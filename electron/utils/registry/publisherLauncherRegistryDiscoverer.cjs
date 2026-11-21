// @ts-check
'use strict';

const fs = require('node:fs');
const {
  expandWindowsEnvPlaceholders,
  joinRegistryOrHostPath,
  dirnameRegistryOrHostPath,
  basenameRegistryOrHostPath,
  queryWindowsRegistryStringValue,
  queryWindowsRegistryStringValueAsync,
  getCachedWindowsRegistrySubkeys,
  enumerateWindowsRegistrySubkeys,
  enumerateWindowsRegistrySubkeysAsync,
} = require('./regQueryClient.cjs');

const EA_UNINSTALL_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/**
 * Normalize publisher handoff alias strictly to canonical ID.
 *
 * @param {unknown} raw
 * @returns {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot' | null}
 */
function normalizePublisherLauncherId(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  const compact = s.replace(/[^a-z0-9]/g, '');
  if (!compact) return null;

  if (
    s === 'ubisoft' ||
    s === 'uplay' ||
    s === 'ubisoft_connect' ||
    s === 'ubisoft-connect' ||
    compact === 'ubisoft' ||
    compact === 'uplay' ||
    compact === 'ubisoftconnect' ||
    compact === 'hostubisoft' ||
    compact === 'bottleubisoft'
  ) {
    return 'ubisoft';
  }
  if (
    s === 'ea' ||
    s === 'origin' ||
    s === 'ea_app' ||
    s === 'ea-app' ||
    s === 'eadesktop' ||
    compact === 'ea' ||
    compact === 'origin' ||
    compact === 'eaapp' ||
    compact === 'theeaapp' ||
    compact === 'eaappclient' ||
    compact === 'originclient' ||
    compact === 'eadesktop' ||
    compact === 'link2ea' ||
    compact === 'xbox2ea' ||
    compact === 'eaconnectmicrosoft' ||
    compact === 'electronicarts' ||
    compact === 'eaplay' ||
    compact === 'hostea' ||
    compact === 'bottleea'
  ) {
    return 'ea';
  }
  if (
    s === 'bnet' ||
    s === 'battlenet' ||
    s === 'battle.net' ||
    s === 'blizzard' ||
    compact === 'bnet' ||
    compact === 'battlenet' ||
    compact === 'blizzard' ||
    compact === 'hostbnet' ||
    compact === 'bottlebnet'
  ) {
    return 'bnet';
  }
  if (
    s === 'rockstar' ||
    s === 'rockstar_games' ||
    s === 'rockstar-games' ||
    s === 'rgl' ||
    compact === 'rockstar' ||
    compact === 'rockstargames' ||
    compact === 'rockstargameslauncher' ||
    compact === 'rgl' ||
    compact === 'socialclub' ||
    compact === 'hostrockstar' ||
    compact === 'bottlerockstar'
  ) {
    return 'rockstar';
  }
  if (
    s === 'riot' ||
    s === 'riot_client' ||
    s === 'riot-client' ||
    s === 'vanguard' ||
    compact === 'riot' ||
    compact === 'riotclient' ||
    compact === 'riotgames' ||
    compact === 'vanguard'
  ) {
    return 'riot';
  }
  return null;
}

/**
 * Extract the first non-empty version line from an EA Desktop `version.properties` file.
 *
 * @param {string | null | undefined} filePath
 * @param {any} fsImpl
 * @returns {string | null}
 */
function readEaVersionPropertiesFile(filePath, fsImpl) {
  if (!filePath) return null;
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.includes('=')) {
        const rhs = line.split('=').slice(1).join('=').trim();
        if (rhs) return rhs;
      } else {
        return line;
      }
    }
  } catch {}
  return null;
}

/**
 * Extract EA App / EA Desktop version from enumerated Windows Uninstall registry entries.
 *
 * @param {Array<{ properties?: Record<string, string> }>} uninstEntries
 * @returns {string | null}
 */
function extractEaVersionFromUninstallEntries(uninstEntries) {
  for (const entry of uninstEntries) {
    const props = entry.properties || {};
    const upgradeCode = String(props.UpgradeCode || props.upgradecode || '')
      .trim()
      .toUpperCase();
    const dispName = String(props.DisplayName || props.displayname || '')
      .trim()
      .toLowerCase();
    if (
      upgradeCode === '{ADF2591E-00D2-4FFF-9BF4-9CCDAE6BDC67}' ||
      dispName === 'ea app' ||
      dispName === 'ea desktop'
    ) {
      const dispVer = String(
        props.DisplayVersion ||
          props.displayversion ||
          props.BundleVersion ||
          props.bundleversion ||
          ''
      ).trim();
      if (dispVer) {
        return dispVer;
      }
    }
  }
  return null;
}

/**
 * Resolve Windows environment root directories respecting `options.homedir` sandbox isolation.
 *
 * @param {Record<string, any>} options
 */
function resolveWindowsPublisherRoots(options) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const sandboxHome =
    typeof options.homedir === 'string' && options.homedir.trim() ? options.homedir.trim() : '';

  const programFiles = sandboxHome
    ? String(
        options.programFilesDir ||
          options.env?.ProgramFiles ||
          options.env?.PROGRAMFILES ||
          joinRegistryOrHostPath(sandboxHome, 'Program Files')
      )
    : String(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files');
  const programFilesX86 = sandboxHome
    ? String(
        options.programFilesX86Dir ||
          options.env?.['ProgramFiles(x86)'] ||
          options.env?.['PROGRAMFILES(X86)'] ||
          joinRegistryOrHostPath(sandboxHome, 'Program Files (x86)')
      )
    : String(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)');
  const programData = sandboxHome
    ? String(
        options.programDataDir ||
          options.env?.ProgramData ||
          options.env?.PROGRAMDATA ||
          joinRegistryOrHostPath(sandboxHome, 'ProgramData')
      )
    : String(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData');
  const systemDriveRoot = sandboxHome
    ? String(
        options.systemDrive ||
          options.env?.SystemDrive ||
          options.env?.SYSTEMDRIVE ||
          sandboxHome
      )
    : `${String(env.SystemDrive || env.SYSTEMDRIVE || 'C:').replace(/[\\/]+$/, '')}\\`;

  return { env, programFiles, programFilesX86, programData, systemDriveRoot };
}

/**
 * Discover custom or default Windows host installation paths for chained publisher launchers
 * (`'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'`).
 * Short-circuits 64-bit EA registry hits and avoids blocking main-thread full-Uninstall `reg.exe /s`
 * scans (serving cached Uninstall entries in 0ms and kicking off async background prewarm on miss).
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {{ installDir: string | null, binaryPath: string | null, launcherAppPath: string | null, backgroundServicePath: string | null, exeCandidates: string[], version: string | null }}
 */
function discoverWindowsPublisherLauncherPaths(handoffId, options = {}) {
  const platform = options.platform || process.platform;
  const canonical = normalizePublisherLauncherId(handoffId);
  if (platform !== 'win32' || !canonical) {
    return {
      installDir: null,
      binaryPath: null,
      launcherAppPath: null,
      backgroundServicePath: null,
      exeCandidates: [],
      version: null,
    };
  }

  const fsImpl = options.fsImpl || fs;
  const { env, programFiles, programFilesX86, programData, systemDriveRoot } =
    resolveWindowsPublisherRoots(options);

  /** @type {string | null} */
  let regInstallDir = null;
  /** @type {string | null} */
  let regDirectExe = null;
  /** @type {string | null} */
  let regLauncherApp = null;
  /** @type {string | null} */
  let version = null;
  /** @type {string[]} */
  const exeCandidates = [];

  const pushCandidate = (/** @type {string | null | undefined} */ cand) => {
    const clean = String(cand || '').trim();
    if (!clean) return;
    if (!exeCandidates.includes(clean)) {
      exeCandidates.push(clean);
    }
  };

  if (canonical === 'ubisoft') {
    regInstallDir =
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher',
        'InstallDir',
        options
      ) ||
      queryWindowsRegistryStringValue('HKLM\\SOFTWARE\\Ubisoft\\Launcher', 'InstallDir', options) ||
      queryWindowsRegistryStringValue('HKCU\\Software\\Ubisoft\\Launcher', 'InstallDir', options) ||
      null;
    if (regInstallDir) {
      regInstallDir = regInstallDir.replace(/([^:])[\\/]+$/, '$1');
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'upc.exe'));
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'UbisoftConnect.exe'));
    }
    pushCandidate(
      joinRegistryOrHostPath(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'upc.exe')
    );
    pushCandidate(
      joinRegistryOrHostPath(
        programFilesX86,
        'Ubisoft',
        'Ubisoft Game Launcher',
        'UbisoftConnect.exe'
      )
    );
    pushCandidate(
      joinRegistryOrHostPath(programFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'upc.exe')
    );
  } else if (canonical === 'ea') {
    // Short-circuit 32-bit WOW6432Node lookups whenever 64-bit native keys already match
    const installLoc64 = queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
      'InstallLocation',
      options
    );
    const clientPath64 = queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
      'ClientPath',
      options
    );
    const launcherPath64 = queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
      'LauncherAppPath',
      options
    );
    const installLoc32 = installLoc64
      ? null
      : queryWindowsRegistryStringValue(
          'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
          'InstallLocation',
          options
        );
    const clientPath32 = clientPath64
      ? null
      : queryWindowsRegistryStringValue(
          'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
          'ClientPath',
          options
        );
    const launcherPath32 = launcherPath64
      ? null
      : queryWindowsRegistryStringValue(
          'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
          'LauncherAppPath',
          options
        );
    version =
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
        'ClientVersion',
        options
      ) ||
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
        'ClientVersion',
        options
      ) ||
      null;

    regDirectExe = clientPath64 || clientPath32 || null;
    regLauncherApp = launcherPath64 || launcherPath32 || null;
    regInstallDir = installLoc64 || installLoc32 || null;
    if (regDirectExe) {
      pushCandidate(regDirectExe);
    }
    if (regInstallDir) {
      regInstallDir = regInstallDir.replace(/([^:])[\\/]+$/, '$1');
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'EA Desktop', 'EADesktop.exe'));
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'EA Desktop', 'EALauncher.exe'));
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'EADesktop.exe'));
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'EALauncher.exe'));
    }
    if (regLauncherApp) {
      pushCandidate(regLauncherApp);
    }
    pushCandidate(
      joinRegistryOrHostPath(
        programFiles,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EADesktop.exe'
      )
    );
    pushCandidate(
      joinRegistryOrHostPath(
        programFiles,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EALauncher.exe'
      )
    );
    pushCandidate(
      joinRegistryOrHostPath(
        programFilesX86,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EADesktop.exe'
      )
    );
    pushCandidate(
      joinRegistryOrHostPath(
        programFilesX86,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EALauncher.exe'
      )
    );
  } else if (canonical === 'bnet') {
    regInstallDir =
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net',
        'InstallLocation',
        options
      ) ||
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net',
        'InstallLocation',
        options
      ) ||
      null;
    version =
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net',
        'DisplayVersion',
        options
      ) || null;
    if (regInstallDir) {
      regInstallDir = regInstallDir.replace(/([^:])[\\/]+$/, '$1');
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'Battle.net.exe'));
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'Battle.net Launcher.exe'));
    }
    pushCandidate(joinRegistryOrHostPath(programFilesX86, 'Battle.net', 'Battle.net.exe'));
    pushCandidate(joinRegistryOrHostPath(programFiles, 'Battle.net', 'Battle.net.exe'));
  } else if (canonical === 'rockstar') {
    regInstallDir =
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Launcher',
        'InstallFolder',
        options
      ) ||
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\Rockstar Games\\Launcher',
        'InstallFolder',
        options
      ) ||
      null;
    version =
      queryWindowsRegistryStringValue(
        'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Launcher',
        'Version',
        options
      ) || null;
    if (regInstallDir) {
      regInstallDir = regInstallDir.replace(/([^:])[\\/]+$/, '$1');
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'LauncherPatcher.exe'));
      pushCandidate(joinRegistryOrHostPath(regInstallDir, 'Launcher.exe'));
    }
    pushCandidate(
      joinRegistryOrHostPath(programFiles, 'Rockstar Games', 'Launcher', 'LauncherPatcher.exe')
    );
    pushCandidate(
      joinRegistryOrHostPath(programFiles, 'Rockstar Games', 'Launcher', 'Launcher.exe')
    );
    pushCandidate(
      joinRegistryOrHostPath(programFilesX86, 'Rockstar Games', 'Launcher', 'LauncherPatcher.exe')
    );
    pushCandidate(
      joinRegistryOrHostPath(programFilesX86, 'Rockstar Games', 'Launcher', 'Launcher.exe')
    );
  } else if (canonical === 'riot') {
    const riotInstallsJson = joinRegistryOrHostPath(
      programData,
      'Riot Games',
      'RiotClientInstalls.json'
    );
    try {
      if (fsImpl.existsSync(riotInstallsJson)) {
        const parsed = JSON.parse(fsImpl.readFileSync(riotInstallsJson, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const key of ['rc_default', 'rc_live', 'rc_beta']) {
            if (typeof parsed[key] === 'string' && parsed[key].trim()) {
              const rawExe = expandWindowsEnvPlaceholders(parsed[key].trim(), env);
              const normalizedExe =
                process.platform !== 'win32' && rawExe.startsWith('/') && !rawExe.startsWith('//')
                  ? rawExe
                  : rawExe.replace(/\//g, '\\');
              if (!regDirectExe) regDirectExe = normalizedExe;
              pushCandidate(normalizedExe);
            }
          }
        }
      }
    } catch {}
    pushCandidate(
      joinRegistryOrHostPath(systemDriveRoot, 'Riot Games', 'Riot Client', 'RiotClientServices.exe')
    );
  }

  /** @type {string | null} */
  let binaryPath = null;
  for (const cand of exeCandidates) {
    try {
      if (fsImpl.existsSync(cand)) {
        binaryPath = cand;
        break;
      }
    } catch {}
  }

  if (!binaryPath && options.requireExisting === false) {
    binaryPath = regDirectExe || (regInstallDir ? exeCandidates[0] || null : null);
  }

  const installDir = binaryPath
    ? regInstallDir || dirnameRegistryOrHostPath(binaryPath)
    : regInstallDir && (options.requireExisting === false || fsImpl.existsSync(regInstallDir))
      ? regInstallDir
      : null;

  /** @type {string | null} */
  let launcherAppPath = null;
  /** @type {string | null} */
  let backgroundServicePath = null;

  if (canonical === 'ea') {
    const binDir = binaryPath ? dirnameRegistryOrHostPath(binaryPath) : null;
    const launcherAppCandidates = [
      regLauncherApp,
      binDir ? joinRegistryOrHostPath(binDir, 'EALauncher.exe') : null,
      regInstallDir ? joinRegistryOrHostPath(regInstallDir, 'EA Desktop', 'EALauncher.exe') : null,
      regInstallDir ? joinRegistryOrHostPath(regInstallDir, 'EALauncher.exe') : null,
      joinRegistryOrHostPath(
        programFiles,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EALauncher.exe'
      ),
      joinRegistryOrHostPath(
        programFilesX86,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EALauncher.exe'
      ),
    ].filter(Boolean);

    for (const lc of launcherAppCandidates) {
      try {
        if (lc && fsImpl.existsSync(lc)) {
          launcherAppPath = lc;
          break;
        }
      } catch {}
    }
    if (!launcherAppPath && options.requireExisting === false && regLauncherApp) {
      launcherAppPath = regLauncherApp;
    }

    const bgCandidates = [
      binDir ? joinRegistryOrHostPath(binDir, 'EABackgroundService.exe') : null,
      regInstallDir
        ? joinRegistryOrHostPath(regInstallDir, 'EA Desktop', 'EABackgroundService.exe')
        : null,
      regInstallDir ? joinRegistryOrHostPath(regInstallDir, 'EABackgroundService.exe') : null,
      joinRegistryOrHostPath(
        programFiles,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EABackgroundService.exe'
      ),
      joinRegistryOrHostPath(
        programFilesX86,
        'Electronic Arts',
        'EA Desktop',
        'EA Desktop',
        'EABackgroundService.exe'
      ),
    ].filter(Boolean);

    for (const bg of bgCandidates) {
      try {
        if (bg && fsImpl.existsSync(bg)) {
          backgroundServicePath = bg;
          break;
        }
      } catch {}
    }

    if (!version && (binaryPath || installDir)) {
      const parentBinDir = binDir ? dirnameRegistryOrHostPath(binDir) : '';
      const versionFileCandidates = [
        binDir ? joinRegistryOrHostPath(binDir, 'version.properties') : null,
        parentBinDir && /ea desktop$/i.test(basenameRegistryOrHostPath(parentBinDir))
          ? joinRegistryOrHostPath(parentBinDir, 'version.properties')
          : null,
        installDir
          ? joinRegistryOrHostPath(installDir, 'EA Desktop', 'version.properties')
          : null,
        installDir ? joinRegistryOrHostPath(installDir, 'version.properties') : null,
      ].filter(Boolean);
      for (const vf of versionFileCandidates) {
        const parsedVer = readEaVersionPropertiesFile(vf, fsImpl);
        if (parsedVer) {
          version = parsedVer;
          break;
        }
      }
    }

    if (!version && (binaryPath || installDir)) {
      const hasSyncMock =
        typeof options.execFileSyncFn === 'function' ||
        typeof options.execFileSyncImpl === 'function';
      if (hasSyncMock || options.allowSlowSyncUninstallScan === true) {
        const uninstEntries = enumerateWindowsRegistrySubkeys(EA_UNINSTALL_REGISTRY_KEYS, options);
        version = extractEaVersionFromUninstallEntries(uninstEntries);
      } else {
        const cachedUninstall = getCachedWindowsRegistrySubkeys(EA_UNINSTALL_REGISTRY_KEYS);
        if (cachedUninstall) {
          version = extractEaVersionFromUninstallEntries(cachedUninstall);
        } else {
          // Non-blocking background prewarm instead of stalling Electron's main thread for 4s
          void enumerateWindowsRegistrySubkeysAsync(EA_UNINSTALL_REGISTRY_KEYS, options).catch(
            () => {}
          );
        }
      }
    }
  }

  return {
    installDir,
    binaryPath,
    launcherAppPath,
    backgroundServicePath,
    exeCandidates,
    version,
  };
}

/**
 * Fully non-blocking async counterpart to `discoverWindowsPublisherLauncherPaths`.
 * Uses async `reg.exe` queries and non-blocking `enumerateWindowsRegistrySubkeysAsync` for EA uninstall lookup.
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ installDir: string | null, binaryPath: string | null, launcherAppPath: string | null, backgroundServicePath: string | null, exeCandidates: string[], version: string | null }>}
 */
async function discoverWindowsPublisherLauncherPathsAsync(handoffId, options = {}) {
  const canonical = normalizePublisherLauncherId(handoffId);
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || !canonical) {
    return {
      installDir: null,
      binaryPath: null,
      launcherAppPath: null,
      backgroundServicePath: null,
      exeCandidates: [],
      version: null,
    };
  }

  // Pre-warm the relevant EA registry keys asynchronously so the path builder does zero sync reg spawns
  if (canonical === 'ea') {
    const loc64 = await queryWindowsRegistryStringValueAsync(
      'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
      'InstallLocation',
      options
    );
    if (!loc64) {
      await queryWindowsRegistryStringValueAsync(
        'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
        'InstallLocation',
        options
      );
    }
    const ver64 = await queryWindowsRegistryStringValueAsync(
      'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
      'ClientVersion',
      options
    );
    if (!ver64) {
      await queryWindowsRegistryStringValueAsync(
        'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
        'ClientVersion',
        options
      );
    }
  }

  const baseResult = discoverWindowsPublisherLauncherPaths(canonical, {
    ...options,
    allowSlowSyncUninstallScan: false,
  });

  if (canonical === 'ea' && !baseResult.version && (baseResult.binaryPath || baseResult.installDir)) {
    const uninstEntries = await enumerateWindowsRegistrySubkeysAsync(
      EA_UNINSTALL_REGISTRY_KEYS,
      options
    );
    const eaVer = extractEaVersionFromUninstallEntries(uninstEntries);
    if (eaVer) {
      return { ...baseResult, version: eaVer };
    }
  }

  return baseResult;
}

module.exports = {
  normalizePublisherLauncherId,
  discoverWindowsPublisherLauncherPaths,
  discoverWindowsPublisherLauncherPathsAsync,
};
