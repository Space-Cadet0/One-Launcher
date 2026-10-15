import type { CanonicalGame } from '../contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  GameInstallInfoRequest,
  GameLaunchConfig,
  InstalledGameRecord,
  InstallGameRequest,
  LauncherActionResult,
  LaunchGameRequest,
  StopGameRequest,
  UninstallGameRequest,
  VerifyGameRequest,
} from '../contracts/launcher';

export interface ElectronAPI {
  isElectron: boolean;
  platform?: string;
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

  // Universal Game Launcher & Install Manager IPC
  scanAllInstalledGames: () => Promise<{
    success: boolean;
    installedGames?: InstalledGameRecord[];
    installedSteamAppIds?: number[];
    error?: string;
  }>;
  detectCompatibilityLayers: () => Promise<CompatibilityLayerInfo[]>;
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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
