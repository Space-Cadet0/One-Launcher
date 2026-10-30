'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const {
  StorefrontLocalCacheFederator,
  detectImageMagicBytes,
  validateFederatedImageFile,
  resolveFederatorUserDataDir,
} = require('./storefrontLocalCacheFederator.cjs');
const { isContainedWithinRoot } = require('./securityAndPathUtils.cjs');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {
  // Non-Electron CLI / Vitest context
}

function getLazyLauncherEngine() {
  try {
    return require('../launcherEngine.cjs');
  } catch {
    return null;
  }
}

const OFFLINE_VAULT_TIER_CAPS = {
  compact: 150 * 1024 * 1024, // 150 MB
  balanced: 350 * 1024 * 1024, // 350 MB (default)
  max_offline: 1536 * 1024 * 1024, // 1.5 GB
  full_archive: 1536 * 1024 * 1024, // 1.5 GB legacy alias
};

const VALID_TIERS = new Set(['compact', 'balanced', 'max_offline', 'full_archive']);
const MAX_P1_RECENT_DETAIL_GAMES = 40;
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

const ROLE_MAX_WIDTHS = {
  cover: 600,
  capsule: 460,
  icon: 128,
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

const QUALITY_RANK = {
  skeleton_fallback: 0,
  local_federated: 1,
  storefront_native: 2,
  scraped: 3,
  authoritative: 4,
};
const METADATA_QUALITY_RANK = QUALITY_RANK;

const REJECTED_VIDEO_URL_RE = /\.(?:mp4|webm|m3u8|ts|mkv|mov|avi|mpd|ogv)(?:$|[?#])/i;
const REJECTED_VIDEO_MIME_RE =
  /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

/**
 * Adaptive 404 retry schedule (NEVER Infinity so fixed/re-listed store pages always self-heal):
 * - 1st 404: 6 hours
 * - 2nd 404: 24 hours
 * - 3rd 404: 7 days
 * - 4th+ 404: 30 days
 *
 * @param {number} failureCount
 * @returns {number}
 */
function computeAdaptive404DelayMs(failureCount) {
  const count = Math.max(1, Math.floor(Number(failureCount) || 1));
  if (count === 1) return 6 * 60 * 60 * 1000;
  if (count === 2) return 24 * 60 * 60 * 1000;
  if (count === 3) return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

/**
 * Detects WAF / bot-protection challenge responses (Cloudflare, Akamai, PerimeterX, CAPTCHA)
 * or HTTP 429 / 403 blocks so transient blocks never poison 404 or metadata state.
 *
 * @param {number | undefined | null} status
 * @param {string | Buffer | null | undefined} bodySample
 * @param {Record<string, any> | Headers | null | undefined} headers
 * @returns {boolean}
 */
function isWafOrChallengeResponse(status, bodySample, headers) {
  const getHeader = (name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      return String(headers.get(name) || '');
    }
    return String(headers[name] || headers[name.toLowerCase()] || '');
  };

  if (getHeader('cf-mitigated')) return true;
  if (status === 429) return true;

  let sampleStr = '';
  if (typeof bodySample === 'string') {
    sampleStr = bodySample.slice(0, 4096);
  } else if (Buffer.isBuffer(bodySample)) {
    sampleStr = bodySample.subarray(0, 4096).toString('utf8');
  }

  if (
    sampleStr &&
    /cf-chl-bypass|cf-browser-verification|Just a moment\.\.\.|Attention Required! \| Cloudflare|Access Denied[\s\S]{0,200}Reference #|Reference #\d+\.\w+|PerimeterX|px-captcha|g-recaptcha|hcaptcha/i.test(
      sampleStr
    )
  ) {
    return true;
  }

  return status === 403;
}

function parseRetryAfterMs(headers) {
  if (!headers) return 0;
  let raw = '';
  if (typeof headers.get === 'function') {
    raw = String(headers.get('retry-after') || '');
  } else {
    raw = String(headers['retry-after'] || headers['Retry-After'] || '');
  }
  raw = raw.trim();
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(24 * 60 * 60 * 1000, Math.round(secs * 1000));
  }
  const parsedDate = Date.parse(raw);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    if (diff > 0) {
      return Math.min(24 * 60 * 60 * 1000, diff);
    }
  }
  return 0;
}

function isRejectedVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return REJECTED_VIDEO_URL_RE.test(url.trim());
}

function normalizeComparableMediaUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';
  return clean.replace(
    /^https?:\/\/(?:shared\.(?:akamai|fastly)\.steamstatic\.com|cdn\.(?:cloudflare|akamai)\.steamstatic\.com|steamcdn-a\.akamaihd\.net)\//i,
    'https://steamstatic.canonical/'
  );
}

const ASSET_IDENTITY_QUERY_KEYS = new Set([
  'w',
  'h',
  'width',
  'height',
  'mode',
  'format',
  'fmt',
]);

/**
 * Normalizes an asset source URL for identity comparison across sync cycles:
 * - Aliases Steam CDN mirror hosts to `steamstatic.canonical`
 * - Preserves host + pathname + deterministic sizing/format parameters (`w`, `h`, `mode`)
 * - Strips volatile CDN signature / cache-buster query tokens (`t`, `sig`, `se`, `token`, etc.)
 */
function normalizeAssetIdentityUrl(url) {
  const comparable = normalizeComparableMediaUrl(url);
  if (!comparable) return '';
  try {
    const parsed = new URL(comparable);
    const host = parsed.hostname.toLowerCase();
    const pathname =
      parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    const keptParams = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      const keyLower = k.toLowerCase();
      if (ASSET_IDENTITY_QUERY_KEYS.has(keyLower)) {
        keptParams.push(`${keyLower}=${v}`);
      }
    }
    keptParams.sort();
    return `https://${host}${pathname}${keptParams.length > 0 ? `?${keptParams.join('&')}` : ''}`;
  } catch {
    return comparable;
  }
}

/**
 * Pure byte-level GIF87a/GIF89a multi-frame detector.
 * Walks the Logical Screen Descriptor, optional Global Color Table, Extension sub-blocks,
 * and Image Descriptors (`0x2C`) + LZW sub-blocks in O(frame-1 bytes), returning `true`
 * as soon as >= 2 frames are present so animated GIFs are NEVER flattened by `nativeImage.toJPEG`.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isAnimatedGifBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14) return false;
  if (
    buf[0] !== 0x47 ||
    buf[1] !== 0x49 ||
    buf[2] !== 0x46 ||
    buf[3] !== 0x38 ||
    (buf[4] !== 0x37 && buf[4] !== 0x39) ||
    buf[5] !== 0x61
  ) {
    return false;
  }

  const len = buf.length;
  const packed = buf[10];
  let offset = 13;
  if (packed & 0x80) {
    offset += 3 * (1 << ((packed & 0x07) + 1));
  }

  const skipSubBlocks = (startPos) => {
    let pos = startPos;
    while (pos < len) {
      const blockSize = buf[pos++];
      if (blockSize === 0) return pos;
      pos += blockSize;
    }
    return len;
  };

  let imageFrames = 0;
  let gceBlocks = 0;
  let parseClean = true;

  while (offset < len) {
    const introducer = buf[offset++];
    if (introducer === 0x3b) {
      break;
    }
    if (introducer === 0x21) {
      if (offset >= len) break;
      const extLabel = buf[offset++];
      if (extLabel === 0xf9) {
        gceBlocks++;
      }
      offset = skipSubBlocks(offset);
      continue;
    }
    if (introducer === 0x2c) {
      imageFrames++;
      if (imageFrames >= 2) return true;
      if (offset + 9 > len) break;
      const localPacked = buf[offset + 8];
      offset += 9;
      if (localPacked & 0x80) {
        offset += 3 * (1 << ((localPacked & 0x07) + 1));
      }
      if (offset >= len) break;
      offset += 1; // LZW minimum code size byte
      offset = skipSubBlocks(offset);
      continue;
    }
    parseClean = false;
    break;
  }

  if (imageFrames >= 2) return true;
  if (!parseClean && gceBlocks >= 2) return true;

  // Structural GCE fallback for truncated or synthetic buffers (`0x21 0xF9 0x04 <4 bytes> 0x00`)
  let structuralGceCount = 0;
  for (let i = 13; i + 7 < len; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04 && buf[i + 7] === 0x00) {
      structuralGceCount++;
      if (structuralGceCount >= 2) return true;
      i += 7;
    }
  }

  return false;
}

function hasXboxPlatform(game) {
  if (!game || typeof game !== 'object') return false;
  const gid = String(game.id || game.gameId || '').trim().toLowerCase();
  if (gid.startsWith('xbox-') || gid.startsWith('xbox_')) return true;
  if (String(game.platform || '').trim().toLowerCase() === 'xbox') return true;
  if (game.xboxProductId) return true;
  if (Array.isArray(game.platforms)) {
    return game.platforms.some((p) =>
      typeof p === 'string'
        ? p.trim().toLowerCase() === 'xbox'
        : Boolean(p && typeof p === 'object' && String(p.platformId || '').toLowerCase() === 'xbox')
    );
  }
  return false;
}

function extractXboxBigIdsFromGame(gameObj, platformsArr) {
  const found = new Set();
  const addCandidate = (raw) => {
    const clean = String(raw || '')
      .replace(/^xbox[-_:]/i, '')
      .trim()
      .toUpperCase();
    if (/^[A-Z0-9]{12}$/.test(clean)) {
      found.add(clean);
    }
  };

  if (gameObj && typeof gameObj === 'object') {
    addCandidate(gameObj.xboxProductId);
  }
  const plats = Array.isArray(platformsArr)
    ? platformsArr
    : Array.isArray(gameObj?.platforms)
      ? gameObj.platforms
      : [];
  for (const p of plats) {
    if (!p || typeof p !== 'object') continue;
    if (p.xboxProductId) addCandidate(p.xboxProductId);
    if (String(p.platformId || '').toLowerCase() === 'xbox') {
      addCandidate(p.platformGameId);
      addCandidate(p.storefrontAppId);
    }
  }
  return Array.from(found);
}

/**
 * Infers truthful `MetadataQuality` for `OfflineVaultService`, preventing Xbox DisplayCatalog
 * baseline synopses (`enrichedSource: 'xbox'` or missing `appId`) from poisoning `vault_games`
 * as `'authoritative'` (rank 4).
 */
function inferVaultMetadataQuality(game, enriched) {
  if (!enriched || typeof enriched !== 'object') {
    const explicitGameQuality = String(game?.metadataQuality || '').trim();
    if (
      explicitGameQuality &&
      Object.prototype.hasOwnProperty.call(QUALITY_RANK, explicitGameQuality)
    ) {
      return explicitGameQuality;
    }
    return 'skeleton_fallback';
  }

  const explicitQuality = String(
    enriched.metadataQuality || game?.metadataQuality || ''
  ).trim();
  const enrichedSource = String(enriched.enrichedSource || '').trim().toLowerCase();
  const gameId = String(game?.id || game?.gameId || '').trim();
  const numericAppId = Number(enriched.appId);
  const hasPositiveAppId = Number.isFinite(numericAppId) && numericAppId > 0;

  if (explicitQuality === 'storefront_native' || enrichedSource === 'xbox') {
    return 'storefront_native';
  }

  if (
    explicitQuality === 'skeleton_fallback' ||
    explicitQuality === 'local_federated' ||
    explicitQuality === 'scraped'
  ) {
    return explicitQuality;
  }

  if (explicitQuality === 'authoritative') {
    if ((!gameId.startsWith('steam-') || hasPositiveAppId) && (!hasXboxPlatform(game) || hasPositiveAppId)) {
      return 'authoritative';
    }
    return 'storefront_native';
  }

  if (
    hasPositiveAppId &&
    ((Array.isArray(enriched.screenshots) && enriched.screenshots.length > 0) ||
      (typeof enriched.detailedDescription === 'string' && enriched.detailedDescription.length > 120))
  ) {
    return 'authoritative';
  }

  if (!hasPositiveAppId && (hasXboxPlatform(game) || gameId.startsWith('steam-'))) {
    return 'storefront_native';
  }

  if (enriched.shortDescription || enriched.detailedDescription) {
    return 'scraped';
  }

  return 'skeleton_fallback';
}

function buildAssetUrlKey(gameId, role, ordinal, sourceUrl) {
  const cleanGameId = String(gameId || '').trim();
  const cleanRole = String(role || 'cover').trim();
  const cleanOrd = Math.max(0, Math.floor(Number(ordinal) || 0));
  const cleanUrl = String(sourceUrl || '').trim();
  const isUrlKeyedRole =
    cleanUrl &&
    (cleanRole === 'inline_img' ||
      cleanRole === 'inline_poster' ||
      (cleanRole === 'icon' && cleanOrd > 0));
  if (isUrlKeyedRole) {
    const urlHash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 32);
    return `${cleanGameId || 'url'}::${cleanRole}::${urlHash}`;
  }
  if (cleanGameId) {
    return `${cleanGameId}::${cleanRole}::${cleanOrd}`;
  }
  const urlHash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 32);
  return `url::${cleanRole}::${urlHash}`;
}

/**
 * Normalizes an explicit user media override flag (`ov`) from `ol-media://` or IPC params.
 * @param {unknown} rawOv
 * @returns {boolean}
 */
function isExplicitOverrideParam(rawOv) {
  if (rawOv === true || rawOv === 1) return true;
  if (typeof rawOv === 'number') return rawOv > 0;
  if (typeof rawOv === 'string') {
    const norm = rawOv.trim().toLowerCase();
    return Boolean(
      norm && norm !== '0' && norm !== 'false' && norm !== 'null' && norm !== 'undefined'
    );
  }
  return false;
}

/**
 * @param {string} hostname
 * @param {string[]} allowedDomains
 * @returns {boolean}
 */
function matchesCdnHost(hostname, allowedDomains) {
  const clean = String(hostname || '').trim().toLowerCase();
  if (!clean) return false;
  for (const dom of allowedDomains) {
    if (clean === dom || clean.endsWith(`.${dom}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates whether a SQLite `game_media_assets` federated row (`source_url` + `federated_path`)
 * is origin-, ID-, and content-hash-compatible across macOS and Windows paths, and rejects
 * explicit user media overrides (`params?.ov`) so custom covers always use `media_blobs`.
 *
 * @param {unknown} sourceUrl
 * @param {unknown} federatedPath
 * @param {Record<string, any> | null} [params]
 * @returns {boolean}
 */
function isFederatedAssetRowCompatible(sourceUrl, federatedPath, params = null) {
  if (isExplicitOverrideParam(params?.ov)) {
    return false;
  }
  const cleanFedPath = typeof federatedPath === 'string' ? federatedPath.trim() : '';
  if (!cleanFedPath) {
    return false;
  }

  const normPath = cleanFedPath.replace(/\\/g, '/');
  const normPathLower = normPath.toLowerCase();
  const paramGogId = params?.gogId != null ? String(params.gogId).trim() : params?.gid != null ? String(params.gid).trim() : '';
  const paramSteamId = params?.steamAppId != null ? String(params.steamAppId).trim() : params?.sid != null ? String(params.sid).trim() : '';

  const gogDirMatch = normPath.match(/\/gog\/(\d+)\//i);
  if (paramGogId && gogDirMatch && gogDirMatch[1] !== paramGogId) {
    return false;
  }
  const steamDirMatch = normPath.match(/\/librarycache\/(\d+)(?:\/|_)/i);
  if (paramSteamId && steamDirMatch && steamDirMatch[1] !== paramSteamId) {
    return false;
  }

  const cleanUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!cleanUrl) {
    return true;
  }

  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || '';

  // Third-party custom artwork hosts must never resolve to local storefront federated files
  if (matchesCdnHost(host, ['igdb.com', 'steamgriddb.com'])) {
    return false;
  }

  const isGogCache =
    normPathLower.includes('gog.com/galaxy/webcache') ||
    (normPathLower.includes('/webcache/') && normPathLower.includes('/gog/'));
  if (isGogCache) {
    if (!matchesCdnHost(host, ['gog-statics.com', 'gog.com'])) {
      return false;
    }
    const urlHash64 = pathname.match(/([0-9a-f]{64})/i);
    const fileHash64 = path.posix.basename(normPath).match(/([0-9a-f]{64})/i);
    if (urlHash64 && fileHash64 && urlHash64[1].toLowerCase() !== fileHash64[1].toLowerCase()) {
      return false;
    }
    return true;
  }

  const isSteamCache =
    normPathLower.includes('appcache/librarycache') ||
    (normPathLower.includes('/userdata/') && normPathLower.includes('/config/grid/')) ||
    normPathLower.includes('/steam/games/');
  if (isSteamCache) {
    if (
      !matchesCdnHost(host, [
        'steamstatic.com',
        'akamaihd.net',
        'steamcdn-a.akamaihd.net',
        'steampowered.com',
      ])
    ) {
      return false;
    }
    const appUrlMatch = pathname.match(/\/(?:steam|images)\/apps\/(\d+)\//i);
    if (appUrlMatch) {
      if (steamDirMatch && steamDirMatch[1] !== appUrlMatch[1]) {
        return false;
      }
      if (paramSteamId && paramSteamId !== appUrlMatch[1]) {
        return false;
      }
    }
    const sha40SegMatch = pathname.match(/\/([0-9a-f]{40})\//i);
    if (sha40SegMatch && normPathLower.includes('appcache/librarycache')) {
      if (!normPathLower.includes(sha40SegMatch[1].toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  const isXboxCache =
    normPathLower.includes('/xboxgames/') ||
    normPathLower.includes('microsoft.gamingapp_') ||
    normPathLower.includes('8wekyb3d8bbwe') ||
    normPathLower.includes('/windowsapps/');
  if (isXboxCache) {
    return matchesCdnHost(host, ['s-microsoft.com', 'xboxlive.com', 'microsoft.com']);
  }

  const isEpicCache =
    normPathLower.includes('/images-cache/') ||
    normPathLower.includes('/heroic/') ||
    normPathLower.includes('epicgameslauncher') ||
    normPathLower.includes('/legendary/');
  if (isEpicCache) {
    return matchesCdnHost(host, ['epicgames.com', 'unrealengine.com']);
  }

  return true;
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

class OfflineVaultService {
  /**
   * @param {Record<string, any>} [options]
   */
  constructor(options = {}) {
    this.options = { ...options };
    this.federator =
      options.federator instanceof StorefrontLocalCacheFederator ||
      (options.federator &&
        typeof options.federator === 'object' &&
        (typeof options.federator.resolveFederatedAsset === 'function' ||
          typeof options.federator.resolveLocalStoreAsset === 'function'))
        ? options.federator
        : new StorefrontLocalCacheFederator(options);
    this.db = null;
    this.vaultDir = '';
    this.blobsDir = '';
    this.tmpDir = '';
    this.dbPath = '';

    /** @type {Map<string, number>} */
    this.pendingBlobAccessMap = new Map();
    this.accessFlushTimer = null;
    this.startupSweepTimer = null;

    /** @type {Map<string, number>} */
    this.p1RecentDetailGames = new Map();

    /** @type {Set<string>} */
    this.halfOpenProbesInFlight = new Set();
    /** @type {Map<string, any>} */
    this.inFlightMediaFetches = new Map();

    /** @type {Set<(snapshot: any) => void>} */
    this.healthListeners = new Set();
    this.hydrationEngine = null;

    this.cachedFreeDiskBytes = null;
    this.cachedFreeDiskAt = 0;
    this.isShutdown = false;
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

  setHydrationEngine(engine) {
    this.hydrationEngine = engine || null;
  }

  loadP1RecentGamesFromDb(db) {
    if (!db) return;
    try {
      const row = db.prepare("SELECT value FROM vault_settings WHERE key = 'p1_recent_games'").get();
      if (!row || typeof row.value !== 'string') return;
      const parsed = JSON.parse(row.value);
      if (!Array.isArray(parsed)) return;
      this.p1RecentDetailGames.clear();
      for (const entry of parsed.slice(-MAX_P1_RECENT_DETAIL_GAMES)) {
        if (typeof entry === 'string' && entry.trim()) {
          this.p1RecentDetailGames.set(entry.trim(), this.now());
        } else if (entry && typeof entry === 'object' && entry.gameId) {
          this.p1RecentDetailGames.set(
            String(entry.gameId).trim(),
            Number(entry.ts || this.now())
          );
        }
      }
    } catch {}
  }

  persistP1RecentGamesToDb() {
    if (!this.db) return;
    try {
      const serialized = JSON.stringify(
        Array.from(this.p1RecentDetailGames.entries()).map(([gameId, ts]) => ({ gameId, ts }))
      );
      this.db
        .prepare(
          "INSERT INTO vault_settings (key, value, updated_at) VALUES ('p1_recent_games', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
        .run(serialized, this.now());
    } catch {}
  }

  recordP1DetailGame(gameId) {
    const cleanId = String(gameId || '').trim();
    if (!cleanId) return false;
    this.ensureOpen();
    if (this.p1RecentDetailGames.has(cleanId)) {
      this.p1RecentDetailGames.delete(cleanId);
    }
    this.p1RecentDetailGames.set(cleanId, this.now());
    while (this.p1RecentDetailGames.size > MAX_P1_RECENT_DETAIL_GAMES) {
      const oldestKey = this.p1RecentDetailGames.keys().next().value;
      if (!oldestKey) break;
      this.p1RecentDetailGames.delete(oldestKey);
    }
    this.persistP1RecentGamesToDb();
    return true;
  }

  isP1DetailGame(gameId) {
    const cleanId = String(gameId || '').trim();
    if (!cleanId) return false;
    return this.p1RecentDetailGames.has(cleanId);
  }

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
      if (!this.db) return;
      if (this.hydrationEngine?.isSuspendedInGame) return;
      try {
        this.sweepOrphanBlobs({ reclaimLegacyP2NonCover: true });
        this.maybeEvictBlobs({ forceIfOverMax: true });
      } catch (sweepErr) {
        diagLog.debug('offlineVault.postInitSweep', sweepErr);
      }
    }, delayMs);
    if (this.startupSweepTimer && typeof this.startupSweepTimer.unref === 'function') {
      this.startupSweepTimer.unref();
    }
  }

  runStartupZlibCompactionIfNeeded(db = this.db, opts = {}) {
    if (!db) return { compacted: false, compressedCount: 0 };
    try {
      const force = Boolean(opts && opts.force);
      const thresholdBytes =
        typeof opts?.thresholdBytes === 'number' && opts.thresholdBytes > 0
          ? opts.thresholdBytes
          : typeof this.options.sqliteCompactionThresholdBytes === 'number' &&
              this.options.sqliteCompactionThresholdBytes > 0
            ? this.options.sqliteCompactionThresholdBytes
            : DEFAULT_SQLITE_COMPACTION_THRESHOLD_BYTES;

      const preBytes = this.getSqliteDiskBytes();
      const migRow = db
        .prepare("SELECT value FROM vault_settings WHERE key = 'json_zlib_migrated_v1'")
        .get();
      const alreadyMigrated = migRow && migRow.value === '1';

      if (!force && alreadyMigrated && preBytes <= thresholdBytes) {
        return { compacted: false, compressedCount: 0 };
      }

      const uncompressedRows = db
        .prepare(
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
        const updStmt = db.prepare(
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

      db.prepare(
        "INSERT INTO vault_settings (key, value, updated_at) VALUES ('json_zlib_migrated_v1', '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at"
      ).run(this.now());

      const vacRow = db
        .prepare("SELECT value FROM vault_settings WHERE key = 'sqlite_vacuum_diet_v1'")
        .get();
      if (preBytes > thresholdBytes && (!vacRow || vacRow.value !== '1' || compressedCount > 0)) {
        db.prepare(
          "INSERT INTO vault_settings (key, value, updated_at) VALUES ('sqlite_vacuum_diet_v1', '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at"
        ).run(this.now());
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          db.exec('VACUUM;');
          db.exec('PRAGMA journal_mode = WAL;');
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

  onHealthChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  emitHealthChanged(snapshot) {
    for (const listener of this.healthListeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  resolveVaultPaths() {
    const userDataDir = resolveFederatorUserDataDir(this.options);
    const vaultDir = path.join(userDataDir, 'offline-vault');
    return {
      vaultDir,
      blobsDir: path.join(vaultDir, 'blobs'),
      tmpDir: path.join(vaultDir, 'tmp'),
      dbPath: path.join(vaultDir, 'catalog_metadata.sqlite'),
    };
  }

  ensureOpen() {
    const paths = this.resolveVaultPaths();
    if (this.db && this.dbPath === paths.dbPath) {
      return this.db;
    }
    if (this.db && this.dbPath !== paths.dbPath) {
      this.shutdown();
    }

    this.vaultDir = paths.vaultDir;
    this.blobsDir = paths.blobsDir;
    this.tmpDir = paths.tmpDir;
    this.dbPath = paths.dbPath;

    fs.mkdirSync(this.vaultDir, { recursive: true });
    fs.mkdirSync(this.blobsDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });

    // Clean up any orphaned partial temp files from prior crash
    try {
      for (const f of fs.readdirSync(this.tmpDir)) {
        if (f.endsWith('.tmp')) {
          try {
            fs.unlinkSync(path.join(this.tmpDir, f));
          } catch {}
        }
      }
    } catch {}

    const db = new DatabaseSync(this.dbPath);
    db.exec(`
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

      CREATE TABLE IF NOT EXISTS storefront_endpoint_health (
        host TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'CLOSED',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        opened_until INTEGER NOT NULL DEFAULT 0,
        last_status_code INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    try {
      const cols = db.prepare('PRAGMA table_info(vault_games)').all();
      if (Array.isArray(cols)) {
        if (!cols.some((c) => c && c.name === 'archived_by_subscription_rotation')) {
          db.exec(
            'ALTER TABLE vault_games ADD COLUMN archived_by_subscription_rotation INTEGER NOT NULL DEFAULT 0;'
          );
        }
        if (!cols.some((c) => c && c.name === 'media_hydrated_at')) {
          db.exec('ALTER TABLE vault_games ADD COLUMN media_hydrated_at INTEGER DEFAULT 0;');
        }
      }
    } catch (migErr) {
      diagLog.warn('offlineVault.migrateSubscriptionRotationCol', migErr);
    }

    db.prepare(
      "INSERT OR IGNORE INTO vault_settings (key, value, updated_at) VALUES ('tier', 'balanced', ?)"
    ).run(this.now());

    this.db = db;
    this.isShutdown = false;
    this.loadP1RecentGamesFromDb(db);
    this.runStartupSelfHeal(db);
    this.runStartupZlibCompactionIfNeeded(db);
    this.schedulePostInitOrphanSweep();
    return db;
  }

  /**
   * Fast idempotent startup self-heal over `vault_games` & `game_media_assets`:
   * 1. Downgrades poisoned `metadata_quality = 'authoritative'` rows on `steam-*` / `xbox-*` games
   *    whose `enriched_json` lacks a positive numeric `appId` (or comes from Xbox) to `'storefront_native'`.
   * 2. Deletes stale duplicate `xbox-<BigId>` rows when a cross-merged canonical row (e.g. `steam-<appId>`)
   *    already owns that `xboxProductId`.
   */
  runStartupSelfHeal(db) {
    if (!db) return;
    try {
      const authCandidates = db
        .prepare(
          `
          SELECT game_id, platforms_json, summary_json, enriched_json
          FROM vault_games
          WHERE metadata_quality = 'authoritative'
        `
        )
        .all();

      const downgradeStmt = db.prepare(
        "UPDATE vault_games SET metadata_quality = 'storefront_native', enriched_json = ? WHERE game_id = ?"
      );

      for (const row of authCandidates) {
        if (!row || !row.game_id) continue;
        const enriched = parseVaultJson(row.enriched_json);
        const gid = String(row.game_id);
        const summary = parseVaultJson(row.summary_json);
        const platforms = parseVaultJson(row.platforms_json);

        const isXboxOrSteamRow =
          gid.startsWith('steam-') ||
          gid.startsWith('xbox-') ||
          gid.startsWith('xbox_') ||
          hasXboxPlatform({ id: gid, ...summary, platforms: platforms || summary?.platforms });
        if (!isXboxOrSteamRow) continue;

        const hasPosAppId = enriched && Number(enriched.appId) > 0;
        const isExplicitXboxNative =
          enriched &&
          (enriched.enrichedSource === 'xbox' || enriched.metadataQuality === 'storefront_native');

        if (!hasPosAppId || isExplicitXboxNative) {
          let updatedJson = row.enriched_json;
          if (enriched && typeof enriched === 'object') {
            enriched.metadataQuality = 'storefront_native';
            updatedJson = compressVaultJson(JSON.stringify(enriched));
          }
          downgradeStmt.run(updatedJson, gid);
        }
      }

      // Clean up orphaned duplicate `xbox-<BigId>` rows superseded by cross-merged canonical games
      const allGames = db
        .prepare('SELECT game_id, summary_json, platforms_json FROM vault_games')
        .all();
      const deleteAssetsStmt = db.prepare('DELETE FROM game_media_assets WHERE game_id = ?');
      const deleteGameStmt = db.prepare('DELETE FROM vault_games WHERE game_id = ?');

      for (const row of allGames) {
        if (!row || !row.game_id) continue;
        const gid = String(row.game_id);
        if (/^xbox[-_]/i.test(gid)) continue;

        const summary = parseVaultJson(row.summary_json);
        const platforms = parseVaultJson(row.platforms_json);

        const bigIds = extractXboxBigIdsFromGame(summary, platforms);
        for (const bigId of bigIds) {
          const dupVariants = [
            `xbox-${bigId.toLowerCase()}`,
            `xbox-${bigId.toUpperCase()}`,
            `xbox_${bigId.toLowerCase()}`,
            `xbox_${bigId.toUpperCase()}`,
          ];
          for (const dupId of dupVariants) {
            if (dupId !== gid) {
              deleteAssetsStmt.run(dupId);
              deleteGameStmt.run(dupId);
            }
          }
        }
      }

      // Self-heal poisoned cross-storefront, third-party CDN, or mismatched-hash federated asset rows
      const federatedRows = db
        .prepare(
          "SELECT url_key, game_id, source_url, federated_path FROM game_media_assets WHERE storage_kind = 'federated'"
        )
        .all();
      if (Array.isArray(federatedRows) && federatedRows.length > 0) {
        const resetFederatedStmt = db.prepare(
          "UPDATE game_media_assets SET storage_kind = 'pending', federated_path = NULL WHERE url_key = ?"
        );
        const resetHydratedStmt = db.prepare(
          'UPDATE vault_games SET media_hydrated_at = 0 WHERE game_id = ?'
        );
        for (const fedRow of federatedRows) {
          if (!fedRow || !fedRow.url_key) continue;
          if (!isFederatedAssetRowCompatible(fedRow.source_url, fedRow.federated_path, null)) {
            resetFederatedStmt.run(fedRow.url_key);
            if (fedRow.game_id) {
              resetHydratedStmt.run(String(fedRow.game_id));
            }
          }
        }
      }
    } catch (healErr) {
      diagLog.debug('offlineVault.startupSelfHeal', healErr);
    }
  }

  getTier() {
    const db = this.ensureOpen();
    const row = db.prepare("SELECT value FROM vault_settings WHERE key = 'tier'").get();
    const val = row && typeof row.value === 'string' ? row.value : 'balanced';
    return VALID_TIERS.has(val) ? val : 'balanced';
  }

  setTier(tier) {
    const cleanTier = String(tier || '').trim();
    if (!VALID_TIERS.has(cleanTier)) {
      return { success: false, error: `Invalid vault tier: ${cleanTier}` };
    }
    const db = this.ensureOpen();
    db.prepare(
      "INSERT INTO vault_settings (key, value, updated_at) VALUES ('tier', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(cleanTier, this.now());

    const maxBytes = OFFLINE_VAULT_TIER_CAPS[cleanTier];
    this.maybeEvictBlobs({ forceIfOverMax: true, maxBytes });
    return {
      success: true,
      stats: this.getStats(),
    };
  }

  getBlobFilePath(sha256, ext) {
    this.ensureOpen();
    const cleanSha = String(sha256 || '').toLowerCase().trim();
    const cleanExt = String(ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    return path.join(this.blobsDir, cleanSha.slice(0, 2), `${cleanSha}.${cleanExt}`);
  }

  scheduleBlobAccessFlush() {
    if (this.accessFlushTimer) return;
    this.accessFlushTimer = setTimeout(() => {
      this.accessFlushTimer = null;
      this.flushBlobAccessTimestamps();
    }, 10000);
    if (this.accessFlushTimer && typeof this.accessFlushTimer.unref === 'function') {
      this.accessFlushTimer.unref();
    }
  }

  touchBlobAccess(sha256) {
    if (!sha256) return;
    this.pendingBlobAccessMap.set(sha256, this.now());
    if (this.pendingBlobAccessMap.size >= 100) {
      this.flushBlobAccessTimestamps();
    } else {
      this.scheduleBlobAccessFlush();
    }
  }

  flushBlobAccessTimestamps() {
    if (this.accessFlushTimer) {
      try {
        clearTimeout(this.accessFlushTimer);
      } catch {}
      this.accessFlushTimer = null;
    }
    if (!this.db || this.pendingBlobAccessMap.size === 0) {
      this.pendingBlobAccessMap.clear();
      return;
    }
    const entries = Array.from(this.pendingBlobAccessMap.entries());
    this.pendingBlobAccessMap.clear();
    try {
      const stmt = this.db.prepare(
        'UPDATE media_blobs SET last_accessed_at = ? WHERE sha256 = ? AND last_accessed_at < ?'
      );
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const [sha, ts] of entries) {
          stmt.run(ts, sha, ts);
        }
        this.db.exec('COMMIT');
      } catch (txErr) {
        try {
          this.db.exec('ROLLBACK');
        } catch {}
        throw txErr;
      }
    } catch (err) {
      diagLog.debug('offlineVault.flushBlobAccess', err);
    }
  }

  getSqliteDiskBytes() {
    if (!this.dbPath) return 0;
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${this.dbPath}${suffix}`;
      try {
        if (fs.existsSync(p)) {
          total += fs.statSync(p).size || 0;
        }
      } catch {}
    }
    return total;
  }

  getFreeDiskBytes() {
    if (typeof this.options.freeDiskBytesFn === 'function') {
      return Number(this.options.freeDiskBytesFn());
    }
    const now = this.now();
    if (this.cachedFreeDiskBytes !== null && now - this.cachedFreeDiskAt < 30000) {
      return this.cachedFreeDiskBytes;
    }
    let freeBytes = 100 * 1024 * 1024 * 1024;
    try {
      const target = this.vaultDir || resolveFederatorUserDataDir(this.options);
      const launcherEngine = getLazyLauncherEngine();
      let resolvedSync = false;
      if (launcherEngine && typeof launcherEngine.getDiskSpace === 'function') {
        const dsOrPromise = /** @type {any} */ (launcherEngine.getDiskSpace(target));
        if (dsOrPromise && typeof dsOrPromise.then === 'function') {
          dsOrPromise
            .then((/** @type {any} */ ds) => {
              if (ds && typeof ds.freeBytes === 'number') {
                this.cachedFreeDiskBytes = ds.freeBytes;
                this.cachedFreeDiskAt = this.now();
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
    this.cachedFreeDiskBytes = freeBytes;
    this.cachedFreeDiskAt = now;
    return freeBytes;
  }

  getStats() {
    const db = this.ensureOpen();
    const tier = this.getTier();
    const maxBytes = OFFLINE_VAULT_TIER_CAPS[tier];
    const sqliteBytes = this.getSqliteDiskBytes();

    const blobRow = db
      .prepare('SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS bytes FROM media_blobs')
      .get();
    const blobCount = Number(blobRow?.cnt || 0);
    const blobBytes = Number(blobRow?.bytes || 0);

    const fedRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM game_media_assets WHERE storage_kind = 'federated'")
      .get();
    const federatedAssetCount = Number(fedRow?.cnt || 0);

    const gamesRow = db.prepare('SELECT COUNT(*) AS cnt FROM vault_games').get();
    const totalGames = Number(gamesRow?.cnt || 0);

    const enrichedRow = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM vault_games WHERE enriched_json IS NOT NULL AND enriched_json != '' AND metadata_quality != 'skeleton_fallback'"
      )
      .get();
    const enrichedGames = Number(enrichedRow?.cnt || 0);

    const pendingRow = db
      .prepare("SELECT COUNT(*) AS cnt FROM game_media_assets WHERE storage_kind = 'pending'")
      .get();
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

  clear(options = {}) {
    const db = this.ensureOpen();
    this.flushBlobAccessTimestamps();
    const preserveMetadata = Boolean(options && options.preserveMetadata);

    // Remove all stored blob & temp files on disk
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
        this.p1RecentDetailGames.clear();
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

  // ==========================================================================
  // Metadata Persistence (with Non-Destructive Quality Guard + Zlib Compression)
  // ==========================================================================

  registerGameMediaCandidate(
    gameId,
    assetRole,
    ordinal,
    sourceUrl,
    nowTs,
    allowCreatePending = true
  ) {
    if (!sourceUrl || typeof sourceUrl !== 'string') return;
    const cleanUrl = sourceUrl.trim();
    if (!/^https?:\/\//i.test(cleanUrl) || isRejectedVideoUrl(cleanUrl)) return;

    const db = this.ensureOpen();
    const urlKey = buildAssetUrlKey(gameId, assetRole, ordinal, cleanUrl);
    const existing = db
      .prepare('SELECT source_url, storage_kind FROM game_media_assets WHERE url_key = ?')
      .get(urlKey);

    if (!existing) {
      if (!allowCreatePending) return;
      db.prepare(
        `
        INSERT INTO game_media_assets (
          url_key, game_id, asset_role, ordinal, source_url, storage_kind,
          blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, 0, NULL, ?)
      `
      ).run(
        urlKey,
        String(gameId || ''),
        String(assetRole || 'cover'),
        Math.max(0, Math.floor(Number(ordinal) || 0)),
        cleanUrl,
        nowTs
      );
      return;
    }

    // Adaptive 404 & Artwork Upgrade Self-Heal Rule:
    // Whenever normalized asset identity changes (e.g., upgrading Microsoft Store cover -> Steam 2x cover
    // or updating SHA1 asset hash path), reset cached blob pinning when online while preserving Steam CDN mirror aliases!
    if (
      existing.source_url !== cleanUrl &&
      normalizeAssetIdentityUrl(existing.source_url) !== normalizeAssetIdentityUrl(cleanUrl)
    ) {
      if (existing.storage_kind === 'pending' || this.isNetworkOnline()) {
        db.prepare(
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
        ).run(cleanUrl, nowTs, urlKey);
      }
    }
  }

  upsertGames(games) {
    if (!Array.isArray(games)) {
      return { success: false, error: 'Expected array of games' };
    }
    const db = this.ensureOpen();
    const nowTs = this.now();
    let upserted = 0;

    const selectExistingStmt = db.prepare(
      'SELECT steam_app_id, is_favorited, archived_by_subscription_rotation, enriched_json, metadata_quality, enriched_at FROM vault_games WHERE game_id = ?'
    );
    const deleteOrphanAssetsStmt = db.prepare('DELETE FROM game_media_assets WHERE game_id = ?');
    const deleteOrphanGameStmt = db.prepare('DELETE FROM vault_games WHERE game_id = ?');
    const upsertStmt = db.prepare(`
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
    `);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const g of games) {
        if (!g || typeof g !== 'object' || !g.id) continue;
        const gameId = String(g.id).trim();
        if (!gameId) continue;

        const existing = selectExistingStmt.get(gameId);
        const platforms = Array.isArray(g.platforms) ? g.platforms : null;

        // Clean up stale duplicate `xbox-<BigId>` rows when upserting a cross-merged canonical game
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

        const summaryCopy = { ...g };
        delete summaryCopy.enrichedMetadata;
        const summaryJson = compressVaultJson(JSON.stringify(summaryCopy));
        const platformsJson = platforms ? compressVaultJson(JSON.stringify(platforms)) : null;

        const incomingEnriched =
          g.enrichedMetadata && typeof g.enrichedMetadata === 'object'
            ? { ...g.enrichedMetadata }
            : null;

        let incomingQuality = inferVaultMetadataQuality(g, incomingEnriched);
        if (!Object.prototype.hasOwnProperty.call(METADATA_QUALITY_RANK, incomingQuality)) {
          incomingQuality = 'skeleton_fallback';
        }

        const existingEnrichedObj =
          existing && existing.enriched_json ? parseVaultJson(existing.enriched_json) : null;

        if (
          incomingEnriched &&
          existingEnrichedObj?.xboxDeliveryHints &&
          !incomingEnriched.xboxDeliveryHints
        ) {
          incomingEnriched.xboxDeliveryHints = existingEnrichedObj.xboxDeliveryHints;
        }

        const incomingEnrichedJson = incomingEnriched
          ? compressVaultJson(JSON.stringify(incomingEnriched))
          : null;

        let finalEnrichedJson = incomingEnrichedJson;
        let finalQuality = incomingQuality;
        let finalEnrichedAt = incomingEnrichedJson ? nowTs : 0;

        if (existing && existing.enriched_json) {
          let existingQuality = String(existing.metadata_quality || 'skeleton_fallback');
          // Self-heal previously poisoned Xbox/cross-merged 'authoritative' rows lacking positive appId
          if (
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
          if (!incomingEnrichedJson || existingRank > incomingRank) {
            finalEnrichedJson = compressVaultJson(existing.enriched_json);
            finalQuality = existingQuality;
            finalEnrichedAt = Number(existing.enriched_at || nowTs);
          }
        }

        const archivedByRotation =
          g.archivedBySubscriptionRotation === true ? 1 : 0;

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

        const activeEnriched =
          finalEnrichedJson === incomingEnrichedJson ? incomingEnriched : existingEnrichedObj;
        const coverCandidate = g.capsuleImage || activeEnriched?.capsuleImage;
        const headerCandidate = g.headerImage || activeEnriched?.headerImage;
        const iconCandidate = g.iconUrl || activeEnriched?.iconUrl;
        const isHighPriorityDetailTier =
          isInstalled === 1 ||
          g.isPinned === true ||
          this.isP1DetailGame(gameId) ||
          (isFavorited === 1 && this.p1RecentDetailGames.size < MAX_P1_RECENT_DETAIL_GAMES);

        if (typeof coverCandidate === 'string') {
          this.registerGameMediaCandidate(gameId, 'cover', 0, coverCandidate, nowTs, true);
        }
        if (typeof headerCandidate === 'string') {
          this.registerGameMediaCandidate(
            gameId,
            'header',
            0,
            headerCandidate,
            nowTs,
            isHighPriorityDetailTier
          );
        }
        if (typeof iconCandidate === 'string') {
          this.registerGameMediaCandidate(gameId, 'icon', 0, iconCandidate, nowTs, true);
        }
        if (activeEnriched && Array.isArray(activeEnriched.screenshots)) {
          const maxShots = isInstalled === 1 || g.isPinned === true ? 6 : 4;
          activeEnriched.screenshots.slice(0, maxShots).forEach((shot, idx) => {
            const thumbUrl =
              typeof shot === 'string' ? shot : shot?.pathThumbnail || shot?.pathFull || '';
            if (thumbUrl) {
              this.registerGameMediaCandidate(
                gameId,
                'screenshot_thumb',
                idx,
                thumbUrl,
                nowTs,
                isHighPriorityDetailTier
              );
            }
          });
        }

        upserted++;
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

    return { success: true, upserted };
  }

  /**
   * Expands a candidate gameId into canonical/legacy separator variants (`:`, `-`, `_`).
   * @param {Set<string>} targetSet
   * @param {unknown} rawId
   */
  collectVaultGameIdVariants(targetSet, rawId) {
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
   * Deletes orphaned or rekeyed game rows from `vault_games` and `game_media_assets`
   * inside a single transaction while keeping content-addressed `media_blobs` intact.
   *
   * @param {string[] | { gameIds?: string[] } | string} gameIdsInput
   */
  deleteGames(gameIdsInput) {
    const rawList = Array.isArray(gameIdsInput)
      ? gameIdsInput
      : gameIdsInput && typeof gameIdsInput === 'object' && Array.isArray(gameIdsInput.gameIds)
        ? gameIdsInput.gameIds
        : typeof gameIdsInput === 'string'
          ? [gameIdsInput]
          : [];

    /** @type {string[]} */
    const safeIds = [];
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

    const db = this.ensureOpen();
    const deleteAssetsStmt = db.prepare('DELETE FROM game_media_assets WHERE game_id = ?');
    const deleteGameStmt = db.prepare('DELETE FROM vault_games WHERE game_id = ?');
    let deleted = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of safeIds) {
        deleteAssetsStmt.run(id);
        const res = deleteGameStmt.run(id);
        if (res && res.changes > 0) {
          deleted += Number(res.changes);
        }
        this.p1RecentDetailGames.delete(id);
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
   * Invalidates stale federated and superseded cover/header media rows when a user metadata
   * or artwork override is saved, preserving content-addressed `media_blobs` and keeping
   * matching `storage_kind = 'blob'` rows intact.
   *
   * @param {string} gameId
   * @param {Record<string, any>} [record]
   * @param {string[]} [extraKeys]
   */
  saveUserOverride(gameId, record = {}, extraKeys = []) {
    const primaryGameId = normalizeSafeVaultGameId(gameId);
    if (!primaryGameId) {
      return { success: false, invalidated: 0 };
    }

    /** @type {Set<string>} */
    const candidateIds = new Set();
    this.collectVaultGameIdVariants(candidateIds, primaryGameId);
    if (record && typeof record === 'object') {
      this.collectVaultGameIdVariants(candidateIds, record.gameId);
      if (record.platformId && record.platformGameId) {
        this.collectVaultGameIdVariants(
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
        this.collectVaultGameIdVariants(candidateIds, `steam-${numSid}`);
      }
      if (Array.isArray(record.purgeKeys)) {
        for (const pk of record.purgeKeys) {
          this.collectVaultGameIdVariants(candidateIds, pk);
        }
      }
    }
    if (Array.isArray(extraKeys)) {
      for (const ek of extraKeys) {
        this.collectVaultGameIdVariants(candidateIds, ek);
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

    const db = this.ensureOpen();
    const selectRowsStmt = db.prepare(
      'SELECT url_key, game_id, asset_role, source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE game_id = ?'
    );
    const resetFederatedOnlyStmt = db.prepare(`
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE url_key = ?
    `);
    const resetFullRowStmt = db.prepare(`
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          blob_sha256 = NULL,
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE url_key = ?
    `);
    const resetHydratedStmt = db.prepare(
      'UPDATE vault_games SET media_hydrated_at = 0 WHERE game_id = ?'
    );

    let invalidated = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const cid of candidateIds) {
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
   * Invalidates federated and cover/header media rows across `gameId` and any removed alias/rekey
   * IDs when a user override is reset/removed, keeping `media_blobs` intact on disk.
   *
   * @param {string} gameId
   * @param {string[]} [extraKeys]
   */
  removeUserOverride(gameId, extraKeys = []) {
    /** @type {Set<string>} */
    const candidateIds = new Set();
    this.collectVaultGameIdVariants(candidateIds, gameId);
    if (Array.isArray(extraKeys)) {
      for (const ek of extraKeys) {
        this.collectVaultGameIdVariants(candidateIds, ek);
      }
    }
    if (candidateIds.size === 0) {
      return { success: false, invalidated: 0 };
    }

    const db = this.ensureOpen();
    const resetCoverHeaderStmt = db.prepare(`
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          blob_sha256 = NULL,
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE game_id = ?
        AND asset_role IN ('cover', 'capsule', 'header', 'hero')
    `);
    const resetFederatedStmt = db.prepare(`
      UPDATE game_media_assets
      SET storage_kind = 'pending',
          federated_path = NULL,
          failure_count = 0,
          next_retry_at = 0,
          last_status_code = NULL
      WHERE game_id = ?
        AND storage_kind = 'federated'
    `);
    const resetHydratedStmt = db.prepare(
      'UPDATE vault_games SET media_hydrated_at = 0 WHERE game_id = ?'
    );

    let invalidated = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const cid of candidateIds) {
        const r1 = resetCoverHeaderStmt.run(cid);
        const r2 = resetFederatedStmt.run(cid);
        const changes = Number(r1?.changes || 0) + Number(r2?.changes || 0);
        if (changes > 0) {
          invalidated += changes;
        }
        resetHydratedStmt.run(cid);
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
   * Non-destructively marks Game Pass / subscription titles that rotated out of the active catalog
   * so cached artwork blobs, achievements, HLTB, and enriched metadata remain preserved offline.
   * @param {string[]} gameIds
   */
  archiveSubscriptionRotatedGames(gameIds = []) {
    if (!Array.isArray(gameIds) || gameIds.length === 0) {
      return { success: true, archived: 0 };
    }
    const db = this.ensureOpen();
    const nowTs = this.now();
    const stmt = db.prepare(
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
   * @param {Record<string, any>} [payload]
   */
  saveGameDetail(payload = {}) {
    if (!payload || typeof payload !== 'object' || !payload.gameId) {
      return { success: false, error: 'Missing gameId' };
    }
    const gameId = String(payload.gameId).trim();
    if (!gameId) {
      return { success: false, error: 'Empty gameId' };
    }

    const db = this.ensureOpen();
    const nowTs = this.now();
    const existing = db
      .prepare(
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

    if (
      incomingEnrichedObj &&
      existingEnrichedObj?.xboxDeliveryHints &&
      !incomingEnrichedObj.xboxDeliveryHints
    ) {
      incomingEnrichedObj.xboxDeliveryHints = existingEnrichedObj.xboxDeliveryHints;
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

    // Non-Destructive Metadata Upsert Rule:
    // NEVER overwrite higher-ranked enriched_json with lower-ranked or empty enriched_json!
    if (existing && existing.enriched_json) {
      let existingQuality = String(existing.metadata_quality || 'skeleton_fallback');
      if (
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
      if (!incomingEnrichedJson || existingRank > incomingRank) {
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
    const finalCriticJson =
      payload.criticScore !== undefined && payload.criticScore !== null
        ? compressVaultJson(JSON.stringify(payload.criticScore))
        : existing?.critic_json
          ? compressVaultJson(existing.critic_json)
          : null;

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

    db.prepare(
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
    ).run(
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

    // Register static image assets from enrichedMetadata (strictly ZERO video URLs!)
    if (incomingEnrichedObj) {
      const isHighPriorityDetailTier =
        isInstalled === 1 ||
        payload.promoteToP1 === true ||
        this.isP1DetailGame(gameId) ||
        (isFavorited === 1 && this.p1RecentDetailGames.size < MAX_P1_RECENT_DETAIL_GAMES);

      if (typeof incomingEnrichedObj.capsuleImage === 'string') {
        this.registerGameMediaCandidate(
          gameId,
          'cover',
          0,
          incomingEnrichedObj.capsuleImage,
          nowTs,
          true
        );
      }
      if (typeof incomingEnrichedObj.headerImage === 'string') {
        this.registerGameMediaCandidate(
          gameId,
          'header',
          0,
          incomingEnrichedObj.headerImage,
          nowTs,
          isHighPriorityDetailTier
        );
      }
      if (Array.isArray(incomingEnrichedObj.screenshots)) {
        const maxShots = isInstalled === 1 ? 6 : 4;
        incomingEnrichedObj.screenshots.slice(0, maxShots).forEach((shot, idx) => {
          const thumbUrl =
            typeof shot === 'string' ? shot : shot?.pathThumbnail || shot?.pathFull || '';
          if (thumbUrl) {
            this.registerGameMediaCandidate(
              gameId,
              'screenshot_thumb',
              idx,
              thumbUrl,
              nowTs,
              isHighPriorityDetailTier
            );
          }
        });
      }
    }

    return { success: true };
  }

  /**
   * Durably stamps `media_hydrated_at` on `vault_games` once static image hydration completes
   * (including 0-asset games whose media URLs were all video-excluded or already verified).
   *
   * @param {string} gameId
   * @param {number} [hydratedAt]
   */
  markGameMediaHydrated(gameId, hydratedAt = this.now()) {
    const cleanId = String(gameId || '').trim();
    if (!cleanId || this.isShutdown) {
      return { success: false, updated: 0 };
    }
    try {
      const db = this.db || this.ensureOpen();
      if (!db) {
        return { success: false, updated: 0 };
      }
      const ts =
        typeof hydratedAt === 'number' && Number.isFinite(hydratedAt) && hydratedAt >= 0
          ? Math.floor(hydratedAt)
          : this.now();
      const res = db
        .prepare('UPDATE vault_games SET media_hydrated_at = ? WHERE game_id = ?')
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

  getGameDetail(gameId) {
    const cleanId = String(gameId || '').trim();
    if (!cleanId) return null;
    const db = this.ensureOpen();
    const row = db
      .prepare(
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

  getCatalogSnapshot(options = {}) {
    const db = this.ensureOpen();
    const includeArchived = Boolean(options && options.includeArchived);
    const rows = db
      .prepare(
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
    const games = [];
    /** @type {Record<string, any>} */
    const details = {};

    for (const row of rows) {
      const isArchivedRotation = Number(row.archived_by_subscription_rotation || 0) === 1;
      const isRowInstalled = Number(row.is_installed || 0) === 1;
      if (isArchivedRotation && !isRowInstalled && !includeArchived) {
        continue;
      }

      const summary = parseVaultJson(row.summary_json) || {};
      const platforms = parseVaultJson(row.platforms_json) || summary.platforms || [];
      const enrichedMetadata = parseVaultJson(row.enriched_json);
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

    return {
      success: true,
      games,
      details,
    };
  }

  // ==========================================================================
  // Per-Host Circuit Breaker + WAF Detection + Adaptive 404 Curve
  // ==========================================================================

  getEndpointHealth(host) {
    const cleanHost = String(host || '').toLowerCase().trim();
    if (!cleanHost) return null;
    const db = this.ensureOpen();
    const row = db
      .prepare('SELECT * FROM storefront_endpoint_health WHERE host = ?')
      .get(cleanHost);
    if (!row) {
      return {
        host: cleanHost,
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedUntil: 0,
      };
    }
    const nowTs = this.now();
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

  canRequestHost(host) {
    const cleanHost = String(host || '').toLowerCase().trim();
    if (!cleanHost) return { allowed: true, state: 'CLOSED', isCanary: false };

    const snap = this.getEndpointHealth(cleanHost);
    if (!snap || snap.state === 'CLOSED') {
      return { allowed: true, state: 'CLOSED', isCanary: false };
    }

    const nowTs = this.now();
    if (snap.state === 'OPEN' && snap.openedUntil > nowTs) {
      return {
        allowed: false,
        state: 'OPEN',
        isCanary: false,
        retryAfterMs: snap.openedUntil - nowTs,
      };
    }

    // HALF_OPEN: allow strictly 1 single-canary probe per host
    if (this.halfOpenProbesInFlight.has(cleanHost)) {
      return {
        allowed: false,
        state: 'HALF_OPEN',
        isCanary: false,
        retryAfterMs: 5000,
      };
    }

    this.halfOpenProbesInFlight.add(cleanHost);
    const db = this.ensureOpen();
    db.prepare(
      "UPDATE storefront_endpoint_health SET state = 'HALF_OPEN', updated_at = ? WHERE host = ?"
    ).run(nowTs, cleanHost);

    return {
      allowed: true,
      state: 'HALF_OPEN',
      isCanary: true,
    };
  }

  releaseCanaryIfHeld(host) {
    const cleanHost = String(host || '').toLowerCase().trim();
    if (cleanHost) {
      this.halfOpenProbesInFlight.delete(cleanHost);
    }
  }

  recordHostSuccess(host, statusCode = 200) {
    const cleanHost = String(host || '').toLowerCase().trim();
    if (!cleanHost) return;
    this.halfOpenProbesInFlight.delete(cleanHost);

    const db = this.ensureOpen();
    const prev = db
      .prepare('SELECT state, consecutive_failures FROM storefront_endpoint_health WHERE host = ?')
      .get(cleanHost);

    if (!prev || (prev.state === 'CLOSED' && Number(prev.consecutive_failures || 0) === 0)) {
      return;
    }

    const nowTs = this.now();
    db.prepare(
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
    ).run(cleanHost, statusCode, nowTs);

    this.emitHealthChanged({
      host: cleanHost,
      state: 'CLOSED',
      consecutiveFailures: 0,
      openedUntil: 0,
      lastStatusCode: statusCode,
    });
  }

  recordHostWafBlock(host, statusCode = 403, retryAfterMs = 0, errorMsg = 'WAF or rate limit block') {
    const cleanHost = String(host || '').toLowerCase().trim();
    if (!cleanHost) return null;
    this.halfOpenProbesInFlight.delete(cleanHost);

    const db = this.ensureOpen();
    const nowTs = this.now();
    const prev = db
      .prepare('SELECT consecutive_failures FROM storefront_endpoint_health WHERE host = ?')
      .get(cleanHost);
    const failures = Number(prev?.consecutive_failures || 0) + 1;

    // Cooldown curve: Retry-After if provided, else 15m -> 30m -> 60m (+ small positive jitter)
    const baseMs =
      retryAfterMs > 0
        ? retryAfterMs
        : failures === 1
          ? 15 * 60 * 1000
          : failures === 2
            ? 30 * 60 * 1000
            : 60 * 60 * 1000;
    const jitterMs = this.options.disableJitter ? 0 : Math.floor(Math.random() * 5000);
    const openedUntil = nowTs + baseMs + jitterMs;

    db.prepare(
      `
      INSERT INTO storefront_endpoint_health (
        host, state, consecutive_failures, opened_until, last_status_code, last_error, updated_at
      ) VALUES (?, 'OPEN', ?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        state = 'OPEN',
        consecutive_failures = excluded.consecutive_failures,
        opened_until = excluded.opened_until,
        last_status_code = excluded.last_status_code,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `
    ).run(cleanHost, failures, openedUntil, statusCode, String(errorMsg), nowTs);

    const snapshot = {
      host: cleanHost,
      state: 'OPEN',
      consecutiveFailures: failures,
      openedUntil,
      lastStatusCode: statusCode,
      lastError: String(errorMsg),
    };
    this.emitHealthChanged(snapshot);
    return snapshot;
  }

  recordHostFailure(host, statusCode = null, errorMsg = 'Transient upstream failure') {
    const cleanHost = String(host || '').toLowerCase().trim();
    if (!cleanHost) return null;
    const wasCanary = this.halfOpenProbesInFlight.delete(cleanHost);

    const db = this.ensureOpen();
    const nowTs = this.now();
    const prev = db
      .prepare('SELECT state, consecutive_failures FROM storefront_endpoint_health WHERE host = ?')
      .get(cleanHost);
    const failures = Number(prev?.consecutive_failures || 0) + 1;

    // Trip OPEN after >= 3 consecutive 5xx/timeout failures (or immediately if HALF_OPEN canary failed): 30s -> 2m -> 10m
    const shouldTripOpen = failures >= 3 || wasCanary || prev?.state === 'HALF_OPEN';
    const nextState = shouldTripOpen ? 'OPEN' : 'CLOSED';
    let openedUntil = 0;
    if (shouldTripOpen) {
      const backoffMs =
        failures <= 3 ? 30 * 1000 : failures === 4 ? 2 * 60 * 1000 : 10 * 60 * 1000;
      openedUntil = nowTs + backoffMs;
    }

    db.prepare(
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
    ).run(cleanHost, nextState, failures, openedUntil, statusCode, String(errorMsg), nowTs);

    const snapshot = {
      host: cleanHost,
      state: nextState,
      consecutiveFailures: failures,
      openedUntil,
      ...(statusCode !== null && statusCode !== undefined ? { lastStatusCode: statusCode } : {}),
      lastError: String(errorMsg),
    };
    if (shouldTripOpen) {
      this.emitHealthChanged(snapshot);
    }
    return snapshot;
  }

  recordAssetAdaptive404(urlKey, gameId, assetRole, ordinal, sourceUrl) {
    const db = this.ensureOpen();
    const nowTs = this.now();
    const existing = db
      .prepare('SELECT failure_count, source_url FROM game_media_assets WHERE url_key = ?')
      .get(urlKey);

    const prevFailures =
      existing && existing.source_url === sourceUrl ? Number(existing.failure_count || 0) : 0;
    const nextFailures = prevFailures + 1;
    const delayMs = computeAdaptive404DelayMs(nextFailures);
    const nextRetryAt = nowTs + delayMs;

    db.prepare(
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
    ).run(
      urlKey,
      String(gameId || ''),
      String(assetRole || 'cover'),
      Math.max(0, Math.floor(Number(ordinal) || 0)),
      String(sourceUrl || ''),
      nextFailures,
      nextRetryAt,
      nowTs
    );

    return {
      failureCount: nextFailures,
      nextRetryAt,
      delayMs,
    };
  }

  // ==========================================================================
  // Zero-Addon Image Normalization + Content-Addressed Storage + LRU Eviction
  // ==========================================================================

  normalizeImageBuffer(rawBuffer, roleOrContentType = 'cover', maybeRole) {
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

    const isAlphaSensitiveRole = assetRole === 'icon' || assetRole === 'logo';
    const effectivePassThroughBytes =
      isAlphaSensitiveRole && ext === 'png'
        ? TRANSPARENT_PNG_PASS_THROUGH_MAX_BYTES
        : PASS_THROUGH_MAX_BYTES;

    // Fast 0%-CPU pass-through for webp, avif, ico, <=45KB jpg/png (<=256KB for icon/logo png), and <=128KB static gif
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

    // Oversized static PNG/JPEG (>45KB) or oversized static single-frame GIF (>128KB): resize via Electron nativeImage
    const nativeImageImpl = this.options.nativeImage || electron.nativeImage;
    if (nativeImageImpl && typeof nativeImageImpl.createFromBuffer === 'function') {
      try {
        let img = nativeImageImpl.createFromBuffer(rawBuffer);
        if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
          const maxWidth = ROLE_MAX_WIDTHS[assetRole] || 800;
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
          if (isAlphaSensitiveRole && ext === 'png' && typeof img.toPNG === 'function') {
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

    // Fallback when running in pure Node without Electron nativeImage
    return {
      valid: true,
      buffer: rawBuffer,
      ext,
      mimeType,
      normalized: false,
    };
  }

  async normalizeImageBufferAsync(rawBuffer, roleOrContentType = 'cover', maybeRole) {
    if (Buffer.isBuffer(rawBuffer) && rawBuffer.length > PASS_THROUGH_MAX_BYTES) {
      await yieldEventLoop();
    }
    const result = this.normalizeImageBuffer(rawBuffer, roleOrContentType, maybeRole);
    if (result.normalized) {
      await yieldEventLoop();
    }
    return result;
  }

  storeNormalizedBlob(rawBuffer, assetRole = 'cover', upstreamContentType = '') {
    const norm = this.normalizeImageBuffer(rawBuffer, upstreamContentType || assetRole, assetRole);
    if (!norm.valid || !norm.buffer) {
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

    const freeBytes = this.getFreeDiskBytes();
    if (freeBytes < MIN_FREE_DISK_BYTES_FOR_BLOBS) {
      return {
        stored: false,
        reason: 'low_disk_space',
        buffer: norm.buffer,
        ext: norm.ext,
        mimeType: norm.mimeType,
      };
    }

    const db = this.ensureOpen();
    const nowTs = this.now();
    const finalBuf = norm.buffer;
    const sha256 = crypto.createHash('sha256').update(finalBuf).digest('hex');
    const targetPath = this.getBlobFilePath(sha256, norm.ext);

    if (!fs.existsSync(targetPath)) {
      const subDir = path.dirname(targetPath);
      fs.mkdirSync(subDir, { recursive: true });
      const tmpFile = path.join(
        this.tmpDir,
        `${sha256}.${process.pid}.${nowTs}.${Math.random().toString(36).slice(2, 7)}.tmp`
      );
      try {
        fs.writeFileSync(tmpFile, finalBuf);
        fs.renameSync(tmpFile, targetPath);
      } catch (writeErr) {
        try {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch {}
        fs.writeFileSync(targetPath, finalBuf);
      }
    }

    db.prepare(
      `
      INSERT INTO media_blobs (sha256, ext, mime_type, size_bytes, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        last_accessed_at = excluded.last_accessed_at
    `
    ).run(sha256, norm.ext, norm.mimeType, finalBuf.length, nowTs, nowTs);

    this.maybeEvictBlobs();

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

  async storeNormalizedBlobAsync(rawBuffer, assetRole = 'cover', upstreamContentType = '') {
    const norm = await this.normalizeImageBufferAsync(
      rawBuffer,
      upstreamContentType || assetRole,
      assetRole
    );
    if (!norm.valid || !norm.buffer) {
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

    const freeBytes = this.getFreeDiskBytes();
    if (freeBytes < MIN_FREE_DISK_BYTES_FOR_BLOBS) {
      return {
        stored: false,
        reason: 'low_disk_space',
        buffer: norm.buffer,
        ext: norm.ext,
        mimeType: norm.mimeType,
      };
    }

    const db = this.ensureOpen();
    const nowTs = this.now();
    const finalBuf = norm.buffer;
    const sha256 = crypto.createHash('sha256').update(finalBuf).digest('hex');
    const targetPath = this.getBlobFilePath(sha256, norm.ext);

    if (!fs.existsSync(targetPath)) {
      const subDir = path.dirname(targetPath);
      await fs.promises.mkdir(subDir, { recursive: true });
      const tmpFile = path.join(
        this.tmpDir,
        `${sha256}.${process.pid}.${nowTs}.${Math.random().toString(36).slice(2, 7)}.tmp`
      );
      try {
        await fs.promises.writeFile(tmpFile, finalBuf);
        await fs.promises.rename(tmpFile, targetPath);
      } catch {
        try {
          await fs.promises.unlink(tmpFile);
        } catch {}
        await fs.promises.writeFile(targetPath, finalBuf);
      }
    }

    db.prepare(
      `
      INSERT INTO media_blobs (sha256, ext, mime_type, size_bytes, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        last_accessed_at = excluded.last_accessed_at
    `
    ).run(sha256, norm.ext, norm.mimeType, finalBuf.length, nowTs, nowTs);

    this.maybeEvictBlobs();

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
   * Unconditional Orphan & Legacy P2 Non-Cover Blob Garbage Collector (NO 4 GB threshold).
   * 1. Demotes/unpins legacy non-(cover|capsule|icon) blobs cached for uninstalled P2 games
   *    outside the active P1 40-game detail LRU window.
   * 2. Deletes unreferenced `media_blobs` rows and their on-disk files.
   * 3. Scans `offline-vault/blobs` and unlinks any untracked files missing from `media_blobs`.
   * 4. Reclaims freelist pages via `PRAGMA incremental_vacuum`.
   */
  sweepOrphanBlobs(options = {}) {
    const db = this.ensureOpen();
    this.flushBlobAccessTimestamps();
    const nowTs = this.now();
    const thirtyDaysAgo = nowTs - 30 * 24 * 60 * 60 * 1000;
    const reclaimLegacyP2NonCover = options.reclaimLegacyP2NonCover !== false;

    let p2AssetsDemoted = 0;
    let orphanBlobsRemoved = 0;
    let untrackedFilesRemoved = 0;
    let freedBytes = 0;

    if (reclaimLegacyP2NonCover) {
      const protectedP0OrP1Ids = new Set(this.p1RecentDetailGames.keys());
      const gameRows = db
        .prepare(
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
        if (
          Number(gr.is_favorited || 0) === 1 &&
          favAdded < MAX_P1_RECENT_DETAIL_GAMES
        ) {
          protectedP0OrP1Ids.add(gid);
          favAdded++;
        }
      }

      const nonCoverRows = db
        .prepare(
          `
          SELECT url_key, game_id, failure_count, next_retry_at
          FROM game_media_assets
          WHERE asset_role NOT IN ('cover', 'capsule', 'icon')
            AND storage_kind != 'federated'
        `
        )
        .all();

      const deleteAssetKeyStmt = db.prepare('DELETE FROM game_media_assets WHERE url_key = ?');
      const unpinBackoffKeyStmt = db.prepare(
        "UPDATE game_media_assets SET storage_kind = 'pending', blob_sha256 = NULL WHERE url_key = ?"
      );

      db.exec('BEGIN IMMEDIATE');
      try {
        for (const ar of nonCoverRows) {
          const gid = String(ar.game_id || '').trim();
          if (!gid || protectedP0OrP1Ids.has(gid)) continue;
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

    // Remove unreferenced `media_blobs` rows (or rows whose disk blob disappeared)
    const unrefBlobs = db
      .prepare(
        `
        SELECT mb.sha256 AS sha256, mb.ext AS ext, mb.size_bytes AS size_bytes
        FROM media_blobs mb
        LEFT JOIN game_media_assets gma ON gma.blob_sha256 = mb.sha256
        WHERE gma.url_key IS NULL
      `
      )
      .all();

    const deleteBlobStmt = db.prepare('DELETE FROM media_blobs WHERE sha256 = ?');
    for (const ub of unrefBlobs) {
      const fp = this.getBlobFilePath(ub.sha256, ub.ext);
      let actualRemoved = 0;
      try {
        if (fs.existsSync(fp)) {
          actualRemoved = fs.statSync(fp).size || Number(ub.size_bytes || 0);
          fs.unlinkSync(fp);
        } else {
          actualRemoved = Number(ub.size_bytes || 0);
        }
      } catch {}
      try {
        deleteBlobStmt.run(ub.sha256);
        orphanBlobsRemoved++;
        freedBytes += actualRemoved;
      } catch {}
    }

    // Walk `this.blobsDir` and remove any untracked files on disk not present in `media_blobs`
    const validBlobFiles = new Set();
    const allTrackedBlobs = db.prepare('SELECT sha256, ext FROM media_blobs').all();
    for (const row of allTrackedBlobs) {
      if (!row || !row.sha256) continue;
      const cleanSha = String(row.sha256).toLowerCase().trim();
      const cleanExt = String(row.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      validBlobFiles.add(`${cleanSha}.${cleanExt}`);
    }

    if (this.blobsDir && fs.existsSync(this.blobsDir)) {
      try {
        for (const shardEnt of fs.readdirSync(this.blobsDir, { withFileTypes: true })) {
          const shardPath = path.join(this.blobsDir, shardEnt.name);
          if (shardEnt.isFile()) {
            if (!validBlobFiles.has(shardEnt.name.toLowerCase())) {
              try {
                const sz = fs.statSync(shardPath).size || 0;
                fs.unlinkSync(shardPath);
                untrackedFilesRemoved++;
                freedBytes += sz;
              } catch {}
            }
            continue;
          }
          if (!shardEnt.isDirectory()) continue;
          let remainingChildren = 0;
          try {
            const files = fs.readdirSync(shardPath, { withFileTypes: true });
            for (const fEnt of files) {
              const fPath = path.join(shardPath, fEnt.name);
              if (fEnt.isFile() && !validBlobFiles.has(fEnt.name.toLowerCase())) {
                try {
                  const sz = fs.statSync(fPath).size || 0;
                  fs.unlinkSync(fPath);
                  untrackedFilesRemoved++;
                  freedBytes += sz;
                } catch {
                  remainingChildren++;
                }
              } else {
                remainingChildren++;
              }
            }
            if (remainingChildren === 0) {
              try {
                fs.rmdirSync(shardPath);
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }

    try {
      db.exec('PRAGMA incremental_vacuum;');
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {}

    return {
      success: true,
      p2AssetsDemoted,
      orphanBlobsRemoved,
      untrackedFilesRemoved,
      freedBytes,
      stats: this.getStats(),
    };
  }

  enforceQuota(options = {}) {
    const evictRes = this.maybeEvictBlobs({ forceIfOverMax: true, ...options });
    return {
      success: true,
      ...evictRes,
      stats: this.getStats(),
    };
  }

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

  compactVault(options = {}) {
    const db = this.ensureOpen();
    const preSqliteBytes = this.getSqliteDiskBytes();
    const reclaim = this.reclaimUnusedCache(options);
    const zlibCompaction = this.runStartupZlibCompactionIfNeeded(db, { force: true });
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.exec('VACUUM;');
      db.exec('PRAGMA journal_mode = WAL;');
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

  /**
   * Evicts unpinned LRU blobs when usage hits >= 95% of tier cap (or > maxBytes after tier change)
   * down to 80% of tier cap. Installed games' cover/header/icon/logo/hero blobs (rank 100) are NEVER evicted,
   * and P2/P1 non-cover detail blobs are always evicted before active library covers.
   */
  maybeEvictBlobs(opts = {}) {
    const db = this.ensureOpen();
    this.flushBlobAccessTimestamps();

    const tier = this.getTier();
    const maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : OFFLINE_VAULT_TIER_CAPS[tier];
    const sqliteBytes = this.getSqliteDiskBytes();
    const sumRow = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media_blobs').get();
    let currentBlobBytes = Number(sumRow?.bytes || 0);
    let currentTotalBytes = sqliteBytes + currentBlobBytes;

    const triggerThreshold = opts.forceIfOverMax ? maxBytes : Math.floor(maxBytes * 0.95);
    if (currentTotalBytes < triggerThreshold) {
      return { evictedCount: 0, freedBytes: 0 };
    }

    const targetTotalBytes = Math.floor(maxBytes * 0.8);

    // Retention priority rank:
    // 100 = PINNED (installed game cover/capsule/header/hero/logo/icon)
    //  65 = installed game screenshots / inline images
    //  55 = active library cover / capsule / icon
    //  40 = uninstalled header / hero / logo
    //  30 = screenshot_thumb / screenshot
    //  20 = inline_img / inline_poster
    //  10 = screenshot_full
    //   0 = orphaned blob
    const candidates = db
      .prepare(
        `
        SELECT
          mb.sha256 AS sha256,
          mb.ext AS ext,
          mb.size_bytes AS size_bytes,
          mb.last_accessed_at AS last_accessed_at,
          COALESCE(MAX(
            CASE
              WHEN vg.is_installed = 1 AND gma.asset_role IN ('cover', 'capsule', 'header', 'hero', 'logo', 'icon') THEN 100
              WHEN vg.is_installed = 1 AND gma.url_key IS NOT NULL THEN 65
              WHEN gma.asset_role IN ('cover', 'capsule') THEN 55
              WHEN gma.asset_role = 'icon' THEN 50
              WHEN gma.asset_role IN ('header', 'hero', 'logo') THEN 40
              WHEN gma.asset_role IN ('screenshot_thumb', 'screenshot') THEN 30
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

    let evictedCount = 0;
    let freedBytes = 0;

    const resetAssetStmt = db.prepare(
      "UPDATE game_media_assets SET storage_kind = 'pending', blob_sha256 = NULL WHERE blob_sha256 = ?"
    );
    const deleteBlobStmt = db.prepare('DELETE FROM media_blobs WHERE sha256 = ?');

    for (const cand of candidates) {
      if (currentTotalBytes <= targetTotalBytes) break;
      const blobFile = this.getBlobFilePath(cand.sha256, cand.ext);
      try {
        if (fs.existsSync(blobFile)) {
          fs.unlinkSync(blobFile);
        }
      } catch {}

      db.exec('BEGIN IMMEDIATE');
      try {
        resetAssetStmt.run(cand.sha256);
        deleteBlobStmt.run(cand.sha256);
        db.exec('COMMIT');
        const sz = Number(cand.size_bytes || 0);
        currentBlobBytes = Math.max(0, currentBlobBytes - sz);
        currentTotalBytes = sqliteBytes + currentBlobBytes;
        freedBytes += sz;
        evictedCount++;
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {}
      }
    }

    return { evictedCount, freedBytes };
  }

  // ==========================================================================
  // `ol-media://` Resolution & Upstream Persist-on-Read
  // ==========================================================================

  getFetchImpl() {
    if (typeof this.options.fetchImpl === 'function') {
      return this.options.fetchImpl;
    }
    if (electron.net && typeof electron.net.fetch === 'function') {
      return electron.net.fetch.bind(electron.net);
    }
    return globalThis.fetch;
  }

  isAssetAlreadyHydratedOrBackedOff(params = {}) {
    const db = this.ensureOpen();
    const gameId = String(params.gameId || '').trim();
    const role = String(params.role || 'cover').trim();
    const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
    const sourceUrl = String(params.url || '').trim();
    const urlKey = buildAssetUrlKey(gameId, role, ordinal, sourceUrl);

    const row = db.prepare('SELECT * FROM game_media_assets WHERE url_key = ?').get(urlKey);
    if (!row) return false;

    if (
      sourceUrl &&
      row.source_url &&
      normalizeAssetIdentityUrl(row.source_url) !== normalizeAssetIdentityUrl(sourceUrl)
    ) {
      return false;
    }

    if (row.storage_kind === 'blob' && row.blob_sha256) {
      const mb = db
        .prepare('SELECT ext FROM media_blobs WHERE sha256 = ?')
        .get(row.blob_sha256);
      if (mb && fs.existsSync(this.getBlobFilePath(row.blob_sha256, mb.ext))) {
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

    if (row.next_retry_at && Number(row.next_retry_at) > this.now()) {
      return true;
    }

    return false;
  }

  isAssetBackedOffFailure(params = {}) {
    if (this.isShutdown) return false;
    const db = this.db || this.ensureOpen();
    if (!db) return false;
    const gameId = String(params.gameId || '').trim();
    const role = String(params.role || 'cover').trim();
    const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
    const sourceUrl = String(params.url || '').trim();
    const urlKey = buildAssetUrlKey(gameId, role, ordinal, sourceUrl);

    const row = db
      .prepare(
        'SELECT storage_kind, failure_count, next_retry_at FROM game_media_assets WHERE url_key = ?'
      )
      .get(urlKey);
    if (!row || row.storage_kind !== 'pending') return false;
    return Number(row.failure_count || 0) > 0 || Number(row.next_retry_at || 0) > this.now();
  }

  bindAssetBlobRow(urlKey, gameId, role, ordinal, rawUrl, sha256) {
    this.ensureOpen()
      .prepare(
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
      .run(urlKey, gameId, role, ordinal, rawUrl, sha256, this.now());
  }

  /**
   * Resolves a media asset request for `ol-media://` or `MediaHydrationEngine` across:
   * 1. Content-addressed SQLite blob vault / verified federated path
   * 2. Zero-copy local first-party cache federation (Steam, GOG Galaxy, Heroic, Xbox)
   * 3. Reference-counted `AbortSignal`-coalesced upstream fetch + async normalization + persist-on-read
   *
   * @param {Record<string, any> | string | URL} paramsInput
   * @param {{ signal?: AbortSignal, backgroundHydration?: boolean, hydrationTier?: number, throwOnAbort?: boolean }} [reqOpts]
   */
  async resolveMediaRequest(paramsInput = {}, reqOpts = {}) {
    /** @type {Record<string, any>} */
    let params = {};
    if (typeof paramsInput === 'string' || paramsInput instanceof URL) {
      try {
        const parsedReq = new URL(String(paramsInput));
        const sp = parsedReq.searchParams;
        params = {
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
        params = {};
      }
    } else if (paramsInput && typeof paramsInput === 'object') {
      params = paramsInput;
    }

    const gameId = String(params.gameId || '').trim();
    const role = String(params.role || 'cover').trim();
    const ordinal = Math.max(0, Math.floor(Number(params.ordinal ?? params.ord ?? 0)));
    const rawUrl = typeof params.url === 'string' ? params.url.trim() : '';
    const isExplicitOverride = isExplicitOverrideParam(params.ov);

    // Strict zero-video mandate: NEVER download, cache, or serve video trailer blobs!
    if (rawUrl && isRejectedVideoUrl(rawUrl)) {
      return { kind: 'error', status: 415, reason: 'video_caching_prohibited' };
    }

    const db = this.ensureOpen();

    // On-demand detail-page asset view (`ol-media://` without backgroundHydration) promotes game into P1 40-game LRU
    if (
      !reqOpts.backgroundHydration &&
      gameId &&
      ['header', 'hero', 'logo', 'screenshot', 'screenshot_thumb', 'screenshot_full'].includes(role)
    ) {
      this.recordP1DetailGame(gameId);
      if (this.hydrationEngine && typeof this.hydrationEngine.recordP1DetailView === 'function') {
        try {
          this.hydrationEngine.recordP1DetailView(gameId);
        } catch {}
      }
    }

    const nowTs = this.now();
    const urlKey = buildAssetUrlKey(gameId, role, ordinal, rawUrl);

    let assetRow = db.prepare('SELECT * FROM game_media_assets WHERE url_key = ?').get(urlKey);
    if (!assetRow && rawUrl) {
      assetRow = db
        .prepare(
          "SELECT * FROM game_media_assets WHERE source_url = ? AND storage_kind IN ('blob', 'federated') LIMIT 1"
        )
        .get(rawUrl);
    }

    // Track prior blob in case an upgraded URL fails strictly due to transient offline network loss
    let offlineFallbackBlobSha = null;
    let offlineFallbackPrevSourceUrl = '';

    // When asset identity changes (e.g., upgrading Microsoft Store cover -> Steam 2x portrait cover
    // or SHA1 hashed asset path), unpin stale cached blob when online so the upgraded image is fetched,
    // while keeping Steam CDN mirror aliases and offline safety intact!
    if (
      assetRow &&
      assetRow.url_key === urlKey &&
      rawUrl &&
      assetRow.source_url &&
      assetRow.source_url !== rawUrl &&
      normalizeAssetIdentityUrl(assetRow.source_url) !== normalizeAssetIdentityUrl(rawUrl)
    ) {
      const onlineNow = this.isNetworkOnline();
      if (assetRow.storage_kind === 'blob' && assetRow.blob_sha256) {
        offlineFallbackBlobSha = String(assetRow.blob_sha256);
        offlineFallbackPrevSourceUrl = String(assetRow.source_url);
      }

      if (assetRow.storage_kind === 'pending' || onlineNow) {
        db.prepare(
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
        ).run(rawUrl, nowTs, urlKey);
        assetRow = db.prepare('SELECT * FROM game_media_assets WHERE url_key = ?').get(urlKey);
      }
    }

    // Tier 1A: Existing content-addressed blob hit
    if (assetRow && assetRow.storage_kind === 'blob' && assetRow.blob_sha256) {
      const mb = db
        .prepare('SELECT sha256, ext, mime_type, size_bytes FROM media_blobs WHERE sha256 = ?')
        .get(assetRow.blob_sha256);
      if (mb) {
        const blobPath = this.getBlobFilePath(mb.sha256, mb.ext);
        if (
          isContainedWithinRoot(this.blobsDir, blobPath, this.options.platform) &&
          fs.existsSync(blobPath)
        ) {
          this.touchBlobAccess(mb.sha256);
          return {
            kind: 'file',
            filePath: blobPath,
            mimeType: mb.mime_type,
            sizeBytes: Number(mb.size_bytes || 0),
            cacheControl: 'public, max-age=31536000, immutable',
            source: 'vault_blob',
          };
        }
      }
      // Self-heal missing blob file
      db.prepare(
        "UPDATE game_media_assets SET storage_kind = 'pending', blob_sha256 = NULL WHERE url_key = ?"
      ).run(assetRow.url_key);
    }

    // Tier 1B: Existing verified federated local file hit
    if (assetRow && assetRow.storage_kind === 'federated' && assetRow.federated_path) {
      const federatedPath = String(assetRow.federated_path);
      if (
        isExplicitOverride ||
        !isFederatedAssetRowCompatible(rawUrl || assetRow.source_url, federatedPath, params)
      ) {
        db.prepare(
          "UPDATE game_media_assets SET storage_kind = 'pending', federated_path = NULL WHERE url_key = ?"
        ).run(assetRow.url_key);
      } else {
        try {
          const lst = fs.lstatSync(federatedPath);
          if (!lst.isSymbolicLink() && lst.isFile() && lst.size >= 33) {
            const header = Buffer.allocUnsafe(16);
            header.fill(0);
            const fd = fs.openSync(federatedPath, 'r');
            let bytesRead = 0;
            try {
              bytesRead = fs.readSync(fd, header, 0, 16, 0);
            } finally {
              try {
                fs.closeSync(fd);
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
        // Self-heal if local storefront cache file was deleted
        db.prepare(
          "UPDATE game_media_assets SET storage_kind = 'pending', federated_path = NULL WHERE url_key = ?"
        ).run(assetRow.url_key);
      }
    }

    // Tier 2: Zero-Copy First-Party Local Cache Federation (Steam, GOG Galaxy, Heroic, Xbox)
    // Skip Tier 2 completely when `ov` is set so explicit user media overrides always persist into `media_blobs`.
    if (!isExplicitOverride) {
      let resolvedXboxProductId = params.xboxProductId || params.xid || '';
      let resolvedPfn = params.packageFamilyName || params.pfn || params.xpfn || '';
      let resolvedXboxTitleId = params.xboxTitleId || params.xtid || '';

      if (!resolvedXboxProductId && /^xbox[-_:]([A-Z0-9]{12})$/i.test(gameId)) {
        resolvedXboxProductId = gameId.replace(/^xbox[-_:]/i, '').toUpperCase();
      }
      if (gameId && (!resolvedXboxProductId || !resolvedPfn || !resolvedXboxTitleId)) {
        try {
          const gRow = db
            .prepare('SELECT platforms_json, summary_json FROM vault_games WHERE game_id = ?')
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

      const federatedHit =
        typeof this.federator?.resolveFederatedAsset === 'function'
          ? this.federator.resolveFederatedAsset(federationPayload)
          : typeof this.federator?.resolveLocalStoreAsset === 'function'
            ? this.federator.resolveLocalStoreAsset(federationPayload)
            : null;

      if (
        federatedHit &&
        federatedHit.path &&
        federatedHit.mimeType &&
        isFederatedAssetRowCompatible(rawUrl, federatedHit.path, federationPayload)
      ) {
        db.prepare(
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
        ).run(urlKey, gameId, role, ordinal, rawUrl, federatedHit.path, nowTs);

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

    // Tier 3: Reference-Counted `AbortSignal`-Coalesced Upstream HTTP(S) Fetch + Persist-on-Read
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      return { kind: 'error', status: 404, reason: 'no_upstream_url' };
    }

    if (reqOpts.signal?.aborted) {
      if (reqOpts.throwOnAbort === true) {
        throw reqOpts.signal.reason || new Error('Aborted');
      }
      return { kind: 'error', status: 499, reason: 'aborted' };
    }

    // Check Adaptive 404 Backoff before touching network
    if (assetRow && assetRow.url_key === urlKey && Number(assetRow.next_retry_at || 0) > nowTs) {
      return {
        kind: 'error',
        status: 404,
        reason: 'adaptive_404_cooldown',
        nextRetryAt: Number(assetRow.next_retry_at),
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

    let inFlightEntry = this.inFlightMediaFetches.get(fetchKey);
    if (!inFlightEntry) {
      const gate = this.canRequestHost(host);
      if (!gate.allowed) {
        return {
          kind: 'error',
          status: 503,
          reason: 'circuit_open',
          retryAfterMs: gate.retryAfterMs,
        };
      }

      const sharedAbortCtrl = new AbortController();
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
        const fetchFn = this.getFetchImpl();
        if (typeof fetchFn !== 'function') {
          this.releaseCanaryIfHeld(host);
          return { response: { kind: 'error', status: 503, reason: 'fetch_unavailable' } };
        }

        try {
          const res = await fetchFn(rawUrl, {
            method: 'GET',
            headers: {
              Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            signal: sharedAbortCtrl.signal,
          });

          const status = Number(res.status || 0);
          const contentType = String(res.headers?.get?.('content-type') || '');

          if (REJECTED_VIDEO_MIME_RE.test(contentType)) {
            this.releaseCanaryIfHeld(host);
            return { response: { kind: 'error', status: 415, reason: 'video_caching_prohibited' } };
          }

          if (status === 429 || status === 403 || res.headers?.get?.('cf-mitigated')) {
            let sampleText = '';
            try {
              sampleText = (await res.text()).slice(0, 2048);
            } catch {}
            if (isWafOrChallengeResponse(status, sampleText, res.headers)) {
              const retryMs = parseRetryAfterMs(res.headers);
              this.recordHostWafBlock(host, status, retryMs, `HTTP ${status} WAF/rate-limit`);
              return { response: { kind: 'error', status, reason: 'waf_blocked' } };
            }
          }

          if (status === 404) {
            let sampleText = '';
            try {
              if (/text\/html/i.test(contentType)) {
                sampleText = (await res.text()).slice(0, 2048);
              }
            } catch {}
            if (isWafOrChallengeResponse(404, sampleText, res.headers)) {
              this.recordHostWafBlock(host, 404, 0, 'WAF disguised as 404');
              return { response: { kind: 'error', status: 403, reason: 'waf_blocked' } };
            }
            this.recordHostSuccess(host, 404);
            this.recordAssetAdaptive404(urlKey, gameId, role, ordinal, rawUrl);
            return {
              isDefinitive404: true,
              response: { kind: 'error', status: 404, reason: 'not_found' },
            };
          }

          if (status >= 500 || status === 0) {
            this.recordHostFailure(host, status || 502, `HTTP ${status}`);
            return { response: { kind: 'error', status: status || 502, reason: 'http_5xx' } };
          }

          if (!res.ok) {
            this.releaseCanaryIfHeld(host);
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
            this.releaseCanaryIfHeld(host);
            return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
          }

          // Background hydration skips downloading oversized (>1.5 MB) inline GIF bodies altogether
          if (
            !entry.hasForegroundSubscriber &&
            isInlineOrGifCandidate &&
            (/image\/gif/i.test(contentType) || /\.gif(?:$|[?#])/i.test(rawUrl)) &&
            contentLength > MAX_INLINE_ANIMATED_GIF_CACHE_BYTES
          ) {
            this.recordHostSuccess(host, 200);
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

          const arrayBuf = await res.arrayBuffer();
          const rawBuf = Buffer.from(arrayBuf);
          if (rawBuf.length > maxFetchBytes) {
            this.releaseCanaryIfHeld(host);
            return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
          }

          const magic = detectImageMagicBytes(rawBuf);
          if (!magic.valid) {
            if (isWafOrChallengeResponse(200, rawBuf, res.headers)) {
              this.recordHostWafBlock(host, 403, 0, 'HTML challenge page on 200 OK');
              return { response: { kind: 'error', status: 403, reason: 'waf_blocked' } };
            }
            this.releaseCanaryIfHeld(host);
            return { response: { kind: 'error', status: 415, reason: 'invalid_image_magic' } };
          }

          if (
            rawBuf.length > MAX_DOWNLOAD_IMAGE_BYTES &&
            !(magic.ext === 'gif' && isAnimatedGifBuffer(rawBuf))
          ) {
            this.releaseCanaryIfHeld(host);
            return { response: { kind: 'error', status: 413, reason: 'image_too_large' } };
          }

          // Valid upstream image received -> mark host CLOSED (recovers HALF_OPEN canary!)
          this.recordHostSuccess(host, 200);

          const stored = await this.storeNormalizedBlobAsync(rawBuf, role, contentType);
          if (stored.stored && stored.sha256) {
            this.bindAssetBlobRow(urlKey, gameId, role, ordinal, rawUrl, stored.sha256);
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
            this.releaseCanaryIfHeld(host);
            return { response: { kind: 'error', status: 499, reason: 'aborted' } };
          }
          const msg = err instanceof Error ? err.message : String(err);
          this.recordHostFailure(host, null, msg);

          // Offline safety: if an upgraded URL failed due to network loss and the prior cached blob
          // still exists on disk, restore and serve the prior blob rather than showing a broken card!
          if (offlineFallbackBlobSha) {
            const fallbackMb = this.ensureOpen()
              .prepare('SELECT sha256, ext, mime_type, size_bytes FROM media_blobs WHERE sha256 = ?')
              .get(offlineFallbackBlobSha);
            if (fallbackMb) {
              const fallbackPath = this.getBlobFilePath(fallbackMb.sha256, fallbackMb.ext);
              if (
                isContainedWithinRoot(this.blobsDir, fallbackPath, this.options.platform) &&
                fs.existsSync(fallbackPath)
              ) {
                this.ensureOpen()
                  .prepare(
                    `
                    UPDATE game_media_assets
                    SET source_url = ?, storage_kind = 'blob', blob_sha256 = ?
                    WHERE url_key = ?
                  `
                  )
                  .run(offlineFallbackPrevSourceUrl || rawUrl, offlineFallbackBlobSha, urlKey);
                this.touchBlobAccess(fallbackMb.sha256);
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

          return { response: { kind: 'error', status: 504, reason: 'network_error' } };
        } finally {
          clearTimeout(timeoutId);
          this.inFlightMediaFetches.delete(fetchKey);
        }
      };

      entry.promise = runSharedFetch();
      this.inFlightMediaFetches.set(fetchKey, entry);
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
        (sharedRes) => {
          if (callerSignal) {
            callerSignal.removeEventListener('abort', onCallerAbort);
          }
          inFlightEntry.subscribers.delete(subId);
          if (settled) return;
          settled = true;

          if (sharedRes?.storedSha256 && urlKey !== inFlightEntry.primaryUrlKey) {
            try {
              this.bindAssetBlobRow(urlKey, gameId, role, ordinal, rawUrl, sharedRes.storedSha256);
            } catch {}
          } else if (sharedRes?.isDefinitive404 && urlKey !== inFlightEntry.primaryUrlKey) {
            try {
              this.recordAssetAdaptive404(urlKey, gameId, role, ordinal, rawUrl);
            } catch {}
          }

          resolve(sharedRes?.response || { kind: 'error', status: 504, reason: 'network_error' });
        },
        (unexpectedErr) => {
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
   */
  async checkUrlStatus(url) {
    const cleanUrl = typeof url === 'string' ? url.trim() : '';
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
      return {
        online: false,
        status: null,
        isDefinitive404: false,
        isWafOrRateLimited: false,
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

    const gate = this.canRequestHost(host);
    if (!gate.allowed) {
      const snap = this.getEndpointHealth(host);
      const isWaf = snap?.lastStatusCode === 429 || snap?.lastStatusCode === 403;
      return {
        online: true,
        status: snap?.lastStatusCode || 503,
        isDefinitive404: false,
        isWafOrRateLimited: isWaf,
        retryAfterMs: gate.retryAfterMs,
      };
    }

    const fetchFn = this.getFetchImpl();
    if (typeof fetchFn !== 'function') {
      this.releaseCanaryIfHeld(host);
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

    try {
      let res = await fetchFn(cleanUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: ctrl.signal,
      });

      if (res.status === 405 || res.status === 403) {
        res = await fetchFn(cleanUrl, {
          method: 'GET',
          headers: {
            Range: 'bytes=0-2047',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
          signal: ctrl.signal,
        });
      }

      const status = Number(res.status || 0);
      let bodySample = '';
      if (status === 403 || status === 429 || status === 404) {
        try {
          bodySample = (await res.text()).slice(0, 2048);
        } catch {}
      }

      if (isWafOrChallengeResponse(status, bodySample, res.headers)) {
        const retryMs = parseRetryAfterMs(res.headers);
        const snap = this.recordHostWafBlock(host, status, retryMs, `CheckURL WAF ${status}`);
        return {
          online: true,
          status,
          isDefinitive404: false,
          isWafOrRateLimited: true,
          retryAfterMs: snap ? Math.max(0, snap.openedUntil - this.now()) : retryMs,
        };
      }

      if (status === 404) {
        this.recordHostSuccess(host, 404);
        return {
          online: true,
          status: 404,
          isDefinitive404: true,
          isWafOrRateLimited: false,
        };
      }

      if (status >= 500) {
        this.recordHostFailure(host, status, `CheckURL HTTP ${status}`);
        return {
          online: true,
          status,
          isDefinitive404: false,
          isWafOrRateLimited: false,
        };
      }

      this.recordHostSuccess(host, status || 200);
      return {
        online: true,
        status: status || 200,
        isDefinitive404: false,
        isWafOrRateLimited: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordHostFailure(host, null, msg);
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

  resolveLocalMetadata(payload = {}) {
    if (!this.federator || typeof this.federator.resolveLocalMetadata !== 'function') {
      return null;
    }
    return this.federator.resolveLocalMetadata({
      ...payload,
      steamAppId: payload.steamAppId ?? payload.sid,
      gogId: payload.gogId ?? payload.gid,
      epicAppName: payload.epicAppName || payload.epicApp,
      xboxProductId: payload.xboxProductId || payload.xid,
      packageFamilyName: payload.packageFamilyName || payload.pfn || payload.xpfn,
      xboxTitleId: payload.xboxTitleId || payload.xtid,
    });
  }

  // ==========================================================================
  // Memory Trim & Clean NTFS-Safe Shutdown Lifecycle
  // ==========================================================================

  trimMemory() {
    try {
      this.federator.trimMemory();
    } catch {}
    if (!this.db) return { success: true };

    this.flushBlobAccessTimestamps();
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
      this.db.exec('PRAGMA shrink_memory;');
    } catch (err) {
      diagLog.debug('offlineVault.trimMemory', err);
    }
    return { success: true };
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
    this.halfOpenProbesInFlight.clear();
    if (!this.db) return;

    this.flushBlobAccessTimestamps();
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
    this.isShutdown = true;
  }
}

function createOfflineVaultService(options = {}) {
  return new OfflineVaultService(options);
}

module.exports = {
  OfflineVaultService,
  createOfflineVaultService,
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
  inferVaultMetadataQuality,
  computeAdaptive404DelayMs,
  isWafOrChallengeResponse,
  isRejectedVideoUrl,
  validateFederatedImageFile,
  isExplicitOverrideParam,
  isFederatedAssetRowCompatible,
};
