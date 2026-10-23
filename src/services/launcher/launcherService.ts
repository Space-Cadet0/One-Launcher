import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  resolveEffectiveLaunchPolicy,
  resolveEffectiveLifecyclePolicy,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  type ActiveGameSession,
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
  type CompatibilityLayerUpdateInfo,
  type DiskSpaceInfo,
  type DownloadTaskState,
  type FastMinimalLaunchAdvisory,
  type GameInstallInfo,
  type GameLaunchConfig,
  type GameLaunchConfigResetRequest,
  type InstallCompatibilityLayerResult,
  type InstalledGameRecord,
  type InstallGameRequest,
  type LauncherActionResult,
  type LauncherPerformanceSettings,
  type LaunchMethod,
  type ResolvedLaunchModePreview,
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

  constructor() {
    this.loadLocalConfigs();
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
        const saved = (res as any)?.settings || res;
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

    if (timer && typeof (timer as any).unref === 'function') {
      (timer as any).unref();
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
        this.unsubscribeHibernate = window.electronAPI.onHibernateStateChanged((data: any) => {
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
        });
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
        ]);

        if (perfSettings && typeof perfSettings === 'object') {
          const remotePerf = (perfSettings as any).settings || perfSettings;
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
          for (const key of ['steam', 'gog', 'epic'] as const) {
            if (typeof (detectedClients as Record<string, unknown>)[key] === 'boolean') {
              nextClients[key] = (detectedClients as Record<'steam' | 'gog' | 'epic', boolean>)[
                key
              ];
            }
          }
          this.installedStorefrontClients = nextClients;
        }

        const drainedList = Array.isArray(pendingSessions)
          ? pendingSessions
          : Array.isArray((pendingSessions as any)?.pendingSessions)
            ? (pendingSessions as any).pendingSessions
            : Array.isArray((pendingSessions as any)?.sessions)
              ? (pendingSessions as any).sessions
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

    const task = data?.task;
    if (task && task.status === 'completed') {
      const installPath = task.finalInstallPath || task.installDir;
      const isWindowsBinaryOnMac =
        !this.isWindowsHost() &&
        (Boolean(task.isWindowsBinaryOnMac) ||
          Boolean(task.executablePath && /\.exe$/i.test(task.executablePath)) ||
          /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
            String(task.executablePath || installPath || '')
          ));
      const newRecord: InstalledGameRecord = {
        platformId: task.platformId,
        platformGameId: task.platformGameId,
        appId: task.platformId === 'steam' ? task.steamAppId : undefined,
        title: task.title,
        installPath,
        executablePath: task.executablePath,
        installSize: task.totalBytes,
        runner: 'one_launcher',
        isWindowsBinaryOnMac,
      };

      const existingIdx = this.installedRecords.findIndex(
        (r) =>
          r.platformId === newRecord.platformId &&
          String(r.platformGameId) === String(newRecord.platformGameId)
      );
      if (existingIdx >= 0) {
        this.installedRecords[existingIdx] = { ...this.installedRecords[existingIdx], ...newRecord };
      } else {
        this.installedRecords.push(newRecord);
      }
      this.installedIndexMutationSeq++;

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity:game-installed', {
            detail: {
              gameId: task.gameId,
              platformId: task.platformId,
              platformGameId: task.platformGameId,
              installPath,
              executablePath: task.executablePath,
              isWindowsBinaryOnMac,
              installed: true,
            },
          })
        );
      }
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
    const apiPlatform = typeof window !== 'undefined' ? (window as any)?.electronAPI?.platform : undefined;
    if (apiPlatform === 'win32' || apiPlatform === 'darwin' || apiPlatform === 'linux') {
      return apiPlatform;
    }
    if (typeof navigator !== 'undefined') {
      const ua = navigator.platform || navigator.userAgent || '';
      if (/Win/i.test(ua)) return 'win32';
      if (/Linux/i.test(ua)) return 'linux';
    }
    return 'darwin';
  }

  public isWindowsHost(): boolean {
    return this.getHostPlatform() === 'win32';
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
          if (res && res.success && Array.isArray(res.installedGames)) {
            const isWin = this.isWindowsHost();
            if (res.epicPlatformSupport && typeof res.epicPlatformSupport === 'object') {
              this.epicPlatformSupportMap = { ...res.epicPlatformSupport };
            }
            this.installedRecords = this.attachEpicPlatformSupportMetadata(
              res.installedGames.map((r) => (isWin ? { ...r, isWindowsBinaryOnMac: false } : r))
            );
            this.lastScanTimestamp = Date.now();

            const hasAnyCustomExe = Object.values(this.launchConfigs).some(
              (c) =>
                Boolean(c?.customExecutablePath) ||
                (c?.platformConfigs &&
                  Object.values(c.platformConfigs).some((p) => Boolean(p?.customExecutablePath)))
            );
            if (
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
                this.downloadQueue[i] = {
                  ...task,
                  status: 'completed',
                  progressPercent: 100,
                  bytesDownloaded: matchedRecord.installSize || task.totalBytes,
                  totalBytes: matchedRecord.installSize || task.totalBytes,
                  speedBytesPerSec: 0,
                  etaSeconds: 0,
                  finalInstallPath: matchedRecord.installPath,
                  executablePath: matchedRecord.executablePath,
                  isWindowsBinaryOnMac: matchedRecord.isWindowsBinaryOnMac,
                  completedAt: new Date().toISOString(),
                  statusMessage: 'Installation complete',
                };

                if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                  window.dispatchEvent(
                    new CustomEvent('antigravity:game-installed', {
                      detail: {
                        gameId: task.gameId,
                        platformId: task.platformId,
                        platformGameId: task.platformGameId,
                        installPath: matchedRecord.installPath,
                        executablePath: matchedRecord.executablePath,
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
                const wasPresent = prevRecords.some(
                  (p) =>
                    p.platformId === rec.platformId &&
                    String(p.platformGameId) === String(rec.platformGameId)
                );
                if (!wasPresent) {
                  window.dispatchEvent(
                    new CustomEvent('antigravity:game-installed', {
                      detail: {
                        gameId: `${rec.platformId}-${rec.platformGameId}`,
                        platformId: rec.platformId,
                        platformGameId: rec.platformGameId,
                        installPath: rec.installPath,
                        executablePath: rec.executablePath,
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
          for (const key of ['steam', 'gog', 'epic'] as const) {
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
    } catch (err: any) {
      return {
        success: false,
        runnerType,
        error: err?.message || 'Failed to install compatibility layer.',
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
    } catch (err: any) {
      return {
        success: false,
        runnerType,
        updated: false,
        message: err?.message || 'Failed to update compatibility layer.',
        error: err?.message || 'Failed to update compatibility layer.',
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

    for (const r of this.installedRecords) {
      if (!r) continue;
      if (r.platformGameId !== undefined && r.platformGameId !== null && r.platformGameId !== '') {
        const key = `${r.platformId}:${String(r.platformGameId)}`;
        if (!byPlatGameKey.has(key)) byPlatGameKey.set(key, r);
      }
      if (r.platformId === 'steam') {
        const appIdNum = Number(r.appId || r.platformGameId);
        if (Number.isFinite(appIdNum) && appIdNum > 0 && !bySteamAppId.has(appIdNum)) {
          bySteamAppId.set(appIdNum, r);
        }
      }
      if (r.installPath) {
        const key = `${r.platformId}:${r.installPath}`;
        if (!byPlatInstallPath.has(key)) byPlatInstallPath.set(key, r);
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

    // 1. O(1) indexed helper to check matching platform records in installedRecords
    const matchPlatformRecord = (p: GamePlatformOwnership): InstalledGameRecord | undefined => {
      const pGameId = String(p.platformGameId || (p as any).storefrontAppId || '');
      if (pGameId) {
        const byPlatKey = idx.byPlatGameKey.get(`${p.platformId}:${pGameId}`);
        if (byPlatKey) return byPlatKey;
      }
      if (p.platformId === 'steam' && game.steamAppId) {
        const bySteamApp = idx.bySteamAppId.get(Number(game.steamAppId));
        if (bySteamApp) return bySteamApp;
      }

      if (p.installPath) {
        const byInstall = idx.byPlatInstallPath.get(`${p.platformId}:${p.installPath}`);
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

      if (p.installed && (p.installPath || p.executablePath)) {
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
          title: game.title,
          installPath: p.installPath || '',
          executablePath: p.executablePath,
          launchArguments: p.launchArguments,
          installSize: p.installSize,
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
              (targetPlat as any)?.storefrontAppId ||
              game.platforms[0]?.platformGameId ||
              game.id
          ),
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
    const targetId = preferredPlatformId || validRememberedId || cfg?.preferredPlatformId;

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
            isWindowsBinaryOnMac: this.isWindowsHost()
              ? false
              : (rec.isWindowsBinaryOnMac ?? found.isWindowsBinaryOnMac),
          };
        }
        return found;
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
          isWindowsBinaryOnMac: this.isWindowsHost()
            ? false
            : (installedRecord.isWindowsBinaryOnMac ?? matchingPlat.isWindowsBinaryOnMac),
        };
      }
    }

    const installedPlat = game.platforms.find((p) => p.installed);
    if (installedPlat) return installedPlat;

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
        const info: GameInstallInfo = {
          ...res,
          hostPlatform: resHostPlatform,
        };
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

    const fallbackInfo: GameInstallInfo = {
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
    };
    this.setCachedInstallInfoEntry(`${game.id}:${resolvedPlatformId}`, fallbackInfo);
    return fallbackInfo;
  }

  private setCachedInstallInfoEntry(key: string, info: GameInstallInfo): void {
    if (!key) return;
    if (this.installInfoCache.has(key)) {
      this.installInfoCache.delete(key);
    }
    while (this.installInfoCache.size >= LauncherService.MAX_INSTALL_INFO_CACHE_SIZE) {
      const oldestKey = this.installInfoCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.installInfoCache.delete(oldestKey);
    }
    this.installInfoCache.set(key, info);
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
      this.getLaunchConfig(game.id)?.preferredPlatformId ||
      effPlatform?.platformId ||
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
        (resolvedPlatformId === 'gog' || resolvedPlatformId === 'epic') &&
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
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Failed to launch game.',
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
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Failed to stop game.',
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
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Failed to start installation.',
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
      const record: InstalledGameRecord = {
        platformId: resolvedPlatformId,
        platformGameId: String(resolvedPlatformGameId),
        appId:
          resolvedPlatformId === 'steam'
            ? game.steamAppId || Number(resolvedPlatformGameId) || undefined
            : undefined,
        title: game.title,
        installPath: effPlatform?.installPath || '',
        executablePath: effPlatform?.executablePath,
        runner: 'custom',
      };
      if (existingIdx >= 0) {
        this.installedRecords[existingIdx] = { ...this.installedRecords[existingIdx], ...record };
      } else {
        this.installedRecords.push(record);
      }
      this.installedIndexMutationSeq++;
    } else {
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
                String(r.platformGameId) === String(resolvedPlatformGameId)) ||
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
        installPath,
      });
    }

    if (res.success) {
      this.installedRecords = this.attachEpicPlatformSupportMetadata(
        this.installedRecords.filter(
          (r) =>
            !(
              r.platformId === resolvedPlatformId &&
              String(r.platformGameId) === String(resolvedPlatformGameId)
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
