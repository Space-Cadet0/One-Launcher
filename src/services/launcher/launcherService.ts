import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  resolveEffectiveLaunchPolicy,
  resolveEffectiveLifecyclePolicy,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  type ActiveGameSession,
  type AppInfoResult,
  type CloudSaveSyncTelemetry,
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
  type CompatibilityLayerUpdateInfo,
  type DiskSpaceInfo,
  type DownloadTaskState,
  type FastMinimalLaunchAdvisory,
  type GameInstallInfo,
  type GameLaunchConfig,
  type GameLaunchConfigResetRequest,
  type HibernateStatePayload,
  type InstallCompatibilityLayerResult,
  type InstalledGameRecord,
  type InstallGameRequest,
  type LauncherActionResult,
  type LauncherPerformanceSettings,
  type LaunchMethod,
  type ResolvedLaunchModePreview,
  type SessionUpdatedEventType,
  type SessionUpdatedPayload,
  type StorefrontLaunchPolicyView,
  type StorefrontLaunchProfile,
  type UpdateCompatibilityLayerResult,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';
import { requestScheduler } from '../network/requestScheduler';
import { syncJobManager } from '../network/syncJobManager';
import {
  getStorefrontNativeOsFlags,
  saveCachedGogOsSupport,
} from '../platform/nativeOsService';
import { steamApi } from '../steam/steamApi';
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
  sanitizeGameLaunchConfig,
  sanitizeLegacyCompatLayer,
  sanitizePerformanceSettings as sanitizePerformanceSettingsEntry,
  sanitizeStorefrontLifecycleOverride,
  sanitizeWineDebugMode,
} from './launchConfigStore';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  buildEffectiveLaunchModePreview,
  buildStorefrontLaunchPolicyConfig,
  buildStorefrontLaunchPolicyView,
  computeFastMinimalLaunchAdvisory,
  type BuildEffectiveLaunchModePreviewParams,
  type BuildLaunchModePreviewParams,
  type BuildStorefrontLaunchPolicyViewParams,
  type FastMinimalLaunchAdvisoryParams,
} from './launchPolicyPreview';
import { sanitizeGameInstallSizeBytes } from '../../utils/formatBytes';

function sanitizeGameInstallInfo(info: GameInstallInfo): GameInstallInfo {
  return {
    ...info,
    estimatedSizeBytes: sanitizeGameInstallSizeBytes(info.estimatedSizeBytes),
    downloadSizeBytes: sanitizeGameInstallSizeBytes(info.downloadSizeBytes),
    dlcSizeBytes: sanitizeGameInstallSizeBytes(info.dlcSizeBytes),
    ...(Array.isArray(info.availableInstallers)
      ? {
          availableInstallers: info.availableInstallers.map((ins) => ({
            ...ins,
            totalSizeBytes: sanitizeGameInstallSizeBytes(ins.totalSizeBytes),
            downloadSizeBytes: sanitizeGameInstallSizeBytes(ins.downloadSizeBytes),
            dlcSizeBytes: sanitizeGameInstallSizeBytes(ins.dlcSizeBytes),
          })),
        }
      : {}),
  };
}

export type {
  FastMinimalLaunchAdvisory,
  StorefrontLaunchPolicyView,
  StorefrontPolicyInfoBox,
  StorefrontPolicyInfoKey,
  StorefrontPolicyOptionDescriptor,
} from '../../contracts/launcher';
export {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  LAUNCH_CONFIGS_STORAGE_KEY,
  PERF_SETTINGS_STORAGE_KEY,
  SELECTED_STOREFRONTS_STORAGE_KEY,
  buildEffectiveLaunchModePreview,
  buildStorefrontLaunchPolicyConfig,
  buildStorefrontLaunchPolicyView,
  computeFastMinimalLaunchAdvisory,
  resolveEffectiveLaunchPolicy,
  resolveEffectiveLifecyclePolicy,
  sanitizeGameLaunchConfig,
  sanitizeLaunchMethod,
  sanitizeLegacyCompatLayer,
  sanitizeStorefrontLifecycleOverride,
  sanitizeStorefrontLifecyclePolicy,
  sanitizeWineDebugMode,
  type BuildEffectiveLaunchModePreviewParams,
  type BuildLaunchModePreviewParams,
  type BuildStorefrontLaunchPolicyViewParams,
  type FastMinimalLaunchAdvisoryParams,
};

const NORMALIZED_TITLE_CACHE = new Map<string, string>();
const MAX_NORMALIZED_TITLE_CACHE_SIZE = 2500;

function normalizeTitleForMatch(title?: string): string {
  if (!title) return '';
  const cached = NORMALIZED_TITLE_CACHE.get(title);
  if (cached !== undefined) return cached;
  const normalized = title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (NORMALIZED_TITLE_CACHE.size >= MAX_NORMALIZED_TITLE_CACHE_SIZE) {
    NORMALIZED_TITLE_CACHE.clear();
  }
  NORMALIZED_TITLE_CACHE.set(title, normalized);
  return normalized;
}

interface InstalledLookupIndex {
  byPlatGameKey: Map<string, InstalledGameRecord>;
  bySteamAppId: Map<number, InstalledGameRecord>;
  byPlatInstallPath: Map<string, InstalledGameRecord>;
  byPlatExePath: Map<string, InstalledGameRecord>;
  byPlatNormTitle: Map<string, InstalledGameRecord>;
}

export class LauncherService {
  public static readonly MAX_INSTALL_INFO_CACHE_SIZE = 150;
  private installedRecords: InstalledGameRecord[] = [];
  private installedIndexMutationSeq = 0;
  private installedIndexBuiltSeq = -1;
  private installedIndexRecordsRef: InstalledGameRecord[] | null = null;
  private installedIndexRecordsLen = -1;
  private installedLookupIndex: InstalledLookupIndex = {
    byPlatGameKey: new Map(),
    bySteamAppId: new Map(),
    byPlatInstallPath: new Map(),
    byPlatExePath: new Map(),
    byPlatNormTitle: new Map(),
  };
  private epicPlatformSupportMap: Record<string, { windows: boolean; mac: boolean }> = {};
  private activeSessions: Map<string, ActiveGameSession> = new Map();
  private downloadQueue: DownloadTaskState[] = [];
  private launchConfigs: Record<string, GameLaunchConfig> = {};
  private performanceSettings: LauncherPerformanceSettings = {
    ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  };
  private inGameHibernating = false;
  private inGamePriorityScopeRelease: (() => void) | null = null;
  private downloadsPausedByInGame: Set<string> = new Set();
  private compatibilityLayers: CompatibilityLayerInfo[] = [];
  private installedStorefrontClients: Partial<Record<StorefrontId, boolean>> = {};
  private runnerUpdates: Record<string, CompatibilityLayerUpdateInfo> = {};
  private installInfoCache: Map<string, GameInstallInfo> = new Map();
  private listeners: Set<() => void> = new Set();
  private initialized = false;
  private unsubscribeDownload?: () => void;
  private unsubscribeSession?: () => void;
  private unsubscribeHibernate?: () => void;
  private focusListener?: () => void;
  private activeDownloadPollTimer?: ReturnType<typeof setInterval> | null;
  private inFlightScanPromise: Promise<InstalledGameRecord[]> | null = null;
  private lastScanTimestamp = 0;
  private lastScanSucceeded = false;
  private detectedHostArch?: string;

  constructor() {
    this.loadLocalConfigs();
  }

  private getErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message) return err.message;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      const msg = (err as { message: string }).message;
      if (msg) return msg;
    }
    return fallback;
  }

  private attachEpicPlatformSupportMetadata(
    records: InstalledGameRecord[]
  ): InstalledGameRecord[] {
    if (Object.keys(this.epicPlatformSupportMap).length > 0) {
      Object.defineProperty(records, 'epicPlatformSupport', {
        value: this.epicPlatformSupportMap,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return records;
  }

  public getEpicPlatformSupport(): Record<string, { windows: boolean; mac: boolean }> {
    return { ...this.epicPlatformSupportMap };
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
        const resRecord =
          res && typeof res === 'object' ? (res as unknown as Record<string, unknown>) : null;
        const saved =
          resRecord?.settings && typeof resRecord.settings === 'object'
            ? (resRecord.settings as Partial<LauncherPerformanceSettings>)
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
    return this.inGameHibernating;
  }

  public setInGameHibernating(hibernating: boolean): void {
    const next = Boolean(hibernating);
    const transitionedToTrue = !this.inGameHibernating && next;
    const transitionedToFalse = this.inGameHibernating && !next;
    this.inGameHibernating = next;

    if (this.inGameHibernating) {
      if (this.activeDownloadPollTimer) {
        clearInterval(this.activeDownloadPollTimer);
        this.activeDownloadPollTimer = null;
      }
      if (transitionedToTrue) {
        window.electronAPI?.clearRendererImageCache?.()?.catch?.(() => {});
      }
    } else if (transitionedToFalse) {
      this.ensureActiveDownloadPolling();
    }

    this.emitStateChanged();
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:hibernate-state-changed', {
          detail: {
            hibernating: this.inGameHibernating,
            hibernated: this.inGameHibernating,
            isHibernated: this.inGameHibernating,
          },
        })
      );
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitStateChanged(): void {
    this.notifyStateChanged();
  }

  private notifyStateChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:launcher-state-changed', {
          detail: {
            runningGames: this.getRunningGames(),
            downloadQueue: this.getDownloadQueue(),
            installedRecords: this.installedRecords,
            inGameHibernating: this.inGameHibernating,
            performanceSettings: this.getPerformanceSettings(),
          },
        })
      );
    }
  }

  private syncInGameResourceThrottle(): void {
    if (this.activeSessions.size > 0) {
      if (typeof document !== 'undefined') {
        document.body?.classList.add('is-in-game');
      }

      const activeSession = Array.from(this.activeSessions.values())[0];
      const activeConfig = activeSession
        ? this.getLaunchConfig(activeSession.gameId, activeSession.platformId)
        : undefined;
      const effectiveBehavior =
        activeConfig?.inGameLauncherBehavior && activeConfig.inGameLauncherBehavior !== 'default'
          ? activeConfig.inGameLauncherBehavior
          : this.performanceSettings.inGameLauncherBehavior;

      void effectiveBehavior;

      if (this.performanceSettings.pauseBackgroundSyncInGame !== false) {
        requestScheduler.setInGameThrottle(true);
        if (!this.inGamePriorityScopeRelease) {
          const activeTitle = activeSession?.title || 'Active Game';
          const scopeHandle = syncJobManager.beginPriorityScope(
            'In-Game Performance Mode',
            activeTitle
          ) as unknown;
          this.inGamePriorityScopeRelease = () => {
            if (typeof scopeHandle === 'function') {
              scopeHandle();
            } else if (typeof scopeHandle === 'string') {
              syncJobManager.endPriorityScope(scopeHandle);
            }
          };
        }
      } else {
        requestScheduler.setInGameThrottle(false);
        if (this.inGamePriorityScopeRelease) {
          try {
            this.inGamePriorityScopeRelease();
          } catch {}
          this.inGamePriorityScopeRelease = null;
        }
      }

      if (this.performanceSettings.pauseDownloadsInGame !== false) {
        for (const task of this.downloadQueue) {
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
        document.body?.classList.remove('is-in-game');
      }
      const wasHibernating = this.inGameHibernating;
      this.inGameHibernating = false;
      requestScheduler.setInGameThrottle(false);

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

  private hasActiveDownloads(): boolean {
    return this.downloadQueue.some(
      (t) =>
        t.status === 'downloading' ||
        t.status === 'queued' ||
        t.status === 'extracting' ||
        t.status === 'verifying'
    );
  }

  private ensureActiveDownloadPolling(): void {
    if (this.inGameHibernating || !this.hasActiveDownloads()) {
      if (this.activeDownloadPollTimer) {
        clearInterval(this.activeDownloadPollTimer);
        this.activeDownloadPollTimer = null;
      }
      return;
    }

    if (this.activeDownloadPollTimer || typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    const timer = setInterval(async () => {
      if (this.inGameHibernating || !this.hasActiveDownloads()) {
        if (this.activeDownloadPollTimer) {
          clearInterval(this.activeDownloadPollTimer);
          this.activeDownloadPollTimer = null;
        }
        return;
      }

      try {
        if (window.electronAPI?.getDownloadQueue) {
          const latestQueue = await window.electronAPI.getDownloadQueue();
          if (Array.isArray(latestQueue) && latestQueue.length > 0) {
            this.handleDownloadUpdated({ queue: latestQueue });
          }
        }
      } catch {}
    }, 3500);

    const maybeNodeTimer = timer as unknown as { unref?: () => void };
    if (maybeNodeTimer && typeof maybeNodeTimer.unref === 'function') {
      maybeNodeTimer.unref();
    }
    this.activeDownloadPollTimer = timer;
  }

  public async initialize(): Promise<void> {
    this.loadLocalConfigs();

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !this.focusListener) {
      this.focusListener = () => {
        if (this.activeSessions.size > 0) return;
        if (!this.inFlightScanPromise && Date.now() - this.lastScanTimestamp > 30000) {
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

      if (!this.unsubscribeHibernate && window.electronAPI.onHibernateStateChanged) {
        this.unsubscribeHibernate = window.electronAPI.onHibernateStateChanged(
          (data: HibernateStatePayload) => {
            const nextHibernating = Boolean(
              data?.hibernating ?? data?.hibernated ?? data?.isHibernated
            );
            const transitionedToTrue = !this.inGameHibernating && nextHibernating;
            const transitionedToFalse = this.inGameHibernating && !nextHibernating;
            this.inGameHibernating = nextHibernating;
            if (this.inGameHibernating) {
              if (this.activeDownloadPollTimer) {
                clearInterval(this.activeDownloadPollTimer);
                this.activeDownloadPollTimer = null;
              }
              if (transitionedToTrue) {
                window.electronAPI?.clearRendererImageCache?.()?.catch?.(() => {});
              }
            } else if (transitionedToFalse) {
              this.ensureActiveDownloadPolling();
            }
            this.emitStateChanged();
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              window.dispatchEvent(
                new CustomEvent('antigravity:hibernate-state-changed', {
                  detail: {
                    ...data,
                    hibernating: this.inGameHibernating,
                    hibernated: this.inGameHibernating,
                  },
                })
              );
            }
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
          window.electronAPI.getAppInfo
            ? window.electronAPI.getAppInfo().catch(() => null)
            : Promise.resolve(null),
        ]);

        if (appInfo && typeof (appInfo as AppInfoResult).arch === 'string') {
          this.detectedHostArch = (appInfo as AppInfoResult).arch;
        }

        if (perfSettings && typeof perfSettings === 'object') {
          const perfRecord = perfSettings as unknown as Record<string, unknown>;
          const remotePerf =
            perfRecord.settings && typeof perfRecord.settings === 'object'
              ? (perfRecord.settings as Partial<LauncherPerformanceSettings>)
              : (perfSettings as Partial<LauncherPerformanceSettings>);
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
          } else {
            this.launchConfigs = {
              ...this.launchConfigs,
              ...diskConfigs,
            };
          }
          this.persistLocalConfigs();
        }

        if (Array.isArray(running)) {
          this.activeSessions.clear();
          for (const s of running) {
            if (s && s.gameId) {
              this.activeSessions.set(s.gameId, s);
            }
          }
        }

        if (Array.isArray(queue)) {
          this.downloadQueue = queue;
        }

        if (Array.isArray(layers)) {
          this.compatibilityLayers = layers;
        }

        if (detectedClients && typeof detectedClients === 'object') {
          const nextClients: Partial<Record<StorefrontId, boolean>> = {};
          const clientsMap = detectedClients as Record<string, unknown>;
          for (const key of ['steam', 'gog', 'epic', 'xbox'] as const) {
            if (typeof clientsMap[key] === 'boolean') {
              nextClients[key] = clientsMap[key] as boolean;
            }
          }
          this.installedStorefrontClients = nextClients;
        }

        type DrainedSessionItem = {
          session?: ActiveGameSession;
          sessionId?: string;
          gameId?: string;
          title?: string;
          platformId?: StorefrontId;
          platformGameId?: string;
          startedAt?: string;
          endedAt?: string;
          lastPlayed?: string;
          launchMethod?: string;
          event?: SessionUpdatedEventType;
          sessionMinutesPlayed?: number;
          durationSeconds?: number;
          storefrontTotalPlaytimeMinutes?: number | null;
          cloudSync?: CloudSaveSyncTelemetry;
          statusMessage?: string;
          error?: string;
        };

        const pendingContainer =
          pendingSessions && !Array.isArray(pendingSessions) && typeof pendingSessions === 'object'
            ? (pendingSessions as {
                pendingSessions?: DrainedSessionItem[];
                sessions?: DrainedSessionItem[];
              })
            : null;
        const drainedList: DrainedSessionItem[] = Array.isArray(pendingSessions)
          ? (pendingSessions as DrainedSessionItem[])
          : Array.isArray(pendingContainer?.pendingSessions)
            ? pendingContainer.pendingSessions
            : Array.isArray(pendingContainer?.sessions)
              ? pendingContainer.sessions
              : [];

        for (const item of drainedList) {
          if (!item) continue;
          const sessionObj: ActiveGameSession | undefined =
            item.session ||
            (item.gameId
              ? {
                  sessionId: item.sessionId || `drained-${item.gameId}-${Date.now()}`,
                  gameId: item.gameId,
                  title: item.title || item.gameId,
                  platformId: (item.platformId || 'steam') as StorefrontId,
                  platformGameId: String(item.platformGameId || item.gameId),
                  startedAt: item.startedAt || new Date().toISOString(),
                  launchMethod: item.launchMethod || 'direct',
                  status: 'stopping',
                  ...(item.cloudSync ? { cloudSync: item.cloudSync } : {}),
                  ...(item.statusMessage ? { statusMessage: item.statusMessage } : {}),
                }
              : undefined);
          if (sessionObj || item.cloudSync) {
            this.handleSessionUpdated({
              session: sessionObj,
              event: item.event || 'stopped',
              sessionMinutesPlayed: item.sessionMinutesPlayed ?? 1,
              durationSeconds: item.durationSeconds ?? 60,
              lastPlayed: item.lastPlayed || item.endedAt || new Date().toISOString(),
              storefrontTotalPlaytimeMinutes: item.storefrontTotalPlaytimeMinutes,
              cloudSync: item.cloudSync,
              statusMessage: item.statusMessage,
              error: item.error,
            });
          }
        }
      } catch (err) {
        console.warn('[LauncherService] Initialization sync warning:', err);
      }

      this.syncInGameResourceThrottle();
      this.lastScanTimestamp = 0;
      if (this.activeSessions.size === 0) {
        await this.scanAllInstalledGames(true);
      }
      this.ensureActiveDownloadPolling();
    }

    this.initialized = true;
    this.notifyStateChanged();
  }

  private mergeTaskMonotonically(
    existing: DownloadTaskState | undefined,
    incoming: DownloadTaskState
  ): DownloadTaskState {
    if (
      !existing ||
      existing.status === 'queued' ||
      !['downloading', 'extracting', 'verifying'].includes(incoming.status)
    ) {
      return incoming;
    }
    const progressPercent = Math.max(existing.progressPercent || 0, incoming.progressPercent || 0);
    const bytesDownloaded = Math.max(existing.bytesDownloaded || 0, incoming.bytesDownloaded || 0);
    const totalBytes =
      incoming.totalBytes && incoming.totalBytes > 0
        ? Math.max(incoming.totalBytes, bytesDownloaded)
        : incoming.totalBytes;
    return {
      ...incoming,
      progressPercent,
      bytesDownloaded,
      totalBytes,
    };
  }

  private handleDownloadUpdated(data: { task?: DownloadTaskState; queue?: DownloadTaskState[] }): void {
    const existingById = new Map<string, DownloadTaskState>();
    for (const t of this.downloadQueue) {
      if (t && t.taskId) {
        existingById.set(t.taskId, t);
      }
    }

    if (Array.isArray(data?.queue)) {
      this.downloadQueue = data.queue.map((incoming) =>
        this.mergeTaskMonotonically(existingById.get(incoming.taskId), incoming)
      );
    } else if (data?.task) {
      const mergedTask = this.mergeTaskMonotonically(
        existingById.get(data.task.taskId),
        data.task
      );
      const idx = this.downloadQueue.findIndex((t) => t.taskId === mergedTask.taskId);
      if (idx >= 0) {
        this.downloadQueue[idx] = mergedTask;
      } else {
        this.downloadQueue = [...this.downloadQueue, mergedTask];
      }
    }

    const completedById = new Map<string, DownloadTaskState>();
    if (data?.task && data.task.status === 'completed') {
      completedById.set(data.task.taskId, data.task);
    }
    for (const queuedTask of this.downloadQueue) {
      if (
        queuedTask &&
        queuedTask.status === 'completed' &&
        existingById.get(queuedTask.taskId)?.status !== 'completed'
      ) {
        completedById.set(queuedTask.taskId, queuedTask);
      }
    }

    let shouldRescanInstalled = false;
    for (const task of completedById.values()) {
      const installPath = task.finalInstallPath || task.installDir;
      const isWindowsBinaryOnMac =
        !this.isWindowsHost() &&
        (Boolean(task.isWindowsBinaryOnMac) ||
          Boolean(task.executablePath && /\.exe$/i.test(task.executablePath)) ||
          /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
            String(task.executablePath || installPath || '')
          ));
      const normalizedSteamAppId =
        task.platformId === 'steam'
          ? Number(task.steamAppId || String(task.platformGameId || '').replace(/^steam-/i, '')) ||
            undefined
          : undefined;
      const normalizedPlatformGameId =
        task.platformId === 'steam' && normalizedSteamAppId
          ? String(normalizedSteamAppId)
          : task.platformGameId;

      const taskExt = task as DownloadTaskState & {
        xboxProductId?: string;
        packageFamilyName?: string;
        appUserModelId?: string;
        xboxTitleId?: string;
        scid?: string;
        msaAppId?: string;
        version?: string;
        installRequest?: InstallGameRequest & {
          xboxProductId?: string;
          packageFamilyName?: string;
          appUserModelId?: string;
          xboxTitleId?: string;
          scid?: string;
          msaAppId?: string;
        };
      };
      const taskXboxProductId = taskExt.xboxProductId || taskExt.installRequest?.xboxProductId;
      const taskPackageFamilyName =
        taskExt.packageFamilyName || taskExt.installRequest?.packageFamilyName;
      const taskAppUserModelId = taskExt.appUserModelId || taskExt.installRequest?.appUserModelId;
      const taskXboxTitleId = taskExt.xboxTitleId || taskExt.installRequest?.xboxTitleId;
      const taskScid = taskExt.scid || taskExt.installRequest?.scid;
      const taskMsaAppId = taskExt.msaAppId || taskExt.installRequest?.msaAppId;
      const taskVersion = taskExt.version;

      const sanitizedTaskSize = sanitizeGameInstallSizeBytes(task.totalBytes);
      const newRecord: InstalledGameRecord & { xboxProductId?: string } = {
        platformId: task.platformId,
        platformGameId: normalizedPlatformGameId,
        appId: normalizedSteamAppId,
        title: task.title,
        installPath,
        executablePath: task.executablePath,
        ...(task.launchArguments ? { launchArguments: task.launchArguments } : {}),
        ...(sanitizedTaskSize !== undefined ? { installSize: sanitizedTaskSize } : {}),
        ...(taskVersion ? { version: taskVersion } : {}),
        ...(taskXboxProductId ? { xboxProductId: taskXboxProductId } : {}),
        ...(taskPackageFamilyName ? { packageFamilyName: taskPackageFamilyName } : {}),
        ...(taskAppUserModelId ? { appUserModelId: taskAppUserModelId } : {}),
        ...(taskXboxTitleId ? { xboxTitleId: taskXboxTitleId } : {}),
        ...(taskScid ? { scid: taskScid } : {}),
        ...(taskMsaAppId ? { msaAppId: taskMsaAppId } : {}),
        runner: task.runner || (task.platformId === 'steam' ? 'steam' : 'one_launcher'),
        isWindowsBinaryOnMac,
      };

      const existingIdx = this.installedRecords.findIndex(
        (r) =>
          r.platformId === newRecord.platformId &&
          (String(r.platformGameId).toLowerCase() ===
            String(newRecord.platformGameId).toLowerCase() ||
            String(r.platformGameId).toLowerCase() === String(task.platformGameId).toLowerCase() ||
            Boolean(
              taskPackageFamilyName &&
                r.packageFamilyName &&
                r.packageFamilyName.toLowerCase() === taskPackageFamilyName.toLowerCase()
            ) ||
            (normalizedSteamAppId !== undefined && Number(r.appId) === normalizedSteamAppId))
      );
      if (existingIdx >= 0) {
        this.installedRecords[existingIdx] = { ...this.installedRecords[existingIdx], ...newRecord };
      } else {
        this.installedRecords.push(newRecord);
      }
      this.installedIndexMutationSeq++;

      if (task.platformId === 'steam' || task.platformId === 'xbox') {
        shouldRescanInstalled = true;
      }

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity:game-installed', {
            detail: {
              gameId: task.gameId,
              platformId: task.platformId,
              platformGameId: task.platformGameId,
              ...(normalizedSteamAppId ? { steamAppId: normalizedSteamAppId } : {}),
              installPath,
              executablePath: task.executablePath,
              ...(task.launchArguments ? { launchArguments: task.launchArguments } : {}),
              ...(taskVersion ? { version: taskVersion } : {}),
              ...(taskXboxProductId ? { xboxProductId: taskXboxProductId } : {}),
              ...(taskPackageFamilyName ? { packageFamilyName: taskPackageFamilyName } : {}),
              ...(taskAppUserModelId ? { appUserModelId: taskAppUserModelId } : {}),
              ...(taskXboxTitleId ? { xboxTitleId: taskXboxTitleId } : {}),
              ...(taskScid ? { scid: taskScid } : {}),
              ...(taskMsaAppId ? { msaAppId: taskMsaAppId } : {}),
              isWindowsBinaryOnMac,
              installed: true,
            },
          })
        );
      }
    }

    if (
      shouldRescanInstalled &&
      typeof window !== 'undefined' &&
      window.electronAPI?.scanAllInstalledGames
    ) {
      void this.scanAllInstalledGames(true).catch(() => {});
    }

    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
  }

  private handleSessionUpdated(data: SessionUpdatedPayload): void {
    const session = data?.session;
    const isLifecycleEvent =
      data?.event === 'started' ||
      data?.event === 'stopping' ||
      data?.event === 'stopped' ||
      data?.event === 'playtime_synced';

    const isCloudSyncEvent =
      data?.event === 'cloud_sync_warning' ||
      data?.event === 'cloud_sync_complete' ||
      (!isLifecycleEvent &&
        (session?.status === 'cloud_sync_warning' ||
          session?.status === 'cloud_sync_complete' ||
          Boolean(data?.cloudSync || session?.cloudSync)));

    if (isCloudSyncEvent) {
      const targetGameId = session?.gameId || data?.cloudSync?.gameId;
      const cloudSyncDetail = data?.cloudSync || session?.cloudSync;
      if (targetGameId && this.activeSessions.has(targetGameId)) {
        const existingSession = this.activeSessions.get(targetGameId)!;
        this.activeSessions.set(targetGameId, {
          ...existingSession,
          ...(cloudSyncDetail ? { cloudSync: cloudSyncDetail } : {}),
          ...(data?.statusMessage || session?.statusMessage
            ? { statusMessage: data?.statusMessage || session?.statusMessage }
            : {}),
        });
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity:cloud-sync-telemetry', {
            detail: cloudSyncDetail || session || data,
          })
        );
      }
      this.notifyStateChanged();
      return;
    }

    if (!session || !session.gameId) return;

    if (data.event === 'playtime_synced') {
      if (
        typeof data.storefrontTotalPlaytimeMinutes === 'number' &&
        data.storefrontTotalPlaytimeMinutes > 0 &&
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function'
      ) {
        window.dispatchEvent(
          new CustomEvent('antigravity:game-session-ended', {
            detail: {
              gameId: session.gameId,
              platformId: session.platformId,
              platformGameId: session.platformGameId,
              sessionMinutesPlayed: 0,
              durationSeconds: data.durationSeconds ?? 0,
              lastPlayed: data.lastPlayed || new Date().toISOString(),
              storefrontTotalPlaytimeMinutes: data.storefrontTotalPlaytimeMinutes,
            },
          })
        );
      }
      this.notifyStateChanged();
      return;
    }

    if (data.event === 'stopped') {
      this.activeSessions.delete(session.gameId);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        if (data.cloudSync) {
          window.dispatchEvent(
            new CustomEvent('antigravity:cloud-sync-telemetry', {
              detail: data.cloudSync,
            })
          );
        }
        if (data.error) {
          window.dispatchEvent(
            new CustomEvent('antigravity:game-launch-error', {
              detail: {
                gameId: session.gameId,
                platformId: session.platformId,
                error: data.error,
              },
            })
          );
        }
        if ((data.sessionMinutesPlayed ?? 0) > 0 && !data.error) {
          window.dispatchEvent(
            new CustomEvent('antigravity:game-session-ended', {
              detail: {
                gameId: session.gameId,
                platformId: session.platformId,
                platformGameId: session.platformGameId,
                sessionMinutesPlayed: data.sessionMinutesPlayed ?? 1,
                durationSeconds: data.durationSeconds ?? 60,
                lastPlayed: data.lastPlayed || new Date().toISOString(),
                ...(typeof data.storefrontTotalPlaytimeMinutes === 'number' &&
                data.storefrontTotalPlaytimeMinutes > 0
                  ? { storefrontTotalPlaytimeMinutes: data.storefrontTotalPlaytimeMinutes }
                  : {}),
              },
            })
          );
        }
      }
    } else {
      this.activeSessions.set(session.gameId, session);
    }

    this.syncInGameResourceThrottle();
    this.notifyStateChanged();
  }

  public getHostPlatform(): 'darwin' | 'win32' | 'linux' {
    const apiPlatform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
    if (apiPlatform === 'win32' || apiPlatform === 'darwin' || apiPlatform === 'linux') {
      return apiPlatform;
    }
    if (typeof navigator !== 'undefined' && !navigator.userAgent?.includes('Node')) {
      const ua = navigator.platform || navigator.userAgent || '';
      if (/Win/i.test(ua)) return 'win32';
      if (/Linux/i.test(ua)) return 'linux';
    }
    return 'darwin';
  }

  public getHostArch(): 'arm64' | 'x64' {
    const apiRecord =
      typeof window !== 'undefined' && window.electronAPI
        ? (window.electronAPI as unknown as Record<string, unknown>)
        : undefined;
    const rawApiArch = typeof apiRecord?.arch === 'string' ? apiRecord.arch.trim() : '';
    const candidateArch = rawApiArch || (this.detectedHostArch || '').trim();
    if (candidateArch) {
      return /^(x64|ia32|x86_64|x86|intel|amd64)$/i.test(candidateArch) ? 'x64' : 'arm64';
    }
    if (typeof navigator !== 'undefined') {
      const uaDataArch = (
        navigator as Navigator & { userAgentData?: { architecture?: string } }
      )?.userAgentData?.architecture;
      if (typeof uaDataArch === 'string' && uaDataArch.trim()) {
        return /^(x64|ia32|x86_64|x86|intel|amd64)$/i.test(uaDataArch.trim()) ? 'x64' : 'arm64';
      }
    }
    if (typeof process !== 'undefined' && typeof process.arch === 'string') {
      return /^(x64|ia32|x86_64|x86|intel|amd64)$/i.test(process.arch) ? 'x64' : 'arm64';
    }
    return 'arm64';
  }

  public isWindowsHost(): boolean {
    return this.getHostPlatform() === 'win32';
  }

  public hasAuthoritativeInstallScan(): boolean {
    return this.lastScanSucceeded;
  }

  public async scanAllInstalledGames(
    forceRefresh = false,
    options?: { silentInitialBoot?: boolean }
  ): Promise<InstalledGameRecord[]> {
    if (this.inFlightScanPromise) {
      return this.inFlightScanPromise;
    }

    if (
      !forceRefresh &&
      this.lastScanTimestamp > 0 &&
      Date.now() - this.lastScanTimestamp < 1500 &&
      this.installedRecords.length > 0
    ) {
      return this.installedRecords;
    }

    if (typeof window !== 'undefined' && window.electronAPI?.scanAllInstalledGames) {
      this.inFlightScanPromise = (async () => {
        try {
          const prevRecords = [...this.installedRecords];
          const res = await window.electronAPI!.scanAllInstalledGames();
          if (res && res.success !== false && Array.isArray(res.installedGames)) {
            this.lastScanSucceeded = true;
            const isWin = this.isWindowsHost();
            if (res.epicPlatformSupport && typeof res.epicPlatformSupport === 'object') {
              this.epicPlatformSupportMap = { ...res.epicPlatformSupport };
            }
            this.installedRecords = this.attachEpicPlatformSupportMetadata(
              res.installedGames.map((r) => {
                const sanitizedInstallSize = sanitizeGameInstallSizeBytes(r.installSize);
                const nextRec: InstalledGameRecord = {
                  ...r,
                  ...(isWin ? { isWindowsBinaryOnMac: false } : {}),
                };
                if (sanitizedInstallSize !== undefined) {
                  nextRec.installSize = sanitizedInstallSize;
                } else {
                  delete nextRec.installSize;
                }
                return nextRec;
              })
            );
            this.lastScanTimestamp = Date.now();

            const hasAnyCustomExe = Object.values(this.launchConfigs).some(
              (c) =>
                Boolean(c?.customExecutablePath) ||
                (c?.platformConfigs &&
                  Object.values(c.platformConfigs).some((p) => Boolean(p?.customExecutablePath)))
            );
            if (
              typeof window !== 'undefined' &&
              typeof window.electronAPI?.getGameLaunchConfigs === 'function' &&
              hasAnyCustomExe
            ) {
              try {
                const freshConfigs = (await window.electronAPI.getGameLaunchConfigs()) as Record<
                  string,
                  GameLaunchConfig
                >;
                if (freshConfigs && typeof freshConfigs === 'object') {
                  const reconciled = reconcileLaunchConfigsWithDisk(
                    this.launchConfigs,
                    freshConfigs,
                    false
                  );
                  if (reconciled.changed) {
                    this.launchConfigs = reconciled.configs;
                    this.persistLocalConfigs();
                  }
                }
              } catch {}
            }

            // 1. Reconcile any active downloads whose game is now detected as installed on disk
            for (let i = 0; i < this.downloadQueue.length; i++) {
              const task = this.downloadQueue[i];
              if (
                task.status !== 'downloading' &&
                task.status !== 'queued' &&
                task.status !== 'extracting' &&
                task.status !== 'verifying'
              ) {
                continue;
              }

              const matchedRecord = this.installedRecords.find(
                (r) =>
                  r.platformId === task.platformId &&
                  (String(r.platformGameId) === String(task.platformGameId) ||
                    (task.steamAppId &&
                      Number(r.appId || r.platformGameId) === Number(task.steamAppId)))
              );

              if (matchedRecord) {
                const resolvedBytes =
                  sanitizeGameInstallSizeBytes(matchedRecord.installSize) ??
                  sanitizeGameInstallSizeBytes(task.totalBytes) ??
                  0;
                this.downloadQueue[i] = {
                  ...task,
                  status: 'completed',
                  progressPercent: 100,
                  bytesDownloaded: resolvedBytes,
                  totalBytes: resolvedBytes,
                  speedBytesPerSec: 0,
                  etaSeconds: 0,
                  finalInstallPath: matchedRecord.installPath,
                  executablePath: matchedRecord.executablePath,
                  isWindowsBinaryOnMac: matchedRecord.isWindowsBinaryOnMac,
                  completedAt: new Date().toISOString(),
                  statusMessage: 'Installation complete',
                };

                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                  const matchedExt = matchedRecord as InstalledGameRecord & {
                    xboxProductId?: string;
                  };
                  window.dispatchEvent(
                    new CustomEvent('antigravity:game-installed', {
                      detail: {
                        gameId: task.gameId,
                        platformId: task.platformId,
                        platformGameId: task.platformGameId,
                        installPath: matchedRecord.installPath,
                        executablePath: matchedRecord.executablePath,
                        ...(matchedRecord.launchArguments
                          ? { launchArguments: matchedRecord.launchArguments }
                          : {}),
                        ...(matchedRecord.version ? { version: matchedRecord.version } : {}),
                        ...(matchedExt.xboxProductId
                          ? { xboxProductId: matchedExt.xboxProductId }
                          : {}),
                        ...(matchedRecord.packageFamilyName
                          ? { packageFamilyName: matchedRecord.packageFamilyName }
                          : {}),
                        ...(matchedRecord.appUserModelId
                          ? { appUserModelId: matchedRecord.appUserModelId }
                          : {}),
                        ...(matchedRecord.xboxTitleId
                          ? { xboxTitleId: matchedRecord.xboxTitleId }
                          : {}),
                        ...(matchedRecord.scid ? { scid: matchedRecord.scid } : {}),
                        ...(matchedRecord.msaAppId ? { msaAppId: matchedRecord.msaAppId } : {}),
                        isWindowsBinaryOnMac: matchedRecord.isWindowsBinaryOnMac,
                        installed: true,
                      },
                    })
                  );
                }
              }
            }

            // 2. Dispatch antigravity:game-installed for any newly discovered installation
            // (Skip individual cold-boot event storm when App.tsx batch-reconciles initial scan)
            if (
              !options?.silentInitialBoot &&
              typeof window !== 'undefined' &&
              typeof window.dispatchEvent === 'function'
            ) {
              for (const rec of this.installedRecords) {
                const prevRec = prevRecords.find(
                  (p) =>
                    p.platformId === rec.platformId &&
                    String(p.platformGameId).toLowerCase() ===
                      String(rec.platformGameId).toLowerCase()
                );
                const recExt = rec as InstalledGameRecord & { xboxProductId?: string };
                const prevRecExt = prevRec as
                  | (InstalledGameRecord & { xboxProductId?: string })
                  | undefined;
                const gainedXboxIdentityOrExe =
                  rec.platformId === 'xbox' &&
                  Boolean(
                    prevRec &&
                      ((rec.executablePath && rec.executablePath !== prevRec.executablePath) ||
                        (rec.packageFamilyName &&
                          rec.packageFamilyName !== prevRec.packageFamilyName) ||
                        (rec.appUserModelId && rec.appUserModelId !== prevRec.appUserModelId) ||
                        (rec.xboxTitleId && rec.xboxTitleId !== prevRec.xboxTitleId) ||
                        (rec.scid && rec.scid !== prevRec.scid) ||
                        (rec.msaAppId && rec.msaAppId !== prevRec.msaAppId) ||
                        (recExt.xboxProductId && recExt.xboxProductId !== prevRecExt?.xboxProductId))
                  );
                if (!prevRec || gainedXboxIdentityOrExe) {
                  const matchingTask = this.downloadQueue.find(
                    (t) =>
                      t.platformId === rec.platformId &&
                      (String(t.platformGameId).toLowerCase() ===
                        String(rec.platformGameId).toLowerCase() ||
                        Boolean(
                          recExt.xboxProductId &&
                            String(t.platformGameId).toLowerCase() ===
                              String(recExt.xboxProductId).toLowerCase()
                        ))
                  );
                  window.dispatchEvent(
                    new CustomEvent('antigravity:game-installed', {
                      detail: {
                        gameId: matchingTask?.gameId || `${rec.platformId}-${rec.platformGameId}`,
                        platformId: rec.platformId,
                        platformGameId: rec.platformGameId,
                        installPath: rec.installPath,
                        executablePath: rec.executablePath,
                        ...(rec.launchArguments ? { launchArguments: rec.launchArguments } : {}),
                        ...(rec.version ? { version: rec.version } : {}),
                        ...(recExt.xboxProductId ? { xboxProductId: recExt.xboxProductId } : {}),
                        ...(rec.packageFamilyName
                          ? { packageFamilyName: rec.packageFamilyName }
                          : {}),
                        ...(rec.appUserModelId ? { appUserModelId: rec.appUserModelId } : {}),
                        ...(rec.xboxTitleId ? { xboxTitleId: rec.xboxTitleId } : {}),
                        ...(rec.scid ? { scid: rec.scid } : {}),
                        ...(rec.msaAppId ? { msaAppId: rec.msaAppId } : {}),
                        isWindowsBinaryOnMac: rec.isWindowsBinaryOnMac,
                        installed: true,
                      },
                    })
                  );
                }
              }
            }

            this.ensureActiveDownloadPolling();
            this.notifyStateChanged();
            return this.installedRecords;
          }
        } catch (err) {
          console.warn('[LauncherService] scanAllInstalledGames failed:', err);
        } finally {
          this.inFlightScanPromise = null;
        }
        return this.installedRecords;
      })();
      return this.inFlightScanPromise;
    }
    return this.installedRecords;
  }

  public async detectCompatibilityLayers(): Promise<CompatibilityLayerInfo[]> {
    if (typeof window !== 'undefined' && window.electronAPI?.detectCompatibilityLayers) {
      try {
        const layers = await window.electronAPI.detectCompatibilityLayers();
        if (Array.isArray(layers)) {
          const prevSerialized = JSON.stringify(this.compatibilityLayers);
          const nextSerialized = JSON.stringify(layers);
          this.compatibilityLayers = layers;
          if (prevSerialized !== nextSerialized) {
            this.notifyStateChanged();
          }
          return layers;
        }
      } catch (err) {
        console.warn('[LauncherService] detectCompatibilityLayers failed:', err);
      }
    }
    return this.compatibilityLayers;
  }

  public getCompatibilityLayers(): CompatibilityLayerInfo[] {
    return this.compatibilityLayers;
  }

  public getInstalledStorefrontClients(): Partial<Record<StorefrontId, boolean>> {
    return { ...this.installedStorefrontClients };
  }

  public async detectInstalledStorefrontClients(): Promise<
    Partial<Record<StorefrontId, boolean>>
  > {
    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.detectInstalledStorefrontClients === 'function'
    ) {
      try {
        const detected = await window.electronAPI.detectInstalledStorefrontClients();
        if (detected && typeof detected === 'object') {
          const next: Partial<Record<StorefrontId, boolean>> = {};
          for (const key of ['steam', 'gog', 'epic', 'xbox'] as const) {
            if (typeof detected[key] === 'boolean') {
              next[key] = detected[key];
            }
          }
          const prevSerialized = JSON.stringify(this.installedStorefrontClients);
          const nextSerialized = JSON.stringify(next);
          this.installedStorefrontClients = next;
          if (prevSerialized !== nextSerialized) {
            this.notifyStateChanged();
          }
          return { ...this.installedStorefrontClients };
        }
      } catch (err) {
        console.warn('[LauncherService] detectInstalledStorefrontClients failed:', err);
      }
    }
    return { ...this.installedStorefrontClients };
  }

  public async installCompatibilityLayer(
    runnerType: Exclude<CompatibilityLayerType, 'native'>,
    mode: 'auto' | 'download' = 'auto'
  ): Promise<InstallCompatibilityLayerResult> {
    const descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === runnerType);
    if (
      mode === 'download' ||
      typeof window === 'undefined' ||
      !window.electronAPI?.installCompatibilityLayer
    ) {
      if (descriptor?.downloadUrl && typeof window !== 'undefined') {
        if (window.electronAPI?.openExternal) {
          await window.electronAPI.openExternal(descriptor.downloadUrl);
        } else if (typeof window.open === 'function') {
          window.open(descriptor.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      }
      return {
        success: true,
        openedExternalInstaller: true,
        runnerType,
        message: 'Opened official installer download page.',
      };
    }

    try {
      const res = await window.electronAPI.installCompatibilityLayer({ runnerType, mode });
      this.compatibilityLayers = res.layers || (await this.detectCompatibilityLayers());
      this.notifyStateChanged();
      return res;
    } catch (err: unknown) {
      return {
        success: false,
        runnerType,
        error: this.getErrorMessage(err, 'Failed to install compatibility layer.'),
      };
    }
  }

  public getRunnerUpdates(): Record<string, CompatibilityLayerUpdateInfo> {
    return this.runnerUpdates;
  }

  public async checkCompatibilityLayerUpdates(): Promise<
    Record<string, CompatibilityLayerUpdateInfo>
  > {
    if (
      typeof window !== 'undefined' &&
      window.electronAPI?.checkCompatibilityLayerUpdates
    ) {
      try {
        const res = await window.electronAPI.checkCompatibilityLayerUpdates();
        if (res && typeof res === 'object') {
          const prevSerialized = JSON.stringify(this.runnerUpdates);
          const nextSerialized = JSON.stringify(res);
          this.runnerUpdates = res;
          if (prevSerialized !== nextSerialized) {
            this.notifyStateChanged();
          }
        }
      } catch (err) {
        console.warn('[LauncherService] checkCompatibilityLayerUpdates failed:', err);
      }
    }
    return this.runnerUpdates;
  }

  public async updateCompatibilityLayer(
    runnerType: Exclude<CompatibilityLayerType, 'native'>
  ): Promise<UpdateCompatibilityLayerResult> {
    const descriptor = COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === runnerType);
    if (
      typeof window === 'undefined' ||
      !window.electronAPI?.updateCompatibilityLayer
    ) {
      if (descriptor?.downloadUrl && typeof window !== 'undefined') {
        if (window.electronAPI?.openExternal) {
          await window.electronAPI.openExternal(descriptor.downloadUrl);
        } else if (typeof window.open === 'function') {
          window.open(descriptor.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      }
      return {
        success: true,
        runnerType,
        updated: false,
        openedExternalUrl: descriptor?.downloadUrl,
        message: 'Opened official runner update portal.',
      };
    }

    try {
      const res = await window.electronAPI.updateCompatibilityLayer({ runnerType });
      if (Array.isArray(res.detectedLayers)) {
        this.compatibilityLayers = res.detectedLayers;
      } else {
        await this.detectCompatibilityLayers();
      }
      if (res.updateInfo) {
        this.runnerUpdates = {
          ...this.runnerUpdates,
          [runnerType]: res.updateInfo,
        };
      } else {
        await this.checkCompatibilityLayerUpdates();
      }
      this.notifyStateChanged();
      return res;
    } catch (err: unknown) {
      const errMsg = this.getErrorMessage(err, 'Failed to update compatibility layer.');
      return {
        success: false,
        runnerType,
        updated: false,
        message: errMsg,
        error: errMsg,
      };
    }
  }

  public getInstalledRecords(): InstalledGameRecord[] {
    return this.installedRecords;
  }

  private ensureInstalledLookupIndex(): InstalledLookupIndex {
    if (
      this.installedIndexRecordsRef === this.installedRecords &&
      this.installedIndexRecordsLen === this.installedRecords.length &&
      this.installedIndexBuiltSeq === this.installedIndexMutationSeq
    ) {
      return this.installedLookupIndex;
    }

    const byPlatGameKey = new Map<string, InstalledGameRecord>();
    const bySteamAppId = new Map<number, InstalledGameRecord>();
    const byPlatInstallPath = new Map<string, InstalledGameRecord>();
    const byPlatExePath = new Map<string, InstalledGameRecord>();
    const byPlatNormTitle = new Map<string, InstalledGameRecord>();

    const normalizeLookupPlatGameId = (raw: unknown): string =>
      String(raw ?? '')
        .trim()
        .replace(/^(?:gog[_-]|epic[_-]|steam[_-]|xbox[_-]|custom[_-])/i, '')
        .toLowerCase();
    const normalizeLookupPath = (raw: string): string => raw.trim().replace(/[\\/]+$/, '');

    for (const r of this.installedRecords) {
      if (!r) continue;
      if (r.platformGameId !== undefined && r.platformGameId !== null && r.platformGameId !== '') {
        const key = `${r.platformId}:${String(r.platformGameId)}`;
        if (!byPlatGameKey.has(key)) byPlatGameKey.set(key, r);
        const normId = normalizeLookupPlatGameId(r.platformGameId);
        if (normId) {
          const normKey = `${r.platformId}:${normId}`;
          if (!byPlatGameKey.has(normKey)) byPlatGameKey.set(normKey, r);
        }
      }
      if (r.packageFamilyName) {
        const pfnKey = `${r.platformId}:${String(r.packageFamilyName)}`;
        if (!byPlatGameKey.has(pfnKey)) byPlatGameKey.set(pfnKey, r);
        const normPfn = String(r.packageFamilyName).trim().toLowerCase();
        if (normPfn && !byPlatGameKey.has(`${r.platformId}:${normPfn}`)) {
          byPlatGameKey.set(`${r.platformId}:${normPfn}`, r);
        }
      }
      const rXboxProductId = (r as InstalledGameRecord & { xboxProductId?: string }).xboxProductId;
      if (rXboxProductId) {
        const prodKey = `${r.platformId}:${String(rXboxProductId)}`;
        if (!byPlatGameKey.has(prodKey)) byPlatGameKey.set(prodKey, r);
        const normProd = normalizeLookupPlatGameId(rXboxProductId);
        if (normProd && !byPlatGameKey.has(`${r.platformId}:${normProd}`)) {
          byPlatGameKey.set(`${r.platformId}:${normProd}`, r);
        }
      }
      if (r.xboxTitleId) {
        const titleIdKey = `${r.platformId}:${String(r.xboxTitleId).trim().toLowerCase()}`;
        if (!byPlatGameKey.has(titleIdKey)) byPlatGameKey.set(titleIdKey, r);
      }
      if (r.platformId === 'steam') {
        const appIdNum = Number(r.appId || normalizeLookupPlatGameId(r.platformGameId));
        if (Number.isFinite(appIdNum) && appIdNum > 0 && !bySteamAppId.has(appIdNum)) {
          bySteamAppId.set(appIdNum, r);
        }
      }
      if (r.installPath) {
        const key = `${r.platformId}:${r.installPath}`;
        if (!byPlatInstallPath.has(key)) byPlatInstallPath.set(key, r);
        const trimmedKey = `${r.platformId}:${normalizeLookupPath(r.installPath)}`;
        if (!byPlatInstallPath.has(trimmedKey)) byPlatInstallPath.set(trimmedKey, r);
      }
      if (r.executablePath) {
        const key = `${r.platformId}:${r.executablePath}`;
        if (!byPlatExePath.has(key)) byPlatExePath.set(key, r);
      }
      if (r.title) {
        const norm = normalizeTitleForMatch(r.title);
        if (norm) {
          const key = `${r.platformId}:${norm}`;
          if (!byPlatNormTitle.has(key)) byPlatNormTitle.set(key, r);
        }
      }
    }

    this.installedLookupIndex = {
      byPlatGameKey,
      bySteamAppId,
      byPlatInstallPath,
      byPlatExePath,
      byPlatNormTitle,
    };
    this.installedIndexRecordsRef = this.installedRecords;
    this.installedIndexRecordsLen = this.installedRecords.length;
    this.installedIndexBuiltSeq = this.installedIndexMutationSeq;
    return this.installedLookupIndex;
  }

  public getInstalledRecordForGame(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ): InstalledGameRecord | undefined {
    if (!game) return undefined;

    const idx = this.ensureInstalledLookupIndex();
    const cfg = this.getLaunchConfig(game.id);
    const normGameTitle = game.title ? normalizeTitleForMatch(game.title) : '';

    const normalizeLookupPlatGameId = (raw: unknown): string =>
      String(raw ?? '')
        .trim()
        .replace(/^(?:gog[_-]|epic[_-]|steam[_-]|xbox[_-]|custom[_-])/i, '')
        .toLowerCase();

    // 1. O(1) indexed helper to check matching platform records in installedRecords
    const matchPlatformRecord = (p: GamePlatformOwnership): InstalledGameRecord | undefined => {
      const pGameId = String(p.platformGameId || p.storefrontAppId || '');
      if (pGameId) {
        const byPlatKey =
          idx.byPlatGameKey.get(`${p.platformId}:${pGameId}`) ||
          idx.byPlatGameKey.get(`${p.platformId}:${normalizeLookupPlatGameId(pGameId)}`);
        if (byPlatKey) return byPlatKey;
      }
      if (p.xboxProductId) {
        const byProdKey =
          idx.byPlatGameKey.get(`${p.platformId}:${p.xboxProductId}`) ||
          idx.byPlatGameKey.get(`${p.platformId}:${normalizeLookupPlatGameId(p.xboxProductId)}`);
        if (byProdKey) return byProdKey;
      }
      if (p.packageFamilyName) {
        const byPfnKey =
          idx.byPlatGameKey.get(`${p.platformId}:${p.packageFamilyName}`) ||
          idx.byPlatGameKey.get(`${p.platformId}:${p.packageFamilyName.trim().toLowerCase()}`);
        if (byPfnKey) return byPfnKey;
      }
      if (p.storefrontAppId) {
        const normStoreId = normalizeLookupPlatGameId(p.storefrontAppId);
        if (normStoreId) {
          const byStoreKey = idx.byPlatGameKey.get(`${p.platformId}:${normStoreId}`);
          if (byStoreKey) return byStoreKey;
        }
      }
      if (p.platformId === 'steam' && game.steamAppId) {
        const bySteamApp = idx.bySteamAppId.get(Number(game.steamAppId));
        if (bySteamApp) return bySteamApp;
      }

      if (p.installPath) {
        const trimmedPath = p.installPath.trim().replace(/[\\/]+$/, '');
        const byInstall =
          idx.byPlatInstallPath.get(`${p.platformId}:${p.installPath}`) ||
          idx.byPlatInstallPath.get(`${p.platformId}:${trimmedPath}`);
        if (byInstall) return byInstall;
      }
      if (p.executablePath) {
        const byExe = idx.byPlatExePath.get(`${p.platformId}:${p.executablePath}`);
        if (byExe) return byExe;
      }
      if (normGameTitle) {
        const byTitle = idx.byPlatNormTitle.get(`${p.platformId}:${normGameTitle}`);
        if (byTitle) return byTitle;
      }

      if (
        !this.initialized &&
        !this.lastScanSucceeded &&
        p.installed &&
        (p.installPath || p.executablePath)
      ) {
        const isWinPath = Boolean(
          (p.executablePath && /\.exe$/i.test(p.executablePath)) ||
            /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
              String(p.executablePath || p.installPath || '')
            )
        );
        const isMacPath = Boolean(
          (p.executablePath && !/\.exe$/i.test(p.executablePath)) ||
            (p.installPath && /\.app(\/|$)/i.test(p.installPath))
        );
        const inferredWinOnMac = this.isWindowsHost()
          ? false
          : p.isWindowsBinaryOnMac !== undefined
            ? p.isWindowsBinaryOnMac
            : isWinPath
              ? true
              : isMacPath
                ? false
                : undefined;
        return {
          platformId: p.platformId,
          platformGameId: p.platformGameId,
          appId: p.platformId === 'steam' ? game.steamAppId || Number(p.platformGameId) : undefined,
          packageFamilyName: p.packageFamilyName,
          appUserModelId: p.appUserModelId,
          xboxTitleId: p.xboxTitleId,
          title: game.title,
          installPath: p.installPath || '',
          executablePath: p.executablePath,
          launchArguments: p.launchArguments,
          installSize: sanitizeGameInstallSizeBytes(p.installSize),
          version: p.version,
          isWindowsBinaryOnMac: inferredWinOnMac,
        };
      }
      return undefined;
    };

    // When preferredPlatformId is explicitly provided, strictly scope to that storefront
    if (preferredPlatformId) {
      const targetPlat = game.platforms.find((p) => p.platformId === preferredPlatformId);
      if (targetPlat) {
        const matched = matchPlatformRecord(targetPlat);
        if (matched) return matched;
      }

      if (preferredPlatformId === 'steam' && game.steamAppId) {
        const bySteamId = idx.bySteamAppId.get(Number(game.steamAppId));
        if (bySteamId) return bySteamId;
      }

      const platCfg = this.getLaunchConfig(game.id, preferredPlatformId);
      if (platCfg?.customExecutablePath) {
        return {
          platformId: preferredPlatformId,
          platformGameId: String(
            targetPlat?.platformGameId ||
              targetPlat?.storefrontAppId ||
              game.platforms[0]?.platformGameId ||
              game.id
          ),
          packageFamilyName: targetPlat?.packageFamilyName,
          appUserModelId: targetPlat?.appUserModelId,
          xboxTitleId: targetPlat?.xboxTitleId,
          title: game.title,
          installPath: platCfg.workingDirectory || platCfg.customExecutablePath,
          executablePath: platCfg.customExecutablePath,
          launchArguments: platCfg.launchArguments || targetPlat?.launchArguments,
          runner: 'custom',
          isWindowsBinaryOnMac:
            !this.isWindowsHost() && /\.exe$/i.test(platCfg.customExecutablePath),
        };
      }

      return undefined;
    }

    const targetPlatformId = cfg?.preferredPlatformId;
    if (targetPlatformId) {
      const targetPlat = game.platforms.find((p) => p.platformId === targetPlatformId);
      if (targetPlat) {
        const matched = matchPlatformRecord(targetPlat);
        if (matched) return matched;
      }
    }

    for (const p of game.platforms) {
      const matched = matchPlatformRecord(p);
      if (matched) return matched;
    }

    // 2. Fallback check by steamAppId
    if (game.steamAppId) {
      const bySteamId = idx.bySteamAppId.get(Number(game.steamAppId));
      if (bySteamId) return bySteamId;
    }

    // 3. Fallback check by customExecutablePath in LaunchConfig or platformConfigs
    if (cfg?.customExecutablePath) {
      const resolvedPlatId = targetPlatformId || game.platforms[0]?.platformId || 'custom';
      const targetPlat = game.platforms.find((p) => p.platformId === resolvedPlatId);
      return {
        platformId: resolvedPlatId,
        platformGameId: targetPlat?.platformGameId || game.platforms[0]?.platformGameId || game.id,
        packageFamilyName: targetPlat?.packageFamilyName,
        appUserModelId: targetPlat?.appUserModelId,
        xboxTitleId: targetPlat?.xboxTitleId,
        title: game.title,
        installPath: cfg.workingDirectory || cfg.customExecutablePath,
        executablePath: cfg.customExecutablePath,
        launchArguments: cfg.launchArguments || targetPlat?.launchArguments,
        runner: 'custom',
        isWindowsBinaryOnMac:
          !this.isWindowsHost() && /\.exe$/i.test(cfg.customExecutablePath),
      };
    }

    if (cfg?.platformConfigs) {
      for (const [platId, platProfile] of Object.entries(cfg.platformConfigs)) {
        if (platProfile?.customExecutablePath) {
          const resolvedPlatId = platId as StorefrontId;
          const targetPlat = game.platforms.find((p) => p.platformId === resolvedPlatId);
          return {
            platformId: resolvedPlatId,
            platformGameId: targetPlat?.platformGameId || game.platforms[0]?.platformGameId || game.id,
            packageFamilyName: targetPlat?.packageFamilyName,
            appUserModelId: targetPlat?.appUserModelId,
            xboxTitleId: targetPlat?.xboxTitleId,
            title: game.title,
            installPath: platProfile.workingDirectory || platProfile.customExecutablePath,
            executablePath: platProfile.customExecutablePath,
            launchArguments: platProfile.launchArguments || targetPlat?.launchArguments,
            runner: 'custom',
            isWindowsBinaryOnMac:
              !this.isWindowsHost() && /\.exe$/i.test(platProfile.customExecutablePath),
          };
        }
      }
    }

    return undefined;
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
    if (!game || !Array.isArray(game.platforms) || game.platforms.length === 0) {
      return undefined;
    }

    const cfg = this.getLaunchConfig(game.id);
    const rememberedId = !preferredPlatformId
      ? loadSelectedStorefrontsFromStorage()[game.id]
      : undefined;
    const validRememberedId =
      rememberedId && game.platforms.some((p) => p.platformId === rememberedId)
        ? rememberedId
        : undefined;
    const explicitOrRememberedId = preferredPlatformId || validRememberedId;
    const targetId = explicitOrRememberedId || cfg?.preferredPlatformId;
    let fallbackPreferredUninstalled: GamePlatformOwnership | undefined;

    if (targetId) {
      const found = game.platforms.find((p) => p.platformId === targetId);
      if (found) {
        const rec = this.getInstalledRecordForGame(game, targetId);
        if (rec) {
          return {
            ...found,
            installed: true,
            installPath: rec.installPath || found.installPath,
            executablePath: rec.executablePath || found.executablePath,
            launchArguments: rec.launchArguments || found.launchArguments,
            xboxProductId: found.xboxProductId,
            packageFamilyName: rec.packageFamilyName || found.packageFamilyName,
            appUserModelId: rec.appUserModelId || found.appUserModelId,
            xboxTitleId: rec.xboxTitleId || found.xboxTitleId,
            scid: rec.scid || found.scid,
            msaAppId: rec.msaAppId || found.msaAppId,
            isWindowsBinaryOnMac: this.isWindowsHost()
              ? false
              : (rec.isWindowsBinaryOnMac ?? found.isWindowsBinaryOnMac),
          };
        }
        const targetPlatCfg = this.getLaunchConfig(game.id, targetId);
        const isTargetInstalled = Boolean(found.installed || targetPlatCfg?.customExecutablePath);
        if (explicitOrRememberedId || isTargetInstalled) {
          return found;
        }
        fallbackPreferredUninstalled = found;
      }
    }

    // Prefer an installed platform
    const installedRecord = this.getInstalledRecordForGame(game);
    if (installedRecord) {
      const matchingPlat = game.platforms.find(
        (p) => p.platformId === installedRecord.platformId
      );
      if (matchingPlat) {
        return {
          ...matchingPlat,
          installed: true,
          installPath: installedRecord.installPath || matchingPlat.installPath,
          executablePath: installedRecord.executablePath || matchingPlat.executablePath,
          launchArguments: installedRecord.launchArguments || matchingPlat.launchArguments,
          xboxProductId: matchingPlat.xboxProductId,
          packageFamilyName: installedRecord.packageFamilyName || matchingPlat.packageFamilyName,
          appUserModelId: installedRecord.appUserModelId || matchingPlat.appUserModelId,
          xboxTitleId: installedRecord.xboxTitleId || matchingPlat.xboxTitleId,
          scid: installedRecord.scid || matchingPlat.scid,
          msaAppId: installedRecord.msaAppId || matchingPlat.msaAppId,
          isWindowsBinaryOnMac: this.isWindowsHost()
            ? false
            : (installedRecord.isWindowsBinaryOnMac ?? matchingPlat.isWindowsBinaryOnMac),
        };
      }
    }

    const installedPlat = game.platforms.find((p) => p.installed);
    if (installedPlat) return installedPlat;

    if (fallbackPreferredUninstalled) return fallbackPreferredUninstalled;

    return game.platforms[0];
  }

  public isGameInstalled(game: CanonicalGame, platformId?: StorefrontId): boolean {
    if (!game) return false;

    if (platformId) {
      const platCfg = this.getLaunchConfig(game.id, platformId);
      if (platCfg?.customExecutablePath) {
        return true;
      }
      if (this.getInstalledRecordForGame(game, platformId)) return true;
      const plat = game.platforms.find((p) => p.platformId === platformId);
      return Boolean(plat?.installed);
    }

    const cfg = this.getLaunchConfig(game.id);
    if (cfg?.customExecutablePath) return true;
    if (
      cfg?.platformConfigs &&
      Object.values(cfg.platformConfigs).some((p) => Boolean(p?.customExecutablePath))
    ) {
      return true;
    }
    if (game.platforms.some((p) => p.installed)) return true;
    return Boolean(this.getInstalledRecordForGame(game));
  }

  public isGameRunning(gameId: string, platformId?: StorefrontId): boolean {
    const session = this.activeSessions.get(gameId);
    if (!session) return false;
    return !platformId || !session.platformId || session.platformId === platformId;
  }

  public getActiveSession(gameId: string, platformId?: StorefrontId): ActiveGameSession | undefined {
    const session = this.activeSessions.get(gameId);
    if (!session) return undefined;
    if (platformId && session.platformId && session.platformId !== platformId) {
      return undefined;
    }
    return session;
  }

  public getRunningGames(): ActiveGameSession[] {
    return Array.from(this.activeSessions.values());
  }

  public getActiveDownload(gameId: string, platformId?: StorefrontId): DownloadTaskState | undefined {
    return this.downloadQueue.find(
      (t) =>
        t.gameId === gameId &&
        (!platformId || !t.platformId || t.platformId === platformId) &&
        (t.status === 'queued' ||
          t.status === 'downloading' ||
          t.status === 'extracting' ||
          t.status === 'verifying' ||
          t.status === 'paused')
    );
  }

  public getDownloadQueue(): DownloadTaskState[] {
    return this.downloadQueue;
  }

  public async getDiskSpace(targetPath?: string): Promise<DiskSpaceInfo | null> {
    if (typeof window !== 'undefined' && window.electronAPI?.getDiskSpace) {
      try {
        return await window.electronAPI.getDiskSpace(targetPath);
      } catch {}
    }
    return {
      targetPath: targetPath || (this.isWindowsHost() ? 'C:\\Games\\OneLauncher' : '~/Games/OneLauncher'),
      freeBytes: 120 * 1024 * 1024 * 1024,
      totalBytes: 500 * 1024 * 1024 * 1024,
      usedBytes: 380 * 1024 * 1024 * 1024,
    };
  }

  public async getGameInstallInfo(
    game: CanonicalGame,
    platformId?: StorefrontId,
    targetInstallDir?: string
  ): Promise<GameInstallInfo> {
    const hostPlatform = this.getHostPlatform();
    const isWin = hostPlatform === 'win32';
    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId: StorefrontId =
      platformId || effPlatform?.platformId || (game.steamAppId ? 'steam' : 'custom');
    const resolvedPlatformGameId =
      effPlatform?.platformGameId || (game.steamAppId ? String(game.steamAppId) : game.id);
    const storeFlags = getStorefrontNativeOsFlags(game, resolvedPlatformId);

    if (typeof window !== 'undefined' && window.electronAPI?.getGameInstallInfo) {
      try {
        const cachedSteamMeta =
          resolvedPlatformId === 'steam' && game.steamAppId
            ? steamApi.getCachedMetadata(Number(game.steamAppId))
            : undefined;
        const steamPlatforms =
          resolvedPlatformId === 'steam'
            ? cachedSteamMeta?.platforms || game.enrichedMetadata?.platforms
            : undefined;
        const res = await window.electronAPI.getGameInstallInfo({
          gameId: game.id,
          title: game.title,
          platformId: resolvedPlatformId,
          platformGameId: resolvedPlatformGameId,
          steamAppId: game.steamAppId,
          xboxProductId: effPlatform?.xboxProductId,
          packageFamilyName: effPlatform?.packageFamilyName,
          appUserModelId: effPlatform?.appUserModelId,
          xboxTitleId: effPlatform?.xboxTitleId,
          targetInstallDir,
          steamPlatforms,
          storePlatforms: {
            windows: storeFlags.windows,
            mac: storeFlags.mac,
          },
        });
        const resHostPlatform = res.hostPlatform || hostPlatform;
        if (Array.isArray(res.availableInstallers) && res.availableInstallers.length > 0) {
          const hasMac = res.availableInstallers.some((i) => i.os === 'mac');
          const hasWin = res.availableInstallers.some((i) => i.os === 'windows');
          const targetPlat = (game.platforms || []).find(
            (p) => p.platformId === resolvedPlatformId
          );
          if (resHostPlatform === 'win32') {
            if (targetPlat) {
              targetPlat.platforms = {
                ...targetPlat.platforms,
                windows: hasWin,
                mac: targetPlat.platforms?.mac ?? false,
              };
            }
          } else {
            if (targetPlat) {
              targetPlat.platforms = {
                ...targetPlat.platforms,
                windows: hasWin,
                mac: hasMac,
              };
            }
            if (resolvedPlatformId === 'gog') {
              saveCachedGogOsSupport(resolvedPlatformGameId, game.title, {
                windows: hasWin,
                mac: hasMac,
              });
            }
          }
        }
        const info: GameInstallInfo = sanitizeGameInstallInfo({
          ...res,
          hostPlatform: resHostPlatform,
        });
        this.setCachedInstallInfoEntry(`${game.id}:${resolvedPlatformId}`, info);
        return info;
      } catch (err) {
        console.warn('[LauncherService] getGameInstallInfo fallback:', err);
      }
    }

    const storeFolder =
      resolvedPlatformId === 'gog'
        ? 'GOG'
        : resolvedPlatformId === 'epic'
          ? 'Epic'
          : resolvedPlatformId === 'xbox'
            ? 'Xbox'
            : resolvedPlatformId === 'steam'
              ? 'Steam'
              : 'Games';
    const defaultInstallDir = isWin
      ? `C:\\Games\\OneLauncher\\${storeFolder}`
      : `~/Games/OneLauncher/${storeFolder}`;
    const availableInstallDirs = isWin
      ? [defaultInstallDir, 'C:\\Games', 'D:\\Games']
      : [defaultInstallDir, '/Applications'];
    const diskSpace = (await this.getDiskSpace(targetInstallDir || defaultInstallDir)) || undefined;

    const macFallbackInstallers: NonNullable<GameInstallInfo['availableInstallers']> = [];
    if (!isWin) {
      if (storeFlags.mac) {
        macFallbackInstallers.push({
          id: `${resolvedPlatformId}-mac-native`,
          name: `${game.title || 'Game'} — Native macOS Build`,
          os: 'mac',
        });
      }
      if (storeFlags.windows || macFallbackInstallers.length === 0) {
        macFallbackInstallers.push({
          id: `${resolvedPlatformId}-win-compat`,
          name: `${game.title || 'Game'} — Windows Build (CrossOver / Wine)`,
          os: 'windows',
        });
      }
    }

    const fallbackInfo: GameInstallInfo = sanitizeGameInstallInfo({
      platformId: resolvedPlatformId,
      platformGameId: resolvedPlatformGameId,
      hostPlatform,
      defaultInstallDir,
      availableInstallDirs,
      availableInstallers: isWin
        ? [
            {
              id: `${resolvedPlatformId}-win-native`,
              name: `${game.title || 'Game'} — Windows Native Build`,
              os: 'windows',
            },
          ]
        : macFallbackInstallers,
      canDirectDownload: resolvedPlatformId === 'gog',
      requiresStoreClientFallback: resolvedPlatformId !== 'gog',
      diskSpace,
    });
    this.setCachedInstallInfoEntry(`${game.id}:${resolvedPlatformId}`, fallbackInfo);
    return fallbackInfo;
  }

  private setCachedInstallInfoEntry(key: string, info: GameInstallInfo): void {
    if (!key) return;
    const sanitized = sanitizeGameInstallInfo(info);
    if (this.installInfoCache.has(key)) {
      this.installInfoCache.delete(key);
    }
    while (this.installInfoCache.size >= LauncherService.MAX_INSTALL_INFO_CACHE_SIZE) {
      const oldestKey = this.installInfoCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.installInfoCache.delete(oldestKey);
    }
    this.installInfoCache.set(key, sanitized);
  }

  public getCachedInstallInfo(
    gameId?: string,
    platformId?: StorefrontId
  ): GameInstallInfo | undefined {
    if (!gameId) return undefined;
    if (platformId) {
      return this.installInfoCache.get(`${gameId}:${platformId}`);
    }
    for (const [key, value] of this.installInfoCache.entries()) {
      if (key.startsWith(`${gameId}:`)) {
        return value;
      }
    }
    return undefined;
  }

  public async launchGame(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<LauncherActionResult> {
    if (!game) {
      return { success: false, error: 'No game specified to launch.' };
    }

    if (this.activeSessions.has(game.id)) {
      return {
        success: true,
        message: `${game.title} is already running.`,
        session: this.activeSessions.get(game.id),
      };
    }

    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId: StorefrontId =
      platformId ||
      effPlatform?.platformId ||
      this.getLaunchConfig(game.id)?.preferredPlatformId ||
      (game.steamAppId ? 'steam' : 'custom');

    const savedLaunchConfig = this.getLaunchConfig(game.id, resolvedPlatformId);
    const installedRecord = this.getInstalledRecordForGame(game, resolvedPlatformId);
    const targetPlatformObj =
      game.platforms.find((p) => p.platformId === resolvedPlatformId) || effPlatform;

    const resolvedPlatformGameId =
      installedRecord?.platformGameId ||
      targetPlatformObj?.platformGameId ||
      (game.steamAppId ? String(game.steamAppId) : game.id);

    const installPath = installedRecord?.installPath || targetPlatformObj?.installPath;
    const executablePath =
      savedLaunchConfig?.customExecutablePath ||
      installedRecord?.executablePath ||
      targetPlatformObj?.executablePath;
    const launchArguments =
      savedLaunchConfig?.launchArguments ||
      installedRecord?.launchArguments ||
      targetPlatformObj?.launchArguments;
    const isWindowsBinaryOnMac =
      installedRecord?.isWindowsBinaryOnMac ?? targetPlatformObj?.isWindowsBinaryOnMac;

    const xboxProductId = targetPlatformObj?.xboxProductId;
    const packageFamilyName =
      installedRecord?.packageFamilyName || targetPlatformObj?.packageFamilyName;
    const appUserModelId =
      installedRecord?.appUserModelId || targetPlatformObj?.appUserModelId;
    const xboxTitleId =
      installedRecord?.xboxTitleId || targetPlatformObj?.xboxTitleId;
    const scid = installedRecord?.scid || targetPlatformObj?.scid;
    const msaAppId = installedRecord?.msaAppId || targetPlatformObj?.msaAppId;

    const preview = this.resolveEffectiveLaunchModePreview(
      game,
      resolvedPlatformId,
      savedLaunchConfig
    );
    const isNativeInstalledBuild =
      preview.detectedBuildType === 'mac_native_app' ||
      preview.detectedBuildType === 'mac_native_bin' ||
      preview.detectedBuildType === 'windows_native';

    let launchConfig: GameLaunchConfig | undefined = savedLaunchConfig;
    if (isNativeInstalledBuild) {
      if (!savedLaunchConfig) {
        launchConfig = {
          gameId: game.id,
          preferredPlatformId: resolvedPlatformId,
          launchMethod: preview.defaultLaunchMethod,
        };
      } else if (
        !savedLaunchConfig.launchMethod ||
        savedLaunchConfig.launchMethod === 'auto' ||
        savedLaunchConfig.launchMethod === 'custom'
      ) {
        launchConfig = {
          ...savedLaunchConfig,
          launchMethod: preview.defaultLaunchMethod,
        };
      } else if (
        savedLaunchConfig.launchMethod === 'storefront_uri' &&
        (resolvedPlatformId === 'gog' ||
          resolvedPlatformId === 'epic' ||
          resolvedPlatformId === 'xbox') &&
        this.installedStorefrontClients[resolvedPlatformId] === false
      ) {
        launchConfig = {
          ...savedLaunchConfig,
          launchMethod: 'direct',
        };
      }
    }

    if (typeof window !== 'undefined' && window.electronAPI?.launchGame) {
      try {
        const res = await window.electronAPI.launchGame({
          gameId: game.id,
          title: game.title,
          platformId: resolvedPlatformId,
          platformGameId: resolvedPlatformGameId,
          steamAppId: game.steamAppId,
          ...(xboxProductId ? { xboxProductId } : {}),
          packageFamilyName,
          appUserModelId,
          xboxTitleId,
          scid,
          msaAppId,
          installPath,
          executablePath,
          launchArguments,
          isWindowsBinaryOnMac,
          launchConfig,
          performanceSettings: this.getPerformanceSettings(),
        });

        if (res.success && res.session) {
          this.activeSessions.set(game.id, res.session);
          this.syncInGameResourceThrottle();
          this.notifyStateChanged();
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: this.getErrorMessage(err, 'Failed to launch game.'),
        };
      }
    }

    // Browser / Non-Electron fallback
    const fallbackLaunchMethod =
      launchConfig?.launchMethod ||
      preview.resolvedPolicy?.effectiveLaunchMethod ||
      preview.defaultLaunchMethod ||
      'storefront_uri';
    const session: ActiveGameSession = {
      sessionId: `web-session-${Date.now()}`,
      gameId: game.id,
      title: game.title,
      platformId: resolvedPlatformId,
      platformGameId: resolvedPlatformGameId,
      startedAt: new Date().toISOString(),
      launchMethod: fallbackLaunchMethod,
      executablePath,
      status: 'running',
    };

    this.activeSessions.set(game.id, session);
    this.syncInGameResourceThrottle();
    this.notifyStateChanged();

    return {
      success: true,
      message: `Launched ${game.title}`,
      session,
    };
  }

  public async stopGame(gameId: string): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.stopGame) {
      try {
        const session = this.activeSessions.get(gameId);
        const res = await window.electronAPI.stopGame({
          gameId,
          sessionId: session?.sessionId,
          pid: session?.pid,
        });
        this.activeSessions.delete(gameId);
        this.syncInGameResourceThrottle();
        this.notifyStateChanged();
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: this.getErrorMessage(err, 'Failed to stop game.'),
        };
      }
    }

    const existing = this.activeSessions.get(gameId);
    if (!existing) {
      return { success: false, error: 'Game is not currently running.' };
    }

    this.handleSessionUpdated({
      session: existing,
      event: 'stopped',
      sessionMinutesPlayed: 1,
      durationSeconds: 60,
      lastPlayed: new Date().toISOString(),
    });

    return {
      success: true,
      message: `Stopped ${existing.title}`,
      sessionMinutesPlayed: 1,
    };
  }

  public async startInstall(request: InstallGameRequest): Promise<LauncherActionResult> {
    const resolvedTotalBytes = request.totalBytes || request.estimatedSizeBytes;
    const payload: InstallGameRequest = {
      ...request,
      estimatedSizeBytes: request.estimatedSizeBytes,
      totalBytes: resolvedTotalBytes,
      ...(request.compatibilityLayer ? { compatibilityLayer: request.compatibilityLayer } : {}),
      ...(request.wineBottleName ? { wineBottleName: request.wineBottleName } : {}),
      ...(typeof request.includeDlcs === 'boolean' ? { includeDlcs: request.includeDlcs } : {}),
      ...(typeof request.preferClientlessExtraction === 'boolean'
        ? { preferClientlessExtraction: request.preferClientlessExtraction }
        : {}),
    };

    if (typeof window !== 'undefined' && window.electronAPI?.installGame) {
      try {
        const res = await window.electronAPI.installGame(payload);
        if (res.success && res.task) {
          const exists = this.downloadQueue.some((t) => t.taskId === res.task!.taskId);
          if (!exists) {
            this.downloadQueue = [...this.downloadQueue, res.task];
          }
          this.ensureActiveDownloadPolling();
          this.notifyStateChanged();
          this.openDownloadDrawer();
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: this.getErrorMessage(err, 'Failed to start installation.'),
        };
      }
    }

    // Web mode fallback task
    const task: DownloadTaskState = {
      taskId: `web-dl-${Date.now()}`,
      gameId: request.gameId,
      title: request.title,
      platformId: request.platformId,
      platformGameId: request.platformGameId,
      steamAppId: request.steamAppId,
      headerImage: request.headerImage,
      installDir: request.installDir,
      status: 'downloading',
      progressPercent: 0,
      bytesDownloaded: 0,
      totalBytes: resolvedTotalBytes || 250 * 1024 * 1024,
      speedBytesPerSec: 15 * 1024 * 1024,
      etaSeconds: 16,
      statusMessage: `Downloading ${request.title}...`,
      startedAt: new Date().toISOString(),
    };

    this.downloadQueue = [...this.downloadQueue, task];
    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
    this.openDownloadDrawer();

    return {
      success: true,
      message: `Started installation for ${request.title}`,
      task,
    };
  }

  public async installGame(request: InstallGameRequest): Promise<LauncherActionResult> {
    return this.startInstall(request);
  }

  public async pauseDownload(taskId: string): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.pauseDownload) {
      const res = await window.electronAPI.pauseDownload(taskId);
      if (res.task) {
        this.handleDownloadUpdated({ task: res.task });
      }
      return res;
    }

    const idx = this.downloadQueue.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return { success: false, error: 'Download task not found.' };
    const updated: DownloadTaskState = {
      ...this.downloadQueue[idx],
      status: 'paused',
      speedBytesPerSec: 0,
      statusMessage: 'Download paused',
    };
    this.downloadQueue[idx] = updated;
    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
    return { success: true, task: updated };
  }

  public async resumeDownload(taskId: string): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.resumeDownload) {
      const res = await window.electronAPI.resumeDownload(taskId);
      if (res.task) {
        this.handleDownloadUpdated({ task: res.task });
      }
      return res;
    }

    const idx = this.downloadQueue.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return { success: false, error: 'Download task not found.' };
    const updated: DownloadTaskState = {
      ...this.downloadQueue[idx],
      status: 'downloading',
      speedBytesPerSec: 15 * 1024 * 1024,
      statusMessage: 'Resuming download...',
    };
    this.downloadQueue[idx] = updated;
    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
    return { success: true, task: updated };
  }

  public async cancelDownload(taskId: string): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.cancelDownload) {
      const res = await window.electronAPI.cancelDownload(taskId);
      if (res.task) {
        this.handleDownloadUpdated({ task: res.task });
      }
      return res;
    }

    const idx = this.downloadQueue.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return { success: false, error: 'Download task not found.' };
    const updated: DownloadTaskState = {
      ...this.downloadQueue[idx],
      status: 'cancelled',
      speedBytesPerSec: 0,
      statusMessage: 'Download cancelled',
    };
    this.downloadQueue[idx] = updated;
    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
    return { success: true, task: updated };
  }

  public clearCompletedDownloads(): void {
    this.downloadQueue = this.downloadQueue.filter(
      (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed'
    );
    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
  }

  public setManualInstallStatus(
    game: CanonicalGame,
    installed: boolean,
    platformId?: StorefrontId
  ): void {
    if (!game) return;

    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId: StorefrontId =
      platformId || effPlatform?.platformId || (game.steamAppId ? 'steam' : 'custom');
    const resolvedPlatformGameId =
      effPlatform?.platformGameId || (game.steamAppId ? String(game.steamAppId) : game.id);

    if (installed) {
      const activeTask = this.getActiveDownload(game.id, resolvedPlatformId);
      if (activeTask) {
        if (typeof window !== 'undefined' && window.electronAPI?.cancelDownload) {
          window.electronAPI.cancelDownload(activeTask.taskId).catch(() => {});
        }
        this.downloadQueue = this.downloadQueue.map((t) =>
          t.gameId === game.id &&
          (!t.platformId || t.platformId === resolvedPlatformId) &&
          (t.status === 'queued' ||
            t.status === 'downloading' ||
            t.status === 'extracting' ||
            t.status === 'verifying' ||
            t.status === 'paused')
            ? {
                ...t,
                status: 'completed',
                progressPercent: 100,
                bytesDownloaded: t.totalBytes,
                speedBytesPerSec: 0,
                etaSeconds: 0,
                completedAt: new Date().toISOString(),
                statusMessage: 'Marked as installed',
              }
            : t
        );
      }

      const existingIdx = this.installedRecords.findIndex(
        (r) =>
          r.platformId === resolvedPlatformId &&
          String(r.platformGameId) === String(resolvedPlatformGameId)
      );
      const sanitizedManualSize = sanitizeGameInstallSizeBytes(
        effPlatform?.installSize ??
          (existingIdx >= 0 ? this.installedRecords[existingIdx]?.installSize : undefined)
      );
      const record: InstalledGameRecord = {
        platformId: resolvedPlatformId,
        platformGameId: String(resolvedPlatformGameId),
        appId:
          resolvedPlatformId === 'steam'
            ? game.steamAppId || Number(resolvedPlatformGameId) || undefined
            : undefined,
        packageFamilyName: effPlatform?.packageFamilyName,
        appUserModelId: effPlatform?.appUserModelId,
        xboxTitleId: effPlatform?.xboxTitleId,
        scid: effPlatform?.scid,
        msaAppId: effPlatform?.msaAppId,
        title: game.title,
        installPath: effPlatform?.installPath || '',
        executablePath: effPlatform?.executablePath,
        ...(sanitizedManualSize !== undefined ? { installSize: sanitizedManualSize } : {}),
        runner: 'custom',
      };
      if (existingIdx >= 0) {
        const mergedRecord: InstalledGameRecord = {
          ...this.installedRecords[existingIdx],
          ...record,
        };
        if (sanitizedManualSize === undefined) {
          delete mergedRecord.installSize;
        }
        this.installedRecords[existingIdx] = mergedRecord;
      } else {
        this.installedRecords.push(record);
      }
      this.installedIndexMutationSeq++;
    } else {
      this.installInfoCache.delete(`${game.id}:${resolvedPlatformId}`);
      const cfg = this.getLaunchConfig(game.id, resolvedPlatformId);
      if (cfg?.customExecutablePath) {
        const { customExecutablePath: _ce, workingDirectory: _wd, ...rest } = cfg;
        void this.saveLaunchConfig(
          {
            ...rest,
            gameId: game.id,
            preferredPlatformId: resolvedPlatformId,
            launchMethod: rest.launchMethod || 'auto',
          },
          resolvedPlatformId
        );
      }
      this.installedRecords = this.attachEpicPlatformSupportMetadata(
        this.installedRecords.filter(
          (r) =>
            !(
              (r.platformId === resolvedPlatformId &&
                (String(r.platformGameId) === String(resolvedPlatformGameId) ||
                  (effPlatform?.xboxProductId &&
                    String(r.platformGameId) === String(effPlatform.xboxProductId)) ||
                  (effPlatform?.packageFamilyName &&
                    r.packageFamilyName === effPlatform.packageFamilyName))) ||
              (resolvedPlatformId === 'steam' &&
                game.steamAppId &&
                Number(r.appId || r.platformGameId) === Number(game.steamAppId))
            )
        )
      );
    }

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:game-installed', {
          detail: {
            gameId: game.id,
            platformId: resolvedPlatformId,
            platformGameId: resolvedPlatformGameId,
            installed,
          },
        })
      );
    }

    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
  }

  public async uninstallGame(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<LauncherActionResult> {
    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const rec = this.getInstalledRecordForGame(game, platformId || effPlatform?.platformId);
    const resolvedPlatformId: StorefrontId =
      platformId || rec?.platformId || effPlatform?.platformId || 'custom';
    const resolvedPlatformGameId =
      rec?.platformGameId || effPlatform?.platformGameId || game.id;
    const installPath = rec?.installPath || effPlatform?.installPath;
    const xboxProductId = effPlatform?.xboxProductId;
    const packageFamilyName = rec?.packageFamilyName || effPlatform?.packageFamilyName;
    const appUserModelId = rec?.appUserModelId || effPlatform?.appUserModelId;

    let res: LauncherActionResult = {
      success: true,
      message: `Uninstalled ${game.title}`,
    };

    if (typeof window !== 'undefined' && window.electronAPI?.uninstallGame) {
      res = await window.electronAPI.uninstallGame({
        gameId: game.id,
        title: game.title,
        platformId: resolvedPlatformId,
        platformGameId: resolvedPlatformGameId,
        steamAppId: game.steamAppId,
        ...(xboxProductId ? { xboxProductId } : {}),
        packageFamilyName,
        appUserModelId,
        installPath,
      });
    }

    if (res.success) {
      this.installInfoCache.delete(`${game.id}:${resolvedPlatformId}`);
      this.installedRecords = this.attachEpicPlatformSupportMetadata(
        this.installedRecords.filter(
          (r) =>
            !(
              r.platformId === resolvedPlatformId &&
              (String(r.platformGameId) === String(resolvedPlatformGameId) ||
                (xboxProductId && String(r.platformGameId) === String(xboxProductId)) ||
                (packageFamilyName && r.packageFamilyName === packageFamilyName))
            )
        )
      );

      const existingPlatCfg = this.getLaunchConfig(game.id, resolvedPlatformId);
      if (existingPlatCfg?.customExecutablePath) {
        const { customExecutablePath: _ce, workingDirectory: _wd, ...restCfg } = existingPlatCfg;
        await this.saveLaunchConfig(
          {
            ...restCfg,
            gameId: game.id,
            preferredPlatformId: resolvedPlatformId,
            launchMethod: restCfg.launchMethod || 'auto',
          },
          resolvedPlatformId
        );
      }

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity:game-installed', {
            detail: {
              gameId: game.id,
              platformId: resolvedPlatformId,
              platformGameId: resolvedPlatformGameId,
              installed: false,
            },
          })
        );
      }

      this.notifyStateChanged();
    }

    return res;
  }

  public async verifyGameFiles(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<LauncherActionResult> {
    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const rec = this.getInstalledRecordForGame(game, effPlatform?.platformId);
    const resolvedPlatformId: StorefrontId =
      platformId || rec?.platformId || effPlatform?.platformId || 'steam';
    const resolvedPlatformGameId =
      rec?.platformGameId || effPlatform?.platformGameId || String(game.steamAppId || game.id);
    const installPath = rec?.installPath || effPlatform?.installPath;

    if (typeof window !== 'undefined' && window.electronAPI?.verifyGameFiles) {
      return await window.electronAPI.verifyGameFiles({
        gameId: game.id,
        title: game.title,
        platformId: resolvedPlatformId,
        platformGameId: resolvedPlatformGameId,
        steamAppId: game.steamAppId,
        installPath,
      });
    }

    return {
      success: true,
      message: `Verified game files for ${game.title}`,
    };
  }

  public async browseLocalFiles(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<boolean> {
    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId = platformId || effPlatform?.platformId;
    const cfg = this.getLaunchConfig(game.id, resolvedPlatformId);
    const rec = this.getInstalledRecordForGame(game, resolvedPlatformId);
    const targetPath =
      rec?.installPath ||
      effPlatform?.installPath ||
      cfg?.workingDirectory ||
      cfg?.customExecutablePath ||
      rec?.executablePath;

    if (!targetPath) return false;

    if (typeof window !== 'undefined' && window.electronAPI?.browseLocalFiles) {
      const res = await window.electronAPI.browseLocalFiles(targetPath);
      return typeof res === 'boolean' ? res : Boolean(res?.success);
    }

    return false;
  }

  public async locateInstalledGame(
    game: CanonicalGame,
    platformId?: StorefrontId
  ): Promise<string | null> {
    const selectedExe = await this.selectExecutable();
    if (!selectedExe) return null;

    const resolvedPlatformId: StorefrontId =
      platformId ||
      this.getLaunchConfig(game.id)?.preferredPlatformId ||
      game.platforms[0]?.platformId ||
      'custom';

    const existingCfg = this.getLaunchConfig(game.id, resolvedPlatformId) || {
      gameId: game.id,
      launchMethod: 'direct' as LaunchMethod,
    };

    const normalizedExe = selectedExe.replace(/[\\/]+$/, '');
    const lastSepIdx = Math.max(normalizedExe.lastIndexOf('/'), normalizedExe.lastIndexOf('\\'));
    const exeDir = lastSepIdx > 0 ? normalizedExe.slice(0, lastSepIdx) : undefined;
    const isWinExeOnMac = !this.isWindowsHost() && /\.exe$/i.test(selectedExe);

    let resolvedLaunchMethod: LaunchMethod;
    if (isWinExeOnMac) {
      resolvedLaunchMethod =
        existingCfg.launchMethod === 'compatibility_layer' ? 'compatibility_layer' : 'auto';
    } else {
      resolvedLaunchMethod = 'direct';
    }

    const updatedCfg: GameLaunchConfig = {
      ...existingCfg,
      gameId: game.id,
      preferredPlatformId: resolvedPlatformId,
      launchMethod: resolvedLaunchMethod,
      customExecutablePath: selectedExe,
      ...(exeDir ? { workingDirectory: exeDir } : {}),
    };

    await this.saveLaunchConfig(updatedCfg, resolvedPlatformId);

    const resolvedPlatformGameId =
      game.platforms.find((p) => p.platformId === resolvedPlatformId)?.platformGameId || game.id;

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:game-installed', {
          detail: {
            gameId: game.id,
            platformId: resolvedPlatformId,
            platformGameId: resolvedPlatformGameId,
            installPath: exeDir || selectedExe,
            executablePath: selectedExe,
            isWindowsBinaryOnMac: isWinExeOnMac,
            installed: true,
          },
        })
      );
    }

    this.notifyStateChanged();
    return selectedExe;
  }

  public async selectExecutable(defaultPath?: string): Promise<string | null> {
    if (typeof window !== 'undefined' && window.electronAPI?.selectExecutableDialog) {
      return await window.electronAPI.selectExecutableDialog(defaultPath);
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
    config: Partial<GameLaunchConfig | StorefrontLaunchProfile>
  ): StorefrontLaunchProfile {
    return extractStorefrontProfileFromConfig(config);
  }

  public async saveLaunchConfig(
    config: GameLaunchConfig,
    platformId?: StorefrontId
  ): Promise<void> {
    if (!config || !config.gameId) return;
    const nextConfig = buildMergedSaveLaunchConfig(
      this.launchConfigs[config.gameId],
      config,
      platformId
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

  public async resetLaunchConfig(
    gameId: string,
    platformId?: StorefrontId
  ): Promise<void> {
    if (!gameId) return;

    if (platformId && this.launchConfigs[gameId]?.platformConfigs) {
      const nextPlatformConfigs = { ...this.launchConfigs[gameId].platformConfigs };
      delete nextPlatformConfigs[platformId];
      const remainingIds = Object.keys(nextPlatformConfigs) as StorefrontId[];

      if (remainingIds.length > 0) {
        const fallbackPlatId = remainingIds[0];
        const fallbackProfile = nextPlatformConfigs[fallbackPlatId] || { launchMethod: 'auto' };
        const updatedConfig: GameLaunchConfig = {
          gameId,
          preferredPlatformId: fallbackPlatId,
          launchMethod: fallbackProfile.launchMethod || 'auto',
          ...fallbackProfile,
          platformConfigs: nextPlatformConfigs,
        };
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
    const savedConfig = game
      ? this.getLaunchConfig(game.id, targetPlatformId)
      : undefined;
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
      globalStorefrontLifecycle: this.getPerformanceSettings().storefrontClientLifecycle,
      installedStorefrontClients: this.installedStorefrontClients,
    });
  }

  public openDownloadDrawer(): void {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('antigravity:open-download-drawer'));
    }
  }
}

export const launcherService = new LauncherService();
