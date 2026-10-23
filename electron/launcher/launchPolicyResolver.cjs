'use strict';

/**
 * Pure, zero-dependency shared launch policy resolver used across both the
 * Electron main process (electron/launcherEngine.cjs) and the renderer service
 * layer (mirrored in src/contracts/launchPolicyResolver.ts).
 */

const VALID_STOREFRONT_LIFECYCLE_POLICIES = new Set([
  'minimal_and_close_if_started',
  'minimal_keep_running',
  'default_client',
  'fast_direct_bypass',
]);

const VALID_LAUNCH_METHODS = new Set([
  'auto',
  'direct',
  'storefront_uri',
  'compatibility_layer',
]);

const VALID_BUILD_TYPES = new Set([
  'mac_native_app',
  'mac_native_bin',
  'windows_exe_on_mac',
  'windows_native',
  'not_installed',
]);

function sanitizePlatformId(platformId) {
  const clean = typeof platformId === 'string' ? platformId.trim().toLowerCase() : '';
  if (clean === 'steam' || clean === 'gog' || clean === 'epic' || clean === 'custom') {
    return clean;
  }
  return 'custom';
}

function sanitizeHostPlatform(hostPlatform) {
  const clean = typeof hostPlatform === 'string' ? hostPlatform.trim().toLowerCase() : '';
  if (clean === 'win32' || clean === 'linux' || clean === 'darwin') {
    return clean;
  }
  return 'darwin';
}

function sanitizeLaunchMethod(launchMethod) {
  const clean = typeof launchMethod === 'string' ? launchMethod.trim() : '';
  if (!clean || clean === 'custom') {
    return 'auto';
  }
  return VALID_LAUNCH_METHODS.has(clean) ? clean : 'auto';
}

function sanitizeStorefrontLifecyclePolicy(
  value,
  fallback = 'minimal_and_close_if_started'
) {
  const cleanFallback = VALID_STOREFRONT_LIFECYCLE_POLICIES.has(fallback)
    ? fallback
    : 'minimal_and_close_if_started';
  const clean = typeof value === 'string' ? value.trim() : '';
  return VALID_STOREFRONT_LIFECYCLE_POLICIES.has(clean) ? clean : cleanFallback;
}

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

function inferDetectedBuildType(input, hostPlatform, isInstalled) {
  if (!isInstalled) {
    return 'not_installed';
  }
  if (input && VALID_BUILD_TYPES.has(input.detectedBuildType)) {
    return input.detectedBuildType === 'not_installed'
      ? 'not_installed'
      : input.detectedBuildType;
  }
  if (hostPlatform === 'win32') {
    return 'windows_native';
  }
  const exeStr = typeof input?.executablePath === 'string' ? input.executablePath.trim() : '';
  const instStr = typeof input?.installPath === 'string' ? input.installPath.trim() : '';
  const isExplicitAppBundle = Boolean(
    (exeStr && /\.app(\/|$)/i.test(exeStr)) ||
      (!exeStr && instStr && /\.app(\/|$)/i.test(instStr))
  );
  const isBottlePath = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(exeStr || instStr);
  const isWinExe =
    Boolean(exeStr && /\.(exe|bat|msi)$/i.test(exeStr)) ||
    (!isExplicitAppBundle && (Boolean(input?.isWindowsBinaryOnMac) || isBottlePath));

  if (isWinExe) {
    return 'windows_exe_on_mac';
  }
  if (isExplicitAppBundle) {
    return 'mac_native_app';
  }
  return 'mac_native_bin';
}

/**
 * Resolves the canonical launch execution policy across host OS, detected build type,
 * storefront ID, configured LaunchMethod, and storefront client lifecycle policy.
 */
function resolveEffectiveLaunchPolicy(input = {}) {
  const platformId = sanitizePlatformId(input.platformId);
  const hostPlatform = sanitizeHostPlatform(input.hostPlatform);
  const configuredLaunchMethod = sanitizeLaunchMethod(input.configuredLaunchMethod);
  const effectiveLifecycle = resolveEffectiveLifecyclePolicy(
    input.storefrontClientLifecycle,
    input.globalStorefrontLifecycle
  );

  const rawInstalled =
    typeof input.isInstalled === 'boolean'
      ? input.isInstalled
      : VALID_BUILD_TYPES.has(input.detectedBuildType)
        ? input.detectedBuildType !== 'not_installed'
        : Boolean(
            (typeof input.executablePath === 'string' && input.executablePath.trim()) ||
              (typeof input.installPath === 'string' && input.installPath.trim()) ||
              input.hasExecutable ||
              input.hasCustomExecutable
          );

  const detectedBuildType = inferDetectedBuildType(input, hostPlatform, rawInstalled);
  const isInstalled = rawInstalled && detectedBuildType !== 'not_installed';

  const hasCustomExecutable = Boolean(input.hasCustomExecutable);
  const hasExecutable =
    typeof input.hasExecutable === 'boolean'
      ? input.hasExecutable
      : typeof input.executablePath === 'string'
        ? Boolean(input.executablePath.trim())
        : isInstalled;

  let autoResolvedMethod = 'storefront_uri';
  let effectiveLaunchMethod = 'storefront_uri';
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
      platformId === 'steam' ? 'storefront_uri' : hasExecutable ? 'direct' : 'storefront_uri';
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
    (platformId === 'gog' || platformId === 'epic');

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

module.exports = {
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  resolveEffectiveLifecyclePolicy,
  resolveEffectiveLaunchPolicy,
};
