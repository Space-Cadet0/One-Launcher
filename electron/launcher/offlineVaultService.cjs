// @ts-check
'use strict';

const fs = require('node:fs');
const {
  StorefrontLocalCacheFederator,
  validateFederatedImageFile,
} = require('./storefrontLocalCacheFederator.cjs');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

const vaultSchema = require('./vault/vaultSchemaAndLifecycle.cjs');
const vaultLattice = require('./vault/vaultMetadataLattice.cjs');
const vaultSelfHeal = require('./vault/vaultStartupSelfHeal.cjs');
const vaultGamesRepo = require('./vault/vaultGamesRepository.cjs');
const vaultBlobStore = require('./vault/vaultBlobStore.cjs');
const vaultMediaResolver = require('./vault/vaultMediaResolver.cjs');
const vaultRemoteFetcher = require('./vault/vaultRemoteMediaFetcher.cjs');

const {
  electron,
  OFFLINE_VAULT_TIER_CAPS,
  VALID_TIERS,
  MAX_P1_RECENT_DETAIL_GAMES,
  DEFAULT_STARTUP_SWEEP_DELAY_MS,
  PASS_THROUGH_MAX_BYTES,
  MAX_INLINE_ANIMATED_GIF_CACHE_BYTES,
  MAX_ASSET_FETCH_BYTES,
  ROLE_MAX_WIDTHS,
  VAULT_ZLIB_PREFIX,
  compressVaultJson,
  decompressVaultJsonString,
  parseVaultJson,
  collectVaultGameIdVariants,
  VaultStatementCache,
  resolveVaultPaths,
  getSqliteDiskBytes,
  getFreeDiskBytes,
  openVaultDatabase,
  runStartupZlibCompactionIfNeeded,
} = vaultSchema;

const {
  QUALITY_RANK,
  METADATA_QUALITY_RANK,
  computeAdaptive404DelayMs,
  isWafOrChallengeResponse,
  isRejectedVideoUrl,
  normalizeAssetIdentityUrl,
  isAnimatedGifBuffer,
  getCriticAuthorityRank,
  isTrustedEnrichedMetacritic,
  carryForwardVaultCriticAndReviewFields,
  inferVaultMetadataQuality,
  buildAssetUrlKey,
  isExplicitOverrideParam,
  normalizeVaultChainedHandoffId,
  sanitizeVaultPlatformEntry,
  sanitizeVaultPlatformEntriesOsFlags,
  isFederatedAssetRowCompatible,
} = vaultLattice;

class OfflineVaultService {
  /**
   * @param {Record<string, any>} [options]
   */
  constructor(options = {}) {
    this.options = { ...options };
    this.hasCustomFetchImpl = typeof options.fetchImpl === 'function';
    this.federator =
      options.federator instanceof StorefrontLocalCacheFederator ||
      (options.federator &&
        typeof options.federator === 'object' &&
        (typeof options.federator.resolveFederatedAsset === 'function' ||
          typeof options.federator.resolveLocalStoreAsset === 'function'))
        ? options.federator
        : new StorefrontLocalCacheFederator(options);

    /** @type {any} */
    this.db = null;
    /** @type {InstanceType<typeof VaultStatementCache> | null} */
    this.stmtCache = null;
    this.vaultDir = '';
    this.blobsDir = '';
    this.tmpDir = '';
    this.dbPath = '';

    /** @type {Set<string>} */
    this.knownBlobHashes = new Set();
    /** @type {Map<string, { ext: string, sizeBytes: number }>} */
    this.blobMetaBySha = new Map();
    this.totalBlobBytes = 0;

    /** @type {Map<string, number>} */
    this.pendingBlobAccessMap = new Map();
    /** @type {any} */
    this.accessFlushTimer = null;
    /** @type {any} */
    this.startupSweepTimer = null;
    /** @type {any} */
    this.p1FlushTimer = null;
    this.p1RecentGamesDirty = false;
    /** @type {Promise<any> | null} */
    this.activeDiskSweepPromise = null;
    this.txDepth = 0;

    /** @type {Map<string, number>} */
    this.p1RecentDetailGames = new Map();

    /** @type {Set<string>} */
    this.halfOpenProbesInFlight = new Set();
    /** @type {Map<string, any>} */
    this.inFlightMediaFetches = new Map();

    /** @type {Set<(snapshot: any) => void>} */
    this.healthListeners = new Set();
    /** @type {any} */
    this.hydrationEngine = null;

    /** @type {number | null} */
    this.cachedFreeDiskBytes = null;
    this.cachedFreeDiskAt = 0;
    /** @type {number | null} */
    this.cachedSqliteDiskBytes = null;
    this.cachedSqliteDiskAt = 0;
    this.isShutdown = false;
  }

  /**
   * Retrieves a lazy-compiled prepared statement from the active `VaultStatementCache`.
   *
   * @param {string} key
   * @param {string} sql
   */
  stmt(key, sql) {
    if (!this.stmtCache) {
      this.ensureOpen();
    }
    if (!this.stmtCache) {
      throw new Error('OfflineVaultService statement cache unavailable');
    }
    return this.stmtCache.get(key, sql);
  }

  now() {
    if (typeof this.options.nowFn === 'function') {
      return Number(this.options.nowFn());
    }
    return Date.now();
  }

  isNetworkOnline() {
    if (typeof this.options.isOnlineFn === 'function') {
      return Boolean(this.options.isOnlineFn());
    }
    if (electron.net && typeof electron.net.isOnline === 'function') {
      try {
        return Boolean(electron.net.isOnline());
      } catch {
        return true;
      }
    }
    return true;
  }

  init() {
    this.ensureOpen();
    return this;
  }

  /**
   * @param {any} engine
   */
  setHydrationEngine(engine) {
    this.hydrationEngine = engine || null;
  }

  /** @param {any} db */
  loadP1RecentGamesFromDb(db) {
    vaultMediaResolver.loadP1RecentGamesFromDb(this, db);
  }

  persistP1RecentGamesToDb() {
    vaultMediaResolver.persistP1RecentGamesToDb(this);
  }

  flushP1RecentGamesToDb() {
    vaultMediaResolver.flushP1RecentGamesToDb(this);
  }

  /** @param {string} gameId */
  recordP1DetailGame(gameId) {
    return vaultMediaResolver.recordP1DetailGame(this, gameId);
  }

  /** @param {string} gameId */
  isP1DetailGame(gameId) {
    const cleanId = String(gameId || '').trim();
    if (!cleanId) return false;
    return this.p1RecentDetailGames.has(cleanId);
  }

  /**
   * @param {string | Record<string, any>} gameIdOrPayload
   * @param {Record<string, any>} [opts]
   */
  promoteGame(gameIdOrPayload, opts = {}) {
    const rawObj =
      gameIdOrPayload && typeof gameIdOrPayload === 'object'
        ? gameIdOrPayload
        : { gameId: String(gameIdOrPayload || '') };
    const cleanId = String(rawObj.gameId || rawObj.id || '').trim();
    if (!cleanId) return { success: false, promoted: false };
    this.recordP1DetailGame(cleanId);
    if (
      !opts.fromHydrationEngine &&
      this.hydrationEngine &&
      typeof this.hydrationEngine.promoteGame === 'function'
    ) {
      return this.hydrationEngine.promoteGame(rawObj, { ...opts, fromVault: true });
    }
    return { success: true, promoted: true, gameId: cleanId };
  }

  schedulePostInitOrphanSweep() {
    if (this.options.disableAutoStartupSweep === true) return;
    if (this.startupSweepTimer) {
      try {
        clearTimeout(this.startupSweepTimer);
      } catch {}
      this.startupSweepTimer = null;
    }
    const delayMs =
      typeof this.options.startupSweepDelayMs === 'number'
        ? Math.max(0, this.options.startupSweepDelayMs)
        : DEFAULT_STARTUP_SWEEP_DELAY_MS;

    this.startupSweepTimer = setTimeout(() => {
      this.startupSweepTimer = null;
      if (!this.db || this.isShutdown) return;
      if (this.hydrationEngine?.isSuspendedInGame) return;
      this.sweepOrphanBlobsAsync({ reclaimLegacyP2NonCover: true })
        .then(() => {
          if (this.db && !this.isShutdown) {
            this.maybeEvictBlobs({ forceIfOverMax: true });
          }
        })
        .catch((sweepErr) => {
          diagLog.debug('offlineVault.postInitSweep', sweepErr);
        });
    }, delayMs);
    if (this.startupSweepTimer && typeof this.startupSweepTimer.unref === 'function') {
      this.startupSweepTimer.unref();
    }
  }

  /**
   * @param {any} [db]
   * @param {Record<string, any>} [opts]
   */
  runStartupZlibCompactionIfNeeded(db = this.db, opts = {}) {
    return runStartupZlibCompactionIfNeeded(this, db, opts);
  }

  /** @param {(snapshot: any) => void} listener */
  onHealthChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  /** @param {any} snapshot */
  emitHealthChanged(snapshot) {
    for (const listener of this.healthListeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  resolveVaultPaths() {
    return resolveVaultPaths(this.options);
  }

  ensureOpen() {
    return openVaultDatabase(this);
  }

  /**
   * @param {any} db
   * @param {{ force?: boolean }} [options]
   */
  runStartupSelfHeal(db, options = {}) {
    return vaultSelfHeal.runStartupSelfHeal(this, db, options);
  }

  getTier() {
    this.ensureOpen();
    const row = this.stmt(
      'settings.getByKey',
      'SELECT value FROM vault_settings WHERE key = ?'
    ).get('tier');
    const val = row && typeof row.value === 'string' ? row.value : 'balanced';
    return VALID_TIERS.has(val) ? val : 'balanced';
  }

  /** @param {string} tier */
  setTier(tier) {
    const cleanTier = String(tier || '').trim();
    if (!VALID_TIERS.has(cleanTier)) {
      return { success: false, error: `Invalid vault tier: ${cleanTier}` };
    }
    this.ensureOpen();
    this.stmt(
      'settings.upsert',
      'INSERT INTO vault_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run('tier', cleanTier, this.now());

    const maxBytes = OFFLINE_VAULT_TIER_CAPS[cleanTier];
    this.maybeEvictBlobs({ forceIfOverMax: true, maxBytes });
    return {
      success: true,
      stats: this.getStats(),
    };
  }

  /**
   * @param {string} sha256
   * @param {string} ext
   */
  getBlobFilePath(sha256, ext) {
    return vaultBlobStore.getBlobFilePath(this, sha256, ext);
  }

  scheduleBlobAccessFlush() {
    vaultMediaResolver.scheduleBlobAccessFlush(this);
  }

  /** @param {string} sha256 */
  touchBlobAccess(sha256) {
    vaultMediaResolver.touchBlobAccess(this, sha256);
  }

  flushBlobAccessTimestamps() {
    vaultMediaResolver.flushBlobAccessTimestamps(this);
  }

  getSqliteDiskBytes() {
    return getSqliteDiskBytes(this, { forceRefresh: true });
  }

  getFreeDiskBytes() {
    return getFreeDiskBytes(this);
  }

  getStats() {
    this.ensureOpen();
    const tier = this.getTier();
    const maxBytes = OFFLINE_VAULT_TIER_CAPS[tier];
    const sqliteBytes = getSqliteDiskBytes(this, { forceRefresh: true });

    const blobRow = this.stmt(
      'stats.blobs',
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS bytes FROM media_blobs'
    ).get();
    const blobCount = Number(blobRow?.cnt || 0);
    const blobBytes = Number(blobRow?.bytes || 0);
    this.totalBlobBytes = blobBytes;

    const fedRow = this.stmt(
      'stats.federated',
      "SELECT COUNT(*) AS cnt FROM game_media_assets WHERE storage_kind = 'federated'"
    ).get();
    const federatedAssetCount = Number(fedRow?.cnt || 0);

    const gamesRow = this.stmt(
      'stats.countVaultGames',
      'SELECT COUNT(*) AS cnt FROM vault_games'
    ).get();
    const totalGames = Number(gamesRow?.cnt || 0);

    const enrichedRow = this.stmt(
      'stats.countEnrichedGames',
      "SELECT COUNT(*) AS cnt FROM vault_games WHERE enriched_json IS NOT NULL AND enriched_json != '' AND metadata_quality != 'skeleton_fallback'"
    ).get();
    const enrichedGames = Number(enrichedRow?.cnt || 0);

    const pendingRow = this.stmt(
      'stats.countPendingAssets',
      "SELECT COUNT(*) AS cnt FROM game_media_assets WHERE storage_kind = 'pending'"
    ).get();
    const dbPending = Number(pendingRow?.cnt || 0);
    const engineState = this.hydrationEngine?.getProgressSnapshot?.() || null;

    return {
      tier,
      maxBytes,
      sqliteBytes,
      blobBytes,
      totalBytes: sqliteBytes + blobBytes,
      blobCount,
      federatedAssetCount,
      totalGames,
      enrichedGames,
      pendingAssets: engineState ? Math.max(dbPending, engineState.pendingAssets || 0) : dbPending,
      isHydrating: Boolean(engineState?.isHydrating),
      isSuspendedInGame: Boolean(engineState?.isSuspendedInGame),
    };
  }

  /** @param {Record<string, any>} [options] */
  clear(options = {}) {
    const db = this.ensureOpen();
    this.flushBlobAccessTimestamps();
    this.flushP1RecentGamesToDb();
    const preserveMetadata = Boolean(options && options.preserveMetadata);

    try {
      if (this.blobsDir && fs.existsSync(this.blobsDir)) {
        fs.rmSync(this.blobsDir, { recursive: true, force: true });
      }
      if (this.tmpDir && fs.existsSync(this.tmpDir)) {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.blobsDir, { recursive: true });
      fs.mkdirSync(this.tmpDir, { recursive: true });
    } catch (err) {
      diagLog.warn('offlineVault.clearBlobs', err);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM url_resolution_cache;');
      db.exec('DELETE FROM media_blobs;');
      if (preserveMetadata) {
        db.exec(`
          UPDATE game_media_assets
          SET storage_kind = 'pending',
              blob_sha256 = NULL,
              federated_path = NULL,
              failure_count = 0,
              next_retry_at = 0,
              last_status_code = NULL,
              last_verified_at = 0;
          UPDATE vault_games SET media_hydrated_at = 0;
        `);
      } else {
        db.exec('DELETE FROM game_media_assets;');
        db.exec('DELETE FROM vault_games;');
        db.exec('DELETE FROM storefront_endpoint_health;');
        db.exec("DELETE FROM vault_settings WHERE key = 'p1_recent_games';");
        db.exec("DELETE FROM vault_meta WHERE key = 'self_heal_version';");
        this.p1RecentDetailGames.clear();
        this.p1RecentGamesDirty = false;
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

    this.knownBlobHashes.clear();
    this.blobMetaBySha.clear();
    this.totalBlobBytes = 0;
    this.cachedSqliteDiskBytes = null;

    try {
      db.exec('PRAGMA incremental_vacuum;');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}

    this.halfOpenProbesInFlight.clear();
    return {
      success: true,
      stats: this.getStats(),
    };
  }

  /**
   * @param {string} gameId
   * @param {string} assetRole
   * @param {number} ordinal
   * @param {string} sourceUrl
   * @param {number} nowTs
   * @param {boolean} [allowCreatePending=true]
   */
  registerGameMediaCandidate(
    gameId,
    assetRole,
    ordinal,
    sourceUrl,
    nowTs,
    allowCreatePending = true
  ) {
    vaultGamesRepo.registerGameMediaCandidate(
      this,
      gameId,
      assetRole,
      ordinal,
      sourceUrl,
      nowTs,
      allowCreatePending
    );
  }

  /** @param {any[]} games */
  upsertGames(games) {
    return vaultGamesRepo.upsertGames(this, games);
  }

  /**
   * @param {Set<string>} targetSet
   * @param {unknown} rawId
   */
  collectVaultGameIdVariants(targetSet, rawId) {
    collectVaultGameIdVariants(targetSet, rawId);
  }

  /** @param {string[] | { gameIds?: string[] } | string} gameIdsInput */
  deleteGames(gameIdsInput) {
    return vaultGamesRepo.deleteGames(this, gameIdsInput);
  }

  /**
   * @param {string} gameId
   * @param {Record<string, any>} [record]
   * @param {string[]} [extraKeys]
   */
  saveUserOverride(gameId, record = {}, extraKeys = []) {
    return vaultGamesRepo.saveUserOverride(this, gameId, record, extraKeys);
  }

  /**
   * @param {string} gameId
   * @param {string[]} [extraKeys]
   */
  removeUserOverride(gameId, extraKeys = []) {
    return vaultGamesRepo.removeUserOverride(this, gameId, extraKeys);
  }

  /** @param {string[]} [gameIds] */
  archiveSubscriptionRotatedGames(gameIds = []) {
    return vaultGamesRepo.archiveSubscriptionRotatedGames(this, gameIds);
  }

  /** @param {Record<string, any>} [payload] */
  saveGameDetail(payload = {}) {
    return vaultGamesRepo.saveGameDetail(this, payload);
  }

  /**
   * @param {string} gameId
   * @param {number} [hydratedAt]
   */
  markGameMediaHydrated(gameId, hydratedAt = this.now()) {
    return vaultGamesRepo.markGameMediaHydrated(this, gameId, hydratedAt);
  }

  /** @param {string} gameId */
  getGameDetail(gameId) {
    return vaultGamesRepo.getGameDetail(this, gameId);
  }

  /** @param {string} gameId */
  getGameMediaAssetCandidates(gameId) {
    return vaultGamesRepo.getGameMediaAssetCandidates(this, gameId);
  }

  /**
   * @param {string[]} gameIds
   * @param {string[]} [candidateNormUrls]
   */
  getGamesMediaHydrationState(gameIds, candidateNormUrls = []) {
    return vaultGamesRepo.getGamesMediaHydrationState(this, gameIds, candidateNormUrls);
  }

  /** @param {Record<string, any>} [options] */
  getAllHydratedGames(options = {}) {
    return this.getCatalogSnapshot(options);
  }

  /** @param {Record<string, any>} [options] */
  getBootstrapCatalog(options = {}) {
    return this.getCatalogSnapshot(options);
  }

  /** @param {Record<string, any>} [options] */
  getCatalogSnapshot(options = {}) {
    return vaultGamesRepo.getCatalogSnapshot(this, options);
  }

  /** @param {string} host */
  getEndpointHealth(host) {
    return vaultRemoteFetcher.getEndpointHealth(this, host);
  }

  /** @param {string} host */
  canRequestHost(host) {
    return vaultRemoteFetcher.canRequestHost(this, host);
  }

  /** @param {string} host */
  releaseCanaryIfHeld(host) {
    vaultRemoteFetcher.releaseCanaryIfHeld(this, host);
  }

  /**
   * @param {string} host
   * @param {number} [statusCode]
   */
  recordHostSuccess(host, statusCode = 200) {
    vaultRemoteFetcher.recordHostSuccess(this, host, statusCode);
  }

  /**
   * @param {string} host
   * @param {number} [statusCode]
   * @param {number} [retryAfterMs]
   * @param {string} [errorMsg]
   */
  recordHostWafBlock(host, statusCode = 403, retryAfterMs = 0, errorMsg = 'WAF or rate limit block') {
    return vaultRemoteFetcher.recordHostWafBlock(this, host, statusCode, retryAfterMs, errorMsg);
  }

  /**
   * @param {string} host
   * @param {number | null} [statusCode]
   * @param {string} [errorMsg]
   */
  recordHostFailure(host, statusCode = null, errorMsg = 'Transient upstream failure') {
    return vaultRemoteFetcher.recordHostFailure(this, host, statusCode, errorMsg);
  }

  /**
   * @param {string} urlKey
   * @param {string} gameId
   * @param {string} assetRole
   * @param {number} ordinal
   * @param {string} sourceUrl
   */
  recordAssetAdaptive404(urlKey, gameId, assetRole, ordinal, sourceUrl) {
    return vaultMediaResolver.recordAssetAdaptive404(
      this,
      urlKey,
      gameId,
      assetRole,
      ordinal,
      sourceUrl
    );
  }

  /**
   * @param {Buffer} rawBuffer
   * @param {string} [roleOrContentType]
   * @param {string} [maybeRole]
   */
  normalizeImageBuffer(rawBuffer, roleOrContentType = 'cover', maybeRole) {
    return vaultBlobStore.normalizeImageBuffer(this, rawBuffer, roleOrContentType, maybeRole);
  }

  /**
   * @param {Buffer} rawBuffer
   * @param {string} [roleOrContentType]
   * @param {string} [maybeRole]
   */
  normalizeImageBufferAsync(rawBuffer, roleOrContentType = 'cover', maybeRole) {
    return vaultBlobStore.normalizeImageBufferAsync(this, rawBuffer, roleOrContentType, maybeRole);
  }

  /**
   * @param {Buffer} rawBuffer
   * @param {string} [assetRole]
   * @param {string} [upstreamContentType]
   */
  storeNormalizedBlob(rawBuffer, assetRole = 'cover', upstreamContentType = '') {
    return vaultBlobStore.storeNormalizedBlob(this, rawBuffer, assetRole, upstreamContentType);
  }

  /**
   * @param {Buffer} rawBuffer
   * @param {string} [assetRole]
   * @param {string} [upstreamContentType]
   */
  storeNormalizedBlobAsync(rawBuffer, assetRole = 'cover', upstreamContentType = '') {
    return vaultBlobStore.storeNormalizedBlobAsync(this, rawBuffer, assetRole, upstreamContentType);
  }

  /** @param {Record<string, any>} [options] */
  sweepOrphanBlobs(options = {}) {
    return vaultBlobStore.sweepOrphanBlobs(this, options);
  }

  /** @param {Record<string, any>} [options] */
  sweepOrphanBlobsAsync(options = {}) {
    return vaultBlobStore.sweepOrphanBlobsAsync(this, options);
  }

  /** @param {Record<string, any>} [options] */
  enforceQuota(options = {}) {
    const evictRes = this.maybeEvictBlobs({ forceIfOverMax: true, ...options });
    return {
      success: true,
      ...evictRes,
      stats: this.getStats(),
    };
  }

  /** @param {Record<string, any>} [options] */
  reclaimUnusedCache(options = {}) {
    const sweep = this.sweepOrphanBlobs(options);
    const quota = this.maybeEvictBlobs({ forceIfOverMax: true, ...options });
    try {
      const db = this.ensureOpen();
      db.exec('PRAGMA incremental_vacuum;');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    return {
      success: true,
      freedBytes: Number(sweep.freedBytes || 0) + Number(quota.freedBytes || 0),
      sweep,
      quota,
      stats: this.getStats(),
    };
  }

  /** @param {Record<string, any>} [options] */
  compactVault(options = {}) {
    const db = this.ensureOpen();
    const preSqliteBytes = this.getSqliteDiskBytes();
    const reclaim = this.reclaimUnusedCache(options);
    const zlibCompaction = this.runStartupZlibCompactionIfNeeded(db, { force: true });
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.exec('VACUUM;');
      db.exec('PRAGMA journal_mode = WAL;');
      this.cachedSqliteDiskBytes = null;
    } catch (vacErr) {
      diagLog.debug('offlineVault.compactVaultVacuum', vacErr);
    }
    const postSqliteBytes = this.getSqliteDiskBytes();
    const sqliteFreed = Math.max(0, preSqliteBytes - postSqliteBytes);
    return {
      success: true,
      preSqliteBytes,
      postSqliteBytes,
      compressedRows: Number(zlibCompaction?.compressedCount || 0),
      freedBytes: Number(reclaim.freedBytes || 0) + sqliteFreed,
      stats: this.getStats(),
    };
  }

  getStorageGovernanceStats() {
    return {
      ...this.getStats(),
      tierCaps: { ...OFFLINE_VAULT_TIER_CAPS },
      p1WindowCount: this.p1RecentDetailGames.size,
      p1WindowMax: MAX_P1_RECENT_DETAIL_GAMES,
      freeDiskBytes: this.getFreeDiskBytes(),
    };
  }

  /** @param {{ maxBytes?: number, forceIfOverMax?: boolean }} [opts] */
  maybeEvictBlobs(opts = {}) {
    return vaultBlobStore.maybeEvictBlobs(this, opts);
  }

  getFetchImpl() {
    return vaultRemoteFetcher.getFetchImpl(this);
  }

  /** @param {Record<string, any>} [params] */
  isAssetAlreadyHydratedOrBackedOff(params = {}) {
    return vaultMediaResolver.isAssetAlreadyHydratedOrBackedOff(this, params);
  }

  /** @param {Record<string, any>} [params] */
  isAssetBackedOffFailure(params = {}) {
    return vaultMediaResolver.isAssetBackedOffFailure(this, params);
  }

  /**
   * @param {string} urlKey
   * @param {string} gameId
   * @param {string} role
   * @param {number} ordinal
   * @param {string} rawUrl
   * @param {string} sha256
   */
  bindAssetBlobRow(urlKey, gameId, role, ordinal, rawUrl, sha256) {
    vaultMediaResolver.bindAssetBlobRow(this, urlKey, gameId, role, ordinal, rawUrl, sha256);
  }

  /** @param {Record<string, any> | string | URL} [paramsInput] */
  parseMediaRequestParams(paramsInput = {}) {
    return vaultMediaResolver.parseMediaRequestParams(paramsInput);
  }

  /**
   * @param {string} sha256
   * @param {string} [cacheControl]
   */
  tryResolveBlobBySha(sha256, cacheControl) {
    return vaultMediaResolver.tryResolveBlobBySha(this, sha256, cacheControl);
  }

  /**
   * @param {Record<string, any>} assetRow
   * @param {string} rawUrl
   * @param {Record<string, any>} params
   * @param {boolean} isExplicitOverride
   * @param {{ selfHealMissing?: boolean }} [opts]
   */
  tryResolveFederatedRow(assetRow, rawUrl, params, isExplicitOverride, opts) {
    return vaultMediaResolver.tryResolveFederatedRow(
      this,
      assetRow,
      rawUrl,
      params,
      isExplicitOverride,
      opts
    );
  }

  /** @param {Record<string, any> | string | URL} [paramsInput] */
  resolveLocalCachedMedia(paramsInput = {}) {
    return vaultMediaResolver.resolveLocalCachedMedia(this, paramsInput);
  }

  /**
   * @param {Record<string, any> | string | URL} [paramsInput]
   * @param {{ signal?: AbortSignal, backgroundHydration?: boolean, hydrationTier?: number, throwOnAbort?: boolean, localCacheOnly?: boolean }} [reqOpts]
   */
  resolveMediaRequest(paramsInput = {}, reqOpts = {}) {
    return vaultRemoteFetcher.resolveMediaRequest(this, paramsInput, reqOpts);
  }

  /** @param {string} url */
  checkUrlStatus(url) {
    return vaultRemoteFetcher.checkUrlStatus(this, url);
  }

  /** @param {Record<string, any>} [payload] */
  resolveLocalMetadata(payload = {}) {
    return vaultMediaResolver.resolveLocalMetadata(this, payload);
  }

  trimMemory() {
    try {
      this.federator.trimMemory();
    } catch {}
    if (!this.db) return { success: true };

    this.flushBlobAccessTimestamps();
    this.flushP1RecentGamesToDb();
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
      this.db.exec('PRAGMA shrink_memory;');
    } catch (err) {
      diagLog.debug('offlineVault.trimMemory', err);
    }
    return { success: true };
  }

  close() {
    this.shutdown();
  }

  shutdown() {
    if (this.accessFlushTimer) {
      try {
        clearTimeout(this.accessFlushTimer);
      } catch {}
      this.accessFlushTimer = null;
    }
    if (this.startupSweepTimer) {
      try {
        clearTimeout(this.startupSweepTimer);
      } catch {}
      this.startupSweepTimer = null;
    }
    if (this.p1FlushTimer) {
      try {
        clearTimeout(this.p1FlushTimer);
      } catch {}
      this.p1FlushTimer = null;
    }
    this.halfOpenProbesInFlight.clear();
    if (!this.db) {
      if (this.stmtCache) {
        this.stmtCache.clear();
        this.stmtCache = null;
      }
      this.isShutdown = true;
      return;
    }

    this.flushBlobAccessTimestamps();
    this.flushP1RecentGamesToDb();

    if (this.stmtCache) {
      this.stmtCache.clear();
      this.stmtCache = null;
    }

    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err) {
      diagLog.debug('offlineVault.walTruncate', err);
    }
    try {
      this.db.close();
    } catch (err) {
      diagLog.debug('offlineVault.dbClose', err);
    }
    this.db = null;
    this.knownBlobHashes.clear();
    this.blobMetaBySha.clear();
    this.totalBlobBytes = 0;
    this.cachedSqliteDiskBytes = null;
    this.isShutdown = true;
  }
}

/**
 * @param {Record<string, any>} [options]
 */
function createOfflineVaultService(options = {}) {
  return new OfflineVaultService(options);
}

module.exports = {
  OfflineVaultService,
  createOfflineVaultService,
  VaultStatementCache,
  OFFLINE_VAULT_TIER_CAPS,
  ROLE_MAX_WIDTHS,
  PASS_THROUGH_MAX_BYTES,
  MAX_P1_RECENT_DETAIL_GAMES,
  QUALITY_RANK,
  METADATA_QUALITY_RANK,
  MAX_INLINE_ANIMATED_GIF_CACHE_BYTES,
  MAX_ASSET_FETCH_BYTES,
  VAULT_ZLIB_PREFIX,
  compressVaultJson,
  decompressVaultJsonString,
  parseVaultJson,
  isAnimatedGifBuffer,
  normalizeAssetIdentityUrl,
  buildAssetUrlKey,
  inferVaultMetadataQuality,
  computeAdaptive404DelayMs,
  isWafOrChallengeResponse,
  isRejectedVideoUrl,
  validateFederatedImageFile,
  isExplicitOverrideParam,
  normalizeVaultChainedHandoffId,
  sanitizeVaultPlatformEntry,
  sanitizeVaultPlatformEntriesOsFlags,
  isFederatedAssetRowCompatible,
  getCriticAuthorityRank,
  isTrustedEnrichedMetacritic,
  carryForwardVaultCriticAndReviewFields,
};
