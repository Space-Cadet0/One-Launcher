const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const https = require('node:https');
const http = require('node:http');
const { spawn, exec, execFile, execFileSync, execSync } = require('node:child_process');

const {
  diagLog,
  getDiagnosticLogPath,
  setDiagnosticUserDataGetter,
} = require('./utils/diagnosticLogger.cjs');
const {
  sanitizeLaunchMethod,
  resolveEffectiveLifecyclePolicy,
  resolveEffectiveLaunchPolicy,
} = require('./launcher/launchPolicyResolver.cjs');
const {
  isProcessAlive,
  waitForProcessExit,
  extractMatchedPidFromProcessOutput,
  signalSubprocessTree,
  execCliWithTreeTimeout,
} = require('./launcher/processTreeUtils.cjs');
const {
  setSecurityUserDataDirResolver,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
  isStoreDisconnectedTombstoned,
  clearStoreDisconnectedTombstone,
  purgeStoreHelperCredentials,
  getImportedEpicInstalls,
  recordImportedEpicInstall,
  resolveHostWindowsKnownFolders,
  clearCachedWindowsKnownFolders,
} = require('./launcher/securityAndPathUtils.cjs');
const {
  readWinePrefixShellFolders,
  resolveBottleSteamExe,
  sandboxWinePrefixUserFolders,
  sandboxWinePrefixUserFoldersAsync,
} = require('./launcher/wineAndCrossOverManager.cjs');
const {
  inspectWindowsExecutableHeader,
  inspectMacMachOHeader,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  parseSteamContentLogForApp,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
} = require('./launcher/binaryAndManifestInspectors.cjs');
const {
  GOG_GALAXY_LAUNCHER_CLIENT_ID,
  normalizePosixUtf8Locale,
  purgeOsMetadataAndCountRealFilesSync,
  createCloudSaveRollingBackup,
  createCloudSaveRollingBackupAsync,
  resolveGogCloudSaveLocations,
  resolveEpicSavePathTemplate,
  pruneGogCloudConfigsMap,
  pruneCloudSaveStateForGame,
  buildCloudSyncTelemetryPayload,
  createCloudSaveRunner,
} = require('./launcher/cloudSaveEngine.cjs');

let electron = {};
try {
  const reqElectron = require('electron');
  if (reqElectron && typeof reqElectron === 'object') {
    electron = reqElectron;
  }
} catch {}

let storeSync = null;
try {
  storeSync = require('./storeSync.cjs');
} catch {}

let mainWindowGetter = () => null;
let configuredUserDataDir = null;

setDiagnosticUserDataGetter(() => getUserDataDir());
setSecurityUserDataDirResolver((customDir) => getUserDataDir(customDir));

// Active game sessions keyed by gameId
const activeSessions = new Map();

// Concurrency & post-session race barriers
const inFlightPostSessionByGame = new Map();
const pendingBottleLaunches = new Map();
const inFlightPostSessionByBottle = new Map();
const pendingEphemeralShutdowns = new Map();
const pendingStorefrontLaunches = new Map();

// Download queue keyed by taskId
const downloadQueueMap = new Map();
const downloadControllers = new Map();

// Local event listeners for testing and internal hooks
const sessionListeners = new Set();
const downloadListeners = new Set();
let sessionLifecycleHook = null;
let epicAuthRecoveryHook = null;

/**
 * Configure launcher engine with Electron mainWindow getter and optional overrides
 */
function setMainWindowGetter(fn) {
  if (typeof fn === 'function') {
    mainWindowGetter = fn;
  }
}

function setSessionLifecycleHook(fn) {
  sessionLifecycleHook = typeof fn === 'function' ? fn : null;
}

function setEpicAuthRecoveryHook(fn) {
  epicAuthRecoveryHook = typeof fn === 'function' ? fn : null;
}

function setUserDataDir(dirPath) {
  configuredUserDataDir = dirPath;
}

function onSessionUpdated(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function onDownloadUpdated(listener) {
  downloadListeners.add(listener);
  return () => downloadListeners.delete(listener);
}

function getPendingSessionsFilePath(options = {}) {
  const customDir =
    options && typeof options === 'object'
      ? options.userDataDir || options.baseDir
      : typeof options === 'string'
        ? options
        : undefined;
  return path.join(getUserDataDir(customDir), 'one_launcher_pending_sessions.json');
}

function queuePendingCompletedSession(eventPayload, options = {}) {
  if (!eventPayload || typeof eventPayload !== 'object') return [];
  const filePath = getPendingSessionsFilePath(options);
  let queue = [];
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        queue = parsed;
      }
    }
  } catch {}

  const sessionObj = eventPayload.session || eventPayload;
  const gameId = String(sessionObj.gameId || eventPayload.gameId || '').trim();
  const sessionId = String(sessionObj.sessionId || eventPayload.sessionId || '').trim();
  if (!gameId) return queue;

  const entryRecord = {
    sessionId: sessionId || `session-${Date.now()}`,
    gameId,
    title: String(sessionObj.title || eventPayload.title || gameId),
    platformId: sessionObj.platformId || eventPayload.platformId || 'custom',
    platformGameId: String(sessionObj.platformGameId || eventPayload.platformGameId || gameId),
    sessionMinutesPlayed: Number(eventPayload.sessionMinutesPlayed ?? 0),
    durationSeconds: Number(eventPayload.durationSeconds ?? 0),
    lastPlayed: eventPayload.lastPlayed || new Date().toISOString(),
    ...(typeof eventPayload.storefrontTotalPlaytimeMinutes === 'number' &&
    eventPayload.storefrontTotalPlaytimeMinutes > 0
      ? { storefrontTotalPlaytimeMinutes: eventPayload.storefrontTotalPlaytimeMinutes }
      : {}),
    ...(eventPayload.error ? { error: String(eventPayload.error) } : {}),
  };

  const existingIdx = queue.findIndex(
    (item) =>
      item &&
      ((sessionId && item.sessionId === sessionId) ||
        (!sessionId && item.gameId === gameId && item.lastPlayed === entryRecord.lastPlayed))
  );

  if (existingIdx >= 0) {
    queue[existingIdx] = {
      ...queue[existingIdx],
      ...entryRecord,
      sessionMinutesPlayed:
        entryRecord.sessionMinutesPlayed > 0
          ? entryRecord.sessionMinutesPlayed
          : queue[existingIdx].sessionMinutesPlayed,
    };
  } else {
    queue.push(entryRecord);
    if (queue.length > 100) {
      queue = queue.slice(-100);
    }
  }

  try {
    atomicWriteFileSync(filePath, JSON.stringify(queue, null, 2));
  } catch {}

  return queue;
}

function drainPendingCompletedSessions(options = {}) {
  const filePath = getPendingSessionsFilePath(options);
  let queue = [];
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        queue = parsed;
      }
      atomicWriteFileSync(filePath, JSON.stringify([], null, 2));
    }
  } catch {}
  return queue;
}

function emitSessionUpdated(payload, options = {}) {
  for (const listener of sessionListeners) {
    try {
      listener(payload);
    } catch {}
  }

  if (typeof sessionLifecycleHook === 'function' && payload) {
    try {
      const sess = payload.session || payload;
      const lifecycleStatus =
        payload.event === 'stopped'
          ? 'stopped'
          : payload.event === 'started'
            ? 'running'
            : payload.event === 'stopping'
              ? 'stopping'
              : sess.status;
      sessionLifecycleHook(sess.gameId, {
        ...sess,
        ...payload,
        status: lifecycleStatus,
      });
    } catch {}
  }

  let sentToRenderer = false;
  try {
    const win = mainWindowGetter ? mainWindowGetter() : null;
    if (
      win &&
      typeof win.isDestroyed === 'function' &&
      !win.isDestroyed() &&
      win.webContents &&
      (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())
    ) {
      const isRendererLoading = Boolean(
        win.webContents.isLoadingMainFrame?.() || win.webContents.isLoading?.()
      );
      if (!isRendererLoading) {
        win.webContents.send('launcher:session-updated', payload);
        sentToRenderer = true;
      }
    }
  } catch {}

  if (
    (!sentToRenderer || options?.forceQueuePendingSession === true) &&
    payload &&
    (payload.event === 'stopped' ||
      payload.event === 'playtime_synced' ||
      payload.status === 'stopped' ||
      payload.session?.status === 'stopped')
  ) {
    try {
      queuePendingCompletedSession(payload, options);
    } catch {}
  }
}

function emitDownloadUpdated(payload) {
  for (const listener of downloadListeners) {
    try {
      listener(payload);
    } catch {}
  }
  try {
    const win = mainWindowGetter ? mainWindowGetter() : null;
    if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.webContents) {
      win.webContents.send('launcher:download-updated', payload);
    }
  } catch {}
}

/**
 * Resolve Electron userData directory with fallback for headless/test environments
 */
function getUserDataDir(customDir) {
  if (customDir && typeof customDir === 'string') {
    try {
      if (!fs.existsSync(customDir)) {
        fs.mkdirSync(customDir, { recursive: true });
      }
    } catch {}
    return customDir;
  }
  if (configuredUserDataDir) {
    try {
      if (!fs.existsSync(configuredUserDataDir)) {
        fs.mkdirSync(configuredUserDataDir, { recursive: true });
      }
    } catch {}
    return configuredUserDataDir;
  }
  try {
    if (electron.app && typeof electron.app.getPath === 'function') {
      const p = electron.app.getPath('userData');
      if (p) {
        if (!fs.existsSync(p)) {
          fs.mkdirSync(p, { recursive: true });
        }
        return p;
      }
    }
  } catch {}

  const fallback = path.join(os.homedir(), '.one-launcher');
  try {
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
  } catch {}
  return fallback;
}

/**
 * Normalize paths across macOS/POSIX and Windows (including escaped backslashes in manifests)
 */
function toLocalFsPath(rawPath, customRoots = []) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';

  try {
    if (fs.existsSync(trimmed)) return trimmed;
  } catch {}

  // Convert Windows backslashes or drive-letter paths to POSIX forward slashes when running on non-Windows host
  if (path.sep === '/' && (trimmed.includes('\\') || /^[A-Za-z]:[\\/]/.test(trimmed))) {
    const posixCandidate = trimmed.replace(/\\\\/g, '/').replace(/\\/g, '/');
    try {
      if (fs.existsSync(posixCandidate)) return posixCandidate;
    } catch {}

    // Wine maps Z:/ directly to the host POSIX root filesystem (/)
    if (/^[Zz]:\//.test(posixCandidate)) {
      const zRootMapped = '/' + posixCandidate.replace(/^[Zz]:\/+/, '');
      try {
        if (fs.existsSync(zRootMapped)) return zRootMapped;
      } catch {}
      const zStripped = posixCandidate.replace(/^[Zz]:\/+/, '');
      for (const root of customRoots) {
        if (!root) continue;
        const candidateInRoot = path.join(root, zStripped);
        try {
          if (fs.existsSync(candidateInRoot)) return candidateInRoot;
        } catch {}
      }
      return zRootMapped;
    }

    // If it starts with a drive letter like C:/... check if a customRoot maps to it
    const driveStripped = posixCandidate.replace(/^[A-Za-z]:\//, '');
    for (const root of customRoots) {
      if (!root) continue;
      const candidateInRoot = path.join(root, driveStripped);
      try {
        if (fs.existsSync(candidateInRoot)) return candidateInRoot;
      } catch {}
    }
    return posixCandidate;
  }

  return trimmed;
}


const ALLOWED_EXTERNAL_URI_SCHEME_RE =
  /^https?:\/\/|^steam:\/\/|^goggalaxy:\/\/|^com\.epicgames\.launcher:\/\/|^heroic:\/\//i;

/**
 * Open an external URI via Electron shell (or record for headless tests)
 */
const openedExternalUris = [];
async function openExternalUri(uri, options = {}) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return false;
  }
  const cleanUri = uri.trim();
  if (!ALLOWED_EXTERNAL_URI_SCHEME_RE.test(cleanUri)) {
    return false;
  }
  openedExternalUris.push(cleanUri);
  if (typeof options.onOpenExternal === 'function') {
    await options.onOpenExternal(cleanUri);
    return true;
  }
  try {
    if (electron.shell && typeof electron.shell.openExternal === 'function') {
      await electron.shell.openExternal(cleanUri);
      return true;
    }
  } catch {}
  return true;
}

/**
 * Excluded auxiliary / redistributable / crash-handler binaries
 */
const EXCLUDED_EXECUTABLE_PATTERNS = [
  /unitycrashhandler/i,
  /^unins\d*\.exe$/i,
  /uninstall/i,
  /vc_redist/i,
  /vcredist/i,
  /dxsetup/i,
  /directx/i,
  /crashpad_handler/i,
  /crashreporter/i,
  /crashhandler/i,
  /bugsplat/i,
  /ue4prereqsetup/i,
  /ueprereqsetup/i,
  /^dotnet/i,
  /ndp\d+/i,
  /notification_helper/i,
  /steamerrorreporter/i,
  /crs-handler/i,
  /easyanticheat_eos_setup/i,
  /beservice/i,
  /^(itemtest|hammer|hlmv|hlfaceposer|studiomdl|vrad|vvis|vbsp|vbspinfo|vtex|vpk|bspzip|captioncompiler|demoinfo|dmxconvert|dmxedit|elementviewer|glview|height2normal|height2ssbump|mksheet|motionmapper|normal2ssbump|pfm2tgas|qc_eyes|shadercompile|splitskybox|vtf2tga)(\.(exe|com|bat|cmd|sh))?$/i,
];

function isExcludedExecutable(filename) {
  const base = path.basename(filename);
  return EXCLUDED_EXECUTABLE_PATTERNS.some((re) => re.test(base));
}


/**
 * Score candidate executables by relevance to the game title / folder name, depth, PE architecture, and size
 */
function scoreExecutableCandidate(
  filePath,
  rootDir,
  hintName = '',
  peInfo = null,
  platform = null
) {
  const rawFileName = path.basename(filePath);
  const base = rawFileName.replace(/\.(exe|app|sh|command)$/i, '');
  const folderName = path.basename(rootDir);
  const rel = path.relative(rootDir, filePath);
  const depth = rel.split(/[\\/]/).length;

  let score = 100 - depth * 12;

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normBase = norm(base);
  const normHint = norm(hintName);
  const normFolder = norm(folderName);

  if (normHint && normBase === normHint) score += 60;
  else if (normFolder && normBase === normFolder) score += 50;
  else if (normHint && (normBase.includes(normHint) || normHint.includes(normBase))) score += 30;
  else if (normFolder && (normBase.includes(normFolder) || normFolder.includes(normBase))) score += 25;

  if (/shipping/i.test(base)) score += 20; // Unreal Engine *-Win64-Shipping.exe
  if (/^goglauncher$/i.test(base)) score -= 120; // Prefer inner game .app over outer GOGLauncher wrapper
  if (/launcher|setup|config|editor|server/i.test(base)) score -= 15;

  const isWinExe = rawFileName.toLowerCase().endsWith('.exe');
  const effectivePlatform = platform || (isWinExe ? 'win32' : process.platform);
  if (isWinExe && effectivePlatform === 'win32') {
    const exeDir = path.dirname(filePath);
    if (rawFileName.toLowerCase() === 'start_protected_game.exe') {
      const hasEacSettings =
        fs.existsSync(path.join(exeDir, 'EasyAntiCheat', 'Settings.json')) ||
        Boolean(rootDir && fs.existsSync(path.join(rootDir, 'EasyAntiCheat', 'Settings.json')));
      if (hasEacSettings) {
        score += 180;
      }
    } else if (/_be\.exe$/i.test(rawFileName)) {
      const hasBeLauncherIni =
        fs.existsSync(path.join(exeDir, 'BattlEye', 'BELauncher.ini')) ||
        Boolean(rootDir && fs.existsSync(path.join(rootDir, 'BattlEye', 'BELauncher.ini')));
      if (hasBeLauncherIni) {
        score += 180;
      }
    }
  }

  const resolvedPeInfo =
    peInfo ||
    (isWinExe
      ? inspectWindowsExecutableHeader(filePath)
      : null);

  if (resolvedPeInfo?.is16BitDos) {
    score -= 500;
  }
  if (resolvedPeInfo?.is64Bit || /x64|win64|_64|64bit/i.test(base)) {
    score += 45;
  }
  if (/\b(rerelease|remaster|enhanced|bin[\\/]x64|binaries[\\/]win64)\b/i.test(rel)) {
    score += 35;
  }
  if (/_steam$/i.test(base)) {
    score += 20;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      score += Math.min(25, Math.log10(stat.size) * 3);
    }
  } catch {}

  return score;
}

/**
 * Ensure +x (0o755) permissions on all binaries inside MacOS directories and shell scripts on macOS
 */
function ensureMacExecutablePermissions(installPath) {
  if (!installPath || typeof installPath !== 'string' || !fs.existsSync(installPath)) return;

  function walkPerms(currentDir, depth) {
    if (depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const isMacOsBinDir = path.basename(currentDir).toLowerCase() === 'macos';
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (/^(node_modules|\.git|_CodeSignature)$/i.test(entry.name)) continue;
        walkPerms(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (isMacOsBinDir || lower.endsWith('.sh') || lower.endsWith('.command')) {
          try {
            fs.chmodSync(fullPath, 0o755);
          } catch {}
        }
      }
    }
  }

  try {
    const st = fs.statSync(installPath);
    if (st.isFile()) {
      fs.chmodSync(installPath, 0o755);
    } else if (st.isDirectory()) {
      walkPerms(installPath, 0);
    }
  } catch {}
}

/**
 * Resolve the enclosing or child macOS .app bundle path from a target path.
 */
function resolveTargetMacAppBundlePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return null;
  const cleaned = toLocalFsPath(targetPath);
  if (!cleaned || !fs.existsSync(cleaned)) return null;

  const inlineMatch = cleaned.match(/^(.*?\.app)(?:[\\/]|$)/i);
  if (inlineMatch && inlineMatch[1] && fs.existsSync(inlineMatch[1])) {
    return inlineMatch[1];
  }

  try {
    const st = fs.statSync(cleaned);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(cleaned, { withFileTypes: true });
      const appEntry = entries.find(
        (e) => e.isDirectory() && e.name.toLowerCase().endsWith('.app')
      );
      if (appEntry) {
        return path.join(cleaned, appEntry.name);
      }
    }
  } catch {}

  return null;
}

/**
 * Universal macOS .app bundle quarantine removal, executable permission enforcement,
 * and ad-hoc code signature verification & repair.
 * Fixes macOS SIGKILL (EXC_BAD_ACCESS / Code Signature Invalid) on unsigned x86_64/arm64
 * game bundles or bundles whose Contents/Resources were modified post-install.
 */
function ensureMacAppCodeSignatureValid(targetPath, options = {}) {
  const platform = options.platform || process.platform;
  if (
    platform !== 'darwin' ||
    (isTestEnvironment(options) && options.allowCodesignInTest !== true)
  ) {
    return { verified: false, repaired: false, appBundlePath: null };
  }

  const appBundlePath = resolveTargetMacAppBundlePath(targetPath);
  if (!appBundlePath || !fs.existsSync(appBundlePath)) {
    return { verified: false, repaired: false, appBundlePath: null };
  }

  const execFileSyncImpl =
    typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;

  try {
    ensureMacExecutablePermissions(appBundlePath);
  } catch {}

  try {
    execFileSyncImpl('xattr', ['-cr', appBundlePath], {
      stdio: 'ignore',
      timeout: 4000,
    });
  } catch {}

  try {
    execFileSyncImpl('codesign', ['--verify', '--deep', '--strict', appBundlePath], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return { verified: true, repaired: false, appBundlePath };
  } catch {
    try {
      let bundleId = '';
      const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
      if (fs.existsSync(infoPlistPath)) {
        try {
          const plistRaw = fs.readFileSync(infoPlistPath, 'utf8');
          const idMatch = plistRaw.match(
            /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/i
          );
          if (idMatch && idMatch[1]) {
            bundleId = idMatch[1].trim();
          }
        } catch {}
      }
      const signArgs = [
        '--force',
        '--deep',
        '--sign',
        '-',
        ...(bundleId
          ? ['--identifier', bundleId, `-r=designated => identifier "${bundleId}"`]
          : []),
        appBundlePath,
      ];
      execFileSyncImpl('codesign', signArgs, {
        stdio: 'ignore',
        timeout: 15000,
      });
      return { verified: true, repaired: true, appBundlePath, bundleId: bundleId || null };
    } catch {
      return { verified: false, repaired: false, appBundlePath };
    }
  }
}

/**
 * Inspect whether a GOG installation bundles the GOG Galaxy SDK (`libGalaxy*.dylib`, `Galaxy*.dll`, `GalaxyPeer.json`).
 * Pure DRM-free games without the Galaxy SDK do not need GOG Galaxy woken in the background.
 */
function doesGogInstallUseGalaxySdk(installDir, executablePath) {
  const sdkFilePattern = /^(lib)?Galaxy(Peer)?(64)?\.(dylib|dll|so)|^GalaxyPeer\.json$/i;
  const searchRoots = new Set();

  if (installDir && typeof installDir === 'string') {
    const cleanInstall = toLocalFsPath(installDir);
    if (cleanInstall && fs.existsSync(cleanInstall)) {
      searchRoots.add(cleanInstall);
      const appPath = resolveTargetMacAppBundlePath(cleanInstall);
      if (appPath) {
        searchRoots.add(appPath);
        searchRoots.add(path.join(appPath, 'Contents', 'Frameworks'));
        searchRoots.add(path.join(appPath, 'Contents', 'MacOS'));
        searchRoots.add(path.join(appPath, 'Contents', 'PlugIns'));
      }
    }
  }

  if (executablePath && typeof executablePath === 'string') {
    const cleanExe = toLocalFsPath(executablePath);
    if (cleanExe) {
      const exeDir = path.dirname(cleanExe);
      if (exeDir && fs.existsSync(exeDir)) {
        searchRoots.add(exeDir);
      }
      const appPath = resolveTargetMacAppBundlePath(cleanExe);
      if (appPath) {
        searchRoots.add(appPath);
        searchRoots.add(path.join(appPath, 'Contents', 'Frameworks'));
        searchRoots.add(path.join(appPath, 'Contents', 'MacOS'));
        searchRoots.add(path.join(appPath, 'Contents', 'PlugIns'));
      }
    }
  }

  const visitedDirs = new Set();
  const scanDir = (dirPath, depth) => {
    if (depth > 3 || !dirPath || visitedDirs.has(dirPath) || !fs.existsSync(dirPath)) {
      return false;
    }
    visitedDirs.add(dirPath);
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.isFile() && sdkFilePattern.test(entry.name)) {
        return true;
      }
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.isDirectory() && !/^(node_modules|\.git|_CodeSignature)$/i.test(entry.name)) {
        if (scanDir(path.join(dirPath, entry.name), depth + 1)) {
          return true;
        }
      }
    }
    return false;
  };

  for (const root of searchRoots) {
    if (scanDir(root, 0)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve executable binary inside a macOS .app bundle
 */
function resolveMacAppBundleBinary(appBundlePath) {
  try {
    const macosDir = path.join(appBundlePath, 'Contents', 'MacOS');
    if (fs.existsSync(macosDir) && fs.statSync(macosDir).isDirectory()) {
      let resolvedBinPath = null;

      // Check Info.plist CFBundleExecutable first if available
      const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
      if (fs.existsSync(plistPath)) {
        try {
          const plistContent = fs.readFileSync(plistPath, 'utf8');
          const m = plistContent.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i);
          if (m && m[1]) {
            const candidate = path.join(macosDir, m[1].trim());
            if (fs.existsSync(candidate)) resolvedBinPath = candidate;
          }
        } catch {}
      }

      if (!resolvedBinPath) {
        const entries = fs.readdirSync(macosDir);
        const validFiles = entries.filter((name) => {
          if (name.startsWith('.')) return false;
          const full = path.join(macosDir, name);
          try {
            return fs.statSync(full).isFile();
          } catch {
            return false;
          }
        });
        if (validFiles.length > 0) {
          const bundleBase = path.basename(appBundlePath, '.app').toLowerCase();
          const exact = validFiles.find((f) => f.toLowerCase() === bundleBase);
          resolvedBinPath = path.join(macosDir, exact || validFiles[0]);
        }
      }

      if (resolvedBinPath && /^goglauncher$/i.test(path.basename(resolvedBinPath))) {
        const resDir = path.join(appBundlePath, 'Contents', 'Resources');
        if (fs.existsSync(resDir)) {
          try {
            const infoFiles = fs
              .readdirSync(resDir)
              .filter((f) => /^\.?goggame-\d+\.info$/i.test(f))
              .sort((a, b) => (a.startsWith('.') ? -1 : 1) - (b.startsWith('.') ? -1 : 1));
            for (const f of infoFiles) {
              try {
                const parsed = JSON.parse(fs.readFileSync(path.join(resDir, f), 'utf8'));
                if (!Array.isArray(parsed?.playTasks)) continue;
                const task =
                  parsed.playTasks.find((t) => t && t.isPrimary && t.path) ||
                  parsed.playTasks.find((t) => t && t.path);
                if (task && task.path) {
                  const relTaskPath = String(task.path).replace(/\\/g, path.sep);
                  const candidates = [
                    path.join(appBundlePath, relTaskPath),
                    path.join(resDir, relTaskPath),
                  ];
                  for (const candidateTaskPath of candidates) {
                    if (
                      fs.existsSync(candidateTaskPath) &&
                      !/[\\/]GOGLauncher$/i.test(candidateTaskPath)
                    ) {
                      if (candidateTaskPath.toLowerCase().endsWith('.app')) {
                        return resolveMacAppBundleBinary(candidateTaskPath);
                      }
                      try {
                        fs.chmodSync(candidateTaskPath, 0o755);
                      } catch {}
                      return candidateTaskPath;
                    }
                  }
                }
              } catch {}
            }
          } catch {}

          const gameDir = path.join(resDir, 'game');
          if (fs.existsSync(gameDir)) {
            try {
              const nestedApps = fs
                .readdirSync(gameDir, { withFileTypes: true })
                .filter((d) => d.isDirectory() && d.name.toLowerCase().endsWith('.app'));
              if (nestedApps.length > 0) {
                return resolveMacAppBundleBinary(path.join(gameDir, nestedApps[0].name));
              }
            } catch {}
          }
        }
      }

      if (resolvedBinPath) {
        try {
          fs.chmodSync(resolvedBinPath, 0o755);
        } catch {}
        return resolvedBinPath;
      }
    }
  } catch {}
  return appBundlePath;
}

const MAX_DISCOVERY_CACHE_ENTRIES = 500;
const MAX_LEGENDARY_CACHE_DIRS = 16;
const MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES = 2000;
const STEAM_APPINFO_BUF_IDLE_TTL_MS = 5000;
const executableDiscoveryCache = new Map();
const steamAppInfoCache = new Map();
const steamResolvedLaunchSpecCache = new Map();
const legendaryMetadataDirCache = new Map();
const legendaryAssetsFileCache = new Map();
const legendaryAliasesFileCache = new Map();
const moltenVkHudDeadlockCache = new Map();
let lastProductionScanCache = { timestamp: 0, result: null };
let lastSyncedEpicFingerprint = '';
let lastSyncedGogFingerprint = '';

function setBoundedMapEntry(map, key, value, maxEntries = MAX_DISCOVERY_CACHE_ENTRIES) {
  if (!map.has(key) && map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

function evictExecutableDiscoveryCacheForPath(targetPath) {
  if (!targetPath) return;
  const rawStr = String(targetPath);
  const resolvedStr = path.resolve(rawStr);
  executableDiscoveryCache.delete(rawStr);
  executableDiscoveryCache.delete(resolvedStr);
  const prefixes = [`${rawStr}|`, `${rawStr}:`, `${resolvedStr}|`, `${resolvedStr}:`];
  for (const key of Array.from(executableDiscoveryCache.keys())) {
    if (prefixes.some((prefix) => String(key).startsWith(prefix))) {
      executableDiscoveryCache.delete(key);
    }
  }
}

function trimLauncherEngineMemory() {
  for (const [, entry] of steamAppInfoCache.entries()) {
    if (entry) {
      if (entry.evictTimer) {
        try {
          clearTimeout(entry.evictTimer);
        } catch {}
        entry.evictTimer = null;
      }
      entry.buf = null;
    }
  }
  while (steamResolvedLaunchSpecCache.size > 1000) {
    const oldestKey = steamResolvedLaunchSpecCache.keys().next().value;
    if (oldestKey === undefined) break;
    steamResolvedLaunchSpecCache.delete(oldestKey);
  }
  lastProductionScanCache = { timestamp: 0, result: null };
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {}
  }
  return { success: true };
}

function invalidateScanCaches() {
  executableDiscoveryCache.clear();
  for (const [, entry] of steamAppInfoCache.entries()) {
    if (entry && entry.evictTimer) {
      try {
        clearTimeout(entry.evictTimer);
      } catch {}
      entry.evictTimer = null;
    }
  }
  steamAppInfoCache.clear();
  steamResolvedLaunchSpecCache.clear();
  legendaryMetadataDirCache.clear();
  legendaryAssetsFileCache.clear();
  legendaryAliasesFileCache.clear();
  moltenVkHudDeadlockCache.clear();
  lastProductionScanCache = { timestamp: 0, result: null };
  lastSyncedEpicFingerprint = '';
  lastSyncedGogFingerprint = '';
}

function hasShebangHeader(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function readBoundedHeaderBytesSync(filePath, maxBytes = 64) {
  const limit = Math.max(1, Math.min(Number(maxBytes) || 64, 512));
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function readBoundedTrailerBytesSync(filePath, maxBytes = 64) {
  const limit = Math.max(1, Math.min(Number(maxBytes) || 64, 512));
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    const size = Number(st.size || 0);
    if (size <= 0) return Buffer.alloc(0);
    const readLen = Math.min(size, limit);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, size - readLen);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function isValidSqliteDatabaseFile(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
    return bytesRead === 16 && buf.toString('utf8', 0, 15) === 'SQLite format 3';
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function hasZipMagicHeader(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    return (
      bytesRead === 4 &&
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function inspectDmgUdifTrailer(filePath) {
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    const size = Number(st.size || 0);
    if (size < 512) return false;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, size - 512);
    return bytesRead === 4 && buf.toString('ascii', 0, 4) === 'koly';
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Auto-discover the primary game executable inside an installation directory
 */
function findPrimaryExecutable(installPath, options = {}) {
  const platform = options.platform || process.platform;
  const hintName = options.hintName || options.preferredHint || '';
  const preferWindowsExecutable = Boolean(options.preferWindowsExecutable);
  const localInstallPath = toLocalFsPath(installPath);

  if (!localInstallPath || !fs.existsSync(localInstallPath)) {
    return { executablePath: undefined, isWindowsBinaryOnMac: false };
  }

  const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(localInstallPath);

  let rootMtimeMs = 0;
  try {
    const rootStat = fs.statSync(localInstallPath);
    rootMtimeMs = rootStat.mtimeMs || 0;
    if (rootStat.isFile()) {
      const isWinExe = localInstallPath.toLowerCase().endsWith('.exe');
      if (isWinExe && platform === 'win32') {
        const rootPe = inspectWindowsExecutableHeader(localInstallPath);
        if (rootPe.is16BitDos) {
          return { executablePath: undefined, isWindowsBinaryOnMac: false };
        }
      }
      return {
        executablePath: localInstallPath,
        isWindowsBinaryOnMac: platform === 'darwin' && (isWinExe || isInsideBottle),
      };
    }
    if (platform === 'darwin' && !isInsideBottle && localInstallPath.endsWith('.app')) {
      return {
        executablePath: resolveMacAppBundleBinary(localInstallPath),
        isWindowsBinaryOnMac: false,
      };
    }
  } catch {
    return { executablePath: undefined, isWindowsBinaryOnMac: false };
  }

  const cacheKey = `${localInstallPath}|${platform}|${hintName}|${preferWindowsExecutable ? 'win' : 'auto'}`;
  const cached = executableDiscoveryCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.timestamp < 60000 &&
    cached.mtimeMs === rootMtimeMs &&
    (!cached.result.executablePath || fs.existsSync(cached.result.executablePath)) &&
    !(platform === 'darwin' && fs.existsSync(path.join(localInstallPath, 'Info.plist'))) &&
    !(platform === 'darwin' && /[\\/]GOGLauncher$/i.test(String(cached.result.executablePath || '')))
  ) {
    return { ...cached.result };
  }

  if (platform === 'darwin' && !isInsideBottle) {
    flattenGogNestedInstallDir(localInstallPath);
    ensureMacExecutablePermissions(localInstallPath);
    try {
      rootMtimeMs = fs.statSync(localInstallPath).mtimeMs || 0;
    } catch {}
  }

  const cacheAndReturn = (result) => {
    setBoundedMapEntry(
      executableDiscoveryCache,
      cacheKey,
      {
        result,
        mtimeMs: rootMtimeMs,
        timestamp: Date.now(),
      },
      MAX_DISCOVERY_CACHE_ENTRIES
    );
    return { ...result };
  };

  const macApps = [];
  const winExeCandidates = [];
  const unixBins = [];
  const maxWalkDepth = platform === 'darwin' ? 4 : 3;

  function walk(currentDir, depth) {
    if (depth > maxWalkDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().endsWith('.app')) {
          if (!isInsideBottle) {
            macApps.push(fullPath);
          }
          continue; // Don't recurse inside .app bundle during general walk
        }
        // Skip common non-executable asset directories to keep scanning fast (preserve Contents/Resources on darwin)
        const skipRe =
          platform === 'darwin' && !isInsideBottle
            ? /^(node_modules|redist|_commonredist|directx|vcredist|locales|streamingassets|mono|_codesignature)$/i
            : /^(node_modules|redist|_commonredist|directx|vcredist|locales|resources|data|assets|streamingassets|mono)$/i;
        if (skipRe.test(entry.name)) {
          continue;
        }
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.exe')) {
          if (!isExcludedExecutable(entry.name)) {
            let size = 0;
            try {
              size = fs.statSync(fullPath).size;
            } catch {}
            const relPath = path.relative(localInstallPath, fullPath);
            const peInfo = inspectWindowsExecutableHeader(fullPath);
            winExeCandidates.push({
              path: fullPath,
              relPath,
              depth,
              size,
              peInfo,
            });
          }
        } else if (
          platform === 'darwin' &&
          !isInsideBottle &&
          !/\.(com|bat|cmd|vbs|msi|fgd|vdf|res|bsp|dsp|ain|dem|vmt|vtf|dll|so|dylib|txt|md|json|info|acf|png|jpg|jpeg|gif|ico|pak|kpf|wad|pk3|pk4|vpk|bsa|ba2|upk|uasset|umap|pck|bundle|assets|ress|resource|zip|7z|rar|tar|gz|bz2|xz|cab|iso|dmg|pkg|bin|dat|log|xml|ini|cfg|wav|mp3|ogg|mp4|webm|pdf|html|css|js|plist|icns|nib|strings|hashdb)$/i.test(
            lower
          )
        ) {
          if (lower.endsWith('.sh') || lower.endsWith('.command')) {
            if (!isExcludedExecutable(entry.name) && !/^script(_alt)?\.sh$/i.test(entry.name)) {
              unixBins.push(fullPath);
            }
          } else {
            try {
              const st = fs.statSync(fullPath);
              if ((st.mode & 0o111) !== 0 && !isExcludedExecutable(entry.name)) {
                const machO = inspectMacMachOHeader(fullPath);
                if (machO.isMachO || hasShebangHeader(fullPath)) {
                  unixBins.push(fullPath);
                }
              }
            } catch {}
          }
        }
      }
    }
  }

  walk(localInstallPath, 0);

  // Check GOG .info files (goggame-*.info and .goggame-*.info) for explicit primary FileTask playTasks FIRST
  const resolveGogInfoPlayTaskExecutable = () => {
    const infoSearchDirs = [
      path.join(localInstallPath, 'Contents', 'Resources'),
      path.join(localInstallPath, 'Resources'),
      localInstallPath,
      ...macApps.map((appDir) => path.join(appDir, 'Contents', 'Resources')),
    ];
    for (const dir of infoSearchDirs) {
      if (!fs.existsSync(dir)) continue;
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const infoFiles = files
        .filter((f) => /^\.?goggame-\d+\.info$/i.test(f))
        .sort((a, b) => (a.startsWith('.') ? -1 : 1) - (b.startsWith('.') ? -1 : 1));
      for (const f of infoFiles) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (!Array.isArray(parsed?.playTasks)) continue;
          const isFileTask = (t) =>
            Boolean(t && t.path && (!t.type || String(t.type) === 'FileTask'));
          const task =
            parsed.playTasks.find((t) => isFileTask(t) && t.isPrimary) ||
            parsed.playTasks.find((t) => isFileTask(t) && t.category === 'game') ||
            parsed.playTasks.find((t) => isFileTask(t));
          if (task && task.path) {
            const relTaskPath = String(task.path).replace(/\\/g, path.sep);
            const candidates = [
              path.join(localInstallPath, relTaskPath),
              path.join(dir, relTaskPath),
              path.join(path.resolve(dir, '..', '..'), relTaskPath),
            ];
            for (const c of candidates) {
              if (fs.existsSync(c)) {
                const resolvedCand = c.toLowerCase().endsWith('.app')
                  ? resolveMacAppBundleBinary(c)
                  : c;
                if (platform === 'darwin' && /[\\/]GOGLauncher$/i.test(resolvedCand)) {
                  continue;
                }
                return resolvedCand;
              }
            }
          }
        } catch {}
      }
    }
    return undefined;
  };

  const nonDosCandidates = winExeCandidates.filter((c) => !c.peInfo?.is16BitDos);
  const filteredWinCandidates =
    nonDosCandidates.length > 0
      ? nonDosCandidates
      : platform === 'win32'
        ? []
        : winExeCandidates;

  const gogInfoExe = resolveGogInfoPlayTaskExecutable();

  if (platform === 'darwin') {
    if (preferWindowsExecutable) {
      if (
        gogInfoExe &&
        gogInfoExe.toLowerCase().endsWith('.exe') &&
        !inspectWindowsExecutableHeader(gogInfoExe)?.is16BitDos
      ) {
        return cacheAndReturn({
          executablePath: gogInfoExe,
          isWindowsBinaryOnMac: true,
        });
      }
      if (filteredWinCandidates.length > 0) {
        filteredWinCandidates.sort(
          (a, b) =>
            scoreExecutableCandidate(b.path, localInstallPath, hintName, b.peInfo, platform) -
            scoreExecutableCandidate(a.path, localInstallPath, hintName, a.peInfo, platform)
        );
        return cacheAndReturn({
          executablePath: filteredWinCandidates[0].path,
          isWindowsBinaryOnMac: true,
        });
      }
    }

    if (gogInfoExe) {
      if (!gogInfoExe.toLowerCase().endsWith('.exe')) {
        const machO = inspectMacMachOHeader(gogInfoExe);
        if (!machO.is32BitOnly) {
          return cacheAndReturn({
            executablePath: gogInfoExe,
            isWindowsBinaryOnMac: isInsideBottle,
          });
        }
      } else if (isInsideBottle || macApps.length === 0) {
        return cacheAndReturn({
          executablePath: gogInfoExe,
          isWindowsBinaryOnMac: true,
        });
      }
    }

    if (!isInsideBottle && macApps.length > 0) {
      macApps.sort(
        (a, b) =>
          scoreExecutableCandidate(b, localInstallPath, hintName, null, platform) -
          scoreExecutableCandidate(a, localInstallPath, hintName, null, platform)
      );
      const candidateMacBin = resolveMacAppBundleBinary(macApps[0]);
      if (candidateMacBin && !candidateMacBin.toLowerCase().endsWith('.exe')) {
        const machO = inspectMacMachOHeader(candidateMacBin);
        if (machO.is32BitOnly && filteredWinCandidates.length > 0) {
          filteredWinCandidates.sort(
            (a, b) =>
              scoreExecutableCandidate(b.path, localInstallPath, hintName, b.peInfo, platform) -
              scoreExecutableCandidate(a.path, localInstallPath, hintName, a.peInfo, platform)
          );
          return cacheAndReturn({
            executablePath: filteredWinCandidates[0].path,
            isWindowsBinaryOnMac: true,
          });
        }
      }
      return cacheAndReturn({
        executablePath: candidateMacBin,
        isWindowsBinaryOnMac: false,
      });
    }

    if (!isInsideBottle && unixBins.length > 0) {
      unixBins.sort(
        (a, b) =>
          scoreExecutableCandidate(b, localInstallPath, hintName, null, platform) -
          scoreExecutableCandidate(a, localInstallPath, hintName, null, platform)
      );
      return cacheAndReturn({
        executablePath: unixBins[0],
        isWindowsBinaryOnMac: false,
      });
    }

    if (filteredWinCandidates.length > 0) {
      filteredWinCandidates.sort(
        (a, b) =>
          scoreExecutableCandidate(b.path, localInstallPath, hintName, b.peInfo, platform) -
          scoreExecutableCandidate(a.path, localInstallPath, hintName, a.peInfo, platform)
      );
      return cacheAndReturn({
        executablePath: filteredWinCandidates[0].path,
        isWindowsBinaryOnMac: true,
      });
    }

    return cacheAndReturn({ executablePath: undefined, isWindowsBinaryOnMac: false });
  }

  // Windows (win32) or fallback: honor primary FileTask in goggame-<id>.info FIRST
  if (gogInfoExe) {
    const is16Bit =
      gogInfoExe.toLowerCase().endsWith('.exe') &&
      Boolean(inspectWindowsExecutableHeader(gogInfoExe)?.is16BitDos);
    if (!is16Bit) {
      return cacheAndReturn({
        executablePath: gogInfoExe,
        isWindowsBinaryOnMac: false,
      });
    }
  }

  if (filteredWinCandidates.length > 0) {
    filteredWinCandidates.sort(
      (a, b) =>
        scoreExecutableCandidate(b.path, localInstallPath, hintName, b.peInfo, platform) -
        scoreExecutableCandidate(a.path, localInstallPath, hintName, a.peInfo, platform)
    );
    return cacheAndReturn({
      executablePath: filteredWinCandidates[0].path,
      isWindowsBinaryOnMac: false,
    });
  }

  return cacheAndReturn({ executablePath: undefined, isWindowsBinaryOnMac: false });
}


/**
 * Locate and parse Steam binary <SteamRoot>/appcache/appinfo.vdf (v27, v28, v29)
 * to resolve the authoritative executable, launch arguments, and working directory for an AppID.
 */
function scheduleSteamAppInfoBufEviction(entry) {
  if (!entry) return;
  if (entry.evictTimer) {
    try {
      clearTimeout(entry.evictTimer);
    } catch {}
  }
  entry.evictTimer = setTimeout(() => {
    entry.buf = null;
    entry.evictTimer = null;
  }, STEAM_APPINFO_BUF_IDLE_TTL_MS);
  if (entry.evictTimer && typeof entry.evictTimer.unref === 'function') {
    entry.evictTimer.unref();
  }
}

function getIndexedSteamAppInfoVdf(appinfoPath) {
  try {
    if (!appinfoPath || !fs.existsSync(appinfoPath)) return null;
    const st = fs.statSync(appinfoPath);
    const mtimeMs = st.mtimeMs || 0;
    const cached = steamAppInfoCache.get(appinfoPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.buf) {
        scheduleSteamAppInfoBufEviction(cached);
      }
      return cached;
    }
    if (cached && cached.evictTimer) {
      try {
        clearTimeout(cached.evictTimer);
      } catch {}
      cached.evictTimer = null;
    }

    const buf = fs.readFileSync(appinfoPath);
    if (buf.length < 16) return null;

    const magic = buf.readUInt32LE(0);
    if (magic !== 0x07564429 && magic !== 0x07564428 && magic !== 0x07564427) {
      return null;
    }

    let strings = null;
    let entriesEnd = buf.length;
    let pos = 8;

    if (magic === 0x07564429) {
      const strTableOffset = Number(buf.readBigInt64LE(8));
      pos = 16;
      if (strTableOffset > 16 && strTableOffset + 4 <= buf.length) {
        entriesEnd = strTableOffset;
        const strCount = buf.readUInt32LE(strTableOffset);
        strings = new Array(strCount);
        let sPos = strTableOffset + 4;
        for (let i = 0; i < strCount && sPos < buf.length; i++) {
          let end = sPos;
          while (end < buf.length && buf[end] !== 0) end++;
          strings[i] = buf.toString('utf8', sPos, end);
          sPos = end + 1;
        }
      }
    }

    const entryMetaBytes = magic === 0x07564427 ? 40 : 60;
    const appIndex = new Map();

    while (pos + 8 <= entriesEnd) {
      const entryAppId = buf.readUInt32LE(pos);
      if (entryAppId === 0) break;
      const size = buf.readUInt32LE(pos + 4);
      const nextPos = pos + 8 + size;
      if (size <= entryMetaBytes || nextPos > entriesEnd) break;
      appIndex.set(entryAppId, {
        payloadStart: pos + 8 + entryMetaBytes,
        payloadEnd: nextPos,
      });
      pos = nextPos;
    }

    const indexed = {
      mtimeMs,
      buf,
      magic,
      strings,
      appIndex,
      evictTimer: null,
    };
    scheduleSteamAppInfoBufEviction(indexed);
    setBoundedMapEntry(steamAppInfoCache, appinfoPath, indexed, 16);
    return indexed;
  } catch {
    return null;
  }
}

function parseSteamBinaryVdfSlice(buf, startPos, endPos, strings) {
  let p = startPos;

  function readNullTerminatedUtf8() {
    let e = p;
    while (e < endPos && buf[e] !== 0) e++;
    const str = buf.toString('utf8', p, e);
    p = Math.min(endPos, e + 1);
    return str;
  }

  function readNullTerminatedUtf16() {
    let e = p;
    while (e + 1 < endPos && (buf[e] !== 0 || buf[e + 1] !== 0)) e += 2;
    const str = buf.toString('utf16le', p, e);
    p = Math.min(endPos, e + 2);
    return str;
  }

  function parseObject() {
    const obj = {};
    while (p < endPos) {
      const type = buf[p++];
      if (type === 0x08) break;

      let key;
      if (strings) {
        if (p + 4 > endPos) break;
        const keyIdx = buf.readUInt32LE(p);
        p += 4;
        key = strings[keyIdx] !== undefined ? strings[keyIdx] : String(keyIdx);
      } else {
        key = readNullTerminatedUtf8();
      }

      if (type === 0x00) {
        obj[key] = parseObject();
      } else if (type === 0x01) {
        obj[key] = readNullTerminatedUtf8();
      } else if (type === 0x02 || type === 0x04 || type === 0x06) {
        if (p + 4 > endPos) break;
        obj[key] = buf.readInt32LE(p);
        p += 4;
      } else if (type === 0x03) {
        if (p + 4 > endPos) break;
        obj[key] = buf.readFloatLE(p);
        p += 4;
      } else if (type === 0x05) {
        obj[key] = readNullTerminatedUtf16();
      } else if (type === 0x07 || type === 0x0a) {
        if (p + 8 > endPos) break;
        obj[key] = String(buf.readBigUInt64LE(p));
        p += 8;
      } else {
        break;
      }
    }
    return obj;
  }

  return parseObject();
}

function findEnclosingSteamAppInfoVdf(startPaths = [], options = {}) {
  if (options.appinfoVdfPath && fs.existsSync(options.appinfoVdfPath)) {
    return options.appinfoVdfPath;
  }
  const visited = new Set();
  for (const rawStart of startPaths) {
    if (!rawStart || typeof rawStart !== 'string') continue;
    let curr = toLocalFsPath(rawStart);
    for (let depth = 0; depth <= 6 && curr; depth++) {
      const resolvedCurr = path.resolve(curr);
      if (!visited.has(resolvedCurr)) {
        visited.add(resolvedCurr);
        const candidates = [
          path.join(resolvedCurr, 'appcache', 'appinfo.vdf'),
          path.join(resolvedCurr, 'Steam', 'appcache', 'appinfo.vdf'),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) return c;
        }
      }
      const parent = path.dirname(resolvedCurr);
      if (!parent || parent === resolvedCurr) break;
      curr = parent;
    }
  }
  return null;
}

function resolveSteamAppInfoLaunchSpec(steamappsDirOrInstallPath, appId, installPath, options = {}) {
  try {
    if (installPath && typeof installPath === 'object') {
      options = installPath;
      installPath = steamappsDirOrInstallPath;
    }
    const cleanAppId = parseInt(String(appId || '').replace(/^steam[-_]/i, '').trim(), 10);
    if (!cleanAppId || Number.isNaN(cleanAppId)) return null;

    const resolvedInstallPath = toLocalFsPath(installPath || steamappsDirOrInstallPath);
    const appinfoPath = findEnclosingSteamAppInfoVdf(
      [steamappsDirOrInstallPath, resolvedInstallPath],
      options
    );
    if (!appinfoPath) return null;

    const indexed = getIndexedSteamAppInfoVdf(appinfoPath);
    if (!indexed) return null;

    const platform = options.platform || process.platform;
    const specCacheKey = `${appinfoPath}::${indexed.mtimeMs}::${cleanAppId}`;
    if (steamResolvedLaunchSpecCache.has(specCacheKey)) {
      const cachedEntry = steamResolvedLaunchSpecCache.get(specCacheKey);
      if (
        cachedEntry &&
        cachedEntry.installPath === resolvedInstallPath &&
        cachedEntry.platform === platform
      ) {
        if (cachedEntry.spec === null) return null;
        if (cachedEntry.spec.executablePath && fs.existsSync(cachedEntry.spec.executablePath)) {
          return { ...cachedEntry.spec };
        }
      }
    }

    const slice = indexed.appIndex.get(cleanAppId);
    if (!slice) {
      setBoundedMapEntry(
        steamResolvedLaunchSpecCache,
        specCacheKey,
        { installPath: resolvedInstallPath, platform, spec: null },
        MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
      );
      return null;
    }

    let parsedApp = null;
    if (indexed.buf) {
      scheduleSteamAppInfoBufEviction(indexed);
      parsedApp = parseSteamBinaryVdfSlice(
        indexed.buf,
        slice.payloadStart,
        slice.payloadEnd,
        indexed.strings
      );
    } else {
      const sliceLen = slice.payloadEnd - slice.payloadStart;
      if (sliceLen <= 0) return null;
      const sliceBuf = Buffer.allocUnsafe(sliceLen);
      const fd = fs.openSync(appinfoPath, 'r');
      try {
        fs.readSync(fd, sliceBuf, 0, sliceLen, slice.payloadStart);
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      parsedApp = parseSteamBinaryVdfSlice(sliceBuf, 0, sliceLen, indexed.strings);
    }

    const root = parsedApp?.appinfo || parsedApp;
    const launchMap = root?.config?.launch;
    if (!launchMap || typeof launchMap !== 'object') {
      setBoundedMapEntry(
        steamResolvedLaunchSpecCache,
        specCacheKey,
        { installPath: resolvedInstallPath, platform, spec: null },
        MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
      );
      return null;
    }

    const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
      resolvedInstallPath || ''
    );
    const wantWindows = platform === 'win32' || isInsideBottle;

    const candidates = [];
    for (const [, entry] of Object.entries(launchMap)) {
      if (!entry || typeof entry !== 'object' || !entry.executable) continue;
      const relExe = String(entry.executable)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, path.sep);
      if (!relExe || !resolvedInstallPath) continue;

      let candidateExe = path.join(resolvedInstallPath, relExe);
      if (!fs.existsSync(candidateExe)) continue;

      if (platform === 'darwin' && !isInsideBottle && candidateExe.toLowerCase().endsWith('.app')) {
        candidateExe = resolveMacAppBundleBinary(candidateExe);
      }

      if (isExcludedExecutable(candidateExe)) continue;

      const oslist = String(entry.config?.oslist || '').toLowerCase();
      let score = 0;

      if (wantWindows) {
        if (oslist.includes('windows')) {
          score += 100;
        } else if (!oslist && candidateExe.toLowerCase().endsWith('.exe')) {
          score += 60;
        } else {
          continue;
        }
      } else {
        if (oslist.includes('macos') || oslist.includes('osx')) {
          score += 100;
        } else if (oslist.includes('windows')) {
          score += 40;
        } else if (oslist.includes('linux')) {
          continue;
        }
        if (
          !candidateExe.toLowerCase().endsWith('.exe') &&
          !candidateExe.toLowerCase().endsWith('.sh') &&
          inspectMacMachOHeader(candidateExe).is32BitOnly
        ) {
          score -= 120;
        }
      }

      const entryType = String(entry.type || 'default').toLowerCase();
      if (entryType === 'default' || entryType === 'none' || !entry.type) {
        score += 50;
      } else if (entryType === 'option1' || entryType === 'option2') {
        score -= 20;
      } else if (/config|editor|tool|sdk|server|vr|benchmark/i.test(entryType)) {
        score -= 80;
      }

      if (entry.config?.ownsdlc) {
        score -= 15;
      }

      if (String(entry.config?.osarch || '') === '64') {
        score += 15;
      }

      candidates.push({
        score,
        entry,
        executablePath: candidateExe,
      });
    }

    if (candidates.length === 0) {
      setBoundedMapEntry(
        steamResolvedLaunchSpecCache,
        specCacheKey,
        { installPath: resolvedInstallPath, platform, spec: null },
        MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
      );
      return null;
    }
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const launchArguments =
      best.entry.arguments && String(best.entry.arguments).trim()
        ? String(best.entry.arguments).trim()
        : undefined;
    const workingDirectory =
      best.entry.workingdir && resolvedInstallPath
        ? path.join(
            resolvedInstallPath,
            String(best.entry.workingdir)
              .replace(/^[\\/]+/, '')
              .replace(/\\/g, path.sep)
          )
        : undefined;
    const isWindowsBinaryOnMac =
      platform === 'darwin' &&
      (isInsideBottle || best.executablePath.toLowerCase().endsWith('.exe'));

    const resolvedSpec = {
      executablePath: best.executablePath,
      launchArguments,
      workingDirectory,
      isWindowsBinaryOnMac,
    };
    setBoundedMapEntry(
      steamResolvedLaunchSpecCache,
      specCacheKey,
      { installPath: resolvedInstallPath, platform, spec: resolvedSpec },
      MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
    );
    return { ...resolvedSpec };
  } catch {
    return null;
  }
}

/**
 * Universal fallback for Source Engine games (hl2.exe / hl2_osx / hl2_linux / hl2.sh)
 * that require `-game <mod_subdir> -steam` based on `<subdir>/gameinfo.txt` on disk.
 */
function resolveDefaultEngineLaunchArguments(installPath, executablePath) {
  try {
    if (!executablePath || typeof executablePath !== 'string') return undefined;
    const exeBase = path.basename(executablePath);
    if (!/^hl2(\.exe|_osx|_linux|\.sh)?$/i.test(exeBase)) return undefined;

    const rootDir = toLocalFsPath(installPath) || path.dirname(toLocalFsPath(executablePath));
    if (!rootDir || !fs.existsSync(rootDir)) return undefined;

    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const modDirs = [];
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const subDir = path.join(rootDir, d.name);
      try {
        const subFiles = fs.readdirSync(subDir);
        if (subFiles.some((f) => f.toLowerCase() === 'gameinfo.txt')) {
          modDirs.push(d.name);
        }
      } catch {}
    }

    if (modDirs.length === 0) return undefined;

    const normFolder = path
      .basename(rootDir)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const exactMatch = modDirs.find(
      (dir) => dir.toLowerCase().replace(/[^a-z0-9]/g, '') === normFolder
    );
    const nonBaseMod = modDirs.find(
      (dir) => !/^(hl2|platform|bin|core|config)$/i.test(dir)
    );
    const chosenMod = exactMatch || nonBaseMod || modDirs[0];
    return chosenMod ? `-game ${chosenMod} -steam` : undefined;
  } catch {
    return undefined;
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


/**
 * Discover all Steam root directories and steamapps folders across macOS, Windows, VDF libraries, and Wine/CrossOver bottles
 */
function discoverSteamLocations(options = {}) {
  const homedir = options.homedir || os.homedir();
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const isIsolatedTest = Boolean(options.homedir || (options.customRoots && options.customRoots.length > 0));

  const candidateSteamRoots = [
    path.join(homedir, 'Library/Application Support/Steam'),
    path.join(homedir, '.local/share/Steam'),
    path.join(homedir, '.steam/steam'),
    ...customRoots,
  ];

  // Also check CrossOver bottles for Windows Steam installations on macOS
  const bottleContainers = [
    path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
  ];

  for (const bottlesDir of bottleContainers) {
    if (!fs.existsSync(bottlesDir)) continue;
    try {
      const entries = fs.readdirSync(bottlesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        candidateSteamRoots.push(
          path.join(bottlesDir, entry.name, 'drive_c/Program Files (x86)/Steam'),
          path.join(bottlesDir, entry.name, 'drive_c/Program Files/Steam')
        );
      }
    } catch {}
  }

  if (!isIsolatedTest) {
    candidateSteamRoots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  }

  const steamRoots = new Set();
  const steamappsDirs = new Set();

  const addSteamRootCandidate = (dir) => {
    const resolved = toLocalFsPath(dir, customRoots);
    if (resolved && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          steamRoots.add(resolved);
        }
      } catch {}
    }
  };

  const addSteamappsCandidate = (dir) => {
    const resolved = toLocalFsPath(dir, customRoots);
    if (resolved && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          steamappsDirs.add(resolved);
          addSteamRootCandidate(path.dirname(resolved));
        }
      } catch {}
    }
  };

  const inspectSteamRootForVdf = (rootDir) => {
    const localRoot = toLocalFsPath(rootDir, customRoots);
    if (!localRoot || !fs.existsSync(localRoot)) return;

    addSteamRootCandidate(localRoot);

    if (path.basename(localRoot).toLowerCase() === 'steamapps') {
      addSteamappsCandidate(localRoot);
    }
    addSteamappsCandidate(path.join(localRoot, 'steamapps'));
    addSteamappsCandidate(path.join(localRoot, 'Steam', 'steamapps'));

    // Also check if rootDir directly contains appmanifest_*.acf
    try {
      const rootFiles = fs.readdirSync(localRoot);
      if (rootFiles.some((f) => /^appmanifest_\d+\.acf$/i.test(f))) {
        addSteamappsCandidate(localRoot);
      }
    } catch {}

    const driveCMatch = localRoot.match(/^(.*?[\\/]drive_c)(?:[\\/]|$)/i);
    const bottleDriveCDir = driveCMatch ? driveCMatch[1] : null;
    const vdfCustomRoots = bottleDriveCDir ? [bottleDriveCDir, ...customRoots] : customRoots;

    const vdfLocations = [
      path.join(localRoot, 'steamapps', 'libraryfolders.vdf'),
      path.join(localRoot, 'libraryfolders.vdf'),
      path.join(localRoot, 'config', 'libraryfolders.vdf'),
      path.join(localRoot, 'Steam', 'steamapps', 'libraryfolders.vdf'),
    ];

    for (const vdfPath of vdfLocations) {
      if (fs.existsSync(vdfPath)) {
        try {
          const vdfContent = fs.readFileSync(vdfPath, 'utf8');
          const libPaths = parseSteamLibraryFoldersVdf(vdfContent);
          for (const lp of libPaths) {
            const candidateLibPaths = [toLocalFsPath(lp, vdfCustomRoots)];
            if (bottleDriveCDir && /^[Cc]:[\\/]/.test(lp)) {
              const driveStripped = lp
                .replace(/\\\\/g, '/')
                .replace(/\\/g, '/')
                .replace(/^[Cc]:\/+/, '');
              candidateLibPaths.push(path.join(bottleDriveCDir, driveStripped));
            } else if (/^[Zz]:[\\/]/.test(lp)) {
              const zPosix =
                '/' +
                lp
                  .replace(/\\\\/g, '/')
                  .replace(/\\/g, '/')
                  .replace(/^[Zz]:\/+/, '');
              candidateLibPaths.push(zPosix);
            }
            for (const resolvedLp of candidateLibPaths) {
              if (resolvedLp) {
                addSteamRootCandidate(resolvedLp);
                addSteamappsCandidate(path.join(resolvedLp, 'steamapps'));
                addSteamappsCandidate(resolvedLp);
              }
            }
          }
        } catch {}
      }
    }
  };

  for (const root of candidateSteamRoots) {
    inspectSteamRootForVdf(root);
  }

  return {
    steamRoots: Array.from(steamRoots),
    steamappsDirs: Array.from(steamappsDirs),
  };
}

/**
 * Load & save One Launcher managed installations (`one_launcher_installed.json`)
 */
function getManagedInstalledFilePath(userDataDir) {
  return path.join(getUserDataDir(userDataDir), 'one_launcher_installed.json');
}

function loadManagedInstalledGames(userDataDir) {
  const filePath = getManagedInstalledFilePath(userDataDir);
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let records = [];
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (parsed && typeof parsed === 'object') {
      records = Array.isArray(parsed.installedGames) ? parsed.installedGames : Object.values(parsed);
    }
    let modified = false;
    for (const r of records) {
      if (r && typeof r === 'object' && r.platformId && r.platformId !== 'steam' && r.appId !== undefined) {
        delete r.appId;
        modified = true;
      }
    }
    if (modified) {
      saveManagedInstalledGames(records, userDataDir);
    }
    return records;
  } catch {}
  return [];
}

function saveManagedInstalledGames(records, userDataDir) {
  const filePath = getManagedInstalledFilePath(userDataDir);
  try {
    atomicWriteFileSync(filePath, JSON.stringify(records, null, 2));
    invalidateScanCaches();
    return true;
  } catch {
    return false;
  }
}

function upsertManagedInstallRecord(record, userDataDir) {
  const cleanRecord = { ...record };
  if (cleanRecord.platformId !== 'steam') {
    delete cleanRecord.appId;
  }
  const existing = loadManagedInstalledGames(userDataDir);
  const idx = existing.findIndex(
    (r) =>
      r.platformId === cleanRecord.platformId &&
      String(r.platformGameId) === String(cleanRecord.platformGameId)
  );
  if (idx >= 0) {
    const merged = { ...existing[idx], ...cleanRecord };
    if (merged.platformId !== 'steam') {
      delete merged.appId;
    }
    existing[idx] = merged;
  } else {
    existing.push(cleanRecord);
  }
  saveManagedInstalledGames(existing, userDataDir);
  invalidateScanCaches();
  return existing;
}

/**
 * Load & save per-game launch configurations (`one_launcher_configs.json`)
 */
const LAUNCH_PROFILE_KEYS = [
  'launchMethod',
  'customExecutablePath',
  'workingDirectory',
  'launchArguments',
  'environmentVariables',
  'compatibilityLayer',
  'wineBottleName',
  'winePrefixPath',
  'crossoverGraphicsBackend',
  'crossoverD3DMetalVersion',
  'crossoverHighResolutionMode',
  'crossoverDlss',
  'wineMsync',
  'wineEsync',
  'metalHud',
  'dxvkHud',
  'wineDebug',
  'inGameLauncherBehavior',
  'storefrontClientLifecycle',
  'preLaunchCommand',
  'postExitCommand',
];

function resolvePlatformLaunchConfig(rawConfig, platformId) {
  if (!rawConfig || typeof rawConfig !== 'object') return {};
  const platMap =
    rawConfig.platformConfigs && typeof rawConfig.platformConfigs === 'object'
      ? rawConfig.platformConfigs
      : rawConfig.storefrontConfigs && typeof rawConfig.storefrontConfigs === 'object'
        ? rawConfig.storefrontConfigs
        : null;

  let resolved;
  if (platformId && platMap && platMap[platformId]) {
    resolved = {
      gameId: rawConfig.gameId,
      preferredPlatformId: platformId,
      launchMethod: 'auto',
      ...platMap[platformId],
    };
  } else if (
    platformId &&
    platMap &&
    Object.keys(platMap).length > 0 &&
    rawConfig.preferredPlatformId &&
    rawConfig.preferredPlatformId !== platformId
  ) {
    resolved = {
      gameId: rawConfig.gameId,
      preferredPlatformId: platformId,
      launchMethod: 'auto',
    };
  } else {
    resolved = { ...rawConfig };
  }
  if (resolved.compatibilityLayer === 'whisky') {
    resolved.compatibilityLayer = 'crossover';
  }
  if (resolved.launchMethod === 'custom') {
    resolved.launchMethod = 'auto';
  }
  return resolved;
}

function getLaunchConfigsFilePath(userDataDir) {
  return path.join(getUserDataDir(userDataDir), 'one_launcher_configs.json');
}

function getGameLaunchConfigs(options = {}) {
  const filePath = getLaunchConfigsFilePath(options.userDataDir);
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const shouldValidateFs = !options.userDataDir || options.pruneMissingExecutables === true;
      let modified = false;
      const archiveAssetRe =
        /\.(kpf|pak|wad|pk3|pk4|vpk|bsa|ba2|upk|uasset|umap|pck|bundle|assets|ress|resource|zip|7z|rar)$/i;
      for (const cfg of Object.values(parsed)) {
        if (!cfg || typeof cfg !== 'object') continue;
        if (cfg.compatibilityLayer === 'whisky') {
          cfg.compatibilityLayer = 'crossover';
          modified = true;
        }
        if (cfg.launchMethod === 'custom') {
          cfg.launchMethod = 'auto';
          modified = true;
        }
        if (shouldValidateFs && cfg.customExecutablePath) {
          const localExe = toLocalFsPath(cfg.customExecutablePath, options.customRoots);
          const isArchiveAsset = archiveAssetRe.test(String(localExe || ''));
          if (!localExe || isArchiveAsset || !fs.existsSync(localExe)) {
            delete cfg.customExecutablePath;
            modified = true;
          }
        }
        if (shouldValidateFs && cfg.workingDirectory) {
          const localDir = toLocalFsPath(cfg.workingDirectory, options.customRoots);
          if (!localDir || !fs.existsSync(localDir)) {
            delete cfg.workingDirectory;
            modified = true;
          }
        }
        if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
          for (const [, prof] of Object.entries(cfg.platformConfigs)) {
            if (!prof || typeof prof !== 'object') continue;
            if (prof.compatibilityLayer === 'whisky') {
              prof.compatibilityLayer = 'crossover';
              modified = true;
            }
            if (prof.launchMethod === 'custom') {
              prof.launchMethod = 'auto';
              modified = true;
            }
            if (shouldValidateFs && prof.customExecutablePath) {
              const localExe = toLocalFsPath(prof.customExecutablePath, options.customRoots);
              const isArchiveAsset = archiveAssetRe.test(String(localExe || ''));
              if (!localExe || isArchiveAsset || !fs.existsSync(localExe)) {
                delete prof.customExecutablePath;
                modified = true;
              }
            }
            if (shouldValidateFs && prof.workingDirectory) {
              const localDir = toLocalFsPath(prof.workingDirectory, options.customRoots);
              if (!localDir || !fs.existsSync(localDir)) {
                delete prof.workingDirectory;
                modified = true;
              }
            }
          }
        }
      }
      if (modified && (options.pruneMissingExecutables === true || options.persistPrunedConfigs === true)) {
        try {
          atomicWriteFileSync(filePath, JSON.stringify(parsed, null, 2));
        } catch {}
      }
      return parsed;
    }
  } catch {}
  return {};
}

function getGameLaunchConfig(gameId, options = {}) {
  if (!gameId) return null;
  const all = getGameLaunchConfigs(options);
  return all[gameId] || null;
}

function saveGameLaunchConfig(config, options = {}) {
  if (!config || !config.gameId) {
    return { success: false, error: 'Invalid launch config: missing gameId' };
  }
  const filePath = getLaunchConfigsFilePath(options.userDataDir);
  const existing = getGameLaunchConfigs(options);
  if (config.reset === true) {
    delete existing[config.gameId];
    try {
      atomicWriteFileSync(filePath, JSON.stringify(existing, null, 2));
      invalidateScanCaches();
      return { success: true, config: { gameId: config.gameId } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  const cleanProfile = {
    launchMethod: sanitizeLaunchMethod(config.launchMethod),
  };
  for (const key of LAUNCH_PROFILE_KEYS) {
    if (config[key] !== undefined && config[key] !== null) {
      cleanProfile[key] =
        key === 'compatibilityLayer' && config[key] === 'whisky'
          ? 'crossover'
          : key === 'launchMethod'
            ? sanitizeLaunchMethod(config[key])
            : config[key];
    }
  }

  const prevConfig = existing[config.gameId] || {};
  const mergedPlatformConfigs = {
    ...(prevConfig.platformConfigs && typeof prevConfig.platformConfigs === 'object'
      ? prevConfig.platformConfigs
      : {}),
  };

  if (config.platformConfigs && typeof config.platformConfigs === 'object') {
    for (const [platId, p] of Object.entries(config.platformConfigs)) {
      if (p && typeof p === 'object') {
        const cleanPlatProfile = { launchMethod: sanitizeLaunchMethod(p.launchMethod) };
        for (const key of LAUNCH_PROFILE_KEYS) {
          if (p[key] !== undefined && p[key] !== null) {
            cleanPlatProfile[key] =
              key === 'compatibilityLayer' && p[key] === 'whisky'
                ? 'crossover'
                : key === 'launchMethod'
                  ? sanitizeLaunchMethod(p[key])
                  : p[key];
          }
        }
        mergedPlatformConfigs[platId] = cleanPlatProfile;
      }
    }
  }

  if (config.resetPlatformId) {
    delete mergedPlatformConfigs[config.resetPlatformId];
  } else if (config.preferredPlatformId) {
    mergedPlatformConfigs[config.preferredPlatformId] = { ...cleanProfile };
  }

  const preferredPlatformId = config.preferredPlatformId || prevConfig.preferredPlatformId;
  const updated = {
    gameId: config.gameId,
    ...(preferredPlatformId ? { preferredPlatformId } : {}),
    ...cleanProfile,
  };

  for (const [k, v] of Object.entries(config)) {
    if (
      k === 'gameId' ||
      k === 'preferredPlatformId' ||
      k === 'reset' ||
      k === 'resetPlatformId' ||
      k === 'platformConfigs' ||
      LAUNCH_PROFILE_KEYS.includes(k)
    ) {
      continue;
    }
    if (v !== undefined && v !== null) {
      updated[k] = v;
    }
  }

  if (Object.keys(mergedPlatformConfigs).length > 0) {
    updated.platformConfigs = mergedPlatformConfigs;
  }

  existing[config.gameId] = updated;
  try {
    atomicWriteFileSync(filePath, JSON.stringify(existing, null, 2));
    invalidateScanCaches();
    return { success: true, config: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * In-Game Footprint Minimization & Performance Settings Persistence
 */
const DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS = {
  inGameLauncherBehavior: 'hide_tray_hibernate',
  postGameLauncherBehavior: 'restore_window',
  pauseBackgroundSyncInGame: true,
  pauseDownloadsInGame: true,
  storefrontClientLifecycle: 'minimal_and_close_if_started',
  autoShutdownWinePrefixOnExit: true,
  suppressWineDebugLogging: true,
};

const VALID_IN_GAME_BEHAVIORS = new Set([
  'keep_open',
  'minimize_taskbar',
  'hide_tray_hibernate',
  'zero_renderer_daemon',
]);

const VALID_POST_GAME_BEHAVIORS = new Set([
  'restore_window',
  'stay_minimized',
  'exit_launcher',
]);

const VALID_STOREFRONT_LIFECYCLES = new Set([
  'default_client',
  'minimal_keep_running',
  'minimal_and_close_if_started',
  'fast_direct_bypass',
]);

function normalizeStorefrontClientLifecycle(val) {
  if (val === 'shutdown_if_woken') return 'minimal_and_close_if_started';
  if (val === 'keep_running') return 'minimal_keep_running';
  return VALID_STOREFRONT_LIFECYCLES.has(val) ? val : null;
}

function getPerformanceSettingsFilePath(options = {}) {
  const customDir =
    options && typeof options === 'object'
      ? options.userDataDir || options.baseDir
      : typeof options === 'string'
        ? options
        : undefined;
  return path.join(getUserDataDir(customDir), 'one_launcher_performance_settings.json');
}

function sanitizeLauncherPerformanceSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const normStorefront = normalizeStorefrontClientLifecycle(src.storefrontClientLifecycle);
  return {
    inGameLauncherBehavior: VALID_IN_GAME_BEHAVIORS.has(src.inGameLauncherBehavior)
      ? src.inGameLauncherBehavior
      : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.inGameLauncherBehavior,
    postGameLauncherBehavior: VALID_POST_GAME_BEHAVIORS.has(src.postGameLauncherBehavior)
      ? src.postGameLauncherBehavior
      : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.postGameLauncherBehavior,
    pauseBackgroundSyncInGame:
      typeof src.pauseBackgroundSyncInGame === 'boolean'
        ? src.pauseBackgroundSyncInGame
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.pauseBackgroundSyncInGame,
    pauseDownloadsInGame:
      typeof src.pauseDownloadsInGame === 'boolean'
        ? src.pauseDownloadsInGame
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.pauseDownloadsInGame,
    storefrontClientLifecycle:
      normStorefront || DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
    autoShutdownWinePrefixOnExit:
      typeof src.autoShutdownWinePrefixOnExit === 'boolean'
        ? src.autoShutdownWinePrefixOnExit
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.autoShutdownWinePrefixOnExit,
    suppressWineDebugLogging:
      typeof src.suppressWineDebugLogging === 'boolean'
        ? src.suppressWineDebugLogging
        : DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.suppressWineDebugLogging,
  };
}

function getLauncherPerformanceSettings(options = {}) {
  const filePath = getPerformanceSettingsFilePath(options);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return sanitizeLauncherPerformanceSettings(parsed);
    }
  } catch {}
  return { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS };
}

function saveLauncherPerformanceSettings(settings = {}, options = {}) {
  const filePath = getPerformanceSettingsFilePath(options);
  const current = getLauncherPerformanceSettings(options);
  const merged =
    settings && settings.reset === true
      ? { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS }
      : sanitizeLauncherPerformanceSettings({ ...current, ...(settings || {}) });
  try {
    atomicWriteFileSync(filePath, JSON.stringify(merged, null, 2));
  } catch {}
  const result = { ...merged };
  Object.defineProperties(result, {
    success: { value: true, enumerable: false },
    settings: { value: merged, enumerable: false },
  });
  return result;
}

function resolveEffectivePerformancePolicy(launchConfig = {}, options = {}) {
  const base = getLauncherPerformanceSettings(options);
  const cfg = launchConfig && typeof launchConfig === 'object' ? launchConfig : {};

  const inGameOverride =
    cfg.inGameLauncherBehavior &&
    cfg.inGameLauncherBehavior !== 'default' &&
    VALID_IN_GAME_BEHAVIORS.has(cfg.inGameLauncherBehavior)
      ? cfg.inGameLauncherBehavior
      : base.inGameLauncherBehavior;

  const normCfgStorefront =
    cfg.storefrontClientLifecycle && cfg.storefrontClientLifecycle !== 'default'
      ? normalizeStorefrontClientLifecycle(cfg.storefrontClientLifecycle)
      : 'default';

  const storefrontOverride = resolveEffectiveLifecyclePolicy(
    normCfgStorefront || 'default',
    base.storefrontClientLifecycle
  );

  return {
    ...base,
    inGameLauncherBehavior: inGameOverride,
    storefrontClientLifecycle: storefrontOverride,
  };
}


/**
 * A) Multi-Storefront & Multi-Drive Installation Scanner
 */
function scanAllInstalledGames(options = {}) {
  try {
    const isDefaultProdScan =
      !options.homedir &&
      !options.customRoots &&
      !options.userDataDir &&
      !options.forceRefresh &&
      !options.syncFirstParty &&
      !options.eglManifestsDir &&
      !options.gogGalaxyConfigPath &&
      !options.gogGalaxyStorageDir;

    if (
      isDefaultProdScan &&
      lastProductionScanCache.result &&
      Date.now() - lastProductionScanCache.timestamp < 3000
    ) {
      const cachedInstalledGames = lastProductionScanCache.result.installedGames.map((g) => ({ ...g }));
      const cachedEpicSupport = { ...(lastProductionScanCache.result.epicPlatformSupport || {}) };
      try {
        Object.defineProperty(cachedInstalledGames, 'epicPlatformSupport', {
          value: cachedEpicSupport,
          enumerable: false,
          configurable: true,
        });
      } catch {}
      return {
        success: true,
        installedGames: cachedInstalledGames,
        installedSteamAppIds: [...lastProductionScanCache.result.installedSteamAppIds],
        epicPlatformSupport: cachedEpicSupport,
      };
    }

    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
    const userDataDir = getUserDataDir(options.userDataDir);
    const isIsolatedTest = Boolean(options.homedir || (options.customRoots && options.customRoots.length > 0));
    const launchConfigs = getGameLaunchConfigs({ userDataDir });

    const discoveredMap = new Map();
    const installedSteamAppIds = [];

    const addRecord = (record) => {
      if (!record || !record.platformId || !record.platformGameId) return;
      const key = `${record.platformId}:${record.platformGameId}`;
      const existing = discoveredMap.get(key);
      if (existing) {
        if (
          platform === 'darwin' &&
          ['steam', 'gog', 'epic'].includes(record.platformId) &&
          Boolean(existing.isWindowsBinaryOnMac) !== Boolean(record.isWindowsBinaryOnMac)
        ) {
          const platPrefixRe = new RegExp(`^${record.platformId}[-_]`, 'i');
          const cleanId = String(
            record.storefrontAppId || record.appId || record.platformGameId || ''
          ).replace(platPrefixRe, '');
          let rawSaved =
            launchConfigs[`${record.platformId}-${cleanId}`] ||
            launchConfigs[`${record.platformId}_${cleanId}`] ||
            launchConfigs[String(record.platformGameId)] ||
            launchConfigs[cleanId] ||
            null;
          if (!rawSaved && cleanId) {
            const lowerClean = cleanId.toLowerCase();
            for (const [cfgKey, cfgVal] of Object.entries(launchConfigs)) {
              if (!cfgVal || typeof cfgVal !== 'object') continue;
              const kLower = cfgKey.toLowerCase();
              if (
                kLower === `${record.platformId}-${lowerClean}` ||
                kLower === `${record.platformId}_${lowerClean}` ||
                kLower === lowerClean ||
                String(cfgVal.gameId || '').toLowerCase() === `${record.platformId}-${lowerClean}` ||
                Boolean(
                  cfgVal.platformConfigs &&
                    cfgVal.platformConfigs[record.platformId] &&
                    kLower.includes(lowerClean)
                )
              ) {
                rawSaved = cfgVal;
                break;
              }
            }
          }
          const savedCfg = resolvePlatformLaunchConfig(rawSaved || {}, record.platformId);
          const preferWinBottle = savedCfg?.launchMethod === 'compatibility_layer';
          const preferred = preferWinBottle
            ? record.isWindowsBinaryOnMac
              ? record
              : existing
            : !record.isWindowsBinaryOnMac
              ? record
              : existing;
          const secondary = preferred === record ? existing : record;
          discoveredMap.set(key, {
            ...secondary,
            ...preferred,
            executablePath: preferred.executablePath || secondary.executablePath,
            installPath: preferred.installPath || secondary.installPath,
            launchArguments: preferred.launchArguments || secondary.launchArguments,
            isWindowsBinaryOnMac: Boolean(preferred.isWindowsBinaryOnMac),
          });
        } else {
          discoveredMap.set(key, {
            ...existing,
            ...record,
            executablePath: record.executablePath || existing.executablePath,
            installPath: record.installPath || existing.installPath,
            launchArguments: record.launchArguments || existing.launchArguments,
          });
        }
      } else {
        discoveredMap.set(key, record);
      }
      if (record.platformId === 'steam') {
        const numId = Number(record.appId || record.platformGameId);
        if (numId > 0 && !installedSteamAppIds.includes(numId)) {
          installedSteamAppIds.push(numId);
        }
      }
    };

    // =========================================================================
    // 1. STEAM MULTI-LIBRARY SCANNER
    // =========================================================================
    const { steamappsDirs } = discoverSteamLocations(options);

    for (const steamappsDir of steamappsDirs) {
      let files = [];
      try {
        files = fs.readdirSync(steamappsDir);
      } catch {
        continue;
      }

      const isSteamappsInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(steamappsDir);
      const bottleRoot = isSteamappsInsideBottle ? extractBottleRootFromPath(steamappsDir) : null;

      for (const file of files) {
        if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
        const manifestPath = path.join(steamappsDir, file);
        let parsed = null;
        try {
          parsed = parseSteamAcf(fs.readFileSync(manifestPath, 'utf8'));
        } catch {}
        if (!parsed || !parsed.appId) continue;

        // Skip Steamworks Common Redistributables
        if (parsed.appId === 228980) continue;

        const installPath = parsed.installdir
          ? path.join(steamappsDir, 'common', parsed.installdir)
          : path.join(steamappsDir, 'common', String(parsed.appId));

        const dirExists = fs.existsSync(installPath);
        const stateFlags = parsed.StateFlags ? String(parsed.StateFlags).trim() : undefined;
        const bytesToDl = Number(parsed.BytesToDownload || 0);
        const bytesDl = Number(parsed.BytesDownloaded || 0);
        const isActivelyDownloading = Boolean(
          stateFlags && stateFlags !== '4' && bytesToDl > 0 && bytesDl < bytesToDl
        );

        // Verify common/<installdir> exists and is not mid-download
        if (isActivelyDownloading || !dirExists) {
          if (!dirExists && isSteamappsInsideBottle && !isActivelyDownloading) {
            try {
              fs.rmSync(manifestPath, { force: true });
            } catch {}
            try {
              removeSteamAppFromLibraryFoldersVdf(steamappsDir, parsed.appId);
            } catch {}
            try {
              cleanupCrossOverSteamShortcuts(
                parsed.appId,
                parsed.name,
                bottleRoot ? [bottleRoot] : [],
                options
              );
            } catch {}
          }
          continue;
        }

        const appInfoSpec = resolveSteamAppInfoLaunchSpec(
          steamappsDir,
          parsed.appId,
          installPath,
          { platform }
        );
        const exeDiscovery =
          appInfoSpec && appInfoSpec.executablePath
            ? {
                executablePath: appInfoSpec.executablePath,
                isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
              }
            : findPrimaryExecutable(installPath, { platform, hintName: parsed.name });

        // If common/<installdir> has zero valid executables (e.g. only cloud save/config leftovers after uninstall), do not report as installed
        if (!exeDiscovery.executablePath) {
          if (isSteamappsInsideBottle && !isActivelyDownloading) {
            try {
              fs.rmSync(manifestPath, { force: true });
            } catch {}
            try {
              if (isSafeToDeleteInstallPath(installPath, options)) {
                fs.rmSync(installPath, { recursive: true, force: true });
              }
            } catch {}
            try {
              removeSteamAppFromLibraryFoldersVdf(steamappsDir, parsed.appId);
            } catch {}
            try {
              cleanupCrossOverSteamShortcuts(
                parsed.appId,
                parsed.name,
                bottleRoot ? [bottleRoot] : [],
                options
              );
            } catch {}
          }
          continue;
        }

        const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(installPath);
        const launchArguments =
          appInfoSpec?.launchArguments ||
          resolveDefaultEngineLaunchArguments(installPath, exeDiscovery.executablePath);

        addRecord({
          platformId: 'steam',
          platformGameId: String(parsed.appId),
          appId: parsed.appId,
          title: parsed.name,
          name: parsed.name,
          installPath,
          executablePath: exeDiscovery.executablePath,
          ...(launchArguments ? { launchArguments } : {}),
          installSize: parsed.SizeOnDisk ? Number(parsed.SizeOnDisk) || undefined : undefined,
          version: parsed.buildid ? String(parsed.buildid) : undefined,
          manifestPath,
          runner: 'steam',
          isWindowsBinaryOnMac:
            Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
            (platform === 'darwin' && isInsideBottle),
        });
      }
    }

    // =========================================================================
    // 2. GOG.COM SCANNER (GOG Galaxy + Heroic + macOS /Applications + Managed)
    // =========================================================================
    const gogSearchDirs = new Set([
      path.join(homedir, 'Applications'),
      path.join(homedir, 'Games'),
      path.join(homedir, 'Games', 'OneLauncher', 'GOG'),
      path.join(homedir, 'Games', 'Heroic'),
      ...customRoots.map((r) => toLocalFsPath(r, customRoots)),
    ]);

    if (!isIsolatedTest) {
      gogSearchDirs.add('/Applications');
      gogSearchDirs.add('C:\\Program Files (x86)\\GOG Galaxy\\Games');
      gogSearchDirs.add('C:\\GOG Games');
      gogSearchDirs.add('C:\\Games\\OneLauncher\\GOG');
    }

    // Check GOG Galaxy config.json for custom libraryPath
    const gogGalaxyConfigs = [
      path.join(homedir, 'Library/Application Support/GOG.com/Galaxy/config.json'),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'config.json')),
    ];
    if (!isIsolatedTest) {
      gogGalaxyConfigs.push(
        '/Users/Shared/GOG.com/Galaxy/config.json',
        'C:\\ProgramData\\GOG.com\\Galaxy\\config.json'
      );
    }
    for (const cfgPath of gogGalaxyConfigs) {
      if (fs.existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          if (cfg.libraryPath) {
            gogSearchDirs.add(toLocalFsPath(cfg.libraryPath, customRoots));
          }
          if (Array.isArray(cfg.installed)) {
            for (const item of cfg.installed) {
              if (item.installPath) {
                gogSearchDirs.add(toLocalFsPath(item.installPath, customRoots));
              }
            }
          }
        } catch {}
      }
    }

    const parseGogInfoFile = (infoFilePath) => {
      try {
        const raw = JSON.parse(fs.readFileSync(infoFilePath, 'utf8'));
        const fileMatch = path.basename(infoFilePath).match(/^goggame-(\d+)\.info$/i);
        const gameId = String(raw.gameId || raw.rootGameId || (fileMatch ? fileMatch[1] : ''));
        if (!gameId) return;

        const title = String(raw.name || raw.title || `GOG Game ${gameId}`);
        if (/^(steam|epic|custom)-\d+$/i.test(title)) return;
        let installPath = path.dirname(infoFilePath);

        // If inside <App>.app/Contents/Resources/goggame-<id>.info, resolve to <App>.app or parent game folder
        const normInfoDir = installPath.replace(/\\/g, '/');
        if (normInfoDir.endsWith('/Contents/Resources')) {
          const appBundleDir = path.resolve(installPath, '..', '..');
          const parentOfApp = path.dirname(appBundleDir);
          const parentBase = path.basename(parentOfApp).toLowerCase();
          if (
            parentOfApp &&
            !/^(applications|gog|heroic|games|onelauncher)$/i.test(parentBase) &&
            /[\\/](OneLauncher[\\/]GOG|GOG Galaxy[\\/]Games|Heroic)[\\/]/i.test(appBundleDir)
          ) {
            installPath = parentOfApp;
          } else {
            installPath = appBundleDir;
          }
        }

        let executablePath = undefined;
        let launchArguments = undefined;
        let isWindowsBinaryOnMac = false;

        if (Array.isArray(raw.playTasks)) {
          const isFileTask = (t) =>
            Boolean(t && t.path && (!t.type || String(t.type) === 'FileTask'));
          const primaryTask =
            raw.playTasks.find((t) => isFileTask(t) && t.isPrimary) ||
            raw.playTasks.find((t) => isFileTask(t) && t.category === 'game') ||
            raw.playTasks.find((t) => isFileTask(t));
          if (primaryTask && primaryTask.path) {
            if (
              primaryTask.arguments &&
              typeof primaryTask.arguments === 'string' &&
              primaryTask.arguments.trim()
            ) {
              launchArguments = primaryTask.arguments.trim();
            }
            const relTaskPath = primaryTask.path.replace(/\\/g, path.sep);
            const candidates = [
              path.join(installPath, relTaskPath),
              path.join(path.dirname(infoFilePath), relTaskPath),
              path.join(path.resolve(path.dirname(infoFilePath), '..', '..'), relTaskPath),
            ];
            for (const c of candidates) {
              if (fs.existsSync(c)) {
                const resolvedCand = c.endsWith('.app') ? resolveMacAppBundleBinary(c) : c;
                if (platform === 'darwin' && /[\\/]GOGLauncher$/i.test(resolvedCand)) {
                  continue;
                }
                if (
                  platform === 'darwin' &&
                  resolvedCand &&
                  !resolvedCand.toLowerCase().endsWith('.exe') &&
                  inspectMacMachOHeader(resolvedCand).is32BitOnly
                ) {
                  continue;
                }
                executablePath = resolvedCand;
                break;
              }
            }
          }
        }

        if (!executablePath) {
          const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
          executablePath = discovered.executablePath;
          isWindowsBinaryOnMac = discovered.isWindowsBinaryOnMac;
        } else if (platform === 'darwin' && executablePath.toLowerCase().endsWith('.exe')) {
          isWindowsBinaryOnMac = true;
        }

        addRecord({
          platformId: 'gog',
          platformGameId: gameId,
          title,
          installPath,
          executablePath,
          ...(launchArguments ? { launchArguments } : {}),
          version: raw.version ? String(raw.version) : raw.buildId ? String(raw.buildId) : undefined,
          manifestPath: infoFilePath,
          runner: 'gog',
          isWindowsBinaryOnMac,
        });
      } catch {}
    };

    const scanDirForGogInfo = (dirPath, depth = 0) => {
      if (depth > 3 || !dirPath || !fs.existsSync(dirPath)) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dirPath, entry.name);
        if (entry.isFile() && /^goggame-\d+\.info$/i.test(entry.name)) {
          parseGogInfoFile(full);
        } else if (entry.isDirectory()) {
          if (entry.name.toLowerCase().endsWith('.app')) {
            // Check Contents/Resources inside .app bundle
            const resDir = path.join(full, 'Contents', 'Resources');
            if (fs.existsSync(resDir)) {
              try {
                const resFiles = fs.readdirSync(resDir);
                for (const rf of resFiles) {
                  if (/^goggame-\d+\.info$/i.test(rf)) {
                    parseGogInfoFile(path.join(resDir, rf));
                  }
                }
              } catch {}
            }
          } else if (dirPath !== '/Applications') {
            scanDirForGogInfo(full, depth + 1);
          }
        }
      }
    };

    for (const gogDir of gogSearchDirs) {
      scanDirForGogInfo(gogDir, 0);
    }

    // Heroic GOG installed.json + One Launcher gog_store/installed.json
    const heroicGogFiles = [
      path.join(userDataDir, 'gog_store/installed.json'),
      path.join(homedir, 'Library/Application Support/heroic/gog_store/installed.json'),
      path.join(homedir, '.config/heroic/gog_store/installed.json'),
      path.join(homedir, 'AppData/Roaming/heroic/gog_store/installed.json'),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'gog_store/installed.json')),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'heroic/gog_store/installed.json')),
    ];

    for (const hgFile of heroicGogFiles) {
      if (!fs.existsSync(hgFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(hgFile, 'utf8'));
        const list = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.installed)
            ? raw.installed
            : Object.values(raw || {});
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const gameId = String(item.appName || item.gameId || item.id || '');
          const rawInstallPath = item.install_path || item.installPath;
          if (!gameId || !rawInstallPath) continue;
          const installPath = toLocalFsPath(rawInstallPath, customRoots);
          if (!installPath || !fs.existsSync(installPath)) continue;
          const title = item.title || item.name || `GOG Game ${gameId}`;
          const isWindowsGogItem =
            platform === 'darwin' && String(item.platform || '').toLowerCase() === 'windows';
          const discovered = findPrimaryExecutable(installPath, {
            platform,
            hintName: title,
            preferWindowsExecutable: isWindowsGogItem,
          });
          const itemExeCandidate = item.executable
            ? toLocalFsPath(item.executable, customRoots)
            : '';
          const resolvedHeroicExe =
            itemExeCandidate && fs.existsSync(itemExeCandidate)
              ? itemExeCandidate
              : discovered.executablePath || itemExeCandidate || undefined;
          const isWinOnMac =
            discovered.isWindowsBinaryOnMac ||
            isWindowsGogItem ||
            Boolean(
              platform === 'darwin' &&
                resolvedHeroicExe &&
                resolvedHeroicExe.toLowerCase().endsWith('.exe')
            );

          addRecord({
            platformId: 'gog',
            platformGameId: gameId,
            title,
            installPath,
            executablePath: resolvedHeroicExe,
            installSize: item.install_size ? Number(item.install_size) || undefined : undefined,
            version: item.version ? String(item.version) : undefined,
            manifestPath: hgFile,
            runner: 'gogdl',
            isWindowsBinaryOnMac: isWinOnMac,
          });
        }
      } catch {}
    }

    // =========================================================================
    // 3. EPIC GAMES STORE SCANNER (Epic Games Launcher + Heroic / Legendary)
    // =========================================================================
    const epicManifestDirs = new Set([
      path.join(homedir, 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests'),
      path.join(homedir, 'ProgramData/Epic/EpicGamesLauncher/Data/Manifests'),
    ]);
    if (!isIsolatedTest) {
      epicManifestDirs.add('C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests');
    }
    for (const root of customRoots) {
      const localRoot = toLocalFsPath(root, customRoots);
      if (!localRoot) continue;
      epicManifestDirs.add(localRoot);
      epicManifestDirs.add(path.join(localRoot, 'Manifests'));
      epicManifestDirs.add(path.join(localRoot, 'Data', 'Manifests'));
      epicManifestDirs.add(path.join(localRoot, 'Epic/EpicGamesLauncher/Data/Manifests'));
      epicManifestDirs.add(path.join(localRoot, 'ProgramData/Epic/EpicGamesLauncher/Data/Manifests'));
    }

    for (const manifestDir of epicManifestDirs) {
      if (!fs.existsSync(manifestDir)) continue;
      let files = [];
      try {
        files = fs.readdirSync(manifestDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.toLowerCase().endsWith('.item')) continue;
        const itemPath = path.join(manifestDir, file);
        try {
          const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
          if (item.bIsIncompleteInstall === true) continue;

          const appName = String(item.AppName || item.CatalogItemId || '');
          if (!appName) continue;

          const title = String(item.DisplayName || appName);
          const installPath = toLocalFsPath(item.InstallLocation || '', customRoots);
          if (!installPath) continue;

          let executablePath = undefined;
          let isWindowsBinaryOnMac = false;

          if (item.LaunchExecutable) {
            const cleanLaunchExe = String(item.LaunchExecutable).replace(/\\/g, path.sep);
            const candidateExe = path.join(installPath, cleanLaunchExe);
            if (fs.existsSync(candidateExe)) {
              executablePath = candidateExe.endsWith('.app')
                ? resolveMacAppBundleBinary(candidateExe)
                : candidateExe;
            } else {
              const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
              executablePath = discovered.executablePath || candidateExe;
              isWindowsBinaryOnMac = discovered.isWindowsBinaryOnMac;
            }
          } else {
            const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
            executablePath = discovered.executablePath;
            isWindowsBinaryOnMac = discovered.isWindowsBinaryOnMac;
          }

          if (platform === 'darwin' && executablePath && executablePath.toLowerCase().endsWith('.exe')) {
            isWindowsBinaryOnMac = true;
          }

          const launchArguments =
            item.LaunchCommand && typeof item.LaunchCommand === 'string'
              ? item.LaunchCommand.trim()
              : '';

          if (Boolean(options.userDataDir) || !isIsolatedTest) {
            recordImportedEpicInstall(
              { appName, installPath, source: itemPath },
              { userDataDir }
            );
          }

          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title,
            installPath,
            executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            installSize: item.InstallSize ? Number(item.InstallSize) || undefined : undefined,
            version: item.AppVersionString ? String(item.AppVersionString) : undefined,
            manifestPath: itemPath,
            runner: 'epic',
            isWindowsBinaryOnMac,
          });
        } catch {}
      }
    }

    // Epic LauncherInstalled.dat
    const launcherInstalledFiles = [
      path.join(homedir, 'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat'),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'LauncherInstalled.dat')),
      ...customRoots.map((r) =>
        path.join(toLocalFsPath(r, customRoots), 'Epic/UnrealEngineLauncher/LauncherInstalled.dat')
      ),
    ];
    if (!isIsolatedTest) {
      launcherInstalledFiles.push('C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat');
    }

    for (const datFile of launcherInstalledFiles) {
      if (!fs.existsSync(datFile)) continue;
      try {
        const dat = JSON.parse(fs.readFileSync(datFile, 'utf8'));
        const list = Array.isArray(dat?.InstallationList) ? dat.InstallationList : [];
        for (const entry of list) {
          const appName = String(entry.AppName || entry.ArtifactId || '');
          if (!appName || appName.startsWith('UE_')) continue;
          const installPath = toLocalFsPath(entry.InstallLocation || '', customRoots);
          if (!installPath) continue;

          if (Boolean(options.userDataDir) || !isIsolatedTest) {
            recordImportedEpicInstall(
              { appName, installPath, source: datFile },
              { userDataDir }
            );
          }

          const discovered = findPrimaryExecutable(installPath, { platform, hintName: appName });
          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title: entry.DisplayName || path.basename(installPath) || appName,
            installPath,
            executablePath: discovered.executablePath,
            version: entry.AppVersion ? String(entry.AppVersion) : undefined,
            manifestPath: datFile,
            runner: 'epic',
            isWindowsBinaryOnMac: discovered.isWindowsBinaryOnMac,
          });
        }
      } catch {}
    }

    // Heroic / Legendary installed.json + One Launcher legendaryConfig/legendary/installed.json
    const managedLegendaryInstalledPath = path.resolve(
      path.join(userDataDir, 'legendaryConfig/legendary/installed.json')
    );
    const legendaryFiles = [
      path.join(userDataDir, 'legendaryConfig/legendary/installed.json'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'),
      path.join(homedir, '.config/legendary/installed.json'),
      path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary/installed.json'),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'installed.json')),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'legendary/installed.json')),
      ...customRoots.map((r) =>
        path.join(toLocalFsPath(r, customRoots), 'heroic/legendaryConfig/legendary/installed.json')
      ),
    ];

    for (const legFile of legendaryFiles) {
      if (!fs.existsSync(legFile)) continue;
      const isExternalLegFile = path.resolve(legFile) !== managedLegendaryInstalledPath;
      try {
        const raw = JSON.parse(fs.readFileSync(legFile, 'utf8'));
        const entries = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
            ? Object.entries(raw).map(([k, v]) => (v && typeof v === 'object' ? { app_name: k, ...v } : null))
            : [];

        for (const item of entries) {
          if (!item || typeof item !== 'object') continue;
          const appName = String(item.app_name || item.appName || '');
          const rawInstallPath = item.install_path || item.installPath;
          if (!appName || !rawInstallPath) continue;

          const installPath = toLocalFsPath(rawInstallPath, customRoots);
          if (isExternalLegFile && (Boolean(options.userDataDir) || !isIsolatedTest)) {
            recordImportedEpicInstall(
              { appName, installPath, source: legFile },
              { userDataDir }
            );
          }

          const title = String(item.title || appName);
          let executablePath = undefined;
          if (item.executable) {
            const cleanExe = String(item.executable).replace(/\\/g, path.sep);
            const candidate = path.isAbsolute(cleanExe) ? cleanExe : path.join(installPath, cleanExe);
            executablePath = toLocalFsPath(candidate, customRoots);
          }
          const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
          if (!executablePath || !fs.existsSync(executablePath)) {
            executablePath = discovered.executablePath || executablePath;
          }

          const isWindowsBinaryOnMac =
            discovered.isWindowsBinaryOnMac ||
            (platform === 'darwin' &&
              (String(item.platform || '').toLowerCase() === 'windows' ||
                Boolean(executablePath && executablePath.toLowerCase().endsWith('.exe'))));

          const launchArguments =
            item.launch_parameters && typeof item.launch_parameters === 'string'
              ? item.launch_parameters.trim()
              : '';

          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title,
            installPath,
            executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            installSize: item.install_size ? Number(item.install_size) || undefined : undefined,
            version: item.version ? String(item.version) : undefined,
            manifestPath: legFile,
            runner: 'legendary',
            isWindowsBinaryOnMac,
          });
        }
      } catch {}
    }

    // =========================================================================
    // 4. ONE LAUNCHER MANAGED INSTALLS & CUSTOM LAUNCH CONFIG OVERRIDES
    // =========================================================================
    const managedRecords = loadManagedInstalledGames(userDataDir);
    const validManagedRecords = [];
    let managedPruned = false;
    for (const rec of managedRecords) {
      if (!rec || !rec.platformId || !rec.platformGameId) continue;
      const localInstall = toLocalFsPath(rec.installPath, customRoots);
      if (localInstall && fs.existsSync(localInstall)) {
        const existingKey = `${rec.platformId}:${rec.platformGameId}`;
        const existingDiscovered = discoveredMap.get(existingKey);
        const isSameInstallDir = Boolean(
          existingDiscovered &&
            existingDiscovered.installPath &&
            path.resolve(existingDiscovered.installPath) === path.resolve(localInstall)
        );
        const matchedDiscovered = isSameInstallDir ? existingDiscovered : null;
        const recExeLocal = rec.executablePath ? toLocalFsPath(rec.executablePath, customRoots) : '';
        const isRecExeValid =
          Boolean(recExeLocal) &&
          fs.existsSync(recExeLocal) &&
          !isExcludedExecutable(path.basename(recExeLocal)) &&
          !/\.com$/i.test(recExeLocal);
        const discovered =
          matchedDiscovered && matchedDiscovered.executablePath
            ? {
                executablePath: matchedDiscovered.executablePath,
                isWindowsBinaryOnMac: matchedDiscovered.isWindowsBinaryOnMac,
              }
            : findPrimaryExecutable(localInstall, { platform, hintName: rec.title });
        const effectiveExe =
          matchedDiscovered?.executablePath ||
          (isRecExeValid ? recExeLocal : undefined) ||
          discovered.executablePath;
        if (!effectiveExe || !fs.existsSync(effectiveExe)) {
          managedPruned = true;
          continue;
        }
        const effectiveLaunchArgs =
          matchedDiscovered?.launchArguments ||
          rec.launchArguments ||
          resolveDefaultEngineLaunchArguments(localInstall, effectiveExe);
        const inferredWinOnMac =
          matchedDiscovered?.isWindowsBinaryOnMac !== undefined
            ? matchedDiscovered.isWindowsBinaryOnMac
            : rec.isWindowsBinaryOnMac !== undefined
              ? rec.isWindowsBinaryOnMac
              : Boolean(
                  discovered.isWindowsBinaryOnMac ||
                    (platform === 'darwin' &&
                      ((effectiveExe && /\.exe$/i.test(effectiveExe)) ||
                        /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
                          String(effectiveExe || rec.installPath || '')
                        )))
                );
        validManagedRecords.push({
          ...rec,
          installPath: localInstall,
          executablePath: effectiveExe,
          isWindowsBinaryOnMac: inferredWinOnMac,
        });
        addRecord({
          ...rec,
          installPath: localInstall,
          executablePath: effectiveExe,
          ...(effectiveLaunchArgs ? { launchArguments: effectiveLaunchArgs } : {}),
          runner: matchedDiscovered?.runner || rec.runner || 'one_launcher',
          isWindowsBinaryOnMac: inferredWinOnMac,
        });
      } else {
        managedPruned = true;
      }
    }
    if (managedPruned) {
      try {
        saveManagedInstalledGames(validManagedRecords, userDataDir);
      } catch {}
    }

    for (const cfg of Object.values(launchConfigs)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const customEntries = [];
      const seenPlatExe = new Set();

      if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
        for (const [platId, prof] of Object.entries(cfg.platformConfigs)) {
          if (!prof || typeof prof !== 'object' || !prof.customExecutablePath) continue;
          const customExe = toLocalFsPath(prof.customExecutablePath, customRoots);
          if (!customExe) continue;
          const dedupeKey = `${platId}:${customExe}`;
          if (seenPlatExe.has(dedupeKey)) continue;
          seenPlatExe.add(dedupeKey);
          customEntries.push({
            platId,
            customExe,
            workingDirectory: prof.workingDirectory,
          });
        }
      }

      if (cfg.customExecutablePath) {
        const platId = cfg.preferredPlatformId || 'custom';
        const customExe = toLocalFsPath(cfg.customExecutablePath, customRoots);
        if (customExe) {
          const dedupeKey = `${platId}:${customExe}`;
          if (!seenPlatExe.has(dedupeKey)) {
            seenPlatExe.add(dedupeKey);
            customEntries.push({
              platId,
              customExe,
              workingDirectory: cfg.workingDirectory,
            });
          }
        }
      }

      for (const entry of customEntries) {
        const { platId, customExe, workingDirectory } = entry;
        if (customExe && fs.existsSync(customExe)) {
          const platformGameId = String(cfg.gameId).replace(/^(steam|gog|epic|custom)-/, '');
          const installPath = workingDirectory
            ? toLocalFsPath(workingDirectory, customRoots)
            : path.dirname(customExe);
          const alreadyDiscovered = Array.from(discoveredMap.values()).some(
            (r) =>
              r &&
              (platId === 'custom' || r.platformId === platId) &&
              ((installPath && r.installPath === installPath) ||
                (customExe && r.executablePath === customExe))
          );
          if (alreadyDiscovered) continue;
          addRecord({
            platformId: platId,
            platformGameId,
            storefrontAppId: String(cfg.gameId),
            title: cfg.title || String(cfg.gameId),
            installPath,
            executablePath: customExe,
            runner: 'custom',
            isWindowsBinaryOnMac: platform === 'darwin' && customExe.toLowerCase().endsWith('.exe'),
          });
        }
      }
    }

    const installedGames = Array.from(discoveredMap.values());
    const { epicPlatformSupport } = collectLocalEpicMetadataAndSupport(options);
    try {
      Object.defineProperty(installedGames, 'epicPlatformSupport', {
        value: epicPlatformSupport,
        enumerable: false,
        configurable: true,
      });
    } catch {}

    if (!options.skipFirstPartySync) {
      const epicFingerprint = installedGames
        .filter((g) => g && g.platformId === 'epic')
        .map((g) => `${g.platformGameId}:${g.installPath}`)
        .sort()
        .join('|');
      const gogFingerprint = installedGames
        .filter((g) => g && g.platformId === 'gog' && g.runner !== 'custom' && g.installPath)
        .map((g) => `${g.platformGameId}:${g.installPath}`)
        .sort()
        .join('|');

      const runFirstPartySyncSynchronously = Boolean(
        options.homedir ||
          options.syncFirstParty === true ||
          options.eglManifestsDir ||
          options.gogGalaxyConfigPath ||
          options.gogGalaxyStorageDir
      );

      if (runFirstPartySyncSynchronously) {
        try {
          if (installedGames.some((g) => g && g.platformId === 'epic')) {
            syncEpicFirstPartyLauncher(options);
          }
        } catch {}
        try {
          for (const g of installedGames) {
            if (g && g.platformId === 'gog' && g.runner !== 'custom' && g.installPath) {
              syncGogFirstPartyLauncher(g, { ...options, fromAutoScan: true });
            }
          }
        } catch {}
      } else {
        if (epicFingerprint && epicFingerprint !== lastSyncedEpicFingerprint) {
          lastSyncedEpicFingerprint = epicFingerprint;
          setImmediate(() => {
            try {
              syncEpicFirstPartyLauncher(options);
            } catch {}
          });
        }
        if (gogFingerprint && gogFingerprint !== lastSyncedGogFingerprint) {
          lastSyncedGogFingerprint = gogFingerprint;
          setImmediate(() => {
            try {
              for (const g of installedGames) {
                if (g && g.platformId === 'gog' && g.runner !== 'custom' && g.installPath) {
                  syncGogFirstPartyLauncher(g, { ...options, fromAutoScan: true });
                }
              }
            } catch {}
          });
        }
      }
    }

    if (isDefaultProdScan) {
      lastProductionScanCache = {
        timestamp: Date.now(),
        result: { installedGames, installedSteamAppIds, epicPlatformSupport },
      };
    }

    return {
      success: true,
      installedGames,
      installedSteamAppIds,
      epicPlatformSupport,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      installedGames: [],
      installedSteamAppIds: [],
      epicPlatformSupport: {},
    };
  }
}

/**
 * Resolve Epic Games Launcher Manifests directory and LauncherInstalled.dat path
 */
function resolveEpicFirstPartyPaths(options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  if (
    options.homedir &&
    !options.eglManifestsDir &&
    !options.eglLauncherInstalledPath &&
    !options.eglLauncherInstalledDat
  ) {
    return { eglManifestsDir: null, eglLauncherInstalledPath: null, isolatedNoOp: true };
  }

  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const eglManifestsDir =
    options.eglManifestsDir ||
    (!options.homedir
      ? platform === 'win32'
        ? path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
        : path.join(homedir, 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests')
      : null);

  const eglLauncherInstalledPath =
    options.eglLauncherInstalledPath ||
    options.eglLauncherInstalledDat ||
    (!options.homedir
      ? platform === 'win32'
        ? path.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
        : path.join(homedir, 'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat')
      : null);

  return { eglManifestsDir, eglLauncherInstalledPath, isolatedNoOp: false };
}

/**
 * Synchronize installed Epic games into Epic Games Launcher (.item manifests + LauncherInstalled.dat)
 */
function syncEpicFirstPartyLauncher(options = {}) {
  try {
    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const userDataDir = getUserDataDir(options.userDataDir);
    const { eglManifestsDir, eglLauncherInstalledPath, isolatedNoOp } = resolveEpicFirstPartyPaths(options);

    if (isolatedNoOp || (!eglManifestsDir && !eglLauncherInstalledPath)) {
      return { synced: 0 };
    }

    // 1. Collect all installed Epic games from Legendary installed.json files & managed records
    const epicGamesMap = new Map();
    const installPathToAppName = new Map();

    const legendaryDirs = [
      path.join(userDataDir, 'legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
      path.join(homedir, '.config/legendary'),
      path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary'),
    ];
    const legendaryInstalledFiles = legendaryDirs.map((d) => path.join(d, 'installed.json'));

    for (const legFile of legendaryInstalledFiles) {
      if (!fs.existsSync(legFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(legFile, 'utf8'));
        const entries = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
            ? Object.entries(raw).map(([k, v]) => (v && typeof v === 'object' ? { app_name: k, ...v } : null))
            : [];
        for (const item of entries) {
          if (!item || typeof item !== 'object') continue;
          const appName = String(item.app_name || item.appName || '').replace(/^epic[-_]/i, '').trim();
          const rawInstallPath = item.install_path || item.installPath;
          if (!appName || !rawInstallPath) continue;
          const installPath = toLocalFsPath(rawInstallPath);
          if (!installPath || !fs.existsSync(installPath)) continue;

          epicGamesMap.set(appName, {
            ...item,
            appName,
            installPath,
            title: item.title || appName,
            version: item.version || '1.0',
            install_size: item.install_size || item.installSize || 0,
            _legFile: legFile,
          });
          installPathToAppName.set(path.resolve(installPath), appName);
        }
      } catch {}
    }

    const managedRecords = loadManagedInstalledGames(userDataDir);
    for (const rec of managedRecords) {
      if (!rec || rec.platformId !== 'epic' || !rec.installPath) continue;
      const installPath = toLocalFsPath(rec.installPath);
      if (!installPath || !fs.existsSync(installPath)) continue;
      const resolvedPathKey = path.resolve(installPath);
      const canonicalAppName =
        installPathToAppName.get(resolvedPathKey) ||
        String(rec.platformGameId || '').replace(/^epic[-_]/i, '').trim();
      if (!canonicalAppName) continue;

      const existing = epicGamesMap.get(canonicalAppName) || {};
      epicGamesMap.set(canonicalAppName, {
        ...existing,
        appName: canonicalAppName,
        installPath,
        title: existing.title || rec.title || canonicalAppName,
        executablePath: rec.executablePath || existing.executablePath,
        version: existing.version || rec.version || '1.0',
        install_size: existing.install_size || rec.installSize || 0,
      });
      installPathToAppName.set(resolvedPathKey, canonicalAppName);
    }

    // 2. Run `legendary egl-sync --export-only` asynchronously only when explicitly requested
    if (options.runLegendaryEglSync === true && !options.skipLegendaryCliSync && !options.homedir && eglManifestsDir) {
      const legendaryBin = findLegendaryBinary(options);
      if (legendaryBin) {
        try {
          fs.mkdirSync(eglManifestsDir, { recursive: true });
          execFile(
            legendaryBin,
            ['egl-sync', '-y', '--one-shot', '--export-only', '--egl-manifest-path', eglManifestsDir],
            {
              env: {
                ...process.env,
                LEGENDARY_CONFIG_PATH: path.join(userDataDir, 'legendaryConfig', 'legendary'),
                LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
                LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
              },
              timeout: 10000,
            },
            () => {}
          );
        } catch {}
      }
    }

    // 3. Direct Node.js .item + .mancpn + .manifest Synthesis & Verification
    let syncedCount = 0;
    if (eglManifestsDir) {
      fs.mkdirSync(eglManifestsDir, { recursive: true });
      const existingItems = [];
      try {
        const files = fs.readdirSync(eglManifestsDir);
        for (const f of files) {
          if (!f.toLowerCase().endsWith('.item')) continue;
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(eglManifestsDir, f), 'utf8'));
            if (parsed && typeof parsed === 'object') {
              existingItems.push({ ...parsed, _fileName: f });
            }
          } catch {}
        }
      } catch {}

      const metadataDirs = legendaryDirs.map((d) => path.join(d, 'metadata'));

      // Load assets.json fallback map for catalog_item_id & namespace
      const assetsCatalogMap = new Map();
      for (const legDir of legendaryDirs) {
        const assetsFile = path.join(legDir, 'assets.json');
        if (!fs.existsSync(assetsFile)) continue;
        try {
          const rawAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
          const assetLists = [];
          if (Array.isArray(rawAssets)) {
            assetLists.push(rawAssets);
          } else if (rawAssets && typeof rawAssets === 'object') {
            for (const val of Object.values(rawAssets)) {
              if (Array.isArray(val)) assetLists.push(val);
            }
          }
          for (const list of assetLists) {
            for (const asset of list) {
              if (!asset || typeof asset !== 'object') continue;
              const aName = String(asset.app_name || asset.appName || '').trim();
              if (!aName || assetsCatalogMap.has(aName)) continue;
              const cid = asset.catalog_item_id || asset.catalogItemId || '';
              const cns = asset.namespace || asset.catalogNamespace || '';
              if (cid || cns) {
                assetsCatalogMap.set(aName, { catalogItemId: cid, catalogNamespace: cns });
              }
            }
          }
        } catch {}
      }

      for (const [appName, entry] of epicGamesMap.entries()) {
        const installPath = entry.installPath;
        if (!installPath || !fs.existsSync(installPath)) continue;

        let meta = null;
        for (const metaDir of metadataDirs) {
          const metaFile = path.join(metaDir, `${appName}.json`);
          if (fs.existsSync(metaFile)) {
            try {
              meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
              if (meta) break;
            } catch {}
          }
        }

        const assetsFallback = assetsCatalogMap.get(appName);
        const catalogItemId =
          meta?.asset_infos?.Windows?.catalog_item_id ||
          meta?.asset_infos?.Mac?.catalog_item_id ||
          meta?.metadata?.id ||
          meta?.id ||
          meta?.app_info?.id ||
          entry.catalog_item_id ||
          entry.catalogItemId ||
          assetsFallback?.catalogItemId ||
          '';
        const catalogNamespace =
          meta?.asset_infos?.Windows?.namespace ||
          meta?.asset_infos?.Mac?.namespace ||
          meta?.metadata?.namespace ||
          meta?.achievements?.namespace ||
          meta?.namespace ||
          meta?.app_info?.namespace ||
          entry.namespace ||
          entry.catalogNamespace ||
          assetsFallback?.catalogNamespace ||
          '';

        // Search for binary .manifest file in Legendary manifests directories
        const manifestSearchDirs = [];
        if (entry._legFile) {
          manifestSearchDirs.push(path.join(path.dirname(entry._legFile), 'manifests'));
        }
        for (const legDir of legendaryDirs) {
          const mDir = path.join(legDir, 'manifests');
          if (!manifestSearchDirs.includes(mDir)) manifestSearchDirs.push(mDir);
        }

        let sourceManifestPath = null;
        let bestManifestMtime = -1;
        for (const mDir of manifestSearchDirs) {
          if (!fs.existsSync(mDir)) continue;
          try {
            const mFiles = fs.readdirSync(mDir);
            for (const mf of mFiles) {
              if (!mf.toLowerCase().endsWith('.manifest')) continue;
              if (mf === `${appName}.manifest` || mf.startsWith(`${appName}_`)) {
                const candidatePath = path.join(mDir, mf);
                try {
                  const st = fs.statSync(candidatePath);
                  if (st.mtimeMs > bestManifestMtime) {
                    bestManifestMtime = st.mtimeMs;
                    sourceManifestPath = candidatePath;
                  }
                } catch {}
              }
            }
          } catch {}
        }

        const alreadyValid = existingItems.some((it) => {
          if (
            it.AppName !== appName ||
            it.InstallLocation !== installPath ||
            it.bIsIncompleteInstall !== false ||
            !it.CatalogItemId ||
            !it.CatalogNamespace ||
            !it.InstallationGuid
          ) {
            return false;
          }
          const itemGuid = String(it.InstallationGuid);
          const mancpnExists = fs.existsSync(path.join(installPath, '.egstore', `${itemGuid}.mancpn`));
          if (!mancpnExists) return false;
          if (sourceManifestPath && !fs.existsSync(path.join(installPath, '.egstore', `${itemGuid}.manifest`))) {
            return false;
          }
          return true;
        });

        if (alreadyValid) {
          syncedCount++;
          continue;
        }

        let relativeExePath = '';
        if (entry.executable && !path.isAbsolute(String(entry.executable))) {
          relativeExePath = String(entry.executable);
        } else if (entry.executablePath && String(entry.executablePath).startsWith(installPath)) {
          relativeExePath = path.relative(installPath, entry.executablePath);
        } else {
          const discovered = findPrimaryExecutable(installPath, {
            platform,
            hintName: entry.title || appName,
          });
          if (discovered.executablePath && discovered.executablePath.startsWith(installPath)) {
            relativeExePath = path.relative(installPath, discovered.executablePath);
          } else if (discovered.executablePath) {
            relativeExePath = path.basename(discovered.executablePath);
          }
        }
        const cleanLaunchExecutable = String(relativeExePath || '')
          .replace(/^[.\\/]+/, '')
          .replace(/\\/g, '/');

        const existingForApp = existingItems.find((it) => it.AppName === appName);
        const existingGuid = String(
          entry.egl_guid || existingForApp?.InstallationGuid || ''
        )
          .replace(/[^0-9a-fA-F]/g, '')
          .toUpperCase();

        const guid =
          existingGuid.length === 32
            ? existingGuid
            : crypto
                .createHash('md5')
                .update(`${appName}:${installPath}`)
                .digest('hex')
                .toUpperCase();

        const mandatoryFolderName =
          meta?.metadata?.customAttributes?.FolderName?.value || path.basename(installPath);

        const itemPayload = {
          FormatVersion: 0,
          bIsIncompleteInstall: false,
          LaunchCommand: entry.launch_parameters || '',
          LaunchExecutable: cleanLaunchExecutable,
          ManifestLocation: path.join(installPath, '.egstore'),
          StagingLocation: path.join(installPath, '.egstore', 'bps'),
          bIsApplication: true,
          bIsExecutable: true,
          bIsManaged: false,
          bNeedsValidation: false,
          bRequiresAuth: true,
          bCanRunOffline: Boolean(entry.can_run_offline !== false),
          AppName: appName,
          BaseURLs: Array.isArray(entry.base_urls) ? entry.base_urls : [],
          BuildLabel: 'Live',
          AppCategories: ['public', 'games', 'applications'],
          ChunkDbs: [],
          CompatibleApps: [],
          DisplayName: entry.title || meta?.app_title || appName,
          FullAppName: appName,
          InstallationGuid: guid,
          InstallLocation: installPath,
          InstallSessionId: '',
          InstallTags: Array.isArray(entry.install_tags) ? entry.install_tags : [],
          InstallComponents: [],
          HostInstallationGuid: '',
          PrereqIds: [],
          TechnicalType: '',
          VaultThumbnailUrl: '',
          VaultTitleText: '',
          InstallSize: Number(entry.install_size || entry.installSize || 0),
          MainWindowProcessName: '',
          ProcessNames: [],
          MainGameAppName: appName,
          MandatoryAppFolderName: mandatoryFolderName,
          OwnershipToken: 'false',
          CatalogNamespace: catalogNamespace,
          CatalogItemId: catalogItemId,
          AppVersionString: String(entry.version || '1.0'),
        };

        const mancpnPayload = {
          FormatVersion: 0,
          AppName: appName,
          CatalogItemId: catalogItemId,
          CatalogNamespace: catalogNamespace,
        };

        try {
          const egstoreDir = path.join(installPath, '.egstore');
          const bpsDir = path.join(egstoreDir, 'bps');
          fs.mkdirSync(bpsDir, { recursive: true });
          // Clean up any stale .item files that may have been written to .egstore previously
          try {
            const egFiles = fs.readdirSync(egstoreDir);
            for (const ef of egFiles) {
              if (ef.toLowerCase().endsWith('.item')) {
                fs.rmSync(path.join(egstoreDir, ef), { force: true });
              }
            }
          } catch {}
          atomicWriteFileSync(
            path.join(egstoreDir, `${guid}.mancpn`),
            JSON.stringify(mancpnPayload, null, 2)
          );
          if (sourceManifestPath && fs.existsSync(sourceManifestPath)) {
            fs.copyFileSync(sourceManifestPath, path.join(egstoreDir, `${guid}.manifest`));
          }
        } catch {}

        try {
          // Remove any stale .item files for this appName with a different filename
          for (const oldItem of existingItems) {
            if (oldItem.AppName === appName && oldItem._fileName && oldItem._fileName !== `${guid}.item`) {
              try {
                fs.rmSync(path.join(eglManifestsDir, oldItem._fileName), { force: true });
              } catch {}
            }
          }
          const serializedItem = JSON.stringify(itemPayload, null, 2);
          atomicWriteFileSync(path.join(eglManifestsDir, `${guid}.item`), serializedItem);
          syncedCount++;
        } catch {}

        if (entry._legFile && fs.existsSync(entry._legFile) && entry.egl_guid !== guid) {
          try {
            const rawLeg = JSON.parse(fs.readFileSync(entry._legFile, 'utf8'));
            if (rawLeg && typeof rawLeg === 'object' && !Array.isArray(rawLeg) && rawLeg[appName]) {
              rawLeg[appName].egl_guid = guid;
              atomicWriteFileSync(entry._legFile, JSON.stringify(rawLeg, null, 2));
            }
          } catch {}
        }
      }
    }

    // 4. Update LauncherInstalled.dat
    if (eglLauncherInstalledPath) {
      const validItems = [];
      if (eglManifestsDir && fs.existsSync(eglManifestsDir)) {
        try {
          const files = fs.readdirSync(eglManifestsDir);
          for (const f of files) {
            if (!f.toLowerCase().endsWith('.item')) continue;
            try {
              const parsed = JSON.parse(fs.readFileSync(path.join(eglManifestsDir, f), 'utf8'));
              if (
                parsed &&
                !parsed.bIsIncompleteInstall &&
                parsed.AppName &&
                parsed.InstallLocation &&
                fs.existsSync(parsed.InstallLocation)
              ) {
                validItems.push(parsed);
              }
            } catch {}
          }
        } catch {}
      }

      const listMap = new Map();
      if (fs.existsSync(eglLauncherInstalledPath)) {
        try {
          const existingDat = JSON.parse(fs.readFileSync(eglLauncherInstalledPath, 'utf8'));
          const existingList = Array.isArray(existingDat?.InstallationList)
            ? existingDat.InstallationList
            : [];
          for (const item of existingList) {
            if (item && item.AppName && item.InstallLocation && fs.existsSync(item.InstallLocation)) {
              listMap.set(item.AppName, item);
            }
          }
        } catch {}
      }

      for (const item of validItems) {
        listMap.set(item.AppName, {
          InstallLocation: item.InstallLocation,
          NamespaceId: item.CatalogNamespace || '',
          ItemId: item.CatalogItemId || '',
          ArtifactId: item.AppName,
          AppVersion: item.AppVersionString || '1.0',
          AppName: item.AppName,
        });
      }

      try {
        fs.mkdirSync(path.dirname(eglLauncherInstalledPath), { recursive: true });
        atomicWriteFileSync(
          eglLauncherInstalledPath,
          JSON.stringify({ InstallationList: Array.from(listMap.values()) }, null, 2)
        );
      } catch {}
    }

    return { synced: syncedCount };
  } catch {
    return { synced: 0 };
  }
}

/**
 * Unregister an uninstalled Epic game from Epic Games Launcher (.item manifests + LauncherInstalled.dat)
 */
function unregisterEpicFirstPartyLauncher(appName, installPath, options = {}) {
  try {
    const { eglManifestsDir, eglLauncherInstalledPath, isolatedNoOp } = resolveEpicFirstPartyPaths(options);
    if (isolatedNoOp || (!eglManifestsDir && !eglLauncherInstalledPath)) {
      return { removed: 0 };
    }

    const cleanAppName = String(appName || '').replace(/^epic[-_]/i, '').trim();
    const normInstallPath = installPath ? toLocalFsPath(installPath) : null;
    let removedCount = 0;

    if (eglManifestsDir && fs.existsSync(eglManifestsDir)) {
      try {
        const files = fs.readdirSync(eglManifestsDir);
        for (const f of files) {
          if (!f.toLowerCase().endsWith('.item')) continue;
          const fullItemPath = path.join(eglManifestsDir, f);
          try {
            const item = JSON.parse(fs.readFileSync(fullItemPath, 'utf8'));
            const matchesApp =
              cleanAppName && (item.AppName === cleanAppName || item.AppName === String(appName));
            const matchesPath = normInstallPath && item.InstallLocation === normInstallPath;
            if (matchesApp || matchesPath) {
              fs.rmSync(fullItemPath, { force: true });
              removedCount++;
            }
          } catch {}
        }
      } catch {}
    }

    if (eglLauncherInstalledPath && fs.existsSync(eglLauncherInstalledPath)) {
      try {
        const rawDat = JSON.parse(fs.readFileSync(eglLauncherInstalledPath, 'utf8'));
        const existingList = Array.isArray(rawDat?.InstallationList) ? rawDat.InstallationList : [];
        const filteredList = existingList.filter((entry) => {
          if (!entry) return false;
          const matchesApp =
            cleanAppName &&
            (entry.AppName === cleanAppName ||
              entry.ArtifactId === cleanAppName ||
              entry.AppName === String(appName));
          const matchesPath = normInstallPath && entry.InstallLocation === normInstallPath;
          return !(matchesApp || matchesPath);
        });
        fs.writeFileSync(
          eglLauncherInstalledPath,
          JSON.stringify({ InstallationList: filteredList }, null, 2),
          'utf8'
        );
      } catch {}
    }

    return { removed: removedCount };
  } catch {
    return { removed: 0 };
  }
}

/**
 * Flatten nested subfolder created by gogdl download (e.g. <finalInstallPath>/<SubDir>/goggame-<id>.info)
 * so game files and goggame-<id>.info live directly at depth 0 of <finalInstallPath>.
 * Never flattens macOS Contents/ directories and auto-repairs previously flattened macOS bundles.
 */
function flattenGogNestedInstallDir(finalInstallPath, cleanId) {
  try {
    if (!finalInstallPath || !fs.existsSync(finalInstallPath)) return finalInstallPath;
    if (finalInstallPath.toLowerCase().endsWith('.app')) return finalInstallPath;
    const stat = fs.statSync(finalInstallPath);
    if (!stat.isDirectory()) return finalInstallPath;

    // Auto-repair if a macOS .app Contents/ directory was previously flattened into finalInstallPath
    const hasRootInfoPlist = fs.existsSync(path.join(finalInstallPath, 'Info.plist'));
    const hasRootBundleParts =
      fs.existsSync(path.join(finalInstallPath, 'MacOS')) ||
      fs.existsSync(path.join(finalInstallPath, 'Resources')) ||
      fs.existsSync(path.join(finalInstallPath, 'PkgInfo'));

    if (hasRootInfoPlist && hasRootBundleParts) {
      const contentsDir = path.join(finalInstallPath, 'Contents');
      fs.mkdirSync(contentsDir, { recursive: true });
      const bundleEntries = [
        'Info.plist',
        'PkgInfo',
        'MacOS',
        'Resources',
        '_CodeSignature',
        'Documents',
        'Frameworks',
        'PlugIns',
        'Library',
      ];
      for (const itemName of bundleEntries) {
        const src = path.join(finalInstallPath, itemName);
        const dest = path.join(contentsDir, itemName);
        if (!fs.existsSync(src)) continue;
        try {
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
          } else {
            fs.cpSync(src, dest, { recursive: true, force: true });
            fs.rmSync(src, { recursive: true, force: true });
          }
        } catch {
          try {
            fs.cpSync(src, dest, { recursive: true, force: true });
            fs.rmSync(src, { recursive: true, force: true });
          } catch {}
        }
      }
    }

    const rootEntries = fs.readdirSync(finalInstallPath, { withFileTypes: true });

    // Never flatten a macOS bundle directory containing Contents/
    if (rootEntries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'contents')) {
      return finalInstallPath;
    }

    const hasRootInfoOrApp = rootEntries.some(
      (e) =>
        (e.isFile() && /^\.?goggame-\d+\.info$/i.test(e.name)) ||
        (e.isDirectory() && e.name.toLowerCase().endsWith('.app'))
    );
    if (hasRootInfoOrApp) return finalInstallPath;

    const visibleDirs = rootEntries.filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        !e.name.toLowerCase().endsWith('.app') &&
        e.name.toLowerCase() !== 'contents'
    );
    const visibleFiles = rootEntries.filter((e) => e.isFile() && !e.name.startsWith('.'));

    let targetSubDir = null;
    for (const d of visibleDirs) {
      const subFullPath = path.join(finalInstallPath, d.name);
      try {
        const subFiles = fs.readdirSync(subFullPath);
        if (
          (cleanId && subFiles.includes(`goggame-${cleanId}.info`)) ||
          subFiles.some((f) => /^\.?goggame-\d+\.info$/i.test(f))
        ) {
          targetSubDir = subFullPath;
          break;
        }
      } catch {}
    }

    if (/[\\/]steamapps[\\/]common(?:[\\/]|$)/i.test(finalInstallPath)) {
      return finalInstallPath;
    }

    if (
      !targetSubDir &&
      visibleDirs.length === 1 &&
      visibleFiles.length === 0 &&
      !/^(bin|binaries|rerelease|x64|x86|win64|win32|macos|contents|resources|data|engine)$/i.test(
        visibleDirs[0].name
      )
    ) {
      targetSubDir = path.join(finalInstallPath, visibleDirs[0].name);
    }

    if (targetSubDir && fs.existsSync(targetSubDir)) {
      const innerItems = fs.readdirSync(targetSubDir);
      for (const itemName of innerItems) {
        const src = path.join(targetSubDir, itemName);
        const dest = path.join(finalInstallPath, itemName);
        if (fs.existsSync(dest)) continue;
        try {
          fs.renameSync(src, dest);
        } catch {
          try {
            fs.cpSync(src, dest, { recursive: true, force: true });
            fs.rmSync(src, { recursive: true, force: true });
          } catch {}
        }
      }
      try {
        const remaining = fs.readdirSync(targetSubDir);
        if (remaining.length === 0) {
          fs.rmdirSync(targetSubDir);
        }
      } catch {}
    }
  } catch {}
  return finalInstallPath;
}

/**
 * Resolve GOG Galaxy 2.0 config.json and galaxy-2.0.db paths
 */
function resolveGogFirstPartyPaths(options = {}) {
  const platform = options.platform || process.platform;
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';

  const gogConfigPath =
    options.gogGalaxyConfigPath ||
    (!options.homedir
      ? platform === 'win32'
        ? path.join(programData, 'GOG.com', 'Galaxy', 'config.json')
        : '/Users/Shared/GOG.com/Galaxy/config.json'
      : null);

  const gogDbPath =
    options.gogGalaxyDbPath ||
    (!options.homedir
      ? platform === 'win32'
        ? path.join(programData, 'GOG.com', 'Galaxy', 'storage', 'galaxy-2.0.db')
        : fs.existsSync('/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db')
          ? '/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db'
          : '/Users/Shared/GOG.com/Galaxy/storage/galaxy-2.0.db'
      : null);

  return { gogConfigPath, gogDbPath };
}

/**
 * Synchronize an installed GOG game into GOG Galaxy 2.0 (goggame-<id>.info, config.json, galaxy-2.0.db SQLite, & Windows Registry)
 */
function syncGogFirstPartyLauncher(record, options = {}) {
  try {
    if (!record || typeof record !== 'object') return { synced: false };
    if (
      options.fromAutoScan &&
      options.homedir &&
      !options.gogGalaxyDbPath &&
      !options.gogGalaxyConfigPath
    ) {
      return { synced: false };
    }

    const platform = options.platform || process.platform;
    const cleanId = String(record.platformGameId || '').replace(/^gog[-_]/i, '').trim();
    const installPath = record.installPath ? toLocalFsPath(record.installPath) : null;
    if (!cleanId || !installPath || !fs.existsSync(installPath)) {
      return { synced: false };
    }

    // Step A: Flatten nested directory (or repair flattened macOS bundle) & ensure +x permissions
    flattenGogNestedInstallDir(installPath, cleanId);
    if (platform === 'darwin') {
      ensureMacExecutablePermissions(installPath);
    }

    // Resolve galaxyInstallPath (prefer top-level .app bundle inside installPath on darwin)
    let galaxyInstallPath = installPath;
    if (platform === 'darwin' && !installPath.toLowerCase().endsWith('.app')) {
      try {
        const entries = fs.readdirSync(installPath, { withFileTypes: true });
        const appDir = entries.find(
          (d) => d.isDirectory() && d.name.toLowerCase().endsWith('.app')
        );
        if (appDir) {
          galaxyInstallPath = path.join(installPath, appDir.name);
        }
      } catch {}
    }

    // Step B: Ensure complete goggame-<cleanId>.info & .goggame-<cleanId>.info
    const infoFilePath = path.join(installPath, `goggame-${cleanId}.info`);
    const dotInfoFilePath = path.join(installPath, `.goggame-${cleanId}.info`);
    const macResourcesDir = path.join(galaxyInstallPath, 'Contents', 'Resources');
    const macResourcesInfoPath = path.join(macResourcesDir, `goggame-${cleanId}.info`);
    const macResourcesDotInfoPath = path.join(macResourcesDir, `.goggame-${cleanId}.info`);

    const candidateInfoPaths = [
      macResourcesDotInfoPath,
      macResourcesInfoPath,
      dotInfoFilePath,
      infoFilePath,
    ];
    const parsedInfoCandidates = [];
    for (const candidateInfo of candidateInfoPaths) {
      if (fs.existsSync(candidateInfo)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidateInfo, 'utf8'));
          if (parsed && typeof parsed === 'object') {
            parsedInfoCandidates.push(parsed);
          }
        } catch {}
      }
    }

    const info =
      parsedInfoCandidates.find(
        (c) => Array.isArray(c.playTasks) && c.playTasks.length > 0 && Boolean(c.playTasks[0]?.path)
      ) ||
      parsedInfoCandidates[0] ||
      {};

    let resolvedExe = record.executablePath ? toLocalFsPath(record.executablePath) : undefined;
    if (!resolvedExe || !fs.existsSync(resolvedExe) || /[\\/]GOGLauncher$/i.test(resolvedExe)) {
      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: record.title || info.name,
      });
      if (discovered.executablePath && fs.existsSync(discovered.executablePath)) {
        resolvedExe = discovered.executablePath;
      }
    }

    if (resolvedExe) {
      record.executablePath = resolvedExe;
      try {
        const existingManaged = loadManagedInstalledGames(options.userDataDir);
        const mIdx = existingManaged.findIndex(
          (r) =>
            r &&
            r.platformId === 'gog' &&
            (String(r.platformGameId) === cleanId ||
              String(r.platformGameId) === String(record.platformGameId))
        );
        if (mIdx >= 0 && existingManaged[mIdx].executablePath !== resolvedExe) {
          existingManaged[mIdx] = { ...existingManaged[mIdx], executablePath: resolvedExe };
          saveManagedInstalledGames(existingManaged, options.userDataDir);
        }
      } catch {}
    }

    let relativeExePath = '';
    if (resolvedExe && resolvedExe.startsWith(galaxyInstallPath)) {
      relativeExePath = path.relative(galaxyInstallPath, resolvedExe);
    } else if (resolvedExe && resolvedExe.startsWith(installPath)) {
      relativeExePath = path.relative(installPath, resolvedExe);
    } else if (resolvedExe) {
      relativeExePath = path.basename(resolvedExe);
    }

    const { gogConfigPath, gogDbPath } = resolveGogFirstPartyPaths(options);

    // Resolve authoritative buildId, generation, and per-game clientId (never GOG Galaxy's launcher clientId!)
    let realBuildId = String(
      info.buildId && /^\d+$/.test(String(info.buildId)) ? info.buildId : cleanId
    );
    let realGeneration = 2;
    const pickValidGogGameClientId = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val).trim();
      if (!str || str === GOG_GALAXY_LAUNCHER_CLIENT_ID) return '';
      const lower = str.toLowerCase();
      if (lower === 'null' || lower === 'undefined' || lower === 'false' || lower === 'nan') {
        return '';
      }
      return /^[A-Za-z0-9_-]{3,128}$/.test(str) ? str : '';
    };
    let resolvedGameClientId =
      pickValidGogGameClientId(record.clientId) ||
      pickValidGogGameClientId(record.gogClientId) ||
      pickValidGogGameClientId(info.clientId) ||
      parsedInfoCandidates.map((c) => pickValidGogGameClientId(c?.clientId)).find(Boolean) ||
      '';

    if (gogDbPath && fs.existsSync(gogDbPath) && /^\d+$/.test(cleanId)) {
      let dbLookup = null;
      try {
        const { DatabaseSync } = require('node:sqlite');
        dbLookup = new DatabaseSync(gogDbPath, { readBigInts: true });
        dbLookup.exec('PRAGMA busy_timeout = 3000;');
        const buildRow = dbLookup
          .prepare('SELECT manifest FROM Builds WHERE productId = ? LIMIT 1')
          .get(Number(cleanId));
        if (buildRow && buildRow.manifest) {
          const parsedManifest = JSON.parse(buildRow.manifest);
          const firstItem = parsedManifest?.items?.[0];
          if (firstItem?.generation) realGeneration = Number(firstItem.generation);
          if (realGeneration === 1 && firstItem?.legacy_build_id) {
            realBuildId = String(firstItem.legacy_build_id);
          } else if (firstItem?.build_id) {
            realBuildId = String(firstItem.build_id);
          }
          if (!resolvedGameClientId) {
            resolvedGameClientId =
              pickValidGogGameClientId(firstItem?.clientId) ||
              pickValidGogGameClientId(parsedManifest?.clientId) ||
              '';
          }
        }
      } catch {
      } finally {
        if (dbLookup) {
          try {
            dbLookup.close();
          } catch {}
        }
      }
    }

    if (!resolvedGameClientId) {
      try {
        const cfgCacheFile = path.join(
          getUserDataDir(options.userDataDir),
          'one_launcher_gog_cloud_configs.json'
        );
        if (fs.existsSync(cfgCacheFile)) {
          const parsedCfgCache = JSON.parse(fs.readFileSync(cfgCacheFile, 'utf8'));
          resolvedGameClientId = pickValidGogGameClientId(
            parsedCfgCache?.__productClientIds?.[cleanId]
          );
        }
      } catch {}
    }

    const hasExistingValidPlayTasks =
      Array.isArray(info.playTasks) &&
      info.playTasks.length > 0 &&
      Boolean(info.playTasks[0]?.path);

    const sanitizedBaseInfo = { ...info };
    delete sanitizedBaseInfo.clientId;

    const synthesizedInfo = {
      ...sanitizedBaseInfo,
      buildId: realBuildId,
      ...(resolvedGameClientId ? { clientId: resolvedGameClientId } : {}),
      gameId: String(cleanId),
      rootGameId: String(info.rootGameId || cleanId),
      language: info.language || 'English',
      languages:
        Array.isArray(info.languages) && info.languages.length > 0 ? info.languages : ['en-US'],
      name: info.name || record.title || `GOG Game ${cleanId}`,
      osBitness: Array.isArray(info.osBitness) ? info.osBitness : ['64'],
      version: typeof info.version === 'number' ? info.version : 1,
      playTasks: hasExistingValidPlayTasks
        ? info.playTasks
        : [
            {
              category: 'game',
              isPrimary: true,
              languages: ['en-US'],
              name: info.name || record.title || 'Play',
              path: relativeExePath || '',
              type: 'FileTask',
            },
          ],
    };

    const serializedInfo = JSON.stringify(synthesizedInfo, null, 2);
    let activeInfoFilePath = infoFilePath;
    const writeIfChanged = (targetFilePath, content) => {
      try {
        if (fs.existsSync(targetFilePath)) {
          const existingContent = fs.readFileSync(targetFilePath, 'utf8');
          if (existingContent === content) return false;
        }
        fs.writeFileSync(targetFilePath, content, 'utf8');
        return true;
      } catch {
        return false;
      }
    };

    try {
      const hasMacBundleLayout =
        platform === 'darwin' &&
        (galaxyInstallPath.toLowerCase().endsWith('.app') ||
          fs.existsSync(path.join(galaxyInstallPath, 'Contents')));

      let hasSealedValidSignature = false;
      if (
        hasMacBundleLayout &&
        !fs.existsSync(macResourcesInfoPath) &&
        (!isTestEnvironment(options) || options.allowCodesignInTest === true)
      ) {
        try {
          const execFileSyncImpl =
            typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;
          execFileSyncImpl('codesign', ['--verify', '--deep', '--strict', galaxyInstallPath], {
            stdio: 'ignore',
            timeout: 4000,
          });
          hasSealedValidSignature = true;
        } catch {
          hasSealedValidSignature = false;
        }
      }

      if (hasMacBundleLayout && !hasSealedValidSignature) {
        fs.mkdirSync(macResourcesDir, { recursive: true });
        writeIfChanged(macResourcesInfoPath, serializedInfo);
        writeIfChanged(macResourcesDotInfoPath, serializedInfo);
        activeInfoFilePath = macResourcesInfoPath;
        const rootHashDb = path.join(installPath, `goggame-${cleanId}.hashdb`);
        const resHashDb = path.join(macResourcesDir, `goggame-${cleanId}.hashdb`);
        if (fs.existsSync(rootHashDb) && !fs.existsSync(resHashDb)) {
          fs.copyFileSync(rootHashDb, resHashDb);
        }
        if (galaxyInstallPath !== installPath && fs.existsSync(macResourcesInfoPath)) {
          try {
            if (fs.existsSync(infoFilePath)) fs.unlinkSync(infoFilePath);
            if (fs.existsSync(dotInfoFilePath)) fs.unlinkSync(dotInfoFilePath);
          } catch {}
        }
      } else {
        writeIfChanged(infoFilePath, serializedInfo);
        writeIfChanged(dotInfoFilePath, serializedInfo);
        activeInfoFilePath = infoFilePath;
      }
    } catch {}

    // Step C: Update GOG Galaxy config.json (installationPaths)
    if (gogConfigPath && fs.existsSync(gogConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(gogConfigPath, 'utf8')) || {};
        if (!Array.isArray(cfg.installationPaths)) {
          cfg.installationPaths = [];
        }
        let cfgChanged = false;
        for (const dirCandidate of [path.dirname(galaxyInstallPath), path.dirname(installPath)]) {
          if (
            dirCandidate &&
            dirCandidate !== cfg.libraryPath &&
            !cfg.installationPaths.includes(dirCandidate)
          ) {
            cfg.installationPaths.push(dirCandidate);
            cfgChanged = true;
          }
        }
        if (cfgChanged) {
          fs.writeFileSync(gogConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
        }
      } catch {}
    }

    // Step D: Register in GOG Galaxy 2.0 SQLite Database (galaxy-2.0.db)
    if (gogDbPath && (fs.existsSync(gogDbPath) || options.gogGalaxyDbPath) && /^\d+$/.test(cleanId)) {
      const numericProductId = Number(cleanId);
      const sqlBuildId = /^\d+$/.test(realBuildId) ? BigInt(realBuildId) : 0n;
      const installationId = Number(String(numericProductId).slice(0, 9)) || numericProductId;
      const releaseKey = `gog_${cleanId}`;

      let db = null;
      try {
        fs.mkdirSync(path.dirname(gogDbPath), { recursive: true });
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(gogDbPath, { readBigInts: true });
        db.exec('PRAGMA busy_timeout = 5000;');

        db.exec(`
          CREATE TABLE IF NOT EXISTS ReleaseKeys (key TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS Products (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER);
          CREATE TABLE IF NOT EXISTS InstalledProducts (productId INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS Languages (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
          CREATE TABLE IF NOT EXISTS AvailableLanguages (productId INTEGER, buildId INTEGER, languageId INTEGER, PRIMARY KEY (productId, buildId, languageId));
          CREATE TABLE IF NOT EXISTS InstalledBaseProducts (productId INTEGER PRIMARY KEY, generation INTEGER, languageId INTEGER, installationPath TEXT, installationId INTEGER, buildId INTEGER, branch TEXT, installationDate TEXT);
          CREATE TABLE IF NOT EXISTS ImportedLatestBuildIds (productId INTEGER PRIMARY KEY, buildId INTEGER);
          CREATE TABLE IF NOT EXISTS ProductStates (productId INTEGER PRIMARY KEY, installation INTEGER, operation INTEGER);
          CREATE TABLE IF NOT EXISTS ModificationTargets (productId INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS BaseModificationTargets (productId INTEGER PRIMARY KEY, languageId INTEGER, installationPath TEXT, buildId INTEGER, branch TEXT, areDlcsSelectedByUser INTEGER);
          CREATE TABLE IF NOT EXISTS ProductSettings (gameReleaseKey TEXT PRIMARY KEY, selectedBuildId INTEGER, branch TEXT, password TEXT, autoUpdate INTEGER, cloudStorage INTEGER, overlay INTEGER, desktopShortcut INTEGER, customLaunchParameters, selectedLaunchParameters INTEGER);
          CREATE TABLE IF NOT EXISTS PlayTaskTypes (id INTEGER PRIMARY KEY, type TEXT UNIQUE);
          CREATE TABLE IF NOT EXISTS PlayTasks (id INTEGER PRIMARY KEY, gameReleaseKey TEXT, userId INTEGER, "order" INTEGER, typeId INTEGER, isPrimary INTEGER);
          CREATE TABLE IF NOT EXISTS PlayTaskLaunchParameters (playTaskId INTEGER PRIMARY KEY, executablePath TEXT, commandLineArgs TEXT, label TEXT);
          CREATE TABLE IF NOT EXISTS GameFiles (id INTEGER PRIMARY KEY, installPath TEXT, productId INTEGER, hash TEXT, fileAttribute INTEGER);
        `);

        // Generically clean up any stale non-GOG Steam AppID rows (Products.name LIKE 'steam-%')
        try {
          const staleSubquery = "SELECT id FROM Products WHERE name LIKE 'steam-%'";
          db.prepare(`DELETE FROM ImportedLatestBuildIds WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM BaseModificationTargets WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM ModificationTargets WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM ProductStates WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM GameFiles WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM InstalledBaseProducts WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM InstalledProducts WHERE productId IN (${staleSubquery})`).run();
          db.prepare(`DELETE FROM AvailableLanguages WHERE productId IN (${staleSubquery})`).run();
          db.prepare("DELETE FROM Products WHERE name LIKE 'steam-%'").run();
        } catch {}

        db.prepare('INSERT OR IGNORE INTO ReleaseKeys (key) VALUES (?)').run(releaseKey);
        db.prepare(
          'INSERT INTO Products (id, name, parentId) VALUES (?, ?, NULL) ON CONFLICT(id) DO UPDATE SET name = COALESCE(Products.name, excluded.name)'
        ).run(numericProductId, synthesizedInfo.name);
        db.prepare('INSERT OR IGNORE INTO InstalledProducts (productId) VALUES (?)').run(
          numericProductId
        );
        db.prepare(
          "INSERT OR IGNORE INTO Languages (id, name, code) VALUES (16, 'English', 'en-US')"
        ).run();
        db.prepare(
          'INSERT OR IGNORE INTO AvailableLanguages (productId, buildId, languageId) VALUES (?, ?, 16)'
        ).run(numericProductId, sqlBuildId);
        db.prepare(
          "INSERT OR REPLACE INTO InstalledBaseProducts (productId, generation, languageId, installationPath, installationId, buildId, branch, installationDate) VALUES (?, ?, 16, ?, ?, ?, NULL, datetime('now'))"
        ).run(numericProductId, realGeneration, galaxyInstallPath, installationId, sqlBuildId);
        db.prepare(
          'INSERT OR REPLACE INTO ImportedLatestBuildIds (productId, buildId) VALUES (?, ?)'
        ).run(numericProductId, sqlBuildId);
        db.prepare(
          'INSERT OR REPLACE INTO ProductStates (productId, installation, operation) VALUES (?, 3, 0)'
        ).run(numericProductId);
        db.prepare('INSERT OR IGNORE INTO ModificationTargets (productId) VALUES (?)').run(
          numericProductId
        );
        db.prepare(
          'INSERT OR REPLACE INTO BaseModificationTargets (productId, languageId, installationPath, buildId, branch, areDlcsSelectedByUser) VALUES (?, 16, ?, ?, NULL, 0)'
        ).run(numericProductId, galaxyInstallPath, sqlBuildId);

        try {
          db.prepare('DELETE FROM AvailableLanguages WHERE productId = ? AND buildId != ?').run(
            numericProductId,
            sqlBuildId
          );
        } catch {}

        db.prepare(
          'INSERT OR IGNORE INTO ProductSettings (gameReleaseKey, selectedBuildId, branch, password, autoUpdate, cloudStorage, overlay, desktopShortcut, customLaunchParameters, selectedLaunchParameters) VALUES (?, NULL, NULL, NULL, 1, 1, 1, 0, 0, NULL)'
        ).run(releaseKey);
        db.prepare(
          "INSERT OR IGNORE INTO PlayTaskTypes (id, type) VALUES (1, 'BuiltIn'), (2, 'BuiltInPrimary')"
        ).run();

        const galaxyPlayTaskExe =
          platform === 'darwin' && galaxyInstallPath.toLowerCase().endsWith('.app')
            ? resolveMacAppBundleBinary(galaxyInstallPath) || resolvedExe || ''
            : resolvedExe || '';

        try {
          const triggers = db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'PlayTasks'"
            )
            .all();
          for (const t of triggers) {
            if (t && t.sql && t.sql.includes('RAISE(ABORT, "')) {
              const fixedSql = t.sql.replace(
                /RAISE\(ABORT,\s*"([^"]+)"\)/g,
                "RAISE(ABORT, '$1')"
              );
              db.exec(`DROP TRIGGER IF EXISTS ${t.name};`);
              db.exec(fixedSql);
            }
          }
        } catch {}

        try {
          db.prepare(
            'DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey = ?)'
          ).run(releaseKey);
          db.prepare('DELETE FROM PlayTasks WHERE gameReleaseKey = ?').run(releaseKey);
          const ptInfo = db
            .prepare(
              'INSERT INTO PlayTasks (gameReleaseKey, userId, "order", typeId, isPrimary) VALUES (?, NULL, 1, 2, 1)'
            )
            .run(releaseKey);
          db.prepare(
            'INSERT INTO PlayTaskLaunchParameters (playTaskId, executablePath, commandLineArgs, label) VALUES (?, ?, ?, ?)'
          ).run(ptInfo.lastInsertRowid, galaxyPlayTaskExe, '', synthesizedInfo.name);
        } catch {}

        const gfCountRow = db
          .prepare('SELECT COUNT(*) AS cnt FROM GameFiles WHERE productId = ?')
          .get(numericProductId);
        if (Number(gfCountRow?.cnt || 0) === 0) {
          const gfRelPath =
            platform === 'darwin'
              ? `Contents/Resources/goggame-${cleanId}.info`
              : `goggame-${cleanId}.info`;
          db.prepare(
            'INSERT INTO GameFiles (installPath, productId, hash, fileAttribute) VALUES (?, ?, ?, 32)'
          ).run(gfRelPath, numericProductId, '');
        }
      } catch {
      } finally {
        if (db) {
          try {
            db.close();
          } catch {}
        }
      }
    }

    // Step E: Windows Registry Registration (HKCU\Software\GOG.com\Games\<cleanId>)
    if (platform === 'win32' && !options.homedir && !options.skipRegistry) {
      const regKey = `HKCU\\Software\\GOG.com\\Games\\${cleanId}`;
      const regEntries = [
        ['path', installPath],
        ['gameID', cleanId],
        ['gameName', synthesizedInfo.name],
        ['exe', resolvedExe || ''],
        ['workingDir', installPath],
        ['launchCommand', resolvedExe || ''],
        ['ver', String(record.version || '1.0')],
        ['language', 'english'],
        ['lang_code', 'en-US'],
      ];
      for (const [valName, valData] of regEntries) {
        try {
          execFileSync(
            'reg.exe',
            ['add', regKey, '/v', valName, '/t', 'REG_SZ', '/d', String(valData), '/f'],
            { stdio: 'ignore', timeout: 3000 }
          );
        } catch {}
      }
    }

    if (platform === 'darwin') {
      try {
        ensureMacAppCodeSignatureValid(galaxyInstallPath || installPath, options);
      } catch {}
    }

    return { synced: true, infoFilePath: activeInfoFilePath };
  } catch {
    return { synced: false };
  }
}

async function syncGogGameToGalaxy(record, options = {}) {
  return syncGogFirstPartyLauncher(record, options);
}

/**
 * Unregister an uninstalled GOG game from GOG Galaxy 2.0 SQLite DB & Windows Registry
 */
function unregisterGogFirstPartyLauncher(cleanId, installPath, options = {}) {
  try {
    const platform = options.platform || process.platform;
    const normId = String(cleanId || '').replace(/^gog[-_]/i, '').trim();
    const { gogDbPath } = resolveGogFirstPartyPaths(options);

    if (gogDbPath && fs.existsSync(gogDbPath) && /^\d+$/.test(normId)) {
      const numericProductId = Number(normId);
      const releaseKey = `gog_${normId}`;
      let db = null;
      try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(gogDbPath, { readBigInts: true });
        db.exec('PRAGMA busy_timeout = 5000;');
        try {
          db.prepare(
            'DELETE FROM PlayTaskLaunchParameters WHERE playTaskId IN (SELECT id FROM PlayTasks WHERE gameReleaseKey = ?)'
          ).run(releaseKey);
        } catch {}
        try {
          db.prepare('DELETE FROM PlayTasks WHERE gameReleaseKey = ?').run(releaseKey);
        } catch {}
        try {
          db.prepare('DELETE FROM ProductSettings WHERE gameReleaseKey = ?').run(releaseKey);
        } catch {}
        try {
          db.prepare('DELETE FROM GameFiles WHERE productId = ?').run(numericProductId);
        } catch {}
        try {
          db.prepare('DELETE FROM BaseModificationTargets WHERE productId = ?').run(
            numericProductId
          );
        } catch {}
        try {
          db.prepare('DELETE FROM ModificationTargets WHERE productId = ?').run(numericProductId);
        } catch {}
        try {
          db.prepare('DELETE FROM ImportedLatestBuildIds WHERE productId = ?').run(numericProductId);
        } catch {}
        try {
          db.prepare('DELETE FROM InstalledBaseProducts WHERE productId = ?').run(numericProductId);
        } catch {}
        try {
          db.prepare('DELETE FROM InstalledProducts WHERE productId = ?').run(numericProductId);
        } catch {}
        try {
          db.prepare('DELETE FROM ProductStates WHERE productId = ?').run(numericProductId);
        } catch {}
      } catch {
      } finally {
        if (db) {
          try {
            db.close();
          } catch {}
        }
      }
    }

    if (platform === 'win32' && !options.homedir && !options.skipRegistry && normId) {
      try {
        execFileSync('reg.exe', ['delete', `HKCU\\Software\\GOG.com\\Games\\${normId}`, '/f'], {
          stdio: 'ignore',
          timeout: 3000,
        });
      } catch {}
    }

    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/**
 * Validate whether a bottle directory is properly initialized
 */
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

/**
 * Enumerate subdirectory names inside a Wine/CrossOver Bottles directory
 */
function listBottleSubdirectories(bottlesDir, options = {}) {
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

/**
 * Extract version, buildVersion, displayVersion, and appPath from a macOS compatibility layer binary or bundle
 */
function extractRunnerVersionInfo(runnerTypeOrPath, maybeBinaryPath, maybeOptions = {}) {
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

  // 1. Inspect <Bundle>/Contents/Info.plist if present
  if (appPath) {
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
      try {
        const plistText = fs.readFileSync(plistPath, 'utf8');
        const shortMatch = plistText.match(
          /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/i
        );
        const bundleVerMatch = plistText.match(
          /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/i
        );
        const shortVer = shortMatch ? shortMatch[1].trim() : '';
        const bundleVer = bundleVerMatch ? bundleVerMatch[1].trim() : '';
        const semverMatch = bundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
        const semver = semverMatch ? semverMatch[1] : '';
        const buildNum = semverMatch && semverMatch[2] ? semverMatch[2] : '';

        if (/^\d{8}$/.test(shortVer) && semver) {
          version = semver;
          buildVersion = bundleVer || shortVer;
          displayVersion = `${semver} (Preview ${shortVer})`;
        } else if (semver) {
          version = semver;
          buildVersion = bundleVer || (buildNum ? `Build ${buildNum}` : undefined);
          displayVersion = buildNum ? `${semver} (Build ${buildNum})` : semver;
        } else if (shortVer || bundleVer) {
          version = shortVer || bundleVer;
          buildVersion = bundleVer && bundleVer !== version ? bundleVer : undefined;
          displayVersion = buildVersion ? `${version} (${buildVersion})` : version;
        }
      } catch {}
    }
  }

  // 2. Fallback to Heroic tools folder naming (e.g. Game-Porting-Toolkit-3.0-3 or Wine-CrossOver-23.7.1-2)
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

  // 3. Fallback to Homebrew Cellar/Caskroom path (including symlink resolution)
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
        const out = execFileSync(binaryPath, ['--version'], {
          timeout: 1000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
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

  return {
    appPath,
    version,
    buildVersion,
    displayVersion,
  };
}

/**
 * Parse string key-value pairs from a macOS XML or binary (bplist00) Info.plist file
 */
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

      const readUInt = (offset, byteLen) => {
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

      const readLength = (pos, lowNibble) => {
        if (lowNibble !== 0x0f) return { len: lowNibble, nextPos: pos };
        const intMarker = buf[pos];
        const intBytes = 1 << (intMarker & 0x0f);
        return { len: readUInt(pos + 1, intBytes), nextPos: pos + 1 + intBytes };
      };

      const readObject = (objIdx, depth = 0) => {
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
 * Inspect bundled D3DMetal.framework inside CrossOver / CrossOver Preview / GPTK bundles
 */
function detectBundledD3DMetalVersions(runnerType, binaryPath, appPath) {
  let resolvedAppPath = appPath;
  if (!resolvedAppPath && binaryPath && typeof binaryPath === 'string') {
    const appMatch = binaryPath.match(/^(.*?\.app)(?:[\\/]|$)/i);
    const contentsMatch = binaryPath.match(/^(.*?)[\\/]Contents[\\/]/i);
    resolvedAppPath = appMatch ? appMatch[1] : contentsMatch ? contentsMatch[1] : undefined;
  }

  const readFrameworkVersion = (fwDirs) => {
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

  if (runnerType === 'crossover' || runnerType === 'crossover_preview') {
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

/**
 * Parse a runner version string into numeric core segments plus pre-release stage/number
 * (alpha/a=1, beta/b=2, rc/pre=3, final release=4) and post-release numeric revision.
 */
function parseRunnerVersionSegments(raw) {
  let str = String(raw || '').trim();
  str = str.replace(/^(?:build\s+|v(?=\d))/i, '').trim();
  const coreMatch = str.match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!coreMatch) {
    const fallbackNums = str
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number);
    return { core: fallbackNums, preStage: 4, preNum: 0 };
  }
  const core = coreMatch[1].split('.').map(Number);
  const rest = (coreMatch[2] || '').trim();
  if (!rest) {
    return { core, preStage: 4, preNum: 0 };
  }
  const preMatch = rest.match(/^[-_.]?(alpha|a|beta|b|rc|pre)(?=$|[^a-zA-Z])[-_.]?(\d*)/i);
  if (preMatch) {
    const tag = preMatch[1].toLowerCase();
    const preStage =
      tag === 'alpha' || tag === 'a'
        ? 1
        : tag === 'beta' || tag === 'b'
          ? 2
          : 3;
    const preNum = preMatch[2] ? Number(preMatch[2]) : 0;
    return { core, preStage, preNum };
  }
  const revMatch = rest.match(/^(?:[-_](\d+)|\s*\(?build\s+(\d+)\)?)/i);
  if (revMatch) {
    core.push(Number(revMatch[1] || revMatch[2]));
  }
  return { core, preStage: 4, preNum: 0 };
}

/**
 * Compare two runner version strings semantically with pre-release & build awareness (-1 if vA < vB, 0 if equal, 1 if vA > vB)
 */
function compareRunnerVersions(vA, vB) {
  const parsedA = parseRunnerVersionSegments(vA);
  const parsedB = parseRunnerVersionSegments(vB);
  const maxLen = Math.max(parsedA.core.length, parsedB.core.length);
  for (let i = 0; i < maxLen; i++) {
    const a = parsedA.core[i] || 0;
    const b = parsedB.core[i] || 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  if (parsedA.preStage !== parsedB.preStage) {
    return parsedA.preStage < parsedB.preStage ? -1 : 1;
  }
  if (parsedA.preNum !== parsedB.preNum) {
    return parsedA.preNum < parsedB.preNum ? -1 : 1;
  }
  return 0;
}

/**
 * B) macOS Compatibility Layer Detector (CrossOver, CrossOver Preview, Apple GPTK, Open-Source Wine)
 */
function detectCompatibilityLayers(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return [];
  }

  const homedir = options.homedir || os.homedir();
  const isIsolatedTest = Boolean(options.homedir || options.customApplicationsDir);
  const appsDirs = [];
  if (options.customApplicationsDir) {
    appsDirs.push(options.customApplicationsDir);
  } else {
    appsDirs.push(path.join(homedir, 'Applications'));
    if (!isIsolatedTest) {
      appsDirs.push('/Applications');
    }
  }

  const sharedCrossOverBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver/Bottles'
  );
  const previewSpecBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview/Bottles'
  );

  // Clean up any uninitialized empty directory at ~/Library/Application Support/CrossOver Preview/Bottles/OneLauncher
  const brokenPreviewBottle = path.join(previewSpecBottlesDir, 'OneLauncher');
  if (
    fs.existsSync(brokenPreviewBottle) &&
    !isValidBottleDirectory(brokenPreviewBottle, false)
  ) {
    try {
      fs.rmSync(brokenPreviewBottle, { recursive: true, force: true });
    } catch {}
  }

  const effectivePreviewBottlesDir = hasValidInitializedBottles(
    previewSpecBottlesDir,
    isIsolatedTest
  )
    ? previewSpecBottlesDir
    : fs.existsSync(sharedCrossOverBottlesDir)
      ? sharedCrossOverBottlesDir
      : previewSpecBottlesDir;

  const layers = [];
  const addedTypes = new Set();

  // 1. CrossOver & CrossOver Preview
  const crossoverVariants = [
    {
      id: 'crossover',
      type: 'crossover',
      name: 'CrossOver',
      appName: 'CrossOver.app',
      bottlesDir: sharedCrossOverBottlesDir,
    },
    {
      id: 'crossover_preview',
      type: 'crossover_preview',
      name: 'CrossOver Preview',
      appName: 'CrossOver Preview.app',
      bottlesDir: effectivePreviewBottlesDir,
    },
  ];

  for (const variant of crossoverVariants) {
    for (const appsDir of appsDirs) {
      const appPath = path.join(appsDir, variant.appName);
      if (!fs.existsSync(appPath)) continue;

      const candidateBins = [
        path.join(appPath, 'Contents/SharedSupport/CrossOver/bin/wine'),
        path.join(appPath, 'Contents/SharedSupport/CrossOver/CrossOver-Hosted Application/wine'),
        path.join(appPath, 'Contents/SharedSupport/CrossOver/lib64/apple_gptk/wine'),
      ];
      const binaryPath = candidateBins.find((b) => fs.existsSync(b)) || candidateBins[0];
      const availableBottles = listBottleSubdirectories(variant.bottlesDir, options);
      const versionInfo = extractRunnerVersionInfo(variant.type, binaryPath, options);
      const d3dmInfo = detectBundledD3DMetalVersions(
        variant.type,
        binaryPath,
        versionInfo.appPath || appPath
      );

      if (!addedTypes.has(variant.id)) {
        addedTypes.add(variant.id);
        layers.push({
          id: variant.id,
          type: variant.type,
          name: variant.name,
          binaryPath,
          appPath: versionInfo.appPath || appPath,
          version: versionInfo.version,
          buildVersion: versionInfo.buildVersion,
          displayVersion: versionInfo.displayVersion,
          ...(d3dmInfo.d3dmetalVersion ? { d3dmetalVersion: d3dmInfo.d3dmetalVersion } : {}),
          ...(d3dmInfo.availableD3DMetalVersions
            ? { availableD3DMetalVersions: d3dmInfo.availableD3DMetalVersions }
            : {}),
          bottlesDir: variant.bottlesDir,
          availableBottles,
        });
      }
    }
  }

  // 2. Apple Game Porting Toolkit (Heroic GPTK or /Applications/Game Porting Toolkit.app)
  const heroicGptkRoot = path.join(homedir, 'Library/Application Support/heroic/tools/game-porting-toolkit');
  if (fs.existsSync(heroicGptkRoot)) {
    try {
      const subdirs = fs.readdirSync(heroicGptkRoot);
      for (const sub of subdirs) {
        const binCandidates = [
          path.join(heroicGptkRoot, sub, 'bin/wine64'),
          path.join(heroicGptkRoot, sub, 'Contents/Resources/wine/bin/wine64'),
        ];
        const foundBin = binCandidates.find((b) => fs.existsSync(b));
        if (foundBin && !addedTypes.has('gptk')) {
          addedTypes.add('gptk');
          const versionInfo = extractRunnerVersionInfo('gptk', foundBin, options);
          const d3dmInfo = detectBundledD3DMetalVersions(
            'gptk',
            foundBin,
            versionInfo.appPath || path.join(heroicGptkRoot, sub)
          );
          layers.push({
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
            availableBottles: [],
          });
        }
      }
    } catch {}
  }

  for (const appsDir of appsDirs) {
    const gptkApp = path.join(appsDir, 'Game Porting Toolkit.app');
    if (fs.existsSync(gptkApp) && !addedTypes.has('gptk')) {
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
      addedTypes.add('gptk');
      layers.push({
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
        availableBottles: [],
      });
    }
  }

  // 3. Open-Source Wine (Wine Crossover.app, Wine Stable.app, Wine Staging.app, Heroic Wine, Homebrew/Standalone Wine)
  const wineEntryCandidates = [];
  const wineAppVariants = [
    { appName: 'Wine Crossover.app', label: 'Open-Source Wine (Wine-CrossOver)' },
    { appName: 'Wine Stable.app', label: 'Open-Source Wine (Wine Stable)' },
    { appName: 'Wine Staging.app', label: 'Open-Source Wine (Wine Staging)' },
    { appName: 'Wine Devel.app', label: 'Open-Source Wine (Wine Devel)' },
  ];

  for (const appsDir of appsDirs) {
    for (const wv of wineAppVariants) {
      wineEntryCandidates.push(
        {
          binPath: path.join(appsDir, wv.appName, 'Contents/Resources/wine/bin/wine64'),
          name: wv.label,
        },
        {
          binPath: path.join(appsDir, wv.appName, 'Contents/Resources/wine/bin/wine'),
          name: wv.label,
        }
      );
    }
  }

  const heroicWineRoot = path.join(homedir, 'Library/Application Support/heroic/tools/wine');
  if (fs.existsSync(heroicWineRoot)) {
    try {
      const rankHeroicWineDir = (dirName) => {
        const lower = String(dirName || '').toLowerCase();
        const isDxmt = lower.includes('-dxmt');
        if (lower.includes('wine-staging')) return isDxmt ? 1 : 0;
        if (lower.includes('wine-stable') || lower.includes('wine-devel')) return isDxmt ? 3 : 2;
        if (lower.includes('wine-crossover')) return 5;
        return 4;
      };
      const subdirs = fs
        .readdirSync(heroicWineRoot)
        .filter((sub) => !sub.startsWith('.'))
        .sort((a, b) => {
          const rankDiff = rankHeroicWineDir(a) - rankHeroicWineDir(b);
          if (rankDiff !== 0) return rankDiff;
          return compareRunnerVersions(b, a);
        });
      for (const sub of subdirs) {
        wineEntryCandidates.push(
          {
            binPath: path.join(heroicWineRoot, sub, 'bin/wine64'),
            name: 'Open-Source Wine (Heroic)',
          },
          {
            binPath: path.join(heroicWineRoot, sub, 'Contents/Resources/wine/bin/wine64'),
            name: 'Open-Source Wine (Heroic)',
          },
          {
            binPath: path.join(heroicWineRoot, sub, 'Contents/Resources/wine/bin/wine'),
            name: 'Open-Source Wine (Heroic)',
          },
          {
            binPath: path.join(heroicWineRoot, sub, 'bin/wine'),
            name: 'Open-Source Wine (Heroic)',
          }
        );
      }
    } catch {}
  }

  wineEntryCandidates.push(
    { binPath: path.join(homedir, 'bin/wine64'), name: 'Open-Source Wine (wine64)' },
    { binPath: path.join(homedir, 'bin/wine'), name: 'Open-Source Wine (wine)' }
  );

  if (!isIsolatedTest) {
    wineEntryCandidates.push(
      { binPath: '/opt/homebrew/bin/wine64', name: 'Open-Source Wine (Homebrew wine64)' },
      { binPath: '/usr/local/bin/wine64', name: 'Open-Source Wine (Homebrew wine64)' },
      { binPath: '/opt/homebrew/bin/wine', name: 'Open-Source Wine (Homebrew wine)' },
      { binPath: '/usr/local/bin/wine', name: 'Open-Source Wine (Homebrew wine)' }
    );
  }

  const foundWineEntry = wineEntryCandidates.find((entry) => fs.existsSync(entry.binPath));
  if (foundWineEntry && !addedTypes.has('wine')) {
    addedTypes.add('wine');
    const defaultPrefix = path.join(homedir, '.wine');
    const versionInfo = extractRunnerVersionInfo('wine', foundWineEntry.binPath, options);
    layers.push({
      id: 'wine',
      type: 'wine',
      name: foundWineEntry.name,
      binaryPath: foundWineEntry.binPath,
      appPath: versionInfo.appPath,
      version: versionInfo.version,
      buildVersion: versionInfo.buildVersion,
      displayVersion: versionInfo.displayVersion,
      bottlesDir: fs.existsSync(defaultPrefix) ? defaultPrefix : undefined,
      availableBottles: [],
    });
  }

  // Prioritize compatibility layers that already have an initialized bottle or prefix ready
  const hasSharedPrefix =
    fs.existsSync(path.join(homedir, 'Games/Heroic/Prefixes/default')) ||
    fs.existsSync(path.join(homedir, 'Games/OneLauncher/Prefixes/default/drive_c'));

  const isLayerReady = (layer) => {
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

  return layers;
}

/**
 * Check upstream feeds for macOS compatibility layer updates
 */
async function checkCompatibilityLayerUpdates(options = {}) {
  const layers = Array.isArray(options.layers)
    ? options.layers
    : detectCompatibilityLayers(options);
  const runnerTypes = ['crossover', 'crossover_preview', 'gptk', 'wine'];
  const defaultDownloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://developer.apple.com/games/game-porting-toolkit/',
    wine: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
  };

  const feedMap = {};
  if (options.mockFeeds && typeof options.mockFeeds === 'object') {
    for (const rt of runnerTypes) {
      if (options.mockFeeds[rt]) {
        feedMap[rt] = { ...options.mockFeeds[rt] };
      }
    }
  } else if (
    typeof options.httpGetText === 'function' ||
    (!options.homedir && !options.skipNetwork)
  ) {
    const fetchWithTimeout = async (url, timeoutMs = 4500) => {
      if (typeof options.httpGetText === 'function') {
        try {
          return await options.httpGetText(url);
        } catch {
          return null;
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'OneGameLauncher/1.0' },
        });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    const wineLayer = layers.find((l) => l.type === 'wine');

    await Promise.all([
      // 1. CrossOver Stable Sparkle XML feed
      (async () => {
        const xml = await fetchWithTimeout('https://www.codeweavers.com/xml/versions/cxmac.xml');
        if (xml) {
          const encMatch = xml.match(/<enclosure\s+([^>]+)>/i);
          if (encMatch) {
            const attrs = encMatch[1];
            const verMatch = attrs.match(/sparkle:version="([^"]+)"/i);
            const shortMatch = attrs.match(/sparkle:shortVersionString="([^"]+)"/i);
            const urlMatch = attrs.match(/url="([^"]+)"/i);
            const rawBundleVer = verMatch ? verMatch[1].trim() : '';
            const rawShortVer = shortMatch ? shortMatch[1].trim() : '';
            const semverMatch = rawBundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
            const latestVersion = semverMatch
              ? semverMatch[1]
              : rawShortVer || rawBundleVer || undefined;
            const latestBuildVersion =
              semverMatch && semverMatch[2] ? `Build ${semverMatch[2]}` : undefined;
            const latestDisplayVersion =
              latestVersion && latestBuildVersion
                ? `${latestVersion} (${latestBuildVersion})`
                : latestVersion;
            if (latestVersion) {
              feedMap.crossover = {
                latestVersion,
                rawBundleVersion: rawBundleVer || undefined,
                latestBuildVersion,
                latestDisplayVersion,
                downloadUrl: urlMatch ? urlMatch[1].trim() : defaultDownloadUrls.crossover,
                updateMethod: 'direct_download',
              };
            }
          }
        }
      })(),
      // 2. GPTK latest GitHub release
      (async () => {
        const txt = await fetchWithTimeout(
          'https://api.github.com/repos/Gcenx/game-porting-toolkit/releases/latest'
        );
        if (txt) {
          try {
            const json = JSON.parse(txt);
            const tag = String(json.tag_name || '');
            const m = tag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
            if (m) {
              const rawVer = m[1];
              feedMap.gptk = {
                latestVersion: rawVer.replace(/[-_]/g, '.'),
                latestBuildVersion: rawVer,
                latestDisplayVersion: rawVer,
                downloadUrl: json.html_url || defaultDownloadUrls.gptk,
                updateMethod: 'homebrew_cask',
              };
            }
          } catch {}
        }
      })(),
      // 3. Variant-matched Open-Source Wine upstream feed
      (async () => {
        const wineBinStr = String(wineLayer?.binaryPath || '').replace(/\\/g, '/');
        const wineAppStr = String(wineLayer?.appPath || '').replace(/\\/g, '/');
        const wineNameStr = String(wineLayer?.name || '');

        const isRetiredWineCrossOver =
          Boolean(wineLayer) &&
          (/wine[- ]crossover/i.test(wineBinStr) ||
            /wine[- ]crossover/i.test(wineAppStr) ||
            /wine[- ]crossover/i.test(wineNameStr));
        if (isRetiredWineCrossOver) {
          return;
        }

        const isHeroicWineStaging =
          Boolean(wineLayer) && /\/heroic\/tools\/wine\/.*staging/i.test(wineBinStr);
        if (isHeroicWineStaging) {
          const txt = await fetchWithTimeout(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest'
          );
          if (txt) {
            try {
              const json = JSON.parse(txt);
              const tag = String(json.tag_name || json.name || '');
              const m = tag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
              if (m) {
                const rawVer = m[1];
                feedMap.wine = {
                  latestVersion: rawVer.replace(/[-_]/g, '.'),
                  latestBuildVersion: rawVer,
                  latestDisplayVersion: rawVer,
                  downloadUrl:
                    json.html_url || 'https://github.com/Gcenx/macOS_Wine_builds/releases',
                  updateMethod: 'vendor_portal',
                };
              }
            } catch {}
          }
          return;
        }

        const isHomebrewWineStaging =
          Boolean(wineLayer) &&
          (/Wine Staging\.app/i.test(wineBinStr) ||
            /Wine Staging\.app/i.test(wineAppStr) ||
            /Wine Staging/i.test(wineNameStr));
        const caskFeedUrl = isHomebrewWineStaging
          ? 'https://formulae.brew.sh/api/cask/wine@staging.json'
          : 'https://formulae.brew.sh/api/cask/wine-stable.json';
        const txt = await fetchWithTimeout(caskFeedUrl);
        if (txt) {
          try {
            const json = JSON.parse(txt);
            if (json && json.version) {
              const rawVer = String(json.version);
              feedMap.wine = {
                latestVersion: rawVer.replace(/[-_]/g, '.'),
                latestBuildVersion: rawVer,
                latestDisplayVersion: rawVer,
                downloadUrl: json.url || defaultDownloadUrls.wine,
                updateMethod: 'homebrew_cask',
              };
            }
          } catch {}
        }
      })(),
    ]);
  }

  const checkedAt = new Date().toISOString();
  const results = {};

  for (const runnerType of runnerTypes) {
    const layer = layers.find((l) => l.type === runnerType);
    const feed = feedMap[runnerType] || {};
    const stableFeed = feedMap.crossover;
    const stableSurpassesPreview = Boolean(
      runnerType === 'crossover_preview' &&
        layer &&
        layer.version &&
        stableFeed &&
        stableFeed.latestVersion &&
        compareRunnerVersions(layer.version, stableFeed.latestVersion) < 0
    );

    let latestVersion;
    let latestBuildVersion;
    let latestDisplayVersion;

    if (feed.latestVersion) {
      latestVersion = feed.latestVersion;
      latestBuildVersion = feed.latestBuildVersion;
      latestDisplayVersion =
        feed.latestDisplayVersion ||
        (latestBuildVersion && !String(latestVersion).includes(String(latestBuildVersion))
          ? `${latestVersion} (${latestBuildVersion})`
          : latestVersion);
    } else if (stableSurpassesPreview) {
      latestVersion = stableFeed.latestVersion;
      latestBuildVersion = stableFeed.latestBuildVersion;
      latestDisplayVersion = stableFeed.latestDisplayVersion || latestVersion;
    } else {
      latestVersion = layer?.version;
      latestBuildVersion = layer?.buildVersion;
      latestDisplayVersion = layer?.displayVersion;
    }

    let updateAvailable = false;
    if (layer && layer.version) {
      if (feed.latestVersion) {
        if (feed.rawBundleVersion && layer.buildVersion) {
          updateAvailable =
            compareRunnerVersions(layer.buildVersion, feed.rawBundleVersion) < 0 ||
            compareRunnerVersions(layer.version, feed.latestVersion) < 0;
        } else {
          updateAvailable = compareRunnerVersions(layer.version, feed.latestVersion) < 0;
        }
      }
      if (!updateAvailable && stableSurpassesPreview) {
        updateAvailable = true;
        if (
          stableFeed.latestVersion &&
          (!latestVersion || compareRunnerVersions(latestVersion, stableFeed.latestVersion) < 0)
        ) {
          latestVersion = stableFeed.latestVersion;
          latestBuildVersion = stableFeed.latestBuildVersion;
          latestDisplayVersion = stableFeed.latestDisplayVersion || latestVersion;
        }
      }
    }

    const updateMethod =
      feed.updateMethod ||
      (runnerType === 'crossover_preview'
        ? 'vendor_portal'
        : runnerType === 'crossover'
          ? 'direct_download'
          : 'homebrew_cask');

    const statusMessage = !layer
      ? 'Not installed'
      : updateAvailable
        ? `Update available: ${latestDisplayVersion || latestVersion}`
        : `Up to date (${layer.displayVersion || layer.version || 'Installed'})`;

    results[runnerType] = {
      runnerType,
      installed: Boolean(layer),
      installedVersion: layer?.version,
      installedBuildVersion: layer?.buildVersion,
      installedDisplayVersion: layer?.displayVersion,
      latestVersion,
      latestBuildVersion,
      latestDisplayVersion,
      updateAvailable,
      downloadUrl: feed.downloadUrl || defaultDownloadUrls[runnerType],
      canAutoUpdate: true,
      updateMethod,
      statusMessage,
      checkedAt,
    };
  }

  return results;
}

/**
 * One-click update for a macOS compatibility layer (via Homebrew Cask, direct Sparkle archive, or official vendor portal)
 */
async function updateCompatibilityLayer(payload = {}, options = {}) {
  const runnerType = String(payload.runnerType || 'crossover')
    .toLowerCase()
    .trim();
  const homedir = options.homedir || os.homedir();
  const beforeLayers = detectCompatibilityLayers(options);
  const beforeLayer = beforeLayers.find((l) => l.type === runnerType);
  const previousVersion = beforeLayer?.version;
  const previousBuildVersion = beforeLayer?.buildVersion;

  if (typeof options.mockUpdater === 'function') {
    const mockRes = (await options.mockUpdater(payload, options)) || {};
    const detectedLayers = detectCompatibilityLayers(options);
    const newVersion =
      mockRes.newVersion || detectedLayers.find((l) => l.type === runnerType)?.version;
    const updates = await checkCompatibilityLayerUpdates({ ...options, layers: detectedLayers });
    const updated =
      mockRes.updated !== undefined
        ? Boolean(mockRes.updated)
        : Boolean(newVersion && newVersion !== previousVersion);
    return {
      success: mockRes.success !== false,
      runnerType,
      updated,
      previousVersion,
      newVersion,
      openedExternalUrl: Boolean(mockRes.openedExternalUrl),
      message:
        mockRes.message ||
        (updated
          ? `Successfully updated ${runnerType} to ${newVersion || 'latest version'}.`
          : 'Runner update check completed.'),
      detectedLayers,
      updateInfo: updates[runnerType],
    };
  }

  const defaultUpdateUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://developer.apple.com/games/game-porting-toolkit/',
    wine: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
  };

  const brewCandidates = [
    options.brewBinaryPath,
    path.join(homedir, 'homebrew/bin/brew'),
    ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
  ].filter(Boolean);
  const brewPath = brewCandidates.find((p) => fs.existsSync(p));

  const beforeBinNorm = String(beforeLayer?.binaryPath || '').replace(/\\/g, '/');
  const beforeAppNorm = String(beforeLayer?.appPath || '').replace(/\\/g, '/');
  const isWineStagingApp = Boolean(
    beforeLayer &&
      (/Wine Staging\.app/i.test(beforeBinNorm) ||
        /Wine Staging\.app/i.test(beforeAppNorm) ||
        /Wine Staging/i.test(String(beforeLayer.name || '')))
  );
  const isHeroicManagedTool = Boolean(beforeLayer && /\/heroic\/tools\//i.test(beforeBinNorm));

  const caskMap = {
    crossover: 'crossover',
    wine: isWineStagingApp ? 'wine@staging' : 'wine-stable',
    gptk: 'game-porting-toolkit',
  };
  const caskName = caskMap[runnerType];
  let updatedViaBrew = false;
  let usedMockBrewHook = false;
  let extractedDmg = false;

  if (caskName && typeof options.onExecBrew === 'function') {
    const args = [
      'upgrade',
      '--cask',
      ...(runnerType === 'wine' ? ['--no-quarantine'] : []),
      caskName,
    ];
    try {
      await options.onExecBrew(brewPath || '/opt/homebrew/bin/brew', args);
      updatedViaBrew = true;
      usedMockBrewHook = true;
    } catch {}
  } else if (caskName && brewPath && !isHeroicManagedTool) {
    const args = [
      'upgrade',
      '--cask',
      ...(runnerType === 'wine' ? ['--no-quarantine'] : []),
      caskName,
    ];
    try {
      const isCaskManaged = await new Promise((resolve) => {
        execFile(brewPath, ['list', '--cask', caskName], { timeout: 15000 }, (err) => {
          resolve(!err);
        });
      });
      if (isCaskManaged) {
        await new Promise((resolve, reject) => {
          execFile(brewPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
        updatedViaBrew = true;
      }
    } catch {}
  }

  if (!updatedViaBrew && payload.dmgPath && fs.existsSync(payload.dmgPath)) {
    try {
      const targetAppsDir = options.customApplicationsDir || path.join(homedir, 'Applications');
      await mountAndExtractDmgSafe(payload.dmgPath, targetAppsDir, options);
      updatedViaBrew = true;
      extractedDmg = true;
    } catch {}
  }

  const detectedLayers = detectCompatibilityLayers(options);
  const afterLayer = detectedLayers.find((l) => l.type === runnerType);
  const newVersion = afterLayer?.version;
  const newBuildVersion = afterLayer?.buildVersion;
  const updates = await checkCompatibilityLayerUpdates({ ...options, layers: detectedLayers });

  let openedExternalUrl = false;
  if (!updatedViaBrew) {
    const targetUrl =
      updates[runnerType]?.downloadUrl ||
      defaultUpdateUrls[runnerType] ||
      defaultUpdateUrls.crossover;
    await openExternalUri(targetUrl, options);
    openedExternalUrl = true;
  }

  const versionChanged = Boolean(
    (newVersion && newVersion !== previousVersion) ||
      (newBuildVersion && newBuildVersion !== previousBuildVersion)
  );
  const updated =
    usedMockBrewHook || extractedDmg
      ? Boolean(versionChanged || updatedViaBrew)
      : versionChanged;

  return {
    success: true,
    runnerType,
    updated,
    previousVersion,
    newVersion,
    openedExternalUrl,
    message: updated
      ? `Successfully updated ${runnerType} to ${newVersion || 'latest version'}.`
      : openedExternalUrl
        ? 'Opened official update page in your browser. Click "Re-Scan Runners" once installation finishes.'
        : 'Runner is already up to date.',
    detectedLayers,
    updateInfo: updates[runnerType],
  };
}

/**
 * Safely mount a macOS .dmg archive via hdiutil attach, copy any .app bundle inside to targetDestDir,
 * and guarantee hdiutil detach runs inside a finally block.
 */
async function mountAndExtractDmgSafe(dmgPath, targetDestDir, options = {}) {
  const mountPoint = path.join(
    os.tmpdir(),
    `ol-dmg-mount-${process.pid}-${Date.now()}`
  );
  const execHdiutil =
    typeof options.onExecHdiutil === 'function'
      ? options.onExecHdiutil
      : (args) =>
          new Promise((resolve, reject) => {
            execFile(
              'hdiutil',
              args,
              { timeout: 120000 },
              (err, stdout, stderr) => {
                if (err) reject(err);
                else resolve({ stdout, stderr });
              }
            );
          });

  let attached = false;
  try {
    await execHdiutil([
      'attach',
      dmgPath,
      '-mountpoint',
      mountPoint,
      '-nobrowse',
      '-readonly',
      '-quiet',
    ]);
    attached = true;

    if (fs.existsSync(mountPoint) && targetDestDir) {
      fs.mkdirSync(targetDestDir, { recursive: true });
      const entries = fs.readdirSync(mountPoint);
      const appEntry = entries.find((e) => e.toLowerCase().endsWith('.app'));
      if (appEntry) {
        const srcApp = path.join(mountPoint, appEntry);
        const destApp = path.join(targetDestDir, appEntry);
        fs.cpSync(srcApp, destApp, { recursive: true, force: true });
      }
    }
    return { success: true, mountPoint };
  } finally {
    if (attached || typeof options.onExecHdiutil === 'function') {
      try {
        await execHdiutil(['detach', mountPoint, '-force', '-quiet']);
      } catch {}
    }
  }
}

/**
 * Install or open official download page for a macOS Windows compatibility layer (CrossOver, CrossOver Preview, GPTK, Open-Source Wine)
 */
async function installCompatibilityLayer(payload = {}, options = {}) {
  const runnerType = String(payload.runnerType || 'crossover')
    .toLowerCase()
    .trim();
  const mode = String(payload.mode || 'auto')
    .toLowerCase()
    .trim();
  const homedir = options.homedir || os.homedir();

  const downloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://developer.apple.com/games/game-porting-toolkit/',
    wine: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
  };
  const downloadUrl = downloadUrls[runnerType] || downloadUrls.crossover;

  if (mode === 'download') {
    await openExternalUri(downloadUrl, options);
    return {
      success: true,
      openedExternalInstaller: true,
      runnerType,
      message: 'Opened official download page in your browser.',
      layers: detectCompatibilityLayers(options),
    };
  }

  const brewCandidates = [
    options.brewBinaryPath,
    path.join(homedir, 'homebrew/bin/brew'),
    ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
  ].filter(Boolean);
  const brewPath = brewCandidates.find((p) => fs.existsSync(p));

  if (
    (brewPath || typeof options.onExecBrew === 'function') &&
    (runnerType === 'crossover' || runnerType === 'wine')
  ) {
    const args =
      runnerType === 'crossover'
        ? ['install', '--cask', 'crossover']
        : ['install', '--cask', '--no-quarantine', 'wine-stable'];
    try {
      if (typeof options.onExecBrew === 'function') {
        await options.onExecBrew(brewPath || '/opt/homebrew/bin/brew', args);
      } else {
        await new Promise((resolve, reject) => {
          execFile(brewPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
      }
      const layers = detectCompatibilityLayers(options);
      if (layers.some((l) => l.type === runnerType)) {
        return {
          success: true,
          installed: true,
          runnerType,
          message: 'Successfully installed via Homebrew!',
          layers,
        };
      }
    } catch {}
  }

  await openExternalUri(downloadUrl, options);
  return {
    success: true,
    openedExternalInstaller: true,
    runnerType,
    message:
      'Opened official installer page in your browser. Click "Re-Scan Runners" once installation finishes.',
    layers: detectCompatibilityLayers(options),
  };
}

/**
 * Resolve the bundled libMoltenVK.dylib path for a given Wine executable or layer object.
 */
function resolveWineLayerMoltenVkPath(wineBinary) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return null;

  const normalizedBin = path.resolve(binPath);
  const binDir = path.dirname(normalizedBin);
  const wineRoot = path.resolve(binDir, '..');
  const candidates = [
    normalizedBin.endsWith('.dylib') ? normalizedBin : null,
    path.join(wineRoot, 'lib', 'libMoltenVK.dylib'),
    path.join(wineRoot, 'lib64', 'libMoltenVK.dylib'),
    path.join(wineRoot, 'lib', 'external', 'libMoltenVK.dylib'),
    path.join(wineRoot, 'lib64', 'external', 'libMoltenVK.dylib'),
    path.join(wineRoot, 'lib', 'apple_gptk', 'external', 'libMoltenVK.dylib'),
    path.join(wineRoot, 'lib64', 'apple_gptk', 'external', 'libMoltenVK.dylib'),
    path.join(wineRoot, 'lib', 'wine', 'x86_64-unix', 'libMoltenVK.dylib'),
    path.join(binDir, 'libMoltenVK.dylib'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

/**
 * Detect whether a Wine distribution bundles an older libMoltenVK.dylib containing the
 * C++ static initializer `_GLOBAL__sub_I_mvk_datatypes.mm`, which calls `MTLRegisterDevices()`
 * inside `dlopen()` while holding the global dyld API lock and deadlocks with Apple's
 * `libMTLHud.dylib` (`MTL_HUD_ENABLED=1`) on macOS Thread 0 unless pre-initialized.
 */
function doesWineLayerHaveMoltenVkHudDeadlock(wineBinary) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return false;

  const normalizedBin = path.resolve(binPath);
  if (moltenVkHudDeadlockCache.has(normalizedBin)) {
    return moltenVkHudDeadlockCache.get(normalizedBin);
  }

  const dylibPath = resolveWineLayerMoltenVkPath(normalizedBin);
  if (!dylibPath) {
    return false;
  }

  let hasDeadlock = false;
  try {
    const buf = fs.readFileSync(dylibPath);
    if (buf.includes('_GLOBAL__sub_I_mvk_datatypes.mm')) {
      hasDeadlock = true;
    }
    moltenVkHudDeadlockCache.set(normalizedBin, hasDeadlock);
  } catch {}

  return hasDeadlock;
}

/**
 * Ensure the x86_64 `libone_metal_preload.dylib` helper exists on a real filesystem path
 * outside `app.asar` so `dyld` can load it via `DYLD_INSERT_LIBRARIES`.
 * This dylib interposes `CFRunLoopRun` on macOS Thread 0 to pre-initialize Metal and
 * `libMoltenVK.dylib` before any Win32 threads are created, allowing `MTL_HUD_ENABLED=1`
 * to work on Open-Source Wine / GPTK without deadlocking.
 */
function ensureWineMetalPreloadDylib(options = {}) {
  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const unpackedDylib = path.join(unpackedDir, 'helpers', 'libone_metal_preload.dylib');
  const bundledDylib = path.join(__dirname, 'helpers', 'libone_metal_preload.dylib');

  if (!/\.asar[\\/]/i.test(unpackedDylib) && fs.existsSync(unpackedDylib)) {
    return unpackedDylib;
  }
  if (!/\.asar[\\/]/i.test(bundledDylib) && fs.existsSync(bundledDylib)) {
    return bundledDylib;
  }

  const helpersOutDir = path.join(getUserDataDir(options?.userDataDir), 'helpers');
  const extractedDylib = path.join(helpersOutDir, 'libone_metal_preload.dylib');

  if (fs.existsSync(bundledDylib)) {
    try {
      if (!fs.existsSync(helpersOutDir)) {
        fs.mkdirSync(helpersOutDir, { recursive: true });
      }
      if (!fs.existsSync(extractedDylib)) {
        fs.writeFileSync(extractedDylib, fs.readFileSync(bundledDylib));
        fs.chmodSync(extractedDylib, 0o755);
      }
      return extractedDylib;
    } catch {}
  }

  if (fs.existsSync(extractedDylib)) {
    return extractedDylib;
  }

  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/clang')) {
    try {
      if (!fs.existsSync(helpersOutDir)) {
        fs.mkdirSync(helpersOutDir, { recursive: true });
      }
      const bundledCSrc = path.join(__dirname, 'helpers', 'one_metal_preload.c');
      const targetCSrc = fs.existsSync(bundledCSrc)
        ? bundledCSrc
        : path.join(helpersOutDir, 'one_metal_preload.c');
      if (!fs.existsSync(targetCSrc)) {
        fs.writeFileSync(
          targetCSrc,
          [
            '#include <dlfcn.h>',
            '#include <stdlib.h>',
            '#include <pthread.h>',
            '#include <CoreFoundation/CoreFoundation.h>',
            'extern void *MTLCreateSystemDefaultDevice(void);',
            'struct interpose_s { void *new_func; void *orig_func; };',
            'static pthread_once_t s_once = PTHREAD_ONCE_INIT;',
            'static void preinit_metal_and_mvk(void) {',
            '  void *dev = MTLCreateSystemDefaultDevice(); (void)dev;',
            '  const char *mvk_path = getenv("ONE_LAUNCHER_MOLTENVK_PATH");',
            '  if (mvk_path && mvk_path[0]) dlopen(mvk_path, RTLD_NOW | RTLD_GLOBAL);',
            '  dlopen("libMoltenVK.dylib", RTLD_NOW | RTLD_GLOBAL);',
            '}',
            'static void my_CFRunLoopRun(void) {',
            '  if (pthread_main_np()) pthread_once(&s_once, preinit_metal_and_mvk);',
            '  CFRunLoopRun();',
            '}',
            '__attribute__((used)) static const struct interpose_s interpose_CFRunLoopRun',
            '  __attribute__((section("__DATA,__interpose"))) = { (void *)my_CFRunLoopRun, (void *)CFRunLoopRun };',
            '',
          ].join('\n'),
          'utf8'
        );
      }
      execFileSync(
        '/usr/bin/clang',
        [
          '-arch',
          'x86_64',
          '-dynamiclib',
          '-O2',
          '-mmacosx-version-min=11.0',
          targetCSrc,
          '-o',
          extractedDylib,
          '-framework',
          'CoreFoundation',
          '-framework',
          'Metal',
        ],
        { timeout: 5000, stdio: 'ignore' }
      );
      if (fs.existsSync(extractedDylib)) {
        return extractedDylib;
      }
    } catch {}
  }

  return null;
}

/**
 * Resolve the adjacent wineserver / wineserver64 binary for a given Wine executable path.
 */
function resolveWineserverBinary(wineBinary) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return null;

  const normalizedBin = path.resolve(binPath);
  if (/wineserver(?:64)?$/i.test(normalizedBin) && fs.existsSync(normalizedBin)) {
    return normalizedBin;
  }

  const binDir = path.dirname(normalizedBin);
  const parentBinDir = path.resolve(binDir, '..', 'bin');
  const candidates = [
    path.join(binDir, 'wineserver'),
    path.join(binDir, 'wineserver64'),
    path.join(parentBinDir, 'wineserver'),
    path.join(parentBinDir, 'wineserver64'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

/**
 * Cleanly terminate all processes in a Wine prefix (`wineserver -k`) and wait until
 * `wineserver` and all background prefix daemons (`explorer.exe`, `services.exe`, etc.)
 * have completely exited and flushed registry state (`wineserver -w`).
 */
async function shutdownWinePrefix(wineBinary, winePrefix, timeoutMs = 3000) {
  const wineserverBin = resolveWineserverBinary(wineBinary);
  if (!wineserverBin || !winePrefix) {
    return false;
  }

  const prefixEnv = {
    ...process.env,
    WINEPREFIX: winePrefix,
  };

  await new Promise((resolve) => {
    try {
      execFile(wineserverBin, ['-k'], { env: prefixEnv, timeout: timeoutMs }, () => resolve());
    } catch {
      resolve();
    }
  });

  await new Promise((resolve) => {
    try {
      execFile(wineserverBin, ['-w'], { env: prefixEnv, timeout: timeoutMs }, () => resolve());
    } catch {
      resolve();
    }
  });

  return true;
}

/**
 * Case-insensitive segment resolver inside a Wine prefix drive_c directory.
 */
function resolveBottleDriveCPathCaseInsensitive(driveCRoot, segments) {
  if (!driveCRoot || !Array.isArray(segments) || segments.length === 0) return null;
  let current = driveCRoot;
  try {
    if (!fs.existsSync(current)) return null;
    for (const seg of segments) {
      const exactNext = path.join(current, seg);
      if (fs.existsSync(exactNext)) {
        current = exactNext;
        continue;
      }
      const lowerSeg = String(seg).toLowerCase();
      const entries = fs.readdirSync(current);
      const matched = entries.find((entry) => entry.toLowerCase() === lowerSeg);
      if (!matched) return null;
      current = path.join(current, matched);
    }
    return current;
  } catch {
    return null;
  }
}

/**
 * Locate Windows `GalaxyClient.exe` inside a Wine/CrossOver prefix (`drive_c`).
 */
function resolveBottleGogGalaxyExe(winePrefix) {
  if (!winePrefix || typeof winePrefix !== 'string') return null;
  const driveCRoot =
    resolveBottleDriveCPathCaseInsensitive(winePrefix, ['drive_c']) ||
    path.join(winePrefix, 'drive_c');
  const candidateSegmentsList = [
    ['Program Files (x86)', 'GOG Galaxy', 'GalaxyClient.exe'],
    ['Program Files', 'GOG Galaxy', 'GalaxyClient.exe'],
    ['GOG Galaxy', 'GalaxyClient.exe'],
  ];
  for (const segs of candidateSegmentsList) {
    const candidates = [
      path.join(driveCRoot, ...segs),
      resolveBottleDriveCPathCaseInsensitive(driveCRoot, segs),
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
 * Locate Windows `EpicGamesLauncher.exe` inside a Wine/CrossOver prefix (`drive_c`).
 */
function resolveBottleEpicLauncherExe(winePrefix) {
  if (!winePrefix || typeof winePrefix !== 'string') return null;
  const driveCRoot =
    resolveBottleDriveCPathCaseInsensitive(winePrefix, ['drive_c']) ||
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
      resolveBottleDriveCPathCaseInsensitive(driveCRoot, segs),
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
 * Apply per-game CrossOver 26 settings (Graphics Backend, DLSS, MSync/ESync, High Resolution Mode, HUD overlays)
 * to the launch environment, <bottlePath>/cxbottle.conf, and <bottlePath>/user.reg.
 */
function applyCrossOverPerGameSettings(
  chosenLayerOrBottlePath,
  launchConfig = {},
  envOrOptions = {},
  bottlePath = '',
  options = {}
) {
  const isStringBottleFirstArg = typeof chosenLayerOrBottlePath === 'string';
  const effectiveOptions = isStringBottleFirstArg
    ? envOrOptions && typeof envOrOptions === 'object'
      ? envOrOptions
      : {}
    : options && typeof options === 'object'
      ? options
      : {};
  const chosenLayer = isStringBottleFirstArg
    ? { type: effectiveOptions.isPreviewRunner ? 'crossover_preview' : 'crossover' }
    : chosenLayerOrBottlePath;
  const env = isStringBottleFirstArg
    ? {}
    : envOrOptions && typeof envOrOptions === 'object'
      ? envOrOptions
      : {};
  const effectiveBottlePathArg = isStringBottleFirstArg ? chosenLayerOrBottlePath : bottlePath;

  const cfg = launchConfig && typeof launchConfig === 'object' ? launchConfig : {};
  const backend =
    typeof cfg.crossoverGraphicsBackend === 'string'
      ? cfg.crossoverGraphicsBackend.toLowerCase().trim()
      : undefined;
  const d3dmVer =
    typeof cfg.crossoverD3DMetalVersion === 'string'
      ? cfg.crossoverD3DMetalVersion.toLowerCase().trim()
      : undefined;
  const isD3DMetalEligible = !backend || backend === 'auto' || backend === 'd3dmetal';

  // 1. Graphics Backend ('auto' | 'd3dmetal' | 'dxmt' | 'dxvk' | 'wined3d')
  if (
    backend === 'd3dmetal' ||
    backend === 'dxmt' ||
    backend === 'dxvk' ||
    backend === 'wined3d'
  ) {
    env.CX_GRAPHICS_BACKEND = backend;
    if (backend === 'd3dmetal') {
      env.WINED3DMETAL = '1';
    } else {
      delete env.WINED3DMETAL;
    }
  } else if (backend === 'auto') {
    delete env.CX_GRAPHICS_BACKEND;
    delete env.WINED3DMETAL;
  }

  // 1b. D3DMetal Version ('auto' | '4' | '3') -> CX_GRAPHICS_BACKEND_VERSION
  if (isD3DMetalEligible && (d3dmVer === '3' || d3dmVer === '4')) {
    env.CX_GRAPHICS_BACKEND_VERSION = d3dmVer;
  } else if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION) {
    delete env.CX_GRAPHICS_BACKEND_VERSION;
  }

  // 2. DLSS (only applicable when backend is 'auto'/undefined, 'd3dmetal', or 'dxmt')
  const dlssUnsupportedBackend = backend === 'dxvk' || backend === 'wined3d';
  if (cfg.crossoverDlss === true && !dlssUnsupportedBackend) {
    env.D3DM_ENABLE_METALFX = '1';
    env.DXMT_ENABLE_NVEXT = '1';
  } else if (cfg.crossoverDlss === false || (cfg.crossoverDlss === true && dlssUnsupportedBackend)) {
    env.D3DM_ENABLE_METALFX = '0';
    env.DXMT_ENABLE_NVEXT = '0';
  }

  // 3. Synchronization (wineMsync, wineEsync — mutually exclusive in Wine/CrossOver 26)
  if (cfg.wineMsync === false) {
    env.WINEMSYNC = '0';
    env.WINEESYNC = cfg.wineEsync === false ? '0' : '1';
  } else {
    env.WINEMSYNC = '1';
    env.WINEESYNC = '0';
  }

  // 4. HUD Overlays (metalHud, dxvkHud)
  if (cfg.metalHud === true) {
    env.MTL_HUD_ENABLED = '1';
    const candidateWineBin =
      (chosenLayer && typeof chosenLayer === 'object' && chosenLayer.binaryPath) ||
      effectiveOptions.wineBinary ||
      '';
    if (candidateWineBin && doesWineLayerHaveMoltenVkHudDeadlock(candidateWineBin)) {
      const preloadDylib = ensureWineMetalPreloadDylib(effectiveOptions);
      const moltenVkPath = resolveWineLayerMoltenVkPath(candidateWineBin);
      if (preloadDylib) {
        const existingInsert = String(env.DYLD_INSERT_LIBRARIES || '')
          .split(':')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!existingInsert.includes(preloadDylib)) {
          existingInsert.unshift(preloadDylib);
        }
        env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
        if (moltenVkPath) {
          env.ONE_LAUNCHER_MOLTENVK_PATH = moltenVkPath;
        }
      } else {
        delete env.MTL_HUD_ENABLED;
      }
    }
  } else if (cfg.metalHud === false) {
    delete env.MTL_HUD_ENABLED;
    delete env.ONE_LAUNCHER_MOLTENVK_PATH;
    if (env.DYLD_INSERT_LIBRARIES) {
      const filteredInsert = String(env.DYLD_INSERT_LIBRARIES)
        .split(':')
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith('libone_metal_preload.dylib'));
      if (filteredInsert.length > 0) {
        env.DYLD_INSERT_LIBRARIES = filteredInsert.join(':');
      } else {
        delete env.DYLD_INSERT_LIBRARIES;
      }
    }
  }

  if (cfg.dxvkHud === true) {
    env.DXVK_HUD = env.DXVK_HUD || 'devinfo,fps,frametimes';
  } else if (cfg.dxvkHud === false) {
    delete env.DXVK_HUD;
  }

  // 4b. Wine Debug Logging suppression (WINEDEBUG=-all unless explicitly overridden)
  const perfSettings = getLauncherPerformanceSettings(effectiveOptions);
  if (typeof cfg.wineDebug === 'string' && cfg.wineDebug.trim()) {
    env.WINEDEBUG = cfg.wineDebug.trim();
  } else if (
    perfSettings.suppressWineDebugLogging !== false &&
    !cfg.environmentVariables?.WINEDEBUG &&
    !env.WINEDEBUG
  ) {
    env.WINEDEBUG = '-all';
  }

  const resolvedBottlePath = effectiveBottlePathArg || env.WINEPREFIX || '';
  let isBottleDir = false;
  if (resolvedBottlePath && fs.existsSync(resolvedBottlePath)) {
    try {
      isBottleDir = fs.statSync(resolvedBottlePath).isDirectory();
    } catch {}
  }

  // 5. Update <bottlePath>/cxbottle.conf [EnvironmentVariables] & [Bottle] sections
  if (isBottleDir) {
    const cxbottleConfPath = path.join(resolvedBottlePath, 'cxbottle.conf');
    const isPreviewRunner =
      chosenLayer?.type === 'crossover_preview' || Boolean(effectiveOptions.isPreviewRunner);
    const hasCrossOverEnvConfig =
      backend !== undefined ||
      typeof cfg.crossoverD3DMetalVersion === 'string' ||
      typeof cfg.crossoverDlss === 'boolean' ||
      typeof cfg.wineMsync === 'boolean' ||
      typeof cfg.wineEsync === 'boolean' ||
      chosenLayer?.type === 'crossover' ||
      isPreviewRunner ||
      fs.existsSync(cxbottleConfPath);

    if (hasCrossOverEnvConfig) {
      try {
        let existingConf = fs.existsSync(cxbottleConfPath)
          ? fs.readFileSync(cxbottleConfPath, 'utf8')
          : '';

        // CodeWeavers CrossOver Preview wine wrapper requires "Preview" = "1" inside [Bottle] or it exits with code 1
        if (isPreviewRunner) {
          if (/^"Preview"\s*=\s*"[^"]*"/m.test(existingConf)) {
            existingConf = existingConf.replace(
              /^"Preview"\s*=\s*"[^"]*"/m,
              '"Preview" = "1"'
            );
          } else if (/^\[Bottle\]\s*$/m.test(existingConf)) {
            existingConf = existingConf.replace(
              /^\[Bottle\]\s*$/m,
              '[Bottle]\n"Preview" = "1"'
            );
          } else {
            existingConf = `[Bottle]\n"WineArch" = "win64"\n"Preview" = "1"\n\n${existingConf}`;
          }
        }

        const updates = new Map();
        const removals = new Set();

        if (
          backend === 'd3dmetal' ||
          backend === 'dxmt' ||
          backend === 'dxvk' ||
          backend === 'wined3d'
        ) {
          updates.set('CX_GRAPHICS_BACKEND', backend);
        } else if (backend === 'auto') {
          removals.add('CX_GRAPHICS_BACKEND');
        }

        if (isD3DMetalEligible && (d3dmVer === '3' || d3dmVer === '4')) {
          updates.set('CX_GRAPHICS_BACKEND_VERSION', d3dmVer);
        } else {
          removals.add('CX_GRAPHICS_BACKEND_VERSION');
        }

        if (cfg.crossoverDlss === true && !dlssUnsupportedBackend) {
          updates.set('D3DM_ENABLE_METALFX', '1');
          updates.set('DXMT_ENABLE_NVEXT', '1');
        } else if (
          cfg.crossoverDlss === false ||
          (cfg.crossoverDlss === true && dlssUnsupportedBackend)
        ) {
          updates.set('D3DM_ENABLE_METALFX', '0');
          updates.set('DXMT_ENABLE_NVEXT', '0');
        }

        updates.set('WINEMSYNC', env.WINEMSYNC);
        updates.set('WINEESYNC', env.WINEESYNC);

        const sectionHeaderRe = /^\[EnvironmentVariables\]\s*$/m;
        const headerMatch = sectionHeaderRe.exec(existingConf);

        if (headerMatch) {
          const sectionStart = headerMatch.index + headerMatch[0].length;
          const afterHeader = existingConf.slice(sectionStart);
          const nextSectionMatch = /^\s*\[[^\]]+\]/m.exec(afterHeader);
          const sectionBody = nextSectionMatch
            ? afterHeader.slice(0, nextSectionMatch.index)
            : afterHeader;
          const remainder = nextSectionMatch ? afterHeader.slice(nextSectionMatch.index) : '';

          const lines = sectionBody.split(/\r?\n/);
          const seenKeys = new Set();
          const updatedLines = [];

          for (const line of lines) {
            const kvMatch = line.match(/^\s*"?([A-Za-z0-9_]+)"?\s*=\s*(.*)$/);
            if (kvMatch) {
              const key = kvMatch[1];
              if (removals.has(key)) {
                continue;
              }
              if (updates.has(key)) {
                seenKeys.add(key);
                updatedLines.push(`"${key}" = "${updates.get(key)}"`);
                continue;
              }
            }
            updatedLines.push(line);
          }

          const newEntries = [];
          for (const [k, v] of updates.entries()) {
            if (!seenKeys.has(k)) {
              newEntries.push(`"${k}" = "${v}"`);
            }
          }

          if (newEntries.length > 0) {
            let insertIdx = updatedLines.length;
            while (insertIdx > 0 && updatedLines[insertIdx - 1].trim() === '') {
              insertIdx--;
            }
            updatedLines.splice(insertIdx, 0, ...newEntries);
          }

          const newSectionBody =
            (updatedLines.length > 0 && updatedLines[0] !== '' ? '\n' : '') +
            updatedLines.join('\n') +
            (remainder && !updatedLines[updatedLines.length - 1]?.endsWith('\n') ? '\n' : '');

          const finalConf =
            existingConf.slice(0, sectionStart) + newSectionBody + remainder;
          atomicWriteFileSync(cxbottleConfPath, finalConf);
        } else {
          const envLines = ['[EnvironmentVariables]'];
          for (const [k, v] of updates.entries()) {
            envLines.push(`"${k}" = "${v}"`);
          }
          const prefix =
            existingConf.length > 0 && !existingConf.endsWith('\n')
              ? `${existingConf}\n\n`
              : existingConf.length > 0
                ? `${existingConf}\n`
                : '';
          atomicWriteFileSync(cxbottleConfPath, `${prefix}${envLines.join('\n')}\n`);
        }
      } catch {}
    }
  }

  // 6. High Resolution Mode (launchConfig.crossoverHighResolutionMode)
  if (typeof cfg.crossoverHighResolutionMode === 'boolean' && isBottleDir) {
    const retinaVal = cfg.crossoverHighResolutionMode ? 'y' : 'n';
    const logPixelsDword = cfg.crossoverHighResolutionMode ? 'dword:000000c0' : 'dword:00000060';
    const logPixelsDec = cfg.crossoverHighResolutionMode ? '192' : '96';
    const userRegPath = path.join(resolvedBottlePath, 'user.reg');
    try {
      let regContent = fs.existsSync(userRegPath)
        ? fs.readFileSync(userRegPath, 'utf8')
        : '';

      // 6a. [Software\\Wine\\Mac Driver] "RetinaMode"="y" | "n"
      const macDriverRe = /^\[Software\\\\Wine\\\\Mac Driver\][^\r\n]*$/m;
      const macDriverMatch = macDriverRe.exec(regContent);
      if (macDriverMatch) {
        const secStart = macDriverMatch.index + macDriverMatch[0].length;
        const afterSec = regContent.slice(secStart);
        const nextSecMatch = /^\[[^\]]+\]/m.exec(afterSec);
        const secBody = nextSecMatch ? afterSec.slice(0, nextSecMatch.index) : afterSec;
        const secRest = nextSecMatch ? afterSec.slice(nextSecMatch.index) : '';

        let newSecBody;
        if (/^"RetinaMode"\s*=\s*"[^"]*"/m.test(secBody)) {
          newSecBody = secBody.replace(
            /^"RetinaMode"\s*=\s*"[^"]*"/m,
            `"RetinaMode"="${retinaVal}"`
          );
        } else {
          newSecBody = `\n"RetinaMode"="${retinaVal}"${secBody.startsWith('\n') ? '' : '\n'}${secBody}`;
        }

        regContent = regContent.slice(0, secStart) + newSecBody + secRest;
      } else {
        const prefix =
          regContent.length > 0 && !regContent.endsWith('\n')
            ? `${regContent}\n`
            : regContent;
        regContent = `${prefix}\n[Software\\\\Wine\\\\Mac Driver]\n"RetinaMode"="${retinaVal}"\n`;
      }

      // 6b. [Control Panel\\Desktop] "LogPixels"=dword:000000c0 | dword:00000060
      const desktopRe = /^\[Control Panel\\\\Desktop\][^\r\n]*$/m;
      const desktopMatch = desktopRe.exec(regContent);
      if (desktopMatch) {
        const secStart = desktopMatch.index + desktopMatch[0].length;
        const afterSec = regContent.slice(secStart);
        const nextSecMatch = /^\[[^\]]+\]/m.exec(afterSec);
        const secBody = nextSecMatch ? afterSec.slice(0, nextSecMatch.index) : afterSec;
        const secRest = nextSecMatch ? afterSec.slice(nextSecMatch.index) : '';

        let newSecBody;
        if (/^"LogPixels"\s*=\s*[^\r\n]*/m.test(secBody)) {
          newSecBody = secBody.replace(
            /^"LogPixels"\s*=\s*[^\r\n]*/m,
            `"LogPixels"=${logPixelsDword}`
          );
        } else {
          newSecBody = `\n"LogPixels"=${logPixelsDword}${secBody.startsWith('\n') ? '' : '\n'}${secBody}`;
        }

        regContent = regContent.slice(0, secStart) + newSecBody + secRest;
      } else {
        const prefix =
          regContent.length > 0 && !regContent.endsWith('\n')
            ? `${regContent}\n`
            : regContent;
        regContent = `${prefix}\n[Control Panel\\\\Desktop]\n"LogPixels"=${logPixelsDword}\n`;
      }

      atomicWriteFileSync(userRegPath, regContent);
    } catch {}

    if (
      effectiveOptions?.syncLiveWineReg === true &&
      !effectiveOptions.homedir &&
      !effectiveOptions.skipRegistrySpawn &&
      chosenLayer?.binaryPath &&
      fs.existsSync(chosenLayer.binaryPath)
    ) {
      const regEnv = { ...process.env, ...env };
      try {
        execFile(
          chosenLayer.binaryPath,
          [
            'reg',
            'add',
            'HKCU\\Software\\Wine\\Mac Driver',
            '/v',
            'RetinaMode',
            '/t',
            'REG_SZ',
            '/d',
            retinaVal,
            '/f',
          ],
          { timeout: 2500, env: regEnv },
          () => {}
        );
      } catch {}
      try {
        execFile(
          chosenLayer.binaryPath,
          [
            'reg',
            'add',
            'HKCU\\Control Panel\\Desktop',
            '/v',
            'LogPixels',
            '/t',
            'REG_DWORD',
            '/d',
            logPixelsDec,
            '/f',
          ],
          { timeout: 2500, env: regEnv },
          () => {}
        );
      } catch {}
    }
  }

  // 7. Clamp any oversized fullscreen resolutions in the Wine prefix's game configs
  // (e.g., 2x Retina-doubled resolutions saved by older Wine/GPTK layers that exceed
  // CrossOver 26's maximum display mode and cause SDL_GetClosestDisplayMode -> NULL crashes).
  if (
    isBottleDir &&
    (process.platform === 'darwin' ||
      effectiveOptions.platform === 'darwin' ||
      effectiveOptions.sanitizeDisplayConfigs)
  ) {
    try {
      sanitizeWinePrefixDisplayConfigs(resolvedBottlePath, {
        ...effectiveOptions,
        ...(typeof cfg.crossoverHighResolutionMode === 'boolean'
          ? { highResolutionMode: cfg.crossoverHighResolutionMode }
          : {}),
      });
    } catch {}
  }

  return env;
}

let cachedHostDisplayMetrics = null;

/**
 * Determine the host display's maximum supported resolution (physical Retina vs logical points).
 */
function getHostMaxDisplayResolution(highResolutionMode = true, options = {}) {
  if (Number(options?.maxWidth) > 0 && Number(options?.maxHeight) > 0) {
    const mw = Math.round(Number(options.maxWidth));
    const mh = Math.round(Number(options.maxHeight));
    const lw = Math.round(Number(options.logicalWidth || mw));
    const lh = Math.round(Number(options.logicalHeight || mh));
    return {
      width: highResolutionMode ? mw : lw,
      height: highResolutionMode ? mh : lh,
      nativeWidth: mw,
      nativeHeight: mh,
      logicalWidth: lw,
      logicalHeight: lh,
    };
  }

  if (electron.screen && typeof electron.screen.getAllDisplays === 'function') {
    try {
      const displays = electron.screen.getAllDisplays();
      if (Array.isArray(displays) && displays.length > 0) {
        let maxW = 0;
        let maxH = 0;
        let logW = 0;
        let logH = 0;
        for (const d of displays) {
          const w = Number(d?.size?.width || 0);
          const h = Number(d?.size?.height || 0);
          const scale = Number(d?.scaleFactor || 1);
          const physW = Math.round(w * scale);
          const physH = Math.round(h * scale);
          if (physW > maxW) {
            maxW = physW;
            maxH = physH;
          }
          if (w > logW) {
            logW = Math.round(w);
            logH = Math.round(h);
          }
        }
        if (maxW > 0 && maxH > 0) {
          return {
            width: highResolutionMode ? maxW : logW,
            height: highResolutionMode ? maxH : logH,
            nativeWidth: maxW,
            nativeHeight: maxH,
            logicalWidth: logW,
            logicalHeight: logH,
          };
        }
      }
    } catch {}
  }

  if (
    !cachedHostDisplayMetrics &&
    process.platform === 'darwin' &&
    !options?.skipDisplayProbe &&
    !options?.homedir
  ) {
    try {
      const out = execFileSync(
        '/usr/sbin/system_profiler',
        ['SPDisplaysDataType', '-json'],
        { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const parsed = JSON.parse(String(out || '').trim());
      const gpus = Array.isArray(parsed?.SPDisplaysDataType) ? parsed.SPDisplaysDataType : [];
      let maxW = 0;
      let maxH = 0;
      let logW = 0;
      let logH = 0;
      const parseResPair = (val) => {
        const m = String(val || '').match(/(\d{3,5})\s*[xX×]\s*(\d{3,5})/);
        return m ? [Number(m[1]), Number(m[2])] : [0, 0];
      };
      for (const gpu of gpus) {
        const displays = Array.isArray(gpu?.spdisplays_ndrvs) ? gpu.spdisplays_ndrvs : [];
        for (const d of displays) {
          const [pw, ph] = parseResPair(d?._spdisplays_pixels || d?.spdisplays_pixelresolution);
          const [rw, rh] = parseResPair(d?.spdisplays_resolution);
          const isRetina = /retina/i.test(
            String(d?.spdisplays_resolution || d?.spdisplays_retina || '')
          );
          const physW = pw || (isRetina && rw ? rw * 2 : rw);
          const physH = ph || (isRetina && rh ? rh * 2 : rh);
          const logicalW = rw || (physW ? Math.round(physW / (isRetina ? 2 : 1)) : 0);
          const logicalH = rh || (physH ? Math.round(physH / (isRetina ? 2 : 1)) : 0);
          if (physW > maxW) {
            maxW = physW;
            maxH = physH;
          }
          if (logicalW > logW) {
            logW = logicalW;
            logH = logicalH;
          }
        }
      }
      if (maxW > 0 && maxH > 0) {
        cachedHostDisplayMetrics = {
          maxW: Math.round(maxW),
          maxH: Math.round(maxH),
          logW: Math.round(logW || maxW),
          logH: Math.round(logH || maxH),
        };
      }
    } catch {}
  }

  const metrics = cachedHostDisplayMetrics || {
    maxW: 3840,
    maxH: 2160,
    logW: 1920,
    logH: 1080,
  };

  return {
    width: highResolutionMode ? metrics.maxW : metrics.logW,
    height: highResolutionMode ? metrics.maxH : metrics.logH,
    nativeWidth: metrics.maxW,
    nativeHeight: metrics.maxH,
    logicalWidth: metrics.logW,
    logicalHeight: metrics.logH,
  };
}


/**
 * Scan engine configuration files (.cfg, .ini) inside a Wine prefix's user profile directories
 * (`Saved Games`, `Documents/My Games`, `AppData/Local`) and clamp any saved display resolutions
 * that exceed the host display's maximum supported resolution.
 */
function sanitizeWinePrefixDisplayConfigs(winePrefix, options = {}) {
  if (!winePrefix || typeof winePrefix !== 'string' || !fs.existsSync(winePrefix)) {
    return { sanitizedFiles: [], maxWidth: 0, maxHeight: 0 };
  }

  try {
    sandboxWinePrefixUserFolders(winePrefix, options);
  } catch {}

  const resolvedPrefix = path.resolve(winePrefix);
  let highResolutionMode = true;
  if (typeof options.highResolutionMode === 'boolean') {
    highResolutionMode = options.highResolutionMode;
  } else {
    try {
      const userRegPath = path.join(winePrefix, 'user.reg');
      if (fs.existsSync(userRegPath)) {
        const regHead = fs.readFileSync(userRegPath, 'utf8');
        if (/^"RetinaMode"\s*=\s*"n"/im.test(regHead)) {
          highResolutionMode = false;
        }
      }
    } catch {}
  }

  const displayRes = getHostMaxDisplayResolution(highResolutionMode, options);
  const maxWidth = Number(options.maxWidth) > 0 ? Math.round(Number(options.maxWidth)) : displayRes.width;
  const maxHeight = Number(options.maxHeight) > 0 ? Math.round(Number(options.maxHeight)) : displayRes.height;

  const usersDir = path.join(winePrefix, 'drive_c', 'users');
  if (!fs.existsSync(usersDir)) {
    return { sanitizedFiles: [], maxWidth, maxHeight };
  }

  const sanitizedFiles = [];
  const skippedDirNames = new Set([
    'public',
    'steam',
    'microsoft',
    'temp',
    'packages',
    'cef',
    'cache',
    'shadercache',
    'd3dscache',
    'crashdumps',
    'logs',
  ]);

  const cfgPairs = [
    ['v_width', 'v_height'],
    ['r_customwidth', 'r_customheight'],
    ['r_width', 'r_height'],
  ];
  const iniPairs = [
    ['ResolutionSizeX', 'ResolutionSizeY'],
    ['LastUserConfirmedResolutionSizeX', 'LastUserConfirmedResolutionSizeY'],
    ['DesiredScreenWidth', 'DesiredScreenHeight'],
  ];

  const isPathInsidePrefix = (candidatePath) => {
    try {
      const lstat = fs.lstatSync(candidatePath);
      if (lstat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(candidatePath), fs.readlinkSync(candidatePath));
        return target === resolvedPrefix || target.startsWith(resolvedPrefix + path.sep);
      }
      return true;
    } catch {
      return false;
    }
  };

  const sanitizeConfigFile = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.cfg' && ext !== '.ini') return;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size <= 0 || st.size > 262144) return;
      const original = fs.readFileSync(filePath, 'utf8');
      let updated = original;
      let prevW = 0;
      let prevH = 0;

      if (ext === '.cfg') {
        for (const [wKey, hKey] of cfgPairs) {
          const wRe = new RegExp(`^([ \\t]*(?:seta?\\s+)?${wKey}\\s+")(\\d+)(".*)$`, 'im');
          const hRe = new RegExp(`^([ \\t]*(?:seta?\\s+)?${hKey}\\s+")(\\d+)(".*)$`, 'im');
          const wMatch = wRe.exec(updated);
          const hMatch = hRe.exec(updated);
          if (wMatch && hMatch) {
            const w = Number(wMatch[2]);
            const h = Number(hMatch[2]);
            if (w > 0 && h > 0 && (w > maxWidth || h > maxHeight)) {
              prevW = w;
              prevH = h;
              updated = updated.replace(wRe, `$1${maxWidth}$3`).replace(hRe, `$1${maxHeight}$3`);
            }
          }
        }
      } else if (ext === '.ini') {
        for (const [wKey, hKey] of iniPairs) {
          const wRe = new RegExp(`^([ \\t]*${wKey}\\s*=\\s*)(\\d+)([ \\t]*)$`, 'im');
          const hRe = new RegExp(`^([ \\t]*${hKey}\\s*=\\s*)(\\d+)([ \\t]*)$`, 'im');
          const wMatch = wRe.exec(updated);
          const hMatch = hRe.exec(updated);
          if (wMatch && hMatch) {
            const w = Number(wMatch[2]);
            const h = Number(hMatch[2]);
            if (w > 0 && h > 0 && (w > maxWidth || h > maxHeight)) {
              prevW = w;
              prevH = h;
              updated = updated.replace(wRe, `$1${maxWidth}$3`).replace(hRe, `$1${maxHeight}$3`);
            }
          }
        }
      }

      if (updated !== original) {
        atomicWriteFileSync(filePath, updated);
        sanitizedFiles.push({
          filePath,
          previousWidth: prevW,
          previousHeight: prevH,
          clampedWidth: maxWidth,
          clampedHeight: maxHeight,
        });
      }
    } catch {}
  };

  const walkConfigDir = (dirPath, depth = 0) => {
    if (depth > 5 || !dirPath || !fs.existsSync(dirPath)) return;
    if (!isPathInsidePrefix(dirPath)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (!isPathInsidePrefix(fullPath)) continue;
      if (entry.isDirectory()) {
        if (skippedDirNames.has(entry.name.toLowerCase())) continue;
        walkConfigDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        sanitizeConfigFile(fullPath);
      }
    }
  };

  let userEntries = [];
  try {
    userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
  } catch {
    return { sanitizedFiles, maxWidth, maxHeight };
  }

  for (const userEntry of userEntries) {
    if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
    if (userEntry.name.toLowerCase() === 'public') continue;
    const userRoot = path.join(usersDir, userEntry.name);
    const configRoots = [
      path.join(userRoot, 'Saved Games'),
      path.join(userRoot, 'Documents', 'My Games'),
      path.join(userRoot, 'My Documents', 'My Games'),
      path.join(userRoot, 'AppData', 'Local'),
    ];
    for (const root of configRoots) {
      if (fs.existsSync(root) && isPathInsidePrefix(root)) {
        walkConfigDir(root, 0);
      }
    }
  }

  return { sanitizedFiles, maxWidth, maxHeight };
}

/**
 * Auto-provision bottle/prefix and configure Wine environment variables for a chosen compatibility layer
 */
async function ensureCompatibilityLayerReady(chosenLayer, launchConfig = {}, env = {}, options = {}) {
  if (!chosenLayer) return {};
  const homedir = options.homedir || os.homedir();
  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);

  if (chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview') {
    const sharedBottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
    const previewBottlesDir = path.join(
      homedir,
      'Library/Application Support/CrossOver Preview/Bottles'
    );
    const defaultBottlesDir =
      chosenLayer.type === 'crossover_preview'
        ? hasValidInitializedBottles(previewBottlesDir, isMockHomedir)
          ? previewBottlesDir
          : fs.existsSync(sharedBottlesDir)
            ? sharedBottlesDir
            : previewBottlesDir
        : sharedBottlesDir;

    const bottlesDir = chosenLayer.bottlesDir || defaultBottlesDir;
    const availableBottles = listBottleSubdirectories(bottlesDir, options);

    let targetBottle;
    if (launchConfig && launchConfig.wineBottleName) {
      targetBottle = launchConfig.wineBottleName;
    } else if (availableBottles.includes('OneLauncher')) {
      targetBottle = 'OneLauncher';
    } else if (availableBottles.includes('default')) {
      targetBottle = 'default';
    } else if (availableBottles.length > 0) {
      targetBottle = availableBottles[0];
    } else {
      targetBottle = 'OneLauncher';
    }

    const bottlePath = path.join(bottlesDir, targetBottle);
    const isBottleInitialized = isValidBottleDirectory(bottlePath, isMockHomedir);

    if (!isBottleInitialized && !options.skipBottleProvisioning) {
      if (!isMockHomedir && fs.existsSync(bottlePath)) {
        try {
          fs.rmSync(bottlePath, { recursive: true, force: true });
        } catch {}
      }
      if (!options.homedir) {
        const cxbottleCandidates = [
          chosenLayer.binaryPath ? path.join(path.dirname(chosenLayer.binaryPath), 'cxbottle') : null,
          '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
          '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
        ].filter(Boolean);
        const cxbottleBin = cxbottleCandidates.find((p) => fs.existsSync(p));
        if (cxbottleBin) {
          try {
            if (!fs.existsSync(bottlesDir)) {
              fs.mkdirSync(bottlesDir, { recursive: true });
            }
          } catch {}
          await new Promise((resolve) => {
            execFile(
              cxbottleBin,
              ['--bottle', targetBottle, '--create', '--template', 'win10_64', '--default'],
              { timeout: 60000, env: { ...process.env, ...env } },
              () => resolve()
            );
          });
        }
      }
      if (!fs.existsSync(bottlePath) && !options.skipBottleDirCreation) {
        try {
          fs.mkdirSync(bottlePath, { recursive: true });
        } catch {}
      }
    }

    env.CX_BOTTLE = targetBottle;
    if (launchConfig && launchConfig.winePrefixPath) {
      env.WINEPREFIX = launchConfig.winePrefixPath;
    } else if (fs.existsSync(bottlePath)) {
      env.WINEPREFIX = bottlePath;
    }
    if (env.WINEMSYNC === '1') {
      env.WINEESYNC = '0';
    } else if (env.WINEESYNC === '1') {
      env.WINEMSYNC = '0';
    } else {
      env.WINEMSYNC = env.WINEMSYNC ?? '1';
      env.WINEESYNC = env.WINEESYNC ?? (env.WINEMSYNC === '1' ? '0' : '1');
    }

    try {
      await sandboxWinePrefixUserFoldersAsync(env.WINEPREFIX || bottlePath, options);
    } catch {}

    applyCrossOverPerGameSettings(
      chosenLayer,
      launchConfig,
      env,
      env.WINEPREFIX || bottlePath,
      options
    );

    return {
      targetBottle,
      winePrefix: env.WINEPREFIX,
      wineBinary: chosenLayer.binaryPath,
      wineserverBinary: resolveWineserverBinary(chosenLayer.binaryPath),
    };
  }

  let targetPrefix;
  if (launchConfig && launchConfig.winePrefixPath) {
    targetPrefix = launchConfig.winePrefixPath;
  } else {
    const heroicPfx1 = path.join(homedir, 'Games/Heroic/Prefixes/default/SteamHeroic/pfx');
    const heroicPfx2 = path.join(homedir, 'Games/Heroic/Prefixes/default/SteamHeroic');
    const heroicPfx3 = path.join(homedir, 'Games/Heroic/Prefixes/default');

    if (fs.existsSync(heroicPfx1)) {
      targetPrefix = heroicPfx1;
    } else if (fs.existsSync(path.join(heroicPfx2, 'drive_c'))) {
      targetPrefix = heroicPfx2;
    } else if (fs.existsSync(path.join(heroicPfx3, 'drive_c'))) {
      targetPrefix = heroicPfx3;
    } else {
      targetPrefix = path.join(homedir, 'Games/OneLauncher/Prefixes/default');
    }
  }

  try {
    if (targetPrefix && !fs.existsSync(targetPrefix)) {
      fs.mkdirSync(targetPrefix, { recursive: true });
    }
  } catch {}

  env.WINEPREFIX = targetPrefix;
  if (env.WINEMSYNC === '1') {
    env.WINEESYNC = '0';
  } else if (env.WINEESYNC === '1') {
    env.WINEMSYNC = '0';
  } else {
    env.WINEMSYNC = env.WINEMSYNC ?? '1';
    env.WINEESYNC = env.WINEESYNC ?? (env.WINEMSYNC === '1' ? '0' : '1');
  }
  if (!String(env.WINEDLLOVERRIDES || '').includes('winemenubuilder.exe=d')) {
    env.WINEDLLOVERRIDES = env.WINEDLLOVERRIDES
      ? `${env.WINEDLLOVERRIDES};winemenubuilder.exe=d`
      : 'winemenubuilder.exe=d';
  }

  try {
    await sandboxWinePrefixUserFoldersAsync(env.WINEPREFIX || targetPrefix, options);
  } catch {}

  applyCrossOverPerGameSettings(
    chosenLayer,
    launchConfig,
    env,
    env.WINEPREFIX || targetPrefix,
    options
  );

  return {
    winePrefix: targetPrefix,
    wineBinary: chosenLayer.binaryPath,
    wineserverBinary: resolveWineserverBinary(chosenLayer.binaryPath),
  };
}

/**
 * Parse command-line launch argument string into array
 */
function parseLaunchArguments(argString) {
  if (!argString || typeof argString !== 'string') return [];
  const args = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = regex.exec(argString)) !== null) {
    if (match[1] !== undefined) args.push(match[1]);
    else if (match[2] !== undefined) args.push(match[2]);
    else args.push(match[0]);
  }
  return args;
}

/**
 * Build Storefront URI for protocol-based launching
 */
function buildStorefrontLaunchUri(payload = {}) {
  const platformId = payload.platformId || 'steam';
  const gameId = payload.platformGameId || payload.steamAppId || payload.gameId;
  if (platformId === 'steam') {
    const appId = payload.steamAppId || payload.platformGameId;
    return appId ? `steam://rungameid/${appId}` : null;
  }
  if (platformId === 'gog') {
    const cleanGogId = String(gameId || '')
      .trim()
      .replace(/^gog[-_]/i, '');
    return cleanGogId ? `goggalaxy://launchGame/gog_${cleanGogId}` : null;
  }
  if (platformId === 'epic') {
    return gameId
      ? `com.epicgames.launcher://apps/${encodeURIComponent(String(gameId))}?action=launch&silent=true`
      : null;
  }
  return null;
}

const pausedByInGameTaskIds = new Set();
const inFlightPostSessionPromises = new Set();

function trackPostSessionPromise(promise) {
  if (!promise || typeof promise.finally !== 'function') {
    return Promise.resolve(promise);
  }
  inFlightPostSessionPromises.add(promise);
  promise.finally(() => {
    inFlightPostSessionPromises.delete(promise);
  });
  return promise;
}

function hasActivePostSessionWork() {
  return inFlightPostSessionPromises.size > 0;
}

function getPausedByInGameTaskIds() {
  return Array.from(pausedByInGameTaskIds);
}

function pauseActiveDownloadsForInGame(options = {}) {
  const pausedTaskIds = [];
  for (const [taskId, task] of downloadQueueMap.entries()) {
    if (!task) continue;
    if (task.status === 'downloading' || task.status === 'queued') {
      const res = pauseDownload(taskId, options);
      if (res && res.success) {
        pausedByInGameTaskIds.add(taskId);
        pausedTaskIds.push(taskId);
        try {
          updateDownloadTask(
            taskId,
            { statusMessage: 'Paused while in-game' },
            options
          );
        } catch {}
      }
    }
  }
  return { pausedTaskIds };
}

function resumeDownloadsPausedByInGame(options = {}) {
  const resumedTaskIds = [];
  for (const taskId of Array.from(pausedByInGameTaskIds)) {
    pausedByInGameTaskIds.delete(taskId);
    const task = downloadQueueMap.get(taskId);
    if (task && task.status === 'paused') {
      const res = resumeDownload(taskId, options);
      if (res && res.success) {
        resumedTaskIds.push(taskId);
      }
    }
  }
  return { resumedTaskIds };
}

const {
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
} = createCloudSaveRunner({
  resolveIsolatedHomedirAndUserData: (...args) => resolveIsolatedHomedirAndUserData(...args),
  isTestEnvironment: (...args) => isTestEnvironment(...args),
  fetchGogV1Json: (...args) => fetchGogV1Json(...args),
  findGogdlBinary: (...args) => findGogdlBinary(...args),
  ensureGogdlAuthConfig: (...args) => ensureGogdlAuthConfig(...args),
  resolveEpicAppAndPlatforms: (...args) => resolveEpicAppAndPlatforms(...args),
  ensureLegendaryConfigAndAuth: (...args) => ensureLegendaryConfigAndAuth(...args),
  getLegendaryConfigDir: (...args) => getLegendaryConfigDir(...args),
  collectLocalEpicMetadataAndSupport: (...args) => collectLocalEpicMetadataAndSupport(...args),
  findLegendaryBinary: (...args) => findLegendaryBinary(...args),
});


/**
 * Finalize an active game session, compute playtime, run ordered post-exit cloud sync + prefix shutdown, and emit stop event
 */
function finalizeGameSession(gameId, options = {}) {
  const entry = activeSessions.get(gameId);
  if (!entry || entry.finalized) return null;
  entry.finalized = true;

  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }

  const normalizedGameId = String(gameId || entry.session?.gameId || '');
  const resolvedPrefix = entry.winePrefix ? path.resolve(entry.winePrefix) : '';

  let resolveGameBarrier = () => {};
  const postSessionBarrierPromise = new Promise((resolve) => {
    resolveGameBarrier = resolve;
  });
  let resolveBottleBarrier = () => {};
  const bottleBarrierPromise = new Promise((resolve) => {
    resolveBottleBarrier = resolve;
  });

  if (normalizedGameId) {
    inFlightPostSessionByGame.set(normalizedGameId, postSessionBarrierPromise);
  }
  if (resolvedPrefix) {
    inFlightPostSessionByBottle.set(resolvedPrefix, bottleBarrierPromise);
  }

  activeSessions.delete(gameId);

  const elapsedMs = Math.max(0, Date.now() - (entry.startedMs || Date.now()));
  const durationSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const crashedEarly =
    !entry.stoppedByUser &&
    entry.exitCode !== null &&
    entry.exitCode !== undefined &&
    entry.exitCode !== 0 &&
    elapsedMs < 30000;

  let sessionMinutesPlayed;
  let crashError;
  if (crashedEarly) {
    sessionMinutesPlayed = 0;
    crashError =
      (entry.stderrBuffer || '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(' | ')
        .slice(0, 300) || `Process exited with code ${entry.exitCode}`;
  } else {
    sessionMinutesPlayed = Math.max(1, Math.round(elapsedMs / 60000));
  }

  const lastPlayed = new Date().toISOString();

  if (entry.postExitCommand) {
    try {
      exec(entry.postExitCommand, { windowsHide: true }, () => {});
    } catch {}
  }

  const mergedOptions = {
    ...(entry.launchOptions || {}),
    ...(options || {}),
  };
  const effectivePerfPolicy = resolveEffectivePerformancePolicy(
    entry.launchConfig || {},
    mergedOptions
  );

  const stoppedSession = {
    ...entry.session,
    status: 'stopping',
  };

  const willRunPostExitCloudSync = Boolean(
    !crashedEarly &&
      ((stoppedSession.platformId === 'epic' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'gog' && entry.session?.launchMethod !== 'storefront_uri') ||
        (entry.bottleSteamRoot && (entry.steamAppId || entry.platformGameId)))
  );

  if (!willRunPostExitCloudSync && activeSessions.size === 0) {
    try {
      resumeDownloadsPausedByInGame(mergedOptions);
    } catch {}
  }

  emitSessionUpdated(
    {
      session: stoppedSession,
      event: 'stopped',
      sessionMinutesPlayed,
      durationSeconds,
      lastPlayed,
      ...(crashedEarly ? { error: crashError } : {}),
    },
    mergedOptions
  );

  const emitCloudSyncTelemetry = (direction, syncResult) => {
    try {
      const telemetry = buildCloudSyncTelemetryPayload({
        gameId: stoppedSession.gameId,
        platformId: stoppedSession.platformId,
        direction,
        syncResult,
        isSteam: stoppedSession.platformId === 'steam',
      });
      if (telemetry) {
        emitSessionUpdated({ ...telemetry, session: stoppedSession }, mergedOptions);
      }
    } catch {}
  };

  const hasActiveOrPausedBottleDownload = () => {
    if (!resolvedPrefix) return false;
    const prefixWithSep = resolvedPrefix.endsWith(path.sep)
      ? resolvedPrefix
      : resolvedPrefix + path.sep;
    const hasBottleSteam = Boolean(
      entry.bottleSteamRoot ||
        fs.existsSync(path.join(resolvedPrefix, 'drive_c', 'Program Files (x86)', 'Steam', 'steam.exe')) ||
        fs.existsSync(path.join(resolvedPrefix, 'drive_c', 'Program Files', 'Steam', 'steam.exe'))
    );
    return Array.from(downloadQueueMap.values()).some((t) => {
      if (!t) return false;
      const isActiveOrInGamePaused =
        ['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
        pausedByInGameTaskIds.has(t.taskId);
      if (!isActiveOrInGamePaused) return false;
      const rawDir = typeof t.installDir === 'string' && t.installDir.trim() ? path.resolve(t.installDir) : '';
      if (rawDir && (rawDir === resolvedPrefix || rawDir.startsWith(prefixWithSep))) {
        return true;
      }
      if (hasBottleSteam && String(t.platformId || '').toLowerCase() === 'steam') {
        return true;
      }
      return false;
    });
  };

  const isPrefixBusyWithOtherSession = () =>
    Boolean(resolvedPrefix) &&
    ((pendingBottleLaunches.get(resolvedPrefix) || 0) > 0 ||
      hasActiveOrPausedBottleDownload() ||
      Array.from(activeSessions.values()).some(
        (other) =>
          other !== entry &&
          !other.finalized &&
          other.winePrefix &&
          path.resolve(other.winePrefix) === resolvedPrefix
      ));

  // 1. Run post-exit Cloud Save uploads & Bottle Steam cloud_log barrier FIRST (before wineserver -k!)
  let epicCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'epic' &&
    entry.session?.launchMethod !== 'storefront_uri'
  ) {
    epicCloudSaveSyncPromise = trackPostSessionPromise(
      syncEpicCloudSaves(
        {
          platformId: 'epic',
          platformGameId: entry.platformGameId || stoppedSession.platformGameId,
          gameId: stoppedSession.gameId,
          title: stoppedSession.title,
          installPath: entry.installPath,
        },
        'post_exit',
        {
          ...mergedOptions,
          useCompatLayer: Boolean(entry.winePrefix),
          winePrefix: entry.winePrefix,
          installPath: entry.installPath,
        }
      )
        .then((res) => {
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch((err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
    );
  }

  let gogCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'gog' &&
    entry.session?.launchMethod !== 'storefront_uri'
  ) {
    gogCloudSaveSyncPromise = trackPostSessionPromise(
      syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: entry.platformGameId || stoppedSession.platformGameId,
          gameId: stoppedSession.gameId,
          title: stoppedSession.title,
          installPath: entry.installPath,
        },
        'post_exit',
        {
          ...mergedOptions,
          useCompatLayer: Boolean(entry.winePrefix),
          winePrefix: entry.winePrefix,
          installPath: entry.installPath,
        }
      )
        .then((res) => {
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch((err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
    );
  }

  const lifecyclePolicy =
    normalizeStorefrontClientLifecycle(entry.effectiveStorefrontLifecycle) ||
    effectivePerfPolicy.storefrontClientLifecycle;

  let bottleSteamPostExitPromise = Promise.resolve({ completed: false });
  if (entry.bottleSteamRoot && (entry.steamAppId || entry.platformGameId)) {
    const cleanBottleAppId = String(entry.steamAppId || entry.platformGameId || '')
      .replace(/^steam[-_]/i, '')
      .trim();
    bottleSteamPostExitPromise = trackPostSessionPromise(
      (async () => {
        const cloudRes = await waitForSteamCloudSyncCompletion(
          entry.bottleSteamRoot,
          cleanBottleAppId,
          {
            ...mergedOptions,
            mode: 'post_exit',
            ignoreStaleLogAge: true,
          }
        );
        emitCloudSyncTelemetry('post_exit', cloudRes);
        let closedBottleSteam = false;
        if (
          entry.wokeBottleSteamByLauncher &&
          lifecyclePolicy === 'minimal_and_close_if_started' &&
          entry.wineBinary &&
          entry.bottleSteamExe &&
          !isPrefixBusyWithOtherSession()
        ) {
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          await new Promise((resolve) => {
            try {
              execFileImpl(
                entry.wineBinary,
                [entry.bottleSteamExe, '-shutdown'],
                {
                  env: {
                    ...(entry.launchEnv || process.env),
                    ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                  },
                  timeout: 5000,
                },
                () => resolve()
              );
              closedBottleSteam = true;
            } catch {
              resolve();
            }
          });
        }
        return { completed: true, cloudRes, closedBottleSteam };
      })().catch(() => ({ completed: false }))
    );
  }

  let bottleGogPostExitPromise = Promise.resolve({ completed: false, closedBottleGog: false });
  if (
    entry.wokeBottleGogByLauncher &&
    lifecyclePolicy === 'minimal_and_close_if_started' &&
    entry.wineBinary &&
    entry.bottleGogExe
  ) {
    bottleGogPostExitPromise = trackPostSessionPromise(
      Promise.allSettled([gogCloudSaveSyncPromise])
        .then(async () => {
          if (isPrefixBusyWithOtherSession()) {
            return { completed: false, closedBottleGog: false };
          }
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          await new Promise((resolve) => {
            try {
              execFileImpl(
                entry.wineBinary,
                [entry.bottleGogExe, '/command=shutdown'],
                {
                  env: {
                    ...(entry.launchEnv || process.env),
                    ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                  },
                  timeout: 5000,
                },
                () => resolve()
              );
            } catch {
              resolve();
            }
          });
          return { completed: true, closedBottleGog: true };
        })
        .catch(() => ({ completed: false, closedBottleGog: false }))
    );
  }

  let bottleEpicPostExitPromise = Promise.resolve({ completed: false, closedBottleEpic: false });
  if (
    entry.wokeBottleEpicByLauncher &&
    lifecyclePolicy === 'minimal_and_close_if_started' &&
    entry.wineBinary &&
    entry.bottleEpicExe
  ) {
    bottleEpicPostExitPromise = trackPostSessionPromise(
      Promise.allSettled([epicCloudSaveSyncPromise])
        .then(async () => {
          if (isPrefixBusyWithOtherSession()) {
            return { completed: false, closedBottleEpic: false };
          }
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          await new Promise((resolve) => {
            try {
              execFileImpl(
                entry.wineBinary,
                ['taskkill', '/F', '/IM', 'EpicGamesLauncher.exe'],
                {
                  env: {
                    ...(entry.launchEnv || process.env),
                    ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                  },
                  timeout: 4000,
                },
                () => resolve()
              );
            } catch {
              resolve();
            }
          });
          return { completed: true, closedBottleEpic: true };
        })
        .catch(() => ({ completed: false, closedBottleEpic: false }))
    );
  }

  let hostSteamCloudSyncPromise = Promise.resolve({ completed: true, reason: 'no_active_cloud_job' });
  if (
    !crashedEarly &&
    stoppedSession.platformId === 'steam' &&
    !entry.bottleSteamRoot &&
    !entry.wokeSteamByLauncher &&
    (entry.steamAppId || entry.platformGameId)
  ) {
    const cleanHostAppId = String(entry.steamAppId || entry.platformGameId || '')
      .replace(/^steam[-_]/i, '')
      .trim();
    const targetPlatform = mergedOptions.platform || process.platform;
    const candidateHostSteamRoot =
      mergedOptions.steamRoot ||
      entry.steamRoot ||
      (entry.steamClientBinaryPath && targetPlatform === 'win32'
        ? path.dirname(entry.steamClientBinaryPath)
        : targetPlatform === 'darwin' && (mergedOptions.homedir || !isTestEnvironment(mergedOptions))
          ? path.join(mergedOptions.homedir || os.homedir(), 'Library', 'Application Support', 'Steam')
          : '');
    if (cleanHostAppId && (candidateHostSteamRoot || targetPlatform === 'darwin')) {
      hostSteamCloudSyncPromise = trackPostSessionPromise(
        waitForSteamCloudSyncCompletion(candidateHostSteamRoot || '', cleanHostAppId, {
          ...mergedOptions,
          mode: 'post_exit',
          ignoreStaleLogAge: true,
        })
          .then((res) => {
            emitCloudSyncTelemetry('post_exit', res);
            return res;
          })
          .catch(() => ({ completed: false }))
      );
    }
  }

  // 2. Chain Wine prefix shutdown strictly AFTER post-exit cloud sync & bottle storefront shutdown finish
  // (Skip wineserver -k when keeping a warm bottle storefront client running per lifecyclePolicy!)
  const hasActiveBottleStorefrontClient = Boolean(
    entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wasBottleGogRunning ||
      entry.wokeBottleEpicByLauncher ||
      entry.wasBottleEpicRunning
  );
  const shouldPreserveBottleStorefrontClient =
    hasActiveBottleStorefrontClient &&
    (lifecyclePolicy === 'minimal_keep_running' ||
      lifecyclePolicy === 'default_client' ||
      (lifecyclePolicy === 'minimal_and_close_if_started' &&
        ((entry.launchedViaBottleSteam && !entry.wokeBottleSteamByLauncher) ||
          (entry.wasBottleGogRunning && !entry.wokeBottleGogByLauncher) ||
          (entry.wasBottleEpicRunning && !entry.wokeBottleEpicByLauncher))));

  let winePrefixShutdownPromise = Promise.resolve(false);
  if (
    (!entry.stopping ||
      entry.deferredPrefixShutdownToFinalize ||
      entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wokeBottleEpicByLauncher) &&
    !entry.wineShutdownHandledByStopGame &&
    !shouldPreserveBottleStorefrontClient &&
    entry.winePrefix &&
    (entry.wineserverBinary || entry.wineBinary) &&
    effectivePerfPolicy.autoShutdownWinePrefixOnExit !== false
  ) {
    winePrefixShutdownPromise = trackPostSessionPromise(
      Promise.allSettled([
        epicCloudSaveSyncPromise,
        gogCloudSaveSyncPromise,
        bottleSteamPostExitPromise,
        bottleGogPostExitPromise,
        bottleEpicPostExitPromise,
      ])
        .then(() => {
          if (isPrefixBusyWithOtherSession()) return false;
          return shutdownWinePrefix(
            entry.wineserverBinary || entry.wineBinary,
            entry.winePrefix,
            3000
          ).then((res) => {
            if (typeof mergedOptions.onWinePrefixShutdown === 'function') {
              try {
                mergedOptions.onWinePrefixShutdown(entry.winePrefix, res);
              } catch {}
            }
            return res;
          });
        })
        .catch(() => false)
    );
  }

  Promise.allSettled([
    epicCloudSaveSyncPromise,
    gogCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    winePrefixShutdownPromise,
  ]).finally(() => {
    if (resolvedPrefix && inFlightPostSessionByBottle.get(resolvedPrefix) === bottleBarrierPromise) {
      inFlightPostSessionByBottle.delete(resolvedPrefix);
    }
    resolveBottleBarrier();
  });

  // 3. Sync playtime to storefront (skip GOG when launched via storefront_uri to avoid Galaxy double-count)
  let storefrontSyncPromise = Promise.resolve(null);
  const skipGogStorefrontPlaytimeSync =
    stoppedSession.platformId === 'gog' && entry.session?.launchMethod === 'storefront_uri';
  if (
    !crashedEarly &&
    !skipGogStorefrontPlaytimeSync &&
    sessionMinutesPlayed > 0 &&
    stoppedSession.platformId &&
    ['epic', 'gog', 'steam'].includes(stoppedSession.platformId)
  ) {
    storefrontSyncPromise = trackPostSessionPromise(
      syncSessionPlaytimeToStorefront(
        {
          platformId: stoppedSession.platformId,
          platformGameId: entry.platformGameId || stoppedSession.platformGameId,
          gameId: stoppedSession.gameId,
          title: stoppedSession.title,
          installPath: entry.installPath,
          executablePath: stoppedSession.executablePath,
          startedAt:
            stoppedSession.startedAt || new Date(entry.startedMs || Date.now()).toISOString(),
          endedAt: lastPlayed,
          durationSeconds,
          sessionMinutesPlayed,
        },
        mergedOptions
      )
        .then((syncRes) => {
          if (
            syncRes &&
            typeof syncRes.storefrontTotalPlaytimeMinutes === 'number' &&
            syncRes.storefrontTotalPlaytimeMinutes > 0
          ) {
            emitSessionUpdated(
              {
                session: stoppedSession,
                event: 'playtime_synced',
                sessionMinutesPlayed,
                durationSeconds,
                lastPlayed,
                storefrontTotalPlaytimeMinutes: syncRes.storefrontTotalPlaytimeMinutes,
              },
              mergedOptions
            );
          }
          return syncRes;
        })
        .catch(() => null)
    );
  }

  // 4. Trigger ephemeral storefront client shutdown after playtime & cloud sync finish
  let ephemeralClientShutdownPromise = Promise.resolve({ closed: false });
  if (entry.wokeGogGalaxyByLauncher || entry.wokeSteamByLauncher) {
    ephemeralClientShutdownPromise = trackPostSessionPromise(
      Promise.allSettled([
        storefrontSyncPromise,
        gogCloudSaveSyncPromise,
        epicCloudSaveSyncPromise,
      ]).then(() =>
        shutdownEphemeralStorefrontClient(entry, mergedOptions)
          .then((res) => {
            if (res && res.cloudSyncWait) {
              emitCloudSyncTelemetry('post_exit', res.cloudSyncWait);
            }
            return res;
          })
          .catch(() => ({ closed: false }))
      )
    );
    storefrontSyncPromise = trackPostSessionPromise(
      storefrontSyncPromise.finally(() => ephemeralClientShutdownPromise)
    );
  }

  Promise.allSettled([
    epicCloudSaveSyncPromise,
    gogCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    hostSteamCloudSyncPromise,
    winePrefixShutdownPromise,
  ]).finally(() => {
    if (
      normalizedGameId &&
      inFlightPostSessionByGame.get(normalizedGameId) === postSessionBarrierPromise
    ) {
      inFlightPostSessionByGame.delete(normalizedGameId);
    }
    resolveGameBarrier();
    if (activeSessions.size === 0) {
      try {
        resumeDownloadsPausedByInGame(mergedOptions);
      } catch {}
    }
  });

  return {
    session: stoppedSession,
    sessionMinutesPlayed,
    durationSeconds,
    lastPlayed,
    postSessionBarrierPromise,
    storefrontSyncPromise,
    winePrefixShutdownPromise,
    ephemeralClientShutdownPromise,
    epicCloudSaveSyncPromise,
    gogCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    ...(crashedEarly ? { error: crashError } : {}),
  };
}

/**
 * C) Direct Game Launcher, Process Monitor & Playtime Tracker
 */
async function launchGame(payload = {}, options = {}) {
  let lockedPlatformId = '';
  let lockedBottlePrefix = '';
  const releasePendingBottleLock = () => {
    if (!lockedBottlePrefix) return;
    const prev = pendingBottleLaunches.get(lockedBottlePrefix) || 0;
    if (prev <= 1) {
      pendingBottleLaunches.delete(lockedBottlePrefix);
    } else {
      pendingBottleLaunches.set(lockedBottlePrefix, prev - 1);
    }
    lockedBottlePrefix = '';
  };
  const releasePendingPlatformLock = () => {
    if (!lockedPlatformId) return;
    const prev = pendingStorefrontLaunches.get(lockedPlatformId) || 0;
    if (prev <= 1) {
      pendingStorefrontLaunches.delete(lockedPlatformId);
    } else {
      pendingStorefrontLaunches.set(lockedPlatformId, prev - 1);
    }
    lockedPlatformId = '';
  };

  try {
    const gameId = String(payload.gameId || `${payload.platformId || 'custom'}-${payload.platformGameId || 'game'}`);
    if (activeSessions.has(gameId)) {
      const existing = activeSessions.get(gameId);
      return {
        success: true,
        message: 'Game is already running',
        session: { ...existing.session },
      };
    }

    const normPlatformId = String(payload.platformId || '').trim().toLowerCase();
    if (normPlatformId) {
      lockedPlatformId = normPlatformId;
      pendingStorefrontLaunches.set(
        normPlatformId,
        (pendingStorefrontLaunches.get(normPlatformId) || 0) + 1
      );
      if (pendingEphemeralShutdowns.has(normPlatformId)) {
        const pendingCtrl = pendingEphemeralShutdowns.get(normPlatformId);
        pendingEphemeralShutdowns.delete(normPlatformId);
        if (pendingCtrl && typeof pendingCtrl.abort === 'function') {
          try {
            pendingCtrl.abort();
          } catch {}
        }
      }
    }

    if (inFlightPostSessionByGame.has(gameId)) {
      const inFlightGamePromise = inFlightPostSessionByGame.get(gameId);
      emitSessionUpdated(
        {
          gameId,
          platformId: payload.platformId || 'custom',
          status: 'starting',
          event: 'starting',
          statusMessage: 'Finishing previous cloud save upload...',
        },
        options
      );
      const barrierTimeoutMs = Math.max(
        0,
        Number(options.postSessionBarrierTimeoutMs ?? 20000)
      );
      await Promise.race([
        inFlightGamePromise,
        new Promise((resolve) => {
          const t = setTimeout(resolve, barrierTimeoutMs);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      if (activeSessions.has(gameId)) {
        const existing = activeSessions.get(gameId);
        return {
          success: true,
          message: 'Game is already running',
          session: { ...existing.session },
        };
      }
    }

    const emitPreLaunchCloudTelemetry = (syncResult) => {
      try {
        const effectivePlatformId = payload.platformId || 'custom';
        const telemetry = buildCloudSyncTelemetryPayload({
          gameId,
          platformId: effectivePlatformId,
          direction: 'pre_launch',
          syncResult,
          isSteam: effectivePlatformId === 'steam',
        });
        if (telemetry) {
          emitSessionUpdated(telemetry, options);
        }
      } catch {}
    };

    const platform = options.platform || process.platform;
    const savedConfigs = getGameLaunchConfigs(options);
    const rawSavedConfig =
      savedConfigs[gameId] || (payload.gameId && savedConfigs[payload.gameId]) || {};
    const platformSavedConfig = resolvePlatformLaunchConfig(rawSavedConfig, payload.platformId);
    const platformPayloadConfig = resolvePlatformLaunchConfig(
      payload.launchConfig,
      payload.platformId
    );
    const launchConfig = {
      ...platformSavedConfig,
      ...(payload.storefrontClientLifecycle
        ? { storefrontClientLifecycle: payload.storefrontClientLifecycle }
        : {}),
      ...platformPayloadConfig,
    };
    const effectivePerfPolicy = resolveEffectivePerformancePolicy(launchConfig, options);
    let gogWakeResult = null;
    let steamMinimalSpawnedResult = null;

    const rawLaunchMethod = launchConfig.launchMethod || payload.launchMethod || 'auto';
    const launchMethod = rawLaunchMethod === 'custom' ? 'auto' : rawLaunchMethod;
    const preferWindowsExe =
      platform === 'darwin' &&
      launchMethod === 'compatibility_layer' &&
      !launchConfig.customExecutablePath;

    // Resolve executable path
    let resolvedExePath = undefined;
    let isWindowsBinaryOnMac = Boolean(payload.isWindowsBinaryOnMac);

    const localInstallDir = payload.installPath ? toLocalFsPath(payload.installPath) : '';
    const isInstallInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(localInstallDir);
    if (
      platform === 'darwin' &&
      localInstallDir &&
      !isInstallInsideBottle &&
      fs.existsSync(localInstallDir)
    ) {
      try {
        flattenGogNestedInstallDir(localInstallDir);
        ensureMacExecutablePermissions(localInstallDir);
      } catch {}
    }

    if (launchConfig.customExecutablePath) {
      const customCandidate = toLocalFsPath(launchConfig.customExecutablePath);
      if (fs.existsSync(customCandidate)) {
        resolvedExePath = customCandidate;
      }
    }

    if (preferWindowsExe && localInstallDir && fs.existsSync(localInstallDir)) {
      const winDiscovered = findPrimaryExecutable(localInstallDir, {
        platform,
        hintName: payload.title,
        preferWindowsExecutable: true,
      });
      if (winDiscovered.executablePath && fs.existsSync(winDiscovered.executablePath)) {
        resolvedExePath = winDiscovered.executablePath;
        isWindowsBinaryOnMac = Boolean(winDiscovered.isWindowsBinaryOnMac);
      }
    }

    let appInfoSpec = null;
    if (!launchConfig.customExecutablePath && payload.platformId === 'steam') {
      const steamAppIdVal = String(payload.steamAppId || payload.platformGameId || '')
        .replace(/^steam[-_]/i, '')
        .trim();
      const searchInstallDir =
        localInstallDir ||
        (payload.executablePath ? path.dirname(toLocalFsPath(payload.executablePath)) : '');
      if (steamAppIdVal && searchInstallDir) {
        appInfoSpec = resolveSteamAppInfoLaunchSpec(
          searchInstallDir,
          steamAppIdVal,
          searchInstallDir,
          { platform }
        );
        if (
          !resolvedExePath &&
          appInfoSpec &&
          appInfoSpec.executablePath &&
          fs.existsSync(appInfoSpec.executablePath)
        ) {
          resolvedExePath = appInfoSpec.executablePath;
          if (appInfoSpec.isWindowsBinaryOnMac) {
            isWindowsBinaryOnMac = true;
          }
        }
      }
    }

    if (
      platform === 'darwin' &&
      !preferWindowsExe &&
      !launchConfig.customExecutablePath &&
      !isInstallInsideBottle &&
      localInstallDir &&
      fs.existsSync(localInstallDir) &&
      !resolvedExePath &&
      payload.executablePath &&
      /\.exe$/i.test(payload.executablePath)
    ) {
      const discoveredNative = findPrimaryExecutable(localInstallDir, {
        platform,
        hintName: payload.title,
        preferWindowsExecutable: false,
      });
      if (
        discoveredNative?.executablePath &&
        !discoveredNative.isWindowsBinaryOnMac &&
        !/\.exe$/i.test(discoveredNative.executablePath) &&
        fs.existsSync(discoveredNative.executablePath)
      ) {
        resolvedExePath = discoveredNative.executablePath;
        isWindowsBinaryOnMac = false;
      }
    }

    if (!resolvedExePath && payload.executablePath) {
      const payloadCandidate = toLocalFsPath(payload.executablePath);
      if (fs.existsSync(payloadCandidate)) {
        resolvedExePath = payloadCandidate;
      }
    }
    if (
      platform === 'darwin' &&
      !launchConfig.customExecutablePath &&
      localInstallDir &&
      (!resolvedExePath ||
        !fs.existsSync(resolvedExePath) ||
        /[\\/]GOGLauncher$/i.test(resolvedExePath) ||
        /\.com$/i.test(resolvedExePath) ||
        isExcludedExecutable(path.basename(resolvedExePath)))
    ) {
      evictExecutableDiscoveryCacheForPath(localInstallDir);
      const discovered =
        !preferWindowsExe &&
        appInfoSpec &&
        appInfoSpec.executablePath &&
        fs.existsSync(appInfoSpec.executablePath)
          ? {
              executablePath: appInfoSpec.executablePath,
              isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
            }
          : findPrimaryExecutable(localInstallDir, {
              platform,
              hintName: payload.title,
              preferWindowsExecutable: preferWindowsExe,
            });
      if (discovered.executablePath) {
        resolvedExePath = discovered.executablePath;
        if (discovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        } else if (!/\.exe$/i.test(discovered.executablePath)) {
          isWindowsBinaryOnMac = false;
        }
        if (payload.executablePath && resolvedExePath !== toLocalFsPath(payload.executablePath)) {
          try {
            const managed = loadManagedInstalledGames(options.userDataDir);
            let updatedManaged = false;
            for (const rec of managed) {
              if (
                (rec.installPath && path.resolve(rec.installPath) === path.resolve(localInstallDir)) ||
                (payload.platformGameId &&
                  String(rec.platformGameId) === String(payload.platformGameId) &&
                  rec.platformId === payload.platformId)
              ) {
                rec.executablePath = resolvedExePath;
                updatedManaged = true;
              }
            }
            if (updatedManaged) {
              saveManagedInstalledGames(managed, options.userDataDir);
            }
          } catch {}
        }
      }
    }
    if (!resolvedExePath && payload.installPath) {
      const discovered = findPrimaryExecutable(payload.installPath, {
        platform,
        hintName: payload.title,
        preferWindowsExecutable: preferWindowsExe,
      });
      resolvedExePath = discovered.executablePath;
      if (discovered.isWindowsBinaryOnMac) {
        isWindowsBinaryOnMac = true;
      } else if (discovered.executablePath && !/\.exe$/i.test(discovered.executablePath)) {
        isWindowsBinaryOnMac = false;
      }
    }

    if (
      resolvedExePath &&
      !launchConfig.customExecutablePath &&
      (/\.com$/i.test(resolvedExePath) || isExcludedExecutable(path.basename(resolvedExePath))) &&
      fs.existsSync(resolvedExePath)
    ) {
      const rediscovered = findPrimaryExecutable(
        localInstallDir || path.dirname(resolvedExePath),
        {
          platform,
          hintName: payload.title,
          preferWindowsExecutable: preferWindowsExe,
        }
      );
      if (rediscovered.executablePath) {
        resolvedExePath = rediscovered.executablePath;
        if (rediscovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
      }
    }

    if (
      resolvedExePath &&
      resolvedExePath.toLowerCase().endsWith('.exe') &&
      fs.existsSync(resolvedExePath)
    ) {
      const peHeader = inspectWindowsExecutableHeader(resolvedExePath);
      if (peHeader.is16BitDos) {
        const rediscovered = findPrimaryExecutable(
          payload.installPath || path.dirname(resolvedExePath),
          {
            platform,
            hintName: payload.title,
            preferWindowsExecutable: preferWindowsExe,
          }
        );
        resolvedExePath = rediscovered.executablePath || undefined;
        if (rediscovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
      }
    }

    if (
      platform === 'darwin' &&
      ((resolvedExePath && resolvedExePath.toLowerCase().endsWith('.exe')) ||
        /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
          String(resolvedExePath || payload.installPath || '')
        ))
    ) {
      isWindowsBinaryOnMac = true;
    }

    const effectiveLaunchArgsStr =
      launchConfig.launchArguments ||
      payload.launchArguments ||
      (appInfoSpec && appInfoSpec.launchArguments) ||
      resolveDefaultEngineLaunchArguments(
        localInstallDir || (resolvedExePath ? path.dirname(resolvedExePath) : ''),
        resolvedExePath
      );
    const args = parseLaunchArguments(effectiveLaunchArgsStr);
    const env = {
      ...process.env,
      ...(launchConfig.environmentVariables || {}),
    };

    // Execute optional pre-launch command asynchronously (never block Electron main thread)
    if (launchConfig.preLaunchCommand) {
      await new Promise((resolve) => {
        try {
          exec(
            launchConfig.preLaunchCommand,
            { timeout: 5000, windowsHide: true },
            (cmdErr) => {
              if (cmdErr) {
                diagLog.warn('launchGame.preLaunchCommand', cmdErr, { gameId });
              }
              resolve();
            }
          );
        } catch (syncErr) {
          diagLog.warn('launchGame.preLaunchCommandSpawn', syncErr, { gameId });
          resolve();
        }
      });
    }

    const isMacNativeExecutable =
      Boolean(resolvedExePath) &&
      !/\.(exe|bat|msi)$/i.test(resolvedExePath) &&
      !isWindowsBinaryOnMac;
    const useCompatLayer =
      platform === 'darwin' &&
      (isWindowsBinaryOnMac ||
        Boolean(resolvedExePath && /\.(exe|bat|msi)$/i.test(resolvedExePath)) ||
        (launchMethod === 'compatibility_layer' && !isMacNativeExecutable) ||
        (!isMacNativeExecutable &&
          launchConfig.compatibilityLayer &&
          launchConfig.compatibilityLayer !== 'native'));

    const isFastMinimalBypass =
      effectivePerfPolicy.storefrontClientLifecycle === 'fast_direct_bypass' ||
      (payload.platformId === 'steam' && launchMethod === 'direct');

    const effectiveSteamAppId =
      payload.platformId === 'steam'
        ? String(payload.steamAppId || payload.platformGameId || '')
            .replace(/^steam[-_]/i, '')
            .trim()
        : '';

    const isAutoLikeMethod = launchMethod === 'auto' || launchMethod === 'custom';

    const isSteamAutoUriPreferred =
      payload.platformId === 'steam' &&
      isAutoLikeMethod &&
      !isFastMinimalBypass &&
      !useCompatLayer &&
      !payload.customExecutablePath &&
      !launchConfig?.customExecutablePath &&
      Boolean(buildStorefrontLaunchUri(payload)) &&
      (platform === 'win32' ||
        (platform === 'darwin' && Boolean(resolveSteamClientBinaryPath(options))));

    // 1. Direct or Compatibility Layer execution when executable is available
    if (
      resolvedExePath &&
      !isSteamAutoUriPreferred &&
      launchMethod !== 'storefront_uri' &&
      (launchMethod === 'direct' ||
        isAutoLikeMethod ||
        launchMethod === 'compatibility_layer' ||
        useCompatLayer)
    ) {
      let spawnCmd = resolvedExePath;
      let spawnArgs = [...args];
      let actualLaunchMethod = 'direct';
      let compatResult = null;
      let chosenCompatLayer = null;
      let targetWinePrefix = null;
      let bottleSteamExe = null;
      let shouldLaunchViaBottleSteam = false;
      let wasBottleSteamRunning = false;
      let bottleGogExe = null;
      let shouldWakeBottleGog = false;
      let wasBottleGogRunning = false;
      let wokeBottleGogByLauncher = false;
      let bottleEpicExe = null;
      let shouldWakeBottleEpic = false;
      let wasBottleEpicRunning = false;
      let wokeBottleEpicByLauncher = false;

      if (useCompatLayer) {
        const layers = detectCompatibilityLayers(options);
        const preferredType = launchConfig.compatibilityLayer;
        let chosenLayer =
          (preferredType && preferredType !== 'native'
            ? layers.find((l) => l.type === preferredType || l.id === preferredType)
            : layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview')) ||
          layers[0];

        if (!chosenLayer) {
          if (isAutoLikeMethod && options.allowStorefrontFallbackOnMissingCompat) {
            // Fall through to storefront URI below
            resolvedExePath = undefined;
          } else {
            return {
              success: false,
              error:
                'No Windows compatibility layer (CrossOver, Game Porting Toolkit, or Wine) detected on macOS to run this Windows executable.',
            };
          }
        } else {
          compatResult = await ensureCompatibilityLayerReady(
            chosenLayer,
            launchConfig,
            env,
            options
          );

          if (chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview') {
            const resolvedBottleDir =
              env.WINEPREFIX ||
              (chosenLayer.bottlesDir && env.CX_BOTTLE
                ? path.join(chosenLayer.bottlesDir, env.CX_BOTTLE)
                : '');
            if (!resolvedBottleDir || !fs.existsSync(resolvedBottleDir)) {
              const fallbackLayer = layers.find(
                (l) =>
                  l.id !== chosenLayer.id &&
                  l.type !== 'crossover' &&
                  l.type !== 'crossover_preview'
              );
              if (fallbackLayer) {
                chosenLayer = fallbackLayer;
                delete env.CX_BOTTLE;
                compatResult = await ensureCompatibilityLayerReady(
                  chosenLayer,
                  launchConfig,
                  env,
                  options
                );
              }
            }
          }

          chosenCompatLayer = chosenLayer;
          targetWinePrefix = compatResult?.winePrefix || env.WINEPREFIX || null;

          if (targetWinePrefix) {
            const resolvedTargetPrefix = path.resolve(targetWinePrefix);
            lockedBottlePrefix = resolvedTargetPrefix;
            pendingBottleLaunches.set(
              resolvedTargetPrefix,
              (pendingBottleLaunches.get(resolvedTargetPrefix) || 0) + 1
            );

            if (inFlightPostSessionByBottle.has(resolvedTargetPrefix)) {
              const bottleInFlightPromise = inFlightPostSessionByBottle.get(resolvedTargetPrefix);
              emitSessionUpdated(
                {
                  gameId,
                  platformId: payload.platformId || 'custom',
                  status: 'starting',
                  event: 'starting',
                  statusMessage: 'Waiting for Wine bottle post-exit cloud sync...',
                },
                options
              );
              const bottleBarrierTimeoutMs = Math.max(
                0,
                Number(options.postSessionBarrierTimeoutMs ?? 20000)
              );
              await Promise.race([
                bottleInFlightPromise,
                new Promise((resolve) => {
                  const t = setTimeout(resolve, bottleBarrierTimeoutMs);
                  if (typeof t.unref === 'function') t.unref();
                }),
              ]);
            }
          }

          // Guard against Apple libMTLHud.dylib + older libMoltenVK.dylib static initializer deadlock
          // by injecting libone_metal_preload.dylib (`CFRunLoopRun` interpose on Thread 0) so Metal HUD
          // remains enabled and functional without deadlocking.
          if (
            env.MTL_HUD_ENABLED === '1' &&
            chosenLayer.binaryPath &&
            doesWineLayerHaveMoltenVkHudDeadlock(chosenLayer.binaryPath)
          ) {
            const preloadDylib = ensureWineMetalPreloadDylib(options);
            const moltenVkPath = resolveWineLayerMoltenVkPath(chosenLayer.binaryPath);
            if (preloadDylib) {
              const existingInsert = String(env.DYLD_INSERT_LIBRARIES || '')
                .split(':')
                .map((s) => s.trim())
                .filter(Boolean);
              if (!existingInsert.includes(preloadDylib)) {
                existingInsert.unshift(preloadDylib);
              }
              env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
              if (moltenVkPath) {
                env.ONE_LAUNCHER_MOLTENVK_PATH = moltenVkPath;
              }
            } else {
              delete env.MTL_HUD_ENABLED;
            }
          }

          if (payload.platformId === 'steam' && targetWinePrefix) {
            bottleSteamExe = resolveBottleSteamExe(targetWinePrefix);
            shouldLaunchViaBottleSteam = Boolean(
              bottleSteamExe &&
                effectiveSteamAppId &&
                !isFastMinimalBypass &&
                !options.disableBottleSteamLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          } else if (payload.platformId === 'gog' && targetWinePrefix) {
            bottleGogExe = resolveBottleGogGalaxyExe(targetWinePrefix);
            shouldWakeBottleGog = Boolean(
              bottleGogExe &&
                !isFastMinimalBypass &&
                options.usesGalaxySdk !== false &&
                !options.disableBottleGogLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          } else if (payload.platformId === 'epic' && targetWinePrefix) {
            bottleEpicExe = resolveBottleEpicLauncherExe(targetWinePrefix);
            shouldWakeBottleEpic = Boolean(
              bottleEpicExe &&
                !isFastMinimalBypass &&
                !options.disableBottleEpicLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          }

          // Pre-launch Wine prefix hygiene: if no other active or pending game session is running in this prefix,
          // terminate any orphaned game executable or lingering wineserver/explorer.exe from a previous session.
          // NOTE: When launching with a Bottle storefront client (Steam, GOG Galaxy, or Epic Games Launcher),
          // do NOT kill wineserver so warm bottle storefront clients stay intact!
          const hasOtherActiveSessionInPrefix =
            Boolean(lockedBottlePrefix) &&
            ((pendingBottleLaunches.get(lockedBottlePrefix) || 0) > 1 ||
              Array.from(activeSessions.entries()).some(
                ([activeId, activeEntry]) =>
                  activeId !== gameId &&
                  !activeEntry.finalized &&
                  activeEntry.winePrefix &&
                  path.resolve(activeEntry.winePrefix) === lockedBottlePrefix
              ));

          if (!hasOtherActiveSessionInPrefix) {
            if (
              !options.homedir &&
              resolvedExePath &&
              resolvedExePath.toLowerCase().endsWith('.exe')
            ) {
              const exeBase = path.basename(resolvedExePath);
              if (
                exeBase &&
                exeBase.length > 3 &&
                !/^(?:steam|galaxyclient|epicgameslauncher)\.exe$/i.test(exeBase)
              ) {
                await new Promise((resolve) => {
                  try {
                    execFile('pkill', ['-KILL', '-f', exeBase], { timeout: 1000 }, () => resolve());
                  } catch {
                    resolve();
                  }
                });
              }
            }

            if (!shouldLaunchViaBottleSteam && !shouldWakeBottleGog && !shouldWakeBottleEpic) {
              const candidateWineserver = resolveWineserverBinary(chosenLayer.binaryPath);
              const canRunWineserver =
                Boolean(candidateWineserver && targetWinePrefix) &&
                (!options.homedir ||
                  candidateWineserver.startsWith(options.homedir) ||
                  candidateWineserver.startsWith(os.tmpdir()) ||
                  candidateWineserver.startsWith('/private/var/folders') ||
                  candidateWineserver.startsWith('/var/folders'));

              if (canRunWineserver) {
                await shutdownWinePrefix(chosenLayer.binaryPath, targetWinePrefix, 2000);
              }
            }
          }

          if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
            try {
              sanitizeWinePrefixDisplayConfigs(targetWinePrefix, {
                ...options,
                ...(typeof launchConfig.crossoverHighResolutionMode === 'boolean'
                  ? { highResolutionMode: launchConfig.crossoverHighResolutionMode }
                  : {}),
              });
            } catch {}
          }
        }
      }

      if (resolvedExePath) {
        // Universal Steam AppID environment + steam_appid.txt for all direct & compat Steam launches
        if (payload.platformId === 'steam' && effectiveSteamAppId) {
          env.SteamAppId = effectiveSteamAppId;
          env.SteamGameId = effectiveSteamAppId;
          const targetAppIdDir =
            launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
              ? launchConfig.workingDirectory
              : path.dirname(resolvedExePath);
          if (targetAppIdDir && fs.existsSync(targetAppIdDir)) {
            const steamAppIdTxt = path.join(targetAppIdDir, 'steam_appid.txt');
            try {
              if (!fs.existsSync(steamAppIdTxt)) {
                fs.writeFileSync(steamAppIdTxt, `${effectiveSteamAppId}\n`, 'utf8');
              }
            } catch {}
          }
        }

        // Storefront pre-launch cloud save sync & auth/runtime hooks (after Wine prefix is resolved)
        if (payload.platformId === 'epic') {
          try {
            const epicPreSyncRes = await syncEpicCloudSaves(payload, 'pre_launch', {
              ...options,
              useCompatLayer,
              winePrefix: targetWinePrefix,
              installPath: localInstallDir || payload.installPath,
            });
            emitPreLaunchCloudTelemetry(epicPreSyncRes);
          } catch (epicSyncErr) {
            emitPreLaunchCloudTelemetry({
              synced: false,
              reason: epicSyncErr && epicSyncErr.message ? epicSyncErr.message : 'sync_failed',
            });
          }
          try {
            const epicAuth = await resolveEpicLaunchAuthArguments(payload, options);
            if (epicAuth && Array.isArray(epicAuth.args)) {
              for (const flag of epicAuth.args) {
                const flagPrefix = String(flag).split('=')[0].toLowerCase();
                const alreadyPresent = args.some(
                  (existingArg) => String(existingArg).split('=')[0].toLowerCase() === flagPrefix
                );
                if (!alreadyPresent) {
                  args.push(flag);
                }
              }
            }
          } catch {}
        } else if (payload.platformId === 'gog') {
          try {
            const gogPreSyncRes = await syncGogCloudSaves(payload, 'pre_launch', {
              ...options,
              useCompatLayer,
              winePrefix: targetWinePrefix,
              installPath: localInstallDir || payload.installPath,
            });
            emitPreLaunchCloudTelemetry(gogPreSyncRes);
          } catch (gogSyncErr) {
            emitPreLaunchCloudTelemetry({
              synced: false,
              reason: gogSyncErr && gogSyncErr.message ? gogSyncErr.message : 'sync_failed',
            });
          }

          // Skip waking host macOS GOG Galaxy when running inside a Wine bottle on darwin
          // (host Galaxy cannot bridge IPC into Wine) OR when fast_direct_bypass is active.
          const skipHostGogWake =
            (useCompatLayer && platform === 'darwin') || isFastMinimalBypass;
          if (!skipHostGogWake) {
            const shouldWakeGog =
              options.gogGalaxyClientPath !== undefined ||
              options.allowGogWakeInTest === true ||
              typeof options.spawnFn === 'function' ||
              doesGogInstallUseGalaxySdk(localInstallDir, resolvedExePath);
            if (shouldWakeGog) {
              try {
                gogWakeResult = await ensureGogGalaxyBackgroundService(options);
              } catch {}
            }
          }
        }

        // Finalize spawn command & arguments (incorporating any Epic auth flags added to `args`)
        if (useCompatLayer && chosenCompatLayer) {
          if (shouldLaunchViaBottleSteam && bottleSteamExe) {
            const execFileImpl =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            const checkBottleSteamRunning = (outStr) =>
              /(?:^|[\\/\s"'])steam\.exe(?:\s|["']|$)/i.test(String(outStr || ''));

            if (typeof options.mockProcessListOutput === 'string') {
              wasBottleSteamRunning = checkBottleSteamRunning(options.mockProcessListOutput);
            } else if (typeof options.getProcessListOutput === 'function') {
              try {
                wasBottleSteamRunning = checkBottleSteamRunning(
                  await options.getProcessListOutput()
                );
              } catch {}
            } else if (
              !options.homedir ||
              typeof options.execFileImpl === 'function' ||
              typeof options.execFileFn === 'function'
            ) {
              try {
                wasBottleSteamRunning = await new Promise((resolve) => {
                  execFileImpl('ps', ['-ax', '-o', 'command='], { timeout: 1500 }, (err, stdout) => {
                    resolve(!err && checkBottleSteamRunning(stdout));
                  });
                });
              } catch {
                wasBottleSteamRunning = false;
              }
            }

            spawnCmd = chosenCompatLayer.binaryPath;
            spawnArgs = [
              bottleSteamExe,
              ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client' ? [] : ['-silent']),
              '-applaunch',
              String(effectiveSteamAppId),
              ...args,
            ];
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          } else {
            spawnCmd = chosenCompatLayer.binaryPath;
            spawnArgs = [resolvedExePath, ...args];
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          }
        } else if (platform === 'darwin' && resolvedExePath) {
          const appBundleMatch = String(resolvedExePath).match(/^(.*?\.app)(?:[\\/]|$)/i);
          const enclosingAppBundle = appBundleMatch && appBundleMatch[1] ? appBundleMatch[1] : null;
          if (
            enclosingAppBundle &&
            !isTestEnvironment(options) &&
            typeof options.spawnFn !== 'function' &&
            options.preferDirectMacBinary !== true
          ) {
            // Launch native macOS .app bundles via LaunchServices (/usr/bin/open -W -a) so the game runs
            // under its own TCC responsible-process attribution rather than inheriting One Launcher's TCC identity.
            spawnCmd = '/usr/bin/open';
            spawnArgs = [
              '-W',
              '-a',
              enclosingAppBundle,
              ...(args.length > 0 ? ['--args', ...args] : []),
            ];
          } else if (resolvedExePath.endsWith('.app')) {
            const innerBin = resolveMacAppBundleBinary(resolvedExePath);
            if (innerBin && innerBin !== resolvedExePath && fs.existsSync(innerBin)) {
              spawnCmd = innerBin;
              spawnArgs = [...args];
            } else {
              spawnCmd = '/usr/bin/open';
              spawnArgs = ['-W', '-a', resolvedExePath, ...(args.length > 0 ? ['--args', ...args] : [])];
            }
          } else {
            spawnArgs = [...args];
          }
        } else {
          spawnArgs = [...args];
        }
      }

      if (resolvedExePath) {
        let shouldFallthroughToStorefrontUri = false;
        try {
          if (platform === 'darwin' && !useCompatLayer) {
            try {
              ensureMacAppCodeSignatureValid(resolvedExePath || localInstallDir, options);
            } catch {}
          }
          if (platform !== 'win32' && fs.existsSync(spawnCmd) && spawnCmd !== '/usr/bin/open') {
            try {
              const st = fs.statSync(spawnCmd);
              if (st.isFile() && (st.mode & 0o111) === 0) {
                fs.chmodSync(spawnCmd, 0o755);
              }
            } catch {}
            if (platform === 'darwin' && !options.homedir) {
              try {
                const appMatch = String(spawnCmd).match(/^(.*?\.app)(?:\/|$)/i);
                const targetQuarantinePath = appMatch ? appMatch[1] : spawnCmd;
                if (localInstallDir && fs.existsSync(localInstallDir)) {
                  execFile('xattr', ['-dr', 'com.apple.quarantine', localInstallDir], () => {});
                }
                execFile('xattr', ['-dr', 'com.apple.quarantine', targetQuarantinePath], () => {});
              } catch {}
            }
          }

          const cwd =
            launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
              ? launchConfig.workingDirectory
              : shouldLaunchViaBottleSteam && bottleSteamExe
                ? path.dirname(bottleSteamExe)
                : path.dirname(resolvedExePath);
          const effectiveCwd = fs.existsSync(cwd) ? cwd : os.homedir();

          const gameSpawnImpl =
            typeof options.gameSpawnFn === 'function'
              ? options.gameSpawnFn
              : typeof options.spawnFn === 'function' && options.useSpawnFnForGame !== false && payload.platformId !== 'gog'
                ? options.spawnFn
                : spawn;

          if (
            shouldLaunchViaBottleSteam &&
            bottleSteamExe &&
            chosenCompatLayer &&
            chosenCompatLayer.binaryPath &&
            !wasBottleSteamRunning &&
            !isFastMinimalBypass &&
            (!isTestEnvironment(options) || options.enableTwoStageSteamColdStart === true)
          ) {
            try {
              const bottleSteamRoot = path.dirname(bottleSteamExe);
              const bottleCloudLogPath = path.join(bottleSteamRoot, 'logs', 'cloud_log.txt');
              let preBootLogOffset = 0;
              try {
                if (fs.existsSync(bottleCloudLogPath)) {
                  preBootLogOffset = fs.statSync(bottleCloudLogPath).size;
                }
              } catch {}

              emitSessionUpdated(
                {
                  gameId,
                  platformId: payload.platformId || 'steam',
                  status: 'starting',
                  event: 'starting',
                  statusMessage: 'Starting Steam & syncing Steam Cloud...',
                },
                options
              );

              const stage1BottleSteam = gameSpawnImpl(
                chosenCompatLayer.binaryPath,
                [
                  bottleSteamExe,
                  ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                    ? []
                    : ['-silent']),
                ],
                {
                  cwd: fs.existsSync(bottleSteamRoot) ? bottleSteamRoot : effectiveCwd,
                  env,
                  stdio: 'ignore',
                  detached: true,
                }
              );
              if (stage1BottleSteam && typeof stage1BottleSteam.unref === 'function') {
                stage1BottleSteam.unref();
              }

              await waitForSteamColdStartupCloudReady(bottleSteamRoot, effectiveSteamAppId, {
                ...options,
                preBootLogOffset,
                steamRootStrict: true,
              });
            } catch (coldStartErr) {
              diagLog.warn('launchGame.bottleSteamColdStartSync', coldStartErr, {
                gameId,
                appId: effectiveSteamAppId,
              });
            }
          }

          if (
            chosenCompatLayer &&
            chosenCompatLayer.binaryPath &&
            ((shouldWakeBottleGog && bottleGogExe) || (shouldWakeBottleEpic && bottleEpicExe))
          ) {
            const bottleHelperExecFileImpl =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            const bottleClientSpawnImpl =
              typeof options.bottleClientSpawnFn === 'function'
                ? options.bottleClientSpawnFn
                : typeof options.gameSpawnFn === 'function'
                  ? options.gameSpawnFn
                  : typeof options.spawnFn === 'function'
                    ? options.spawnFn
                    : spawn;

            const checkWinExeRunningInProcessList = async (exeRegex) => {
              if (typeof options.mockProcessListOutput === 'string') {
                return exeRegex.test(options.mockProcessListOutput);
              }
              if (typeof options.getProcessListOutput === 'function') {
                try {
                  return exeRegex.test(String((await options.getProcessListOutput()) || ''));
                } catch {
                  return false;
                }
              }
              if (
                !options.homedir ||
                typeof options.execFileImpl === 'function' ||
                typeof options.execFileFn === 'function'
              ) {
                try {
                  return await new Promise((resolve) => {
                    bottleHelperExecFileImpl(
                      'ps',
                      ['-ax', '-o', 'command='],
                      { timeout: 1500 },
                      (err, stdout) => {
                        resolve(!err && exeRegex.test(String(stdout || '')));
                      }
                    );
                  });
                } catch {
                  return false;
                }
              }
              return false;
            };

            if (shouldWakeBottleGog && bottleGogExe) {
              wasBottleGogRunning = await checkWinExeRunningInProcessList(
                /(?:^|[\\/\s"'])GalaxyClient\.exe(?:\s|["']|$)/i
              );
              if (!wasBottleGogRunning) {
                try {
                  const bottleGogRoot = path.dirname(bottleGogExe);
                  const bottleGogArgs = [
                    bottleGogExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['/deactivated']),
                  ];
                  const bgBottleGog = bottleClientSpawnImpl(
                    chosenCompatLayer.binaryPath,
                    bottleGogArgs,
                    {
                      cwd: fs.existsSync(bottleGogRoot) ? bottleGogRoot : effectiveCwd,
                      env,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (bgBottleGog && typeof bgBottleGog.unref === 'function') {
                    bgBottleGog.unref();
                  }
                  wokeBottleGogByLauncher = true;
                } catch (bgGogErr) {
                  diagLog.warn('launchGame.bottleGogWake', bgGogErr, { gameId });
                }
              }
            }

            if (shouldWakeBottleEpic && bottleEpicExe) {
              wasBottleEpicRunning = await checkWinExeRunningInProcessList(
                /(?:^|[\\/\s"'])EpicGamesLauncher\.exe(?:\s|["']|$)/i
              );
              if (!wasBottleEpicRunning) {
                try {
                  const bottleEpicRoot = path.dirname(bottleEpicExe);
                  const bottleEpicArgs = [
                    bottleEpicExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['-silent']),
                  ];
                  const bgBottleEpic = bottleClientSpawnImpl(
                    chosenCompatLayer.binaryPath,
                    bottleEpicArgs,
                    {
                      cwd: fs.existsSync(bottleEpicRoot) ? bottleEpicRoot : effectiveCwd,
                      env,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (bgBottleEpic && typeof bgBottleEpic.unref === 'function') {
                    bgBottleEpic.unref();
                  }
                  wokeBottleEpicByLauncher = true;
                } catch (bgEpicErr) {
                  diagLog.warn('launchGame.bottleEpicWake', bgEpicErr, { gameId });
                }
              }
            }
          }

          let child = null;
          try {
            child = gameSpawnImpl(spawnCmd, spawnArgs, {
              cwd: effectiveCwd,
              env,
              stdio: ['ignore', 'ignore', 'pipe'],
              detached: false,
            });
          } catch (initialSpawnErr) {
            if (!useCompatLayer && isAutoLikeMethod && buildStorefrontLaunchUri(payload)) {
              shouldFallthroughToStorefrontUri = true;
            } else if (platform === 'win32' && !useCompatLayer) {
              const psFilePath = String(spawnCmd).replace(/'/g, "''");
              const psCwd = String(effectiveCwd).replace(/'/g, "''");
              const psArgStr =
                spawnArgs.length > 0
                  ? ` -ArgumentList ${spawnArgs.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')}`
                  : '';
              child = gameSpawnImpl(
                'powershell.exe',
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-WindowStyle',
                  'Hidden',
                  '-Command',
                  `$p = Start-Process -FilePath '${psFilePath}' -WorkingDirectory '${psCwd}'${psArgStr} -Wait -PassThru; exit $p.ExitCode`,
                ],
                {
                  cwd: effectiveCwd,
                  env,
                  detached: false,
                  stdio: ['ignore', 'ignore', 'pipe'],
                }
              );
            } else {
              throw initialSpawnErr;
            }
          }

          if (!shouldFallthroughToStorefrontUri && child) {
            const session = {
              sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              gameId,
              title: String(payload.title || gameId),
              platformId: payload.platformId || 'custom',
              platformGameId: String(payload.platformGameId || gameId),
              pid: shouldLaunchViaBottleSteam ? undefined : child.pid,
              startedAt: new Date().toISOString(),
              launchMethod: actualLaunchMethod,
              executablePath: resolvedExePath,
              status: 'running',
            };

            const resolvedWineBinary =
              useCompatLayer && chosenCompatLayer ? chosenCompatLayer.binaryPath || null : null;
            const resolvedWineserverBinary = resolvedWineBinary
              ? resolveWineserverBinary(resolvedWineBinary)
              : null;
            const resolvedWinePrefix = useCompatLayer
              ? compatResult?.winePrefix || env.WINEPREFIX || null
              : null;

            const entry = {
              session,
              platformId: session.platformId,
              child,
              pid: shouldLaunchViaBottleSteam ? 0 : child.pid || 0,
              pollTimer: null,
              startedMs: Date.now(),
              postExitCommand: launchConfig.postExitCommand,
              finalized: false,
              stopping: false,
              stderrBuffer: '',
              exitCode: null,
              stoppedByUser: false,
              wineBinary: resolvedWineBinary,
              wineserverBinary: resolvedWineserverBinary,
              winePrefix: resolvedWinePrefix,
              launchEnv: env,
              installPath: localInstallDir || payload.installPath || '',
              platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
              steamAppId: effectiveSteamAppId || undefined,
              launchOptions: options,
              launchConfig,
              effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
              wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
              gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
              wokeSteamByLauncher: false,
              steamClientBinaryPath: null,
              launchedViaBottleSteam: shouldLaunchViaBottleSteam,
              bottleSteamExe: shouldLaunchViaBottleSteam ? bottleSteamExe : null,
              bottleSteamRoot:
                shouldLaunchViaBottleSteam && bottleSteamExe ? path.dirname(bottleSteamExe) : null,
              wokeBottleSteamByLauncher: shouldLaunchViaBottleSteam ? !wasBottleSteamRunning : false,
              bottleGogExe: shouldWakeBottleGog ? bottleGogExe : null,
              wasBottleGogRunning,
              wokeBottleGogByLauncher,
              bottleEpicExe: shouldWakeBottleEpic ? bottleEpicExe : null,
              wasBottleEpicRunning,
              wokeBottleEpicByLauncher,
            };

            if (child.stderr && typeof child.stderr.on === 'function') {
              child.stderr.on('data', (chunk) => {
                if (entry.stderrBuffer.length < 4096) {
                  entry.stderrBuffer += String(chunk);
                }
              });
            }

            activeSessions.set(gameId, entry);
            releasePendingBottleLock();
            releasePendingPlatformLock();

            if (effectivePerfPolicy.pauseDownloadsInGame !== false) {
              try {
                pauseActiveDownloadsForInGame(options);
              } catch {}
            }
            emitSessionUpdated({ session: { ...session }, event: 'started' }, options);

            if (shouldLaunchViaBottleSteam) {
              // Bottle Steam (`steam.exe -silent -applaunch <id>`): CLI stub may exit in ~1s when
              // handing off to an existing steam.exe, OR stay alive forever as background steam.exe.
              // Track the target <Game.exe> via PID-latching process polling rather than steam.exe's child exit.
              if (typeof child.on === 'function') {
                child.on('error', (err) => {
                  entry.exitCode = -1;
                  entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
                  if (!entry.stopping) {
                    finalizeGameSession(gameId, options);
                  }
                });
              }

              if (!options.disableBottleSteamPolling) {
                const candidateGameExeNames = new Set();
                if (resolvedExePath) {
                  candidateGameExeNames.add(path.basename(resolvedExePath).toLowerCase());
                }
                if (payload.executablePath) {
                  candidateGameExeNames.add(path.basename(payload.executablePath).toLowerCase());
                }
                if (localInstallDir && fs.existsSync(localInstallDir)) {
                  try {
                    const topEntries = fs.readdirSync(localInstallDir, { withFileTypes: true });
                    for (const ent of topEntries) {
                      if (
                        ent.isFile() &&
                        ent.name.toLowerCase().endsWith('.exe') &&
                        !/^(?:steam|steamwebhelper|steamservice|steamerrorreporter|unins\d+|vc_redist.*|dxsetup|unitycrashhandler.*|crashreportclient.*)\.exe$/i.test(
                          ent.name
                        )
                      ) {
                        candidateGameExeNames.add(ent.name.toLowerCase());
                      }
                    }
                  } catch {}
                }
                const bottleExeHints = Array.from(candidateGameExeNames).filter(Boolean);
                const bottlePollMs = Math.max(
                  15,
                  Number(options.bottleSteamPollIntervalMs || 1500)
                );
                const maxLaunchWaitMs = Number(options.bottleSteamMaxLaunchWaitMs ?? 120000);
                const execFileImpl =
                  typeof options.execFileImpl === 'function'
                    ? options.execFileImpl
                    : typeof options.execFileFn === 'function'
                      ? options.execFileFn
                      : execFile;
                const hasMockProcessSource =
                  typeof options.getProcessListOutput === 'function' ||
                  typeof options.execFileImpl === 'function' ||
                  typeof options.execFileFn === 'function' ||
                  typeof options.bottleSteamProcessListFn === 'function';
                let seenGameRunning = false;

                const pollTimer = setInterval(() => {
                  if (entry.finalized || entry.stopping) {
                    clearInterval(pollTimer);
                    entry.pollTimer = null;
                    return;
                  }

                  const trackedPid = Number(entry.pid || entry.session?.pid || 0);
                  if (trackedPid > 0 && !hasMockProcessSource && typeof options.mockProcessListOutput !== 'string') {
                    let trackedAlive = false;
                    try {
                      process.kill(trackedPid, 0);
                      trackedAlive = true;
                    } catch (killErr) {
                      trackedAlive = Boolean(killErr && killErr.code === 'EPERM');
                    }
                    if (trackedAlive) {
                      seenGameRunning = true;
                      return;
                    }
                    entry.pid = 0;
                    if (entry.session) {
                      entry.session.pid = undefined;
                    }
                  }

                  const handleBottleProcessList = (err, stdout) => {
                    if (err || entry.finalized || entry.stopping) return;
                    const outStr = String(stdout || '');
                    const matchedPid = extractMatchedPidFromProcessOutput(
                      outStr,
                      bottleExeHints,
                      'darwin'
                    );
                    const lowerOut = outStr.toLowerCase();
                    const isPresent =
                      matchedPid > 0 || bottleExeHints.some((h) => h && lowerOut.includes(h));
                    if (isPresent) {
                      seenGameRunning = true;
                      if (matchedPid > 0) {
                        entry.pid = matchedPid;
                        if (entry.session) {
                          entry.session.pid = matchedPid;
                        }
                      }
                    } else if (seenGameRunning) {
                      entry.exitCode = 0;
                      finalizeGameSession(gameId, options);
                    } else if (
                      maxLaunchWaitMs > 0 &&
                      Date.now() - entry.startedMs >= maxLaunchWaitMs
                    ) {
                      entry.exitCode = 0;
                      finalizeGameSession(gameId, options);
                    }
                  };

                  if (typeof options.bottleSteamProcessListFn === 'function') {
                    Promise.resolve(options.bottleSteamProcessListFn())
                      .then((out) => handleBottleProcessList(null, out))
                      .catch(() => {});
                  } else if (typeof options.getProcessListOutput === 'function') {
                    Promise.resolve(options.getProcessListOutput())
                      .then((out) => handleBottleProcessList(null, out))
                      .catch(() => {});
                  } else if (
                    typeof options.execFileImpl === 'function' ||
                    typeof options.execFileFn === 'function' ||
                    !options.homedir
                  ) {
                    execFileImpl(
                      'ps',
                      ['-ax', '-o', 'pid=,command='],
                      { timeout: 2500 },
                      handleBottleProcessList
                    );
                  } else if (typeof options.mockProcessListOutput === 'string') {
                    handleBottleProcessList(null, options.mockProcessListOutput);
                  }
                }, bottlePollMs);

                if (typeof pollTimer.unref === 'function') {
                  pollTimer.unref();
                }
                entry.pollTimer = pollTimer;
              }
            } else if (typeof child.on === 'function') {
              child.on('exit', (code, signal) => {
                if (entry.exitCode === null || entry.exitCode === undefined) {
                  if (typeof code === 'number') {
                    entry.exitCode = code;
                  } else if (signal && !entry.stoppedByUser && !entry.stopping) {
                    entry.exitCode = -1;
                    entry.exitSignal = signal;
                    if (!entry.stderrBuffer.trim()) {
                      entry.stderrBuffer = `Process terminated by signal ${signal}`;
                    }
                  } else {
                    entry.exitCode = 0;
                  }
                }
                if (entry.stopping) {
                  return;
                }
                if (child.stderr && !child.stderr.destroyed && child.stderr.readable) {
                  child.once('close', () => {
                    if (!entry.stopping) finalizeGameSession(gameId, options);
                  });
                  const flushTimer = setTimeout(() => {
                    if (!entry.stopping) finalizeGameSession(gameId, options);
                  }, 50);
                  if (typeof flushTimer.unref === 'function') flushTimer.unref();
                } else {
                  finalizeGameSession(gameId, options);
                }
              });

              child.on('error', (err) => {
                entry.exitCode = -1;
                entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
                if (!entry.stopping) {
                  finalizeGameSession(gameId, options);
                }
              });
            }

            const startupWaitMs =
              options.startupWaitMs !== undefined
                ? Number(options.startupWaitMs)
                : options.homedir || options.skipStartupWait
                  ? 0
                  : 450;

            if (startupWaitMs > 0) {
              await new Promise((r) => setTimeout(r, startupWaitMs));
            }

            if (entry.exitCode !== null && entry.exitCode !== 0) {
              const rawStderr = (entry.stderrBuffer || '').trim();
              const fatalMatch = rawStderr.match(/Fatal Error:\s*(.+)/i);
              const stderrLines = rawStderr
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);
              const extractedError =
                (fatalMatch && fatalMatch[0]) ||
                (stderrLines.length > 0 ? stderrLines[stderrLines.length - 1] : '') ||
                `Process exited immediately with code ${entry.exitCode}`;
              if (
                !useCompatLayer &&
                isAutoLikeMethod &&
                /spawn\s+UNKNOWN/i.test(extractedError) &&
                buildStorefrontLaunchUri(payload)
              ) {
                shouldFallthroughToStorefrontUri = true;
              } else {
                return {
                  success: false,
                  error: extractedError,
                  sessionMinutesPlayed: 0,
                };
              }
            } else {
              return {
                success: true,
                message: `Launched ${session.title}`,
                session: { ...session },
                executablePath: resolvedExePath,
              };
            }
          }
        } catch (spawnErr) {
          if (!useCompatLayer && isAutoLikeMethod && buildStorefrontLaunchUri(payload)) {
            shouldFallthroughToStorefrontUri = true;
          } else {
            return {
              success: false,
              error: `Failed to spawn game process: ${spawnErr.message}`,
            };
          }
        }
      }
    }

    releasePendingBottleLock();

    // 2. Storefront URI Launch (or 'auto' fallback when no local executable is found)
    const uri = buildStorefrontLaunchUri(payload);
    if (!uri) {
      return {
        success: false,
        error: 'No local executable or storefront protocol URI available to launch this game.',
      };
    }

    // When launching Steam via storefront URI and Steam is not running yet, spawn Steam with minimal flags
    if (
      payload.platformId === 'steam' &&
      (!options.homedir ||
        typeof options.spawnFn === 'function' ||
        Boolean(options.steamClientBinaryPath || options.customApplicationsDir) ||
        options.allowSteamMinimalSpawnInTest ||
        options.enableTwoStageSteamColdStart === true)
    ) {
      try {
        const steamAppIdVal = String(payload.steamAppId || payload.platformGameId || '')
          .replace(/^steam[-_]/i, '')
          .trim();
        const steamLaunchSpec = await resolveSteamClientLaunchCommand(steamAppIdVal, args, {
          ...options,
          launchConfig,
          storefrontClientLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
        });
        if (
          steamLaunchSpec &&
          !steamLaunchSpec.alreadyRunning &&
          steamLaunchSpec.binaryPath &&
          !isFastMinimalBypass &&
          (!isTestEnvironment(options) || options.enableTwoStageSteamColdStart === true)
        ) {
          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const hostSteamRoot =
            options.steamRoot ||
            (platform === 'win32'
              ? path.dirname(steamLaunchSpec.binaryPath)
              : path.join(
                  options.homedir || os.homedir(),
                  'Library',
                  'Application Support',
                  'Steam'
                ));
          const hostCloudLogPath = hostSteamRoot
            ? path.join(hostSteamRoot, 'logs', 'cloud_log.txt')
            : '';
          let preBootLogOffset = 0;
          try {
            if (hostCloudLogPath && fs.existsSync(hostCloudLogPath)) {
              preBootLogOffset = fs.statSync(hostCloudLogPath).size;
            }
          } catch {}

          emitSessionUpdated(
            {
              gameId,
              platformId: payload.platformId || 'steam',
              status: 'starting',
              event: 'starting',
              statusMessage: 'Starting Steam & syncing Steam Cloud...',
            },
            options
          );

          const stage1Args = steamLaunchSpec.useMinimalBinarySpawn ? ['-silent'] : [];
          const stage1Child = spawnImpl(steamLaunchSpec.binaryPath, stage1Args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (stage1Child && typeof stage1Child.unref === 'function') {
            stage1Child.unref();
          }

          await waitForSteamColdStartupCloudReady(hostSteamRoot, steamAppIdVal, {
            ...options,
            preBootLogOffset,
          });

          if (steamLaunchSpec.useMinimalBinarySpawn) {
            if (platform === 'win32') {
              const stage2Child = spawnImpl(steamLaunchSpec.binaryPath, steamLaunchSpec.args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              });
              if (stage2Child && typeof stage2Child.unref === 'function') {
                stage2Child.unref();
              }
            } else {
              await openExternalUri(uri, options);
            }
            steamMinimalSpawnedResult = steamLaunchSpec;
          }
        } else if (
          steamLaunchSpec &&
          steamLaunchSpec.useMinimalBinarySpawn &&
          steamLaunchSpec.binaryPath
        ) {
          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const steamChild = spawnImpl(steamLaunchSpec.binaryPath, steamLaunchSpec.args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (steamChild && typeof steamChild.unref === 'function') {
            steamChild.unref();
          }
          steamMinimalSpawnedResult = steamLaunchSpec;
        }
      } catch {}
    }

    let gogCliSpawned = false;
    if (payload.platformId === 'gog') {
      const cleanGogId = String(payload.platformGameId || gameId || '')
        .trim()
        .replace(/^gog[-_]/i, '');
      const gogInstallTarget =
        localInstallDir || (payload.installPath ? toLocalFsPath(payload.installPath) : '');

      if (
        gogInstallTarget &&
        fs.existsSync(gogInstallTarget) &&
        (!isTestEnvironment(options) ||
          Boolean(options.gogGalaxyDbPath || options.gogGalaxyConfigPath))
      ) {
        try {
          await syncGogGameToGalaxy(
            {
              platformGameId: payload.platformGameId || gameId,
              title: payload.title,
              installPath: gogInstallTarget,
              executablePath: resolvedExePath || payload.executablePath,
            },
            options
          );
        } catch {}
      }

      if (
        platform === 'win32' &&
        typeof options.openExternalFn !== 'function' &&
        cleanGogId &&
        gogInstallTarget &&
        fs.existsSync(gogInstallTarget)
      ) {
        const galaxyClientExe = resolveGogGalaxyClientBinaryPath(options);
        if (galaxyClientExe) {
          try {
            const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
            const gogChild = spawnImpl(
              galaxyClientExe,
              [`/command=runGame`, `/gameId=${cleanGogId}`, `/path=${gogInstallTarget}`],
              {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              }
            );
            if (gogChild && typeof gogChild.unref === 'function') {
              gogChild.unref();
            }
            gogCliSpawned = true;
          } catch {}
        }
      }
    }

    if (!steamMinimalSpawnedResult && !gogCliSpawned) {
      await openExternalUri(uri, options);
    }

    const session = {
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      gameId,
      title: String(payload.title || gameId),
      platformId: payload.platformId || 'steam',
      platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
      pid: undefined,
      startedAt: new Date().toISOString(),
      launchMethod: 'storefront_uri',
      executablePath: resolvedExePath || payload.executablePath,
      status: 'running',
    };

    const entry = {
      session,
      platformId: session.platformId,
      child: null,
      startedMs: Date.now(),
      postExitCommand: launchConfig.postExitCommand,
      finalized: false,
      stopping: false,
      pollTimer: null,
      stderrBuffer: '',
      exitCode: null,
      stoppedByUser: false,
      wineBinary: null,
      wineserverBinary: null,
      winePrefix: null,
      installPath: localInstallDir || payload.installPath || '',
      platformGameId: String(payload.platformGameId || payload.steamAppId || gameId),
      steamAppId: effectiveSteamAppId || undefined,
      launchOptions: options,
      launchConfig,
      effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
      wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
      gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
      wokeSteamByLauncher: Boolean(steamMinimalSpawnedResult && steamMinimalSpawnedResult.wokeSteamByLauncher),
      steamClientBinaryPath: steamMinimalSpawnedResult ? steamMinimalSpawnedResult.binaryPath || null : null,
    };

    // Optional background process tree monitor when installPath is known
    if (payload.installPath && !options.disableUriPolling) {
      let seenRunningOnSystem = false;
      const pollIntervalMs = Number(options.uriPollIntervalMs || 4000);
      const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
      const pollTimer = setInterval(() => {
        if (entry.finalized) {
          clearInterval(pollTimer);
          entry.pollTimer = null;
          return;
        }
        const trackedPid = Number(entry.session?.pid || entry.pid || 0);
        if (trackedPid > 0) {
          let trackedAlive = false;
          try {
            process.kill(trackedPid, 0);
            trackedAlive = true;
          } catch (killErr) {
            trackedAlive = Boolean(killErr && killErr.code === 'EPERM');
          }
          if (trackedAlive) {
            seenRunningOnSystem = true;
            return;
          }
          // Tracked PID exited (ESRCH) — clear latched PID and fall through to check if any child process remains
          entry.pid = 0;
          if (entry.session) {
            entry.session.pid = undefined;
          }
        }
        const targetPlatform = options.platform || process.platform;
        const exeHints = [
          payload.executablePath ? path.basename(payload.executablePath).toLowerCase() : '',
          resolvedExePath ? path.basename(resolvedExePath).toLowerCase() : '',
          payload.installPath ? path.basename(payload.installPath).toLowerCase() : '',
        ].filter(Boolean);
        const handleProcessList = (err, stdout) => {
          if (err || !stdout || entry.finalized) return;
          const matchedPid = extractMatchedPidFromProcessOutput(
            stdout,
            exeHints,
            targetPlatform
          );
          const out = String(stdout).toLowerCase();
          const isPresent =
            matchedPid > 0 || exeHints.some((h) => h && out.includes(h));
          if (isPresent) {
            seenRunningOnSystem = true;
            if (matchedPid > 0) {
              entry.pid = matchedPid;
              if (entry.session) {
                entry.session.pid = matchedPid;
              }
            }
          } else if (seenRunningOnSystem) {
            finalizeGameSession(gameId, options);
          }
        };
        if (targetPlatform === 'win32') {
          execFileImpl('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 2500 }, handleProcessList);
        } else {
          execFileImpl('ps', ['-ax', '-o', 'pid=,command='], { timeout: 2500 }, handleProcessList);
        }
      }, pollIntervalMs);
      if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
      }
      entry.pollTimer = pollTimer;
    }

    activeSessions.set(gameId, entry);
    releasePendingPlatformLock();

    if (effectivePerfPolicy.pauseDownloadsInGame !== false) {
      try {
        pauseActiveDownloadsForInGame(options);
      } catch {}
    }
    emitSessionUpdated({ session: { ...session }, event: 'started' }, options);

    return {
      success: true,
      message: `Opened via ${session.platformId.toUpperCase()} client (${uri})`,
      session: { ...session },
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  } finally {
    releasePendingBottleLock();
    releasePendingPlatformLock();
  }
}

/**
 * Stop a running game session cleanly (SIGTERM -> wineserver -k/-w teardown -> SIGKILL fallback)
 */
async function stopGame(request = {}, options = {}) {
  try {
    const reqObj = typeof request === 'string' ? { gameId: request, sessionId: request } : request || {};
    let targetKey = null;
    let targetEntry = null;

    if (reqObj.gameId && activeSessions.has(reqObj.gameId)) {
      targetKey = reqObj.gameId;
      targetEntry = activeSessions.get(reqObj.gameId);
    } else {
      for (const [k, entry] of activeSessions.entries()) {
        if (
          (reqObj.sessionId && entry.session.sessionId === reqObj.sessionId) ||
          (reqObj.pid && entry.session.pid === reqObj.pid) ||
          (reqObj.gameId && entry.session.platformGameId === String(reqObj.gameId))
        ) {
          targetKey = k;
          targetEntry = entry;
          break;
        }
      }
    }

    if (!targetEntry || !targetKey) {
      return {
        success: false,
        error: 'No active running game session found.',
      };
    }

    targetEntry.stopping = true;
    targetEntry.stoppedByUser = true;
    targetEntry.session.status = 'stopping';
    emitSessionUpdated({
      session: { ...targetEntry.session },
      event: 'stopping',
    });

    const isTestHomedir = Boolean(options.homedir || reqObj.homedir);
    const exePath = targetEntry.session?.executablePath || '';
    const exeBase =
      process.platform !== 'win32' && exePath.toLowerCase().endsWith('.exe')
        ? path.basename(exePath)
        : '';

    if (!isTestHomedir && exeBase && exeBase.length > 3) {
      await new Promise((resolve) => {
        try {
          execFile('pkill', ['-TERM', '-f', exeBase], { timeout: 1000 }, () => resolve());
        } catch {
          resolve();
        }
      });
    }

    const mergedStopOptions = {
      ...(targetEntry.launchOptions || {}),
      ...(options || {}),
    };
    const effectivePerfPolicy = resolveEffectivePerformancePolicy(
      targetEntry.launchConfig || {},
      mergedStopOptions
    );

    const pid = targetEntry.launchedViaBottleSteam
      ? Number(targetEntry.pid || targetEntry.session?.pid || 0) || null
      : (targetEntry.child && targetEntry.child.pid ? targetEntry.child.pid : null) ||
        Number(targetEntry.pid || targetEntry.session?.pid || 0) ||
        null;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }

    // If this session was launched via a Wine compatibility layer, cleanly shut down wineserver
    // when autoShutdownWinePrefixOnExit !== false (unless another session is active/pending in the same
    // prefix, or Bottle Steam / Epic / GOG needs to flush cloud saves inside finalizeGameSession first).
    const sessionWinePrefix = targetEntry.winePrefix || null;
    const sessionWineBin = targetEntry.wineserverBinary || targetEntry.wineBinary || null;
    const entryPlatformId = targetEntry.session?.platformId || targetEntry.platformId || '';
    const needsDeferredPrefixShutdownForCloud = Boolean(
      targetEntry.launchedViaBottleSteam ||
        targetEntry.wokeBottleGogByLauncher ||
        targetEntry.wasBottleGogRunning ||
        targetEntry.wokeBottleEpicByLauncher ||
        targetEntry.wasBottleEpicRunning ||
        entryPlatformId === 'epic' ||
        entryPlatformId === 'gog'
    );
    if (
      process.platform !== 'win32' &&
      sessionWinePrefix &&
      sessionWineBin &&
      effectivePerfPolicy.autoShutdownWinePrefixOnExit !== false
    ) {
      const resolvedWineserver = resolveWineserverBinary(sessionWineBin);
      const canRunWineserver =
        Boolean(resolvedWineserver) &&
        (!isTestHomedir ||
          resolvedWineserver.startsWith(options.homedir || reqObj.homedir || '') ||
          resolvedWineserver.startsWith(os.tmpdir()) ||
          resolvedWineserver.startsWith('/private/var/folders') ||
          resolvedWineserver.startsWith('/var/folders'));
      if (needsDeferredPrefixShutdownForCloud) {
        if (canRunWineserver) {
          targetEntry.deferredPrefixShutdownToFinalize = true;
        }
      } else {
        const resolvedSessionPrefix = path.resolve(sessionWinePrefix);
        const hasOtherActiveSessionInPrefix =
          (pendingBottleLaunches.get(resolvedSessionPrefix) || 0) > 0 ||
          Array.from(activeSessions.entries()).some(
            ([k, e]) =>
              k !== targetKey &&
              !e.finalized &&
              e.winePrefix &&
              path.resolve(e.winePrefix) === resolvedSessionPrefix
          );
        if (!hasOtherActiveSessionInPrefix && canRunWineserver) {
          targetEntry.wineShutdownHandledByStopGame = true;
          await shutdownWinePrefix(resolvedWineserver, sessionWinePrefix, 2500);
        }
      }
    }

    if (pid) {
      const exitedGracefully = await waitForProcessExit(
        targetEntry.launchedViaBottleSteam ? null : targetEntry.child,
        pid,
        500
      );
      if (!exitedGracefully && isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        if (!isTestHomedir && exeBase && exeBase.length > 3) {
          await new Promise((resolve) => {
            try {
              execFile('pkill', ['-KILL', '-f', exeBase], { timeout: 1000 }, () => resolve());
            } catch {
              resolve();
            }
          });
        }
        await waitForProcessExit(
          targetEntry.launchedViaBottleSteam ? null : targetEntry.child,
          pid,
          400
        );
      }
    }

    const result = finalizeGameSession(targetKey, options) || {
      session: targetEntry.session,
      sessionMinutesPlayed: Math.max(1, Math.round((Date.now() - targetEntry.startedMs) / 60000)),
    };

    if (options.awaitPostSessionBarrier && result.postSessionBarrierPromise) {
      await result.postSessionBarrierPromise;
    }

    let storefrontTotalPlaytimeMinutes = null;
    if (options.awaitStorefrontPlaytimeSync && result.storefrontSyncPromise) {
      const syncRes = await result.storefrontSyncPromise;
      if (syncRes && typeof syncRes.storefrontTotalPlaytimeMinutes === 'number') {
        storefrontTotalPlaytimeMinutes = syncRes.storefrontTotalPlaytimeMinutes;
      }
    }

    return {
      success: true,
      message: `Stopped ${targetEntry.session.title}`,
      session: result.session,
      sessionMinutesPlayed: result.sessionMinutesPlayed,
      ...(storefrontTotalPlaytimeMinutes !== null ? { storefrontTotalPlaytimeMinutes } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

function getRunningGames() {
  return Array.from(activeSessions.values()).map((entry) => ({ ...entry.session }));
}

/**
 * D) Disk Space & Download / Installation Queue Manager
 */
function getDiskSpace(targetPath, options = {}) {
  try {
    const homedir = options.homedir || os.homedir();
    let curr = toLocalFsPath(targetPath || homedir) || homedir;

    // Walk up parent directories until an existing path is found
    let guard = 0;
    while (!fs.existsSync(curr) && guard < 25) {
      const parent = path.dirname(curr);
      if (!parent || parent === curr) {
        curr = homedir;
        break;
      }
      curr = parent;
      guard++;
    }

    if (!fs.existsSync(curr)) {
      curr = os.homedir();
    }

    const stats = fs.statfsSync(curr);
    const bsize = Number(stats.bsize || 4096);
    const totalBytes = Number(stats.blocks || 0) * bsize;
    const freeBytes = Number(stats.bavail || stats.bfree || 0) * bsize;
    const usedBytes = Math.max(0, totalBytes - Number(stats.bfree || 0) * bsize);

    return {
      targetPath: targetPath || curr,
      freeBytes,
      totalBytes,
      usedBytes,
    };
  } catch {
    return {
      targetPath: targetPath || os.homedir(),
      freeBytes: 100 * 1024 * 1024 * 1024,
      totalBytes: 500 * 1024 * 1024 * 1024,
      usedBytes: 400 * 1024 * 1024 * 1024,
    };
  }
}

function getDefaultInstallDir(platformId = 'custom', options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const storeFolder =
    platformId === 'gog'
      ? 'GOG'
      : platformId === 'epic'
        ? 'Epic'
        : platformId === 'steam'
          ? 'Steam'
          : 'Games';

  if (platform === 'win32' && !options.homedir) {
    return `C:\\Games\\OneLauncher\\${storeFolder}`;
  }
  return path.join(homedir, 'Games', 'OneLauncher', storeFolder);
}

const quarantineClearedBinaries = new Set();

function findBundledOrSystemCliBinary(baseName, options = {}) {
  const homedir = options.homedir || os.homedir();
  if (options.homedir && options.allowSystemBinariesInTest !== true) {
    const testCandidates = [
      path.join(options.homedir, `Library/Application Support/heroic/tools/bin/${baseName}`),
      path.join(options.homedir, `.local/bin/${baseName}`),
      path.join(options.homedir, `bin/${baseName}`),
    ];
    return testCandidates.find((p) => fs.existsSync(p)) || null;
  }

  const binName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
  const unpackedDir = __dirname.replace('app.asar', 'app.asar.unpacked');
  const candidates = [
    path.join(unpackedDir, 'bin', process.arch, process.platform, binName),
    path.join(__dirname, 'bin', process.arch, process.platform, binName),
    `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/arm64/darwin/${baseName}`,
    `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/x64/darwin/${baseName}`,
    `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/arm64/${baseName}`,
    `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/x64/${baseName}`,
    path.join(homedir, `Library/Application Support/heroic/tools/bin/${baseName}`),
    `/opt/homebrew/bin/${baseName}`,
    `/usr/local/bin/${baseName}`,
    path.join(homedir, `.local/bin/${baseName}`),
    path.join(
      process.env.LOCALAPPDATA || path.join(homedir, 'AppData/Local'),
      `Programs/heroic/resources/app.asar.unpacked/build/bin/x64/win32/${baseName}.exe`
    ),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found && process.platform !== 'win32') {
    try {
      const st = fs.statSync(found);
      if (st.isFile() && (st.mode & 0o111) === 0) {
        fs.chmodSync(found, 0o755);
      }
    } catch {}
    if (process.platform === 'darwin' && !quarantineClearedBinaries.has(found)) {
      quarantineClearedBinaries.add(found);
      try {
        execFileSync('xattr', ['-dr', 'com.apple.quarantine', found], {
          stdio: 'ignore',
          timeout: 1500,
        });
      } catch {}
    }
  }
  return found;
}

function findLegendaryBinary(options = {}) {
  return findBundledOrSystemCliBinary('legendary', options);
}

function findGogdlBinary(options = {}) {
  return findBundledOrSystemCliBinary('gogdl', options);
}

function isTestEnvironment(options = {}) {
  return Boolean(
    options?.homedir ||
      options?.userDataDir ||
      process.env.VITEST ||
      process.env.NODE_ENV === 'test'
  );
}

function isMockOrCorruptedToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return false;
  return /^(epic-rotated|gog-rotated|freshly-renewed|mock-|test-|fake-)/i.test(tokenStr.trim());
}

function isPoisonedStorefrontToken(tokenStr, options = {}) {
  if (!tokenStr || typeof tokenStr !== 'string') return false;
  const trimmed = tokenStr.trim();
  if (/^(epic-rotated|gog-rotated)/i.test(trimmed)) {
    return true;
  }
  const hasExplicitTestSandbox = Boolean(
    options?.homedir || options?.userDataDir || options?.savedTokens
  );
  if (
    options?.sanitizeMockTokens === true ||
    (!isTestEnvironment(options) && !hasExplicitTestSandbox) ||
    (!options?.homedir && !options?.userDataDir && !options?.savedTokens)
  ) {
    return isMockOrCorruptedToken(trimmed);
  }
  return false;
}

function resolveIsolatedHomedirAndUserData(options = {}) {
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  const defaultHome = isVitest
    ? path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`)
    : os.homedir();

  if (options?.homedir || options?.userDataDir || configuredUserDataDir) {
    const homedir = options.homedir || defaultHome;
    const fallbackUserData =
      options.userDataDir ||
      (options.homedir ? path.join(options.homedir, '.one-launcher') : undefined);
    const userDataDir = getUserDataDir(fallbackUserData);
    return { homedir, userDataDir };
  }
  if (isVitest) {
    const isolatedUserData = path.join(defaultHome, '.one-launcher');
    try {
      if (!fs.existsSync(isolatedUserData)) {
        fs.mkdirSync(isolatedUserData, { recursive: true });
      }
    } catch {}
    return { homedir: defaultHome, userDataDir: isolatedUserData };
  }
  return {
    homedir: os.homedir(),
    userDataDir: getUserDataDir(options?.userDataDir),
  };
}

function getLegendaryConfigDir(options = {}) {
  const customCfgDir =
    options && typeof options === 'object'
      ? options.legendaryConfigDir || options.legendaryConfigPath
      : null;
  if (typeof customCfgDir === 'string' && customCfgDir.trim()) {
    return customCfgDir.trim();
  }
  const { userDataDir } = resolveIsolatedHomedirAndUserData(options);
  return path.join(userDataDir, 'legendaryConfig', 'legendary');
}

function sanitizeEpicCandidateRecord(rawRecord, options = {}) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const copy = { ...rawRecord };
  let poisoned = false;
  if (isPoisonedStorefrontToken(copy.access_token, options)) {
    delete copy.access_token;
    poisoned = true;
  }
  if (isPoisonedStorefrontToken(copy.refresh_token, options)) {
    delete copy.refresh_token;
    poisoned = true;
  }
  if (
    (copy.account_id === 'epic-user-1' || isPoisonedStorefrontToken(copy.account_id, options)) &&
    typeof copy.in_app_id === 'string' &&
    /^[0-9a-f]{32}$/i.test(copy.in_app_id.trim())
  ) {
    copy.account_id = copy.in_app_id.trim();
  }
  return {
    record: copy.access_token || copy.refresh_token ? copy : null,
    meta: copy,
    poisoned,
  };
}

/**
 * Ensure Legendary config directory and Epic OAuth user.json are populated
 */
async function ensureLegendaryConfigAndAuth(options = {}) {
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const legendaryConfigPath = getLegendaryConfigDir(options);
  const userFilePath = path.join(legendaryConfigPath, 'user.json');
  const activeStoreSync = options.storeSync || storeSync;

  try {
    if (!fs.existsSync(legendaryConfigPath)) {
      fs.mkdirSync(legendaryConfigPath, { recursive: true });
    }
  } catch {}

  const candidateHeroicDirs = [
    path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'heroic',
      'legendaryConfig',
      'legendary'
    ),
    path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary'),
    path.join(homedir, '.config/legendary'),
  ];

  // Copy non-credential metadata files; never blindly copy a potentially poisoned user.json
  for (const srcDir of candidateHeroicDirs) {
    if (!fs.existsSync(srcDir)) continue;
    for (const fileName of ['assets.json', 'installed.json', 'aliases.json']) {
      const srcFile = path.join(srcDir, fileName);
      const dstFile = path.join(legendaryConfigPath, fileName);
      if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
        try {
          fs.copyFileSync(srcFile, dstFile);
          if (fileName === 'installed.json') {
            const parsedExt = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
            const extEntries = Array.isArray(parsedExt)
              ? parsedExt
              : parsedExt && typeof parsedExt === 'object'
                ? Object.entries(parsedExt).map(([k, v]) =>
                    v && typeof v === 'object' ? { app_name: k, ...v } : null
                  )
                : [];
            for (const item of extEntries) {
              if (!item || typeof item !== 'object') continue;
              const extAppName = String(item.app_name || item.appName || '').trim();
              const extInstallPath = String(item.install_path || item.installPath || '').trim();
              if (extAppName || extInstallPath) {
                recordImportedEpicInstall(
                  { appName: extAppName, installPath: extInstallPath, source: srcDir },
                  options
                );
              }
            }
          }
        } catch (copyMetaErr) {
          diagLog.debug('ensureLegendaryConfigAndAuth.copyMetadata', copyMetaErr, { srcFile });
        }
      }
    }
  }

  const epicTombstoned =
    isStoreDisconnectedTombstoned('epic', options) &&
    !options.savedTokens?.epic &&
    !options.allowInteractiveAuth;
  if (epicTombstoned) {
    try {
      if (fs.existsSync(userFilePath)) {
        fs.unlinkSync(userFilePath);
      }
    } catch {}
    return {
      legendaryConfigPath,
      configDir: legendaryConfigPath,
      userFilePath,
      authenticated: false,
      disconnectedByUser: true,
      recoveredSession: false,
      accessToken: null,
      refreshToken: null,
      accountId: null,
      displayName: null,
      env: {
        ...process.env,
        LEGENDARY_CONFIG_PATH: legendaryConfigPath,
        LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
        LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
      },
    };
  }

  const hasExplicitSavedTokens = Boolean(options.savedTokens);
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens(options)
      : {});

  const candidateRecords = [];
  let fallbackAccountMeta = null;

  if (savedTokens && savedTokens.epic && typeof savedTokens.epic === 'object') {
    const sanitized = sanitizeEpicCandidateRecord(savedTokens.epic, options);
    if (sanitized) {
      fallbackAccountMeta = fallbackAccountMeta || sanitized.meta;
      if (sanitized.record) {
        candidateRecords.push({ source: 'savedTokens', data: sanitized.record });
      }
    }
  }

  const candidateUserJsonPaths = [
    userFilePath,
    path.join(homedir, '.config/legendary/user.json'),
    path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/user.json'),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'heroic',
      'legendaryConfig',
      'legendary',
      'user.json'
    ),
    path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'user.json'),
  ];

  for (const candFile of candidateUserJsonPaths) {
    if (!fs.existsSync(candFile)) continue;
    try {
      const parsedUser = JSON.parse(fs.readFileSync(candFile, 'utf8'));
      const sanitized = sanitizeEpicCandidateRecord(parsedUser, options);
      if (sanitized) {
        fallbackAccountMeta = fallbackAccountMeta || sanitized.meta;
        if (sanitized.poisoned) {
          // Remove poisoned user.json from disk if it's in our managed or default legendary path
          if (
            path.resolve(candFile) === path.resolve(userFilePath) ||
            path.resolve(candFile) === path.resolve(path.join(homedir, '.config/legendary/user.json'))
          ) {
            try {
              fs.unlinkSync(candFile);
            } catch {}
          }
        }
        if (sanitized.record) {
          candidateRecords.push({
            source: candFile,
            isExternal: path.resolve(candFile) !== path.resolve(userFilePath),
            data: sanitized.record,
          });
        }
      }
    } catch {}
  }

  let epicTokenData = null;
  let epicTokenFromExternal = false;
  let recoveredSession = false;
  const triedRefreshTokens = new Set();

  for (const { data: cand, isExternal } of candidateRecords) {
    const expiresAtMs = cand.expires_at ? new Date(cand.expires_at).getTime() : 0;
    const isExpiringSoon =
      Boolean(options.forceTokenRefresh) ||
      !cand.access_token ||
      !expiresAtMs ||
      Number.isNaN(expiresAtMs) ||
      expiresAtMs - Date.now() < 10 * 60 * 1000;

    if (!isExpiringSoon && cand.access_token) {
      epicTokenData = { ...cand };
      epicTokenFromExternal = Boolean(isExternal);
      break;
    }

    if (options.skipNetwork) {
      if (cand.access_token && !options.forceTokenRefresh) {
        epicTokenData = { ...cand };
        epicTokenFromExternal = Boolean(isExternal);
        break;
      }
      continue;
    }

    if (
      cand.refresh_token &&
      !triedRefreshTokens.has(cand.refresh_token) &&
      activeStoreSync &&
      typeof activeStoreSync.renewEpicTokens === 'function'
    ) {
      triedRefreshTokens.add(cand.refresh_token);
      try {
        const renewed = await activeStoreSync.renewEpicTokens(cand.refresh_token);
        if (
          renewed &&
          renewed.access_token &&
          !isPoisonedStorefrontToken(renewed.access_token, options)
        ) {
          epicTokenData = {
            ...cand,
            ...renewed,
          };
          epicTokenFromExternal = Boolean(isExternal);
          if (typeof activeStoreSync.saveTokens === 'function') {
            try {
              activeStoreSync.saveTokens(
                'epic',
                epicTokenData,
                isExternal ? { ...options, fromExternalFallback: true } : options
              );
            } catch {}
          }
          break;
        }
      } catch {
        // Renewal failed for this candidate's refresh_token — do NOT write this dead token to user.json;
        // continue checking remaining candidate user.json sources.
      }
    } else if (
      !cand.refresh_token &&
      cand.access_token &&
      !options.forceTokenRefresh &&
      (!cand.expires_at || expiresAtMs > Date.now())
    ) {
      epicTokenData = { ...cand };
      epicTokenFromExternal = Boolean(isExternal);
      break;
    }
  }

  // Fallback to Epic session recovery hook (silent cookie refresh / interactive login) if all local tokens failed
  if ((!epicTokenData || !epicTokenData.access_token) && !options.skipNetwork) {
    const recoveryFn =
      typeof options.recoverEpicAuthFn === 'function'
        ? options.recoverEpicAuthFn
        : epicAuthRecoveryHook;
    if (typeof recoveryFn === 'function') {
      try {
        const recovered = await recoveryFn({
          allowInteractiveAuth: Boolean(options.allowInteractiveAuth),
          forceTokenRefresh: Boolean(options.forceTokenRefresh),
          options,
        });
        if (
          recovered &&
          recovered.access_token &&
          !isPoisonedStorefrontToken(recovered.access_token, options)
        ) {
          epicTokenData = {
            ...(fallbackAccountMeta || {}),
            ...recovered,
          };
          recoveredSession = true;
          if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
            try {
              activeStoreSync.saveTokens(
                'epic',
                epicTokenData,
                options.allowInteractiveAuth
                  ? options
                  : { ...options, fromExternalFallback: true }
              );
            } catch {}
          }
        }
      } catch {}
    }
  }

  if (epicTokenData && epicTokenData.access_token) {
    const resolvedAccountId =
      epicTokenData.account_id &&
      epicTokenData.account_id !== 'epic-user-1' &&
      !isPoisonedStorefrontToken(epicTokenData.account_id, options)
        ? epicTokenData.account_id
        : epicTokenData.in_app_id || epicTokenData.account_id || '';

    const userJsonPayload = {
      access_token: epicTokenData.access_token,
      expires_in: epicTokenData.expires_in || 7200,
      expires_at: epicTokenData.expires_at || new Date(Date.now() + 7200 * 1000).toISOString(),
      token_type: epicTokenData.token_type || 'bearer',
      refresh_token: epicTokenData.refresh_token || '',
      refresh_expires: epicTokenData.refresh_expires || 28800,
      refresh_expires_at:
        epicTokenData.refresh_expires_at || new Date(Date.now() + 28800 * 1000).toISOString(),
      account_id: resolvedAccountId,
      client_id: epicTokenData.client_id || '34a02cf8f4414e29b15921876da36f9a',
      internal_client: true,
      client_service: 'launcher',
      displayName: epicTokenData.displayName || resolvedAccountId || 'Player',
      app: 'launcher',
      in_app_id: epicTokenData.in_app_id || resolvedAccountId || '',
    };

    try {
      atomicWriteSecureFileSync(userFilePath, JSON.stringify(userJsonPayload, null, 2), options);
    } catch (writeErr) {
      diagLog.warn('ensureLegendaryConfigAndAuth.writeSecureUserJson', writeErr, { userFilePath });
    }

    if (
      !hasExplicitSavedTokens &&
      !isMockOrCorruptedToken(epicTokenData.access_token) &&
      activeStoreSync &&
      typeof activeStoreSync.saveTokens === 'function' &&
      savedTokens?.epic?.access_token !== epicTokenData.access_token
    ) {
      try {
        activeStoreSync.saveTokens(
          'epic',
          {
            ...(savedTokens?.epic || {}),
            ...epicTokenData,
            access_token: epicTokenData.access_token,
            refresh_token:
              epicTokenData.refresh_token || savedTokens?.epic?.refresh_token || undefined,
            account_id: resolvedAccountId || savedTokens?.epic?.account_id,
            displayName: userJsonPayload.displayName || savedTokens?.epic?.displayName,
          },
          epicTokenFromExternal ? { ...options, fromExternalFallback: true } : options
        );
      } catch {}
    }

    return {
      legendaryConfigPath,
      configDir: legendaryConfigPath,
      userFilePath,
      authenticated: true,
      recoveredSession,
      accessToken: epicTokenData.access_token,
      refreshToken: epicTokenData.refresh_token || null,
      accountId: resolvedAccountId || null,
      displayName: userJsonPayload.displayName || null,
      env: {
        ...process.env,
        LEGENDARY_CONFIG_PATH: legendaryConfigPath,
        LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
        LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
      },
    };
  }

  // No valid token could be obtained: ensure no stale or invalid user.json remains on disk
  try {
    if (fs.existsSync(userFilePath)) {
      fs.unlinkSync(userFilePath);
    }
  } catch {}

  return {
    legendaryConfigPath,
    configDir: legendaryConfigPath,
    userFilePath,
    authenticated: false,
    recoveredSession: false,
    accessToken: null,
    refreshToken: null,
    accountId: fallbackAccountMeta?.account_id || null,
    displayName: fallbackAccountMeta?.displayName || null,
    env: {
      ...process.env,
      LEGENDARY_CONFIG_PATH: legendaryConfigPath,
      LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
      LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
    },
  };
}

/**
 * Ensure gogdl auth.json is populated with GOG OAuth credentials
 */
async function ensureGogdlAuthConfig(options = {}) {
  const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);
  const gogAuthPath = options.gogAuthPath || path.join(userDataDir, 'gog_store', 'auth.json');

  try {
    const dir = path.dirname(gogAuthPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}

  const gogTombstoned =
    isStoreDisconnectedTombstoned('gog', options) &&
    !options.savedTokens?.gog &&
    !options.gogAccessToken;
  if (gogTombstoned) {
    try {
      if (fs.existsSync(gogAuthPath)) {
        fs.unlinkSync(gogAuthPath);
      }
    } catch {}
    return {
      gogAuthPath,
      configPath: gogAuthPath,
      authenticated: false,
      disconnectedByUser: true,
      accessToken: undefined,
      refreshToken: null,
      userId: null,
    };
  }

  const sanitizeGogEntry = (rawEntry, isFromDiskOrUntrusted = false) => {
    if (!rawEntry || typeof rawEntry !== 'object') return null;
    const copy = { ...rawEntry };
    const rawUid = String(copy.user_id || copy.userId || '').trim();
    if (
      isFromDiskOrUntrusted &&
      (isMockOrCorruptedToken(copy.access_token) ||
        isMockOrCorruptedToken(copy.refresh_token) ||
        rawUid === 'gog-user-1' ||
        rawUid === 'gog-user-777')
    ) {
      return null;
    }
    if (isPoisonedStorefrontToken(copy.access_token, options)) {
      delete copy.access_token;
    }
    if (isPoisonedStorefrontToken(copy.refresh_token, options)) {
      delete copy.refresh_token;
    }
    if (!copy.access_token && !copy.refresh_token) return null;
    return copy;
  };

  let existingClientAuth = null;
  if (fs.existsSync(gogAuthPath)) {
    try {
      const parsedAuth = JSON.parse(fs.readFileSync(gogAuthPath, 'utf8'));
      const rawClient = parsedAuth?.['46899977096215655'] || null;
      existingClientAuth = sanitizeGogEntry(rawClient, true);
      if (rawClient && !existingClientAuth) {
        try {
          fs.unlinkSync(gogAuthPath);
        } catch {}
      }
    } catch {}
  }

  const candidateHeroicGogAuthPaths = [
    path.join(homedir, 'Library/Application Support/heroic/gog_store/auth.json'),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'heroic',
      'gog_store',
      'auth.json'
    ),
    path.join(homedir, 'AppData', 'Roaming', 'heroic', 'gog_store', 'auth.json'),
    path.join(homedir, '.config/heroic/gog_store/auth.json'),
  ];

  const externalHeroicGogCandidates = [];
  for (const hcPath of candidateHeroicGogAuthPaths) {
    if (!fs.existsSync(hcPath)) continue;
    try {
      const parsedHc = JSON.parse(fs.readFileSync(hcPath, 'utf8'));
      const cleanedHc = sanitizeGogEntry(parsedHc?.['46899977096215655'] || parsedHc, true);
      if (cleanedHc) {
        externalHeroicGogCandidates.push(cleanedHc);
      }
    } catch {}
  }

  const activeStoreSync = options.storeSync || storeSync;
  const hasExplicitSavedTokens = Boolean(options.savedTokens);
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens(options)
      : {});

  const sanitizedSavedGog = savedTokens?.gog
    ? sanitizeGogEntry(savedTokens.gog, !hasExplicitSavedTokens)
    : null;
  const sanitizedOptionGog =
    options.gogAccessToken && !isPoisonedStorefrontToken(options.gogAccessToken, options)
      ? { access_token: options.gogAccessToken }
      : null;

  let gogData = sanitizedSavedGog || sanitizedOptionGog || existingClientAuth || null;
  let loadedFromHeroicFallback = false;

  if (!gogData || (!gogData.access_token && !gogData.refresh_token)) {
    if (externalHeroicGogCandidates.length > 0) {
      gogData = { ...externalHeroicGogCandidates[0] };
      loadedFromHeroicFallback = true;
    }
  }

  if (!options.skipNetwork && activeStoreSync && typeof activeStoreSync.renewGogTokens === 'function') {
    const updatedAtMs = gogData?.updatedAt
      ? new Date(gogData.updatedAt).getTime()
      : gogData?.loginTime
        ? Number(gogData.loginTime) * 1000
        : 0;
    const maxAgeMs = ((gogData?.expires_in || 3600) - 600) * 1000;
    const needsRefresh =
      Boolean(options.forceTokenRefresh) ||
      !gogData?.access_token ||
      !updatedAtMs ||
      Number.isNaN(updatedAtMs) ||
      Date.now() - updatedAtMs > maxAgeMs;

    if (needsRefresh) {
      const refreshQueue = [];
      if (gogData?.refresh_token) refreshQueue.push({ cand: gogData, isExternal: loadedFromHeroicFallback });
      for (const extCand of externalHeroicGogCandidates) {
        if (
          extCand.refresh_token &&
          !refreshQueue.some((item) => item.cand.refresh_token === extCand.refresh_token)
        ) {
          refreshQueue.push({ cand: extCand, isExternal: true });
        }
      }

      let renewedSuccess = false;
      for (const { cand, isExternal } of refreshQueue) {
        try {
          const renewed = await activeStoreSync.renewGogTokens(cand.refresh_token);
          if (
            renewed &&
            renewed.access_token &&
            !isPoisonedStorefrontToken(renewed.access_token, options)
          ) {
            gogData = {
              ...(gogData || {}),
              ...cand,
              ...renewed,
              updatedAt: renewed.updatedAt || new Date().toISOString(),
            };
            if (typeof activeStoreSync.saveTokens === 'function') {
              try {
                activeStoreSync.saveTokens(
                  'gog',
                  gogData,
                  isExternal ? { ...options, fromExternalFallback: true } : options
                );
              } catch {}
            }
            renewedSuccess = true;
            break;
          }
        } catch {}
      }

      if (!renewedSuccess && (!gogData || !gogData.access_token)) {
        const fallbackWithAccess = externalHeroicGogCandidates.find((c) => c.access_token);
        if (fallbackWithAccess) {
          gogData = { ...fallbackWithAccess };
          loadedFromHeroicFallback = true;
        }
      }
    }
  }

  if (
    loadedFromHeroicFallback &&
    gogData?.access_token &&
    activeStoreSync &&
    typeof activeStoreSync.saveTokens === 'function'
  ) {
    try {
      activeStoreSync.saveTokens('gog', gogData, { ...options, fromExternalFallback: true });
    } catch {}
  }

  if (gogData && gogData.access_token) {
    const updatedAtMs = gogData.updatedAt ? new Date(gogData.updatedAt).getTime() : 0;
    const loginTimeSec =
      updatedAtMs && !Number.isNaN(updatedAtMs)
        ? Math.floor(updatedAtMs / 1000)
        : gogData.loginTime || existingClientAuth?.loginTime || Math.floor(Date.now() / 1000);

    const authPayload = {
      '46899977096215655': {
        access_token: gogData.access_token,
        refresh_token: gogData.refresh_token || '',
        user_id: gogData.user_id || gogData.userId || '',
        expires_in: gogData.expires_in || 3600,
        loginTime: loginTimeSec,
      },
    };
    try {
      atomicWriteSecureFileSync(gogAuthPath, JSON.stringify(authPayload, null, 2), options);
    } catch (writeErr) {
      diagLog.warn('ensureGogdlAuthConfig.writeSecureAuthJson', writeErr, { gogAuthPath });
    }
  }

  return {
    gogAuthPath,
    configPath: gogAuthPath,
    authenticated: Boolean(gogData?.access_token),
    accessToken: gogData?.access_token,
    refreshToken: gogData?.refresh_token || null,
    userId: gogData?.user_id || gogData?.userId || existingClientAuth?.user_id || null,
  };
}

/**
 * Scan and cache local Legendary assets.json, aliases.json, and metadata/*.json
 * to resolve per-game Epic macOS and Windows build availability with <1ms cached lookups.
 */
function collectLocalEpicMetadataAndSupport(options = {}) {
  const homedir = options.homedir || os.homedir();
  const userDataDir = getUserDataDir(options.userDataDir);
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const configDirs = Array.from(
    new Set([
      path.join(userDataDir, 'legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/one-launcher/legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
      path.join(
        process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
        'heroic',
        'legendaryConfig',
        'legendary'
      ),
      path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary'),
      path.join(homedir, '.config/legendary'),
      ...customRoots.map((r) => toLocalFsPath(r, customRoots)),
      ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'legendary')),
      ...customRoots.map((r) =>
        path.join(toLocalFsPath(r, customRoots), 'heroic/legendaryConfig/legendary')
      ),
    ])
  );

  const winAssets = [];
  const macAssets = [];
  const aliasToAppName = new Map();
  const metaSummaries = [];
  const seenMetaAppNames = new Set();

  for (const dir of configDirs) {
    if (!dir || !fs.existsSync(dir)) continue;

    const aliasesFile = path.join(dir, 'aliases.json');
    if (fs.existsSync(aliasesFile)) {
      try {
        const st = fs.statSync(aliasesFile);
        const mtimeMs = st.mtimeMs || 0;
        const size = st.size || 0;
        const cachedAliases = legendaryAliasesFileCache.get(aliasesFile);
        let aliasEntries = null;
        if (
          cachedAliases &&
          cachedAliases.mtimeMs === mtimeMs &&
          cachedAliases.size === size &&
          Array.isArray(cachedAliases.entries)
        ) {
          aliasEntries = cachedAliases.entries;
        } else {
          aliasEntries = [];
          const aliasesObj = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
          if (aliasesObj && typeof aliasesObj === 'object') {
            for (const [appNameKey, list] of Object.entries(aliasesObj)) {
              if (!Array.isArray(list)) continue;
              for (const alias of list) {
                const n = norm(alias);
                if (n) {
                  aliasEntries.push([n, appNameKey]);
                }
              }
            }
          }
          setBoundedMapEntry(
            legendaryAliasesFileCache,
            aliasesFile,
            { mtimeMs, size, entries: aliasEntries },
            MAX_LEGENDARY_CACHE_DIRS
          );
        }
        for (const [n, appNameKey] of aliasEntries) {
          if (!aliasToAppName.has(n)) {
            aliasToAppName.set(n, appNameKey);
          }
        }
      } catch {}
    }

    const assetsFile = path.join(dir, 'assets.json');
    if (fs.existsSync(assetsFile)) {
      try {
        const st = fs.statSync(assetsFile);
        const mtimeMs = st.mtimeMs || 0;
        const size = st.size || 0;
        const cachedAssets = legendaryAssetsFileCache.get(assetsFile);
        let fileWinAssets = null;
        let fileMacAssets = null;
        if (
          cachedAssets &&
          cachedAssets.mtimeMs === mtimeMs &&
          cachedAssets.size === size &&
          Array.isArray(cachedAssets.winAssets) &&
          Array.isArray(cachedAssets.macAssets)
        ) {
          fileWinAssets = cachedAssets.winAssets;
          fileMacAssets = cachedAssets.macAssets;
        } else {
          fileWinAssets = [];
          fileMacAssets = [];
          const parsed = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (!item || typeof item !== 'object') continue;
              const hasMacInfo =
                String(item.platform || '').toLowerCase() === 'mac' ||
                Boolean(
                  item.asset_infos &&
                    item.asset_infos.Mac &&
                    Object.keys(item.asset_infos.Mac).length > 0
                );
              const hasWinInfo =
                String(item.platform || '').toLowerCase() === 'windows' ||
                Boolean(
                  item.asset_infos &&
                    item.asset_infos.Windows &&
                    Object.keys(item.asset_infos.Windows).length > 0
                ) ||
                (!item.platform && !item.asset_infos);

              if (hasMacInfo) fileMacAssets.push(item);
              if (hasWinInfo) fileWinAssets.push(item);
            }
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.Windows)) {
              fileWinAssets.push(...parsed.Windows);
            }
            if (Array.isArray(parsed.Mac)) {
              fileMacAssets.push(...parsed.Mac);
            }
          }
          setBoundedMapEntry(
            legendaryAssetsFileCache,
            assetsFile,
            { mtimeMs, size, winAssets: fileWinAssets, macAssets: fileMacAssets },
            MAX_LEGENDARY_CACHE_DIRS
          );
        }
        winAssets.push(...fileWinAssets);
        macAssets.push(...fileMacAssets);
      } catch {}
    }

    const metaDir = path.join(dir, 'metadata');
    if (fs.existsSync(metaDir)) {
      try {
        const st = fs.statSync(metaDir);
        const mtimeMs = st.mtimeMs || 0;
        const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
        const fileCount = files.length;
        const cachedMeta = legendaryMetadataDirCache.get(metaDir);
        let dirSummaries = null;
        if (
          cachedMeta &&
          cachedMeta.mtimeMs === mtimeMs &&
          cachedMeta.fileCount === fileCount &&
          Array.isArray(cachedMeta.summaries)
        ) {
          dirSummaries = cachedMeta.summaries;
        } else {
          dirSummaries = [];
          for (const f of files) {
            try {
              const json = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8'));
              if (!json || typeof json !== 'object') continue;
              const appName = String(json.app_name || f.replace(/\.json$/i, '')).trim();
              if (!appName) continue;
              const catalogItemId = String(
                json.catalog_item_id || json.id || json.metadata?.id || ''
              ).trim();
              const namespace = String(json.namespace || json.metadata?.namespace || '').trim();
              const deploymentId =
                String(
                  json.sidecar?.config?.deploymentId ||
                    json.metadata?.customAttributes?.DeploymentId?.value ||
                    ''
                ).trim() || undefined;
              const appTitle = String(json.app_title || json.metadata?.title || '').trim();
              const normTitle = norm(appTitle);
              const hasMacAsset = Boolean(
                json.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0
              );
              const hasWinAsset = Boolean(
                json.asset_infos?.Windows && Object.keys(json.asset_infos.Windows).length > 0
              );
              const releaseInfo = json.metadata?.releaseInfo || json.releaseInfo;
              const hasMacRelease =
                Array.isArray(releaseInfo) &&
                releaseInfo.some(
                  (r) =>
                    r &&
                    Array.isArray(r.platform) &&
                    r.platform.some((p) => /^mac$/i.test(String(p)))
                );
              const hasWinRelease =
                Array.isArray(releaseInfo) &&
                releaseInfo.some(
                  (r) =>
                    r &&
                    Array.isArray(r.platform) &&
                    r.platform.some((p) => /^(windows|win32)$/i.test(String(p)))
                );
              const hasMac = hasMacAsset || hasMacRelease;
              const hasWin = hasWinAsset || hasWinRelease || !hasMac;
              dirSummaries.push({
                appName,
                catalogItemId,
                namespace,
                deploymentId,
                appTitle,
                normTitle,
                hasMac,
                hasWin,
                macVersion: json.asset_infos?.Mac?.build_version || undefined,
                winVersion: json.asset_infos?.Windows?.build_version || undefined,
              });
            } catch {}
          }
          setBoundedMapEntry(
            legendaryMetadataDirCache,
            metaDir,
            {
              mtimeMs,
              fileCount,
              summaries: dirSummaries,
            },
            MAX_LEGENDARY_CACHE_DIRS
          );
        }
        for (const s of dirSummaries) {
          const key = s.appName.toLowerCase();
          if (!seenMetaAppNames.has(key)) {
            seenMetaAppNames.add(key);
            metaSummaries.push({ ...s });
          } else {
            const existing = metaSummaries.find((m) => m.appName.toLowerCase() === key);
            if (existing) {
              if (!existing.deploymentId && s.deploymentId) existing.deploymentId = s.deploymentId;
              if (!existing.namespace && s.namespace) existing.namespace = s.namespace;
              if (!existing.catalogItemId && s.catalogItemId) {
                existing.catalogItemId = s.catalogItemId;
              }
            }
          }
        }
      } catch {}
    }
  }

  const epicPlatformSupport = {};
  const mergeSupport = (rawKey, win, mac) => {
    const k = String(rawKey || '').toLowerCase().trim();
    if (!k) return;
    const prev = epicPlatformSupport[k] || { windows: false, mac: false };
    epicPlatformSupport[k] = {
      windows: Boolean(prev.windows || win),
      mac: Boolean(prev.mac || mac),
    };
  };

  for (const item of winAssets) {
    if (!item || typeof item !== 'object') continue;
    mergeSupport(item.app_name || item.appName, true, false);
    mergeSupport(item.catalog_item_id || item.catalogItemId, true, false);
    if (item.app_title || item.title) {
      mergeSupport(norm(item.app_title || item.title), true, false);
    }
  }
  for (const item of macAssets) {
    if (!item || typeof item !== 'object') continue;
    mergeSupport(item.app_name || item.appName, false, true);
    mergeSupport(item.catalog_item_id || item.catalogItemId, false, true);
    if (item.app_title || item.title) {
      mergeSupport(norm(item.app_title || item.title), false, true);
    }
  }
  for (const s of metaSummaries) {
    const existingByApp = epicPlatformSupport[s.appName.toLowerCase()];
    const hasWin = Boolean(s.hasWin || existingByApp?.windows);
    const hasMac = Boolean(s.hasMac || existingByApp?.mac);
    mergeSupport(s.appName, hasWin, hasMac);
    mergeSupport(s.catalogItemId, hasWin, hasMac);
    if (s.normTitle) {
      mergeSupport(s.normTitle, hasWin, hasMac);
    }
    if (s.appTitle) {
      mergeSupport(s.appTitle, hasWin, hasMac);
    }
  }

  return {
    configDirs,
    winAssets,
    macAssets,
    aliasToAppName,
    metaSummaries,
    epicPlatformSupport,
  };
}

/**
 * Resolve Epic Games app_name and native macOS vs Windows build availability
 */
function resolveEpicAppAndPlatforms(payload = {}, options = {}) {
  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^epic-/i, '')
    .trim();
  const title = String(payload.title || '').trim();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTitle = norm(title);
  const normCleanId = norm(cleanId);

  const { configDirs, winAssets, macAssets, aliasToAppName, metaSummaries } =
    collectLocalEpicMetadataAndSupport(options);

  const matchesEntry = (entry, targetAppName) => {
    if (!entry || typeof entry !== 'object') return false;
    if (targetAppName && entry.app_name === targetAppName) return true;
    if (cleanId) {
      if (
        entry.app_name === cleanId ||
        entry.catalog_item_id === cleanId ||
        entry.asset_id === cleanId ||
        entry.namespace === cleanId ||
        entry.asset_infos?.Windows?.build_id === cleanId ||
        entry.asset_infos?.Mac?.build_id === cleanId
      ) {
        return true;
      }
    }
    if (normTitle && entry.app_title && norm(entry.app_title) === normTitle) {
      return true;
    }
    return false;
  };

  const matchesMetaSummary = (s, targetAppName) => {
    if (!s) return false;
    if (targetAppName && s.appName.toLowerCase() === String(targetAppName).toLowerCase()) {
      return true;
    }
    if (cleanId) {
      const cleanLower = cleanId.toLowerCase();
      if (
        s.appName.toLowerCase() === cleanLower ||
        (s.catalogItemId && s.catalogItemId.toLowerCase() === cleanLower) ||
        (s.namespace && s.namespace.toLowerCase() === cleanLower)
      ) {
        return true;
      }
    }
    if (normTitle && s.normTitle && s.normTitle === normTitle) {
      return true;
    }
    return false;
  };

  let resolvedAppName = '';

  // 1. Direct match in assets.json
  const directWin = winAssets.find((e) => matchesEntry(e, ''));
  const directMac = macAssets.find((e) => matchesEntry(e, ''));
  if (directMac && directMac.app_name) {
    resolvedAppName = directMac.app_name;
  } else if (directWin && directWin.app_name) {
    resolvedAppName = directWin.app_name;
  }

  // 2. Match in metadata/*.json summaries (by app_name, catalog_item_id, namespace, or normalized app_title)
  const matchedMeta = metaSummaries.find((s) => matchesMetaSummary(s, resolvedAppName));
  if (!resolvedAppName && matchedMeta && matchedMeta.appName) {
    resolvedAppName = matchedMeta.appName;
  }

  // 3. Fallback to aliases.json match by title or cleanId
  if (!resolvedAppName) {
    if (normTitle && aliasToAppName.has(normTitle)) {
      resolvedAppName = aliasToAppName.get(normTitle);
    } else if (normCleanId && aliasToAppName.has(normCleanId)) {
      resolvedAppName = aliasToAppName.get(normCleanId);
    }
  }

  if (!resolvedAppName) {
    resolvedAppName = cleanId;
  }

  const macEntry = macAssets.find((e) => matchesEntry(e, resolvedAppName));
  const winEntry = winAssets.find((e) => matchesEntry(e, resolvedAppName));
  const metaSummary =
    matchedMeta || metaSummaries.find((s) => matchesMetaSummary(s, resolvedAppName)) || null;

  const foundInLocal = Boolean(macEntry || winEntry || metaSummary);
  const hasMacBuild = foundInLocal
    ? Boolean(macEntry) || Boolean(metaSummary?.hasMac)
    : Boolean(payload.storePlatforms?.mac === true);
  const hasWindowsBuild = foundInLocal
    ? Boolean(winEntry) || Boolean(metaSummary?.hasWin) || !hasMacBuild
    : payload.storePlatforms?.windows !== undefined
      ? Boolean(payload.storePlatforms.windows)
      : true;

  const macVersion =
    macEntry?.build_version ||
    macEntry?.asset_infos?.Mac?.build_version ||
    metaSummary?.macVersion ||
    undefined;
  const winVersion =
    winEntry?.build_version ||
    winEntry?.asset_infos?.Windows?.build_version ||
    metaSummary?.winVersion ||
    undefined;

  let namespace = macEntry?.namespace || winEntry?.namespace || metaSummary?.namespace;
  let catalogItemId =
    macEntry?.catalog_item_id || winEntry?.catalog_item_id || metaSummary?.catalogItemId;
  let deploymentId = metaSummary?.deploymentId;

  if ((!namespace || !catalogItemId || !deploymentId) && resolvedAppName) {
    for (const dir of configDirs) {
      if (!dir) continue;
      const metaFile = path.join(dir, 'metadata', `${resolvedAppName}.json`);
      if (fs.existsSync(metaFile)) {
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          namespace = namespace || metaJson?.namespace || metaJson?.metadata?.namespace;
          catalogItemId =
            catalogItemId ||
            metaJson?.catalog_item_id ||
            metaJson?.id ||
            metaJson?.metadata?.id;
          deploymentId =
            deploymentId ||
            String(
              metaJson?.sidecar?.config?.deploymentId ||
                metaJson?.metadata?.customAttributes?.DeploymentId?.value ||
                ''
            ).trim() ||
            undefined;
          if (namespace && catalogItemId && deploymentId) break;
        } catch {}
      }
    }
  }

  return {
    resolvedAppName,
    appName: resolvedAppName,
    hasMacBuild,
    hasWindowsBuild,
    macVersion,
    winVersion,
    namespace,
    catalogItemId,
    deploymentId,
  };
}

/**
 * Helper to perform an HTTPS JSON request using options.fetchFn, global.fetch, or node:https fallback
 */
async function performJsonHttpRequest(url, reqOptions = {}, fetchFn = null) {
  const fetchImpl = fetchFn || (typeof global !== 'undefined' ? global.fetch : null);
  const timeoutMs = Number(reqOptions.timeoutMs || 3500);
  if (typeof fetchImpl === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(url, {
        method: reqOptions.method || 'GET',
        headers: reqOptions.headers || {},
        ...(reqOptions.body !== undefined ? { body: reqOptions.body } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const status = Number(response?.status || (response?.ok ? 200 : 500));
      const ok = Boolean(response?.ok ?? (status >= 200 && status < 300));
      let data = null;
      if (typeof response?.json === 'function') {
        try {
          data = await response.json();
        } catch {}
      } else if (typeof response?.text === 'function') {
        try {
          const txt = await response.text();
          data = txt ? JSON.parse(txt) : null;
        } catch {}
      }
      return { ok, status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'http:' ? http : https;
      const req = client.request(
        parsedUrl,
        {
          method: reqOptions.method || 'GET',
          headers: reqOptions.headers || {},
          timeout: timeoutMs,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += String(chunk);
          });
          res.on('end', () => {
            const status = Number(res.statusCode || 500);
            const ok = status >= 200 && status < 300;
            let data = null;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {}
            resolve({ ok, status, data });
          });
        }
      );
      req.on('error', () => resolve({ ok: false, status: 0, data: null }));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
        resolve({ ok: false, status: 0, data: null });
      });
      if (reqOptions.body !== undefined) {
        req.write(reqOptions.body);
      }
      req.end();
    } catch {
      resolve({ ok: false, status: 0, data: null });
    }
  });
}

/**
 * Resolve Epic Games OAuth Exchange Code & EOS SDK launch arguments so Epic games
 * authenticate with Epic Online Services for live achievement unlocks and cloud saves.
 */
async function resolveEpicLaunchAuthArguments(payload = {}, options = {}) {
  let appName = String(payload.appName || payload.artifactId || '').trim();
  let namespace = String(payload.namespace || '').trim();
  let catalogItemId = String(payload.catalogItemId || '').trim();
  let deploymentId = String(payload.deploymentId || '').trim();

  if (!appName || !namespace || !deploymentId) {
    try {
      const resolved = resolveEpicAppAndPlatforms(payload, options);
      if (!appName && resolved?.resolvedAppName) {
        appName = String(resolved.resolvedAppName).trim();
      }
      if (!namespace && resolved?.namespace) {
        namespace = String(resolved.namespace).trim();
      }
      if (!catalogItemId && resolved?.catalogItemId) {
        catalogItemId = String(resolved.catalogItemId).trim();
      }
      if (!deploymentId && resolved?.deploymentId) {
        deploymentId = String(resolved.deploymentId).trim();
      }
    } catch {}
  }

  if (!appName) {
    appName = String(payload.platformGameId || payload.gameId || '')
      .replace(/^epic-/i, '')
      .trim();
  }

  if (appName && (!namespace || !deploymentId)) {
    try {
      const { metaSummaries } = collectLocalEpicMetadataAndSupport(options);
      const matched = metaSummaries.find(
        (s) => s && s.appName && s.appName.toLowerCase() === appName.toLowerCase()
      );
      if (matched) {
        if (!namespace && matched.namespace) namespace = String(matched.namespace).trim();
        if (!catalogItemId && matched.catalogItemId) {
          catalogItemId = String(matched.catalogItemId).trim();
        }
        if (!deploymentId && matched.deploymentId) {
          deploymentId = String(matched.deploymentId).trim();
        }
      }
    } catch {}
  }

  const activeStoreSync = options.storeSync || storeSync;
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens()
      : {});

  const legAuth = await ensureLegendaryConfigAndAuth(options).catch(() => null);

  let accessToken =
    legAuth?.accessToken ||
    savedTokens?.epic?.access_token ||
    options.epicAccessToken ||
    null;
  let refreshToken =
    legAuth?.refreshToken ||
    savedTokens?.epic?.refresh_token ||
    options.epicRefreshToken ||
    null;
  let accountId =
    legAuth?.accountId ||
    savedTokens?.epic?.account_id ||
    options.epicAccountId ||
    '';
  let displayName =
    legAuth?.displayName ||
    savedTokens?.epic?.displayName ||
    options.epicDisplayName ||
    '';

  if ((!accessToken || !accountId || !displayName || !refreshToken) && legAuth?.legendaryConfigPath) {
    const userJsonFile = path.join(legAuth.legendaryConfigPath, 'user.json');
    if (fs.existsSync(userJsonFile)) {
      try {
        const parsedUser = JSON.parse(fs.readFileSync(userJsonFile, 'utf8'));
        accessToken = accessToken || parsedUser?.access_token || null;
        refreshToken = refreshToken || parsedUser?.refresh_token || null;
        accountId = accountId || parsedUser?.account_id || parsedUser?.in_app_id || '';
        displayName = displayName || parsedUser?.displayName || '';
      } catch {}
    }
  }

  if (!displayName) {
    displayName = accountId || 'Player';
  }

  let exchangeCode = null;
  if (options.mockEpicExchangeCode) {
    exchangeCode = String(options.mockEpicExchangeCode).trim();
  } else if (accessToken && !options.skipNetwork) {
    const requestExchange = (token) =>
      performJsonHttpRequest(
        'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/exchange',
        {
          method: 'GET',
          timeoutMs: 3500,
          headers: {
            Authorization: `bearer ${token}`,
            Accept: 'application/json',
            'User-Agent':
              'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
          },
        },
        options.fetchFn
      );

    try {
      let res = await requestExchange(accessToken);
      if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 400)) {
        const renewFn =
          options.renewEpicTokensFn ||
          (activeStoreSync && typeof activeStoreSync.renewEpicTokens === 'function'
            ? activeStoreSync.renewEpicTokens
            : null);
        let refreshedToken = null;
        if (refreshToken && typeof renewFn === 'function') {
          try {
            const renewed = await renewFn(refreshToken);
            if (renewed?.access_token) {
              refreshedToken = renewed.access_token;
              if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
                try {
                  activeStoreSync.saveTokens(
                    'epic',
                    {
                      ...(savedTokens?.epic || {}),
                      ...renewed,
                      account_id: renewed.account_id || accountId,
                      displayName: renewed.displayName || displayName,
                    },
                    options
                  );
                } catch {}
              }
            }
          } catch {}
        }
        if (!refreshedToken) {
          const forcedAuth = await ensureLegendaryConfigAndAuth({
            ...options,
            forceTokenRefresh: true,
          }).catch(() => null);
          if (forcedAuth?.accessToken && forcedAuth.accessToken !== accessToken) {
            refreshedToken = forcedAuth.accessToken;
          }
        }
        if (refreshedToken) {
          accessToken = refreshedToken;
          res = await requestExchange(accessToken);
        }
      }
      if (res.ok && res.data && res.data.code) {
        exchangeCode = String(res.data.code).trim();
      }
    } catch {}
  }

  const authenticated = Boolean(exchangeCode);
  let epicArgs = [];
  if (authenticated) {
    epicArgs = [
      '-AUTH_LOGIN=unused',
      `-AUTH_PASSWORD=${exchangeCode}`,
      '-AUTH_TYPE=exchangecode',
      ...(appName ? [`-epicapp=${appName}`] : []),
      '-epicenv=Prod',
      '-EpicPortal',
      `-epicusername=${displayName || 'Player'}`,
      `-epicuserid=${accountId || ''}`,
      '-epiclocale=en',
      ...(namespace ? [`-epicsandboxid=${namespace}`] : []),
      ...(deploymentId ? [`-epicdeploymentid=${deploymentId}`] : []),
    ];
  } else if (appName) {
    epicArgs = [
      `-epicapp=${appName}`,
      '-epicenv=Prod',
      '-EpicPortal',
      `-epicusername=${displayName || 'Player'}`,
      `-epicuserid=${accountId || ''}`,
      '-epiclocale=en',
      ...(namespace ? [`-epicsandboxid=${namespace}`] : []),
      ...(deploymentId ? [`-epicdeploymentid=${deploymentId}`] : []),
    ];
  }

  return {
    args: epicArgs,
    authenticated,
    appName: appName || '',
    namespace: namespace || '',
    catalogItemId: catalogItemId || '',
    deploymentId: deploymentId || '',
    accountId: accountId || '',
    displayName: displayName || 'Player',
    exchangeCode: exchangeCode || null,
  };
}

/**
 * Ensure GOG Galaxy background communication daemon is running when installed on the host OS
 * so GOG Galaxy SDK (`Galaxy64.dll` / `libGalaxy64.dylib`) unlocks achievements in real time.
 */
async function ensureGogGalaxyBackgroundService(options = {}) {
  const targetPlatform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  const candidates = [];
  if (options.gogGalaxyClientPath !== undefined) {
    if (options.gogGalaxyClientPath) {
      candidates.push(options.gogGalaxyClientPath);
    }
  } else if (targetPlatform === 'win32') {
    candidates.push(
      'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe',
      'C:\\Program Files\\GOG Galaxy\\GalaxyClient.exe',
      'C:\\ProgramData\\GOG.com\\Galaxy\\redists\\GalaxyCommunication.exe'
    );
  } else if (targetPlatform === 'darwin') {
    candidates.push(path.join(homedir, 'Applications', 'GOG Galaxy.app'));
    if (!options.homedir || options.allowSystemGogAppInTest) {
      candidates.push('/Applications/GOG Galaxy.app');
    }
  }

  const clientPath = candidates.find((p) => p && fs.existsSync(p)) || null;
  if (!clientPath) {
    return {
      found: false,
      alreadyRunning: false,
      started: false,
      clientPath: null,
    };
  }

  let isRunning = false;
  if (typeof options.mockProcessListOutput === 'string') {
    isRunning = /GalaxyClient|GalaxyCommunication|GOG Galaxy/i.test(options.mockProcessListOutput);
  } else if (!options.homedir || options.allowProcessCheckInTest) {
    isRunning = await new Promise((resolve) => {
      const cmd = targetPlatform === 'win32' ? 'tasklist.exe' : 'ps';
      const cmdArgs =
        targetPlatform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-ax', '-o', 'command='];
      try {
        execFile(cmd, cmdArgs, { timeout: 1500 }, (err, stdout) => {
          if (err || !stdout) {
            resolve(false);
            return;
          }
          resolve(/GalaxyClient|GalaxyCommunication|GOG Galaxy/i.test(String(stdout)));
        });
      } catch {
        resolve(false);
      }
    });
  }

  if (isRunning) {
    return {
      found: true,
      alreadyRunning: true,
      started: false,
      clientPath,
    };
  }

  if (
    options.disableGogGalaxyWake === true ||
    (options.homedir && !options.allowGogWakeInTest && typeof options.spawnFn !== 'function')
  ) {
    return {
      found: true,
      alreadyRunning: false,
      started: false,
      skippedInTest: true,
      clientPath,
    };
  }

  const spawnImpl = options.spawnFn || spawn;
  try {
    if (targetPlatform === 'win32') {
      const child = spawnImpl(clientPath, ['/launchViaAutoStart'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
    } else if (targetPlatform === 'darwin') {
      const child = spawnImpl(
        '/usr/bin/open',
        ['-g', '-j', '-a', clientPath, '--args', '--launchViaAutoStart'],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
    }
    return {
      found: true,
      alreadyRunning: false,
      started: true,
      clientPath,
    };
  } catch {
    return {
      found: true,
      alreadyRunning: false,
      started: false,
      clientPath,
    };
  }
}

/**
 * Discover native host Steam client binary (`steam.exe` on Windows, `steam_osx` on macOS)
 * while respecting isolated test overrides (`steamClientBinaryPath`, `customApplicationsDir`, `homedir`).
 */
function resolveSteamClientBinaryPath(options = {}) {
  const targetPlatform = options.platform || process.platform;
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (options.steamClientBinaryPath !== undefined && options.steamClientBinaryPath !== null) {
    const explicitPath = String(options.steamClientBinaryPath).trim();
    if (!explicitPath) return null;
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  if (targetPlatform === 'win32') {
    const winCandidates = [];
    if (options.customApplicationsDir) {
      winCandidates.push(
        path.join(options.customApplicationsDir, 'Steam', 'steam.exe'),
        path.join(options.customApplicationsDir, 'steam.exe')
      );
    }
    if (options.homedir) {
      winCandidates.push(
        path.join(options.homedir, 'Program Files (x86)', 'Steam', 'steam.exe'),
        path.join(options.homedir, 'Program Files', 'Steam', 'steam.exe')
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || options.allowSystemSteamInTest === true) &&
      (!isTestEnv || options.allowSystemSteamInTest === true)
    ) {
      if (process.env['ProgramFiles(x86)']) {
        winCandidates.push(path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steam.exe'));
      }
      if (process.env.ProgramFiles) {
        winCandidates.push(path.join(process.env.ProgramFiles, 'Steam', 'steam.exe'));
      }
      winCandidates.push(
        'C:\\Program Files (x86)\\Steam\\steam.exe',
        'C:\\Program Files\\Steam\\steam.exe'
      );
    }
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (targetPlatform === 'darwin') {
    const macCandidates = [];
    if (options.customApplicationsDir) {
      macCandidates.push(
        path.join(options.customApplicationsDir, 'Steam.app', 'Contents', 'MacOS', 'steam_osx'),
        path.join(options.customApplicationsDir, 'Contents', 'MacOS', 'steam_osx')
      );
    }
    if (options.homedir) {
      macCandidates.push(
        path.join(options.homedir, 'Applications', 'Steam.app', 'Contents', 'MacOS', 'steam_osx')
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || options.allowSystemSteamInTest === true) &&
      (!isTestEnv || options.allowSystemSteamInTest === true)
    ) {
      macCandidates.push(
        path.join(os.homedir(), 'Applications', 'Steam.app', 'Contents', 'MacOS', 'steam_osx'),
        '/Applications/Steam.app/Contents/MacOS/steam_osx'
      );
    }
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

/**
 * Discover native host GOG Galaxy client (`GalaxyClient.exe` on Windows, `GOG Galaxy.app` on macOS)
 * while respecting isolated test overrides (`gogGalaxyClientPath`, `customApplicationsDir`, `homedir`).
 */
function resolveGogGalaxyClientBinaryPath(options = {}) {
  const targetPlatform = options.platform || process.platform;
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (options.gogGalaxyClientPath !== undefined && options.gogGalaxyClientPath !== null) {
    const explicitPath = String(options.gogGalaxyClientPath).trim();
    if (!explicitPath) return null;
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const allowSystem =
    options.allowSystemGogAppInTest === true ||
    options.allowSystemStorefrontClientsInTest === true;

  if (targetPlatform === 'win32') {
    const winCandidates = [];
    if (options.customApplicationsDir) {
      winCandidates.push(
        path.join(options.customApplicationsDir, 'GOG Galaxy', 'GalaxyClient.exe'),
        path.join(options.customApplicationsDir, 'GalaxyClient.exe')
      );
    }
    if (options.homedir) {
      winCandidates.push(
        path.join(options.homedir, 'Program Files (x86)', 'GOG Galaxy', 'GalaxyClient.exe'),
        path.join(options.homedir, 'Program Files', 'GOG Galaxy', 'GalaxyClient.exe')
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      if (process.env['ProgramFiles(x86)']) {
        winCandidates.push(
          path.join(process.env['ProgramFiles(x86)'], 'GOG Galaxy', 'GalaxyClient.exe')
        );
      }
      if (process.env.ProgramFiles) {
        winCandidates.push(
          path.join(process.env.ProgramFiles, 'GOG Galaxy', 'GalaxyClient.exe')
        );
      }
      winCandidates.push(
        'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe',
        'C:\\Program Files\\GOG Galaxy\\GalaxyClient.exe'
      );
    }
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (targetPlatform === 'darwin') {
    const macCandidates = [];
    if (options.customApplicationsDir) {
      macCandidates.push(path.join(options.customApplicationsDir, 'GOG Galaxy.app'));
    }
    if (options.homedir) {
      macCandidates.push(path.join(options.homedir, 'Applications', 'GOG Galaxy.app'));
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      macCandidates.push(
        path.join(os.homedir(), 'Applications', 'GOG Galaxy.app'),
        '/Applications/GOG Galaxy.app'
      );
    }
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

/**
 * Discover native host Epic Games Launcher client (`EpicGamesLauncher.exe` on Windows,
 * `Epic Games Launcher.app` on macOS) while respecting isolated test overrides.
 */
function resolveEpicClientBinaryPath(options = {}) {
  const targetPlatform = options.platform || process.platform;
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (options.epicClientBinaryPath !== undefined && options.epicClientBinaryPath !== null) {
    const explicitPath = String(options.epicClientBinaryPath).trim();
    if (!explicitPath) return null;
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const allowSystem =
    options.allowSystemEpicAppInTest === true ||
    options.allowSystemStorefrontClientsInTest === true;

  if (targetPlatform === 'win32') {
    const winCandidates = [];
    if (options.customApplicationsDir) {
      winCandidates.push(
        path.join(
          options.customApplicationsDir,
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.customApplicationsDir,
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win32',
          'EpicGamesLauncher.exe'
        ),
        path.join(options.customApplicationsDir, 'EpicGamesLauncher.exe')
      );
    }
    if (options.homedir) {
      winCandidates.push(
        path.join(
          options.homedir,
          'Program Files (x86)',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.homedir,
          'Program Files (x86)',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win32',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.homedir,
          'Program Files',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.homedir,
          'Program Files',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win32',
          'EpicGamesLauncher.exe'
        )
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      if (process.env['ProgramFiles(x86)']) {
        winCandidates.push(
          path.join(
            process.env['ProgramFiles(x86)'],
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win64',
            'EpicGamesLauncher.exe'
          ),
          path.join(
            process.env['ProgramFiles(x86)'],
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win32',
            'EpicGamesLauncher.exe'
          )
        );
      }
      if (process.env.ProgramFiles) {
        winCandidates.push(
          path.join(
            process.env.ProgramFiles,
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win64',
            'EpicGamesLauncher.exe'
          ),
          path.join(
            process.env.ProgramFiles,
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win32',
            'EpicGamesLauncher.exe'
          )
        );
      }
      winCandidates.push(
        'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
        'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe',
        'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
      );
    }
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (targetPlatform === 'darwin') {
    const macCandidates = [];
    if (options.customApplicationsDir) {
      macCandidates.push(path.join(options.customApplicationsDir, 'Epic Games Launcher.app'));
    }
    if (options.homedir) {
      macCandidates.push(path.join(options.homedir, 'Applications', 'Epic Games Launcher.app'));
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      macCandidates.push(
        path.join(os.homedir(), 'Applications', 'Epic Games Launcher.app'),
        '/Applications/Epic Games Launcher.app'
      );
    }
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

/**
 * Detect whether official desktop storefront clients (Steam, GOG Galaxy, Epic Games Launcher)
 * are installed on the host OS.
 */
function detectInstalledStorefrontClients(options = {}) {
  return {
    steam: Boolean(resolveSteamClientBinaryPath(options)),
    gog: Boolean(resolveGogGalaxyClientBinaryPath(options)),
    epic: Boolean(resolveEpicClientBinaryPath(options)),
  };
}

/**
 * Resolve Steam client binary path and minimal launch command when Steam is not already running.
 * - `minimal_and_close_if_started` / `minimal_keep_running`: `['-silent', '-applaunch', appId, ...extraArgs]`
 *   (preserving Steam Friends Co-op invites, Shift+Tab Overlay, and ISteamMicroTxn).
 * - `fast_direct_bypass`: `['-silent', '-nochatui', '-nofriendsui', '-nobrowser', '-applaunch', appId, ...extraArgs]`.
 */
async function resolveSteamClientLaunchCommand(steamAppId, extraArgs = [], options = {}) {
  const cleanAppId = String(steamAppId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  if (!cleanAppId) {
    return {
      useMinimalBinarySpawn: false,
      alreadyRunning: false,
      binaryPath: null,
      args: [],
      wokeSteamByLauncher: false,
    };
  }

  const rawPolicy =
    options.storefrontClientLifecycle ||
    resolveEffectivePerformancePolicy(options.launchConfig || {}, options).storefrontClientLifecycle;
  const policy = normalizeStorefrontClientLifecycle(rawPolicy) || rawPolicy;

  const targetPlatform = options.platform || process.platform;
  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  // 1. Discover Steam client executable
  const binaryPath = resolveSteamClientBinaryPath(options);

  // 2. Check if Steam is already running
  let alreadyRunning = false;
  const checkProcessList = (stdoutStr) => {
    const out = String(stdoutStr || '');
    if (targetPlatform === 'win32') {
      return /steam\.exe/i.test(out);
    }
    return /(?:Steam\.app\/Contents\/MacOS\/steam_osx|(?:^|[\\/])steam_osx(?:\s|$)|(?:^|[\\/])steam\.exe(?:\s|$))/i.test(
      out
    );
  };

  if (typeof options.mockProcessListOutput === 'string') {
    alreadyRunning = checkProcessList(options.mockProcessListOutput);
  } else if (
    !options.homedir ||
    typeof options.execFileImpl === 'function' ||
    typeof options.execFileFn === 'function'
  ) {
    try {
      alreadyRunning = await new Promise((resolve) => {
        if (targetPlatform === 'win32') {
          execFileImpl(
            'tasklist.exe',
            ['/FI', 'IMAGENAME eq steam.exe', '/NH'],
            { timeout: 1500 },
            (err, stdout) => {
              resolve(!err && checkProcessList(stdout));
            }
          );
        } else {
          execFileImpl('ps', ['-ax', '-o', 'command='], { timeout: 1500 }, (err, stdout) => {
            resolve(!err && checkProcessList(stdout));
          });
        }
      });
    } catch {
      alreadyRunning = false;
    }
  }

  if (alreadyRunning || policy === 'default_client' || !binaryPath) {
    return {
      useMinimalBinarySpawn: false,
      alreadyRunning,
      binaryPath: binaryPath || null,
      args: [],
      wokeSteamByLauncher: false,
    };
  }

  const parsedExtraArgs = Array.isArray(extraArgs) ? extraArgs.filter(Boolean).map(String) : [];
  const minimalArgs =
    policy === 'fast_direct_bypass'
      ? [
          '-silent',
          '-nochatui',
          '-nofriendsui',
          '-nobrowser',
          '-applaunch',
          cleanAppId,
          ...parsedExtraArgs,
        ]
      : ['-silent', '-applaunch', cleanAppId, ...parsedExtraArgs];

  return {
    useMinimalBinarySpawn: true,
    alreadyRunning: false,
    wokeSteamByLauncher: true,
    binaryPath,
    args: minimalArgs,
  };
}

/**
 * Gracefully shut down an ephemeral storefront client (GOG Galaxy or Steam) that was
 * woken specifically by One Launcher for this game session, once playtime/cloud sync finishes.
 * Never kills a storefront client that the user already had running before the session started.
 */
async function shutdownEphemeralStorefrontClient(sessionEntry = {}, options = {}) {
  if (!sessionEntry || typeof sessionEntry !== 'object') {
    return { closed: false, shutDown: false, reason: 'invalid_session' };
  }

  const effectivePolicy = resolveEffectivePerformancePolicy(
    sessionEntry.launchConfig || {},
    options
  );
  const policy =
    normalizeStorefrontClientLifecycle(sessionEntry.effectiveStorefrontLifecycle) ||
    normalizeStorefrontClientLifecycle(options.storefrontClientLifecycle) ||
    effectivePolicy.storefrontClientLifecycle;

  if (policy !== 'minimal_and_close_if_started') {
    return { closed: false, shutDown: false, reason: 'policy_keep_running', policy };
  }

  const targetPlatform = options.platform || process.platform;
  const platformId = String(
    sessionEntry.platformId || sessionEntry.session?.platformId || ''
  ).toLowerCase();

  const hasOtherActivePlatformSession = () =>
    (platformId && (pendingStorefrontLaunches.get(platformId) || 0) > 0) ||
    Array.from(activeSessions.values()).some(
      (other) =>
        other !== sessionEntry &&
        !other.finalized &&
        String(other.platformId || other.session?.platformId || '').toLowerCase() === platformId
    );

  const hasActiveOrPausedDownloadsForPlatform = () =>
    options.hasActiveDownloads === true ||
    Array.from(downloadQueueMap.values()).some(
      (t) =>
        t &&
        (!platformId || String(t.platformId || '').toLowerCase() === platformId) &&
        (['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
          pausedByInGameTaskIds.has(t.taskId))
    );

  if (hasOtherActivePlatformSession()) {
    return { closed: false, shutDown: false, reason: 'other_session_active' };
  }
  if (hasActiveOrPausedDownloadsForPlatform()) {
    return { closed: false, shutDown: false, reason: 'active_download_in_progress' };
  }

  const abortCtrl = new AbortController();
  if (platformId) {
    const prevCtrl = pendingEphemeralShutdowns.get(platformId);
    if (prevCtrl && typeof prevCtrl.abort === 'function') {
      try {
        prevCtrl.abort();
      } catch {}
    }
    pendingEphemeralShutdowns.set(platformId, abortCtrl);
  }

  const getBusyOrAbortedReason = () => {
    if (abortCtrl.signal.aborted) return 'other_session_active';
    if (hasOtherActivePlatformSession()) return 'other_session_active';
    if (hasActiveOrPausedDownloadsForPlatform()) return 'active_download_in_progress';
    return null;
  };

  try {
    const defaultGraceMs =
      isTestEnvironment(options) ||
      options.skipCloudSyncGraceDelay === true ||
      typeof options.spawnFn === 'function' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function'
        ? 0
        : 5000;
    const graceMs =
      options.cloudSyncGraceMs !== undefined
        ? Math.max(0, Number(options.cloudSyncGraceMs) || 0)
        : defaultGraceMs;

    if (graceMs > 0) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          abortCtrl.signal.removeEventListener('abort', finish);
          resolve();
        };
        const t = setTimeout(finish, graceMs);
        if (typeof t.unref === 'function') t.unref();
        abortCtrl.signal.addEventListener('abort', finish, { once: true });
      });
      const busyAfterGrace = getBusyOrAbortedReason();
      if (busyAfterGrace) {
        return { closed: false, shutDown: false, reason: busyAfterGrace };
      }
    }

    const spawnImpl = options.spawnFn || spawn;
    const execFileImpl =
      typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : typeof options.execFileFn === 'function'
          ? options.execFileFn
          : execFile;

    if (platformId === 'gog' && sessionEntry.wokeGogGalaxyByLauncher === true) {
      const busyBeforeGogKill = getBusyOrAbortedReason();
      if (busyBeforeGogKill) {
        return { closed: false, shutDown: false, reason: busyBeforeGogKill };
      }
      const clientPath = sessionEntry.gogGalaxyClientPath || 'GalaxyClient.exe';
      try {
        if (targetPlatform === 'win32') {
          const child = spawnImpl(clientPath, ['/command=shutdown'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.unref === 'function') child.unref();
          return {
            closed: true,
            shutDown: true,
            platformId: 'gog',
            method: 'command_shutdown',
            clientPath,
          };
        } else if (targetPlatform === 'darwin') {
          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'GOG Galaxy'],
              { timeout: 2500 },
              () => resolve()
            );
          });
          return {
            closed: true,
            shutDown: true,
            platformId: 'gog',
            method: 'sigterm_quit',
            clientPath: sessionEntry.gogGalaxyClientPath || null,
          };
        }
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'gog',
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (platformId === 'steam' && sessionEntry.wokeSteamByLauncher === true) {
      const steamAppId =
        sessionEntry.steamAppId ||
        sessionEntry.platformGameId ||
        sessionEntry.session?.platformGameId ||
        options.steamAppId ||
        '';
      const candidateSteamRoot =
        options.steamRoot ||
        sessionEntry.steamRoot ||
        sessionEntry.bottleSteamRoot ||
        (sessionEntry.steamClientBinaryPath && targetPlatform === 'win32'
          ? path.dirname(sessionEntry.steamClientBinaryPath)
          : targetPlatform === 'darwin' && (options.homedir || !isTestEnvironment(options))
            ? path.join(options.homedir || os.homedir(), 'Library', 'Application Support', 'Steam')
            : sessionEntry.steamClientBinaryPath
              ? path.dirname(sessionEntry.steamClientBinaryPath)
              : null) ||
        (() => {
          try {
            const locs = discoverSteamLocations(options);
            if (locs && locs.steamRoots) {
              const arr = Array.from(locs.steamRoots);
              return arr[0] || '';
            }
          } catch {}
          return '';
        })();

      let cloudWaitResult = options.preResolvedCloudWaitResult || null;
      if (!cloudWaitResult && steamAppId) {
        try {
          cloudWaitResult = await waitForSteamCloudSyncCompletion(
            candidateSteamRoot || '',
            steamAppId,
            {
              ...options,
              mode: 'post_exit',
              ignoreStaleLogAge: true,
              signal: abortCtrl.signal,
              abortOnSignal: true,
            }
          );
        } catch {}
      }

      const busyBeforeSteamKill = getBusyOrAbortedReason();
      if (busyBeforeSteamKill) {
        return { closed: false, shutDown: false, reason: busyBeforeSteamKill };
      }

      const steamBin = sessionEntry.steamClientBinaryPath || 'steam.exe';
      try {
        if (targetPlatform === 'win32') {
          const child = spawnImpl(steamBin, ['-shutdown'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.unref === 'function') child.unref();
          return {
            closed: true,
            shutDown: true,
            platformId: 'steam',
            method: 'steam_shutdown_flag',
            binaryPath: steamBin,
            ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
          };
        } else if (targetPlatform === 'darwin') {
          if (typeof options.spawnFn === 'function' && !options.execFileFn && !options.execFileImpl) {
            const child = spawnImpl(
              sessionEntry.steamClientBinaryPath || '/Applications/Steam.app/Contents/MacOS/steam_osx',
              ['-shutdown'],
              { detached: true, stdio: 'ignore' }
            );
            if (child && typeof child.unref === 'function') child.unref();
            return {
              closed: true,
              shutDown: true,
              platformId: 'steam',
              method: 'steam_shutdown_flag',
              binaryPath: sessionEntry.steamClientBinaryPath || null,
              ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
            };
          }

          if (sessionEntry.steamClientBinaryPath) {
            const shutdownOk = await new Promise((resolve) => {
              try {
                execFileImpl(
                  sessionEntry.steamClientBinaryPath,
                  ['-shutdown'],
                  { timeout: 3000 },
                  (err) => resolve(!err)
                );
              } catch {
                resolve(false);
              }
            });
            if (shutdownOk) {
              return {
                closed: true,
                shutDown: true,
                platformId: 'steam',
                method: 'steam_shutdown_flag',
                binaryPath: sessionEntry.steamClientBinaryPath,
                ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
              };
            }
          }

          const busyBeforeFallbackPkill = getBusyOrAbortedReason();
          if (busyBeforeFallbackPkill) {
            return { closed: false, shutDown: false, reason: busyBeforeFallbackPkill };
          }

          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'steam_osx'],
              { timeout: 2500 },
              () => resolve()
            );
          });
          return {
            closed: true,
            shutDown: true,
            platformId: 'steam',
            method: 'sigterm_quit',
            binaryPath: sessionEntry.steamClientBinaryPath || null,
            ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
          };
        }
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'steam',
          reason: 'shutdown_command_failed',
        };
      }
    }

    return { closed: false, shutDown: false, reason: 'not_woken_by_launcher' };
  } finally {
    if (platformId && pendingEphemeralShutdowns.get(platformId) === abortCtrl) {
      pendingEphemeralShutdowns.delete(platformId);
    }
  }
}

/**
 * Sync completed game session playtime to first-party storefront cloud APIs (Epic & GOG)
 * and retrieve authoritative storefront total playtime as the Single Point of Truth.
 */
async function syncSessionPlaytimeToStorefront(sessionInfo = {}, options = {}) {
  const platformId = String(sessionInfo.platformId || 'custom').toLowerCase();
  const durationSeconds = Number(sessionInfo.durationSeconds || 0);
  const sessionMinutesPlayed = Number(
    sessionInfo.sessionMinutesPlayed !== undefined
      ? sessionInfo.sessionMinutesPlayed
      : durationSeconds > 0
        ? Math.max(1, Math.round(durationSeconds / 60))
        : 0
  );

  if (durationSeconds <= 0 || sessionMinutesPlayed <= 0) {
    return {
      synced: false,
      platformId,
      reason: 'zero_duration',
      storefrontTotalPlaytimeMinutes: null,
    };
  }

  const activeStoreSync = options.storeSync || storeSync;
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens()
      : {});

  if (platformId === 'epic') {
    let artifactId = String(sessionInfo.artifactId || sessionInfo.appName || '').trim();
    if (!artifactId) {
      try {
        const resolved = resolveEpicAppAndPlatforms(sessionInfo, options);
        if (resolved?.resolvedAppName) {
          artifactId = String(resolved.resolvedAppName).trim();
        }
      } catch {}
    }
    if (!artifactId) {
      artifactId = String(sessionInfo.platformGameId || sessionInfo.gameId || '')
        .replace(/^epic-/i, '')
        .trim();
    }

    const legAuth = await ensureLegendaryConfigAndAuth(options).catch(() => null);
    let accessToken =
      legAuth?.accessToken ||
      savedTokens?.epic?.access_token ||
      options.epicAccessToken ||
      null;
    let refreshToken =
      legAuth?.refreshToken ||
      savedTokens?.epic?.refresh_token ||
      options.epicRefreshToken ||
      null;
    let accountId =
      legAuth?.accountId ||
      savedTokens?.epic?.account_id ||
      options.epicAccountId ||
      '';

    if ((!accessToken || !accountId || !refreshToken) && legAuth?.legendaryConfigPath) {
      const userJsonFile = path.join(legAuth.legendaryConfigPath, 'user.json');
      if (fs.existsSync(userJsonFile)) {
        try {
          const parsedUser = JSON.parse(fs.readFileSync(userJsonFile, 'utf8'));
          accessToken = accessToken || parsedUser?.access_token || null;
          refreshToken = refreshToken || parsedUser?.refresh_token || null;
          accountId = accountId || parsedUser?.account_id || parsedUser?.in_app_id || '';
        } catch {}
      }
    }

    if (!accessToken || !accountId || !artifactId) {
      return {
        synced: false,
        platformId: 'epic',
        reason: 'missing_credentials_or_artifact',
        storefrontTotalPlaytimeMinutes: null,
      };
    }

    const endMs = sessionInfo.endedAt ? new Date(sessionInfo.endedAt).getTime() : Date.now();
    const validEndMs = Number.isNaN(endMs) ? Date.now() : endMs;
    const startMs = sessionInfo.startedAt
      ? new Date(sessionInfo.startedAt).getTime()
      : validEndMs - durationSeconds * 1000;
    const validStartMs =
      Number.isNaN(startMs) || startMs >= validEndMs
        ? validEndMs - durationSeconds * 1000
        : startMs;

    const startTimeIso = new Date(validStartMs).toISOString();
    const endTimeIso = new Date(validEndMs).toISOString();
    const machineId =
      options.machineId ||
      (typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex'));

    const putUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${encodeURIComponent(accountId)}`;
    const putBody = JSON.stringify({
      machineId,
      artifactId,
      startTime: startTimeIso,
      endTime: endTimeIso,
      startSegment: true,
      endSegment: true,
    });

    const executePut = (token) =>
      performJsonHttpRequest(
        putUrl,
        {
          method: 'PUT',
          timeoutMs: 4000,
          headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent':
              'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
          },
          body: putBody,
        },
        options.fetchFn
      );

    let putRes = await executePut(accessToken);

    if (!putRes.ok && (putRes.status === 401 || putRes.status === 403 || putRes.status === 400)) {
      const renewFn =
        options.renewEpicTokensFn ||
        (activeStoreSync && typeof activeStoreSync.renewEpicTokens === 'function'
          ? activeStoreSync.renewEpicTokens
          : null);
      let refreshedToken = null;
      if (refreshToken && typeof renewFn === 'function') {
        try {
          const renewed = await renewFn(refreshToken);
          if (renewed?.access_token) {
            refreshedToken = renewed.access_token;
            if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
              try {
                activeStoreSync.saveTokens(
                  'epic',
                  {
                    ...(savedTokens?.epic || {}),
                    ...renewed,
                    account_id: renewed.account_id || accountId,
                  },
                  options
                );
              } catch {}
            }
          }
        } catch {}
      }
      if (!refreshedToken) {
        const forcedAuth = await ensureLegendaryConfigAndAuth({
          ...options,
          forceTokenRefresh: true,
        }).catch(() => null);
        if (forcedAuth?.accessToken && forcedAuth.accessToken !== accessToken) {
          refreshedToken = forcedAuth.accessToken;
        }
      }
      if (refreshedToken) {
        accessToken = refreshedToken;
        putRes = await executePut(accessToken);
      }
    }

    let storefrontTotalPlaytimeMinutes = null;
    const allUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${encodeURIComponent(accountId)}/all`;
    const getRes = await performJsonHttpRequest(
      allUrl,
      {
        method: 'GET',
        timeoutMs: 4000,
        headers: {
          Authorization: `bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent':
            'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
        },
      },
      options.fetchFn
    );

    if (getRes.ok && Array.isArray(getRes.data)) {
      const matchedItem = getRes.data.find(
        (item) =>
          item &&
          String(item.artifactId || '').toLowerCase() === String(artifactId).toLowerCase()
      );
      if (matchedItem && typeof matchedItem.totalTime === 'number' && matchedItem.totalTime > 0) {
        storefrontTotalPlaytimeMinutes = Math.max(1, Math.round(matchedItem.totalTime / 60));
      }
    }

    return {
      synced: Boolean(putRes.ok),
      platformId: 'epic',
      artifactId,
      storefrontTotalPlaytimeMinutes,
    };
  }

  if (platformId === 'gog') {
    let rawGogId = String(sessionInfo.platformGameId || sessionInfo.gameId || '')
      .replace(/^gog[-_]/i, '')
      .trim();
    let numericGameId = /^\d+$/.test(rawGogId) ? rawGogId : '';

    const searchDirs = [];
    if (sessionInfo.installPath) {
      searchDirs.push(toLocalFsPath(sessionInfo.installPath));
    }
    if (sessionInfo.executablePath) {
      searchDirs.push(path.dirname(toLocalFsPath(sessionInfo.executablePath)));
    }

    for (const dir of searchDirs) {
      if (numericGameId) break;
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        const infoFile = files.find((f) => /^goggame-\d+\.info$/i.test(f));
        if (infoFile) {
          const match = infoFile.match(/^goggame-(\d+)\.info$/i);
          if (match && match[1]) {
            numericGameId = match[1];
          }
        }
      } catch {}
    }

    const gogAuth = await ensureGogdlAuthConfig(options).catch(() => null);
    let accessToken =
      gogAuth?.accessToken ||
      savedTokens?.gog?.access_token ||
      options.gogAccessToken ||
      null;
    const refreshToken =
      gogAuth?.refreshToken ||
      savedTokens?.gog?.refresh_token ||
      options.gogRefreshToken ||
      null;
    let userId =
      gogAuth?.userId ||
      savedTokens?.gog?.user_id ||
      savedTokens?.gog?.userId ||
      options.gogUserId ||
      '';

    if (!userId && accessToken && String(accessToken).split('.').length === 3) {
      try {
        const payloadB64 = String(accessToken).split('.')[1];
        const decoded = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        userId = String(decoded?.sub || decoded?.user_id || '').trim();
      } catch {}
    }

    if (!accessToken || !userId || !numericGameId) {
      return {
        synced: false,
        platformId: 'gog',
        reason: 'missing_credentials_or_game_id',
        storefrontTotalPlaytimeMinutes: null,
      };
    }

    const startMs = sessionInfo.startedAt
      ? new Date(sessionInfo.startedAt).getTime()
      : Date.now() - durationSeconds * 1000;
    const sessionDateSec = Math.floor(
      (Number.isNaN(startMs) ? Date.now() - durationSeconds * 1000 : startMs) / 1000
    );
    const timeMinutes = Math.max(1, sessionMinutesPlayed || Math.round(durationSeconds / 60));

    const postUrl = `https://gameplay.gog.com/clients/${encodeURIComponent(numericGameId)}/users/${encodeURIComponent(userId)}/sessions`;
    const postBody = JSON.stringify({
      session_date: sessionDateSec,
      time: timeMinutes,
    });

    const executePost = (token) =>
      performJsonHttpRequest(
        postUrl,
        {
          method: 'POST',
          timeoutMs: 4000,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: postBody,
        },
        options.fetchFn
      );

    let postRes = await executePost(accessToken);

    if (!postRes.ok && (postRes.status === 401 || postRes.status === 403) && refreshToken) {
      const renewGogFn =
        options.renewGogTokensFn ||
        (activeStoreSync && typeof activeStoreSync.renewGogTokens === 'function'
          ? activeStoreSync.renewGogTokens
          : null);
      if (typeof renewGogFn === 'function') {
        try {
          const renewed = await renewGogFn(refreshToken);
          if (renewed?.access_token) {
            accessToken = renewed.access_token;
            if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
              try {
                activeStoreSync.saveTokens(
                  'gog',
                  {
                    ...(savedTokens?.gog || {}),
                    ...renewed,
                    user_id: renewed.user_id || userId,
                  },
                  options
                );
              } catch {}
            }
            postRes = await executePost(accessToken);
          }
        } catch {}
      }
    }

    let storefrontTotalPlaytimeMinutes = null;
    if (postRes.data && typeof postRes.data === 'object') {
      const candidateTotal =
        postRes.data.total_time ??
        postRes.data.totalPlaytimeMinutes ??
        postRes.data.playtime;
      if (typeof candidateTotal === 'number' && candidateTotal > 0) {
        storefrontTotalPlaytimeMinutes = Math.max(1, Math.round(candidateTotal));
      }
    }

    return {
      synced: Boolean(postRes.ok),
      platformId: 'gog',
      gameId: numericGameId,
      storefrontTotalPlaytimeMinutes,
    };
  }

  if (platformId === 'steam') {
    return {
      synced: true,
      platformId: 'steam',
      storefrontTotalPlaytimeMinutes: null,
    };
  }

  return {
    synced: false,
    platformId,
    reason: 'unsupported_platform',
    storefrontTotalPlaytimeMinutes: null,
  };
}

/**
 * Background monitor for Steam downloads & installations via appmanifest_<appId>.acf + logs/content_log.txt
 */
function startSteamInstallMonitor(taskId, appId, options = {}) {
  const intervalMs = Number(options.steamPollIntervalMs || 1200);
  const locationsCacheTtlMs = Number(options.steamLocationsCacheTtlMs ?? 10000);
  let lastBytes = 0;
  let lastTickTime = Date.now();
  let cachedLocations = null;
  let cachedLocationsAt = 0;
  let lastKnownManifestDir = null;
  let inFlightTick = false;

  const readContentLogTail = (steamRoots, minTimestampMs = 0) => {
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        try {
          const st = fs.statSync(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;
          const readLen = Math.min(size, 24 * 1024);
          const fd = fs.openSync(logPath, 'r');
          let bytesRead = 0;
          const buf = Buffer.alloc(readLen);
          try {
            bytesRead = fs.readSync(fd, buf, 0, readLen, size - readLen);
          } finally {
            fs.closeSync(fd);
          }
          const parsedLog = parseSteamContentLogForApp(
            buf.subarray(0, bytesRead).toString('utf8'),
            appId,
            minTimestampMs
          );
          if (
            parsedLog.updateStarted ||
            parsedLog.isRunning ||
            parsedLog.fullyInstalled ||
            parsedLog.bytesToDownload > 0 ||
            parsedLog.bytesToStage > 0 ||
            parsedLog.phase
          ) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {
          // logPath does not exist or unreadable
        }
      }
    }
    return bestLogInfo;
  };

  const readContentLogTailAsync = async (steamRoots, minTimestampMs = 0) => {
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        let fh = null;
        try {
          const st = await fs.promises.stat(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;
          const readLen = Math.min(size, 24 * 1024);
          fh = await fs.promises.open(logPath, 'r');
          const buf = Buffer.alloc(readLen);
          const { bytesRead } = await fh.read(buf, 0, readLen, size - readLen);
          await fh.close();
          fh = null;
          const parsedLog = parseSteamContentLogForApp(
            buf.subarray(0, bytesRead).toString('utf8'),
            appId,
            minTimestampMs
          );
          if (
            parsedLog.updateStarted ||
            parsedLog.isRunning ||
            parsedLog.fullyInstalled ||
            parsedLog.bytesToDownload > 0 ||
            parsedLog.bytesToStage > 0 ||
            parsedLog.phase
          ) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {
          // logPath does not exist or unreadable
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {}
          }
        }
      }
    }
    return bestLogInfo;
  };

  const timer = setInterval(() => {
    if (inFlightTick) return;
    inFlightTick = true;
    (async () => {
      const task = downloadQueueMap.get(taskId);
      if (
        !task ||
        task.status === 'cancelled' ||
        task.status === 'completed' ||
        task.status === 'failed'
      ) {
        clearInterval(timer);
        downloadControllers.delete(taskId);
        return;
      }

      if (task.status === 'paused') {
        return;
      }

      const nowMs = Date.now();
      const shouldRefreshLocations =
        !cachedLocations ||
        !cachedLocations.steamappsDirs ||
        (Array.isArray(cachedLocations.steamappsDirs)
          ? cachedLocations.steamappsDirs.length === 0
          : cachedLocations.steamappsDirs.size === 0) ||
        !lastKnownManifestDir ||
        nowMs - cachedLocationsAt >= locationsCacheTtlMs;
      if (shouldRefreshLocations) {
        cachedLocations = discoverSteamLocations(options);
        cachedLocationsAt = nowMs;
      }
      let { steamRoots, steamappsDirs } = cachedLocations;
      const logInfo = options.syncLogSnapshot
        ? readContentLogTail(steamRoots, Number(task.startedAt || 0))
        : await readContentLogTailAsync(steamRoots, Number(task.startedAt || 0));

      let parsed = null;
      let matchedSteamappsDir = null;

      const findManifestInDirsAsync = async (dirs) => {
        for (const steamappsDir of dirs) {
          const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
          try {
            const acfText = await fs.promises.readFile(acfPath, 'utf8');
            const candidateParsed = parseSteamAcf(acfText);
            if (candidateParsed && String(candidateParsed.appId) === String(appId)) {
              parsed = candidateParsed;
              matchedSteamappsDir = steamappsDir;
              lastKnownManifestDir = steamappsDir;
              break;
            }
          } catch {}
        }
      };

      await findManifestInDirsAsync(steamappsDirs);
      if (!matchedSteamappsDir && !shouldRefreshLocations) {
        cachedLocations = discoverSteamLocations(options);
        cachedLocationsAt = nowMs;
        steamRoots = cachedLocations.steamRoots;
        steamappsDirs = cachedLocations.steamappsDirs;
        await findManifestInDirsAsync(steamappsDirs);
      }

      const latestTask = downloadQueueMap.get(taskId);
      if (
        !latestTask ||
        latestTask.status === 'cancelled' ||
        latestTask.status === 'completed' ||
        latestTask.status === 'failed' ||
        latestTask.status === 'paused'
      ) {
        return;
      }

      const acfDownloaded = Number(parsed?.BytesDownloaded || 0);
      const acfTotal = Number(parsed?.BytesToDownload || 0);
      const acfStaged = Number(parsed?.BytesStaged || 0);
      const acfToStage = Number(parsed?.BytesToStage || 0);
      let logDownloaded = Number(logInfo?.bytesDownloaded || 0);
      const logTotal = Number(logInfo?.bytesToDownload || 0);
      const logStaged = Number(logInfo?.bytesStaged || 0);
      const logToStage = Number(logInfo?.bytesToStage || 0);

      // Guard against stale content_log lines when ACF explicitly shows download just started (0 / acfTotal)
      if (acfTotal > 0 && acfDownloaded === 0 && logDownloaded >= acfTotal * 0.9) {
        logDownloaded = 0;
      }

      const downloadTotal = acfTotal > 0 ? acfTotal : logTotal;
      const downloadDone =
        downloadTotal > 0
          ? Math.min(downloadTotal, Math.max(acfDownloaded, logDownloaded))
          : Math.max(acfDownloaded, logDownloaded);

      const stageTotal = acfToStage > 0 ? acfToStage : logToStage;
      const stageDone =
        stageTotal > 0
          ? Math.min(stageTotal, Math.max(acfStaged, logStaged))
          : Math.max(acfStaged, logStaged);

      let effectiveTotal = 0;
      let effectiveDownloaded = 0;

      if (downloadTotal > 0) {
        effectiveTotal = downloadTotal;
        effectiveDownloaded = downloadDone;
      } else if (stageTotal > 0) {
        effectiveTotal = stageTotal;
        effectiveDownloaded = stageDone;
      } else {
        effectiveTotal = Number(parsed?.SizeOnDisk || 0) || latestTask.totalBytes || 0;
        effectiveDownloaded = downloadDone || stageDone || 0;
      }

      const stateFlags = parsed && parsed.StateFlags ? String(parsed.StateFlags).trim() : '';
      const commonInstallPath =
        matchedSteamappsDir && parsed
          ? path.join(matchedSteamappsDir, 'common', parsed.installdir || String(appId))
          : null;

      let commonInstallExists = false;
      if (commonInstallPath) {
        try {
          await fs.promises.access(commonInstallPath);
          commonInstallExists = true;
        } catch {}
      }

      const isComplete =
        Boolean(parsed) &&
        (stateFlags === '4' || Boolean(logInfo?.fullyInstalled)) &&
        commonInstallExists &&
        (acfTotal === 0 || acfDownloaded >= acfTotal || Boolean(logInfo?.fullyInstalled));

      if (isComplete && commonInstallPath) {
        clearInterval(timer);
        downloadControllers.delete(taskId);

        const hostPlat = options.platform || process.platform;
        const appInfoSpec = resolveSteamAppInfoLaunchSpec(
          matchedSteamappsDir || commonInstallPath,
          appId,
          commonInstallPath,
          { platform: hostPlat }
        );
        const exeDiscovery =
          appInfoSpec && appInfoSpec.executablePath
            ? {
                executablePath: appInfoSpec.executablePath,
                isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
              }
            : findPrimaryExecutable(commonInstallPath, {
                platform: hostPlat,
                hintName: parsed.name || latestTask.title,
              });
        const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(commonInstallPath);
        const isWinOnMac =
          Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
          (hostPlat === 'darwin' && isInsideBottle);
        const launchArguments =
          appInfoSpec?.launchArguments ||
          resolveDefaultEngineLaunchArguments(commonInstallPath, exeDiscovery.executablePath);

        const finalSize =
          Number(parsed.SizeOnDisk || 0) ||
          getDirectorySizeFast(commonInstallPath, 3) ||
          effectiveTotal ||
          latestTask.totalBytes;

        upsertManagedInstallRecord(
          {
            platformId: 'steam',
            platformGameId: String(appId),
            appId: Number(appId),
            title: parsed.name || latestTask.title,
            installPath: commonInstallPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            installSize: finalSize,
            version: parsed.buildid ? String(parsed.buildid) : undefined,
            runner: 'steam',
            isWindowsBinaryOnMac: isWinOnMac,
          },
          options.userDataDir
        );

        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: finalSize,
            totalBytes: finalSize,
            speedBytesPerSec: 0,
            etaSeconds: 0,
            finalInstallPath: commonInstallPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            runner: 'steam',
            isWindowsBinaryOnMac: isWinOnMac,
            statusMessage: 'Installed via Steam',
          },
          options
        );
        return;
      }

      const hasActiveLogProgress = Boolean(
        logInfo &&
          (logInfo.updateStarted ||
            logInfo.isRunning ||
            logInfo.fullyInstalled ||
            logInfo.bytesToDownload > 0 ||
            logInfo.bytesToStage > 0 ||
            logInfo.phase)
      );

      if (!parsed && !hasActiveLogProgress) {
        updateDownloadTask(
          taskId,
          {
            status: 'downloading',
            progressPercent: 0,
            bytesDownloaded: 0,
            speedBytesPerSec: 0,
            statusMessage: 'Waiting for confirmation in Steam client...',
          },
          options
        );
        return;
      }

      if (parsed || hasActiveLogProgress) {
        const phaseLabel =
          logInfo?.phase ||
          (acfStaged > 0 && acfTotal > 0 && acfDownloaded >= acfTotal ? 'Staging' : 'Downloading');

        const rawRatio = effectiveTotal > 0 ? effectiveDownloaded / effectiveTotal : 0;
        let progressPercent =
          effectiveTotal > 0
            ? Math.min(99, Math.max(latestTask.progressPercent || 0, Math.floor(rawRatio * 100)))
            : latestTask.progressPercent || 0;

        if (effectiveDownloaded === 0 && /preallocating|allocating/i.test(phaseLabel)) {
          progressPercent = 0;
        }

        const now = Date.now();
        let rawSpeedBytesPerSec = logInfo?.speedBytesPerSec || 0;
        if (!rawSpeedBytesPerSec && effectiveDownloaded > lastBytes && now > lastTickTime) {
          rawSpeedBytesPerSec = Math.round(((effectiveDownloaded - lastBytes) * 1000) / (now - lastTickTime));
        }
        lastBytes = effectiveDownloaded;
        lastTickTime = now;

        const speedBytesPerSec = computeSmoothedDownloadSpeed(taskId, {
          bytesDownloaded: effectiveDownloaded,
          rawSpeedBytesPerSec,
          nowMs: now,
        });

        const etaSeconds =
          speedBytesPerSec > 0 && effectiveTotal > effectiveDownloaded
            ? Math.max(1, Math.round((effectiveTotal - effectiveDownloaded) / speedBytesPerSec))
            : latestTask.etaSeconds;

        const nextStatus = /staging|extracting/i.test(phaseLabel)
          ? 'extracting'
          : /verifying/i.test(phaseLabel)
            ? 'verifying'
            : 'downloading';

        const statusMessage =
          effectiveDownloaded === 0 && /preallocating|allocating/i.test(phaseLabel)
            ? `Steam: Preallocating ${latestTask.title} (0%)...`
            : `Steam: ${phaseLabel} ${latestTask.title} (${progressPercent}%)...`;

        updateDownloadTask(
          taskId,
          {
            status: nextStatus,
            progressPercent,
            bytesDownloaded: effectiveDownloaded,
            totalBytes: effectiveTotal,
            speedBytesPerSec,
            etaSeconds,
            statusMessage,
          },
          options
        );
      }
    })()
      .catch((tickErr) => {
        diagLog.debug('startSteamInstallMonitor.tick', tickErr, { taskId, appId });
      })
      .finally(() => {
        inFlightTick = false;
      });
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  downloadControllers.set(taskId, { type: 'timer', timer });
  return timer;
}

const installInfoSizeCache = new Map();
const steamPlatformSupportCache = new Map();

async function getGameInstallInfo(payload = {}, options = {}) {
  const platformId = payload.platformId || 'custom';
  const platformGameId = String(payload.platformGameId || payload.gameId || '');
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  let defaultInstallDir = getDefaultInstallDir(platformId, options);
  let availableInstallDirs =
    platform === 'darwin'
      ? [defaultInstallDir, '/Applications', path.join(homedir, 'Applications')]
      : [defaultInstallDir, 'C:\\Games', 'D:\\Games'];

  const targetDir = payload.targetInstallDir || defaultInstallDir;
  let diskSpace = getDiskSpace(targetDir, options);

  let estimatedSizeBytes = payload.estimatedSizeBytes ? Number(payload.estimatedSizeBytes) : undefined;
  let availableInstallers = [];
  let canDirectDownload = false;
  let requiresStoreClientFallback = false;

  if (platformId === 'gog') {
    canDirectDownload = true;
    const savedTokens =
      options.savedTokens ||
      (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});
    let authRes = null;
    if (!options.skipNetwork) {
      try {
        authRes = await ensureGogdlAuthConfig(options);
      } catch {}
    }
    let gogToken = options.gogAccessToken || authRes?.accessToken || savedTokens?.gog?.access_token;
    const cleanId = platformGameId.replace(/^gog-/i, '');
    const titleLabel = payload.title || 'Game';

    if (!estimatedSizeBytes && cleanId && installInfoSizeCache.has(`gog:${cleanId}:${platform}`)) {
      estimatedSizeBytes = installInfoSizeCache.get(`gog:${cleanId}:${platform}`);
    }

    const fetchGogProduct = async (token) => {
      if (!token || !cleanId || options.skipNetwork) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      try {
        const res = await fetch(
          `https://api.gog.com/products/${encodeURIComponent(cleanId)}?expand=downloads,description`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GOGGalaxy/2.0',
            },
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);
        if (res.ok) {
          return await res.json();
        }
        return null;
      } catch {
        clearTimeout(timeout);
        return null;
      }
    };

    const normalizeInstallerVersion = (v) => {
      if (v === undefined || v === null) return undefined;
      const cleaned = String(v).trim().replace(/^[vV]+/, '');
      return cleaned || undefined;
    };

    let productData = null;
    if (cleanId && (!options.skipNetwork || options.mockGogProductData)) {
      productData = options.mockGogProductData || (await fetchGogProduct(gogToken));
      if (!options.mockGogProductData && (!productData || !productData.downloads) && gogToken) {
        try {
          const refreshedAuth = await ensureGogdlAuthConfig({
            ...options,
            forceTokenRefresh: true,
          });
          if (refreshedAuth?.accessToken && refreshedAuth.accessToken !== gogToken) {
            gogToken = refreshedAuth.accessToken;
            productData = await fetchGogProduct(gogToken);
          }
        } catch {}
      }

      if (productData && productData.downloads) {
        const rawInstallers = Array.isArray(productData?.downloads?.installers)
          ? productData.downloads.installers
          : [];
        const mappedInstallers = rawInstallers.map((ins, idx) => {
          const normOs =
            ins.os === 'mac' || ins.os === 'osx'
              ? 'mac'
              : ins.os === 'linux'
                ? 'linux'
                : 'windows';
          const baseName = ins.name || titleLabel;
          return {
            id: String(ins.id || `ins-${idx}`),
            name:
              normOs === 'mac'
                ? `${baseName} — Native macOS Build`
                : normOs === 'windows'
                  ? `${baseName} — Windows Build`
                  : baseName,
            os: normOs,
            language: ins.language || 'en',
            totalSizeBytes: Number(ins.total_size || 0) || undefined,
            version: normalizeInstallerVersion(ins.version),
          };
        });

        const platformFiltered =
          platform === 'win32'
            ? mappedInstallers.filter((i) => i.os === 'windows')
            : mappedInstallers.filter((i) => i.os === 'mac' || i.os === 'windows');

        const osGroups = new Map();
        for (const ins of platformFiltered) {
          if (!osGroups.has(ins.os)) {
            osGroups.set(ins.os, []);
          }
          osGroups.get(ins.os).push(ins);
        }

        const dedupedInstallers = [];
        for (const [, candidates] of osGroups.entries()) {
          candidates.sort((a, b) => {
            const langDiff =
              (/^en/i.test(a.language || '') ? 0 : 1) - (/^en/i.test(b.language || '') ? 0 : 1);
            if (langDiff !== 0) return langDiff;
            return (b.totalSizeBytes || 0) - (a.totalSizeBytes || 0);
          });
          if (candidates[0]) {
            dedupedInstallers.push(candidates[0]);
          }
        }

        availableInstallers = dedupedInstallers;

        if (platform === 'win32') {
          availableInstallers = availableInstallers.map((i) => ({
            ...i,
            name: `${titleLabel} — Windows Native Build`,
          }));
        } else if (platform === 'darwin' && availableInstallers.length > 0) {
          const orderScore = (osVal) => (osVal === 'mac' ? 0 : osVal === 'windows' ? 1 : 2);
          availableInstallers.sort((a, b) => orderScore(a.os) - orderScore(b.os));
          const hasMacInstaller = availableInstallers.some((i) => i.os === 'mac');
          if (!hasMacInstaller) {
            availableInstallers = availableInstallers.map((i) =>
              i.os === 'windows'
                ? {
                    ...i,
                    name: `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`,
                  }
                : i
            );
          }
        }

        const bestSize =
          availableInstallers[0]?.totalSizeBytes ||
          availableInstallers.find((i) => i.totalSizeBytes)?.totalSizeBytes;
        if (bestSize) {
          estimatedSizeBytes = bestSize;
        }
      }

      if (!estimatedSizeBytes && productData?.description) {
        const parsedDescSize = parseStorageRequirementBytes(productData.description);
        if (parsedDescSize) {
          estimatedSizeBytes = parsedDescSize;
        }
      }

      // Public GOG Content System v2 fallback when product API installers are empty
      if (availableInstallers.length === 0 && !options.skipNetwork && !options.mockGogProductData) {
        const fetchBuilds = async (osType) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            const res = await fetch(
              `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${osType}/builds?generation=2`,
              { signal: controller.signal }
            );
            clearTimeout(timeout);
            if (res.ok) return await res.json();
          } catch {}
          clearTimeout(timeout);
          return null;
        };

        try {
          const [osxBuilds, winBuilds] = await Promise.all([
            platform === 'win32' ? Promise.resolve(null) : fetchBuilds('osx'),
            fetchBuilds('windows'),
          ]);
          const hasMacDepot =
            platform !== 'win32' && Array.isArray(osxBuilds?.items) && osxBuilds.items.length > 0;
          const hasWinDepot = Array.isArray(winBuilds?.items) && winBuilds.items.length > 0;

          if (hasMacDepot || hasWinDepot) {
            if (hasMacDepot) {
              availableInstallers.push({
                id: 'gog-mac-native',
                name: `${titleLabel} — Native macOS Build`,
                os: 'mac',
                language: 'en',
                totalSizeBytes: estimatedSizeBytes,
                version: normalizeInstallerVersion(osxBuilds.items[0]?.version_name),
              });
            }
            if (hasWinDepot) {
              availableInstallers.push({
                id: platform === 'win32' ? 'gog-win-native' : 'gog-win-compat',
                name:
                  platform === 'win32'
                    ? `${titleLabel} — Windows Native Build`
                    : platform === 'darwin' && !hasMacDepot
                      ? `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`
                      : `${titleLabel} — Windows Build`,
                os: 'windows',
                language: 'en',
                totalSizeBytes: estimatedSizeBytes,
                version: normalizeInstallerVersion(winBuilds.items[0]?.version_name),
              });
            }
          }
        } catch {}
      }

      // Invoke gogdl info fallback when estimatedSizeBytes is still unknown in live execution
      if (
        !estimatedSizeBytes &&
        cleanId &&
        !options.skipNetwork &&
        !options.mockGogProductData &&
        !options.homedir
      ) {
        try {
          const gogdlBin = findGogdlBinary(options);
          const gogAuthPath = authRes?.configPath || authRes?.gogAuthPath;
          if (gogdlBin && gogAuthPath && fs.existsSync(gogAuthPath)) {
            const gogOsFlag = platform === 'darwin' ? 'osx' : 'windows';
            const runGogdlInfo = (osFlag) =>
              new Promise((resolve) => {
                execFile(
                  gogdlBin,
                  ['--auth-config-path', gogAuthPath, 'info', cleanId, '--platform', osFlag],
                  { timeout: 5000 },
                  (err, stdout) => {
                    if (err || !stdout) return resolve(null);
                    try {
                      const jsonLine =
                        String(stdout || '')
                          .split(/\r?\n/)
                          .map((l) => l.trim())
                          .filter((l) => l.startsWith('{'))
                          .pop() || String(stdout || '').trim();
                      const parsed = JSON.parse(jsonLine);
                      let sz = Number(parsed?.download_size || parsed?.disk_size || 0);
                      if (
                        (!Number.isFinite(sz) || sz <= 0) &&
                        parsed?.size &&
                        typeof parsed.size === 'object'
                      ) {
                        const enSize =
                          parsed.size['en-US'] || parsed.size['en'] || parsed.size['*'];
                        sz = Number(enSize?.download_size || enSize?.disk_size || 0);
                        if (!Number.isFinite(sz) || sz <= 0) {
                          for (const val of Object.values(parsed.size)) {
                            const cand = Number(val?.download_size || val?.disk_size || 0);
                            if (cand > sz) sz = cand;
                          }
                        }
                      }
                      resolve(sz > 0 ? sz : null);
                    } catch {
                      resolve(null);
                    }
                  }
                );
              });
            let gogdlSize = await runGogdlInfo(gogOsFlag);
            if (!gogdlSize && gogOsFlag === 'osx') {
              gogdlSize = await runGogdlInfo('windows');
            }
            if (gogdlSize > 0) {
              estimatedSizeBytes = gogdlSize;
            }
          }
        } catch {}
      }

      if (estimatedSizeBytes > 0 && Array.isArray(availableInstallers)) {
        availableInstallers = availableInstallers.map((inst) => ({
          ...inst,
          totalSizeBytes: inst.totalSizeBytes || estimatedSizeBytes,
        }));
      }
    }

    const storeSupportsMac =
      availableInstallers.some((i) => i.os === 'mac') ||
      Boolean(productData?.content_system_compatibility?.osx) ||
      Boolean(payload.storePlatforms?.mac);
    const storeSupportsWin =
      availableInstallers.some((i) => i.os === 'windows') ||
      Boolean(productData?.content_system_compatibility?.windows) ||
      Boolean(payload.storePlatforms?.windows);

    if (
      platform === 'darwin' &&
      availableInstallers.some((i) => i.os === 'mac') &&
      !availableInstallers.some((i) => i.os === 'windows') &&
      (productData?.content_system_compatibility?.windows === true ||
        payload.storePlatforms?.windows === true)
    ) {
      availableInstallers.push({
        id: 'gog-win-compat',
        name: `${titleLabel} — Windows Build via CrossOver / Wine`,
        os: 'windows',
        language: 'en',
        totalSizeBytes: estimatedSizeBytes,
      });
    }

    if (estimatedSizeBytes && cleanId) {
      setBoundedMapEntry(
        installInfoSizeCache,
        `gog:${cleanId}:${platform}`,
        estimatedSizeBytes,
        MAX_DISCOVERY_CACHE_ENTRIES
      );
    }

    if (estimatedSizeBytes && availableInstallers.length > 0) {
      availableInstallers = availableInstallers.map((ins) => ({
        ...ins,
        totalSizeBytes: ins.totalSizeBytes || estimatedSizeBytes,
      }));
    }

    if (availableInstallers.length === 0) {
      const fallbackWinSize =
        estimatedSizeBytes || (options.homedir ? 2600 * 1024 * 1024 : undefined);
      const fallbackMacSize =
        estimatedSizeBytes || (options.homedir ? 2450 * 1024 * 1024 : undefined);
      if (platform === 'win32') {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Native Build`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
          },
        ];
      } else if (
        (payload.storePlatforms && payload.storePlatforms.mac === false) ||
        (productData?.content_system_compatibility &&
          productData.content_system_compatibility.osx === false &&
          storeSupportsWin)
      ) {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
          },
        ];
      } else if (
        payload.storePlatforms &&
        payload.storePlatforms.mac === true &&
        payload.storePlatforms.windows === false &&
        !storeSupportsWin
      ) {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: fallbackMacSize,
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: fallbackMacSize,
          },
          {
            id: 'gog-win-default',
            name: `${titleLabel} (Windows x64 Installer — CrossOver / Wine)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
          },
        ];
      }
    }
  } else if (platformId === 'epic') {
    const legendaryBin = findLegendaryBinary(options);
    canDirectDownload = Boolean(legendaryBin);
    requiresStoreClientFallback = !canDirectDownload;

    const epicInfo = resolveEpicAppAndPlatforms(payload, options);
    const titleLabel = payload.title || 'Game';
    const resolvedAppName =
      epicInfo.resolvedAppName || epicInfo.appName || platformGameId.replace(/^epic-/i, '');

    if (!estimatedSizeBytes && resolvedAppName && installInfoSizeCache.has(`epic:${resolvedAppName}:${platform}`)) {
      estimatedSizeBytes = installInfoSizeCache.get(`epic:${resolvedAppName}:${platform}`);
    }

    const userDataDir = getUserDataDir(options.userDataDir);

    if (!estimatedSizeBytes && resolvedAppName) {
      const installedJsonPaths = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json'),
        path.join(homedir, '.config', 'legendary', 'installed.json'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
        path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'installed.json'),
      ];
      for (const legInstalledPath of installedJsonPaths) {
        try {
          if (fs.existsSync(legInstalledPath)) {
            const rawInstalled = JSON.parse(fs.readFileSync(legInstalledPath, 'utf8'));
            const entry = rawInstalled?.[resolvedAppName];
            if (entry && Number(entry.install_size) > 0) {
              estimatedSizeBytes = Number(entry.install_size);
              break;
            }
          }
        } catch {}
      }
    }

    if (!estimatedSizeBytes && resolvedAppName) {
      const manifestDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'manifests'),
        path.join(homedir, '.config', 'legendary', 'manifests'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
        path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'manifests'),
      ];
      for (const mDir of manifestDirs) {
        try {
          if (!fs.existsSync(mDir)) continue;
          const files = fs.readdirSync(mDir);
          const matchFile = files.find(
            (f) =>
              f.endsWith('.manifest') &&
              (f.startsWith(`${resolvedAppName}_`) || f === `${resolvedAppName}.manifest`)
          );
          if (matchFile) {
            const parsed = parseEpicManifestBuffer(fs.readFileSync(path.join(mDir, matchFile)));
            if (parsed && (parsed.diskSize > 0 || parsed.downloadSize > 0)) {
              estimatedSizeBytes = parsed.diskSize || parsed.downloadSize;
              break;
            }
          }
        } catch {}
      }
    }

    if (!estimatedSizeBytes && resolvedAppName && !options.skipNetwork) {
      try {
        let namespace = epicInfo.namespace;
        let catalogItemId = epicInfo.catalogItemId;
        if (!namespace || !catalogItemId) {
          const metaDirs = [
            path.join(userDataDir, 'legendaryConfig', 'legendary', 'metadata'),
            path.join(homedir, '.config', 'legendary', 'metadata'),
            path.join(
              homedir,
              'Library',
              'Application Support',
              'heroic',
              'legendaryConfig',
              'legendary',
              'metadata'
            ),
            path.join(
              process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
              'heroic',
              'legendaryConfig',
              'legendary',
              'metadata'
            ),
            path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'metadata'),
          ];
          for (const metaDir of metaDirs) {
            const metaPath = path.join(metaDir, `${resolvedAppName}.json`);
            if (fs.existsSync(metaPath)) {
              try {
                const metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                namespace = namespace || metaJson?.namespace || metaJson?.metadata?.namespace;
                catalogItemId =
                  catalogItemId ||
                  metaJson?.id ||
                  metaJson?.catalog_item_id ||
                  metaJson?.metadata?.id;
                if (namespace && catalogItemId) break;
              } catch {}
            }
          }
        }

        const targetLegPlat = platform === 'darwin' && epicInfo.hasMacBuild ? 'Mac' : 'Windows';
        const legAuth = await ensureLegendaryConfigAndAuth(options);
        let accessToken = legAuth?.accessToken;

        if (accessToken && namespace && catalogItemId) {
          const assetsUrl = `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2/platform/${targetLegPlat}/namespace/${encodeURIComponent(namespace)}/catalogItem/${encodeURIComponent(catalogItemId)}/app/${encodeURIComponent(resolvedAppName)}/label/Live`;
          const fetchAssetsWithToken = async (token) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4500);
            try {
              const res = await fetch(assetsUrl, {
                signal: ctrl.signal,
                headers: {
                  Authorization: `Bearer ${token}`,
                  'User-Agent':
                    'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
                },
              });
              clearTimeout(t);
              return res;
            } catch (err) {
              clearTimeout(t);
              throw err;
            }
          };

          let assetsRes = await fetchAssetsWithToken(accessToken);
          if (
            (assetsRes.status === 401 || assetsRes.status === 403) &&
            legAuth?.refreshToken &&
            storeSync &&
            typeof storeSync.renewEpicTokens === 'function'
          ) {
            try {
              const renewed = await storeSync.renewEpicTokens(legAuth.refreshToken);
              if (renewed && renewed.access_token) {
                accessToken = renewed.access_token;
                try {
                  const existingUserPath = path.join(legAuth.legendaryConfigPath, 'user.json');
                  const baseUser = fs.existsSync(existingUserPath)
                    ? JSON.parse(fs.readFileSync(existingUserPath, 'utf8'))
                    : {};
                  const updatedUser = { ...baseUser, ...renewed };
                  fs.writeFileSync(existingUserPath, JSON.stringify(updatedUser, null, 2), 'utf8');
                  if (!options.homedir) {
                    const defaultUserPath = path.join(homedir, '.config/legendary/user.json');
                    if (fs.existsSync(path.dirname(defaultUserPath))) {
                      fs.writeFileSync(defaultUserPath, JSON.stringify(updatedUser, null, 2), 'utf8');
                    }
                  }
                } catch {}
                assetsRes = await fetchAssetsWithToken(accessToken);
              }
            } catch {}
          }

          if (assetsRes.ok) {
            const assetsData = await assetsRes.json();
            const manifests = assetsData?.elements?.[0]?.manifests || [];
            const manifestEntry = manifests.find((m) => m && m.uri);
            if (manifestEntry) {
              let manifestUrl = manifestEntry.uri;
              if (Array.isArray(manifestEntry.queryParams) && manifestEntry.queryParams.length > 0) {
                const qs = manifestEntry.queryParams
                  .filter((q) => q && q.name)
                  .map((q) => `${q.name}=${q.value}`)
                  .join('&');
                if (qs) {
                  manifestUrl += (manifestUrl.includes('?') ? '&' : '?') + qs;
                }
              }
              const mCtrl = new AbortController();
              const mTimeout = setTimeout(() => mCtrl.abort(), 5000);
              try {
                const manifestRes = await fetch(manifestUrl, { signal: mCtrl.signal });
                clearTimeout(mTimeout);
                if (manifestRes.ok) {
                  const manifestBuf = Buffer.from(await manifestRes.arrayBuffer());
                  const parsedManifest = parseEpicManifestBuffer(manifestBuf);
                  if (parsedManifest && (parsedManifest.diskSize > 0 || parsedManifest.downloadSize > 0)) {
                    estimatedSizeBytes = parsedManifest.diskSize || parsedManifest.downloadSize;
                  }
                }
              } catch {}
              clearTimeout(mTimeout);
            }
          }
        }
      } catch {}
    }

    if (
      !estimatedSizeBytes &&
      legendaryBin &&
      resolvedAppName &&
      !options.skipNetwork &&
      !options.disableLegendarySpawn &&
      !options.homedir
    ) {
      try {
        const legAuth = await ensureLegendaryConfigAndAuth(options);
        const targetLegPlat = platform === 'darwin' && epicInfo.hasMacBuild ? 'Mac' : 'Windows';
        const legSize = await new Promise((resolve) => {
          execFile(
            legendaryBin,
            ['info', resolvedAppName, '--platform', targetLegPlat, '--json'],
            { env: legAuth.env, timeout: 10000 },
            (err, stdout) => {
              if (err || !stdout) return resolve(null);
              try {
                const infoJson = JSON.parse(String(stdout).trim());
                const sz = Number(
                  infoJson?.manifest?.disk_size || infoJson?.manifest?.download_size || 0
                );
                resolve(sz > 0 ? sz : null);
              } catch {
                resolve(null);
              }
            }
          );
        });
        if (legSize) {
          estimatedSizeBytes = legSize;
        }
      } catch {}
    }

    if (!estimatedSizeBytes && !options.skipNetwork && payload.title) {
      const sCtrl = new AbortController();
      const sTimeout = setTimeout(() => sCtrl.abort(), 3000);
      try {
        const searchRes = await fetch(
          `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(payload.title)}&l=english&cc=US`,
          { signal: sCtrl.signal }
        );
        clearTimeout(sTimeout);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const normTarget = String(payload.title).toLowerCase().replace(/[^a-z0-9]/g, '');
          const matchedItem = (searchData?.items || []).find(
            (it) => String(it?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === normTarget
          ) || searchData?.items?.[0];
          if (matchedItem?.id) {
            const dCtrl = new AbortController();
            const dTimeout = setTimeout(() => dCtrl.abort(), 3000);
            try {
              const detRes = await fetch(
                `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(matchedItem.id)}`,
                {
                  signal: dCtrl.signal,
                  headers: {
                    Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
                  },
                }
              );
              clearTimeout(dTimeout);
              if (detRes.ok) {
                const detJson = await detRes.json();
                const appData = detJson?.[matchedItem.id]?.data;
                const pcReq = appData?.pc_requirements?.minimum || appData?.pc_requirements?.recommended;
                const macReq = appData?.mac_requirements?.minimum || appData?.mac_requirements?.recommended;
                const parsedSize =
                  (platform === 'darwin' ? parseStorageRequirementBytes(macReq) : undefined) ||
                  parseStorageRequirementBytes(pcReq) ||
                  parseStorageRequirementBytes(macReq);
                if (parsedSize) {
                  estimatedSizeBytes = parsedSize;
                }
              }
            } catch {}
            clearTimeout(dTimeout);
          }
        }
      } catch {}
      clearTimeout(sTimeout);
    }

    if (estimatedSizeBytes && resolvedAppName) {
      setBoundedMapEntry(
        installInfoSizeCache,
        `epic:${resolvedAppName}:${platform}`,
        estimatedSizeBytes,
        MAX_DISCOVERY_CACHE_ENTRIES
      );
    }

    if (platform === 'darwin') {
      if (epicInfo.hasMacBuild) {
        availableInstallers = [
          {
            id: 'epic-mac-native',
            name: `${titleLabel} (macOS Native Build)`,
            os: 'mac',
            totalSizeBytes: estimatedSizeBytes,
            version: epicInfo.macVersion,
          },
          {
            id: 'epic-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver / Wine)`,
            os: 'windows',
            totalSizeBytes: estimatedSizeBytes,
            version: epicInfo.winVersion,
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'epic-win-compat',
            name: `${titleLabel} (Windows Build — CrossOver / Wine Fallback, No macOS Native Build)`,
            os: 'windows',
            totalSizeBytes: estimatedSizeBytes,
            version: epicInfo.winVersion,
          },
        ];
      }
    } else {
      availableInstallers = [
        {
          id: 'epic-win-native',
          name: `${titleLabel} (Windows Native Build)`,
          os: 'windows',
          totalSizeBytes: estimatedSizeBytes,
          version: epicInfo.winVersion,
        },
      ];
    }
  } else if (platformId === 'steam') {
    canDirectDownload = false;
    requiresStoreClientFallback = true;
    const titleLabel = payload.title || 'Game';
    const cleanId = String(payload.steamAppId || platformGameId).replace(/^steam-/i, '');

    try {
      const { steamappsDirs } = discoverSteamLocations(options);
      if (Array.isArray(steamappsDirs) && steamappsDirs.length > 0) {
        const steamCommonDirs = steamappsDirs.map((d) => path.join(d, 'common'));
        defaultInstallDir = steamCommonDirs[0];
        availableInstallDirs = Array.from(new Set([...steamCommonDirs, ...availableInstallDirs]));
        diskSpace = getDiskSpace(payload.targetInstallDir || defaultInstallDir, options);
      }
      if (!estimatedSizeBytes && cleanId && Array.isArray(steamappsDirs)) {
        for (const dir of steamappsDirs) {
          const acfPath = path.join(dir, `appmanifest_${cleanId}.acf`);
          if (fs.existsSync(acfPath)) {
            const parsedAcf = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
            const acfSize = Number(parsedAcf?.SizeOnDisk || parsedAcf?.BytesToDownload || 0);
            if (acfSize > 0) {
              estimatedSizeBytes = acfSize;
              break;
            }
          }
        }
      }
    } catch {}

    if (!estimatedSizeBytes && cleanId && installInfoSizeCache.has(`steam:${cleanId}:${platform}`)) {
      estimatedSizeBytes = installInfoSizeCache.get(`steam:${cleanId}:${platform}`);
    }

    let macSupported = true;
    let winSupported = true;
    let platformSupportResolved = false;

    if (options.mockSteamAppDetails?.platforms) {
      const platData = options.mockSteamAppDetails.platforms;
      macSupported = Boolean(platData.mac);
      winSupported = Boolean(platData.windows);
      platformSupportResolved = true;
    } else if (payload.steamPlatforms && typeof payload.steamPlatforms === 'object') {
      macSupported = Boolean(payload.steamPlatforms.mac);
      winSupported = Boolean(payload.steamPlatforms.windows ?? true);
      if (cleanId) {
        steamPlatformSupportCache.set(cleanId, { macSupported, winSupported });
      }
      platformSupportResolved = true;
    } else if (cleanId && steamPlatformSupportCache.has(cleanId)) {
      const cachedPlat = steamPlatformSupportCache.get(cleanId);
      macSupported = Boolean(cachedPlat.macSupported);
      winSupported = Boolean(cachedPlat.winSupported);
      platformSupportResolved = true;
    }

    if (
      cleanId &&
      !options.skipNetwork &&
      !options.mockSteamAppDetails &&
      ((!platformSupportResolved && platform === 'darwin') || !estimatedSizeBytes)
    ) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(cleanId)}`,
          {
            signal: controller.signal,
            headers: {
              Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
            },
          }
        );
        clearTimeout(timeout);
        if (res.ok) {
          const appDetails = await res.json();
          const appData = appDetails?.[cleanId]?.data;
          const platData = appData?.platforms;
          if (platData && !platformSupportResolved) {
            macSupported = Boolean(platData.mac);
            winSupported = Boolean(platData.windows);
            steamPlatformSupportCache.set(cleanId, { macSupported, winSupported });
            platformSupportResolved = true;
          }
          if (!estimatedSizeBytes && appData) {
            const macReqText =
              appData.mac_requirements?.minimum || appData.mac_requirements?.recommended;
            const pcReqText =
              appData.pc_requirements?.minimum || appData.pc_requirements?.recommended;
            const parsedSize =
              (platform === 'darwin' ? parseStorageRequirementBytes(macReqText) : undefined) ||
              parseStorageRequirementBytes(pcReqText) ||
              parseStorageRequirementBytes(macReqText);
            if (parsedSize) {
              estimatedSizeBytes = parsedSize;
              setBoundedMapEntry(
                installInfoSizeCache,
                `steam:${cleanId}:${platform}`,
                estimatedSizeBytes,
                MAX_DISCOVERY_CACHE_ENTRIES
              );
            }
          }
        }
      } catch {}
      clearTimeout(timeout);
    }

    if (platform === 'darwin') {
      if (!macSupported && winSupported) {
        availableInstallers = [
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver — Windows Steam Bottle)`,
            os: 'windows',
            totalSizeBytes: estimatedSizeBytes,
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'steam-mac-native',
            name: `${titleLabel} (Steam Client — Native OS / Auto-Detect)`,
            os: 'mac',
            totalSizeBytes: estimatedSizeBytes,
          },
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver — Windows Steam Bottle)`,
            os: 'windows',
            totalSizeBytes: estimatedSizeBytes,
          },
        ];
      }
    } else {
      availableInstallers = [
        {
          id: 'steam-win-native',
          name: `${titleLabel} (Steam Client — Windows Native)`,
          os: 'windows',
          totalSizeBytes: estimatedSizeBytes,
        },
      ];
    }
  }

  return {
    platformId,
    platformGameId,
    hostPlatform: platform,
    estimatedSizeBytes,
    defaultInstallDir,
    availableInstallDirs,
    availableInstallers,
    canDirectDownload,
    requiresStoreClientFallback,
    diskSpace,
  };
}

function getDownloadQueue() {
  return Array.from(downloadQueueMap.values()).map((t) => ({ ...t }));
}

function sanitizeDirectoryName(title) {
  return String(title || 'Game')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Game';
}

function matchLast(text, globalRegex) {
  if (!text) return null;
  const matches = Array.from(String(text).matchAll(globalRegex));
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function parseCliSizeToBytes(valStr, unitStr = 'MiB') {
  const num = parseFloat(valStr);
  if (!Number.isFinite(num) || num < 0) return 0;
  const u = String(unitStr || 'MiB').toUpperCase();
  if (u === 'B' || u === 'BYTES') return Math.round(num);
  if (u === 'KIB' || u === 'KB') return Math.round(num * 1024);
  if (u === 'GIB' || u === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num * 1024 * 1024);
}

const downloadSpeedTrackers = new Map();

/**
 * Rolling Window + Exponential Moving Average (EMA) Download Speed Stabilizer.
 * Smooths out multi-threaded chunk decompression pauses (e.g. 0.5 MB/s single-chunk ticks)
 * and OS kernel TCP receive buffer bursts (e.g. 31 MB/s spikes), matching native storefront
 * readout behavior (Steam, GOG Galaxy, Epic Games Launcher).
 */
function computeSmoothedDownloadSpeed(taskId, sample = {}) {
  if (!taskId) return Math.max(0, Math.round(Number(sample.rawSpeedBytesPerSec || 0)));
  const now = typeof sample.nowMs === 'number' ? sample.nowMs : Date.now();
  const bytes =
    sample.bytesDownloaded !== undefined && sample.bytesDownloaded !== null
      ? Number(sample.bytesDownloaded)
      : undefined;
  const rawSpeed = Math.max(0, Math.round(Number(sample.rawSpeedBytesPerSec || 0)));
  const decompressedSpeed = Math.max(0, Math.round(Number(sample.decompressedSpeedBytesPerSec || 0)));

  let tracker = downloadSpeedTrackers.get(taskId);
  if (!tracker) {
    tracker = {
      emaSpeed: 0,
      samples: [],
      lastNonZeroTs: 0,
    };
    downloadSpeedTrackers.set(taskId, tracker);
  }

  tracker.samples.push({
    ts: now,
    bytes: bytes !== undefined && Number.isFinite(bytes) ? bytes : -1,
    rawSpeed,
  });

  while (tracker.samples.length > 2 && now - tracker.samples[0].ts > 6000) {
    tracker.samples.shift();
  }

  // 1. Compute 5-second rolling byte-delta window speed when cumulative bytes are available
  let rollingByteSpeed = 0;
  if (bytes !== undefined && bytes > 0) {
    for (let i = 0; i < tracker.samples.length - 1; i++) {
      const s = tracker.samples[i];
      const dtMs = now - s.ts;
      if (s.bytes >= 0 && bytes > s.bytes && dtMs >= 800 && dtMs <= 8000) {
        rollingByteSpeed = Math.round(((bytes - s.bytes) * 1000) / dtMs);
        break;
      }
    }
  }

  // 2. Compute rolling mean of recent raw speed samples, filtering isolated 1-tick decompression dips
  const recentRawSamples = tracker.samples
    .filter((s) => now - s.ts <= 5000 && s.rawSpeed > 0)
    .map((s) => s.rawSpeed);

  let rollingRawSpeed = 0;
  if (recentRawSamples.length >= 2) {
    const maxRecent = Math.max(...recentRawSamples);
    const filtered =
      maxRecent > 3 * 1024 * 1024
        ? recentRawSamples.filter((v) => v >= maxRecent * 0.25 || recentRawSamples.length <= 2)
        : recentRawSamples;
    const pool = filtered.length > 0 ? filtered : recentRawSamples;
    rollingRawSpeed = Math.round(pool.reduce((a, b) => a + b, 0) / pool.length);
  } else if (recentRawSamples.length === 1) {
    rollingRawSpeed = recentRawSamples[0];
  }

  // 3. Combine raw speed and rolling window speed
  let targetSpeed = rawSpeed;
  if (rawSpeed > 0 && rollingByteSpeed > 0) {
    if (tracker.emaSpeed > 2 * 1024 * 1024 && rawSpeed < tracker.emaSpeed * 0.35) {
      targetSpeed = Math.max(rollingByteSpeed, rollingRawSpeed);
    } else if (tracker.emaSpeed > 2 * 1024 * 1024 && rawSpeed > tracker.emaSpeed * 1.45) {
      targetSpeed = Math.round(rollingByteSpeed * 0.65 + rawSpeed * 0.35);
    } else {
      targetSpeed = Math.round(rawSpeed * 0.5 + rollingByteSpeed * 0.5);
    }
  } else if (rawSpeed <= 0 && rollingByteSpeed > 0) {
    targetSpeed = rollingByteSpeed;
  } else if (rawSpeed > 0 && rollingRawSpeed > 0 && recentRawSamples.length >= 2) {
    targetSpeed = Math.round(rawSpeed * 0.45 + rollingRawSpeed * 0.55);
  }

  // 4. First valid reading initializes EMA immediately
  if (tracker.emaSpeed <= 0) {
    if (targetSpeed > 0) {
      tracker.emaSpeed = targetSpeed;
      tracker.lastNonZeroTs = now;
    }
    return tracker.emaSpeed;
  }

  // 5. Apply asymmetric EMA damping to suppress single-tick decompression dips and buffer burst spikes
  if (targetSpeed > 0) {
    tracker.lastNonZeroTs = now;
    const ratio = targetSpeed / tracker.emaSpeed;
    if (ratio < 0.35) {
      // Single-tick decompression pause (e.g. 0.5 MB/s while worker threads decompress/write chunks)
      const alpha = decompressedSpeed > 1024 * 1024 ? 0.05 : 0.10;
      const damped = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
      tracker.emaSpeed = Math.max(damped, Math.round(tracker.emaSpeed * 0.88));
    } else if (ratio > 1.45) {
      // Single-tick TCP receive buffer burst (e.g. 31 MB/s spike right after decompression completes)
      const alpha = 0.22;
      tracker.emaSpeed = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
    } else {
      const alpha = 0.28;
      tracker.emaSpeed = Math.round(tracker.emaSpeed * (1 - alpha) + targetSpeed * alpha);
    }
  } else if (now - tracker.lastNonZeroTs < 4000) {
    tracker.emaSpeed = Math.round(tracker.emaSpeed * 0.9);
  } else {
    tracker.emaSpeed = 0;
  }

  return tracker.emaSpeed;
}

/**
 * Remove stale gogdl cached manifest for a game ID so fresh installs into empty directories
 * never skip downloading due to a leftover heroic_gogdl/manifests/<cleanId> cache file.
 */
function clearStaleGogdlManifestCache(cleanId, options = {}) {
  if (!cleanId) return;
  const homedir = options.homedir || os.homedir();
  const idStr = String(cleanId).replace(/^gog[-_]/i, '').trim();
  if (!idStr) return;

  const candidateManifestPaths = [
    path.join(homedir, 'Library/Application Support/heroic_gogdl/manifests', idStr),
    path.join(homedir, '.config/heroic_gogdl/manifests', idStr),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData/Roaming'),
      'heroic_gogdl/manifests',
      idStr
    ),
  ];

  for (const manifestPath of candidateManifestPaths) {
    try {
      if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
        fs.unlinkSync(manifestPath);
      }
    } catch {}
  }
}

/**
 * Update a download task state and notify all listeners
 */
function updateDownloadTask(taskId, partial = {}, options = {}) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const prevProgress = Number(task.progressPercent || 0);
  const prevBytes = Number(task.bytesDownloaded || 0);
  const prevStatus = task.status;

  Object.assign(task, partial);

  if (
    task.totalBytes > 0 &&
    partial.bytesDownloaded !== undefined &&
    partial.progressPercent === undefined &&
    !task.hasExplicitCliProgress
  ) {
    task.progressPercent = Math.min(100, Math.round((task.bytesDownloaded / task.totalBytes) * 100));
  }

  if (
    ['downloading', 'extracting', 'verifying'].includes(task.status) &&
    prevStatus !== 'queued'
  ) {
    if (task.progressPercent < prevProgress && task.status !== 'completed') {
      task.progressPercent = prevProgress;
    }
    if (task.bytesDownloaded < prevBytes && task.status !== 'completed') {
      task.bytesDownloaded = prevBytes;
    }
    if (
      task.totalBytes > 0 &&
      task.bytesDownloaded > task.totalBytes &&
      task.status !== 'completed'
    ) {
      task.totalBytes = task.bytesDownloaded;
    }
  }

  if (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled' ||
    task.status === 'paused'
  ) {
    downloadSpeedTrackers.delete(taskId);
  }

  if (task.status === 'completed') {
    task.progressPercent = 100;
    task.speedBytesPerSec = 0;
    task.etaSeconds = 0;
    task.completedAt = task.completedAt || new Date().toISOString();
    task.finalInstallPath =
      task.finalInstallPath || path.join(task.installDir, sanitizeDirectoryName(task.title));

    upsertManagedInstallRecord(
      {
        platformId: task.platformId,
        platformGameId: task.platformGameId,
        appId: task.platformId === 'steam' ? task.steamAppId : undefined,
        title: task.title,
        installPath: task.finalInstallPath,
        executablePath: task.executablePath,
        installSize: task.totalBytes,
        runner: task.runner || 'one_launcher',
        isWindowsBinaryOnMac: task.isWindowsBinaryOnMac,
      },
      options.userDataDir
    );
  }

  emitDownloadUpdated({
    task: { ...task },
    queue: getDownloadQueue(),
  });

  return {
    success: true,
    task: { ...task },
  };
}

/**
 * Ensure Windows Steam (steam.exe) is installed inside a CrossOver / Wine bottle on macOS.
 * Downloads SteamSetup.exe and runs silent install (/S) if steam.exe is not yet present.
 */
async function ensureWindowsSteamInBottle(layer, bottleName, bottlePath, taskId, options = {}) {
  if (!bottlePath) return null;
  const existingSteamExe = resolveBottleSteamExe(bottlePath);
  if (existingSteamExe) return existingSteamExe;

  if (
    options.disableWineSteamSpawn ||
    options.homedir ||
    !layer?.binaryPath ||
    !fs.existsSync(layer.binaryPath)
  ) {
    return null;
  }

  try {
    if (taskId) {
      updateDownloadTask(
        taskId,
        {
          statusMessage: 'Bootstrapping Windows Steam client inside CrossOver bottle...',
        },
        options
      );
    }

    const tempDir = path.join(bottlePath, 'drive_c/windows/temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const steamSetupPath = path.join(tempDir, 'SteamSetup.exe');

    if (!fs.existsSync(steamSetupPath) && typeof fetch === 'function') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch('https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe', {
          signal: controller.signal,
        });
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          fs.writeFileSync(steamSetupPath, Buffer.from(arrayBuf));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!fs.existsSync(steamSetupPath)) {
      return null;
    }

    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(maxTimer);
        resolve();
      };

      const pollTimer = setInterval(() => {
        if (resolveBottleSteamExe(bottlePath)) {
          done();
        }
      }, 500);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();

      const maxTimer = setTimeout(done, 45000);
      if (typeof maxTimer.unref === 'function') maxTimer.unref();

      try {
        const child = spawn(layer.binaryPath, [steamSetupPath, '/S'], {
          env: {
            ...process.env,
            CX_BOTTLE: bottleName,
            WINEPREFIX: bottlePath,
          },
          stdio: 'ignore',
        });
        child.on('error', done);
        child.on('exit', done);
      } catch {
        done();
      }
    });

    return resolveBottleSteamExe(bottlePath);
  } catch {
    return null;
  }
}

async function sweepStaleGogTempBinsAsync(targetDirs = []) {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const activeBinPaths = new Set();
  for (const [, t] of downloadQueueMap.entries()) {
    if (
      t &&
      t.tempBinPath &&
      ['downloading', 'paused', 'queued', 'extracting', 'verifying'].includes(t.status)
    ) {
      activeBinPaths.add(path.resolve(t.tempBinPath));
    }
  }
  const now = Date.now();
  for (const dir of targetDirs) {
    if (!dir || typeof dir !== 'string') continue;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && /^\.gog_v1_.*_main\.bin$/i.test(ent.name)) {
        const fullPath = path.join(dir, ent.name);
        if (activeBinPaths.has(path.resolve(fullPath))) continue;
        try {
          const st = await fs.promises.stat(fullPath);
          if (now - st.mtimeMs > SEVEN_DAYS_MS) {
            await fs.promises.unlink(fullPath);
          }
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            diagLog.warn('sweepStaleGogTempBinsAsync.unlink', err, { fullPath });
          }
        }
      }
    }
  }
}

/**
 * Start a game download / installation task
 */
async function installGame(payload = {}, optionsOrProgress = {}, maybeOptions = {}) {
  const options =
    typeof optionsOrProgress === 'function'
      ? { ...(maybeOptions || {}), onProgress: optionsOrProgress }
      : optionsOrProgress || {};
  try {
    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const platformId = payload.platformId || 'custom';
    const platformGameId = String(payload.platformGameId || payload.gameId || '');
    const gameId = String(payload.gameId || `${platformId}-${platformGameId}`);
    const title = String(payload.title || gameId);
    const installDir = payload.installDir || getDefaultInstallDir(platformId, options);
    const isSimulatedOrManual = Boolean(
      payload.manualControl ||
        payload.mockDownload ||
        payload.simulateDownload ||
        options.simulateDownload
    );
    const totalBytes = Number(
      payload.totalBytes ||
        payload.estimatedSizeBytes ||
        (isSimulatedOrManual ? 120 * 1024 * 1024 : 0)
    );
    const initialSpeed = isSimulatedOrManual ? 18 * 1024 * 1024 : 0;
    const initialEta =
      isSimulatedOrManual && totalBytes > 0
        ? Math.max(1, Math.round(totalBytes / (18 * 1024 * 1024)))
        : undefined;

    try {
      if (!fs.existsSync(installDir)) {
        fs.mkdirSync(installDir, { recursive: true });
      }
    } catch {}

    const taskId = payload.taskId || `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const finalInstallPath = path.join(installDir, sanitizeDirectoryName(title));
    if (platformId === 'gog' && !isSimulatedOrManual) {
      sweepStaleGogTempBinsAsync([installDir, finalInstallPath]).catch(() => {});
    }
    const existingResumedTask =
      payload._resumingPausedInstall && downloadQueueMap.has(taskId)
        ? downloadQueueMap.get(taskId)
        : null;

    const sanitizedInstallRequest = {
      gameId,
      title,
      platformId,
      platformGameId,
      ...(payload.steamAppId ? { steamAppId: payload.steamAppId } : {}),
      installDir,
      ...(payload.os ? { os: payload.os } : {}),
      ...(payload.installerId ? { installerId: payload.installerId } : {}),
      includeDlcs: Boolean(payload.includeDlcs),
      ...(payload.headerImage ? { headerImage: payload.headerImage } : {}),
      ...(totalBytes > 0 ? { estimatedSizeBytes: totalBytes } : {}),
    };

    const task = {
      taskId,
      gameId,
      title,
      platformId,
      platformGameId,
      steamAppId: payload.steamAppId ? Number(payload.steamAppId) : undefined,
      headerImage: payload.headerImage,
      installDir,
      status: 'downloading',
      progressPercent: existingResumedTask ? Number(existingResumedTask.progressPercent || 0) : 0,
      bytesDownloaded: existingResumedTask ? Number(existingResumedTask.bytesDownloaded || 0) : 0,
      totalBytes:
        existingResumedTask && Number(existingResumedTask.totalBytes || 0) > 0
          ? Number(existingResumedTask.totalBytes)
          : totalBytes,
      speedBytesPerSec: initialSpeed,
      etaSeconds: initialEta,
      statusMessage: existingResumedTask ? `Resuming ${title}...` : `Downloading ${title}...`,
      startedAt: existingResumedTask?.startedAt || new Date().toISOString(),
      finalInstallPath,
      manualControl: Boolean(payload.manualControl),
      isSimulatedOrManual,
      installRequest: existingResumedTask?.installRequest || sanitizedInstallRequest,
    };

    downloadQueueMap.set(taskId, task);
    emitDownloadUpdated({ task: { ...task }, queue: getDownloadQueue() });

    // If caller requests manual control (e.g. unit tests testing state transitions), keep in 'downloading' state
    if (payload.manualControl) {
      return {
        success: true,
        message: `Queued installation for ${title}`,
        task: { ...task },
      };
    }

    // Simulated / Mock progressive download
    if (payload.mockDownload || payload.simulateDownload || options.simulateDownload) {
      const stepMs = Number(payload.stepIntervalMs || 60);
      const timer = setInterval(() => {
        const current = downloadQueueMap.get(taskId);
        if (!current || current.status === 'cancelled' || current.status === 'completed' || current.status === 'failed') {
          clearInterval(timer);
          return;
        }
        if (current.status === 'paused') {
          return;
        }

        const nextBytes = Math.min(current.totalBytes, current.bytesDownloaded + Math.ceil(current.totalBytes * 0.25));
        const pct = Math.min(100, Math.round((nextBytes / current.totalBytes) * 100));

        if (pct < 100) {
          updateDownloadTask(
            taskId,
            {
              bytesDownloaded: nextBytes,
              progressPercent: pct,
              speedBytesPerSec: 24 * 1024 * 1024,
              etaSeconds: Math.max(1, Math.round((current.totalBytes - nextBytes) / (24 * 1024 * 1024))),
              statusMessage: `Downloading ${current.title} (${pct}%)...`,
            },
            options
          );
        } else {
          clearInterval(timer);
          updateDownloadTask(
            taskId,
            {
              status: 'extracting',
              bytesDownloaded: current.totalBytes,
              progressPercent: 100,
              speedBytesPerSec: 0,
              statusMessage: `Extracting ${current.title}...`,
            },
            options
          );

          try {
            if (!fs.existsSync(finalInstallPath)) {
              fs.mkdirSync(finalInstallPath, { recursive: true });
            }
            const exePath =
              platform === 'darwin'
                ? path.join(finalInstallPath, `${sanitizeDirectoryName(title)}.sh`)
                : path.join(finalInstallPath, `${sanitizeDirectoryName(title)}.exe`);
            fs.writeFileSync(exePath, '#!/bin/sh\necho "Running"\n', { mode: 0o755 });
            current.executablePath = exePath;
          } catch {}

          updateDownloadTask(
            taskId,
            {
              status: 'completed',
              statusMessage: 'Installation complete',
              executablePath: current.executablePath,
            },
            options
          );
        }
      }, stepMs);
      if (typeof timer.unref === 'function') timer.unref();
      downloadControllers.set(taskId, { type: 'timer', timer });

      return {
        success: true,
        message: `Started installation for ${title}`,
        task: { ...task },
      };
    }

    // Storefront-specific installation handlers
    if (platformId === 'steam') {
      const appId = payload.steamAppId || platformGameId.replace(/^steam-/i, '');
      const isWinCompatInstall =
        platform === 'darwin' &&
        (payload.os === 'windows' || payload.installerId === 'steam-win-compat');
      let launchedViaWineSteam = false;
      const layers = isWinCompatInstall ? detectCompatibilityLayers(options) : [];

      if (isWinCompatInstall && !options.disableWineSteamSpawn && layers.length > 0) {
        const existingConfigs = getGameLaunchConfigs(options);
        const rawExistingConfig = (payload.gameId && existingConfigs[payload.gameId]) || {};
        const existingConfig = resolvePlatformLaunchConfig(rawExistingConfig, 'steam');
        const requestedLayerType = payload.compatibilityLayer || existingConfig.compatibilityLayer;
        const preferredLayer =
          (requestedLayerType && layers.find((l) => l.type === requestedLayerType)) ||
          layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview') ||
          layers[0];

        const env = { ...process.env };
        await ensureCompatibilityLayerReady(preferredLayer, existingConfig, env, options);

        const candidateBottles = [];
        const targetBottleName =
          payload.wineBottleName ||
          existingConfig.wineBottleName ||
          env.CX_BOTTLE ||
          (Array.isArray(preferredLayer.availableBottles) && preferredLayer.availableBottles[0]) ||
          'OneLauncher';
        const targetBottlePath =
          env.WINEPREFIX ||
          (preferredLayer.bottlesDir ? path.join(preferredLayer.bottlesDir, targetBottleName) : '');

        if (targetBottlePath) {
          candidateBottles.push({
            layer: preferredLayer,
            bottleName: targetBottleName,
            bottlePath: targetBottlePath,
          });
        }

        for (const layer of layers) {
          if (!layer.bottlesDir || !Array.isArray(layer.availableBottles)) continue;
          for (const bottleName of layer.availableBottles) {
            const bottlePath = path.join(layer.bottlesDir, bottleName);
            if (!candidateBottles.some((b) => b.bottlePath === bottlePath)) {
              candidateBottles.push({ layer, bottleName, bottlePath });
            }
          }
        }

        let resolvedTarget = null;
        for (const cand of candidateBottles) {
          const foundSteamExe = resolveBottleSteamExe(cand.bottlePath);
          if (foundSteamExe) {
            resolvedTarget = { ...cand, foundSteamExe };
            break;
          }
        }

        if (
          !resolvedTarget &&
          targetBottlePath &&
          preferredLayer.binaryPath &&
          fs.existsSync(preferredLayer.binaryPath)
        ) {
          const bootstrappedExe = await ensureWindowsSteamInBottle(
            preferredLayer,
            targetBottleName,
            targetBottlePath,
            taskId,
            options
          );
          if (bootstrappedExe) {
            resolvedTarget = {
              layer: preferredLayer,
              bottleName: targetBottleName,
              bottlePath: targetBottlePath,
              foundSteamExe: bootstrappedExe,
            };
          }
        }

        if (
          resolvedTarget &&
          resolvedTarget.foundSteamExe &&
          resolvedTarget.layer.binaryPath &&
          fs.existsSync(resolvedTarget.layer.binaryPath)
        ) {
          try {
            const child = spawn(
              resolvedTarget.layer.binaryPath,
              [resolvedTarget.foundSteamExe, `steam://install/${appId}`],
              {
                env: {
                  ...process.env,
                  ...env,
                  CX_BOTTLE: resolvedTarget.bottleName,
                  WINEPREFIX: resolvedTarget.bottlePath,
                },
                stdio: 'ignore',
                detached: true,
              }
            );
            if (typeof child.unref === 'function') child.unref();
            launchedViaWineSteam = true;

            if (payload.gameId) {
              try {
                saveGameLaunchConfig(
                  {
                    ...existingConfig,
                    gameId: payload.gameId,
                    preferredPlatformId: 'steam',
                    launchMethod: 'compatibility_layer',
                    compatibilityLayer: resolvedTarget.layer.type,
                    wineBottleName: resolvedTarget.bottleName,
                  },
                  options
                );
              } catch {}
            }
          } catch {}
        }
      } else if (platform === 'darwin' && !isWinCompatInstall && payload.gameId) {
        try {
          const existingConfigs = getGameLaunchConfigs(options);
          const rawExistingConfig = existingConfigs[payload.gameId] || {};
          const existingConfig = resolvePlatformLaunchConfig(rawExistingConfig, 'steam');
          if (existingConfig?.launchMethod === 'compatibility_layer') {
            saveGameLaunchConfig(
              {
                ...existingConfig,
                gameId: payload.gameId,
                preferredPlatformId: 'steam',
                launchMethod: 'auto',
              },
              options
            );
          }
        } catch {}
      }

      if (
        !launchedViaWineSteam &&
        (!isWinCompatInstall || options.disableWineSteamSpawn || layers.length === 0)
      ) {
        await openExternalUri(`steam://install/${appId}`, options);
      }

      updateDownloadTask(
        taskId,
        {
          statusMessage: launchedViaWineSteam
            ? 'Installing via Windows Steam in CrossOver / Wine (monitoring appmanifest)...'
            : 'Installing via Steam client (monitoring appmanifest & content_log)...',
        },
        options
      );

      if (!options.disableSteamMonitor) {
        startSteamInstallMonitor(taskId, appId, options);
      }
    } else if (platformId === 'epic') {
      const legendaryBin = findLegendaryBinary(options);
      const epicInfo = resolveEpicAppAndPlatforms(payload, options);
      const resolvedAppName =
        epicInfo.resolvedAppName || platformGameId.replace(/^epic-/i, '') || platformGameId;

      let epicPlatformFlag = 'Windows';
      if (platform === 'darwin') {
        if (payload.os === 'windows' || payload.installerId === 'epic-win-compat') {
          epicPlatformFlag = 'Windows';
        } else {
          epicPlatformFlag = epicInfo.hasMacBuild ? 'Mac' : 'Windows';
        }
      }

      if (legendaryBin && !options.disableLegendarySpawn) {
        try {
          const authInfo = await ensureLegendaryConfigAndAuth({
            ...options,
            allowInteractiveAuth: true,
          });
          const spawnArgs = [
            'install',
            resolvedAppName,
            '--platform',
            epicPlatformFlag,
            '--base-path',
            installDir,
            payload.includeDlcs === true ? '--with-dlcs' : '--skip-dlcs',
            '--skip-sdl',
            '-y',
          ];

          const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
          const child = spawnImpl(legendaryBin, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: authInfo.env,
            ...(typeof options.spawnFn !== 'function' && platform !== 'win32'
              ? { detached: true }
              : {}),
          });
          const ctrl = {
            type: 'process',
            child,
            pausedByUser: false,
            cancelRequested: false,
            exitedWhilePaused: false,
            resumeInstallFn: () =>
              installGame({ ...payload, taskId, _resumingPausedInstall: true }, options),
          };
          downloadControllers.set(taskId, ctrl);

          let lastErrorLine = '';
          let sawAuthFailure = false;

          const onOutput = (chunk) => {
            const text = String(chunk || '');
            if (
              /login failed! cannot continue with download process|stored credentials are no longer valid|invalid_refresh_token|errors\.com\.epicgames\.account\.auth_token/i.test(
                text
              )
            ) {
              sawAuthFailure = true;
            }
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
              const errMatch = line.match(/(?:ERROR|CRITICAL):\s*(.+)/i);
              if (errMatch && errMatch[1]) {
                lastErrorLine = errMatch[1].trim();
              }
            }

            const currentTask = downloadQueueMap.get(taskId);
            if (!currentTask) return;

            const dlSizeMatch = matchLast(text, /Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/gi);
            if (dlSizeMatch) {
              const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
              if (parsedTotal > 0) {
                currentTask.totalBytes = parsedTotal;
                currentTask.hasExactDownloadSize = true;
              }
            }

            const pctMatch = matchLast(text, /Progress:\s*([\d.]+)%?/gi);
            const dlMiBMatch = matchLast(text, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
            const speedMatch =
              matchLast(text, /\+\s*Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s/gi) ||
              matchLast(text, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
            const decompMatch = matchLast(
              text,
              /\/\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s\s*\(decompressed\)/gi
            );
            const etaMatch = matchLast(text, /ETA:\s*(\d+):(\d+):(\d+)/gi);

            if (pctMatch || dlMiBMatch || speedMatch || etaMatch) {
              const partialUpdate = {};
              if (pctMatch) {
                currentTask.hasExplicitCliProgress = true;
                partialUpdate.progressPercent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
              } else {
                partialUpdate.progressPercent = currentTask.progressPercent;
              }
              if (dlMiBMatch) {
                currentTask.hasExplicitCliBytes = true;
                partialUpdate.bytesDownloaded = parseCliSizeToBytes(
                  dlMiBMatch[1],
                  dlMiBMatch[2] || 'MiB'
                );
              } else if (
                pctMatch &&
                !currentTask.hasExplicitCliBytes &&
                partialUpdate.bytesDownloaded === undefined
              ) {
                partialUpdate.bytesDownloaded = Math.round(
                  (partialUpdate.progressPercent / 100) * currentTask.totalBytes
                );
              }
              const rawCliSpeed = speedMatch
                ? parseCliSizeToBytes(speedMatch[1], speedMatch[2] || 'MiB')
                : 0;
              const decompCliSpeed = decompMatch
                ? parseCliSizeToBytes(decompMatch[1], decompMatch[2] || 'MiB')
                : 0;
              if (speedMatch || partialUpdate.bytesDownloaded !== undefined) {
                const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
                  bytesDownloaded:
                    partialUpdate.bytesDownloaded !== undefined
                      ? partialUpdate.bytesDownloaded
                      : currentTask.bytesDownloaded,
                  rawSpeedBytesPerSec: rawCliSpeed,
                  decompressedSpeedBytesPerSec: decompCliSpeed,
                });
                if (smoothedSpeed > 0 || speedMatch) {
                  partialUpdate.speedBytesPerSec = smoothedSpeed;
                }
              }
              if (etaMatch) {
                const cliEta =
                  parseInt(etaMatch[1], 10) * 3600 +
                  parseInt(etaMatch[2], 10) * 60 +
                  parseInt(etaMatch[3], 10);
                const activeSpeed =
                  partialUpdate.speedBytesPerSec || currentTask.speedBytesPerSec || 0;
                const activeBytes =
                  partialUpdate.bytesDownloaded !== undefined
                    ? partialUpdate.bytesDownloaded
                    : currentTask.bytesDownloaded;
                if (
                  currentTask.etaSeconds > 0 &&
                  cliEta > currentTask.etaSeconds * 3 &&
                  activeSpeed > 0 &&
                  currentTask.totalBytes > activeBytes
                ) {
                  partialUpdate.etaSeconds = Math.max(
                    1,
                    Math.round((currentTask.totalBytes - activeBytes) / activeSpeed)
                  );
                } else {
                  partialUpdate.etaSeconds = cliEta;
                }
              }
              const displayPct =
                partialUpdate.progressPercent !== undefined
                  ? partialUpdate.progressPercent
                  : currentTask.progressPercent;
              partialUpdate.statusMessage = `Installing ${
                epicPlatformFlag === 'Mac' ? 'macOS build' : 'Windows build'
              } via Legendary (${displayPct}%)...`;

              updateDownloadTask(taskId, partialUpdate, options);
            }
          };

          if (child.stdout) child.stdout.on('data', onOutput);
          if (child.stderr) child.stderr.on('data', onOutput);
          child.on('exit', async (code) => {
            const currentTask = downloadQueueMap.get(taskId);
            if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
              ctrl.exitedWhilePaused = true;
              ctrl.child = null;
              return;
            }
            downloadControllers.delete(taskId);
            if (currentTask && currentTask.status === 'cancelled') return;

            if (code === 0) {
              // Inspect installed.json to resolve actual install_path and executable
              let installedEntry = null;
              const candidateInstalledFiles = [
                path.join(authInfo.legendaryConfigPath, 'installed.json'),
                path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'),
                path.join(
                  process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
                  'heroic',
                  'legendaryConfig',
                  'legendary',
                  'installed.json'
                ),
                path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'installed.json'),
                path.join(homedir, '.config/legendary/installed.json'),
              ];
              for (const instFile of candidateInstalledFiles) {
                if (!fs.existsSync(instFile)) continue;
                try {
                  const raw = JSON.parse(fs.readFileSync(instFile, 'utf8'));
                  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    installedEntry = raw[resolvedAppName] || raw[platformGameId] || null;
                  } else if (Array.isArray(raw)) {
                    installedEntry = raw.find(
                      (x) =>
                        x &&
                        (x.app_name === resolvedAppName || x.app_name === platformGameId)
                    );
                  }
                  if (installedEntry) break;
                } catch {}
              }

              const actualInstallPath =
                installedEntry && (installedEntry.install_path || installedEntry.installPath)
                  ? toLocalFsPath(installedEntry.install_path || installedEntry.installPath)
                  : fs.existsSync(finalInstallPath)
                    ? finalInstallPath
                    : installDir;

              // Prioritize manifest installedEntry.executable (e.g., EAC/BattlEye bootstrapper) if present on disk
              let executablePath = undefined;
              if (installedEntry?.executable) {
                const cleanExe = String(installedEntry.executable).replace(/\\/g, path.sep);
                const candidateManifestExe = path.isAbsolute(cleanExe)
                  ? cleanExe
                  : path.join(actualInstallPath, cleanExe);
                if (fs.existsSync(candidateManifestExe)) {
                  executablePath = candidateManifestExe.toLowerCase().endsWith('.app')
                    ? resolveMacAppBundleBinary(candidateManifestExe)
                    : candidateManifestExe;
                }
              }

              const exeDiscovery = findPrimaryExecutable(actualInstallPath, {
                platform,
                hintName: title,
                preferWindowsExecutable: platform === 'darwin' && epicPlatformFlag === 'Windows',
              });

              if (!executablePath) {
                executablePath = exeDiscovery.executablePath;
                if (!executablePath && installedEntry?.executable) {
                  const cleanExe = String(installedEntry.executable).replace(/\\/g, path.sep);
                  executablePath = path.isAbsolute(cleanExe)
                    ? cleanExe
                    : path.join(actualInstallPath, cleanExe);
                }
              }

              const isWindowsBinaryOnMac =
                platform === 'darwin' &&
                (epicPlatformFlag === 'Windows' ||
                  Boolean(executablePath && executablePath.toLowerCase().endsWith('.exe')) ||
                  Boolean(!executablePath && exeDiscovery.isWindowsBinaryOnMac));

              const installSize =
                Number(installedEntry?.install_size || 0) || currentTask?.totalBytes || totalBytes;

              upsertManagedInstallRecord(
                {
                  platformId: 'epic',
                  platformGameId,
                  title,
                  installPath: actualInstallPath,
                  executablePath,
                  installSize,
                  version: installedEntry?.version ? String(installedEntry.version) : undefined,
                  runner: 'legendary',
                  isWindowsBinaryOnMac,
                },
                options.userDataDir
              );

              if (resolvedAppName && resolvedAppName !== platformGameId) {
                upsertManagedInstallRecord(
                  {
                    platformId: 'epic',
                    platformGameId: resolvedAppName,
                    title,
                    installPath: actualInstallPath,
                    executablePath,
                    installSize,
                    version: installedEntry?.version ? String(installedEntry.version) : undefined,
                    runner: 'legendary',
                    isWindowsBinaryOnMac,
                  },
                  options.userDataDir
                );
              }

              try {
                syncEpicFirstPartyLauncher({ ...options, runLegendaryEglSync: true });
              } catch {}

              if (platform === 'darwin' && !isWindowsBinaryOnMac) {
                try {
                  ensureMacAppCodeSignatureValid(executablePath || actualInstallPath, options);
                } catch {}
              }

              updateDownloadTask(
                taskId,
                {
                  status: 'completed',
                  progressPercent: 100,
                  bytesDownloaded: installSize,
                  totalBytes: installSize,
                  finalInstallPath: actualInstallPath,
                  executablePath,
                  runner: 'legendary',
                  isWindowsBinaryOnMac,
                  statusMessage:
                    epicPlatformFlag === 'Mac'
                      ? 'Installed native macOS build via Legendary'
                      : 'Installed Windows build via Legendary',
                },
                options
              );
            } else {
              if (sawAuthFailure && !payload._retriedAfterReauth) {
                updateDownloadTask(
                  taskId,
                  {
                    statusMessage:
                      'Epic Games session expired — refreshing authentication and retrying install...',
                  },
                  options
                );

                try {
                  const staleUserJson = path.join(authInfo.legendaryConfigPath, 'user.json');
                  if (fs.existsSync(staleUserJson)) {
                    fs.unlinkSync(staleUserJson);
                  }
                } catch {}

                const retryAuth = await ensureLegendaryConfigAndAuth({
                  ...options,
                  forceTokenRefresh: true,
                  allowInteractiveAuth: true,
                });

                if (retryAuth?.authenticated && retryAuth?.accessToken) {
                  await installGame(
                    {
                      ...payload,
                      taskId,
                      _retriedAfterReauth: true,
                    },
                    options
                  );
                  return;
                }

                const expiredMsg =
                  'Epic Games session expired. Please reconnect your Epic Games account in Store Connections and try installing again.';
                updateDownloadTask(
                  taskId,
                  {
                    status: 'failed',
                    speedBytesPerSec: 0,
                    etaSeconds: undefined,
                    error: expiredMsg,
                    statusMessage: expiredMsg,
                  },
                  options
                );
                return;
              }

              const errMsg = lastErrorLine || `Legendary exited with code ${code}`;
              updateDownloadTask(
                taskId,
                {
                  status: 'failed',
                  speedBytesPerSec: 0,
                  etaSeconds: undefined,
                  error: errMsg,
                  statusMessage: `Installation failed: ${errMsg}`,
                },
                options
              );
            }
          });
        } catch (spawnErr) {
          updateDownloadTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              etaSeconds: undefined,
              error: spawnErr.message,
              statusMessage: `Failed to start Legendary: ${spawnErr.message}`,
            },
            options
          );
        }
      } else {
        await openExternalUri(
          `com.epicgames.launcher://apps/${encodeURIComponent(resolvedAppName)}?action=install`,
          options
        );
        updateDownloadTask(
          taskId,
          {
            statusMessage: 'Installing via Epic Games Launcher...',
          },
          options
        );
      }
    } else if (platformId === 'gog') {
      const savedTokens =
        options.savedTokens ||
        (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});
      let authRes = null;
      try {
        authRes = await ensureGogdlAuthConfig(options);
      } catch {}
      const gogToken = options.gogAccessToken || authRes?.accessToken || savedTokens?.gog?.access_token;
      const gogdlBin = findGogdlBinary(options);
      const cleanId = platformGameId.replace(/^gog-/i, '');

      if (gogdlBin && gogToken && !options.disableGogdlSpawn) {
        try {
          const gogAuthPath =
            authRes?.configPath ||
            authRes?.gogAuthPath ||
            path.join(getUserDataDir(options.userDataDir), 'gog_store', 'auth.json');
          const gogPlatformFlag =
            payload.os === 'windows' ||
            (payload.installerId && String(payload.installerId).toLowerCase().includes('win'))
              ? 'windows'
              : platform === 'darwin'
                ? 'osx'
                : 'windows';

          try {
            if (!fs.existsSync(finalInstallPath)) {
              fs.mkdirSync(finalInstallPath, { recursive: true });
            }
          } catch {}

          // Check if target build is a GOG Content System V1 depot (generation === 1)
          let isV1Build = false;
          if (!options.homedir && !options.skipNetwork) {
            try {
              const buildsCheck = await fetchGogV1Json(
                `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${encodeURIComponent(gogPlatformFlag)}/builds?generation=2`,
                {},
                4000
              );
              if (buildsCheck?.items?.[0]?.generation === 1) {
                isV1Build = true;
              }
            } catch {}
          }

          if (isV1Build) {
            downloadGogV1Depot(
              {
                taskId,
                cleanId,
                platformGameId,
                title,
                gogPlatformFlag,
                finalInstallPath,
                gogToken,
                gogdlBin,
                gogAuthPath,
                platform,
                totalBytes,
                includeDlcs: payload.includeDlcs === true,
              },
              options
            ).catch((v1Err) => {
              if (v1Err && v1Err.isPausedByUser) return;
              updateDownloadTask(
                taskId,
                {
                  status: 'failed',
                  speedBytesPerSec: 0,
                  etaSeconds: undefined,
                  error: v1Err.message,
                  statusMessage: `V1 depot installation failed: ${v1Err.message}`,
                },
                options
              );
            });
          } else {
            const existingExeCheck = findPrimaryExecutable(finalInstallPath, {
              platform,
              hintName: title,
              preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
            });
            if (!existingExeCheck.executablePath && !payload._resumingPausedInstall) {
              clearStaleGogdlManifestCache(cleanId, options);
            }

            const gogArgs = [
              '--auth-config-path',
              gogAuthPath,
              'download',
              cleanId,
              '--platform',
              gogPlatformFlag,
              '--path',
              finalInstallPath,
              payload.includeDlcs === true ? '--with-dlcs' : '--skip-dlcs',
              '--lang',
              'en-US',
            ];

            const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
            const child = spawnImpl(gogdlBin, gogArgs, {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PYTHONUNBUFFERED: '1' },
              ...(typeof options.spawnFn !== 'function' && platform !== 'win32'
                ? { detached: true }
                : {}),
            });
            const ctrl = {
              type: 'process',
              child,
              pausedByUser: false,
              cancelRequested: false,
              exitedWhilePaused: false,
              resumeInstallFn: () =>
                installGame({ ...payload, taskId, _resumingPausedInstall: true }, options),
            };
            downloadControllers.set(taskId, ctrl);

            updateDownloadTask(
              taskId,
              {
                status: 'downloading',
                statusMessage: payload._resumingPausedInstall
                  ? `Resuming ${title} via gogdl...`
                  : 'Initializing GOG depot & verifying manifest via gogdl...',
              },
              options
            );

            let lastErrorLine = '';

            const onGogOutput = (chunk) => {
              const text = String(chunk || '');
              const lines = text.split(/\r?\n/);
              const currentTask = downloadQueueMap.get(taskId);
              let resolvedSizeOnChunk = false;

              for (const line of lines) {
                const errMatch = line.match(
                  /(?:ERROR|CRITICAL|Exception|[A-Za-z]+Error|Failed to execute script)[\]:\s]+(.+)/i
                );
                if (errMatch && errMatch[1]) {
                  lastErrorLine = errMatch[1].trim();
                }

                const sizeTupleMatch = line.match(/\([\d.]+,\s*['"][A-Z]+['"]\)\s*(\d+)/);
                if (sizeTupleMatch && currentTask) {
                  const parsedBytes = Number(sizeTupleMatch[1]);
                  if (parsedBytes > 0) {
                    if (/Disk size:/i.test(line) && !/Download size:/i.test(line)) {
                      if (
                        !currentTask.hasExactDownloadSize &&
                        (!currentTask.totalBytes || currentTask.totalBytes <= 0)
                      ) {
                        currentTask.totalBytes = parsedBytes;
                        resolvedSizeOnChunk = true;
                      }
                    } else {
                      currentTask.totalBytes = parsedBytes;
                      currentTask.hasExactDownloadSize = true;
                      resolvedSizeOnChunk = true;
                    }
                  }
                }

                const dlSizeMatch = line.match(/Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/i);
                if (dlSizeMatch && currentTask && !sizeTupleMatch) {
                  const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
                  if (parsedTotal > 0) {
                    currentTask.totalBytes = parsedTotal;
                    currentTask.hasExactDownloadSize = true;
                    resolvedSizeOnChunk = true;
                  }
                }

                const progressBytesMatch = line.match(/Progress:\s*[\d.]+\s+(\d+)\/(\d+)/i);
                if (progressBytesMatch && currentTask && Number(progressBytesMatch[2]) > 0) {
                  currentTask.totalBytes = Number(progressBytesMatch[2]);
                  const dlBytesVal = Math.max(
                    currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
                    Number(progressBytesMatch[1]) || 0
                  );
                  currentTask.downloadedBytes = dlBytesVal;
                  currentTask.bytesDownloaded = dlBytesVal;
                  resolvedSizeOnChunk = true;
                }
              }

              if (!currentTask) return;

              if (resolvedSizeOnChunk && currentTask.totalBytes > 0) {
                updateDownloadTask(
                  taskId,
                  {
                    totalBytes: currentTask.totalBytes,
                    downloadedBytes: currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
                    bytesDownloaded: currentTask.bytesDownloaded || currentTask.downloadedBytes || 0,
                  },
                  options
                );
              }

              if (
                currentTask.progressPercent === 0 &&
                (/\[V2\]\s*INFO:\s*Deleted:/i.test(text) || /Getting Dependencies repository/i.test(text))
              ) {
                updateDownloadTask(
                  taskId,
                  {
                    statusMessage: 'Allocating files & starting GOG download...',
                  },
                  options
                );
              }

              const pctMatch = matchLast(text, /Progress:\s*([\d.]+)%?/gi);
              const dlMiBMatch = matchLast(text, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
              const speedMatch =
                matchLast(text, /\+\s*Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s/gi) ||
                matchLast(text, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
              const decompMatch = matchLast(
                text,
                /\/\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s\s*\(decompressed\)/gi
              );
              const etaMatch = matchLast(text, /ETA:\s*(\d+):(\d+):(\d+)/gi);

              if (pctMatch || dlMiBMatch || speedMatch || etaMatch) {
                const partialUpdate = {};
                if (pctMatch) {
                  currentTask.hasExplicitCliProgress = true;
                  partialUpdate.progressPercent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
                } else {
                  partialUpdate.progressPercent = currentTask.progressPercent;
                }
                if (dlMiBMatch) {
                  currentTask.hasExplicitCliBytes = true;
                  partialUpdate.bytesDownloaded = parseCliSizeToBytes(
                    dlMiBMatch[1],
                    dlMiBMatch[2] || 'MiB'
                  );
                } else if (
                  pctMatch &&
                  !currentTask.hasExplicitCliBytes &&
                  partialUpdate.bytesDownloaded === undefined
                ) {
                  partialUpdate.bytesDownloaded = Math.round(
                    (partialUpdate.progressPercent / 100) * currentTask.totalBytes
                  );
                }
                const rawCliSpeed = speedMatch
                  ? parseCliSizeToBytes(speedMatch[1], speedMatch[2] || 'MiB')
                  : 0;
                const decompCliSpeed = decompMatch
                  ? parseCliSizeToBytes(decompMatch[1], decompMatch[2] || 'MiB')
                  : 0;
                if (speedMatch || partialUpdate.bytesDownloaded !== undefined) {
                  const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
                    bytesDownloaded:
                      partialUpdate.bytesDownloaded !== undefined
                        ? partialUpdate.bytesDownloaded
                        : currentTask.bytesDownloaded,
                    rawSpeedBytesPerSec: rawCliSpeed,
                    decompressedSpeedBytesPerSec: decompCliSpeed,
                  });
                  if (smoothedSpeed > 0 || speedMatch) {
                    partialUpdate.speedBytesPerSec = smoothedSpeed;
                  }
                }
                if (etaMatch) {
                  const cliEta =
                    parseInt(etaMatch[1], 10) * 3600 +
                    parseInt(etaMatch[2], 10) * 60 +
                    parseInt(etaMatch[3], 10);
                  const activeSpeed =
                    partialUpdate.speedBytesPerSec || currentTask.speedBytesPerSec || 0;
                  const activeBytes =
                    partialUpdate.bytesDownloaded !== undefined
                      ? partialUpdate.bytesDownloaded
                      : currentTask.bytesDownloaded;
                  if (
                    currentTask.etaSeconds > 0 &&
                    cliEta > currentTask.etaSeconds * 3 &&
                    activeSpeed > 0 &&
                    currentTask.totalBytes > activeBytes
                  ) {
                    partialUpdate.etaSeconds = Math.max(
                      1,
                      Math.round((currentTask.totalBytes - activeBytes) / activeSpeed)
                    );
                  } else {
                    partialUpdate.etaSeconds = cliEta;
                  }
                }
                const displayPct =
                  partialUpdate.progressPercent !== undefined
                    ? partialUpdate.progressPercent
                    : currentTask.progressPercent;
                partialUpdate.statusMessage = `Installing via gogdl (${displayPct}%)...`;
                updateDownloadTask(taskId, partialUpdate, options);
              }
            };

            if (child.stdout) child.stdout.on('data', onGogOutput);
            if (child.stderr) child.stderr.on('data', onGogOutput);
            child.on('exit', async (code) => {
              const currentTask = downloadQueueMap.get(taskId);
              if (ctrl.pausedByUser || (currentTask && currentTask.status === 'paused')) {
                ctrl.exitedWhilePaused = true;
                ctrl.child = null;
                return;
              }
              downloadControllers.delete(taskId);
              if (currentTask && currentTask.status === 'cancelled') return;

              if (code === 0) {
                const targetScanDir = fs.existsSync(finalInstallPath) ? finalInstallPath : installDir;
                flattenGogNestedInstallDir(targetScanDir, cleanId);
                const exeDiscovery = findPrimaryExecutable(targetScanDir, {
                  platform,
                  hintName: title,
                  preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
                });

                if (!exeDiscovery.executablePath && !options.homedir && !options.skipNetwork) {
                  try {
                    await downloadGogV1Depot(
                      {
                        taskId,
                        cleanId,
                        platformGameId,
                        title,
                        gogPlatformFlag,
                        finalInstallPath: targetScanDir,
                        gogToken,
                        gogdlBin,
                        gogAuthPath,
                        platform,
                        totalBytes: currentTask?.totalBytes || totalBytes,
                        includeDlcs: payload.includeDlcs === true,
                      },
                      options
                    );
                    return;
                  } catch (v1FallbackErr) {
                    if (v1FallbackErr && v1FallbackErr.isPausedByUser) return;
                  }
                }

                const isWindowsBinaryOnMac =
                  platform === 'darwin' &&
                  (gogPlatformFlag === 'windows' || Boolean(exeDiscovery.isWindowsBinaryOnMac));

                const gogRecord = {
                  platformId: 'gog',
                  platformGameId,
                  title,
                  installPath: targetScanDir,
                  executablePath: exeDiscovery.executablePath,
                  installSize: currentTask?.totalBytes || totalBytes,
                  runner: 'gogdl',
                  isWindowsBinaryOnMac,
                };

                upsertManagedInstallRecord(gogRecord, options.userDataDir);
                try {
                  syncGogFirstPartyLauncher(gogRecord, options);
                } catch {}

                updateDownloadTask(
                  taskId,
                  {
                    status: 'completed',
                    progressPercent: 100,
                    finalInstallPath: targetScanDir,
                    executablePath: exeDiscovery.executablePath,
                    runner: 'gogdl',
                    isWindowsBinaryOnMac,
                    statusMessage:
                      gogPlatformFlag === 'osx'
                        ? 'Installed native macOS build via gogdl'
                        : 'Installed Windows build via gogdl',
                  },
                  options
                );
              } else {
                if (
                  !options.homedir &&
                  !options.skipNetwork &&
                  /KeyError:\s*'size'|Failed to execute script/i.test(lastErrorLine)
                ) {
                  try {
                    await downloadGogV1Depot(
                      {
                        taskId,
                        cleanId,
                        platformGameId,
                        title,
                        gogPlatformFlag,
                        finalInstallPath,
                        gogToken,
                        gogdlBin,
                        gogAuthPath,
                        platform,
                        totalBytes: currentTask?.totalBytes || totalBytes,
                        includeDlcs: payload.includeDlcs === true,
                      },
                      options
                    );
                    return;
                  } catch (v1FallbackErr) {
                    if (v1FallbackErr && v1FallbackErr.isPausedByUser) return;
                  }
                }

                const errMsg = lastErrorLine || `gogdl exited with code ${code}`;
                updateDownloadTask(
                  taskId,
                  {
                    status: 'failed',
                    speedBytesPerSec: 0,
                    etaSeconds: undefined,
                    error: errMsg,
                    statusMessage: `Installation failed: ${errMsg}`,
                  },
                  options
                );
              }
            });
          }
        } catch (err) {
          updateDownloadTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              error: err.message,
              statusMessage: `Failed to start gogdl: ${err.message}`,
            },
            options
          );
        }
      } else if (!gogToken && !payload.downloadUrl) {
        await openExternalUri(`goggalaxy://openGameView/${platformGameId}`, options);
        updateDownloadTask(
          taskId,
          {
            statusMessage: 'Opened in GOG Galaxy client...',
          },
          options
        );
      }
    }

    const latestTask = downloadQueueMap.get(taskId) || task;
    return {
      success: true,
      message: `Started installation for ${title}`,
      task: { ...latestTask },
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function fetchGogV1Json(url, headers = {}, timeoutMs = 8000, fetchImpl = null) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res || !res.ok) return null;
    if (typeof res.arrayBuffer !== 'function') {
      if (typeof res.json === 'function') {
        return await res.json();
      }
      if (typeof res.text === 'function') {
        return JSON.parse(await res.text());
      }
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let text = '';
    try {
      text = buf.toString('utf8');
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        return JSON.parse(text);
      }
    } catch {}
    const zlib = require('zlib');
    try {
      return JSON.parse(zlib.inflateSync(buf).toString('utf8'));
    } catch {}
    try {
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    } catch {}
    return JSON.parse(text);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Native Node.js GOG Content System V1 Depot Downloader & Bundle Extractor
 */
async function downloadGogV1Depot(
  {
    taskId,
    cleanId,
    platformGameId,
    title,
    gogPlatformFlag = 'osx',
    finalInstallPath,
    gogToken,
    gogdlBin,
    gogAuthPath,
    platform = process.platform,
    totalBytes = 0,
    includeDlcs = false,
  },
  options = {}
) {
  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const buildsUrl = `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${encodeURIComponent(gogPlatformFlag)}/builds?generation=2`;
  const buildsJson = await fetchGogV1Json(buildsUrl, {}, 8000, fetchFn);
  const build =
    buildsJson?.items?.find((b) => b && b.generation === 1) || buildsJson?.items?.[0];
  if (!build || !build.link) {
    throw new Error(`No GOG depot build found for ${title}`);
  }

  const repo = await fetchGogV1Json(build.link, {}, 8000, fetchFn);
  const product = repo?.product || {};
  const installDirectory = product.installDirectory || sanitizeDirectoryName(title);
  const depots = Array.isArray(product.depots) ? product.depots : [];
  const depot =
    depots.find(
      (d) =>
        d &&
        d.manifest &&
        (String(d.gameID || '') === String(cleanId) ||
          (Array.isArray(d.gameIDs) && d.gameIDs.map(String).includes(String(cleanId))) ||
          (!d.gameID && !d.gameIDs)) &&
        (!Array.isArray(d.languages) ||
          d.languages.some((l) => /^(en(-us)?|english|\*|neutral)$/i.test(String(l))))
    ) || depots.find((d) => d && d.manifest);

  if (!depot || !depot.manifest) {
    throw new Error(`No GOG V1 depot manifest found for ${title}`);
  }

  const manifestBaseUrl = build.link.slice(0, build.link.lastIndexOf('/'));
  const manifestJson = await fetchGogV1Json(`${manifestBaseUrl}/${depot.manifest}`, {}, 8000, fetchFn);
  const manifestFiles = Array.isArray(manifestJson?.depot?.files) ? manifestJson.depot.files : [];

  let extractRoot = finalInstallPath;
  if (
    gogPlatformFlag === 'osx' &&
    manifestFiles.some((f) => f && f.path && /^\/?Contents\//i.test(String(f.path)))
  ) {
    if (!finalInstallPath.toLowerCase().endsWith('.app')) {
      const appFolderName = installDirectory.toLowerCase().endsWith('.app')
        ? installDirectory
        : `${installDirectory}.app`;
      extractRoot = path.join(finalInstallPath, appFolderName);
    }
  }
  await fs.promises.mkdir(extractRoot, { recursive: true });

  const buildLegacyId = build.legacy_build_id || build.build_id;
  const secureUrl = `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/secure_link?_version=2&generation=1&type=depot&path=/${encodeURIComponent(gogPlatformFlag)}/${encodeURIComponent(buildLegacyId)}`;
  const secureJson = await fetchGogV1Json(
    secureUrl,
    {
      Authorization: `Bearer ${gogToken}`,
    },
    8000,
    fetchFn
  );

  const urlObj = secureJson?.urls?.[0];
  let mainBinUrl = '';
  if (urlObj && urlObj.url_format && urlObj.parameters) {
    let formatted = String(urlObj.url_format);
    for (const [k, v] of Object.entries(urlObj.parameters)) {
      formatted = formatted.replace(`{${k}}`, String(v));
    }
    mainBinUrl = `${formatted.replace(/\/+$/, '')}/main.bin`;
  } else if (typeof urlObj === 'string') {
    mainBinUrl = `${urlObj.replace(/\/+$/, '')}/main.bin`;
  } else if (urlObj && typeof urlObj.url === 'string') {
    mainBinUrl = `${urlObj.url.replace(/\/+$/, '')}/main.bin`;
  }

  if (!mainBinUrl) {
    throw new Error(`Failed to resolve GOG V1 secure CDN link for ${title}`);
  }

  const maxEnd = manifestFiles.reduce(
    (acc, f) =>
      f && f.size > 0 && typeof f.offset === 'number' ? Math.max(acc, f.offset + f.size) : acc,
    0
  );
  const effectiveTotalBytes = maxEnd || totalBytes;

  const tempBinPath = path.join(finalInstallPath, `.gog_v1_${cleanId}_main.bin`);
  let existingBytes = 0;
  try {
    const st = await fs.promises.stat(tempBinPath);
    existingBytes = Math.max(0, Number(st.size) || 0);
  } catch {}

  if (taskId) {
    const initialPct =
      effectiveTotalBytes > 0 && existingBytes > 0
        ? Math.min(98, Math.round((existingBytes / effectiveTotalBytes) * 100))
        : 0;
    updateDownloadTask(
      taskId,
      {
        status: 'downloading',
        tempBinPath,
        ...(existingBytes > 0 ? { bytesDownloaded: existingBytes, progressPercent: initialPct } : {}),
        totalBytes: effectiveTotalBytes,
        statusMessage:
          existingBytes > 0
            ? `Resuming GOG V1 depot archive (${initialPct}%)...`
            : 'Downloading GOG V1 depot archive...',
      },
      options
    );
  }

  const controller = new AbortController();
  const ctrl = {
    type: 'abort',
    controller,
    tempBinPath,
    pausedByUser: false,
    cancelRequested: false,
    exitedWhilePaused: false,
    resumeInstallFn: async () => {
      let freshToken = gogToken;
      try {
        if (typeof options.refreshGogTokenFn === 'function') {
          const refreshed = await options.refreshGogTokenFn(options);
          if (refreshed) freshToken = refreshed;
        } else {
          const refreshedAuth = await ensureGogdlAuthConfig(options);
          if (refreshedAuth && refreshedAuth.accessToken) {
            freshToken = refreshedAuth.accessToken;
          }
        }
      } catch (refreshErr) {
        diagLog.warn('downloadGogV1Depot.refreshTokenOnResume', refreshErr, { cleanId });
      }
      return downloadGogV1Depot(
        {
          taskId,
          cleanId,
          platformGameId,
          title,
          gogPlatformFlag,
          finalInstallPath,
          gogToken: freshToken,
          gogdlBin,
          gogAuthPath,
          platform,
          totalBytes: effectiveTotalBytes,
          includeDlcs,
        },
        options
      ).catch((v1Err) => {
        if (v1Err && (v1Err.isPausedByUser || v1Err.isCancelledByUser)) return;
        if (taskId) {
          const curTask = downloadQueueMap.get(taskId);
          if (curTask && curTask.status === 'cancelled') return;
          updateDownloadTask(
            taskId,
            {
              status: 'failed',
              speedBytesPerSec: 0,
              etaSeconds: undefined,
              error: v1Err.message,
              statusMessage: `V1 depot installation failed: ${v1Err.message}`,
            },
            options
          );
        }
      });
    },
  };
  if (taskId) {
    downloadControllers.set(taskId, ctrl);
  }

  try {
    let bytesDownloaded = existingBytes;
    const alreadyFullyDownloaded =
      existingBytes > 0 && effectiveTotalBytes > 0 && existingBytes >= effectiveTotalBytes;

    if (!alreadyFullyDownloaded) {
      const reqHeaders =
        existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
      const binRes = await fetchFn(mainBinUrl, {
        ...(Object.keys(reqHeaders).length > 0 ? { headers: reqHeaders } : {}),
        signal: controller.signal,
      });
      if (!binRes.ok || !binRes.body) {
        throw new Error(`GOG V1 CDN returned HTTP ${binRes.status}`);
      }

      const isPartialResume = existingBytes > 0 && binRes.status === 206;
      const outFh = await fs.promises.open(tempBinPath, isPartialResume ? 'a' : 'w');
      bytesDownloaded = isPartialResume ? existingBytes : 0;
      let lastEmitTime = Date.now();
      let lastEmitBytes = bytesDownloaded;

      try {
        for await (const chunk of binRes.body) {
          if (ctrl.cancelRequested) {
            const cancelErr = new Error('Download cancelled by user');
            cancelErr.name = 'AbortError';
            cancelErr.isCancelledByUser = true;
            throw cancelErr;
          }
          if (ctrl.pausedByUser || controller.signal.aborted) {
            const abortErr = new Error('Download paused by user');
            abortErr.name = 'AbortError';
            abortErr.isPausedByUser = true;
            throw abortErr;
          }
          const buf = Buffer.from(chunk);
          await outFh.write(buf);
          bytesDownloaded += buf.length;

          const now = Date.now();
          if (taskId && now - lastEmitTime >= 250) {
            const elapsedSec = Math.max(0.05, (now - lastEmitTime) / 1000);
            const rawInstantSpeed = Math.round((bytesDownloaded - lastEmitBytes) / elapsedSec);
            const speedBytesPerSec = computeSmoothedDownloadSpeed(taskId, {
              bytesDownloaded,
              rawSpeedBytesPerSec: rawInstantSpeed,
              nowMs: now,
            });
            const pct =
              effectiveTotalBytes > 0
                ? Math.min(98, Math.round((bytesDownloaded / effectiveTotalBytes) * 100))
                : 0;
            const etaSeconds =
              speedBytesPerSec > 0 && effectiveTotalBytes > bytesDownloaded
                ? Math.max(1, Math.round((effectiveTotalBytes - bytesDownloaded) / speedBytesPerSec))
                : undefined;

            updateDownloadTask(
              taskId,
              {
                status: 'downloading',
                progressPercent: pct,
                bytesDownloaded,
                totalBytes: effectiveTotalBytes,
                speedBytesPerSec,
                etaSeconds,
                statusMessage: `Downloading GOG V1 depot (${pct}%)...`,
              },
              options
            );
            lastEmitTime = now;
            lastEmitBytes = bytesDownloaded;
          }
        }
      } finally {
        try {
          await outFh.close();
        } catch {}
      }
    }

    if (ctrl.cancelRequested) {
      const cancelErr = new Error('Download cancelled by user');
      cancelErr.name = 'AbortError';
      cancelErr.isCancelledByUser = true;
      throw cancelErr;
    }

    if (ctrl.pausedByUser || controller.signal.aborted) {
      const abortErr = new Error('Download paused by user');
      abortErr.name = 'AbortError';
      abortErr.isPausedByUser = true;
      throw abortErr;
    }

    if (taskId) {
      updateDownloadTask(
        taskId,
        {
          status: 'extracting',
          progressPercent: 98,
          bytesDownloaded: effectiveTotalBytes || bytesDownloaded,
          totalBytes: effectiveTotalBytes || bytesDownloaded,
          speedBytesPerSec: 0,
          etaSeconds: 1,
          statusMessage: 'Extracting GOG V1 depot files & bundles...',
        },
        options
      );
    }

    const inFh = await fs.promises.open(tempBinPath, 'r');
    const copyBuf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let extractedBytes = 0;
    let lastExtractEmitMs = Date.now();
    try {
      for (const f of manifestFiles) {
        if (ctrl.cancelRequested) {
          const cancelErr = new Error('Download cancelled by user');
          cancelErr.name = 'AbortError';
          cancelErr.isCancelledByUser = true;
          throw cancelErr;
        }
        if (!f || !f.path) continue;
        const rawEntryPath = String(f.path);
        const relPath = rawEntryPath
          .replace(/^[\/\\]+/, '')
          .replace(/\\/g, path.sep);
        if (!relPath) continue;
        const destPath = path.resolve(extractRoot, relPath);

        if (!isContainedWithinRoot(extractRoot, destPath, platform)) {
          diagLog.warn('downloadGogV1Depot.pathTraversalBlocked', 'Blocked depot entry escaping extractRoot', {
            extractRoot,
            entryPath: rawEntryPath,
          });
          continue;
        }

        if (f.directory) {
          await fs.promises.mkdir(destPath, { recursive: true });
        } else if (f.symlinkType || (f.target && f.size === undefined)) {
          const targetStr = String(f.target || '');
          const resolvedLinkTarget = path.resolve(path.dirname(destPath), targetStr);
          if (!targetStr || !isContainedWithinRoot(extractRoot, resolvedLinkTarget, platform)) {
            diagLog.warn('downloadGogV1Depot.symlinkEscapeBlocked', 'Blocked depot symlink escaping extractRoot', {
              extractRoot,
              entryPath: rawEntryPath,
              target: targetStr,
            });
            continue;
          }
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          try {
            await fs.promises.unlink(destPath).catch(() => {});
            await fs.promises.symlink(targetStr, destPath);
          } catch (symErr) {
            diagLog.warn('downloadGogV1Depot.symlinkCreate', symErr, { destPath });
          }
        } else if (typeof f.size === 'number') {
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          const mode = f.executable || /\/MacOS\//i.test(relPath) ? 0o755 : 0o644;
          const fileOutFh = await fs.promises.open(destPath, 'w', mode);
          try {
            let remaining = f.size;
            let readPos = Number(f.offset || 0);
            let writePos = 0;
            while (remaining > 0) {
              if (ctrl.cancelRequested) {
                const cancelErr = new Error('Download cancelled by user');
                cancelErr.name = 'AbortError';
                cancelErr.isCancelledByUser = true;
                throw cancelErr;
              }
              const toRead = Math.min(copyBuf.length, remaining);
              const { bytesRead } = await inFh.read(copyBuf, 0, toRead, readPos);
              if (bytesRead <= 0) break;
              await fileOutFh.write(copyBuf, 0, bytesRead, writePos);
              remaining -= bytesRead;
              readPos += bytesRead;
              writePos += bytesRead;
              extractedBytes += bytesRead;

              const nowMs = Date.now();
              if (taskId && nowMs - lastExtractEmitMs >= 250) {
                const extPct =
                  effectiveTotalBytes > 0
                    ? Math.min(99, 98 + Math.floor((extractedBytes / effectiveTotalBytes) * 1.9))
                    : 99;
                updateDownloadTask(
                  taskId,
                  {
                    status: 'extracting',
                    progressPercent: extPct,
                    speedBytesPerSec: 0,
                    statusMessage: `Extracting GOG V1 depot files (${Math.min(100, Math.round((extractedBytes / Math.max(1, effectiveTotalBytes)) * 100))}%)...`,
                  },
                  options
                );
                lastExtractEmitMs = nowMs;
              }
            }
          } finally {
            try {
              await fileOutFh.close();
            } catch {}
          }
        }
      }
    } finally {
      try {
        await inFh.close();
      } catch {}
      try {
        await fs.promises.unlink(tempBinPath);
      } catch (unlinkErr) {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          diagLog.warn('downloadGogV1Depot.unlinkExtractedBin', unlinkErr, { tempBinPath });
        }
      }
    }

    if (taskId) {
      downloadControllers.delete(taskId);
    }

    if (platform === 'darwin') {
      ensureMacExecutablePermissions(finalInstallPath);
      executableDiscoveryCache.clear();
      const macExeDiscovery = findPrimaryExecutable(finalInstallPath, {
        platform: 'darwin',
        hintName: title,
      });

      if (macExeDiscovery.executablePath) {
        const machO = inspectMacMachOHeader(macExeDiscovery.executablePath);
        const resolvedAuthPath =
          gogAuthPath ||
          path.join(getUserDataDir(options.userDataDir), 'gog_store', 'auth.json');
        const resolvedGogdlBin = gogdlBin || findGogdlBinary(options);
        if (
          machO.is32BitOnly &&
          resolvedGogdlBin &&
          fs.existsSync(resolvedAuthPath) &&
          !options.disableGogdlSpawn
        ) {
          if (taskId) {
            updateDownloadTask(
              taskId,
              {
                status: 'downloading',
                statusMessage:
                  '32-bit macOS build detected; downloading Windows build for CrossOver/Wine...',
              },
              options
            );
          }
          await new Promise((resolve) => {
            const winChild = spawn(
              resolvedGogdlBin,
              [
                '--auth-config-path',
                resolvedAuthPath,
                'download',
                cleanId,
                '--platform',
                'windows',
                '--path',
                finalInstallPath,
                includeDlcs ? '--with-dlcs' : '--skip-dlcs',
                '--lang',
                'en-US',
              ],
              { stdio: 'ignore' }
            );
            winChild.on('error', () => resolve());
            winChild.on('exit', () => resolve());
          });
        }
      }
    }

    executableDiscoveryCache.clear();
    const finalExeDiscovery = findPrimaryExecutable(finalInstallPath, {
      platform,
      hintName: title,
      preferWindowsExecutable: platform === 'darwin' && gogPlatformFlag === 'windows',
    });
    const isWindowsBinaryOnMac = Boolean(finalExeDiscovery.isWindowsBinaryOnMac);

    const resolvedDepotClientId =
      [
        product?.clientId,
        repo?.clientId,
        manifestJson?.clientId,
        build?.clientId,
        buildsJson?.items?.[0]?.clientId,
      ]
        .map((val) => (val === null || val === undefined ? '' : String(val).trim()))
        .find(
          (str) =>
            str &&
            str !== GOG_GALAXY_LAUNCHER_CLIENT_ID &&
            /^[A-Za-z0-9_-]{3,128}$/.test(str)
        ) || undefined;

    const gogRecord = {
      platformId: 'gog',
      platformGameId: String(platformGameId || cleanId),
      title,
      installPath: finalInstallPath,
      executablePath: finalExeDiscovery.executablePath,
      installSize: effectiveTotalBytes,
      runner: 'gogdl',
      isWindowsBinaryOnMac,
      ...(resolvedDepotClientId ? { clientId: resolvedDepotClientId } : {}),
    };

    upsertManagedInstallRecord(gogRecord, options.userDataDir);
    try {
      syncGogFirstPartyLauncher(gogRecord, options);
    } catch {}

    if (taskId) {
      updateDownloadTask(
        taskId,
        {
          status: 'completed',
          progressPercent: 100,
          bytesDownloaded: effectiveTotalBytes,
          totalBytes: effectiveTotalBytes,
          speedBytesPerSec: 0,
          etaSeconds: 0,
          tempBinPath: undefined,
          finalInstallPath,
          executablePath: finalExeDiscovery.executablePath,
          runner: 'gogdl',
          isWindowsBinaryOnMac,
          statusMessage: 'Installed via GOG V1 depot extractor',
        },
        options
      );
    }

    return {
      success: true,
      installPath: finalInstallPath,
      extractRoot,
      executablePath: finalExeDiscovery.executablePath,
      isWindowsBinaryOnMac,
      totalBytes: effectiveTotalBytes,
    };
  } catch (err) {
    const wasPaused = Boolean(
      !ctrl.cancelRequested &&
        !(err && err.isCancelledByUser) &&
        (ctrl.pausedByUser ||
          (err && err.isPausedByUser) ||
          (taskId && downloadQueueMap.get(taskId)?.status === 'paused'))
    );
    if (wasPaused) {
      ctrl.exitedWhilePaused = true;
      if (err && typeof err === 'object') {
        err.isPausedByUser = true;
      }
      throw err;
    }
    if (taskId) {
      downloadControllers.delete(taskId);
    }
    try {
      await fs.promises.unlink(tempBinPath);
    } catch (unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        diagLog.warn('downloadGogV1Depot.unlinkFailedBin', unlinkErr, { tempBinPath });
      }
    }
    throw err;
  }
}

function pauseDownload(taskId, options = {}) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }
  if (task.status !== 'downloading' && task.status !== 'queued') {
    return {
      success: false,
      error: `Cannot pause download task in status "${task.status}".`,
      task: { ...task },
    };
  }

  const targetPlatform = options.platform || process.platform;
  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    ctrl.pausedByUser = true;
    if (ctrl.type === 'abort' && ctrl.controller) {
      try {
        ctrl.controller.abort();
      } catch {}
    } else if (ctrl.type === 'process' && ctrl.child) {
      if (targetPlatform === 'win32') {
        ctrl.exitedWhilePaused = true;
        signalSubprocessTree(ctrl.child, 'SIGKILL', options);
      } else {
        signalSubprocessTree(ctrl.child, 'SIGSTOP', options);
      }
    }
  }

  if (Number(task.speedBytesPerSec || 0) > 0) {
    task.lastActiveSpeedBytesPerSec = Number(task.speedBytesPerSec);
  }

  return updateDownloadTask(
    taskId,
    {
      status: 'paused',
      speedBytesPerSec: 0,
      etaSeconds: undefined,
      statusMessage: 'Download paused',
    },
    options
  );
}

function resumeDownload(taskId, options = {}) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }
  if (task.status !== 'paused' && task.status !== 'failed') {
    return {
      success: false,
      error: `Cannot resume download task in status "${task.status}".`,
      task: { ...task },
    };
  }

  const targetPlatform = options.platform || process.platform;
  const ctrl = downloadControllers.get(taskId);
  let shouldInvokeResumeFn = false;
  let shouldReinvokeInstallRequest = false;

  if (ctrl) {
    ctrl.pausedByUser = false;
    const pid = ctrl.type === 'process' && ctrl.child ? ctrl.child.pid : null;
    const canSigCont =
      Boolean(pid) &&
      !ctrl.exitedWhilePaused &&
      targetPlatform !== 'win32' &&
      isProcessAlive(pid);
    if (canSigCont) {
      const signaled = signalSubprocessTree(ctrl.child, 'SIGCONT', options);
      if (!signaled && typeof ctrl.resumeInstallFn === 'function') {
        shouldInvokeResumeFn = true;
      }
    } else if (typeof ctrl.resumeInstallFn === 'function') {
      shouldInvokeResumeFn = true;
    }
  } else if (task.installRequest && !task.manualControl && !task.isSimulatedOrManual) {
    shouldReinvokeInstallRequest = true;
  }

  const resumedSpeed =
    task.isSimulatedOrManual || task.manualControl
      ? Number(task.lastActiveSpeedBytesPerSec || 0) || 18 * 1024 * 1024
      : 0;

  const updatedRes = updateDownloadTask(
    taskId,
    {
      status: 'downloading',
      error: undefined,
      speedBytesPerSec: resumedSpeed,
      statusMessage: `Resuming ${task.title}...`,
    },
    options
  );

  if (shouldInvokeResumeFn && ctrl && typeof ctrl.resumeInstallFn === 'function') {
    ctrl.exitedWhilePaused = false;
    Promise.resolve()
      .then(() => ctrl.resumeInstallFn())
      .catch((err) => {
        diagLog.warn('resumeDownload.resumeInstallFn', err, { taskId });
      });
  } else if (shouldReinvokeInstallRequest && task.installRequest) {
    Promise.resolve()
      .then(() =>
        installGame(
          {
            ...task.installRequest,
            taskId,
            _resumingPausedInstall: true,
          },
          options
        )
      )
      .catch((err) => {
        diagLog.warn('resumeDownload.reinvokeInstallGame', err, { taskId });
      });
  }

  return updatedRes;
}

function terminateDownloadController(ctrl, options = {}) {
  if (!ctrl) return;
  ctrl.cancelRequested = true;
  ctrl.pausedByUser = false;
  if (ctrl.timer) {
    try {
      clearInterval(ctrl.timer);
    } catch {}
  }
  if (ctrl.type === 'abort' && ctrl.controller && typeof ctrl.controller.abort === 'function') {
    try {
      ctrl.controller.abort();
    } catch {}
  }
  if (ctrl.type === 'process' && ctrl.child) {
    const targetPlatform = options.platform || process.platform;
    if (targetPlatform === 'win32') {
      signalSubprocessTree(ctrl.child, 'SIGKILL', options);
    } else {
      signalSubprocessTree(ctrl.child, 'SIGCONT', options);
      signalSubprocessTree(ctrl.child, 'SIGTERM', options);
      const pid = ctrl.child.pid;
      if (pid) {
        const killTimer = setTimeout(() => {
          if (isProcessAlive(pid)) {
            signalSubprocessTree(ctrl.child, 'SIGKILL', options);
          }
        }, 1500);
        if (typeof killTimer.unref === 'function') {
          killTimer.unref();
        }
      }
    }
  }
}

function cleanupCancelledGogTempBins(task, ctrl) {
  const candidateBins = new Set();
  if (ctrl && typeof ctrl.tempBinPath === 'string' && ctrl.tempBinPath) {
    candidateBins.add(ctrl.tempBinPath);
  }
  if (task && typeof task.tempBinPath === 'string' && task.tempBinPath) {
    candidateBins.add(task.tempBinPath);
  }
  if (task && task.platformId === 'gog' && task.finalInstallPath) {
    const cleanId = String(task.platformGameId || task.gameId || '')
      .replace(/^gog[-_]/i, '')
      .trim();
    if (cleanId) {
      candidateBins.add(path.join(task.finalInstallPath, `.gog_v1_${cleanId}_main.bin`));
    }
  }
  for (const binPath of candidateBins) {
    try {
      if (fs.existsSync(binPath)) {
        fs.unlinkSync(binPath);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        diagLog.warn('cancelDownload.unlinkTempBin', err, { binPath });
      }
    }
  }
}

function cancelDownload(taskId, options = {}) {
  pausedByInGameTaskIds.delete(taskId);
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    terminateDownloadController(ctrl, options);
    downloadControllers.delete(taskId);
  }
  cleanupCancelledGogTempBins(task, ctrl);

  return updateDownloadTask(
    taskId,
    {
      status: 'cancelled',
      speedBytesPerSec: 0,
      etaSeconds: undefined,
      tempBinPath: undefined,
      statusMessage: 'Download cancelled',
    },
    options
  );
}

function clearDownloadQueue(options = {}) {
  for (const [taskId, ctrl] of downloadControllers.entries()) {
    const task = downloadQueueMap.get(taskId);
    terminateDownloadController(ctrl, options);
    cleanupCancelledGogTempBins(task, ctrl);
  }
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
  pausedByInGameTaskIds.clear();
  downloadQueueMap.clear();
}

function shutdownLauncherEngine(options = {}) {
  for (const [, ctrl] of downloadControllers.entries()) {
    terminateDownloadController(ctrl, options);
  }
  downloadControllers.clear();
  downloadSpeedTrackers.clear();

  for (const [, entry] of activeSessions.entries()) {
    if (entry && entry.pollTimer) {
      try {
        clearInterval(entry.pollTimer);
      } catch {}
      entry.pollTimer = null;
    }
  }
  trimLauncherEngineMemory();
}

/**
 * E) Supporting File Management & Config Persistence Functions
 */
async function browseLocalFiles(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { success: false, error: 'No target path provided.' };
  }
  const resolved = toLocalFsPath(targetPath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `Path does not exist: ${targetPath}` };
  }

  try {
    const stat = fs.statSync(resolved);
    if (electron.shell) {
      if (stat.isFile() || resolved.endsWith('.app')) {
        electron.shell.showItemInFolder(resolved);
      } else {
        await electron.shell.openPath(resolved);
      }
    }
    return { success: true, path: resolved };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function verifyGameFiles(payload = {}, options = {}) {
  try {
    const { platformId, platformGameId, steamAppId, installPath, title } = payload;
    const targetPlatform = options.platform || process.platform;
    const execFileImpl =
      typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : typeof options.execFileFn === 'function'
          ? options.execFileFn
          : execFile;
    const canRunCliRepair =
      !options.skipCliRepair &&
      (!isTestEnvironment(options) ||
        typeof options.execFileImpl === 'function' ||
        typeof options.execFileFn === 'function' ||
        Boolean(options.legendaryBinaryPath) ||
        Boolean(options.gogdlBinaryPath) ||
        options.allowCliRepairInTest === true);

    if (installPath) {
      const localInstall = toLocalFsPath(installPath);
      if (!fs.existsSync(localInstall)) {
        return {
          success: false,
          error: `Installation directory not found: ${installPath}`,
        };
      }

      if (platformId === 'epic' && canRunCliRepair) {
        let appName = '';
        try {
          const resolved = resolveEpicAppAndPlatforms(payload, options);
          if (resolved && resolved.appName) {
            appName = String(resolved.appName).trim();
          }
        } catch {}
        if (!appName) {
          appName = String(payload.appName || platformGameId || payload.gameId || '')
            .replace(/^epic[-_]/i, '')
            .trim();
        }
        const legendaryBin =
          options.legendaryBinaryPath ||
          findLegendaryBinary(options) ||
          (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
            ? 'legendary'
            : null);
        if (appName && legendaryBin) {
          const legendaryConfigPath = getLegendaryConfigDir(options);
          const cliRes = await new Promise((resolve) => {
            try {
              execFileImpl(
                legendaryBin,
                ['repair', appName, '-y'],
                {
                  env: {
                    ...process.env,
                    LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
                    LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
                    ...(legendaryConfigPath ? { LEGENDARY_CONFIG_PATH: legendaryConfigPath } : {}),
                  },
                  timeout: 120000,
                },
                (err, stdout, stderr) => {
                  const combined = `${stdout || ''}\n${stderr || ''}`;
                  resolve({ err, combined });
                }
              );
            } catch (err) {
              resolve({ err, combined: '' });
            }
          });
          if (!cliRes.err && !/not installed|cannot find/i.test(cliRes.combined)) {
            const discovered = findPrimaryExecutable(localInstall, {
              platform: targetPlatform,
              hintName: title,
            });
            return {
              success: true,
              repairedViaCli: true,
              runner: 'legendary',
              message: `Verified and repaired Epic installation via Legendary (${title || appName}).`,
              installPath: localInstall,
              executablePath: discovered.executablePath,
            };
          }
        }
      } else if (platformId === 'gog' && canRunCliRepair) {
        const cleanId = String(platformGameId || payload.gameId || '')
          .replace(/^gog[-_]/i, '')
          .trim();
        const gogdlBin =
          options.gogdlBinaryPath ||
          findGogdlBinary(options) ||
          (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
            ? 'gogdl'
            : null);
        let gogAuthPath = options.gogAuthConfigPath || null;
        if (!gogAuthPath && gogdlBin && !isTestEnvironment(options)) {
          try {
            const authRes = await ensureGogdlAuthConfig(options);
            gogAuthPath = authRes?.configPath || authRes?.gogAuthPath || null;
          } catch {}
        }
        if (cleanId && gogdlBin && gogAuthPath) {
          const discoveredForOs = findPrimaryExecutable(localInstall, {
            platform: targetPlatform,
            hintName: title,
          });
          const gogOs =
            targetPlatform === 'win32' || discoveredForOs.isWindowsBinaryOnMac ? 'windows' : 'osx';
          const cliRes = await new Promise((resolve) => {
            try {
              execFileImpl(
                gogdlBin,
                [
                  '--auth-config-path',
                  gogAuthPath,
                  'repair',
                  cleanId,
                  '--platform',
                  gogOs,
                  '--path',
                  localInstall,
                  '--skip-dlcs',
                  '--lang',
                  'en-US',
                ],
                {
                  env: { ...process.env, PYTHONUNBUFFERED: '1' },
                  timeout: 120000,
                },
                (err, stdout, stderr) => {
                  resolve({ err, combined: `${stdout || ''}\n${stderr || ''}` });
                }
              );
            } catch (err) {
              resolve({ err, combined: '' });
            }
          });
          if (!cliRes.err && !/unrecognized arguments|invalid choice/i.test(cliRes.combined)) {
            return {
              success: true,
              repairedViaCli: true,
              runner: 'gogdl',
              message: `Verified and repaired GOG installation via gogdl (${title || cleanId}).`,
              installPath: localInstall,
              executablePath: discoveredForOs.executablePath,
            };
          }
        }
      }

      const discovered = findPrimaryExecutable(localInstall, {
        platform: targetPlatform,
        hintName: title,
      });

      if (platformId === 'steam' && (steamAppId || platformGameId)) {
        await openExternalUri(`steam://validate/${steamAppId || platformGameId}`, options);
      }

      return {
        success: true,
        message: discovered.executablePath
          ? `Verified installation integrity (${path.basename(discovered.executablePath)} ready).`
          : 'Verified installation directory exists.',
        installPath: localInstall,
        executablePath: discovered.executablePath,
      };
    }

    if (platformId === 'steam' && (steamAppId || platformGameId)) {
      await openExternalUri(`steam://validate/${steamAppId || platformGameId}`, options);
      return {
        success: true,
        message: 'Triggered Steam file integrity validation.',
      };
    }

    return {
      success: false,
      error: 'No installation path available to verify.',
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

function isSafeToDeleteInstallPath(targetPath, options = {}) {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.trim().length < 10) {
    return false;
  }
  const resolved = path.resolve(toLocalFsPath(targetPath));
  const homedir = path.resolve(options.homedir || os.homedir());

  const forbiddenExact = new Set([
    '/',
    '/Applications',
    '/Users',
    '/System',
    '/Library',
    '/var',
    '/tmp',
    '/private',
    '/opt',
    '/usr',
    '/bin',
    'C:\\',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\Users',
    homedir,
    path.join(homedir, 'Applications'),
    path.join(homedir, 'Documents'),
    path.join(homedir, 'Desktop'),
    path.join(homedir, 'Library'),
    path.join(homedir, 'Games'),
  ]);

  if (forbiddenExact.has(resolved)) {
    return false;
  }

  return true;
}

function normalizeComparableTitle(value) {
  if (!value || typeof value !== 'string') return '';
  const romanMap = {
    xx: '20',
    xix: '19',
    xviii: '18',
    xvii: '17',
    xvi: '16',
    xv: '15',
    xiv: '14',
    xiii: '13',
    xii: '12',
    xi: '11',
    x: '10',
    ix: '9',
    viii: '8',
    vii: '7',
    vi: '6',
    v: '5',
    iv: '4',
    iii: '3',
    ii: '2',
  };
  return value
    .toLowerCase()
    .replace(
      /\b(xx|xix|xviii|xvii|xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii)\b/g,
      (m) => romanMap[m] || m
    )
    .replace(/[^a-z0-9]/g, '');
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

function removeSteamAppFromLibraryFoldersVdf(steamappsDir, appId) {
  const cleanAppId = String(appId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  if (!cleanAppId || !steamappsDir || typeof steamappsDir !== 'string') return false;

  const escapedAppId = cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRegex = new RegExp(
    `^[\\t ]*"${escapedAppId}"[\\t ]+"[^"]*"[\\t ]*\\r?\\n?`,
    'gm'
  );

  const candidates = new Set([
    path.join(steamappsDir, 'libraryfolders.vdf'),
    path.resolve(steamappsDir, '..', 'config', 'libraryfolders.vdf'),
    path.resolve(steamappsDir, '..', 'steamapps', 'libraryfolders.vdf'),
  ]);

  let updatedAny = false;
  for (const vdfPath of candidates) {
    if (!fs.existsSync(vdfPath)) continue;
    try {
      const original = fs.readFileSync(vdfPath, 'utf8');
      const updated = original.replace(lineRegex, '');
      if (updated !== original) {
        fs.writeFileSync(vdfPath, updated, 'utf8');
        updatedAny = true;
      }
    } catch {}
  }
  return updatedAny;
}

function cleanupCrossOverSteamShortcuts(appId, title, bottleDirs = [], options = {}) {
  const cleanAppId = String(appId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  const normTitle = normalizeComparableTitle(title);
  const homedir = options.homedir || os.homedir();

  const allBottleDirs = new Set();
  if (bottleDirs && typeof bottleDirs[Symbol.iterator] === 'function') {
    for (const dir of bottleDirs) {
      if (!dir || typeof dir !== 'string') continue;
      const root = extractBottleRootFromPath(dir) || dir;
      if (fs.existsSync(root)) {
        allBottleDirs.add(path.resolve(root));
      }
    }
  }

  try {
    const layers = detectCompatibilityLayers(options);
    for (const layer of layers) {
      if (layer && layer.bottlesDir && fs.existsSync(layer.bottlesDir)) {
        for (const sub of listBottleSubdirectories(layer.bottlesDir)) {
          const fullBottle = path.join(layer.bottlesDir, sub);
          if (fs.existsSync(fullBottle)) {
            allBottleDirs.add(path.resolve(fullBottle));
          }
        }
      }
    }
  } catch {}

  const matchedShortcutNames = new Set();
  if (normTitle && !/^(steam|gog|epic|custom)?\d+$/i.test(String(title || '').trim())) {
    matchedShortcutNames.add(normTitle);
  }

  const deletedWindowsUrlPaths = new Set();
  const deletedCxmenuUrlPaths = new Set();
  const removedPaths = [];
  const escapedAppId = cleanAppId ? cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const appIdUrlRegex = escapedAppId
    ? new RegExp(`steam://rungameid/${escapedAppId}(?:\\b|$)`, 'i')
    : null;

  // Step A: Scan <bottleDir>/drive_c/users/<user>/Desktop and Start Menu/Programs for .url shortcuts
  const scanWinUrlDir = (dirPath, depth = 0) => {
    if (depth > 4 || !dirPath || !fs.existsSync(dirPath)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanWinUrlDir(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.url')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const baseName = path.basename(entry.name, path.extname(entry.name));
          const normBase = normalizeComparableTitle(baseName);
          const matchesId = Boolean(appIdUrlRegex && appIdUrlRegex.test(content));
          const matchesTitle = Boolean(
            normTitle && normBase === normTitle && /steam:\/\/rungameid\//i.test(content)
          );
          if (matchesId || matchesTitle) {
            if (normBase) matchedShortcutNames.add(normBase);
            deletedWindowsUrlPaths.add(path.resolve(fullPath));
            fs.rmSync(fullPath, { force: true });
            removedPaths.push(fullPath);
          }
        } catch {}
      }
    }
  };

  for (const bottleDir of allBottleDirs) {
    const usersDir = path.join(bottleDir, 'drive_c', 'users');
    if (!fs.existsSync(usersDir)) continue;
    let userEntries = [];
    try {
      userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const u of userEntries) {
      if (!u.isDirectory() || u.name.startsWith('.')) continue;
      const userRoot = path.join(usersDir, u.name);
      scanWinUrlDir(path.join(userRoot, 'Desktop'), 0);
      scanWinUrlDir(
        path.join(userRoot, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        0
      );
    }
  }

  // Step B: Scan <bottleDir>/desktopdata/cxmenu recursively for .url wrapper scripts
  for (const bottleDir of allBottleDirs) {
    const cxmenuDir = path.join(bottleDir, 'desktopdata', 'cxmenu');
    if (!fs.existsSync(cxmenuDir)) continue;

    const scanCxmenuDir = (dirPath, depth = 0) => {
      if (depth > 5 || !dirPath || !fs.existsSync(dirPath)) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          scanCxmenuDir(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.url')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const rawBase = path.basename(entry.name, path.extname(entry.name));
            let decodedBase = rawBase.replace(/\+/g, ' ');
            try {
              decodedBase = decodeURIComponent(decodedBase);
            } catch {}

            let targetWinUrlPath = null;
            const startMatch = content.match(/--start\s+"([a-zA-Z]:[\\/][^"]+\.url)"/i);
            if (startMatch) {
              const relDriveC = startMatch[1]
                .replace(/^[a-zA-Z]:[\\/]+/, '')
                .replace(/[\\/]+/g, path.sep);
              targetWinUrlPath = path.resolve(bottleDir, 'drive_c', relDriveC);
            }

            const matchesAppId = Boolean(appIdUrlRegex && appIdUrlRegex.test(content));
            const matchesDeletedOrMissingWinUrl = Boolean(
              targetWinUrlPath &&
                (deletedWindowsUrlPaths.has(targetWinUrlPath) || !fs.existsSync(targetWinUrlPath))
            );
            const normDecoded = normalizeComparableTitle(decodedBase);
            const normRaw = normalizeComparableTitle(rawBase);
            const matchesShortcutName = Boolean(
              (normDecoded && matchedShortcutNames.has(normDecoded)) ||
                (normRaw && matchedShortcutNames.has(normRaw))
            );

            if (matchesAppId || matchesDeletedOrMissingWinUrl || matchesShortcutName) {
              deletedCxmenuUrlPaths.add(path.resolve(fullPath));
              if (normDecoded) matchedShortcutNames.add(normDecoded);
              fs.rmSync(fullPath, { force: true });
              removedPaths.push(fullPath);
            }
          } catch {}
        }
      }
    };

    scanCxmenuDir(cxmenuDir, 0);
  }

  // Step C: Scan <homedir>/Applications/CrossOver (and <homedir>/Applications) for CrossOver helper .app bundles
  const cxAppsRoot = path.join(homedir, 'Applications', 'CrossOver');
  const userAppsRoot = path.join(homedir, 'Applications');

  const scanAppsDir = (dirPath, depth = 0) => {
    if (depth > 3 || !dirPath || !fs.existsSync(dirPath)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (!entry.isDirectory()) continue;

      if (entry.name.toLowerCase().endsWith('.app')) {
        if (/^(steam|crossover)\.app$/i.test(entry.name)) continue;
        const plistPath = path.join(fullPath, 'Contents', 'Info.plist');
        if (!fs.existsSync(plistPath)) continue;

        try {
          const plistContent = fs.readFileSync(plistPath, 'utf8');
          const isCxHelper =
            /(com\.codeweavers\.CrossOverHelper|<key>CrossOverHelperCommand<\/key>|<key>CXHelperAppBottleName<\/key>|<key>CXBottle<\/key>)/i.test(
              plistContent
            );
          if (!isCxHelper) continue;

          const cmdMatch = plistContent.match(
            /<key>CrossOverHelperCommand<\/key>\s*<string>([\s\S]*?)<\/string>/i
          );
          let helperCmdPath = '';
          if (cmdMatch) {
            helperCmdPath = cmdMatch[1]
              .trim()
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&apos;/g, "'")
              .replace(/^"+|"+$/g, '')
              .trim();
          }

          const origMenuMatch = plistContent.match(
            /<key>CXOriginalMenuName<\/key>\s*<string>([\s\S]*?)<\/string>/i
          );
          const origMenuName = origMenuMatch ? origMenuMatch[1].trim() : '';
          const bundleNameMatch = plistContent.match(
            /<key>CFBundleName<\/key>\s*<string>([\s\S]*?)<\/string>/i
          );
          const bundleName = bundleNameMatch ? bundleNameMatch[1].trim() : '';
          const appBaseName = path.basename(fullPath, '.app');

          const matchesDeletedOrMissingCxmenu = Boolean(
            helperCmdPath &&
              (deletedCxmenuUrlPaths.has(path.resolve(helperCmdPath)) ||
                (helperCmdPath.toLowerCase().endsWith('.url') && !fs.existsSync(helperCmdPath)))
          );
          const matchesAppIdInPlist = Boolean(appIdUrlRegex && appIdUrlRegex.test(plistContent));
          const normAppBase = normalizeComparableTitle(appBaseName);
          const normOrigMenu = normalizeComparableTitle(origMenuName);
          const normBundleName = normalizeComparableTitle(bundleName);
          const matchesName = Boolean(
            (normAppBase && matchedShortcutNames.has(normAppBase)) ||
              (normOrigMenu && matchedShortcutNames.has(normOrigMenu)) ||
              (normBundleName && matchedShortcutNames.has(normBundleName))
          );

          if (matchesDeletedOrMissingCxmenu || matchesAppIdInPlist || matchesName) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            removedPaths.push(fullPath);

            // Clean up empty parent subfolder inside ~/Applications/CrossOver/<Subfolder>
            const parentDir = path.dirname(fullPath);
            if (
              fs.existsSync(cxAppsRoot) &&
              path.resolve(parentDir) !== path.resolve(cxAppsRoot) &&
              path.resolve(parentDir).startsWith(path.resolve(cxAppsRoot) + path.sep)
            ) {
              try {
                const remaining = fs
                  .readdirSync(parentDir)
                  .filter((f) => f !== '.DS_Store');
                if (remaining.length === 0) {
                  fs.rmSync(parentDir, { recursive: true, force: true });
                }
              } catch {}
            }
          }
        } catch {}
      } else {
        scanAppsDir(fullPath, depth + 1);
      }
    }
  };

  if (fs.existsSync(cxAppsRoot)) {
    scanAppsDir(cxAppsRoot, 0);
  }
  if (fs.existsSync(userAppsRoot)) {
    scanAppsDir(userAppsRoot, 0);
  }

  return { removedPaths };
}

async function uninstallGame(payload = {}, options = {}) {
  try {
    const { gameId, title, platformId, platformGameId, steamAppId, installPath, allowDeleteFiles } = payload;
    const platform = options.platform || process.platform;
    const userDataDir = getUserDataDir(options.userDataDir);

    const cleanId = String(platformGameId || gameId || '')
      .replace(/^(epic|gog|steam)[-_]/i, '')
      .trim();
    const appId = String(steamAppId || platformGameId || cleanId)
      .replace(/^steam[-_]/i, '')
      .trim();
    const localInstall = installPath ? toLocalFsPath(installPath) : '';
    const isBottlePath = (p) => /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(String(p || ''));

    // Remove from One Launcher managed records if present
    const managed = loadManagedInstalledGames(userDataDir);
    const filtered = managed.filter(
      (r) =>
        !(
          (r.platformId === platformId &&
            (String(r.platformGameId) === String(platformGameId) ||
              (appId && String(r.platformGameId) === appId))) ||
          (installPath && r.installPath === installPath) ||
          (localInstall && r.installPath && path.resolve(r.installPath) === path.resolve(localInstall))
        )
    );
    if (filtered.length !== managed.length) {
      saveManagedInstalledGames(filtered, userDataDir);
    }

    if (platformId === 'epic') {
      try {
        unregisterEpicFirstPartyLauncher(cleanId || platformGameId, installPath, options);
      } catch {}
      try {
        const legInstalledPath = path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json');
        if (fs.existsSync(legInstalledPath)) {
          const rawLeg = JSON.parse(fs.readFileSync(legInstalledPath, 'utf8'));
          if (rawLeg && typeof rawLeg === 'object' && !Array.isArray(rawLeg)) {
            let changed = false;
            for (const [k, v] of Object.entries(rawLeg)) {
              if (
                k === cleanId ||
                k === String(platformGameId) ||
                (installPath && (v?.install_path === installPath || v?.installPath === installPath))
              ) {
                delete rawLeg[k];
                changed = true;
              }
            }
            if (changed) {
              atomicWriteFileSync(legInstalledPath, JSON.stringify(rawLeg, null, 2));
            }
          }
        }
      } catch (legErr) {
        diagLog.warn('uninstallGame.legendaryInstalledCleanup', legErr, { gameId, platformGameId });
      }
    } else if (platformId === 'gog') {
      try {
        unregisterGogFirstPartyLauncher(cleanId || platformGameId, installPath, options);
      } catch {}
      try {
        clearStaleGogdlManifestCache(cleanId || platformGameId, options);
      } catch {}
    } else if (platformId === 'steam' && appId) {
      let isBottleInstall = isBottlePath(localInstall);
      let removedLocalSteamFiles = false;
      let acfName = '';
      const discoveredBottleDirs = new Set();

      if (isBottleInstall) {
        const br = extractBottleRootFromPath(localInstall);
        if (br) discoveredBottleDirs.add(br);
      }

      const candidateSteamappsDirs = new Set();
      try {
        const { steamappsDirs } = discoverSteamLocations(options);
        for (const d of steamappsDirs) {
          if (d) candidateSteamappsDirs.add(d);
        }
      } catch {}

      if (localInstall && /steamapps[\\/]common[\\/]/i.test(localInstall)) {
        candidateSteamappsDirs.add(path.resolve(localInstall, '..', '..'));
      }

      try {
        const layers = detectCompatibilityLayers(options);
        for (const layer of layers) {
          if (layer && layer.bottlesDir && fs.existsSync(layer.bottlesDir)) {
            for (const bottle of listBottleSubdirectories(layer.bottlesDir)) {
              const bPath = path.join(layer.bottlesDir, bottle);
              discoveredBottleDirs.add(bPath);
              const s1 = path.join(bPath, 'drive_c/Program Files (x86)/Steam/steamapps');
              const s2 = path.join(bPath, 'drive_c/Program Files/Steam/steamapps');
              if (fs.existsSync(s1)) candidateSteamappsDirs.add(s1);
              if (fs.existsSync(s2)) candidateSteamappsDirs.add(s2);
            }
          }
        }
      } catch {}

      for (const steamappsDir of candidateSteamappsDirs) {
        if (!steamappsDir || !fs.existsSync(steamappsDir)) continue;
        const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
        if (fs.existsSync(acfPath)) {
          let parsedAcf = null;
          try {
            parsedAcf = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
          } catch {}
          if (parsedAcf && parsedAcf.name && !acfName) {
            acfName = parsedAcf.name;
          }
          if (isBottlePath(steamappsDir)) {
            isBottleInstall = true;
            const br = extractBottleRootFromPath(steamappsDir);
            if (br) discoveredBottleDirs.add(br);
          }
          try {
            fs.rmSync(acfPath, { force: true });
            removedLocalSteamFiles = true;
          } catch {}

          const installdir = parsedAcf && parsedAcf.installdir ? String(parsedAcf.installdir) : '';
          if (installdir) {
            const acfCommonDir = path.join(steamappsDir, 'common', installdir);
            if (fs.existsSync(acfCommonDir) && isSafeToDeleteInstallPath(acfCommonDir, options)) {
              try {
                fs.rmSync(acfCommonDir, { recursive: true, force: true });
              } catch {}
            }
          }

          const auxPaths = [
            path.join(steamappsDir, 'downloading', appId),
            path.join(steamappsDir, 'temp', appId),
            path.join(steamappsDir, 'shadercache', appId),
            path.join(steamappsDir, 'workshop', 'content', appId),
            path.join(steamappsDir, 'workshop', `appworkshop_${appId}.acf`),
          ];
          for (const aux of auxPaths) {
            if (fs.existsSync(aux)) {
              try {
                fs.rmSync(aux, { recursive: true, force: true });
              } catch {}
            }
          }

          removeSteamAppFromLibraryFoldersVdf(steamappsDir, appId);
        }
      }

      if (localInstall && fs.existsSync(localInstall) && isSafeToDeleteInstallPath(localInstall, options)) {
        if (isBottlePath(localInstall)) {
          isBottleInstall = true;
        }
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
          removedLocalSteamFiles = true;
        } catch {}
      }

      if (isBottleInstall || platform === 'darwin') {
        try {
          cleanupCrossOverSteamShortcuts(
            appId,
            title || acfName,
            Array.from(discoveredBottleDirs),
            options
          );
        } catch {}
      }

      // Only invoke steam://uninstall/<appId> when not a bottle install and local Steam files were not directly removed
      if (!isBottleInstall && !removedLocalSteamFiles && !allowDeleteFiles) {
        await openExternalUri(`steam://uninstall/${appId}`, options);
      }
    }

    if (localInstall && fs.existsSync(localInstall)) {
      const canDeleteLocal =
        Boolean(allowDeleteFiles) ||
        isBottlePath(localInstall) ||
        /steamapps[\\/]common[\\/]/i.test(localInstall) ||
        localInstall.includes('OneLauncher') ||
        localInstall.includes('one-launcher');

      if (canDeleteLocal && isSafeToDeleteInstallPath(localInstall, options)) {
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
        } catch {}
      }
    }

    try {
      pruneCloudSaveStateForGame(
        {
          platformId,
          gameId,
          platformGameId: cleanId || platformGameId,
        },
        userDataDir
      );
    } catch (pruneErr) {
      diagLog.warn('uninstallGame.pruneCloudSaveState', pruneErr, { gameId, platformId });
    }

    invalidateScanCaches();

    return {
      success: true,
      message: `Uninstalled ${title || gameId || platformGameId}`,
      installPath,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function selectExecutableDialog(defaultPath) {
  try {
    if (electron.dialog && typeof electron.dialog.showOpenDialog === 'function') {
      const win = mainWindowGetter ? mainWindowGetter() : null;
      const res = await electron.dialog.showOpenDialog(win || undefined, {
        title: 'Select Game Executable',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openFile', 'treatPackageAsDirectory'],
      });
      if (!res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
        return res.filePaths[0];
      }
    }
  } catch {}
  return null;
}

async function selectFolderDialog(defaultPath) {
  try {
    if (electron.dialog && typeof electron.dialog.showOpenDialog === 'function') {
      const win = mainWindowGetter ? mainWindowGetter() : null;
      const res = await electron.dialog.showOpenDialog(win || undefined, {
        title: 'Select Installation Folder',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
        return res.filePaths[0];
      }
    }
  } catch {}
  return null;
}

module.exports = {
  // Configuration, Diagnostics, Security & Event Hooks
  setMainWindowGetter,
  setSessionLifecycleHook,
  setEpicAuthRecoveryHook,
  setUserDataDir,
  getUserDataDir,
  onSessionUpdated,
  onDownloadUpdated,
  queuePendingCompletedSession,
  drainPendingCompletedSessions,
  openedExternalUris,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
  isStoreDisconnectedTombstoned,
  clearStoreDisconnectedTombstone,
  purgeStoreHelperCredentials,
  getImportedEpicInstalls,
  recordImportedEpicInstall,
  resolveHostWindowsKnownFolders,
  clearCachedWindowsKnownFolders,
  diagLog,
  getDiagnosticLogPath,
  openExternalUri,

  // A) Scanner & Helpers
  toLocalFsPath,
  scanAllInstalledGames,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  resolveMacAppBundleBinary,
  ensureMacExecutablePermissions,
  ensureMacAppCodeSignatureValid,
  doesGogInstallUseGalaxySdk,
  invalidateScanCaches,
  evictExecutableDiscoveryCacheForPath,
  inspectWindowsExecutableHeader,
  inspectMacMachOHeader,
  scoreExecutableCandidate,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  parseSteamContentLogForApp,
  getDirectorySizeFast,
  discoverSteamLocations,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  upsertManagedInstallRecord,
  syncEpicFirstPartyLauncher,
  unregisterEpicFirstPartyLauncher,
  flattenGogNestedInstallDir,
  syncGogFirstPartyLauncher,
  syncGogGameToGalaxy,
  unregisterGogFirstPartyLauncher,
  cleanupCrossOverSteamShortcuts,
  removeSteamAppFromLibraryFoldersVdf,

  // B) Compatibility Layers
  isValidBottleDirectory,
  hasValidInitializedBottles,
  detectCompatibilityLayers,
  installCompatibilityLayer,
  mountAndExtractDmgSafe,
  extractRunnerVersionInfo,
  detectBundledD3DMetalVersions,
  compareRunnerVersions,
  checkCompatibilityLayerUpdates,
  updateCompatibilityLayer,
  ensureCompatibilityLayerReady,
  applyCrossOverPerGameSettings,
  getHostMaxDisplayResolution,
  sandboxWinePrefixUserFolders,
  sandboxWinePrefixUserFoldersAsync,
  sanitizeWinePrefixDisplayConfigs,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  resolveWineserverBinary,
  shutdownWinePrefix,
  readWinePrefixShellFolders,
  resolveBottleSteamExe,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,

  // C) Launcher & Session Manager
  launchGame,
  stopGame,
  getRunningGames,
  isProcessAlive,
  waitForProcessExit,
  extractMatchedPidFromProcessOutput,
  signalSubprocessTree,
  execCliWithTreeTimeout,
  parseLaunchArguments,
  buildStorefrontLaunchUri,
  resolveEpicLaunchAuthArguments,
  resolveEpicSavePathTemplate,
  syncEpicCloudSaves,
  resolveGogCloudSaveLocations,
  syncGogCloudSaves,
  GOG_GALAXY_LAUNCHER_CLIENT_ID,
  normalizePosixUtf8Locale,
  purgeOsMetadataAndCountRealFilesSync,
  createCloudSaveRollingBackup,
  createCloudSaveRollingBackupAsync,
  pruneGogCloudConfigsMap,
  pruneCloudSaveStateForGame,
  buildCloudSyncTelemetryPayload,
  ensureGogGalaxyBackgroundService,
  resolveSteamClientBinaryPath,
  resolveGogGalaxyClientBinaryPath,
  resolveEpicClientBinaryPath,
  detectInstalledStorefrontClients,
  resolveSteamClientLaunchCommand,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
  shutdownEphemeralStorefrontClient,
  syncSessionPlaytimeToStorefront,
  pauseActiveDownloadsForInGame,
  resumeDownloadsPausedByInGame,
  getPausedByInGameTaskIds,
  hasActivePostSessionWork,
  sanitizeLaunchMethod,
  resolveEffectiveLifecyclePolicy,
  resolveEffectiveLaunchPolicy,

  // D) Download & Installation Manager
  findLegendaryBinary,
  findGogdlBinary,
  isTestEnvironment,
  isMockOrCorruptedToken,
  isPoisonedStorefrontToken,
  getLegendaryConfigDir,
  ensureLegendaryConfigAndAuth,
  ensureGogdlAuthConfig,
  collectLocalEpicMetadataAndSupport,
  resolveEpicAppAndPlatforms,
  startSteamInstallMonitor,
  ensureWindowsSteamInBottle,
  getDiskSpace,
  getDefaultInstallDir,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
  getGameInstallInfo,
  downloadGogV1Depot,
  computeSmoothedDownloadSpeed,
  clearStaleGogdlManifestCache,
  installGame,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  getDownloadQueue,
  updateDownloadTask,
  clearDownloadQueue,
  shutdownLauncherEngine,
  trimLauncherEngineMemory,
  steamAppInfoCache,

  // E) File Management & Config Persistence
  browseLocalFiles,
  verifyGameFiles,
  uninstallGame,
  isSafeToDeleteInstallPath,
  resolvePlatformLaunchConfig,
  saveGameLaunchConfig,
  getGameLaunchConfigs,
  getGameLaunchConfig,
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  getLauncherPerformanceSettings,
  saveLauncherPerformanceSettings,
  resolveEffectivePerformancePolicy,
  selectExecutableDialog,
  selectFolderDialog,
};
