import { StorefrontId } from './platform';
import type { ChainedHandoffTopology } from './game';
import type { ResolvedEffectiveLaunchPolicy } from './launchPolicyResolver';

export {
  resolveEffectiveLaunchPolicy,
  resolveEffectiveLifecyclePolicy,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  type LaunchPolicyBuildType,
  type ResolveEffectiveLaunchPolicyInput,
  type ResolvedEffectiveLaunchPolicy,
} from './launchPolicyResolver';

export type LaunchMethod =
  | 'auto'
  | 'direct'
  | 'storefront_uri'
  | 'compatibility_layer'
  /** @deprecated Legacy launch method automatically normalized to 'auto' */
  | 'custom';

export type CompatibilityLayerType =
  | 'native'
  | 'crossover'
  | 'crossover_preview'
  | 'gptk'
  | 'wine';

export type CrossOverD3DMetalVersion = 'auto' | '4' | '3';

export type WineDebugMode = 'off' | 'fixme_err' | 'warn_err' | 'relay';

export const MANAGED_ENV_VAR_KEYS = [
  'CX_GRAPHICS_BACKEND_VERSION',
  'DXVK_CONFIG_FILE',
  'DXMT_METALFX_SPATIAL_SWAPCHAIN',
  'DXVK_FRAME_RATE',
  'D3DM_MAX_FPS',
  'CX_FWD_COMPAT_GL_CTX',
] as const;

export type ManagedEnvVarKey = (typeof MANAGED_ENV_VAR_KEYS)[number];

export interface BundledD3DMetalVersionInfo {
  /** Selector key used for CX_GRAPHICS_BACKEND_VERSION ('4', '3', or 'default') */
  id: string;
  /** Exact version from D3DMetal.framework/Resources/Info.plist (e.g. "4.0b3", "3.0", "3.0b3") */
  version: string;
  /** Display label (e.g. "D3DMetal 4.0b3 (Default)", "D3DMetal 3.0 (Fallback)") */
  label: string;
  isDefault?: boolean;
}

export interface CompatibilityLayerInfo {
  id: string;
  type: CompatibilityLayerType;
  name: string;
  binaryPath: string;
  appPath?: string;
  bottlesDir?: string;
  availableBottles?: string[];
  available?: boolean;
  version?: string;
  buildVersion?: string;
  displayVersion?: string;
  d3dmetalVersion?: string;
  availableD3DMetalVersions?: BundledD3DMetalVersionInfo[];
  hostArch?: string;
  darwinKernelMajor?: number;
  supportsMetalFxDlssD3dMetal?: boolean;
  supportsMetalFxDlssDxmt?: boolean;
  vulkanDriver?: string;
}

export type CompatibilityLayerUpdateMethod =
  | 'direct_download'
  | 'homebrew_cask'
  | 'vendor_portal'
  | 'external_manager'
  | 'brew_upgrade'
  | 'direct_zip_app';

export type CompatibilityRunnerOperationPhase =
  | 'probing'
  | 'downloading'
  | 'verifying_signature'
  | 'extracting'
  | 'installing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CompatibilityRunnerProgressEvent {
  runnerType: Exclude<CompatibilityLayerType, 'native'>;
  operation: 'install' | 'update';
  phase: CompatibilityRunnerOperationPhase;
  progressPercent: number | null;
  bytesDownloaded?: number;
  totalBytes?: number;
  message: string;
  error?: string;
  updatedAt?: string;
}

export interface CompatibilityLayerUpdateInfo {
  runnerType: CompatibilityLayerType;
  installed: boolean;
  installedVersion?: string;
  installedBuildVersion?: string;
  installedDisplayVersion?: string;
  latestVersion?: string;
  latestBuildVersion?: string;
  latestDisplayVersion?: string;
  updateAvailable: boolean;
  downloadUrl?: string;
  releaseNotesUrl?: string;
  canAutoUpdate: boolean;
  updateMethod?: CompatibilityLayerUpdateMethod;
  estimatedDownloadBytes?: number;
  stableSurpassesPreview?: boolean;
  stableFallbackVersion?: string;
  statusMessage?: string;
  checkedAt: string;
}

export interface UpdateCompatibilityLayerPayload {
  runnerType: Exclude<CompatibilityLayerType, 'native'>;
  dmgPath?: string;
  archivePath?: string;
  switchToStableCrossOver?: boolean;
}

export interface UpdateCompatibilityLayerResult {
  success: boolean;
  runnerType: CompatibilityLayerType;
  updated: boolean;
  cancelled?: boolean;
  previousVersion?: string;
  newVersion?: string;
  installedPath?: string;
  openedExternalUrl?: boolean | string;
  busyCode?: 'RUNNER_BUSY_ACTIVE_SESSION' | 'RUNNER_BUSY_EXTERNAL_PROCESS';
  message: string;
  error?: string;
  detectedLayers?: CompatibilityLayerInfo[];
  updateInfo?: CompatibilityLayerUpdateInfo;
}

export interface CompatibilityRunnerDescriptor {
  type: Exclude<CompatibilityLayerType, 'native'>;
  label: string;
  shortLabel: string;
  vendor: string;
  description: string;
  bestFor: string;
  downloadUrl: string;
  downloadLabel: string;
  brewCask?: string;
  brewCommandDisplay?: string;
  canAutoInstallViaBrew?: boolean;
  canAutoInstallDirect?: boolean;
  estimatedDownloadMB?: number;
}

export interface InstallCompatibilityLayerRequest {
  runnerType: Exclude<CompatibilityLayerType, 'native'>;
  mode?: 'auto' | 'direct' | 'download';
  dmgPath?: string;
  archivePath?: string;
}

export interface InstallCompatibilityLayerResult {
  success: boolean;
  installed?: boolean;
  cancelled?: boolean;
  openedExternalInstaller?: boolean;
  runnerType: string;
  installedPath?: string;
  busyCode?: 'RUNNER_BUSY_ACTIVE_SESSION' | 'RUNNER_BUSY_EXTERNAL_PROCESS';
  message?: string;
  error?: string;
  layers?: CompatibilityLayerInfo[];
}

export interface InstalledGameRecord {
  platformId: StorefrontId;
  platformGameId: string;
  appId?: number;
  title?: string;
  installPath: string;
  executablePath?: string;
  /** Default launch arguments discovered from storefront manifest (appinfo.vdf / goggame.info / Epic .item / MicrosoftGame.config) */
  launchArguments?: string;
  installSize?: number; // in bytes
  version?: string;
  manifestPath?: string;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  isCrossPlatformLauncherRuntime?: boolean;
  externalStorefrontHandoff?: StorefrontId | 'riot' | string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
  runner?:
    | 'steam'
    | 'gog'
    | 'epic'
    | 'xbox'
    | 'xbox_xgr'
    | 'legendary'
    | 'gogdl'
    | 'nile'
    | 'crossover'
    | 'one_launcher'
    | 'custom';
  isWindowsBinaryOnMac?: boolean;
  executableArchitecture?: string;
  is32BitExecutable?: boolean;
}

export type InstalledGameInfo = InstalledGameRecord;

export type CrossOverGraphicsBackend = 'auto' | 'd3dmetal' | 'dxmt' | 'dxvk' | 'wined3d';

export type BottleDisplayScalingMode =
  | 'default'
  | 'auto_fullscreen'
  | 'force_fullscreen'
  | 'native_driver'
  | 'windowed'
  | 'virtual_desktop';

export type GlobalBottleDisplayScalingMode = Exclude<BottleDisplayScalingMode, 'default'>;

export type DisplayAspectRatioMode = 'default' | 'preserve_aspect' | 'integer' | 'stretch';

export type GlobalDisplayAspectRatioMode = Exclude<DisplayAspectRatioMode, 'default'>;

export type VirtualDesktopResolutionPreset =
  | 'auto'
  | '1920x1080'
  | '1600x900'
  | '1280x720'
  | '1024x768'
  | '800x600';

export type InGameLauncherBehavior =
  | 'keep_open'
  | 'minimize_taskbar'
  | 'hide_tray_hibernate'
  | 'zero_renderer_daemon';

export type PostGameLauncherBehavior =
  | 'restore_window'
  | 'stay_minimized'
  | 'exit_launcher';

export type StorefrontClientLifecyclePolicy =
  | 'minimal_and_close_if_started'
  | 'minimal_keep_running'
  | 'default_client'
  | 'fast_direct_bypass';

export interface CloudSaveSyncTelemetry {
  gameId: string;
  platformId: StorefrontId;
  direction: 'pre_launch' | 'post_exit';
  synced: boolean;
  status: 'cloud_sync_complete' | 'cloud_sync_warning';
  reason?: string;
  backupPath?: string;
  timestamp: string;
}

export interface FastMinimalLaunchAdvisory {
  isActive: boolean;
  title: string;
  footprintBenefit: string;
  warnings: string[];
  recommendation: string;
  severity?: 'info' | 'warning';
  badgeLabel?: string;
  headline?: string;
  consequences?: string[];
}

export interface LauncherPerformanceSettings {
  inGameLauncherBehavior: InGameLauncherBehavior;
  postGameLauncherBehavior: PostGameLauncherBehavior;
  pauseBackgroundSyncInGame: boolean;
  pauseDownloadsInGame: boolean;
  storefrontClientLifecycle: StorefrontClientLifecyclePolicy;
  autoShutdownWinePrefixOnExit: boolean;
  suppressWineDebugLogging: boolean;
  defaultBottleDisplayScalingMode?: GlobalBottleDisplayScalingMode;
  defaultDisplayAspectRatio?: GlobalDisplayAspectRatioMode;
  enableFullscreenHotkey?: boolean;
}

export const DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS: LauncherPerformanceSettings = {
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
};

export interface StorefrontLaunchProfile {
  launchMethod?: LaunchMethod;
  customExecutablePath?: string;
  workingDirectory?: string;
  launchArguments?: string;
  environmentVariables?: Record<string, string>;
  compatibilityLayer?: CompatibilityLayerType;
  wineBottleName?: string;
  winePrefixPath?: string;
  /** CrossOver 26 per-game graphics backend override */
  crossoverGraphicsBackend?: CrossOverGraphicsBackend;
  /** CrossOver Preview per-game D3DMetal version selector (CX_GRAPHICS_BACKEND_VERSION: 'auto' | '4' | '3') */
  crossoverD3DMetalVersion?: CrossOverD3DMetalVersion;
  /** CrossOver 26 High Resolution Mode (Retina 192 DPI in HKCU\Software\Wine\Mac Driver) */
  crossoverHighResolutionMode?: boolean;
  /** CrossOver 26 DLSS (MetalFX upscaling for D3DMetal and DXMT) */
  crossoverDlss?: boolean;
  /** Wine / CrossOver Mach semaphore synchronization (WINEMSYNC) */
  wineMsync?: boolean;
  /** Wine / CrossOver eventfd synchronization (WINEESYNC) */
  wineEsync?: boolean;
  /** Wine debug channel verbosity override (WINEDEBUG) */
  wineDebug?: WineDebugMode | string;
  /** Apple Metal Performance HUD overlay (MTL_HUD_ENABLED=1) */
  metalHud?: boolean;
  /** DXVK FPS & frametime HUD overlay (DXVK_HUD=devinfo,fps,frametimes) */
  dxvkHud?: boolean;
  /** Target maximum frame rate cap (DXVK_FRAME_RATE / D3DM_MAX_FPS / dxvk.maxFrameRate) */
  preferredMaxFrameRate?: number;
  /** DXMT MetalFX spatial swapchain upscale factor (DXMT_METALFX_SPATIAL_SWAPCHAIN: 1.33 | 1.5 | 1.7 | 2.0) */
  metalfxSpatialUpscaleFactor?: number;
  /** Wine / CrossOver virtual desktop containment */
  virtualDesktop?: boolean;
  /** Wine virtual desktop resolution preset (e.g. 'auto' | '1920x1080' | '1280x720') */
  virtualDesktopResolution?: VirtualDesktopResolutionPreset | string;
  /** Bottled macOS fullscreen & legacy resolution scaling mode ('default' inherits global LauncherPerformanceSettings) */
  displayScalingMode?: BottleDisplayScalingMode;
  /** Bottled macOS fullscreen aspect ratio & filter policy ('default' inherits global LauncherPerformanceSettings) */
  displayAspectRatio?: DisplayAspectRatioMode;
  /** Wine Mac Driver display mode emulation override (EmulateModeset) */
  emulateModeset?: boolean;
  /** 32-bit PE32 4 GB address space override (WINE_LARGE_ADDRESS_AWARE) */
  forceLargeAddressAware?: boolean;
  /** Clamp legacy DirectSound / CoreAudio buffer sizing for Wine compatibility */
  audioBufferClamp?: boolean;
  /** Advertise x86 AVX instruction set inside Rosetta 2 / Wine (ROSETTA_ADVERTISE_AVX) */
  advertiseAvx?: boolean;
  preLaunchCommand?: string;
  postExitCommand?: string;
  /** Per-game override for in-game launcher behavior ('default' inherits global LauncherPerformanceSettings) */
  inGameLauncherBehavior?: 'default' | InGameLauncherBehavior;
  /** Per-game override for storefront client lifecycle policy ('default' inherits global LauncherPerformanceSettings) */
  storefrontClientLifecycle?: 'default' | StorefrontClientLifecyclePolicy;
}

export interface GameLaunchConfig extends StorefrontLaunchProfile {
  gameId: string;
  preferredPlatformId?: StorefrontId;
  launchMethod: LaunchMethod;
  /** CrossOver Preview per-game D3DMetal version selector (CX_GRAPHICS_BACKEND_VERSION: 'auto' | '4' | '3') */
  crossoverD3DMetalVersion?: CrossOverD3DMetalVersion;
  /** Wine debug channel verbosity override (WINEDEBUG) */
  wineDebug?: WineDebugMode | string;
  /** Per-game override for in-game launcher behavior ('default' inherits global LauncherPerformanceSettings) */
  inGameLauncherBehavior?: 'default' | InGameLauncherBehavior;
  /** Per-game override for storefront client lifecycle policy ('default' inherits global LauncherPerformanceSettings) */
  storefrontClientLifecycle?: 'default' | StorefrontClientLifecyclePolicy;
  /** Per-storefront launch & compatibility profiles keyed by StorefrontId ('steam' | 'gog' | 'epic' | 'custom') */
  platformConfigs?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>;
}

export interface GameLaunchConfigResetRequest {
  gameId: string;
  launchMethod?: LaunchMethod;
  reset?: boolean;
  resetToDefaults?: boolean;
  resetPlatformId?: StorefrontId;
  preferredPlatformId?: StorefrontId;
  platformConfigs?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>;
}

export type SaveGameLaunchConfigPayload =
  | (GameLaunchConfig & {
      reset?: boolean;
      resetToDefaults?: boolean;
      resetPlatformId?: StorefrontId;
    })
  | GameLaunchConfigResetRequest;

export type StorefrontPolicyInfoKey =
  | StorefrontClientLifecyclePolicy
  | 'clientless_epic'
  | 'clientless_bottle_gog'
  | 'protocol_delegated';

export interface StorefrontPolicyOptionDescriptor {
  value: StorefrontClientLifecyclePolicy;
  label: string;
  isRecommended?: boolean;
}

export interface StorefrontPolicyInfoBox {
  policyKey: StorefrontPolicyInfoKey;
  cardHeading: string;
  severity: 'optimal' | 'info' | 'warning';
  badgeLabel: string;
  headline: string;
  footprintSummary: string;
  includedFeatures: string[];
  excludedOrTradeoffs: string[];
}

export interface StorefrontLaunchPolicyView {
  cardHeading: string;
  isBottleContext: boolean;
  showDropdown: boolean;
  dropdownOptions: StorefrontPolicyOptionDescriptor[];
  selectedDropdownValue: StorefrontClientLifecyclePolicy;
  infoBox: StorefrontPolicyInfoBox;
}

export interface ResolvedLaunchModePreview {
  isInstalled: boolean;
  hostPlatform: 'darwin' | 'win32' | 'linux';
  platformId: StorefrontId;
  installPath?: string;
  executablePath?: string;
  executableArchitecture?: string;
  is32BitExecutable?: boolean;
  detectedBuildType:
    | 'mac_native_app'
    | 'mac_native_bin'
    | 'windows_exe_on_mac'
    | 'windows_native'
    | 'not_installed';
  detectedBuildLabel: string;
  detectedBuildDetail: string;
  /** True when the storefront offers both a Native macOS build (Recommended) and a Windows build (via Compatibility / Translation layer) */
  hasDualMacAndWinBuild?: boolean;
  autoResolvedMethod: LaunchMethod;
  autoResolvedSummary: string;
  /** Storefront & build-type preferred default launch mode ('storefront_uri' for Steam Native, 'direct' for Epic/GOG/Custom Native, 'auto' for Bottle & uninstalled) */
  defaultLaunchMethod: LaunchMethod;
  recommendedModes: LaunchMethod[];
  /** Launch modes relevant to this storefront's installation type */
  availableModes: LaunchMethod[];
  /** Shared pure launch policy resolution backing both renderer preview and main-process execution */
  resolvedPolicy?: ResolvedEffectiveLaunchPolicy;
  /** Dynamic visibility flags for modal sections based on host OS, storefront build type, and active runner */
  visibleSections: {
    compatibilityLayer: boolean;
    crossoverRendering: boolean;
    nativeMacMetalHud: boolean;
    executableAndArgs: boolean;
    environmentAndHooks: boolean;
  };
  modeNotes: Record<
    LaunchMethod,
    {
      badge?: string;
      badgeTone?: 'emerald' | 'sky' | 'amber' | 'slate';
      dynamicDesc: string;
      warning?: string;
      disabled?: boolean;
      disabledReason?: string;
    }
  >;
}

export type ActiveGameSessionStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'cloud_sync_warning'
  | 'cloud_sync_complete';

export interface ActiveGameSession {
  sessionId: string;
  gameId: string;
  title: string;
  platformId: StorefrontId;
  platformGameId: string;
  pid?: number;
  startedAt: string; // ISO
  launchMethod: string;
  executablePath?: string;
  status: ActiveGameSessionStatus;
  isBottledSession?: boolean;
  fullscreenActive?: boolean;
  displayScalingMode?: GlobalBottleDisplayScalingMode;
  displayAspectRatio?: GlobalDisplayAspectRatioMode;
  cloudSync?: CloudSaveSyncTelemetry;
  statusMessage?: string;
}

export type SessionUpdatedEventType =
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'fullscreen_updated'
  | 'playtime_synced'
  | 'cloud_sync_warning'
  | 'cloud_sync_complete';

export interface SessionUpdatedPayload {
  session?: ActiveGameSession;
  event?: SessionUpdatedEventType;
  sessionMinutesPlayed?: number;
  durationSeconds?: number;
  lastPlayed?: string;
  storefrontTotalPlaytimeMinutes?: number | null;
  cloudSync?: CloudSaveSyncTelemetry;
  statusMessage?: string;
  error?: string;
}

export interface HibernateStatePayload {
  hibernating: boolean;
  reason?: string;
  gameId?: string;
  gameTitle?: string;
  inGame?: boolean;
  mode?: InGameLauncherBehavior | string;
  hibernated?: boolean;
  isHibernated?: boolean;
  behavior?: InGameLauncherBehavior;
  activeSessions?: number;
}

export type DownloadTaskStatus =
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadTaskState {
  taskId: string;
  gameId: string;
  title: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  headerImage?: string;
  installDir: string;
  status: DownloadTaskStatus;
  progressPercent: number; // 0-100
  bytesDownloaded: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds?: number;
  statusMessage?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  finalInstallPath?: string;
  executablePath?: string;
  launchArguments?: string;
  runner?: InstalledGameRecord['runner'];
  isWindowsBinaryOnMac?: boolean;
  isCrossPlatformLauncherRuntime?: boolean;
  externalStorefrontHandoff?: StorefrontId | 'riot' | string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
  installRequest?: InstallGameRequest;
  tempBinPath?: string;
}

export interface DiskSpaceInfo {
  targetPath: string;
  freeBytes: number;
  totalBytes: number;
  usedBytes: number;
  volumeMissing?: boolean;
}

export interface AvailableInstaller {
  id: string;
  name: string;
  label?: string;
  os: 'mac' | 'windows' | 'linux';
  language?: string;
  sizeBytes?: number;
  totalSizeBytes?: number;
  downloadSizeBytes?: number;
  dlcSizeBytes?: number;
  version?: string;
  authoritativeOsSupport?: boolean;
  externalLauncher?: string;
  externalLauncherUrl?: string;
  externalStorefrontHandoff?: string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
}

export interface GameInstallInfo {
  platformId: StorefrontId;
  platformGameId: string;
  hostPlatform?: 'darwin' | 'win32' | 'linux';
  estimatedSizeBytes?: number;
  downloadSizeBytes?: number;
  dlcSizeBytes?: number;
  defaultInstallDir: string;
  availableInstallDirs: string[];
  availableInstallers?: AvailableInstaller[];
  canDirectDownload: boolean;
  requiresStoreClientFallback?: boolean;
  authoritativeOsSupport?: boolean;
  isCrossPlatformBottleInstall?: boolean;
  executableArchitecture?: string;
  is32BitExecutable?: boolean;
  externalLauncher?: string;
  externalLauncherUrl?: string;
  externalStorefrontHandoff?: string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
  diskSpace?: DiskSpaceInfo;
  xboxCompatibility?: {
    tier:
      | 'tier_a_supported'
      | 'tier_b_legacy_uwp'
      | 'tier_c_kernel_anticheat'
      | 'tier_c_external_launcher';
    label?: string;
    summary?: string;
    detail?: string;
    canExtractAndRun?: boolean;
    supportedOnMacBottle?: boolean;
    requiresCoreWindow?: boolean;
    antiCheatDetected?: boolean;
    antiCheatSignals?: string[];
    externalStorefront?: string;
    externalLauncher?: string;
    externalLauncherUrl?: string;
    externalStorefrontHandoff?: string;
    chainedLauncherHandoff?: string;
    chainedExternalInstallId?: string;
    antiCheatName?: string;
    encryption?: string;
  };
}

export type GameInstallInfoResponse = GameInstallInfo;

export interface LauncherActionResult {
  success: boolean;
  message?: string;
  error?: string;
  session?: ActiveGameSession;
  sessionMinutesPlayed?: number;
  task?: DownloadTaskState;
  installPath?: string;
  executablePath?: string;
}

export interface GameInstallInfoRequest {
  gameId?: string;
  title?: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  externalStorefrontHandoff?: StorefrontId | 'riot' | string;
  xboxBottleCompatibilityTier?: string;
  isCrossPlatformLauncherRuntime?: boolean;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
  targetInstallDir?: string;
  steamPlatforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
  storePlatforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
}

export type GetGameInstallInfoPayload = GameInstallInfoRequest;

export interface LaunchGameRequest {
  gameId: string;
  title: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
  executablePath?: string;
  launchArguments?: string;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  isWindowsBinaryOnMac?: boolean;
  isCrossPlatformLauncherRuntime?: boolean;
  externalStorefrontHandoff?: StorefrontId | 'riot' | string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
  launchConfig?: GameLaunchConfig;
  performanceSettings?: LauncherPerformanceSettings;
}

export interface StopGameRequest {
  sessionId?: string;
  gameId?: string;
  pid?: number;
}

export interface ToggleSessionFullscreenRequest {
  sessionId?: string;
  gameId?: string;
  fullscreen?: boolean;
  aspectRatio?: GlobalDisplayAspectRatioMode;
}

export interface ToggleSessionFullscreenResult {
  success: boolean;
  sessionId?: string;
  gameId?: string;
  fullscreenActive?: boolean;
  displayAspectRatio?: GlobalDisplayAspectRatioMode;
  message?: string;
  error?: string;
}

export interface InstallGameRequest {
  gameId: string;
  title: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  headerImage?: string;
  installDir: string;
  installerId?: string;
  os?: 'mac' | 'windows' | 'linux';
  createShortcut?: boolean;
  estimatedSizeBytes?: number;
  totalBytes?: number;
  compatibilityLayer?: CompatibilityLayerType;
  wineBottleName?: string;
  includeDlcs?: boolean;
  preferClientlessExtraction?: boolean;
  externalLauncher?: string;
  externalLauncherUrl?: string;
  externalStorefrontHandoff?: StorefrontId | 'riot' | string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
}

export interface UninstallGameRequest {
  gameId: string;
  title?: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  deletePrefix?: boolean;
}

export interface VerifyGameRequest {
  gameId: string;
  title?: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
}

export interface AppInfoResult {
  version: string;
  platform: string;
  arch?: string;
  isUpdatedLaunch?: boolean;
}

export interface AppUpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  publishedAt?: string;
  error?: string;
}
