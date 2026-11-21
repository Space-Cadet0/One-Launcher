// @ts-check
'use strict';

const fs = require('node:fs');
const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  MAX_P1_RECENT_DETAIL_GAMES,
  compressVaultJson,
  decompressVaultJsonString,
  parseVaultJson,
  normalizeSafeVaultGameId,
  collectVaultGameIdVariants,
  isDbReadOnly,
} = require('./vaultSchemaAndLifecycle.cjs');
const {
  METADATA_QUALITY_RANK,
  isRejectedVideoUrl,
  normalizeAssetIdentityUrl,
  hasXboxPlatform,
  extractXboxBigIdsFromGame,
  carryForwardVaultRequirements,
  getCriticAuthorityRank,
  carryForwardVaultCriticAndReviewFields,
  hasVaultNonPlaceholderStrings,
  inferVaultMetadataQuality,
  buildAssetUrlKey,
  buildVaultPlatformSanitizeContext,
  sanitizeVaultPlatformEntriesOsFlags,
  isStandaloneStorefrontLauncherUtility,
} = require('./vaultMetadataLattice.cjs');

/**
 * Registers or updates a media candidate row using cached statements and ZERO sync `fs.existsSync`
 * inside SQLite write transactions. When an existing `storage_kind = 'blob'` row has a mismatched
 * URL and `deferredBlobDiskChecks` is provided, disk verification is deferred until after `COMMIT`
 * so SQLite write locks are never held across filesystem I/O.
 *
 * @param {any} service
 * @param {string} gameId
 * @param {string} assetRole
 * @param {number} ordinal
 * @param {string} sourceUrl
 * @param {number} nowTs
 * @param {boolean} [allowCreatePending=true]
 * @param {Array<{ urlKey: string, sha256: string, cleanUrl: string, nowTs: number, isCoverRole: boolean }> | null} [deferredBlobDiskChecks=null]
 */
function registerGameMediaCandidate(
  service,
  gameId,
  assetRole,
  ordinal,
  sourceUrl,
  nowTs,
  allowCreatePending = true,
  deferredBlobDiskChecks = null
) {
  if (!sourceUrl || typeof sourceUrl !== 'string') return;
  const cleanUrl = sourceUrl.trim();
  if (!/^https?:\/\//i.test(cleanUrl) || isRejectedVideoUrl(cleanUrl)) return;

  service.ensureOpen();
  const urlKey = buildAssetUrlKey(gameId, assetRole, ordinal, cleanUrl);
  const existing = service
    .stmt(
      'media.selectCandidateByKey',
      'SELECT source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?'
    )
    .get(urlKey);

  if (!existing) {
    if (!allowCreatePending) return;
    service
      .stmt(
        'media.insertPendingCandidate',
        `
        INSERT INTO game_media_assets (
          url_key, game_id, asset_role, ordinal, source_url, storage_kind,
          blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, 0, NULL, ?)
      `
      )
      .run(
        urlKey,
        String(gameId || ''),
        String(assetRole || 'cover'),
        Math.max(0, Math.floor(Number(ordinal) || 0)),
        cleanUrl,
        nowTs
      );
    return;
  }

  // Non-destructive sync candidate update:
  // NEVER wipe a healthy on-disk cover blob during routine upsertGames() syncs just because raw
  // capsuleImage differs from the resolved cover URL rendered by GameCardCover.
  if (
    existing.source_url !== cleanUrl &&
    normalizeAssetIdentityUrl(existing.source_url) !== normalizeAssetIdentityUrl(cleanUrl)
  ) {
    const normalizedRole = String(assetRole || 'cover').toLowerCase();
    const isCoverRole = normalizedRole === 'cover' || normalizedRole === 'capsule';

    if (existing.storage_kind === 'blob') {
      const sha = existing.blob_sha256 ? String(existing.blob_sha256) : '';
      let isKnownBlob = Boolean(sha && service.knownBlobHashes.has(sha));
      if (sha && !isKnownBlob) {
        const mb = service
          .stmt('blobs.selectMetaBySha', 'SELECT ext, size_bytes FROM media_blobs WHERE sha256 = ?')
          .get(sha);
        if (mb) {
          isKnownBlob = true;
          service.knownBlobHashes.add(sha);
          service.blobMetaBySha.set(sha, {
            ext: String(mb.ext || 'jpg'),
            sizeBytes: Math.max(0, Number(mb.size_bytes || 0)),
          });
        }
      }

      if (isKnownBlob) {
        if (Array.isArray(deferredBlobDiskChecks)) {
          // Defer disk-presence verification until after COMMIT so ZERO fs.existsSync runs inside SQLite tx!
          deferredBlobDiskChecks.push({
            urlKey,
            sha256: sha,
            cleanUrl,
            nowTs,
            isCoverRole,
          });
          return;
        }
        // Standalone call outside a caller-managed tx: check disk outside any write lock
        const meta = service.blobMetaBySha.get(sha);
        let hasLiveBlobOnDisk = false;
        if (meta) {
          const blobPath = service.getBlobFilePath(sha, meta.ext);
          if (
            isContainedWithinRoot(service.blobsDir, blobPath, service.options.platform) &&
            fs.existsSync(blobPath)
          ) {
            hasLiveBlobOnDisk = true;
          } else {
            service.knownBlobHashes.delete(sha);
            service.blobMetaBySha.delete(sha);
          }
        }
        if (hasLiveBlobOnDisk && (isCoverRole || !service.isNetworkOnline())) {
          return;
        }
      }
    } else if (existing.storage_kind !== 'pending' && !service.isNetworkOnline()) {
      return;
    }

    service
      .stmt(
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
      )
      .run(cleanUrl, nowTs, urlKey);
  }
}

/**
 * Runs deferred blob-on-disk verification OUTSIDE any SQLite write transaction so missing disk
 * blobs still self-heal cleanly on `upsertGames()` / `saveGameDetail()` while keeping SQLite
 * transactions 100% free of synchronous filesystem I/O.
 *
 * @param {any} service
 * @param {Array<{ urlKey: string, sha256: string, cleanUrl: string, nowTs: number, isCoverRole: boolean }>} deferredChecks
 */
function reconcileDeferredBlobDiskChecks(service, deferredChecks) {
  if (!Array.isArray(deferredChecks) || deferredChecks.length === 0) return;
  const db = service.db;
  if (!db) return;

  const isOnline = service.isNetworkOnline();
  /** @type {Map<string, boolean>} */
  const existsBySha = new Map();
  /** @type {Array<{ urlKey: string, cleanUrl: string, nowTs: number }>} */
  const rowsToReset = [];

  for (const item of deferredChecks) {
    let exists = existsBySha.get(item.sha256);
    if (exists === undefined) {
      const meta = service.blobMetaBySha.get(item.sha256);
      let ext = meta ? meta.ext : '';
      if (!ext) {
        const mb = service
          .stmt('blobs.selectMetaBySha', 'SELECT ext, size_bytes FROM media_blobs WHERE sha256 = ?')
          .get(item.sha256);
        if (mb && mb.ext) {
          ext = String(mb.ext);
          service.blobMetaBySha.set(item.sha256, {
            ext,
            sizeBytes: Math.max(0, Number(mb.size_bytes || 0)),
          });
        }
      }
      exists = false;
      if (ext) {
        const blobPath = service.getBlobFilePath(item.sha256, ext);
        if (
          isContainedWithinRoot(service.blobsDir, blobPath, service.options.platform) &&
          fs.existsSync(blobPath)
        ) {
          exists = true;
        }
      }
      existsBySha.set(item.sha256, exists);
      if (!exists) {
        const removedMeta = service.blobMetaBySha.get(item.sha256);
        if (removedMeta) {
          service.totalBlobBytes = Math.max(0, service.totalBlobBytes - removedMeta.sizeBytes);
        }
        service.knownBlobHashes.delete(item.sha256);
        service.blobMetaBySha.delete(item.sha256);
      }
    }

    if (exists && (item.isCoverRole || !isOnline)) {
      continue;
    }
    rowsToReset.push({ urlKey: item.urlKey, cleanUrl: item.cleanUrl, nowTs: item.nowTs });
  }

  if (rowsToReset.length === 0) return;

  const resetStmt = service.stmt(
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
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rowsToReset) {
      resetStmt.run(r.cleanUrl, r.nowTs, r.urlKey);
    }
    db.exec('COMMIT');
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
  }
}

/**
 * Batch-upserts catalog games with `1c42634` diff-skip (`skipped++`), `__quotaSlimmed` Rank-0
 * immunity, monotonic `QUALITY_RANK`, 13-field platform sanitization, and cached statements.
 *
 * @param {any} service
 * @param {any[]} games
 */
function upsertGames(service, games) {
  if (!Array.isArray(games)) {
    return { success: false, error: 'Expected array of games' };
  }
  const db = service.ensureOpen();
  const nowTs = service.now();
  let upserted = 0;
  let skipped = 0;

  const selectExistingStmt = service.stmt(
    'games.selectForUpsert',
    'SELECT canonical_title, steam_app_id, is_installed, is_favorited, archived_by_subscription_rotation, platforms_json, summary_json, enriched_json, metadata_quality, enriched_at FROM vault_games WHERE game_id = ?'
  );
  const deleteOrphanAssetsStmt = service.stmt(
    'games.deleteAssetsByGameId',
    'DELETE FROM game_media_assets WHERE game_id = ?'
  );
  const deleteOrphanUrlCacheStmt = service.stmt(
    'games.deleteUrlCacheByGameId',
    'DELETE FROM url_resolution_cache WHERE game_id = ?'
  );
  const deleteOrphanGameStmt = service.stmt(
    'games.deleteByGameId',
    'DELETE FROM vault_games WHERE game_id = ?'
  );
  const upsertStmt = service.stmt(
    'games.upsertCore',
    `
      INSERT INTO vault_games (
        game_id, canonical_title, steam_app_id, is_installed, is_favorited,
        archived_by_subscription_rotation,
        platforms_json, summary_json, enriched_json, metadata_quality, updated_at, enriched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET
        canonical_title = CASE WHEN excluded.canonical_title != '' THEN excluded.canonical_title ELSE vault_games.canonical_title END,
        steam_app_id = excluded.steam_app_id,
        is_installed = excluded.is_installed,
        is_favorited = excluded.is_favorited,
        archived_by_subscription_rotation = excluded.archived_by_subscription_rotation,
        platforms_json = COALESCE(excluded.platforms_json, vault_games.platforms_json),
        summary_json = COALESCE(excluded.summary_json, vault_games.summary_json),
        enriched_json = excluded.enriched_json,
        metadata_quality = excluded.metadata_quality,
        updated_at = excluded.updated_at,
        enriched_at = excluded.enriched_at
    `
  );

  /** @type {Array<{ urlKey: string, sha256: string, cleanUrl: string, nowTs: number, isCoverRole: boolean }>} */
  const deferredBlobDiskChecks = [];

  db.exec('BEGIN IMMEDIATE');
  service.txDepth = (service.txDepth || 0) + 1;
  try {
    for (const g of games) {
      if (!g || typeof g !== 'object' || !g.id) continue;
      const gameId = String(g.id).trim();
      if (!gameId) continue;

      const existing = selectExistingStmt.get(gameId);
      const rawPlatforms = Array.isArray(g.platforms) ? g.platforms : null;
      const incomingEnrichedPreview =
        g.enrichedMetadata && typeof g.enrichedMetadata === 'object' ? g.enrichedMetadata : null;
      const existingEnrichedStr =
        existing && existing.enriched_json
          ? decompressVaultJsonString(existing.enriched_json)
          : null;
      let existingEnrichedObj = null;
      if (existingEnrichedStr) {
        try {
          existingEnrichedObj = JSON.parse(existingEnrichedStr);
        } catch {
          existingEnrichedObj = null;
        }
      }
      const hasEnrichedForOsSanitize = Boolean(
        (incomingEnrichedPreview &&
          !(
            incomingEnrichedPreview.enrichedSource === 'xbox' &&
            !(Number(incomingEnrichedPreview.appId) > 0)
          )) ||
          (existingEnrichedObj &&
            !(
              existingEnrichedObj.enrichedSource === 'xbox' &&
              !(Number(existingEnrichedObj.appId) > 0)
            ))
      );
      const platforms = rawPlatforms
        ? sanitizeVaultPlatformEntriesOsFlags(
            rawPlatforms,
            hasEnrichedForOsSanitize,
            buildVaultPlatformSanitizeContext(g, incomingEnrichedPreview, existingEnrichedObj)
          ).platforms || null
        : null;

      if (
        Array.isArray(rawPlatforms) &&
        rawPlatforms.length > 0 &&
        Array.isArray(platforms) &&
        platforms.length === 0
      ) {
        if (existing) {
          try {
            deleteOrphanAssetsStmt.run(gameId);
            deleteOrphanUrlCacheStmt.run(gameId);
            deleteOrphanGameStmt.run(gameId);
          } catch {}
        }
        continue;
      }

      if (!/^xbox[-_]/i.test(gameId)) {
        const xboxBigIds = extractXboxBigIdsFromGame(g, platforms);
        for (const bigId of xboxBigIds) {
          const dupVariants = [
            `xbox-${bigId.toLowerCase()}`,
            `xbox-${bigId.toUpperCase()}`,
            `xbox_${bigId.toLowerCase()}`,
            `xbox_${bigId.toUpperCase()}`,
          ];
          for (const dupId of dupVariants) {
            if (dupId !== gameId) {
              deleteOrphanAssetsStmt.run(dupId);
              deleteOrphanUrlCacheStmt.run(dupId);
              deleteOrphanGameStmt.run(dupId);
            }
          }
        }
      }

      const isInstalled =
        g.isInstalled === true ||
        Boolean(platforms && platforms.some((p) => p && p.installed === true))
          ? 1
          : 0;
      if (!isInstalled && isStandaloneStorefrontLauncherUtility(g.title, platforms)) {
        if (existing) {
          try {
            deleteOrphanGameStmt.run(gameId);
          } catch {}
        }
        continue;
      }
      const isFavorited =
        typeof g.isFavorited === 'boolean'
          ? g.isFavorited
            ? 1
            : 0
          : existing
            ? Number(existing.is_favorited || 0)
            : 0;

      const rawSteamAppIdStr = typeof g.steamAppId === 'string' ? g.steamAppId.trim() : '';
      const steamAppId =
        typeof g.steamAppId === 'number' && g.steamAppId > 0
          ? g.steamAppId
          : rawSteamAppIdStr && /^\d+$/.test(rawSteamAppIdStr) && parseInt(rawSteamAppIdStr, 10) > 0
            ? parseInt(rawSteamAppIdStr, 10)
            : g.steamAppId === null || platforms !== null
              ? null
              : existing && typeof existing.steam_app_id === 'number' && existing.steam_app_id > 0
                ? existing.steam_app_id
                : null;

      const incomingIsSlimmed = Boolean(
        incomingEnrichedPreview?.__quotaSlimmed || incomingEnrichedPreview?.__digestOnly
      );
      const existingIsSlimmed = Boolean(
        existingEnrichedObj?.__quotaSlimmed || existingEnrichedObj?.__digestOnly
      );
      const existingSummaryStr =
        existing && existing.summary_json !== null && existing.summary_json !== undefined
          ? decompressVaultJsonString(existing.summary_json)
          : null;
      let existingSummaryObj = null;
      if (existingSummaryStr) {
        try {
          existingSummaryObj = JSON.parse(existingSummaryStr);
        } catch {
          existingSummaryObj = null;
        }
      }

      const summaryCopy = { ...g };
      delete summaryCopy.enrichedMetadata;
      if (platforms) {
        summaryCopy.platforms = platforms;
      }

      // Protect summary_json against __quotaSlimmed / empty-field clobber
      if (existingSummaryObj && typeof existingSummaryObj === 'object') {
        if (
          !(
            typeof summaryCopy.shortDescription === 'string' &&
            summaryCopy.shortDescription.trim().length > 0
          ) &&
          typeof existingSummaryObj.shortDescription === 'string' &&
          existingSummaryObj.shortDescription.trim().length > 0
        ) {
          summaryCopy.shortDescription = existingSummaryObj.shortDescription;
        }
        if (
          !(
            typeof summaryCopy.detailedDescription === 'string' &&
            summaryCopy.detailedDescription.trim().length > 0
          ) &&
          typeof existingSummaryObj.detailedDescription === 'string' &&
          existingSummaryObj.detailedDescription.trim().length > 0
        ) {
          summaryCopy.detailedDescription = existingSummaryObj.detailedDescription;
        }
        if (
          incomingIsSlimmed &&
          !(
            typeof summaryCopy.aboutTheGame === 'string' &&
            summaryCopy.aboutTheGame.trim().length > 0
          ) &&
          typeof existingSummaryObj.aboutTheGame === 'string' &&
          existingSummaryObj.aboutTheGame.trim().length > 0
        ) {
          summaryCopy.aboutTheGame = existingSummaryObj.aboutTheGame;
        }
        if (
          (incomingIsSlimmed ||
            !hasVaultNonPlaceholderStrings(summaryCopy.developers, 'Unknown Developer')) &&
          hasVaultNonPlaceholderStrings(existingSummaryObj.developers, 'Unknown Developer')
        ) {
          summaryCopy.developers = existingSummaryObj.developers;
        }
        if (
          (incomingIsSlimmed ||
            !hasVaultNonPlaceholderStrings(summaryCopy.publishers, 'Unknown Publisher')) &&
          hasVaultNonPlaceholderStrings(existingSummaryObj.publishers, 'Unknown Publisher')
        ) {
          summaryCopy.publishers = existingSummaryObj.publishers;
        }
        if (
          incomingIsSlimmed &&
          (!Array.isArray(summaryCopy.tags) || summaryCopy.tags.length === 0) &&
          Array.isArray(existingSummaryObj.tags) &&
          existingSummaryObj.tags.length > 0
        ) {
          summaryCopy.tags = existingSummaryObj.tags;
        }
        if (
          incomingIsSlimmed &&
          Array.isArray(existingSummaryObj.genres) &&
          existingSummaryObj.genres.length >
            (Array.isArray(summaryCopy.genres) ? summaryCopy.genres.length : 0)
        ) {
          summaryCopy.genres = existingSummaryObj.genres;
        }
        const incomingHasReviews = Boolean(
          summaryCopy.reviewSummary &&
            (summaryCopy.reviewSummary.totalReviews > 0 ||
              summaryCopy.reviewSummary.positivePercent > 0)
        );
        const existingHasReviews = Boolean(
          existingSummaryObj.reviewSummary &&
            (existingSummaryObj.reviewSummary.totalReviews > 0 ||
              existingSummaryObj.reviewSummary.positivePercent > 0)
        );
        if (!incomingHasReviews && existingHasReviews) {
          summaryCopy.reviewSummary = existingSummaryObj.reviewSummary;
        }
      }

      if (
        Array.isArray(platforms) &&
        platforms.some((ep) => ep && ep.isCrossPlatformLauncherRuntime === true)
      ) {
        const supportsLinux = platforms.some(
          (ep) => ep && ep.platforms && ep.platforms.linux === true
        );
        if (
          !summaryCopy.worksOn ||
          typeof summaryCopy.worksOn !== 'object' ||
          summaryCopy.worksOn.mac !== true ||
          summaryCopy.worksOn.windows === false
        ) {
          summaryCopy.worksOn = {
            ...(summaryCopy.worksOn || {}),
            windows: true,
            mac: true,
            linux: Boolean(summaryCopy.worksOn?.linux || supportsLinux),
          };
        }
      } else if (
        summaryCopy.worksOn &&
        typeof summaryCopy.worksOn === 'object' &&
        !summaryCopy.worksOn.windows &&
        !summaryCopy.worksOn.mac &&
        !summaryCopy.worksOn.linux
      ) {
        summaryCopy.worksOn = { windows: true, mac: false, linux: false };
      }
      const rawSummaryJson = JSON.stringify(summaryCopy);
      const rawPlatformsJson = platforms ? JSON.stringify(platforms) : null;

      const incomingEnriched =
        g.enrichedMetadata && typeof g.enrichedMetadata === 'object'
          ? { ...g.enrichedMetadata }
          : null;

      let incomingQuality = inferVaultMetadataQuality(g, incomingEnriched);
      if (!Object.prototype.hasOwnProperty.call(METADATA_QUALITY_RANK, incomingQuality)) {
        incomingQuality = 'skeleton_fallback';
      }

      if (
        incomingEnriched &&
        existingEnrichedObj?.xboxDeliveryHints &&
        !incomingEnriched.xboxDeliveryHints
      ) {
        incomingEnriched.xboxDeliveryHints = existingEnrichedObj.xboxDeliveryHints;
      }
      if (incomingEnriched && existingEnrichedObj) {
        carryForwardVaultRequirements(incomingEnriched, existingEnrichedObj);
        carryForwardVaultCriticAndReviewFields(incomingEnriched, existingEnrichedObj);
      }

      const rawIncomingEnrichedJson = incomingEnriched ? JSON.stringify(incomingEnriched) : null;

      let keepExistingEnriched = false;
      let finalQuality = incomingQuality;
      let finalEnrichedAt = rawIncomingEnrichedJson ? nowTs : 0;

      if (existing && existing.enriched_json) {
        let existingQuality = String(existing.metadata_quality || 'skeleton_fallback');
        if (existingIsSlimmed) {
          existingQuality = 'skeleton_fallback';
        } else if (
          existingQuality === 'authoritative' &&
          existingEnrichedObj &&
          ((!(Number(existingEnrichedObj.appId) > 0) &&
            (gameId.startsWith('steam-') || hasXboxPlatform(g))) ||
            existingEnrichedObj.enrichedSource === 'xbox' ||
            existingEnrichedObj.metadataQuality === 'storefront_native')
        ) {
          existingQuality = 'storefront_native';
        }

        const existingRank = METADATA_QUALITY_RANK[existingQuality] ?? 0;
        const incomingRank = METADATA_QUALITY_RANK[incomingQuality] ?? 0;
        if (incomingIsSlimmed && existingEnrichedObj && !existingIsSlimmed) {
          keepExistingEnriched = true;
          finalQuality = existingQuality;
          finalEnrichedAt = Number(existing.enriched_at || nowTs);
        } else if (!rawIncomingEnrichedJson || existingRank > incomingRank) {
          keepExistingEnriched = true;
          finalQuality = existingQuality;
          finalEnrichedAt = Number(existing.enriched_at || nowTs);
        } else if (existingIsSlimmed && !incomingIsSlimmed && incomingRank === 0) {
          keepExistingEnriched = true;
          finalQuality = existingQuality;
          finalEnrichedAt = Number(existing.enriched_at || nowTs);
        } else if (rawIncomingEnrichedJson === existingEnrichedStr) {
          keepExistingEnriched = true;
          finalEnrichedAt = Number(existing.enriched_at || nowTs);
        }
      }

      const archivedByRotation = g.archivedBySubscriptionRotation === true ? 1 : 0;

      // Hard Invariant 1 (1c42634): Cold-boot diff-skip prevents post-sync WAL write storms
      let isRowUnchanged = false;
      if (existing) {
        const existingPlatformsStr =
          existing.platforms_json !== null && existing.platforms_json !== undefined
            ? decompressVaultJsonString(existing.platforms_json)
            : null;
        const effectivePlatformsStr =
          rawPlatformsJson !== null ? rawPlatformsJson : existingPlatformsStr;
        const incomingTitle = String(g.title || '');
        const effectiveTitle =
          incomingTitle !== '' ? incomingTitle : String(existing.canonical_title || '');
        const effectiveEnrichedStr = keepExistingEnriched
          ? existingEnrichedStr
          : rawIncomingEnrichedJson;

        isRowUnchanged =
          effectiveTitle === String(existing.canonical_title || '') &&
          (steamAppId ?? null) === (existing.steam_app_id ?? null) &&
          isInstalled === Number(existing.is_installed || 0) &&
          isFavorited === Number(existing.is_favorited || 0) &&
          archivedByRotation === Number(existing.archived_by_subscription_rotation || 0) &&
          finalQuality === String(existing.metadata_quality || 'skeleton_fallback') &&
          rawSummaryJson === existingSummaryStr &&
          effectivePlatformsStr === existingPlatformsStr &&
          effectiveEnrichedStr === existingEnrichedStr;
      }

      if (isRowUnchanged) {
        skipped++;
      } else {
        const summaryJson = compressVaultJson(rawSummaryJson);
        const platformsJson = rawPlatformsJson ? compressVaultJson(rawPlatformsJson) : null;
        const finalEnrichedJson = keepExistingEnriched
          ? compressVaultJson(existing.enriched_json)
          : rawIncomingEnrichedJson
            ? compressVaultJson(rawIncomingEnrichedJson)
            : null;

        upsertStmt.run(
          gameId,
          String(g.title || ''),
          steamAppId,
          isInstalled,
          isFavorited,
          archivedByRotation,
          platformsJson,
          summaryJson,
          finalEnrichedJson,
          finalQuality,
          nowTs,
          finalEnrichedAt
        );
        upserted++;
      }

      const activeEnriched = keepExistingEnriched ? existingEnrichedObj : incomingEnriched;
      const coverCandidate = g.capsuleImage || activeEnriched?.capsuleImage;
      const headerCandidate = g.headerImage || activeEnriched?.headerImage;
      const iconCandidate = g.iconUrl || activeEnriched?.iconUrl;
      const isHighPriorityDetailTier =
        isInstalled === 1 ||
        g.isPinned === true ||
        service.isP1DetailGame(gameId) ||
        (isFavorited === 1 && service.p1RecentDetailGames.size < MAX_P1_RECENT_DETAIL_GAMES);

      if (typeof coverCandidate === 'string') {
        registerGameMediaCandidate(
          service,
          gameId,
          'cover',
          0,
          coverCandidate,
          nowTs,
          true,
          deferredBlobDiskChecks
        );
      }
      if (typeof headerCandidate === 'string') {
        registerGameMediaCandidate(
          service,
          gameId,
          'header',
          0,
          headerCandidate,
          nowTs,
          isHighPriorityDetailTier,
          deferredBlobDiskChecks
        );
      }
      if (typeof iconCandidate === 'string') {
        registerGameMediaCandidate(
          service,
          gameId,
          'icon',
          0,
          iconCandidate,
          nowTs,
          true,
          deferredBlobDiskChecks
        );
      }
      if (activeEnriched && Array.isArray(activeEnriched.screenshots)) {
        const maxShots = isInstalled === 1 || g.isPinned === true ? 6 : 4;
        activeEnriched.screenshots.slice(0, maxShots).forEach((/** @type {any} */ shot, /** @type {number} */ idx) => {
          const thumbUrl =
            typeof shot === 'string' ? shot : shot?.pathThumbnail || shot?.pathFull || '';
          if (thumbUrl) {
            registerGameMediaCandidate(
              service,
              gameId,
              'screenshot_thumb',
              idx,
              thumbUrl,
              nowTs,
              isHighPriorityDetailTier,
              deferredBlobDiskChecks
            );
          }
        });
      }
    }
    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return {
      success: false,
      error: txErr instanceof Error ? txErr.message : String(txErr),
    };
  } finally {
    service.txDepth = Math.max(0, (service.txDepth || 1) - 1);
  }

  // Perform any rare disk-missing blob checks strictly OUTSIDE the SQLite write transaction!
  reconcileDeferredBlobDiskChecks(service, deferredBlobDiskChecks);

  return { success: true, upserted, skipped };
}

/**
 * Deletes orphaned or rekeyed game rows from `vault_games`, `game_media_assets`, and
 * `url_resolution_cache` inside a single transaction while keeping `media_blobs` intact.
 *
 * @param {any} service
 * @param {string[] | { gameIds?: string[] } | string} gameIdsInput
 */
function deleteGames(service, gameIdsInput) {
  const rawList = Array.isArray(gameIdsInput)
    ? gameIdsInput
    : gameIdsInput && typeof gameIdsInput === 'object' && Array.isArray(gameIdsInput.gameIds)
      ? gameIdsInput.gameIds
      : typeof gameIdsInput === 'string'
        ? [gameIdsInput]
        : [];

  /** @type {string[]} */
  const safeIds = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const rawId of rawList) {
    const safe = normalizeSafeVaultGameId(rawId);
    if (safe && !seen.has(safe)) {
      seen.add(safe);
      safeIds.push(safe);
    }
  }

  if (safeIds.length === 0) {
    return { success: true, deleted: 0 };
  }

  const db = service.ensureOpen();
  const deleteAssetsStmt = service.stmt(
    'games.deleteAssetsByGameId',
    'DELETE FROM game_media_assets WHERE game_id = ?'
  );
  const deleteUrlCacheStmt = service.stmt(
    'games.deleteUrlCacheByGameId',
    'DELETE FROM url_resolution_cache WHERE game_id = ?'
  );
  const deleteGameStmt = service.stmt(
    'games.deleteByGameId',
    'DELETE FROM vault_games WHERE game_id = ?'
  );
  let deleted = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of safeIds) {
      deleteAssetsStmt.run(id);
      deleteUrlCacheStmt.run(id);
      const res = deleteGameStmt.run(id);
      if (res && res.changes > 0) {
        deleted += Number(res.changes);
      }
      service.p1RecentDetailGames.delete(id);
    }
    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return {
      success: false,
      error: txErr instanceof Error ? txErr.message : String(txErr),
    };
  }

  return { success: true, deleted };
}

/**
 * Invalidates stale federated and superseded cover/header media rows and reconciles `critic_json`
 * when a user metadata/artwork/review override is saved.
 *
 * @param {any} service
 * @param {string} gameId
 * @param {Record<string, any>} [record]
 * @param {string[]} [extraKeys]
 */
function saveUserOverride(service, gameId, record = {}, extraKeys = []) {
  const primaryGameId = normalizeSafeVaultGameId(gameId);
  if (!primaryGameId) {
    return { success: false, invalidated: 0 };
  }

  /** @type {Set<string>} */
  const candidateIds = new Set();
  collectVaultGameIdVariants(candidateIds, primaryGameId);
  if (record && typeof record === 'object') {
    collectVaultGameIdVariants(candidateIds, record.gameId);
    if (record.platformId && record.platformGameId) {
      collectVaultGameIdVariants(
        candidateIds,
        `${String(record.platformId).trim()}:${String(record.platformGameId).trim()}`
      );
    }
    const rawSid = record.steamAppId;
    const numSid =
      typeof rawSid === 'number' && rawSid > 0
        ? rawSid
        : typeof rawSid === 'string' && /^\d+$/.test(rawSid.trim())
          ? parseInt(rawSid.trim(), 10)
          : 0;
    if (numSid > 0) {
      collectVaultGameIdVariants(candidateIds, `steam-${numSid}`);
    }
    if (Array.isArray(record.purgeKeys)) {
      for (const pk of record.purgeKeys) {
        collectVaultGameIdVariants(candidateIds, pk);
      }
    }
  }
  if (Array.isArray(extraKeys)) {
    for (const ek of extraKeys) {
      collectVaultGameIdVariants(candidateIds, ek);
    }
  }

  const nextCoverUrl =
    typeof record?.coverUrl === 'string' && record.coverUrl.trim()
      ? record.coverUrl.trim()
      : typeof record?.capsuleImage === 'string' && record.capsuleImage.trim()
        ? record.capsuleImage.trim()
        : '';
  const nextHeaderUrl =
    typeof record?.heroUrl === 'string' && record.heroUrl.trim()
      ? record.heroUrl.trim()
      : typeof record?.headerUrl === 'string' && record.headerUrl.trim()
        ? record.headerUrl.trim()
        : typeof record?.headerImage === 'string' && record.headerImage.trim()
          ? record.headerImage.trim()
          : '';

  const nextCoverNorm = nextCoverUrl ? normalizeAssetIdentityUrl(nextCoverUrl) : '';
  const nextHeaderNorm = nextHeaderUrl ? normalizeAssetIdentityUrl(nextHeaderUrl) : '';

  const hasReviewRoute = Boolean(
    record &&
      typeof record === 'object' &&
      record.reviewRoute &&
      typeof record.reviewRoute === 'object'
  );
  const reviewRouteMode = hasReviewRoute
    ? String(record.reviewRoute.mode || '').trim().toLowerCase()
    : '';
  const hasExplicitReviewScoreProp = Boolean(
    record &&
      typeof record === 'object' &&
      Object.prototype.hasOwnProperty.call(record, 'reviewScoreOverride') &&
      record.reviewScoreOverride !== undefined
  );
  const explicitReviewScore =
    hasExplicitReviewScoreProp &&
    record.reviewScoreOverride &&
    typeof record.reviewScoreOverride === 'object' &&
    !Array.isArray(record.reviewScoreOverride) &&
    typeof record.reviewScoreOverride.score === 'number' &&
    Number.isFinite(record.reviewScoreOverride.score) &&
    record.reviewScoreOverride.score > 0
      ? record.reviewScoreOverride
      : null;

  /** @type {'none' | 'clear' | 'write'} */
  let criticUpdateMode = 'none';
  /** @type {string | null} */
  let nextCriticJson = null;
  if (
    reviewRouteMode === 'unrated' ||
    (hasExplicitReviewScoreProp && record.reviewScoreOverride === null)
  ) {
    criticUpdateMode = 'clear';
  } else if (explicitReviewScore) {
    criticUpdateMode = 'write';
    nextCriticJson = compressVaultJson(JSON.stringify(explicitReviewScore));
  } else if (hasReviewRoute) {
    criticUpdateMode = 'clear';
  }

  const db = service.ensureOpen();
  const nowTs = service.now();
  const selectRowsStmt = service.stmt(
    'override.selectAssetsByGame',
    'SELECT url_key, game_id, asset_role, source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE game_id = ?'
  );
  const resetFederatedOnlyStmt = service.stmt(
    'override.resetFederatedByKey',
    `
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE url_key = ?
    `
  );
  const resetFullRowStmt = service.stmt(
    'override.resetFullByKey',
    `
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          blob_sha256 = NULL,
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE url_key = ?
    `
  );
  const resetHydratedStmt = service.stmt(
    'games.resetMediaHydratedAt',
    'UPDATE vault_games SET media_hydrated_at = 0 WHERE game_id = ?'
  );
  const clearCriticStmt =
    criticUpdateMode === 'clear'
      ? service.stmt(
          'override.clearCriticByGame',
          'UPDATE vault_games SET critic_json = NULL, updated_at = ? WHERE game_id = ?'
        )
      : null;
  const writeCriticStmt =
    criticUpdateMode === 'write'
      ? service.stmt(
          'override.writeCriticByGame',
          'UPDATE vault_games SET critic_json = ?, updated_at = ? WHERE game_id = ?'
        )
      : null;
  const clearUrlCache404Stmt = service.stmt(
    'override.clearUrlCache404ByGame',
    'DELETE FROM url_resolution_cache WHERE game_id = ? AND blob_sha256 IS NULL'
  );
  const clearExactUrlCache404Stmt = service.stmt(
    'override.clearUrlCache404ByNorm',
    'DELETE FROM url_resolution_cache WHERE norm_url = ? AND blob_sha256 IS NULL'
  );

  let invalidated = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (nextCoverNorm) {
      clearExactUrlCache404Stmt.run(nextCoverNorm);
    }
    if (nextHeaderNorm) {
      clearExactUrlCache404Stmt.run(nextHeaderNorm);
    }
    for (const cid of candidateIds) {
      clearUrlCache404Stmt.run(cid);
      const rows = selectRowsStmt.all(cid);
      let touchedGame = false;
      for (const row of rows) {
        if (!row || !row.url_key) continue;
        const role = String(row.asset_role || '').toLowerCase();
        const isCoverRole = role === 'cover' || role === 'capsule';
        const isHeaderRole = role === 'header' || role === 'hero';

        if (isCoverRole || isHeaderRole) {
          const expectedNorm = isCoverRole ? nextCoverNorm : nextHeaderNorm;
          const rowNorm = row.source_url ? normalizeAssetIdentityUrl(row.source_url) : '';
          const keepMatchingBlob =
            cid === primaryGameId &&
            row.storage_kind === 'blob' &&
            Boolean(row.blob_sha256) &&
            Boolean(expectedNorm) &&
            rowNorm === expectedNorm;
          if (!keepMatchingBlob) {
            resetFullRowStmt.run(row.url_key);
            invalidated++;
            touchedGame = true;
          }
        } else if (row.storage_kind === 'federated') {
          resetFederatedOnlyStmt.run(row.url_key);
          invalidated++;
          touchedGame = true;
        }
      }
      if (touchedGame) {
        resetHydratedStmt.run(cid);
      }
      if (clearCriticStmt) {
        clearCriticStmt.run(nowTs, cid);
      } else if (writeCriticStmt) {
        writeCriticStmt.run(nextCriticJson, nowTs, cid);
      }
    }
    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    diagLog.debug('offlineVault.saveUserOverride', txErr);
    return { success: false, invalidated: 0 };
  }

  return { success: true, invalidated };
}

/**
 * Invalidates federated and cover/header media rows and clears persisted `vault_games.critic_json`
 * when a user override is removed/reset.
 *
 * @param {any} service
 * @param {string} gameId
 * @param {string[]} [extraKeys]
 */
function removeUserOverride(service, gameId, extraKeys = []) {
  /** @type {Set<string>} */
  const candidateIds = new Set();
  /** @param {unknown} rawKey */
  const collectWithNumericSteamVariant = (rawKey) => {
    collectVaultGameIdVariants(candidateIds, rawKey);
    const trimmed =
      typeof rawKey === 'string'
        ? rawKey.trim()
        : typeof rawKey === 'number' && Number.isInteger(rawKey) && rawKey > 0
          ? String(rawKey)
          : '';
    if (/^\d+$/.test(trimmed)) {
      collectVaultGameIdVariants(candidateIds, `steam-${trimmed}`);
    }
  };
  collectWithNumericSteamVariant(gameId);
  if (Array.isArray(extraKeys)) {
    for (const ek of extraKeys) {
      collectWithNumericSteamVariant(ek);
    }
  }
  if (candidateIds.size === 0) {
    return { success: false, invalidated: 0 };
  }

  const db = service.ensureOpen();
  const nowTs = service.now();
  const resetCoverHeaderStmt = service.stmt(
    'override.removeResetCoverHeader',
    `
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          blob_sha256 = NULL,
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE game_id = ?
        AND asset_role IN ('cover', 'capsule', 'header', 'hero')
    `
  );
  const resetFederatedStmt = service.stmt(
    'override.removeResetFederated',
    `
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE game_id = ?
        AND storage_kind = 'federated'
    `
  );
  const resetHydratedAndCriticStmt = service.stmt(
    'override.removeResetGame',
    'UPDATE vault_games SET media_hydrated_at = 0, critic_json = NULL, updated_at = ? WHERE game_id = ?'
  );
  const clearUrlCache404Stmt = service.stmt(
    'override.clearUrlCache404ByGame',
    'DELETE FROM url_resolution_cache WHERE game_id = ? AND blob_sha256 IS NULL'
  );

  let invalidated = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const cid of candidateIds) {
      clearUrlCache404Stmt.run(cid);
      const r1 = resetCoverHeaderStmt.run(cid);
      const r2 = resetFederatedStmt.run(cid);
      const changes = Number(r1?.changes || 0) + Number(r2?.changes || 0);
      if (changes > 0) {
        invalidated += changes;
      }
      resetHydratedAndCriticStmt.run(nowTs, cid);
    }
    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    diagLog.debug('offlineVault.removeUserOverride', txErr);
    return { success: false, invalidated: 0 };
  }

  return { success: true, invalidated };
}

/**
 * @param {any} service
 * @param {string[]} [gameIds]
 */
function archiveSubscriptionRotatedGames(service, gameIds = []) {
  if (!Array.isArray(gameIds) || gameIds.length === 0) {
    return { success: true, archived: 0 };
  }
  const db = service.ensureOpen();
  const nowTs = service.now();
  const stmt = service.stmt(
    'games.archiveRotated',
    'UPDATE vault_games SET archived_by_subscription_rotation = 1, updated_at = ? WHERE game_id = ?'
  );
  let archived = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rawId of gameIds) {
      const cleanId = String(rawId || '').trim();
      if (!cleanId) continue;
      const res = stmt.run(nowTs, cleanId);
      if (res && res.changes > 0) archived += Number(res.changes);
    }
    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return {
      success: false,
      error: txErr instanceof Error ? txErr.message : String(txErr),
    };
  }
  return { success: true, archived };
}

/**
 * Persists game detail fields + registers static media candidates inside a SINGLE transaction
 * (`BEGIN IMMEDIATE ... COMMIT`, or `SAVEPOINT save_game_detail` when nested inside an active tx).
 *
 * @param {any} service
 * @param {Record<string, any>} [payload]
 */
function saveGameDetail(service, payload = {}) {
  if (!payload || typeof payload !== 'object' || !payload.gameId) {
    return { success: false, error: 'Missing gameId' };
  }
  const gameId = String(payload.gameId).trim();
  if (!gameId) {
    return { success: false, error: 'Empty gameId' };
  }

  const db = service.ensureOpen();
  const nowTs = service.now();
  const nestedTx = (service.txDepth || 0) > 0;
  const savepointName = 'save_game_detail';
  /** @type {Array<{ urlKey: string, sha256: string, cleanUrl: string, nowTs: number, isCoverRole: boolean }>} */
  const deferredBlobDiskChecks = [];

  if (nestedTx) {
    db.exec(`SAVEPOINT ${savepointName}`);
  } else {
    db.exec('BEGIN IMMEDIATE');
  }
  service.txDepth = (service.txDepth || 0) + 1;

  try {
    const existing = service
      .stmt(
        'games.selectDetailForSave',
        `
        SELECT canonical_title, steam_app_id, is_installed, is_favorited,
               archived_by_subscription_rotation,
               enriched_json, achievements_json, hltb_json, critic_json,
               metadata_quality, enriched_at
        FROM vault_games
        WHERE game_id = ?
      `
      )
      .get(gameId);

    const incomingEnrichedObj =
      payload.enrichedMetadata && typeof payload.enrichedMetadata === 'object'
        ? { ...payload.enrichedMetadata }
        : null;

    const existingEnrichedObj =
      existing && existing.enriched_json ? parseVaultJson(existing.enriched_json) : null;
    const incomingIsSlimmed = Boolean(
      incomingEnrichedObj?.__quotaSlimmed || incomingEnrichedObj?.__digestOnly
    );
    const existingIsSlimmed = Boolean(
      existingEnrichedObj?.__quotaSlimmed || existingEnrichedObj?.__digestOnly
    );

    if (
      incomingEnrichedObj &&
      existingEnrichedObj?.xboxDeliveryHints &&
      !incomingEnrichedObj.xboxDeliveryHints
    ) {
      incomingEnrichedObj.xboxDeliveryHints = existingEnrichedObj.xboxDeliveryHints;
    }
    if (incomingEnrichedObj && existingEnrichedObj) {
      carryForwardVaultRequirements(incomingEnrichedObj, existingEnrichedObj);
      carryForwardVaultCriticAndReviewFields(incomingEnrichedObj, existingEnrichedObj);
    }

    const incomingEnrichedJson = incomingEnrichedObj
      ? compressVaultJson(JSON.stringify(incomingEnrichedObj))
      : null;

    let incomingQuality = incomingEnrichedObj
      ? inferVaultMetadataQuality(
          { id: gameId, metadataQuality: payload.metadataQuality },
          incomingEnrichedObj
        )
      : String(payload.metadataQuality || existing?.metadata_quality || 'skeleton_fallback');
    if (!Object.prototype.hasOwnProperty.call(METADATA_QUALITY_RANK, incomingQuality)) {
      incomingQuality = 'skeleton_fallback';
    }

    let finalEnrichedJson = incomingEnrichedJson;
    let finalQuality = incomingQuality;
    let finalEnrichedAt =
      typeof payload.enrichedAt === 'number' && payload.enrichedAt > 0 ? payload.enrichedAt : nowTs;

    if (existing && existing.enriched_json) {
      let existingQuality = String(existing.metadata_quality || 'skeleton_fallback');
      if (existingIsSlimmed) {
        existingQuality = 'skeleton_fallback';
      } else if (
        existingQuality === 'authoritative' &&
        existingEnrichedObj &&
        ((!(Number(existingEnrichedObj.appId) > 0) &&
          (gameId.startsWith('steam-') || /^xbox[-_]/i.test(gameId))) ||
          existingEnrichedObj.enrichedSource === 'xbox' ||
          existingEnrichedObj.metadataQuality === 'storefront_native')
      ) {
        existingQuality = 'storefront_native';
      }

      const existingRank = METADATA_QUALITY_RANK[existingQuality] ?? 0;
      const incomingRank = METADATA_QUALITY_RANK[incomingQuality] ?? 0;
      if (incomingIsSlimmed && existingEnrichedObj && !existingIsSlimmed) {
        finalEnrichedJson = compressVaultJson(existing.enriched_json);
        finalQuality = existingQuality;
        finalEnrichedAt = Number(existing.enriched_at || finalEnrichedAt);
      } else if (!incomingEnrichedJson || existingRank > incomingRank) {
        finalEnrichedJson = compressVaultJson(existing.enriched_json);
        finalQuality = existingQuality;
        finalEnrichedAt = Number(existing.enriched_at || finalEnrichedAt);
      } else if (existingIsSlimmed && !incomingIsSlimmed && incomingRank === 0) {
        finalEnrichedJson = compressVaultJson(existing.enriched_json);
        finalQuality = existingQuality;
        finalEnrichedAt = Number(existing.enriched_at || finalEnrichedAt);
      }
    }

    const finalAchievementsJson =
      payload.achievements !== undefined && payload.achievements !== null
        ? compressVaultJson(JSON.stringify(payload.achievements))
        : existing?.achievements_json
          ? compressVaultJson(existing.achievements_json)
          : null;
    const finalHltbJson =
      payload.hltb !== undefined && payload.hltb !== null
        ? compressVaultJson(JSON.stringify(payload.hltb))
        : existing?.hltb_json
          ? compressVaultJson(existing.hltb_json)
          : null;
    let finalCriticJson = existing?.critic_json ? compressVaultJson(existing.critic_json) : null;
    if (payload.clearCriticScore === true) {
      finalCriticJson = null;
    } else if (payload.criticScore === null && payload.forceCriticScore === true) {
      finalCriticJson = null;
    } else if (payload.criticScore !== undefined && payload.criticScore !== null) {
      if (payload.forceCriticScore === true) {
        finalCriticJson = compressVaultJson(JSON.stringify(payload.criticScore));
      } else {
        const existingCriticObj =
          existing && existing.critic_json ? parseVaultJson(existing.critic_json) : null;
        const existingCriticRank = getCriticAuthorityRank(existingCriticObj);
        const incomingCriticRank = getCriticAuthorityRank(payload.criticScore);
        if (existingCriticRank === 0 || incomingCriticRank >= existingCriticRank) {
          finalCriticJson = compressVaultJson(JSON.stringify(payload.criticScore));
        }
      }
    }

    const canonicalTitle =
      typeof payload.canonicalTitle === 'string' && payload.canonicalTitle.trim()
        ? payload.canonicalTitle.trim()
        : typeof incomingEnrichedObj?.name === 'string' && incomingEnrichedObj.name.trim()
          ? incomingEnrichedObj.name.trim()
          : existing?.canonical_title || '';

    const steamAppId =
      typeof payload.steamAppId === 'number' && payload.steamAppId > 0
        ? payload.steamAppId
        : existing?.steam_app_id ?? null;

    const isInstalled =
      typeof payload.isInstalled === 'boolean'
        ? payload.isInstalled
          ? 1
          : 0
        : existing?.is_installed ?? 0;
    const isFavorited =
      typeof payload.isFavorited === 'boolean'
        ? payload.isFavorited
          ? 1
          : 0
        : existing?.is_favorited ?? 0;
    const archivedByRotation =
      typeof payload.archivedBySubscriptionRotation === 'boolean'
        ? payload.archivedBySubscriptionRotation
          ? 1
          : 0
        : Number(existing?.archived_by_subscription_rotation || 0);

    service
      .stmt(
        'games.upsertDetail',
        `
        INSERT INTO vault_games (
          game_id, canonical_title, steam_app_id, is_installed, is_favorited,
          archived_by_subscription_rotation,
          enriched_json, achievements_json, hltb_json, critic_json,
          metadata_quality, updated_at, enriched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
          canonical_title = CASE WHEN excluded.canonical_title != '' THEN excluded.canonical_title ELSE vault_games.canonical_title END,
          steam_app_id = COALESCE(excluded.steam_app_id, vault_games.steam_app_id),
          is_installed = excluded.is_installed,
          is_favorited = excluded.is_favorited,
          archived_by_subscription_rotation = excluded.archived_by_subscription_rotation,
          enriched_json = excluded.enriched_json,
          achievements_json = excluded.achievements_json,
          hltb_json = excluded.hltb_json,
          critic_json = excluded.critic_json,
          metadata_quality = excluded.metadata_quality,
          updated_at = excluded.updated_at,
          enriched_at = excluded.enriched_at
      `
      )
      .run(
        gameId,
        canonicalTitle,
        steamAppId,
        isInstalled,
        isFavorited,
        archivedByRotation,
        finalEnrichedJson,
        finalAchievementsJson,
        finalHltbJson,
        finalCriticJson,
        finalQuality,
        nowTs,
        finalEnrichedJson ? finalEnrichedAt : 0
      );

    if (incomingEnrichedObj) {
      const isHighPriorityDetailTier =
        isInstalled === 1 ||
        payload.promoteToP1 === true ||
        service.isP1DetailGame(gameId) ||
        (isFavorited === 1 && service.p1RecentDetailGames.size < MAX_P1_RECENT_DETAIL_GAMES);

      if (typeof incomingEnrichedObj.capsuleImage === 'string') {
        registerGameMediaCandidate(
          service,
          gameId,
          'cover',
          0,
          incomingEnrichedObj.capsuleImage,
          nowTs,
          true,
          deferredBlobDiskChecks
        );
      }
      if (typeof incomingEnrichedObj.headerImage === 'string') {
        registerGameMediaCandidate(
          service,
          gameId,
          'header',
          0,
          incomingEnrichedObj.headerImage,
          nowTs,
          isHighPriorityDetailTier,
          deferredBlobDiskChecks
        );
      }
      if (Array.isArray(incomingEnrichedObj.screenshots)) {
        const maxShots = isInstalled === 1 ? 6 : 4;
        incomingEnrichedObj.screenshots.slice(0, maxShots).forEach((/** @type {any} */ shot, /** @type {number} */ idx) => {
          const thumbUrl =
            typeof shot === 'string' ? shot : shot?.pathThumbnail || shot?.pathFull || '';
          if (thumbUrl) {
            registerGameMediaCandidate(
              service,
              gameId,
              'screenshot_thumb',
              idx,
              thumbUrl,
              nowTs,
              isHighPriorityDetailTier,
              deferredBlobDiskChecks
            );
          }
        });
      }
    }

    if (nestedTx) {
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    } else {
      db.exec('COMMIT');
    }
  } catch (txErr) {
    try {
      if (nestedTx) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } else {
        db.exec('ROLLBACK');
      }
    } catch {}
    return {
      success: false,
      error: txErr instanceof Error ? txErr.message : String(txErr),
    };
  } finally {
    service.txDepth = Math.max(0, (service.txDepth || 1) - 1);
  }

  if (!nestedTx) {
    reconcileDeferredBlobDiskChecks(service, deferredBlobDiskChecks);
  }

  return { success: true };
}

/**
 * @param {any} service
 * @param {string} gameId
 * @param {number} [hydratedAt]
 */
function markGameMediaHydrated(service, gameId, hydratedAt = service.now()) {
  const cleanId = String(gameId || '').trim();
  if (!cleanId || service.isShutdown) {
    return { success: false, updated: 0 };
  }
  try {
    const db = service.db || service.ensureOpen();
    if (!db) {
      return { success: false, updated: 0 };
    }
    const ts =
      typeof hydratedAt === 'number' && Number.isFinite(hydratedAt) && hydratedAt >= 0
        ? Math.floor(hydratedAt)
        : service.now();
    const res = service
      .stmt(
        'games.markMediaHydrated',
        'UPDATE vault_games SET media_hydrated_at = ? WHERE game_id = ?'
      )
      .run(ts, cleanId);
    return {
      success: true,
      updated: Number(res?.changes || 0),
      mediaHydratedAt: ts,
    };
  } catch (err) {
    diagLog.debug('offlineVault.markGameMediaHydrated', err, { gameId: cleanId });
    return { success: false, updated: 0 };
  }
}

/**
 * @param {any} service
 * @param {string} gameId
 */
function getGameDetail(service, gameId) {
  const cleanId = String(gameId || '').trim();
  if (!cleanId) return null;
  service.ensureOpen();
  const row = service
    .stmt(
      'games.selectDetailById',
      `
        SELECT game_id, archived_by_subscription_rotation, enriched_json, achievements_json, hltb_json, critic_json, metadata_quality, enriched_at, media_hydrated_at
        FROM vault_games
        WHERE game_id = ?
      `
    )
    .get(cleanId);
  if (!row) return null;

  const enrichedMetadata = parseVaultJson(row.enriched_json);
  const achievements = parseVaultJson(row.achievements_json);
  const hltb = parseVaultJson(row.hltb_json);
  const criticScore = parseVaultJson(row.critic_json);
  const isArchivedRotation = Number(row.archived_by_subscription_rotation || 0) === 1;
  const enrichedAtNum = Number(row.enriched_at) || 0;
  const mediaHydratedAtNum = Number(row.media_hydrated_at) || 0;

  if (
    enrichedMetadata &&
    typeof enrichedMetadata === 'object' &&
    !enrichedMetadata.enrichedAt &&
    enrichedAtNum > 0
  ) {
    enrichedMetadata.enrichedAt = enrichedAtNum;
  }

  let effectiveQuality = row.metadata_quality || 'skeleton_fallback';
  if (
    enrichedMetadata &&
    typeof enrichedMetadata === 'object' &&
    !(Number(enrichedMetadata.appId) > 0) &&
    (String(row.game_id).startsWith('steam-') ||
      /^xbox[-_]/i.test(String(row.game_id)) ||
      enrichedMetadata.enrichedSource === 'xbox' ||
      enrichedMetadata.metadataQuality === 'storefront_native')
  ) {
    if (
      String(row.game_id).startsWith('steam-') ||
      !enrichedMetadata.metadataQuality ||
      enrichedMetadata.metadataQuality === 'authoritative'
    ) {
      enrichedMetadata.metadataQuality = 'storefront_native';
    }
    if (effectiveQuality === 'authoritative') {
      effectiveQuality = 'storefront_native';
    }
  }

  if (!enrichedMetadata && !achievements && !hltb && !criticScore) {
    return {
      gameId: row.game_id,
      enrichedMetadata: null,
      achievements: null,
      hltb: null,
      criticScore: null,
      metadataQuality: effectiveQuality,
      enrichedAt: enrichedAtNum,
      mediaHydratedAt: mediaHydratedAtNum,
      ...(isArchivedRotation ? { archivedBySubscriptionRotation: true } : {}),
    };
  }

  return {
    gameId: row.game_id,
    enrichedMetadata,
    achievements,
    hltb,
    criticScore,
    metadataQuality: effectiveQuality,
    enrichedAt: enrichedAtNum,
    mediaHydratedAt: mediaHydratedAtNum,
    ...(isArchivedRotation ? { archivedBySubscriptionRotation: true } : {}),
  };
}

/**
 * Returns existing `game_media_assets` candidate rows for a single game (used by
 * `MediaHydrationEngine.promoteGame`, replacing raw `this.vault.isAvailable && this.vault.db` access).
 *
 * @param {any} service
 * @param {string} gameId
 * @returns {Array<{ role: string, ordinal: number, url: string }>}
 */
function getGameMediaAssetCandidates(service, gameId) {
  const cleanId = String(gameId || '').trim();
  if (!cleanId || service.isShutdown) return [];
  try {
    service.ensureOpen();
    const rows = service
      .stmt(
        'media.selectPromoteCandidatesByGame',
        `SELECT asset_role, ordinal, source_url FROM game_media_assets
         WHERE game_id = ? AND source_url IS NOT NULL AND source_url != ''
         ORDER BY asset_role ASC, ordinal ASC`
      )
      .all(cleanId);
    /** @type {Array<{ role: string, ordinal: number, url: string }>} */
    const out = [];
    for (const r of rows) {
      if (!r || !r.source_url) continue;
      out.push({
        role: String(r.asset_role || 'cover'),
        ordinal: Number(r.ordinal) || 0,
        url: String(r.source_url),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Batched SQL hydration-state query for `MediaHydrationEngine.queueHydration`:
 * returns lightweight per-game flags + `(game_id, role, ordinal, blob_hash, backoff_until, ...)`
 * from `game_media_assets` and `url_resolution_cache` in chunked `IN (...)` queries WITHOUT
 * decompressing `achievements_json`, `hltb_json`, or `critic_json`!
 *
 * @param {any} service
 * @param {string[]} gameIds
 * @param {string[]} [candidateNormUrls]
 */
function getGamesMediaHydrationState(service, gameIds, candidateNormUrls = []) {
  /** @type {Map<string, any>} */
  const gameMetaById = new Map();
  /** @type {Map<string, Array<{ urlKey: string, gameId: string, role: string, ordinal: number, sourceUrl: string, storageKind: string, blobHash: string | null, federatedPath: string | null, failureCount: number, backoffUntil: number }>>} */
  const assetsByGameId = new Map();
  /** @type {Map<string, { blobHash: string | null, failureCount: number, backoffUntil: number }>} */
  const urlCacheByNormUrl = new Map();

  if (service.isShutdown || !Array.isArray(gameIds) || gameIds.length === 0) {
    return { gameMetaById, assetsByGameId, urlCacheByNormUrl };
  }

  const db = service.ensureOpen();
  const uniqueIds = Array.from(
    new Set(gameIds.map((id) => String(id || '').trim()).filter(Boolean))
  );

  const CHUNK_SIZE = 400;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');

    // 1. Lightweight game metadata (skipping achievements_json, hltb_json, critic_json completely!)
    const gameRows = db
      .prepare(
        `
        SELECT game_id, canonical_title, steam_app_id, is_installed, is_favorited,
               metadata_quality, media_hydrated_at, enriched_json
        FROM vault_games
        WHERE game_id IN (${placeholders})
      `
      )
      .all(...chunk);

    for (const row of gameRows) {
      if (!row || !row.game_id) continue;
      const gid = String(row.game_id);
      const enriched = row.enriched_json ? parseVaultJson(row.enriched_json) : null;
      gameMetaById.set(gid, {
        gameId: gid,
        canonicalTitle: String(row.canonical_title || ''),
        steamAppId: row.steam_app_id ?? null,
        isInstalled: Number(row.is_installed || 0) === 1,
        isFavorited: Number(row.is_favorited || 0) === 1,
        metadataQuality: String(row.metadata_quality || 'skeleton_fallback'),
        mediaHydratedAt: Number(row.media_hydrated_at || 0),
        enrichedMetadata: enriched,
      });
    }

    // 2. Single batched query returning `(game_id, role, ordinal, blob_hash, backoff_until, ...)`
    const assetRows = db
      .prepare(
        `
        SELECT url_key, game_id, asset_role AS role, ordinal, source_url,
               storage_kind, blob_sha256 AS blob_hash, federated_path,
               failure_count, next_retry_at AS backoff_until
        FROM game_media_assets
        WHERE game_id IN (${placeholders})
      `
      )
      .all(...chunk);

    for (const r of assetRows) {
      if (!r || !r.game_id) continue;
      const gid = String(r.game_id);
      let list = assetsByGameId.get(gid);
      if (!list) {
        list = [];
        assetsByGameId.set(gid, list);
      }
      list.push({
        urlKey: String(r.url_key || ''),
        gameId: gid,
        role: String(r.role || 'cover'),
        ordinal: Number(r.ordinal || 0),
        sourceUrl: String(r.source_url || ''),
        storageKind: String(r.storage_kind || 'pending'),
        blobHash: r.blob_hash ? String(r.blob_hash) : null,
        federatedPath: r.federated_path ? String(r.federated_path) : null,
        failureCount: Number(r.failure_count || 0),
        backoffUntil: Number(r.backoff_until || 0),
      });
    }

    // 3. Per-game entries in `url_resolution_cache`
    const gameUrlCacheRows = db
      .prepare(
        `
        SELECT norm_url, blob_sha256 AS blob_hash, failure_count, next_retry_at AS backoff_until
        FROM url_resolution_cache
        WHERE game_id IN (${placeholders})
      `
      )
      .all(...chunk);

    for (const r of gameUrlCacheRows) {
      if (!r || !r.norm_url) continue;
      urlCacheByNormUrl.set(String(r.norm_url), {
        blobHash: r.blob_hash ? String(r.blob_hash) : null,
        failureCount: Number(r.failure_count || 0),
        backoffUntil: Number(r.backoff_until || 0),
      });
    }
  }

  // 4. Optional additional candidate normalized URLs (e.g. shared across games or before game_id bind)
  const extraNormUrls = Array.from(
    new Set(
      (Array.isArray(candidateNormUrls) ? candidateNormUrls : [])
        .map((u) => String(u || '').trim())
        .filter((u) => u && !urlCacheByNormUrl.has(u))
    )
  );
  for (let i = 0; i < extraNormUrls.length; i += CHUNK_SIZE) {
    const chunk = extraNormUrls.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `
        SELECT norm_url, blob_sha256 AS blob_hash, failure_count, next_retry_at AS backoff_until
        FROM url_resolution_cache
        WHERE norm_url IN (${placeholders})
      `
      )
      .all(...chunk);
    for (const r of rows) {
      if (!r || !r.norm_url) continue;
      urlCacheByNormUrl.set(String(r.norm_url), {
        blobHash: r.blob_hash ? String(r.blob_hash) : null,
        failureCount: Number(r.failure_count || 0),
        backoffUntil: Number(r.backoff_until || 0),
      });
    }
  }

  return { gameMetaById, assetsByGameId, urlCacheByNormUrl };
}

/**
 * @param {any} service
 * @param {Record<string, any>} [options]
 */
function getCatalogSnapshot(service, options = {}) {
  const db = service.ensureOpen();
  const includeArchived = Boolean(options && options.includeArchived);
  const rows = service
    .stmt(
      'games.selectCatalogSnapshot',
      `
        SELECT game_id, canonical_title, steam_app_id, is_installed, is_favorited,
               archived_by_subscription_rotation, platforms_json, summary_json,
               enriched_json, achievements_json, hltb_json, critic_json,
               metadata_quality, updated_at, enriched_at, media_hydrated_at
        FROM vault_games
        ORDER BY canonical_title ASC
      `
    )
    .all();
  /** @type {any[]} */
  const games = [];
  /** @type {Record<string, any>} */
  const details = {};
  /** @type {Array<{ gameId: string, platformsJson: string | null, summaryJson: string | null }>} */
  const pendingOsRepairs = [];
  /** @type {string[]} */
  const pendingOrphanPruneIds = [];
  /** @type {string[]} */
  const pendingLauncherUtilityPurgeIds = [];

  for (const row of rows) {
    const isArchivedRotation = Number(row.archived_by_subscription_rotation || 0) === 1;
    const isRowInstalled = Number(row.is_installed || 0) === 1;

    const summary = parseVaultJson(row.summary_json) || {};
    const rawPlatforms = parseVaultJson(row.platforms_json) || summary.platforms || [];
    const enrichedMetadata = parseVaultJson(row.enriched_json);
    const hasEnrichedForOs = Boolean(
      enrichedMetadata &&
        !(enrichedMetadata.enrichedSource === 'xbox' && !(Number(enrichedMetadata.appId) > 0))
    );
    const sanitizedPlatRes = sanitizeVaultPlatformEntriesOsFlags(
      rawPlatforms,
      hasEnrichedForOs,
      buildVaultPlatformSanitizeContext(summary, enrichedMetadata)
    );
    const platforms = sanitizedPlatRes.platforms || [];
    if (
      Array.isArray(rawPlatforms) &&
      rawPlatforms.length > 0 &&
      Array.isArray(platforms) &&
      platforms.length === 0
    ) {
      if (row.game_id) {
        pendingOrphanPruneIds.push(String(row.game_id));
      }
      continue;
    }
    const rowTitle = String(summary?.title || row.canonical_title || '');
    if (!isRowInstalled && isStandaloneStorefrontLauncherUtility(rowTitle, platforms)) {
      if (!service.options?.readOnly && !options?.readOnly && row.game_id) {
        pendingLauncherUtilityPurgeIds.push(String(row.game_id));
      }
      continue;
    }
    const anyPlatCrossPlatformMac = Boolean(
      Array.isArray(platforms) &&
        platforms.some(
          (ep) =>
            ep &&
            (ep.isCrossPlatformLauncherRuntime === true ||
              Boolean(ep.platforms && ep.platforms.mac === true))
        )
    );
    const allPlatsExplicitlyNonMac = Boolean(
      Array.isArray(platforms) &&
        platforms.length > 0 &&
        platforms.every(
          (ep) =>
            ep &&
            !ep.isCrossPlatformLauncherRuntime &&
            ep.platforms &&
            typeof ep.platforms === 'object' &&
            ep.platforms.mac === false
        )
    );
    const worksOnMissingCrossPlatMac = Boolean(
      anyPlatCrossPlatformMac &&
        summary?.worksOn &&
        typeof summary.worksOn === 'object' &&
        summary.worksOn.mac === false
    );
    const worksOnPoisoned = Boolean(
      summary?.worksOn &&
        typeof summary.worksOn === 'object' &&
        ((!summary.worksOn.windows && !summary.worksOn.mac && !summary.worksOn.linux) ||
          (summary.worksOn.mac === true && allPlatsExplicitlyNonMac))
    );
    if (worksOnPoisoned) {
      summary.worksOn = {
        windows: true,
        mac: false,
        linux: Boolean(summary?.worksOn?.linux),
      };
    } else if (worksOnMissingCrossPlatMac) {
      summary.worksOn = {
        windows: summary.worksOn.windows !== false,
        mac: true,
        linux: Boolean(summary?.worksOn?.linux),
      };
    }
    if (
      Array.isArray(platforms) &&
      platforms.length === 1 &&
      platforms[0]?.chainedLauncherHandoff &&
      (summary.externalStorefrontHandoff || summary.chainedLauncherHandoff)
    ) {
      summary.chainedLauncherHandoff = platforms[0].chainedLauncherHandoff;
      summary.externalStorefrontHandoff = platforms[0].externalStorefrontHandoff;
    }
    if (
      (sanitizedPlatRes.repaired || worksOnPoisoned || worksOnMissingCrossPlatMac) &&
      row.game_id
    ) {
      const nextPlatsJson = compressVaultJson(JSON.stringify(platforms));
      const nextSummary = { ...summary, platforms };
      const nextSummaryJson = compressVaultJson(JSON.stringify(nextSummary));
      pendingOsRepairs.push({
        gameId: String(row.game_id),
        platformsJson: nextPlatsJson,
        summaryJson: nextSummaryJson,
      });
    }

    if (isArchivedRotation && !isRowInstalled && !includeArchived) {
      continue;
    }

    const achievements = parseVaultJson(row.achievements_json);
    const hltb = parseVaultJson(row.hltb_json);
    const criticScore = parseVaultJson(row.critic_json);
    const enrichedAtNum = Number(row.enriched_at) || 0;
    const mediaHydratedAtNum = Number(row.media_hydrated_at) || 0;

    if (
      enrichedMetadata &&
      typeof enrichedMetadata === 'object' &&
      !enrichedMetadata.enrichedAt &&
      enrichedAtNum > 0
    ) {
      enrichedMetadata.enrichedAt = enrichedAtNum;
    }

    let effectiveQuality = row.metadata_quality || 'skeleton_fallback';
    if (
      enrichedMetadata &&
      typeof enrichedMetadata === 'object' &&
      !(Number(enrichedMetadata.appId) > 0) &&
      (String(row.game_id).startsWith('steam-') ||
        /^xbox[-_]/i.test(String(row.game_id)) ||
        hasXboxPlatform({ id: row.game_id, ...summary, platforms }) ||
        enrichedMetadata.enrichedSource === 'xbox' ||
        enrichedMetadata.metadataQuality === 'storefront_native')
    ) {
      if (
        String(row.game_id).startsWith('steam-') ||
        !enrichedMetadata.metadataQuality ||
        enrichedMetadata.metadataQuality === 'authoritative'
      ) {
        enrichedMetadata.metadataQuality = 'storefront_native';
      }
      if (effectiveQuality === 'authoritative') {
        effectiveQuality = 'storefront_native';
      }
    }

    if (summary && (summary.id || row.game_id)) {
      const effectiveGameId = String(summary.id || row.game_id || '');
      const hasSteamEntitlement =
        Boolean(summary.steamAppId) ||
        effectiveGameId.startsWith('steam-') ||
        (Array.isArray(platforms) &&
          platforms.some((p) => p && String(p.platformId || '').toLowerCase() === 'steam'));
      const gameObj = {
        ...summary,
        id: effectiveGameId,
        title: summary.title || row.canonical_title || row.game_id,
        sortTitle:
          summary.sortTitle ||
          String(summary.title || row.canonical_title || row.game_id).replace(
            /^(The|A|An)\s+/i,
            ''
          ),
        ...(summary.steamAppId
          ? { steamAppId: Number(summary.steamAppId) }
          : hasSteamEntitlement && row.steam_app_id
            ? { steamAppId: Number(row.steam_app_id) }
            : {}),
        ...(isArchivedRotation ? { archivedBySubscriptionRotation: true } : {}),
        platforms,
        ...(enrichedMetadata ? { enrichedMetadata } : {}),
      };
      games.push(gameObj);
    }

    if (enrichedMetadata || achievements || hltb || criticScore || mediaHydratedAtNum > 0) {
      const gameIdKey = String(row.game_id || '');
      details[gameIdKey] = {
        gameId: gameIdKey,
        enrichedMetadata,
        achievements,
        hltb,
        criticScore,
        metadataQuality: effectiveQuality,
        enrichedAt: enrichedAtNum,
        mediaHydratedAt: mediaHydratedAtNum,
        ...(isArchivedRotation ? { archivedBySubscriptionRotation: true } : {}),
      };
    }
  }

  if (
    (pendingOsRepairs.length > 0 || pendingLauncherUtilityPurgeIds.length > 0) &&
    !options?.readOnly &&
    !isDbReadOnly(service, db)
  ) {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (pendingOsRepairs.length > 0) {
          const repairStmt = service.stmt(
            'selfHeal.updateOsFlags',
            'UPDATE vault_games SET platforms_json = ?, summary_json = ? WHERE game_id = ?'
          );
          for (const rep of pendingOsRepairs) {
            repairStmt.run(rep.platformsJson, rep.summaryJson, rep.gameId);
          }
        }
        if (pendingLauncherUtilityPurgeIds.length > 0) {
          const delAssetsStmt = service.stmt(
            'games.deleteAssetsByGameId',
            'DELETE FROM game_media_assets WHERE game_id = ?'
          );
          const delUrlCacheStmt = service.stmt(
            'games.deleteUrlCacheByGameId',
            'DELETE FROM url_resolution_cache WHERE game_id = ?'
          );
          const delGameStmt = service.stmt(
            'games.deleteByGameId',
            'DELETE FROM vault_games WHERE game_id = ?'
          );
          for (const id of pendingLauncherUtilityPurgeIds) {
            delAssetsStmt.run(id);
            delUrlCacheStmt.run(id);
            delGameStmt.run(id);
          }
        }
        db.exec('COMMIT');
      } catch (txErr) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw txErr;
      }
    } catch (err) {
      diagLog.debug('offlineVault.repairHydratedCatalog', err);
    }
  }

  if (pendingOrphanPruneIds.length > 0 && !service.options?.readOnly && !options?.readOnly) {
    const idsToPrune = pendingOrphanPruneIds.slice();
    setImmediate(() => {
      try {
        if (!service.db || isDbReadOnly(service, service.db)) return;
        deleteGames(service, idsToPrune);
      } catch (err) {
        diagLog.debug('offlineVault.pruneOrphanExpiredRows', err);
      }
    });
  }

  return {
    success: true,
    games,
    details,
  };
}

module.exports = {
  registerGameMediaCandidate,
  upsertGames,
  deleteGames,
  saveUserOverride,
  removeUserOverride,
  archiveSubscriptionRotatedGames,
  saveGameDetail,
  markGameMediaHydrated,
  getGameDetail,
  getGameMediaAssetCandidates,
  getGamesMediaHydrationState,
  getCatalogSnapshot,
};
