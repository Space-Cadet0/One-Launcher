// @ts-check
'use strict';

const fs = require('node:fs');
const { detectImageMagicBytes } = require('../storefrontLocalCacheFederator.cjs');
const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  MAX_P1_RECENT_DETAIL_GAMES,
  P1_RECENT_FLUSH_DEBOUNCE_MS,
} = require('./vaultSchemaAndLifecycle.cjs');
const {
  computeAdaptive404DelayMs,
  isRejectedVideoUrl,
  normalizeAssetIdentityUrl,
  buildAssetUrlKey,
  isExplicitOverrideParam,
  isFederatedAssetRowCompatible,
} = require('./vaultMetadataLattice.cjs');
const { getBlobFilePath } = require('./vaultBlobStore.cjs');

/**
 * @param {any} service
 * @param {any} db
 */
function loadP1RecentGamesFromDb(service, db) {
  if (!db) return;
  try {
    const row = service.stmtCache
      ? service.stmtCache
          .get('settings.getByKey', 'SELECT value FROM vault_settings WHERE key = ?')
          .get('p1_recent_games')
      : db.prepare("SELECT value FROM vault_settings WHERE key = 'p1_recent_games'").get();
    if (!row || typeof row.value !== 'string') return;
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return;
    service.p1RecentDetailGames.clear();
    for (const entry of parsed.slice(-MAX_P1_RECENT_DETAIL_GAMES)) {
      if (typeof entry === 'string' && entry.trim()) {
        service.p1RecentDetailGames.set(entry.trim(), service.now());
      } else if (entry && typeof entry === 'object' && entry.gameId) {
        service.p1RecentDetailGames.set(
          String(entry.gameId).trim(),
          Number(entry.ts || service.now())
        );
      }
    }
    service.p1RecentGamesDirty = false;
  } catch {}
}

/**
 * Persists the P1 recent-detail LRU snapshot to `vault_settings` using a cached statement.
 *
 * @param {any} service
 */
function persistP1RecentGamesToDb(service) {
  if (!service.db) return;
  try {
    const serialized = JSON.stringify(
      Array.from(service.p1RecentDetailGames.entries()).map(([gameId, ts]) => ({ gameId, ts }))
    );
    service
      .stmt(
        'settings.upsert',
        'INSERT INTO vault_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      )
      .run('p1_recent_games', serialized, service.now());
    service.p1RecentGamesDirty = false;
  } catch {}
}

/**
 * Cancels any pending 250ms debounce timer and flushes dirty P1 recent detail games synchronously
 * (invoked on `close()`, `shutdown()`, `trimMemory()`, and `clear()`).
 *
 * @param {any} service
 */
function flushP1RecentGamesToDb(service) {
  if (service.p1FlushTimer) {
    try {
      clearTimeout(service.p1FlushTimer);
    } catch {}
    service.p1FlushTimer = null;
  }
  if (!service.p1RecentGamesDirty || !service.db) {
    service.p1RecentGamesDirty = false;
    return;
  }
  persistP1RecentGamesToDb(service);
}

/**
 * Coalesced P1 recent-detail tracking: updates in-memory LRU immediately (`isP1DetailGame` is
 * instantly accurate) and coalesces SQLite writes over a 250ms dirty window (flushed on `close()`).
 *
 * @param {any} service
 * @param {string} gameId
 * @returns {boolean}
 */
function recordP1DetailGame(service, gameId) {
  const cleanId = String(gameId || '').trim();
  if (!cleanId) return false;
  service.ensureOpen();
  if (service.p1RecentDetailGames.has(cleanId)) {
    service.p1RecentDetailGames.delete(cleanId);
  }
  service.p1RecentDetailGames.set(cleanId, service.now());
  while (service.p1RecentDetailGames.size > MAX_P1_RECENT_DETAIL_GAMES) {
    const oldestKey = service.p1RecentDetailGames.keys().next().value;
    if (!oldestKey) break;
    service.p1RecentDetailGames.delete(oldestKey);
  }
  service.p1RecentGamesDirty = true;
  if (!service.p1FlushTimer) {
    service.p1FlushTimer = setTimeout(() => {
      service.p1FlushTimer = null;
      if (service.p1RecentGamesDirty && service.db && !service.isShutdown) {
        persistP1RecentGamesToDb(service);
      }
    }, P1_RECENT_FLUSH_DEBOUNCE_MS);
    if (service.p1FlushTimer && typeof service.p1FlushTimer.unref === 'function') {
      service.p1FlushTimer.unref();
    }
  }
  return true;
}

/**
 * @param {any} service
 */
function scheduleBlobAccessFlush(service) {
  if (service.accessFlushTimer) return;
  service.accessFlushTimer = setTimeout(() => {
    service.accessFlushTimer = null;
    flushBlobAccessTimestamps(service);
  }, 10000);
  if (service.accessFlushTimer && typeof service.accessFlushTimer.unref === 'function') {
    service.accessFlushTimer.unref();
  }
}

/**
 * @param {any} service
 * @param {string} sha256
 */
function touchBlobAccess(service, sha256) {
  if (!sha256) return;
  service.pendingBlobAccessMap.set(sha256, service.now());
  if (service.pendingBlobAccessMap.size >= 100) {
    flushBlobAccessTimestamps(service);
  } else {
    scheduleBlobAccessFlush(service);
  }
}

/**
 * @param {any} service
 */
function flushBlobAccessTimestamps(service) {
  if (service.accessFlushTimer) {
    try {
      clearTimeout(service.accessFlushTimer);
    } catch {}
    service.accessFlushTimer = null;
  }
  if (!service.db || service.pendingBlobAccessMap.size === 0) {
    service.pendingBlobAccessMap.clear();
    return;
  }
  const entries = Array.from(service.pendingBlobAccessMap.entries());
  service.pendingBlobAccessMap.clear();
  try {
    const stmt = service.stmt(
      'blobs.touchAccess',
      'UPDATE media_blobs SET last_accessed_at = ? WHERE sha256 = ? AND last_accessed_at < ?'
    );
    service.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [sha, ts] of entries) {
        stmt.run(ts, sha, ts);
      }
      service.db.exec('COMMIT');
    } catch (txErr) {
      try {
        service.db.exec('ROLLBACK');
      } catch {}
      throw txErr;
    }
  } catch (err) {
    diagLog.debug('offlineVault.flushBlobAccess', err);
  }
}

/**
 * @param {any} service
 * @param {string} urlKey
 * @param {string} gameId
 * @param {string} assetRole
 * @param {number} ordinal
 * @param {string} sourceUrl
 */
function recordAssetAdaptive404(service, urlKey, gameId, assetRole, ordinal, sourceUrl) {
  const db = service.ensureOpen();
  const nowTs = service.now();
  const cleanGameId = String(gameId || '').trim();
  const cleanSourceUrl = String(sourceUrl || '').trim();
  const normUrl = cleanSourceUrl ? normalizeAssetIdentityUrl(cleanSourceUrl) : '';

  const existing = service
    .stmt(
      'media.selectAdaptive404Asset',
      'SELECT failure_count, source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?'
    )
    .get(urlKey);

  const existingCache = normUrl
    ? service
        .stmt(
          'urlCache.selectFailureByNorm',
          'SELECT failure_count, blob_sha256 FROM url_resolution_cache WHERE norm_url = ?'
        )
        .get(normUrl)
    : null;

  const existingNorm =
    existing && existing.source_url ? normalizeAssetIdentityUrl(existing.source_url) : '';
  const prevAssetFailures =
    existing && existingNorm && normUrl && existingNorm === normUrl
      ? Number(existing.failure_count || 0)
      : existing && existing.source_url === cleanSourceUrl
        ? Number(existing.failure_count || 0)
        : 0;
  const prevCacheFailures =
    existingCache && !existingCache.blob_sha256 ? Number(existingCache.failure_count || 0) : 0;
  const nextFailures = Math.max(prevAssetFailures, prevCacheFailures) + 1;
  const delayMs = computeAdaptive404DelayMs(nextFailures);
  const nextRetryAt = nowTs + delayMs;

  const hasHealthyPinnedBlob = Boolean(
    existing && existing.storage_kind === 'blob' && existing.blob_sha256
  );

  db.exec('SAVEPOINT record_adaptive_404');
  try {
    if (normUrl) {
      service
        .stmt(
          'urlCache.upsert404',
          `
          INSERT INTO url_resolution_cache (
            norm_url, game_id, blob_sha256, failure_count, next_retry_at, last_status_code, updated_at
          ) VALUES (?, ?, NULL, ?, ?, 404, ?)
          ON CONFLICT(norm_url) DO UPDATE SET
            game_id = CASE WHEN excluded.game_id != '' THEN excluded.game_id ELSE url_resolution_cache.game_id END,
            blob_sha256 = NULL,
            failure_count = excluded.failure_count,
            next_retry_at = excluded.next_retry_at,
            last_status_code = 404,
            updated_at = excluded.updated_at
        `
        )
        .run(normUrl, cleanGameId, nextFailures, nextRetryAt, nowTs);
    }

    // Hard Invariant: NEVER unpin a healthy `storage_kind = 'blob'` when an alternate URL 404s!
    if (!hasHealthyPinnedBlob) {
      service
        .stmt(
          'media.upsertAdaptive404',
          `
          INSERT INTO game_media_assets (
            url_key, game_id, asset_role, ordinal, source_url, storage_kind,
            blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, 404, ?)
          ON CONFLICT(url_key) DO UPDATE SET
            source_url = excluded.source_url,
            failure_count = excluded.failure_count,
            next_retry_at = excluded.next_retry_at,
            last_status_code = 404,
            last_verified_at = excluded.last_verified_at
        `
        )
        .run(
          urlKey,
          cleanGameId,
          String(assetRole || 'cover'),
          Math.max(0, Math.floor(Number(ordinal) || 0)),
          cleanSourceUrl,
          nextFailures,
          nextRetryAt,
          nowTs
        );
    }
    db.exec('RELEASE SAVEPOINT record_adaptive_404');
  } catch (err) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT record_adaptive_404');
      db.exec('RELEASE SAVEPOINT record_adaptive_404');
    } catch {}
    throw err;
  }

  return {
    failureCount: nextFailures,
    nextRetryAt,
    delayMs,
  };
}

/**
 * @param {any} service
 * @param {Record<string, any>} [params]
 * @returns {boolean}
 */
function isAssetAlreadyHydratedOrBackedOff(service, params = {}) {
  service.ensureOpen();
  const gameId = String(params.gameId || '').trim();
  const role = String(params.role || 'cover').trim();
  const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
  const sourceUrl = String(params.url || '').trim();
  const normSourceUrl = sourceUrl ? normalizeAssetIdentityUrl(sourceUrl) : '';
  const urlKey = buildAssetUrlKey(gameId, role, ordinal, sourceUrl);
  const nowTs = service.now();

  /** @param {string} sha */
  const hasLiveBlobFile = (sha) => {
    let meta = service.blobMetaBySha.get(sha);
    if (!meta) {
      const mb = service
        .stmt('blobs.selectMetaBySha', 'SELECT ext, size_bytes FROM media_blobs WHERE sha256 = ?')
        .get(sha);
      if (mb) {
        meta = { ext: String(mb.ext || 'jpg'), sizeBytes: Math.max(0, Number(mb.size_bytes || 0)) };
        service.knownBlobHashes.add(sha);
        service.blobMetaBySha.set(sha, meta);
      }
    }
    if (!meta) return false;
    return fs.existsSync(getBlobFilePath(service, sha, meta.ext));
  };

  if (normSourceUrl) {
    const cacheRow = service
      .stmt(
        'urlCache.selectByNormFull',
        'SELECT blob_sha256, failure_count, next_retry_at, last_status_code FROM url_resolution_cache WHERE norm_url = ?'
      )
      .get(normSourceUrl);
    if (cacheRow) {
      if (cacheRow.blob_sha256) {
        if (hasLiveBlobFile(String(cacheRow.blob_sha256))) {
          return true;
        }
      } else if (cacheRow.next_retry_at && Number(cacheRow.next_retry_at) > nowTs) {
        return true;
      }
    }
  }

  const row = service
    .stmt('media.selectByUrlKey', 'SELECT * FROM game_media_assets WHERE url_key = ?')
    .get(urlKey);
  if (!row) return false;

  if (
    sourceUrl &&
    row.source_url &&
    normalizeAssetIdentityUrl(row.source_url) !== normSourceUrl
  ) {
    return false;
  }

  if (row.storage_kind === 'blob' && row.blob_sha256) {
    if (hasLiveBlobFile(String(row.blob_sha256))) {
      return true;
    }
  }

  if (row.storage_kind === 'federated' && row.federated_path) {
    if (!isFederatedAssetRowCompatible(sourceUrl || row.source_url, row.federated_path, params)) {
      return false;
    }
    try {
      const lst = fs.lstatSync(String(row.federated_path));
      if (!lst.isSymbolicLink() && lst.isFile() && lst.size >= 33) {
        return true;
      }
    } catch {}
  }

  if (row.next_retry_at && Number(row.next_retry_at) > nowTs) {
    return true;
  }

  return false;
}

/**
 * @param {any} service
 * @param {Record<string, any>} [params]
 * @returns {boolean}
 */
function isAssetBackedOffFailure(service, params = {}) {
  if (service.isShutdown) return false;
  const db = service.db || service.ensureOpen();
  if (!db) return false;
  const gameId = String(params.gameId || '').trim();
  const role = String(params.role || 'cover').trim();
  const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
  const sourceUrl = String(params.url || '').trim();
  const normSourceUrl = sourceUrl ? normalizeAssetIdentityUrl(sourceUrl) : '';
  const urlKey = buildAssetUrlKey(gameId, role, ordinal, sourceUrl);
  const nowTs = service.now();

  if (normSourceUrl) {
    const cacheRow = service
      .stmt(
        'urlCache.selectByNormFull',
        'SELECT blob_sha256, failure_count, next_retry_at, last_status_code FROM url_resolution_cache WHERE norm_url = ?'
      )
      .get(normSourceUrl);
    if (
      cacheRow &&
      !cacheRow.blob_sha256 &&
      (Number(cacheRow.failure_count || 0) > 0 || Number(cacheRow.next_retry_at || 0) > nowTs)
    ) {
      return true;
    }
  }

  const row = service
    .stmt(
      'media.selectBackoffByUrlKey',
      'SELECT storage_kind, failure_count, next_retry_at FROM game_media_assets WHERE url_key = ?'
    )
    .get(urlKey);
  if (!row || row.storage_kind !== 'pending') return false;
  return Number(row.failure_count || 0) > 0 || Number(row.next_retry_at || 0) > nowTs;
}

/**
 * @param {any} service
 * @param {string} urlKey
 * @param {string} gameId
 * @param {string} role
 * @param {number} ordinal
 * @param {string} rawUrl
 * @param {string} sha256
 */
function bindAssetBlobRow(service, urlKey, gameId, role, ordinal, rawUrl, sha256) {
  const db = service.ensureOpen();
  const nowTs = service.now();
  const cleanGameId = String(gameId || '').trim();
  const cleanRawUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const normUrl = cleanRawUrl ? normalizeAssetIdentityUrl(cleanRawUrl) : '';

  db.exec('SAVEPOINT bind_asset_blob');
  try {
    const prevRow = service
      .stmt(
        'media.selectPrevForBind',
        'SELECT game_id, source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?'
      )
      .get(urlKey);
    if (
      prevRow &&
      prevRow.storage_kind === 'blob' &&
      prevRow.blob_sha256 &&
      prevRow.source_url
    ) {
      const prevNorm = normalizeAssetIdentityUrl(prevRow.source_url);
      if (prevNorm && prevNorm !== normUrl) {
        service
          .stmt(
            'urlCache.insertIgnoreBlob',
            `
            INSERT OR IGNORE INTO url_resolution_cache (
              norm_url, game_id, blob_sha256, failure_count, next_retry_at, last_status_code, updated_at
            ) VALUES (?, ?, ?, 0, 0, 200, ?)
          `
          )
          .run(
            prevNorm,
            String(prevRow.game_id || cleanGameId),
            String(prevRow.blob_sha256),
            nowTs
          );
      }
    }

    service
      .stmt(
        'media.upsertBlobBinding',
        `
        INSERT INTO game_media_assets (
          url_key, game_id, asset_role, ordinal, source_url, storage_kind,
          blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, 'blob', ?, NULL, 0, 0, 200, ?)
        ON CONFLICT(url_key) DO UPDATE SET
          source_url = excluded.source_url,
          storage_kind = 'blob',
          blob_sha256 = excluded.blob_sha256,
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = 200,
          last_verified_at = excluded.last_verified_at
      `
      )
      .run(urlKey, cleanGameId, role, ordinal, cleanRawUrl, sha256, nowTs);

    if (normUrl) {
      service
        .stmt(
          'urlCache.upsertBlob',
          `
          INSERT INTO url_resolution_cache (
            norm_url, game_id, blob_sha256, failure_count, next_retry_at, last_status_code, updated_at
          ) VALUES (?, ?, ?, 0, 0, 200, ?)
          ON CONFLICT(norm_url) DO UPDATE SET
            game_id = CASE WHEN excluded.game_id != '' THEN excluded.game_id ELSE url_resolution_cache.game_id END,
            blob_sha256 = excluded.blob_sha256,
            failure_count = 0,
            next_retry_at = 0,
            last_status_code = 200,
            updated_at = excluded.updated_at
        `
        )
        .run(normUrl, cleanGameId, sha256, nowTs);
    }

    db.exec('RELEASE SAVEPOINT bind_asset_blob');
  } catch (err) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT bind_asset_blob');
      db.exec('RELEASE SAVEPOINT bind_asset_blob');
    } catch {}
    throw err;
  }
}

/**
 * Parse `paramsInput` (object, `ol-media://` URL string, or URL instance) into a uniform params object.
 * @param {Record<string, any> | string | URL} [paramsInput]
 * @returns {Record<string, any>}
 */
function parseMediaRequestParams(paramsInput = {}) {
  if (typeof paramsInput === 'string' || paramsInput instanceof URL) {
    try {
      const parsedReq = new URL(String(paramsInput));
      const sp = parsedReq.searchParams;
      return {
        gameId: sp.get('gameId') || '',
        role: sp.get('role') || 'cover',
        ordinal: Number(sp.get('ord') || sp.get('ordinal') || 0),
        url: sp.get('url') || '',
        steamAppId: sp.get('steamAppId') || '',
        gogId: sp.get('gogId') || '',
        epicAppName: sp.get('epicApp') || sp.get('epicAppName') || '',
        xboxProductId: sp.get('xboxProductId') || sp.get('xid') || '',
        pfn: sp.get('pfn') || sp.get('packageFamilyName') || '',
        packageFamilyName: sp.get('pfn') || sp.get('packageFamilyName') || '',
        xboxTitleId: sp.get('xboxTitleId') || sp.get('xtid') || '',
        ov: sp.get('ov') || '',
      };
    } catch {
      return {};
    }
  }
  if (paramsInput && typeof paramsInput === 'object') {
    return paramsInput;
  }
  return {};
}

/**
 * Async Tier 1A blob verification and response builder.
 *
 * @param {any} service
 * @param {string} sha256
 * @param {string} [cacheControl]
 */
async function tryResolveBlobBySha(
  service,
  sha256,
  cacheControl = 'public, max-age=31536000, immutable'
) {
  if (!sha256 || typeof sha256 !== 'string') return null;
  service.ensureOpen();
  const mb = service
    .stmt(
      'blobs.selectFullBySha',
      'SELECT sha256, ext, mime_type, size_bytes FROM media_blobs WHERE sha256 = ?'
    )
    .get(sha256);
  if (!mb) return null;
  const blobPath = getBlobFilePath(service, mb.sha256, mb.ext);
  if (!isContainedWithinRoot(service.blobsDir, blobPath, service.options.platform)) {
    return null;
  }
  let blobStat = null;
  try {
    blobStat = await fs.promises.stat(blobPath);
  } catch {}
  if (!blobStat || !blobStat.isFile() || blobStat.size <= 0) {
    service.knownBlobHashes.delete(sha256);
    service.blobMetaBySha.delete(sha256);
    return null;
  }
  touchBlobAccess(service, mb.sha256);
  return {
    kind: 'file',
    filePath: blobPath,
    mimeType: mb.mime_type,
    sizeBytes: Number(mb.size_bytes || blobStat.size || 0),
    cacheControl,
    source: 'vault_blob',
  };
}

/**
 * Async Tier 1B federated local file verification and response builder.
 *
 * @param {any} service
 * @param {Record<string, any>} assetRow
 * @param {string} rawUrl
 * @param {Record<string, any>} params
 * @param {boolean} isExplicitOverride
 * @param {{ selfHealMissing?: boolean }} [opts]
 */
async function tryResolveFederatedRow(
  service,
  assetRow,
  rawUrl,
  params,
  isExplicitOverride,
  opts = { selfHealMissing: false }
) {
  if (!assetRow || assetRow.storage_kind !== 'federated' || !assetRow.federated_path) {
    return null;
  }
  service.ensureOpen();
  const federatedPath = String(assetRow.federated_path);
  const effectiveRole = String(assetRow.asset_role || params?.role || '').trim().toLowerCase();
  const effectiveOrdinal = Math.max(
    0,
    Math.floor(Number(assetRow.ordinal ?? params?.ordinal ?? params?.ord ?? 0) || 0)
  );
  const isDisallowedFederationRole =
    effectiveRole === 'achievement_icon' || (effectiveRole === 'icon' && effectiveOrdinal > 0);
  if (
    isExplicitOverride ||
    isDisallowedFederationRole ||
    !isFederatedAssetRowCompatible(rawUrl || assetRow.source_url, federatedPath, {
      ...(params && typeof params === 'object' ? params : {}),
      role: effectiveRole || params?.role,
      ordinal: effectiveOrdinal,
    })
  ) {
    if (opts.selfHealMissing) {
      service
        .stmt(
          'media.resetFederatedByUrlKey',
          "UPDATE game_media_assets SET storage_kind = 'pending', federated_path = NULL WHERE url_key = ?"
        )
        .run(assetRow.url_key);
    }
    return null;
  }
  try {
    const lst = await fs.promises.lstat(federatedPath);
    if (!lst.isSymbolicLink() && lst.isFile() && lst.size >= 33) {
      const header = Buffer.allocUnsafe(16);
      header.fill(0);
      const fh = await fs.promises.open(federatedPath, 'r');
      let bytesRead = 0;
      try {
        const readRes = await fh.read(header, 0, 16, 0);
        bytesRead = Number(readRes?.bytesRead || 0);
      } finally {
        try {
          await fh.close();
        } catch {}
      }
      const magic = detectImageMagicBytes(header.subarray(0, bytesRead));
      if (magic.valid && magic.mimeType) {
        return {
          kind: 'file',
          filePath: federatedPath,
          mimeType: magic.mimeType,
          sizeBytes: lst.size,
          cacheControl: 'public, max-age=86400',
          source: 'federated_local',
        };
      }
    }
  } catch {}
  if (opts.selfHealMissing) {
    service
      .stmt(
        'media.resetFederatedByUrlKey',
        "UPDATE game_media_assets SET storage_kind = 'pending', federated_path = NULL WHERE url_key = ?"
      )
      .run(assetRow.url_key);
  }
  return null;
}

/**
 * Zero-DNS Tier 1A/1B local disk cache lookup for `ol-media://` fast path.
 * Uses `VaultStatementCache` for ZERO per-request `db.prepare()` compilations!
 *
 * @param {any} service
 * @param {Record<string, any> | string | URL} [paramsInput]
 */
async function resolveLocalCachedMedia(service, paramsInput = {}) {
  const params = parseMediaRequestParams(paramsInput);
  const gameId = String(params.gameId || '').trim();
  const role = String(params.role || 'cover').trim();
  const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
  const rawUrl = typeof params.url === 'string' ? params.url.trim() : '';
  const isExplicitOverride = isExplicitOverrideParam(params.ov);
  const localCacheOnly = params.localCacheOnly === true;

  if (rawUrl && isRejectedVideoUrl(rawUrl)) {
    return null;
  }
  if (!rawUrl && !gameId) {
    return null;
  }

  service.ensureOpen();
  const normRawUrl = rawUrl ? normalizeAssetIdentityUrl(rawUrl) : '';
  const urlKey = buildAssetUrlKey(gameId, role, ordinal, rawUrl);
  const assetRow = service
    .stmt('media.selectByUrlKey', 'SELECT * FROM game_media_assets WHERE url_key = ?')
    .get(urlKey);
  const assetSourceNorm =
    assetRow && assetRow.source_url ? normalizeAssetIdentityUrl(assetRow.source_url) : '';
  const isExactUrlMatch = Boolean(
    assetRow && (!normRawUrl || (assetSourceNorm && assetSourceNorm === normRawUrl))
  );

  const recordDetailViewIfNeeded = () => {
    if (
      !params.backgroundHydration &&
      gameId &&
      ['header', 'hero', 'logo', 'screenshot', 'screenshot_thumb', 'screenshot_full'].includes(role)
    ) {
      recordP1DetailGame(service, gameId);
      if (
        service.hydrationEngine &&
        typeof service.hydrationEngine.recordP1DetailView === 'function'
      ) {
        try {
          service.hydrationEngine.recordP1DetailView(gameId);
        } catch {}
      }
    }
  };

  // (a) Exact previously-validated URL hit on `game_media_assets`
  if (isExactUrlMatch && assetRow) {
    if (assetRow.storage_kind === 'blob' && assetRow.blob_sha256) {
      const blobHit = await tryResolveBlobBySha(
        service,
        String(assetRow.blob_sha256),
        'public, max-age=31536000, immutable'
      );
      if (blobHit) {
        recordDetailViewIfNeeded();
        return blobHit;
      }
    } else if (assetRow.storage_kind === 'federated' && assetRow.federated_path) {
      const fedHit = await tryResolveFederatedRow(
        service,
        assetRow,
        rawUrl,
        params,
        isExplicitOverride,
        { selfHealMissing: false }
      );
      if (fedHit) {
        recordDetailViewIfNeeded();
        return fedHit;
      }
    }
  }

  // (b) Live disk blob in `url_resolution_cache` for exact normalized URL
  if (normRawUrl) {
    const cacheRow = service
      .stmt(
        'urlCache.selectByNormFull',
        'SELECT blob_sha256, failure_count, next_retry_at, last_status_code FROM url_resolution_cache WHERE norm_url = ?'
      )
      .get(normRawUrl);
    if (cacheRow && cacheRow.blob_sha256) {
      const cachedHit = await tryResolveBlobBySha(
        service,
        String(cacheRow.blob_sha256),
        'public, max-age=31536000, immutable'
      );
      if (cachedHit) {
        if (
          !assetRow ||
          assetRow.storage_kind !== 'blob' ||
          assetRow.blob_sha256 !== cacheRow.blob_sha256 ||
          assetSourceNorm !== normRawUrl
        ) {
          try {
            bindAssetBlobRow(
              service,
              urlKey,
              gameId,
              role,
              ordinal,
              rawUrl,
              String(cacheRow.blob_sha256)
            );
          } catch {}
        }
        recordDetailViewIfNeeded();
        return cachedHit;
      }
    }

    if (!assetRow) {
      const bySourceRow = service
        .stmt(
          'media.selectBlobShaBySourceUrl',
          "SELECT blob_sha256 FROM game_media_assets WHERE source_url = ? AND storage_kind = 'blob' AND blob_sha256 IS NOT NULL LIMIT 1"
        )
        .get(rawUrl);
      if (bySourceRow && bySourceRow.blob_sha256) {
        const sourceHit = await tryResolveBlobBySha(
          service,
          String(bySourceRow.blob_sha256),
          'public, max-age=31536000, immutable'
        );
        if (sourceHit) {
          recordDetailViewIfNeeded();
          return sourceHit;
        }
      }
    }
  }

  // (c) Explicit offline fallback to existing `assetRow` blob / federated file
  if ((localCacheOnly || !service.isNetworkOnline()) && assetRow) {
    if (assetRow.storage_kind === 'blob' && assetRow.blob_sha256) {
      const offlineHit = await tryResolveBlobBySha(
        service,
        String(assetRow.blob_sha256),
        isExactUrlMatch ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
      );
      if (offlineHit) {
        recordDetailViewIfNeeded();
        return offlineHit;
      }
    } else if (assetRow.storage_kind === 'federated' && assetRow.federated_path) {
      const fedHit = await tryResolveFederatedRow(
        service,
        assetRow,
        rawUrl,
        params,
        isExplicitOverride,
        { selfHealMissing: false }
      );
      if (fedHit) {
        recordDetailViewIfNeeded();
        return fedHit;
      }
    }
  }

  return null;
}

/**
 * @param {any} service
 * @param {Record<string, any>} [payload]
 */
function resolveLocalMetadata(service, payload = {}) {
  if (!service.federator || typeof service.federator.resolveLocalMetadata !== 'function') {
    return null;
  }
  return service.federator.resolveLocalMetadata({
    ...payload,
    steamAppId: payload.steamAppId ?? payload.sid,
    gogId: payload.gogId ?? payload.gid,
    epicAppName: payload.epicAppName || payload.epicApp,
    xboxProductId: payload.xboxProductId || payload.xid,
    packageFamilyName: payload.packageFamilyName || payload.pfn || payload.xpfn,
    xboxTitleId: payload.xboxTitleId || payload.xtid,
  });
}

module.exports = {
  loadP1RecentGamesFromDb,
  persistP1RecentGamesToDb,
  flushP1RecentGamesToDb,
  recordP1DetailGame,
  scheduleBlobAccessFlush,
  touchBlobAccess,
  flushBlobAccessTimestamps,
  recordAssetAdaptive404,
  isAssetAlreadyHydratedOrBackedOff,
  isAssetBackedOffFailure,
  bindAssetBlobRow,
  parseMediaRequestParams,
  tryResolveBlobBySha,
  tryResolveFederatedRow,
  resolveLocalCachedMedia,
  resolveLocalMetadata,
};
