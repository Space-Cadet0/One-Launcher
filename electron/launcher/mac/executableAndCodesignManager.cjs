// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const {
  diagLog,
  getUserDataDir,
  isTestEnvironment,
  toLocalFsPath,
  clearMacQuarantineAsync,
  writeManagedInstallSentinel,
  MAX_DISCOVERY_CACHE_ENTRIES,
  macCodesignValidCache,
  executableDiscoveryCache,
  setBoundedMapEntry,
  evictExecutableDiscoveryCacheForPath,
  isPathUnderActiveDownload,
  registerExternalCacheInvalidator,
} = require('../engineStateRegistry.cjs');
const {
  atomicWriteFileSync,
  isContainedWithinRoot,
} = require('../securityAndPathUtils.cjs');
const {
  inspectWindowsExecutableHeader,
  inspectMacMachOHeader,
  selectPreferredGogPlayTask,
} = require('../binaryAndManifestInspectors.cjs');

/**
 * Excluded auxiliary / redistributable / crash-handler binaries
 */
const EXCLUDED_EXECUTABLE_PATTERNS = [
  /^gamelaunchhelper\.exe$/i,
  /^appxlauncher\.exe$/i,
  /^cleanup\.exe$/i,
  /^touchup\.exe$/i,
  /^eaappinstaller\.exe$/i,
  /^eainstaller\.exe$/i,
  /^originthinsetup.*\.exe$/i,
  /^link2ea\.exe$/i,
  /^activationui\.exe$/i,
  /^eaanticheat\.installer.*\.exe$/i,
  /^getgametoken(?:32|64)?\.exe$/i,
  /^igoproxy(?:32|64)?\.exe$/i,
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

function hasShebangHeader(filePath) {
  /** @type {number | null} */
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
 * Score candidate executables by relevance to the game title / folder name, depth, PE architecture, and size
 */
function scoreExecutableCandidate(
  filePath,
  rootDir,
  hintName = '',
  /** @type {any} */ peInfo = null,
  /** @type {string | null} */ platform = null
) {
  const rawFileName = path.basename(filePath);
  const base = rawFileName.replace(/\.(exe|app|sh|command)$/i, '');
  const folderName = path.basename(rootDir);
  const rel = path.relative(rootDir, filePath);
  const depth = rel.split(/[\\/]/).length;

  let score = 100 - depth * 12;

  const norm = (/** @type {any} */ s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normBase = norm(base);
  const normHint = norm(hintName);
  const normFolder = norm(folderName);

  if (normHint && normBase === normHint) score += 60;
  else if (normFolder && normBase === normFolder) score += 50;
  else if (normHint && (normBase.includes(normHint) || normHint.includes(normBase))) score += 30;
  else if (normFolder && (normBase.includes(normFolder) || normFolder.includes(normBase))) score += 25;

  if (/shipping/i.test(base)) score += 20;
  if (/^goglauncher$/i.test(base)) score -= 120;
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
    peInfo || (isWinExe ? inspectWindowsExecutableHeader(filePath) : null);

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
    /** @type {fs.Dirent[]} */
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
      const appEntries = entries.filter(
        (e) => e.isDirectory() && e.name.toLowerCase().endsWith('.app')
      );
      if (appEntries.length === 1) {
        return path.join(cleaned, appEntries[0].name);
      }
      if (appEntries.length > 1) {
        const dirBaseLower = path.basename(cleaned).toLowerCase().replace(/[^a-z0-9]+/g, '');
        const scored = appEntries
          .map((e) => {
            const nameLower = e.name.toLowerCase();
            const stemLower = nameLower.replace(/\.app$/, '').replace(/[^a-z0-9]+/g, '');
            let score = 0;
            if (dirBaseLower && stemLower === dirBaseLower) score += 100;
            else if (dirBaseLower && (stemLower.includes(dirBaseLower) || dirBaseLower.includes(stemLower))) {
              score += 50;
            }
            if (/(?:unins|helper|crash|update|setup|config|editor|server|dedicated)/i.test(nameLower)) {
              score -= 80;
            }
            score -= Math.min(30, nameLower.length * 0.25);
            return { name: e.name, score };
          })
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        return path.join(cleaned, scored[0].name);
      }
    }
  } catch {}

  return null;
}

function computeMacAppBundleStatSignature(appBundlePath) {
  try {
    const bundleSt = fs.statSync(appBundlePath);
    const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
    const plistSt = fs.existsSync(infoPlistPath) ? fs.statSync(infoPlistPath) : null;
    const codeResourcesPath = path.join(appBundlePath, 'Contents', '_CodeSignature', 'CodeResources');
    const codeResSt = fs.existsSync(codeResourcesPath) ? fs.statSync(codeResourcesPath) : null;
    const innerBin = resolveMacAppBundleBinary(appBundlePath);
    const binSt =
      innerBin && innerBin !== appBundlePath && fs.existsSync(innerBin)
        ? fs.statSync(innerBin)
        : null;
    return [
      `${bundleSt.dev}:${bundleSt.ino}:${Math.trunc(bundleSt.mtimeMs)}`,
      plistSt ? `${plistSt.dev}:${plistSt.ino}:${Math.trunc(plistSt.mtimeMs)}:${plistSt.size}` : 'no-plist',
      codeResSt ? `${codeResSt.dev}:${codeResSt.ino}:${Math.trunc(codeResSt.mtimeMs)}:${codeResSt.size}` : 'no-coderes',
      binSt ? `${binSt.dev}:${binSt.ino}:${Math.trunc(binSt.mtimeMs)}:${binSt.size}` : 'no-bin',
    ].join('|');
  } catch {
    return null;
  }
}

const CODESIGN_DISK_CACHE_MAX_ENTRIES = 500;
/** @type {Set<string>} */
const loadedCodesignCacheDirs = new Set();

function getCodesignDiskCachePath(/** @type {any} */ options = {}) {
  try {
    const userDataDir = getUserDataDir(options?.userDataDir);
    if (!userDataDir) return null;
    return path.join(userDataDir, 'one_launcher_codesign_cache.json');
  } catch {
    return null;
  }
}

function hydrateCodesignDiskCache(/** @type {any} */ options = {}) {
  const cachePath = getCodesignDiskCachePath(options);
  if (!cachePath) return;
  if (loadedCodesignCacheDirs.has(cachePath) && macCodesignValidCache.size > 0) return;
  loadedCodesignCacheDirs.add(cachePath);
  try {
    if (!fs.existsSync(cachePath)) return;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [bundleKey, sigVal] of Object.entries(parsed)) {
        if (typeof bundleKey === 'string' && typeof sigVal === 'string' && !macCodesignValidCache.has(bundleKey)) {
          setBoundedMapEntry(macCodesignValidCache, bundleKey, sigVal, CODESIGN_DISK_CACHE_MAX_ENTRIES);
        }
      }
    }
  } catch {}
}

function persistCodesignDiskCacheEntry(appBundlePath, statSig, /** @type {any} */ options = {}) {
  if (!appBundlePath || !statSig) return;
  const cachePath = getCodesignDiskCachePath(options);
  if (!cachePath) return;
  try {
    /** @type {Record<string, string>} */
    let onDisk = {};
    if (fs.existsSync(cachePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          onDisk = parsed;
        }
      } catch {}
    }
    if (onDisk[appBundlePath] === statSig) {
      return;
    }
    onDisk[appBundlePath] = statSig;
    const keys = Object.keys(onDisk);
    if (keys.length > CODESIGN_DISK_CACHE_MAX_ENTRIES) {
      const dropCount = keys.length - CODESIGN_DISK_CACHE_MAX_ENTRIES;
      for (let i = 0; i < dropCount; i += 1) {
        delete onDisk[keys[i]];
      }
    }
    atomicWriteFileSync(cachePath, JSON.stringify(onDisk, null, 2));
  } catch {}
}

function isCodesignTimeoutError(/** @type {any} */ err) {
  if (!err || typeof err !== 'object') return false;
  if (err.killed === true) return true;
  const code = String(err.code || '').toUpperCase();
  if (code === 'ETIMEDOUT' || code === 'ETIME') return true;
  const sig = String(err.signal || '').toUpperCase();
  if (sig === 'SIGTERM' || sig === 'SIGKILL') return true;
  const msg = String(err.message || '');
  return /timed?\s*out/i.test(msg);
}

function hasTrustedAppleOrDeveloperAuthority(outputText) {
  const text = String(outputText || '');
  return /^\s*Authority\s*=\s*(?:Developer ID Application:|Apple Distribution:|Mac App Store|Apple Worldwide Developer Relations|(?:macOS\s+)?Software Signing)/im.test(
    text
  );
}

registerExternalCacheInvalidator(() => {
  loadedCodesignCacheDirs.clear();
});

function readMacBundleIdFromInfoPlist(appBundlePath) {
  const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlistPath)) return '';
  try {
    const plistRaw = fs.readFileSync(infoPlistPath, 'utf8');
    const idMatch = plistRaw.match(
      /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/i
    );
    const candidate = idMatch && idMatch[1] ? idMatch[1].trim() : '';
    return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

/**
 * Check whether a file starts with a Mach-O or Fat/Universal Mach-O magic header.
 * Validates `nfat_arch` (`1..32`) for `0xCAFEBABE` so Java `.class` files are rejected.
 * @param {string} filePath
 */
function isMachOBinaryFile(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(8);
    const nRead = fs.readSync(fd, hdr, 0, 8, 0);
    if (nRead < 4) return false;
    const magic = hdr.readUInt32BE(0);
    if (
      magic === 0xfeedface ||
      magic === 0xcefaedfe ||
      magic === 0xfeedfacf ||
      magic === 0xcffaedfe
    ) {
      return true;
    }
    if (nRead >= 8) {
      if (magic === 0xcafebabe || magic === 0xcafebabf) {
        const nfat = hdr.readUInt32BE(4);
        return nfat >= 1 && nfat <= 32;
      }
      if (magic === 0xbebafeca || magic === 0xbfbafeca) {
        const nfat = hdr.readUInt32LE(4);
        return nfat >= 1 && nfat <= 32;
      }
    }
    return false;
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
 * Collect nested signable macOS bundle items inside `Contents/{Frameworks,PlugIns,Helpers,Library,Resources,MacOS}`
 * ordered deepest-first (inside-out) so ad-hoc re-signing never relies on deprecated `codesign --deep`.
 *
 * @param {string} appBundlePath
 * @returns {string[]}
 */
function collectNestedMacSignableItems(appBundlePath) {
  const contentsDir = path.join(appBundlePath, 'Contents');
  const subdirs = ['Frameworks', 'PlugIns', 'Helpers', 'Library', 'Resources', 'MacOS'];
  /** @type {Array<{ targetPath: string, depth: number }>} */
  const items = [];
  const seen = new Set();

  const walk = (/** @type {string} */ dir, /** @type {number} */ depth, /** @type {boolean} */ inExecDir) => {
    if (depth > 8) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const isNestedBundle = /\.(?:framework|xpc|app|bundle|appex)$/i.test(entry.name);
        walk(fullPath, depth + 1, inExecDir || entry.name === 'MacOS' || entry.name === 'Helpers');
        if (isNestedBundle && !seen.has(fullPath)) {
          seen.add(fullPath);
          items.push({ targetPath: fullPath, depth });
        }
      } else if (entry.isFile()) {
        const isCodeExt = /\.(?:dylib|so)$/i.test(entry.name);
        if ((isCodeExt || (inExecDir && isMachOBinaryFile(fullPath))) && !seen.has(fullPath)) {
          seen.add(fullPath);
          items.push({ targetPath: fullPath, depth });
        }
      }
    }
  };

  for (const sub of subdirs) {
    const subPath = path.join(contentsDir, sub);
    if (fs.existsSync(subPath)) {
      walk(subPath, 1, sub === 'MacOS' || sub === 'Helpers');
    }
  }

  items.sort((a, b) => b.depth - a.depth || b.targetPath.length - a.targetPath.length);
  return items.map((item) => item.targetPath);
}

/**
 * Inside-out ad-hoc macOS app bundle signing (sync). Never passes `--deep` to `codesign --sign`.
 * @param {string} appBundlePath
 * @param {string | null} bundleId
 * @param {(cmd: string, args: string[], opts: any) => any} execFileSyncImpl
 */
function signMacAppBundleInsideOutSync(appBundlePath, bundleId, execFileSyncImpl) {
  const nestedItems = collectNestedMacSignableItems(appBundlePath);
  for (const itemPath of nestedItems) {
    execFileSyncImpl('codesign', ['--force', '--sign', '-', itemPath], {
      stdio: 'ignore',
      timeout: 15000,
    });
  }
  const outerSignArgs = [
    '--force',
    '--sign',
    '-',
    ...(bundleId ? ['--identifier', bundleId, `-r=designated => identifier "${bundleId}"`] : []),
    appBundlePath,
  ];
  execFileSyncImpl('codesign', outerSignArgs, {
    stdio: 'ignore',
    timeout: 15000,
  });
  execFileSyncImpl('codesign', ['--verify', '--strict', appBundlePath], {
    stdio: 'ignore',
    timeout: 15000,
  });
}

/**
 * Inside-out ad-hoc macOS app bundle signing (async). Never passes `--deep` to `codesign --sign`.
 * @param {string} appBundlePath
 * @param {string | null} bundleId
 * @param {(cmd: string, args: string[], timeout: number) => Promise<any>} runCmd
 */
async function signMacAppBundleInsideOutAsync(appBundlePath, bundleId, runCmd) {
  const nestedItems = collectNestedMacSignableItems(appBundlePath);
  for (const itemPath of nestedItems) {
    await runCmd('codesign', ['--force', '--sign', '-', itemPath], 15000);
  }
  const outerSignArgs = [
    '--force',
    '--sign',
    '-',
    ...(bundleId ? ['--identifier', bundleId, `-r=designated => identifier "${bundleId}"`] : []),
    appBundlePath,
  ];
  await runCmd('codesign', outerSignArgs, 15000);
  await runCmd('codesign', ['--verify', '--strict', appBundlePath], 15000);
}

function ensureMacAppCodeSignatureValid(targetPath, /** @type {any} */ options = {}) {
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

  const hasCustomExecFileSync = typeof options.execFileSyncFn === 'function';
  const hasCustomSpawnSync = typeof options.spawnSyncFn === 'function';
  const useCache =
    ((!hasCustomExecFileSync && !hasCustomSpawnSync) || options.useCodesignCache === true) &&
    options.forceCodesignRecheck !== true;
  if (useCache) {
    hydrateCodesignDiskCache(options);
  }
  const statSig = useCache ? computeMacAppBundleStatSignature(appBundlePath) : null;
  if (useCache && statSig && macCodesignValidCache.get(appBundlePath) === statSig) {
    return { verified: true, repaired: false, cached: true, appBundlePath };
  }

  const execFileSyncImpl = hasCustomExecFileSync ? options.execFileSyncFn : execFileSync;
  const spawnSyncImpl = hasCustomSpawnSync ? options.spawnSyncFn : spawnSync;

  try {
    ensureMacExecutablePermissions(appBundlePath);
  } catch {}

  // O(1) quarantine check before running recursive `xattr -dr`
  let hasQuarantine = true;
  try {
    const xattrOut = execFileSyncImpl('xattr', ['-p', 'com.apple.quarantine', appBundlePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
    if (execFileSyncImpl === execFileSync && !String(xattrOut || '').trim()) {
      hasQuarantine = false;
    }
  } catch (/** @type {any} */ probeErr) {
    const errText = `${probeErr?.stderr || ''} ${probeErr?.message || ''}`;
    if (
      /No such xattr/i.test(errText) ||
      (probeErr?.status === 1 && !/ENOENT|EACCES|EPERM/i.test(errText))
    ) {
      hasQuarantine = false;
    }
  }
  if (hasQuarantine) {
    try {
      execFileSyncImpl('xattr', ['-dr', 'com.apple.quarantine', appBundlePath], {
        stdio: 'ignore',
        timeout: 4000,
      });
    } catch {
      // Never fall back to `xattr -cr` (which strips FinderInfo/codesign metadata); use targeted non-recursive delete.
      try {
        execFileSyncImpl('xattr', ['-d', 'com.apple.quarantine', appBundlePath], {
          stdio: 'ignore',
          timeout: 4000,
        });
      } catch {}
    }
  }

  try {
    execFileSyncImpl('codesign', ['--verify', '--strict', appBundlePath], {
      stdio: 'ignore',
      timeout: 15000,
    });
    if (useCache) {
      const postSig = computeMacAppBundleStatSignature(appBundlePath);
      if (postSig) {
        setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, CODESIGN_DISK_CACHE_MAX_ENTRIES);
        persistCodesignDiskCacheEntry(appBundlePath, postSig, options);
      }
    }
    return { verified: true, repaired: false, appBundlePath };
  } catch (/** @type {any} */ verifyErr) {
    if (isCodesignTimeoutError(verifyErr)) {
      diagLog.warn('codesign.verifyTimedOut', 'Skipped ad-hoc re-sign after codesign --verify timeout', {
        appBundlePath,
      });
      return { verified: false, repaired: false, timedOut: true, appBundlePath };
    }
    try {
      if (hasCustomSpawnSync || !hasCustomExecFileSync) {
        // On macOS, `codesign -dv --verbose=2` writes Authority=... metadata to stderr (stdout is empty).
        const dvRes = spawnSyncImpl('codesign', ['-dv', '--verbose=2', appBundlePath], {
          encoding: 'utf8',
          timeout: 5000,
        });
        if (
          dvRes &&
          (isCodesignTimeoutError(dvRes.error) ||
            dvRes.signal === 'SIGTERM' ||
            dvRes.signal === 'SIGKILL')
        ) {
          diagLog.warn(
            'codesign.dvTimedOut',
            'Skipped ad-hoc re-sign after codesign -dv timeout',
            { appBundlePath }
          );
          return { verified: false, repaired: false, timedOut: true, appBundlePath };
        }
        const combinedDvOut = `${dvRes?.stdout || ''}\n${dvRes?.stderr || ''}`;
        if (hasTrustedAppleOrDeveloperAuthority(combinedDvOut)) {
          diagLog.warn(
            'codesign.refusedAdHocResignTrustedAuthority',
            'Refused to overwrite Developer ID / Apple Distribution signature with ad-hoc signature',
            { appBundlePath }
          );
          return { verified: false, repaired: false, preservedTrustedSignature: true, appBundlePath };
        }
      } else {
        const dvOut = execFileSyncImpl('codesign', ['-dv', '--verbose=2', appBundlePath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        });
        const combinedDvOut =
          dvOut && typeof dvOut === 'object'
            ? `${dvOut.stdout || ''}\n${dvOut.stderr || ''}`
            : String(dvOut || '');
        if (hasTrustedAppleOrDeveloperAuthority(combinedDvOut)) {
          diagLog.warn(
            'codesign.refusedAdHocResignTrustedAuthority',
            'Refused to overwrite Developer ID / Apple Distribution signature with ad-hoc signature',
            { appBundlePath }
          );
          return { verified: false, repaired: false, preservedTrustedSignature: true, appBundlePath };
        }
      }
    } catch (/** @type {any} */ dvErr) {
      if (isCodesignTimeoutError(dvErr)) {
        diagLog.warn(
          'codesign.dvTimedOut',
          'Skipped ad-hoc re-sign after codesign -dv timeout',
          { appBundlePath }
        );
        return { verified: false, repaired: false, timedOut: true, appBundlePath };
      }
      const combinedDvErr = `${dvErr?.stdout || ''}\n${dvErr?.stderr || ''}\n${dvErr?.message || ''}`;
      if (hasTrustedAppleOrDeveloperAuthority(combinedDvErr)) {
        diagLog.warn(
          'codesign.refusedAdHocResignTrustedAuthority',
          'Refused to overwrite Developer ID / Apple Distribution signature with ad-hoc signature',
          { appBundlePath }
        );
        return { verified: false, repaired: false, preservedTrustedSignature: true, appBundlePath };
      }
    }
    try {
      const bundleId = readMacBundleIdFromInfoPlist(appBundlePath);
      signMacAppBundleInsideOutSync(appBundlePath, bundleId, execFileSyncImpl);
      if (useCache) {
        const postSig = computeMacAppBundleStatSignature(appBundlePath);
        if (postSig) {
          setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, CODESIGN_DISK_CACHE_MAX_ENTRIES);
          persistCodesignDiskCacheEntry(appBundlePath, postSig, options);
        }
      }
      return { verified: true, repaired: true, appBundlePath, bundleId: bundleId || null };
    } catch {
      return { verified: false, repaired: false, appBundlePath };
    }
  }
}

async function ensureMacAppCodeSignatureValidAsync(targetPath, /** @type {any} */ options = {}) {
  if (typeof options.execFileSyncFn === 'function') {
    return ensureMacAppCodeSignatureValid(targetPath, options);
  }
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

  const hasCustomExec =
    typeof options.execFileFn === 'function' || typeof options.execFileImpl === 'function';
  const useCache =
    (!hasCustomExec || options.useCodesignCache === true) && options.forceCodesignRecheck !== true;
  if (useCache) {
    hydrateCodesignDiskCache(options);
  }
  const statSig = useCache ? computeMacAppBundleStatSignature(appBundlePath) : null;
  if (useCache && statSig && macCodesignValidCache.get(appBundlePath) === statSig) {
    return { verified: true, repaired: false, cached: true, appBundlePath };
  }

  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const runCmd = (/** @type {string} */ cmd, /** @type {string[]} */ cmdArgs, /** @type {number} */ timeout) =>
    new Promise((resolve, reject) => {
      try {
        execFileImpl(
          cmd,
          cmdArgs,
          { timeout },
          (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
            if (err) {
              if (stdout !== undefined && err && typeof err === 'object' && err.stdout === undefined) {
                err.stdout = stdout;
              }
              if (stderr !== undefined && err && typeof err === 'object' && err.stderr === undefined) {
                err.stderr = stderr;
              }
              reject(err);
            } else {
              resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
            }
          }
        );
      } catch (err) {
        reject(err);
      }
    });

  try {
    ensureMacExecutablePermissions(appBundlePath);
  } catch {}

  // O(1) quarantine check & deduplicated clearing via clearMacQuarantineAsync (avoids 3x recursive xattr -dr)
  try {
    await clearMacQuarantineAsync(appBundlePath, options);
  } catch {}

  try {
    await runCmd('codesign', ['--verify', '--strict', appBundlePath], 15000);
    if (useCache) {
      const postSig = computeMacAppBundleStatSignature(appBundlePath);
      if (postSig) {
        setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, CODESIGN_DISK_CACHE_MAX_ENTRIES);
        persistCodesignDiskCacheEntry(appBundlePath, postSig, options);
      }
    }
    return { verified: true, repaired: false, appBundlePath };
  } catch (/** @type {any} */ verifyErr) {
    if (isCodesignTimeoutError(verifyErr)) {
      diagLog.warn('codesign.verifyTimedOut', 'Skipped ad-hoc re-sign after codesign --verify timeout', {
        appBundlePath,
      });
      return { verified: false, repaired: false, timedOut: true, appBundlePath };
    }
    try {
      const dvRes = /** @type {{ stdout?: string, stderr?: string }} */ (
        await runCmd('codesign', ['-dv', '--verbose=2', appBundlePath], 5000)
      );
      if (hasTrustedAppleOrDeveloperAuthority(`${dvRes?.stdout || ''}\n${dvRes?.stderr || ''}`)) {
        diagLog.warn(
          'codesign.refusedAdHocResignTrustedAuthority',
          'Refused to overwrite Developer ID / Apple Distribution signature with ad-hoc signature',
          { appBundlePath }
        );
        return { verified: false, repaired: false, preservedTrustedSignature: true, appBundlePath };
      }
    } catch (/** @type {any} */ dvErr) {
      if (isCodesignTimeoutError(dvErr)) {
        diagLog.warn(
          'codesign.dvTimedOut',
          'Skipped ad-hoc re-sign after codesign -dv timeout',
          { appBundlePath }
        );
        return { verified: false, repaired: false, timedOut: true, appBundlePath };
      }
      const combinedDvErr = `${dvErr?.stdout || ''}\n${dvErr?.stderr || ''}\n${dvErr?.message || ''}`;
      if (hasTrustedAppleOrDeveloperAuthority(combinedDvErr)) {
        diagLog.warn(
          'codesign.refusedAdHocResignTrustedAuthority',
          'Refused to overwrite Developer ID / Apple Distribution signature with ad-hoc signature',
          { appBundlePath }
        );
        return { verified: false, repaired: false, preservedTrustedSignature: true, appBundlePath };
      }
    }
    try {
      const bundleId = readMacBundleIdFromInfoPlist(appBundlePath);
      await signMacAppBundleInsideOutAsync(appBundlePath, bundleId, runCmd);
      if (useCache) {
        const postSig = computeMacAppBundleStatSignature(appBundlePath);
        if (postSig) {
          setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, CODESIGN_DISK_CACHE_MAX_ENTRIES);
          persistCodesignDiskCacheEntry(appBundlePath, postSig, options);
        }
      }
      return { verified: true, repaired: true, appBundlePath, bundleId: bundleId || null };
    } catch {
      return { verified: false, repaired: false, appBundlePath };
    }
  }
}

/**
 * Inspect whether a GOG installation bundles the GOG Galaxy SDK
 */
function doesGogInstallUseGalaxySdk(installDir, executablePath) {
  const sdkFilePattern =
    /^(?:lib)?Galaxy(?:Peer)?(?:64|32|CSharpGlue)?\.(?:dylib|dll|so)$|^GalaxyPeer\.json$/i;
  const sdkFrameworkDirPattern =
    /^(?:lib)?Galaxy(?:Peer)?(?:64|32|CSharpGlue)?\.(?:framework|bundle)$/i;
  const sdkFrameworkBinaryPattern = /^(?:lib)?Galaxy(?:Peer)?(?:64|32|CSharpGlue)?$/i;
  const skipAssetDirsPattern =
    /^(?:node_modules|\.git|_CodeSignature|StreamingAssets|Movies|Video|Audio|Music|Sounds|Paks|pak|Localization|Locales)$/i;
  const searchRoots = new Set();

  const addMacAppSearchRoots = (/** @type {string | null} */ appPath) => {
    if (!appPath) return;
    searchRoots.add(appPath);
    searchRoots.add(path.join(appPath, 'Contents', 'Frameworks'));
    searchRoots.add(path.join(appPath, 'Contents', 'MacOS'));
    searchRoots.add(path.join(appPath, 'Contents', 'PlugIns'));
    searchRoots.add(path.join(appPath, 'Contents', 'Resources', 'Data', 'Plugins'));
  };

  if (installDir && typeof installDir === 'string') {
    const cleanInstall = toLocalFsPath(installDir);
    if (cleanInstall && fs.existsSync(cleanInstall)) {
      searchRoots.add(cleanInstall);
      addMacAppSearchRoots(resolveTargetMacAppBundlePath(cleanInstall));
    }
  }

  if (executablePath && typeof executablePath === 'string') {
    const cleanExe = toLocalFsPath(executablePath);
    if (cleanExe) {
      const exeDir = path.dirname(cleanExe);
      if (exeDir && fs.existsSync(exeDir)) {
        searchRoots.add(exeDir);
      }
      addMacAppSearchRoots(resolveTargetMacAppBundlePath(cleanExe));
    }
  }

  const visitedDirs = new Set();
  const scanDir = (/** @type {string} */ dirPath, /** @type {number} */ depth) => {
    if (depth > 6 || !dirPath || visitedDirs.has(dirPath) || !fs.existsSync(dirPath)) {
      return false;
    }
    visitedDirs.add(dirPath);
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }

    const normDir = dirPath.replace(/\\/g, '/');
    const isInsideFrameworkOrBundleBin =
      /\.framework(?:\/Versions\/[^/]+)?$/i.test(normDir) ||
      /\.bundle\/Contents\/MacOS$/i.test(normDir);

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const isFileOrSymlink = entry.isFile() || entry.isSymbolicLink();
      if (isFileOrSymlink && sdkFilePattern.test(entry.name)) {
        return true;
      }
      if (
        isFileOrSymlink &&
        isInsideFrameworkOrBundleBin &&
        sdkFrameworkBinaryPattern.test(entry.name)
      ) {
        return true;
      }
      if (sdkFrameworkDirPattern.test(entry.name)) {
        if (entry.isDirectory()) return true;
        if (entry.isSymbolicLink()) {
          try {
            if (fs.statSync(path.join(dirPath, entry.name)).isDirectory()) {
              return true;
            }
          } catch {}
        }
      }
    }

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (skipAssetDirsPattern.test(entry.name)) continue;
      let isSubDir = entry.isDirectory();
      if (!isSubDir && entry.isSymbolicLink()) {
        try {
          isSubDir = fs.statSync(path.join(dirPath, entry.name)).isDirectory();
        } catch {
          isSubDir = false;
        }
      }
      if (isSubDir) {
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

      const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
      if (fs.existsSync(plistPath)) {
        try {
          const plistContent = fs.readFileSync(plistPath, 'utf8');
          const m = plistContent.match(
            /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
          );
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
                  parsed.playTasks.find((/** @type {any} */ t) => t && t.isPrimary && t.path) ||
                  parsed.playTasks.find((/** @type {any} */ t) => t && t.path);
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

function mergeDirectoryIntoParentSync(srcDir, destDir) {
  const entries = fs.readdirSync(srcDir);
  for (const itemName of entries) {
    if (itemName === '.DS_Store') {
      try {
        fs.rmSync(path.join(srcDir, itemName), { force: true });
      } catch {}
      continue;
    }
    const src = path.join(srcDir, itemName);
    const dest = path.join(destDir, itemName);
    let srcStat;
    try {
      srcStat = fs.lstatSync(src);
    } catch {
      continue;
    }

    let destStat = null;
    try {
      destStat = fs.lstatSync(dest);
    } catch {
      destStat = null;
    }

    if (!destStat) {
      try {
        fs.renameSync(src, dest);
      } catch {
        try {
          fs.cpSync(src, dest, { recursive: true, force: true });
          fs.rmSync(src, { recursive: true, force: true });
        } catch {}
      }
      continue;
    }

    if (
      srcStat.isDirectory() &&
      !srcStat.isSymbolicLink() &&
      destStat.isDirectory() &&
      !destStat.isSymbolicLink()
    ) {
      mergeDirectoryIntoParentSync(src, dest);
      try {
        if (fs.readdirSync(src).length === 0) {
          fs.rmdirSync(src);
        }
      } catch {}
      continue;
    }

    if (!destStat.isDirectory() || destStat.isSymbolicLink()) {
      try {
        if (process.platform === 'win32') {
          fs.rmSync(dest, { force: true });
        }
        fs.renameSync(src, dest);
      } catch {
        try {
          fs.cpSync(src, dest, { recursive: true, force: true });
          fs.rmSync(src, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}

function hasIncompleteGogdlMarkers(dirPath) {
  try {
    return (
      fs.existsSync(path.join(dirPath, '.gogdl-resume')) ||
      fs.existsSync(path.join(dirPath, '.gogdl-download-cache')) ||
      fs.existsSync(path.join(dirPath, '.onelauncher-gog-v2-resume.json'))
    );
  } catch {
    return false;
  }
}

function flattenGogNestedInstallDir(finalInstallPath, cleanId) {
  try {
    if (!finalInstallPath || !fs.existsSync(finalInstallPath)) return finalInstallPath;
    if (finalInstallPath.toLowerCase().endsWith('.app')) return finalInstallPath;
    if (isPathUnderActiveDownload(finalInstallPath)) return finalInstallPath;
    if (/[\\/]steamapps[\\/]common(?:[\\/]|$)/i.test(finalInstallPath)) {
      return finalInstallPath;
    }
    const stat = fs.statSync(finalInstallPath);
    if (!stat.isDirectory()) return finalInstallPath;

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

    if (rootEntries.some((e) => e.isDirectory() && e.name.toLowerCase() === 'contents')) {
      return finalInstallPath;
    }

    if (rootEntries.some((e) => e.isDirectory() && e.name.toLowerCase().endsWith('.app'))) {
      return finalInstallPath;
    }

    /** @type {Set<string>} */
    const rootInfoIds = new Set();
    for (const e of rootEntries) {
      if (!e.isFile()) continue;
      const m = e.name.match(/^\.?goggame-(\d+)\.info$/i);
      if (m && m[1]) rootInfoIds.add(m[1]);
    }

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
      if (hasIncompleteGogdlMarkers(subFullPath)) {
        continue;
      }
      try {
        const subFiles = fs.readdirSync(subFullPath);
        if (rootInfoIds.size > 0) {
          const matchesSameRootGame =
            (cleanId && subFiles.includes(`goggame-${cleanId}.info`)) ||
            subFiles.some((f) => {
              const m = f.match(/^\.?goggame-(\d+)\.info$/i);
              return Boolean(m && m[1] && rootInfoIds.has(m[1]));
            });
          if (matchesSameRootGame) {
            targetSubDir = subFullPath;
            break;
          }
        } else if (
          (cleanId && subFiles.includes(`goggame-${cleanId}.info`)) ||
          subFiles.some((f) => /^\.?goggame-\d+\.info$/i.test(f))
        ) {
          targetSubDir = subFullPath;
          break;
        }
      } catch {}
    }

    if (rootInfoIds.size > 0 && !targetSubDir) {
      return finalInstallPath;
    }

    if (
      !targetSubDir &&
      visibleDirs.length === 1 &&
      visibleFiles.length === 0 &&
      !/^(bin|binaries|rerelease|x64|x86|win64|win32|macos|content|contents|resources|data|engine)$/i.test(
        visibleDirs[0].name
      )
    ) {
      const candidateSubDir = path.join(finalInstallPath, visibleDirs[0].name);
      const isXboxPackageSubDir =
        fs.existsSync(path.join(candidateSubDir, 'MicrosoftGame.config')) ||
        fs.existsSync(path.join(candidateSubDir, 'AppxManifest.xml'));
      if (!isXboxPackageSubDir && !hasIncompleteGogdlMarkers(candidateSubDir)) {
        targetSubDir = candidateSubDir;
      }
    }

    if (targetSubDir && fs.existsSync(targetSubDir)) {
      mergeDirectoryIntoParentSync(targetSubDir, finalInstallPath);
      try {
        const remaining = fs.readdirSync(targetSubDir);
        if (remaining.length === 0) {
          fs.rmdirSync(targetSubDir);
        }
      } catch {}
      if (rootInfoIds.size > 0) {
        const orphanRootResume = path.join(finalInstallPath, '.gogdl-resume');
        try {
          if (fs.existsSync(orphanRootResume)) {
            fs.rmSync(orphanRootResume, { force: true });
          }
        } catch {}
      }
      evictExecutableDiscoveryCacheForPath(finalInstallPath);
    }
  } catch {}
  return finalInstallPath;
}

/**
 * Extracts a candidate launcher stem from an engine executable filename, requiring an
 * explicit delimiter (`_main`, `-main`, `.main`), a digit-to-`main` boundary (`<Stem><N>Main.exe`),
 * or a mixed-case `Main` boundary (`<Stem>Main.exe`).
 * Safely rejects ordinary words ending in `main` (e.g. `Domain.exe`, `DOMAIN.EXE`, `Remain.exe`).
 *
 * @param {string | undefined | null} fileName
 * @returns {string | null}
 */
function extractSiblingLauncherStem(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const cleanName = path.basename(fileName.replace(/\\/g, '/'));

  // 1. Explicit delimiter before main: stem_main.exe, stem-main.exe, stem.main.exe
  const delimMatch = cleanName.match(/^(.+?)[_\-.](?:main)\.exe$/i);
  if (delimMatch && delimMatch[1].trim()) return delimMatch[1].trim();

  // 2. Numeric transition before main: game2main.exe, engine3MAIN.exe
  const digitMatch = cleanName.match(/^(.+?[0-9])(?:main)\.exe$/i);
  if (digitMatch && digitMatch[1].trim()) return digitMatch[1].trim();

  // 3. Mixed-case Main boundary: GameMain.exe, EngineMain.EXE (rejects Domain.exe / DOMAIN.EXE)
  const camelMatch = cleanName.match(/^([A-Za-z0-9_.\-]+)Main\.[eE][xX][eE]$/);
  if (camelMatch && camelMatch[1].trim()) return camelMatch[1].trim();

  return null;
}

/**
 * Resolves whether a candidate executable has a valid sibling bootstrapper launcher `<Stem>.exe`.
 * Classic Windows titles frequently pair an outer launcher stub `<Stem>.exe` with an inner
 * engine binary `<Stem>Main.exe`, `<Stem>_main.exe`, or `<Stem>-main.exe`.
 * Preserves `candidatePath` unchanged when no valid PE bootstrapper sibling exists.
 *
 * @param {string | undefined | null} candidatePath
 * @param {string | undefined | null} [rootDir]
 * @returns {string | undefined}
 */
function resolveSiblingLauncherStub(candidatePath, rootDir = undefined) {
  if (!candidatePath || typeof candidatePath !== 'string') return candidatePath || undefined;
  const originalPath = candidatePath;
  const normalizedCandidate = String(candidatePath).replace(/\\/g, path.sep);
  const fileName = path.basename(normalizedCandidate);

  const stem = extractSiblingLauncherStem(fileName);
  if (!stem) return originalPath;
  const targetName = `${stem.toLowerCase()}.exe`;

  const candidateDir = path.dirname(normalizedCandidate);
  const dirsToCheck = [candidateDir];

  const parentDir = path.dirname(candidateDir);
  if (parentDir && parentDir !== candidateDir && parentDir !== '.' && parentDir !== path.parse(parentDir).root) {
    let allowParent = false;
    if (rootDir && typeof rootDir === 'string') {
      const resolvedRoot = path.resolve(String(rootDir).replace(/\\/g, path.sep));
      const resolvedParent = path.resolve(parentDir);
      const rel = path.relative(resolvedRoot, resolvedParent);
      allowParent = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } else {
      const parentBase = path.basename(parentDir).toLowerCase();
      const genericContainers = new Set([
        'games',
        'gog',
        'gog games',
        'steamapps',
        'common',
        'program files',
        'program files (x86)',
        'users',
        'applications',
        'onelauncher',
      ]);
      allowParent = Boolean(parentBase && !genericContainers.has(parentBase));
    }
    if (allowParent) {
      dirsToCheck.push(parentDir);
    }
  }

  for (const dir of dirsToCheck) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      const matchFile = files.find((f) => f.toLowerCase() === targetName);
      if (!matchFile) continue;
      const fullPath = path.join(dir, matchFile);
      if (isExcludedExecutable(fullPath) || /^gdkstubgame\.exe$/i.test(matchFile)) {
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size <= 0) {
          continue;
        }
        const peHeader = inspectWindowsExecutableHeader(fullPath);
        if (peHeader.is16BitDos) {
          continue;
        }
        return fullPath;
      } catch {}
    } catch {}
  }

  return originalPath;
}

/**
 * Auto-discover the primary game executable inside an installation directory
 */
function findPrimaryExecutable(installPath, /** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const hintName = options.hintName || options.preferredHint || '';
  const preferWindowsExecutable = Boolean(options.preferWindowsExecutable);
  const localInstallPath = toLocalFsPath(installPath);

  if (!localInstallPath || !fs.existsSync(localInstallPath)) {
    return { executablePath: undefined, isWindowsBinaryOnMac: false };
  }

  const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(localInstallPath);
  const readOnly = Boolean(options.readOnly) || isPathUnderActiveDownload(localInstallPath);

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
    !(
      platform === 'darwin' &&
      /[\\/]GOGLauncher$/i.test(String(cached.result.executablePath || ''))
    )
  ) {
    return { ...cached.result };
  }

  if (platform === 'darwin' && !isInsideBottle && !readOnly) {
    flattenGogNestedInstallDir(localInstallPath, undefined);
    if (!preferWindowsExecutable) {
      ensureMacExecutablePermissions(localInstallPath);
    }
    try {
      rootMtimeMs = fs.statSync(localInstallPath).mtimeMs || 0;
    } catch {}
  }

  const cacheAndReturn = (/** @type {any} */ result) => {
    let finalResult = result;
    if (finalResult && finalResult.executablePath && !options.exactCandidate) {
      const sibling = resolveSiblingLauncherStub(finalResult.executablePath, localInstallPath);
      if (sibling && sibling !== finalResult.executablePath) {
        finalResult = {
          ...finalResult,
          executablePath: sibling,
        };
      }
    }
    setBoundedMapEntry(
      executableDiscoveryCache,
      cacheKey,
      {
        result: finalResult,
        mtimeMs: rootMtimeMs,
        timestamp: Date.now(),
      },
      MAX_DISCOVERY_CACHE_ENTRIES
    );
    return { ...finalResult };
  };

  /** @type {string[]} */
  const macApps = [];
  /** @type {any[]} */
  const winExeCandidates = [];
  /** @type {string[]} */
  const unixBins = [];
  const maxWalkDepth = platform === 'darwin' ? 4 : 3;

  function walk(currentDir, depth) {
    if (depth > maxWalkDepth) return;
    /** @type {fs.Dirent[]} */
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
          continue;
        }
        const skipRe =
          platform === 'darwin' && !isInsideBottle
            ? /^(node_modules|redist|_commonredist|__installer|directx|vcredist|locales|streamingassets|mono|_codesignature)$/i
            : /^(node_modules|redist|_commonredist|__installer|directx|vcredist|locales|resources|data|assets|streamingassets|mono)$/i;
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

  const resolveGogInfoPlayTaskExecutable = () => {
    const infoSearchDirs = [
      path.join(localInstallPath, 'Contents', 'Resources'),
      path.join(localInstallPath, 'Resources'),
      localInstallPath,
      ...macApps.map((appDir) => path.join(appDir, 'Contents', 'Resources')),
    ];
    for (const dir of infoSearchDirs) {
      if (!fs.existsSync(dir)) continue;
      /** @type {string[]} */
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
          const task = selectPreferredGogPlayTask(
            parsed.playTasks,
            [dir, localInstallPath, path.resolve(dir, '..', '..')],
            { platform }
          );
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

    const normFolder = path
      .basename(rootDir)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const exactMatch = modDirs.find(
      (dir) => dir.toLowerCase().replace(/[^a-z0-9]/g, '') === normFolder
    );
    const nonBaseMod = modDirs.find((dir) => !/^(hl2|platform|bin|core|config)$/i.test(dir));
    const chosenMod = exactMatch || nonBaseMod || modDirs[0];
    return chosenMod ? `-game ${chosenMod} -steam` : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  EXCLUDED_EXECUTABLE_PATTERNS,
  isExcludedExecutable,
  hasShebangHeader,
  scoreExecutableCandidate,
  ensureMacExecutablePermissions,
  resolveTargetMacAppBundlePath,
  readMacBundleIdFromInfoPlist,
  ensureMacAppCodeSignatureValid,
  ensureMacAppCodeSignatureValidAsync,
  doesGogInstallUseGalaxySdk,
  resolveMacAppBundleBinary,
  flattenGogNestedInstallDir,
  extractSiblingLauncherStem,
  resolveSiblingLauncherStub,
  findPrimaryExecutable,
  resolveDefaultEngineLaunchArguments,
};
