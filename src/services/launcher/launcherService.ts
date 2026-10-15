import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  GameLaunchConfig,
  InstalledGameRecord,
  InstallGameRequest,
  LauncherActionResult,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';

const LAUNCH_CONFIGS_STORAGE_KEY = 'one_launcher_game_configs_v1';

export class LauncherService {
  private installedRecords: InstalledGameRecord[] = [];
  private activeSessions: Map<string, ActiveGameSession> = new Map();
  private downloadQueue: DownloadTaskState[] = [];
  private launchConfigs: Record<string, GameLaunchConfig> = {};
  private compatibilityLayers: CompatibilityLayerInfo[] = [];
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

  private loadLocalConfigs(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(LAUNCH_CONFIGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.launchConfigs = parsed;
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
          this.launchConfigs = { ...this.launchConfigs, ...configs };
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

  public getInstalledRecords(): InstalledGameRecord[] {
    return this.installedRecords;
  }

  public getInstalledRecordForGame(
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ): InstalledGameRecord | undefined {
    if (!game) return undefined;

    const cfg = this.getLaunchConfig(game.id);
    const targetPlatformId = preferredPlatformId || cfg?.preferredPlatformId;

    // 1. Check matching platform records in installedRecords
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
          installSize: p.installSize,
          version: p.version,
          isWindowsBinaryOnMac: this.isWindowsHost() ? false : p.isWindowsBinaryOnMac,
        };
      }
      return undefined;
    };

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

    // 3. Fallback check by customExecutablePath in LaunchConfig
    if (cfg?.customExecutablePath) {
      return {
        platformId: targetPlatformId || game.platforms[0]?.platformId || 'custom',
        platformGameId: game.platforms[0]?.platformGameId || game.id,
        title: game.title,
        installPath: cfg.workingDirectory || cfg.customExecutablePath,
        executablePath: cfg.customExecutablePath,
        runner: 'custom',
      };
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
      if (found) return found;
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
    const cfg = this.getLaunchConfig(game.id);
    if (cfg?.customExecutablePath) return true;

    if (platformId) {
      const plat = game.platforms.find((p) => p.platformId === platformId);
      if (plat?.installed) return true;
      const rec = this.getInstalledRecordForGame(game, platformId);
      return Boolean(rec && rec.platformId === platformId);
    }

    if (game.platforms.some((p) => p.installed)) return true;
    return Boolean(this.getInstalledRecordForGame(game));
  }

  public isGameRunning(gameId: string): boolean {
    return this.activeSessions.has(gameId);
  }

  public getActiveSession(gameId: string): ActiveGameSession | undefined {
    return this.activeSessions.get(gameId);
  }

  public getRunningGames(): ActiveGameSession[] {
    return Array.from(this.activeSessions.values());
  }

  public getActiveDownload(gameId: string): DownloadTaskState | undefined {
    return this.downloadQueue.find(
      (t) =>
        t.gameId === gameId &&
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
        const res = await window.electronAPI.getGameInstallInfo({
          gameId: game.id,
          title: game.title,
          platformId: resolvedPlatformId,
          platformGameId: resolvedPlatformGameId,
          steamAppId: game.steamAppId,
          targetInstallDir,
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

    const launchConfig = this.getLaunchConfig(game.id);
    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const installedRecord = this.getInstalledRecordForGame(game, effPlatform?.platformId);

    const resolvedPlatformId: StorefrontId =
      platformId ||
      launchConfig?.preferredPlatformId ||
      installedRecord?.platformId ||
      effPlatform?.platformId ||
      (game.steamAppId ? 'steam' : 'custom');

    const resolvedPlatformGameId =
      installedRecord?.platformGameId ||
      effPlatform?.platformGameId ||
      (game.steamAppId ? String(game.steamAppId) : game.id);

    const installPath = installedRecord?.installPath || effPlatform?.installPath;
    const executablePath =
      launchConfig?.customExecutablePath ||
      installedRecord?.executablePath ||
      effPlatform?.executablePath;
    const isWindowsBinaryOnMac =
      installedRecord?.isWindowsBinaryOnMac ?? effPlatform?.isWindowsBinaryOnMac;

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
    if (typeof window !== 'undefined' && window.electronAPI?.installGame) {
      try {
        const res = await window.electronAPI.installGame(request);
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
      totalBytes: 250 * 1024 * 1024,
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
      const activeTask = this.getActiveDownload(game.id);
      if (activeTask) {
        if (typeof window !== 'undefined' && window.electronAPI?.cancelDownload) {
          window.electronAPI.cancelDownload(activeTask.taskId).catch(() => {});
        }
        this.downloadQueue = this.downloadQueue.map((t) =>
          t.gameId === game.id &&
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
    const rec = this.getInstalledRecordForGame(game, effPlatform?.platformId);
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
    const cfg = this.getLaunchConfig(game.id);
    const effPlatform = this.getEffectivePlatformForGame(game, platformId);
    const rec = this.getInstalledRecordForGame(game, effPlatform?.platformId);
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

    const existingCfg = this.getLaunchConfig(game.id) || {
      gameId: game.id,
      launchMethod: 'direct',
    };

    const updatedCfg: GameLaunchConfig = {
      ...existingCfg,
      gameId: game.id,
      preferredPlatformId: platformId || existingCfg.preferredPlatformId || game.platforms[0]?.platformId,
      launchMethod: 'direct',
      customExecutablePath: selectedExe,
    };

    await this.saveLaunchConfig(updatedCfg);

    const resolvedPlatformId: StorefrontId =
      updatedCfg.preferredPlatformId || game.platforms[0]?.platformId || 'custom';
    const resolvedPlatformGameId =
      game.platforms.find((p) => p.platformId === resolvedPlatformId)?.platformGameId || game.id;

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:game-installed', {
          detail: {
            gameId: game.id,
            platformId: resolvedPlatformId,
            platformGameId: resolvedPlatformGameId,
            installPath: selectedExe,
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

  public async saveLaunchConfig(config: GameLaunchConfig): Promise<void> {
    if (!config || !config.gameId) return;
    this.launchConfigs[config.gameId] = {
      ...this.launchConfigs[config.gameId],
      ...config,
    };
    this.persistLocalConfigs();

    if (typeof window !== 'undefined' && window.electronAPI?.saveGameLaunchConfig) {
      try {
        await window.electronAPI.saveGameLaunchConfig(this.launchConfigs[config.gameId]);
      } catch (err) {
        console.warn('[LauncherService] Failed to save launch config via IPC:', err);
      }
    }

    this.notifyStateChanged();
  }

  public getLaunchConfig(gameId: string): GameLaunchConfig | undefined {
    return this.launchConfigs[gameId];
  }

  public getAllLaunchConfigs(): Record<string, GameLaunchConfig> {
    return { ...this.launchConfigs };
  }

  public openDownloadDrawer(): void {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('antigravity:open-download-drawer'));
    }
  }
}

export const launcherService = new LauncherService();
