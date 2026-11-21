// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const {
  toHostFilesystemPath,
  isContainedWithinRoot,
  getCanonicalChromeUserAgent,
} = require('../../launcher/securityAndPathUtils.cjs');
const {
  getTokensFilePath,
  loadSavedTokensAsync,
  saveTokensAsync,
} = require('../tokenVault.cjs');
const xboxStorefront = require('../xbox/index.cjs');

/**
 * Upstream public native desktop OAuth client constants (identical to the public desktop
 * constants in GOG Galaxy / `heroic-gogdl` and Epic Games Launcher / `derrod/legendary` per
 * RFC 8252 §8.5 for installed native apps — NOT private developer credentials).
 * Optional `ONE_LAUNCHER_*` environment overrides are supported for custom relays or testing.
 */
const GOG_CLIENT_ID =
  String(process.env.ONE_LAUNCHER_GOG_CLIENT_ID || '').trim() || '46899977096215655';
const GOG_CLIENT_SECRET =
  String(process.env.ONE_LAUNCHER_GOG_CLIENT_SECRET || '').trim() ||
  '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

const EPIC_CLIENT_ID =
  String(process.env.ONE_LAUNCHER_EPIC_CLIENT_ID || '').trim() ||
  '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_AUTH =
  String(process.env.ONE_LAUNCHER_EPIC_CLIENT_AUTH || '').trim() ||
  'MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=';

const STORE_HTTP_TIMEOUT_MS = 20_000;
const MAX_STORE_SYNC_CACHE_ENTRIES = 500;
const STEAM_OWNED_CACHE_FILENAME = 'one_launcher_steam_owned_cache.json';

/** @type {Map<string, Promise<any>>} */
const inFlightTokenRenewals = new Map();
/** @type {Map<string, { storefrontId: string, resolvedVaultPath: string, data: Record<string, any>, expiresAtMs: number }>} */
const recentlyRotatedTokens = new Map();
const RECENT_ROTATED_TOKEN_TTL_MS = 30_000;
const RECENT_ROTATED_TOKEN_MAX_ENTRIES = 128;

/**
 * @param {string} raw
 * @returns {string}
 */
function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

/**
 * @param {AbortSignal | undefined} callerSignal
 * @param {number} [timeoutMs]
 * @returns {AbortSignal | undefined}
 */
function buildStoreFetchSignal(callerSignal, timeoutMs = STORE_HTTP_TIMEOUT_MS) {
  const timeoutSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (callerSignal && timeoutSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return callerSignal || timeoutSignal;
}

/**
 * Races an arbitrary shared promise against an individual caller's `AbortSignal` without
 * propagating cancellation into the shared single-flight network operation.
 *
 * @template T
 * @param {Promise<T>} sharedPromise
 * @param {AbortSignal | undefined} callerSignal
 * @returns {Promise<T>}
 */
function raceWithCallerAbortSignal(sharedPromise, callerSignal) {
  if (!callerSignal) return sharedPromise;
  if (callerSignal.aborted) {
    const reason =
      callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
    return Promise.reject(reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const reason =
        callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new DOMException('The operation was aborted.', 'AbortError');
      reject(reason);
    };
    callerSignal.addEventListener('abort', onAbort, { once: true });
    sharedPromise.then(
      (val) => {
        callerSignal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        callerSignal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * @param {string} [clientToken]
 * @returns {string}
 */
function buildPlatformStoreUserAgent(clientToken = '') {
  if (!clientToken) {
    return getCanonicalChromeUserAgent({ platform: process.platform });
  }
  const osPart =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osPart}) ${clientToken}`;
}

/**
 * Validates that an untrusted media/image/video URL uses strictly `https:` (optionally upgrading
 * protocol-relative `//` when allowed) with no embedded credentials or dangerous schemes.
 *
 * @param {unknown} rawUrl
 * @param {{ allowProtocolRelative?: boolean }} [opts]
 * @returns {string}
 */
function sanitizeSafeHttpsMediaUrl(rawUrl, opts = {}) {
  if (typeof rawUrl !== 'string') return '';
  let trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096) return '';
  if (opts.allowProtocolRelative === true && trimmed.startsWith('//')) {
    trimmed = `https:${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return '';
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Resolves a Legendary `<baseDir>/metadata/<appName>.json` path while strictly blocking path
 * traversal (`..`, path separators, NUL bytes, or containment escape outside `<baseDir>/metadata`).
 *
 * @param {string} baseDir
 * @param {unknown} rawAppName
 * @returns {string | null}
 */
function resolveSafeLegendaryMetaFilePath(baseDir, rawAppName) {
  if (!baseDir || typeof baseDir !== 'string') return null;
  const cleanApp = String(rawAppName || '').trim();
  if (
    !cleanApp ||
    cleanApp.length > 200 ||
    cleanApp === '.' ||
    cleanApp === '..' ||
    cleanApp.includes('..') ||
    /[\\/\0\r\n]/.test(cleanApp)
  ) {
    return null;
  }
  const metaDir = path.resolve(baseDir, 'metadata');
  const fileName = `${cleanApp}.json`;
  const directFile = path.resolve(metaDir, fileName);
  if (path.basename(directFile) !== fileName) {
    return null;
  }
  if (!isContainedWithinRoot(metaDir, directFile, process.platform)) {
    return null;
  }
  return directFile;
}

/**
 * @param {Record<string, any>} [options]
 * @returns {{ locale: string, country: string }}
 */
function resolveDefaultStoreLocaleAndCountry(options = {}) {
  let detectedLocale = '';
  let detectedCountry = '';
  try {
    if (app) {
      if (typeof app.getLocale === 'function') {
        detectedLocale = String(app.getLocale() || '').trim();
      }
      if (typeof app.getLocaleCountryCode === 'function') {
        detectedCountry = String(app.getLocaleCountryCode() || '').trim().toUpperCase();
      }
    }
  } catch {}

  const explicitLocale =
    typeof options.locale === 'string' && options.locale.trim() ? options.locale.trim() : '';
  const explicitCountry =
    (typeof options.market === 'string' && /^[A-Z]{2}$/i.test(options.market.trim())
      ? options.market.trim().toUpperCase()
      : '') ||
    (typeof options.country === 'string' && /^[A-Z]{2}$/i.test(options.country.trim())
      ? options.country.trim().toUpperCase()
      : '');
  const fallbackMarket =
    typeof options.fallbackMarket === 'string' && /^[A-Z]{2}$/i.test(options.fallbackMarket.trim())
      ? options.fallbackMarket.trim().toUpperCase()
      : '';

  if (!detectedCountry) {
    const locForRegion = explicitLocale || detectedLocale;
    if (locForRegion && locForRegion.replace(/_/g, '-').includes('-')) {
      const parts = locForRegion.replace(/_/g, '-').split('-');
      const cc = parts[parts.length - 1].toUpperCase();
      if (/^[A-Z]{2}$/.test(cc)) {
        detectedCountry = cc;
      }
    }
  }

  const country =
    explicitCountry ||
    (/^[A-Z]{2}$/.test(detectedCountry) ? detectedCountry : '') ||
    fallbackMarket ||
    'US';

  const rawLocale = explicitLocale || detectedLocale || 'en-US';
  const locale =
    typeof xboxStorefront?.alignXboxLocaleWithMarket === 'function'
      ? xboxStorefront.alignXboxLocaleWithMarket(rawLocale, country)
      : rawLocale.includes('-')
        ? rawLocale
        : `${rawLocale.toLowerCase()}-${country}`;

  return { locale, country };
}

/**
 * @param {unknown} rawCodeOrUrl
 * @param {string[]} [allowedHosts]
 * @returns {string}
 */
function extractVerifiedOAuthCode(rawCodeOrUrl, allowedHosts = []) {
  const trimmed = String(rawCodeOrUrl || '').trim();
  if (!trimmed) {
    throw new Error('Missing OAuth authorization code');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('Malformed OAuth callback URL');
    }
    const host = parsed.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
      throw new Error('OAuth callback URL must use HTTPS');
    }
    if (
      Array.isArray(allowedHosts) &&
      allowedHosts.length > 0 &&
      !allowedHosts.map((h) => h.toLowerCase()).includes(host)
    ) {
      throw new Error(`Unexpected OAuth callback host: ${host}`);
    }
    const extracted = String(parsed.searchParams.get('code') || '').trim();
    if (!extracted) {
      throw new Error('OAuth callback URL missing code parameter');
    }
    return extracted;
  }
  return trimmed;
}

/**
 * @param {unknown} rawStr
 * @returns {string}
 */
function escapeHtmlEntities(rawStr) {
  return String(rawStr ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {string} filePath
 * @param {string} content
 */
function atomicWriteFileSync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, hostFilePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(hostFilePath, 0o600);
      } catch {}
    }
  } catch {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    fs.writeFileSync(hostFilePath, content, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(hostFilePath, 0o600);
      } catch {}
    }
  }
}

/**
 * Atomic temp-file write + rename with bounded retry backoff on transient Windows `EPERM`/`EBUSY`
 * rename locks so concurrent readers never observe torn JSON.
 *
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWriteFileAsync(filePath, content) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const dir = path.dirname(hostFilePath);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {}
  const tmpPath = `${hostFilePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  /** @type {unknown} */
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.promises.rename(tmpPath, hostFilePath);
      if (process.platform !== 'win32') {
        try {
          await fs.promises.chmod(hostFilePath, 0o600);
        } catch {}
      }
      return;
    } catch (err) {
      lastErr = err;
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
      if (
        (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') &&
        attempt < 3
      ) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  try {
    await fs.promises.unlink(tmpPath);
  } catch {}
  throw lastErr instanceof Error ? lastErr : new Error('Atomic file rename failed');
}

/**
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function resolveStoreVaultOptions(options = {}) {
  if (!options || typeof options !== 'object') return {};
  /** @type {Record<string, any>} */
  const vaultOpts = {};
  if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    vaultOpts.userDataDir = options.userDataDir.trim();
  }
  if (typeof options.filePath === 'string' && options.filePath.trim()) {
    vaultOpts.filePath = options.filePath.trim();
  }
  if (typeof options.tokensFilePath === 'string' && options.tokensFilePath.trim()) {
    vaultOpts.tokensFilePath = options.tokensFilePath.trim();
  }
  if (options.safeStorage && typeof options.safeStorage === 'object') {
    vaultOpts.safeStorage = options.safeStorage;
  }
  if (typeof options.machineIdOverride === 'string' && options.machineIdOverride) {
    vaultOpts.machineIdOverride = options.machineIdOverride;
  }
  return vaultOpts;
}

/**
 * @param {string} storefrontId
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveStoreVaultLockKey(storefrontId, options = {}) {
  const vaultOpts = resolveStoreVaultOptions(options);
  const resolvedVaultPath = path.resolve(toHostFilesystemPath(getTokensFilePath(vaultOpts)));
  return `${storefrontId}:${resolvedVaultPath}`;
}

/**
 * @param {string} storefrontId
 * @param {string} resolvedVaultPath
 * @param {string} rawRefreshToken
 * @returns {Record<string, any> | null}
 */
function getRecentlyRotatedToken(storefrontId, resolvedVaultPath, rawRefreshToken) {
  const tok = String(rawRefreshToken || '').trim();
  if (!tok) return null;
  const now = Date.now();
  for (const [k, v] of recentlyRotatedTokens.entries()) {
    if (!v || v.expiresAtMs <= now) {
      recentlyRotatedTokens.delete(k);
    }
  }
  const key = `${storefrontId}:${resolvedVaultPath}:${sha256Hex(tok)}`;
  const hit = recentlyRotatedTokens.get(key);
  if (hit && hit.expiresAtMs > now && hit.data && typeof hit.data === 'object') {
    return { ...hit.data };
  }
  return null;
}

/**
 * @param {string} storefrontId
 * @param {string} resolvedVaultPath
 * @param {string} oldRefreshToken
 * @param {Record<string, any>} newData
 */
function recordRecentlyRotatedToken(storefrontId, resolvedVaultPath, oldRefreshToken, newData) {
  const oldTok = String(oldRefreshToken || '').trim();
  if (!oldTok || !newData || typeof newData !== 'object' || !newData.access_token) return;
  const key = `${storefrontId}:${resolvedVaultPath}:${sha256Hex(oldTok)}`;
  if (!recentlyRotatedTokens.has(key) && recentlyRotatedTokens.size >= RECENT_ROTATED_TOKEN_MAX_ENTRIES) {
    const oldest = recentlyRotatedTokens.keys().next().value;
    if (oldest !== undefined) recentlyRotatedTokens.delete(oldest);
  }
  recentlyRotatedTokens.set(key, {
    storefrontId,
    resolvedVaultPath,
    data: { ...newData },
    expiresAtMs: Date.now() + RECENT_ROTATED_TOKEN_TTL_MS,
  });
}

/**
 * Clears rotated refresh-token cache entries scoped strictly to the mutated `storefrontId` (and
 * optional `filePath`), so clearing/updating one storefront never wipes another storefront's cache.
 *
 * @param {string | undefined} storefrontId
 * @param {string | undefined} [filePath]
 */
function clearRecentlyRotatedTokensForScope(storefrontId, filePath) {
  const normStore = typeof storefrontId === 'string' && storefrontId.trim() ? storefrontId.trim() : '';
  const normPath =
    typeof filePath === 'string' && filePath.trim()
      ? path.resolve(toHostFilesystemPath(filePath.trim()))
      : '';

  if (!normStore && !normPath) {
    recentlyRotatedTokens.clear();
    return;
  }

  for (const [key, entry] of recentlyRotatedTokens.entries()) {
    const storeMatches = !normStore || entry.storefrontId === normStore;
    const pathMatches = !normPath || entry.resolvedVaultPath === normPath;
    if (storeMatches && pathMatches) {
      recentlyRotatedTokens.delete(key);
    }
  }
}

/**
 * @param {Record<string, any> | null | undefined} savedEntry
 * @returns {boolean}
 */
function isSavedVaultTokenFreshAfterRotation(savedEntry) {
  if (!savedEntry || typeof savedEntry !== 'object' || !savedEntry.access_token) {
    return false;
  }
  const now = Date.now();
  if (savedEntry.expires_at) {
    const expMs = Date.parse(String(savedEntry.expires_at));
    if (!Number.isNaN(expMs)) {
      return expMs - now > 60_000;
    }
  }
  if (savedEntry.updatedAt) {
    const updMs = Date.parse(String(savedEntry.updatedAt));
    if (!Number.isNaN(updMs) && now - updMs < 120_000) {
      return true;
    }
  }
  return false;
}

/**
 * Shared single-flight OAuth refresh-token renewal runner for GOG and Epic:
 * - Deduplicates concurrent refreshes per `${storefrontId}:${resolvedVaultPath}`
 * - Uses SHA-256 hashed refresh-token keys (never plaintext tokens)
 * - Persists `previous_refresh_token_hash` (never plaintext old refresh tokens)
 * - Isolates caller `AbortSignal` from the shared network flight so one aborted caller cannot
 *   cancel sibling waiters or strand a rotated single-use refresh token.
 *
 * @param {{
 *   storefrontId: 'gog' | 'epic',
 *   refreshToken: string,
 *   options?: Record<string, any>,
 *   performRefresh: (effectiveRefreshToken: string, internalSignal: AbortSignal | undefined) => Promise<Record<string, any>>,
 * }} params
 * @returns {Promise<Record<string, any>>}
 */
async function runSingleFlightTokenRenewal({
  storefrontId,
  refreshToken,
  options = {},
  performRefresh,
}) {
  const vaultOpts = resolveStoreVaultOptions(options);
  const resolvedVaultPath = path.resolve(toHostFilesystemPath(getTokensFilePath(vaultOpts)));
  const inflightKey = resolveStoreVaultLockKey(storefrontId, options);
  const existingFlight = inFlightTokenRenewals.get(inflightKey);
  if (existingFlight) {
    return raceWithCallerAbortSignal(existingFlight, options?.signal);
  }

  const callerRefreshToken = String(refreshToken || '').trim();
  const callerRefreshHash = callerRefreshToken ? sha256Hex(callerRefreshToken) : '';

  const renewalPromise = (async () => {
    const recent = getRecentlyRotatedToken(storefrontId, resolvedVaultPath, callerRefreshToken);
    if (recent) {
      return recent;
    }

    let effectiveRefreshToken = callerRefreshToken;
    try {
      const allSaved = await loadSavedTokensAsync(vaultOpts);
      const saved = allSaved && typeof allSaved === 'object' ? allSaved[storefrontId] : null;
      const isRotatedSuccessor =
        !callerRefreshToken ||
        (callerRefreshHash && saved?.previous_refresh_token_hash === callerRefreshHash) ||
        saved?.previous_refresh_token === callerRefreshToken ||
        Boolean(options?.preferVaultRefreshToken);
      if (
        saved &&
        saved.refresh_token &&
        saved.refresh_token !== callerRefreshToken &&
        isRotatedSuccessor
      ) {
        if (isSavedVaultTokenFreshAfterRotation(saved)) {
          return { ...saved };
        }
        effectiveRefreshToken = String(saved.refresh_token).trim();
      }
    } catch {}

    // Internal timeout signal only — never bind caller A's AbortSignal directly to a shared flight
    const internalSignal = buildStoreFetchSignal(undefined, STORE_HTTP_TIMEOUT_MS);
    const data = await performRefresh(effectiveRefreshToken, internalSignal);
    if (!data || !data.access_token) {
      throw new Error(`${storefrontId.toUpperCase()} refresh response missing access_token`);
    }

    /** @type {Record<string, any>} */
    const persistedBase =
      !data.expires_at && Number(data.expires_in) > 0
        ? { ...data, expires_at: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() }
        : { ...data };
    /** @type {Record<string, any>} */
    const persisted =
      effectiveRefreshToken &&
      persistedBase.refresh_token &&
      persistedBase.refresh_token !== effectiveRefreshToken
        ? {
            ...persistedBase,
            previous_refresh_token_hash: sha256Hex(effectiveRefreshToken),
          }
        : persistedBase;

    await saveTokensAsync(storefrontId, persisted, vaultOpts);
    if (persisted.refresh_token && persisted.refresh_token !== effectiveRefreshToken) {
      recordRecentlyRotatedToken(storefrontId, resolvedVaultPath, effectiveRefreshToken, persisted);
    }
    if (
      persisted.refresh_token &&
      callerRefreshToken &&
      persisted.refresh_token !== callerRefreshToken
    ) {
      recordRecentlyRotatedToken(storefrontId, resolvedVaultPath, callerRefreshToken, persisted);
    }
    return persisted;
  })().finally(() => {
    if (inFlightTokenRenewals.get(inflightKey) === renewalPromise) {
      inFlightTokenRenewals.delete(inflightKey);
    }
  });

  inFlightTokenRenewals.set(inflightKey, renewalPromise);
  return raceWithCallerAbortSignal(renewalPromise, options?.signal);
}

/**
 * @param {any[]} gamesArray
 * @param {any} fnRef
 * @param {{ authoritativeComplete: boolean, achievementsMap?: Record<string, any>, suppressedItems?: any[] }} meta
 * @param {Record<string, any>} [options]
 */
function attachStoreSyncCallMetadata(gamesArray, fnRef, meta, options = {}) {
  const authoritativeComplete = Boolean(meta.authoritativeComplete);
  const achievementsMap = meta.achievementsMap || {};
  const suppressedItems = Array.isArray(meta.suppressedItems) ? meta.suppressedItems : [];

  if (options && options.outMeta && typeof options.outMeta === 'object') {
    options.outMeta.authoritativeComplete = authoritativeComplete;
    options.outMeta.achievementsMap = achievementsMap;
    options.outMeta.suppressedItems = suppressedItems;
  }

  if (Array.isArray(gamesArray)) {
    try {
      Object.defineProperties(gamesArray, {
        authoritativeComplete: {
          value: authoritativeComplete,
          enumerable: false,
          configurable: true,
        },
        achievementsMap: { value: achievementsMap, enumerable: false, configurable: true },
        suppressedItems: { value: suppressedItems, enumerable: false, configurable: true },
      });
    } catch {}
  }

  if (fnRef) {
    fnRef.lastAuthoritativeComplete = authoritativeComplete;
    fnRef.lastAchievementsMap = achievementsMap;
    fnRef.lastSuppressedItems = suppressedItems;
  }

  return gamesArray;
}

/**
 * @param {any} win
 */
function destroyScraperWindowCleanly(win) {
  if (!win) return;
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
    if (win.webContents) {
      try {
        if (typeof win.webContents.removeAllListeners === 'function') {
          win.webContents.removeAllListeners();
        }
      } catch {}
      try {
        if (win.webContents.session && typeof win.webContents.session.clearCache === 'function') {
          const res = win.webContents.session.clearCache();
          if (res && typeof res.catch === 'function') {
            res.catch(() => {});
          }
        }
      } catch {}
    }
    try {
      if (typeof win.destroy === 'function') {
        win.destroy();
      } else if (typeof win.close === 'function') {
        win.close();
      }
    } catch {
      try {
        if (typeof win.close === 'function') win.close();
      } catch {}
    }
  } catch {}
}

/**
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} [maxEntries]
 */
function setBoundedCacheEntry(map, key, value, maxEntries = MAX_STORE_SYNC_CACHE_ENTRIES) {
  if (!map.has(key) && map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

/**
 * @param {number | undefined} percentage
 * @returns {'ultra_rare' | 'rare' | 'uncommon' | 'common'}
 */
function classifyAchievementRarityTier(percentage) {
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return 'common';
  if (percentage < 10) return 'ultra_rare';
  if (percentage < 25) return 'rare';
  if (percentage < 50) return 'uncommon';
  return 'common';
}

/**
 * Read a fetch Response body into a Buffer while enforcing a strict maximum byte limit (`C2`).
 *
 * @param {any} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBoundedResponseBuffer(res, maxBytes) {
  const rawCl = res?.headers?.get?.('content-length');
  if (rawCl !== null && rawCl !== undefined) {
    const clNum = Number(rawCl);
    if (Number.isFinite(clNum) && clNum > maxBytes) {
      try {
        await res?.body?.cancel?.();
      } catch {}
      throw new Error(`Response Content-Length exceeds limit (${clNum} > ${maxBytes})`);
    }
  }
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error(`Response stream exceeds byte cap (${totalBytes} > ${maxBytes})`);
        }
        chunks.push(chunk);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return Buffer.concat(chunks, totalBytes);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error(`Response buffer exceeds byte cap (${ab.byteLength} > ${maxBytes})`);
  }
  return Buffer.from(ab);
}

// ============================================================================
// Steam Owned-Games Cache, Steam `appdetails` EA Handoff & IGDB/Lutris Cover
// ============================================================================

/**
 * Resolve the non-secret Steam owned-games cache path inside `userDataDir`.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getSteamOwnedGamesCachePath(options = {}) {
  if (typeof options?.userDataDir === 'string' && options.userDataDir.trim()) {
    return path.join(toHostFilesystemPath(options.userDataDir.trim()), STEAM_OWNED_CACHE_FILENAME);
  }
  const tokensPath = getTokensFilePath(resolveStoreVaultOptions(options));
  return path.join(path.dirname(toHostFilesystemPath(tokensPath)), STEAM_OWNED_CACHE_FILENAME);
}

/**
 * @param {Record<string, any>} [options]
 * @returns {any[]}
 */
function loadSteamOwnedGamesCache(options = {}) {
  const cachePath = getSteamOwnedGamesCachePath(options);
  const expectedSteamId =
    typeof options?.steamId === 'string' && options.steamId.trim() ? options.steamId.trim() : '';
  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const cachedSteamId =
        typeof parsed?.steamId === 'string' && parsed.steamId.trim() ? parsed.steamId.trim() : '';
      if (
        Array.isArray(parsed?.games) &&
        (!expectedSteamId || !cachedSteamId || expectedSteamId === cachedSteamId)
      ) {
        const result = parsed.games;
        try {
          Object.defineProperty(result, 'fromDiskCache', {
            value: true,
            enumerable: false,
            configurable: true,
          });
        } catch {}
        return result;
      }
    }
  } catch {}
  if (Array.isArray(options?.legacyGames)) {
    return options.legacyGames;
  }
  return [];
}

/**
 * @param {any[]} games
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function saveSteamOwnedGamesCache(games, options = {}) {
  if (!Array.isArray(games)) return false;
  try {
    const cachePath = getSteamOwnedGamesCachePath(options);
    const payload = {
      schemaVersion: 1,
      ...(typeof options?.steamId === 'string' && options.steamId.trim()
        ? { steamId: options.steamId.trim() }
        : {}),
      updatedAt: new Date().toISOString(),
      games,
    };
    atomicWriteFileSync(cachePath, JSON.stringify(payload));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to save Steam owned games cache:', msg);
    return false;
  }
}

/**
 * @param {Record<string, any>} [options]
 */
function clearSteamOwnedGamesCache(options = {}) {
  try {
    const cachePath = getSteamOwnedGamesCachePath(options);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch {}
}

/**
 * Detect whether a Steam `appdetails` data payload requires EA App (`link2ea://`) chained handoff
 * (`chainedHandoffTopology: 'storefront_depot_uri'`), leaving Steam-native EA titles unchained.
 *
 * @param {unknown} appDetailsPayload
 */
function detectSteamAppDetailsChainedHandoff(appDetailsPayload) {
  if (!appDetailsPayload || typeof appDetailsPayload !== 'object') return null;
  /** @type {any} */
  let data = appDetailsPayload;
  if (data.data && typeof data.data === 'object') {
    data = data.data;
  } else if (
    !('drm_notice' in data) &&
    !('drmNotice' in data) &&
    !('ext_user_account_notice' in data) &&
    !('extUserAccountNotice' in data)
  ) {
    const firstEntry = Object.values(data).find(
      (v) => v && typeof v === 'object' && ('data' in v || 'drm_notice' in v || 'drmNotice' in v)
    );
    if (firstEntry && typeof firstEntry === 'object') {
      data = /** @type {any} */ (firstEntry).data || firstEntry;
    }
  }

  const rawDrm = String(data?.drm_notice ?? data?.drmNotice ?? '').trim();
  const rawExtAccount = String(
    data?.ext_user_account_notice ?? data?.extUserAccountNotice ?? ''
  ).trim();

  /** @param {string} s */
  const normalizeHtmlNotice = (s) =>
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();

  const cleanDrm = normalizeHtmlNotice(rawDrm);
  const cleanExt = normalizeHtmlNotice(rawExtAccount);
  if (!cleanDrm) return null;

  if (
    /\b(?:no|without)\s+(?:EA\s+app|Origin)\b/i.test(cleanDrm) ||
    /\b(?:EA\s+app|Origin(?:\s+client)?)\s+(?:is\s+)?not\s+required\b/i.test(cleanDrm)
  ) {
    return null;
  }

  const hasEaDrmRequirement =
    /\b(?:EA\s+app|Origin(?:\s+client)?)\b[\s\S]*\b(?:installation|required|activation)\b/i.test(
      cleanDrm
    ) ||
    /\b(?:installation|required|activation)\b[\s\S]*\b(?:EA\s+app|Origin\s+client)\b/i.test(
      cleanDrm
    ) ||
    (/\bEA\s+Account\b/i.test(cleanExt) && /\b(?:EA\s+app|Origin(?:\s+client)?)\b/i.test(cleanDrm));

  if (!hasEaDrmRequirement) {
    return null;
  }

  return {
    chainedLauncherHandoff: 'ea',
    chainedHandoffTopology: 'storefront_depot_uri',
    ...(rawDrm ? { drmNotice: rawDrm } : {}),
    ...(rawExtAccount ? { extUserAccountNotice: rawExtAccount } : {}),
  };
}

/**
 * @param {Record<string, any>} target
 * @param {unknown} appDetailsPayload
 * @returns {Record<string, any>}
 */
function enrichSteamGameFromAppDetails(target, appDetailsPayload) {
  if (!target || typeof target !== 'object') return target;
  const handoff = detectSteamAppDetailsChainedHandoff(appDetailsPayload);
  if (!handoff) {
    return target;
  }

  target.chainedLauncherHandoff = handoff.chainedLauncherHandoff;
  target.chainedHandoffTopology = handoff.chainedHandoffTopology;
  if (handoff.drmNotice && !target.drmNotice) {
    target.drmNotice = handoff.drmNotice;
  }
  if (handoff.extUserAccountNotice && !target.extUserAccountNotice) {
    target.extUserAccountNotice = handoff.extUserAccountNotice;
  }

  if (Array.isArray(target.platforms)) {
    target.platforms = target.platforms.map((/** @type {any} */ p) => {
      if (!p || p.platformId !== 'steam') return p;
      return {
        ...p,
        chainedLauncherHandoff: handoff.chainedLauncherHandoff,
        chainedHandoffTopology: handoff.chainedHandoffTopology,
      };
    });
  }
  if (target.enrichedMetadata && typeof target.enrichedMetadata === 'object') {
    target.enrichedMetadata = {
      ...target.enrichedMetadata,
      chainedLauncherHandoff: handoff.chainedLauncherHandoff,
      chainedHandoffTopology: handoff.chainedHandoffTopology,
      ...(handoff.drmNotice && !target.enrichedMetadata.drmNotice
        ? { drmNotice: handoff.drmNotice }
        : {}),
      ...(handoff.extUserAccountNotice && !target.enrichedMetadata.extUserAccountNotice
        ? { extUserAccountNotice: handoff.extUserAccountNotice }
        : {}),
    };
  }
  return target;
}

/**
 * @param {any} payload
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
async function fetchSteamProductAppDetailsMetadata(payload, options = {}) {
  const rawId =
    payload && typeof payload === 'object'
      ? payload.appId ?? payload.steamAppId ?? payload.platformGameId ?? ''
      : payload;
  const cleanId = String(rawId ?? '')
    .replace(/^steam[-_:]/i, '')
    .trim();
  if (!/^\d+$/.test(cleanId)) return null;

  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const cc = String(options?.country || 'US').trim().toUpperCase() || 'US';
  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(cleanId)}&l=english&cc=${encodeURIComponent(cc)}`;
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': buildPlatformStoreUserAgent(),
      Accept: 'application/json',
    },
    signal: buildStoreFetchSignal(options?.signal),
  });
  if (!res.ok) return null;
  const json = /** @type {any} */ (await res.json());
  const entry = json?.[cleanId];
  if (!entry || entry.success === false || !entry.data || typeof entry.data !== 'object') {
    return null;
  }
  const data = entry.data;
  const handoff = detectSteamAppDetailsChainedHandoff(data);
  /** @type {Record<string, any>} */
  const enriched = {
    appId: Number(cleanId),
    name: typeof data.name === 'string' ? data.name : undefined,
    drmNotice: typeof data.drm_notice === 'string' && data.drm_notice ? data.drm_notice : undefined,
    extUserAccountNotice:
      typeof data.ext_user_account_notice === 'string' && data.ext_user_account_notice
        ? data.ext_user_account_notice
        : undefined,
    ...(handoff
      ? {
          chainedLauncherHandoff: handoff.chainedLauncherHandoff,
          chainedHandoffTopology: handoff.chainedHandoffTopology,
        }
      : {}),
  };
  if (payload && typeof payload === 'object' && payload.game) {
    enrichSteamGameFromAppDetails(payload.game, data);
  }
  return enriched;
}

const EDITION_WORDS = new Set([
  'complete',
  'definitive',
  'enhanced',
  'goty',
  'deluxe',
  'gold',
  'standard',
  'remastered',
  'remaster',
  'directors',
  'director',
  'cut',
  'edition',
  'collectors',
  'collector',
  'anniversary',
  'special',
  'ultimate',
  'extended',
  'game',
  'year',
  'final',
  'royal',
  'emperor',
  'classics',
  'classic',
  'plus',
  'bundle',
  'pack',
  'package',
  'collection',
  'upgrade',
  'vr',
  'hd',
]);

/** @type {Record<string, string>} */
const ROMAN_TO_ARABIC = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xvii: '17',
  xviii: '18',
  xix: '19',
  xx: '20',
};

const NUMERIC_SEQUELS = new Set([
  '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
]);

/**
 * @param {string[]} words
 * @returns {string | null}
 */
function extractSequelIdentifier(words) {
  if (!Array.isArray(words)) return null;
  for (const word of words) {
    if (NUMERIC_SEQUELS.has(word) || /^[2-9]$|^1[0-9]$|^20$/.test(word)) {
      return word;
    }
    if (ROMAN_TO_ARABIC[word]) {
      return ROMAN_TO_ARABIC[word];
    }
  }
  return null;
}

/**
 * @param {string} source
 * @param {string} candidate
 * @returns {number}
 */
function computeTokenSimilarity(source, candidate) {
  const s1 = source
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const s2 = candidate
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const words1 = s1.split(' ').filter(Boolean);
  const words2 = s2.split(' ').filter(Boolean);

  const seq1 = extractSequelIdentifier(words1);
  const seq2 = extractSequelIdentifier(words2);
  if (seq1 !== seq2) {
    return 0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  if (union === 0) return 0;
  const jaccard = intersection / union;

  if (words1.length === 1 && !tokens2.has(words1[0])) {
    return 0;
  }
  if (words2.length === 1 && !tokens1.has(words2[0])) {
    return 0;
  }

  const [shorterWords, longerWords] =
    words1.length <= words2.length ? [words1, words2] : [words2, words1];
  const shorterSet = new Set(shorterWords);
  const longerSet = new Set(longerWords);

  let allShorterInLonger = true;
  for (const w of shorterWords) {
    if (!longerSet.has(w)) {
      allShorterInLonger = false;
      break;
    }
  }

  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerWords) {
      if (
        !shorterSet.has(w) &&
        !EDITION_WORDS.has(w) &&
        w !== 'the' &&
        w !== 'of' &&
        w !== 'a' &&
        w !== 'an'
      ) {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  if (words1.length >= 2 && (s1.includes(s2) || s2.includes(s1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}

const LUTRIS_NATURAL_PC_PREDECESSOR_RE =
  /(?:^|\s)(?:my|your|our|the|his|her|its|a|an|this|that|new|old|custom|virtual|retro|mini|pocket|super|dream|ultimate|gaming|home|office|build\s+a)\s+pc$/i;
const LUTRIS_NATURAL_WINDOWS_PREDECESSOR_RE =
  /(?:^|\s)(?:the|of|in|into|through|behind|between|beyond|under|over|from|with|without|two|three|four|many|broken|stained|open|closed|shattered|dark|rear|glass)\s+windows$/i;

/**
 * @param {string} rawTitle
 * @returns {string}
 */
function normalizeIgdbLookupTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  let cur = rawTitle
    .replace(/&(?:trade|#8482|#x0*2122|reg|#174|#x0*ae|copy|#169|#x0*a9);/gi, '™')
    .replace(/&(?:rsquo|lsquo|#8217|#8216|#x0*2019|#x0*2018|apos|#0*39|#x0*27);/gi, "'")
    .replace(/&(?:ndash|mdash|#8211|#8212|#x0*2013|#x0*2014);/gi, ' ')
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ')
    .replace(/&(?:amp|#0*38|#x0*26);/gi, '&')
    .replace(/([\p{L}\p{N}])(?:[™®©℠℗]+|\(\s*(?:tm|r|c)\s*\))(?=[\p{L}\p{N}])/giu, '$1 ')
    .replace(/(?:[™®©℠℗]+|\(\s*(?:tm|r|c)\s*\))/gi, '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = cur
      .replace(
        /\s*[\(\[]\s*(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\/|]\s*s|\s+play\s+anywhere)?|microsoft\s+store|game\s+preview|ea\s+play(?:\s+edition)?|base\s+game|(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version))\s*[\)\]]/gi,
        ''
      )
      .replace(
        /(?:\s*[:\-–—]\s*|\s+for\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|microsoft\s+store|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\/|]\s*s)?)(?:\s+(?:edition|version))?\s*$/gi,
        ''
      )
      .replace(
        /(?:[:\-–—]\s*|\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version)\s*$/gi,
        ''
      )
      .replace(/(?:[:\-–—]\s*|\s+)game\s+preview\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (/\s+pc$/i.test(cur) && !LUTRIS_NATURAL_PC_PREDECESSOR_RE.test(cur)) {
      const withoutPc = cur.replace(/\s+pc$/i, '').trim();
      if (withoutPc.length >= 2) cur = withoutPc;
    }
    if (
      /\s+windows(?:\s*10|\s*11)?$/i.test(cur) &&
      !LUTRIS_NATURAL_WINDOWS_PREDECESSOR_RE.test(cur)
    ) {
      const withoutWin = cur.replace(/\s+windows(?:\s*10|\s*11)?$/i, '').trim();
      if (withoutWin.length >= 2) cur = withoutWin;
    }
    if (cur === prev) break;
  }

  return cur
    .replace(/[:\-–—_+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} gameTitle
 * @returns {Promise<string | null>}
 */
async function fetchIgdbCover(gameTitle) {
  if (!gameTitle) return null;
  const cleanTitle = normalizeIgdbLookupTitle(String(gameTitle));
  if (!cleanTitle) return null;
  try {
    const url = `https://lutris.net/api/games?search=${encodeURIComponent(cleanTitle)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': buildPlatformStoreUserAgent() },
      signal: buildStoreFetchSignal(undefined),
    });
    if (!res.ok) return null;
    const data = /** @type {any} */ (await res.json());
    const items = data.results || [];
    if (items.length === 0) return null;

    const normTarget = cleanTitle.toLowerCase().replace(/'/g, '');
    let bestCover = null;
    let bestScore = -1;

    for (const item of items) {
      if (!item.coverart) continue;
      const candNorm = normalizeIgdbLookupTitle(item.name || '').toLowerCase().replace(/'/g, '');
      let score = computeTokenSimilarity(normTarget, candNorm) * 100;
      if (candNorm && candNorm === normTarget) score += 100;

      if (score > bestScore && score >= 50) {
        bestScore = score;
        const m = String(item.coverart).match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
        if (m && !m[1].startsWith('library_capsule_') && !m[1].startsWith('banner_')) {
          bestCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
        } else {
          const safeHttpsCover = sanitizeSafeHttpsMediaUrl(String(item.coverart), {
            allowProtocolRelative: true,
          });
          if (safeHttpsCover) {
            try {
              const parsedCover = new URL(safeHttpsCover);
              const baseName = path.posix.basename(parsedCover.pathname).toLowerCase();
              if (baseName && !/(?:^|[_.-])(?:default|placeholder)(?:[_.-]|$)/.test(baseName)) {
                bestCover = safeHttpsCover;
              }
            } catch {}
          }
        }
      }
    }
    return bestCover;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('IGDB cover fetch warning:', msg);
  }
  return null;
}

function trimStoreSyncSharedMemory() {
  recentlyRotatedTokens.clear();
}

module.exports = {
  GOG_CLIENT_ID,
  GOG_CLIENT_SECRET,
  GOG_REDIRECT_URI,
  EPIC_CLIENT_ID,
  EPIC_CLIENT_AUTH,
  STORE_HTTP_TIMEOUT_MS,
  MAX_STORE_SYNC_CACHE_ENTRIES,
  sha256Hex,
  buildStoreFetchSignal,
  raceWithCallerAbortSignal,
  buildPlatformStoreUserAgent,
  sanitizeSafeHttpsMediaUrl,
  resolveSafeLegendaryMetaFilePath,
  resolveDefaultStoreLocaleAndCountry,
  extractVerifiedOAuthCode,
  escapeHtmlEntities,
  atomicWriteFileSync,
  atomicWriteFileAsync,
  resolveStoreVaultOptions,
  resolveStoreVaultLockKey,
  getRecentlyRotatedToken,
  recordRecentlyRotatedToken,
  clearRecentlyRotatedTokensForScope,
  isSavedVaultTokenFreshAfterRotation,
  runSingleFlightTokenRenewal,
  attachStoreSyncCallMetadata,
  destroyScraperWindowCleanly,
  setBoundedCacheEntry,
  classifyAchievementRarityTier,
  readBoundedResponseBuffer,
  getSteamOwnedGamesCachePath,
  loadSteamOwnedGamesCache,
  saveSteamOwnedGamesCache,
  clearSteamOwnedGamesCache,
  detectSteamAppDetailsChainedHandoff,
  enrichSteamGameFromAppDetails,
  fetchSteamProductAppDetailsMetadata,
  computeTokenSimilarity,
  fetchIgdbCover,
  trimStoreSyncSharedMemory,
};
