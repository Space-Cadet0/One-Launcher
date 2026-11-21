import {
  resolveWineDebugEnvValue,
  sanitizeBottleDisplayScalingMode,
  sanitizeDisplayAspectRatio,
  sanitizeGameLaunchConfig as sanitizeContractGameLaunchConfig,
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
  sanitizeLaunchMethod,
  sanitizeLauncherPerformanceSettings,
  sanitizeLegacyCompatLayer,
  sanitizeStorefrontLaunchProfile,
  sanitizeStorefrontLifecycleOverride as sanitizeContractStorefrontLifecycleOverride,
  sanitizeVirtualDesktopResolution,
  sanitizeWineDebugMode,
} from '../../contracts/launchConfigSanitizers';
import type {
  GameLaunchConfig,
  LauncherPerformanceSettings,
  StorefrontClientLifecyclePolicy,
  StorefrontLaunchProfile,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';

export {
  resolveWineDebugEnvValue,
  sanitizeBottleDisplayScalingMode,
  sanitizeDisplayAspectRatio,
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
  sanitizeLegacyCompatLayer,
  sanitizeVirtualDesktopResolution,
  sanitizeWineDebugMode,
};

export const LAUNCH_CONFIGS_STORAGE_KEY = 'one_launcher_game_configs_v1';
export const PERF_SETTINGS_STORAGE_KEY = 'one_launcher_perf_settings_v1';
export const SELECTED_STOREFRONTS_STORAGE_KEY = 'one_launcher_selected_storefronts_v1';

function isBottleLaunchProfile(profile?: Partial<StorefrontLaunchProfile> | null): boolean {
  if (!profile || typeof profile !== 'object') return false;
  if (profile.launchMethod === 'compatibility_layer') return true;
  const cleanLayer = sanitizeLegacyCompatLayer(profile.compatibilityLayer);
  if (cleanLayer && cleanLayer !== 'native') return true;
  if (typeof profile.wineBottleName === 'string' && profile.wineBottleName.trim().length > 0) {
    return true;
  }
  if (typeof profile.winePrefixPath === 'string' && profile.winePrefixPath.trim().length > 0) {
    return true;
  }
  return false;
}

export function sanitizeStorefrontLifecycleOverride(
  val?: unknown,
  platformId?: StorefrontId | string
): 'default' | StorefrontClientLifecyclePolicy | undefined {
  const normalized = sanitizeContractStorefrontLifecycleOverride(val);
  if (normalized === 'default_client' && platformId === 'gog') {
    return 'minimal_keep_running';
  }
  return normalized;
}

function applyPlatformLifecycleCoercion<T extends Partial<StorefrontLaunchProfile>>(
  profile: T,
  platformId?: StorefrontId | string
): T {
  if (!profile || typeof profile !== 'object' || !platformId) return profile;
  if (profile.storefrontClientLifecycle === undefined) return profile;
  const effectivePlatformId = isBottleLaunchProfile(profile) ? undefined : platformId;
  const coerced = sanitizeStorefrontLifecycleOverride(
    profile.storefrontClientLifecycle,
    effectivePlatformId
  );
  if (coerced === profile.storefrontClientLifecycle) {
    return profile;
  }
  return {
    ...profile,
    storefrontClientLifecycle: coerced,
  };
}

export function sanitizeGameLaunchConfig(cfg: GameLaunchConfig): GameLaunchConfig {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const sanitized = sanitizeContractGameLaunchConfig(cfg);
  const nextCfg: GameLaunchConfig = applyPlatformLifecycleCoercion(
    sanitized,
    sanitized.preferredPlatformId
  );

  if (nextCfg.platformConfigs && typeof nextCfg.platformConfigs === 'object') {
    const nextPlatCfgs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
    for (const [platId, prof] of Object.entries(nextCfg.platformConfigs)) {
      if (prof && typeof prof === 'object') {
        nextPlatCfgs[platId as StorefrontId] = applyPlatformLifecycleCoercion(prof, platId);
      }
    }
    if (Object.keys(nextPlatCfgs).length > 0) {
      nextCfg.platformConfigs = nextPlatCfgs;
    }
  }

  return nextCfg;
}

export function sanitizePerformanceSettings(
  raw?: Partial<LauncherPerformanceSettings> | null
): LauncherPerformanceSettings {
  return sanitizeLauncherPerformanceSettings(raw);
}

export function extractStorefrontProfile(
  config: Partial<GameLaunchConfig | StorefrontLaunchProfile>,
  platformId?: StorefrontId
): StorefrontLaunchProfile {
  const profile = sanitizeStorefrontLaunchProfile(config);
  return applyPlatformLifecycleCoercion(profile, platformId);
}

export function buildMergedSaveLaunchConfig(
  existing: GameLaunchConfig | undefined,
  config: GameLaunchConfig,
  platformId?: StorefrontId
): GameLaunchConfig {
  const targetPlatformId = platformId || config.preferredPlatformId;
  const profile = extractStorefrontProfile(config, targetPlatformId);

  const mergedPlatformConfigs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
  if (existing?.platformConfigs) {
    for (const [platId, p] of Object.entries(existing.platformConfigs)) {
      if (p) {
        mergedPlatformConfigs[platId as StorefrontId] = extractStorefrontProfile(
          p,
          platId as StorefrontId
        );
      }
    }
  }

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

  return sanitizeGameLaunchConfig({
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
  });
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

let hasLaunchConfigsSnapshot = false;
let launchConfigsStorageRef: Storage | null = null;
let launchConfigsRawSnapshot: string | null = null;
let launchConfigsCachedMap: Record<string, GameLaunchConfig> = {};

let hasPerfSettingsSnapshot = false;
let perfSettingsStorageRef: Storage | null = null;
let perfSettingsRawSnapshot: string | null = null;
let perfSettingsCached: LauncherPerformanceSettings | null = null;

let hasSelectedStorefrontsSnapshot = false;
let selectedStorefrontsStorageRef: Storage | null = null;
let selectedStorefrontsRawSnapshot: string | null = null;
let selectedStorefrontsCachedMap: Record<string, StorefrontId> = {};

let launchConfigStorageListenerAttached = false;

function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean(process.env?.VITEST || process.env?.NODE_ENV === 'test')
    );
  } catch {
    return false;
  }
}

function getSafeLaunchStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function ensureLaunchConfigStorageListener(): void {
  if (launchConfigStorageListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  launchConfigStorageListenerAttached = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === null || e.key === LAUNCH_CONFIGS_STORAGE_KEY) {
      hasLaunchConfigsSnapshot = false;
      launchConfigsRawSnapshot = null;
    }
    if (e.key === null || e.key === PERF_SETTINGS_STORAGE_KEY) {
      hasPerfSettingsSnapshot = false;
      perfSettingsRawSnapshot = null;
    }
    if (e.key === null || e.key === SELECTED_STOREFRONTS_STORAGE_KEY) {
      hasSelectedStorefrontsSnapshot = false;
      selectedStorefrontsRawSnapshot = null;
    }
  });
}

function cloneLaunchConfigsMap(
  source: Record<string, GameLaunchConfig>
): Record<string, GameLaunchConfig> {
  const copy: Record<string, GameLaunchConfig> = {};
  for (const [gid, cfg] of Object.entries(source)) {
    copy[gid] = {
      ...cfg,
      ...(cfg.platformConfigs ? { platformConfigs: { ...cfg.platformConfigs } } : {}),
    };
  }
  return copy;
}

function ensureLaunchConfigsHydrated(): Record<string, GameLaunchConfig> {
  const storage = getSafeLaunchStorage();
  if (!storage) return {};
  ensureLaunchConfigStorageListener();

  if (!isTestEnv() && hasLaunchConfigsSnapshot && launchConfigsStorageRef === storage) {
    return launchConfigsCachedMap;
  }

  try {
    const raw = storage.getItem(LAUNCH_CONFIGS_STORAGE_KEY);
    if (
      hasLaunchConfigsSnapshot &&
      launchConfigsStorageRef === storage &&
      raw === launchConfigsRawSnapshot
    ) {
      // Adopt Blink ExternalString pointer so subsequent checks are O(1) pointer equality
      launchConfigsRawSnapshot = raw;
      return launchConfigsCachedMap;
    }
    launchConfigsStorageRef = storage;
    launchConfigsRawSnapshot = raw;
    hasLaunchConfigsSnapshot = true;
    launchConfigsCachedMap = {};
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const sanitized: Record<string, GameLaunchConfig> = {};
        for (const [gid, cfg] of Object.entries(parsed)) {
          if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
            sanitized[gid] = sanitizeGameLaunchConfig(cfg as GameLaunchConfig);
          }
        }
        launchConfigsCachedMap = sanitized;
      }
    }
    return launchConfigsCachedMap;
  } catch {
    hasLaunchConfigsSnapshot = false;
    launchConfigsRawSnapshot = null;
    launchConfigsCachedMap = {};
    return {};
  }
}

export function getReadonlyLocalLaunchConfigsFromStorage(): Readonly<
  Record<string, GameLaunchConfig>
> {
  return ensureLaunchConfigsHydrated();
}

export function getLaunchConfigFromStorage(
  gameId: string,
  platformId?: StorefrontId
): GameLaunchConfig | undefined {
  if (!gameId) return undefined;
  const map = ensureLaunchConfigsHydrated();
  return resolveLaunchConfigFromMap(map, gameId, platformId);
}

export function loadLocalLaunchConfigsFromStorage(): Record<string, GameLaunchConfig> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  return cloneLaunchConfigsMap(ensureLaunchConfigsHydrated());
}

export function loadLocalPerformanceSettingsFromStorage(): LauncherPerformanceSettings | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const storage = window.localStorage;
  ensureLaunchConfigStorageListener();

  if (!isTestEnv() && hasPerfSettingsSnapshot && perfSettingsStorageRef === storage) {
    return perfSettingsCached ? { ...perfSettingsCached } : null;
  }

  try {
    const rawPerf = storage.getItem(PERF_SETTINGS_STORAGE_KEY);
    if (
      hasPerfSettingsSnapshot &&
      perfSettingsStorageRef === storage &&
      rawPerf === perfSettingsRawSnapshot
    ) {
      perfSettingsRawSnapshot = rawPerf;
      return perfSettingsCached ? { ...perfSettingsCached } : null;
    }
    perfSettingsStorageRef = storage;
    perfSettingsRawSnapshot = rawPerf;
    hasPerfSettingsSnapshot = true;
    perfSettingsCached = null;
    if (rawPerf) {
      const parsedPerf: unknown = JSON.parse(rawPerf);
      if (parsedPerf && typeof parsedPerf === 'object' && !Array.isArray(parsedPerf)) {
        const sanitized = sanitizePerformanceSettings(
          parsedPerf as Partial<LauncherPerformanceSettings>
        );
        perfSettingsCached = sanitized;
        return { ...sanitized };
      }
    }
  } catch {
    hasPerfSettingsSnapshot = false;
    perfSettingsRawSnapshot = null;
    perfSettingsCached = null;
  }
  return null;
}

export function persistLocalLaunchConfigsToStorage(
  configs: Record<string, GameLaunchConfig>
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const storage = window.localStorage;
  ensureLaunchConfigStorageListener();
  try {
    const serialized = JSON.stringify(configs);
    storage.setItem(LAUNCH_CONFIGS_STORAGE_KEY, serialized);
    launchConfigsStorageRef = storage;
    launchConfigsRawSnapshot = isTestEnv() ? serialized : null;
    hasLaunchConfigsSnapshot = true;
    launchConfigsCachedMap = cloneLaunchConfigsMap(configs);
  } catch {}
}

export function persistLocalPerformanceSettingsToStorage(
  settings: LauncherPerformanceSettings
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const storage = window.localStorage;
  ensureLaunchConfigStorageListener();
  try {
    const serialized = JSON.stringify(settings);
    storage.setItem(PERF_SETTINGS_STORAGE_KEY, serialized);
    perfSettingsStorageRef = storage;
    perfSettingsRawSnapshot = isTestEnv() ? serialized : null;
    hasPerfSettingsSnapshot = true;
    perfSettingsCached = { ...settings };
  } catch {}
}

const VALID_STOREFRONT_IDS = new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox', 'custom']);

export function loadSelectedStorefrontsFromStorage(): Record<string, StorefrontId> {
  const storage = getSafeLaunchStorage();
  if (!storage) return {};
  ensureLaunchConfigStorageListener();

  if (
    !isTestEnv() &&
    hasSelectedStorefrontsSnapshot &&
    selectedStorefrontsStorageRef === storage
  ) {
    return { ...selectedStorefrontsCachedMap };
  }

  try {
    const raw = storage.getItem(SELECTED_STOREFRONTS_STORAGE_KEY);
    if (
      hasSelectedStorefrontsSnapshot &&
      selectedStorefrontsStorageRef === storage &&
      raw === selectedStorefrontsRawSnapshot
    ) {
      selectedStorefrontsRawSnapshot = raw;
      return { ...selectedStorefrontsCachedMap };
    }
    selectedStorefrontsStorageRef = storage;
    selectedStorefrontsRawSnapshot = raw;
    hasSelectedStorefrontsSnapshot = true;
    selectedStorefrontsCachedMap = {};
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, StorefrontId> = {};
    for (const [gameId, platId] of Object.entries(parsed)) {
      if (typeof platId === 'string' && VALID_STOREFRONT_IDS.has(platId as StorefrontId)) {
        clean[gameId] = platId as StorefrontId;
      }
    }
    selectedStorefrontsCachedMap = clean;
    return { ...clean };
  } catch {
    hasSelectedStorefrontsSnapshot = false;
    selectedStorefrontsRawSnapshot = null;
    selectedStorefrontsCachedMap = {};
    return {};
  }
}

export function persistSelectedStorefrontToStorage(
  gameId: string,
  platformId: StorefrontId
): void {
  if (!gameId || !VALID_STOREFRONT_IDS.has(platformId)) return;
  const storage = getSafeLaunchStorage();
  if (!storage) return;
  ensureLaunchConfigStorageListener();
  try {
    const current = loadSelectedStorefrontsFromStorage();
    if (current[gameId] === platformId) return;
    current[gameId] = platformId;
    const serialized = JSON.stringify(current);
    storage.setItem(SELECTED_STOREFRONTS_STORAGE_KEY, serialized);
    selectedStorefrontsStorageRef = storage;
    selectedStorefrontsRawSnapshot = isTestEnv() ? serialized : null;
    hasSelectedStorefrontsSnapshot = true;
    selectedStorefrontsCachedMap = { ...current };
  } catch {}
}

export function clearSelectedStorefrontFromStorage(gameId: string): void {
  if (!gameId) return;
  const storage = getSafeLaunchStorage();
  if (!storage) return;
  ensureLaunchConfigStorageListener();
  try {
    const current = loadSelectedStorefrontsFromStorage();
    if (!(gameId in current)) return;
    delete current[gameId];
    const serialized = JSON.stringify(current);
    storage.setItem(SELECTED_STOREFRONTS_STORAGE_KEY, serialized);
    selectedStorefrontsStorageRef = storage;
    selectedStorefrontsRawSnapshot = isTestEnv() ? serialized : null;
    hasSelectedStorefrontsSnapshot = true;
    selectedStorefrontsCachedMap = { ...current };
  } catch {}
}
