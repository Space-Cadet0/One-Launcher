// @ts-check
'use strict';

const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');

const REGISTRY_CACHE_TTL_MS = 300_000;
const MAX_REGISTRY_CACHE_ENTRIES = 512;
const REG_QUERY_MAX_CONCURRENCY = 4;
const REG_SUBKEY_MAX_BUFFER_BYTES = 24 * 1024 * 1024;

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });
const win1252FallbackDecoder = new TextDecoder('windows-1252');

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

/** @type {Promise<void> | null} */
let inFlightStorefrontRegistryPrewarm = null;
let lastStorefrontRegistryPrewarmAt = 0;

/** @type {Map<string, Promise<RegistrySubkeyEntry[]>>} */
const inFlightSubkeyEnumerations = new Map();

function invalidateWindowsRegistryDiscoveryCache() {
  registryValueCache.clear();
  registrySubkeysCache.clear();
  lastStorefrontRegistryPrewarmAt = 0;
}

/**
 * Decode raw `reg.exe` stdout cleanly across UTF-8 and Windows OEM/ANSI codepages
 * (e.g. CP1252/CP850 non-ASCII user profile paths like `C:\Users\Jörg\...`),
 * avoiding `\uFFFD` mojibake corruption when Windows outputs legacy ANSI bytes.
 *
 * @param {string | Buffer | Uint8Array | null | undefined} rawOut
 * @returns {string}
 */
function decodeRegExeOutput(rawOut) {
  if (rawOut === null || rawOut === undefined) return '';
  if (typeof rawOut === 'string') {
    return rawOut.replace(/^\uFEFF/, '');
  }
  const bytes = Buffer.isBuffer(rawOut)
    ? rawOut
    : rawOut instanceof Uint8Array
      ? rawOut
      : Buffer.from(String(rawOut), 'utf8');
  if (bytes.length === 0) return '';
  try {
    return utf8FatalDecoder.decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    try {
      return win1252FallbackDecoder.decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      return Buffer.from(bytes).toString('latin1').replace(/^\uFEFF/, '');
    }
  }
}

/**
 * Execute an array of async tasks with bounded worker concurrency (e.g. max 4 parallel `reg.exe` spawns).
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runBoundedConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || REG_QUERY_MAX_CONCURRENCY, items.length));
  /** @type {R[]} */
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
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
 *
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function shouldQueryHostWindowsRegistry(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return false;
  if (options.allowRegistryDiscoveryInTest === true) return true;
  if (
    typeof options.execFileSyncFn === 'function' ||
    typeof options.execFileSyncImpl === 'function' ||
    typeof options.execFileFn === 'function' ||
    typeof options.execFileImpl === 'function'
  ) {
    return true;
  }
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

/** @type {Array<{ keyPath: string, values: string[] }>} */
const STOREFRONT_REGISTRY_PREWARM_SPECS = [
  { keyPath: 'HKCU\\Software\\Valve\\Steam', values: ['SteamPath', 'SteamExe'] },
  { keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', values: ['InstallPath'] },
  { keyPath: 'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient\\paths', values: ['client', 'launcher'] },
  { keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', values: ['client', 'launcher'] },
  { keyPath: 'HKCU\\Software\\GOG.com\\GalaxyClient\\paths', values: ['client'] },
  { keyPath: 'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient', values: ['clientExecutable'] },
  { keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient', values: ['clientExecutable'] },
  {
    keyPath:
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7258BA11-600C-430E-A759-27E2C691A335}_is1',
    values: ['InstallLocation'],
  },
  {
    keyPath:
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7258BA11-600C-430E-A759-27E2C691A335}_is1',
    values: ['InstallLocation'],
  },
  { keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\EpicGames\\EpicGamesLauncher', values: ['AppDataPath'] },
  { keyPath: 'HKCU\\Software\\EpicGames\\EpicGamesLauncher', values: ['AppDataPath'] },
  { keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\Unreal Engine', values: ['INSTALLDIR'] },
  { keyPath: 'HKCU\\Software\\Epic Games\\Modding', values: ['RootDir'] },
  { keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', values: ['InstallDir'] },
  { keyPath: 'HKLM\\SOFTWARE\\Ubisoft\\Launcher', values: ['InstallDir'] },
  { keyPath: 'HKCU\\Software\\Ubisoft\\Launcher', values: ['InstallDir'] },
  {
    keyPath: 'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop',
    values: ['InstallLocation', 'ClientPath', 'LauncherAppPath', 'ClientVersion'],
  },
  {
    keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop',
    values: ['InstallLocation', 'ClientPath', 'LauncherAppPath', 'ClientVersion'],
  },
  {
    keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net',
    values: ['InstallLocation', 'DisplayVersion'],
  },
  {
    keyPath: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net',
    values: ['InstallLocation'],
  },
  {
    keyPath: 'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Launcher',
    values: ['InstallFolder', 'Version'],
  },
  {
    keyPath: 'HKLM\\SOFTWARE\\Rockstar Games\\Launcher',
    values: ['InstallFolder'],
  },
];

/**
 * Normalize a raw string extracted from `reg.exe` or DI mocks, rejecting `\uFFFD` or NUL bytes.
 *
 * @param {string} rawCandidate
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
function sanitizeRegistryCandidateString(rawCandidate, env = process.env) {
  const candidate = expandWindowsEnvPlaceholders(
    String(rawCandidate || '').replace(/\r?\n$/, '').trim(),
    env
  ).replace(/^"+|"+$/g, '');
  if (!candidate || candidate.includes('\uFFFD') || candidate.includes('\0')) {
    return null;
  }
  return process.platform !== 'win32' && candidate.startsWith('/') && !candidate.startsWith('//')
    ? candidate
    : candidate.replace(/\//g, '\\');
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
 * @param {string} targetPath
 * @returns {string}
 */
function basenameRegistryOrHostPath(targetPath) {
  if (!targetPath) return '';
  if (process.platform !== 'win32' && targetPath.startsWith('/') && !targetPath.startsWith('//')) {
    return path.posix.basename(targetPath);
  }
  return path.win32.basename(targetPath);
}

/**
 * Asynchronously pre-warm all storefront Windows Registry values via bounded-concurrency
 * (`REG_QUERY_MAX_CONCURRENCY = 4`) non-blocking native `reg.exe query <keyPath>` invocations.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
async function refreshWindowsStorefrontRegistryCacheAsync(options = {}) {
  const hasInjectedAsyncExec =
    typeof options.execFileFn === 'function' || typeof options.execFileImpl === 'function';
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return;
  if (!hasInjectedAsyncExec && !shouldQueryHostWindowsRegistry(options)) return;

  const now = Date.now();
  if (
    !hasInjectedAsyncExec &&
    !options.forceRefresh &&
    lastStorefrontRegistryPrewarmAt > 0 &&
    now - lastStorefrontRegistryPrewarmAt < REGISTRY_CACHE_TTL_MS / 2
  ) {
    return;
  }
  if (!hasInjectedAsyncExec && inFlightStorefrontRegistryPrewarm) {
    return inFlightStorefrontRegistryPrewarm;
  }

  const execAsyncImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const maxConcurrency =
    typeof options.maxConcurrency === 'number' && options.maxConcurrency >= 1
      ? Math.min(6, Math.floor(options.maxConcurrency))
      : REG_QUERY_MAX_CONCURRENCY;

  const prewarmPromise = (async () => {
    const env = options.env || process.env;
    const expiresAt = Date.now() + REGISTRY_CACHE_TTL_MS;

    await runBoundedConcurrency(STOREFRONT_REGISTRY_PREWARM_SPECS, maxConcurrency, (spec) => {
      return new Promise((resolve) => {
        try {
          execAsyncImpl(
            'reg.exe',
            ['query', spec.keyPath],
            {
              encoding: hasInjectedAsyncExec ? 'utf8' : 'buffer',
              windowsHide: true,
              timeout: 1500,
            },
            (/** @type {Error | null} */ err, /** @type {string | Buffer} */ stdout) => {
              /** @type {Map<string, string | null>} */
              const parsedValues = new Map();
              if (!err && stdout) {
                const outStr = decodeRegExeOutput(stdout);
                for (const line of outStr.split(/\r?\n/)) {
                  const m = line.match(/^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
                  if (m && m[1]) {
                    const vNameLower = m[1].trim().toLowerCase();
                    parsedValues.set(
                      vNameLower,
                      sanitizeRegistryCandidateString(m[2] || '', env)
                    );
                  }
                }
              }
              if (!hasInjectedAsyncExec || options.populateCacheInTest === true) {
                for (const expectedVal of spec.values) {
                  const cacheKey = `${spec.keyPath}::${expectedVal}`.toLowerCase();
                  const found = parsedValues.has(expectedVal.toLowerCase())
                    ? parsedValues.get(expectedVal.toLowerCase()) ?? null
                    : null;
                  setBoundedCacheEntry(registryValueCache, cacheKey, {
                    value: found,
                    expiresAt,
                  });
                }
              }
              resolve(undefined);
            }
          );
        } catch {
          resolve(undefined);
        }
      });
    });
    if (!hasInjectedAsyncExec) {
      lastStorefrontRegistryPrewarmAt = Date.now();
    }
  })().finally(() => {
    if (inFlightStorefrontRegistryPrewarm === prewarmPromise) {
      inFlightStorefrontRegistryPrewarm = null;
    }
  });

  if (!hasInjectedAsyncExec) {
    inFlightStorefrontRegistryPrewarm = prewarmPromise;
  }
  await prewarmPromise;
}

/**
 * Parse a single `REG_SZ`/`REG_EXPAND_SZ` query response for `valueName`.
 *
 * @param {string} rawOut
 * @param {string} valueName
 * @param {boolean} allowBareMockValue
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
function parseSingleRegValueOutput(rawOut, valueName, allowBareMockValue, env = process.env) {
  const escapedNameRegex = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regQueryMatch = rawOut.match(
    new RegExp(`^\\s*${escapedNameRegex}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, 'im')
  );
  const hasRegHeaderOrOtherRegValues = /^\s*\S+.*\s+REG_[A-Z0-9_]+\s+/im.test(rawOut);
  if (regQueryMatch && regQueryMatch[1]) {
    return sanitizeRegistryCandidateString(regQueryMatch[1], env);
  }
  if (!hasRegHeaderOrOtherRegValues && allowBareMockValue) {
    return sanitizeRegistryCandidateString(rawOut, env);
  }
  return null;
}

/**
 * Query a single `REG_SZ` or `REG_EXPAND_SZ` value from Windows Registry synchronously
 * (backed by a 5-minute positive+negative cache pre-warmed asynchronously at startup).
 *
 * @param {string} keyPath
 * @param {string} valueName
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function queryWindowsRegistryStringValue(keyPath, valueName, options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) return null;

  const customSyncFn =
    typeof options.execFileSyncFn === 'function'
      ? options.execFileSyncFn
      : typeof options.execFileSyncImpl === 'function'
        ? options.execFileSyncImpl
        : null;
  const useCache = customSyncFn === null && options.useCache !== false;
  const cacheKey = `${keyPath}::${valueName}`.toLowerCase();
  const now = Date.now();
  if (useCache) {
    const cached = registryValueCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const execImpl = customSyncFn || execFileSync;

  let resolved = null;
  try {
    const rawOutBufOrStr = execImpl('reg.exe', ['query', keyPath, '/v', valueName], {
      encoding: customSyncFn ? 'utf8' : 'buffer',
      windowsHide: true,
      timeout: 800,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rawOut = decodeRegExeOutput(rawOutBufOrStr);
    resolved = parseSingleRegValueOutput(
      rawOut,
      valueName,
      customSyncFn !== null,
      options.env || process.env
    );
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
 * Non-blocking async counterpart to `queryWindowsRegistryStringValue`.
 *
 * @param {string} keyPath
 * @param {string} valueName
 * @param {Record<string, any>} [options]
 * @returns {Promise<string | null>}
 */
async function queryWindowsRegistryStringValueAsync(keyPath, valueName, options = {}) {
  if (
    (typeof options.execFileSyncFn === 'function' ||
      typeof options.execFileSyncImpl === 'function') &&
    typeof options.execFileFn !== 'function' &&
    typeof options.execFileImpl !== 'function'
  ) {
    return queryWindowsRegistryStringValue(keyPath, valueName, options);
  }
  if (!shouldQueryHostWindowsRegistry(options)) return null;

  const customAsyncFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : null;
  const useCache = customAsyncFn === null && options.useCache !== false;
  const cacheKey = `${keyPath}::${valueName}`.toLowerCase();
  const now = Date.now();
  if (useCache) {
    const cached = registryValueCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const execAsyncImpl = customAsyncFn || execFile;
  const resolved = await new Promise((resolve) => {
    try {
      execAsyncImpl(
        'reg.exe',
        ['query', keyPath, '/v', valueName],
        {
          encoding: customAsyncFn ? 'utf8' : 'buffer',
          windowsHide: true,
          timeout: 1500,
        },
        (/** @type {Error | null} */ err, /** @type {string | Buffer} */ stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          const rawOut = decodeRegExeOutput(stdout);
          resolve(
            parseSingleRegValueOutput(
              rawOut,
              valueName,
              customAsyncFn !== null,
              options.env || process.env
            )
          );
        }
      );
    } catch {
      resolve(null);
    }
  });

  if (useCache) {
    setBoundedCacheEntry(registryValueCache, cacheKey, {
      value: resolved,
      expiresAt: now + REGISTRY_CACHE_TTL_MS,
    });
  }
  return resolved;
}

/**
 * Parse JSON-serialized subkey arrays when supplied by legacy test fixtures.
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
 * Expand root hive shorthand (`HKLM\`, `HKCU\`, etc.) to full `reg.exe` output hive prefix.
 *
 * @param {string} keyPath
 * @returns {string}
 */
function expandRegistryHivePrefix(keyPath) {
  return String(keyPath || '')
    .trim()
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    .replace(/^HKCR\\/i, 'HKEY_CLASSES_ROOT\\')
    .replace(/^HKU\\/i, 'HKEY_USERS\\')
    .replace(/^HKCC\\/i, 'HKEY_CURRENT_CONFIG\\')
    .replace(/\\+$/, '');
}

/**
 * Parse `reg.exe query <parentKey> /s` text output into immediate `RegistrySubkeyEntry[]`.
 * Skips any localized parenthesized default-value token (e.g. `(Default)`, `(Standard)`, `(par défaut)`).
 *
 * @param {string | Buffer} rawOutInput
 * @param {string} parentKeyPath
 * @param {Record<string, any>} [options]
 * @returns {RegistrySubkeyEntry[]}
 */
function parseRegQuerySubkeysOutput(rawOutInput, parentKeyPath, options = {}) {
  const rawOut = decodeRegExeOutput(rawOutInput);
  const trimmed = rawOut.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseEnumeratedSubkeysJson(trimmed, options);
  }

  const expandedParent = expandRegistryHivePrefix(parentKeyPath);
  const expandedParentLower = expandedParent.toLowerCase();
  const shortParentLower = String(parentKeyPath || '')
    .trim()
    .replace(/\\+$/, '')
    .toLowerCase();
  const env = options.env || process.env;

  /** @type {Map<string, RegistrySubkeyEntry>} */
  const entriesByLowerKey = new Map();
  /** @type {RegistrySubkeyEntry | null} */
  let currentEntry = null;

  for (const rawLine of rawOut.split(/\r?\n/)) {
    if (!rawLine || !rawLine.trim()) continue;
    if (/^(?:HKEY_|HK(?:LM|CU|CR|U|CC)\\)/i.test(rawLine)) {
      const header = rawLine.trim().replace(/\\+$/, '');
      const headerLower = header.toLowerCase();
      let rel = '';
      if (headerLower.startsWith(`${expandedParentLower}\\`)) {
        rel = header.slice(expandedParent.length + 1);
      } else if (headerLower.startsWith(`${shortParentLower}\\`)) {
        rel = header.slice(shortParentLower.length + 1);
      } else {
        currentEntry = null;
        continue;
      }
      if (!rel || rel.includes('\\') || rel.includes('\uFFFD') || rel.includes('\0')) {
        currentEntry = null;
        continue;
      }
      const mapKey = `${expandedParentLower}\\${rel.toLowerCase()}`;
      let existing = entriesByLowerKey.get(mapKey);
      if (!existing) {
        existing = {
          keyName: rel,
          fullKeyPath: `${expandedParent}\\${rel}`,
          properties: {},
        };
        entriesByLowerKey.set(mapKey, existing);
      }
      currentEntry = existing;
      continue;
    }

    if (currentEntry) {
      const valMatch = rawLine.match(/^\s+(.+?)\s+REG_(?:EXPAND_SZ|SZ|DWORD|QWORD)\s+(.*)$/i);
      if (valMatch && valMatch[1]) {
        const propKey = valMatch[1].trim();
        // Skip localized unnamed default value placeholder across all Windows locales
        if (!propKey || /^\([^)]+\)$/.test(propKey)) continue;
        let propVal = String(valMatch[2] || '').trim();
        if (/^0x[0-9a-f]+$/i.test(propVal)) {
          propVal = String(parseInt(propVal, 16));
        }
        const cleanVal = expandWindowsEnvPlaceholders(propVal, env);
        if (!cleanVal.includes('\uFFFD') && !cleanVal.includes('\0')) {
          currentEntry.properties[propKey] = cleanVal;
        }
      }
    }
  }

  return Array.from(entriesByLowerKey.values());
}

/**
 * @param {string | string[]} registryPaths
 * @returns {string[]}
 */
function normalizeRegistryPathList(registryPaths) {
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
  return normalizedPaths;
}

/**
 * Return non-expired cached subkeys for `registryPaths` without spawning any subprocess, or `null` on miss.
 *
 * @param {string | string[]} registryPaths
 * @returns {RegistrySubkeyEntry[] | null}
 */
function getCachedWindowsRegistrySubkeys(registryPaths) {
  const normalizedPaths = normalizeRegistryPathList(registryPaths);
  if (normalizedPaths.length === 0) return null;
  const cacheKey = normalizedPaths.map((p) => p.toLowerCase()).join('|');
  const cached = registrySubkeysCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  return null;
}

/**
 * Synchronously enumerate immediate subkeys of one or more Windows Registry paths via `reg.exe`.
 *
 * @param {string | string[]} registryPaths
 * @param {Record<string, any>} [options]
 * @returns {RegistrySubkeyEntry[]}
 */
function enumerateWindowsRegistrySubkeys(registryPaths, options = {}) {
  if (!shouldQueryHostWindowsRegistry(options)) return [];

  const normalizedPaths = normalizeRegistryPathList(registryPaths);
  if (normalizedPaths.length === 0) return [];

  const customSyncFn =
    typeof options.execFileSyncFn === 'function'
      ? options.execFileSyncFn
      : typeof options.execFileSyncImpl === 'function'
        ? options.execFileSyncImpl
        : null;
  const useCache = customSyncFn === null && options.useCache !== false;
  const cacheKey = normalizedPaths.map((p) => p.toLowerCase()).join('|');
  const now = Date.now();
  if (useCache) {
    const cached = registrySubkeysCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const execImpl = customSyncFn || execFileSync;

  /** @type {RegistrySubkeyEntry[]} */
  const resolved = [];
  for (const keyPath of normalizedPaths) {
    try {
      const rawOut = execImpl('reg.exe', ['query', keyPath, '/s'], {
        encoding: customSyncFn ? 'utf8' : 'buffer',
        windowsHide: true,
        timeout: 2000,
        maxBuffer: REG_SUBKEY_MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = parseRegQuerySubkeysOutput(rawOut, keyPath, options);
      for (const item of parsed) {
        resolved.push(item);
      }
    } catch {
      // Missing registry subtree is non-fatal
    }
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
 * Non-blocking async counterpart of `enumerateWindowsRegistrySubkeys` with bounded concurrency
 * (`REG_QUERY_MAX_CONCURRENCY = 4`), single-flight coalescing, and OEM/UTF-8 codepage decoding.
 *
 * @param {string | string[]} registryPaths
 * @param {Record<string, any>} [options]
 * @returns {Promise<RegistrySubkeyEntry[]>}
 */
async function enumerateWindowsRegistrySubkeysAsync(registryPaths, options = {}) {
  if (
    (typeof options.execFileSyncFn === 'function' ||
      typeof options.execFileSyncImpl === 'function') &&
    typeof options.execFileFn !== 'function' &&
    typeof options.execFileImpl !== 'function'
  ) {
    return enumerateWindowsRegistrySubkeys(registryPaths, options);
  }
  const hasInjectedAsyncExec =
    typeof options.execFileFn === 'function' || typeof options.execFileImpl === 'function';
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];
  if (!hasInjectedAsyncExec && !shouldQueryHostWindowsRegistry(options)) return [];

  const normalizedPaths = normalizeRegistryPathList(registryPaths);
  if (normalizedPaths.length === 0) return [];

  const useCache = !hasInjectedAsyncExec && options.useCache !== false;
  const cacheKey = normalizedPaths.map((p) => p.toLowerCase()).join('|');
  const now = Date.now();
  if (useCache) {
    const cached = registrySubkeysCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const existingFlight = inFlightSubkeyEnumerations.get(cacheKey);
    if (existingFlight) {
      return existingFlight;
    }
  }

  const execAsyncImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : hasInjectedAsyncExec
        ? options.execFileFn
        : execFile;

  const maxConcurrency =
    typeof options.maxConcurrency === 'number' && options.maxConcurrency >= 1
      ? Math.min(6, Math.floor(options.maxConcurrency))
      : REG_QUERY_MAX_CONCURRENCY;

  const flightPromise = (async () => {
    const perPathResults = await runBoundedConcurrency(
      normalizedPaths,
      maxConcurrency,
      (keyPath) =>
        new Promise((resolve) => {
          try {
            execAsyncImpl(
              'reg.exe',
              ['query', keyPath, '/s'],
              {
                encoding: hasInjectedAsyncExec ? 'utf8' : 'buffer',
                windowsHide: true,
                timeout: 4000,
                maxBuffer: REG_SUBKEY_MAX_BUFFER_BYTES,
              },
              (/** @type {Error | null} */ err, /** @type {string | Buffer} */ stdout) => {
                if (err || !stdout) {
                  resolve([]);
                  return;
                }
                resolve(parseRegQuerySubkeysOutput(stdout, keyPath, options));
              }
            );
          } catch {
            resolve([]);
          }
        })
    );

    /** @type {RegistrySubkeyEntry[]} */
    const resolved = perPathResults.flat();

    if (useCache) {
      setBoundedCacheEntry(registrySubkeysCache, cacheKey, {
        value: resolved,
        expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS,
      });
    }
    return resolved;
  })().finally(() => {
    if (inFlightSubkeyEnumerations.get(cacheKey) === flightPromise) {
      inFlightSubkeyEnumerations.delete(cacheKey);
    }
  });

  if (useCache) {
    inFlightSubkeyEnumerations.set(cacheKey, flightPromise);
  }
  return flightPromise;
}

module.exports = {
  REGISTRY_CACHE_TTL_MS,
  REG_QUERY_MAX_CONCURRENCY,
  invalidateWindowsRegistryDiscoveryCache,
  decodeRegExeOutput,
  runBoundedConcurrency,
  shouldQueryHostWindowsRegistry,
  expandWindowsEnvPlaceholders,
  sanitizeRegistryCandidateString,
  joinRegistryOrHostPath,
  dirnameRegistryOrHostPath,
  basenameRegistryOrHostPath,
  refreshWindowsStorefrontRegistryCacheAsync,
  queryWindowsRegistryStringValue,
  queryWindowsRegistryStringValueAsync,
  parseRegQuerySubkeysOutput,
  getCachedWindowsRegistrySubkeys,
  enumerateWindowsRegistrySubkeys,
  enumerateWindowsRegistrySubkeysAsync,
};
