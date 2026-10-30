const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');

const {
  getElectron,
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
  applyStrictRosettaAvxEnv,
} = require('./wineAndCrossOverManager.cjs');
const {
  discoverWindowsSteamRegistryPaths,
} = require('../utils/windowsRegistryDiscovery.cjs');
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

function flattenGogNestedInstallDir(finalInstallPath, cleanId) {
  try {
    if (!finalInstallPath || !fs.existsSync(finalInstallPath)) return finalInstallPath;
    if (finalInstallPath.toLowerCase().endsWith('.app')) return finalInstallPath;
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

  if (platform === 'darwin' && !isInsideBottle) {
    flattenGogNestedInstallDir(localInstallPath, undefined);
    ensureMacExecutablePermissions(localInstallPath);
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
      const regSteam = discoverWindowsSteamRegistryPaths(options);
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

  const bottleParentRoots = [
    path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
    path.join(homedir, 'Library/Containers/com.isaacmarovitz.Whisky/Bottles'),
    path.join(homedir, 'Games/OneLauncher/Prefixes'),
    path.join(homedir, 'Games/Heroic/Prefixes'),
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

  const allBottles = listAllInitializedBottlePaths(options);
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

  for (const variant of crossoverVariants) {
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
      } catch {
        // Isolate transient filesystem/plist read errors per app bundle
      }
    }
  }

  const heroicGptkRoot = path.join(
    homedir,
    'Library/Application Support/heroic/tools/game-porting-toolkit'
  );
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
      const rankHeroicWineDir = (/** @type {any} */ dirName) => {
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

  const hasSharedPrefix =
    fs.existsSync(path.join(homedir, 'Games/Heroic/Prefixes/default')) ||
    fs.existsSync(path.join(homedir, 'Games/OneLauncher/Prefixes/default/drive_c'));

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

async function checkCompatibilityLayerUpdates(/** @type {any} */ options = {}) {
  const layers = Array.isArray(options.layers)
    ? options.layers
    : detectCompatibilityLayers(options);
  const runnerTypes = ['crossover', 'crossover_preview', 'gptk', 'wine'];
  /** @type {Record<string, string>} */
  const defaultDownloadUrls = {
    crossover: 'https://www.codeweavers.com/crossover/download',
    crossover_preview: 'https://www.codeweavers.com/preview/download',
    gptk: 'https://developer.apple.com/games/game-porting-toolkit/',
    wine: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
  };

  /** @type {Record<string, any>} */
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
    const fetchWithTimeout = async (/** @type {string} */ url, timeoutMs = 4500) => {
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

    const wineLayer = layers.find((/** @type {any} */ l) => l.type === 'wine');

    await Promise.all([
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
  /** @type {Record<string, any>} */
  const results = {};

  for (const runnerType of runnerTypes) {
    const layer = layers.find((/** @type {any} */ l) => l.type === runnerType);
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

async function updateCompatibilityLayer(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
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

  /** @type {Record<string, string>} */
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

  /** @type {Record<string, string>} */
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
  const homedir = options.homedir || os.homedir();

  /** @type {Record<string, string>} */
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
    mode !== 'direct' &&
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

  const dmgPath =
    typeof payload.dmgPath === 'string' && payload.dmgPath.trim()
      ? payload.dmgPath.trim()
      : typeof options.dmgPath === 'string' && options.dmgPath.trim()
        ? options.dmgPath.trim()
        : '';

  const shouldTryDirectInstall =
    mode === 'direct' ||
    (mode === 'auto' &&
      !brewPath &&
      typeof options.onExecBrew !== 'function' &&
      (!isTestEnvironment(options) ||
        options.allowDirectVendorInstall === true ||
        typeof options.fetchFn === 'function' ||
        Boolean(dmgPath)) &&
      (runnerType === 'crossover' || runnerType === 'wine' || Boolean(dmgPath)));

  if (shouldTryDirectInstall) {
    try {
      const { installRunnerDirect } = require('./environmentProvisioner.cjs');
      const directRes = await installRunnerDirect(runnerType, {
        ...options,
        ...(dmgPath ? { dmgPath } : {}),
      });
      if (directRes && directRes.installed) {
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
      if (mode === 'direct') {
        if (options.throwOnError === true) {
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          installed: false,
          runnerType,
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
 * Ensure the x86_64 `libone_metal_preload.dylib` helper exists on a real filesystem path
 * outside `app.asar` so `dyld` can load it via `DYLD_INSERT_LIBRARIES` / `CX_DYLD_INSERT_LIBRARIES`.
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

/**
 * Inspect whether a Wine binary is a SIP-protected `#!/usr/bin/perl` or shell wrapper and
 * either configure `CX_DYLD_INSERT_LIBRARIES` (CrossOver) or resolve the adjacent non-SIP
 * `wineloader` / `wineloader64` Mach-O binary so `DYLD_INSERT_LIBRARIES` is not stripped by `dyld`.
 */
function resolveSipSafeWineBinaryAndPreloadEnv(wineBinaryPath, /** @type {Record<string, any>} */ env = {}) {
  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') {
    return wineBinaryPath;
  }
  if (!env.DYLD_INSERT_LIBRARIES) {
    return wineBinaryPath;
  }

  // Always mirror DYLD_INSERT_LIBRARIES into CX_DYLD_INSERT_LIBRARIES so CrossOver's Perl wrapper
  // forwards it into wineloader right before exec!
  const existingCxInsert = String(env.CX_DYLD_INSERT_LIBRARIES || '')
    .split(/:(?![\\/])/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of String(env.DYLD_INSERT_LIBRARIES)
    .split(/:(?![\\/])/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!existingCxInsert.includes(entry)) {
      existingCxInsert.push(entry);
    }
  }
  if (existingCxInsert.length > 0) {
    env.CX_DYLD_INSERT_LIBRARIES = existingCxInsert.join(':');
  }

  // Check if wineBinaryPath starts with a SIP-protected interpreter shebang (e.g., #!/usr/bin/perl, #!/bin/sh)
  try {
    if (!fs.existsSync(wineBinaryPath) || !fs.statSync(wineBinaryPath).isFile()) {
      return wineBinaryPath;
    }
    const fd = fs.openSync(wineBinaryPath, 'r');
    const headBuf = Buffer.alloc(128);
    const bytesRead = fs.readSync(fd, headBuf, 0, 128, 0);
    fs.closeSync(fd);
    const firstLine = headBuf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] || '';
    const shebangMatch = firstLine.match(/^#!\s*(\/\S+)/);
    if (!shebangMatch) {
      return wineBinaryPath;
    }
    const interp = shebangMatch[1];
    const isSipInterpreter = /^\/(usr\/bin|bin|sbin|usr\/sbin)\//.test(interp);
    if (!isSipInterpreter) {
      return wineBinaryPath;
    }

    // CrossOver's Perl wrapper natively consumes CX_DYLD_INSERT_LIBRARIES and sets upbottle environment;
    // for non-CrossOver SIP-shebang Wine wrappers, invoke the adjacent Mach-O wineloader directly if present.
    const isCrossOverWrapper = /CrossOver/i.test(wineBinaryPath) || Boolean(env.CX_BOTTLE);
    if (isCrossOverWrapper) {
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
      return wineBinaryPath;
    }

    const binDir = path.dirname(path.resolve(wineBinaryPath));
    const loaderCandidates = [
      path.join(binDir, 'wineloader64'),
      path.join(binDir, 'wineloader'),
      path.join(binDir, 'wine64-preloader'),
      path.resolve(binDir, '..', 'lib', 'wine', 'x86_64-unix', 'wine'),
      path.resolve(binDir, '..', 'lib64', 'wine', 'x86_64-unix', 'wine'),
    ];
    for (const cand of loaderCandidates) {
      try {
        if (fs.existsSync(cand) && inspectMacMachOHeader(cand).isMachO) {
          return cand;
        }
      } catch {}
    }
  } catch {}

  return wineBinaryPath;
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

  const prefixEnv = {
    ...process.env,
    WINEPREFIX: canonicalPrefix,
    ...(bottleName ? { CX_BOTTLE: bottleName } : {}),
  };

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

function applyCrossOverPerGameSettings(
  /** @type {any} */ chosenLayerOrBottlePath,
  /** @type {any} */ launchConfig = {},
  /** @type {any} */ envOrOptions = {},
  bottlePath = '',
  /** @type {any} */ options = {}
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
  /** @type {Record<string, any>} */
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
  } else if (!backend || backend === 'auto') {
    if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND) {
      delete env.CX_GRAPHICS_BACKEND;
    }
    if (!cfg.environmentVariables?.WINED3DMETAL) {
      delete env.WINED3DMETAL;
    }
  }

  if (isD3DMetalEligible && (d3dmVer === '3' || d3dmVer === '4')) {
    env.CX_GRAPHICS_BACKEND_VERSION = d3dmVer;
  } else if (!cfg.environmentVariables?.CX_GRAPHICS_BACKEND_VERSION) {
    delete env.CX_GRAPHICS_BACKEND_VERSION;
  }

  const dlssUnsupportedBackend = backend === 'dxvk' || backend === 'wined3d';
  if (cfg.crossoverDlss === true && !dlssUnsupportedBackend) {
    env.D3DM_ENABLE_METALFX = '1';
    env.DXMT_ENABLE_NVEXT = '1';
  } else if (cfg.crossoverDlss === false || (cfg.crossoverDlss === true && dlssUnsupportedBackend)) {
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
    env.WINEESYNC = cfg.wineEsync === false ? '0' : '1';
  } else {
    env.WINEMSYNC = '1';
    env.WINEESYNC = '0';
  }

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
          .split(/:(?![\\/])/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!existingInsert.includes(preloadDylib)) {
          existingInsert.unshift(preloadDylib);
        }
        env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');

        // Mirror into CX_DYLD_INSERT_LIBRARIES so CrossOver's SIP-protected #!/usr/bin/perl wine wrapper
        // forwards libone_metal_preload.dylib into wineloader without dyld stripping it!
        const existingCxInsert = String(env.CX_DYLD_INSERT_LIBRARIES || '')
          .split(/:(?![\\/])/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!existingCxInsert.includes(preloadDylib)) {
          existingCxInsert.unshift(preloadDylib);
        }
        env.CX_DYLD_INSERT_LIBRARIES = existingCxInsert.join(':');

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
        .split(/:(?![\\/])/)
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith('libone_metal_preload.dylib'));
      if (filteredInsert.length > 0) {
        env.DYLD_INSERT_LIBRARIES = filteredInsert.join(':');
      } else {
        delete env.DYLD_INSERT_LIBRARIES;
      }
    }
    if (env.CX_DYLD_INSERT_LIBRARIES) {
      const filteredCxInsert = String(env.CX_DYLD_INSERT_LIBRARIES)
        .split(/:(?![\\/])/)
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith('libone_metal_preload.dylib'));
      if (filteredCxInsert.length > 0) {
        env.CX_DYLD_INSERT_LIBRARIES = filteredCxInsert.join(':');
      } else {
        delete env.CX_DYLD_INSERT_LIBRARIES;
      }
    }
  }

  if (cfg.dxvkHud === true) {
    env.DXVK_HUD = env.DXVK_HUD || 'devinfo,fps,frametimes';
  } else if (cfg.dxvkHud === false) {
    delete env.DXVK_HUD;
  }

  const explicitAvxCfg =
    typeof cfg.advertiseAvx === 'boolean'
      ? cfg.advertiseAvx
      : typeof cfg.rosettaAdvertiseAvx === 'boolean'
        ? cfg.rosettaAdvertiseAvx
        : cfg.environmentVariables?.ROSETTA_ADVERTISE_AVX;
  applyStrictRosettaAvxEnv(env, explicitAvxCfg);

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

        // Prevent permanent Preview flag clobbering across shared bottles:
        // - CrossOver Preview sets "Preview" = "1" (tagging "OneLauncherManagedPreview" = "1" on shared Stable bottles)
        // - CrossOver Stable cleanly removes "Preview" = "1" when launching against a shared bottle
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

        if (
          backend === 'd3dmetal' ||
          backend === 'dxmt' ||
          backend === 'dxvk' ||
          backend === 'wined3d'
        ) {
          updates.set('CX_GRAPHICS_BACKEND', backend);
        } else {
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
        } else {
          removals.add('D3DM_ENABLE_METALFX');
          removals.add('DXMT_ENABLE_NVEXT');
        }

        updates.set('WINEMSYNC', env.WINEMSYNC);
        updates.set('WINEESYNC', env.WINEESYNC);
        if (env.ROSETTA_ADVERTISE_AVX === '1') {
          updates.set('ROSETTA_ADVERTISE_AVX', '1');
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

  if (typeof cfg.crossoverHighResolutionMode === 'boolean' && isBottleDir) {
    const retinaVal = cfg.crossoverHighResolutionMode ? 'y' : 'n';
    const logPixelsDword = cfg.crossoverHighResolutionMode ? 'dword:000000c0' : 'dword:00000060';
    const logPixelsDec = cfg.crossoverHighResolutionMode ? '192' : '96';
    const userRegPath = path.join(resolvedBottlePath, 'user.reg');
    try {
      let regContent = fs.existsSync(userRegPath)
        ? fs.readFileSync(userRegPath, 'utf8')
        : '';
      if (!regContent.trim()) {
        regContent =
          'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n';
      }

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
      const runLiveRegAdd = (/** @type {string[]} */ regArgs) =>
        new Promise((resolve) => {
          try {
            execFile(chosenLayer.binaryPath, regArgs, { timeout: 2500, env: regEnv }, () =>
              resolve(true)
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
        ...(typeof cfg.crossoverHighResolutionMode === 'boolean'
          ? { highResolutionMode: cfg.crossoverHighResolutionMode }
          : {}),
      });
      setBoundedMapEntry(
        recentDisplaySanitizeCache,
        `${path.resolve(resolvedBottlePath)}:${String(cfg.crossoverHighResolutionMode)}`,
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

function sanitizeWinePrefixDisplayConfigs(winePrefix, /** @type {any} */ options = {}) {
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
  const maxWidth =
    Number(options.maxWidth) > 0 ? Math.round(Number(options.maxWidth)) : displayRes.width;
  const maxHeight =
    Number(options.maxHeight) > 0 ? Math.round(Number(options.maxHeight)) : displayRes.height;

  const usersDir = path.join(winePrefix, 'drive_c', 'users');
  if (!fs.existsSync(usersDir)) {
    return { sanitizedFiles: [], maxWidth, maxHeight };
  }

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

  const isPathInsidePrefix = (/** @type {string} */ candidatePath) => {
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

  const sanitizeConfigFile = (/** @type {string} */ filePath) => {
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

  const walkConfigDir = (/** @type {string} */ dirPath, depth = 0) => {
    if (depth > 5 || !dirPath || !fs.existsSync(dirPath)) return;
    if (!isPathInsidePrefix(dirPath)) return;
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
      if (!isPathInsidePrefix(fullPath)) continue;
      if (entry.isDirectory()) {
        if (skippedDirNames.has(entry.name.toLowerCase())) continue;
        walkConfigDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        sanitizeConfigFile(fullPath);
      }
    }
  };

  /** @type {fs.Dirent[]} */
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
          await new Promise((resolve) => {
            execFile(
              cxbottleBin,
              ['--bottle', targetBottle, '--create', '--template', 'win10_64', '--default'],
              { timeout: 60000, env: { ...process.env, ...env } },
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

    const effectiveWineBinary = resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env);
    return {
      targetBottle,
      winePrefix: env.WINEPREFIX,
      wineBinary: effectiveWineBinary,
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

  const effectiveWineBinary = resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env);
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
  parsePlistStringValues,
  detectBundledD3DMetalVersions,
  compareRunnerVersions,
  detectCompatibilityLayers,
  checkCompatibilityLayerUpdates,
  updateCompatibilityLayer,
  mountAndExtractDmgSafe,
  installCompatibilityLayer,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  resolveSipSafeWineBinaryAndPreloadEnv,
  resolveWineserverBinary,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  applyCrossOverPerGameSettings,
  getHostMaxDisplayResolution,
  sanitizeWinePrefixDisplayConfigs,
  ensureCompatibilityLayerReady,
};
