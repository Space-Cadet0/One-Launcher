import type { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import type { HostPlatform } from '../../../contracts/hostPlatform';
import type {
  DiskSpaceInfo,
  DownloadTaskState,
  GameInstallInfo,
  InstalledGameRecord,
  InstallGameRequest,
  LauncherActionResult,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';
import {
  getStorefrontNativeOsFlags,
  saveCachedGogOsSupport,
} from '../../platform/nativeOsService';
import { steamApi } from '../../steam/steamApi';
import {
  buildGameInstalledEventDetailFromRecord,
  dispatchGameInstalledEvent,
  getLauncherErrorMessage,
  isBottleFilesystemPath,
  isWindowsExecutablePath,
  sanitizeGameInstallInfo,
} from './launcherEventHelpers';

export const MAX_INSTALL_INFO_CACHE_SIZE = 150;

export interface DownloadQueueManagerContext {
  getHostPlatform: () => HostPlatform;
  isWindowsHost: () => boolean;
  isInGameHibernating: () => boolean;
  getEffectivePlatformForGame: (
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ) => GamePlatformOwnership | undefined;
  getDiskSpace: (targetPath?: string) => Promise<DiskSpaceInfo | null>;
  upsertInstalledRecord: (
    record: InstalledGameRecord,
    matchHint?: {
      rawPlatformGameId?: string;
      packageFamilyName?: string;
      normalizedSteamAppId?: number;
    }
  ) => void;
  scanAllInstalledGames: (forceRefresh?: boolean) => Promise<InstalledGameRecord[]>;
  openDownloadDrawer: () => void;
  notifyStateChanged: () => void;
}

type ExtendedDownloadTask = DownloadTaskState & {
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

export class DownloadQueueManager {
  private downloadQueue: DownloadTaskState[] = [];
  private installInfoCache: Map<string, GameInstallInfo> = new Map();
  private activeDownloadPollTimer: ReturnType<typeof setInterval> | null = null;

  public getQueue(): DownloadTaskState[] {
    return this.downloadQueue;
  }

  public setQueue(queue: DownloadTaskState[]): void {
    this.downloadQueue = queue;
  }

  public getActiveDownload(
    gameId: string,
    platformId?: StorefrontId
  ): DownloadTaskState | undefined {
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

  public hasActiveDownloads(): boolean {
    return this.downloadQueue.some(
      (t) =>
        t.status === 'downloading' ||
        t.status === 'queued' ||
        t.status === 'extracting' ||
        t.status === 'verifying'
    );
  }

  public stopDownloadPolling(): void {
    if (this.activeDownloadPollTimer) {
      clearInterval(this.activeDownloadPollTimer);
      this.activeDownloadPollTimer = null;
    }
  }

  public ensureActiveDownloadPolling(ctx: DownloadQueueManagerContext): void {
    if (ctx.isInGameHibernating() || !this.hasActiveDownloads()) {
      this.stopDownloadPolling();
      return;
    }

    if (this.activeDownloadPollTimer || typeof window === 'undefined' || !window.electronAPI) {
      return;
    }

    const timer = setInterval(async () => {
      if (ctx.isInGameHibernating() || !this.hasActiveDownloads()) {
        this.stopDownloadPolling();
        return;
      }

      try {
        if (window.electronAPI?.getDownloadQueue) {
          const latestQueue = await window.electronAPI.getDownloadQueue();
          if (Array.isArray(latestQueue) && latestQueue.length > 0) {
            this.handleDownloadUpdated({ queue: latestQueue }, ctx);
          }
        }
      } catch {}
    }, 3500);

    if (
      timer &&
      typeof timer === 'object' &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref();
    }
    this.activeDownloadPollTimer = timer;
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

  public handleDownloadUpdated(
    data: { task?: DownloadTaskState; queue?: DownloadTaskState[] },
    ctx: DownloadQueueManagerContext
  ): void {
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
        !ctx.isWindowsHost() &&
        (Boolean(task.isWindowsBinaryOnMac) ||
          isWindowsExecutablePath(task.executablePath) ||
          isBottleFilesystemPath(task.executablePath || installPath));
      const normalizedSteamAppId =
        task.platformId === 'steam'
          ? Number(task.steamAppId || String(task.platformGameId || '').replace(/^steam-/i, '')) ||
            undefined
          : undefined;
      const normalizedPlatformGameId =
        task.platformId === 'steam' && normalizedSteamAppId
          ? String(normalizedSteamAppId)
          : task.platformGameId;

      const taskExt = task as ExtendedDownloadTask;
      const taskXboxProductId = taskExt.xboxProductId || taskExt.installRequest?.xboxProductId;
      const taskPackageFamilyName =
        taskExt.packageFamilyName || taskExt.installRequest?.packageFamilyName;
      const taskAppUserModelId = taskExt.appUserModelId || taskExt.installRequest?.appUserModelId;
      const taskXboxTitleId = taskExt.xboxTitleId || taskExt.installRequest?.xboxTitleId;
      const taskScid = taskExt.scid || taskExt.installRequest?.scid;
      const taskMsaAppId = taskExt.msaAppId || taskExt.installRequest?.msaAppId;
      const taskVersion = taskExt.version;

      const sanitizedTaskSize = sanitizeGameInstallSizeBytes(task.totalBytes);
      const newRecord: InstalledGameRecord = {
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

      ctx.upsertInstalledRecord(newRecord, {
        rawPlatformGameId: task.platformGameId,
        packageFamilyName: taskPackageFamilyName,
        normalizedSteamAppId,
      });

      if (task.platformId === 'steam' || task.platformId === 'xbox') {
        shouldRescanInstalled = true;
      }

      dispatchGameInstalledEvent(
        buildGameInstalledEventDetailFromRecord(task.gameId, newRecord, true, {
          platformId: task.platformId,
          platformGameId: task.platformGameId,
          steamAppId: normalizedSteamAppId,
        })
      );
    }

    if (
      shouldRescanInstalled &&
      typeof window !== 'undefined' &&
      window.electronAPI?.scanAllInstalledGames
    ) {
      void ctx.scanAllInstalledGames(true).catch(() => {});
    }

    this.ensureActiveDownloadPolling(ctx);
    ctx.notifyStateChanged();
  }

  public reconcileActiveDownloadsWithInstalledRecords(
    installedRecords: InstalledGameRecord[]
  ): void {
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

      const matchedRecord = installedRecords.find(
        (r) =>
          r.platformId === task.platformId &&
          (String(r.platformGameId) === String(task.platformGameId) ||
            Boolean(
              task.steamAppId &&
                Number(r.appId || r.platformGameId) === Number(task.steamAppId)
            ))
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

        dispatchGameInstalledEvent(
          buildGameInstalledEventDetailFromRecord(task.gameId, matchedRecord, true, {
            platformId: task.platformId,
            platformGameId: task.platformGameId,
          })
        );
      }
    }
  }

  public setCachedInstallInfoEntry(key: string, info: GameInstallInfo): void {
    if (!key) return;
    const sanitized = sanitizeGameInstallInfo(info);
    if (this.installInfoCache.has(key)) {
      this.installInfoCache.delete(key);
    }
    while (this.installInfoCache.size >= MAX_INSTALL_INFO_CACHE_SIZE) {
      const oldestKey = this.installInfoCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.installInfoCache.delete(oldestKey);
    }
    this.installInfoCache.set(key, sanitized);
  }

  public deleteCachedInstallInfoEntry(key: string): void {
    this.installInfoCache.delete(key);
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

  public async getDiskSpace(
    targetPath: string | undefined,
    isWindowsHost: boolean
  ): Promise<DiskSpaceInfo | null> {
    if (typeof window !== 'undefined' && window.electronAPI?.getDiskSpace) {
      try {
        return await window.electronAPI.getDiskSpace(targetPath);
      } catch {}
    }
    return {
      targetPath: targetPath || (isWindowsHost ? 'C:\\Games\\OneLauncher' : '~/Games/OneLauncher'),
      freeBytes: 120 * 1024 * 1024 * 1024,
      totalBytes: 500 * 1024 * 1024 * 1024,
      usedBytes: 380 * 1024 * 1024 * 1024,
    };
  }

  public async getGameInstallInfo(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    targetInstallDir: string | undefined,
    ctx: DownloadQueueManagerContext
  ): Promise<GameInstallInfo> {
    const hostPlatform = ctx.getHostPlatform();
    const isWin = hostPlatform === 'win32';
    const effPlatform = ctx.getEffectivePlatformForGame(game, platformId);
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
          externalStorefrontHandoff: effPlatform?.externalStorefrontHandoff,
          xboxBottleCompatibilityTier: effPlatform?.xboxBottleCompatibilityTier,
          isCrossPlatformLauncherRuntime: effPlatform?.isCrossPlatformLauncherRuntime,
          chainedLauncherHandoff: effPlatform?.chainedLauncherHandoff,
          chainedExternalInstallId: effPlatform?.chainedExternalInstallId,
          targetInstallDir,
          steamPlatforms,
          storePlatforms: {
            windows: storeFlags.windows,
            mac: storeFlags.mac,
          },
        });
        const resHostPlatform = res.hostPlatform || hostPlatform;
        const canUpdateStoreOsFromInstallers =
          resolvedPlatformId !== 'xbox' &&
          resolvedPlatformId !== 'ubisoft' &&
          resolvedPlatformId !== 'ea' &&
          resolvedPlatformId !== 'rockstar' &&
          (resolvedPlatformId as string) !== 'riot' &&
          (resolvedPlatformId === 'steam'
            ? res.authoritativeOsSupport === true
            : res.authoritativeOsSupport !== false);

        if (
          canUpdateStoreOsFromInstallers &&
          resHostPlatform !== 'win32' &&
          resolvedPlatformId === 'gog' &&
          Array.isArray(res.availableInstallers) &&
          res.availableInstallers.length > 0 &&
          !res.availableInstallers.every((i) => i.authoritativeOsSupport === false)
        ) {
          const hasMac = res.availableInstallers.some((i) => i.os === 'mac');
          const hasWin = res.availableInstallers.some((i) => i.os === 'windows');
          if (hasWin || hasMac) {
            saveCachedGogOsSupport(resolvedPlatformGameId, game.title, {
              windows: hasWin,
              mac: hasMac,
            });
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
    const diskSpace = (await ctx.getDiskSpace(targetInstallDir || defaultInstallDir)) || undefined;

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

  public async startInstall(
    request: InstallGameRequest,
    ctx: DownloadQueueManagerContext
  ): Promise<LauncherActionResult> {
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
          this.ensureActiveDownloadPolling(ctx);
          ctx.notifyStateChanged();
          ctx.openDownloadDrawer();
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, 'Failed to start installation.'),
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
    this.ensureActiveDownloadPolling(ctx);
    ctx.notifyStateChanged();
    ctx.openDownloadDrawer();

    return {
      success: true,
      message: `Started installation for ${request.title}`,
      task,
    };
  }

  public async pauseDownload(
    taskId: string,
    ctx: DownloadQueueManagerContext
  ): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.pauseDownload) {
      try {
        const res = await window.electronAPI.pauseDownload(taskId);
        if (res.task) {
          this.handleDownloadUpdated({ task: res.task }, ctx);
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, 'Failed to pause download.'),
        };
      }
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
    this.ensureActiveDownloadPolling(ctx);
    ctx.notifyStateChanged();
    return { success: true, task: updated };
  }

  public async resumeDownload(
    taskId: string,
    ctx: DownloadQueueManagerContext
  ): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.resumeDownload) {
      try {
        const res = await window.electronAPI.resumeDownload(taskId);
        if (res.task) {
          this.handleDownloadUpdated({ task: res.task }, ctx);
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, 'Failed to resume download.'),
        };
      }
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
    this.ensureActiveDownloadPolling(ctx);
    ctx.notifyStateChanged();
    return { success: true, task: updated };
  }

  public async cancelDownload(
    taskId: string,
    ctx: DownloadQueueManagerContext
  ): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.cancelDownload) {
      try {
        const res = await window.electronAPI.cancelDownload(taskId);
        if (res.task) {
          this.handleDownloadUpdated({ task: res.task }, ctx);
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, 'Failed to cancel download.'),
        };
      }
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
    this.ensureActiveDownloadPolling(ctx);
    ctx.notifyStateChanged();
    return { success: true, task: updated };
  }

  public clearCompletedDownloads(ctx: DownloadQueueManagerContext): void {
    this.downloadQueue = this.downloadQueue.filter(
      (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed'
    );
    this.ensureActiveDownloadPolling(ctx);
    ctx.notifyStateChanged();
  }
}
