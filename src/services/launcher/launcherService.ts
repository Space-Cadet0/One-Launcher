import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import {
  buildHostCapabilities,
  resolveHostArch,
  resolveHostPlatform,
  type HostArch,
  type HostPlatform,
  type HostPlatformCapabilities,
} from '../../contracts/hostPlatform';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  resolveEffectiveLaunchPolicy,
  resolveEffectiveLifecyclePolicy,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  type ActiveGameSession,
  type AppInfoResult,
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
  type CompatibilityLayerUpdateInfo,
  type CompatibilityRunnerProgressEvent,
  type DiskSpaceInfo,
  type DownloadTaskState,
  type FastMinimalLaunchAdvisory,
  type GameInstallInfo,
  type GameLaunchConfig,
  type GameLaunchConfigResetRequest,
  type GlobalDisplayAspectRatioMode,
  type HibernateStatePayload,
  type InstallCompatibilityLayerResult,
  type InstalledGameRecord,
  type InstallGameRequest,
  type LauncherActionResult,
  type LauncherPerformanceSettings,
  type ResolvedLaunchModePreview,
  type SessionUpdatedPayload,
  type StorefrontLaunchPolicyView,
  type StorefrontLaunchProfile,
  type ToggleSessionFullscreenResult,
  type UpdateCompatibilityLayerResult,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';
import { requestScheduler } from '../network/requestScheduler';
import {
  LAUNCH_CONFIGS_STORAGE_KEY,
  PERF_SETTINGS_STORAGE_KEY,
  SELECTED_STOREFRONTS_STORAGE_KEY,
  buildMergedSaveLaunchConfig,
  clearSelectedStorefrontFromStorage,
  extractStorefrontProfile as extractStorefrontProfileFromConfig,
  loadLocalLaunchConfigsFromStorage,
  loadLocalPerformanceSettingsFromStorage,
  loadSelectedStorefrontsFromStorage,
  persistLocalLaunchConfigsToStorage,
  persistLocalPerformanceSettingsToStorage,
  persistSelectedStorefrontToStorage,
  reconcileLaunchConfigsWithDisk,
  resolveLaunchConfigFromMap,
  sanitizeBottleDisplayScalingMode,
  sanitizeDisplayAspectRatio,
  sanitizeGameLaunchConfig,
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
  sanitizeLegacyCompatLayer,
  sanitizePerformanceSettings as sanitizePerformanceSettingsEntry,
  sanitizeStorefrontLifecycleOverride,
  sanitizeVirtualDesktopResolution,
  sanitizeWineDebugMode,
} from './launchConfigStore';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  CROSSOVER_GRAPHICS_BACKEND_POLICIES,
  buildEffectiveLaunchModePreview,
  buildStorefrontLaunchPolicyConfig,
  buildStorefrontLaunchPolicyView,
  computeFastMinimalLaunchAdvisory,
  getCrossOverGraphicsBackendPolicy,
  resolveRunnerMetalFxEligibility,
  type BuildEffectiveLaunchModePreviewParams,
  type BuildLaunchModePreviewParams,
  type BuildStorefrontLaunchPolicyViewParams,
  type CrossOverGraphicsBackendPolicyDescriptor,
  type FastMinimalLaunchAdvisoryParams,
  type RunnerMetalFxEligibility,
} from './launchPolicyPreview';
import {
  CompatibilityRunnerClient,
  type CompatibilityRunnerClientContext,
} from './core/compatibilityRunnerClient';
import {
  DownloadQueueManager,
  MAX_INSTALL_INFO_CACHE_SIZE,
  type DownloadQueueManagerContext,
} from './core/downloadQueueManager';
import {
  InstalledGamesRegistry,
  type InstalledGamesRegistryContext,
} from './core/installedGamesRegistry';
import {
  dispatchLauncherStateChangedEvent,
  dispatchOpenDownloadDrawerEvent,
} from './core/launcherEventHelpers';
import {
  SessionLifecycleManager,
  type SessionLifecycleManagerContext,
} from './core/sessionLifecycleManager';

export type {
  FastMinimalLaunchAdvisory,
  StorefrontLaunchPolicyView,
  StorefrontPolicyInfoBox,
  StorefrontPolicyInfoKey,
  StorefrontPolicyOptionDescriptor,
} from '../../contracts/launcher';
export {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  CROSSOVER_GRAPHICS_BACKEND_POLICIES,
  LAUNCH_CONFIGS_STORAGE_KEY,
  PERF_SETTINGS_STORAGE_KEY,
  SELECTED_STOREFRONTS_STORAGE_KEY,
  buildEffectiveLaunchModePreview,
  buildStorefrontLaunchPolicyConfig,
  buildStorefrontLaunchPolicyView,
  computeFastMinimalLaunchAdvisory,
  getCrossOverGraphicsBackendPolicy,
  resolveEffectiveLaunchPolicy,
  resolveEffectiveLifecyclePolicy,
  resolveRunnerMetalFxEligibility,
  sanitizeBottleDisplayScalingMode,
  sanitizeDisplayAspectRatio,
  sanitizeGameLaunchConfig,
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
  sanitizeLaunchMethod,
  sanitizeLegacyCompatLayer,
  sanitizeStorefrontLifecycleOverride,
  sanitizeStorefrontLifecyclePolicy,
  sanitizeVirtualDesktopResolution,
  sanitizeWineDebugMode,
  type BuildEffectiveLaunchModePreviewParams,
  type BuildLaunchModePreviewParams,
  type CrossOverGraphicsBackendPolicyDescriptor,
  type BuildStorefrontLaunchPolicyViewParams,
  type FastMinimalLaunchAdvisoryParams,
  type RunnerMetalFxEligibility,
};

const FOCUS_RESCAN_COOLDOWN_MS = 5 * 60 * 1000;

export class LauncherService {
  public static readonly MAX_INSTALL_INFO_CACHE_SIZE = MAX_INSTALL_INFO_CACHE_SIZE;

  private readonly installedRegistry = new InstalledGamesRegistry();
  private readonly downloadManager = new DownloadQueueManager();
  private readonly sessionManager = new SessionLifecycleManager();
  private readonly runnerClient = new CompatibilityRunnerClient();

  private launchConfigs: Record<string, GameLaunchConfig> = {};
  private performanceSettings: LauncherPerformanceSettings = {
    ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  };
  private inGamePriorityScopeActive = false;
  private inGamePriorityScopeRelease: (() => void) | null = null;
  private downloadsPausedByInGame: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initializedElectronApiRef: unknown = undefined;
  private cachedAppInfo: AppInfoResult | null = null;
  private cachedAppInfoPromise: Promise<AppInfoResult | null> | null = null;
  private cachedAppInfoApiRef: unknown = undefined;
  private lastConfigsFetchedAt = 0;
  private unsubscribeDownload?: () => void;
  private unsubscribeSession?: () => void;
  private unsubscribeHibernate?: () => void;
  private focusListener?: () => void;
  private detectedHostArch?: string;

  constructor() {
    this.loadLocalConfigs();
  }

  // Compatibility accessors preserving direct property access from unit test harnesses
  private get installedRecords(): InstalledGameRecord[] {
    return this.installedRegistry.getRecords();
  }

  private set installedRecords(records: InstalledGameRecord[]) {
    this.installedRegistry.setRecords(records);
  }

  private get activeSessions(): Map<string, ActiveGameSession> {
    return this.sessionManager.getActiveSessionsMap();
  }

  private get downloadQueue(): DownloadTaskState[] {
    return this.downloadManager.getQueue();
  }

  private set downloadQueue(queue: DownloadTaskState[]) {
    this.downloadManager.setQueue(queue);
  }

  private get installedStorefrontClients(): Partial<Record<StorefrontId, boolean>> {
    return this.runnerClient.getRawInstalledStorefrontClients();
  }

  private set installedStorefrontClients(clients: Partial<Record<StorefrontId, boolean>>) {
    this.runnerClient.setInstalledStorefrontClients(clients);
  }

  private get runnerUpdates(): Record<string, CompatibilityLayerUpdateInfo> {
    return this.runnerClient.getRunnerUpdates();
  }

  private set runnerUpdates(updates: Record<string, CompatibilityLayerUpdateInfo>) {
    this.runnerClient.setRunnerUpdates(updates);
  }

  private createInstalledRegistryContext(): InstalledGamesRegistryContext {
    return {
      isWindowsHost: () => this.isWindowsHost(),
      isInitialized: () => this.initialized,
      getLaunchConfigsMap: () => this.launchConfigs,
      setLaunchConfigsMap: (next) => {
        this.launchConfigs = next;
      },
      persistLocalConfigs: () => this.persistLocalConfigs(),
      getLastConfigsFetchedAt: () => this.lastConfigsFetchedAt,
      setLastConfigsFetchedAt: (ts) => {
        this.lastConfigsFetchedAt = ts;
      },
      getLaunchConfig: (gameId, platformId) => this.getLaunchConfig(gameId, platformId),
      saveLaunchConfig: (cfg, platformId) => this.saveLaunchConfig(cfg, platformId),
      getInstalledRecordForGame: (game, platformId) =>
        this.getInstalledRecordForGame(game, platformId),
      getEffectivePlatformForGame: (game, platformId) =>
        this.getEffectivePlatformForGame(game, platformId),
      getDownloadQueue: () => this.downloadManager.getQueue(),
      setDownloadQueue: (queue) => {
        this.downloadManager.setQueue(queue);
      },
      getActiveDownload: (gameId, platformId) => this.getActiveDownload(gameId, platformId),
      reconcileActiveDownloads: (records) =>
        this.downloadManager.reconcileActiveDownloadsWithInstalledRecords(records),
      deleteCachedInstallInfoEntry: (key) => this.downloadManager.deleteCachedInstallInfoEntry(key),
      ensureActiveDownloadPolling: () => this.ensureActiveDownloadPolling(),
      notifyStateChanged: () => this.notifyStateChanged(),
    };
  }

  private createDownloadManagerContext(): DownloadQueueManagerContext {
    return {
      getHostPlatform: () => this.getHostPlatform(),
      isWindowsHost: () => this.isWindowsHost(),
      isInGameHibernating: () => this.sessionManager.isInGameHibernating(),
      getEffectivePlatformForGame: (game, platformId) =>
        this.getEffectivePlatformForGame(game, platformId),
      getDiskSpace: (targetPath) => this.getDiskSpace(targetPath),
      upsertInstalledRecord: (record, matchHint) =>
        this.installedRegistry.upsertInstalledRecord(record, matchHint),
      scanAllInstalledGames: (forceRefresh) => this.scanAllInstalledGames(forceRefresh),
      openDownloadDrawer: () => this.openDownloadDrawer(),
      notifyStateChanged: () => this.notifyStateChanged(),
    };
  }

  private createSessionManagerContext(): SessionLifecycleManagerContext {
    return {
      isWindowsHost: () => this.isWindowsHost(),
      getPerformanceSettings: () => this.getPerformanceSettings(),
      getLaunchConfig: (gameId, platformId) => this.getLaunchConfig(gameId, platformId),
      saveLaunchConfig: (cfg, platformId) => this.saveLaunchConfig(cfg, platformId),
      getEffectivePlatformForGame: (game, platformId) =>
        this.getEffectivePlatformForGame(game, platformId),
      getInstalledRecordForGame: (game, platformId) =>
        this.getInstalledRecordForGame(game, platformId),
      getInstalledStorefrontClients: () => this.runnerClient.getRawInstalledStorefrontClients(),
      resolveEffectiveLaunchModePreview: (game, preferredPlatformId, draftConfig) =>
        this.resolveEffectiveLaunchModePreview(game, preferredPlatformId, draftConfig),
      deleteCachedInstallInfoEntry: (key) => this.downloadManager.deleteCachedInstallInfoEntry(key),
      removeInstalledRecords: (predicate) =>
        this.installedRegistry.removeInstalledRecords(predicate),
      selectExecutable: (defaultPath) => this.selectExecutable(defaultPath),
      stopDownloadPolling: () => this.downloadManager.stopDownloadPolling(),
      ensureActiveDownloadPolling: () => this.ensureActiveDownloadPolling(),
      syncInGameResourceThrottle: () => this.syncInGameResourceThrottle(),
      notifyStateChanged: () => this.notifyStateChanged(),
    };
  }

  private createRunnerClientContext(): CompatibilityRunnerClientContext {
    return {
      getHostCapabilities: () => this.getHostCapabilities(),
      detectCompatibilityLayers: () => this.detectCompatibilityLayers(),
      checkCompatibilityLayerUpdates: () => this.checkCompatibilityLayerUpdates(),
      notifyStateChanged: () => this.notifyStateChanged(),
    };
  }

  private teardownElectronApiListeners(): void {
    if (this.unsubscribeDownload) {
      try {
        this.unsubscribeDownload();
      } catch {}
      this.unsubscribeDownload = undefined;
    }
    if (this.unsubscribeSession) {
      try {
        this.unsubscribeSession();
      } catch {}
      this.unsubscribeSession = undefined;
    }
    if (this.unsubscribeHibernate) {
      try {
        this.unsubscribeHibernate();
      } catch {}
      this.unsubscribeHibernate = undefined;
    }
    this.runnerClient.teardownRunnerProgressSubscription();
  }

  public getEpicPlatformSupport(): Record<string, { windows: boolean; mac: boolean }> {
    return this.installedRegistry.getEpicPlatformSupport();
  }

  private sanitizePerformanceSettings(
    raw?: Partial<LauncherPerformanceSettings> | null
  ): LauncherPerformanceSettings {
    return sanitizePerformanceSettingsEntry(raw);
  }

  private loadLocalConfigs(): void {
    this.launchConfigs = loadLocalLaunchConfigsFromStorage();
    const storedPerf = loadLocalPerformanceSettingsFromStorage();
    if (storedPerf) {
      this.performanceSettings = storedPerf;
    }
  }

  private persistLocalConfigs(): void {
    persistLocalLaunchConfigsToStorage(this.launchConfigs);
  }

  private persistLocalPerformanceSettings(): void {
    persistLocalPerformanceSettingsToStorage(this.performanceSettings);
  }

  public getPerformanceSettings(): LauncherPerformanceSettings {
    return { ...this.performanceSettings };
  }

  public async savePerformanceSettings(
    settings: Partial<LauncherPerformanceSettings>
  ): Promise<LauncherPerformanceSettings> {
    const next = this.sanitizePerformanceSettings({
      ...this.performanceSettings,
      ...settings,
    });
    this.performanceSettings = next;
    this.persistLocalPerformanceSettings();

    if (typeof window !== 'undefined' && window.electronAPI?.saveLauncherPerformanceSettings) {
      try {
        const res = await window.electronAPI.saveLauncherPerformanceSettings(next);
        const saved =
          res && typeof res === 'object' && res.settings && typeof res.settings === 'object'
            ? res.settings
            : res;
        if (saved && typeof saved === 'object') {
          this.performanceSettings = this.sanitizePerformanceSettings({
            ...next,
            ...saved,
          });
          this.persistLocalPerformanceSettings();
        }
      } catch (err) {
        console.warn('[LauncherService] Failed to save performance settings via IPC:', err);
      }
    }

    this.syncInGameResourceThrottle();
    this.notifyStateChanged();
    return { ...this.performanceSettings };
  }

  public isInGameHibernating(): boolean {
    return this.sessionManager.isInGameHibernating();
  }

  public setInGameHibernating(hibernating: boolean): void {
    this.sessionManager.applyHibernationState(hibernating, this.createSessionManagerContext());
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyStateChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
    dispatchLauncherStateChangedEvent({
      runningGames: this.getRunningGames(),
      downloadQueue: this.downloadQueue,
      installedRecords: this.installedRecords,
      inGameHibernating: this.sessionManager.isInGameHibernating(),
      performanceSettings: this.getPerformanceSettings(),
    });
  }

  private syncInGameResourceThrottle(): void {
    const activeSessions = this.activeSessions;
    if (activeSessions.size > 0) {
      if (typeof document !== 'undefined') {
        document.body?.classList?.add('is-in-game');
      }

      const activeSession = Array.from(activeSessions.values())[0];

      if (this.performanceSettings.pauseBackgroundSyncInGame !== false) {
        requestScheduler.setInGameThrottle(true);
        if (!this.inGamePriorityScopeActive && !this.inGamePriorityScopeRelease) {
          this.inGamePriorityScopeActive = true;
          const activeTitle = activeSession?.title || 'Active Game';
          void import('../network/syncJobManager')
            .then(({ syncJobManager }) => {
              const scopeHandle = syncJobManager.beginPriorityScope(
                'In-Game Performance Mode',
                activeTitle
              ) as unknown;
              const release = () => {
                if (typeof scopeHandle === 'function') {
                  scopeHandle();
                } else if (typeof scopeHandle === 'string') {
                  syncJobManager.endPriorityScope(scopeHandle);
                }
              };
              if (!this.inGamePriorityScopeActive || activeSessions.size === 0) {
                try {
                  release();
                } catch {}
                return;
              }
              this.inGamePriorityScopeRelease = release;
            })
            .catch(() => {
              this.inGamePriorityScopeActive = false;
            });
        }
      } else {
        requestScheduler.setInGameThrottle(false);
        this.inGamePriorityScopeActive = false;
        if (this.inGamePriorityScopeRelease) {
          try {
            this.inGamePriorityScopeRelease();
          } catch {}
          this.inGamePriorityScopeRelease = null;
        }
      }

      if (this.performanceSettings.pauseDownloadsInGame !== false) {
        for (const task of this.downloadManager.getQueue()) {
          if (task && task.status === 'downloading') {
            this.downloadsPausedByInGame.add(task.taskId);
            void this.pauseDownload(task.taskId);
          }
        }
      } else if (this.downloadsPausedByInGame.size > 0) {
        const toResume = Array.from(this.downloadsPausedByInGame);
        this.downloadsPausedByInGame.clear();
        for (const taskId of toResume) {
          void this.resumeDownload(taskId);
        }
      }
    } else {
      if (typeof document !== 'undefined') {
        document.body?.classList?.remove('is-in-game');
      }
      const wasHibernating = this.sessionManager.clearHibernatingFlag();
      requestScheduler.setInGameThrottle(false);
      this.inGamePriorityScopeActive = false;

      if (this.inGamePriorityScopeRelease) {
        try {
          this.inGamePriorityScopeRelease();
        } catch {}
        this.inGamePriorityScopeRelease = null;
      }

      if (this.downloadsPausedByInGame.size > 0) {
        const toResume = Array.from(this.downloadsPausedByInGame);
        this.downloadsPausedByInGame.clear();
        for (const taskId of toResume) {
          void this.resumeDownload(taskId);
        }
      }

      if (wasHibernating) {
        this.ensureActiveDownloadPolling();
      }
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  private ensureActiveDownloadPolling(): void {
    this.downloadManager.ensureActiveDownloadPolling(this.createDownloadManagerContext());
  }

  public async getAppInfo(): Promise<AppInfoResult | null> {
    const currentApi = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!currentApi?.getAppInfo) {
      return null;
    }
    if (this.cachedAppInfoApiRef !== currentApi) {
      this.cachedAppInfoApiRef = currentApi;
      this.cachedAppInfo = null;
      this.cachedAppInfoPromise = null;
    }
    if (this.cachedAppInfo) {
      return this.cachedAppInfo;
    }
    if (this.cachedAppInfoPromise) {
      return this.cachedAppInfoPromise;
    }
    const flight = currentApi
      .getAppInfo()
      .then((info) => {
        if (this.cachedAppInfoApiRef === currentApi) {
          this.cachedAppInfo = info ?? null;
          if (info && typeof (info as AppInfoResult).arch === 'string') {
            const prevArch = this.detectedHostArch;
            this.detectedHostArch = (info as AppInfoResult).arch;
            if (prevArch !== this.detectedHostArch) {
              this.notifyStateChanged();
            }
          }
        }
        return info ?? null;
      })
      .catch(() => null)
      .finally(() => {
        if (this.cachedAppInfoPromise === flight) {
          this.cachedAppInfoPromise = null;
        }
      });
    this.cachedAppInfoPromise = flight;
    return flight;
  }

  public resetForTests(): void {
    this.teardownElectronApiListeners();
    this.downloadManager.stopDownloadPolling();
    this.initialized = false;
    this.initPromise = null;
    this.initializedElectronApiRef = undefined;
    this.cachedAppInfo = null;
    this.cachedAppInfoPromise = null;
    this.cachedAppInfoApiRef = undefined;
    this.lastConfigsFetchedAt = 0;
    this.installedRegistry.resetScanState();
    this.sessionManager.resetSessionState();
    this.inGamePriorityScopeActive = false;
    if (this.inGamePriorityScopeRelease) {
      try {
        this.inGamePriorityScopeRelease();
      } catch {}
      this.inGamePriorityScopeRelease = null;
    }
  }

  public initialize(): Promise<void> {
    const currentApi = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (this.initPromise && this.initializedElectronApiRef === currentApi) {
      return this.initPromise;
    }
    if (this.initialized && this.initializedElectronApiRef === currentApi) {
      return Promise.resolve();
    }
    if (this.initializedElectronApiRef !== currentApi) {
      this.teardownElectronApiListeners();
      this.initialized = false;
      this.initPromise = null;
      this.cachedAppInfo = null;
      this.cachedAppInfoPromise = null;
      this.cachedAppInfoApiRef = undefined;
      this.lastConfigsFetchedAt = 0;
    }
    this.initializedElectronApiRef = currentApi;

    const flight = this.runInitializeInternal().finally(() => {
      if (this.initPromise === flight) {
        this.initPromise = null;
      }
    });
    this.initPromise = flight;
    return flight;
  }

  private async runInitializeInternal(): Promise<void> {
    this.loadLocalConfigs();

    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      !this.focusListener
    ) {
      this.focusListener = () => {
        if (this.sessionManager.getActiveSessionsMap().size > 0) return;
        if (
          !this.installedRegistry.getInFlightScanPromise() &&
          Date.now() - this.installedRegistry.getLastScanTimestamp() > FOCUS_RESCAN_COOLDOWN_MS
        ) {
          this.scanAllInstalledGames().catch(() => {});
        }
      };
      window.addEventListener('focus', this.focusListener);
    }

    if (typeof window !== 'undefined' && window.electronAPI) {
      if (!this.unsubscribeDownload && window.electronAPI.onDownloadUpdated) {
        this.unsubscribeDownload = window.electronAPI.onDownloadUpdated((data) => {
          this.handleDownloadUpdated(data);
        });
      }

      if (!this.unsubscribeSession && window.electronAPI.onSessionUpdated) {
        this.unsubscribeSession = window.electronAPI.onSessionUpdated((data) => {
          this.handleSessionUpdated(data);
        });
      }

      this.runnerClient.ensureRunnerProgressSubscription(this.createRunnerClientContext());

      if (!this.unsubscribeHibernate && window.electronAPI.onHibernateStateChanged) {
        this.unsubscribeHibernate = window.electronAPI.onHibernateStateChanged(
          (data: HibernateStatePayload) => {
            const nextHibernating = Boolean(
              data?.hibernating ?? data?.hibernated ?? data?.isHibernated
            );
            this.sessionManager.applyHibernationState(
              nextHibernating,
              this.createSessionManagerContext(),
              data
            );
          }
        );
      }

      try {
        const [
          configs,
          running,
          queue,
          layers,
          perfSettings,
          pendingSessions,
          detectedClients,
          appInfo,
        ] = await Promise.all([
          window.electronAPI.getGameLaunchConfigs
            ? window.electronAPI.getGameLaunchConfigs()
            : Promise.resolve({}),
          window.electronAPI.getRunningGames
            ? window.electronAPI.getRunningGames()
            : Promise.resolve([]),
          window.electronAPI.getDownloadQueue
            ? window.electronAPI.getDownloadQueue()
            : Promise.resolve([]),
          this.getHostCapabilities().supportsWindowsTranslation &&
          window.electronAPI.detectCompatibilityLayers
            ? window.electronAPI.detectCompatibilityLayers()
            : Promise.resolve([]),
          window.electronAPI.getLauncherPerformanceSettings
            ? window.electronAPI.getLauncherPerformanceSettings().catch(() => null)
            : Promise.resolve(null),
          window.electronAPI.drainPendingSessions
            ? window.electronAPI.drainPendingSessions().catch(() => [])
            : Promise.resolve([]),
          window.electronAPI.detectInstalledStorefrontClients
            ? window.electronAPI.detectInstalledStorefrontClients().catch(() => null)
            : Promise.resolve(null),
          this.getAppInfo(),
        ]);

        if (appInfo && typeof (appInfo as AppInfoResult).arch === 'string') {
          const prevArch = this.detectedHostArch;
          this.detectedHostArch = (appInfo as AppInfoResult).arch;
          if (prevArch !== this.detectedHostArch) {
            this.notifyStateChanged();
          }
        }

        if (perfSettings && typeof perfSettings === 'object') {
          const remotePerf: Partial<LauncherPerformanceSettings> =
            perfSettings.settings && typeof perfSettings.settings === 'object'
              ? perfSettings.settings
              : perfSettings;
          if (remotePerf && typeof remotePerf === 'object') {
            this.performanceSettings = this.sanitizePerformanceSettings({
              ...this.performanceSettings,
              ...remotePerf,
            });
            this.persistLocalPerformanceSettings();
          }
        }

        if (configs && typeof configs === 'object') {
          const diskConfigs = configs as Record<string, GameLaunchConfig>;
          if (typeof window.electronAPI.getGameLaunchConfigs === 'function') {
            this.launchConfigs = reconcileLaunchConfigsWithDisk(
              this.launchConfigs,
              diskConfigs,
              true
            ).configs;
            this.lastConfigsFetchedAt = Date.now();
          } else {
            this.launchConfigs = {
              ...this.launchConfigs,
              ...diskConfigs,
            };
          }
          this.persistLocalConfigs();
        }

        if (Array.isArray(running)) {
          this.sessionManager.replaceActiveSessions(running);
        }

        if (Array.isArray(queue)) {
          this.downloadManager.setQueue(queue);
        }

        if (Array.isArray(layers)) {
          this.runnerClient.setCompatibilityLayers(layers);
        }

        if (detectedClients && typeof detectedClients === 'object') {
          this.runnerClient.applyDetectedStorefrontClients(detectedClients);
        }

        this.sessionManager.processDrainedPendingSessions(
          pendingSessions,
          this.createSessionManagerContext()
        );
      } catch (err) {
        console.warn('[LauncherService] Initialization sync warning:', err);
      }

      this.syncInGameResourceThrottle();
      this.installedRegistry.setLastScanTimestamp(0);
      if (this.sessionManager.getActiveSessionsMap().size === 0) {
        await this.scanAllInstalledGames(true, { silentInitialBoot: true });
      }
      this.ensureActiveDownloadPolling();
    }

    this.initialized = true;
    this.notifyStateChanged();
  }

  private handleDownloadUpdated(data: {
    task?: DownloadTaskState;
    queue?: DownloadTaskState[];
  }): void {
    this.downloadManager.handleDownloadUpdated(data, this.createDownloadManagerContext());
  }

  private handleSessionUpdated(data: SessionUpdatedPayload): void {
    this.sessionManager.handleSessionUpdated(data, this.createSessionManagerContext());
  }

  public getHostPlatform(): HostPlatform {
    return resolveHostPlatform();
  }

  public getHostArch(): HostArch {
    return resolveHostArch(undefined, this.detectedHostArch);
  }

  public isWindowsHost(): boolean {
    return this.getHostPlatform() === 'win32';
  }

  public getHostCapabilities(explicitPlatform?: HostPlatform): HostPlatformCapabilities {
    const platform: HostPlatform =
      explicitPlatform === 'darwin' || explicitPlatform === 'win32' || explicitPlatform === 'linux'
        ? explicitPlatform
        : this.isWindowsHost()
          ? 'win32'
          : this.getHostPlatform();
    return buildHostCapabilities(platform, this.getHostArch());
  }

  public hasAuthoritativeInstallScan(): boolean {
    return this.installedRegistry.hasAuthoritativeInstallScan();
  }

  public async scanAllInstalledGames(
    forceRefresh = false,
    options?: { silentInitialBoot?: boolean }
  ): Promise<InstalledGameRecord[]> {
    return this.installedRegistry.scanAllInstalledGames(
      forceRefresh,
      options,
      this.createInstalledRegistryContext()
    );
  }

  public async detectCompatibilityLayers(): Promise<CompatibilityLayerInfo[]> {
    return this.runnerClient.detectCompatibilityLayers(this.createRunnerClientContext());
  }

  public getCompatibilityLayers(): CompatibilityLayerInfo[] {
    return this.runnerClient.getCompatibilityLayers();
  }

  public getInstalledStorefrontClients(): Partial<Record<StorefrontId, boolean>> {
    return { ...this.installedStorefrontClients };
  }

  public async detectInstalledStorefrontClients(): Promise<
    Partial<Record<StorefrontId, boolean>>
  > {
    return this.runnerClient.detectInstalledStorefrontClients(this.createRunnerClientContext());
  }

  public getActiveRunnerOperations(): Partial<
    Record<Exclude<CompatibilityLayerType, 'native'>, CompatibilityRunnerProgressEvent>
  > {
    return this.runnerClient.getActiveRunnerOperations(this.createRunnerClientContext());
  }

  public getActiveRunnerOperation(
    runnerType: Exclude<CompatibilityLayerType, 'native'>
  ): CompatibilityRunnerProgressEvent | undefined {
    return this.runnerClient.getActiveRunnerOperation(
      runnerType,
      this.createRunnerClientContext()
    );
  }

  public onRunnerProgress(
    listener: (event: CompatibilityRunnerProgressEvent) => void
  ): () => void {
    return this.runnerClient.onRunnerProgress(listener, this.createRunnerClientContext());
  }

  public registerPostRunnerMutationSyncHook(hook: () => Promise<void>): () => void {
    return this.runnerClient.registerPostRunnerMutationSyncHook(hook);
  }

  public async cancelCompatibilityLayerOperation(
    runnerType: Exclude<CompatibilityLayerType, 'native'>
  ): Promise<{ success: boolean; cancelled: boolean }> {
    return this.runnerClient.cancelCompatibilityLayerOperation(
      runnerType,
      this.createRunnerClientContext()
    );
  }

  public async installCompatibilityLayer(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    mode: 'auto' | 'direct' | 'download' = 'auto',
    options?: { dmgPath?: string; archivePath?: string; authenticateOnly?: boolean }
  ): Promise<InstallCompatibilityLayerResult> {
    return this.runnerClient.installCompatibilityLayer(
      runnerType,
      mode,
      options,
      this.createRunnerClientContext()
    );
  }

  public getRunnerUpdates(): Record<string, CompatibilityLayerUpdateInfo> {
    return this.runnerUpdates;
  }

  public async checkCompatibilityLayerUpdates(): Promise<
    Record<string, CompatibilityLayerUpdateInfo>
  > {
    return this.runnerClient.checkCompatibilityLayerUpdates(this.createRunnerClientContext());
  }

  public async updateCompatibilityLayer(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    options?: {
      dmgPath?: string;
      archivePath?: string;
      switchToStableCrossOver?: boolean;
      authenticateOnly?: boolean;
    }
  ): Promise<UpdateCompatibilityLayerResult> {
    return this.runnerClient.updateCompatibilityLayer(
      runnerType,
      options,
      this.createRunnerClientContext()
    );
  }

  public getInstalledRecords(): InstalledGameRecord[] {
    return this.installedRegistry.getRecords();
  }

  public getInstalledRecordForGame(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ): InstalledGameRecord | undefined {
    return this.installedRegistry.getInstalledRecordForGame(
      game,
      preferredPlatformId,
      this.createInstalledRegistryContext()
    );
  }

  public getSelectedStorefrontForGame(gameOrId: CanonicalGame | string): StorefrontId | undefined {
    if (typeof gameOrId === 'string') {
      return gameOrId ? loadSelectedStorefrontsFromStorage()[gameOrId] : undefined;
    }
    const game = gameOrId;
    if (!game || !Array.isArray(game.platforms) || game.platforms.length === 0) {
      return undefined;
    }
    const remembered = loadSelectedStorefrontsFromStorage()[game.id];
    if (remembered && game.platforms.some((p) => p.platformId === remembered)) {
      return remembered;
    }
    return this.getEffectivePlatformForGame(game)?.platformId || game.platforms[0]?.platformId;
  }

  public setSelectedStorefrontForGame(gameId: string, platformId: StorefrontId | null): void {
    if (!gameId) return;
    if (!platformId) {
      clearSelectedStorefrontFromStorage(gameId);
      return;
    }
    persistSelectedStorefrontToStorage(gameId, platformId);
  }

  public getEffectivePlatformForGame(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ): GamePlatformOwnership | undefined {
    return this.installedRegistry.getEffectivePlatformForGame(
      game,
      preferredPlatformId,
      this.createInstalledRegistryContext()
    );
  }

  public isGameInstalled(game: CanonicalGame, platformId?: StorefrontId): boolean {
    return this.installedRegistry.isGameInstalled(
      game,
      platformId,
      this.createInstalledRegistryContext()
    );
  }

  public isGameRunning(gameId: string, platformId?: StorefrontId): boolean {
    return this.sessionManager.isGameRunning(gameId, platformId);
  }

  public getActiveSession(gameId: string, platformId?: StorefrontId): ActiveGameSession | undefined {
    return this.sessionManager.getActiveSession(gameId, platformId);
  }

  public getRunningGames(): ActiveGameSession[] {
    return this.sessionManager.getRunningGames();
  }

  public getActiveDownload(gameId: string, platformId?: StorefrontId): DownloadTaskState | undefined {
    return this.downloadManager.getActiveDownload(gameId, platformId);
  }

  public getDownloadQueue(): DownloadTaskState[] {
    return this.downloadManager.getQueue();
  }

  public async getDiskSpace(targetPath?: string): Promise<DiskSpaceInfo | null> {
    return this.downloadManager.getDiskSpace(targetPath, this.isWindowsHost());
  }

  public async getGameInstallInfo(
    game: CanonicalGame,
    platformId?: StorefrontId,
    targetInstallDir?: string
  ): Promise<GameInstallInfo> {
    return this.downloadManager.getGameInstallInfo(
      game,
      platformId,
      targetInstallDir,
      this.createDownloadManagerContext()
    );
  }

  public getCachedInstallInfo(
    gameId?: string,
    platformId?: StorefrontId
  ): GameInstallInfo | undefined {
    return this.downloadManager.getCachedInstallInfo(gameId, platformId);
  }

  public launchGame(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<LauncherActionResult> {
    return this.sessionManager.launchGame(game, platformId, this.createSessionManagerContext());
  }

  public async stopGame(gameId: string): Promise<LauncherActionResult> {
    return this.sessionManager.stopGame(gameId, this.createSessionManagerContext());
  }

  public async toggleSessionFullscreen(
    gameId: string,
    options?: { fullscreen?: boolean; aspectRatio?: GlobalDisplayAspectRatioMode }
  ): Promise<ToggleSessionFullscreenResult> {
    return this.sessionManager.toggleSessionFullscreen(
      gameId,
      options,
      this.createSessionManagerContext()
    );
  }

  public async startInstall(request: InstallGameRequest): Promise<LauncherActionResult> {
    return this.downloadManager.startInstall(request, this.createDownloadManagerContext());
  }

  public async installGame(request: InstallGameRequest): Promise<LauncherActionResult> {
    return this.startInstall(request);
  }

  public async pauseDownload(taskId: string): Promise<LauncherActionResult> {
    return this.downloadManager.pauseDownload(taskId, this.createDownloadManagerContext());
  }

  public async resumeDownload(taskId: string): Promise<LauncherActionResult> {
    return this.downloadManager.resumeDownload(taskId, this.createDownloadManagerContext());
  }

  public async cancelDownload(taskId: string): Promise<LauncherActionResult> {
    return this.downloadManager.cancelDownload(taskId, this.createDownloadManagerContext());
  }

  public clearCompletedDownloads(): void {
    this.downloadManager.clearCompletedDownloads(this.createDownloadManagerContext());
  }

  public setManualInstallStatus(
    game: CanonicalGame,
    installed: boolean,
    platformId?: StorefrontId
  ): void {
    this.installedRegistry.setManualInstallStatus(
      game,
      installed,
      platformId,
      this.createInstalledRegistryContext()
    );
  }

  public async uninstallGame(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<LauncherActionResult> {
    return this.sessionManager.uninstallGame(
      game,
      platformId,
      this.createSessionManagerContext()
    );
  }

  public async verifyGameFiles(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<LauncherActionResult> {
    return this.sessionManager.verifyGameFiles(
      game,
      platformId,
      this.createSessionManagerContext()
    );
  }

  public async browseLocalFiles(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<boolean> {
    return this.sessionManager.browseLocalFiles(
      game,
      platformId,
      this.createSessionManagerContext()
    );
  }

  public async locateInstalledGame(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<string | null> {
    return this.sessionManager.locateInstalledGame(
      game,
      platformId,
      this.createSessionManagerContext()
    );
  }

  public async selectExecutable(defaultPath?: string): Promise<string | null> {
    if (typeof window !== 'undefined' && window.electronAPI?.selectExecutableDialog) {
      return await window.electronAPI.selectExecutableDialog(defaultPath);
    }
    return null;
  }

  public async selectRunnerArchive(defaultPath?: string): Promise<string | null> {
    if (typeof window !== 'undefined') {
      if (typeof window.electronAPI?.selectRunnerArchiveDialog === 'function') {
        return await window.electronAPI.selectRunnerArchiveDialog(defaultPath);
      }
      if (typeof window.electronAPI?.selectExecutableDialog === 'function') {
        return await window.electronAPI.selectExecutableDialog(defaultPath);
      }
    }
    return null;
  }

  public async selectFolder(defaultPath?: string): Promise<string | null> {
    if (typeof window !== 'undefined' && window.electronAPI?.selectFolderDialog) {
      return await window.electronAPI.selectFolderDialog(defaultPath);
    }
    return null;
  }

  public extractStorefrontProfile(
    config: Partial<GameLaunchConfig | StorefrontLaunchProfile>,
    platformId?: StorefrontId
  ): StorefrontLaunchProfile {
    return extractStorefrontProfileFromConfig(config, platformId);
  }

  public async saveLaunchConfig(
    config: GameLaunchConfig,
    platformId?: StorefrontId
  ): Promise<void> {
    if (!config || !config.gameId) return;
    const nextConfig = sanitizeGameLaunchConfig(
      buildMergedSaveLaunchConfig(this.launchConfigs[config.gameId], config, platformId)
    );

    this.launchConfigs[config.gameId] = nextConfig;
    this.persistLocalConfigs();

    if (typeof window !== 'undefined' && window.electronAPI?.saveGameLaunchConfig) {
      try {
        await window.electronAPI.saveGameLaunchConfig(nextConfig);
      } catch (err) {
        console.warn('[LauncherService] Failed to save launch config via IPC:', err);
      }
    }

    this.notifyStateChanged();
  }

  public async resetLaunchConfig(gameId: string, platformId?: StorefrontId): Promise<void> {
    if (!gameId) return;

    if (platformId && this.launchConfigs[gameId]?.platformConfigs) {
      const nextPlatformConfigs = { ...this.launchConfigs[gameId].platformConfigs };
      delete nextPlatformConfigs[platformId];
      const remainingIds = Object.keys(nextPlatformConfigs) as StorefrontId[];

      if (remainingIds.length > 0) {
        const fallbackPlatId = remainingIds[0];
        const fallbackProfile = nextPlatformConfigs[fallbackPlatId] || { launchMethod: 'auto' };
        const updatedConfig: GameLaunchConfig = sanitizeGameLaunchConfig({
          gameId,
          preferredPlatformId: fallbackPlatId,
          launchMethod: fallbackProfile.launchMethod || 'auto',
          ...fallbackProfile,
          platformConfigs: nextPlatformConfigs,
        });
        this.launchConfigs[gameId] = updatedConfig;
        this.persistLocalConfigs();

        if (typeof window !== 'undefined' && window.electronAPI?.saveGameLaunchConfig) {
          try {
            await window.electronAPI.saveGameLaunchConfig({
              ...updatedConfig,
              resetPlatformId: platformId,
            });
          } catch (err) {
            console.warn('[LauncherService] Failed to reset platform launch config via IPC:', err);
          }
        }

        this.notifyStateChanged();
        return;
      }
    }

    delete this.launchConfigs[gameId];
    this.persistLocalConfigs();

    if (typeof window !== 'undefined' && window.electronAPI?.saveGameLaunchConfig) {
      try {
        const resetRequest: GameLaunchConfigResetRequest = {
          gameId,
          launchMethod: 'auto',
          reset: true,
        };
        await window.electronAPI.saveGameLaunchConfig(resetRequest);
      } catch (err) {
        console.warn('[LauncherService] Failed to reset launch config via IPC:', err);
      }
    }

    this.notifyStateChanged();
  }

  public getLaunchConfig(
    gameId: string,
    platformId?: StorefrontId
  ): GameLaunchConfig | undefined {
    return resolveLaunchConfigFromMap(this.launchConfigs, gameId, platformId);
  }

  public getAllLaunchConfigs(): Record<string, GameLaunchConfig> {
    return { ...this.launchConfigs };
  }

  public getFastMinimalLaunchAdvisory(
    params: FastMinimalLaunchAdvisoryParams
  ): FastMinimalLaunchAdvisory {
    return computeFastMinimalLaunchAdvisory(
      params,
      this.getPerformanceSettings().storefrontClientLifecycle
    );
  }

  public getStorefrontLaunchPolicyView(
    params: BuildStorefrontLaunchPolicyViewParams
  ): StorefrontLaunchPolicyView {
    return buildStorefrontLaunchPolicyView(params);
  }

  public resolveEffectiveLaunchModePreview(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId,
    draftConfig?: Partial<GameLaunchConfig>
  ): ResolvedLaunchModePreview {
    const hostPlatform = this.getHostPlatform();
    const baseConfig = game ? this.getLaunchConfig(game.id) : undefined;
    const targetPlatformId =
      preferredPlatformId ||
      draftConfig?.preferredPlatformId ||
      baseConfig?.preferredPlatformId;
    const savedConfig = game ? this.getLaunchConfig(game.id, targetPlatformId) : undefined;
    const installedRecord = game
      ? this.getInstalledRecordForGame(game, targetPlatformId)
      : undefined;
    const effPlatform = game
      ? this.getEffectivePlatformForGame(game, targetPlatformId)
      : undefined;
    const platformIdForCache: StorefrontId =
      targetPlatformId ||
      installedRecord?.platformId ||
      effPlatform?.platformId ||
      (game?.steamAppId ? 'steam' : 'custom');
    const perfSettings = this.getPerformanceSettings();

    return buildEffectiveLaunchModePreview({
      game,
      hostPlatform,
      hostArch: this.getHostArch(),
      preferredPlatformId,
      baseConfig,
      savedConfig,
      draftConfig,
      installedRecord,
      effPlatform,
      layers: this.getCompatibilityLayers(),
      cachedInstallInfo: this.getCachedInstallInfo(game?.id, platformIdForCache),
      globalStorefrontLifecycle: perfSettings.storefrontClientLifecycle,
      globalDisplayScalingMode: perfSettings.defaultBottleDisplayScalingMode,
      globalDisplayAspectRatio: perfSettings.defaultDisplayAspectRatio,
      globalDefaultPerformanceHud: perfSettings.defaultPerformanceHud,
      installedStorefrontClients: this.runnerClient.getRawInstalledStorefrontClients(),
    });
  }

  public openDownloadDrawer(): void {
    dispatchOpenDownloadDrawerEvent();
  }
}

export const launcherService = new LauncherService();
