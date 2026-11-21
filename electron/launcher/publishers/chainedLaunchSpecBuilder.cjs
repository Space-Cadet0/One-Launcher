// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveDriveCPathCaseInsensitive } = require('../wineAndCrossOverManager.cjs');
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
  normalizeBattleNetLaunchProductCode,
  sanitizeExternalLaunchId,
} = require('./publisherCatalogData.cjs');
const { resolveBottleWindowsPathReadOnly } = require('./wineRegistryParserAndMutator.cjs');
const {
  extractBattleNetProductId,
  findPrimaryPublisherGameExecutable,
  resolveEaContentIdNearExecutable,
} = require('./publisherGameScanner.cjs');

/**
 * @typedef {import('./publisherCatalogData.cjs').ChainedLauncherLaunchSpec} ChainedLauncherLaunchSpec
 */

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/**
 * Convert a host or bottle game installation directory to a Windows path (`C:\...` or `Z:\...`)
 * suitable for Rockstar Games Launcher's `-launchTitleInFolder <WindowsPath>` CLI argument.
 *
 * @param {string} rawInstallDir
 * @param {string} [bottlePath]
 * @param {boolean} [isWineBottleExecution]
 * @returns {string}
 */
function toRockstarWindowsInstallDir(rawInstallDir, bottlePath = '', isWineBottleExecution = false) {
  const clean = String(rawInstallDir || '')
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (!clean || CONTROL_CHARS_RE.test(clean)) return '';

  const slashNorm = clean.replace(/\\/g, '/').replace(/\/+$/, '');
  if (bottlePath) {
    const cleanBottleDriveC = `${bottlePath.replace(/\\/g, '/').replace(/\/+$/, '')}/drive_c`;
    if (slashNorm.toLowerCase() === cleanBottleDriveC.toLowerCase()) {
      return 'C:\\';
    }
    if (slashNorm.toLowerCase().startsWith(`${cleanBottleDriveC.toLowerCase()}/`)) {
      const rel = slashNorm.slice(cleanBottleDriveC.length + 1).replace(/\//g, '\\');
      return `C:\\${rel}`;
    }
  }

  const driveCMatch = slashNorm.match(/\/drive_c(?:\/(.*))?$/i);
  if (driveCMatch) {
    const rel = String(driveCMatch[1] || '').replace(/\//g, '\\');
    return rel ? `C:\\${rel}` : 'C:\\';
  }

  if (/^[A-Za-z]:[\\/]/.test(clean)) {
    const winNorm = clean.replace(/\//g, '\\');
    return /^[A-Za-z]:\\$/.test(winNorm) ? winNorm : winNorm.replace(/\\+$/, '');
  }

  if (slashNorm.startsWith('/') && isWineBottleExecution) {
    return `Z:\\${slashNorm.replace(/^\/+/, '').replace(/\//g, '\\')}`;
  }

  return '';
}

/**
 * Return `true` when `dirPath` on disk is an Xbox GDK stub wrapper folder (`GDKStubGame.exe`
 * with no real playable game `.exe`), so Rockstar `-launchTitleInFolder` never targets a stub.
 *
 * @param {string} dirPath
 * @returns {boolean}
 */
function isGdkStubOnlyDirectory(dirPath) {
  if (!dirPath || /^[A-Za-z]:[\\/]/.test(dirPath)) return false;
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return false;
    const entries = fs.readdirSync(dirPath);
    const hasStub = entries.some((n) => n.toLowerCase() === 'gdkstubgame.exe');
    if (!hasStub) return false;
    const { executablePath } = findPrimaryPublisherGameExecutable(dirPath);
    return !executablePath;
  } catch {
    return false;
  }
}

/**
 * Build a deterministic, strictly validated launch specification for a game or installer delegated
 * through a chained publisher launcher (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`).
 *
 * All external game IDs and launch codes are validated against `/^[A-Za-z0-9._:-]+$/` (rejecting
 * whitespace, quotes, URI delimiters, control characters, traversal, and leading `-`) and URI
 * segments are encoded with `encodeURIComponent` to prevent URI/argument injection.
 *
 * @param {{
 *   handoffId: string,
 *   externalInstallId?: string | null,
 *   chainedExternalInstallId?: string | null,
 *   launcherBinaryPath?: string | null,
 *   clientBinaryPath?: string | null,
 *   launcherAppPath?: string | null,
 *   gameExecutablePath?: string | null,
 *   executablePath?: string | null,
 *   installDir?: string | null,
 *   installPath?: string | null,
 *   windowsInstallDir?: string | null,
 *   bottlePath?: string | null,
 *   epicPartnerRegistryPath?: string | null,
 *   storefrontId?: string | null,
 *   platform?: string,
 *   compatibilityLayerType?: string | null,
 *   inBottle?: boolean,
 *   crossoverInjectsNoBattlEye?: boolean,
 *   storefrontClientLifecycle?: string | null,
 * }} params
 * @returns {ChainedLauncherLaunchSpec}
 */
function buildChainedLauncherLaunchSpec(params) {
  const {
    handoffId,
    externalInstallId,
    chainedExternalInstallId,
    launcherBinaryPath,
    clientBinaryPath,
    launcherAppPath,
    gameExecutablePath,
    executablePath,
    installDir,
    installPath,
    windowsInstallDir,
    bottlePath,
    platform = process.platform,
    compatibilityLayerType,
    inBottle,
    crossoverInjectsNoBattlEye,
    storefrontClientLifecycle,
  } = params || {};

  const canonical = normalizeChainedHandoffId(handoffId);
  const normPlatform = String(platform || process.platform).toLowerCase();
  const normLayer = String(compatibilityLayerType || '').toLowerCase();
  const normLifecycle = String(storefrontClientLifecycle || '')
    .trim()
    .toLowerCase();
  const isMinimalLifecycle =
    normLifecycle === 'minimal_and_close_if_started' ||
    normLifecycle === 'minimal_keep_running';
  const isWineBottleExecution =
    inBottle === true ||
    Boolean(bottlePath && String(bottlePath).trim()) ||
    (normPlatform === 'darwin' && normLayer !== 'native');

  const rawExternalId = String(externalInstallId ?? chainedExternalInstallId ?? '').trim();
  const safeExternalId = sanitizeExternalLaunchId(rawExternalId);
  const cleanLauncherBin = String(launcherBinaryPath ?? clientBinaryPath ?? '').trim();
  const cleanLauncherApp = String(launcherAppPath || '').trim();
  const cleanGameExe = String(gameExecutablePath ?? executablePath ?? '').trim();
  const cleanInstallDir = String(installDir ?? installPath ?? '').trim();
  const cleanWindowsInstallDir = String(windowsInstallDir || '').trim();
  const cleanBottlePath = String(bottlePath || '').trim();

  if (canonical === 'ubisoft') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.ubisoft;
    /** @type {string[]} */
    const args = isWineBottleExecution ? [...(descriptor.wineClientArgs || [])] : [];
    if (isMinimalLifecycle && !args.includes('-minimized')) {
      args.push('-minimized');
    }
    /** @type {string | undefined} */
    let uri;
    if (safeExternalId) {
      uri = `uplay://launch/${encodeURIComponent(safeExternalId)}/0`;
      args.push(uri);
    }
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};
    return {
      launcherExe: cleanLauncherBin || cleanGameExe,
      args,
      envOverrides,
      ...(uri ? { uri } : {}),
      targetExecutablePath: cleanGameExe || null,
    };
  }

  if (canonical === 'ea') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.ea;
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};

    // If caller passed an explicit externalInstallId, strictly validate it (never fall back on invalid input);
    // only auto-discover from __Installer/installerdata.xml when externalInstallId was omitted.
    const resolvedCleanId = rawExternalId
      ? safeExternalId
      : sanitizeExternalLaunchId(
          cleanGameExe || cleanInstallDir
            ? resolveEaContentIdNearExecutable(cleanGameExe, cleanInstallDir)
            : ''
        );

    let eaRunnerExe = '';
    if (cleanLauncherApp) {
      let appExists = false;
      let binExists = false;
      try {
        appExists = fs.existsSync(cleanLauncherApp) && fs.statSync(cleanLauncherApp).isFile();
      } catch {}
      try {
        binExists = Boolean(cleanLauncherBin && fs.existsSync(cleanLauncherBin));
      } catch {}
      if (appExists || !binExists) {
        eaRunnerExe = cleanLauncherApp;
      }
    }
    if (!eaRunnerExe && cleanLauncherBin) {
      eaRunnerExe = cleanLauncherBin;
      try {
        const binDir = path.dirname(cleanLauncherBin);
        if (binDir && fs.existsSync(binDir)) {
          const siblingLauncher = resolveDriveCPathCaseInsensitive(binDir, ['EALauncher.exe']);
          if (
            siblingLauncher &&
            fs.existsSync(siblingLauncher) &&
            fs.statSync(siblingLauncher).isFile()
          ) {
            eaRunnerExe = siblingLauncher;
          }
        }
      } catch {}
    }

    /** @type {string | undefined} */
    const uri = resolvedCleanId
      ? `origin2://game/launch?offerIds=${encodeURIComponent(resolvedCleanId)}&autoDownload=1`
      : undefined;

    const isDirectEaDesktopOnWine =
      isWineBottleExecution &&
      Boolean(eaRunnerExe) &&
      /(?:^|[\\/])eadesktop\.exe$/i.test(eaRunnerExe);

    /** @type {string[]} */
    const args = isDirectEaDesktopOnWine ? [...(descriptor.wineClientArgs || [])] : [];
    if (uri && eaRunnerExe) {
      args.push(uri);
    }

    return {
      launcherExe: eaRunnerExe || cleanGameExe,
      args,
      envOverrides,
      ...(uri ? { uri } : {}),
      protocolUri: uri || null,
      targetExecutablePath: cleanGameExe || null,
    };
  }

  if (canonical === 'bnet') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.bnet;
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};
    const inferredDir = cleanInstallDir || (cleanGameExe ? path.dirname(cleanGameExe) : '');
    const safeBnetId = rawExternalId
      ? safeExternalId
      : sanitizeExternalLaunchId(inferredDir ? extractBattleNetProductId(inferredDir) : '');
    const launchCode = safeBnetId
      ? sanitizeExternalLaunchId(normalizeBattleNetLaunchProductCode(safeBnetId))
      : '';
    const protocolUri = launchCode ? `battlenet://${encodeURIComponent(launchCode)}` : null;
    /** @type {string[]} */
    const args = launchCode ? [`--exec=launch ${launchCode}`] : [];
    return {
      launcherExe: cleanLauncherBin || cleanGameExe,
      args,
      envOverrides,
      ...(protocolUri ? { uri: protocolUri } : {}),
      protocolUri,
      targetExecutablePath: cleanGameExe || null,
      ...(safeBnetId ? { tactUid: safeBnetId } : {}),
      ...(launchCode ? { launchProductCode: launchCode } : {}),
    };
  }

  if (canonical === 'rockstar') {
    const descriptor = CHAINED_PUBLISHER_ECOSYSTEMS.rockstar;
    /** @type {Record<string, string>} */
    const envOverrides = isWineBottleExecution ? { ...(descriptor.wineEnvOverrides || {}) } : {};

    let rockstarLauncherExe = cleanLauncherBin;
    if (rockstarLauncherExe && /(?:^|[\\/])launcherpatcher\.exe$/i.test(rockstarLauncherExe)) {
      try {
        const siblingLauncher = resolveDriveCPathCaseInsensitive(
          path.dirname(rockstarLauncherExe),
          ['Launcher.exe']
        );
        if (
          siblingLauncher &&
          fs.existsSync(siblingLauncher) &&
          fs.statSync(siblingLauncher).isFile()
        ) {
          rockstarLauncherExe = siblingLauncher;
        }
      } catch {}
    }

    let candidateHostInstallDir = cleanInstallDir;
    if (candidateHostInstallDir && isGdkStubOnlyDirectory(candidateHostInstallDir)) {
      candidateHostInstallDir = '';
    }
    if (!candidateHostInstallDir && cleanGameExe) {
      const exeDir = /^[A-Za-z]:[\\/]/.test(cleanGameExe)
        ? cleanGameExe.replace(/[\\/][^\\/]+$/, '')
        : path.dirname(cleanGameExe);
      if (!isGdkStubOnlyDirectory(exeDir)) {
        candidateHostInstallDir = exeDir;
      }
    }

    const fallbackCleanWinDir =
      cleanWindowsInstallDir && !CONTROL_CHARS_RE.test(cleanWindowsInstallDir)
        ? cleanWindowsInstallDir.replace(/\//g, '\\').replace(/([^:])\\+$/, '$1')
        : '';
    const resolvedWinInstallDir = cleanWindowsInstallDir
      ? toRockstarWindowsInstallDir(
          cleanWindowsInstallDir,
          cleanBottlePath,
          isWineBottleExecution
        ) || fallbackCleanWinDir
      : toRockstarWindowsInstallDir(
          candidateHostInstallDir,
          cleanBottlePath,
          isWineBottleExecution
        );

    const rockstarMinimalArgs = isMinimalLifecycle ? ['-minmode'] : [];

    if (rockstarLauncherExe && resolvedWinInstallDir) {
      return {
        launcherExe: rockstarLauncherExe,
        args: [...rockstarMinimalArgs, '-launchTitleInFolder', resolvedWinInstallDir],
        envOverrides,
        expectedGameExe: cleanGameExe || '',
        targetExecutablePath: cleanGameExe || null,
      };
    }

    if (rockstarLauncherExe) {
      return {
        launcherExe: rockstarLauncherExe,
        args: [...rockstarMinimalArgs],
        envOverrides,
        expectedGameExe: cleanGameExe || '',
        targetExecutablePath: cleanGameExe || null,
      };
    }

    // Fallback when Rockstar's `Launcher.exe` is unavailable: look for a `Play*.exe` bootstrapper
    let playBootstrapperPath = '';
    let localScanDir = candidateHostInstallDir;
    if (
      localScanDir &&
      !/^[A-Za-z]:[\\/]/.test(localScanDir) &&
      fs.existsSync(localScanDir)
    ) {
      // Already a valid host path
    } else if (localScanDir && cleanBottlePath && /^[A-Za-z]:[\\/]/.test(localScanDir)) {
      localScanDir = resolveBottleWindowsPathReadOnly(localScanDir, cleanBottlePath);
    }

    if (cleanGameExe && /(?:^|[\\/])play[a-z0-9_.-]*\.exe$/i.test(cleanGameExe)) {
      playBootstrapperPath = cleanGameExe;
    } else if (localScanDir) {
      try {
        if (fs.existsSync(localScanDir) && fs.statSync(localScanDir).isDirectory()) {
          const entries = fs
            .readdirSync(localScanDir, { withFileTypes: true })
            .filter((d) => d.isFile() && /^play[a-z0-9_.-]*\.exe$/i.test(d.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (entries.length > 0) {
            playBootstrapperPath = path.join(localScanDir, entries[0].name);
          }
        }
      } catch {}
    }

    if (playBootstrapperPath) {
      /** @type {string[]} */
      const fallbackArgs = [];
      if (isWineBottleExecution && crossoverInjectsNoBattlEye !== true) {
        const playDir = /^[A-Za-z]:[\\/]/.test(playBootstrapperPath)
          ? localScanDir
          : path.dirname(playBootstrapperPath);
        let hasBattlEyeCompanion = false;
        try {
          if (playDir && fs.existsSync(playDir) && fs.statSync(playDir).isDirectory()) {
            const dirFiles = fs.readdirSync(playDir);
            hasBattlEyeCompanion = dirFiles.some((name) =>
              /(?:_be\.exe|^beservice.*\.exe|^bedaisy\.sys|^battleye)$/i.test(name)
            );
          }
        } catch {}
        if (hasBattlEyeCompanion && !fallbackArgs.includes('-nobattleye')) {
          fallbackArgs.push('-nobattleye');
        }
      }
      return {
        launcherExe: playBootstrapperPath,
        args: fallbackArgs,
        envOverrides,
        expectedGameExe: cleanGameExe || '',
        targetExecutablePath: cleanGameExe || null,
      };
    }

    // Never spawn raw DRM-gated Rockstar engine executables directly with `args: []`
    return {
      launcherExe: '',
      args: resolvedWinInstallDir
        ? [...rockstarMinimalArgs, '-launchTitleInFolder', resolvedWinInstallDir]
        : [...rockstarMinimalArgs],
      envOverrides,
      expectedGameExe: cleanGameExe || '',
      targetExecutablePath: cleanGameExe || null,
    };
  }

  if (canonical === 'riot') {
    /** @type {string[]} */
    const args = safeExternalId
      ? [`--launch-product=${safeExternalId}`, '--launch-patchline=live']
      : [];
    return {
      launcherExe: cleanLauncherBin || cleanGameExe,
      args,
      envOverrides: {},
    };
  }

  return {
    launcherExe: cleanGameExe || cleanLauncherBin,
    args: [],
    envOverrides: {},
  };
}

module.exports = {
  toRockstarWindowsInstallDir,
  isGdkStubOnlyDirectory,
  buildChainedLauncherLaunchSpec,
};
