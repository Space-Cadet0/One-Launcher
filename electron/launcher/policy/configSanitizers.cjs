// @ts-check
'use strict';

/**
 * Pure, zero-dependency launch configuration & performance settings sanitizers.
 * Strictly mirrored 1:1 with `src/contracts/launchConfigSanitizers.ts` (enforced by Gate 13).
 */

/**
 * @typedef {'auto' | 'direct' | 'storefront_uri' | 'compatibility_layer' | 'custom'} LaunchMethod
 * @typedef {'native' | 'crossover' | 'crossover_preview' | 'crossover_preview_arm64' | 'gptk' | 'wine'} CompatibilityLayerType
 * @typedef {'auto' | 'd3dmetal' | 'dxmt' | 'dxvk' | 'wined3d'} CrossOverGraphicsBackend
 * @typedef {'default' | 'on' | 'off'} PerformanceHudMode
 * @typedef {'off' | 'fixme_err' | 'warn_err' | 'relay'} WineDebugMode
 * @typedef {'minimal_and_close_if_started' | 'minimal_keep_running' | 'default_client' | 'fast_direct_bypass'} StorefrontClientLifecyclePolicy
 * @typedef {'keep_open' | 'minimize_taskbar' | 'hide_tray_hibernate' | 'zero_renderer_daemon'} InGameLauncherBehavior
 * @typedef {'restore_window' | 'stay_minimized' | 'exit_launcher'} PostGameLauncherBehavior
 * @typedef {'auto_fullscreen' | 'force_fullscreen' | 'native_driver' | 'windowed' | 'virtual_desktop'} GlobalBottleDisplayScalingMode
 * @typedef {'default' | GlobalBottleDisplayScalingMode} BottleDisplayScalingMode
 * @typedef {'preserve_aspect' | 'integer' | 'stretch'} GlobalDisplayAspectRatioMode
 * @typedef {'default' | GlobalDisplayAspectRatioMode} DisplayAspectRatioMode
 */

/**
 * Canonical per-storefront launch profile keys in exact lockstep order with
 * `src/contracts/launchConfigSanitizers.ts` (`LAUNCH_PROFILE_KEYS`).
 * @type {readonly string[]}
 */
const LAUNCH_PROFILE_KEYS = Object.freeze([
  'launchMethod',
  'customExecutablePath',
  'workingDirectory',
  'launchArguments',
  'environmentVariables',
  'compatibilityLayer',
  'wineBottleName',
  'winePrefixPath',
  'crossoverGraphicsBackend',
  'crossoverD3DMetalVersion',
  'crossoverHighResolutionMode',
  'crossoverDlss',
  'wineMsync',
  'wineEsync',
  'metalHud',
  'dxvkHud',
  'performanceHud',
  'wineDebug',
  'preferredMaxFrameRate',
  'metalfxSpatialUpscaleFactor',
  'virtualDesktop',
  'virtualDesktopResolution',
  'displayScalingMode',
  'displayAspectRatio',
  'emulateModeset',
  'forceLargeAddressAware',
  'audioBufferClamp',
  'advertiseAvx',
  'inGameLauncherBehavior',
  'storefrontClientLifecycle',
  'preLaunchCommand',
  'postExitCommand',
]);

const DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS = Object.freeze({
  inGameLauncherBehavior: /** @type {InGameLauncherBehavior} */ ('hide_tray_hibernate'),
  postGameLauncherBehavior: /** @type {PostGameLauncherBehavior} */ ('restore_window'),
  pauseBackgroundSyncInGame: true,
  pauseDownloadsInGame: true,
  storefrontClientLifecycle: /** @type {StorefrontClientLifecyclePolicy} */ (
    'minimal_and_close_if_started'
  ),
  autoShutdownWinePrefixOnExit: true,
  suppressWineDebugLogging: true,
  defaultBottleDisplayScalingMode: /** @type {GlobalBottleDisplayScalingMode} */ ('auto_fullscreen'),
  defaultDisplayAspectRatio: /** @type {GlobalDisplayAspectRatioMode} */ ('preserve_aspect'),
  enableFullscreenHotkey: true,
  defaultPerformanceHud: false,
  ignoreLeadingTheWhenSorting: true,
});

/**
 * Canonical translation map from UI `WineDebugMode` enum tokens to valid Wine `WINEDEBUG`
 * environment values.
 * @type {Readonly<Record<WineDebugMode, string>>}
 */
const WINE_DEBUG_MODE_TO_ENV_MAP = Object.freeze({
  off: '-all',
  fixme_err: 'fixme+all,err+all',
  warn_err: 'warn+all,err+all',
  relay: '+relay',
});

/** @type {readonly CompatibilityLayerType[]} */
const VALID_COMPATIBILITY_LAYERS = Object.freeze([
  'native',
  'crossover',
  'crossover_preview',
  'crossover_preview_arm64',
  'gptk',
  'wine',
]);

/** @type {readonly Exclude<LaunchMethod, 'custom'>[]} */
const VALID_LAUNCH_METHODS = Object.freeze([
  'auto',
  'direct',
  'storefront_uri',
  'compatibility_layer',
]);

/** @type {readonly PerformanceHudMode[]} */
const VALID_PERFORMANCE_HUD_MODES = Object.freeze(['default', 'on', 'off']);

/** @type {readonly StorefrontClientLifecyclePolicy[]} */
const VALID_STOREFRONT_LIFECYCLE_POLICIES = Object.freeze([
  'minimal_and_close_if_started',
  'minimal_keep_running',
  'default_client',
  'fast_direct_bypass',
]);

/** @type {readonly InGameLauncherBehavior[]} */
const VALID_IN_GAME_BEHAVIORS = Object.freeze([
  'keep_open',
  'minimize_taskbar',
  'hide_tray_hibernate',
  'zero_renderer_daemon',
]);

/** @type {readonly PostGameLauncherBehavior[]} */
const VALID_POST_GAME_BEHAVIORS = Object.freeze([
  'restore_window',
  'stay_minimized',
  'exit_launcher',
]);

/** @type {readonly GlobalBottleDisplayScalingMode[]} */
const VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES = Object.freeze([
  'auto_fullscreen',
  'force_fullscreen',
  'native_driver',
  'windowed',
  'virtual_desktop',
]);

/** @type {readonly BottleDisplayScalingMode[]} */
const VALID_BOTTLE_DISPLAY_SCALING_MODES = Object.freeze([
  'default',
  ...VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES,
]);

/** @type {readonly GlobalDisplayAspectRatioMode[]} */
const VALID_GLOBAL_DISPLAY_ASPECT_RATIOS = Object.freeze([
  'preserve_aspect',
  'integer',
  'stretch',
]);

/** @type {readonly DisplayAspectRatioMode[]} */
const VALID_DISPLAY_ASPECT_RATIOS = Object.freeze([
  'default',
  ...VALID_GLOBAL_DISPLAY_ASPECT_RATIOS,
]);

/** @type {readonly CrossOverGraphicsBackend[]} */
const VALID_CROSSOVER_GRAPHICS_BACKENDS = Object.freeze([
  'auto',
  'd3dmetal',
  'dxmt',
  'dxvk',
  'wined3d',
]);

/** @type {Set<string>} */
const VALID_COMPAT_LAYER_SET = new Set(VALID_COMPATIBILITY_LAYERS);
/** @type {Set<string>} */
const VALID_LAUNCH_METHOD_SET = new Set(VALID_LAUNCH_METHODS);
/** @type {Set<string>} */
const VALID_PERFORMANCE_HUD_SET = new Set(VALID_PERFORMANCE_HUD_MODES);
/** @type {Set<string>} */
const VALID_STOREFRONT_LIFECYCLE_SET = new Set(VALID_STOREFRONT_LIFECYCLE_POLICIES);
/** @type {Set<string>} */
const VALID_IN_GAME_BEHAVIOR_SET = new Set(VALID_IN_GAME_BEHAVIORS);
/** @type {Set<string>} */
const VALID_POST_GAME_BEHAVIOR_SET = new Set(VALID_POST_GAME_BEHAVIORS);
/** @type {Set<string>} */
const VALID_GLOBAL_SCALING_SET = new Set(VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES);
/** @type {Set<string>} */
const VALID_SCALING_SET = new Set(VALID_BOTTLE_DISPLAY_SCALING_MODES);
/** @type {Set<string>} */
const VALID_GLOBAL_ASPECT_SET = new Set(VALID_GLOBAL_DISPLAY_ASPECT_RATIOS);
/** @type {Set<string>} */
const VALID_ASPECT_SET = new Set(VALID_DISPLAY_ASPECT_RATIOS);
/** @type {Set<string>} */
const VALID_GRAPHICS_BACKEND_SET = new Set(VALID_CROSSOVER_GRAPHICS_BACKENDS);
/** @type {Set<string>} */
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} val
 * @returns {val is Record<string, any>}
 */
function isPlainRecord(val) {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

/**
 * @param {unknown} layer
 * @returns {CompatibilityLayerType | undefined}
 */
function sanitizeLegacyCompatLayer(layer) {
  if (typeof layer !== 'string') return undefined;
  const clean = layer.trim().toLowerCase();
  if (!clean) return undefined;
  if (clean === 'whisky') return 'crossover';
  return VALID_COMPAT_LAYER_SET.has(clean)
    ? /** @type {CompatibilityLayerType} */ (clean)
    : undefined;
}

/**
 * @param {unknown} launchMethod
 * @returns {Exclude<LaunchMethod, 'custom'>}
 */
function sanitizeLaunchMethod(launchMethod) {
  const clean = typeof launchMethod === 'string' ? launchMethod.trim() : '';
  if (!clean || clean === 'custom') {
    return 'auto';
  }
  return VALID_LAUNCH_METHOD_SET.has(clean)
    ? /** @type {Exclude<LaunchMethod, 'custom'>} */ (clean)
    : 'auto';
}

/**
 * @param {unknown} value
 * @returns {StorefrontClientLifecyclePolicy | null}
 */
function normalizeStorefrontClientLifecycle(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (clean === 'shutdown_if_woken') return 'minimal_and_close_if_started';
  if (clean === 'keep_running') return 'minimal_keep_running';
  return VALID_STOREFRONT_LIFECYCLE_SET.has(clean)
    ? /** @type {StorefrontClientLifecyclePolicy} */ (clean)
    : null;
}

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {StorefrontClientLifecyclePolicy}
 */
function sanitizeStorefrontLifecyclePolicy(
  value,
  fallback = 'minimal_and_close_if_started'
) {
  const cleanFallback =
    normalizeStorefrontClientLifecycle(fallback) || 'minimal_and_close_if_started';
  const normalized = normalizeStorefrontClientLifecycle(value);
  return normalized || cleanFallback;
}

/**
 * @param {unknown} value
 * @returns {'default' | StorefrontClientLifecyclePolicy | undefined}
 */
function sanitizeStorefrontLifecycleOverride(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return 'default';
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean === 'default') return 'default';
  return normalizeStorefrontClientLifecycle(clean) || 'default';
}

/**
 * @param {unknown} perGameOverride
 * @param {string} [globalPolicy]
 * @returns {StorefrontClientLifecyclePolicy}
 */
function resolveEffectiveLifecyclePolicy(
  perGameOverride,
  globalPolicy = 'minimal_and_close_if_started'
) {
  const effectiveGlobal = sanitizeStorefrontLifecyclePolicy(
    globalPolicy,
    'minimal_and_close_if_started'
  );
  if (!perGameOverride || perGameOverride === 'default') {
    return effectiveGlobal;
  }
  return sanitizeStorefrontLifecyclePolicy(perGameOverride, effectiveGlobal);
}

/**
 * @param {unknown} value
 * @returns {PerformanceHudMode | undefined}
 */
function sanitizePerformanceHudMode(value) {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().toLowerCase();
  return VALID_PERFORMANCE_HUD_SET.has(clean)
    ? /** @type {PerformanceHudMode} */ (clean)
    : undefined;
}

/**
 * Pure, lossless, idempotent migration from legacy split `metalHud` / `dxvkHud` booleans
 * to the unified `performanceHud` (`'default' | 'on' | 'off'`) setting, recursively migrating
 * nested `platformConfigs` profiles identically across Electron and renderer.
 *
 * @template T
 * @param {T} cfg
 * @returns {T}
 */
function migrateLegacyHudConfig(cfg) {
  if (!isPlainRecord(cfg)) {
    return cfg;
  }
  /** @type {Record<string, any>} */
  const rawRecord = cfg;
  const existing = sanitizePerformanceHudMode(rawRecord.performanceHud);
  /** @type {PerformanceHudMode} */
  const resolvedHud = existing
    ? existing
    : rawRecord.metalHud === true || rawRecord.dxvkHud === true
      ? 'on'
      : 'default';

  let platformConfigsChanged = false;
  /** @type {Record<string, any> | undefined} */
  let nextPlatformConfigs;
  if (isPlainRecord(rawRecord.platformConfigs)) {
    nextPlatformConfigs = {};
    for (const [platId, prof] of Object.entries(rawRecord.platformConfigs)) {
      if (FORBIDDEN_OBJECT_KEYS.has(platId)) {
        platformConfigsChanged = true;
        continue;
      }
      const nextProf = isPlainRecord(prof) ? migrateLegacyHudConfig(prof) : prof;
      if (nextProf !== prof) {
        platformConfigsChanged = true;
      }
      nextPlatformConfigs[platId] = nextProf;
    }
  }

  if (rawRecord.performanceHud === resolvedHud && !platformConfigsChanged) {
    return cfg;
  }

  /** @type {Record<string, any>} */
  const migrated = { ...rawRecord, performanceHud: resolvedHud };
  if (nextPlatformConfigs !== undefined && platformConfigsChanged) {
    migrated.platformConfigs = nextPlatformConfigs;
  }

  return /** @type {T} */ (migrated);
}

/**
 * @param {Record<string, any> | null | undefined} cfg
 * @param {Record<string, any> | null | undefined} perfSettings
 * @returns {boolean}
 */
function resolveEffectivePerformanceHud(cfg, perfSettings) {
  const globalDefault = Boolean(perfSettings && perfSettings.defaultPerformanceHud === true);
  if (!isPlainRecord(cfg)) {
    return globalDefault;
  }
  const migrated = migrateLegacyHudConfig(cfg);
  if (migrated.performanceHud === 'on') return true;
  if (migrated.performanceHud === 'off') return false;
  return globalDefault;
}

/**
 * @param {unknown} val
 * @returns {WineDebugMode | string | undefined}
 */
function sanitizeWineDebugMode(val) {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(WINE_DEBUG_MODE_TO_ENV_MAP, lower)) {
    return /** @type {WineDebugMode} */ (lower);
  }
  return trimmed;
}

/**
 * Translates a `GameLaunchConfig.wineDebug` value into a valid Wine `WINEDEBUG` environment
 * string. Known enum tokens (`'off'`, `'fixme_err'`, `'warn_err'`, `'relay'`) are translated via
 * `WINE_DEBUG_MODE_TO_ENV_MAP`; custom raw Wine debug channel specs are preserved verbatim.
 *
 * @param {unknown} val
 * @returns {string | undefined}
 */
function resolveWineDebugEnvValue(val) {
  const clean = sanitizeWineDebugMode(val);
  if (!clean) return undefined;
  if (Object.prototype.hasOwnProperty.call(WINE_DEBUG_MODE_TO_ENV_MAP, clean)) {
    return WINE_DEBUG_MODE_TO_ENV_MAP[/** @type {WineDebugMode} */ (clean)];
  }
  return clean;
}

/**
 * @param {unknown} val
 * @returns {GlobalBottleDisplayScalingMode}
 */
function sanitizeGlobalBottleDisplayScalingMode(val) {
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (clean === 'off') return 'native_driver';
    if (VALID_GLOBAL_SCALING_SET.has(clean)) {
      return /** @type {GlobalBottleDisplayScalingMode} */ (clean);
    }
  }
  return DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.defaultBottleDisplayScalingMode;
}

/**
 * @param {unknown} val
 * @returns {BottleDisplayScalingMode | undefined}
 */
function sanitizeBottleDisplayScalingMode(val) {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (!clean) return undefined;
    if (clean === 'off') return 'native_driver';
    if (VALID_SCALING_SET.has(clean)) {
      return /** @type {BottleDisplayScalingMode} */ (clean);
    }
  }
  return 'default';
}

/**
 * @param {unknown} val
 * @returns {GlobalDisplayAspectRatioMode}
 */
function sanitizeGlobalDisplayAspectRatio(val) {
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (VALID_GLOBAL_ASPECT_SET.has(clean)) {
      return /** @type {GlobalDisplayAspectRatioMode} */ (clean);
    }
  }
  return DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.defaultDisplayAspectRatio;
}

/**
 * @param {unknown} val
 * @returns {DisplayAspectRatioMode | undefined}
 */
function sanitizeDisplayAspectRatio(val) {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (!clean) return undefined;
    if (VALID_ASPECT_SET.has(clean)) {
      return /** @type {DisplayAspectRatioMode} */ (clean);
    }
  }
  return 'default';
}

/**
 * @param {unknown} val
 * @returns {string | undefined}
 */
function sanitizeVirtualDesktopResolution(val) {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'auto' || /^\d{3,5}x\d{3,5}$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * @param {unknown} val
 * @returns {CrossOverGraphicsBackend | undefined}
 */
function sanitizeCrossOverGraphicsBackend(val) {
  if (typeof val !== 'string') return undefined;
  const clean = val.trim().toLowerCase();
  return VALID_GRAPHICS_BACKEND_SET.has(clean)
    ? /** @type {CrossOverGraphicsBackend} */ (clean)
    : undefined;
}

/**
 * @param {Record<string, any> | null | undefined} cfg
 * @param {Record<string, any> | null | undefined} perfSettings
 * @returns {GlobalBottleDisplayScalingMode}
 */
function resolveEffectiveDisplayScalingMode(cfg, perfSettings) {
  const sanitizedPerGame = sanitizeBottleDisplayScalingMode(cfg && cfg.displayScalingMode);
  if (sanitizedPerGame && sanitizedPerGame !== 'default') {
    return sanitizedPerGame;
  }
  if (cfg && cfg.virtualDesktop === true) {
    return 'virtual_desktop';
  }
  return sanitizeGlobalBottleDisplayScalingMode(
    perfSettings && perfSettings.defaultBottleDisplayScalingMode
  );
}

/**
 * @param {Record<string, any> | null | undefined} cfg
 * @param {Record<string, any> | null | undefined} perfSettings
 * @returns {GlobalDisplayAspectRatioMode}
 */
function resolveEffectiveDisplayAspectRatio(cfg, perfSettings) {
  const sanitizedPerGame = sanitizeDisplayAspectRatio(cfg && cfg.displayAspectRatio);
  if (sanitizedPerGame && sanitizedPerGame !== 'default') {
    return sanitizedPerGame;
  }
  return sanitizeGlobalDisplayAspectRatio(perfSettings && perfSettings.defaultDisplayAspectRatio);
}

/**
 * @param {Record<string, any> | null | undefined} raw
 */
function sanitizeLauncherPerformanceSettings(raw) {
  const base = { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS };
  if (!isPlainRecord(raw)) return base;

  const rawInGame = typeof raw.inGameLauncherBehavior === 'string' ? raw.inGameLauncherBehavior : '';
  const rawPostGame =
    typeof raw.postGameLauncherBehavior === 'string' ? raw.postGameLauncherBehavior : '';
  const normLifecycle = normalizeStorefrontClientLifecycle(raw.storefrontClientLifecycle);
  const hasLegacyHudFlag =
    typeof raw.enableMetalHud === 'boolean' || typeof raw.enableMangoHud === 'boolean';
  const legacyHudDefault = raw.enableMetalHud === true || raw.enableMangoHud === true;

  return {
    inGameLauncherBehavior: VALID_IN_GAME_BEHAVIOR_SET.has(rawInGame)
      ? /** @type {InGameLauncherBehavior} */ (rawInGame)
      : base.inGameLauncherBehavior,
    postGameLauncherBehavior: VALID_POST_GAME_BEHAVIOR_SET.has(rawPostGame)
      ? /** @type {PostGameLauncherBehavior} */ (rawPostGame)
      : base.postGameLauncherBehavior,
    pauseBackgroundSyncInGame:
      typeof raw.pauseBackgroundSyncInGame === 'boolean'
        ? raw.pauseBackgroundSyncInGame
        : base.pauseBackgroundSyncInGame,
    pauseDownloadsInGame:
      typeof raw.pauseDownloadsInGame === 'boolean'
        ? raw.pauseDownloadsInGame
        : base.pauseDownloadsInGame,
    storefrontClientLifecycle: normLifecycle || base.storefrontClientLifecycle,
    autoShutdownWinePrefixOnExit:
      typeof raw.autoShutdownWinePrefixOnExit === 'boolean'
        ? raw.autoShutdownWinePrefixOnExit
        : base.autoShutdownWinePrefixOnExit,
    suppressWineDebugLogging:
      typeof raw.suppressWineDebugLogging === 'boolean'
        ? raw.suppressWineDebugLogging
        : base.suppressWineDebugLogging,
    defaultBottleDisplayScalingMode: sanitizeGlobalBottleDisplayScalingMode(
      raw.defaultBottleDisplayScalingMode
    ),
    defaultDisplayAspectRatio: sanitizeGlobalDisplayAspectRatio(raw.defaultDisplayAspectRatio),
    enableFullscreenHotkey:
      typeof raw.enableFullscreenHotkey === 'boolean'
        ? raw.enableFullscreenHotkey
        : base.enableFullscreenHotkey,
    defaultPerformanceHud:
      typeof raw.defaultPerformanceHud === 'boolean'
        ? raw.defaultPerformanceHud
        : hasLegacyHudFlag
          ? legacyHudDefault
          : base.defaultPerformanceHud,
    ignoreLeadingTheWhenSorting:
      typeof raw.ignoreLeadingTheWhenSorting === 'boolean'
        ? raw.ignoreLeadingTheWhenSorting
        : base.ignoreLeadingTheWhenSorting,
  };
}

/**
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Record<string, any>}
 */
function sanitizeStorefrontLaunchProfile(raw) {
  if (!isPlainRecord(raw)) return { performanceHud: 'default' };
  /** @type {Record<string, any>} */
  const profile = {};

  for (const key of LAUNCH_PROFILE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const val = raw[key];
    if (val === undefined || val === null) continue;

    if (key === 'launchMethod') {
      profile.launchMethod = sanitizeLaunchMethod(val);
    } else if (key === 'compatibilityLayer') {
      const cleanLayer = sanitizeLegacyCompatLayer(val);
      if (cleanLayer !== undefined) {
        profile.compatibilityLayer = cleanLayer;
      }
    } else if (key === 'crossoverGraphicsBackend') {
      const cleanBackend = sanitizeCrossOverGraphicsBackend(val);
      if (cleanBackend !== undefined) {
        profile.crossoverGraphicsBackend = cleanBackend;
      }
    } else if (key === 'storefrontClientLifecycle') {
      const cleanLifecycle = sanitizeStorefrontLifecycleOverride(val);
      if (cleanLifecycle !== undefined) {
        profile.storefrontClientLifecycle = cleanLifecycle;
      }
    } else if (key === 'performanceHud') {
      const cleanHud = sanitizePerformanceHudMode(val);
      if (cleanHud !== undefined) {
        profile.performanceHud = cleanHud;
      }
    } else if (key === 'wineDebug') {
      const cleanDebug = sanitizeWineDebugMode(val);
      if (cleanDebug !== undefined) {
        profile.wineDebug = cleanDebug;
      }
    } else if (key === 'displayScalingMode') {
      const cleanMode = sanitizeBottleDisplayScalingMode(val);
      if (cleanMode !== undefined) {
        profile.displayScalingMode = cleanMode;
      }
    } else if (key === 'displayAspectRatio') {
      const cleanAspect = sanitizeDisplayAspectRatio(val);
      if (cleanAspect !== undefined) {
        profile.displayAspectRatio = cleanAspect;
      }
    } else if (key === 'virtualDesktopResolution') {
      const cleanVdRes = sanitizeVirtualDesktopResolution(val);
      if (cleanVdRes !== undefined) {
        profile.virtualDesktopResolution = cleanVdRes;
      }
    } else if (key === 'inGameLauncherBehavior') {
      if (val === 'default' || (typeof val === 'string' && VALID_IN_GAME_BEHAVIOR_SET.has(val))) {
        profile.inGameLauncherBehavior = val;
      }
    } else if (key === 'environmentVariables') {
      if (isPlainRecord(val)) {
        /** @type {Record<string, string>} */
        const cleanEnv = {};
        for (const [envKey, envVal] of Object.entries(val)) {
          if (FORBIDDEN_OBJECT_KEYS.has(envKey)) continue;
          if (typeof envVal === 'string') {
            cleanEnv[envKey] = envVal;
          }
        }
        profile.environmentVariables = cleanEnv;
      }
    } else {
      profile[key] = val;
    }
  }

  if (profile.wineMsync === true && profile.wineEsync === true) {
    profile.wineEsync = false;
  }

  return migrateLegacyHudConfig(profile);
}

/**
 * @param {Record<string, any>} cfg
 * @returns {Record<string, any>}
 */
function sanitizeGameLaunchConfig(cfg) {
  if (!isPlainRecord(cfg)) return cfg;
  const cleanRoot = sanitizeStorefrontLaunchProfile(cfg);
  /** @type {Record<string, any>} */
  const nextCfg = {
    ...cleanRoot,
    gameId: typeof cfg.gameId === 'string' ? cfg.gameId : '',
    launchMethod: sanitizeLaunchMethod(cfg.launchMethod),
    ...(typeof cfg.preferredPlatformId === 'string' && cfg.preferredPlatformId.trim()
      ? { preferredPlatformId: cfg.preferredPlatformId.trim() }
      : {}),
  };

  if (isPlainRecord(cfg.platformConfigs)) {
    /** @type {Record<string, any>} */
    const nextPlatCfgs = {};
    for (const [platId, prof] of Object.entries(cfg.platformConfigs)) {
      if (FORBIDDEN_OBJECT_KEYS.has(platId)) continue;
      if (isPlainRecord(prof)) {
        nextPlatCfgs[platId] = sanitizeStorefrontLaunchProfile(prof);
      }
    }
    if (Object.keys(nextPlatCfgs).length > 0) {
      nextCfg.platformConfigs = nextPlatCfgs;
    }
  }

  return nextCfg;
}

module.exports = {
  LAUNCH_PROFILE_KEYS,
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  WINE_DEBUG_MODE_TO_ENV_MAP,
  VALID_COMPATIBILITY_LAYERS,
  VALID_LAUNCH_METHODS,
  VALID_PERFORMANCE_HUD_MODES,
  VALID_STOREFRONT_LIFECYCLE_POLICIES,
  VALID_IN_GAME_BEHAVIORS,
  VALID_POST_GAME_BEHAVIORS,
  VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES,
  VALID_BOTTLE_DISPLAY_SCALING_MODES,
  VALID_GLOBAL_DISPLAY_ASPECT_RATIOS,
  VALID_DISPLAY_ASPECT_RATIOS,
  VALID_CROSSOVER_GRAPHICS_BACKENDS,
  sanitizeLegacyCompatLayer,
  sanitizeLaunchMethod,
  normalizeStorefrontClientLifecycle,
  sanitizeStorefrontLifecyclePolicy,
  sanitizeStorefrontLifecycleOverride,
  resolveEffectiveLifecyclePolicy,
  sanitizePerformanceHudMode,
  migrateLegacyHudConfig,
  resolveEffectivePerformanceHud,
  sanitizeWineDebugMode,
  resolveWineDebugEnvValue,
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
  sanitizeDisplayAspectRatio,
  sanitizeVirtualDesktopResolution,
  sanitizeCrossOverGraphicsBackend,
  resolveEffectiveDisplayScalingMode,
  resolveEffectiveDisplayAspectRatio,
  sanitizeLauncherPerformanceSettings,
  sanitizeStorefrontLaunchProfile,
  sanitizeGameLaunchConfig,
};
