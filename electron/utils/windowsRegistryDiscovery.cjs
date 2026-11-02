// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');

const REGISTRY_CACHE_TTL_MS = 60_000;
const MAX_REGISTRY_CACHE_ENTRIES = 256;

/** @type {Map<string, { value: string | null, expiresAt: number }>} */
const registryValueCache = new Map();

/**
 * @typedef {Object} RegistrySubkeyEntry
 * @property {string} keyName
 * @property {string} fullKeyPath
 * @property {Record<string, string>} properties
 */

/** @type {Map<string, { value: RegistrySubkeyEntry[], expiresAt: number }>} */
const registrySubkeysCache = new Map();

function invalidateWindowsRegistryDiscoveryCache() {
  registryValueCache.clear();
  registrySubkeysCache.clear();
}

/**
 * @template T
 * @param {Map<string, T>} map
 * @param {string} key
 * @param {T} entry
 */
function setBoundedCacheEntry(map, key, entry) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_REGISTRY_CACHE_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, entry);
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
 * Expand `%ENV_VAR%` placeholders using `env` (`options.env || process.env`).
 *
 * @param {string} rawValue
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
function expandWindowsEnvPlaceholders(rawValue, env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  return rawValue.replace(/%([^%]+)%/g, (full, varName) => {
    let val = sourceEnv[varName];
    if (val === undefined) {
      const lowerKey = String(varName || '').toLowerCase();
      for (const [k, v] of Object.entries(sourceEnv)) {
        if (k.toLowerCase() === lowerKey && typeof v === 'string') {
          val = v;
          break;
        }
      }
    }
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
      String(extracted || '').replace(/\r?\n$/, '').trim(),
      options.env || process.env
    ).replace(/^"+|"+$/g, '');

    if (candidate && !candidate.includes('\uFFFD') && !candidate.includes('\0')) {
      resolved =
        process.platform !== 'win32' && candidate.startsWith('/') && !candidate.startsWith('//')
          ? candidate
          : candidate.replace(/\//g, '\\');
    }
  } catch {
    resolved = null;
  }

  if (useCache) {
    setBoundedCacheEntry(registryValueCache, cacheKey, {
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

/**
 * Join path segments preserving Windows backslashes for drive-letter/UNC paths and POSIX slashes
 * for hermetic cross-OS test roots on macOS/Linux.
 *
 * @param {string} base
 * @param {...string} parts
 * @returns {string}
 */
function joinRegistryOrHostPath(base, ...parts) {
  if (!base) return '';
  if (process.platform !== 'win32' && base.startsWith('/') && !base.startsWith('//')) {
    return path.posix.join(base, ...parts.map((p) => String(p || '').replace(/\\/g, '/')));
  }
  return path.win32.join(base, ...parts);
}

/**
 * @param {string} targetPath
 * @returns {string}
 */
function dirnameRegistryOrHostPath(targetPath) {
  if (!targetPath) return '';
  if (process.platform !== 'win32' && targetPath.startsWith('/') && !targetPath.startsWith('//')) {
    return path.posix.dirname(targetPath);
  }
  return path.win32.dirname(targetPath);
}

/**
 * Build the UTF-8 PowerShell command that enumerates immediate subkeys of `normalizedPaths`
 * and serializes `{ keyName, fullKeyPath, properties }` via `ConvertTo-Json -Compress`.
 *
 * @param {string[]} normalizedPaths
 * @returns {string}
 */
function buildEnumerateSubkeysPowerShellCommand(normalizedPaths) {
  const psPathsLiteral = normalizedPaths
    .map((p) => `'${p.replace(/'/g, "''")}'`)
    .join(', ');
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$results = New-Object System.Collections.Generic.List[object]',
    `foreach ($rawPath in @(${psPathsLiteral})) {`,
    `  $norm = $rawPath -replace '^HKCU\\\\','HKEY_CURRENT_USER\\' -replace '^HKLM\\\\','HKEY_LOCAL_MACHINE\\' -replace '^HKCR\\\\','HKEY_CLASSES_ROOT\\' -replace '^HKU\\\\','HKEY_USERS\\' -replace '^HKCC\\\\','HKEY_CURRENT_CONFIG\\'`,
    `  $regPath = 'Registry::' + $norm`,
    `  if (-not (Test-Path -LiteralPath $regPath)) { continue }`,
    `  $children = Get-ChildItem -LiteralPath $regPath -ErrorAction SilentlyContinue`,
    `  foreach ($child in $children) {`,
    `    $props = @{}`,
    `    foreach ($valName in $child.GetValueNames()) {`,
    `      if ([string]::IsNullOrEmpty($valName)) { continue }`,
    `      $val = $child.GetValue($valName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    `      if ($null -ne $val) { $props[$valName] = [string]$val }`,
    `    }`,
    `    $results.Add([PSCustomObject]@{ keyName = [string]$child.PSChildName; fullKeyPath = [string]$child.Name; properties = $props })`,
    `  }`,
    `}`,
    '[Console]::Out.Write((ConvertTo-Json -InputObject @($results) -Depth 4 -Compress))',
  ].join('; ');
}

/**
 * Parse and sanitize JSON output from `buildEnumerateSubkeysPowerShellCommand`.
 *
 * @param {string} rawOut
 * @param {Record<string, any>} [options]
 * @returns {RegistrySubkeyEntry[]}
 */
function parseEnumeratedSubkeysJson(rawOut, options = {}) {
  const trimmed = String(rawOut || '').trim();
  if (!trimmed) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];

  const env = options.env || process.env;
  /** @type {RegistrySubkeyEntry[]} */
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const keyName = String(item.keyName || '').trim();
    const fullKeyPath = String(item.fullKeyPath || '').trim();
    if (!keyName || keyName.includes('\uFFFD') || keyName.includes('\0')) continue;

    /** @type {Record<string, string>} */
    const properties = {};
    if (item.properties && typeof item.properties === 'object') {
      for (const [propKey, propVal] of Object.entries(item.properties)) {
        if (!propKey || propVal === null || propVal === undefined) continue;
        const cleanVal = expandWindowsEnvPlaceholders(String(propVal).trim(), env);
        if (!cleanVal.includes('\uFFFD') && !cleanVal.includes('\0')) {
          properties[propKey] = cleanVal;
        }
      }
    }
    out.push({ keyName, fullKeyPath, properties });
  }
  return out;
}

/**
 * Enumerate immediate subkeys of one or more Windows Registry paths (`HKLM\...`, `HKCU\...`)
 * in a single UTF-8 PowerShell call (`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`),
 * returning `Array<{ keyName: string, fullKeyPath: string, properties: Record<string, string> }>`.
 * Returns `[]` immediately on non-`win32` unless `options.platform === 'win32'` with injected
 * `options.execFileSyncFn` or `options.allowRegistryDiscoveryInTest === true`.
 *
 * @param {string | string[]} registryPaths
 * @param {Record<string, any>} [options]
 * @returns {RegistrySubkeyEntry[]}
 */
function enumerateWindowsRegistrySubkeys(registryPaths, options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) return [];

  const rawList = Array.isArray(registryPaths) ? registryPaths : [registryPaths];
  /** @type {string[]} */
  const normalizedPaths = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of rawList) {
    const clean = String(raw || '')
      .trim()
      .replace(/^Registry::/i, '');
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalizedPaths.push(clean);
  }
  if (normalizedPaths.length === 0) return [];

  const useCache = typeof options.execFileSyncFn !== 'function';
  const cacheKey = normalizedPaths.map((p) => p.toLowerCase()).join('|');
  const now = Date.now();
  if (useCache) {
    const cached = registrySubkeysCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const execImpl =
    typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync;
  const psCommand = buildEnumerateSubkeysPowerShellCommand(normalizedPaths);

  /** @type {RegistrySubkeyEntry[]} */
  let resolved = [];
  try {
    const rawOut = String(
      execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCommand],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ) || ''
    );
    resolved = parseEnumeratedSubkeysJson(rawOut, options);
  } catch {
    resolved = [];
  }

  if (useCache) {
    setBoundedCacheEntry(registrySubkeysCache, cacheKey, {
      value: resolved,
      expiresAt: now + REGISTRY_CACHE_TTL_MS,
    });
  }
  return resolved;
}

/**
 * Async counterpart of `enumerateWindowsRegistrySubkeys` for non-blocking main-process discovery.
 *
 * @param {string | string[]} registryPaths
 * @param {Record<string, any>} [options]
 * @returns {Promise<RegistrySubkeyEntry[]>}
 */
async function enumerateWindowsRegistrySubkeysAsync(registryPaths, options = {}) {
  if (typeof options.execFileSyncFn === 'function' && typeof options.execFileFn !== 'function') {
    return enumerateWindowsRegistrySubkeys(registryPaths, options);
  }
  const hasInjectedAsyncExec = typeof options.execFileFn === 'function';
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];
  if (!hasInjectedAsyncExec && !shouldQueryHostWindowsRegistry(options)) return [];

  const rawList = Array.isArray(registryPaths) ? registryPaths : [registryPaths];
  /** @type {string[]} */
  const normalizedPaths = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of rawList) {
    const clean = String(raw || '')
      .trim()
      .replace(/^Registry::/i, '');
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalizedPaths.push(clean);
  }
  if (normalizedPaths.length === 0) return [];

  const useCache = !hasInjectedAsyncExec;
  const cacheKey = normalizedPaths.map((p) => p.toLowerCase()).join('|');
  const now = Date.now();
  if (useCache) {
    const cached = registrySubkeysCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const execAsyncImpl = hasInjectedAsyncExec ? options.execFileFn : execFile;
  const psCommand = buildEnumerateSubkeysPowerShellCommand(normalizedPaths);

  /** @type {RegistrySubkeyEntry[]} */
  let resolved = [];
  try {
    const rawOut = await new Promise((resolve, reject) => {
      execAsyncImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCommand],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
        },
        (/** @type {Error | null} */ err, /** @type {string | Buffer} */ stdout) => {
          if (err) return reject(err);
          resolve(String(stdout || ''));
        }
      );
    });
    resolved = parseEnumeratedSubkeysJson(rawOut, options);
  } catch {
    resolved = [];
  }

  if (useCache) {
    setBoundedCacheEntry(registrySubkeysCache, cacheKey, {
      value: resolved,
      expiresAt: now + REGISTRY_CACHE_TTL_MS,
    });
  }
  return resolved;
}

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
 * @param {typeof fs} fsImpl
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
 * Discover custom or default Windows host installation paths for chained publisher launchers
 * (`'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'`).
 * Respects `options.homedir` sandbox isolation so hermetic tests never leak onto developer host paths.
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

  /** @type {string | null} */
  let regInstallDir = null;
  /** @type {string | null} */
  let regDirectExe = null;
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

  /** @type {string | null} */
  let regLauncherApp = null;

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
    const installLoc32 = queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
      'InstallLocation',
      options
    );
    const clientPath32 = queryWindowsRegistryStringValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
      'ClientPath',
      options
    );
    const launcherPath32 = queryWindowsRegistryStringValue(
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
      const parentBinDir = binDir ? path.dirname(binDir) : '';
      const versionFileCandidates = [
        binDir ? joinRegistryOrHostPath(binDir, 'version.properties') : null,
        parentBinDir && /ea desktop$/i.test(path.basename(parentBinDir))
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
      const uninstEntries = enumerateWindowsRegistrySubkeys(
        [
          'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        ],
        options
      );
      for (const entry of uninstEntries) {
        const props = entry.properties || {};
        const upgradeCode = String(
          props.UpgradeCode || props.upgradecode || ''
        )
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
            version = dispVer;
            break;
          }
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

module.exports = {
  invalidateWindowsRegistryDiscoveryCache,
  queryWindowsRegistryStringValue,
  enumerateWindowsRegistrySubkeys,
  enumerateWindowsRegistrySubkeysAsync,
  normalizePublisherLauncherId,
  discoverWindowsSteamRegistryPaths,
  discoverWindowsGogGalaxyRegistryPaths,
  discoverWindowsEpicRegistryPaths,
  discoverWindowsPublisherLauncherPaths,
};
