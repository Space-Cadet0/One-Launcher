// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  shouldQueryHostWindowsRegistry,
  queryWindowsRegistryStringValue,
} = require('./regQueryClient.cjs');

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
  discoverWindowsSteamRegistryPaths,
  discoverWindowsGogGalaxyRegistryPaths,
  discoverWindowsEpicRegistryPaths,
};
