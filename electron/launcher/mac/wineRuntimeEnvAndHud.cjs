// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const {
  diagLog,
  getUserDataDir,
  isTestEnvironment,
  getLauncherPerformanceSettings,
  moltenVkHudDeadlockCache,
  setBoundedMapEntry,
} = require('../engineStateRegistry.cjs');
const { inspectMacMachOHeader } = require('../binaryAndManifestInspectors.cjs');
const { deriveCrossOverRootPath } = require('../wineAndCrossOverManager.cjs');
const { inspectBottleConfMetadata } = require('./compatLayerRegistryAndDetection.cjs');

/**
 * Split a colon-delimited `DYLD_INSERT_LIBRARIES` value while preserving Windows drive-letter
 * paths (e.g. `C:\...\foo.dll`). Single canonical helper shared across HUD, CrossOver tuning,
 * and supervisor background-client env sanitization.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitDyldInsertLibraries(raw) {
  const str = String(raw || '');
  if (!str) return [];
  const rawParts = str.split(':');
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < rawParts.length; i += 1) {
    const part = rawParts[i];
    if (/^[A-Za-z]$/.test(part) && i + 1 < rawParts.length && rawParts[i + 1].startsWith('\\')) {
      out.push(`${part}:${rawParts[i + 1]}`);
      i += 1;
    } else if (part.trim()) {
      out.push(part.trim());
    }
  }
  return out;
}

function resolveWineLayerMoltenVkPath(wineBinary) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return null;

  const normalizedBin = path.resolve(binPath);
  const binDir = path.dirname(normalizedBin);
  const derivedCxRoot = deriveCrossOverRootFromBinaryPath(normalizedBin);
  const candidateRoots = Array.from(
    new Set(
      [
        derivedCxRoot,
        path.resolve(binDir, '..'),
        path.resolve(binDir, '..', '..'),
        path.resolve(binDir, '..', '..', '..'),
      ].filter(Boolean)
    )
  );
  /** @type {string[]} */
  const candidates = [];
  if (normalizedBin.endsWith('.dylib')) {
    candidates.push(normalizedBin);
  }
  for (const rootDir of candidateRoots) {
    candidates.push(
      path.join(rootDir, 'lib', 'aarch64', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib', 'x86_64', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib64', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib', 'external', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib64', 'external', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib', 'apple_gptk', 'external', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib64', 'apple_gptk', 'external', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib', 'wine', 'aarch64-unix', 'libMoltenVK.dylib'),
      path.join(rootDir, 'lib', 'wine', 'x86_64-unix', 'libMoltenVK.dylib')
    );
  }
  candidates.push(path.join(binDir, 'libMoltenVK.dylib'));

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

function doesWineLayerHaveMoltenVkHudDeadlock(wineBinary) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return false;

  const normalizedBin = path.resolve(binPath);
  const dylibPath = resolveWineLayerMoltenVkPath(normalizedBin);
  if (!dylibPath) {
    return false;
  }

  let cacheKey = normalizedBin;
  try {
    const st = fs.statSync(dylibPath);
    cacheKey = `${path.resolve(dylibPath)}:${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return false;
  }

  if (moltenVkHudDeadlockCache.has(cacheKey)) {
    return moltenVkHudDeadlockCache.get(cacheKey);
  }

  const needle = Buffer.from('_GLOBAL__sub_I_mvk_datatypes.mm', 'utf8');
  const chunkSize = 64 * 1024;
  const overlap = needle.length;
  let hasDeadlock = false;
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(dylibPath, 'r');
    const chunkBuf = Buffer.allocUnsafe(chunkSize + overlap);
    let carryBytes = 0;
    let filePos = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, chunkBuf, carryBytes, chunkSize, filePos);
      if (bytesRead <= 0) break;
      const windowEnd = carryBytes + bytesRead;
      if (chunkBuf.subarray(0, windowEnd).includes(needle)) {
        hasDeadlock = true;
        break;
      }
      filePos += bytesRead;
      if (bytesRead < chunkSize) break;
      carryBytes = Math.min(overlap, windowEnd);
      chunkBuf.copy(chunkBuf, 0, windowEnd - carryBytes, windowEnd);
    }
    setBoundedMapEntry(moltenVkHudDeadlockCache, cacheKey, hasDeadlock, 128);
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  return hasDeadlock;
}

/**
 * Ensure the universal (`arm64` + `x86_64`) `libone_metal_preload.dylib` helper exists on a real
 * filesystem path outside `app.asar` so `dyld` can load it via `DYLD_INSERT_LIBRARIES` or `CX_ENV`.
 */
function ensureWineMetalPreloadDylib(/** @type {any} */ options = {}) {
  const electronRoot = path.resolve(__dirname, '..', '..');
  const unpackedElectronRoot = electronRoot.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const unpackedDylib = path.join(unpackedElectronRoot, 'helpers', 'libone_metal_preload.dylib');
  const bundledDylib = path.join(electronRoot, 'helpers', 'libone_metal_preload.dylib');

  if (!/\.asar[\\/]/i.test(unpackedDylib) && fs.existsSync(unpackedDylib)) {
    return unpackedDylib;
  }
  if (!/\.asar[\\/]/i.test(bundledDylib) && fs.existsSync(bundledDylib)) {
    return bundledDylib;
  }

  const helpersOutDir = path.join(getUserDataDir(options?.userDataDir), 'helpers');
  const extractedDylib = path.join(helpersOutDir, 'libone_metal_preload.dylib');

  if (fs.existsSync(bundledDylib)) {
    try {
      if (!fs.existsSync(helpersOutDir)) {
        fs.mkdirSync(helpersOutDir, { recursive: true });
      }
      const bundledStat = fs.statSync(bundledDylib);
      let needsExtract = !fs.existsSync(extractedDylib);
      if (!needsExtract) {
        try {
          needsExtract = fs.statSync(extractedDylib).size !== bundledStat.size;
        } catch {
          needsExtract = true;
        }
      }
      if (needsExtract) {
        fs.writeFileSync(extractedDylib, fs.readFileSync(bundledDylib));
        fs.chmodSync(extractedDylib, 0o755);
      }
      return extractedDylib;
    } catch {}
  }

  if (fs.existsSync(extractedDylib)) {
    return extractedDylib;
  }

  return null;
}

/** @type {Map<string, string>} */
const liveBottleMsyncByPrefix = new Map();

/**
 * Parse shell-quoted `KEY=VALUE` assignments compatible with Perl `Text::ParseWords::shellwords`
 * (`bin/wine:722` `$ENV{CX_ENV}`).
 *
 * @param {string} rawCxEnv
 * @returns {Array<{ key: string, rawToken: string }>}
 */
function parseCxEnvShellwordTokens(rawCxEnv) {
  const str = String(rawCxEnv || '').trim();
  if (!str) return [];
  /** @type {Array<{ key: string, rawToken: string }>} */
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i += 1;
    if (i >= str.length) break;
    const start = i;
    let unquoted = '';
    let quoteChar = '';
    while (i < str.length) {
      const ch = str[i];
      if (quoteChar) {
        if (ch === '\\' && quoteChar === '"' && i + 1 < str.length) {
          unquoted += str[i + 1];
          i += 2;
          continue;
        }
        if (ch === quoteChar) {
          quoteChar = '';
          i += 1;
          continue;
        }
        unquoted += ch;
        i += 1;
      } else {
        if (/\s/.test(ch)) break;
        if (ch === '"' || ch === "'") {
          quoteChar = ch;
          i += 1;
          continue;
        }
        if (ch === '\\' && i + 1 < str.length) {
          unquoted += str[i + 1];
          i += 2;
          continue;
        }
        unquoted += ch;
        i += 1;
      }
    }
    const rawToken = str.slice(start, i);
    const eqIdx = unquoted.indexOf('=');
    const key = eqIdx > 0 ? unquoted.slice(0, eqIdx).trim() : '';
    tokens.push({ key, rawToken });
  }
  return tokens;
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
  const parsed = parseCxEnvShellwordTokens(cxEnvStr);
  return parsed
    .filter((entry) => !entry.key || !removeSet.has(entry.key))
    .map((entry) => entry.rawToken)
    .join(' ');
}

/**
 * Single authoritative Performance HUD / Overlay environment resolver across macOS Native,
 * macOS Bottled (CrossOver / Preview / arm64 / GPTK / Wine), and Windows Native launches.
 *
 * - Fixes Bug A: under Hardened Runtime + deadlocking MoltenVK (`hasDeadlock && !loaderAllowsDyldInsert`),
 *   strips `MTL_HUD_ENABLED` and unconditionally sets `env.DXVK_HUD = userCustomDxvkHud || 'devinfo,fps,frametimes'`
 *   on DXVK / open-source Wine (NEVER blocked by legacy `cfg.dxvkHud === false`).
 * - Prevents double overlays: when `MTL_HUD_ENABLED='1'` IS active, deletes `env.DXVK_HUD` unless
 *   explicitly supplied in `cfg.environmentVariables.DXVK_HUD`.
 * - Fixes Bug B: sets `env.MTL_HUD_ENABLED='1'` for native macOS launches (`!useCompatLayer && platform === 'darwin'`).
 * - Preserves `libone_metal_preload.dylib` in `DYLD_INSERT_LIBRARIES` when `audioBufferClamp` is active.
 *
 * @param {Record<string, any>} params
 * @returns {{
 *   hudEnabled: boolean,
 *   mode: 'none' | 'metal_hud' | 'dxvk_hud' | 'suppressed_deadlock',
 *   appliedMetalHud: boolean,
 *   appliedDxvkHud: boolean,
 *   usedPreloadDylib: boolean
 * }}
 */
function applyUnifiedPerformanceHudEnv(params = {}) {
  const env = params && typeof params.env === 'object' ? params.env : null;
  if (!env) {
    return {
      hudEnabled: false,
      mode: 'none',
      appliedMetalHud: false,
      appliedDxvkHud: false,
      usedPreloadDylib: false,
    };
  }
  const cfg = params.launchConfig && typeof params.launchConfig === 'object' ? params.launchConfig : {};
  const effectiveOptions = params.options && typeof params.options === 'object' ? params.options : {};
  const perfSettings =
    params.perfSettings && typeof params.perfSettings === 'object'
      ? params.perfSettings
      : getLauncherPerformanceSettings(effectiveOptions);
  const hostPlatform = params.platform || effectiveOptions.platform || process.platform;
  const chosenLayer = params.chosenLayer || null;
  const useCompatLayer =
    params.useCompatLayer !== undefined ? Boolean(params.useCompatLayer) : Boolean(chosenLayer);
  const candidateWineBin = String(params.wineBinaryPath || chosenLayer?.binaryPath || '');
  const effectiveBackend = String(
    params.backend || env.CX_GRAPHICS_BACKEND || cfg.crossoverGraphicsBackend || ''
  )
    .trim()
    .toLowerCase();
  const userEnv =
    cfg.environmentVariables && typeof cfg.environmentVariables === 'object'
      ? cfg.environmentVariables
      : {};
  const userCustomDxvkHud =
    typeof userEnv.DXVK_HUD === 'string' && userEnv.DXVK_HUD.trim() ? userEnv.DXVK_HUD.trim() : '';
  const userCustomMetalHud =
    typeof userEnv.MTL_HUD_ENABLED === 'string' && userEnv.MTL_HUD_ENABLED.trim()
      ? userEnv.MTL_HUD_ENABLED.trim()
      : '';
  const audioClampActive =
    cfg.audioBufferClamp === true || effectiveOptions.enableAudioBufferClamp === true;
  const hasCustomUserDyldInsert = Boolean(
    typeof userEnv.DYLD_INSERT_LIBRARIES === 'string' && userEnv.DYLD_INSERT_LIBRARIES.trim()
  );

  const perfHudSetting =
    cfg.performanceHud === 'on' || cfg.performanceHud === 'off' || cfg.performanceHud === 'default'
      ? cfg.performanceHud
      : undefined;
  const legacyHudOn = !perfHudSetting && (cfg.metalHud === true || cfg.dxvkHud === true);
  const explicitlyOff = perfHudSetting === 'off';

  const configHudEnabled =
    perfHudSetting === 'on' || legacyHudOn
      ? true
      : explicitlyOff
        ? false
        : Boolean(perfSettings?.defaultPerformanceHud);

  const userRequestedMetalHud =
    !explicitlyOff &&
    (userCustomMetalHud === '1' ||
      (params.respectExistingEnvMetalHud === true && env.MTL_HUD_ENABLED === '1'));
  const userRequestedDxvkHud = !explicitlyOff && Boolean(userCustomDxvkHud);
  const hudEnabled = configHudEnabled || userRequestedMetalHud || userRequestedDxvkHud;

  const stripPreloadFromDyldInsertIfAllowed = () => {
    if (!audioClampActive && env.DYLD_INSERT_LIBRARIES) {
      const remainingInsert = splitDyldInsertLibraries(env.DYLD_INSERT_LIBRARIES).filter(
        (s) => s && !s.endsWith('libone_metal_preload.dylib')
      );
      if (remainingInsert.length > 0) {
        env.DYLD_INSERT_LIBRARIES = remainingInsert.join(':');
      } else {
        delete env.DYLD_INSERT_LIBRARIES;
      }
    }
  };

  const stripCxEnvKeys = (/** @type {string[]} */ keys) => {
    if (typeof env.CX_ENV === 'string' && env.CX_ENV) {
      const cleaned = stripKeysFromCxEnv(env.CX_ENV, keys);
      if (cleaned) {
        env.CX_ENV = cleaned;
      } else {
        delete env.CX_ENV;
      }
    }
  };

  if (!hudEnabled) {
    delete env.MTL_HUD_ENABLED;
    delete env.ONE_LAUNCHER_MOLTENVK_PATH;
    if (!userEnv.MVK_ICD_LIBRARY_PATH) {
      delete env.MVK_ICD_LIBRARY_PATH;
    }
    if (explicitlyOff || !userCustomDxvkHud) {
      delete env.DXVK_HUD;
    }
    stripPreloadFromDyldInsertIfAllowed();
    const cxStrip = ['MTL_HUD_ENABLED'];
    if (explicitlyOff || !userCustomDxvkHud) {
      cxStrip.push('DXVK_HUD');
    }
    if (!audioClampActive && !hasCustomUserDyldInsert) {
      cxStrip.push('DYLD_INSERT_LIBRARIES');
    }
    stripCxEnvKeys(cxStrip);
    return {
      hudEnabled: false,
      mode: 'none',
      appliedMetalHud: false,
      appliedDxvkHud: false,
      usedPreloadDylib: false,
    };
  }

  // Windows native (or non-macOS) launch: DXVK_HUD only
  if (hostPlatform !== 'darwin' && !useCompatLayer) {
    delete env.MTL_HUD_ENABLED;
    env.DXVK_HUD = userCustomDxvkHud || 'devinfo,fps,frametimes';
    return {
      hudEnabled: true,
      mode: 'dxvk_hud',
      appliedMetalHud: false,
      appliedDxvkHud: true,
      usedPreloadDylib: false,
    };
  }

  // Native macOS launch (`!useCompatLayer && hostPlatform === 'darwin'`): Fixes Bug B
  if (!useCompatLayer && hostPlatform === 'darwin') {
    if (userRequestedDxvkHud && !configHudEnabled && !userRequestedMetalHud) {
      env.DXVK_HUD = userCustomDxvkHud;
      delete env.MTL_HUD_ENABLED;
      return {
        hudEnabled: true,
        mode: 'dxvk_hud',
        appliedMetalHud: false,
        appliedDxvkHud: true,
        usedPreloadDylib: false,
      };
    }
    env.MTL_HUD_ENABLED =
      userCustomMetalHud && userCustomMetalHud !== '0' ? userCustomMetalHud : '1';
    if (userCustomDxvkHud) {
      env.DXVK_HUD = userCustomDxvkHud;
    } else {
      delete env.DXVK_HUD;
    }
    return {
      hudEnabled: true,
      mode: 'metal_hud',
      appliedMetalHud: true,
      appliedDxvkHud: Boolean(env.DXVK_HUD),
      usedPreloadDylib: false,
    };
  }

  // Bottled macOS launch (CrossOver / Preview / arm64 / GPTK / Wine)
  if (userRequestedDxvkHud && !configHudEnabled && !userRequestedMetalHud) {
    env.DXVK_HUD = userCustomDxvkHud;
    delete env.MTL_HUD_ENABLED;
    stripCxEnvKeys(['MTL_HUD_ENABLED']);
    return {
      hudEnabled: true,
      mode: 'dxvk_hud',
      appliedMetalHud: false,
      appliedDxvkHud: true,
      usedPreloadDylib: false,
    };
  }

  const hasDeadlock =
    typeof params.hasMoltenVkHudDeadlock === 'boolean'
      ? params.hasMoltenVkHudDeadlock
      : typeof effectiveOptions.hasMoltenVkHudDeadlock === 'boolean'
        ? effectiveOptions.hasMoltenVkHudDeadlock
        : Boolean(candidateWineBin && doesWineLayerHaveMoltenVkHudDeadlock(candidateWineBin));
  const loaderAllowsDyldInsert =
    typeof params.loaderAllowsDyldInsert === 'boolean'
      ? params.loaderAllowsDyldInsert
      : typeof effectiveOptions.loaderAllowsDyldInsert === 'boolean'
        ? effectiveOptions.loaderAllowsDyldInsert
        : !candidateWineBin || doesWineLoaderAllowDyldInsert(candidateWineBin);
  const canFallbackToDxvkHud = effectiveBackend === 'dxvk' || chosenLayer?.type === 'wine';

  if (!hasDeadlock) {
    env.MTL_HUD_ENABLED = '1';
    if (userCustomDxvkHud) {
      env.DXVK_HUD = userCustomDxvkHud;
    } else {
      delete env.DXVK_HUD;
      stripCxEnvKeys(['DXVK_HUD']);
    }
    return {
      hudEnabled: true,
      mode: 'metal_hud',
      appliedMetalHud: true,
      appliedDxvkHud: Boolean(env.DXVK_HUD),
      usedPreloadDylib: false,
    };
  }

  if (loaderAllowsDyldInsert) {
    const preloadDylib = ensureWineMetalPreloadDylib(effectiveOptions);
    const moltenVkPath = resolveWineLayerMoltenVkPath(candidateWineBin);
    if (preloadDylib) {
      env.MTL_HUD_ENABLED = '1';
      const existingInsert = splitDyldInsertLibraries(env.DYLD_INSERT_LIBRARIES);
      if (!existingInsert.includes(preloadDylib)) {
        existingInsert.unshift(preloadDylib);
      }
      env.DYLD_INSERT_LIBRARIES = existingInsert.join(':');
      if (params.syncCxEnv === true) {
        resolveSipSafeWineBinaryAndPreloadEnv(candidateWineBin, env, {
          layerType: chosenLayer?.type,
        });
      }
      if (moltenVkPath) {
        env.MVK_ICD_LIBRARY_PATH = moltenVkPath;
        env.ONE_LAUNCHER_MOLTENVK_PATH = moltenVkPath;
      }
      if (userCustomDxvkHud) {
        env.DXVK_HUD = userCustomDxvkHud;
      } else {
        delete env.DXVK_HUD;
        stripCxEnvKeys(['DXVK_HUD']);
      }
      return {
        hudEnabled: true,
        mode: 'metal_hud',
        appliedMetalHud: true,
        appliedDxvkHud: Boolean(env.DXVK_HUD),
        usedPreloadDylib: true,
      };
    }
  }

  // Hardened Runtime (or unavailable preload dylib) + deadlocking MoltenVK -> Fixes Bug A!
  delete env.MTL_HUD_ENABLED;
  delete env.ONE_LAUNCHER_MOLTENVK_PATH;
  stripPreloadFromDyldInsertIfAllowed();
  stripCxEnvKeys(
    audioClampActive || hasCustomUserDyldInsert
      ? ['MTL_HUD_ENABLED']
      : ['MTL_HUD_ENABLED', 'DYLD_INSERT_LIBRARIES']
  );

  if (canFallbackToDxvkHud) {
    // Unconditionally enable DXVK_HUD (NEVER blocked by legacy cfg.dxvkHud === false)
    env.DXVK_HUD = userCustomDxvkHud || 'devinfo,fps,frametimes';
    diagLog.warn('launchGame.suppressedDeadlockingMetalHudUnderHardenedRuntime', {
      gameId: params.gameId || undefined,
      binaryPath: candidateWineBin,
      layerType: chosenLayer?.type,
      fallback: 'dxvk_hud',
    });
    return {
      hudEnabled: true,
      mode: 'dxvk_hud',
      appliedMetalHud: false,
      appliedDxvkHud: true,
      usedPreloadDylib: false,
    };
  }

  if (userCustomDxvkHud) {
    env.DXVK_HUD = userCustomDxvkHud;
  } else {
    delete env.DXVK_HUD;
  }
  diagLog.warn('launchGame.suppressedDeadlockingMetalHudUnderHardenedRuntime', {
    gameId: params.gameId || undefined,
    binaryPath: candidateWineBin,
    layerType: chosenLayer?.type,
    fallback: 'none',
  });
  return {
    hudEnabled: true,
    mode: 'suppressed_deadlock',
    appliedMetalHud: false,
    appliedDxvkHud: Boolean(env.DXVK_HUD),
    usedPreloadDylib: false,
  };
}

/**
 * Format a `KEY="VALUE"` token safe for Perl `Text::ParseWords::shellwords` (`$ENV{CX_ENV}`).
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function formatCxEnvAssignmentToken(key, value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

/**
 * Merge `KEY=VALUE` assignments into CrossOver's `CX_ENV` string (`bin/wine:722`), updating
 * matching keys idempotently while preserving any existing user `CX_ENV` assignments.
 *
 * @param {string | undefined} existingCxEnv
 * @param {Record<string, string | undefined | null>} updates
 * @returns {string}
 */
function mergeCxEnvVariables(existingCxEnv, updates = {}) {
  const parsed = parseCxEnvShellwordTokens(existingCxEnv || '');
  const updateEntries = Object.entries(updates).filter(
    ([k, v]) => k && typeof v === 'string' && v.length > 0
  );
  if (updateEntries.length === 0) {
    return parsed.map((t) => t.rawToken).join(' ');
  }
  const updateMap = new Map(
    updateEntries.map(([k, v]) => [k, formatCxEnvAssignmentToken(k, String(v))])
  );
  const seen = new Set();
  const outTokens = [];
  for (const tok of parsed) {
    if (tok.key && updateMap.has(tok.key)) {
      if (!seen.has(tok.key)) {
        seen.add(tok.key);
        outTokens.push(/** @type {string} */ (updateMap.get(tok.key)));
      }
    } else if (tok.rawToken) {
      outTokens.push(tok.rawToken);
    }
  }
  for (const [k, formatted] of updateMap.entries()) {
    if (!seen.has(k)) {
      seen.add(k);
      outTokens.push(formatted);
    }
  }
  return outTokens.join(' ');
}

/**
 * Derive `<cxRoot>` (`.../Contents/SharedSupport/CrossOver`) from a CrossOver `wine` or `wineloader` binary path.
 *
 * @param {string} wineBinaryPath
 * @returns {string}
 */
function deriveCrossOverRootFromBinaryPath(wineBinaryPath) {
  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') return '';
  const norm = path.resolve(wineBinaryPath);
  const sharedMatch = norm.match(/^(.*[\\/]Contents[\\/]SharedSupport[\\/]CrossOver)(?:[\\/]|$)/i);
  if (sharedMatch && sharedMatch[1]) {
    return sharedMatch[1];
  }
  const binDir = path.dirname(norm);
  if (path.basename(binDir).toLowerCase() === 'bin') {
    return path.dirname(binDir);
  }
  const unixMatch = norm.match(
    /^(.*)[\\/]lib(?:64)?[\\/]wine[\\/][^\\/]+[\\/]wine(?:\.app[\\/]Contents[\\/]MacOS[\\/]wine)?$/i
  );
  if (unixMatch && unixMatch[1]) {
    return unixMatch[1];
  }
  return '';
}

/**
 * Align `env.WINEMSYNC` with an already-live `wineserver` in `bottlePath` so helper (`reg.exe`)
 * and game processes never abort inside `msync_init` (`rc=1`) due to client/server sync mismatch.
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} env
 * @param {Record<string, any>} [options]
 * @returns {string | undefined}
 */
function alignWineMsyncWithLiveBottle(bottlePath, env = {}, options = {}) {
  if (!bottlePath || typeof bottlePath !== 'string' || !env || typeof env !== 'object') {
    return env?.WINEMSYNC;
  }
  let canonicalPrefix = path.resolve(bottlePath);
  try {
    if (fs.existsSync(bottlePath)) {
      canonicalPrefix = fs.realpathSync(bottlePath);
    }
  } catch {}

  let isLive = false;
  try {
    const { isBottleWineserverActive } = require('../firstPartyRegistration.cjs');
    isLive = isBottleWineserverActive(bottlePath, options);
  } catch {
    isLive = Boolean(options?.wineserverActive);
  }

  if (!isLive) {
    if (env.WINEMSYNC === '0' || env.WINEMSYNC === '1') {
      setBoundedMapEntry(liveBottleMsyncByPrefix, canonicalPrefix, String(env.WINEMSYNC), 128);
    }
    return env.WINEMSYNC;
  }

  // 1. Check in-memory record of the sync mode used when booting this prefix
  const recorded = liveBottleMsyncByPrefix.get(canonicalPrefix);
  if (recorded === '0' || recorded === '1') {
    env.WINEMSYNC = recorded;
    return recorded;
  }

  // 2. Check Wine server socket directory for msync artifact if running on darwin/linux
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    try {
      const st = fs.statSync(canonicalPrefix);
      const serverFolder = `server-${Number(st.dev).toString(16)}-${Number(st.ino).toString(16)}`;
      const uid = process.getuid();
      for (const tmpRoot of Array.from(new Set(['/tmp', os.tmpdir()]))) {
        const serverDir = path.join(tmpRoot, `.wine-${uid}`, serverFolder);
        if (fs.existsSync(path.join(serverDir, 'msync'))) {
          env.WINEMSYNC = '1';
          setBoundedMapEntry(liveBottleMsyncByPrefix, canonicalPrefix, '1', 128);
          return '1';
        }
      }
    } catch {}
  }

  // 3. Inspect existing `cxbottle.conf` `"WINEMSYNC"` value before any overwrite
  try {
    const cxbottleConfPath = path.join(bottlePath, 'cxbottle.conf');
    if (fs.existsSync(cxbottleConfPath)) {
      const rawConf = fs.readFileSync(cxbottleConfPath, 'utf8');
      const msyncMatch = rawConf.match(/^\s*"WINEMSYNC"\s*=\s*"([01])"/m);
      if (msyncMatch && (msyncMatch[1] === '0' || msyncMatch[1] === '1')) {
        env.WINEMSYNC = msyncMatch[1];
        setBoundedMapEntry(liveBottleMsyncByPrefix, canonicalPrefix, msyncMatch[1], 128);
        return msyncMatch[1];
      }
    }
  } catch {}

  if (!env.WINEMSYNC) {
    env.WINEMSYNC = '1';
  }
  return env.WINEMSYNC;
}

/**
 * Inspect whether a Wine binary is CrossOver's Perl `bin/wine` wrapper, another SIP-interpreter
 * shebang script, or a direct Mach-O `wineloader`, and prepare a SIP-safe & SIP-disabled-safe `env`:
 * - CrossOver Perl `bin/wine` (`#!/usr/bin/perl`, `arm64e`): forwards `DYLD_INSERT_LIBRARIES` and
 *   `WINEDLLOVERRIDES` via `CX_ENV` (`bin/wine:722`), mirrors `WINEDEBUG` into `CX_DEBUGMSG`, and
 *   **always deletes top-level `DYLD_INSERT_LIBRARIES`** so `/usr/bin/perl` never crashes or drops preload.
 * - Direct CrossOver `wineloader` Mach-O: populates `CX_ROOT` and `CX_APPLEGPTK_LIBD3DSHARED_PATH`
 *   so `cxcompatdb.so` never logs `"CX_ROOT not set"`.
 * - Non-CrossOver SIP-shebang Wine scripts: resolves adjacent Mach-O `wineloader`/`wineloader64` if
 *   present, or deletes top-level `DYLD_INSERT_LIBRARIES` if falling back to the SIP script.
 *
 * @param {string} wineBinaryPath
 * @param {Record<string, any>} [env]
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
/** @type {Map<string, boolean>} */
const dyldInsertAllowedCache = new Map();

/**
 * Pure-Node (`0` subprocesses) Mach-O `LC_CODE_SIGNATURE` (`0x1d`) + `CodeDirectory` (`0xfade0c02`)
 * + `CS_MAGIC_ENTITLEMENTS` (`0xfade7171`) inspector that determines whether a Wine / CrossOver
 * loader binary permits `DYLD_INSERT_LIBRARIES` without macOS Hardened Runtime (`0x10000`) rejection.
 *
 * Returns `false` ONLY when the resolved Mach-O loader has Hardened Runtime (`flags & 0x10000`) AND
 * lacks both `com.apple.security.cs.allow-dyld-environment-variables` and `com.apple.security.get-task-allow`.
 * Returns `true` for unsigned binaries, non-hardened binaries, CrossOver loaders with `allow-dyld-environment-variables`,
 * and virtual/synthetic unit-test stubs.
 *
 * @param {string} wineBinaryPath
 * @returns {boolean}
 */
function doesWineLoaderAllowDyldInsert(wineBinaryPath) {
  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') {
    return true;
  }

  let targetPath = wineBinaryPath;
  try {
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return true;
    }
  } catch {
    return true;
  }

  // If wineBinaryPath is a shebang wrapper (e.g. CrossOver Perl bin/wine or #!/bin/sh wine64),
  // resolve the underlying Mach-O wineloader binary to inspect its code signature.
  try {
    const probeFd = fs.openSync(targetPath, 'r');
    const magicProbe = Buffer.alloc(4);
    let readBytes = 0;
    try {
      readBytes = fs.readSync(probeFd, magicProbe, 0, 4, 0);
    } finally {
      try {
        fs.closeSync(probeFd);
      } catch {}
    }
    if (readBytes >= 2 && magicProbe[0] === 0x23 && magicProbe[1] === 0x21) {
      const binDir = path.dirname(path.resolve(targetPath));
      const arm64Loaders = [
        path.resolve(
          binDir,
          '..',
          'lib',
          'wine',
          'aarch64-unix',
          'wine.app',
          'Contents',
          'MacOS',
          'wine'
        ),
        path.resolve(binDir, '..', 'lib', 'wine', 'aarch64-unix', 'wine'),
      ];
      const loaderCandidates = [
        path.resolve(binDir, '..', 'CrossOver-Hosted Application', 'wineloader'),
        path.resolve(binDir, '..', 'CrossOver-Hosted Application', 'wineloader64'),
        path.join(binDir, 'wineloader64'),
        path.join(binDir, 'wineloader'),
        path.join(binDir, 'wine64-preloader'),
        ...(process.arch === 'arm64' ? arm64Loaders : []),
        path.resolve(
          binDir,
          '..',
          'lib',
          'wine',
          'x86_64-unix',
          'wine.app',
          'Contents',
          'MacOS',
          'wine'
        ),
        path.resolve(binDir, '..', 'lib64', 'wine', 'x86_64-unix', 'wine'),
        path.resolve(binDir, '..', 'lib', 'wine', 'x86_64-unix', 'wine'),
        ...(process.arch !== 'arm64' ? arm64Loaders : []),
      ];
      const foundMachO = loaderCandidates.find((cand) => {
        try {
          return fs.existsSync(cand) && inspectMacMachOHeader(cand).isMachO;
        } catch {
          return false;
        }
      });
      if (!foundMachO) {
        return true;
      }
      targetPath = foundMachO;
    }
  } catch {
    return true;
  }

  let cacheKey = targetPath;
  let fileSize = 0;
  try {
    const realTarget = fs.realpathSync(targetPath);
    const st = fs.statSync(realTarget);
    fileSize = st.size;
    cacheKey = `${realTarget}:${Math.trunc(st.mtimeMs)}:${st.size}`;
    targetPath = realTarget;
  } catch {
    return true;
  }

  if (dyldInsertAllowedCache.has(cacheKey)) {
    return /** @type {boolean} */ (dyldInsertAllowedCache.get(cacheKey));
  }

  let allowed = true;
  /** @type {number | null} */
  let fd = null;
  try {
    fd = fs.openSync(targetPath, 'r');
    const headLen = Math.min(fileSize, 16384);
    if (headLen < 32) {
      setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
      return true;
    }
    let sliceOffset = 0;
    let headBuf = Buffer.alloc(headLen);
    const firstRead = fs.readSync(fd, headBuf, 0, headLen, 0);
    if (firstRead < 32) {
      setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
      return true;
    }

    const magicBE = headBuf.readUInt32BE(0);
    if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
      const isFatBE = magicBE === 0xcafebabe;
      const nfat = isFatBE ? headBuf.readUInt32BE(4) : headBuf.readUInt32LE(4);
      if (nfat >= 1 && nfat <= 16 && firstRead >= 8 + nfat * 20) {
        const preferredCpu = process.arch === 'x64' ? 0x01000007 : 0x0100000c;
        let chosenOff = isFatBE ? headBuf.readUInt32BE(16) : headBuf.readUInt32LE(16);
        for (let i = 0; i < nfat; i += 1) {
          const entryOff = 8 + i * 20;
          const cpu = isFatBE
            ? headBuf.readUInt32BE(entryOff)
            : headBuf.readUInt32LE(entryOff);
          const off = isFatBE
            ? headBuf.readUInt32BE(entryOff + 8)
            : headBuf.readUInt32LE(entryOff + 8);
          if (cpu === preferredCpu && off > 0) {
            chosenOff = off;
            break;
          }
        }
        if (chosenOff > 0 && chosenOff + 32 <= fileSize) {
          sliceOffset = chosenOff;
          const sliceReadLen = Math.min(fileSize - sliceOffset, 16384);
          headBuf = Buffer.alloc(sliceReadLen);
          const sr = fs.readSync(fd, headBuf, 0, sliceReadLen, sliceOffset);
          if (sr < 32) {
            setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
            return true;
          }
        }
      }
    }

    const sliceMagicLE = headBuf.readUInt32LE(0);
    const isMachO64LE = sliceMagicLE === 0xfeedfacf;
    const isMachO32LE = sliceMagicLE === 0xfeedface;
    if (!isMachO64LE && !isMachO32LE) {
      setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, true, 256);
      return true;
    }

    const machHeaderSize = isMachO64LE ? 32 : 28;
    const ncmds = headBuf.readUInt32LE(16);
    const sizeofcmds = headBuf.readUInt32LE(20);
    const neededHeaderBytes = machHeaderSize + sizeofcmds;
    if (
      ncmds > 0 &&
      sizeofcmds > 0 &&
      neededHeaderBytes <= 256 * 1024 &&
      sliceOffset + neededHeaderBytes <= fileSize &&
      neededHeaderBytes > headBuf.length
    ) {
      headBuf = Buffer.alloc(neededHeaderBytes);
      fs.readSync(fd, headBuf, 0, neededHeaderBytes, sliceOffset);
    }

    let sigDataOff = 0;
    let sigDataSize = 0;
    let cmdOff = machHeaderSize;
    const maxCmdEnd = Math.min(headBuf.length, machHeaderSize + sizeofcmds);
    for (let i = 0; i < ncmds && cmdOff + 8 <= maxCmdEnd; i += 1) {
      const cmd = headBuf.readUInt32LE(cmdOff);
      const cmdsize = headBuf.readUInt32LE(cmdOff + 4);
      if (cmdsize < 8 || cmdOff + cmdsize > maxCmdEnd) break;
      if (cmd === 0x1d && cmdsize >= 16) {
        sigDataOff = headBuf.readUInt32LE(cmdOff + 8);
        sigDataSize = headBuf.readUInt32LE(cmdOff + 12);
        break;
      }
      cmdOff += cmdsize;
    }

    if (
      sigDataOff > 0 &&
      sigDataSize >= 12 &&
      sigDataSize <= 2 * 1024 * 1024 &&
      sliceOffset + sigDataOff + sigDataSize <= fileSize
    ) {
      const sigBuf = Buffer.alloc(sigDataSize);
      const sigRead = fs.readSync(fd, sigBuf, 0, sigDataSize, sliceOffset + sigDataOff);
      if (sigRead >= 12 && sigBuf.readUInt32BE(0) === 0xfade0cc0) {
        const blobCount = sigBuf.readUInt32BE(8);
        let hasHardenedRuntime = false;
        let hasAllowDyldEntitlement = false;

        for (let b = 0; b < blobCount && 12 + (b + 1) * 8 <= sigRead; b += 1) {
          const blobOff = sigBuf.readUInt32BE(12 + b * 8 + 4);
          if (blobOff + 8 > sigRead) continue;
          const blobMagic = sigBuf.readUInt32BE(blobOff);
          const blobLen = sigBuf.readUInt32BE(blobOff + 4);
          if (blobMagic === 0xfade0c02 && blobOff + 16 <= sigRead) {
            const cdFlags = sigBuf.readUInt32BE(blobOff + 12);
            if ((cdFlags & 0x00010000) !== 0) {
              hasHardenedRuntime = true;
            }
          } else if (blobMagic === 0xfade7171 && blobLen > 8 && blobOff + 8 < sigRead) {
            const entEnd = Math.min(sigRead, blobOff + blobLen);
            const entXml = sigBuf.subarray(blobOff + 8, entEnd).toString('utf8');
            if (
              /<key>\s*com\.apple\.security\.(?:cs\.allow-dyld-environment-variables|get-task-allow)\s*<\/key>\s*<true\s*\/>/i.test(
                entXml
              )
            ) {
              hasAllowDyldEntitlement = true;
            }
          }
        }

        if (hasHardenedRuntime && !hasAllowDyldEntitlement) {
          allowed = false;
        }
      }
    }
  } catch {
    allowed = true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  setBoundedMapEntry(dyldInsertAllowedCache, cacheKey, allowed, 256);
  return allowed;
}

const CX_ENV_MANAGED_FORWARD_KEYS = [
  'WINEDLLOVERRIDES',
  'CX_GRAPHICS_BACKEND',
  'CX_GRAPHICS_BACKEND_VERSION',
  'DXVK_CONFIG_FILE',
  'DXVK_CONFIG',
  'DXVK_STATE_CACHE_PATH',
  'DXVK_LOG_LEVEL',
  'DXVK_LOG_PATH',
  'DXVK_FRAME_RATE',
  'DXVK_HUD',
  'DXMT_CONFIG',
  'DXMT_LOG_LEVEL',
  'DXMT_LOG_PATH',
  'DXMT_METALFX_SPATIAL_SWAPCHAIN',
  'DXMT_ENABLE_NVEXT',
  'D3DM_ENABLE_METALFX',
  'D3DM_MAX_FPS',
  'D3DM_NVNGX_PATH',
  'CX_FWD_COMPAT_GL_CTX',
  'CX_LIBVULKAN',
  'MVK_CONFIG_RESUME_LOST_DEVICE',
  'MVK_CONFIG_LOG_LEVEL',
  'MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS',
  'MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS',
  'MVK_CONFIG_FAST_MATH_ENABLED',
  'MVK_ICD_LIBRARY_PATH',
  'ONE_LAUNCHER_MOLTENVK_PATH',
  'ONE_LAUNCHER_METAL_PRELOAD',
  'ONE_LAUNCHER_AUDIO_BUFFER_CLAMP',
  'ONE_LAUNCHER_AUDIO_RT_THREAD',
  'ONE_LAUNCHER_SUPPRESS_PRELOAD',
  'ONE_LAUNCHER_DISPLAY_SCALING_MODE',
  'ONE_LAUNCHER_DISPLAY_ASPECT',
  'ONE_LAUNCHER_SCALING_FILTER',
  'ONE_LAUNCHER_SAFE_INSET_TOP',
  'ONE_LAUNCHER_FULLSCREEN_HOTKEY',
  'ONE_LAUNCHER_SCALER_DLL_X86',
  'ONE_LAUNCHER_SCALER_DLL_X64',
  'ONE_LAUNCHER_LAUNCHER_EXE_X86',
  'ONE_LAUNCHER_LAUNCHER_EXE_X64',
  'ONE_LAUNCHER_DISPLAY_CONTROL_FILE',
  'ONE_LAUNCHER_DISPLAY_STATUS_FILE',
  'ONE_LAUNCHER_DISPLAY_TRACE_FILE',
  'ONE_LAUNCHER_SINGLE_CORE_AFFINITY',
  'MTL_HUD_ENABLED',
  'WINEMSYNC',
  'WINEESYNC',
  'FEX_X87REDUCEDPRECISION',
  'FEX_TSOENABLED',
  'FEX_MULTIBLOCK',
];

function resolveSipSafeWineBinaryAndPreloadEnv(
  wineBinaryPath,
  /** @type {Record<string, any>} */ env = {},
  /** @type {Record<string, any>} */ options = {}
) {
  if (!env || typeof env !== 'object') {
    return wineBinaryPath;
  }

  if (!wineBinaryPath || typeof wineBinaryPath !== 'string') {
    return wineBinaryPath;
  }

  const isCrossOverPathOrBottle =
    /CrossOver/i.test(wineBinaryPath) ||
    Boolean(env.CX_BOTTLE) ||
    options?.layerType === 'crossover' ||
    options?.layerType === 'crossover_preview' ||
    options?.layerType === 'crossover_preview_arm64';
  const looksLikeDirectMachOLoader = /\/(?:wineloader(?:64|2)?|wine64-preloader)$/i.test(
    wineBinaryPath
  );

  let isShebangScript = false;
  let isSipInterpreter = false;
  let fileExistsOnDisk = false;
  try {
    if (fs.existsSync(wineBinaryPath) && fs.statSync(wineBinaryPath).isFile()) {
      fileExistsOnDisk = true;
      const fd = fs.openSync(wineBinaryPath, 'r');
      try {
        const headBuf = Buffer.alloc(128);
        const bytesRead = fs.readSync(fd, headBuf, 0, 128, 0);
        const firstLine = headBuf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] || '';
        const shebangMatch = firstLine.match(/^#!\s*(\/\S+)/);
        if (shebangMatch) {
          isShebangScript = true;
          isSipInterpreter = /^\/(usr\/bin|bin|sbin|usr\/sbin)\//.test(shebangMatch[1]);
        }
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  } catch {}

  const isVirtualCrossOverBinWine =
    !fileExistsOnDisk &&
    !looksLikeDirectMachOLoader &&
    (/\/CrossOver[^/]*\/bin\/wine$/i.test(wineBinaryPath) ||
      (isCrossOverPathOrBottle && /\/bin\/wine$/i.test(wineBinaryPath)));

  // Case 1: CrossOver Perl `bin/wine` wrapper (real SIP-shebang script or virtual CrossOver `bin/wine`)
  if ((isCrossOverPathOrBottle && isSipInterpreter) || isVirtualCrossOverBinWine) {
    /** @type {Record<string, string>} */
    const cxEnvUpdates = {};
    if (
      typeof env.DYLD_INSERT_LIBRARIES === 'string' &&
      env.DYLD_INSERT_LIBRARIES.trim() &&
      doesWineLoaderAllowDyldInsert(wineBinaryPath)
    ) {
      cxEnvUpdates.DYLD_INSERT_LIBRARIES = env.DYLD_INSERT_LIBRARIES.trim();
    }
    for (const fwdKey of CX_ENV_MANAGED_FORWARD_KEYS) {
      const rawVal = env[fwdKey];
      if (typeof rawVal === 'string' && rawVal.trim()) {
        cxEnvUpdates[fwdKey] = rawVal.trim();
      }
    }
    if (Object.keys(cxEnvUpdates).length > 0) {
      env.CX_ENV = mergeCxEnvVariables(env.CX_ENV, cxEnvUpdates);
    }
    // NEVER leave DYLD_INSERT_LIBRARIES in top-level env when invoking #!/usr/bin/perl (arm64e)
    delete env.DYLD_INSERT_LIBRARIES;

    if (typeof env.WINEDEBUG === 'string' && env.WINEDEBUG.trim() && !env.CX_DEBUGMSG) {
      env.CX_DEBUGMSG = env.WINEDEBUG.trim();
    }

    if (fileExistsOnDisk) {
      const binDir = path.dirname(path.resolve(wineBinaryPath));
      const explicitWin64 =
        options?.wineArch === 'win64' ||
        options?.layerType === 'crossover' ||
        options?.layerType === 'crossover_preview';
      const preferArm64Loader =
        !explicitWin64 &&
        (options?.layerType === 'crossover_preview_arm64' ||
          options?.wineArch === 'arm64' ||
          /aarch64-unix|CrossOver Preview arm64\.app/i.test(wineBinaryPath));
      const arm64CxLoaders = [
        path.resolve(
          binDir,
          '..',
          'lib',
          'wine',
          'aarch64-unix',
          'wine.app',
          'Contents',
          'MacOS',
          'wine'
        ),
        path.resolve(binDir, '..', 'lib', 'wine', 'aarch64-unix', 'wine'),
      ];
      const x64CxLoaders = [
        path.join(binDir, 'wineloader64'),
        path.join(binDir, 'wineloader'),
        path.resolve(
          binDir,
          '..',
          'lib',
          'wine',
          'x86_64-unix',
          'wine.app',
          'Contents',
          'MacOS',
          'wine'
        ),
        path.resolve(binDir, '..', 'lib64', 'wine', 'x86_64-unix', 'wine'),
        path.resolve(binDir, '..', 'lib', 'wine', 'x86_64-unix', 'wine'),
      ];
      const cxWineloaderCandidates = preferArm64Loader
        ? [...arm64CxLoaders, ...x64CxLoaders]
        : [...x64CxLoaders, ...arm64CxLoaders];
      const foundLoader = cxWineloaderCandidates.find((p) => {
        try {
          return fs.existsSync(p) && inspectMacMachOHeader(p).isMachO;
        } catch {
          return false;
        }
      });
      if (foundLoader) {
        env.WINELOADER = env.WINELOADER || foundLoader;
      }
    }
    return wineBinaryPath;
  }

  // Case 2: Non-CrossOver SIP-protected interpreter wrapper (e.g. #!/bin/sh wine64 or gameportingtoolkit)
  if (isShebangScript && isSipInterpreter) {
    const wantsDyldInsert =
      typeof env.DYLD_INSERT_LIBRARIES === 'string' && Boolean(env.DYLD_INSERT_LIBRARIES.trim());
    const isGptkWrapperScript = /gameportingtoolkit/i.test(path.basename(wineBinaryPath));
    if (wantsDyldInsert && !isGptkWrapperScript) {
      const binDir = path.dirname(path.resolve(wineBinaryPath));
      const wineRoot = path.resolve(binDir, '..');
      const loaderCandidates = [
        path.join(binDir, 'wineloader64'),
        path.join(binDir, 'wineloader'),
        path.join(binDir, 'wine64-preloader'),
        path.resolve(wineRoot, 'lib', 'wine', 'x86_64-unix', 'wine'),
        path.resolve(wineRoot, 'lib64', 'wine', 'x86_64-unix', 'wine'),
      ];
      for (const cand of loaderCandidates) {
        try {
          if (
            fs.existsSync(cand) &&
            inspectMacMachOHeader(cand).isMachO &&
            doesWineLoaderAllowDyldInsert(cand)
          ) {
            const hasExplicitLibEnv = Boolean(
              env.DYLD_FALLBACK_LIBRARY_PATH && env.WINEDLLPATH
            );
            const derivedLibDirs = [
              path.join(wineRoot, 'lib64'),
              path.join(wineRoot, 'lib'),
            ].filter((d) => fs.existsSync(d));
            const derivedDllDirs = [
              path.join(wineRoot, 'lib64', 'wine'),
              path.join(wineRoot, 'lib', 'wine'),
            ].filter((d) => fs.existsSync(d));
            if (hasExplicitLibEnv || (derivedLibDirs.length > 0 && derivedDllDirs.length > 0)) {
              if (!env.DYLD_FALLBACK_LIBRARY_PATH && derivedLibDirs.length > 0) {
                env.DYLD_FALLBACK_LIBRARY_PATH = `${derivedLibDirs.join(':')}:/usr/lib`;
              }
              if (!env.WINEDLLPATH && derivedDllDirs.length > 0) {
                env.WINEDLLPATH = derivedDllDirs.join(':');
              }
              return cand;
            }
          }
        } catch {}
      }
    }
    // Preserve wrapper script (retaining its GST_PLUGIN_SYSTEM_PATH_1_0 / DYLD_FALLBACK_LIBRARY_PATH)
    // and strip top-level DYLD_INSERT_LIBRARIES so arm64e SIP interpreter never rejects or crashes.
    delete env.DYLD_INSERT_LIBRARIES;
    return wineBinaryPath;
  }

  // Case 3: Direct Mach-O binary (`wineloader` / `wineloader64` / `wine64` / `lib64/wine/.../wine`)
  if (!isShebangScript && fileExistsOnDisk && env.DYLD_INSERT_LIBRARIES) {
    if (!doesWineLoaderAllowDyldInsert(wineBinaryPath)) {
      delete env.DYLD_INSERT_LIBRARIES;
    }
  }

  if (isCrossOverPathOrBottle && !isShebangScript) {
    const cxRoot = deriveCrossOverRootFromBinaryPath(wineBinaryPath);
    if (cxRoot) {
      if (!env.CX_ROOT) {
        env.CX_ROOT = cxRoot;
      }
      const gptkSharedDylibCandidates = [
        path.join(cxRoot, 'lib', 'apple_gptk', 'external', 'libd3dshared.dylib'),
        path.join(cxRoot, 'lib64', 'apple_gptk', 'external', 'libd3dshared.dylib'),
      ];
      try {
        if (!env.CX_APPLEGPTK_LIBD3DSHARED_PATH) {
          const foundSharedDylib = gptkSharedDylibCandidates.find((p) => fs.existsSync(p));
          if (foundSharedDylib) {
            env.CX_APPLEGPTK_LIBD3DSHARED_PATH = foundSharedDylib;
          }
        }
      } catch {}
    }
    if (env.ROSETTA_ADVERTISE_AVX === '0') {
      delete env.ROSETTA_ADVERTISE_AVX;
    }
  }

  return wineBinaryPath;
}

/**
 * Alias helper for preparing `env` right before spawning any Wine / CrossOver process
 * (`bin/wine` Perl wrapper or direct `wineloader`), ensuring `DYLD_INSERT_LIBRARIES` is never
 * left in top-level `env` for `#!/usr/bin/perl` and `CX_ENV` / `CX_ROOT` are properly populated.
 *
 * @param {string} wineBinaryPath
 * @param {Record<string, any>} [env]
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function prepareCrossOverWineSpawnEnv(wineBinaryPath, env = {}, options = {}) {
  return resolveSipSafeWineBinaryAndPreloadEnv(wineBinaryPath, env, options);
}

/**
 * Prepare a fully aligned Wine command + environment for helper/bootstrap commands (`reg.exe`,
 * `wineboot`, installer helpers, publisher clients) or game launches targeting `bottlePath`:
 * - Aligns `WINEMSYNC` with any live `wineserver` (`alignWineMsyncWithLiveBottle`).
 * - Applies `resolveSipSafeWineBinaryAndPreloadEnv` (`CX_ENV`, `CX_ROOT`, SIP-safe preload stripping).
 * - Computes `prefixArgs` (`['--dll', env.WINEDLLOVERRIDES]` on CrossOver Perl `bin/wine` when non-GUI suppression is off).
 * - When `suppressGuiDialogs === true`: disables `winemenubuilder.exe`, `mscoree`, `mshtml`,
 *   `MTL_HUD_ENABLED`, `DXVK_HUD`, and `DYLD_INSERT_LIBRARIES`, and sets `ONE_LAUNCHER_SUPPRESS_PRELOAD=1` + `WINEDEBUG=-all`.
 *
 * @param {{
 *   wineBinary: string,
 *   bottlePath?: string,
 *   env?: Record<string, any>,
 *   suppressGuiDialogs?: boolean,
 *   layerType?: string,
 *   wineserverActive?: boolean,
 *   includeDllFlag?: boolean
 * }} params
 * @returns {{ wineBinary: string, prefixArgs: string[], env: Record<string, any> }}
 */
function prepareAlignedBottleWineCommand(params) {
  const src = params && typeof params === 'object' ? params : { wineBinary: '' };
  const rawWineBin = String(src.wineBinary || '');
  const bottlePath = typeof src.bottlePath === 'string' ? src.bottlePath : '';
  /** @type {Record<string, any>} */
  const targetEnv = src.env && typeof src.env === 'object' ? src.env : {};

  if (bottlePath) {
    if (!targetEnv.WINEPREFIX) {
      targetEnv.WINEPREFIX = bottlePath;
    }
    const cxBottleMatch = /\/Bottles\/([^/]+)$/i.exec(bottlePath.replace(/\\/g, '/'));
    if (cxBottleMatch && cxBottleMatch[1] && !targetEnv.CX_BOTTLE) {
      targetEnv.CX_BOTTLE = cxBottleMatch[1];
    }
  }

  if (src.suppressGuiDialogs === true) {
    const existingOverrides = String(targetEnv.WINEDLLOVERRIDES || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const reqDisable of ['winemenubuilder.exe=d', 'mscoree=d', 'mshtml=d']) {
      const dllBase = reqDisable.split('=')[0].toLowerCase();
      if (!existingOverrides.some((tok) => tok.split('=')[0].trim().toLowerCase() === dllBase)) {
        existingOverrides.push(reqDisable);
      }
    }
    targetEnv.WINEDLLOVERRIDES = existingOverrides.join(';');
    delete targetEnv.DYLD_INSERT_LIBRARIES;
    delete targetEnv.MTL_HUD_ENABLED;
    delete targetEnv.DXVK_HUD;
    targetEnv.ONE_LAUNCHER_SUPPRESS_PRELOAD = '1';
    targetEnv.ONE_LAUNCHER_METAL_PRELOAD = '0';
    targetEnv.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP = '0';
    if (!targetEnv.WINEDEBUG) {
      targetEnv.WINEDEBUG = '-all';
    }
  }

  if (bottlePath) {
    alignWineMsyncWithLiveBottle(bottlePath, targetEnv, {
      wineserverActive: src.wineserverActive,
    });
  }

  const resolvedBin = resolveSipSafeWineBinaryAndPreloadEnv(rawWineBin, targetEnv, {
    layerType: src.layerType,
  });

  /** @type {string[]} */
  const prefixArgs =
    src.suppressGuiDialogs !== true &&
    src.includeDllFlag !== false &&
    typeof targetEnv.WINEDLLOVERRIDES === 'string' &&
    Boolean(targetEnv.WINEDLLOVERRIDES.trim()) &&
    /\/bin\/wine$/i.test(String(resolvedBin || '')) &&
    (/CrossOver/i.test(String(resolvedBin || '')) || Boolean(targetEnv.CX_BOTTLE))
      ? ['--dll', targetEnv.WINEDLLOVERRIDES.trim()]
      : [];

  return {
    wineBinary: resolvedBin,
    prefixArgs,
    env: targetEnv,
  };
}

/**
 * Shared helper for auxiliary Wine / CrossOver commands (`wineboot`, `wineserver`, registry
 * queries, background client wakes, and display watcher spawns) returning `{ binaryPath, env }`.
 *
 * @param {{
 *   wineBinary: string,
 *   bottlePath?: string | null,
 *   env?: Record<string, any>,
 *   suppressGuiDialogs?: boolean,
 *   layerType?: string | null,
 * }} params
 * @returns {{ binaryPath: string, env: Record<string, any>, prefixArgs: string[] }}
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
  const res = prepareAlignedBottleWineCommand({
    wineBinary,
    bottlePath: bottlePath || workingEnv.WINEPREFIX || '',
    env: workingEnv,
    suppressGuiDialogs,
    layerType,
  });
  const resolvedFromHelper =
    res && typeof res.wineBinary === 'string' && res.wineBinary ? res.wineBinary : '';
  if (resolvedFromHelper) {
    return {
      binaryPath: resolvedFromHelper,
      env: res.env && typeof res.env === 'object' ? res.env : workingEnv,
      prefixArgs: Array.isArray(res.prefixArgs) ? res.prefixArgs : [],
    };
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
    prefixArgs: [],
  };
}

function resolveWineserverBinary(wineBinary, /** @type {Record<string, any>} */ options = {}) {
  const binPath =
    typeof wineBinary === 'object' && wineBinary !== null
      ? String(wineBinary.binaryPath || '')
      : String(wineBinary || '');
  if (!binPath) return null;

  const normalizedBin = path.resolve(binPath);
  if (/wineserver(?:-arm64|-x86|64)?$/i.test(normalizedBin) && fs.existsSync(normalizedBin)) {
    return normalizedBin;
  }

  const binDir = path.dirname(normalizedBin);
  const parentBinDir = path.resolve(binDir, '..', 'bin');
  const cxRoot = deriveCrossOverRootFromBinaryPath(normalizedBin);
  const cxRootBinDir = cxRoot ? path.join(cxRoot, 'bin') : '';
  const searchDirs = Array.from(new Set([binDir, parentBinDir, cxRootBinDir].filter(Boolean)));

  const bottleMetaArch =
    !options?.wineArch && (options?.bottlePath || options?.winePrefix)
      ? inspectBottleConfMetadata(options.bottlePath || options.winePrefix).wineArch
      : undefined;
  const effectiveWineArch = options?.wineArch || bottleMetaArch;
  const explicitWin64 =
    effectiveWineArch === 'win64' ||
    options?.layerType === 'crossover' ||
    options?.layerType === 'crossover_preview';
  const explicitArm64 =
    !explicitWin64 &&
    (effectiveWineArch === 'arm64' || options?.layerType === 'crossover_preview_arm64');
  const hasArm64BundleMarkers = Boolean(
    !explicitWin64 &&
      !/x86_64-unix|win64/i.test(normalizedBin) &&
      cxRoot &&
      fs.existsSync(path.join(cxRoot, 'lib/wine/aarch64-unix/ntdll.so')) &&
      fs.existsSync(path.join(cxRoot, 'bin/wineserver-arm64'))
  );
  const isArm64Hint =
    explicitArm64 ||
    (!explicitWin64 &&
      (/aarch64-unix|CrossOver Preview arm64\.app/i.test(normalizedBin) ||
        hasArm64BundleMarkers));
  const isWin64Hint =
    explicitWin64 || (!isArm64Hint && /x86_64-unix|win64/i.test(normalizedBin));
  const orderedNames = isArm64Hint
    ? ['wineserver-arm64', 'wineserver', 'wineserver64', 'wineserver-x86']
    : isWin64Hint
      ? ['wineserver', 'wineserver64', 'wineserver-x86', 'wineserver-arm64']
      : ['wineserver', 'wineserver64', 'wineserver-arm64', 'wineserver-x86'];

  for (const name of orderedNames) {
    for (const dir of searchDirs) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

async function shutdownWinePrefix(wineBinary, winePrefix, timeoutMs = 3000, extraOptions = {}) {
  const resolvedWineArch =
    extraOptions?.wineArch ||
    (winePrefix && typeof winePrefix === 'string'
      ? inspectBottleConfMetadata(winePrefix).wineArch
      : undefined);
  const wineserverBin = resolveWineserverBinary(wineBinary, {
    wineArch: resolvedWineArch,
    layerType: extraOptions?.layerType,
  });
  if (!wineserverBin || !winePrefix) {
    return false;
  }

  let canonicalPrefix = winePrefix;
  try {
    canonicalPrefix = fs.realpathSync(winePrefix);
  } catch {}

  const bottleName =
    extraOptions && typeof extraOptions.bottleName === 'string' && extraOptions.bottleName.trim()
      ? extraOptions.bottleName.trim()
      : '';
  const execFileImpl =
    extraOptions && typeof extraOptions.execFileFn === 'function'
      ? extraOptions.execFileFn
      : execFile;

  /** @type {Record<string, any>} */
  const prefixEnv = {
    ...process.env,
    WINEPREFIX: canonicalPrefix,
    ...(bottleName
      ? {
          CX_BOTTLE: bottleName,
          CX_BOTTLE_PATH: extraOptions?.cxBottlePath || path.dirname(canonicalPrefix),
        }
      : extraOptions?.cxBottlePath
        ? { CX_BOTTLE_PATH: extraOptions.cxBottlePath }
        : {}),
  };
  delete prefixEnv.DYLD_INSERT_LIBRARIES;

  let isNodeShebangScriptOnWin32 = false;
  if (process.platform === 'win32') {
    try {
      const head = fs.readFileSync(wineserverBin, 'utf8').slice(0, 64);
      isNodeShebangScriptOnWin32 = head.startsWith('#!/usr/bin/env node');
    } catch {}
  }

  const runWineserverFlag = (/** @type {string} */ flag) =>
    new Promise((resolve) => {
      try {
        if (isNodeShebangScriptOnWin32) {
          execFileImpl(
            process.execPath,
            [wineserverBin, flag],
            { env: prefixEnv, timeout: timeoutMs },
            () => resolve(true)
          );
        } else {
          execFileImpl(wineserverBin, [flag], { env: prefixEnv, timeout: timeoutMs }, () =>
            resolve(true)
          );
        }
      } catch {
        resolve(false);
      }
    });

  await runWineserverFlag('-k');
  await runWineserverFlag('-w');
  liveBottleMsyncByPrefix.delete(canonicalPrefix);

  return true;
}


module.exports = {
  splitDyldInsertLibraries,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  parseCxEnvShellwordTokens,
  stripKeysFromCxEnv,
  applyUnifiedPerformanceHudEnv,
  formatCxEnvAssignmentToken,
  mergeCxEnvVariables,
  deriveCrossOverRootFromBinaryPath,
  alignWineMsyncWithLiveBottle,
  doesWineLoaderAllowDyldInsert,
  CX_ENV_MANAGED_FORWARD_KEYS,
  resolveSipSafeWineBinaryAndPreloadEnv,
  prepareCrossOverWineSpawnEnv,
  prepareAlignedBottleWineCommand,
  prepareAlignedAuxBottleWineCommand,
  resolveWineserverBinary,
  shutdownWinePrefix,
};
