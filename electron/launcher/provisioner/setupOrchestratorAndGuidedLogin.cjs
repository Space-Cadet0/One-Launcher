// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { spawn } = childProcess;

const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  invalidateScanCaches,
  openExternalUri,
  safeIsBottleSlug,
  activeSessions,
  pendingBottleLaunches,
} = require('../engineStateRegistry.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  resolveBottleSteamExe,
  isCrossOverPerlWineWrapperOptions,
  applyCrossOverEnvironmentHygiene,
} = require('../wineAndCrossOverManager.cjs');
const { atomicWriteFileSync } = require('../securityAndPathUtils.cjs');
const {
  parseSteamAcf,
  parseSteamLibraryFoldersVdf,
} = require('../binaryAndManifestInspectors.cjs');
const { isBottleWinExeRunning } = require('../storefrontReadinessBarrier.cjs');
const {
  resolveWineLibraryPathInBottle,
} = require('../mac/compatLayerRegistryAndDetection.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  resolveTargetMacAppBundlePath,
  isValidBottleDirectory,
  detectCompatibilityLayers,
  listBottleSubdirectories,
  listAllInitializedBottlePaths,
  shutdownWinePrefix,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
  alignWineMsyncWithLiveBottle,
  prepareCrossOverWineSpawnEnv,
  prepareAlignedAuxBottleWineCommand,
} = macNativeInstallerAndCodesign;
const {
  syncGogFirstPartyLauncher,
  resolveGogGalaxyClientBinaryPath,
} = require('../gogRegistryAndDirectInstaller.cjs');
const {
  syncEpicFirstPartyLauncher,
  resolveEpicClientBinaryPath,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const {
  resolveSteamClientBinaryPath,
} = require('../sessionAndProcessSupervisor.cjs');
const {
  getSetupWizardState,
  saveSetupWizardState,
  probeClientLoginStates,
  probeEnvironmentHealth,
  invalidateProberRunnerUpdatesCache,
} = require('../environmentHealthProber.cjs');
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
  sanitizeChainedPublisherAutostartInBottleRegs,
} = require('../chainedPublisherLaunchers.cjs');
const {
  ACTION_EXECUTION_ORDER,
  VALID_CLIENT_LOGIN_TARGETS,
  explicitHomedirOpt,
  emitEnvironmentSetupProgress,
  normalizeRequestedRunnerType,
  componentIdToRunnerType,
  cancellableSleep,
  streamVerifiedDownloadToFile,
  getExecFileFn,
  runExecFileAsync,
} = require('./installerNetworkAndGuardrails.cjs');
const {
  verifyMacPkgSignature,
  verifyWindowsInstallerSignature,
} = require('./artifactSignatureVerifier.cjs');
const {
  resolveTargetMacApplicationsDir,
  mountVerifyAndInstallDmgApp,
} = require('./macAppBundleInstaller.cjs');
const {
  downloadGogGalaxyInstallerToFile,
} = require('./gogAndPreviewResolvers.cjs');
const {
  isRosetta2InstalledFast,
  ensureRosetta2InBackground,
  installRunnerDirect,
  resolveRunnerAndBottleTarget,
  resolveAndValidateBottleClientTarget,
  isBenignWindowsInstallerExitCode,
  runBottleInstallerAndWait,
  ensureBottleInitializedInternal,
  provisionVerifiedChainedPublisherClient,
} = require('./runnerAndBottleProvisioner.cjs');

/** @type {Map<string, AbortController>} */
const activeSetupRuns = new Map();

/** @type {Map<string, { abortController: AbortController, runId: string }>} */
const activeGuidedLogins = new Map();

const MAX_LINK_STEAM_TEXT_BYTES = 512 * 1024;

/**
 * Tokenize Valve KeyValues VDF content into quoted strings and structural braces `{` / `}`
 * while preserving exact character offsets for safe surgical splicing.
 *
 * @param {string} vdfContent
 * @returns {Array<{ type: 'string' | 'lbrace' | 'rbrace', value: string, start: number, end: number }>}
 */
function tokenizeValveVdf(vdfContent) {
  /** @type {Array<{ type: 'string' | 'lbrace' | 'rbrace', value: string, start: number, end: number }>} */
  const tokens = [];
  const len = vdfContent.length;
  let i = 0;
  while (i < len) {
    const ch = vdfContent[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && i + 1 < len && vdfContent[i + 1] === '/') {
      i += 2;
      while (i < len && vdfContent[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{') {
      tokens.push({ type: 'lbrace', value: '{', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '}') {
      tokens.push({ type: 'rbrace', value: '}', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let value = '';
      while (i < len && vdfContent[i] !== '"') {
        if (vdfContent[i] === '\\' && i + 1 < len) {
          value += vdfContent[i + 1];
          i += 2;
        } else {
          value += vdfContent[i];
          i += 1;
        }
      }
      if (i < len && vdfContent[i] === '"') {
        i += 1;
      }
      tokens.push({ type: 'string', value, start, end: i });
      continue;
    }
    i += 1;
  }
  return tokens;
}

/**
 * Locate `"libraryfolders" -> "0" -> "apps" { ... }` in a Valve `libraryfolders.vdf` file,
 * returning brace indices and existing AppID keys inside `"0" -> "apps"`.
 *
 * @param {string} vdfContent
 * @returns {{ openBraceIndex: number, closeBraceIndex: number, existingAppIds: Set<string> } | null}
 */
function locateLibraryFoldersZeroAppsBlock(vdfContent) {
  const tokens = tokenizeValveVdf(vdfContent);
  /**
   * @param {number} lbraceTokIdx
   * @returns {number}
   */
  const skipBlock = (lbraceTokIdx) => {
    let depth = 0;
    for (let idx = lbraceTokIdx; idx < tokens.length; idx += 1) {
      if (tokens[idx].type === 'lbrace') depth += 1;
      else if (tokens[idx].type === 'rbrace') {
        depth -= 1;
        if (depth === 0) return idx + 1;
      }
    }
    return tokens.length;
  };

  let idx = 0;
  while (idx + 1 < tokens.length) {
    const rootKey = tokens[idx];
    const rootNext = tokens[idx + 1];
    if (rootKey.type === 'string' && rootNext.type === 'lbrace') {
      if (rootKey.value.toLowerCase() !== 'libraryfolders') {
        idx = skipBlock(idx + 1);
        continue;
      }
      let c = idx + 2;
      while (c < tokens.length && tokens[c].type !== 'rbrace') {
        const childKey = tokens[c];
        const childVal = tokens[c + 1];
        if (!childVal) break;
        if (childKey.type === 'string' && childVal.type === 'string') {
          c += 2;
          continue;
        }
        if (childKey.type === 'string' && childVal.type === 'lbrace') {
          if (childKey.value === '0') {
            let z = c + 2;
            while (z < tokens.length && tokens[z].type !== 'rbrace') {
              const zKey = tokens[z];
              const zVal = tokens[z + 1];
              if (!zVal) break;
              if (zKey.type === 'string' && zVal.type === 'string') {
                z += 2;
                continue;
              }
              if (zKey.type === 'string' && zVal.type === 'lbrace') {
                if (zKey.value.toLowerCase() === 'apps') {
                  const openBraceIndex = zVal.start;
                  /** @type {Set<string>} */
                  const existingAppIds = new Set();
                  let a = z + 2;
                  while (a < tokens.length && tokens[a].type !== 'rbrace') {
                    const appKey = tokens[a];
                    const appVal = tokens[a + 1];
                    if (appKey.type === 'string' && appVal && appVal.type === 'string') {
                      existingAppIds.add(appKey.value.trim());
                      a += 2;
                    } else if (appVal && appVal.type === 'lbrace') {
                      a = skipBlock(a + 1);
                    } else {
                      a += 1;
                    }
                  }
                  if (a < tokens.length && tokens[a].type === 'rbrace') {
                    return {
                      openBraceIndex,
                      closeBraceIndex: tokens[a].start,
                      existingAppIds,
                    };
                  }
                  return null;
                }
                z = skipBlock(z + 1);
                continue;
              }
              z += 1;
            }
            return null;
          }
          c = skipBlock(c + 1);
          continue;
        }
        c += 1;
      }
      return null;
    }
    idx += 1;
  }
  return null;
}

/**
 * Determine whether a parsed Steam `.acf` manifest represents an in-progress download
 * rather than a completed installation.
 *
 * @param {any} parsed
 * @returns {boolean}
 */
function isSteamAcfActivelyDownloading(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const stateFlags =
    parsed.StateFlags !== undefined ? String(parsed.StateFlags).trim() : undefined;
  const stateFlagsNum =
    stateFlags !== undefined && /^\d+$/.test(stateFlags) ? Number(stateFlags) : NaN;
  const bytesToDl = Number(parsed.BytesToDownload || 0);
  const bytesDl = Number(parsed.BytesDownloaded || 0);
  const isInstalledFlagSet = Number.isFinite(stateFlagsNum) && (stateFlagsNum & 4) === 4;
  return Boolean(
    !isInstalledFlagSet &&
      ((Number.isFinite(stateFlagsNum) &&
        (stateFlagsNum & (2 | 256 | 512 | 1024 | 2048)) !== 0) ||
        (stateFlags && bytesToDl > 0 && bytesDl < bytesToDl))
  );
}

/**
 * Validate a Steam ACF `installdir` folder name to ensure it cannot traverse paths.
 *
 * @param {unknown} installdir
 * @returns {installdir is string}
 */
function isValidSteamInstallDirName(installdir) {
  return (
    typeof installdir === 'string' &&
    Boolean(installdir.trim()) &&
    !/[\\/\x00]/.test(installdir) &&
    installdir !== '.' &&
    installdir !== '..'
  );
}

/**
 * Check whether any active game session or pending bottle launch is currently
 * running inside `bottlePath`.
 *
 * @param {string} bottlePath
 * @returns {Promise<boolean>}
 */
async function hasActiveGameSessionInBottle(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string') return false;
  const resolvedTarget = path.resolve(bottlePath);
  const realTarget = await fs.promises.realpath(resolvedTarget).catch(() => resolvedTarget);
  const targetKeys = new Set([resolvedTarget.toLowerCase(), realTarget.toLowerCase()]);

  if (pendingBottleLaunches) {
    for (const [prefix, count] of pendingBottleLaunches.entries()) {
      if (!prefix || !(Number(count) > 0)) continue;
      const resPrefix = path.resolve(prefix);
      if (targetKeys.has(resPrefix.toLowerCase())) return true;
      const realPrefix = await fs.promises.realpath(resPrefix).catch(() => resPrefix);
      if (targetKeys.has(realPrefix.toLowerCase())) return true;
    }
  }

  if (activeSessions) {
    for (const [, entry] of activeSessions.entries()) {
      if (!entry || entry.finalized) continue;
      const prefix = entry.winePrefix || entry.session?.winePrefix;
      if (!prefix || typeof prefix !== 'string') continue;
      const resPrefix = path.resolve(prefix);
      if (targetKeys.has(resPrefix.toLowerCase())) return true;
      const realPrefix = await fs.promises.realpath(resPrefix).catch(() => resPrefix);
      if (targetKeys.has(realPrefix.toLowerCase())) return true;
    }
  }

  return false;
}

/**
 * Safely synchronize `"0" -> "apps"` entries in existing target bottle `libraryfolders.vdf` files
 * against all valid installed `appmanifest_<appId>.acf` files in `<targetSteamRoot>/steamapps/`,
 * strictly when `steam.exe` is NOT running inside `targetBottlePath`.
 *
 * @param {string} targetSteamRoot
 * @param {string} targetSteamappsDir
 * @param {string} targetBottlePath
 * @param {Record<string, any>} options
 * @returns {Promise<{ updated: boolean, skippedBecauseSteamRunning: boolean }>}
 */
async function syncTargetBottleLibraryFoldersVdf(
  targetSteamRoot,
  targetSteamappsDir,
  targetBottlePath,
  options
) {
  const targetConfigDir =
    resolveDriveCPathCaseInsensitive(targetSteamRoot, ['config']) ||
    path.join(targetSteamRoot, 'config');
  const rawCandidates = [
    resolveDriveCPathCaseInsensitive(targetSteamappsDir, ['libraryfolders.vdf']) ||
      path.join(targetSteamappsDir, 'libraryfolders.vdf'),
    resolveDriveCPathCaseInsensitive(targetConfigDir, ['libraryfolders.vdf']) ||
      path.join(targetConfigDir, 'libraryfolders.vdf'),
  ];
  /** @type {string[]} */
  const existingVdfs = [];
  /** @type {Set<string>} */
  const seenVdfKeys = new Set();
  for (const cand of rawCandidates) {
    try {
      const st = await fs.promises.stat(cand);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_LINK_STEAM_TEXT_BYTES) continue;
      const realCand = await fs.promises.realpath(cand).catch(() => path.resolve(cand));
      const key = realCand.toLowerCase();
      if (seenVdfKeys.has(key)) continue;
      seenVdfKeys.add(key);
      existingVdfs.push(cand);
    } catch {}
  }
  if (existingVdfs.length === 0) {
    return { updated: false, skippedBecauseSteamRunning: false };
  }

  const targetCommonDir =
    resolveDriveCPathCaseInsensitive(targetSteamappsDir, ['common']) ||
    path.join(targetSteamappsDir, 'common');

  /** @type {Array<{ appIdNum: number, appIdStr: string, sizeOnDisk: string }>} */
  const targetManifests = [];
  try {
    const entries = await fs.promises.readdir(targetSteamappsDir);
    for (const entry of entries) {
      const match = /^appmanifest_(\d+)\.acf$/i.exec(entry);
      if (!match) continue;
      const appIdStr = match[1];
      const appIdNum = Number(appIdStr);
      if (!Number.isSafeInteger(appIdNum) || appIdNum <= 0) continue;
      const acfPath = path.join(targetSteamappsDir, entry);
      try {
        const st = await fs.promises.stat(acfPath);
        if (!st.isFile() || st.size <= 0 || st.size > MAX_LINK_STEAM_TEXT_BYTES) continue;
        const rawAcf = await fs.promises.readFile(acfPath, 'utf8');
        const parsed = parseSteamAcf(rawAcf);
        if (!parsed || Number(parsed.appId) !== appIdNum) continue;
        if (isSteamAcfActivelyDownloading(parsed)) continue;
        const installdir = parsed.installdir;
        if (!isValidSteamInstallDirName(installdir)) continue;
        const gameDir = path.join(targetCommonDir, installdir);
        try {
          const dirStat = await fs.promises.stat(gameDir);
          if (!dirStat.isDirectory()) continue;
        } catch {
          continue;
        }
        const rawSize = parsed.SizeOnDisk !== undefined ? String(parsed.SizeOnDisk).trim() : '';
        const sizeOnDisk = /^\d+$/.test(rawSize) ? rawSize : '0';
        targetManifests.push({ appIdNum, appIdStr, sizeOnDisk });
      } catch {}
    }
  } catch {
    return { updated: false, skippedBecauseSteamRunning: false };
  }
  if (targetManifests.length === 0) {
    return { updated: false, skippedBecauseSteamRunning: false };
  }
  targetManifests.sort((a, b) => a.appIdNum - b.appIdNum);

  /** @type {Array<{ vdfPath: string, vdfContent: string, block: NonNullable<ReturnType<typeof locateLibraryFoldersZeroAppsBlock>>, linesToInsert: string[] }>} */
  const pendingMutations = [];
  for (const vdfPath of existingVdfs) {
    try {
      const vdfContent = await fs.promises.readFile(vdfPath, 'utf8');
      const block = locateLibraryFoldersZeroAppsBlock(vdfContent);
      if (!block) continue;

      /** @type {string[]} */
      const linesToInsert = [];
      for (const item of targetManifests) {
        if (block.existingAppIds.has(item.appIdStr)) continue;
        block.existingAppIds.add(item.appIdStr);
        linesToInsert.push(`\t\t\t"${item.appIdStr}"\t\t"${item.sizeOnDisk}"\n`);
      }
      if (linesToInsert.length > 0) {
        pendingMutations.push({ vdfPath, vdfContent, block, linesToInsert });
      }
    } catch {}
  }

  if (pendingMutations.length === 0) {
    return { updated: false, skippedBecauseSteamRunning: false };
  }

  const steamRunning = await isBottleWinExeRunning('steam.exe', targetBottlePath, options);
  if (steamRunning) {
    return { updated: false, skippedBecauseSteamRunning: true };
  }

  let anyUpdated = false;
  for (const { vdfPath, vdfContent, block, linesToInsert } of pendingMutations) {
    try {
      const insertionPayload = linesToInsert.join('');
      let lineStartBeforeClose = block.closeBraceIndex;
      while (
        lineStartBeforeClose > block.openBraceIndex + 1 &&
        (vdfContent[lineStartBeforeClose - 1] === ' ' ||
          vdfContent[lineStartBeforeClose - 1] === '\t')
      ) {
        lineStartBeforeClose -= 1;
      }

      let updatedContent = '';
      if (
        lineStartBeforeClose > block.openBraceIndex + 1 &&
        vdfContent[lineStartBeforeClose - 1] === '\n'
      ) {
        updatedContent =
          vdfContent.slice(0, lineStartBeforeClose) +
          insertionPayload +
          vdfContent.slice(lineStartBeforeClose);
      } else {
        updatedContent =
          vdfContent.slice(0, block.closeBraceIndex) +
          `\n${insertionPayload}\t\t` +
          vdfContent.slice(block.closeBraceIndex);
      }

      if (updatedContent !== vdfContent) {
        atomicWriteFileSync(vdfPath, updatedContent);
        anyUpdated = true;
      }
    } catch {}
  }
  return { updated: anyUpdated, skippedBecauseSteamRunning: false };
}

/**
 * Link already-installed Windows Steam games from other initialized bottles into
 * `targetBottlePath` with zero re-downloading and zero disk duplication:
 * - Creates POSIX directory symlinks inside `<targetSteamRoot>/steamapps/common/<installdir>`
 *   pointing to the canonical physical game directory (`fs.promises.realpath`), without ever
 *   overwriting an existing non-symlink directory.
 * - Atomically copies missing `appmanifest_<appId>.acf` files into `<targetSteamRoot>/steamapps/`.
 * - When `steam.exe` is not running inside `targetBottlePath`, registers missing linked apps
 *   into `"0" -> "apps"` of existing `libraryfolders.vdf` files.
 *
 * @param {string} targetBottlePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ linkedCount: number, linkedAppIds: number[], needsVdfSync?: boolean }>}
 */
async function linkInstalledSteamAppsIntoBottle(targetBottlePath, options = {}) {
  if (!targetBottlePath || typeof targetBottlePath !== 'string' || !targetBottlePath.trim()) {
    return { linkedCount: 0, linkedAppIds: [] };
  }

  const resolvedTargetBottle = path.resolve(targetBottlePath.trim());
  const targetSteamExe = resolveBottleSteamExe(resolvedTargetBottle);
  if (!targetSteamExe) {
    return { linkedCount: 0, linkedAppIds: [] };
  }

  const realTargetBottle = await fs.promises
    .realpath(resolvedTargetBottle)
    .catch(() => resolvedTargetBottle);
  const targetBottleKeys = new Set([
    resolvedTargetBottle.toLowerCase(),
    realTargetBottle.toLowerCase(),
  ]);

  const targetSteamRoot = path.dirname(targetSteamExe);
  const targetSteamappsDir =
    resolveDriveCPathCaseInsensitive(targetSteamRoot, ['steamapps']) ||
    path.join(targetSteamRoot, 'steamapps');
  const targetCommonDir =
    resolveDriveCPathCaseInsensitive(targetSteamappsDir, ['common']) ||
    path.join(targetSteamappsDir, 'common');
  await fs.promises.mkdir(targetCommonDir, { recursive: true });

  const realTargetSteamappsDir = await fs.promises
    .realpath(targetSteamappsDir)
    .catch(() => path.resolve(targetSteamappsDir));
  const realTargetCommonDir = await fs.promises
    .realpath(targetCommonDir)
    .catch(() => path.resolve(targetCommonDir));
  const realTargetCommonPrefix = `${realTargetCommonDir.toLowerCase()}${path.sep}`;

  // Discover all other initialized bottle directories on the host
  /** @type {string[]} */
  const sourceBottlePaths = [];
  /** @type {Set<string>} */
  const seenBottleKeys = new Set(targetBottleKeys);

  /** @param {string | null | undefined} candidateBottle */
  const addSourceBottle = async (candidateBottle) => {
    if (!candidateBottle || typeof candidateBottle !== 'string') return;
    const resolved = path.resolve(candidateBottle);
    const resolvedKey = resolved.toLowerCase();
    if (seenBottleKeys.has(resolvedKey)) return;
    let realPath = resolved;
    try {
      const st = await fs.promises.stat(resolved);
      if (!st.isDirectory()) return;
      realPath = await fs.promises.realpath(resolved);
    } catch {
      return;
    }
    const realKey = realPath.toLowerCase();
    if (seenBottleKeys.has(realKey)) return;
    seenBottleKeys.add(resolvedKey);
    seenBottleKeys.add(realKey);
    sourceBottlePaths.push(resolved);
  };

  const discoverOpts = {
    ...options,
    ...explicitHomedirOpt(options),
    platform: options.platform || process.platform,
  };

  try {
    const layers = detectCompatibilityLayers(discoverOpts);
    for (const layer of layers) {
      if (!layer || !layer.bottlesDir) continue;
      for (const bName of listBottleSubdirectories(layer.bottlesDir, discoverOpts)) {
        await addSourceBottle(path.join(layer.bottlesDir, bName));
      }
    }
  } catch {}

  try {
    for (const bPath of listAllInitializedBottlePaths(discoverOpts)) {
      await addSourceBottle(bPath);
    }
  } catch {}

  // Discover all source Windows Steam `steamapps` directories across other bottles
  /** @type {string[]} */
  const sourceSteamappsDirs = [];
  /** @type {Set<string>} */
  const seenSteamappsKeys = new Set([realTargetSteamappsDir.toLowerCase()]);

  /** @param {string | null | undefined} candidateSteamapps */
  const addSourceSteamappsDir = async (candidateSteamapps) => {
    if (!candidateSteamapps || typeof candidateSteamapps !== 'string') return;
    let realDir = '';
    try {
      const st = await fs.promises.stat(candidateSteamapps);
      if (!st.isDirectory()) return;
      realDir = await fs.promises.realpath(candidateSteamapps);
    } catch {
      return;
    }
    const key = realDir.toLowerCase();
    if (seenSteamappsKeys.has(key)) return;
    seenSteamappsKeys.add(key);
    sourceSteamappsDirs.push(realDir);
  };

  for (const srcBottle of sourceBottlePaths) {
    const driveCRoot =
      resolveDriveCPathCaseInsensitive(srcBottle, ['drive_c']) ||
      path.join(srcBottle, 'drive_c');
    const steamRootCandidates = new Set([
      resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)', 'Steam']) ||
        path.join(driveCRoot, 'Program Files (x86)', 'Steam'),
      resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files', 'Steam']) ||
        path.join(driveCRoot, 'Program Files', 'Steam'),
    ]);
    const srcSteamExe = resolveBottleSteamExe(srcBottle);
    if (srcSteamExe) {
      steamRootCandidates.add(path.dirname(srcSteamExe));
    }

    for (const srcSteamRoot of steamRootCandidates) {
      const ciSrcSteamapps = resolveDriveCPathCaseInsensitive(srcSteamRoot, ['steamapps']);
      if (ciSrcSteamapps) {
        await addSourceSteamappsDir(ciSrcSteamapps);
      }
      await addSourceSteamappsDir(path.join(srcSteamRoot, 'steamapps'));
      await addSourceSteamappsDir(path.join(srcSteamRoot, 'SteamApps'));

      const srcConfigDir =
        resolveDriveCPathCaseInsensitive(srcSteamRoot, ['config']) ||
        path.join(srcSteamRoot, 'config');
      const vdfCandidates = [
        ...(ciSrcSteamapps
          ? [
              resolveDriveCPathCaseInsensitive(ciSrcSteamapps, ['libraryfolders.vdf']) ||
                path.join(ciSrcSteamapps, 'libraryfolders.vdf'),
            ]
          : []),
        path.join(srcSteamRoot, 'steamapps', 'libraryfolders.vdf'),
        path.join(srcSteamRoot, 'SteamApps', 'libraryfolders.vdf'),
        resolveDriveCPathCaseInsensitive(srcConfigDir, ['libraryfolders.vdf']) ||
          path.join(srcConfigDir, 'libraryfolders.vdf'),
      ];
      for (const vdfPath of vdfCandidates) {
        try {
          const st = await fs.promises.stat(vdfPath);
          if (!st.isFile() || st.size <= 0 || st.size > MAX_LINK_STEAM_TEXT_BYTES) continue;
          const vdfContent = await fs.promises.readFile(vdfPath, 'utf8');
          const libPaths = parseSteamLibraryFoldersVdf(vdfContent);
          for (const lp of libPaths) {
            const resolvedHosts = resolveWineLibraryPathInBottle(srcBottle, driveCRoot, lp);
            for (const hostRoot of resolvedHosts) {
              const ciHostSteamapps = resolveDriveCPathCaseInsensitive(hostRoot, ['steamapps']);
              if (ciHostSteamapps) {
                await addSourceSteamappsDir(ciHostSteamapps);
              }
              await addSourceSteamappsDir(path.join(hostRoot, 'steamapps'));
              await addSourceSteamappsDir(path.join(hostRoot, 'SteamApps'));
              await addSourceSteamappsDir(hostRoot);
            }
          }
        } catch {}
      }
    }
  }

  /** @type {Set<number>} */
  const linkedAppIdSet = new Set();

  for (const sourceSteamappsDir of sourceSteamappsDirs) {
    /** @type {string[]} */
    let entries = [];
    try {
      entries = (await fs.promises.readdir(sourceSteamappsDir)).sort();
    } catch {
      continue;
    }

    const sourceCommonDir =
      resolveDriveCPathCaseInsensitive(sourceSteamappsDir, ['common']) ||
      path.join(sourceSteamappsDir, 'common');

    for (const entry of entries) {
      const match = /^appmanifest_(\d+)\.acf$/i.exec(entry);
      if (!match) continue;
      const appIdStr = match[1];
      const appIdNum = Number(appIdStr);
      if (!Number.isSafeInteger(appIdNum) || appIdNum <= 0) continue;

      const sourceAcfPath = path.join(sourceSteamappsDir, entry);
      let rawAcf = '';
      try {
        const st = await fs.promises.stat(sourceAcfPath);
        if (!st.isFile() || st.size <= 0 || st.size > MAX_LINK_STEAM_TEXT_BYTES) continue;
        rawAcf = await fs.promises.readFile(sourceAcfPath, 'utf8');
      } catch {
        continue;
      }

      /** @type {any} */
      let parsed = null;
      try {
        parsed = parseSteamAcf(rawAcf);
      } catch {}
      if (!parsed || Number(parsed.appId) !== appIdNum) continue;

      if (isSteamAcfActivelyDownloading(parsed)) continue;

      const installdir = parsed.installdir;
      if (!isValidSteamInstallDirName(installdir)) {
        continue;
      }

      const sourceGameDir = path.join(sourceCommonDir, installdir);
      let realSourceGameDir = '';
      try {
        const srcStat = await fs.promises.stat(sourceGameDir);
        if (!srcStat.isDirectory()) continue;
        realSourceGameDir = await fs.promises.realpath(sourceGameDir);
      } catch {
        continue;
      }

      // Guard against self-referential symlinks pointing inside targetCommonDir
      // AND reverse containment where source is '/' or an ancestor of targetBottle / targetCommonDir
      const realSourceLower = realSourceGameDir.toLowerCase();
      const realSourceTrimmed =
        realSourceLower.length > 1 ? realSourceLower.replace(/[\\/]+$/, '') : realSourceLower;
      const realTargetCommonLower = realTargetCommonDir.toLowerCase();
      const realTargetBottleLower = realTargetBottle.toLowerCase();
      const realSourceRoot = path.parse(realSourceGameDir).root.toLowerCase();
      if (
        realSourceTrimmed === '/' ||
        realSourceLower === realSourceRoot ||
        realSourceTrimmed === realTargetCommonLower ||
        realSourceLower.startsWith(realTargetCommonPrefix) ||
        realSourceTrimmed === realTargetBottleLower ||
        realTargetBottleLower.startsWith(`${realSourceTrimmed}${path.sep}`) ||
        realTargetCommonLower.startsWith(`${realSourceTrimmed}${path.sep}`)
      ) {
        continue;
      }

      const targetGameDir = path.join(targetCommonDir, installdir);
      let linkedThisApp = false;
      let canWriteManifest = true;

      try {
        const targetLstat = await fs.promises.lstat(targetGameDir);
        if (targetLstat.isSymbolicLink()) {
          let symlinkValid = false;
          try {
            symlinkValid = (await fs.promises.stat(targetGameDir)).isDirectory();
          } catch {}
          if (!symlinkValid) {
            await fs.promises.unlink(targetGameDir);
            await fs.promises.symlink(realSourceGameDir, targetGameDir, 'dir');
            linkedThisApp = true;
          }
        } else if (!targetLstat.isDirectory()) {
          // Existing non-directory file collides with installdir; do not overwrite or link
          canWriteManifest = false;
        }
        // Existing non-symlink directory: NEVER overwrite!
      } catch (lstatErr) {
        if (/** @type {any} */ (lstatErr)?.code === 'ENOENT') {
          try {
            await fs.promises.symlink(realSourceGameDir, targetGameDir, 'dir');
            linkedThisApp = true;
          } catch {
            canWriteManifest = false;
          }
        } else {
          canWriteManifest = false;
        }
      }

      if (!canWriteManifest) continue;

      const targetAcfPath = path.join(targetSteamappsDir, `appmanifest_${appIdStr}.acf`);
      let targetAcfExists = false;
      try {
        await fs.promises.lstat(targetAcfPath);
        targetAcfExists = true;
      } catch {}

      if (!targetAcfExists) {
        try {
          atomicWriteFileSync(targetAcfPath, rawAcf);
          linkedThisApp = true;
        } catch {}
      }

      if (linkedThisApp) {
        linkedAppIdSet.add(appIdNum);
      }
    }
  }

  let needsVdfSync = false;
  try {
    const vdfSyncRes = await syncTargetBottleLibraryFoldersVdf(
      targetSteamRoot,
      targetSteamappsDir,
      resolvedTargetBottle,
      options
    );
    needsVdfSync = Boolean(vdfSyncRes?.skippedBecauseSteamRunning);
  } catch (vdfErr) {
    diagLog.warn('linkInstalledSteamAppsIntoBottle.vdfSync', vdfErr, {
      bottlePath: resolvedTargetBottle,
    });
  }

  const linkedAppIds = Array.from(linkedAppIdSet).sort((a, b) => a - b);
  return {
    linkedCount: linkedAppIds.length,
    linkedAppIds,
    ...(needsVdfSync ? { needsVdfSync: true } : {}),
  };
}

/**
 * Ensure a target bottle is initialized before installing a bottled client, skipping
 * redundant `ensureCompatibilityLayerReady` work when the bottle is already valid on disk.
 *
 * @param {any} layer
 * @param {string} bottleName
 * @param {string} bottlePath
 * @param {Record<string, any>} options
 * @param {AbortSignal} [signal]
 */
async function ensureBottleReadyIfUninitialized(layer, bottleName, bottlePath, options, signal) {
  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
  const isCrossOverLayer =
    layer?.type === 'crossover' ||
    layer?.type === 'crossover_preview' ||
    layer?.type === 'crossover_preview_arm64';
  const alreadyInitialized = isCrossOverLayer
    ? isValidBottleDirectory(bottlePath, isMockHomedir)
    : fs.existsSync(path.join(bottlePath, 'system.reg')) &&
      fs.existsSync(path.join(bottlePath, 'drive_c'));
  if (!alreadyInitialized) {
    await ensureBottleInitializedInternal(layer, bottleName, bottlePath, options, signal);
  }
}

/**
 * Lightweight, 0-write check for Windows Visual C++ 2015-2022 Redistributable without triggering
 * a full 24-component `probeEnvironmentHealth` scan.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function isWinVcRedistInstalledFast(options = {}) {
  if (typeof options.vcRedistInstalled === 'boolean') {
    return options.vcRedistInstalled;
  }
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(sysRoot, 'System32', 'vcruntime140.dll'),
    path.join(sysRoot, 'System32', 'vcruntime140_1.dll'),
  ];
  for (const cand of candidates) {
    try {
      await fs.promises.access(cand, fs.constants.F_OK);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Cancel an in-flight `runEnvironmentSetupTasks` run by `runId` (or all active runs if omitted).
 *
 * @param {string} [runId]
 * @param {Record<string, any>} [_options]
 * @returns {{ success: boolean, runId?: string, cancelled: boolean }}
 */
function cancelEnvironmentSetup(runId, _options = {}) {
  if (typeof runId === 'string' && runId.trim()) {
    const cleanId = runId.trim();
    const ctrl = activeSetupRuns.get(cleanId);
    if (!ctrl) {
      return { success: false, runId: cleanId, cancelled: false };
    }
    ctrl.abort();
    return { success: true, runId: cleanId, cancelled: true };
  }

  let cancelledAny = false;
  for (const [, ctrl] of activeSetupRuns.entries()) {
    ctrl.abort();
    cancelledAny = true;
  }
  return { success: cancelledAny, cancelled: cancelledAny };
}

/**
 * Execute requested environment setup tasks sequentially in dependency order:
 * `os_prerequisite` -> `install_runner` -> `ensure_bottle` -> `install_client` -> `sync_first_party_manifests`.
 *
 * @param {{ runId?: string, tasks: any[], connectedStorefronts?: any[] }} payload
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ success: boolean, runId: string, cancelled?: boolean, outcomes: any[], snapshot: any, error?: string }>}
 */
async function runEnvironmentSetupTasks(payload, options = {}) {
  const runId = String(
    payload?.runId || `env-setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const rawTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];

  const sortedTasks = rawTasks
    .map((task, idx) => ({ task, idx }))
    .sort((a, b) => {
      const prioA = ACTION_EXECUTION_ORDER[/** @type {keyof typeof ACTION_EXECUTION_ORDER} */ (a.task.action)] ?? 99;
      const prioB = ACTION_EXECUTION_ORDER[/** @type {keyof typeof ACTION_EXECUTION_ORDER} */ (b.task.action)] ?? 99;
      return prioA !== prioB ? prioA - prioB : a.idx - b.idx;
    })
    .map((entry) => entry.task);

  const controller = new AbortController();
  activeSetupRuns.set(runId, controller);

  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const hostArch = String(options.arch || process.arch || 'arm64');
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const execFileFn = getExecFileFn(options);

  /** @type {any[]} */
  const outcomes = [];
  /** @type {any[]} */
  const succeededComponents = [];
  let wasCancelled = false;

  try {
    const hasExplicitRosettaTask = sortedTasks.some((t) => t.action === 'install_rosetta2');
    const needsWindowsTranslationOnMac =
      hostPlatform === 'darwin' &&
      hostArch === 'arm64' &&
      !hasExplicitRosettaTask &&
      sortedTasks.some(
        (t) =>
          t.action === 'install_runner' ||
          t.action === 'ensure_bottle' ||
          (t.action === 'install_client' && String(t.componentId || '').startsWith('bottle_'))
      );

    if (needsWindowsTranslationOnMac) {
      await ensureRosetta2InBackground({
        ...options,
        signal: controller.signal,
      });
    }

    const totalSteps = sortedTasks.length;

    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      const task = sortedTasks[stepIndex];
      const componentId = task.componentId;
      const progressBase = {
        runId,
        componentId,
        action: task.action,
        stepIndex,
        totalSteps,
      };

      if (controller.signal.aborted) {
        wasCancelled = true;
        emitEnvironmentSetupProgress(
          {
            ...progressBase,
            phase: 'cancelled',
            message: 'Cancelled.',
          },
          options
        );
        outcomes.push({
          componentId,
          action: task.action,
          status: 'cancelled',
          message: 'Cancelled by user.',
        });
        continue;
      }

      try {
        // -------------------------------------------------------------------
        // 1. Apple Rosetta 2
        // -------------------------------------------------------------------
        if (task.action === 'install_rosetta2') {
          if (hostPlatform !== 'darwin' || hostArch !== 'arm64') {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'Rosetta 2 is only applicable on Apple Silicon Macs.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Rosetta 2 is only applicable on Apple Silicon Macs.',
            });
            continue;
          }

          const rosettaReady = await isRosetta2InstalledFast(options);
          if (rosettaReady && !options.forceReinstall) {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'Rosetta 2 is already installed.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Rosetta 2 is already installed.',
            });
            succeededComponents.push('rosetta2');
            continue;
          }

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'installing',
              message: 'Installing Apple Rosetta 2 via softwareupdate...',
            },
            options
          );
          await runExecFileAsync(
            execFileFn,
            '/usr/sbin/softwareupdate',
            ['--install-rosetta', '--agree-to-license'],
            { timeout: 300000, signal: controller.signal }
          );

          succeededComponents.push('rosetta2');
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: 'Installed Apple Rosetta 2.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            message: 'Installed Apple Rosetta 2.',
          });
          continue;
        }

        // -------------------------------------------------------------------
        // 2. Windows VC++ 2015-2022 Redistributable
        // -------------------------------------------------------------------
        if (task.action === 'install_win_vcredist') {
          if (hostPlatform !== 'win32') {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'VC++ Redistributable is only applicable on Windows.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'VC++ Redistributable is only applicable on Windows.',
            });
            continue;
          }

          const vcReady = await isWinVcRedistInstalledFast(options);
          if (vcReady && !options.forceReinstall) {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: 'VC++ Redistributable is already installed.',
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'VC++ Redistributable is already installed.',
            });
            succeededComponents.push('win_vcredist');
            continue;
          }

          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
          try {
            const vcUrls =
              options.x64Only === true
                ? [{ archLabel: 'x64', url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe' }]
                : [
                    { archLabel: 'x64', url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe' },
                    { archLabel: 'x86', url: 'https://aka.ms/vs/17/release/vc_redist.x86.exe' },
                  ];

            for (const item of vcUrls) {
              const exePath = path.join(tempDir, `vc_redist.${item.archLabel}.exe`);
              await streamVerifiedDownloadToFile(
                item.url,
                exePath,
                {
                  ...progressBase,
                  label: `VC++ Redistributable (${item.archLabel})`,
                  minFreeBytes: 100 * 1024 * 1024,
                },
                options,
                controller.signal
              );
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: `Verifying Microsoft Authenticode signature (${item.archLabel})...`,
                },
                options
              );
              await verifyWindowsInstallerSignature(exePath, {
                ...options,
                platform: 'win32',
                kind: 'exe',
                _componentId: componentId,
              });

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing VC++ Redistributable (${item.archLabel})...`,
                },
                options
              );
              try {
                await runExecFileAsync(
                  execFileFn,
                  exePath,
                  ['/install', '/quiet', '/norestart'],
                  { timeout: 180000, windowsHide: true, signal: controller.signal }
                );
              } catch (/** @type {any} */ execErr) {
                if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                  throw execErr;
                }
              }
            }
          } finally {
            try {
              await fs.promises.rm(tempDir, { recursive: true, force: true });
            } catch {}
          }

          succeededComponents.push('win_vcredist');
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: 'Installed Microsoft Visual C++ 2015–2022 Redistributable.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            message: 'Installed Microsoft Visual C++ 2015–2022 Redistributable.',
          });
          continue;
        }

        // -------------------------------------------------------------------
        // 3. Compatibility Runner (CrossOver, Wine Stable, GPTK, Preview)
        // -------------------------------------------------------------------
        if (task.action === 'install_runner') {
          if (hostPlatform !== 'darwin') {
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Compatibility runners are only applicable on macOS.',
            });
            continue;
          }

          const runnerType =
            normalizeRequestedRunnerType(task.runnerType) ||
            componentIdToRunnerType(componentId) ||
            'crossover';

          const hostArchForRunner = String(options.arch || process.arch || 'arm64').toLowerCase();
          if (runnerType === 'crossover_preview_arm64' && hostArchForRunner !== 'arm64') {
            const unsupportedMsg =
              'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.';
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'failed',
                message: unsupportedMsg,
                error: unsupportedMsg,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'failed',
              message: unsupportedMsg,
              error: unsupportedMsg,
            });
            continue;
          }

          const existingLayers = detectCompatibilityLayers({
            ...options,
            ...explicitHomedirOpt(options),
          });
          const alreadyLayer = existingLayers.find((/** @type {any} */ l) => l.type === runnerType);
          if (
            alreadyLayer &&
            !options.forceReinstall &&
            !task.forceUpdate &&
            !task.downloadUrl &&
            !task.dmgPath &&
            !task.archivePath
          ) {
            saveSetupWizardState(
              { preferredRunnerType: /** @type {any} */ (runnerType) },
              options
            );
            succeededComponents.push(componentId);
            try {
              if (typeof invalidateProberRunnerUpdatesCache === 'function') {
                invalidateProberRunnerUpdatesCache({ skipPreviewUrlCacheClear: true });
              }
            } catch {}
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: `${alreadyLayer.name} is already installed.`,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              installedPath: alreadyLayer.appPath || alreadyLayer.binaryPath,
              message: `${alreadyLayer.name} is already installed.`,
            });
            continue;
          }

          const res = await installRunnerDirect(runnerType, {
            ...options,
            dmgPath: task.dmgPath || options.dmgPath,
            archivePath: task.archivePath || options.archivePath,
            ...(task.downloadUrl || options.downloadUrl
              ? { downloadUrl: task.downloadUrl || options.downloadUrl }
              : {}),
            existingLayer: alreadyLayer || null,
            _runnerOperation: alreadyLayer ? 'update' : 'install',
            signal: controller.signal,
            _progressCtx: progressBase,
          });

          if (!res || res.success === false) {
            if (/** @type {any} */ (res)?.cancelled || controller.signal.aborted) {
              wasCancelled = true;
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'cancelled',
                  message: res?.message || 'Cancelled.',
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'cancelled',
                message: res?.message || 'Cancelled by user.',
              });
            } else {
              const failMsg =
                /** @type {any} */ (res)?.error ||
                res?.message ||
                `Failed to install ${runnerType}.`;
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'failed',
                  message: failMsg,
                  error: failMsg,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'failed',
                message: failMsg,
                error: failMsg,
              });
            }
          } else if (res.openedExternal) {
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'completed',
                openedExternalUrl: res.openedExternalUrl,
                message: res.message,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'opened_external',
              openedExternalUrl: res.openedExternalUrl,
              message: res.message,
            });
          } else if (res.alreadyUpToDate) {
            const currentWizardState = getSetupWizardState(options);
            if (!task.forceUpdate || !currentWizardState?.preferredRunnerType) {
              saveSetupWizardState(
                { preferredRunnerType: /** @type {any} */ (runnerType) },
                options
              );
            }
            succeededComponents.push(componentId);
            try {
              if (typeof invalidateProberRunnerUpdatesCache === 'function') {
                invalidateProberRunnerUpdatesCache({ skipPreviewUrlCacheClear: true });
              }
            } catch {}
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'skipped',
                message: res.message,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              ...(alreadyLayer?.appPath || alreadyLayer?.binaryPath
                ? { installedPath: alreadyLayer.appPath || alreadyLayer.binaryPath }
                : {}),
              message: res.message,
            });
          } else if (res.installed !== true) {
            if (res.authenticated && options.authenticateOnly === true) {
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'skipped',
                  message: res.message,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'skipped',
                message: res.message,
              });
            } else {
              const notInstalledMsg =
                res.message ||
                (res.authenticated
                  ? 'Authenticated with CodeWeavers Preview without installing runner.'
                  : `Runner ${runnerType} was not installed.`);
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'failed',
                  message: notInstalledMsg,
                  error: notInstalledMsg,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'failed',
                message: notInstalledMsg,
                error: notInstalledMsg,
              });
            }
          } else {
            const currentWizardState = getSetupWizardState(options);
            const nextPreferredRunnerType = res.switchedToStableCrossOver
              ? 'crossover'
              : runnerType;
            const shouldSavePreferredRunner =
              !task.forceUpdate ||
              !currentWizardState?.preferredRunnerType ||
              (res.switchedToStableCrossOver &&
                normalizeRequestedRunnerType(currentWizardState.preferredRunnerType) ===
                  'crossover_preview');
            if (shouldSavePreferredRunner) {
              saveSetupWizardState(
                {
                  preferredRunnerType: /** @type {any} */ (nextPreferredRunnerType),
                },
                options
              );
            }
            succeededComponents.push(componentId);
            try {
              if (typeof invalidateProberRunnerUpdatesCache === 'function') {
                invalidateProberRunnerUpdatesCache({ skipPreviewUrlCacheClear: true });
              }
            } catch {}
            emitEnvironmentSetupProgress(
              {
                ...progressBase,
                phase: 'completed',
                progressPercent: 100,
                message: res.message,
              },
              options
            );
            outcomes.push({
              componentId,
              action: task.action,
              status: 'completed',
              ...(res.installedPath ? { installedPath: res.installedPath } : {}),
              message: res.message,
            });
          }
          continue;
        }

        // -------------------------------------------------------------------
        // 4. Bottle Creation / Reuse & User Folder Sandboxing
        // -------------------------------------------------------------------
        if (task.action === 'ensure_bottle') {
          if (hostPlatform !== 'darwin') {
            outcomes.push({
              componentId,
              action: task.action,
              status: 'skipped',
              message: 'Windows bottles are only applicable on macOS.',
            });
            continue;
          }

          const hostArchForBottle = String(options.arch || process.arch || 'arm64').toLowerCase();
          const normalizedTaskRunnerForBottle = normalizeRequestedRunnerType(task.runnerType);
          if (
            normalizedTaskRunnerForBottle === 'crossover_preview_arm64' &&
            hostArchForBottle !== 'arm64'
          ) {
            throw new Error(
              'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
            );
          }

          if (
            task.bottleName !== undefined &&
            task.bottleName !== null &&
            String(task.bottleName).trim() !== '' &&
            !safeIsBottleSlug(String(task.bottleName).trim())
          ) {
            throw new Error(
              `Invalid bottle name "${task.bottleName}": must be a safe directory slug without path traversal or leading hyphens.`
            );
          }

          const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
            homedir,
            { runnerType: task.runnerType, bottleName: task.bottleName },
            options
          );

          if (
            layer.type === 'crossover_preview_arm64' &&
            (hostArchForBottle !== 'arm64' || layer.available === false)
          ) {
            throw new Error(
              'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
            );
          }

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'configuring_bottle',
              message: `Configuring Windows 10 64-bit bottle "${bottleName}"...`,
            },
            options
          );

          await ensureBottleInitializedInternal(
            layer,
            bottleName,
            bottlePath,
            options,
            controller.signal
          );

          saveSetupWizardState(
            {
              preferredRunnerType: layer.type,
              preferredBottleName: bottleName,
            },
            options
          );
          succeededComponents.push('bottle_default');
          invalidateScanCaches({ skipPreviewUrlCacheClear: true });

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: `Bottle "${bottleName}" is ready and sandboxed.`,
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            installedPath: bottlePath,
            message: `Bottle "${bottleName}" is ready and sandboxed.`,
          });
          continue;
        }

        // -------------------------------------------------------------------
        // 5. Host & Bottled Storefront Clients
        // -------------------------------------------------------------------
        if (task.action === 'install_client') {
          const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
          try {
            // A) Host Steam
            if (componentId === 'host_steam') {
              const existing = resolveSteamClientBinaryPath({
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existing && !options.forceReinstall) {
                succeededComponents.push('host_steam');
                emitEnvironmentSetupProgress(
                  { ...progressBase, phase: 'skipped', message: 'Steam is already installed.' },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existing,
                  message: 'Steam is already installed.',
                });
                continue;
              }

              if (hostPlatform === 'darwin') {
                const dmgPath = path.join(tempDir, 'steam.dmg');
                await streamVerifiedDownloadToFile(
                  'https://cdn.fastly.steamstatic.com/client/installer/steam.dmg',
                  dmgPath,
                  { ...progressBase, label: 'Steam for macOS', minFreeBytes: 400 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Valve Developer ID signature...',
                  },
                  options
                );
                const targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
                const installedPath = await mountVerifyAndInstallDmgApp(
                  dmgPath,
                  targetAppsDir,
                  ['MXGJJ98X76'],
                  /Developer ID Application:\s*Valve/i,
                  { ...options, _componentId: componentId }
                );
                succeededComponents.push('host_steam');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Steam to ${installedPath}.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath,
                  message: `Installed Steam to ${installedPath}.`,
                });
                continue;
              }

              if (hostPlatform === 'win32') {
                const exePath = path.join(tempDir, 'SteamSetup.exe');
                await streamVerifiedDownloadToFile(
                  'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe',
                  exePath,
                  { ...progressBase, label: 'Steam Installer', minFreeBytes: 500 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Valve Authenticode signature...',
                  },
                  options
                );
                await verifyWindowsInstallerSignature(exePath, {
                  ...options,
                  platform: 'win32',
                  kind: 'exe',
                  _componentId: componentId,
                });
                emitEnvironmentSetupProgress(
                  { ...progressBase, phase: 'installing', message: 'Installing Steam silently...' },
                  options
                );
                try {
                  await runExecFileAsync(execFileFn, exePath, ['/S'], {
                    timeout: 180000,
                    windowsHide: true,
                    signal: controller.signal,
                  });
                } catch (/** @type {any} */ execErr) {
                  if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                    throw execErr;
                  }
                }
                const installedBin =
                  resolveSteamClientBinaryPath({
                    ...options,
                    ...explicitHomedirOpt(options),
                    platform: 'win32',
                  }) || '';
                succeededComponents.push('host_steam');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed Steam Desktop Client.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(installedBin ? { installedPath: installedBin } : {}),
                  message: 'Installed Steam Desktop Client.',
                });
                continue;
              }

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'skipped',
                  message: `Automated Steam installation is not supported on ${hostPlatform}.`,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'skipped',
                message: `Automated Steam installation is not supported on ${hostPlatform}.`,
              });
              continue;
            }

            // B) Bottled Windows Steam (macOS)
            if (componentId === 'bottle_steam') {
              const { layer, bottleName, bottlePath } = resolveAndValidateBottleClientTarget(
                homedir,
                task,
                options
              );
              const existingSteam = resolveBottleSteamExe(bottlePath);
              if (existingSteam && !options.forceReinstall) {
                /** @type {{ linkedCount: number, linkedAppIds: number[], needsVdfSync?: boolean }} */
                let linkRes = { linkedCount: 0, linkedAppIds: [] };
                try {
                  linkRes = await linkInstalledSteamAppsIntoBottle(bottlePath, options);
                } catch (linkErr) {
                  diagLog.warn('runEnvironmentSetupTasks.linkInstalledSteamApps', linkErr, {
                    bottlePath,
                  });
                }

                let steamRestartRequired = false;
                let activeGameInBottle = false;
                let warmSteamRestarted = false;
                if (linkRes.linkedCount > 0 || linkRes.needsVdfSync) {
                  const warmSteamRunning = await isBottleWinExeRunning(
                    'steam.exe',
                    bottlePath,
                    options
                  ).catch(() => false);
                  if (warmSteamRunning) {
                    activeGameInBottle = await hasActiveGameSessionInBottle(bottlePath);
                    if (activeGameInBottle) {
                      steamRestartRequired = true;
                    } else {
                      emitEnvironmentSetupProgress(
                        {
                          ...progressBase,
                          phase: 'installing',
                          message: `Closing warm Windows Steam in "${bottleName}" to apply linked library...`,
                        },
                        options
                      );
                      await closeForegroundClientGracefully(
                        'bottle_steam',
                        {
                          scope: 'bottle',
                          bottlePath,
                          bottleName,
                          binaryPath: existingSteam,
                        },
                        hostPlatform,
                        layer,
                        options
                      ).catch(() => false);
                      const stillRunningAfterClose = await isBottleWinExeRunning(
                        'steam.exe',
                        bottlePath,
                        options
                      ).catch(() => false);
                      if (stillRunningAfterClose) {
                        steamRestartRequired = true;
                      } else {
                        warmSteamRestarted = true;
                        try {
                          const postCloseLinkRes = await linkInstalledSteamAppsIntoBottle(
                            bottlePath,
                            options
                          );
                          const mergedIds = Array.from(
                            new Set([
                              ...linkRes.linkedAppIds,
                              ...(postCloseLinkRes.linkedAppIds || []),
                            ])
                          ).sort((a, b) => a - b);
                          linkRes = {
                            linkedCount: mergedIds.length,
                            linkedAppIds: mergedIds,
                            ...(postCloseLinkRes.needsVdfSync ? { needsVdfSync: true } : {}),
                          };
                          if (linkRes.needsVdfSync) {
                            steamRestartRequired = true;
                          }
                        } catch (resyncErr) {
                          diagLog.warn(
                            'runEnvironmentSetupTasks.resyncAfterWarmSteamClose',
                            resyncErr,
                            { bottlePath }
                          );
                        }
                      }
                    }
                  }
                }

                invalidateScanCaches({ skipPreviewUrlCacheClear: true });
                succeededComponents.push('bottle_steam');
                let skipMsg =
                  linkRes.linkedCount > 0
                    ? `Windows Steam is already installed in "${bottleName}"; linked ${linkRes.linkedCount} existing Steam game${linkRes.linkedCount === 1 ? '' : 's'}.`
                    : warmSteamRestarted
                      ? `Windows Steam is already installed in "${bottleName}"; refreshed Steam library configuration.`
                      : `Windows Steam is already installed in "${bottleName}".`;
                if (steamRestartRequired) {
                  skipMsg = activeGameInBottle
                    ? `${skipMsg} Restart Steam in "${bottleName}" after your active game closes so Steam loads the newly linked library.`
                    : `${skipMsg} Restart Steam in "${bottleName}" so Steam loads the newly linked library.`;
                }
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: skipMsg,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingSteam,
                  ...(steamRestartRequired ? { steamRestartRequired: true } : {}),
                  message: skipMsg,
                });
                continue;
              }

              await ensureBottleReadyIfUninitialized(
                layer,
                bottleName,
                bottlePath,
                options,
                controller.signal
              );

              const stagedExe = path.join(tempDir, 'SteamSetup.exe');
              await streamVerifiedDownloadToFile(
                'https://cdn.fastly.steamstatic.com/client/installer/SteamSetup.exe',
                stagedExe,
                {
                  ...progressBase,
                  label: 'Windows Steam Installer',
                  minFreeBytes: 600 * 1024 * 1024,
                },
                options,
                controller.signal
              );

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: 'Verifying Windows Steam PE & Authenticode signature...',
                },
                options
              );
              await verifyWindowsInstallerSignature(stagedExe, {
                ...options,
                platform: 'darwin',
                kind: 'exe',
                _componentId: componentId,
              });

              const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
              await fs.promises.mkdir(bottleTempDir, { recursive: true });
              const bottleSetupExe = path.join(bottleTempDir, 'SteamSetup.exe');
              await fs.promises.copyFile(stagedExe, bottleSetupExe);

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing Windows Steam inside bottle "${bottleName}"...`,
                },
                options
              );
              try {
                const installedSteamExe = await runBottleInstallerAndWait(
                  layer,
                  bottleName,
                  bottlePath,
                  ['C:\\windows\\temp\\SteamSetup.exe', '/S'],
                  () => resolveBottleSteamExe(bottlePath),
                  options,
                  controller.signal
                );
                /** @type {{ linkedCount: number, linkedAppIds: number[] }} */
                let linkRes = { linkedCount: 0, linkedAppIds: [] };
                try {
                  linkRes = await linkInstalledSteamAppsIntoBottle(bottlePath, options);
                } catch (linkErr) {
                  diagLog.warn('runEnvironmentSetupTasks.linkInstalledSteamApps', linkErr, {
                    bottlePath,
                  });
                }
                invalidateScanCaches({ skipPreviewUrlCacheClear: true });
                succeededComponents.push('bottle_steam');
                const installMsg =
                  linkRes.linkedCount > 0
                    ? `Installed Windows Steam in bottle "${bottleName}" and linked ${linkRes.linkedCount} existing Steam game${linkRes.linkedCount === 1 ? '' : 's'}.`
                    : `Installed Windows Steam in bottle "${bottleName}".`;
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: installMsg,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: installedSteamExe,
                  message: installMsg,
                });
              } finally {
                try {
                  await fs.promises.rm(bottleSetupExe, { force: true });
                } catch {}
              }
              continue;
            }

            // C) Host GOG Galaxy
            if (componentId === 'host_gog') {
              const existingGog = resolveGogGalaxyClientBinaryPath({
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existingGog && !options.forceReinstall) {
                succeededComponents.push('host_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: 'GOG Galaxy is already installed.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingGog,
                  message: 'GOG Galaxy is already installed.',
                });
                continue;
              }

              if (hostPlatform === 'darwin') {
                const pkgPath = path.join(tempDir, 'GOG_Galaxy_2.0.pkg');
                await downloadGogGalaxyInstallerToFile(
                  'osx',
                  pkgPath,
                  {
                    ...progressBase,
                    label: 'GOG Galaxy for macOS',
                    minFreeBytes: 600 * 1024 * 1024,
                  },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying GOG Apple Installer package signature...',
                  },
                  options
                );
                await verifyMacPkgSignature(pkgPath, {
                  ...options,
                  _componentId: componentId,
                });

                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'installing',
                    message:
                      'Opening macOS Installer for GOG Galaxy (complete prompt to finish)...',
                  },
                  options
                );
                await runExecFileAsync(execFileFn, '/usr/bin/open', ['-W', pkgPath], {
                  timeout: 600000,
                  signal: controller.signal,
                });

                const postBin = resolveGogGalaxyClientBinaryPath({
                  ...options,
                  ...explicitHomedirOpt(options),
                  platform: 'darwin',
                });
                if (!postBin && !isTestEnvironment(options)) {
                  throw new Error(
                    'macOS Installer closed before GOG Galaxy.app was installed.'
                  );
                }
                try {
                  syncGogFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('host_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed GOG Galaxy for macOS.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(postBin ? { installedPath: postBin } : {}),
                  message: 'Installed GOG Galaxy for macOS.',
                });
                continue;
              }

              if (hostPlatform === 'win32') {
                const exePath = path.join(tempDir, 'GOG_Galaxy_Setup.exe');
                const dlRes = await downloadGogGalaxyInstallerToFile(
                  'windows',
                  exePath,
                  { ...progressBase, label: 'GOG Galaxy', minFreeBytes: 600 * 1024 * 1024 },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying GOG Authenticode signature...',
                  },
                  options
                );
                await verifyWindowsInstallerSignature(exePath, {
                  ...options,
                  ...(dlRes.isStubWebInstaller && options.minInstallerBytes === undefined
                    ? { minInstallerBytes: 128 * 1024 }
                    : {}),
                  platform: 'win32',
                  kind: 'exe',
                  _componentId: componentId,
                });
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'installing',
                    message: 'Installing GOG Galaxy silently...',
                  },
                  options
                );
                try {
                  await runExecFileAsync(
                    execFileFn,
                    exePath,
                    ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
                    { timeout: 300000, windowsHide: true, signal: controller.signal }
                  );
                } catch (/** @type {any} */ execErr) {
                  if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                    throw execErr;
                  }
                }
                try {
                  syncGogFirstPartyLauncher(options);
                } catch {}
                const installedGog =
                  resolveGogGalaxyClientBinaryPath({
                    ...options,
                    ...explicitHomedirOpt(options),
                    platform: 'win32',
                  }) || '';
                succeededComponents.push('host_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed GOG Galaxy.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(installedGog ? { installedPath: installedGog } : {}),
                  message: 'Installed GOG Galaxy.',
                });
                continue;
              }

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'skipped',
                  message: `Automated GOG Galaxy installation is not supported on ${hostPlatform}.`,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'skipped',
                message: `Automated GOG Galaxy installation is not supported on ${hostPlatform}.`,
              });
              continue;
            }

            // D) Bottled GOG Galaxy (macOS)
            if (componentId === 'bottle_gog') {
              const { layer, bottleName, bottlePath } = resolveAndValidateBottleClientTarget(
                homedir,
                task,
                options
              );
              const existingGog = resolveBottleGogGalaxyExe(bottlePath);
              if (existingGog && !options.forceReinstall) {
                succeededComponents.push('bottle_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `GOG Galaxy is already installed in "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingGog,
                  message: `GOG Galaxy is already installed in "${bottleName}".`,
                });
                continue;
              }

              await ensureBottleReadyIfUninitialized(
                layer,
                bottleName,
                bottlePath,
                options,
                controller.signal
              );

              const stagedExe = path.join(tempDir, 'GOG_Galaxy_Setup.exe');
              const dlRes = await downloadGogGalaxyInstallerToFile(
                'windows',
                stagedExe,
                {
                  ...progressBase,
                  label: 'Windows GOG Galaxy Installer',
                  minFreeBytes: 650 * 1024 * 1024,
                },
                options,
                controller.signal
              );

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: 'Verifying GOG Galaxy PE & Authenticode signature...',
                },
                options
              );
              await verifyWindowsInstallerSignature(stagedExe, {
                ...options,
                ...(dlRes.isStubWebInstaller && options.minInstallerBytes === undefined
                  ? { minInstallerBytes: 128 * 1024 }
                  : {}),
                platform: 'darwin',
                kind: 'exe',
                _componentId: componentId,
              });

              const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
              await fs.promises.mkdir(bottleTempDir, { recursive: true });
              const bottleSetupExe = path.join(bottleTempDir, 'GOG_Galaxy_Setup.exe');
              await fs.promises.copyFile(stagedExe, bottleSetupExe);

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing GOG Galaxy inside bottle "${bottleName}"...`,
                },
                options
              );
              try {
                const installedGogExe = await runBottleInstallerAndWait(
                  layer,
                  bottleName,
                  bottlePath,
                  [
                    'C:\\windows\\temp\\GOG_Galaxy_Setup.exe',
                    '/VERYSILENT',
                    '/SUPPRESSMSGBOXES',
                    '/NORESTART',
                  ],
                  () => resolveBottleGogGalaxyExe(bottlePath),
                  options,
                  controller.signal
                );
                try {
                  syncGogFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('bottle_gog');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Windows GOG Galaxy in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: installedGogExe,
                  message: `Installed Windows GOG Galaxy in bottle "${bottleName}".`,
                });
              } finally {
                try {
                  await fs.promises.rm(bottleSetupExe, { force: true });
                } catch {}
              }
              continue;
            }

            // E) Host Epic Games Launcher
            if (componentId === 'host_epic') {
              const existingEpic = resolveEpicClientBinaryPath({
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (existingEpic && !options.forceReinstall) {
                succeededComponents.push('host_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: 'Epic Games Launcher is already installed.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingEpic,
                  message: 'Epic Games Launcher is already installed.',
                });
                continue;
              }

              if (hostPlatform === 'darwin') {
                const dmgPath = path.join(tempDir, 'EpicGamesLauncher.dmg');
                await streamVerifiedDownloadToFile(
                  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncher.dmg',
                  dmgPath,
                  {
                    ...progressBase,
                    label: 'Epic Games Launcher for macOS',
                    minFreeBytes: 1200 * 1024 * 1024,
                  },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Epic Games Developer ID signature...',
                  },
                  options
                );
                const targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
                const installedPath = await mountVerifyAndInstallDmgApp(
                  dmgPath,
                  targetAppsDir,
                  ['96DBZ92D3Y'],
                  /Developer ID Application:\s*Epic Games/i,
                  { ...options, _componentId: componentId }
                );
                try {
                  syncEpicFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('host_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Epic Games Launcher to ${installedPath}.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath,
                  message: `Installed Epic Games Launcher to ${installedPath}.`,
                });
                continue;
              }

              if (hostPlatform === 'win32') {
                const msiPath = path.join(tempDir, 'EpicGamesLauncherInstaller.msi');
                await streamVerifiedDownloadToFile(
                  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi',
                  msiPath,
                  {
                    ...progressBase,
                    label: 'Epic Games Launcher Installer',
                    minFreeBytes: 1200 * 1024 * 1024,
                  },
                  options,
                  controller.signal
                );
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'verifying_signature',
                    message: 'Verifying Epic Games Authenticode signature...',
                  },
                  options
                );
                await verifyWindowsInstallerSignature(msiPath, {
                  ...options,
                  platform: 'win32',
                  kind: 'msi',
                  _componentId: componentId,
                });
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'installing',
                    message: 'Installing Epic Games Launcher silently...',
                  },
                  options
                );
                try {
                  await runExecFileAsync(
                    execFileFn,
                    'msiexec.exe',
                    ['/i', msiPath, '/qn', '/norestart'],
                    { timeout: 300000, windowsHide: true, signal: controller.signal }
                  );
                } catch (/** @type {any} */ execErr) {
                  if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
                    throw execErr;
                  }
                }
                try {
                  syncEpicFirstPartyLauncher(options);
                } catch {}
                const installedEpic =
                  resolveEpicClientBinaryPath({
                    ...options,
                    ...explicitHomedirOpt(options),
                    platform: 'win32',
                  }) || '';
                succeededComponents.push('host_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: 'Installed Epic Games Launcher.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  ...(installedEpic ? { installedPath: installedEpic } : {}),
                  message: 'Installed Epic Games Launcher.',
                });
                continue;
              }

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'skipped',
                  message: `Automated Epic Games Launcher installation is not supported on ${hostPlatform}.`,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'skipped',
                message: `Automated Epic Games Launcher installation is not supported on ${hostPlatform}.`,
              });
              continue;
            }

            // F) Bottled Epic Games Launcher (macOS)
            if (componentId === 'bottle_epic') {
              const { layer, bottleName, bottlePath } = resolveAndValidateBottleClientTarget(
                homedir,
                task,
                options
              );
              const existingEpic = resolveBottleEpicLauncherExe(bottlePath);
              if (existingEpic && !options.forceReinstall) {
                succeededComponents.push('bottle_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `Epic Games Launcher is already installed in "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingEpic,
                  message: `Epic Games Launcher is already installed in "${bottleName}".`,
                });
                continue;
              }

              await ensureBottleReadyIfUninitialized(
                layer,
                bottleName,
                bottlePath,
                options,
                controller.signal
              );

              const stagedMsi = path.join(tempDir, 'EpicGamesLauncherInstaller.msi');
              await streamVerifiedDownloadToFile(
                'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi',
                stagedMsi,
                {
                  ...progressBase,
                  label: 'Windows Epic Games Launcher MSI',
                  minFreeBytes: 1200 * 1024 * 1024,
                },
                options,
                controller.signal
              );

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'verifying_signature',
                  message: 'Verifying Epic Games MSI package header...',
                },
                options
              );
              await verifyWindowsInstallerSignature(stagedMsi, {
                ...options,
                platform: 'darwin',
                kind: 'msi',
                _componentId: componentId,
              });

              const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
              await fs.promises.mkdir(bottleTempDir, { recursive: true });
              const bottleMsiPath = path.join(bottleTempDir, 'EpicGamesLauncherInstaller.msi');
              await fs.promises.copyFile(stagedMsi, bottleMsiPath);

              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'installing',
                  message: `Installing Epic Games Launcher inside bottle "${bottleName}"...`,
                },
                options
              );
              try {
                const installedEpicExe = await runBottleInstallerAndWait(
                  layer,
                  bottleName,
                  bottlePath,
                  [
                    'msiexec',
                    '/i',
                    'C:\\windows\\temp\\EpicGamesLauncherInstaller.msi',
                    '/qn',
                    '/norestart',
                  ],
                  () => resolveBottleEpicLauncherExe(bottlePath),
                  options,
                  controller.signal
                );
                try {
                  syncEpicFirstPartyLauncher(options);
                } catch {}
                succeededComponents.push('bottle_epic');
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed Windows Epic Games Launcher in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: installedEpicExe,
                  message: `Installed Windows Epic Games Launcher in bottle "${bottleName}".`,
                });
              } finally {
                try {
                  await fs.promises.rm(bottleMsiPath, { force: true });
                } catch {}
              }
              continue;
            }

            // G) Chained Publisher Launchers (Ubisoft Connect, EA App, Battle.net, Rockstar, Riot)
            if (
              componentId === 'host_ubisoft' ||
              componentId === 'bottle_ubisoft' ||
              componentId === 'host_ea' ||
              componentId === 'bottle_ea' ||
              componentId === 'host_bnet' ||
              componentId === 'bottle_bnet' ||
              componentId === 'host_rockstar' ||
              componentId === 'bottle_rockstar' ||
              componentId === 'host_riot'
            ) {
              const pubHandoffId = /** @type {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} */ (
                normalizeChainedHandoffId(componentId)
              );
              const pubEcosystem = CHAINED_PUBLISHER_ECOSYSTEMS[pubHandoffId];
              const isBottleScope = componentId.startsWith('bottle_');

              if (isBottleScope) {
                if (hostPlatform !== 'darwin') {
                  emitEnvironmentSetupProgress(
                    {
                      ...progressBase,
                      phase: 'skipped',
                      message: `${pubEcosystem.displayName} bottle installation is only applicable on macOS.`,
                    },
                    options
                  );
                  outcomes.push({
                    componentId,
                    action: task.action,
                    status: 'skipped',
                    message: `${pubEcosystem.displayName} bottle installation is only applicable on macOS.`,
                  });
                  continue;
                }

                const { layer, bottleName, bottlePath } = resolveAndValidateBottleClientTarget(
                  homedir,
                  task,
                  options
                );
                await ensureBottleInitializedInternal(
                  layer,
                  bottleName,
                  bottlePath,
                  options,
                  controller.signal
                );

                const existingBottlePub = discoverBottlePublisherLauncher(bottlePath, pubHandoffId);
                if (
                  existingBottlePub.installed &&
                  existingBottlePub.binaryPath &&
                  !options.forceReinstall
                ) {
                  succeededComponents.push(componentId);
                  emitEnvironmentSetupProgress(
                    {
                      ...progressBase,
                      phase: 'skipped',
                      message: `${pubEcosystem.displayName} is already installed in "${bottleName}".`,
                    },
                    options
                  );
                  outcomes.push({
                    componentId,
                    action: task.action,
                    status: 'skipped',
                    installedPath: existingBottlePub.binaryPath,
                    message: `${pubEcosystem.displayName} is already installed in "${bottleName}".`,
                  });
                  continue;
                }

                const provisionedBottle = await provisionVerifiedChainedPublisherClient(
                  {
                    handoffId: pubHandoffId,
                    scope: 'bottle',
                    componentId,
                    progressBase,
                    tempDir,
                    layer,
                    bottleName,
                    bottlePath,
                    signal: controller.signal,
                  },
                  options
                );

                succeededComponents.push(componentId);
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    progressPercent: 100,
                    message: `Installed ${pubEcosystem.displayName} in bottle "${bottleName}".`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'completed',
                  installedPath: provisionedBottle.binaryPath,
                  message: `Installed ${pubEcosystem.displayName} in bottle "${bottleName}".`,
                });
                continue;
              }

              const existingHostPub = discoverHostPublisherLauncher(pubHandoffId, {
                ...options,
                ...explicitHomedirOpt(options),
                platform: hostPlatform,
              });
              if (
                existingHostPub.installed &&
                existingHostPub.binaryPath &&
                !options.forceReinstall
              ) {
                succeededComponents.push(componentId);
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `${pubEcosystem.displayName} is already installed.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  installedPath: existingHostPub.binaryPath,
                  message: `${pubEcosystem.displayName} is already installed.`,
                });
                continue;
              }

              if (hostPlatform === 'darwin' && componentId === 'host_bnet') {
                const extUrl = 'https://download.battle.net/?product=bnetdesk';
                await openExternalUri(extUrl, options);
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'completed',
                    openedExternalUrl: extUrl,
                    message: 'Opened Battle.net for macOS download page.',
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'opened_external',
                  openedExternalUrl: extUrl,
                  message: 'Opened Battle.net for macOS download page.',
                });
                continue;
              }

              if (hostPlatform !== 'win32') {
                emitEnvironmentSetupProgress(
                  {
                    ...progressBase,
                    phase: 'skipped',
                    message: `${pubEcosystem.displayName} native host client is only applicable on Windows.`,
                  },
                  options
                );
                outcomes.push({
                  componentId,
                  action: task.action,
                  status: 'skipped',
                  message: `${pubEcosystem.displayName} native host client is only applicable on Windows.`,
                });
                continue;
              }

              const provisionedHost = await provisionVerifiedChainedPublisherClient(
                {
                  handoffId: pubHandoffId,
                  scope: 'host',
                  componentId,
                  progressBase,
                  tempDir,
                  signal: controller.signal,
                },
                options
              );

              succeededComponents.push(componentId);
              emitEnvironmentSetupProgress(
                {
                  ...progressBase,
                  phase: 'completed',
                  progressPercent: 100,
                  message: `Installed ${pubEcosystem.displayName}.`,
                },
                options
              );
              outcomes.push({
                componentId,
                action: task.action,
                status: 'completed',
                installedPath: provisionedHost.binaryPath,
                message: `Installed ${pubEcosystem.displayName}.`,
              });
              continue;
            }

            throw new Error(`Unsupported client componentId: ${componentId}`);
          } finally {
            try {
              await fs.promises.rm(tempDir, { recursive: true, force: true });
            } catch {}
          }
        }

        // -------------------------------------------------------------------
        // 6. Sync First-Party Manifests
        // -------------------------------------------------------------------
        if (task.action === 'sync_first_party_manifests') {
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'installing',
              message: 'Synchronizing installed game manifests with storefront clients...',
            },
            options
          );
          try {
            syncGogFirstPartyLauncher(options);
          } catch {}
          try {
            syncEpicFirstPartyLauncher(options);
          } catch {}
          invalidateScanCaches({ skipPreviewUrlCacheClear: true });

          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'completed',
              progressPercent: 100,
              message: 'Synchronized first-party launcher manifests.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'completed',
            message: 'Synchronized first-party launcher manifests.',
          });
          continue;
        }

        throw new Error(`Unknown setup task action: ${task.action}`);
      } catch (/** @type {any} */ taskErr) {
        const isAbort = taskErr?.name === 'AbortError' || controller.signal.aborted;
        const errMsg = taskErr instanceof Error ? taskErr.message : String(taskErr);

        if (isAbort) {
          wasCancelled = true;
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'cancelled',
              message: 'Task cancelled.',
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'cancelled',
            message: 'Cancelled by user.',
          });
        } else {
          diagLog.warn('environmentProvisioner.taskFailed', taskErr, {
            runId,
            componentId,
            action: task.action,
          });
          emitEnvironmentSetupProgress(
            {
              ...progressBase,
              phase: 'failed',
              message: errMsg,
              error: errMsg,
            },
            options
          );
          outcomes.push({
            componentId,
            action: task.action,
            status: 'failed',
            message: errMsg,
            error: errMsg,
          });
        }
      }
    }
  } finally {
    activeSetupRuns.delete(runId);
  }

  if (succeededComponents.length > 0) {
    try {
      saveSetupWizardState(
        {
          addConfiguredComponents: /** @type {any} */ (succeededComponents),
          lastHealthCheckAt: new Date().toISOString(),
        },
        options
      );
    } catch {}
  }

  invalidateScanCaches({ skipPreviewUrlCacheClear: true });
  const snapshot = await probeEnvironmentHealth({
    ...options,
    forceRefreshRunnerUpdates: true,
    ...(Array.isArray(payload?.connectedStorefronts)
      ? { connectedStorefronts: payload.connectedStorefronts }
      : {}),
  });

  const hasFailures = outcomes.some((o) => o.status === 'failed');
  return {
    success: !hasFailures && !wasCancelled,
    runId,
    ...(wasCancelled ? { cancelled: true } : {}),
    outcomes,
    snapshot,
    ...(hasFailures
      ? {
          error: outcomes
            .filter((o) => o.status === 'failed')
            .map((o) => o.error || o.message)
            .join('; '),
        }
      : {}),
  };
}

/**
 * Cancel an active guided client login watcher by `targetId` (or all active watchers if omitted).
 *
 * @param {string} [targetId]
 * @param {Record<string, any>} [_options]
 * @returns {{ success: boolean, targetId?: string, cancelled: boolean }}
 */
function cancelGuidedClientLogin(targetId, _options = {}) {
  if (typeof targetId === 'string' && targetId.trim()) {
    const clean = targetId.trim();
    const entry = activeGuidedLogins.get(clean);
    if (!entry) {
      return { success: false, targetId: clean, cancelled: false };
    }
    entry.abortController.abort();
    return { success: true, targetId: clean, cancelled: true };
  }

  let any = false;
  for (const [, entry] of activeGuidedLogins.entries()) {
    entry.abortController.abort();
    any = true;
  }
  return { success: any, cancelled: any };
}

/**
 * Gracefully shut down a foreground storefront client after guided login succeeds so 0 MB
 * background RAM remains while preserving its newly written login session on disk.
 * Uses explicit `switch` statements returning `false` for unsupported targets (never falling
 * through to kill unrelated clients like Epic Games Launcher).
 *
 * @param {string} targetId
 * @param {any} probeState
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {any} bottleLayer
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function closeForegroundClientGracefully(
  targetId,
  probeState,
  hostPlatform,
  bottleLayer,
  options = {}
) {
  if (typeof options.closeClientFn === 'function') {
    await options.closeClientFn({ targetId, probeState, hostPlatform, bottleLayer });
    return true;
  }

  const execFileFn = getExecFileFn(options);
  try {
    if (probeState.scope === 'bottle' && probeState.bottlePath && bottleLayer?.binaryPath) {
      /** @type {Record<string, any>} */
      const bottleEnv = {
        ...process.env,
        WINEPREFIX: probeState.bottlePath,
        ...(probeState.bottleName ? { CX_BOTTLE: probeState.bottleName } : {}),
      };
      applyCrossOverEnvironmentHygiene(bottleEnv, {
        wineBinaryPath: bottleLayer.binaryPath,
        compatLayer: bottleLayer,
        layerType: bottleLayer.type,
        homedir: options.homedir,
        platform: 'darwin',
      });
      const alignedClose = prepareAlignedAuxBottleWineCommand({
        wineBinary: bottleLayer.binaryPath,
        bottlePath: probeState.bottlePath,
        env: bottleEnv,
        suppressGuiDialogs: true,
        layerType: bottleLayer.type,
      });
      const closeWineBin = alignedClose.binaryPath;
      const closeBottleEnv = alignedClose.env;

      if (targetId === 'bottle_steam' && probeState.binaryPath) {
        await runExecFileAsync(
          execFileFn,
          closeWineBin,
          [probeState.binaryPath, '-shutdown'],
          { timeout: 15000, env: closeBottleEnv }
        ).catch(() => {});
        await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
          bottleName: probeState.bottleName,
          execFileFn,
        }).catch(() => {});
        return true;
      }

      if (targetId === 'bottle_gog') {
        if (probeState.binaryPath) {
          await runExecFileAsync(
            execFileFn,
            closeWineBin,
            [probeState.binaryPath, '/command=shutdown'],
            { timeout: 8000, env: closeBottleEnv }
          ).catch(() => {});
          const settleMs = isTestEnvironment(options) ? 10 : 1200;
          await cancellableSleep(settleMs);
        }
        for (const gogExe of ['GalaxyClient.exe', 'GalaxyCommunication.exe']) {
          await runExecFileAsync(
            execFileFn,
            closeWineBin,
            ['taskkill', '/F', '/T', '/IM', gogExe],
            { timeout: 6000, env: closeBottleEnv }
          ).catch(() => {});
        }
        await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
          bottleName: probeState.bottleName,
          execFileFn,
        }).catch(() => {});
        return true;
      }

      /** @type {string[] | null} */
      let bottleKillImages = null;
      switch (targetId) {
        case 'bottle_epic':
          bottleKillImages = ['EpicGamesLauncher.exe'];
          break;
        case 'bottle_ubisoft':
          bottleKillImages = ['upc.exe', 'UbisoftConnect.exe', 'UplayWebCore.exe'];
          break;
        case 'bottle_ea':
          bottleKillImages = [
            'EADesktop.exe',
            'EALauncher.exe',
            'EACefSubProcess.exe',
            'EALocalHostSvc.exe',
            'Link2EA.exe',
            'EABackgroundService.exe',
          ];
          break;
        case 'bottle_bnet':
          bottleKillImages = ['Battle.net.exe', 'Agent.exe'];
          break;
        case 'bottle_rockstar':
          bottleKillImages = ['Launcher.exe', 'LauncherPatcher.exe', 'SocialClubHelper.exe'];
          break;
        default:
          return false;
      }

      for (const img of bottleKillImages) {
        await runExecFileAsync(execFileFn, closeWineBin, ['taskkill', '/IM', img], {
          timeout: 5000,
          env: closeBottleEnv,
        }).catch(() => {});
        await runExecFileAsync(execFileFn, closeWineBin, ['taskkill', '/F', '/T', '/IM', img], {
          timeout: 6000,
          env: closeBottleEnv,
        }).catch(() => {});
      }
      await shutdownWinePrefix(bottleLayer.binaryPath, probeState.bottlePath, 5000, {
        bottleName: probeState.bottleName,
        execFileFn,
      }).catch(() => {});
      if (
        probeState.bottlePath &&
        (targetId === 'bottle_ubisoft' ||
          targetId === 'bottle_ea' ||
          targetId === 'bottle_bnet' ||
          targetId === 'bottle_rockstar')
      ) {
        sanitizeChainedPublisherAutostartInBottleRegs(probeState.bottlePath);
      }
      return true;
    }

    if (hostPlatform === 'darwin') {
      /** @type {string | null} */
      let macAppName = null;
      switch (targetId) {
        case 'host_steam':
          macAppName = 'Steam';
          break;
        case 'host_gog':
          macAppName = 'GOG Galaxy';
          break;
        case 'host_epic':
          macAppName = 'Epic Games Launcher';
          break;
        case 'host_ea':
          macAppName = 'EA app';
          break;
        case 'host_bnet':
          macAppName = 'Battle.net';
          break;
        case 'host_riot':
          macAppName = 'Riot Client';
          break;
        default:
          return false;
      }
      await runExecFileAsync(
        execFileFn,
        '/usr/bin/osascript',
        ['-e', `quit app "${macAppName}"`],
        { timeout: 10000 }
      ).catch(() => {});
      return true;
    }

    if (hostPlatform === 'win32') {
      if (targetId === 'host_steam' && probeState.binaryPath) {
        await runExecFileAsync(execFileFn, probeState.binaryPath, ['-shutdown'], {
          timeout: 12000,
          windowsHide: true,
        }).catch(() => {});
        return true;
      }
      if (targetId === 'host_gog') {
        if (probeState.binaryPath) {
          await runExecFileAsync(execFileFn, probeState.binaryPath, ['/command=shutdown'], {
            timeout: 8000,
            windowsHide: true,
          }).catch(() => {});
          const settleMs = isTestEnvironment(options) ? 10 : 1200;
          await cancellableSleep(settleMs);
        }
        for (const winGogExe of ['GalaxyClient.exe', 'GalaxyCommunication.exe']) {
          await runExecFileAsync(execFileFn, 'taskkill.exe', ['/F', '/T', '/IM', winGogExe], {
            timeout: 6000,
            windowsHide: true,
          }).catch(() => {});
        }
        return true;
      }

      /** @type {string[] | null} */
      let winKillImages = null;
      switch (targetId) {
        case 'host_epic':
          winKillImages = ['EpicGamesLauncher.exe'];
          break;
        case 'host_ubisoft':
          winKillImages = ['upc.exe', 'UbisoftConnect.exe', 'UplayWebCore.exe'];
          break;
        case 'host_ea':
          winKillImages = [
            'EADesktop.exe',
            'EALauncher.exe',
            'EACefSubProcess.exe',
            'EALocalHostSvc.exe',
            'Link2EA.exe',
            'EABackgroundService.exe',
          ];
          break;
        case 'host_bnet':
          winKillImages = ['Battle.net.exe'];
          break;
        case 'host_rockstar':
          winKillImages = ['Launcher.exe', 'LauncherPatcher.exe'];
          break;
        case 'host_riot':
          winKillImages = [
            'RiotClientServices.exe',
            'RiotClientUx.exe',
            'RiotClientCrashHandler.exe',
          ];
          break;
        default:
          return false;
      }

      for (const img of winKillImages) {
        await runExecFileAsync(execFileFn, 'taskkill.exe', ['/IM', img], {
          timeout: 5000,
          windowsHide: true,
        }).catch(() => {});
        await runExecFileAsync(execFileFn, 'taskkill.exe', ['/F', '/T', '/IM', img], {
          timeout: 6000,
          windowsHide: true,
        }).catch(() => {});
      }
      return true;
    }
  } catch {}
  return false;
}

/**
 * Launch a storefront client in foreground interactive sign-in mode (WITHOUT `-silent`),
 * watch its local session files until sign-in completes, sync first-party manifests, and
 * optionally close the foreground client window cleanly afterward.
 *
 * @param {any} payload
 * @param {Record<string, any>} [options]
 * @returns {Promise<any>}
 */
async function startGuidedClientLogin(payload, options = {}) {
  const targetId = /** @type {import('./installerNetworkAndGuardrails.cjs').ClientLoginTargetId} */ (
    String(payload?.targetId || '').trim()
  );
  if (!VALID_CLIENT_LOGIN_TARGETS.has(targetId)) {
    throw new Error(`Invalid guided login targetId: "${targetId}"`);
  }

  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const rawRequestedRunner =
    typeof payload?.runnerType === 'string' ? payload.runnerType.trim() : '';
  const normalizedRequestedRunner = normalizeRequestedRunnerType(rawRequestedRunner);
  const hasExplicitAutoRunner = Boolean(rawRequestedRunner) && normalizedRequestedRunner === '';

  const probeOpts = {
    ...options,
    ...explicitHomedirOpt(options),
    platform: hostPlatform,
    ...(normalizedRequestedRunner
      ? { preferredRunnerType: normalizedRequestedRunner }
      : hasExplicitAutoRunner
        ? { preferredRunnerType: 'skip' }
        : {}),
    ...(payload?.bottleName ? { preferredBottleName: payload.bottleName } : {}),
  };

  const initialStates = await probeClientLoginStates(probeOpts);
  const initialState = initialStates[targetId];
  const forceInteractive =
    payload?.forceInteractiveLogin === true || options.forceInteractiveLogin === true;

  if (
    initialState.authenticated &&
    initialState.accountMatchesOneLauncher !== false &&
    !forceInteractive
  ) {
    return {
      success: true,
      targetId,
      authenticated: true,
      autoClosedClient: false,
      probeState: initialState,
      message: 'Already signed in.',
    };
  }

  if (!initialState.installed || !initialState.binaryPath) {
    return {
      success: false,
      targetId,
      authenticated: false,
      probeState: initialState,
      message: `${initialState.label} is not installed yet.`,
      error: 'Client not installed.',
    };
  }

  cancelGuidedClientLogin(targetId);

  const abortController = new AbortController();
  const runId = `guided-login-${targetId}-${Date.now()}`;
  activeGuidedLogins.set(targetId, { abortController, runId });

  /** @type {any} */
  let bottleLayer = null;
  if (initialState.scope === 'bottle') {
    const hostArch = String(options.arch || process.arch || 'arm64').toLowerCase();
    if (
      normalizedRequestedRunner === 'crossover_preview_arm64' &&
      hostPlatform === 'darwin' &&
      hostArch !== 'arm64'
    ) {
      activeGuidedLogins.delete(targetId);
      const archErrMsg =
        'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.';
      return {
        success: false,
        targetId,
        authenticated: false,
        probeState: initialState,
        message: archErrMsg,
        error: archErrMsg,
      };
    }
    const runners = detectCompatibilityLayers({
      ...options,
      ...explicitHomedirOpt(options),
    });
    const matchedLayer = normalizedRequestedRunner
      ? runners.find(
          (/** @type {any} */ r) =>
            r && (r.type === normalizedRequestedRunner || r.id === normalizedRequestedRunner)
        )
      : null;
    if (normalizedRequestedRunner) {
      if (!matchedLayer) {
        activeGuidedLogins.delete(targetId);
        const missingMsg = `Compatibility runner "${normalizedRequestedRunner}" is not installed.`;
        return {
          success: false,
          targetId,
          authenticated: false,
          probeState: initialState,
          message: missingMsg,
          error: missingMsg,
        };
      }
      if (
        matchedLayer.available === false ||
        (matchedLayer.type === 'crossover_preview_arm64' && hostArch !== 'arm64')
      ) {
        activeGuidedLogins.delete(targetId);
        const unavailMsg =
          matchedLayer.type === 'crossover_preview_arm64'
            ? 'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
            : `Compatibility runner "${normalizedRequestedRunner}" is unavailable on this host.`;
        return {
          success: false,
          targetId,
          authenticated: false,
          probeState: initialState,
          message: unavailMsg,
          error: unavailMsg,
        };
      }
    }
    bottleLayer =
      matchedLayer ||
      runners.find(
        (/** @type {any} */ r) =>
          r &&
          r.available !== false &&
          !(r.type === 'crossover_preview_arm64' && hostArch !== 'arm64')
      ) ||
      null;
    if (!bottleLayer?.binaryPath) {
      activeGuidedLogins.delete(targetId);
      const onlyUnsupportedArm64 =
        hostArch !== 'arm64' &&
        runners.some((/** @type {any} */ r) => r && r.type === 'crossover_preview_arm64');
      const errMsg = onlyUnsupportedArm64
        ? 'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
        : 'No compatibility runner available to launch bottled client.';
      return {
        success: false,
        targetId,
        authenticated: false,
        probeState: initialState,
        message: errMsg,
        error: onlyUnsupportedArm64 ? errMsg : 'Compatibility runner missing.',
      };
    }
  }

  try {
    if (typeof options.spawnClientFn === 'function') {
      await options.spawnClientFn({
        targetId,
        probeState: initialState,
        hostPlatform,
        bottleLayer,
      });
    } else if (initialState.scope === 'bottle' && bottleLayer?.binaryPath) {
      const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
      const pubHandoffId = normalizeChainedHandoffId(targetId);
      const pubDescriptor = pubHandoffId ? CHAINED_PUBLISHER_ECOSYSTEMS[pubHandoffId] : null;
      const extraClientArgs = pubDescriptor?.wineClientArgs ? [...pubDescriptor.wineClientArgs] : [];
      const extraEnvOverrides = pubDescriptor?.wineEnvOverrides
        ? { ...pubDescriptor.wineEnvOverrides }
        : {};
      /** @type {Record<string, any>} */
      const guidedBottleEnv = {
        ...process.env,
        ...(initialState.bottlePath ? { WINEPREFIX: initialState.bottlePath } : {}),
        ...(initialState.bottleName ? { CX_BOTTLE: initialState.bottleName } : {}),
        ...extraEnvOverrides,
      };
      if (initialState.bottlePath) {
        alignWineMsyncWithLiveBottle(initialState.bottlePath, guidedBottleEnv);
      }
      prepareCrossOverWineSpawnEnv(bottleLayer.binaryPath, guidedBottleEnv);
      applyCrossOverEnvironmentHygiene(guidedBottleEnv, {
        wineBinaryPath: bottleLayer.binaryPath,
        compatLayer: bottleLayer,
        layerType: bottleLayer.type,
        homedir,
        platform: 'darwin',
      });
      const guidedDllOverrides = String(guidedBottleEnv.WINEDLLOVERRIDES || '').trim();
      const guidedWineArgs =
        guidedDllOverrides &&
        isCrossOverPerlWineWrapperOptions({
          binaryPath: bottleLayer.binaryPath,
          layerType: bottleLayer.type,
        })
          ? ['--dll', guidedDllOverrides, initialState.binaryPath, ...extraClientArgs]
          : [initialState.binaryPath, ...extraClientArgs];
      const child = spawnImpl(bottleLayer.binaryPath, guidedWineArgs, {
        detached: true,
        stdio: 'ignore',
        env: guidedBottleEnv,
      });
      if (child && typeof child.on === 'function') {
        child.on('error', () => {});
      }
      if (child && typeof child.unref === 'function') child.unref();
    } else if (hostPlatform === 'darwin') {
      const execFileFn = getExecFileFn(options);
      const appBundle = resolveTargetMacAppBundlePath(initialState.binaryPath);
      await runExecFileAsync(
        execFileFn,
        '/usr/bin/open',
        appBundle ? ['-a', appBundle] : [initialState.binaryPath],
        { timeout: 15000 }
      );
    } else {
      const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
      const child = spawnImpl(initialState.binaryPath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      if (child && typeof child.on === 'function') {
        child.on('error', () => {});
      }
      if (child && typeof child.unref === 'function') child.unref();
    }

    if (
      forceInteractive &&
      initialState.authenticated &&
      initialState.accountMatchesOneLauncher !== false
    ) {
      return {
        success: true,
        targetId,
        authenticated: true,
        autoClosedClient: false,
        probeState: initialState,
        message: `Opened ${initialState.label} in foreground to verify or switch accounts.`,
      };
    }

    emitEnvironmentSetupProgress(
      {
        runId,
        componentId: targetId,
        stepIndex: 0,
        totalSteps: 1,
        phase: 'guided_login_waiting',
        message: `Waiting for sign-in to ${initialState.label}...`,
      },
      options
    );

    const pollIntervalMs = Number(options.pollIntervalMs || 1200);
    const timeoutMs = Number(payload?.timeoutMs || options.timeoutMs || 600000);
    const deadline = Date.now() + timeoutMs;
    let latestState = initialState;

    while (Date.now() < deadline) {
      if (abortController.signal.aborted) {
        return {
          success: false,
          targetId,
          authenticated: false,
          cancelled: true,
          probeState: latestState,
          message: `Cancelled sign-in watcher for ${initialState.label}.`,
        };
      }

      // Cancellable sleep always removes its 'abort' listener in finally (prevents 500-listener leak)
      await cancellableSleep(pollIntervalMs, abortController.signal);

      if (abortController.signal.aborted) {
        return {
          success: false,
          targetId,
          authenticated: false,
          cancelled: true,
          probeState: latestState,
          message: `Cancelled sign-in watcher for ${initialState.label}.`,
        };
      }

      const states = await probeClientLoginStates(probeOpts);
      latestState = states[targetId];

      if (latestState.authenticated && latestState.accountMatchesOneLauncher !== false) {
        emitEnvironmentSetupProgress(
          {
            runId,
            componentId: targetId,
            stepIndex: 0,
            totalSteps: 1,
            phase: 'guided_login_detected',
            progressPercent: 100,
            message: `Sign-in detected for ${latestState.label}!`,
          },
          options
        );

        try {
          if (latestState.storefrontId === 'gog') {
            syncGogFirstPartyLauncher(options);
          } else if (latestState.storefrontId === 'epic') {
            syncEpicFirstPartyLauncher(options);
          }
        } catch {}
        invalidateScanCaches({ skipPreviewUrlCacheClear: true });

        let autoClosedClient = false;
        if (payload?.autoCloseOnSuccess !== false) {
          const defaultFlushMs = isTestEnvironment(options)
            ? 20
            : latestState.scope === 'bottle'
              ? 4500
              : 2500;
          const flushMs = Number(options.postLoginFlushDelayMs ?? defaultFlushMs);
          if (flushMs > 0) {
            await cancellableSleep(flushMs, abortController.signal);
          }
          if (abortController.signal.aborted) {
            emitEnvironmentSetupProgress(
              {
                runId,
                componentId: targetId,
                stepIndex: 0,
                totalSteps: 1,
                phase: 'cancelled',
                message: `Cancelled sign-in watcher for ${initialState.label}.`,
              },
              options
            );
            return {
              success: false,
              targetId,
              authenticated: false,
              cancelled: true,
              probeState: latestState,
              message: `Cancelled sign-in watcher for ${initialState.label}.`,
            };
          }
          autoClosedClient = await closeForegroundClientGracefully(
            targetId,
            latestState,
            hostPlatform,
            bottleLayer,
            options
          );
        }

        if (targetId === 'bottle_steam' && latestState.bottlePath) {
          try {
            await linkInstalledSteamAppsIntoBottle(latestState.bottlePath, options);
          } catch (linkErr) {
            diagLog.warn('startGuidedClientLogin.linkInstalledSteamApps', linkErr, {
              bottlePath: latestState.bottlePath,
            });
          }
          invalidateScanCaches({ skipPreviewUrlCacheClear: true });
        }

        if (
          latestState.bottlePath &&
          (targetId === 'bottle_ubisoft' ||
            targetId === 'bottle_ea' ||
            targetId === 'bottle_bnet' ||
            targetId === 'bottle_rockstar')
        ) {
          sanitizeChainedPublisherAutostartInBottleRegs(latestState.bottlePath);
        }

        return {
          success: true,
          targetId,
          authenticated: true,
          autoClosedClient,
          probeState: latestState,
          message: `Signed into ${latestState.label}${latestState.detectedAccountLabel ? ` as ${latestState.detectedAccountLabel}` : ''}.`,
        };
      }
    }

    return {
      success: false,
      targetId,
      authenticated: false,
      timedOut: true,
      probeState: latestState,
      message: `Timed out waiting for sign-in to ${initialState.label}.`,
      error: 'Guided login timed out.',
    };
  } finally {
    const active = activeGuidedLogins.get(targetId);
    if (active && active.runId === runId) {
      activeGuidedLogins.delete(targetId);
    }
  }
}

module.exports = {
  isWinVcRedistInstalledFast,
  linkInstalledSteamAppsIntoBottle,
  runEnvironmentSetupTasks,
  cancelEnvironmentSetup,
  closeForegroundClientGracefully,
  startGuidedClientLogin,
  cancelGuidedClientLogin,
};
