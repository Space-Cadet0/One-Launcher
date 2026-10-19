import { StorefrontId } from './platform';

export type LaunchMethod =
  | 'auto'
  | 'direct'
  | 'storefront_uri'
  | 'compatibility_layer';

export type CompatibilityLayerType =
  | 'native'
  | 'crossover'
  | 'crossover_preview'
  | 'whisky'
  | 'gptk'
  | 'wine';

export interface CompatibilityLayerInfo {
  id: string;
  type: CompatibilityLayerType;
  name: string;
  binaryPath: string;
  bottlesDir?: string;
  availableBottles?: string[];
  version?: string;
}

export interface InstalledGameRecord {
  platformId: StorefrontId;
  platformGameId: string;
  appId?: number;
  title?: string;
  installPath: string;
  executablePath?: string;
  /** Default launch arguments discovered from storefront manifest (appinfo.vdf / goggame.info / Epic .item / engine gameinfo.txt) */
  launchArguments?: string;
  installSize?: number; // in bytes
  version?: string;
  manifestPath?: string;
  runner?:
    | 'steam'
    | 'gog'
    | 'epic'
    | 'legendary'
    | 'gogdl'
    | 'nile'
    | 'one_launcher'
    | 'custom';
  isWindowsBinaryOnMac?: boolean;
}

export type CrossOverGraphicsBackend = 'auto' | 'd3dmetal' | 'dxmt' | 'dxvk' | 'wined3d';

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
  /** CrossOver 26 High Resolution Mode (Retina 192 DPI in HKCU\Software\Wine\Mac Driver) */
  crossoverHighResolutionMode?: boolean;
  /** CrossOver 26 DLSS (MetalFX upscaling for D3DMetal and DXMT) */
  crossoverDlss?: boolean;
  /** Wine / CrossOver Mach semaphore synchronization (WINEMSYNC) */
  wineMsync?: boolean;
  /** Wine / CrossOver eventfd synchronization (WINEESYNC) */
  wineEsync?: boolean;
  /** Apple Metal Performance HUD overlay (MTL_HUD_ENABLED=1) */
  metalHud?: boolean;
  /** DXVK FPS & frametime HUD overlay (DXVK_HUD=devinfo,fps,frametimes) */
  dxvkHud?: boolean;
  preLaunchCommand?: string;
  postExitCommand?: string;
}

export interface GameLaunchConfig extends StorefrontLaunchProfile {
  gameId: string;
  preferredPlatformId?: StorefrontId;
  launchMethod: LaunchMethod;
  /** Per-storefront launch & compatibility profiles keyed by StorefrontId ('steam' | 'gog' | 'epic' | 'custom') */
  platformConfigs?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>;
}

export interface ResolvedLaunchModePreview {
  isInstalled: boolean;
  hostPlatform: 'darwin' | 'win32' | 'linux';
  platformId: StorefrontId;
  installPath?: string;
  executablePath?: string;
  detectedBuildType:
    | 'mac_native_app'
    | 'mac_native_bin'
    | 'windows_exe_on_mac'
    | 'windows_native'
    | 'not_installed';
  detectedBuildLabel: string;
  detectedBuildDetail: string;
  autoResolvedMethod: LaunchMethod;
  autoResolvedSummary: string;
  recommendedModes: LaunchMethod[];
  /** Launch modes relevant to this storefront's installation type */
  availableModes: LaunchMethod[];
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
    }
  >;
}

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
  status: 'starting' | 'running' | 'stopping';
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
}

export interface DiskSpaceInfo {
  targetPath: string;
  freeBytes: number;
  totalBytes: number;
  usedBytes: number;
}

export interface GameInstallInfo {
  platformId: StorefrontId;
  platformGameId: string;
  hostPlatform?: 'darwin' | 'win32' | 'linux';
  estimatedSizeBytes?: number;
  defaultInstallDir: string;
  availableInstallDirs: string[];
  availableInstallers?: {
    id: string;
    name: string;
    os: 'mac' | 'windows' | 'linux';
    language?: string;
    totalSizeBytes?: number;
    version?: string;
  }[];
  canDirectDownload: boolean;
  requiresStoreClientFallback?: boolean;
  diskSpace?: DiskSpaceInfo;
}

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
  targetInstallDir?: string;
  steamPlatforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
}

export interface LaunchGameRequest {
  gameId: string;
  title: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
  executablePath?: string;
  launchArguments?: string;
  isWindowsBinaryOnMac?: boolean;
  launchConfig?: GameLaunchConfig;
}

export interface StopGameRequest {
  sessionId?: string;
  gameId?: string;
  pid?: number;
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
}

export interface UninstallGameRequest {
  gameId: string;
  title?: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
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
