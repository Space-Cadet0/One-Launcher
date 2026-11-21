import type {
  BottleDisplayScalingMode,
  CompatibilityLayerType,
  CrossOverGraphicsBackend,
  DisplayAspectRatioMode,
  GameLaunchConfig,
  GlobalBottleDisplayScalingMode,
  GlobalDisplayAspectRatioMode,
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  PerformanceHudMode,
  PostGameLauncherBehavior,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchProfile,
  VirtualDesktopResolutionPreset,
  WineDebugMode,
} from './launcher';
import type { StorefrontId } from './platform';

/**
 * Canonical per-storefront launch profile keys in exact lockstep order with
 * `electron/launcher/policy/configSanitizers.cjs` (verified by Gate 13).
 */
export const LAUNCH_PROFILE_KEYS = [
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
] as const satisfies readonly (keyof StorefrontLaunchProfile)[];

export const DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS: Readonly<LauncherPerformanceSettings> =
  Object.freeze({
    inGameLauncherBehavior: 'hide_tray_hibernate',
    postGameLauncherBehavior: 'restore_window',
    pauseBackgroundSyncInGame: true,
    pauseDownloadsInGame: true,
    storefrontClientLifecycle: 'minimal_and_close_if_started',
    autoShutdownWinePrefixOnExit: true,
    suppressWineDebugLogging: true,
    defaultBottleDisplayScalingMode: 'auto_fullscreen',
    defaultDisplayAspectRatio: 'preserve_aspect',
    enableFullscreenHotkey: true,
    defaultPerformanceHud: false,
    ignoreLeadingTheWhenSorting: true,
  });

/**
 * Canonical translation map from UI `WineDebugMode` enum tokens to valid Wine `WINEDEBUG`
 * environment values. Raw channel expressions (e.g. `'+loaddll,err+all'`, `'-all'`) are
 * preserved verbatim by `resolveWineDebugEnvValue`.
 */
export const WINE_DEBUG_MODE_TO_ENV_MAP: Readonly<Record<WineDebugMode, string>> = Object.freeze({
  off: '-all',
  fixme_err: 'fixme+all,err+all',
  warn_err: 'warn+all,err+all',
  relay: '+relay',
});

export const VALID_COMPATIBILITY_LAYERS: readonly CompatibilityLayerType[] = Object.freeze([
  'native',
  'crossover',
  'crossover_preview',
  'crossover_preview_arm64',
  'gptk',
  'wine',
]);

export const VALID_LAUNCH_METHODS: readonly Exclude<LaunchMethod, 'custom'>[] = Object.freeze([
  'auto',
  'direct',
  'storefront_uri',
  'compatibility_layer',
]);

export const VALID_PERFORMANCE_HUD_MODES: readonly PerformanceHudMode[] = Object.freeze([
  'default',
  'on',
  'off',
]);

export const VALID_STOREFRONT_LIFECYCLE_POLICIES: readonly StorefrontClientLifecyclePolicy[] =
  Object.freeze([
    'minimal_and_close_if_started',
    'minimal_keep_running',
    'default_client',
    'fast_direct_bypass',
  ]);

export const VALID_IN_GAME_BEHAVIORS: readonly InGameLauncherBehavior[] = Object.freeze([
  'keep_open',
  'minimize_taskbar',
  'hide_tray_hibernate',
  'zero_renderer_daemon',
]);

export const VALID_POST_GAME_BEHAVIORS: readonly PostGameLauncherBehavior[] = Object.freeze([
  'restore_window',
  'stay_minimized',
  'exit_launcher',
]);

export const VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES: readonly GlobalBottleDisplayScalingMode[] =
  Object.freeze([
    'auto_fullscreen',
    'force_fullscreen',
    'native_driver',
    'windowed',
    'virtual_desktop',
  ]);

export const VALID_BOTTLE_DISPLAY_SCALING_MODES: readonly BottleDisplayScalingMode[] =
  Object.freeze(['default', ...VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES]);

export const VALID_GLOBAL_DISPLAY_ASPECT_RATIOS: readonly GlobalDisplayAspectRatioMode[] =
  Object.freeze(['preserve_aspect', 'integer', 'stretch']);

export const VALID_DISPLAY_ASPECT_RATIOS: readonly DisplayAspectRatioMode[] = Object.freeze([
  'default',
  ...VALID_GLOBAL_DISPLAY_ASPECT_RATIOS,
]);

export const VALID_CROSSOVER_GRAPHICS_BACKENDS: readonly CrossOverGraphicsBackend[] =
  Object.freeze(['auto', 'd3dmetal', 'dxmt', 'dxvk', 'wined3d']);

const VALID_COMPAT_LAYER_SET = new Set<string>(VALID_COMPATIBILITY_LAYERS);
const VALID_LAUNCH_METHOD_SET = new Set<string>(VALID_LAUNCH_METHODS);
const VALID_PERFORMANCE_HUD_SET = new Set<string>(VALID_PERFORMANCE_HUD_MODES);
const VALID_STOREFRONT_LIFECYCLE_SET = new Set<string>(VALID_STOREFRONT_LIFECYCLE_POLICIES);
const VALID_IN_GAME_BEHAVIOR_SET = new Set<string>(VALID_IN_GAME_BEHAVIORS);
const VALID_POST_GAME_BEHAVIOR_SET = new Set<string>(VALID_POST_GAME_BEHAVIORS);
const VALID_GLOBAL_SCALING_SET = new Set<string>(VALID_GLOBAL_BOTTLE_DISPLAY_SCALING_MODES);
const VALID_SCALING_SET = new Set<string>(VALID_BOTTLE_DISPLAY_SCALING_MODES);
const VALID_GLOBAL_ASPECT_SET = new Set<string>(VALID_GLOBAL_DISPLAY_ASPECT_RATIOS);
const VALID_ASPECT_SET = new Set<string>(VALID_DISPLAY_ASPECT_RATIOS);
const VALID_GRAPHICS_BACKEND_SET = new Set<string>(VALID_CROSSOVER_GRAPHICS_BACKENDS);
const FORBIDDEN_OBJECT_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

export function sanitizeLegacyCompatLayer(layer?: unknown): CompatibilityLayerType | undefined {
  if (typeof layer !== 'string') return undefined;
  const clean = layer.trim().toLowerCase();
  if (!clean) return undefined;
  if (clean === 'whisky') return 'crossover';
  return VALID_COMPAT_LAYER_SET.has(clean) ? (clean as CompatibilityLayerType) : undefined;
}

export function sanitizeLaunchMethod(launchMethod?: unknown): LaunchMethod {
  const clean = typeof launchMethod === 'string' ? launchMethod.trim() : '';
  if (!clean || clean === 'custom') {
    return 'auto';
  }
  return VALID_LAUNCH_METHOD_SET.has(clean) ? (clean as LaunchMethod) : 'auto';
}

export function normalizeStorefrontClientLifecycle(
  value?: unknown
): StorefrontClientLifecyclePolicy | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (clean === 'shutdown_if_woken') return 'minimal_and_close_if_started';
  if (clean === 'keep_running') return 'minimal_keep_running';
  return VALID_STOREFRONT_LIFECYCLE_SET.has(clean)
    ? (clean as StorefrontClientLifecyclePolicy)
    : null;
}

export function sanitizeStorefrontLifecyclePolicy(
  value?: unknown,
  fallback: StorefrontClientLifecyclePolicy = 'minimal_and_close_if_started'
): StorefrontClientLifecyclePolicy {
  const cleanFallback =
    normalizeStorefrontClientLifecycle(fallback) ?? 'minimal_and_close_if_started';
  const normalized = normalizeStorefrontClientLifecycle(value);
  return normalized ?? cleanFallback;
}

export function sanitizeStorefrontLifecycleOverride(
  value?: unknown
): 'default' | StorefrontClientLifecyclePolicy | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return 'default';
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean === 'default') return 'default';
  return normalizeStorefrontClientLifecycle(clean) ?? 'default';
}

export function resolveEffectiveLifecyclePolicy(
  perGameOverride?: 'default' | StorefrontClientLifecyclePolicy | string | null,
  globalPolicy: StorefrontClientLifecyclePolicy | string = 'minimal_and_close_if_started'
): StorefrontClientLifecyclePolicy {
  const effectiveGlobal = sanitizeStorefrontLifecyclePolicy(
    globalPolicy,
    'minimal_and_close_if_started'
  );
  if (!perGameOverride || perGameOverride === 'default') {
    return effectiveGlobal;
  }
  return sanitizeStorefrontLifecyclePolicy(perGameOverride, effectiveGlobal);
}

export function sanitizePerformanceHudMode(value?: unknown): PerformanceHudMode | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().toLowerCase();
  return VALID_PERFORMANCE_HUD_SET.has(clean) ? (clean as PerformanceHudMode) : undefined;
}

/**
 * Pure, lossless, idempotent migration from legacy split `metalHud` / `dxvkHud` booleans
 * to the unified `performanceHud` (`'default' | 'on' | 'off'`) setting, recursively migrating
 * nested `platformConfigs` profiles identically across Electron and renderer.
 */
export function migrateLegacyHudConfig<T extends Partial<StorefrontLaunchProfile>>(
  cfg: T
): T & { performanceHud: PerformanceHudMode } {
  if (!isPlainRecord(cfg)) {
    return cfg as T & { performanceHud: PerformanceHudMode };
  }
  const rawRecord = cfg as Record<string, unknown>;
  const existing = sanitizePerformanceHudMode(rawRecord.performanceHud);
  const resolvedHud: PerformanceHudMode = existing
    ? existing
    : rawRecord.metalHud === true || rawRecord.dxvkHud === true
      ? 'on'
      : 'default';

  let platformConfigsChanged = false;
  let nextPlatformConfigs: Record<string, unknown> | undefined;
  if (isPlainRecord(rawRecord.platformConfigs)) {
    nextPlatformConfigs = {};
    for (const [platId, prof] of Object.entries(rawRecord.platformConfigs)) {
      if (FORBIDDEN_OBJECT_KEYS.has(platId)) {
        platformConfigsChanged = true;
        continue;
      }
      const nextProf = isPlainRecord(prof)
        ? migrateLegacyHudConfig(prof as Partial<StorefrontLaunchProfile>)
        : prof;
      if (nextProf !== prof) {
        platformConfigsChanged = true;
      }
      nextPlatformConfigs[platId] = nextProf;
    }
  }

  if (rawRecord.performanceHud === resolvedHud && !platformConfigsChanged) {
    return cfg as T & { performanceHud: PerformanceHudMode };
  }

  const migrated: Record<string, unknown> = { ...rawRecord, performanceHud: resolvedHud };
  if (nextPlatformConfigs !== undefined && platformConfigsChanged) {
    migrated.platformConfigs = nextPlatformConfigs;
  }

  return migrated as T & { performanceHud: PerformanceHudMode };
}

export function resolveEffectivePerformanceHud(
  cfg?: Partial<StorefrontLaunchProfile> | null,
  perfSettings?: Partial<LauncherPerformanceSettings> | null
): boolean {
  const globalDefault = Boolean(perfSettings && perfSettings.defaultPerformanceHud === true);
  if (!isPlainRecord(cfg)) {
    return globalDefault;
  }
  const migrated = migrateLegacyHudConfig(cfg);
  if (migrated.performanceHud === 'on') return true;
  if (migrated.performanceHud === 'off') return false;
  return globalDefault;
}

export function sanitizeWineDebugMode(val?: unknown): WineDebugMode | string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(WINE_DEBUG_MODE_TO_ENV_MAP, lower)) {
    return lower as WineDebugMode;
  }
  return trimmed;
}

/**
 * Translates a `GameLaunchConfig.wineDebug` value into a valid Wine `WINEDEBUG` environment
 * string. Known enum tokens (`'off'`, `'fixme_err'`, `'warn_err'`, `'relay'`) are translated via
 * `WINE_DEBUG_MODE_TO_ENV_MAP`; custom raw Wine debug channel specs (e.g. `'+loaddll,err+all'`,
 * `'-all'`) are preserved verbatim.
 */
export function resolveWineDebugEnvValue(val?: unknown): string | undefined {
  const clean = sanitizeWineDebugMode(val);
  if (!clean) return undefined;
  if (Object.prototype.hasOwnProperty.call(WINE_DEBUG_MODE_TO_ENV_MAP, clean)) {
    return WINE_DEBUG_MODE_TO_ENV_MAP[clean as WineDebugMode];
  }
  return clean;
}

export function sanitizeGlobalBottleDisplayScalingMode(
  val?: unknown
): GlobalBottleDisplayScalingMode {
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (clean === 'off') return 'native_driver';
    if (VALID_GLOBAL_SCALING_SET.has(clean)) {
      return clean as GlobalBottleDisplayScalingMode;
    }
  }
  return DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.defaultBottleDisplayScalingMode ?? 'auto_fullscreen';
}

export function sanitizeBottleDisplayScalingMode(
  val?: unknown
): BottleDisplayScalingMode | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (!clean) return undefined;
    if (clean === 'off') return 'native_driver';
    if (VALID_SCALING_SET.has(clean)) {
      return clean as BottleDisplayScalingMode;
    }
  }
  return 'default';
}

export function sanitizeGlobalDisplayAspectRatio(val?: unknown): GlobalDisplayAspectRatioMode {
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (VALID_GLOBAL_ASPECT_SET.has(clean)) {
      return clean as GlobalDisplayAspectRatioMode;
    }
  }
  return DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.defaultDisplayAspectRatio ?? 'preserve_aspect';
}

export function sanitizeDisplayAspectRatio(val?: unknown): DisplayAspectRatioMode | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (!clean) return undefined;
    if (VALID_ASPECT_SET.has(clean)) {
      return clean as DisplayAspectRatioMode;
    }
  }
  return 'default';
}

export function sanitizeVirtualDesktopResolution(
  val?: unknown
): VirtualDesktopResolutionPreset | string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'auto' || /^\d{3,5}x\d{3,5}$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

export function sanitizeCrossOverGraphicsBackend(
  val?: unknown
): CrossOverGraphicsBackend | undefined {
  if (typeof val !== 'string') return undefined;
  const clean = val.trim().toLowerCase();
  return VALID_GRAPHICS_BACKEND_SET.has(clean)
    ? (clean as CrossOverGraphicsBackend)
    : undefined;
}

export function resolveEffectiveDisplayScalingMode(
  cfg?: Partial<StorefrontLaunchProfile> | null,
  perfSettings?: Partial<LauncherPerformanceSettings> | null
): GlobalBottleDisplayScalingMode {
  const sanitizedPerGame = sanitizeBottleDisplayScalingMode(cfg?.displayScalingMode);
  if (sanitizedPerGame && sanitizedPerGame !== 'default') {
    return sanitizedPerGame;
  }
  if (cfg?.virtualDesktop === true) {
    return 'virtual_desktop';
  }
  return sanitizeGlobalBottleDisplayScalingMode(perfSettings?.defaultBottleDisplayScalingMode);
}

export function resolveEffectiveDisplayAspectRatio(
  cfg?: Partial<StorefrontLaunchProfile> | null,
  perfSettings?: Partial<LauncherPerformanceSettings> | null
): GlobalDisplayAspectRatioMode {
  const sanitizedPerGame = sanitizeDisplayAspectRatio(cfg?.displayAspectRatio);
  if (sanitizedPerGame && sanitizedPerGame !== 'default') {
    return sanitizedPerGame;
  }
  return sanitizeGlobalDisplayAspectRatio(perfSettings?.defaultDisplayAspectRatio);
}

export function sanitizeLauncherPerformanceSettings(
  raw?: Partial<LauncherPerformanceSettings> | Record<string, unknown> | null
): LauncherPerformanceSettings {
  const base: LauncherPerformanceSettings = { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS };
  if (!isPlainRecord(raw)) return base;

  const rawRec = raw as Record<string, unknown>;
  const rawInGame =
    typeof rawRec.inGameLauncherBehavior === 'string' ? rawRec.inGameLauncherBehavior : '';
  const rawPostGame =
    typeof rawRec.postGameLauncherBehavior === 'string' ? rawRec.postGameLauncherBehavior : '';
  const normLifecycle = normalizeStorefrontClientLifecycle(rawRec.storefrontClientLifecycle);
  const hasLegacyHudFlag =
    typeof rawRec.enableMetalHud === 'boolean' || typeof rawRec.enableMangoHud === 'boolean';
  const legacyHudDefault = rawRec.enableMetalHud === true || rawRec.enableMangoHud === true;

  return {
    inGameLauncherBehavior: VALID_IN_GAME_BEHAVIOR_SET.has(rawInGame)
      ? (rawInGame as InGameLauncherBehavior)
      : base.inGameLauncherBehavior,
    postGameLauncherBehavior: VALID_POST_GAME_BEHAVIOR_SET.has(rawPostGame)
      ? (rawPostGame as PostGameLauncherBehavior)
      : base.postGameLauncherBehavior,
    pauseBackgroundSyncInGame:
      typeof raw.pauseBackgroundSyncInGame === 'boolean'
        ? raw.pauseBackgroundSyncInGame
        : base.pauseBackgroundSyncInGame,
    pauseDownloadsInGame:
      typeof raw.pauseDownloadsInGame === 'boolean'
        ? raw.pauseDownloadsInGame
        : base.pauseDownloadsInGame,
    storefrontClientLifecycle: normLifecycle ?? base.storefrontClientLifecycle,
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
        : (base.enableFullscreenHotkey ?? true),
    defaultPerformanceHud:
      typeof raw.defaultPerformanceHud === 'boolean'
        ? raw.defaultPerformanceHud
        : hasLegacyHudFlag
          ? legacyHudDefault
          : (base.defaultPerformanceHud ?? false),
    ignoreLeadingTheWhenSorting:
      typeof raw.ignoreLeadingTheWhenSorting === 'boolean'
        ? raw.ignoreLeadingTheWhenSorting
        : (base.ignoreLeadingTheWhenSorting ?? true),
  };
}

export function sanitizeStorefrontLaunchProfile(
  raw: Partial<StorefrontLaunchProfile> | Record<string, unknown> | null | undefined
): StorefrontLaunchProfile {
  if (!isPlainRecord(raw)) return { performanceHud: 'default' };
  const profile: Record<string, unknown> = {};

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
        const cleanEnv: Record<string, string> = {};
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

  return migrateLegacyHudConfig(profile as StorefrontLaunchProfile);
}

export function sanitizeGameLaunchConfig(cfg: GameLaunchConfig): GameLaunchConfig {
  if (!isPlainRecord(cfg)) return cfg;
  const cleanRoot = sanitizeStorefrontLaunchProfile(cfg);
  const nextCfg: GameLaunchConfig = {
    ...cleanRoot,
    gameId: typeof cfg.gameId === 'string' ? cfg.gameId : '',
    launchMethod: sanitizeLaunchMethod(cfg.launchMethod),
    ...(typeof cfg.preferredPlatformId === 'string' && cfg.preferredPlatformId.trim()
      ? { preferredPlatformId: cfg.preferredPlatformId.trim() as StorefrontId }
      : {}),
  };

  if (isPlainRecord(cfg.platformConfigs)) {
    const nextPlatCfgs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
    for (const [platId, prof] of Object.entries(cfg.platformConfigs)) {
      if (FORBIDDEN_OBJECT_KEYS.has(platId)) continue;
      if (isPlainRecord(prof)) {
        nextPlatCfgs[platId as StorefrontId] = sanitizeStorefrontLaunchProfile(prof);
      }
    }
    if (Object.keys(nextPlatCfgs).length > 0) {
      nextCfg.platformConfigs = nextPlatCfgs;
    }
  }

  return nextCfg;
}
