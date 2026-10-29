import type {
  LaunchMethod,
  StorefrontClientLifecyclePolicy,
} from './launcher';
import type { StorefrontId } from './platform';

export type LaunchPolicyBuildType =
  | 'mac_native_app'
  | 'mac_native_bin'
  | 'windows_exe_on_mac'
  | 'windows_native'
  | 'not_installed';

export interface ResolveEffectiveLaunchPolicyInput {
  platformId?: StorefrontId | string;
  hostPlatform?: 'darwin' | 'win32' | 'linux' | string;
  detectedBuildType?: LaunchPolicyBuildType;
  isInstalled?: boolean;
  isWindowsBinaryOnMac?: boolean;
  hasExecutable?: boolean;
  hasCustomExecutable?: boolean;
  executablePath?: string;
  installPath?: string;
  configuredLaunchMethod?: LaunchMethod | string;
  storefrontClientLifecycle?: 'default' | StorefrontClientLifecyclePolicy | string;
  globalStorefrontLifecycle?: StorefrontClientLifecyclePolicy | string;
  usesGalaxySdk?: boolean;
}

export interface ResolvedEffectiveLaunchPolicy {
  platformId: StorefrontId;
  hostPlatform: 'darwin' | 'win32' | 'linux';
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

const VALID_STOREFRONT_LIFECYCLE_POLICIES = new Set<StorefrontClientLifecyclePolicy>([
  'minimal_and_close_if_started',
  'minimal_keep_running',
  'default_client',
  'fast_direct_bypass',
]);

const VALID_LAUNCH_METHODS = new Set<LaunchMethod>([
  'auto',
  'direct',
  'storefront_uri',
  'compatibility_layer',
]);

const VALID_BUILD_TYPES = new Set<LaunchPolicyBuildType>([
  'mac_native_app',
  'mac_native_bin',
  'windows_exe_on_mac',
  'windows_native',
  'not_installed',
]);

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

function sanitizeHostPlatform(
  hostPlatform?: 'darwin' | 'win32' | 'linux' | string
): 'darwin' | 'win32' | 'linux' {
  const clean = typeof hostPlatform === 'string' ? hostPlatform.trim().toLowerCase() : '';
  if (clean === 'win32' || clean === 'linux' || clean === 'darwin') {
    return clean;
  }
  return 'darwin';
}

export function sanitizeLaunchMethod(launchMethod?: LaunchMethod | string): LaunchMethod {
  const clean = typeof launchMethod === 'string' ? (launchMethod.trim() as LaunchMethod) : undefined;
  if (!clean || clean === 'custom') {
    return 'auto';
  }
  return VALID_LAUNCH_METHODS.has(clean) ? clean : 'auto';
}

export function sanitizeStorefrontLifecyclePolicy(
  value?: string | null,
  fallback: StorefrontClientLifecyclePolicy = 'minimal_and_close_if_started'
): StorefrontClientLifecyclePolicy {
  const cleanFallback = VALID_STOREFRONT_LIFECYCLE_POLICIES.has(fallback)
    ? fallback
    : 'minimal_and_close_if_started';
  const clean = typeof value === 'string' ? (value.trim() as StorefrontClientLifecyclePolicy) : undefined;
  return clean && VALID_STOREFRONT_LIFECYCLE_POLICIES.has(clean) ? clean : cleanFallback;
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

function inferDetectedBuildType(
  input: ResolveEffectiveLaunchPolicyInput,
  hostPlatform: 'darwin' | 'win32' | 'linux',
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
 * Pure, zero-dependency shared launch policy resolver mirroring electron/launcher/launchPolicyResolver.cjs.
 */
export function resolveEffectiveLaunchPolicy(
  input: ResolveEffectiveLaunchPolicyInput = {}
): ResolvedEffectiveLaunchPolicy {
  const platformId = sanitizePlatformId(input.platformId);
  const hostPlatform = sanitizeHostPlatform(input.hostPlatform);
  const configuredLaunchMethod = sanitizeLaunchMethod(input.configuredLaunchMethod);

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

  const syncsCloudSavesStandalone =
    isInstalled &&
    !delegatesToStorefrontUri &&
    (platformId === 'gog' ||
      platformId === 'epic' ||
      (platformId === 'xbox' && isBottleExecution));

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
      spawnsStorefrontClient = !isBottleExecution && effectiveLifecycle === 'default_client';
    } else {
      spawnsStorefrontClient = false;
    }
  }

  return {
    platformId,
    hostPlatform,
    detectedBuildType,
    isInstalled,
    isBottleExecution,
    configuredLaunchMethod,
    autoResolvedMethod,
    effectiveLaunchMethod,
    effectiveLifecycle,
    coercedFromDirectToCompat,
    isFastDirectBypass,
    delegatesToStorefrontUri,
    spawnsStorefrontClient,
    usesSilentSteamApplaunch,
    usesClientlessEos,
    syncsCloudSavesStandalone,
  };
}
