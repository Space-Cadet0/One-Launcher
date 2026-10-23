import type { CanonicalGame } from '../contracts/game';
import type {
  ActiveGameSession,
  AppInfoResult,
  AppUpdateCheckResult,
  CloudSaveSyncTelemetry,
  CompatibilityLayerInfo,
  CompatibilityLayerUpdateInfo,
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  GameInstallInfoRequest,
  GameLaunchConfig,
  HibernateStatePayload,
  InstallCompatibilityLayerRequest,
  InstallCompatibilityLayerResult,
  InstalledGameRecord,
  InstallGameRequest,
  LauncherActionResult,
  LauncherPerformanceSettings,
  LaunchGameRequest,
  SaveGameLaunchConfigPayload,
  SessionUpdatedEventType,
  SessionUpdatedPayload,
  StopGameRequest,
  UninstallGameRequest,
  UpdateCompatibilityLayerPayload,
  UpdateCompatibilityLayerResult,
  VerifyGameRequest,
} from '../contracts/launcher';

export type { AppInfoResult, AppUpdateCheckResult } from '../contracts/launcher';

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
  fetchEpicGameSchema?: (payload: {
    gameId?: string;
    platformGameId?: string;
    appName?: string;
    namespace?: string;
    catalogItemId?: string;
    title?: string;
  }) => Promise<any[] | { achievements?: any[]; [key: string]: any }>;

  // Universal Game Launcher & Install Manager IPC
  scanAllInstalledGames: (options?: Record<string, unknown>) => Promise<{
    success: boolean;
    installedGames?: InstalledGameRecord[];
    installedSteamAppIds?: number[];
    epicPlatformSupport?: Record<string, { windows: boolean; mac: boolean }>;
    error?: string;
  }>;
  detectCompatibilityLayers: (options?: Record<string, unknown>) => Promise<CompatibilityLayerInfo[]>;
  detectInstalledStorefrontClients?: (
    options?: Record<string, unknown>
  ) => Promise<Record<'steam' | 'gog' | 'epic', boolean>>;
  installCompatibilityLayer: (payload: InstallCompatibilityLayerRequest) => Promise<InstallCompatibilityLayerResult>;
  checkCompatibilityLayerUpdates: (options?: Record<string, unknown>) => Promise<Record<string, CompatibilityLayerUpdateInfo>>;
  updateCompatibilityLayer: (payload: UpdateCompatibilityLayerPayload) => Promise<UpdateCompatibilityLayerResult>;
  getDiskSpace: (targetPath?: string) => Promise<DiskSpaceInfo | null>;
  getGameInstallInfo: (
    payload: GameInstallInfoRequest | Record<string, any>,
    options?: Record<string, unknown>
  ) => Promise<GameInstallInfo>;
  getInstallInfo?: (
    payload: GameInstallInfoRequest | Record<string, any>,
    options?: Record<string, unknown>
  ) => Promise<GameInstallInfo>;
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
  saveGameLaunchConfig: (
    config: SaveGameLaunchConfigPayload,
    options?: Record<string, unknown>
  ) => Promise<{ success: boolean; config?: GameLaunchConfig; error?: string }>;
  saveLaunchConfig?: (
    config: SaveGameLaunchConfigPayload,
    options?: Record<string, unknown>
  ) => Promise<{ success: boolean; config?: GameLaunchConfig; error?: string }>;
  getGameLaunchConfigs: (options?: Record<string, unknown>) => Promise<Record<string, GameLaunchConfig>>;
  getLaunchConfig?: (
    gameId?: string,
    options?: Record<string, unknown>
  ) => Promise<GameLaunchConfig | Record<string, GameLaunchConfig> | null>;
  deleteLaunchConfig?: (
    gameId: string,
    options?: Record<string, unknown>
  ) => Promise<{ success: boolean; error?: string }>;
  getLauncherPerformanceSettings: (options?: Record<string, unknown>) => Promise<
    LauncherPerformanceSettings & {
      success?: boolean;
      settings?: LauncherPerformanceSettings;
      error?: string;
    }
  >;
  saveLauncherPerformanceSettings: (
    settings: Partial<LauncherPerformanceSettings> | LauncherPerformanceSettings,
    options?: Record<string, unknown>
  ) => Promise<
    {
      success: boolean;
      settings?: LauncherPerformanceSettings;
      error?: string;
    } & Partial<LauncherPerformanceSettings>
  >;
  drainPendingSessions: (options?: Record<string, unknown>) => Promise<
    Array<{
      session?: ActiveGameSession;
      sessionId?: string;
      gameId?: string;
      title?: string;
      platformId?: string;
      platformGameId?: string;
      event?: SessionUpdatedEventType;
      sessionMinutesPlayed?: number;
      durationSeconds?: number;
      storefrontTotalPlaytimeMinutes?: number | null;
      cloudSync?: CloudSaveSyncTelemetry;
      statusMessage?: string;
      startedAt?: string;
      endedAt?: string;
      lastPlayed?: string;
      error?: string;
      [key: string]: any;
    }> & {
      sessions?: Array<Record<string, any>>;
      pendingSessions?: Array<Record<string, any>>;
      success?: boolean;
    }
  >;
  clearRendererImageCache: () => Promise<{ success: boolean; [key: string]: any }>;
  onHibernateStateChanged: (
    cb: (data: HibernateStatePayload & Record<string, any>) => void
  ) => () => void;
  onDownloadUpdated: (
    cb: (data: { task?: DownloadTaskState; queue?: DownloadTaskState[]; [key: string]: any }) => void
  ) => () => void;
  onSessionUpdated: (cb: (data: SessionUpdatedPayload) => void) => () => void;
  onFullscreenChanged?: (cb: (isFullScreen: boolean) => void) => () => void;
  isWindowFullscreen?: () => Promise<boolean>;
  toggleWindowFullscreen?: () => Promise<boolean>;
  minimizeWindow: () => Promise<boolean>;
  toggleMaximizeWindow: () => Promise<boolean>;
  isWindowMaximized: () => Promise<boolean>;
  closeWindow: () => Promise<boolean>;
  performMenuAction: (action: WindowMenuAction) => Promise<boolean>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
  trimMemory?: (options?: Record<string, any>) => Promise<{ success: boolean }>;
  getAppVersion?: () => Promise<string>;
  getAppInfo?: () => Promise<AppInfoResult>;
  checkForAppUpdates?: () => Promise<AppUpdateCheckResult>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
