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

export interface GameLaunchConfig {
  gameId: string;
  preferredPlatformId?: StorefrontId;
  launchMethod: LaunchMethod;
  customExecutablePath?: string;
  workingDirectory?: string;
  launchArguments?: string;
  environmentVariables?: Record<string, string>;
  compatibilityLayer?: CompatibilityLayerType;
  wineBottleName?: string;
  winePrefixPath?: string;
  preLaunchCommand?: string;
  postExitCommand?: string;
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
}

export interface LaunchGameRequest {
  gameId: string;
  title: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
  executablePath?: string;
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
