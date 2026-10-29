'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const {
  isContainedWithinRoot,
  resolveHostWindowsKnownFolders,
} = require('./securityAndPathUtils.cjs');
const {
  computePackageFamilyName,
  parseMicrosoftGameConfigXml: parseCoreMicrosoftGameConfigXml,
  parseAppxManifestXml,
  extractXmlAttr,
} = require('../storefronts/xbox/xboxConfigAndIds.cjs');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

let electronApp = null;
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object' && reqElectron.app) {
    electronApp = reqElectron.app;
  }
} catch {
  // Non-Electron test or CLI context
}

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

const gogWebCacheRowLookup = new Map();
const MAX_GOG_WEBCACHE_LOOKUP_ENTRIES = 512;
const gogGalaxyDbSnapshotLookup = new Map();
const MAX_GOG_DB_SNAPSHOT_ENTRIES = 4;
const gogRootWebCacheDirLookup = new Map();
const MAX_GOG_ROOT_WEBCACHE_DIR_ENTRIES = 16;
const xboxManifestScanLookup = new Map();
const MAX_XBOX_MANIFEST_LOOKUP_ENTRIES = 256;

const WIN32_LOCAL_DRIVES_TTL_MS = 10_000;
/** @type {string[] | null} */
let cachedWin32LocalDrives = null;
let cachedWin32LocalDrivesAt = 0;
/** @type {Promise<string[]> | null} */
let inFlightWin32DriveProbe = null;

function resolveFallbackWin32SystemDrives(options = {}) {
  const envObj = options && options.env && typeof options.env === 'object' ? options.env : process.env;
  const sysDriveRaw = String(envObj?.SystemDrive || 'C:').trim();
  const match = /^([A-Za-z]):/.exec(sysDriveRaw);
  const letter = match ? match[1].toUpperCase() : 'C';
  return [`${letter}:\\`];
}

/**
 * Asynchronously discovers local fixed (`DriveType=3`) and removable (`DriveType=2`) Windows
 * logical drives via CIM (`Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3"`),
 * cached with a `10s` TTL and skipping `DriveType=4` mapped SMB network shares so disconnected
 * NAS/VPN drives never stall the Electron main thread for 5-30 seconds.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string[]>}
 */
function discoverWindowsLocalDrivesAsync(options = {}) {
  const platform = options.platform || process.platform;
  const execFileFn =
    typeof options.execFileImpl === 'function' ? options.execFileImpl : execFile;
  if (platform !== 'win32' && typeof options.execFileImpl !== 'function') {
    return Promise.resolve([]);
  }
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const now = Number(nowFn());
  const useSharedCache = typeof options.execFileImpl !== 'function' && !options.bypassDriveCache;

  if (
    useSharedCache &&
    Array.isArray(cachedWin32LocalDrives) &&
    cachedWin32LocalDrives.length > 0 &&
    now - cachedWin32LocalDrivesAt < WIN32_LOCAL_DRIVES_TTL_MS
  ) {
    return Promise.resolve(cachedWin32LocalDrives.slice());
  }

  if (useSharedCache && inFlightWin32DriveProbe) {
    return inFlightWin32DriveProbe;
  }

  const probePromise = new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" | Select-Object -ExpandProperty DeviceID',
    ];
    try {
      execFileFn(
        'powershell.exe',
        args,
        { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 },
        (err, stdout) => {
          const drives = new Set();
          if (!err && typeof stdout === 'string') {
            for (const rawLine of stdout.split(/\r?\n/)) {
              const trimmed = rawLine.trim();
              const m = /^([A-Za-z]):\\?$/.exec(trimmed);
              if (m) {
                drives.add(`${m[1].toUpperCase()}:\\`);
              }
            }
          }
          if (drives.size === 0) {
            for (const d of resolveFallbackWin32SystemDrives(options)) {
              drives.add(d);
            }
          }
          const result = Array.from(drives);
          if (useSharedCache) {
            cachedWin32LocalDrives = result;
            cachedWin32LocalDrivesAt = Number(nowFn());
          }
          resolve(result.slice());
        }
      );
    } catch {
      const fallback = resolveFallbackWin32SystemDrives(options);
      if (useSharedCache) {
        cachedWin32LocalDrives = fallback;
        cachedWin32LocalDrivesAt = Number(nowFn());
      }
      resolve(fallback.slice());
    }
  }).finally(() => {
    if (inFlightWin32DriveProbe === probePromise) {
      inFlightWin32DriveProbe = null;
    }
  });

  if (useSharedCache) {
    inFlightWin32DriveProbe = probePromise;
  }
  return probePromise;
}

function getKnownWindowsLocalDrivesSync(options = {}) {
  if (Array.isArray(options.localDrives)) {
    return options.localDrives
      .map((d) => String(d || '').trim())
      .filter(Boolean)
      .map((d) => (/^[A-Za-z]:$/.test(d) ? `${d.toUpperCase()}\\` : d));
  }
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const now = Number(nowFn());
  if (Array.isArray(cachedWin32LocalDrives) && cachedWin32LocalDrives.length > 0) {
    if (now - cachedWin32LocalDrivesAt >= WIN32_LOCAL_DRIVES_TTL_MS) {
      discoverWindowsLocalDrivesAsync(options).catch(() => {});
    }
    return cachedWin32LocalDrives.slice();
  }
  discoverWindowsLocalDrivesAsync(options).catch(() => {});
  return resolveFallbackWin32SystemDrives(options);
}

function getLazyLauncherEngine() {
  try {
    return require('../launcherEngine.cjs');
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

  // PNG: 89 50 4E 47 0D 0A 1A 0A (check first 4 bytes per spec: 89 50 4E 47)
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
    // Reject ftypisom / ftypmp42 / ftypM4V (MP4 video containers!)
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

function isExistingDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

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
 * Dynamically discovers local storefront cache roots across macOS, macOS Wine/CrossOver/Whisky/Heroic
 * bottles, and Windows (`win32`), while honoring explicit unit-test isolation overrides.
 *
 * @param {Record<string, any>} [options]
 */
function discoverStorefrontCacheRoots(options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const userDataDir = resolveFederatorUserDataDir(options);
  const hasExplicitTestIsolation = Boolean(
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

  const launcherEngine = getLazyLauncherEngine();
  let bottlePaths = [];
  if (Array.isArray(options.bottlePaths)) {
    bottlePaths = options.bottlePaths.filter(Boolean);
  } else if (
    launcherEngine &&
    typeof launcherEngine.listAllInitializedBottlePaths === 'function' &&
    (!hasExplicitTestIsolation || Boolean(options.homedir || options.bottlePath))
  ) {
    try {
      bottlePaths = launcherEngine.listAllInitializedBottlePaths({
        ...options,
        platform,
        homedir,
      });
    } catch {
      bottlePaths = [];
    }
  }

  // 1. Steam Roots
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
  const gogRootsSet = new Set();
  const explicitGogRoots = Array.isArray(options.gogGalaxyRoots)
    ? options.gogGalaxyRoots
    : options.gogGalaxyRoot
      ? [options.gogGalaxyRoot]
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

  // 3. Heroic Roots (for images-cache/<sha256(url)> and legendaryConfig)
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

  // 5. Amazon Games SQLite DB Paths
  const amazonDbPathsSet = new Set();
  if (typeof options.amazonDbPath === 'string' && options.amazonDbPath.trim()) {
    if (isExistingFile(options.amazonDbPath.trim())) {
      amazonDbPathsSet.add(path.resolve(options.amazonDbPath.trim()));
    }
  } else {
    let localAppData = options.localAppData || '';
    if (!localAppData && (platform === 'win32' || options.windowsKnownFolders)) {
      try {
        const kf = resolveHostWindowsKnownFolders(options);
        localAppData = kf.localAppData || '';
      } catch {}
    }
    const amazonCandidates = [
      localAppData
        ? path.join(localAppData, 'Amazon Games', 'Data', 'Games', 'Sql', 'GameProductInfo.sqlite')
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
    for (const bottle of bottlePaths) {
      const usersDir = path.join(bottle, 'drive_c', 'users');
      if (isExistingDirectory(usersDir)) {
        try {
          for (const u of fs.readdirSync(usersDir)) {
            if (u === 'Public' || u.startsWith('.')) continue;
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
        } catch {}
      }
    }
    for (const c of amazonCandidates) {
      if (c && isExistingFile(c)) {
        amazonDbPathsSet.add(path.resolve(c));
      }
    }
  }

  // 6. XboxGames Roots (`<Drive>:\.GamingRoot`, `<Drive>:\XboxGames`, and macOS bottle `drive_c/XboxGames`)
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
    if (!hasExplicitTestIsolation && platform === 'win32') {
      const localDrives = getKnownWindowsLocalDrivesSync(options);
      for (const driveRoot of localDrives) {
        if (!isExistingDirectory(driveRoot)) continue;
        xboxCandidates.push(path.join(driveRoot, 'XboxGames'));
        // Parse `<Drive>:\.GamingRoot` (`RGBX` + u32 LE version 1 + UTF-16LE relative path)
        const gamingRootFile = path.join(driveRoot, '.GamingRoot');
        if (isExistingFile(gamingRootFile)) {
          try {
            const grBuf = fs.readFileSync(gamingRootFile);
            if (grBuf.length > 8 && grBuf.toString('ascii', 0, 4) === 'RGBX') {
              const relUtf16 = grBuf
                .subarray(8)
                .toString('utf16le')
                .replace(/\0+$/g, '')
                .trim();
              if (relUtf16 && !relUtf16.includes('..')) {
                const candidateCustomRoot = path.resolve(driveRoot, relUtf16);
                if (isContainedWithinRoot(driveRoot, candidateCustomRoot, 'win32')) {
                  xboxCandidates.push(candidateCustomRoot);
                }
              }
            }
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
            if (grBuf.length > 8 && grBuf.toString('ascii', 0, 4) === 'RGBX') {
              const relUtf16 = grBuf
                .subarray(8)
                .toString('utf16le')
                .replace(/\0+$/g, '')
                .trim();
              if (relUtf16 && !relUtf16.includes('..')) {
                const candidateCustomRoot = path.resolve(extraDir, relUtf16);
                if (isContainedWithinRoot(extraDir, candidateCustomRoot, platform)) {
                  xboxCandidates.push(candidateCustomRoot);
                }
              }
            }
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
  const xboxAppCacheDirsSet = new Set();
  if (Array.isArray(options.xboxAppCacheDirs)) {
    for (const xd of options.xboxAppCacheDirs) {
      if (xd && isExistingDirectory(xd)) {
        xboxAppCacheDirsSet.add(path.resolve(xd));
      }
    }
  } else {
    let localAppData = options.localAppData || '';
    if (!localAppData && (platform === 'win32' || options.windowsKnownFolders)) {
      try {
        const kf = resolveHostWindowsKnownFolders(options);
        localAppData = kf.localAppData || '';
      } catch {}
    }
    const appPkgSubDirs = [
      path.join('Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalState'),
      path.join('Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe', 'LocalCache'),
    ];
    const xboxCacheCandidates = [];
    for (const sub of appPkgSubDirs) {
      if (localAppData) xboxCacheCandidates.push(path.join(localAppData, sub));
      xboxCacheCandidates.push(path.join(homedir, 'AppData', 'Local', sub));
    }
    for (const bottle of bottlePaths) {
      const usersDir = path.join(bottle, 'drive_c', 'users');
      if (isExistingDirectory(usersDir)) {
        try {
          for (const u of fs.readdirSync(usersDir)) {
            if (u === 'Public' || u.startsWith('.')) continue;
            for (const sub of appPkgSubDirs) {
              xboxCacheCandidates.push(path.join(usersDir, u, 'AppData', 'Local', sub));
            }
          }
        } catch {}
      }
    }
    for (const c of xboxCacheCandidates) {
      if (c && isExistingDirectory(c)) {
        xboxAppCacheDirsSet.add(path.resolve(c));
      }
    }
  }

  return {
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
}

/**
 * Async variant of `discoverStorefrontCacheRoots` that awaits non-blocking local fixed/removable
 * drive enumeration (`DriveType=2 OR DriveType=3`, `10s` TTL) on `win32` before resolving roots.
 *
 * @param {Record<string, any>} [options]
 */
async function discoverStorefrontCacheRootsAsync(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32' && !Array.isArray(options.localDrives)) {
    const localDrives = await discoverWindowsLocalDrivesAsync(options);
    return discoverStorefrontCacheRoots({ ...options, localDrives });
  }
  return discoverStorefrontCacheRoots(options);
}

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

function extractXboxParams(params = {}) {
  let productId = '';
  if (typeof params.xboxProductId === 'string' && params.xboxProductId.trim()) {
    productId = params.xboxProductId.replace(/^xbox[-_:]/i, '').trim().toUpperCase();
  } else if (typeof params.gameId === 'string' && /^xbox[-_:][A-Z0-9]{12}$/i.test(params.gameId.trim())) {
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

/**
 * Delegates `MicrosoftGame.config` XML parsing to `../storefronts/xbox/xboxConfigAndIds.cjs`
 * (`parseCoreMicrosoftGameConfigXml` + `computePackageFamilyName` + sibling `AppxManifest.xml` PFN enrichment).
 * Supports both 1-arg `(xmlStr)` export compatibility and 4-arg federated manifest resolution.
 */
function parseMicrosoftGameConfigXml(xmlStr, configFilePath, gameFolderPath, xboxRoot) {
  if (!xmlStr || typeof xmlStr !== 'string') return null;
  if (arguments.length <= 1 || !configFilePath) {
    return parseCoreMicrosoftGameConfigXml(xmlStr);
  }

  const configDir = path.dirname(configFilePath);
  const wrappedXml = /<Game\b/i.test(xmlStr) ? xmlStr : `<Game configVersion="1">${xmlStr}</Game>`;
  const coreParsed = parseCoreMicrosoftGameConfigXml(wrappedXml);
  if (!coreParsed) return null;

  let identityName = String(coreParsed.identity?.name || '').trim();
  let identityPublisher = String(coreParsed.identity?.publisher || '').trim();
  let identityVersion = String(coreParsed.identity?.version || '').trim();
  let packageFamilyName = String(
    coreParsed.packageFamilyName || computePackageFamilyName(identityName, identityPublisher) || ''
  ).trim();
  if (!packageFamilyName && /_[0-9a-hjkmnp-tv-z]{13}$/i.test(identityName)) {
    packageFamilyName = identityName;
  }

  // Enrich missing PFN / Publisher from sibling AppxManifest.xml when present
  let appxFallbackDisplayName = '';
  let appxFallbackPublisherDisplayName = '';
  if (!packageFamilyName || !identityName) {
    const appxCandidates = [
      path.join(configDir, 'AppxManifest.xml'),
      ...(gameFolderPath && gameFolderPath !== configDir
        ? [path.join(gameFolderPath, 'AppxManifest.xml')]
        : []),
    ];
    for (const appxPath of appxCandidates) {
      if (!isExistingFile(appxPath)) continue;
      if (xboxRoot && !isContainedWithinRoot(xboxRoot, appxPath)) continue;
      try {
        const appxParsed = parseAppxManifestXml(fs.readFileSync(appxPath, 'utf8'));
        if (appxParsed) {
          if (!identityName && appxParsed.identity?.name) {
            identityName = appxParsed.identity.name;
          }
          if (!identityPublisher && appxParsed.identity?.publisher) {
            identityPublisher = appxParsed.identity.publisher;
          }
          if (!identityVersion && appxParsed.identity?.version) {
            identityVersion = appxParsed.identity.version;
          }
          if (!packageFamilyName) {
            packageFamilyName =
              appxParsed.packageFamilyName ||
              computePackageFamilyName(identityName, identityPublisher) ||
              '';
          }
          appxFallbackDisplayName = appxParsed.displayName || '';
          appxFallbackPublisherDisplayName = appxParsed.publisherDisplayName || '';
          break;
        }
      } catch {}
    }
  }

  const shellMatch = /<ShellVisuals\b([^>]*)\/?>/i.exec(xmlStr);
  const rawSquare44 = shellMatch ? extractXmlAttr(shellMatch[1], 'Square44x44Logo') : '';

  const rawTitleIdMatch = xmlStr.match(/<TitleId[^>]*>([^<]+)<\/TitleId>/i);
  const rawTitleIdStr = rawTitleIdMatch ? rawTitleIdMatch[1].trim() : '';
  let titleId = '';
  if (rawTitleIdStr) {
    if (/^\d+$/.test(rawTitleIdStr)) {
      titleId = rawTitleIdStr;
    } else if (/^(?:0x)?[0-9a-f]+$/i.test(rawTitleIdStr)) {
      titleId = String(parseInt(rawTitleIdStr.replace(/^0x/i, ''), 16) >>> 0);
    } else {
      titleId = coreParsed.titleIdDecimal || coreParsed.titleId || rawTitleIdStr;
    }
  }

  const rawStoreId = String(coreParsed.storeId || '').trim().toUpperCase();
  const productId = /^[A-Z0-9]{12}$/.test(rawStoreId) ? rawStoreId : '';

  const normalizeRelAsset = (rel) => {
    if (!rel) return '';
    const normalizedRel = rel.replace(/\\/g, path.sep);
    if (normalizedRel.includes('..')) return '';
    return path.resolve(configDir, normalizedRel);
  };

  /** @type {Record<string, any>} */
  const sv = coreParsed.shellVisuals || {};
  const square480Path = normalizeRelAsset(sv.square480x480Logo);
  const splashScreenPath = normalizeRelAsset(sv.splashScreenImage);
  const square150Path = normalizeRelAsset(sv.square150x150Logo);
  const square44Path = normalizeRelAsset(rawSquare44);
  const storeLogoPath = normalizeRelAsset(sv.storeLogo);
  const exeRel =
    (Array.isArray(coreParsed.executables) && coreParsed.executables[0]?.name) ||
    coreParsed.primaryExecutable ||
    '';
  const executablePath = exeRel ? normalizeRelAsset(exeRel) : '';

  const displayName =
    sv.defaultDisplayName ||
    appxFallbackDisplayName ||
    (gameFolderPath ? path.basename(gameFolderPath) : '');
  const publisherDisplayName =
    sv.publisherDisplayName || appxFallbackPublisherDisplayName || '';

  return {
    xboxRoot,
    gameFolderPath,
    configDir,
    configFilePath,
    productId,
    identityName,
    identityPublisher,
    packageFamilyName,
    identityVersion,
    titleId,
    titleIdHex: coreParsed.titleId || '',
    scid: coreParsed.scid || '',
    msaAppId: coreParsed.msaAppId || '',
    title: displayName,
    publisher: publisherDisplayName,
    executablePath: executablePath && isExistingFile(executablePath) ? executablePath : undefined,
    visuals: {
      square480Path,
      splashScreenPath,
      square150Path,
      square44Path,
      storeLogoPath,
    },
  };
}

function parseAppxManifestFolderFallback(xmlStr, appxFilePath, gameFolderPath, xboxRoot) {
  const appxParsed = parseAppxManifestXml(xmlStr);
  if (!appxParsed || appxParsed.isFramework || appxParsed.isResourcePackage) return null;
  const configDir = path.dirname(appxFilePath);
  const identityName = String(appxParsed.identity?.name || '').trim();
  const identityPublisher = String(appxParsed.identity?.publisher || '').trim();
  const packageFamilyName = String(
    appxParsed.packageFamilyName || computePackageFamilyName(identityName, identityPublisher) || ''
  ).trim();
  const normalizeRelAsset = (rel) => {
    if (!rel) return '';
    const normalizedRel = rel.replace(/\\/g, path.sep);
    if (normalizedRel.includes('..')) return '';
    return path.resolve(configDir, normalizedRel);
  };
  const primaryApp = Array.isArray(appxParsed.applications) ? appxParsed.applications[0] : null;
  const executablePath = primaryApp?.executable ? normalizeRelAsset(primaryApp.executable) : '';
  const visualMatch = /<uap:VisualElements\b([^>]*)\/?>/i.exec(xmlStr);
  const square150Path = visualMatch
    ? normalizeRelAsset(extractXmlAttr(visualMatch[1], 'Square150x150Logo'))
    : '';
  const square44Path = visualMatch
    ? normalizeRelAsset(extractXmlAttr(visualMatch[1], 'Square44x44Logo'))
    : '';
  const storeLogoTag = /<Logo[^>]*>([^<]+)<\/Logo>/i.exec(xmlStr);
  const storeLogoPath = storeLogoTag ? normalizeRelAsset(storeLogoTag[1].trim()) : '';

  return {
    xboxRoot,
    gameFolderPath,
    configDir,
    configFilePath: appxFilePath,
    productId: '',
    identityName,
    identityPublisher,
    packageFamilyName,
    identityVersion: String(appxParsed.identity?.version || '').trim(),
    titleId: '',
    titleIdHex: '',
    scid: '',
    msaAppId: '',
    title:
      (appxParsed.displayName && !appxParsed.displayName.startsWith('ms-resource:')
        ? appxParsed.displayName
        : '') || path.basename(gameFolderPath),
    publisher:
      appxParsed.publisherDisplayName && !appxParsed.publisherDisplayName.startsWith('ms-resource:')
        ? appxParsed.publisherDisplayName
        : '',
    executablePath: executablePath && isExistingFile(executablePath) ? executablePath : undefined,
    visuals: {
      square480Path: '',
      splashScreenPath: '',
      square150Path,
      square44Path,
      storeLogoPath,
    },
  };
}

function scanLocalXboxGameManifests(roots, options = {}) {
  const xboxRoots = Array.isArray(roots?.xboxGamesRoots) ? roots.xboxGamesRoots : [];
  const manifests = [];

  for (const xboxRoot of xboxRoots) {
    if (!isExistingDirectory(xboxRoot)) continue;
    let gameDirs = [];
    try {
      gameDirs = fs.readdirSync(xboxRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of gameDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const gameFolderPath = path.join(xboxRoot, dirent.name);
      const configCandidates = [
        path.join(gameFolderPath, 'Content', 'MicrosoftGame.config'),
        path.join(gameFolderPath, 'MicrosoftGame.config'),
      ];

      let foundForFolder = false;
      for (const cfgPath of configCandidates) {
        if (!isExistingFile(cfgPath)) continue;
        if (!isContainedWithinRoot(xboxRoot, cfgPath, options.platform)) continue;
        try {
          const st = fs.statSync(cfgPath);
          const cacheKey = `${cfgPath}::${st.mtimeMs}::${st.size}`;
          let parsed = xboxManifestScanLookup.get(cacheKey);
          if (!parsed) {
            const xmlStr = fs.readFileSync(cfgPath, 'utf8');
            parsed = parseMicrosoftGameConfigXml(xmlStr, cfgPath, gameFolderPath, xboxRoot);
            if (parsed) {
              setBoundedCache(
                xboxManifestScanLookup,
                cacheKey,
                parsed,
                MAX_XBOX_MANIFEST_LOOKUP_ENTRIES
              );
            }
          }
          if (parsed) {
            manifests.push(parsed);
            foundForFolder = true;
            break;
          }
        } catch {}
      }

      if (!foundForFolder) {
        const appxCandidates = [
          path.join(gameFolderPath, 'Content', 'AppxManifest.xml'),
          path.join(gameFolderPath, 'AppxManifest.xml'),
        ];
        for (const appxPath of appxCandidates) {
          if (!isExistingFile(appxPath)) continue;
          if (!isContainedWithinRoot(xboxRoot, appxPath, options.platform)) continue;
          try {
            const st = fs.statSync(appxPath);
            const cacheKey = `appx::${appxPath}::${st.mtimeMs}::${st.size}`;
            let parsed = xboxManifestScanLookup.get(cacheKey);
            if (!parsed) {
              const xmlStr = fs.readFileSync(appxPath, 'utf8');
              parsed = parseAppxManifestFolderFallback(xmlStr, appxPath, gameFolderPath, xboxRoot);
              if (parsed) {
                setBoundedCache(
                  xboxManifestScanLookup,
                  cacheKey,
                  parsed,
                  MAX_XBOX_MANIFEST_LOOKUP_ENTRIES
                );
              }
            }
            if (parsed) {
              manifests.push(parsed);
              break;
            }
          } catch {}
        }
      }
    }
  }

  return manifests;
}

function matchXboxManifest(manifests, { productId = '', pfn = '', titleId = '', title = '' }) {
  const cleanProd = String(productId || '').toUpperCase();
  const cleanPfnLower = String(pfn || '').toLowerCase();
  const pfnPrefixLower = cleanPfnLower.includes('_')
    ? cleanPfnLower.slice(0, cleanPfnLower.lastIndexOf('_'))
    : cleanPfnLower;
  const cleanTid = String(titleId || '').trim();
  const cleanTidUpper = cleanTid.replace(/^0x/i, '').toUpperCase();
  const normTitle = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  for (const m of manifests) {
    if (cleanProd && m.productId && m.productId === cleanProd) return m;
    if (cleanPfnLower) {
      if (m.packageFamilyName && m.packageFamilyName.toLowerCase() === cleanPfnLower) {
        return m;
      }
      if (m.identityName) {
        const idLower = m.identityName.toLowerCase();
        if (idLower === cleanPfnLower || (pfnPrefixLower && idLower === pfnPrefixLower)) {
          return m;
        }
      }
    }
    if (
      cleanTid &&
      ((m.titleId && m.titleId === cleanTid) ||
        (m.titleIdHex && m.titleIdHex.toUpperCase() === cleanTidUpper))
    ) {
      return m;
    }
  }

  if (normTitle) {
    for (const m of manifests) {
      const candNorm = String(m.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (candNorm && candNorm === normTitle) return m;
    }
  }
  return null;
}

/**
 * Resolves a zero-copy local Xbox artwork asset from `<Drive>:\XboxGames\*\Content\MicrosoftGame.config`
 * `<ShellVisuals>` (`Square480x480Logo`, `SplashScreenImage`, `StoreLogo`, `Square150x150Logo`) or
 * `Microsoft.GamingApp_8wekyb3d8bbwe\LocalState` / `LocalCache` image caches.
 */
function resolveXboxFederatedAsset(xboxParamsOrPayload, role, url, roots, options = {}) {
  // Support 2-arg public call `resolveXboxFederatedAsset(params, options)` as well as 5-arg internal call
  if (
    arguments.length <= 2 &&
    xboxParamsOrPayload &&
    typeof xboxParamsOrPayload === 'object' &&
    (!roots || typeof roots !== 'object')
  ) {
    const opts = role && typeof role === 'object' ? role : {};
    const resolvedRoots = opts._precomputedRoots || discoverStorefrontCacheRoots(opts);
    const extracted = extractXboxParams(xboxParamsOrPayload);
    const resolvedRole = String(xboxParamsOrPayload.role || 'cover').trim();
    const resolvedUrl = typeof xboxParamsOrPayload.url === 'string' ? xboxParamsOrPayload.url.trim() : '';
    return resolveXboxFederatedAsset(extracted, resolvedRole, resolvedUrl, resolvedRoots, {
      ...opts,
      title: xboxParamsOrPayload.title || opts.title,
    });
  }
  const xboxParams = xboxParamsOrPayload || {};
  const manifests = scanLocalXboxGameManifests(roots, options);
  const matched = matchXboxManifest(manifests, {
    ...xboxParams,
    title: options.title,
  });

  if (matched) {
    const v = matched.visuals || {};
    const orderedCandidates =
      role === 'header'
        ? [v.splashScreenPath, v.square480Path, v.storeLogoPath]
        : role === 'icon'
          ? [v.square150Path, v.square44Path, v.storeLogoPath, v.square480Path]
          : [v.square480Path, v.storeLogoPath, v.square150Path, v.splashScreenPath];

    for (const candidate of orderedCandidates) {
      if (!candidate) continue;
      const validated = validateFederatedImageFile(candidate, matched.xboxRoot, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'xbox_microsoft_game_config',
        };
      }
    }
  }

  // Fallback: Check `Microsoft.GamingApp_8wekyb3d8bbwe\LocalState` / `LocalCache` for cached Store images
  const cacheDirs = Array.isArray(roots?.xboxAppCacheDirs) ? roots.xboxAppCacheDirs : [];
  if (cacheDirs.length > 0 && (xboxParams.productId || url)) {
    const urlHash =
      url && /^https?:\/\//i.test(url)
        ? crypto.createHash('sha256').update(url).digest('hex')
        : '';
    const stems = [
      ...(xboxParams.productId
        ? [`${xboxParams.productId}_${role}`, xboxParams.productId]
        : []),
      ...(urlHash ? [urlHash] : []),
    ];
    const exts = ['png', 'jpg', 'jpeg', 'webp'];

    for (const cacheDir of cacheDirs) {
      const subDirs = [cacheDir, path.join(cacheDir, 'ImageCache'), path.join(cacheDir, 'Images')];
      for (const dir of subDirs) {
        if (!isExistingDirectory(dir)) continue;
        for (const stem of stems) {
          for (const ext of exts) {
            const candidate = path.join(dir, `${stem}.${ext}`);
            const validated = validateFederatedImageFile(candidate, cacheDir, options);
            if (validated.valid) {
              return {
                path: validated.path,
                mimeType: validated.mimeType,
                ext: validated.ext,
                sizeBytes: validated.sizeBytes,
                source: 'xbox_gaming_app_cache',
              };
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves a local Steam image asset across user custom grids, modern nested SHA-1
 * `appcache/librarycache/<appId>/<sha1>/...` directories (1-2 levels), direct `<appId>/...`,
 * legacy flat `<appId>_...`, and `steam/games/*.ico`.
 */
function resolveSteamFederatedAsset(appId, role, url, roots, options = {}) {
  if (!appId || !/^\d+$/.test(appId)) return null;
  const exts = ['webp', 'png', 'jpg', 'jpeg'];

  for (const steamRoot of roots.steamRoots) {
    const candidates = [];

    // 1. User custom grid overrides: userdata/<steam3Id>/config/grid/
    const userdataDir = path.join(steamRoot, 'userdata');
    if (isExistingDirectory(userdataDir)) {
      try {
        for (const uid of fs.readdirSync(userdataDir)) {
          if (!/^\d+$/.test(uid)) continue;
          const gridDir = path.join(userdataDir, uid, 'config', 'grid');
          if (!isExistingDirectory(gridDir)) continue;
          if (role === 'cover') {
            for (const ext of exts) {
              candidates.push(path.join(gridDir, `${appId}p.${ext}`));
            }
          } else if (role === 'header') {
            for (const ext of exts) {
              candidates.push(path.join(gridDir, `${appId}.${ext}`));
              candidates.push(path.join(gridDir, `${appId}_hero.${ext}`));
            }
          } else if (role === 'icon') {
            for (const ext of [...exts, 'ico']) {
              candidates.push(path.join(gridDir, `${appId}_icon.${ext}`));
            }
          }
        }
      } catch {}
    }

    // 2. Modern Steam librarycache/<appId>/ (direct + 1-2 nested SHA1 subdirectories) & legacy flat
    const libCacheDir = path.join(steamRoot, 'appcache', 'librarycache');
    const appCacheDir = path.join(libCacheDir, appId);

    const roleStemNames =
      role === 'cover'
        ? ['library_600x900', 'library_capsule', 'library_600x900_2x']
        : role === 'header'
          ? ['header', 'library_header', 'library_hero']
          : role === 'icon'
            ? ['icon', `${appId}_icon`]
            : [];

    if (isExistingDirectory(appCacheDir)) {
      const searchDirs = [appCacheDir];
      try {
        const level1 = fs.readdirSync(appCacheDir, { withFileTypes: true });
        for (const ent1 of level1) {
          if (ent1.isDirectory() && !ent1.name.startsWith('.')) {
            const sub1 = path.join(appCacheDir, ent1.name);
            searchDirs.push(sub1);
            try {
              const level2 = fs.readdirSync(sub1, { withFileTypes: true });
              for (const ent2 of level2) {
                if (ent2.isDirectory() && !ent2.name.startsWith('.')) {
                  searchDirs.push(path.join(sub1, ent2.name));
                }
              }
            } catch {}
          }
        }
      } catch {}

      for (const dir of searchDirs) {
        for (const stem of roleStemNames) {
          for (const ext of role === 'icon' ? [...exts, 'ico'] : exts) {
            candidates.push(path.join(dir, `${stem}.${ext}`));
          }
        }
      }

      // Steam stores square app icons as `<40-char-sha1>.jpg` inside `librarycache/<appId>/`
      if (role === 'icon') {
        try {
          for (const fileName of fs.readdirSync(appCacheDir)) {
            if (/^[0-9a-f]{40}\.(?:jpg|jpeg|png|webp|ico)$/i.test(fileName)) {
              candidates.push(path.join(appCacheDir, fileName));
            }
          }
        } catch {}
      }
    }

    // 3. Legacy flat files in appcache/librarycache/
    if (isExistingDirectory(libCacheDir)) {
      if (role === 'cover') {
        for (const ext of exts) {
          candidates.push(path.join(libCacheDir, `${appId}_library_600x900.${ext}`));
          candidates.push(path.join(libCacheDir, `${appId}_library_capsule.${ext}`));
        }
      } else if (role === 'header') {
        for (const ext of exts) {
          candidates.push(path.join(libCacheDir, `${appId}_header.${ext}`));
          candidates.push(path.join(libCacheDir, `${appId}_library_hero.${ext}`));
        }
      } else if (role === 'icon') {
        for (const ext of [...exts, 'ico']) {
          candidates.push(path.join(libCacheDir, `${appId}_icon.${ext}`));
        }
      }
    }

    // 4. steam/games/*.ico for icons
    if (role === 'icon') {
      const gamesIcoDirs = [
        path.join(steamRoot, 'steam', 'games'),
        path.join(steamRoot, 'Steam', 'games'),
      ];
      const urlHashMatch =
        typeof url === 'string' ? url.match(/\/([0-9a-f]{40})\.(?:ico|jpg|png)/i) : null;
      let vdfClientIcon = '';
      if (!urlHashMatch) {
        const launcherEngine = getLazyLauncherEngine();
        const appinfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');
        if (launcherEngine && typeof launcherEngine.readSteamAppInfoParsedEntry === 'function') {
          const parsed = launcherEngine.readSteamAppInfoParsedEntry(appinfoPath, appId);
          const root = parsed?.appinfo || parsed;
          vdfClientIcon = String(root?.common?.clienticon || root?.common?.icon || '').trim();
        }
      }
      for (const icoDir of gamesIcoDirs) {
        if (!isExistingDirectory(icoDir)) continue;
        if (urlHashMatch && urlHashMatch[1]) {
          candidates.push(path.join(icoDir, `${urlHashMatch[1]}.ico`));
        }
        if (vdfClientIcon && /^[0-9a-f]{40}$/i.test(vdfClientIcon)) {
          candidates.push(path.join(icoDir, `${vdfClientIcon}.ico`));
        }
        candidates.push(path.join(icoDir, `${appId}.ico`));
      }
    }

    for (const candidate of candidates) {
      const validated = validateFederatedImageFile(candidate, steamRoot, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'steam_local_cache',
        };
      }
    }
  }

  return null;
}

/**
 * Opens GOG Galaxy 2.0 `galaxy-2.0.db` (`{ readOnly: true }`) ONCE per `(dbPath, mtimeMs, size)`
 * across an entire GOG federation scan, indexing `WebCache` resources and `GamePieces` raw rows
 * in memory and immediately closing the SQLite descriptor so Windows file locks are never held.
 */
function loadGogGalaxyDbSnapshot(dbPath, DatabaseSync) {
  if (!dbPath || !DatabaseSync) return null;
  let sig = '';
  try {
    const st = fs.statSync(dbPath);
    sig = `${dbPath}::${st.mtimeMs}::${st.size}`;
  } catch {
    return null;
  }
  if (gogGalaxyDbSnapshotLookup.has(sig)) {
    return gogGalaxyDbSnapshotLookup.get(sig);
  }

  const webCacheByGogId = new Map();
  const piecesByGogId = new Map();
  const parsedMetaByGogId = new Map();

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const wcRows = db
        .prepare(
          `
          SELECT
            wc.releaseKey AS releaseKey,
            CAST(wc.userId AS TEXT) AS userId,
            wcrt.type AS resourceType,
            wcr.filename AS filename
          FROM WebCache wc
          JOIN WebCacheResources wcr ON wcr.webCacheId = wc.id
          JOIN WebCacheResourceTypes wcrt ON wcrt.id = wcr.webCacheResourceTypeId
          WHERE wc.releaseKey LIKE 'gog_%'
        `
        )
        .all();
      for (const r of wcRows) {
        if (!r || typeof r.releaseKey !== 'string' || !r.releaseKey.startsWith('gog_')) continue;
        const gid = r.releaseKey.slice(4);
        if (!/^\d+$/.test(gid)) continue;
        let arr = webCacheByGogId.get(gid);
        if (!arr) {
          arr = [];
          webCacheByGogId.set(gid, arr);
        }
        arr.push({
          userId: r.userId,
          resourceType: r.resourceType,
          filename: r.filename,
        });
      }
    } catch (wcErr) {
      diagLog.debug('federator.gogSnapshotWebCache', wcErr, { dbPath });
    }

    try {
      const gpRows = db
        .prepare(
          `
          SELECT gp.releaseKey AS releaseKey, gpt.type AS pieceType, gp.value AS valueJson
          FROM GamePieces gp
          JOIN GamePieceTypes gpt ON gpt.id = gp.gamePieceTypeId
          WHERE gp.releaseKey LIKE 'gog_%'
        `
        )
        .all();
      for (const r of gpRows) {
        if (!r || typeof r.releaseKey !== 'string' || !r.releaseKey.startsWith('gog_')) continue;
        const gid = r.releaseKey.slice(4);
        if (!/^\d+$/.test(gid)) continue;
        let mapForGame = piecesByGogId.get(gid);
        if (!mapForGame) {
          mapForGame = new Map();
          piecesByGogId.set(gid, mapForGame);
        }
        if (r.pieceType && typeof r.valueJson === 'string' && !mapForGame.has(r.pieceType)) {
          mapForGame.set(r.pieceType, r.valueJson);
        }
      }
    } catch (gpErr) {
      diagLog.debug('federator.gogSnapshotGamePieces', gpErr, { dbPath });
    }
  } catch (err) {
    diagLog.debug('federator.gogSnapshotOpen', err, { dbPath });
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }

  const snapshot = {
    webCacheByGogId,
    piecesByGogId,
    parsedMetaByGogId,
  };
  setBoundedCache(gogGalaxyDbSnapshotLookup, sig, snapshot, MAX_GOG_DB_SNAPSHOT_ENTRIES);
  return snapshot;
}

/**
 * Queries GOG Galaxy 2.0 `galaxy-2.0.db` read-only (via single-open snapshot cache) with
 * `CAST(wc.userId AS TEXT)` 64-bit safety to locate cached images in
 * `<gogRoot>/{webcache,WebCache}/<userId>/gog/<productId>/<filename>`.
 */
function resolveGogFederatedAsset(gogId, role, roots, options = {}) {
  if (!gogId || !/^\d+$/.test(gogId)) return null;
  const gogResourceType =
    role === 'cover'
      ? 'verticalCover'
      : role === 'header'
        ? 'background'
        : role === 'icon'
          ? 'squareIcon'
          : '';
  if (!gogResourceType) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  for (const gogRoot of roots.gogRoots) {
    const dbPath = resolveGogDbPathForRoot(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    const rows = snapshot?.webCacheByGogId?.get(gogId) || null;
    if (!Array.isArray(rows) || rows.length === 0) continue;

    let actualWebCacheFolder = gogRootWebCacheDirLookup.get(gogRoot);
    if (actualWebCacheFolder === undefined) {
      actualWebCacheFolder = '';
      try {
        const rootEntries = fs.readdirSync(gogRoot);
        actualWebCacheFolder =
          rootEntries.find((e) => e.toLowerCase() === 'webcache') || '';
      } catch {}
      setBoundedCache(
        gogRootWebCacheDirLookup,
        gogRoot,
        actualWebCacheFolder,
        MAX_GOG_ROOT_WEBCACHE_DIR_ENTRIES
      );
    }

    for (const row of rows) {
      if (!row || row.resourceType !== gogResourceType) continue;
      const userIdStr = String(row.userId || '').trim();
      const filename = String(row.filename || '').trim();
      if (!userIdStr || !filename || filename.includes('..') || /[\\/]/.test(filename)) {
        continue;
      }

      const webCacheDirs = actualWebCacheFolder
        ? [path.join(gogRoot, actualWebCacheFolder, userIdStr, 'gog', gogId)]
        : [
            path.join(gogRoot, 'WebCache', userIdStr, 'gog', gogId),
            path.join(gogRoot, 'webcache', userIdStr, 'gog', gogId),
          ];
      for (const dir of webCacheDirs) {
        const candidatePath = path.join(dir, filename);
        const validated = validateFederatedImageFile(candidatePath, gogRoot, options);
        if (validated.valid) {
          return {
            path: validated.path,
            mimeType: validated.mimeType,
            ext: validated.ext,
            sizeBytes: validated.sizeBytes,
            source: 'gog_galaxy_webcache',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Checks Heroic Games Launcher's `images-cache/<sha256(upstreamUrl)>` directory.
 */
function resolveHeroicImagesCacheAsset(url, roots, options = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    return null;
  }
  const cleanUrl = url.trim();
  const shaHex = crypto.createHash('sha256').update(cleanUrl).digest('hex');

  for (const heroicRoot of roots.heroicRoots) {
    const imgCacheDir = path.join(heroicRoot, 'images-cache');
    if (!isExistingDirectory(imgCacheDir)) continue;

    const candidates = [
      path.join(imgCacheDir, shaHex),
      path.join(imgCacheDir, `${shaHex}.webp`),
      path.join(imgCacheDir, `${shaHex}.jpg`),
      path.join(imgCacheDir, `${shaHex}.png`),
    ];
    for (const candidate of candidates) {
      const validated = validateFederatedImageFile(candidate, imgCacheDir, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'heroic_images_cache',
        };
      }
    }
  }

  return null;
}

/**
 * Unified zero-copy local first-party cache resolver across Steam, GOG Galaxy, and Heroic.
 *
 * @param {Record<string, any>} params
 * @param {Record<string, any>} [options]
 */
function resolveFederatedAsset(params = {}, options = {}) {
  if (!params || typeof params !== 'object') return null;
  const role = String(params.role || 'cover').trim();
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  const steamAppId = extractSteamAppIdFromParams(params);
  if (steamAppId && roots.steamRoots.length > 0) {
    const steamHit = resolveSteamFederatedAsset(steamAppId, role, url, roots, options);
    if (steamHit) return steamHit;
  }

  const gogId = extractGogIdFromParams(params);
  if (gogId && roots.gogRoots.length > 0) {
    const gogHit = resolveGogFederatedAsset(gogId, role, roots, options);
    if (gogHit) return gogHit;
  }

  const xboxParams = extractXboxParams(params);
  if (
    (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) &&
    ((roots.xboxGamesRoots && roots.xboxGamesRoots.length > 0) ||
      (roots.xboxAppCacheDirs && roots.xboxAppCacheDirs.length > 0))
  ) {
    const xboxHit = resolveXboxFederatedAsset(
      xboxParams,
      role,
      url,
      roots,
      { ...options, title: params.title || options.title }
    );
    if (xboxHit) return xboxHit;
  }

  // If Epic game has no explicit URL passed yet, check local Legendary keyImages URL against Heroic images-cache
  let effectiveUrl = url;
  const epicAppName = extractEpicAppNameFromParams(params);
  if (!effectiveUrl && epicAppName && roots.legendaryDirs.length > 0 && roots.heroicRoots.length > 0) {
    const localEpic = resolveLocalEpicMetadata(epicAppName, {
      ...options,
      _precomputedRoots: roots,
    });
    if (localEpic) {
      if (role === 'cover' && localEpic.capsuleImage) {
        effectiveUrl = localEpic.capsuleImage;
      } else if (role === 'header' && localEpic.headerImage) {
        effectiveUrl = localEpic.headerImage;
      }
    }
  }

  if (effectiveUrl && roots.heroicRoots.length > 0) {
    const heroicHit = resolveHeroicImagesCacheAsset(effectiveUrl, roots, options);
    if (heroicHit) return heroicHit;
  }

  return null;
}

function formatUnixSecondsOrIsoDate(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === '') return undefined;
  if (typeof rawVal === 'number' || /^\d{9,13}$/.test(String(rawVal).trim())) {
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num <= 0) return undefined;
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
  const str = String(rawVal).trim();
  if (!str || str.startsWith('2099')) return undefined;
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoMatch ? isoMatch[1] : str;
}

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

function sanitizeOfflineHtmlRemovingVideos(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<video[\s\S]*?<\/video>/gi, '')
    .replace(/<source[^>]+type=["']video\/[^"']*["'][^>]*>/gi, '')
    .trim();
}

function normalizeGogImageTemplateUrl(rawUrl, fallbackExt = 'jpg') {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let u = rawUrl.trim();
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  // GOG Statics uses `_{formatter}.jpg` whereas GOG GamesDB uses `{formatter}.{ext}`
  u = u.replace(/\{ext\}/gi, fallbackExt);
  u = u.replace(/_?\{formatter\}/gi, '');
  if (/\.(?:mp4|webm|m3u8|ts)(?:$|\?)/i.test(u)) return '';
  return /^https?:\/\//i.test(u) ? u : '';
}

/**
 * Resolves local Steam metadata for `appId` from `appcache/appinfo.vdf` (via `launcherEngine`)
 * and `userdata/<steam3Id>/config/librarycache/<appId>.json`.
 *
 * @param {number | string} appId
 * @param {Record<string, any>} [options]
 */
function resolveLocalSteamMetadata(appId, options = {}) {
  const cleanStr = String(appId || '').replace(/^steam[-_]/i, '').trim();
  const numericAppId = parseInt(cleanStr, 10);
  if (!numericAppId || Number.isNaN(numericAppId)) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const launcherEngine = getLazyLauncherEngine();

  let name = '';
  const developersSet = new Set();
  const publishersSet = new Set();
  const genresSet = new Set();
  let releaseDate = undefined;
  let platforms = null;
  let shortDescription = '';
  let detailedDescription = '';
  let metacriticScore = undefined;

  for (const steamRoot of roots.steamRoots) {
    // 1. Binary appinfo.vdf
    const appinfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');
    if (isExistingFile(appinfoPath) && launcherEngine) {
      let parsed = null;
      if (typeof launcherEngine.readSteamAppInfoParsedEntry === 'function') {
        parsed = launcherEngine.readSteamAppInfoParsedEntry(appinfoPath, numericAppId);
      } else if (
        typeof launcherEngine.getIndexedSteamAppInfoVdf === 'function' &&
        typeof launcherEngine.parseSteamBinaryVdfSlice === 'function'
      ) {
        const idx = launcherEngine.getIndexedSteamAppInfoVdf(appinfoPath);
        const slice = idx?.appIndex?.get(numericAppId);
        if (slice && idx?.buf) {
          parsed = launcherEngine.parseSteamBinaryVdfSlice(
            idx.buf,
            slice.payloadStart,
            slice.payloadEnd,
            idx.strings
          );
        }
      }

      const root = parsed?.appinfo || parsed;
      const common = root?.common;
      const extended = root?.extended;

      if (common && typeof common === 'object') {
        if (!name && typeof common.name === 'string' && common.name.trim()) {
          name = common.name.trim();
        }
        if (typeof common.oslist === 'string' && common.oslist.trim()) {
          const osLower = common.oslist.toLowerCase();
          platforms = {
            windows: osLower.includes('windows'),
            mac: osLower.includes('macos') || osLower.includes('osx') || /\bmac\b/.test(osLower),
            linux: osLower.includes('linux'),
          };
        }
        if (!releaseDate) {
          releaseDate =
            formatUnixSecondsOrIsoDate(common.steam_release_date) ||
            formatUnixSecondsOrIsoDate(common.original_release_date);
        }
        if (common.associations && typeof common.associations === 'object') {
          for (const assoc of Object.values(common.associations)) {
            if (!assoc || typeof assoc !== 'object' || !assoc.name) continue;
            const t = String(assoc.type || '').toLowerCase();
            if (t === 'developer') developersSet.add(String(assoc.name).trim());
            else if (t === 'publisher') publishersSet.add(String(assoc.name).trim());
          }
        }
        if (common.genres && typeof common.genres === 'object') {
          for (const gVal of Object.values(common.genres)) {
            const gKey = String(gVal).trim();
            if (STEAM_GENRE_ID_NAMES[gKey]) {
              genresSet.add(STEAM_GENRE_ID_NAMES[gKey]);
            } else if (gKey && !/^\d+$/.test(gKey)) {
              genresSet.add(gKey);
            }
          }
        }
        if (typeof common.metacritic_score === 'number' && common.metacritic_score > 0) {
          metacriticScore = common.metacritic_score;
        }
      }

      if (extended && typeof extended === 'object') {
        if (typeof extended.developer === 'string' && extended.developer.trim()) {
          developersSet.add(extended.developer.trim());
        }
        if (typeof extended.publisher === 'string' && extended.publisher.trim()) {
          publishersSet.add(extended.publisher.trim());
        }
      }
    }

    // 2. userdata/<steam3Id>/config/librarycache/<appId>.json
    const userdataDir = path.join(steamRoot, 'userdata');
    if (isExistingDirectory(userdataDir)) {
      try {
        for (const uid of fs.readdirSync(userdataDir)) {
          if (!/^\d+$/.test(uid)) continue;
          const jsonPath = path.join(
            userdataDir,
            uid,
            'config',
            'librarycache',
            `${numericAppId}.json`
          );
          if (!isExistingFile(jsonPath)) continue;
          try {
            const rawJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (Array.isArray(rawJson)) {
              for (const entry of rawJson) {
                if (!Array.isArray(entry) || entry.length < 2) continue;
                const [section, payload] = entry;
                const data = payload?.data || payload;
                if (section === 'descriptions' && data && typeof data === 'object') {
                  if (!shortDescription && typeof data.strSnippet === 'string') {
                    shortDescription = stripVideoTagsAndHtmlToPlainText(data.strSnippet);
                  }
                  if (!detailedDescription && typeof data.strFullDescription === 'string') {
                    detailedDescription = sanitizeOfflineHtmlRemovingVideos(data.strFullDescription);
                  }
                } else if (section === 'associations' && data && typeof data === 'object') {
                  if (Array.isArray(data.rgDevelopers)) {
                    for (const d of data.rgDevelopers) {
                      const n = typeof d === 'string' ? d : d?.strName;
                      if (n) developersSet.add(String(n).trim());
                    }
                  }
                  if (Array.isArray(data.rgPublishers)) {
                    for (const p of data.rgPublishers) {
                      const n = typeof p === 'string' ? p : p?.strName;
                      if (n) publishersSet.add(String(n).trim());
                    }
                  }
                }
              }
            } else if (rawJson && typeof rawJson === 'object') {
              if (!name && typeof rawJson.name === 'string') name = rawJson.name.trim();
              if (!shortDescription && typeof rawJson.shortDescription === 'string') {
                shortDescription = stripVideoTagsAndHtmlToPlainText(rawJson.shortDescription);
              }
              if (!detailedDescription && typeof rawJson.detailedDescription === 'string') {
                detailedDescription = sanitizeOfflineHtmlRemovingVideos(rawJson.detailedDescription);
              }
              if (Array.isArray(rawJson.developers)) {
                rawJson.developers.forEach((d) => d && developersSet.add(String(d).trim()));
              }
              if (Array.isArray(rawJson.publishers)) {
                rawJson.publishers.forEach((p) => p && publishersSet.add(String(p).trim()));
              }
              if (Array.isArray(rawJson.genres)) {
                rawJson.genres.forEach((g) => g && genresSet.add(String(g).trim()));
              }
              if (!releaseDate && rawJson.releaseDate) {
                releaseDate = formatUnixSecondsOrIsoDate(rawJson.releaseDate);
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  const developers = Array.from(developersSet).filter(Boolean);
  const publishers = Array.from(publishersSet).filter(Boolean);
  const genres = Array.from(genresSet).filter(Boolean);

  if (
    !name &&
    developers.length === 0 &&
    publishers.length === 0 &&
    genres.length === 0 &&
    !releaseDate &&
    !platforms &&
    !shortDescription &&
    !detailedDescription
  ) {
    return null;
  }

  if (!shortDescription && detailedDescription) {
    shortDescription = stripVideoTagsAndHtmlToPlainText(detailedDescription).slice(0, 320);
  }

  return {
    appId: numericAppId,
    name: name || undefined,
    shortDescription: shortDescription || '',
    detailedDescription: detailedDescription || shortDescription || '',
    aboutTheGame: detailedDescription || shortDescription || '',
    developers,
    publishers,
    genres,
    tags: genres,
    categories: [],
    screenshots: [],
    movies: [],
    releaseDate: releaseDate || '',
    platforms: platforms || { windows: true, mac: false, linux: false },
    ...(metacriticScore ? { metacritic: { score: metacriticScore } } : {}),
    metadataQuality: 'local_federated',
  };
}

function parseGogPiecesMapToMetadata(cleanGogId, piecesByType) {
  if (!piecesByType || piecesByType.size === 0) return null;

  const getParsed = (type) => {
    const raw = piecesByType.get(type);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const titleObj = getParsed('title') || getParsed('originalTitle');
  const summaryObj = getParsed('summary');
  const metaObj = getParsed('meta');
  const origMetaObj = getParsed('originalMeta');
  const mediaObj = getParsed('media');
  const storeMediaObj = getParsed('storeMedia');
  const osObj = getParsed('osCompatibility');
  const storeOsObj = getParsed('storeOsCompatibility');
  const storeTagsObj = getParsed('storeTags');
  const localizationsObj = getParsed('localizations');
  const storeFeaturesObj = getParsed('storeFeatures');
  const reviewScoreObj = getParsed('reviewScore');
  const origImagesObj = getParsed('originalImages');
  const storeImagesObj = getParsed('storeImages');

  const name = String(titleObj?.title || '').trim();
  const rawSummaryHtml = String(summaryObj?.summary || summaryObj?.description || '').trim();
  const detailedDescription = sanitizeOfflineHtmlRemovingVideos(rawSummaryHtml);
  const shortDescription = stripVideoTagsAndHtmlToPlainText(rawSummaryHtml).slice(0, 360);

  const developers = Array.from(
    new Set([
      ...(Array.isArray(metaObj?.developers) ? metaObj.developers : []),
      ...(Array.isArray(origMetaObj?.developers) ? origMetaObj.developers : []),
    ])
  )
    .map((d) => (typeof d === 'string' ? d.trim() : String(d?.name || '').trim()))
    .filter(Boolean);

  const publishers = Array.from(
    new Set([
      ...(Array.isArray(metaObj?.publishers) ? metaObj.publishers : []),
      ...(Array.isArray(origMetaObj?.publishers) ? origMetaObj.publishers : []),
    ])
  )
    .map((p) => (typeof p === 'string' ? p.trim() : String(p?.name || '').trim()))
    .filter(Boolean);

  const genres = Array.from(
    new Set([
      ...(Array.isArray(metaObj?.genres) ? metaObj.genres : []),
      ...(Array.isArray(origMetaObj?.genres) ? origMetaObj.genres : []),
    ])
  )
    .map((g) => (typeof g === 'string' ? g.trim() : String(g?.name || '').trim()))
    .filter(Boolean);

  const tags = Array.from(
    new Set([
      ...(Array.isArray(storeTagsObj?.tags)
        ? storeTagsObj.tags.map((t) => (typeof t === 'string' ? t : t?.name))
        : []),
      ...(Array.isArray(metaObj?.themes) ? metaObj.themes : []),
    ])
  )
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  const categories = Array.isArray(storeFeaturesObj?.features)
    ? storeFeaturesObj.features
        .map((f) => String(typeof f === 'string' ? f : f?.name || '').trim())
        .filter(Boolean)
    : [];

  const supportedLanguages = Array.isArray(localizationsObj?.localizations)
    ? Array.from(
        new Set(
          localizationsObj.localizations
            .map((loc) => String(loc?.language || loc?.code || '').trim())
            .filter(Boolean)
        )
      ).join(', ')
    : undefined;

  const supportedOsArr = [
    ...(Array.isArray(osObj?.supported) ? osObj.supported : []),
    ...(Array.isArray(storeOsObj?.supported) ? storeOsObj.supported : []),
  ];
  let platforms = { windows: true, mac: false, linux: false };
  if (supportedOsArr.length > 0) {
    const slugs = supportedOsArr
      .map((item) => String(typeof item === 'string' ? item : item?.slug || item?.name || '').toLowerCase())
      .filter(Boolean);
    platforms = {
      windows: slugs.some((s) => s.includes('win')),
      mac: slugs.some((s) => s.includes('osx') || s.includes('mac')),
      linux: slugs.some((s) => s.includes('linux')),
    };
  }

  const releaseDate =
    formatUnixSecondsOrIsoDate(metaObj?.releaseDate) ||
    formatUnixSecondsOrIsoDate(origMetaObj?.releaseDate) ||
    '';

  const capsuleImage = normalizeGogImageTemplateUrl(origImagesObj?.verticalCover, 'webp');
  const headerImage =
    normalizeGogImageTemplateUrl(origImagesObj?.background, 'webp') ||
    normalizeGogImageTemplateUrl(storeImagesObj?.horizontalCover, 'png');
  const iconUrl = normalizeGogImageTemplateUrl(origImagesObj?.squareIcon, 'webp');

  const screenshotUrls = Array.from(
    new Set([
      ...(Array.isArray(storeMediaObj?.screenshots)
        ? storeMediaObj.screenshots.map((u) => normalizeGogImageTemplateUrl(u, 'jpg'))
        : []),
      ...(Array.isArray(mediaObj?.screenshots)
        ? mediaObj.screenshots.map((u) => normalizeGogImageTemplateUrl(u, 'webp'))
        : []),
    ])
  ).filter(Boolean);

  const screenshots = screenshotUrls.slice(0, 12).map((url, idx) => ({
    id: idx,
    pathThumbnail: url,
    pathFull: url,
  }));

  const rawCritics = metaObj?.criticsScore ?? origMetaObj?.criticsScore;
  const rawUserScore = reviewScoreObj?.score?.value ?? reviewScoreObj?.value;
  const criticScoreVal =
    typeof rawCritics === 'number' && rawCritics > 0
      ? Math.round(rawCritics)
      : typeof rawUserScore === 'number' && rawUserScore > 0
        ? Math.round(rawUserScore <= 5 ? rawUserScore * 20 : rawUserScore)
        : undefined;

  if (
    !name &&
    !shortDescription &&
    developers.length === 0 &&
    publishers.length === 0 &&
    genres.length === 0 &&
    !capsuleImage &&
    !headerImage &&
    screenshots.length === 0
  ) {
    return null;
  }

  return {
    appId: 0,
    gogId: cleanGogId,
    name: name || undefined,
    title: name || undefined,
    shortDescription,
    detailedDescription: detailedDescription || shortDescription,
    aboutTheGame: detailedDescription || shortDescription,
    headerImage: headerImage || undefined,
    capsuleImage: capsuleImage || undefined,
    iconUrl: iconUrl || undefined,
    developers,
    publishers,
    genres,
    tags,
    categories,
    ...(supportedLanguages ? { supportedLanguages } : {}),
    screenshots,
    movies: [],
    releaseDate,
    platforms,
    ...(criticScoreVal ? { metacritic: { score: criticScoreVal }, reviewScore: criticScoreVal } : {}),
    metadataQuality: 'local_federated',
  };
}

/**
 * Resolves local GOG metadata from `galaxy-2.0.db` (`GamePieces` joined with `GamePieceTypes`)
 * using the single-open read-only snapshot cache (`loadGogGalaxyDbSnapshot`).
 *
 * @param {string | number} gogId
 * @param {Record<string, any>} [options]
 */
function resolveLocalGogMetadata(gogId, options = {}) {
  const cleanGogId = String(gogId || '').replace(/^gog[-_]/i, '').trim();
  if (!cleanGogId || !/^\d+$/.test(cleanGogId)) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  for (const gogRoot of roots.gogRoots) {
    const dbPath = resolveGogDbPathForRoot(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    if (!snapshot) continue;

    if (snapshot.parsedMetaByGogId.has(cleanGogId)) {
      const cachedParsed = snapshot.parsedMetaByGogId.get(cleanGogId);
      if (cachedParsed) return cachedParsed;
      continue;
    }

    const piecesByType = snapshot.piecesByGogId.get(cleanGogId);
    if (piecesByType && piecesByType.size > 0) {
      const parsed = parseGogPiecesMapToMetadata(cleanGogId, piecesByType);
      snapshot.parsedMetaByGogId.set(cleanGogId, parsed || null);
      if (parsed) return parsed;
    } else {
      snapshot.parsedMetaByGogId.set(cleanGogId, null);
    }
  }

  return null;
}

/**
 * Enumerates owned/installed GOG games from local `galaxy-2.0.db` when `fetchGogOwnedGames` is offline,
 * reusing the single-open read-only `galaxy-2.0.db` snapshot.
 *
 * @param {Record<string, any>} [options]
 */
function listLocalGogCatalogGames(options = {}) {
  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return [];

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const gamesById = new Map();

  for (const gogRoot of roots.gogRoots) {
    const dbPath = resolveGogDbPathForRoot(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    if (!snapshot) continue;

    for (const [gogId, piecesMap] of snapshot.piecesByGogId.entries()) {
      if (gamesById.has(gogId)) continue;
      let meta = snapshot.parsedMetaByGogId.get(gogId);
      if (meta === undefined) {
        meta = parseGogPiecesMapToMetadata(gogId, piecesMap) || null;
        snapshot.parsedMetaByGogId.set(gogId, meta);
      }
      if (!meta || !meta.title) continue;
      gamesById.set(gogId, meta);
    }
  }

  return Array.from(gamesById.values());
}

function parseLegendaryMetadataJson(json, fallbackAppName) {
  if (!json || typeof json !== 'object') return null;
  const meta = json.metadata && typeof json.metadata === 'object' ? json.metadata : json;
  const appName = String(json.app_name || meta.app_name || fallbackAppName || '').trim();
  const title = String(json.app_title || meta.title || '').trim();
  if (!appName && !title) return null;

  // Detect DLC / non-base-game if mainGameItem is present
  const isDlc = Boolean(
    meta.mainGameItem && (meta.mainGameItem.id || meta.mainGameItem.namespace)
  );

  const rawDesc = String(meta.description || json.description || '').trim();
  const rawLong = String(meta.longDescription || meta.technicalDetails || '').trim();
  const shortDescription = stripVideoTagsAndHtmlToPlainText(rawDesc || rawLong).slice(0, 360);
  const detailedDescription = sanitizeOfflineHtmlRemovingVideos(rawLong || rawDesc);

  const developer = String(meta.developer || json.developer || '').trim();
  const publisher = String(meta.publisher || json.publisher || '').trim();

  const releaseInfo = Array.isArray(meta.releaseInfo) ? meta.releaseInfo : [];
  let rawReleaseDate = meta.releaseDate || meta.creationDate || '';
  if (!rawReleaseDate && releaseInfo.length > 0 && releaseInfo[0]?.dateAdded) {
    rawReleaseDate = releaseInfo[0].dateAdded;
  }
  const releaseDate = formatUnixSecondsOrIsoDate(rawReleaseDate) || '';

  const hasMacAsset = Boolean(json.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0);
  const hasMacRelease = releaseInfo.some(
    (r) =>
      r &&
      Array.isArray(r.platform) &&
      r.platform.some((p) => /^mac$/i.test(String(p)))
  );

  const keyImages = Array.isArray(meta.keyImages)
    ? meta.keyImages
    : Array.isArray(json.keyImages)
      ? json.keyImages
      : [];

  const findKeyImageUrl = (types) => {
    for (const t of types) {
      const hit = keyImages.find(
        (img) =>
          img &&
          typeof img.url === 'string' &&
          /^https?:\/\//i.test(img.url) &&
          img.type === t &&
          !/\.(?:mp4|webm|m3u8|ts)(?:$|\?)/i.test(img.url)
      );
      if (hit) return hit.url;
    }
    return undefined;
  };

  const capsuleImage = findKeyImageUrl(['DieselGameBoxTall', 'OfferImageTall']);
  const headerImage = findKeyImageUrl(['DieselGameBox', 'OfferImageWide', 'Thumbnail', 'DieselStoreFrontWide']);
  const screenshotUrls = keyImages
    .filter(
      (img) =>
        img &&
        typeof img.url === 'string' &&
        /^https?:\/\//i.test(img.url) &&
        ['featuredMedia', 'GalleryImage', 'Screenshot'].includes(img.type) &&
        !/\.(?:mp4|webm|m3u8|ts)(?:$|\?)/i.test(img.url)
    )
    .map((img) => img.url);

  const screenshots = Array.from(new Set(screenshotUrls)).map((url, idx) => ({
    id: idx,
    pathThumbnail: url,
    pathFull: url,
  }));

  return {
    appId: 0,
    appName,
    isDlc,
    namespace: meta.namespace || json.namespace || undefined,
    catalogItemId: meta.id || json.catalog_item_id || json.id || undefined,
    name: title || undefined,
    title: title || undefined,
    shortDescription,
    detailedDescription: detailedDescription || shortDescription,
    aboutTheGame: detailedDescription || shortDescription,
    headerImage: headerImage || capsuleImage,
    capsuleImage: capsuleImage || headerImage,
    keyImages,
    releaseInfo,
    developers: developer ? [developer] : [],
    publishers: publisher ? [publisher] : ['Epic Games Store'],
    genres: [],
    tags: ['Epic Games Store'],
    categories: [],
    screenshots,
    movies: [],
    releaseDate,
    platforms: {
      windows: true,
      mac: hasMacAsset || hasMacRelease,
      linux: false,
    },
    metadataQuality: 'local_federated',
  };
}

/**
 * Resolves local Epic / Legendary / Heroic metadata from `<legendaryDir>/metadata/<appName>.json`.
 *
 * @param {string} appName
 * @param {Record<string, any>} [options]
 */
function resolveLocalEpicMetadata(appName, options = {}) {
  const cleanAppName = String(appName || '').replace(/^epic[-_]/i, '').trim();
  const normTargetTitle = String(options.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!cleanAppName && !normTargetTitle) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  // Fast exact path lookup first
  if (cleanAppName && !cleanAppName.includes('..') && !/[\\/]/.test(cleanAppName)) {
    for (const legDir of roots.legendaryDirs) {
      const exactFile = path.join(legDir, 'metadata', `${cleanAppName}.json`);
      if (isExistingFile(exactFile) && isContainedWithinRoot(legDir, exactFile, options.platform)) {
        try {
          const json = JSON.parse(fs.readFileSync(exactFile, 'utf8'));
          const parsed = parseLegendaryMetadataJson(json, cleanAppName);
          if (parsed) return parsed;
        } catch {}
      }
    }
  }

  // Case-insensitive appName or title fallback scan across metadata/*.json
  const lowerApp = cleanAppName.toLowerCase();
  for (const legDir of roots.legendaryDirs) {
    const metaDir = path.join(legDir, 'metadata');
    if (!isExistingDirectory(metaDir)) continue;
    try {
      const files = fs.readdirSync(metaDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const stemLower = f.slice(0, -5).toLowerCase();
        if (lowerApp && stemLower === lowerApp) {
          const fp = path.join(metaDir, f);
          if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
          try {
            const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
            if (parsed) return parsed;
          } catch {}
        }
      }
      if (normTargetTitle) {
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          const fp = path.join(metaDir, f);
          if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
          try {
            const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const candTitle = String(json?.app_title || json?.metadata?.title || '')
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '');
            if (candTitle && candTitle === normTargetTitle) {
              const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
              if (parsed) return parsed;
            }
          } catch {}
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Enumerates all local Legendary `metadata/*.json` base games for offline Epic sync fallback.
 *
 * @param {Record<string, any>} [options]
 */
function listLocalEpicCatalogGames(options = {}) {
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const byAppName = new Map();

  for (const legDir of roots.legendaryDirs) {
    const metaDir = path.join(legDir, 'metadata');
    if (!isExistingDirectory(metaDir)) continue;
    try {
      for (const f of fs.readdirSync(metaDir)) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(metaDir, f);
        if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
        try {
          const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
          const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
          if (!parsed || parsed.isDlc || !parsed.appName || !parsed.title) continue;
          const key = parsed.appName.toLowerCase();
          if (!byAppName.has(key)) {
            byAppName.set(key, parsed);
          }
        } catch {}
      }
    } catch {}
  }

  return Array.from(byAppName.values());
}

/**
 * Resolves local Amazon Games metadata from `GameProductInfo.sqlite` (read-only `DatabaseSync`).
 *
 * @param {string} productId
 * @param {Record<string, any>} [options]
 */
function resolveLocalAmazonMetadata(productId, options = {}) {
  const cleanId = String(productId || '').replace(/^amazon[-_]/i, '').trim();
  if (!cleanId) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  for (const dbPath of roots.amazonDbPaths) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      const targetTable = tables.includes('DbSet')
        ? 'DbSet'
        : tables.includes('Products')
          ? 'Products'
          : null;
      if (!targetTable) continue;

      const row = db.prepare(`SELECT * FROM "${targetTable}" WHERE Id = ? LIMIT 1`).get(cleanId);
      if (!row) continue;

      const title = String(row.ProductTitle || row.Title || '').trim();
      const rawDesc = String(row.ProductDescription || row.Description || '').trim();
      const shortDescription = stripVideoTagsAndHtmlToPlainText(rawDesc).slice(0, 360);
      const devStr = String(row.Developers || row.Developer || '').trim();
      const pubStr = String(row.ProductPublisher || row.Publisher || '').trim();
      const releaseDate = formatUnixSecondsOrIsoDate(row.ReleaseDate) || '';
      const iconUrl =
        typeof row.ProductIconUrl === 'string' && /^https?:\/\//i.test(row.ProductIconUrl)
          ? row.ProductIconUrl
          : undefined;
      const capsuleImage =
        typeof row.BoxArtUrl === 'string' && /^https?:\/\//i.test(row.BoxArtUrl)
          ? row.BoxArtUrl
          : iconUrl;
      const headerImage =
        typeof row.BackgroundUrl === 'string' && /^https?:\/\//i.test(row.BackgroundUrl)
          ? row.BackgroundUrl
          : capsuleImage;

      return {
        appId: 0,
        amazonId: cleanId,
        name: title || undefined,
        title: title || undefined,
        shortDescription,
        detailedDescription: sanitizeOfflineHtmlRemovingVideos(rawDesc) || shortDescription,
        aboutTheGame: sanitizeOfflineHtmlRemovingVideos(rawDesc) || shortDescription,
        headerImage,
        capsuleImage,
        iconUrl,
        developers: devStr ? devStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
        publishers: pubStr ? [pubStr] : [],
        genres: [],
        tags: ['Amazon Games'],
        categories: [],
        screenshots: [],
        movies: [],
        releaseDate,
        platforms: { windows: true, mac: false, linux: false },
        metadataQuality: 'local_federated',
      };
    } catch (err) {
      diagLog.debug('federator.amazonMetadataQuery', err, { dbPath, cleanId });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  return null;
}

/**
 * Resolves local Xbox game metadata from installed `MicrosoftGame.config` files across `<Drive>:\XboxGames`
 * and macOS bottle `drive_c/XboxGames`.
 *
 * @param {string | Record<string, any>} productIdOrPayload
 * @param {Record<string, any>} [options]
 */
function resolveLocalXboxMetadata(productIdOrPayload, options = {}) {
  const payload =
    typeof productIdOrPayload === 'string'
      ? { xboxProductId: productIdOrPayload }
      : productIdOrPayload || {};
  const xboxParams = extractXboxParams(payload);
  const title = payload.title || options.title || '';
  if (!xboxParams.productId && !xboxParams.pfn && !xboxParams.titleId && !title) {
    return null;
  }

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const manifests = scanLocalXboxGameManifests(roots, options);
  const matched = matchXboxManifest(manifests, { ...xboxParams, title });
  if (!matched) return null;

  return {
    appId: 0,
    xboxProductId: matched.productId || xboxParams.productId || undefined,
    identityName: matched.identityName || undefined,
    packageFamilyName:
      matched.packageFamilyName || xboxParams.pfn || matched.identityName || undefined,
    xboxTitleId: matched.titleId || xboxParams.titleId || undefined,
    scid: matched.scid || undefined,
    msaAppId: matched.msaAppId || undefined,
    name: matched.title || undefined,
    title: matched.title || undefined,
    shortDescription: '',
    detailedDescription: '',
    aboutTheGame: '',
    developers: matched.publisher ? [matched.publisher] : [],
    publishers: matched.publisher ? [matched.publisher] : [],
    genres: [],
    tags: ['Xbox'],
    categories: [],
    screenshots: [],
    movies: [],
    releaseDate: '',
    installPath: matched.configDir,
    executablePath: matched.executablePath,
    platforms: { windows: true, mac: false, linux: false },
    metadataQuality: 'local_federated',
  };
}

/**
 * Enumerates all locally installed Xbox games discovered via `MicrosoftGame.config` / `AppxManifest.xml`
 * across Windows `<Drive>:\XboxGames` (`.GamingRoot`) and macOS bottles (`drive_c/XboxGames`),
 * populating BOTH `identityName` AND full `packageFamilyName` (`<IdentityName>_<PublisherId>`).
 *
 * @param {Record<string, any>} [options]
 */
function listLocalXboxInstalledGames(options = {}) {
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  return scanLocalXboxGameManifests(roots, options).map((m) => ({
    xboxProductId: m.productId || undefined,
    identityName: m.identityName || undefined,
    packageFamilyName: m.packageFamilyName || undefined,
    pfn: m.packageFamilyName || undefined,
    scid: m.scid || undefined,
    version: m.identityVersion || undefined,
    xboxTitleId: m.titleId || undefined,
    msaAppId: m.msaAppId || undefined,
    title: m.title,
    publisher: m.publisher || undefined,
    installPath: m.configDir,
    gameFolderPath: m.gameFolderPath,
    executablePath: m.executablePath,
  }));
}

/**
 * Unified local metadata resolver across Steam, GOG Galaxy, Epic/Legendary/Heroic, Xbox, and Amazon Games.
 *
 * @param {Record<string, any>} payload
 * @param {Record<string, any>} [options]
 */
function resolveLocalMetadata(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const mergedOpts = { ...options, _precomputedRoots: roots, title: payload.title };

  const gogId = extractGogIdFromParams(payload);
  if (gogId) {
    const gogMeta = resolveLocalGogMetadata(gogId, mergedOpts);
    if (gogMeta) return gogMeta;
  }

  const epicAppName = extractEpicAppNameFromParams(payload);
  if (epicAppName) {
    const epicMeta = resolveLocalEpicMetadata(epicAppName, mergedOpts);
    if (epicMeta) return epicMeta;
  }

  const xboxParams = extractXboxParams(payload);
  if (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) {
    const xboxMeta = resolveLocalXboxMetadata(payload, mergedOpts);
    if (xboxMeta) return xboxMeta;
  }

  const steamAppId = extractSteamAppIdFromParams(payload);
  if (steamAppId) {
    const steamMeta = resolveLocalSteamMetadata(steamAppId, mergedOpts);
    if (steamMeta) return steamMeta;
  }

  const amazonId =
    payload.amazonId ||
    (typeof payload.gameId === 'string' && /^amazon[-_]/i.test(payload.gameId)
      ? payload.gameId.replace(/^amazon[-_]/i, '')
      : '');
  if (amazonId) {
    const amzMeta = resolveLocalAmazonMetadata(amazonId, mergedOpts);
    if (amzMeta) return amzMeta;
  }

  // Title fallback in Legendary if title was supplied without explicit storefront ID
  if (payload.title && roots.legendaryDirs.length > 0) {
    const epicByTitle = resolveLocalEpicMetadata('', mergedOpts);
    if (epicByTitle) return epicByTitle;
  }

  return null;
}

function clearFederatorCaches() {
  gogWebCacheRowLookup.clear();
  gogGalaxyDbSnapshotLookup.clear();
  gogRootWebCacheDirLookup.clear();
  xboxManifestScanLookup.clear();
  cachedWin32LocalDrives = null;
  cachedWin32LocalDrivesAt = 0;
}

class StorefrontLocalCacheFederator {
  /**
   * @param {Record<string, any>} [defaultOptions]
   */
  constructor(defaultOptions = {}) {
    this.defaultOptions = { ...defaultOptions };
    const platform = this.defaultOptions.platform || process.platform;
    if (
      platform === 'win32' &&
      !this.defaultOptions.homedir &&
      !this.defaultOptions.userDataDir &&
      !process.env.VITEST &&
      process.env.NODE_ENV !== 'test'
    ) {
      discoverWindowsLocalDrivesAsync(this.defaultOptions).catch(() => {});
    }
  }

  discoverRoots(overrides = {}) {
    return discoverStorefrontCacheRoots({ ...this.defaultOptions, ...overrides });
  }

  discoverRootsAsync(overrides = {}) {
    return discoverStorefrontCacheRootsAsync({ ...this.defaultOptions, ...overrides });
  }

  discoverStorefrontCacheRootsAsync(overrides = {}) {
    return discoverStorefrontCacheRootsAsync({ ...this.defaultOptions, ...overrides });
  }

  resolveFederatedAsset(params = {}, overrides = {}) {
    return resolveFederatedAsset(params, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalSteamMetadata(appId, overrides = {}) {
    return resolveLocalSteamMetadata(appId, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalGogMetadata(gogId, overrides = {}) {
    return resolveLocalGogMetadata(gogId, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalEpicMetadata(appName, overrides = {}) {
    return resolveLocalEpicMetadata(appName, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalXboxMetadata(productIdOrPayload, overrides = {}) {
    return resolveLocalXboxMetadata(productIdOrPayload, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalAmazonMetadata(productId, overrides = {}) {
    return resolveLocalAmazonMetadata(productId, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalMetadata(payload = {}, overrides = {}) {
    return resolveLocalMetadata(payload, { ...this.defaultOptions, ...overrides });
  }

  listLocalEpicCatalogGames(overrides = {}) {
    return listLocalEpicCatalogGames({ ...this.defaultOptions, ...overrides });
  }

  listLocalGogCatalogGames(overrides = {}) {
    return listLocalGogCatalogGames({ ...this.defaultOptions, ...overrides });
  }

  listLocalXboxInstalledGames(overrides = {}) {
    return listLocalXboxInstalledGames({ ...this.defaultOptions, ...overrides });
  }

  trimMemory() {
    clearFederatorCaches();
  }
}

function createStorefrontLocalCacheFederator(options = {}) {
  return new StorefrontLocalCacheFederator(options);
}

module.exports = {
  StorefrontLocalCacheFederator,
  createStorefrontLocalCacheFederator,
  detectImageMagicBytes,
  validateFederatedImageFile,
  resolveFederatorUserDataDir,
  discoverWindowsLocalDrivesAsync,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  parseMicrosoftGameConfigXml,
  resolveFederatedAsset,
  resolveXboxFederatedAsset,
  resolveLocalSteamMetadata,
  resolveLocalGogMetadata,
  resolveLocalEpicMetadata,
  resolveLocalXboxMetadata,
  resolveLocalAmazonMetadata,
  resolveLocalMetadata,
  listLocalEpicCatalogGames,
  listLocalGogCatalogGames,
  listLocalXboxInstalledGames,
  clearFederatorCaches,
};
