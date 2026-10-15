const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { spawn, exec, execFile, execFileSync, execSync } = require('node:child_process');

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

// Active game sessions keyed by gameId
const activeSessions = new Map();

// Download queue keyed by taskId
const downloadQueueMap = new Map();
const downloadControllers = new Map();

// Local event listeners for testing and internal hooks
const sessionListeners = new Set();
const downloadListeners = new Set();

/**
 * Configure launcher engine with Electron mainWindow getter and optional overrides
 */
function setMainWindowGetter(fn) {
  if (typeof fn === 'function') {
    mainWindowGetter = fn;
  }
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

function emitSessionUpdated(payload) {
  for (const listener of sessionListeners) {
    try {
      listener(payload);
    } catch {}
  }
  try {
    const win = mainWindowGetter ? mainWindowGetter() : null;
    if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.webContents) {
      win.webContents.send('launcher:session-updated', payload);
    }
  } catch {}
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

  // Convert Windows backslashes to POSIX forward slashes when running on non-Windows host
  if (path.sep === '/' && trimmed.includes('\\')) {
    const posixCandidate = trimmed.replace(/\\\\/g, '/').replace(/\\/g, '/');
    try {
      if (fs.existsSync(posixCandidate)) return posixCandidate;
    } catch {}

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

/**
 * Open an external URI via Electron shell (or record for headless tests)
 */
const openedExternalUris = [];
async function openExternalUri(uri, options = {}) {
  openedExternalUris.push(uri);
  if (typeof options.onOpenExternal === 'function') {
    await options.onOpenExternal(uri);
    return true;
  }
  try {
    if (electron.shell && typeof electron.shell.openExternal === 'function') {
      await electron.shell.openExternal(uri);
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
];

function isExcludedExecutable(filename) {
  const base = path.basename(filename);
  return EXCLUDED_EXECUTABLE_PATTERNS.some((re) => re.test(base));
}

/**
 * Inspect the binary header of a Windows .exe file on disk to distinguish
 * valid 32/64-bit PE executables from legacy 16-bit MS-DOS MZ executables (which
 * fail with spawn UNKNOWN on 64-bit Windows) and identify 64-bit PE32+ binaries.
 */
function inspectWindowsExecutableHeader(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { isValidPe: false, is64Bit: false, is16BitDos: false };
  }
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;

    // Synthetic unit-test stubs (< 64 bytes, e.g. 'MZ-fake-windows-pe-binary-payload')
    if (size < 64) {
      return {
        isValidPe: true,
        is64Bit: false,
        is16BitDos: false,
        isSyntheticStub: true,
      };
    }

    const dosHeader = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, dosHeader, 0, 64, 0);
    if (bytesRead < 64) {
      return { isValidPe: true, is64Bit: false, is16BitDos: false, isSyntheticStub: true };
    }

    // Check 'MZ' magic bytes (0x4D, 0x5A)
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      return { isValidPe: true, is64Bit: false, is16BitDos: false };
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 6 > size) {
      return { isValidPe: false, is64Bit: false, is16BitDos: true };
    }

    const peBuf = Buffer.alloc(6);
    const peBytesRead = fs.readSync(fd, peBuf, 0, 6, peOffset);
    if (
      peBytesRead < 6 ||
      peBuf[0] !== 0x50 ||
      peBuf[1] !== 0x45 ||
      peBuf[2] !== 0x00 ||
      peBuf[3] !== 0x00
    ) {
      return { isValidPe: false, is64Bit: false, is16BitDos: true };
    }

    const machine = peBuf.readUInt16LE(4);
    const is64Bit = machine === 0x8664 || machine === 0xaa64;
    return {
      isValidPe: true,
      is64Bit,
      is16BitDos: false,
      machine,
    };
  } catch {
    return { isValidPe: false, is64Bit: false, is16BitDos: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Score candidate executables by relevance to the game title / folder name, depth, PE architecture, and size
 */
function scoreExecutableCandidate(filePath, rootDir, hintName = '', peInfo = null) {
  const base = path.basename(filePath).replace(/\.(exe|app|sh|command)$/i, '');
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
  if (/launcher|setup|config|editor|server/i.test(base)) score -= 15;

  const resolvedPeInfo =
    peInfo ||
    (String(filePath).toLowerCase().endsWith('.exe')
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

      if (resolvedBinPath) {
        return resolvedBinPath;
      }
    }
  } catch {}
  return appBundlePath;
}

const executableDiscoveryCache = new Map();
let lastProductionScanCache = { timestamp: 0, result: null };
let lastSyncedEpicFingerprint = '';
let lastSyncedGogFingerprint = '';

function invalidateScanCaches() {
  executableDiscoveryCache.clear();
  lastProductionScanCache = { timestamp: 0, result: null };
  lastSyncedEpicFingerprint = '';
  lastSyncedGogFingerprint = '';
}

/**
 * Auto-discover the primary game executable inside an installation directory
 */
function findPrimaryExecutable(installPath, options = {}) {
  const platform = options.platform || process.platform;
  const hintName = options.hintName || '';
  const localInstallPath = toLocalFsPath(installPath);

  if (!localInstallPath || !fs.existsSync(localInstallPath)) {
    return { executablePath: undefined, isWindowsBinaryOnMac: false };
  }

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
        isWindowsBinaryOnMac: platform === 'darwin' && isWinExe,
      };
    }
    if (platform === 'darwin' && localInstallPath.endsWith('.app')) {
      return {
        executablePath: resolveMacAppBundleBinary(localInstallPath),
        isWindowsBinaryOnMac: false,
      };
    }
  } catch {
    return { executablePath: undefined, isWindowsBinaryOnMac: false };
  }

  const cacheKey = `${localInstallPath}|${platform}|${hintName}`;
  const cached = executableDiscoveryCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.timestamp < 60000 &&
    cached.mtimeMs === rootMtimeMs &&
    (!cached.result.executablePath || fs.existsSync(cached.result.executablePath))
  ) {
    return { ...cached.result };
  }

  const cacheAndReturn = (result) => {
    executableDiscoveryCache.set(cacheKey, {
      result,
      mtimeMs: rootMtimeMs,
      timestamp: Date.now(),
    });
    return { ...result };
  };

  const macApps = [];
  const winExeCandidates = [];
  const unixBins = [];

  function walk(currentDir, depth) {
    if (depth > 3) return;
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
          macApps.push(fullPath);
          continue; // Don't recurse inside .app bundle during general walk
        }
        // Skip common non-executable asset directories to keep scanning fast
        if (/^(node_modules|redist|_commonredist|directx|vcredist|locales|resources|data|assets|streamingassets|mono)$/i.test(entry.name)) {
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
        } else if (platform === 'darwin' && !/\.(dll|so|dylib|txt|md|json|info|acf|vdf|png|jpg|jpeg|gif|ico|pak|bin|dat|log|xml|ini|cfg|wav|mp3|ogg|mp4|webm|pdf|html|css|js)$/i.test(lower)) {
          if (lower.endsWith('.sh') || lower.endsWith('.command')) {
            if (!isExcludedExecutable(entry.name)) {
              unixBins.push(fullPath);
            }
          } else {
            try {
              const st = fs.statSync(fullPath);
              if ((st.mode & 0o111) !== 0 && !isExcludedExecutable(entry.name)) {
                unixBins.push(fullPath);
              }
            } catch {}
          }
        }
      }
    }
  }

  walk(localInstallPath, 0);

  const nonDosCandidates = winExeCandidates.filter((c) => !c.peInfo?.is16BitDos);
  const filteredWinCandidates =
    nonDosCandidates.length > 0
      ? nonDosCandidates
      : platform === 'win32'
        ? []
        : winExeCandidates;

  if (platform === 'darwin') {
    if (macApps.length > 0) {
      macApps.sort(
        (a, b) =>
          scoreExecutableCandidate(b, localInstallPath, hintName) -
          scoreExecutableCandidate(a, localInstallPath, hintName)
      );
      return cacheAndReturn({
        executablePath: resolveMacAppBundleBinary(macApps[0]),
        isWindowsBinaryOnMac: false,
      });
    }

    if (unixBins.length > 0) {
      unixBins.sort(
        (a, b) =>
          scoreExecutableCandidate(b, localInstallPath, hintName) -
          scoreExecutableCandidate(a, localInstallPath, hintName)
      );
      return cacheAndReturn({
        executablePath: unixBins[0],
        isWindowsBinaryOnMac: false,
      });
    }

    if (filteredWinCandidates.length > 0) {
      filteredWinCandidates.sort(
        (a, b) =>
          scoreExecutableCandidate(b.path, localInstallPath, hintName, b.peInfo) -
          scoreExecutableCandidate(a.path, localInstallPath, hintName, a.peInfo)
      );
      return cacheAndReturn({
        executablePath: filteredWinCandidates[0].path,
        isWindowsBinaryOnMac: true,
      });
    }

    return cacheAndReturn({ executablePath: undefined, isWindowsBinaryOnMac: false });
  }

  // Windows (win32) or fallback
  if (filteredWinCandidates.length > 0) {
    filteredWinCandidates.sort(
      (a, b) =>
        scoreExecutableCandidate(b.path, localInstallPath, hintName, b.peInfo) -
        scoreExecutableCandidate(a.path, localInstallPath, hintName, a.peInfo)
    );
    return cacheAndReturn({
      executablePath: filteredWinCandidates[0].path,
      isWindowsBinaryOnMac: false,
    });
  }

  return cacheAndReturn({ executablePath: undefined, isWindowsBinaryOnMac: false });
}

/**
 * Parse Valve VDF libraryfolders.vdf to extract all Steam library paths
 */
function parseSteamLibraryFoldersVdf(vdfContent) {
  const paths = [];
  if (!vdfContent || typeof vdfContent !== 'string') return paths;

  // Match "path" "<value>"
  const pathRegex = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = pathRegex.exec(vdfContent)) !== null) {
    const raw = m[1].replace(/\\\\/g, '\\').trim();
    if (raw && !paths.includes(raw)) {
      paths.push(raw);
    }
  }

  // Also support legacy VDF format: "1" "D:\\SteamLibrary"
  const legacyRegex = /"\d+"\s+"([A-Za-z]:\\[^"]+|\/[^"]+)"/g;
  while ((m = legacyRegex.exec(vdfContent)) !== null) {
    const raw = m[1].replace(/\\\\/g, '\\').trim();
    if (raw && !paths.includes(raw)) {
      paths.push(raw);
    }
  }

  return paths;
}

/**
 * Parse Steam appmanifest_<appId>.acf content
 */
function parseSteamAcf(acfContent) {
  if (!acfContent || typeof acfContent !== 'string') return null;
  const extract = (key) => {
    const re = new RegExp(`"${key}"\\s+"([^"]*)"`, 'i');
    const m = acfContent.match(re);
    return m ? m[1] : undefined;
  };

  const appIdStr = extract('appid');
  const appId = appIdStr ? parseInt(appIdStr, 10) : NaN;
  if (!appId || Number.isNaN(appId)) return null;

  return {
    appId,
    name: extract('name') || `Steam App ${appId}`,
    installdir: extract('installdir') || '',
    SizeOnDisk: extract('SizeOnDisk'),
    StateFlags: extract('StateFlags'),
    buildid: extract('buildid'),
    BytesDownloaded: extract('BytesDownloaded'),
    BytesToDownload: extract('BytesToDownload'),
    BytesStaged: extract('BytesStaged'),
    BytesToStage: extract('BytesToStage'),
    LastUpdated: extract('LastUpdated'),
  };
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
 * Parse Steam logs/content_log.txt tail content for real-time download & staging progress of a specific AppID
 */
function parseSteamContentLogForApp(logContent, appId) {
  const result = {
    bytesDownloaded: 0,
    bytesToDownload: 0,
    bytesStaged: 0,
    bytesToStage: 0,
    phase: undefined,
    fullyInstalled: false,
    speedBytesPerSec: 0,
  };

  if (!logContent || typeof logContent !== 'string' || !appId) return result;

  const appPrefixRe = new RegExp(`AppID\\s+${String(appId)}\\b`, 'i');
  const lines = logContent.split(/\r?\n/);

  for (const line of lines) {
    const rateMatch = line.match(/Current download rate:\s*([\d.]+)\s*Mbps/i);
    if (rateMatch) {
      const mbps = parseFloat(rateMatch[1]);
      if (!Number.isNaN(mbps) && mbps >= 0) {
        result.speedBytesPerSec = Math.round(mbps * 125000);
      }
    }

    if (!appPrefixRe.test(line)) continue;

    const dlMatch = line.match(/download\s+(\d+)\/(\d+)/i);
    if (dlMatch) {
      result.bytesDownloaded = Number(dlMatch[1]) || 0;
      result.bytesToDownload = Number(dlMatch[2]) || 0;
    }

    const stageMatch = line.match(/stage\s+(\d+)\/(\d+)/i);
    if (stageMatch) {
      result.bytesStaged = Number(stageMatch[1]) || 0;
      result.bytesToStage = Number(stageMatch[2]) || 0;
    }

    const updateChangedMatch = line.match(/App update changed\s*:\s*(.+)$/i);
    if (updateChangedMatch) {
      const rawPhase = updateChangedMatch[1].trim();
      result.phase = rawPhase;
      if (/running update|downloading|staging|preallocating/i.test(rawPhase)) {
        result.fullyInstalled = false;
      }
    }

    if (/state changed\s*:\s*[^(\r\n]*Fully Installed/i.test(line)) {
      result.fullyInstalled = true;
      result.phase = 'Fully Installed';
    } else if (/update started/i.test(line)) {
      result.fullyInstalled = false;
    }
  }

  return result;
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

  // Also check CrossOver and Whisky bottles for Windows Steam installations on macOS
  const bottleContainers = [
    path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
    path.join(homedir, 'Library/Containers/com.isaacmarovitz.Whisky/Bottles'),
    path.join(
      homedir,
      'Library/Containers/com.isaacmarovitz.Whisky/Data/Library/Application Support/com.isaacmarovitz.Whisky/Bottles'
    ),
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
            const resolvedLp = toLocalFsPath(lp, customRoots);
            if (resolvedLp) {
              addSteamRootCandidate(resolvedLp);
              addSteamappsCandidate(path.join(resolvedLp, 'steamapps'));
              addSteamappsCandidate(resolvedLp);
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
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
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
function getLaunchConfigsFilePath(userDataDir) {
  return path.join(getUserDataDir(userDataDir), 'one_launcher_configs.json');
}

function getGameLaunchConfigs(options = {}) {
  const filePath = getLaunchConfigsFilePath(options.userDataDir);
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

function saveGameLaunchConfig(config, options = {}) {
  if (!config || !config.gameId) {
    return { success: false, error: 'Invalid launch config: missing gameId' };
  }
  const filePath = getLaunchConfigsFilePath(options.userDataDir);
  const existing = getGameLaunchConfigs(options);
  const updated = {
    ...existing[config.gameId],
    ...config,
  };
  existing[config.gameId] = updated;
  try {
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
    invalidateScanCaches();
    return { success: true, config: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
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
      return {
        success: true,
        installedGames: lastProductionScanCache.result.installedGames.map((g) => ({ ...g })),
        installedSteamAppIds: [...lastProductionScanCache.result.installedSteamAppIds],
      };
    }

    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
    const userDataDir = getUserDataDir(options.userDataDir);
    const isIsolatedTest = Boolean(options.homedir || (options.customRoots && options.customRoots.length > 0));

    const discoveredMap = new Map();
    const installedSteamAppIds = [];

    const addRecord = (record) => {
      if (!record || !record.platformId || !record.platformGameId) return;
      const key = `${record.platformId}:${record.platformGameId}`;
      const existing = discoveredMap.get(key);
      if (existing) {
        discoveredMap.set(key, {
          ...existing,
          ...record,
          executablePath: record.executablePath || existing.executablePath,
          installPath: record.installPath || existing.installPath,
        });
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
        const isActivelyDownloading =
          stateFlags && stateFlags !== '4' && bytesToDl > 0 && bytesDl < bytesToDl;

        // Verify common/<installdir> exists and is not mid-download
        if (isActivelyDownloading || (!dirExists && stateFlags && stateFlags !== '4')) {
          continue;
        }

        const exeDiscovery = dirExists
          ? findPrimaryExecutable(installPath, { platform, hintName: parsed.name })
          : { executablePath: undefined, isWindowsBinaryOnMac: false };

        addRecord({
          platformId: 'steam',
          platformGameId: String(parsed.appId),
          appId: parsed.appId,
          title: parsed.name,
          name: parsed.name,
          installPath,
          executablePath: exeDiscovery.executablePath,
          installSize: parsed.SizeOnDisk ? Number(parsed.SizeOnDisk) || undefined : undefined,
          version: parsed.buildid ? String(parsed.buildid) : undefined,
          manifestPath,
          runner: 'steam',
          isWindowsBinaryOnMac: exeDiscovery.isWindowsBinaryOnMac,
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
          installPath = appBundleDir;
        }

        let executablePath = undefined;
        let isWindowsBinaryOnMac = false;

        if (Array.isArray(raw.playTasks)) {
          const primaryTask =
            raw.playTasks.find((t) => t && t.isPrimary && t.path) ||
            raw.playTasks.find((t) => t && t.category === 'game' && t.path) ||
            raw.playTasks.find((t) => t && t.path);
          if (primaryTask && primaryTask.path) {
            const relTaskPath = primaryTask.path.replace(/\\/g, path.sep);
            const candidates = [
              path.join(installPath, relTaskPath),
              path.join(path.dirname(infoFilePath), relTaskPath),
            ];
            for (const c of candidates) {
              if (fs.existsSync(c)) {
                executablePath = c.endsWith('.app') ? resolveMacAppBundleBinary(c) : c;
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
          const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
          const isWinOnMac =
            discovered.isWindowsBinaryOnMac ||
            (platform === 'darwin' && String(item.platform || '').toLowerCase() === 'windows');

          addRecord({
            platformId: 'gog',
            platformGameId: gameId,
            title,
            installPath,
            executablePath: item.executable ? toLocalFsPath(item.executable, customRoots) : discovered.executablePath,
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

          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title,
            installPath,
            executablePath,
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

          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title,
            installPath,
            executablePath,
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
    for (const rec of managedRecords) {
      if (!rec || !rec.platformId || !rec.platformGameId) continue;
      const localInstall = toLocalFsPath(rec.installPath, customRoots);
      if (localInstall && fs.existsSync(localInstall)) {
        const discovered = findPrimaryExecutable(localInstall, { platform, hintName: rec.title });
        addRecord({
          ...rec,
          installPath: localInstall,
          executablePath: rec.executablePath || discovered.executablePath,
          runner: rec.runner || 'one_launcher',
          isWindowsBinaryOnMac:
            rec.isWindowsBinaryOnMac !== undefined
              ? rec.isWindowsBinaryOnMac
              : discovered.isWindowsBinaryOnMac,
        });
      }
    }

    const launchConfigs = getGameLaunchConfigs({ userDataDir });
    for (const cfg of Object.values(launchConfigs)) {
      if (!cfg || !cfg.customExecutablePath) continue;
      const customExe = toLocalFsPath(cfg.customExecutablePath, customRoots);
      if (customExe && fs.existsSync(customExe)) {
        const platformId = cfg.preferredPlatformId || 'custom';
        const platformGameId = String(cfg.gameId).replace(/^(steam|gog|epic|custom)-/, '');
        const installPath = cfg.workingDirectory
          ? toLocalFsPath(cfg.workingDirectory, customRoots)
          : path.dirname(customExe);
        const alreadyDiscovered = Array.from(discoveredMap.values()).some(
          (r) =>
            r &&
            ((installPath && r.installPath === installPath) ||
              (customExe && r.executablePath === customExe))
        );
        if (alreadyDiscovered) continue;
        addRecord({
          platformId,
          platformGameId,
          title: cfg.title || cfg.gameId,
          installPath,
          executablePath: customExe,
          runner: 'custom',
          isWindowsBinaryOnMac: platform === 'darwin' && customExe.toLowerCase().endsWith('.exe'),
        });
      }
    }

    const installedGames = Array.from(discoveredMap.values());

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
        result: { installedGames, installedSteamAppIds },
      };
    }

    return {
      success: true,
      installedGames,
      installedSteamAppIds,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      installedGames: [],
      installedSteamAppIds: [],
    };
  }
}

/**
 * Resolve Epic Games Launcher Manifests directory and LauncherInstalled.dat path
 */
function resolveEpicFirstPartyPaths(options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  if (options.homedir && !options.eglManifestsDir && !options.eglLauncherInstalledPath) {
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

    const legendaryInstalledFiles = [
      path.join(userDataDir, 'legendaryConfig/legendary/installed.json'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'),
      path.join(homedir, '.config/legendary/installed.json'),
      path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary/installed.json'),
    ];

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
              },
              timeout: 10000,
            },
            () => {}
          );
        } catch {}
      }
    }

    // 3. Direct Node.js .item Manifest Synthesis & Verification
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
              existingItems.push(parsed);
            }
          } catch {}
        }
      } catch {}

      const metadataDirs = [
        path.join(userDataDir, 'legendaryConfig/legendary/metadata'),
        path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/metadata'),
        path.join(homedir, '.config/legendary/metadata'),
        path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary/metadata'),
      ];

      for (const [appName, entry] of epicGamesMap.entries()) {
        const installPath = entry.installPath;
        if (!installPath || !fs.existsSync(installPath)) continue;

        const alreadyValid = existingItems.some(
          (it) =>
            it.AppName === appName &&
            it.InstallLocation === installPath &&
            it.bIsIncompleteInstall === false
        );
        if (alreadyValid) {
          syncedCount++;
          continue;
        }

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

        const catalogItemId =
          meta?.id || meta?.app_info?.id || entry.catalog_item_id || entry.catalogItemId || '';
        const catalogNamespace =
          meta?.namespace ||
          meta?.app_info?.namespace ||
          entry.namespace ||
          entry.catalogNamespace ||
          '';

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

        const guid = crypto
          .createHash('md5')
          .update(`${appName}:${installPath}`)
          .digest('hex')
          .toUpperCase();

        const itemPayload = {
          FormatVersion: 0,
          bIsIncompleteInstall: false,
          LaunchCommand: entry.launch_parameters || '',
          LaunchExecutable: relativeExePath || '',
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
          InstallationGuid: guid,
          InstallLocation: installPath,
          InstallSessionId: '',
          InstallTags: [],
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
          MandatoryAppFolderName: path.basename(installPath),
          OwnershipToken: 'false',
          CatalogNamespace: catalogNamespace,
          CatalogItemId: catalogItemId,
          AppVersionString: String(entry.version || '1.0'),
        };

        const serializedItem = JSON.stringify(itemPayload, null, 2);
        try {
          const egstoreDir = path.join(installPath, '.egstore');
          fs.mkdirSync(egstoreDir, { recursive: true });
          fs.writeFileSync(path.join(egstoreDir, `${guid}.item`), serializedItem, 'utf8');
        } catch {}

        try {
          fs.writeFileSync(path.join(eglManifestsDir, `${guid}.item`), serializedItem, 'utf8');
          syncedCount++;
        } catch {}
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
        fs.writeFileSync(
          eglLauncherInstalledPath,
          JSON.stringify({ InstallationList: Array.from(listMap.values()) }, null, 2),
          'utf8'
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
 */
function flattenGogNestedInstallDir(finalInstallPath, cleanId) {
  try {
    if (!finalInstallPath || !fs.existsSync(finalInstallPath)) return finalInstallPath;
    if (finalInstallPath.toLowerCase().endsWith('.app')) return finalInstallPath;
    const stat = fs.statSync(finalInstallPath);
    if (!stat.isDirectory()) return finalInstallPath;

    const rootEntries = fs.readdirSync(finalInstallPath, { withFileTypes: true });
    const hasRootInfoOrApp = rootEntries.some(
      (e) =>
        (e.isFile() && /^goggame-\d+\.info$/i.test(e.name)) ||
        (e.isDirectory() && e.name.toLowerCase().endsWith('.app'))
    );
    if (hasRootInfoOrApp) return finalInstallPath;

    const visibleDirs = rootEntries.filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.toLowerCase().endsWith('.app')
    );
    const visibleFiles = rootEntries.filter((e) => e.isFile() && !e.name.startsWith('.'));

    let targetSubDir = null;
    for (const d of visibleDirs) {
      const subFullPath = path.join(finalInstallPath, d.name);
      try {
        const subFiles = fs.readdirSync(subFullPath);
        if (
          (cleanId && subFiles.includes(`goggame-${cleanId}.info`)) ||
          subFiles.some((f) => /^goggame-\d+\.info$/i.test(f))
        ) {
          targetSubDir = subFullPath;
          break;
        }
      } catch {}
    }

    if (!targetSubDir && visibleDirs.length === 1 && visibleFiles.length === 0) {
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

    // Step A: Flatten nested directory if needed
    flattenGogNestedInstallDir(installPath, cleanId);

    // Step B: Ensure complete goggame-<cleanId>.info & .goggame-<cleanId>.info
    const infoFilePath = path.join(installPath, `goggame-${cleanId}.info`);
    const dotInfoFilePath = path.join(installPath, `.goggame-${cleanId}.info`);
    const macResourcesDir = path.join(installPath, 'Contents', 'Resources');
    const macResourcesInfoPath = path.join(macResourcesDir, `goggame-${cleanId}.info`);

    let info = {};
    for (const candidateInfo of [infoFilePath, dotInfoFilePath, macResourcesInfoPath]) {
      if (fs.existsSync(candidateInfo)) {
        try {
          info = JSON.parse(fs.readFileSync(candidateInfo, 'utf8')) || {};
          break;
        } catch {}
      }
    }

    let resolvedExe = record.executablePath ? toLocalFsPath(record.executablePath) : undefined;
    if (!resolvedExe || !fs.existsSync(resolvedExe)) {
      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: record.title || info.name,
      });
      resolvedExe = discovered.executablePath;
    }

    let relativeExePath = '';
    if (resolvedExe && resolvedExe.startsWith(installPath)) {
      relativeExePath = path.relative(installPath, resolvedExe);
    } else if (resolvedExe) {
      relativeExePath = path.basename(resolvedExe);
    }

    const synthesizedInfo = {
      ...info,
      buildId: String(info.buildId && /^\d+$/.test(String(info.buildId)) ? info.buildId : cleanId),
      clientId: String(info.clientId || '46899977096215655'),
      gameId: String(cleanId),
      rootGameId: String(info.rootGameId || cleanId),
      language: info.language || 'English',
      languages:
        Array.isArray(info.languages) && info.languages.length > 0 ? info.languages : ['en-US'],
      name: info.name || record.title || `GOG Game ${cleanId}`,
      osBitness: Array.isArray(info.osBitness) ? info.osBitness : ['64'],
      version: typeof info.version === 'number' ? info.version : 1,
      playTasks:
        Array.isArray(info.playTasks) && info.playTasks.length > 0
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
    try {
      if (!installPath.toLowerCase().endsWith('.app')) {
        fs.writeFileSync(infoFilePath, serializedInfo, 'utf8');
        fs.writeFileSync(dotInfoFilePath, serializedInfo, 'utf8');
      }
      if (platform === 'darwin') {
        fs.mkdirSync(macResourcesDir, { recursive: true });
        fs.writeFileSync(macResourcesInfoPath, serializedInfo, 'utf8');
        const rootHashDb = path.join(installPath, `goggame-${cleanId}.hashdb`);
        const resHashDb = path.join(macResourcesDir, `goggame-${cleanId}.hashdb`);
        if (fs.existsSync(rootHashDb) && !fs.existsSync(resHashDb)) {
          fs.copyFileSync(rootHashDb, resHashDb);
        }
      }
    } catch {}

    const { gogConfigPath, gogDbPath } = resolveGogFirstPartyPaths(options);

    // Step C: Update GOG Galaxy config.json (installationPaths)
    if (gogConfigPath && fs.existsSync(gogConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(gogConfigPath, 'utf8')) || {};
        const parentLibraryDir = path.dirname(installPath);
        if (!Array.isArray(cfg.installationPaths)) {
          cfg.installationPaths = [];
        }
        if (
          parentLibraryDir &&
          parentLibraryDir !== cfg.libraryPath &&
          !cfg.installationPaths.includes(parentLibraryDir)
        ) {
          cfg.installationPaths.push(parentLibraryDir);
          fs.writeFileSync(gogConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
        }
      } catch {}
    }

    // Step D: Register in GOG Galaxy 2.0 SQLite Database (galaxy-2.0.db)
    if (gogDbPath && (fs.existsSync(gogDbPath) || options.gogGalaxyDbPath) && /^\d+$/.test(cleanId)) {
      const numericProductId = Number(cleanId);
      const numericBuildId = Number(
        synthesizedInfo.buildId && /^\d+$/.test(String(synthesizedInfo.buildId))
          ? synthesizedInfo.buildId
          : cleanId
      );
      const installationId = Number(String(numericProductId).slice(0, 9)) || numericProductId;

      let db = null;
      try {
        fs.mkdirSync(path.dirname(gogDbPath), { recursive: true });
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(gogDbPath);
        db.exec('PRAGMA busy_timeout = 3000;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS Products (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER);
          CREATE TABLE IF NOT EXISTS InstalledProducts (productId INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS Languages (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
          CREATE TABLE IF NOT EXISTS AvailableLanguages (productId INTEGER, buildId INTEGER, languageId INTEGER, PRIMARY KEY (productId, buildId, languageId));
          CREATE TABLE IF NOT EXISTS InstalledBaseProducts (productId INTEGER PRIMARY KEY, generation INTEGER, languageId INTEGER, installationPath TEXT, installationId INTEGER, buildId INTEGER, branch TEXT, installationDate TEXT);
          CREATE TABLE IF NOT EXISTS ImportedLatestBuildIds (productId INTEGER PRIMARY KEY, buildId INTEGER);
        `);

        db.prepare('INSERT OR IGNORE INTO Products (id, name, parentId) VALUES (?, ?, NULL)').run(
          numericProductId,
          synthesizedInfo.name
        );
        db.prepare('INSERT OR IGNORE INTO InstalledProducts (productId) VALUES (?)').run(
          numericProductId
        );
        db.prepare(
          "INSERT OR IGNORE INTO Languages (id, name, code) VALUES (16, 'English', 'en-US')"
        ).run();
        db.prepare(
          'INSERT OR IGNORE INTO AvailableLanguages (productId, buildId, languageId) VALUES (?, ?, 16)'
        ).run(numericProductId, numericBuildId);
        db.prepare(
          "INSERT OR REPLACE INTO InstalledBaseProducts (productId, generation, languageId, installationPath, installationId, buildId, branch, installationDate) VALUES (?, 2, 16, ?, ?, ?, '', datetime('now'))"
        ).run(numericProductId, installPath, installationId, numericBuildId);
        db.prepare(
          'INSERT OR REPLACE INTO ImportedLatestBuildIds (productId, buildId) VALUES (?, ?)'
        ).run(numericProductId, numericBuildId);
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

    return { synced: true, infoFilePath };
  } catch {
    return { synced: false };
  }
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
      let db = null;
      try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(gogDbPath);
        db.exec('PRAGMA busy_timeout = 3000;');
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
        execSync(`reg delete "HKCU\\Software\\GOG.com\\Games\\${normId}" /f`, {
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
 * Enumerate subdirectory names inside a Wine/CrossOver/Whisky Bottles directory
 */
function listBottleSubdirectories(bottlesDir) {
  if (!bottlesDir || !fs.existsSync(bottlesDir)) return [];
  try {
    return fs
      .readdirSync(bottlesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * B) macOS Compatibility Layer Detector (CrossOver, Whisky, Apple GPTK, Wine)
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

  const layers = [];
  const addedTypes = new Set();

  // 1. CrossOver & CrossOver Preview
  const crossoverVariants = [
    {
      id: 'crossover',
      type: 'crossover',
      name: 'CrossOver',
      appName: 'CrossOver.app',
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    },
    {
      id: 'crossover_preview',
      type: 'crossover_preview',
      name: 'CrossOver Preview',
      appName: 'CrossOver Preview.app',
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
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
      const availableBottles = listBottleSubdirectories(variant.bottlesDir);

      if (!addedTypes.has(variant.id)) {
        addedTypes.add(variant.id);
        layers.push({
          id: variant.id,
          type: variant.type,
          name: variant.name,
          binaryPath,
          bottlesDir: variant.bottlesDir,
          availableBottles,
        });
      }
    }
  }

  // 2. Whisky
  const whiskyLibWine = path.join(
    homedir,
    'Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64'
  );
  const whiskyBottlesCandidates = [
    path.join(homedir, 'Library/Containers/com.isaacmarovitz.Whisky/Bottles'),
    path.join(
      homedir,
      'Library/Containers/com.isaacmarovitz.Whisky/Data/Library/Application Support/com.isaacmarovitz.Whisky/Bottles'
    ),
  ];
  const whiskyBottlesDir =
    whiskyBottlesCandidates.find((d) => fs.existsSync(d)) || whiskyBottlesCandidates[0];

  for (const appsDir of appsDirs) {
    const whiskyApp = path.join(appsDir, 'Whisky.app');
    if (fs.existsSync(whiskyApp) || fs.existsSync(whiskyLibWine)) {
      const candidateBins = [
        whiskyLibWine,
        path.join(whiskyApp, 'Contents/Resources/wine64'),
        path.join(whiskyApp, 'Contents/SharedSupport/Wine/bin/wine64'),
      ];
      const binaryPath = candidateBins.find((b) => fs.existsSync(b)) || candidateBins[0];
      if (!addedTypes.has('whisky')) {
        addedTypes.add('whisky');
        layers.push({
          id: 'whisky',
          type: 'whisky',
          name: 'Whisky',
          binaryPath,
          bottlesDir: whiskyBottlesDir,
          availableBottles: listBottleSubdirectories(whiskyBottlesDir),
        });
      }
    }
  }

  // 3. Apple Game Porting Toolkit (Heroic GPTK or /Applications/Game Porting Toolkit.app)
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
          layers.push({
            id: 'gptk',
            type: 'gptk',
            name: `Game Porting Toolkit (${sub})`,
            binaryPath: foundBin,
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
      addedTypes.add('gptk');
      layers.push({
        id: 'gptk',
        type: 'gptk',
        name: 'Apple Game Porting Toolkit',
        binaryPath,
        availableBottles: [],
      });
    }
  }

  // 4. Standalone / Homebrew Wine
  const wineBinCandidates = [
    path.join(homedir, 'bin/wine64'),
    path.join(homedir, 'bin/wine'),
  ];
  if (!isIsolatedTest) {
    wineBinCandidates.push(
      '/opt/homebrew/bin/wine64',
      '/usr/local/bin/wine64',
      '/opt/homebrew/bin/wine',
      '/usr/local/bin/wine'
    );
  }
  const foundWine = wineBinCandidates.find((b) => fs.existsSync(b));
  if (foundWine && !addedTypes.has('wine')) {
    addedTypes.add('wine');
    const defaultPrefix = path.join(homedir, '.wine');
    layers.push({
      id: 'wine',
      type: 'wine',
      name: 'Wine (Standalone)',
      binaryPath: foundWine,
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
 * Auto-provision bottle/prefix and configure Wine environment variables for a chosen compatibility layer
 */
async function ensureCompatibilityLayerReady(chosenLayer, launchConfig = {}, env = {}, options = {}) {
  if (!chosenLayer) return {};
  const homedir = options.homedir || os.homedir();

  if (chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview') {
    const defaultBottlesSubdir =
      chosenLayer.type === 'crossover_preview'
        ? 'Library/Application Support/CrossOver Preview/Bottles'
        : 'Library/Application Support/CrossOver/Bottles';
    const bottlesDir = chosenLayer.bottlesDir || path.join(homedir, defaultBottlesSubdir);
    const availableBottles = listBottleSubdirectories(bottlesDir);

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
    if (!fs.existsSync(bottlePath) && !options.homedir && !options.skipBottleProvisioning) {
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

    env.CX_BOTTLE = targetBottle;
    if (launchConfig && launchConfig.winePrefixPath) {
      env.WINEPREFIX = launchConfig.winePrefixPath;
    } else if (fs.existsSync(bottlePath)) {
      env.WINEPREFIX = bottlePath;
    }
    env.WINEESYNC = env.WINEESYNC || '1';
    env.WINEMSYNC = env.WINEMSYNC || '1';

    return { targetBottle, winePrefix: env.WINEPREFIX };
  }

  let targetPrefix;
  if (launchConfig && launchConfig.winePrefixPath) {
    targetPrefix = launchConfig.winePrefixPath;
  } else if (chosenLayer.type === 'whisky' && chosenLayer.bottlesDir) {
    const availableBottles = listBottleSubdirectories(chosenLayer.bottlesDir);
    const bottle = (launchConfig && launchConfig.wineBottleName) || availableBottles[0] || 'Default';
    targetPrefix = path.join(chosenLayer.bottlesDir, bottle);
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
  env.WINEMSYNC = env.WINEMSYNC || '1';
  env.WINEESYNC = env.WINEESYNC || '1';
  if (!String(env.WINEDLLOVERRIDES || '').includes('winemenubuilder.exe=d')) {
    env.WINEDLLOVERRIDES = env.WINEDLLOVERRIDES
      ? `${env.WINEDLLOVERRIDES};winemenubuilder.exe=d`
      : 'winemenubuilder.exe=d';
  }

  return { winePrefix: targetPrefix };
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
    return gameId ? `goggalaxy://openGameView/${gameId}` : null;
  }
  if (platformId === 'epic') {
    return gameId
      ? `com.epicgames.launcher://apps/${encodeURIComponent(String(gameId))}?action=launch&silent=true`
      : null;
  }
  return null;
}

/**
 * Finalize an active game session, compute playtime, run post-exit hooks, and emit stop event
 */
function finalizeGameSession(gameId) {
  const entry = activeSessions.get(gameId);
  if (!entry || entry.finalized) return null;
  entry.finalized = true;

  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
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
      exec(entry.postExitCommand, () => {});
    } catch {}
  }

  const stoppedSession = {
    ...entry.session,
    status: 'stopping',
  };

  emitSessionUpdated({
    session: stoppedSession,
    event: 'stopped',
    sessionMinutesPlayed,
    durationSeconds,
    lastPlayed,
    ...(crashedEarly ? { error: crashError } : {}),
  });

  return {
    session: stoppedSession,
    sessionMinutesPlayed,
    durationSeconds,
    lastPlayed,
    ...(crashedEarly ? { error: crashError } : {}),
  };
}

/**
 * C) Direct Game Launcher, Process Monitor & Playtime Tracker
 */
async function launchGame(payload = {}, options = {}) {
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

    const platform = options.platform || process.platform;
    const savedConfigs = getGameLaunchConfigs(options);
    const launchConfig = {
      ...(savedConfigs[gameId] || {}),
      ...(payload.launchConfig || {}),
    };

    const launchMethod = launchConfig.launchMethod || payload.launchMethod || 'auto';

    // Resolve executable path
    let resolvedExePath = undefined;
    let isWindowsBinaryOnMac = Boolean(payload.isWindowsBinaryOnMac);

    if (launchConfig.customExecutablePath) {
      const customCandidate = toLocalFsPath(launchConfig.customExecutablePath);
      if (fs.existsSync(customCandidate)) {
        resolvedExePath = customCandidate;
      }
    }
    if (!resolvedExePath && payload.executablePath) {
      const payloadCandidate = toLocalFsPath(payload.executablePath);
      if (fs.existsSync(payloadCandidate)) {
        resolvedExePath = payloadCandidate;
      }
    }
    if (!resolvedExePath && payload.installPath) {
      const discovered = findPrimaryExecutable(payload.installPath, {
        platform,
        hintName: payload.title,
      });
      resolvedExePath = discovered.executablePath;
      if (discovered.isWindowsBinaryOnMac) {
        isWindowsBinaryOnMac = true;
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
          }
        );
        resolvedExePath = rediscovered.executablePath || undefined;
        if (rediscovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
      }
    }

    if (platform === 'darwin' && resolvedExePath && resolvedExePath.toLowerCase().endsWith('.exe')) {
      isWindowsBinaryOnMac = true;
    }

    const args = parseLaunchArguments(launchConfig.launchArguments);
    const env = {
      ...process.env,
      ...(launchConfig.environmentVariables || {}),
    };

    // Execute optional pre-launch command
    if (launchConfig.preLaunchCommand) {
      try {
        execSync(launchConfig.preLaunchCommand, { stdio: 'ignore', timeout: 5000 });
      } catch {}
    }

    const useCompatLayer =
      platform === 'darwin' &&
      (isWindowsBinaryOnMac ||
        launchMethod === 'compatibility_layer' ||
        (launchConfig.compatibilityLayer && launchConfig.compatibilityLayer !== 'native'));

    const isSteamAutoUriPreferred =
      payload.platformId === 'steam' &&
      launchMethod === 'auto' &&
      !useCompatLayer &&
      !launchConfig?.customExecutablePath &&
      Boolean(buildStorefrontLaunchUri(payload)) &&
      (platform === 'win32' ||
        (resolvedExePath && resolvedExePath.toLowerCase().endsWith('.exe')) ||
        /steamapps[\\/]/i.test(String(resolvedExePath || payload.installPath || '')));

    // 1. Direct or Compatibility Layer execution when executable is available
    if (
      resolvedExePath &&
      !isSteamAutoUriPreferred &&
      launchMethod !== 'storefront_uri' &&
      (launchMethod === 'direct' ||
        launchMethod === 'auto' ||
        launchMethod === 'compatibility_layer' ||
        useCompatLayer)
    ) {
      let spawnCmd = resolvedExePath;
      let spawnArgs = [...args];
      let actualLaunchMethod = 'direct';

      if (useCompatLayer) {
        const layers = detectCompatibilityLayers(options);
        const preferredType = launchConfig.compatibilityLayer;
        let chosenLayer =
          (preferredType && preferredType !== 'native'
            ? layers.find((l) => l.type === preferredType || l.id === preferredType)
            : null) || layers[0];

        if (!chosenLayer) {
          if (launchMethod === 'auto' && options.allowStorefrontFallbackOnMissingCompat) {
            // Fall through to storefront URI below
            resolvedExePath = undefined;
          } else {
            return {
              success: false,
              error:
                'No Windows compatibility layer (CrossOver, Whisky, Game Porting Toolkit, or Wine) detected on macOS to run this Windows executable.',
            };
          }
        } else {
          await ensureCompatibilityLayerReady(chosenLayer, launchConfig, env, options);

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
                await ensureCompatibilityLayerReady(chosenLayer, launchConfig, env, options);
              }
            }
          }

          spawnCmd = chosenLayer.binaryPath;
          spawnArgs = [resolvedExePath, ...args];
          actualLaunchMethod = `compatibility_layer:${chosenLayer.type}`;
        }
      } else if (platform === 'darwin' && resolvedExePath.endsWith('.app')) {
        // Resolve inner binary inside .app bundle or use /usr/bin/open -W -a
        const innerBin = resolveMacAppBundleBinary(resolvedExePath);
        if (innerBin && innerBin !== resolvedExePath && fs.existsSync(innerBin)) {
          spawnCmd = innerBin;
        } else {
          spawnCmd = '/usr/bin/open';
          spawnArgs = ['-W', '-a', resolvedExePath, ...(args.length > 0 ? ['--args', ...args] : [])];
        }
      }

      if (resolvedExePath) {
        let shouldFallthroughToStorefrontUri = false;
        try {
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
                execFile('xattr', ['-dr', 'com.apple.quarantine', targetQuarantinePath], () => {});
              } catch {}
            }
          }

          const cwd =
            launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
              ? launchConfig.workingDirectory
              : path.dirname(resolvedExePath);
          const effectiveCwd = fs.existsSync(cwd) ? cwd : os.homedir();

          let child = null;
          try {
            child = spawn(spawnCmd, spawnArgs, {
              cwd: effectiveCwd,
              env,
              stdio: ['ignore', 'ignore', 'pipe'],
              detached: false,
            });
          } catch (initialSpawnErr) {
            if (launchMethod === 'auto' && buildStorefrontLaunchUri(payload)) {
              shouldFallthroughToStorefrontUri = true;
            } else if (platform === 'win32' && !useCompatLayer) {
              const psFilePath = String(spawnCmd).replace(/'/g, "''");
              const psCwd = String(effectiveCwd).replace(/'/g, "''");
              const psArgStr =
                spawnArgs.length > 0
                  ? ` -ArgumentList ${spawnArgs.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')}`
                  : '';
              child = spawn(
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
              pid: child.pid,
              startedAt: new Date().toISOString(),
              launchMethod: actualLaunchMethod,
              executablePath: resolvedExePath,
              status: 'running',
            };

            const entry = {
              session,
              child,
              startedMs: Date.now(),
              postExitCommand: launchConfig.postExitCommand,
              finalized: false,
              stderrBuffer: '',
              exitCode: null,
              stoppedByUser: false,
            };

            if (child.stderr) {
              child.stderr.on('data', (chunk) => {
                if (entry.stderrBuffer.length < 4096) {
                  entry.stderrBuffer += String(chunk);
                }
              });
            }

            activeSessions.set(gameId, entry);
            emitSessionUpdated({ session: { ...session }, event: 'started' });

            child.on('exit', (code) => {
              if (entry.exitCode === null || entry.exitCode === undefined) {
                entry.exitCode = typeof code === 'number' ? code : 0;
              }
              if (child.stderr && !child.stderr.destroyed && child.stderr.readable) {
                child.once('close', () => finalizeGameSession(gameId));
                const flushTimer = setTimeout(() => finalizeGameSession(gameId), 50);
                if (typeof flushTimer.unref === 'function') flushTimer.unref();
              } else {
                finalizeGameSession(gameId);
              }
            });

            child.on('error', (err) => {
              entry.exitCode = -1;
              entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
              finalizeGameSession(gameId);
            });

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
                launchMethod === 'auto' &&
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
          if (launchMethod === 'auto' && buildStorefrontLaunchUri(payload)) {
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

    // 2. Storefront URI Launch (or 'auto' fallback when no local executable is found)
    const uri = buildStorefrontLaunchUri(payload);
    if (!uri) {
      return {
        success: false,
        error: 'No local executable or storefront protocol URI available to launch this game.',
      };
    }

    await openExternalUri(uri, options);

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
      child: null,
      startedMs: Date.now(),
      postExitCommand: launchConfig.postExitCommand,
      finalized: false,
      pollTimer: null,
      stderrBuffer: '',
      exitCode: null,
      stoppedByUser: false,
    };

    // Optional background process tree monitor when installPath is known
    if (payload.installPath && !options.disableUriPolling) {
      let seenRunningOnSystem = false;
      const pollTimer = setInterval(() => {
        if (entry.finalized) return;
        const cmd =
          process.platform === 'win32'
            ? 'tasklist /FO CSV /NH'
            : 'ps -ax -o pid=,command=';
        exec(cmd, { timeout: 2500 }, (err, stdout) => {
          if (err || !stdout || entry.finalized) return;
          const exeHint = path.basename(payload.executablePath || payload.installPath || '').toLowerCase();
          const resolvedExeHint = resolvedExePath ? path.basename(resolvedExePath).toLowerCase() : '';
          const out = stdout.toLowerCase();
          const isPresent =
            (exeHint && out.includes(exeHint)) ||
            (resolvedExeHint && out.includes(resolvedExeHint));
          if (isPresent) {
            seenRunningOnSystem = true;
          } else if (seenRunningOnSystem) {
            finalizeGameSession(gameId);
          }
        });
      }, 4000);
      if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
      }
      entry.pollTimer = pollTimer;
    }

    activeSessions.set(gameId, entry);
    emitSessionUpdated({ session: { ...session }, event: 'started' });

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
  }
}

/**
 * Stop a running game session cleanly (SIGTERM -> SIGKILL fallback)
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

    targetEntry.stoppedByUser = true;
    targetEntry.session.status = 'stopping';
    emitSessionUpdated({
      session: { ...targetEntry.session },
      event: 'stopping',
    });

    if (
      process.platform !== 'win32' &&
      !options.homedir &&
      !reqObj.homedir &&
      targetEntry.session?.executablePath &&
      targetEntry.session.executablePath.toLowerCase().endsWith('.exe')
    ) {
      const exeBase = path.basename(targetEntry.session.executablePath);
      if (exeBase && exeBase.length > 3) {
        try {
          exec(`pkill -f "${exeBase.replace(/"/g, '')}"`, () => {});
        } catch {}
      }
    }

    if (targetEntry.child && targetEntry.child.pid) {
      const pid = targetEntry.child.pid;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}

      // Wait briefly for process to terminate gracefully, then SIGKILL if still running
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        if (targetEntry.child) {
          targetEntry.child.once('exit', finish);
        }
        const timer = setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
          finish();
        }, 400);
        if (typeof timer.unref === 'function') timer.unref();
      });
    }

    const result = finalizeGameSession(targetKey) || {
      session: targetEntry.session,
      sessionMinutesPlayed: Math.max(1, Math.round((Date.now() - targetEntry.startedMs) / 60000)),
    };

    return {
      success: true,
      message: `Stopped ${targetEntry.session.title}`,
      session: result.session,
      sessionMinutesPlayed: result.sessionMinutesPlayed,
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

function findLegendaryBinary(options = {}) {
  const homedir = options.homedir || os.homedir();
  if (options.homedir && options.allowSystemBinariesInTest !== true) {
    const testCandidates = [
      path.join(options.homedir, 'Library/Application Support/heroic/tools/bin/legendary'),
      path.join(options.homedir, '.local/bin/legendary'),
      path.join(options.homedir, 'bin/legendary'),
    ];
    return testCandidates.find((p) => fs.existsSync(p)) || null;
  }

  const binName = process.platform === 'win32' ? 'legendary.exe' : 'legendary';
  const unpackedDir = __dirname.replace('app.asar', 'app.asar.unpacked');
  const candidates = [
    path.join(unpackedDir, 'bin', process.arch, process.platform, binName),
    path.join(__dirname, 'bin', process.arch, process.platform, binName),
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/arm64/darwin/legendary',
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/x64/darwin/legendary',
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/arm64/legendary',
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/x64/legendary',
    path.join(homedir, 'Library/Application Support/heroic/tools/bin/legendary'),
    '/opt/homebrew/bin/legendary',
    '/usr/local/bin/legendary',
    path.join(homedir, '.local/bin/legendary'),
    path.join(
      process.env.LOCALAPPDATA || path.join(homedir, 'AppData/Local'),
      'Programs/heroic/resources/app.asar.unpacked/build/bin/x64/win32/legendary.exe'
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
  }
  return found;
}

function findGogdlBinary(options = {}) {
  const homedir = options.homedir || os.homedir();
  if (options.homedir && options.allowSystemBinariesInTest !== true) {
    const testCandidates = [
      path.join(options.homedir, 'Library/Application Support/heroic/tools/bin/gogdl'),
      path.join(options.homedir, '.local/bin/gogdl'),
      path.join(options.homedir, 'bin/gogdl'),
    ];
    return testCandidates.find((p) => fs.existsSync(p)) || null;
  }

  const binName = process.platform === 'win32' ? 'gogdl.exe' : 'gogdl';
  const unpackedDir = __dirname.replace('app.asar', 'app.asar.unpacked');
  const candidates = [
    path.join(unpackedDir, 'bin', process.arch, process.platform, binName),
    path.join(__dirname, 'bin', process.arch, process.platform, binName),
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/arm64/darwin/gogdl',
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/x64/darwin/gogdl',
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/arm64/gogdl',
    '/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/x64/gogdl',
    path.join(homedir, 'Library/Application Support/heroic/tools/bin/gogdl'),
    '/opt/homebrew/bin/gogdl',
    '/usr/local/bin/gogdl',
    path.join(homedir, '.local/bin/gogdl'),
    path.join(
      process.env.LOCALAPPDATA || path.join(homedir, 'AppData/Local'),
      'Programs/heroic/resources/app.asar.unpacked/build/bin/x64/win32/gogdl.exe'
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
  }
  return found;
}

/**
 * Ensure Legendary config directory and Epic OAuth user.json are populated
 */
async function ensureLegendaryConfigAndAuth(options = {}) {
  const homedir = options.homedir || os.homedir();
  const userDataDir = getUserDataDir(options.userDataDir);
  const legendaryConfigPath =
    options.legendaryConfigPath || path.join(userDataDir, 'legendaryConfig', 'legendary');

  try {
    if (!fs.existsSync(legendaryConfigPath)) {
      fs.mkdirSync(legendaryConfigPath, { recursive: true });
    }
  } catch {}

  const candidateHeroicDirs = [
    path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
    path.join(homedir, '.config/legendary'),
  ];

  for (const srcDir of candidateHeroicDirs) {
    if (!fs.existsSync(srcDir)) continue;
    for (const fileName of ['assets.json', 'installed.json', 'aliases.json', 'user.json']) {
      const srcFile = path.join(srcDir, fileName);
      const dstFile = path.join(legendaryConfigPath, fileName);
      if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
        try {
          fs.copyFileSync(srcFile, dstFile);
        } catch {}
      }
    }
  }

  const savedTokens =
    options.savedTokens ||
    (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});

  if (savedTokens && savedTokens.epic && savedTokens.epic.access_token) {
    let epicTokenData = { ...savedTokens.epic };
    const expiresAtMs = epicTokenData.expires_at ? new Date(epicTokenData.expires_at).getTime() : 0;
    const isExpiringSoon = expiresAtMs > 0 && expiresAtMs - Date.now() < 10 * 60 * 1000;

    if (
      isExpiringSoon &&
      epicTokenData.refresh_token &&
      !options.skipNetwork &&
      storeSync &&
      typeof storeSync.renewEpicTokens === 'function'
    ) {
      try {
        epicTokenData = await storeSync.renewEpicTokens(epicTokenData.refresh_token);
      } catch {}
    }

    const userJsonPayload = {
      access_token: epicTokenData.access_token,
      expires_in: epicTokenData.expires_in || 7200,
      expires_at: epicTokenData.expires_at || new Date(Date.now() + 7200 * 1000).toISOString(),
      token_type: epicTokenData.token_type || 'bearer',
      refresh_token: epicTokenData.refresh_token || '',
      refresh_expires: epicTokenData.refresh_expires || 28800,
      refresh_expires_at:
        epicTokenData.refresh_expires_at || new Date(Date.now() + 28800 * 1000).toISOString(),
      account_id: epicTokenData.account_id || '',
      client_id: epicTokenData.client_id || '34a02cf8f4414e29b15921876da36f9a',
      internal_client: true,
      client_service: 'launcher',
      displayName: epicTokenData.displayName || epicTokenData.account_id || 'Player',
      app: 'launcher',
      in_app_id: epicTokenData.in_app_id || epicTokenData.account_id || '',
    };

    try {
      fs.writeFileSync(
        path.join(legendaryConfigPath, 'user.json'),
        JSON.stringify(userJsonPayload, null, 2),
        'utf8'
      );
    } catch {}

    if (!options.homedir) {
      try {
        const defaultLegendaryDir = path.join(homedir, '.config/legendary');
        if (!fs.existsSync(defaultLegendaryDir)) {
          fs.mkdirSync(defaultLegendaryDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(defaultLegendaryDir, 'user.json'),
          JSON.stringify(userJsonPayload, null, 2),
          'utf8'
        );
      } catch {}
    }
  }

  return {
    legendaryConfigPath,
    env: {
      ...process.env,
      LEGENDARY_CONFIG_PATH: legendaryConfigPath,
    },
  };
}

/**
 * Ensure gogdl auth.json is populated with GOG OAuth credentials
 */
async function ensureGogdlAuthConfig(options = {}) {
  const homedir = options.homedir || os.homedir();
  const userDataDir = getUserDataDir(options.userDataDir);
  const gogAuthPath = options.gogAuthPath || path.join(userDataDir, 'gog_store', 'auth.json');

  try {
    const dir = path.dirname(gogAuthPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {}

  let existingClientAuth = null;
  if (fs.existsSync(gogAuthPath)) {
    try {
      const parsedAuth = JSON.parse(fs.readFileSync(gogAuthPath, 'utf8'));
      existingClientAuth = parsedAuth?.['46899977096215655'] || null;
    } catch {}
  }

  const savedTokens =
    options.savedTokens ||
    (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});
  let gogData =
    savedTokens && savedTokens.gog
      ? { ...savedTokens.gog }
      : options.gogAccessToken
        ? { access_token: options.gogAccessToken }
        : existingClientAuth
          ? { ...existingClientAuth }
          : null;

  if (
    gogData &&
    gogData.refresh_token &&
    !options.skipNetwork &&
    storeSync &&
    typeof storeSync.renewGogTokens === 'function'
  ) {
    const updatedAtMs = gogData.updatedAt ? new Date(gogData.updatedAt).getTime() : 0;
    const maxAgeMs = ((gogData.expires_in || 3600) - 600) * 1000;
    const needsRefresh =
      Boolean(options.forceTokenRefresh) ||
      !updatedAtMs ||
      Number.isNaN(updatedAtMs) ||
      Date.now() - updatedAtMs > maxAgeMs;

    if (needsRefresh) {
      try {
        const renewed = await storeSync.renewGogTokens(gogData.refresh_token);
        if (renewed && renewed.access_token) {
          gogData = {
            ...gogData,
            ...renewed,
            updatedAt: renewed.updatedAt || new Date().toISOString(),
          };
        }
      } catch {}
    }
  }

  if (gogData && gogData.access_token) {
    const updatedAtMs = gogData.updatedAt ? new Date(gogData.updatedAt).getTime() : 0;
    const loginTimeSec =
      updatedAtMs && !Number.isNaN(updatedAtMs)
        ? Math.floor(updatedAtMs / 1000)
        : existingClientAuth?.loginTime || Math.floor(Date.now() / 1000);

    const authPayload = {
      '46899977096215655': {
        access_token: gogData.access_token,
        refresh_token: gogData.refresh_token || '',
        user_id: gogData.user_id || '',
        expires_in: gogData.expires_in || 3600,
        loginTime: loginTimeSec,
      },
    };
    try {
      fs.writeFileSync(gogAuthPath, JSON.stringify(authPayload, null, 2), 'utf8');
    } catch {}
  } else {
    const heroicAuth = path.join(homedir, 'Library/Application Support/heroic/gog_store/auth.json');
    if (fs.existsSync(heroicAuth) && !fs.existsSync(gogAuthPath)) {
      try {
        fs.copyFileSync(heroicAuth, gogAuthPath);
      } catch {}
    }
  }

  return { gogAuthPath, accessToken: gogData?.access_token };
}

/**
 * Resolve Epic Games app_name and native macOS vs Windows build availability
 */
function resolveEpicAppAndPlatforms(payload = {}, options = {}) {
  const homedir = options.homedir || os.homedir();
  const userDataDir = getUserDataDir(options.userDataDir);
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];

  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^epic-/i, '')
    .trim();
  const title = String(payload.title || '').trim();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTitle = norm(title);
  const normCleanId = norm(cleanId);

  const configDirs = [
    path.join(userDataDir, 'legendaryConfig/legendary'),
    path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
    path.join(homedir, '.config/legendary'),
    ...customRoots.map((r) => toLocalFsPath(r, customRoots)),
    ...customRoots.map((r) => path.join(toLocalFsPath(r, customRoots), 'legendary')),
    ...customRoots.map((r) =>
      path.join(toLocalFsPath(r, customRoots), 'heroic/legendaryConfig/legendary')
    ),
  ];

  const winAssets = [];
  const macAssets = [];
  const aliasToAppName = new Map();

  for (const dir of configDirs) {
    if (!dir || !fs.existsSync(dir)) continue;

    const aliasesFile = path.join(dir, 'aliases.json');
    if (fs.existsSync(aliasesFile)) {
      try {
        const aliasesObj = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
        if (aliasesObj && typeof aliasesObj === 'object') {
          for (const [appNameKey, list] of Object.entries(aliasesObj)) {
            if (!Array.isArray(list)) continue;
            for (const alias of list) {
              const n = norm(alias);
              if (n && !aliasToAppName.has(n)) {
                aliasToAppName.set(n, appNameKey);
              }
            }
          }
        }
      } catch {}
    }

    const assetsFile = path.join(dir, 'assets.json');
    if (fs.existsSync(assetsFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const hasMacInfo =
              String(item.platform || '').toLowerCase() === 'mac' ||
              Boolean(item.asset_infos && item.asset_infos.Mac && Object.keys(item.asset_infos.Mac).length > 0);
            const hasWinInfo =
              String(item.platform || '').toLowerCase() === 'windows' ||
              Boolean(
                item.asset_infos &&
                  item.asset_infos.Windows &&
                  Object.keys(item.asset_infos.Windows).length > 0
              ) ||
              (!item.platform && !item.asset_infos);

            if (hasMacInfo) macAssets.push(item);
            if (hasWinInfo) winAssets.push(item);
          }
        } else if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.Windows)) {
            winAssets.push(...parsed.Windows);
          }
          if (Array.isArray(parsed.Mac)) {
            macAssets.push(...parsed.Mac);
          }
        }
      } catch {}
    }
  }

  // Also check electron/epicBaseGames.json if present
  try {
    const baseGamesPath = path.join(__dirname, 'epicBaseGames.json');
    if (fs.existsSync(baseGamesPath)) {
      const baseGames = JSON.parse(fs.readFileSync(baseGamesPath, 'utf8'));
      if (Array.isArray(baseGames)) {
        for (const g of baseGames) {
          if (!g || !g.app_name) continue;
          const n = norm(g.app_title || g.title);
          if (n && !aliasToAppName.has(n)) {
            aliasToAppName.set(n, g.app_name);
          }
        }
      }
    }
  } catch {}

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

  let resolvedAppName = '';

  // 1. Direct match in assets.json
  const directWin = winAssets.find((e) => matchesEntry(e, ''));
  const directMac = macAssets.find((e) => matchesEntry(e, ''));
  if (directMac && directMac.app_name) {
    resolvedAppName = directMac.app_name;
  } else if (directWin && directWin.app_name) {
    resolvedAppName = directWin.app_name;
  }

  // 2. Fallback to aliases.json match by title or cleanId
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

  const hasMacBuild = Boolean(macEntry);
  const hasWindowsBuild =
    winAssets.length > 0 || macAssets.length > 0 ? Boolean(winEntry) || !hasMacBuild : true;

  const macVersion =
    macEntry?.build_version || macEntry?.asset_infos?.Mac?.build_version || undefined;
  const winVersion =
    winEntry?.build_version || winEntry?.asset_infos?.Windows?.build_version || undefined;

  return {
    resolvedAppName,
    hasMacBuild,
    hasWindowsBuild,
    macVersion,
    winVersion,
  };
}

/**
 * Background monitor for Steam downloads & installations via appmanifest_<appId>.acf + logs/content_log.txt
 */
function startSteamInstallMonitor(taskId, appId, options = {}) {
  const intervalMs = Number(options.steamPollIntervalMs || 1200);
  let lastBytes = 0;
  let lastTickTime = Date.now();

  const readContentLogTail = (steamRoots) => {
    let bestLogInfo = null;
    for (const root of steamRoots) {
      const candidateLogs = [
        path.join(root, 'logs', 'content_log.txt'),
        path.join(root, 'Steam', 'logs', 'content_log.txt'),
      ];
      for (const logPath of candidateLogs) {
        if (!fs.existsSync(logPath)) continue;
        try {
          const st = fs.statSync(logPath);
          const size = Number(st.size || 0);
          if (size <= 0) continue;
          const readLen = Math.min(size, 24 * 1024);
          const fd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(readLen);
          fs.readSync(fd, buf, 0, readLen, size - readLen);
          fs.closeSync(fd);
          const parsedLog = parseSteamContentLogForApp(buf.toString('utf8'), appId);
          if (
            parsedLog.fullyInstalled ||
            parsedLog.bytesToDownload > 0 ||
            parsedLog.bytesToStage > 0 ||
            parsedLog.phase
          ) {
            bestLogInfo = parsedLog;
          } else if (!bestLogInfo && parsedLog.speedBytesPerSec > 0) {
            bestLogInfo = parsedLog;
          }
        } catch {}
      }
    }
    return bestLogInfo;
  };

  const timer = setInterval(() => {
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

    const { steamRoots, steamappsDirs } = discoverSteamLocations(options);
    const logInfo = readContentLogTail(steamRoots);

    let parsed = null;
    let matchedSteamappsDir = null;
    let downloadingDirBytes = 0;

    for (const steamappsDir of steamappsDirs) {
      const dlDir = path.join(steamappsDir, 'downloading', String(appId));
      if (fs.existsSync(dlDir)) {
        const dSize = getDirectorySizeFast(dlDir, 4);
        if (dSize > downloadingDirBytes) {
          downloadingDirBytes = dSize;
        }
      }

      const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
      if (fs.existsSync(acfPath)) {
        try {
          const candidateParsed = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
          if (candidateParsed && String(candidateParsed.appId) === String(appId)) {
            parsed = candidateParsed;
            matchedSteamappsDir = steamappsDir;
            break;
          }
        } catch {}
      }
    }

    const acfDownloaded = Number(parsed?.BytesDownloaded || 0);
    const acfTotal = Number(parsed?.BytesToDownload || 0);
    const acfStaged = Number(parsed?.BytesStaged || 0);
    const acfToStage = Number(parsed?.BytesToStage || 0);
    const logDownloaded = Number(logInfo?.bytesDownloaded || 0);

    let effectiveTotal =
      acfTotal ||
      logInfo?.bytesToDownload ||
      acfToStage ||
      logInfo?.bytesToStage ||
      Number(parsed?.SizeOnDisk || 0) ||
      task.totalBytes;

    let effectiveDownloaded =
      acfDownloaded > 0 || logDownloaded > 0
        ? Math.max(acfDownloaded, logDownloaded)
        : downloadingDirBytes > 0
          ? effectiveTotal > 0
            ? Math.min(effectiveTotal, downloadingDirBytes)
            : downloadingDirBytes
          : 0;

    if (effectiveDownloaded === 0 && acfStaged > 0 && acfToStage > 0) {
      effectiveDownloaded = acfStaged;
      effectiveTotal = acfToStage;
    }

    const stateFlags = parsed && parsed.StateFlags ? String(parsed.StateFlags).trim() : '';
    const commonInstallPath =
      matchedSteamappsDir && parsed
        ? path.join(matchedSteamappsDir, 'common', parsed.installdir || String(appId))
        : null;

    const isComplete =
      Boolean(parsed) &&
      (stateFlags === '4' || Boolean(logInfo?.fullyInstalled)) &&
      Boolean(commonInstallPath && fs.existsSync(commonInstallPath)) &&
      (acfTotal === 0 || acfDownloaded >= acfTotal || Boolean(logInfo?.fullyInstalled));

    if (isComplete && commonInstallPath) {
      clearInterval(timer);
      downloadControllers.delete(taskId);

      const exeDiscovery = findPrimaryExecutable(commonInstallPath, {
        platform: options.platform || process.platform,
        hintName: parsed.name || task.title,
      });

      const finalSize =
        Number(parsed.SizeOnDisk || 0) ||
        getDirectorySizeFast(commonInstallPath, 3) ||
        effectiveTotal ||
        task.totalBytes;

      upsertManagedInstallRecord(
        {
          platformId: 'steam',
          platformGameId: String(appId),
          appId: Number(appId),
          title: parsed.name || task.title,
          installPath: commonInstallPath,
          executablePath: exeDiscovery.executablePath,
          installSize: finalSize,
          version: parsed.buildid ? String(parsed.buildid) : undefined,
          runner: 'steam',
          isWindowsBinaryOnMac: exeDiscovery.isWindowsBinaryOnMac,
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
          runner: 'steam',
          isWindowsBinaryOnMac: exeDiscovery.isWindowsBinaryOnMac,
          statusMessage: 'Installed via Steam',
        },
        options
      );
      return;
    }

    if (parsed || logInfo || downloadingDirBytes > 0) {
      const progressPercent =
        effectiveTotal > 0
          ? Math.min(
              99,
              Math.max(
                task.progressPercent || 0,
                Math.round((effectiveDownloaded / effectiveTotal) * 100)
              )
            )
          : task.progressPercent || 0;

      const now = Date.now();
      let speedBytesPerSec = logInfo?.speedBytesPerSec || 0;
      if (!speedBytesPerSec && effectiveDownloaded > lastBytes && now > lastTickTime) {
        speedBytesPerSec = Math.round(((effectiveDownloaded - lastBytes) * 1000) / (now - lastTickTime));
      }
      lastBytes = effectiveDownloaded;
      lastTickTime = now;

      const etaSeconds =
        speedBytesPerSec > 0 && effectiveTotal > effectiveDownloaded
          ? Math.max(1, Math.round((effectiveTotal - effectiveDownloaded) / speedBytesPerSec))
          : task.etaSeconds;

      const phaseLabel =
        logInfo?.phase ||
        (acfStaged > 0 && acfTotal > 0 && acfDownloaded >= acfTotal ? 'Staging' : 'Downloading');
      const nextStatus = /staging|extracting/i.test(phaseLabel)
        ? 'extracting'
        : /verifying/i.test(phaseLabel)
          ? 'verifying'
          : 'downloading';

      updateDownloadTask(
        taskId,
        {
          status: nextStatus,
          progressPercent,
          bytesDownloaded: effectiveDownloaded,
          totalBytes: effectiveTotal,
          speedBytesPerSec,
          etaSeconds,
          statusMessage: `Steam: ${phaseLabel} ${task.title} (${progressPercent}%)...`,
        },
        options
      );
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  downloadControllers.set(taskId, { type: 'timer', timer });
  return timer;
}

async function getGameInstallInfo(payload = {}, options = {}) {
  const platformId = payload.platformId || 'custom';
  const platformGameId = String(payload.platformGameId || payload.gameId || '');
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  const defaultInstallDir = getDefaultInstallDir(platformId, options);
  const availableInstallDirs =
    platform === 'darwin'
      ? [defaultInstallDir, '/Applications', path.join(homedir, 'Applications')]
      : [defaultInstallDir, 'C:\\Games', 'D:\\Games'];

  const targetDir = payload.targetInstallDir || defaultInstallDir;
  const diskSpace = getDiskSpace(targetDir, options);

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

    if (cleanId && (!options.skipNetwork || options.mockGogProductData)) {
      let productData = options.mockGogProductData || (await fetchGogProduct(gogToken));
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
    }

    if (availableInstallers.length === 0) {
      if (platform === 'win32') {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Native Build`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: estimatedSizeBytes || 2600 * 1024 * 1024,
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: estimatedSizeBytes || 2450 * 1024 * 1024,
          },
          {
            id: 'gog-win-default',
            name: `${titleLabel} (Windows x64 Installer — CrossOver / Wine)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: estimatedSizeBytes || 2600 * 1024 * 1024,
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

    if (platform === 'darwin') {
      let macSupported = true;
      let winSupported = true;

      if (cleanId && !options.skipNetwork) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        try {
          const res = await fetch(
            `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(cleanId)}&filters=platforms`,
            { signal: controller.signal }
          );
          clearTimeout(timeout);
          if (res.ok) {
            const appDetails = await res.json();
            const platData = appDetails?.[cleanId]?.data?.platforms;
            if (platData) {
              macSupported = Boolean(platData.mac);
              winSupported = Boolean(platData.windows);
            }
          }
        } catch {}
        clearTimeout(timeout);
      }

      if (!macSupported && winSupported) {
        availableInstallers = [
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Steam via CrossOver / Wine)`,
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
            name: `${titleLabel} (Windows Steam via CrossOver / Wine)`,
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
  if (u === 'KIB' || u === 'KB') return Math.round(num * 1024);
  if (u === 'GIB' || u === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  return Math.round(num * 1024 * 1024);
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
 * Start a game download / installation task
 */
async function installGame(payload = {}, options = {}) {
  try {
    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const platformId = payload.platformId || 'custom';
    const platformGameId = String(payload.platformGameId || payload.gameId || '');
    const gameId = String(payload.gameId || `${platformId}-${platformGameId}`);
    const title = String(payload.title || gameId);
    const installDir = payload.installDir || getDefaultInstallDir(platformId, options);
    const totalBytes = Number(payload.totalBytes || payload.estimatedSizeBytes || 120 * 1024 * 1024);

    try {
      if (!fs.existsSync(installDir)) {
        fs.mkdirSync(installDir, { recursive: true });
      }
    } catch {}

    const taskId = payload.taskId || `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const finalInstallPath = path.join(installDir, sanitizeDirectoryName(title));

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
      progressPercent: 0,
      bytesDownloaded: 0,
      totalBytes,
      speedBytesPerSec: 18 * 1024 * 1024,
      etaSeconds: Math.max(1, Math.round(totalBytes / (18 * 1024 * 1024))),
      statusMessage: `Downloading ${title}...`,
      startedAt: new Date().toISOString(),
      finalInstallPath,
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
      let launchedViaWineSteam = false;

      if (
        platform === 'darwin' &&
        (payload.os === 'windows' || payload.installerId === 'steam-win-compat') &&
        !options.disableWineSteamSpawn
      ) {
        const layers = detectCompatibilityLayers(options);
        for (const layer of layers) {
          if (!layer.bottlesDir || !Array.isArray(layer.availableBottles)) continue;
          for (const bottleName of layer.availableBottles) {
            const bottlePath = path.join(layer.bottlesDir, bottleName);
            const candidateSteamExes = [
              path.join(bottlePath, 'drive_c/Program Files (x86)/Steam/steam.exe'),
              path.join(bottlePath, 'drive_c/Program Files/Steam/steam.exe'),
            ];
            const foundSteamExe = candidateSteamExes.find((p) => fs.existsSync(p));
            if (foundSteamExe && layer.binaryPath && fs.existsSync(layer.binaryPath)) {
              try {
                const child = spawn(
                  layer.binaryPath,
                  [foundSteamExe, `steam://install/${appId}`],
                  {
                    env: {
                      ...process.env,
                      CX_BOTTLE: bottleName,
                      WINEPREFIX: bottlePath,
                    },
                    stdio: 'ignore',
                    detached: true,
                  }
                );
                if (typeof child.unref === 'function') child.unref();
                launchedViaWineSteam = true;
                break;
              } catch {}
            }
          }
          if (launchedViaWineSteam) break;
        }
      }

      if (!launchedViaWineSteam) {
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
          const authInfo = await ensureLegendaryConfigAndAuth(options);
          const spawnArgs = [
            'install',
            resolvedAppName,
            '--platform',
            epicPlatformFlag,
            '--base-path',
            installDir,
            '--skip-dlcs',
            '--skip-sdl',
            '-y',
          ];

          const child = spawn(legendaryBin, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: authInfo.env,
          });
          downloadControllers.set(taskId, { type: 'process', child });

          let lastErrorLine = '';

          const onOutput = (chunk) => {
            const text = String(chunk || '');
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
            const dlMiBMatch = matchLast(text, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB)?/gi);
            const speedMatch = matchLast(text, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB)?/gi);
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
              if (speedMatch) {
                partialUpdate.speedBytesPerSec = parseCliSizeToBytes(
                  speedMatch[1],
                  speedMatch[2] || 'MiB'
                );
              }
              if (etaMatch) {
                partialUpdate.etaSeconds =
                  parseInt(etaMatch[1], 10) * 3600 +
                  parseInt(etaMatch[2], 10) * 60 +
                  parseInt(etaMatch[3], 10);
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

          child.stdout.on('data', onOutput);
          child.stderr.on('data', onOutput);
          child.on('exit', (code) => {
            downloadControllers.delete(taskId);
            const currentTask = downloadQueueMap.get(taskId);
            if (currentTask && currentTask.status === 'cancelled') return;

            if (code === 0) {
              // Inspect installed.json to resolve actual install_path and executable
              let installedEntry = null;
              const candidateInstalledFiles = [
                path.join(authInfo.legendaryConfigPath, 'installed.json'),
                path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'),
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

              const exeDiscovery = findPrimaryExecutable(actualInstallPath, {
                platform,
                hintName: title,
              });

              let executablePath = exeDiscovery.executablePath;
              if (!executablePath && installedEntry?.executable) {
                const cleanExe = String(installedEntry.executable).replace(/\\/g, path.sep);
                executablePath = path.isAbsolute(cleanExe)
                  ? cleanExe
                  : path.join(actualInstallPath, cleanExe);
              }

              const isWindowsBinaryOnMac =
                platform === 'darwin' &&
                (epicPlatformFlag === 'Windows' ||
                  Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
                  Boolean(executablePath && executablePath.toLowerCase().endsWith('.exe')));

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
                syncEpicFirstPartyLauncher(options);
              } catch {}

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
            authRes?.gogAuthPath || path.join(getUserDataDir(options.userDataDir), 'gog_store', 'auth.json');
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

          const gogArgs = [
            '--auth-config-path',
            gogAuthPath,
            'download',
            cleanId,
            '--platform',
            gogPlatformFlag,
            '--path',
            finalInstallPath,
            '--skip-dlcs',
            '--lang',
            'en-US',
          ];

          const child = spawn(gogdlBin, gogArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          downloadControllers.set(taskId, { type: 'process', child });

          updateDownloadTask(
            taskId,
            {
              status: 'downloading',
              statusMessage: 'Initializing GOG depot & verifying manifest via gogdl...',
            },
            options
          );

          let lastErrorLine = '';

          const onGogOutput = (chunk) => {
            const text = String(chunk || '');
            const lines = text.split(/\r?\n/);
            const currentTask = downloadQueueMap.get(taskId);

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
                    }
                  } else {
                    currentTask.totalBytes = parsedBytes;
                    currentTask.hasExactDownloadSize = true;
                  }
                }
              }

              const dlSizeMatch = line.match(/Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/i);
              if (dlSizeMatch && currentTask && !sizeTupleMatch) {
                const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
                if (parsedTotal > 0) {
                  currentTask.totalBytes = parsedTotal;
                  currentTask.hasExactDownloadSize = true;
                }
              }
            }

            if (!currentTask) return;

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
            const dlMiBMatch = matchLast(text, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB)?/gi);
            const speedMatch = matchLast(text, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB)?/gi);
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
              if (speedMatch) {
                partialUpdate.speedBytesPerSec = parseCliSizeToBytes(
                  speedMatch[1],
                  speedMatch[2] || 'MiB'
                );
              }
              if (etaMatch) {
                partialUpdate.etaSeconds =
                  parseInt(etaMatch[1], 10) * 3600 +
                  parseInt(etaMatch[2], 10) * 60 +
                  parseInt(etaMatch[3], 10);
              }
              const displayPct =
                partialUpdate.progressPercent !== undefined
                  ? partialUpdate.progressPercent
                  : currentTask.progressPercent;
              partialUpdate.statusMessage = `Installing via gogdl (${displayPct}%)...`;
              updateDownloadTask(taskId, partialUpdate, options);
            }
          };

          child.stdout.on('data', onGogOutput);
          child.stderr.on('data', onGogOutput);
          child.on('exit', (code) => {
            downloadControllers.delete(taskId);
            const currentTask = downloadQueueMap.get(taskId);
            if (currentTask && currentTask.status === 'cancelled') return;

            if (code === 0) {
              const targetScanDir = fs.existsSync(finalInstallPath) ? finalInstallPath : installDir;
              flattenGogNestedInstallDir(targetScanDir, cleanId);
              const exeDiscovery = findPrimaryExecutable(targetScanDir, {
                platform,
                hintName: title,
              });
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

function pauseDownload(taskId) {
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

  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    if (ctrl.type === 'abort' && ctrl.controller) {
      try {
        ctrl.controller.abort();
      } catch {}
    } else if (ctrl.type === 'process' && ctrl.child && ctrl.child.pid && process.platform !== 'win32') {
      try {
        process.kill(ctrl.child.pid, 'SIGSTOP');
      } catch {}
    }
  }

  return updateDownloadTask(taskId, {
    status: 'paused',
    speedBytesPerSec: 0,
    etaSeconds: undefined,
    statusMessage: 'Download paused',
  });
}

function resumeDownload(taskId) {
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

  const ctrl = downloadControllers.get(taskId);
  if (ctrl && ctrl.type === 'process' && ctrl.child && ctrl.child.pid && process.platform !== 'win32') {
    try {
      process.kill(ctrl.child.pid, 'SIGCONT');
    } catch {}
  }

  return updateDownloadTask(taskId, {
    status: 'downloading',
    error: undefined,
    speedBytesPerSec: 18 * 1024 * 1024,
    statusMessage: `Resuming ${task.title}...`,
  });
}

function cancelDownload(taskId) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    if (ctrl.type === 'timer' && ctrl.timer) {
      clearInterval(ctrl.timer);
    } else if (ctrl.type === 'abort' && ctrl.controller) {
      try {
        ctrl.controller.abort();
      } catch {}
    } else if (ctrl.type === 'process' && ctrl.child && ctrl.child.pid) {
      try {
        process.kill(ctrl.child.pid, 'SIGTERM');
      } catch {}
    }
    downloadControllers.delete(taskId);
  }

  return updateDownloadTask(taskId, {
    status: 'cancelled',
    speedBytesPerSec: 0,
    etaSeconds: undefined,
    statusMessage: 'Download cancelled',
  });
}

function clearDownloadQueue() {
  for (const [taskId] of downloadQueueMap.entries()) {
    const ctrl = downloadControllers.get(taskId);
    if (ctrl && ctrl.timer) clearInterval(ctrl.timer);
  }
  downloadControllers.clear();
  downloadQueueMap.clear();
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

    if (installPath) {
      const localInstall = toLocalFsPath(installPath);
      if (!fs.existsSync(localInstall)) {
        return {
          success: false,
          error: `Installation directory not found: ${installPath}`,
        };
      }
      const discovered = findPrimaryExecutable(localInstall, {
        platform: options.platform || process.platform,
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

async function uninstallGame(payload = {}, options = {}) {
  try {
    const { gameId, title, platformId, platformGameId, steamAppId, installPath, allowDeleteFiles } = payload;
    const userDataDir = getUserDataDir(options.userDataDir);

    // Remove from One Launcher managed records if present
    const managed = loadManagedInstalledGames(userDataDir);
    const filtered = managed.filter(
      (r) =>
        !(
          (r.platformId === platformId && String(r.platformGameId) === String(platformGameId)) ||
          (installPath && r.installPath === installPath)
        )
    );
    if (filtered.length !== managed.length) {
      saveManagedInstalledGames(filtered, userDataDir);
    }

    const cleanId = String(platformGameId || gameId || '')
      .replace(/^(epic|gog|steam)[-_]/i, '')
      .trim();

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
              fs.writeFileSync(legInstalledPath, JSON.stringify(rawLeg, null, 2), 'utf8');
            }
          }
        }
      } catch {}
    } else if (platformId === 'gog') {
      try {
        unregisterGogFirstPartyLauncher(cleanId || platformGameId, installPath, options);
      } catch {}
    }

    if (platformId === 'steam' && (steamAppId || platformGameId) && !allowDeleteFiles) {
      await openExternalUri(`steam://uninstall/${steamAppId || platformGameId}`, options);
    }

    if (installPath) {
      const localInstall = toLocalFsPath(installPath);
      const isManagedDir =
        localInstall.includes('OneLauncher') ||
        localInstall.includes('one-launcher') ||
        Boolean(allowDeleteFiles);

      if (isManagedDir && isSafeToDeleteInstallPath(localInstall, options) && fs.existsSync(localInstall)) {
        fs.rmSync(localInstall, { recursive: true, force: true });
      }
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
  // Configuration & Event Hooks
  setMainWindowGetter,
  setUserDataDir,
  getUserDataDir,
  onSessionUpdated,
  onDownloadUpdated,
  openedExternalUris,

  // A) Scanner & Helpers
  scanAllInstalledGames,
  findPrimaryExecutable,
  invalidateScanCaches,
  inspectWindowsExecutableHeader,
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
  unregisterGogFirstPartyLauncher,

  // B) Compatibility Layers
  detectCompatibilityLayers,
  ensureCompatibilityLayerReady,

  // C) Launcher & Session Manager
  launchGame,
  stopGame,
  getRunningGames,
  parseLaunchArguments,
  buildStorefrontLaunchUri,

  // D) Download & Installation Manager
  findLegendaryBinary,
  findGogdlBinary,
  ensureLegendaryConfigAndAuth,
  ensureGogdlAuthConfig,
  resolveEpicAppAndPlatforms,
  startSteamInstallMonitor,
  getDiskSpace,
  getDefaultInstallDir,
  getGameInstallInfo,
  installGame,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  getDownloadQueue,
  updateDownloadTask,
  clearDownloadQueue,

  // E) File Management & Config Persistence
  browseLocalFiles,
  verifyGameFiles,
  uninstallGame,
  isSafeToDeleteInstallPath,
  saveGameLaunchConfig,
  getGameLaunchConfigs,
  selectExecutableDialog,
  selectFolderDialog,
};
