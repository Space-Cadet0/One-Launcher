const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');

const {
  toLocalFsPath,
  resolveIsolatedHomedirAndUserData,
  registerExternalCacheInvalidator,
} = require('./engineStateRegistry.cjs');
const { parseGamingRootFile } = require('./binaryAndManifestInspectors.cjs');

const WIN_DRIVE_CACHE_TTL_MS = 10_000;
const GAMING_SERVICES_CACHE_TTL_MS = 30_000;

/** @type {{ timestamp: number, drives: string[] | null, inFlight: Promise<string[]> | null }} */
let winLocalDrivesCache = {
  timestamp: 0,
  drives: null,
  inFlight: null,
};

/** @type {{ timestamp: number, installed: boolean | null }} */
let winGamingServicesCache = {
  timestamp: 0,
  installed: null,
};

const MAC_VOLUME_CASE_CACHE_TTL_MS = 60_000;
/** @type {Map<string, { timestamp: number, caseSensitive: boolean }>} */
const macVolumeCaseSensitivityCache = new Map();

registerExternalCacheInvalidator(() => {
  winLocalDrivesCache = { timestamp: 0, drives: null, inFlight: null };
  winGamingServicesCache = { timestamp: 0, installed: null };
  macVolumeCaseSensitivityCache.clear();
});

function normalizeWindowsDriveRoot(rawDrive) {
  const m = String(rawDrive || '').trim().match(/^([A-Za-z]):/);
  return m ? `${m[1].toUpperCase()}:\\` : '';
}

function parseLogicalDiskJsonOutput(stdout) {
  /** @type {string[]} */
  const roots = [];
  const seen = new Set();
  const addRoot = (/** @type {any} */ val) => {
    const norm = normalizeWindowsDriveRoot(val);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      roots.push(norm);
    }
  };

  const trimmed = String(stdout || '').trim();
  if (!trimmed) return roots;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string') {
          addRoot(item);
        } else if (item && typeof item === 'object') {
          addRoot(item.DeviceID || item.Name || item.Root);
        }
      }
      return roots;
    }
    if (typeof parsed === 'string') {
      addRoot(parsed);
      return roots;
    }
    if (parsed && typeof parsed === 'object') {
      addRoot(parsed.DeviceID || parsed.Name || parsed.Root);
      return roots;
    }
  } catch {}

  for (const line of trimmed.split(/\r?\n/)) {
    addRoot(line);
  }
  return roots;
}

/**
 * Discover local fixed/removable Windows drives asynchronously (`DriveType=2 OR DriveType=3`),
 * cached for 10 seconds. Skips `DriveType=4` SMB network shares to avoid 21s TCP timeouts.
 */
async function discoverWindowsLocalDrivesAsync(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];

  const sysDriveRoot =
    normalizeWindowsDriveRoot(options.systemDrive || process.env.SystemDrive || 'C:') || 'C:\\';

  if (Array.isArray(options.mountedDriveRoots)) {
    const explicit = options.mountedDriveRoots
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
    return explicit.length > 0 ? explicit : [sysDriveRoot];
  }

  const hasCustomExec =
    typeof options.execFileFn === 'function' || typeof options.execFileImpl === 'function';

  const now = Date.now();
  if (
    !hasCustomExec &&
    !options.forceRefresh &&
    winLocalDrivesCache.drives &&
    now - winLocalDrivesCache.timestamp < WIN_DRIVE_CACHE_TTL_MS
  ) {
    return [...winLocalDrivesCache.drives];
  }

  if (!hasCustomExec && !options.forceRefresh && winLocalDrivesCache.inFlight) {
    return winLocalDrivesCache.inFlight;
  }

  const execFileFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  // On non-Windows hosts running cross-OS unit tests without an execFile mock, return sysDriveRoot immediately.
  if (process.platform !== 'win32' && !hasCustomExec) {
    return [sysDriveRoot];
  }

  const psScript =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" | ' +
    'Select-Object -ExpandProperty DeviceID | ConvertTo-Json -Compress';

  const promise = new Promise((resolve) => {
    try {
      execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 4000, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          const parsed = !err ? parseLogicalDiskJsonOutput(stdout) : [];
          const result = parsed.length > 0 ? parsed : [sysDriveRoot];
          if (!result.includes(sysDriveRoot)) {
            result.unshift(sysDriveRoot);
          }
          if (!hasCustomExec) {
            winLocalDrivesCache = {
              timestamp: Date.now(),
              drives: result,
              inFlight: null,
            };
          }
          resolve([...result]);
        }
      );
    } catch {
      if (!hasCustomExec) {
        winLocalDrivesCache = {
          timestamp: Date.now(),
          drives: [sysDriveRoot],
          inFlight: null,
        };
      }
      resolve([sysDriveRoot]);
    }
  });

  if (!hasCustomExec) {
    winLocalDrivesCache.inFlight = promise;
  }
  return promise;
}

/**
 * Return cached local Windows drives without ever looping A:\..Z:\ synchronously.
 */
function getCachedWindowsLocalDrives(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];
  const sysDriveRoot =
    normalizeWindowsDriveRoot(options.systemDrive || process.env.SystemDrive || 'C:') || 'C:\\';
  if (Array.isArray(options.mountedDriveRoots)) {
    const explicit = options.mountedDriveRoots
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
    return explicit.length > 0 ? explicit : [sysDriveRoot];
  }
  if (winLocalDrivesCache.drives && winLocalDrivesCache.drives.length > 0) {
    return [...winLocalDrivesCache.drives];
  }
  return [sysDriveRoot];
}

/**
 * Determine whether an installation path resides on an external macOS `/Volumes/<Name>` or
 * non-system Windows `<DriveLetter>:\` volume whose volume root is currently unmounted/offline.
 */
function isExternalVolumeUnmounted(rawPath, /** @type {any} */ options = {}) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;

  const platform = options.platform || process.platform;

  // macOS external volumes: /Volumes/<VolumeName>/...
  const posixNorm = trimmed.replace(/\\/g, '/');
  const macVolMatch = posixNorm.match(/^\/Volumes\/([^/]+)(?:\/|$)/);
  if (macVolMatch) {
    const volumeName = macVolMatch[1];
    if (!volumeName || volumeName === 'Macintosh HD') return false;
    if (Array.isArray(options.mountedVolumes)) {
      return !options.mountedVolumes.includes(volumeName) &&
        !options.mountedVolumes.includes(`/Volumes/${volumeName}`);
    }
    const volRoot = `/Volumes/${volumeName}`;
    try {
      return !fs.existsSync(volRoot);
    } catch {
      return true;
    }
  }

  // UNC network share paths (\\server\share\...) — never block on SMB if not explicitly reachable
  if (/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) {
    return false;
  }

  // Windows non-system drive letters: <DriveLetter>:\... where DriveLetter != SystemDrive (C)
  const winDriveMatch = trimmed.match(/^([A-Za-z]):[\\/]/);
  if (winDriveMatch && (platform === 'win32' || Array.isArray(options.mountedDriveRoots))) {
    const driveLetter = winDriveMatch[1].toUpperCase();
    const sysDriveLetter = String(options.systemDrive || process.env.SystemDrive || 'C:')
      .trim()
      .charAt(0)
      .toUpperCase() || 'C';
    if (driveLetter === sysDriveLetter || driveLetter === 'Z') {
      return false;
    }
    const driveRoot = `${driveLetter}:\\`;
    if (Array.isArray(options.mountedDriveRoots)) {
      const normalizedMounted = options.mountedDriveRoots.map((/** @type {any} */ d) =>
        normalizeWindowsDriveRoot(d)
      );
      return !normalizedMounted.includes(driveRoot);
    }
    if (
      winLocalDrivesCache.drives &&
      Date.now() - winLocalDrivesCache.timestamp < WIN_DRIVE_CACHE_TTL_MS
    ) {
      return !winLocalDrivesCache.drives.includes(driveRoot);
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

function resolveCandidateDriveRoot(rawDrive) {
  const trimmed = String(rawDrive || '').trim();
  if (!trimmed) return '';
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:\\`;
  }
  return trimmed;
}

/**
 * Check whether Windows GamingServices is installed on the host.
 */
function hasWindowsGamingServicesInstalled(/** @type {any} */ options = {}) {
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
    // 1. Kernel filter & XVD drivers (<SystemRoot>\System32\drivers\{gameflt.sys,xvdd.sys,gamingflt.sys})
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

    // 2. MSIX package state & Xbox App execution aliases under %LOCALAPPDATA%
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

    // 3. Mounted drive roots (SystemDrive first, then mounted C:..Z: / fixture roots) for .GamingRoot or XboxGames
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
        if (winLocalDrivesCache.drives && winLocalDrivesCache.drives.length > 0) {
          for (const cachedRoot of winLocalDrivesCache.drives) {
            addDrive(cachedRoot);
          }
        } else {
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

    // 4. Final SCM registry fallback on real win32 (never leaked into hermetic homedir tests unless mocked)
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

function joinWinOrHostPath(basePath, ...segments) {
  if (/^[A-Za-z]:[\\/]/.test(basePath) || basePath.includes('\\')) {
    return path.win32.join(basePath, ...segments);
  }
  return path.join(basePath, ...segments);
}

function getDefaultXboxClientlessWinDir(/** @type {any} */ options = {}) {
  const baseLocalAppData =
    options.localAppData ||
    process.env.LOCALAPPDATA ||
    options.homedir ||
    os.homedir();
  return joinWinOrHostPath(baseLocalAppData, 'Programs', 'OneLauncher', 'Games', 'Xbox');
}

function getDefaultInstallDir(platformId = 'custom', /** @type {any} */ options = {}) {
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
        !winLocalDrivesCache.drives
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
    return `C:\\Games\\OneLauncher\\${storeFolder}`;
  }
  return path.join(homedir, 'Games', 'OneLauncher', storeFolder);
}

/**
 * Non-destructive read-only volume case-sensitivity check on macOS (`darwin`).
 * Compares inode (`st.ino`) + device (`st.dev`) of an existing entry vs its toggled-ASCII-case
 * twin whose parent directory resides on the same `st.dev` (avoiding `/Volumes/<Name>` rootfs
 * parent confusion), falling back to cached `diskutil info -plist` only when a volume contains
 * zero ASCII-letter entries.
 *
 * @param {string} targetPath
 * @param {any} [options={}]
 * @returns {{ caseSensitive: boolean }}
 */
function checkVolumeCaseSensitivity(targetPath, /** @type {any} */ options = {}) {
  if (typeof options.volumeCaseSensitive === 'boolean') {
    return { caseSensitive: options.volumeCaseSensitive };
  }
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return { caseSensitive: false };
  }

  const homedir = options.homedir || os.homedir();
  let curr = toLocalFsPath(targetPath || homedir) || targetPath || homedir;
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

  const toggleAsciiCase = (/** @type {string} */ value) =>
    value.replace(/[A-Za-z]/g, (ch) =>
      ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
    );

  try {
    let existingPath = path.resolve(curr);
    /** @type {any} */
    let targetStat = null;
    for (let guard = 0; guard < 40 && existingPath; guard += 1) {
      try {
        targetStat = statSyncFn(existingPath);
        if (targetStat) break;
      } catch {
        const parent = path.dirname(existingPath);
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

    // 1. Walk up `existingPath` while parent remains on the exact same `st.dev`
    let walkNode = existingPath;
    for (let depth = 0; depth < 40 && walkNode; depth += 1) {
      const parentDir = path.dirname(walkNode);
      if (!parentDir || parentDir === walkNode) break;
      /** @type {any} */
      let parentStat = null;
      try {
        parentStat = statSyncFn(parentDir);
      } catch {
        break;
      }
      if (!parentStat || parentStat.dev !== targetDev) {
        // Crossed volume mount boundary (e.g., `/Volumes/ExternalSSD` -> `/Volumes`)
        break;
      }
      const base = path.basename(walkNode);
      if (base && /[A-Za-z]/.test(base) && toggleAsciiCase(base) !== base) {
        try {
          probeOrigStat = walkNode === existingPath ? targetStat : statSyncFn(walkNode);
          probeOrigPath = walkNode;
          break;
        } catch {}
      }
      walkNode = parentDir;
    }

    // 2. If `existingPath` is a mount root (e.g. `/` or `/Volumes/ExternalSSD`), inspect an entry inside it
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
            const candidateChild = path.join(mountRootDir, name);
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
      const parentDir = path.dirname(probeOrigPath);
      const toggledBase = toggleAsciiCase(path.basename(probeOrigPath));
      const toggledPath = path.join(parentDir, toggledBase);
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
        macVolumeCaseSensitivityCache.set(cacheKey, { timestamp: now, caseSensitive });
      }
      return { caseSensitive };
    }

    // 3. Empty volume fallback: `diskutil info -plist <mountPoint>`
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
        let caseSensitive = false;
        const csKeyMatch = plistOut.match(/<key>CaseSensitive<\/key>\s*<(true|false)\s*\/>/i);
        if (csKeyMatch) {
          caseSensitive = csKeyMatch[1].toLowerCase() === 'true';
        } else if (/Case-sensitive/i.test(plistOut)) {
          caseSensitive = true;
        }
        if (!hasCustomFsMocks) {
          macVolumeCaseSensitivityCache.set(cacheKey, { timestamp: now, caseSensitive });
        }
        return { caseSensitive };
      } catch {}
    }
  } catch {}

  return { caseSensitive: false };
}

/**
 * Honest async disk space inspection via `fs.promises.statfs`.
 * Walks up `path.dirname(targetPath)` until reaching an existing directory.
 * Never returns a fake 100 GiB fallback on failure.
 */
async function getDiskSpace(targetPath, /** @type {any} */ options = {}) {
  const homedir = options.homedir || os.homedir();
  let curr = toLocalFsPath(targetPath || homedir) || targetPath || homedir;

  try {
    const isRealHostOs =
      !options.homedir && (!options.platform || options.platform === process.platform);
    if (isRealHostOs || options.mountedVolumes || options.mountedDriveRoots) {
      if (isExternalVolumeUnmounted(curr, options)) {
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

    // Walk up parent directories until an existing directory/path is found
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
      effectivePlatform === 'darwin' ? checkVolumeCaseSensitivity(curr, options) : null;

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
 * Safely and quickly sum file sizes in a directory up to maxDepth
 */
function getDirectorySizeFast(dirPath, maxDepth = 4) {
  if (!dirPath || typeof dirPath !== 'string' || !fs.existsSync(dirPath)) return 0;
  let total = 0;

  function walk(curr, depth) {
    if (depth > maxDepth) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(curr, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = path.join(curr, entry.name);
      if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          total += Number(st.size || 0);
        } catch {}
      } else if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }

  try {
    const st = fs.statSync(dirPath);
    if (st.isFile()) return Number(st.size || 0);
    if (st.isDirectory()) walk(dirPath, 0);
  } catch {}

  return total;
}

module.exports = {
  normalizeWindowsDriveRoot,
  discoverWindowsLocalDrivesAsync,
  getCachedWindowsLocalDrives,
  isExternalVolumeUnmounted,
  hasWindowsGamingServicesInstalled,
  getDefaultXboxClientlessWinDir,
  getDefaultInstallDir,
  checkVolumeCaseSensitivity,
  getDiskSpace,
  getDirectorySizeFast,
};
