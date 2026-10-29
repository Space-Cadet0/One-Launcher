'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  RFC3394_DEFAULT_IV,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
  unwrapCikWithDeviceKey,
  wrapCikWithDeviceKey,
  buildOpenSslXtsKey,
  buildXvdXtsTweak,
  decryptXvdPage,
  encryptXvdPage,
  decryptContiguousPageBuffer,
} = require('./xboxBoringSslCrypto.cjs');
const {
  APPX_BASE32_ALPHABET,
  HELPER_EXE_BASENAMES,
  normalizeContainerRelPath,
  stripXmlComments,
  decodeXmlEntities,
  extractXmlAttr,
  extractXmlTagText,
  computeAppxPublisherId,
  computePackageFamilyName,
  normalizeHexTitleId,
  deriveScidFromHexTitleId,
  deriveScidFromDecimalTitleId,
  deriveDefaultScidFromTitleId,
  parseMicrosoftGameConfigXml,
  parseAppxManifestXml,
} = require('./xboxConfigAndIds.cjs');

const XVD_MAGIC = 'msft-xvd';
const XVD_PAGE_SIZE = 0x1000; // 4096 bytes
const XVD_HEADER_PAGES = 3;
const XVD_HEADER_SECTION_SIZE = XVD_HEADER_PAGES * XVD_PAGE_SIZE; // 0x3000 (12,288 bytes)
const XVD_HASH_ENTRIES_PER_PAGE = 170; // 170 * 24 = 4080 bytes (+ 16 trailing bytes per 4096 page)
const XVD_HASH_ENTRY_SIZE = 24; // 20B hash + 4B u32LE data_unit
const XVC_INFO_HEADER_SIZE = 0xda8; // 3496 bytes
const XVC_REGION_HEADER_SIZE = 0x80; // 128 bytes
const SEGMENT_METADATA_MAGIC = ' PFX';

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
    pattern: /(?:^|\/)(?:easyanticheat_eos\.(?:exe|sys)|easyanticheat\.sys|start_protected_game\.exe)$/i,
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

function bytesToPages(byteLength) {
  const n = Number(byteLength || 0);
  if (n <= 0) return 0;
  return Math.ceil(n / XVD_PAGE_SIZE);
}

function pageAlignBytes(byteLength) {
  return bytesToPages(byteLength) * XVD_PAGE_SIZE;
}

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

function readNullTerminatedUtf16LE(buf, offset, maxCodeUnits) {
  const endByte = Math.min(buf.length, offset + maxCodeUnits * 2);
  let byteEnd = offset;
  while (byteEnd + 1 < endByte) {
    if (buf[byteEnd] === 0 && buf[byteEnd + 1] === 0) break;
    byteEnd += 2;
  }
  return buf.subarray(offset, byteEnd).toString('utf16le');
}

// ---------------------------------------------------------------------------
// Range Readers (Buffer, Local File, Multi-CDN HTTP Failover, 4 MiB LRU Cache)
// ---------------------------------------------------------------------------

function createBufferRangeReader(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('createBufferRangeReader expects a Buffer');
  }
  let bytesRead = 0;
  let requests = 0;
  return {
    async getTotalSize() {
      return buffer.length;
    },
    async readRange(offset, length, signal) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const start = Math.max(0, Number(offset));
      const len = Math.max(0, Number(length));
      if (len === 0 || start >= buffer.length) return Buffer.alloc(0);
      const slice = Buffer.from(buffer.subarray(start, Math.min(buffer.length, start + len)));
      bytesRead += slice.length;
      requests += 1;
      return slice;
    },
    getStats() {
      return { bytesRead, requests, totalSize: buffer.length };
    },
  };
}

function createFileRangeReader(filePath) {
  let fdPromise = null;
  let cachedSize = null;
  let bytesRead = 0;
  let requests = 0;

  async function ensureHandle() {
    if (!fdPromise) {
      fdPromise = fs.promises.open(filePath, 'r');
    }
    return fdPromise;
  }

  return {
    async getTotalSize() {
      if (cachedSize === null) {
        const handle = await ensureHandle();
        const st = await handle.stat();
        cachedSize = st.size;
      }
      return cachedSize;
    },
    async readRange(offset, length, signal) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const len = Math.max(0, Number(length));
      if (len === 0) return Buffer.alloc(0);
      const handle = await ensureHandle();
      const total = await this.getTotalSize();
      const start = Math.max(0, Number(offset));
      if (start >= total) return Buffer.alloc(0);
      const toRead = Math.min(len, total - start);
      const out = Buffer.allocUnsafe(toRead);
      let filled = 0;
      while (filled < toRead) {
        const { bytesRead: n } = await handle.read(out, filled, toRead - filled, start + filled);
        if (n <= 0) break;
        filled += n;
      }
      bytesRead += filled;
      requests += 1;
      return filled === toRead ? out : out.subarray(0, filled);
    },
    async close() {
      if (fdPromise) {
        const h = await fdPromise.catch(() => null);
        fdPromise = null;
        if (h) await h.close().catch(() => {});
      }
    },
    getStats() {
      return { bytesRead, requests, totalSize: cachedSize };
    },
  };
}

/**
 * @param {Record<string, any>} [params]
 */
function resolveCandidateUrls({ urls, cdnRootPaths, fileName } = {}) {
  const resolved = [];
  if (Array.isArray(urls)) {
    for (const u of urls) {
      if (typeof u === 'string' && u.trim()) resolved.push(u.trim());
    }
  }
  if (Array.isArray(cdnRootPaths)) {
    for (const root of cdnRootPaths) {
      if (typeof root !== 'string' || !root.trim()) continue;
      const trimmed = root.trim();
      if (fileName) {
        resolved.push(`${trimmed.replace(/\/+$/, '')}/${String(fileName).replace(/^\/+/, '')}`);
      } else {
        resolved.push(trimmed);
      }
    }
  }
  return Array.from(new Set(resolved));
}

function parseContentRangeTotal(headerVal) {
  if (!headerVal) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(headerVal));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Executes a single bounded HTTP `Range` request, enforcing HTTP `206` (or `200` ONLY within
 * `maxAllowed200Bytes` <= 16 MiB) and immediately cancelling/aborting unexpected multi-GB
 * `200 OK` bodies (both `Content-Length` and chunked transfer-encoded) BEFORE OOM buffering (`D4.4`).
 *
 * @param {string} targetUrl
 * @param {number} startByte
 * @param {number} endInclusive
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   headers?: Record<string, string>,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxHttp200Bytes?: number,
 *   signal?: AbortSignal,
 * }} [options]
 */
async function fetchRange(targetUrl, startByte, endInclusive, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Global fetch is unavailable for fetchRange');
  }
  const start = Math.max(0, Math.floor(Number(startByte)));
  const end = Math.max(start, Math.floor(Number(endInclusive)));
  const expectedBytes = Math.max(1, end - start + 1);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30_000;
  const extraHeaders = options.headers && typeof options.headers === 'object' ? options.headers : {};
  const signal = options.signal;

  const MAX_HTTP_200_FULL_BODY_BYTES = 16 * 1024 * 1024;
  const MIN_HTTP_200_SMALL_BODY_BYTES = 256 * 1024;
  const maxAllowed200Bytes =
    Number(options.maxHttp200Bytes) > 0
      ? Math.min(MAX_HTTP_200_FULL_BODY_BYTES, Math.floor(Number(options.maxHttp200Bytes)))
      : Math.min(
          MAX_HTTP_200_FULL_BODY_BYTES,
          Math.max(MIN_HTTP_200_SMALL_BODY_BYTES, expectedBytes * 2, start + expectedBytes)
        );

  if (signal?.aborted) {
    const abortErr = new Error('Operation aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error('HTTP Range timeout')), timeoutMs);
  const onOuterAbort = () => timeoutCtrl.abort(signal.reason || new Error('Aborted'));
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

  const cancelBody = async (resp) => {
    try {
      if (resp?.body && typeof resp.body.cancel === 'function') {
        await resp.body.cancel();
      }
    } catch {
      // Ignore stream cancellation error
    }
  };

  try {
    const resp = await fetchFn(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': options.userAgent || 'Microsoft-Delivery-Optimization/10.0',
        ...extraHeaders,
        Range: `bytes=${start}-${end}`,
      },
      signal: timeoutCtrl.signal,
    });

    if (resp.status === 416) {
      await cancelBody(resp);
      const crTotal = parseContentRangeTotal(resp.headers?.get?.('content-range'));
      return { status: 416, buffer: Buffer.alloc(0), totalSize: crTotal };
    }

    if (resp.status !== 206 && resp.status !== 200) {
      await cancelBody(resp);
      throw new Error(`HTTP ${resp.status} reading Range ${start}-${end} from ${targetUrl}`);
    }

    const rawContentLength = resp.headers?.get?.('content-length');
    const parsedContentLength =
      rawContentLength !== null &&
      rawContentLength !== undefined &&
      String(rawContentLength).trim() !== ''
        ? Number(rawContentLength)
        : NaN;

    if (resp.status === 200) {
      if (
        start + expectedBytes > MAX_HTTP_200_FULL_BODY_BYTES ||
        (Number.isFinite(parsedContentLength) &&
          (parsedContentLength < 0 || parsedContentLength > maxAllowed200Bytes))
      ) {
        await cancelBody(resp);
        timeoutCtrl.abort(new Error('Aborted unexpected full-body HTTP 200 response'));
        throw new Error(
          `Aborted unexpected HTTP 200 full-body response (Content-Length=${rawContentLength ?? 'missing'}) for Range bytes=${start}-${end}`
        );
      }
    } else if (
      Number.isFinite(parsedContentLength) &&
      parsedContentLength > Math.max(expectedBytes * 2, expectedBytes + 65536)
    ) {
      await cancelBody(resp);
      timeoutCtrl.abort(new Error('Aborted oversized HTTP 206 Range response'));
      throw new Error(
        `Aborted oversized HTTP 206 response (Content-Length=${parsedContentLength}) for Range bytes=${start}-${end}`
      );
    }

    let resolvedTotalSize = parseContentRangeTotal(resp.headers?.get?.('content-range'));
    if (resolvedTotalSize === null && resp.status === 200 && parsedContentLength > 0) {
      resolvedTotalSize = parsedContentLength;
    }

    if (resp.status === 200 && !Number.isFinite(parsedContentLength)) {
      /** @type {Buffer} */
      let buf;
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        buf = Buffer.alloc(0);
      } else {
        const reader = resp.body.getReader();
        /** @type {Buffer[]} */
        const chunks = [];
        let accumulatedBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          accumulatedBytes += value.byteLength;
          if (accumulatedBytes > maxAllowed200Bytes) {
            await reader.cancel().catch(() => {});
            timeoutCtrl.abort(new Error('Aborted oversized chunked HTTP 200 response'));
            throw new Error(
              `Aborted oversized chunked HTTP 200 response (> ${maxAllowed200Bytes} bytes) for Range bytes=${start}-${end}`
            );
          }
          chunks.push(
            Buffer.isBuffer(value)
              ? value
              : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          );
        }
        buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, accumulatedBytes);
      }
      if (resolvedTotalSize === null && buf.length > 0) {
        resolvedTotalSize = buf.length;
      }
      if (start >= buf.length) {
        buf = Buffer.alloc(0);
      } else if (start > 0 || buf.length > expectedBytes) {
        buf = Buffer.from(buf.subarray(start, Math.min(buf.length, start + expectedBytes)));
      }
      return { status: resp.status, buffer: buf, totalSize: resolvedTotalSize };
    }

    const ab = await resp.arrayBuffer();
    let buf = Buffer.from(ab);
    if (resp.status === 200 && buf.length > maxAllowed200Bytes) {
      throw new Error(
        `Rejected oversized buffered HTTP 200 response (${buf.length} bytes) for Range bytes=${start}-${end}`
      );
    }
    if (resp.status === 200) {
      if (start >= buf.length) {
        buf = Buffer.alloc(0);
      } else if (start > 0 || buf.length > expectedBytes) {
        buf = Buffer.from(buf.subarray(start, Math.min(buf.length, start + expectedBytes)));
      }
    }
    return { status: resp.status, buffer: buf, totalSize: resolvedTotalSize };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

function createHttpRangeReader(options = {}) {
  const candidates = resolveCandidateUrls(options);
  if (candidates.length === 0) {
    throw new Error('createHttpRangeReader requires at least one URL or cdnRootPath');
  }
  const fetchFn = options.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Global fetch is unavailable for createHttpRangeReader');
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30_000;
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : Math.max(3, candidates.length * 2);
  const extraHeaders = options.headers && typeof options.headers === 'object' ? options.headers : {};

  let preferredIndex = 0;
  let totalSize = Number.isFinite(options.totalSize) && options.totalSize > 0 ? Number(options.totalSize) : null;
  let bytesRead = 0;
  let requests = 0;

  return {
    getCandidateUrls() {
      return candidates.slice();
    },
    async getTotalSize(signal) {
      if (totalSize !== null) return totalSize;
      await this.readRange(0, 16, signal);
      return totalSize;
    },
    async readRange(offset, length, signal) {
      const start = Math.max(0, Math.floor(Number(offset)));
      const len = Math.max(0, Math.floor(Number(length)));
      if (len === 0) return Buffer.alloc(0);
      if (totalSize !== null && start >= totalSize) return Buffer.alloc(0);
      const endInclusive =
        totalSize !== null ? Math.min(totalSize - 1, start + len - 1) : start + len - 1;

      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (signal?.aborted) {
          const abortErr = new Error('Operation aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        const urlIdx = (preferredIndex + attempt) % candidates.length;
        const targetUrl = candidates[urlIdx];

        try {
          const res = await fetchRange(targetUrl, start, endInclusive, {
            fetchImpl: fetchFn,
            headers: extraHeaders,
            userAgent: options.userAgent,
            timeoutMs,
            signal,
          });
          if (res.totalSize !== null && res.totalSize !== undefined) {
            totalSize = res.totalSize;
          }
          if (res.status === 416) {
            return Buffer.alloc(0);
          }
          preferredIndex = urlIdx;
          bytesRead += res.buffer.length;
          requests += 1;
          return res.buffer;
        } catch (err) {
          lastErr = err;
          if (signal?.aborted) {
            const abortErr = new Error('Operation aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          if (attempt < maxRetries) {
            const backoffMs = Math.min(1500, 80 * Math.pow(2, Math.min(attempt, 4)));
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }
      throw lastErr || new Error('Failed HTTP Range read across all CDN endpoints');
    },
    getStats() {
      return { bytesRead, requests, totalSize, preferredUrl: candidates[preferredIndex] };
    },
  };
}

/**
 * Wraps any rangeReader with a fixed-budget LRU block cache (default 4 MiB, 128 KiB blocks).
 */
function createLruBlockRangeReader(innerReader, options = {}) {
  const blockSize = Number(options.blockSize) > 0 ? Number(options.blockSize) : 128 * 1024;
  const maxCacheBytes = Number(options.maxCacheBytes) > 0 ? Number(options.maxCacheBytes) : 4 * 1024 * 1024;
  const maxBlocks = Math.max(4, Math.floor(maxCacheBytes / blockSize));
  const cache = new Map(); // blockIndex -> Buffer

  async function getBlock(blockIndex, signal) {
    if (cache.has(blockIndex)) {
      const existing = cache.get(blockIndex);
      cache.delete(blockIndex);
      cache.set(blockIndex, existing);
      return existing;
    }
    const block = await innerReader.readRange(blockIndex * blockSize, blockSize, signal);
    cache.set(blockIndex, block);
    while (cache.size > maxBlocks) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    return block;
  }

  return {
    async getTotalSize(signal) {
      return typeof innerReader.getTotalSize === 'function' ? innerReader.getTotalSize(signal) : null;
    },
    async readRange(offset, length, signal) {
      const start = Math.max(0, Math.floor(Number(offset)));
      const len = Math.max(0, Math.floor(Number(length)));
      if (len === 0) return Buffer.alloc(0);

      // Large sequential reads bypass block cache to avoid thrashing
      if (len > blockSize * 4) {
        return innerReader.readRange(start, len, signal);
      }

      const firstBlock = Math.floor(start / blockSize);
      const lastBlock = Math.floor((start + len - 1) / blockSize);
      const parts = [];
      let totalCopied = 0;

      for (let b = firstBlock; b <= lastBlock; b += 1) {
        const blk = await getBlock(b, signal);
        if (blk.length === 0) break;
        const blkStart = b * blockSize;
        const sliceStart = Math.max(0, start - blkStart);
        const sliceEnd = Math.min(blk.length, start + len - blkStart);
        if (sliceEnd > sliceStart) {
          const sub = blk.subarray(sliceStart, sliceEnd);
          parts.push(sub);
          totalCopied += sub.length;
        }
        if (blk.length < blockSize) break;
      }

      return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, totalCopied);
    },
    clearCache() {
      cache.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// XVD Header, Section Layout, Hash Tree, XVC Info, UserData & SegmentMetadata
// ---------------------------------------------------------------------------

/**
 * Parses the XvdHeader from the first >= 0x474 (ideally 0x3000) bytes of an MSIXVC/XVD image.
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
  const driveSize = Number(buf.readBigUInt64LE(0x218));
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
 * Computes the 4-level XVD hash tree page layout ([level3 | level2 | level1 | level0]).
 */
function computeHashTreeLayout(totalHashedPages, resiliencyEnabled = false) {
  const n = Math.max(0, Math.floor(Number(totalHashedPages || 0)));
  if (n === 0) {
    return {
      totalHashedPages: 0,
      resiliencyMultiplier: resiliencyEnabled ? 2 : 1,
      level0Pages: 0,
      level1Pages: 0,
      level2Pages: 0,
      level3Pages: 0,
      level0OffsetPages: 0,
      totalPages: 0,
    };
  }

  const storedHashes = (count) => (count <= 1 ? 0 : count);
  const levelPages = (count) => {
    const s = storedHashes(count);
    return s === 0 ? 0 : Math.ceil(s / XVD_HASH_ENTRIES_PER_PAGE);
  };

  // Level 0 always occupies >= 1 page when totalHashedPages >= 1
  const level0Pages = Math.max(1, Math.ceil(n / XVD_HASH_ENTRIES_PER_PAGE));
  const level1Pages = levelPages(level0Pages);
  const level2Pages = levelPages(level1Pages);
  const level3Pages = levelPages(level2Pages);

  const mult = resiliencyEnabled ? 2 : 1;
  const level0OffsetPages = (level3Pages + level2Pages + level1Pages) * mult;
  const totalPages = (level3Pages + level2Pages + level1Pages + level0Pages) * mult;

  return {
    totalHashedPages: n,
    resiliencyMultiplier: mult,
    level0Pages,
    level1Pages,
    level2Pages,
    level3Pages,
    level0OffsetPages,
    totalPages,
  };
}

/**
 * Computes exact page & byte spans for every section of an XVD container.
 * Explicitly multiplies `userData.startPage * 0x1000` (fixing upstream xodus's page-vs-byte bug).
 */
function computeXvdLayout(header) {
  let cursorPage = 0;
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
  const mutableDataSpan = makeSpan(header.mutablePageCount, header.mutablePageCount * XVD_PAGE_SIZE);

  const userDataPages = bytesToPages(header.userDataLength);
  const xvcInfoPages = bytesToPages(header.xvcDataLength);
  const dynamicHeaderPages = bytesToPages(header.dynamicHeaderLength);
  const driveDataPages = bytesToPages(header.driveSize);
  const totalHashedPages = userDataPages + xvcInfoPages + dynamicHeaderPages + driveDataPages;

  const hashTreeDetails = header.dataIntegrityDisabled
    ? computeHashTreeLayout(0, header.resiliencyEnabled)
    : computeHashTreeLayout(totalHashedPages, header.resiliencyEnabled);

  const hashTreeSpan = {
    ...makeSpan(hashTreeDetails.totalPages, hashTreeDetails.totalPages * XVD_PAGE_SIZE),
    ...hashTreeDetails,
    level0StartPage: cursorPage - hashTreeDetails.level0Pages * hashTreeDetails.resiliencyMultiplier,
    level0ByteOffset:
      (cursorPage - hashTreeDetails.level0Pages * hashTreeDetails.resiliencyMultiplier) * XVD_PAGE_SIZE,
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
function computeXvdL0PageHash(rawPageBuffer, hashByteLength = 20) {
  const view = Buffer.isBuffer(rawPageBuffer) ? rawPageBuffer : Buffer.from(rawPageBuffer || []);
  let page4096 = view;
  if (view.length !== XVD_PAGE_SIZE) {
    page4096 = Buffer.alloc(XVD_PAGE_SIZE, 0);
    view.copy(page4096, 0, 0, Math.min(view.length, XVD_PAGE_SIZE));
  }
  const len = Math.max(1, Math.min(24, Number(hashByteLength) || 20));
  const fullDigest = crypto.createHash('sha256').update(page4096).digest();
  return Buffer.from(fullDigest.subarray(0, len));
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
      24,
      Number(options.hashByteLength) || (expectedView.length === 24 && options.full24Bytes ? 24 : 20)
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
 * Reads L0 hash tree entries (`hashes` 20B SHA-256 prefixes + `dataUnits` u32LE at `entry[20..24]`)
 * for a contiguous span of 0x1000 file pages (`D8.5`).
 *
 * @param {object} rangeReader
 * @param {object} layout Result of computeXvdLayout()
 * @param {number} firstPageByteOffset Byte offset of first 0x1000 page (>= layout.userData.byteOffset)
 * @param {number} pageCount Number of 0x1000 pages
 * @param {AbortSignal} [signal]
 */
async function readL0EntriesForPages(rangeReader, layout, firstPageByteOffset, pageCount, signal) {
  const dataUnits = new Uint32Array(Math.max(0, pageCount));
  const hashes = [];
  if (pageCount <= 0) {
    return { enabled: false, dataUnits, hashes };
  }

  const firstHashedIdx = Math.floor((firstPageByteOffset - layout.userData.byteOffset) / XVD_PAGE_SIZE);
  if (layout.hashTree.pageCount === 0 || firstHashedIdx < 0) {
    for (let i = 0; i < pageCount; i += 1) {
      dataUnits[i] = Math.max(0, firstHashedIdx + i);
    }
    return { enabled: false, dataUnits, hashes };
  }

  const mult = layout.hashTree.resiliencyMultiplier || 1;
  const firstL0LogicalPage = Math.floor(firstHashedIdx / XVD_HASH_ENTRIES_PER_PAGE);
  const lastHashedIdx = firstHashedIdx + pageCount - 1;
  const lastL0LogicalPage = Math.floor(lastHashedIdx / XVD_HASH_ENTRIES_PER_PAGE);

  const l0StartByte = layout.hashTree.level0ByteOffset + firstL0LogicalPage * mult * XVD_PAGE_SIZE;
  const l0SpanPages = (lastL0LogicalPage - firstL0LogicalPage + 1) * mult;
  const l0Buf = await rangeReader.readRange(l0StartByte, l0SpanPages * XVD_PAGE_SIZE, signal);

  for (let i = 0; i < pageCount; i += 1) {
    const hashedIdx = firstHashedIdx + i;
    const l0PageRel = (Math.floor(hashedIdx / XVD_HASH_ENTRIES_PER_PAGE) - firstL0LogicalPage) * mult;
    const entryIdx = hashedIdx % XVD_HASH_ENTRIES_PER_PAGE;
    const entryByteOff = l0PageRel * XVD_PAGE_SIZE + entryIdx * XVD_HASH_ENTRY_SIZE;
    if (entryByteOff + 24 <= l0Buf.length) {
      hashes.push(Buffer.from(l0Buf.subarray(entryByteOff, entryByteOff + 20)));
      dataUnits[i] = l0Buf.readUInt32LE(entryByteOff + 20);
    } else {
      hashes.push(null);
    }
  }
  return { enabled: true, dataUnits, hashes };
}

function isAllZeroBuffer(buf) {
  if (!buf || buf.length === 0) return true;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * Validates a contiguous buffer of on-disk `0x1000` XVD pages against L0 SHA-256 hash entries (`D8.5`).
 *
 * @param {Buffer|Uint8Array} rawPagesBuffer
 * @param {Array<Buffer|null>} l0Hashes
 * @param {{ firstPageByteOffset?: number, topHashBlockHash?: Buffer|null }} [options]
 */
function verifyXvdContiguousPagesL0(rawPagesBuffer, l0Hashes, options = {}) {
  if (!Array.isArray(l0Hashes) || l0Hashes.length === 0) return true;
  const view = Buffer.isBuffer(rawPagesBuffer) ? rawPagesBuffer : Buffer.from(rawPagesBuffer || []);
  const firstOff = Number(options.firstPageByteOffset) || 0;
  const hasRootHash =
    options.topHashBlockHash && !isAllZeroBuffer(options.topHashBlockHash);

  for (let i = 0; i < l0Hashes.length; i += 1) {
    const expected = l0Hashes[i];
    if (!expected || expected.length < 20) continue;
    // Unpopulated data_unit-only synthetic fixtures have zeroed topHashBlockHash AND zeroed 20B hash slot
    if (!hasRootHash && isAllZeroBuffer(expected)) continue;
    const pageStart = i * XVD_PAGE_SIZE;
    if (pageStart >= view.length) break;
    const pageSlice = view.subarray(pageStart, Math.min(view.length, pageStart + XVD_PAGE_SIZE));
    verifyXvdL0PageHash(pageSlice, expected, {
      hashByteLength: 20,
      throwOnMismatch: true,
      pageOffset: firstOff + pageStart,
    });
  }
  return true;
}

/**
 * Reads L0 hash tree `data_unit` (u32LE at entry[20..24]) values for a contiguous span of file pages.
 * @param {object} rangeReader
 * @param {object} layout Result of computeXvdLayout()
 * @param {number} firstPageByteOffset Byte offset of first 0x1000 page (>= layout.userData.byteOffset)
 * @param {number} pageCount Number of 0x1000 pages
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint32Array>} Array of `data_unit` u32 values (or sequential fallback if integrity disabled)
 */
async function readL0DataUnitsForPages(rangeReader, layout, firstPageByteOffset, pageCount, signal) {
  const { dataUnits } = await readL0EntriesForPages(
    rangeReader,
    layout,
    firstPageByteOffset,
    pageCount,
    signal
  );
  return dataUnits;
}

/**
 * Parses `XvcInfo` (3496B) and trailing `XvcRegionHeader[]` (128B each).
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
  const initialPlayOffset = Number(buf.readBigUInt64LE(0xd28));
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
    const offset = Number(buf.readBigUInt64LE(rOff + 0x50));
    const length = Number(buf.readBigUInt64LE(rOff + 0x58));
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
      const data = dataStart <= buf.length ? Buffer.from(buf.subarray(dataStart, dataEnd)) : Buffer.alloc(0);

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
 * @param {Buffer} buf
 */
function parseSegmentMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) {
    throw new Error(`SegmentMetadata.bin buffer too small (${buf ? buf.length : 0} bytes)`);
  }
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== SEGMENT_METADATA_MAGIC) {
    throw new Error(`Invalid SegmentMetadata.bin magic: expected "${SEGMENT_METADATA_MAGIC}", got "${magic}"`);
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
    const fileSize = Number(buf.readBigUInt64LE(recOff + 0x08));

    const strStart = pathsTableOffset + pathRelByteOffset;
    const strEnd = Math.min(buf.length, strStart + pathCodeUnits * 2);
    const rawPath = strStart <= buf.length ? buf.subarray(strStart, strEnd).toString('utf16le').replace(/\0+$/g, '') : '';
    const path = normalizeContainerRelPath(rawPath);

    segments.push({
      index: i,
      flags,
      keepEncryptedFlag: Boolean(flags & 0x01),
      path,
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

const STRUCTURAL_XVC_DESCRIPTIONS = new Set([
  'XVC-HD',
  'FS-MD',
  'XVC-MD',
  'XVC-EXVD',
  'XVC-MDU',
]);

function isStructuralXvcRegion(region) {
  const desc = String(region?.description || '').trim().toUpperCase();
  if (STRUCTURAL_XVC_DESCRIPTIONS.has(desc)) return true;
  const flags = Number(region?.flags || 0) >>> 0;
  if ((flags & 0x1) !== 0) return true; // XVC_REGION_FLAG_RESIDENT_METADATA
  const id = Number(region?.id || 0) >>> 0;
  // Note: 0x40000003 (unencrypted prefix file segment region, flags=0, keyId=0xffff)
  // holds segments[0..K] on real GDK packages (e.g. Quake, Quake II); all other >= 0x40000000 IDs are structural.
  if (id >= 0x40000000 && id !== 0x40000003) return true;
  return false;
}

/**
 * Maps `SegmentMetadata.bin` segments onto physical `.msixvc` disk offsets & encryption regions.
 */
function mapSegmentsToRegions(segmentMetadata, xvcInfo, layout, header) {
  const segments = Array.isArray(segmentMetadata)
    ? segmentMetadata
    : segmentMetadata?.segments || [];
  if (segments.length === 0) return [];

  const driveDataByteOffset = layout?.driveData?.byteOffset ?? 0;
  const encryptionDisabled = Boolean(header?.encryptionDisabled);
  const rawRegions = Array.isArray(xvcInfo) ? xvcInfo : xvcInfo?.regions || [];
  const regions = rawRegions.filter(
    (r) => r.length > 0 && r.offset >= driveDataByteOffset
  );
  const candidatePayloadRegions = regions.filter((r) => !isStructuralXvcRegion(r));
  // If an explicit < 0x40000000 user region already claims firstSegmentIndex === 0, prefer it over a dummy 0x40000003
  const hasExplicitUserZeroStart = candidatePayloadRegions.some(
    (r) => (r.id >>> 0) < 0x40000000 && r.firstSegmentIndex === 0
  );
  const filteredPayloadRegions = hasExplicitUserZeroStart
    ? candidatePayloadRegions.filter((r) => (r.id >>> 0) !== 0x40000003 || r.firstSegmentIndex !== 0)
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
      const pageCount = Number.isFinite(seg.pageCount) ? seg.pageCount : bytesToPages(seg.fileSize || 0);
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
      const pageCount = Number.isFinite(seg.pageCount) ? seg.pageCount : bytesToPages(seg.fileSize || 0);
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

// ---------------------------------------------------------------------------
// Lightweight HTTP-Range GPT + NTFS VBR + $MFT Walker (4 MiB LRU Cache)
// ---------------------------------------------------------------------------

function applyNtfsMultiSectorFixup(recordBuf, sectorSize = 512) {
  const buf = Buffer.from(recordBuf);
  if (buf.length < 48) return buf;
  const usaOffset = buf.readUInt16LE(0x04);
  const usaCount = buf.readUInt16LE(0x06);
  if (usaCount < 2 || usaOffset + usaCount * 2 > buf.length) return buf;

  const usn = buf.readUInt16LE(usaOffset);
  for (let i = 1; i < usaCount; i += 1) {
    const sectorEndOff = i * sectorSize - 2;
    if (sectorEndOff + 2 > buf.length) break;
    if (buf.readUInt16LE(sectorEndOff) === usn) {
      buf.writeUInt16LE(buf.readUInt16LE(usaOffset + i * 2), sectorEndOff);
    }
  }
  return buf;
}

function decodeNtfsDataRuns(buf, startOffset, clusterSize, partitionByteOffset) {
  const runs = [];
  let off = startOffset;
  let currentLcn = 0n;
  let currentVcn = 0n;

  while (off < buf.length) {
    const headerByte = buf[off];
    off += 1;
    if (headerByte === 0) break;

    const lenBytes = headerByte & 0x0f;
    const offBytes = (headerByte >> 4) & 0x0f;
    if (lenBytes === 0 || off + lenBytes + offBytes > buf.length) break;

    let clusterCount = 0n;
    for (let i = 0; i < lenBytes; i += 1) {
      clusterCount |= BigInt(buf[off + i]) << BigInt(i * 8);
    }
    off += lenBytes;

    let sparse = false;
    if (offBytes === 0) {
      sparse = true;
    } else {
      let delta = 0n;
      for (let i = 0; i < offBytes; i += 1) {
        delta |= BigInt(buf[off + i]) << BigInt(i * 8);
      }
      const signBit = 1n << BigInt(offBytes * 8 - 1);
      if (delta & signBit) {
        delta -= 1n << BigInt(offBytes * 8);
      }
      currentLcn += delta;
      off += offBytes;
    }

    const byteLength = Number(clusterCount) * clusterSize;
    const diskOffset = sparse ? null : partitionByteOffset + Number(currentLcn) * clusterSize;
    runs.push({
      vcn: Number(currentVcn),
      lcn: sparse ? null : Number(currentLcn),
      clusterCount: Number(clusterCount),
      byteLength,
      diskOffset,
      sparse,
    });
    currentVcn += clusterCount;
  }
  return runs;
}

async function readFromNtfsRuns(driveReader, runs, logicalOffset, byteLength, signal) {
  if (byteLength <= 0) return Buffer.alloc(0);
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
      const chunk = await driveReader.readRange(run.diskOffset + relStart, take, signal);
      chunk.copy(out, outPos, 0, Math.min(chunk.length, take));
    }
    outPos += take;
    logicalOffset += take;
    remaining -= take;
  }

  return out;
}

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
      const partEntryLba = Number(gptHdr.readBigUInt64LE(72));
      const numEntries = Math.min(128, gptHdr.readUInt32LE(80));
      const entrySize = gptHdr.readUInt32LE(84) || 128;
      const entriesBuf = await driveReader.readRange(
        partEntryLba * sectorSize,
        numEntries * entrySize,
        signal
      );

      for (let i = 0; i < numEntries; i += 1) {
        const eOff = i * entrySize;
        if (eOff + 64 > entriesBuf.length) break;
        const typeGuid = entriesBuf.subarray(eOff, eOff + 16);
        if (typeGuid.every((b) => b === 0)) continue;
        const firstLba = Number(entriesBuf.readBigUInt64LE(eOff + 32));
        const candidateOffset = firstLba * sectorSize;
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
        const vbr = await driveReader.readRange(candidateOffset, 512, signal);
        if (vbr.length >= 0x50 && vbr.subarray(0x03, 0x0b).toString('ascii') === 'NTFS    ') {
          return candidateOffset;
        }
      }
    }
  }

  return null;
}

function parseNtfsFileRecordAttributes(recordBuf, clusterSize, partitionByteOffset) {
  if (recordBuf.length < 48 || recordBuf.subarray(0, 4).toString('ascii') !== 'FILE') {
    return null;
  }
  const fixed = applyNtfsMultiSectorFixup(recordBuf, 512);
  const flags = fixed.readUInt16LE(0x16);
  if ((flags & 0x01) === 0) return null; // Not in-use

  const isDirectory = Boolean(flags & 0x02);
  let attrOff = fixed.readUInt16LE(0x14);
  const names = [];
  let dataAttr = null;

  while (attrOff + 16 <= fixed.length) {
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
        const realSize = Number(fixed.readBigUInt64LE(attrOff + 48));
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
 */
async function createVirtualDriveRangeReader(containerReader, header, layout, signal) {
  let batTable = null;
  if (header.xvdType === 1 && layout.dynamicHeader.byteLength > 0) {
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
    .filter((r) => r.isEncrypted && !header.encryptionDisabled && r.length > 0)
    .map((r) => [r.offset, r.offset + r.length]);

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
  const sectorsPerCluster = vbr.readUInt8(0x0d) || 8;
  const clusterSize = bytesPerSector * sectorsPerCluster;
  const mftCluster = Number(vbr.readBigUInt64LE(0x30));
  const rawRecClusters = vbr.readInt8(0x40);
  const recordSize =
    rawRecClusters < 0 ? 1 << -rawRecClusters : Math.max(1024, rawRecClusters * clusterSize);

  const mftStartVirtOffset = partitionOffset + mftCluster * clusterSize;
  if (
    header.xvdType === 0 &&
    !isContainerRangePlaintext(layout.driveData.byteOffset + mftStartVirtOffset, recordSize)
  ) {
    return [];
  }

  const mftRecord0 = await driveReader.readRange(mftStartVirtOffset, recordSize, signal);
  const parsedMft0 = parseNtfsFileRecordAttributes(mftRecord0, clusterSize, partitionOffset);
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
      const parsed = parseNtfsFileRecordAttributes(slice, clusterSize, partitionOffset);
      if (!parsed) continue;
      if (rNum > 5 && parsed.fileName && parsed.fileName.startsWith('$')) continue;
      records.set(rNum, parsed);
    }
  }

  // Reconstruct full paths relative to root record 5
  const resolveRelPath = (recNum) => {
    const parts = [];
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
      readAllBytes: async (reqSignal) => {
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

/**
 * Finds the XVC region covering `containerOffset` (preferring non-structural payload regions over structural regions).
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
      : !run.sparse && run.diskOffset !== null && run.diskOffset !== undefined && header?.xvdType === 0
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
 * Parses `MicrosoftGame.config` XML text into canonical One Launcher Xbox metadata
 * via canonical `xboxConfigAndIds.cjs` (`D2.3`).
 */
function parseMicrosoftGameConfig(xmlInput) {
  return parseMicrosoftGameConfigXml(xmlInput);
}

/**
 * Parses `AppxManifest.xml` into structured identity, entry-point, and trust metadata
 * via canonical `xboxConfigAndIds.cjs` (`D2.3`).
 */
function parseAppxManifest(xmlInput) {
  return parseAppxManifestXml(xmlInput);
}

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

function stripFlatRootPrefix(relPath, stripPrefix) {
  const norm = normalizeContainerRelPath(relPath);
  if (!stripPrefix) return norm;
  const lower = norm.toLowerCase();
  const pref = `${stripPrefix.toLowerCase()}/`;
  return lower.startsWith(pref) ? norm.slice(pref.length) : norm;
}

function resolveOptionalSegmentOsslKey(seg, xvcInfo, options = {}) {
  const deviceKey = options.deviceKey || options.kek || null;
  const coerce = (raw) => {
    if (!raw) return null;
    let buf = Buffer.isBuffer(raw)
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw)
        : /^[0-9a-fA-F]{64}$/.test(String(raw).trim()) || /^[0-9a-fA-F]{80}$/.test(String(raw).trim())
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
        const key = coerce(v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array) ? (v.cik ?? v.key ?? v.rawCik) : v);
        if (key) map.set(kNorm, key);
      }
    }
    if (seg.keyGuid && map.has(seg.keyGuid.toLowerCase())) return map.get(seg.keyGuid.toLowerCase());
    if (seg.keyHex && map.has(seg.keyHex.toLowerCase())) return map.get(seg.keyHex.toLowerCase());
    if (map.has(String(seg.keyId))) return map.get(String(seg.keyId));
    const entry = xvcInfo?.encryptionKeyIds?.[seg.keyId];
    if (entry && map.has(entry.guid.toLowerCase())) return map.get(entry.guid.toLowerCase());
    if (map.size === 1) return map.values().next().value;
  }
  return coerce(options.cik);
}

/**
 * Reads container headers (`XvdHeader`, `user_data`, `XvcInfo`, `SegmentMetadata.bin`, plus NTFS fallback)
 * using minimal coalesced Range requests.
 */
async function inspectMsixvcContainer(options = {}) {
  const { includeNtfsFallback = true, signal } = options;
  let rangeReader = options.rangeReader || null;
  let ownsReader = false;

  if (!rangeReader) {
    if (Buffer.isBuffer(options.msixvcBuffer || options.buffer)) {
      rangeReader = createBufferRangeReader(options.msixvcBuffer || options.buffer);
    } else if (options.msixvcPath) {
      rangeReader = createFileRangeReader(options.msixvcPath);
      ownsReader = true;
    } else if (options.urls || options.url || options.cdnRootPaths) {
      rangeReader = createHttpRangeReader({
        urls: options.urls || (options.url ? [options.url] : undefined),
        cdnRootPaths: options.cdnRootPaths,
        fileName: options.fileName,
        headers: options.headers,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
    }
  }

  if (!rangeReader || typeof rangeReader.readRange !== 'function') {
    throw new TypeError('inspectMsixvcContainer requires a rangeReader, urls, msixvcPath, or buffer');
  }

  try {
    // Step 1: Coalesced 128 KiB initial read covers XvdHeader (0x3000) and often small hash_tree + user_data
    const initialProbeSize = 128 * 1024;
    const initialBuf = await rangeReader.readRange(0, initialProbeSize, signal);
    const header = parseXvdHeader(initialBuf);
    const layout = computeXvdLayout(header);

    const sliceOrRead = async (byteOffset, byteLength) => {
      if (byteLength <= 0) return Buffer.alloc(0);
      if (byteOffset + byteLength <= initialBuf.length) {
        return initialBuf.subarray(byteOffset, byteOffset + byteLength);
      }
      return rangeReader.readRange(byteOffset, byteLength, signal);
    };

    // Coalesce user_data + xvc_info into a single HTTP Range request when contiguous
    let userDataBuf = Buffer.alloc(0);
    let xvcInfoBuf = Buffer.alloc(0);
    const metaStart = layout.userData.byteOffset;
    const metaEnd = layout.xvcInfo.byteOffset + layout.xvcInfo.byteLength;

    if (metaEnd > metaStart && metaEnd - metaStart <= 32 * 1024 * 1024) {
      const combined = await sliceOrRead(metaStart, metaEnd - metaStart);
      userDataBuf = combined.subarray(0, Math.min(combined.length, layout.userData.byteLength));
      const xvcRelStart = layout.xvcInfo.byteOffset - metaStart;
      if (xvcRelStart >= 0 && xvcRelStart < combined.length) {
        xvcInfoBuf = combined.subarray(
          xvcRelStart,
          Math.min(combined.length, xvcRelStart + layout.xvcInfo.byteLength)
        );
      }
    } else {
      if (layout.userData.byteLength > 0) {
        userDataBuf = await sliceOrRead(layout.userData.byteOffset, layout.userData.byteLength);
      }
      if (layout.xvcInfo.byteLength > 0) {
        xvcInfoBuf = await sliceOrRead(layout.xvcInfo.byteOffset, layout.xvcInfo.byteLength);
      }
    }

    const userData = parseUserData(userDataBuf);
    const xvcInfo = parseXvcInfo(xvcInfoBuf);

    const findUserDataFile = (suffix) => {
      const target = suffix.toLowerCase();
      for (const entry of userData.entries) {
        const lower = entry.path.toLowerCase();
        if (lower === target || lower.endsWith(`/${target}`)) {
          return entry;
        }
      }
      return null;
    };

    /** @type {{ path: string, size: number, data: Buffer } | null} */
    let segMetaEntry = findUserDataFile('segmentmetadata.bin');
    let gameConfigBuf = findUserDataFile('microsoftgame.config')?.data || null;
    let appxManifestBuf = findUserDataFile('appxmanifest.xml')?.data || null;

    let ntfsFiles = [];
    const shouldWalkNtfs =
      Boolean(options.includeAllNtfsFiles) ||
      (includeNtfsFallback && (!segMetaEntry || !gameConfigBuf || !appxManifestBuf));
    if (shouldWalkNtfs) {
      try {
        ntfsFiles = await walkUnencryptedNtfsFiles({
          rangeReader,
          header,
          layout,
          xvcInfo,
          signal,
        });
        for (const nf of ntfsFiles) {
          const lower = nf.path.toLowerCase();
          if (!segMetaEntry && (lower === 'segmentmetadata.bin' || lower.endsWith('/segmentmetadata.bin')) && nf.isPlaintextAccessible) {
            const data = await nf.readAllBytes(signal);
            segMetaEntry = { path: nf.path, size: data.length, data };
          } else if (!gameConfigBuf && (lower === 'microsoftgame.config' || lower.endsWith('/microsoftgame.config')) && nf.isPlaintextAccessible) {
            gameConfigBuf = await nf.readAllBytes(signal);
          } else if (!appxManifestBuf && (lower === 'appxmanifest.xml' || lower.endsWith('/appxmanifest.xml')) && nf.isPlaintextAccessible) {
            appxManifestBuf = await nf.readAllBytes(signal);
          }
        }
      } catch {
        // Non-fatal if container has no NTFS partition or prefix is encrypted
      }
    }

    const segmentMetadata = segMetaEntry?.data ? parseSegmentMetadata(segMetaEntry.data) : null;
    const mappedSegments = segmentMetadata
      ? mapSegmentsToRegions(segmentMetadata, xvcInfo, layout, header)
      : [];

    // Fallback: if MicrosoftGame.config or AppxManifest.xml lives inside mappedSegments (plaintext or with optional CIK)
    const tryReadManifestSegment = async (suffix) => {
      const target = suffix.toLowerCase();
      const seg = mappedSegments.find((s) => {
        const clean = stripFlatRootPrefix(s.path, 'Files').toLowerCase();
        return clean === target;
      });
      if (!seg || seg.fileSize <= 0 || seg.alignedByteLength > 2 * 1024 * 1024) return null;
      const hashTreeEnabled = !header.dataIntegrityDisabled && layout.hashTree.pageCount > 0;
      if (seg.isEncrypted) {
        const osslKey = resolveOptionalSegmentOsslKey(seg, xvcInfo, options);
        if (!osslKey) return null;
        const [rawPages, l0] = await Promise.all([
          sliceOrRead(seg.diskOffset, seg.alignedByteLength),
          readL0EntriesForPages(rangeReader, layout, seg.diskOffset, seg.pageCount, signal),
        ]);
        if (rawPages.length < seg.alignedByteLength) return null;
        if (hashTreeEnabled && l0.enabled) {
          verifyXvdContiguousPagesL0(rawPages, l0.hashes, {
            firstPageByteOffset: seg.diskOffset,
            topHashBlockHash: header.topHashBlockHash,
          });
        }
        const out = decryptXvcRegionBuffer({
          rawBuffer: rawPages,
          firstPageByteOffset: seg.diskOffset,
          pageCount: seg.pageCount,
          dataUnits: l0.dataUnits,
          osslXtsKey: osslKey,
          header,
          regionId: seg.regionId,
        });
        return out.subarray(0, seg.fileSize);
      }
      if (hashTreeEnabled) {
        const [rawPages, l0] = await Promise.all([
          sliceOrRead(seg.diskOffset, seg.alignedByteLength),
          readL0EntriesForPages(rangeReader, layout, seg.diskOffset, seg.pageCount, signal),
        ]);
        if (rawPages.length < seg.fileSize) return null;
        if (l0.enabled && rawPages.length >= seg.alignedByteLength) {
          verifyXvdContiguousPagesL0(rawPages, l0.hashes, {
            firstPageByteOffset: seg.diskOffset,
            topHashBlockHash: header.topHashBlockHash,
          });
        }
        return rawPages.subarray(0, seg.fileSize);
      }
      const raw = await sliceOrRead(seg.diskOffset, seg.fileSize);
      return raw.length >= seg.fileSize ? raw.subarray(0, seg.fileSize) : null;
    };

    // Fallback: if MicrosoftGame.config or AppxManifest.xml lives inside encrypted NTFS $MFT runs (with optional CIK)
    const tryReadManifestNtfsFile = async (suffix) => {
      const target = suffix.toLowerCase();
      const nf =
        ntfsFiles.find((n) => stripFlatRootPrefix(n.path, 'Files').toLowerCase() === target) ||
        ntfsFiles.find((n) =>
          stripFlatRootPrefix(n.path, 'Files').toLowerCase().endsWith(`/${target}`)
        );
      if (!nf || nf.fileSize <= 0 || nf.fileSize > 2 * 1024 * 1024) return null;
      if (nf.resident) {
        return Buffer.from(nf.residentData || Buffer.alloc(0)).subarray(0, nf.fileSize);
      }
      const hashTreeEnabled = !header.dataIntegrityDisabled && layout.hashTree.pageCount > 0;
      const out = Buffer.alloc(nf.fileSize, 0);
      let logicalCursor = 0;

      for (const run of nf.dataRuns || []) {
        if (logicalCursor >= nf.fileSize) break;
        const take = Math.min(nf.fileSize - logicalCursor, Math.max(0, Number(run.byteLength || 0)));
        if (take <= 0) continue;
        if (run.sparse) {
          logicalCursor += take;
          continue;
        }
        if (run.containerOffset === null || !Number.isFinite(run.containerOffset)) {
          if (run.isEncrypted) return null;
          const chunk = await nf.readRangeBytes(logicalCursor, take, signal);
          chunk.copy(out, logicalCursor, 0, Math.min(chunk.length, take));
          logicalCursor += take;
          continue;
        }

        const physStart = Number(run.containerOffset);
        const physEnd = physStart + take;
        const pageAlignedStart = Math.floor(physStart / XVD_PAGE_SIZE) * XVD_PAGE_SIZE;
        const pageAlignedEnd = Math.ceil(physEnd / XVD_PAGE_SIZE) * XVD_PAGE_SIZE;
        const alignedLen = pageAlignedEnd - pageAlignedStart;
        const pageCount = Math.floor(alignedLen / XVD_PAGE_SIZE);

        if (run.isEncrypted) {
          const osslKey = resolveOptionalSegmentOsslKey(run, xvcInfo, options);
          if (!osslKey) return null;
          const [rawPages, l0] = await Promise.all([
            sliceOrRead(pageAlignedStart, alignedLen),
            readL0EntriesForPages(rangeReader, layout, pageAlignedStart, pageCount, signal),
          ]);
          if (rawPages.length < alignedLen) return null;
          if (hashTreeEnabled && l0.enabled) {
            verifyXvdContiguousPagesL0(rawPages, l0.hashes, {
              firstPageByteOffset: pageAlignedStart,
              topHashBlockHash: header.topHashBlockHash,
            });
          }
          const decPages = decryptXvcRegionBuffer({
            rawBuffer: rawPages,
            firstPageByteOffset: pageAlignedStart,
            pageCount,
            dataUnits: l0.dataUnits,
            osslXtsKey: osslKey,
            header,
            regionId: run.regionId,
          });
          const sliceStart = physStart - pageAlignedStart;
          decPages.copy(out, logicalCursor, sliceStart, sliceStart + take);
        } else {
          const [rawPages, l0] = await Promise.all([
            sliceOrRead(pageAlignedStart, alignedLen),
            hashTreeEnabled
              ? readL0EntriesForPages(rangeReader, layout, pageAlignedStart, pageCount, signal)
              : Promise.resolve(null),
          ]);
          const sliceStart = physStart - pageAlignedStart;
          if (rawPages.length < sliceStart + take) return null;
          if (hashTreeEnabled && l0?.enabled && rawPages.length >= alignedLen) {
            verifyXvdContiguousPagesL0(rawPages, l0.hashes, {
              firstPageByteOffset: pageAlignedStart,
              topHashBlockHash: header.topHashBlockHash,
            });
          }
          rawPages.copy(out, logicalCursor, sliceStart, sliceStart + take);
        }
        logicalCursor += take;
      }

      return out;
    };

    if (!gameConfigBuf && mappedSegments.length > 0) {
      gameConfigBuf = await tryReadManifestSegment('microsoftgame.config').catch(() => null);
    }
    if (!appxManifestBuf && mappedSegments.length > 0) {
      appxManifestBuf = await tryReadManifestSegment('appxmanifest.xml').catch(() => null);
    }
    if (!gameConfigBuf && ntfsFiles.length > 0) {
      gameConfigBuf = await tryReadManifestNtfsFile('microsoftgame.config').catch(() => null);
    }
    if (!appxManifestBuf && ntfsFiles.length > 0) {
      appxManifestBuf = await tryReadManifestNtfsFile('appxmanifest.xml').catch(() => null);
    }

    const gameConfig = gameConfigBuf ? parseMicrosoftGameConfig(gameConfigBuf) : null;
    const appxManifest = appxManifestBuf ? parseAppxManifest(appxManifestBuf) : null;

    return {
      header,
      layout,
      xvcInfo,
      userData,
      segmentMetadata,
      mappedSegments,
      ntfsFiles,
      gameConfig,
      appxManifest,
    };
  } finally {
    if (ownsReader && typeof rangeReader?.close === 'function') {
      await rangeReader.close().catch(() => {});
    }
  }
}

/**
 * Performs rapid (< 400ms) HTTP-Range pre-download compatibility classification of an `.msixvc` package.
 * Classifies into:
 * - `tier_a_supported`: GDK (`MicrosoftGame.config`) or Desktop Bridge (`Windows.FullTrustApplication` / `mediumIL`) without kernel anti-cheat.
 * - `tier_b_legacy_uwp`: Pure UWP `CoreWindow` (`EntryPoint` without `MicrosoftGame.config` or `FullTrustApplication`).
 * - `tier_c_kernel_anticheat`: Kernel anti-cheat driver/service detected in `SegmentMetadata.bin` / container manifest.
 */
async function probeMsixvcCompatibility(options = {}) {
  const inspected = await inspectMsixvcContainer({
    ...options,
    includeNtfsFallback: options.includeNtfsFallback !== false,
  });

  const { header, layout, xvcInfo, userData, mappedSegments, ntfsFiles, gameConfig, appxManifest } =
    inspected;

  const allPaths = [
    ...mappedSegments.map((s) => s.path),
    ...userData.entries.map((e) => e.path),
    ...ntfsFiles.map((n) => n.path),
  ];

  const antiCheatSignals = detectAntiCheatSignals(allPaths);

  // Compute deduplicated uncompressed extracted byte total
  const seenFiles = new Map();
  for (const seg of mappedSegments) {
    seenFiles.set(stripFlatRootPrefix(seg.path, 'Files').toLowerCase(), seg.fileSize);
  }
  for (const entry of userData.entries) {
    const clean = stripFlatRootPrefix(entry.path, 'Files');
    if (clean.toLowerCase() === 'segmentmetadata.bin') continue;
    if (!seenFiles.has(clean.toLowerCase())) {
      seenFiles.set(clean.toLowerCase(), entry.size);
    }
  }
  for (const nf of ntfsFiles) {
    const clean = stripFlatRootPrefix(nf.path, 'Files');
    if (!seenFiles.has(clean.toLowerCase())) {
      seenFiles.set(clean.toLowerCase(), nf.fileSize);
    }
  }

  let totalExtractedBytes = 0;
  for (const sz of seenFiles.values()) {
    totalExtractedBytes += Number(sz || 0);
  }

  const hasMeaningfulGameConfig = Boolean(
    gameConfig &&
      (gameConfig.executables.length > 0 ||
        gameConfig.titleId ||
        gameConfig.msaAppId ||
        gameConfig.identity?.name)
  );

  let tier = 'tier_a_supported';
  let reason = 'Supported GDK / Win32 x64 package';

  if (antiCheatSignals.length > 0) {
    tier = 'tier_c_kernel_anticheat';
    reason = `Unsupported Windows kernel anti-cheat detected: ${antiCheatSignals
      .map((s) => s.label)
      .join(', ')}`;
  } else if (hasMeaningfulGameConfig) {
    tier = 'tier_a_supported';
    reason = 'Microsoft GDK Win32 title (MicrosoftGame.config present)';
  } else if (appxManifest?.hasFullTrustApplication) {
    tier = 'tier_a_supported';
    reason = 'Desktop Bridge Win32 title (Windows.FullTrustApplication)';
  } else if (appxManifest && appxManifest.applications.some((a) => a.isPureUwpCoreWindow)) {
    tier = 'tier_b_legacy_uwp';
    reason = `Legacy pure-UWP CoreWindow application (${appxManifest.applications[0].entryPoint}) is unsupported in Wine/CrossOver`;
  }

  const packageFamilyName =
    gameConfig?.packageFamilyName || appxManifest?.packageFamilyName || '';
  const executables = gameConfig?.executables
    ? gameConfig.executables.map((e) => e.name)
    : (appxManifest?.applications || []).map((a) => a.executable).filter(Boolean);

  return {
    tier,
    supportedOnMacBottle: tier === 'tier_a_supported',
    reason,
    antiCheatSignals,
    metadata: {
      titleId: gameConfig?.titleId || '',
      titleIdDecimal: gameConfig?.titleIdDecimal || '',
      scid: gameConfig?.scid || '',
      msaAppId: gameConfig?.msaAppId || '',
      storeId: gameConfig?.storeId || '',
      packageFamilyName,
      identityName: gameConfig?.identity?.name || appxManifest?.identity?.name || '',
      version: gameConfig?.identity?.version || appxManifest?.identity?.version || '',
      displayName:
        gameConfig?.shellVisuals?.defaultDisplayName || appxManifest?.displayName || '',
      primaryExecutable: gameConfig?.primaryExecutable || executables[0] || '',
      overrideWorkingDirectory: gameConfig?.overrideWorkingDirectory || undefined,
      executables,
      requiresXboxLive: Boolean(gameConfig?.requiresXboxLive),
    },
    gameConfig,
    appxManifest,
    encryption: {
      encryptionDisabled: header.encryptionDisabled,
      keyCount: xvcInfo.keyCount,
      keyIds: xvcInfo.encryptionKeyIds,
      encryptedRegionCount: xvcInfo.regions.filter((r) => r.isEncrypted && !header.encryptionDisabled).length,
    },
    totalExtractedBytes,
    totalContainerBytes: layout.totalContainerBytes,
    fileCount: seenFiles.size,
  };
}

module.exports = {
  XVD_MAGIC,
  XVD_PAGE_SIZE,
  XVD_HEADER_PAGES,
  XVD_HEADER_SECTION_SIZE,
  XVD_HASH_ENTRIES_PER_PAGE,
  XVD_HASH_ENTRY_SIZE,
  XVC_INFO_HEADER_SIZE,
  XVC_REGION_HEADER_SIZE,
  XVD_VOLUME_FLAGS,
  APPX_BASE32_ALPHABET,
  HELPER_EXE_BASENAMES,
  RFC3394_DEFAULT_IV,
  bytesToPages,
  pageAlignBytes,
  formatGuidLE,
  writeGuidLE,
  normalizeContainerRelPath,
  stripXmlComments,
  decodeXmlEntities,
  extractXmlAttr,
  extractXmlTagText,
  computeAppxPublisherId,
  computePackageFamilyName,
  normalizeHexTitleId,
  deriveScidFromHexTitleId,
  deriveScidFromDecimalTitleId,
  deriveDefaultScidFromTitleId,
  aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394,
  unwrapCikWithDeviceKey,
  unwrapCikRfc3394: unwrapCikWithDeviceKey,
  wrapCikWithDeviceKey,
  wrapCikRfc3394: wrapCikWithDeviceKey,
  buildOpenSslXtsKey,
  buildXvdXtsTweak,
  decryptXvdPage,
  encryptXvdPage,
  decryptContiguousPageBuffer,
  fetchRange,
  createBufferRangeReader,
  createFileRangeReader,
  createHttpRangeReader,
  createLruBlockRangeReader,
  parseXvdHeader,
  computeHashTreeLayout,
  computeXvdLayout,
  computeXvdL0PageHash,
  verifyXvdL0PageHash,
  readL0EntriesForPages,
  verifyXvdContiguousPagesL0,
  readL0DataUnitsForPages,
  parseXvcInfo,
  parseUserData,
  parseSegmentMetadata,
  isStructuralXvcRegion,
  findRegionForOffset,
  splitContainerRunsByXvcRegions,
  decryptXvcRegionBuffer,
  mapSegmentsToRegions,
  walkUnencryptedNtfsFiles,
  parseMicrosoftGameConfigXml,
  parseMicrosoftGameConfig,
  parseAppxManifestXml,
  parseAppxManifest,
  detectAntiCheatSignals,
  inspectMsixvcContainer,
  probeMsixvcCompatibility,
};
