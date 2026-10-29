// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REGISTRY_CACHE_TTL_MS = 60_000;

/** @type {Map<string, { value: string | null, expiresAt: number }>} */
const registryValueCache = new Map();

function invalidateWindowsRegistryDiscoveryCache() {
  registryValueCache.clear();
}

/**
 * Determine whether live host Windows Registry probing should run for `options`.
 * Skips live host registry reads during isolated unit tests (`options.homedir` or `options.customRoots`)
 * unless explicitly opted in via `options.allowRegistryDiscoveryInTest` or `options.execFileSyncFn`.
 *
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function shouldQueryHostWindowsRegistry(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return false;
  if (options.allowRegistryDiscoveryInTest === true) return true;
  if (typeof options.execFileSyncFn === 'function') return true;
  const isIsolatedTest = Boolean(
    options.homedir || (Array.isArray(options.customRoots) && options.customRoots.length > 0)
  );
  if (isIsolatedTest) return false;
  if (process.platform !== 'win32') return false;
  return true;
}

/**
 * Expand `%ENV_VAR%` placeholders using `process.env`.
 *
 * @param {string} rawValue
 * @returns {string}
 */
function expandWindowsEnvPlaceholders(rawValue) {
  return rawValue.replace(/%([^%]+)%/g, (full, varName) => {
    const val = process.env[varName];
    return typeof val === 'string' && val.length > 0 ? val : full;
  });
}

/**
 * Query a single `REG_SZ` or `REG_EXPAND_SZ` value from Windows Registry via PowerShell UTF-8
 * `Get-ItemProperty` (`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`), avoiding OEM
 * codepage mojibake on non-ASCII Windows usernames and custom library paths.
 * Rejects corrupted strings containing `\uFFFD` or NUL bytes.
 *
 * @param {string} keyPath
 * @param {string} valueName
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function queryWindowsRegistryStringValue(keyPath, valueName, options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) return null;

  const useCache = typeof options.execFileSyncFn !== 'function';
  const cacheKey = `${keyPath}::${valueName}`.toLowerCase();
  const now = Date.now();
  if (useCache) {
    const cached = registryValueCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const execImpl =
    typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;

  const escapedKeyPath = String(keyPath || '')
    .trim()
    .replace(/'/g, "''");
  const escapedValueName = String(valueName || '')
    .trim()
    .replace(/'/g, "''");
  const psCommand = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$k = '${escapedKeyPath}' -replace '^HKCU\\\\','HKEY_CURRENT_USER\\' -replace '^HKLM\\\\','HKEY_LOCAL_MACHINE\\' -replace '^HKCR\\\\','HKEY_CLASSES_ROOT\\' -replace '^HKU\\\\','HKEY_USERS\\' -replace '^HKCC\\\\','HKEY_CURRENT_CONFIG\\'`,
    `$p = Get-ItemProperty -LiteralPath ('Registry::' + $k) -Name '${escapedValueName}' -ErrorAction Stop`,
    `if ($null -ne $p) { [Console]::Out.Write([string]$p.'${escapedValueName}') }`,
  ].join('; ');

  let resolved = null;
  try {
    let rawOut = '';
    try {
      rawOut = String(
        execImpl(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCommand],
          {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 3500,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        ) || ''
      );
    } catch (psErr) {
      if (typeof options.execFileSyncFn === 'function') {
        rawOut = String(
          execImpl('reg.exe', ['query', keyPath, '/v', valueName], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 2500,
            stdio: ['ignore', 'pipe', 'ignore'],
          }) || ''
        );
      } else {
        throw psErr;
      }
    }

    const escapedNameRegex = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regQueryMatch = rawOut.match(
      new RegExp(`^\\s*${escapedNameRegex}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, 'im')
    );
    const extracted = regQueryMatch && regQueryMatch[1] ? regQueryMatch[1] : rawOut;
    const candidate = expandWindowsEnvPlaceholders(
      String(extracted || '').replace(/\r?\n$/, '').trim()
    ).replace(/^"+|"+$/g, '');

    if (candidate && !candidate.includes('\uFFFD') && !candidate.includes('\0')) {
      resolved = candidate.replace(/\//g, '\\');
    }
  } catch {
    resolved = null;
  }

  if (useCache) {
    registryValueCache.set(cacheKey, {
      value: resolved,
      expiresAt: now + REGISTRY_CACHE_TTL_MS,
    });
  }
  return resolved;
}

/**
 * Discover custom Windows Steam installation root and executable via Registry.
 * Checks `HKCU\Software\Valve\Steam` (`SteamPath`, `SteamExe`) and
 * `HKLM\SOFTWARE\WOW6432Node\Valve\Steam` (`InstallPath`).
 *
 * @param {Record<string, any>} [options]
 * @returns {{ steamRoot: string | null, steamPath: string | null, steamExe: string | null }}
 */
function discoverWindowsSteamRegistryPaths(options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) {
    return { steamRoot: null, steamPath: null, steamExe: null };
  }

  const steamPathHkcu = queryWindowsRegistryStringValue(
    'HKCU\\Software\\Valve\\Steam',
    'SteamPath',
    options
  );
  const steamExeHkcu = queryWindowsRegistryStringValue(
    'HKCU\\Software\\Valve\\Steam',
    'SteamExe',
    options
  );
  const installPathHklm = queryWindowsRegistryStringValue(
    'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam',
    'InstallPath',
    options
  );

  let steamRoot = steamPathHkcu || installPathHklm || null;
  if (!steamRoot && steamExeHkcu) {
    steamRoot = path.win32.dirname(steamExeHkcu);
  }
  let steamExe = steamExeHkcu || (steamRoot ? path.win32.join(steamRoot, 'steam.exe') : null);

  if (options.requireExisting === true) {
    const fsImpl = options.fsImpl || fs;
    if (steamExe && !fsImpl.existsSync(steamExe)) steamExe = null;
    if (steamRoot && !fsImpl.existsSync(steamRoot)) steamRoot = null;
  }

  return { steamRoot, steamPath: steamRoot, steamExe };
}

/**
 * Discover custom Windows GOG Galaxy client directory and `GalaxyClient.exe` via Registry.
 * Checks native 64-bit `HKLM\SOFTWARE\GOG.com\GalaxyClient\paths` (GOG Galaxy 2.1.10+),
 * 32-bit `HKLM\SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths`, `HKCU\Software\GOG.com\GalaxyClient\paths`,
 * Inno Setup `Uninstall\{7258BA11-600C-430E-A759-27E2C691A335}_is1` (`InstallLocation`),
 * optional `clientExecutable` override, and legacy `launcher` value.
 *
 * @param {Record<string, any>} [options]
 * @returns {{ clientDir: string | null, clientExe: string | null }}
 */
function discoverWindowsGogGalaxyRegistryPaths(options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) {
    return { clientDir: null, clientExe: null };
  }

  const rawClientDir =
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient\\paths',
      'client',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths',
      'client',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKCU\\Software\\GOG.com\\GalaxyClient\\paths',
      'client',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7258BA11-600C-430E-A759-27E2C691A335}_is1',
      'InstallLocation',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7258BA11-600C-430E-A759-27E2C691A335}_is1',
      'InstallLocation',
      options
    ) ||
    null;

  const clientDir = rawClientDir
    ? rawClientDir.replace(/^([A-Za-z]:\\)$/, '$1').replace(/([^:])[\\/]+$/, '$1')
    : null;

  const rawClientExecutable =
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient',
      'clientExecutable',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient',
      'clientExecutable',
      options
    ) ||
    'GalaxyClient.exe';

  const launcherExe =
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient\\paths',
      'launcher',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths',
      'launcher',
      options
    ) ||
    null;

  let clientExe = clientDir
    ? path.win32.isAbsolute(rawClientExecutable)
      ? rawClientExecutable
      : path.win32.join(clientDir, rawClientExecutable)
    : launcherExe;

  if (options.requireExisting === true) {
    const fsImpl = options.fsImpl || fs;
    if (clientExe && !fsImpl.existsSync(clientExe)) clientExe = null;
  }

  return { clientDir, clientExe };
}

/**
 * Discover custom Windows Epic Games Launcher `AppDataPath` (containing `Manifests`)
 * and launcher install root via Registry.
 *
 * @param {Record<string, any>} [options]
 * @returns {{ appDataPath: string | null, manifestsDir: string | null, launcherExeCandidates: string[] }}
 */
function discoverWindowsEpicRegistryPaths(options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) {
    return { appDataPath: null, manifestsDir: null, launcherExeCandidates: [] };
  }

  const appDataPath =
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\EpicGames\\EpicGamesLauncher',
      'AppDataPath',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKCU\\Software\\EpicGames\\EpicGamesLauncher',
      'AppDataPath',
      options
    ) ||
    null;

  const manifestsDir = appDataPath ? path.win32.join(appDataPath, 'Manifests') : null;

  const installDir =
    queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\Unreal Engine',
      'INSTALLDIR',
      options
    ) ||
    queryWindowsRegistryStringValue(
      'HKCU\\Software\\Epic Games\\Modding',
      'RootDir',
      options
    ) ||
    null;

  /** @type {string[]} */
  const launcherExeCandidates = [];
  if (installDir) {
    launcherExeCandidates.push(
      path.win32.join(installDir, 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
      path.win32.join(installDir, 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe')
    );
  }

  return { appDataPath, manifestsDir, launcherExeCandidates };
}

module.exports = {
  invalidateWindowsRegistryDiscoveryCache,
  queryWindowsRegistryStringValue,
  discoverWindowsSteamRegistryPaths,
  discoverWindowsGogGalaxyRegistryPaths,
  discoverWindowsEpicRegistryPaths,
};
