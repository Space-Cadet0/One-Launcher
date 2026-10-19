import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerDescriptor,
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  GameLaunchConfig,
  InstallCompatibilityLayerResult,
  InstalledGameRecord,
  InstallGameRequest,
  LauncherActionResult,
  LaunchMethod,
  ResolvedLaunchModePreview,
  StorefrontLaunchProfile,
  UpdateCompatibilityLayerResult,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';
import { steamApi } from '../steam/steamApi';

const LAUNCH_CONFIGS_STORAGE_KEY = 'one_launcher_game_configs_v1';

export const COMPATIBILITY_RUNNER_DESCRIPTORS: CompatibilityRunnerDescriptor[] = [
  {
    type: 'crossover',
    label: 'CrossOver (Recommended)',
    shortLabel: 'CrossOver',
    vendor: 'CodeWeavers',
    description:
      'Commercial Windows compatibility layer for macOS with built-in Bottle management, D3DMetal, DXMT, DXVK, and MetalFX DLSS upscaling.',
    bestFor:
      'Best overall compatibility for DirectX 9/10/11/12 Windows games and Windows Steam/GOG/Epic bottles.',
    downloadUrl: 'https://www.codeweavers.com/crossover/download',
    downloadLabel: 'Download CrossOver Installer',
    brewCask: 'crossover',
    brewCommandDisplay: 'brew install --cask crossover',
    canAutoInstallViaBrew: true,
  },
  {
    type: 'crossover_preview',
    label: 'CrossOver Preview',
    shortLabel: 'CrossOver Preview',
    vendor: 'CodeWeavers',
    description:
      'Early-access preview build of CrossOver featuring the latest experimental Wine, D3DMetal, and DXMT updates.',
    bestFor:
      'Testing newly released Windows titles that need bleeding-edge graphics translation fixes.',
    downloadUrl: 'https://www.codeweavers.com/preview',
    downloadLabel: 'Open CrossOver Preview Page',
    canAutoInstallViaBrew: false,
  },
  {
    type: 'gptk',
    label: 'Apple Game Porting Toolkit (GPTK / D3DMetal)',
    shortLabel: 'Apple GPTK',
    vendor: 'Apple',
    description:
      'Apple’s DirectX 11/12-to-Metal 3 runtime (D3DMetal), detected from /Applications/Game Porting Toolkit.app or Heroic GPTK tools.',
    bestFor:
      'Running DirectX 12 Windows executables on Apple Silicon using Apple’s standalone D3DMetal runtime.',
    downloadUrl: 'https://developer.apple.com/games/game-porting-toolkit/',
    downloadLabel: 'Open Apple GPTK Downloads',
    brewCask: 'game-porting-toolkit',
    brewCommandDisplay:
      'brew tap apple/apple http://github.com/apple/homebrew-apple && brew install --cask game-porting-toolkit',
    canAutoInstallViaBrew: false,
  },
  {
    type: 'wine',
    label: 'Open-Source Wine (Wine-CrossOver / Wine Stable)',
    shortLabel: 'Open-Source Wine',
    vendor: 'WineHQ / Homebrew / Gcenx',
    description:
      'Free, open-source Windows API translation layer (wine64) installed via Homebrew, WineHQ (.app), or Heroic Wine-CrossOver builds.',
    bestFor:
      'Running DRM-free or standalone DirectX 9/10/11 Windows .exe games without a paid CrossOver license.',
    downloadUrl: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
    downloadLabel: 'Open Official WineHQ macOS Guide',
    brewCask: 'wine-stable',
    brewCommandDisplay: 'brew install --cask --no-quarantine wine-stable',
    canAutoInstallViaBrew: true,
  },
];

function sanitizeLegacyCompatLayer(layer?: any): CompatibilityLayerType | undefined {
  if (!layer) return undefined;
  if (layer === 'whisky') return 'crossover';
  return layer as CompatibilityLayerType;
}

export class LauncherService {
  private installedRecords: InstalledGameRecord[] = [];
  private activeSessions: Map<string, ActiveGameSession> = new Map();
  private downloadQueue: DownloadTaskState[] = [];
  private launchConfigs: Record<string, GameLaunchConfig> = {};
  private compatibilityLayers: CompatibilityLayerInfo[] = [];
  private runnerUpdates: Record<string, CompatibilityLayerUpdateInfo> = {};
  private listeners: Set<() => void> = new Set();
  private initialized = false;
  private unsubscribeDownload?: () => void;
  private unsubscribeSession?: () => void;
  private focusListener?: () => void;
  private activeDownloadPollTimer?: ReturnType<typeof setInterval> | null;
  private inFlightScanPromise: Promise<InstalledGameRecord[]> | null = null;
  private lastScanTimestamp = 0;

  constructor() {
    this.loadLocalConfigs();
  }

  private sanitizeGameLaunchConfig(cfg: GameLaunchConfig): GameLaunchConfig {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const nextCfg: GameLaunchConfig = {
      ...cfg,
      ...(cfg.compatibilityLayer
        ? { compatibilityLayer: sanitizeLegacyCompatLayer(cfg.compatibilityLayer) }
        : {}),
    };
    if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
      const nextPlatCfgs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {};
      for (const [platId, p] of Object.entries(cfg.platformConfigs)) {
        if (p) {
          nextPlatCfgs[platId as StorefrontId] = {
            ...p,
            ...(p.compatibilityLayer
              ? { compatibilityLayer: sanitizeLegacyCompatLayer(p.compatibilityLayer) }
              : {}),
          };
        }
      }
      nextCfg.platformConfigs = nextPlatCfgs;
    }
    return nextCfg;
  }

  private loadLocalConfigs(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(LAUNCH_CONFIGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const sanitized: Record<string, GameLaunchConfig> = {};
          for (const [gid, cfg] of Object.entries(parsed)) {
            if (cfg && typeof cfg === 'object') {
              sanitized[gid] = this.sanitizeGameLaunchConfig(cfg as GameLaunchConfig);
            }
          }
          this.launchConfigs = sanitized;
        }
      }
    } catch {}
  }

  private persistLocalConfigs(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(LAUNCH_CONFIGS_STORAGE_KEY, JSON.stringify(this.launchConfigs));
    } catch {}
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
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:launcher-state-changed', {
          detail: {
            runningGames: this.getRunningGames(),
            downloadQueue: this.getDownloadQueue(),
            installedRecords: this.installedRecords,
          },
        })
      );
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
    if (!this.hasActiveDownloads()) {
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
      if (!this.hasActiveDownloads()) {
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

      try {
        const [configs, running, queue, layers] = await Promise.all([
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
        ]);

        if (configs && typeof configs === 'object') {
          const diskConfigs = configs as Record<string, GameLaunchConfig>;
          const nextConfigs: Record<string, GameLaunchConfig> = {
            ...this.launchConfigs,
            ...diskConfigs,
          };
          if (typeof window.electronAPI.getGameLaunchConfigs === 'function') {
            for (const [gid, localCfg] of Object.entries(nextConfigs)) {
              let updatedCfg = localCfg;
              if (updatedCfg?.customExecutablePath && !diskConfigs[gid]?.customExecutablePath) {
                const { customExecutablePath: _ce, workingDirectory: _wd, ...rest } = updatedCfg;
                updatedCfg = rest as GameLaunchConfig;
              }
              if (updatedCfg?.platformConfigs) {
                const nextPlatCfgs = { ...updatedCfg.platformConfigs };
                let platChanged = false;
                for (const [platId, platProfile] of Object.entries(nextPlatCfgs)) {
                  const diskPlatProfile = diskConfigs[gid]?.platformConfigs?.[platId as StorefrontId];
                  if (platProfile?.customExecutablePath && !diskPlatProfile?.customExecutablePath) {
                    const { customExecutablePath: _ce, workingDirectory: _wd, ...restPlat } = platProfile;
                    nextPlatCfgs[platId as StorefrontId] = restPlat;
                    platChanged = true;
                  }
                }
                if (platChanged) {
                  updatedCfg = {
                    ...updatedCfg,
                    platformConfigs: nextPlatCfgs,
                  };
                }
              }
              nextConfigs[gid] = this.sanitizeGameLaunchConfig(updatedCfg);
            }
          }
          this.launchConfigs = nextConfigs;
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
      } catch (err) {
        console.warn('[LauncherService] Initialization sync warning:', err);
      }

      this.lastScanTimestamp = 0;
      await this.scanAllInstalledGames(true);
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
      const newRecord: InstalledGameRecord = {
        platformId: task.platformId,
        platformGameId: task.platformGameId,
        appId: task.platformId === 'steam' ? task.steamAppId : undefined,
        title: task.title,
        installPath,
        executablePath: task.executablePath,
        installSize: task.totalBytes,
        runner: 'one_launcher',
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

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('antigravity:game-installed', {
            detail: {
              gameId: task.gameId,
              platformId: task.platformId,
              platformGameId: task.platformGameId,
              installPath,
              executablePath: task.executablePath,
              installed: true,
            },
          })
        );
      }
    }

    this.ensureActiveDownloadPolling();
    this.notifyStateChanged();
  }

  private handleSessionUpdated(data: {
    session?: ActiveGameSession;
    event?: 'started' | 'stopping' | 'stopped';
    sessionMinutesPlayed?: number;
    durationSeconds?: number;
    lastPlayed?: string;
    error?: string;
  }): void {
    const session = data?.session;
    if (!session || !session.gameId) return;

    if (data.event === 'stopped') {
      this.activeSessions.delete(session.gameId);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
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
              },
            })
          );
        }
      }
    } else {
      this.activeSessions.set(session.gameId, session);
    }

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

  public async scanAllInstalledGames(forceRefresh = false): Promise<InstalledGameRecord[]> {
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
            this.installedRecords = res.installedGames.map((r) =>
              isWin ? { ...r, isWindowsBinaryOnMac: false } : r
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
                  let cfgChanged = false;
                  for (const [gid, localCfg] of Object.entries(this.launchConfigs)) {
                    if (!localCfg) continue;
                    const diskCfg = freshConfigs[gid];
                    let updatedCfg = localCfg;
                    if (updatedCfg.customExecutablePath && (!diskCfg || !diskCfg.customExecutablePath)) {
                      const { customExecutablePath: _ce, workingDirectory: _wd, ...rest } = updatedCfg;
                      updatedCfg = rest as GameLaunchConfig;
                      cfgChanged = true;
                    }
                    if (updatedCfg.platformConfigs) {
                      const nextPlatCfgs = { ...updatedCfg.platformConfigs };
                      let platChanged = false;
                      for (const [platId, platProfile] of Object.entries(nextPlatCfgs)) {
                        const diskPlatProfile = diskCfg?.platformConfigs?.[platId as StorefrontId];
                        if (platProfile?.customExecutablePath && !diskPlatProfile?.customExecutablePath) {
                          const { customExecutablePath: _ce, workingDirectory: _wd, ...restPlat } = platProfile;
                          nextPlatCfgs[platId as StorefrontId] = restPlat;
                          platChanged = true;
                        }
                      }
                      if (platChanged) {
                        updatedCfg = {
                          ...updatedCfg,
                          platformConfigs: nextPlatCfgs,
                        };
                        cfgChanged = true;
                      }
                    }
                    if (updatedCfg !== localCfg) {
                      this.launchConfigs[gid] = updatedCfg;
                    }
                  }
                  if (cfgChanged) {
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
                        installed: true,
                      },
                    })
                  );
                }
              }
            }

            // 2. Dispatch antigravity:game-installed for any newly discovered installation
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
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
          this.compatibilityLayers = layers;
          this.notifyStateChanged();
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
          this.runnerUpdates = res;
          this.notifyStateChanged();
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

  public getInstalledRecordForGame(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ): InstalledGameRecord | undefined {
    if (!game) return undefined;

    const cfg = this.getLaunchConfig(game.id);

    // 1. Helper to check matching platform records in installedRecords
    const matchPlatformRecord = (p: GamePlatformOwnership): InstalledGameRecord | undefined => {
      const exact = this.installedRecords.find(
        (r) =>
          r.platformId === p.platformId &&
          (String(r.platformGameId) === String(p.platformGameId) ||
            (p.platformId === 'steam' &&
              game.steamAppId &&
              Number(r.appId || r.platformGameId) === Number(game.steamAppId)))
      );
      if (exact) return exact;

      if (p.installed && (p.installPath || p.executablePath)) {
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
          isWindowsBinaryOnMac: this.isWindowsHost() ? false : p.isWindowsBinaryOnMac,
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
        const bySteamId = this.installedRecords.find(
          (r) =>
            r.platformId === 'steam' &&
            Number(r.appId || r.platformGameId) === Number(game.steamAppId)
        );
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
      const bySteamId = this.installedRecords.find(
        (r) =>
          r.platformId === 'steam' &&
          Number(r.appId || r.platformGameId) === Number(game.steamAppId)
      );
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
          };
        }
      }
    }

    return undefined;
  }

  public getEffectivePlatformForGame(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ): GamePlatformOwnership | undefined {
    if (!game || !Array.isArray(game.platforms) || game.platforms.length === 0) {
      return undefined;
    }

    const cfg = this.getLaunchConfig(game.id);
    const targetId = preferredPlatformId || cfg?.preferredPlatformId;

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

    if (typeof window !== 'undefined' && window.electronAPI?.getGameInstallInfo) {
      try {
        const cachedSteamMeta = game.steamAppId
          ? steamApi.getCachedMetadata(Number(game.steamAppId))
          : undefined;
        const steamPlatforms =
          cachedSteamMeta?.platforms || game.enrichedMetadata?.platforms;
        const res = await window.electronAPI.getGameInstallInfo({
          gameId: game.id,
          title: game.title,
          platformId: resolvedPlatformId,
          platformGameId: resolvedPlatformGameId,
          steamAppId: game.steamAppId,
          targetInstallDir,
          steamPlatforms,
        });
        return {
          ...res,
          hostPlatform: res.hostPlatform || hostPlatform,
        };
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

    return {
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
        : undefined,
      canDirectDownload: resolvedPlatformId === 'gog',
      requiresStoreClientFallback: resolvedPlatformId !== 'gog',
      diskSpace,
    };
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

    const launchConfig = this.getLaunchConfig(game.id, resolvedPlatformId);
    const installedRecord = this.getInstalledRecordForGame(game, resolvedPlatformId);
    const targetPlatformObj =
      game.platforms.find((p) => p.platformId === resolvedPlatformId) || effPlatform;

    const resolvedPlatformGameId =
      installedRecord?.platformGameId ||
      targetPlatformObj?.platformGameId ||
      (game.steamAppId ? String(game.steamAppId) : game.id);

    const installPath = installedRecord?.installPath || targetPlatformObj?.installPath;
    const executablePath =
      launchConfig?.customExecutablePath ||
      installedRecord?.executablePath ||
      targetPlatformObj?.executablePath;
    const launchArguments =
      launchConfig?.launchArguments ||
      installedRecord?.launchArguments ||
      targetPlatformObj?.launchArguments;
    const isWindowsBinaryOnMac =
      installedRecord?.isWindowsBinaryOnMac ?? targetPlatformObj?.isWindowsBinaryOnMac;

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
        });

        if (res.success && res.session) {
          this.activeSessions.set(game.id, res.session);
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
    const session: ActiveGameSession = {
      sessionId: `web-session-${Date.now()}`,
      gameId: game.id,
      title: game.title,
      platformId: resolvedPlatformId,
      platformGameId: resolvedPlatformGameId,
      startedAt: new Date().toISOString(),
      launchMethod: 'storefront_uri',
      executablePath,
      status: 'running',
    };

    this.activeSessions.set(game.id, session);
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
      this.installedRecords = this.installedRecords.filter(
        (r) =>
          !(
            (r.platformId === resolvedPlatformId &&
              String(r.platformGameId) === String(resolvedPlatformGameId)) ||
            (resolvedPlatformId === 'steam' &&
              game.steamAppId &&
              Number(r.appId || r.platformGameId) === Number(game.steamAppId))
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
      this.installedRecords = this.installedRecords.filter(
        (r) =>
          !(
            r.platformId === resolvedPlatformId &&
            String(r.platformGameId) === String(resolvedPlatformGameId)
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

    const updatedCfg: GameLaunchConfig = {
      ...existingCfg,
      gameId: game.id,
      preferredPlatformId: resolvedPlatformId,
      launchMethod:
        existingCfg.launchMethod && existingCfg.launchMethod !== 'storefront_uri'
          ? existingCfg.launchMethod
          : 'direct',
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
    const profileKeys: (keyof StorefrontLaunchProfile)[] = [
      'launchMethod',
      'customExecutablePath',
      'workingDirectory',
      'launchArguments',
      'environmentVariables',
      'compatibilityLayer',
      'wineBottleName',
      'winePrefixPath',
      'crossoverGraphicsBackend',
      'crossoverHighResolutionMode',
      'crossoverDlss',
      'wineMsync',
      'wineEsync',
      'metalHud',
      'dxvkHud',
      'preLaunchCommand',
      'postExitCommand',
    ];
    const profile: StorefrontLaunchProfile = {};
    for (const key of profileKeys) {
      const val = config[key];
      if (val !== undefined) {
        (profile as any)[key] =
          key === 'compatibilityLayer' ? sanitizeLegacyCompatLayer(val) : val;
      }
    }
    if (profile.wineMsync === true && profile.wineEsync === true) {
      profile.wineEsync = false;
    }
    return profile;
  }

  public async saveLaunchConfig(
    config: GameLaunchConfig,
    platformId?: StorefrontId
  ): Promise<void> {
    if (!config || !config.gameId) return;
    const targetPlatformId = platformId || config.preferredPlatformId;
    const existing = this.launchConfigs[config.gameId];
    const profile = this.extractStorefrontProfile(config);

    const mergedPlatformConfigs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...(existing?.platformConfigs || {}),
    };

    if (config.platformConfigs) {
      for (const [platId, p] of Object.entries(config.platformConfigs)) {
        if (p) {
          mergedPlatformConfigs[platId as StorefrontId] = this.extractStorefrontProfile(p);
        }
      }
    }

    if (targetPlatformId) {
      mergedPlatformConfigs[targetPlatformId] = profile;
    }

    const nextConfig: GameLaunchConfig = {
      gameId: config.gameId,
      ...(targetPlatformId
        ? { preferredPlatformId: targetPlatformId }
        : existing?.preferredPlatformId
          ? { preferredPlatformId: existing.preferredPlatformId }
          : {}),
      launchMethod: profile.launchMethod || 'auto',
      ...profile,
      ...(Object.keys(mergedPlatformConfigs).length > 0
        ? { platformConfigs: mergedPlatformConfigs }
        : {}),
    };

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
        this.launchConfigs[gameId] = {
          gameId,
          preferredPlatformId: fallbackPlatId,
          launchMethod: fallbackProfile.launchMethod || 'auto',
          ...fallbackProfile,
          platformConfigs: nextPlatformConfigs,
        };
        this.persistLocalConfigs();

        if (typeof window !== 'undefined' && window.electronAPI?.saveGameLaunchConfig) {
          try {
            await window.electronAPI.saveGameLaunchConfig({
              ...this.launchConfigs[gameId],
              resetPlatformId: platformId,
            } as any);
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
        await window.electronAPI.saveGameLaunchConfig({
          gameId,
          launchMethod: 'auto',
          reset: true,
        } as any);
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
    const rawBase = this.launchConfigs[gameId];
    if (!rawBase) return undefined;
    const base = this.sanitizeGameLaunchConfig(rawBase);

    if (!platformId) {
      if (base.preferredPlatformId && base.platformConfigs?.[base.preferredPlatformId]) {
        const prefProfile = base.platformConfigs[base.preferredPlatformId]!;
        return {
          ...base,
          ...prefProfile,
          launchMethod: prefProfile.launchMethod || base.launchMethod || 'auto',
        };
      }
      return base;
    }

    const platProfile = base.platformConfigs?.[platformId];
    if (platProfile) {
      return {
        gameId: base.gameId,
        preferredPlatformId: platformId,
        launchMethod: platProfile.launchMethod || 'auto',
        ...platProfile,
        platformConfigs: base.platformConfigs,
      };
    }

    if (base.platformConfigs && Object.keys(base.platformConfigs).length > 0) {
      if (base.preferredPlatformId === platformId) {
        return base;
      }
      return undefined;
    }

    if (!base.preferredPlatformId || base.preferredPlatformId === platformId) {
      return base;
    }
    return undefined;
  }

  public getAllLaunchConfigs(): Record<string, GameLaunchConfig> {
    return { ...this.launchConfigs };
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
    const mergedDraft = { ...savedConfig, ...draftConfig };

    const installedRecord = game
      ? this.getInstalledRecordForGame(game, targetPlatformId)
      : undefined;
    const effPlatform = game
      ? this.getEffectivePlatformForGame(game, targetPlatformId)
      : undefined;
    const layers = this.getCompatibilityLayers();

    const hasCustomExecKeyInDraft =
      draftConfig !== undefined && 'customExecutablePath' in draftConfig;
    const effectiveRecordExec =
      installedRecord?.runner === 'custom' &&
      hasCustomExecKeyInDraft &&
      !draftConfig?.customExecutablePath
        ? undefined
        : installedRecord?.executablePath;
    const effectiveRecordInstallPath =
      installedRecord?.runner === 'custom' &&
      hasCustomExecKeyInDraft &&
      !draftConfig?.customExecutablePath
        ? undefined
        : installedRecord?.installPath;

    const executablePath =
      (draftConfig?.customExecutablePath?.trim() || undefined) ||
      (!hasCustomExecKeyInDraft ? savedConfig?.customExecutablePath : undefined) ||
      effectiveRecordExec ||
      effPlatform?.executablePath;

    const installPath =
      effectiveRecordInstallPath || effPlatform?.installPath;

    const isInstalled = Boolean(
      executablePath || installPath || effPlatform?.installed
    );

    const platformId: StorefrontId =
      targetPlatformId ||
      installedRecord?.platformId ||
      effPlatform?.platformId ||
      (game?.steamAppId ? 'steam' : 'custom');

    const storeName =
      platformId === 'steam'
        ? 'Steam'
        : platformId === 'epic'
          ? 'Epic Games'
          : platformId === 'gog'
            ? 'GOG Galaxy'
            : 'Storefront';
    const storeProtocol =
      platformId === 'steam'
        ? 'steam://'
        : platformId === 'epic'
          ? 'com.epicgames.launcher://'
          : platformId === 'gog'
            ? 'goggalaxy://'
            : 'storefront URI';

    const selectedLayerType = sanitizeLegacyCompatLayer(mergedDraft.compatibilityLayer);
    const activeLayer =
      (selectedLayerType && selectedLayerType !== 'native'
        ? layers.find((l) => l.type === selectedLayerType)
        : undefined) ||
      layers.find(
        (l) => l.type === 'crossover' || l.type === 'crossover_preview'
      ) ||
      layers[0];
    const layerName =
      activeLayer?.name ||
      (selectedLayerType && selectedLayerType !== 'native'
        ? COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === selectedLayerType)?.shortLabel ||
          selectedLayerType
        : 'CrossOver / Wine');
    const bottleName =
      mergedDraft.wineBottleName || activeLayer?.availableBottles?.[0];

    let detectedBuildType: ResolvedLaunchModePreview['detectedBuildType'] =
      'not_installed';
    let detectedBuildLabel = 'Not Installed Locally';
    let detectedBuildDetail =
      'Install this game first or link an existing executable below.';

    if (!isInstalled) {
      detectedBuildType = 'not_installed';
      detectedBuildLabel = 'Not Installed Locally';
      detectedBuildDetail =
        'Install this game first or link an existing executable below.';
    } else if (hostPlatform === 'win32') {
      detectedBuildType = 'windows_native';
      detectedBuildLabel = 'Windows Native Build (.exe)';
      detectedBuildDetail =
        executablePath || installPath || 'Installed on Windows';
    } else {
      const isExplicitAppBundle = Boolean(
        (executablePath && /\.app(\/|$)/i.test(executablePath)) ||
          (!executablePath && installPath && /\.app$/i.test(installPath))
      );
      const isBottlePath = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
        String(executablePath || installPath || '')
      );
      const isExeOnMac =
        Boolean(executablePath && /\.exe$/i.test(executablePath)) ||
        (!isExplicitAppBundle &&
          (Boolean(
            installedRecord?.isWindowsBinaryOnMac ||
              effPlatform?.isWindowsBinaryOnMac
          ) ||
            isBottlePath ||
            Boolean(mergedDraft.wineBottleName || mergedDraft.winePrefixPath)));

      if (isExeOnMac) {
        detectedBuildType = 'windows_exe_on_mac';
        detectedBuildLabel = 'Windows Build (.exe) on macOS';
        detectedBuildDetail =
          'Requires CrossOver / Wine translation layer on Apple Silicon';
      } else if (isExplicitAppBundle) {
        detectedBuildType = 'mac_native_app';
        detectedBuildLabel = 'macOS Native App Bundle (.app)';
        detectedBuildDetail =
          'Runs natively on macOS without translation layers';
      } else {
        detectedBuildType = 'mac_native_bin';
        detectedBuildLabel = 'macOS Native Binary';
        detectedBuildDetail = 'Runs natively on macOS';
      }
    }

    const effectiveLaunchMethod: LaunchMethod =
      draftConfig?.launchMethod || savedConfig?.launchMethod || 'auto';
    const effectiveCompatLayer: CompatibilityLayerType =
      sanitizeLegacyCompatLayer(draftConfig?.compatibilityLayer) ||
      sanitizeLegacyCompatLayer(savedConfig?.compatibilityLayer) ||
      layers[0]?.type ||
      'crossover';
    const hasExplicitBottleOrCompatConfig = Boolean(
      draftConfig?.wineBottleName ||
        draftConfig?.winePrefixPath ||
        savedConfig?.wineBottleName ||
        savedConfig?.winePrefixPath ||
        (savedConfig?.crossoverGraphicsBackend &&
          savedConfig.crossoverGraphicsBackend !== 'auto')
    );

    let availableModes: LaunchMethod[];
    let visibleSections: ResolvedLaunchModePreview['visibleSections'];

    if (hostPlatform === 'win32') {
      availableModes = ['auto', 'direct', 'storefront_uri'];
      visibleSections = {
        compatibilityLayer: false,
        crossoverRendering: false,
        nativeMacMetalHud: false,
        executableAndArgs: true,
        environmentAndHooks: true,
      };
    } else if (
      detectedBuildType === 'mac_native_app' ||
      detectedBuildType === 'mac_native_bin'
    ) {
      availableModes = ['auto', 'direct', 'storefront_uri'];
      visibleSections = {
        compatibilityLayer: false,
        crossoverRendering: false,
        nativeMacMetalHud: true,
        executableAndArgs: true,
        environmentAndHooks: true,
      };
    } else if (detectedBuildType === 'windows_exe_on_mac') {
      availableModes = ['auto', 'compatibility_layer'];
      visibleSections = {
        compatibilityLayer: true,
        crossoverRendering:
          effectiveCompatLayer === 'crossover' ||
          effectiveCompatLayer === 'crossover_preview',
        nativeMacMetalHud: false,
        executableAndArgs: true,
        environmentAndHooks: true,
      };
    } else {
      const showCompatForUninstalled =
        effectiveLaunchMethod === 'compatibility_layer' ||
        hasExplicitBottleOrCompatConfig;
      availableModes =
        effectiveLaunchMethod === 'direct'
          ? ['auto', 'direct', 'compatibility_layer', 'storefront_uri']
          : ['auto', 'compatibility_layer', 'storefront_uri'];
      visibleSections = {
        compatibilityLayer: showCompatForUninstalled,
        crossoverRendering:
          showCompatForUninstalled &&
          (effectiveCompatLayer === 'crossover' ||
            effectiveCompatLayer === 'crossover_preview'),
        nativeMacMetalHud: false,
        executableAndArgs: true,
        environmentAndHooks: true,
      };
    }

    if (detectedBuildType === 'windows_exe_on_mac') {
      const bottleSuffix = bottleName ? ` (Bottle: "${bottleName}")` : '';
      return {
        isInstalled,
        hostPlatform,
        platformId,
        installPath,
        executablePath,
        detectedBuildType,
        detectedBuildLabel,
        detectedBuildDetail,
        autoResolvedMethod: 'compatibility_layer',
        autoResolvedSummary: `Launches Windows executable (.exe) via ${layerName}${bottleSuffix}.`,
        recommendedModes: ['auto', 'compatibility_layer'],
        availableModes,
        visibleSections,
        modeNotes: {
          auto: {
            badge: 'Recommended',
            badgeTone: 'emerald',
            dynamicDesc: `Automatically runs this Windows (.exe) build through ${layerName}${bottleSuffix} with your configured graphics and bottle settings.`,
          },
          compatibility_layer: {
            badge: 'Custom Runner & Bottle',
            badgeTone: 'sky',
            dynamicDesc: `Explicitly pin a specific compatibility runner (${layerName}), target bottle / WinePrefix, and per-game graphics overrides.`,
          },
          direct: {
            badge: 'Requires Translation',
            badgeTone: 'amber',
            dynamicDesc: `Targets ${executablePath ? executablePath.split(/[\\/]/).pop() : 'the game executable'} directly.`,
            warning: `macOS cannot execute Windows .exe binaries natively without Wine/CrossOver, so One Launcher will automatically invoke ${layerName} if selected.`,
          },
          storefront_uri: {
            badge: 'Caution on macOS',
            badgeTone: 'amber',
            dynamicDesc: `Delegates launch to ${storeName} (${storeProtocol}).`,
            warning: `Native macOS storefront clients (such as macOS Steam) cannot launch Windows-only .exe builds directly. Use Auto-Detect or Compatibility Layer instead.`,
          },
        },
      };
    }

    if (
      detectedBuildType === 'mac_native_app' ||
      detectedBuildType === 'mac_native_bin'
    ) {
      const targetName =
        executablePath
          ?.split(/[\\/]/)
          .find((part) => /\.app$/i.test(part)) ||
        executablePath?.split(/[\\/]/).pop() ||
        'native macOS binary';

      return {
        isInstalled,
        hostPlatform,
        platformId,
        installPath,
        executablePath,
        detectedBuildType,
        detectedBuildLabel,
        detectedBuildDetail,
        autoResolvedMethod: 'direct',
        autoResolvedSummary:
          detectedBuildType === 'mac_native_app'
            ? `Launches native macOS app bundle (${targetName}) directly via macOS LaunchServices (open -a).`
            : `Launches native macOS binary (${targetName}) directly without translation layers.`,
        recommendedModes: ['auto', 'direct', 'storefront_uri'],
        availableModes,
        visibleSections,
        modeNotes: {
          auto: {
            badge: 'Recommended',
            badgeTone: 'emerald',
            dynamicDesc: `Automatically launches this native macOS build (${targetName}) directly with zero translation overhead.`,
          },
          direct: {
            badge: 'Native macOS',
            badgeTone: 'emerald',
            dynamicDesc: `Spawns the local macOS ${detectedBuildType === 'mac_native_app' ? '.app bundle' : 'binary'} directly without opening ${storeName}.`,
          },
          compatibility_layer: {
            badge: 'Not Needed',
            badgeTone: 'amber',
            dynamicDesc: `Routes execution through Wine / CrossOver translation.`,
            warning: `This is already a native macOS build and does not need Wine/CrossOver translation unless you explicitly override the executable to a Windows .exe.`,
          },
          storefront_uri: {
            badge: 'Store Client',
            badgeTone: 'sky',
            dynamicDesc: `Launches via the ${storeName} desktop client (${storeProtocol}).`,
          },
        },
      };
    }

    if (detectedBuildType === 'windows_native') {
      const exeName = executablePath?.split(/[\\/]/).pop();
      const autoMethod: LaunchMethod = executablePath
        ? 'direct'
        : 'storefront_uri';
      return {
        isInstalled,
        hostPlatform,
        platformId,
        installPath,
        executablePath,
        detectedBuildType,
        detectedBuildLabel,
        detectedBuildDetail,
        autoResolvedMethod: autoMethod,
        autoResolvedSummary: executablePath
          ? `Launches native Windows executable (${exeName}) directly.`
          : `Launches via ${storeName} client protocol (${storeProtocol}).`,
        recommendedModes: ['auto', 'direct', 'storefront_uri'],
        availableModes,
        visibleSections,
        modeNotes: {
          auto: {
            badge: 'Recommended',
            badgeTone: 'emerald',
            dynamicDesc: executablePath
              ? `Automatically spawns the native Windows executable (${exeName}) directly.`
              : `Automatically launches via ${storeName} (${storeProtocol}).`,
          },
          direct: {
            badge: 'Native Windows',
            badgeTone: 'emerald',
            dynamicDesc: `Directly spawns the Windows .exe binary with custom launch arguments and environment variables.`,
          },
          compatibility_layer: {
            badge: 'Not Needed',
            badgeTone: 'slate',
            dynamicDesc: `Wine / CrossOver translation layer for non-Windows hosts.`,
            warning: `Compatibility layers are not required on native Windows hosts.`,
          },
          storefront_uri: {
            badge: 'Supported',
            badgeTone: 'sky',
            dynamicDesc: `Delegates launch to the ${storeName} desktop client (${storeProtocol}).`,
          },
        },
      };
    }

    // not_installed
    return {
      isInstalled: false,
      hostPlatform,
      platformId,
      installPath,
      executablePath,
      detectedBuildType: 'not_installed',
      detectedBuildLabel,
      detectedBuildDetail,
      autoResolvedMethod: 'storefront_uri',
      autoResolvedSummary:
        'Game is not installed locally yet. Install via One Launcher or link an existing executable below.',
      recommendedModes: ['auto', 'storefront_uri'],
      availableModes,
      visibleSections,
      modeNotes: {
        auto: {
          badge: 'Recommended',
          badgeTone: 'emerald',
          dynamicDesc:
            'Automatically selects the optimal native or CrossOver pipeline once installed or linked.',
        },
        direct: {
          badge: 'Requires Executable',
          badgeTone: 'amber',
          dynamicDesc: 'Spawns a local game binary directly.',
          warning:
            'No local installation detected yet. Link a custom executable path below to use Direct Executable mode.',
        },
        compatibility_layer: {
          badge: 'Pre-Configure',
          badgeTone: 'sky',
          dynamicDesc: `Pre-configure ${layerName} bottle, CrossOver 26 graphics backend, and HUD settings before installing or linking a Windows .exe.`,
        },
        storefront_uri: {
          badge: 'Store Fallback',
          badgeTone: 'sky',
          dynamicDesc: `Opens ${storeName} (${storeProtocol}) to install or launch the game.`,
        },
      },
    };
  }

  public openDownloadDrawer(): void {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('antigravity:open-download-drawer'));
    }
  }
}

export const launcherService = new LauncherService();
