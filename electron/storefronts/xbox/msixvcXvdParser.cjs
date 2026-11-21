// @ts-check
'use strict';

/**
 * MSIXVC / XVD Container Parser, HashTree Merkle Verifier & Compatibility Prober Facade.
 *
 * Preserves 100% of existing `msixvcXvdParser.cjs` exports backed by 5 cohesive modules
 * under `electron/storefronts/xbox/xvd/`:
 *   - `xvdConstantsAndPrimitives.cjs`
 *   - `xvdRangeReaders.cjs`
 *   - `xvdHeaderAndHashTree.cjs`
 *   - `xvdXvcAndSegments.cjs`
 *   - `xvdNtfsWalker.cjs`
 */

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

const {
  XVD_MAGIC,
  XVD_PAGE_SIZE,
  XVD_HEADER_PAGES,
  XVD_HEADER_SECTION_SIZE,
  XVD_HASH_ENTRIES_PER_PAGE,
  XVD_HASH_ENTRY_SIZE,
  XVC_INFO_HEADER_SIZE,
  XVC_REGION_HEADER_SIZE,
  XVD_VOLUME_FLAGS,
  MAX_XVD_METADATA_ALLOC_BYTES,
  MAX_NTFS_READ_ALL_BYTES,
  readSafeU64LE,
  bytesToPages,
  pageAlignBytes,
  formatGuidLE,
  writeGuidLE,
} = require('./xvd/xvdConstantsAndPrimitives.cjs');

const {
  ALLOWED_XVD_CDN_HOSTS,
  ALLOWED_XVD_HTTP_EXACT_HOSTS,
  ALLOWED_XVD_HTTP_HOST_SUFFIXES,
  redactUrlForLog,
  validateXvdCdnUrl,
  fetchRange,
  createBufferRangeReader,
  createFileRangeReader,
  createHttpRangeReader,
  createLruBlockRangeReader,
} = require('./xvd/xvdRangeReaders.cjs');

const {
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
} = require('./xvd/xvdHeaderAndHashTree.cjs');

const {
  parseXvcInfo,
  parseUserData,
  parseSegmentMetadata,
  isStructuralXvcRegion,
  findRegionForOffset,
  splitContainerRunsByXvcRegions,
  decryptXvcRegionBuffer,
  mapSegmentsToRegions,
  detectAntiCheatSignals,
  stripFlatRootPrefix,
  resolveOptionalSegmentOsslKey,
} = require('./xvd/xvdXvcAndSegments.cjs');

const {
  decodeNtfsDataRuns,
  resolveSafeNtfsMftRecordSize,
  walkUnencryptedNtfsFiles,
} = require('./xvd/xvdNtfsWalker.cjs');

/**
 * Parses `MicrosoftGame.config` XML text into canonical One Launcher Xbox metadata
 * via canonical `xboxConfigAndIds.cjs` (`D2.3`).
 *
 * @param {Buffer|string} xmlInput
 */
function parseMicrosoftGameConfig(xmlInput) {
  return parseMicrosoftGameConfigXml(xmlInput);
}

/**
 * Parses `AppxManifest.xml` into structured identity, entry-point, and trust metadata
 * via canonical `xboxConfigAndIds.cjs` (`D2.3`).
 *
 * @param {Buffer|string} xmlInput
 */
function parseAppxManifest(xmlInput) {
  return parseAppxManifestXml(xmlInput);
}

/**
 * Reads container headers (`XvdHeader`, `user_data`, `XvcInfo`, `SegmentMetadata.bin`, plus NTFS fallback)
 * using minimal coalesced Range requests and full Merkle HashTree verification (`L0 -> L3 -> topHashBlockHash`).
 *
 * @param {Record<string, any>} [options]
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
        maxRedirects: options.maxRedirects,
        allowedHosts: options.allowedHosts,
        ...(typeof options.allowLocalhost === 'boolean'
          ? { allowLocalhost: options.allowLocalhost }
          : {}),
      });
    }
  }

  if (!rangeReader || typeof rangeReader.readRange !== 'function') {
    throw new TypeError(
      'inspectMsixvcContainer requires a rangeReader, urls, msixvcPath, or buffer'
    );
  }

  try {
    // Step 1: Coalesced 128 KiB initial read covers XvdHeader (0x3000) and often small hash_tree + user_data
    const initialProbeSize = 128 * 1024;
    const initialBuf = await rangeReader.readRange(0, initialProbeSize, signal);
    const header = parseXvdHeader(initialBuf);
    const layout = computeXvdLayout(header);

    /**
     * @param {number} byteOffset
     * @param {number} byteLength
     */
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
      if (layout.userData.byteLength > MAX_XVD_METADATA_ALLOC_BYTES) {
        throw new RangeError(
          `XVD userData (${layout.userData.byteLength} bytes) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
        );
      }
      if (layout.xvcInfo.byteLength > MAX_XVD_METADATA_ALLOC_BYTES) {
        throw new RangeError(
          `XVD xvcInfo (${layout.xvcInfo.byteLength} bytes) exceeds ${MAX_XVD_METADATA_ALLOC_BYTES} byte cap`
        );
      }
      if (layout.userData.byteLength > 0) {
        userDataBuf = await sliceOrRead(layout.userData.byteOffset, layout.userData.byteLength);
      }
      if (layout.xvcInfo.byteLength > 0) {
        xvcInfoBuf = await sliceOrRead(layout.xvcInfo.byteOffset, layout.xvcInfo.byteLength);
      }
    }

    const userData = parseUserData(userDataBuf);
    const xvcInfo = parseXvcInfo(xvcInfoBuf);

    /** @param {string} suffix */
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

    /** @type {any[]} */
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
          if (
            !segMetaEntry &&
            (lower === 'segmentmetadata.bin' || lower.endsWith('/segmentmetadata.bin')) &&
            nf.isPlaintextAccessible
          ) {
            const data = await nf.readAllBytes(signal);
            segMetaEntry = { path: nf.path, size: data.length, data };
          } else if (
            !gameConfigBuf &&
            (lower === 'microsoftgame.config' || lower.endsWith('/microsoftgame.config')) &&
            nf.isPlaintextAccessible
          ) {
            gameConfigBuf = await nf.readAllBytes(signal);
          } else if (
            !appxManifestBuf &&
            (lower === 'appxmanifest.xml' || lower.endsWith('/appxmanifest.xml')) &&
            nf.isPlaintextAccessible
          ) {
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

    const l0MerkleOpts = { topHashBlockHash: header.topHashBlockHash };

    // Fallback: if MicrosoftGame.config or AppxManifest.xml lives inside mappedSegments (plaintext or with optional CIK)
    /** @param {string} suffix */
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
          readL0EntriesForPages(
            rangeReader,
            layout,
            seg.diskOffset,
            seg.pageCount,
            signal,
            l0MerkleOpts
          ),
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
          readL0EntriesForPages(
            rangeReader,
            layout,
            seg.diskOffset,
            seg.pageCount,
            signal,
            l0MerkleOpts
          ),
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
    /** @param {string} suffix */
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
            readL0EntriesForPages(
              rangeReader,
              layout,
              pageAlignedStart,
              pageCount,
              signal,
              l0MerkleOpts
            ),
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
              ? readL0EntriesForPages(
                  rangeReader,
                  layout,
                  pageAlignedStart,
                  pageCount,
                  signal,
                  l0MerkleOpts
                )
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
 *
 * @param {Record<string, any>} [options]
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
      encryptedRegionCount: xvcInfo.regions.filter(
        (r) => r.isEncrypted && !header.encryptionDisabled
      ).length,
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
  ALLOWED_XVD_CDN_HOSTS,
  ALLOWED_XVD_HTTP_EXACT_HOSTS,
  ALLOWED_XVD_HTTP_HOST_SUFFIXES,
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
  redactUrlForLog,
  validateXvdCdnUrl,
  fetchRange,
  createBufferRangeReader,
  createFileRangeReader,
  createHttpRangeReader,
  createLruBlockRangeReader,
  MAX_XVD_METADATA_ALLOC_BYTES,
  MAX_NTFS_READ_ALL_BYTES,
  readSafeU64LE,
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
  parseXvcInfo,
  parseUserData,
  parseSegmentMetadata,
  isStructuralXvcRegion,
  findRegionForOffset,
  splitContainerRunsByXvcRegions,
  decryptXvcRegionBuffer,
  mapSegmentsToRegions,
  decodeNtfsDataRuns,
  resolveSafeNtfsMftRecordSize,
  walkUnencryptedNtfsFiles,
  parseMicrosoftGameConfigXml,
  parseMicrosoftGameConfig,
  parseAppxManifestXml,
  parseAppxManifest,
  detectAntiCheatSignals,
  inspectMsixvcContainer,
  probeMsixvcCompatibility,
};
