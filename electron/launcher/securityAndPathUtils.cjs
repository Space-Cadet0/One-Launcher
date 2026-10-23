'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {
  // Non-Electron test or CLI context
}

let userDataDirResolver = null;

function setSecurityUserDataDirResolver(fn) {
  if (typeof fn === 'function' || fn === null) {
    userDataDirResolver = fn;
  }
}

function resolveEffectiveUserDataDir(options = {}) {
  if (options && typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    return options.userDataDir.trim();
  }
  if (typeof userDataDirResolver === 'function') {
    try {
      const dir = userDataDirResolver(options?.userDataDir);
      if (dir) return dir;
    } catch {
      // Fallback below
    }
  }
  if (options && typeof options.homedir === 'string' && options.homedir.trim()) {
    return path.join(options.homedir.trim(), '.one-launcher');
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`, '.one-launcher');
  }
  try {
    if (electron.app && typeof electron.app.getPath === 'function') {
      const p = electron.app.getPath('userData');
      if (p) return p;
    }
  } catch {
    // Fallback below
  }
  return path.join(os.homedir(), '.one-launcher');
}

/**
 * Atomically write non-secret JSON/config file content via temporary file + rename.
 */
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    diagLog.warn('fs.atomicWriteFallback', err, { filePath });
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore temp cleanup failure
    }
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

/**
 * Atomically write sensitive credential/session files (`user.json`, `auth.json`, tombstones)
 * with strict owner-only directory (`0o700`) and file (`0o600`) permissions on POSIX, plus
 * non-blocking `icacls` inheritance-stripped owner ACL hardening on Windows (`win32`).
 */
function atomicWriteSecureFileSync(filePath, content, options = {}) {
  const targetPlatform = options.platform || process.platform;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (targetPlatform !== 'win32' && process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (chmodDirErr) {
      diagLog.debug('security.chmodDir', chmodDirErr, { dir });
    }
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch (chmodTmpErr) {
        diagLog.debug('security.chmodTmp', chmodTmpErr, { tmpPath });
      }
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    diagLog.warn('security.atomicWriteFallback', err, { filePath });
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore temp cleanup error
    }
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (chmodFileErr) {
      diagLog.debug('security.chmodFile', chmodFileErr, { filePath });
    }
  }

  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (targetPlatform === 'win32' && (!isVitest || options.enforceWindowsAclInTest === true)) {
    let username = String(options.username || process.env.USERNAME || '').trim();
    if (!username) {
      try {
        username = String(os.userInfo().username || '').trim();
      } catch {
        username = '';
      }
    }
    if (username) {
      const execFileImpl =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : execFile;
      try {
        execFileImpl(
          'icacls',
          [filePath, '/inheritance:r', '/grant:r', `${username}:(F)`],
          { timeout: 3000, windowsHide: true },
          (aclErr) => {
            if (aclErr) {
              diagLog.debug('security.icacls', aclErr, { filePath });
            }
          }
        );
      } catch (aclInvokeErr) {
        diagLog.debug('security.icaclsInvoke', aclInvokeErr, { filePath });
      }
    }
  }
}

/**
 * Verify that `resolvedPath` is strictly inside or equal to `anchorRoot` with zero `..` escapes,
 * drive-letter switches, UNC switches, or NUL-byte injections across both Windows and POSIX semantics.
 */
function isContainedWithinRoot(anchorRoot, resolvedPath, platform = process.platform) {
  if (
    !anchorRoot ||
    !resolvedPath ||
    typeof anchorRoot !== 'string' ||
    typeof resolvedPath !== 'string'
  ) {
    return false;
  }
  if (anchorRoot.includes('\0') || resolvedPath.includes('\0')) {
    return false;
  }

  const trimmedAnchor = anchorRoot.trim();
  const trimmedTarget = resolvedPath.trim();
  if (!trimmedAnchor || !trimmedTarget) {
    return false;
  }

  const useWinSemantics =
    platform === 'win32' ||
    /^[A-Za-z]:[\\/]/.test(trimmedAnchor) ||
    /^[A-Za-z]:[\\/]/.test(trimmedTarget) ||
    trimmedAnchor.startsWith('\\\\') ||
    trimmedTarget.startsWith('\\\\');

  if (useWinSemantics) {
    const winAnchor = path.win32.normalize(trimmedAnchor.replace(/\//g, '\\'));
    const winTarget = path.win32.normalize(trimmedTarget.replace(/\//g, '\\'));
    if (!path.win32.isAbsolute(winAnchor) || !path.win32.isAbsolute(winTarget)) {
      return false;
    }
    const rel = path.win32.relative(winAnchor.toLowerCase(), winTarget.toLowerCase());
    if (rel === '') return true;
    if (rel.startsWith('..') || path.win32.isAbsolute(rel)) {
      return false;
    }
    return true;
  }

  const posixAnchor = path.posix.normalize(trimmedAnchor.replace(/\\/g, '/'));
  const posixTarget = path.posix.normalize(trimmedTarget.replace(/\\/g, '/'));
  if (!posixAnchor.startsWith('/') || !posixTarget.startsWith('/')) {
    return false;
  }
  const rel = path.posix.relative(posixAnchor, posixTarget);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    return false;
  }
  return true;
}

// ============================================================================
// Account Logout Tombstones (`one_launcher_disconnected_stores.json`)
// ============================================================================

const tombstoneCacheByFile = new Map();

function normalizeStoreKey(store) {
  return String(store || '')
    .trim()
    .toLowerCase();
}

function getDisconnectedStoresFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'one_launcher_disconnected_stores.json');
}

function readDisconnectedStoresObject(options = {}) {
  const filePath = getDisconnectedStoresFilePath(options);
  try {
    if (!fs.existsSync(filePath)) {
      tombstoneCacheByFile.delete(filePath);
      return { stores: {} };
    }
    const st = fs.statSync(filePath);
    const cached = tombstoneCacheByFile.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized =
      parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object'
        ? parsed
        : { stores: {} };
    tombstoneCacheByFile.set(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      data: normalized,
    });
    return normalized;
  } catch (err) {
    diagLog.warn('security.readDisconnectedStores', err, { filePath });
    return { stores: {} };
  }
}

function isStoreDisconnectedTombstoned(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return false;
  const parsed = readDisconnectedStoresObject(options);
  return Boolean(parsed?.stores?.[normStore]?.disconnected === true);
}

function clearStoreDisconnectedTombstone(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return { success: false };
  const filePath = getDisconnectedStoresFilePath(options);
  const current = readDisconnectedStoresObject(options);
  if (current?.stores && Object.prototype.hasOwnProperty.call(current.stores, normStore)) {
    const nextStores = { ...current.stores };
    delete nextStores[normStore];
    const nextPayload = { stores: nextStores, updatedAt: new Date().toISOString() };
    try {
      atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
      tombstoneCacheByFile.delete(filePath);
    } catch (err) {
      diagLog.warn('security.clearTombstone', err, { store: normStore, filePath });
    }
  }
  return { success: true, store: normStore, tombstoned: false };
}

/**
 * Purge One Launcher's helper CLI credential files (`legendaryConfig/legendary/user.json`,
 * `gog_store/auth.json`) AND persist a logout tombstone so external Heroic/Legendary files
 * never silently resurrect a disconnected account on next startup or launch.
 */
function purgeStoreHelperCredentials(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return { success: false, error: 'Missing store identifier' };

  const userDataDir = resolveEffectiveUserDataDir(options);
  const filePath = getDisconnectedStoresFilePath(options);
  const current = readDisconnectedStoresObject(options);
  const nextPayload = {
    stores: {
      ...(current?.stores || {}),
      [normStore]: {
        disconnected: true,
        disconnectedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };

  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    tombstoneCacheByFile.delete(filePath);
  } catch (err) {
    diagLog.warn('security.writeTombstone', err, { store: normStore, filePath });
  }

  const unlinkedPaths = [];
  const candidateFiles = [];
  if (normStore === 'epic') {
    candidateFiles.push(path.join(userDataDir, 'legendaryConfig', 'legendary', 'user.json'));
    if (options.legendaryConfigDir) {
      candidateFiles.push(path.join(options.legendaryConfigDir, 'user.json'));
    }
    if (options.legendaryConfigPath) {
      candidateFiles.push(path.join(options.legendaryConfigPath, 'user.json'));
    }
  } else if (normStore === 'gog') {
    candidateFiles.push(
      path.join(userDataDir, 'gog_store', 'auth.json'),
      path.join(userDataDir, 'gogdlConfig', 'auth.json')
    );
    if (options.gogAuthPath) {
      candidateFiles.push(options.gogAuthPath);
    }
  }

  for (const credFile of candidateFiles) {
    if (!credFile) continue;
    try {
      if (fs.existsSync(credFile)) {
        fs.unlinkSync(credFile);
        unlinkedPaths.push(credFile);
      }
    } catch (err) {
      diagLog.warn('security.purgeHelperCredFile', err, { store: normStore, credFile });
    }
  }

  return {
    success: true,
    store: normStore,
    tombstoned: true,
    unlinkedPaths,
  };
}

// ============================================================================
// Official Epic Games Launcher Import Registry (`one_launcher_epic_imports.json`)
// ============================================================================

function getEpicImportsFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'one_launcher_epic_imports.json');
}

function getImportedEpicInstalls(options = {}) {
  const filePath = getEpicImportsFilePath(options);
  try {
    if (!fs.existsSync(filePath)) return { imports: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object') {
      return parsed;
    }
  } catch (err) {
    diagLog.warn('security.readEpicImports', err, { filePath });
  }
  return { imports: {} };
}

function recordImportedEpicInstall(appNameOrEntry, installPathOrOptions, maybeOptions = {}) {
  let rawApp = '';
  let rawPath = '';
  let rawSource = '';
  let options = maybeOptions || {};

  if (appNameOrEntry && typeof appNameOrEntry === 'object') {
    rawApp = appNameOrEntry.appName || appNameOrEntry.app_name || '';
    rawPath = appNameOrEntry.installPath || appNameOrEntry.install_path || '';
    rawSource = appNameOrEntry.source || '';
    options =
      installPathOrOptions && typeof installPathOrOptions === 'object' ? installPathOrOptions : {};
  } else {
    rawApp = appNameOrEntry;
    rawPath = installPathOrOptions;
  }

  const cleanApp = String(rawApp || '').trim();
  const cleanPath = String(rawPath || '').trim();
  if (!cleanApp && !cleanPath) return false;
  const recordKey = cleanApp || cleanPath;
  const filePath = getEpicImportsFilePath(options);
  try {
    const existing = getImportedEpicInstalls(options);
    const prev = existing.imports ? existing.imports[recordKey] : null;
    if (
      prev &&
      prev.appName === cleanApp &&
      prev.installPath === cleanPath &&
      (!rawSource || prev.source === rawSource)
    ) {
      return true;
    }
    const next = {
      imports: {
        ...(existing.imports || {}),
        [recordKey]: {
          appName: cleanApp,
          installPath: cleanPath,
          ...(rawSource ? { source: String(rawSource) } : {}),
          importedAt: prev?.importedAt || new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(filePath, JSON.stringify(next, null, 2));
    return true;
  } catch (err) {
    diagLog.warn('security.recordEpicImport', err, { appName: cleanApp, installPath: cleanPath });
    return false;
  }
}

// ============================================================================
// Windows Known Folder Redirection (OneDrive Documents / Saved Games)
// ============================================================================

let cachedLiveWinKnownFolders = null;
let cachedLiveWinKnownFoldersAt = 0;
const WIN_KNOWN_FOLDERS_TTL_MS = 5 * 60 * 1000;

function clearCachedWindowsKnownFolders() {
  cachedLiveWinKnownFolders = null;
  cachedLiveWinKnownFoldersAt = 0;
}

/**
 * Resolve Windows Known Folders (`Documents`, `Saved Games`, `AppData\Local`, `AppData\Roaming`,
 * `AppData\LocalLow`), honoring Windows 10/11 OneDrive Folder Backup redirection registered in
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders` and Electron's
 * `SHGetKnownFolderPath` (`app.getPath('documents')`), while remaining 100% deterministic in
 * cross-OS unit tests via `options.windowsKnownFolders` and `options.windowsRegistryOutput`.
 */
function resolveHostWindowsKnownFolders(options = {}) {
  const hasCustomContext = Boolean(
    options.homedir ||
      options.windowsKnownFolders ||
      options.windowsRegistryOutput !== undefined ||
      options.env
  );

  if (
    !hasCustomContext &&
    process.platform === 'win32' &&
    cachedLiveWinKnownFolders &&
    Date.now() - cachedLiveWinKnownFoldersAt < WIN_KNOWN_FOLDERS_TTL_MS
  ) {
    return { ...cachedLiveWinKnownFolders };
  }

  const homedir = options.homedir || os.homedir();
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
  const useWinSep = process.platform === 'win32' || hasWinDriveInOverrides;
  const pathImpl = useWinSep ? path.win32 : path.posix;
  const normalizeWinOrHost = (p) => {
    if (!p || typeof p !== 'string') return '';
    if (
      process.platform === 'win32' ||
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

  const envLookup = new Map();
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v === 'string' && v.trim()) {
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

  const expandWinEnvString = (val) => {
    if (!val || typeof val !== 'string') return '';
    let unresolved = false;
    const expanded = val.trim().replace(/%([^%]+)%/g, (full, varName) => {
      const found = envLookup.get(String(varName || '').toUpperCase());
      if (found) return found;
      unresolved = true;
      return full;
    });
    if (unresolved || /%[^%]+%/.test(expanded)) return '';
    return normalizeWinOrHost(expanded);
  };

  let documents = normalizeWinOrHost(pathImpl.join(homedir, 'Documents'));
  let savedGames = normalizeWinOrHost(pathImpl.join(homedir, 'Saved Games'));
  let localAppData =
    expandWinEnvString(envLookup.get('LOCALAPPDATA') || '') ||
    normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Local'));
  let roamingAppData =
    expandWinEnvString(envLookup.get('APPDATA') || '') ||
    normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'Roaming'));
  let localLowAppData = normalizeWinOrHost(pathImpl.join(homedir, 'AppData', 'LocalLow'));

  // 1. Live Electron SHGetKnownFolderPath ('documents') when running on real Windows without overrides
  if (
    process.platform === 'win32' &&
    !options.homedir &&
    options.windowsRegistryOutput === undefined &&
    !options.windowsKnownFolders
  ) {
    try {
      const electronDocs = electron.app?.getPath?.('documents');
      if (typeof electronDocs === 'string' && electronDocs.trim()) {
        documents = normalizeWinOrHost(electronDocs.trim());
      }
    } catch {
      // Fallback to registry / homedir
    }
  }

  // 2. Parse HKCU User Shell Folders registry output (mocked in tests or queried via reg.exe on win32)
  let regOutput =
    typeof options.windowsRegistryOutput === 'string' ? options.windowsRegistryOutput : '';
  if (
    !regOutput &&
    options.windowsRegistryOutput === undefined &&
    process.platform === 'win32' &&
    !options.homedir &&
    !options.windowsKnownFolders
  ) {
    try {
      regOutput = execFileSync(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        ],
        {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }
      );
    } catch (regErr) {
      diagLog.debug('knownFolders.regQuery', regErr);
    }
  }

  if (regOutput) {
    const lines = regOutput.split(/\r?\n/);
    for (const rawLine of lines) {
      const m = rawLine.match(/^\s*(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
      if (!m) continue;
      const keyName = m[1].trim().toLowerCase();
      const expandedVal = expandWinEnvString(m[2].trim());
      if (!expandedVal) continue;

      if (keyName === 'personal' || keyName === '{f42ee2d3-909f-4907-8871-4c22fc0bf756}') {
        documents = expandedVal;
      } else if (
        keyName === '{4c5c32ff-bb9d-43b0-b5b4-2d72e54eaaa4}' ||
        keyName === 'saved games'
      ) {
        savedGames = expandedVal;
      } else if (keyName === 'local appdata') {
        localAppData = expandedVal;
      } else if (keyName === 'appdata') {
        roamingAppData = expandedVal;
      } else if (
        keyName === '{a520a1a4-1780-4ff6-bd18-167343c5af16}' ||
        keyName === 'locallow'
      ) {
        localLowAppData = expandedVal;
      }
    }
  }

  // 3. Explicit caller overrides (`options.windowsKnownFolders`)
  if (options.windowsKnownFolders && typeof options.windowsKnownFolders === 'object') {
    const kf = options.windowsKnownFolders;
    if (kf.documents) {
      documents = expandWinEnvString(kf.documents) || normalizeWinOrHost(kf.documents);
    }
    if (kf.savedGames) {
      savedGames = expandWinEnvString(kf.savedGames) || normalizeWinOrHost(kf.savedGames);
    }
    if (kf.localAppData) {
      localAppData = expandWinEnvString(kf.localAppData) || normalizeWinOrHost(kf.localAppData);
    }
    if (kf.roamingAppData) {
      roamingAppData =
        expandWinEnvString(kf.roamingAppData) || normalizeWinOrHost(kf.roamingAppData);
    }
    if (kf.localLowAppData) {
      localLowAppData =
        expandWinEnvString(kf.localLowAppData) || normalizeWinOrHost(kf.localLowAppData);
    }
  }

  const result = {
    homedir: normalizeWinOrHost(homedir),
    documents,
    savedGames,
    localAppData,
    roamingAppData,
    localLowAppData,
  };

  if (!hasCustomContext && process.platform === 'win32') {
    cachedLiveWinKnownFolders = result;
    cachedLiveWinKnownFoldersAt = Date.now();
  }

  return { ...result };
}

module.exports = {
  setSecurityUserDataDirResolver,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
  getDisconnectedStoresFilePath,
  isStoreDisconnectedTombstoned,
  clearStoreDisconnectedTombstone,
  purgeStoreHelperCredentials,
  getImportedEpicInstalls,
  recordImportedEpicInstall,
  resolveHostWindowsKnownFolders,
  clearCachedWindowsKnownFolders,
};
