// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectImageMagicBytes } = require('../storefrontLocalCacheFederator.cjs');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  electron,
  OFFLINE_VAULT_TIER_CAPS,
  MAX_P1_RECENT_DETAIL_GAMES,
  MIN_FREE_DISK_BYTES_FOR_BLOBS,
  PASS_THROUGH_MAX_BYTES,
  UNRESIZED_STATIC_PASS_THROUGH_MAX_BYTES,
  TRANSPARENT_PNG_PASS_THROUGH_MAX_BYTES,
  GIF_PASS_THROUGH_MAX_BYTES,
  MAX_INLINE_ANIMATED_GIF_CACHE_BYTES,
  ROLE_MAX_WIDTHS,
  parseVaultJson,
  yieldEventLoop,
  getSqliteDiskBytes,
  getFreeDiskBytes,
  refreshInMemoryBlobIndex,
} = require('./vaultSchemaAndLifecycle.cjs');
const { isAnimatedGifBuffer, normalizeAssetIdentityUrl } = require('./vaultMetadataLattice.cjs');

/**
 * @param {any} service
 * @param {string} sha256
 * @param {string} ext
 * @returns {string}
 */
function getBlobFilePath(service, sha256, ext) {
  service.ensureOpen();
  const cleanSha = String(sha256 || '').toLowerCase().trim();
  const cleanExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  return path.join(service.blobsDir, cleanSha.slice(0, 2), `${cleanSha}.${cleanExt}`);
}

/**
 * @param {any} service
 * @param {Buffer} rawBuffer
 * @param {string} [roleOrContentType]
 * @param {string} [maybeRole]
 */
function normalizeImageBuffer(service, rawBuffer, roleOrContentType = 'cover', maybeRole) {
  let assetRole = 'cover';
  if (typeof maybeRole === 'string' && maybeRole.trim()) {
    assetRole = maybeRole.trim();
  } else if (typeof roleOrContentType === 'string') {
    const trimmed = roleOrContentType.trim();
    if (trimmed && !trimmed.includes('/')) {
      assetRole = trimmed;
    }
  }

  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length < 33) {
    return { valid: false };
  }
  const magic = detectImageMagicBytes(rawBuffer);
  if (!magic.valid || !magic.ext || !magic.mimeType) {
    return { valid: false };
  }

  const ext = magic.ext;
  const mimeType = magic.mimeType;

  // Animated GIFs MUST NEVER be flattened via nativeImage.toJPEG (which extracts only frame 0)!
  if (ext === 'gif' && isAnimatedGifBuffer(rawBuffer)) {
    return {
      valid: true,
      buffer: rawBuffer,
      ext: 'gif',
      mimeType: 'image/gif',
      normalized: false,
      animated: true,
      ...(rawBuffer.length > MAX_INLINE_ANIMATED_GIF_CACHE_BYTES ? { skipDiskBlob: true } : {}),
    };
  }

  const normalizedAssetRole = assetRole.toLowerCase();
  const isAlphaSensitiveRole =
    normalizedAssetRole === 'icon' ||
    normalizedAssetRole === 'logo' ||
    normalizedAssetRole === 'achievement_icon';
  const effectivePassThroughBytes =
    isAlphaSensitiveRole && ext === 'png'
      ? TRANSPARENT_PNG_PASS_THROUGH_MAX_BYTES
      : PASS_THROUGH_MAX_BYTES;

  if (
    ext === 'webp' ||
    ext === 'avif' ||
    ext === 'ico' ||
    ((ext === 'jpg' || ext === 'png') && rawBuffer.length <= effectivePassThroughBytes) ||
    (ext === 'gif' && rawBuffer.length <= GIF_PASS_THROUGH_MAX_BYTES)
  ) {
    return {
      valid: true,
      buffer: rawBuffer,
      ext,
      mimeType,
      normalized: false,
    };
  }

  const nativeImageImpl = service.options.nativeImage || electron.nativeImage;
  if (nativeImageImpl && typeof nativeImageImpl.createFromBuffer === 'function') {
    try {
      let img = nativeImageImpl.createFromBuffer(rawBuffer);
      if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
        const maxWidth = ROLE_MAX_WIDTHS[normalizedAssetRole] || 800;
        const sz = typeof img.getSize === 'function' ? img.getSize() : null;
        const needsResize = Boolean(
          sz &&
            typeof sz.width === 'number' &&
            sz.width > maxWidth &&
            typeof img.resize === 'function'
        );
        const unresizedCapBytes =
          ext === 'gif'
            ? GIF_PASS_THROUGH_MAX_BYTES
            : isAlphaSensitiveRole && ext === 'png'
              ? TRANSPARENT_PNG_PASS_THROUGH_MAX_BYTES
              : UNRESIZED_STATIC_PASS_THROUGH_MAX_BYTES;
        const exceedsUnresizedCap = rawBuffer.length > unresizedCapBytes;

        if (!needsResize && !exceedsUnresizedCap) {
          return {
            valid: true,
            buffer: rawBuffer,
            ext,
            mimeType,
            normalized: false,
          };
        }

        if (needsResize) {
          const targetHeight =
            typeof sz.height === 'number' && sz.height > 0
              ? Math.max(1, Math.round((sz.height * maxWidth) / sz.width))
              : undefined;
          img = img.resize(
            targetHeight ? { width: maxWidth, height: targetHeight } : { width: maxWidth }
          );
        }
        if (isAlphaSensitiveRole && ext === 'png') {
          if (typeof img.toPNG === 'function') {
            const pngBuf = img.toPNG();
            if (
              Buffer.isBuffer(pngBuf) &&
              pngBuf.length >= 33 &&
              pngBuf.length < rawBuffer.length &&
              detectImageMagicBytes(pngBuf).valid
            ) {
              return {
                valid: true,
                buffer: pngBuf,
                ext: 'png',
                mimeType: 'image/png',
                normalized: true,
              };
            }
          }
        } else if (typeof img.toJPEG === 'function') {
          const jpegBuf = img.toJPEG(82);
          if (
            Buffer.isBuffer(jpegBuf) &&
            jpegBuf.length >= 33 &&
            (jpegBuf.length < rawBuffer.length || needsResize) &&
            detectImageMagicBytes(jpegBuf).valid
          ) {
            return {
              valid: true,
              buffer: jpegBuf,
              ext: 'jpg',
              mimeType: 'image/jpeg',
              normalized: true,
            };
          }
        }
      }
    } catch (err) {
      diagLog.debug('offlineVault.nativeImageNormalize', err, { assetRole });
    }
  }

  return {
    valid: true,
    buffer: rawBuffer,
    ext,
    mimeType,
    normalized: false,
  };
}

/**
 * @param {any} service
 * @param {Buffer} rawBuffer
 * @param {string} [roleOrContentType]
 * @param {string} [maybeRole]
 */
async function normalizeImageBufferAsync(service, rawBuffer, roleOrContentType = 'cover', maybeRole) {
  if (Buffer.isBuffer(rawBuffer) && rawBuffer.length > PASS_THROUGH_MAX_BYTES) {
    await yieldEventLoop();
  }
  const result = normalizeImageBuffer(service, rawBuffer, roleOrContentType, maybeRole);
  if (result.normalized) {
    await yieldEventLoop();
  }
  return result;
}

/**
 * Records a stored blob row in SQLite + updates in-memory `knownBlobHashes`, `blobMetaBySha`,
 * and `totalBlobBytes` atomically without table-scan `SUM(size_bytes)` queries.
 *
 * @param {any} service
 * @param {string} sha256
 * @param {string} ext
 * @param {string} mimeType
 * @param {number} sizeBytes
 * @param {number} nowTs
 */
function upsertMediaBlobIndexRow(service, sha256, ext, mimeType, sizeBytes, nowTs) {
  service
    .stmt(
      'blobs.upsert',
      `
      INSERT INTO media_blobs (sha256, ext, mime_type, size_bytes, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        last_accessed_at = excluded.last_accessed_at
    `
    )
    .run(sha256, ext, mimeType, sizeBytes, nowTs, nowTs);

  const prev = service.blobMetaBySha.get(sha256);
  if (!prev) {
    service.totalBlobBytes = Math.max(0, Number(service.totalBlobBytes || 0)) + sizeBytes;
  }
  service.knownBlobHashes.add(sha256);
  service.blobMetaBySha.set(sha256, { ext, sizeBytes: prev ? prev.sizeBytes : sizeBytes });
}

/**
 * Safe content-addressed sync blob write: NEVER overwrites a live `targetPath` in place!
 * On rename contention (`EEXIST` / `EPERM` / `EACCES`), unlinks `tmpFile` and succeeds if
 * `targetPath` already exists with non-zero size (exact SHA-256 content already present).
 *
 * @param {any} service
 * @param {string} sha256
 * @param {string} targetPath
 * @param {Buffer} finalBuf
 * @param {number} nowTs
 */
function writeContentAddressedBlobSync(service, sha256, targetPath, finalBuf, nowTs) {
  try {
    const existingStat = fs.statSync(targetPath);
    if (existingStat.isFile() && existingStat.size > 0) {
      return;
    }
  } catch {}

  const subDir = path.dirname(targetPath);
  fs.mkdirSync(subDir, { recursive: true });
  const tmpFile = path.join(
    service.tmpDir,
    `${sha256}.${process.pid}.${nowTs}.${Math.random().toString(36).slice(2, 7)}.tmp`
  );
  try {
    fs.writeFileSync(tmpFile, finalBuf);
    fs.renameSync(tmpFile, targetPath);
  } catch (writeErr) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    // Content-addressed by SHA-256: if targetPath already exists with non-zero size, NEVER overwrite in place!
    try {
      const postStat = fs.statSync(targetPath);
      if (postStat.isFile() && postStat.size > 0) {
        return;
      }
    } catch {}
    throw writeErr;
  }
}

/**
 * Safe content-addressed async blob write: NEVER overwrites a live `targetPath` in place!
 *
 * @param {any} service
 * @param {string} sha256
 * @param {string} targetPath
 * @param {Buffer} finalBuf
 * @param {number} nowTs
 */
async function writeContentAddressedBlobAsync(service, sha256, targetPath, finalBuf, nowTs) {
  try {
    const existingStat = await fs.promises.stat(targetPath);
    if (existingStat.isFile() && existingStat.size > 0) {
      return;
    }
  } catch {}

  const subDir = path.dirname(targetPath);
  await fs.promises.mkdir(subDir, { recursive: true });
  const tmpFile = path.join(
    service.tmpDir,
    `${sha256}.${process.pid}.${nowTs}.${Math.random().toString(36).slice(2, 7)}.tmp`
  );
  try {
    await fs.promises.writeFile(tmpFile, finalBuf);
    await fs.promises.rename(tmpFile, targetPath);
  } catch (writeErr) {
    try {
      await fs.promises.unlink(tmpFile);
    } catch {}
    // Content-addressed by SHA-256: if targetPath already exists with non-zero size, succeed without overwriting!
    try {
      const postStat = await fs.promises.stat(targetPath);
      if (postStat.isFile() && postStat.size > 0) {
        return;
      }
    } catch {}
    throw writeErr;
  }
}

/**
 * @param {any} service
 * @param {Buffer} rawBuffer
 * @param {string} [assetRole]
 * @param {string} [upstreamContentType]
 */
function storeNormalizedBlob(service, rawBuffer, assetRole = 'cover', upstreamContentType = '') {
  const norm = normalizeImageBuffer(
    service,
    rawBuffer,
    upstreamContentType || assetRole,
    assetRole
  );
  if (!norm.valid || !norm.buffer || !norm.ext || !norm.mimeType) {
    return { stored: false, reason: 'invalid_image' };
  }

  if ('skipDiskBlob' in norm && norm.skipDiskBlob) {
    return {
      stored: false,
      skipDiskBlob: true,
      reason: 'oversized_animated_gif_passthrough',
      buffer: norm.buffer,
      ext: norm.ext,
      mimeType: norm.mimeType,
    };
  }

  const freeBytes = getFreeDiskBytes(service);
  if (freeBytes < MIN_FREE_DISK_BYTES_FOR_BLOBS) {
    return {
      stored: false,
      reason: 'low_disk_space',
      buffer: norm.buffer,
      ext: norm.ext,
      mimeType: norm.mimeType,
    };
  }

  service.ensureOpen();
  const nowTs = service.now();
  const finalBuf = norm.buffer;
  const sha256 = crypto.createHash('sha256').update(finalBuf).digest('hex');
  const targetPath = getBlobFilePath(service, sha256, norm.ext);

  writeContentAddressedBlobSync(service, sha256, targetPath, finalBuf, nowTs);
  upsertMediaBlobIndexRow(service, sha256, norm.ext, norm.mimeType, finalBuf.length, nowTs);
  maybeEvictBlobs(service);

  return {
    stored: true,
    sha256,
    ext: norm.ext,
    mimeType: norm.mimeType,
    sizeBytes: finalBuf.length,
    filePath: targetPath,
    buffer: finalBuf,
  };
}

/**
 * @param {any} service
 * @param {Buffer} rawBuffer
 * @param {string} [assetRole]
 * @param {string} [upstreamContentType]
 */
async function storeNormalizedBlobAsync(
  service,
  rawBuffer,
  assetRole = 'cover',
  upstreamContentType = ''
) {
  const norm = await normalizeImageBufferAsync(
    service,
    rawBuffer,
    upstreamContentType || assetRole,
    assetRole
  );
  if (!norm.valid || !norm.buffer || !norm.ext || !norm.mimeType) {
    return { stored: false, reason: 'invalid_image' };
  }

  if ('skipDiskBlob' in norm && norm.skipDiskBlob) {
    return {
      stored: false,
      skipDiskBlob: true,
      reason: 'oversized_animated_gif_passthrough',
      buffer: norm.buffer,
      ext: norm.ext,
      mimeType: norm.mimeType,
    };
  }

  const freeBytes = getFreeDiskBytes(service);
  if (freeBytes < MIN_FREE_DISK_BYTES_FOR_BLOBS) {
    return {
      stored: false,
      reason: 'low_disk_space',
      buffer: norm.buffer,
      ext: norm.ext,
      mimeType: norm.mimeType,
    };
  }

  service.ensureOpen();
  const nowTs = service.now();
  const finalBuf = norm.buffer;
  const sha256 = crypto.createHash('sha256').update(finalBuf).digest('hex');
  const targetPath = getBlobFilePath(service, sha256, norm.ext);

  await writeContentAddressedBlobAsync(service, sha256, targetPath, finalBuf, nowTs);
  upsertMediaBlobIndexRow(service, sha256, norm.ext, norm.mimeType, finalBuf.length, nowTs);
  maybeEvictBlobs(service);

  return {
    stored: true,
    sha256,
    ext: norm.ext,
    mimeType: norm.mimeType,
    sizeBytes: finalBuf.length,
    filePath: targetPath,
    buffer: finalBuf,
  };
}

/**
 * Synchronous batched SQLite phase of orphan & legacy P2 non-cover garbage collection.
 * Uses `VaultStatementCache` and batches all `media_blobs` deletions inside ONE transaction.
 *
 * @param {any} service
 * @param {Record<string, any>} [options]
 */
function sweepOrphanBlobsDbPhase(service, options = {}) {
  const db = service.ensureOpen();
  service.flushBlobAccessTimestamps();
  const nowTs = service.now();
  const thirtyDaysAgo = nowTs - 30 * 24 * 60 * 60 * 1000;
  const reclaimLegacyP2NonCover = options.reclaimLegacyP2NonCover !== false;

  let p2AssetsDemoted = 0;
  let orphanBlobsRemoved = 0;
  let dbFreedBytes = 0;

  if (reclaimLegacyP2NonCover) {
    const protectedP0OrP1Ids = new Set(service.p1RecentDetailGames.keys());
    const gameRows = service
      .stmt(
        'sweep.selectGamesProtection',
        'SELECT game_id, is_installed, is_favorited, summary_json FROM vault_games'
      )
      .all();

    let favAdded = 0;
    for (const gr of gameRows) {
      if (!gr || !gr.game_id) continue;
      const gid = String(gr.game_id);
      if (Number(gr.is_installed || 0) === 1) {
        protectedP0OrP1Ids.add(gid);
        continue;
      }
      const summary = parseVaultJson(gr.summary_json);
      if (summary && typeof summary === 'object') {
        if (summary.isPinned === true || summary.isInstalled === true) {
          protectedP0OrP1Ids.add(gid);
          continue;
        }
        const lpRaw = summary.lastPlayedAt || summary.lastPlayed || 0;
        const lpMs = typeof lpRaw === 'number' ? lpRaw : Date.parse(String(lpRaw || ''));
        if (Number.isFinite(lpMs) && lpMs >= thirtyDaysAgo) {
          protectedP0OrP1Ids.add(gid);
          continue;
        }
      }
      if (Number(gr.is_favorited || 0) === 1 && favAdded < MAX_P1_RECENT_DETAIL_GAMES) {
        protectedP0OrP1Ids.add(gid);
        favAdded++;
      }
    }

    const nonCoverRows = service
      .stmt(
        'sweep.selectNonCoverAssets',
        `
          SELECT url_key, game_id, source_url, failure_count, next_retry_at
          FROM game_media_assets
          WHERE asset_role NOT IN ('cover', 'capsule', 'icon')
            AND storage_kind != 'federated'
        `
      )
      .all();

    const deleteAssetKeyStmt = service.stmt(
      'sweep.deleteAssetByKey',
      'DELETE FROM game_media_assets WHERE url_key = ?'
    );
    const unpinBackoffKeyStmt = service.stmt(
      'sweep.unpinBackoffAsset',
      "UPDATE game_media_assets SET storage_kind = 'pending', blob_sha256 = NULL WHERE url_key = ?"
    );
    const deleteDemotedUrlCacheStmt = service.stmt(
      'sweep.deleteUrlCacheByNormAndGame',
      'DELETE FROM url_resolution_cache WHERE norm_url = ? AND game_id = ?'
    );

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const ar of nonCoverRows) {
        const gid = String(ar.game_id || '').trim();
        if (!gid || protectedP0OrP1Ids.has(gid)) continue;
        if (ar.source_url) {
          const demotedNorm = normalizeAssetIdentityUrl(ar.source_url);
          if (demotedNorm) {
            deleteDemotedUrlCacheStmt.run(demotedNorm, gid);
          }
        }
        if (Number(ar.failure_count || 0) > 0 && Number(ar.next_retry_at || 0) > nowTs) {
          unpinBackoffKeyStmt.run(ar.url_key);
        } else {
          deleteAssetKeyStmt.run(ar.url_key);
        }
        p2AssetsDemoted++;
      }
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
  }

  // Prune `url_resolution_cache` BEFORE computing unreferenced `media_blobs`
  const fourteenDaysAgo = nowTs - 14 * 24 * 60 * 60 * 1000;
  db.exec('BEGIN IMMEDIATE');
  try {
    service
      .stmt(
        'sweep.pruneStale404UrlCache',
        'DELETE FROM url_resolution_cache WHERE blob_sha256 IS NULL AND updated_at < ?'
      )
      .run(thirtyDaysAgo);

    const vaultGamesCountRow = service
      .stmt('stats.countVaultGames', 'SELECT COUNT(*) AS cnt FROM vault_games')
      .get();
    const hasVaultGames = Number(vaultGamesCountRow?.cnt || 0) > 0;
    if (hasVaultGames) {
      db.exec(`
        DELETE FROM url_resolution_cache
        WHERE game_id = ''
           OR NOT EXISTS (
             SELECT 1 FROM vault_games vg WHERE vg.game_id = url_resolution_cache.game_id
           );
      `);
    } else {
      db.exec(`
        DELETE FROM url_resolution_cache
        WHERE game_id = ''
           OR NOT EXISTS (
             SELECT 1 FROM game_media_assets gma WHERE gma.game_id = url_resolution_cache.game_id
           );
      `);
    }

    service
      .stmt(
        'sweep.pruneOldSecondaryUrlCache',
        `
        DELETE FROM url_resolution_cache
        WHERE blob_sha256 IS NOT NULL
          AND updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM game_media_assets gma WHERE gma.blob_sha256 = url_resolution_cache.blob_sha256
          )
      `
      )
      .run(fourteenDaysAgo);

    const secondaryRows = service
      .stmt(
        'sweep.selectSecondaryUrlCache',
        `
          SELECT urc.norm_url AS norm_url, urc.game_id AS game_id, urc.updated_at AS updated_at
          FROM url_resolution_cache urc
          WHERE urc.blob_sha256 IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM game_media_assets gma WHERE gma.blob_sha256 = urc.blob_sha256
            )
          ORDER BY urc.game_id ASC, urc.updated_at DESC, urc.norm_url ASC
        `
      )
      .all();

    const deleteUrlCacheByNormStmt = service.stmt(
      'sweep.deleteUrlCacheByNorm',
      'DELETE FROM url_resolution_cache WHERE norm_url = ?'
    );
    /** @type {Set<string>} */
    const seenSecondaryGameIds = new Set();
    for (const sRow of secondaryRows) {
      if (!sRow || !sRow.norm_url) continue;
      const gid = String(sRow.game_id || '');
      if (seenSecondaryGameIds.has(gid)) {
        deleteUrlCacheByNormStmt.run(sRow.norm_url);
      } else {
        seenSecondaryGameIds.add(gid);
      }
    }

    db.exec('COMMIT');
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
  }

  // Batch-delete ALL unreferenced `media_blobs` rows inside ONE transaction!
  const unrefBlobs = service
    .stmt(
      'sweep.selectUnrefBlobs',
      `
        SELECT mb.sha256 AS sha256, mb.ext AS ext, mb.size_bytes AS size_bytes
        FROM media_blobs mb
        LEFT JOIN game_media_assets gma ON gma.blob_sha256 = mb.sha256
        LEFT JOIN url_resolution_cache urc ON urc.blob_sha256 = mb.sha256
        WHERE gma.url_key IS NULL
          AND urc.norm_url IS NULL
      `
    )
    .all();

  /** @type {Array<{ sha256: string, filePath: string, sizeBytes: number }>} */
  const orphanFilesToUnlink = [];
  if (unrefBlobs.length > 0) {
    const deleteBlobStmt = service.stmt(
      'blobs.deleteBySha',
      'DELETE FROM media_blobs WHERE sha256 = ?'
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const ub of unrefBlobs) {
        const sha = String(ub.sha256 || '');
        if (!sha) continue;
        deleteBlobStmt.run(sha);
        const sz = Math.max(0, Number(ub.size_bytes || 0));
        orphanFilesToUnlink.push({
          sha256: sha,
          filePath: getBlobFilePath(service, sha, ub.ext),
          sizeBytes: sz,
        });
        orphanBlobsRemoved++;
        dbFreedBytes += sz;
      }
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
  }

  // Reconcile in-memory blob index & build valid tracked filename set for async disk traversal
  refreshInMemoryBlobIndex(service);
  /** @type {Set<string>} */
  const validBlobFiles = new Set();
  for (const [sha, meta] of service.blobMetaBySha.entries()) {
    const cleanSha = sha.toLowerCase().trim();
    const cleanExt = String(meta.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    validBlobFiles.add(`${cleanSha}.${cleanExt}`);
  }

  try {
    db.exec('PRAGMA incremental_vacuum;');
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    service.cachedSqliteDiskBytes = null;
  } catch {}

  return {
    p2AssetsDemoted,
    orphanBlobsRemoved,
    dbFreedBytes,
    orphanFilesToUnlink,
    validBlobFiles,
  };
}

/**
 * Fully async (`fs.promises`) disk traversal & unlink pass for orphan and untracked blob files.
 * Yields between shard directories so 256+ shard dirs / 3,600+ files never stall Electron's main thread.
 *
 * @param {any} service
 * @param {Array<{ sha256: string, filePath: string, sizeBytes: number }>} orphanFilesToUnlink
 * @param {Set<string>} validBlobFiles
 * @returns {Promise<{ untrackedFilesRemoved: number, diskFreedBytes: number }>}
 */
async function sweepOrphanBlobFilesOnDiskAsync(service, orphanFilesToUnlink, validBlobFiles) {
  let untrackedFilesRemoved = 0;
  let diskFreedBytes = 0;

  for (const item of orphanFilesToUnlink) {
    if (service.isShutdown) break;
    try {
      await fs.promises.unlink(item.filePath);
    } catch {}
  }

  if (service.isShutdown || !service.blobsDir) {
    return { untrackedFilesRemoved, diskFreedBytes };
  }

  let shardEntries = [];
  try {
    shardEntries = await fs.promises.readdir(service.blobsDir, { withFileTypes: true });
  } catch {
    return { untrackedFilesRemoved, diskFreedBytes };
  }

  let shardsProcessed = 0;
  for (const shardEnt of shardEntries) {
    if (service.isShutdown) break;
    const shardPath = path.join(service.blobsDir, shardEnt.name);
    if (shardEnt.isFile()) {
      if (!validBlobFiles.has(shardEnt.name.toLowerCase())) {
        try {
          const st = await fs.promises.stat(shardPath);
          await fs.promises.unlink(shardPath);
          untrackedFilesRemoved++;
          diskFreedBytes += st.size || 0;
        } catch {}
      }
      continue;
    }
    if (!shardEnt.isDirectory()) continue;

    let remainingChildren = 0;
    try {
      const files = await fs.promises.readdir(shardPath, { withFileTypes: true });
      for (const fEnt of files) {
        if (service.isShutdown) break;
        const fPath = path.join(shardPath, fEnt.name);
        if (fEnt.isFile() && !validBlobFiles.has(fEnt.name.toLowerCase())) {
          // Skip files created/stored concurrently after the DB snapshot was taken
          const stem = fEnt.name.split('.')[0]?.toLowerCase() || '';
          if (stem && service.knownBlobHashes.has(stem)) {
            remainingChildren++;
            continue;
          }
          try {
            const st = await fs.promises.stat(fPath);
            await fs.promises.unlink(fPath);
            untrackedFilesRemoved++;
            diskFreedBytes += st.size || 0;
          } catch {
            remainingChildren++;
          }
        } else {
          remainingChildren++;
        }
      }
      if (remainingChildren === 0 && !service.isShutdown) {
        try {
          await fs.promises.rmdir(shardPath);
        } catch {}
      }
    } catch {}

    shardsProcessed++;
    if (shardsProcessed % 8 === 0) {
      await yieldEventLoop();
    }
  }

  return { untrackedFilesRemoved, diskFreedBytes };
}

/**
 * Sync-returning entry point preserving backwards compatibility for sync callers:
 * executes batched SQLite deletes immediately and runs the 256-shard disk walk asynchronously
 * via `fs.promises` (zero main-thread blocking!).
 *
 * @param {any} service
 * @param {Record<string, any>} [options]
 */
function sweepOrphanBlobs(service, options = {}) {
  const dbRes = sweepOrphanBlobsDbPhase(service, options);
  const diskSweepPromise = sweepOrphanBlobFilesOnDiskAsync(
    service,
    dbRes.orphanFilesToUnlink,
    dbRes.validBlobFiles
  ).catch((err) => {
    diagLog.debug('offlineVault.sweepOrphanDiskAsync', err);
    return { untrackedFilesRemoved: 0, diskFreedBytes: 0 };
  });
  service.activeDiskSweepPromise = diskSweepPromise;

  return {
    success: true,
    p2AssetsDemoted: dbRes.p2AssetsDemoted,
    orphanBlobsRemoved: dbRes.orphanBlobsRemoved,
    untrackedFilesRemoved: 0,
    freedBytes: dbRes.dbFreedBytes,
    stats: service.getStats(),
    diskSweepPromise,
  };
}

/**
 * Full async orphan sweep awaiting both batched DB cleanup and async `fs.promises` disk traversal.
 *
 * @param {any} service
 * @param {Record<string, any>} [options]
 */
async function sweepOrphanBlobsAsync(service, options = {}) {
  const dbRes = sweepOrphanBlobsDbPhase(service, options);
  const diskRes = await sweepOrphanBlobFilesOnDiskAsync(
    service,
    dbRes.orphanFilesToUnlink,
    dbRes.validBlobFiles
  );
  return {
    success: true,
    p2AssetsDemoted: dbRes.p2AssetsDemoted,
    orphanBlobsRemoved: dbRes.orphanBlobsRemoved,
    untrackedFilesRemoved: diskRes.untrackedFilesRemoved,
    freedBytes: dbRes.dbFreedBytes + diskRes.diskFreedBytes,
    stats: service.getStats(),
  };
}

/**
 * High-water-mark batched LRU eviction:
 * - Fast O(1) short-circuit using in-memory `totalBlobBytes` + cached `sqliteBytes` when below 95% cap
 *   (avoiding per-store `flushBlobAccessTimestamps()`, `statSync`, and `SUM(size_bytes)` table scans!).
 * - When triggered (`>= 95%` cap or `forceIfOverMax`), evicts down to `<= 80%` (`<= 85%`) in
 *   ONE single `BEGIN IMMEDIATE ... COMMIT` transaction, pruning `url_resolution_cache` alongside
 *   evicted hashes while keeping installed covers pinned (`retention_rank = 100`) and
 *   `achievement_icon` unpinned (`retention_rank = 25`).
 *
 * @param {any} service
 * @param {{ maxBytes?: number, forceIfOverMax?: boolean }} [opts]
 */
function maybeEvictBlobs(service, opts = {}) {
  const db = service.ensureOpen();
  const tier = service.getTier();
  const maxBytes =
    typeof opts.maxBytes === 'number' ? opts.maxBytes : OFFLINE_VAULT_TIER_CAPS[tier];
  const triggerThreshold = opts.forceIfOverMax ? maxBytes : Math.floor(maxBytes * 0.95);

  // Fast O(1) pre-check on hot store paths (zero flush / zero SUM table scan when safely below high-water mark!)
  if (!opts.forceIfOverMax && typeof opts.maxBytes !== 'number') {
    const fastSqliteBytes = getSqliteDiskBytes(service, { forceRefresh: false });
    const fastTotalBytes = fastSqliteBytes + Math.max(0, Number(service.totalBlobBytes || 0));
    if (fastTotalBytes < triggerThreshold) {
      return { evictedCount: 0, freedBytes: 0 };
    }
  }

  service.flushBlobAccessTimestamps();

  const sqliteBytes = getSqliteDiskBytes(service, { forceRefresh: true });
  const sumRow = service
    .stmt('blobs.sumSizeBytes', 'SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media_blobs')
    .get();
  let currentBlobBytes = Number(sumRow?.bytes || 0);
  service.totalBlobBytes = currentBlobBytes;
  let currentTotalBytes = sqliteBytes + currentBlobBytes;

  if (currentTotalBytes < triggerThreshold) {
    return { evictedCount: 0, freedBytes: 0 };
  }

  // Target <= 80% (strictly <= 85%, matching existing 0.8 quota assertions)
  const targetTotalBytes = Math.floor(maxBytes * 0.8);

  const candidates = service
    .stmt(
      'blobs.selectEvictionCandidates',
      `
        SELECT
          mb.sha256 AS sha256,
          mb.ext AS ext,
          mb.size_bytes AS size_bytes,
          mb.last_accessed_at AS last_accessed_at,
          COALESCE(MAX(
            CASE
              WHEN vg.is_installed = 1 AND gma.asset_role IN ('cover', 'capsule', 'header', 'hero', 'logo', 'icon') THEN 100
              WHEN vg.is_installed = 1 AND COALESCE(gma.asset_role, '') != 'achievement_icon' AND gma.url_key IS NOT NULL THEN 65
              WHEN gma.asset_role IN ('cover', 'capsule') THEN 55
              WHEN gma.asset_role = 'icon' THEN 50
              WHEN gma.asset_role IN ('header', 'hero', 'logo') THEN 40
              WHEN gma.asset_role IN ('screenshot_thumb', 'screenshot') THEN 30
              WHEN gma.asset_role = 'achievement_icon' THEN 25
              WHEN gma.asset_role IN ('inline_img', 'inline_poster') THEN 20
              WHEN gma.asset_role = 'screenshot_full' THEN 10
              WHEN gma.url_key IS NOT NULL THEN 15
              ELSE 0
            END
          ), 0) AS retention_rank
        FROM media_blobs mb
        LEFT JOIN game_media_assets gma ON gma.blob_sha256 = mb.sha256
        LEFT JOIN vault_games vg ON vg.game_id = gma.game_id
        GROUP BY mb.sha256
        HAVING retention_rank < 100
        ORDER BY retention_rank ASC, mb.last_accessed_at ASC, mb.created_at ASC
      `
    )
    .all();

  /** @type {Array<{ sha256: string, ext: string, sizeBytes: number }>} */
  const toEvict = [];
  for (const cand of candidates) {
    if (currentTotalBytes <= targetTotalBytes) break;
    const sz = Math.max(0, Number(cand.size_bytes || 0));
    toEvict.push({
      sha256: String(cand.sha256),
      ext: String(cand.ext || 'jpg'),
      sizeBytes: sz,
    });
    currentBlobBytes = Math.max(0, currentBlobBytes - sz);
    currentTotalBytes = sqliteBytes + currentBlobBytes;
  }

  if (toEvict.length === 0) {
    return { evictedCount: 0, freedBytes: 0 };
  }

  const resetAssetStmt = service.stmt(
    'evict.resetAssetsBySha',
    "UPDATE game_media_assets SET storage_kind = 'pending', blob_sha256 = NULL WHERE blob_sha256 = ?"
  );
  const pruneUrlCacheStmt = service.stmt(
    'evict.pruneUrlCacheBySha',
    'DELETE FROM url_resolution_cache WHERE blob_sha256 = ?'
  );
  const deleteBlobStmt = service.stmt(
    'blobs.deleteBySha',
    'DELETE FROM media_blobs WHERE sha256 = ?'
  );

  let evictedCount = 0;
  let freedBytes = 0;

  // Single batched BEGIN IMMEDIATE ... COMMIT transaction for ALL evicted blobs + url_resolution_cache cleanup!
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of toEvict) {
      resetAssetStmt.run(item.sha256);
      pruneUrlCacheStmt.run(item.sha256);
      deleteBlobStmt.run(item.sha256);
      evictedCount++;
      freedBytes += item.sizeBytes;
    }
    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    diagLog.debug('offlineVault.maybeEvictBlobs', txErr);
    return { evictedCount: 0, freedBytes: 0 };
  }

  // Update in-memory index and unlink evicted files strictly outside the SQLite transaction
  for (const item of toEvict) {
    service.knownBlobHashes.delete(item.sha256);
    service.blobMetaBySha.delete(item.sha256);
    const blobFile = getBlobFilePath(service, item.sha256, item.ext);
    try {
      if (fs.existsSync(blobFile)) {
        fs.unlinkSync(blobFile);
      }
    } catch {}
  }
  service.totalBlobBytes = currentBlobBytes;

  return { evictedCount, freedBytes };
}

module.exports = {
  getBlobFilePath,
  normalizeImageBuffer,
  normalizeImageBufferAsync,
  storeNormalizedBlob,
  storeNormalizedBlobAsync,
  sweepOrphanBlobs,
  sweepOrphanBlobsAsync,
  maybeEvictBlobs,
};
