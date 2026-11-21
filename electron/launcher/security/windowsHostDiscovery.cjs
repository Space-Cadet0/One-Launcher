// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { execFile } = childProcess;

/** @type {{ app?: { getPath?: (name: string) => string } }} */
let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {
  // Non-Electron test or CLI context
}

/**
 * @typedef {{
 *   homedir: string,
 *   documents: string,
 *   savedGames: string,
 *   localAppData: string,
 *   roamingAppData: string,
 *   localLowAppData: string,
 * }} WindowsKnownFolders
 */

/** @type {WindowsKnownFolders | null} */
let cachedLiveWinKnownFolders = null;
let cachedLiveWinKnownFoldersAt = 0;
/** @type {Promise<WindowsKnownFolders | null> | null} */
let inFlightWinKnownFoldersRefresh = null;
const WIN_KNOWN_FOLDERS_TTL_MS = 5 * 60 * 1000;

function clearCachedWindowsKnownFolders() {
  cachedLiveWinKnownFolders = null;
  cachedLiveWinKnownFoldersAt = 0;
}

/**
 * @param {Record<string, any>} [options]
 */
function buildKnownFolderEnvHelpers(options = {}) {
  const rawOsHome = os.homedir();
  const rawEnvForHome =
    options.env && typeof options.env === 'object' ? options.env : process.env;
  const envUserProfile = String(
    rawEnvForHome.USERPROFILE || rawEnvForHome.userprofile || ''
  ).trim();
  const homedir =
    options.homedir ||
    options.userProfile ||
    (process.platform === 'win32' &&
    envUserProfile &&
    !envUserProfile.includes('\uFFFD') &&
    (!rawOsHome || rawOsHome.startsWith('/'))
      ? envUserProfile
      : rawOsHome && !rawOsHome.includes('\uFFFD')
        ? rawOsHome
        : envUserProfile || rawOsHome);
  const hasWinDriveInOverrides = Boolean(
    /^[A-Za-z]:[\\/]/.test(String(homedir)) ||
      String(homedir).startsWith('\\\\') ||
      /[A-Za-z]:[\\/]/.test(String(options.windowsRegistryOutput || '')) ||
      (options.windowsKnownFolders &&
        Object.values(options.windowsKnownFolders).some(
          (v) => typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'))
        )) ||
      (options.env &&
        Object.values(options.env).some(
          (v) => typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'))
        ))
  );
  const useWinSep =
    process.platform === 'win32' || options.platform === 'win32' || hasWinDriveInOverrides;
  const pathImpl = useWinSep ? path.win32 : path.posix;

  /**
   * @param {unknown} p
   * @returns {string}
   */
  const normalizeWinOrHost = (p) => {
    if (!p || typeof p !== 'string') return '';
    if (
      process.platform === 'win32' ||
      options.platform === 'win32' ||
      /^[A-Za-z]:[\\/]/.test(p) ||
      p.startsWith('\\\\')
    ) {
      return path.win32.normalize(p.replace(/\//g, '\\'));
    }
    return path.posix.normalize(p.replace(/\\/g, '/'));
  };

  const rawEnv =
    options.env && typeof options.env === 'object'
      ? options.env
      : !options.homedir
        ? process.env
        : {};

  /** @type {Map<string, string>} */
  const envLookup = new Map();
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v === 'string' && v.trim() && !v.includes('\uFFFD')) {
      envLookup.set(k.toUpperCase(), v.trim());
    }
  }
  if (!envLookup.has('USERPROFILE')) {
    envLookup.set('USERPROFILE', homedir);
  }
  if (!envLookup.has('HOMEPATH')) {
    envLookup.set('HOMEPATH', homedir);
  }
  const oneDriveBase =
    envLookup.get('ONEDRIVECONSUMER') ||
    envLookup.get('ONEDRIVE') ||
    envLookup.get('ONEDRIVECOMMERCIAL') ||
    '';
  if (oneDriveBase) {
    if (!envLookup.has('ONEDRIVE')) envLookup.set('ONEDRIVE', oneDriveBase);
    if (!envLookup.has('ONEDRIVECONSUMER')) envLookup.set('ONEDRIVECONSUMER', oneDriveBase);
    if (!envLookup.has('ONEDRIVECOMMERCIAL')) envLookup.set('ONEDRIVECOMMERCIAL', oneDriveBase);
  }
  if (!envLookup.has('LOCALAPPDATA')) {
    envLookup.set('LOCALAPPDATA', pathImpl.join(homedir, 'AppData', 'Local'));
  }
  if (!envLookup.has('APPDATA')) {
    envLookup.set('APPDATA', pathImpl.join(homedir, 'AppData', 'Roaming'));
  }

  /**
   * @param {unknown} val
   * @returns {string}
   */
  const expandWinEnvString = (val) => {
    if (!val || typeof val !== 'string') return '';
    if (val.includes('\uFFFD') || val.includes('\0')) return '';
    let unresolved = false;
    const expanded = val.trim().replace(/%([^%]+)%/g, (full, varName) => {
      const found = envLookup.get(String(varName || '').toUpperCase());
      if (found && !found.includes('\uFFFD')) return found;
      unresolved = true;
      return full;
    });
    if (unresolved || /%[^%]+%/.test(expanded) || expanded.includes('\uFFFD')) return '';
    return normalizeWinOrHost(expanded);
  };

  return { homedir, pathImpl, normalizeWinOrHost, envLookup, expandWinEnvString };
}

/**
 * @param {string} regOutput
 * @param {WindowsKnownFolders} current
 * @param {(val: unknown) => string} expandWinEnvString
 * @returns {WindowsKnownFolders}
 */
function applyRegistryOutputToKnownFolders(regOutput, current, expandWinEnvString) {
  if (!regOutput || typeof regOutput !== 'string') return current;
  const next = { ...current };
  const lines = regOutput.split(/\r?\n/);
  for (const rawLine of lines) {
    const m = rawLine.match(/^\s*(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (!m) continue;
    const keyName = m[1].trim().toLowerCase();
    const expandedVal = expandWinEnvString(m[2].trim());
    if (!expandedVal) continue;

    if (keyName === 'personal' || keyName === '{f42ee2d3-909f-4907-8871-4c22fc0bf756}') {
      next.documents = expandedVal;
    } else if (
      keyName === '{4c5c32ff-bb9d-43b0-b5b4-2d72e54eaaa4}' ||
      keyName === 'saved games'
    ) {
      next.savedGames = expandedVal;
    } else if (keyName === 'local appdata') {
      next.localAppData = expandedVal;
    } else if (keyName === 'appdata') {
      next.roamingAppData = expandedVal;
    } else if (
      keyName === '{a520a1a4-1780-4ff6-bd18-167343c5af16}' ||
      keyName === 'locallow'
    ) {
      next.localLowAppData = expandedVal;
    }
  }
  return next;
}

/**
 * @param {any} parsedJson
 * @param {WindowsKnownFolders} current
 * @param {(val: unknown) => string} expandWinEnvString
 * @param {(p: unknown) => string} normalizeWinOrHost
 * @returns {WindowsKnownFolders}
 */
function applyParsedKnownFoldersJson(parsedJson, current, expandWinEnvString, normalizeWinOrHost) {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    return current;
  }
  /**
   * @param {unknown} rawVal
   * @returns {string}
   */
  const sanitizeCandidate = (rawVal) => {
    if (typeof rawVal !== 'string') return '';
    const trimmed = rawVal.trim();
    if (!trimmed || trimmed.includes('\uFFFD') || trimmed.includes('\0')) {
      return '';
    }
    if (/%[^%]+%/.test(trimmed)) {
      return expandWinEnvString(trimmed);
    }
    return normalizeWinOrHost(trimmed);
  };

  const next = { ...current };
  const docs = sanitizeCandidate(
    parsedJson.Personal ?? parsedJson.Documents ?? parsedJson.documents
  );
  if (docs) next.documents = docs;

  const saved = sanitizeCandidate(
    parsedJson.SavedGames ??
      parsedJson.savedGames ??
      parsedJson['Saved Games'] ??
      parsedJson['{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}']
  );
  if (saved) next.savedGames = saved;

  const local = sanitizeCandidate(
    parsedJson.LocalAppData ?? parsedJson.localAppData ?? parsedJson['Local AppData']
  );
  if (local) next.localAppData = local;

  const roaming = sanitizeCandidate(
    parsedJson.AppData ?? parsedJson.RoamingAppData ?? parsedJson.roamingAppData
  );
  if (roaming) next.roamingAppData = roaming;

  const localLow = sanitizeCandidate(
    parsedJson.LocalLow ??
      parsedJson.LocalLowAppData ??
      parsedJson.localLowAppData ??
      parsedJson['{A520A1A4-1780-4FF6-BD18-167343c5AF16}']
  );
  if (localLow) next.localLowAppData = localLow;

  return next;
}

const WIN32_LOCAL_DRIVES_TTL_MS = 10_000;
/** @type {string[] | null} */
let cachedWin32LocalDrives = null;
let cachedWin32LocalDrivesAt = 0;
/** @type {Promise<string[]> | null} */
let inFlightWin32DriveProbe = null;

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
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function resolveFallbackWin32SystemDrives(options = {}) {
  const envObj =
    options && options.env && typeof options.env === 'object' ? options.env : process.env;
  const sysDriveRaw = String(
    options?.systemDrive || envObj?.SystemDrive || envObj?.SYSTEMDRIVE || 'C:'
  ).trim();
  const norm = normalizeWindowsDriveRoot(sysDriveRaw);
  return [norm || 'C:\\'];
}

/**
 * @param {unknown} stdout
 * @returns {string[]}
 */
function parseWindowsDriveDiscoveryOutput(stdout) {
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

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const dosMatch = rawLine.match(/\\DosDevices\\([A-Za-z]):\s+REG_/i);
    if (dosMatch && dosMatch[1]) {
      addRoot(`${dosMatch[1]}:`);
    }
  }
  if (roots.length > 0) return roots;

  if (trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (typeof item === 'string') {
          addRoot(item);
        } else if (item && typeof item === 'object') {
          addRoot(item.DeviceID || item.Name || item.Root);
        }
      }
      if (roots.length > 0) return roots;
    } catch {}
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const m = /^([A-Za-z]):\\?$/.exec(rawLine.trim());
    if (m) addRoot(`${m[1]}:`);
  }
  return roots;
}

function clearCachedWindowsLocalDrives() {
  cachedWin32LocalDrives = null;
  cachedWin32LocalDrivesAt = 0;
  inFlightWin32DriveProbe = null;
}

/**
 * Unified, process-wide Windows local drive discovery (`DriveType=2` removable & `DriveType=3` fixed),
 * skipping mapped SMB network shares (`DriveType=4`).
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<string[]>}
 */
function discoverWindowsLocalDrivesAsync(options = {}) {
  const platform = options.platform || process.platform;
  const hasCustomExec =
    typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function';
  if (platform !== 'win32' && !hasCustomExec) {
    return Promise.resolve([]);
  }

  const sysDrives = resolveFallbackWin32SystemDrives(options);
  const sysDriveRoot = sysDrives[0] || 'C:\\';

  if (Array.isArray(options.mountedDriveRoots)) {
    const explicit = options.mountedDriveRoots
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
    return Promise.resolve(explicit.length > 0 ? explicit : [sysDriveRoot]);
  }
  if (Array.isArray(options.localDrives)) {
    const explicit = options.localDrives
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
    return Promise.resolve(explicit.length > 0 ? explicit : [sysDriveRoot]);
  }

  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const now = Number(nowFn());
  const useSharedCache =
    !hasCustomExec && !options.bypassDriveCache && !options.forceRefresh;

  if (
    useSharedCache &&
    Array.isArray(cachedWin32LocalDrives) &&
    cachedWin32LocalDrives.length > 0 &&
    now - cachedWin32LocalDrivesAt < WIN32_LOCAL_DRIVES_TTL_MS
  ) {
    return Promise.resolve(cachedWin32LocalDrives.slice());
  }

  if (useSharedCache && inFlightWin32DriveProbe) {
    return inFlightWin32DriveProbe.then((list) => list.slice());
  }

  if (process.platform !== 'win32' && !hasCustomExec) {
    return Promise.resolve([sysDriveRoot]);
  }

  const execFileFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const probePromise = (async () => {
    /** @type {string[]} */
    let discovered = [];

    if (!hasCustomExec && process.platform === 'win32') {
      /** @type {string[]} */
      const regCandidates = await new Promise((resolve) => {
        try {
          execFile(
            'reg.exe',
            ['query', 'HKLM\\SYSTEM\\MountedDevices'],
            { encoding: 'utf8', timeout: 1500, windowsHide: true, maxBuffer: 256 * 1024 },
            (err, stdout) => {
              resolve(!err && stdout ? parseWindowsDriveDiscoveryOutput(String(stdout)) : []);
            }
          );
        } catch {
          resolve([]);
        }
      });

      if (regCandidates.length > 0) {
        const checks = await Promise.all(
          regCandidates.map(async (root) => {
            try {
              await fs.promises.access(root, fs.constants.F_OK);
              return root;
            } catch {
              return null;
            }
          })
        );
        discovered = /** @type {string[]} */ (checks.filter((r) => typeof r === 'string'));
      }
    }

    if (discovered.length === 0) {
      discovered = await new Promise((resolve) => {
        try {
          execFileFn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" | Select-Object -ExpandProperty DeviceID',
            ],
            { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              resolve(!err && stdout ? parseWindowsDriveDiscoveryOutput(String(stdout)) : []);
            }
          );
        } catch {
          resolve([]);
        }
      });
    }

    const result = discovered.length > 0 ? discovered : [sysDriveRoot];
    if (!result.includes(sysDriveRoot) && !hasCustomExec) {
      result.unshift(sysDriveRoot);
    }
    if (useSharedCache) {
      cachedWin32LocalDrives = result;
      cachedWin32LocalDrivesAt = Number(nowFn());
    }
    return result.slice();
  })().finally(() => {
    if (inFlightWin32DriveProbe === probePromise) {
      inFlightWin32DriveProbe = null;
    }
  });

  if (useSharedCache) {
    inFlightWin32DriveProbe = probePromise;
  }
  return probePromise;
}

/**
 * Return cached local Windows drives without blocking on A:\..Z:\ loops.
 *
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function getCachedWindowsLocalDrives(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];
  const sysDrives = resolveFallbackWin32SystemDrives(options);
  const sysDriveRoot = sysDrives[0] || 'C:\\';
  if (Array.isArray(options.mountedDriveRoots)) {
    const explicit = options.mountedDriveRoots
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
    return explicit.length > 0 ? explicit : [sysDriveRoot];
  }
  if (Array.isArray(options.localDrives)) {
    const explicit = options.localDrives
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
    return explicit.length > 0 ? explicit : [sysDriveRoot];
  }
  if (Array.isArray(cachedWin32LocalDrives) && cachedWin32LocalDrives.length > 0) {
    return cachedWin32LocalDrives.slice();
  }
  return [sysDriveRoot];
}

/**
 * Synchronous accessor for local Windows drives (`DriveType=2` & `DriveType=3`).
 *
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function getKnownWindowsLocalDrivesSync(options = {}) {
  if (Array.isArray(options.localDrives)) {
    return options.localDrives
      .map((/** @type {any} */ d) => String(d || '').trim())
      .filter(Boolean)
      .map((/** @type {string} */ d) => (/^[A-Za-z]:$/.test(d) ? `${d.toUpperCase()}\\` : d));
  }
  if (Array.isArray(options.mountedDriveRoots)) {
    return options.mountedDriveRoots
      .map((/** @type {any} */ d) => normalizeWindowsDriveRoot(d))
      .filter(Boolean);
  }

  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const now = Number(nowFn());
  const customExecFileSync =
    typeof options.execFileSyncFn === 'function'
      ? options.execFileSyncFn
      : typeof options.execFileSyncImpl === 'function'
        ? options.execFileSyncImpl
        : null;

  if (
    customExecFileSync === null &&
    !options.bypassDriveCache &&
    Array.isArray(cachedWin32LocalDrives) &&
    cachedWin32LocalDrives.length > 0
  ) {
    if (now - cachedWin32LocalDrivesAt >= WIN32_LOCAL_DRIVES_TTL_MS) {
      discoverWindowsLocalDrivesAsync(options).catch(() => {});
    }
    return cachedWin32LocalDrives.slice();
  }

  const targetPlatform = options.platform || process.platform;
  if (targetPlatform !== 'win32' || (process.platform !== 'win32' && customExecFileSync === null)) {
    return resolveFallbackWin32SystemDrives(options);
  }

  const useSharedCache = customExecFileSync === null && !options.bypassDriveCache;

  if (customExecFileSync === null && process.platform === 'win32') {
    try {
      const regOut = childProcess.execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SYSTEM\\MountedDevices'],
        { encoding: 'utf8', timeout: 800, windowsHide: true, maxBuffer: 256 * 1024 }
      );
      const regDrives = parseWindowsDriveDiscoveryOutput(regOut).filter((root) => {
        try {
          return fs.existsSync(root);
        } catch {
          return false;
        }
      });
      if (regDrives.length > 0) {
        if (useSharedCache) {
          cachedWin32LocalDrives = regDrives;
          cachedWin32LocalDrivesAt = now;
        }
        return regDrives.slice();
      }
    } catch {
      // Fall through
    }
  }

  const syncRunner = customExecFileSync || childProcess.execFileSync;
  try {
    const stdout = syncRunner(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" | Select-Object -ExpandProperty DeviceID',
      ],
      {
        timeout: 1500,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
      }
    );
    const parsed = parseWindowsDriveDiscoveryOutput(String(stdout || ''));
    const result = parsed.length > 0 ? parsed : resolveFallbackWin32SystemDrives(options);
    if (useSharedCache) {
      cachedWin32LocalDrives = result;
      cachedWin32LocalDrivesAt = now;
    }
    return result.slice();
  } catch {
    const fallback = resolveFallbackWin32SystemDrives(options);
    if (useSharedCache) {
      cachedWin32LocalDrives = fallback;
      cachedWin32LocalDrivesAt = now;
    }
    return fallback.slice();
  }
}

/**
 * Asynchronously refresh Windows Known Folders via non-blocking `reg.exe` (`execFile`).
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<WindowsKnownFolders | null>}
 */
function refreshHostWindowsKnownFoldersAsync(options = {}) {
  const hasInjectedExec =
    typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function';
  if (process.platform !== 'win32' && !hasInjectedExec) {
    return Promise.resolve(resolveHostWindowsKnownFolders(options));
  }
  if (!hasInjectedExec && inFlightWinKnownFoldersRefresh) {
    return inFlightWinKnownFoldersRefresh;
  }
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (isVitest && !options.allowRegistryDiscoveryInTest && !hasInjectedExec) {
    return Promise.resolve(
      cachedLiveWinKnownFolders
        ? { ...cachedLiveWinKnownFolders }
        : resolveHostWindowsKnownFolders(options)
    );
  }

  const execAsync =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  /** @type {Promise<WindowsKnownFolders | null>} */
  const refreshPromise = new Promise((resolve) => {
    try {
      execAsync(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        ],
        { encoding: 'utf8', timeout: 2000, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (!err && stdout) {
            const { homedir, pathImpl, normalizeWinOrHost, envLookup, expandWinEnvString } =
              buildKnownFolderEnvHelpers(options);
            /** @type {WindowsKnownFolders} */
            let base = {
              homedir: normalizeWinOrHost(homedir),
              documents: normalizeWinOrHost(pathImpl.join(homedir, 'Documents')),
              savedGames: normalizeWinOrHost(pathImpl.join(homedir, 'Saved Games')),
              localAppData:
                expandWinEnvString(envLookup.get('LOCALAPPDATA') || '') ||
                normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Local')),
              roamingAppData:
                expandWinEnvString(envLookup.get('APPDATA') || '') ||
                normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Roaming')),
              localLowAppData: normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'LocalLow')),
            };
            try {
              const electronDocs = electron.app?.getPath?.('documents');
              if (
                typeof electronDocs === 'string' &&
                electronDocs.trim() &&
                !electronDocs.includes('\uFFFD')
              ) {
                base.documents = normalizeWinOrHost(electronDocs.trim());
              }
              const electronAppData = electron.app?.getPath?.('appData');
              if (
                typeof electronAppData === 'string' &&
                electronAppData.trim() &&
                !electronAppData.includes('\uFFFD')
              ) {
                base.roamingAppData = normalizeWinOrHost(electronAppData.trim());
              }
            } catch {}
            base = applyRegistryOutputToKnownFolders(String(stdout), base, expandWinEnvString);
            if (!hasInjectedExec) {
              cachedLiveWinKnownFolders = base;
              cachedLiveWinKnownFoldersAt = Date.now();
            }
            resolve({ ...base });
            return;
          }
          resolve(cachedLiveWinKnownFolders ? { ...cachedLiveWinKnownFolders } : null);
        }
      );
    } catch {
      resolve(cachedLiveWinKnownFolders ? { ...cachedLiveWinKnownFolders } : null);
    }
  }).finally(() => {
    if (inFlightWinKnownFoldersRefresh === refreshPromise) {
      inFlightWinKnownFoldersRefresh = null;
    }
  });

  if (!hasInjectedExec) {
    inFlightWinKnownFoldersRefresh = refreshPromise;
  }
  return refreshPromise;
}

/**
 * Resolve Windows Known Folders (`Documents`, `Saved Games`, `AppData\Local`, `AppData\Roaming`,
 * `AppData\LocalLow`) with an in-memory cache so hot paths never spawn subprocesses repeatedly.
 *
 * @param {Record<string, any>} [options]
 * @returns {any}
 */
function resolveHostWindowsKnownFolders(options = {}) {
  const customSyncFn =
    typeof options.execFileSyncFn === 'function'
      ? options.execFileSyncFn
      : typeof options.execFileSyncImpl === 'function'
        ? options.execFileSyncImpl
        : null;
  const hasExplicitSandboxHomedir = Boolean(
    options.homedir && options.homedir !== os.homedir()
  );
  const hasCustomContext = Boolean(
    hasExplicitSandboxHomedir ||
      options.userProfile ||
      options.windowsKnownFolders ||
      options.windowsRegistryOutput !== undefined ||
      options.env ||
      customSyncFn !== null
  );

  if (
    !hasCustomContext &&
    process.platform === 'win32' &&
    cachedLiveWinKnownFolders &&
    Date.now() - cachedLiveWinKnownFoldersAt < WIN_KNOWN_FOLDERS_TTL_MS
  ) {
    return { ...cachedLiveWinKnownFolders };
  }

  const { homedir, pathImpl, normalizeWinOrHost, envLookup, expandWinEnvString } =
    buildKnownFolderEnvHelpers(options);

  /** @type {WindowsKnownFolders} */
  let current = {
    homedir: normalizeWinOrHost(homedir),
    documents: normalizeWinOrHost(pathImpl.join(homedir, 'Documents')),
    savedGames: normalizeWinOrHost(pathImpl.join(homedir, 'Saved Games')),
    localAppData:
      expandWinEnvString(envLookup.get('LOCALAPPDATA') || '') ||
      normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Local')),
    roamingAppData:
      expandWinEnvString(envLookup.get('APPDATA') || '') ||
      normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Roaming')),
    localLowAppData: normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'LocalLow')),
  };

  if (
    (process.platform === 'win32' || customSyncFn !== null) &&
    !hasExplicitSandboxHomedir &&
    options.windowsRegistryOutput === undefined &&
    !options.windowsKnownFolders
  ) {
    try {
      const electronDocs = electron.app?.getPath?.('documents');
      if (typeof electronDocs === 'string' && electronDocs.trim() && !electronDocs.includes('\uFFFD')) {
        current.documents = normalizeWinOrHost(electronDocs.trim());
      }
      const electronAppData = electron.app?.getPath?.('appData');
      if (
        typeof electronAppData === 'string' &&
        electronAppData.trim() &&
        !electronAppData.includes('\uFFFD')
      ) {
        current.roamingAppData = normalizeWinOrHost(electronAppData.trim());
      }
    } catch {}

    const execSyncImpl = customSyncFn || childProcess.execFileSync;
    const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
    let resolvedViaReg = false;

    try {
      const rawRegOut = execSyncImpl(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        ],
        {
          encoding: 'utf8',
          timeout: 800,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const regStr = (
        typeof rawRegOut === 'string'
          ? rawRegOut
          : Buffer.isBuffer(rawRegOut)
            ? rawRegOut.toString('utf8')
            : String(rawRegOut ?? '')
      )
        .replace(/^\uFEFF/, '')
        .trim();

      if (regStr.startsWith('{')) {
        const parsedJson = JSON.parse(regStr);
        current = applyParsedKnownFoldersJson(
          parsedJson,
          current,
          expandWinEnvString,
          normalizeWinOrHost
        );
        resolvedViaReg = true;
      } else if (/REG_(?:EXPAND_)?SZ/i.test(regStr)) {
        current = applyRegistryOutputToKnownFolders(regStr, current, expandWinEnvString);
        resolvedViaReg = true;
      }
    } catch {}

    if (!resolvedViaReg && (isVitest || customSyncFn !== null)) {
      const psKnownFoldersScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$sh = New-Object -ComObject Shell.Application',
        '$sg = try { $n = $sh.Namespace("shell:SavedGames"); if ($n) { $n.Self.Path } else { "" } } catch { "" }',
        '$ll = try { $n = $sh.Namespace("shell:LocalAppDataLow"); if ($n) { $n.Self.Path } else { "" } } catch { "" }',
        '@{',
        "  Personal = [Environment]::GetFolderPath('Personal')",
        '  SavedGames = $sg',
        "  LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')",
        "  AppData = [Environment]::GetFolderPath('ApplicationData')",
        '  LocalLow = $ll',
        '} | ConvertTo-Json -Compress',
      ].join('; ');

      try {
        const rawPsOut = execSyncImpl(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            psKnownFoldersScript,
          ],
          {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );
        const stdoutStr = (
          typeof rawPsOut === 'string'
            ? rawPsOut
            : Buffer.isBuffer(rawPsOut)
              ? rawPsOut.toString('utf8')
              : String(rawPsOut ?? '')
        )
          .replace(/^\uFEFF/, '')
          .trim();

        if (stdoutStr.startsWith('{')) {
          const parsedJson = JSON.parse(stdoutStr);
          current = applyParsedKnownFoldersJson(
            parsedJson,
            current,
            expandWinEnvString,
            normalizeWinOrHost
          );
        } else if (/REG_(?:EXPAND_)?SZ/i.test(stdoutStr)) {
          current = applyRegistryOutputToKnownFolders(stdoutStr, current, expandWinEnvString);
        }
      } catch {}
    }
  }

  if (typeof options.windowsRegistryOutput === 'string' && options.windowsRegistryOutput) {
    current = applyRegistryOutputToKnownFolders(
      options.windowsRegistryOutput,
      current,
      expandWinEnvString
    );
  }

  if (options.windowsKnownFolders && typeof options.windowsKnownFolders === 'object') {
    const kf = options.windowsKnownFolders;
    if (kf.documents) {
      current.documents = expandWinEnvString(kf.documents) || normalizeWinOrHost(kf.documents);
    }
    if (kf.savedGames) {
      current.savedGames = expandWinEnvString(kf.savedGames) || normalizeWinOrHost(kf.savedGames);
    }
    if (kf.localAppData) {
      current.localAppData =
        expandWinEnvString(kf.localAppData) || normalizeWinOrHost(kf.localAppData);
    }
    if (kf.roamingAppData) {
      current.roamingAppData =
        expandWinEnvString(kf.roamingAppData) || normalizeWinOrHost(kf.roamingAppData);
    }
    if (kf.localLowAppData) {
      current.localLowAppData =
        expandWinEnvString(kf.localLowAppData) || normalizeWinOrHost(kf.localLowAppData);
    }
  }

  if (!hasCustomContext && process.platform === 'win32') {
    cachedLiveWinKnownFolders = current;
    cachedLiveWinKnownFoldersAt = Date.now();
  }

  return { ...current };
}

module.exports = {
  discoverWindowsLocalDrivesAsync,
  getCachedWindowsLocalDrives,
  getKnownWindowsLocalDrivesSync,
  clearCachedWindowsLocalDrives,
  resolveHostWindowsKnownFolders,
  refreshHostWindowsKnownFoldersAsync,
  clearCachedWindowsKnownFolders,
};
