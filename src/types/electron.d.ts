import type { CanonicalGame } from '../contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  CompatibilityLayerUpdateInfo,
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  GameInstallInfoRequest,
  GameLaunchConfig,
  InstallCompatibilityLayerRequest,
  InstallCompatibilityLayerResult,
  InstalledGameRecord,
  InstallGameRequest,
  LauncherActionResult,
  LaunchGameRequest,
  StopGameRequest,
  UninstallGameRequest,
  UpdateCompatibilityLayerPayload,
  UpdateCompatibilityLayerResult,
  VerifyGameRequest,
} from '../contracts/launcher';

export type WindowMenuAction =
  | 'reload'
  | 'force-reload'
  | 'toggle-devtools'
  | 'reset-zoom'
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-fullscreen'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'minimize'
  | 'maximize-toggle'
  | 'close'
  | 'quit';

export interface ElectronAPI {
  isElectron: boolean;
  platform: string;
  loginStore: (storefrontId: string) => Promise<any>;
  syncStore: (
    storefrontId: string,
    credentials?: Record<string, any>
  ) => Promise<{
    success: boolean;
    storefrontId?: string;
    accountName?: string;
    accountId?: string;
    avatarUrl?: string;
    games?: CanonicalGame[];
    suppressedItems?: any[];
    achievements?: Record<string | number, any>;
    error?: string;
  }>;
  exchangeCode: (storefrontId: string, code: string) => Promise<any>;
  getSavedTokens: () => Promise<Record<string, any>>;
  clearTokens: (storefrontId: string) => Promise<void>;
  scanLocalGames: () => Promise<{ success: boolean; installedSteamAppIds?: number[]; installedGames?: any[]; error?: string }>;
  scanSteamAchievements: () => Promise<{ success: boolean; achievements?: Record<number, any>; error?: string }>;
  openExternal: (url: string) => Promise<boolean>;
  searchHltb: (title: string) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  fetchEpicAchievements: (accountId?: string, accessToken?: string) => Promise<Record<string, any>>;
  fetchGogAchievements: (username?: string, accessToken?: string, userId?: string) => Promise<Record<string, any>>;
  fetchSteamBatchAchievements: (appIds?: number[]) => Promise<{
    success: boolean;
    achievements?: Record<number, { unlocked: number; total: number; percentage: number; isMastered?: boolean }>;
    steamId?: string;
    error?: string;
  }>;
  fetchIgdbCover: (title: string) => Promise<string | null>;
  fetchEpicProductMetadata?: (payload: {
    appName?: string;
    namespace?: string;
    catalogItemId?: string;
    title?: string;
    slug?: string;
  }) => Promise<any>;

  // Universal Game Launcher & Install Manager IPC
  scanAllInstalledGames: () => Promise<{
    success: boolean;
    installedGames?: InstalledGameRecord[];
    installedSteamAppIds?: number[];
    epicPlatformSupport?: Record<string, { windows: boolean; mac: boolean }>;
    error?: string;
  }>;
  detectCompatibilityLayers: () => Promise<CompatibilityLayerInfo[]>;
  installCompatibilityLayer: (payload: InstallCompatibilityLayerRequest) => Promise<InstallCompatibilityLayerResult>;
  checkCompatibilityLayerUpdates: () => Promise<Record<string, CompatibilityLayerUpdateInfo>>;
  updateCompatibilityLayer: (payload: UpdateCompatibilityLayerPayload) => Promise<UpdateCompatibilityLayerResult>;
  getDiskSpace: (targetPath?: string) => Promise<DiskSpaceInfo | null>;
  getGameInstallInfo: (payload: GameInstallInfoRequest | Record<string, any>) => Promise<GameInstallInfo>;
  launchGame: (payload: LaunchGameRequest | Record<string, any>) => Promise<LauncherActionResult>;
  stopGame: (payload: StopGameRequest | string | Record<string, any>) => Promise<LauncherActionResult>;
  getRunningGames: () => Promise<ActiveGameSession[]>;
  installGame: (payload: InstallGameRequest | Record<string, any>) => Promise<LauncherActionResult>;
  pauseDownload: (taskId: string) => Promise<LauncherActionResult>;
  resumeDownload: (taskId: string) => Promise<LauncherActionResult>;
  cancelDownload: (taskId: string) => Promise<LauncherActionResult>;
  getDownloadQueue: () => Promise<DownloadTaskState[]>;
  uninstallGame: (payload: UninstallGameRequest | Record<string, any>) => Promise<LauncherActionResult>;
  verifyGameFiles: (payload: VerifyGameRequest | Record<string, any>) => Promise<LauncherActionResult>;
  browseLocalFiles: (targetPath: string) => Promise<{ success: boolean; error?: string } | boolean>;
  selectExecutableDialog: (defaultPath?: string) => Promise<string | null>;
  selectFolderDialog: (defaultPath?: string) => Promise<string | null>;
  saveGameLaunchConfig: (config: GameLaunchConfig) => Promise<{ success: boolean; config?: GameLaunchConfig; error?: string }>;
  getGameLaunchConfigs: () => Promise<Record<string, GameLaunchConfig>>;
  onDownloadUpdated: (cb: (data: any) => void) => () => void;
  onSessionUpdated: (
    cb: (data: {
      session?: ActiveGameSession;
      event?: 'started' | 'stopping' | 'stopped';
      sessionMinutesPlayed?: number;
      durationSeconds?: number;
      lastPlayed?: string;
      error?: string;
    }) => void
  ) => () => void;
  onFullscreenChanged?: (cb: (isFullScreen: boolean) => void) => () => void;
  minimizeWindow: () => Promise<boolean>;
  toggleMaximizeWindow: () => Promise<boolean>;
  isWindowMaximized: () => Promise<boolean>;
  closeWindow: () => Promise<boolean>;
  performMenuAction: (action: WindowMenuAction) => Promise<boolean>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
  trimMemory?: () => Promise<{ success: boolean }>;
  getAppVersion?: () => Promise<string>;
  getAppInfo?: () => Promise<AppInfoResult>;
  checkForAppUpdates?: () => Promise<AppUpdateCheckResult>;
}

export interface AppInfoResult {
  version: string;
  platform: string;
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

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
