import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  sanitizeLaunchMethod,
  type CompatibilityLayerType,
  type GameLaunchConfig,
  type LauncherPerformanceSettings,
  type StorefrontClientLifecyclePolicy,
  type StorefrontLaunchProfile,
  type WineDebugMode,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';

export const LAUNCH_CONFIGS_STORAGE_KEY = 'one_launcher_game_configs_v1';
export const PERF_SETTINGS_STORAGE_KEY = 'one_launcher_perf_settings_v1';
export const SELECTED_STOREFRONTS_STORAGE_KEY = 'one_launcher_selected_storefronts_v1';

export function sanitizeLegacyCompatLayer(layer?: unknown): CompatibilityLayerType | undefined {
  if (!layer) return undefined;
  if (layer === 'whisky') return 'crossover';
  return layer as CompatibilityLayerType;
}

export function sanitizeStorefrontLifecycleOverride(
  val?: unknown,
  platformId?: StorefrontId | string
): 'default' | StorefrontClientLifecyclePolicy | undefined {
  if (!val) return undefined;
  if (val === 'default_client' && platformId === 'gog') {
    return 'minimal_keep_running';
  }
  if (
    val === 'default' ||
    val === 'minimal_and_close_if_started' ||
    val === 'minimal_keep_running' ||
    val === 'default_client' ||
    val === 'fast_direct_bypass'
  ) {
    return val;
  }
  return 'default';
}

export function sanitizeWineDebugMode(val?: unknown): WineDebugMode | string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function sanitizeGameLaunchConfig(cfg: GameLaunchConfig): GameLaunchConfig {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const nextCfg: GameLaunchConfig = {
    ...cfg,
    launchMethod: sanitizeLaunchMethod(cfg.launchMethod),
    ...(cfg.compatibilityLayer
      ? { compatibilityLayer: sanitizeLegacyCompatLayer(cfg.compatibilityLayer) }
      : {}),
    ...(cfg.storefrontClientLifecycle
      ? {
          storefrontClientLifecycle: sanitizeStorefrontLifecycleOverride(
            cfg.storefrontClientLifecycle
          ),
        }
      : {}),
    ...(cfg.wineDebug !== undefined
      ? { wineDebug: sanitizeWineDebugMode(cfg.wineDebug) }
      : {}),
  };
  if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
    const nextPlatCfgs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
    for (const [platId, p] of Object.entries(cfg.platformConfigs)) {
      if (p) {
        nextPlatCfgs[platId as StorefrontId] = {
          ...p,
          ...(p.launchMethod !== undefined
            ? { launchMethod: sanitizeLaunchMethod(p.launchMethod) }
            : {}),
          ...(p.compatibilityLayer
            ? { compatibilityLayer: sanitizeLegacyCompatLayer(p.compatibilityLayer) }
            : {}),
          ...(p.storefrontClientLifecycle
            ? {
                storefrontClientLifecycle: sanitizeStorefrontLifecycleOverride(
                  p.storefrontClientLifecycle
                ),
              }
            : {}),
          ...(p.wineDebug !== undefined
            ? { wineDebug: sanitizeWineDebugMode(p.wineDebug) }
            : {}),
        };
      }
    }
    nextCfg.platformConfigs = nextPlatCfgs;
  }
  return nextCfg;
}

export function sanitizePerformanceSettings(
  raw?: Partial<LauncherPerformanceSettings> | null
): LauncherPerformanceSettings {
  const base = { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS };
  if (!raw || typeof raw !== 'object') return base;
  return {
    inGameLauncherBehavior:
      raw.inGameLauncherBehavior === 'keep_open' ||
      raw.inGameLauncherBehavior === 'minimize_taskbar' ||
      raw.inGameLauncherBehavior === 'hide_tray_hibernate' ||
      raw.inGameLauncherBehavior === 'zero_renderer_daemon'
        ? raw.inGameLauncherBehavior
        : base.inGameLauncherBehavior,
    postGameLauncherBehavior:
      raw.postGameLauncherBehavior === 'restore_window' ||
      raw.postGameLauncherBehavior === 'stay_minimized' ||
      raw.postGameLauncherBehavior === 'exit_launcher'
        ? raw.postGameLauncherBehavior
        : base.postGameLauncherBehavior,
    pauseBackgroundSyncInGame:
      typeof raw.pauseBackgroundSyncInGame === 'boolean'
        ? raw.pauseBackgroundSyncInGame
        : base.pauseBackgroundSyncInGame,
    pauseDownloadsInGame:
      typeof raw.pauseDownloadsInGame === 'boolean'
        ? raw.pauseDownloadsInGame
        : base.pauseDownloadsInGame,
    storefrontClientLifecycle:
      raw.storefrontClientLifecycle === 'minimal_and_close_if_started' ||
      raw.storefrontClientLifecycle === 'minimal_keep_running' ||
      raw.storefrontClientLifecycle === 'default_client' ||
      raw.storefrontClientLifecycle === 'fast_direct_bypass'
        ? raw.storefrontClientLifecycle
        : base.storefrontClientLifecycle,
    autoShutdownWinePrefixOnExit:
      typeof raw.autoShutdownWinePrefixOnExit === 'boolean'
        ? raw.autoShutdownWinePrefixOnExit
        : base.autoShutdownWinePrefixOnExit,
    suppressWineDebugLogging:
      typeof raw.suppressWineDebugLogging === 'boolean'
        ? raw.suppressWineDebugLogging
        : base.suppressWineDebugLogging,
  };
}

export function extractStorefrontProfile(
  config: Partial<GameLaunchConfig | StorefrontLaunchProfile>,
  _platformId?: StorefrontId
): StorefrontLaunchProfile {
  const profileKeys: (keyof StorefrontLaunchProfile)[] = [
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
    'wineDebug',
    'metalHud',
    'dxvkHud',
    'preLaunchCommand',
    'postExitCommand',
    'inGameLauncherBehavior',
    'storefrontClientLifecycle',
  ];
  const profile: StorefrontLaunchProfile = {};
  for (const key of profileKeys) {
    const val = config[key];
    if (val !== undefined) {
      if (key === 'launchMethod') {
        profile.launchMethod = sanitizeLaunchMethod(val as string);
      } else if (key === 'compatibilityLayer') {
        profile.compatibilityLayer = sanitizeLegacyCompatLayer(val);
      } else if (key === 'storefrontClientLifecycle') {
        profile.storefrontClientLifecycle = sanitizeStorefrontLifecycleOverride(val);
      } else if (key === 'wineDebug') {
        const cleanDebug = sanitizeWineDebugMode(val);
        if (cleanDebug !== undefined) {
          profile.wineDebug = cleanDebug;
        }
      } else {
        (profile as Record<string, unknown>)[key] = val;
      }
    }
  }
  if (profile.wineMsync === true && profile.wineEsync === true) {
    profile.wineEsync = false;
  }
  return profile;
}

export function buildMergedSaveLaunchConfig(
  existing: GameLaunchConfig | undefined,
  config: GameLaunchConfig,
  platformId?: StorefrontId
): GameLaunchConfig {
  const targetPlatformId = platformId || config.preferredPlatformId;
  const profile = extractStorefrontProfile(config, targetPlatformId);

  const mergedPlatformConfigs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
    ...(existing?.platformConfigs || {}),
  };

  if (config.platformConfigs) {
    for (const [platId, p] of Object.entries(config.platformConfigs)) {
      if (p) {
        mergedPlatformConfigs[platId as StorefrontId] = extractStorefrontProfile(
          p,
          platId as StorefrontId
        );
      }
    }
  }

  if (targetPlatformId) {
    mergedPlatformConfigs[targetPlatformId] = profile;
  }

  return {
    gameId: config.gameId,
    ...(targetPlatformId
      ? { preferredPlatformId: targetPlatformId }
      : existing?.preferredPlatformId
        ? { preferredPlatformId: existing.preferredPlatformId }
        : {}),
    launchMethod: sanitizeLaunchMethod(profile.launchMethod),
    ...profile,
    ...(Object.keys(mergedPlatformConfigs).length > 0
      ? { platformConfigs: mergedPlatformConfigs }
      : {}),
  };
}

export function resolveLaunchConfigFromMap(
  configs: Record<string, GameLaunchConfig>,
  gameId: string,
  platformId?: StorefrontId
): GameLaunchConfig | undefined {
  const rawBase = configs[gameId];
  if (!rawBase) return undefined;
  const base = sanitizeGameLaunchConfig(rawBase);

  if (!platformId) {
    if (base.preferredPlatformId && base.platformConfigs?.[base.preferredPlatformId]) {
      const prefProfile = base.platformConfigs[base.preferredPlatformId]!;
      return {
        ...base,
        ...prefProfile,
        launchMethod: sanitizeLaunchMethod(prefProfile.launchMethod || base.launchMethod),
      };
    }
    return base;
  }

  const platProfile = base.platformConfigs?.[platformId];
  if (platProfile) {
    return {
      gameId: base.gameId,
      preferredPlatformId: platformId,
      launchMethod: sanitizeLaunchMethod(platProfile.launchMethod),
      ...platProfile,
      platformConfigs: base.platformConfigs,
    };
  }

  if (base.platformConfigs && Object.keys(base.platformConfigs).length > 0) {
    if (base.preferredPlatformId === platformId) {
      return base;
    }
    return undefined;
  }

  if (!base.preferredPlatformId || base.preferredPlatformId === platformId) {
    return base;
  }
  return undefined;
}

export function reconcileLaunchConfigsWithDisk(
  localConfigs: Record<string, GameLaunchConfig>,
  diskConfigs: Record<string, GameLaunchConfig>,
  mergeDiskEntries = false
): { configs: Record<string, GameLaunchConfig>; changed: boolean } {
  const nextConfigs: Record<string, GameLaunchConfig> = mergeDiskEntries
    ? { ...localConfigs, ...diskConfigs }
    : { ...localConfigs };
  let changed = mergeDiskEntries;

  for (const [gid, localCfg] of Object.entries(nextConfigs)) {
    if (!localCfg) continue;
    const diskCfg = diskConfigs[gid];
    let updatedCfg = localCfg;
    if (updatedCfg.customExecutablePath && (!diskCfg || !diskCfg.customExecutablePath)) {
      const { customExecutablePath: _ce, workingDirectory: _wd, ...rest } = updatedCfg;
      updatedCfg = rest as GameLaunchConfig;
      changed = true;
    }
    if (updatedCfg.platformConfigs) {
      const nextPlatCfgs = { ...updatedCfg.platformConfigs };
      let platChanged = false;
      for (const [platId, platProfile] of Object.entries(nextPlatCfgs)) {
        const diskPlatProfile = diskCfg?.platformConfigs?.[platId as StorefrontId];
        if (platProfile?.customExecutablePath && !diskPlatProfile?.customExecutablePath) {
          const { customExecutablePath: _ce, workingDirectory: _wd, ...restPlat } = platProfile;
          nextPlatCfgs[platId as StorefrontId] = restPlat;
          platChanged = true;
        }
      }
      if (platChanged) {
        updatedCfg = {
          ...updatedCfg,
          platformConfigs: nextPlatCfgs,
        };
        changed = true;
      }
    }
    nextConfigs[gid] = sanitizeGameLaunchConfig(updatedCfg);
  }

  return { configs: nextConfigs, changed };
}

export function loadLocalLaunchConfigsFromStorage(): Record<string, GameLaunchConfig> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(LAUNCH_CONFIGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const sanitized: Record<string, GameLaunchConfig> = {};
        for (const [gid, cfg] of Object.entries(parsed)) {
          if (cfg && typeof cfg === 'object') {
            sanitized[gid] = sanitizeGameLaunchConfig(cfg as GameLaunchConfig);
          }
        }
        return sanitized;
      }
    }
  } catch {}
  return {};
}

export function loadLocalPerformanceSettingsFromStorage(): LauncherPerformanceSettings | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const rawPerf = window.localStorage.getItem(PERF_SETTINGS_STORAGE_KEY);
    if (rawPerf) {
      const parsedPerf = JSON.parse(rawPerf);
      if (parsedPerf && typeof parsedPerf === 'object') {
        return sanitizePerformanceSettings(parsedPerf);
      }
    }
  } catch {}
  return null;
}

export function persistLocalLaunchConfigsToStorage(
  configs: Record<string, GameLaunchConfig>
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(LAUNCH_CONFIGS_STORAGE_KEY, JSON.stringify(configs));
  } catch {}
}

export function persistLocalPerformanceSettingsToStorage(
  settings: LauncherPerformanceSettings
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(PERF_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

const VALID_STOREFRONT_IDS = new Set<StorefrontId>(['steam', 'gog', 'epic', 'custom']);

export function loadSelectedStorefrontsFromStorage(): Record<string, StorefrontId> {
  const storage =
    (typeof window !== 'undefined' && window.localStorage) ||
    (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!storage) return {};
  try {
    const raw = storage.getItem(SELECTED_STOREFRONTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const clean: Record<string, StorefrontId> = {};
    for (const [gameId, platId] of Object.entries(parsed)) {
      if (typeof platId === 'string' && VALID_STOREFRONT_IDS.has(platId as StorefrontId)) {
        clean[gameId] = platId as StorefrontId;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function persistSelectedStorefrontToStorage(
  gameId: string,
  platformId: StorefrontId
): void {
  if (!gameId || !VALID_STOREFRONT_IDS.has(platformId)) return;
  const storage =
    (typeof window !== 'undefined' && window.localStorage) ||
    (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!storage) return;
  try {
    const current = loadSelectedStorefrontsFromStorage();
    if (current[gameId] === platformId) return;
    current[gameId] = platformId;
    storage.setItem(SELECTED_STOREFRONTS_STORAGE_KEY, JSON.stringify(current));
  } catch {}
}

export function clearSelectedStorefrontFromStorage(gameId: string): void {
  if (!gameId) return;
  const storage =
    (typeof window !== 'undefined' && window.localStorage) ||
    (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!storage) return;
  try {
    const current = loadSelectedStorefrontsFromStorage();
    if (!(gameId in current)) return;
    delete current[gameId];
    storage.setItem(SELECTED_STOREFRONTS_STORAGE_KEY, JSON.stringify(current));
  } catch {}
}
