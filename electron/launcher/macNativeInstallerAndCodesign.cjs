const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');

const {
  getElectron,
  getMainWindow,
  getUserDataDir,
  isTestEnvironment,
  toLocalFsPath,
  openExternalUri,
  clearMacQuarantineAsync,
  writeManagedInstallSentinel,
  getGameLaunchConfigs,
  resolvePlatformLaunchConfig,
  getLauncherPerformanceSettings,
  safeIsBottleSlug,
  MAX_DISCOVERY_CACHE_ENTRIES,
  MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES,
  STEAM_APPINFO_BUF_IDLE_TTL_MS,
  macCodesignValidCache,
  recentDisplaySanitizeCache,
  pendingWineRegSyncByPrefix,
  executableDiscoveryCache,
  steamAppInfoCache,
  steamResolvedLaunchSpecCache,
  moltenVkHudDeadlockCache,
  setBoundedMapEntry,
  evictExecutableDiscoveryCacheForPath,
  isPathUnderActiveDownload,
} = require('./engineStateRegistry.cjs');
const {
  atomicWriteFileSync,
  isContainedWithinRoot,
} = require('./securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  resolveBottleSteamExe,
  sandboxWinePrefixUserFolders,
  sandboxWinePrefixUserFoldersAsync,
  upsertWineUserRegKey,
  upsertWineUserRegKeysBatch,
  applyStrictRosettaAvxEnv,
} = require('./wineAndCrossOverManager.cjs');
const windowsRegistryDiscovery = require('../utils/windowsRegistryDiscovery.cjs');
const {
  inspectWindowsExecutableHeader,
  inspectMacMachOHeader,
  parseSteamLibraryFoldersVdf,
} = require('./binaryAndManifestInspectors.cjs');
const { compareSemver } = require('../utils/semverUtils.cjs');

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

function computeMacAppBundleStatSignature(appBundlePath) {
  try {
    const bundleSt = fs.statSync(appBundlePath);
    const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
    const plistSt = fs.existsSync(infoPlistPath) ? fs.statSync(infoPlistPath) : null;
    const innerBin = resolveMacAppBundleBinary(appBundlePath);
    const binSt =
      innerBin && innerBin !== appBundlePath && fs.existsSync(innerBin)
        ? fs.statSync(innerBin)
        : null;
    return [
      `${bundleSt.dev}:${bundleSt.ino}:${Math.trunc(bundleSt.mtimeMs)}`,
      plistSt ? `${plistSt.dev}:${plistSt.ino}:${Math.trunc(plistSt.mtimeMs)}` : 'no-plist',
      binSt ? `${binSt.dev}:${binSt.ino}:${Math.trunc(binSt.mtimeMs)}:${binSt.size}` : 'no-bin',
    ].join('|');
  } catch {
    return null;
  }
}

function readMacBundleIdFromInfoPlist(appBundlePath) {
  const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlistPath)) return '';
  try {
    const plistRaw = fs.readFileSync(infoPlistPath, 'utf8');
    const idMatch = plistRaw.match(
      /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/i
    );
    return idMatch && idMatch[1] ? idMatch[1].trim() : '';
  } catch {
    return '';
  }
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

  const useCache =
    typeof options.execFileSyncFn !== 'function' && options.forceCodesignRecheck !== true;
  const statSig = useCache ? computeMacAppBundleStatSignature(appBundlePath) : null;
  if (useCache && statSig && macCodesignValidCache.get(appBundlePath) === statSig) {
    return { verified: true, repaired: false, cached: true, appBundlePath };
  }

  const execFileSyncImpl =
    typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;

  try {
    ensureMacExecutablePermissions(appBundlePath);
  } catch {}

  try {
    execFileSyncImpl('xattr', ['-dr', 'com.apple.quarantine', appBundlePath], {
      stdio: 'ignore',
      timeout: 4000,
    });
  } catch {
    try {
      execFileSyncImpl('xattr', ['-cr', appBundlePath], {
        stdio: 'ignore',
        timeout: 4000,
      });
    } catch {}
  }

  try {
    execFileSyncImpl('codesign', ['--verify', '--deep', '--strict', appBundlePath], {
      stdio: 'ignore',
      timeout: 5000,
    });
    if (useCache) {
      const postSig = computeMacAppBundleStatSignature(appBundlePath);
      if (postSig) setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, 500);
    }
    return { verified: true, repaired: false, appBundlePath };
  } catch {
    try {
      const bundleId = readMacBundleIdFromInfoPlist(appBundlePath);
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
      if (useCache) {
        const postSig = computeMacAppBundleStatSignature(appBundlePath);
        if (postSig) setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, 500);
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

  const useCache =
    typeof options.execFileFn !== 'function' &&
    typeof options.execFileImpl !== 'function' &&
    options.forceCodesignRecheck !== true;
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
        execFileImpl(cmd, cmdArgs, { timeout }, (/** @type {any} */ err) => {
          if (err) reject(err);
          else resolve(true);
        });
      } catch (err) {
        reject(err);
      }
    });

  try {
    ensureMacExecutablePermissions(appBundlePath);
  } catch {}

  // Strictly await quarantine attribute stripping BEFORE codesign verification & launch
  try {
    await runCmd('xattr', ['-dr', 'com.apple.quarantine', appBundlePath], 6000);
  } catch {
    try {
      await clearMacQuarantineAsync(appBundlePath, { ...options, force: true });
    } catch {}
  }

  try {
    await runCmd('codesign', ['--verify', '--deep', '--strict', appBundlePath], 5000);
    if (useCache) {
      const postSig = computeMacAppBundleStatSignature(appBundlePath);
      if (postSig) setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, 500);
    }
    return { verified: true, repaired: false, appBundlePath };
  } catch {
    try {
      const bundleId = readMacBundleIdFromInfoPlist(appBundlePath);
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
      await runCmd('codesign', signArgs, 15000);
      if (useCache) {
        const postSig = computeMacAppBundleStatSignature(appBundlePath);
        if (postSig) setBoundedMapEntry(macCodesignValidCache, appBundlePath, postSig, 500);
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
          const isFileTask = (/** @type {any} */ t) =>
            Boolean(t && t.path && (!t.type || String(t.type) === 'FileTask'));
          const task =
            parsed.playTasks.find((/** @type {any} */ t) => isFileTask(t) && t.isPrimary) ||
            parsed.playTasks.find((/** @type {any} */ t) => isFileTask(t) && t.category === 'game') ||
            parsed.playTasks.find((/** @type {any} */ t) => isFileTask(t));
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

function scheduleSteamAppInfoBufEviction(/** @type {any} */ entry) {
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
    /** @type {Record<string, any>} */
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

function readSteamAppInfoParsedEntry(appinfoPath, appId) {
  try {
    const cleanAppId = parseInt(String(appId || '').replace(/^steam[-_]/i, '').trim(), 10);
    if (!cleanAppId || Number.isNaN(cleanAppId)) return null;
    const indexed = getIndexedSteamAppInfoVdf(appinfoPath);
    if (!indexed) return null;
    const slice = indexed.appIndex.get(cleanAppId);
    if (!slice) return null;
    if (indexed.buf) {
      scheduleSteamAppInfoBufEviction(indexed);
      return parseSteamBinaryVdfSlice(
        indexed.buf,
        slice.payloadStart,
        slice.payloadEnd,
        indexed.strings
      );
    }
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
    return parseSteamBinaryVdfSlice(sliceBuf, 0, sliceLen, indexed.strings);
  } catch {
    return null;
  }
}

function findEnclosingSteamAppInfoVdf(startPaths = [], /** @type {any} */ options = {}) {
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

function resolveSteamAppInfoLaunchSpec(
  steamappsDirOrInstallPath,
  appId,
  /** @type {any} */ installPath,
  /** @type {any} */ options = {}
) {
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
    /** @type {Array<{ score: number, entry: any, rawExe: string, isProtocolUri: boolean, isUbisoft: boolean }>} */
    const protocolLaunchCandidates = [];
    for (const [, entry] of Object.entries(launchMap)) {
      if (!entry || typeof entry !== 'object' || !entry.executable) continue;
      const rawExe = String(entry.executable).trim();
      if (!rawExe) continue;

      const oslist = String(entry.config?.oslist || '').toLowerCase();
      const entryType = String(entry.type || 'default').toLowerCase();
      const isProtocolUri = /^(?:link2ea|origin2|origin|uplay):\/\//i.test(rawExe);
      const isChainedShimExe =
        !isProtocolUri && /(?:^|[\\/])(?:link2ea|ealauncher|upc)\.exe$/i.test(rawExe);

      if (isProtocolUri || isChainedShimExe) {
        if (oslist) {
          if (wantWindows && !oslist.includes('windows')) {
            continue;
          }
          if (
            !wantWindows &&
            !oslist.includes('macos') &&
            !oslist.includes('osx') &&
            !oslist.includes('windows')
          ) {
            continue;
          }
        }
        let protoScore = isProtocolUri ? 120 : 90;
        if (entryType === 'default' || entryType === 'none' || !entry.type) {
          protoScore += 50;
        }
        if (entry.config?.ownsdlc) {
          protoScore -= 15;
        }
        const isUbisoft =
          /^uplay:\/\//i.test(rawExe) || /(?:^|[\\/])upc\.exe$/i.test(rawExe);
        protocolLaunchCandidates.push({
          score: protoScore,
          entry,
          rawExe,
          isProtocolUri,
          isUbisoft,
        });
        continue;
      }

      const relExe = rawExe.replace(/^[\\/]+/, '').replace(/\\/g, path.sep);
      if (!relExe || !resolvedInstallPath) continue;

      let candidateExe = path.join(resolvedInstallPath, relExe);
      if (!fs.existsSync(candidateExe)) continue;

      if (platform === 'darwin' && !isInsideBottle && candidateExe.toLowerCase().endsWith('.app')) {
        candidateExe = resolveMacAppBundleBinary(candidateExe);
      }

      if (isExcludedExecutable(candidateExe)) continue;

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

    if (protocolLaunchCandidates.length > 0) {
      protocolLaunchCandidates.sort((a, b) => b.score - a.score);
      candidates.sort((a, b) => b.score - a.score);
      const bestProto = protocolLaunchCandidates[0];
      // Only let a native macOS `.app` binary override a Windows-only protocol entry if Steam ships a native Mac build
      const hasHigherNativeMacCandidate =
        platform === 'darwin' &&
        !wantWindows &&
        candidates.length > 0 &&
        !candidates[0].executablePath.toLowerCase().endsWith('.exe') &&
        candidates[0].score > bestProto.score;

      if (!hasHigherNativeMacCandidate) {
        let concreteExe = candidates[0]?.executablePath || null;
        if (!concreteExe && resolvedInstallPath && fs.existsSync(resolvedInstallPath)) {
          const discovered = findPrimaryExecutable(resolvedInstallPath, {
            platform: wantWindows ? 'win32' : platform,
          });
          if (discovered?.executablePath) {
            concreteExe = discovered.executablePath;
          }
        }
        const launchArguments =
          bestProto.entry.arguments && String(bestProto.entry.arguments).trim()
            ? String(bestProto.entry.arguments).trim()
            : undefined;
        const workingDirectory =
          bestProto.entry.workingdir && resolvedInstallPath
            ? path.join(
                resolvedInstallPath,
                String(bestProto.entry.workingdir)
                  .replace(/^[\\/]+/, '')
                  .replace(/\\/g, path.sep)
              )
            : resolvedInstallPath || undefined;
        const isWindowsBinaryOnMac =
          platform === 'darwin' &&
          Boolean(
            isInsideBottle ||
              wantWindows ||
              !concreteExe ||
              concreteExe.toLowerCase().endsWith('.exe')
          );
        const resolvedProtoSpec = {
          executablePath: concreteExe || null,
          args: launchArguments,
          launchArguments,
          workingDir: workingDirectory,
          workingDirectory,
          isWindowsBinaryOnMac,
          requiresStorefrontProtocolLaunch: true,
          ...(bestProto.isProtocolUri ? { protocolUri: bestProto.rawExe } : {}),
          chainedLauncherHandoff: /** @type {'ubisoft' | 'ea'} */ (
            bestProto.isUbisoft ? 'ubisoft' : 'ea'
          ),
          chainedHandoffTopology: /** @type {'storefront_depot_uri'} */ ('storefront_depot_uri'),
        };
        setBoundedMapEntry(
          steamResolvedLaunchSpecCache,
          specCacheKey,
          { installPath: resolvedInstallPath, platform, spec: resolvedProtoSpec },
          MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
        );
        return { ...resolvedProtoSpec };
      }
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

function discoverSteamLocations(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const isIsolatedTest = Boolean(
    options.homedir || (options.customRoots && options.customRoots.length > 0)
  );

  const candidateSteamRoots = [
    path.join(homedir, 'Library/Application Support/Steam'),
    path.join(homedir, '.local/share/Steam'),
    path.join(homedir, '.steam/steam'),
    ...customRoots,
  ];

  const bottleContainers = [
    path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
    path.join(homedir, 'Games/OneLauncher/Bottles'),
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
    if (platform === 'win32') {
      const regSteam = windowsRegistryDiscovery.discoverWindowsSteamRegistryPaths(options);
      const regSteamRoot = regSteam.steamRoot || regSteam.steamPath;
      if (regSteamRoot) {
        candidateSteamRoots.unshift(regSteamRoot);
      }
    }
  }

  const steamRoots = new Set();
  const steamappsDirs = new Set();

  const addSteamRootCandidate = (/** @type {any} */ dir) => {
    const resolved = toLocalFsPath(dir, customRoots);
    if (resolved && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          steamRoots.add(resolved);
        }
      } catch {}
    }
  };

  const addSteamappsCandidate = (/** @type {any} */ dir) => {
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

  const inspectSteamRootForVdf = (/** @type {any} */ rootDir) => {
    const localRoot = toLocalFsPath(rootDir, customRoots);
    if (!localRoot || !fs.existsSync(localRoot)) return;

    addSteamRootCandidate(localRoot);

    if (path.basename(localRoot).toLowerCase() === 'steamapps') {
      addSteamappsCandidate(localRoot);
    }
    addSteamappsCandidate(path.join(localRoot, 'steamapps'));
    addSteamappsCandidate(path.join(localRoot, 'Steam', 'steamapps'));

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

function normalizeComparableTitle(value) {
  if (!value || typeof value !== 'string') return '';
  /** @type {Record<string, string>} */
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

function cleanupCrossOverSteamShortcuts(appId, title, bottleDirs = [], /** @type {any} */ options = {}) {
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
  /** @type {string[]} */
  const removedPaths = [];
  const escapedAppId = cleanAppId ? cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const appIdUrlRegex = escapedAppId
    ? new RegExp(`steam://rungameid/${escapedAppId}(?:\\b|$)`, 'i')
    : null;

  const scanWinUrlDir = (/** @type {string} */ dirPath, depth = 0) => {
    if (depth > 4 || !dirPath || !fs.existsSync(dirPath)) return;
    /** @type {fs.Dirent[]} */
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
    /** @type {fs.Dirent[]} */
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

  for (const bottleDir of allBottleDirs) {
    const cxmenuDir = path.join(bottleDir, 'desktopdata', 'cxmenu');
    if (!fs.existsSync(cxmenuDir)) continue;

    const scanCxmenuDir = (/** @type {string} */ dirPath, depth = 0) => {
      if (depth > 5 || !dirPath || !fs.existsSync(dirPath)) return;
      /** @type {fs.Dirent[]} */
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

  const cxAppsRoot = path.join(homedir, 'Applications', 'CrossOver');
  const userAppsRoot = path.join(homedir, 'Applications');

  const scanAppsDir = (/** @type {string} */ dirPath, depth = 0) => {
    if (depth > 3 || !dirPath || !fs.existsSync(dirPath)) return;
    /** @type {fs.Dirent[]} */
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
  const homedir = (options && options.homedir) || os.homedir();
  return path.join(homedir, 'Library/Application Support/OneLauncher/runner-install-receipts.json');
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
 * Read all stored runner install receipts (100% read-only; never creates directories or mutates files).
 *
 * @param {any} [options]
 * @returns {Record<string, any>}
 */
function readRunnerInstallReceipts(options = {}) {
  const filePath = getRunnerInstallReceiptsFilePath(options);
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

  if (appPath) {
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
      try {
        const plistStat = fs.statSync(plistPath);
        const { shortVer, bundleVer } = readAppBundlePlistVersionStrings(plistPath);
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

        const receipts = readRunnerInstallReceipts(options);
        const normKey = normalizeReceiptAppPath(appPath);
        const receipt =
          receipts[normKey] ||
          Object.entries(receipts).find(([k]) => k.toLowerCase() === normKey.toLowerCase())?.[1];
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

  const sharedCrossOverBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver/Bottles'
  );
  const previewSpecBottlesDir = path.join(
    homedir,
    'Library/Application Support/CrossOver Preview/Bottles'
  );

  const defaultBottleSlug = 'OneLauncher';
  if (safeIsBottleSlug(defaultBottleSlug) && !options.readOnly) {
    const brokenPreviewBottle = path.join(previewSpecBottlesDir, defaultBottleSlug);
    if (
      isContainedWithinRoot(previewSpecBottlesDir, brokenPreviewBottle) &&
      fs.existsSync(brokenPreviewBottle) &&
      !isValidBottleDirectory(brokenPreviewBottle, false)
    ) {
      try {
        fs.rmSync(brokenPreviewBottle, { recursive: true, force: true });
      } catch {}
    }
  }

  const effectivePreviewBottlesDir = hasValidInitializedBottles(
    previewSpecBottlesDir,
    isIsolatedTest
  )
    ? previewSpecBottlesDir
    : fs.existsSync(sharedCrossOverBottlesDir)
      ? sharedCrossOverBottlesDir
      : previewSpecBottlesDir;

  const hostArch = String(options?.arch || process.arch || 'arm64');
  const darwinKernelMajor =
    options?.darwinKernelMajor !== undefined
      ? Number(options.darwinKernelMajor)
      : process.platform === 'darwin'
        ? Number(String(os.release() || '25.0.0').split('.')[0]) || 25
        : 25;
  const layerHostDlssCaps = {
    hostArch,
    darwinKernelMajor,
    supportsMetalFxDlssD3dMetal: hostArch === 'arm64' && darwinKernelMajor >= 25,
    supportsMetalFxDlssDxmt: hostArch === 'arm64' && darwinKernelMajor >= 23,
  };

  /** @type {any[]} */
  const layers = [];
  const addedTypes = new Set();

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
   * managers (`Heroic`, `Whisky`, `Sikarugir`, `Kegworks`, `Mythic`), and CLI wrappers.
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
   * @param {{ layer: any, sourceRank: number } | null} best
   * @param {{ layer: any, sourceRank: number }} next
   * @returns {boolean}
   */
  const isBetterRankedLayerCandidate = (best, next) => {
    if (!best) return true;
    if (isCandidateNewerVersion(best.layer, next.layer)) return true;
    if (isCandidateNewerVersion(next.layer, best.layer)) return false;
    return next.sourceRank > best.sourceRank;
  };

  for (const variant of crossoverVariants) {
    /** @type {{ layer: any, sourceRank: number } | null} */
    let bestVariantEntry = null;
    for (const appsDir of appsDirs) {
      try {
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

        const candidateEntry = {
          sourceRank: getAppsDirRank(appsDir),
          layer: {
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
            ...layerHostDlssCaps,
            bottlesDir: variant.bottlesDir,
            availableBottles,
          },
        };

        if (isBetterRankedLayerCandidate(bestVariantEntry, candidateEntry)) {
          bestVariantEntry = candidateEntry;
        }
      } catch {
        // Isolate transient filesystem/plist read errors per app bundle
      }
    }
    if (bestVariantEntry && !addedTypes.has(variant.id)) {
      addedTypes.add(variant.id);
      layers.push(bestVariantEntry.layer);
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

  // Standalone community Wine managers on macOS (Whisky, Sikarugir, Kegworks, Mythic)
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

  for (const [engineDirRel, engineLabel, engineRank] of /** @type {Array<[string, string, number]>} */ ([
    ['Library/Application Support/Sikarugir/Engines', 'Open-Source Wine (Sikarugir)', 340],
    ['Library/Application Support/Kegworks/Engines', 'Open-Source Wine (Kegworks)', 330],
  ])) {
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
 * (`Heroic`, or standalone managers `(Whisky, Sikarugir, Kegworks, Mythic)`).
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
  if (
    combined.includes('Library/Application Support/Kegworks/Engines') ||
    combined.includes('Open-Source Wine (Kegworks)')
  ) {
    return 'Sikarugir';
  }
  if (/Sikarugir/i.test(combined)) return 'Sikarugir';
  if (/Mythic/i.test(combined)) return 'Mythic';
  return null;
}

/** @type {Set<(event: any) => void>} */
const compatRunnerProgressListeners = new Set();

/** @type {Map<string, { operation: 'install' | 'update', controller: AbortController, promise: Promise<any> }>} */
const activeCompatRunnerOps = new Map();

/**
 * Subscribe to real-time compatibility runner install/update progress events.
 *
 * @param {(event: any) => void} listener
 * @returns {() => boolean}
 */
function onCompatibilityRunnerProgress(listener) {
  if (typeof listener === 'function') {
    compatRunnerProgressListeners.add(listener);
  }
  return () => compatRunnerProgressListeners.delete(listener);
}

/**
 * Emit a compatibility runner progress event to in-process listeners, `options.onRunnerProgress`,
 * and all open Electron `BrowserWindow` instances (`'launcher:compat-runner-progress'`).
 *
 * @param {Record<string, any>} event
 * @param {Record<string, any>} [options]
 */
function emitCompatibilityRunnerProgress(event, options = {}) {
  if (!event || typeof event !== 'object') return;
  const normalized = {
    runnerType: event.runnerType,
    operation: event.operation === 'update' ? 'update' : 'install',
    phase: event.phase || 'probing',
    progressPercent:
      typeof event.progressPercent === 'number' ? event.progressPercent : null,
    ...(typeof event.bytesDownloaded === 'number'
      ? { bytesDownloaded: event.bytesDownloaded }
      : {}),
    ...(typeof event.totalBytes === 'number' ? { totalBytes: event.totalBytes } : {}),
    message: String(event.message || ''),
    ...(event.error ? { error: String(event.error) } : {}),
    updatedAt: event.updatedAt || new Date().toISOString(),
  };

  for (const listener of compatRunnerProgressListeners) {
    try {
      listener(normalized);
    } catch {}
  }

  if (typeof options.onRunnerProgress === 'function') {
    try {
      options.onRunnerProgress(normalized);
    } catch {}
  }

  if (options._skipBroadcastCompatRunnerIpc !== true) {
    try {
      /** @type {Set<any>} */
      const targetWindows = new Set();
      const electronMod = getElectron();
      const BrowserWindow = electronMod?.BrowserWindow;
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win) targetWindows.add(win);
        }
      }
      if (typeof getMainWindow === 'function') {
        const mainWin = getMainWindow();
        if (mainWin) targetWindows.add(mainWin);
      }
      for (const win of targetWindows) {
        if (
          win &&
          (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) &&
          win.webContents &&
          (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed()) &&
          typeof win.webContents.send === 'function'
        ) {
          win.webContents.send('launcher:compat-runner-progress', normalized);
        }
      }
    } catch {}
  }
}

/**
 * Cancel an active background install or update operation for `runnerType`.
 *
 * @param {string} runnerType
 * @returns {{ success: boolean, cancelled: boolean }}
 */
function cancelCompatibilityLayerOperation(runnerType) {
  const cleanRunnerType = String(runnerType || '')
    .trim()
    .toLowerCase();
  if (!cleanRunnerType) {
    return { success: false, cancelled: false };
  }
  const activeEntry = activeCompatRunnerOps.get(cleanRunnerType);
  if (!activeEntry) {
    return { success: true, cancelled: false };
  }
  try {
    activeEntry.controller.abort();
  } catch {}
  emitCompatibilityRunnerProgress({
    runnerType: cleanRunnerType,
    operation: activeEntry.operation,
    phase: 'cancelled',
    progressPercent: null,
    message: 'Compatibility runner operation cancelled.',
  });
  return { success: true, cancelled: true };
}

/**
 * Open a native macOS file picker restricted to runner installer archives (`.zip`, `.dmg`, `.tar.xz`, `.txz`).
 *
 * @param {string} [defaultPath]
 * @param {Record<string, any>} [options]
 * @returns {Promise<string | null>}
 */
async function selectRunnerArchiveDialog(defaultPath, options = {}) {
  /** @type {Record<string, any>} */
  const dialogOptions = {
    title: 'Select Compatibility Runner Installer Archive',
    buttonLabel: 'Select Archive',
    properties: ['openFile'],
    filters: [
      {
        name: 'Runner Installer Archive',
        extensions: ['zip', 'dmg', 'xz', 'txz'],
      },
    ],
  };
  if (typeof defaultPath === 'string' && defaultPath.trim() && !defaultPath.includes('\0')) {
    dialogOptions.defaultPath = toLocalFsPath(defaultPath.trim());
  }

  if (typeof options.showOpenDialogFn === 'function') {
    const mockRes = await options.showOpenDialogFn(dialogOptions);
    if (!mockRes || mockRes.canceled || !Array.isArray(mockRes.filePaths) || !mockRes.filePaths[0]) {
      return null;
    }
    return String(mockRes.filePaths[0]);
  }

  const electronMod = getElectron();
  const dialog = electronMod?.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    return null;
  }
  const BrowserWindow = electronMod?.BrowserWindow;
  const focusedWin =
    BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function'
      ? BrowserWindow.getFocusedWindow()
      : null;
  const res = focusedWin
    ? await dialog.showOpenDialog(focusedWin, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (!res || res.canceled || !Array.isArray(res.filePaths) || !res.filePaths[0]) {
    return null;
  }
  return String(res.filePaths[0]);
}

async function checkCompatibilityLayerUpdates(/** @type {any} */ options = {}) {
  const layers = Array.isArray(options.layers)
    ? options.layers
    : detectCompatibilityLayers(options);
  const runnerTypes = ['crossover', 'crossover_preview', 'gptk', 'wine'];
  /** @type {Record<string, string>} */
  const defaultDownloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://github.com/Gcenx/game-porting-toolkit/releases/latest',
    wine: 'https://github.com/Gcenx/macOS_Wine_builds/releases/latest',
  };

  const hostArch = String(options?.arch || process.arch || 'arm64');
  const darwinKernelMajor =
    options?.darwinKernelMajor !== undefined
      ? Number(options.darwinKernelMajor)
      : typeof options?.osRelease === 'string' && options.osRelease.trim()
        ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
        : process.platform === 'darwin'
          ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
          : 24;
  const isGptkDirectSupported = hostArch === 'arm64' && darwinKernelMajor >= 23;

  const isAllowedCodeWeaversFeedUrl = (/** @type {string} */ rawUrl) => {
    try {
      const parsed = new URL(String(rawUrl || '').trim());
      const host = parsed.hostname.toLowerCase();
      if (
        options.allowLoopbackInstallerUrls === true &&
        (host === '127.0.0.1' || host === 'localhost')
      ) {
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      }
      if (parsed.protocol !== 'https:') return false;
      return (
        host === 'codeweavers.com' ||
        host === 'www.codeweavers.com' ||
        host === 'media.codeweavers.com'
      );
    } catch {
      return false;
    }
  };

  const parseSparkleEnclosureFeed = (
    /** @type {string} */ xml,
    /** @type {string} */ fallbackDownloadUrl
  ) => {
    const encMatch = xml.match(/<enclosure\b([^>]*)>/i);
    if (!encMatch) return null;
    const attrs = encMatch[1];
    const verMatch = attrs.match(/\bsparkle:version=["']([^"']+)["']/i);
    const shortMatch = attrs.match(/\bsparkle:shortVersionString=["']([^"']+)["']/i);
    const urlMatch = attrs.match(/\burl=["']([^"']+)["']/i);
    const lenMatch = attrs.match(/\blength=["'](\d+)["']/i);
    const edSigMatch = attrs.match(/\bsparkle:edSignature=["']([^"']+)["']/i);
    const rawBundleVer = verMatch ? verMatch[1].trim() : '';
    const rawShortVer = shortMatch ? shortMatch[1].trim() : '';
    const parsedLength = lenMatch ? Number.parseInt(lenMatch[1], 10) : 0;
    const semverMatch = rawBundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
    const isPreviewDateShortVer = /^\d{8}$/.test(rawShortVer) && Boolean(semverMatch);
    const latestVersion = semverMatch
      ? semverMatch[1]
      : rawShortVer || rawBundleVer || undefined;
    const latestBuildVersion = isPreviewDateShortVer
      ? rawBundleVer || rawShortVer
      : semverMatch && semverMatch[2]
        ? `Build ${semverMatch[2]}`
        : undefined;
    const latestDisplayVersion = isPreviewDateShortVer
      ? `${semverMatch?.[1]} (Preview ${rawShortVer})`
      : latestVersion && latestBuildVersion
        ? `${latestVersion} (${latestBuildVersion})`
        : latestVersion;
    if (!latestVersion) return null;
    const candidateUrl = urlMatch ? urlMatch[1].trim() : '';
    const safeUrl =
      candidateUrl && isAllowedCodeWeaversFeedUrl(candidateUrl)
        ? candidateUrl
        : fallbackDownloadUrl;
    return {
      latestVersion,
      rawBundleVersion: rawBundleVer || undefined,
      latestBuildVersion,
      latestDisplayVersion,
      downloadUrl: safeUrl,
      hasDirectEnclosureUrl: Boolean(candidateUrl && isAllowedCodeWeaversFeedUrl(candidateUrl)),
      ...(parsedLength > 0 ? { estimatedDownloadBytes: parsedLength } : {}),
      ...(edSigMatch ? { sparkleEdSignature: edSigMatch[1].trim() } : {}),
    };
  };

  /** @type {Record<string, any>} */
  const feedMap = {};
  const defaultTimeoutMs = Number(options.timeoutMs || 4500);
  if (options.mockFeeds && typeof options.mockFeeds === 'object') {
    for (const rt of runnerTypes) {
      if (options.mockFeeds[rt]) {
        feedMap[rt] = { ...options.mockFeeds[rt] };
      }
    }
  } else if (
    typeof options.httpGetText === 'function' ||
    typeof options.fetchFn === 'function' ||
    (!options.homedir && !options.skipNetwork)
  ) {
    const fetchWithTimeout = async (/** @type {string} */ url, timeoutMs = defaultTimeoutMs) => {
      if (typeof options.httpGetText === 'function') {
        try {
          return await options.httpGetText(url);
        } catch {
          return null;
        }
      }
      const fetchImpl =
        typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;
      if (typeof fetchImpl !== 'function') return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
      try {
        const res = await fetchImpl(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'OneGameLauncher/1.0' },
        });
        if (!res || !res.ok) return null;
        return await res.text();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    const wineLayer = layers.find((/** @type {any} */ l) => l.type === 'wine');
    const gptkLayer = layers.find((/** @type {any} */ l) => l.type === 'gptk');
    const previewLayer = layers.find((/** @type {any} */ l) => l.type === 'crossover_preview');

    await Promise.all([
      (async () => {
        const xml = await fetchWithTimeout('https://www.codeweavers.com/xml/versions/cxmac.xml');
        if (xml) {
          const parsed = parseSparkleEnclosureFeed(xml, defaultDownloadUrls.crossover);
          if (parsed) {
            const { hasDirectEnclosureUrl: _unused, ...rest } = parsed;
            feedMap.crossover = {
              ...rest,
              updateMethod: 'direct_download',
            };
          }
        }
      })(),
      (async () => {
        if (!previewLayer?.appPath) return;
        const plistDict = parsePlistStringValues(
          path.join(previewLayer.appPath, 'Contents/Info.plist')
        );
        const rawSuFeedUrl = String(options.previewFeedUrl || plistDict.SUFeedURL || '').trim();
        const rawSuPubKey = String(plistDict.SUPublicEDKey || '').trim();
        if (!rawSuFeedUrl || !isAllowedCodeWeaversFeedUrl(rawSuFeedUrl)) return;
        const xml = await fetchWithTimeout(rawSuFeedUrl);
        if (!xml) return;
        const parsed = parseSparkleEnclosureFeed(xml, defaultDownloadUrls.crossover_preview);
        if (parsed && parsed.hasDirectEnclosureUrl) {
          const { hasDirectEnclosureUrl: _unused, ...rest } = parsed;
          feedMap.crossover_preview = {
            ...rest,
            feedUrl: rawSuFeedUrl,
            ...(rawSuPubKey ? { sparklePublicEdKey: rawSuPubKey } : {}),
            canAutoUpdate: true,
            updateMethod: 'direct_download',
          };
        }
      })(),
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
              const assets = Array.isArray(json.assets) ? json.assets : [];
              const archiveAsset =
                assets.find((/** @type {any} */ a) =>
                  /\.(?:tar\.xz|txz)$/i.test(String(a?.name || ''))
                ) ||
                assets.find((/** @type {any} */ a) => /\.dmg$/i.test(String(a?.name || '')));
              const assetBytes =
                typeof archiveAsset?.size === 'number' && archiveAsset.size > 0
                  ? archiveAsset.size
                  : undefined;
              const externalGptkMgr = getExternalManagerForLayer(gptkLayer);
              feedMap.gptk = {
                latestVersion: rawVer.replace(/[-_]/g, '.'),
                latestBuildVersion: rawVer,
                latestDisplayVersion: rawVer,
                downloadUrl:
                  (isGptkDirectSupported && archiveAsset?.browser_download_url) ||
                  json.html_url ||
                  defaultDownloadUrls.gptk,
                ...(assetBytes ? { estimatedDownloadBytes: assetBytes } : {}),
                updateMethod:
                  !externalGptkMgr && isHomebrewManagedLayer(gptkLayer)
                    ? 'homebrew_cask'
                    : isGptkDirectSupported
                      ? 'direct_download'
                      : 'vendor_portal',
              };
            }
          } catch {}
        }
      })(),
      (async () => {
        const wineBinStr = String(wineLayer?.binaryPath || '').replace(/\\/g, '/');
        const wineAppStr = String(wineLayer?.appPath || '').replace(/\\/g, '/');
        const wineNameStr = String(wineLayer?.name || '');
        const wineCombinedStr = `${wineNameStr} ${wineAppStr} ${wineBinStr}`;

        const isRetiredWineCrossOver =
          Boolean(wineLayer) && /wine[-_\s]*crossover/i.test(wineCombinedStr);
        if (isRetiredWineCrossOver) {
          return;
        }

        const externalWineMgr = getExternalManagerForLayer(wineLayer);
        const explicitWineChan = String(options.wineChannel || '')
          .trim()
          .toLowerCase();
        const wineChannel =
          explicitWineChan === 'staging' ||
          explicitWineChan === 'devel' ||
          explicitWineChan === 'stable'
            ? explicitWineChan
            : /wine[-_\s]*staging/i.test(wineCombinedStr)
              ? 'staging'
              : /wine[-_\s]*devel/i.test(wineCombinedStr)
                ? 'devel'
                : 'stable';

        const caskFeedUrl =
          wineChannel === 'staging'
            ? 'https://formulae.brew.sh/api/cask/wine@staging.json'
            : wineChannel === 'devel'
              ? 'https://formulae.brew.sh/api/cask/wine@devel.json'
              : 'https://formulae.brew.sh/api/cask/wine-stable.json';
        const assetNameRe =
          wineChannel === 'staging'
            ? /wine[-_]?staging.*\.(?:tar\.xz|txz|dmg)$/i
            : wineChannel === 'devel'
              ? /wine[-_]?devel.*\.(?:tar\.xz|txz|dmg)$/i
              : /wine[-_]?stable.*\.(?:tar\.xz|txz|dmg)$/i;

        const [caskTxt, ghListTxt] = await Promise.all([
          fetchWithTimeout(caskFeedUrl),
          fetchWithTimeout(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20'
          ),
        ]);

        /** @type {Record<string, any> | null} */
        let caskCandidate = null;
        if (caskTxt) {
          try {
            const json = JSON.parse(caskTxt);
            if (json && json.version) {
              const rawVer = String(json.version).split(',')[0].trim();
              if (rawVer) {
                caskCandidate = {
                  latestVersion: rawVer.replace(/[-_]/g, '.'),
                  latestBuildVersion: rawVer,
                  latestDisplayVersion: rawVer,
                  downloadUrl: json.url || defaultDownloadUrls.wine,
                };
              }
            }
          } catch {}
        }

        /** @type {Record<string, any> | null} */
        let ghCandidate = null;
        const parseGhReleaseItem = (/** @type {any} */ rel, allowTagFallback = false) => {
          if (!rel || rel.draft) return null;
          const assets = Array.isArray(rel.assets) ? rel.assets : [];
          const matchedAsset = assets.find((/** @type {any} */ a) =>
            assetNameRe.test(String(a?.name || ''))
          );
          if (!matchedAsset && !allowTagFallback) return null;
          const tag = String(rel.tag_name || rel.name || matchedAsset?.name || '');
          const m = tag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
          const rawVer = m ? m[1] : tag.replace(/^v/i, '').trim();
          if (!rawVer) return null;
          return {
            latestVersion: rawVer.replace(/[-_]/g, '.'),
            latestBuildVersion: rawVer,
            latestDisplayVersion: rawVer,
            downloadUrl:
              matchedAsset?.browser_download_url || rel.html_url || defaultDownloadUrls.wine,
            ...(typeof matchedAsset?.size === 'number' && matchedAsset.size > 0
              ? { estimatedDownloadBytes: matchedAsset.size }
              : {}),
          };
        };

        if (ghListTxt) {
          try {
            const rels = JSON.parse(ghListTxt);
            const relArray = Array.isArray(rels) ? rels : [rels];
            for (const rel of relArray) {
              const parsedRel = parseGhReleaseItem(rel, false);
              if (parsedRel) {
                ghCandidate = parsedRel;
                break;
              }
            }
          } catch {}
        }

        if (!ghCandidate) {
          const ghLatestTxt = await fetchWithTimeout(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest'
          );
          if (ghLatestTxt) {
            try {
              const latestObj = JSON.parse(ghLatestTxt);
              const hasAssetsArray =
                Array.isArray(latestObj?.assets) && latestObj.assets.length > 0;
              ghCandidate = parseGhReleaseItem(latestObj, !hasAssetsArray);
            } catch {}
          }
        }

        const chosenWineFeed = (() => {
          if (caskCandidate && ghCandidate) {
            const cmp = compareRunnerVersions(
              caskCandidate.latestVersion,
              ghCandidate.latestVersion
            );
            if (cmp < 0) return ghCandidate;
            if (cmp > 0) return caskCandidate;
            return {
              ...caskCandidate,
              ...ghCandidate,
            };
          }
          return ghCandidate || caskCandidate;
        })();

        if (chosenWineFeed) {
          feedMap.wine = {
            ...chosenWineFeed,
            updateMethod:
              !externalWineMgr && isHomebrewManagedLayer(wineLayer)
                ? 'homebrew_cask'
                : 'direct_download',
          };
        }
      })(),
    ]);
  }

  const checkedAt = new Date().toISOString();
  /** @type {Record<string, any>} */
  const results = {};

  for (const runnerType of runnerTypes) {
    const layer = layers.find((/** @type {any} */ l) => l.type === runnerType);
    const feed = feedMap[runnerType] || {};
    const stableFeed = feedMap.crossover;
    const externalMgr = getExternalManagerForLayer(layer);
    const isRetiredWineCrossOver =
      runnerType === 'wine' &&
      Boolean(layer) &&
      /wine[-_\s]*crossover/i.test(
        `${layer?.binaryPath || ''} ${layer?.appPath || ''} ${layer?.name || ''}`
      );
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
    if (layer && layer.version && !isRetiredWineCrossOver) {
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

    /** @type {'homebrew_cask' | 'direct_download' | 'vendor_portal' | 'external_manager'} */
    let updateMethod;
    let canAutoUpdate = true;

    if (isRetiredWineCrossOver) {
      updateMethod = 'vendor_portal';
      canAutoUpdate = false;
    } else if (runnerType === 'crossover_preview') {
      if (
        feed.canAutoUpdate === true ||
        feed.updateMethod === 'direct_download' ||
        stableSurpassesPreview ||
        (Boolean(layer) && updateAvailable)
      ) {
        updateMethod = 'direct_download';
        canAutoUpdate = true;
      } else {
        updateMethod = feed.updateMethod || 'vendor_portal';
        canAutoUpdate = Boolean(feed.canAutoUpdate === true);
      }
    } else if (runnerType === 'gptk') {
      if (!externalMgr && isHomebrewManagedLayer(layer)) {
        updateMethod = 'homebrew_cask';
        canAutoUpdate = true;
      } else if (isGptkDirectSupported) {
        updateMethod = 'direct_download';
        canAutoUpdate = true;
      } else {
        updateMethod = 'vendor_portal';
        canAutoUpdate = false;
      }
    } else if (runnerType === 'crossover') {
      updateMethod = 'direct_download';
      canAutoUpdate = true;
    } else {
      updateMethod =
        !externalMgr && isHomebrewManagedLayer(layer) ? 'homebrew_cask' : 'direct_download';
      canAutoUpdate = true;
    }

    const statusMessage = !layer
      ? 'Not installed'
      : isRetiredWineCrossOver
        ? `Retired Wine-CrossOver build (${layer.displayVersion || layer.version || 'Installed'})`
        : updateAvailable
          ? `Update available: ${latestDisplayVersion || latestVersion}`
          : `Up to date (${layer.displayVersion || layer.version || 'Installed'})`;

    const downloadUrl =
      runnerType === 'crossover_preview' &&
      !feed.canAutoUpdate &&
      stableSurpassesPreview &&
      stableFeed?.downloadUrl
        ? stableFeed.downloadUrl
        : feed.downloadUrl || defaultDownloadUrls[runnerType];
    const estimatedDownloadBytes =
      runnerType === 'crossover_preview' &&
      !feed.canAutoUpdate &&
      stableSurpassesPreview &&
      typeof stableFeed?.estimatedDownloadBytes === 'number'
        ? stableFeed.estimatedDownloadBytes
        : typeof feed.estimatedDownloadBytes === 'number'
          ? feed.estimatedDownloadBytes
          : undefined;

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
      downloadUrl,
      ...(estimatedDownloadBytes ? { estimatedDownloadBytes } : {}),
      canAutoUpdate,
      updateMethod,
      ...(runnerType === 'crossover_preview'
        ? {
            stableSurpassesPreview,
            ...(stableSurpassesPreview && (stableFeed?.latestDisplayVersion || stableFeed?.latestVersion)
              ? {
                  stableFallbackVersion:
                    stableFeed.latestDisplayVersion || stableFeed.latestVersion,
                }
              : {}),
          }
        : {}),
      statusMessage,
      checkedAt,
    };
  }

  return results;
}

async function updateCompatibilityLayer(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  const runnerType = String(payload.runnerType || 'crossover')
    .toLowerCase()
    .trim();

  if (options._bypassSingleFlight !== true && activeCompatRunnerOps.has(runnerType)) {
    const existingOp = activeCompatRunnerOps.get(runnerType);
    if (existingOp) {
      return existingOp.promise;
    }
  }

  const controller = new AbortController();
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const runPromise = (async () => {
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

    const {
      installRunnerDirect,
      assertRunnerSafeToReplace,
    } = require('./environmentProvisioner.cjs');

    const effectiveSafetyRunnerType =
      runnerType === 'crossover_preview' && payload.switchToStableCrossOver === true
        ? 'crossover'
        : runnerType;
    const safetyTargetLayer =
      beforeLayers.find((l) => l.type === effectiveSafetyRunnerType) || beforeLayer || null;
    const safetyRes = await assertRunnerSafeToReplace(
      effectiveSafetyRunnerType,
      safetyTargetLayer?.appPath || null,
      safetyTargetLayer,
      options
    );
    if (!safetyRes.ok) {
      emitCompatibilityRunnerProgress(
        {
          runnerType,
          operation: 'update',
          phase: 'failed',
          progressPercent: null,
          message: safetyRes.error || 'Runner is currently busy.',
          error: safetyRes.error,
        },
        options
      );
      return {
        success: false,
        runnerType,
        updated: false,
        previousVersion,
        ...(safetyRes.busyCode ? { busyCode: safetyRes.busyCode } : {}),
        error: safetyRes.error,
        message: safetyRes.error || 'Runner is currently busy.',
        detectedLayers: beforeLayers,
      };
    }

    /** @type {Record<string, string>} */
    const defaultUpdateUrls = {
      crossover: 'https://www.codeweavers.com/crossover/download',
      crossover_preview: 'https://www.codeweavers.com/preview/download',
      gptk: 'https://github.com/Gcenx/game-porting-toolkit/releases/latest',
      wine: 'https://github.com/Gcenx/macOS_Wine_builds/releases/latest',
    };

    const localArchivePath =
      typeof payload.archivePath === 'string' && payload.archivePath.trim()
        ? payload.archivePath.trim()
        : typeof options.archivePath === 'string' && options.archivePath.trim()
          ? options.archivePath.trim()
          : '';
    const localDmgPath =
      typeof payload.dmgPath === 'string' && payload.dmgPath.trim()
        ? payload.dmgPath.trim()
        : typeof options.dmgPath === 'string' && options.dmgPath.trim()
          ? options.dmgPath.trim()
          : '';
    const hasLocalInstaller = Boolean(localArchivePath || localDmgPath);

    const brewCandidates = [
      options.brewBinaryPath,
      path.join(homedir, 'homebrew/bin/brew'),
      ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
    ].filter(Boolean);
    const brewPath = brewCandidates.find((p) => fs.existsSync(p));

    const beforeCombinedStr = `${beforeLayer?.name || ''} ${beforeLayer?.appPath || ''} ${beforeLayer?.binaryPath || ''}`.replace(
      /\\/g,
      '/'
    );
    const isWineStagingApp = Boolean(beforeLayer && /wine[-_\s]*staging/i.test(beforeCombinedStr));
    const isWineDevelApp = Boolean(beforeLayer && /wine[-_\s]*devel/i.test(beforeCombinedStr));
    const externalMgr = getExternalManagerForLayer(beforeLayer);

    /** @type {Record<string, string>} */
    const caskMap = {
      crossover: 'crossover',
      wine: isWineStagingApp ? 'wine@staging' : isWineDevelApp ? 'wine@devel' : 'wine-stable',
      gptk: 'game-porting-toolkit',
    };
    const caskName = caskMap[runnerType];
    let updatedViaBrew = false;
    let usedMockBrewHook = false;

    const shouldAttemptHomebrewUpdate =
      Boolean(caskName) &&
      !hasLocalInstaller &&
      payload.switchToStableCrossOver !== true &&
      !externalMgr &&
      (typeof options.onExecBrew === 'function' || Boolean(options.brewBinaryPath));

    if (shouldAttemptHomebrewUpdate && typeof options.onExecBrew === 'function') {
      const args = [
        'upgrade',
        '--cask',
        ...(runnerType === 'wine' ? ['--no-quarantine'] : []),
        caskName,
      ];
      try {
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'installing',
            progressPercent: null,
            message: `Upgrading ${caskName} via Homebrew...`,
          },
          options
        );
        await options.onExecBrew(brewPath || '/opt/homebrew/bin/brew', args);
        updatedViaBrew = true;
        usedMockBrewHook = true;
      } catch {}
    } else if (shouldAttemptHomebrewUpdate && brewPath) {
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
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'installing',
              progressPercent: null,
              message: `Upgrading ${caskName} via Homebrew...`,
            },
            options
          );
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

    const hostArch = String(options?.arch || process.arch || 'arm64');
    const darwinKernelMajor =
      options?.darwinKernelMajor !== undefined
        ? Number(options.darwinKernelMajor)
        : typeof options?.osRelease === 'string' && options.osRelease.trim()
          ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
          : process.platform === 'darwin'
            ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
            : 24;

    const canRunDirectInCurrentEnv =
      hasLocalInstaller ||
      typeof options.capturePreviewDownloadFn === 'function' ||
      options.allowInteractivePreviewCapture === true ||
      !isTestEnvironment(options) ||
      options.allowDirectVendorInstall === true ||
      typeof options.fetchFn === 'function' ||
      typeof options.mockDirectDownload === 'function';

    const isDirectUpdateCapable =
      runnerType === 'crossover' ||
      runnerType === 'wine' ||
      (runnerType === 'gptk' &&
        (hasLocalInstaller || (hostArch === 'arm64' && darwinKernelMajor >= 23))) ||
      (runnerType === 'crossover_preview' &&
        (hasLocalInstaller ||
          payload.switchToStableCrossOver === true ||
          options.skipNetwork !== true));

    if (!updatedViaBrew && canRunDirectInCurrentEnv && isDirectUpdateCapable) {
      try {
        const directRes = await installRunnerDirect(runnerType, {
          ...options,
          ...(localDmgPath ? { dmgPath: localDmgPath } : {}),
          ...(localArchivePath ? { archivePath: localArchivePath } : {}),
          ...(payload.switchToStableCrossOver === true ? { switchToStableCrossOver: true } : {}),
          existingLayer: safetyTargetLayer,
          _runnerOperation: 'update',
          _suppressWizardProgressBroadcast: true,
          _runnerProgressMeta: { runnerType, operation: 'update' },
          signal: controller.signal,
          onRunnerProgress: (/** @type {any} */ evt) =>
            emitCompatibilityRunnerProgress(evt, {
              ...options,
              onRunnerProgress: options.onRunnerProgress,
            }),
        });

        const didSwitchToStable =
          payload.switchToStableCrossOver === true ||
          Boolean(directRes && directRes.switchedToStableCrossOver);
        const detectedLayers = detectCompatibilityLayers(options);
        const targetAfterType =
          runnerType === 'crossover_preview' && didSwitchToStable
            ? 'crossover'
            : runnerType;
        const afterLayer =
          detectedLayers.find((l) => l.type === targetAfterType) ||
          detectedLayers.find((l) => l.type === runnerType);
        const newVersion = afterLayer?.version || directRes?.version || undefined;
        const updates = await checkCompatibilityLayerUpdates({
          ...options,
          layers: detectedLayers,
        });

        if (directRes && directRes.openedExternal) {
          return {
            success: true,
            runnerType,
            updated: false,
            previousVersion,
            newVersion,
            openedExternalUrl: true,
            message: directRes.message,
            detectedLayers,
            updateInfo: updates[runnerType],
          };
        }

        const successMsg = didSwitchToStable
          ? `Successfully installed CrossOver Stable ${newVersion || ''}`.trim() + '.'
          : `Successfully updated ${afterLayer?.name || runnerType} to ${newVersion || 'latest version'}.`;

        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'completed',
            progressPercent: 100,
            message: successMsg,
          },
          options
        );

        return {
          success: true,
          runnerType,
          updated: Boolean(directRes && directRes.installed),
          previousVersion,
          newVersion,
          openedExternalUrl: false,
          message: successMsg,
          detectedLayers,
          updateInfo: updates[runnerType],
        };
      } catch (err) {
        const isCancelled =
          controller.signal.aborted ||
          (err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError');
        const detectedLayers = detectCompatibilityLayers(options);
        if (isCancelled) {
          const cancelMsg = 'Compatibility runner update cancelled.';
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'update',
              phase: 'cancelled',
              progressPercent: null,
              message: cancelMsg,
            },
            options
          );
          return {
            success: false,
            cancelled: true,
            runnerType,
            updated: false,
            previousVersion,
            message: cancelMsg,
            detectedLayers,
          };
        }
        if (options.throwOnError === true) {
          throw err;
        }
        const errObj = /** @type {any} */ (err);
        const errMsg = err instanceof Error ? err.message : String(err);
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'update',
            phase: 'failed',
            progressPercent: null,
            message: errMsg,
            error: errMsg,
          },
          options
        );
        return {
          success: false,
          runnerType,
          updated: false,
          previousVersion,
          ...(errObj?.busyCode ? { busyCode: errObj.busyCode } : {}),
          error: errMsg,
          message: errMsg,
          detectedLayers,
        };
      }
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
    const updated = usedMockBrewHook
      ? Boolean(versionChanged || updatedViaBrew)
      : versionChanged;

    if (updated) {
      emitCompatibilityRunnerProgress(
        {
          runnerType,
          operation: 'update',
          phase: 'completed',
          progressPercent: 100,
          message: `Successfully updated ${runnerType} to ${newVersion || 'latest version'}.`,
        },
        options
      );
    }

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
  })();

  activeCompatRunnerOps.set(runnerType, {
    operation: 'update',
    controller,
    promise: runPromise,
  });

  try {
    return await runPromise;
  } finally {
    const cur = activeCompatRunnerOps.get(runnerType);
    if (cur && cur.promise === runPromise) {
      activeCompatRunnerOps.delete(runnerType);
    }
  }
}

/**
 * Safely mount a macOS .dmg archive via hdiutil attach, copy any .app bundle inside asynchronously
 * via `/usr/bin/ditto` (preserving `.framework` symlinks & code signatures without freezing IPC),
 * strip quarantine attributes, and guarantee hdiutil detach runs inside a finally block.
 */
async function mountAndExtractDmgSafe(dmgPath, targetDestDir, /** @type {any} */ options = {}) {
  const mountPoint = path.join(
    os.tmpdir(),
    `ol-dmg-mount-${process.pid}-${Date.now()}`
  );
  const execFileFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const execHdiutil =
    typeof options.onExecHdiutil === 'function'
      ? options.onExecHdiutil
      : (/** @type {string[]} */ args) =>
          new Promise((resolve, reject) => {
            execFileFn(
              'hdiutil',
              args,
              { timeout: 120000 },
              (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                if (err) reject(err);
                else resolve({ stdout, stderr });
              }
            );
          });

  const copyMacAppBundleAsync = async (/** @type {string} */ srcApp, /** @type {string} */ destApp) => {
    if (typeof options.onExecDitto === 'function') {
      await options.onExecDitto(srcApp, destApp);
      return;
    }
    const canUseDitto =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';
    if (canUseDitto) {
      await new Promise((resolve, reject) => {
        execFileFn(
          '/usr/bin/ditto',
          [srcApp, destApp],
          { timeout: 300000 },
          (/** @type {any} */ err) => {
            if (err) reject(err);
            else resolve(true);
          }
        );
      });
      return;
    }
    await fs.promises.cp(srcApp, destApp, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  };

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
      await fs.promises.mkdir(targetDestDir, { recursive: true });
      const entries = await fs.promises.readdir(mountPoint);
      const appEntry = entries.find((e) => e.toLowerCase().endsWith('.app'));
      if (appEntry) {
        const srcApp = path.join(mountPoint, appEntry);
        const destApp = path.join(targetDestDir, appEntry);
        await copyMacAppBundleAsync(srcApp, destApp);
        await clearMacQuarantineAsync(destApp, { ...options, force: true });
        if (options.gameId || options.store || options.writeManagedSentinel) {
          writeManagedInstallSentinel(targetDestDir, {
            store: options.store || options.platformId || 'custom',
            gameId: options.gameId || options.platformGameId || appEntry,
            installKind: 'mac-dmg-pkg',
          });
        }
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

async function installCompatibilityLayer(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  const runnerType = String(payload.runnerType || 'crossover')
    .toLowerCase()
    .trim();
  const mode = String(payload.mode || 'auto')
    .toLowerCase()
    .trim();

  /** @type {Record<string, string>} */
  const downloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://github.com/Gcenx/game-porting-toolkit/releases/latest',
    wine: 'https://github.com/Gcenx/macOS_Wine_builds/releases/latest',
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

  if (options._bypassSingleFlight !== true && activeCompatRunnerOps.has(runnerType)) {
    const existingOp = activeCompatRunnerOps.get(runnerType);
    if (existingOp) {
      return existingOp.promise;
    }
  }

  const controller = new AbortController();
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const runPromise = (async () => {
    const homedir = options.homedir || os.homedir();
    const beforeLayers = detectCompatibilityLayers(options);
    const beforeLayer = beforeLayers.find((l) => l.type === runnerType) || null;

    const {
      installRunnerDirect,
      assertRunnerSafeToReplace,
    } = require('./environmentProvisioner.cjs');

    const safetyRes = await assertRunnerSafeToReplace(
      runnerType,
      beforeLayer?.appPath || null,
      beforeLayer,
      options
    );
    if (!safetyRes.ok) {
      emitCompatibilityRunnerProgress(
        {
          runnerType,
          operation: 'install',
          phase: 'failed',
          progressPercent: null,
          message: safetyRes.error || 'Runner is currently busy.',
          error: safetyRes.error,
        },
        options
      );
      return {
        success: false,
        installed: false,
        runnerType,
        ...(safetyRes.busyCode ? { busyCode: safetyRes.busyCode } : {}),
        error: safetyRes.error,
        message: safetyRes.error || 'Runner is currently busy.',
        layers: beforeLayers,
      };
    }

    const archivePath =
      typeof payload.archivePath === 'string' && payload.archivePath.trim()
        ? payload.archivePath.trim()
        : typeof options.archivePath === 'string' && options.archivePath.trim()
          ? options.archivePath.trim()
          : '';
    const dmgPath =
      typeof payload.dmgPath === 'string' && payload.dmgPath.trim()
        ? payload.dmgPath.trim()
        : typeof options.dmgPath === 'string' && options.dmgPath.trim()
          ? options.dmgPath.trim()
          : '';
    const hasLocalInstaller = Boolean(archivePath || dmgPath);

    const brewCandidates = [
      options.brewBinaryPath,
      path.join(homedir, 'homebrew/bin/brew'),
      ...(!options.homedir ? ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'] : []),
    ].filter(Boolean);
    const brewPath = brewCandidates.find((p) => fs.existsSync(p));

    const shouldTryHomebrewInstall =
      !hasLocalInstaller &&
      mode !== 'direct' &&
      (mode === 'brew' ||
        typeof options.onExecBrew === 'function' ||
        Boolean(options.brewBinaryPath)) &&
      (brewPath || typeof options.onExecBrew === 'function') &&
      (runnerType === 'crossover' || runnerType === 'wine');

    if (shouldTryHomebrewInstall) {
      const args =
        runnerType === 'crossover'
          ? ['install', '--cask', 'crossover']
          : ['install', '--cask', '--no-quarantine', 'wine-stable'];
      try {
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'install',
            phase: 'installing',
            progressPercent: null,
            message: `Installing ${runnerType} via Homebrew...`,
          },
          options
        );
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
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'completed',
              progressPercent: 100,
              message: 'Successfully installed via Homebrew!',
            },
            options
          );
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

    const hostArch = String(options?.arch || process.arch || 'arm64');
    const darwinKernelMajor =
      options?.darwinKernelMajor !== undefined
        ? Number(options.darwinKernelMajor)
        : typeof options?.osRelease === 'string' && options.osRelease.trim()
          ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
          : process.platform === 'darwin'
            ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
            : 24;

    const canRunDirectInCurrentEnv =
      hasLocalInstaller ||
      typeof options.capturePreviewDownloadFn === 'function' ||
      options.allowInteractivePreviewCapture === true ||
      !isTestEnvironment(options) ||
      options.allowDirectVendorInstall === true ||
      typeof options.fetchFn === 'function' ||
      typeof options.mockDirectDownload === 'function';

    const isDirectInstallCapable =
      runnerType === 'crossover' ||
      runnerType === 'wine' ||
      (runnerType === 'gptk' &&
        (hasLocalInstaller || (hostArch === 'arm64' && darwinKernelMajor >= 23))) ||
      (runnerType === 'crossover_preview' &&
        (hasLocalInstaller ||
          typeof options.capturePreviewDownloadFn === 'function' ||
          options.allowInteractivePreviewCapture === true ||
          !isTestEnvironment(options) ||
          options.allowDirectVendorInstall === true));

    const shouldTryDirectInstall =
      mode === 'direct' ||
      ((mode === 'auto' || mode === 'brew') &&
        typeof options.onExecBrew !== 'function' &&
        canRunDirectInCurrentEnv &&
        isDirectInstallCapable);

    if (shouldTryDirectInstall) {
      try {
        const directRes = await installRunnerDirect(runnerType, {
          ...options,
          ...(dmgPath ? { dmgPath } : {}),
          ...(archivePath ? { archivePath } : {}),
          existingLayer: beforeLayer,
          _runnerOperation: 'install',
          _suppressWizardProgressBroadcast: true,
          _runnerProgressMeta: { runnerType, operation: 'install' },
          signal: controller.signal,
          onRunnerProgress: (/** @type {any} */ evt) =>
            emitCompatibilityRunnerProgress(evt, {
              ...options,
              onRunnerProgress: options.onRunnerProgress,
            }),
        });
        if (directRes && directRes.installed) {
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'completed',
              progressPercent: 100,
              message: directRes.message,
            },
            options
          );
          return {
            success: true,
            installed: true,
            runnerType,
            installedPath: directRes.installedPath,
            message: directRes.message,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (directRes && directRes.openedExternal) {
          return {
            success: true,
            openedExternalInstaller: true,
            runnerType,
            message: directRes.message,
            layers: detectCompatibilityLayers(options),
          };
        }
      } catch (err) {
        const isCancelled =
          controller.signal.aborted ||
          (err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError');
        if (isCancelled) {
          const cancelMsg = 'Compatibility runner installation cancelled.';
          emitCompatibilityRunnerProgress(
            {
              runnerType,
              operation: 'install',
              phase: 'cancelled',
              progressPercent: null,
              message: cancelMsg,
            },
            options
          );
          return {
            success: false,
            cancelled: true,
            installed: false,
            runnerType,
            message: cancelMsg,
            layers: detectCompatibilityLayers(options),
          };
        }
        if (options.throwOnError === true) {
          throw err;
        }
        const errObj = /** @type {any} */ (err);
        const errMsg = err instanceof Error ? err.message : String(err);
        emitCompatibilityRunnerProgress(
          {
            runnerType,
            operation: 'install',
            phase: 'failed',
            progressPercent: null,
            message: errMsg,
            error: errMsg,
          },
          options
        );
        if (
          mode === 'direct' ||
          hasLocalInstaller ||
          typeof options.capturePreviewDownloadFn === 'function' ||
          options.allowInteractivePreviewCapture === true ||
          !isTestEnvironment(options) ||
          options.allowDirectVendorInstall === true ||
          typeof options.fetchFn === 'function'
        ) {
          return {
            success: false,
            installed: false,
            runnerType,
            ...(errObj?.busyCode ? { busyCode: errObj.busyCode } : {}),
            error: errMsg,
            message: errMsg,
            layers: detectCompatibilityLayers(options),
          };
        }
      }
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
  })();

  activeCompatRunnerOps.set(runnerType, {
    operation: 'install',
    controller,
    promise: runPromise,
  });

  try {
    return await runPromise;
  } finally {
    const cur = activeCompatRunnerOps.get(runnerType);
    if (cur && cur.promise === runPromise) {
      activeCompatRunnerOps.delete(runnerType);
    }
  }
}

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
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

function doesWineLayerHaveMoltenVkHudDeadlock(wineBinary) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return false;

  const normalizedBin = path.resolve(binPath);
  const dylibPath = resolveWineLayerMoltenVkPath(normalizedBin);
  if (!dylibPath) {
    return false;
  }

  let cacheKey = normalizedBin;
  try {
    const st = fs.statSync(dylibPath);
    cacheKey = `${path.resolve(dylibPath)}:${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return false;
  }

  if (moltenVkHudDeadlockCache.has(cacheKey)) {
    return moltenVkHudDeadlockCache.get(cacheKey);
  }

  const needle = Buffer.from('_GLOBAL__sub_I_mvk_datatypes.mm', 'utf8');
  const chunkSize = 64 * 1024;
  const overlap = needle.length;
  let hasDeadlock = false;
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(dylibPath, 'r');
    const chunkBuf = Buffer.allocUnsafe(chunkSize + overlap);
    let carryBytes = 0;
    let filePos = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, chunkBuf, carryBytes, chunkSize, filePos);
      if (bytesRead <= 0) break;
      const windowEnd = carryBytes + bytesRead;
      if (chunkBuf.subarray(0, windowEnd).includes(needle)) {
        hasDeadlock = true;
        break;
      }
      filePos += bytesRead;
      if (bytesRead < chunkSize) break;
      carryBytes = Math.min(overlap, windowEnd);
      chunkBuf.copy(chunkBuf, 0, windowEnd - carryBytes, windowEnd);
    }
    setBoundedMapEntry(moltenVkHudDeadlockCache, cacheKey, hasDeadlock, 128);
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  return hasDeadlock;
}

/**
 * Ensure the universal (`arm64` + `x86_64`) `libone_metal_preload.dylib` helper exists on a real
 * filesystem path outside `app.asar` so `dyld` can load it via `DYLD_INSERT_LIBRARIES` or `CX_ENV`.
 */
function ensureWineMetalPreloadDylib(/** @type {any} */ options = {}) {
  const electronRoot = path.resolve(__dirname, '..');
  const unpackedElectronRoot = electronRoot.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const unpackedDylib = path.join(unpackedElectronRoot, 'helpers', 'libone_metal_preload.dylib');
  const bundledDylib = path.join(electronRoot, 'helpers', 'libone_metal_preload.dylib');

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

  return null;
}

/** @type {Map<string, string>} */
const liveBottleMsyncByPrefix = new Map();

/**
 * Parse shell-quoted `KEY=VALUE` assignments compatible with Perl `Text::ParseWords::shellwords`
 * (`bin/wine:722` `$ENV{CX_ENV}`).
 *
 * @param {string} rawCxEnv
 * @returns {Array<{ key: string, rawToken: string }>}
 */
function parseCxEnvShellwordTokens(rawCxEnv) {
  const str = String(rawCxEnv || '').trim();
  if (!str) return [];
  /** @type {Array<{ key: string, rawToken: string }>} */
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i += 1;
    if (i >= str.length) break;
    const start = i;
    let unquoted = '';
    let quoteChar = '';
    while (i < str.length) {
      const ch = str[i];
      if (quoteChar) {
        if (ch === '\\' && quoteChar === '"' && i + 1 < str.length) {
          unquoted += str[i + 1];
          i += 2;
          continue;
        }
        if (ch === quoteChar) {
          quoteChar = '';
          i += 1;
          continue;
        }
        unquoted += ch;
        i += 1;
      } else {
        if (/\s/.test(ch)) break;
        if (ch === '"' || ch === "'") {
          quoteChar = ch;
          i += 1;
          continue;
        }
        if (ch === '\\' && i + 1 < str.length) {
          unquoted += str[i + 1];
          i += 2;
          continue;
        }
        unquoted += ch;
        i += 1;
      }
    }
    const rawToken = str.slice(start, i);
    const eqIdx = unquoted.indexOf('=');
    const key = eqIdx > 0 ? unquoted.slice(0, eqIdx).trim() : '';
    tokens.push({ key, rawToken });
  }
  return tokens;
}

/**
 * Format a `KEY="VALUE"` token safe for Perl `Text::ParseWords::shellwords` (`$ENV{CX_ENV}`).
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function formatCxEnvAssignmentToken(key, value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

/**
 * Merge `KEY=VALUE` assignments into CrossOver's `CX_ENV` string (`bin/wine:722`), updating
 * matching keys idempotently while preserving any existing user `CX_ENV` assignments.
 *
 * @param {string | undefined} existingCxEnv
 * @param {Record<string, string | undefined | null>} updates
 * @returns {string}
 */
function mergeCxEnvVariables(existingCxEnv, updates = {}) {
  const parsed = parseCxEnvShellwordTokens(existingCxEnv || '');
  const updateEntries = Object.entries(updates).filter(
    ([k, v]) => k && typeof v === 'string' && v.length > 0
  );
  if (updateEntries.length === 0) {
    return parsed.map((t) => t.rawToken).join(' ');
  }
  const updateMap = new Map(
    updateEntries.map(([k, v]) => [k, formatCxEnvAssignmentToken(k, String(v))])
  );
  const seen = new Set();
  const outTokens = [];
  for (const tok of parsed) {
    if (tok.key && updateMap.has(tok.key)) {
      if (!seen.has(tok.key)) {
        seen.add(tok.key);
        outTokens.push(/** @type {string} */ (updateMap.get(tok.key)));
      }
    } else if (tok.rawToken) {
      outTokens.push(tok.rawToken);
    }
  }
  for (const [k, formatted] of updateMap.entries()) {
    if (!seen.has(k)) {
      seen.add(k);
      outTokens.push(formatted);
    }
  }
  return outTokens.join(' ');
}

/**
 * Derive `<cxRoot>` (`.../Contents/SharedSupport/CrossOver`) from a CrossOver `wine` or `wineloader` binary path.
 *
 * @param {string} wineBinaryPath
 * @returns {string}
 */
function deriveCrossOverRootFromBinaryPath(wineBinaryPath) {
  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') return '';
  const norm = path.resolve(wineBinaryPath);
  const sharedMatch = norm.match(/^(.*\/Contents\/SharedSupport\/CrossOver)(?:\/|$)/i);
  if (sharedMatch && sharedMatch[1]) {
    return sharedMatch[1];
  }
  const binDir = path.dirname(norm);
  if (path.basename(binDir).toLowerCase() === 'bin') {
    return path.dirname(binDir);
  }
  const unixMatch = norm.match(/^(.*)\/lib(?:64)?\/wine\/[^/]+\/wine$/i);
  if (unixMatch && unixMatch[1]) {
    return unixMatch[1];
  }
  return '';
}

/**
 * Align `env.WINEMSYNC` with an already-live `wineserver` in `bottlePath` so helper (`reg.exe`)
 * and game processes never abort inside `msync_init` (`rc=1`) due to client/server sync mismatch.
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} env
 * @param {Record<string, any>} [options]
 * @returns {string | undefined}
 */
function alignWineMsyncWithLiveBottle(bottlePath, env = {}, options = {}) {
  if (!bottlePath || typeof bottlePath !== 'string' || !env || typeof env !== 'object') {
    return env?.WINEMSYNC;
  }
  let canonicalPrefix = path.resolve(bottlePath);
  try {
    if (fs.existsSync(bottlePath)) {
      canonicalPrefix = fs.realpathSync(bottlePath);
    }
  } catch {}

  let isLive = false;
  try {
    const { isBottleWineserverActive } = require('./firstPartyRegistration.cjs');
    isLive = isBottleWineserverActive(bottlePath, options);
  } catch {
    isLive = Boolean(options?.wineserverActive);
  }

  if (!isLive) {
    if (env.WINEMSYNC === '0' || env.WINEMSYNC === '1') {
      setBoundedMapEntry(liveBottleMsyncByPrefix, canonicalPrefix, String(env.WINEMSYNC), 128);
    }
    return env.WINEMSYNC;
  }

  // 1. Check in-memory record of the sync mode used when booting this prefix
  const recorded = liveBottleMsyncByPrefix.get(canonicalPrefix);
  if (recorded === '0' || recorded === '1') {
    env.WINEMSYNC = recorded;
    return recorded;
  }

  // 2. Check Wine server socket directory for msync artifact if running on darwin/linux
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    try {
      const st = fs.statSync(canonicalPrefix);
      const serverFolder = `server-${Number(st.dev).toString(16)}-${Number(st.ino).toString(16)}`;
      const uid = process.getuid();
      for (const tmpRoot of Array.from(new Set(['/tmp', os.tmpdir()]))) {
        const serverDir = path.join(tmpRoot, `.wine-${uid}`, serverFolder);
        if (fs.existsSync(path.join(serverDir, 'msync'))) {
          env.WINEMSYNC = '1';
          setBoundedMapEntry(liveBottleMsyncByPrefix, canonicalPrefix, '1', 128);
          return '1';
        }
      }
    } catch {}
  }

  // 3. Inspect existing `cxbottle.conf` `"WINEMSYNC"` value before any overwrite
  try {
    const cxbottleConfPath = path.join(bottlePath, 'cxbottle.conf');
    if (fs.existsSync(cxbottleConfPath)) {
      const rawConf = fs.readFileSync(cxbottleConfPath, 'utf8');
      const msyncMatch = rawConf.match(/^\s*"WINEMSYNC"\s*=\s*"([01])"/m);
      if (msyncMatch && (msyncMatch[1] === '0' || msyncMatch[1] === '1')) {
        env.WINEMSYNC = msyncMatch[1];
        setBoundedMapEntry(liveBottleMsyncByPrefix, canonicalPrefix, msyncMatch[1], 128);
        return msyncMatch[1];
      }
    }
  } catch {}

  if (!env.WINEMSYNC) {
    env.WINEMSYNC = '1';
  }
  return env.WINEMSYNC;
}

/**
 * Inspect whether a Wine binary is CrossOver's Perl `bin/wine` wrapper, another SIP-interpreter
 * shebang script, or a direct Mach-O `wineloader`, and prepare a SIP-safe & SIP-disabled-safe `env`:
 * - CrossOver Perl `bin/wine` (`#!/usr/bin/perl`, `arm64e`): forwards `DYLD_INSERT_LIBRARIES` and
 *   `WINEDLLOVERRIDES` via `CX_ENV` (`bin/wine:722`), mirrors `WINEDEBUG` into `CX_DEBUGMSG`, and
 *   **always deletes top-level `DYLD_INSERT_LIBRARIES`** so `/usr/bin/perl` never crashes or drops preload.
 * - Direct CrossOver `wineloader` Mach-O: populates `CX_ROOT` and `CX_APPLEGPTK_LIBD3DSHARED_PATH`
 *   so `cxcompatdb.so` never logs `"CX_ROOT not set"`.
 * - Non-CrossOver SIP-shebang Wine scripts: resolves adjacent Mach-O `wineloader`/`wineloader64` if
 *   present, or deletes top-level `DYLD_INSERT_LIBRARIES` if falling back to the SIP script.
 *
 * @param {string} wineBinaryPath
 * @param {Record<string, any>} [env]
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
/** @type {Map<string, boolean>} */
const dyldInsertAllowedCache = new Map();

/**
 * Pure-Node (`0` subprocesses) Mach-O `LC_CODE_SIGNATURE` (`0x1d`) + `CodeDirectory` (`0xfade0c02`)
 * + `CS_MAGIC_ENTITLEMENTS` (`0xfade7171`) inspector that determines whether a Wine / CrossOver
 * loader binary permits `DYLD_INSERT_LIBRARIES` without macOS Hardened Runtime (`0x10000`) rejection.
 *
 * Returns `false` ONLY when the resolved Mach-O loader has Hardened Runtime (`flags & 0x10000`) AND
 * lacks both `com.apple.security.cs.allow-dyld-environment-variables` and `com.apple.security.get-task-allow`.
 * Returns `true` for unsigned binaries, non-hardened binaries, CrossOver loaders with `allow-dyld-environment-variables`,
 * and virtual/synthetic unit-test stubs.
 *
 * @param {string} wineBinaryPath
 * @returns {boolean}
 */
function doesWineLoaderAllowDyldInsert(wineBinaryPath) {
  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') {
    return true;
  }

  let targetPath = wineBinaryPath;
  try {
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return true;
    }
  } catch {
    return true;
  }

  // If wineBinaryPath is a shebang wrapper (e.g. CrossOver Perl bin/wine or #!/bin/sh wine64),
  // resolve the underlying Mach-O wineloader binary to inspect its code signature.
  try {
    const probeFd = fs.openSync(targetPath, 'r');
    const magicProbe = Buffer.alloc(4);
    let readBytes = 0;
    try {
      readBytes = fs.readSync(probeFd, magicProbe, 0, 4, 0);
    } finally {
      try {
        fs.closeSync(probeFd);
      } catch {}
    }
    if (readBytes >= 2 && magicProbe[0] === 0x23 && magicProbe[1] === 0x21) {
      const binDir = path.dirname(path.resolve(targetPath));
      const loaderCandidates = [
        path.resolve(binDir, '..', 'CrossOver-Hosted Application', 'wineloader'),
        path.resolve(binDir, '..', 'CrossOver-Hosted Application', 'wineloader64'),
        path.join(binDir, 'wineloader64'),
        path.join(binDir, 'wineloader'),
        path.join(binDir, 'wine64-preloader'),
        path.resolve(binDir, '..', 'lib64', 'wine', 'x86_64-unix', 'wine'),
        path.resolve(binDir, '..', 'lib', 'wine', 'x86_64-unix', 'wine'),
      ];
      const foundMachO = loaderCandidates.find((cand) => {
        try {
          return fs.existsSync(cand) && inspectMacMachOHeader(cand).isMachO;
        } catch {
          return false;
        }
      });
      if (!foundMachO) {
        return true;
      }
      targetPath = foundMachO;
    }
  } catch {
    return true;
  }

  let cacheKey = targetPath;
  let fileSize = 0;
  try {
    const realTarget = fs.realpathSync(targetPath);
    const st = fs.statSync(realTarget);
    fileSize = st.size;
    cacheKey = `${realTarget}:${Math.trunc(st.mtimeMs)}:${st.size}`;
    targetPath = realTarget;
  } catch {
    return true;
  }

  if (dyldInsertAllowedCache.has(cacheKey)) {
    return /** @type {boolean} */ (dyldInsertAllowedCache.get(cacheKey));
  }

  let allowed = true;
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(targetPath, 'r');
    const headLen = Math.min(fileSize, 16384);
    if (headLen < 32) {
      setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
      return true;
    }
    let sliceOffset = 0;
    let headBuf = Buffer.alloc(headLen);
    const firstRead = fs.readSync(fd, headBuf, 0, headLen, 0);
    if (firstRead < 32) {
      setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
      return true;
    }

    const magicBE = headBuf.readUInt32BE(0);
    if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
      const isFatBE = magicBE === 0xcafebabe;
      const nfat = isFatBE ? headBuf.readUInt32BE(4) : headBuf.readUInt32LE(4);
      if (nfat >= 1 && nfat <= 16 && firstRead >= 8 + nfat * 20) {
        const preferredCpu = process.arch === 'x64' ? 0x01000007 : 0x0100000c;
        let chosenOff = isFatBE ? headBuf.readUInt32BE(16) : headBuf.readUInt32LE(16);
        for (let i = 0; i < nfat; i += 1) {
          const entryOff = 8 + i * 20;
          const cpu = isFatBE
            ? headBuf.readUInt32BE(entryOff)
            : headBuf.readUInt32LE(entryOff);
          const off = isFatBE
            ? headBuf.readUInt32BE(entryOff + 8)
            : headBuf.readUInt32LE(entryOff + 8);
          if (cpu === preferredCpu && off > 0) {
            chosenOff = off;
            break;
          }
        }
        if (chosenOff > 0 && chosenOff + 32 <= fileSize) {
          sliceOffset = chosenOff;
          const sliceReadLen = Math.min(fileSize - sliceOffset, 16384);
          headBuf = Buffer.alloc(sliceReadLen);
          const sr = fs.readSync(fd, headBuf, 0, sliceReadLen, sliceOffset);
          if (sr < 32) {
            setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
            return true;
          }
        }
      }
    }

    const sliceMagicLE = headBuf.readUInt32LE(0);
    const isMachO64LE = sliceMagicLE === 0xfeedfacf;
    const isMachO32LE = sliceMagicLE === 0xfeedface;
    if (!isMachO64LE && !isMachO32LE) {
      setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
      return true;
    }

    const machHeaderSize = isMachO64LE ? 32 : 28;
    const ncmds = headBuf.readUInt32LE(16);
    const sizeofcmds = headBuf.readUInt32LE(20);
    const neededHeaderBytes = machHeaderSize + sizeofcmds;
    if (
      ncmds > 0 &&
      sizeofcmds > 0 &&
      neededHeaderBytes <= 256 * 1024 &&
      sliceOffset + neededHeaderBytes <= fileSize &&
      neededHeaderBytes > headBuf.length
    ) {
      headBuf = Buffer.alloc(neededHeaderBytes);
      fs.readSync(fd, headBuf, 0, neededHeaderBytes, sliceOffset);
    }

    let sigDataOff = 0;
    let sigDataSize = 0;
    let cmdOff = machHeaderSize;
    const maxCmdEnd = Math.min(headBuf.length, machHeaderSize + sizeofcmds);
    for (let i = 0; i < ncmds && cmdOff + 8 <= maxCmdEnd; i += 1) {
      const cmd = headBuf.readUInt32LE(cmdOff);
      const cmdsize = headBuf.readUInt32LE(cmdOff + 4);
      if (cmdsize < 8 || cmdOff + cmdsize > maxCmdEnd) break;
      if (cmd === 0x1d && cmdsize >= 16) {
        sigDataOff = headBuf.readUInt32LE(cmdOff + 8);
        sigDataSize = headBuf.readUInt32LE(cmdOff + 12);
        break;
      }
      cmdOff += cmdsize;
    }

    if (
      sigDataOff > 0 &&
      sigDataSize >= 12 &&
      sigDataSize <= 2 * 1024 * 1024 &&
      sliceOffset + sigDataOff + sigDataSize <= fileSize
    ) {
      const sigBuf = Buffer.alloc(sigDataSize);
      const sigRead = fs.readSync(fd, sigBuf, 0, sigDataSize, sliceOffset + sigDataOff);
      if (sigRead >= 12 && sigBuf.readUInt32BE(0) === 0xfade0cc0) {
        const blobCount = sigBuf.readUInt32BE(8);
        let hasHardenedRuntime = false;
        let hasAllowDyldEntitlement = false;

        for (let b = 0; b < blobCount && 12 + (b + 1) * 8 <= sigRead; b += 1) {
          const blobOff = sigBuf.readUInt32BE(12 + b * 8 + 4);
          if (blobOff + 8 > sigRead) continue;
          const blobMagic = sigBuf.readUInt32BE(blobOff);
          const blobLen = sigBuf.readUInt32BE(blobOff + 4);
          if (blobMagic === 0xfade0c02 && blobOff + 16 <= sigRead) {
            const cdFlags = sigBuf.readUInt32BE(blobOff + 12);
            if ((cdFlags & 0x00010000) !== 0) {
              hasHardenedRuntime = true;
            }
          } else if (blobMagic === 0xfade7171 && blobLen > 8 && blobOff + 8 < sigRead) {
            const entEnd = Math.min(sigRead, blobOff + blobLen);
            const entXml = sigBuf.subarray(blobOff + 8, entEnd).toString('utf8');
            if (
              /<key>\s*com\.apple\.security\.(?:cs\.allow-dyld-environment-variables|get-task-allow)\s*<\/key>\s*<true\s*\/>/i.test(
                entXml
              )
            ) {
              hasAllowDyldEntitlement = true;
            }
          }
        }

        if (hasHardenedRuntime && !hasAllowDyldEntitlement) {
          allowed = false;
        }
      }
    }
  } catch {
    allowed = true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, allowed, 256);
  return allowed;
}

const CX_ENV_MANAGED_FORWARD_KEYS = [
  'WINEDLLOVERRIDES',
  'CX_GRAPHICS_BACKEND',
  'CX_GRAPHICS_BACKEND_VERSION',
  'DXVK_CONFIG_FILE',
  'DXVK_CONFIG',
  'DXVK_STATE_CACHE_PATH',
  'DXVK_LOG_LEVEL',
  'DXVK_LOG_PATH',
  'DXVK_FRAME_RATE',
  'DXVK_HUD',
  'DXMT_CONFIG',
  'DXMT_LOG_LEVEL',
  'DXMT_LOG_PATH',
  'DXMT_METALFX_SPATIAL_SWAPCHAIN',
  'DXMT_ENABLE_NVEXT',
  'D3DM_ENABLE_METALFX',
  'D3DM_MAX_FPS',
  'D3DM_NVNGX_PATH',
  'CX_FWD_COMPAT_GL_CTX',
  'CX_LIBVULKAN',
  'MVK_CONFIG_RESUME_LOST_DEVICE',
  'MVK_CONFIG_LOG_LEVEL',
  'MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS',
  'MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS',
  'MVK_CONFIG_FAST_MATH_ENABLED',
  'MVK_ICD_LIBRARY_PATH',
  'ONE_LAUNCHER_MOLTENVK_PATH',
  'ONE_LAUNCHER_METAL_PRELOAD',
  'ONE_LAUNCHER_AUDIO_BUFFER_CLAMP',
  'ONE_LAUNCHER_AUDIO_RT_THREAD',
  'ONE_LAUNCHER_SUPPRESS_PRELOAD',
  'MTL_HUD_ENABLED',
  'WINEMSYNC',
  'WINEESYNC',
];

function resolveSipSafeWineBinaryAndPreloadEnv(
  wineBinaryPath,
  /** @type {Record<string, any>} */ env = {},
  /** @type {Record<string, any>} */ options = {}
) {
  if (!env || typeof env !== 'object') {
    return wineBinaryPath;
  }

  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') {
    return wineBinaryPath;
  }

  const isCrossOverPathOrBottle =
    /CrossOver/i.test(wineBinaryPath) ||
    Boolean(env.CX_BOTTLE) ||
    options?.layerType === 'crossover' ||
    options?.layerType === 'crossover_preview';
  const looksLikeDirectMachOLoader = /\/(?:wineloader(?:64|2)?|wine64-preloader)$/i.test(
    wineBinaryPath
  );

  let isShebangScript = false;
  let isSipInterpreter = false;
  let fileExistsOnDisk = false;
  try {
    if (fs.existsSync(wineBinaryPath) && fs.statSync(wineBinaryPath).isFile()) {
      fileExistsOnDisk = true;
      const fd = fs.openSync(wineBinaryPath, 'r');
      try {
        const headBuf = Buffer.alloc(128);
        const bytesRead = fs.readSync(fd, headBuf, 0, 128, 0);
        const firstLine = headBuf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] || '';
        const shebangMatch = firstLine.match(/^#!\s*(\/\S+)/);
        if (shebangMatch) {
          isShebangScript = true;
          isSipInterpreter = /^\/(usr\/bin|bin|sbin|usr\/sbin)\//.test(shebangMatch[1]);
        }
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  } catch {}

  const isVirtualCrossOverBinWine =
    !fileExistsOnDisk &&
    !looksLikeDirectMachOLoader &&
    (/\/CrossOver[^/]*\/bin\/wine$/i.test(wineBinaryPath) ||
      (isCrossOverPathOrBottle && /\/bin\/wine$/i.test(wineBinaryPath)));

  // Case 1: CrossOver Perl `bin/wine` wrapper (real SIP-shebang script or virtual CrossOver `bin/wine`)
  if ((isCrossOverPathOrBottle && isSipInterpreter) || isVirtualCrossOverBinWine) {
    /** @type {Record<string, string>} */
    const cxEnvUpdates = {};
    if (
      typeof env.DYLD_INSERT_LIBRARIES === 'string' &&
      env.DYLD_INSERT_LIBRARIES.trim() &&
      doesWineLoaderAllowDyldInsert(wineBinaryPath)
    ) {
      cxEnvUpdates.DYLD_INSERT_LIBRARIES = env.DYLD_INSERT_LIBRARIES.trim();
    }
    for (const fwdKey of CX_ENV_MANAGED_FORWARD_KEYS) {
      const rawVal = env[fwdKey];
      if (typeof rawVal === 'string' && rawVal.trim()) {
        cxEnvUpdates[fwdKey] = rawVal.trim();
      }
    }
    if (Object.keys(cxEnvUpdates).length > 0) {
      env.CX_ENV = mergeCxEnvVariables(env.CX_ENV, cxEnvUpdates);
    }
    // NEVER leave DYLD_INSERT_LIBRARIES in top-level env when invoking #!/usr/bin/perl (arm64e)
    delete env.DYLD_INSERT_LIBRARIES;

    if (typeof env.WINEDEBUG === 'string' && env.WINEDEBUG.trim() && !env.CX_DEBUGMSG) {
      env.CX_DEBUGMSG = env.WINEDEBUG.trim();
    }

    if (fileExistsOnDisk) {
      const binDir = path.dirname(path.resolve(wineBinaryPath));
      const cxWineloaderCandidates = [
        path.join(binDir, 'wineloader64'),
        path.join(binDir, 'wineloader'),
        path.resolve(binDir, '..', 'lib64', 'wine', 'x86_64-unix', 'wine'),
      ];
      const foundLoader = cxWineloaderCandidates.find((p) => {
        try {
          return fs.existsSync(p) && inspectMacMachOHeader(p).isMachO;
        } catch {
          return false;
        }
      });
      if (foundLoader) {
        env.WINELOADER = env.WINELOADER || foundLoader;
      }
    }
    return wineBinaryPath;
  }

  // Case 2: Non-CrossOver SIP-protected interpreter wrapper (e.g. #!/bin/sh wine64 or gameportingtoolkit)
  if (isShebangScript && isSipInterpreter) {
    const wantsDyldInsert =
      typeof env.DYLD_INSERT_LIBRARIES === 'string' && Boolean(env.DYLD_INSERT_LIBRARIES.trim());
    const isGptkWrapperScript = /gameportingtoolkit/i.test(path.basename(wineBinaryPath));
    if (wantsDyldInsert && !isGptkWrapperScript) {
      const binDir = path.dirname(path.resolve(wineBinaryPath));
      const wineRoot = path.resolve(binDir, '..');
      const loaderCandidates = [
        path.join(binDir, 'wineloader64'),
        path.join(binDir, 'wineloader'),
        path.join(binDir, 'wine64-preloader'),
        path.resolve(wineRoot, 'lib', 'wine', 'x86_64-unix', 'wine'),
        path.resolve(wineRoot, 'lib64', 'wine', 'x86_64-unix', 'wine'),
      ];
      for (const cand of loaderCandidates) {
        try {
          if (
            fs.existsSync(cand) &&
            inspectMacMachOHeader(cand).isMachO &&
            doesWineLoaderAllowDyldInsert(cand)
          ) {
            const hasExplicitLibEnv = Boolean(
              env.DYLD_FALLBACK_LIBRARY_PATH && env.WINEDLLPATH
            );
            const derivedLibDirs = [
              path.join(wineRoot, 'lib64'),
              path.join(wineRoot, 'lib'),
            ].filter((d) => fs.existsSync(d));
            const derivedDllDirs = [
              path.join(wineRoot, 'lib64', 'wine'),
              path.join(wineRoot, 'lib', 'wine'),
            ].filter((d) => fs.existsSync(d));
            if (hasExplicitLibEnv || (derivedLibDirs.length > 0 && derivedDllDirs.length > 0)) {
              if (!env.DYLD_FALLBACK_LIBRARY_PATH && derivedLibDirs.length > 0) {
                env.DYLD_FALLBACK_LIBRARY_PATH = `${derivedLibDirs.join(':')}:/usr/lib`;
              }
              if (!env.WINEDLLPATH && derivedDllDirs.length > 0) {
                env.WINEDLLPATH = derivedDllDirs.join(':');
              }
              return cand;
            }
          }
        } catch {}
      }
    }
    // Preserve wrapper script (retaining its GST_PLUGIN_SYSTEM_PATH_1_0 / DYLD_FALLBACK_LIBRARY_PATH)
    // and strip top-level DYLD_INSERT_LIBRARIES so arm64e SIP interpreter never rejects or crashes.
    delete env.DYLD_INSERT_LIBRARIES;
    return wineBinaryPath;
  }

  // Case 3: Direct Mach-O binary (`wineloader` / `wineloader64` / `wine64` / `lib64/wine/.../wine`)
  if (!isShebangScript && fileExistsOnDisk && env.DYLD_INSERT_LIBRARIES) {
    if (!doesWineLoaderAllowDyldInsert(wineBinaryPath)) {
      delete env.DYLD_INSERT_LIBRARIES;
    }
  }

  if (isCrossOverPathOrBottle && !isShebangScript) {
    const cxRoot = deriveCrossOverRootFromBinaryPath(wineBinaryPath);
    if (cxRoot) {
      if (!env.CX_ROOT) {
        env.CX_ROOT = cxRoot;
      }
      const gptkSharedDylib = path.join(
        cxRoot,
        'lib64',
        'apple_gptk',
        'external',
        'libd3dshared.dylib'
      );
      try {
        if (!env.CX_APPLEGPTK_LIBD3DSHARED_PATH && fs.existsSync(gptkSharedDylib)) {
          env.CX_APPLEGPTK_LIBD3DSHARED_PATH = gptkSharedDylib;
        }
      } catch {}
    }
    if (env.ROSETTA_ADVERTISE_AVX === '0') {
      delete env.ROSETTA_ADVERTISE_AVX;
    }
  }

  return wineBinaryPath;
}

/**
 * Alias helper for preparing `env` right before spawning any Wine / CrossOver process
 * (`bin/wine` Perl wrapper or direct `wineloader`), ensuring `DYLD_INSERT_LIBRARIES` is never
 * left in top-level `env` for `#!/usr/bin/perl` and `CX_ENV` / `CX_ROOT` are properly populated.
 *
 * @param {string} wineBinaryPath
 * @param {Record<string, any>} [env]
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function prepareCrossOverWineSpawnEnv(wineBinaryPath, env = {}, options = {}) {
  return resolveSipSafeWineBinaryAndPreloadEnv(wineBinaryPath, env, options);
}

/**
 * Prepare a fully aligned Wine command + environment for helper/bootstrap commands (`reg.exe`,
 * `wineboot`, installer helpers, publisher clients) or game launches targeting `bottlePath`:
 * - Aligns `WINEMSYNC` with any live `wineserver` (`alignWineMsyncWithLiveBottle`).
 * - Applies `resolveSipSafeWineBinaryAndPreloadEnv` (`CX_ENV`, `CX_ROOT`, SIP-safe preload stripping).
 * - Computes `prefixArgs` (`['--dll', env.WINEDLLOVERRIDES]` on CrossOver Perl `bin/wine` when non-GUI suppression is off).
 * - When `suppressGuiDialogs === true`: disables `winemenubuilder.exe`, `mscoree`, `mshtml`,
 *   `MTL_HUD_ENABLED`, `DXVK_HUD`, and `DYLD_INSERT_LIBRARIES`, and sets `ONE_LAUNCHER_SUPPRESS_PRELOAD=1` + `WINEDEBUG=-all`.
 *
 * @param {{
 *   wineBinary: string,
 *   bottlePath?: string,
 *   env?: Record<string, any>,
 *   suppressGuiDialogs?: boolean,
 *   layerType?: string,
 *   wineserverActive?: boolean,
 *   includeDllFlag?: boolean
 * }} params
 * @returns {{ wineBinary: string, prefixArgs: string[], env: Record<string, any> }}
 */
function prepareAlignedBottleWineCommand(params) {
  const src = params && typeof params === 'object' ? params : { wineBinary: '' };
  const rawWineBin = String(src.wineBinary || '');
  const bottlePath = typeof src.bottlePath === 'string' ? src.bottlePath : '';
  /** @type {Record<string, any>} */
  const targetEnv = src.env && typeof src.env === 'object' ? src.env : {};

  if (bottlePath) {
    if (!targetEnv.WINEPREFIX) {
      targetEnv.WINEPREFIX = bottlePath;
    }
    const cxBottleMatch = /\/Bottles\/([^/]+)$/i.exec(bottlePath.replace(/\\/g, '/'));
    if (cxBottleMatch && cxBottleMatch[1] && !targetEnv.CX_BOTTLE) {
      targetEnv.CX_BOTTLE = cxBottleMatch[1];
    }
  }

  if (src.suppressGuiDialogs === true) {
    const existingOverrides = String(targetEnv.WINEDLLOVERRIDES || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const reqDisable of ['winemenubuilder.exe=d', 'mscoree=d', 'mshtml=d']) {
      const dllBase = reqDisable.split('=')[0].toLowerCase();
      if (!existingOverrides.some((tok) => tok.split('=')[0].trim().toLowerCase() === dllBase)) {
        existingOverrides.push(reqDisable);
      }
    }
    targetEnv.WINEDLLOVERRIDES = existingOverrides.join(';');
    delete targetEnv.DYLD_INSERT_LIBRARIES;
    delete targetEnv.MTL_HUD_ENABLED;
    delete targetEnv.DXVK_HUD;
    targetEnv.ONE_LAUNCHER_SUPPRESS_PRELOAD = '1';
    targetEnv.ONE_LAUNCHER_METAL_PRELOAD = '0';
    targetEnv.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP = '0';
    if (!targetEnv.WINEDEBUG) {
      targetEnv.WINEDEBUG = '-all';
    }
  }

  if (bottlePath) {
    alignWineMsyncWithLiveBottle(bottlePath, targetEnv, {
      wineserverActive: src.wineserverActive,
    });
  }

  const resolvedBin = resolveSipSafeWineBinaryAndPreloadEnv(rawWineBin, targetEnv, {
    layerType: src.layerType,
  });

  /** @type {string[]} */
  const prefixArgs =
    src.suppressGuiDialogs !== true &&
    src.includeDllFlag !== false &&
    typeof targetEnv.WINEDLLOVERRIDES === 'string' &&
    Boolean(targetEnv.WINEDLLOVERRIDES.trim()) &&
    /\/bin\/wine$/i.test(String(resolvedBin || '')) &&
    (/CrossOver/i.test(String(resolvedBin || '')) || Boolean(targetEnv.CX_BOTTLE))
      ? ['--dll', targetEnv.WINEDLLOVERRIDES.trim()]
      : [];

  return {
    wineBinary: resolvedBin,
    prefixArgs,
    env: targetEnv,
  };
}

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

async function shutdownWinePrefix(wineBinary, winePrefix, timeoutMs = 3000, extraOptions = {}) {
  const wineserverBin = resolveWineserverBinary(wineBinary);
  if (!wineserverBin || !winePrefix) {
    return false;
  }

  let canonicalPrefix = winePrefix;
  try {
    canonicalPrefix = fs.realpathSync(winePrefix);
  } catch {}

  const bottleName =
    extraOptions && typeof extraOptions.bottleName === 'string' && extraOptions.bottleName.trim()
      ? extraOptions.bottleName.trim()
      : '';
  const execFileImpl =
    extraOptions && typeof extraOptions.execFileFn === 'function'
      ? extraOptions.execFileFn
      : execFile;

  /** @type {Record<string, any>} */
  const prefixEnv = {
    ...process.env,
    WINEPREFIX: canonicalPrefix,
    ...(bottleName ? { CX_BOTTLE: bottleName } : {}),
  };
  delete prefixEnv.DYLD_INSERT_LIBRARIES;

  let isNodeShebangScriptOnWin32 = false;
  if (process.platform === 'win32') {
    try {
      const head = fs.readFileSync(wineserverBin, 'utf8').slice(0, 64);
      isNodeShebangScriptOnWin32 = head.startsWith('#!/usr/bin/env node');
    } catch {}
  }

  const runWineserverFlag = (/** @type {string} */ flag) =>
    new Promise((resolve) => {
      try {
        if (isNodeShebangScriptOnWin32) {
          execFileImpl(
            process.execPath,
            [wineserverBin, flag],
            { env: prefixEnv, timeout: timeoutMs },
            () => resolve(true)
          );
        } else {
          execFileImpl(wineserverBin, [flag], { env: prefixEnv, timeout: timeoutMs }, () =>
            resolve(true)
          );
        }
      } catch {
        resolve(false);
      }
    });

  await runWineserverFlag('-k');
  await runWineserverFlag('-w');
  liveBottleMsyncByPrefix.delete(canonicalPrefix);

  return true;
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
 * Curated OpenGL 1.1–3.2 + WGL extension list (< 1,250 bytes) for legacy 32-bit x86 OpenGL engines
 * whose fixed-size stack/static `GL_EXTENSIONS` / `Com_sprintf` buffers overflow when CrossOver 26+
 * advertises its 10,800+ byte Core-Profile / Apple-Silicon GL extension string.
 */
const LEGACY_32BIT_OPENGL_ENABLED_EXTENSIONS = [
  'GL_ARB_multitexture',
  'GL_ARB_texture_compression',
  'GL_ARB_texture_cube_map',
  'GL_ARB_texture_env_add',
  'GL_ARB_texture_env_combine',
  'GL_ARB_texture_env_dot3',
  'GL_ARB_texture_border_clamp',
  'GL_ARB_texture_mirrored_repeat',
  'GL_ARB_texture_non_power_of_two',
  'GL_ARB_vertex_buffer_object',
  'GL_ARB_vertex_program',
  'GL_ARB_fragment_program',
  'GL_ARB_shader_objects',
  'GL_ARB_vertex_shader',
  'GL_ARB_fragment_shader',
  'GL_ARB_shading_language_100',
  'GL_ARB_framebuffer_object',
  'GL_ARB_depth_texture',
  'GL_ARB_shadow',
  'GL_ARB_multisample',
  'GL_ARB_occlusion_query',
  'GL_ARB_pixel_buffer_object',
  'GL_ARB_draw_buffers',
  'GL_ARB_point_sprite',
  'GL_EXT_bgra',
  'GL_EXT_blend_color',
  'GL_EXT_blend_minmax',
  'GL_EXT_blend_subtract',
  'GL_EXT_blend_func_separate',
  'GL_EXT_compiled_vertex_array',
  'GL_EXT_draw_range_elements',
  'GL_EXT_fog_coord',
  'GL_EXT_multi_draw_arrays',
  'GL_EXT_secondary_color',
  'GL_EXT_separate_specular_color',
  'GL_EXT_shadow_funcs',
  'GL_EXT_stencil_two_side',
  'GL_EXT_stencil_wrap',
  'GL_EXT_texture3D',
  'GL_EXT_texture_compression_s3tc',
  'GL_EXT_texture_edge_clamp',
  'GL_EXT_texture_env_add',
  'GL_EXT_texture_env_combine',
  'GL_EXT_texture_env_dot3',
  'GL_EXT_texture_filter_anisotropic',
  'GL_EXT_texture_lod_bias',
  'GL_EXT_framebuffer_object',
  'GL_EXT_framebuffer_blit',
  'GL_ATI_separate_stencil',
  'GL_NV_texgen_reflection',
  'GL_NV_register_combiners',
  'GL_NV_texture_shader',
  'GL_SGIS_generate_mipmap',
  'GL_SGIS_texture_lod',
  'WGL_ARB_extensions_string',
  'WGL_ARB_pixel_format',
  'WGL_ARB_pbuffer',
  'WGL_ARB_render_texture',
  'WGL_ARB_multisample',
  'WGL_EXT_extensions_string',
  'WGL_EXT_swap_control',
].join(' ');

/**
 * Remove a specific named value from a section inside a Wine `.reg` file if present,
 * and record `"ValueName"=-` in `options.liveSyncAccumulator` (or live `wineserver`) when active.
 *
 * @param {string} regFilePath
 * @param {string} subKeyPath
 * @param {string} valueName
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function removeWineRegNamedValue(regFilePath, subKeyPath, valueName, options = {}) {
  if (!regFilePath || !subKeyPath || !valueName || !fs.existsSync(regFilePath)) {
    return false;
  }
  try {
    const content = fs.readFileSync(regFilePath, 'utf8');
    const normalizedSubKey = subKeyPath
      .trim()
      .replace(/^\\+|\\+$/g, '')
      .replace(/\\+/g, '\\');
    const escapedSec = normalizedSubKey
      .replace(/\\/g, '\\\\')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const secRe = new RegExp(`^\\[${escapedSec}\\](?:\\s+\\d+)?[^\\r\\n]*$`, 'im');
    const match = secRe.exec(content);
    if (!match) return false;

    const secStart = match.index + match[0].length;
    const afterSec = content.slice(secStart);
    const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
    const body = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
    const rest = nextSec ? afterSec.slice(nextSec.index) : '';
    const targetLower = valueName.toLowerCase();
    let removed = false;
    const filteredLines = body.split(/\r?\n/).filter((line) => {
      const kv = line.match(/^\s*"((?:[^"\\]|\\.)+)"\s*=/);
      if (!kv) return true;
      const unescaped = kv[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (unescaped.toLowerCase() === targetLower) {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) return false;
    atomicWriteFileSync(regFilePath, content.slice(0, secStart) + filteredLines.join('\n') + rest);

    /** @type {'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE'} */
    const hiveName =
      path.basename(regFilePath).toLowerCase() === 'user.reg'
        ? 'HKEY_CURRENT_USER'
        : 'HKEY_LOCAL_MACHINE';
    if (options && Array.isArray(options.liveSyncAccumulator)) {
      options.liveSyncAccumulator.push({
        hiveName,
        normalizedSubKey,
        entryPairsOrNullForDelete: [[valueName, { delete: true }]],
      });
    } else if (options && options.bottlePath && options.skipLiveWineRegSync !== true) {
      try {
        const { syncLiveWineRegistryAsync } = require('./firstPartyRegistration.cjs');
        syncLiveWineRegistryAsync(
          options.bottlePath,
          hiveName,
          normalizedSubKey,
          [[valueName, { delete: true }]],
          options
        ).catch(() => {});
      } catch {}
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Compose `;`-delimited `DXMT_CONFIG` / `DXVK_CONFIG` clauses without overwriting existing user clauses.
 *
 * @param {string | undefined | null} existing
 * @param {string | Array<string> | Record<string, string | number | boolean> | undefined | null} additions
 * @param {{ overwriteExisting?: boolean }} [options]
 * @returns {string}
 */
function mergeSemicolonConfigClauses(existing, additions, options = {}) {
  const overwriteExisting = Boolean(options?.overwriteExisting);
  /** @type {Array<{ keyLower: string, clause: string }>} */
  const ordered = [];
  /** @type {Map<string, number>} */
  const keyIndex = new Map();

  const pushClause = (/** @type {string} */ rawClause, /** @type {boolean} */ allowOverwrite) => {
    const trimmed = String(rawClause || '').trim();
    if (!trimmed) return;
    const eqIdx = trimmed.indexOf('=');
    const keyLower = eqIdx > 0 ? trimmed.slice(0, eqIdx).trim().toLowerCase() : trimmed.toLowerCase();
    if (!keyLower) return;
    if (keyIndex.has(keyLower)) {
      if (allowOverwrite) {
        const idx = /** @type {number} */ (keyIndex.get(keyLower));
        ordered[idx] = { keyLower, clause: trimmed };
      }
      return;
    }
    keyIndex.set(keyLower, ordered.length);
    ordered.push({ keyLower, clause: trimmed });
  };

  for (const part of String(existing || '').split(';')) {
    pushClause(part, false);
  }

  if (typeof additions === 'string') {
    for (const part of additions.split(';')) {
      pushClause(part, overwriteExisting);
    }
  } else if (Array.isArray(additions)) {
    for (const item of additions) {
      for (const part of String(item || '').split(';')) {
        pushClause(part, overwriteExisting);
      }
    }
  } else if (additions && typeof additions === 'object') {
    for (const [k, v] of Object.entries(additions)) {
      if (k && v !== undefined && v !== null && String(v).trim() !== '') {
        pushClause(`${k.trim()} = ${String(v).trim()}`, overwriteExisting);
      }
    }
  }

  return ordered.map((entry) => entry.clause).join('; ');
}

/**
 * Detect whether a CrossOver root directory on disk bundles 32-bit DXMT, 32-bit DXVK, and 64-bit D3DMetal.
 * Falls back to `{ has32BitDxmt: true, has32BitDxvk: true, has64BitD3dMetal: true }` when `cxRoot` is virtual
 * in unit tests (i.e. no `lib`/`lib64` backend tree exists on disk).
 *
 * @param {string} cxRoot
 * @param {Record<string, any>} [params]
 */
function detectCrossOverBackendLayerSupport(cxRoot, params = {}) {
  const explicit = params?.layerSupport && typeof params.layerSupport === 'object' ? params.layerSupport : null;
  const layerType = String(params?.chosenLayer?.type || params?.layerType || '')
    .trim()
    .toLowerCase();
  const isStandaloneNonCrossOver = layerType === 'wine' || layerType === 'gptk';
  const bottlePath = String(params?.bottlePath || params?.winePrefix || '').trim();

  let has32BitDxmt = !isStandaloneNonCrossOver;
  let has32BitDxvk = !isStandaloneNonCrossOver;
  let has64BitD3dMetal = layerType !== 'wine';

  if (cxRoot && typeof cxRoot === 'string') {
    try {
      if (fs.existsSync(cxRoot) && fs.statSync(cxRoot).isDirectory()) {
        const probe32Dxmt =
          fs.existsSync(path.join(cxRoot, 'lib', 'dxmt', 'i386-windows', 'd3d11.dll')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'wine', 'i386-windows', 'winemetal.dll'));
        const probe32Dxvk =
          fs.existsSync(path.join(cxRoot, 'lib', 'dxvk', 'i386-windows', 'd3d9.dll')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'dxvk', 'i386-windows', 'd3d11.dll'));
        const probe64D3dMetal =
          fs.existsSync(path.join(cxRoot, 'lib64', 'apple_gptk')) ||
          fs.existsSync(path.join(cxRoot, 'lib', 'external', 'D3DMetal.framework')) ||
          fs.existsSync(path.join(cxRoot, 'lib64', 'external', 'D3DMetal.framework'));
        const hasRealBackendTree =
          probe32Dxmt ||
          probe32Dxvk ||
          probe64D3dMetal ||
          fs.existsSync(path.join(cxRoot, 'lib', 'wine')) ||
          fs.existsSync(path.join(cxRoot, 'lib64', 'wine'));
        if (hasRealBackendTree || isStandaloneNonCrossOver) {
          has32BitDxmt = probe32Dxmt;
          has32BitDxvk = probe32Dxvk;
          has64BitD3dMetal = probe64D3dMetal || (layerType === 'gptk' && !hasRealBackendTree);
        }
      }
    } catch {}
  }

  if (isStandaloneNonCrossOver && bottlePath) {
    try {
      if (fs.existsSync(bottlePath) && fs.statSync(bottlePath).isDirectory()) {
        const syswow64 =
          resolveDriveCPathCaseInsensitive(bottlePath, ['drive_c', 'windows', 'syswow64']) ||
          path.join(bottlePath, 'drive_c', 'windows', 'syswow64');
        if (!has32BitDxmt && fs.existsSync(path.join(syswow64, 'winemetal.dll'))) {
          has32BitDxmt = true;
        }
        if (!has32BitDxvk && fs.existsSync(path.join(syswow64, 'dxvk_config.dll'))) {
          has32BitDxvk = true;
        }
      }
    } catch {}
  }

  if (explicit) {
    if (typeof explicit.has32BitDxmt === 'boolean') has32BitDxmt = explicit.has32BitDxmt;
    if (typeof explicit.has32BitDxvk === 'boolean') has32BitDxvk = explicit.has32BitDxvk;
    if (typeof explicit.has64BitD3dMetal === 'boolean') has64BitD3dMetal = explicit.has64BitD3dMetal;
  }

  return { has32BitDxmt, has32BitDxvk, has64BitD3dMetal };
}

/**
 * Deterministic universal CrossOver graphics backend router driven strictly by PE32/PE32+ header bits,
 * PE import/delay-import tables, UE5 IoStore `.utoc` containers, and on-disk layer layout.
 *
 * @param {Record<string, any>} [params]
 */
function resolveEffectiveCrossOverGraphicsBackend(params = {}) {
  const src =
    params?.capabilities && typeof params.capabilities === 'object'
      ? { ...params.capabilities, ...params }
      : params?.peCapabilities && typeof params.peCapabilities === 'object'
        ? { ...params.peCapabilities, ...params }
        : params || {};

  const rawRequested = String(
    src.requestedBackend ?? src.crossoverGraphicsBackend ?? src.backend ?? 'auto'
  )
    .trim()
    .toLowerCase();
  const normalizedRequested = rawRequested || 'auto';

  const cxRoot =
    typeof src.cxRoot === 'string' && src.cxRoot.trim()
      ? src.cxRoot.trim()
      : deriveCrossOverRootFromBinaryPath(
          String(src.wineBinaryPath || src.chosenLayer?.binaryPath || '')
        );
  const layerSupport = detectCrossOverBackendLayerSupport(cxRoot, src);

  const is32Bit = Boolean(src.is32Bit || src.effectiveMachine === 'x86' || src.isX86);
  const is64Bit = Boolean(
    !is32Bit &&
      (src.is64Bit ||
        src.effectiveMachine === 'x64' ||
        src.effectiveMachine === 'arm64' ||
        src.isX64)
  );
  const isNxCompat = src.isNxCompat === false ? false : Boolean(src.isNxCompat ?? true);
  const importsD3d12 = Boolean(src.importsD3d12);
  const importsD3d11Or10 = Boolean(src.importsD3d11Or10);
  const importsD3d9 = Boolean(src.importsD3d9);
  const importsLegacyD3dOrGl = Boolean(src.importsLegacyD3dOrGl);
  const importsVulkan = Boolean(src.importsVulkan);
  const hasUe5IoStoreContainer = Boolean(src.hasUe5IoStoreContainer);
  const isD3d12Only =
    typeof src.isD3d12Only === 'boolean'
      ? src.isD3d12Only
      : (importsD3d12 || hasUe5IoStoreContainer) &&
        !importsD3d11Or10 &&
        !importsD3d9 &&
        !importsVulkan &&
        !importsLegacyD3dOrGl;

  let effectiveRequested = normalizedRequested;
  /** @type {string | null} */
  let reroutedReason = null;

  // Hard Safety Guard #2: D3DMetal is 64-bit only (`is_d3dmetal_usable() == 0` on PE32).
  // Treat `'d3dmetal'` on `is32Bit` identically to `'auto'` instead of dropping blindly to CGL OpenGL wined3d.
  if (is32Bit && effectiveRequested === 'd3dmetal') {
    effectiveRequested = 'auto';
    reroutedReason = 'pe32_d3dmetal_unsupported';
  }

  // Hard Safety Guard #1: `is32Bit && isNxCompat === false` + `'dxmt'` MUST NEVER allow `'dxmt'`
  // (prevents 100% CPU `dxmt-encode-thr` Rosetta `rwx` infinite hang).
  if (is32Bit && isNxCompat === false && effectiveRequested === 'dxmt') {
    reroutedReason = 'pe32_non_nx_dxmt_hang_guard';
    if (importsD3d11Or10 && layerSupport.has32BitDxvk) {
      return {
        backend: 'dxvk',
        cxGraphicsBackendEnv: 'dxvk',
        direct3dRenderer: null,
        reroutedReason,
        layerSupport,
      };
    }
    return {
      backend: 'wined3d',
      cxGraphicsBackendEnv: 'wined3d',
      direct3dRenderer: importsD3d9 && !importsLegacyD3dOrGl ? 'vulkan' : null,
      reroutedReason,
      layerSupport,
    };
  }

  // Explicit non-auto backend selection
  if (
    effectiveRequested === 'd3dmetal' ||
    effectiveRequested === 'dxmt' ||
    effectiveRequested === 'dxvk' ||
    effectiveRequested === 'wined3d'
  ) {
    let resolvedExplicit = effectiveRequested;
    if (resolvedExplicit === 'dxmt' && is32Bit && !layerSupport.has32BitDxmt) {
      resolvedExplicit = layerSupport.has32BitDxvk ? 'dxvk' : 'wined3d';
      reroutedReason = 'pe32_dxmt_layer_missing';
    } else if (resolvedExplicit === 'dxvk' && is32Bit && !layerSupport.has32BitDxvk) {
      resolvedExplicit = 'wined3d';
      reroutedReason = 'pe32_dxvk_layer_missing';
    } else if (resolvedExplicit === 'd3dmetal' && is64Bit && !layerSupport.has64BitD3dMetal) {
      resolvedExplicit = 'auto';
      reroutedReason = 'pe64_d3dmetal_layer_missing';
    }
    return {
      backend: resolvedExplicit,
      cxGraphicsBackendEnv: resolvedExplicit === 'auto' ? null : resolvedExplicit,
      direct3dRenderer: null,
      reroutedReason,
      layerSupport,
    };
  }

  // Universal `'auto'` Resolution
  if (is32Bit) {
    if (importsD3d11Or10 && isNxCompat !== false) {
      if (layerSupport.has32BitDxmt) {
        return {
          backend: 'dxmt',
          cxGraphicsBackendEnv: 'dxmt',
          direct3dRenderer: null,
          reroutedReason,
          layerSupport,
        };
      }
      if (layerSupport.has32BitDxvk) {
        return {
          backend: 'dxvk',
          cxGraphicsBackendEnv: 'dxvk',
          direct3dRenderer: null,
          reroutedReason: reroutedReason || 'pe32_dxmt_layer_missing',
          layerSupport,
        };
      }
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: 'vulkan',
        reroutedReason: reroutedReason || 'pe32_dxmt_dxvk_missing',
        layerSupport,
      };
    }

    if (importsD3d11Or10 && isNxCompat === false) {
      if (layerSupport.has32BitDxvk) {
        return {
          backend: 'dxvk',
          cxGraphicsBackendEnv: 'dxvk',
          direct3dRenderer: null,
          reroutedReason,
          layerSupport,
        };
      }
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: 'vulkan',
        reroutedReason: reroutedReason || 'pe32_dxvk_layer_missing',
        layerSupport,
      };
    }

    if (importsD3d9 && !importsD3d11Or10 && !importsLegacyD3dOrGl) {
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: 'vulkan',
        reroutedReason,
        layerSupport,
      };
    }

    if (importsLegacyD3dOrGl) {
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: null,
        reroutedReason,
        layerSupport,
      };
    }

    // Packed / dynamically-loaded non-DEP (`isNxCompat === false`) PE32 guard:
    // Pin to `wined3d` rather than leaving `cxGraphicsBackendEnv: null` so CrossOver `cxcompatdb`
    // can never auto-select `dxmt` and trigger Rosetta's `WINE_SIMULATE_WRITECOPY` encode hang.
    if (isNxCompat === false) {
      return {
        backend: 'wined3d',
        cxGraphicsBackendEnv: 'wined3d',
        direct3dRenderer: null,
        reroutedReason: reroutedReason || 'pe32_non_nx_dxmt_hang_guard',
        layerSupport,
      };
    }
  }

  if (is64Bit && isD3d12Only && layerSupport.has64BitD3dMetal) {
    return {
      backend: 'd3dmetal',
      cxGraphicsBackendEnv: 'd3dmetal',
      direct3dRenderer: null,
      reroutedReason,
      layerSupport,
    };
  }

  return {
    backend: 'auto',
    cxGraphicsBackendEnv: null,
    direct3dRenderer: null,
    reroutedReason,
    layerSupport,
  };
}

const NON_APFS_APPLEDOUBLE_FS_TYPES = new Set([
  'exfat',
  'msdos',
  'fat',
  'fat32',
  'vfat',
  'ntfs',
  'ntfs-3g',
  'tuxera_ntfs',
  'ufsd_ntfs',
  'smbfs',
  'cifs',
  'udf',
]);

/** @type {{ ts: number, raw: string }} */
let cachedDarwinMountTable = { ts: 0, raw: '' };

function getCachedDarwinMountTableOutput() {
  const now = Date.now();
  if (cachedDarwinMountTable.raw && now - cachedDarwinMountTable.ts < 5000) {
    return cachedDarwinMountTable.raw;
  }
  try {
    const out = execFileSync('/sbin/mount', [], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cachedDarwinMountTable = { ts: now, raw: String(out || '') };
    return cachedDarwinMountTable.raw;
  } catch {
    return '';
  }
}

/**
 * Remove macOS Finder `._<name>` AppleDouble resource-fork twins (`0x00051607`) ONLY on non-APFS/HFS+
 * external/network volumes (`exfat`, `msdos`, `ntfs`, `smbfs`) and ONLY when sibling `<name>` exists.
 * Returns `0` in `< 0.1 ms` on internal APFS `/System/Volumes/Data` paths with zero subprocesses.
 *
 * @param {string} targetDir
 * @param {{ platform?: string, fsType?: string, mountOutput?: string, maxDepth?: number, maxDirs?: number }} [options]
 * @returns {number}
 */
function cleanNonApfsAppleDoubleTwins(targetDir, options = {}) {
  const effectivePlatform = options?.platform || process.platform;
  if (effectivePlatform !== 'darwin' || !targetDir || typeof targetDir !== 'string') {
    return 0;
  }
  let realTargetDir = '';
  try {
    if (!fs.existsSync(targetDir)) return 0;
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return 0;
  }

  // Fast < 0.1 ms short-circuit for internal APFS/HFS+ paths (/Users, /Applications, /System/Volumes/Data, /private/var, etc.)
  if (!options?.fsType && !options?.mountOutput && !realTargetDir.startsWith('/Volumes/')) {
    return 0;
  }

  let fsTypeLower = typeof options?.fsType === 'string' ? options.fsType.trim().toLowerCase() : '';
  if (!fsTypeLower) {
    const mountRaw =
      typeof options?.mountOutput === 'string'
        ? options.mountOutput
        : getCachedDarwinMountTableOutput();
    if (mountRaw) {
      let longestMountLen = -1;
      for (const line of mountRaw.split(/\r?\n/)) {
        const m = line.match(/\son\s+(\/.+?)\s+\(([^,)\s]+)/);
        if (!m) continue;
        const mountPoint = m[1];
        const fstype = m[2].trim().toLowerCase();
        if (
          realTargetDir === mountPoint ||
          realTargetDir.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`)
        ) {
          if (mountPoint.length > longestMountLen) {
            longestMountLen = mountPoint.length;
            fsTypeLower = fstype;
          }
        }
      }
    }
  }

  if (!fsTypeLower || !NON_APFS_APPLEDOUBLE_FS_TYPES.has(fsTypeLower)) {
    return 0;
  }

  const maxDepth = Number.isFinite(options?.maxDepth)
    ? Math.max(0, Number(options.maxDepth))
    : 5;
  const maxDirs = Number.isFinite(options?.maxDirs)
    ? Math.max(1, Number(options.maxDirs))
    : 200;

  let removedCount = 0;
  let visitedDirs = 0;
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: realTargetDir, depth: 0 }];

  while (queue.length > 0 && visitedDirs < maxDirs) {
    const current = queue.shift();
    if (!current) break;
    visitedDirs += 1;

    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const exactNames = new Set();
    const lowerNames = new Set();
    for (let i = 0; i < entries.length; i += 1) {
      const nm = entries[i].name;
      exactNames.add(nm);
      lowerNames.add(nm.toLowerCase());
    }

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!entry.name.startsWith('._') && current.depth < maxDepth && visitedDirs < maxDirs) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('._') || entry.name.length <= 2) {
        continue;
      }
      const baseSibling = entry.name.slice(2);
      if (!exactNames.has(baseSibling) && !lowerNames.has(baseSibling.toLowerCase())) {
        continue;
      }
      const twinPath = path.join(current.dir, entry.name);
      /** @type {number | null} */
      let fd = null;
      let isAppleDouble = false;
      try {
        fd = fs.openSync(twinPath, 'r');
        const magicBuf = Buffer.alloc(4);
        const bytesRead = fs.readSync(fd, magicBuf, 0, 4, 0);
        isAppleDouble = bytesRead === 4 && magicBuf.readUInt32BE(0) === 0x00051607;
      } catch {
        isAppleDouble = false;
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
      }
      if (isAppleDouble) {
        try {
          fs.unlinkSync(twinPath);
          removedCount += 1;
        } catch {}
      }
    }
  }

  return removedCount;
}

function applyCrossOverPerGameSettings(
  /** @type {any} */ chosenLayerOrBottlePath,
  /** @type {any} */ launchConfig = {},
  /** @type {any} */ envOrOptions = {},
  /** @type {any} */ bottlePath = '',
  /** @type {any} */ options = {}
) {
  const isStringBottleFirstArg = typeof chosenLayerOrBottlePath === 'string';
  const isSecondArgExeString = isStringBottleFirstArg && typeof launchConfig === 'string';
  const effectiveOptions = isSecondArgExeString
    ? bottlePath && typeof bottlePath === 'object'
      ? bottlePath
      : options && typeof options === 'object'
        ? options
        : {}
    : isStringBottleFirstArg
      ? envOrOptions && typeof envOrOptions === 'object'
        ? envOrOptions
        : {}
      : options && typeof options === 'object'
        ? options
        : {};
  const chosenLayer = isStringBottleFirstArg
    ? { type: effectiveOptions.isPreviewRunner ? 'crossover_preview' : 'crossover' }
    : chosenLayerOrBottlePath;
  /** @type {Record<string, any>} */
  const env = isStringBottleFirstArg
    ? {}
    : envOrOptions && typeof envOrOptions === 'object'
      ? envOrOptions
      : {};
  const effectiveBottlePathArg = isStringBottleFirstArg
    ? chosenLayerOrBottlePath
    : typeof bottlePath === 'string'
      ? bottlePath
      : '';
  const explicitExeNameFromArg = isSecondArgExeString ? launchConfig.trim() : '';

  const cfg = isSecondArgExeString
    ? envOrOptions && typeof envOrOptions === 'object'
      ? envOrOptions
      : {}
    : launchConfig && typeof launchConfig === 'object'
      ? launchConfig
      : {};
  const requestedBackend =
    typeof cfg.crossoverGraphicsBackend === 'string'
      ? cfg.crossoverGraphicsBackend.toLowerCase().trim()
      : undefined;
  const d3dmVer =
    typeof cfg.crossoverD3DMetalVersion === 'string'
      ? cfg.crossoverD3DMetalVersion.toLowerCase().trim()
      : undefined;

  const candidateWineBin =
    (chosenLayer && typeof chosenLayer === 'object' && chosenLayer.binaryPath) ||
    effectiveOptions.wineBinary ||
    '';

  const peCapsSrc =
    (effectiveOptions.peCapabilities && typeof effectiveOptions.peCapabilities === 'object'
      ? effectiveOptions.peCapabilities
      : null) ||
    (effectiveOptions.effectiveCaps && typeof effectiveOptions.effectiveCaps === 'object'
      ? effectiveOptions.effectiveCaps
      : null) ||
    (cfg.peCapabilities && typeof cfg.peCapabilities === 'object' ? cfg.peCapabilities : null);
  const hasPeCaps = Boolean(
    peCapsSrc ||
      typeof effectiveOptions.is32Bit === 'boolean' ||
      typeof effectiveOptions.is64Bit === 'boolean' ||
      typeof effectiveOptions.isD3d12Only === 'boolean'
  );
  const peCaps = peCapsSrc || effectiveOptions;

  const resolvedBottlePath = effectiveBottlePathArg || env.WINEPREFIX || '';

  const backendRoute = resolveEffectiveCrossOverGraphicsBackend({
    requestedBackend: requestedBackend || 'auto',
    chosenLayer,
    wineBinaryPath: candidateWineBin,
    bottlePath: resolvedBottlePath,
    cxRoot: effectiveOptions.cxRoot,
    layerSupport: effectiveOptions.layerSupport,
    ...(hasPeCaps
      ? {
          is32Bit: Boolean(peCaps.is32Bit || peCaps.effectiveMachine === 'x86'),
          is64Bit: Boolean(
            peCaps.is64Bit ||
              peCaps.effectiveMachine === 'x64' ||
              peCaps.effectiveMachine === 'arm64'
          ),
          isLargeAddressAware: peCaps.isLargeAddressAware,
          isNxCompat: peCaps.isNxCompat,
          importsD3d12: Boolean(peCaps.importsD3d12),
          importsD3d11Or10: Boolean(peCaps.importsD3d11Or10),
          importsD3d9: Boolean(peCaps.importsD3d9),
          importsLegacyD3dOrGl: Boolean(peCaps.importsLegacyD3dOrGl),
          importsVulkan: Boolean(peCaps.importsVulkan),
          hasUe5IoStoreContainer: Boolean(peCaps.hasUe5IoStoreContainer),
          isD3d12Only: peCaps.isD3d12Only,
        }
      : {}),
  });
  const backend = backendRoute.backend;

  let isBottleDir = false;
  if (resolvedBottlePath && fs.existsSync(resolvedBottlePath)) {
    try {
      isBottleDir = fs.statSync(resolvedBottlePath).isDirectory();
    } catch {}
  }

  const isCrossOverRunner =
    chosenLayer?.type === 'crossover' ||
    chosenLayer?.type === 'crossover_preview' ||
    Boolean(effectiveOptions.isPreviewRunner) ||
    /CrossOver/i.test(String(candidateWineBin || '')) ||
    (isBottleDir && fs.existsSync(path.join(resolvedBottlePath, 'cxbottle.conf')));

  let crossOverMajor = 0;
  const rawLayerVer = String(chosenLayer?.version || effectiveOptions.runnerVersion || '').trim();
  if (rawLayerVer) {
    const parsedMajor = parseInt(rawLayerVer.split('.')[0], 10);
    if (Number.isFinite(parsedMajor) && parsedMajor > 0) {
      crossOverMajor = parsedMajor;
    }
  } else if (isCrossOverRunner && candidateWineBin && fs.existsSync(candidateWineBin)) {
    try {
      const vInfo = extractRunnerVersionInfo(
        chosenLayer?.type || 'crossover',
        candidateWineBin,
        effectiveOptions
      );
      const parsedMajor = parseInt(String(vInfo?.version || '').split('.')[0], 10);
      if (Number.isFinite(parsedMajor) && parsedMajor > 0) {
        crossOverMajor = parsedMajor;
      }
    } catch {}
  }
  const isCrossOver25Plus =
    isCrossOverRunner &&
    (crossOverMajor >= 25 ||
      chosenLayer?.type === 'crossover_preview' ||
      Boolean(effectiveOptions.isPreviewRunner));

  if (backendRoute.cxGraphicsBackendEnv) {
    env.CX_GRAPHICS_BACKEND = backendRoute.cxGraphicsBackendEnv;
    if (!isCrossOver25Plus && backendRoute.cxGraphicsBackendEnv === 'd3dmetal') {
      env.WINED3DMETAL = '1';
    } else if (!cfg.environmentVariables?.WINED3DMETAL) {
      delete env.WINED3DMETAL;
    }
  } else {
    if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND) {
      delete env.CX_GRAPHICS_BACKEND;
    }
    if (!cfg.environmentVariables?.WINED3DMETAL) {
      delete env.WINED3DMETAL;
    }
  }

  const isD3DMetalEligible = !backend || backend === 'auto' || backend === 'd3dmetal';
  const hasMultipleBundledD3dMetal =
    !Array.isArray(chosenLayer?.availableD3DMetalVersions) ||
    chosenLayer.availableD3DMetalVersions.length > 1;
  if (isD3DMetalEligible && (d3dmVer === '3' || d3dmVer === '4') && hasMultipleBundledD3dMetal) {
    env.CX_GRAPHICS_BACKEND_VERSION = d3dmVer;
  } else if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION) {
    delete env.CX_GRAPHICS_BACKEND_VERSION;
  }

  const isPe32Target = Boolean(
    hasPeCaps && (peCaps.is32Bit || peCaps.effectiveMachine === 'x86')
  );
  const isPe32NonLaa = Boolean(
    isPe32Target &&
      peCaps.isLargeAddressAware === false &&
      cfg.forceLargeAddressAware !== true
  );
  const isPe32Laa = Boolean(
    isPe32Target &&
      (peCaps.isLargeAddressAware === true || cfg.forceLargeAddressAware === true)
  );

  const hostArch = String(
    effectiveOptions.arch ||
      chosenLayer?.hostArch ||
      (process.platform === 'darwin' ? process.arch : 'arm64') ||
      'arm64'
  )
    .trim()
    .toLowerCase();
  const rawDarwinMajor =
    effectiveOptions.darwinKernelMajor ??
    chosenLayer?.darwinKernelMajor ??
    (isTestEnvironment(effectiveOptions)
      ? 25
      : process.platform === 'darwin'
        ? Number(String(os.release() || '25.0.0').split('.')[0]) || 25
        : 25);
  const darwinMajor = Number(rawDarwinMajor) || 25;

  const dlssUnsupportedBackend = backend === 'dxvk' || backend === 'wined3d';
  const dlssUnsupportedTarget =
    dlssUnsupportedBackend || isPe32Target || hostArch === 'x64' || darwinMajor < 23;
  const wantMetalFxDlss = cfg.crossoverDlss === true || cfg.metalFxUpscaling === true;
  if (wantMetalFxDlss && !dlssUnsupportedTarget) {
    env.DXMT_ENABLE_NVEXT = '1';
    env.D3DM_ENABLE_METALFX = darwinMajor >= 25 ? '1' : '0';
    if (!isCrossOverRunner && env.D3DM_ENABLE_METALFX === '1' && !env.D3DM_NVNGX_PATH) {
      const wineRootForNgx = candidateWineBin
        ? path.resolve(path.dirname(candidateWineBin), '..')
        : '';
      const ngxDirCandidates = [
        wineRootForNgx ? path.join(wineRootForNgx, 'lib', 'wine', 'x86_64-windows') : '',
        wineRootForNgx ? path.join(wineRootForNgx, 'lib64', 'wine', 'x86_64-windows') : '',
        '/Library/Apple/usr/libexec/oah/libd3dmetal/wine/x86_64-windows',
        '/opt/homebrew/opt/game-porting-toolkit/lib/wine/x86_64-windows',
        '/usr/local/opt/game-porting-toolkit/lib/wine/x86_64-windows',
      ].filter(Boolean);
      for (const ngxDir of ngxDirCandidates) {
        try {
          if (fs.existsSync(path.join(ngxDir, 'nvngx.dll'))) {
            env.D3DM_NVNGX_PATH = ngxDir;
            const curOverrides = String(env.WINEDLLOVERRIDES || '')
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean);
            if (
              !curOverrides.some((tok) => {
                const lhs = tok.split('=')[0].trim().toLowerCase();
                return lhs === 'nvngx' || lhs === 'nvngx,nvapi64';
              })
            ) {
              curOverrides.push('nvngx,nvapi64=n,b');
              env.WINEDLLOVERRIDES = curOverrides.join(';');
            }
            break;
          }
        } catch {}
      }
    }
  } else if (cfg.crossoverDlss === false || (wantMetalFxDlss && dlssUnsupportedTarget)) {
    env.D3DM_ENABLE_METALFX = '0';
    env.DXMT_ENABLE_NVEXT = '0';
  } else {
    if (!cfg.environmentVariables?.D3DM_ENABLE_METALFX) {
      delete env.D3DM_ENABLE_METALFX;
    }
    if (!cfg.environmentVariables?.DXMT_ENABLE_NVEXT) {
      delete env.DXMT_ENABLE_NVEXT;
    }
  }

  if (cfg.wineMsync === false) {
    env.WINEMSYNC = '0';
    if (isCrossOver25Plus) {
      if (!cfg.environmentVariables?.WINEESYNC) delete env.WINEESYNC;
    } else {
      env.WINEESYNC = cfg.wineEsync === false ? '0' : '1';
    }
  } else {
    env.WINEMSYNC = '1';
    if (isCrossOver25Plus) {
      if (!cfg.environmentVariables?.WINEESYNC) delete env.WINEESYNC;
    } else {
      env.WINEESYNC = '0';
    }
  }

  if (isBottleDir) {
    alignWineMsyncWithLiveBottle(resolvedBottlePath, env, effectiveOptions);
  }

  const loaderAllowsDyldInsert =
    !candidateWineBin || doesWineLoaderAllowDyldInsert(candidateWineBin);

  if (cfg.metalHud === true) {
    env.MTL_HUD_ENABLED = '1';
    if (candidateWineBin && doesWineLayerHaveMoltenVkHudDeadlock(candidateWineBin)) {
      if (loaderAllowsDyldInsert) {
        const preloadDylib = ensureWineMetalPreloadDylib(effectiveOptions);
        const moltenVkPath = resolveWineLayerMoltenVkPath(candidateWineBin);
        if (preloadDylib) {
          const existingInsert = String(env.DYLD_INSERT_LIBRARIES || '')
            .split(/:(?![\\/])/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (!existingInsert.includes(preloadDylib)) {
            existingInsert.unshift(preloadDylib);
          }
          env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
          if (moltenVkPath) {
            env.MVK_ICD_LIBRARY_PATH = moltenVkPath;
            env.ONE_LAUNCHER_MOLTENVK_PATH = moltenVkPath;
          }
        } else {
          delete env.MTL_HUD_ENABLED;
          if (
            cfg.dxvkHud !== false &&
            !env.DXVK_HUD &&
            (backend === 'dxvk' || chosenLayer?.type === 'wine')
          ) {
            env.DXVK_HUD = 'devinfo,fps,frametimes';
          }
        }
      } else {
        delete env.MTL_HUD_ENABLED;
        if (
          cfg.dxvkHud !== false &&
          !env.DXVK_HUD &&
          (backend === 'dxvk' || chosenLayer?.type === 'wine')
        ) {
          env.DXVK_HUD = 'devinfo,fps,frametimes';
        }
      }
    }
  } else if (cfg.metalHud === false) {
    delete env.MTL_HUD_ENABLED;
    delete env.ONE_LAUNCHER_MOLTENVK_PATH;
    if (!cfg.environmentVariables?.MVK_ICD_LIBRARY_PATH) {
      delete env.MVK_ICD_LIBRARY_PATH;
    }
    if (env.DYLD_INSERT_LIBRARIES && cfg.audioBufferClamp !== true && !effectiveOptions.enableAudioBufferClamp) {
      const filteredInsert = String(env.DYLD_INSERT_LIBRARIES)
        .split(/:(?![\\/])/)
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith('libone_metal_preload.dylib'));
      if (filteredInsert.length > 0) {
        env.DYLD_INSERT_LIBRARIES = filteredInsert.join(':');
      } else {
        delete env.DYLD_INSERT_LIBRARIES;
      }
    }
  }

  if (cfg.audioBufferClamp === false || effectiveOptions.enableAudioBufferClamp === false) {
    env.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP = '0';
  } else if (cfg.audioBufferClamp === true || effectiveOptions.enableAudioBufferClamp === true) {
    if (loaderAllowsDyldInsert) {
      const preloadDylib = ensureWineMetalPreloadDylib(effectiveOptions);
      if (preloadDylib) {
        const existingInsert = String(env.DYLD_INSERT_LIBRARIES || '')
          .split(/:(?![\\/])/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!existingInsert.includes(preloadDylib)) {
          existingInsert.unshift(preloadDylib);
        }
        env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
        env.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP = '1';
        if (cfg.metalHud !== true && !env.ONE_LAUNCHER_MOLTENVK_PATH) {
          env.ONE_LAUNCHER_METAL_PRELOAD = '0';
        }
      }
    }
  }

  if (cfg.dxvkHud === true) {
    env.DXVK_HUD = env.DXVK_HUD || 'devinfo,fps,frametimes';
  } else if (cfg.dxvkHud === false) {
    delete env.DXVK_HUD;
  }

  if (
    (chosenLayer?.type === 'crossover' || chosenLayer?.type === 'crossover_preview') &&
    env.CX_FWD_COMPAT_GL_CTX === undefined &&
    cfg.environmentVariables?.CX_FWD_COMPAT_GL_CTX === undefined
  ) {
    env.CX_FWD_COMPAT_GL_CTX = '1';
  }

  const explicitAvxCfg =
    typeof cfg.advertiseAvx === 'boolean'
      ? cfg.advertiseAvx
      : typeof cfg.rosettaAdvertiseAvx === 'boolean'
        ? cfg.rosettaAdvertiseAvx
        : cfg.environmentVariables?.ROSETTA_ADVERTISE_AVX;
  applyStrictRosettaAvxEnv(env, explicitAvxCfg, {
    isCrossOverWrapper: effectiveOptions.isCrossOverWrapper,
    wineBinaryPath: candidateWineBin,
    compatLayer: chosenLayer,
    layerType: chosenLayer?.type,
  });

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
  if (isCrossOverRunner && env.WINEDEBUG && !cfg.environmentVariables?.CX_DEBUGMSG) {
    env.CX_DEBUGMSG = String(env.WINEDEBUG);
  }

  // 32-bit DXMT dynamic vertex/constant buffer NoWait guard + MetalFX Spatial Swapchain Upscaling
  if (
    isPe32Target &&
    (backend === 'dxmt' || (backend === 'auto' && Boolean(peCaps.importsD3d11Or10)))
  ) {
    env.DXMT_CONFIG = mergeSemicolonConfigClauses(
      env.DXMT_CONFIG,
      'd3d11.ignoreMapFlagNoWait = True'
    );
  }

  const spatialUpscaleFactor = Number(cfg.metalfxSpatialUpscaleFactor);
  if (
    Number.isFinite(spatialUpscaleFactor) &&
    spatialUpscaleFactor > 1 &&
    (backend === 'dxmt' || backend === 'auto')
  ) {
    if (!cfg.environmentVariables?.DXMT_METALFX_SPATIAL_SWAPCHAIN) {
      env.DXMT_METALFX_SPATIAL_SWAPCHAIN = '1';
    }
    env.DXMT_CONFIG = mergeSemicolonConfigClauses(
      env.DXMT_CONFIG,
      `d3d11.metalSpatialUpscaleFactor = ${spatialUpscaleFactor}`,
      {
        overwriteExisting: !String(cfg.environmentVariables?.DXMT_CONFIG || '').includes(
          'd3d11.metalSpatialUpscaleFactor'
        ),
      }
    );
  } else if (!cfg.environmentVariables?.DXMT_METALFX_SPATIAL_SWAPCHAIN) {
    delete env.DXMT_METALFX_SPATIAL_SWAPCHAIN;
  }

  // 3-Tier Unified-Memory Cap + Multi-Backend FPS Cap + DXVK_CONFIG_FILE Materialization
  const totalRamMB = Math.floor(
    (Number(effectiveOptions.totalMemoryBytes) || os.totalmem()) / (1024 * 1024)
  );
  if (isPe32NonLaa) {
    env.DXVK_CONFIG = mergeSemicolonConfigClauses(
      env.DXVK_CONFIG,
      'd3d9.maxAvailableMemory = 1536; dxgi.maxDeviceMemory = 1536; dxgi.maxSharedMemory = 1536; d3d9.deferSurfaceCreation = True; d3d9.seamlessCubes = True'
    );
  } else if (isPe32Laa && backend === 'dxvk') {
    const pe32LaaDxgiCap = Math.min(3072, Math.max(2048, Math.floor(totalRamMB * 0.45)));
    env.DXVK_CONFIG = mergeSemicolonConfigClauses(
      env.DXVK_CONFIG,
      `d3d9.maxAvailableMemory = 2048; dxgi.maxDeviceMemory = ${pe32LaaDxgiCap}; dxgi.maxSharedMemory = ${pe32LaaDxgiCap}; d3d9.deferSurfaceCreation = True; d3d9.seamlessCubes = True`
    );
  } else if (backend === 'dxvk' && !isPe32Target) {
    const vramCapMB = Math.max(2048, Math.floor(totalRamMB * 0.45));
    env.DXVK_CONFIG = mergeSemicolonConfigClauses(
      env.DXVK_CONFIG,
      `d3d9.maxAvailableMemory = 4096; dxgi.maxDeviceMemory = ${vramCapMB}; dxgi.maxSharedMemory = ${vramCapMB}`
    );
    if (hasPeCaps && peCaps.importsD3d9) {
      env.DXVK_CONFIG = mergeSemicolonConfigClauses(
        env.DXVK_CONFIG,
        'd3d9.deferSurfaceCreation = True'
      );
    }
  }

  if (Number(cfg.preferredMaxFrameRate) > 0) {
    const maxFps = Math.round(Number(cfg.preferredMaxFrameRate));
    env.DXMT_CONFIG = mergeSemicolonConfigClauses(
      env.DXMT_CONFIG,
      `d3d11.preferredMaxFrameRate = ${maxFps}`
    );
    if (backend === 'dxvk') {
      if (env.DXVK_FRAME_RATE === undefined && cfg.environmentVariables?.DXVK_FRAME_RATE === undefined) {
        env.DXVK_FRAME_RATE = String(maxFps);
      }
      env.DXVK_CONFIG = mergeSemicolonConfigClauses(
        env.DXVK_CONFIG,
        `dxgi.maxFrameRate = ${maxFps}; d3d9.maxFrameRate = ${maxFps}`
      );
    } else if (backend === 'd3dmetal') {
      if (env.D3DM_MAX_FPS === undefined && cfg.environmentVariables?.D3DM_MAX_FPS === undefined) {
        env.D3DM_MAX_FPS = String(maxFps);
      }
    }
  }

  if (
    typeof env.DXVK_CONFIG === 'string' &&
    env.DXVK_CONFIG.trim() &&
    env.DXVK_CONFIG_FILE === undefined &&
    cfg.environmentVariables?.DXVK_CONFIG_FILE === undefined
  ) {
    try {
      const normalizedClauses = env.DXVK_CONFIG.split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      if (normalizedClauses.length > 0) {
        const dxvkConfBody = `${normalizedClauses.join('\n')}\n`;
        const cfgHash = crypto.createHash('sha256').update(dxvkConfBody).digest('hex').slice(0, 12);
        const dxvkConfDir = path.join(
          getUserDataDir(effectiveOptions?.userDataDir),
          'shader-cache',
          'dxvk'
        );
        fs.mkdirSync(dxvkConfDir, { recursive: true });
        const dxvkConfPath = path.join(dxvkConfDir, `dxvk-${cfgHash}.conf`);
        if (!fs.existsSync(dxvkConfPath)) {
          atomicWriteFileSync(dxvkConfPath, dxvkConfBody);
        }
        env.DXVK_CONFIG_FILE = dxvkConfPath;
      }
    } catch {}
  }

  const usesMoltenVkBackend =
    backend === 'dxvk' ||
    backendRoute.direct3dRenderer === 'vulkan' ||
    Boolean(hasPeCaps && peCaps.importsVulkan);
  if (usesMoltenVkBackend) {
    if (
      env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS === undefined
    ) {
      env.MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS = '0';
    }
    if (
      env.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS === undefined
    ) {
      env.MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS = '2';
    }
    if (
      env.MVK_CONFIG_FAST_MATH_ENABLED === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_FAST_MATH_ENABLED === undefined
    ) {
      env.MVK_CONFIG_FAST_MATH_ENABLED = '1';
    }
    if (
      env.MVK_CONFIG_RESUME_LOST_DEVICE === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_RESUME_LOST_DEVICE === undefined
    ) {
      env.MVK_CONFIG_RESUME_LOST_DEVICE = '1';
    }
  }

  if (
    env.DXVK_STATE_CACHE_PATH === undefined &&
    cfg.environmentVariables?.DXVK_STATE_CACHE_PATH === undefined
  ) {
    try {
      const dxvkCacheDir = path.join(
        getUserDataDir(effectiveOptions?.userDataDir),
        'shader-cache',
        'dxvk'
      );
      fs.mkdirSync(dxvkCacheDir, { recursive: true });
      env.DXVK_STATE_CACHE_PATH = dxvkCacheDir;
    } catch {}
  }

  const isDebugLoggingOff =
    !env.WINEDEBUG || env.WINEDEBUG === '-all' || env.WINEDEBUG === '-all,err+system';
  if (isDebugLoggingOff) {
    if (env.DXVK_LOG_LEVEL === undefined && cfg.environmentVariables?.DXVK_LOG_LEVEL === undefined) {
      env.DXVK_LOG_LEVEL = 'none';
    }
    if (env.DXVK_LOG_PATH === undefined && cfg.environmentVariables?.DXVK_LOG_PATH === undefined) {
      env.DXVK_LOG_PATH = 'none';
    }
    if (env.DXMT_LOG_LEVEL === undefined && cfg.environmentVariables?.DXMT_LOG_LEVEL === undefined) {
      env.DXMT_LOG_LEVEL = 'none';
    }
    if (env.DXMT_LOG_PATH === undefined && cfg.environmentVariables?.DXMT_LOG_PATH === undefined) {
      env.DXMT_LOG_PATH = 'none';
    }
    if (
      env.MVK_CONFIG_LOG_LEVEL === undefined &&
      cfg.environmentVariables?.MVK_CONFIG_LOG_LEVEL === undefined
    ) {
      env.MVK_CONFIG_LOG_LEVEL = '2';
    }
  }

  if (isBottleDir) {
    const cxbottleConfPath = path.join(resolvedBottlePath, 'cxbottle.conf');
    const isPreviewRunner =
      chosenLayer?.type === 'crossover_preview' || Boolean(effectiveOptions.isPreviewRunner);
    const isStableCrossOverRunner =
      chosenLayer?.type === 'crossover' && !isPreviewRunner;
    const isSharedStableBottlePath =
      /\/CrossOver\/Bottles\//i.test(resolvedBottlePath.replace(/\\/g, '/')) &&
      !/\/CrossOver Preview\/Bottles\//i.test(resolvedBottlePath.replace(/\\/g, '/'));
    const hasCrossOverEnvConfig =
      requestedBackend !== undefined ||
      backendRoute.cxGraphicsBackendEnv !== null ||
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

        if (isPreviewRunner) {
          if (/^"Preview"\s*=\s*"[^"]*"/m.test(existingConf)) {
            existingConf = existingConf.replace(
              /^"Preview"\s*=\s*"[^"]*"/m,
              '"Preview" = "1"'
            );
          } else if (/^\[Bottle\]\s*$/m.test(existingConf)) {
            const extraTag = isSharedStableBottlePath ? '\n"OneLauncherManagedPreview" = "1"' : '';
            existingConf = existingConf.replace(
              /^\[Bottle\]\s*$/m,
              `[Bottle]\n"Preview" = "1"${extraTag}`
            );
          } else {
            const extraTag = isSharedStableBottlePath ? '\n"OneLauncherManagedPreview" = "1"' : '';
            existingConf = `[Bottle]\n"WineArch" = "win64"\n"Preview" = "1"${extraTag}\n\n${existingConf}`;
          }
        } else if (
          isStableCrossOverRunner &&
          (isSharedStableBottlePath || /^"OneLauncherManagedPreview"\s*=\s*"1"/m.test(existingConf))
        ) {
          existingConf = existingConf
            .replace(/^"Preview"\s*=\s*"1"\s*\r?\n?/gm, '')
            .replace(/^"OneLauncherManagedPreview"\s*=\s*"[^"]*"\s*\r?\n?/gm, '');
        }

        const updates = new Map();
        const removals = new Set();

        const hasExplicitNonAutoBackend = Boolean(
          requestedBackend && requestedBackend !== 'auto' && backendRoute.cxGraphicsBackendEnv
        );
        if (hasExplicitNonAutoBackend) {
          updates.set('CX_GRAPHICS_BACKEND', backendRoute.cxGraphicsBackendEnv);
        } else {
          removals.add('CX_GRAPHICS_BACKEND');
        }

        if (
          isD3DMetalEligible &&
          (d3dmVer === '3' || d3dmVer === '4') &&
          hasMultipleBundledD3dMetal
        ) {
          updates.set('CX_GRAPHICS_BACKEND_VERSION', d3dmVer);
        } else {
          removals.add('CX_GRAPHICS_BACKEND_VERSION');
        }
        removals.add('WINED3DMETAL');

        if (wantMetalFxDlss && !dlssUnsupportedTarget) {
          updates.set('D3DM_ENABLE_METALFX', darwinMajor >= 25 ? '1' : '0');
          updates.set('DXMT_ENABLE_NVEXT', '1');
        } else if (
          cfg.crossoverDlss === false ||
          (wantMetalFxDlss && dlssUnsupportedTarget)
        ) {
          updates.set('D3DM_ENABLE_METALFX', '0');
          updates.set('DXMT_ENABLE_NVEXT', '0');
        } else {
          removals.add('D3DM_ENABLE_METALFX');
          removals.add('DXMT_ENABLE_NVEXT');
        }

        updates.set('WINEMSYNC', env.WINEMSYNC);
        if (isCrossOver25Plus) {
          removals.add('WINEESYNC');
        } else if (env.WINEESYNC !== undefined) {
          updates.set('WINEESYNC', env.WINEESYNC);
        }
        if (env.ROSETTA_ADVERTISE_AVX === '1' || env.ROSETTA_ADVERTISE_AVX === '0') {
          updates.set('ROSETTA_ADVERTISE_AVX', env.ROSETTA_ADVERTISE_AVX);
        } else {
          removals.add('ROSETTA_ADVERTISE_AVX');
        }

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

  const enableLegacyDisplay = Boolean(
    effectiveOptions.enableLegacyDisplayModeSynthesis || cfg.enableLegacyDisplayModeSynthesis
  );
  const usesLegacyDdraw = Boolean(
    effectiveOptions.usesLegacyDirectDraw || cfg.usesLegacyDirectDraw
  );
  const forceLegacy96Dpi = Boolean(enableLegacyDisplay || usesLegacyDdraw);
  const effectiveHighResolutionMode = forceLegacy96Dpi
    ? false
    : typeof cfg.crossoverHighResolutionMode === 'boolean'
      ? cfg.crossoverHighResolutionMode
      : undefined;

  // Coalesced bottle registry hygiene: RetinaMode (non-destructive), LogPixels, Desktops, AppDefaults,
  // Direct3D VideoMemorySize / Vulkan routing, reference-counted EmulateModeset, LargeAddressAware,
  // and baseline system.reg / user.reg prefix hygiene flushed in a single `reg.exe import` call.
  if (isBottleDir) {
    try {
      const {
        isBottleWineserverActive,
        upsertWineSystemRegKeysBatch,
        flushLiveWineRegistryAccumulator,
      } = require('./firstPartyRegistration.cjs');
      const userRegPath = path.join(resolvedBottlePath, 'user.reg');
      const systemRegPath = path.join(resolvedBottlePath, 'system.reg');
      const skipLiveSync = Boolean(
        effectiveOptions.skipRegistrySpawn ||
          effectiveOptions.skipLiveWineRegSync ||
          effectiveOptions.homedir
      );
      /** @type {Array<{ hiveName: 'HKEY_LOCAL_MACHINE' | 'HKEY_CURRENT_USER', normalizedSubKey: string, entryPairsOrNullForDelete: Array<[string, any]> | null }>} */
      const liveSyncAccumulator = [];
      const regUpsertOpts = {
        ...effectiveOptions,
        bottlePath: resolvedBottlePath,
        regFilePath: userRegPath,
        skipLiveWineRegSync: skipLiveSync,
        liveSyncAccumulator,
      };
      /** @type {Array<{ subKeyPath: string, entries: Array<[string, any]> }>} */
      const userRegBatchSpecs = [];

      const rawExeInputs = [
        explicitExeNameFromArg,
        effectiveOptions.exeName,
        cfg.exeName,
        ...(Array.isArray(effectiveOptions.targetExeNames) ? effectiveOptions.targetExeNames : []),
        ...(Array.isArray(cfg.targetExeNames) ? cfg.targetExeNames : []),
      ];
      const targetExeSet = new Set();
      for (const rawExe of rawExeInputs) {
        if (typeof rawExe !== 'string' || !rawExe.trim()) continue;
        const baseLower = path.win32.basename(rawExe.trim()).toLowerCase();
        if (baseLower && /\.exe$/i.test(baseLower)) {
          targetExeSet.add(baseLower);
        }
      }
      const targetExes = Array.from(targetExeSet);

      // Inspect pre-existing user.reg state once for non-destructive RetinaMode & baseline hygiene
      let priorMacDriverManaged = false;
      /** @type {string | null} */
      let priorRetinaModeVal = null;
      /** @type {string | null} */
      let savedPriorRetinaVal = null;
      let hasFontsSectionInUserReg = false;
      let hasValveSteamInUserReg = false;
      /** @type {string | null} */
      let globalWineVersionVal = null;

      if (fs.existsSync(userRegPath)) {
        try {
          let existingUserReg = fs.readFileSync(userRegPath, 'utf8');
          hasFontsSectionInUserReg = /^\[Software\\\\Wine\\\\Fonts\](?:\s+\d+)?[^\r\n]*$/im.test(
            existingUserReg
          );
          hasValveSteamInUserReg = /^\[Software\\\\Valve\\\\Steam\](?:\s+\d+)?[^\r\n]*$/im.test(
            existingUserReg
          );

          // Remove non-symlink `[Software\\Wow6432Node\\Valve...]` shadow sections when `[Software\\Valve\\Steam]` exists
          if (hasValveSteamInUserReg) {
            const lines = existingUserReg.split(/\r?\n/);
            /** @type {string[]} */
            const cleanedLines = [];
            let i = 0;
            let removedValveShadow = false;
            while (i < lines.length) {
              const secHeader = lines[i].match(/^\[(Software\\\\Wow6432Node\\\\Valve(?:\\\\[^\]]*)?)\]/i);
              if (secHeader) {
                const rawEscapedSec = secHeader[1];
                let endIdx = i + 1;
                while (endIdx < lines.length && !/^\[[^\]]+\]/.test(lines[endIdx])) {
                  endIdx += 1;
                }
                const secSlice = lines.slice(i + 1, endIdx).join('\n');
                if (!/^\s*#link\b/m.test(secSlice)) {
                  removedValveShadow = true;
                  liveSyncAccumulator.push({
                    hiveName: 'HKEY_CURRENT_USER',
                    normalizedSubKey: rawEscapedSec.replace(/\\\\/g, '\\'),
                    entryPairsOrNullForDelete: null,
                  });
                  i = endIdx;
                  continue;
                }
              }
              cleanedLines.push(lines[i]);
              i += 1;
            }
            if (removedValveShadow) {
              existingUserReg = cleanedLines.join('\n');
              atomicWriteFileSync(userRegPath, existingUserReg);
            }
          }

          const macSecMatch = /^\[Software\\\\Wine\\\\Mac Driver\](?:\s+\d+)?[^\r\n]*$/im.exec(
            existingUserReg
          );
          if (macSecMatch) {
            const secStart = macSecMatch.index + macSecMatch[0].length;
            const afterSec = existingUserReg.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
            priorMacDriverManaged = /^"OneLauncherManagedRetina"\s*=\s*"1"/im.test(secBody);
            const rmMatch = /^"RetinaMode"\s*=\s*"([^"]*)"/im.exec(secBody);
            if (rmMatch) priorRetinaModeVal = rmMatch[1];
            const spMatch = /^"OneLauncherPriorRetina"\s*=\s*"([^"]*)"/im.exec(secBody);
            if (spMatch) savedPriorRetinaVal = spMatch[1];
          }

          const globalWineMatch = /^\[Software\\\\Wine\](?:\s+\d+)?[^\r\n]*$/im.exec(
            existingUserReg
          );
          if (globalWineMatch) {
            const secStart = globalWineMatch.index + globalWineMatch[0].length;
            const afterSec = existingUserReg.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
            const verMatch = /^"Version"\s*=\s*"([^"]*)"/im.exec(secBody);
            if (verMatch) globalWineVersionVal = verMatch[1].trim().toLowerCase();
          }
        } catch {}
      }

      // 1. Non-destructive RetinaMode + LogPixels DPI synchronization
      if (forceLegacy96Dpi) {
        /** @type {Array<[string, any]>} */
        const macDriverEntries = [
          ['RetinaMode', { type: 'sz', value: 'n' }],
          ['OneLauncherManagedRetina', { type: 'sz', value: '1' }],
        ];
        if (!priorMacDriverManaged && priorRetinaModeVal !== null) {
          macDriverEntries.push(['OneLauncherPriorRetina', { type: 'sz', value: priorRetinaModeVal }]);
        }
        userRegBatchSpecs.push(
          { subKeyPath: 'Software\\Wine\\Mac Driver', entries: macDriverEntries },
          { subKeyPath: 'Control Panel\\Desktop', entries: [['LogPixels', { type: 'dword', value: 0x60 }]] },
          { subKeyPath: 'Software\\Wine\\Fonts', entries: [['LogPixels', { type: 'dword', value: 0x60 }]] },
          {
            subKeyPath: 'Software\\Wine\\AppDefaults\\explorer.exe\\Mac Driver',
            entries: [['RetinaMode', { type: 'sz', value: 'n' }]],
          }
        );
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Mac Driver`,
            entries: [['RetinaMode', { type: 'sz', value: 'n' }]],
          });
        }
      } else if (typeof effectiveHighResolutionMode === 'boolean') {
        const retinaVal = effectiveHighResolutionMode ? 'y' : 'n';
        const logPixelsVal = effectiveHighResolutionMode ? 0xc0 : 0x60;
        userRegBatchSpecs.push(
          {
            subKeyPath: 'Software\\Wine\\Mac Driver',
            entries: [['RetinaMode', { type: 'sz', value: retinaVal }]],
          },
          {
            subKeyPath: 'Control Panel\\Desktop',
            entries: [['LogPixels', { type: 'dword', value: logPixelsVal }]],
          }
        );
        if (hasFontsSectionInUserReg) {
          userRegBatchSpecs.push({
            subKeyPath: 'Software\\Wine\\Fonts',
            entries: [['LogPixels', { type: 'dword', value: logPixelsVal }]],
          });
        }
      } else if (priorMacDriverManaged && savedPriorRetinaVal !== null) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Wine\\Mac Driver',
          entries: [['RetinaMode', { type: 'sz', value: savedPriorRetinaVal }]],
        });
      }

      // 2. Global `[Software\\Wine]` `"Version"` poisoning recovery for 64-bit launches
      if (
        hasPeCaps &&
        peCaps.is64Bit &&
        !cfg.windowsVersion &&
        !effectiveOptions.windowsVersion &&
        globalWineVersionVal &&
        (globalWineVersionVal === 'win7' ||
          globalWineVersionVal === 'winxp' ||
          globalWineVersionVal === 'winxp64' ||
          globalWineVersionVal === 'vista' ||
          globalWineVersionVal === 'win2k')
      ) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Wine',
          entries: [['Version', { type: 'sz', value: 'win10' }]],
        });
      }

      // 3. Virtual Desktop synthesis & per-exe AppDefaults
      const displayProbeOpts = skipLiveSync
        ? { ...effectiveOptions, skipDisplayProbe: true }
        : effectiveOptions;
      const hostRes = getHostMaxDisplayResolution(
        Boolean(effectiveHighResolutionMode),
        displayProbeOpts
      );
      const desktopWidth = Math.max(640, Math.round(Number(hostRes?.width) || 1512));
      const desktopHeight = Math.max(480, Math.round(Number(hostRes?.height) || 982));
      const desktopModeStr = `${desktopWidth}x${desktopHeight}`;

      userRegBatchSpecs.push({
        subKeyPath: 'Software\\Wine\\Explorer\\Desktops',
        entries: [['OneLauncher', { type: 'sz', value: desktopModeStr }]],
      });

      const wantVirtualDesktop = Boolean(cfg.virtualDesktop === true || enableLegacyDisplay);
      if (wantVirtualDesktop) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Wine\\Explorer',
          entries: [['Desktop', { type: 'sz', value: 'OneLauncher' }]],
        });
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Explorer`,
            entries: [['Desktop', { type: 'sz', value: 'OneLauncher' }]],
          });
        }
      }

      const limitLegacyGl = Boolean(
        effectiveOptions.limitLegacy32BitGlExtensions || cfg.limitLegacy32BitGlExtensions
      );
      if (limitLegacyGl) {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\OpenGL`,
            entries: [['EnabledExtensions', { type: 'sz', value: LEGACY_32BIT_OPENGL_ENABLED_EXTENSIONS }]],
          });
        }
      }

      if (usesLegacyDdraw) {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            entries: [['DirectDrawRenderer', { type: 'sz', value: 'opengl' }]],
          });
        }
      }

      if (backendRoute.direct3dRenderer === 'vulkan') {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            entries: [['renderer', { type: 'sz', value: 'vulkan' }]],
          });
        }
      }

      // 32-bit Non-LAA (`1.92 GiB` VA) Direct3D VideoMemorySize cap (`1536` MiB) on non-DXMT backends
      if (isPe32NonLaa && backend !== 'dxmt') {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            entries: [['VideoMemorySize', { type: 'sz', value: '1536' }]],
          });
        }
      }

      // Opt-in Wine AppDefaults LargeAddressAware (`dword:00000001`) for 32-bit targets
      if (cfg.forceLargeAddressAware === true && isPe32Target) {
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}`,
            entries: [['LargeAddressAware', { type: 'dword', value: 1 }]],
          });
        }
      }

      const wantEmulateModeset =
        cfg.emulateModeset === true ||
        effectiveOptions.emulateModeset === true ||
        (cfg.emulateModeset !== false &&
          effectiveOptions.emulateModeset !== false &&
          enableLegacyDisplay);
      if (wantEmulateModeset) {
        userRegBatchSpecs.push({
          subKeyPath: 'Software\\Wine\\AppDefaults\\explorer.exe\\X11 Driver',
          entries: [['EmulateModeset', { type: 'sz', value: 'y' }]],
        });
        for (const tExe of targetExes) {
          userRegBatchSpecs.push({
            subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\X11 Driver`,
            entries: [['EmulateModeset', { type: 'sz', value: 'y' }]],
          });
        }
      }

      const appLocalDllOverrides =
        effectiveOptions.appLocalDllOverrides &&
        typeof effectiveOptions.appLocalDllOverrides === 'object'
          ? effectiveOptions.appLocalDllOverrides
          : null;
      if (appLocalDllOverrides) {
        const dllEntries = Object.entries(appLocalDllOverrides)
          .filter(([k, v]) => k && typeof v === 'string')
          .map(([k, v]) => /** @type {[string, any]} */ ([k, { type: 'sz', value: v }]));
        if (dllEntries.length > 0) {
          for (const tExe of targetExes) {
            userRegBatchSpecs.push({
              subKeyPath: `Software\\Wine\\AppDefaults\\${tExe}\\DllOverrides`,
              entries: dllEntries,
            });
          }
        }
      }

      if (userRegBatchSpecs.length > 0) {
        upsertWineUserRegKeysBatch(resolvedBottlePath, userRegBatchSpecs, regUpsertOpts);
      }

      // 4. Value removals in `user.reg` (zero-write when absent; recorded into `liveSyncAccumulator` when removed)
      if (!wantVirtualDesktop) {
        removeWineRegNamedValue(userRegPath, 'Software\\Wine\\Explorer', 'Desktop', regUpsertOpts);
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Explorer`,
            'Desktop',
            regUpsertOpts
          );
        }
      }

      if (!forceLegacy96Dpi) {
        removeWineRegNamedValue(
          userRegPath,
          'Software\\Wine\\AppDefaults\\explorer.exe\\Mac Driver',
          'RetinaMode',
          regUpsertOpts
        );
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Mac Driver`,
            'RetinaMode',
            regUpsertOpts
          );
        }
        if (typeof effectiveHighResolutionMode === 'boolean') {
          removeWineRegNamedValue(
            userRegPath,
            'Software\\Wine\\Mac Driver',
            'OneLauncherManagedRetina',
            regUpsertOpts
          );
          removeWineRegNamedValue(
            userRegPath,
            'Software\\Wine\\Mac Driver',
            'OneLauncherPriorRetina',
            regUpsertOpts
          );
        } else if (priorMacDriverManaged) {
          if (savedPriorRetinaVal === null) {
            removeWineRegNamedValue(
              userRegPath,
              'Software\\Wine\\Mac Driver',
              'RetinaMode',
              regUpsertOpts
            );
          }
          removeWineRegNamedValue(
            userRegPath,
            'Software\\Wine\\Mac Driver',
            'OneLauncherManagedRetina',
            regUpsertOpts
          );
          removeWineRegNamedValue(
            userRegPath,
            'Software\\Wine\\Mac Driver',
            'OneLauncherPriorRetina',
            regUpsertOpts
          );
        }
      }

      if (backendRoute.direct3dRenderer !== 'vulkan' && hasPeCaps) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            'renderer',
            regUpsertOpts
          );
        }
      }

      if (backend === 'dxmt' || isPe32Laa || (hasPeCaps && peCaps.is64Bit)) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\Direct3D`,
            'VideoMemorySize',
            regUpsertOpts
          );
        }
      }

      if (cfg.forceLargeAddressAware === false || (hasPeCaps && peCaps.is64Bit)) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}`,
            'LargeAddressAware',
            regUpsertOpts
          );
        }
      }

      if (
        !wantEmulateModeset &&
        (cfg.emulateModeset === false ||
          effectiveOptions.emulateModeset === false ||
          (hasPeCaps && (peCaps.is64Bit || !enableLegacyDisplay)))
      ) {
        for (const tExe of targetExes) {
          removeWineRegNamedValue(
            userRegPath,
            `Software\\Wine\\AppDefaults\\${tExe}\\X11 Driver`,
            'EmulateModeset',
            regUpsertOpts
          );
        }
        let otherExeStillUsesEmulateModeset = false;
        if (fs.existsSync(userRegPath)) {
          try {
            const curUserReg = fs.readFileSync(userRegPath, 'utf8');
            const appDefX11Re =
              /^\[Software\\\\Wine\\\\AppDefaults\\\\([^\\\]]+)\\\\X11 Driver\](?:\s+\d+)?[^\r\n]*$/gim;
            let x11Match;
            while ((x11Match = appDefX11Re.exec(curUserReg)) !== null) {
              const exeLower = String(x11Match[1] || '').trim().toLowerCase();
              if (!exeLower || exeLower === 'explorer.exe') continue;
              const secStart = x11Match.index + x11Match[0].length;
              const afterSec = curUserReg.slice(secStart);
              const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
              const secBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
              if (/^"EmulateModeset"\s*=\s*"y"/im.test(secBody)) {
                otherExeStillUsesEmulateModeset = true;
                break;
              }
            }
          } catch {}
        }
        if (!otherExeStillUsesEmulateModeset) {
          removeWineRegNamedValue(
            userRegPath,
            'Software\\Wine\\AppDefaults\\explorer.exe\\X11 Driver',
            'EmulateModeset',
            regUpsertOpts
          );
        }
      }

      // 5. Baseline `system.reg` prefix hygiene (FontSubstitutes & ServicesPipeTimeout when initialized)
      if (fs.existsSync(systemRegPath)) {
        try {
          const sysContent = fs.readFileSync(systemRegPath, 'utf8');
          /** @type {Array<{ subKeyPath: string, entries: Array<[string, any]> }>} */
          const sysRegBatchSpecs = [];

          const fontSubRe =
            /^\[Software\\\\Microsoft\\\\Windows NT\\\\CurrentVersion\\\\FontSubstitutes\](?:\s+\d+)?[^\r\n]*$/im;
          const fontSubMatch = fontSubRe.exec(sysContent);
          let fontSubBody = '';
          if (fontSubMatch) {
            const secStart = fontSubMatch.index + fontSubMatch[0].length;
            const afterSec = sysContent.slice(secStart);
            const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
            fontSubBody = nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
          }

          const windowsDir = resolveDriveCPathCaseInsensitive(resolvedBottlePath, [
            'drive_c',
            'windows',
          ]);
          /** @type {Set<string>} */
          const installedFontNamesLower = new Set();
          if (windowsDir && fs.existsSync(windowsDir)) {
            const fontsDir = resolveDriveCPathCaseInsensitive(resolvedBottlePath, [
              'drive_c',
              'windows',
              'fonts',
            ]);
            if (fontsDir && fs.existsSync(fontsDir)) {
              try {
                for (const fn of fs.readdirSync(fontsDir)) {
                  installedFontNamesLower.add(fn.toLowerCase());
                }
              } catch {}
            }
          }

          /** @type {Array<[string, any]>} */
          const missingFontSubs = [];
          if (
            !/^"Palatino Linotype"\s*=/im.test(fontSubBody) &&
            !installedFontNamesLower.has('pala.ttf')
          ) {
            missingFontSubs.push(['Palatino Linotype', { type: 'sz', value: 'Palatino' }]);
          }
          if (windowsDir && fs.existsSync(windowsDir)) {
            if (
              !/^"Segoe UI"\s*=/im.test(fontSubBody) &&
              !installedFontNamesLower.has('segoeui.ttf')
            ) {
              missingFontSubs.push(['Segoe UI', { type: 'sz', value: 'Helvetica Neue' }]);
            }
            if (
              !/^"MS UI Gothic"\s*=/im.test(fontSubBody) &&
              !installedFontNamesLower.has('msgothic.ttc') &&
              !installedFontNamesLower.has('msgothic.ttf')
            ) {
              missingFontSubs.push(['MS UI Gothic', { type: 'sz', value: 'Hiragino Sans' }]);
            }
          }
          if (missingFontSubs.length > 0) {
            sysRegBatchSpecs.push({
              subKeyPath: 'Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes',
              entries: missingFontSubs,
            });
          }

          const ctrlSecRe = /^\[System\\\\CurrentControlSet\\\\Control\](?:\s+\d+)?[^\r\n]*$/im;
          const ctrlMatch = ctrlSecRe.exec(sysContent);
          const ctrlBody = ctrlMatch
            ? (() => {
                const secStart = ctrlMatch.index + ctrlMatch[0].length;
                const afterSec = sysContent.slice(secStart);
                const nextSec = /^\[[^\]]+\]/m.exec(afterSec);
                return nextSec ? afterSec.slice(0, nextSec.index) : afterSec;
              })()
            : '';
          if (!/^"ServicesPipeTimeout"\s*=/im.test(ctrlBody)) {
            sysRegBatchSpecs.push({
              subKeyPath: 'System\\CurrentControlSet\\Control',
              entries: [['ServicesPipeTimeout', { type: 'dword', value: 60000 }]],
            });
          }

          if (sysRegBatchSpecs.length > 0) {
            upsertWineSystemRegKeysBatch(resolvedBottlePath, sysRegBatchSpecs, {
              ...effectiveOptions,
              bottlePath: resolvedBottlePath,
              regFilePath: systemRegPath,
              skipLiveWineRegSync: skipLiveSync,
              liveSyncAccumulator,
            });
          }
        } catch {}
      }

      // 6. Single coalesced live `reg.exe import` sync (or explicit `syncLiveWineReg === true` CLI fallback)
      const bottleServerLive = !skipLiveSync && isBottleWineserverActive(resolvedBottlePath, effectiveOptions);
      if (bottleServerLive && liveSyncAccumulator.length > 0) {
        flushLiveWineRegistryAccumulator(resolvedBottlePath, liveSyncAccumulator, {
          ...effectiveOptions,
          wineBinary: candidateWineBin || effectiveOptions.wineBinary,
          layerType: chosenLayer?.type,
          env,
        }).catch(() => {});
      } else if (
        effectiveOptions?.syncLiveWineReg === true &&
        typeof effectiveHighResolutionMode === 'boolean' &&
        !effectiveOptions.homedir &&
        !effectiveOptions.skipRegistrySpawn &&
        chosenLayer?.binaryPath &&
        fs.existsSync(chosenLayer.binaryPath)
      ) {
        const retinaVal = effectiveHighResolutionMode ? 'y' : 'n';
        const logPixelsDec = effectiveHighResolutionMode ? '192' : '96';
        const aligned = prepareAlignedBottleWineCommand({
          wineBinary: chosenLayer.binaryPath,
          bottlePath: resolvedBottlePath,
          env: { ...process.env, ...env },
          suppressGuiDialogs: true,
          layerType: chosenLayer?.type,
        });
        const runLiveRegAdd = (/** @type {string[]} */ regArgs) =>
          new Promise((resolve) => {
            try {
              execFile(
                aligned.wineBinary,
                [...aligned.prefixArgs, ...regArgs],
                { timeout: 2500, env: aligned.env },
                () => resolve(true)
              );
            } catch {
              resolve(false);
            }
          });
        const prefixKey = path.resolve(resolvedBottlePath);
        const syncPromise = Promise.race([
          Promise.all([
            runLiveRegAdd([
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
            ]),
            runLiveRegAdd([
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
            ]),
            runLiveRegAdd([
              'reg',
              'add',
              'HKCU\\Software\\Wine\\Fonts',
              '/v',
              'LogPixels',
              '/t',
              'REG_DWORD',
              '/d',
              logPixelsDec,
              '/f',
            ]),
          ]),
          new Promise((resolve) => {
            const t = setTimeout(resolve, 3000);
            if (typeof t.unref === 'function') t.unref();
          }),
        ]).finally(() => {
          if (pendingWineRegSyncByPrefix.get(prefixKey) === syncPromise) {
            pendingWineRegSyncByPrefix.delete(prefixKey);
          }
        });
        pendingWineRegSyncByPrefix.set(prefixKey, syncPromise);
      }
    } catch {}
  }

  if (
    isBottleDir &&
    (process.platform === 'darwin' ||
      effectiveOptions.platform === 'darwin' ||
      effectiveOptions.sanitizeDisplayConfigs)
  ) {
    try {
      sanitizeWinePrefixDisplayConfigs(resolvedBottlePath, {
        ...effectiveOptions,
        ...(typeof effectiveHighResolutionMode === 'boolean'
          ? { highResolutionMode: effectiveHighResolutionMode }
          : {}),
      });
      const installDirKey =
        typeof effectiveOptions.installDir === 'string' && effectiveOptions.installDir
          ? path.resolve(effectiveOptions.installDir)
          : '';
      setBoundedMapEntry(
        recentDisplaySanitizeCache,
        `${path.resolve(resolvedBottlePath)}:${String(effectiveHighResolutionMode)}:${installDirKey}`,
        Date.now(),
        256
      );
    } catch {}
  }

  return env;
}

/** @type {{ maxW: number, maxH: number, logW: number, logH: number } | null} */
let cachedHostDisplayMetrics = null;

function getHostMaxDisplayResolution(highResolutionMode = true, /** @type {any} */ options = {}) {
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

  const electron = getElectron();
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
      const parseResPair = (/** @type {any} */ val) => {
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
          const logicalW =
            isRetina && physW > 0 && (!rw || rw === physW)
              ? Math.round(physW / 2)
              : rw || physW;
          const logicalH =
            isRetina && physH > 0 && (!rh || rh === physH)
              ? Math.round(physH / 2)
              : rh || physH;
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

/** @type {Record<number, [number, number]>} */
const IDTECH_R_MODE_RESOLUTIONS = {
  3: [640, 480],
  4: [800, 600],
  5: [1024, 768],
  6: [1152, 864],
  7: [1280, 1024],
  8: [1600, 1200],
  9: [1280, 720],
  10: [1366, 768],
  12: [1680, 1050],
  13: [1600, 900],
  14: [1600, 1024],
  15: [1920, 1200],
  16: [2560, 1600],
  17: [1920, 1080],
  18: [1920, 1200],
  19: [2560, 1600],
};

/** @type {Array<[number, number, number]>} */
const SAFE_IDTECH_MODE_CANDIDATES = [
  [5, 1024, 768],
  [4, 800, 600],
  [3, 640, 480],
];

function sanitizeWinePrefixDisplayConfigs(winePrefix, /** @type {any} */ options = {}) {
  const hasValidPrefix = Boolean(
    winePrefix && typeof winePrefix === 'string' && fs.existsSync(winePrefix)
  );
  const rawInstallDir =
    options && typeof options.installDir === 'string' && options.installDir.trim()
      ? options.installDir.trim()
      : '';
  const hasValidInstallDir = Boolean(rawInstallDir && fs.existsSync(rawInstallDir));
  if (!hasValidPrefix && !hasValidInstallDir) {
    return { sanitizedFiles: [], maxWidth: 0, maxHeight: 0 };
  }

  if (hasValidPrefix) {
    try {
      sandboxWinePrefixUserFolders(winePrefix, options);
    } catch {}
  }

  const resolvedPrefix = hasValidPrefix ? path.resolve(winePrefix) : '';
  const resolvedInstallDir = hasValidInstallDir ? path.resolve(rawInstallDir) : '';
  let highResolutionMode = true;
  if (typeof options.highResolutionMode === 'boolean') {
    highResolutionMode = options.highResolutionMode;
  } else if (hasValidPrefix) {
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
  const maxWidth =
    Number(options.maxWidth) > 0 ? Math.round(Number(options.maxWidth)) : displayRes.width;
  const maxHeight =
    Number(options.maxHeight) > 0 ? Math.round(Number(options.maxHeight)) : displayRes.height;

  /** @type {any[]} */
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
    'add',
    '__support',
    '__gog_support',
    '__installer',
    'support',
    '_commonredist',
    'redist',
    'directx',
    'vcredist',
    'mono',
    'streamingassets',
    'node_modules',
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

  const isPathInsideAnchor = (
    /** @type {string} */ candidatePath,
    /** @type {string} */ anchorRoot
  ) => {
    if (!anchorRoot) return false;
    try {
      const lstat = fs.lstatSync(candidatePath);
      if (lstat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(candidatePath), fs.readlinkSync(candidatePath));
        return target === anchorRoot || target.startsWith(anchorRoot + path.sep);
      }
      return true;
    } catch {
      return false;
    }
  };

  const sanitizeConfigFile = (/** @type {string} */ filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.cfg' && ext !== '.ini') return;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size <= 0 || st.size > 524288) return;
      const original = fs.readFileSync(filePath, 'utf8');
      let updated = original;
      let prevW = 0;
      let prevH = 0;
      let clampedW = maxWidth;
      let clampedH = maxHeight;

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

        // Clamp discrete id Tech 3 / id Tech 4 `seta r_mode "<N>"` when `r_fullscreen` is enabled
        const isFullscreenEnabled = /^[ \t]*(?:seta?\s+)?r_fullscreen\s+"?([1-9]\d*)"?/im.test(
          updated
        );
        if (isFullscreenEnabled) {
          const rModeRe = /^([ \t]*(?:seta?\s+)?r_mode\s+")(\d+)(".*)$/im;
          const rModeMatch = rModeRe.exec(updated);
          if (rModeMatch) {
            const modeIdx = Number(rModeMatch[2]);
            const modeRes = IDTECH_R_MODE_RESOLUTIONS[modeIdx];
            if (modeRes && (modeRes[0] > maxWidth || modeRes[1] > maxHeight)) {
              const safePick =
                SAFE_IDTECH_MODE_CANDIDATES.find(
                  ([, cw, ch]) => cw <= maxWidth && ch <= maxHeight
                ) || [3, 640, 480];
              if (!prevW && !prevH) {
                prevW = modeRes[0];
                prevH = modeRes[1];
                clampedW = safePick[1];
                clampedH = safePick[2];
              }
              updated = updated.replace(rModeRe, `$1${safePick[0]}$3`);
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
          clampedWidth: clampedW,
          clampedHeight: clampedH,
        });
      }
    } catch {}
  };

  const walkConfigDir = (
    /** @type {string} */ dirPath,
    /** @type {string} */ anchorRoot,
    depth = 0,
    maxDepth = 5
  ) => {
    if (depth > maxDepth || !dirPath || !fs.existsSync(dirPath)) return;
    if (!isPathInsideAnchor(dirPath, anchorRoot)) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (!isPathInsideAnchor(fullPath, anchorRoot)) continue;
      if (entry.isDirectory()) {
        if (skippedDirNames.has(entry.name.toLowerCase())) continue;
        walkConfigDir(fullPath, anchorRoot, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        sanitizeConfigFile(fullPath);
      }
    }
  };

  if (hasValidPrefix) {
    const usersDir = path.join(winePrefix, 'drive_c', 'users');
    if (fs.existsSync(usersDir)) {
      /** @type {fs.Dirent[]} */
      let userEntries = [];
      try {
        userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
      } catch {
        userEntries = [];
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
          if (fs.existsSync(root) && isPathInsideAnchor(root, resolvedPrefix)) {
            walkConfigDir(root, resolvedPrefix, 0, 5);
          }
        }
      }
    }
  }

  if (hasValidInstallDir && resolvedInstallDir) {
    try {
      if (fs.statSync(resolvedInstallDir).isDirectory()) {
        walkConfigDir(resolvedInstallDir, resolvedInstallDir, 0, 3);
      }
    } catch {}
  }

  return { sanitizedFiles, maxWidth, maxHeight };
}

async function ensureCompatibilityLayerReady(
  /** @type {any} */ chosenLayer,
  /** @type {any} */ launchConfig = {},
  /** @type {Record<string, any>} */ env = {},
  /** @type {any} */ options = {}
) {
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
    if (
      launchConfig &&
      launchConfig.wineBottleName &&
      safeIsBottleSlug(launchConfig.wineBottleName)
    ) {
      targetBottle = String(launchConfig.wineBottleName).trim();
    } else if (availableBottles.includes('OneLauncher')) {
      targetBottle = 'OneLauncher';
    } else if (availableBottles.includes('default')) {
      targetBottle = 'default';
    } else if (availableBottles.length > 0 && safeIsBottleSlug(availableBottles[0])) {
      targetBottle = availableBottles[0];
    } else {
      targetBottle = 'OneLauncher';
    }

    const bottlePath = path.join(bottlesDir, targetBottle);
    const isBottleInitialized = isValidBottleDirectory(bottlePath, isMockHomedir);

    if (!isBottleInitialized && !options.skipBottleProvisioning) {
      if (
        !isMockHomedir &&
        safeIsBottleSlug(targetBottle) &&
        isContainedWithinRoot(bottlesDir, bottlePath) &&
        fs.existsSync(bottlePath)
      ) {
        try {
          fs.rmSync(bottlePath, { recursive: true, force: true });
        } catch {}
      }
      if (!options.homedir && safeIsBottleSlug(targetBottle)) {
        const cxbottleCandidates = [
          chosenLayer.binaryPath ? path.join(path.dirname(chosenLayer.binaryPath), 'cxbottle') : null,
          '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
          '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/cxbottle',
        ].filter(Boolean);
        const cxbottleBin = cxbottleCandidates.find((p) => p && fs.existsSync(p));
        if (cxbottleBin) {
          try {
            if (!fs.existsSync(bottlesDir)) {
              fs.mkdirSync(bottlesDir, { recursive: true });
            }
          } catch {}
          /** @type {Record<string, any>} */
          const cxbottleCreateEnv = { ...process.env, ...env };
          delete cxbottleCreateEnv.DYLD_INSERT_LIBRARIES;
          const execFileImpl =
            typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
          await new Promise((resolve) => {
            execFileImpl(
              cxbottleBin,
              ['--bottle', targetBottle, '--create', '--template', 'win10_64'],
              { timeout: 60000, env: cxbottleCreateEnv },
              () => resolve(true)
            );
          });
        }
      }
      if (
        !fs.existsSync(bottlePath) &&
        !options.skipBottleDirCreation &&
        safeIsBottleSlug(targetBottle) &&
        isContainedWithinRoot(bottlesDir, bottlePath)
      ) {
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
    env.WINEMSYNC = env.WINEMSYNC ?? '1';
    delete env.WINEESYNC;

    try {
      await sandboxWinePrefixUserFoldersAsync(env.WINEPREFIX || bottlePath, options);
    } catch {}

    const resolvedBottlePrefix = env.WINEPREFIX || bottlePath;
    applyCrossOverPerGameSettings(
      chosenLayer,
      launchConfig,
      env,
      resolvedBottlePrefix,
      options
    );
    if (resolvedBottlePrefix) {
      const pendingReg = pendingWineRegSyncByPrefix.get(path.resolve(resolvedBottlePrefix));
      if (pendingReg) {
        try {
          await pendingReg;
        } catch {}
      }
    }

    const effectiveWineBinary = resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env, {
      layerType: chosenLayer.type,
    });
    return {
      targetBottle,
      winePrefix: env.WINEPREFIX,
      wineBinary: effectiveWineBinary,
      wineserverBinary: resolveWineserverBinary(chosenLayer.binaryPath),
    };
  }

  const targetPrefix =
    launchConfig && launchConfig.winePrefixPath
      ? launchConfig.winePrefixPath
      : path.join(homedir, 'Games/OneLauncher/Prefixes/default');

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

  if (
    targetPrefix &&
    !fs.existsSync(path.join(targetPrefix, 'system.reg')) &&
    !options.skipBottleProvisioning &&
    !options.homedir &&
    (!isTestEnvironment(options) || options.forceStandaloneWineboot === true) &&
    chosenLayer.binaryPath &&
    fs.existsSync(chosenLayer.binaryPath)
  ) {
    try {
      const alignedBoot = prepareAlignedBottleWineCommand({
        wineBinary: chosenLayer.binaryPath,
        bottlePath: targetPrefix,
        env: { ...process.env, ...env },
        suppressGuiDialogs: true,
        layerType: chosenLayer.type,
      });
      const execFileImpl =
        typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
      await new Promise((resolve) => {
        try {
          execFileImpl(
            alignedBoot.wineBinary,
            [...alignedBoot.prefixArgs, 'wineboot', '-u'],
            { timeout: 45000, env: alignedBoot.env },
            () => resolve(true)
          );
        } catch {
          resolve(false);
        }
      });
    } catch {}
  }

  try {
    await sandboxWinePrefixUserFoldersAsync(env.WINEPREFIX || targetPrefix, options);
  } catch {}

  const resolvedTargetPrefix = env.WINEPREFIX || targetPrefix;
  applyCrossOverPerGameSettings(
    chosenLayer,
    launchConfig,
    env,
    resolvedTargetPrefix,
    options
  );
  if (resolvedTargetPrefix) {
    const pendingReg = pendingWineRegSyncByPrefix.get(path.resolve(resolvedTargetPrefix));
    if (pendingReg) {
      try {
        await pendingReg;
      } catch {}
    }
  }

  const effectiveWineBinary = resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env, {
    layerType: chosenLayer.type,
  });
  return {
    winePrefix: targetPrefix,
    wineBinary: effectiveWineBinary,
    wineserverBinary: resolveWineserverBinary(chosenLayer.binaryPath),
  };
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
  findPrimaryExecutable,
  getIndexedSteamAppInfoVdf,
  parseSteamBinaryVdfSlice,
  readSteamAppInfoParsedEntry,
  findEnclosingSteamAppInfoVdf,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  normalizeComparableTitle,
  extractBottleRootFromPath,
  removeSteamAppFromLibraryFoldersVdf,
  cleanupCrossOverSteamShortcuts,
  isValidBottleDirectory,
  hasValidInitializedBottles,
  listBottleSubdirectories,
  listAllInitializedBottlePaths,
  resolveTargetBottleForFirstPartySync,
  extractRunnerVersionInfo,
  readRunnerInstallReceipts,
  recordRunnerInstallReceipt,
  parsePlistStringValues,
  detectBundledD3DMetalVersions,
  compareRunnerVersions,
  detectCompatibilityLayers,
  checkCompatibilityLayerUpdates,
  updateCompatibilityLayer,
  cancelCompatibilityLayerOperation,
  selectRunnerArchiveDialog,
  onCompatibilityRunnerProgress,
  mountAndExtractDmgSafe,
  installCompatibilityLayer,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  mergeCxEnvVariables,
  deriveCrossOverRootFromBinaryPath,
  alignWineMsyncWithLiveBottle,
  doesWineLoaderAllowDyldInsert,
  resolveSipSafeWineBinaryAndPreloadEnv,
  prepareCrossOverWineSpawnEnv,
  prepareAlignedBottleWineCommand,
  resolveWineserverBinary,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  removeWineRegNamedValue,
  mergeSemicolonConfigClauses,
  detectCrossOverBackendLayerSupport,
  resolveEffectiveCrossOverGraphicsBackend,
  cleanNonApfsAppleDoubleTwins,
  applyCrossOverPerGameSettings,
  getHostMaxDisplayResolution,
  sanitizeWinePrefixDisplayConfigs,
  ensureCompatibilityLayerReady,
};
