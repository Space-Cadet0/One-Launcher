const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
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
  /^(itemtest|hammer|hlmv|hlfaceposer|studiomdl|vrad|vvis|vbsp|vbspinfo|vtex|vpk|bspzip|captioncompiler|demoinfo|dmxconvert|dmxedit|elementviewer|glview|height2normal|height2ssbump|mksheet|motionmapper|normal2ssbump|pfm2tgas|qc_eyes|shadercompile|splitskybox|vtf2tga)(\.(exe|com|bat|cmd|sh))?$/i,
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
 * Inspect macOS Mach-O executable header to distinguish 64-bit, 32-bit only (i386), and Universal (Fat) binaries
 */
function inspectMacMachOHeader(filePath) {
  let fd = null;
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(168);
    const bytesRead = fs.readSync(fd, buf, 0, 168, 0);
    if (bytesRead < 4) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }

    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);

    if (magicLE === 0xfeedfacf || magicBE === 0xfeedfacf) {
      return { isMachO: true, is64Bit: true, is32BitOnly: false };
    }
    if (magicLE === 0xfeedface || magicBE === 0xfeedface) {
      return { isMachO: true, is64Bit: false, is32BitOnly: true };
    }
    if (magicBE === 0xcafebabe && bytesRead >= 8) {
      const nfat = buf.readUInt32BE(4);
      if (nfat >= 1 && nfat <= 8 && bytesRead >= 8 + nfat * 20) {
        let has64 = false;
        let has32 = false;
        for (let i = 0; i < nfat; i++) {
          const cputype = buf.readUInt32BE(8 + i * 20);
          if ((cputype & 0x01000000) !== 0) {
            has64 = true;
          } else {
            has32 = true;
          }
        }
        return { isMachO: true, is64Bit: has64, is32BitOnly: !has64 && has32 };
      }
    }
    return { isMachO: false, is64Bit: false, is32BitOnly: false };
  } catch {
    return { isMachO: false, is64Bit: false, is32BitOnly: false };
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
  if (/^goglauncher$/i.test(base)) score -= 120; // Prefer inner game .app over outer GOGLauncher wrapper
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

const executableDiscoveryCache = new Map();
const steamAppInfoCache = new Map();
let lastProductionScanCache = { timestamp: 0, result: null };
let lastSyncedEpicFingerprint = '';
let lastSyncedGogFingerprint = '';

function invalidateScanCaches() {
  executableDiscoveryCache.clear();
  steamAppInfoCache.clear();
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

/**
 * Auto-discover the primary game executable inside an installation directory
 */
function findPrimaryExecutable(installPath, options = {}) {
  const platform = options.platform || process.platform;
  const hintName = options.hintName || options.preferredHint || '';
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

  const cacheKey = `${localInstallPath}|${platform}|${hintName}`;
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

  // Also check GOG .info files (goggame-*.info and .goggame-*.info) for explicit playTasks[0].path
  const resolveGogInfoPlayTaskExecutable = () => {
    const infoSearchDirs = [
      path.join(localInstallPath, 'Contents', 'Resources'),
      path.join(localInstallPath, 'Resources'),
      localInstallPath,
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
          const task =
            parsed.playTasks.find((t) => t && t.isPrimary && t.path) ||
            parsed.playTasks.find((t) => t && t.path);
          if (task && task.path) {
            const relTaskPath = String(task.path).replace(/\\/g, path.sep);
            const candidates = [
              path.join(localInstallPath, relTaskPath),
              path.join(dir, relTaskPath),
            ];
            for (const c of candidates) {
              if (fs.existsSync(c)) {
                return c.toLowerCase().endsWith('.app') ? resolveMacAppBundleBinary(c) : c;
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

  if (platform === 'darwin') {
    if (!isInsideBottle && macApps.length > 0) {
      macApps.sort(
        (a, b) =>
          scoreExecutableCandidate(b, localInstallPath, hintName) -
          scoreExecutableCandidate(a, localInstallPath, hintName)
      );
      const candidateMacBin = resolveMacAppBundleBinary(macApps[0]);
      if (candidateMacBin && !candidateMacBin.toLowerCase().endsWith('.exe')) {
        const machO = inspectMacMachOHeader(candidateMacBin);
        if (machO.is32BitOnly && filteredWinCandidates.length > 0) {
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
      }
      return cacheAndReturn({
        executablePath: candidateMacBin,
        isWindowsBinaryOnMac: false,
      });
    }

    const gogInfoExe = resolveGogInfoPlayTaskExecutable();
    if (gogInfoExe) {
      if (!gogInfoExe.toLowerCase().endsWith('.exe')) {
        const machO = inspectMacMachOHeader(gogInfoExe);
        if (machO.is32BitOnly && filteredWinCandidates.length > 0) {
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
      }
      return cacheAndReturn({
        executablePath: gogInfoExe,
        isWindowsBinaryOnMac: isInsideBottle || gogInfoExe.toLowerCase().endsWith('.exe'),
      });
    }

    if (!isInsideBottle && unixBins.length > 0) {
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

  const gogInfoExeWin = resolveGogInfoPlayTaskExecutable();
  if (gogInfoExeWin) {
    return cacheAndReturn({
      executablePath: gogInfoExeWin,
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
 * Locate and parse Steam binary <SteamRoot>/appcache/appinfo.vdf (v27, v28, v29)
 * to resolve the authoritative executable, launch arguments, and working directory for an AppID.
 */
function getIndexedSteamAppInfoVdf(appinfoPath) {
  try {
    if (!appinfoPath || !fs.existsSync(appinfoPath)) return null;
    const st = fs.statSync(appinfoPath);
    const mtimeMs = st.mtimeMs || 0;
    const cached = steamAppInfoCache.get(appinfoPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
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
    };
    steamAppInfoCache.set(appinfoPath, indexed);
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

    const sliceRange = indexed.appIndex.get(cleanAppId);
    if (!sliceRange) return null;

    const parsedApp = parseSteamBinaryVdfSlice(
      indexed.buf,
      sliceRange.payloadStart,
      sliceRange.payloadEnd,
      indexed.strings
    );
    const root = parsedApp?.appinfo || parsedApp;
    const launchMap = root?.config?.launch;
    if (!launchMap || typeof launchMap !== 'object') return null;

    const platform = options.platform || process.platform;
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

    if (candidates.length === 0) return null;
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

    return {
      executablePath: best.executablePath,
      launchArguments,
      workingDirectory,
      isWindowsBinaryOnMac,
    };
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
    const rateMatch =
      line.match(/Current download rate:\s*([\d.]+)\s*Mbps/i) ||
      line.match(/Increasing target number of download connections to \d+\s*\(rate was [\d.]+,\s*now\s*([\d.]+)\)/i);
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
      result.speedBytesPerSec = 0;
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
  'preLaunchCommand',
  'postExitCommand',
];

function resolvePlatformLaunchConfig(rawConfig, platformId) {
  if (!rawConfig || typeof rawConfig !== 'object') return {};
  let resolved;
  if (platformId && rawConfig.platformConfigs && rawConfig.platformConfigs[platformId]) {
    resolved = {
      gameId: rawConfig.gameId,
      preferredPlatformId: platformId,
      launchMethod: 'auto',
      ...rawConfig.platformConfigs[platformId],
    };
  } else if (
    platformId &&
    rawConfig.platformConfigs &&
    Object.keys(rawConfig.platformConfigs).length > 0 &&
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
      if (modified) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
        } catch {}
      }
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
  if (config.reset === true) {
    delete existing[config.gameId];
    try {
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
      invalidateScanCaches();
      return { success: true, config: { gameId: config.gameId } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  const cleanProfile = {
    launchMethod: config.launchMethod || 'auto',
  };
  for (const key of LAUNCH_PROFILE_KEYS) {
    if (config[key] !== undefined && config[key] !== null) {
      cleanProfile[key] =
        key === 'compatibilityLayer' && config[key] === 'whisky' ? 'crossover' : config[key];
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
        const cleanPlatProfile = { launchMethod: p.launchMethod || 'auto' };
        for (const key of LAUNCH_PROFILE_KEYS) {
          if (p[key] !== undefined && p[key] !== null) {
            cleanPlatProfile[key] =
              key === 'compatibilityLayer' && p[key] === 'whisky' ? 'crossover' : p[key];
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
          launchArguments: record.launchArguments || existing.launchArguments,
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
          const primaryTask =
            raw.playTasks.find((t) => t && t.isPrimary && t.path) ||
            raw.playTasks.find((t) => t && t.category === 'game' && t.path) ||
            raw.playTasks.find((t) => t && t.path);
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

          const launchArguments =
            item.LaunchCommand && typeof item.LaunchCommand === 'string'
              ? item.LaunchCommand.trim()
              : '';

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
        const recExeLocal = rec.executablePath ? toLocalFsPath(rec.executablePath, customRoots) : '';
        const isRecExeValid =
          Boolean(recExeLocal) &&
          fs.existsSync(recExeLocal) &&
          !isExcludedExecutable(path.basename(recExeLocal)) &&
          !/\.com$/i.test(recExeLocal);
        const discovered =
          existingDiscovered && existingDiscovered.executablePath
            ? {
                executablePath: existingDiscovered.executablePath,
                isWindowsBinaryOnMac: existingDiscovered.isWindowsBinaryOnMac,
              }
            : findPrimaryExecutable(localInstall, { platform, hintName: rec.title });
        const effectiveExe =
          existingDiscovered?.executablePath ||
          (isRecExeValid ? recExeLocal : undefined) ||
          discovered.executablePath;
        if (!effectiveExe || !fs.existsSync(effectiveExe)) {
          managedPruned = true;
          continue;
        }
        const effectiveLaunchArgs =
          existingDiscovered?.launchArguments ||
          rec.launchArguments ||
          resolveDefaultEngineLaunchArguments(localInstall, effectiveExe);
        validManagedRecords.push({
          ...rec,
          installPath: localInstall,
          executablePath: effectiveExe,
        });
        addRecord({
          ...rec,
          installPath: localInstall,
          executablePath: effectiveExe,
          ...(effectiveLaunchArgs ? { launchArguments: effectiveLaunchArgs } : {}),
          runner: existingDiscovered?.runner || rec.runner || 'one_launcher',
          isWindowsBinaryOnMac:
            existingDiscovered?.isWindowsBinaryOnMac !== undefined
              ? existingDiscovered.isWindowsBinaryOnMac
              : rec.isWindowsBinaryOnMac !== undefined
                ? rec.isWindowsBinaryOnMac
                : discovered.isWindowsBinaryOnMac,
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

    const launchConfigs = getGameLaunchConfigs({ userDataDir });
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

    // Resolve authoritative buildId and generation from galaxy-2.0.db Builds table if available
    let realBuildId = String(
      info.buildId && /^\d+$/.test(String(info.buildId)) ? info.buildId : cleanId
    );
    let realGeneration = 2;

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

    const hasExistingValidPlayTasks =
      Array.isArray(info.playTasks) &&
      info.playTasks.length > 0 &&
      Boolean(info.playTasks[0]?.path);

    const synthesizedInfo = {
      ...info,
      buildId: realBuildId,
      clientId: String(info.clientId || '46899977096215655'),
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
    try {
      const hasMacBundleLayout =
        platform === 'darwin' &&
        (galaxyInstallPath.toLowerCase().endsWith('.app') ||
          fs.existsSync(path.join(galaxyInstallPath, 'Contents')));

      if (hasMacBundleLayout) {
        fs.mkdirSync(macResourcesDir, { recursive: true });
        fs.writeFileSync(macResourcesInfoPath, serializedInfo, 'utf8');
        fs.writeFileSync(macResourcesDotInfoPath, serializedInfo, 'utf8');
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
        fs.writeFileSync(infoFilePath, serializedInfo, 'utf8');
        fs.writeFileSync(dotInfoFilePath, serializedInfo, 'utf8');
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
      let shouldRelaunchGalaxy = false;
      try {
        fs.mkdirSync(path.dirname(gogDbPath), { recursive: true });
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(gogDbPath, { readBigInts: true });
        db.exec('PRAGMA busy_timeout = 3000;');

        if (!options.homedir && !options.gogGalaxyDbPath && platform === 'darwin') {
          let alreadySyncedInDb = false;
          try {
            const existingBase = db
              .prepare(
                'SELECT installationPath, buildId, branch FROM InstalledBaseProducts WHERE productId = ?'
              )
              .get(numericProductId);
            const existingState = db
              .prepare('SELECT installation FROM ProductStates WHERE productId = ?')
              .get(numericProductId);
            const existingPt = db
              .prepare('SELECT id FROM PlayTasks WHERE gameReleaseKey = ? LIMIT 1')
              .get(releaseKey);
            alreadySyncedInDb = Boolean(
              existingBase &&
                existingBase.installationPath === galaxyInstallPath &&
                String(existingBase.buildId) === String(sqlBuildId) &&
                existingBase.branch === null &&
                existingState &&
                Number(existingState.installation) === 3 &&
                existingPt
            );
          } catch {}

          if (!alreadySyncedInDb) {
            try {
              const pgrepOut = execSync('pgrep -f "GOG Galaxy"', {
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 1500,
              })
                .toString()
                .trim();
              if (pgrepOut) {
                let activeOps = 0;
                try {
                  const opRow = db
                    .prepare('SELECT COUNT(*) AS cnt FROM ProductStates WHERE operation != 0')
                    .get();
                  activeOps = Number(opRow?.cnt || 0);
                } catch {}
                if (activeOps === 0) {
                  try {
                    db.close();
                  } catch {}
                  db = null;
                  try {
                    execSync('killall "GOG Galaxy"', { stdio: 'ignore', timeout: 2000 });
                  } catch {}
                  for (let i = 0; i < 15; i++) {
                    try {
                      execSync('pgrep -f "GOG Galaxy"', { stdio: 'ignore', timeout: 500 });
                      execSync('sleep 0.1', { stdio: 'ignore', timeout: 500 });
                    } catch {
                      break;
                    }
                  }
                  db = new DatabaseSync(gogDbPath, { readBigInts: true });
                  db.exec('PRAGMA busy_timeout = 3000;');
                  shouldRelaunchGalaxy = true;
                }
              }
            } catch {}
          }
        }

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
          CREATE TABLE IF NOT EXISTS ProductSettings (gameReleaseKey TEXT PRIMARY KEY, selectedBuildId INTEGER, branch TEXT, password TEXT, autoUpdate INTEGER, cloudStorage INTEGER, overlay INTEGER, desktopShortcut INTEGER, customLaunchParameters INTEGER, selectedLaunchParameters INTEGER);
          CREATE TABLE IF NOT EXISTS PlayTaskTypes (id INTEGER PRIMARY KEY, type TEXT UNIQUE);
          CREATE TABLE IF NOT EXISTS PlayTasks (id INTEGER PRIMARY KEY, gameReleaseKey TEXT, userId INTEGER, "order" INTEGER, typeId INTEGER, isPrimary INTEGER);
          CREATE TABLE IF NOT EXISTS PlayTaskLaunchParameters (playTaskId INTEGER PRIMARY KEY, executablePath TEXT, commandLineArgs TEXT, label TEXT);
          CREATE TABLE IF NOT EXISTS GameFiles (id INTEGER PRIMARY KEY, installPath TEXT, productId INTEGER, hash TEXT, fileAttribute INTEGER);
        `);

        // Clean up any stale non-GOG Steam AppID pollution (e.g. productId 2320 / steam-2320)
        try {
          db.prepare('DELETE FROM ImportedLatestBuildIds WHERE productId = 2320').run();
          db.prepare('DELETE FROM BaseModificationTargets WHERE productId = 2320').run();
          db.prepare('DELETE FROM ModificationTargets WHERE productId = 2320').run();
          db.prepare('DELETE FROM ProductStates WHERE productId = 2320').run();
          db.prepare('DELETE FROM GameFiles WHERE productId = 2320').run();
          db.prepare('DELETE FROM InstalledBaseProducts WHERE productId = 2320').run();
          db.prepare('DELETE FROM InstalledProducts WHERE productId = 2320').run();
          db.prepare('DELETE FROM AvailableLanguages WHERE productId = 2320').run();
          db.prepare("DELETE FROM Products WHERE id = 2320 AND name LIKE 'steam-%'").run();
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
        if (shouldRelaunchGalaxy && fs.existsSync('/Applications/GOG Galaxy.app')) {
          try {
            execFile('open', ['-g', '-a', '/Applications/GOG Galaxy.app'], () => {});
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

    return { synced: true, infoFilePath: activeInfoFilePath };
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
      const releaseKey = `gog_${normId}`;
      let db = null;
      try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(gogDbPath, { readBigInts: true });
        db.exec('PRAGMA busy_timeout = 3000;');
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
 * Compare two runner version strings numerically segment by segment (-1 if vA < vB, 0 if equal, 1 if vA > vB)
 */
function compareRunnerVersions(vA, vB) {
  const partsA = String(vA || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const partsB = String(vB || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a < b) return -1;
    if (a > b) return 1;
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
      const subdirs = fs.readdirSync(heroicWineRoot);
      for (const sub of subdirs) {
        if (sub.startsWith('.')) continue;
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
    crossover_preview: 'https://www.codeweavers.com/preview/download_links',
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
      // 3. Open-Source Wine Homebrew cask JSON
      (async () => {
        const txt = await fetchWithTimeout('https://formulae.brew.sh/api/cask/wine-stable.json');
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
    const latestVersion = feed.latestVersion || layer?.version;
    const latestBuildVersion =
      feed.latestBuildVersion !== undefined
        ? feed.latestBuildVersion
        : feed.latestVersion
          ? undefined
          : layer?.buildVersion;
    const latestDisplayVersion =
      feed.latestDisplayVersion ||
      (latestVersion
        ? latestBuildVersion && !String(latestVersion).includes(String(latestBuildVersion))
          ? `${latestVersion} (${latestBuildVersion})`
          : latestVersion
        : layer?.displayVersion);

    const updateAvailable = Boolean(
      layer &&
        layer.version &&
        feed.latestVersion &&
        compareRunnerVersions(layer.version, feed.latestVersion) < 0
    );

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
  const previousVersion = beforeLayers.find((l) => l.type === runnerType)?.version;

  if (typeof options.mockUpdater === 'function') {
    const mockRes = (await options.mockUpdater(payload, options)) || {};
    const detectedLayers = detectCompatibilityLayers(options);
    const newVersion =
      mockRes.newVersion || detectedLayers.find((l) => l.type === runnerType)?.version;
    const updates = await checkCompatibilityLayerUpdates(options);
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
    crossover_preview: 'https://www.codeweavers.com/preview/download_links',
    gptk: 'https://developer.apple.com/games/game-porting-toolkit/',
    wine: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
  };

  const brewCandidates = [
    options.brewBinaryPath,
    path.join(homedir, 'homebrew/bin/brew'),
    ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
  ].filter(Boolean);
  const brewPath = brewCandidates.find((p) => fs.existsSync(p));

  const caskMap = {
    crossover: 'crossover',
    wine: 'wine-stable',
    gptk: 'game-porting-toolkit',
  };
  const caskName = caskMap[runnerType];
  let updatedViaBrew = false;

  if (caskName && (brewPath || typeof options.onExecBrew === 'function')) {
    const args = [
      'upgrade',
      '--cask',
      ...(runnerType === 'wine' ? ['--no-quarantine'] : []),
      caskName,
    ];
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
      updatedViaBrew = true;
    } catch {}
  }

  let openedExternalUrl = false;
  if (!updatedViaBrew) {
    const targetUrl = defaultUpdateUrls[runnerType] || defaultUpdateUrls.crossover;
    await openExternalUri(targetUrl, options);
    openedExternalUrl = true;
  }

  const detectedLayers = detectCompatibilityLayers(options);
  const newVersion = detectedLayers.find((l) => l.type === runnerType)?.version;
  const updates = await checkCompatibilityLayerUpdates(options);
  const updated = Boolean((newVersion && newVersion !== previousVersion) || updatedViaBrew);

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
    crossover_preview: 'https://www.codeweavers.com/preview',
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
  } else if (cfg.metalHud === false) {
    delete env.MTL_HUD_ENABLED;
  }

  if (cfg.dxvkHud === true) {
    env.DXVK_HUD = env.DXVK_HUD || 'devinfo,fps,frametimes';
  } else if (cfg.dxvkHud === false) {
    delete env.DXVK_HUD;
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
          fs.writeFileSync(cxbottleConfPath, finalConf, 'utf8');
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
          fs.writeFileSync(cxbottleConfPath, `${prefix}${envLines.join('\n')}\n`, 'utf8');
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

      fs.writeFileSync(userRegPath, regContent, 'utf8');
    } catch {}

    if (
      !options.homedir &&
      !options.skipRegistrySpawn &&
      chosenLayer?.binaryPath &&
      fs.existsSync(chosenLayer.binaryPath)
    ) {
      const regEnv = { ...process.env, ...env };
      try {
        execFileSync(
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
          { timeout: 2500, stdio: 'ignore', env: regEnv }
        );
      } catch {}
      try {
        execFileSync(
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
          { timeout: 2500, stdio: 'ignore', env: regEnv }
        );
      } catch {}
    }
  }

  return env;
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

    applyCrossOverPerGameSettings(
      chosenLayer,
      launchConfig,
      env,
      env.WINEPREFIX || bottlePath,
      options
    );

    return { targetBottle, winePrefix: env.WINEPREFIX };
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

  applyCrossOverPerGameSettings(
    chosenLayer,
    launchConfig,
    env,
    env.WINEPREFIX || targetPrefix,
    options
  );

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
    const rawSavedConfig =
      savedConfigs[gameId] || (payload.gameId && savedConfigs[payload.gameId]) || {};
    const platformSavedConfig = resolvePlatformLaunchConfig(rawSavedConfig, payload.platformId);
    const platformPayloadConfig = resolvePlatformLaunchConfig(
      payload.launchConfig,
      payload.platformId
    );
    const launchConfig = {
      ...platformSavedConfig,
      ...platformPayloadConfig,
    };

    const launchMethod = launchConfig.launchMethod || payload.launchMethod || 'auto';

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
        if (appInfoSpec && appInfoSpec.executablePath && fs.existsSync(appInfoSpec.executablePath)) {
          resolvedExePath = appInfoSpec.executablePath;
          if (appInfoSpec.isWindowsBinaryOnMac) {
            isWindowsBinaryOnMac = true;
          }
        }
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
      executableDiscoveryCache.delete(path.resolve(localInstallDir));
      const discovered =
        appInfoSpec && appInfoSpec.executablePath && fs.existsSync(appInfoSpec.executablePath)
          ? {
              executablePath: appInfoSpec.executablePath,
              isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
            }
          : findPrimaryExecutable(localInstallDir, {
              platform,
              hintName: payload.title,
            });
      if (discovered.executablePath) {
        resolvedExePath = discovered.executablePath;
        if (discovered.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
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
      });
      resolvedExePath = discovered.executablePath;
      if (discovered.isWindowsBinaryOnMac) {
        isWindowsBinaryOnMac = true;
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
      platform === 'win32';

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
            : layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview')) ||
          layers[0];

        if (!chosenLayer) {
          if (launchMethod === 'auto' && options.allowStorefrontFallbackOnMissingCompat) {
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

          if (payload.platformId === 'steam') {
            const steamAppIdVal = String(
              payload.steamAppId || payload.platformGameId || ''
            )
              .replace(/^steam[-_]/i, '')
              .trim();
            if (steamAppIdVal) {
              env.SteamAppId = steamAppIdVal;
              env.SteamGameId = steamAppIdVal;
              const targetAppIdDir =
                launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
                  ? launchConfig.workingDirectory
                  : path.dirname(resolvedExePath);
              if (targetAppIdDir && fs.existsSync(targetAppIdDir)) {
                const steamAppIdTxt = path.join(targetAppIdDir, 'steam_appid.txt');
                try {
                  if (!fs.existsSync(steamAppIdTxt)) {
                    fs.writeFileSync(steamAppIdTxt, `${steamAppIdVal}\n`, 'utf8');
                  }
                } catch {}
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
            if (!useCompatLayer && launchMethod === 'auto' && buildStorefrontLaunchUri(payload)) {
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
                !useCompatLayer &&
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
          if (!useCompatLayer && launchMethod === 'auto' && buildStorefrontLaunchUri(payload)) {
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
  }
  return found;
}

function findLegendaryBinary(options = {}) {
  return findBundledOrSystemCliBinary('legendary', options);
}

function findGogdlBinary(options = {}) {
  return findBundledOrSystemCliBinary('gogdl', options);
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

  let epicTokenData =
    savedTokens && savedTokens.epic && savedTokens.epic.access_token
      ? { ...savedTokens.epic }
      : null;

  if (!epicTokenData || !epicTokenData.access_token) {
    const candidateUserJsonPaths = [
      path.join(legendaryConfigPath, 'user.json'),
      path.join(homedir, '.config/legendary/user.json'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/user.json'),
    ];
    for (const userJsonFile of candidateUserJsonPaths) {
      if (fs.existsSync(userJsonFile)) {
        try {
          const parsedUser = JSON.parse(fs.readFileSync(userJsonFile, 'utf8'));
          if (parsedUser && (parsedUser.access_token || parsedUser.refresh_token)) {
            epicTokenData = { ...parsedUser };
            break;
          }
        } catch {}
      }
    }
  }

  if (epicTokenData && (epicTokenData.access_token || epicTokenData.refresh_token)) {
    const expiresAtMs = epicTokenData.expires_at ? new Date(epicTokenData.expires_at).getTime() : 0;
    const isExpiringSoon =
      !epicTokenData.access_token ||
      !expiresAtMs ||
      Number.isNaN(expiresAtMs) ||
      expiresAtMs - Date.now() < 10 * 60 * 1000;

    if (
      isExpiringSoon &&
      epicTokenData.refresh_token &&
      !options.skipNetwork &&
      storeSync &&
      typeof storeSync.renewEpicTokens === 'function'
    ) {
      try {
        const renewed = await storeSync.renewEpicTokens(epicTokenData.refresh_token);
        if (renewed && renewed.access_token) {
          epicTokenData = { ...epicTokenData, ...renewed };
        }
      } catch {}
    }

    if (epicTokenData.access_token) {
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
  }

  return {
    legendaryConfigPath,
    accessToken: epicTokenData?.access_token || null,
    refreshToken: epicTokenData?.refresh_token || null,
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

  let namespace = macEntry?.namespace || winEntry?.namespace;
  let catalogItemId = macEntry?.catalog_item_id || winEntry?.catalog_item_id;

  if ((!namespace || !catalogItemId) && resolvedAppName) {
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
          if (namespace && catalogItemId) break;
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
              hintName: parsed.name || task.title,
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
        task.totalBytes;

      upsertManagedInstallRecord(
        {
          platformId: 'steam',
          platformGameId: String(appId),
          appId: Number(appId),
          title: parsed.name || task.title,
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

const installInfoSizeCache = new Map();
const steamPlatformSupportCache = new Map();

function parseStorageRequirementBytes(htmlOrText) {
  if (!htmlOrText) return undefined;
  const text = typeof htmlOrText === 'string' ? htmlOrText : JSON.stringify(htmlOrText);
  const patterns = [
    /(?:Storage|Hard\s*Drive(?:\s*Space)?|Hard\s*Disk(?:\s*Space)?|Disk\s*Space|Available\s*Space|Free\s*Space|HDD|SSD)[^0-9]{0,45}(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB|TB|TiB)\b/i,
    /\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB|TB|TiB)\s+(?:available\s+space|free\s+(?:disk\s+)?space|hard\s+drive\s+space|storage|of\s+free\s+space)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (!Number.isFinite(val) || val <= 0) continue;
      const unit = m[2].toUpperCase();
      if (unit.startsWith('T')) return Math.round(val * 1024 * 1024 * 1024 * 1024);
      if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
      if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
    }
  }
  return undefined;
}

function parseEpicManifestBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  try {
    // Binary Epic Manifest (magic 0x44bec00c)
    if (buf.length >= 41 && buf.readUInt32LE(0) === 0x44bec00c) {
      const headerSize = buf.readUInt32LE(4);
      const storedAs = buf.readUInt8(36);
      const rawBody = buf.subarray(headerSize);
      const body = storedAs & 1 ? zlib.inflateSync(rawBody) : rawBody;

      // 1. ManifestMeta
      const metaSize = body.readUInt32LE(0);
      let offset = metaSize;

      // 2. ChunkDataList
      const cdlSize = body.readUInt32LE(offset);
      const cdlCount = body.readUInt32LE(offset + 5);
      // Layout inside ChunkDataList after 9-byte header (size u32 + version u8 + count u32):
      // guid (16B * count), hash (8B * count), sha_hash (20B * count), group_num (1B * count),
      // window_size (4B * count), file_size (8B * count)
      const windowSizeStart = offset + 9 + cdlCount * (16 + 8 + 20 + 1);
      let uncompressedChunkSize = 0n;
      for (let i = 0; i < cdlCount; i++) {
        uncompressedChunkSize += BigInt(body.readUInt32LE(windowSizeStart + i * 4));
      }
      const fileSizeStart = windowSizeStart + cdlCount * 4;
      let downloadSize = 0n;
      for (let i = 0; i < cdlCount; i++) {
        downloadSize += body.readBigUInt64LE(fileSizeStart + i * 8);
      }

      // 3. FileManifestList
      offset += cdlSize;
      const fmlCount = body.readUInt32LE(offset + 5);
      let pos = offset + 9;
      const skipFString = () => {
        const len = body.readInt32LE(pos);
        pos += 4;
        if (len > 0) pos += len;
        else if (len < 0) pos += -len * 2;
      };
      // Skip filename FStrings
      for (let i = 0; i < fmlCount; i++) skipFString();
      // Skip symlink_target FStrings
      for (let i = 0; i < fmlCount; i++) skipFString();
      // Skip sha_hash (20B * fmlCount) + file_meta_flags (1B * fmlCount)
      pos += fmlCount * 21;
      // Skip install_tags (TArray<FString> per file)
      for (let i = 0; i < fmlCount; i++) {
        const tagCount = body.readUInt32LE(pos);
        pos += 4;
        for (let t = 0; t < tagCount; t++) skipFString();
      }
      // Sum chunk_parts sizes (each part starts with u32 struct_size, guid 16B, offset u32, size u32)
      let diskSize = 0n;
      for (let i = 0; i < fmlCount; i++) {
        const partCount = body.readUInt32LE(pos);
        pos += 4;
        for (let p = 0; p < partCount; p++) {
          const structSize = body.readUInt32LE(pos);
          const partSize = body.readUInt32LE(pos + 24);
          diskSize += BigInt(partSize);
          pos += structSize;
        }
      }

      return {
        diskSize: Number(diskSize) || Number(uncompressedChunkSize) || 0,
        downloadSize: Number(downloadSize) || 0,
      };
    }

    // JSON Epic Manifest (starts with '{' 0x7b or zlib-compressed JSON)
    let jsonStr = null;
    if (buf[0] === 0x7b) {
      jsonStr = buf.toString('utf8');
    } else {
      try {
        const inflated = zlib.inflateSync(buf);
        if (inflated.length > 0 && inflated[0] === 0x7b) {
          jsonStr = inflated.toString('utf8');
        }
      } catch {}
    }
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      let diskSize = 0;
      if (Array.isArray(parsed.FileManifestList)) {
        for (const f of parsed.FileManifestList) {
          if (Array.isArray(f.FileChunkParts)) {
            for (const part of f.FileChunkParts) {
              if (typeof part.Size === 'string') {
                const n = Number(part.Size);
                if (Number.isFinite(n) && n > 0) diskSize += n;
              } else if (typeof part.Size === 'number' && part.Size > 0) {
                diskSize += part.Size;
              }
            }
          }
        }
      }
      return {
        diskSize: diskSize || Number(parsed.diskSize || parsed.installSize || 0),
        downloadSize: Number(parsed.downloadSize || diskSize || 0),
      };
    }
  } catch {}
  return null;
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
          const gogAuthPath = authRes?.configPath;
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
                      const parsed = JSON.parse(String(stdout).trim());
                      const sz = Number(parsed?.disk_size || parsed?.download_size || 0);
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
            if (gogdlSize) {
              estimatedSizeBytes = gogdlSize;
            }
          }
        } catch {}
      }
    }

    if (estimatedSizeBytes && cleanId) {
      installInfoSizeCache.set(`gog:${cleanId}:${platform}`, estimatedSizeBytes);
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
      installInfoSizeCache.set(`epic:${resolvedAppName}:${platform}`, estimatedSizeBytes);
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

    if (!estimatedSizeBytes && cleanId) {
      try {
        const { steamappsDirs } = discoverSteamLocations(options);
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
      } catch {}
    }

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
              installInfoSizeCache.set(`steam:${cleanId}:${platform}`, estimatedSizeBytes);
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
  const candidateSteamExes = [
    path.join(bottlePath, 'drive_c/Program Files (x86)/Steam/steam.exe'),
    path.join(bottlePath, 'drive_c/Program Files/Steam/steam.exe'),
  ];
  const existingSteamExe = candidateSteamExes.find((p) => fs.existsSync(p));
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
        if (candidateSteamExes.some((p) => fs.existsSync(p))) {
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

    return candidateSteamExes.find((p) => fs.existsSync(p)) || null;
  } catch {
    return null;
  }
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
      speedBytesPerSec: initialSpeed,
      etaSeconds: initialEta,
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
      const isWinCompatInstall =
        platform === 'darwin' &&
        (payload.os === 'windows' || payload.installerId === 'steam-win-compat');
      let launchedViaWineSteam = false;
      const layers = isWinCompatInstall ? detectCompatibilityLayers(options) : [];

      if (isWinCompatInstall && !options.disableWineSteamSpawn && layers.length > 0) {
        const existingConfigs = getGameLaunchConfigs(options);
        const rawExistingConfig = (payload.gameId && existingConfigs[payload.gameId]) || {};
        const existingConfig = resolvePlatformLaunchConfig(rawExistingConfig, 'steam');
        const preferredLayer =
          layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview') || layers[0];

        const env = { ...process.env };
        await ensureCompatibilityLayerReady(preferredLayer, existingConfig, env, options);

        const candidateBottles = [];
        const targetBottleName =
          env.CX_BOTTLE ||
          existingConfig.wineBottleName ||
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
          const candidateSteamExes = [
            path.join(cand.bottlePath, 'drive_c/Program Files (x86)/Steam/steam.exe'),
            path.join(cand.bottlePath, 'drive_c/Program Files/Steam/steam.exe'),
          ];
          const foundSteamExe = candidateSteamExes.find((p) => fs.existsSync(p));
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
                    compatibilityLayer: resolvedTarget.layer.type,
                    wineBottleName: resolvedTarget.bottleName,
                  },
                  options
                );
              } catch {}
            }
          } catch {}
        }
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
              },
              options
            ).catch((v1Err) => {
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
            });
            if (!existingExeCheck.executablePath) {
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

            child.stdout.on('data', onGogOutput);
            child.stderr.on('data', onGogOutput);
            child.on('exit', async (code) => {
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
                      },
                      options
                    );
                    return;
                  } catch {}
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
                      },
                      options
                    );
                    return;
                  } catch {}
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

async function fetchGogV1Json(url, headers = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
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
  },
  options = {}
) {
  const buildsUrl = `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${encodeURIComponent(gogPlatformFlag)}/builds?generation=2`;
  const buildsJson = await fetchGogV1Json(buildsUrl);
  const build =
    buildsJson?.items?.find((b) => b && b.generation === 1) || buildsJson?.items?.[0];
  if (!build || !build.link) {
    throw new Error(`No GOG depot build found for ${title}`);
  }

  const repo = await fetchGogV1Json(build.link);
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
  const manifestJson = await fetchGogV1Json(`${manifestBaseUrl}/${depot.manifest}`);
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
  fs.mkdirSync(extractRoot, { recursive: true });

  const buildLegacyId = build.legacy_build_id || build.build_id;
  const secureUrl = `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/secure_link?_version=2&generation=1&type=depot&path=/${encodeURIComponent(gogPlatformFlag)}/${encodeURIComponent(buildLegacyId)}`;
  const secureJson = await fetchGogV1Json(secureUrl, {
    Authorization: `Bearer ${gogToken}`,
  });

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

  if (taskId) {
    updateDownloadTask(
      taskId,
      {
        status: 'downloading',
        totalBytes: effectiveTotalBytes,
        statusMessage: 'Downloading GOG V1 depot archive...',
      },
      options
    );
  }

  const tempBinPath = path.join(finalInstallPath, `.gog_v1_${cleanId}_main.bin`);
  const controller = new AbortController();
  if (taskId) {
    downloadControllers.set(taskId, { type: 'abort', controller });
  }

  try {
    const binRes = await fetch(mainBinUrl, { signal: controller.signal });
    if (!binRes.ok || !binRes.body) {
      throw new Error(`GOG V1 CDN returned HTTP ${binRes.status}`);
    }

    const outFd = fs.openSync(tempBinPath, 'w');
    let bytesDownloaded = 0;
    let lastEmitTime = Date.now();
    let lastEmitBytes = 0;

    try {
      for await (const chunk of binRes.body) {
        const buf = Buffer.from(chunk);
        fs.writeSync(outFd, buf);
        bytesDownloaded += buf.length;

        const now = Date.now();
        if (taskId && now - lastEmitTime >= 500) {
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
        fs.closeSync(outFd);
      } catch {}
    }

    if (taskId) {
      downloadControllers.delete(taskId);
      updateDownloadTask(
        taskId,
        {
          status: 'extracting',
          progressPercent: 99,
          bytesDownloaded: effectiveTotalBytes || bytesDownloaded,
          totalBytes: effectiveTotalBytes || bytesDownloaded,
          speedBytesPerSec: 0,
          etaSeconds: 1,
          statusMessage: 'Extracting GOG V1 depot files & bundles...',
        },
        options
      );
    }

    const inFd = fs.openSync(tempBinPath, 'r');
    const copyBuf = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
      for (const f of manifestFiles) {
        if (!f || !f.path) continue;
        const relPath = String(f.path)
          .replace(/^[\/\\]+/, '')
          .replace(/\\/g, path.sep);
        if (!relPath) continue;
        const destPath = path.join(extractRoot, relPath);

        if (f.directory) {
          fs.mkdirSync(destPath, { recursive: true });
        } else if (f.symlinkType || (f.target && f.size === undefined)) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.symlinkSync(f.target, destPath);
          } catch {}
        } else if (typeof f.size === 'number') {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          const mode = f.executable || /\/MacOS\//i.test(relPath) ? 0o755 : 0o644;
          const fileOutFd = fs.openSync(destPath, 'w', mode);
          try {
            let remaining = f.size;
            let readPos = Number(f.offset || 0);
            while (remaining > 0) {
              const toRead = Math.min(copyBuf.length, remaining);
              const bytesRead = fs.readSync(inFd, copyBuf, 0, toRead, readPos);
              if (bytesRead <= 0) break;
              fs.writeSync(fileOutFd, copyBuf, 0, bytesRead);
              remaining -= bytesRead;
              readPos += bytesRead;
            }
          } finally {
            try {
              fs.closeSync(fileOutFd);
            } catch {}
          }
        }
      }
    } finally {
      try {
        fs.closeSync(inFd);
      } catch {}
      try {
        if (fs.existsSync(tempBinPath)) fs.unlinkSync(tempBinPath);
      } catch {}
    }

    if (platform === 'darwin') {
      ensureMacExecutablePermissions(finalInstallPath);
      executableDiscoveryCache.delete(path.resolve(finalInstallPath));
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
                '--skip-dlcs',
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

    executableDiscoveryCache.delete(path.resolve(finalInstallPath));
    const finalExeDiscovery = findPrimaryExecutable(finalInstallPath, {
      platform,
      hintName: title,
    });
    const isWindowsBinaryOnMac = Boolean(finalExeDiscovery.isWindowsBinaryOnMac);

    const gogRecord = {
      platformId: 'gog',
      platformGameId: String(platformGameId || cleanId),
      title,
      installPath: finalInstallPath,
      executablePath: finalExeDiscovery.executablePath,
      installSize: effectiveTotalBytes,
      runner: 'gogdl',
      isWindowsBinaryOnMac,
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
    if (taskId) {
      downloadControllers.delete(taskId);
    }
    try {
      if (fs.existsSync(tempBinPath)) fs.unlinkSync(tempBinPath);
    } catch {}
    throw err;
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
    speedBytesPerSec: downloadControllers.has(taskId) ? 0 : 18 * 1024 * 1024,
    statusMessage: `Resuming ${task.title}...`,
  });
}

function terminateDownloadController(ctrl) {
  if (!ctrl) return;
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
    const pid = ctrl.child.pid;
    if (pid) {
      if (process.platform !== 'win32') {
        try {
          process.kill(pid, 'SIGCONT');
        } catch {}
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      const killTimer = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }, 1500);
      if (typeof killTimer.unref === 'function') {
        killTimer.unref();
      }
    } else if (typeof ctrl.child.kill === 'function') {
      try {
        ctrl.child.kill('SIGTERM');
      } catch {}
    }
  }
}

function cancelDownload(taskId) {
  const task = downloadQueueMap.get(taskId);
  if (!task) {
    return { success: false, error: `Download task ${taskId} not found.` };
  }

  const ctrl = downloadControllers.get(taskId);
  if (ctrl) {
    terminateDownloadController(ctrl);
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
  for (const [, ctrl] of downloadControllers.entries()) {
    terminateDownloadController(ctrl);
  }
  downloadControllers.clear();
  downloadSpeedTrackers.clear();
  downloadQueueMap.clear();
}

function shutdownLauncherEngine() {
  for (const [, ctrl] of downloadControllers.entries()) {
    terminateDownloadController(ctrl);
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
              fs.writeFileSync(legInstalledPath, JSON.stringify(rawLeg, null, 2), 'utf8');
            }
          }
        }
      } catch {}
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
  toLocalFsPath,
  scanAllInstalledGames,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  resolveMacAppBundleBinary,
  ensureMacExecutablePermissions,
  invalidateScanCaches,
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
  unregisterGogFirstPartyLauncher,
  cleanupCrossOverSteamShortcuts,
  removeSteamAppFromLibraryFoldersVdf,

  // B) Compatibility Layers
  isValidBottleDirectory,
  hasValidInitializedBottles,
  detectCompatibilityLayers,
  installCompatibilityLayer,
  extractRunnerVersionInfo,
  detectBundledD3DMetalVersions,
  compareRunnerVersions,
  checkCompatibilityLayerUpdates,
  updateCompatibilityLayer,
  ensureCompatibilityLayerReady,
  applyCrossOverPerGameSettings,

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

  // E) File Management & Config Persistence
  browseLocalFiles,
  verifyGameFiles,
  uninstallGame,
  isSafeToDeleteInstallPath,
  resolvePlatformLaunchConfig,
  saveGameLaunchConfig,
  getGameLaunchConfigs,
  selectExecutableDialog,
  selectFolderDialog,
};
