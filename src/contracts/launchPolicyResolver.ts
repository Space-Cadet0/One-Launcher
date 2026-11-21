import type {
  BottleDisplayScalingMode,
  CompatibilityLayerType,
  CrossOverGraphicsBackend,
  DisplayAspectRatioMode,
  GlobalBottleDisplayScalingMode,
  GlobalDisplayAspectRatioMode,
  LaunchMethod,
  PerformanceHudMode,
  StorefrontClientLifecyclePolicy,
} from './launcher';
import type { HostArch, HostPlatform } from './hostPlatform';
import type { StorefrontId } from './platform';
import {
  resolveEffectiveDisplayAspectRatio,
  resolveEffectiveDisplayScalingMode,
  resolveEffectiveLifecyclePolicy,
  resolveEffectivePerformanceHud,
  sanitizeCrossOverGraphicsBackend,
  sanitizeLaunchMethod,
  sanitizeLegacyCompatLayer,
} from './launchConfigSanitizers';

export {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  LAUNCH_PROFILE_KEYS,
  WINE_DEBUG_MODE_TO_ENV_MAP,
  migrateLegacyHudConfig,
  normalizeStorefrontClientLifecycle,
  resolveEffectiveDisplayAspectRatio,
  resolveEffectiveDisplayScalingMode,
  resolveEffectiveLifecyclePolicy,
  resolveEffectivePerformanceHud,
  resolveWineDebugEnvValue,
  sanitizeBottleDisplayScalingMode,
  sanitizeCrossOverGraphicsBackend,
  sanitizeDisplayAspectRatio,
  sanitizeGameLaunchConfig,
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
  sanitizeLauncherPerformanceSettings,
  sanitizeLaunchMethod,
  sanitizeLegacyCompatLayer,
  sanitizePerformanceHudMode,
  sanitizeStorefrontLaunchProfile,
  sanitizeStorefrontLifecycleOverride,
  sanitizeStorefrontLifecyclePolicy,
  sanitizeVirtualDesktopResolution,
  sanitizeWineDebugMode,
} from './launchConfigSanitizers';

export type LaunchPolicyBuildType =
  | 'mac_native_app'
  | 'mac_native_bin'
  | 'windows_exe_on_mac'
  | 'windows_native'
  | 'not_installed';

export interface RunnerHostSupportResult {
  supported: boolean;
  reason: string | null;
}

export interface BottleCompatDescriptor {
  name?: string;
  wineArch?: string;
  bottleArch?: string;
}

export interface BottleCompatOptions {
  bottleDetails?: Record<string, { wineArch?: string; bottleArch?: string }>;
  allowCustomNewBottleName?: boolean;
}

export interface ResolveDefaultBottleOptions {
  bottleDetails?: Record<string, { wineArch?: string; bottleArch?: string }>;
  descriptorDefault?: string;
}

export interface ResolveEffectiveLaunchPolicyInput {
  platformId?: StorefrontId | string;
  hostPlatform?: HostPlatform | string;
  hostArch?: HostArch | string;
  detectedBuildType?: LaunchPolicyBuildType;
  isInstalled?: boolean;
  isWindowsBinaryOnMac?: boolean;
  hasExecutable?: boolean;
  hasCustomExecutable?: boolean;
  executablePath?: string;
  installPath?: string;
  configuredLaunchMethod?: LaunchMethod | string;
  compatibilityLayer?: CompatibilityLayerType | string;
  crossoverGraphicsBackend?: CrossOverGraphicsBackend | string;
  displayScalingMode?: BottleDisplayScalingMode | 'off' | string;
  globalDisplayScalingMode?: GlobalBottleDisplayScalingMode | 'off' | string;
  displayAspectRatio?: DisplayAspectRatioMode | string;
  globalDisplayAspectRatio?: GlobalDisplayAspectRatioMode | string;
  virtualDesktop?: boolean;
  performanceHud?: PerformanceHudMode | string;
  metalHud?: boolean;
  dxvkHud?: boolean;
  globalDefaultPerformanceHud?: boolean;
  storefrontClientLifecycle?: 'default' | StorefrontClientLifecyclePolicy | string;
  globalStorefrontLifecycle?: StorefrontClientLifecyclePolicy | string;
  usesGalaxySdk?: boolean;
  isClientlessXboxInstall?: boolean;
}

export interface ResolvedEffectiveLaunchPolicy {
  platformId: StorefrontId;
  hostPlatform: HostPlatform;
  hostArch: HostArch;
  detectedBuildType: LaunchPolicyBuildType;
  isInstalled: boolean;
  isBottleExecution: boolean;
  configuredLaunchMethod: LaunchMethod;
  /** Pipeline method resolved when configuredLaunchMethod === 'auto' */
  autoResolvedMethod: LaunchMethod;
  /** Effective execution method after host/build coercion (e.g. 'direct' -> 'compatibility_layer' on windows_exe_on_mac) */
  effectiveLaunchMethod: LaunchMethod;
  /** Sanitized effective storefront client lifecycle policy */
  effectiveLifecycle: StorefrontClientLifecyclePolicy;
  /** Sanitized requested compatibility layer if specified, or null */
  effectiveCompatibilityLayer: CompatibilityLayerType | null;
  /** True when the requested compatibility layer is supported on the resolved (hostPlatform, hostArch) */
  runnerHostArchSupported: boolean;
  /** Human-readable error message when `runnerHostArchSupported === false`, else null */
  runnerHostArchError: string | null;
  /** Effective sanitized graphics backend ('auto' | 'd3dmetal' | 'dxmt' | 'dxvk' | 'wined3d') */
  effectiveGraphicsBackend: CrossOverGraphicsBackend;
  /** Effective display scaling mode honoring per-game override, 'off' -> 'native_driver', and virtualDesktop */
  effectiveDisplayScalingMode: GlobalBottleDisplayScalingMode;
  /** Effective display aspect ratio mode */
  effectiveDisplayAspectRatio: GlobalDisplayAspectRatioMode;
  /** Effective Performance HUD toggle honoring unified performanceHud, legacy metalHud/dxvkHud, and global default */
  effectivePerformanceHud: boolean;
  /** True only when DXMT MetalFX spatial swapchain upscaling is eligible on this bottle/backend/host */
  supportsMetalfxSpatial: boolean;
  /** True when configuredLaunchMethod === 'direct' was coerced to 'compatibility_layer' on macOS for a Windows PE binary */
  coercedFromDirectToCompat: boolean;
  /** True only when installed, not delegating to storefront URI, non-custom, and fast bypass is active ('direct' or 'fast_direct_bypass') */
  isFastDirectBypass: boolean;
  /** True when execution delegates to external desktop storefront URI protocol (steam://, com.epicgames.launcher://, goggalaxy://) */
  delegatesToStorefrontUri: boolean;
  /** True when execution may start or wake a storefront client process */
  spawnsStorefrontClient: boolean;
  /** True when Steam launch uses silent client (-silent -applaunch on host or bottle steam.exe) before direct binary fallback */
  usesSilentSteamApplaunch: boolean;
  /** True when Epic launch uses clientless EOS OAuth exchange code injection */
  usesClientlessEos: boolean;
  /** True when One Launcher runs standalone pre-launch/post-exit cloud save sync (gogdl / legendary) */
  syncsCloudSavesStandalone: boolean;
}

const VALID_BUILD_TYPES = new Set<LaunchPolicyBuildType>([
  'mac_native_app',
  'mac_native_bin',
  'windows_exe_on_mac',
  'windows_native',
  'not_installed',
]);

const X64_ARCH_RE = /^(x64|ia32|x86_64|x86|intel|amd64)$/i;

function sanitizePlatformId(platformId?: StorefrontId | string): StorefrontId {
  const clean = typeof platformId === 'string' ? platformId.trim().toLowerCase() : '';
  if (
    clean === 'steam' ||
    clean === 'gog' ||
    clean === 'epic' ||
    clean === 'xbox' ||
    clean === 'custom'
  ) {
    return clean;
  }
  return 'custom';
}

function sanitizeHostPlatform(hostPlatform?: HostPlatform | string): HostPlatform {
  const clean = typeof hostPlatform === 'string' ? hostPlatform.trim().toLowerCase() : '';
  if (clean === 'win32' || clean === 'linux' || clean === 'darwin') {
    return clean;
  }
  return 'darwin';
}

function sanitizeHostArch(hostArch: HostArch | string | undefined, hostPlatform: HostPlatform): HostArch {
  const clean = typeof hostArch === 'string' ? hostArch.trim() : '';
  if (clean) {
    return X64_ARCH_RE.test(clean) ? 'x64' : 'arm64';
  }
  return hostPlatform === 'win32' ? 'x64' : 'arm64';
}

/**
 * Canonical host-OS + CPU-architecture compatibility check for a requested compatibility runner.
 * Mirrors `electron/launcher/policy/launchPolicyCore.cjs` 1:1 (enforced by Gate 13).
 */
export function isRunnerSupportedOnHost(
  runnerType?: CompatibilityLayerType | string | null,
  hostPlatform: HostPlatform | string = 'darwin',
  hostArch?: HostArch | string
): RunnerHostSupportResult {
  const cleanPlatform = sanitizeHostPlatform(hostPlatform);
  const cleanArch = sanitizeHostArch(hostArch, cleanPlatform);
  const cleanRunner = sanitizeLegacyCompatLayer(runnerType);

  if (!cleanRunner || cleanRunner === 'native') {
    return { supported: true, reason: null };
  }

  if (cleanRunner === 'crossover_preview_arm64') {
    if (cleanPlatform !== 'darwin') {
      return {
        supported: false,
        reason:
          'CrossOver Preview (arm64 / FEX) is only supported on Apple Silicon (arm64) macOS.',
      };
    }
    if (cleanArch !== 'arm64') {
      return {
        supported: false,
        reason:
          'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64.',
      };
    }
    return { supported: true, reason: null };
  }

  if (cleanRunner === 'gptk') {
    if (cleanPlatform !== 'darwin') {
      return {
        supported: false,
        reason:
          'Apple Game Porting Toolkit is only supported on Apple Silicon (arm64) macOS.',
      };
    }
    if (cleanArch !== 'arm64') {
      return {
        supported: false,
        reason: 'Apple Game Porting Toolkit requires an Apple Silicon (arm64) Mac.',
      };
    }
    return { supported: true, reason: null };
  }

  if (cleanPlatform !== 'darwin') {
    return {
      supported: false,
      reason: `Compatibility runner "${cleanRunner}" is only supported on macOS.`,
    };
  }

  return { supported: true, reason: null };
}

/**
 * Canonical bottle-to-runner architecture compatibility check mirrored 1:1 with
 * `electron/launcher/policy/launchPolicyCore.cjs` (enforced by Gate 13).
 */
export function isBottleCompatibleWithRunner(
  bottleOrName: string | BottleCompatDescriptor | null | undefined,
  runnerType?: CompatibilityLayerType | 'skip' | string | null,
  options: BottleCompatOptions = {}
): boolean {
  const rawName =
    typeof bottleOrName === 'string'
      ? bottleOrName
      : bottleOrName && typeof bottleOrName === 'object'
        ? bottleOrName.name
        : '';
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  if (!trimmed) return false;

  const rawRunner = typeof runnerType === 'string' ? runnerType.trim().toLowerCase() : '';
  if (!rawRunner || rawRunner === 'skip') return true;
  const effectiveRunner = sanitizeLegacyCompatLayer(rawRunner);
  if (!effectiveRunner) return true;

  const objectArch =
    bottleOrName && typeof bottleOrName === 'object'
      ? bottleOrName.wineArch || bottleOrName.bottleArch
      : undefined;
  const detailEntry =
    options && options.bottleDetails && typeof options.bottleDetails === 'object'
      ? options.bottleDetails[trimmed]
      : undefined;
  const rawArch = objectArch || (detailEntry && (detailEntry.wineArch || detailEntry.bottleArch));
  const normalizedArch = typeof rawArch === 'string' ? rawArch.trim().toLowerCase() : '';

  if (effectiveRunner === 'crossover_preview_arm64') {
    if (normalizedArch) {
      return normalizedArch === 'arm64';
    }
    if (options && options.allowCustomNewBottleName === true) {
      return !/^(OneLauncher|default)$/i.test(trimmed);
    }
    return /[-_]arm64$/i.test(trimmed);
  }

  if (effectiveRunner === 'crossover' || effectiveRunner === 'crossover_preview') {
    if (normalizedArch) {
      return normalizedArch !== 'arm64';
    }
    return !/[-_]arm64$/i.test(trimmed);
  }

  return true;
}

/**
 * Resolve the preferred default bottle for a compatibility runner from an available bottle list.
 */
export function resolveDefaultBottleForRunner(
  bottles: readonly string[] | undefined,
  runnerType?: CompatibilityLayerType | string | null,
  options: ResolveDefaultBottleOptions = {}
): string | undefined {
  const list = Array.isArray(bottles) ? bottles : [];
  const effectiveRunner = sanitizeLegacyCompatLayer(runnerType);
  const compatible = list.filter((b) =>
    isBottleCompatibleWithRunner(b, effectiveRunner, {
      bottleDetails: options?.bottleDetails,
    })
  );
  const preferredDefault =
    options?.descriptorDefault ||
    (effectiveRunner === 'crossover_preview_arm64'
      ? 'OneLauncher-arm64'
      : effectiveRunner === 'crossover' || effectiveRunner === 'crossover_preview'
        ? 'OneLauncher'
        : undefined);

  if (preferredDefault) {
    const exact = compatible.find((b) => b.toLowerCase() === preferredDefault.toLowerCase());
    if (exact) return exact;
  }
  if (effectiveRunner === 'crossover' || effectiveRunner === 'crossover_preview') {
    const defaultNamed = compatible.find((b) => b.toLowerCase() === 'default');
    if (defaultNamed) return defaultNamed;
  }
  return compatible[0] || preferredDefault || list[0];
}

export function inferDetectedBuildType(
  input: ResolveEffectiveLaunchPolicyInput,
  hostPlatform: HostPlatform,
  isInstalled: boolean
): LaunchPolicyBuildType {
  if (!isInstalled) {
    return 'not_installed';
  }
  if (input.detectedBuildType && VALID_BUILD_TYPES.has(input.detectedBuildType)) {
    return input.detectedBuildType === 'not_installed'
      ? 'not_installed'
      : input.detectedBuildType;
  }
  if (hostPlatform === 'win32') {
    return 'windows_native';
  }
  const exeStr = typeof input.executablePath === 'string' ? input.executablePath.trim() : '';
  const instStr = typeof input.installPath === 'string' ? input.installPath.trim() : '';
  const isExplicitAppBundle = Boolean(
    (exeStr && /\.app(\/|$)/i.test(exeStr)) ||
      (!exeStr && instStr && /\.app(\/|$)/i.test(instStr))
  );
  const isBottlePath = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(exeStr || instStr);
  const isWinExe =
    Boolean(exeStr && /\.(exe|bat|msi)$/i.test(exeStr)) ||
    (!isExplicitAppBundle && (Boolean(input.isWindowsBinaryOnMac) || isBottlePath));

  if (isWinExe) {
    return 'windows_exe_on_mac';
  }
  if (isExplicitAppBundle) {
    return 'mac_native_app';
  }
  return 'mac_native_bin';
}

/**
 * Pure, zero-dependency shared launch policy resolver mirroring
 * `electron/launcher/policy/launchPolicyCore.cjs` 1:1 (enforced by Gate 13).
 */
export function resolveEffectiveLaunchPolicy(
  input: ResolveEffectiveLaunchPolicyInput = {}
): ResolvedEffectiveLaunchPolicy {
  const platformId = sanitizePlatformId(input.platformId);
  const hostPlatform = sanitizeHostPlatform(input.hostPlatform);
  const hostArch = sanitizeHostArch(input.hostArch, hostPlatform);
  const configuredLaunchMethod = sanitizeLaunchMethod(input.configuredLaunchMethod);
  const effectiveCompatibilityLayer = sanitizeLegacyCompatLayer(input.compatibilityLayer) ?? null;
  const runnerSupport = isRunnerSupportedOnHost(
    effectiveCompatibilityLayer,
    hostPlatform,
    hostArch
  );

  const rawInstalled =
    typeof input.isInstalled === 'boolean'
      ? input.isInstalled
      : input.detectedBuildType && VALID_BUILD_TYPES.has(input.detectedBuildType)
        ? input.detectedBuildType !== 'not_installed'
        : Boolean(
            (typeof input.executablePath === 'string' && input.executablePath.trim()) ||
              (typeof input.installPath === 'string' && input.installPath.trim()) ||
              input.hasExecutable ||
              input.hasCustomExecutable
          );

  const detectedBuildType = inferDetectedBuildType(input, hostPlatform, rawInstalled);
  const isInstalled = rawInstalled && detectedBuildType !== 'not_installed';

  const isBottleManagedBypassContext =
    (platformId === 'epic' || platformId === 'xbox') &&
    hostPlatform !== 'win32' &&
    (detectedBuildType === 'windows_exe_on_mac' ||
      configuredLaunchMethod === 'compatibility_layer');
  const effectiveLifecycle: StorefrontClientLifecyclePolicy =
    isBottleManagedBypassContext &&
    (!input.storefrontClientLifecycle || input.storefrontClientLifecycle === 'default')
      ? 'fast_direct_bypass'
      : resolveEffectiveLifecyclePolicy(
          input.storefrontClientLifecycle,
          input.globalStorefrontLifecycle
        );

  const hasCustomExecutable = Boolean(input.hasCustomExecutable);
  const hasExecutable =
    typeof input.hasExecutable === 'boolean'
      ? input.hasExecutable
      : typeof input.executablePath === 'string'
        ? Boolean(input.executablePath.trim())
        : isInstalled;

  let autoResolvedMethod: LaunchMethod = 'storefront_uri';
  let effectiveLaunchMethod: LaunchMethod = 'storefront_uri';
  let coercedFromDirectToCompat = false;

  if (detectedBuildType === 'not_installed' || !rawInstalled) {
    autoResolvedMethod = 'storefront_uri';
    effectiveLaunchMethod = 'storefront_uri';
  } else if (detectedBuildType === 'windows_exe_on_mac') {
    autoResolvedMethod = 'compatibility_layer';
    if (configuredLaunchMethod === 'storefront_uri') {
      effectiveLaunchMethod = 'storefront_uri';
    } else {
      effectiveLaunchMethod = 'compatibility_layer';
      coercedFromDirectToCompat = configuredLaunchMethod === 'direct';
    }
  } else if (
    detectedBuildType === 'mac_native_app' ||
    detectedBuildType === 'mac_native_bin'
  ) {
    autoResolvedMethod = platformId === 'steam' ? 'storefront_uri' : 'direct';
    if (configuredLaunchMethod === 'storefront_uri') {
      effectiveLaunchMethod = 'storefront_uri';
    } else if (configuredLaunchMethod === 'direct') {
      effectiveLaunchMethod = 'direct';
    } else if (configuredLaunchMethod === 'compatibility_layer') {
      effectiveLaunchMethod = 'compatibility_layer';
    } else {
      effectiveLaunchMethod = autoResolvedMethod;
    }
  } else if (detectedBuildType === 'windows_native') {
    autoResolvedMethod =
      platformId === 'steam'
        ? 'storefront_uri'
        : hasExecutable
          ? 'direct'
          : 'storefront_uri';
    if (configuredLaunchMethod === 'storefront_uri') {
      effectiveLaunchMethod = 'storefront_uri';
    } else if (configuredLaunchMethod === 'auto') {
      effectiveLaunchMethod = autoResolvedMethod;
    } else {
      effectiveLaunchMethod = hasExecutable ? 'direct' : 'storefront_uri';
    }
  }

  const delegatesToStorefrontUri =
    !isInstalled ||
    effectiveLaunchMethod === 'storefront_uri' ||
    configuredLaunchMethod === 'storefront_uri';

  const isFastDirectBypass =
    isInstalled &&
    !delegatesToStorefrontUri &&
    platformId !== 'custom' &&
    (effectiveLifecycle === 'fast_direct_bypass' ||
      (platformId === 'steam' && configuredLaunchMethod === 'direct'));

  const isBottleExecution =
    isInstalled && !delegatesToStorefrontUri && detectedBuildType === 'windows_exe_on_mac';

  const usesSilentSteamApplaunch =
    isInstalled &&
    !delegatesToStorefrontUri &&
    platformId === 'steam' &&
    !isFastDirectBypass &&
    !hasCustomExecutable;

  const usesClientlessEos =
    isInstalled && !delegatesToStorefrontUri && platformId === 'epic';

  const isClientlessXboxInstall = Boolean(input.isClientlessXboxInstall);

  const syncsCloudSavesStandalone =
    isInstalled &&
    !delegatesToStorefrontUri &&
    (platformId === 'gog' ||
      platformId === 'epic' ||
      (platformId === 'xbox' && (isBottleExecution || isClientlessXboxInstall)));

  let spawnsStorefrontClient = false;
  if (isInstalled) {
    if (delegatesToStorefrontUri) {
      spawnsStorefrontClient = platformId !== 'custom';
    } else if (platformId === 'steam') {
      spawnsStorefrontClient = usesSilentSteamApplaunch;
    } else if (platformId === 'gog') {
      spawnsStorefrontClient = !isFastDirectBypass && input.usesGalaxySdk !== false;
    } else if (platformId === 'epic') {
      spawnsStorefrontClient = isBottleExecution && !isFastDirectBypass;
    } else if (platformId === 'xbox') {
      spawnsStorefrontClient =
        !isBottleExecution && !isClientlessXboxInstall && effectiveLifecycle === 'default_client';
    } else {
      spawnsStorefrontClient = false;
    }
  }

  const effectiveDisplayScalingMode = resolveEffectiveDisplayScalingMode(
    {
      displayScalingMode: input.displayScalingMode as BottleDisplayScalingMode | undefined,
      virtualDesktop: input.virtualDesktop,
    },
    {
      defaultBottleDisplayScalingMode: input.globalDisplayScalingMode as
        | GlobalBottleDisplayScalingMode
        | undefined,
    }
  );
  const effectiveDisplayAspectRatio = resolveEffectiveDisplayAspectRatio(
    {
      displayAspectRatio: input.displayAspectRatio as DisplayAspectRatioMode | undefined,
    },
    {
      defaultDisplayAspectRatio: input.globalDisplayAspectRatio as
        | GlobalDisplayAspectRatioMode
        | undefined,
    }
  );
  const effectivePerformanceHud = resolveEffectivePerformanceHud(
    {
      performanceHud: input.performanceHud as PerformanceHudMode | undefined,
      metalHud: input.metalHud,
      dxvkHud: input.dxvkHud,
    },
    {
      defaultPerformanceHud: input.globalDefaultPerformanceHud === true,
    }
  );
  const effectiveGraphicsBackend: CrossOverGraphicsBackend =
    sanitizeCrossOverGraphicsBackend(input.crossoverGraphicsBackend) ?? 'auto';
  const supportsMetalfxSpatial = Boolean(
    isBottleExecution &&
      runnerSupport.supported &&
      (effectiveGraphicsBackend === 'dxmt' || effectiveGraphicsBackend === 'auto')
  );

  return {
    platformId,
    hostPlatform,
    hostArch,
    detectedBuildType,
    isInstalled,
    isBottleExecution,
    configuredLaunchMethod,
    autoResolvedMethod,
    effectiveLaunchMethod,
    effectiveLifecycle,
    effectiveCompatibilityLayer,
    runnerHostArchSupported: runnerSupport.supported,
    runnerHostArchError: runnerSupport.reason,
    effectiveGraphicsBackend,
    effectiveDisplayScalingMode,
    effectiveDisplayAspectRatio,
    effectivePerformanceHud,
    supportsMetalfxSpatial,
    coercedFromDirectToCompat,
    isFastDirectBypass,
    delegatesToStorefrontUri,
    spawnsStorefrontClient,
    usesSilentSteamApplaunch,
    usesClientlessEos,
    syncsCloudSavesStandalone,
  };
}
