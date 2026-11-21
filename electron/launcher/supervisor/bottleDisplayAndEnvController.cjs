// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { signalSubprocessTree } = require('../processTreeUtils.cjs');
const { atomicWriteFileSync } = require('../securityAndPathUtils.cjs');
const {
  inspectWindowsExecutableHeader,
  hasMalformedBackslashExportForwarder,
} = require('../binaryAndManifestInspectors.cjs');
const {
  getElectron,
  diagLog,
  isTestEnvironment,
  emitSessionUpdated,
  activeSessions,
  inFlightLaunchesByGameId,
  inFlightLaunchAbortControllers,
  setBoundedMapEntry,
} = require('../engineStateRegistry.cjs');
const {
  splitDyldInsertLibraries,
  resolveWineLayerMoltenVkPath,
  doesWineLayerHaveMoltenVkHudDeadlock,
  ensureWineMetalPreloadDylib,
  stripKeysFromCxEnv,
  applyUnifiedPerformanceHudEnv,
  prepareAlignedAuxBottleWineCommand,
  getHostMaxDisplayResolution,
} = require('../macNativeInstallerAndCodesign.cjs');
const { toWineWindowsPath } = require('../firstPartyRegistration.cjs');
const { normalizeChainedHandoffId } = require('../chainedPublisherLaunchers.cjs');
const { normalizeVaultChainedHandoffId } = require('../offlineVaultService.cjs');

/** @type {any} */
let cachedMacCoopDisplayAddon = null;
let macCoopDisplayAddonLoaded = false;

/**
 * Lazy-load Wave 1's `libone_coop_activate.dylib` N-API addon for host CoreGraphics
 * display-mode & ColorSync gamma restoration after abnormal game crashes (`SUP-05`).
 *
 * @returns {any}
 */
function loadMacHostDisplayRestoreAddon() {
  if (macCoopDisplayAddonLoaded) {
    return cachedMacCoopDisplayAddon;
  }
  macCoopDisplayAddonLoaded = true;
  if (process.platform !== 'darwin') {
    return null;
  }
  const candidates = [
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'libone_coop_activate.dylib'
        )
      : '',
    path.resolve(__dirname, '..', '..', 'helpers', 'libone_coop_activate.dylib'),
  ].filter(Boolean);
  for (const dylibPath of candidates) {
    try {
      if (!fs.existsSync(dylibPath)) continue;
      const mod = { exports: {} };
      process.dlopen(mod, dylibPath);
      if (typeof (/** @type {any} */ (mod.exports).restoreHostDisplayConfiguration) === 'function') {
        cachedMacCoopDisplayAddon = mod.exports;
        return cachedMacCoopDisplayAddon;
      }
    } catch {}
  }
  return null;
}

/**
 * Restore permanent host display mode and ColorSync gamma configuration after an abnormal game
 * crash (`exitCode !== 0` or fatal signal) so crashed native / `native_driver` / `modern_tier`
 * titles never leave the user's monitor stuck at a low resolution (`SUP-05`).
 *
 * @param {Record<string, any>} [context]
 * @param {Record<string, any>} [options]
 * @returns {{ restored: boolean, method: string, skippedInTest?: boolean }}
 */
function restoreHostDisplayConfiguration(context = {}, options = {}) {
  if (typeof options.restoreHostDisplayFn === 'function') {
    try {
      const res = options.restoreHostDisplayFn(context);
      return { restored: res !== false, method: 'custom_hook' };
    } catch (err) {
      diagLog.warn('supervisor.restoreHostDisplayCustomFailed', err, { gameId: context?.gameId });
      return { restored: false, method: 'custom_hook' };
    }
  }
  if (isTestEnvironment(options) && options.enableHostDisplayRestoreInTest !== true) {
    return { restored: false, method: 'skipped_in_test', skippedInTest: true };
  }
  const targetPlatform = options.platform || process.platform;
  if (targetPlatform === 'darwin') {
    const addon = loadMacHostDisplayRestoreAddon();
    if (addon && typeof addon.restoreHostDisplayConfiguration === 'function') {
      try {
        const ok = Boolean(addon.restoreHostDisplayConfiguration());
        diagLog.info('supervisor.restoreHostDisplayConfiguration', {
          platform: 'darwin',
          gameId: context?.gameId || '',
          exitCode: context?.exitCode,
          exitSignal: context?.exitSignal || null,
          restored: ok,
        });
        return { restored: ok, method: 'coregraphics_native' };
      } catch (err) {
        diagLog.warn('supervisor.restoreHostDisplayDarwinFailed', err, { gameId: context?.gameId });
      }
    }
    return { restored: false, method: 'darwin_unavailable' };
  }
  if (targetPlatform === 'win32') {
    try {
      const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const psExe = path.win32.join(
        sysRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const restoreScript =
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class OLDisp { [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsExW(string lpszDeviceName, IntPtr lpDevMode, IntPtr hwnd, uint dwflags, IntPtr lParam); }'; [void][OLDisp]::ChangeDisplaySettingsExW($null, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero)";
      const execFileImpl =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : execFile;
      const child = execFileImpl(
        psExe,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', restoreScript],
        { timeout: 4000, windowsHide: true },
        () => {}
      );
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
      diagLog.info('supervisor.restoreHostDisplayConfiguration', {
        platform: 'win32',
        gameId: context?.gameId || '',
        exitCode: context?.exitCode,
        exitSignal: context?.exitSignal || null,
        restored: true,
      });
      return { restored: true, method: 'win32_change_display_settings' };
    } catch (err) {
      diagLog.warn('supervisor.restoreHostDisplayWin32Failed', err, { gameId: context?.gameId });
    }
  }
  return { restored: false, method: 'unsupported_platform' };
}

/**
 * Terminate a detached `displayWatcherChild` process tree via `signalSubprocessTree`
 * (`SIGTERM` followed by a delayed `.unref()`'d `SIGKILL` fallback) so `bin/wine` ->
 * `wineloader` -> `one_display_launcher_*.exe --watch-dir` grandchildren are never orphaned
 * (`SUP-04`).
 *
 * @param {any} watcherChild
 * @param {Record<string, any>} [options]
 */
function terminateDisplayWatcherTree(watcherChild, options = {}) {
  if (!watcherChild) return;
  try {
    void signalSubprocessTree(watcherChild, 'SIGTERM', options).catch(() => {});
  } catch {
    try {
      if (typeof watcherChild.kill === 'function') {
        watcherChild.kill('SIGTERM');
      }
    } catch {}
  }
  const pid = Number(watcherChild.pid || 0);
  if (pid > 0 && !isTestEnvironment(options)) {
    const killTimer = setTimeout(() => {
      try {
        void signalSubprocessTree(watcherChild, 'SIGKILL', options).catch(() => {});
      } catch {}
    }, 600);
    if (typeof killTimer.unref === 'function') {
      killTimer.unref();
    }
  }
}

/**
 * Remove temporary per-session Display Scaler INI and status files from disk (`SUP-03`).
 *
 * @param {Array<string | null | undefined>} tempFiles
 */
function cleanupSessionDisplayFiles(tempFiles) {
  if (!Array.isArray(tempFiles)) return;
  for (const tempScalerFile of tempFiles) {
    if (typeof tempScalerFile === 'string' && tempScalerFile) {
      try {
        if (fs.existsSync(tempScalerFile)) {
          fs.unlinkSync(tempScalerFile);
        }
      } catch {}
    }
  }
}

/**
 * Normalize publisher handoff identifiers across both `chainedPublisherLaunchers` and
 * `offlineVaultService` (`'theeaapp'`, `'link2ea'`, `'origin'`, `'eadesktop'`, etc. -> `'ea'`).
 *
 * @param {any} raw
 * @returns {string}
 */
function resolveAnyChainedHandoffId(raw) {
  return normalizeChainedHandoffId(raw) || normalizeVaultChainedHandoffId(raw) || '';
}

/**
 * Normalize a requested compatibility runner string (`'runner_crossover_preview_arm64'`, `'auto'`,
 * `'native'`, etc.) into a canonical runner type (`''` when auto/omitted/native).
 *
 * @param {unknown} rawLayer
 * @returns {string}
 */
function normalizeRequestedCompatibilityLayerType(rawLayer) {
  const s = String(rawLayer || '')
    .trim()
    .toLowerCase();
  if (!s || s === 'auto' || s === 'native') return '';
  if (s === 'runner_crossover_preview_arm64' || s === 'crossover_preview_arm64') {
    return 'crossover_preview_arm64';
  }
  if (s === 'runner_crossover_preview' || s === 'crossover_preview') {
    return 'crossover_preview';
  }
  if (s === 'runner_crossover' || s === 'crossover') {
    return 'crossover';
  }
  if (s === 'runner_wine' || s === 'wine') {
    return 'wine';
  }
  if (s === 'runner_gptk' || s === 'gptk') {
    return 'gptk';
  }
  return s.startsWith('runner_') ? s.slice('runner_'.length) : s;
}

const WINE_KNOWN_PATH_EXT_RE =
  /\.(exe|bat|cmd|com|msi|ini|cfg|conf|json|xml|txt|log|sav|dat|pak|pk3|pk4|wad|bsp|map|bik|smk|mpq|vpk|u|unr|dem|mod|dll|asi|bin|iso)$/i;

/**
 * Universally normalizes an argument or target executable path for Wine execution
 * by converting verified POSIX / relative file paths to canonical Windows backslash paths
 * (`Z:\...` or `C:\...`), while preserving URLs, storefront protocol URIs, Win32 CLI flags,
 * and opaque auth/Base64 tokens untouched.
 *
 * @param {string} rawArg
 * @param {string} [winePrefix]
 * @returns {string}
 */
function normalizeWineArgumentBackslashes(rawArg, winePrefix = '') {
  if (!rawArg || typeof rawArg !== 'string') return rawArg;
  const trimmed = rawArg.trim();
  if (!trimmed) return rawArg;

  // 1. Never modify URLs or storefront/custom protocol URIs (`https://...`, `steam://...`, `com.epicgames.launcher://...`, `ms-xbl-...:`)
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ||
    /^(steam|epic|com\.epicgames\.launcher|uplay|origin|ea|link2ea|battlenet|goggalaxy|xbox|ms-xbl-[a-z0-9-]+|mailto):/i.test(
      trimmed
    )
  ) {
    return rawArg;
  }

  // 2. Windows drive path (`C:\Games/SubDir\game.exe` or `D:/Games/bin/app.exe`)
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    if (winePrefix && typeof winePrefix === 'string' && /^[a-zA-Z]:[\\/]/.test(winePrefix.trim())) {
      const normTrimmed = trimmed.replace(/\\/g, '/');
      const normDriveC = `${winePrefix.trim().replace(/\\/g, '/').replace(/\/+$/, '')}/drive_c`;
      if (
        normTrimmed.toLowerCase() === normDriveC.toLowerCase() ||
        normTrimmed.toLowerCase().startsWith(`${normDriveC.toLowerCase()}/`)
      ) {
        const converted = toWineWindowsPath(trimmed, winePrefix);
        return converted ? converted.replace(/\//g, '\\') : trimmed.replace(/\//g, '\\');
      }
    }
    return trimmed.replace(/\//g, '\\');
  }

  // 3. Win32 UNC path (`\\server\share\game.exe`)
  if (trimmed.startsWith('\\\\')) {
    return trimmed;
  }

  // 4. CLI switch with attached value (`-cfg=configs/game.ini`, `/log:logs/game.log`, `-AUTH_PASSWORD=eyJ...`)
  const switchParamMatch = trimmed.match(/^([/-]{1,2}[a-zA-Z0-9_.-]+[:=])(.+)$/);
  if (switchParamMatch) {
    const prefix = switchParamMatch[1];
    const paramVal = switchParamMatch[2];
    const normalizedVal = normalizeWineArgumentBackslashes(paramVal, winePrefix);
    return normalizedVal === paramVal ? rawArg : `${prefix}${normalizedVal}`;
  }

  // 5. Single-segment Win32/POSIX CLI switches (`/nosplash`, `/w`, `-windowed`, `+connect`)
  if (/^[/-][a-zA-Z0-9_?.-]+$/.test(trimmed) || trimmed.startsWith('+')) {
    return rawArg;
  }

  // 6. Absolute POSIX path: convert ONLY when inside `winePrefix`, existing on disk (or parent dir exists),
  // or ending in a known game/config file extension (prevents mangling `/api/v1` or Base64 strings starting with `/`).
  if (trimmed.startsWith('/') && trimmed.includes('/', 1)) {
    const firstSeg = trimmed.slice(1, trimmed.indexOf('/', 1));
    if (!firstSeg.includes(':')) {
      const normalizedPrefix = winePrefix ? path.resolve(winePrefix) : '';
      const resolvedCandidate = path.resolve(trimmed);
      const insidePrefix = Boolean(
        normalizedPrefix &&
          (resolvedCandidate === normalizedPrefix ||
            resolvedCandidate.startsWith(normalizedPrefix + path.sep))
      );
      let existsOrParentExists = false;
      try {
        existsOrParentExists =
          fs.existsSync(trimmed) || fs.existsSync(path.dirname(trimmed));
      } catch {}
      if (insidePrefix || existsOrParentExists || WINE_KNOWN_PATH_EXT_RE.test(trimmed)) {
        const converted = toWineWindowsPath(trimmed, winePrefix);
        return converted ? converted.replace(/\//g, '\\') : trimmed.replace(/\//g, '\\');
      }
    }
    return rawArg;
  }

  // 7. Relative path with forward slashes (`./bin/game.exe`, `../data/level.map`, `System/game.exe`):
  // Require explicit `./` or `../` prefix, a known file extension, or existence on disk so Base64/JWT tokens (`abc/def+ghi=`) are untouched.
  if (!trimmed.startsWith('-') && !trimmed.startsWith('/') && trimmed.includes('/')) {
    const looksLikeExplicitRelPath =
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      WINE_KNOWN_PATH_EXT_RE.test(trimmed);
    const looksLikeBase64OrToken =
      !trimmed.includes(' ') &&
      (/[+=]$/.test(trimmed) || /[A-Za-z0-9+/]{24,}/.test(trimmed)) &&
      !WINE_KNOWN_PATH_EXT_RE.test(trimmed);
    if (!looksLikeBase64OrToken && looksLikeExplicitRelPath) {
      return trimmed.replace(/\//g, '\\');
    }
  }

  return rawArg;
}

/** @type {Map<string, string>} */
const liveBottleDaemonEnvContractByPrefix = new Map();

/** @type {Map<string, 'silent' | 'standard'>} */
const liveBottleSteamUiModeByPrefix = new Map();

const DISPLAY_SCALER_ENV_KEYS = Object.freeze([
  'ONE_LAUNCHER_DISPLAY_SCALING_MODE',
  'ONE_LAUNCHER_DISPLAY_ASPECT',
  'ONE_LAUNCHER_SAFE_INSET_TOP',
  'ONE_LAUNCHER_FULLSCREEN_HOTKEY',
  'ONE_LAUNCHER_SCALER_DLL_X86',
  'ONE_LAUNCHER_SCALER_DLL_X64',
  'ONE_LAUNCHER_LAUNCHER_EXE_X86',
  'ONE_LAUNCHER_LAUNCHER_EXE_X64',
  'ONE_LAUNCHER_DISPLAY_CONTROL_FILE',
  'ONE_LAUNCHER_DISPLAY_STATUS_FILE',
]);

const CONTRACT_EXCLUDED_CUSTOM_ENV_KEYS = new Set([
  ...DISPLAY_SCALER_ENV_KEYS,
  'WINEPREFIX',
  'CX_BOTTLE',
  'SteamAppId',
  'SteamGameId',
]);

const DISPLAY_MODE_CHANGED_ERR_TOKEN = 'err:system:display_mode_changed';
const DISPLAY_MODE_EMULATION_RECOMMENDATION =
  'Enable Display Mode Emulation (EmulateModeset) in Launch Configuration';

/**
 * Extract a single key's unquoted value from a CrossOver shellword-encoded `CX_ENV` string.
 *
 * @param {unknown} rawCxEnv
 * @param {string} targetKey
 * @returns {string}
 */
function extractKeyFromCxEnv(rawCxEnv, targetKey) {
  const str = String(rawCxEnv || '').trim();
  if (!str || !targetKey) return '';
  let i = 0;
  let foundValue = '';
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i += 1;
    if (i >= str.length) break;
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
    const eqIdx = unquoted.indexOf('=');
    if (eqIdx > 0 && unquoted.slice(0, eqIdx).trim() === targetKey) {
      foundValue = unquoted.slice(eqIdx + 1).trim();
    }
  }
  return foundValue;
}

/**
 * Normalize a Wine/CrossOver bottle prefix path into a canonical lookup key.
 *
 * @param {any} bottlePath
 * @returns {string}
 */
function normalizeBottlePrefixContractKey(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string' || !bottlePath.trim()) return '';
  let resolved = path.resolve(bottlePath.trim());
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch {}
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Clear any recorded warm bottle daemon graphics contract and Steam UI mode for `bottlePath`.
 *
 * @param {any} bottlePath
 */
function deleteBottleDaemonEnvContract(bottlePath) {
  const key = normalizeBottlePrefixContractKey(bottlePath);
  if (key) {
    liveBottleDaemonEnvContractByPrefix.delete(key);
    liveBottleSteamUiModeByPrefix.delete(key);
  }
  if (bottlePath && typeof bottlePath === 'string' && bottlePath.trim()) {
    const rawNorm = path
      .resolve(bottlePath.trim())
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    liveBottleDaemonEnvContractByPrefix.delete(rawNorm);
    liveBottleSteamUiModeByPrefix.delete(rawNorm);
  }
}

/**
 * Inspect the currently recorded warm Bottle Steam UI mode (`'silent' | 'standard'`) for `prefix`.
 *
 * @param {string} prefix
 * @returns {'silent' | 'standard' | undefined}
 */
function getLiveBottleSteamUiMode(prefix) {
  const key = normalizeBottlePrefixContractKey(prefix);
  return key ? liveBottleSteamUiModeByPrefix.get(key) : undefined;
}

/**
 * Record the warm Bottle Steam UI visibility mode (`'silent' | 'standard'`) for `prefix`.
 *
 * @param {string} prefix
 * @param {'silent' | 'standard' | null | undefined} mode
 */
function setLiveBottleSteamUiMode(prefix, mode) {
  const key = normalizeBottlePrefixContractKey(prefix);
  if (!key) return;
  if (mode === 'silent' || mode === 'standard') {
    liveBottleSteamUiModeByPrefix.set(key, mode);
  } else {
    liveBottleSteamUiModeByPrefix.delete(key);
  }
}

/**
 * Compute canonical graphics, HUD, sync, DLL override, preload & custom-env contract for a
 * bottled session so warm daemons (`Steam.exe`) booted under an incompatible environment can
 * be recycled cleanly when and only when inherited game settings actually change.
 *
 * @param {Record<string, any> | null | undefined} envObj
 * @param {Record<string, any> | null | undefined} [customUserEnv]
 * @returns {string}
 */
function computeBottleGraphicsEnvContract(envObj, customUserEnv = null) {
  const src = envObj && typeof envObj === 'object' ? envObj : {};
  const dyldFromEnv =
    String(src.DYLD_INSERT_LIBRARIES || '').trim() ||
    extractKeyFromCxEnv(src.CX_ENV, 'DYLD_INSERT_LIBRARIES');
  /** @type {Record<string, string>} */
  const sortedCustomEnv = {};
  if (customUserEnv && typeof customUserEnv === 'object') {
    for (const k of Object.keys(customUserEnv).sort()) {
      if (!k || CONTRACT_EXCLUDED_CUSTOM_ENV_KEYS.has(k)) {
        continue;
      }
      sortedCustomEnv[k] = String(customUserEnv[k] ?? '').trim();
    }
  }
  return JSON.stringify({
    backend: String(src.CX_GRAPHICS_BACKEND || 'auto').trim().toLowerCase(),
    backendVer: String(src.CX_GRAPHICS_BACKEND_VERSION || '').trim(),
    d3dmMetalFx: String(src.D3DM_ENABLE_METALFX || '0').trim(),
    dxmtNvext: String(src.DXMT_ENABLE_NVEXT || '0').trim(),
    spatial: String(src.DXMT_METALFX_SPATIAL_SWAPCHAIN || '0').trim(),
    dxmtCfg: String(src.DXMT_CONFIG || '').trim(),
    dxvkCfg: String(src.DXVK_CONFIG || '').trim(),
    avx: src.ROSETTA_ADVERTISE_AVX ?? 'unset',
    msync: String(src.WINEMSYNC || '1').trim(),
    fexX87: String(src.FEX_X87REDUCEDPRECISION || 'unset').trim(),
    mtlHud: String(src.MTL_HUD_ENABLED || '0').trim(),
    dxvkHud: String(src.DXVK_HUD || '').trim(),
    dxvkFps: String(src.DXVK_FRAME_RATE || '').trim(),
    d3dmFps: String(src.D3DM_MAX_FPS || '').trim(),
    wineDll: String(src.WINEDLLOVERRIDES || '').trim(),
    dyldPreload: dyldFromEnv,
    audioClamp: String(src.ONE_LAUNCHER_AUDIO_BUFFER_CLAMP || '').trim(),
    customEnv: sortedCustomEnv,
  });
}

/**
 * Inspect the currently recorded warm daemon graphics contract for `bottlePath` (if any).
 *
 * @param {string} bottlePath
 * @returns {string | undefined}
 */
function getLiveBottleDaemonEnvContract(bottlePath) {
  const key = normalizeBottlePrefixContractKey(bottlePath);
  return key ? liveBottleDaemonEnvContractByPrefix.get(key) : undefined;
}

/**
 * Reset bottle display controller warm daemon contract & Steam UI mode maps.
 */
function resetBottleDisplayControllerState() {
  liveBottleDaemonEnvContractByPrefix.clear();
  liveBottleSteamUiModeByPrefix.clear();
}

/**
 * Reset in-memory supervisor daemon contract tracking for deterministic isolated tests.
 */
/** @type {Set<{ record: Record<string, any>, options: Record<string, any> }>} */
const activePostExitCloudUploadJobs = new Set();

function resetSupervisorStateForTests() {
  resetBottleDisplayControllerState();
  inFlightLaunchesByGameId.clear();
  inFlightLaunchAbortControllers.clear();
  activePostExitCloudUploadJobs.clear();
}

/**
 * Strip ONLY `DISPLAY_SCALER_ENV_KEYS` from a storefront client env (`steam.exe` Stage 1 / Stage 2)
 * and its `CX_ENV` string, preserving HUD (`MTL_HUD_ENABLED`, `DXVK_HUD`), graphics backend
 * (`CX_GRAPHICS_BACKEND`), and `DYLD_INSERT_LIBRARIES` (`libone_metal_preload.dylib`) so child
 * games inherit them cleanly while `--watch-dir` + `active_session.ini` manages Display Scaler.
 *
 * @param {Record<string, any> | null | undefined} envObj
 * @returns {Record<string, any> | null | undefined}
 */
function stripDisplayScalerEnvFromClientEnv(envObj) {
  if (!envObj || typeof envObj !== 'object') return envObj;
  for (const dispKey of DISPLAY_SCALER_ENV_KEYS) {
    delete envObj[dispKey];
  }
  if (typeof envObj.CX_ENV === 'string' && envObj.CX_ENV) {
    const cleaned = stripKeysFromCxEnv(envObj.CX_ENV, [...DISPLAY_SCALER_ENV_KEYS]);
    if (cleaned) {
      envObj.CX_ENV = cleaned;
    } else {
      delete envObj.CX_ENV;
    }
  }
  return envObj;
}

const VALID_DISPLAY_ASPECT_MODES = new Set(['preserve_aspect', 'stretch', 'integer']);

/**
 * Resolve a bundled Win32 display scaler helper binary (`one_display_scaler_{x86,x64}.dll` or
 * `one_display_launcher_{x86,x64}.exe`) across dev, unpacked ASAR, and test overrides.
 *
 * @param {string} fileName
 * @param {Record<string, any> | null | undefined} [options]
 * @returns {string}
 */
function resolveBundledDisplayScalerBinPath(fileName, options = {}) {
  if (!fileName || typeof fileName !== 'string') return '';
  const customDir = String(
    options?.displayScalerBinDir || process.env.ONE_LAUNCHER_DISPLAY_SCALER_BIN_DIR || ''
  ).trim();
  const rawLocalBin = path.join(__dirname, '..', '..', 'helpers', 'bin', fileName);
  const unpackedLocalBin = rawLocalBin.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
  const candidates = [
    customDir ? path.join(customDir, fileName) : '',
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          fileName
        )
      : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'helpers', 'bin', fileName) : '',
    unpackedLocalBin !== rawLocalBin ? unpackedLocalBin : '',
    rawLocalBin,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

/**
 * Stage the universal Win32 display scaler DLLs and launcher EXEs into
 * `<targetWinePrefix>/drive_c/ProgramData/OneLauncher/display_scaler/`, copying only when missing
 * or changed so warm launches perform zero redundant disk writes.
 *
 * @param {string} targetWinePrefix
 * @param {Record<string, any> | null | undefined} [options]
 */
function stageBottleDisplayScalerBinaries(targetWinePrefix, options = {}) {
  const stageDirPosix = targetWinePrefix
    ? path.join(targetWinePrefix, 'drive_c', 'ProgramData', 'OneLauncher', 'display_scaler')
    : '';
  const winStageRoot = 'C:\\ProgramData\\OneLauncher\\display_scaler';
  const result = {
    stageDirPosix,
    allPresent: false,
    dllX86Posix: '',
    dllX64Posix: '',
    launcherX86Posix: '',
    launcherX64Posix: '',
    winDllX86: `${winStageRoot}\\one_display_scaler_x86.dll`,
    winDllX64: `${winStageRoot}\\one_display_scaler_x64.dll`,
    winLauncherX86: `${winStageRoot}\\one_display_launcher_x86.exe`,
    winLauncherX64: `${winStageRoot}\\one_display_launcher_x64.exe`,
  };
  if (!stageDirPosix || !fs.existsSync(targetWinePrefix)) {
    return result;
  }

  try {
    fs.mkdirSync(stageDirPosix, { recursive: true });
  } catch {
    return result;
  }

  /** @type {Array<{ prop: 'dllX86Posix' | 'dllX64Posix' | 'launcherX86Posix' | 'launcherX64Posix', fileName: string }>} */
  const specs = [
    { prop: 'dllX86Posix', fileName: 'one_display_scaler_x86.dll' },
    { prop: 'dllX64Posix', fileName: 'one_display_scaler_x64.dll' },
    { prop: 'launcherX86Posix', fileName: 'one_display_launcher_x86.exe' },
    { prop: 'launcherX64Posix', fileName: 'one_display_launcher_x64.exe' },
  ];

  for (const { prop, fileName } of specs) {
    const srcPath = resolveBundledDisplayScalerBinPath(fileName, options);
    const dstPath = path.join(stageDirPosix, fileName);
    if (!srcPath) {
      try {
        if (fs.existsSync(dstPath) && fs.statSync(dstPath).isFile()) {
          result[prop] = dstPath;
        }
      } catch {}
      continue;
    }
    try {
      const srcStat = fs.statSync(srcPath);
      let needsCopy = true;
      if (fs.existsSync(dstPath)) {
        try {
          const dstStat = fs.statSync(dstPath);
          if (
            dstStat.isFile() &&
            dstStat.size === srcStat.size &&
            Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1000
          ) {
            needsCopy = false;
          }
        } catch {}
      }
      if (needsCopy) {
        const tmpDst = `${dstPath}.tmp-${process.pid}-${Date.now()}`;
        fs.copyFileSync(srcPath, tmpDst);
        try {
          fs.chmodSync(tmpDst, 0o755);
        } catch {}
        try {
          fs.utimesSync(tmpDst, srcStat.atime, srcStat.mtime);
        } catch {}
        fs.renameSync(tmpDst, dstPath);
      }
      result[prop] = dstPath;
    } catch {}
  }

  result.allPresent = Boolean(
    result.dllX86Posix &&
      result.dllX64Posix &&
      result.launcherX86Posix &&
      result.launcherX64Posix
  );
  return result;
}

/**
 * Compute top notch safe-area inset (`0..80` px) on the primary macOS display so borderless
 * fullscreen viewports never clip HUD text under MacBook Pro/Air camera housings.
 *
 * @param {boolean} [highResMode]
 * @param {Record<string, any> | null | undefined} [options]
 * @returns {number}
 */
function computeMacPrimaryDisplaySafeInsetTop(highResMode = false, options = {}) {
  if (typeof options?.safeInsetTop === 'number' && Number.isFinite(options.safeInsetTop)) {
    return Math.max(0, Math.min(80, Math.round(options.safeInsetTop)));
  }
  try {
    const electronMod = getElectron();
    const primary = electronMod?.screen?.getPrimaryDisplay?.();
    if (primary && primary.bounds && primary.workArea) {
      const boundsY = Number(primary.bounds.y) || 0;
      const workAreaY = Number(primary.workArea.y) || 0;
      const topMenuHeight = boundsY === 0 ? Math.max(0, workAreaY - boundsY) : 0;
      const notchLogical = topMenuHeight > 28 ? topMenuHeight : 0;
      if (notchLogical <= 0) return 0;
      const scale = highResMode ? Math.max(1, Number(primary.scaleFactor) || 1) : 1;
      return Math.max(0, Math.min(80, Math.round(notchLogical * scale)));
    }
  } catch {}
  return 0;
}

/**
 * Decide whether a bottled macOS session should wrap with `one_display_launcher`:
 * - `'windowed'` / `'virtual_desktop'` -> never wrap (`false`)
 * - `'force_fullscreen'` -> always wrap (`true`)
 * - `'auto_fullscreen'` -> skip modern 64-bit self-scaling D3D11/D3D12/Vulkan/SDL2+ titles so
 *   D3DMetal/DXMT/MoltenVK run unhooked; wrap all 32-bit, legacy DDraw/D3D8/D3D9, OpenGL, GDI,
 *   SDL1, and launcher-stub titles (`true`).
 *
 * @param {Record<string, any> | null | undefined} effectiveCaps
 * @param {string} effectiveDisplayScalingMode
 * @param {string} [launchArgsStr]
 * @returns {boolean}
 */
function shouldWrapBottleSessionWithDisplayLauncher(
  effectiveCaps,
  effectiveDisplayScalingMode,
  launchArgsStr = ''
) {
  if (
    effectiveDisplayScalingMode === 'windowed' ||
    effectiveDisplayScalingMode === 'virtual_desktop' ||
    effectiveDisplayScalingMode === 'off'
  ) {
    return false;
  }
  if (effectiveDisplayScalingMode === 'force_fullscreen') {
    return true;
  }
  if (
    effectiveDisplayScalingMode !== 'auto_fullscreen' &&
    effectiveDisplayScalingMode !== 'auto'
  ) {
    return false;
  }
  const forceGlCore = /(?:^|\s)(?:-force-glcore\d*|-opengl\d*)\b/i.test(
    String(launchArgsStr || effectiveCaps?.launchArguments || '')
  );
  const isModernUnity64 = Boolean(
    effectiveCaps &&
      !effectiveCaps.is32Bit &&
      effectiveCaps.is64Bit &&
      effectiveCaps.importsUnityPlayer &&
      !forceGlCore
  );
  const isModernMultiRenderer64 = Boolean(
    effectiveCaps &&
      !effectiveCaps.is32Bit &&
      effectiveCaps.is64Bit &&
      (effectiveCaps.usesModernGraphicsApi ||
        effectiveCaps.importsD3d12 ||
        effectiveCaps.importsD3d11Or10 ||
        effectiveCaps.importsVulkan) &&
      !forceGlCore
  );
  const effectiveUsesOpenGl = Boolean(
    effectiveCaps?.usesOpenGl && !isModernUnity64 && !isModernMultiRenderer64
  );
  const isModernSelfScaling64Bit = Boolean(
    effectiveCaps &&
      !effectiveCaps.is32Bit &&
      effectiveCaps.is64Bit &&
      (effectiveCaps.usesModernGraphicsApi ||
        effectiveCaps.importsD3d12 ||
        effectiveCaps.importsD3d11Or10 ||
        effectiveCaps.importsVulkan ||
        effectiveCaps.importsModernSdl ||
        isModernUnity64) &&
      !effectiveCaps.usesLegacyDirectDrawOrD3d &&
      !effectiveUsesOpenGl &&
      !effectiveCaps.importsSdl1 &&
      !effectiveCaps.isLauncherStubCandidate
  );
  return !isModernSelfScaling64Bit;
}

/**
 * Format the `display_ctl_<sessionId>.ini` control file consumed by `one_display_scaler`.
 * Interface Contract 1: display_ctl writes safe_inset_top = 0 under universal fullscreen.
 * Preserves the exact 4-line contract whenever `userOverride` is omitted or matches `(seq > 1)`.
 *
 * @param {number} seq
 * @param {boolean} fullscreen
 * @param {string} aspect
 * @param {number} [safeInsetTop=0]
 * @param {boolean} [userOverride]
 * @returns {string}
 */
function formatDisplayScalerControlIni(seq, fullscreen, aspect, safeInsetTop = 0, userOverride) {
  const safeSeq = Math.max(1, Math.floor(Number(seq) || 1));
  const safeAspect = VALID_DISPLAY_ASPECT_MODES.has(aspect) ? aspect : 'preserve_aspect';
  let safe_inset_top = 0;
  if (typeof safeInsetTop === 'number' && Number.isFinite(safeInsetTop)) {
    safe_inset_top = Math.max(0, Math.min(80, Math.round(safeInsetTop)));
  }
  const base = `seq=${safeSeq}\nfullscreen=${fullscreen ? 1 : 0}\naspect=${safeAspect}\nsafe_inset_top=${safe_inset_top}\n`;
  if (typeof userOverride === 'boolean' && userOverride !== (safeSeq > 1)) {
    return `${base}user_override=${userOverride ? 1 : 0}\n`;
  }
  return base;
}

let lastActiveSessionManifestMs = 0;

/**
 * Atomically write `active_session.ini` in `<drive_c>/ProgramData/OneLauncher/display_scaler/` so
 * child processes whose parent stripped `ONE_LAUNCHER_*` environment variables can self-discover
 * the active display scaler configuration alongside `one_display_scaler_{x86,x64}.dll`.
 *
 * @param {string} stageDirPosix
 * @param {{
 *   seq: number,
 *   mode: string,
 *   aspect: string,
 *   filter?: string,
 *   safeInsetTop?: number,
 *   hotkey?: boolean | number,
 *   controlFileWin: string,
 *   statusFileWin: string,
 * }} params
 */
function writeActiveDisplaySessionManifestIni(stageDirPosix, params) {
  if (!stageDirPosix || !params) return;
  const safeSeq = Math.max(1, Math.floor(Number(params.seq) || 1));
  const safeMode = String(params.mode || 'auto_fullscreen').trim() || 'auto_fullscreen';
  const safeAspect = VALID_DISPLAY_ASPECT_MODES.has(params.aspect)
    ? params.aspect
    : 'preserve_aspect';
  const safeFilter = String(params.filter || 'sharp_bilinear').trim() || 'sharp_bilinear';
  const safeInsetTop =
    typeof params.safeInsetTop === 'number' && Number.isFinite(params.safeInsetTop)
      ? Math.max(0, Math.min(80, Math.round(params.safeInsetTop)))
      : 0;
  const hotkeyVal =
    params.hotkey === false || params.hotkey === 0 ? 0 : 1;
  const updatedUnixMs = Math.max(Date.now(), lastActiveSessionManifestMs + 1);
  lastActiveSessionManifestMs = updatedUnixMs;
  const lines = [
    `seq=${safeSeq}`,
    `mode=${safeMode}`,
    `aspect=${safeAspect}`,
    `filter=${safeFilter}`,
    `safe_inset_top=${safeInsetTop}`,
    `hotkey=${hotkeyVal}`,
    `control_file=${String(params.controlFileWin || '')}`,
    `status_file=${String(params.statusFileWin || '')}`,
    `updated_unix_ms=${updatedUnixMs}`,
    '',
  ];
  atomicWriteFileSync(path.join(stageDirPosix, 'active_session.ini'), lines.join('\n'));
}

/**
 * Attach bidirectional polling of `display_status_<sessionId>.json` so in-game `Ctrl+Option+F`
 * hotkey toggles synchronize back to `entry.session.fullscreenActive` and UI listeners.
 *
 * @param {any} entry
 * @param {Record<string, any>} [options]
 */
function attachBottleDisplayStatusPoller(entry, options = {}) {
  if (
    !entry ||
    !entry.displayStatusFilePosix ||
    (isTestEnvironment(options) && options.enableDisplayStatusSyncInTests !== true)
  ) {
    return;
  }
  const statusPollMs = Math.max(100, Number(options.displayStatusPollMs) || 600);
  const statusTimer = setInterval(() => {
    if (entry.finalized || !entry.displayStatusFilePosix) {
      clearInterval(statusTimer);
      return;
    }
    try {
      if (!fs.existsSync(entry.displayStatusFilePosix)) return;
      const st = fs.statSync(entry.displayStatusFilePosix);
      if (!st.isFile() || st.mtimeMs <= (entry.lastObservedDisplayStatusMtimeMs || 0)) {
        return;
      }
      entry.lastObservedDisplayStatusMtimeMs = st.mtimeMs;
      const parsed = JSON.parse(fs.readFileSync(entry.displayStatusFilePosix, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      let updated = false;
      if (
        typeof parsed.fullscreen === 'boolean' &&
        parsed.fullscreen !== entry.session.fullscreenActive
      ) {
        entry.session.fullscreenActive = parsed.fullscreen;
        updated = true;
      }
      if (
        typeof parsed.aspect === 'string' &&
        VALID_DISPLAY_ASPECT_MODES.has(parsed.aspect) &&
        parsed.aspect !== entry.session.displayAspectRatio
      ) {
        entry.session.displayAspectRatio = parsed.aspect;
        updated = true;
      }
      if (updated) {
        emitSessionUpdated(
          {
            session: { ...entry.session },
            event: 'fullscreen_updated',
          },
          options
        );
      }
    } catch {}
  }, statusPollMs);
  if (typeof statusTimer.unref === 'function') {
    statusTimer.unref();
  }
  entry.displayStatusTimer = statusTimer;
}

/**
 * Clean background storefront daemon (`GalaxyClient.exe` / `EpicGamesLauncher.exe`) wake env so
 * game-specific HUD overlays and 32-bit auto-routed `CX_GRAPHICS_BACKEND` overrides never pollute
 * 64-bit background CEF/client helper processes.
 *
 * @param {Record<string, any>} clientEnv
 * @param {Record<string, any> | null | undefined} launchConfig
 */
function sanitizeBottleBackgroundClientWakeEnv(clientEnv, launchConfig) {
  if (!clientEnv || typeof clientEnv !== 'object') return;
  delete clientEnv.MTL_HUD_ENABLED;
  delete clientEnv.DXVK_HUD;
  delete clientEnv.ONE_LAUNCHER_MOLTENVK_PATH;
  if (typeof clientEnv.DYLD_INSERT_LIBRARIES === 'string' && clientEnv.DYLD_INSERT_LIBRARIES) {
    const remainingInsert = splitDyldInsertLibraries(clientEnv.DYLD_INSERT_LIBRARIES).filter(
      (s) => s && !s.endsWith('libone_metal_preload.dylib')
    );
    if (remainingInsert.length > 0) {
      clientEnv.DYLD_INSERT_LIBRARIES = remainingInsert.join(':');
    } else {
      delete clientEnv.DYLD_INSERT_LIBRARIES;
    }
  }
  const keysToStrip = ['MTL_HUD_ENABLED', 'DXVK_HUD', ...DISPLAY_SCALER_ENV_KEYS];
  for (const dispKey of DISPLAY_SCALER_ENV_KEYS) {
    delete clientEnv[dispKey];
  }
  if (
    (launchConfig?.crossoverGraphicsBackend === undefined ||
      launchConfig?.crossoverGraphicsBackend === 'auto') &&
    !launchConfig?.environmentVariables?.CX_GRAPHICS_BACKEND
  ) {
    delete clientEnv.CX_GRAPHICS_BACKEND;
    delete clientEnv.WINED3DMETAL;
    keysToStrip.push('CX_GRAPHICS_BACKEND', 'WINED3DMETAL');
  }
  const hasCustomUserDyldInsert = Boolean(
    typeof launchConfig?.environmentVariables?.DYLD_INSERT_LIBRARIES === 'string' &&
      launchConfig.environmentVariables.DYLD_INSERT_LIBRARIES.trim()
  );
  if (
    !hasCustomUserDyldInsert ||
    (typeof clientEnv.CX_ENV === 'string' &&
      clientEnv.CX_ENV.includes('libone_metal_preload.dylib'))
  ) {
    keysToStrip.push('DYLD_INSERT_LIBRARIES');
  }
  if (typeof clientEnv.CX_ENV === 'string' && clientEnv.CX_ENV) {
    let cleaned = stripKeysFromCxEnv(clientEnv.CX_ENV, keysToStrip);
    if (
      hasCustomUserDyldInsert &&
      typeof clientEnv.DYLD_INSERT_LIBRARIES === 'string' &&
      clientEnv.DYLD_INSERT_LIBRARIES.trim() &&
      keysToStrip.includes('DYLD_INSERT_LIBRARIES')
    ) {
      const escapedVal = clientEnv.DYLD_INSERT_LIBRARIES.includes(' ')
        ? `'${clientEnv.DYLD_INSERT_LIBRARIES.replace(/'/g, "'\\''")}'`
        : clientEnv.DYLD_INSERT_LIBRARIES;
      cleaned = cleaned
        ? `${cleaned} DYLD_INSERT_LIBRARIES=${escapedVal}`
        : `DYLD_INSERT_LIBRARIES=${escapedVal}`;
    }
    if (cleaned) {
      clientEnv.CX_ENV = cleaned;
    } else {
      delete clientEnv.CX_ENV;
    }
  }
}

/**
 * Backward-compatible wrapper routing to the single authoritative `applyUnifiedPerformanceHudEnv`
 * implementation in `macNativeInstallerAndCodesign.cjs`.
 *
 * @param {any} chosenLayer
 * @param {Record<string, any>} env
 * @param {Record<string, any> | null | undefined} launchConfig
 * @param {Record<string, any> | null | undefined} options
 * @param {string} [gameId]
 */
function applyMoltenVkMetalHudDeadlockGuard(chosenLayer, env, launchConfig, options, gameId = '') {
  return applyUnifiedPerformanceHudEnv({
    env,
    launchConfig: launchConfig || {},
    chosenLayer,
    backend: env?.CX_GRAPHICS_BACKEND || launchConfig?.crossoverGraphicsBackend || '',
    platform: options?.platform || process.platform,
    useCompatLayer: Boolean(chosenLayer),
    wineBinaryPath: chosenLayer?.binaryPath || '',
    options: options || {},
    gameId,
    respectExistingEnvMetalHud: true,
    syncCxEnv: true,
  });
}

/**
 * Append a game `stderr` chunk to `entry.stderrBuffer` and count `err:system:display_mode_changed`
 * occurrences across chunk boundaries on bottled launches.
 *
 * @param {any} entry
 * @param {any} chunk
 */
function recordBottledStderrChunk(entry, chunk) {
  const text = String(chunk ?? '');
  if (!text || !entry) return;
  if (entry.stderrBuffer.length < 4096) {
    entry.stderrBuffer += text;
  }
  const isBottled = Boolean(
    entry.winePrefix ||
      entry.wineBinary ||
      String(entry.session?.launchMethod || '').startsWith('compatibility_layer')
  );
  if (!isBottled) return;
  const combined = `${entry.stderrCarryover || ''}${text}`.toLowerCase();
  let idx = 0;
  while (true) {
    const found = combined.indexOf(DISPLAY_MODE_CHANGED_ERR_TOKEN, idx);
    if (found === -1) break;
    entry.displayModeChangedErrorCount = Number(entry.displayModeChangedErrorCount || 0) + 1;
    idx = found + DISPLAY_MODE_CHANGED_ERR_TOKEN.length;
  }
  const carryStart = Math.max(idx, combined.length - (DISPLAY_MODE_CHANGED_ERR_TOKEN.length - 1));
  entry.stderrCarryover = combined.slice(carryStart);
}

/** @type {Map<string, boolean>} */
const crossOverWaitChildrenSupportCache = new Map();

/**
 * Check whether a CrossOver `wine` Perl wrapper supports `--wait-children`.
 *
 * @param {string} binaryPath
 * @returns {boolean}
 */
function doesCrossOverBinarySupportWaitChildren(binaryPath) {
  if (!binaryPath || typeof binaryPath !== 'string') return false;
  if (crossOverWaitChildrenSupportCache.has(binaryPath)) {
    return Boolean(crossOverWaitChildrenSupportCache.get(binaryPath));
  }
  let supported = false;
  let fd = null;
  try {
    fd = fs.openSync(binaryPath, 'r');
    const buf = Buffer.alloc(8192);
    const readBytes = fs.readSync(fd, buf, 0, 8192, 0);
    if (readBytes > 0) {
      supported = buf.subarray(0, readBytes).toString('latin1').includes('wait-children');
    }
  } catch {
    supported = false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  setBoundedMapEntry(crossOverWaitChildrenSupportCache, binaryPath, supported, 64);
  return supported;
}

const APP_LOCAL_PROXY_DLL_ALLOWLIST = [
  'winmm.dll',
  'ddraw.dll',
  'dinput.dll',
  'dinput8.dll',
  'dsound.dll',
  'd3d8.dll',
  'd3d9.dll',
  'version.dll',
  'wsock32.dll',
];

/**
 * Discover validated app-local proxy/wrapper DLLs (`winmm.dll`, `ddraw.dll`, `dinput8.dll`, etc.)
 * across candidate game directories so Wine/CrossOver loads them (`native,builtin`) instead of
 * shadowing them with builtin system DLLs.
 *
 * @param {string[]} candidateDirs
 * @param {string} effectiveMachine
 * @param {Record<string, any>} [options]
 */
function discoverValidatedAppLocalProxyDllOverrides(
  candidateDirs,
  effectiveMachine = 'unknown',
  options = {}
) {
  /** @type {Record<string, string>} */
  const appDefaultsMap = {};
  /** @type {string[]} */
  const envSpecs = [];
  const seenDirs = new Set();

  for (const rawDir of candidateDirs) {
    if (!rawDir || typeof rawDir !== 'string') continue;
    const resolvedDir = path.resolve(rawDir);
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);
    let entries = [];
    try {
      if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) continue;
      entries = fs.readdirSync(resolvedDir).slice(0, 192);
    } catch {
      continue;
    }
    const lowerMap = new Map();
    for (const name of entries) {
      lowerMap.set(name.toLowerCase(), name);
    }
    for (const proxyDll of APP_LOCAL_PROXY_DLL_ALLOWLIST) {
      const matchedName = lowerMap.get(proxyDll);
      if (!matchedName) continue;
      const stem = proxyDll.slice(0, -4);
      if (appDefaultsMap[stem]) continue;

      const dllPath = path.join(resolvedDir, matchedName);
      const pe = inspectWindowsExecutableHeader(dllPath, {
        strictPe: Boolean(options?.strictPe),
      });
      if (!pe.isValidPe) continue;
      if (!pe.isSyntheticStub && effectiveMachine && effectiveMachine !== 'unknown') {
        if (effectiveMachine === 'x86' && !pe.isX86) continue;
        if (effectiveMachine === 'x64' && !pe.isX64) continue;
      }
      if (hasMalformedBackslashExportForwarder(dllPath)) continue;

      appDefaultsMap[stem] = 'native,builtin';
      envSpecs.push(`${stem}=n,b`);
    }
  }

  return {
    hasOverrides: envSpecs.length > 0,
    envOverrideSpec: envSpecs.join(';'),
    appDefaultsMap,
  };
}

/**
 * Dynamically toggle or update fullscreen state & aspect ratio on an active bottled macOS game
 * session without restarting the game (`seq=<N>\nfullscreen=0|1\naspect=...\n`).
 *
 * @param {any} payload
 * @param {Record<string, any>} [options]
 */
function toggleSessionFullscreen(payload = {}, options = {}) {
  try {
    const reqObj =
      typeof payload === 'string'
        ? { gameId: payload, sessionId: payload }
        : payload && typeof payload === 'object'
          ? payload
          : {};
    /** @type {any} */
    let targetEntry = null;
    if (reqObj.gameId && activeSessions.has(reqObj.gameId)) {
      targetEntry = activeSessions.get(reqObj.gameId);
    } else {
      for (const [, entry] of activeSessions.entries()) {
        if (
          (reqObj.sessionId && entry.session?.sessionId === reqObj.sessionId) ||
          (reqObj.gameId &&
            (entry.session?.gameId === String(reqObj.gameId) ||
              entry.session?.platformGameId === String(reqObj.gameId)))
        ) {
          targetEntry = entry;
          break;
        }
      }
    }

    if (!targetEntry || targetEntry.finalized || !targetEntry.session) {
      return {
        success: false,
        error: 'No active running game session found.',
      };
    }

    const isBottled = Boolean(targetEntry.session.isBottledSession || targetEntry.winePrefix);
    if (!isBottled) {
      return {
        success: false,
        sessionId: targetEntry.session.sessionId,
        gameId: targetEntry.session.gameId,
        error: 'Live fullscreen toggle is only supported for bottled macOS sessions.',
      };
    }

    const nextFullscreen =
      typeof reqObj.fullscreen === 'boolean'
        ? reqObj.fullscreen
        : !Boolean(targetEntry.session.fullscreenActive);
    const nextAspect =
      typeof reqObj.aspectRatio === 'string' && VALID_DISPLAY_ASPECT_MODES.has(reqObj.aspectRatio)
        ? reqObj.aspectRatio
        : String(targetEntry.session.displayAspectRatio || 'preserve_aspect');

    const nextSeq = (Number(targetEntry.displayControlSeq) || 1) + 1;
    targetEntry.displayControlSeq = nextSeq;

    const mergedOpts = {
      ...(targetEntry.launchOptions || {}),
      ...(options || {}),
    };

    const targetPrefix = String(targetEntry.winePrefix || '').trim();
    let controlFilePosix = String(targetEntry.displayControlFilePosix || '').trim();
    if (!controlFilePosix && targetPrefix && fs.existsSync(targetPrefix)) {
      const stageDir = path.join(
        targetPrefix,
        'drive_c',
        'ProgramData',
        'OneLauncher',
        'display_scaler'
      );
      try {
        fs.mkdirSync(stageDir, { recursive: true });
        controlFilePosix = path.join(
          stageDir,
          `display_ctl_${targetEntry.session.sessionId}.ini`
        );
        targetEntry.displayControlFilePosix = controlFilePosix;
      } catch {}
    }

    if (controlFilePosix) {
      try {
        atomicWriteFileSync(
          controlFilePosix,
          formatDisplayScalerControlIni(nextSeq, nextFullscreen, nextAspect)
        );
        const toggleStageDir = path.dirname(controlFilePosix);
        const sessionIdForIni = String(targetEntry.session.sessionId || '');
        const activeSessionMode =
          nextFullscreen && targetEntry.session.displayScalingMode === 'force_fullscreen'
            ? 'force_fullscreen'
            : 'auto_fullscreen';
        writeActiveDisplaySessionManifestIni(toggleStageDir, {
          seq: nextSeq,
          mode: activeSessionMode,
          aspect: nextAspect,
          safeInsetTop: 0,
          hotkey: true,
          controlFileWin: `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${sessionIdForIni}.ini`,
          statusFileWin: `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${sessionIdForIni}.json`,
        });
      } catch (/** @type {any} */ writeErr) {
        return {
          success: false,
          sessionId: targetEntry.session.sessionId,
          gameId: targetEntry.session.gameId,
          error: `Failed to write display control file: ${writeErr?.message || String(writeErr)}`,
        };
      }
    }

    if (
      !targetEntry.displayScalerWrapped &&
      !targetEntry.displayWatcherChild &&
      targetPrefix &&
      fs.existsSync(targetPrefix) &&
      targetEntry.wineBinary &&
      targetEntry.installPath &&
      (!isTestEnvironment(mergedOpts) || mergedOpts.enableDisplayScalerInTests === true)
    ) {
      try {
        const staged = stageBottleDisplayScalerBinaries(targetPrefix, mergedOpts);
        const winWatchDir = toWineWindowsPath(targetEntry.installPath, targetPrefix);
        if (staged.allPresent && winWatchDir) {
          const auxEnv = {
            ...(targetEntry.launchEnv || process.env),
            WINEPREFIX: targetPrefix,
            ONE_LAUNCHER_DISPLAY_SCALING_MODE: nextFullscreen ? 'force_fullscreen' : 'auto_fullscreen',
            ONE_LAUNCHER_DISPLAY_ASPECT: nextAspect,
            ONE_LAUNCHER_SAFE_INSET_TOP: '0',
            ONE_LAUNCHER_SCALER_DLL_X86: staged.winDllX86,
            ONE_LAUNCHER_SCALER_DLL_X64: staged.winDllX64,
            ONE_LAUNCHER_LAUNCHER_EXE_X86: staged.winLauncherX86,
            ONE_LAUNCHER_LAUNCHER_EXE_X64: staged.winLauncherX64,
            ONE_LAUNCHER_DISPLAY_CONTROL_FILE: `C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_${targetEntry.session.sessionId}.ini`,
            ONE_LAUNCHER_DISPLAY_STATUS_FILE: `C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_${targetEntry.session.sessionId}.json`,
          };
          const alignedWatch = prepareAlignedAuxBottleWineCommand({
            wineBinary: targetEntry.wineBinary,
            bottlePath: targetPrefix,
            env: auxEnv,
            suppressGuiDialogs: true,
            layerType: targetEntry.chosenCompatLayerType || null,
          });
          const watchSpawnFn = mergedOpts.gameSpawnFn || mergedOpts.spawnFn || spawn;
          const toggleWatchLauncherPosix =
            (targetEntry.is64Bit ? staged.launcherX64Posix : staged.launcherX86Posix) ||
            staged.launcherX64Posix ||
            staged.launcherX86Posix;
          const watcherChild = watchSpawnFn(
            alignedWatch.binaryPath,
            [
              ...(alignedWatch.prefixArgs || []),
              toggleWatchLauncherPosix,
              '--watch-dir',
              winWatchDir,
              '--dll-x86',
              staged.winDllX86,
              '--dll-x64',
              staged.winDllX64,
              '--timeout-ms',
              '15000',
            ],
            {
              cwd: fs.existsSync(targetEntry.installPath) ? targetEntry.installPath : process.cwd(),
              env: alignedWatch.env,
              stdio: 'ignore',
              detached: true,
            }
          );
          if (watcherChild && typeof watcherChild.unref === 'function') {
            watcherChild.unref();
          }
          targetEntry.displayWatcherChild = watcherChild;
          targetEntry.displayScalerWrapped = true;
        }
      } catch {}
    }

    targetEntry.session.fullscreenActive = nextFullscreen;
    targetEntry.session.displayAspectRatio = nextAspect;

    emitSessionUpdated(
      {
        session: { ...targetEntry.session },
        event: 'fullscreen_updated',
      },
      mergedOpts
    );

    return {
      success: true,
      sessionId: targetEntry.session.sessionId,
      gameId: targetEntry.session.gameId,
      fullscreenActive: nextFullscreen,
      displayAspectRatio: nextAspect,
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}


module.exports = {
  resolveAnyChainedHandoffId,
  normalizeRequestedCompatibilityLayerType,
  normalizeWineArgumentBackslashes,
  liveBottleDaemonEnvContractByPrefix,
  liveBottleSteamUiModeByPrefix,
  activePostExitCloudUploadJobs,
  DISPLAY_MODE_CHANGED_ERR_TOKEN,
  DISPLAY_MODE_EMULATION_RECOMMENDATION,
  normalizeBottlePrefixContractKey,
  deleteBottleDaemonEnvContract,
  getLiveBottleSteamUiMode,
  setLiveBottleSteamUiMode,
  computeBottleGraphicsEnvContract,
  getLiveBottleDaemonEnvContract,
  resetBottleDisplayControllerState,
  resetSupervisorStateForTests,
  DISPLAY_SCALER_ENV_KEYS,
  stripDisplayScalerEnvFromClientEnv,
  VALID_DISPLAY_ASPECT_MODES,
  resolveBundledDisplayScalerBinPath,
  stageBottleDisplayScalerBinaries,
  computeMacPrimaryDisplaySafeInsetTop,
  shouldWrapBottleSessionWithDisplayLauncher,
  formatDisplayScalerControlIni,
  writeActiveDisplaySessionManifestIni,
  attachBottleDisplayStatusPoller,
  sanitizeBottleBackgroundClientWakeEnv,
  applyMoltenVkMetalHudDeadlockGuard,
  recordBottledStderrChunk,
  doesCrossOverBinarySupportWaitChildren,
  APP_LOCAL_PROXY_DLL_ALLOWLIST,
  discoverValidatedAppLocalProxyDllOverrides,
  toggleSessionFullscreen,
  restoreHostDisplayConfiguration,
  terminateDisplayWatcherTree,
  cleanupSessionDisplayFiles,
};
