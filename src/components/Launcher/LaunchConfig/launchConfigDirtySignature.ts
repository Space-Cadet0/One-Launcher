import type {
  BottleDisplayScalingMode,
  CompatibilityLayerType,
  CrossOverD3DMetalVersion,
  CrossOverGraphicsBackend,
  DisplayAspectRatioMode,
  InGameLauncherBehavior,
  LaunchMethod,
  PerformanceHudMode,
  StorefrontClientLifecyclePolicy,
  VirtualDesktopResolutionPreset,
} from '../../../contracts/launcher';

export interface LaunchConfigSignatureFields {
  launchMethod: LaunchMethod;
  customExecutablePath: string;
  workingDirectory: string;
  launchArguments: string;
  compatibilityLayer: CompatibilityLayerType;
  wineBottleName: string;
  winePrefixPath: string;
  crossoverGraphicsBackend: CrossOverGraphicsBackend;
  crossoverD3DMetalVersion: CrossOverD3DMetalVersion;
  crossoverHighResolutionMode: boolean | undefined;
  crossoverDlss: boolean;
  preferredMaxFrameRate: number | undefined;
  metalfxSpatialUpscaleFactor: number | undefined;
  displayScalingMode: BottleDisplayScalingMode;
  displayAspectRatio: DisplayAspectRatioMode;
  virtualDesktopResolution: VirtualDesktopResolutionPreset | string;
  emulateModeset: boolean | undefined;
  forceLargeAddressAware: boolean | undefined;
  wineMsync: boolean;
  wineEsync: boolean;
  performanceHud: PerformanceHudMode;
  envText: string;
  preLaunchCommand: string;
  postExitCommand: string;
  inGameLauncherBehavior: 'default' | InGameLauncherBehavior;
  storefrontClientLifecycle: 'default' | StorefrontClientLifecyclePolicy;
}

/**
 * Produces a deterministic dirty-check JSON signature across all 26 launch-config form fields
 * in canonical property order. Consolidates the previously triplicated inline JSON.stringify blocks.
 */
export function serializeLaunchConfigSignature(fields: LaunchConfigSignatureFields): string {
  return JSON.stringify({
    launchMethod: fields.launchMethod,
    customExecutablePath: fields.customExecutablePath,
    workingDirectory: fields.workingDirectory,
    launchArguments: fields.launchArguments,
    compatibilityLayer: fields.compatibilityLayer,
    wineBottleName: fields.wineBottleName,
    winePrefixPath: fields.winePrefixPath,
    crossoverGraphicsBackend: fields.crossoverGraphicsBackend,
    crossoverD3DMetalVersion: fields.crossoverD3DMetalVersion,
    crossoverHighResolutionMode: fields.crossoverHighResolutionMode,
    crossoverDlss: fields.crossoverDlss,
    preferredMaxFrameRate: fields.preferredMaxFrameRate,
    metalfxSpatialUpscaleFactor: fields.metalfxSpatialUpscaleFactor,
    displayScalingMode: fields.displayScalingMode,
    displayAspectRatio: fields.displayAspectRatio,
    virtualDesktopResolution: fields.virtualDesktopResolution,
    emulateModeset: fields.emulateModeset,
    forceLargeAddressAware: fields.forceLargeAddressAware,
    wineMsync: fields.wineMsync,
    wineEsync: fields.wineEsync,
    performanceHud: fields.performanceHud,
    envText: fields.envText,
    preLaunchCommand: fields.preLaunchCommand,
    postExitCommand: fields.postExitCommand,
    inGameLauncherBehavior: fields.inGameLauncherBehavior,
    storefrontClientLifecycle: fields.storefrontClientLifecycle,
  });
}

/**
 * Patches specific keys on a serialized baseline signature while preserving canonical key order.
 */
export function patchLaunchConfigSignature(
  rawSig: string | undefined,
  patch: Partial<LaunchConfigSignatureFields>
): string | undefined {
  if (!rawSig) return rawSig;
  try {
    const parsed = JSON.parse(rawSig) as LaunchConfigSignatureFields;
    return serializeLaunchConfigSignature({ ...parsed, ...patch });
  } catch {
    return rawSig;
  }
}
