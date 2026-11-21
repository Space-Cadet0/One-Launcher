// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  isContainedWithinRoot,
  resolveHostWindowsKnownFolders,
  discoverWindowsLocalDrivesAsync,
  getKnownWindowsLocalDrivesSync,
  clearCachedWindowsLocalDrives,
} = require('../securityAndPathUtils.cjs');

/** @type {any} */
let electronApp = null;
try {
  // @ts-ignore - electron is only available at runtime inside Electron main process
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object' && reqElectron.app) {
    electronApp = reqElectron.app;
  }
} catch {
  // Non-Electron test or CLI context
}

/** @type {Record<string, string>} */
const STEAM_GENRE_ID_NAMES = {
  '1': 'Action',
  '2': 'Strategy',
  '3': 'RPG',
  '4': 'Casual',
  '9': 'Racing',
  '18': 'Sports',
  '23': 'Indie',
  '25': 'Adventure',
  '28': 'Simulation',
  '29': 'Massively Multiplayer',
  '37': 'Free To Play',
  '70': 'Early Access',
};

const MAX_FEDERATED_IMAGE_BYTES = 64 * 1024 * 1024;
const MIN_FEDERATED_IMAGE_BYTES = 33; // strictly > 32 bytes

const STOREFRONT_ROOTS_CACHE_TTL_MS = 60 * 1000;
const MAX_STOREFRONT_ROOTS_CACHE_ENTRIES = 16;

/** @type {Map<string, { roots: StorefrontCacheRoots, cachedAt: number }>} */
const discoveredRootsCache = new Map();

/**
 * @typedef {{
 *   userDataDir: string,
 *   homedir: string,
 *   steamRoots: string[],
 *   gogRoots: string[],
 *   heroicRoots: string[],
 *   legendaryDirs: string[],
 *   amazonDbPaths: string[],
 *   xboxGamesRoots: string[],
 *   xboxAppCacheDirs: string[],
 * }} StorefrontCacheRoots
 */

function getLazyLauncherEngine() {
  try {
    return require('../../launcherEngine.cjs');
  } catch {
    return null;
  }
}

function getSqliteDatabaseSync() {
  try {
    const sqliteMod = require('node:sqlite');
    return sqliteMod && typeof sqliteMod.DatabaseSync === 'function'
      ? sqliteMod.DatabaseSync
      : null;
  } catch {
    return null;
  }
}

/**
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} maxEntries
 */
function setBoundedCache(map, key, value, maxEntries) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveFederatorUserDataDir(options = {}) {
  if (options && typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    return options.userDataDir.trim();
  }
  const launcherEngine = getLazyLauncherEngine();
  if (launcherEngine && typeof launcherEngine.getUserDataDir === 'function') {
    try {
      const p = launcherEngine.getUserDataDir(options?.userDataDir);
      if (p) return p;
    } catch {}
  }
  if (options && typeof options.homedir === 'string' && options.homedir.trim()) {
    return path.join(options.homedir.trim(), '.one-launcher');
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`, '.one-launcher');
  }
  try {
    if (electronApp && typeof electronApp.getPath === 'function') {
      const p = electronApp.getPath('userData');
      if (p) return p;
    }
  } catch {}
  return path.join(os.homedir(), '.one-launcher');
}

/**
 * Inspects the first 16 bytes of a buffer or file header to verify it is a genuine
 * static image (JPEG, PNG, WEBP, AVIF, GIF, or ICO). Explicitly rejects video containers
 * (.mp4, .webm, .ts), HTML challenge pages, and arbitrary non-image payloads.
 *
 * @param {Buffer} buf
 * @returns {{ valid: boolean, mimeType?: string, ext?: string }}
 */
function detectImageMagicBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    return { valid: false };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg', ext: 'jpg' };
  }

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { valid: true, mimeType: 'image/png', ext: 'png' };
  }

  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { valid: true, mimeType: 'image/webp', ext: 'webp' };
  }

  // AVIF: bytes 4..11 'ftypavif' | 'ftypavis' | 'ftypmif1'
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') {
      return { valid: true, mimeType: 'image/avif', ext: 'avif' };
    }
    return { valid: false };
  }

  // GIF: GIF87a / GIF89a
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { valid: true, mimeType: 'image/gif', ext: 'gif' };
  }

  // ICO: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return { valid: true, mimeType: 'image/x-icon', ext: 'ico' };
  }

  return { valid: false };
}

/**
 * Validates that a candidate local cache file is strictly contained inside `anchorRoot`,
 * is NOT a symbolic link, has size > 32 bytes, and passes 16-byte image magic-byte inspection.
 *
 * @param {string} candidatePath
 * @param {string} anchorRoot
 * @param {Record<string, any>} [options]
 * @returns {{ valid: boolean, path?: string, mimeType?: string, ext?: string, sizeBytes?: number }}
 */
function validateFederatedImageFile(candidatePath, anchorRoot, options = {}) {
  try {
    if (!candidatePath || !anchorRoot) return { valid: false };
    const platform = options.platform || process.platform;
    if (!isContainedWithinRoot(anchorRoot, candidatePath, platform)) {
      return { valid: false };
    }

    const lstat = fs.lstatSync(candidatePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { valid: false };
    }
    if (lstat.size < MIN_FEDERATED_IMAGE_BYTES || lstat.size > MAX_FEDERATED_IMAGE_BYTES) {
      return { valid: false };
    }

    const headerBuf = Buffer.allocUnsafe(16);
    headerBuf.fill(0);
    let bytesRead = 0;
    const fd = fs.openSync(candidatePath, 'r');
    try {
      bytesRead = fs.readSync(fd, headerBuf, 0, 16, 0);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }

    if (bytesRead < 12) {
      return { valid: false };
    }

    const magic = detectImageMagicBytes(headerBuf.subarray(0, bytesRead));
    if (!magic.valid) {
      return { valid: false };
    }

    return {
      valid: true,
      path: candidatePath,
      mimeType: magic.mimeType,
      ext: magic.ext,
      sizeBytes: lstat.size,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Async variant of `validateFederatedImageFile` using `fs.promises` (zero main-thread blocking).
 *
 * @param {string} candidatePath
 * @param {string} anchorRoot
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ valid: boolean, path?: string, mimeType?: string, ext?: string, sizeBytes?: number }>}
 */
async function validateFederatedImageFileAsync(candidatePath, anchorRoot, options = {}) {
  try {
    if (!candidatePath || !anchorRoot) return { valid: false };
    const platform = options.platform || process.platform;
    if (!isContainedWithinRoot(anchorRoot, candidatePath, platform)) {
      return { valid: false };
    }

    const lstat = await fs.promises.lstat(candidatePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { valid: false };
    }
    if (lstat.size < MIN_FEDERATED_IMAGE_BYTES || lstat.size > MAX_FEDERATED_IMAGE_BYTES) {
      return { valid: false };
    }

    const headerBuf = Buffer.allocUnsafe(16);
    headerBuf.fill(0);
    let bytesRead = 0;
    const fh = await fs.promises.open(candidatePath, 'r');
    try {
      const readRes = await fh.read(headerBuf, 0, 16, 0);
      bytesRead = Number(readRes?.bytesRead || 0);
    } finally {
      try {
        await fh.close();
      } catch {}
    }

    if (bytesRead < 12) {
      return { valid: false };
    }

    const magic = detectImageMagicBytes(headerBuf.subarray(0, bytesRead));
    if (!magic.valid) {
      return { valid: false };
    }

    return {
      valid: true,
      path: candidatePath,
      mimeType: magic.mimeType,
      ext: magic.ext,
      sizeBytes: lstat.size,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * @param {string} dirPath
 * @returns {boolean}
 */
function isExistingDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} dirPath
 * @returns {Promise<boolean>}
 */
async function isExistingDirectoryAsync(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    const st = await fs.promises.stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isExistingFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isExistingFileAsync(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const st = await fs.promises.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} dirPath
 * @returns {boolean}
 */
function isLikelySteamRoot(dirPath) {
  if (!isExistingDirectory(dirPath)) return false;
  return (
    isExistingDirectory(path.join(dirPath, 'appcache')) ||
    isExistingDirectory(path.join(dirPath, 'userdata')) ||
    isExistingDirectory(path.join(dirPath, 'steamapps')) ||
    isExistingDirectory(path.join(dirPath, 'steam'))
  );
}

/**
 * @param {string} dirPath
 * @returns {Promise<boolean>}
 */
async function isLikelySteamRootAsync(dirPath) {
  if (!(await isExistingDirectoryAsync(dirPath))) return false;
  const subdirs = ['appcache', 'userdata', 'steamapps', 'steam'];
  for (const sub of subdirs) {
    if (await isExistingDirectoryAsync(path.join(dirPath, sub))) return true;
  }
  return false;
}

/**
 * Build a deterministic cache key for `discoverStorefrontCacheRoots` so repeated Tier-2 misses
 * within the 60s TTL window avoid redundant filesystem/bottle/known-folder scans while honoring
 * distinct option overrides cleanly.
 *
 * @param {Record<string, any>} options
 * @param {string} platform
 * @param {string} homedir
 * @param {string} userDataDir
 * @returns {string}
 */
function buildRootsCacheKey(options, platform, homedir, userDataDir) {
  /** @param {unknown} v */
  const normArr = (v) => (Array.isArray(v) ? v.map((x) => String(x || '')).join('|') : '');
  const driveMapKey =
    options.driveRootPathMap && typeof options.driveRootPathMap === 'object'
      ? Object.entries(options.driveRootPathMap)
          .map(([k, v]) => `${k}=${String(v || '')}`)
          .sort()
          .join(',')
      : '';
  const kfKey =
    options.windowsKnownFolders && typeof options.windowsKnownFolders === 'object'
      ? String(options.windowsKnownFolders.localAppData || '')
      : '';
  return JSON.stringify([
    platform,
    homedir,
    userDataDir,
    options.bottlePath ? String(options.bottlePath) : '',
    normArr(options.bottlePaths),
    normArr(options.steamRoots),
    normArr(options.gogGalaxyRoots || options.gogRoots),
    options.gogGalaxyRoot || options.gogRoot || '',
    normArr(options.heroicRoots),
    options.heroicRoot || '',
    normArr(options.legendaryDirs || options.legendaryBaseDirs),
    options.amazonDbPath || '',
    options.localAppData || '',
    kfKey,
    normArr(options.xboxGamesRoots),
    options.xboxGamesRoot || '',
    normArr(options.xboxAppCacheDirs),
    normArr(options.localDrives),
    driveMapKey,
    Boolean(options.allowWin32DriveDiscoveryInTest),
    normArr(options.extraScanDirs),
  ]);
}

/**
 * @param {StorefrontCacheRoots} roots
 * @returns {StorefrontCacheRoots}
 */
function cloneStorefrontCacheRoots(roots) {
  return {
    userDataDir: roots.userDataDir,
    homedir: roots.homedir,
    steamRoots: roots.steamRoots.slice(),
    gogRoots: roots.gogRoots.slice(),
    heroicRoots: roots.heroicRoots.slice(),
    legendaryDirs: roots.legendaryDirs.slice(),
    amazonDbPaths: roots.amazonDbPaths.slice(),
    xboxGamesRoots: roots.xboxGamesRoots.slice(),
    xboxAppCacheDirs: roots.xboxAppCacheDirs.slice(),
  };
}

/**
 * Explicitly invalidates the 60s TTL cache on `discoverStorefrontCacheRoots`.
 */
function invalidateStorefrontCacheRoots() {
  discoveredRootsCache.clear();
}

/**
 * @param {Record<string, any>} options
 * @param {string} platform
 * @returns {string}
 */
function resolveLocalAppDataOnce(options, platform) {
  if (typeof options.localAppData === 'string' && options.localAppData.trim()) {
    return options.localAppData.trim();
  }
  if (platform === 'win32' || options.windowsKnownFolders) {
    try {
      const kf = resolveHostWindowsKnownFolders(options);
      return (kf && kf.localAppData) || '';
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * @param {Buffer} grBuf
 * @param {string} anchorDir
 * @param {string} containPlatform
 * @returns {string | null}
 */
function parseGamingRootRelPath(grBuf, anchorDir, containPlatform) {
  if (!Buffer.isBuffer(grBuf) || grBuf.length <= 8) return null;
  if (grBuf.toString('ascii', 0, 4) !== 'RGBX') return null;
  const relUtf16 = grBuf
    .subarray(8)
    .toString('utf16le')
    .replace(/\0+$/g, '')
    .trim()
    .replace(/[\\/]+/g, path.sep);
  if (!relUtf16 || relUtf16.includes('..')) return null;
  const candidateCustomRoot = path.resolve(anchorDir, relUtf16);
  if (!isContainedWithinRoot(anchorDir, candidateCustomRoot, containPlatform)) {
    return null;
  }
  return candidateCustomRoot;
}

/**
 * @param {Record<string, any>} options
 * @returns {boolean}
 */
function hasExplicitTestIsolationOptions(options) {
  return Boolean(
    options.homedir ||
      options.userDataDir ||
      options.steamRoots ||
      options.gogGalaxyRoot ||
      options.gogGalaxyRoots ||
      options.legendaryDirs ||
      options.legendaryBaseDirs ||
      options.heroicRoot ||
      options.heroicRoots ||
      options.amazonDbPath ||
      options.xboxGamesRoot ||
      options.xboxGamesRoots ||
      options.xboxAppCacheDirs
  );
}

/**
 * Dynamically discovers local storefront cache roots across macOS, macOS Wine/CrossOver/Whisky/Heroic
 * bottles, and Windows (`win32`), with a 60s TTL cache (`invalidateStorefrontCacheRoots()` to clear)
 * and deduplicated `resolveHostWindowsKnownFolders` lookup, while honoring explicit unit-test
 * isolation overrides.
 *
 * @param {Record<string, any>} [options]
 * @returns {StorefrontCacheRoots}
 */
function discoverStorefrontCacheRoots(options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const userDataDir = resolveFederatorUserDataDir(options);
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const nowTs = Number(nowFn());

  const cacheKey = buildRootsCacheKey(options, platform, homedir, userDataDir);
  if (!options.bypassRootsCache && !options.forceRefreshRoots) {
    const cached = discoveredRootsCache.get(cacheKey);
    if (cached && nowTs - cached.cachedAt < STOREFRONT_ROOTS_CACHE_TTL_MS) {
      return cloneStorefrontCacheRoots(cached.roots);
    }
  }

  const hasExplicitTestIsolation = hasExplicitTestIsolationOptions(options);

  // Deduplicated single lookup of host Windows Known Folders (used by both Amazon DB and Xbox App caches)
  const resolvedLocalAppData = resolveLocalAppDataOnce(options, platform);

  const launcherEngine = getLazyLauncherEngine();
  /** @type {string[]} */
  let bottlePaths = [];
  if (Array.isArray(options.bottlePaths)) {
    bottlePaths = options.bottlePaths.filter(Boolean);
  } else if (
    launcherEngine &&
    typeof launcherEngine.listAllInitializedBottlePaths === 'function' &&
    (!hasExplicitTestIsolation || Boolean(options.homedir || options.bottlePath))
  ) {
    try {
      const explicitHomedirOpt = options.homedir ? { homedir: options.homedir } : {};
      bottlePaths = launcherEngine.listAllInitializedBottlePaths({
        ...options,
        platform,
        ...explicitHomedirOpt,
      });
    } catch {
      bottlePaths = [];
    }
  }

  // 1. Steam Roots
  /** @type {Set<string>} */
  const steamRootsSet = new Set();
  if (Array.isArray(options.steamRoots)) {
    for (const r of options.steamRoots) {
      if (r && isExistingDirectory(r)) {
        steamRootsSet.add(path.resolve(r));
      }
    }
  } else {
    const steamCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'Steam'),
      path.join(homedir, '.local', 'share', 'Steam'),
      path.join(homedir, '.steam', 'steam'),
    ];
    for (const bottle of bottlePaths) {
      steamCandidates.push(
        path.join(bottle, 'drive_c', 'Program Files (x86)', 'Steam'),
        path.join(bottle, 'drive_c', 'Program Files', 'Steam')
      );
    }
    if (!hasExplicitTestIsolation) {
      if (platform === 'win32') {
        steamCandidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
      }
      if (launcherEngine && typeof launcherEngine.discoverSteamLocations === 'function') {
        try {
          const locs = launcherEngine.discoverSteamLocations({ platform, homedir });
          if (locs && Array.isArray(locs.steamRoots)) {
            for (const sr of locs.steamRoots) {
              if (isLikelySteamRoot(sr)) {
                steamRootsSet.add(path.resolve(sr));
              }
            }
          }
        } catch {}
      }
    }
    for (const c of steamCandidates) {
      if (isLikelySteamRoot(c)) {
        steamRootsSet.add(path.resolve(c));
      }
    }
  }

  // 2. GOG Galaxy Roots
  /** @type {Set<string>} */
  const gogRootsSet = new Set();
  const explicitGogRoots = Array.isArray(options.gogGalaxyRoots)
    ? options.gogGalaxyRoots
    : Array.isArray(options.gogRoots)
      ? options.gogRoots
      : options.gogGalaxyRoot
        ? [options.gogGalaxyRoot]
        : options.gogRoot
          ? [options.gogRoot]
          : null;

  if (explicitGogRoots) {
    for (const gr of explicitGogRoots) {
      if (gr && isExistingDirectory(gr)) {
        gogRootsSet.add(path.resolve(gr));
      }
    }
  } else {
    const gogCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'GOG.com', 'Galaxy'),
      path.join(homedir, 'GOG.com', 'Galaxy'),
      path.join(homedir, 'ProgramData', 'GOG.com', 'Galaxy'),
    ];
    for (const bottle of bottlePaths) {
      gogCandidates.push(path.join(bottle, 'drive_c', 'ProgramData', 'GOG.com', 'Galaxy'));
    }
    if (!hasExplicitTestIsolation) {
      if (platform === 'darwin') {
        gogCandidates.unshift('/Users/Shared/GOG.com/Galaxy');
      } else if (platform === 'win32') {
        const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
        gogCandidates.unshift(path.join(programData, 'GOG.com', 'Galaxy'));
        if (process.env.LOCALAPPDATA) {
          gogCandidates.push(path.join(process.env.LOCALAPPDATA, 'GOG.com', 'Galaxy'));
        }
      }
    }
    for (const c of gogCandidates) {
      if (isExistingDirectory(c)) {
        gogRootsSet.add(path.resolve(c));
      }
    }
  }

  // 3. Heroic Roots
  /** @type {Set<string>} */
  const heroicRootsSet = new Set();
  const explicitHeroicRoots = Array.isArray(options.heroicRoots)
    ? options.heroicRoots
    : options.heroicRoot
      ? [options.heroicRoot]
      : null;

  if (explicitHeroicRoots) {
    for (const hr of explicitHeroicRoots) {
      if (hr && isExistingDirectory(hr)) {
        heroicRootsSet.add(path.resolve(hr));
      }
    }
  } else {
    const heroicCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'heroic'),
      path.join(homedir, 'AppData', 'Roaming', 'heroic'),
      path.join(homedir, '.config', 'heroic'),
    ];
    if (!hasExplicitTestIsolation && platform === 'win32' && process.env.APPDATA) {
      heroicCandidates.unshift(path.join(process.env.APPDATA, 'heroic'));
    }
    for (const c of heroicCandidates) {
      if (isExistingDirectory(c)) {
        heroicRootsSet.add(path.resolve(c));
      }
    }
  }

  // 4. Legendary Config Directories
  /** @type {Set<string>} */
  const legendaryDirsSet = new Set();
  const explicitLegendary = options.legendaryDirs || options.legendaryBaseDirs;
  if (Array.isArray(explicitLegendary)) {
    for (const ld of explicitLegendary) {
      if (ld && isExistingDirectory(ld)) {
        legendaryDirsSet.add(path.resolve(ld));
      }
    }
  } else {
    const legCandidates = [
      userDataDir ? path.join(userDataDir, 'legendaryConfig', 'legendary') : '',
      path.join(homedir, '.config', 'legendary'),
      ...Array.from(heroicRootsSet).map((hr) => path.join(hr, 'legendaryConfig', 'legendary')),
      path.join(homedir, 'Library', 'Application Support', 'heroic', 'legendaryConfig', 'legendary'),
      path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary'),
    ];
    if (!hasExplicitTestIsolation) {
      legCandidates.push(
        path.join(homedir, 'Library', 'Application Support', 'one-launcher', 'legendaryConfig', 'legendary'),
        path.join(homedir, 'Library', 'Application Support', 'One Launcher', 'legendaryConfig', 'legendary')
      );
      if (platform === 'win32' && process.env.APPDATA) {
        legCandidates.push(
          path.join(process.env.APPDATA, 'one-launcher', 'legendaryConfig', 'legendary'),
          path.join(process.env.APPDATA, 'heroic', 'legendaryConfig', 'legendary')
        );
      }
    }
    for (const c of legCandidates) {
      if (c && isExistingDirectory(c)) {
        legendaryDirsSet.add(path.resolve(c));
      }
    }
  }

  // Pre-collect Wine bottle user dirs once (reused for both Amazon DB and Xbox GamingApp)
  /** @type {Array<{ usersDir: string, users: string[] }>} */
  const bottleUsersEntries = [];
  for (const bottle of bottlePaths) {
    const usersDir = path.join(bottle, 'drive_c', 'users');
    if (isExistingDirectory(usersDir)) {
      try {
        const users = fs
          .readdirSync(usersDir)
          .filter((u) => u !== 'Public' && !u.startsWith('.'));
        if (users.length > 0) {
          bottleUsersEntries.push({ usersDir, users });
        }
      } catch {}
    }
  }

  // 5. Amazon Games SQLite DB Paths
  /** @type {Set<string>} */
  const amazonDbPathsSet = new Set();
  if (typeof options.amazonDbPath === 'string' && options.amazonDbPath.trim()) {
    if (isExistingFile(options.amazonDbPath.trim())) {
      amazonDbPathsSet.add(path.resolve(options.amazonDbPath.trim()));
    }
  } else {
    const amazonCandidates = [
      resolvedLocalAppData
        ? path.join(
            resolvedLocalAppData,
            'Amazon Games',
            'Data',
            'Games',
            'Sql',
            'GameProductInfo.sqlite'
          )
        : '',
      path.join(
        homedir,
        'AppData',
        'Local',
        'Amazon Games',
        'Data',
        'Games',
        'Sql',
        'GameProductInfo.sqlite'
      ),
    ];
    for (const { usersDir, users } of bottleUsersEntries) {
      for (const u of users) {
        amazonCandidates.push(
          path.join(
            usersDir,
            u,
            'AppData',
            'Local',
            'Amazon Games',
            'Data',
            'Games',
            'Sql',
            'GameProductInfo.sqlite'
          )
        );
      }
    }
    for (const c of amazonCandidates) {
      if (c && isExistingFile(c)) {
        amazonDbPathsSet.add(path.resolve(c));
      }
    }
  }

  // 6. XboxGames Roots
  /** @type {Set<string>} */
  const xboxGamesRootsSet = new Set();
  const explicitXboxRoots = Array.isArray(options.xboxGamesRoots)
    ? options.xboxGamesRoots
    : options.xboxGamesRoot
      ? [options.xboxGamesRoot]
      : null;

  if (explicitXboxRoots) {
    for (const xr of explicitXboxRoots) {
      if (xr && isExistingDirectory(xr)) {
        xboxGamesRootsSet.add(path.resolve(xr));
      }
    }
  } else {
    const xboxCandidates = [path.join(homedir, 'XboxGames')];
    for (const bottle of bottlePaths) {
      xboxCandidates.push(path.join(bottle, 'drive_c', 'XboxGames'));
    }
    const allowWin32Drives =
      !hasExplicitTestIsolation ||
      Array.isArray(options.localDrives) ||
      Boolean(options.driveRootPathMap) ||
      Boolean(options.allowWin32DriveDiscoveryInTest);
    if (allowWin32Drives && platform === 'win32') {
      const localDrives = getKnownWindowsLocalDrivesSync(options);
      const driveMap =
        options.driveRootPathMap && typeof options.driveRootPathMap === 'object'
          ? options.driveRootPathMap
          : null;
      for (const rawDriveRoot of localDrives) {
        const driveRoot =
          driveMap && typeof driveMap[rawDriveRoot] === 'string'
            ? driveMap[rawDriveRoot]
            : rawDriveRoot;
        if (!isExistingDirectory(driveRoot)) continue;
        xboxCandidates.push(path.join(driveRoot, 'XboxGames'));
        const gamingRootFile = path.join(driveRoot, '.GamingRoot');
        if (isExistingFile(gamingRootFile)) {
          try {
            const grBuf = fs.readFileSync(gamingRootFile);
            const customRoot = parseGamingRootRelPath(
              grBuf,
              driveRoot,
              driveMap ? process.platform : 'win32'
            );
            if (customRoot) xboxCandidates.push(customRoot);
          } catch {}
        }
      }
    }
    if (Array.isArray(options.extraScanDirs)) {
      for (const rawExtraDir of options.extraScanDirs) {
        const extraDir = typeof rawExtraDir === 'string' ? rawExtraDir.trim() : '';
        if (!extraDir || !isExistingDirectory(extraDir)) continue;
        xboxCandidates.push(extraDir);
        xboxCandidates.push(path.join(extraDir, 'XboxGames'));
        const extraGamingRoot = path.join(extraDir, '.GamingRoot');
        if (isExistingFile(extraGamingRoot)) {
          try {
            const grBuf = fs.readFileSync(extraGamingRoot);
            const customRoot = parseGamingRootRelPath(grBuf, extraDir, platform);
            if (customRoot) xboxCandidates.push(customRoot);
          } catch {}
        }
      }
    }
    for (const c of xboxCandidates) {
      if (c && isExistingDirectory(c)) {
        xboxGamesRootsSet.add(path.resolve(c));
      }
    }
  }

  // 7. Xbox Windows App (`Microsoft.GamingApp_8wekyb3d8bbwe`) LocalState / LocalCache Directories
  /** @type {Set<string>} */
  const xboxAppCacheDirsSet = new Set();
  if (Array.isArray(options.xboxAppCacheDirs)) {
    for (const xd of options.xboxAppCacheDirs) {
      if (xd && isExistingDirectory(xd)) {
        xboxAppCacheDirsSet.add(path.resolve(xd));
      }
    }
  } else {
    const appPkgSubDirs = [
      path.join('Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalState'),
      path.join('Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalCache'),
    ];
    /** @type {string[]} */
    const xboxCacheCandidates = [];
    for (const sub of appPkgSubDirs) {
      if (resolvedLocalAppData) xboxCacheCandidates.push(path.join(resolvedLocalAppData, sub));
      xboxCacheCandidates.push(path.join(homedir, 'AppData', 'Local', sub));
    }
    for (const { usersDir, users } of bottleUsersEntries) {
      for (const u of users) {
        for (const sub of appPkgSubDirs) {
          xboxCacheCandidates.push(path.join(usersDir, u, 'AppData', 'Local', sub));
        }
      }
    }
    for (const c of xboxCacheCandidates) {
      if (c && isExistingDirectory(c)) {
        xboxAppCacheDirsSet.add(path.resolve(c));
      }
    }
  }

  /** @type {StorefrontCacheRoots} */
  const roots = {
    userDataDir,
    homedir,
    steamRoots: Array.from(steamRootsSet),
    gogRoots: Array.from(gogRootsSet),
    heroicRoots: Array.from(heroicRootsSet),
    legendaryDirs: Array.from(legendaryDirsSet),
    amazonDbPaths: Array.from(amazonDbPathsSet),
    xboxGamesRoots: Array.from(xboxGamesRootsSet),
    xboxAppCacheDirs: Array.from(xboxAppCacheDirsSet),
  };

  setBoundedCache(
    discoveredRootsCache,
    cacheKey,
    { roots: cloneStorefrontCacheRoots(roots), cachedAt: nowTs },
    MAX_STOREFRONT_ROOTS_CACHE_ENTRIES
  );
  return roots;
}

/**
 * Async variant of `discoverStorefrontCacheRoots` that uses `fs.promises` and awaits non-blocking
 * local fixed/removable drive enumeration on `win32` while sharing the 60s TTL cache.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<StorefrontCacheRoots>}
 */
async function discoverStorefrontCacheRootsAsync(options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const userDataDir = resolveFederatorUserDataDir(options);
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const nowTs = Number(nowFn());

  let effectiveOptions = options;
  if (platform === 'win32' && !Array.isArray(options.localDrives)) {
    const localDrives = await discoverWindowsLocalDrivesAsync(options);
    effectiveOptions = { ...options, localDrives };
  }

  const cacheKey = buildRootsCacheKey(effectiveOptions, platform, homedir, userDataDir);
  if (!effectiveOptions.bypassRootsCache && !effectiveOptions.forceRefreshRoots) {
    const cached = discoveredRootsCache.get(cacheKey);
    if (cached && nowTs - cached.cachedAt < STOREFRONT_ROOTS_CACHE_TTL_MS) {
      return cloneStorefrontCacheRoots(cached.roots);
    }
  }

  const hasExplicitTestIsolation = hasExplicitTestIsolationOptions(effectiveOptions);
  const resolvedLocalAppData = resolveLocalAppDataOnce(effectiveOptions, platform);

  const launcherEngine = getLazyLauncherEngine();
  /** @type {string[]} */
  let bottlePaths = [];
  if (Array.isArray(effectiveOptions.bottlePaths)) {
    bottlePaths = effectiveOptions.bottlePaths.filter(Boolean);
  } else if (
    launcherEngine &&
    typeof launcherEngine.listAllInitializedBottlePaths === 'function' &&
    (!hasExplicitTestIsolation || Boolean(effectiveOptions.homedir || effectiveOptions.bottlePath))
  ) {
    try {
      const explicitHomedirOpt = effectiveOptions.homedir
        ? { homedir: effectiveOptions.homedir }
        : {};
      bottlePaths = launcherEngine.listAllInitializedBottlePaths({
        ...effectiveOptions,
        platform,
        ...explicitHomedirOpt,
      });
    } catch {
      bottlePaths = [];
    }
  }

  // 1. Steam Roots
  /** @type {Set<string>} */
  const steamRootsSet = new Set();
  if (Array.isArray(effectiveOptions.steamRoots)) {
    for (const r of effectiveOptions.steamRoots) {
      if (r && (await isExistingDirectoryAsync(r))) {
        steamRootsSet.add(path.resolve(r));
      }
    }
  } else {
    const steamCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'Steam'),
      path.join(homedir, '.local', 'share', 'Steam'),
      path.join(homedir, '.steam', 'steam'),
    ];
    for (const bottle of bottlePaths) {
      steamCandidates.push(
        path.join(bottle, 'drive_c', 'Program Files (x86)', 'Steam'),
        path.join(bottle, 'drive_c', 'Program Files', 'Steam')
      );
    }
    if (!hasExplicitTestIsolation) {
      if (platform === 'win32') {
        steamCandidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
      }
      if (launcherEngine && typeof launcherEngine.discoverSteamLocations === 'function') {
        try {
          const locs = launcherEngine.discoverSteamLocations({ platform, homedir });
          if (locs && Array.isArray(locs.steamRoots)) {
            for (const sr of locs.steamRoots) {
              if (await isLikelySteamRootAsync(sr)) {
                steamRootsSet.add(path.resolve(sr));
              }
            }
          }
        } catch {}
      }
    }
    for (const c of steamCandidates) {
      if (await isLikelySteamRootAsync(c)) {
        steamRootsSet.add(path.resolve(c));
      }
    }
  }

  // 2. GOG Galaxy Roots
  /** @type {Set<string>} */
  const gogRootsSet = new Set();
  const explicitGogRoots = Array.isArray(effectiveOptions.gogGalaxyRoots)
    ? effectiveOptions.gogGalaxyRoots
    : Array.isArray(effectiveOptions.gogRoots)
      ? effectiveOptions.gogRoots
      : effectiveOptions.gogGalaxyRoot
        ? [effectiveOptions.gogGalaxyRoot]
        : effectiveOptions.gogRoot
          ? [effectiveOptions.gogRoot]
          : null;

  if (explicitGogRoots) {
    for (const gr of explicitGogRoots) {
      if (gr && (await isExistingDirectoryAsync(gr))) {
        gogRootsSet.add(path.resolve(gr));
      }
    }
  } else {
    const gogCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'GOG.com', 'Galaxy'),
      path.join(homedir, 'GOG.com', 'Galaxy'),
      path.join(homedir, 'ProgramData', 'GOG.com', 'Galaxy'),
    ];
    for (const bottle of bottlePaths) {
      gogCandidates.push(path.join(bottle, 'drive_c', 'ProgramData', 'GOG.com', 'Galaxy'));
    }
    if (!hasExplicitTestIsolation) {
      if (platform === 'darwin') {
        gogCandidates.unshift('/Users/Shared/GOG.com/Galaxy');
      } else if (platform === 'win32') {
        const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
        gogCandidates.unshift(path.join(programData, 'GOG.com', 'Galaxy'));
        if (process.env.LOCALAPPDATA) {
          gogCandidates.push(path.join(process.env.LOCALAPPDATA, 'GOG.com', 'Galaxy'));
        }
      }
    }
    for (const c of gogCandidates) {
      if (await isExistingDirectoryAsync(c)) {
        gogRootsSet.add(path.resolve(c));
      }
    }
  }

  // 3. Heroic Roots
  /** @type {Set<string>} */
  const heroicRootsSet = new Set();
  const explicitHeroicRoots = Array.isArray(effectiveOptions.heroicRoots)
    ? effectiveOptions.heroicRoots
    : effectiveOptions.heroicRoot
      ? [effectiveOptions.heroicRoot]
      : null;

  if (explicitHeroicRoots) {
    for (const hr of explicitHeroicRoots) {
      if (hr && (await isExistingDirectoryAsync(hr))) {
        heroicRootsSet.add(path.resolve(hr));
      }
    }
  } else {
    const heroicCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'heroic'),
      path.join(homedir, 'AppData', 'Roaming', 'heroic'),
      path.join(homedir, '.config', 'heroic'),
    ];
    if (!hasExplicitTestIsolation && platform === 'win32' && process.env.APPDATA) {
      heroicCandidates.unshift(path.join(process.env.APPDATA, 'heroic'));
    }
    for (const c of heroicCandidates) {
      if (await isExistingDirectoryAsync(c)) {
        heroicRootsSet.add(path.resolve(c));
      }
    }
  }

  // 4. Legendary Config Directories
  /** @type {Set<string>} */
  const legendaryDirsSet = new Set();
  const explicitLegendary = effectiveOptions.legendaryDirs || effectiveOptions.legendaryBaseDirs;
  if (Array.isArray(explicitLegendary)) {
    for (const ld of explicitLegendary) {
      if (ld && (await isExistingDirectoryAsync(ld))) {
        legendaryDirsSet.add(path.resolve(ld));
      }
    }
  } else {
    const legCandidates = [
      userDataDir ? path.join(userDataDir, 'legendaryConfig', 'legendary') : '',
      path.join(homedir, '.config', 'legendary'),
      ...Array.from(heroicRootsSet).map((hr) => path.join(hr, 'legendaryConfig', 'legendary')),
      path.join(homedir, 'Library', 'Application Support', 'heroic', 'legendaryConfig', 'legendary'),
      path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary'),
    ];
    if (!hasExplicitTestIsolation) {
      legCandidates.push(
        path.join(homedir, 'Library', 'Application Support', 'one-launcher', 'legendaryConfig', 'legendary'),
        path.join(homedir, 'Library', 'Application Support', 'One Launcher', 'legendaryConfig', 'legendary')
      );
      if (platform === 'win32' && process.env.APPDATA) {
        legCandidates.push(
          path.join(process.env.APPDATA, 'one-launcher', 'legendaryConfig', 'legendary'),
          path.join(process.env.APPDATA, 'heroic', 'legendaryConfig', 'legendary')
        );
      }
    }
    for (const c of legCandidates) {
      if (c && (await isExistingDirectoryAsync(c))) {
        legendaryDirsSet.add(path.resolve(c));
      }
    }
  }

  /** @type {Array<{ usersDir: string, users: string[] }>} */
  const bottleUsersEntries = [];
  for (const bottle of bottlePaths) {
    const usersDir = path.join(bottle, 'drive_c', 'users');
    if (await isExistingDirectoryAsync(usersDir)) {
      try {
        const users = (await fs.promises.readdir(usersDir)).filter(
          (u) => u !== 'Public' && !u.startsWith('.')
        );
        if (users.length > 0) {
          bottleUsersEntries.push({ usersDir, users });
        }
      } catch {}
    }
  }

  // 5. Amazon Games SQLite DB Paths
  /** @type {Set<string>} */
  const amazonDbPathsSet = new Set();
  if (typeof effectiveOptions.amazonDbPath === 'string' && effectiveOptions.amazonDbPath.trim()) {
    if (await isExistingFileAsync(effectiveOptions.amazonDbPath.trim())) {
      amazonDbPathsSet.add(path.resolve(effectiveOptions.amazonDbPath.trim()));
    }
  } else {
    const amazonCandidates = [
      resolvedLocalAppData
        ? path.join(
            resolvedLocalAppData,
            'Amazon Games',
            'Data',
            'Games',
            'Sql',
            'GameProductInfo.sqlite'
          )
        : '',
      path.join(
        homedir,
        'AppData',
        'Local',
        'Amazon Games',
        'Data',
        'Games',
        'Sql',
        'GameProductInfo.sqlite'
      ),
    ];
    for (const { usersDir, users } of bottleUsersEntries) {
      for (const u of users) {
        amazonCandidates.push(
          path.join(
            usersDir,
            u,
            'AppData',
            'Local',
            'Amazon Games',
            'Data',
            'Games',
            'Sql',
            'GameProductInfo.sqlite'
          )
        );
      }
    }
    for (const c of amazonCandidates) {
      if (c && (await isExistingFileAsync(c))) {
        amazonDbPathsSet.add(path.resolve(c));
      }
    }
  }

  // 6. XboxGames Roots
  /** @type {Set<string>} */
  const xboxGamesRootsSet = new Set();
  const explicitXboxRoots = Array.isArray(effectiveOptions.xboxGamesRoots)
    ? effectiveOptions.xboxGamesRoots
    : effectiveOptions.xboxGamesRoot
      ? [effectiveOptions.xboxGamesRoot]
      : null;

  if (explicitXboxRoots) {
    for (const xr of explicitXboxRoots) {
      if (xr && (await isExistingDirectoryAsync(xr))) {
        xboxGamesRootsSet.add(path.resolve(xr));
      }
    }
  } else {
    const xboxCandidates = [path.join(homedir, 'XboxGames')];
    for (const bottle of bottlePaths) {
      xboxCandidates.push(path.join(bottle, 'drive_c', 'XboxGames'));
    }
    const allowWin32Drives =
      !hasExplicitTestIsolation ||
      Array.isArray(effectiveOptions.localDrives) ||
      Boolean(effectiveOptions.driveRootPathMap) ||
      Boolean(effectiveOptions.allowWin32DriveDiscoveryInTest);
    if (allowWin32Drives && platform === 'win32') {
      const localDrives = Array.isArray(effectiveOptions.localDrives)
        ? effectiveOptions.localDrives
        : getKnownWindowsLocalDrivesSync(effectiveOptions);
      const driveMap =
        effectiveOptions.driveRootPathMap && typeof effectiveOptions.driveRootPathMap === 'object'
          ? effectiveOptions.driveRootPathMap
          : null;
      for (const rawDriveRoot of localDrives) {
        const driveRoot =
          driveMap && typeof driveMap[rawDriveRoot] === 'string'
            ? driveMap[rawDriveRoot]
            : rawDriveRoot;
        if (!(await isExistingDirectoryAsync(driveRoot))) continue;
        xboxCandidates.push(path.join(driveRoot, 'XboxGames'));
        const gamingRootFile = path.join(driveRoot, '.GamingRoot');
        if (await isExistingFileAsync(gamingRootFile)) {
          try {
            const grBuf = await fs.promises.readFile(gamingRootFile);
            const customRoot = parseGamingRootRelPath(
              grBuf,
              driveRoot,
              driveMap ? process.platform : 'win32'
            );
            if (customRoot) xboxCandidates.push(customRoot);
          } catch {}
        }
      }
    }
    if (Array.isArray(effectiveOptions.extraScanDirs)) {
      for (const rawExtraDir of effectiveOptions.extraScanDirs) {
        const extraDir = typeof rawExtraDir === 'string' ? rawExtraDir.trim() : '';
        if (!extraDir || !(await isExistingDirectoryAsync(extraDir))) continue;
        xboxCandidates.push(extraDir);
        xboxCandidates.push(path.join(extraDir, 'XboxGames'));
        const extraGamingRoot = path.join(extraDir, '.GamingRoot');
        if (await isExistingFileAsync(extraGamingRoot)) {
          try {
            const grBuf = await fs.promises.readFile(extraGamingRoot);
            const customRoot = parseGamingRootRelPath(grBuf, extraDir, platform);
            if (customRoot) xboxCandidates.push(customRoot);
          } catch {}
        }
      }
    }
    for (const c of xboxCandidates) {
      if (c && (await isExistingDirectoryAsync(c))) {
        xboxGamesRootsSet.add(path.resolve(c));
      }
    }
  }

  // 7. Xbox Windows App LocalState / LocalCache Directories
  /** @type {Set<string>} */
  const xboxAppCacheDirsSet = new Set();
  if (Array.isArray(effectiveOptions.xboxAppCacheDirs)) {
    for (const xd of effectiveOptions.xboxAppCacheDirs) {
      if (xd && (await isExistingDirectoryAsync(xd))) {
        xboxAppCacheDirsSet.add(path.resolve(xd));
      }
    }
  } else {
    const appPkgSubDirs = [
      path.join('Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalState'),
      path.join('Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalCache'),
    ];
    /** @type {string[]} */
    const xboxCacheCandidates = [];
    for (const sub of appPkgSubDirs) {
      if (resolvedLocalAppData) xboxCacheCandidates.push(path.join(resolvedLocalAppData, sub));
      xboxCacheCandidates.push(path.join(homedir, 'AppData', 'Local', sub));
    }
    for (const { usersDir, users } of bottleUsersEntries) {
      for (const u of users) {
        for (const sub of appPkgSubDirs) {
          xboxCacheCandidates.push(path.join(usersDir, u, 'AppData', 'Local', sub));
        }
      }
    }
    for (const c of xboxCacheCandidates) {
      if (c && (await isExistingDirectoryAsync(c))) {
        xboxAppCacheDirsSet.add(path.resolve(c));
      }
    }
  }

  /** @type {StorefrontCacheRoots} */
  const roots = {
    userDataDir,
    homedir,
    steamRoots: Array.from(steamRootsSet),
    gogRoots: Array.from(gogRootsSet),
    heroicRoots: Array.from(heroicRootsSet),
    legendaryDirs: Array.from(legendaryDirsSet),
    amazonDbPaths: Array.from(amazonDbPathsSet),
    xboxGamesRoots: Array.from(xboxGamesRootsSet),
    xboxAppCacheDirs: Array.from(xboxAppCacheDirsSet),
  };

  setBoundedCache(
    discoveredRootsCache,
    cacheKey,
    { roots: cloneStorefrontCacheRoots(roots), cachedAt: nowTs },
    MAX_STOREFRONT_ROOTS_CACHE_ENTRIES
  );
  return roots;
}

/**
 * @param {string} gogRoot
 * @returns {string | null}
 */
function resolveGogDbPathForRoot(gogRoot) {
  if (!gogRoot) return null;
  const candidates = [
    path.join(gogRoot, 'storage', 'galaxy-2.0.db'),
    path.join(gogRoot, 'Storage', 'galaxy-2.0.db'),
    path.join(gogRoot, 'galaxy-2.0.db'),
  ];
  for (const c of candidates) {
    if (isExistingFile(c)) return c;
  }
  return null;
}

/**
 * @param {string} gogRoot
 * @returns {Promise<string | null>}
 */
async function resolveGogDbPathForRootAsync(gogRoot) {
  if (!gogRoot) return null;
  const candidates = [
    path.join(gogRoot, 'storage', 'galaxy-2.0.db'),
    path.join(gogRoot, 'Storage', 'galaxy-2.0.db'),
    path.join(gogRoot, 'galaxy-2.0.db'),
  ];
  for (const c of candidates) {
    if (await isExistingFileAsync(c)) return c;
  }
  return null;
}

/**
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
function extractSteamAppIdFromParams(params = {}) {
  if (params.steamAppId !== undefined && params.steamAppId !== null) {
    const clean = String(params.steamAppId).replace(/^steam[-_]/i, '').trim();
    if (/^\d+$/.test(clean) && clean !== '0') return clean;
  }
  if (typeof params.gameId === 'string' && /^steam[-_]\d+$/i.test(params.gameId.trim())) {
    return params.gameId.trim().replace(/^steam[-_]/i, '');
  }
  if (typeof params.url === 'string') {
    const m = params.url.match(/\/steam\/apps\/(\d+)\//i);
    if (m && m[1]) return m[1];
  }
  return '';
}

/**
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
function extractGogIdFromParams(params = {}) {
  if (params.gogId !== undefined && params.gogId !== null) {
    const clean = String(params.gogId).replace(/^gog[-_]/i, '').trim();
    if (/^\d+$/.test(clean)) return clean;
  }
  if (typeof params.gameId === 'string' && /^gog[-_]\d+$/i.test(params.gameId.trim())) {
    return params.gameId.trim().replace(/^gog[-_]/i, '');
  }
  return '';
}

/**
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
function extractEpicAppNameFromParams(params = {}) {
  if (typeof params.epicAppName === 'string' && params.epicAppName.trim()) {
    return params.epicAppName.replace(/^epic[-_]/i, '').trim();
  }
  if (typeof params.epicApp === 'string' && params.epicApp.trim()) {
    return params.epicApp.replace(/^epic[-_]/i, '').trim();
  }
  if (typeof params.gameId === 'string' && /^epic[-_]/i.test(params.gameId.trim())) {
    return params.gameId.trim().replace(/^epic[-_]/i, '');
  }
  return '';
}

/**
 * @param {Record<string, any>} [params]
 * @returns {{ productId: string, pfn: string, titleId: string }}
 */
function extractXboxParams(params = {}) {
  let productId = '';
  if (typeof params.xboxProductId === 'string' && params.xboxProductId.trim()) {
    productId = params.xboxProductId.replace(/^xbox[-_:]/i, '').trim().toUpperCase();
  } else if (
    typeof params.gameId === 'string' &&
    /^xbox[-_:][A-Z0-9]{12}$/i.test(params.gameId.trim())
  ) {
    productId = params.gameId.trim().replace(/^xbox[-_:]/i, '').toUpperCase();
  }
  const pfn = String(params.xboxPfn || params.packageFamilyName || params.pfn || '').trim();
  const titleId =
    params.xboxTitleId !== undefined && params.xboxTitleId !== null
      ? String(params.xboxTitleId).trim()
      : '';
  return {
    productId: /^[A-Z0-9]{12}$/.test(productId) ? productId : '',
    pfn,
    titleId,
  };
}

const STEAM_CDN_DOMAINS = [
  'steamstatic.com',
  'akamaihd.net',
  'steamcdn-a.akamaihd.net',
  'steampowered.com',
];
const GOG_CDN_DOMAINS = ['gog-statics.com', 'gog.com'];
const EPIC_CDN_DOMAINS = ['epicgames.com', 'unrealengine.com'];
const XBOX_CDN_DOMAINS = ['s-microsoft.com', 'xboxlive.com', 'microsoft.com'];

/**
 * @param {string} hostname
 * @param {string[]} allowedDomains
 * @returns {boolean}
 */
function isHostnameInAllowedDomains(hostname, allowedDomains) {
  const cleanHost = String(hostname || '').trim().toLowerCase();
  if (!cleanHost) return false;
  for (const dom of allowedDomains) {
    if (cleanHost === dom || cleanHost.endsWith(`.${dom}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Pure, universal, OS-agnostic URL-origin & content-hash compatibility check for local
 * first-party storefront cache federation.
 *
 * @param {'steam' | 'gog' | 'epic' | 'xbox' | string} storefront
 * @param {string | null | undefined} url
 * @param {Record<string, any> | null} [context]
 * @returns {boolean}
 */
function isFederatedStoreUrlCompatible(storefront, url, context = null) {
  const store = String(storefront || '').trim().toLowerCase();
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  const candRaw =
    context && typeof context.candidatePath === 'string' ? context.candidatePath.trim() : '';
  const normCand = candRaw ? candRaw.replace(/\\/g, '/') : '';

  if (!cleanUrl) {
    if (store === 'steam' && normCand && context?.steamAppId != null) {
      const ctxAppId = String(context.steamAppId).trim();
      const libMatch = normCand.match(/\/librarycache\/(\d+)(?:\/|_)/i);
      if (ctxAppId && libMatch && libMatch[1] !== ctxAppId) {
        return false;
      }
    } else if (store === 'gog' && normCand && context?.gogId != null) {
      const ctxGogId = String(context.gogId).trim();
      const gogDirMatch = normCand.match(/\/gog\/(\d+)\//i);
      if (ctxGogId && gogDirMatch && gogDirMatch[1] !== ctxGogId) {
        return false;
      }
    }
    return Boolean(
      store === 'steam' || store === 'gog' || store === 'epic' || store === 'xbox'
    );
  }

  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || '';

  if (store === 'steam') {
    if (!isHostnameInAllowedDomains(host, STEAM_CDN_DOMAINS)) {
      return false;
    }
    const appUrlMatch = pathname.match(/\/(?:steam|images)\/apps\/(\d+)\//i);
    const ctxAppId = context?.steamAppId != null ? String(context.steamAppId).trim() : '';
    if (appUrlMatch && ctxAppId && appUrlMatch[1] !== ctxAppId) {
      return false;
    }
    if (normCand) {
      const libMatch = normCand.match(/\/librarycache\/(\d+)(?:\/|_)/i);
      if (appUrlMatch && libMatch && libMatch[1] !== appUrlMatch[1]) {
        return false;
      }
      if (ctxAppId && libMatch && libMatch[1] !== ctxAppId) {
        return false;
      }
      const sha40SegMatch = pathname.match(/\/([0-9a-f]{40})\//i);
      if (sha40SegMatch) {
        const reqSha = sha40SegMatch[1].toLowerCase();
        if (!normCand.toLowerCase().includes(reqSha)) {
          return false;
        }
      }
      const sha40FileMatch = pathname.match(/\/([0-9a-f]{40})\.(?:jpg|jpeg|png|webp|ico)$/i);
      if (sha40FileMatch) {
        const candFileSha = path.posix.basename(normCand).match(/^([0-9a-f]{40})\./i);
        if (candFileSha && candFileSha[1].toLowerCase() !== sha40FileMatch[1].toLowerCase()) {
          return false;
        }
      }
    }
    return true;
  }

  if (store === 'gog') {
    if (!isHostnameInAllowedDomains(host, GOG_CDN_DOMAINS)) {
      return false;
    }
    if (normCand) {
      const gogDirMatch = normCand.match(/\/gog\/(\d+)\//i);
      const ctxGogId = context?.gogId != null ? String(context.gogId).trim() : '';
      if (gogDirMatch && ctxGogId && gogDirMatch[1] !== ctxGogId) {
        return false;
      }
      const urlHash64 = pathname.match(/([0-9a-f]{64})/i);
      const fileHash64 = path.posix.basename(normCand).match(/([0-9a-f]{64})/i);
      if (urlHash64 && fileHash64 && urlHash64[1].toLowerCase() !== fileHash64[1].toLowerCase()) {
        return false;
      }
    }
    return true;
  }

  if (store === 'epic') {
    return isHostnameInAllowedDomains(host, EPIC_CDN_DOMAINS);
  }

  if (store === 'xbox') {
    return isHostnameInAllowedDomains(host, XBOX_CDN_DOMAINS);
  }

  return false;
}

/**
 * @param {any} rawVal
 * @returns {string | undefined}
 */
function formatUnixSecondsOrIsoDate(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === '') return undefined;
  const trimmed = String(rawVal).trim();
  if (!trimmed) return undefined;
  if (typeof rawVal === 'number' || /^-?\d+$/.test(trimmed)) {
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    if (num >= 1970 && num <= 2098) {
      return String(Math.floor(num));
    }
    if (num < 157766400) return undefined;
    const ms = num > 1e11 ? num : num * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString().slice(0, 10);
      if (!iso.startsWith('2099') && !iso.startsWith('1970-01-01')) {
        return iso;
      }
    }
    return undefined;
  }
  if (trimmed.startsWith('2099')) return undefined;
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoMatch ? isoMatch[1] : trimmed;
}

/**
 * @param {any} html
 * @returns {string}
 */
function stripVideoTagsAndHtmlToPlainText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<video[\s\S]*?<\/video>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {any} html
 * @returns {string}
 */
function sanitizeOfflineHtmlRemovingVideos(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<video[\s\S]*?<\/video>/gi, '')
    .replace(/<source[^>]+type=["']video\/[^"']*["'][^>]*>/gi, '')
    .trim();
}

/**
 * @param {any} rawUrl
 * @param {string} [fallbackExt]
 * @returns {string}
 */
function normalizeGogImageTemplateUrl(rawUrl, fallbackExt = 'jpg') {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let u = rawUrl.trim();
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  u = u.replace(/\{ext\}/gi, fallbackExt);
  u = u.replace(/_?\{formatter\}/gi, '');
  if (/\.(?:mp4|webm|m3u8|ts)(?:$|\?)/i.test(u)) return '';
  return /^https?:\/\//i.test(u) ? u : '';
}

module.exports = {
  STEAM_GENRE_ID_NAMES,
  MAX_FEDERATED_IMAGE_BYTES,
  MIN_FEDERATED_IMAGE_BYTES,
  STOREFRONT_ROOTS_CACHE_TTL_MS,
  getLazyLauncherEngine,
  getSqliteDatabaseSync,
  setBoundedCache,
  resolveFederatorUserDataDir,
  detectImageMagicBytes,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  isExistingDirectory,
  isExistingDirectoryAsync,
  isExistingFile,
  isExistingFileAsync,
  isLikelySteamRoot,
  isLikelySteamRootAsync,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  invalidateStorefrontCacheRoots,
  discoverWindowsLocalDrivesAsync,
  getKnownWindowsLocalDrivesSync,
  clearCachedWindowsLocalDrives,
  resolveGogDbPathForRoot,
  resolveGogDbPathForRootAsync,
  extractSteamAppIdFromParams,
  extractGogIdFromParams,
  extractEpicAppNameFromParams,
  extractXboxParams,
  isFederatedStoreUrlCompatible,
  formatUnixSecondsOrIsoDate,
  stripVideoTagsAndHtmlToPlainText,
  sanitizeOfflineHtmlRemovingVideos,
  normalizeGogImageTemplateUrl,
};
