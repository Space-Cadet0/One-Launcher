'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const {
  XVD_PAGE_SIZE,
  bytesToPages,
  createBufferRangeReader,
  createFileRangeReader,
  createHttpRangeReader,
  readL0EntriesForPages,
  readL0DataUnitsForPages,
  verifyXvdContiguousPagesL0,
  findRegionForOffset,
  splitContainerRunsByXvcRegions,
  decryptXvcRegionBuffer,
  parseMicrosoftGameConfig,
  inspectMsixvcContainer,
  probeMsixvcCompatibility,
} = require('./msixvcXvdParser.cjs');
const { parseAppxManifestXml } = require('./xboxConfigAndIds.cjs');

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

const RESUME_JOURNAL_FILENAME = '.onelauncher-xbox-journal.json';
const LEGACY_JOURNAL_FILENAME = '.onelauncher-xbox-install.json';
const DEFAULT_CHUNK_BYTES = 12 * 1024 * 1024; // 12 MiB (within 8–16 MiB coalesced window)
const MIN_COALESCE_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_COALESCE_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_COALESCE_GAP_BYTES = 64 * 1024;
const NTFS_STREAM_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB bounded NTFS streaming window (D4.4)
const DEFAULT_CONCURRENCY = 4;

function coerceCikBuffer(rawCik, deviceKey) {
  if (!rawCik) return null;
  let buf;
  if (Buffer.isBuffer(rawCik)) {
    buf = rawCik;
  } else if (rawCik instanceof Uint8Array) {
    buf = Buffer.from(rawCik);
  } else if (typeof rawCik === 'string') {
    const clean = rawCik.trim();
    if (/^[0-9a-fA-F]{64}$/.test(clean) || /^[0-9a-fA-F]{80}$/.test(clean)) {
      buf = Buffer.from(clean, 'hex');
    } else {
      buf = Buffer.from(clean, 'base64');
    }
  } else {
    return null;
  }

  if (buf.length === 40 && deviceKey) {
    buf = unwrapCikWithDeviceKey(buf, deviceKey);
  }
  if (buf.length !== 32) {
    throw new Error(`Resolved CIK must be 32 bytes (got ${buf.length})`);
  }
  return buf;
}

function buildResolvedXtsKeyResolver({ xvcInfo, cik, cikMap, cikKeys, deviceKey }) {
  const normalizedMap = new Map();
  const rawCollection = cikMap || cikKeys;
  if (rawCollection && typeof rawCollection === 'object') {
    if (Array.isArray(rawCollection)) {
      for (const item of rawCollection) {
        if (!item || typeof item !== 'object') continue;
        const kRaw = item.keyId ?? item.guid ?? item.id ?? '';
        const vRaw = item.cik ?? item.key ?? item.rawCik;
        const cikBuf = coerceCikBuffer(vRaw, deviceKey);
        if (kRaw && cikBuf) {
          normalizedMap.set(String(kRaw).toLowerCase().replace(/[{}]/g, ''), buildOpenSslXtsKey(cikBuf));
        } else if (cikBuf && normalizedMap.size === 0) {
          normalizedMap.set('0', buildOpenSslXtsKey(cikBuf));
        }
      }
    } else {
      const entries =
        rawCollection instanceof Map
          ? Array.from(rawCollection.entries())
          : Object.entries(rawCollection);
      for (const [k, v] of entries) {
        const rawVal =
          v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)
            ? v.cik ?? v.key ?? v.rawCik
            : v;
        const cikBuf = coerceCikBuffer(rawVal, deviceKey);
        if (cikBuf) {
          normalizedMap.set(String(k).toLowerCase().replace(/[{}]/g, ''), buildOpenSslXtsKey(cikBuf));
        }
      }
    }
  }

  const singleKeyBuf = coerceCikBuffer(cik, deviceKey);
  const singleOsslKey = singleKeyBuf ? buildOpenSslXtsKey(singleKeyBuf) : null;

  return function resolveOsslKeyForSegment(seg) {
    if (!seg.isEncrypted) return null;
    if (seg.keyGuid) {
      const byGuid = normalizedMap.get(seg.keyGuid.toLowerCase());
      if (byGuid) return byGuid;
    }
    if (seg.keyHex) {
      const byHex = normalizedMap.get(seg.keyHex.toLowerCase());
      if (byHex) return byHex;
    }
    if (normalizedMap.has(String(seg.keyId))) {
      return normalizedMap.get(String(seg.keyId));
    }
    const keyEntry = xvcInfo?.encryptionKeyIds?.[seg.keyId];
    if (keyEntry) {
      if (normalizedMap.has(keyEntry.guid.toLowerCase())) {
        return normalizedMap.get(keyEntry.guid.toLowerCase());
      }
      if (normalizedMap.has(keyEntry.hex.toLowerCase())) {
        return normalizedMap.get(keyEntry.hex.toLowerCase());
      }
    }
    if (singleOsslKey) return singleOsslKey;
    if (normalizedMap.size === 1) return normalizedMap.values().next().value;
    throw new Error(
      `Missing Content Integrity Key (CIK) for encrypted XVC region ${seg.regionId} (keyId=${seg.keyId}, guid=${seg.keyGuid || 'unknown'})`
    );
  };
}

// ---------------------------------------------------------------------------
// Path Containment & Symlink Escape Defense
// ---------------------------------------------------------------------------

const WIN32_RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const FORBIDDEN_WIN32_SEGMENT_CHARS_RE = /[:<>"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f]/;

function normalizeRelativeInstallPath(rawContainerPath, stripFilesPrefix = true) {
  const rawStr = String(rawContainerPath ?? '');
  if (!rawStr || CONTROL_CHARS_RE.test(rawStr)) {
    throw new Error(
      `Rejected invalid empty, null, or control-character-containing path in MSIXVC: "${rawContainerPath}"`
    );
  }

  const clean = rawStr
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (!clean) {
    throw new Error(`Rejected invalid empty path in MSIXVC: "${rawContainerPath}"`);
  }
  if (/^[a-zA-Z]:/.test(clean)) {
    throw new Error(`Rejected Windows drive-qualified path in MSIXVC: "${rawContainerPath}"`);
  }

  const rawParts = clean.split('/');
  const parts = [];
  for (const part of rawParts) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`Rejected path traversal or empty component in MSIXVC: "${rawContainerPath}"`);
    }
    if (CONTROL_CHARS_RE.test(part) || FORBIDDEN_WIN32_SEGMENT_CHARS_RE.test(part)) {
      throw new Error(`Rejected forbidden Win32/NTFS character in MSIXVC path: "${rawContainerPath}"`);
    }
    if (/[. ]$/.test(part)) {
      throw new Error(
        `Rejected trailing dot or space in MSIXVC path segment "${part}": "${rawContainerPath}"`
      );
    }
    if (WIN32_RESERVED_DEVICE_RE.test(part)) {
      throw new Error(
        `Rejected Win32 reserved device name "${part}" in MSIXVC path: "${rawContainerPath}"`
      );
    }
    parts.push(part);
  }

  if (stripFilesPrefix && parts.length > 1 && parts[0].toLowerCase() === 'files') {
    parts.shift();
  }
  return parts.join('/');
}

function resolveSafeDestinationPath(installRoot, rawContainerPath, stripFilesPrefix = true) {
  const rootResolved = path.resolve(installRoot);
  const relPath = normalizeRelativeInstallPath(rawContainerPath, stripFilesPrefix);
  const targetPath = path.resolve(rootResolved, ...relPath.split('/'));
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (!targetPath.startsWith(rootWithSep)) {
    throw new Error(`Path traversal / containment violation: "${rawContainerPath}" escaped "${rootResolved}"`);
  }
  return targetPath;
}

async function ensureSafeTargetFilePath(installRootResolved, relPath) {
  const targetPath = path.resolve(installRootResolved, ...relPath.split('/'));
  const rootWithSep = installRootResolved.endsWith(path.sep)
    ? installRootResolved
    : `${installRootResolved}${path.sep}`;

  if (!targetPath.startsWith(rootWithSep)) {
    throw new Error(`Path containment violation: "${relPath}" escaped "${installRootResolved}"`);
  }

  // Ensure parent directories exist and contain zero symlinks
  const relDirParts = relPath.split('/').slice(0, -1);
  let cursor = installRootResolved;
  for (const part of relDirParts) {
    cursor = path.join(cursor, part);
    try {
      const st = await fs.promises.lstat(cursor);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink escape blocked at directory "${cursor}"`);
      }
      if (!st.isDirectory()) {
        await fs.promises.unlink(cursor);
        await fs.promises.mkdir(cursor);
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await fs.promises.mkdir(cursor, { recursive: true });
      } else {
        throw err;
      }
    }
  }

  // Ensure target itself is not an existing symlink
  try {
    const existing = await fs.promises.lstat(targetPath);
    if (existing.isSymbolicLink()) {
      throw new Error(`Symlink overwrite blocked at "${targetPath}"`);
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  return targetPath;
}

// ---------------------------------------------------------------------------
// Crash-Safe Resume Journal (.onelauncher-xbox-journal.json)
// ---------------------------------------------------------------------------

async function loadResumeJournal(journalPath, expectedVduid) {
  let parsed = null;
  try {
    const raw = await fs.promises.readFile(journalPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT' && path.basename(journalPath) !== LEGACY_JOURNAL_FILENAME) {
      const legacyPath = path.join(path.dirname(journalPath), LEGACY_JOURNAL_FILENAME);
      try {
        const legacyRaw = await fs.promises.readFile(legacyPath, 'utf8');
        const legacyParsed = JSON.parse(legacyRaw);
        if (legacyParsed && legacyParsed.status !== 'completed') {
          parsed = legacyParsed;
        }
      } catch {
        // No legacy journal
      }
    }
  }

  if (
    parsed &&
    parsed.status !== 'completed' &&
    parsed.version === 1 &&
    (!expectedVduid || !parsed.vduidGuid || parsed.vduidGuid === expectedVduid)
  ) {
    return {
      version: 1,
      status: 'in_progress',
      vduidGuid: expectedVduid || parsed.vduidGuid || '',
      completedFiles:
        parsed.completedFiles && typeof parsed.completedFiles === 'object'
          ? parsed.completedFiles
          : {},
      completedLargeSlices:
        parsed.completedLargeSlices && typeof parsed.completedLargeSlices === 'object'
          ? parsed.completedLargeSlices
          : {},
    };
  }

  return {
    version: 1,
    status: 'in_progress',
    vduidGuid: expectedVduid || '',
    completedFiles: {},
    completedLargeSlices: {},
  };
}

function createJournalCheckpointer(journalPath, journalState) {
  let writeChain = Promise.resolve();
  let pendingTimer = null;

  const flushNow = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    journalState.status = journalState.status || 'in_progress';
    const payload = JSON.stringify(journalState, null, 2);
    const tmpPath = `${journalPath}.tmp.${process.pid}`;
    writeChain = writeChain
      .then(async () => {
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, journalPath);
      })
      .catch(() => {});
    return writeChain;
  };

  const scheduleFlush = () => {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      flushNow();
    }, 250);
    if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
  };

  return { scheduleFlush, flushNow };
}

// ---------------------------------------------------------------------------
// Work Unit Planner (8–16 MiB Coalesced Batches + Multi-Slice Large Files)
// ---------------------------------------------------------------------------

function buildExtractionWorkUnits(pendingSegments, chunkTargetBytes) {
  const targetBytes = Math.min(
    MAX_COALESCE_CHUNK_BYTES,
    Math.max(XVD_PAGE_SIZE, Number(chunkTargetBytes) || DEFAULT_CHUNK_BYTES)
  );
  const sliceAlignedBytes = Math.max(
    XVD_PAGE_SIZE,
    Math.floor(targetBytes / XVD_PAGE_SIZE) * XVD_PAGE_SIZE
  );

  // Sort segments by physical .msixvc offset for sequential CDN Range coalescing
  const sorted = pendingSegments.slice().sort((a, b) => a.diskOffset - b.diskOffset);
  const workUnits = [];
  let currentBatch = null;

  const flushBatch = () => {
    if (currentBatch) {
      workUnits.push(currentBatch);
      currentBatch = null;
    }
  };

  for (const seg of sorted) {
    if (seg.alignedByteLength > sliceAlignedBytes) {
      flushBatch();
      // Split large file across page-aligned 8–16 MiB slices
      const sliceCount = Math.ceil(seg.alignedByteLength / sliceAlignedBytes);
      const slices = [];
      for (let s = 0; s < sliceCount; s += 1) {
        const relPageByteOff = s * sliceAlignedBytes;
        const alignedLen = Math.min(sliceAlignedBytes, seg.alignedByteLength - relPageByteOff);
        const plainLen = Math.max(0, Math.min(alignedLen, seg.fileSize - relPageByteOff));
        slices.push({
          type: 'large_file_slice',
          seg,
          sliceIndex: s,
          sliceCount,
          diskOffset: seg.diskOffset + relPageByteOff,
          alignedByteLength: alignedLen,
          fileOffset: relPageByteOff,
          plainByteLength: plainLen,
        });
      }
      for (const sl of slices) {
        workUnits.push(sl);
      }
      continue;
    }

    if (!currentBatch) {
      currentBatch = {
        type: 'coalesced_segments',
        diskOffset: seg.diskOffset,
        endDiskOffset: seg.diskOffset + seg.alignedByteLength,
        segments: [seg],
        plainBytesTotal: seg.fileSize,
      };
      continue;
    }

    const gap = seg.diskOffset - currentBatch.endDiskOffset;
    const candidateSpan = seg.diskOffset + seg.alignedByteLength - currentBatch.diskOffset;
    if (gap >= 0 && gap <= MAX_COALESCE_GAP_BYTES && candidateSpan <= sliceAlignedBytes) {
      currentBatch.segments.push(seg);
      currentBatch.endDiskOffset = seg.diskOffset + seg.alignedByteLength;
      currentBatch.plainBytesTotal += seg.fileSize;
    } else {
      flushBatch();
      currentBatch = {
        type: 'coalesced_segments',
        diskOffset: seg.diskOffset,
        endDiskOffset: seg.diskOffset + seg.alignedByteLength,
        segments: [seg],
        plainBytesTotal: seg.fileSize,
      };
    }
  }

  flushBatch();
  return workUnits;
}

function alignUp(value, alignment) {
  const n = Number(value || 0);
  if (n <= 0) return 0;
  return Math.ceil(n / alignment) * alignment;
}

function doesSpanOverlapAnyXvcRegion(xvcInfo, startOffset, byteLength) {
  const regions = Array.isArray(xvcInfo) ? xvcInfo : xvcInfo?.regions;
  if (!Array.isArray(regions) || regions.length === 0 || !(byteLength > 0)) return false;
  const endOffset = startOffset + byteLength;
  for (const r of regions) {
    if (!r || !(r.length > 0)) continue;
    if (startOffset < r.offset + r.length && endOffset > r.offset) {
      return true;
    }
  }
  return false;
}

function throwIfAborted(/** @type {AbortSignal | null | undefined} */ signal) {
  if (signal?.aborted) {
    const err = Object.assign(new Error('Xbox MSIXVC extraction paused or cancelled'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    throw err;
  }
}

/**
 * Single-pass streaming MSIXVC/XVD decrypter & extractor (`decryptAll = true`).
 * Zero 2x `.msixvc` disk staging, zero `hdiutil` RAM disk, full crash-safe resume.
 */
async function extractMsixvcStream(options = {}) {
  const {
    rangeReader: providedReader,
    msixvcPath,
    msixvcBuffer,
    urls: rawUrls,
    cdnRootPaths,
    fileName,
    cik,
    cikMap,
    cikKeys,
    decryptAll = true,
    stripFilesPrefix = true,
    concurrency = DEFAULT_CONCURRENCY,
    keepResumeJournal = false,
    onProgress,
    signal,
  } = options;
  const urls = rawUrls || (options.url ? [options.url] : undefined);
  const installDir = options.installDir || options.destinationDir || options.installRoot;
  const deviceKey = options.deviceKey || options.kek || null;
  const explicitChunkBytes = options.chunkTargetBytes ?? options.maxChunkBytes;
  const chunkTargetBytes = explicitChunkBytes ?? DEFAULT_CHUNK_BYTES;

  if (!installDir || typeof installDir !== 'string') {
    throw new Error('extractMsixvcStream requires a target installDir path');
  }
  if (!decryptAll) {
    throw new Error('One Launcher requires decryptAll = true so Wine/CrossOver can load plaintext PE binaries');
  }

  const installRootResolved = path.resolve(installDir);

  let ownsReader = false;
  let rangeReader = providedReader;
  if (!rangeReader) {
    if (Buffer.isBuffer(msixvcBuffer)) {
      rangeReader = createBufferRangeReader(msixvcBuffer);
    } else if (msixvcPath) {
      rangeReader = createFileRangeReader(msixvcPath);
      ownsReader = true;
    } else {
      rangeReader = createHttpRangeReader({
        urls,
        cdnRootPaths,
        fileName,
        headers: options.headers,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
    }
  }

  try {
    throwIfAborted(signal);

    const inspected = await inspectMsixvcContainer({
      rangeReader,
      cik,
      cikMap,
      cikKeys,
      deviceKey,
      includeNtfsFallback: true,
      includeAllNtfsFiles: true,
      signal,
    });

    const { header, layout, xvcInfo, userData, mappedSegments, ntfsFiles } = inspected;
    let { gameConfig, appxManifest } = inspected;
    const hashTreeEnabled = !header.dataIntegrityDisabled && layout.hashTree.pageCount > 0;

    const resolveOsslKey = buildResolvedXtsKeyResolver({
      xvcInfo,
      cik,
      cikMap,
      cikKeys,
      deviceKey,
    });

    /**
     * Universal verified + AES-XTS-decrypting range reader for multi-run, sparse,
     * region-spanning, or non-page-aligned NTFS `$MFT` files.
     *
     * @param {any} nf
     * @param {Array<Record<string, any>>} enrichedRuns
     * @param {number} logicalOffset
     * @param {number} byteLength
     * @param {AbortSignal} [reqSignal]
     * @returns {Promise<Buffer>}
     */
    const readVerifiedAndDecryptedNtfsRange = async (
      nf,
      enrichedRuns,
      logicalOffset,
      byteLength,
      reqSignal
    ) => {
      const activeSig = reqSignal || signal;
      throwIfAborted(activeSig);
      const start = Math.max(0, Math.floor(Number(logicalOffset) || 0));
      const maxAvail = Math.max(0, nf.fileSize - start);
      const len = Math.min(maxAvail, Math.max(0, Math.floor(Number(byteLength) || 0)));
      if (len <= 0) return Buffer.alloc(0);

      const out = Buffer.alloc(len, 0);
      let streamCursor = 0;
      let curLogical = start;
      let remaining = len;
      let outPos = 0;

      for (const run of enrichedRuns) {
        throwIfAborted(activeSig);
        const runLen = Math.max(0, Number(run.byteLength || 0));
        const runStart = streamCursor;
        const runEnd = streamCursor + runLen;
        streamCursor = runEnd;

        if (curLogical >= runEnd) continue;
        if (remaining <= 0) break;

        const relStart = curLogical - runStart;
        const take = Math.min(remaining, runLen - relStart);
        if (take <= 0) continue;

        if (run.sparse) {
          outPos += take;
          curLogical += take;
          remaining -= take;
          continue;
        }

        if (run.containerOffset === null || !Number.isFinite(run.containerOffset)) {
          if (run.isEncrypted) {
            throw new Error(
              `Cannot decrypt NTFS run without physical container offset for "${nf.path}"`
            );
          }
          if (typeof nf.readRangeBytes === 'function') {
            const chunk = await nf.readRangeBytes(curLogical, take, activeSig);
            chunk.copy(out, outPos, 0, Math.min(chunk.length, take));
          }
          outPos += take;
          curLogical += take;
          remaining -= take;
          continue;
        }

        const physStart = Number(run.containerOffset) + relStart;
        const physEnd = physStart + take;
        const pageAlignedStart = Math.floor(physStart / XVD_PAGE_SIZE) * XVD_PAGE_SIZE;
        const pageAlignedEnd = Math.ceil(physEnd / XVD_PAGE_SIZE) * XVD_PAGE_SIZE;
        const alignedByteLen = pageAlignedEnd - pageAlignedStart;
        const pageCount = Math.floor(alignedByteLen / XVD_PAGE_SIZE);

        const [rawPages, spanL0] = await Promise.all([
          rangeReader.readRange(pageAlignedStart, alignedByteLen, activeSig),
          run.isEncrypted || hashTreeEnabled
            ? readL0EntriesForPages(rangeReader, layout, pageAlignedStart, pageCount, activeSig)
            : Promise.resolve(null),
        ]);

        const sliceInPages = physStart - pageAlignedStart;
        if (
          rawPages.length < sliceInPages + take ||
          (run.isEncrypted && rawPages.length < alignedByteLen)
        ) {
          throw new Error(
            `Truncated MSIXVC NTFS Range read at ${pageAlignedStart}: expected ${alignedByteLen} bytes, got ${rawPages.length}`
          );
        }

        if (hashTreeEnabled && spanL0?.enabled && pageCount > 0 && rawPages.length >= alignedByteLen) {
          verifyXvdContiguousPagesL0(rawPages, spanL0.hashes, {
            firstPageByteOffset: pageAlignedStart,
            topHashBlockHash: header.topHashBlockHash,
          });
        }

        let plainPages = rawPages;
        if (run.isEncrypted) {
          const osslKey = resolveOsslKey(run);
          plainPages = decryptXvcRegionBuffer({
            rawBuffer: rawPages,
            firstPageByteOffset: pageAlignedStart,
            pageCount,
            dataUnits: spanL0.dataUnits,
            osslXtsKey: osslKey,
            header,
            regionId: run.regionId,
            inPlace: false,
          });
        }

        plainPages.copy(out, outPos, sliceInPages, sliceInPages + take);
        outPos += take;
        curLogical += take;
        remaining -= take;
      }

      return out;
    };

    // Prepare deduplicated file plan across:
    //   1) SegmentMetadata.bin segments (primary payload + executables when present)
    //   2) user_data PackageFiles (MicrosoftGame.config, AppxManifest.xml, P7X, Summary.json)
    //   3) All non-duplicate NTFS $MFT files (plaintext AND AES-XTS encrypted, single-run AND multi-run)
    /** @type {Map<string, { source: 'segment' | 'userData' | 'ntfs', target: 'segment' | 'inline', entryObj: any, fileSize: number }>} */
    const seenRelPaths = new Map();
    const normalizedSegments = [];

    for (const seg of mappedSegments) {
      const relPath = normalizeRelativeInstallPath(seg.path, stripFilesPrefix);
      const normKey = relPath.toLowerCase();
      const segEntry = { ...seg, relPath };
      normalizedSegments.push(segEntry);
      seenRelPaths.set(normKey, {
        source: 'segment',
        target: 'segment',
        entryObj: segEntry,
        fileSize: seg.fileSize,
      });
    }

    /** @type {Array<{ relPath: string, fileSize: number, encryptedSubRuns?: Array<Record<string, any>>, readRange?: ((offset: number, len: number, sig?: AbortSignal) => Promise<Buffer>) | null, getBytes: (sig?: AbortSignal) => Promise<Buffer> }>} */
    const extraInlineFiles = [];
    for (const entry of userData.entries) {
      const relPath = normalizeRelativeInstallPath(entry.path, stripFilesPrefix);
      const normKey = relPath.toLowerCase();
      if (normKey === 'segmentmetadata.bin') continue;
      if (seenRelPaths.has(normKey)) continue;
      const inlineEntry = {
        relPath,
        fileSize: entry.data.length,
        getBytes: async () => entry.data,
      };
      extraInlineFiles.push(inlineEntry);
      seenRelPaths.set(normKey, {
        source: 'userData',
        target: 'inline',
        entryObj: inlineEntry,
        fileSize: entry.data.length,
      });
    }

    for (const nf of ntfsFiles) {
      const relPath = normalizeRelativeInstallPath(nf.path, stripFilesPrefix);
      const normKey = relPath.toLowerCase();
      if (normKey === 'segmentmetadata.bin') continue;

      const prev = seenRelPaths.get(normKey);
      if (prev) {
        if (prev.source === 'segment' || nf.fileSize <= prev.fileSize) {
          continue;
        }
        // Prefer larger/full NTFS file over smaller stub entry
        if (prev.target === 'inline') {
          const prevIdx = extraInlineFiles.indexOf(prev.entryObj);
          if (prevIdx !== -1) extraInlineFiles.splice(prevIdx, 1);
        } else {
          const prevIdx = normalizedSegments.indexOf(prev.entryObj);
          if (prevIdx !== -1) normalizedSegments.splice(prevIdx, 1);
        }
      }

      const enrichedRuns = splitContainerRunsByXvcRegions(nf.dataRuns, xvcInfo, header, layout);
      const run0 = enrichedRuns.length === 1 ? enrichedRuns[0] : null;
      const alignedByteLength = alignUp(nf.fileSize, XVD_PAGE_SIZE);
      const canPromoteToCoalescedSegment =
        !nf.resident &&
        nf.fileSize > 0 &&
        run0 !== null &&
        !run0.sparse &&
        Number.isFinite(run0.containerOffset) &&
        Number(run0.containerOffset) % XVD_PAGE_SIZE === 0 &&
        run0.byteLength >= nf.fileSize;

      if (canPromoteToCoalescedSegment && run0) {
        const containerOffset = Number(run0.containerOffset);
        const reg = findRegionForOffset(xvcInfo, containerOffset);
        const withinSingleRegion = reg
          ? containerOffset >= reg.offset && containerOffset + alignedByteLength <= reg.offset + reg.length
          : !xvcInfo?.regions?.length ||
            header.encryptionDisabled ||
            !doesSpanOverlapAnyXvcRegion(xvcInfo, containerOffset, alignedByteLength);
        const withinContainer =
          !(layout.totalContainerBytes > 0) ||
          containerOffset + alignedByteLength <= layout.totalContainerBytes;

        if (withinSingleRegion && withinContainer) {
          const pageCount = bytesToPages(alignedByteLength);
          const isEncrypted = !header.encryptionDisabled && Boolean(reg?.isEncrypted);
          const keyId = reg && Number.isFinite(reg.keyId) ? reg.keyId : 0xffff;
          const keyEntry = (xvcInfo?.encryptionKeyIds && xvcInfo.encryptionKeyIds[keyId]) || null;
          const promotedSeg = {
            relPath,
            path: nf.path,
            fileSize: nf.fileSize,
            diskOffset: containerOffset,
            alignedByteLength,
            pageCount,
            regionId: reg ? reg.id : 0,
            keyId,
            keyGuid: isEncrypted ? (keyEntry ? keyEntry.guid : reg?.keyGuid || null) : null,
            keyHex: isEncrypted ? (keyEntry ? keyEntry.hex : reg?.keyHex || null) : null,
            isEncrypted,
          };
          normalizedSegments.push(promotedSeg);
          seenRelPaths.set(normKey, {
            source: 'ntfs',
            target: 'segment',
            entryObj: promotedSeg,
            fileSize: nf.fileSize,
          });
          continue;
        }
      }

      if (nf.resident || nf.fileSize === 0) {
        const residentBuf =
          nf.fileSize === 0
            ? Buffer.alloc(0)
            : Buffer.from(nf.residentData || Buffer.alloc(0)).subarray(0, nf.fileSize);
        const inlineEntry = {
          relPath,
          fileSize: nf.fileSize,
          readRange: null,
          getBytes: async () => residentBuf,
        };
        extraInlineFiles.push(inlineEntry);
        seenRelPaths.set(normKey, {
          source: 'ntfs',
          target: 'inline',
          entryObj: inlineEntry,
          fileSize: nf.fileSize,
        });
      } else {
        const inlineEntry = {
          relPath,
          fileSize: nf.fileSize,
          encryptedSubRuns: enrichedRuns.filter((r) => r.isEncrypted),
          readRange: (offset, len, sig) =>
            readVerifiedAndDecryptedNtfsRange(nf, enrichedRuns, offset, len, sig),
          getBytes: (sig) =>
            readVerifiedAndDecryptedNtfsRange(nf, enrichedRuns, 0, nf.fileSize, sig),
        };
        extraInlineFiles.push(inlineEntry);
        seenRelPaths.set(normKey, {
          source: 'ntfs',
          target: 'inline',
          entryObj: inlineEntry,
          fileSize: nf.fileSize,
        });
      }
    }

    // Fail-fast pre-flight CIK verification BEFORE creating any directories, files, or journals on disk
    for (const seg of normalizedSegments) {
      if (seg.isEncrypted && seg.fileSize > 0) {
        const keyBuf = resolveOsslKey(seg);
        if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
          throw new Error(
            `Missing Content Integrity Key (CIK) for encrypted XVC region ${seg.regionId} (keyId=${seg.keyId}, guid=${seg.keyGuid || 'unknown'})`
          );
        }
      }
    }
    for (const inlineFile of extraInlineFiles) {
      if (inlineFile.fileSize > 0 && Array.isArray(inlineFile.encryptedSubRuns)) {
        for (const subRun of inlineFile.encryptedSubRuns) {
          const keyBuf = resolveOsslKey(subRun);
          if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
            throw new Error(
              `Missing Content Integrity Key (CIK) for encrypted XVC region ${subRun.regionId} (keyId=${subRun.keyId}, guid=${subRun.keyGuid || 'unknown'})`
            );
          }
        }
      }
    }

    // Pre-flight checks passed: now materialize target directory & crash-safe resume journal
    await fs.promises.mkdir(installRootResolved, { recursive: true });
    const journalPath = path.join(installRootResolved, RESUME_JOURNAL_FILENAME);
    const journal = await loadResumeJournal(journalPath, header.vduidGuid);
    const checkpointer = createJournalCheckpointer(journalPath, journal);

    let totalBytes = 0;
    for (const seg of normalizedSegments) totalBytes += seg.fileSize;
    for (const ext of extraInlineFiles) totalBytes += ext.fileSize;
    const totalFiles = normalizedSegments.length + extraInlineFiles.length;

    let bytesDownloaded = 0;
    let completedFilesCount = 0;
    let smoothedSpeedBps = 0;
    let lastSampleTime = Date.now();
    let lastSampleBytes = 0;

    const emitProgress = (status, statusMessage, force = false) => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      const dtSec = (now - lastSampleTime) / 1000;
      if (dtSec >= 0.25 || force) {
        if (dtSec > 0) {
          const instBps = Math.max(0, (bytesDownloaded - lastSampleBytes) / dtSec);
          smoothedSpeedBps =
            smoothedSpeedBps === 0 ? instBps : 0.35 * instBps + 0.65 * smoothedSpeedBps;
          lastSampleTime = now;
          lastSampleBytes = bytesDownloaded;
        }
      }
      const progressPercent =
        totalBytes > 0 ? Math.min(100, Number(((bytesDownloaded / totalBytes) * 100).toFixed(2))) : 100;
      const remainingBytes = Math.max(0, totalBytes - bytesDownloaded);
      const etaSeconds =
        smoothedSpeedBps > 1024 ? Math.ceil(remainingBytes / smoothedSpeedBps) : null;

      onProgress({
        status,
        bytesDownloaded,
        totalBytes,
        progressPercent,
        speedBytesPerSec: Math.round(smoothedSpeedBps),
        etaSeconds,
        completedFiles: completedFilesCount,
        totalFiles,
        statusMessage,
      });
    };

    // Determine which files are already verified complete on disk from a prior resumed run
    const isFileAlreadyComplete = async (relPath, expectedSize) => {
      const rec = journal.completedFiles[relPath];
      if (!rec || rec.size !== expectedSize) return false;
      try {
        const target = path.resolve(installRootResolved, ...relPath.split('/'));
        const st = await fs.promises.stat(target);
        return st.isFile() && st.size === expectedSize;
      } catch {
        return false;
      }
    };

    let resumedUnits = 0;

    // Step 1: Stream unencrypted inline metadata / NTFS bootstrap files in bounded 4 MiB chunks (D4.4)
    for (const inlineFile of extraInlineFiles) {
      throwIfAborted(signal);
      if (await isFileAlreadyComplete(inlineFile.relPath, inlineFile.fileSize)) {
        bytesDownloaded += inlineFile.fileSize;
        completedFilesCount += 1;
        resumedUnits += 1;
        continue;
      }
      const targetPath = await ensureSafeTargetFilePath(installRootResolved, inlineFile.relPath);
      const tmpPath = `${targetPath}.olpart`;
      let totalWritten = 0;

      if (typeof inlineFile.readRange === 'function') {
        const fh = await fs.promises.open(tmpPath, 'w');
        try {
          let logicalOff = 0;
          while (logicalOff < inlineFile.fileSize) {
            throwIfAborted(signal);
            const want = Math.min(NTFS_STREAM_CHUNK_BYTES, inlineFile.fileSize - logicalOff);
            const chunk = await inlineFile.readRange(logicalOff, want, signal);
            if (!chunk || chunk.length === 0) {
              throw new Error(
                `Truncated NTFS stream read for "${inlineFile.relPath}" at offset ${logicalOff}/${inlineFile.fileSize}`
              );
            }
            let chunkOff = 0;
            while (chunkOff < chunk.length) {
              const { bytesWritten } = await fh.write(
                chunk,
                chunkOff,
                chunk.length - chunkOff,
                logicalOff + chunkOff
              );
              if (bytesWritten <= 0) {
                throw new Error(`Short disk write on "${tmpPath}"`);
              }
              chunkOff += bytesWritten;
            }
            logicalOff += chunk.length;
            totalWritten += chunk.length;
            bytesDownloaded += chunk.length;
            emitProgress('downloading', `Streaming ${inlineFile.relPath}`);
          }
        } catch (streamErr) {
          await fh.close().catch(() => {});
          await fs.promises.unlink(tmpPath).catch(() => {});
          throw streamErr;
        }
        await fh.close();
      } else {
        const data = await inlineFile.getBytes(signal);
        const fh = await fs.promises.open(tmpPath, 'w');
        try {
          let off = 0;
          while (off < data.length) {
            const sliceLen = Math.min(NTFS_STREAM_CHUNK_BYTES, data.length - off);
            const { bytesWritten } = await fh.write(data, off, sliceLen, off);
            if (bytesWritten <= 0) {
              throw new Error(`Short disk write on "${tmpPath}"`);
            }
            off += bytesWritten;
          }
          totalWritten = data.length;
        } catch (writeErr) {
          await fh.close().catch(() => {});
          await fs.promises.unlink(tmpPath).catch(() => {});
          throw writeErr;
        }
        await fh.close();
        bytesDownloaded += inlineFile.fileSize;
      }

      await fs.promises.rename(tmpPath, targetPath);
      journal.completedFiles[inlineFile.relPath] = { size: totalWritten };
      checkpointer.scheduleFlush();
      completedFilesCount += 1;
    }

    // Step 2: Filter remaining segments & build coalesced 8–16 MiB Range work queue
    const pendingSegments = [];
    for (const seg of normalizedSegments) {
      if (await isFileAlreadyComplete(seg.relPath, seg.fileSize)) {
        bytesDownloaded += seg.fileSize;
        completedFilesCount += 1;
        resumedUnits += 1;
      } else {
        pendingSegments.push(seg);
      }
    }

    // Adjust chunk size: clamp into [8 MiB, 16 MiB] unless caller explicitly passed a custom size (e.g. unit test)
    const effectiveChunkBytes =
      explicitChunkBytes !== undefined
        ? Math.max(XVD_PAGE_SIZE, Number(explicitChunkBytes))
        : Math.min(MAX_COALESCE_CHUNK_BYTES, Math.max(MIN_COALESCE_CHUNK_BYTES, chunkTargetBytes));

    const allWorkUnits = buildExtractionWorkUnits(pendingSegments, effectiveChunkBytes);

    // Track multi-slice large file state (`<target>.olpart` open file handles & remaining slice counts)
    const largeFileStates = new Map();
    const runnableUnits = [];

    for (const unit of allWorkUnits) {
      if (unit.type !== 'large_file_slice') {
        runnableUnits.push(unit);
        continue;
      }
      const { seg, sliceIndex, sliceCount, plainByteLength } = unit;
      let st = largeFileStates.get(seg.relPath);
      if (!st) {
        const doneArr = Array.isArray(journal.completedLargeSlices[seg.relPath])
          ? journal.completedLargeSlices[seg.relPath]
          : [];
        st = {
          seg,
          sliceCount,
          completedSet: new Set(doneArr),
          handlePromise: null,
          targetPath: null,
          partPath: null,
        };
        largeFileStates.set(seg.relPath, st);
      }

      if (st.completedSet.has(sliceIndex)) {
        bytesDownloaded += plainByteLength;
        resumedUnits += 1;
      } else {
        runnableUnits.push(unit);
      }
    }

    // Finalize any large file whose slices were 100% completed right before a prior crash
    for (const [, st] of largeFileStates.entries()) {
      if (st.completedSet.size >= st.sliceCount) {
        const targetPath = await ensureSafeTargetFilePath(installRootResolved, st.seg.relPath);
        const partPath = `${targetPath}.olpart`;
        try {
          await fs.promises.truncate(partPath, st.seg.fileSize);
          await fs.promises.rename(partPath, targetPath);
          journal.completedFiles[st.seg.relPath] = { size: st.seg.fileSize };
          delete journal.completedLargeSlices[st.seg.relPath];
          completedFilesCount += 1;
        } catch {
          // Will re-extract if .olpart was missing
        }
      }
    }

    emitProgress('downloading', 'Streaming & decrypting Xbox MSIXVC package...', true);

    const ensureLargeFileHandle = async (st) => {
      if (!st.handlePromise) {
        st.handlePromise = (async () => {
          const targetPath = await ensureSafeTargetFilePath(installRootResolved, st.seg.relPath);
          const partPath = `${targetPath}.olpart`;
          st.targetPath = targetPath;
          st.partPath = partPath;
          const exists = await fs.promises
            .stat(partPath)
            .then(() => true)
            .catch(() => false);
          return fs.promises.open(partPath, exists ? 'r+' : 'w+');
        })();
      }
      return st.handlePromise;
    };

    const workerCount = Math.max(1, Math.min(6, Number(concurrency) || DEFAULT_CONCURRENCY));
    let queueCursor = 0;

    const processWorkUnit = async (unit) => {
      throwIfAborted(signal);

      if (unit.type === 'coalesced_segments') {
        const spanBytes = unit.endDiskOffset - unit.diskOffset;
        const anyEncrypted = unit.segments.some((s) => s.isEncrypted);
        const totalSpanPages = Math.floor(spanBytes / XVD_PAGE_SIZE);
        const [rawChunk, spanL0] = await Promise.all([
          rangeReader.readRange(unit.diskOffset, spanBytes, signal),
          anyEncrypted || hashTreeEnabled
            ? readL0EntriesForPages(rangeReader, layout, unit.diskOffset, totalSpanPages, signal)
            : Promise.resolve(null),
        ]);
        if (rawChunk.length < spanBytes) {
          throw new Error(
            `Truncated MSIXVC Range read at ${unit.diskOffset}: expected ${spanBytes} bytes, got ${rawChunk.length}`
          );
        }

        const spanDataUnits = spanL0 ? spanL0.dataUnits : null;

        for (const seg of unit.segments) {
          throwIfAborted(signal);
          const relByteStart = seg.diskOffset - unit.diskOffset;
          const relPageStart = Math.floor(relByteStart / XVD_PAGE_SIZE);
          const segRawAligned = rawChunk.subarray(relByteStart, relByteStart + seg.alignedByteLength);

          if (hashTreeEnabled && spanL0?.enabled && seg.pageCount > 0) {
            const segHashes = spanL0.hashes.slice(relPageStart, relPageStart + seg.pageCount);
            verifyXvdContiguousPagesL0(segRawAligned, segHashes, {
              firstPageByteOffset: seg.diskOffset,
              topHashBlockHash: header.topHashBlockHash,
            });
          }

          let plainBuffer;
          if (seg.fileSize === 0) {
            plainBuffer = Buffer.alloc(0);
          } else if (seg.isEncrypted) {
            const osslKey = resolveOsslKey(seg);
            const segUnits = spanDataUnits.subarray(relPageStart, relPageStart + seg.pageCount);
            const decryptedAligned = decryptContiguousPageBuffer({
              rawBuffer: segRawAligned,
              firstPageDiskOffset: seg.diskOffset,
              pageCount: seg.pageCount,
              dataUnits: segUnits,
              osslXtsKey: osslKey,
              regionId: header.regionIdInXts ? seg.regionId : 0,
              vduidLow8: header.vduidLow8,
              inPlace: true,
            });
            plainBuffer = decryptedAligned.subarray(0, seg.fileSize);
          } else {
            plainBuffer = segRawAligned.subarray(0, seg.fileSize);
          }

          const targetPath = await ensureSafeTargetFilePath(installRootResolved, seg.relPath);
          const tmpPath = `${targetPath}.olpart`;
          await fs.promises.writeFile(tmpPath, plainBuffer);
          await fs.promises.rename(tmpPath, targetPath);

          journal.completedFiles[seg.relPath] = { size: seg.fileSize };
          checkpointer.scheduleFlush();
          bytesDownloaded += seg.fileSize;
          completedFilesCount += 1;
          emitProgress('downloading', `Extracted ${seg.relPath}`);
        }
        return;
      }

      if (unit.type === 'large_file_slice') {
        const { seg, sliceIndex, diskOffset, alignedByteLength, fileOffset, plainByteLength } = unit;
        const pageCount = bytesToPages(alignedByteLength);
        const [rawSlice, sliceL0] = await Promise.all([
          rangeReader.readRange(diskOffset, alignedByteLength, signal),
          seg.isEncrypted || hashTreeEnabled
            ? readL0EntriesForPages(rangeReader, layout, diskOffset, pageCount, signal)
            : Promise.resolve(null),
        ]);

        if (rawSlice.length < alignedByteLength) {
          throw new Error(
            `Truncated MSIXVC large-slice Range read at ${diskOffset}: expected ${alignedByteLength}, got ${rawSlice.length}`
          );
        }

        if (hashTreeEnabled && sliceL0?.enabled && pageCount > 0) {
          verifyXvdContiguousPagesL0(rawSlice, sliceL0.hashes, {
            firstPageByteOffset: diskOffset,
            topHashBlockHash: header.topHashBlockHash,
          });
        }

        let plainSlice;
        if (seg.isEncrypted) {
          const osslKey = resolveOsslKey(seg);
          const decAligned = decryptContiguousPageBuffer({
            rawBuffer: rawSlice,
            firstPageDiskOffset: diskOffset,
            pageCount,
            dataUnits: sliceL0.dataUnits,
            osslXtsKey: osslKey,
            regionId: header.regionIdInXts ? seg.regionId : 0,
            vduidLow8: header.vduidLow8,
            inPlace: true,
          });
          plainSlice = decAligned.subarray(0, plainByteLength);
        } else {
          plainSlice = rawSlice.subarray(0, plainByteLength);
        }

        const st = largeFileStates.get(seg.relPath);
        const fh = await ensureLargeFileHandle(st);
        let written = 0;
        while (written < plainSlice.length) {
          const { bytesWritten } = await fh.write(
            plainSlice,
            written,
            plainSlice.length - written,
            fileOffset + written
          );
          if (bytesWritten <= 0) throw new Error(`Short disk write on ${st.partPath}`);
          written += bytesWritten;
        }

        st.completedSet.add(sliceIndex);
        journal.completedLargeSlices[seg.relPath] = Array.from(st.completedSet);
        bytesDownloaded += plainByteLength;

        if (st.completedSet.size >= st.sliceCount) {
          await fh.truncate(seg.fileSize);
          await fh.sync();
          await fh.close();
          st.handlePromise = null;
          await fs.promises.rename(st.partPath, st.targetPath);
          journal.completedFiles[seg.relPath] = { size: seg.fileSize };
          delete journal.completedLargeSlices[seg.relPath];
          completedFilesCount += 1;
        }

        checkpointer.scheduleFlush();
        emitProgress('downloading', `Streaming ${seg.relPath}`);
      }
    };

    const runners = Array.from({ length: Math.min(workerCount, Math.max(1, runnableUnits.length)) }, async () => {
      while (true) {
        throwIfAborted(signal);
        const idx = queueCursor;
        queueCursor += 1;
        if (idx >= runnableUnits.length) break;
        await processWorkUnit(runnableUnits[idx]);
      }
    });

    try {
      await Promise.all(runners);
    } finally {
      // Always close any open large-file handles cleanly on error/pause/completion
      for (const [, st] of largeFileStates.entries()) {
        if (st.handlePromise) {
          const fh = await st.handlePromise.catch(() => null);
          st.handlePromise = null;
          if (fh) await fh.close().catch(() => {});
        }
      }
      await checkpointer.flushNow();
    }

    if (!keepResumeJournal) {
      await fs.promises.unlink(journalPath).catch(() => {});
      const legacyJournalPath = path.join(installRootResolved, LEGACY_JOURNAL_FILENAME);
      try {
        const legacyRaw = await fs.promises.readFile(legacyJournalPath, 'utf8');
        const legacyParsed = JSON.parse(legacyRaw);
        if (!legacyParsed || legacyParsed.status !== 'completed') {
          await fs.promises.unlink(legacyJournalPath).catch(() => {});
        }
      } catch {
        // Legacy journal absent
      }
    }

    const readExtractedManifestCaseInsensitive = async (/** @type {string} */ targetLowerName) => {
      const exactCandidates = [
        path.join(installRootResolved, targetLowerName),
        targetLowerName === 'microsoftgame.config'
          ? path.join(installRootResolved, 'MicrosoftGame.Config')
          : path.join(installRootResolved, 'AppxManifest.xml'),
        targetLowerName === 'microsoftgame.config'
          ? path.join(installRootResolved, 'MicrosoftGame.config')
          : path.join(installRootResolved, 'appxmanifest.xml'),
        path.join(installRootResolved, 'Content', targetLowerName),
        targetLowerName === 'microsoftgame.config'
          ? path.join(installRootResolved, 'Content', 'MicrosoftGame.Config')
          : path.join(installRootResolved, 'Content', 'AppxManifest.xml'),
        targetLowerName === 'microsoftgame.config'
          ? path.join(installRootResolved, 'Content', 'MicrosoftGame.config')
          : path.join(installRootResolved, 'Content', 'appxmanifest.xml'),
      ];
      for (const cand of exactCandidates) {
        try {
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            return await fs.promises.readFile(cand, 'utf8');
          }
        } catch {}
      }
      const searchDirs = [installRootResolved];
      try {
        const rootEntries = await fs.promises.readdir(installRootResolved, { withFileTypes: true });
        for (const ent of rootEntries) {
          if (ent.isFile() && ent.name.toLowerCase() === targetLowerName) {
            return await fs.promises.readFile(path.join(installRootResolved, ent.name), 'utf8');
          }
          if (ent.isDirectory() && ent.name.toLowerCase() === 'content') {
            searchDirs.push(path.join(installRootResolved, ent.name));
          }
        }
        for (let i = 1; i < searchDirs.length; i += 1) {
          const subDir = searchDirs[i];
          const subEntries = await fs.promises.readdir(subDir, { withFileTypes: true });
          for (const ent of subEntries) {
            if (ent.isFile() && ent.name.toLowerCase() === targetLowerName) {
              return await fs.promises.readFile(path.join(subDir, ent.name), 'utf8');
            }
          }
        }
      } catch {}
      return '';
    };

    if (!gameConfig) {
      try {
        const extractedCfg = await readExtractedManifestCaseInsensitive('microsoftgame.config');
        if (extractedCfg) {
          gameConfig = parseMicrosoftGameConfig(extractedCfg);
        }
      } catch {
        // Optional if Desktop Bridge title without MicrosoftGame.config
      }
    }

    if (!appxManifest) {
      try {
        const extractedAppx = await readExtractedManifestCaseInsensitive('appxmanifest.xml');
        if (extractedAppx) {
          appxManifest = parseAppxManifestXml(extractedAppx);
        }
      } catch {
        // Optional when AppxManifest.xml is absent
      }
    }

    emitProgress('completed', 'Xbox MSIXVC installation complete', true);

    const primaryExecutableRel =
      gameConfig?.primaryExecutable ||
      appxManifest?.applications?.[0]?.executable ||
      '';

    return {
      installDir: installRootResolved,
      totalBytes,
      bytesDownloaded,
      fileCount: totalFiles,
      resumedUnits,
      vduidGuid: header.vduidGuid,
      contentId: xvcInfo.contentId,
      gameConfig,
      appxManifest,
      primaryExecutablePath: primaryExecutableRel
        ? path.join(installRootResolved, ...primaryExecutableRel.split('/'))
        : '',
    };
  } finally {
    if (ownsReader && typeof rangeReader?.close === 'function') {
      await rangeReader.close().catch(() => {});
    }
  }
}

/**
 * Runs `extractMsixvcStream` inside a dedicated Node.js `worker_threads` Worker
 * so AES-128-XTS decryption and disk I/O never block Electron's main event loop.
 *
 * @param {Record<string, any>} [options]
 */
function extractMsixvcInWorker(options = {}) {
  const { onProgress, signal, ...serializableOpts } = options;
  const resolvedInstallDir =
    serializableOpts.installDir || serializableOpts.destinationDir || serializableOpts.installRoot;
  const resolvedDeviceKey = serializableOpts.deviceKey || serializableOpts.kek || null;
  const resolvedChunkBytes = serializableOpts.chunkTargetBytes ?? serializableOpts.maxChunkBytes;
  const resolvedUrls =
    serializableOpts.urls || (serializableOpts.url ? [serializableOpts.url] : null);

  // Serialize Buffer fields cleanly for structured clone
  const payload = {
    installDir: resolvedInstallDir,
    msixvcPath: serializableOpts.msixvcPath || null,
    urls: resolvedUrls,
    cdnRootPaths: serializableOpts.cdnRootPaths || null,
    fileName: serializableOpts.fileName || null,
    headers: serializableOpts.headers || null,
    timeoutMs: serializableOpts.timeoutMs || 30_000,
    cik: Buffer.isBuffer(serializableOpts.cik)
      ? serializableOpts.cik.toString('hex')
      : serializableOpts.cik || null,
    cikMap: serializableOpts.cikMap
      ? Object.fromEntries(
          Object.entries(
            serializableOpts.cikMap instanceof Map
              ? Object.fromEntries(serializableOpts.cikMap.entries())
              : serializableOpts.cikMap
          ).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v])
        )
      : null,
    cikKeys: Array.isArray(serializableOpts.cikKeys)
      ? serializableOpts.cikKeys.map((item) =>
          item && typeof item === 'object'
            ? {
                ...item,
                cik: Buffer.isBuffer(item.cik) ? item.cik.toString('hex') : item.cik,
              }
            : item
        )
      : null,
    deviceKey: Buffer.isBuffer(resolvedDeviceKey)
      ? resolvedDeviceKey.toString('hex')
      : resolvedDeviceKey,
    stripFilesPrefix: serializableOpts.stripFilesPrefix !== false,
    concurrency: serializableOpts.concurrency || DEFAULT_CONCURRENCY,
    ...(resolvedChunkBytes !== undefined ? { chunkTargetBytes: resolvedChunkBytes } : {}),
    keepResumeJournal: Boolean(serializableOpts.keepResumeJournal),
  };

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Xbox MSIXVC extraction aborted before start');
      err.name = 'AbortError';
      reject(err);
      return;
    }

    const worker = new Worker(__filename, {
      workerData: { isXboxExtractorWorker: true, payload },
    });

    let settled = false;
    const onAbort = () => {
      worker.postMessage({ type: 'abort' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = (terminateWorker = false) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (terminateWorker) {
        worker.terminate().catch(() => {});
      }
    };

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(msg.progress);
      } else if (msg.type === 'done' && !settled) {
        settled = true;
        cleanup(true);
        resolve(msg.result);
      } else if (msg.type === 'error' && !settled) {
        settled = true;
        cleanup(true);
        const err = Object.assign(new Error(msg.message || 'Worker extraction failed'), {
          ...(msg.name ? { name: msg.name } : {}),
          ...(msg.code ? { code: msg.code } : {}),
        });
        reject(err);
      }
    });

    worker.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup(true);
        reject(err);
      }
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        cleanup(false);
        reject(new Error(`Xbox MSIXVC worker exited with code ${code}`));
      }
    });
  });
}

if (!isMainThread && workerData?.isXboxExtractorWorker && parentPort) {
  const abortCtrl = new AbortController();
  const onParentMessage = (msg) => {
    if (msg && msg.type === 'abort') {
      abortCtrl.abort();
    }
  };
  parentPort.on('message', onParentMessage);

  extractMsixvcStream({
    ...workerData.payload,
    signal: abortCtrl.signal,
    onProgress: (progress) => {
      parentPort.postMessage({ type: 'progress', progress });
    },
  })
    .then((result) => {
      parentPort.off('message', onParentMessage);
      parentPort.postMessage({ type: 'done', result });
    })
    .catch((err) => {
      parentPort.off('message', onParentMessage);
      parentPort.postMessage({
        type: 'error',
        message: err?.message || String(err),
        name: err?.name || 'Error',
        code: err?.code || undefined,
      });
    });
}

module.exports = {
  RESUME_JOURNAL_FILENAME,
  LEGACY_JOURNAL_FILENAME,
  JOURNAL_FILENAME: RESUME_JOURNAL_FILENAME,
  RFC3394_DEFAULT_IV,
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
  normalizeRelativeInstallPath,
  resolveSafeDestinationPath,
  probeMsixvcCompatibility,
  extractMsixvcStream,
  extractMsixvcImage: extractMsixvcStream,
  extractMsixvcInWorker,
};
