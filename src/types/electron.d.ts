import type {
  CanonicalGame,
  XboxGamePassSyncMode,
  XboxSubscriptionSummary,
} from '../contracts/game';
import type { StorefrontId } from '../contracts/platform';
import type {
  ClientLoginTargetId,
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
  EnvironmentSetupProgressEvent,
  GuidedClientLoginResult,
  RunEnvironmentSetupRequest,
  RunEnvironmentSetupResult,
  SetupWizardPersistedState,
  StartGuidedClientLoginRequest,
} from '../contracts/environmentSetup';
import type {
  EndpointHealthSnapshot,
  OfflineHydrationProgressPayload,
  OfflineVaultGameDetail,
  OfflineVaultStats,
  OfflineVaultTier,
} from '../contracts/network';
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

export interface StorefrontCredentialsInput {
  epicToken?: string;
  epicRefreshToken?: string;
  epicAccountId?: string;
  gogToken?: string;
  gogRefreshToken?: string;
  steamId?: string;
  steamApiKey?: string;
  syncMode?: XboxGamePassSyncMode;
  forceRefresh?: boolean;
}

export interface AchievementSummaryEntry {
  unlocked: number;
  total: number;
  percentage: number;
  isMastered?: boolean;
}

export interface StorefrontAchievementsResponse {
  achievements?: Record<string, AchievementSummaryEntry>;
  [gameKey: string]: any;
}

export interface AchievementSchemaItem {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  unlockedDescription?: string;
  lockedDescription?: string;
  iconUrl?: string;
  unlockedIconUrl?: string;
  lockedIconUrl?: string;
  unlocked?: boolean;
  unlockedAt?: string | null;
  rarityPercentage?: number;
  gamerscore?: number;
  xp?: number;
  isHidden?: boolean;
}

export interface StorefrontTokenSummary {
  connected?: boolean;
  access_token?: 'saved_in_electron' | string;
  hasAccessToken?: boolean;
  hasRefreshToken?: boolean;
  hasApiKey?: boolean;
  steamId?: string;
  accountName?: string;
  username?: string;
  displayName?: string;
  user_id?: string;
  account_id?: string;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  avatars?: Record<string, string>;
  subscription?: XboxSubscriptionSummary | null;
  syncMode?: XboxGamePassSyncMode;
  games?: CanonicalGame[];
  updatedAt?: string;
  expiresAt?: string | number;
}

export interface SavedStoreTokensMap {
  steam?: StorefrontTokenSummary;
  gog?: StorefrontTokenSummary;
  epic?: StorefrontTokenSummary;
  xbox?: StorefrontTokenSummary;
  suppressedItems?: never[];
  [storefrontId: string]: any;
}

export interface StorefrontAuthResult {
  success: boolean;
  storefrontId?: string;
  code?: string;
  requiresInlineConsent?: boolean;
  inlineAuthUrl?: string;
  accountName?: string;
  accountId?: string;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  gamerscore?: number;
  subscription?: XboxSubscriptionSummary;
  syncMode?: XboxGamePassSyncMode;
  games?: CanonicalGame[];
  achievements?: Record<string | number, AchievementSummaryEntry>;
  suppressedItems?: any[];
  tokenData?: StorefrontTokenSummary | null;
  syncError?: string;
  error?: string;
  errorCode?: string;
  xerr?: number | string;
  redirectUrl?: string;
}

export interface HltbSearchEntry {
  game_id?: number;
  game_name?: string;
  game_image?: string;
  comp_main?: number;
  comp_plus?: number;
  comp_100?: number;
  comp_all?: number;
}

export interface UserMetadataOverride {
  gameId: string;
  title?: string;
  coverUrl?: string;
  heroUrl?: string;
  headerUrl?: string;
  logoUrl?: string;
  iconUrl?: string;
  hidden?: boolean;
  favorite?: boolean;
  customTags?: string[];
  notes?: string;
  platformId?: string;
  platformGameId?: string;
  steamAppId?: number | null;
  matchedStore?: string;
  matchedId?: string;
  purgeKeys?: string[];
  updatedAt?: string;
}

export interface RemoveUserOverrideOptions {
  gameId?: string;
  id?: string;
  aliasKeys?: string[];
  aliases?: string[];
  orphanVaultGameIds?: string[];
  platformId?: string;
  platformGameId?: string;
  platforms?: Array<{ platformId?: string; platformGameId?: string }>;
}

export interface UserOverrideMutationResult {
  success: boolean;
  gameId?: string;
  override?: UserMetadataOverride;
  overrides?: Record<string, UserMetadataOverride>;
  error?: string;
}

export interface OfflineVaultBridge {
  getStats: () => Promise<OfflineVaultStats>;
  setTier: (
    tier: OfflineVaultTier
  ) => Promise<{ success: boolean; stats?: OfflineVaultStats; error?: string }>;
  clear: (options?: {
    preserveMetadata?: boolean;
  }) => Promise<{ success: boolean; stats?: OfflineVaultStats; error?: string }>;
  getCatalogSnapshot: () => Promise<{
    success: boolean;
    games?: CanonicalGame[];
    details?: Record<string, OfflineVaultGameDetail>;
  }>;
  upsertGames: (
    games: Partial<CanonicalGame>[]
  ) => Promise<{ success: boolean; upserted?: number; error?: string }>;
  deleteGames: (
    gameIds: string[] | { gameIds?: string[] } | string
  ) => Promise<{ success: boolean; deleted?: number; error?: string }>;
  setModalBusy: (
    isBusy: boolean
  ) => Promise<{ success: boolean; isPausedForModal?: boolean }>;
  getGameDetail: (gameId: string) => Promise<OfflineVaultGameDetail | null>;
  saveGameDetail: (
    payload: OfflineVaultGameDetail & { canonicalTitle?: string; steamAppId?: number | null }
  ) => Promise<{ success: boolean; error?: string }>;
  resolveLocalMetadata: (payload: {
    gameId?: string;
    title?: string;
    steamAppId?: number | string | null;
    gogId?: string | null;
    epicAppName?: string | null;
    xboxProductId?: string | null;
    packageFamilyName?: string | null;
  }) => Promise<{
    success: boolean;
    metadata?: (Partial<CanonicalGame['enrichedMetadata']> & Record<string, unknown>) | null;
  }>;
  queueHydration: (payload: {
    games: Array<{
      gameId: string;
      title?: string;
      steamAppId?: number | string | null;
      gogId?: string | null;
      epicAppName?: string | null;
      xboxProductId?: string | null;
      packageFamilyName?: string | null;
      isInstalled?: boolean;
      isFavorited?: boolean;
      priority?: number;
      assets?: Array<{ role: string; ordinal?: number; url: string }>;
    }>;
  }) => Promise<{ success: boolean; queued?: number }>;
  checkUrlStatus: (url: string) => Promise<{
    online: boolean;
    status: number | null;
    isDefinitive404: boolean;
    isWafOrRateLimited: boolean;
    retryAfterMs?: number;
    blocked?: boolean;
    error?: string;
  }>;
  getUserOverrides: () => Promise<Record<string, UserMetadataOverride>>;
  saveUserOverride: (
    gameIdOrOverride:
      | string
      | (object & {
          gameId?: string;
          id?: string;
          purgeKeys?: string[];
          override?: object;
          batchOverrides?: Record<string, UserMetadataOverride>;
        }),
    overridePatch?: object
  ) => Promise<UserOverrideMutationResult>;
  removeUserOverride: (
    gameId: string | RemoveUserOverrideOptions
  ) => Promise<UserOverrideMutationResult>;
  onHealthChanged: (cb: (snapshot: EndpointHealthSnapshot) => void) => () => void;
  onGameHydrated: (
    cb: (payload: { gameId: string; detail?: OfflineVaultGameDetail }) => void
  ) => () => void;
  onHydrationProgress: (cb: (payload: OfflineHydrationProgressPayload) => void) => () => void;
}

export interface ElectronAPI {
  isElectron: boolean;
  platform: string;
  loginStore: (storefrontId: string) => Promise<StorefrontAuthResult>;
  syncStore: (
    storefrontId: string,
    credentials?: StorefrontCredentialsInput | object
  ) => Promise<{
    success: boolean;
    storefrontId?: string;
    accountName?: string;
    accountId?: string;
    gamertag?: string;
    modernGamertag?: string;
    xuid?: string;
    avatarUrl?: string;
    gamerscore?: number;
    subscription?: XboxSubscriptionSummary;
    syncMode?: XboxGamePassSyncMode;
    games?: CanonicalGame[];
    suppressedItems?: any[];
    achievements?: Record<string | number, AchievementSummaryEntry>;
    error?: string;
  }>;
  exchangeCode: (storefrontId: string, code: string) => Promise<StorefrontAuthResult>;
  getSavedTokens: () => Promise<SavedStoreTokensMap>;
  clearTokens: (storefrontId: string) => Promise<{ success?: boolean } | void>;
  disconnectStore?: (storefrontId: string) => Promise<{ success: boolean } | void>;
  scanLocalGames: () => Promise<{
    success: boolean;
    installedSteamAppIds?: number[];
    installedGames?: InstalledGameRecord[];
    error?: string;
  }>;
  scanSteamAchievements: () => Promise<{
    success: boolean;
    achievements?: Record<number, AchievementSummaryEntry>;
    error?: string;
  }>;
  openExternal: (url: string) => Promise<boolean>;
  openExternalUrl?: (url: string) => Promise<boolean>;
  searchHltb: (title: string) => Promise<{
    success: boolean;
    data?: HltbSearchEntry[];
    error?: string;
  }>;
  fetchEpicAchievements: (
    accountId?: string | Record<string, unknown>,
    accessToken?: string
  ) => Promise<StorefrontAchievementsResponse>;
  fetchGogAchievements: (
    username?: string | Record<string, unknown>,
    accessToken?: string,
    userId?: string
  ) => Promise<StorefrontAchievementsResponse>;
  fetchXboxAchievements?: (payload?: {
    pfns?: string[];
    [key: string]: unknown;
  }) => Promise<StorefrontAchievementsResponse>;
  fetchSteamBatchAchievements: (appIds?: number[]) => Promise<{
    success: boolean;
    achievements?: Record<
      number,
      { unlocked: number; total: number; percentage: number; isMastered?: boolean }
    >;
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
  }) => Promise<Record<string, any> | null>;
  fetchEpicGameSchema?: (payload: {
    gameId?: string;
    platformGameId?: string;
    appName?: string;
    namespace?: string;
    catalogItemId?: string;
    title?: string;
  }) => Promise<AchievementSchemaItem[] | { achievements?: AchievementSchemaItem[]; [key: string]: unknown }>;
  fetchXboxProductMetadata?: (payload: {
    xboxProductId?: string;
    productId?: string;
    packageFamilyName?: string;
    xboxTitleId?: string;
    title?: string;
    query?: string;
    limit?: number;
  }) => Promise<Record<string, any> | null>;
  fetchXboxGameSchema?: (payload: {
    gameId?: string;
    platformGameId?: string;
    xboxProductId?: string;
    productId?: string;
    xboxTitleId?: string;
    titleId?: string;
    packageFamilyName?: string;
  }) => Promise<AchievementSchemaItem[] | { achievements?: AchievementSchemaItem[]; [key: string]: unknown }>;
  getStoreAchievements?: (payload: {
    platformId: string;
    storefrontId?: string;
    gameId?: string;
    platformGameId?: string;
    xboxProductId?: string;
    xboxTitleId?: string;
    packageFamilyName?: string;
    appName?: string;
    namespace?: string;
    catalogItemId?: string;
    title?: string;
  }) => Promise<Record<string, any> | null>;
  getXboxStatus?: (payload?: {
    refreshSubscription?: boolean;
  }) => Promise<{
    connected: boolean;
    accountName?: string;
    gamertag?: string;
    modernGamertag?: string;
    xuid?: string;
    avatarUrl?: string;
    gamerpicUrl?: string;
    gamerscore?: number;
    subscription?: XboxSubscriptionSummary | null;
    syncMode: XboxGamePassSyncMode;
    hasDeviceContext?: boolean;
    error?: string;
  }>;
  setXboxSyncMode?: (
    syncMode: XboxGamePassSyncMode | { syncMode?: XboxGamePassSyncMode; mode?: XboxGamePassSyncMode }
  ) => Promise<{
    success: boolean;
    syncMode?: XboxGamePassSyncMode;
    error?: string;
  }>;

  // Universal Game Launcher & Install Manager IPC
  scanAllInstalledGames: (options?: Record<string, unknown>) => Promise<{
    success: boolean;
    installedGames?: InstalledGameRecord[];
    installedSteamAppIds?: number[];
    epicPlatformSupport?: Record<string, { windows: boolean; mac: boolean }>;
    error?: string;
  }>;
  detectCompatibilityLayers: (
    options?: Record<string, unknown>
  ) => Promise<CompatibilityLayerInfo[]>;
  detectInstalledStorefrontClients?: (
    options?: Record<string, unknown>
  ) => Promise<Record<'steam' | 'gog' | 'epic', boolean> & { xbox?: boolean }>;
  installCompatibilityLayer: (
    payload: InstallCompatibilityLayerRequest
  ) => Promise<InstallCompatibilityLayerResult>;
  checkCompatibilityLayerUpdates: (
    options?: Record<string, unknown>
  ) => Promise<Record<string, CompatibilityLayerUpdateInfo>>;
  updateCompatibilityLayer: (
    payload: UpdateCompatibilityLayerPayload
  ) => Promise<UpdateCompatibilityLayerResult>;
  getDiskSpace: (targetPath?: string) => Promise<DiskSpaceInfo | null>;
  getGameInstallInfo: (
    payload: GameInstallInfoRequest | Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<GameInstallInfo>;
  getInstallInfo?: (
    payload: GameInstallInfoRequest | Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<GameInstallInfo>;
  launchGame: (payload: LaunchGameRequest | Record<string, unknown>) => Promise<LauncherActionResult>;
  stopGame: (
    payload: StopGameRequest | string | Record<string, unknown>
  ) => Promise<LauncherActionResult>;
  getRunningGames: () => Promise<ActiveGameSession[]>;
  installGame: (payload: InstallGameRequest | Record<string, unknown>) => Promise<LauncherActionResult>;
  pauseDownload: (taskId: string) => Promise<LauncherActionResult>;
  resumeDownload: (taskId: string) => Promise<LauncherActionResult>;
  cancelDownload: (taskId: string) => Promise<LauncherActionResult>;
  getDownloadQueue: () => Promise<DownloadTaskState[]>;
  uninstallGame: (
    payload: UninstallGameRequest | Record<string, unknown>
  ) => Promise<LauncherActionResult>;
  verifyGameFiles: (
    payload: VerifyGameRequest | Record<string, unknown>
  ) => Promise<LauncherActionResult>;
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
  getGameLaunchConfigs: (
    options?: Record<string, unknown>
  ) => Promise<Record<string, GameLaunchConfig>>;
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
      [key: string]: unknown;
    }> & {
      sessions?: Array<Record<string, unknown>>;
      pendingSessions?: Array<Record<string, unknown>>;
      success?: boolean;
    }
  >;
  probeEnvironmentHealth: (options?: {
    connectedStorefronts?: StorefrontId[];
  }) => Promise<EnvironmentHealthSnapshot>;
  runEnvironmentSetupTasks: (
    payload: RunEnvironmentSetupRequest
  ) => Promise<RunEnvironmentSetupResult>;
  cancelEnvironmentSetup: (
    runId: string
  ) => Promise<{ success: boolean; cancelled: boolean }>;
  startGuidedClientLogin: (
    payload: StartGuidedClientLoginRequest
  ) => Promise<GuidedClientLoginResult>;
  cancelGuidedClientLogin: (
    targetId: ClientLoginTargetId
  ) => Promise<{ success: boolean; cancelled: boolean }>;
  getSetupWizardState: () => Promise<SetupWizardPersistedState>;
  saveSetupWizardState: (
    patch: Partial<SetupWizardPersistedState> & {
      addConfiguredComponents?: EnvironmentComponentId[];
    }
  ) => Promise<{ success: boolean; state: SetupWizardPersistedState }>;
  onEnvironmentSetupProgress: (
    cb: (event: EnvironmentSetupProgressEvent) => void
  ) => () => void;
  clearRendererImageCache: () => Promise<{ success: boolean; [key: string]: unknown }>;
  onHibernateStateChanged: (
    cb: (data: HibernateStatePayload & Record<string, unknown>) => void
  ) => () => void;
  onDownloadUpdated: (
    cb: (data: {
      task?: DownloadTaskState;
      queue?: DownloadTaskState[];
      [key: string]: unknown;
    }) => void
  ) => () => void;
  onSessionUpdated: (cb: (data: SessionUpdatedPayload) => void) => () => void;
  onFullscreenChanged: (cb: (isFullScreen: boolean) => void) => () => void;
  isWindowFullscreen: () => Promise<boolean>;
  toggleWindowFullscreen: () => Promise<boolean>;
  toggleFullScreen?: () => Promise<boolean>;
  minimizeWindow: () => Promise<boolean>;
  toggleMaximizeWindow: () => Promise<boolean>;
  maximizeWindow?: () => Promise<boolean>;
  isWindowMaximized: () => Promise<boolean>;
  closeWindow: () => Promise<boolean>;
  performMenuAction: (action: WindowMenuAction) => Promise<boolean>;
  toggleDevTools?: () => Promise<boolean>;
  reloadWindow?: () => Promise<boolean>;
  zoomWindow?: (direction: 'in' | 'out' | 'reset') => Promise<boolean>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
  onWindowMaximizedChanged?: (callback: (isMaximized: boolean) => void) => () => void;
  trimMemory: (options?: {
    passive?: boolean;
    clearImageCache?: boolean;
    [key: string]: unknown;
  }) => Promise<{ success: boolean }>;
  getAppVersion: () => Promise<string>;
  getAppInfo: () => Promise<AppInfoResult>;
  checkForAppUpdates: () => Promise<AppUpdateCheckResult>;
  getUserOverrides?: () => Promise<Record<string, UserMetadataOverride>>;
  saveUserOverride?: (
    gameIdOrOverride:
      | string
      | (object & {
          gameId?: string;
          id?: string;
          purgeKeys?: string[];
          override?: object;
          batchOverrides?: Record<string, UserMetadataOverride>;
        }),
    overridePatch?: object
  ) => Promise<UserOverrideMutationResult>;
  removeUserOverride?: (
    gameId: string | RemoveUserOverrideOptions
  ) => Promise<UserOverrideMutationResult>;

  offlineVault?: OfflineVaultBridge;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
