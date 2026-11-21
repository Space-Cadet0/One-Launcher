// @ts-check
'use strict';

const fs = require('node:fs');
const { detectImageMagicBytes } = require('../storefrontLocalCacheFederator.cjs');
const {
  getCanonicalChromeUserAgent,
  isContainedWithinRoot,
  readSafeResponseBuffer,
  safePublicHttpsFetch,
} = require('../securityAndPathUtils.cjs');
const {
  electron,
  MAX_INLINE_ANIMATED_GIF_CACHE_BYTES,
  MAX_DOWNLOAD_IMAGE_BYTES,
  MAX_ASSET_FETCH_BYTES,
  parseVaultJson,
} = require('./vaultSchemaAndLifecycle.cjs');
const {
  REJECTED_VIDEO_MIME_RE,
  isWafOrChallengeResponse,
  parseRetryAfterMs,
  isRejectedVideoUrl,
  normalizeAssetIdentityUrl,
  isAnimatedGifBuffer,
  buildAssetUrlKey,
  isExplicitOverrideParam,
  isFederatedAssetRowCompatible,
} = require('./vaultMetadataLattice.cjs');
const { getBlobFilePath, storeNormalizedBlobAsync } = require('./vaultBlobStore.cjs');
const {
  recordP1DetailGame,
  touchBlobAccess,
  recordAssetAdaptive404,
  bindAssetBlobRow,
  parseMediaRequestParams,
  tryResolveBlobBySha,
  tryResolveFederatedRow,
} = require('./vaultMediaResolver.cjs');

const MAX_ERROR_BODY_SAMPLE_BYTES = 16384; // 16 KiB hard ceiling for error/WAF responses

/**
 * Safely cancels an unread/abandoned Fetch Response body stream so Undici sockets never leak.
 *
 * @param {any} res
 */
async function cancelResponseBodySafely(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
  } catch {}
}

/**
 * Bounded error-response reader (hard cap 16 KiB, slicing sample to <= 2048 chars) backed by
 * `readSafeResponseBuffer(res, 16384)` and mandatory stream cancellation so hostile 403/429/404
 * servers can NEVER OOM V8 or leak Undici sockets.
 *
 * @param {any} res
 * @param {number} [maxBytes=16384]
 * @returns {Promise<string>}
 */
async function readBoundedErrorBodySample(res, maxBytes = MAX_ERROR_BODY_SAMPLE_BYTES) {
  if (!res) return '';
  try {
    const contentLenRaw = res.headers?.get?.('content-length');
    const contentLen =
      contentLenRaw !== null && contentLenRaw !== undefined && String(contentLenRaw).trim() !== ''
        ? Number(contentLenRaw)
        : NaN;

    // If streaming Web ReadableStream is present and response may exceed maxBytes, read ONLY the first `maxBytes` and cancel!
    if (res.body && typeof res.body.getReader === 'function') {
      if (!Number.isFinite(contentLen) || contentLen > maxBytes) {
        const reader = res.body.getReader();
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        try {
          while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const buf = Buffer.isBuffer(value)
              ? value
              : ArrayBuffer.isView(value)
                ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                : Buffer.from(value);
            const remaining = maxBytes - total;
            chunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
            total += Math.min(buf.length, remaining);
            if (total >= maxBytes) break;
          }
        } finally {
          try {
            await reader.cancel();
          } catch {}
          try {
            reader.releaseLock();
          } catch {}
        }
        return Buffer.concat(chunks, total).toString('utf8').slice(0, 2048);
      }
      const buf = await readSafeResponseBuffer(res, maxBytes);
      return buf.toString('utf8').slice(0, 2048);
    }

    if (typeof res.arrayBuffer === 'function') {
      const buf = await readSafeResponseBuffer(res, maxBytes);
      return buf.toString('utf8').slice(0, 2048);
    }

    // Minimal unit-test mock fallback where only `.text()` exists on a plain object
    if (typeof res.text === 'function') {
      const txt = await res.text();
      return String(txt || '').slice(0, 2048);
    }
  } catch {
    await cancelResponseBodySafely(res);
  }
  return '';
}

/**
 * @param {any} service
 * @returns {any}
 */
function getFetchImpl(service) {
  if (typeof service.options.fetchImpl === 'function') {
    return service.options.fetchImpl;
  }
  if (electron.net && typeof electron.net.fetch === 'function') {
    return electron.net.fetch.bind(electron.net);
  }
  return globalThis.fetch;
}

/**
 * @param {any} service
 * @param {string} host
 */
function getEndpointHealth(service, host) {
  const cleanHost = String(host || '').toLowerCase().trim();
  if (!cleanHost) return null;
  service.ensureOpen();
  const row = service
    .stmt('health.selectByHost', 'SELECT * FROM storefront_endpoint_health WHERE host = ?')
    .get(cleanHost);
  if (!row) {
    return {
      host: cleanHost,
      state: 'CLOSED',
      consecutiveFailures: 0,
      openedUntil: 0,
    };
  }
  const nowTs = service.now();
  const openedUntilNum = Number(row.opened_until || 0);
  let effectiveState = String(row.state || 'CLOSED');
  if (effectiveState === 'OPEN' && openedUntilNum > 0 && nowTs >= openedUntilNum) {
    effectiveState = 'HALF_OPEN';
  }
  return {
    host: cleanHost,
    state: effectiveState,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    openedUntil: Number(row.opened_until || 0),
    ...(row.last_status_code !== null && row.last_status_code !== undefined
      ? { lastStatusCode: Number(row.last_status_code) }
      : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  };
}

/**
 * @param {any} service
 * @param {string} host
 */
function canRequestHost(service, host) {
  const cleanHost = String(host || '').toLowerCase().trim();
  if (!cleanHost) return { allowed: true, state: 'CLOSED', isCanary: false };

  const snap = getEndpointHealth(service, cleanHost);
  if (!snap || snap.state === 'CLOSED') {
    return { allowed: true, state: 'CLOSED', isCanary: false };
  }

  const nowTs = service.now();
  if (snap.state === 'OPEN' && snap.openedUntil > nowTs) {
    return {
      allowed: false,
      state: 'OPEN',
      isCanary: false,
      retryAfterMs: snap.openedUntil - nowTs,
    };
  }

  if (service.halfOpenProbesInFlight.has(cleanHost)) {
    return {
      allowed: false,
      state: 'HALF_OPEN',
      isCanary: false,
      retryAfterMs: 5000,
    };
  }

  service.halfOpenProbesInFlight.add(cleanHost);
  service.ensureOpen();
  service
    .stmt(
      'health.markHalfOpen',
      "UPDATE storefront_endpoint_health SET state = 'HALF_OPEN', updated_at = ? WHERE host = ?"
    )
    .run(nowTs, cleanHost);

  return {
    allowed: true,
    state: 'HALF_OPEN',
    isCanary: true,
  };
}

/**
 * @param {any} service
 * @param {string} host
 */
function releaseCanaryIfHeld(service, host) {
  const cleanHost = String(host || '').toLowerCase().trim();
  if (cleanHost) {
    service.halfOpenProbesInFlight.delete(cleanHost);
  }
}

/**
 * @param {any} service
 * @param {string} host
 * @param {number} [statusCode]
 */
function recordHostSuccess(service, host, statusCode = 200) {
  const cleanHost = String(host || '').toLowerCase().trim();
  if (!cleanHost) return;
  service.halfOpenProbesInFlight.delete(cleanHost);

  service.ensureOpen();
  const prev = service
    .stmt(
      'health.selectStateByHost',
      'SELECT state, consecutive_failures FROM storefront_endpoint_health WHERE host = ?'
    )
    .get(cleanHost);

  if (!prev || (prev.state === 'CLOSED' && Number(prev.consecutive_failures || 0) === 0)) {
    return;
  }

  const nowTs = service.now();
  service
    .stmt(
      'health.upsertClosed',
      `
      INSERT INTO storefront_endpoint_health (
        host, state, consecutive_failures, opened_until, last_status_code, last_error, updated_at
      ) VALUES (?, 'CLOSED', 0, 0, ?, NULL, ?)
      ON CONFLICT(host) DO UPDATE SET
        state = 'CLOSED',
        consecutive_failures = 0,
        opened_until = 0,
        last_status_code = excluded.last_status_code,
        last_error = NULL,
        updated_at = excluded.updated_at
    `
    )
    .run(cleanHost, statusCode, nowTs);

  service.emitHealthChanged({
    host: cleanHost,
    state: 'CLOSED',
    consecutiveFailures: 0,
    openedUntil: 0,
    lastStatusCode: statusCode,
  });
}

/**
 * @param {any} service
 * @param {string} host
 * @param {number} [statusCode]
 * @param {number} [retryAfterMs]
 * @param {string} [errorMsg]
 */
function recordHostWafBlock(
  service,
  host,
  statusCode = 403,
  retryAfterMs = 0,
  errorMsg = 'WAF or rate limit block'
) {
  const cleanHost = String(host || '').toLowerCase().trim();
  if (!cleanHost) return null;
  service.halfOpenProbesInFlight.delete(cleanHost);

  service.ensureOpen();
  const nowTs = service.now();
  const prev = service
    .stmt(
      'health.selectStateByHost',
      'SELECT state, consecutive_failures FROM storefront_endpoint_health WHERE host = ?'
    )
    .get(cleanHost);
  const failures = Number(prev?.consecutive_failures || 0) + 1;

  const baseMs =
    retryAfterMs > 0
      ? retryAfterMs
      : failures === 1
        ? 15 * 60 * 1000
        : failures === 2
          ? 30 * 60 * 1000
          : 60 * 60 * 1000;
  const jitterMs = service.options.disableJitter ? 0 : Math.floor(Math.random() * 5000);
  const openedUntil = nowTs + baseMs + jitterMs;

  service
    .stmt(
      'health.upsertState',
      `
      INSERT INTO storefront_endpoint_health (
        host, state, consecutive_failures, opened_until, last_status_code, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        state = excluded.state,
        consecutive_failures = excluded.consecutive_failures,
        opened_until = excluded.opened_until,
        last_status_code = excluded.last_status_code,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `
    )
    .run(cleanHost, 'OPEN', failures, openedUntil, statusCode, String(errorMsg), nowTs);

  const snapshot = {
    host: cleanHost,
    state: 'OPEN',
    consecutiveFailures: failures,
    openedUntil,
    lastStatusCode: statusCode,
    lastError: String(errorMsg),
  };
  service.emitHealthChanged(snapshot);
  return snapshot;
}

/**
 * @param {any} service
 * @param {string} host
 * @param {number | null} [statusCode]
 * @param {string} [errorMsg]
 */
function recordHostFailure(
  service,
  host,
  statusCode = null,
  errorMsg = 'Transient upstream failure'
) {
  const cleanHost = String(host || '').toLowerCase().trim();
  if (!cleanHost) return null;
  const wasCanary = service.halfOpenProbesInFlight.delete(cleanHost);

  service.ensureOpen();
  const nowTs = service.now();
  const prev = service
    .stmt(
      'health.selectStateByHost',
      'SELECT state, consecutive_failures FROM storefront_endpoint_health WHERE host = ?'
    )
    .get(cleanHost);
  const failures = Number(prev?.consecutive_failures || 0) + 1;

  const shouldTripOpen = failures >= 3 || wasCanary || prev?.state === 'HALF_OPEN';
  const nextState = shouldTripOpen ? 'OPEN' : 'CLOSED';
  let openedUntil = 0;
  if (shouldTripOpen) {
    const backoffMs =
      failures <= 3 ? 30 * 1000 : failures === 4 ? 2 * 60 * 1000 : 10 * 60 * 1000;
    openedUntil = nowTs + backoffMs;
  }

  service
    .stmt(
      'health.upsertState',
      `
      INSERT INTO storefront_endpoint_health (
        host, state, consecutive_failures, opened_until, last_status_code, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        state = excluded.state,
        consecutive_failures = excluded.consecutive_failures,
        opened_until = excluded.opened_until,
        last_status_code = excluded.last_status_code,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `
    )
    .run(cleanHost, nextState, failures, openedUntil, statusCode, String(errorMsg), nowTs);

  const snapshot = {
    host: cleanHost,
    state: nextState,
    consecutiveFailures: failures,
    openedUntil,
    ...(statusCode !== null && statusCode !== undefined ? { lastStatusCode: statusCode } : {}),
    lastError: String(errorMsg),
  };
  if (shouldTripOpen) {
    service.emitHealthChanged(snapshot);
  }
  return snapshot;
}

/**
 * Resolves a media asset request for `ol-media://` or `MediaHydrationEngine` across:
 * 1. Content-addressed SQLite blob vault / `url_resolution_cache` / verified federated path
 * 2. Zero-copy async local first-party cache federation (Steam, GOG Galaxy, Heroic, Xbox)
 * 3. Reference-counted `AbortSignal`-coalesced upstream fetch + bounded error reads + persist-on-read
 *
 * @param {any} service
 * @param {Record<string, any> | string | URL} [paramsInput]
 * @param {{ signal?: AbortSignal, backgroundHydration?: boolean, hydrationTier?: number, throwOnAbort?: boolean, localCacheOnly?: boolean }} [reqOpts]
 */
async function resolveMediaRequest(service, paramsInput = {}, reqOpts = {}) {
  const params = parseMediaRequestParams(paramsInput);

  const gameId = String(params.gameId || '').trim();
  const role = String(params.role || 'cover').trim();
  const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
  const rawUrl = typeof params.url === 'string' ? params.url.trim() : '';
  const isExplicitOverride = isExplicitOverrideParam(params.ov);

  if (rawUrl && isRejectedVideoUrl(rawUrl)) {
    return { kind: 'error', status: 415, reason: 'video_caching_prohibited' };
  }

  service.ensureOpen();

  if (
    !reqOpts.backgroundHydration &&
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

  const nowTs = service.now();
  const normRawUrl = rawUrl ? normalizeAssetIdentityUrl(rawUrl) : '';
  const urlKey = buildAssetUrlKey(gameId, role, ordinal, rawUrl);

  const selectByUrlKeyStmt = service.stmt(
    'media.selectByUrlKey',
    'SELECT * FROM game_media_assets WHERE url_key = ?'
  );
  let assetRow = selectByUrlKeyStmt.get(urlKey);
  if (!assetRow && rawUrl) {
    assetRow = service
      .stmt(
        'media.selectActiveBySourceUrl',
        "SELECT * FROM game_media_assets WHERE source_url = ? AND storage_kind IN ('blob', 'federated') LIMIT 1"
      )
      .get(rawUrl);
  }

  const assetSourceNorm =
    assetRow && assetRow.source_url ? normalizeAssetIdentityUrl(assetRow.source_url) : '';
  const isUrlMismatch = Boolean(
    assetRow &&
      assetRow.url_key === urlKey &&
      normRawUrl &&
      assetSourceNorm &&
      assetSourceNorm !== normRawUrl
  );
  const onlineNow = service.isNetworkOnline();

  const urlCacheRow = normRawUrl
    ? service
        .stmt(
          'urlCache.selectByNormFull',
          'SELECT blob_sha256, failure_count, next_retry_at, last_status_code FROM url_resolution_cache WHERE norm_url = ?'
        )
        .get(normRawUrl)
    : null;

  /** @type {string | null} */
  let offlineFallbackBlobSha = null;
  let offlineFallbackPrevSourceUrl = '';
  let skipTier1ForOnlineBlobUpgrade = false;

  const clearUrlCacheBlobStmt = service.stmt(
    'urlCache.clearBlobByNorm',
    'UPDATE url_resolution_cache SET blob_sha256 = NULL WHERE norm_url = ?'
  );
  const resetCandidateStmt = service.stmt(
    'media.resetCandidatePending',
    `
      UPDATE game_media_assets
      SET source_url = ?,
          storage_kind = 'pending',
          blob_sha256 = NULL,
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL,
          last_verified_at = ?
      WHERE url_key = ?
    `
  );

  if (isUrlMismatch && assetRow) {
    if (assetRow.storage_kind === 'blob' && assetRow.blob_sha256) {
      offlineFallbackBlobSha = String(assetRow.blob_sha256);
      offlineFallbackPrevSourceUrl = String(assetRow.source_url);

      if (urlCacheRow && urlCacheRow.blob_sha256) {
        const cachedHit = await tryResolveBlobBySha(
          service,
          String(urlCacheRow.blob_sha256),
          'public, max-age=31536000, immutable'
        );
        if (cachedHit) {
          bindAssetBlobRow(
            service,
            urlKey,
            gameId,
            role,
            ordinal,
            rawUrl,
            String(urlCacheRow.blob_sha256)
          );
          return cachedHit;
        }
        clearUrlCacheBlobStmt.run(normRawUrl);
      } else if (
        onlineNow &&
        reqOpts.localCacheOnly !== true &&
        urlCacheRow &&
        !urlCacheRow.blob_sha256 &&
        Number(urlCacheRow.next_retry_at || 0) > nowTs
      ) {
        return {
          kind: 'error',
          status: 404,
          reason: 'adaptive_404_cooldown',
          nextRetryAt: Number(urlCacheRow.next_retry_at),
        };
      }

      if (onlineNow && reqOpts.localCacheOnly !== true) {
        skipTier1ForOnlineBlobUpgrade = true;
      }
    } else if (assetRow.storage_kind === 'pending') {
      resetCandidateStmt.run(rawUrl, nowTs, urlKey);
      assetRow = selectByUrlKeyStmt.get(urlKey);
    } else if (
      assetRow.storage_kind === 'federated' &&
      onlineNow &&
      reqOpts.localCacheOnly !== true
    ) {
      if (urlCacheRow && urlCacheRow.blob_sha256) {
        const cachedHit = await tryResolveBlobBySha(
          service,
          String(urlCacheRow.blob_sha256),
          'public, max-age=31536000, immutable'
        );
        if (cachedHit) {
          bindAssetBlobRow(
            service,
            urlKey,
            gameId,
            role,
            ordinal,
            rawUrl,
            String(urlCacheRow.blob_sha256)
          );
          return cachedHit;
        }
        clearUrlCacheBlobStmt.run(normRawUrl);
      }
      resetCandidateStmt.run(rawUrl, nowTs, urlKey);
      assetRow = selectByUrlKeyStmt.get(urlKey);
    }
  }

  // Tier 1A: Existing content-addressed blob hit
  if (
    !skipTier1ForOnlineBlobUpgrade &&
    assetRow &&
    assetRow.storage_kind === 'blob' &&
    assetRow.blob_sha256
  ) {
    const blobHit = await tryResolveBlobBySha(
      service,
      String(assetRow.blob_sha256),
      isUrlMismatch ? 'public, max-age=3600' : 'public, max-age=31536000, immutable'
    );
    if (blobHit) {
      return blobHit;
    }
    service
      .stmt(
        'media.resetMissingBlobByUrlKey',
        "UPDATE game_media_assets SET storage_kind = 'pending', blob_sha256 = NULL WHERE url_key = ?"
      )
      .run(assetRow.url_key);
    if (normRawUrl && !isUrlMismatch) {
      clearUrlCacheBlobStmt.run(normRawUrl);
    }
  }

  // Tier 1A secondary hit: `url_resolution_cache`
  if (
    !skipTier1ForOnlineBlobUpgrade &&
    normRawUrl &&
    urlCacheRow &&
    urlCacheRow.blob_sha256 &&
    (!assetRow || assetRow.storage_kind === 'pending')
  ) {
    const cachedHit = await tryResolveBlobBySha(
      service,
      String(urlCacheRow.blob_sha256),
      'public, max-age=31536000, immutable'
    );
    if (cachedHit) {
      bindAssetBlobRow(
        service,
        urlKey,
        gameId,
        role,
        ordinal,
        rawUrl,
        String(urlCacheRow.blob_sha256)
      );
      return cachedHit;
    }
    clearUrlCacheBlobStmt.run(normRawUrl);
  }

  // Tier 1B: Existing verified federated local file hit
  if (
    !skipTier1ForOnlineBlobUpgrade &&
    assetRow &&
    assetRow.storage_kind === 'federated' &&
    assetRow.federated_path
  ) {
    const fedHit = await tryResolveFederatedRow(
      service,
      assetRow,
      rawUrl,
      params,
      isExplicitOverride,
      { selfHealMissing: true }
    );
    if (fedHit) {
      return fedHit;
    }
  }

  // Tier 2: Zero-Copy First-Party Local Cache Federation (async when supported!)
  const normalizedRoleForFederation = role.toLowerCase();
  const skipTier2Federation =
    isExplicitOverride ||
    normalizedRoleForFederation === 'achievement_icon' ||
    (normalizedRoleForFederation === 'icon' && ordinal > 0);
  if (!skipTier2Federation) {
    let resolvedXboxProductId = params.xboxProductId || params.xid || '';
    let resolvedPfn = params.packageFamilyName || params.pfn || params.xpfn || '';
    let resolvedXboxTitleId = params.xboxTitleId || params.xtid || '';

    if (!resolvedXboxProductId && /^xbox[-_:]([A-Z0-9]{12})$/i.test(gameId)) {
      resolvedXboxProductId = gameId.replace(/^xbox[-_:]/i, '').toUpperCase();
    }
    if (gameId && (!resolvedXboxProductId || !resolvedPfn || !resolvedXboxTitleId)) {
      try {
        const gRow = service
          .stmt(
            'games.selectPlatformsSummaryById',
            'SELECT platforms_json, summary_json FROM vault_games WHERE game_id = ?'
          )
          .get(gameId);
        if (gRow) {
          const plats = parseVaultJson(gRow.platforms_json);
          const xboxPlat = Array.isArray(plats)
            ? plats.find((p) => p && String(p.platformId || '').toLowerCase() === 'xbox')
            : null;
          if (xboxPlat) {
            if (!resolvedXboxProductId && xboxPlat.xboxProductId) {
              resolvedXboxProductId = xboxPlat.xboxProductId;
            }
            if (!resolvedPfn && xboxPlat.packageFamilyName) {
              resolvedPfn = xboxPlat.packageFamilyName;
            }
            if (!resolvedXboxTitleId && xboxPlat.xboxTitleId) {
              resolvedXboxTitleId = xboxPlat.xboxTitleId;
            }
          }
        }
      } catch {}
    }

    const federationPayload = {
      gameId,
      role,
      ordinal,
      url: rawUrl,
      ov: params.ov,
      steamAppId: params.steamAppId ?? params.sid,
      gogId: params.gogId ?? params.gid,
      epicAppName: params.epicAppName || params.epicApp,
      xboxProductId: resolvedXboxProductId,
      packageFamilyName: resolvedPfn,
      pfn: resolvedPfn,
      xboxTitleId: resolvedXboxTitleId,
      title: params.title,
    };

    const mayFederate =
      typeof service.federator?.canPotentiallyFederateAsset === 'function'
        ? service.federator.canPotentiallyFederateAsset(federationPayload)
        : true;

    const federatedHit = !mayFederate
      ? null
      : typeof service.federator?.resolveFederatedAssetAsync === 'function'
        ? await service.federator.resolveFederatedAssetAsync(federationPayload)
        : typeof service.federator?.resolveFederatedAsset === 'function'
          ? service.federator.resolveFederatedAsset(federationPayload)
          : typeof service.federator?.resolveLocalStoreAsset === 'function'
            ? service.federator.resolveLocalStoreAsset(federationPayload)
            : null;

    if (
      federatedHit &&
      federatedHit.path &&
      federatedHit.mimeType &&
      isFederatedAssetRowCompatible(rawUrl, federatedHit.path, federationPayload)
    ) {
      service
        .stmt(
          'media.upsertFederatedBinding',
          `
          INSERT INTO game_media_assets (
            url_key, game_id, asset_role, ordinal, source_url, storage_kind,
            blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
          ) VALUES (?, ?, ?, ?, ?, 'federated', NULL, ?, 0, 0, 200, ?)
          ON CONFLICT(url_key) DO UPDATE SET
            source_url = excluded.source_url,
            storage_kind = 'federated',
            blob_sha256 = NULL,
            federated_path = excluded.federated_path,
            failure_count = 0,
            next_retry_at = 0,
            last_status_code = 200,
            last_verified_at = excluded.last_verified_at
        `
        )
        .run(urlKey, gameId, role, ordinal, rawUrl, federatedHit.path, nowTs);

      return {
        kind: 'file',
        filePath: federatedHit.path,
        mimeType: federatedHit.mimeType,
        sizeBytes: federatedHit.sizeBytes,
        cacheControl: 'public, max-age=86400',
        source: federatedHit.source || 'federated_local',
      };
    }
  }

  // Tier 3: Reference-Counted `AbortSignal`-Coalesced Upstream HTTPS Fetch + Persist-on-Read
  if (!rawUrl) {
    return { kind: 'error', status: 404, reason: 'no_upstream_url' };
  }
  if (!/^https:\/\//i.test(rawUrl)) {
    return { kind: 'error', status: 403, reason: 'ssrf_blocked' };
  }
  if (reqOpts.localCacheOnly === true) {
    if (offlineFallbackBlobSha) {
      const fallbackMb = service
        .stmt(
          'blobs.selectFullBySha',
          'SELECT sha256, ext, mime_type, size_bytes FROM media_blobs WHERE sha256 = ?'
        )
        .get(offlineFallbackBlobSha);
      if (fallbackMb) {
        const fallbackPath = getBlobFilePath(service, fallbackMb.sha256, fallbackMb.ext);
        if (isContainedWithinRoot(service.blobsDir, fallbackPath, service.options.platform)) {
          let fbStat = null;
          try {
            fbStat = await fs.promises.stat(fallbackPath);
          } catch {}
          if (fbStat && fbStat.isFile() && fbStat.size > 0) {
            service
              .stmt(
                'media.restoreFallbackBlob',
                "UPDATE game_media_assets SET source_url = ?, storage_kind = 'blob', blob_sha256 = ? WHERE url_key = ?"
              )
              .run(offlineFallbackPrevSourceUrl || rawUrl, offlineFallbackBlobSha, urlKey);
            touchBlobAccess(service, fallbackMb.sha256);
            return {
              kind: 'file',
              filePath: fallbackPath,
              mimeType: fallbackMb.mime_type,
              sizeBytes: Number(fallbackMb.size_bytes || fbStat.size || 0),
              cacheControl: 'public, max-age=3600',
              source: 'vault_blob',
            };
          }
        }
      }
    }
    return { kind: 'error', status: 404, reason: 'offline_cache_miss' };
  }

  if (reqOpts.signal?.aborted) {
    if (reqOpts.throwOnAbort === true) {
      throw reqOpts.signal.reason || new Error('Aborted');
    }
    return { kind: 'error', status: 499, reason: 'aborted' };
  }

  if (
    assetRow &&
    assetRow.url_key === urlKey &&
    !skipTier1ForOnlineBlobUpgrade &&
    Number(assetRow.next_retry_at || 0) > nowTs
  ) {
    return {
      kind: 'error',
      status: 404,
      reason: 'adaptive_404_cooldown',
      nextRetryAt: Number(assetRow.next_retry_at),
    };
  }
  if (urlCacheRow && !urlCacheRow.blob_sha256 && Number(urlCacheRow.next_retry_at || 0) > nowTs) {
    return {
      kind: 'error',
      status: 404,
      reason: 'adaptive_404_cooldown',
      nextRetryAt: Number(urlCacheRow.next_retry_at),
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { kind: 'error', status: 400, reason: 'invalid_url' };
  }
  const host = parsedUrl.hostname.toLowerCase();
  const fetchKey = `${role}::${rawUrl}`;

  let inFlightEntry = service.inFlightMediaFetches.get(fetchKey);
  if (!inFlightEntry) {
    const gate = canRequestHost(service, host);
    if (!gate.allowed) {
      return {
        kind: 'error',
        status: 503,
        reason: 'circuit_open',
        retryAfterMs: gate.retryAfterMs,
      };
    }

    const sharedAbortCtrl = new AbortController();
    /** @type {any} */
    const entry = {
      sharedAbortCtrl,
      subscribers: new Set(),
      hasForegroundSubscriber: !reqOpts.backgroundHydration,
      abortedByAllSubscribers: false,
      timedOut: false,
      primaryUrlKey: urlKey,
      promise: null,
    };

    const timeoutId = setTimeout(() => {
      entry.timedOut = true;
      sharedAbortCtrl.abort(new Error('Media fetch timeout'));
    }, 10000);
    if (typeof timeoutId.unref === 'function') timeoutId.unref();

    const runSharedFetch = async () => {
      const fetchFn = getFetchImpl(service);
      if (typeof fetchFn !== 'function') {
        releaseCanaryIfHeld(service, host);
        return { response: { kind: 'error', status: 503, reason: 'fetch_unavailable' } };
      }

      try {
        const { response: res } = await safePublicHttpsFetch(rawUrl, {
          fetchImpl: fetchFn,
          dnsLookup: service.options.dnsLookup,
          allowDnsUnavailableForCustomFetch: service.hasCustomFetchImpl,
          method: 'GET',
          headers: {
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'User-Agent': getCanonicalChromeUserAgent({ platform: service.options.platform }),
          },
          signal: sharedAbortCtrl.signal,
          timeoutMs: 10000,
          maxRedirects: 3,
          readBody: false,
        });

        const status = Number(res.status || 0);
        const contentType = String(res.headers?.get?.('content-type') || '');

        if (REJECTED_VIDEO_MIME_RE.test(contentType)) {
          await cancelResponseBodySafely(res);
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 415, reason: 'video_caching_prohibited' } };
        }

        if (status === 429 || status === 403 || res.headers?.get?.('cf-mitigated')) {
          const sampleText = await readBoundedErrorBodySample(res, MAX_ERROR_BODY_SAMPLE_BYTES);
          if (isWafOrChallengeResponse(status, sampleText, res.headers)) {
            const retryMs = parseRetryAfterMs(res.headers);
            recordHostWafBlock(service, host, status, retryMs, `HTTP ${status} WAF/rate-limit`);
            return { response: { kind: 'error', status, reason: 'waf_blocked' } };
          }
          await cancelResponseBodySafely(res);
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: status || 403, reason: 'http_error' } };
        }

        if (status === 404) {
          let sampleText = '';
          if (/text\/html/i.test(contentType)) {
            sampleText = await readBoundedErrorBodySample(res, MAX_ERROR_BODY_SAMPLE_BYTES);
          } else {
            await cancelResponseBodySafely(res);
          }
          if (isWafOrChallengeResponse(404, sampleText, res.headers)) {
            recordHostWafBlock(service, host, 404, 0, 'WAF disguised as 404');
            return { response: { kind: 'error', status: 403, reason: 'waf_blocked' } };
          }
          recordHostSuccess(service, host, 404);
          recordAssetAdaptive404(service, urlKey, gameId, role, ordinal, rawUrl);
          return {
            isDefinitive404: true,
            response: { kind: 'error', status: 404, reason: 'not_found' },
          };
        }

        if (status >= 500 || status === 0) {
          await cancelResponseBodySafely(res);
          recordHostFailure(service, host, status || 502, `HTTP ${status}`);
          return { response: { kind: 'error', status: status || 502, reason: 'http_5xx' } };
        }

        if (!res.ok) {
          await cancelResponseBodySafely(res);
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: status || 400, reason: 'http_error' } };
        }

        const isInlineOrGifCandidate =
          role === 'inline_img' ||
          /\.gif(?:$|[?#])/i.test(rawUrl) ||
          /image\/gif/i.test(contentType);
        const maxFetchBytes = isInlineOrGifCandidate
          ? MAX_ASSET_FETCH_BYTES
          : MAX_DOWNLOAD_IMAGE_BYTES;

        const contentLength = Number(res.headers?.get?.('content-length') || 0);
        if (contentLength > maxFetchBytes) {
          await cancelResponseBodySafely(res);
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
        }

        if (
          !entry.hasForegroundSubscriber &&
          isInlineOrGifCandidate &&
          (/image\/gif/i.test(contentType) || /\.gif(?:$|[?#])/i.test(rawUrl)) &&
          contentLength > MAX_INLINE_ANIMATED_GIF_CACHE_BYTES
        ) {
          recordHostSuccess(service, host, 200);
          await cancelResponseBodySafely(res);
          try {
            sharedAbortCtrl.abort(new Error('Skip oversized background GIF body'));
          } catch {}
          return {
            response: {
              kind: 'error',
              status: 413,
              reason: 'oversized_animated_gif_skipped',
              skipDiskBlob: true,
            },
          };
        }

        let rawBuf;
        try {
          rawBuf = await readSafeResponseBuffer(res, maxFetchBytes);
        } catch (streamErr) {
          await cancelResponseBodySafely(res);
          if (/** @type {any} */ (streamErr)?.code === 'ERR_RESPONSE_TOO_LARGE') {
            releaseCanaryIfHeld(service, host);
            return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
          }
          throw streamErr;
        }
        if (rawBuf.length > maxFetchBytes) {
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
        }

        const magic = detectImageMagicBytes(rawBuf);
        if (!magic.valid) {
          if (isWafOrChallengeResponse(200, rawBuf, res.headers)) {
            recordHostWafBlock(service, host, 403, 0, 'HTML challenge page on 200 OK');
            return { response: { kind: 'error', status: 403, reason: 'waf_blocked' } };
          }
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 415, reason: 'invalid_image_magic' } };
        }

        if (
          rawBuf.length > MAX_DOWNLOAD_IMAGE_BYTES &&
          !(magic.ext === 'gif' && isAnimatedGifBuffer(rawBuf))
        ) {
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
        }

        recordHostSuccess(service, host, 200);

        const stored = await storeNormalizedBlobAsync(service, rawBuf, role, contentType);
        if (stored.stored && stored.sha256) {
          bindAssetBlobRow(service, urlKey, gameId, role, ordinal, rawUrl, stored.sha256);
          return {
            storedSha256: stored.sha256,
            response: {
              kind: 'buffer',
              buffer: stored.buffer,
              filePath: stored.filePath,
              mimeType: stored.mimeType,
              sizeBytes: stored.sizeBytes,
              cacheControl: 'public, max-age=31536000, immutable',
              source: 'upstream_persisted',
            },
          };
        }

        if (stored.buffer && stored.mimeType) {
          return {
            response: {
              kind: 'buffer',
              buffer: stored.buffer,
              mimeType: stored.mimeType,
              sizeBytes: stored.buffer.length,
              cacheControl: 'public, max-age=3600',
              ...(stored.skipDiskBlob ? { skipDiskBlob: true } : {}),
              source: stored.skipDiskBlob
                ? 'upstream_passthrough_oversized_gif'
                : 'upstream_passthrough_low_disk',
            },
          };
        }

        return { response: { kind: 'error', status: 415, reason: 'normalization_failed' } };
      } catch (err) {
        if (entry.abortedByAllSubscribers && !entry.timedOut) {
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 499, reason: 'aborted' } };
        }
        if (/** @type {any} */ (err)?.isSsrfBlocked) {
          releaseCanaryIfHeld(service, host);
          return { response: { kind: 'error', status: 403, reason: 'ssrf_blocked' } };
        }
        const msg = err instanceof Error ? err.message : String(err);
        recordHostFailure(service, host, null, msg);

        if (offlineFallbackBlobSha) {
          const fallbackMb = service
            .stmt(
              'blobs.selectFullBySha',
              'SELECT sha256, ext, mime_type, size_bytes FROM media_blobs WHERE sha256 = ?'
            )
            .get(offlineFallbackBlobSha);
          if (fallbackMb) {
            const fallbackPath = getBlobFilePath(service, fallbackMb.sha256, fallbackMb.ext);
            if (isContainedWithinRoot(service.blobsDir, fallbackPath, service.options.platform)) {
              let fbStat = null;
              try {
                fbStat = await fs.promises.stat(fallbackPath);
              } catch {}
              if (fbStat && fbStat.isFile() && fbStat.size > 0) {
                service
                  .stmt(
                    'media.restoreFallbackBlob',
                    "UPDATE game_media_assets SET source_url = ?, storage_kind = 'blob', blob_sha256 = ? WHERE url_key = ?"
                  )
                  .run(offlineFallbackPrevSourceUrl || rawUrl, offlineFallbackBlobSha, urlKey);
                touchBlobAccess(service, fallbackMb.sha256);
                return {
                  response: {
                    kind: 'file',
                    filePath: fallbackPath,
                    mimeType: fallbackMb.mime_type,
                    sizeBytes: Number(fallbackMb.size_bytes || 0),
                    cacheControl: 'public, max-age=3600',
                    source: 'vault_blob',
                  },
                };
              }
            }
          }
        }

        return { response: { kind: 'error', status: 504, reason: 'network_error' } };
      } finally {
        clearTimeout(timeoutId);
        service.inFlightMediaFetches.delete(fetchKey);
      }
    };

    entry.promise = runSharedFetch();
    service.inFlightMediaFetches.set(fetchKey, entry);
    inFlightEntry = entry;
  } else if (!reqOpts.backgroundHydration) {
    inFlightEntry.hasForegroundSubscriber = true;
  }

  const subId = Symbol('mediaSubscriber');
  inFlightEntry.subscribers.add(subId);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const callerSignal = reqOpts.signal || null;

    const onCallerAbort = () => {
      if (settled) return;
      settled = true;
      inFlightEntry.subscribers.delete(subId);
      if (inFlightEntry.subscribers.size === 0) {
        inFlightEntry.abortedByAllSubscribers = true;
        try {
          inFlightEntry.sharedAbortCtrl.abort(
            callerSignal?.reason || new Error('All media subscribers aborted')
          );
        } catch {}
      }
      if (reqOpts.throwOnAbort === true) {
        reject(callerSignal?.reason || new Error('Aborted'));
      } else {
        resolve({ kind: 'error', status: 499, reason: 'aborted' });
      }
    };

    if (callerSignal) {
      if (callerSignal.aborted) {
        onCallerAbort();
        return;
      }
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    inFlightEntry.promise.then(
      (/** @type {any} */ sharedRes) => {
        if (callerSignal) {
          callerSignal.removeEventListener('abort', onCallerAbort);
        }
        inFlightEntry.subscribers.delete(subId);
        if (settled) return;
        settled = true;

        if (sharedRes?.storedSha256 && urlKey !== inFlightEntry.primaryUrlKey) {
          try {
            bindAssetBlobRow(
              service,
              urlKey,
              gameId,
              role,
              ordinal,
              rawUrl,
              sharedRes.storedSha256
            );
          } catch {}
        } else if (sharedRes?.isDefinitive404 && urlKey !== inFlightEntry.primaryUrlKey) {
          try {
            recordAssetAdaptive404(service, urlKey, gameId, role, ordinal, rawUrl);
          } catch {}
        }

        resolve(sharedRes?.response || { kind: 'error', status: 504, reason: 'network_error' });
      },
      (/** @type {any} */ unexpectedErr) => {
        if (callerSignal) {
          callerSignal.removeEventListener('abort', onCallerAbort);
        }
        inFlightEntry.subscribers.delete(subId);
        if (settled) return;
        settled = true;
        const msg = unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr);
        resolve({ kind: 'error', status: 504, reason: msg || 'network_error' });
      }
    );
  });
}

/**
 * Checks upstream URL reachability & status for `offlineVault:check-url-status` IPC.
 * Uses canonical UA, bounded error-body reads (`readBoundedErrorBodySample`), and mandatory stream cancellation.
 *
 * @param {any} service
 * @param {string} url
 */
async function checkUrlStatus(service, url) {
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  if (!cleanUrl || !/^https:\/\//i.test(cleanUrl)) {
    return {
      online: false,
      status: null,
      isDefinitive404: false,
      isWafOrRateLimited: false,
      ...(cleanUrl ? { blocked: true } : {}),
    };
  }

  let host = '';
  try {
    host = new URL(cleanUrl).hostname.toLowerCase();
  } catch {
    return {
      online: false,
      status: null,
      isDefinitive404: false,
      isWafOrRateLimited: false,
    };
  }

  const gate = canRequestHost(service, host);
  if (!gate.allowed) {
    const snap = getEndpointHealth(service, host);
    const isWaf = snap?.lastStatusCode === 429 || snap?.lastStatusCode === 403;
    return {
      online: true,
      status: snap?.lastStatusCode || 503,
      isDefinitive404: false,
      isWafOrRateLimited: isWaf,
      retryAfterMs: gate.retryAfterMs,
    };
  }

  const fetchFn = getFetchImpl(service);
  if (typeof fetchFn !== 'function') {
    releaseCanaryIfHeld(service, host);
    return {
      online: false,
      status: null,
      isDefinitive404: false,
      isWafOrRateLimited: false,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  if (typeof timer.unref === 'function') timer.unref();
  const canonicalUa = getCanonicalChromeUserAgent({ platform: service.options.platform });

  try {
    let { response: res } = await safePublicHttpsFetch(cleanUrl, {
      fetchImpl: fetchFn,
      dnsLookup: service.options.dnsLookup,
      allowDnsUnavailableForCustomFetch: service.hasCustomFetchImpl,
      method: 'HEAD',
      headers: {
        'User-Agent': canonicalUa,
      },
      signal: ctrl.signal,
      timeoutMs: 6000,
      maxRedirects: 3,
      readBody: false,
    });

    if (res.status === 405 || res.status === 403) {
      await cancelResponseBodySafely(res);
      const fallbackGet = await safePublicHttpsFetch(cleanUrl, {
        fetchImpl: fetchFn,
        dnsLookup: service.options.dnsLookup,
        allowDnsUnavailableForCustomFetch: service.hasCustomFetchImpl,
        method: 'GET',
        headers: {
          Range: 'bytes=0-2047',
          'User-Agent': canonicalUa,
        },
        signal: ctrl.signal,
        timeoutMs: 6000,
        maxRedirects: 3,
        readBody: false,
      });
      res = fallbackGet.response;
    }

    const status = Number(res.status || 0);
    let bodySample = '';
    if (status === 403 || status === 429 || status === 404) {
      bodySample = await readBoundedErrorBodySample(res, MAX_ERROR_BODY_SAMPLE_BYTES);
    } else {
      await cancelResponseBodySafely(res);
    }

    if (isWafOrChallengeResponse(status, bodySample, res.headers)) {
      const retryMs = parseRetryAfterMs(res.headers);
      const snap = recordHostWafBlock(service, host, status, retryMs, `CheckURL WAF ${status}`);
      return {
        online: true,
        status,
        isDefinitive404: false,
        isWafOrRateLimited: true,
        retryAfterMs: snap ? Math.max(0, snap.openedUntil - service.now()) : retryMs,
      };
    }

    if (status === 404) {
      recordHostSuccess(service, host, 404);
      return {
        online: true,
        status: 404,
        isDefinitive404: true,
        isWafOrRateLimited: false,
      };
    }

    if (status >= 500) {
      recordHostFailure(service, host, status, `CheckURL HTTP ${status}`);
      return {
        online: true,
        status,
        isDefinitive404: false,
        isWafOrRateLimited: false,
      };
    }

    recordHostSuccess(service, host, status || 200);
    return {
      online: true,
      status: status || 200,
      isDefinitive404: false,
      isWafOrRateLimited: false,
    };
  } catch (err) {
    if (/** @type {any} */ (err)?.isSsrfBlocked) {
      releaseCanaryIfHeld(service, host);
      return {
        online: false,
        status: null,
        isDefinitive404: false,
        isWafOrRateLimited: false,
        blocked: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    recordHostFailure(service, host, null, msg);
    return {
      online: false,
      status: null,
      isDefinitive404: false,
      isWafOrRateLimited: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getFetchImpl,
  getEndpointHealth,
  canRequestHost,
  releaseCanaryIfHeld,
  recordHostSuccess,
  recordHostWafBlock,
  recordHostFailure,
  resolveMediaRequest,
  checkUrlStatus,
  cancelResponseBodySafely,
  readBoundedErrorBodySample,
};
