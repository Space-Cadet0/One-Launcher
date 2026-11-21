// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  getUserDataDir,
  getGameLaunchConfigs,
  resolvePlatformLaunchConfig,
  setBoundedMapEntry,
  registerExternalCacheInvalidator,
  toLocalFsPath,
} = require('../engineStateRegistry.cjs');
const { atomicWriteFileSync } = require('../securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  resolveBottleSteamExe,
} = require('../wineAndCrossOverManager.cjs');
const { parseSteamLibraryFoldersVdf } = require('../binaryAndManifestInspectors.cjs');
const { compareSemver } = require('../../utils/semverUtils.cjs');

/** @type {Array<[string, string, number]>} */
let externalWineEngineDirSpecs = [
  ['Library/Application Support/Sikarugir/Engines', 'Open-Source Wine (Sikarugir)', 340],
];

/** @type {Array<{ managerName: string, tokens: string[] }>} */
let externalWineManagerMatchers = [];

/** @type {Map<string, string>} */
const wineBinaryVersionProbeCache = new Map();

/**
 * Configure additional external Wine manager discovery specs from the allowlisted facade.
 *
 * @param {{ engineDirSpecs?: Array<[string, string, number]>, managerMatchers?: Array<{ managerName: string, tokens: string[] }> }} [specs]
 */
function configureExternalWineManagerSpecs(specs = {}) {
  if (Array.isArray(specs.engineDirSpecs) && specs.engineDirSpecs.length > 0) {
    externalWineEngineDirSpecs = specs.engineDirSpecs;
  }
  if (Array.isArray(specs.managerMatchers)) {
    externalWineManagerMatchers = specs.managerMatchers;
  }
}

function extractBottleRootFromPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const norm = targetPath.replace(/\\/g, '/');
  const bottlesMatch = norm.match(/^(.*?\/Bottles\/[^/]+)(?:\/|$)/i);
  if (bottlesMatch) return bottlesMatch[1];
  const driveCMatch = norm.match(/^(.*?)\/drive_c(?:\/|$)/i);
  if (driveCMatch) return driveCMatch[1];
  return null;
}

function extractRunnerPreviewDate(target, options = undefined) {
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (!trimmed) return null;
    const mIso = trimmed.match(
      /(?:preview\s*|[-_.]|^)(20\d{2})[-._](\d{2})[-._](\d{2})(?=[^0-9]|$)/i
    );
    if (mIso) return `${mIso[1]}${mIso[2]}${mIso[3]}`;
    const m = trimmed.match(/(?:preview\s*|[-_.]|^)(20\d{6})(?=[^0-9]|$)/i);
    return m ? m[1] : null;
  }
  if (target && typeof target === 'object') {
    const obj = /** @type {Record<string, any>} */ (target);
    if (typeof obj.previewDate === 'string') {
      const fromPreviewDate = extractRunnerPreviewDate(obj.previewDate);
      if (fromPreviewDate) return fromPreviewDate;
    }
    if (typeof obj.previewBuildDate === 'string') {
      const fromPreviewBuildDate = extractRunnerPreviewDate(obj.previewBuildDate);
      if (fromPreviewBuildDate) return fromPreviewBuildDate;
    }
    const fromDownload = extractRunnerPreviewDate(obj.downloadUrl || obj.externalDownloadUrl);
    if (fromDownload) return fromDownload;
    const fromArchive = extractRunnerPreviewDate(obj.archivePath || obj.installedArchive);
    if (fromArchive) return fromArchive;
    const fromBuild = extractRunnerPreviewDate(
      obj.buildVersion || obj.latestBuildVersion || obj.rawBundleVersion
    );
    if (fromBuild) return fromBuild;
    const fromDisplay = extractRunnerPreviewDate(
      obj.displayVersion || obj.latestDisplayVersion
    );
    if (fromDisplay) return fromDisplay;
    const fromVer = extractRunnerPreviewDate(obj.version || obj.latestVersion);
    if (fromVer) return fromVer;
    if (typeof obj.appPath === 'string' && obj.appPath) {
      try {
        const plistPath = path.join(obj.appPath, 'Contents/Info.plist');
        if (fs.existsSync(plistPath) && typeof parsePlistStringValues === 'function') {
          const dict = parsePlistStringValues(plistPath);
          const fromShort = extractRunnerPreviewDate(dict.CFBundleShortVersionString);
          if (fromShort) return fromShort;
          const fromBundle = extractRunnerPreviewDate(dict.CFBundleVersion);
          if (fromBundle) return fromBundle;
        }
      } catch {}
    }
  }
  return null;
}

const MAX_LOGINUSERS_VDF_BYTES = 128 * 1024;
const MAX_LIBRARYFOLDERS_VDF_BYTES = 512 * 1024;

/**
 * Read up to `maxBytes` of a UTF-8 text file safely (strictly read-only).
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string | null}
 */
function readBoundedUtf8FileSync(filePath, maxBytes) {
  let fd = null;
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0) return '';
    const readLen = Math.min(st.size, maxBytes);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Inspect `<steamRoot>/config/loginusers.vdf` (bounded <= 128 KiB, read-only) to determine
 * whether a Steam account is signed in / configured for remembered auto-login inside the bottle.
 *
 * @param {string} steamRoot
 * @returns {boolean}
 */
function hasSignedInSteamUserInLoginUsersVdf(steamRoot) {
  if (!steamRoot || typeof steamRoot !== 'string') return false;
  const candidates = [
    path.join(steamRoot, 'config', 'loginusers.vdf'),
    path.join(steamRoot, 'Config', 'loginusers.vdf'),
  ];
  for (const vdfPath of candidates) {
    const text = readBoundedUtf8FileSync(vdfPath, MAX_LOGINUSERS_VDF_BYTES);
    if (!text) continue;
    if (
      /"[^"\r\n]+"[ \t\r\n]*\{[^{}]*"(?:RememberPassword|AllowAutoLogin|AutoLogin)"\s*"1"/i.test(
        text
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a Windows/Wine path from a bottle's `libraryfolders.vdf` into candidate local host
 * filesystem paths (supporting `C:\...` -> `bottlePath/drive_c/...`, arbitrary `dosdevices/<drive>:`
 * symlinks such as `Y:\...` or `D:\...`, `Z:\...` -> host root `/...`, and POSIX paths).
 *
 * @param {string} bottlePath
 * @param {string} driveCRoot
 * @param {string} rawLibPath
 * @returns {string[]}
 */
function resolveWineLibraryPathInBottle(bottlePath, driveCRoot, rawLibPath) {
  if (!rawLibPath || typeof rawLibPath !== 'string') return [];
  const trimmed = rawLibPath.trim();
  if (!trimmed) return [];

  /** @type {string[]} */
  const candidates = [];
  const addCandidate = (/** @type {string | null | undefined} */ p) => {
    if (!p || typeof p !== 'string') return;
    const resolved = path.resolve(p);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  if (trimmed.startsWith('/')) {
    addCandidate(trimmed);
  }

  const normalizedSlashes = trimmed.replace(/\\\\/g, '/').replace(/\\/g, '/');
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalizedSlashes);
  if (driveMatch) {
    const driveLower = driveMatch[1].toLowerCase();
    const relSegments = driveMatch[2]
      .replace(/^\/+/, '')
      .split('/')
      .filter((seg) => seg && seg !== '.');

    // 1. Check `<bottlePath>/dosdevices/<drive>:` symlink or directory first (handles C:, D:, Y:, Z:, etc.)
    const dosdevicesDir =
      resolveDriveCPathCaseInsensitive(bottlePath, ['dosdevices']) ||
      path.join(bottlePath, 'dosdevices');
    const dosDriveEntries = [
      path.join(dosdevicesDir, `${driveLower}:`),
      path.join(dosdevicesDir, `${driveLower.toUpperCase()}:`),
    ];
    for (const dosDrive of dosDriveEntries) {
      try {
        if (fs.existsSync(dosDrive)) {
          const driveTarget = fs.realpathSync(dosDrive);
          addCandidate(
            relSegments.length > 0
              ? resolveDriveCPathCaseInsensitive(driveTarget, relSegments)
              : driveTarget
          );
          addCandidate(path.join(driveTarget, ...relSegments));
          break;
        }
      } catch {}
    }

    // 2. Canonical `C:\...` -> `<bottlePath>/drive_c/...`
    if (driveLower === 'c' && driveCRoot) {
      addCandidate(
        relSegments.length > 0
          ? resolveDriveCPathCaseInsensitive(driveCRoot, relSegments)
          : driveCRoot
      );
      addCandidate(path.join(driveCRoot, ...relSegments));
    }

    // 3. Canonical `Z:\...` -> host root `/...`
    if (driveLower === 'z') {
      addCandidate('/' + relSegments.join('/'));
    }
  }

  // 4. Shared fallback via `toLocalFsPath`
  try {
    const fallbackLocal = toLocalFsPath(trimmed, driveCRoot ? [driveCRoot] : []);
    if (fallbackLocal) {
      addCandidate(fallbackLocal);
    }
  } catch {}

  return candidates;
}

/**
 * Strictly read-only check verifying whether Steam inside `bottlePath` recognizes `appId` as
 * installed via `<bottleSteamRoot>/steamapps/appmanifest_<appId>.acf` OR any library folder
 * already listed in `<bottleSteamRoot>/steamapps/libraryfolders.vdf`.
 *
 * @param {string} bottlePath
 * @param {string | number} appId
 * @returns {boolean}
 */
function hasBottleSteamAppManifest(bottlePath, appId) {
  if (!bottlePath || typeof bottlePath !== 'string' || !bottlePath.trim()) {
    return false;
  }
  const cleanAppId = String(appId ?? '')
    .replace(/^steam[-_]/i, '')
    .trim();
  if (!/^\d+$/.test(cleanAppId)) {
    return false;
  }

  let resolvedBottle = bottlePath.trim();
  try {
    if (!fs.existsSync(resolvedBottle)) return false;
    resolvedBottle = path.resolve(resolvedBottle);
  } catch {
    return false;
  }

  const bottleSteamExe = resolveBottleSteamExe(resolvedBottle);
  if (!bottleSteamExe) {
    return false;
  }

  const bottleSteamRoot = path.dirname(bottleSteamExe);
  const driveCRoot =
    resolveDriveCPathCaseInsensitive(resolvedBottle, ['drive_c']) ||
    path.join(resolvedBottle, 'drive_c');
  const acfFileName = `appmanifest_${cleanAppId}.acf`;

  /** @param {string} candidateDir */
  const hasAcfInLibraryRoot = (candidateDir) => {
    if (!candidateDir) return false;
    const acfCandidates = [
      path.join(candidateDir, 'steamapps', acfFileName),
      path.join(candidateDir, 'SteamApps', acfFileName),
      path.join(candidateDir, acfFileName),
    ];
    for (const acfPath of acfCandidates) {
      try {
        if (fs.existsSync(acfPath) && fs.statSync(acfPath).isFile()) {
          return true;
        }
      } catch {}
    }
    return false;
  };

  // 1. Check primary bottle Steam root (`<bottleSteamRoot>/steamapps/appmanifest_<appId>.acf`)
  if (hasAcfInLibraryRoot(bottleSteamRoot)) {
    return true;
  }

  // 2. Inspect `<bottleSteamRoot>/steamapps/libraryfolders.vdf` (and `config/libraryfolders.vdf`)
  const vdfCandidates = [
    path.join(bottleSteamRoot, 'steamapps', 'libraryfolders.vdf'),
    path.join(bottleSteamRoot, 'SteamApps', 'libraryfolders.vdf'),
    path.join(bottleSteamRoot, 'config', 'libraryfolders.vdf'),
  ];
  const checkedRoots = new Set([path.resolve(bottleSteamRoot).toLowerCase()]);

  for (const vdfPath of vdfCandidates) {
    const vdfContent = readBoundedUtf8FileSync(vdfPath, MAX_LIBRARYFOLDERS_VDF_BYTES);
    if (!vdfContent) continue;
    const libPaths = parseSteamLibraryFoldersVdf(vdfContent);
    for (const lp of libPaths) {
      const resolvedHosts = resolveWineLibraryPathInBottle(resolvedBottle, driveCRoot, lp);
      for (const hostRoot of resolvedHosts) {
        const key = hostRoot.toLowerCase();
        if (checkedRoots.has(key)) continue;
        checkedRoots.add(key);
        if (hasAcfInLibraryRoot(hostRoot)) {
          return true;
        }
      }
    }
  }

  return false;
}

function resolveBottleGogGalaxyExe(winePrefix) {
  if (!winePrefix || typeof winePrefix !== 'string') return null;
  const driveCRoot =
    resolveDriveCPathCaseInsensitive(winePrefix, ['drive_c']) ||
    path.join(winePrefix, 'drive_c');
  const candidateSegmentsList = [
    ['Program Files (x86)', 'GOG Galaxy', 'GalaxyClient.exe'],
    ['Program Files', 'GOG Galaxy', 'GalaxyClient.exe'],
    ['GOG Galaxy', 'GalaxyClient.exe'],
  ];
  for (const segs of candidateSegmentsList) {
    const candidates = [
      path.join(driveCRoot, ...segs),
      resolveDriveCPathCaseInsensitive(driveCRoot, segs),
    ];
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
          return c;
        }
      } catch {}
    }
  }
  return null;
}

function resolveBottleEpicLauncherExe(winePrefix) {
  if (!winePrefix || typeof winePrefix !== 'string') return null;
  const driveCRoot =
    resolveDriveCPathCaseInsensitive(winePrefix, ['drive_c']) ||
    path.join(winePrefix, 'drive_c');
  const candidateSegmentsList = [
    ['Program Files (x86)', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'],
    ['Program Files (x86)', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe'],
    ['Program Files', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'],
    ['Program Files', 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe'],
  ];
  for (const segs of candidateSegmentsList) {
    const candidates = [
      path.join(driveCRoot, ...segs),
      resolveDriveCPathCaseInsensitive(driveCRoot, segs),
    ];
    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
          return c;
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Safely inspect a CrossOver bottle's `cxbottle.conf` without throwing on missing,
 * truncated, binary/NUL-padded, or malformed files.
 *
 * @param {string} bottleDir
 * @returns {{
 *   wineArch?: 'win64' | 'arm64';
 *   previewEnabled?: boolean;
 *   timestamp?: string;
 *   oneLauncherManagedPreview?: boolean;
 * }}
 */
function inspectBottleConfMetadata(bottleDir) {
  if (!bottleDir || typeof bottleDir !== 'string') return {};
  const cxbottleConf = path.join(bottleDir, 'cxbottle.conf');
  try {
    if (!fs.existsSync(cxbottleConf)) return {};
    const rawText = fs.readFileSync(cxbottleConf, 'utf8');
    if (!rawText || typeof rawText !== 'string') return {};
    const sanitizedText = rawText.replace(/^\uFEFF/, '').replace(/\0/g, '');
    const bottleHeaderMatch = /^[ \t]*\[Bottle\](?:[ \t]*(?:[;#].*)?)?$/m.exec(sanitizedText);
    if (!bottleHeaderMatch) return {};
    const afterHeader = sanitizedText.slice(bottleHeaderMatch.index + bottleHeaderMatch[0].length);
    const nextSectionMatch = /^\s*\[[^\]]+\]/m.exec(afterHeader);
    const bottleSection = nextSectionMatch
      ? afterHeader.slice(0, nextSectionMatch.index)
      : afterHeader;

    /** @type {{ wineArch?: 'win64' | 'arm64'; previewEnabled?: boolean; timestamp?: string; oneLauncherManagedPreview?: boolean }} */
    const result = {};
    const archMatch = bottleSection.match(/^\s*"WineArch"\s*=\s*"([^"]+)"/im);
    if (archMatch) {
      const normArch = archMatch[1].trim().toLowerCase();
      if (normArch === 'arm64' || normArch === 'win64') {
        result.wineArch = normArch;
      }
    }
    const previewMatch = bottleSection.match(/^\s*"Preview"\s*=\s*"([^"]+)"/im);
    if (previewMatch) {
      const val = previewMatch[1].trim().toLowerCase();
      result.previewEnabled = val === '1' || val === 'true' || val === 'yes';
    }
    const tsMatch = bottleSection.match(/^\s*"Timestamp"\s*=\s*"([^"]+)"/im);
    if (tsMatch && tsMatch[1].trim()) {
      result.timestamp = tsMatch[1].trim();
    }
    const managedMatch = bottleSection.match(
      /^\s*"OneLauncherManagedPreview"\s*=\s*"([^"]+)"/im
    );
    if (managedMatch) {
      const val = managedMatch[1].trim().toLowerCase();
      result.oneLauncherManagedPreview = val === '1' || val === 'true' || val === 'yes';
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Enforce bidirectional architecture compatibility between a CrossOver runner and an initialized
 * bottle directory without ever mutating `WineArch` in place.
 *
 * @param {string | undefined} layerType
 * @param {string | undefined} bottleName
 * @param {string | undefined} bottlePath
 */
function assertRunnerBottleArchCompatible(layerType, bottleName, bottlePath) {
  if (
    layerType !== 'crossover' &&
    layerType !== 'crossover_preview' &&
    layerType !== 'crossover_preview_arm64'
  ) {
    return;
  }
  if (!bottlePath || typeof bottlePath !== 'string') return;
  const confPath = path.join(bottlePath, 'cxbottle.conf');
  const hasConf = fs.existsSync(confPath);
  const isInitialized = hasConf || isValidBottleDirectory(bottlePath, false);
  if (!isInitialized) return;

  const meta = inspectBottleConfMetadata(bottlePath);
  const label = bottleName || path.basename(bottlePath);
  if ((layerType === 'crossover' || layerType === 'crossover_preview') && meta.wineArch === 'arm64') {
    throw new Error(
      `CrossOver bottle "${label}" has WineArch="arm64" (Experimental FEX) and is incompatible with ${layerType} (Intel/Rosetta). Select crossover_preview_arm64 or use a win64 bottle such as OneLauncher.`
    );
  }
  if (layerType === 'crossover_preview_arm64' && meta.wineArch !== 'arm64') {
    throw new Error(
      `CrossOver bottle "${label}" has WineArch="${meta.wineArch || 'win64'}" and is incompatible with crossover_preview_arm64 (arm64 FEX). Use OneLauncher-arm64 or create a dedicated arm64 bottle instead of converting in place.`
    );
  }
}

function isValidBottleDirectory(bottleDir, isMockHomedir = false) {
  if (!bottleDir || !fs.existsSync(bottleDir)) return false;
  if (isMockHomedir) return true;
  if (
    fs.existsSync(path.join(bottleDir, 'drive_c')) ||
    fs.existsSync(path.join(bottleDir, 'system.reg'))
  ) {
    return true;
  }
  const cxbottleConf = path.join(bottleDir, 'cxbottle.conf');
  if (fs.existsSync(cxbottleConf)) {
    try {
      const confText = fs.readFileSync(cxbottleConf, 'utf8');
      if (/^\[Bottle\]/m.test(confText)) return true;
    } catch {}
  }
  return false;
}

function hasValidInitializedBottles(dirPath, isMockHomedir = false) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  try {
    const entries = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    if (isMockHomedir) return entries.length > 0;
    return entries.some((d) => isValidBottleDirectory(path.join(dirPath, d.name), false));
  } catch {
    return false;
  }
}

function listBottleSubdirectories(bottlesDir, /** @type {any} */ options = {}) {
  if (!bottlesDir || !fs.existsSync(bottlesDir)) return [];
  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
  try {
    return fs
      .readdirSync(bottlesDir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          isValidBottleDirectory(path.join(bottlesDir, d.name), isMockHomedir)
      )
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listAllInitializedBottlePaths(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const seen = new Set();
  /** @type {string[]} */
  const result = [];

  const addIfBottle = (/** @type {any} */ candidateDir) => {
    if (!candidateDir || typeof candidateDir !== 'string') return;
    const resolved = path.resolve(candidateDir);
    if (seen.has(resolved)) return;
    try {
      if (
        fs.existsSync(path.join(resolved, 'drive_c')) ||
        fs.existsSync(path.join(resolved, 'system.reg'))
      ) {
        seen.add(resolved);
        result.push(resolved);
      }
    } catch {}
  };

  if (options.bottlePath) {
    addIfBottle(options.bottlePath);
  }
  if (Array.isArray(options.bottlePaths)) {
    for (const bp of options.bottlePaths) {
      addIfBottle(bp);
    }
  }

  if (platform !== 'darwin') {
    return result;
  }

  const includeThirdPartyPrefixes = options.includeThirdPartyPrefixes !== false;
  const bottleParentRoots = [
    path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview arm64/Bottles'),
    path.join(homedir, 'Library/Containers/com.isaacmarovitz.Whisky/Bottles'),
    path.join(homedir, 'Games/OneLauncher/Prefixes'),
    ...(includeThirdPartyPrefixes ? [path.join(homedir, 'Games/Heroic/Prefixes')] : []),
  ];
  for (const parentRoot of bottleParentRoots) {
    if (!fs.existsSync(parentRoot)) continue;
    try {
      const entries = fs.readdirSync(parentRoot, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          addIfBottle(path.join(parentRoot, ent.name));
        }
      }
    } catch {}
  }
  addIfBottle(path.join(homedir, '.wine'));

  try {
    const layers = detectCompatibilityLayers(options);
    for (const layer of layers) {
      if (!layer || !layer.bottlesDir) continue;
      if (
        !includeThirdPartyPrefixes &&
        /\/Games\/Heroic\/Prefixes(?:\/|$)/i.test(String(layer.bottlesDir).replace(/\\/g, '/'))
      ) {
        continue;
      }
      addIfBottle(layer.bottlesDir);
      if (Array.isArray(layer.availableBottles)) {
        for (const bName of layer.availableBottles) {
          addIfBottle(path.join(layer.bottlesDir, bName));
        }
      }
    }
  } catch {}

  return result;
}

function resolveTargetBottleForFirstPartySync(
  /** @type {any} */ recordOrEntry = {},
  platformId = '',
  /** @type {any} */ options = {}
) {
  if (options.bottlePath && typeof options.bottlePath === 'string') {
    return path.resolve(options.bottlePath);
  }

  const candidateGamePaths = [
    recordOrEntry.installPath,
    recordOrEntry.install_path,
    recordOrEntry.executablePath,
  ].filter(Boolean);
  for (const gp of candidateGamePaths) {
    const insideBottle = extractBottleRootFromPath(String(gp));
    if (insideBottle && fs.existsSync(insideBottle)) {
      return path.resolve(insideBottle);
    }
  }

  const allBottles = listAllInitializedBottlePaths({
    ...options,
    includeThirdPartyPrefixes: false,
  });
  const rawGameId = String(
    recordOrEntry.platformGameId ||
      recordOrEntry.appName ||
      recordOrEntry.app_name ||
      recordOrEntry.gameId ||
      recordOrEntry.id ||
      ''
  )
    .replace(/^(steam|gog|epic)[-_]/i, '')
    .trim();

  if (rawGameId && platformId) {
    try {
      const userDataDir = getUserDataDir(options.userDataDir);
      const launchConfigs = getGameLaunchConfigs({ userDataDir }) || {};
      const rawCfg =
        launchConfigs[`${platformId}-${rawGameId}`] ||
        launchConfigs[`${platformId}_${rawGameId}`] ||
        launchConfigs[rawGameId] ||
        null;
      const resolvedCfg = resolvePlatformLaunchConfig(rawCfg || {}, platformId);
      const bottleName = String(
        recordOrEntry.wineBottleName || resolvedCfg?.wineBottleName || ''
      ).trim();
      if (bottleName) {
        if (path.isAbsolute(bottleName) && fs.existsSync(bottleName)) {
          return path.resolve(bottleName);
        }
        const matched = allBottles.find(
          (b) => path.basename(b).toLowerCase() === bottleName.toLowerCase()
        );
        if (matched) return matched;
      }
    } catch {}
  }

  const sortedBottles = [...allBottles].sort((a, b) => {
    const aIsDefault = path.basename(a).toLowerCase() === 'onelauncher' ? 0 : 1;
    const bIsDefault = path.basename(b).toLowerCase() === 'onelauncher' ? 0 : 1;
    return aIsDefault - bIsDefault;
  });

  for (const bPath of sortedBottles) {
    if (platformId === 'gog' && resolveBottleGogGalaxyExe(bPath)) return bPath;
    if (platformId === 'epic' && resolveBottleEpicLauncherExe(bPath)) return bPath;
    if (platformId === 'steam' && resolveBottleSteamExe(bPath)) return bPath;
  }

  return sortedBottles[0] || null;
}

/**
 * Resolve the path to One Launcher's external compatibility-runner install receipts file
 * (`$HOME/Library/Application Support/OneLauncher/runner-install-receipts.json`).
 * Never touches any file inside an `.app` bundle, keeping `codesign --verify --deep --strict` intact.
 *
 * @param {any} [options]
 * @returns {string}
 */
function getRunnerInstallReceiptsFilePath(options = {}) {
  if (options && typeof options.homedir === 'string' && options.homedir.trim()) {
    return path.join(
      options.homedir.trim(),
      'Library/Application Support/OneLauncher/runner-install-receipts.json'
    );
  }
  if (options && typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    return path.join(options.userDataDir.trim(), 'runner-install-receipts.json');
  }
  try {
    const ud = getUserDataDir();
    if (ud && typeof ud === 'string') {
      return path.join(ud, 'runner-install-receipts.json');
    }
  } catch {}
  return path.join(
    os.homedir(),
    'Library/Application Support/OneLauncher/runner-install-receipts.json'
  );
}

/**
 * Normalize an `.app` bundle path for receipt dictionary keying.
 *
 * @param {string} appPath
 * @returns {string}
 */
function normalizeReceiptAppPath(appPath) {
  return path
    .resolve(String(appPath || '').trim())
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Read `CFBundleShortVersionString` and `CFBundleVersion` from a bundle `Info.plist`
 * (supporting both XML and binary `bplist00` formats).
 *
 * @param {string} plistPath
 * @returns {{ shortVer: string, bundleVer: string }}
 */
function readAppBundlePlistVersionStrings(plistPath) {
  let shortVer = '';
  let bundleVer = '';
  try {
    const plistText = fs.readFileSync(plistPath, 'utf8');
    const shortMatch = plistText.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/i
    );
    const bundleVerMatch = plistText.match(
      /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/i
    );
    shortVer = shortMatch ? shortMatch[1].trim() : '';
    bundleVer = bundleVerMatch ? bundleVerMatch[1].trim() : '';
    if (!shortVer && !bundleVer) {
      const parsedPlist = parsePlistStringValues(plistPath);
      shortVer = String(parsedPlist.CFBundleShortVersionString || '').trim();
      bundleVer = String(parsedPlist.CFBundleVersion || '').trim();
    }
  } catch {}
  return { shortVer, bundleVer };
}

/**
 * Return all candidate paths for One Launcher's external compatibility-runner install receipts,
 * ordered from primary to fallback, so Electron (`~/Library/Application Support/one-launcher`)
 * always reads and merges receipts written to `~/Library/Application Support/OneLauncher`.
 *
 * @param {any} [options]
 * @returns {string[]}
 */
function getRunnerInstallReceiptsCandidatePaths(options = {}) {
  /** @type {string[]} */
  const candidates = [];
  const addUnique = (/** @type {string} */ candidatePath) => {
    if (!candidatePath || typeof candidatePath !== 'string') return;
    const resolved = path.resolve(candidatePath);
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  const hasExplicitHomedir = Boolean(
    options && typeof options.homedir === 'string' && options.homedir.trim()
  );
  const hasExplicitUserDataDir = Boolean(
    options && typeof options.userDataDir === 'string' && options.userDataDir.trim()
  );

  if (hasExplicitHomedir) {
    addUnique(
      path.join(
        options.homedir.trim(),
        'Library/Application Support/OneLauncher/runner-install-receipts.json'
      )
    );
  }
  if (hasExplicitUserDataDir) {
    const explicitUd = path.resolve(options.userDataDir.trim());
    addUnique(path.join(explicitUd, 'runner-install-receipts.json'));
    if (!hasExplicitHomedir) {
      const parentDir = path.dirname(explicitUd);
      if (path.basename(parentDir).toLowerCase() === 'application support') {
        addUnique(path.join(parentDir, 'OneLauncher', 'runner-install-receipts.json'));
      }
    }
  }
  if (!hasExplicitHomedir && !hasExplicitUserDataDir) {
    try {
      const ud = getUserDataDir();
      if (ud && typeof ud === 'string') {
        addUnique(path.join(ud, 'runner-install-receipts.json'));
      }
    } catch {}
    addUnique(
      path.join(
        os.homedir(),
        'Library/Application Support/OneLauncher/runner-install-receipts.json'
      )
    );
  }

  return candidates;
}

/**
 * Read a single runner install receipts JSON file (100% read-only).
 *
 * @param {string} filePath
 * @returns {Record<string, any>}
 */
function readSingleRunnerInstallReceiptsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.receipts && typeof parsed.receipts === 'object' && !Array.isArray(parsed.receipts)) {
        return parsed.receipts;
      }
      if (!Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return {};
}

/**
 * Read and merge all stored runner install receipts across primary (`getUserDataDir()`) and
 * fallback (`~/Library/Application Support/OneLauncher/`) locations (100% read-only).
 *
 * @param {any} [options]
 * @returns {Record<string, any>}
 */
function readRunnerInstallReceipts(options = {}) {
  const candidatePaths = getRunnerInstallReceiptsCandidatePaths(options);
  /** @type {Record<string, any>} */
  const merged = {};
  /** @type {Map<string, string>} */
  const keyByLower = new Map();

  // Read fallback paths first, then higher-priority paths, preferring strictly newer updatedAt timestamps
  for (let i = candidatePaths.length - 1; i >= 0; i -= 1) {
    const receiptsObj = readSingleRunnerInstallReceiptsFile(candidatePaths[i]);
    for (const [rawKey, entry] of Object.entries(receiptsObj)) {
      if (!entry || typeof entry !== 'object') continue;
      const lowerKey = rawKey.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const existingKey = keyByLower.get(lowerKey);
      if (existingKey !== undefined) {
        const existingEntry = merged[existingKey];
        const existingTs = Date.parse(String(existingEntry?.updatedAt || ''));
        const nextTs = Date.parse(String(entry?.updatedAt || ''));
        if (Number.isFinite(existingTs) && Number.isFinite(nextTs) && existingTs > nextTs) {
          continue;
        }
        if (existingKey !== rawKey) {
          delete merged[existingKey];
        }
      }
      keyByLower.set(lowerKey, rawKey);
      merged[rawKey] = entry;
    }
  }
  return merged;
}

/**
 * Record an external runner install receipt in `runner-install-receipts.json` when an upstream
 * packaging tag (e.g. `3.0-3` or `11.0_1`) carries finer revision info than the bundle's `Info.plist`.
 *
 * @param {string} installedPath
 * @param {string} runnerType
 * @param {string | null | undefined} releaseVersion
 * @param {any} [options]
 */
function recordRunnerInstallReceipt(installedPath, runnerType, releaseVersion, options = {}) {
  const trimmedRelease = String(releaseVersion || '').trim();
  if (!installedPath || !trimmedRelease) return;
  try {
    const plistPath = path.join(installedPath, 'Contents', 'Info.plist');
    if (!fs.existsSync(plistPath)) return;
    const plistStat = fs.statSync(plistPath);
    const { shortVer, bundleVer } = readAppBundlePlistVersionStrings(plistPath);
    const filePath = getRunnerInstallReceiptsFilePath(options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existingReceipts = readRunnerInstallReceipts(options);
    const normKey = normalizeReceiptAppPath(installedPath);
    invalidateCompatLayersCache();
    const nextPayload = {
      schemaVersion: 1,
      receipts: {
        ...existingReceipts,
        [normKey]: {
          runnerType: String(runnerType || '').trim(),
          plistShortVersion: shortVer,
          plistBundleVersion: bundleVer,
          plistMtimeMs: Math.round(plistStat.mtimeMs),
          releaseVersion: trimmedRelease,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    atomicWriteFileSync(filePath, JSON.stringify(nextPayload, null, 2));
  } catch {}
}

function extractRunnerVersionInfo(
  /** @type {any} */ runnerTypeOrPath,
  /** @type {any} */ maybeBinaryPath,
  /** @type {any} */ maybeOptions = {}
) {
  const isSinglePathArg =
    typeof maybeBinaryPath !== 'string' &&
    typeof runnerTypeOrPath === 'string' &&
    (runnerTypeOrPath.includes('/') ||
      runnerTypeOrPath.includes('\\') ||
      runnerTypeOrPath.toLowerCase().endsWith('.app'));
  const binaryPath = isSinglePathArg ? runnerTypeOrPath : maybeBinaryPath;
  const options = (isSinglePathArg ? maybeBinaryPath : maybeOptions) || {};

  if (!binaryPath || typeof binaryPath !== 'string') {
    return {
      appPath: undefined,
      version: undefined,
      buildVersion: undefined,
      displayVersion: undefined,
    };
  }

  const appMatch = binaryPath.match(/^(.*?\.app)(?:[\\/]|$)/i);
  const contentsMatch = binaryPath.match(/^(.*?)[\\/]Contents[\\/]/i);
  const appPath = appMatch ? appMatch[1] : contentsMatch ? contentsMatch[1] : undefined;

  let version = undefined;
  let buildVersion = undefined;
  let displayVersion = undefined;
  let previewDate = undefined;

  if (appPath) {
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
      try {
        const plistStat = fs.statSync(plistPath);
        const { shortVer, bundleVer } = readAppBundlePlistVersionStrings(plistPath);
        const plistDate =
          extractRunnerPreviewDate(shortVer) ||
          extractRunnerPreviewDate(bundleVer) ||
          extractRunnerPreviewDate(appPath);
        if (plistDate) {
          previewDate = plistDate;
        }

        const bundleSemverMatch = bundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
        const bundleRevMatch = !bundleSemverMatch
          ? bundleVer.match(/^(\d+\.\d+(?:\.\d+)?)[-_](\d{1,4})(?!\d)/)
          : null;
        const shortRevMatch = shortVer.match(/(\d+\.\d+(?:\.\d+)?)(?:[-_](\d{1,4})(?!\d))?/);
        const rawRevTag = bundleRevMatch
          ? `${bundleRevMatch[1]}${bundleVer.charAt(bundleRevMatch[1].length)}${bundleRevMatch[2]}`
          : shortRevMatch && shortRevMatch[2]
            ? shortRevMatch[0]
            : '';
        const semver = bundleSemverMatch
          ? bundleSemverMatch[1]
          : bundleRevMatch
            ? `${bundleRevMatch[1]}.${bundleRevMatch[2]}`
            : shortRevMatch
              ? shortRevMatch[2]
                ? `${shortRevMatch[1]}.${shortRevMatch[2]}`
                : shortRevMatch[1]
              : '';
        const buildNum = bundleSemverMatch && bundleSemverMatch[2] ? bundleSemverMatch[2] : '';

        if (previewDate && semver) {
          version = semver;
          buildVersion =
            bundleVer && bundleVer !== semver
              ? bundleVer
              : shortVer && shortVer !== semver
                ? shortVer
                : (previewDate || semver);
          displayVersion = `${semver} (Preview ${previewDate})`;
        } else if (previewDate) {
          version = previewDate;
          buildVersion =
            bundleVer && !/preview/i.test(bundleVer) && bundleVer !== previewDate
              ? bundleVer
              : previewDate;
          displayVersion = `Preview ${previewDate}`;
        } else if (semver) {
          version = semver;
          buildVersion =
            bundleVer ||
            (rawRevTag && rawRevTag !== semver
              ? rawRevTag
              : buildNum
                ? `Build ${buildNum}`
                : undefined);
          displayVersion = buildNum
            ? `${semver} (Build ${buildNum})`
            : rawRevTag && rawRevTag !== semver
              ? rawRevTag
              : semver;
        } else if (shortVer || bundleVer) {
          version = shortVer || bundleVer;
          buildVersion = bundleVer && bundleVer !== version ? bundleVer : undefined;
          displayVersion = buildVersion ? `${version} (${buildVersion})` : version;
        }

        const receipts = readRunnerInstallReceipts(options);
        const normKey = normalizeReceiptAppPath(appPath);
        const normKeyLower = normKey.toLowerCase();
        const receipt =
          receipts[normKey] ||
          Object.entries(receipts).find(
            ([k]) => k.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normKeyLower
          )?.[1];
        if (
          receipt &&
          typeof receipt.releaseVersion === 'string' &&
          receipt.releaseVersion.trim() &&
          String(receipt.plistShortVersion || '') === shortVer &&
          String(receipt.plistBundleVersion || '') === bundleVer &&
          typeof receipt.plistMtimeMs === 'number' &&
          Math.abs(plistStat.mtimeMs - receipt.plistMtimeMs) <= 2000
        ) {
          const rawRel = receipt.releaseVersion.trim();
          const normRel = rawRel.replace(/[-_]/g, '.');
          const isEightDigitDateReceipt = /^\d{8}$/.test(rawRel) && Boolean(semver);
          if (!isEightDigitDateReceipt && (!version || compareRunnerVersions(version, normRel) < 0)) {
            version = normRel;
            buildVersion = rawRel !== normRel ? rawRel : buildVersion;
            displayVersion = rawRel;
          }
        }
      } catch {}
    }
  }

  if (!version) {
    const normBin = binaryPath.replace(/\\/g, '/');
    const heroicMatch = normBin.match(/\/tools\/(?:game-porting-toolkit|wine)\/([^/]+)\//i);
    if (heroicMatch) {
      const folderName = heroicMatch[1];
      const verMatch = folderName.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
      if (verMatch) {
        const rawVer = verMatch[1];
        version = rawVer.replace(/[-_]/g, '.');
        buildVersion = rawVer !== version ? rawVer : undefined;
        displayVersion = rawVer;
      }
    }
  }

  if (!version) {
    let normBin = binaryPath.replace(/\\/g, '/');
    try {
      if (fs.existsSync(binaryPath)) {
        normBin = fs.realpathSync(binaryPath).replace(/\\/g, '/');
      }
    } catch {}
    const brewMatch = normBin.match(/\/(?:Cellar|Caskroom)\/[^/]+\/([^/]+)\//i);
    if (brewMatch) {
      const rawBrewVer = brewMatch[1];
      version = rawBrewVer.replace(/[-_]/g, '.');
      buildVersion = rawBrewVer !== version ? rawBrewVer : undefined;
      displayVersion = rawBrewVer;
    } else if (
      options.allowVersionSubprocess === true &&
      !options.homedir &&
      !options.customApplicationsDir &&
      /\/wine(?:64)?$/i.test(normBin) &&
      fs.existsSync(binaryPath)
    ) {
      try {
        const binStat = fs.statSync(binaryPath);
        const cacheKey = `${normBin}|${Math.round(binStat.mtimeMs)}|${binStat.size}`;
        const cachedVer = wineBinaryVersionProbeCache.get(cacheKey);
        const out =
          cachedVer !== undefined
            ? cachedVer
            : execFileSync(binaryPath, ['--version'], {
                timeout: 1000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
              });
        if (cachedVer === undefined) {
          setBoundedMapEntry(wineBinaryVersionProbeCache, cacheKey, String(out || ''), 64);
        }
        const wineVerMatch = String(out || '').match(/wine-([\d.]+(?:[-_][\w.]+)?)/i);
        if (wineVerMatch) {
          const rawVer = wineVerMatch[1];
          version = rawVer.split(/[-_]/)[0];
          buildVersion = rawVer !== version ? rawVer : undefined;
          displayVersion = rawVer;
        }
      } catch {}
    }
  }

  if (!previewDate) {
    const fromDisp = displayVersion?.match(/(?:preview\s*|[-_.]|^)(20\d{6})/i);
    if (fromDisp) previewDate = fromDisp[1];
    else if (buildVersion && /^\d{8}$/.test(buildVersion)) previewDate = buildVersion;
    else if (version && /^\d{8}$/.test(version)) previewDate = version;
  }
  if (previewDate && displayVersion && !/preview/i.test(displayVersion)) {
    displayVersion = `${displayVersion} (Preview ${previewDate})`;
  } else if (previewDate && !displayVersion) {
    displayVersion = version ? `${version} (Preview ${previewDate})` : `Preview ${previewDate}`;
  }
  if (!version && previewDate) {
    version = previewDate;
  }

  return {
    appPath,
    version,
    buildVersion,
    displayVersion,
    ...(previewDate ? { previewDate, previewBuildDate: previewDate } : {}),
  };
}

function parsePlistStringValues(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 40 && buf.slice(0, 6).toString('ascii') === 'bplist') {
      const trailer = buf.slice(buf.length - 32);
      const offsetIntSize = trailer[6];
      const objectRefSize = trailer[7];
      const numObjects = Number(trailer.readBigUInt64BE(8));
      const topObject = Number(trailer.readBigUInt64BE(16));
      const offsetTableOffset = Number(trailer.readBigUInt64BE(24));

      if (
        offsetIntSize < 1 ||
        offsetIntSize > 8 ||
        objectRefSize < 1 ||
        objectRefSize > 8 ||
        numObjects <= 0 ||
        numObjects > 10000 ||
        offsetTableOffset < 8 ||
        offsetTableOffset + numObjects * offsetIntSize > buf.length - 32
      ) {
        return {};
      }

      const readUInt = (/** @type {number} */ offset, /** @type {number} */ byteLen) => {
        let val = 0;
        for (let i = 0; i < byteLen; i++) {
          val = val * 256 + buf[offset + i];
        }
        return val;
      };

      const offsets = [];
      for (let i = 0; i < numObjects; i++) {
        offsets.push(readUInt(offsetTableOffset + i * offsetIntSize, offsetIntSize));
      }

      const readLength = (/** @type {number} */ pos, /** @type {number} */ lowNibble) => {
        if (lowNibble !== 0x0f) return { len: lowNibble, nextPos: pos };
        const intMarker = buf[pos];
        const intBytes = 1 << (intMarker & 0x0f);
        return { len: readUInt(pos + 1, intBytes), nextPos: pos + 1 + intBytes };
      };

      /** @returns {any} */
      const readObject = (/** @type {number} */ objIdx, depth = 0) => {
        if (depth > 6) return null;
        const pos = offsets[objIdx];
        if (pos === undefined || pos >= buf.length) return null;
        const marker = buf[pos];
        const type = marker >> 4;
        const info = marker & 0x0f;
        if (type === 0x5) {
          const { len, nextPos } = readLength(pos + 1, info);
          return buf.slice(nextPos, nextPos + len).toString('utf8');
        }
        if (type === 0x6) {
          const { len, nextPos } = readLength(pos + 1, info);
          const chars = [];
          for (let i = 0; i < len; i++) {
            chars.push(buf.readUInt16BE(nextPos + i * 2));
          }
          return String.fromCharCode(...chars);
        }
        if (type === 0xd) {
          const { len, nextPos } = readLength(pos + 1, info);
          /** @type {Record<string, string>} */
          const out = {};
          for (let i = 0; i < len; i++) {
            const kRef = readUInt(nextPos + i * objectRefSize, objectRefSize);
            const vRef = readUInt(nextPos + (len + i) * objectRefSize, objectRefSize);
            const k = readObject(kRef, depth + 1);
            const v = readObject(vRef, depth + 1);
            if (typeof k === 'string' && typeof v === 'string') {
              out[k] = v;
            }
          }
          return out;
        }
        return null;
      };

      const parsed = readObject(topObject, 0);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }

    const text = buf.toString('utf8');
    /** @type {Record<string, string>} */
    const out = {};
    const re = /<key>\s*([^<]+?)\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      out[m[1].trim()] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Inspect internal bundle markers of a CrossOver `.app` bundle to distinguish
 * Standard vs. Arm64 (Experimental FEX) Preview branches even when `Info.plist` is identical.
 *
 * @param {string} appPath
 * @returns {{
 *   isArm64Bundle: boolean;
 *   hasAarch64Ntdll: boolean;
 *   hasWineserverArm64: boolean;
 *   hasArm64WineLoader: boolean;
 *   buildTimestamp?: string;
 *   buildTag?: string;
 * }}
 */
function inspectCrossOverBundleMarkers(appPath) {
  if (!appPath || typeof appPath !== 'string') {
    return {
      isArm64Bundle: false,
      hasAarch64Ntdll: false,
      hasWineserverArm64: false,
      hasArm64WineLoader: false,
    };
  }
  const cxRoot = path.join(appPath, 'Contents', 'SharedSupport', 'CrossOver');
  let hasAarch64Ntdll = false;
  let hasWineserverArm64 = false;
  let hasArm64WineLoader = false;
  try {
    hasAarch64Ntdll = fs.existsSync(
      path.join(cxRoot, 'lib', 'wine', 'aarch64-unix', 'ntdll.so')
    );
    hasWineserverArm64 = fs.existsSync(path.join(cxRoot, 'bin', 'wineserver-arm64'));
    hasArm64WineLoader =
      fs.existsSync(path.join(cxRoot, 'lib', 'wine', 'aarch64-unix', 'wine')) ||
      fs.existsSync(
        path.join(cxRoot, 'lib', 'wine', 'aarch64-unix', 'wine.app', 'Contents', 'MacOS', 'wine')
      );
  } catch {}

  /** @type {string | undefined} */
  let buildTimestamp;
  /** @type {string | undefined} */
  let buildTag;
  try {
    const cxConfPath = path.join(cxRoot, 'etc', 'CrossOver.conf');
    if (fs.existsSync(cxConfPath)) {
      const confText = fs.readFileSync(cxConfPath, 'utf8');
      const tsMatch = confText.match(/^\s*"BuildTimestamp"\s*=\s*"([^"]+)"/im);
      if (tsMatch && tsMatch[1].trim()) {
        buildTimestamp = tsMatch[1].trim();
      }
      const tagMatch = confText.match(/^\s*"BuildTag"\s*=\s*"([^"]+)"/im);
      if (tagMatch && tagMatch[1].trim()) {
        buildTag = tagMatch[1].trim();
      }
    }
  } catch {}

  return {
    isArm64Bundle: hasAarch64Ntdll || hasWineserverArm64 || hasArm64WineLoader,
    hasAarch64Ntdll,
    hasWineserverArm64,
    hasArm64WineLoader,
    ...(buildTimestamp ? { buildTimestamp } : {}),
    ...(buildTag ? { buildTag } : {}),
  };
}

function detectBundledD3DMetalVersions(runnerType, binaryPath, appPath) {
  let resolvedAppPath = appPath;
  if (!resolvedAppPath && binaryPath && typeof binaryPath === 'string') {
    const appMatch = binaryPath.match(/^(.*?\.app)(?:[\\/]|$)/i);
    const contentsMatch = binaryPath.match(/^(.*?)[\\/]Contents[\\/]/i);
    resolvedAppPath = appMatch ? appMatch[1] : contentsMatch ? contentsMatch[1] : undefined;
  }

  const readFrameworkVersion = (/** @type {string[]} */ fwDirs) => {
    for (const fwDir of fwDirs) {
      if (!fwDir) continue;
      const plistCandidates = [
        path.join(fwDir, 'Resources/Info.plist'),
        path.join(fwDir, 'Versions/Current/Resources/Info.plist'),
        path.join(fwDir, 'Info.plist'),
      ];
      for (const plistPath of plistCandidates) {
        if (!fs.existsSync(plistPath)) continue;
        const dict = parsePlistStringValues(plistPath);
        const ver = String(dict.CFBundleShortVersionString || dict.CFBundleVersion || '').trim();
        if (ver) return ver;
      }
    }
    return undefined;
  };

  if (
    runnerType === 'crossover' ||
    runnerType === 'crossover_preview' ||
    runnerType === 'crossover_preview_arm64'
  ) {
    if (!resolvedAppPath) {
      return { d3dmetalVersion: undefined, availableD3DMetalVersions: undefined };
    }
    const primaryDirs = [
      path.join(
        resolvedAppPath,
        'Contents/SharedSupport/CrossOver/lib/apple_gptk/external/D3DMetal.framework'
      ),
      path.join(
        resolvedAppPath,
        'Contents/SharedSupport/CrossOver/lib64/apple_gptk/external/D3DMetal.framework'
      ),
    ];
    const secondaryDirs = [
      path.join(
        resolvedAppPath,
        'Contents/SharedSupport/CrossOver/lib/apple_gptk3/external/D3DMetal.framework'
      ),
      path.join(
        resolvedAppPath,
        'Contents/SharedSupport/CrossOver/lib64/apple_gptk3/external/D3DMetal.framework'
      ),
    ];

    const primaryVer = readFrameworkVersion(primaryDirs);
    const secondaryVer = readFrameworkVersion(secondaryDirs);

    if (primaryVer && secondaryVer) {
      const primaryMajorId = String(primaryVer).split('.')[0] || '4';
      return {
        d3dmetalVersion: primaryVer,
        availableD3DMetalVersions: [
          {
            id: primaryMajorId,
            version: primaryVer,
            label: `D3DMetal ${primaryVer} (Default)`,
            isDefault: true,
          },
          {
            id: '3',
            version: secondaryVer,
            label: `D3DMetal ${secondaryVer} (Fallback)`,
            isDefault: false,
          },
        ],
      };
    }

    if (primaryVer || secondaryVer) {
      const singleVer = primaryVer || secondaryVer;
      return {
        d3dmetalVersion: singleVer,
        availableD3DMetalVersions: [
          {
            id: 'default',
            version: singleVer,
            label: `D3DMetal ${singleVer}`,
            isDefault: true,
          },
        ],
      };
    }
  } else if (runnerType === 'gptk') {
    const gptkDirs = [];
    if (resolvedAppPath) {
      gptkDirs.push(
        path.join(resolvedAppPath, 'Contents/Resources/wine/lib/external/D3DMetal.framework'),
        path.join(resolvedAppPath, 'Contents/Resources/wine/lib64/external/D3DMetal.framework')
      );
    }
    if (binaryPath && typeof binaryPath === 'string') {
      const binDir = path.dirname(binaryPath);
      gptkDirs.push(
        path.resolve(binDir, '../lib/external/D3DMetal.framework'),
        path.resolve(binDir, '../lib64/external/D3DMetal.framework')
      );
    }
    const gptkVer = readFrameworkVersion(gptkDirs);
    if (gptkVer) {
      return {
        d3dmetalVersion: gptkVer,
        availableD3DMetalVersions: [
          {
            id: 'default',
            version: gptkVer,
            label: `D3DMetal ${gptkVer}`,
            isDefault: true,
          },
        ],
      };
    }
  }

  return { d3dmetalVersion: undefined, availableD3DMetalVersions: undefined };
}

function normalizeRunnerVersionForSemver(raw) {
  let str = String(raw || '').trim();
  // Strip runner folder prefixes (e.g., "Wine-CrossOver-23.7.1-2" -> "23.7.1.2")
  str = str.replace(/^(?:build\s+|v(?=\d))/i, '').trim();
  const leadingPrefix = str.match(/^[A-Za-z][A-Za-z0-9_-]*?[-_](\d.*)$/);
  if (leadingPrefix) {
    str = leadingPrefix[1];
  }
  // Convert "(Build 39120)" or "Build 39120" into a numeric revision ".39120"
  str = str.replace(/\s*\(?build\s+(\d+)\)?/gi, '.$1');
  // Convert post-release packaging revisions like "23.7.1-2" or "3.0_3" (pure trailing digits) into ".2" / ".3"
  str = str.replace(/^(\d+(?:\.\d+)+)[-_](\d+)$/, '$1.$2');
  return str;
}

/**
 * SemVer 2.0 pre-release & build-aware runner version comparison (`26.0-preview < 26.0`).
 */
function compareRunnerVersions(vA, vB) {
  return compareSemver(
    normalizeRunnerVersionForSemver(vA),
    normalizeRunnerVersionForSemver(vB)
  );
}

const COMPAT_LAYERS_CACHE_TTL_MS = 60_000;
/** @type {Map<string, { timestamp: number, layers: any[] }>} */
const compatLayersCache = new Map();

function invalidateCompatLayersCache() {
  compatLayersCache.clear();
}

registerExternalCacheInvalidator(invalidateCompatLayersCache);

function cloneCompatLayersList(/** @type {any[]} */ layers) {
  return layers.map((layer) => {
    if (!layer || typeof layer !== 'object') return layer;
    return {
      ...layer,
      ...(Array.isArray(layer.availableBottles)
        ? { availableBottles: [...layer.availableBottles] }
        : {}),
      ...(layer.bottleDetails && typeof layer.bottleDetails === 'object'
        ? {
            bottleDetails: Object.fromEntries(
              Object.entries(layer.bottleDetails).map(([k, v]) => [
                k,
                v && typeof v === 'object' ? { ...v } : v,
              ])
            ),
          }
        : {}),
    };
  });
}

function detectCompatibilityLayers(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return [];
  }

  const homedir = options.homedir || os.homedir();
  const isIsolatedTest = Boolean(
    options.homedir || options.customApplicationsDir || Array.isArray(options.applicationsDirs)
  );
  const appsDirs = [];
  if (Array.isArray(options.applicationsDirs)) {
    for (const dir of options.applicationsDirs) {
      if (typeof dir === 'string' && dir.trim()) {
        appsDirs.push(dir.trim());
      }
    }
  } else if (options.customApplicationsDir) {
    appsDirs.push(options.customApplicationsDir);
  } else {
    appsDirs.push(path.join(homedir, 'Applications'));
    if (!isIsolatedTest) {
      appsDirs.push('/Applications');
    }
  }

  const hostArch = String(options?.arch || process.arch || 'arm64');
  const darwinKernelMajor =
    options?.darwinKernelMajor !== undefined
      ? Number(options.darwinKernelMajor)
      : process.platform === 'darwin'
        ? Number(String(os.release() || '25.0.0').split('.')[0]) || 25
        : 25;

  const sharedCrossOverBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver/Bottles'
  );
  const previewSpecBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview/Bottles'
  );
  const previewArm64SpecBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview arm64/Bottles'
  );

  const statDirStamp = (/** @type {string} */ dirPath) => {
    try {
      const st = fs.statSync(dirPath);
      return `${st.ino}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      return '0';
    }
  };

  const bypassCache =
    options.forceRefresh === true ||
    options.forceFresh === true ||
    options.bypassCache === true ||
    typeof options.execFileSyncFn === 'function' ||
    typeof options.execFileFn === 'function';
  const compatCacheKey = [
    platform,
    hostArch,
    String(darwinKernelMajor),
    path.resolve(homedir),
    appsDirs.map((d) => `${path.resolve(d)}#${statDirStamp(d)}`).join(','),
    statDirStamp(sharedCrossOverBottlesDir),
    statDirStamp(previewSpecBottlesDir),
    statDirStamp(previewArm64SpecBottlesDir),
    String(Boolean(options.preferLegacy32BitOpenGlWine)),
    options.userDataDir ? path.resolve(options.userDataDir) : '',
  ].join('|');

  if (!bypassCache) {
    const cached = compatLayersCache.get(compatCacheKey);
    if (cached && Date.now() - cached.timestamp < COMPAT_LAYERS_CACHE_TTL_MS) {
      return cloneCompatLayersList(cached.layers);
    }
  }

  const effectivePreviewBottlesDir = hasValidInitializedBottles(previewSpecBottlesDir, false)
    ? previewSpecBottlesDir
    : hasValidInitializedBottles(sharedCrossOverBottlesDir, false)
      ? sharedCrossOverBottlesDir
      : isIsolatedTest && hasValidInitializedBottles(previewSpecBottlesDir, true)
        ? previewSpecBottlesDir
        : !isIsolatedTest && fs.existsSync(sharedCrossOverBottlesDir)
          ? sharedCrossOverBottlesDir
          : previewSpecBottlesDir;

  const effectivePreviewArm64BottlesDir = hasValidInitializedBottles(
    previewArm64SpecBottlesDir,
    false
  )
    ? previewArm64SpecBottlesDir
    : effectivePreviewBottlesDir;

  const layerHostDlssCaps = {
    hostArch,
    darwinKernelMajor,
    supportsMetalFxDlssD3dMetal: hostArch === 'arm64' && darwinKernelMajor >= 25,
    supportsMetalFxDlssDxmt: hostArch === 'arm64' && darwinKernelMajor >= 23,
  };

  /** @type {any[]} */
  const layers = [];
  const addedTypes = new Set();

  /**
   * Compare two discovered `.app` candidates so a stale `$HOME/Applications` copy never shadows
   * a newer `/Applications` copy (or vice versa).
   *
   * @param {any} existingCand
   * @param {any} nextCand
   * @returns {boolean} true if `nextCand` has a strictly higher version/build than `existingCand`
   */
  const isCandidateNewerVersion = (existingCand, nextCand) => {
    if (!existingCand) return true;
    const verA = existingCand.buildVersion || existingCand.version || '';
    const verB = nextCand.buildVersion || nextCand.version || '';
    if (verA && verB) {
      const cmp = compareRunnerVersions(verA, verB);
      if (cmp !== 0) return cmp < 0;
    } else if (!verA && verB) {
      return true;
    }
    if (existingCand.version && nextCand.version) {
      const shortCmp = compareRunnerVersions(existingCand.version, nextCand.version);
      if (shortCmp !== 0) return shortCmp < 0;
    }
    return false;
  };

  /**
   * Source rank helper so `/Applications` wins version ties over `$HOME/Applications`, external
   * external community Wine managers, and CLI wrappers.
   *
   * @param {string} dirPath
   * @returns {number}
   */
  const getAppsDirRank = (dirPath) =>
    path.resolve(String(dirPath || '')).replace(/\\/g, '/') === '/Applications' ? 3 : 2;

  /**
   * Compare two `{ layer, sourceRank }` entries: strictly higher version wins first;
   * equal/missing versions break ties by `sourceRank`.
   *
   * @param {{ layer: any, sourceRank: number, isCanonicalName?: boolean } | null} best
   * @param {{ layer: any, sourceRank: number, isCanonicalName?: boolean }} next
   * @returns {boolean}
   */
  const isBetterRankedLayerCandidate = (best, next) => {
    if (!best) return true;
    if (isCandidateNewerVersion(best.layer, next.layer)) return true;
    if (isCandidateNewerVersion(next.layer, best.layer)) return false;
    if (next.sourceRank !== best.sourceRank) return next.sourceRank > best.sourceRank;
    return Boolean(next.isCanonicalName && !best.isCanonicalName);
  };

  const canonicalCrossOverNames = new Set([
    'CrossOver.app',
    'CrossOver Preview.app',
    'CrossOver Preview arm64.app',
  ]);
  /** @type {Map<string, { layer: any, sourceRank: number, isCanonicalName?: boolean }>} */
  const bestByCrossOverType = new Map();

  for (const appsDir of appsDirs) {
    /** @type {string[]} */
    const appNamesToProbe = [
      'CrossOver.app',
      'CrossOver Preview.app',
      'CrossOver Preview arm64.app',
    ];
    try {
      if (fs.existsSync(appsDir)) {
        const dirEntries = fs.readdirSync(appsDir, { withFileTypes: true });
        for (const ent of dirEntries) {
          if (
            ent.isDirectory() &&
            !ent.name.startsWith('.') &&
            /^CrossOver.*\.app$/i.test(ent.name) &&
            !/\.(?:ol-backup|ol-staging)/i.test(ent.name) &&
            !/uninstall/i.test(ent.name) &&
            !appNamesToProbe.includes(ent.name)
          ) {
            appNamesToProbe.push(ent.name);
          }
        }
      }
    } catch {}

    for (const appName of appNamesToProbe) {
      try {
        const appPath = path.join(appsDir, appName);
        if (!fs.existsSync(appPath)) continue;

        const candidateBins = [
          path.join(appPath, 'Contents/SharedSupport/CrossOver/bin/wine'),
          path.join(appPath, 'Contents/SharedSupport/CrossOver/CrossOver-Hosted Application/wine'),
          path.join(appPath, 'Contents/SharedSupport/CrossOver/lib/apple_gptk/wine'),
          path.join(appPath, 'Contents/SharedSupport/CrossOver/lib/apple_gptk3/wine'),
          path.join(appPath, 'Contents/SharedSupport/CrossOver/lib64/apple_gptk/wine'),
          path.join(appPath, 'Contents/SharedSupport/CrossOver/lib64/apple_gptk3/wine'),
        ];
        const existingBin = candidateBins.find((b) => fs.existsSync(b));
        const isCanonicalName = canonicalCrossOverNames.has(appName);
        if (!isCanonicalName && !existingBin) continue;
        const binaryPath = existingBin || candidateBins[0];

        const markers = inspectCrossOverBundleMarkers(appPath);
        const isPreviewBundle =
          /preview/i.test(appName) ||
          /cxpreview/i.test(markers.buildTag || '') ||
          markers.isArm64Bundle;

        /** @type {'crossover' | 'crossover_preview' | 'crossover_preview_arm64'} */
        const resolvedType = isPreviewBundle
          ? markers.isArm64Bundle
            ? 'crossover_preview_arm64'
            : 'crossover_preview'
          : 'crossover';

        const variantBottlesDir =
          resolvedType === 'crossover'
            ? sharedCrossOverBottlesDir
            : resolvedType === 'crossover_preview_arm64'
              ? effectivePreviewArm64BottlesDir
              : effectivePreviewBottlesDir;

        const availableBottles = listBottleSubdirectories(variantBottlesDir, options);
        /**
         * @type {Record<string, {
         *   wineArch?: 'win64' | 'arm64';
         *   previewEnabled?: boolean;
         *   timestamp?: string;
         *   hasSteam?: boolean;
         *   steamSignedIn?: boolean;
         *   hasGogGalaxy?: boolean;
         *   hasEpicLauncher?: boolean;
         * }>}
         */
        const bottleDetails = {};
        for (const bName of availableBottles) {
          const bPath = path.join(variantBottlesDir, bName);
          const meta = inspectBottleConfMetadata(bPath);
          const bottleSteamExe = resolveBottleSteamExe(bPath);
          const hasSteam = Boolean(bottleSteamExe);
          const steamSignedIn =
            hasSteam && bottleSteamExe
              ? hasSignedInSteamUserInLoginUsersVdf(path.dirname(bottleSteamExe))
              : false;
          const hasGogGalaxy = Boolean(resolveBottleGogGalaxyExe(bPath));
          const hasEpicLauncher = Boolean(resolveBottleEpicLauncherExe(bPath));
          bottleDetails[bName] = {
            ...(meta.wineArch ? { wineArch: meta.wineArch } : {}),
            ...(meta.previewEnabled !== undefined ? { previewEnabled: meta.previewEnabled } : {}),
            ...(meta.timestamp ? { timestamp: meta.timestamp } : {}),
            hasSteam,
            steamSignedIn,
            hasGogGalaxy,
            hasEpicLauncher,
          };
        }

        const versionInfo = extractRunnerVersionInfo(resolvedType, binaryPath, options);
        const d3dmInfo = detectBundledD3DMetalVersions(
          resolvedType,
          binaryPath,
          versionInfo.appPath || appPath
        );

        const variantName =
          resolvedType === 'crossover_preview_arm64'
            ? 'CrossOver Preview (arm64 / FEX)'
            : resolvedType === 'crossover_preview'
              ? 'CrossOver Preview'
              : 'CrossOver';

        const candidateEntry = {
          sourceRank: getAppsDirRank(appsDir),
          isCanonicalName,
          layer: {
            id: resolvedType,
            type: resolvedType,
            name: variantName,
            available: resolvedType === 'crossover_preview_arm64' ? hostArch === 'arm64' : true,
            binaryPath,
            appPath: versionInfo.appPath || appPath,
            version: versionInfo.version,
            buildVersion: versionInfo.buildVersion,
            displayVersion: versionInfo.displayVersion,
            ...(resolvedType === 'crossover_preview'
              ? { previewBranch: 'standard' }
              : resolvedType === 'crossover_preview_arm64'
                ? { previewBranch: 'arm64' }
                : {}),
            supportedBottleArches:
              resolvedType === 'crossover_preview_arm64' ? ['arm64'] : ['win64'],
            ...(markers.buildTimestamp ? { buildTimestamp: markers.buildTimestamp } : {}),
            ...(versionInfo.previewDate
              ? {
                  previewDate: versionInfo.previewDate,
                  previewBuildDate: versionInfo.previewBuildDate,
                }
              : {}),
            ...(d3dmInfo.d3dmetalVersion ? { d3dmetalVersion: d3dmInfo.d3dmetalVersion } : {}),
            ...(d3dmInfo.availableD3DMetalVersions
              ? { availableD3DMetalVersions: d3dmInfo.availableD3DMetalVersions }
              : {}),
            ...layerHostDlssCaps,
            bottlesDir: variantBottlesDir,
            availableBottles,
            bottleDetails,
          },
        };

        const currentBest = bestByCrossOverType.get(resolvedType) || null;
        if (isBetterRankedLayerCandidate(currentBest, candidateEntry)) {
          bestByCrossOverType.set(resolvedType, candidateEntry);
        }
      } catch {
        // Isolate transient filesystem/plist read errors per app bundle
      }
    }
  }

  for (const orderedType of ['crossover', 'crossover_preview', 'crossover_preview_arm64']) {
    const bestEntry = bestByCrossOverType.get(orderedType);
    if (bestEntry && !addedTypes.has(orderedType)) {
      addedTypes.add(orderedType);
      layers.push(bestEntry.layer);
    }
  }

  /** @type {{ layer: any, sourceRank: number } | null} */
  let bestGptkEntry = null;

  for (const appsDir of appsDirs) {
    try {
      const gptkApp = path.join(appsDir, 'Game Porting Toolkit.app');
      if (!fs.existsSync(gptkApp)) continue;
      const binCandidates = [
        path.join(gptkApp, 'Contents/Resources/wine/bin/wine64'),
        path.join(gptkApp, 'Contents/SharedSupport/wine/bin/wine64'),
      ];
      const binaryPath = binCandidates.find((b) => fs.existsSync(b)) || binCandidates[0];
      const versionInfo = extractRunnerVersionInfo('gptk', binaryPath, options);
      const d3dmInfo = detectBundledD3DMetalVersions(
        'gptk',
        binaryPath,
        versionInfo.appPath || gptkApp
      );
      const candidateEntry = {
        sourceRank: getAppsDirRank(appsDir),
        layer: {
          id: 'gptk',
          type: 'gptk',
          name: 'Apple Game Porting Toolkit',
          binaryPath,
          appPath: versionInfo.appPath || gptkApp,
          version: versionInfo.version,
          buildVersion: versionInfo.buildVersion,
          displayVersion: versionInfo.displayVersion,
          ...(d3dmInfo.d3dmetalVersion ? { d3dmetalVersion: d3dmInfo.d3dmetalVersion } : {}),
          ...(d3dmInfo.availableD3DMetalVersions
            ? { availableD3DMetalVersions: d3dmInfo.availableD3DMetalVersions }
            : {}),
          ...layerHostDlssCaps,
          availableBottles: [],
        },
      };
      if (isBetterRankedLayerCandidate(bestGptkEntry, candidateEntry)) {
        bestGptkEntry = candidateEntry;
      }
    } catch {}
  }

  const heroicGptkRoot = path.join(
    homedir,
    'Library/Application Support/heroic/tools/game-porting-toolkit'
  );
  if (fs.existsSync(heroicGptkRoot)) {
    try {
      const subdirs = fs
        .readdirSync(heroicGptkRoot)
        .filter((sub) => !sub.startsWith('.'));
      for (const sub of subdirs) {
        const binCandidates = [
          path.join(heroicGptkRoot, sub, 'bin/wine64'),
          path.join(heroicGptkRoot, sub, 'Contents/Resources/wine/bin/wine64'),
        ];
        const foundBin = binCandidates.find((b) => fs.existsSync(b));
        if (foundBin) {
          const versionInfo = extractRunnerVersionInfo('gptk', foundBin, options);
          const d3dmInfo = detectBundledD3DMetalVersions(
            'gptk',
            foundBin,
            versionInfo.appPath || path.join(heroicGptkRoot, sub)
          );
          const candidateEntry = {
            sourceRank: 1,
            layer: {
              id: 'gptk',
              type: 'gptk',
              name: `Game Porting Toolkit (${sub})`,
              binaryPath: foundBin,
              appPath: versionInfo.appPath,
              version: versionInfo.version,
              buildVersion: versionInfo.buildVersion,
              displayVersion: versionInfo.displayVersion,
              ...(d3dmInfo.d3dmetalVersion ? { d3dmetalVersion: d3dmInfo.d3dmetalVersion } : {}),
              ...(d3dmInfo.availableD3DMetalVersions
                ? { availableD3DMetalVersions: d3dmInfo.availableD3DMetalVersions }
                : {}),
              ...layerHostDlssCaps,
              availableBottles: [],
            },
          };
          if (isBetterRankedLayerCandidate(bestGptkEntry, candidateEntry)) {
            bestGptkEntry = candidateEntry;
          }
        }
      }
    } catch {}
  }

  const gptkCliCandidates = [
    options?.gptkBinaryPath,
    path.join(homedir, 'homebrew/bin/gameportingtoolkit'),
    ...(!isIsolatedTest
      ? ['/opt/homebrew/bin/gameportingtoolkit', '/usr/local/bin/gameportingtoolkit']
      : []),
  ].filter(Boolean);
  for (const cliBin of gptkCliCandidates) {
    if (!fs.existsSync(cliBin)) continue;
    try {
      const versionInfo = extractRunnerVersionInfo('gptk', cliBin, options);
      const d3dmInfo = detectBundledD3DMetalVersions(
        'gptk',
        cliBin,
        versionInfo.appPath || path.dirname(path.dirname(cliBin))
      );
      const candidateEntry = {
        sourceRank: 0,
        layer: {
          id: 'gptk',
          type: 'gptk',
          name: 'Apple Game Porting Toolkit (Homebrew)',
          binaryPath: cliBin,
          appPath: versionInfo.appPath,
          version: versionInfo.version,
          buildVersion: versionInfo.buildVersion,
          displayVersion: versionInfo.displayVersion,
          ...(d3dmInfo.d3dmetalVersion ? { d3dmetalVersion: d3dmInfo.d3dmetalVersion } : {}),
          ...(d3dmInfo.availableD3DMetalVersions
            ? { availableD3DMetalVersions: d3dmInfo.availableD3DMetalVersions }
            : {}),
          ...layerHostDlssCaps,
          availableBottles: [],
        },
      };
      if (isBetterRankedLayerCandidate(bestGptkEntry, candidateEntry)) {
        bestGptkEntry = candidateEntry;
      }
    } catch {}
  }

  if (bestGptkEntry && !addedTypes.has('gptk')) {
    addedTypes.add('gptk');
    layers.push(bestGptkEntry.layer);
  }

  const preferLegacyGlWine = Boolean(options && options.preferLegacy32BitOpenGlWine);
  /** @type {Array<{ binPath: string, name: string, retired: boolean, sourceRank: number, versionInfo: any }>} */
  const discoveredWineEntries = [];

  const wineAppVariants = [
    { appName: 'Wine Stable.app', label: 'Open-Source Wine (Wine Stable)', retired: false, variantBonus: 3 },
    { appName: 'Wine Staging.app', label: 'Open-Source Wine (Wine Staging)', retired: false, variantBonus: 2 },
    { appName: 'Wine Devel.app', label: 'Open-Source Wine (Wine Devel)', retired: false, variantBonus: 1 },
    { appName: 'Wine Crossover.app', label: 'Open-Source Wine (Wine-CrossOver)', retired: true, variantBonus: 0 },
  ];

  for (const wv of wineAppVariants) {
    for (const appsDir of appsDirs) {
      const bin64 = path.join(appsDir, wv.appName, 'Contents/Resources/wine/bin/wine64');
      const bin32 = path.join(appsDir, wv.appName, 'Contents/Resources/wine/bin/wine');
      const resolvedBin = fs.existsSync(bin64) ? bin64 : fs.existsSync(bin32) ? bin32 : '';
      if (resolvedBin) {
        const baseAppsRank = getAppsDirRank(appsDir) === 3 ? 600 : 500;
        discoveredWineEntries.push({
          binPath: resolvedBin,
          name: wv.label,
          retired: wv.retired,
          sourceRank: baseAppsRank + wv.variantBonus,
          versionInfo: extractRunnerVersionInfo('wine', resolvedBin, options),
        });
      }
    }
  }

  const heroicWineRoot = path.join(homedir, 'Library/Application Support/heroic/tools/wine');
  if (fs.existsSync(heroicWineRoot)) {
    try {
      const rankHeroicWineDir = (/** @type {any} */ dirName) => {
        const lower = String(dirName || '').toLowerCase();
        const isDxmt = lower.includes('-dxmt');
        if (lower.includes('wine-staging')) return isDxmt ? 485 : 490;
        if (lower.includes('wine-stable') || lower.includes('wine-devel')) return isDxmt ? 475 : 480;
        if (lower.includes('wine-crossover')) return 450;
        return 460;
      };
      const subdirs = fs
        .readdirSync(heroicWineRoot)
        .filter((sub) => !sub.startsWith('.'));
      for (const sub of subdirs) {
        const subBinCandidates = [
          path.join(heroicWineRoot, sub, 'bin/wine64'),
          path.join(heroicWineRoot, sub, 'Contents/Resources/wine/bin/wine64'),
          path.join(heroicWineRoot, sub, 'Contents/Resources/wine/bin/wine'),
          path.join(heroicWineRoot, sub, 'bin/wine'),
        ];
        const resolvedSubBin = subBinCandidates.find((b) => fs.existsSync(b));
        if (resolvedSubBin) {
          discoveredWineEntries.push({
            binPath: resolvedSubBin,
            name: 'Open-Source Wine (Heroic)',
            retired: /wine[-_\s]*crossover/i.test(sub),
            sourceRank: rankHeroicWineDir(sub),
            versionInfo: extractRunnerVersionInfo('wine', resolvedSubBin, options),
          });
        }
      }
    } catch {}
  }

  // Standalone community Wine managers on macOS (injected via externalWineManagerSpecs)
  for (const whiskyBin of [
    path.join(homedir, 'Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64'),
    path.join(homedir, 'Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine'),
  ]) {
    if (fs.existsSync(whiskyBin)) {
      discoveredWineEntries.push({
        binPath: whiskyBin,
        name: 'Open-Source Wine (Whisky)',
        retired: false,
        sourceRank: 350,
        versionInfo: extractRunnerVersionInfo('wine', whiskyBin, options),
      });
      break;
    }
  }

  for (const [engineDirRel, engineLabel, engineRank] of externalWineEngineDirSpecs) {
    const enginesRoot = path.join(homedir, engineDirRel);
    if (fs.existsSync(enginesRoot)) {
      try {
        const engineDirs = fs
          .readdirSync(enginesRoot)
          .filter((sub) => !sub.startsWith('.'));
        for (const sub of engineDirs) {
          const engBin = [
            path.join(enginesRoot, sub, 'wswine.bundle/bin/wine64'),
            path.join(enginesRoot, sub, 'wswine.bundle/bin/wine'),
          ].find((b) => fs.existsSync(b));
          if (engBin) {
            discoveredWineEntries.push({
              binPath: engBin,
              name: engineLabel,
              retired: /wine[-_\s]*crossover/i.test(sub),
              sourceRank: engineRank,
              versionInfo: extractRunnerVersionInfo('wine', engBin, options),
            });
          }
        }
      } catch {}
    }
  }

  for (const mythicBin of [
    path.join(homedir, 'Library/Application Support/Mythic/Libraries/Wine/bin/wine64'),
    path.join(homedir, 'Library/Application Support/Mythic/Libraries/Wine/bin/wine'),
  ]) {
    if (fs.existsSync(mythicBin)) {
      discoveredWineEntries.push({
        binPath: mythicBin,
        name: 'Open-Source Wine (Mythic)',
        retired: false,
        sourceRank: 320,
        versionInfo: extractRunnerVersionInfo('wine', mythicBin, options),
      });
      break;
    }
  }

  /** @type {Array<{ binPath: string, name: string, sourceRank: number }>} */
  const cliWineCandidates = [
    { binPath: path.join(homedir, 'bin/wine64'), name: 'Open-Source Wine (wine64)', sourceRank: 205 },
    { binPath: path.join(homedir, 'bin/wine'), name: 'Open-Source Wine (wine)', sourceRank: 204 },
  ];
  if (!isIsolatedTest) {
    cliWineCandidates.push(
      { binPath: '/opt/homebrew/bin/wine64', name: 'Open-Source Wine (Homebrew wine64)', sourceRank: 203 },
      { binPath: '/usr/local/bin/wine64', name: 'Open-Source Wine (Homebrew wine64)', sourceRank: 202 },
      { binPath: '/opt/homebrew/bin/wine', name: 'Open-Source Wine (Homebrew wine)', sourceRank: 201 },
      { binPath: '/usr/local/bin/wine', name: 'Open-Source Wine (Homebrew wine)', sourceRank: 200 }
    );
  }
  for (const cliItem of cliWineCandidates) {
    if (fs.existsSync(cliItem.binPath)) {
      discoveredWineEntries.push({
        binPath: cliItem.binPath,
        name: cliItem.name,
        retired: /wine[-_\s]*crossover/i.test(cliItem.binPath),
        sourceRank: cliItem.sourceRank,
        versionInfo: extractRunnerVersionInfo('wine', cliItem.binPath, options),
      });
    }
  }

  discoveredWineEntries.sort((a, b) => {
    if (!preferLegacyGlWine && a.retired !== b.retired) {
      return a.retired ? 1 : -1;
    }
    if (preferLegacyGlWine && a.retired !== b.retired) {
      return a.retired ? -1 : 1;
    }
    if (isCandidateNewerVersion(a.versionInfo, b.versionInfo)) return 1;
    if (isCandidateNewerVersion(b.versionInfo, a.versionInfo)) return -1;
    if (b.sourceRank !== a.sourceRank) return b.sourceRank - a.sourceRank;
    return compareRunnerVersions(path.basename(b.binPath), path.basename(a.binPath));
  });

  const foundWineEntry = discoveredWineEntries[0];
  const foundWineCrossoverFallback = discoveredWineEntries.find((entry) => entry.retired);
  if (foundWineEntry && !addedTypes.has('wine')) {
    addedTypes.add('wine');
    const defaultPrefix = path.join(homedir, '.wine');
    const versionInfo = foundWineEntry.versionInfo;
    layers.push({
      id: 'wine',
      type: 'wine',
      name: foundWineEntry.name,
      binaryPath: foundWineEntry.binPath,
      ...(foundWineCrossoverFallback
        ? { legacy32BitOpenGlBinaryPath: foundWineCrossoverFallback.binPath }
        : {}),
      appPath: versionInfo.appPath,
      version: versionInfo.version,
      buildVersion: versionInfo.buildVersion,
      displayVersion: versionInfo.displayVersion,
      ...layerHostDlssCaps,
      bottlesDir: fs.existsSync(defaultPrefix) ? defaultPrefix : undefined,
      availableBottles: [],
    });
  }

  const hasSharedPrefix =
    fs.existsSync(path.join(homedir, 'Games/OneLauncher/Prefixes/default/drive_c')) ||
    fs.existsSync(path.join(homedir, 'Games/OneLauncher/Prefixes/default/system.reg'));

  const isLayerReady = (/** @type {any} */ layer) => {
    if (Array.isArray(layer.availableBottles) && layer.availableBottles.length > 0) {
      return true;
    }
    if ((layer.type === 'gptk' || layer.type === 'wine') && hasSharedPrefix) {
      return true;
    }
    return false;
  };

  layers.sort((a, b) => {
    const aReady = isLayerReady(a) ? 1 : 0;
    const bReady = isLayerReady(b) ? 1 : 0;
    return bReady - aReady;
  });

  if (!bypassCache) {
    setBoundedMapEntry(
      compatLayersCache,
      compatCacheKey,
      { timestamp: Date.now(), layers: cloneCompatLayersList(layers) },
      32
    );
  }

  return layers;
}

/**
 * Determine whether an installed compatibility runner binary or `.app` bundle is managed inside
 * Homebrew (`Caskroom` or `Cellar`).
 *
 * @param {any} layer
 * @returns {boolean}
 */
function isHomebrewManagedLayer(layer) {
  if (!layer) return false;
  for (const rawPath of [layer.binaryPath, layer.appPath]) {
    if (!rawPath || typeof rawPath !== 'string') continue;
    let norm = rawPath.replace(/\\/g, '/');
    if (/\/(?:Caskroom|Cellar)\//i.test(norm) || /^\/(?:opt\/homebrew|usr\/local)\/bin\//i.test(norm)) {
      return true;
    }
    try {
      if (fs.existsSync(rawPath)) {
        norm = fs.realpathSync(rawPath).replace(/\\/g, '/');
        if (/\/(?:Caskroom|Cellar)\//i.test(norm)) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/**
 * Detect whether a compatibility runner layer belongs to an external third-party manager
 * (`Heroic` or standalone community Wine managers).
 *
 * @param {any} layer
 * @returns {string | null}
 */
function getExternalManagerForLayer(layer) {
  if (!layer) return null;
  const combined = `${layer.binaryPath || ''} ${layer.appPath || ''} ${layer.name || ''}`.replace(
    /\\/g,
    '/'
  );
  if (/\/heroic\/tools\//i.test(combined) || /\(Heroic\)/i.test(combined)) {
    return 'Heroic';
  }
  if (/Whisky/i.test(combined)) return 'Whisky';
  for (const matcher of externalWineManagerMatchers) {
    if (matcher.tokens.some((tok) => combined.includes(tok))) {
      return matcher.managerName;
    }
  }
  if (/Sikarugir/i.test(combined)) return 'Sikarugir';
  if (/Mythic/i.test(combined)) return 'Mythic';
  return null;
}


module.exports = {
  configureExternalWineManagerSpecs,
  extractBottleRootFromPath,
  extractRunnerPreviewDate,
  hasBottleSteamAppManifest,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  inspectBottleConfMetadata,
  assertRunnerBottleArchCompatible,
  isValidBottleDirectory,
  hasValidInitializedBottles,
  listBottleSubdirectories,
  listAllInitializedBottlePaths,
  resolveTargetBottleForFirstPartySync,
  getRunnerInstallReceiptsFilePath,
  getRunnerInstallReceiptsCandidatePaths,
  readRunnerInstallReceipts,
  recordRunnerInstallReceipt,
  extractRunnerVersionInfo,
  parsePlistStringValues,
  inspectCrossOverBundleMarkers,
  detectBundledD3DMetalVersions,
  compareRunnerVersions,
  invalidateCompatLayersCache,
  detectCompatibilityLayers,
  isHomebrewManagedLayer,
  getExternalManagerForLayer,
};
