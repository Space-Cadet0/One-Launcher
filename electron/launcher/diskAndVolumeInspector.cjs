// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');

const {
  toLocalFsPath,
  resolveIsolatedHomedirAndUserData,
  registerExternalCacheInvalidator,
} = require('./engineStateRegistry.cjs');
const {
  discoverWindowsLocalDrivesAsync,
  getKnownWindowsLocalDrivesSync,
  getCachedWindowsLocalDrives,
  clearCachedWindowsLocalDrives,
} = require('./securityAndPathUtils.cjs');
const { parseGamingRootFile } = require('./binaryAndManifestInspectors.cjs');

const GAMING_SERVICES_CACHE_TTL_MS = 30_000;
const MAC_VOLUME_CASE_CACHE_TTL_MS = 60_000;
const MAX_MAC_VOLUME_CASE_CACHE_ENTRIES = 64;
const DEFAULT_DIR_SIZE_MAX_ENTRIES = 100_000;

/** @type {{ timestamp: number, installed: boolean | null }} */
let winGamingServicesCache = {
  timestamp: 0,
  installed: null,
};

/** @type {Map<string, { timestamp: number, caseSensitive: boolean }>} */
const macVolumeCaseSensitivityCache = new Map();

registerExternalCacheInvalidator(() => {
  clearCachedWindowsLocalDrives();
  winGamingServicesCache = { timestamp: 0, installed: null };
  macVolumeCaseSensitivityCache.clear();
});

/**
 * @param {string} key
 * @param {{ timestamp: number, caseSensitive: boolean }} value
 */
function setBoundedCaseCache(key, value) {
  if (macVolumeCaseSensitivityCache.has(key)) {
    macVolumeCaseSensitivityCache.delete(key);
  } else if (macVolumeCaseSensitivityCache.size >= MAX_MAC_VOLUME_CASE_CACHE_ENTRIES) {
    const oldest = macVolumeCaseSensitivityCache.keys().next().value;
    if (oldest !== undefined) macVolumeCaseSensitivityCache.delete(oldest);
  }
  macVolumeCaseSensitivityCache.set(key, value);
}

/**
 * @param {unknown} rawDrive
 * @returns {string}
 */
function normalizeWindowsDriveRoot(rawDrive) {
  const m = String(rawDrive || '')
    .trim()
    .match(/^([A-Za-z]):/);
  return m ? `${m[1].toUpperCase()}:\\` : '';
}

/**
 * @param {string} basePath
 * @param {...string} segments
 * @returns {string}
 */
function joinWinOrHostPath(basePath, ...segments) {
  if (/^[A-Za-z]:[\\/]/.test(basePath) || basePath.includes('\\')) {
    return path.win32.join(basePath, ...segments);
  }
  return path.join(basePath, ...segments);
}

/**
 * @param {unknown} rawDrive
 * @returns {string}
 */
function resolveCandidateDriveRoot(rawDrive) {
  const trimmed = String(rawDrive || '').trim();
  if (!trimmed) return '';
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:\\`;
  }
  return trimmed;
}

/**
 * @param {string} value
 * @returns {string}
 */
function toggleAsciiCase(value) {
  return value.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
  );
}

/**
 * @param {string} plistOut
 * @returns {boolean}
 */
function parseDiskutilPlistCaseSensitivity(plistOut) {
  const csKeyMatch = plistOut.match(/<key>CaseSensitive<\/key>\s*<(true|false)\s*\/>/i);
  if (csKeyMatch) {
    return csKeyMatch[1].toLowerCase() === 'true';
  }
  return /Case-sensitive/i.test(plistOut);
}

/**
 * Determine whether an installation path resides on an external macOS `/Volumes/<Name>` or
 * non-system Windows `<DriveLetter>:\` volume whose volume root is currently unmounted/offline.
 *
 * @param {unknown} rawPath
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isExternalVolumeUnmounted(rawPath, options = {}) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;

  const platform = options.platform || process.platform;

  // macOS external volumes: /Volumes/<VolumeName>/...
  const posixNorm = trimmed.replace(/\\/g, '/');
  const macVolMatch = posixNorm.match(/^\/Volumes\/([^/]+)(?:\/|$)/);
  if (macVolMatch) {
    const volumeName = macVolMatch[1];
    if (!volumeName) return false;
    if (Array.isArray(options.mountedVolumes)) {
      return (
        !options.mountedVolumes.includes(volumeName) &&
        !options.mountedVolumes.includes(`/Volumes/${volumeName}`)
      );
    }
    const volRoot = `/Volumes/${volumeName}`;
    try {
      // Root volume symlink (e.g. `/Volumes/Macintosh HD` -> `/`) exists on mounted macOS systems
      return !fs.existsSync(volRoot);
    } catch {
      return true;
    }
  }

  // UNC network share paths (\\server\share\...) — never block on SMB if not explicitly reachable
  if (/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) {
    return false;
  }

  // Windows non-system drive letters: <DriveLetter>:\... where DriveLetter != SystemDrive
  const winDriveMatch = trimmed.match(/^([A-Za-z]):[\\/]/);
  if (winDriveMatch && (platform === 'win32' || Array.isArray(options.mountedDriveRoots))) {
    const driveLetter = winDriveMatch[1].toUpperCase();
    const sysDriveLetter =
      String(options.systemDrive || process.env.SystemDrive || 'C:')
        .trim()
        .charAt(0)
        .toUpperCase() || 'C';
    // Skip Wine's virtual Z:\ root on non-win32 hosts, but inspect Z:\ normally on native win32
    if (driveLetter === sysDriveLetter || (driveLetter === 'Z' && platform !== 'win32')) {
      return false;
    }
    const driveRoot = `${driveLetter}:\\`;
    if (Array.isArray(options.mountedDriveRoots)) {
      const normalizedMounted = options.mountedDriveRoots.map((/** @type {any} */ d) =>
        normalizeWindowsDriveRoot(d)
      );
      return !normalizedMounted.includes(driveRoot);
    }
    const knownDrives = getKnownWindowsLocalDrivesSync();
    if (knownDrives && knownDrives.length > 0) {
      return !knownDrives.includes(driveRoot);
    }
    if (process.platform === 'win32') {
      try {
        return !fs.existsSync(driveRoot);
      } catch {
        return true;
      }
    }
  }

  return false;
}

/**
 * Non-blocking async counterpart to `isExternalVolumeUnmounted`.
 *
 * @param {unknown} rawPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function isExternalVolumeUnmountedAsync(rawPath, options = {}) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;

  const platform = options.platform || process.platform;
  const posixNorm = trimmed.replace(/\\/g, '/');
  const macVolMatch = posixNorm.match(/^\/Volumes\/([^/]+)(?:\/|$)/);
  if (macVolMatch) {
    const volumeName = macVolMatch[1];
    if (!volumeName) return false;
    if (Array.isArray(options.mountedVolumes)) {
      return (
        !options.mountedVolumes.includes(volumeName) &&
        !options.mountedVolumes.includes(`/Volumes/${volumeName}`)
      );
    }
    try {
      await fs.promises.access(`/Volumes/${volumeName}`);
      return false;
    } catch {
      return true;
    }
  }

  if (/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) {
    return false;
  }

  const winDriveMatch = trimmed.match(/^([A-Za-z]):[\\/]/);
  if (winDriveMatch && (platform === 'win32' || Array.isArray(options.mountedDriveRoots))) {
    const driveLetter = winDriveMatch[1].toUpperCase();
    const sysDriveLetter =
      String(options.systemDrive || process.env.SystemDrive || 'C:')
        .trim()
        .charAt(0)
        .toUpperCase() || 'C';
    if (driveLetter === sysDriveLetter || (driveLetter === 'Z' && platform !== 'win32')) {
      return false;
    }
    const driveRoot = `${driveLetter}:\\`;
    if (Array.isArray(options.mountedDriveRoots)) {
      const normalizedMounted = options.mountedDriveRoots.map((/** @type {any} */ d) =>
        normalizeWindowsDriveRoot(d)
      );
      return !normalizedMounted.includes(driveRoot);
    }
    const knownDrives = await discoverWindowsLocalDrivesAsync(options);
    if (knownDrives && knownDrives.length > 0) {
      return !knownDrives.includes(driveRoot);
    }
    if (process.platform === 'win32') {
      try {
        await fs.promises.access(driveRoot);
        return false;
      } catch {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether Windows GamingServices is installed on the host (sync API preserved for existing callers).
 *
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function hasWindowsGamingServicesInstalled(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return false;
  if (typeof options.hasGamingServices === 'boolean') {
    return options.hasGamingServices;
  }

  const hasCustomExists = typeof options.existsSyncFn === 'function';
  const hasCustomExecSync = typeof options.execFileSyncFn === 'function';
  const isHermeticFixture = Boolean(
    options.homedir ||
      options.localAppData ||
      options.systemDrive ||
      options.systemRoot ||
      Array.isArray(options.mountedDriveRoots) ||
      hasCustomExists ||
      hasCustomExecSync
  );

  const now = Date.now();
  if (
    !isHermeticFixture &&
    !options.forceRefresh &&
    winGamingServicesCache.installed !== null &&
    now - winGamingServicesCache.timestamp < GAMING_SERVICES_CACHE_TTL_MS
  ) {
    return winGamingServicesCache.installed;
  }

  const existsSync = hasCustomExists ? options.existsSyncFn : fs.existsSync;

  /**
   * @param {string} rawRoot
   * @returns {boolean}
   */
  const hasGamingRootOrXboxGamesOnDrive = (rawRoot) => {
    const rootDir = resolveCandidateDriveRoot(rawRoot);
    if (!rootDir) return false;
    try {
      const gamingRootPath = joinWinOrHostPath(rootDir, '.GamingRoot');
      if (!hasCustomExists) {
        const parsedRoot = parseGamingRootFile(gamingRootPath, rootDir);
        if (parsedRoot && parsedRoot.resolvedPath && existsSync(parsedRoot.resolvedPath)) {
          return true;
        }
      }
      if (existsSync(gamingRootPath)) {
        return true;
      }
      if (existsSync(joinWinOrHostPath(rootDir, 'XboxGames'))) {
        return true;
      }
    } catch {}
    return false;
  };

  let installed = false;
  try {
    const sysDriveCandidate = options.systemDrive
      ? resolveCandidateDriveRoot(options.systemDrive)
      : !options.homedir
        ? resolveCandidateDriveRoot(process.env.SystemDrive || 'C:')
        : '';

    const systemRootCandidate = options.systemRoot
      ? String(options.systemRoot).trim()
      : !options.homedir && (process.platform === 'win32' || hasCustomExists || options.systemDrive)
        ? process.env.SystemRoot ||
          (sysDriveCandidate ? joinWinOrHostPath(sysDriveCandidate, 'Windows') : '')
        : '';

    if (systemRootCandidate) {
      const driverNames = ['gameflt.sys', 'xvdd.sys', 'gamingflt.sys'];
      for (const driverName of driverNames) {
        if (existsSync(joinWinOrHostPath(systemRootCandidate, 'System32', 'drivers', driverName))) {
          installed = true;
          break;
        }
      }
    }

    if (!installed) {
      const localAppData = options.localAppData
        ? String(options.localAppData).trim()
        : options.homedir
          ? joinWinOrHostPath(String(options.homedir).trim(), 'AppData', 'Local')
          : process.platform === 'win32' || hasCustomExists
            ? process.env.LOCALAPPDATA || joinWinOrHostPath(os.homedir(), 'AppData', 'Local')
            : '';

      if (localAppData) {
        const appDataIndicators = [
          joinWinOrHostPath(localAppData, 'Packages', 'Microsoft.GamingServices_8wekyb3d8bbwe'),
          joinWinOrHostPath(localAppData, 'Microsoft', 'WindowsApps', 'XboxPcApp.exe'),
          joinWinOrHostPath(
            localAppData,
            'Microsoft',
            'WindowsApps',
            'Microsoft.GamingApp_8wekyb3d8bbwe',
            'XboxPcApp.exe'
          ),
          joinWinOrHostPath(localAppData, 'Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe'),
        ];
        for (const indicator of appDataIndicators) {
          if (existsSync(indicator)) {
            installed = true;
            break;
          }
        }
      }
    }

    if (!installed) {
      /** @type {string[]} */
      const candidateDrives = [];
      const addDrive = (/** @type {any} */ d) => {
        const resolved = resolveCandidateDriveRoot(d);
        if (resolved && !candidateDrives.includes(resolved)) {
          candidateDrives.push(resolved);
        }
      };

      if (sysDriveCandidate) {
        addDrive(sysDriveCandidate);
      }
      if (Array.isArray(options.mountedDriveRoots)) {
        for (const root of options.mountedDriveRoots) {
          addDrive(root);
        }
      } else if (!options.homedir && (process.platform === 'win32' || hasCustomExists)) {
        const knownDrives = getKnownWindowsLocalDrivesSync();
        if (knownDrives && knownDrives.length > 0) {
          for (const cachedRoot of knownDrives) {
            addDrive(cachedRoot);
          }
        } else if (hasCustomExists) {
          for (let code = 67; code <= 90; code++) {
            const driveRoot = `${String.fromCharCode(code)}:\\`;
            if (!candidateDrives.includes(driveRoot) && existsSync(driveRoot)) {
              candidateDrives.push(driveRoot);
            }
          }
        }
      }

      for (const driveRoot of candidateDrives) {
        if (hasGamingRootOrXboxGamesOnDrive(driveRoot)) {
          installed = true;
          break;
        }
      }
    }

    if (!installed && (hasCustomExecSync || (!options.homedir && process.platform === 'win32'))) {
      const execSyncFn = hasCustomExecSync ? options.execFileSyncFn : execFileSync;
      try {
        execSyncFn(
          'reg.exe',
          [
            'query',
            'HKLM\\SYSTEM\\CurrentControlSet\\Services\\GamingServices',
            '/v',
            'ImagePath',
          ],
          {
            windowsHide: true,
            timeout: 1500,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );
        installed = true;
      } catch {
        installed = false;
      }
    }
  } catch {
    installed = false;
  }

  if (!isHermeticFixture) {
    winGamingServicesCache = {
      timestamp: now,
      installed,
    };
  }
  return installed;
}

/**
 * Non-blocking async counterpart to `hasWindowsGamingServicesInstalled`.
 * Uses `fs.promises.access`, `discoverWindowsLocalDrivesAsync`, and async `execFile('reg.exe', ...)`.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function hasWindowsGamingServicesInstalledAsync(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return false;
  if (typeof options.hasGamingServices === 'boolean') {
    return options.hasGamingServices;
  }
  if (
    typeof options.existsSyncFn === 'function' ||
    typeof options.execFileSyncFn === 'function'
  ) {
    return hasWindowsGamingServicesInstalled(options);
  }

  const hasCustomExecAsync =
    typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function';
  const isHermeticFixture = Boolean(
    options.homedir ||
      options.localAppData ||
      options.systemDrive ||
      options.systemRoot ||
      Array.isArray(options.mountedDriveRoots) ||
      hasCustomExecAsync
  );

  const now = Date.now();
  if (
    !isHermeticFixture &&
    !options.forceRefresh &&
    winGamingServicesCache.installed !== null &&
    now - winGamingServicesCache.timestamp < GAMING_SERVICES_CACHE_TTL_MS
  ) {
    return winGamingServicesCache.installed;
  }

  /**
   * @param {string} p
   * @returns {Promise<boolean>}
   */
  const existsAsync = async (p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  };

  let installed = false;
  try {
    const sysDriveCandidate = options.systemDrive
      ? resolveCandidateDriveRoot(options.systemDrive)
      : !options.homedir
        ? resolveCandidateDriveRoot(process.env.SystemDrive || 'C:')
        : '';

    const systemRootCandidate = options.systemRoot
      ? String(options.systemRoot).trim()
      : !options.homedir && (process.platform === 'win32' || options.systemDrive)
        ? process.env.SystemRoot ||
          (sysDriveCandidate ? joinWinOrHostPath(sysDriveCandidate, 'Windows') : '')
        : '';

    if (systemRootCandidate) {
      const checks = await Promise.all(
        ['gameflt.sys', 'xvdd.sys', 'gamingflt.sys'].map((driverName) =>
          existsAsync(joinWinOrHostPath(systemRootCandidate, 'System32', 'drivers', driverName))
        )
      );
      if (checks.some(Boolean)) installed = true;
    }

    if (!installed) {
      const localAppData = options.localAppData
        ? String(options.localAppData).trim()
        : options.homedir
          ? joinWinOrHostPath(String(options.homedir).trim(), 'AppData', 'Local')
          : process.platform === 'win32'
            ? process.env.LOCALAPPDATA || joinWinOrHostPath(os.homedir(), 'AppData', 'Local')
            : '';

      if (localAppData) {
        const indicators = [
          joinWinOrHostPath(localAppData, 'Packages', 'Microsoft.GamingServices_8wekyb3d8bbwe'),
          joinWinOrHostPath(localAppData, 'Microsoft', 'WindowsApps', 'XboxPcApp.exe'),
          joinWinOrHostPath(
            localAppData,
            'Microsoft',
            'WindowsApps',
            'Microsoft.GamingApp_8wekyb3d8bbwe',
            'XboxPcApp.exe'
          ),
          joinWinOrHostPath(localAppData, 'Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe'),
        ];
        const checks = await Promise.all(indicators.map(existsAsync));
        if (checks.some(Boolean)) installed = true;
      }
    }

    if (!installed) {
      /** @type {string[]} */
      const candidateDrives = [];
      const addDrive = (/** @type {any} */ d) => {
        const resolved = resolveCandidateDriveRoot(d);
        if (resolved && !candidateDrives.includes(resolved)) {
          candidateDrives.push(resolved);
        }
      };
      if (sysDriveCandidate) addDrive(sysDriveCandidate);
      if (Array.isArray(options.mountedDriveRoots)) {
        for (const root of options.mountedDriveRoots) addDrive(root);
      } else if (!options.homedir && process.platform === 'win32') {
        const drives = await discoverWindowsLocalDrivesAsync(options);
        for (const d of drives) addDrive(d);
      }

      for (const rootDir of candidateDrives) {
        if (
          (await existsAsync(joinWinOrHostPath(rootDir, '.GamingRoot'))) ||
          (await existsAsync(joinWinOrHostPath(rootDir, 'XboxGames')))
        ) {
          installed = true;
          break;
        }
      }
    }

    if (!installed && (hasCustomExecAsync || (!options.homedir && process.platform === 'win32'))) {
      const execAsyncImpl =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : execFile;
      installed = await new Promise((resolve) => {
        try {
          execAsyncImpl(
            'reg.exe',
            [
              'query',
              'HKLM\\SYSTEM\\CurrentControlSet\\Services\\GamingServices',
              '/v',
              'ImagePath',
            ],
            { windowsHide: true, timeout: 1500 },
            (/** @type {any} */ err) => resolve(!err)
          );
        } catch {
          resolve(false);
        }
      });
    }
  } catch {
    installed = false;
  }

  if (!isHermeticFixture) {
    winGamingServicesCache = {
      timestamp: now,
      installed,
    };
  }
  return installed;
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getDefaultXboxClientlessWinDir(options = {}) {
  const baseLocalAppData =
    options.localAppData ||
    process.env.LOCALAPPDATA ||
    options.homedir ||
    os.homedir();
  return joinWinOrHostPath(baseLocalAppData, 'Programs', 'OneLauncher', 'Games', 'Xbox');
}

/**
 * @param {string} [platformId='custom']
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getDefaultInstallDir(platformId = 'custom', options = {}) {
  const platform = options.platform || process.platform;
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const storeFolder =
    platformId === 'gog'
      ? 'GOG'
      : platformId === 'epic'
        ? 'Epic'
        : platformId === 'steam'
          ? 'Steam'
          : platformId === 'xbox'
            ? 'Xbox'
            : 'Games';

  if (platformId === 'xbox' && platform === 'win32' && !options.homedir) {
    const forceClientless =
      options.clientlessMsixvc === true ||
      options.isClientlessXboxInstall === true ||
      options.installMode === 'msixvc' ||
      options.installMode === 'direct_msixvc';

    if (forceClientless || !hasWindowsGamingServicesInstalled(options)) {
      return getDefaultXboxClientlessWinDir(options);
    }

    try {
      const sysDriveRoot =
        resolveCandidateDriveRoot(options.systemDrive || process.env.SystemDrive || 'C:') || 'C:\\';
      const candidateDrives = getCachedWindowsLocalDrives(options);
      if (!candidateDrives.includes(sysDriveRoot)) {
        candidateDrives.unshift(sysDriveRoot);
      }
      if (
        process.platform === 'win32' &&
        !Array.isArray(options.mountedDriveRoots) &&
        !getKnownWindowsLocalDrivesSync()
      ) {
        for (let code = 67; code <= 90; code++) {
          const driveRoot = `${String.fromCharCode(code)}:\\`;
          if (!candidateDrives.includes(driveRoot) && fs.existsSync(driveRoot)) {
            candidateDrives.push(driveRoot);
          }
        }
      }
      for (const rootDir of candidateDrives) {
        const gamingRoot = parseGamingRootFile(joinWinOrHostPath(rootDir, '.GamingRoot'), rootDir);
        if (gamingRoot && gamingRoot.resolvedPath) {
          return gamingRoot.resolvedPath;
        }
        const xboxGamesDir = joinWinOrHostPath(rootDir, 'XboxGames');
        if (fs.existsSync(xboxGamesDir)) {
          return xboxGamesDir;
        }
      }
    } catch {}
    return getDefaultXboxClientlessWinDir(options);
  }

  if (platform === 'win32' && !options.homedir) {
    const sysDriveRoot =
      resolveCandidateDriveRoot(options.systemDrive || process.env.SystemDrive || 'C:') || 'C:\\';
    return path.win32.join(sysDriveRoot, 'Games', 'OneLauncher', storeFolder);
  }
  return path.join(homedir, 'Games', 'OneLauncher', storeFolder);
}

/**
 * Non-destructive read-only volume case-sensitivity check on macOS (`darwin`, sync API preserved).
 *
 * @param {string} targetPath
 * @param {Record<string, any>} [options]
 * @returns {{ caseSensitive: boolean }}
 */
function checkVolumeCaseSensitivity(targetPath, options = {}) {
  if (typeof options.volumeCaseSensitive === 'boolean') {
    return { caseSensitive: options.volumeCaseSensitive };
  }
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return { caseSensitive: false };
  }

  const homedir = options.homedir || os.homedir();
  const curr = toLocalFsPath(targetPath || homedir) || targetPath || homedir;
  if (!curr || typeof curr !== 'string') {
    return { caseSensitive: false };
  }

  if (isExternalVolumeUnmounted(curr, options)) {
    return { caseSensitive: false };
  }

  const hasCustomFsMocks =
    typeof options.statSyncFn === 'function' ||
    typeof options.readdirSyncFn === 'function' ||
    typeof options.execFileSyncFn === 'function';
  const statSyncFn = typeof options.statSyncFn === 'function' ? options.statSyncFn : fs.statSync;
  const readdirSyncFn =
    typeof options.readdirSyncFn === 'function' ? options.readdirSyncFn : fs.readdirSync;
  const execFileSyncFn =
    typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;

  const pMod = platform === 'darwin' && curr.startsWith('/') ? path.posix : path;

  try {
    let existingPath = pMod.resolve(curr);
    /** @type {any} */
    let targetStat = null;
    for (let guard = 0; guard < 40 && existingPath; guard += 1) {
      try {
        targetStat = statSyncFn(existingPath);
        if (targetStat) break;
      } catch {
        const parent = pMod.dirname(existingPath);
        if (!parent || parent === existingPath) {
          existingPath = '';
          break;
        }
        existingPath = parent;
      }
    }

    if (!existingPath || !targetStat) {
      return { caseSensitive: false };
    }

    const targetDev = targetStat.dev;
    const cacheKey =
      targetDev !== undefined && targetDev !== null ? `dev:${String(targetDev)}` : existingPath;
    const now = Date.now();
    if (!hasCustomFsMocks && !options.forceRefresh) {
      const cached = macVolumeCaseSensitivityCache.get(cacheKey);
      if (cached && now - cached.timestamp < MAC_VOLUME_CASE_CACHE_TTL_MS) {
        return { caseSensitive: cached.caseSensitive };
      }
    }

    let probeOrigPath = '';
    /** @type {any} */
    let probeOrigStat = null;

    let walkNode = existingPath;
    for (let depth = 0; depth < 40 && walkNode; depth += 1) {
      const parentDir = pMod.dirname(walkNode);
      if (!parentDir || parentDir === walkNode) break;
      /** @type {any} */
      let parentStat = null;
      try {
        parentStat = statSyncFn(parentDir);
      } catch {
        break;
      }
      if (!parentStat || parentStat.dev !== targetDev) {
        break;
      }
      const base = pMod.basename(walkNode);
      if (base && /[A-Za-z]/.test(base) && toggleAsciiCase(base) !== base) {
        try {
          probeOrigStat = walkNode === existingPath ? targetStat : statSyncFn(walkNode);
          probeOrigPath = walkNode;
          break;
        } catch {}
      }
      walkNode = parentDir;
    }

    const mountRootDir = walkNode || existingPath;
    if (!probeOrigPath) {
      /** @type {any} */
      let mountDirStat = null;
      try {
        mountDirStat = mountRootDir === existingPath ? targetStat : statSyncFn(mountRootDir);
      } catch {}
      if (mountDirStat && typeof mountDirStat.isDirectory === 'function' && mountDirStat.isDirectory()) {
        try {
          const entries = readdirSyncFn(mountRootDir).slice(0, 64);
          for (const rawEntry of entries) {
            const name = typeof rawEntry === 'string' ? rawEntry : rawEntry?.name;
            if (!name || name === '.' || name === '..') continue;
            if (!/[A-Za-z]/.test(name) || toggleAsciiCase(name) === name) continue;
            const candidateChild = pMod.join(mountRootDir, name);
            try {
              const childStat = statSyncFn(candidateChild);
              if (childStat && childStat.dev === targetDev) {
                probeOrigPath = candidateChild;
                probeOrigStat = childStat;
                break;
              }
            } catch {}
          }
        } catch {}
      }
    }

    if (probeOrigPath && probeOrigStat) {
      const parentDir = pMod.dirname(probeOrigPath);
      const toggledBase = toggleAsciiCase(pMod.basename(probeOrigPath));
      const toggledPath = pMod.join(parentDir, toggledBase);
      let caseSensitive = false;
      try {
        const toggledStat = statSyncFn(toggledPath);
        caseSensitive = !(
          toggledStat &&
          toggledStat.ino === probeOrigStat.ino &&
          toggledStat.dev === probeOrigStat.dev
        );
      } catch (/** @type {any} */ statErr) {
        if (statErr && statErr.code === 'ENOENT') {
          caseSensitive = true;
        }
      }
      if (!hasCustomFsMocks) {
        setBoundedCaseCache(cacheKey, { timestamp: now, caseSensitive });
      }
      return { caseSensitive };
    }

    if (process.platform === 'darwin' || typeof options.execFileSyncFn === 'function') {
      const volMatch = existingPath.match(/^(\/Volumes\/[^/]+)(?:\/|$)/);
      const mountPoint = volMatch ? volMatch[1] : mountRootDir || '/';
      try {
        const plistOut = String(
          execFileSyncFn('/usr/sbin/diskutil', ['info', '-plist', mountPoint], {
            timeout: 2000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }) || ''
        );
        const caseSensitive = parseDiskutilPlistCaseSensitivity(plistOut);
        if (!hasCustomFsMocks) {
          setBoundedCaseCache(cacheKey, { timestamp: now, caseSensitive });
        }
        return { caseSensitive };
      } catch {}
    }
  } catch {}

  return { caseSensitive: false };
}

/**
 * Non-blocking async macOS volume case-sensitivity check using `fs.promises.stat`,
 * `fs.promises.readdir`, and async `execFile('/usr/sbin/diskutil', ['info', '-plist', ...])`
 * (zero main-thread `execFileSync` blocking!).
 *
 * @param {string} targetPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ caseSensitive: boolean }>}
 */
async function checkVolumeCaseSensitivityAsync(targetPath, options = {}) {
  if (typeof options.volumeCaseSensitive === 'boolean') {
    return { caseSensitive: options.volumeCaseSensitive };
  }
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return { caseSensitive: false };
  }

  // Preserve compatibility when tests inject synchronous mocks without async counterparts
  if (
    (typeof options.statSyncFn === 'function' ||
      typeof options.readdirSyncFn === 'function' ||
      typeof options.execFileSyncFn === 'function') &&
    typeof options.statAsyncFn !== 'function' &&
    typeof options.execFileImpl !== 'function' &&
    typeof options.execFileFn !== 'function'
  ) {
    return checkVolumeCaseSensitivity(targetPath, options);
  }

  const homedir = options.homedir || os.homedir();
  const curr = toLocalFsPath(targetPath || homedir) || targetPath || homedir;
  if (!curr || typeof curr !== 'string') {
    return { caseSensitive: false };
  }

  if (await isExternalVolumeUnmountedAsync(curr, options)) {
    return { caseSensitive: false };
  }

  const hasCustomMocks =
    typeof options.statAsyncFn === 'function' ||
    typeof options.readdirAsyncFn === 'function' ||
    typeof options.execFileImpl === 'function' ||
    typeof options.execFileFn === 'function';
  const statAsyncFn =
    typeof options.statAsyncFn === 'function'
      ? options.statAsyncFn
      : fs.promises.stat.bind(fs.promises);
  const readdirAsyncFn =
    typeof options.readdirAsyncFn === 'function'
      ? options.readdirAsyncFn
      : fs.promises.readdir.bind(fs.promises);
  const execFileAsyncFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const pMod = platform === 'darwin' && curr.startsWith('/') ? path.posix : path;

  try {
    let existingPath = pMod.resolve(curr);
    /** @type {any} */
    let targetStat = null;
    for (let guard = 0; guard < 40 && existingPath; guard += 1) {
      try {
        targetStat = await statAsyncFn(existingPath);
        if (targetStat) break;
      } catch {
        const parent = pMod.dirname(existingPath);
        if (!parent || parent === existingPath) {
          existingPath = '';
          break;
        }
        existingPath = parent;
      }
    }

    if (!existingPath || !targetStat) {
      return { caseSensitive: false };
    }

    const targetDev = targetStat.dev;
    const cacheKey =
      targetDev !== undefined && targetDev !== null ? `dev:${String(targetDev)}` : existingPath;
    const now = Date.now();
    if (!hasCustomMocks && !options.forceRefresh) {
      const cached = macVolumeCaseSensitivityCache.get(cacheKey);
      if (cached && now - cached.timestamp < MAC_VOLUME_CASE_CACHE_TTL_MS) {
        return { caseSensitive: cached.caseSensitive };
      }
    }

    let probeOrigPath = '';
    /** @type {any} */
    let probeOrigStat = null;

    let walkNode = existingPath;
    for (let depth = 0; depth < 40 && walkNode; depth += 1) {
      const parentDir = pMod.dirname(walkNode);
      if (!parentDir || parentDir === walkNode) break;
      /** @type {any} */
      let parentStat = null;
      try {
        parentStat = await statAsyncFn(parentDir);
      } catch {
        break;
      }
      if (!parentStat || parentStat.dev !== targetDev) {
        break;
      }
      const base = pMod.basename(walkNode);
      if (base && /[A-Za-z]/.test(base) && toggleAsciiCase(base) !== base) {
        try {
          probeOrigStat = walkNode === existingPath ? targetStat : await statAsyncFn(walkNode);
          probeOrigPath = walkNode;
          break;
        } catch {}
      }
      walkNode = parentDir;
    }

    const mountRootDir = walkNode || existingPath;
    if (!probeOrigPath) {
      /** @type {any} */
      let mountDirStat = null;
      try {
        mountDirStat =
          mountRootDir === existingPath ? targetStat : await statAsyncFn(mountRootDir);
      } catch {}
      if (mountDirStat && typeof mountDirStat.isDirectory === 'function' && mountDirStat.isDirectory()) {
        try {
          const entries = (await readdirAsyncFn(mountRootDir)).slice(0, 64);
          for (const rawEntry of entries) {
            const name = typeof rawEntry === 'string' ? rawEntry : rawEntry?.name;
            if (!name || name === '.' || name === '..') continue;
            if (!/[A-Za-z]/.test(name) || toggleAsciiCase(name) === name) continue;
            const candidateChild = pMod.join(mountRootDir, name);
            try {
              const childStat = await statAsyncFn(candidateChild);
              if (childStat && childStat.dev === targetDev) {
                probeOrigPath = candidateChild;
                probeOrigStat = childStat;
                break;
              }
            } catch {}
          }
        } catch {}
      }
    }

    if (probeOrigPath && probeOrigStat) {
      const parentDir = pMod.dirname(probeOrigPath);
      const toggledBase = toggleAsciiCase(pMod.basename(probeOrigPath));
      const toggledPath = pMod.join(parentDir, toggledBase);
      let caseSensitive = false;
      try {
        const toggledStat = await statAsyncFn(toggledPath);
        caseSensitive = !(
          toggledStat &&
          toggledStat.ino === probeOrigStat.ino &&
          toggledStat.dev === probeOrigStat.dev
        );
      } catch (/** @type {any} */ statErr) {
        if (statErr && statErr.code === 'ENOENT') {
          caseSensitive = true;
        }
      }
      if (!hasCustomMocks) {
        setBoundedCaseCache(cacheKey, { timestamp: now, caseSensitive });
      }
      return { caseSensitive };
    }

    // Async empty-volume fallback: non-blocking `diskutil info -plist <mountPoint>`
    if (
      process.platform === 'darwin' ||
      typeof options.execFileImpl === 'function' ||
      typeof options.execFileFn === 'function'
    ) {
      const volMatch = existingPath.match(/^(\/Volumes\/[^/]+)(?:\/|$)/);
      const mountPoint = volMatch ? volMatch[1] : mountRootDir || '/';
      const plistOut = await new Promise((resolve) => {
        try {
          execFileAsyncFn(
            '/usr/sbin/diskutil',
            ['info', '-plist', mountPoint],
            { timeout: 2000, encoding: 'utf8' },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              resolve(!err && stdout ? String(stdout) : '');
            }
          );
        } catch {
          resolve('');
        }
      });
      if (plistOut) {
        const caseSensitive = parseDiskutilPlistCaseSensitivity(String(plistOut));
        if (!hasCustomMocks) {
          setBoundedCaseCache(cacheKey, { timestamp: now, caseSensitive });
        }
        return { caseSensitive };
      }
    }
  } catch {}

  return { caseSensitive: false };
}

/**
 * Honest non-blocking async disk space inspection via `fs.promises.statfs` +
 * async `checkVolumeCaseSensitivityAsync`.
 *
 * @param {string} targetPath
 * @param {Record<string, any>} [options]
 */
async function getDiskSpace(targetPath, options = {}) {
  const homedir = options.homedir || os.homedir();
  let curr = toLocalFsPath(targetPath || homedir) || targetPath || homedir;

  try {
    const isRealHostOs =
      !options.homedir && (!options.platform || options.platform === process.platform);
    if (isRealHostOs || options.mountedVolumes || options.mountedDriveRoots) {
      if (await isExternalVolumeUnmountedAsync(curr, options)) {
        return {
          targetPath: targetPath || curr,
          availableBytes: null,
          freeBytes: null,
          totalBytes: null,
          usedBytes: null,
          volumeMissing: true,
          error: `Volume is not mounted for path: ${targetPath || curr}`,
        };
      }
    }

    let guard = 0;
    while (curr && guard < 40) {
      try {
        await fs.promises.access(curr);
        break;
      } catch {
        const parent = path.dirname(curr);
        if (!parent || parent === curr) {
          curr = '';
          break;
        }
        curr = parent;
        guard++;
      }
    }

    if (!curr) {
      return {
        targetPath: targetPath || '',
        availableBytes: null,
        freeBytes: null,
        totalBytes: null,
        usedBytes: null,
        error: `No accessible ancestor directory for path: ${targetPath || ''}`,
      };
    }

    const statfsFn =
      typeof options.statfsFn === 'function'
        ? options.statfsFn
        : fs.promises.statfs.bind(fs.promises);
    const stats = await statfsFn(curr);
    const bsize = Number(stats.bsize || 4096);
    const totalBytes = Number(stats.blocks || 0) * bsize;
    const freeBytes = Number(stats.bavail ?? stats.bfree ?? 0) * bsize;
    const usedBytes = Math.max(0, totalBytes - Number(stats.bfree ?? 0) * bsize);
    const effectivePlatform = options.platform || process.platform;
    const caseSensitivityInfo =
      effectivePlatform === 'darwin'
        ? await checkVolumeCaseSensitivityAsync(curr, options)
        : null;

    return {
      targetPath: targetPath || curr,
      availableBytes: freeBytes,
      freeBytes,
      totalBytes,
      usedBytes,
      ...(caseSensitivityInfo ? { caseSensitive: caseSensitivityInfo.caseSensitive } : {}),
    };
  } catch (/** @type {any} */ err) {
    return {
      targetPath: targetPath || curr || '',
      availableBytes: null,
      freeBytes: null,
      totalBytes: null,
      usedBytes: null,
      error: String(err?.message || err || 'Failed to inspect filesystem space'),
    };
  }
}

/**
 * Safely and quickly sum file sizes in a directory synchronously up to `maxDepth`
 * (skips symlinks, bounded entry cap; kept intact for existing sync callers).
 *
 * @param {string} dirPath
 * @param {number} [maxDepth=4]
 * @returns {number}
 */
function getDirectorySizeFast(dirPath, maxDepth = 4) {
  if (!dirPath || typeof dirPath !== 'string' || !fs.existsSync(dirPath)) return 0;
  let total = 0;
  let visitedEntries = 0;

  /**
   * @param {string} curr
   * @param {number} depth
   */
  function walk(curr, depth) {
    if (depth > maxDepth || visitedEntries >= DEFAULT_DIR_SIZE_MAX_ENTRIES) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(curr, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visitedEntries >= DEFAULT_DIR_SIZE_MAX_ENTRIES) return;
      visitedEntries += 1;
      if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
      const full = path.join(curr, entry.name);
      if (entry.isFile()) {
        try {
          const st = fs.lstatSync(full);
          if (!st.isSymbolicLink()) {
            total += Number(st.size || 0);
          }
        } catch {}
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }

  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return Number(st.size || 0);
    if (st.isDirectory()) walk(dirPath, 0);
  } catch {}

  return total;
}

/**
 * Non-blocking, symlink-safe, bounded asynchronous directory size calculator.
 * Uses iterative `fs.promises.readdir` + `fs.promises.lstat`, respects optional `AbortSignal`,
 * caps total visited entries, and yields to the event loop every 256 entries.
 *
 * @param {string} dirPath
 * @param {number | { maxDepth?: number, maxEntries?: number, signal?: AbortSignal | null }} [maxDepthOrOptions=4]
 * @returns {Promise<number>}
 */
async function getDirectorySizeFastAsync(dirPath, maxDepthOrOptions = 4) {
  if (!dirPath || typeof dirPath !== 'string') return 0;
  const maxDepth =
    typeof maxDepthOrOptions === 'number'
      ? Math.max(0, Math.floor(maxDepthOrOptions))
      : typeof maxDepthOrOptions?.maxDepth === 'number'
        ? Math.max(0, Math.floor(maxDepthOrOptions.maxDepth))
        : 4;
  const maxEntries =
    typeof maxDepthOrOptions === 'object' &&
    typeof maxDepthOrOptions?.maxEntries === 'number' &&
    maxDepthOrOptions.maxEntries > 0
      ? Math.floor(maxDepthOrOptions.maxEntries)
      : DEFAULT_DIR_SIZE_MAX_ENTRIES;
  const signal = typeof maxDepthOrOptions === 'object' ? maxDepthOrOptions?.signal || null : null;

  if (signal?.aborted) return 0;

  /** @type {fs.Stats} */
  let rootStat;
  try {
    rootStat = await fs.promises.lstat(dirPath);
  } catch {
    return 0;
  }
  if (rootStat.isSymbolicLink()) return 0;
  if (rootStat.isFile()) return Number(rootStat.size || 0);
  if (!rootStat.isDirectory()) return 0;

  let total = 0;
  let visitedEntries = 0;
  /** @type {Array<{ dir: string, depth: number }>} */
  const stack = [{ dir: dirPath, depth: 0 }];

  while (stack.length > 0 && visitedEntries < maxEntries) {
    if (signal?.aborted) break;
    const current = /** @type {{ dir: string, depth: number }} */ (stack.pop());
    if (current.depth > maxDepth) continue;

    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visitedEntries >= maxEntries || signal?.aborted) break;
      visitedEntries += 1;
      if (visitedEntries % 256 === 0) {
        await new Promise((r) => setImmediate(r));
      }
      if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
      const full = path.join(current.dir, entry.name);

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      /** @type {fs.Stats | null} */
      let statObj = null;

      if (!isDir && !isFile) {
        try {
          statObj = await fs.promises.lstat(full);
          if (statObj.isSymbolicLink()) continue;
          isDir = statObj.isDirectory();
          isFile = statObj.isFile();
        } catch {
          continue;
        }
      }

      if (isFile) {
        try {
          const st = statObj || (await fs.promises.lstat(full));
          if (!st.isSymbolicLink() && st.isFile()) {
            total += Number(st.size || 0);
          }
        } catch {}
      } else if (isDir && current.depth < maxDepth) {
        stack.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }

  return total;
}

module.exports = {
  normalizeWindowsDriveRoot,
  discoverWindowsLocalDrivesAsync,
  getCachedWindowsLocalDrives,
  isExternalVolumeUnmounted,
  isExternalVolumeUnmountedAsync,
  hasWindowsGamingServicesInstalled,
  hasWindowsGamingServicesInstalledAsync,
  getDefaultXboxClientlessWinDir,
  getDefaultInstallDir,
  checkVolumeCaseSensitivity,
  checkVolumeCaseSensitivityAsync,
  getDiskSpace,
  getDirectorySizeFast,
  getDirectorySizeFastAsync,
};
