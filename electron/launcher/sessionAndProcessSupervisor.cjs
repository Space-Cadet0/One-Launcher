const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, exec, execFile } = require('node:child_process');

const {
  isProcessAlive,
  waitForProcessExit,
  extractMatchedPidFromProcessOutput,
  signalSubprocessTree,
} = require('./processTreeUtils.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isContainedWithinRoot,
  resolveHostWindowsKnownFolders,
} = require('./securityAndPathUtils.cjs');
const {
  resolveBottleSteamExe,
  resolveBundledXboxWinLauncherExePath,
  stageWindowsClientlessXboxBridgeDlls,
  restoreWindowsClientlessXboxBridgeDlls,
  prepareXboxBottleEnvironment,
  upsertWineUserRegKey,
  mergeWineDllOverrides,
} = require('./wineAndCrossOverManager.cjs');
const {
  discoverWindowsSteamRegistryPaths,
} = require('../utils/windowsRegistryDiscovery.cjs');
const {
  isHostGogGalaxyRunning,
  reapOrphanedGogOverlayProcesses,
  isBottleWinExeRunning,
  probeLocalTcpPort,
  resolveGogCommunicationLogPath,
  waitForGogCommunicationServiceReady,
  waitForGogPostExitFlush,
  waitForBottleEpicPortalReady,
  extractTrackedPidFromSteamGameProcessLog,
} = require('./storefrontReadinessBarrier.cjs');
const {
  inspectWindowsExecutableHeader,
  hasMalformedBackslashExportForwarder,
  resolveEffectiveGameExecutableCapabilities,
  resolveParadoxLauncherSettings,
  resolveCaseInsensitiveRelFile,
  isCompatibleX86OrX64PeHeader,
  parseSteamAcf,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('./binaryAndManifestInspectors.cjs');
const { executeGogGameScript } = require('../storefronts/gog/gogScriptInterpreter.cjs');
const {
  normalizePosixUtf8Locale,
  syncXboxCloudSaves,
  pruneCloudSaveStateForGame,
  buildCloudSyncTelemetryPayload,
  createCloudSaveRunner,
} = require('./cloudSaveEngine.cjs');

const {
  getElectron,
  getStoreSync,
  getXboxStorefrontModules,
  diagLog,
  getOfflineVaultLifecycleHooks,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  emitSessionUpdated,
  activeSessions,
  inFlightPostSessionByGame,
  pendingBottleLaunches,
  inFlightPostSessionByBottle,
  pendingEphemeralShutdowns,
  pendingStorefrontLaunches,
  downloadQueueMap,
  pausedByInGameTaskIds,
  inFlightPostSessionPromises,
  recentDisplaySanitizeCache,
  setBoundedMapEntry,
  evictExecutableDiscoveryCacheForPath,
  trimLauncherEngineMemory,
  invalidateScanCaches,
  toLocalFsPath,
  resolveWindowsNodeShebangSpawn,
  openExternalUri,
  resolveHostLocaleInfo,
  clearMacQuarantineAsync,
  findLegendaryBinary,
  findGogdlBinary,
  readManagedInstallSentinel,
  hasManagedInstallSentinel,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  normalizeStorefrontClientLifecycle,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  resolveEffectivePerformancePolicy,
  isSafeToDeleteInstallPath,
  safeIsNumericAppId,
} = require('./engineStateRegistry.cjs');

const {
  findBestX86OrX64WindowsExe,
  isWindowsAppsProtectedPath,
  hasXboxClientlessReceipt,
  queryTargetedAppxPackageAsync,
  ensureWindowsXboxAppxRegisteredAsync,
  removeTargetedAppxPackageVerifiedAsync,
  isWindowsXboxAppRunning,
  activateWindowsXboxApplication,
  resolveXboxClientBinaryPath,
} = require('./windowsXboxAppxAndMsixvcOrchestrator.cjs');

const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('./macNativeInstallerAndCodesign.cjs')
);
const {
  isExcludedExecutable,
  ensureMacExecutablePermissions,
  resolveTargetMacAppBundlePath,
  readMacBundleIdFromInfoPlist,
  ensureMacAppCodeSignatureValidAsync,
  doesGogInstallUseGalaxySdk,
  resolveMacAppBundleBinary,
  flattenGogNestedInstallDir,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  extractBottleRootFromPath,
  removeSteamAppFromLibraryFoldersVdf,
  cleanupCrossOverSteamShortcuts,
  isValidBottleDirectory,
  listBottleSubdirectories,
  detectCompatibilityLayers,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  resolveSipSafeWineBinaryAndPreloadEnv,
  resolveWineserverBinary,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  sanitizeWinePrefixDisplayConfigs,
  applyCrossOverPerGameSettings,
  ensureCompatibilityLayerReady,
  cleanNonApfsAppleDoubleTwins,
  alignWineMsyncWithLiveBottle,
  prepareCrossOverWineSpawnEnv,
} = macNativeInstallerAndCodesign;

const {
  unregisterEpicFirstPartyLauncher,
  getLegendaryConfigDir,
  ensureLegendaryConfigAndAuth,
  collectLocalEpicMetadataAndSupport,
  resolveEpicAppAndPlatforms,
  performJsonHttpRequest,
  resolveEpicLaunchAuthArguments,
  resolveEpicClientBinaryPath,
} = require('./epicLegendaryAndEosCoordinator.cjs');

const {
  syncGogGameToGalaxy,
  unregisterGogFirstPartyLauncher,
  ensureGogdlAuthConfig,
  ensureGogGalaxyBackgroundService,
  resolveGogGalaxyClientBinaryPath,
  clearStaleGogdlManifestCache,
  fetchGogV1Json,
} = require('./gogRegistryAndDirectInstaller.cjs');

const {
  shutdownDownloadEngine,
  pauseActiveDownloadsForInGame,
  resumeDownloadsPausedByInGame,
} = require('./downloadQueueCoordinator.cjs');
const {
  toWineWindowsPath,
  deleteWineSystemRegKey,
  isBottleWineserverActive,
} = require('./firstPartyRegistration.cjs');
const chainedPublisherLaunchers = /** @type {any} */ (require('./chainedPublisherLaunchers.cjs'));
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
  scanBottlePublisherInstalledGames,
  scanHostPublisherInstalledGames,
  buildChainedLauncherLaunchSpec,
} = chainedPublisherLaunchers;
const { normalizeVaultChainedHandoffId } = require('./offlineVaultService.cjs');
const { parseSteamEaInstallerDataXml } = require('../storefronts/steamLocalScanner.cjs');
const {
  doChainedPublisherTitlesMatch,
  isGdkStubExecutablePath,
  resolveSiblingLauncherStub,
} = require('./installedGameScanner.cjs');

/**
 * Normalize publisher handoff identifiers across both `chainedPublisherLaunchers` and
 * `offlineVaultService` (`'theeaapp'`, `'link2ea'`, `'origin'`, `'eadesktop'`, etc. -> `'ea'`).
 *
 * @param {any} raw
 * @returns {string}
 */
function resolveAnyChainedHandoffId(raw) {
  return normalizeChainedHandoffId(raw) || normalizeVaultChainedHandoffId(raw) || '';
}

const WINE_KNOWN_PATH_EXT_RE =
  /\.(exe|bat|cmd|com|msi|ini|cfg|conf|json|xml|txt|log|sav|dat|pak|pk3|pk4|wad|bsp|map|bik|smk|mpq|vpk|u|unr|dem|mod|dll|asi|bin|iso)$/i;

/**
 * Universally normalizes an argument or target executable path for Wine execution
 * by converting verified POSIX / relative file paths to canonical Windows backslash paths
 * (`Z:\...` or `C:\...`), while preserving URLs, storefront protocol URIs, Win32 CLI flags,
 * and opaque auth/Base64 tokens untouched.
 *
 * @param {string} rawArg
 * @param {string} [winePrefix]
 * @returns {string}
 */
function normalizeWineArgumentBackslashes(rawArg, winePrefix = '') {
  if (!rawArg || typeof rawArg !== 'string') return rawArg;
  const trimmed = rawArg.trim();
  if (!trimmed) return rawArg;

  // 1. Never modify URLs or storefront/custom protocol URIs (`https://...`, `steam://...`, `com.epicgames.launcher://...`, `ms-xbl-...:`)
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ||
    /^(steam|epic|com\.epicgames\.launcher|uplay|origin|ea|link2ea|battlenet|goggalaxy|xbox|ms-xbl-[a-z0-9-]+|mailto):/i.test(
      trimmed
    )
  ) {
    return rawArg;
  }

  // 2. Windows drive path (`C:\Games/SubDir\game.exe` or `D:/Games/bin/app.exe`)
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    if (winePrefix && typeof winePrefix === 'string' && /^[a-zA-Z]:[\\/]/.test(winePrefix.trim())) {
      const normTrimmed = trimmed.replace(/\\/g, '/');
      const normDriveC = `${winePrefix.trim().replace(/\\/g, '/').replace(/\/+$/, '')}/drive_c`;
      if (
        normTrimmed.toLowerCase() === normDriveC.toLowerCase() ||
        normTrimmed.toLowerCase().startsWith(`${normDriveC.toLowerCase()}/`)
      ) {
        const converted = toWineWindowsPath(trimmed, winePrefix);
        return converted ? converted.replace(/\//g, '\\') : trimmed.replace(/\//g, '\\');
      }
    }
    return trimmed.replace(/\//g, '\\');
  }

  // 3. Win32 UNC path (`\\server\share\game.exe`)
  if (trimmed.startsWith('\\\\')) {
    return trimmed;
  }

  // 4. CLI switch with attached value (`-cfg=configs/game.ini`, `/log:logs/game.log`, `-AUTH_PASSWORD=eyJ...`)
  const switchParamMatch = trimmed.match(/^([/-]{1,2}[a-zA-Z0-9_.-]+[:=])(.+)$/);
  if (switchParamMatch) {
    const prefix = switchParamMatch[1];
    const paramVal = switchParamMatch[2];
    const normalizedVal = normalizeWineArgumentBackslashes(paramVal, winePrefix);
    return normalizedVal === paramVal ? rawArg : `${prefix}${normalizedVal}`;
  }

  // 5. Single-segment Win32/POSIX CLI switches (`/nosplash`, `/w`, `-windowed`, `+connect`)
  if (/^[/-][a-zA-Z0-9_?.-]+$/.test(trimmed) || trimmed.startsWith('+')) {
    return rawArg;
  }

  // 6. Absolute POSIX path: convert ONLY when inside `winePrefix`, existing on disk (or parent dir exists),
  // or ending in a known game/config file extension (prevents mangling `/api/v1` or Base64 strings starting with `/`).
  if (trimmed.startsWith('/') && trimmed.includes('/', 1)) {
    const firstSeg = trimmed.slice(1, trimmed.indexOf('/', 1));
    if (!firstSeg.includes(':')) {
      const normalizedPrefix = winePrefix ? path.resolve(winePrefix) : '';
      const resolvedCandidate = path.resolve(trimmed);
      const insidePrefix = Boolean(
        normalizedPrefix &&
          (resolvedCandidate === normalizedPrefix ||
            resolvedCandidate.startsWith(normalizedPrefix + path.sep))
      );
      let existsOrParentExists = false;
      try {
        existsOrParentExists =
          fs.existsSync(trimmed) || fs.existsSync(path.dirname(trimmed));
      } catch {}
      if (insidePrefix || existsOrParentExists || WINE_KNOWN_PATH_EXT_RE.test(trimmed)) {
        const converted = toWineWindowsPath(trimmed, winePrefix);
        return converted ? converted.replace(/\//g, '\\') : trimmed.replace(/\//g, '\\');
      }
    }
    return rawArg;
  }

  // 7. Relative path with forward slashes (`./bin/game.exe`, `../data/level.map`, `System/game.exe`):
  // Require explicit `./` or `../` prefix, a known file extension, or existence on disk so Base64/JWT tokens (`abc/def+ghi=`) are untouched.
  if (!trimmed.startsWith('-') && !trimmed.startsWith('/') && trimmed.includes('/')) {
    const looksLikeExplicitRelPath =
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      WINE_KNOWN_PATH_EXT_RE.test(trimmed);
    const looksLikeBase64OrToken =
      !trimmed.includes(' ') &&
      (/[+=]$/.test(trimmed) || /[A-Za-z0-9+/]{24,}/.test(trimmed)) &&
      !WINE_KNOWN_PATH_EXT_RE.test(trimmed);
    if (!looksLikeBase64OrToken && looksLikeExplicitRelPath) {
      return trimmed.replace(/\//g, '\\');
    }
  }

  return rawArg;
}

/** @type {Map<string, string>} */
const liveBottleDaemonEnvContractByPrefix = new Map();

const DISPLAY_MODE_CHANGED_ERR_TOKEN = 'err:system:display_mode_changed';
const DISPLAY_MODE_EMULATION_RECOMMENDATION =
  'Enable Display Mode Emulation (EmulateModeset) in Launch Configuration';

/**
 * Normalize a Wine/CrossOver bottle prefix path into a canonical lookup key.
 *
 * @param {any} bottlePath
 * @returns {string}
 */
function normalizeBottlePrefixContractKey(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string' || !bottlePath.trim()) return '';
  let resolved = path.resolve(bottlePath.trim());
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch {}
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Clear any recorded warm bottle daemon graphics contract for `bottlePath`.
 *
 * @param {any} bottlePath
 */
function deleteBottleDaemonEnvContract(bottlePath) {
  const key = normalizeBottlePrefixContractKey(bottlePath);
  if (key) {
    liveBottleDaemonEnvContractByPrefix.delete(key);
  }
  if (bottlePath && typeof bottlePath === 'string' && bottlePath.trim()) {
    const rawNorm = path
      .resolve(bottlePath.trim())
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    liveBottleDaemonEnvContractByPrefix.delete(rawNorm);
  }
}

/**
 * Compute canonical graphics & sync environment contract for a bottled session so warm daemons
 * (`Steam.exe`) booted under an incompatible translation backend or sync mode can be recycled cleanly.
 *
 * @param {Record<string, any> | null | undefined} envObj
 * @returns {string}
 */
function computeBottleGraphicsEnvContract(envObj) {
  const src = envObj && typeof envObj === 'object' ? envObj : {};
  return JSON.stringify({
    backend: String(src.CX_GRAPHICS_BACKEND || 'auto').trim().toLowerCase(),
    d3dmMetalFx: String(src.D3DM_ENABLE_METALFX || '0').trim(),
    dxmtNvext: String(src.DXMT_ENABLE_NVEXT || '0').trim(),
    spatial: String(src.DXMT_METALFX_SPATIAL_SWAPCHAIN || '0').trim(),
    dxmtCfg: String(src.DXMT_CONFIG || '').trim(),
    dxvkCfg: String(src.DXVK_CONFIG || '').trim(),
    avx: src.ROSETTA_ADVERTISE_AVX ?? 'unset',
    msync: String(src.WINEMSYNC || '1').trim(),
  });
}

/**
 * Inspect the currently recorded warm daemon graphics contract for `bottlePath` (if any).
 *
 * @param {string} bottlePath
 * @returns {string | undefined}
 */
function getLiveBottleDaemonEnvContract(bottlePath) {
  const key = normalizeBottlePrefixContractKey(bottlePath);
  return key ? liveBottleDaemonEnvContractByPrefix.get(key) : undefined;
}

/**
 * Reset in-memory supervisor daemon contract tracking for deterministic isolated tests.
 */
function resetSupervisorStateForTests() {
  liveBottleDaemonEnvContractByPrefix.clear();
}

/**
 * Prepare an auxiliary Wine / CrossOver command so `WINEMSYNC`, `CX_ENV`, `CX_ROOT`, SIP wrapper
 * resolution, and optional headless GUI dialog suppression stay aligned with any live `wineserver`.
 *
 * @param {{
 *   wineBinary: string,
 *   bottlePath?: string | null,
 *   env?: Record<string, any>,
 *   suppressGuiDialogs?: boolean,
 *   layerType?: string | null,
 * }} params
 * @returns {{ binaryPath: string, env: Record<string, any> }}
 */
function prepareAlignedAuxBottleWineCommand(params) {
  const {
    wineBinary = '',
    bottlePath = '',
    env: inputEnv = {},
    suppressGuiDialogs = false,
    layerType,
  } = params || {};
  const workingEnv = inputEnv && typeof inputEnv === 'object' ? inputEnv : {};
  if (typeof macNativeInstallerAndCodesign.prepareAlignedBottleWineCommand === 'function') {
    const res = macNativeInstallerAndCodesign.prepareAlignedBottleWineCommand({
      wineBinary,
      bottlePath: bottlePath || workingEnv.WINEPREFIX || '',
      env: workingEnv,
      suppressGuiDialogs,
      layerType,
    });
    const resolvedFromHelper =
      res && typeof res.wineBinary === 'string' && res.wineBinary
        ? res.wineBinary
        : res && typeof res.binaryPath === 'string' && res.binaryPath
          ? res.binaryPath
          : '';
    if (resolvedFromHelper) {
      return {
        binaryPath: resolvedFromHelper,
        env: res.env && typeof res.env === 'object' ? res.env : workingEnv,
      };
    }
  }
  const effectivePrefix = String(bottlePath || workingEnv.WINEPREFIX || '').trim();
  if (effectivePrefix) {
    workingEnv.WINEPREFIX = workingEnv.WINEPREFIX || effectivePrefix;
    alignWineMsyncWithLiveBottle(effectivePrefix, workingEnv);
  }
  if (suppressGuiDialogs) {
    const disableSpec = 'mscoree,mshtml=d;winemenubuilder.exe=d';
    const curDll = String(workingEnv.WINEDLLOVERRIDES || '').trim();
    if (!curDll) {
      workingEnv.WINEDLLOVERRIDES = disableSpec;
    } else if (!curDll.includes('winemenubuilder.exe=d')) {
      workingEnv.WINEDLLOVERRIDES = `${curDll};${disableSpec}`;
    }
    if (!workingEnv.WINEDEBUG) {
      workingEnv.WINEDEBUG = '-all';
    }
  }
  const resolvedBin =
    typeof prepareCrossOverWineSpawnEnv === 'function'
      ? prepareCrossOverWineSpawnEnv(wineBinary, workingEnv, {
          ...(layerType ? { layerType } : {}),
        })
      : resolveSipSafeWineBinaryAndPreloadEnv(wineBinary, workingEnv, {
          ...(layerType ? { layerType } : {}),
        });
  return {
    binaryPath: resolvedBin || wineBinary,
    env: workingEnv,
  };
}

/**
 * Remove specific environment variable assignments from a CrossOver `CX_ENV` string while
 * preserving all remaining quoted or unquoted tokens cleanly.
 *
 * @param {string | undefined | null} cxEnvStr
 * @param {string[]} keysToRemove
 * @returns {string}
 */
function stripKeysFromCxEnv(cxEnvStr, keysToRemove) {
  if (!cxEnvStr || typeof cxEnvStr !== 'string') return '';
  const removeSet = new Set(
    (Array.isArray(keysToRemove) ? keysToRemove : []).map((k) => String(k || '').trim())
  );
  if (removeSet.size === 0) return cxEnvStr;
  /** @type {string[]} */
  const tokens = [];
  let i = 0;
  const n = cxEnvStr.length;
  while (i < n) {
    while (i < n && /\s/.test(cxEnvStr[i])) i += 1;
    if (i >= n) break;
    const start = i;
    let inSingle = false;
    let inDouble = false;
    while (i < n) {
      const ch = cxEnvStr[i];
      if (ch === '\\' && !inSingle && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        i += 1;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        i += 1;
        continue;
      }
      if (!inSingle && !inDouble && /\s/.test(ch)) {
        break;
      }
      i += 1;
    }
    const rawTok = cxEnvStr.slice(start, i);
    const eqIdx = rawTok.indexOf('=');
    const key = eqIdx > 0 ? rawTok.slice(0, eqIdx).trim() : '';
    if (!key || !removeSet.has(key)) {
      tokens.push(rawTok);
    }
  }
  return tokens.join(' ');
}

const DISPLAY_SCALER_ENV_KEYS = Object.freeze([
  'ONE_LAUNCHER_DISPLAY_SCALING_MODE',
  'ONE_LAUNCHER_DISPLAY_ASPECT',
  'ONE_LAUNCHER_SAFE_INSET_TOP',
  'ONE_LAUNCHER_FULLSCREEN_HOTKEY',
  'ONE_LAUNCHER_SCALER_DLL_X86',
  'ONE_LAUNCHER_SCALER_DLL_X64',
  'ONE_LAUNCHER_LAUNCHER_EXE_X86',
  'ONE_LAUNCHER_LAUNCHER_EXE_X64',
  'ONE_LAUNCHER_DISPLAY_CONTROL_FILE',
  'ONE_LAUNCHER_DISPLAY_STATUS_FILE',
]);

const VALID_DISPLAY_ASPECT_MODES = new Set(['preserve_aspect', 'stretch', 'integer']);

/**
 * Resolve a bundled Win32 display scaler helper binary (`one_display_scaler_{x86,x64}.dll` or
 * `one_display_launcher_{x86,x64}.exe`) across dev, unpacked ASAR, and test overrides.
 *
 * @param {string} fileName
 * @param {Record<string, any> | null | undefined} [options]
 * @returns {string}
 */
function resolveBundledDisplayScalerBinPath(fileName, options = {}) {
  if (!fileName || typeof fileName !== 'string') return '';
  const customDir = String(
    options?.displayScalerBinDir || process.env.ONE_LAUNCHER_DISPLAY_SCALER_BIN_DIR || ''
  ).trim();
  const rawLocalBin = path.join(__dirname, '..', 'helpers', 'bin', fileName);
  const unpackedLocalBin = rawLocalBin.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
  const candidates = [
    customDir ? path.join(customDir, fileName) : '',
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          fileName
        )
      : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'helpers', 'bin', fileName) : '',
    unpackedLocalBin !== rawLocalBin ? unpackedLocalBin : '',
    rawLocalBin,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

/**
 * Stage the universal Win32 display scaler DLLs and launcher EXEs into
 * `<targetWinePrefix>/drive_c/ProgramData/OneLauncher/display_scaler/`, copying only when missing
 * or changed so warm launches perform zero redundant disk writes.
 *
 * @param {string} targetWinePrefix
 * @param {Record<string, any> | null | undefined} [options]
 */
function stageBottleDisplayScalerBinaries(targetWinePrefix, options = {}) {
  const stageDirPosix = targetWinePrefix
    ? path.join(targetWinePrefix, 'drive_c', 'ProgramData', 'OneLauncher', 'display_scaler')
    : '';
  const winStageRoot = 'C:\\ProgramData\\OneLauncher\\display_scaler';
  const result = {
    stageDirPosix,
    allPresent: false,
    dllX86Posix: '',
    dllX64Posix: '',
    launcherX86Posix: '',
    launcherX64Posix: '',
    winDllX86: `${winStageRoot}\\one_display_scaler_x86.dll`,
    winDllX64: `${winStageRoot}\\one_display_scaler_x64.dll`,
    winLauncherX86: `${winStageRoot}\\one_display_launcher_x86.exe`,
    winLauncherX64: `${winStageRoot}\\one_display_launcher_x64.exe`,
  };
  if (!stageDirPosix || !fs.existsSync(targetWinePrefix)) {
    return result;
  }

  try {
    fs.mkdirSync(stageDirPosix, { recursive: true });
  } catch {
    return result;
  }

  /** @type {Array<{ prop: 'dllX86Posix' | 'dllX64Posix' | 'launcherX86Posix' | 'launcherX64Posix', fileName: string }>} */
  const specs = [
    { prop: 'dllX86Posix', fileName: 'one_display_scaler_x86.dll' },
    { prop: 'dllX64Posix', fileName: 'one_display_scaler_x64.dll' },
    { prop: 'launcherX86Posix', fileName: 'one_display_launcher_x86.exe' },
    { prop: 'launcherX64Posix', fileName: 'one_display_launcher_x64.exe' },
  ];

  for (const { prop, fileName } of specs) {
    const srcPath = resolveBundledDisplayScalerBinPath(fileName, options);
    const dstPath = path.join(stageDirPosix, fileName);
    if (!srcPath) {
      try {
        if (fs.existsSync(dstPath) && fs.statSync(dstPath).isFile()) {
          result[prop] = dstPath;
        }
      } catch {}
      continue;
    }
    try {
      const srcStat = fs.statSync(srcPath);
      let needsCopy = true;
      if (fs.existsSync(dstPath)) {
        try {
          const dstStat = fs.statSync(dstPath);
          if (
            dstStat.isFile() &&
            dstStat.size === srcStat.size &&
            Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1000
          ) {
            needsCopy = false;
          }
        } catch {}
      }
      if (needsCopy) {
        const tmpDst = `${dstPath}.tmp-${process.pid}-${Date.now()}`;
        fs.copyFileSync(srcPath, tmpDst);
        try {
          fs.chmodSync(tmpDst, 0o755);
        } catch {}
        try {
          fs.utimesSync(tmpDst, srcStat.atime, srcStat.mtime);
        } catch {}
        fs.renameSync(tmpDst, dstPath);
      }
      result[prop] = dstPath;
    } catch {}
  }

  result.allPresent = Boolean(
    result.dllX86Posix &&
      result.dllX64Posix &&
      result.launcherX86Posix &&
      result.launcherX64Posix
  );
  return result;
}

/**
 * Compute top notch safe-area inset (`0..80` px) on the primary macOS display so borderless
 * fullscreen viewports never clip HUD text under MacBook Pro/Air camera housings.
 *
 * @param {boolean} [highResMode]
 * @param {Record<string, any> | null | undefined} [options]
 * @returns {number}
 */
function computeMacPrimaryDisplaySafeInsetTop(highResMode = false, options = {}) {
  if (typeof options?.safeInsetTop === 'number' && Number.isFinite(options.safeInsetTop)) {
    return Math.max(0, Math.min(80, Math.round(options.safeInsetTop)));
  }
  try {
    const electronMod = getElectron();
    const primary = electronMod?.screen?.getPrimaryDisplay?.();
    if (primary && primary.bounds && primary.workArea) {
      const boundsY = Number(primary.bounds.y) || 0;
      const workAreaY = Number(primary.workArea.y) || 0;
      const topMenuHeight = boundsY === 0 ? Math.max(0, workAreaY - boundsY) : 0;
      const notchLogical = topMenuHeight > 28 ? topMenuHeight : 0;
      if (notchLogical <= 0) return 0;
      const scale = highResMode ? Math.max(1, Number(primary.scaleFactor) || 1) : 1;
      return Math.max(0, Math.min(80, Math.round(notchLogical * scale)));
    }
  } catch {}
  return 0;
}

/**
 * Decide whether a bottled macOS session should wrap with `one_display_launcher`:
 * - `'windowed'` / `'virtual_desktop'` -> never wrap (`false`)
 * - `'force_fullscreen'` -> always wrap (`true`)
 * - `'auto_fullscreen'` -> skip modern 64-bit self-scaling D3D11/D3D12/Vulkan/SDL2+ titles so
 *   D3DMetal/DXMT/MoltenVK run unhooked; wrap all 32-bit, legacy DDraw/D3D8/D3D9, OpenGL, GDI,
 *   SDL1, and launcher-stub titles (`true`).
 *
 * @param {Record<string, any> | null | undefined} effectiveCaps
 * @param {string} effectiveDisplayScalingMode
 * @returns {boolean}
 */
function shouldWrapBottleSessionWithDisplayLauncher(effectiveCaps, effectiveDisplayScalingMode) {
  if (
    effectiveDisplayScalingMode === 'windowed' ||
    effectiveDisplayScalingMode === 'virtual_desktop' ||
    effectiveDisplayScalingMode === 'off'
  ) {
    return false;
  }
  if (effectiveDisplayScalingMode === 'force_fullscreen') {
    return true;
  }
  if (
    effectiveDisplayScalingMode !== 'auto_fullscreen' &&
    effectiveDisplayScalingMode !== 'auto'
  ) {
    return false;
  }
  const isModernSelfScaling64Bit = Boolean(
    effectiveCaps &&
      !effectiveCaps.is32Bit &&
      effectiveCaps.is64Bit &&
      (effectiveCaps.importsD3d12 ||
        effectiveCaps.importsD3d11Or10 ||
        effectiveCaps.importsVulkan ||
        effectiveCaps.importsModernSdl) &&
      !effectiveCaps.usesLegacyDirectDrawOrD3d &&
      !effectiveCaps.usesOpenGl &&
      !effectiveCaps.importsSdl1 &&
      !effectiveCaps.isLauncherStubCandidate
  );
  return !isModernSelfScaling64Bit;
}

/**
 * Format the `display_ctl_<sessionId>.ini` control file consumed by `one_display_scaler`.
 * Interface Contract 1: display_ctl writes safe_inset_top = 0 under universal fullscreen.
 *
 * @param {number} seq
 * @param {boolean} fullscreen
 * @param {string} aspect
 * @param {number} [safeInsetTop=0]
 * @returns {string}
 */
function formatDisplayScalerControlIni(seq, fullscreen, aspect, safeInsetTop = 0) {
  const safeSeq = Math.max(1, Math.floor(Number(seq) || 1));
  const safeAspect = VALID_DISPLAY_ASPECT_MODES.has(aspect) ? aspect : 'preserve_aspect';
  let safe_inset_top = 0;
  if (typeof safeInsetTop === 'number' && Number.isFinite(safeInsetTop)) {
    safe_inset_top = Math.max(0, Math.min(80, Math.round(safeInsetTop)));
  }
  return `seq=${safeSeq}\nfullscreen=${fullscreen ? 1 : 0}\naspect=${safeAspect}\nsafe_inset_top=${safe_inset_top}\n`;
}

/**
 * Clean background storefront daemon (`GalaxyClient.exe` / `EpicGamesLauncher.exe`) wake env so
 * game-specific HUD overlays and 32-bit auto-routed `CX_GRAPHICS_BACKEND` overrides never pollute
 * 64-bit background CEF/client helper processes.
 *
 * @param {Record<string, any>} clientEnv
 * @param {Record<string, any> | null | undefined} launchConfig
 */
function sanitizeBottleBackgroundClientWakeEnv(clientEnv, launchConfig) {
  if (!clientEnv || typeof clientEnv !== 'object') return;
  delete clientEnv.MTL_HUD_ENABLED;
  delete clientEnv.DXVK_HUD;
  delete clientEnv.ONE_LAUNCHER_MOLTENVK_PATH;
  const keysToStrip = ['MTL_HUD_ENABLED', 'DXVK_HUD', ...DISPLAY_SCALER_ENV_KEYS];
  for (const dispKey of DISPLAY_SCALER_ENV_KEYS) {
    delete clientEnv[dispKey];
  }
  if (
    (launchConfig?.crossoverGraphicsBackend === undefined ||
      launchConfig?.crossoverGraphicsBackend === 'auto') &&
    !launchConfig?.environmentVariables?.CX_GRAPHICS_BACKEND
  ) {
    delete clientEnv.CX_GRAPHICS_BACKEND;
    delete clientEnv.WINED3DMETAL;
    keysToStrip.push('CX_GRAPHICS_BACKEND', 'WINED3DMETAL');
  }
  if (typeof clientEnv.CX_ENV === 'string' && clientEnv.CX_ENV) {
    const cleaned = stripKeysFromCxEnv(clientEnv.CX_ENV, keysToStrip);
    if (cleaned) {
      clientEnv.CX_ENV = cleaned;
    } else {
      delete clientEnv.CX_ENV;
    }
  }
}

/**
 * Guard against the Apple `libMTLHud.dylib` + older `libMoltenVK.dylib` static-initializer Thread 0
 * deadlock. When the Wine loader allows `DYLD_INSERT_LIBRARIES`, inject `libone_metal_preload.dylib`;
 * when Hardened Runtime / AMFI strips `DYLD_INSERT_LIBRARIES`, suppress `MTL_HUD_ENABLED` and fall
 * back to `DXVK_HUD` when running on DXVK / open-source Wine.
 *
 * @param {any} chosenLayer
 * @param {Record<string, any>} env
 * @param {Record<string, any> | null | undefined} launchConfig
 * @param {Record<string, any> | null | undefined} options
 * @param {string} [gameId]
 */
function applyMoltenVkMetalHudDeadlockGuard(chosenLayer, env, launchConfig, options, gameId = '') {
  if (
    !env ||
    env.MTL_HUD_ENABLED !== '1' ||
    !chosenLayer?.binaryPath ||
    !doesWineLayerHaveMoltenVkHudDeadlock(chosenLayer.binaryPath)
  ) {
    return;
  }
  const allowsDyldInsert =
    typeof macNativeInstallerAndCodesign.doesWineLoaderAllowDyldInsert === 'function'
      ? Boolean(macNativeInstallerAndCodesign.doesWineLoaderAllowDyldInsert(chosenLayer.binaryPath))
      : true;
  if (!allowsDyldInsert) {
    delete env.MTL_HUD_ENABLED;
    delete env.ONE_LAUNCHER_MOLTENVK_PATH;
    const audioClampActive =
      options?.enableAudioBufferClamp === true || launchConfig?.audioBufferClamp === true;
    const hasCustomUserDyldInsert = Boolean(launchConfig?.environmentVariables?.DYLD_INSERT_LIBRARIES);
    if (!audioClampActive && env.DYLD_INSERT_LIBRARIES) {
      const remainingInsert = String(env.DYLD_INSERT_LIBRARIES)
        .split(/:(?![\\/])/)
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith('libone_metal_preload.dylib'));
      if (remainingInsert.length > 0) {
        env.DYLD_INSERT_LIBRARIES = remainingInsert.join(':');
      } else {
        delete env.DYLD_INSERT_LIBRARIES;
      }
    }
    if (typeof env.CX_ENV === 'string' && env.CX_ENV) {
      const cxKeysToStrip =
        audioClampActive || hasCustomUserDyldInsert
          ? ['MTL_HUD_ENABLED']
          : ['MTL_HUD_ENABLED', 'DYLD_INSERT_LIBRARIES'];
      const cleanedCxEnv = stripKeysFromCxEnv(env.CX_ENV, cxKeysToStrip);
      if (cleanedCxEnv) {
        env.CX_ENV = cleanedCxEnv;
      } else {
        delete env.CX_ENV;
      }
    }
    if (!env.DXVK_HUD && (env.CX_GRAPHICS_BACKEND === 'dxvk' || chosenLayer.type === 'wine')) {
      env.DXVK_HUD = 'devinfo,fps,frametimes';
    }
    diagLog.warn('launchGame.suppressedDeadlockingMetalHudUnderHardenedRuntime', {
      gameId: gameId || undefined,
      binaryPath: chosenLayer.binaryPath,
      layerType: chosenLayer.type,
    });
    return;
  }

  const preloadDylib = ensureWineMetalPreloadDylib(options || {});
  const moltenVkPath = resolveWineLayerMoltenVkPath(chosenLayer.binaryPath);
  if (preloadDylib) {
    const existingInsert = String(env.DYLD_INSERT_LIBRARIES || '')
      .split(/:(?![\\/])/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!existingInsert.includes(preloadDylib)) {
      existingInsert.unshift(preloadDylib);
    }
    env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
    resolveSipSafeWineBinaryAndPreloadEnv(chosenLayer.binaryPath, env, {
      layerType: chosenLayer?.type,
    });
    if (moltenVkPath) {
      env.ONE_LAUNCHER_MOLTENVK_PATH = moltenVkPath;
    }
  } else {
    delete env.MTL_HUD_ENABLED;
  }
}

/**
 * Append a game `stderr` chunk to `entry.stderrBuffer` and count `err:system:display_mode_changed`
 * occurrences across chunk boundaries on bottled launches.
 *
 * @param {any} entry
 * @param {any} chunk
 */
function recordBottledStderrChunk(entry, chunk) {
  const text = String(chunk ?? '');
  if (!text || !entry) return;
  if (entry.stderrBuffer.length < 4096) {
    entry.stderrBuffer += text;
  }
  const isBottled = Boolean(
    entry.winePrefix ||
      entry.wineBinary ||
      String(entry.session?.launchMethod || '').startsWith('compatibility_layer')
  );
  if (!isBottled) return;
  const combined = `${entry.stderrCarryover || ''}${text}`.toLowerCase();
  let idx = 0;
  while (true) {
    const found = combined.indexOf(DISPLAY_MODE_CHANGED_ERR_TOKEN, idx);
    if (found === -1) break;
    entry.displayModeChangedErrorCount = Number(entry.displayModeChangedErrorCount || 0) + 1;
    idx = found + DISPLAY_MODE_CHANGED_ERR_TOKEN.length;
  }
  const carryStart = Math.max(idx, combined.length - (DISPLAY_MODE_CHANGED_ERR_TOKEN.length - 1));
  entry.stderrCarryover = combined.slice(carryStart);
}

/** @type {((options?: any) => any) | null} */
let cachedSupervisorGetSetupWizardState = null;

function getSupervisorSetupWizardState(/** @type {any} */ options = {}) {
  try {
    if (!cachedSupervisorGetSetupWizardState) {
      const proberMod = /** @type {any} */ (require('./environmentHealthProber.cjs'));
      cachedSupervisorGetSetupWizardState = proberMod.getSetupWizardState;
    }
    return typeof cachedSupervisorGetSetupWizardState === 'function'
      ? cachedSupervisorGetSetupWizardState(options)
      : null;
  } catch {
    return null;
  }
}

/**
 * Check whether Paradox Launcher v2 MSI is installed inside a macOS Wine/CrossOver bottle.
 *
 * @param {string | null | undefined} bottlePath
 * @returns {boolean}
 */
function hasParadoxLauncherInstalledInBottle(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string') return false;
  const usersDir = path.join(bottlePath, 'drive_c', 'users');
  try {
    if (!fs.existsSync(usersDir)) return false;
    const userEntries = fs.readdirSync(usersDir, { withFileTypes: true }).slice(0, 16);
    for (const uEntry of userEntries) {
      if (!uEntry.isDirectory() || /^public$/i.test(uEntry.name)) continue;
      const pdxRoot = path.join(
        usersDir,
        uEntry.name,
        'AppData',
        'Local',
        'Programs',
        'Paradox Interactive'
      );
      if (!fs.existsSync(pdxRoot)) continue;
      if (fs.existsSync(path.join(pdxRoot, 'launcherpath'))) return true;
      const pdxChildren = fs.readdirSync(pdxRoot, { withFileTypes: true }).slice(0, 24);
      if (
        pdxChildren.some(
          (c) =>
            (c.isDirectory() && /^launcher-v2/i.test(c.name)) ||
            (c.isFile() && /^paradox launcher\.exe$/i.test(c.name))
        )
      ) {
        return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Strip EA App / Origin autostart keys (`"EADM"`, `"Origin"`) from `[Software\Microsoft\Windows\CurrentVersion\Run]`
 * and reset `"startOnBootFlag"=dword:00000000` in `<bottlePath>/user.reg` so shared CrossOver/Wine bottles
 * (`OneLauncher`, `Steam`) never auto-spawn `EALauncher.exe -silent` during unrelated game sessions.
 *
 * @param {string | null | undefined} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function sanitizeEaBottleAutostartFallback(bottlePath, options = {}) {
  if (!bottlePath || typeof bottlePath !== 'string') return false;
  let mutated = false;
  if (typeof chainedPublisherLaunchers.sanitizeEaBottleAutostartInUserReg === 'function') {
    try {
      if (chainedPublisherLaunchers.sanitizeEaBottleAutostartInUserReg(bottlePath, options)) {
        mutated = true;
      }
    } catch {}
  }

  try {
    const userRegPath = path.join(bottlePath, 'user.reg');
    if (fs.existsSync(userRegPath)) {
      const original = fs.readFileSync(userRegPath, 'utf8');
      const lines = original.split(/\r?\n/);
      /** @type {string[]} */
      const out = [];
      let inCurrentVersionRun = false;
      let changedReg = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.includes(']')) {
          const headerInner = trimmed
            .slice(1, trimmed.indexOf(']'))
            .replace(/\\\\+/g, '\\')
            .toLowerCase();
          inCurrentVersionRun =
            headerInner === 'software\\microsoft\\windows\\currentversion\\run' ||
            headerInner === 'software\\wow6432node\\microsoft\\windows\\currentversion\\run';
          out.push(line);
          continue;
        }
        if (inCurrentVersionRun && /^"(?:eadm|origin)"\s*=/i.test(trimmed)) {
          changedReg = true;
          continue;
        }
        if (/^"startOnBootFlag"\s*=\s*dword:0*1\s*$/i.test(trimmed)) {
          out.push(line.replace(/dword:0*1/i, 'dword:00000000'));
          changedReg = true;
          continue;
        }
        out.push(line);
      }
      if (changedReg) {
        atomicWriteFileSync(userRegPath, out.join('\n'));
        mutated = true;
      }
    }
  } catch {}

  return mutated;
}

/**
 * Map apublisher `handoffId` to its foreground UI process regex (excluding headless background services
 * such as `EABackgroundService.exe` and Battle.net `Agent.exe`).
 *
 * @param {string} handoffId
 * @returns {RegExp | null}
 */
function getPublisherForegroundUiRegex(handoffId) {
  const norm = resolveAnyChainedHandoffId(handoffId);
  if (norm === 'ea') return /(?:^|[\\/\s"'])(?:eadesktop|ealauncher|origin)\.exe\b/i;
  if (norm === 'ubisoft') return /(?:^|[\\/\s"'])(?:upc|ubisoftconnect|ubisoftgamelauncher)\.exe\b/i;
  if (norm === 'bnet') return /(?:^|[\\/\s"'])battle\.net(?:\s+launcher)?\.exe\b/i;
  if (norm === 'rockstar') return /(?:^|[\\/\s"'])(?:launcher|rockstarservice)\.exe\b/i;
  if (norm === 'riot') return /(?:^|[\\/\s"'])(?:riotclientservices|riotclientux)\.exe\b/i;
  return null;
}

/**
 * Non-blocking check whether a publisher foreground UI client is already running in `bottlePath`.
 *
 * @param {string | null | undefined} bottlePath
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
function checkBottlePublisherUiRunningAsync(bottlePath, handoffId, options = {}) {
  const uiRe = getPublisherForegroundUiRegex(handoffId);
  if (!bottlePath || !uiRe) return Promise.resolve(false);
  if (typeof options.mockProcessListOutput === 'string') {
    return Promise.resolve(uiRe.test(options.mockProcessListOutput));
  }
  if (typeof options.getProcessListOutput === 'function') {
    return Promise.resolve(options.getProcessListOutput())
      .then((out) => uiRe.test(String(out || '')))
      .catch(() => false);
  }
  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  if (
    isTestEnvironment(options) &&
    execFileImpl === execFile &&
    options.allowProcessCheckInTest !== true
  ) {
    return Promise.resolve(false);
  }
  const resolvedBottleLower = path.resolve(bottlePath).replace(/\\/g, '/').toLowerCase();
  return new Promise((resolve) => {
    try {
      execFileImpl('ps', ['eww', '-axo', 'command='], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(false);
        for (const rawLine of String(stdout).split(/\r?\n/)) {
          const normLine = rawLine.replace(/\\/g, '/');
          if (!uiRe.test(normLine)) continue;
          const lower = normLine.toLowerCase();
          if (
            lower.includes(resolvedBottleLower) ||
            !/\/bottles\//i.test(lower)
          ) {
            return resolve(true);
          }
        }
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Non-blocking check whether a publisher foreground UI client is already running on Windows (`win32`).
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
function checkHostWinPublisherUiRunningAsync(handoffId, options = {}) {
  const uiRe = getPublisherForegroundUiRegex(handoffId);
  if (!uiRe) return Promise.resolve(false);
  if (typeof options.mockProcessListOutput === 'string') {
    return Promise.resolve(uiRe.test(options.mockProcessListOutput));
  }
  if (typeof options.getProcessListOutput === 'function') {
    return Promise.resolve(options.getProcessListOutput())
      .then((out) => uiRe.test(String(out || '')))
      .catch(() => false);
  }
  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  if (
    isTestEnvironment(options) &&
    execFileImpl === execFile &&
    options.allowProcessCheckInTest !== true
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'tasklist.exe',
        ['/FO', 'CSV', '/NH'],
        { timeout: 2000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve(false);
          resolve(uiRe.test(String(stdout)));
        }
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Verify that a host Windows (`win32`) directory is a dedicated EA game leaf folder (and NEVER
 * `EA Desktop`, `Electronic Arts`, `EA Games` container root, `Origin`, or a system folder).
 *
 * @param {string} localInstall
 * @param {any} eaInstallerXmlMeta
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isSafeHostEaGameDirToDelete(localInstall, eaInstallerXmlMeta, options = {}) {
  if (!localInstall || !isSafeToDeleteInstallPath(localInstall, options)) return false;
  const norm = toHostFilesystemPath(localInstall).replace(/\\/g, '/').replace(/\/+$/, '');
  const segs = norm.split('/').filter(Boolean);
  if (segs.length < 3) return false;
  const leafLower = segs[segs.length - 1].toLowerCase();
  const parentLower = segs[segs.length - 2].toLowerCase();
  if (
    /^(?:ea desktop|electronic arts|ea games|origin|origin games|games|program files|program files \(x86\)|windows|users|programdata|steam|steamapps|common)$/i.test(
      leafLower
    )
  ) {
    return false;
  }
  if (/\/electronic arts\/ea desktop(?:\/|$)/i.test(norm)) {
    return false;
  }
  if (eaInstallerXmlMeta && eaInstallerXmlMeta.isEaInstaller) {
    return true;
  }
  return parentLower === 'ea games' || parentLower === 'origin games';
}

/**
 * Convert a Wine registry path (`C:\...` or `Z:\...`) into its resolved host path inside `bottleRoot`.
 *
 * @param {string} bottleRoot
 * @param {string} rawWinePath
 * @returns {string}
 */
function wineRegistryInstallDirToPosix(bottleRoot, rawWinePath) {
  const cleaned = String(rawWinePath || '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/\\\\/g, '\\');
  if (!cleaned) return '';
  if (/^[cC]:[\\/]/.test(cleaned)) {
    const rel = cleaned.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
    return path.resolve(bottleRoot, 'drive_c', rel);
  }
  if (/^[zZ]:[\\/]/.test(cleaned)) {
    const rel = cleaned.slice(2).replace(/\\/g, '/');
    return path.resolve(rel.startsWith('/') ? rel : `/${rel}`);
  }
  if (cleaned.startsWith('/')) {
    return path.resolve(cleaned);
  }
  return '';
}

/**
 * Remove EA Games / Origin Games / Uninstall registry keys inside `<bottleRoot>/system.reg` whose
 * `Install Dir` or `InstallLocation` resolves strictly to `targetInstallPath` (preserving sibling EA games
 * and `EA Desktop`), sanitize shared-bottle EA autostart, and stop idle `EABackgroundService.exe` in `bottleRoot`.
 *
 * @param {string} bottleRoot
 * @param {string} targetInstallPath
 * @param {{ externalInstallId?: string, eaInstallerXmlMeta?: any, epicPartnerRegistryPath?: string }} meta
 * @param {Record<string, any>} [options]
 */
function cleanupBottleEaGameRegistryAndDaemons(bottleRoot, targetInstallPath, meta = {}, options = {}) {
  if (!bottleRoot || !fs.existsSync(bottleRoot)) return;
  const resolvedTarget = targetInstallPath ? path.resolve(targetInstallPath) : '';
  const systemRegPath = path.join(bottleRoot, 'system.reg');
  if (resolvedTarget && fs.existsSync(systemRegPath)) {
    try {
      const regContent = fs.readFileSync(systemRegPath, 'utf8');
      const lines = regContent.split(/\r?\n/);
      /** @type {Set<string>} */
      const keysToDelete = new Set();
      let currentKey = '';
      /** @type {string[]} */
      let currentInstallCandidates = [];

      const flushSection = () => {
        if (!currentKey || currentInstallCandidates.length === 0) return;
        const normKeyLower = currentKey.toLowerCase();
        const isEaOrUninstallSubkey =
          /^software\\(?:wow6432node\\)?(?:ea games|origin games)\\[^\\]+/.test(normKeyLower) ||
          /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/.test(
            normKeyLower
          );
        if (!isEaOrUninstallSubkey) return;
        if (/\\ea desktop(?:\\|$)/i.test(normKeyLower)) return;
        for (const rawDir of currentInstallCandidates) {
          const candidatePosix = wineRegistryInstallDirToPosix(bottleRoot, rawDir);
          if (candidatePosix && candidatePosix === resolvedTarget) {
            keysToDelete.add(currentKey);
            break;
          }
        }
      };

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.includes(']')) {
          flushSection();
          currentKey = trimmed.slice(1, trimmed.indexOf(']')).replace(/\\\\+/g, '\\');
          currentInstallCandidates = [];
          continue;
        }
        if (!currentKey) continue;
        const m = trimmed.match(/^"(Install Dir|InstallLocation)"\s*=\s*"((?:[^"\\]|\\.)*)"/i);
        if (m && m[2]) {
          currentInstallCandidates.push(m[2]);
        }
      }
      flushSection();

      for (const regKey of keysToDelete) {
        try {
          deleteWineSystemRegKey(bottleRoot, regKey, options);
        } catch {}
      }
    } catch (err) {
      diagLog.warn('uninstallGame.cleanupBottleEaGameRegistry', err, {
        bottleRoot,
        targetInstallPath,
      });
    }
  }

  sanitizeEaBottleAutostartFallback(bottleRoot, options);

  const resolvedBottle = path.resolve(bottleRoot);
  const bottleBusy = Array.from(activeSessions.values()).some(
    (s) => s && !s.finalized && s.winePrefix && path.resolve(s.winePrefix) === resolvedBottle
  );
  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  if (
    !bottleBusy &&
    (!isTestEnvironment(options) || execFileImpl !== execFile)
  ) {
    try {
      const bottleLower = resolvedBottle.replace(/\\/g, '/').toLowerCase();
      execFileImpl('ps', ['eww', '-axo', 'pid=,command='], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return;
        for (const rawLine of String(stdout).split(/\r?\n/)) {
          const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) continue;
          const cPid = Number.parseInt(m[1], 10);
          const cmdNorm = m[2].replace(/\\/g, '/').toLowerCase();
          if (
            cPid > 1 &&
            cPid !== process.pid &&
            cmdNorm.includes('eabackgroundservice.exe') &&
            cmdNorm.includes(bottleLower)
          ) {
            try {
              process.kill(cPid, 'SIGTERM');
            } catch {}
          }
        }
      });
    } catch {}
  }
}

/**
 * Asynchronously remove Windows (`win32`) `EA Games`, `Origin Games`, and `{ContentID}` Uninstall
 * registry subkeys whose `Install Dir` / `InstallLocation` resolves strictly to `targetInstallPath`.
 *
 * @param {string} targetInstallPath
 * @param {{ externalInstallId?: string, eaInstallerXmlMeta?: any }} meta
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function cleanupWindowsEaGameRegistryAsync(targetInstallPath, meta = {}, options = {}) {
  if (!targetInstallPath) return;
  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  if (isTestEnvironment(options) && execFileImpl === execFile) return;

  const normTarget = toHostFilesystemPath(targetInstallPath)
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
  if (!normTarget) return;

  const queryRegKey = (/** @type {string} */ keyPath) =>
    new Promise((resolve) => {
      try {
        execFileImpl(
          'reg.exe',
          ['query', keyPath, '/s'],
          { timeout: 3500, windowsHide: true },
          (err, stdout) => resolve(err ? '' : String(stdout || ''))
        );
      } catch {
        resolve('');
      }
    });

  const deleteRegKey = (/** @type {string} */ keyPath) =>
    new Promise((resolve) => {
      try {
        execFileImpl(
          'reg.exe',
          ['delete', keyPath, '/f'],
          { timeout: 3500, windowsHide: true },
          () => resolve(undefined)
        );
      } catch {
        resolve(undefined);
      }
    });

  const roots = [
    'HKLM\\SOFTWARE\\EA Games',
    'HKLM\\SOFTWARE\\WOW6432Node\\EA Games',
    'HKLM\\SOFTWARE\\Origin Games',
    'HKLM\\SOFTWARE\\WOW6432Node\\Origin Games',
  ];
  const candidateContentIds = new Set();
  if (meta.externalInstallId) candidateContentIds.add(String(meta.externalInstallId).trim());
  if (Array.isArray(meta.eaInstallerXmlMeta?.contentIds)) {
    for (const cid of meta.eaInstallerXmlMeta.contentIds) {
      if (cid) candidateContentIds.add(String(cid).trim());
    }
  }
  for (const cid of candidateContentIds) {
    if (!/^[A-Za-z0-9._-]+$/.test(cid)) continue;
    roots.push(
      `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${cid}}`,
      `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${cid}}`
    );
  }

  /** @type {Set<string>} */
  const matchedKeys = new Set();
  for (const rootKey of roots) {
    const out = await queryRegKey(rootKey);
    if (!out) continue;
    let currentSubkey = '';
    for (const rawLine of out.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (/^HKEY_/i.test(trimmed)) {
        currentSubkey = trimmed;
        continue;
      }
      if (!currentSubkey || currentSubkey.toLowerCase() === rootKey.replace(/^HKLM\\/i, 'hkey_local_machine\\').toLowerCase()) {
        // Note: for direct Uninstall\{cid} queries, currentSubkey equals the queried leaf key itself
        if (!/\\uninstall\\\{/i.test(currentSubkey)) continue;
      }
      const valMatch = trimmed.match(/^(?:Install Dir|InstallLocation)\s+REG_[A-Z0-9_]+\s+(.+)$/i);
      if (valMatch && valMatch[1]) {
        const candidateNorm = toHostFilesystemPath(valMatch[1].trim())
          .replace(/\//g, '\\')
          .replace(/\\+$/, '')
          .toLowerCase();
        if (candidateNorm && candidateNorm === normTarget && !/\\ea desktop(?:\\|$)/i.test(currentSubkey)) {
          matchedKeys.add(currentSubkey);
        }
      }
    }
  }

  for (const k of matchedKeys) {
    await deleteRegKey(k);
  }
}

/** @type {((params: any, options?: any) => Promise<{ installed: boolean, provisionedNow: boolean, binaryPath: string, installDir: string }>) | null} */
let cachedEnsureChainedPublisherLauncherInstalled = null;
function getEnsureChainedPublisherLauncherInstalled() {
  if (!cachedEnsureChainedPublisherLauncherInstalled) {
    cachedEnsureChainedPublisherLauncherInstalled =
      require('./environmentProvisioner.cjs').ensureChainedPublisherLauncherInstalled;
  }
  return cachedEnsureChainedPublisherLauncherInstalled;
}

/** @type {Map<string, boolean>} */
const crossOverWaitChildrenSupportCache = new Map();

/**
 * Inspect whether a CrossOver `bin/wine` wrapper implements the `CXOpts` `--wait-children` flag
 * (true on real CrossOver / CrossOver Preview Perl wrappers; false on tiny synthetic test stubs).
 *
 * @param {string} binaryPath
 * @returns {boolean}
 */
function doesCrossOverBinarySupportWaitChildren(binaryPath) {
  if (!binaryPath || typeof binaryPath !== 'string') return false;
  if (crossOverWaitChildrenSupportCache.has(binaryPath)) {
    return Boolean(crossOverWaitChildrenSupportCache.get(binaryPath));
  }
  let supported = false;
  let fd = null;
  try {
    fd = fs.openSync(binaryPath, 'r');
    const buf = Buffer.alloc(8192);
    const readBytes = fs.readSync(fd, buf, 0, 8192, 0);
    if (readBytes > 0) {
      supported = buf.subarray(0, readBytes).toString('latin1').includes('wait-children');
    }
  } catch {
    supported = false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  setBoundedMapEntry(crossOverWaitChildrenSupportCache, binaryPath, supported, 64);
  return supported;
}

const APP_LOCAL_PROXY_DLL_ALLOWLIST = [
  'winmm.dll',
  'ddraw.dll',
  'dinput.dll',
  'dinput8.dll',
  'dsound.dll',
  'd3d8.dll',
  'd3d9.dll',
  'version.dll',
  'wsock32.dll',
];

/**
 * Discover validated app-local proxy/wrapper DLLs (`winmm.dll`, `ddraw.dll`, `dinput8.dll`, etc.)
 * across candidate game directories so Wine/CrossOver loads them (`native,builtin`) instead of
 * shadowing them with builtin system DLLs.
 *
 * @param {string[]} candidateDirs
 * @param {string} effectiveMachine
 * @param {Record<string, any>} [options]
 */
function discoverValidatedAppLocalProxyDllOverrides(
  candidateDirs,
  effectiveMachine = 'unknown',
  options = {}
) {
  /** @type {Record<string, string>} */
  const appDefaultsMap = {};
  /** @type {string[]} */
  const envSpecs = [];
  const seenDirs = new Set();

  for (const rawDir of candidateDirs) {
    if (!rawDir || typeof rawDir !== 'string') continue;
    const resolvedDir = path.resolve(rawDir);
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);
    let entries = [];
    try {
      if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) continue;
      entries = fs.readdirSync(resolvedDir).slice(0, 192);
    } catch {
      continue;
    }
    const lowerMap = new Map();
    for (const name of entries) {
      lowerMap.set(name.toLowerCase(), name);
    }
    for (const proxyDll of APP_LOCAL_PROXY_DLL_ALLOWLIST) {
      const matchedName = lowerMap.get(proxyDll);
      if (!matchedName) continue;
      const stem = proxyDll.slice(0, -4);
      if (appDefaultsMap[stem]) continue;

      const dllPath = path.join(resolvedDir, matchedName);
      const pe = inspectWindowsExecutableHeader(dllPath, {
        strictPe: Boolean(options?.strictPe),
      });
      if (!pe.isValidPe) continue;
      if (!pe.isSyntheticStub && effectiveMachine && effectiveMachine !== 'unknown') {
        if (effectiveMachine === 'x86' && !pe.isX86) continue;
        if (effectiveMachine === 'x64' && !pe.isX64) continue;
      }
      if (hasMalformedBackslashExportForwarder(dllPath)) continue;

      appDefaultsMap[stem] = 'native,builtin';
      envSpecs.push(`${stem}=n,b`);
    }
  }

  return {
    hasOverrides: envSpecs.length > 0,
    envOverrideSpec: envSpecs.join(';'),
    appDefaultsMap,
  };
}

const BOTTLE_SYSTEM_DAEMON_EXE_SET = new Set([
  'services.exe',
  'winedevice.exe',
  'plugplay.exe',
  'svchost.exe',
  'rpcss.exe',
  'explorer.exe',
  'conhost.exe',
  'wineboot.exe',
  'winewrapper.exe',
  'start.exe',
  'reg.exe',
  'regedit.exe',
  'cmd.exe',
  'tabtip.exe',
  'winecfg.exe',
  'winemenubuilder.exe',
  'steam.exe',
  'steamwebhelper.exe',
  'steamservice.exe',
  'steamerrorreporter.exe',
  'galaxyclient.exe',
  'galaxyclienthelper.exe',
  'galaxycommunication.exe',
  'epicgameslauncher.exe',
  'epicwebhelper.exe',
  'unrealcefsubprocess.exe',
  'crashreportclient.exe',
  'upc.exe',
  'ubisoftconnect.exe',
  'ubisoftgamelauncher.exe',
  'ubisoftgamelauncher64.exe',
  'ubisoftextension.exe',
  'uplaywebcore.exe',
  'uplayservice.exe',
  'eadesktop.exe',
  'ealauncher.exe',
  'eabackgroundservice.exe',
  'eaanticheat.gameservicelauncher.exe',
  'eaanticheat.installer.exe',
  'eacefsubprocess.exe',
  'ealocalhostsvc.exe',
  'ealaunchhelper.exe',
  'easteamproxy.exe',
  'easteamlauncher.exe',
  'easteamauthhelper.exe',
  'eaegsproxy.exe',
  'eaegslauncher.exe',
  'eaconnect_microsoft.exe',
  'eagep.exe',
  'eaupdater.exe',
  'eadestager.exe',
  'apprecovery.exe',
  'eacrashreporter.exe',
  'errorreporter.exe',
  'igoproxy.exe',
  'igoproxy32.exe',
  'igoproxy64.exe',
  'activationui.exe',
  'eacoreserver.exe',
  'origin.exe',
  'originwebhelperservice.exe',
  'originclientservice.exe',
  'touchup.exe',
  'cleanup.exe',
  'link2ea.exe',
  'battle.net.exe',
  'battle.net launcher.exe',
  'agent.exe',
  'blizzarderror.exe',
  'blizzardbrowser.exe',
  'systemsurvey.exe',
  'launcher.exe',
  'launcherpatcher.exe',
  'socialclubhelper.exe',
  'rockstarservice.exe',
  'rockstarerrorhandler.exe',
  'dowser.exe',
  'paradox launcher.exe',
  'riotclientservices.exe',
  'riotclientux.exe',
  'gdkstubgame.exe',
]);

const PROTECTED_BOTTLE_DRIVE_C_REL_PATHS = new Set([
  '',
  '.',
  'windows',
  'users',
  'programdata',
  'program files',
  'program files (x86)',
  'games',
  'ubisoft',
  'ea games',
  'origin games',
  'electronic arts',
  'battle.net',
  'rockstar games',
  'riot games',
  'riot games/riot client',
  'program files/ubisoft',
  'program files (x86)/ubisoft',
  'program files/ubisoft/ubisoft game launcher',
  'program files (x86)/ubisoft/ubisoft game launcher',
  'program files/ubisoft/ubisoft game launcher/games',
  'program files (x86)/ubisoft/ubisoft game launcher/games',
  'program files/electronic arts',
  'program files (x86)/electronic arts',
  'program files/electronic arts/ea desktop',
  'program files (x86)/electronic arts/ea desktop',
  'program files/electronic arts/ea desktop/ea desktop',
  'program files (x86)/electronic arts/ea desktop/ea desktop',
  'program files/ea games',
  'program files (x86)/ea games',
  'program files/origin',
  'program files (x86)/origin',
  'program files/origin games',
  'program files (x86)/origin games',
  'program files/battle.net',
  'program files (x86)/battle.net',
  'program files/rockstar games',
  'program files (x86)/rockstar games',
  'program files/rockstar games/launcher',
  'program files (x86)/rockstar games/launcher',
  'program files/rockstar games/social club',
  'program files (x86)/rockstar games/social club',
  'program files/steam',
  'program files (x86)/steam',
  'program files/steam/steamapps',
  'program files (x86)/steam/steamapps',
  'program files/steam/steamapps/common',
  'program files (x86)/steam/steamapps/common',
  'program files/gog galaxy',
  'program files (x86)/gog galaxy',
  'program files/gog galaxy/games',
  'program files (x86)/gog galaxy/games',
  'program files/epic games',
  'program files (x86)/epic games',
]);

/**
 * Verify that `candidateDir` is a dedicated game leaf sub-directory strictly inside
 * `<bottlePath>/drive_c/...` and NEVER `<bottlePath>`, `drive_c`, `Program Files`, or any
 * publisher launcher client directory.
 *
 * @param {string} bottlePath
 * @param {string} candidateDir
 * @returns {boolean}
 */
function isSafeBottleChainedGameDirToDelete(bottlePath, candidateDir) {
  if (!bottlePath || !candidateDir) return false;
  const resolvedBottle = path.resolve(bottlePath);
  const driveCRoot = path.join(resolvedBottle, 'drive_c');
  const resolvedCandidate = path.resolve(candidateDir);
  if (resolvedCandidate === resolvedBottle || resolvedCandidate === driveCRoot) {
    return false;
  }
  if (!isContainedWithinRoot(driveCRoot, resolvedCandidate, 'darwin')) {
    return false;
  }
  const relPosix = path
    .relative(driveCRoot, resolvedCandidate)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!relPosix || relPosix.startsWith('..') || relPosix.includes('/../')) {
    return false;
  }
  const segs = relPosix.split('/').filter(Boolean);
  if (segs.length === 0) return false;
  const firstSegLower = segs[0].toLowerCase();
  if (firstSegLower === 'windows' || firstSegLower === 'users' || firstSegLower === 'programdata') {
    return false;
  }
  const relLower = segs.join('/').toLowerCase();
  if (PROTECTED_BOTTLE_DRIVE_C_REL_PATHS.has(relLower)) {
    return false;
  }
  if (
    relLower.startsWith('program files/electronic arts/ea desktop/') ||
    relLower.startsWith('program files (x86)/electronic arts/ea desktop/')
  ) {
    return false;
  }
  return segs.length >= 2;
}

/**
 * Collect lowercase `.exe` basenames belonging to the actual game inside `realInstallPath`
 * (excluding system daemons, publisher launcher clients, uninstallers/redists, and `GDKStubGame.exe`).
 *
 * @param {string} realInstallPath
 * @param {string} [primaryGameExe]
 * @returns {string[]}
 */
function collectChainedGameCandidateExeNames(realInstallPath, primaryGameExe = '') {
  /** @type {Set<string>} */
  const candidates = new Set();
  const tryAddExe = (/** @type {string} */ exeFileOrPath) => {
    if (!exeFileOrPath || isGdkStubExecutablePath(exeFileOrPath)) return;
    const baseLower = path.basename(exeFileOrPath).toLowerCase();
    if (!baseLower || !baseLower.endsWith('.exe')) return;
    if (BOTTLE_SYSTEM_DAEMON_EXE_SET.has(baseLower)) return;
    if (isExcludedExecutable(baseLower)) return;
    candidates.add(baseLower);
  };

  if (primaryGameExe) {
    tryAddExe(primaryGameExe);
  }
  if (realInstallPath && fs.existsSync(realInstallPath)) {
    const skipDirSet = new Set([
      '__installer',
      'support',
      'redist',
      'directx',
      '_commonredist',
      'crashreporter',
      'prereq',
      'installers',
      'easyanticheat',
      'battleye',
    ]);
    let visitedEntries = 0;
    const walkInstallDir = (/** @type {string} */ dir, /** @type {number} */ depth) => {
      if (depth > 4 || visitedEntries > 250) return;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        visitedEntries += 1;
        if (visitedEntries > 250) break;
        if (ent.isFile() && ent.name.toLowerCase().endsWith('.exe')) {
          tryAddExe(ent.name);
        } else if (ent.isDirectory() && !ent.name.startsWith('.')) {
          if (skipDirSet.has(ent.name.toLowerCase())) continue;
          walkInstallDir(path.join(dir, ent.name), depth + 1);
        }
      }
    };
    walkInstallDir(realInstallPath, 0);
  }
  return Array.from(candidates);
}

/**
 * Scan active POSIX processes for a live bottled child `.exe` belonging to `localInstallDir` or
 * `targetExeBasenamesLower` after a parent bootstrapper `.exe` exits (`CreateProcess` + `exit(0)`).
 *
 * @param {{ localInstallDir?: string, resolvedExePath?: string, bottleDir?: string | null, targetExeBasenamesLower?: string[], excludePid?: number }} params
 * @param {Record<string, any>} [options]
 * @returns {Promise<number>}
 */
function findLiveBottleGameChildPid(params = {}, options = {}) {
  if (typeof options.findLiveBottleGameChildPidFn === 'function') {
    try {
      return Promise.resolve(Number(options.findLiveBottleGameChildPidFn(params, options)) || 0);
    } catch {
      return Promise.resolve(0);
    }
  }

  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  const mockPsOutput =
    typeof options.mockProcessListOutput === 'string' ? options.mockProcessListOutput : null;
  if (
    mockPsOutput === null &&
    isTestEnvironment(options) &&
    execFileImpl === execFile &&
    options.allowProcessCheckInTest !== true
  ) {
    return Promise.resolve(0);
  }

  const parsePsText = (/** @type {string} */ rawStdout) => {
    if (!rawStdout) return 0;
    const excludePid = Number(params.excludePid || 0);
    const parentExeLower = params.resolvedExePath
      ? path.basename(params.resolvedExePath).toLowerCase()
      : '';
    const rawInstall = String(params.localInstallDir || '').trim();
    const normPosixInstall = rawInstall
      ? path.resolve(rawInstall).replace(/\\/g, '/').toLowerCase()
      : '';
    const installFolderBase = normPosixInstall ? path.posix.basename(normPosixInstall) : '';
    const winTailMarker =
      installFolderBase && installFolderBase.length >= 3 ? `\\${installFolderBase}\\` : '';
    const posixTailMarker =
      installFolderBase && installFolderBase.length >= 3 ? `/${installFolderBase}/` : '';

    const targetBases = Array.isArray(params.targetExeBasenamesLower)
      ? params.targetExeBasenamesLower
          .map((s) => String(s || '').trim().toLowerCase())
          .filter((s) => s && s.endsWith('.exe') && !BOTTLE_SYSTEM_DAEMON_EXE_SET.has(s))
      : [];
    const childOnlyBases = targetBases.filter((b) => b !== parentExeLower);

    let bestExactChildPid = 0;
    let bestInstallDirPid = 0;

    for (const rawLine of String(rawStdout).split(/\r?\n/)) {
      const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid || pid === excludePid) {
        continue;
      }
      const cmdLower = m[2].toLowerCase();
      if (!cmdLower.includes('.exe')) continue;

      const exeMatches = cmdLower.match(/[a-z0-9_.\- ]+?\.exe\b/g) || [];
      const exeTokens = exeMatches
        .map((tok) => tok.trim().split(/[\\/]/).pop() || '')
        .filter(Boolean);
      if (
        exeTokens.length > 0 &&
        exeTokens.every((tok) => BOTTLE_SYSTEM_DAEMON_EXE_SET.has(tok))
      ) {
        continue;
      }

      const matchesChildBase = childOnlyBases.some((base) => {
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|[\\\\/ "'=])${escaped}(?:$|[ "'?])`, 'i').test(cmdLower);
      });
      if (matchesChildBase) {
        bestExactChildPid = pid;
        continue;
      }

      const matchesInstallDir =
        (normPosixInstall && cmdLower.includes(normPosixInstall)) ||
        (winTailMarker && cmdLower.includes(winTailMarker)) ||
        (posixTailMarker && cmdLower.includes(posixTailMarker));
      if (matchesInstallDir) {
        bestInstallDirPid = pid;
      }
    }

    return bestExactChildPid || bestInstallDirPid || 0;
  };

  if (mockPsOutput !== null) {
    return Promise.resolve(parsePsText(mockPsOutput));
  }

  return new Promise((resolve) => {
    try {
      execFileImpl(
        'ps',
        ['-axo', 'pid=,command='],
        { encoding: 'utf8', timeout: 1500 },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (err || !stdout) return resolve(0);
          resolve(parsePsText(String(stdout)));
        }
      );
    } catch {
      resolve(0);
    }
  });
}

/**
 * Quote-aware command-line launch argument tokenizer.
 * Preserves inline quoted substrings (e.g., `--mod="path with spaces"` -> `['--mod=path with spaces']`),
 * supports single and double quotes, and handles `\"` / `\\` escapes inside double quotes without
 * corrupting Windows directory backslashes (`C:\Games\My Mod`).
 *
 * @param {string} argString
 * @returns {string[]}
 */
function parseLaunchArguments(argString) {
  if (!argString || typeof argString !== 'string') return [];
  /** @type {string[]} */
  const args = [];
  let current = '';
  let hasTokenChars = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < argString.length; i++) {
    const ch = argString[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < argString.length) {
        const next = argString[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasTokenChars) {
        args.push(current);
        current = '';
        hasTokenChars = false;
      }
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasTokenChars = true;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasTokenChars = true;
      continue;
    }

    if (ch === '\\' && i + 1 < argString.length) {
      const next = argString[i + 1];
      if (next === '"' || next === "'") {
        current += next;
        hasTokenChars = true;
        i++;
        continue;
      }
    }

    current += ch;
    hasTokenChars = true;
  }

  if (hasTokenChars) {
    args.push(current);
  }

  return args;
}

/**
 * Build Storefront URI for protocol-based launching
 */
function buildStorefrontLaunchUri(/** @type {any} */ payload = {}) {
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
  if (platformId === 'xbox') {
    const cleanXboxId = String(payload.xboxProductId || gameId || '')
      .trim()
      .replace(/^xbox[-_]/i, '');
    return cleanXboxId ? `msxbox://game/?productId=${encodeURIComponent(cleanXboxId)}` : null;
  }
  return null;
}

function trackPostSessionPromise(/** @type {any} */ promise) {
  if (!promise || typeof promise.finally !== 'function') {
    return Promise.resolve(promise);
  }
  inFlightPostSessionPromises.add(promise);
  promise.finally(() => {
    inFlightPostSessionPromises.delete(promise);
  });
  return promise;
}

function killPosixProcessesMatchingWinExe(
  /** @type {string} */ exePath,
  /** @type {NodeJS.Signals} */ signal = 'SIGTERM',
  scopeHint = ''
) {
  return new Promise((resolve) => {
    if (!exePath || process.platform === 'win32') return resolve(undefined);
    const exeBase = path.basename(exePath);
    if (
      !exeBase ||
      exeBase.length <= 3 ||
      /^(?:steam|galaxyclient|epicgameslauncher|upc|ubisoftconnect|ubisoftgamelauncher|eadesktop|ealauncher|battle\.net|riotclientservices|gdkstubgame)\.exe$/i.test(
        exeBase
      )
    ) {
      return resolve(undefined);
    }
    const escapedBase = exeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactTokenRe = new RegExp(`(?:^|[\\\\/\\s"'])${escapedBase}(?:\\s|["']|$)`, 'i');
    const normScope = scopeHint ? String(scopeHint).replace(/\\/g, '/').toLowerCase() : '';
    try {
      execFile('ps', ['-axo', 'pid=,command='], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(undefined);
        for (const rawLine of String(stdout).split(/\r?\n/)) {
          const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) continue;
          const candidatePid = Number.parseInt(m[1], 10);
          const cmd = m[2].trim();
          if (!candidatePid || candidatePid <= 1 || candidatePid === process.pid) continue;
          if (
            /^(?:\/bin\/|\/usr\/bin\/)?(?:ps|pkill|pgrep|grep|rg|vim|nvim|nano|less|tail|cat)\b/i.test(
              cmd
            )
          ) {
            continue;
          }
          if (!exactTokenRe.test(cmd)) continue;
          const lowerCmd = cmd.replace(/\\/g, '/').toLowerCase();
          const hasWineOrPathContext =
            (normScope && lowerCmd.includes(normScope)) ||
            /(?:wine|crossover|gameportingtoolkit|drive_c|[a-z]:\/)/i.test(lowerCmd);
          if (!hasWineOrPathContext) continue;
          try {
            process.kill(candidatePid, signal);
          } catch {}
        }
        resolve(undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function isMacSipProtectedExecutableOrScript(/** @type {string} */ binPath) {
  if (!binPath || typeof binPath !== 'string') return false;
  const resolved = path.resolve(binPath);
  const isSipPath = (/** @type {string} */ p) =>
    p.startsWith('/usr/bin/') ||
    p.startsWith('/bin/') ||
    p.startsWith('/sbin/') ||
    p.startsWith('/System/');
  if (isSipPath(resolved)) return true;
  /** @type {number | null} */
  let fd = null;
  try {
    if (!fs.existsSync(resolved)) return false;
    fd = fs.openSync(resolved, 'r');
    const head = Buffer.alloc(128);
    const bytesRead = fs.readSync(fd, head, 0, 128, 0);
    if (bytesRead >= 2 && head[0] === 0x23 && head[1] === 0x21) {
      const firstLine = head.subarray(2, bytesRead).toString('utf8').split(/\r?\n/)[0].trim();
      const interp = firstLine.split(/\s+/)[0] || '';
      if (isSipPath(interp)) return true;
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return false;
}

/**
 * Determine whether a Windows spawn error genuinely requires UAC elevation (`ERROR_ELEVATION_REQUIRED` / 740).
 * Never triggers `-Verb RunAs` on generic libuv `UV_UNKNOWN` (-4094) or `WindowsApps` ACL errors for
 * real PE binaries unless the executable's PE `RT_MANIFEST` (or `.manifest` sidecar) requests elevation.
 */
function isWindowsElevationRequiredError(
  /** @type {any} */ err,
  exePath = '',
  /** @type {any} */ _options = {}
) {
  if (!err || typeof err !== 'object') return false;
  const msg = String(err.message || '');
  if (err.errno === 740 || /\b740\b|elevation/i.test(msg)) {
    return true;
  }
  if (exePath && isWindowsAppsProtectedPath(exePath)) {
    return false;
  }
  if (exePath && fs.existsSync(exePath)) {
    const peInfo = inspectWindowsExecutableHeader(exePath, { inspectElevationManifest: true });
    if (peInfo && peInfo.exists && peInfo.isValidPe && !peInfo.isSyntheticStub) {
      if (!('requiresElevation' in peInfo && peInfo.requiresElevation)) {
        return false;
      }
      return (
        err.code === 'EACCES' ||
        err.code === 'UNKNOWN' ||
        err.errno === -4094 ||
        err.errno === -4092 ||
        /eacces/i.test(msg)
      );
    }
  }
  return err.code === 'EACCES' || err.errno === -4094 || /eacces/i.test(msg);
}

function spawnWindowsViaPowerShellStartProcess(
  /** @type {any} */ gameSpawnImpl,
  /** @type {string} */ spawnCmd,
  /** @type {string[]} */ spawnArgs,
  /** @type {string} */ effectiveCwd,
  /** @type {Record<string, any>} */ baseEnv,
  requireRunAs = false
) {
  const psEnv = {
    ...baseEnv,
    ONE_LAUNCHER_PS_EXE: String(spawnCmd),
    ONE_LAUNCHER_PS_CWD: String(effectiveCwd),
    ONE_LAUNCHER_PS_ARGS_JSON: JSON.stringify(
      Array.isArray(spawnArgs) ? spawnArgs.map(String) : []
    ),
  };
  const verbClause = requireRunAs ? ' -Verb RunAs' : '';
  const psScript = [
    '$exe = $env:ONE_LAUNCHER_PS_EXE',
    '$wd = $env:ONE_LAUNCHER_PS_CWD',
    '$rawArgs = $env:ONE_LAUNCHER_PS_ARGS_JSON',
    '$argList = @()',
    'if ($rawArgs) { $parsed = ConvertFrom-Json -InputObject $rawArgs; if ($parsed -is [array]) { $argList = [string[]]$parsed } elseif ($null -ne $parsed) { $argList = @([string]$parsed) } }',
    `if ($argList.Count -gt 0) { $p = Start-Process -FilePath $exe -WorkingDirectory $wd -ArgumentList $argList${verbClause} -PassThru } else { $p = Start-Process -FilePath $exe -WorkingDirectory $wd${verbClause} -PassThru }`,
    "if ($null -ne $p) { [Console]::Out.WriteLine('OL_ELEVATED_PID=' + $p.Id); [Console]::Out.Flush(); try { $p.WaitForExit() } catch { Wait-Process -Id $p.Id -ErrorAction SilentlyContinue }; try { if ($null -ne $p.ExitCode) { exit $p.ExitCode } } catch {} }",
    'exit 0',
  ].join('; ');
  const child = gameSpawnImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
    {
      cwd: effectiveCwd,
      env: psEnv,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  if (child && typeof child === 'object') {
    child._isPowerShellStartProcessWrapper = true;
    child._requireRunAs = Boolean(requireRunAs);
  }
  return child;
}

function hasActivePostSessionWork() {
  return inFlightPostSessionPromises.size > 0;
}

async function waitForActivePostSessionWork(timeoutMs = 10000) {
  if (inFlightPostSessionPromises.size === 0) {
    return { completed: true, remaining: 0 };
  }
  const activeSnapshot = Array.from(inFlightPostSessionPromises);
  const safeTimeoutMs = Math.max(250, Math.min(30000, Number(timeoutMs) || 10000));
  let timedOut = false;
  await Promise.race([
    Promise.allSettled(activeSnapshot),
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve(undefined);
      }, safeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  return {
    completed: !timedOut && inFlightPostSessionPromises.size === 0,
    remaining: inFlightPostSessionPromises.size,
  };
}

const {
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
} = createCloudSaveRunner({
  resolveIsolatedHomedirAndUserData: (/** @type {any[]} */ ...args) =>
    resolveIsolatedHomedirAndUserData(...args),
  isTestEnvironment: (/** @type {any[]} */ ...args) => isTestEnvironment(...args),
  fetchGogV1Json: (
    /** @type {string} */ url,
    /** @type {any} */ headers,
    /** @type {any} */ timeoutMs,
    /** @type {any} */ fetchFn
  ) => fetchGogV1Json(url, headers, timeoutMs, fetchFn),
  findGogdlBinary: (/** @type {any[]} */ ...args) => findGogdlBinary(...args),
  ensureGogdlAuthConfig: (/** @type {any[]} */ ...args) => ensureGogdlAuthConfig(...args),
  resolveEpicAppAndPlatforms: (/** @type {any[]} */ ...args) => resolveEpicAppAndPlatforms(...args),
  ensureLegendaryConfigAndAuth: (/** @type {any[]} */ ...args) =>
    ensureLegendaryConfigAndAuth(...args),
  getLegendaryConfigDir: (/** @type {any[]} */ ...args) => getLegendaryConfigDir(...args),
  collectLocalEpicMetadataAndSupport: (/** @type {any[]} */ ...args) =>
    collectLocalEpicMetadataAndSupport(...args),
  findLegendaryBinary: (/** @type {any[]} */ ...args) => findLegendaryBinary(...args),
});

/**
 * Finalize an active game session, compute playtime, run ordered post-exit cloud sync + prefix shutdown, and emit stop event
 */
function finalizeGameSession(/** @type {string} */ gameId, /** @type {any} */ options = {}) {
  const entry = activeSessions.get(gameId);
  if (!entry || entry.finalized) return null;
  entry.finalized = true;

  if (entry.pollTimer) {
    clearInterval(entry.pollTimer);
    entry.pollTimer = null;
  }
  if (entry.displayStatusTimer) {
    clearInterval(entry.displayStatusTimer);
    entry.displayStatusTimer = null;
  }

  if (entry.displayWatcherChild && typeof entry.displayWatcherChild.kill === 'function') {
    try {
      entry.displayWatcherChild.kill('SIGTERM');
    } catch {}
    entry.displayWatcherChild = null;
  }
  for (const tempScalerFile of [entry.displayControlFilePosix, entry.displayStatusFilePosix]) {
    if (typeof tempScalerFile === 'string' && tempScalerFile) {
      try {
        if (fs.existsSync(tempScalerFile)) {
          fs.unlinkSync(tempScalerFile);
        }
      } catch {}
    }
  }

  const normalizedGameId = String(gameId || entry.session?.gameId || '');
  const resolvedPrefix = entry.winePrefix ? path.resolve(entry.winePrefix) : '';

  /** @type {(value?: any) => void} */
  let resolveGameBarrier = () => {};
  const postSessionBarrierPromise = new Promise((resolve) => {
    resolveGameBarrier = resolve;
  });
  /** @type {(value?: any) => void} */
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
  const exitedAbnormally =
    !entry.stoppedByUser &&
    entry.exitCode !== null &&
    entry.exitCode !== undefined &&
    entry.exitCode !== 0;
  const crashedEarly = exitedAbnormally && elapsedMs < 30000;
  const displayModeErrorDetected = Boolean(
    !entry.stoppedByUser &&
      Number(entry.displayModeChangedErrorCount || 0) >= 2 &&
      (exitedAbnormally || elapsedMs < 45000)
  );
  const displayModeRecommendation = displayModeErrorDetected
    ? DISPLAY_MODE_EMULATION_RECOMMENDATION
    : undefined;

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
      exec(entry.postExitCommand, { timeout: 5000, windowsHide: true }, () => {});
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
    ...(displayModeErrorDetected
      ? {
          displayModeErrorDetected: true,
          recommendation: displayModeRecommendation,
        }
      : {}),
  };

  if (displayModeErrorDetected) {
    diagLog.warn('finalizeGameSession.displayModeErrorDetected', {
      gameId: normalizedGameId || stoppedSession.gameId,
      platformId: stoppedSession.platformId,
      displayModeChangedErrorCount: Number(entry.displayModeChangedErrorCount || 0),
      exitCode: entry.exitCode,
      elapsedMs,
      recommendation: displayModeRecommendation,
    });
  }

  const willRunPostExitCloudSync = Boolean(
    !crashedEarly &&
      ((stoppedSession.platformId === 'epic' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'gog' && entry.session?.launchMethod !== 'storefront_uri') ||
        (stoppedSession.platformId === 'xbox' &&
          entry.session?.launchMethod !== 'storefront_uri' &&
          !entry.isChainedPublisherLauncher) ||
        Boolean(entry.xboxLoopbackServer) ||
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
      ...(displayModeErrorDetected
        ? {
            displayModeErrorDetected: true,
            recommendation: displayModeRecommendation,
          }
        : {}),
    },
    mergedOptions
  );

  const emitCloudSyncTelemetry = (/** @type {string} */ direction, /** @type {any} */ syncResult) => {
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
      const rawDir =
        typeof t.installDir === 'string' && t.installDir.trim() ? path.resolve(t.installDir) : '';
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
  /** @type {Promise<any>} */
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
        .then((/** @type {any} */ res) => {
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch((/** @type {any} */ err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
    );
  }

  /** @type {Promise<any>} */
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
        .then((/** @type {any} */ res) => {
          emitCloudSyncTelemetry('post_exit', res);
          return res;
        })
        .catch((/** @type {any} */ err) => {
          const failRes = {
            synced: false,
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        })
    );
  }

  /** @type {Promise<any>} */
  let xboxCloudSaveSyncPromise = Promise.resolve({ synced: false });
  if (
    (stoppedSession.platformId === 'xbox' && !entry.isChainedPublisherLauncher) ||
    entry.xboxLoopbackServer
  ) {
    xboxCloudSaveSyncPromise = trackPostSessionPromise(
      (async () => {
        try {
          if (
            !crashedEarly &&
            entry.xboxLoopbackServer &&
            typeof entry.xboxLoopbackServer.flushPendingSaves === 'function'
          ) {
            await entry.xboxLoopbackServer.flushPendingSaves().catch(() => null);
          }

          if (
            !crashedEarly &&
            stoppedSession.platformId === 'xbox' &&
            entry.session?.launchMethod !== 'storefront_uri'
          ) {
            const rawRuntimeScids =
              entry.xboxLoopbackServer &&
              typeof entry.xboxLoopbackServer.getActiveScids === 'function'
                ? entry.xboxLoopbackServer.getActiveScids()
                : [];
            /** @type {string[]} */
            const dedupedRuntimeScids = [];
            const seenScidLower = new Set();
            if (Array.isArray(rawRuntimeScids)) {
              for (const rawScid of rawRuntimeScids) {
                const trimmedScid = String(rawScid || '').trim();
                const lowerScid = trimmedScid.toLowerCase();
                if (trimmedScid && !seenScidLower.has(lowerScid)) {
                  seenScidLower.add(lowerScid);
                  dedupedRuntimeScids.push(trimmedScid);
                }
              }
            }
            const scidsToSync =
              dedupedRuntimeScids.length > 0 ? dedupedRuntimeScids : [entry.scid];
            /** @type {any} */
            let lastRes = { synced: false, reason: 'skipped' };
            for (const activeScid of scidsToSync) {
              const effectiveFallbackScid =
                entry.fallbackScid ||
                (entry.scid &&
                activeScid &&
                String(entry.scid).toLowerCase() !== String(activeScid).toLowerCase()
                  ? entry.scid
                  : undefined);
              const res = await syncXboxCloudSaves(
                {
                  platformId: 'xbox',
                  platformGameId: entry.platformGameId || stoppedSession.platformGameId,
                  gameId: stoppedSession.gameId,
                  title: stoppedSession.title,
                  installPath: entry.installPath,
                  packageFamilyName: entry.packageFamilyName,
                  scid: activeScid,
                  fallbackScid: effectiveFallbackScid,
                  msaAppId: entry.msaAppId,
                  xboxTitleId: entry.xboxTitleId,
                  xboxProductId: entry.xboxProductId,
                  appUserModelId: entry.appUserModelId,
                },
                'post_exit',
                {
                  ...mergedOptions,
                  useCompatLayer: Boolean(entry.winePrefix),
                  winePrefix: entry.winePrefix,
                  installPath: entry.installPath,
                  isAppxRegistered: Boolean(entry.isAppxRegistered),
                  useGamingServicesRuntime: Boolean(entry.isAppxRegistered),
                  userDataDir: getUserDataDir(mergedOptions.userDataDir),
                }
              );
              emitCloudSyncTelemetry('post_exit', res);
              lastRes = res;
            }
            return lastRes;
          }
          return { synced: false, reason: 'skipped' };
        } catch (/** @type {any} */ err) {
          const failRes = {
            synced: false,
            provider: 'xbox_connected_storage',
            reason: err && err.message ? err.message : 'sync_failed',
          };
          emitCloudSyncTelemetry('post_exit', failRes);
          return failRes;
        } finally {
          if (entry.xboxLoopbackServer && typeof entry.xboxLoopbackServer.close === 'function') {
            try {
              await entry.xboxLoopbackServer.close();
            } catch {}
            entry.xboxLoopbackServer = null;
          }
        }
      })()
    );
  }

  const lifecyclePolicy =
    normalizeStorefrontClientLifecycle(entry.effectiveStorefrontLifecycle) ||
    effectivePerfPolicy.storefrontClientLifecycle;

  /** @type {Promise<any>} */
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
              const shutdownEnv = {
                ...(entry.launchEnv || process.env),
                ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
              };
              const alignedSteamShutdown = prepareAlignedAuxBottleWineCommand({
                wineBinary: entry.wineBinary,
                bottlePath: entry.winePrefix,
                env: shutdownEnv,
              });
              deleteBottleDaemonEnvContract(entry.winePrefix);
              execFileImpl(
                alignedSteamShutdown.binaryPath,
                [entry.bottleSteamExe, '-shutdown'],
                {
                  env: alignedSteamShutdown.env,
                  timeout: 5000,
                },
                () => resolve(undefined)
              );
              closedBottleSteam = true;
            } catch {
              resolve(undefined);
            }
          });
        }
        return { completed: true, cloudRes, closedBottleSteam };
      })().catch(() => ({ completed: false }))
    );
  }

  /** @type {Promise<any>} */
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
          await waitForGogPostExitFlush({
            platform: 'win32',
            bottlePath: entry.winePrefix,
            options: mergedOptions,
          });
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          await new Promise((resolve) => {
            try {
              const shutdownEnv = {
                ...(entry.launchEnv || process.env),
                ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
              };
              const alignedGogShutdown = prepareAlignedAuxBottleWineCommand({
                wineBinary: entry.wineBinary,
                bottlePath: entry.winePrefix,
                env: shutdownEnv,
              });
              execFileImpl(
                alignedGogShutdown.binaryPath,
                [entry.bottleGogExe, '/command=shutdown'],
                {
                  env: alignedGogShutdown.env,
                  timeout: 12000,
                },
                () => resolve(undefined)
              );
            } catch {
              resolve(undefined);
            }
          });
          await reapOrphanedGogOverlayProcesses(mergedOptions);
          return { completed: true, closedBottleGog: true };
        })
        .catch(() => ({ completed: false, closedBottleGog: false }))
    );
  }

  /** @type {Promise<any>} */
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
          const runBottleTaskkill = (/** @type {string[]} */ args) =>
            new Promise((resolve) => {
              try {
                const shutdownEnv = {
                  ...(entry.launchEnv || process.env),
                  ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                };
                const alignedEpicShutdown = prepareAlignedAuxBottleWineCommand({
                  wineBinary: entry.wineBinary,
                  bottlePath: entry.winePrefix,
                  env: shutdownEnv,
                });
                execFileImpl(
                  alignedEpicShutdown.binaryPath,
                  args,
                  {
                    env: alignedEpicShutdown.env,
                    timeout: 6000,
                  },
                  () => resolve(undefined)
                );
              } catch {
                resolve(undefined);
              }
            });
          await runBottleTaskkill(['taskkill', '/IM', 'EpicGamesLauncher.exe']);
          if (
            (!isTestEnvironment(mergedOptions) ||
              mergedOptions.enableStorefrontReadinessBarrier === true) &&
            entry.winePrefix
          ) {
            await new Promise((r) => setTimeout(r, 3500));
            if (
              await isBottleWinExeRunning('EpicGamesLauncher.exe', entry.winePrefix, mergedOptions)
            ) {
              await runBottleTaskkill(['taskkill', '/F', '/IM', 'EpicGamesLauncher.exe']);
            }
          }
          return { completed: true, closedBottleEpic: true };
        })
        .catch(() => ({ completed: false, closedBottleEpic: false }))
    );
  }

  /** @type {Promise<any>} */
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
          ? path.join(
              mergedOptions.homedir || os.homedir(),
              'Library',
              'Application Support',
              'Steam'
            )
          : '');
    if (cleanHostAppId && (candidateHostSteamRoot || targetPlatform === 'darwin')) {
      hostSteamCloudSyncPromise = trackPostSessionPromise(
        waitForSteamCloudSyncCompletion(candidateHostSteamRoot || '', cleanHostAppId, {
          ...mergedOptions,
          mode: 'post_exit',
          ignoreStaleLogAge: true,
        })
          .then((/** @type {any} */ res) => {
            emitCloudSyncTelemetry('post_exit', res);
            return res;
          })
          .catch(() => ({ completed: false }))
      );
    }
  }

  // 2. Chain Wine prefix shutdown strictly AFTER post-exit cloud sync & bottle storefront shutdown finish
  const entryPublisherHandoff = resolveAnyChainedHandoffId(entry.chainedLauncherHandoff);
  const hasActiveBottleStorefrontClient = Boolean(
    entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wasBottleGogRunning ||
      entry.wokeBottleEpicByLauncher ||
      entry.wasBottleEpicRunning ||
      entry.isChainedPublisherLauncher
  );
  const shouldPreserveBottleStorefrontClient =
    hasActiveBottleStorefrontClient &&
    (lifecyclePolicy === 'minimal_keep_running' ||
      lifecyclePolicy === 'default_client' ||
      (lifecyclePolicy === 'minimal_and_close_if_started' &&
        ((entry.launchedViaBottleSteam && !entry.wokeBottleSteamByLauncher) ||
          (entry.wasBottleGogRunning && !entry.wokeBottleGogByLauncher) ||
          (entry.wasBottleEpicRunning && !entry.wokeBottleEpicByLauncher) ||
          (entry.isChainedPublisherLauncher &&
            entry.wasBottlePublisherRunning &&
            !entry.wokePublisherClientByLauncher))));

  /** @type {Promise<any>} */
  let bottlePublisherPostExitPromise = Promise.resolve({
    completed: false,
    closedBottlePublisher: false,
  });
  if (
    entryPublisherHandoff === 'ea' &&
    entry.wokePublisherClientByLauncher &&
    lifecyclePolicy === 'minimal_and_close_if_started' &&
    entry.wineBinary &&
    entry.winePrefix &&
    (shouldPreserveBottleStorefrontClient ||
      effectivePerfPolicy.autoShutdownWinePrefixOnExit === false)
  ) {
    bottlePublisherPostExitPromise = trackPostSessionPromise(
      Promise.allSettled([epicCloudSaveSyncPromise, bottleSteamPostExitPromise])
        .then(async () => {
          if (isPrefixBusyWithOtherSession()) {
            return { completed: false, closedBottlePublisher: false };
          }
          const execFileImpl =
            typeof mergedOptions.execFileImpl === 'function'
              ? mergedOptions.execFileImpl
              : typeof mergedOptions.execFileFn === 'function'
                ? mergedOptions.execFileFn
                : execFile;
          const runBottleCmd = (/** @type {string[]} */ cmdArgs) =>
            new Promise((resolve) => {
              try {
                const shutdownEnv = {
                  ...(entry.launchEnv || process.env),
                  ...(entry.winePrefix ? { WINEPREFIX: entry.winePrefix } : {}),
                };
                const alignedPubShutdown = prepareAlignedAuxBottleWineCommand({
                  wineBinary: entry.wineBinary,
                  bottlePath: entry.winePrefix,
                  env: shutdownEnv,
                  suppressGuiDialogs: true,
                });
                execFileImpl(
                  alignedPubShutdown.binaryPath,
                  cmdArgs,
                  { env: alignedPubShutdown.env, timeout: 6000 },
                  () => resolve(undefined)
                );
              } catch {
                resolve(undefined);
              }
            });
          await runBottleCmd([
            'reg',
            'delete',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v',
            'EADM',
            '/f',
          ]);
          await runBottleCmd([
            'taskkill',
            '/F',
            '/IM',
            'EADesktop.exe',
            '/IM',
            'EALauncher.exe',
            '/IM',
            'EACefSubProcess.exe',
            '/IM',
            'EALocalHostSvc.exe',
            '/IM',
            'Link2EA.exe',
            '/IM',
            'EABackgroundService.exe',
          ]);
          return { completed: true, closedBottlePublisher: true };
        })
        .catch(() => ({ completed: false, closedBottlePublisher: false }))
    );
  }

  /** @type {Promise<any>} */
  let winePrefixShutdownPromise = Promise.resolve(false);
  if (
    (!entry.stopping ||
      entry.deferredPrefixShutdownToFinalize ||
      entry.launchedViaBottleSteam ||
      entry.wokeBottleGogByLauncher ||
      entry.wokeBottleEpicByLauncher ||
      entry.isChainedPublisherLauncher) &&
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
        xboxCloudSaveSyncPromise,
        bottleSteamPostExitPromise,
        bottleGogPostExitPromise,
        bottleEpicPostExitPromise,
        bottlePublisherPostExitPromise,
      ])
        .then(async () => {
          if (
            entry.isChainedPublisherLauncher &&
            !isTestEnvironment(mergedOptions) &&
            !entry.stopping
          ) {
            await new Promise((r) => {
              const t = setTimeout(r, 3000);
              if (typeof t.unref === 'function') t.unref();
            });
          }
          if (isPrefixBusyWithOtherSession()) return false;
          deleteBottleDaemonEnvContract(entry.winePrefix);
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
    xboxCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    bottlePublisherPostExitPromise,
    winePrefixShutdownPromise,
  ]).finally(() => {
    if (entryPublisherHandoff === 'ea' && entry.winePrefix) {
      sanitizeEaBottleAutostartFallback(entry.winePrefix, mergedOptions);
    }
    if (resolvedPrefix && inFlightPostSessionByBottle.get(resolvedPrefix) === bottleBarrierPromise) {
      inFlightPostSessionByBottle.delete(resolvedPrefix);
    }
    resolveBottleBarrier();
  });

  // 3. Sync playtime to storefront (skip GOG when launched via storefront_uri to avoid Galaxy double-count)
  /** @type {Promise<any>} */
  let storefrontSyncPromise = Promise.resolve(null);
  const skipGogStorefrontPlaytimeSync =
    stoppedSession.platformId === 'gog' && entry.session?.launchMethod === 'storefront_uri';
  if (
    !crashedEarly &&
    !skipGogStorefrontPlaytimeSync &&
    sessionMinutesPlayed > 0 &&
    stoppedSession.platformId &&
    ['epic', 'gog', 'steam', 'xbox'].includes(stoppedSession.platformId)
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
          xboxTitleId: entry.xboxTitleId,
          packageFamilyName: entry.packageFamilyName,
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
  /** @type {Promise<any>} */
  let ephemeralClientShutdownPromise = Promise.resolve({ closed: false });
  if (
    entry.wokeGogGalaxyByLauncher ||
    entry.wokeSteamByLauncher ||
    entry.wokeEpicByLauncher ||
    entry.wokeXboxAppByLauncher ||
    entry.wokePublisherClientByLauncher ||
    entry.ephemeralClientWoken
  ) {
    ephemeralClientShutdownPromise = trackPostSessionPromise(
      Promise.allSettled([
        gogCloudSaveSyncPromise,
        epicCloudSaveSyncPromise,
        xboxCloudSaveSyncPromise,
      ]).then(() =>
        shutdownEphemeralStorefrontClient(entry, mergedOptions)
          .then((res) => {
            if (res && 'cloudSyncWait' in res && res.cloudSyncWait) {
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
    xboxCloudSaveSyncPromise,
    bottleSteamPostExitPromise,
    bottleGogPostExitPromise,
    bottleEpicPostExitPromise,
    bottlePublisherPostExitPromise,
    hostSteamCloudSyncPromise,
    winePrefixShutdownPromise,
    ephemeralClientShutdownPromise,
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
    ...(displayModeErrorDetected
      ? {
          displayModeErrorDetected: true,
          recommendation: displayModeRecommendation,
        }
      : {}),
  };
}

/**
 * Launch and supervise a game delegated through a chained publisher launcher
 * (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`) inside a macOS Wine/CrossOver bottle (`darwin`)
 * or natively on Windows (`win32`) / macOS native `.app` (`bnet`/`riot`), never executing
 * `GDKStubGame.exe` directly.
 *
 * @param {{
 *   gameId: string,
 *   normPlatformId: string,
 *   chainedHandoffId: string,
 *   payload: any,
 *   options: any,
 *   platform: string,
 *   launchConfig: any,
 *   effectivePerfPolicy: any,
 *   localInstallDir: string,
 *   isInstallInsideBottle: boolean,
 *   isWindowsBinaryOnMac: boolean,
 *   hasGdkStubIndicator: boolean,
 *   resolvedExePath?: string,
 *   installedRecord?: any,
 *   xboxReceipt?: any,
 *   acquireBottleLock: (resolvedPrefix: string) => Promise<void>,
 *   releasePendingBottleLock: () => void,
 *   releasePendingPlatformLock: () => void,
 * }} ctx
 */
async function launchChainedPublisherGame(ctx) {
  const {
    gameId,
    normPlatformId,
    chainedHandoffId,
    payload,
    options,
    platform,
    launchConfig,
    effectivePerfPolicy,
    localInstallDir,
    isInstallInsideBottle,
    isWindowsBinaryOnMac,
    hasGdkStubIndicator,
    resolvedExePath,
    installedRecord,
    xboxReceipt,
    acquireBottleLock,
    releasePendingBottleLock,
    releasePendingPlatformLock,
  } = ctx;

  const ecosystem = /** @type {Record<string, any>} */ (CHAINED_PUBLISHER_ECOSYSTEMS)[
    chainedHandoffId
  ];
  const isBottlePath = (/** @type {any} */ p) =>
    /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(String(p || ''));
  const userLaunchArgs = parseLaunchArguments(
    launchConfig.launchArguments || payload.launchArguments || ''
  );

  // Execute optional pre-launch command asynchronously
  if (launchConfig.preLaunchCommand) {
    await new Promise((resolve) => {
      try {
        exec(launchConfig.preLaunchCommand, { timeout: 5000, windowsHide: true }, (cmdErr) => {
          if (cmdErr) {
            diagLog.warn('launchGame.chainedPreLaunchCommand', cmdErr, { gameId });
          }
          resolve(undefined);
        });
      } catch (syncErr) {
        diagLog.warn('launchGame.chainedPreLaunchCommandSpawn', syncErr, { gameId });
        resolve(undefined);
      }
    });
  }

  let externalInstallId = String(
    payload.chainedExternalInstallId ||
      installedRecord?.chainedExternalInstallId ||
      xboxReceipt?.chainedExternalInstallId ||
      ''
  ).trim();

  // Persist healed game install metadata back to one_launcher_installed.json when discovered
  const persistHealedManagedRecord = (
    /** @type {{ installPath?: string, executablePath?: string, externalInstallId?: string, wineBottle?: string, compatibilityLayer?: string }} */ healed
  ) => {
    if (!installedRecord) return;
    try {
      const userDataDir = resolveIsolatedHomedirAndUserData(options).userDataDir;
      const allManaged = loadManagedInstalledGames(userDataDir);
      let updated = false;
      for (const rec of allManaged) {
        if (
          (rec.platformId === installedRecord.platformId &&
            installedRecord.platformGameId &&
            rec.platformGameId &&
            String(rec.platformGameId) === String(installedRecord.platformGameId)) ||
          (installedRecord.installPath && rec.installPath === installedRecord.installPath)
        ) {
          if (healed.installPath && rec.installPath !== healed.installPath) {
            rec.installPath = healed.installPath;
            updated = true;
          }
          if (healed.executablePath && rec.executablePath !== healed.executablePath) {
            rec.executablePath = healed.executablePath;
            updated = true;
          }
          if (
            healed.externalInstallId &&
            rec.chainedExternalInstallId !== healed.externalInstallId
          ) {
            rec.chainedExternalInstallId = healed.externalInstallId;
            updated = true;
          }
          if (rec.chainedLauncherHandoff !== chainedHandoffId) {
            rec.chainedLauncherHandoff = chainedHandoffId;
            updated = true;
          }
          if (healed.wineBottle && rec.wineBottle !== healed.wineBottle) {
            rec.wineBottle = healed.wineBottle;
            updated = true;
          }
          if (healed.compatibilityLayer && rec.compatibilityLayer !== healed.compatibilityLayer) {
            rec.compatibilityLayer = healed.compatibilityLayer;
            updated = true;
          }
        }
      }
      if (updated) {
        saveManagedInstalledGames(allManaged, userDataDir);
      }
    } catch {}
  };

  // --- macOS (`darwin`) Chained Publisher Launcher Execution ---
  if (platform === 'darwin') {
    const isNativeMacPublisherBundle =
      ['bnet', 'ea', 'riot'].includes(chainedHandoffId) &&
      normPlatformId !== 'xbox' &&
      !isInstallInsideBottle &&
      !isWindowsBinaryOnMac &&
      !hasGdkStubIndicator &&
      Boolean(
        (localInstallDir &&
          /\.app(?:[\\/]|$)/i.test(localInstallDir) &&
          fs.existsSync(localInstallDir)) ||
          (resolvedExePath && /\.app(?:[\\/]|$)/i.test(resolvedExePath)) ||
          (payload.executablePath && /\.app(?:[\\/]|$)/i.test(payload.executablePath))
      );

    if (isNativeMacPublisherBundle) {
      const macHostLauncher = discoverHostPublisherLauncher(chainedHandoffId, {
        ...options,
        platform: 'darwin',
      });
      if (macHostLauncher.installed && macHostLauncher.binaryPath) {
        if (!externalInstallId) {
          const macHostGames = scanHostPublisherInstalledGames({ ...options, platform: 'darwin' });
          const matchedMac = macHostGames.find(
            (g) =>
              g.handoffId === chainedHandoffId &&
              ((localInstallDir && path.resolve(g.installPath) === path.resolve(localInstallDir)) ||
                doChainedPublisherTitlesMatch(
                  g.title,
                  String(payload.title || installedRecord?.title || '')
                ))
          );
          if (matchedMac?.externalInstallId) {
            externalInstallId = matchedMac.externalInstallId;
          }
        }
        const nativeSpec = buildChainedLauncherLaunchSpec({
          handoffId: chainedHandoffId,
          externalInstallId,
          launcherBinaryPath: macHostLauncher.binaryPath,
          gameExecutablePath:
            resolvedExePath && !isGdkStubExecutablePath(resolvedExePath)
              ? resolvedExePath
              : undefined,
          installDir: localInstallDir || payload.installPath || '',
          bottlePath: '',
          platform: 'darwin',
          compatibilityLayerType: 'native',
        });
        const spawnImpl = options.gameSpawnFn || options.spawnFn || spawn;
        const child = spawnImpl(nativeSpec.launcherExe, nativeSpec.args || [], {
          cwd:
            localInstallDir && fs.existsSync(localInstallDir)
              ? localInstallDir
              : path.dirname(nativeSpec.launcherExe),
          env: {
            ...process.env,
            ...(launchConfig.environmentVariables || {}),
            ...(nativeSpec.envOverrides || {}),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: false,
        });
        const session = {
          sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          gameId,
          title: String(payload.title || gameId),
          platformId: payload.platformId || chainedHandoffId,
          platformGameId: String(payload.platformGameId || gameId),
          pid: child?.pid,
          startedAt: new Date().toISOString(),
          launchMethod: 'chained_publisher_launcher',
          executablePath: resolvedExePath || nativeSpec.launcherExe,
          status: 'running',
        };
        /** @type {any} */
        const entry = {
          session,
          platformId: session.platformId,
          child,
          pid: child?.pid || 0,
          elevatedTargetPid: 0,
          reLatchedBottleChildPid: 0,
          isChainedPublisherLauncher: true,
          chainedLauncherHandoff: chainedHandoffId,
          launchedViaPublisherClient: true,
          targetExeBasenamesLower: [],
          pollTimer: null,
          startedMs: Date.now(),
          postExitCommand: launchConfig.postExitCommand,
          finalized: false,
          stopping: false,
          stderrBuffer: '',
          exitCode: null,
          stoppedByUser: false,
          wineBinary: null,
          wineserverBinary: null,
          winePrefix: null,
          installPath: localInstallDir || payload.installPath || '',
          platformGameId: String(payload.platformGameId || gameId),
          launchOptions: options,
          launchConfig,
          effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
        };
        if (child && typeof child.on === 'function') {
          child.on('exit', () => {
            if (!entry.stopping) finalizeGameSession(gameId, options);
          });
          child.on('error', (/** @type {any} */ err) => {
            entry.exitCode = -1;
            entry.stderrBuffer += '\n' + (err?.message || String(err));
            if (!entry.stopping) finalizeGameSession(gameId, options);
          });
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
          message: `Launched ${session.title} via ${ecosystem?.displayName || chainedHandoffId}`,
          session: { ...session },
          executablePath: session.executablePath,
        };
      }
    }

    if (!ecosystem || !ecosystem.supportedInWineBottle) {
      return {
        success: false,
        error:
          ecosystem?.unsupportedBottleReason ||
          `${chainedHandoffId.toUpperCase()} games cannot run inside macOS Wine/CrossOver bottles.`,
      };
    }

    const layers = detectCompatibilityLayers(options);
    const preferredType =
      launchConfig.compatibilityLayer ||
      payload.compatibilityLayer ||
      installedRecord?.compatibilityLayer;
    const chosenLayer =
      (preferredType && preferredType !== 'native'
        ? layers.find((l) => l.type === preferredType || l.id === preferredType)
        : layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview')) ||
      layers[0];

    if (!chosenLayer || !chosenLayer.binaryPath) {
      return {
        success: false,
        error: `No Windows compatibility layer (CrossOver, Game Porting Toolkit, or Wine) detected on macOS to run ${ecosystem.displayName}.`,
      };
    }

    /** @type {Record<string, any>} */
    const bottleEnv = {
      ...process.env,
      ...(launchConfig.environmentVariables || {}),
    };

    const candidateBottleInstall =
      localInstallDir && !hasGdkStubIndicator && isBottlePath(localInstallDir)
        ? localInstallDir
        : installedRecord?.installPath &&
            !isGdkStubExecutablePath(installedRecord.executablePath || '') &&
            isBottlePath(installedRecord.installPath)
          ? toLocalFsPath(installedRecord.installPath)
          : '';
    const explicitBottleFromInstall = candidateBottleInstall
      ? extractBottleRootFromPath(candidateBottleInstall)
      : '';
    const explicitBottleName = String(
      payload.wineBottle ||
        payload.wineBottleName ||
        options.bottleName ||
        installedRecord?.wineBottle ||
        (explicitBottleFromInstall ? path.basename(explicitBottleFromInstall) : '')
    ).trim();
    const gameConfigBottleName = String(launchConfig.wineBottleName || '').trim();
    const wizardState = getSupervisorSetupWizardState(options);
    const wizardPreferredBottleName = String(wizardState?.preferredBottleName || '').trim();
    const helperBottleName =
      typeof chainedPublisherLaunchers.resolveDefaultChainedBottleName === 'function'
        ? String(
            chainedPublisherLaunchers.resolveDefaultChainedBottleName({
              explicitBottleName,
              gameConfigBottleName,
              wizardPreferredBottleName,
              discoveredBottleNames: Array.isArray(chosenLayer.availableBottles)
                ? chosenLayer.availableBottles
                : [],
            }) || ''
          ).trim()
        : '';
    const requestedBottleName =
      gameConfigBottleName ||
      explicitBottleName ||
      helperBottleName ||
      wizardPreferredBottleName ||
      '';

    const isMockHomedirForChained = Boolean(
      options.homedir || options.customApplicationsDir || isTestEnvironment(options)
    );
    let preResolvedBottlePath = '';
    if (
      explicitBottleFromInstall &&
      fs.existsSync(explicitBottleFromInstall) &&
      isValidBottleDirectory(explicitBottleFromInstall, isMockHomedirForChained)
    ) {
      preResolvedBottlePath = explicitBottleFromInstall;
    } else if (
      (chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview') &&
      chosenLayer.bottlesDir &&
      requestedBottleName
    ) {
      const candidateNamedBottle = path.join(chosenLayer.bottlesDir, requestedBottleName);
      if (
        fs.existsSync(candidateNamedBottle) &&
        isValidBottleDirectory(candidateNamedBottle, isMockHomedirForChained)
      ) {
        preResolvedBottlePath = candidateNamedBottle;
      }
    }

    const compatResult = preResolvedBottlePath
      ? null
      : await ensureCompatibilityLayerReady(
          chosenLayer,
          {
            ...launchConfig,
            ...(explicitBottleFromInstall ? { winePrefixPath: explicitBottleFromInstall } : {}),
            ...(requestedBottleName ? { wineBottleName: requestedBottleName } : {}),
          },
          bottleEnv,
          {
            ...options,
            ...(options.enableAudioBufferClamp === true || launchConfig?.audioBufferClamp === true
              ? { enableAudioBufferClamp: true }
              : {}),
          }
        );

    const bottlePath = String(
      preResolvedBottlePath ||
        explicitBottleFromInstall ||
        compatResult?.winePrefix ||
        bottleEnv.WINEPREFIX ||
        ''
    ).trim();
    if (!bottlePath) {
      return {
        success: false,
        error: `Could not resolve an initialized Wine bottle for ${ecosystem.displayName}.`,
      };
    }
    const bottleName = String(
      bottleEnv.CX_BOTTLE || requestedBottleName || path.basename(bottlePath)
    ).trim();

    await acquireBottleLock(path.resolve(bottlePath));

    emitSessionUpdated(
      {
        gameId,
        platformId: payload.platformId || chainedHandoffId,
        status: 'starting',
        event: 'starting',
        statusMessage: `Preparing ${ecosystem.displayName} in Wine bottle...`,
      },
      options
    );

    let launcherBinPath = '';
    if (options.skipPublisherProvisioning === true) {
      const discovered = discoverBottlePublisherLauncher(bottlePath, chainedHandoffId);
      launcherBinPath = String(discovered?.binaryPath || '').trim();
    } else {
      const ensureProvisionFn =
        typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
          ? options.ensureChainedPublisherLauncherInstalledFn
          : getEnsureChainedPublisherLauncherInstalled();
      let ensured = null;
      try {
        ensured = await ensureProvisionFn(
          {
            handoffId: chainedHandoffId,
            platform: 'darwin',
            runnerLayer: chosenLayer,
            bottleName,
            bottlePath,
          },
          options
        );
      } catch (/** @type {any} */ provisionErr) {
        return {
          success: false,
          error:
            provisionErr?.message ||
            `Failed to provision ${ecosystem.displayName} inside bottle "${bottleName}".`,
        };
      }
      if (!ensured || !ensured.installed || !ensured.binaryPath) {
        return {
          success: false,
          error:
            /** @type {any} */ (ensured)?.error ||
            `Failed to provision ${ecosystem.displayName} inside bottle "${bottleName}".`,
        };
      }
      launcherBinPath = ensured.binaryPath;
    }

    let realInstallPath = candidateBottleInstall;
    let realGameExe =
      resolvedExePath &&
      !isGdkStubExecutablePath(resolvedExePath) &&
      isBottlePath(resolvedExePath) &&
      fs.existsSync(resolvedExePath)
        ? resolvedExePath
        : installedRecord?.executablePath &&
            !isGdkStubExecutablePath(installedRecord.executablePath) &&
            isBottlePath(installedRecord.executablePath) &&
            fs.existsSync(toLocalFsPath(installedRecord.executablePath))
          ? toLocalFsPath(installedRecord.executablePath)
          : '';

    const rawEpicPartnerRegPath = String(
      payload.epicPartnerRegistryPath || installedRecord?.epicPartnerRegistryPath || ''
    )
      .trim()
      .replace(/\//g, '\\')
      .replace(/\\+$/, '');
    const epicPartnerRegistryLeaf = rawEpicPartnerRegPath
      ? rawEpicPartnerRegPath.split('\\').pop() || ''
      : '';

    if (
      !externalInstallId ||
      normPlatformId === 'epic' ||
      !realInstallPath ||
      !realGameExe ||
      !fs.existsSync(realGameExe)
    ) {
      const bottleGames = scanBottlePublisherInstalledGames(bottlePath, options).filter(
        (g) => g.handoffId === chainedHandoffId
      );
      let matchedBottleGame = null;
      if (externalInstallId) {
        matchedBottleGame =
          bottleGames.find(
            (g) =>
              g.externalInstallId &&
              String(g.externalInstallId).toLowerCase() === externalInstallId.toLowerCase()
          ) || null;
      }
      if (!matchedBottleGame && realInstallPath) {
        matchedBottleGame =
          bottleGames.find(
            (g) => path.resolve(g.installPath) === path.resolve(realInstallPath)
          ) || null;
      }
      if (!matchedBottleGame && epicPartnerRegistryLeaf) {
        matchedBottleGame =
          bottleGames.find(
            (g) =>
              doChainedPublisherTitlesMatch(g.title, epicPartnerRegistryLeaf) ||
              (g.installPath &&
                doChainedPublisherTitlesMatch(path.basename(g.installPath), epicPartnerRegistryLeaf))
          ) || null;
      }
      if (!matchedBottleGame) {
        const searchTitle = String(payload.title || installedRecord?.title || '');
        if (searchTitle) {
          matchedBottleGame =
            bottleGames.find((g) => doChainedPublisherTitlesMatch(g.title, searchTitle)) || null;
        }
      }
      if (matchedBottleGame) {
        if (matchedBottleGame.externalInstallId && (!externalInstallId || normPlatformId === 'epic')) {
          externalInstallId = matchedBottleGame.externalInstallId;
        }
        if (matchedBottleGame.installPath) {
          realInstallPath = matchedBottleGame.installPath;
        }
        if (
          matchedBottleGame.executablePath &&
          !isGdkStubExecutablePath(matchedBottleGame.executablePath)
        ) {
          realGameExe = matchedBottleGame.executablePath;
        }
        persistHealedManagedRecord({
          installPath: realInstallPath || undefined,
          executablePath: realGameExe || undefined,
          externalInstallId: externalInstallId || undefined,
          wineBottle: bottleName,
          compatibilityLayer: chosenLayer.type,
        });
      }
    }

    const spec = buildChainedLauncherLaunchSpec({
      handoffId: chainedHandoffId,
      externalInstallId,
      launcherBinaryPath: launcherBinPath || undefined,
      gameExecutablePath: realGameExe || undefined,
      installDir: realInstallPath || localInstallDir || payload.installPath || '',
      bottlePath: bottlePath || '',
      epicPartnerRegistryPath: rawEpicPartnerRegPath || undefined,
      storefrontId: normPlatformId || undefined,
      platform: 'darwin',
      compatibilityLayerType: chosenLayer.type,
    });
    if (
      !realGameExe &&
      spec.targetExecutablePath &&
      !isGdkStubExecutablePath(spec.targetExecutablePath)
    ) {
      realGameExe = spec.targetExecutablePath;
    }

    if (!spec.launcherExe || isGdkStubExecutablePath(spec.launcherExe)) {
      return {
        success: false,
        error: `Could not locate ${ecosystem.displayName} or installed game executable in bottle "${bottleName}".`,
      };
    }

    const candidateExeNames = collectChainedGameCandidateExeNames(realInstallPath, realGameExe);
    const chainedEffectiveCaps =
      realGameExe || realInstallPath
        ? resolveEffectiveGameExecutableCapabilities(
            realGameExe || undefined,
            realInstallPath || undefined
          )
        : null;
    const chainedProxyCandidateDirs = [
      realGameExe ? path.dirname(realGameExe) : '',
      realInstallPath || '',
      ...(chainedEffectiveCaps?.targetExePaths || []).map((p) => path.dirname(p)),
    ].filter(Boolean);
    const chainedProxyInfo = discoverValidatedAppLocalProxyDllOverrides(
      chainedProxyCandidateDirs,
      chainedEffectiveCaps?.effectiveMachine || 'unknown',
      options
    );
    if (chainedProxyInfo.hasOverrides) {
      bottleEnv.WINEDLLOVERRIDES = mergeWineDllOverrides(
        bottleEnv.WINEDLLOVERRIDES,
        chainedProxyInfo.envOverrideSpec
      );
    }
    const mergedChainedTargetExes = Array.from(
      new Set(
        [
          ...(chainedEffectiveCaps?.targetExeBasenamesLower || []),
          ...candidateExeNames.map((n) => String(n || '').toLowerCase()),
        ].filter((n) => n && n.endsWith('.exe'))
      )
    );
    const earlyChainedPerfPolicy = resolveEffectivePerformancePolicy(launchConfig || {}, options);
    const chainedCompatCapOptions = {
      ...options,
      skipBottleProvisioning: true,
      ...(options.enableAudioBufferClamp === true || launchConfig?.audioBufferClamp === true
        ? { enableAudioBufferClamp: true }
        : {}),
      ...(chainedEffectiveCaps ? { peCapabilities: chainedEffectiveCaps } : {}),
      enableLegacyDisplayModeSynthesis: Boolean(
        chainedEffectiveCaps?.needsLegacyDisplayModeSynthesis
      ),
      limitLegacy32BitGlExtensions: Boolean(chainedEffectiveCaps?.isLegacy32BitOpenGl),
      usesLegacyDirectDraw: Boolean(chainedEffectiveCaps?.usesLegacyDirectDrawOrD3d),
      displayScalingMode: earlyChainedPerfPolicy.effectiveDisplayScalingMode,
      displayAspectRatio: earlyChainedPerfPolicy.effectiveDisplayAspectRatio,
      exeName: realGameExe ? path.basename(realGameExe) : '',
      targetExeNames: mergedChainedTargetExes,
      ...(chainedProxyInfo.hasOverrides
        ? { appLocalDllOverrides: chainedProxyInfo.appDefaultsMap }
        : {}),
      ...(realInstallPath ? { installDir: realInstallPath } : {}),
    };

    await ensureCompatibilityLayerReady(
      chosenLayer,
      {
        ...launchConfig,
        winePrefixPath: bottlePath,
        ...(bottleName ? { wineBottleName: bottleName } : {}),
      },
      bottleEnv,
      chainedCompatCapOptions
    );

    bottleEnv.WINEPREFIX = bottlePath;
    if (
      (chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview') &&
      bottleName
    ) {
      bottleEnv.CX_BOTTLE = bottleName;
    }
    if (chainedProxyInfo.hasOverrides) {
      bottleEnv.WINEDLLOVERRIDES = mergeWineDllOverrides(
        bottleEnv.WINEDLLOVERRIDES,
        chainedProxyInfo.envOverrideSpec
      );
    }
    if (spec.envOverrides && typeof spec.envOverrides === 'object') {
      for (const [k, v] of Object.entries(spec.envOverrides)) {
        if (k === 'WINEDLLOVERRIDES') {
          bottleEnv.WINEDLLOVERRIDES = mergeWineDllOverrides(bottleEnv.WINEDLLOVERRIDES, v);
        } else if (v !== undefined) {
          bottleEnv[k] = v;
        }
      }
    }
    applyMoltenVkMetalHudDeadlockGuard(chosenLayer, bottleEnv, launchConfig, options, gameId);

    const isDirectGameExeSpawn = Boolean(
      realGameExe &&
        spec.launcherExe &&
        path.resolve(spec.launcherExe) === path.resolve(realGameExe)
    );
    let wasBottlePublisherRunning = isDirectGameExeSpawn
      ? false
      : await checkBottlePublisherUiRunningAsync(bottlePath, chainedHandoffId, options);

    const prefixContractKey = normalizeBottlePrefixContractKey(bottlePath);
    const targetGraphicsContract = computeBottleGraphicsEnvContract(bottleEnv);
    const desiredBackendLower = String(bottleEnv.CX_GRAPHICS_BACKEND || 'auto')
      .trim()
      .toLowerCase();
    const normalizedChainedBottle = path.resolve(bottlePath);
    const hasOtherActiveChainedBottleSession = Array.from(activeSessions.values()).some(
      (s) =>
        s &&
        !s.finalized &&
        s.session?.gameId !== gameId &&
        s.winePrefix &&
        path.resolve(s.winePrefix) === normalizedChainedBottle
    );

    if (
      wasBottlePublisherRunning &&
      !hasOtherActiveChainedBottleSession &&
      options.enableWarmDaemonEnvRecycle !== false
    ) {
      const recordedContract = prefixContractKey
        ? liveBottleDaemonEnvContractByPrefix.get(prefixContractKey)
        : undefined;
      const hasRecordedContractMismatch =
        typeof recordedContract === 'string' && recordedContract !== targetGraphicsContract;
      const hasUnrecordedIncompatibleBackend =
        recordedContract === undefined &&
        Boolean(bottleEnv.CX_GRAPHICS_BACKEND) &&
        desiredBackendLower !== 'auto' &&
        (!isTestEnvironment(options) || options.enableWarmDaemonEnvRecycle === true);

      if (hasRecordedContractMismatch || hasUnrecordedIncompatibleBackend) {
        diagLog.info('launchGame.recycledWarmBottlePublisherForGraphicsContract', {
          gameId,
          handoff: chainedHandoffId,
          bottlePath,
          previousContract: recordedContract || null,
          targetContract: targetGraphicsContract,
        });
        deleteBottleDaemonEnvContract(bottlePath);
        await shutdownWinePrefix(chosenLayer.binaryPath, bottlePath, 3000, {
          bottleName: String(bottleName || ''),
          execFileFn: options.execFileImpl || options.execFileFn || execFile,
        });
        if (fs.existsSync(bottlePath)) {
          try {
            applyCrossOverPerGameSettings(
              bottlePath,
              chainedCompatCapOptions.exeName || '',
              {
                ...launchConfig,
                winePrefixPath: bottlePath,
                ...(bottleName ? { wineBottleName: bottleName } : {}),
              },
              {
                ...chainedCompatCapOptions,
                skipRegistrySpawn: true,
                skipLiveWineRegSync: true,
              }
            );
          } catch {}
        }
        wasBottlePublisherRunning = false;
      }
    }

    if (!isDirectGameExeSpawn && !wasBottlePublisherRunning && prefixContractKey) {
      setBoundedMapEntry(
        liveBottleDaemonEnvContractByPrefix,
        prefixContractKey,
        targetGraphicsContract,
        128
      );
    }

    const chainedPerfPolicy = resolveEffectivePerformancePolicy(launchConfig || {}, options);
    const chainedDisplayScalingMode =
      chainedPerfPolicy.effectiveDisplayScalingMode || 'auto_fullscreen';
    const chainedDisplayAspectRatio =
      chainedPerfPolicy.effectiveDisplayAspectRatio || 'preserve_aspect';
    const chainedFullscreenHotkey = chainedPerfPolicy.enableFullscreenHotkey !== false;
    const chainedInitialFullscreen =
      chainedDisplayScalingMode === 'auto_fullscreen' ||
      chainedDisplayScalingMode === 'force_fullscreen';
    const chainedSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let chainedDisplayControlFilePosix = '';
    let chainedDisplayStatusFilePosix = '';
    if (
      chainedPerfPolicy.suppressWineDebugLogging !== false &&
      !launchConfig?.wineDebug &&
      !launchConfig?.environmentVariables?.WINEDEBUG &&
      (!bottleEnv.WINEDEBUG || bottleEnv.WINEDEBUG === '-all')
    ) {
      bottleEnv.WINEDEBUG = '-all,err+system';
      if (bottleEnv.CX_DEBUGMSG === '-all' && !launchConfig?.environmentVariables?.CX_DEBUGMSG) {
        bottleEnv.CX_DEBUGMSG = '-all,err+system';
      }
    }
    // Interface Contract 1: Pure Edge-to-Edge Symmetric Panel Span (ONE_LAUNCHER_SAFE_INSET_TOP: '0')
    const chainedSafeInsetTop =
      chainedDisplayScalingMode !== 'off' && chainedDisplayScalingMode !== 'windowed'
        ? 0
        : (typeof options?.safeInsetTop === 'number' && Number.isFinite(options.safeInsetTop)
            ? Math.max(0, Math.min(80, Math.round(options.safeInsetTop)))
            : 0);
    bottleEnv.ONE_LAUNCHER_DISPLAY_SCALING_MODE = chainedDisplayScalingMode;
    bottleEnv.ONE_LAUNCHER_DISPLAY_ASPECT = chainedDisplayAspectRatio;
    bottleEnv.ONE_LAUNCHER_SAFE_INSET_TOP = String(chainedSafeInsetTop);
    bottleEnv.ONE_LAUNCHER_FULLSCREEN_HOTKEY = chainedFullscreenHotkey ? '1' : '0';
    if (bottlePath && fs.existsSync(bottlePath)) {
      const stagedChainedDisp = stageBottleDisplayScalerBinaries(bottlePath, options);
      if (stagedChainedDisp.stageDirPosix) {
        chainedDisplayControlFilePosix = path.join(
          stagedChainedDisp.stageDirPosix,
          `display_ctl_${chainedSessionId}.ini`
        );
        chainedDisplayStatusFilePosix = path.join(
          stagedChainedDisp.stageDirPosix,
          `display_status_${chainedSessionId}.json`
        );
        try {
          atomicWriteFileSync(
            chainedDisplayControlFilePosix,
            formatDisplayScalerControlIni(
              1,
              chainedInitialFullscreen,
              chainedDisplayAspectRatio,
              chainedSafeInsetTop
            )
          );
        } catch {}
        bottleEnv.ONE_LAUNCHER_SCALER_DLL_X86 = stagedChainedDisp.winDllX86;
        bottleEnv.ONE_LAUNCHER_SCALER_DLL_X64 = stagedChainedDisp.winDllX64;
        bottleEnv.ONE_LAUNCHER_LAUNCHER_EXE_X86 = stagedChainedDisp.winLauncherX86;
        bottleEnv.ONE_LAUNCHER_LAUNCHER_EXE_X64 = stagedChainedDisp.winLauncherX64;
        bottleEnv.ONE_LAUNCHER_DISPLAY_CONTROL_FILE = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${chainedSessionId}.ini`;
        bottleEnv.ONE_LAUNCHER_DISPLAY_STATUS_FILE = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${chainedSessionId}.json`;
      }
    }

    let wineSpawnCmd = chosenLayer.binaryPath;
    alignWineMsyncWithLiveBottle(bottlePath, bottleEnv);
    /** @type {Record<string, any>} */
    let spawnEnv = { ...bottleEnv };
    if (!isTestEnvironment(options)) {
      wineSpawnCmd = resolveSipSafeWineBinaryAndPreloadEnv(wineSpawnCmd, spawnEnv, {
        layerType: chosenLayer?.type,
      });
      if (isMacSipProtectedExecutableOrScript(wineSpawnCmd)) {
        delete spawnEnv.DYLD_INSERT_LIBRARIES;
      }
    } else {
      prepareCrossOverWineSpawnEnv(wineSpawnCmd, spawnEnv, {
        layerType: chosenLayer?.type,
      });
    }

    if (realInstallPath) {
      try {
        cleanNonApfsAppleDoubleTwins(realInstallPath, options);
      } catch {}
    }

    const trimmedChainedDllOverrides =
      typeof spawnEnv.WINEDLLOVERRIDES === 'string' ? spawnEnv.WINEDLLOVERRIDES.trim() : '';
    const isRealCrossOverPerl =
      doesCrossOverBinarySupportWaitChildren(wineSpawnCmd) ||
      options.forceCrossOverDllFlag === true;
    const chainedDllArgs =
      isRealCrossOverPerl && trimmedChainedDllOverrides
        ? ['--dll', trimmedChainedDllOverrides]
        : [];
    const wineArgs = [
      ...chainedDllArgs,
      spec.launcherExe,
      ...(spec.args || []),
      ...(isDirectGameExeSpawn ? userLaunchArgs : []),
    ];
    const effectiveCwd =
      realInstallPath && fs.existsSync(realInstallPath)
        ? realInstallPath
        : fs.existsSync(path.dirname(spec.launcherExe))
          ? path.dirname(spec.launcherExe)
          : process.cwd();

    const gameSpawnImpl = options.gameSpawnFn || options.spawnFn || spawn;
    const child = gameSpawnImpl(wineSpawnCmd, wineArgs, {
      cwd: effectiveCwd,
      env: spawnEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });

    const session = {
      sessionId: chainedSessionId,
      gameId,
      title: String(payload.title || gameId),
      platformId: payload.platformId || chainedHandoffId,
      platformGameId: String(payload.platformGameId || gameId),
      pid: isDirectGameExeSpawn ? child?.pid : undefined,
      startedAt: new Date().toISOString(),
      launchMethod: 'compatibility_layer',
      executablePath: realGameExe || spec.launcherExe,
      status: 'running',
      isBottledSession: true,
      fullscreenActive: chainedInitialFullscreen,
      displayScalingMode: chainedDisplayScalingMode,
      displayAspectRatio: chainedDisplayAspectRatio,
    };

    const resolvedWineBinary = chosenLayer.binaryPath || null;
    const resolvedWineserverBinary = resolvedWineBinary
      ? resolveWineserverBinary(resolvedWineBinary)
      : null;

    /** @type {any} */
    const entry = {
      session,
      platformId: session.platformId,
      child,
      pid: isDirectGameExeSpawn ? child?.pid || 0 : 0,
      elevatedTargetPid: 0,
      reLatchedBottleChildPid: 0,
      isChainedPublisherLauncher: true,
      chainedLauncherHandoff: chainedHandoffId,
      launchedViaPublisherClient: !isDirectGameExeSpawn,
      wasBottlePublisherRunning,
      wokePublisherClientByLauncher: !isDirectGameExeSpawn && !wasBottlePublisherRunning,
      ephemeralClientWoken: !isDirectGameExeSpawn && !wasBottlePublisherRunning,
      targetExeBasenamesLower: candidateExeNames,
      pollTimer: null,
      startedMs: Date.now(),
      postExitCommand: launchConfig.postExitCommand,
      finalized: false,
      stopping: false,
      stderrBuffer: '',
      stderrCarryover: '',
      displayModeChangedErrorCount: 0,
      exitCode: null,
      stoppedByUser: false,
      wineBinary: resolvedWineBinary,
      wineserverBinary: resolvedWineserverBinary,
      winePrefix: bottlePath,
      launchEnv: bottleEnv,
      displayControlSeq: 1,
      displayControlFilePosix: chainedDisplayControlFilePosix || null,
      displayStatusFilePosix: chainedDisplayStatusFilePosix || null,
      displayScalerWrapped: false,
      displayWatcherChild: null,
      chosenCompatLayerType: chosenLayer?.type || null,
      installPath: realInstallPath || localInstallDir || '',
      platformGameId: String(payload.platformGameId || gameId),
      launchOptions: options,
      launchConfig,
      effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
    };

    if (child?.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (/** @type {any} */ chunk) => {
        recordBottledStderrChunk(entry, chunk);
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

    const hasMockProcessSource =
      typeof options.findLiveBottleGameChildPidFn === 'function' ||
      typeof options.getProcessListOutput === 'function' ||
      typeof options.mockProcessListOutput === 'string' ||
      typeof options.execFileImpl === 'function' ||
      typeof options.execFileFn === 'function';
    const canPollProcessTable =
      !options.disableChainedLauncherPolling &&
      (!isTestEnvironment(options) ||
        hasMockProcessSource ||
        options.allowProcessCheckInTest === true);

    let childExitedAt = 0;
    /** @type {number | null} */
    let childExitCode = null;

    if (child && typeof child.on === 'function') {
      child.on('error', (/** @type {any} */ err) => {
        entry.exitCode = -1;
        entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
        if (!entry.stopping) {
          finalizeGameSession(gameId, options);
        }
      });
      child.on('exit', (/** @type {any} */ code) => {
        childExitedAt = Date.now();
        childExitCode = typeof code === 'number' ? code : 0;
        if (entry.stopping || entry.stoppedByUser || !canPollProcessTable) {
          entry.exitCode = childExitCode;
          if (!entry.stopping) {
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
          }
        }
      });
    }

    if (canPollProcessTable) {
      const pollMs = Math.max(25, Number(options.chainedLauncherPollIntervalMs || 1500));
      const maxBootstrapWaitMs = Number(options.chainedLauncherMaxBootstrapWaitMs ?? 90000);
      const graceAfterLauncherExitMs = Number(options.chainedLauncherBootstrapGraceMs ?? 30000);
      const checkAliveFn =
        typeof options.isProcessAliveFn === 'function' ? options.isProcessAliveFn : isProcessAlive;
      let seenRealGameRunning = false;
      let consecutiveMisses = 0;
      let pollBusy = false;

      const pollTimer = setInterval(() => {
        if (pollBusy) return;
        if (entry.finalized || entry.stopping || entry.stoppedByUser) {
          clearInterval(pollTimer);
          entry.pollTimer = null;
          return;
        }
        pollBusy = true;
        void (async () => {
          try {
            let effectivePollOpts = options;
            if (
              typeof options.getProcessListOutput === 'function' &&
              typeof options.findLiveBottleGameChildPidFn !== 'function'
            ) {
              const dynamicOut = await Promise.resolve(options.getProcessListOutput());
              effectivePollOpts = {
                ...options,
                mockProcessListOutput: String(dynamicOut || ''),
              };
            }

            // Re-discover realInstallPath/candidateExeNames dynamically if the user just installed the game in-session
            if (!realInstallPath || candidateExeNames.length === 0) {
              const liveGames = scanBottlePublisherInstalledGames(bottlePath, options).filter(
                (g) => g.handoffId === chainedHandoffId
              );
              const searchTitle = String(payload.title || installedRecord?.title || '');
              const dynamicMatch = liveGames.find(
                (g) =>
                  (externalInstallId &&
                    g.externalInstallId &&
                    String(g.externalInstallId).toLowerCase() ===
                      externalInstallId.toLowerCase()) ||
                  (searchTitle && doChainedPublisherTitlesMatch(g.title, searchTitle))
              );
              if (dynamicMatch) {
                if (dynamicMatch.installPath) {
                  realInstallPath = dynamicMatch.installPath;
                  entry.installPath = realInstallPath;
                }
                if (
                  dynamicMatch.executablePath &&
                  !isGdkStubExecutablePath(dynamicMatch.executablePath)
                ) {
                  realGameExe = dynamicMatch.executablePath;
                  if (entry.session) entry.session.executablePath = realGameExe;
                }
                const refreshed = collectChainedGameCandidateExeNames(realInstallPath, realGameExe);
                candidateExeNames.splice(0, candidateExeNames.length, ...refreshed);
                entry.targetExeBasenamesLower = candidateExeNames;
              }
            }

            const livePid = await findLiveBottleGameChildPid(
              {
                localInstallDir: realInstallPath,
                resolvedExePath: isDirectGameExeSpawn ? '' : spec.launcherExe,
                bottleDir: bottlePath,
                targetExeBasenamesLower: candidateExeNames,
                excludePid: isDirectGameExeSpawn ? 0 : child?.pid || 0,
              },
              effectivePollOpts
            );

            if (entry.finalized || entry.stopping || entry.stoppedByUser) return;

            if (livePid > 0) {
              seenRealGameRunning = true;
              consecutiveMisses = 0;
              if (entry.pid !== livePid) {
                entry.pid = livePid;
                entry.reLatchedBottleChildPid = livePid;
                if (entry.session) {
                  entry.session.pid = livePid;
                }
              }
              return;
            }

            if (seenRealGameRunning) {
              if (
                !hasMockProcessSource &&
                entry.reLatchedBottleChildPid > 0 &&
                checkAliveFn(entry.reLatchedBottleChildPid)
              ) {
                return;
              }
              consecutiveMisses += 1;
              if (consecutiveMisses >= (hasMockProcessSource ? 1 : 2)) {
                clearInterval(pollTimer);
                entry.pollTimer = null;
                entry.exitCode = 0;
                finalizeGameSession(gameId, options);
              }
              return;
            }

            const nowMs = Date.now();
            const timedOutTotal =
              maxBootstrapWaitMs > 0 && nowMs - entry.startedMs >= maxBootstrapWaitMs;
            const timedOutAfterExit =
              childExitedAt > 0 &&
              graceAfterLauncherExitMs >= 0 &&
              nowMs - childExitedAt >= graceAfterLauncherExitMs;

            if (timedOutTotal || timedOutAfterExit) {
              clearInterval(pollTimer);
              entry.pollTimer = null;
              entry.exitCode = childExitCode ?? 0;
              finalizeGameSession(gameId, options);
            }
          } finally {
            pollBusy = false;
          }
        })();
      }, pollMs);

      if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
      }
      entry.pollTimer = pollTimer;
    }

    return {
      success: true,
      message: `Launched ${session.title} via ${ecosystem.displayName}`,
      session: { ...session },
      executablePath: session.executablePath,
    };
  }

  // --- Windows (`win32`) Native Chained Publisher Launcher Execution ---
  let hostLauncher = discoverHostPublisherLauncher(chainedHandoffId, {
    ...options,
    platform: 'win32',
  });
  if (
    !hostLauncher.installed &&
    chainedHandoffId !== 'riot' &&
    options.skipPublisherProvisioning !== true
  ) {
    emitSessionUpdated(
      {
        gameId,
        platformId: payload.platformId || chainedHandoffId,
        status: 'starting',
        event: 'starting',
        statusMessage: `Preparing ${ecosystem?.displayName || chainedHandoffId}...`,
      },
      options
    );
    const ensureProvisionFn =
      typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
        ? options.ensureChainedPublisherLauncherInstalledFn
        : getEnsureChainedPublisherLauncherInstalled();
    let ensuredHost = null;
    try {
      ensuredHost = await ensureProvisionFn(
        {
          handoffId: chainedHandoffId,
          platform: 'win32',
        },
        options
      );
    } catch (/** @type {any} */ provisionErr) {
      return {
        success: false,
        error:
          provisionErr?.message ||
          `Failed to install ${ecosystem?.displayName || chainedHandoffId} on Windows.`,
      };
    }
    if (!ensuredHost || !ensuredHost.installed || !ensuredHost.binaryPath) {
      return {
        success: false,
        error:
          /** @type {any} */ (ensuredHost)?.error ||
          `Failed to install ${ecosystem?.displayName || chainedHandoffId} on Windows.`,
      };
    }
    hostLauncher = {
      installed: true,
      binaryPath: ensuredHost.binaryPath,
      hasLocalSession: Boolean(/** @type {any} */ (ensuredHost).hasLocalSession),
    };
  }

  let realInstallPath =
    localInstallDir && !hasGdkStubIndicator ? localInstallDir : '';
  let realGameExe =
    resolvedExePath && !isGdkStubExecutablePath(resolvedExePath)
      ? resolvedExePath
      : payload.executablePath &&
          !isGdkStubExecutablePath(payload.executablePath) &&
          fs.existsSync(toLocalFsPath(payload.executablePath))
        ? toLocalFsPath(payload.executablePath)
        : installedRecord?.executablePath &&
            !isGdkStubExecutablePath(installedRecord.executablePath) &&
            fs.existsSync(toLocalFsPath(installedRecord.executablePath))
          ? toLocalFsPath(installedRecord.executablePath)
          : '';

  const rawWinEpicPartnerRegPath = String(
    payload.epicPartnerRegistryPath || installedRecord?.epicPartnerRegistryPath || ''
  )
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '');
  const winEpicPartnerRegistryLeaf = rawWinEpicPartnerRegPath
    ? rawWinEpicPartnerRegPath.split('\\').pop() || ''
    : '';

  if (
    !externalInstallId ||
    normPlatformId === 'epic' ||
    !realInstallPath ||
    !realGameExe ||
    !fs.existsSync(toHostFilesystemPath(realGameExe))
  ) {
    const hostGames = scanHostPublisherInstalledGames({
      ...options,
      platform: 'win32',
    }).filter((g) => g.handoffId === chainedHandoffId);
    let matchedHostGame = null;
    if (externalInstallId) {
      matchedHostGame =
        hostGames.find(
          (g) =>
            g.externalInstallId &&
            String(g.externalInstallId).toLowerCase() === externalInstallId.toLowerCase()
        ) || null;
    }
    if (!matchedHostGame && realInstallPath) {
      matchedHostGame =
        hostGames.find(
          (g) =>
            toHostFilesystemPath(g.installPath).toLowerCase() ===
            toHostFilesystemPath(realInstallPath).toLowerCase()
        ) || null;
    }
    if (!matchedHostGame && winEpicPartnerRegistryLeaf) {
      matchedHostGame =
        hostGames.find(
          (g) =>
            doChainedPublisherTitlesMatch(g.title, winEpicPartnerRegistryLeaf) ||
            (g.installPath &&
              doChainedPublisherTitlesMatch(
                path.basename(toHostFilesystemPath(g.installPath)),
                winEpicPartnerRegistryLeaf
              ))
        ) || null;
    }
    if (!matchedHostGame) {
      const searchTitle = String(payload.title || installedRecord?.title || '');
      if (searchTitle) {
        matchedHostGame =
          hostGames.find((g) => doChainedPublisherTitlesMatch(g.title, searchTitle)) || null;
      }
    }
    if (matchedHostGame) {
      if (matchedHostGame.externalInstallId && (!externalInstallId || normPlatformId === 'epic')) {
        externalInstallId = matchedHostGame.externalInstallId;
      }
      if (matchedHostGame.installPath) {
        realInstallPath = matchedHostGame.installPath;
      }
      if (
        matchedHostGame.executablePath &&
        !isGdkStubExecutablePath(matchedHostGame.executablePath)
      ) {
        realGameExe = matchedHostGame.executablePath;
      }
      persistHealedManagedRecord({
        installPath: realInstallPath || undefined,
        executablePath: realGameExe || undefined,
        externalInstallId: externalInstallId || undefined,
      });
    }
  }

  const winSpec = buildChainedLauncherLaunchSpec({
    handoffId: chainedHandoffId,
    externalInstallId,
    launcherBinaryPath: hostLauncher.binaryPath || undefined,
    gameExecutablePath: realGameExe || undefined,
    installDir: realInstallPath || localInstallDir || payload.installPath || '',
    bottlePath: '',
    epicPartnerRegistryPath: rawWinEpicPartnerRegPath || undefined,
    storefrontId: normPlatformId || undefined,
    platform: 'win32',
  });
  if (
    !realGameExe &&
    winSpec.targetExecutablePath &&
    !isGdkStubExecutablePath(winSpec.targetExecutablePath)
  ) {
    realGameExe = winSpec.targetExecutablePath;
  }

  const canSpawnWinExe = Boolean(
    winSpec.launcherExe &&
      !isGdkStubExecutablePath(winSpec.launcherExe) &&
      (fs.existsSync(toHostFilesystemPath(winSpec.launcherExe)) ||
        fs.existsSync(winSpec.launcherExe) ||
        typeof options.gameSpawnFn === 'function' ||
        typeof options.spawnFn === 'function')
  );
  const isDirectWinGameExe = Boolean(
    canSpawnWinExe &&
      realGameExe &&
      winSpec.launcherExe &&
      toHostFilesystemPath(winSpec.launcherExe).toLowerCase() ===
        toHostFilesystemPath(realGameExe).toLowerCase()
  );

  const wasHostPublisherRunning = isDirectWinGameExe
    ? false
    : await checkHostWinPublisherUiRunningAsync(chainedHandoffId, options);

  /** @type {any} */
  let winChild = null;
  let winLaunchMethod = 'chained_publisher_launcher';
  if (canSpawnWinExe) {
    const gameSpawnImpl = options.gameSpawnFn || options.spawnFn || spawn;
    const winArgs = [
      ...(winSpec.args || []),
      ...(isDirectWinGameExe ? userLaunchArgs : []),
    ];
    const hostInstallCwd = realInstallPath ? toHostFilesystemPath(realInstallPath) : '';
    const hostExeDirCwd = winSpec.launcherExe
      ? path.dirname(toHostFilesystemPath(winSpec.launcherExe))
      : '';
    const winCwd =
      hostInstallCwd && fs.existsSync(hostInstallCwd)
        ? hostInstallCwd
        : hostExeDirCwd && fs.existsSync(hostExeDirCwd)
          ? hostExeDirCwd
          : process.cwd();
    winChild = gameSpawnImpl(winSpec.launcherExe, winArgs, {
      cwd: winCwd,
      env: {
        ...process.env,
        ...(launchConfig.environmentVariables || {}),
        ...(winSpec.envOverrides || {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      windowsHide: false,
    });
    winLaunchMethod = isDirectWinGameExe ? 'direct' : 'chained_publisher_launcher';
  } else {
    const targetUri =
      winSpec.uri || (normPlatformId === 'xbox' ? buildStorefrontLaunchUri(payload) : null);
    if (!targetUri) {
      return {
        success: false,
        error: `No installed ${ecosystem?.displayName || chainedHandoffId} client or protocol URI found to launch this game.`,
      };
    }
    await openExternalUri(targetUri, options);
    winLaunchMethod = 'storefront_uri';
  }

  const candidateWinExeNames = collectChainedGameCandidateExeNames(
    realInstallPath ? toHostFilesystemPath(realInstallPath) : '',
    realGameExe
  );
  const winSession = {
    sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    gameId,
    title: String(payload.title || gameId),
    platformId: payload.platformId || chainedHandoffId,
    platformGameId: String(payload.platformGameId || gameId),
    pid: isDirectWinGameExe ? winChild?.pid : undefined,
    startedAt: new Date().toISOString(),
    launchMethod: winLaunchMethod,
    executablePath: realGameExe || winSpec.launcherExe || undefined,
    status: 'running',
    isBottledSession: false,
  };

  /** @type {any} */
  const winEntry = {
    session: winSession,
    platformId: winSession.platformId,
    child: winChild,
    pid: isDirectWinGameExe ? winChild?.pid || 0 : 0,
    elevatedTargetPid: 0,
    reLatchedBottleChildPid: 0,
    isChainedPublisherLauncher: true,
    chainedLauncherHandoff: chainedHandoffId,
    launchedViaPublisherClient: !isDirectWinGameExe,
    wasHostPublisherRunning,
    wokePublisherClientByLauncher: !isDirectWinGameExe && !wasHostPublisherRunning,
    ephemeralClientWoken: !isDirectWinGameExe && !wasHostPublisherRunning,
    targetExeBasenamesLower: candidateWinExeNames,
    pollTimer: null,
    startedMs: Date.now(),
    postExitCommand: launchConfig.postExitCommand,
    finalized: false,
    stopping: false,
    stderrBuffer: '',
    exitCode: null,
    stoppedByUser: false,
    wineBinary: null,
    wineserverBinary: null,
    winePrefix: null,
    installPath: realInstallPath || localInstallDir || '',
    platformGameId: String(payload.platformGameId || gameId),
    launchOptions: options,
    launchConfig,
    effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
  };

  activeSessions.set(gameId, winEntry);
  releasePendingPlatformLock();

  if (effectivePerfPolicy.pauseDownloadsInGame !== false) {
    try {
      pauseActiveDownloadsForInGame(options);
    } catch {}
  }
  emitSessionUpdated({ session: { ...winSession }, event: 'started' }, options);

  const hasWinMockProcessSource =
    typeof options.getProcessListOutput === 'function' ||
    typeof options.mockProcessListOutput === 'string' ||
    typeof options.execFileImpl === 'function' ||
    typeof options.execFileFn === 'function';
  const canPollWinProcessTable =
    !options.disableChainedLauncherPolling &&
    (!isTestEnvironment(options) ||
      hasWinMockProcessSource ||
      options.allowProcessCheckInTest === true);

  let winChildExitedAt = 0;
  /** @type {number | null} */
  let winChildExitCode = null;
  if (winChild && typeof winChild.on === 'function') {
    winChild.on('error', (/** @type {any} */ err) => {
      winEntry.exitCode = -1;
      winEntry.stderrBuffer += '\n' + (err?.message || String(err));
      if (!winEntry.stopping) {
        finalizeGameSession(gameId, options);
      }
    });
    winChild.on('exit', (/** @type {any} */ code) => {
      winChildExitedAt = Date.now();
      winChildExitCode = typeof code === 'number' ? code : 0;
      if (winEntry.stopping || winEntry.stoppedByUser || !canPollWinProcessTable) {
        winEntry.exitCode = winChildExitCode;
        if (!winEntry.stopping) {
          finalizeGameSession(gameId, options);
        }
      }
    });
  }

  if (canPollWinProcessTable) {
    const pollMs = Math.max(25, Number(options.chainedLauncherPollIntervalMs || 1500));
    const maxBootstrapWaitMs = Number(options.chainedLauncherMaxBootstrapWaitMs ?? 90000);
    const graceAfterLauncherExitMs = Number(options.chainedLauncherBootstrapGraceMs ?? 30000);
    const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
    let seenWinGameRunning = false;
    let consecutiveMisses = 0;

    const handleWinProcessList = (/** @type {any} */ err, /** @type {any} */ stdout) => {
      if (err || winEntry.finalized || winEntry.stopping || winEntry.stoppedByUser) return;
      const outStr = String(stdout || '');
      const matchedPid =
        candidateWinExeNames.length > 0
          ? extractMatchedPidFromProcessOutput(outStr, candidateWinExeNames, 'win32')
          : 0;
      if (matchedPid > 0) {
        seenWinGameRunning = true;
        consecutiveMisses = 0;
        winEntry.pid = matchedPid;
        winEntry.reLatchedBottleChildPid = matchedPid;
        if (winEntry.session) {
          winEntry.session.pid = matchedPid;
        }
        return;
      }
      if (seenWinGameRunning) {
        consecutiveMisses += 1;
        if (consecutiveMisses >= (hasWinMockProcessSource ? 1 : 2)) {
          clearInterval(pollTimer);
          winEntry.pollTimer = null;
          winEntry.exitCode = 0;
          finalizeGameSession(gameId, options);
        }
        return;
      }
      const nowMs = Date.now();
      const timedOutTotal =
        maxBootstrapWaitMs > 0 && nowMs - winEntry.startedMs >= maxBootstrapWaitMs;
      const timedOutAfterExit =
        winChildExitedAt > 0 &&
        graceAfterLauncherExitMs >= 0 &&
        nowMs - winChildExitedAt >= graceAfterLauncherExitMs;
      if (timedOutTotal || timedOutAfterExit) {
        clearInterval(pollTimer);
        winEntry.pollTimer = null;
        winEntry.exitCode = winChildExitCode ?? 0;
        finalizeGameSession(gameId, options);
      }
    };

    const pollTimer = setInterval(() => {
      if (winEntry.finalized || winEntry.stopping || winEntry.stoppedByUser) {
        clearInterval(pollTimer);
        winEntry.pollTimer = null;
        return;
      }
      if (typeof options.getProcessListOutput === 'function') {
        Promise.resolve(options.getProcessListOutput())
          .then((out) => handleWinProcessList(null, out))
          .catch(() => {});
      } else if (typeof options.mockProcessListOutput === 'string') {
        handleWinProcessList(null, options.mockProcessListOutput);
      } else if (!options.homedir || options.execFileImpl || options.execFileFn) {
        execFileImpl(
          'tasklist.exe',
          ['/FO', 'CSV', '/NH'],
          { timeout: 2500, windowsHide: true },
          handleWinProcessList
        );
      }
    }, pollMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    winEntry.pollTimer = pollTimer;
  }

  return {
    success: true,
    message: `Launched ${winSession.title} via ${ecosystem?.displayName || chainedHandoffId}`,
    session: { ...winSession },
    ...(winSession.executablePath ? { executablePath: winSession.executablePath } : {}),
  };
}

/**
 * C) Direct Game Launcher, Process Monitor & Playtime Tracker
 */
async function launchGame(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
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
    const gameId = String(
      payload.gameId || `${payload.platformId || 'custom'}-${payload.platformGameId || 'game'}`
    );
    if (activeSessions.has(gameId)) {
      const existing = activeSessions.get(gameId);
      return {
        success: true,
        message: 'Game is already running',
        session: { ...existing.session },
      };
    }

    const normPlatformId = String(payload.platformId || '')
      .trim()
      .toLowerCase();
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

    const emitPreLaunchCloudTelemetry = (/** @type {any} */ syncResult) => {
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
    const effectivePerfPolicy = payload.performanceSettings
      ? resolveEffectivePerformancePolicy(launchConfig, payload.performanceSettings, options)
      : resolveEffectivePerformancePolicy(launchConfig, options);
    /** @type {any} */
    let gogWakeResult = null;
    /** @type {any} */
    let steamMinimalSpawnedResult = null;

    const rawLaunchMethod = launchConfig.launchMethod || payload.launchMethod || 'auto';
    const launchMethod = rawLaunchMethod === 'custom' ? 'auto' : rawLaunchMethod;
    const preferWindowsExe =
      platform === 'darwin' &&
      launchMethod === 'compatibility_layer' &&
      !launchConfig.customExecutablePath;

    // Resolve executable path
    /** @type {string | undefined} */
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

    /** @type {any} */
    let appInfoSpec = null;
    /** @type {any} */
    let xboxGameCfg = null;
    /** @type {any} */
    let xboxAppxCfg = null;
    /** @type {any} */
    let xboxReceipt = null;
    if (payload.platformId === 'xbox') {
      const xboxInspectRoot =
        localInstallDir ||
        payload.installPath ||
        (payload.executablePath ? path.dirname(toLocalFsPath(payload.executablePath)) : '');
      if (xboxInspectRoot) {
        for (const rName of ['.onelauncher-xbox-receipt.json', '.onelauncher-xbox-install.json']) {
          const rPath = path.join(xboxInspectRoot, rName);
          if (fs.existsSync(rPath)) {
            try {
              const parsedR = JSON.parse(fs.readFileSync(rPath, 'utf8'));
              if (parsedR && parsedR.status === 'completed') {
                xboxReceipt = parsedR;
                break;
              }
            } catch {}
          }
        }
        xboxGameCfg = inspectMicrosoftGameConfig(xboxInspectRoot);
        xboxAppxCfg = inspectAppxManifest(xboxInspectRoot);
        if (!launchConfig.customExecutablePath && !resolvedExePath) {
          const xboxExeCandidates = [];
          if (xboxGameCfg?.primaryExecutable) {
            const normPrimary = xboxGameCfg.primaryExecutable.replace(/\\/g, path.sep);
            xboxExeCandidates.push(
              path.join(xboxGameCfg.contentRootDir || xboxInspectRoot, normPrimary),
              path.join(xboxInspectRoot, normPrimary)
            );
          }
          if (xboxReceipt?.executableRelPath) {
            const relCand = path.join(
              xboxInspectRoot,
              String(xboxReceipt.executableRelPath).replace(/\\/g, path.sep)
            );
            if (!isExcludedExecutable(path.basename(relCand)) && !isGdkStubExecutablePath(relCand)) {
              xboxExeCandidates.push(relCand);
            }
          }
          if (xboxAppxCfg?.primaryExecutable) {
            const normAppxPrimary = xboxAppxCfg.primaryExecutable.replace(/\\/g, path.sep);
            xboxExeCandidates.push(
              path.join(xboxAppxCfg.contentRootDir || xboxInspectRoot, normAppxPrimary),
              path.join(xboxInspectRoot, normAppxPrimary)
            );
          }
          for (const candidateCfgExe of xboxExeCandidates) {
            if (
              candidateCfgExe &&
              !isExcludedExecutable(path.basename(candidateCfgExe)) &&
              !isGdkStubExecutablePath(candidateCfgExe) &&
              !candidateCfgExe.toLowerCase().endsWith('.olpart') &&
              fs.existsSync(candidateCfgExe)
            ) {
              resolvedExePath = candidateCfgExe;
              if (platform === 'darwin' && /\.exe$/i.test(candidateCfgExe)) {
                isWindowsBinaryOnMac = true;
              }
              break;
            }
          }
          if (
            !xboxGameCfg &&
            xboxAppxCfg?.requiresCoreWindow &&
            !resolvedExePath &&
            platform === 'win32' &&
            (payload.appUserModelId || xboxAppxCfg?.appUserModelId)
          ) {
            resolvedExePath = 'explorer.exe';
          }
        }
      }
      if (
        platform === 'darwin' &&
        !xboxGameCfg &&
        xboxAppxCfg?.requiresCoreWindow &&
        !resolvedExePath
      ) {
        return {
          success: false,
          error:
            'Legacy UWP CoreWindow title requires Windows OS runtime; GDK desktop executables are required on macOS bottles.',
        };
      }
    } else if (!launchConfig.customExecutablePath && payload.platformId === 'steam') {
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
        if (appInfoSpec && appInfoSpec.isWindowsBinaryOnMac) {
          isWindowsBinaryOnMac = true;
        }
        if (
          !resolvedExePath &&
          appInfoSpec &&
          appInfoSpec.executablePath &&
          fs.existsSync(appInfoSpec.executablePath)
        ) {
          resolvedExePath = appInfoSpec.executablePath;
        }
      }
    }

    // Intercept Chained Publisher Launcher titles & Xbox GDKStubGame.exe stub packages
    // while keeping Steam `storefront_depot_uri` (`link2ea://` / `uplay://`) titles on the Steam launch path
    let isSteamStorefrontDepotUri = false;
    let steamChainedPublisherHandoff = '';
    {
      const cleanLaunchLookupId = String(payload.platformGameId || gameId || '')
        .replace(/^(epic|gog|steam|xbox|ubisoft|ea|bnet|rockstar|riot)[-_:]/i, '')
        .trim();
      const managedRecordsForLaunch = loadManagedInstalledGames(
        resolveIsolatedHomedirAndUserData(options).userDataDir
      );
      const installedRecord = managedRecordsForLaunch.find(
        (/** @type {any} */ r) =>
          (r.platformId === payload.platformId &&
            ((payload.platformGameId &&
              r.platformGameId &&
              String(r.platformGameId) === String(payload.platformGameId)) ||
              (cleanLaunchLookupId &&
                r.platformGameId &&
                String(r.platformGameId) === cleanLaunchLookupId))) ||
          (localInstallDir &&
            r.installPath &&
            path.resolve(toLocalFsPath(r.installPath)) === path.resolve(localInstallDir))
      );

      const epicResolvedMeta =
        normPlatformId === 'epic' ? resolveEpicAppAndPlatforms(payload, options) : null;

      const standalonePublisherPlatform = ['ubisoft', 'ea', 'bnet', 'rockstar', 'riot'].includes(
        normPlatformId
      )
        ? normPlatformId
        : '';
      let chainedHandoffId = resolveAnyChainedHandoffId(
        payload.chainedLauncherHandoff ||
          payload.chainedRequiresLauncherHandoff ||
          payload.externalStorefrontHandoff ||
          installedRecord?.chainedLauncherHandoff ||
          installedRecord?.chainedRequiresLauncherHandoff ||
          installedRecord?.externalStorefrontHandoff ||
          xboxReceipt?.chainedLauncherHandoff ||
          xboxReceipt?.externalStorefrontHandoff ||
          epicResolvedMeta?.chainedLauncherHandoff ||
          appInfoSpec?.chainedLauncherHandoff ||
          standalonePublisherPlatform
      );

      const hasGdkStubIndicator = Boolean(
        isGdkStubExecutablePath(launchConfig.customExecutablePath || '') ||
          isGdkStubExecutablePath(resolvedExePath || '') ||
          isGdkStubExecutablePath(payload.executablePath || '') ||
          isGdkStubExecutablePath(installedRecord?.executablePath || '') ||
          xboxGameCfg?.isExternalLauncherStub
      );

      if (resolvedExePath && isGdkStubExecutablePath(resolvedExePath)) {
        resolvedExePath = undefined;
      }

      if (!chainedHandoffId && hasGdkStubIndicator) {
        const pfnProbe = String(
          xboxGameCfg?.packageFamilyName ||
            xboxAppxCfg?.packageFamilyName ||
            payload.packageFamilyName ||
            installedRecord?.packageFamilyName ||
            ''
        ).toLowerCase();
        if (pfnProbe.includes('ubisoft')) chainedHandoffId = 'ubisoft';
        else if (
          pfnProbe.includes('electronicarts') ||
          pfnProbe.includes('electronicartsmobile') ||
          pfnProbe.includes('_q5ha1ztykcgvj') ||
          pfnProbe.includes('.ea')
        ) {
          chainedHandoffId = 'ea';
        } else if (pfnProbe.includes('blizzard') || pfnProbe.includes('activision')) {
          chainedHandoffId = 'bnet';
        } else if (pfnProbe.includes('rockstar') || pfnProbe.includes('take-two')) {
          chainedHandoffId = 'rockstar';
        } else if (pfnProbe.includes('riotgames')) {
          chainedHandoffId = 'riot';
        }
      }

      if (!chainedHandoffId && hasGdkStubIndicator) {
        return {
          success: false,
          error:
            'This Xbox package is an external publisher launcher stub (GDKStubGame.exe) and cannot be executed directly.',
        };
      }

      if (normPlatformId === 'steam' && !hasGdkStubIndicator) {
        const steamProbeDir =
          localInstallDir ||
          (payload.installPath ? toLocalFsPath(payload.installPath) : '') ||
          (installedRecord?.installPath ? toLocalFsPath(installedRecord.installPath) : '');
        const hasSteamEaInstallerXml = Boolean(
          steamProbeDir &&
            fs.existsSync(path.join(steamProbeDir, '__Installer', 'installerdata.xml'))
        );
        if (
          chainedHandoffId ||
          hasSteamEaInstallerXml ||
          appInfoSpec?.requiresStorefrontProtocolLaunch ||
          payload.requiresStorefrontProtocolLaunch ||
          installedRecord?.requiresStorefrontProtocolLaunch ||
          payload.chainedHandoffTopology === 'storefront_depot_uri' ||
          installedRecord?.chainedHandoffTopology === 'storefront_depot_uri'
        ) {
          isSteamStorefrontDepotUri = true;
          steamChainedPublisherHandoff =
            chainedHandoffId ||
            resolveAnyChainedHandoffId(appInfoSpec?.chainedLauncherHandoff) ||
            (hasSteamEaInstallerXml ? 'ea' : '');
        }
      }

      if (chainedHandoffId && !isSteamStorefrontDepotUri) {
        const effectivePayload =
          epicResolvedMeta &&
          (epicResolvedMeta.epicPartnerRegistryPath || epicResolvedMeta.chainedExternalInstallId)
            ? {
                ...payload,
                ...(epicResolvedMeta.epicPartnerRegistryPath && !payload.epicPartnerRegistryPath
                  ? { epicPartnerRegistryPath: epicResolvedMeta.epicPartnerRegistryPath }
                  : {}),
                ...(epicResolvedMeta.chainedExternalInstallId && !payload.chainedExternalInstallId
                  ? { chainedExternalInstallId: epicResolvedMeta.chainedExternalInstallId }
                  : {}),
                ...(epicResolvedMeta.chainedHandoffTopology && !payload.chainedHandoffTopology
                  ? { chainedHandoffTopology: epicResolvedMeta.chainedHandoffTopology }
                  : {}),
              }
            : payload;
        const acquireBottleLock = async (/** @type {string} */ resolvedTargetPrefix) => {
          if (!resolvedTargetPrefix) return;
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
                platformId: payload.platformId || chainedHandoffId,
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
        };

        return await launchChainedPublisherGame({
          gameId,
          normPlatformId,
          chainedHandoffId,
          payload: effectivePayload,
          options,
          platform,
          launchConfig,
          effectivePerfPolicy,
          localInstallDir,
          isInstallInsideBottle,
          isWindowsBinaryOnMac,
          hasGdkStubIndicator,
          resolvedExePath,
          installedRecord,
          xboxReceipt,
          acquireBottleLock,
          releasePendingBottleLock,
          releasePendingPlatformLock,
        });
      }
    }

    if (preferWindowsExe && !resolvedExePath && localInstallDir && fs.existsSync(localInstallDir)) {
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
      resolvedExePath = discovered.executablePath || undefined;
      if (discovered.isWindowsBinaryOnMac) {
        isWindowsBinaryOnMac = true;
      } else if (discovered.executablePath && !/\.exe$/i.test(discovered.executablePath)) {
        isWindowsBinaryOnMac = false;
      }
    }
    if (
      platform === 'darwin' &&
      !launchConfig.customExecutablePath &&
      resolvedExePath &&
      /\.exe$/i.test(resolvedExePath)
    ) {
      const candidateGogDir = localInstallDir || path.dirname(resolvedExePath);
      if (candidateGogDir && fs.existsSync(path.join(candidateGogDir, 'GOGLauncher.exe'))) {
        try {
          const gogInfoFile = fs
            .readdirSync(candidateGogDir)
            .find((f) => /^\.?goggame-\d+\.info$/i.test(f));
          if (gogInfoFile) {
            const parsedInfo = JSON.parse(
              fs.readFileSync(path.join(candidateGogDir, gogInfoFile), 'utf8')
            );
            if (Array.isArray(parsedInfo?.playTasks)) {
              const resolvedBaseLower = path.basename(resolvedExePath).toLowerCase();
              const matchedLauncherTask = parsedInfo.playTasks.find(
                (/** @type {any} */ t) =>
                  t &&
                  typeof t.path === 'string' &&
                  String(t.category || '').trim().toLowerCase() === 'launcher' &&
                  !t.arguments &&
                  path.win32.basename(t.path.trim()).toLowerCase() === resolvedBaseLower
              );
              const gameTask = matchedLauncherTask
                ? parsedInfo.playTasks.find(
                    (/** @type {any} */ t) =>
                      t &&
                      typeof t.path === 'string' &&
                      (!t.type || String(t.type) === 'FileTask') &&
                      String(t.category || '').trim().toLowerCase() === 'game'
                  )
                : null;
              if (gameTask && gameTask.path) {
                const directGameExe = resolveCaseInsensitiveRelFile(
                  candidateGogDir,
                  String(gameTask.path).trim().replace(/\\/g, '/')
                );
                if (directGameExe && fs.existsSync(directGameExe)) {
                  resolvedExePath = directGameExe;
                  isWindowsBinaryOnMac = true;
                }
              }
            }
          }
        } catch {}
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

    const hasExplicitLaunchArgs = Boolean(
      (typeof launchConfig.launchArguments === 'string' && launchConfig.launchArguments.trim()) ||
        (Array.isArray(payload.launchArgs) && payload.launchArgs.length > 0) ||
        (typeof payload.launchArguments === 'string' && payload.launchArguments.trim())
    );
    if (resolvedExePath && !launchConfig.customExecutablePath && !hasExplicitLaunchArgs) {
      const siblingCandidate = resolveSiblingLauncherStub(
        resolvedExePath,
        localInstallDir || payload.installPath || ''
      );
      if (siblingCandidate && fs.existsSync(siblingCandidate)) {
        resolvedExePath = siblingCandidate;
      }
    }

    if (
      resolvedExePath &&
      resolvedExePath !== 'explorer.exe' &&
      resolvedExePath.toLowerCase().endsWith('.exe') &&
      fs.existsSync(resolvedExePath)
    ) {
      /** @type {any} */
      let peInfo = inspectWindowsExecutableHeader(resolvedExePath, {
        strictPe: Boolean(options.strictPe),
      });
      if (peInfo.is16BitDos && !launchConfig.customExecutablePath) {
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
        peInfo =
          resolvedExePath &&
          resolvedExePath.toLowerCase().endsWith('.exe') &&
          fs.existsSync(resolvedExePath)
            ? inspectWindowsExecutableHeader(resolvedExePath, {
                strictPe: Boolean(options.strictPe),
              })
            : null;
      }
      if (
        peInfo &&
        peInfo.exists &&
        peInfo.isValidPe &&
        !isCompatibleX86OrX64PeHeader(peInfo, {
          hostPlatform: platform,
          hostArch: options.arch || process.arch,
        }) &&
        !launchConfig.customExecutablePath
      ) {
        const searchRoot = localInstallDir || payload.installPath || path.dirname(resolvedExePath);
        const compatibleAltExe = findBestX86OrX64WindowsExe(searchRoot, {
          strictPe: Boolean(options.strictPe),
          platform,
          arch: options.arch || process.arch,
        });
        if (compatibleAltExe && fs.existsSync(compatibleAltExe)) {
          diagLog.info('launchGame.peArchFallbackSelected', {
            gameId,
            rejectedExe: path.basename(resolvedExePath),
            rejectedMachine: peInfo.machineHex,
            selectedExe: path.basename(compatibleAltExe),
          });
          resolvedExePath = compatibleAltExe;
          peInfo = inspectWindowsExecutableHeader(resolvedExePath, {
            strictPe: Boolean(options.strictPe),
          });
        } else {
          return {
            success: false,
            error: `Launch failed: Executable "${path.basename(resolvedExePath)}" targets unsupported architecture (${peInfo.machineHex || 'ARM64'}) and no compatible x86/x64 executable was found in the installation.`,
          };
        }
      }
      if (resolvedExePath && peInfo && peInfo.exists && !peInfo.isValidPe) {
        return {
          success: false,
          error: `Launch failed: Game executable "${path.basename(resolvedExePath)}" is incomplete or corrupted (invalid Windows PE header). Please repair or reinstall the game.`,
        };
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
    /** @type {Record<string, any>} */
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
              resolve(undefined);
            }
          );
        } catch (syncErr) {
          diagLog.warn('launchGame.preLaunchCommandSpawn', syncErr, { gameId });
          resolve(undefined);
        }
      });
    }

    const isMacNativeExecutable =
      Boolean(resolvedExePath) &&
      !/\.(exe|bat|msi)$/i.test(String(resolvedExePath)) &&
      !isWindowsBinaryOnMac;
    const useCompatLayer =
      platform === 'darwin' &&
      (isWindowsBinaryOnMac ||
        Boolean(resolvedExePath && /\.(exe|bat|msi)$/i.test(resolvedExePath)) ||
        (launchMethod === 'compatibility_layer' && !isMacNativeExecutable) ||
        (!isMacNativeExecutable &&
          launchConfig.compatibilityLayer &&
          launchConfig.compatibilityLayer !== 'native'));

    const effectiveCaps =
      resolvedExePath &&
      resolvedExePath !== 'explorer.exe' &&
      /\.exe$/i.test(String(resolvedExePath))
        ? resolveEffectiveGameExecutableCapabilities(
            resolvedExePath,
            localInstallDir || '',
            options
          )
        : null;

    if (platform === 'win32' && !useCompatLayer) {
      if (localInstallDir && fs.existsSync(localInstallDir)) {
        try {
          await executeGogGameScript(localInstallDir, {
            ...options,
            platform: 'win32',
          });
        } catch (winScriptErr) {
          diagLog.warn('launchGame.win32GogScriptNonFatal', winScriptErr, { gameId });
        }
      }

      if (effectiveCaps) {
        const rawCompatCombined = `${effectiveCaps.gogCompatibilityFlags || ''} ${effectiveCaps.launcherSettings?.environmentVars || ''}`;
        const isLegacyDpiSensitive = Boolean(
          effectiveCaps.usesLegacyDirectDrawOrD3d ||
            effectiveCaps.needsLegacyDisplayModeSynthesis ||
            /\b(?:16BITCOLOR|256COLOR|640X480)\b/i.test(rawCompatCombined)
        );
        const shouldKeepCompatToken = (/** @type {string} */ tok) => {
          if (!tok) return false;
          if (
            launchConfig.runAsAdmin !== true &&
            /^(?:RUNASADMIN|ElevateCreateProcess)$/i.test(tok)
          ) {
            return false;
          }
          if (isLegacyDpiSensitive && /^HIGHDPIAWARE$/i.test(tok)) {
            return false;
          }
          return true;
        };

        const compatTokens = [];
        if (effectiveCaps.gogCompatibilityFlags) {
          for (const tok of effectiveCaps.gogCompatibilityFlags.split(/\s+/)) {
            if (shouldKeepCompatToken(tok) && !compatTokens.includes(tok)) {
              compatTokens.push(tok);
            }
          }
        }
        if (effectiveCaps.launcherSettings?.environmentVars) {
          for (const pair of effectiveCaps.launcherSettings.environmentVars.split(/[;\r\n]+/)) {
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const envKey = pair.slice(0, eq).trim();
            const envVal = pair.slice(eq + 1).trim();
            if (!envKey || !envVal) continue;
            if (/^__COMPAT_LAYER$/i.test(envKey)) {
              for (const tok of envVal.split(/\s+/)) {
                if (shouldKeepCompatToken(tok) && !compatTokens.includes(tok)) {
                  compatTokens.push(tok);
                }
              }
            } else if (!launchConfig.environmentVariables?.[envKey] && env[envKey] === undefined) {
              env[envKey] = envVal;
            }
          }
        }
        if (
          compatTokens.length > 0 &&
          !launchConfig.environmentVariables?.__COMPAT_LAYER
        ) {
          const existingCompat = String(env.__COMPAT_LAYER || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          for (const tok of compatTokens) {
            if (!existingCompat.includes(tok)) {
              existingCompat.push(tok);
            }
          }
          env.__COMPAT_LAYER = existingCompat.join(' ');
        }
      }
    }

    const hasExplicitPerGameLifecycleOverride = Boolean(
      launchConfig.storefrontClientLifecycle &&
        launchConfig.storefrontClientLifecycle !== 'default'
    );
    if (
      useCompatLayer &&
      (payload.platformId === 'epic' || payload.platformId === 'xbox') &&
      !hasExplicitPerGameLifecycleOverride
    ) {
      effectivePerfPolicy.storefrontClientLifecycle = 'fast_direct_bypass';
      launchConfig.storefrontClientLifecycle = 'fast_direct_bypass';
    }

    const isFastMinimalBypass =
      !isSteamStorefrontDepotUri &&
      (effectivePerfPolicy.storefrontClientLifecycle === 'fast_direct_bypass' ||
        (payload.platformId === 'steam' && launchMethod === 'direct'));

    const effectiveSteamAppId =
      payload.platformId === 'steam'
        ? String(payload.steamAppId || payload.platformGameId || '')
            .replace(/^steam[-_]/i, '')
            .trim()
        : '';

    if (
      isSteamStorefrontDepotUri &&
      platform === 'darwin' &&
      !resolvedExePath &&
      isInstallInsideBottle &&
      localInstallDir
    ) {
      const enclosingBottle = extractBottleRootFromPath(localInstallDir);
      const fallbackBottleSteam = enclosingBottle ? resolveBottleSteamExe(enclosingBottle) : null;
      if (fallbackBottleSteam) {
        resolvedExePath = fallbackBottleSteam;
      }
    }

    const isAutoLikeMethod = launchMethod === 'auto' || launchMethod === 'custom';

    const isSteamAutoUriPreferred =
      payload.platformId === 'steam' &&
      (isAutoLikeMethod || isSteamStorefrontDepotUri) &&
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
      const preGeneratedSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const effectiveDisplayScalingMode =
        effectivePerfPolicy.effectiveDisplayScalingMode || 'auto_fullscreen';
      const effectiveDisplayAspectRatio =
        effectivePerfPolicy.effectiveDisplayAspectRatio || 'preserve_aspect';
      const enableFullscreenHotkey = effectivePerfPolicy.enableFullscreenHotkey !== false;
      const initialBottleFullscreen =
        effectiveDisplayScalingMode === 'auto_fullscreen' ||
        effectiveDisplayScalingMode === 'force_fullscreen';
      let bottleDisplayControlFilePosix = '';
      let bottleDisplayStatusFilePosix = '';
      /** @type {ReturnType<typeof stageBottleDisplayScalerBinaries> | null} */
      let bottleDisplayStagedInfo = null;
      let bottleDisplayScalerWrapped = false;
      let bottleShouldWatchSteamGameDir = false;
      /** @type {string[]} */
      let bottleSteamDisplayDllArgs = [];
      /** @type {any} */
      let bottleDisplayWatcherChild = null;
      /** @type {any} */
      let compatResult = null;
      /** @type {any} */
      let chosenCompatLayer = null;
      /** @type {string | null} */
      let targetWinePrefix = null;
      /** @type {string | null} */
      let bottleSteamExe = null;
      let shouldLaunchViaBottleSteam = false;
      let wasBottleSteamRunning = false;
      let wasBottleSteamPublisherRunning = false;
      let wokeBottleSteamPublisherByLauncher = false;
      /** @type {string | null} */
      let bottleGogExe = null;
      let shouldWakeBottleGog = false;
      let wasBottleGogRunning = false;
      let wokeBottleGogByLauncher = false;
      /** @type {string | null} */
      let bottleEpicExe = null;
      let shouldWakeBottleEpic = false;
      let wasBottleEpicRunning = false;
      let wokeBottleEpicByLauncher = false;
      let hasOtherActiveBottleSession = false;
      /** @type {Record<string, any>} */
      let outerCompatLayerCapOptions = options;
      let outerEffectiveCompatLaunchConfig = launchConfig;
      /** @type {any} */
      let initialAppLocalProxyInfo = {
        hasOverrides: false,
        envOverrideSpec: '',
        appDefaultsMap: {},
        validatedDllNames: [],
      };
      /** @type {string[]} */
      let mergedCompatTargetExeNames = [];
      /** @type {() => Promise<void>} */
      let recycleIdleBottleWineserverBeforeClientWake = async () => {};
      /** @type {any} */
      let xboxLoopbackServer = null;
      let wasXboxAppRunningAtStart = false;
      let launchedViaXboxActivationLatch = false;
      let activatedXboxPid = 0;
      let isXboxAppxRegisteredOnWin32 = false;
      let winClientlessLauncherExe = '';
      let winClientlessPrimaryXgrDll = '';

      const resolvedXboxPfn = String(
        xboxGameCfg?.packageFamilyName ||
          xboxAppxCfg?.packageFamilyName ||
          payload.packageFamilyName ||
          xboxReceipt?.packageFamilyName ||
          ''
      ).trim();
      const resolvedXboxTitleId = String(
        xboxGameCfg?.titleId || payload.xboxTitleId || xboxReceipt?.xboxTitleId || ''
      ).trim();
      let resolvedXboxScid = String(
        xboxGameCfg?.scid ||
          payload.scid ||
          xboxReceipt?.scid ||
          (resolvedXboxTitleId ? deriveDefaultScidFromTitleId(resolvedXboxTitleId) : '')
      )
        .trim()
        .toLowerCase();
      const resolvedXboxFallbackScid = String(
        xboxGameCfg?.fallbackScid || payload.fallbackScid || xboxReceipt?.fallbackScid || ''
      )
        .trim()
        .toLowerCase();
      const resolvedXboxMsaAppId = String(
        xboxGameCfg?.msaAppId || payload.msaAppId || xboxReceipt?.msaAppId || ''
      ).trim();
      const resolvedXboxProductId = String(
        payload.xboxProductId ||
          xboxGameCfg?.storeId ||
          xboxReceipt?.xboxProductId ||
          payload.platformGameId ||
          ''
      )
        .trim()
        .replace(/^xbox[-_]/i, '')
        .toUpperCase();
      const resolvedXboxAumid = String(
        xboxGameCfg?.appUserModelId ||
          xboxAppxCfg?.appUserModelId ||
          payload.appUserModelId ||
          xboxReceipt?.appUserModelId ||
          (resolvedXboxPfn ? `${resolvedXboxPfn}!App` : '')
      ).trim();

      if (useCompatLayer) {
        const layers = detectCompatibilityLayers({
          ...options,
          ...(effectiveCaps?.isLegacy32BitOpenGl ? { preferLegacy32BitOpenGlWine: true } : {}),
        });
        const preferredType = launchConfig.compatibilityLayer;
        let chosenLayer =
          (preferredType && preferredType !== 'native'
            ? layers.find((l) => l.type === preferredType || l.id === preferredType)
            : layers.find((l) => l.type === 'crossover' || l.type === 'crossover_preview')) ||
          layers[0];

        if (!chosenLayer) {
          if (isAutoLikeMethod && options.allowStorefrontFallbackOnMissingCompat) {
            resolvedExePath = undefined;
          } else {
            return {
              success: false,
              error:
                'No Windows compatibility layer (CrossOver, Game Porting Toolkit, or Wine) detected on macOS to run this Windows executable.',
            };
          }
        } else {
          let effectiveCompatLaunchConfig = launchConfig;
          if (
            (effectiveCaps?.isLegacy32BitOpenGl ||
              effectiveCaps?.needsLegacyDisplayModeSynthesis) &&
            options.forceRequestedCompatLayer !== true &&
            chosenLayer.type === 'wine'
          ) {
            const readyCrossOverLayer = layers.find(
              (l) =>
                (l.type === 'crossover' || l.type === 'crossover_preview') &&
                l.binaryPath &&
                ((Array.isArray(l.availableBottles) && l.availableBottles.length > 0) ||
                  isTestEnvironment(options) ||
                  fs.existsSync(l.binaryPath))
            );
            if (readyCrossOverLayer) {
              diagLog.info('launchGame.routedLegacy32BitOpenGlToCrossOver', {
                gameId,
                fromRuntime: chosenLayer.name || chosenLayer.id || 'wine',
                toRuntime: readyCrossOverLayer.type,
              });
              chosenLayer = readyCrossOverLayer;
              if (
                effectiveCompatLaunchConfig?.winePrefixPath &&
                !/\/CrossOver(?: Preview)?\/Bottles\//i.test(
                  String(effectiveCompatLaunchConfig.winePrefixPath).replace(/\\/g, '/')
                )
              ) {
                effectiveCompatLaunchConfig = {
                  ...effectiveCompatLaunchConfig,
                  winePrefixPath: undefined,
                };
              }
            } else if (chosenLayer.legacy32BitOpenGlBinaryPath) {
              chosenLayer = {
                ...chosenLayer,
                binaryPath: chosenLayer.legacy32BitOpenGlBinaryPath,
              };
            }
          }

          let preCompatParadoxExe = '';
          if (resolvedExePath && /^dowser\.exe$/i.test(path.basename(resolvedExePath))) {
            const pdxCandidate =
              effectiveCaps?.paradoxDirectGameExe ||
              resolveParadoxLauncherSettings(
                resolvedExePath,
                localInstallDir || path.dirname(resolvedExePath)
              ).paradoxDirectGameExe ||
              '';
            if (pdxCandidate && fs.existsSync(pdxCandidate)) {
              preCompatParadoxExe = pdxCandidate;
            }
          }
          const preCompatProxyCandidateDirs = [
            resolvedExePath ? path.dirname(resolvedExePath) : '',
            localInstallDir || '',
            ...(preCompatParadoxExe ? [path.dirname(preCompatParadoxExe)] : []),
            ...(effectiveCaps?.targetExePaths || []).map((p) => path.dirname(p)),
          ].filter(Boolean);
          initialAppLocalProxyInfo = discoverValidatedAppLocalProxyDllOverrides(
            preCompatProxyCandidateDirs,
            effectiveCaps?.effectiveMachine || 'unknown',
            options
          );
          if (initialAppLocalProxyInfo.hasOverrides) {
            env.WINEDLLOVERRIDES = mergeWineDllOverrides(
              env.WINEDLLOVERRIDES,
              initialAppLocalProxyInfo.envOverrideSpec
            );
          }
          mergedCompatTargetExeNames = Array.from(
            new Set([
              ...(effectiveCaps?.targetExeBasenamesLower || []),
              ...(resolvedExePath ? [path.basename(resolvedExePath).toLowerCase()] : []),
              ...(preCompatParadoxExe ? [path.basename(preCompatParadoxExe).toLowerCase()] : []),
            ])
          ).filter((name) => Boolean(name && name.endsWith('.exe')));

          const compatLayerCapOptions = {
            ...options,
            ...(effectiveCaps ? { peCapabilities: effectiveCaps } : {}),
            ...(options.enableAudioBufferClamp === true ||
            (options.enableAudioBufferClamp !== false &&
              launchConfig?.audioBufferClamp === true)
              ? { enableAudioBufferClamp: true }
              : {}),
            enableLegacyDisplayModeSynthesis: Boolean(
              effectiveCaps?.needsLegacyDisplayModeSynthesis
            ),
            limitLegacy32BitGlExtensions: Boolean(effectiveCaps?.isLegacy32BitOpenGl),
            usesLegacyDirectDraw: Boolean(effectiveCaps?.usesLegacyDirectDrawOrD3d),
            displayScalingMode: effectivePerfPolicy.effectiveDisplayScalingMode,
            displayAspectRatio: effectivePerfPolicy.effectiveDisplayAspectRatio,
            exeName: resolvedExePath ? path.basename(resolvedExePath) : '',
            targetExeNames: mergedCompatTargetExeNames,
            ...(initialAppLocalProxyInfo.hasOverrides
              ? { appLocalDllOverrides: initialAppLocalProxyInfo.appDefaultsMap }
              : {}),
            ...(localInstallDir ? { installDir: localInstallDir } : {}),
          };
          outerCompatLayerCapOptions = compatLayerCapOptions;
          outerEffectiveCompatLaunchConfig = effectiveCompatLaunchConfig;

          compatResult = await ensureCompatibilityLayerReady(
            chosenLayer,
            effectiveCompatLaunchConfig,
            env,
            compatLayerCapOptions
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
                  compatLayerCapOptions
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

          if (targetWinePrefix) {
            alignWineMsyncWithLiveBottle(targetWinePrefix, env);
          }

          applyMoltenVkMetalHudDeadlockGuard(
            chosenLayer,
            env,
            effectiveCompatLaunchConfig,
            options,
            gameId
          );

          const isUnmockedHostBottleInVitest =
            Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') &&
            !options.allowBottleClientWakeInTest &&
            ((typeof options.bottleClientSpawnFn !== 'function' &&
              typeof options.gameSpawnFn !== 'function' &&
              typeof options.spawnFn !== 'function') ||
              String((chosenLayer && chosenLayer.binaryPath) || '').startsWith('/Applications/'));

          if (payload.platformId === 'steam' && targetWinePrefix && !isUnmockedHostBottleInVitest) {
            bottleSteamExe = resolveBottleSteamExe(targetWinePrefix);
            shouldLaunchViaBottleSteam = Boolean(
              bottleSteamExe &&
                effectiveSteamAppId &&
                !isFastMinimalBypass &&
                !options.disableBottleSteamLaunch &&
                !options.disableBottleStorefrontLaunch
            );
            if (shouldLaunchViaBottleSteam && steamChainedPublisherHandoff) {
              wasBottleSteamPublisherRunning = await checkBottlePublisherUiRunningAsync(
                targetWinePrefix,
                steamChainedPublisherHandoff,
                options
              );
              const pubEcosystem = /** @type {Record<string, any>} */ (CHAINED_PUBLISHER_ECOSYSTEMS)[
                steamChainedPublisherHandoff
              ];
              if (
                options.skipPublisherProvisioning !== true &&
                pubEcosystem &&
                pubEcosystem.supportedInWineBottle
              ) {
                const discoveredBottlePub = discoverBottlePublisherLauncher(
                  targetWinePrefix,
                  steamChainedPublisherHandoff
                );
                if (
                  !discoveredBottlePub?.installed ||
                  typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
                ) {
                  emitSessionUpdated(
                    {
                      gameId,
                      platformId: payload.platformId || 'steam',
                      status: 'starting',
                      event: 'starting',
                      statusMessage: `Preparing ${pubEcosystem.displayName || steamChainedPublisherHandoff} in Wine bottle...`,
                    },
                    options
                  );
                  const ensureProvisionFn =
                    typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
                      ? options.ensureChainedPublisherLauncherInstalledFn
                      : getEnsureChainedPublisherLauncherInstalled();
                  try {
                    await ensureProvisionFn(
                      {
                        handoffId: steamChainedPublisherHandoff,
                        platform: 'darwin',
                        runnerLayer: chosenLayer,
                        bottleName: String(env.CX_BOTTLE || path.basename(targetWinePrefix)),
                        bottlePath: targetWinePrefix,
                      },
                      options
                    );
                  } catch (pubProvErr) {
                    diagLog.warn('launchGame.bottleSteamPublisherProvision', pubProvErr, {
                      gameId,
                      handoffId: steamChainedPublisherHandoff,
                    });
                  }
                }
              }
              wokeBottleSteamPublisherByLauncher = !wasBottleSteamPublisherRunning;
            }
          } else if (
            payload.platformId === 'gog' &&
            targetWinePrefix &&
            !isUnmockedHostBottleInVitest
          ) {
            bottleGogExe = resolveBottleGogGalaxyExe(targetWinePrefix);
            const gogInstallUsesSdk =
              options.strictGalaxySdkCheck === true
                ? doesGogInstallUseGalaxySdk(localInstallDir, resolvedExePath)
                : true;
            shouldWakeBottleGog = Boolean(
              bottleGogExe &&
                !isFastMinimalBypass &&
                options.usesGalaxySdk !== false &&
                gogInstallUsesSdk &&
                !options.disableBottleGogLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          } else if (
            payload.platformId === 'epic' &&
            targetWinePrefix &&
            !isUnmockedHostBottleInVitest
          ) {
            bottleEpicExe = resolveBottleEpicLauncherExe(targetWinePrefix);
            shouldWakeBottleEpic = Boolean(
              bottleEpicExe &&
                !isFastMinimalBypass &&
                !options.disableBottleEpicLaunch &&
                !options.disableBottleStorefrontLaunch
            );
          }

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
          hasOtherActiveBottleSession = hasOtherActiveSessionInPrefix;

          recycleIdleBottleWineserverBeforeClientWake = async () => {
            if (
              hasOtherActiveBottleSession ||
              !targetWinePrefix ||
              !chosenCompatLayer?.binaryPath ||
              (isTestEnvironment(options) && options.recycleIdleBottleWineserver !== true) ||
              !isBottleWineserverActive(targetWinePrefix, options)
            ) {
              return;
            }
            const candidateWineserver = resolveWineserverBinary(chosenCompatLayer.binaryPath);
            const hasMockExec =
              typeof options.execFileImpl === 'function' ||
              typeof options.execFileFn === 'function';
            const canRunWineserver =
              Boolean((candidateWineserver || hasMockExec) && targetWinePrefix) &&
              (hasMockExec ||
                !options.homedir ||
                String(candidateWineserver).startsWith(options.homedir) ||
                String(candidateWineserver).startsWith(os.tmpdir()) ||
                String(candidateWineserver).startsWith('/private/var/folders') ||
                String(candidateWineserver).startsWith('/var/folders'));
            if (!canRunWineserver) return;
            const execFileForRecycle =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            deleteBottleDaemonEnvContract(targetWinePrefix);
            await shutdownWinePrefix(chosenCompatLayer.binaryPath, targetWinePrefix, 2500, {
              bottleName: String(env.CX_BOTTLE || ''),
              execFileFn: execFileForRecycle,
            });
            if (fs.existsSync(targetWinePrefix)) {
              try {
                applyCrossOverPerGameSettings(
                  targetWinePrefix,
                  outerCompatLayerCapOptions.exeName || '',
                  outerEffectiveCompatLaunchConfig,
                  {
                    ...outerCompatLayerCapOptions,
                    skipRegistrySpawn: true,
                    skipLiveWineRegSync: true,
                  }
                );
              } catch {}
            }
            alignWineMsyncWithLiveBottle(targetWinePrefix, env);
            diagLog.info('launchGame.recycledIdleBottleWineserverBeforeWake', {
              gameId,
              bottlePath: targetWinePrefix,
            });
          };

          if (!hasOtherActiveSessionInPrefix) {
            if (
              !isTestEnvironment(options) &&
              resolvedExePath &&
              resolvedExePath.toLowerCase().endsWith('.exe')
            ) {
              await killPosixProcessesMatchingWinExe(
                resolvedExePath,
                'SIGKILL',
                localInstallDir || targetWinePrefix || ''
              );
            }

            if (!shouldLaunchViaBottleSteam && !shouldWakeBottleGog && !shouldWakeBottleEpic) {
              const candidateWineserver = resolveWineserverBinary(chosenLayer.binaryPath);
              const canRunWineserver =
                Boolean(candidateWineserver && targetWinePrefix) &&
                (!options.homedir ||
                  String(candidateWineserver).startsWith(options.homedir) ||
                  String(candidateWineserver).startsWith(os.tmpdir()) ||
                  String(candidateWineserver).startsWith('/private/var/folders') ||
                  String(candidateWineserver).startsWith('/var/folders'));

              if (canRunWineserver) {
                deleteBottleDaemonEnvContract(targetWinePrefix);
                await shutdownWinePrefix(chosenLayer.binaryPath, targetWinePrefix, 2000);
                if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
                  try {
                    applyCrossOverPerGameSettings(
                      targetWinePrefix,
                      compatLayerCapOptions.exeName || '',
                      effectiveCompatLaunchConfig,
                      {
                        ...compatLayerCapOptions,
                        skipRegistrySpawn: true,
                        skipLiveWineRegSync: true,
                      }
                    );
                  } catch {}
                }
              }
            }
          }

          if (
            targetWinePrefix &&
            localInstallDir &&
            fs.existsSync(targetWinePrefix) &&
            fs.existsSync(localInstallDir)
          ) {
            try {
              await executeGogGameScript(localInstallDir, {
                ...options,
                platform,
                bottleDir: targetWinePrefix,
                wineBinaryPath: chosenLayer.binaryPath,
              });
            } catch (bottleScriptErr) {
              diagLog.warn('launchGame.bottleGogScriptNonFatal', bottleScriptErr, { gameId });
            }
          }

          if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
            const installDirKey =
              localInstallDir && fs.existsSync(localInstallDir)
                ? path.resolve(localInstallDir)
                : '';
            const effectiveSanitizeHighRes =
              compatLayerCapOptions.enableLegacyDisplayModeSynthesis ||
              compatLayerCapOptions.usesLegacyDirectDraw
                ? false
                : launchConfig.crossoverHighResolutionMode;
            const sanitizeKey = `${path.resolve(targetWinePrefix)}:${String(effectiveSanitizeHighRes)}:${String(effectivePerfPolicy.effectiveDisplayScalingMode)}:${String(effectivePerfPolicy.effectiveDisplayAspectRatio)}:${installDirKey}`;
            const lastSanitizedAt = recentDisplaySanitizeCache.get(sanitizeKey) || 0;
            if (
              options.forceSanitizeDisplayConfigs === true ||
              Date.now() - lastSanitizedAt > 4000
            ) {
              try {
                sanitizeWinePrefixDisplayConfigs(targetWinePrefix, {
                  ...options,
                  ...(localInstallDir ? { installDir: localInstallDir } : {}),
                  ...(typeof effectiveSanitizeHighRes === 'boolean'
                    ? { highResolutionMode: effectiveSanitizeHighRes }
                    : {}),
                  displayScalingMode: effectivePerfPolicy.effectiveDisplayScalingMode,
                  displayAspectRatio: effectivePerfPolicy.effectiveDisplayAspectRatio,
                });
                setBoundedMapEntry(recentDisplaySanitizeCache, sanitizeKey, Date.now(), 256);
              } catch {}
            }
          }
        }
      }

      if (resolvedExePath) {
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

        if (payload.platformId === 'epic') {
          try {
            const epicPreSyncRes = await syncEpicCloudSaves(payload, 'pre_launch', {
              ...options,
              useCompatLayer,
              winePrefix: targetWinePrefix,
              installPath: localInstallDir || payload.installPath,
            });
            emitPreLaunchCloudTelemetry(epicPreSyncRes);
          } catch (/** @type {any} */ epicSyncErr) {
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
          } catch (/** @type {any} */ gogSyncErr) {
            emitPreLaunchCloudTelemetry({
              synced: false,
              reason: gogSyncErr && gogSyncErr.message ? gogSyncErr.message : 'sync_failed',
            });
          }

          const shouldWakeHostGog =
            !(useCompatLayer && platform === 'darwin') &&
            !isFastMinimalBypass &&
            options.usesGalaxySdk !== false &&
            options.disableGogGalaxyWake !== true &&
            !(
              options.strictGalaxySdkCheck === true &&
              !doesGogInstallUseGalaxySdk(localInstallDir, resolvedExePath)
            );
          if (shouldWakeHostGog) {
            if (
              !isTestEnvironment(options) ||
              options.gogGalaxyClientPath !== undefined ||
              options.allowGogWakeInTest === true ||
              typeof options.spawnFn === 'function'
            ) {
              emitSessionUpdated(
                {
                  gameId,
                  platformId: payload.platformId || 'gog',
                  status: 'starting',
                  event: 'starting',
                  statusMessage:
                    effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? 'Starting GOG Galaxy client...'
                      : 'Starting GOG Galaxy background service...',
                },
                options
              );
            }
            try {
              gogWakeResult = await ensureGogGalaxyBackgroundService({
                ...options,
                storefrontClientLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
              });
            } catch (gogWakeErr) {
              diagLog.warn('launchGame.hostGogWake', gogWakeErr, { gameId });
            }
          }
        } else if (payload.platformId === 'xbox') {
          const activeStoreSync = options.storeSync || getStoreSync();
          const isTransientOfflineXboxError = (/** @type {any} */ err) => {
            if (!err) return false;
            const code = String(err.code || err.cause?.code || '').toUpperCase();
            if (
              [
                'ENOTFOUND',
                'ETIMEDOUT',
                'ECONNREFUSED',
                'EAI_AGAIN',
                'ENETUNREACH',
                'EHOSTUNREACH',
                'ECONNRESET',
                'UND_ERR_CONNECT_TIMEOUT',
              ].includes(code)
            ) {
              return true;
            }
            const msg = String(err.message || err || '').toLowerCase();
            return /(?:enotfound|etimedout|econnrefused|eai_again|enetunreach|ehostunreach|econnreset|fetch failed|network\s*(?:error|unreachable|offline)|offline|dns|socket hang up)/i.test(
              msg
            );
          };
          const resolveXboxAuthAndSession = async () => {
            const xboxAuthProvider =
              options.xboxAuthProvider ||
              (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
                ? activeStoreSync.getXboxAuthProvider({
                    userDataDir: resolveIsolatedHomedirAndUserData(options).userDataDir,
                  })
                : null);
            if (options.xboxSession) {
              return { xboxAuthProvider, xboxSession: options.xboxSession };
            }
            let xboxSession = null;
            let encounteredOfflineNetworkError = Boolean(options.offline === true);
            if (xboxAuthProvider && typeof xboxAuthProvider.getValidXboxSession === 'function') {
              try {
                xboxSession = await xboxAuthProvider.getValidXboxSession();
              } catch (/** @type {any} */ authErr) {
                if (isTransientOfflineXboxError(authErr)) {
                  encounteredOfflineNetworkError = true;
                }
                xboxSession = null;
              }
            }
            if (!xboxSession && xboxAuthProvider) {
              /** @type {any} */
              let authStatus = null;
              if (typeof xboxAuthProvider.getAuthStatus === 'function') {
                try {
                  authStatus = await Promise.resolve(xboxAuthProvider.getAuthStatus());
                } catch {
                  authStatus = null;
                }
              }
              const explicitlyLoggedOut = Boolean(
                authStatus &&
                  (authStatus.connected === false ||
                    authStatus.authenticated === false ||
                    authStatus.loggedOut === true)
              );
              if (
                !explicitlyLoggedOut &&
                (encounteredOfflineNetworkError || authStatus?.connected === true)
              ) {
                /** @type {any} */
                let cachedProfile = null;
                if (typeof xboxAuthProvider.getCachedProfile === 'function') {
                  try {
                    cachedProfile = await Promise.resolve(xboxAuthProvider.getCachedProfile());
                  } catch {
                    cachedProfile = null;
                  }
                } else if (
                  authStatus?.connected === true &&
                  typeof xboxAuthProvider.getUserProfile === 'function'
                ) {
                  try {
                    cachedProfile = await Promise.resolve(xboxAuthProvider.getUserProfile());
                  } catch {
                    cachedProfile = null;
                  }
                } else if (authStatus?.connected === true && authStatus?.xuid) {
                  cachedProfile = {
                    xuid: authStatus.xuid,
                    gamertag: authStatus.gamertag,
                    uhs: authStatus.uhs,
                  };
                }
                if (
                  cachedProfile &&
                  cachedProfile.xuid &&
                  cachedProfile.connected !== false &&
                  cachedProfile.loggedOut !== true
                ) {
                  xboxSession = {
                    ...cachedProfile,
                    xuid: String(cachedProfile.xuid),
                    gamertag: String(cachedProfile.gamertag || 'Xbox Player'),
                    uhs: String(cachedProfile.uhs || ''),
                    offline: true,
                  };
                }
              }
            }
            return { xboxAuthProvider, xboxSession };
          };
          const runXboxPreLaunchSync = async (/** @type {Record<string, any>} */ extraSyncOpts = {}) => {
            try {
              const xboxPreSyncRes = await syncXboxCloudSaves(
                {
                  ...payload,
                  packageFamilyName: resolvedXboxPfn,
                  scid: resolvedXboxScid,
                  fallbackScid: resolvedXboxFallbackScid || undefined,
                  msaAppId: resolvedXboxMsaAppId,
                  xboxTitleId: resolvedXboxTitleId,
                  xboxProductId: resolvedXboxProductId,
                  appUserModelId: resolvedXboxAumid,
                  installPath: localInstallDir || payload.installPath,
                },
                'pre_launch',
                {
                  ...options,
                  useCompatLayer,
                  winePrefix: targetWinePrefix,
                  installPath: localInstallDir || payload.installPath,
                  userDataDir: resolveIsolatedHomedirAndUserData(options).userDataDir,
                  ...extraSyncOpts,
                }
              );
              if (
                xboxPreSyncRes &&
                typeof xboxPreSyncRes.resolvedScid === 'string' &&
                xboxPreSyncRes.resolvedScid.trim()
              ) {
                resolvedXboxScid = xboxPreSyncRes.resolvedScid.trim().toLowerCase();
              }
              emitPreLaunchCloudTelemetry(xboxPreSyncRes);
              return xboxPreSyncRes;
            } catch (/** @type {any} */ xboxSyncErr) {
              const failTelemetry = {
                synced: false,
                provider: 'xbox_connected_storage',
                reason: xboxSyncErr && xboxSyncErr.message ? xboxSyncErr.message : 'sync_failed',
              };
              emitPreLaunchCloudTelemetry(failTelemetry);
              return failTelemetry;
            }
          };

          if (useCompatLayer) {
            const { xboxAuthProvider, xboxSession } = await resolveXboxAuthAndSession();

            // Provision bottle registry + Packages/<PFN>/SystemAppData/{wgs/t,xgs} FIRST so pre_launch
            // cloud save hydration always finds an initialized SystemAppData save tree on first launch.
            const xboxPrep = await prepareXboxBottleEnvironment({
              bottlePath: targetWinePrefix,
              compatLayer: chosenCompatLayer,
              installDir: localInstallDir || payload.installPath,
              executablePath: resolvedExePath,
              packageFamilyName: resolvedXboxPfn,
              xuid: xboxSession?.xuid,
              scid: resolvedXboxScid,
              env,
              advertiseAvx:
                launchConfig.advertiseAvx ??
                launchConfig.rosettaAdvertiseAvx ??
                env.ROSETTA_ADVERTISE_AVX,
              xboxBridgeDllPath: options.xboxBridgeDllPath,
              gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              xboxAppNotifyBridgeDllPath: options.xboxAppNotifyBridgeDllPath,
            });

            await runXboxPreLaunchSync({
              xboxAuthProvider,
              xboxSession,
            });

            const xboxMods = getXboxStorefrontModules();
            if (xboxMods?.xboxRuntimeLoopbackServer?.startXboxRuntimeLoopbackServer) {
              try {
                xboxLoopbackServer =
                  await xboxMods.xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
                    authProvider: xboxAuthProvider,
                    userProfile: xboxSession || undefined,
                    gameMetadata: {
                      titleId: resolvedXboxTitleId,
                      titleIdDecimal: xboxGameCfg?.titleIdDecimal || undefined,
                      scid: resolvedXboxScid,
                      fallbackScid: resolvedXboxFallbackScid || undefined,
                      msaAppId: resolvedXboxMsaAppId,
                      storeId: resolvedXboxProductId,
                      packageFamilyName: resolvedXboxPfn,
                      displayName: String(payload.title || xboxGameCfg?.displayName || gameId),
                      fullTrust: true,
                    },
                    saveRootDir: xboxPrep.systemAppDataDir || xboxPrep.wgsRootDir || undefined,
                    bottleUsersDir: xboxPrep.bottleUsersDir || undefined,
                    gameRootDir: localInstallDir || payload.installPath || undefined,
                    locale: payload.locale || options.locale || undefined,
                    storeProvider: options.xboxStoreProvider || undefined,
                    enableCloudSaveSync: true,
                    fetchImpl: options.fetchImpl,
                  });
                if (xboxLoopbackServer && xboxLoopbackServer.env) {
                  Object.assign(env, xboxLoopbackServer.env);
                }
                const resolvedXgrLocale = String(
                  xboxLoopbackServer?.env?.ONE_XGR_LOCALE || env.ONE_XGR_LOCALE || ''
                ).trim();
                if (resolvedXgrLocale && !env.WINEUSERLOCALE) {
                  env.WINEUSERLOCALE = resolvedXgrLocale;
                }
              } catch (loopbackErr) {
                diagLog.warn('launchGame.xboxLoopbackServerFailed', loopbackErr, { gameId });
              }
            }
            if (resolvedXboxPfn) {
              env.ONE_XGR_PFN = resolvedXboxPfn;
              env.ONE_LAUNCHER_XBOX_PFN = resolvedXboxPfn;
            }
            if (resolvedXboxScid) {
              env.ONE_XGR_SCID = resolvedXboxScid;
              env.ONE_LAUNCHER_XBOX_SCID = resolvedXboxScid;
            }
            if (resolvedXboxProductId) env.ONE_XGR_STORE_ID = resolvedXboxProductId;
            if (resolvedXboxTitleId) env.ONE_XGR_TITLE_ID = resolvedXboxTitleId;
            if (resolvedXboxMsaAppId) env.ONE_XGR_MSA_APP_ID = resolvedXboxMsaAppId;
          } else if (platform === 'win32') {
            const installRootForWin = localInstallDir || payload.installPath || '';
            const hasClientlessReceipt = hasXboxClientlessReceipt(installRootForWin);
            const isClientlessWinXbox = Boolean(
              hasClientlessReceipt ||
                payload.isClientlessXboxInstall === true ||
                payload.runner === 'xbox_direct' ||
                payload.installerId === 'xbox-msixvc-win'
            );

            if (!isClientlessWinXbox) {
              isXboxAppxRegisteredOnWin32 = true;
            } else if (options.forceClientlessXboxOnWin32 !== true) {
              const appxRegCheck = await ensureWindowsXboxAppxRegisteredAsync(
                {
                  installDir: installRootForWin,
                  identityName:
                    xboxGameCfg?.identityName ||
                    xboxAppxCfg?.identityName ||
                    payload.identityName ||
                    '',
                  packageFamilyName: resolvedXboxPfn,
                },
                options
              );
              if (appxRegCheck.gamingServicesInstalled && appxRegCheck.registered) {
                isXboxAppxRegisteredOnWin32 = true;
                if (hasClientlessReceipt && installRootForWin) {
                  await restoreWindowsClientlessXboxBridgeDlls(installRootForWin).catch(() => null);
                }
              }
            }

            if (!isXboxAppxRegisteredOnWin32) {
              const { xboxAuthProvider, xboxSession } = await resolveXboxAuthAndSession();

              const stagedWinBridge = await stageWindowsClientlessXboxBridgeDlls({
                installDir: installRootForWin,
                executablePath: resolvedExePath,
                xboxBridgeDllPath: options.xboxBridgeDllPath,
                gameInputBridgeDllPath: options.gameInputBridgeDllPath,
                strictBridgeSha256: options.strictBridgeSha256,
              });

              let winSystemAppDataDir = '';
              try {
                const knownFolders = resolveHostWindowsKnownFolders(options) || {};
                const rawHostLocalAppData =
                  knownFolders.localAppData ||
                  knownFolders.appDataLocal ||
                  options.localAppData ||
                  (options.homedir
                    ? path.join(options.homedir, 'AppData', 'Local')
                    : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
                const hostLocalAppData = toHostFilesystemPath(rawHostLocalAppData);
                if (
                  hostLocalAppData &&
                  resolvedXboxPfn &&
                  !/[\\/:*?"<>|]/.test(resolvedXboxPfn) &&
                  !resolvedXboxPfn.includes('..')
                ) {
                  const pkgRoot = path.join(hostLocalAppData, 'Packages', resolvedXboxPfn);
                  winSystemAppDataDir = path.join(pkgRoot, 'SystemAppData');
                  await Promise.all([
                    fs.promises.mkdir(path.join(winSystemAppDataDir, 'wgs', 't'), {
                      recursive: true,
                    }),
                    fs.promises.mkdir(path.join(winSystemAppDataDir, 'xgs'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'LocalState'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'TempState'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'AC'), { recursive: true }),
                    fs.promises.mkdir(path.join(pkgRoot, 'Settings'), { recursive: true }),
                  ]);
                }
              } catch {}

              await runXboxPreLaunchSync({
                xboxAuthProvider,
                xboxSession,
                isClientlessXboxGdk: true,
                isAppxRegistered: false,
                useGamingServicesRuntime: false,
              });

              const xboxMods = getXboxStorefrontModules();
              if (xboxMods?.xboxRuntimeLoopbackServer?.startXboxRuntimeLoopbackServer) {
                try {
                  xboxLoopbackServer =
                    await xboxMods.xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
                      authProvider: xboxAuthProvider,
                      userProfile: xboxSession || undefined,
                      gameMetadata: {
                        titleId: resolvedXboxTitleId,
                        titleIdDecimal: xboxGameCfg?.titleIdDecimal || undefined,
                        scid: resolvedXboxScid,
                        fallbackScid: resolvedXboxFallbackScid || undefined,
                        msaAppId: resolvedXboxMsaAppId,
                        storeId: resolvedXboxProductId,
                        packageFamilyName: resolvedXboxPfn,
                        displayName: String(payload.title || xboxGameCfg?.displayName || gameId),
                        fullTrust: true,
                      },
                      saveRootDir: winSystemAppDataDir || undefined,
                      gameRootDir: localInstallDir || payload.installPath || undefined,
                      locale: payload.locale || options.locale || undefined,
                      storeProvider: options.xboxStoreProvider || undefined,
                      enableCloudSaveSync: true,
                      fetchImpl: options.fetchImpl,
                    });
                  if (xboxLoopbackServer && xboxLoopbackServer.env) {
                    Object.assign(env, xboxLoopbackServer.env);
                  }
                } catch (loopbackErr) {
                  diagLog.warn('launchGame.winXboxLoopbackServerFailed', loopbackErr, { gameId });
                }
              }

              if (resolvedXboxPfn) {
                env.ONE_XGR_PFN = resolvedXboxPfn;
                env.ONE_LAUNCHER_XBOX_PFN = resolvedXboxPfn;
              }
              if (resolvedXboxScid) {
                env.ONE_XGR_SCID = resolvedXboxScid;
                env.ONE_LAUNCHER_XBOX_SCID = resolvedXboxScid;
              }
              if (resolvedXboxProductId) env.ONE_XGR_STORE_ID = resolvedXboxProductId;
              if (resolvedXboxTitleId) env.ONE_XGR_TITLE_ID = resolvedXboxTitleId;
              if (resolvedXboxMsaAppId) env.ONE_XGR_MSA_APP_ID = resolvedXboxMsaAppId;

              /** @type {any} */
              const winBridgeInfo = stagedWinBridge;
              if (
                options.disableXboxWinLauncher !== true &&
                winBridgeInfo?.requiresXgrInjection !== false
              ) {
                const resolvedWinLauncher =
                  winBridgeInfo?.winLauncherExePath ||
                  resolveBundledXboxWinLauncherExePath(options);
                const candidatePrimaryXgr =
                  winBridgeInfo?.primaryXgameruntimeDllPath ||
                  (resolvedExePath && resolvedExePath !== 'explorer.exe'
                    ? path.join(path.dirname(resolvedExePath), 'xgameruntime.dll')
                    : '');
                if (
                  resolvedWinLauncher &&
                  candidatePrimaryXgr &&
                  fs.existsSync(candidatePrimaryXgr)
                ) {
                  winClientlessLauncherExe = resolvedWinLauncher;
                  winClientlessPrimaryXgrDll = candidatePrimaryXgr;
                }
              }
            } else {
              await runXboxPreLaunchSync({
                isAppxRegistered: true,
                useGamingServicesRuntime: true,
              });

              wasXboxAppRunningAtStart = await isWindowsXboxAppRunning(options);
              const canUseAumidActivation =
                Boolean(resolvedXboxAumid) &&
                !launchConfig.customExecutablePath &&
                options.disableXboxAumidActivation !== true &&
                (!isTestEnvironment(options) ||
                  typeof options.activateXboxApplicationFn === 'function' ||
                  options.enableXboxAumidActivationInTest === true);

              if (canUseAumidActivation) {
                const actRes = await activateWindowsXboxApplication(
                  resolvedXboxAumid,
                  effectiveLaunchArgsStr,
                  options
                );
                if (actRes && actRes.activated && actRes.pid > 0) {
                  activatedXboxPid = actRes.pid;
                  launchedViaXboxActivationLatch = true;
                  actualLaunchMethod = 'xbox_aumid_com';
                } else if (resolvedExePath === 'explorer.exe' && resolvedXboxAumid) {
                  args.length = 0;
                  args.push(`shell:AppsFolder\\${resolvedXboxAumid}`);
                  launchedViaXboxActivationLatch = true;
                  actualLaunchMethod = 'xbox_apps_folder';
                } else if (
                  localInstallDir &&
                  xboxGameCfg?.gameLaunchHelperExecutable &&
                  fs.existsSync(
                    path.join(
                      xboxGameCfg.contentRootDir || localInstallDir,
                      xboxGameCfg.gameLaunchHelperExecutable
                    )
                  )
                ) {
                  spawnCmd = path.join(
                    xboxGameCfg.contentRootDir || localInstallDir,
                    xboxGameCfg.gameLaunchHelperExecutable
                  );
                  launchedViaXboxActivationLatch = true;
                }
              } else if (resolvedExePath === 'explorer.exe' && resolvedXboxAumid) {
                args.length = 0;
                args.push(`shell:AppsFolder\\${resolvedXboxAumid}`);
                launchedViaXboxActivationLatch = true;
                actualLaunchMethod = 'xbox_apps_folder';
              }
            }
          } else {
            await runXboxPreLaunchSync();
          }
        }

        // Finalize spawn command & arguments (incorporating any Epic auth flags added to `args`)
        if (useCompatLayer && chosenCompatLayer) {
          let wantDisplayLauncherWrap = false;
          if (platform === 'darwin' || (!options.platform && process.platform === 'darwin')) {
            if (
              effectivePerfPolicy.suppressWineDebugLogging !== false &&
              !launchConfig.wineDebug &&
              !launchConfig.environmentVariables?.WINEDEBUG &&
              (!env.WINEDEBUG || env.WINEDEBUG === '-all')
            ) {
              env.WINEDEBUG = '-all,err+system';
              if (
                env.CX_DEBUGMSG === '-all' &&
                !launchConfig.environmentVariables?.CX_DEBUGMSG
              ) {
                env.CX_DEBUGMSG = '-all,err+system';
              }
            }
            // Interface Contract 1: Pure Edge-to-Edge Symmetric Panel Span (ONE_LAUNCHER_SAFE_INSET_TOP: '0')
            const safeInsetTop =
              effectiveDisplayScalingMode !== 'off' && effectiveDisplayScalingMode !== 'windowed'
                ? 0
                : (typeof options?.safeInsetTop === 'number' && Number.isFinite(options.safeInsetTop)
                    ? Math.max(0, Math.min(80, Math.round(options.safeInsetTop)))
                    : 0);
            env.ONE_LAUNCHER_DISPLAY_SCALING_MODE = effectiveDisplayScalingMode;
            env.ONE_LAUNCHER_DISPLAY_ASPECT = effectiveDisplayAspectRatio;
            env.ONE_LAUNCHER_SAFE_INSET_TOP = String(safeInsetTop);
            env.ONE_LAUNCHER_FULLSCREEN_HOTKEY = enableFullscreenHotkey ? '1' : '0';

            if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
              bottleDisplayStagedInfo = stageBottleDisplayScalerBinaries(targetWinePrefix, options);
              if (bottleDisplayStagedInfo.stageDirPosix) {
                bottleDisplayControlFilePosix = path.join(
                  bottleDisplayStagedInfo.stageDirPosix,
                  `display_ctl_${preGeneratedSessionId}.ini`
                );
                bottleDisplayStatusFilePosix = path.join(
                  bottleDisplayStagedInfo.stageDirPosix,
                  `display_status_${preGeneratedSessionId}.json`
                );
                try {
                  atomicWriteFileSync(
                    bottleDisplayControlFilePosix,
                    formatDisplayScalerControlIni(
                      1,
                      initialBottleFullscreen,
                      effectiveDisplayAspectRatio,
                      safeInsetTop
                    )
                  );
                } catch {}
                env.ONE_LAUNCHER_SCALER_DLL_X86 = bottleDisplayStagedInfo.winDllX86;
                env.ONE_LAUNCHER_SCALER_DLL_X64 = bottleDisplayStagedInfo.winDllX64;
                env.ONE_LAUNCHER_LAUNCHER_EXE_X86 = bottleDisplayStagedInfo.winLauncherX86;
                env.ONE_LAUNCHER_LAUNCHER_EXE_X64 = bottleDisplayStagedInfo.winLauncherX64;
                env.ONE_LAUNCHER_DISPLAY_CONTROL_FILE = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${preGeneratedSessionId}.ini`;
                env.ONE_LAUNCHER_DISPLAY_STATUS_FILE = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${preGeneratedSessionId}.json`;
              }
            }

            const canInjectDisplayScaler =
              (!isTestEnvironment(options) || options.enableDisplayScalerInTests === true) &&
              Boolean(bottleDisplayStagedInfo && bottleDisplayStagedInfo.allPresent);
            wantDisplayLauncherWrap =
              canInjectDisplayScaler &&
              shouldWrapBottleSessionWithDisplayLauncher(
                effectiveCaps,
                effectiveDisplayScalingMode
              );
          }

          if (shouldLaunchViaBottleSteam && bottleSteamExe) {
            const execFileImpl =
              typeof options.execFileImpl === 'function'
                ? options.execFileImpl
                : typeof options.execFileFn === 'function'
                  ? options.execFileFn
                  : execFile;
            const normTargetPrefix = targetWinePrefix
              ? path.resolve(targetWinePrefix).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
              : '';
            const normRealTargetPrefix = targetWinePrefix
              ? normalizeBottlePrefixContractKey(targetWinePrefix)
              : '';
            let observedSteamBackend = '';
            const checkBottleSteamRunning = (/** @type {any} */ outStr) => {
              observedSteamBackend = '';
              const lines = String(outStr || '').split(/\r?\n/);
              for (const line of lines) {
                if (!/(?:^|[\\/\s"'])steam\.exe(?:\s|["']|$)/i.test(line)) continue;
                if (normTargetPrefix) {
                  const lowerLine = line.replace(/\\/g, '/').toLowerCase();
                  const envMatch = lowerLine.match(/wineprefix=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
                  if (envMatch) {
                    const linePrefix = (envMatch[1] || envMatch[2] || envMatch[3] || '').replace(
                      /\/+$/,
                      ''
                    );
                    if (
                      linePrefix &&
                      linePrefix !== normTargetPrefix &&
                      (!normRealTargetPrefix || linePrefix !== normRealTargetPrefix)
                    ) {
                      continue;
                    }
                  }
                  const bottleMatch = lowerLine.match(
                    /((?:[a-z]:)?\/[^\s"']*\/bottles\/[^/\s"']+)/i
                  );
                  if (bottleMatch && bottleMatch[1]) {
                    const lineBottle = bottleMatch[1].replace(/\/+$/, '');
                    const matchesRaw =
                      normTargetPrefix.startsWith(lineBottle) ||
                      lineBottle.startsWith(normTargetPrefix);
                    const matchesReal = Boolean(
                      normRealTargetPrefix &&
                        (normRealTargetPrefix.startsWith(lineBottle) ||
                          lineBottle.startsWith(normRealTargetPrefix))
                    );
                    if (!matchesRaw && !matchesReal) {
                      continue;
                    }
                  }
                }
                const backendMatch = line.match(
                  /\bCX_GRAPHICS_BACKEND=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i
                );
                if (backendMatch) {
                  observedSteamBackend = String(
                    backendMatch[1] || backendMatch[2] || backendMatch[3] || ''
                  )
                    .trim()
                    .toLowerCase();
                }
                return true;
              }
              return false;
            };

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
                const psArgs =
                  platform === 'darwin' && execFileImpl === execFile
                    ? ['eww', '-ax', '-o', 'command=']
                    : ['-ax', '-o', 'command='];
                wasBottleSteamRunning = await new Promise((resolve) => {
                  execFileImpl('ps', psArgs, { timeout: 1500 }, (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    resolve(!err && checkBottleSteamRunning(stdout));
                  });
                });
              } catch {
                wasBottleSteamRunning = false;
              }
            }

            const prefixContractKey = normalizeBottlePrefixContractKey(targetWinePrefix);
            const targetGraphicsContract = computeBottleGraphicsEnvContract(env);
            const desiredBackendLower = String(env.CX_GRAPHICS_BACKEND || 'auto')
              .trim()
              .toLowerCase();

            if (
              wasBottleSteamRunning &&
              !hasOtherActiveBottleSession &&
              targetWinePrefix &&
              options.enableWarmDaemonEnvRecycle !== false
            ) {
              const recordedContract = prefixContractKey
                ? liveBottleDaemonEnvContractByPrefix.get(prefixContractKey)
                : undefined;
              const hasRecordedContractMismatch =
                typeof recordedContract === 'string' && recordedContract !== targetGraphicsContract;
              const hasUnrecordedIncompatibleBackend =
                recordedContract === undefined &&
                ((Boolean(observedSteamBackend) && observedSteamBackend !== desiredBackendLower) ||
                  (Boolean(env.CX_GRAPHICS_BACKEND) &&
                    desiredBackendLower !== 'auto' &&
                    (!isTestEnvironment(options) || options.enableWarmDaemonEnvRecycle === true)));

              if (hasRecordedContractMismatch || hasUnrecordedIncompatibleBackend) {
                diagLog.info('launchGame.recycledWarmBottleSteamForGraphicsContract', {
                  gameId,
                  bottlePath: targetWinePrefix,
                  previousContract: recordedContract || null,
                  observedSteamBackend: observedSteamBackend || null,
                  targetContract: targetGraphicsContract,
                });
                try {
                  const shutdownSteamEnv = {
                    ...env,
                    WINEPREFIX: targetWinePrefix,
                  };
                  const alignedSteamShutdown = prepareAlignedAuxBottleWineCommand({
                    wineBinary: chosenCompatLayer.binaryPath,
                    bottlePath: targetWinePrefix,
                    env: shutdownSteamEnv,
                    suppressGuiDialogs: true,
                    layerType: chosenCompatLayer.type,
                  });
                  const steamExeForShutdown = bottleSteamExe;
                  await new Promise((resolve) => {
                    try {
                      execFileImpl(
                        alignedSteamShutdown.binaryPath,
                        [steamExeForShutdown, '-shutdown'],
                        {
                          cwd: path.dirname(steamExeForShutdown),
                          env: alignedSteamShutdown.env,
                          timeout: 4000,
                        },
                        () => resolve(undefined)
                      );
                    } catch {
                      resolve(undefined);
                    }
                  });
                } catch {}
                deleteBottleDaemonEnvContract(targetWinePrefix);
                await shutdownWinePrefix(chosenCompatLayer.binaryPath, targetWinePrefix, 3000, {
                  bottleName: String(env.CX_BOTTLE || ''),
                  execFileFn: execFileImpl,
                });
                if (fs.existsSync(targetWinePrefix)) {
                  try {
                    applyCrossOverPerGameSettings(
                      targetWinePrefix,
                      outerCompatLayerCapOptions.exeName || '',
                      outerEffectiveCompatLaunchConfig,
                      {
                        ...outerCompatLayerCapOptions,
                        skipRegistrySpawn: true,
                        skipLiveWineRegSync: true,
                      }
                    );
                  } catch {}
                }
                alignWineMsyncWithLiveBottle(targetWinePrefix, env);
                wasBottleSteamRunning = false;
              }
            } else if (!wasBottleSteamRunning) {
              await recycleIdleBottleWineserverBeforeClientWake();
            }

            if (!wasBottleSteamRunning && prefixContractKey) {
              setBoundedMapEntry(
                liveBottleDaemonEnvContractByPrefix,
                prefixContractKey,
                targetGraphicsContract,
                128
              );
            }

            spawnCmd = chosenCompatLayer.binaryPath;
            const trimmedSteamDll =
              typeof env.WINEDLLOVERRIDES === 'string' ? env.WINEDLLOVERRIDES.trim() : '';
            const steamDllArgs =
              trimmedSteamDll &&
              (doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath) ||
                options.forceCrossOverDllFlag === true)
                ? ['--dll', trimmedSteamDll]
                : [];
            spawnArgs = [
              ...steamDllArgs,
              bottleSteamExe,
              ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                ? []
                : ['-silent']),
              '-applaunch',
              String(effectiveSteamAppId),
              ...args,
            ];
            bottleSteamDisplayDllArgs = steamDllArgs;
            bottleShouldWatchSteamGameDir = Boolean(
              wantDisplayLauncherWrap && localInstallDir && targetWinePrefix
            );
            actualLaunchMethod = `compatibility_layer:${chosenCompatLayer.type}`;
          } else {
            spawnCmd = chosenCompatLayer.binaryPath;
            let resolvedParadoxDirectExe = '';
            if (resolvedExePath && /^dowser\.exe$/i.test(path.basename(resolvedExePath))) {
              const pdxResolved =
                effectiveCaps?.paradoxDirectGameExe ||
                resolveParadoxLauncherSettings(
                  resolvedExePath,
                  localInstallDir || path.dirname(resolvedExePath)
                ).paradoxDirectGameExe ||
                '';
              if (pdxResolved && fs.existsSync(pdxResolved)) {
                resolvedParadoxDirectExe = pdxResolved;
                if (!hasParadoxLauncherInstalledInBottle(targetWinePrefix)) {
                  resolvedExePath = pdxResolved;
                  const pdxExtraArgs = Array.isArray(effectiveCaps?.paradoxLauncherSettings?.exeArgs)
                    ? effectiveCaps.paradoxLauncherSettings.exeArgs
                    : [];
                  for (const extraArg of pdxExtraArgs) {
                    if (extraArg && !args.includes(extraArg)) {
                      args.push(extraArg);
                    }
                  }
                }
              }
            }
            const proxyCandidateDirs = [
              resolvedExePath ? path.dirname(resolvedExePath) : '',
              localInstallDir || '',
              ...(resolvedParadoxDirectExe ? [path.dirname(resolvedParadoxDirectExe)] : []),
              ...(effectiveCaps?.targetExePaths || []).map((p) => path.dirname(p)),
            ].filter(Boolean);
            const appLocalProxyInfo = discoverValidatedAppLocalProxyDllOverrides(
              proxyCandidateDirs,
              effectiveCaps?.effectiveMachine || 'unknown',
              options
            );
            if (appLocalProxyInfo.hasOverrides) {
              env.WINEDLLOVERRIDES = mergeWineDllOverrides(
                env.WINEDLLOVERRIDES,
                appLocalProxyInfo.envOverrideSpec
              );
              if (targetWinePrefix && fs.existsSync(targetWinePrefix)) {
                try {
                  const userRegPath = path.join(targetWinePrefix, 'user.reg');
                  const skipLiveSync = Boolean(
                    options.homedir || options.skipRegistrySpawn || options.skipLiveWineRegSync
                  );
                  const dllEntries = Object.entries(appLocalProxyInfo.appDefaultsMap).map(
                    ([k, v]) => /** @type {[string, any]} */ ([k, { type: 'sz', value: v }])
                  );
                  const targetBases = effectiveCaps?.targetExeBasenamesLower?.length
                    ? effectiveCaps.targetExeBasenamesLower
                    : resolvedExePath
                      ? [path.basename(resolvedExePath).toLowerCase()]
                      : [];
                  for (const tExe of targetBases) {
                    if (!tExe.endsWith('.exe')) continue;
                    upsertWineUserRegKey(
                      targetWinePrefix,
                      `Software\\Wine\\AppDefaults\\${tExe}\\DllOverrides`,
                      dllEntries,
                      {
                        ...options,
                        regFilePath: userRegPath,
                        skipLiveWineRegSync: skipLiveSync,
                      }
                    );
                  }
                } catch {}
              }
            }

            const isCrossOverWineWrapper =
              chosenCompatLayer.type === 'crossover' ||
              chosenCompatLayer.type === 'crossover_preview' ||
              /CrossOver[^/\\]*\.app\/Contents\/SharedSupport\/CrossOver\/bin\/wine$/i.test(
                String(chosenCompatLayer.binaryPath || '')
              );
            const realCrossOverPerlWrapper = isCrossOverWineWrapper
              ? doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
              : false;
            const shouldPassWaitChildren =
              isCrossOverWineWrapper &&
              options.enableCrossOverWaitChildren !== false &&
              (options.enableCrossOverWaitChildren === true ||
                realCrossOverPerlWrapper ||
                Boolean(
                  effectiveCaps?.hasChildGameExecutable &&
                    (typeof options.gameSpawnFn === 'function' ||
                      typeof options.spawnFn === 'function')
                ));
            const waitChildrenArgs = shouldPassWaitChildren ? ['--wait-children'] : [];

            const trimmedDllOverrides =
              typeof env.WINEDLLOVERRIDES === 'string' ? env.WINEDLLOVERRIDES.trim() : '';
            const dllOverrideArgs =
              isCrossOverWineWrapper &&
              trimmedDllOverrides &&
              (payload.platformId === 'xbox' ||
                appLocalProxyInfo.hasOverrides ||
                Boolean(launchConfig.environmentVariables?.WINEDLLOVERRIDES) ||
                options.forceCrossOverDllFlag === true ||
                realCrossOverPerlWrapper)
                ? ['--dll', trimmedDllOverrides]
                : [];
            const effectiveWinePrefix =
              targetWinePrefix ||
              (resolvedExePath ? extractBottleRootFromPath(resolvedExePath) : '') ||
              '';
            const winTargetExePath = resolvedExePath
              ? toWineWindowsPath(resolvedExePath, effectiveWinePrefix)
              : '';
            const normalizedWineArgs = args.map((a) =>
              normalizeWineArgumentBackslashes(a, effectiveWinePrefix)
            );
            if (wantDisplayLauncherWrap && bottleDisplayStagedInfo && resolvedExePath) {
              const chosenDisplayLauncherPosix = effectiveCaps?.is32Bit
                ? bottleDisplayStagedInfo.launcherX86Posix
                : bottleDisplayStagedInfo.launcherX64Posix;
              spawnArgs = [
                ...waitChildrenArgs,
                ...dllOverrideArgs,
                chosenDisplayLauncherPosix,
                '--dll-x86',
                bottleDisplayStagedInfo.winDllX86,
                '--dll-x64',
                bottleDisplayStagedInfo.winDllX64,
                '--',
                winTargetExePath || resolvedExePath,
                ...normalizedWineArgs,
              ];
              bottleDisplayScalerWrapped = true;
            } else {
              spawnArgs = [
                ...waitChildrenArgs,
                ...dllOverrideArgs,
                resolvedExePath,
                ...args,
              ];
            }
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
              spawnArgs = [
                '-W',
                '-a',
                resolvedExePath,
                ...(args.length > 0 ? ['--args', ...args] : []),
              ];
            }
          } else {
            spawnArgs = [...args];
          }
        } else if (
          platform === 'win32' &&
          payload.platformId === 'xbox' &&
          !isXboxAppxRegisteredOnWin32 &&
          winClientlessLauncherExe &&
          winClientlessPrimaryXgrDll &&
          resolvedExePath !== 'explorer.exe'
        ) {
          spawnCmd = winClientlessLauncherExe;
          spawnArgs = ['--dll', winClientlessPrimaryXgrDll, '--', resolvedExePath, ...args];
          actualLaunchMethod = 'xbox_win_clientless_injector';
        } else {
          spawnArgs = [...args];
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
                  await clearMacQuarantineAsync(localInstallDir, options);
                }
                if (targetQuarantinePath && targetQuarantinePath !== localInstallDir) {
                  await clearMacQuarantineAsync(targetQuarantinePath, options);
                }
              } catch {}
            }
          } else if (
            platform === 'darwin' &&
            !useCompatLayer &&
            !options.homedir &&
            spawnCmd === '/usr/bin/open'
          ) {
            try {
              const appMatch = String(resolvedExePath).match(/^(.*?\.app)(?:\/|$)/i);
              const targetQuarantinePath = appMatch ? appMatch[1] : resolvedExePath;
              if (localInstallDir && fs.existsSync(localInstallDir)) {
                await clearMacQuarantineAsync(localInstallDir, options);
              }
              if (targetQuarantinePath && targetQuarantinePath !== localInstallDir) {
                await clearMacQuarantineAsync(targetQuarantinePath, options);
              }
            } catch {}
          }

          if (platform === 'darwin' && !useCompatLayer) {
            try {
              await ensureMacAppCodeSignatureValidAsync(resolvedExePath || localInstallDir, options);
            } catch {}
          }

          let xboxDefaultCwd = '';
          if (
            payload.platformId === 'xbox' &&
            !launchConfig.customExecutablePath &&
            !launchConfig.workingDirectory &&
            xboxGameCfg?.contentRootDir
          ) {
            const candidateXboxCwd = xboxGameCfg.overrideWorkingDirectory
              ? path.resolve(xboxGameCfg.contentRootDir, xboxGameCfg.overrideWorkingDirectory)
              : xboxGameCfg.contentRootDir;
            if (fs.existsSync(candidateXboxCwd)) {
              xboxDefaultCwd = candidateXboxCwd;
            } else if (fs.existsSync(xboxGameCfg.contentRootDir)) {
              xboxDefaultCwd = xboxGameCfg.contentRootDir;
            }
          }
          const cwd =
            launchConfig.workingDirectory && fs.existsSync(launchConfig.workingDirectory)
              ? launchConfig.workingDirectory
              : shouldLaunchViaBottleSteam && bottleSteamExe
                ? path.dirname(bottleSteamExe)
                : xboxDefaultCwd || path.dirname(resolvedExePath);
          const effectiveCwd = fs.existsSync(cwd)
            ? cwd
            : resolveIsolatedHomedirAndUserData(options).homedir;

          const gameSpawnImpl =
            typeof options.gameSpawnFn === 'function'
              ? options.gameSpawnFn
              : typeof options.spawnFn === 'function' &&
                  options.useSpawnFnForGame !== false &&
                  payload.platformId !== 'gog'
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

              const stage1Env = { ...env };
              if (
                effectivePerfPolicy.storefrontClientLifecycle === 'default_client' &&
                (launchConfig?.crossoverGraphicsBackend === undefined ||
                  launchConfig?.crossoverGraphicsBackend === 'auto') &&
                !launchConfig?.environmentVariables?.CX_GRAPHICS_BACKEND &&
                !effectiveCaps?.is32Bit
              ) {
                delete stage1Env.CX_GRAPHICS_BACKEND;
                delete stage1Env.WINED3DMETAL;
                if (typeof stage1Env.CX_ENV === 'string' && stage1Env.CX_ENV) {
                  const cleanedStage1Cx = stripKeysFromCxEnv(stage1Env.CX_ENV, [
                    'CX_GRAPHICS_BACKEND',
                    'WINED3DMETAL',
                  ]);
                  if (cleanedStage1Cx) {
                    stage1Env.CX_ENV = cleanedStage1Cx;
                  } else {
                    delete stage1Env.CX_ENV;
                  }
                }
                const stage1PrefixKey = normalizeBottlePrefixContractKey(targetWinePrefix);
                if (stage1PrefixKey) {
                  setBoundedMapEntry(
                    liveBottleDaemonEnvContractByPrefix,
                    stage1PrefixKey,
                    computeBottleGraphicsEnvContract(stage1Env),
                    128
                  );
                }
              }
              const alignedStage1 = prepareAlignedAuxBottleWineCommand({
                wineBinary: chosenCompatLayer.binaryPath,
                bottlePath: targetWinePrefix,
                env: stage1Env,
                suppressGuiDialogs: false,
                layerType: chosenCompatLayer.type,
              });
              const stage1Dll =
                typeof alignedStage1.env.WINEDLLOVERRIDES === 'string'
                  ? alignedStage1.env.WINEDLLOVERRIDES.trim()
                  : '';
              const stage1DllArgs =
                stage1Dll && doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
                  ? ['--dll', stage1Dll]
                  : [];
              const stage1BottleSteam = gameSpawnImpl(
                alignedStage1.binaryPath,
                [
                  ...stage1DllArgs,
                  bottleSteamExe,
                  ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                    ? []
                    : ['-silent']),
                ],
                {
                  cwd: fs.existsSync(bottleSteamRoot) ? bottleSteamRoot : effectiveCwd,
                  env: alignedStage1.env,
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
                isBottleSteam: true,
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
            const bottleClientSpawnImpl =
              typeof options.bottleClientSpawnFn === 'function'
                ? options.bottleClientSpawnFn
                : typeof options.gameSpawnFn === 'function'
                  ? options.gameSpawnFn
                  : typeof options.spawnFn === 'function'
                    ? options.spawnFn
                    : spawn;

            if (shouldWakeBottleGog && bottleGogExe) {
              await reapOrphanedGogOverlayProcesses(options);
              wasBottleGogRunning = await isBottleWinExeRunning(
                'GalaxyClient.exe',
                targetWinePrefix,
                options
              );
              if (!wasBottleGogRunning) {
                try {
                  await recycleIdleBottleWineserverBeforeClientWake();
                  if (!isTestEnvironment(options)) {
                    const portBusy = await probeLocalTcpPort(9977, '127.0.0.1', 300, options);
                    if (portBusy && !(await isHostGogGalaxyRunning(options))) {
                      await new Promise((r) => {
                        execFile(
                          '/usr/bin/pkill',
                          ['-TERM', '-f', 'GalaxyCommunication'],
                          () => r(undefined)
                        );
                      });
                      await new Promise((r) => setTimeout(r, 400));
                    }
                  }

                  const gogCommLog = resolveGogCommunicationLogPath({
                    platform: 'win32',
                    bottlePath: targetWinePrefix,
                    options,
                  });
                  let preBootGogLogOffset = 0;
                  try {
                    if (gogCommLog && fs.existsSync(gogCommLog)) {
                      preBootGogLogOffset = fs.statSync(gogCommLog).size;
                    }
                  } catch {}

                  emitSessionUpdated(
                    {
                      gameId,
                      platformId: payload.platformId || 'gog',
                      status: 'starting',
                      event: 'starting',
                      statusMessage: 'Starting Bottle GOG Galaxy SDK service...',
                    },
                    options
                  );

                  const bottleGogRoot = path.dirname(bottleGogExe);
                  const bgGogEnv = { ...env };
                  sanitizeBottleBackgroundClientWakeEnv(bgGogEnv, launchConfig);
                  const alignedBgGog = prepareAlignedAuxBottleWineCommand({
                    wineBinary: chosenCompatLayer.binaryPath,
                    bottlePath: targetWinePrefix,
                    env: bgGogEnv,
                    suppressGuiDialogs: false,
                    layerType: chosenCompatLayer.type,
                  });
                  const bgGogDll =
                    typeof alignedBgGog.env.WINEDLLOVERRIDES === 'string'
                      ? alignedBgGog.env.WINEDLLOVERRIDES.trim()
                      : '';
                  const bgGogDllArgs =
                    bgGogDll && doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
                      ? ['--dll', bgGogDll]
                      : [];
                  const bottleGogArgs = [
                    ...bgGogDllArgs,
                    bottleGogExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['/launchViaAutoStart', '/runWithoutUpdating']),
                  ];
                  const bgBottleGog = bottleClientSpawnImpl(
                    alignedBgGog.binaryPath,
                    bottleGogArgs,
                    {
                      cwd: fs.existsSync(bottleGogRoot) ? bottleGogRoot : effectiveCwd,
                      env: alignedBgGog.env,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (bgBottleGog && typeof bgBottleGog.unref === 'function') {
                    bgBottleGog.unref();
                  }
                  wokeBottleGogByLauncher = true;

                  await waitForGogCommunicationServiceReady({
                    platform: 'win32',
                    bottlePath: targetWinePrefix,
                    preBootLogOffset: preBootGogLogOffset,
                    timeoutMs: 45000,
                    options,
                  });
                } catch (bgGogErr) {
                  diagLog.warn('launchGame.bottleGogWake', bgGogErr, { gameId });
                }
              } else {
                await waitForGogCommunicationServiceReady({
                  platform: 'win32',
                  bottlePath: targetWinePrefix,
                  alreadyRunning: true,
                  timeoutMs: 8000,
                  options,
                });
              }
            }

            if (shouldWakeBottleEpic && bottleEpicExe) {
              wasBottleEpicRunning = await isBottleWinExeRunning(
                'EpicGamesLauncher.exe',
                targetWinePrefix,
                options
              );
              if (!wasBottleEpicRunning) {
                try {
                  if (!wokeBottleGogByLauncher) {
                    await recycleIdleBottleWineserverBeforeClientWake();
                  }
                  let preBootEpicLogOffset = 0;
                  if (targetWinePrefix) {
                    const candidateEpicLog = path.join(
                      targetWinePrefix,
                      'drive_c',
                      'users',
                      'crossover',
                      'AppData',
                      'Local',
                      'EpicGamesLauncher',
                      'Saved',
                      'Logs',
                      'EpicGamesLauncher.log'
                    );
                    try {
                      if (fs.existsSync(candidateEpicLog)) {
                        preBootEpicLogOffset = fs.statSync(candidateEpicLog).size;
                      }
                    } catch {}
                  }

                  emitSessionUpdated(
                    {
                      gameId,
                      platformId: payload.platformId || 'epic',
                      status: 'starting',
                      event: 'starting',
                      statusMessage: 'Starting Bottle Epic Games Launcher...',
                    },
                    options
                  );

                  const bottleEpicRoot = path.dirname(bottleEpicExe);
                  const bgEpicEnv = { ...env };
                  sanitizeBottleBackgroundClientWakeEnv(bgEpicEnv, launchConfig);
                  const alignedBgEpic = prepareAlignedAuxBottleWineCommand({
                    wineBinary: chosenCompatLayer.binaryPath,
                    bottlePath: targetWinePrefix,
                    env: bgEpicEnv,
                    suppressGuiDialogs: false,
                    layerType: chosenCompatLayer.type,
                  });
                  const bgEpicDll =
                    typeof alignedBgEpic.env.WINEDLLOVERRIDES === 'string'
                      ? alignedBgEpic.env.WINEDLLOVERRIDES.trim()
                      : '';
                  const bgEpicDllArgs =
                    bgEpicDll && doesCrossOverBinarySupportWaitChildren(chosenCompatLayer.binaryPath)
                      ? ['--dll', bgEpicDll]
                      : [];
                  const bottleEpicArgs = [
                    ...bgEpicDllArgs,
                    bottleEpicExe,
                    ...(effectivePerfPolicy.storefrontClientLifecycle === 'default_client'
                      ? []
                      : ['-silent']),
                  ];
                  const bgBottleEpic = bottleClientSpawnImpl(
                    alignedBgEpic.binaryPath,
                    bottleEpicArgs,
                    {
                      cwd: fs.existsSync(bottleEpicRoot) ? bottleEpicRoot : effectiveCwd,
                      env: alignedBgEpic.env,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (bgBottleEpic && typeof bgBottleEpic.unref === 'function') {
                    bgBottleEpic.unref();
                  }
                  wokeBottleEpicByLauncher = true;

                  await waitForBottleEpicPortalReady({
                    bottlePath: targetWinePrefix,
                    preBootLogOffset: preBootEpicLogOffset,
                    timeoutMs: 25000,
                    options,
                  });
                } catch (bgEpicErr) {
                  diagLog.warn('launchGame.bottleEpicWake', bgEpicErr, { gameId });
                }
              }
            }
          }

          if (platform === 'darwin' && localInstallDir) {
            try {
              cleanNonApfsAppleDoubleTwins(localInstallDir, options);
            } catch {}
          }

          /** @type {Record<string, any>} */
          let spawnEnv = env;
          if (platform === 'darwin' && spawnEnv) {
            if (useCompatLayer && !isTestEnvironment(options)) {
              spawnEnv = { ...env };
              spawnCmd = resolveSipSafeWineBinaryAndPreloadEnv(spawnCmd, spawnEnv, {
                layerType: chosenCompatLayer?.type,
              });
              if (isMacSipProtectedExecutableOrScript(spawnCmd)) {
                // CrossOver's #!/usr/bin/perl wrapper consumes CX_ENV
                // and injects it into non-SIP wineloader; strip outer DYLD_INSERT_LIBRARIES on SIP Perl.
                delete spawnEnv.DYLD_INSERT_LIBRARIES;
              }
            } else if (useCompatLayer) {
              spawnEnv = { ...env };
              prepareCrossOverWineSpawnEnv(spawnCmd, spawnEnv, {
                layerType: chosenCompatLayer?.type,
              });
            } else if (
              spawnEnv.DYLD_INSERT_LIBRARIES &&
              !isTestEnvironment(options) &&
              isMacSipProtectedExecutableOrScript(spawnCmd)
            ) {
              spawnEnv = { ...env };
              delete spawnEnv.DYLD_INSERT_LIBRARIES;
            }
          }

          /** @type {any} */
          let child = null;
          if (activatedXboxPid > 0) {
            child = {
              pid: activatedXboxPid,
              stderr: null,
              on: () => {},
              once: () => {},
            };
          } else {
            try {
              if (
                platform === 'win32' &&
                !useCompatLayer &&
                payload.platformId === 'xbox' &&
                /\bgamelaunchhelper\.exe$/i.test(String(spawnCmd || ''))
              ) {
                launchedViaXboxActivationLatch = true;
              }
              const resolvedDirectSpawn =
                gameSpawnImpl === spawn
                  ? resolveWindowsNodeShebangSpawn(spawnCmd, spawnArgs)
                  : { cmd: spawnCmd, args: spawnArgs };
              child = gameSpawnImpl(resolvedDirectSpawn.cmd, resolvedDirectSpawn.args, {
                cwd: effectiveCwd,
                env: spawnEnv,
                stdio: ['ignore', 'ignore', 'pipe'],
                detached: false,
              });
              if (
                platform === 'win32' &&
                !useCompatLayer &&
                child &&
                child.pid === undefined &&
                typeof child.once === 'function'
              ) {
                const asyncSpawnErr = await new Promise((resolve) => {
                  let settled = false;
                  const finish = (/** @type {any} */ errVal) => {
                    if (settled) return;
                    settled = true;
                    resolve(errVal);
                  };
                  child.once('error', (/** @type {any} */ err) => finish(err));
                  child.once('spawn', () => finish(null));
                  const t = setTimeout(() => finish(null), 50);
                  if (typeof t.unref === 'function') t.unref();
                });
                if (asyncSpawnErr) {
                  throw asyncSpawnErr;
                }
              }
            } catch (/** @type {any} */ initialSpawnErr) {
              if (
                platform === 'win32' &&
                !useCompatLayer &&
                isWindowsElevationRequiredError(initialSpawnErr, spawnCmd, options)
              ) {
                child = spawnWindowsViaPowerShellStartProcess(
                  gameSpawnImpl,
                  spawnCmd,
                  spawnArgs,
                  effectiveCwd,
                  spawnEnv,
                  true
                );
              } else if (
                !useCompatLayer &&
                isAutoLikeMethod &&
                buildStorefrontLaunchUri(payload)
              ) {
                shouldFallthroughToStorefrontUri = true;
              } else if (platform === 'win32' && !useCompatLayer) {
                child = spawnWindowsViaPowerShellStartProcess(
                  gameSpawnImpl,
                  spawnCmd,
                  spawnArgs,
                  effectiveCwd,
                  spawnEnv,
                  false
                );
              } else {
                throw initialSpawnErr;
              }
            }
          }

          if (!shouldFallthroughToStorefrontUri && child) {
            if (
              bottleShouldWatchSteamGameDir &&
              bottleDisplayStagedInfo &&
              targetWinePrefix &&
              localInstallDir
            ) {
              try {
                const winWatchDir = toWineWindowsPath(localInstallDir, targetWinePrefix);
                if (winWatchDir) {
                  bottleDisplayWatcherChild = gameSpawnImpl(
                    spawnCmd,
                    [
                      ...bottleSteamDisplayDllArgs,
                      bottleDisplayStagedInfo.launcherX86Posix,
                      '--watch-dir',
                      winWatchDir,
                      '--dll-x86',
                      bottleDisplayStagedInfo.winDllX86,
                      '--dll-x64',
                      bottleDisplayStagedInfo.winDllX64,
                      '--timeout-ms',
                      '120000',
                    ],
                    {
                      cwd: effectiveCwd,
                      env: spawnEnv,
                      stdio: 'ignore',
                      detached: true,
                    }
                  );
                  if (
                    bottleDisplayWatcherChild &&
                    typeof bottleDisplayWatcherChild.unref === 'function'
                  ) {
                    bottleDisplayWatcherChild.unref();
                  }
                  bottleDisplayScalerWrapped = true;
                }
              } catch (watchSpawnErr) {
                diagLog.warn('launchGame.bottleSteamDisplayWatcher', watchSpawnErr, { gameId });
              }
            }

            const isBottledMacSession = Boolean(useCompatLayer && platform === 'darwin');
            const session = {
              sessionId: preGeneratedSessionId,
              gameId,
              title: String(payload.title || gameId),
              platformId: payload.platformId || 'custom',
              platformGameId: String(payload.platformGameId || gameId),
              pid: shouldLaunchViaBottleSteam ? undefined : child.pid,
              startedAt: new Date().toISOString(),
              launchMethod: actualLaunchMethod,
              executablePath: resolvedExePath,
              status: 'running',
              isBottledSession: isBottledMacSession,
              ...(isBottledMacSession
                ? {
                    fullscreenActive: initialBottleFullscreen,
                    displayScalingMode: effectiveDisplayScalingMode,
                    displayAspectRatio: effectiveDisplayAspectRatio,
                  }
                : {}),
            };

            const resolvedWineBinary =
              useCompatLayer && chosenCompatLayer ? chosenCompatLayer.binaryPath || null : null;
            const resolvedWineserverBinary = resolvedWineBinary
              ? resolveWineserverBinary(resolvedWineBinary)
              : null;
            const resolvedWinePrefix = useCompatLayer
              ? compatResult?.winePrefix || env.WINEPREFIX || null
              : null;

            const paradoxExpectedExe =
              effectiveCaps?.paradoxDirectGameExe ||
              (resolvedExePath && /^dowser\.exe$/i.test(path.basename(resolvedExePath))
                ? resolveParadoxLauncherSettings(
                    resolvedExePath,
                    localInstallDir || path.dirname(resolvedExePath)
                  ).paradoxDirectGameExe || null
                : null);
            const mergedTargetBasenames = Array.from(
              new Set([
                ...(effectiveCaps?.targetExeBasenamesLower || []),
                ...(paradoxExpectedExe
                  ? [path.basename(paradoxExpectedExe).trim().toLowerCase()]
                  : []),
              ])
            ).filter(Boolean);

            /** @type {any} */
            const entry = {
              session,
              platformId: session.platformId,
              child,
              pid: shouldLaunchViaBottleSteam ? 0 : child.pid || 0,
              elevatedTargetPid: 0,
              reLatchedBottleChildPid: 0,
              targetExeBasenamesLower: mergedTargetBasenames,
              ...(paradoxExpectedExe ? { expectedGameExe: paradoxExpectedExe } : {}),
              pollTimer: null,
              startedMs: Date.now(),
              postExitCommand: launchConfig.postExitCommand,
              finalized: false,
              stopping: false,
              stderrBuffer: '',
              stderrCarryover: '',
              displayModeChangedErrorCount: 0,
              exitCode: null,
              stoppedByUser: false,
              wineBinary: resolvedWineBinary,
              wineserverBinary: resolvedWineserverBinary,
              winePrefix: resolvedWinePrefix,
              launchEnv: env,
              displayControlSeq: 1,
              displayControlFilePosix: bottleDisplayControlFilePosix || null,
              displayStatusFilePosix: bottleDisplayStatusFilePosix || null,
              displayScalerWrapped: bottleDisplayScalerWrapped,
              displayWatcherChild: bottleDisplayWatcherChild,
              chosenCompatLayerType: chosenCompatLayer?.type || null,
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
              isSteamStorefrontDepotUri: isSteamStorefrontDepotUri || undefined,
              chainedLauncherHandoff: steamChainedPublisherHandoff || undefined,
              wasBottlePublisherRunning: wasBottleSteamPublisherRunning || undefined,
              wokePublisherClientByLauncher: wokeBottleSteamPublisherByLauncher || undefined,
              bottleSteamExe: shouldLaunchViaBottleSteam ? bottleSteamExe : null,
              bottleSteamRoot:
                shouldLaunchViaBottleSteam && bottleSteamExe ? path.dirname(bottleSteamExe) : null,
              wokeBottleSteamByLauncher: shouldLaunchViaBottleSteam
                ? !wasBottleSteamRunning
                : false,
              bottleGogExe: shouldWakeBottleGog ? bottleGogExe : null,
              wasBottleGogRunning,
              wokeBottleGogByLauncher,
              bottleEpicExe: shouldWakeBottleEpic ? bottleEpicExe : null,
              wasBottleEpicRunning,
              wokeBottleEpicByLauncher,
              xboxLoopbackServer,
              packageFamilyName: resolvedXboxPfn || undefined,
              scid: resolvedXboxScid || undefined,
              fallbackScid: resolvedXboxFallbackScid || undefined,
              isAppxRegistered: isXboxAppxRegisteredOnWin32 || undefined,
              msaAppId: resolvedXboxMsaAppId || undefined,
              xboxTitleId: resolvedXboxTitleId || undefined,
              xboxProductId: resolvedXboxProductId || undefined,
              appUserModelId: resolvedXboxAumid || undefined,
              wasXboxAppRunningAtStart,
              wokeXboxAppByLauncher: false,
              displayStatusTimer: null,
              lastObservedDisplayStatusMtimeMs: 0,
            };

            if (
              entry.displayStatusFilePosix &&
              isBottledMacSession &&
              (!isTestEnvironment(options) || options.enableDisplayStatusSyncInTests === true)
            ) {
              const statusPollMs = Math.max(100, Number(options.displayStatusPollMs) || 600);
              const statusTimer = setInterval(() => {
                if (entry.finalized || !entry.displayStatusFilePosix) {
                  clearInterval(statusTimer);
                  return;
                }
                try {
                  if (!fs.existsSync(entry.displayStatusFilePosix)) return;
                  const st = fs.statSync(entry.displayStatusFilePosix);
                  if (!st.isFile() || st.mtimeMs <= (entry.lastObservedDisplayStatusMtimeMs || 0)) {
                    return;
                  }
                  entry.lastObservedDisplayStatusMtimeMs = st.mtimeMs;
                  const parsed = JSON.parse(fs.readFileSync(entry.displayStatusFilePosix, 'utf8'));
                  if (!parsed || typeof parsed !== 'object') return;
                  let updated = false;
                  if (
                    typeof parsed.fullscreen === 'boolean' &&
                    parsed.fullscreen !== entry.session.fullscreenActive
                  ) {
                    entry.session.fullscreenActive = parsed.fullscreen;
                    updated = true;
                  }
                  if (
                    typeof parsed.aspect === 'string' &&
                    VALID_DISPLAY_ASPECT_MODES.has(parsed.aspect) &&
                    parsed.aspect !== entry.session.displayAspectRatio
                  ) {
                    entry.session.displayAspectRatio = parsed.aspect;
                    updated = true;
                  }
                  if (updated) {
                    emitSessionUpdated(
                      {
                        session: { ...entry.session },
                        event: 'fullscreen_updated',
                      },
                      options
                    );
                  }
                } catch {}
              }, statusPollMs);
              if (typeof statusTimer.unref === 'function') {
                statusTimer.unref();
              }
              entry.displayStatusTimer = statusTimer;
            }

            if (
              child._isPowerShellStartProcessWrapper &&
              child.stdout &&
              typeof child.stdout.on === 'function'
            ) {
              let psStdoutHeader = '';
              child.stdout.on('data', (/** @type {any} */ chunk) => {
                if (psStdoutHeader.length < 512) {
                  psStdoutHeader += String(chunk || '');
                  const pidMatch = psStdoutHeader.match(/OL_ELEVATED_PID=(\d+)/);
                  if (pidMatch && pidMatch[1]) {
                    const latchedPid = Number.parseInt(pidMatch[1], 10);
                    if (latchedPid > 0) {
                      entry.elevatedTargetPid = latchedPid;
                      entry.pid = latchedPid;
                      if (entry.session) {
                        entry.session.pid = latchedPid;
                      }
                    }
                  }
                }
              });
            }

            if (child.stderr && typeof child.stderr.on === 'function') {
              child.stderr.on('data', (/** @type {any} */ chunk) => {
                recordBottledStderrChunk(entry, chunk);
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
              if (typeof child.on === 'function') {
                child.on('error', (/** @type {any} */ err) => {
                  entry.exitCode = -1;
                  entry.stderrBuffer += '\n' + (err && err.message ? err.message : String(err));
                  if (!entry.stopping) {
                    finalizeGameSession(gameId, options);
                  }
                });
              }

              if (!options.disableBottleSteamPolling) {
                const candidateGameExeNames = new Set();
                const addBottleHintIfValid = (/** @type {any} */ exeCandidate) => {
                  if (!exeCandidate) return;
                  const baseLower = path.basename(String(exeCandidate)).toLowerCase();
                  if (!baseLower || !baseLower.endsWith('.exe')) return;
                  if (BOTTLE_SYSTEM_DAEMON_EXE_SET.has(baseLower)) return;
                  if (isExcludedExecutable(baseLower)) return;
                  candidateGameExeNames.add(baseLower);
                };
                addBottleHintIfValid(resolvedExePath);
                addBottleHintIfValid(payload.executablePath);
                for (const discoveredExe of collectChainedGameCandidateExeNames(
                  localInstallDir || '',
                  resolvedExePath || ''
                )) {
                  candidateGameExeNames.add(discoveredExe);
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
                  if (
                    trackedPid > 0 &&
                    !hasMockProcessSource &&
                    typeof options.mockProcessListOutput !== 'string'
                  ) {
                    let trackedAlive = false;
                    try {
                      process.kill(trackedPid, 0);
                      trackedAlive = true;
                    } catch (/** @type {any} */ killErr) {
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

                  const handleBottleProcessList = (/** @type {any} */ err, /** @type {any} */ stdout) => {
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
            } else if (launchedViaXboxActivationLatch && platform === 'win32') {
              const xboxPollMs = Math.max(25, Number(options.xboxPollIntervalMs || 1500));
              const maxXboxBootstrapWaitMs = Number(options.xboxMaxBootstrapWaitMs ?? 60000);
              const candidateXboxExes = new Set();
              if (
                resolvedExePath &&
                !/^(?:explorer|gamelaunchhelper)\.exe$/i.test(path.basename(resolvedExePath))
              ) {
                candidateXboxExes.add(path.basename(resolvedExePath).toLowerCase());
              }
              if (xboxGameCfg?.executables) {
                for (const ex of xboxGameCfg.executables) {
                  if (ex && !ex.isGameLaunchHelper && !ex.isHelperStub && ex.name) {
                    candidateXboxExes.add(path.posix.basename(ex.name).toLowerCase());
                  }
                }
              }
              const xboxExeHints = Array.from(candidateXboxExes).filter(Boolean);
              const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
              let seenRealXboxGamePid = false;

              const pollTimer = setInterval(() => {
                if (entry.finalized || entry.stopping) {
                  clearInterval(pollTimer);
                  entry.pollTimer = null;
                  return;
                }

                const finalizeWithXboxWakeCheck = () => {
                  isWindowsXboxAppRunning(options)
                    .then((runningNow) => {
                      if (!wasXboxAppRunningAtStart && runningNow) {
                        entry.wokeXboxAppByLauncher = true;
                      }
                    })
                    .catch(() => {})
                    .finally(() => {
                      entry.exitCode = 0;
                      finalizeGameSession(gameId, options);
                    });
                };

                const handleWinProcOutput = (/** @type {any} */ err, /** @type {any} */ stdout) => {
                  if (err || entry.finalized || entry.stopping) return;
                  const outStr = String(stdout || '');
                  const matchedPid =
                    xboxExeHints.length > 0
                      ? extractMatchedPidFromProcessOutput(outStr, xboxExeHints, 'win32')
                      : 0;
                  if (matchedPid > 0) {
                    seenRealXboxGamePid = true;
                    entry.pid = matchedPid;
                    if (entry.session) entry.session.pid = matchedPid;
                    return;
                  }

                  const trackedPid = Number(entry.pid || entry.session?.pid || 0);
                  if (
                    trackedPid > 0 &&
                    typeof options.getProcessListOutput !== 'function' &&
                    typeof options.mockProcessListOutput !== 'string'
                  ) {
                    let alive = false;
                    try {
                      process.kill(trackedPid, 0);
                      alive = true;
                    } catch (/** @type {any} */ kErr) {
                      alive = Boolean(kErr && kErr.code === 'EPERM');
                    }
                    if (alive) {
                      if (Date.now() - entry.startedMs > 3000) {
                        seenRealXboxGamePid = true;
                      }
                      return;
                    }
                  }

                  if (
                    seenRealXboxGamePid ||
                    Date.now() - entry.startedMs >= maxXboxBootstrapWaitMs
                  ) {
                    clearInterval(pollTimer);
                    entry.pollTimer = null;
                    finalizeWithXboxWakeCheck();
                  }
                };

                if (typeof options.getProcessListOutput === 'function') {
                  Promise.resolve(options.getProcessListOutput())
                    .then((out) => handleWinProcOutput(null, out))
                    .catch(() => {});
                } else if (typeof options.mockProcessListOutput === 'string') {
                  handleWinProcOutput(null, options.mockProcessListOutput);
                } else if (!options.homedir || options.execFileImpl || options.execFileFn) {
                  execFileImpl(
                    'tasklist.exe',
                    ['/FO', 'CSV', '/NH'],
                    { timeout: 2500, windowsHide: true },
                    handleWinProcOutput
                  );
                }
              }, xboxPollMs);
              if (typeof pollTimer.unref === 'function') pollTimer.unref();
              entry.pollTimer = pollTimer;
            } else if (typeof child.on === 'function') {
              const triggerStandardExitFinalization = () => {
                if (entry.stopping) return;
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
              };

              child.on('exit', (/** @type {any} */ code, /** @type {any} */ signal) => {
                const computedExitCode =
                  typeof code === 'number'
                    ? code
                    : signal && !entry.stoppedByUser && !entry.stopping
                      ? -1
                      : 0;

                const applyExitCodeToEntry = () => {
                  if (entry.exitCode === null || entry.exitCode === undefined) {
                    entry.exitCode = computedExitCode;
                    if (signal && !entry.stoppedByUser && !entry.stopping) {
                      entry.exitSignal = signal;
                      if (!entry.stderrBuffer.trim()) {
                        entry.stderrBuffer = `Process terminated by signal ${signal}`;
                      }
                    }
                  }
                };

                if (entry.stopping || entry.stoppedByUser) {
                  applyExitCodeToEntry();
                  if (!entry.stopping) {
                    triggerStandardExitFinalization();
                  }
                  return;
                }

                const canCheckBottleChildProcesses =
                  useCompatLayer &&
                  (!isTestEnvironment(options) ||
                    typeof options.findLiveBottleGameChildPidFn === 'function' ||
                    typeof options.mockProcessListOutput === 'string' ||
                    typeof options.execFileImpl === 'function' ||
                    typeof options.execFileFn === 'function' ||
                    options.allowProcessCheckInTest === true);

                if (!canCheckBottleChildProcesses) {
                  applyExitCodeToEntry();
                  triggerStandardExitFinalization();
                  return;
                }

                void (async () => {
                  const childQueryParams = {
                    localInstallDir: entry.installPath,
                    resolvedExePath,
                    bottleDir: entry.winePrefix,
                    targetExeBasenamesLower: entry.targetExeBasenamesLower,
                    excludePid: child.pid || 0,
                  };
                  let liveChildPid = await findLiveBottleGameChildPid(childQueryParams, options);
                  if (
                    !liveChildPid &&
                    !entry.stopping &&
                    !entry.stoppedByUser &&
                    Date.now() - entry.startedMs < 15000 &&
                    (typeof options.mockProcessListOutput !== 'string' ||
                      options.bottleChildRetryDelayMs !== undefined) &&
                    (!options.homedir ||
                      typeof options.findLiveBottleGameChildPidFn === 'function' ||
                      options.bottleChildRetryDelayMs !== undefined ||
                      options.allowProcessCheckInTest === true)
                  ) {
                    const retryWaitMs =
                      options.bottleChildRetryDelayMs !== undefined
                        ? Math.max(0, Number(options.bottleChildRetryDelayMs))
                        : 350;
                    if (retryWaitMs > 0) {
                      await new Promise((r) => {
                        const t = setTimeout(r, retryWaitMs);
                        if (typeof t.unref === 'function') t.unref();
                      });
                    }
                    if (!entry.stopping && !entry.stoppedByUser) {
                      liveChildPid = await findLiveBottleGameChildPid(childQueryParams, options);
                    }
                  }

                  if (liveChildPid > 0 && !entry.stopping && !entry.stoppedByUser) {
                    diagLog.info('launchGame.reLatchedBottleChildProcess', {
                      gameId,
                      parentPid: child.pid || 0,
                      childPid: liveChildPid,
                    });
                    entry.exitCode = null;
                    entry.pid = liveChildPid;
                    entry.reLatchedBottleChildPid = liveChildPid;
                    if (entry.session) {
                      entry.session.pid = liveChildPid;
                    }
                    emitSessionUpdated(
                      {
                        gameId,
                        platformId: entry.platformId,
                        session: { ...entry.session },
                        status: 'running',
                        event: 'running',
                      },
                      options
                    );

                    const checkAliveFn =
                      typeof options.isProcessAliveFn === 'function'
                        ? options.isProcessAliveFn
                        : isProcessAlive;
                    const reLatchPollMs =
                      Number(options.bottleChildPollIntervalMs) > 0
                        ? Number(options.bottleChildPollIntervalMs)
                        : 1000;
                    let pollBusy = false;
                    const reLatchTimer = setInterval(() => {
                      if (pollBusy) return;
                      if (entry.stopping || entry.stoppedByUser || entry.finalized) {
                        clearInterval(reLatchTimer);
                        return;
                      }
                      if (entry.pid > 0 && checkAliveFn(entry.pid)) {
                        return;
                      }
                      pollBusy = true;
                      void findLiveBottleGameChildPid(
                        {
                          ...childQueryParams,
                          excludePid: entry.pid || child.pid || 0,
                        },
                        options
                      )
                        .then((nextPid) => {
                          if (entry.stopping || entry.stoppedByUser || entry.finalized) {
                            clearInterval(reLatchTimer);
                            return;
                          }
                          if (nextPid > 0 && nextPid !== entry.pid) {
                            entry.pid = nextPid;
                            entry.reLatchedBottleChildPid = nextPid;
                            if (entry.session) entry.session.pid = nextPid;
                            return;
                          }
                          clearInterval(reLatchTimer);
                          entry.pollTimer = null;
                          entry.exitCode = 0;
                          finalizeGameSession(gameId, options);
                        })
                        .finally(() => {
                          pollBusy = false;
                        });
                    }, reLatchPollMs);
                    if (typeof reLatchTimer.unref === 'function') reLatchTimer.unref();
                    entry.pollTimer = reLatchTimer;
                    return;
                  }

                  applyExitCodeToEntry();
                  triggerStandardExitFinalization();
                })();
              });

              child.on('error', (/** @type {any} */ err) => {
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
              await new Promise((r) => {
                if (entry.exitCode !== null) return r(undefined);
                let done = false;
                const finish = () => {
                  if (done) return;
                  done = true;
                  clearTimeout(t);
                  r(undefined);
                };
                const t = setTimeout(finish, startupWaitMs);
                if (child && typeof child.once === 'function') {
                  child.once('exit', finish);
                  child.once('error', finish);
                }
              });
            }

            if (entry.exitCode !== null && entry.exitCode !== 0) {
              const rawStderr = (entry.stderrBuffer || '').trim();
              const fatalMatch = rawStderr.match(/Fatal Error:\s*(.+)/i);
              const stderrLines = rawStderr
                .split(/\r?\n/)
                .map((/** @type {string} */ l) => l.trim())
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
        } catch (/** @type {any} */ spawnErr) {
          if (xboxLoopbackServer && typeof xboxLoopbackServer.close === 'function') {
            try {
              await xboxLoopbackServer.close();
            } catch {}
            xboxLoopbackServer = null;
          }
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

    let wasHostSteamPublisherRunning = false;
    let wokeHostSteamPublisherByLauncher = false;
    if (platform === 'win32' && isSteamStorefrontDepotUri && steamChainedPublisherHandoff) {
      wasHostSteamPublisherRunning = await checkHostWinPublisherUiRunningAsync(
        steamChainedPublisherHandoff,
        options
      );
      if (steamChainedPublisherHandoff !== 'riot' && options.skipPublisherProvisioning !== true) {
        const hostPubLauncher = discoverHostPublisherLauncher(steamChainedPublisherHandoff, {
          ...options,
          platform: 'win32',
        });
        if (
          !hostPubLauncher?.installed ||
          typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
        ) {
          const pubEco = /** @type {Record<string, any>} */ (CHAINED_PUBLISHER_ECOSYSTEMS)[
            steamChainedPublisherHandoff
          ];
          emitSessionUpdated(
            {
              gameId,
              platformId: payload.platformId || 'steam',
              status: 'starting',
              event: 'starting',
              statusMessage: `Preparing ${pubEco?.displayName || steamChainedPublisherHandoff}...`,
            },
            options
          );
          const ensureProvisionFn =
            typeof options.ensureChainedPublisherLauncherInstalledFn === 'function'
              ? options.ensureChainedPublisherLauncherInstalledFn
              : getEnsureChainedPublisherLauncherInstalled();
          try {
            await ensureProvisionFn(
              {
                handoffId: steamChainedPublisherHandoff,
                platform: 'win32',
              },
              options
            );
          } catch (hostPubProvErr) {
            diagLog.warn('launchGame.win32SteamPublisherProvision', hostPubProvErr, {
              gameId,
              handoffId: steamChainedPublisherHandoff,
            });
          }
        }
      }
      wokeHostSteamPublisherByLauncher = !wasHostSteamPublisherRunning;
    }

    let uriHostSteamRoot = '';
    let steamGameProcessLogOffset = 0;
    if (payload.platformId === 'steam') {
      uriHostSteamRoot =
        options.steamRoot ||
        (platform === 'win32'
          ? (() => {
              const sBin = resolveSteamClientBinaryPath(options);
              return sBin ? path.dirname(sBin) : '';
            })()
          : !options.homedir && isTestEnvironment(options)
            ? ''
            : path.join(
                options.homedir || os.homedir(),
                'Library',
                'Application Support',
                'Steam'
              ));
      if (uriHostSteamRoot) {
        const gpLogPath = path.join(uriHostSteamRoot, 'logs', 'gameprocess_log.txt');
        try {
          if (fs.existsSync(gpLogPath)) {
            steamGameProcessLogOffset = fs.statSync(gpLogPath).size;
          }
        } catch {}
      }
    }

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
            uriHostSteamRoot ||
            (platform === 'win32'
              ? path.dirname(steamLaunchSpec.binaryPath)
              : path.join(
                  options.homedir || os.homedir(),
                  'Library',
                  'Application Support',
                  'Steam'
                ));
          uriHostSteamRoot = hostSteamRoot;
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

          const macSteamAppMatch =
            platform === 'darwin' && typeof options.spawnFn !== 'function'
              ? String(steamLaunchSpec.binaryPath).match(/^(.*?\.app)(?:\/|$)/i)
              : null;
          if (macSteamAppMatch && macSteamAppMatch[1] && steamLaunchSpec.useMinimalBinarySpawn) {
            const stage1Child = spawnImpl(
              '/usr/bin/open',
              [
                '-g',
                '-j',
                '-a',
                macSteamAppMatch[1],
                '--args',
                '-silent',
                '-nofriendsui',
                '-nochatui',
              ],
              {
                detached: true,
                stdio: 'ignore',
              }
            );
            if (stage1Child && typeof stage1Child.unref === 'function') {
              stage1Child.unref();
            }
          } else {
            const stage1Args = steamLaunchSpec.useMinimalBinarySpawn ? ['-silent'] : [];
            const stage1Child = spawnImpl(steamLaunchSpec.binaryPath, stage1Args, {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            if (stage1Child && typeof stage1Child.unref === 'function') {
              stage1Child.unref();
            }
          }

          await waitForSteamColdStartupCloudReady(hostSteamRoot, steamAppIdVal, {
            ...options,
            preBootLogOffset,
          });

          if (steamLaunchSpec.useMinimalBinarySpawn) {
            const hasCustomOpenExternal =
              typeof options.openExternalFn === 'function' ||
              typeof options.onOpenExternal === 'function';
            if (platform === 'win32' || (!hasCustomOpenExternal && steamLaunchSpec.binaryPath)) {
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

    let wokeEpicByLauncher = false;
    if (payload.platformId === 'epic') {
      const checkEpicOut = (/** @type {any} */ outStr) =>
        /(?:EpicGamesLauncher|Epic Games Launcher)/i.test(String(outStr || ''));
      /** @type {boolean | null} */
      let wasHostEpicRunning = null;
      if (typeof options.mockProcessListOutput === 'string') {
        wasHostEpicRunning = checkEpicOut(options.mockProcessListOutput);
      } else if (typeof options.getProcessListOutput === 'function') {
        try {
          wasHostEpicRunning = checkEpicOut(await options.getProcessListOutput());
        } catch {}
      } else if (
        !options.homedir ||
        typeof options.execFileFn === 'function' ||
        typeof options.execFileImpl === 'function'
      ) {
        const execImpl =
          typeof options.execFileImpl === 'function'
            ? options.execFileImpl
            : typeof options.execFileFn === 'function'
              ? options.execFileFn
              : execFile;
        wasHostEpicRunning = await new Promise((resolve) => {
          try {
            if (platform === 'win32') {
              execImpl(
                'tasklist.exe',
                ['/FI', 'IMAGENAME eq EpicGamesLauncher.exe', '/NH'],
                { timeout: 1500, windowsHide: true },
                (/** @type {any} */ err, /** @type {any} */ stdout) =>
                  resolve(!err && checkEpicOut(stdout))
              );
            } else {
              execImpl(
                'ps',
                ['-ax', '-o', 'command='],
                { timeout: 1500 },
                (/** @type {any} */ err, /** @type {any} */ stdout) =>
                  resolve(!err && checkEpicOut(stdout))
              );
            }
          } catch {
            resolve(true);
          }
        });
      }
      if (wasHostEpicRunning === false) {
        wokeEpicByLauncher = true;
      }
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

      const canCheckHostGogForUri =
        !isTestEnvironment(options) ||
        options.mockProcessListOutput !== undefined ||
        typeof options.getProcessListOutput === 'function';

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
            if (canCheckHostGogForUri) {
              const wasWinGogRunning = await isHostGogGalaxyRunning({
                ...options,
                platform: 'win32',
              });
              if (!wasWinGogRunning) {
                gogWakeResult = {
                  found: true,
                  alreadyRunning: false,
                  started: true,
                  clientPath: galaxyClientExe,
                };
              }
            }
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

      if (!gogCliSpawned) {
        const shouldPreWakeSilentMacGogForUri =
          platform === 'darwin' &&
          effectivePerfPolicy.storefrontClientLifecycle !== 'default_client' &&
          effectivePerfPolicy.storefrontClientLifecycle !== 'fast_direct_bypass' &&
          options.disableGogGalaxyWake !== true;

        if (shouldPreWakeSilentMacGogForUri) {
          try {
            const preWakeRes = await ensureGogGalaxyBackgroundService({
              ...options,
              platform,
              storefrontClientLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
            });
            if (preWakeRes && !preWakeRes.skippedInTest) {
              gogWakeResult = preWakeRes;
            }
          } catch {}
        }

        if (!gogWakeResult && canCheckHostGogForUri) {
          try {
            const wasHostGogRunningForUri = await isHostGogGalaxyRunning({
              ...options,
              platform,
            });
            if (!wasHostGogRunningForUri) {
              const detectedHostClientPath = resolveGogGalaxyClientBinaryPath({
                ...options,
                platform,
              });
              gogWakeResult = {
                found: Boolean(detectedHostClientPath),
                alreadyRunning: false,
                started: true,
                clientPath: detectedHostClientPath,
              };
            }
          } catch {}
        }
      }
    }

    if (!steamMinimalSpawnedResult && !gogCliSpawned) {
      const shouldBackgroundUriOpen =
        payload.platformId === 'gog' &&
        platform === 'darwin' &&
        effectivePerfPolicy.storefrontClientLifecycle !== 'default_client';
      await openExternalUri(
        uri,
        shouldBackgroundUriOpen ? { ...options, activate: false } : options
      );
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
      isBottledSession: false,
    };

    /** @type {any} */
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
      steamRoot: uriHostSteamRoot || undefined,
      launchOptions: options,
      launchConfig,
      effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
      wokeGogGalaxyByLauncher: Boolean(gogWakeResult && gogWakeResult.started),
      gogGalaxyClientPath: gogWakeResult ? gogWakeResult.clientPath || null : null,
      wokeSteamByLauncher: Boolean(
        steamMinimalSpawnedResult && steamMinimalSpawnedResult.wokeSteamByLauncher
      ),
      steamClientBinaryPath: steamMinimalSpawnedResult
        ? steamMinimalSpawnedResult.binaryPath || null
        : null,
      wokeEpicByLauncher: Boolean(wokeEpicByLauncher),
      isSteamStorefrontDepotUri: isSteamStorefrontDepotUri || undefined,
      chainedLauncherHandoff: steamChainedPublisherHandoff || undefined,
      wasHostPublisherRunning: wasHostSteamPublisherRunning || undefined,
      wokePublisherClientByLauncher: wokeHostSteamPublisherByLauncher || undefined,
    };

    const steamChainedExeCandidates = isSteamStorefrontDepotUri
      ? collectChainedGameCandidateExeNames(
          localInstallDir || (payload.installPath ? toLocalFsPath(payload.installPath) : ''),
          resolvedExePath || ''
        )
      : [];
    const maxSteamChainedBootstrapWaitMs = Number(options.chainedLauncherMaxBootstrapWaitMs ?? 90000);

    const canMonitorSteamLog = Boolean(
      payload.platformId === 'steam' && uriHostSteamRoot && effectiveSteamAppId
    );
    if (
      (payload.installPath || localInstallDir || canMonitorSteamLog) &&
      !options.disableUriPolling
    ) {
      let seenRunningOnSystem = false;
      const pollIntervalMs = Number(options.uriPollIntervalMs || 4000);
      const execFileImpl =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : execFile;
      const pollTimer = setInterval(() => {
        if (entry.finalized) {
          clearInterval(pollTimer);
          entry.pollTimer = null;
          return;
        }
        const trackedPid = Number(entry.session?.pid || entry.pid || 0);
        if (trackedPid > 0) {
          const isPidAliveFn =
            typeof options.isPidAliveFn === 'function' ? options.isPidAliveFn : null;
          let trackedAlive = false;
          if (isPidAliveFn) {
            try {
              trackedAlive = Boolean(isPidAliveFn(trackedPid));
            } catch {
              trackedAlive = false;
            }
          } else {
            try {
              process.kill(trackedPid, 0);
              trackedAlive = true;
            } catch (/** @type {any} */ killErr) {
              trackedAlive = Boolean(killErr && killErr.code === 'EPERM');
            }
          }
          if (trackedAlive) {
            seenRunningOnSystem = true;
            return;
          }
          entry.pid = 0;
          if (entry.session) {
            entry.session.pid = undefined;
          }
        }

        if (
          canMonitorSteamLog &&
          (!isSteamStorefrontDepotUri || steamChainedExeCandidates.length === 0)
        ) {
          const steamLogPid = extractTrackedPidFromSteamGameProcessLog(
            uriHostSteamRoot,
            effectiveSteamAppId,
            steamGameProcessLogOffset,
            options
          );
          if (steamLogPid > 0) {
            seenRunningOnSystem = true;
            entry.pid = steamLogPid;
            if (entry.session) {
              entry.session.pid = steamLogPid;
            }
            return;
          }
        }

        const targetPlatform = options.platform || process.platform;
        const filterUriExeHint = (/** @type {string} */ hint) => {
          if (!hint) return false;
          if (hint.endsWith('.exe')) {
            if (BOTTLE_SYSTEM_DAEMON_EXE_SET.has(hint)) return false;
            if (isExcludedExecutable(hint)) return false;
          }
          return true;
        };
        const exeHints = Array.from(
          new Set(
            [
              payload.executablePath ? path.basename(payload.executablePath).toLowerCase() : '',
              resolvedExePath ? path.basename(resolvedExePath).toLowerCase() : '',
              ...steamChainedExeCandidates,
              !isSteamStorefrontDepotUri && payload.installPath
                ? path.basename(payload.installPath).toLowerCase()
                : '',
            ].filter(filterUriExeHint)
          )
        );
        if (exeHints.length === 0) {
          if (seenRunningOnSystem) {
            finalizeGameSession(gameId, options);
          } else if (
            isSteamStorefrontDepotUri &&
            maxSteamChainedBootstrapWaitMs > 0 &&
            Date.now() - entry.startedMs >= maxSteamChainedBootstrapWaitMs
          ) {
            finalizeGameSession(gameId, options);
          }
          return;
        }
        const handleProcessList = (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (err || !stdout || entry.finalized) return;
          const matchedPid = extractMatchedPidFromProcessOutput(
            stdout,
            exeHints,
            targetPlatform
          );
          const isPresent = matchedPid > 0;
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
          } else if (
            isSteamStorefrontDepotUri &&
            maxSteamChainedBootstrapWaitMs > 0 &&
            Date.now() - entry.startedMs >= maxSteamChainedBootstrapWaitMs
          ) {
            finalizeGameSession(gameId, options);
          }
        };
        if (targetPlatform === 'win32') {
          execFileImpl(
            'tasklist.exe',
            ['/FO', 'CSV', '/NH'],
            { timeout: 2500, windowsHide: true },
            handleProcessList
          );
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
  } catch (/** @type {any} */ err) {
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
async function stopGame(/** @type {any} */ request = {}, /** @type {any} */ options = {}) {
  try {
    const reqObj =
      typeof request === 'string' ? { gameId: request, sessionId: request } : request || {};
    /** @type {string | null} */
    let targetKey = null;
    /** @type {any} */
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
    if (
      targetEntry.displayWatcherChild &&
      typeof targetEntry.displayWatcherChild.kill === 'function'
    ) {
      try {
        targetEntry.displayWatcherChild.kill('SIGTERM');
      } catch {}
      targetEntry.displayWatcherChild = null;
    }
    emitSessionUpdated({
      session: { ...targetEntry.session },
      event: 'stopping',
    });

    const mergedStopOptions = {
      ...(targetEntry.launchOptions || {}),
      ...(options || {}),
    };
    const isTestHomedir = Boolean(mergedStopOptions.homedir || reqObj.homedir);
    const isTestStopEnv =
      isTestEnvironment(mergedStopOptions) && mergedStopOptions.allowProcessCheckInTest !== true;
    const exePath = targetEntry.session?.executablePath || '';
    const exeBase =
      process.platform !== 'win32' && exePath.toLowerCase().endsWith('.exe')
        ? path.basename(exePath)
        : '';

    if (!isTestStopEnv && exeBase && exeBase.length > 3) {
      await killPosixProcessesMatchingWinExe(exePath, 'SIGTERM', targetEntry.winePrefix || '');
    }
    if (!isTestStopEnv && Array.isArray(targetEntry.targetExeBasenamesLower)) {
      for (const childExeName of targetEntry.targetExeBasenamesLower) {
        if (
          typeof childExeName === 'string' &&
          childExeName.length > 4 &&
          childExeName.toLowerCase() !== exeBase.toLowerCase()
        ) {
          await killPosixProcessesMatchingWinExe(
            childExeName,
            'SIGTERM',
            targetEntry.winePrefix || ''
          );
        }
      }
    }
    if (Number(targetEntry.reLatchedBottleChildPid) > 0) {
      try {
        process.kill(Number(targetEntry.reLatchedBottleChildPid), 'SIGTERM');
      } catch {}
    }

    const stopPlatform = mergedStopOptions.platform || process.platform;
    const macAppBundlePath =
      stopPlatform === 'darwin' && !targetEntry.winePrefix
        ? resolveTargetMacAppBundlePath(exePath)
        : null;
    const signalMacAppBundleProcesses = (/** @type {NodeJS.Signals} */ sig) =>
      new Promise((resolve) => {
        if (!macAppBundlePath || isTestStopEnv) return resolve(undefined);
        const macOsDirPrefix = `${path.resolve(macAppBundlePath)}/Contents/MacOS/`;
        try {
          execFile('ps', ['-axo', 'pid=,command='], { timeout: 1500 }, (err, stdout) => {
            if (!err && stdout) {
              for (const rawLine of String(stdout).split(/\r?\n/)) {
                const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
                if (!m) continue;
                const cPid = Number.parseInt(m[1], 10);
                if (cPid > 1 && cPid !== process.pid && m[2].includes(macOsDirPrefix)) {
                  try {
                    process.kill(cPid, sig);
                  } catch {}
                }
              }
            }
            resolve(undefined);
          });
        } catch {
          resolve(undefined);
        }
      });

    if (macAppBundlePath && !isTestHomedir && !isTestEnvironment(mergedStopOptions)) {
      const bundleId = readMacBundleIdFromInfoPlist(macAppBundlePath);
      if (bundleId && /^[A-Za-z0-9._-]+$/.test(bundleId)) {
        await new Promise((resolve) => {
          try {
            execFile(
              'osascript',
              ['-e', `tell application id "${bundleId}" to quit`],
              { timeout: 1500 },
              () => resolve(undefined)
            );
          } catch {
            resolve(undefined);
          }
        });
      }
      await signalMacAppBundleProcesses('SIGTERM');
    }

    const effectivePerfPolicy = resolveEffectivePerformancePolicy(
      targetEntry.launchConfig || {},
      mergedStopOptions
    );

    const elevatedTargetPid = Number(targetEntry.elevatedTargetPid || 0);
    const usesLatchedPublisherChildPid = Boolean(
      targetEntry.launchedViaBottleSteam ||
        (targetEntry.launchedViaPublisherClient && Number(targetEntry.reLatchedBottleChildPid || 0) > 0)
    );
    const pid = usesLatchedPublisherChildPid
      ? Number(targetEntry.pid || targetEntry.session?.pid || 0) || null
      : elevatedTargetPid > 0
        ? elevatedTargetPid
        : (targetEntry.child && targetEntry.child.pid ? targetEntry.child.pid : null) ||
          Number(targetEntry.pid || targetEntry.session?.pid || 0) ||
          null;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }

    const sessionWinePrefix = targetEntry.winePrefix || null;
    const sessionWineBin = targetEntry.wineserverBinary || targetEntry.wineBinary || null;
    const entryPlatformId = targetEntry.session?.platformId || targetEntry.platformId || '';
    const needsDeferredPrefixShutdownForCloud = Boolean(
      targetEntry.launchedViaBottleSteam ||
        targetEntry.wokeBottleGogByLauncher ||
        targetEntry.wasBottleGogRunning ||
        targetEntry.wokeBottleEpicByLauncher ||
        targetEntry.wasBottleEpicRunning ||
        targetEntry.isChainedPublisherLauncher ||
        entryPlatformId === 'epic' ||
        entryPlatformId === 'gog'
    );
    const stopHostPlatform =
      mergedStopOptions.platform || options.platform || reqObj.platform || process.platform;
    if (
      stopHostPlatform !== 'win32' &&
      sessionWinePrefix &&
      sessionWineBin &&
      effectivePerfPolicy.autoShutdownWinePrefixOnExit !== false
    ) {
      const resolvedWineserver = resolveWineserverBinary(sessionWineBin);
      const normWineserver = resolvedWineserver
        ? path.resolve(resolvedWineserver).replace(/\\/g, '/').toLowerCase()
        : '';
      const normTestHome = (options.homedir || reqObj.homedir || '')
        ? path.resolve(options.homedir || reqObj.homedir).replace(/\\/g, '/').toLowerCase()
        : '';
      const normTmpDir = path.resolve(os.tmpdir()).replace(/\\/g, '/').toLowerCase();
      const canRunWineserver =
        Boolean(resolvedWineserver) &&
        (!isTestHomedir ||
          (normTestHome && normWineserver.startsWith(normTestHome)) ||
          normWineserver.startsWith(normTmpDir) ||
          normWineserver.startsWith('/private/var/folders') ||
          normWineserver.startsWith('/var/folders'));
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
          deleteBottleDaemonEnvContract(sessionWinePrefix);
          await shutdownWinePrefix(resolvedWineserver, sessionWinePrefix, 2500);
        }
      }
    }

    if (pid) {
      const exitedGracefully = await waitForProcessExit(
        usesLatchedPublisherChildPid || elevatedTargetPid > 0 ? null : targetEntry.child,
        pid,
        500
      );
      if (!exitedGracefully && isProcessAlive(pid)) {
        if (stopPlatform === 'win32') {
          try {
            await signalSubprocessTree(
              usesLatchedPublisherChildPid || elevatedTargetPid > 0
                ? { pid }
                : targetEntry.child || { pid },
              'SIGKILL',
              mergedStopOptions
            );
          } catch {}
          if (
            elevatedTargetPid > 0 &&
            targetEntry.child?._requireRunAs &&
            isProcessAlive(elevatedTargetPid) &&
            !isTestStopEnv
          ) {
            const execFileImpl =
              mergedStopOptions.execFileImpl || mergedStopOptions.execFileFn || execFile;
            await new Promise((resolve) => {
              try {
                execFileImpl(
                  'powershell.exe',
                  [
                    '-NoProfile',
                    '-NonInteractive',
                    '-WindowStyle',
                    'Hidden',
                    '-Command',
                    `Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID','${elevatedTargetPid}','/T','/F') -Verb RunAs -WindowStyle Hidden -Wait`,
                  ],
                  { timeout: 10000, windowsHide: true },
                  () => resolve(undefined)
                );
              } catch {
                resolve(undefined);
              }
            });
          }
          if (
            elevatedTargetPid > 0 &&
            targetEntry.child?.pid &&
            targetEntry.child.pid !== elevatedTargetPid
          ) {
            try {
              process.kill(targetEntry.child.pid, 'SIGTERM');
            } catch {}
          }
        } else {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
        if (!isTestStopEnv && exeBase && exeBase.length > 3) {
          await killPosixProcessesMatchingWinExe(exePath, 'SIGKILL', targetEntry.winePrefix || '');
        }
        if (macAppBundlePath && !isTestStopEnv) {
          await signalMacAppBundleProcesses('SIGKILL');
        }
        await waitForProcessExit(
          usesLatchedPublisherChildPid || elevatedTargetPid > 0 ? null : targetEntry.child,
          pid,
          400
        );
      }
    } else if (macAppBundlePath && !isTestStopEnv) {
      await signalMacAppBundleProcesses('SIGKILL');
    }

    const result = finalizeGameSession(targetKey, options) || {
      session: targetEntry.session,
      sessionMinutesPlayed: Math.max(1, Math.round((Date.now() - targetEntry.startedMs) / 60000)),
      postSessionBarrierPromise: null,
      storefrontSyncPromise: null,
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
  } catch (/** @type {any} */ err) {
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
 * Dynamically toggle or update fullscreen state & aspect ratio on an active bottled macOS game
 * session without restarting the game (`seq=<N>\nfullscreen=0|1\naspect=...\n`).
 *
 * @param {any} payload
 * @param {Record<string, any>} [options]
 */
function toggleSessionFullscreen(payload = {}, options = {}) {
  try {
    const reqObj =
      typeof payload === 'string'
        ? { gameId: payload, sessionId: payload }
        : payload && typeof payload === 'object'
          ? payload
          : {};
    /** @type {any} */
    let targetEntry = null;
    if (reqObj.gameId && activeSessions.has(reqObj.gameId)) {
      targetEntry = activeSessions.get(reqObj.gameId);
    } else {
      for (const [, entry] of activeSessions.entries()) {
        if (
          (reqObj.sessionId && entry.session?.sessionId === reqObj.sessionId) ||
          (reqObj.gameId &&
            (entry.session?.gameId === String(reqObj.gameId) ||
              entry.session?.platformGameId === String(reqObj.gameId)))
        ) {
          targetEntry = entry;
          break;
        }
      }
    }

    if (!targetEntry || targetEntry.finalized || !targetEntry.session) {
      return {
        success: false,
        error: 'No active running game session found.',
      };
    }

    const isBottled = Boolean(targetEntry.session.isBottledSession || targetEntry.winePrefix);
    if (!isBottled) {
      return {
        success: false,
        sessionId: targetEntry.session.sessionId,
        gameId: targetEntry.session.gameId,
        error: 'Live fullscreen toggle is only supported for bottled macOS sessions.',
      };
    }

    const nextFullscreen =
      typeof reqObj.fullscreen === 'boolean'
        ? reqObj.fullscreen
        : !Boolean(targetEntry.session.fullscreenActive);
    const nextAspect =
      typeof reqObj.aspectRatio === 'string' && VALID_DISPLAY_ASPECT_MODES.has(reqObj.aspectRatio)
        ? reqObj.aspectRatio
        : String(targetEntry.session.displayAspectRatio || 'preserve_aspect');

    const nextSeq = (Number(targetEntry.displayControlSeq) || 1) + 1;
    targetEntry.displayControlSeq = nextSeq;

    const mergedOpts = {
      ...(targetEntry.launchOptions || {}),
      ...(options || {}),
    };

    const targetPrefix = String(targetEntry.winePrefix || '').trim();
    let controlFilePosix = String(targetEntry.displayControlFilePosix || '').trim();
    if (!controlFilePosix && targetPrefix && fs.existsSync(targetPrefix)) {
      const stageDir = path.join(
        targetPrefix,
        'drive_c',
        'ProgramData',
        'OneLauncher',
        'display_scaler'
      );
      try {
        fs.mkdirSync(stageDir, { recursive: true });
        controlFilePosix = path.join(
          stageDir,
          `display_ctl_${targetEntry.session.sessionId}.ini`
        );
        targetEntry.displayControlFilePosix = controlFilePosix;
      } catch {}
    }

    if (controlFilePosix) {
      try {
        atomicWriteFileSync(
          controlFilePosix,
          formatDisplayScalerControlIni(nextSeq, nextFullscreen, nextAspect)
        );
      } catch (/** @type {any} */ writeErr) {
        return {
          success: false,
          sessionId: targetEntry.session.sessionId,
          gameId: targetEntry.session.gameId,
          error: `Failed to write display control file: ${writeErr?.message || String(writeErr)}`,
        };
      }
    }

    if (
      !targetEntry.displayScalerWrapped &&
      !targetEntry.displayWatcherChild &&
      targetPrefix &&
      fs.existsSync(targetPrefix) &&
      targetEntry.wineBinary &&
      targetEntry.installPath &&
      (!isTestEnvironment(mergedOpts) || mergedOpts.enableDisplayScalerInTests === true)
    ) {
      try {
        const staged = stageBottleDisplayScalerBinaries(targetPrefix, mergedOpts);
        const winWatchDir = toWineWindowsPath(targetEntry.installPath, targetPrefix);
        if (staged.allPresent && winWatchDir) {
          const auxEnv = {
            ...(targetEntry.launchEnv || process.env),
            WINEPREFIX: targetPrefix,
            ONE_LAUNCHER_DISPLAY_SCALING_MODE: nextFullscreen ? 'force_fullscreen' : 'windowed',
            ONE_LAUNCHER_DISPLAY_ASPECT: nextAspect,
            ONE_LAUNCHER_SAFE_INSET_TOP: '0',
            ONE_LAUNCHER_SCALER_DLL_X86: staged.winDllX86,
            ONE_LAUNCHER_SCALER_DLL_X64: staged.winDllX64,
            ONE_LAUNCHER_LAUNCHER_EXE_X86: staged.winLauncherX86,
            ONE_LAUNCHER_LAUNCHER_EXE_X64: staged.winLauncherX64,
            ONE_LAUNCHER_DISPLAY_CONTROL_FILE: `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${targetEntry.session.sessionId}.ini`,
            ONE_LAUNCHER_DISPLAY_STATUS_FILE: `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${targetEntry.session.sessionId}.json`,
          };
          const alignedWatch = prepareAlignedAuxBottleWineCommand({
            wineBinary: targetEntry.wineBinary,
            bottlePath: targetPrefix,
            env: auxEnv,
            suppressGuiDialogs: true,
            layerType: targetEntry.chosenCompatLayerType || null,
          });
          const watchSpawnFn = mergedOpts.gameSpawnFn || mergedOpts.spawnFn || spawn;
          const watcherChild = watchSpawnFn(
            alignedWatch.binaryPath,
            [
              staged.launcherX86Posix,
              '--watch-dir',
              winWatchDir,
              '--dll-x86',
              staged.winDllX86,
              '--dll-x64',
              staged.winDllX64,
              '--timeout-ms',
              '15000',
            ],
            {
              cwd: fs.existsSync(targetEntry.installPath) ? targetEntry.installPath : process.cwd(),
              env: alignedWatch.env,
              stdio: 'ignore',
              detached: true,
            }
          );
          if (watcherChild && typeof watcherChild.unref === 'function') {
            watcherChild.unref();
          }
          targetEntry.displayWatcherChild = watcherChild;
          targetEntry.displayScalerWrapped = true;
        }
      } catch {}
    }

    targetEntry.session.fullscreenActive = nextFullscreen;
    targetEntry.session.displayAspectRatio = nextAspect;

    emitSessionUpdated(
      {
        session: { ...targetEntry.session },
        event: 'fullscreen_updated',
      },
      mergedOpts
    );

    return {
      success: true,
      sessionId: targetEntry.session.sessionId,
      gameId: targetEntry.session.gameId,
      fullscreenActive: nextFullscreen,
      displayAspectRatio: nextAspect,
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Discover native host Steam client binary (`steam.exe` on Windows, `steam_osx` on macOS)
 * while respecting isolated test overrides (`steamClientBinaryPath`, `customApplicationsDir`, `homedir`).
 */
function resolveSteamClientBinaryPath(/** @type {any} */ options = {}) {
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
      const regSteam = discoverWindowsSteamRegistryPaths(options);
      if (regSteam.steamExe) {
        winCandidates.push(regSteam.steamExe);
      }
      const regSteamRoot = regSteam.steamRoot || regSteam.steamPath;
      if (regSteamRoot) {
        winCandidates.push(path.join(regSteamRoot, 'steam.exe'));
      }
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
 * Detect whether official desktop storefront clients (Steam, GOG Galaxy, Epic Games Launcher, Xbox App)
 * are installed on the host OS.
 */
function detectInstalledStorefrontClients(/** @type {any} */ options = {}) {
  return {
    steam: Boolean(resolveSteamClientBinaryPath(options)),
    gog: Boolean(resolveGogGalaxyClientBinaryPath(options)),
    epic: Boolean(resolveEpicClientBinaryPath(options)),
    xbox: Boolean(resolveXboxClientBinaryPath(options)),
  };
}

/**
 * Resolve Steam client binary path and minimal launch command when Steam is not already running.
 */
async function resolveSteamClientLaunchCommand(
  /** @type {any} */ steamAppId,
  /** @type {any[]} */ extraArgs = [],
  /** @type {any} */ options = {}
) {
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

  const binaryPath = resolveSteamClientBinaryPath(options);

  let alreadyRunning = false;
  const checkProcessList = (/** @type {any} */ stdoutStr) => {
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
            { timeout: 1500, windowsHide: true },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              resolve(!err && checkProcessList(stdout));
            }
          );
        } else {
          execFileImpl(
            'ps',
            ['-ax', '-o', 'command='],
            { timeout: 1500 },
            (/** @type {any} */ err, /** @type {any} */ stdout) => {
              resolve(!err && checkProcessList(stdout));
            }
          );
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
 * Gracefully shut down an ephemeral storefront client that was woken specifically by One Launcher.
 */
async function shutdownEphemeralStorefrontClient(
  /** @type {any} */ sessionEntry = {},
  /** @type {any} */ options = {}
) {
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
          resolve(undefined);
        };
        const t = setTimeout(finish, graceMs);
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

    const shouldReapGogOverlay =
      !isTestEnvironment(options) ||
      options.allowOverlayReaperInTest === true ||
      typeof options.mockOverlayProcessList === 'string';

    if (platformId === 'gog' && sessionEntry.wokeGogGalaxyByLauncher === true) {
      const busyBeforeGogKill = getBusyOrAbortedReason();
      if (busyBeforeGogKill) {
        return { closed: false, shutDown: false, reason: busyBeforeGogKill };
      }

      const canCheckHostGogAlive =
        !isTestEnvironment(options) ||
        options.mockProcessListOutput !== undefined ||
        typeof options.getProcessListOutput === 'function';

      if (canCheckHostGogAlive) {
        const stillRunningBeforeFlush = await isHostGogGalaxyRunning({
          ...options,
          platform: targetPlatform,
        });
        if (!stillRunningBeforeFlush) {
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: false,
            shutDown: false,
            alreadyClosed: true,
            platformId: 'gog',
            reason: 'already_exited',
          };
        }
      }

      const gogFlushWait = await waitForGogPostExitFlush({
        platform: targetPlatform,
        homedir: options.homedir,
        signal: abortCtrl.signal,
        options,
      });

      const busyAfterGogFlush = getBusyOrAbortedReason();
      if (busyAfterGogFlush) {
        return { closed: false, shutDown: false, reason: busyAfterGogFlush };
      }

      if (canCheckHostGogAlive && gogFlushWait && gogFlushWait.waitedMs > 0) {
        const stillRunningAfterFlush = await isHostGogGalaxyRunning({
          ...options,
          platform: targetPlatform,
        });
        if (!stillRunningAfterFlush) {
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: false,
            shutDown: false,
            alreadyClosed: true,
            platformId: 'gog',
            reason: 'already_exited',
          };
        }
      }

      const clientPath =
        sessionEntry.gogGalaxyClientPath ||
        (!isTestEnvironment(options) && targetPlatform === 'win32'
          ? resolveGogGalaxyClientBinaryPath({ ...options, platform: 'win32' })
          : null) ||
        'GalaxyClient.exe';
      try {
        if (targetPlatform === 'win32') {
          const child = spawnImpl(clientPath, ['/command=shutdown'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child && typeof child.unref === 'function') child.unref();
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: true,
            shutDown: true,
            platformId: 'gog',
            method: 'command_shutdown',
            clientPath,
            ...(gogFlushWait && gogFlushWait.reason !== 'skipped_in_test'
              ? { postExitFlush: gogFlushWait }
              : {}),
          };
        } else if (targetPlatform === 'darwin') {
          const candidateAppOrBin =
            sessionEntry.gogGalaxyClientPath ||
            (!isTestEnvironment(options)
              ? resolveGogGalaxyClientBinaryPath({ ...options, platform: 'darwin' }) ||
                '/Applications/GOG Galaxy.app'
              : '');
          const macGalaxyBin = candidateAppOrBin
            ? candidateAppOrBin.endsWith('.app')
              ? path.join(candidateAppOrBin, 'Contents', 'MacOS', 'GOG Galaxy')
              : candidateAppOrBin
            : '';

          if (macGalaxyBin && fs.existsSync(macGalaxyBin)) {
            const cmdShutdownOk = await new Promise((resolve) => {
              try {
                execFileImpl(
                  macGalaxyBin,
                  ['--command=shutdown'],
                  { timeout: 6000 },
                  (/** @type {any} */ err) => resolve(!err)
                );
              } catch {
                resolve(false);
              }
            });
            if (cmdShutdownOk) {
              if (shouldReapGogOverlay) {
                await reapOrphanedGogOverlayProcesses(options);
              }
              return {
                closed: true,
                shutDown: true,
                platformId: 'gog',
                method: 'command_shutdown',
                clientPath: sessionEntry.gogGalaxyClientPath || null,
                ...(gogFlushWait && gogFlushWait.reason !== 'skipped_in_test'
                  ? { postExitFlush: gogFlushWait }
                  : {}),
              };
            }
          }

          const busyBeforeMacPkill = getBusyOrAbortedReason();
          if (busyBeforeMacPkill) {
            return { closed: false, shutDown: false, reason: busyBeforeMacPkill };
          }

          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'GOG Galaxy'],
              { timeout: 2500 },
              () => resolve(undefined)
            );
          });
          if (shouldReapGogOverlay) {
            await reapOrphanedGogOverlayProcesses(options);
          }
          return {
            closed: true,
            shutDown: true,
            platformId: 'gog',
            method: 'sigterm_quit',
            clientPath: sessionEntry.gogGalaxyClientPath || null,
            ...(gogFlushWait && gogFlushWait.reason !== 'skipped_in_test'
              ? { postExitFlush: gogFlushWait }
              : {}),
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
          if (
            sessionEntry.wokePublisherClientByLauncher === true &&
            resolveAnyChainedHandoffId(sessionEntry.chainedLauncherHandoff) === 'ea' &&
            !getBusyOrAbortedReason()
          ) {
            await new Promise((resolve) => {
              execFileImpl(
                'taskkill.exe',
                [
                  '/F',
                  '/IM',
                  'EADesktop.exe',
                  '/IM',
                  'EALauncher.exe',
                  '/IM',
                  'Link2EA.exe',
                  '/IM',
                  'EACefSubProcess.exe',
                  '/IM',
                  'EALocalHostSvc.exe',
                  '/IM',
                  'EABackgroundService.exe',
                ],
                { timeout: 4000, windowsHide: true },
                () => resolve(undefined)
              );
            });
          }
          return {
            closed: true,
            shutDown: true,
            platformId: 'steam',
            method: 'steam_shutdown_flag',
            binaryPath: steamBin,
            ...(cloudWaitResult ? { cloudSyncWait: cloudWaitResult } : {}),
          };
        } else if (targetPlatform === 'darwin') {
          if (
            typeof options.spawnFn === 'function' &&
            !options.execFileFn &&
            !options.execFileImpl
          ) {
            const child = spawnImpl(
              sessionEntry.steamClientBinaryPath ||
                '/Applications/Steam.app/Contents/MacOS/steam_osx',
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
                  (/** @type {any} */ err) => resolve(!err)
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
              () => resolve(undefined)
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

    if (platformId === 'epic' && sessionEntry.wokeEpicByLauncher === true) {
      const busyBeforeEpicKill = getBusyOrAbortedReason();
      if (busyBeforeEpicKill) {
        return { closed: false, shutDown: false, reason: busyBeforeEpicKill };
      }

      try {
        if (targetPlatform === 'win32') {
          if (
            typeof options.spawnFn === 'function' &&
            !options.execFileFn &&
            !options.execFileImpl
          ) {
            const child = spawnImpl('taskkill.exe', ['/IM', 'EpicGamesLauncher.exe'], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            if (child && typeof child.unref === 'function') child.unref();
          } else {
            await new Promise((resolve) => {
              execFileImpl(
                'taskkill.exe',
                ['/IM', 'EpicGamesLauncher.exe'],
                { timeout: 4000, windowsHide: true },
                () => resolve(undefined)
              );
            });
          }

          if (!isTestEnvironment(options) || options.enableEpicForceKillFallback === true) {
            const waitMs = Math.max(0, Number(options.epicGracefulKillWaitMs ?? 3000));
            if (waitMs > 0) {
              await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                  if (done) return;
                  done = true;
                  clearTimeout(t);
                  abortCtrl.signal.removeEventListener('abort', finish);
                  resolve(undefined);
                };
                const t = setTimeout(finish, waitMs);
                abortCtrl.signal.addEventListener('abort', finish, { once: true });
              });
            }
            if (!getBusyOrAbortedReason()) {
              await new Promise((resolve) => {
                execFileImpl(
                  'taskkill.exe',
                  ['/F', '/IM', 'EpicGamesLauncher.exe'],
                  { timeout: 3000, windowsHide: true },
                  () => resolve(undefined)
                );
              });
            }
          }

          return {
            closed: true,
            shutDown: true,
            platformId: 'epic',
            method: 'taskkill_graceful',
            clientPath: sessionEntry.epicClientPath || null,
          };
        } else if (targetPlatform === 'darwin') {
          if (!isTestEnvironment(options) || options.preferOsascriptQuitOnDarwin === true) {
            const osaOk = await new Promise((resolve) => {
              try {
                execFileImpl(
                  '/usr/bin/osascript',
                  ['-e', 'tell application "Epic Games Launcher" to quit'],
                  { timeout: 4000 },
                  (/** @type {any} */ err) => resolve(!err)
                );
              } catch {
                resolve(false);
              }
            });
            if (osaOk) {
              return {
                closed: true,
                shutDown: true,
                platformId: 'epic',
                method: 'osascript_quit',
                clientPath: sessionEntry.epicClientPath || null,
              };
            }
          }

          const busyBeforeEpicPkill = getBusyOrAbortedReason();
          if (busyBeforeEpicPkill) {
            return { closed: false, shutDown: false, reason: busyBeforeEpicPkill };
          }

          await new Promise((resolve) => {
            execFileImpl(
              '/usr/bin/pkill',
              ['-TERM', '-x', 'EpicGamesLauncher'],
              { timeout: 2500 },
              () => resolve(undefined)
            );
          });
          return {
            closed: true,
            shutDown: true,
            platformId: 'epic',
            method: 'sigterm_quit',
            clientPath: sessionEntry.epicClientPath || null,
          };
        }
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'epic',
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (
      platformId === 'xbox' &&
      sessionEntry.wokeXboxAppByLauncher === true &&
      targetPlatform === 'win32'
    ) {
      const busyBeforeXboxKill = getBusyOrAbortedReason();
      if (busyBeforeXboxKill) {
        return { closed: false, shutDown: false, reason: busyBeforeXboxKill };
      }
      try {
        await new Promise((resolve) => {
          execFileImpl(
            'taskkill.exe',
            ['/IM', 'XboxPcApp.exe'],
            { timeout: 4000, windowsHide: true },
            () => resolve(undefined)
          );
        });
        return {
          closed: true,
          shutDown: true,
          platformId: 'xbox',
          method: 'taskkill_graceful',
          clientPath: sessionEntry.xboxClientPath || null,
        };
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: 'xbox',
          reason: 'shutdown_command_failed',
        };
      }
    }

    const sessionChainedHandoff = resolveAnyChainedHandoffId(
      sessionEntry.chainedLauncherHandoff ||
        sessionEntry.chainedRequiresLauncherHandoff ||
        sessionEntry.chainedHandedOffTo ||
        sessionEntry.steamChainedPublisherHandoff ||
        sessionEntry.platformId
    );
    const wasPublisherWokenByLauncher = Boolean(
      sessionEntry.wokePublisherClientByLauncher === true ||
        sessionEntry.ephemeralClientWoken === true ||
        sessionEntry.wokeBottleSteamPublisherByLauncher === true ||
        (sessionEntry.wasRunningAtLaunch === false && Boolean(sessionChainedHandoff))
    );
    const sessionBottlePath = String(
      sessionEntry.winePrefix || sessionEntry.bottlePath || ''
    ).trim();

    if (
      targetPlatform === 'darwin' &&
      wasPublisherWokenByLauncher &&
      sessionBottlePath &&
      ['ea', 'ubisoft', 'bnet', 'rockstar'].includes(sessionChainedHandoff)
    ) {
      const resolvedBottlePrefix = path.resolve(sessionBottlePath);
      const hasOtherActiveSameBottleSession =
        (pendingBottleLaunches.get(resolvedBottlePrefix) || 0) > 0 ||
        Array.from(activeSessions.values()).some((other) => {
          if (!other || other === sessionEntry || other.finalized) return false;
          const otherPrefix = String(other.winePrefix || other.bottlePath || '').trim();
          return Boolean(otherPrefix && path.resolve(otherPrefix) === resolvedBottlePrefix);
        });
      const hasActivePublisherDownload = Array.from(downloadQueueMap.values()).some(
        (t) =>
          t &&
          (String(t.platformId || '').toLowerCase() === sessionChainedHandoff ||
            resolveAnyChainedHandoffId(t.chainedLauncherHandoff) === sessionChainedHandoff) &&
          (['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
            pausedByInGameTaskIds.has(t.taskId))
      );
      const busyBeforeBottlePubKill = getBusyOrAbortedReason();
      if (
        busyBeforeBottlePubKill ||
        hasOtherActiveSameBottleSession ||
        hasActivePublisherDownload
      ) {
        return {
          closed: false,
          shutDown: false,
          reason:
            busyBeforeBottlePubKill ||
            (hasOtherActiveSameBottleSession
              ? 'other_session_active'
              : 'active_download_in_progress'),
        };
      }

      /** @type {Record<string, string[]>} */
      const bottlePublisherDaemonExesByHandoff = {
        ea: [
          'eadesktop.exe',
          'eabackgroundservice.exe',
          'ealauncher.exe',
          'link2ea.exe',
          'eacefsubprocess.exe',
          'ealocalhostsvc.exe',
        ],
        ubisoft: [
          'upc.exe',
          'ubisoftconnect.exe',
          'ubisoftgamelauncher.exe',
          'ubisoftgamelauncher64.exe',
          'uplaywebcore.exe',
          'uplayservice.exe',
        ],
        bnet: ['battle.net.exe', 'battle.net launcher.exe', 'agent.exe', 'blizzardbrowser.exe'],
        rockstar: [
          'launcher.exe',
          'launcherpatcher.exe',
          'socialclubhelper.exe',
          'rockstarservice.exe',
        ],
      };
      const targetPubExes = bottlePublisherDaemonExesByHandoff[sessionChainedHandoff] || [];
      const bottleNormLower = resolvedBottlePrefix.replace(/\\/g, '/').toLowerCase();
      const killPidImpl =
        typeof options.killPidFn === 'function'
          ? options.killPidFn
          : (/** @type {number} */ pid, /** @type {string} */ sig) => process.kill(pid, sig);

      const readPsOutputAsync = async () => {
        if (typeof options.mockProcessListOutput === 'string') {
          return options.mockProcessListOutput;
        }
        if (typeof options.getProcessListOutput === 'function') {
          return String((await options.getProcessListOutput()) || '');
        }
        return await new Promise((resolve) => {
          try {
            execFileImpl(
              'ps',
              ['eww', '-axo', 'pid=,command='],
              { timeout: 2500 },
              (/** @type {any} */ err, /** @type {any} */ stdout) =>
                resolve(err ? '' : String(stdout || ''))
            );
          } catch {
            resolve('');
          }
        });
      };

      const findMatchingBottlePublisherPids = (/** @type {string} */ psText) => {
        /** @type {number[]} */
        const matched = [];
        for (const rawLine of String(psText || '').split(/\r?\n/)) {
          const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
          if (!m) continue;
          const cPid = Number.parseInt(m[1], 10);
          if (!(cPid > 1) || cPid === process.pid) continue;
          const cmdLower = m[2].replace(/\\/g, '/').toLowerCase();
          if (!cmdLower.includes(bottleNormLower)) continue;
          if (targetPubExes.some((exeName) => cmdLower.includes(exeName))) {
            matched.push(cPid);
          }
        }
        return matched;
      };

      try {
        const initialPs = await readPsOutputAsync();
        const pidsToTerminate = findMatchingBottlePublisherPids(initialPs);
        for (const pid of pidsToTerminate) {
          try {
            killPidImpl(pid, 'SIGTERM');
          } catch {}
        }
        const waitMs = Math.max(
          0,
          Number(options.bottlePublisherGracefulKillWaitMs ?? (isTestEnvironment(options) ? 0 : 800))
        );
        if (waitMs > 0 && pidsToTerminate.length > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, waitMs);
          });
          if (!getBusyOrAbortedReason()) {
            const followUpPs = await readPsOutputAsync();
            for (const stillPid of findMatchingBottlePublisherPids(followUpPs)) {
              try {
                killPidImpl(stillPid, 'SIGKILL');
              } catch {}
            }
          }
        }
        return {
          closed: true,
          shutDown: true,
          platformId: platformId || sessionChainedHandoff,
          chainedLauncherHandoff: sessionChainedHandoff,
          winePrefix: resolvedBottlePrefix,
          terminatedPids: pidsToTerminate,
          method: 'bottle_publisher_sigterm',
        };
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: platformId || sessionChainedHandoff,
          reason: 'shutdown_command_failed',
        };
      }
    }

    if (
      sessionChainedHandoff === 'ea' &&
      wasPublisherWokenByLauncher &&
      targetPlatform === 'win32'
    ) {
      const hasOtherActiveEaSession = Array.from(activeSessions.values()).some(
        (other) =>
          other !== sessionEntry &&
          !other.finalized &&
          resolveAnyChainedHandoffId(other.chainedLauncherHandoff) === 'ea'
      );
      const hasActiveEaDownload = Array.from(downloadQueueMap.values()).some(
        (t) =>
          t &&
          (String(t.platformId || '').toLowerCase() === 'ea' ||
            resolveAnyChainedHandoffId(t.chainedLauncherHandoff) === 'ea') &&
          (['downloading', 'queued', 'extracting', 'verifying'].includes(t.status) ||
            pausedByInGameTaskIds.has(t.taskId))
      );
      const busyBeforeEaKill = getBusyOrAbortedReason();
      if (busyBeforeEaKill || hasOtherActiveEaSession || hasActiveEaDownload) {
        return {
          closed: false,
          shutDown: false,
          reason: busyBeforeEaKill || (hasOtherActiveEaSession ? 'other_session_active' : 'active_download_in_progress'),
        };
      }
      try {
        await new Promise((resolve) => {
          execFileImpl(
            'taskkill.exe',
            ['/IM', 'EADesktop.exe'],
            { timeout: 3000, windowsHide: true },
            () => resolve(undefined)
          );
        });
        const eaWaitMs = Math.max(
          0,
          Number(options.eaGracefulKillWaitMs ?? (isTestEnvironment(options) ? 0 : 1500))
        );
        if (eaWaitMs > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, eaWaitMs);
            if (typeof t.unref === 'function') t.unref();
          });
        }
        if (!getBusyOrAbortedReason()) {
          await new Promise((resolve) => {
            execFileImpl(
              'taskkill.exe',
              [
                '/F',
                '/IM',
                'EADesktop.exe',
                '/IM',
                'EALauncher.exe',
                '/IM',
                'Link2EA.exe',
                '/IM',
                'EACefSubProcess.exe',
                '/IM',
                'EALocalHostSvc.exe',
                '/IM',
                'EABackgroundService.exe',
              ],
              { timeout: 4000, windowsHide: true },
              () => resolve(undefined)
            );
          });
        }
        return {
          closed: true,
          shutDown: true,
          platformId: platformId || 'ea',
          chainedLauncherHandoff: 'ea',
          method: 'taskkill_graceful',
        };
      } catch {
        return {
          closed: false,
          shutDown: false,
          platformId: platformId || 'ea',
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
 * Sync completed game session playtime to first-party storefront cloud APIs (Epic, GOG, Xbox)
 */
async function syncSessionPlaytimeToStorefront(
  /** @type {any} */ sessionInfo = {},
  /** @type {any} */ options = {}
) {
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

  const activeStoreSync = options.storeSync || getStoreSync();
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

    const executePut = (/** @type {string} */ token) =>
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
        (/** @type {any} */ item) =>
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
    const rawGogId = String(sessionInfo.platformGameId || sessionInfo.gameId || '')
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

    const executePost = (/** @type {string} */ token) =>
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

  if (platformId === 'xbox') {
    try {
      let titleId = String(sessionInfo.xboxTitleId || '').trim();
      if (!titleId && sessionInfo.installPath) {
        const cfg = inspectMicrosoftGameConfig(sessionInfo.installPath);
        if (cfg) {
          titleId = cfg.titleIdDecimal || cfg.titleId || '';
        }
      }
      let titleIdDecimal = titleId;
      if (
        titleId &&
        !/^\d+$/.test(titleId) &&
        /^[0-9a-fA-F]{1,8}$/.test(titleId.replace(/^0x/i, ''))
      ) {
        titleIdDecimal = String(parseInt(titleId.replace(/^0x/i, ''), 16));
      }

      const authProvider =
        options.xboxAuthProvider ||
        (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
          ? activeStoreSync.getXboxAuthProvider({
              userDataDir: getUserDataDir(options.userDataDir),
            })
          : null);
      const session =
        options.xboxSession ||
        (authProvider && typeof authProvider.getValidXboxSession === 'function'
          ? await authProvider.getValidXboxSession().catch(() => null)
          : null);

      const xboxMods = getXboxStorefrontModules();
      if (
        !titleIdDecimal ||
        !session ||
        !session.xuid ||
        !session.authorizationHeader ||
        !xboxMods?.xboxAchievementsAndStats?.fetchXboxPlaytimeBatch
      ) {
        return {
          synced: false,
          platformId: 'xbox',
          reason: !titleIdDecimal ? 'missing_title_id' : 'missing_xbox_auth',
          storefrontTotalPlaytimeMinutes: null,
        };
      }

      const playtimeMap = await xboxMods.xboxAchievementsAndStats.fetchXboxPlaytimeBatch({
        xuid: session.xuid,
        authorizationHeader: session.authorizationHeader,
        titleIds: [titleIdDecimal],
        fetchImpl: options.fetchImpl,
      });
      const remoteMinutes = Number(
        (playtimeMap instanceof Map ? playtimeMap.get(titleIdDecimal) : 0) || 0
      );
      return {
        synced: true,
        platformId: 'xbox',
        storefrontTotalPlaytimeMinutes: Math.max(sessionMinutesPlayed, remoteMinutes),
      };
    } catch (/** @type {any} */ err) {
      return {
        synced: false,
        platformId: 'xbox',
        reason: err?.message || 'xbox_playtime_sync_failed',
        storefrontTotalPlaytimeMinutes: null,
      };
    }
  }

  return {
    synced: false,
    platformId,
    reason: 'unsupported_platform',
    storefrontTotalPlaytimeMinutes: null,
  };
}

async function verifyGameFiles(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
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
          /** @type {any} */
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
                (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                  const combined = `${stdout || ''}\n${stderr || ''}`;
                  resolve({ err, combined });
                }
              );
            } catch (/** @type {any} */ err) {
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
          const gogLocale = resolveHostLocaleInfo(options).gogLocale || 'en-US';
          /** @type {any} */
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
                  gogLocale,
                ],
                {
                  env: { ...process.env, PYTHONUNBUFFERED: '1' },
                  timeout: 120000,
                },
                (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                  resolve({ err, combined: `${stdout || ''}\n${stderr || ''}` });
                }
              );
            } catch (/** @type {any} */ err) {
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
      } else if (platformId === 'xbox') {
        const gameCfg = inspectMicrosoftGameConfig(localInstall);
        const appxCfg = !gameCfg ? inspectAppxManifest(localInstall) : null;
        const resolvedPfn =
          payload.packageFamilyName ||
          gameCfg?.packageFamilyName ||
          appxCfg?.packageFamilyName ||
          '';
        const resolvedIdentityName =
          gameCfg?.identityName || appxCfg?.identityName || '';
        const hasClientlessReceipt = hasXboxClientlessReceipt(localInstall);

        if (targetPlatform === 'win32' && resolvedPfn && !hasClientlessReceipt && canRunCliRepair) {
          const appxCheck = await queryTargetedAppxPackageAsync(
            { identityName: resolvedIdentityName, packageFamilyName: resolvedPfn },
            { ...options, execFileImpl }
          );
          if (appxCheck.found && appxCheck.pkg && appxCheck.pkg.Status) {
            const st = appxCheck.pkg.Status;
            const isBadStringStatus =
              typeof st === 'string' && st.trim() !== '' && !/^(?:ok|normal|healthy|0)$/i.test(st.trim());
            const isBadObjStatus =
              typeof st === 'object' &&
              st !== null &&
              (st.Invalid === true ||
                st.Tampered === true ||
                st.Modified === true ||
                st.LicenseIssue === true ||
                st.DataOffline === true ||
                st.DependencyIssue === true);
            if (isBadStringStatus || isBadObjStatus) {
              return {
                success: false,
                error: `Xbox Appx package ${resolvedPfn} reported unhealthy status (${typeof st === 'string' ? st : JSON.stringify(st)}). Please repair via Xbox App or reinstall.`,
                installPath: localInstall,
              };
            }
          }
        }

        if (gameCfg?.isExternalLauncherStub) {
          return {
            success: false,
            error: `Xbox package at ${localInstall} is an external publisher launcher stub (GDKStubGame.exe) and does not contain game files.`,
            installPath: localInstall,
          };
        }

        const primaryExe =
          (gameCfg?.primaryExecutable
            ? path.join(
                gameCfg.configDir || localInstall,
                gameCfg.primaryExecutable.replace(/\\/g, path.sep)
              )
            : '') ||
          findPrimaryExecutable(localInstall, {
            platform: targetPlatform,
            hintName: title,
            preferWindowsExecutable: true,
          }).executablePath;

        if (!primaryExe || isGdkStubExecutablePath(primaryExe) || !fs.existsSync(primaryExe)) {
          return {
            success: false,
            error: `Primary Xbox game executable not found in ${localInstall}.`,
            installPath: localInstall,
          };
        }

        const bottleRoot = extractBottleRootFromPath(localInstall);
        let repairedWinAppxRegistered = false;
        if (targetPlatform === 'darwin' && bottleRoot && resolvedPfn) {
          try {
            await prepareXboxBottleEnvironment({
              bottlePath: bottleRoot,
              env: {},
              packageFamilyName: resolvedPfn,
              installDir: localInstall,
              executablePath: primaryExe,
              scid: gameCfg?.scid || undefined,
              xboxBridgeDllPath: options.xboxBridgeDllPath,
              gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              xboxAppNotifyBridgeDllPath: options.xboxAppNotifyBridgeDllPath,
            });
          } catch {}
        } else if (targetPlatform === 'win32' && hasClientlessReceipt) {
          try {
            if (options.forceClientlessXboxOnWin32 !== true) {
              const appxRegCheck = await ensureWindowsXboxAppxRegisteredAsync(
                {
                  installDir: localInstall,
                  identityName: resolvedIdentityName,
                  packageFamilyName: resolvedPfn,
                },
                { ...options, execFileImpl }
              );
              if (appxRegCheck.gamingServicesInstalled && appxRegCheck.registered) {
                repairedWinAppxRegistered = true;
                await restoreWindowsClientlessXboxBridgeDlls(localInstall);
              }
            }
            if (!repairedWinAppxRegistered) {
              await stageWindowsClientlessXboxBridgeDlls({
                installDir: localInstall,
                executablePath: primaryExe,
                xboxBridgeDllPath: options.xboxBridgeDllPath,
                gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              });
            }
          } catch {}
        }

        return {
          success: true,
          runner:
            targetPlatform === 'darwin'
              ? 'xbox_xgr'
              : hasClientlessReceipt && !repairedWinAppxRegistered
                ? 'xbox_direct'
                : 'xbox',
          message: `Verified Xbox GDK installation integrity (${path.basename(primaryExe)} ready).`,
          installPath: localInstall,
          executablePath: primaryExe,
        };
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
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function uninstallGame(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  try {
    const {
      gameId,
      title,
      platformId,
      platformGameId,
      steamAppId,
      installPath,
      allowDeleteFiles,
    } = payload;
    const platform = options.platform || process.platform;
    const userDataDir = getUserDataDir(options.userDataDir);

    const cleanId = String(platformGameId || gameId || '')
      .replace(/^(epic|gog|steam|xbox|ubisoft|ea|bnet|rockstar|riot)[-_:]/i, '')
      .trim();
    const appId = String(steamAppId || platformGameId || cleanId)
      .replace(/^steam[-_]/i, '')
      .trim();
    let localInstall = installPath ? toLocalFsPath(installPath) : '';
    const isBottlePath = (/** @type {any} */ p) =>
      /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(String(p || ''));

    const managed = loadManagedInstalledGames(userDataDir);
    const matchedManagedRecord = managed.find(
      (/** @type {any} */ r) =>
        (r.platformId === platformId &&
          ((platformGameId &&
            r.platformGameId &&
            String(r.platformGameId) === String(platformGameId)) ||
            (cleanId && r.platformGameId && String(r.platformGameId) === cleanId) ||
            (appId && r.platformGameId && String(r.platformGameId) === appId))) ||
        (installPath && r.installPath === installPath) ||
        (localInstall && r.installPath && path.resolve(r.installPath) === path.resolve(localInstall))
    );
    if (!localInstall && matchedManagedRecord?.installPath) {
      localInstall = toLocalFsPath(matchedManagedRecord.installPath);
    }
    const normUninstallPlatformId = String(platformId || '')
      .trim()
      .toLowerCase();
    const standalonePublisherPlatform = ['ubisoft', 'ea', 'bnet', 'rockstar', 'riot'].includes(
      normUninstallPlatformId
    )
      ? normUninstallPlatformId
      : '';
    /** @type {any} */
    let eaInstallerXmlMeta = null;
    if (localInstall && fs.existsSync(localInstall)) {
      const candidateEaInstallerXml = path.join(localInstall, '__Installer', 'installerdata.xml');
      if (fs.existsSync(candidateEaInstallerXml)) {
        try {
          const rawXml = fs.readFileSync(candidateEaInstallerXml, 'utf8');
          const parsedSteamXml = /** @type {any} */ (parseSteamEaInstallerDataXml(rawXml));
          const parsedPublisherXml =
            typeof chainedPublisherLaunchers.parseEaInstallerDataXml === 'function'
              ? chainedPublisherLaunchers.parseEaInstallerDataXml(rawXml, localInstall)
              : null;
          const mergedContentIds = Array.from(
            new Set([
              ...(Array.isArray(parsedSteamXml?.contentIds) ? parsedSteamXml.contentIds : []),
              ...(parsedSteamXml?.contentId ? [parsedSteamXml.contentId] : []),
              ...(Array.isArray(parsedPublisherXml?.contentIds) ? parsedPublisherXml.contentIds : []),
              ...(parsedPublisherXml?.contentId ? [parsedPublisherXml.contentId] : []),
            ])
          ).filter(Boolean);
          if (parsedSteamXml || (parsedPublisherXml && mergedContentIds.length > 0)) {
            eaInstallerXmlMeta = {
              ...(parsedSteamXml || {}),
              isEaChained: true,
              isEaInstaller: true,
              contentId: mergedContentIds[0] || undefined,
              contentIds: mergedContentIds,
            };
          }
        } catch {}
      }
    }
    const chainedHandoff =
      resolveAnyChainedHandoffId(
        payload.chainedLauncherHandoff ||
          payload.chainedRequiresLauncherHandoff ||
          payload.externalStorefrontHandoff ||
          matchedManagedRecord?.chainedLauncherHandoff ||
          matchedManagedRecord?.chainedRequiresLauncherHandoff ||
          matchedManagedRecord?.externalStorefrontHandoff ||
          standalonePublisherPlatform
      ) || (eaInstallerXmlMeta?.isEaInstaller ? 'ea' : '');
    const externalInstallId = String(
      payload.chainedExternalInstallId ||
        matchedManagedRecord?.chainedExternalInstallId ||
        eaInstallerXmlMeta?.contentIds?.[0] ||
        ''
    ).trim();
    let gogSplitParentDir = '';

    if (platformId === 'epic') {
      const resolvedAppNames = new Set();
      const resolvedCatalogItemIds = new Set();
      let resolvedInstallFromLeg = '';
      if (cleanId) {
        resolvedAppNames.add(cleanId);
        resolvedCatalogItemIds.add(cleanId);
      }
      if (platformGameId) {
        resolvedAppNames.add(String(platformGameId));
      }

      const homedir = options.homedir || os.homedir();
      const legendaryDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary'),
        path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
        path.join(homedir, '.config/legendary'),
        path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary'),
      ];

      for (const legDir of legendaryDirs) {
        const assetsFile = path.join(legDir, 'assets.json');
        if (fs.existsSync(assetsFile)) {
          try {
            const rawAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
            const lists = Array.isArray(rawAssets)
              ? [rawAssets]
              : rawAssets && typeof rawAssets === 'object'
                ? Object.values(rawAssets).filter(Array.isArray)
                : [];
            for (const list of lists) {
              for (const asset of list) {
                if (!asset || typeof asset !== 'object') continue;
                const aName = String(asset.app_name || asset.appName || '').trim();
                const cId = String(asset.catalog_item_id || asset.catalogItemId || '').trim();
                if (
                  (cleanId &&
                    (aName.toLowerCase() === cleanId.toLowerCase() ||
                      cId.toLowerCase() === cleanId.toLowerCase())) ||
                  (aName && resolvedAppNames.has(aName)) ||
                  (cId && resolvedCatalogItemIds.has(cId))
                ) {
                  if (aName) resolvedAppNames.add(aName);
                  if (cId) resolvedCatalogItemIds.add(cId);
                }
              }
            }
          } catch {}
        }

        const instFile = path.join(legDir, 'installed.json');
        if (fs.existsSync(instFile)) {
          const isManagedLegFile =
            path.resolve(instFile) ===
            path.resolve(path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json'));
          try {
            const rawLeg = JSON.parse(fs.readFileSync(instFile, 'utf8'));
            if (rawLeg && typeof rawLeg === 'object' && !Array.isArray(rawLeg)) {
              let changed = false;
              for (const [k, val] of Object.entries(rawLeg)) {
                const v = /** @type {any} */ (val);
                const vApp = String(v?.app_name || v?.appName || k || '').trim();
                const vCat = String(v?.catalog_item_id || v?.catalogItemId || '').trim();
                const vInstallRaw = v?.install_path || v?.installPath || '';
                const vInstallLocal = vInstallRaw ? toLocalFsPath(vInstallRaw) : '';
                const matchesPath = Boolean(
                  (installPath && vInstallRaw === installPath) ||
                    (localInstall &&
                      vInstallLocal &&
                      path.resolve(vInstallLocal) === path.resolve(localInstall))
                );
                const matchesIds = Boolean(
                  resolvedAppNames.has(k) ||
                    resolvedAppNames.has(vApp) ||
                    (cleanId &&
                      (k.toLowerCase() === cleanId.toLowerCase() ||
                        vApp.toLowerCase() === cleanId.toLowerCase() ||
                        vCat.toLowerCase() === cleanId.toLowerCase())) ||
                    (vCat && resolvedCatalogItemIds.has(vCat))
                );
                if (matchesIds || matchesPath) {
                  if (k) resolvedAppNames.add(k);
                  if (vApp) resolvedAppNames.add(vApp);
                  if (vCat) resolvedCatalogItemIds.add(vCat);
                  if (!resolvedInstallFromLeg && vInstallLocal) {
                    resolvedInstallFromLeg = vInstallLocal;
                  }
                  if (isManagedLegFile) {
                    delete rawLeg[k];
                    changed = true;
                  }
                }
              }
              if (isManagedLegFile && changed) {
                atomicWriteFileSync(instFile, JSON.stringify(rawLeg, null, 2));
              }
            }
          } catch (legErr) {
            if (isManagedLegFile) {
              diagLog.warn('uninstallGame.legendaryInstalledCleanup', legErr, {
                gameId,
                platformGameId,
              });
            }
          }
        }
      }

      try {
        unregisterEpicFirstPartyLauncher(
          cleanId || platformGameId,
          installPath || resolvedInstallFromLeg,
          {
            ...options,
            catalogItemId: cleanId,
            resolvedAppNames: Array.from(resolvedAppNames),
            resolvedCatalogItemIds: Array.from(resolvedCatalogItemIds),
          }
        );
      } catch {}
    } else if (platformId === 'gog') {
      if (localInstall) {
        try {
          const parentCandidate = path.dirname(localInstall);
          if (
            parentCandidate &&
            path.resolve(parentCandidate) !== path.resolve(localInstall) &&
            fs.existsSync(parentCandidate) &&
            isSafeToDeleteInstallPath(parentCandidate, options) &&
            !/^(?:gog|gog\.com|gog galaxy|gog games|games|onelauncher|onelauncher games|applications|bottles|drive_c)$/i.test(
              path.basename(parentCandidate).trim()
            )
          ) {
            const parentSentinel = readManagedInstallSentinel(parentCandidate);
            const sentinelGameId = String(parentSentinel?.gameId || '')
              .replace(/^gog[-_]/i, '')
              .trim();
            const matchesSentinel =
              String(parentSentinel?.store || '').toLowerCase() === 'gog' &&
              Boolean(
                (cleanId && sentinelGameId === cleanId) ||
                  (platformGameId &&
                    String(parentSentinel?.gameId || '') === String(platformGameId))
              );
            const matchesGogInfo = Boolean(
              cleanId &&
                (fs.existsSync(path.join(parentCandidate, `goggame-${cleanId}.info`)) ||
                  fs.existsSync(path.join(parentCandidate, `.goggame-${cleanId}.info`)))
            );
            if (matchesSentinel || matchesGogInfo) {
              gogSplitParentDir = parentCandidate;
            }
          }
        } catch {}
      }

      try {
        const unregRes = unregisterGogFirstPartyLauncher(
          cleanId || platformGameId,
          installPath,
          options
        );
        if (unregRes && unregRes.registryDeletePromise) {
          await unregRes.registryDeletePromise.catch(() => {});
        }
        if (gogSplitParentDir) {
          const unregParentRes = unregisterGogFirstPartyLauncher(
            cleanId || platformGameId,
            gogSplitParentDir,
            options
          );
          if (unregParentRes && unregParentRes.registryDeletePromise) {
            await unregParentRes.registryDeletePromise.catch(() => {});
          }
        }
      } catch {}
      try {
        clearStaleGogdlManifestCache(cleanId || platformGameId, options);
      } catch {}
    } else if (platformId === 'steam' && appId) {
      let isBottleInstall = isBottlePath(localInstall);
      let removedLocalSteamFiles = false;
      let acfName = '';
      const discoveredBottleDirs = new Set();
      const hasValidNumericSteamId = safeIsNumericAppId(appId);

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

      if (hasValidNumericSteamId) {
        for (const steamappsDir of candidateSteamappsDirs) {
          if (!steamappsDir || !fs.existsSync(steamappsDir)) continue;
          const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
          if (fs.existsSync(acfPath)) {
            /** @type {any} */
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

            const installdir =
              parsedAcf && parsedAcf.installdir ? String(parsedAcf.installdir) : '';
            if (
              installdir &&
              !/[\\/\x00]/.test(installdir) &&
              installdir !== '.' &&
              installdir !== '..' &&
              !installdir.includes('..')
            ) {
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
      }

      if (
        localInstall &&
        fs.existsSync(localInstall) &&
        isSafeToDeleteInstallPath(localInstall, options)
      ) {
        if (isBottlePath(localInstall)) {
          isBottleInstall = true;
        }
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
          removedLocalSteamFiles = true;
        } catch {}
      }

      if ((isBottleInstall || platform === 'darwin') && hasValidNumericSteamId) {
        try {
          cleanupCrossOverSteamShortcuts(
            appId,
            title || acfName,
            Array.from(discoveredBottleDirs),
            options
          );
        } catch {}
      }

      if (!isBottleInstall && !removedLocalSteamFiles && !allowDeleteFiles && hasValidNumericSteamId) {
        await openExternalUri(`steam://uninstall/${appId}`, options);
      }
    } else if (platformId === 'xbox') {
      const hasClientlessReceipt = hasXboxClientlessReceipt(localInstall);
      const isClientlessOrBottle =
        platform === 'darwin' || hasClientlessReceipt || isBottlePath(localInstall);

      let resolvedPfn = String(
        payload.packageFamilyName || matchedManagedRecord?.packageFamilyName || ''
      ).trim();
      let resolvedIdentityName = '';
      if (localInstall && fs.existsSync(localInstall)) {
        const gameCfg = inspectMicrosoftGameConfig(localInstall);
        const appxCfg = !gameCfg ? inspectAppxManifest(localInstall) : null;
        if (!resolvedPfn) {
          resolvedPfn = String(
            gameCfg?.packageFamilyName || appxCfg?.packageFamilyName || ''
          ).trim();
        }
        resolvedIdentityName = String(
          gameCfg?.identityName || appxCfg?.identityName || ''
        ).trim();
      }

      if (platform === 'win32' && !isClientlessOrBottle && resolvedPfn) {
        const appxRemoveRes = await removeTargetedAppxPackageVerifiedAsync(
          { identityName: resolvedIdentityName, packageFamilyName: resolvedPfn },
          options
        );
        if (!appxRemoveRes.removed && appxRemoveRes.stillInstalled && !chainedHandoff) {
          diagLog.warn('uninstallGame.xboxRemoveAppxPackageStillInstalled', appxRemoveRes.error, {
            gameId,
            resolvedPfn,
          });
          return {
            success: false,
            error:
              appxRemoveRes.error ||
              `Failed to remove Xbox Appx package ${resolvedPfn}. The package is still installed.`,
            installPath,
          };
        }
      } else if (
        isClientlessOrBottle &&
        !chainedHandoff &&
        localInstall &&
        fs.existsSync(localInstall) &&
        isSafeToDeleteInstallPath(localInstall, options)
      ) {
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
        } catch (rmErr) {
          diagLog.warn('uninstallGame.xboxRemoveDir', rmErr, { localInstall });
        }
      }
    }

    // Chained Publisher Launcher cleanup (macOS Wine bottle + Windows native)
    let chainedBottleRoot = '';
    if (chainedHandoff) {
      if (platform === 'darwin' || isBottlePath(localInstall)) {
        chainedBottleRoot = localInstall ? extractBottleRootFromPath(localInstall) : '';
        if (!chainedBottleRoot && matchedManagedRecord?.wineBottle) {
          try {
            const layers = detectCompatibilityLayers(options);
            for (const layer of layers) {
              if (!layer?.bottlesDir || !fs.existsSync(layer.bottlesDir)) continue;
              const candidateBottle = path.join(
                layer.bottlesDir,
                String(matchedManagedRecord.wineBottle)
              );
              if (fs.existsSync(candidateBottle)) {
                chainedBottleRoot = candidateBottle;
                break;
              }
            }
          } catch {}
        }

        if (allowDeleteFiles !== false) {
          if (
            chainedBottleRoot &&
            localInstall &&
            fs.existsSync(localInstall) &&
            isSafeBottleChainedGameDirToDelete(chainedBottleRoot, localInstall)
          ) {
            try {
              fs.rmSync(localInstall, { recursive: true, force: true });
            } catch (rmBottleGameErr) {
              diagLog.warn('uninstallGame.chainedBottleRemoveDir', rmBottleGameErr, {
                localInstall,
                chainedBottleRoot,
              });
            }
          } else if (
            !isBottlePath(localInstall) &&
            localInstall &&
            (localInstall.includes('OneLauncher') || localInstall.includes('one-launcher')) &&
            fs.existsSync(localInstall) &&
            isSafeToDeleteInstallPath(localInstall, options)
          ) {
            try {
              fs.rmSync(localInstall, { recursive: true, force: true });
            } catch {}
          }
        }

        if (
          chainedBottleRoot &&
          typeof chainedPublisherLaunchers.stripPublisherUninstallKeysFromSystemReg === 'function'
        ) {
          try {
            chainedPublisherLaunchers.stripPublisherUninstallKeysFromSystemReg(
              chainedBottleRoot,
              localInstall,
              chainedHandoff
            );
          } catch (stripRegErr) {
            diagLog.warn('uninstallGame.stripPublisherUninstallKeysFromSystemReg', stripRegErr, {
              chainedBottleRoot,
              chainedHandoff,
            });
          }
        }

        if (chainedBottleRoot && chainedHandoff === 'ubisoft') {
          if (externalInstallId && /^[A-Za-z0-9_-]+$/.test(externalInstallId)) {
            try {
              deleteWineSystemRegKey(
                chainedBottleRoot,
                `Software\\Wow6432Node\\Ubisoft\\Launcher\\Installs\\${externalInstallId}`,
                options
              );
              deleteWineSystemRegKey(
                chainedBottleRoot,
                `Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install ${externalInstallId}`,
                options
              );
            } catch (regCleanErr) {
              diagLog.warn('uninstallGame.chainedUbisoftRegCleanup', regCleanErr, {
                chainedBottleRoot,
                externalInstallId,
              });
            }
          }
        } else if (chainedBottleRoot && chainedHandoff === 'ea') {
          cleanupBottleEaGameRegistryAndDaemons(
            chainedBottleRoot,
            localInstall,
            {
              externalInstallId,
              eaInstallerXmlMeta,
              epicPartnerRegistryPath:
                payload.epicPartnerRegistryPath || matchedManagedRecord?.epicPartnerRegistryPath,
            },
            options
          );
        } else if (
          chainedBottleRoot &&
          localInstall &&
          (chainedHandoff === 'bnet' || chainedHandoff === 'rockstar')
        ) {
          // Fallback `system.reg` Uninstall / Rockstar Installs key cleanup matching `localInstall`
          const sysRegFile = path.join(chainedBottleRoot, 'system.reg');
          if (fs.existsSync(sysRegFile)) {
            try {
              const resolvedLocalTarget = path.resolve(localInstall);
              const regLines = fs.readFileSync(sysRegFile, 'utf8').split(/\r?\n/);
              /** @type {Set<string>} */
              const subkeysToDelete = new Set();
              let curSectionKey = '';
              /** @type {string[]} */
              let curSectionDirs = [];
              const flushBottlePubSection = () => {
                if (!curSectionKey || curSectionDirs.length === 0) return;
                const keyLower = curSectionKey.toLowerCase();
                const isUninstallOrRockstarSubkey =
                  /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/.test(
                    keyLower
                  ) ||
                  /^software\\(?:wow6432node\\)?rockstar games\\[^\\]+$/.test(keyLower);
                if (!isUninstallOrRockstarSubkey) return;
                if (/\\(?:rockstar games\\launcher|social club)(?:\\|$)/i.test(keyLower)) return;
                for (const rawRegDir of curSectionDirs) {
                  const candidatePosix = wineRegistryInstallDirToPosix(chainedBottleRoot, rawRegDir);
                  if (candidatePosix && candidatePosix === resolvedLocalTarget) {
                    subkeysToDelete.add(curSectionKey);
                    break;
                  }
                }
              };
              for (const line of regLines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('[') && trimmed.includes(']')) {
                  flushBottlePubSection();
                  curSectionKey = trimmed.slice(1, trimmed.indexOf(']')).replace(/\\\\+/g, '\\');
                  curSectionDirs = [];
                  continue;
                }
                if (!curSectionKey) continue;
                const dirMatch = trimmed.match(
                  /^"(?:InstallLocation|InstallFolder|Install Dir)"\s*=\s*"((?:[^"\\]|\\.)*)"/i
                );
                if (dirMatch && dirMatch[1]) {
                  curSectionDirs.push(dirMatch[1]);
                }
              }
              flushBottlePubSection();
              for (const subkey of subkeysToDelete) {
                try {
                  deleteWineSystemRegKey(chainedBottleRoot, subkey, options);
                } catch {}
              }
            } catch {}
          }
        }
      } else if (platform === 'win32') {
        const hadWinLocalInstallOnDisk = Boolean(localInstall && fs.existsSync(localInstall));
        const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
        const spawnImpl = options.spawnImpl || options.spawnFn || spawn;
        const canQueryWinReg = !isTestEnvironment(options) || execFileImpl !== execFile;

        /**
         * Parse a Windows `UninstallString` / `QuietUninstallString` into `{ exe, args, uri }`.
         * @param {string} rawCmd
         */
        const parseWindowsUninstallCommand = (rawCmd) => {
          const trimmed = String(rawCmd || '').trim();
          if (!trimmed) return null;
          const uriMatch = trimmed.match(/\b(uplay:\/\/uninstall\/[A-Za-z0-9_-]+)/i);
          if (/^uplay:\/\/uninstall\//i.test(trimmed)) {
            return { exe: '', args: /** @type {string[]} */ ([]), uri: trimmed };
          }
          let exe = '';
          let rest = '';
          if (trimmed.startsWith('"')) {
            const endQuote = trimmed.indexOf('"', 1);
            if (endQuote > 1) {
              exe = trimmed.slice(1, endQuote).trim();
              rest = trimmed.slice(endQuote + 1).trim();
            }
          } else {
            const exeMatch = trimmed.match(/^([^\s]+\.exe)(?:\s+(.*))?$/i);
            if (exeMatch) {
              exe = exeMatch[1].trim();
              rest = String(exeMatch[2] || '').trim();
            }
          }
          if (!exe && uriMatch) {
            return { exe: '', args: /** @type {string[]} */ ([]), uri: uriMatch[1] };
          }
          if (!exe) return null;
          /** @type {string[]} */
          const parsedArgs = [];
          const argTokenRe = /"([^"]*)"|([^\s]+)/g;
          let tok;
          while ((tok = argTokenRe.exec(rest)) !== null) {
            parsedArgs.push(tok[1] !== undefined ? tok[1] : tok[2]);
          }
          return { exe, args: parsedArgs, uri: '' };
        };

        let resolvedWinUninstallSpec = null;
        if (canQueryWinReg && (localInstall || externalInstallId)) {
          const normTargetWin = localInstall
            ? toHostFilesystemPath(localInstall)
                .replace(/\//g, '\\')
                .replace(/\\+$/, '')
                .toLowerCase()
            : '';
          /** @type {string[]} */
          const uninstallQueryRoots = [];
          if (externalInstallId && /^[A-Za-z0-9._-]+$/.test(externalInstallId)) {
            if (chainedHandoff === 'ubisoft') {
              uninstallQueryRoots.push(
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install ${externalInstallId}`,
                `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install ${externalInstallId}`
              );
            } else if (chainedHandoff === 'ea') {
              uninstallQueryRoots.push(
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${externalInstallId}}`,
                `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${externalInstallId}}`
              );
            } else if (chainedHandoff === 'riot') {
              uninstallQueryRoots.push(
                `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Riot Game ${externalInstallId}.live`,
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Riot Game ${externalInstallId}.live`
              );
            } else {
              uninstallQueryRoots.push(
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${externalInstallId}`,
                `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${externalInstallId}`,
                `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${externalInstallId}`
              );
            }
          }
          if (normTargetWin && allowDeleteFiles !== true) {
            uninstallQueryRoots.push(
              'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
              'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
              'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
            );
          }

          for (const qKey of uninstallQueryRoots) {
            const isTreeScan = /\\Uninstall$/i.test(qKey);
            const regOut = await new Promise((resolve) => {
              try {
                execFileImpl(
                  'reg.exe',
                  isTreeScan ? ['query', qKey, '/s'] : ['query', qKey],
                  { timeout: 3500, windowsHide: true },
                  (/** @type {any} */ err, /** @type {any} */ stdout) =>
                    resolve(err ? '' : String(stdout || ''))
                );
              } catch {
                resolve('');
              }
            });
            if (!regOut) continue;
            let secKey = '';
            let secInstallLoc = '';
            let secQuietCmd = '';
            let secUninstCmd = '';
            const checkSecMatch = () => {
              const rawChosen = secQuietCmd || secUninstCmd;
              if (!rawChosen) return false;
              if (!isTreeScan && !normTargetWin) {
                resolvedWinUninstallSpec = parseWindowsUninstallCommand(rawChosen);
                return Boolean(resolvedWinUninstallSpec);
              }
              if (normTargetWin && secInstallLoc) {
                const candNorm = toHostFilesystemPath(secInstallLoc)
                  .replace(/\//g, '\\')
                  .replace(/\\+$/, '')
                  .toLowerCase();
                if (candNorm === normTargetWin) {
                  resolvedWinUninstallSpec = parseWindowsUninstallCommand(rawChosen);
                  return Boolean(resolvedWinUninstallSpec);
                }
              }
              return false;
            };
            for (const rawLine of regOut.split(/\r?\n/)) {
              const trimmed = rawLine.trim();
              if (/^HKEY_/i.test(trimmed)) {
                if (secKey && checkSecMatch()) break;
                secKey = trimmed;
                secInstallLoc = '';
                secQuietCmd = '';
                secUninstCmd = '';
                continue;
              }
              if (!secKey) continue;
              const locM = trimmed.match(
                /^(?:InstallLocation|InstallFolder|Install Dir)\s+REG_[A-Z0-9_]+\s+(.+)$/i
              );
              if (locM && locM[1]) secInstallLoc = locM[1].trim();
              const quietM = trimmed.match(/^QuietUninstallString\s+REG_[A-Z0-9_]+\s+(.+)$/i);
              if (quietM && quietM[1]) secQuietCmd = quietM[1].trim();
              const unM = trimmed.match(/^UninstallString\s+REG_[A-Z0-9_]+\s+(.+)$/i);
              if (unM && unM[1]) secUninstCmd = unM[1].trim();
            }
            if (!resolvedWinUninstallSpec && secKey) {
              checkSecMatch();
            }
            if (resolvedWinUninstallSpec) break;
          }
        }

        // Publisher-specific fallback CLI / URI / record uninstallers when registry UninstallString is absent
        if (!resolvedWinUninstallSpec && allowDeleteFiles !== true) {
          const explicitUninstallCmd = String(
            payload.uninstallCommand || matchedManagedRecord?.uninstallCommand || ''
          ).trim();
          if (explicitUninstallCmd) {
            resolvedWinUninstallSpec = parseWindowsUninstallCommand(explicitUninstallCmd);
          }
          if (!resolvedWinUninstallSpec && localInstall && chainedHandoff === 'rockstar') {
            const localUninstExe = path.join(localInstall, 'uninstall.exe');
            if (fs.existsSync(localUninstExe)) {
              resolvedWinUninstallSpec = { exe: localUninstExe, args: [], uri: '' };
            }
          }
        }
        if (!resolvedWinUninstallSpec && allowDeleteFiles !== true) {
          const safeExtId =
            externalInstallId && /^[A-Za-z0-9._-]+$/.test(externalInstallId)
              ? externalInstallId
              : '';
          if (chainedHandoff === 'ubisoft' && safeExtId) {
            resolvedWinUninstallSpec = {
              exe: '',
              args: [],
              uri: `uplay://uninstall/${safeExtId}`,
            };
          } else if (
            (chainedHandoff === 'bnet' ||
              chainedHandoff === 'rockstar' ||
              chainedHandoff === 'riot') &&
            safeExtId
          ) {
            const hostPub = discoverHostPublisherLauncher(chainedHandoff, {
              ...options,
              platform: 'win32',
            });
            if (hostPub?.installed && hostPub.binaryPath) {
              if (chainedHandoff === 'bnet') {
                resolvedWinUninstallSpec = {
                  exe: hostPub.binaryPath,
                  args: [`--exec=uninstall ${safeExtId}`],
                  uri: '',
                };
              } else if (chainedHandoff === 'rockstar') {
                resolvedWinUninstallSpec = {
                  exe: hostPub.binaryPath,
                  args: ['-enableFullMode', `-uninstall=${safeExtId}`],
                  uri: '',
                };
              } else if (chainedHandoff === 'riot') {
                resolvedWinUninstallSpec = {
                  exe: hostPub.binaryPath,
                  args: [`--uninstall-product=${safeExtId}`, '--uninstall-patchline=live'],
                  uri: '',
                };
              }
            }
          } else if (chainedHandoff === 'ea' && localInstall) {
            const eaCleanupExe = path.join(localInstall, '__Installer', 'Cleanup.exe');
            if (fs.existsSync(eaCleanupExe)) {
              resolvedWinUninstallSpec = {
                exe: eaCleanupExe,
                args: ['uninstall_game', '-autologging'],
                uri: '',
              };
            }
          }
        }

        let invokedWinPublisherUninstaller = false;
        if (resolvedWinUninstallSpec) {
          if (resolvedWinUninstallSpec.uri) {
            await openExternalUri(resolvedWinUninstallSpec.uri, options);
            invokedWinPublisherUninstaller = true;
          } else if (
            resolvedWinUninstallSpec.exe &&
            (typeof options.spawnFn === 'function' ||
              typeof options.spawnImpl === 'function' ||
              fs.existsSync(toHostFilesystemPath(resolvedWinUninstallSpec.exe)) ||
              fs.existsSync(resolvedWinUninstallSpec.exe))
          ) {
            const uninstallTimeoutMs = Math.max(
              50,
              Number(
                options.publisherUninstallTimeoutMs ??
                  (isTestEnvironment(options) ? 2000 : 120_000)
              )
            );
            await new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(undefined);
              };
              const timer = setTimeout(finish, uninstallTimeoutMs);
              if (typeof timer.unref === 'function') timer.unref();
              try {
                const uninstChild = spawnImpl(
                  resolvedWinUninstallSpec.exe,
                  resolvedWinUninstallSpec.args || [],
                  {
                    cwd:
                      localInstall && fs.existsSync(localInstall)
                        ? localInstall
                        : path.dirname(resolvedWinUninstallSpec.exe),
                    windowsHide: false,
                    stdio: 'ignore',
                  }
                );
                invokedWinPublisherUninstaller = true;
                if (uninstChild && typeof uninstChild.once === 'function') {
                  uninstChild.once('exit', finish);
                  uninstChild.once('close', finish);
                  uninstChild.once('error', finish);
                } else {
                  finish();
                }
              } catch {
                finish();
              }
            });
          }
        }

        if (invokedWinPublisherUninstaller && hadWinLocalInstallOnDisk && fs.existsSync(localInstall)) {
          const pollTimeoutMs = Math.max(
            0,
            Number(
              options.publisherUninstallPollTimeoutMs ??
                (isTestEnvironment(options) ? 40 : 15_000)
            )
          );
          const pollIntervalMs = Math.max(
            10,
            Number(options.publisherUninstallPollIntervalMs ?? (isTestEnvironment(options) ? 10 : 500))
          );
          const deadline = Date.now() + pollTimeoutMs;
          while (Date.now() < deadline && fs.existsSync(localInstall)) {
            await new Promise((resolve) => {
              setTimeout(resolve, pollIntervalMs);
            });
          }
          if (fs.existsSync(localInstall)) {
            const pubName =
              CHAINED_PUBLISHER_ECOSYSTEMS[chainedHandoff]?.displayName || 'the publisher launcher';
            return {
              success: false,
              cancelled: true,
              stillInstalled: true,
              error: `Publisher uninstaller did not remove ${localInstall}. Confirm uninstall in ${pubName} and try again.`,
              installPath: localInstall,
            };
          }
        }

        if (chainedHandoff === 'ea' && localInstall) {
          await cleanupWindowsEaGameRegistryAsync(
            localInstall,
            { externalInstallId, eaInstallerXmlMeta },
            options
          );
        }
      }
    }

    // Remove from One Launcher managed records AFTER verified Appx / store removal succeeds
    const filtered = managed.filter((/** @type {any} */ r) => {
      if (r === matchedManagedRecord) return false;
      if (
        gogSplitParentDir &&
        r?.platformId === 'gog' &&
        r?.installPath &&
        path.resolve(toLocalFsPath(r.installPath)) === path.resolve(gogSplitParentDir)
      ) {
        return false;
      }
      return true;
    });
    if (filtered.length !== managed.length) {
      saveManagedInstalledGames(filtered, userDataDir);
    }

    if (localInstall && fs.existsSync(localInstall)) {
      const canDeleteLocal =
        chainedHandoff && isBottlePath(localInstall)
          ? allowDeleteFiles !== false &&
            Boolean(chainedBottleRoot) &&
            isSafeBottleChainedGameDirToDelete(chainedBottleRoot, localInstall)
          : chainedHandoff === 'ea' && platform === 'win32'
            ? allowDeleteFiles !== false &&
              (hasManagedInstallSentinel(localInstall) ||
                /steamapps[\\/]common[\\/]/i.test(localInstall) ||
                isSafeHostEaGameDirToDelete(localInstall, eaInstallerXmlMeta, options))
            : Boolean(allowDeleteFiles) ||
              hasManagedInstallSentinel(localInstall) ||
              Boolean(gogSplitParentDir) ||
              (!chainedHandoff && isBottlePath(localInstall)) ||
              /steamapps[\\/]common[\\/]/i.test(localInstall) ||
              localInstall.includes('OneLauncher') ||
              localInstall.includes('one-launcher');

      if (canDeleteLocal && isSafeToDeleteInstallPath(localInstall, options)) {
        try {
          fs.rmSync(localInstall, { recursive: true, force: true });
        } catch {}
      }
    }

    if (gogSplitParentDir && fs.existsSync(gogSplitParentDir)) {
      const canDeleteSplitParent =
        Boolean(allowDeleteFiles) ||
        hasManagedInstallSentinel(gogSplitParentDir) ||
        isBottlePath(gogSplitParentDir) ||
        gogSplitParentDir.includes('OneLauncher') ||
        gogSplitParentDir.includes('one-launcher');

      if (canDeleteSplitParent && isSafeToDeleteInstallPath(gogSplitParentDir, options)) {
        try {
          fs.rmSync(gogSplitParentDir, { recursive: true, force: true });
        } catch {}
      }
    }

    if (localInstall) {
      evictExecutableDiscoveryCacheForPath(localInstall);
    }
    if (gogSplitParentDir) {
      evictExecutableDiscoveryCacheForPath(gogSplitParentDir);
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
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

function shutdownLauncherEngine(/** @type {any} */ options = {}) {
  shutdownDownloadEngine(options);
  liveBottleDaemonEnvContractByPrefix.clear();

  for (const [, entry] of activeSessions.entries()) {
    if (entry && entry.pollTimer) {
      try {
        clearInterval(entry.pollTimer);
      } catch {}
      entry.pollTimer = null;
    }
    if (entry && entry.displayWatcherChild && typeof entry.displayWatcherChild.kill === 'function') {
      try {
        entry.displayWatcherChild.kill('SIGTERM');
      } catch {}
      entry.displayWatcherChild = null;
    }
  }
  const vaultHooks = getOfflineVaultLifecycleHooks();
  if (vaultHooks && typeof vaultHooks.shutdown === 'function') {
    try {
      vaultHooks.shutdown();
    } catch {}
  }
  trimLauncherEngineMemory();
}

module.exports = {
  parseLaunchArguments,
  doesCrossOverBinarySupportWaitChildren,
  discoverValidatedAppLocalProxyDllOverrides,
  computeBottleGraphicsEnvContract,
  getLiveBottleDaemonEnvContract,
  resetSupervisorStateForTests,
  findLiveBottleGameChildPid,
  isSafeBottleChainedGameDirToDelete,
  collectChainedGameCandidateExeNames,
  buildStorefrontLaunchUri,
  trackPostSessionPromise,
  killPosixProcessesMatchingWinExe,
  isMacSipProtectedExecutableOrScript,
  isWindowsElevationRequiredError,
  spawnWindowsViaPowerShellStartProcess,
  hasActivePostSessionWork,
  waitForActivePostSessionWork,
  syncGogCloudSaves,
  syncEpicCloudSaves,
  waitForSteamColdStartupCloudReady,
  waitForSteamCloudSyncCompletion,
  finalizeGameSession,
  launchGame,
  stopGame,
  getRunningGames,
  toggleSessionFullscreen,
  stageBottleDisplayScalerBinaries,
  computeMacPrimaryDisplaySafeInsetTop,
  shouldWrapBottleSessionWithDisplayLauncher,
  resolveSteamClientBinaryPath,
  detectInstalledStorefrontClients,
  resolveSteamClientLaunchCommand,
  shutdownEphemeralStorefrontClient,
  syncSessionPlaytimeToStorefront,
  verifyGameFiles,
  uninstallGame,
  shutdownLauncherEngine,
  normalizeWineArgumentBackslashes,
};
