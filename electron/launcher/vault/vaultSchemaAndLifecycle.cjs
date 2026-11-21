// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { resolveFederatorUserDataDir } = require('../storefrontLocalCacheFederator.cjs');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');

/** @type {Record<string, any>} */
let electron = {};
try {
  // @ts-ignore - electron is only available at runtime inside Electron main process
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {
  // Non-Electron CLI / Vitest context
}

function getLazyLauncherEngine() {
  try {
    return require('../../launcherEngine.cjs');
  } catch {
    return null;
  }
}

/** @type {Record<string, number>} */
const OFFLINE_VAULT_TIER_CAPS = {
  compact: 150 * 1024 * 1024, // 150 MB
  balanced: 350 * 1024 * 1024, // 350 MB (default)
  max_offline: 1536 * 1024 * 1024, // 1.5 GB
  full_archive: 1536 * 1024 * 1024, // 1.5 GB legacy alias
};

const VALID_TIERS = new Set(['compact', 'balanced', 'max_offline', 'full_archive']);
const MAX_P1_RECENT_DETAIL_GAMES = 40;
const P1_RECENT_FLUSH_DEBOUNCE_MS = 250;
const CURRENT_SELF_HEAL_VERSION = 1;
const DEFAULT_SQLITE_COMPACTION_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_STARTUP_SWEEP_DELAY_MS = 25 * 1000; // 25s post-init automatic sweep
const MIN_FREE_DISK_BYTES_FOR_BLOBS = 2 * 1024 * 1024 * 1024; // 2 GB
const PASS_THROUGH_MAX_BYTES = 45 * 1024; // 45 KB zero-decode fast pass-through
const UNRESIZED_STATIC_PASS_THROUGH_MAX_BYTES = 250 * 1024; // 250 KB cap when dimensions already fit ROLE_MAX_WIDTHS
const TRANSPARENT_PNG_PASS_THROUGH_MAX_BYTES = 256 * 1024; // 256 KB alpha-preserving pass-through for icon/logo
const GIF_PASS_THROUGH_MAX_BYTES = 128 * 1024; // 128 KB (single-frame static GIFs)
const MAX_INLINE_ANIMATED_GIF_CACHE_BYTES = 1536 * 1024; // 1.5 MB animated GIF vault blob cap
const MAX_DOWNLOAD_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB hard cap per static image
const MAX_ASSET_FETCH_BYTES = 32 * 1024 * 1024; // 32 MB fetch cap for inline animated GIFs

/** @type {Record<string, number>} */
const ROLE_MAX_WIDTHS = {
  cover: 600,
  capsule: 460,
  icon: 128,
  achievement_icon: 128,
  logo: 640,
  header: 800,
  hero: 1920,
  screenshot: 1280,
  screenshot_thumb: 800,
  screenshot_full: 1280,
  inline_img: 800,
  inline_poster: 800,
};

const VAULT_ZLIB_PREFIX = '__olz1:';
const MIN_COMPRESS_JSON_CHARS = 512;

/**
 * Compresses large JSON column payloads (`>= 512` chars) via `node:zlib` raw deflate (`__olz1:<base64>`)
 * so `catalog_metadata.sqlite` stays `< 25 MB` even for 1,000+ enriched games.
 *
 * @param {any} rawVal
 * @returns {string | null}
 */
function compressVaultJson(rawVal) {
  if (rawVal === null || rawVal === undefined) return null;
  const jsonStr = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal);
  if (!jsonStr) return jsonStr;
  if (jsonStr.startsWith(VAULT_ZLIB_PREFIX)) return jsonStr;
  if (jsonStr.length < MIN_COMPRESS_JSON_CHARS) return jsonStr;
  try {
    const deflated = zlib.deflateRawSync(Buffer.from(jsonStr, 'utf8'), { level: 6 });
    const encoded = `${VAULT_ZLIB_PREFIX}${deflated.toString('base64')}`;
    return encoded.length < jsonStr.length ? encoded : jsonStr;
  } catch {
    return jsonStr;
  }
}

/**
 * Transparently decompresses `__olz1:<base64>` (or raw deflate Buffer) back to a UTF-8 JSON string,
 * while passing plain uncompressed legacy JSON strings straight through untouched.
 *
 * @param {any} rawVal
 * @returns {string | null}
 */
function decompressVaultJsonString(rawVal) {
  if (rawVal === null || rawVal === undefined) return null;
  if (Buffer.isBuffer(rawVal) || rawVal instanceof Uint8Array) {
    const buf = Buffer.from(rawVal);
    try {
      return zlib.inflateRawSync(buf).toString('utf8');
    } catch {
      return buf.toString('utf8');
    }
  }
  if (typeof rawVal !== 'string') return null;
  if (!rawVal) return '';
  if (rawVal.startsWith(VAULT_ZLIB_PREFIX)) {
    try {
      const compressed = Buffer.from(rawVal.slice(VAULT_ZLIB_PREFIX.length), 'base64');
      return zlib.inflateRawSync(compressed).toString('utf8');
    } catch {
      return null;
    }
  }
  return rawVal;
}

/**
 * Safely parses either plain JSON or `__olz1:` deflate-compressed JSON from SQLite.
 *
 * @param {any} rawVal
 * @returns {any}
 */
function parseVaultJson(rawVal) {
  const jsonStr = decompressVaultJsonString(rawVal);
  if (!jsonStr || typeof jsonStr !== 'string') return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Validates a candidate gameId string before SQLite queries or deletions.
 * @param {unknown} rawId
 * @returns {string}
 */
function normalizeSafeVaultGameId(rawId) {
  if (typeof rawId !== 'string') return '';
  const trimmed = rawId.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed.includes('\0') ||
    trimmed === '__proto__' ||
    trimmed === 'constructor' ||
    trimmed === 'prototype'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Expands a candidate gameId into canonical/legacy separator variants (`:`, `-`, `_`).
 * @param {Set<string>} targetSet
 * @param {unknown} rawId
 */
function collectVaultGameIdVariants(targetSet, rawId) {
  const clean = normalizeSafeVaultGameId(rawId);
  if (!clean) return;
  targetSet.add(clean);
  const sepMatch = clean.match(/^(steam|gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
  if (sepMatch) {
    const prefix = sepMatch[1].toLowerCase();
    const rest = sepMatch[2].trim();
    if (rest) {
      targetSet.add(`${prefix}:${rest}`);
      targetSet.add(`${prefix}-${rest}`);
      targetSet.add(`${prefix}_${rest}`);
      if (prefix === 'xbox' && /^[A-Z0-9]{12}$/i.test(rest)) {
        const upper = rest.toUpperCase();
        const lower = rest.toLowerCase();
        targetSet.add(`xbox:${upper}`);
        targetSet.add(`xbox:${lower}`);
        targetSet.add(`xbox-${upper}`);
        targetSet.add(`xbox-${lower}`);
        targetSet.add(`xbox_${upper}`);
        targetSet.add(`xbox_${lower}`);
      }
    }
  }
}

/**
 * Schema-lifecycle prepared-statement cache for `node:sqlite` `DatabaseSync`.
 * Lazily compiles each SQL statement once per open database handle and clears deterministically
 * on `close()`, `shutdown()`, reopen, or corruption quarantine recovery.
 */
class VaultStatementCache {
  /**
   * @param {any} db
   */
  constructor(db) {
    this.db = db;
    /** @type {Map<string, any>} */
    this.statements = new Map();
  }

  /**
   * @param {string} key
   * @param {string} sql
   * @returns {any}
   */
  get(key, sql) {
    if (!this.db) {
      throw new Error('VaultStatementCache accessed after database close');
    }
    let stmt = this.statements.get(key);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(key, stmt);
    }
    return stmt;
  }

  clear() {
    this.statements.clear();
    this.db = null;
  }

  get size() {
    return this.statements.size;
  }
}

const VAULT_INIT_SQL = `
  PRAGMA auto_vacuum = INCREMENTAL;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 3000;
  PRAGMA cache_size = -8192;
  PRAGMA wal_autocheckpoint = 1000;

  CREATE TABLE IF NOT EXISTS vault_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_games (
    game_id TEXT PRIMARY KEY,
    canonical_title TEXT NOT NULL DEFAULT '',
    steam_app_id INTEGER,
    is_installed INTEGER NOT NULL DEFAULT 0,
    is_favorited INTEGER NOT NULL DEFAULT 0,
    archived_by_subscription_rotation INTEGER NOT NULL DEFAULT 0,
    platforms_json TEXT,
    summary_json TEXT,
    enriched_json TEXT,
    achievements_json TEXT,
    hltb_json TEXT,
    critic_json TEXT,
    metadata_quality TEXT NOT NULL DEFAULT 'skeleton_fallback',
    updated_at INTEGER NOT NULL DEFAULT 0,
    enriched_at INTEGER NOT NULL DEFAULT 0,
    media_hydrated_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS media_blobs (
    sha256 TEXT PRIMARY KEY,
    ext TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_media_assets (
    url_key TEXT PRIMARY KEY,
    game_id TEXT NOT NULL DEFAULT '',
    asset_role TEXT NOT NULL DEFAULT 'cover',
    ordinal INTEGER NOT NULL DEFAULT 0,
    source_url TEXT NOT NULL DEFAULT '',
    storage_kind TEXT NOT NULL DEFAULT 'pending',
    blob_sha256 TEXT REFERENCES media_blobs(sha256) ON DELETE SET NULL,
    federated_path TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    last_verified_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_game_media_assets_game_role
    ON game_media_assets(game_id, asset_role, ordinal);
  CREATE INDEX IF NOT EXISTS idx_game_media_assets_blob
    ON game_media_assets(blob_sha256);
  CREATE INDEX IF NOT EXISTS idx_game_media_assets_source_url
    ON game_media_assets(source_url);

  CREATE TABLE IF NOT EXISTS url_resolution_cache (
    norm_url TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    blob_sha256 TEXT REFERENCES media_blobs(sha256) ON DELETE SET NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_url_resolution_cache_game
    ON url_resolution_cache(game_id);
  CREATE INDEX IF NOT EXISTS idx_url_resolution_cache_blob
    ON url_resolution_cache(blob_sha256);

  CREATE TABLE IF NOT EXISTS storefront_endpoint_health (
    host TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'CLOSED',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    opened_until INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`;

/**
 * @param {Record<string, any>} options
 */
function resolveVaultPaths(options) {
  const userDataDir = resolveFederatorUserDataDir(options);
  const vaultDir = path.join(userDataDir, 'offline-vault');
  return {
    vaultDir,
    blobsDir: path.join(vaultDir, 'blobs'),
    tmpDir: path.join(vaultDir, 'tmp'),
    dbPath: path.join(vaultDir, 'catalog_metadata.sqlite'),
  };
}

/**
 * Refreshes the in-memory `knownBlobHashes` Set, `blobMetaBySha` Map, and running
 * `totalBlobBytes` counter from `media_blobs` once on open or after maintenance reconciliation.
 *
 * @param {any} service
 */
function refreshInMemoryBlobIndex(service) {
  service.knownBlobHashes.clear();
  service.blobMetaBySha.clear();
  service.totalBlobBytes = 0;
  if (!service.db || !service.stmtCache) return;
  try {
    const rows = service.stmtCache
      .get('blobs.listAllIndex', 'SELECT sha256, ext, size_bytes FROM media_blobs')
      .all();
    let total = 0;
    for (const row of rows) {
      if (!row || !row.sha256) continue;
      const sha = String(row.sha256);
      const ext = String(row.ext || 'jpg');
      const sz = Math.max(0, Number(row.size_bytes || 0));
      service.knownBlobHashes.add(sha);
      service.blobMetaBySha.set(sha, { ext, sizeBytes: sz });
      total += sz;
    }
    service.totalBlobBytes = total;
  } catch (err) {
    diagLog.debug('offlineVault.refreshInMemoryBlobIndex', err);
  }
}

/**
 * Checks whether the current database handle is read-only.
 *
 * @param {any} service
 * @param {any} [db]
 * @returns {boolean}
 */
function isDbReadOnly(service, db = service.db) {
  if (service.options?.readOnly) return true;
  if (!db) return true;
  try {
    const qOnly = service.stmtCache
      ? service.stmtCache.get('pragma.queryOnly', 'PRAGMA query_only').get()
      : db.prepare('PRAGMA query_only').get();
    return Boolean(Number(qOnly?.query_only));
  } catch {
    return false;
  }
}

/**
 * Measures combined disk bytes of the SQLite database file + `-wal` + `-shm`, with optional
 * 2-second caching for hot-path writes and immediate refresh when `forceRefresh` is true.
 *
 * @param {any} service
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {number}
 */
function getSqliteDiskBytes(service, opts = {}) {
  if (!service.dbPath) return 0;
  const nowTs = service.now();
  if (
    !opts.forceRefresh &&
    typeof service.cachedSqliteDiskBytes === 'number' &&
    nowTs - (service.cachedSqliteDiskAt || 0) < 2000
  ) {
    return service.cachedSqliteDiskBytes;
  }
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${service.dbPath}${suffix}`;
    try {
      if (fs.existsSync(p)) {
        total += fs.statSync(p).size || 0;
      }
    } catch {}
  }
  service.cachedSqliteDiskBytes = total;
  service.cachedSqliteDiskAt = nowTs;
  return total;
}

/**
 * @param {any} service
 * @returns {number}
 */
function getFreeDiskBytes(service) {
  if (typeof service.options.freeDiskBytesFn === 'function') {
    return Number(service.options.freeDiskBytesFn());
  }
  const now = service.now();
  if (service.cachedFreeDiskBytes !== null && now - service.cachedFreeDiskAt < 30000) {
    return service.cachedFreeDiskBytes;
  }
  let freeBytes = 100 * 1024 * 1024 * 1024;
  try {
    const target = service.vaultDir || resolveFederatorUserDataDir(service.options);
    const launcherEngine = getLazyLauncherEngine();
    let resolvedSync = false;
    if (launcherEngine && typeof launcherEngine.getDiskSpace === 'function') {
      const dsOrPromise = /** @type {any} */ (launcherEngine.getDiskSpace(target));
      if (dsOrPromise && typeof dsOrPromise.then === 'function') {
        dsOrPromise
          .then((/** @type {any} */ ds) => {
            if (ds && typeof ds.freeBytes === 'number') {
              service.cachedFreeDiskBytes = ds.freeBytes;
              service.cachedFreeDiskAt = service.now();
            }
          })
          .catch(() => {});
      } else if (dsOrPromise && typeof dsOrPromise.freeBytes === 'number') {
        freeBytes = dsOrPromise.freeBytes;
        resolvedSync = true;
      }
    }
    if (!resolvedSync && typeof fs.statfsSync === 'function') {
      let probe = target;
      while (probe && !fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (!parent || parent === probe) break;
        probe = parent;
      }
      if (probe && fs.existsSync(probe)) {
        const st = fs.statfsSync(probe);
        freeBytes = Number(st.bavail || st.bfree || 0) * Number(st.bsize || 4096);
      }
    }
  } catch {}
  service.cachedFreeDiskBytes = freeBytes;
  service.cachedFreeDiskAt = now;
  return freeBytes;
}

/**
 * Opens or reopens the SQLite database with Windows-safe corruption quarantine
 * (`db.close()` BEFORE `fs.renameSync`), schema migrations, `VaultStatementCache` setup,
 * and in-memory blob index initialization.
 *
 * @param {any} service
 * @returns {any}
 */
function openVaultDatabase(service) {
  const paths = resolveVaultPaths(service.options);
  if (service.db && service.dbPath === paths.dbPath) {
    return service.db;
  }
  if (service.db && service.dbPath !== paths.dbPath) {
    service.shutdown();
  }

  service.vaultDir = paths.vaultDir;
  service.blobsDir = paths.blobsDir;
  service.tmpDir = paths.tmpDir;
  service.dbPath = paths.dbPath;

  fs.mkdirSync(service.vaultDir, { recursive: true });
  fs.mkdirSync(service.blobsDir, { recursive: true });
  fs.mkdirSync(service.tmpDir, { recursive: true });

  // Clean up any orphaned partial temp files from prior crash
  try {
    for (const f of fs.readdirSync(service.tmpDir)) {
      if (f.endsWith('.tmp')) {
        try {
          fs.unlinkSync(path.join(service.tmpDir, f));
        } catch {}
      }
    }
  } catch {}

  if (service.stmtCache) {
    service.stmtCache.clear();
    service.stmtCache = null;
  }

  let db;
  try {
    db = new DatabaseSync(service.dbPath);
    db.exec(VAULT_INIT_SQL);
  } catch (openErr) {
    diagLog.warn('offlineVault.databaseCorrupt', openErr);
    // Hard Invariant: on Windows (NTFS), close SQLite handle BEFORE fs.renameSync to avoid EBUSY!
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
    try {
      const corruptBackup = `${service.dbPath}.corrupt.${Date.now()}`;
      if (fs.existsSync(service.dbPath)) {
        fs.renameSync(service.dbPath, corruptBackup);
      }
      if (fs.existsSync(`${service.dbPath}-wal`)) {
        try {
          fs.unlinkSync(`${service.dbPath}-wal`);
        } catch {}
      }
      if (fs.existsSync(`${service.dbPath}-shm`)) {
        try {
          fs.unlinkSync(`${service.dbPath}-shm`);
        } catch {}
      }
      db = new DatabaseSync(service.dbPath);
      db.exec(VAULT_INIT_SQL);
    } catch (recoverErr) {
      diagLog.error('offlineVault.databaseRecoveryFailed', recoverErr);
      throw recoverErr;
    }
  }

  try {
    const cols = db.prepare('PRAGMA table_info(vault_games)').all();
    if (Array.isArray(cols)) {
      if (!cols.some((/** @type {any} */ c) => c && c.name === 'archived_by_subscription_rotation')) {
        db.exec(
          'ALTER TABLE vault_games ADD COLUMN archived_by_subscription_rotation INTEGER NOT NULL DEFAULT 0;'
        );
      }
      if (!cols.some((/** @type {any} */ c) => c && c.name === 'media_hydrated_at')) {
        db.exec('ALTER TABLE vault_games ADD COLUMN media_hydrated_at INTEGER DEFAULT 0;');
      }
    }
  } catch (migErr) {
    diagLog.warn('offlineVault.migrateSubscriptionRotationCol', migErr);
  }

  service.db = db;
  service.stmtCache = new VaultStatementCache(db);
  service.isShutdown = false;
  service.cachedSqliteDiskBytes = null;
  service.cachedSqliteDiskAt = 0;

  service.stmtCache
    .get(
      'settings.initTier',
      "INSERT OR IGNORE INTO vault_settings (key, value, updated_at) VALUES ('tier', 'balanced', ?)"
    )
    .run(service.now());

  refreshInMemoryBlobIndex(service);
  service.loadP1RecentGamesFromDb(db);
  service.runStartupSelfHeal(db);
  service.runStartupZlibCompactionIfNeeded(db);
  service.schedulePostInitOrphanSweep();
  return db;
}

/**
 * @param {any} service
 * @param {any} [db]
 * @param {Record<string, any>} [opts]
 */
function runStartupZlibCompactionIfNeeded(service, db = service.db, opts = {}) {
  if (!db) return { compacted: false, compressedCount: 0 };
  try {
    const force = Boolean(opts && opts.force);
    const thresholdBytes =
      typeof opts?.thresholdBytes === 'number' && opts.thresholdBytes > 0
        ? opts.thresholdBytes
        : typeof service.options.sqliteCompactionThresholdBytes === 'number' &&
            service.options.sqliteCompactionThresholdBytes > 0
          ? service.options.sqliteCompactionThresholdBytes
          : DEFAULT_SQLITE_COMPACTION_THRESHOLD_BYTES;

    const getSetting = (/** @type {string} */ k) =>
      service.stmtCache
        ? service.stmtCache
            .get('settings.getByKey', 'SELECT value FROM vault_settings WHERE key = ?')
            .get(k)
        : db.prepare('SELECT value FROM vault_settings WHERE key = ?').get(k);

    const migRow = getSetting('json_zlib_migrated_v1');
    const alreadyMigrated = migRow && migRow.value === '1';
    const preBytes = getSqliteDiskBytes(service, { forceRefresh: true });

    if (!force && alreadyMigrated && preBytes <= thresholdBytes) {
      return { compacted: false, compressedCount: 0 };
    }

    const uncompressedRows = service.stmtCache
      .get(
        'compaction.findUncompressed',
        `
          SELECT game_id, platforms_json, summary_json, enriched_json, achievements_json, hltb_json, critic_json
          FROM vault_games
          WHERE (platforms_json IS NOT NULL AND LENGTH(platforms_json) >= 512 AND platforms_json NOT LIKE '__olz1:%')
             OR (summary_json IS NOT NULL AND LENGTH(summary_json) >= 512 AND summary_json NOT LIKE '__olz1:%')
             OR (enriched_json IS NOT NULL AND LENGTH(enriched_json) >= 512 AND enriched_json NOT LIKE '__olz1:%')
             OR (achievements_json IS NOT NULL AND LENGTH(achievements_json) >= 512 AND achievements_json NOT LIKE '__olz1:%')
             OR (hltb_json IS NOT NULL AND LENGTH(hltb_json) >= 512 AND hltb_json NOT LIKE '__olz1:%')
             OR (critic_json IS NOT NULL AND LENGTH(critic_json) >= 512 AND critic_json NOT LIKE '__olz1:%')
        `
      )
      .all();

    let compressedCount = 0;
    if (uncompressedRows.length > 0) {
      const updStmt = service.stmtCache.get(
        'compaction.updateRow',
        `
          UPDATE vault_games
          SET platforms_json = ?,
              summary_json = ?,
              enriched_json = ?,
              achievements_json = ?,
              hltb_json = ?,
              critic_json = ?
          WHERE game_id = ?
        `
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of uncompressedRows) {
          updStmt.run(
            compressVaultJson(r.platforms_json),
            compressVaultJson(r.summary_json),
            compressVaultJson(r.enriched_json),
            compressVaultJson(r.achievements_json),
            compressVaultJson(r.hltb_json),
            compressVaultJson(r.critic_json),
            r.game_id
          );
          compressedCount++;
        }
        db.exec('COMMIT');
      } catch (txErr) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw txErr;
      }
    }

    const setSettingStmt = service.stmtCache.get(
      'settings.upsert',
      'INSERT INTO vault_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    setSettingStmt.run('json_zlib_migrated_v1', '1', service.now());

    const vacRow = getSetting('sqlite_vacuum_diet_v1');
    if (preBytes > thresholdBytes && (!vacRow || vacRow.value !== '1' || compressedCount > 0)) {
      setSettingStmt.run('sqlite_vacuum_diet_v1', '1', service.now());
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        db.exec('VACUUM;');
        db.exec('PRAGMA journal_mode = WAL;');
        service.cachedSqliteDiskBytes = null;
      } catch (vacErr) {
        diagLog.debug('offlineVault.startupVacuum', vacErr);
      }
    }
    return { compacted: compressedCount > 0, compressedCount };
  } catch (compErr) {
    diagLog.debug('offlineVault.startupZlibCompaction', compErr);
    return { compacted: false, compressedCount: 0 };
  }
}

module.exports = {
  electron,
  getLazyLauncherEngine,
  OFFLINE_VAULT_TIER_CAPS,
  VALID_TIERS,
  MAX_P1_RECENT_DETAIL_GAMES,
  P1_RECENT_FLUSH_DEBOUNCE_MS,
  CURRENT_SELF_HEAL_VERSION,
  DEFAULT_SQLITE_COMPACTION_THRESHOLD_BYTES,
  DEFAULT_STARTUP_SWEEP_DELAY_MS,
  MIN_FREE_DISK_BYTES_FOR_BLOBS,
  PASS_THROUGH_MAX_BYTES,
  UNRESIZED_STATIC_PASS_THROUGH_MAX_BYTES,
  TRANSPARENT_PNG_PASS_THROUGH_MAX_BYTES,
  GIF_PASS_THROUGH_MAX_BYTES,
  MAX_INLINE_ANIMATED_GIF_CACHE_BYTES,
  MAX_DOWNLOAD_IMAGE_BYTES,
  MAX_ASSET_FETCH_BYTES,
  ROLE_MAX_WIDTHS,
  VAULT_ZLIB_PREFIX,
  MIN_COMPRESS_JSON_CHARS,
  compressVaultJson,
  decompressVaultJsonString,
  parseVaultJson,
  yieldEventLoop,
  normalizeSafeVaultGameId,
  collectVaultGameIdVariants,
  VaultStatementCache,
  resolveVaultPaths,
  refreshInMemoryBlobIndex,
  isDbReadOnly,
  getSqliteDiskBytes,
  getFreeDiskBytes,
  openVaultDatabase,
  runStartupZlibCompactionIfNeeded,
};
