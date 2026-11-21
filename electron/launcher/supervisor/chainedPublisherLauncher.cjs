// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const {
  isProcessAlive,
  extractMatchedPidFromProcessOutput,
} = require('../processTreeUtils.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isContainedWithinRoot,
  buildSafeChildEnvironment,
} = require('../securityAndPathUtils.cjs');
const { mergeWineDllOverrides } = require('../wineAndCrossOverManager.cjs');
const { resolveEffectiveGameExecutableCapabilities } = require('../binaryAndManifestInspectors.cjs');
const {
  diagLog,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  emitSessionUpdated,
  activeSessions,
  pendingWineRegSyncByPrefix,
  setBoundedMapEntry,
  toLocalFsPath,
  openExternalUri,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  isSafeToDeleteInstallPath,
  resolveEffectivePerformancePolicy,
} = require('../engineStateRegistry.cjs');
const {
  isExcludedExecutable,
  extractBottleRootFromPath,
  isValidBottleDirectory,
  inspectBottleConfMetadata,
  assertRunnerBottleArchCompatible,
  detectCompatibilityLayers,
  resolveSipSafeWineBinaryAndPreloadEnv,
  resolveWineserverBinary,
  shutdownWinePrefix,
  applyCrossOverPerGameSettings,
  predictTargetBottlePrefix,
  ensureCompatibilityLayerReady,
  cleanNonApfsAppleDoubleTwins,
  alignWineMsyncWithLiveBottle,
  prepareCrossOverWineSpawnEnv,
} = require('../macNativeInstallerAndCodesign.cjs');
const { pauseActiveDownloadsForInGame } = require('../downloadQueueCoordinator.cjs');
const {
  toWineWindowsPath,
  deleteWineSystemRegKey,
  isBottleWineserverActive,
} = require('../firstPartyRegistration.cjs');
const chainedPublisherLaunchers = /** @type {any} */ (require('../chainedPublisherLaunchers.cjs'));
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
  scanBottlePublisherInstalledGames,
  scanHostPublisherInstalledGames,
  buildChainedLauncherLaunchSpec,
} = chainedPublisherLaunchers;
const {
  doChainedPublisherTitlesMatch,
  isGdkStubExecutablePath,
} = require('../installedGameScanner.cjs');
const {
  resolveAnyChainedHandoffId,
  normalizeRequestedCompatibilityLayerType,
  liveBottleDaemonEnvContractByPrefix,
  normalizeBottlePrefixContractKey,
  deleteBottleDaemonEnvContract,
  computeBottleGraphicsEnvContract,
  stageBottleDisplayScalerBinaries,
  shouldWrapBottleSessionWithDisplayLauncher,
  formatDisplayScalerControlIni,
  writeActiveDisplaySessionManifestIni,
  attachBottleDisplayStatusPoller,
  applyMoltenVkMetalHudDeadlockGuard,
  recordBottledStderrChunk,
  doesCrossOverBinarySupportWaitChildren,
  discoverValidatedAppLocalProxyDllOverrides,
} = require('./bottleDisplayAndEnvController.cjs');
const {
  createGuardedSessionPoller,
  runApprovedLaunchHookCommand,
  sanitizeEaBottleAutostartFallback,
  parseLaunchArguments,
  buildStorefrontLaunchUri,
  isMacSipProtectedExecutableOrScript,
} = require('./processWatchAndElevation.cjs');
const { finalizeGameSession } = require('./sessionFinalizerAndControl.cjs');

let cachedSupervisorGetSetupWizardState = null;

function getSupervisorSetupWizardState(/** @type {any} */ options = {}) {
  try {
    if (!cachedSupervisorGetSetupWizardState) {
      const proberMod = /** @type {any} */ (require('../environmentHealthProber.cjs'));
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
 * Map a publisher `handoffId` to its foreground UI process regex (excluding headless background services
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
      require('../environmentProvisioner.cjs').ensureChainedPublisherLauncherInstalled;
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
function isSafeBottleChainedGameDirToDelete(bottlePath, candidateDir, /** @type {any} */ options = {}) {
  if (!bottlePath || !candidateDir) return false;
  const resolvedBottle = path.resolve(bottlePath);
  const driveCRoot = path.join(resolvedBottle, 'drive_c');
  const resolvedCandidate = path.resolve(candidateDir);
  if (resolvedCandidate === resolvedBottle || resolvedCandidate === driveCRoot) {
    return false;
  }
  const targetPlatform = options?.platform || process.platform;
  if (!isContainedWithinRoot(driveCRoot, resolvedCandidate, targetPlatform)) {
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
      'engine',
      'content',
      'paks',
      'movies',
      'assets',
      'localization',
      'streamingassets',
      'saved',
      'logs',
      'config',
      'shaders',
      'audio',
      'sound',
      'textures',
      'models',
      'levels',
      'maps',
      'thirdparty',
      'plugins',
    ]);
    const priorityBinDirSet = new Set([
      'bin',
      'binaries',
      'win64',
      'win32',
      'wingdk',
      'x64',
      'x86',
      'system',
      'shipping',
      'retail',
    ]);
    /** @type {Array<{ dir: string, depth: number }>} */
    const priorityQueue = [{ dir: realInstallPath, depth: 0 }];
    /** @type {Array<{ dir: string, depth: number }>} */
    const normalQueue = [];
    let visitedEntries = 0;
    const MAX_VISITED_ENTRIES = 500;
    while (visitedEntries <= MAX_VISITED_ENTRIES && (priorityQueue.length > 0 || normalQueue.length > 0)) {
      const node = priorityQueue.length > 0 ? priorityQueue.shift() : normalQueue.shift();
      if (!node || node.depth > 4) continue;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(node.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_VISITED_ENTRIES) break;
        const lowerName = ent.name.toLowerCase();
        if (ent.isFile() && lowerName.endsWith('.exe')) {
          tryAddExe(ent.name);
        } else if (ent.isDirectory() && !ent.name.startsWith('.') && node.depth < 4) {
          if (skipDirSet.has(lowerName)) continue;
          const nextNode = { dir: path.join(node.dir, ent.name), depth: node.depth + 1 };
          if (priorityBinDirSet.has(lowerName)) {
            priorityQueue.push(nextNode);
          } else {
            normalQueue.push(nextNode);
          }
        }
      }
    }
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
 * Launch a game whose runtime requires a chained publisher client (EA App, Ubisoft Connect,
 * Rockstar Games Launcher, Battle.net, or Paradox Launcher v2).
 *
 * @param {Record<string, any>} ctx
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

  // SUP-01: Execute approved pre-launch command asynchronously with sanitized child env and valid cwd
  if (launchConfig.preLaunchCommand) {
    const safePreLaunchEnv = buildSafeChildEnvironment(
      process.env,
      launchConfig.environmentVariables,
      {},
      { gameId, options }
    );
    const preLaunchCwd =
      localInstallDir && fs.existsSync(localInstallDir)
        ? localInstallDir
        : resolvedExePath && fs.existsSync(path.dirname(resolvedExePath))
          ? path.dirname(resolvedExePath)
          : process.cwd();
    await runApprovedLaunchHookCommand('preLaunchCommand', launchConfig.preLaunchCommand, {
      gameId,
      env: safePreLaunchEnv,
      cwd: preLaunchCwd,
      launchConfig,
      options,
      logTag: 'launchGame.chainedPreLaunchCommand',
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
          env: buildSafeChildEnvironment(
            process.env,
            launchConfig.environmentVariables,
            nativeSpec.envOverrides,
            { gameId, options }
          ),
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

    const effectiveHostArch = String(options.arch || process.arch || 'arm64')
      .trim()
      .toLowerCase();
    const layers = detectCompatibilityLayers(options);
    const rawPreferredType =
      launchConfig.compatibilityLayer ||
      payload.compatibilityLayer ||
      installedRecord?.compatibilityLayer;
    const preferredType = normalizeRequestedCompatibilityLayerType(rawPreferredType);
    if (preferredType === 'crossover_preview_arm64' && effectiveHostArch !== 'arm64') {
      return {
        success: false,
        error:
          'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.',
      };
    }
    const explicitMatchedLayer = preferredType
      ? layers.find((l) => l && (l.type === preferredType || l.id === preferredType))
      : null;
    if (preferredType) {
      if (!explicitMatchedLayer) {
        return {
          success: false,
          error: `Launch failed: Requested compatibility runner "${preferredType}" is not installed.`,
        };
      }
      if (
        explicitMatchedLayer.available === false ||
        (explicitMatchedLayer.type === 'crossover_preview_arm64' &&
          effectiveHostArch !== 'arm64')
      ) {
        return {
          success: false,
          error:
            explicitMatchedLayer.type === 'crossover_preview_arm64'
              ? 'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.'
              : `Launch failed: Requested compatibility runner "${preferredType}" is unavailable on this host.`,
        };
      }
    }
    const chosenLayer = preferredType
      ? explicitMatchedLayer
      : layers.find(
          (l) =>
            l &&
            l.available !== false &&
            (l.type === 'crossover' ||
              l.type === 'crossover_preview' ||
              l.type === 'crossover_preview_arm64')
        ) ||
        layers.find((l) => l && l.available !== false) ||
        layers[0];

    if (!chosenLayer || !chosenLayer.binaryPath) {
      return {
        success: false,
        error: `No Windows compatibility layer (CrossOver, Game Porting Toolkit, or Wine) detected on macOS to run ${ecosystem.displayName}.`,
      };
    }
    if (
      chosenLayer.type === 'crossover_preview_arm64' &&
      (effectiveHostArch !== 'arm64' || chosenLayer.available === false)
    ) {
      return {
        success: false,
        error:
          'Launch failed: CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.',
      };
    }

    /** @type {Record<string, any>} */
    const bottleEnv = buildSafeChildEnvironment(
      process.env,
      launchConfig.environmentVariables,
      {},
      { gameId, options }
    );

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
    const isMockHomedirForChained = Boolean(
      options.homedir || options.customApplicationsDir || isTestEnvironment(options)
    );
    const wizardState = getSupervisorSetupWizardState(options);
    const rawWizardPreferredBottleName = String(wizardState?.preferredBottleName || '').trim();
    const { homedir: supervisorHomedir } = resolveIsolatedHomedirAndUserData(options);
    const chainedBottlesDir =
      chosenLayer.bottlesDir ||
      path.join(supervisorHomedir, 'Library/Application Support/CrossOver/Bottles');
    const isArm64ChosenLayer = chosenLayer.type === 'crossover_preview_arm64';
    const isIntelCrossOverChosenLayer =
      chosenLayer.type === 'crossover' || chosenLayer.type === 'crossover_preview';
    const mappedDiscoveredBottles = Array.isArray(chosenLayer.availableBottles)
      ? chosenLayer.availableBottles.map((/** @type {string} */ bName) => {
          const bPath = path.join(chainedBottlesDir, bName);
          const detailMeta = chosenLayer.bottleDetails?.[bName];
          const confMeta = detailMeta || inspectBottleConfMetadata(bPath);
          const resolvedWineArch =
            confMeta?.wineArch ||
            (isValidBottleDirectory(bPath, false) ? 'win64' : undefined);
          return {
            name: bName,
            ...(confMeta || {}),
            ...(resolvedWineArch ? { wineArch: resolvedWineArch } : {}),
          };
        })
      : [];

    let effectiveWizardPreferredBottleName = rawWizardPreferredBottleName;
    if (
      rawWizardPreferredBottleName &&
      (isArm64ChosenLayer || isIntelCrossOverChosenLayer)
    ) {
      const candidateWizardBottleDirs = Array.from(
        new Set(
          [
            chainedBottlesDir,
            path.join(supervisorHomedir, 'Library/Application Support/CrossOver/Bottles'),
            path.join(supervisorHomedir, 'Library/Application Support/CrossOver Preview/Bottles'),
            path.join(
              supervisorHomedir,
              'Library/Application Support/CrossOver Preview arm64/Bottles'
            ),
          ].filter(Boolean)
        )
      );
      const detailArch = chosenLayer.bottleDetails?.[rawWizardPreferredBottleName]?.wineArch;
      if (detailArch && (isArm64ChosenLayer ? detailArch !== 'arm64' : detailArch === 'arm64')) {
        effectiveWizardPreferredBottleName = '';
      } else {
        for (const dir of candidateWizardBottleDirs) {
          const candPath = path.join(dir, rawWizardPreferredBottleName);
          if (!fs.existsSync(candPath)) continue;
          const meta = inspectBottleConfMetadata(candPath);
          const isInit =
            Boolean(meta.wineArch) ||
            fs.existsSync(path.join(candPath, 'cxbottle.conf')) ||
            isValidBottleDirectory(candPath, false);
          if (!isInit) continue;
          const arch = meta.wineArch || 'win64';
          if (isArm64ChosenLayer ? arch !== 'arm64' : arch === 'arm64') {
            effectiveWizardPreferredBottleName = '';
            break;
          }
        }
      }
      if (effectiveWizardPreferredBottleName && wizardState?.preferredRunnerType) {
        const savedPrefRunner = String(wizardState.preferredRunnerType).trim();
        if (
          savedPrefRunner !== 'skip' &&
          (savedPrefRunner === 'crossover_preview_arm64') !== isArm64ChosenLayer &&
          rawWizardPreferredBottleName.toLowerCase() ===
            (savedPrefRunner === 'crossover_preview_arm64' ? 'onelauncher-arm64' : 'onelauncher')
        ) {
          effectiveWizardPreferredBottleName = '';
        }
      }
    }

    const helperBottleName =
      typeof chainedPublisherLaunchers.resolveDefaultChainedBottleName === 'function'
        ? String(
            chainedPublisherLaunchers.resolveDefaultChainedBottleName({
              explicitBottleName,
              gameConfigBottleName,
              wizardPreferredBottleName: effectiveWizardPreferredBottleName || undefined,
              discoveredBottleNames: mappedDiscoveredBottles,
              runnerType: chosenLayer.type,
            }) || ''
          ).trim()
        : '';
    const requestedBottleName =
      gameConfigBottleName ||
      explicitBottleName ||
      helperBottleName ||
      effectiveWizardPreferredBottleName ||
      '';

    let preResolvedBottlePath = '';
    if (
      explicitBottleFromInstall &&
      fs.existsSync(explicitBottleFromInstall) &&
      isValidBottleDirectory(explicitBottleFromInstall, isMockHomedirForChained)
    ) {
      preResolvedBottlePath = explicitBottleFromInstall;
    } else if (
      (chosenLayer.type === 'crossover' ||
        chosenLayer.type === 'crossover_preview' ||
        chosenLayer.type === 'crossover_preview_arm64') &&
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

    if (preResolvedBottlePath) {
      try {
        assertRunnerBottleArchCompatible(
          chosenLayer.type,
          requestedBottleName || path.basename(preResolvedBottlePath),
          preResolvedBottlePath
        );
      } catch (/** @type {any} */ archErr) {
        return {
          success: false,
          error: archErr?.message || String(archErr),
        };
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
            realInstallPath || undefined,
            {
              ...options,
              launchArguments: userLaunchArgs.join(' '),
            }
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
      runnerType: chosenLayer.type,
      isPreviewRunner:
        chosenLayer.type === 'crossover_preview' ||
        chosenLayer.type === 'crossover_preview_arm64',
      isPreviewArm64Runner: chosenLayer.type === 'crossover_preview_arm64',
      ...(chosenLayer.binaryPath ? { wineBinary: chosenLayer.binaryPath } : {}),
      ...(chosenLayer.version ? { runnerVersion: chosenLayer.version } : {}),
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

    // SUP-07: Deduplicate double ensureCompatibilityLayerReady call when compatResult already
    // provisioned/readied the bottle above; apply per-game capabilities & overrides directly.
    if (!compatResult) {
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
    } else {
      applyCrossOverPerGameSettings(
        chosenLayer,
        {
          ...launchConfig,
          winePrefixPath: bottlePath,
          ...(bottleName ? { wineBottleName: bottleName } : {}),
        },
        bottleEnv,
        bottlePath,
        { ...chainedCompatCapOptions, skipUserFolderSandbox: true }
      );
    }

    bottleEnv.WINEPREFIX = bottlePath;
    if (
      (chosenLayer.type === 'crossover' ||
        chosenLayer.type === 'crossover_preview' ||
        chosenLayer.type === 'crossover_preview_arm64') &&
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
    const shouldWrapChainedDisplayScaler = shouldWrapBottleSessionWithDisplayLauncher(
      chainedEffectiveCaps,
      chainedDisplayScalingMode,
      userLaunchArgs.join(' ')
    );
    /** @type {ReturnType<typeof stageBottleDisplayScalerBinaries> | null} */
    let stagedChainedDisp = null;
    if (shouldWrapChainedDisplayScaler) {
      bottleEnv.ONE_LAUNCHER_DISPLAY_SCALING_MODE = chainedDisplayScalingMode;
      bottleEnv.ONE_LAUNCHER_DISPLAY_ASPECT = chainedDisplayAspectRatio;
      bottleEnv.ONE_LAUNCHER_SAFE_INSET_TOP = String(chainedSafeInsetTop);
      bottleEnv.ONE_LAUNCHER_FULLSCREEN_HOTKEY = chainedFullscreenHotkey ? '1' : '0';
      if (bottlePath && fs.existsSync(bottlePath)) {
        stagedChainedDisp = stageBottleDisplayScalerBinaries(bottlePath, options);
        if (stagedChainedDisp.stageDirPosix) {
          chainedDisplayControlFilePosix = path.join(
            stagedChainedDisp.stageDirPosix,
            `display_ctl_${chainedSessionId}.ini`
          );
          chainedDisplayStatusFilePosix = path.join(
            stagedChainedDisp.stageDirPosix,
            `display_status_${chainedSessionId}.json`
          );
          const winCtlFile = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${chainedSessionId}.ini`;
          const winStatusFile = `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${chainedSessionId}.json`;
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
            writeActiveDisplaySessionManifestIni(stagedChainedDisp.stageDirPosix, {
              seq: 1,
              mode: chainedDisplayScalingMode,
              aspect: chainedDisplayAspectRatio,
              safeInsetTop: chainedSafeInsetTop,
              hotkey: chainedFullscreenHotkey,
              controlFileWin: winCtlFile,
              statusFileWin: winStatusFile,
            });
          } catch {}
          bottleEnv.ONE_LAUNCHER_SCALER_DLL_X86 = stagedChainedDisp.winDllX86;
          bottleEnv.ONE_LAUNCHER_SCALER_DLL_X64 = stagedChainedDisp.winDllX64;
          bottleEnv.ONE_LAUNCHER_LAUNCHER_EXE_X86 = stagedChainedDisp.winLauncherX86;
          bottleEnv.ONE_LAUNCHER_LAUNCHER_EXE_X64 = stagedChainedDisp.winLauncherX64;
          bottleEnv.ONE_LAUNCHER_DISPLAY_CONTROL_FILE = winCtlFile;
          bottleEnv.ONE_LAUNCHER_DISPLAY_STATUS_FILE = winStatusFile;
        }
      }
    } else {
      delete bottleEnv.ONE_LAUNCHER_SCALER_DLL_X86;
      delete bottleEnv.ONE_LAUNCHER_SCALER_DLL_X64;
      delete bottleEnv.ONE_LAUNCHER_LAUNCHER_EXE_X86;
      delete bottleEnv.ONE_LAUNCHER_LAUNCHER_EXE_X64;
      delete bottleEnv.ONE_LAUNCHER_DISPLAY_CONTROL_FILE;
      delete bottleEnv.ONE_LAUNCHER_DISPLAY_STATUS_FILE;
      bottleEnv.ONE_LAUNCHER_DISPLAY_SCALING_MODE =
        chainedDisplayScalingMode === 'windowed' ? 'windowed' : 'off';
      bottleEnv.ONE_LAUNCHER_DISPLAY_ASPECT = chainedDisplayAspectRatio;
      bottleEnv.ONE_LAUNCHER_SAFE_INSET_TOP = String(chainedSafeInsetTop);
      bottleEnv.ONE_LAUNCHER_FULLSCREEN_HOTKEY = '0';
      if (bottlePath && fs.existsSync(bottlePath)) {
        const existingStageDir = path.join(
          bottlePath,
          'drive_c',
          'ProgramData',
          'OneLauncher',
          'display_scaler'
        );
        if (fs.existsSync(existingStageDir)) {
          try {
            writeActiveDisplaySessionManifestIni(existingStageDir, {
              seq: 1,
              mode: 'off',
              aspect: chainedDisplayAspectRatio,
              safeInsetTop: 0,
              hotkey: false,
              controlFileWin: '',
              statusFileWin: '',
            });
          } catch {}
        }
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

    // SUP-07: Await any pending background live `reg.exe import` for this bottle before spawn
    if (bottlePath) {
      const pendingRegBeforeChainedSpawn = pendingWineRegSyncByPrefix.get(path.resolve(bottlePath));
      if (pendingRegBeforeChainedSpawn) {
        try {
          await pendingRegBeforeChainedSpawn;
        } catch {}
      }
    }

    const gameSpawnImpl = options.gameSpawnFn || options.spawnFn || spawn;
    const child = gameSpawnImpl(wineSpawnCmd, wineArgs, {
      cwd: effectiveCwd,
      env: spawnEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });

    const canWrapChainedDisplayScaler =
      (!isTestEnvironment(options) || options.enableDisplayScalerInTests === true) &&
      Boolean(stagedChainedDisp && stagedChainedDisp.allPresent) &&
      shouldWrapChainedDisplayScaler;
    /** @type {any} */
    let chainedDisplayWatcherChild = null;
    const chainedWatchTargetDir =
      realInstallPath || localInstallDir || (realGameExe ? path.dirname(realGameExe) : '');
    if (canWrapChainedDisplayScaler && stagedChainedDisp && bottlePath && chainedWatchTargetDir) {
      try {
        const winWatchDir = toWineWindowsPath(chainedWatchTargetDir, bottlePath);
        const chainedWatchLauncherPosix =
          (chainedEffectiveCaps?.is64Bit
            ? stagedChainedDisp.launcherX64Posix
            : stagedChainedDisp.launcherX86Posix) ||
          stagedChainedDisp.launcherX64Posix ||
          stagedChainedDisp.launcherX86Posix;
        if (winWatchDir && chainedWatchLauncherPosix) {
          // SUP-04: Standardize detached POSIX display watcher so signalSubprocessTree reaps full PGID
          chainedDisplayWatcherChild = gameSpawnImpl(
            wineSpawnCmd,
            [
              ...chainedDllArgs,
              chainedWatchLauncherPosix,
              '--watch-dir',
              winWatchDir,
              '--dll-x86',
              stagedChainedDisp.winDllX86,
              '--dll-x64',
              stagedChainedDisp.winDllX64,
              '--timeout-ms',
              '120000',
            ],
            {
              cwd: effectiveCwd,
              env: spawnEnv,
              stdio: ['ignore', 'ignore', 'ignore'],
              detached: true,
            }
          );
          if (chainedDisplayWatcherChild && typeof chainedDisplayWatcherChild.unref === 'function') {
            chainedDisplayWatcherChild.unref();
          }
        }
      } catch {}
    }

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
      targetExeBasenamesLower: candidateExeNames,
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
      is64Bit: Boolean(chainedEffectiveCaps?.is64Bit),
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
      displayScalerWrapped: Boolean(chainedDisplayWatcherChild),
      displayWatcherChild: chainedDisplayWatcherChild || null,
      displayStatusTimer: null,
      lastObservedDisplayStatusMtimeMs: 0,
      chosenCompatLayerType: chosenLayer?.type || null,
      installPath: realInstallPath || localInstallDir || '',
      platformGameId: String(payload.platformGameId || gameId),
      launchOptions: options,
      launchConfig,
      effectiveStorefrontLifecycle: effectivePerfPolicy.storefrontClientLifecycle,
    };

    attachBottleDisplayStatusPoller(entry, options);

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
      child.on('exit', (/** @type {any} */ code, /** @type {any} */ signal) => {
        childExitedAt = Date.now();
        childExitCode =
          typeof code === 'number'
            ? code
            : signal && !entry.stoppedByUser && !entry.stopping
              ? -1
              : 0;
        if (signal && !entry.stoppedByUser && !entry.stopping) {
          entry.exitSignal = signal;
        }
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
      env: buildSafeChildEnvironment(
        process.env,
        launchConfig.environmentVariables,
        winSpec.envOverrides,
        { gameId, options }
      ),
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
    winChild.on('exit', (/** @type {any} */ code, /** @type {any} */ signal) => {
      winChildExitedAt = Date.now();
      winChildExitCode =
        typeof code === 'number'
          ? code
          : signal && !winEntry.stoppedByUser && !winEntry.stopping
            ? -1
            : 0;
      if (signal && !winEntry.stoppedByUser && !winEntry.stopping) {
        winEntry.exitSignal = signal;
      }
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

    const pollTimer = createGuardedSessionPoller({
      intervalMs: pollMs,
      startedMs: winEntry.startedMs,
      isDone: () => Boolean(winEntry.finalized || winEntry.stopping || winEntry.stoppedByUser),
      onStop: () => {
        winEntry.pollTimer = null;
      },
      onTick: async () => {
        if (typeof options.getProcessListOutput === 'function') {
          const out = await Promise.resolve(options.getProcessListOutput());
          handleWinProcessList(null, out);
        } else if (typeof options.mockProcessListOutput === 'string') {
          handleWinProcessList(null, options.mockProcessListOutput);
        } else if (!options.homedir || options.execFileImpl || options.execFileFn) {
          await new Promise((resolve) => {
            execFileImpl(
              'tasklist.exe',
              ['/FO', 'CSV', '/NH'],
              { timeout: 2500, windowsHide: true },
              (/** @type {any} */ err, /** @type {any} */ stdout) => {
                try {
                  handleWinProcessList(err, stdout);
                } finally {
                  resolve(undefined);
                }
              }
            );
          });
        }
      },
    });
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

module.exports = {
  getSupervisorSetupWizardState,
  hasParadoxLauncherInstalledInBottle,
  getPublisherForegroundUiRegex,
  checkBottlePublisherUiRunningAsync,
  checkHostWinPublisherUiRunningAsync,
  isSafeHostEaGameDirToDelete,
  wineRegistryInstallDirToPosix,
  cleanupBottleEaGameRegistryAndDaemons,
  cleanupWindowsEaGameRegistryAsync,
  getEnsureChainedPublisherLauncherInstalled,
  BOTTLE_SYSTEM_DAEMON_EXE_SET,
  PROTECTED_BOTTLE_DRIVE_C_REL_PATHS,
  isSafeBottleChainedGameDirToDelete,
  collectChainedGameCandidateExeNames,
  findLiveBottleGameChildPid,
  launchChainedPublisherGame,
};
