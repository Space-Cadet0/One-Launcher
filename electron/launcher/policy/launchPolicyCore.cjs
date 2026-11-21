// @ts-check
'use strict';

/**
 * Pure, zero-dependency core launch policy resolver & runner/bottle compatibility engine.
 * Strictly mirrored 1:1 with `src/contracts/launchPolicyResolver.ts` (enforced by Gate 13).
 */

const {
  sanitizeLegacyCompatLayer,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  resolveEffectiveLifecyclePolicy,
  resolveEffectivePerformanceHud,
  resolveEffectiveDisplayScalingMode,
  resolveEffectiveDisplayAspectRatio,
  sanitizeCrossOverGraphicsBackend,
} = require('./configSanitizers.cjs');

/**
 * @typedef {'mac_native_app' | 'mac_native_bin' | 'windows_exe_on_mac' | 'windows_native' | 'not_installed'} LaunchPolicyBuildType
 * @typedef {'darwin' | 'win32' | 'linux'} HostPlatform
 * @typedef {'arm64' | 'x64'} HostArch
 * @typedef {import('./configSanitizers.cjs').CompatibilityLayerType} CompatibilityLayerType
 * @typedef {import('./configSanitizers.cjs').CrossOverGraphicsBackend} CrossOverGraphicsBackend
 */

/** @type {Set<string>} */
const VALID_BUILD_TYPES = new Set([
  'mac_native_app',
  'mac_native_bin',
  'windows_exe_on_mac',
  'windows_native',
  'not_installed',
]);

const X64_ARCH_RE = /^(x64|ia32|x86_64|x86|intel|amd64)$/i;

/**
 * @param {unknown} platformId
 * @returns {'steam' | 'gog' | 'epic' | 'xbox' | 'custom'}
 */
function sanitizePlatformId(platformId) {
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

/**
 * @param {unknown} hostPlatform
 * @returns {HostPlatform}
 */
function sanitizeHostPlatform(hostPlatform) {
  const clean = typeof hostPlatform === 'string' ? hostPlatform.trim().toLowerCase() : '';
  if (clean === 'win32' || clean === 'linux' || clean === 'darwin') {
    return clean;
  }
  return 'darwin';
}

/**
 * @param {unknown} hostArch
 * @param {HostPlatform} hostPlatform
 * @returns {HostArch}
 */
function sanitizeHostArch(hostArch, hostPlatform) {
  const clean = typeof hostArch === 'string' ? hostArch.trim() : '';
  if (clean) {
    return X64_ARCH_RE.test(clean) ? 'x64' : 'arm64';
  }
  return hostPlatform === 'win32' ? 'x64' : 'arm64';
}

/**
 * Canonical host-OS + CPU-architecture compatibility check for a requested compatibility runner.
 * Guarantees 1:1 parity between renderer launch previews and Electron main-process launch checks
 * (specifically rejecting `crossover_preview_arm64` and `gptk` on Intel x86_64 / non-macOS hosts).
 *
 * @param {unknown} runnerType
 * @param {unknown} [hostPlatform]
 * @param {unknown} [hostArch]
 * @returns {{ supported: boolean, reason: string | null }}
 */
function isRunnerSupportedOnHost(runnerType, hostPlatform = 'darwin', hostArch = undefined) {
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
 * Canonical bottle-to-runner architecture compatibility check used across Electron prober,
 * bottle manager, setup wizard, install modal, and launch config modal.
 *
 * @param {string | { name?: string, wineArch?: string, bottleArch?: string } | null | undefined} bottleOrName
 * @param {string | null | undefined} runnerType
 * @param {{ bottleDetails?: Record<string, { wineArch?: string, bottleArch?: string }>, allowCustomNewBottleName?: boolean }} [options]
 * @returns {boolean}
 */
function isBottleCompatibleWithRunner(bottleOrName, runnerType, options = {}) {
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
 *
 * @param {readonly string[] | undefined} bottles
 * @param {string | null | undefined} runnerType
 * @param {{ bottleDetails?: Record<string, { wineArch?: string, bottleArch?: string }>, descriptorDefault?: string }} [options]
 * @returns {string | undefined}
 */
function resolveDefaultBottleForRunner(bottles, runnerType, options = {}) {
  const list = Array.isArray(bottles) ? bottles : [];
  const effectiveRunner = sanitizeLegacyCompatLayer(runnerType);
  const compatible = list.filter((b) =>
    isBottleCompatibleWithRunner(b, effectiveRunner, {
      bottleDetails: options && options.bottleDetails,
    })
  );
  const preferredDefault =
    (options && options.descriptorDefault) ||
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

/**
 * @param {Record<string, any>} input
 * @param {HostPlatform} hostPlatform
 * @param {boolean} isInstalled
 * @returns {LaunchPolicyBuildType}
 */
function inferDetectedBuildType(input, hostPlatform, isInstalled) {
  if (!isInstalled) {
    return 'not_installed';
  }
  if (
    input &&
    typeof input.detectedBuildType === 'string' &&
    VALID_BUILD_TYPES.has(input.detectedBuildType)
  ) {
    return /** @type {LaunchPolicyBuildType} */ (
      input.detectedBuildType === 'not_installed' ? 'not_installed' : input.detectedBuildType
    );
  }
  if (hostPlatform === 'win32') {
    return 'windows_native';
  }
  const exeStr = typeof input?.executablePath === 'string' ? input.executablePath.trim() : '';
  const instStr = typeof input?.installPath === 'string' ? input.installPath.trim() : '';
  const isExplicitAppBundle = Boolean(
    (exeStr && /\.app(\/|$)/i.test(exeStr)) || (!exeStr && instStr && /\.app(\/|$)/i.test(instStr))
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
 * Resolves the canonical launch execution policy across host OS, host CPU arch, detected build
 * type, storefront ID, configured LaunchMethod, compatibility layer, graphics backend, display
 * scaling mode, HUD mode, and storefront client lifecycle policy.
 *
 * @param {Record<string, any>} [input]
 */
function resolveEffectiveLaunchPolicy(input = {}) {
  const platformId = sanitizePlatformId(input.platformId);
  const hostPlatform = sanitizeHostPlatform(input.hostPlatform);
  const hostArch = sanitizeHostArch(input.hostArch, hostPlatform);
  const configuredLaunchMethod = sanitizeLaunchMethod(input.configuredLaunchMethod);
  const effectiveCompatibilityLayer = sanitizeLegacyCompatLayer(input.compatibilityLayer) || null;
  const runnerSupport = isRunnerSupportedOnHost(
    effectiveCompatibilityLayer,
    hostPlatform,
    hostArch
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

  const isBottleManagedBypassContext =
    (platformId === 'epic' || platformId === 'xbox') &&
    hostPlatform !== 'win32' &&
    (detectedBuildType === 'windows_exe_on_mac' ||
      configuredLaunchMethod === 'compatibility_layer');
  const effectiveLifecycle =
    isBottleManagedBypassContext &&
    (!input.storefrontClientLifecycle || input.storefrontClientLifecycle === 'default')
      ? /** @type {import('./configSanitizers.cjs').StorefrontClientLifecyclePolicy} */ (
          'fast_direct_bypass'
        )
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

  /** @type {import('./configSanitizers.cjs').LaunchMethod} */
  let autoResolvedMethod = 'storefront_uri';
  /** @type {import('./configSanitizers.cjs').LaunchMethod} */
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
  } else if (detectedBuildType === 'mac_native_app' || detectedBuildType === 'mac_native_bin') {
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

  const usesClientlessEos = isInstalled && !delegatesToStorefrontUri && platformId === 'epic';

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
      displayScalingMode: input.displayScalingMode,
      virtualDesktop: input.virtualDesktop,
    },
    {
      defaultBottleDisplayScalingMode: input.globalDisplayScalingMode,
    }
  );
  const effectiveDisplayAspectRatio = resolveEffectiveDisplayAspectRatio(
    {
      displayAspectRatio: input.displayAspectRatio,
    },
    {
      defaultDisplayAspectRatio: input.globalDisplayAspectRatio,
    }
  );
  const effectivePerformanceHud = resolveEffectivePerformanceHud(
    {
      performanceHud: input.performanceHud,
      metalHud: input.metalHud,
      dxvkHud: input.dxvkHud,
    },
    {
      defaultPerformanceHud: input.globalDefaultPerformanceHud === true,
    }
  );
  const effectiveGraphicsBackend =
    sanitizeCrossOverGraphicsBackend(input.crossoverGraphicsBackend) || 'auto';
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

module.exports = {
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  resolveEffectiveLifecyclePolicy,
  isRunnerSupportedOnHost,
  isBottleCompatibleWithRunner,
  resolveDefaultBottleForRunner,
  inferDetectedBuildType,
  resolveEffectiveLaunchPolicy,
};
