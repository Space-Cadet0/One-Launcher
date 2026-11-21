// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const { fromWineWindowsPath } = require('../firstPartyRegistration.cjs');
const { sanitizeGameInstallSizeBytes } = require('../binaryAndManifestInspectors.cjs');
const { isCrossOverPerlWineWrapperOptions } = require('../wineAndCrossOverManager.cjs');
const {
  diagLog,
  isTestEnvironment,
  emitDownloadUpdated,
  downloadQueueMap,
  downloadControllers,
  invalidateScanCaches,
  openExternalUri,
  upsertManagedInstallRecord,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
} = require('../engineStateRegistry.cjs');
const {
  hasWindowsGamingServicesInstalled,
  getDirectorySizeFast,
  getDirectorySizeFastAsync,
} = require('../diskAndVolumeInspector.cjs');
const {
  collectXboxLibraryRoots,
  inspectInstalledXboxGameDir,
  queryTargetedAppxPackageAsync,
} = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  normalizeComparableTitle,
  extractBottleRootFromPath,
  isValidBottleDirectory,
  inspectBottleConfMetadata,
  assertRunnerBottleArchCompatible,
  detectCompatibilityLayers,
  prepareAlignedAuxBottleWineCommand,
  ensureCompatibilityLayerReady,
} = macNativeInstallerAndCodesign;
const chainedPublisherLaunchers = /** @type {any} */ (require('../chainedPublisherLaunchers.cjs'));
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
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
  extractEpicRegistryLeaf,
  normalizeRequestedCompatibilityLayerType,
  notifyInstalledGamesUpdated,
  persistDownloadQueueToDisk,
  computeSmoothedDownloadSpeed,
  getDownloadQueue,
  updateDownloadTask,
  toPublicDownloadTask,
  isTaskCancelledOrPaused,
} = require('./downloadQueueStore.cjs');

/** @type {((params: any, options?: any) => Promise<{ installed: boolean, provisionedNow: boolean, binaryPath: string, installDir: string, bottlePath?: string }>) | null} */
let cachedEnsureChainedPublisherLauncherInstalled = null;
/** @type {((options?: any) => any) | null} */
let cachedGetSetupWizardState = null;

function getEnsureChainedPublisherLauncherInstalled() {
  if (!cachedEnsureChainedPublisherLauncherInstalled) {
    const provMod = /** @type {any} */ (require('../environmentProvisioner.cjs'));
    cachedEnsureChainedPublisherLauncherInstalled = provMod.ensureChainedPublisherLauncherInstalled;
  }
  return cachedEnsureChainedPublisherLauncherInstalled;
}

function getSetupWizardStateLazy() {
  if (!cachedGetSetupWizardState) {
    const proberMod = /** @type {any} */ (require('../environmentHealthProber.cjs'));
    cachedGetSetupWizardState = proberMod.getSetupWizardState;
  }
  return cachedGetSetupWizardState;
}

/**
 * Non-blocking existence check helper.
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExistsAsync(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Background monitor for Windows Native GamingServices / Xbox App installations.
 * Uses targeted `Get-AppxPackage -Name '<identityName>'` (~60ms) and non-blocking
 * `getDirectorySizeFastAsync` on every 2s tick.
 *
 * @param {string} taskId
 * @param {any} [payload]
 * @param {any} [options]
 */
function startXboxInstallMonitor(taskId, payload = {}, options = {}) {
  const intervalMs = Math.max(250, Number(options.xboxInstallPollIntervalMs || 2000));
  const cleanStoreId = String(
    payload.cleanStoreId || payload.xboxProductId || payload.storeId || payload.platformGameId || ''
  )
    .replace(/^xbox[-_:]/i, '')
    .trim()
    .toUpperCase();
  const targetPfn = String(payload.packageFamilyName || '').trim();
  const targetIdentityName = String(payload.identityName || '').trim();
  const targetTitleNorm = normalizeComparableTitle(payload.title || '');

  let lastBytes = 0;
  let lastTickTime = Date.now();
  let inFlightTick = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  const stopMonitor = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    downloadControllers.delete(taskId);
  };

  const queryAppxStatusAsync = async () => {
    if ((options.platform || process.platform) !== 'win32') return null;
    if (isTestEnvironment(options) && !options.execFileImpl && !options.execFileFn) {
      return null;
    }
    if (!targetPfn && !targetIdentityName) return null;
    const res = await queryTargetedAppxPackageAsync(
      {
        identityName: targetIdentityName,
        packageFamilyName: targetPfn,
        selectFields: 'Name,PackageFamilyName,InstallLocation,Status,Version',
      },
      options
    );
    return res && res.found && res.pkg ? res.pkg : null;
  };

  const runTick = () => {
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
        stopMonitor();
        return;
      }
      if (task.status === 'paused') return;

      const scanRoots = collectXboxLibraryRoots({
        ...options,
        platform: options.platform || process.platform,
        customRoots: payload.installDir
          ? [payload.installDir, ...(options.customRoots || [])]
          : options.customRoots,
      });

      /** @type {string | null} */
      let matchedDir = null;
      /** @type {any} */
      let matchedInspected = null;

      for (const rootDir of scanRoots) {
        /** @type {fs.Dirent[]} */
        let subEntries = [];
        try {
          subEntries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of subEntries) {
          if (!ent.isDirectory() || ent.isSymbolicLink() || ent.name.startsWith('.')) continue;
          const candidateDir = path.join(rootDir, ent.name);
          const inspected = inspectInstalledXboxGameDir(candidateDir, {
            ...options,
            platform: options.platform || process.platform,
          });
          if (
            inspected &&
            !(inspected.isExternalLauncherStub && !inspected.executablePath) &&
            !isGdkStubExecutablePath(inspected.executablePath)
          ) {
            const matchesId =
              (cleanStoreId &&
                String(inspected.xboxProductId || '').toUpperCase() === cleanStoreId) ||
              (targetPfn &&
                String(inspected.packageFamilyName || '').toLowerCase() ===
                  targetPfn.toLowerCase());
            const matchesTitle =
              !cleanStoreId &&
              !targetPfn &&
              targetTitleNorm &&
              normalizeComparableTitle(ent.name) === targetTitleNorm;
            if (matchesId || matchesTitle) {
              matchedDir = candidateDir;
              matchedInspected = inspected;
              break;
            }
          } else if (
            !inspected?.isExternalLauncherStub &&
            targetTitleNorm &&
            normalizeComparableTitle(ent.name) === targetTitleNorm
          ) {
            matchedDir = candidateDir;
          }
        }
        if (matchedInspected) break;
      }

      const appxInfo = await queryAppxStatusAsync();
      if (!matchedDir && appxInfo?.InstallLocation) {
        const candidateAppxLoc = String(appxInfo.InstallLocation).trim();
        const appxInspected = inspectInstalledXboxGameDir(candidateAppxLoc, {
          ...options,
          platform: options.platform || process.platform,
        });
        if (
          appxInspected &&
          !(appxInspected.isExternalLauncherStub && !appxInspected.executablePath) &&
          !isGdkStubExecutablePath(appxInspected.executablePath)
        ) {
          matchedDir = candidateAppxLoc;
          matchedInspected = appxInspected;
        }
      }

      // Also check chained publisher installations on Windows (Ubisoft Connect / EA App / Battle.net / Rockstar)
      if ((options.platform || process.platform) === 'win32' && !matchedInspected) {
        const expectedHandoff = normalizeChainedHandoffId(
          payload.chainedLauncherHandoff || payload.externalStorefrontHandoff || ''
        );
        const hostPublisherGames = scanHostPublisherInstalledGames({
          ...options,
          platform: 'win32',
        });
        const matchedHostGame = hostPublisherGames.find(
          (/** @type {any} */ g) =>
            g &&
            g.executablePath &&
            !isGdkStubExecutablePath(g.executablePath) &&
            (!expectedHandoff || g.handoffId === expectedHandoff) &&
            ((payload.chainedExternalInstallId &&
              String(g.externalInstallId || '').toLowerCase() ===
                String(payload.chainedExternalInstallId).toLowerCase()) ||
              doChainedPublisherTitlesMatch(g.title, payload.title || ''))
        );
        if (matchedHostGame && (await pathExistsAsync(matchedHostGame.executablePath))) {
          stopMonitor();
          const finalHostSize = sanitizeGameInstallSizeBytes(matchedHostGame.installSizeBytes);
          upsertManagedInstallRecord(
            {
              platformId: 'xbox',
              platformGameId: cleanStoreId || payload.platformGameId,
              ...(cleanStoreId ? { xboxProductId: cleanStoreId } : {}),
              title: matchedHostGame.title || payload.title,
              installPath: matchedHostGame.installPath,
              executablePath: matchedHostGame.executablePath,
              ...(finalHostSize ? { installSize: finalHostSize } : {}),
              chainedLauncherHandoff: matchedHostGame.handoffId,
              ...(matchedHostGame.externalInstallId
                ? { chainedExternalInstallId: String(matchedHostGame.externalInstallId) }
                : {}),
              runner: 'chained_host',
              isWindowsBinaryOnMac: false,
            },
            options.userDataDir
          );
          notifyInstalledGamesUpdated();
          updateDownloadTask(
            taskId,
            {
              status: 'completed',
              progressPercent: 100,
              bytesDownloaded: finalHostSize || Number(task.totalBytes || 0),
              totalBytes: finalHostSize || Number(task.totalBytes || 0),
              speedBytesPerSec: 0,
              etaSeconds: undefined,
              finalInstallPath: matchedHostGame.installPath,
              executablePath: matchedHostGame.executablePath,
              runner: 'chained_host',
              statusMessage: `Installed via ${CHAINED_PUBLISHER_ECOSYSTEMS[matchedHostGame.handoffId]?.displayName || matchedHostGame.handoffId}`,
            },
            options
          );
          return;
        }
      }

      const latestTask = downloadQueueMap.get(taskId);
      if (
        !latestTask ||
        ['cancelled', 'completed', 'failed', 'paused'].includes(latestTask.status)
      ) {
        return;
      }

      const currentDiskBytes = matchedDir
        ? Math.max(0, await getDirectorySizeFastAsync(matchedDir, 4))
        : 0;
      const effectiveTotal = Math.max(Number(latestTask.totalBytes || 0), currentDiskBytes);
      const appxReady = !appxInfo || !appxInfo.Status || /^ok$/i.test(String(appxInfo.Status));

      const verifiedMatchedInstallPath = matchedInspected?.installPath || matchedDir || '';
      const matchedExeContained =
        Boolean(matchedInspected?.executablePath) &&
        Boolean(verifiedMatchedInstallPath) &&
        isContainedWithinRoot(verifiedMatchedInstallPath, matchedInspected.executablePath);

      if (
        matchedInspected &&
        matchedExeContained &&
        (await pathExistsAsync(matchedInspected.executablePath)) &&
        appxReady &&
        (effectiveTotal === 0 || currentDiskBytes >= effectiveTotal * 0.95 || appxInfo?.InstallLocation)
      ) {
        stopMonitor();
        const finalSize =
          sanitizeGameInstallSizeBytes(currentDiskBytes) ||
          sanitizeGameInstallSizeBytes(effectiveTotal);

        upsertManagedInstallRecord(
          {
            platformId: 'xbox',
            platformGameId: matchedInspected.platformGameId || cleanStoreId || payload.platformGameId,
            xboxProductId: matchedInspected.xboxProductId || cleanStoreId || undefined,
            packageFamilyName: matchedInspected.packageFamilyName || targetPfn || undefined,
            appUserModelId: matchedInspected.appUserModelId || undefined,
            xboxTitleId: matchedInspected.xboxTitleId || undefined,
            scid: matchedInspected.scid || undefined,
            msaAppId: matchedInspected.msaAppId || undefined,
            title: matchedInspected.title || latestTask.title,
            installPath: verifiedMatchedInstallPath,
            executablePath: matchedInspected.executablePath,
            installSize: finalSize,
            version: matchedInspected.version || appxInfo?.Version || undefined,
            runner: 'xbox',
            isWindowsBinaryOnMac: false,
          },
          options.userDataDir
        );
        invalidateScanCaches();

        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: finalSize || effectiveTotal,
            totalBytes: finalSize || effectiveTotal,
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            finalInstallPath: verifiedMatchedInstallPath,
            executablePath: matchedInspected.executablePath,
            runner: 'xbox',
            statusMessage: 'Installed via Windows Xbox GamingServices',
          },
          options
        );
        return;
      }

      if (currentDiskBytes > 0) {
        const now = Date.now();
        const rawSpeed =
          currentDiskBytes > lastBytes && now > lastTickTime
            ? Math.round(((currentDiskBytes - lastBytes) * 1000) / (now - lastTickTime))
            : 0;
        lastBytes = currentDiskBytes;
        lastTickTime = now;

        const speedBytesPerSec = computeSmoothedDownloadSpeed(taskId, {
          bytesDownloaded: currentDiskBytes,
          rawSpeedBytesPerSec: rawSpeed,
          nowMs: now,
        });
        const pct =
          effectiveTotal > 0
            ? Math.min(99, Math.round((currentDiskBytes / effectiveTotal) * 100))
            : 0;
        const etaSeconds =
          speedBytesPerSec > 0 && effectiveTotal > currentDiskBytes
            ? Math.max(1, Math.round((effectiveTotal - currentDiskBytes) / speedBytesPerSec))
            : latestTask.etaSeconds;

        updateDownloadTask(
          taskId,
          {
            status: 'downloading',
            progressPercent: pct,
            bytesDownloaded: currentDiskBytes,
            totalBytes: effectiveTotal,
            speedBytesPerSec,
            etaSeconds,
            statusMessage: `Xbox GamingServices: Installing ${latestTask.title} (${pct}%)...`,
          },
          options
        );
      }
    })()
      .catch((tickErr) => {
        diagLog.debug('startXboxInstallMonitor.tick', tickErr, { taskId, cleanStoreId });
      })
      .finally(() => {
        inFlightTick = false;
      });
  };

  timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  downloadControllers.set(taskId, { type: 'timer', timer });
  Promise.resolve().then(runTick);
  return timer;
}

/**
 * Build a regex matching ONLY foreground publisher UI executables (excluding headless background
 * services such as `EABackgroundService.exe`, `Agent.exe`, or `SocialClubHelper.exe`).
 *
 * @param {string} [handoffId]
 * @returns {RegExp}
 */
function getPublisherForegroundUiProcessRegex(handoffId = '') {
  const clean = String(handoffId || '').trim().toLowerCase();
  if (clean === 'ea') {
    return /(?:^|[\\/\s"'])(?:eadesktop|ealauncher|origin)\.exe(?:\b|["']|$)/i;
  }
  if (clean === 'ubisoft') {
    return /(?:^|[\\/\s"'])(?:upc|ubisoftconnect|ubisoftgamelauncher)\.exe(?:\b|["']|$)/i;
  }
  if (clean === 'bnet') {
    return /(?:^|[\\/\s"'])battle\.net\.exe(?:\b|["']|$)/i;
  }
  if (clean === 'rockstar') {
    return /(?:^|[\\/\s"'])(?:launcher|rockstarservice)\.exe(?:\b|["']|$)/i;
  }
  if (clean === 'riot') {
    return /(?:^|[\\/\s"'])(?:riotclientux|riotclientservices)\.exe(?:\b|["']|$)/i;
  }
  return /(?:^|[\\/\s"'])(?:upc|ubisoftconnect|ubisoftgamelauncher|eadesktop|ealauncher|origin|battle\.net|launcher|riotclientux|riotclientservices)\.exe(?:\b|["']|$)/i;
}

/**
 * Checks asynchronously whether any foreground publisher launcher UI process is alive inside `bottlePath` on macOS.
 * Never treats `wineserver` or headless `EABackgroundService.exe` alone as UI-alive.
 *
 * @param {string} bottlePath
 * @param {any} [options]
 * @param {string} [handoffId]
 * @returns {Promise<boolean>}
 */
function checkBottlePublisherLauncherAliveAsync(bottlePath, options = {}, handoffId = '') {
  if (typeof options.isBottleLauncherAliveFn === 'function') {
    return Promise.resolve(Boolean(options.isBottleLauncherAliveFn(bottlePath, handoffId)));
  }
  if (isTestEnvironment(options) && typeof options.execFileFn !== 'function') {
    return Promise.resolve(true);
  }
  const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
  const resolvedBottle = path.resolve(bottlePath);
  const publisherUiRe = getPublisherForegroundUiProcessRegex(handoffId);
  return new Promise((resolve) => {
    try {
      execFileImpl(
        '/bin/ps',
        ['-axo', 'command='],
        { timeout: 3000 },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (err) {
            resolve(true);
            return;
          }
          const lines = String(stdout || '').split(/\r?\n/);
          for (const line of lines) {
            if (!line) continue;
            if (!publisherUiRe.test(line)) continue;
            if (/\/(?:Bottles|Prefixes)\//i.test(line) && !line.includes(resolvedBottle)) {
              continue;
            }
            resolve(true);
            return;
          }
          resolve(false);
        }
      );
    } catch {
      resolve(true);
    }
  });
}

/**
 * Checks asynchronously whether the foreground publisher launcher UI process is alive on Windows (`win32`).
 * Never treats headless `EABackgroundService.exe` alone as UI-alive.
 *
 * @param {string} handoffId
 * @param {any} [options]
 * @returns {Promise<boolean>}
 */
function checkHostWinPublisherLauncherAliveAsync(handoffId, options = {}) {
  if (typeof options.isHostLauncherAliveFn === 'function') {
    return Promise.resolve(Boolean(options.isHostLauncherAliveFn(handoffId)));
  }
  if (isTestEnvironment(options) && typeof options.execFileFn !== 'function') {
    return Promise.resolve(true);
  }
  const execFileImpl = typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
  const publisherUiRe = getPublisherForegroundUiProcessRegex(handoffId);
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'tasklist.exe',
        ['/FO', 'CSV', '/NH'],
        { timeout: 4000, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          if (err) {
            resolve(true);
            return;
          }
          const lines = String(stdout || '').split(/\r?\n/);
          for (const line of lines) {
            if (line && publisherUiRe.test(line)) {
              resolve(true);
              return;
            }
          }
          resolve(false);
        }
      );
    } catch {
      resolve(true);
    }
  });
}

/**
 * Inline fallback reader for EA App configured custom download/library directories.
 *
 * @param {string} platform
 * @param {string | undefined} bottlePath
 * @param {any} [options]
 * @returns {string[]}
 */
function readInlineEaConfiguredLibraryRoots(platform, bottlePath, options = {}) {
  /** @type {string[]} */
  const roots = [];
  const parseIniDirLines = (/** @type {string} */ iniText, /** @type {boolean} */ isBottle) => {
    const lineRe =
      /^\s*(?:machine\.downloadinplacedir|user\.downloadinplacedir)\s*=\s*(.+?)\s*$/gim;
    let m;
    while ((m = lineRe.exec(iniText)) !== null) {
      const rawDir = String(m[1] || '')
        .replace(/^"+|"+$/g, '')
        .trim();
      if (!rawDir) continue;
      if (isBottle && bottlePath) {
        const mapped = fromWineWindowsPath(rawDir, bottlePath);
        if (mapped) roots.push(mapped);
      } else {
        roots.push(rawDir);
      }
    }
  };

  if (platform === 'darwin' && bottlePath) {
    const driveC = path.join(bottlePath, 'drive_c');
    roots.push(
      path.join(driveC, 'Program Files', 'EA Games'),
      path.join(driveC, 'Program Files (x86)', 'EA Games'),
      path.join(driveC, 'Program Files', 'Origin Games'),
      path.join(driveC, 'Program Files (x86)', 'Origin Games')
    );
    const machineIni = path.join(driveC, 'ProgramData', 'EA Desktop', 'machine.ini');
    if (fs.existsSync(machineIni)) {
      try {
        parseIniDirLines(fs.readFileSync(machineIni, 'utf8'), true);
      } catch {}
    }
    const usersDir = path.join(driveC, 'users');
    if (fs.existsSync(usersDir)) {
      try {
        for (const u of fs.readdirSync(usersDir)) {
          if (/^(?:Public|All Users|Default|Default User)$/i.test(u)) continue;
          const eaLocalDir = path.join(
            usersDir,
            u,
            'AppData',
            'Local',
            'Electronic Arts',
            'EA Desktop'
          );
          if (!fs.existsSync(eaLocalDir)) continue;
          for (const f of fs.readdirSync(eaLocalDir)) {
            if (!/^user_.*\.ini$/i.test(f)) continue;
            try {
              parseIniDirLines(fs.readFileSync(path.join(eaLocalDir, f), 'utf8'), true);
            } catch {}
          }
        }
      } catch {}
    }
  } else if (platform === 'win32') {
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const sysDrive = String(options.systemDrive || env.SYSTEMDRIVE || env.SystemDrive || 'C:\\')
      .trim()
      .replace(/[\\/]+$/, '');
    const sysDriveRoot = /^[A-Za-z]:$/.test(sysDrive) ? `${sysDrive}\\` : sysDrive || 'C:\\';
    const progFiles =
      options.programFiles ||
      options.programFilesDir ||
      env.ProgramFiles ||
      env.PROGRAMFILES ||
      path.win32.join(sysDriveRoot, 'Program Files');
    const progFilesX86 =
      options.programFilesX86 ||
      options.programFilesX86Dir ||
      env['ProgramFiles(x86)'] ||
      env['PROGRAMFILES(X86)'] ||
      path.win32.join(sysDriveRoot, 'Program Files (x86)');
    const progData =
      options.programData ||
      env.ProgramData ||
      env.PROGRAMDATA ||
      path.win32.join(sysDriveRoot, 'ProgramData');
    const localAppData =
      env.LOCALAPPDATA ||
      (options.homedir ? path.join(options.homedir, 'AppData', 'Local') : '');

    roots.push(
      path.join(progFiles, 'EA Games'),
      path.join(progFilesX86, 'EA Games'),
      path.join(progFiles, 'Origin Games'),
      path.join(progFilesX86, 'Origin Games')
    );
    const machineIni = path.join(progData, 'EA Desktop', 'machine.ini');
    if (fs.existsSync(machineIni)) {
      try {
        parseIniDirLines(fs.readFileSync(machineIni, 'utf8'), false);
      } catch {}
    }
    if (localAppData) {
      const eaLocalDir = path.join(localAppData, 'Electronic Arts', 'EA Desktop');
      if (fs.existsSync(eaLocalDir)) {
        try {
          for (const f of fs.readdirSync(eaLocalDir)) {
            if (!/^user_.*\.ini$/i.test(f)) continue;
            try {
              parseIniDirLines(fs.readFileSync(path.join(eaLocalDir, f), 'utf8'), false);
            } catch {}
          }
        } catch {}
      }
    }
    if (Array.isArray(options.customRoots)) {
      for (const cr of options.customRoots) {
        if (!cr || typeof cr !== 'string') continue;
        roots.push(path.join(cr, 'EA Games'), path.join(cr, 'Origin Games'));
      }
    }
  }
  return roots;
}

/**
 * @param {string} candidatePath
 * @param {string | undefined} bottlePath
 * @returns {boolean}
 */
function isBroadStagingContainerPath(candidatePath, bottlePath) {
  if (!candidatePath || typeof candidatePath !== 'string') return true;
  const resolved = path.resolve(candidatePath);
  const norm = resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm || norm === '/' || /^[a-z]:$/.test(norm)) return true;
  if (bottlePath) {
    const driveCNorm = path
      .resolve(bottlePath, 'drive_c')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (
      norm === driveCNorm ||
      norm === `${driveCNorm}/program files` ||
      norm === `${driveCNorm}/program files (x86)` ||
      norm === `${driveCNorm}/windows` ||
      norm === `${driveCNorm}/users`
    ) {
      return true;
    }
  }
  const base = path.posix.basename(norm);
  if (
    base === 'program files' ||
    base === 'program files (x86)' ||
    base === 'windows' ||
    base === 'users' ||
    base === 'drive_c'
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} platform
 * @param {string | undefined} bottlePath
 * @param {any} [options]
 * @returns {string[]}
 */
function readBattleNetStagingRoots(platform, bottlePath, options = {}) {
  /** @type {string[]} */
  const roots = [];
  /** @type {string[]} */
  const configFiles = [];
  /** @type {string[]} */
  const sharedInstallContainers = [];

  if (platform === 'darwin' && bottlePath) {
    const driveC = path.join(bottlePath, 'drive_c');
    roots.push(path.join(driveC, 'ProgramData', 'Battle.net'));
    sharedInstallContainers.push(
      path.join(driveC, 'Program Files (x86)'),
      path.join(driveC, 'Program Files')
    );
    const usersDir = path.join(driveC, 'users');
    try {
      if (fs.existsSync(usersDir)) {
        for (const uEntry of fs.readdirSync(usersDir, { withFileTypes: true }).slice(0, 16)) {
          if (!uEntry.isDirectory() || /^public$/i.test(uEntry.name)) continue;
          configFiles.push(
            path.join(
              usersDir,
              uEntry.name,
              'AppData',
              'Roaming',
              'Battle.net',
              'Battle.net.config'
            )
          );
        }
      }
    } catch {}
  } else if (platform === 'win32') {
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const sysDrive = String(options.systemDrive || env.SYSTEMDRIVE || env.SystemDrive || 'C:\\')
      .trim()
      .replace(/[\\/]+$/, '');
    const sysDriveRoot = /^[A-Za-z]:$/.test(sysDrive) ? `${sysDrive}\\` : sysDrive || 'C:\\';
    const progData =
      options.programData ||
      env.ProgramData ||
      env.PROGRAMDATA ||
      path.win32.join(sysDriveRoot, 'ProgramData');
    const progFiles =
      options.programFiles ||
      options.programFilesDir ||
      env.ProgramFiles ||
      env.PROGRAMFILES ||
      path.win32.join(sysDriveRoot, 'Program Files');
    const progFilesX86 =
      options.programFilesX86 ||
      options.programFilesX86Dir ||
      env['ProgramFiles(x86)'] ||
      env['PROGRAMFILES(X86)'] ||
      path.win32.join(sysDriveRoot, 'Program Files (x86)');
    const appData =
      options.appData ||
      env.APPDATA ||
      (options.homedir
        ? path.join(options.homedir, 'AppData', 'Roaming')
        : path.join(os.homedir(), 'AppData', 'Roaming'));
    roots.push(path.join(progData, 'Battle.net'));
    sharedInstallContainers.push(progFilesX86, progFiles);
    if (appData) {
      configFiles.push(path.join(appData, 'Battle.net', 'Battle.net.config'));
    }
  }

  for (const cfgFile of configFiles) {
    try {
      if (!fs.existsSync(cfgFile)) continue;
      const st = fs.statSync(cfgFile);
      if (!st.isFile() || st.size <= 0 || st.size > 524288) continue;
      const parsed = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      const rawDefaultPath = String(
        parsed?.Client?.Install?.DefaultInstallPath || parsed?.DefaultInstallPath || ''
      ).trim();
      if (!rawDefaultPath) continue;
      const localDefaultPath =
        platform === 'darwin' && bottlePath
          ? fromWineWindowsPath(rawDefaultPath, bottlePath)
          : rawDefaultPath;
      if (!localDefaultPath) continue;
      if (isBroadStagingContainerPath(localDefaultPath, bottlePath)) {
        sharedInstallContainers.unshift(localDefaultPath);
      } else {
        roots.push(localDefaultPath);
      }
    } catch {}
  }

  const seenContainers = new Set();
  for (const container of sharedInstallContainers) {
    if (!container) continue;
    const key = path.resolve(container).toLowerCase();
    if (seenContainers.has(key)) continue;
    seenContainers.add(key);
    try {
      if (!fs.existsSync(container)) continue;
      const entries = fs.readdirSync(container, { withFileTypes: true }).slice(0, 96);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (/^battle\.net$/i.test(entry.name)) continue;
        const childDir = path.join(container, entry.name);
        if (
          fs.existsSync(path.join(childDir, '.build.info')) ||
          fs.existsSync(path.join(childDir, '.product.db'))
        ) {
          roots.push(childDir);
        }
      }
    } catch {}
  }

  return roots;
}

/**
 * Collect deduplicated, ancestor-normalized publisher staging roots.
 *
 * @param {string} handoffId
 * @param {string} platform
 * @param {string | undefined} bottlePath
 * @param {any} options
 * @returns {Array<{ raw: string, normKey: string }>}
 */
function collectUniquePublisherStagingRoots(handoffId, platform, bottlePath, options) {
  /** @type {string[]} */
  const candidateRoots = [];

  if (typeof chainedPublisherLaunchers.resolvePublisherStagingDirs === 'function') {
    try {
      const helperDirs = chainedPublisherLaunchers.resolvePublisherStagingDirs(handoffId, {
        ...options,
        platform,
        hostPlatform: platform,
        bottlePath,
        env: options.env && typeof options.env === 'object' ? options.env : process.env,
      });
      if (Array.isArray(helperDirs)) {
        for (const d of helperDirs) {
          if (typeof d === 'string' && d.trim() && !isBroadStagingContainerPath(d, bottlePath)) {
            candidateRoots.push(d.trim());
          }
        }
      }
    } catch {}
  }

  if (handoffId === 'ea') {
    if (typeof chainedPublisherLaunchers.readEaConfiguredLibraryRoots === 'function') {
      try {
        const helperRoots =
          platform === 'darwin' && bottlePath
            ? chainedPublisherLaunchers.readEaConfiguredLibraryRoots({
                ...options,
                platform: 'darwin',
                bottlePath,
              })
            : chainedPublisherLaunchers.readEaConfiguredLibraryRoots({
                ...options,
                platform: 'win32',
              });
        if (Array.isArray(helperRoots)) {
          candidateRoots.push(...helperRoots);
        }
      } catch {}
    }
    candidateRoots.push(...readInlineEaConfiguredLibraryRoots(platform, bottlePath, options));
  } else if (handoffId === 'bnet') {
    candidateRoots.push(...readBattleNetStagingRoots(platform, bottlePath, options));
  } else if (platform === 'darwin' && bottlePath) {
    const driveC = path.join(bottlePath, 'drive_c');
    if (handoffId === 'ubisoft') {
      candidateRoots.push(
        path.join(driveC, 'Program Files (x86)', 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
        path.join(driveC, 'Program Files', 'Ubisoft', 'Ubisoft Game Launcher', 'games')
      );
    } else if (handoffId === 'rockstar') {
      candidateRoots.push(
        path.join(driveC, 'Program Files', 'Rockstar Games'),
        path.join(driveC, 'Program Files (x86)', 'Rockstar Games')
      );
    } else if (handoffId === 'riot') {
      candidateRoots.push(
        path.join(driveC, 'Riot Games'),
        path.join(driveC, 'ProgramData', 'Riot Games')
      );
    }
  } else if (platform === 'win32') {
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const sysDrive = String(options.systemDrive || env.SYSTEMDRIVE || env.SystemDrive || 'C:\\')
      .trim()
      .replace(/[\\/]+$/, '');
    const sysDriveRoot = /^[A-Za-z]:$/.test(sysDrive) ? `${sysDrive}\\` : sysDrive || 'C:\\';
    const progFiles =
      options.programFiles ||
      options.programFilesDir ||
      env.ProgramFiles ||
      env.PROGRAMFILES ||
      path.win32.join(sysDriveRoot, 'Program Files');
    const progFilesX86 =
      options.programFilesX86 ||
      options.programFilesX86Dir ||
      env['ProgramFiles(x86)'] ||
      env['PROGRAMFILES(X86)'] ||
      path.win32.join(sysDriveRoot, 'Program Files (x86)');
    const progData =
      options.programData ||
      env.ProgramData ||
      env.PROGRAMDATA ||
      path.win32.join(sysDriveRoot, 'ProgramData');
    if (handoffId === 'ubisoft') {
      candidateRoots.push(
        path.join(progFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
        path.join(progFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'games')
      );
    } else if (handoffId === 'rockstar') {
      candidateRoots.push(
        path.join(progFiles, 'Rockstar Games'),
        path.join(progFilesX86, 'Rockstar Games')
      );
    } else if (handoffId === 'riot') {
      candidateRoots.push(
        path.join(sysDriveRoot, 'Riot Games'),
        path.join(progData, 'Riot Games')
      );
    }
  }

  /** @type {Array<{ raw: string, normKey: string }>} */
  const uniqueResolved = [];
  const seenResolved = new Set();
  for (const r of candidateRoots) {
    if (!r || typeof r !== 'string') continue;
    if (isBroadStagingContainerPath(r, bottlePath)) continue;
    const resolvedPath = path.resolve(r).replace(/[\\/]+$/, '');
    const normKey = resolvedPath.toLowerCase();
    if (seenResolved.has(normKey)) continue;
    seenResolved.add(normKey);
    uniqueResolved.push({ raw: r, normKey });
  }
  uniqueResolved.sort((a, b) => a.normKey.length - b.normKey.length);
  return uniqueResolved;
}

/**
 * Synchronous publisher staging size measurement (preserved for synchronous API/test callers).
 *
 * @param {string} handoffId
 * @param {string | Record<string, any>} platformOrOptions
 * @param {string | undefined} [bottlePathArg]
 * @param {any} [optionsArg]
 * @returns {number}
 */
function measurePublisherStagingBytes(
  handoffId,
  platformOrOptions,
  bottlePathArg,
  optionsArg = {}
) {
  const isTwoArgObjectCall =
    platformOrOptions !== null && typeof platformOrOptions === 'object';
  const options = isTwoArgObjectCall ? platformOrOptions : optionsArg || {};
  const platform = isTwoArgObjectCall
    ? String(options.platform || options.hostPlatform || process.platform)
    : String(platformOrOptions || options.platform || process.platform);
  const bottlePath = isTwoArgObjectCall ? options.bottlePath : bottlePathArg;

  const uniqueResolved = collectUniquePublisherStagingRoots(handoffId, platform, bottlePath, options);

  /** @type {string[]} */
  const countedNormPrefixes = [];
  let total = 0;
  for (const item of uniqueResolved) {
    if (
      countedNormPrefixes.some(
        (parent) =>
          item.normKey.startsWith(`${parent}/`) || item.normKey.startsWith(`${parent}\\`)
      )
    ) {
      continue;
    }
    try {
      if (fs.existsSync(item.raw)) {
        countedNormPrefixes.push(item.normKey);
        total += Math.max(0, getDirectorySizeFast(item.raw, 3));
      }
    } catch {}
  }
  return total;
}

/**
 * Non-blocking asynchronous publisher staging size measurement using `getDirectorySizeFastAsync`
 * for hot 4-second monitor polling loops and pre-spawn baselines.
 *
 * @param {string} handoffId
 * @param {string} platform
 * @param {string | undefined} bottlePath
 * @param {any} [options]
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<number>}
 */
async function measurePublisherStagingBytesAsync(
  handoffId,
  platform,
  bottlePath,
  options = {},
  signal = null
) {
  const uniqueResolved = collectUniquePublisherStagingRoots(handoffId, platform, bottlePath, options);
  /** @type {string[]} */
  const countedNormPrefixes = [];
  let total = 0;
  for (const item of uniqueResolved) {
    if (signal?.aborted) break;
    if (
      countedNormPrefixes.some(
        (parent) =>
          item.normKey.startsWith(`${parent}/`) || item.normKey.startsWith(`${parent}\\`)
      )
    ) {
      continue;
    }
    try {
      if (await pathExistsAsync(item.raw)) {
        countedNormPrefixes.push(item.normKey);
        total += Math.max(0, await getDirectorySizeFastAsync(item.raw, { maxDepth: 3, signal }));
      }
    } catch {}
  }
  return total;
}

/**
 * Monitors a bottle or Windows host chained publisher launcher (`Ubisoft Connect`, `EA App`,
 * `Battle.net`, `Rockstar Games Launcher`) until the target game finishes installing or the
 * launcher exits cleanly without installing.
 *
 * @param {string} taskId
 * @param {any} monitorCfg
 * @param {any} [options]
 */
function startChainedLauncherInstallMonitor(taskId, monitorCfg, options = {}) {
  const intervalMs = Math.max(250, Number(options.chainedInstallPollIntervalMs || 4000));
  const gracePeriodMs = Math.max(0, Number(options.chainedLauncherGracePeriodMs ?? 45000));
  const startedAt = Date.now();
  const {
    handoffId,
    ecosystem,
    platform,
    bottlePath,
    bottleName,
    compatibilityLayer,
    title,
    platformId,
    platformGameId,
    cleanStoreId,
    externalInstallId,
    chainedHandoffTopology,
    epicPartnerRegistryPath,
    signal,
  } = monitorCfg;
  const epicRegLeaf = extractEpicRegistryLeaf(epicPartnerRegistryPath);

  /** @type {number | null} */
  let baselineBytes =
    typeof monitorCfg.baselineStagingBytes === 'number' &&
    Number.isFinite(monitorCfg.baselineStagingBytes)
      ? Math.max(0, monitorCfg.baselineStagingBytes)
      : null;
  let lastGrowthBytes = 0;
  let lastTickTime = Date.now();
  let consecutiveDeadLauncherPolls = 0;
  let inFlightTick = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  const stopMonitor = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    downloadControllers.delete(taskId);
  };

  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', stopMonitor, { once: true });
  }

  const runTick = () => {
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
        stopMonitor();
        return;
      }
      if (task.status === 'paused') return;

      const discovered =
        platform === 'darwin' && bottlePath
          ? scanBottlePublisherInstalledGames(bottlePath, options)
          : scanHostPublisherInstalledGames({ ...options, platform });

      const matched = discovered.find(
        (/** @type {any} */ g) =>
          g &&
          g.handoffId === handoffId &&
          g.executablePath &&
          !isGdkStubExecutablePath(g.executablePath) &&
          !/steamapps[\\/]common/i.test(String(g.installPath || '')) &&
          ((externalInstallId &&
            String(g.externalInstallId || '').toLowerCase() ===
              String(externalInstallId).toLowerCase()) ||
            doChainedPublisherTitlesMatch(g.title, title) ||
            (epicRegLeaf &&
              g.installPath &&
              doChainedPublisherTitlesMatch(path.basename(g.installPath), epicRegLeaf)))
      );

      if (matched && (await pathExistsAsync(matched.executablePath))) {
        stopMonitor();
        const finalSize =
          sanitizeGameInstallSizeBytes(matched.installSizeBytes) ||
          sanitizeGameInstallSizeBytes(task.totalBytes);
        const effectiveTopology =
          chainedHandoffTopology ||
          (platformId === 'epic'
            ? 'partner_launcher_link'
            : platformId === 'xbox'
              ? 'publisher_managed'
              : undefined);
        upsertManagedInstallRecord(
          {
            platformId: platformId || 'xbox',
            platformGameId,
            ...(cleanStoreId ? { xboxProductId: cleanStoreId } : {}),
            title: matched.title || title,
            installPath: matched.installPath,
            executablePath: matched.executablePath,
            ...(finalSize ? { installSize: finalSize } : {}),
            chainedLauncherHandoff: handoffId,
            externalStorefrontHandoff: handoffId,
            ...(effectiveTopology ? { chainedHandoffTopology: effectiveTopology } : {}),
            ...(epicPartnerRegistryPath ? { epicPartnerRegistryPath } : {}),
            ...(matched.externalInstallId
              ? { chainedExternalInstallId: String(matched.externalInstallId) }
              : {}),
            runner: platform === 'darwin' ? 'chained_bottle' : 'chained_host',
            ...(platform === 'darwin'
              ? {
                  ...(compatibilityLayer ? { compatibilityLayer } : {}),
                  ...(bottleName ? { wineBottle: bottleName } : {}),
                  isWindowsBinaryOnMac: true,
                }
              : { isWindowsBinaryOnMac: false }),
          },
          options.userDataDir
        );
        notifyInstalledGamesUpdated();
        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: finalSize || Number(task.totalBytes || 0),
            totalBytes: finalSize || Number(task.totalBytes || 0),
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            finalInstallPath: matched.installPath,
            executablePath: matched.executablePath,
            runner: platform === 'darwin' ? 'chained_bottle' : 'chained_host',
            statusMessage: `Installed via ${ecosystem?.displayName || handoffId}`,
          },
          options
        );
        return;
      }

      const currentStagingBytes = await measurePublisherStagingBytesAsync(
        handoffId,
        platform,
        bottlePath,
        options,
        signal || null
      );
      if (baselineBytes === null) {
        baselineBytes = currentStagingBytes;
      }
      const deltaBytes = Math.max(0, currentStagingBytes - baselineBytes);
      const grewThisTick = deltaBytes > lastGrowthBytes;
      if (deltaBytes > 0) {
        if (grewThisTick) {
          consecutiveDeadLauncherPolls = 0;
        }
        const now = Date.now();
        const rawSpeed =
          grewThisTick && now > lastTickTime
            ? Math.round(((deltaBytes - lastGrowthBytes) * 1000) / (now - lastTickTime))
            : 0;
        lastGrowthBytes = deltaBytes;
        lastTickTime = now;
        const speedBytesPerSec = computeSmoothedDownloadSpeed(taskId, {
          bytesDownloaded: deltaBytes,
          rawSpeedBytesPerSec: rawSpeed,
          nowMs: now,
        });
        const expectedTotal = Math.max(Number(task.totalBytes || 0), deltaBytes);
        const pct =
          expectedTotal > deltaBytes
            ? Math.min(99, Math.round((deltaBytes / expectedTotal) * 100))
            : Math.min(95, Number(task.progressPercent || 0));
        updateDownloadTask(
          taskId,
          {
            status: 'downloading',
            progressPercent: pct,
            bytesDownloaded: deltaBytes,
            deltaStagingBytes: deltaBytes,
            totalBytes: expectedTotal,
            speedBytesPerSec,
            statusMessage: `${ecosystem?.displayName || handoffId}: Installing ${title}...`,
          },
          options
        );
        if (grewThisTick) {
          return;
        }
      }

      if (Date.now() - startedAt >= gracePeriodMs) {
        const alive =
          platform === 'darwin' && bottlePath
            ? await checkBottlePublisherLauncherAliveAsync(bottlePath, options, handoffId)
            : platform === 'win32'
              ? await checkHostWinPublisherLauncherAliveAsync(handoffId, options)
              : true;
        if (!alive) {
          consecutiveDeadLauncherPolls += 1;
          if (consecutiveDeadLauncherPolls >= 2) {
            stopMonitor();
            const curTask = downloadQueueMap.get(taskId);
            if (curTask) {
              const pubTask = toPublicDownloadTask(curTask);
              downloadQueueMap.delete(taskId);
              persistDownloadQueueToDisk(options.userDataDir || curTask._persistedUserDataDir);
              emitDownloadUpdated({
                task: {
                  ...pubTask,
                  status: 'cancelled',
                  speedBytesPerSec: 0,
                  statusMessage: `${ecosystem?.displayName || 'Publisher launcher'} closed without installing ${title}.`,
                },
                queue: getDownloadQueue(options),
              });
            }
          }
        } else {
          consecutiveDeadLauncherPolls = 0;
        }
      }
    })()
      .catch((tickErr) => {
        diagLog.debug('startChainedLauncherInstallMonitor.tick', tickErr, { taskId, handoffId });
      })
      .finally(() => {
        inFlightTick = false;
      });
  };

  timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  downloadControllers.set(taskId, { type: 'timer', timer });
  return timer;
}

/**
 * Shared Dual-OS (`darwin` Wine/CrossOver bottle + `win32` native host) installation orchestrator
 * for chained publisher games (`xbox` `publisher_managed`, `epic` `partner_launcher_link`, and
 * standalone publisher storefronts).
 *
 * @param {{
 *   taskId: string,
 *   task: any,
 *   payload: any,
 *   platform: string,
 *   platformId: string,
 *   platformGameId: string,
 *   title: string,
 *   cleanStoreId?: string,
 *   chainedHandoffId: string | null | undefined,
 *   chainedHandoffTopology?: string,
 *   epicPartnerRegistryPath?: string
 * }} flowParams
 * @param {any} [options={}]
 */
async function executeChainedPublisherInstallFlow(flowParams, options = {}) {
  const {
    taskId,
    task,
    payload,
    platform,
    platformId,
    platformGameId,
    title,
    cleanStoreId = '',
    chainedHandoffId,
    chainedHandoffTopology,
    epicPartnerRegistryPath,
  } = flowParams;

  const chainedEcosystem = chainedHandoffId
    ? CHAINED_PUBLISHER_ECOSYSTEMS[chainedHandoffId]
    : null;
  if (!chainedHandoffId || !chainedEcosystem) {
    const unknownErr = `Unable to determine publisher launcher ecosystem for ${title}.`;
    updateDownloadTask(
      taskId,
      {
        status: 'failed',
        speedBytesPerSec: 0,
        etaSeconds: undefined,
        error: unknownErr,
        statusMessage: unknownErr,
      },
      options
    );
    return { success: false, error: unknownErr };
  }

  const epicRegLeaf = extractEpicRegistryLeaf(epicPartnerRegistryPath);
  const effectiveTopology =
    chainedHandoffTopology ||
    (platformId === 'epic'
      ? 'partner_launcher_link'
      : platformId === 'xbox'
        ? 'publisher_managed'
        : undefined);
  const effectiveExternalInstallId = payload.chainedExternalInstallId || undefined;
  const isXboxChainedHandoff = String(platformId || '').toLowerCase() === 'xbox';
  const accountLinkHint = isXboxChainedHandoff
    ? `Ensure your Xbox account is linked to your ${chainedEcosystem.displayName} account so your Game Pass entitlement appears in ${chainedEcosystem.displayName}.`
    : undefined;

  if (platform === 'darwin') {
    if (!chainedEcosystem.supportedInWineBottle) {
      const unsupportedReason =
        chainedEcosystem.unsupportedBottleReason ||
        `${chainedEcosystem.displayName} requires Windows kernel anti-cheat and cannot run inside a macOS compatibility bottle.`;
      updateDownloadTask(
        taskId,
        {
          status: 'failed',
          speedBytesPerSec: 0,
          etaSeconds: undefined,
          error: unsupportedReason,
          statusMessage: unsupportedReason,
        },
        options
      );
      return { success: false, error: unsupportedReason };
    }

    const controller = new AbortController();
    /** @type {any} */
    const ctrl = {
      type: 'abort',
      controller,
      pausedByUser: false,
      cancelRequested: false,
    };
    downloadControllers.set(taskId, ctrl);

    try {
      const homedir = options.homedir || os.homedir();
      const explicitHomedirOpt = options.homedir ? { homedir: options.homedir } : {};
      const hostArch = String(
        options.arch || options.hostArch || process.arch || 'arm64'
      ).toLowerCase();
      let gameCfgBottleName = '';
      let gameCfgCompatLayer = '';
      try {
        const allLaunchCfgs = getGameLaunchConfigs(options) || {};
        const lookupId = String(payload.gameId || `${platformId}_${platformGameId}`).trim();
        const rawSavedCfg =
          allLaunchCfgs[lookupId] ||
          allLaunchCfgs[`${platformId}-${platformGameId}`] ||
          allLaunchCfgs[String(platformGameId || '')] ||
          null;
        const resolvedSavedCfg = resolvePlatformLaunchConfig(rawSavedCfg || {}, platformId);
        gameCfgBottleName = String(resolvedSavedCfg?.wineBottleName || '').trim();
        gameCfgCompatLayer = String(resolvedSavedCfg?.compatibilityLayer || '').trim();
      } catch {}
      const requestedLayerType = normalizeRequestedCompatibilityLayerType(
        payload.compatibilityLayer ||
          payload.launchConfig?.compatibilityLayer ||
          options.compatibilityLayer ||
          gameCfgCompatLayer
      );
      if (requestedLayerType === 'crossover_preview_arm64' && hostArch !== 'arm64') {
        throw new Error(
          'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
        );
      }
      const detectedLayers = detectCompatibilityLayers({
        ...options,
        platform: 'darwin',
        ...explicitHomedirOpt,
      });
      const explicitLayerMatch = requestedLayerType
        ? detectedLayers.find(
            (/** @type {any} */ l) =>
              l && (l.type === requestedLayerType || l.id === requestedLayerType)
          )
        : null;
      if (requestedLayerType && !options.compatibilityLayerObj) {
        if (!explicitLayerMatch) {
          throw new Error(`Compatibility runner "${requestedLayerType}" is not installed.`);
        }
        if (
          explicitLayerMatch.available === false ||
          (explicitLayerMatch.type === 'crossover_preview_arm64' && hostArch !== 'arm64')
        ) {
          throw new Error(
            explicitLayerMatch.type === 'crossover_preview_arm64'
              ? 'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
              : `Compatibility runner "${requestedLayerType}" is unavailable on this host.`
          );
        }
      }
      const chosenLayer =
        options.compatibilityLayerObj ||
        explicitLayerMatch ||
        detectedLayers.find(
          (/** @type {any} */ l) =>
            l &&
            l.available !== false &&
            (l.type === 'crossover' ||
              l.type === 'crossover_preview' ||
              l.type === 'crossover_preview_arm64')
        ) ||
        detectedLayers.find((/** @type {any} */ l) => l && l.available !== false) ||
        detectedLayers[0] ||
        null;
      if (
        chosenLayer?.type === 'crossover_preview_arm64' &&
        (hostArch !== 'arm64' || chosenLayer.available === false)
      ) {
        throw new Error(
          'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
        );
      }

      const explicitBottleName = String(
        payload.wineBottle || payload.wineBottleName || options.bottleName || ''
      ).trim();
      let wizardPreferredBottleName = '';
      let wizardPreferredRunnerType = '';
      try {
        const getWizardStateFn = getSetupWizardStateLazy();
        const wizardState =
          typeof getWizardStateFn === 'function' ? getWizardStateFn(options) : null;
        wizardPreferredBottleName = String(wizardState?.preferredBottleName || '').trim();
        wizardPreferredRunnerType = String(wizardState?.preferredRunnerType || '').trim();
      } catch {}
      const chosenBottlesDir =
        chosenLayer?.bottlesDir ||
        path.join(homedir, 'Library', 'Application Support', 'CrossOver', 'Bottles');
      const isArm64ChosenLayer = chosenLayer?.type === 'crossover_preview_arm64';
      const isIntelCrossOverChosenLayer =
        chosenLayer?.type === 'crossover' || chosenLayer?.type === 'crossover_preview';
      const discoveredBottleNames = Array.isArray(chosenLayer?.availableBottles)
        ? chosenLayer.availableBottles.map((/** @type {string} */ bName) => {
            const bPath = path.join(chosenBottlesDir, bName);
            const detailMeta = chosenLayer?.bottleDetails?.[bName];
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
      let effectiveWizardPreferredBottleName = wizardPreferredBottleName;
      if (
        wizardPreferredBottleName &&
        (isArm64ChosenLayer || isIntelCrossOverChosenLayer)
      ) {
        const candidateWizardBottleDirs = Array.from(
          new Set(
            [
              chosenBottlesDir,
              path.join(homedir, 'Library', 'Application Support', 'CrossOver', 'Bottles'),
              path.join(
                homedir,
                'Library',
                'Application Support',
                'CrossOver Preview',
                'Bottles'
              ),
              path.join(
                homedir,
                'Library',
                'Application Support',
                'CrossOver Preview arm64',
                'Bottles'
              ),
            ].filter(Boolean)
          )
        );
        const detailArch = chosenLayer?.bottleDetails?.[wizardPreferredBottleName]?.wineArch;
        if (detailArch && (isArm64ChosenLayer ? detailArch !== 'arm64' : detailArch === 'arm64')) {
          effectiveWizardPreferredBottleName = '';
        } else {
          for (const dir of candidateWizardBottleDirs) {
            const candPath = path.join(dir, wizardPreferredBottleName);
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
        if (
          effectiveWizardPreferredBottleName &&
          wizardPreferredRunnerType &&
          wizardPreferredRunnerType !== 'skip' &&
          (wizardPreferredRunnerType === 'crossover_preview_arm64') !== isArm64ChosenLayer &&
          wizardPreferredBottleName.toLowerCase() ===
            (wizardPreferredRunnerType === 'crossover_preview_arm64'
              ? 'onelauncher-arm64'
              : 'onelauncher')
        ) {
          effectiveWizardPreferredBottleName = '';
        }
      }
      const helperBottleName =
        typeof chainedPublisherLaunchers.resolveDefaultChainedBottleName === 'function'
          ? String(
              chainedPublisherLaunchers.resolveDefaultChainedBottleName({
                explicitBottleName,
                gameConfigBottleName: gameCfgBottleName,
                wizardPreferredBottleName: effectiveWizardPreferredBottleName || undefined,
                discoveredBottleNames,
                runnerType: chosenLayer?.type,
              }) || ''
            ).trim()
          : '';
      const requestedBottleName =
        helperBottleName ||
        explicitBottleName ||
        gameCfgBottleName ||
        effectiveWizardPreferredBottleName ||
        (isArm64ChosenLayer ? 'OneLauncher-arm64' : 'OneLauncher');
      /** @type {Record<string, any>} */
      const bottleInitEnv = {};
      let compatReadyRes = null;
      if (chosenLayer && !payload.bottlePath && !options.bottlePath) {
        try {
          compatReadyRes = await ensureCompatibilityLayerReady(
            chosenLayer,
            { wineBottleName: requestedBottleName },
            bottleInitEnv,
            { ...options, platform: 'darwin', ...explicitHomedirOpt }
          );
        } catch (/** @type {any} */ compatErr) {
          const msg = String(compatErr?.message || compatErr || '');
          if (/incompatible|WineArch=|Invalid CrossOver bottle/i.test(msg)) {
            throw compatErr;
          }
        }
      }
      if (isTaskCancelledOrPaused(taskId, ctrl)) {
        downloadControllers.delete(taskId);
        return { success: false, error: 'Download cancelled or paused.' };
      }

      const resolvedBottlesRoot =
        chosenLayer?.bottlesDir || path.join(homedir, 'Games', 'OneLauncher', 'Prefixes');
      let targetBottlePath = String(
        payload.bottlePath ||
          options.bottlePath ||
          compatReadyRes?.winePrefix ||
          bottleInitEnv.WINEPREFIX ||
          path.join(resolvedBottlesRoot, requestedBottleName)
      );
      if (chosenLayer?.type && targetBottlePath) {
        assertRunnerBottleArchCompatible(chosenLayer.type, requestedBottleName, targetBottlePath);
      }

      const ensurePublisherFn =
        options.ensureChainedPublisherLauncherInstalledFn ||
        getEnsureChainedPublisherLauncherInstalled();
      if (typeof ensurePublisherFn !== 'function') {
        throw new Error('Publisher launcher provisioner is unavailable.');
      }

      const ensured = await ensurePublisherFn(
        {
          handoffId: chainedHandoffId,
          platform: 'darwin',
          runnerLayer: chosenLayer,
          bottleName: requestedBottleName,
          bottlePath: targetBottlePath,
          signal: controller.signal,
          onProgress: (/** @type {any} */ prog) => {
            if (!prog || typeof prog !== 'object' || ctrl.cancelRequested || ctrl.pausedByUser) {
              return;
            }
            updateDownloadTask(
              taskId,
              {
                status: 'downloading',
                ...(typeof prog.percent === 'number'
                  ? {
                      progressPercent: Math.min(99, Math.max(0, Math.round(prog.percent))),
                    }
                  : {}),
                ...(prog.downloadedBytes ? { bytesDownloaded: prog.downloadedBytes } : {}),
                ...(prog.totalBytes ? { totalBytes: prog.totalBytes } : {}),
                ...(typeof prog.speedBytesPerSec === 'number'
                  ? { speedBytesPerSec: prog.speedBytesPerSec }
                  : {}),
                ...(prog.message ? { statusMessage: prog.message } : {}),
              },
              options
            );
          },
        },
        options
      );

      if (isTaskCancelledOrPaused(taskId, ctrl)) {
        downloadControllers.delete(taskId);
        return { success: false, error: 'Download cancelled or paused.' };
      }

      targetBottlePath = path.resolve(
        ensured?.bottlePath ||
          extractBottleRootFromPath(ensured?.binaryPath || '') ||
          targetBottlePath
      );
      const effectiveBottleName = path.basename(targetBottlePath) || requestedBottleName;
      const effectiveLayerType = chosenLayer?.type || 'crossover';

      // Fast-path: check if user already installed this game inside targetBottlePath
      const existingInBottle = scanBottlePublisherInstalledGames(targetBottlePath, {
        ...options,
        homedir,
      });
      const preInstalledMatch = existingInBottle.find(
        (/** @type {any} */ g) =>
          g &&
          g.handoffId === chainedHandoffId &&
          g.executablePath &&
          !isGdkStubExecutablePath(g.executablePath) &&
          !/steamapps[\\/]common/i.test(String(g.installPath || '')) &&
          ((effectiveExternalInstallId &&
            String(g.externalInstallId || '').toLowerCase() ===
              String(effectiveExternalInstallId).toLowerCase()) ||
            doChainedPublisherTitlesMatch(g.title, title) ||
            (epicRegLeaf &&
              g.installPath &&
              doChainedPublisherTitlesMatch(path.basename(g.installPath), epicRegLeaf)))
      );
      if (preInstalledMatch && (await pathExistsAsync(preInstalledMatch.executablePath))) {
        const preSize = sanitizeGameInstallSizeBytes(preInstalledMatch.installSizeBytes);
        upsertManagedInstallRecord(
          {
            platformId,
            platformGameId,
            ...(cleanStoreId ? { xboxProductId: cleanStoreId } : {}),
            title: preInstalledMatch.title || title,
            installPath: preInstalledMatch.installPath,
            executablePath: preInstalledMatch.executablePath,
            ...(preSize ? { installSize: preSize } : {}),
            chainedLauncherHandoff: chainedHandoffId,
            externalStorefrontHandoff: chainedHandoffId,
            ...(effectiveTopology ? { chainedHandoffTopology: effectiveTopology } : {}),
            ...(epicPartnerRegistryPath ? { epicPartnerRegistryPath } : {}),
            ...(preInstalledMatch.externalInstallId
              ? { chainedExternalInstallId: String(preInstalledMatch.externalInstallId) }
              : {}),
            runner: 'chained_bottle',
            compatibilityLayer: effectiveLayerType,
            wineBottle: effectiveBottleName,
            isWindowsBinaryOnMac: true,
          },
          options.userDataDir
        );
        downloadControllers.delete(taskId);
        notifyInstalledGamesUpdated();
        updateDownloadTask(
          taskId,
          {
            status: 'completed',
            progressPercent: 100,
            bytesDownloaded: preSize || Number(task.totalBytes || 0),
            totalBytes: preSize || Number(task.totalBytes || 0),
            speedBytesPerSec: 0,
            etaSeconds: undefined,
            finalInstallPath: preInstalledMatch.installPath,
            executablePath: preInstalledMatch.executablePath,
            runner: 'chained_bottle',
            statusMessage: `Installed via ${chainedEcosystem.displayName}`,
          },
          options
        );
        const completedTask = downloadQueueMap.get(taskId) || task;
        return {
          success: true,
          status: 'installed',
          installPath: preInstalledMatch.installPath,
          executablePath: preInstalledMatch.executablePath,
          task: toPublicDownloadTask(completedTask),
        };
      }

      // Capture staging baseline asynchronously BEFORE spawning publisher launcher
      const baselineStagingBytes = await measurePublisherStagingBytesAsync(
        chainedHandoffId,
        'darwin',
        targetBottlePath,
        options,
        controller.signal
      );

      if (isTaskCancelledOrPaused(taskId, ctrl)) {
        downloadControllers.delete(taskId);
        return { success: false, error: 'Download cancelled or paused.' };
      }

      // Spawn publisher launcher inside the bottle (NEVER opening a macOS browser webpage!)
      const launchSpec = buildChainedLauncherLaunchSpec({
        handoffId: chainedHandoffId,
        externalInstallId: effectiveExternalInstallId,
        launcherBinaryPath: ensured.binaryPath,
        installDir: payload.targetInstallDir || payload.installPath || '',
        bottlePath: targetBottlePath,
        platform: 'darwin',
        compatibilityLayerType: effectiveLayerType,
      });
      const isCrossOverRunner =
        effectiveLayerType === 'crossover' ||
        effectiveLayerType === 'crossover_preview' ||
        effectiveLayerType === 'crossover_preview_arm64';
      const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
      /** @type {Record<string, any>} */
      const childEnv = {
        ...process.env,
        WINEPREFIX: targetBottlePath,
        ...(isCrossOverRunner ? { CX_BOTTLE: effectiveBottleName } : {}),
        ...(launchSpec.envOverrides || {}),
      };
      const alignedLaunch = chosenLayer?.binaryPath
        ? prepareAlignedAuxBottleWineCommand({
            wineBinary: chosenLayer.binaryPath,
            bottlePath: targetBottlePath,
            env: childEnv,
            layerType: effectiveLayerType,
          })
        : { binaryPath: '', env: childEnv };
      const wineBin = alignedLaunch.binaryPath;
      const effectiveChildEnv = alignedLaunch.env;
      if (!wineBin) {
        throw new Error(
          `No Wine / CrossOver runner binary available to launch ${chainedEcosystem.displayName}.`
        );
      }
      const trimmedChildDll =
        typeof effectiveChildEnv.WINEDLLOVERRIDES === 'string'
          ? effectiveChildEnv.WINEDLLOVERRIDES.trim()
          : '';
      const childDllArgs =
        trimmedChildDll &&
        isCrossOverPerlWineWrapperOptions({
          binaryPath: wineBin,
          layerType: effectiveLayerType,
        })
          ? ['--dll', trimmedChildDll]
          : [];
      const spawnedLauncher = spawnImpl(
        wineBin,
        [...childDllArgs, launchSpec.launcherExe, ...(launchSpec.args || [])],
        {
          cwd: path.dirname(ensured.binaryPath),
          env: effectiveChildEnv,
          detached: true,
          stdio: 'ignore',
        }
      );
      if (spawnedLauncher && typeof spawnedLauncher.on === 'function') {
        spawnedLauncher.on('error', (/** @type {any} */ spawnErr) => {
          diagLog.warn('installGame.chainedBottleLauncherSpawnError', spawnErr, {
            handoffId: chainedHandoffId,
            wineBin,
          });
        });
      }
      if (spawnedLauncher && typeof spawnedLauncher.unref === 'function') {
        spawnedLauncher.unref();
      }

      const openedMsg = isXboxChainedHandoff
        ? `Opened ${chainedEcosystem.displayName} in bottle — ensure your Xbox account is linked to your ${chainedEcosystem.displayName} account and click Install for ${title}...`
        : `Opened ${chainedEcosystem.displayName} in bottle — sign in with your linked account and click Install for ${title}...`;
      updateDownloadTask(
        taskId,
        {
          status: 'downloading',
          speedBytesPerSec: 0,
          etaSeconds: undefined,
          statusMessage: openedMsg,
          ...(accountLinkHint ? { accountLinkHint } : {}),
        },
        options
      );

      if (!options.skipInstallMonitor) {
        startChainedLauncherInstallMonitor(
          taskId,
          {
            handoffId: chainedHandoffId,
            ecosystem: chainedEcosystem,
            platform: 'darwin',
            bottlePath: targetBottlePath,
            bottleName: effectiveBottleName,
            compatibilityLayer: effectiveLayerType,
            title,
            platformId,
            platformGameId,
            cleanStoreId,
            externalInstallId: effectiveExternalInstallId,
            chainedHandoffTopology: effectiveTopology,
            epicPartnerRegistryPath,
            baselineStagingBytes,
            signal: controller.signal,
          },
          options
        );
      } else {
        downloadControllers.delete(taskId);
      }

      const curBottleTask = downloadQueueMap.get(taskId) || task;
      return {
        success: true,
        status: 'chained_launcher_opened',
        handoffId: chainedHandoffId,
        externalLauncher: chainedEcosystem.displayName,
        bottlePath: targetBottlePath,
        message: openedMsg,
        ...(accountLinkHint ? { accountLinkHint } : {}),
        task: toPublicDownloadTask(curBottleTask),
      };
    } catch (/** @type {any} */ chainedMacErr) {
      downloadControllers.delete(taskId);
      const errMsg = chainedMacErr?.message || String(chainedMacErr);
      updateDownloadTask(
        taskId,
        {
          status: 'failed',
          speedBytesPerSec: 0,
          etaSeconds: undefined,
          error: errMsg,
          statusMessage: `${chainedEcosystem.displayName} setup failed: ${errMsg}`,
        },
        options
      );
      return { success: false, error: errMsg };
    }
  }

  // Windows Native (`win32`) Chained Publisher Pipeline
  const controller = new AbortController();
  /** @type {any} */
  const ctrl = {
    type: 'abort',
    controller,
    pausedByUser: false,
    cancelRequested: false,
  };
  downloadControllers.set(taskId, ctrl);
  try {
    let hostLauncherBinary = '';
    if (chainedHandoffId !== 'riot' && !options.skipPublisherProvisioning) {
      const ensurePublisherFn =
        options.ensureChainedPublisherLauncherInstalledFn ||
        getEnsureChainedPublisherLauncherInstalled();
      if (typeof ensurePublisherFn === 'function') {
        const ensuredWin = await ensurePublisherFn(
          {
            handoffId: chainedHandoffId,
            platform: 'win32',
            signal: controller.signal,
            onProgress: (/** @type {any} */ prog) => {
              if (!prog || typeof prog !== 'object' || ctrl.cancelRequested || ctrl.pausedByUser) {
                return;
              }
              updateDownloadTask(
                taskId,
                {
                  status: 'downloading',
                  ...(typeof prog.percent === 'number'
                    ? {
                        progressPercent: Math.min(99, Math.max(0, Math.round(prog.percent))),
                      }
                    : {}),
                  ...(prog.downloadedBytes ? { bytesDownloaded: prog.downloadedBytes } : {}),
                  ...(prog.totalBytes ? { totalBytes: prog.totalBytes } : {}),
                  ...(typeof prog.speedBytesPerSec === 'number'
                    ? { speedBytesPerSec: prog.speedBytesPerSec }
                    : {}),
                  ...(prog.message ? { statusMessage: prog.message } : {}),
                },
                options
              );
            },
          },
          options
        );
        hostLauncherBinary = ensuredWin?.binaryPath || '';
      }
    }

    if (isTaskCancelledOrPaused(taskId, ctrl)) {
      downloadControllers.delete(taskId);
      return { success: false, error: 'Download cancelled or paused.' };
    }

    if (!hostLauncherBinary) {
      const discHost = discoverHostPublisherLauncher(chainedHandoffId, {
        ...options,
        platform: 'win32',
      });
      hostLauncherBinary = discHost?.binaryPath || '';
    }

    const existingWinGames = scanHostPublisherInstalledGames({
      ...options,
      platform: 'win32',
    });
    const preInstalledWin = existingWinGames.find(
      (/** @type {any} */ g) =>
        g &&
        g.handoffId === chainedHandoffId &&
        g.executablePath &&
        !isGdkStubExecutablePath(g.executablePath) &&
        !/steamapps[\\/]common/i.test(String(g.installPath || '')) &&
        ((effectiveExternalInstallId &&
          String(g.externalInstallId || '').toLowerCase() ===
            String(effectiveExternalInstallId).toLowerCase()) ||
          doChainedPublisherTitlesMatch(g.title, title) ||
          (epicRegLeaf &&
            g.installPath &&
            doChainedPublisherTitlesMatch(path.basename(g.installPath), epicRegLeaf)))
    );
    if (preInstalledWin && (await pathExistsAsync(preInstalledWin.executablePath))) {
      const preWinSize = sanitizeGameInstallSizeBytes(preInstalledWin.installSizeBytes);
      upsertManagedInstallRecord(
        {
          platformId,
          platformGameId,
          ...(cleanStoreId ? { xboxProductId: cleanStoreId } : {}),
          title: preInstalledWin.title || title,
          installPath: preInstalledWin.installPath,
          executablePath: preInstalledWin.executablePath,
          ...(preWinSize ? { installSize: preWinSize } : {}),
          chainedLauncherHandoff: chainedHandoffId,
          externalStorefrontHandoff: chainedHandoffId,
          ...(effectiveTopology ? { chainedHandoffTopology: effectiveTopology } : {}),
          ...(epicPartnerRegistryPath ? { epicPartnerRegistryPath } : {}),
          ...(preInstalledWin.externalInstallId
            ? { chainedExternalInstallId: String(preInstalledWin.externalInstallId) }
            : {}),
          runner: 'chained_host',
          isWindowsBinaryOnMac: false,
        },
        options.userDataDir
      );
      downloadControllers.delete(taskId);
      notifyInstalledGamesUpdated();
      updateDownloadTask(
        taskId,
        {
          status: 'completed',
          progressPercent: 100,
          bytesDownloaded: preWinSize || Number(task.totalBytes || 0),
          totalBytes: preWinSize || Number(task.totalBytes || 0),
          speedBytesPerSec: 0,
          etaSeconds: undefined,
          finalInstallPath: preInstalledWin.installPath,
          executablePath: preInstalledWin.executablePath,
          runner: 'chained_host',
          statusMessage: `Installed via ${chainedEcosystem.displayName}`,
        },
        options
      );
      const completedWinTask = downloadQueueMap.get(taskId) || task;
      return {
        success: true,
        status: 'installed',
        installPath: preInstalledWin.installPath,
        executablePath: preInstalledWin.executablePath,
        task: toPublicDownloadTask(completedWinTask),
      };
    }

    const hasWinGamingServices =
      options.hasGamingServices !== undefined
        ? Boolean(options.hasGamingServices)
        : hasWindowsGamingServicesInstalled(options);

    // Capture staging baseline asynchronously BEFORE spawning publisher handoff on Windows
    const baselineStagingBytes = await measurePublisherStagingBytesAsync(
      chainedHandoffId,
      'win32',
      undefined,
      options,
      controller.signal
    );

    if (isTaskCancelledOrPaused(taskId, ctrl)) {
      downloadControllers.delete(taskId);
      return { success: false, error: 'Download cancelled or paused.' };
    }

    if (platformId === 'xbox' && cleanStoreId && hasWinGamingServices) {
      await openExternalUri(
        `msxbox://game/?productId=${encodeURIComponent(cleanStoreId)}`,
        options
      );
    } else {
      const winSpec = buildChainedLauncherLaunchSpec({
        handoffId: chainedHandoffId,
        externalInstallId: effectiveExternalInstallId,
        launcherBinaryPath: hostLauncherBinary,
        installDir: payload.targetInstallDir || payload.installPath || '',
        bottlePath: '',
        platform: 'win32',
      });
      if (winSpec.launcherExe && (await pathExistsAsync(winSpec.launcherExe))) {
        const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
        const child = spawnImpl(winSpec.launcherExe, [...(winSpec.args || [])], {
          cwd: path.dirname(winSpec.launcherExe),
          env: {
            ...process.env,
            ...(winSpec.envOverrides || {}),
          },
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        if (child && typeof child.on === 'function') {
          child.on('error', (/** @type {any} */ err) => {
            diagLog.warn('installGame.chainedWinLauncherSpawnError', err, {
              handoffId: chainedHandoffId,
            });
          });
        }
        if (child && typeof child.unref === 'function') {
          child.unref();
        }
      } else if (winSpec.uri) {
        await openExternalUri(winSpec.uri, options);
      }
    }

    const winStatusMsg = isXboxChainedHandoff
      ? `Opened ${chainedEcosystem.displayName} — ensure your Xbox account is linked to your ${chainedEcosystem.displayName} account and install ${title} to continue (monitoring installation)...`
      : `Opened ${chainedEcosystem.displayName} — install ${title} to continue (monitoring installation)...`;
    updateDownloadTask(
      taskId,
      {
        status: 'downloading',
        speedBytesPerSec: 0,
        etaSeconds: undefined,
        statusMessage: winStatusMsg,
        ...(accountLinkHint ? { accountLinkHint } : {}),
      },
      options
    );

    if (!options.skipInstallMonitor) {
      startChainedLauncherInstallMonitor(
        taskId,
        {
          handoffId: chainedHandoffId,
          ecosystem: chainedEcosystem,
          platform: 'win32',
          title,
          platformId,
          platformGameId,
          cleanStoreId,
          externalInstallId: effectiveExternalInstallId,
          chainedHandoffTopology: effectiveTopology,
          epicPartnerRegistryPath,
          baselineStagingBytes,
          signal: controller.signal,
        },
        options
      );
    } else {
      downloadControllers.delete(taskId);
    }

    const curWinTask = downloadQueueMap.get(taskId) || task;
    return {
      success: true,
      status: 'chained_launcher_opened',
      handoffId: chainedHandoffId,
      externalLauncher: chainedEcosystem.displayName,
      message: winStatusMsg,
      ...(accountLinkHint ? { accountLinkHint } : {}),
      task: toPublicDownloadTask(curWinTask),
    };
  } catch (/** @type {any} */ chainedWinErr) {
    downloadControllers.delete(taskId);
    const errMsg = chainedWinErr?.message || String(chainedWinErr);
    updateDownloadTask(
      taskId,
      {
        status: 'failed',
        speedBytesPerSec: 0,
        etaSeconds: undefined,
        error: errMsg,
        statusMessage: `${chainedEcosystem.displayName} setup failed: ${errMsg}`,
      },
      options
    );
    return { success: false, error: errMsg };
  }
}

module.exports = {
  startXboxInstallMonitor,
  getPublisherForegroundUiProcessRegex,
  checkBottlePublisherLauncherAliveAsync,
  checkHostWinPublisherLauncherAliveAsync,
  measurePublisherStagingBytes,
  measurePublisherStagingBytesAsync,
  startChainedLauncherInstallMonitor,
  executeChainedPublisherInstallFlow,
};
