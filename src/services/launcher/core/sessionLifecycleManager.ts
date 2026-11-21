import type { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import {
  sanitizeGlobalBottleDisplayScalingMode,
  sanitizeGlobalDisplayAspectRatio,
} from '../../../contracts/launchConfigSanitizers';
import type {
  ActiveGameSession,
  CloudSaveSyncTelemetry,
  GameLaunchConfig,
  GlobalDisplayAspectRatioMode,
  HibernateStatePayload,
  InstalledGameRecord,
  LauncherActionResult,
  LauncherPerformanceSettings,
  LaunchMethod,
  ResolvedLaunchModePreview,
  SessionUpdatedEventType,
  SessionUpdatedPayload,
  ToggleSessionFullscreenResult,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import {
  dispatchCloudSyncTelemetryEvent,
  dispatchGameInstalledEvent,
  dispatchGameLaunchErrorEvent,
  dispatchGameSessionEndedEvent,
  dispatchHibernateStateChangedEvent,
  getLauncherErrorMessage,
  isWindowsExecutablePath,
} from './launcherEventHelpers';

export interface DrainedSessionItem {
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
}

export interface SessionLifecycleManagerContext {
  isWindowsHost: () => boolean;
  getPerformanceSettings: () => LauncherPerformanceSettings;
  getLaunchConfig: (gameId: string, platformId?: StorefrontId) => GameLaunchConfig | undefined;
  saveLaunchConfig: (config: GameLaunchConfig, platformId?: StorefrontId) => Promise<void>;
  getEffectivePlatformForGame: (
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ) => GamePlatformOwnership | undefined;
  getInstalledRecordForGame: (
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId
  ) => InstalledGameRecord | undefined;
  getInstalledStorefrontClients: () => Partial<Record<StorefrontId, boolean>>;
  resolveEffectiveLaunchModePreview: (
    game: CanonicalGame,
    preferredPlatformId?: StorefrontId,
    draftConfig?: Partial<GameLaunchConfig>
  ) => ResolvedLaunchModePreview;
  deleteCachedInstallInfoEntry: (key: string) => void;
  removeInstalledRecords: (predicate: (rec: InstalledGameRecord) => boolean) => void;
  selectExecutable: (defaultPath?: string) => Promise<string | null>;
  stopDownloadPolling: () => void;
  ensureActiveDownloadPolling: () => void;
  syncInGameResourceThrottle: () => void;
  notifyStateChanged: () => void;
}

export class SessionLifecycleManager {
  private activeSessions: Map<string, ActiveGameSession> = new Map();
  private inGameHibernating = false;
  private inFlightLaunchesByGameId: Map<string, Promise<LauncherActionResult>> = new Map();

  public getActiveSessionsMap(): Map<string, ActiveGameSession> {
    return this.activeSessions;
  }

  public isGameRunning(gameId: string, platformId?: StorefrontId): boolean {
    const session = this.activeSessions.get(gameId);
    if (!session) return false;
    return !platformId || !session.platformId || session.platformId === platformId;
  }

  public getActiveSession(
    gameId: string,
    platformId?: StorefrontId
  ): ActiveGameSession | undefined {
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

  public isInGameHibernating(): boolean {
    return this.inGameHibernating;
  }

  public setInGameHibernatingRaw(val: boolean): void {
    this.inGameHibernating = val;
  }

  public clearHibernatingFlag(): boolean {
    const wasHibernating = this.inGameHibernating;
    this.inGameHibernating = false;
    return wasHibernating;
  }

  public applyHibernationState(
    hibernating: boolean,
    ctx: SessionLifecycleManagerContext,
    extraDetail?: Partial<HibernateStatePayload>
  ): void {
    const next = Boolean(hibernating);
    const transitionedToTrue = !this.inGameHibernating && next;
    const transitionedToFalse = this.inGameHibernating && !next;
    this.inGameHibernating = next;

    if (this.inGameHibernating) {
      ctx.stopDownloadPolling();
      if (transitionedToTrue) {
        window.electronAPI?.clearRendererImageCache?.()?.catch?.(() => {});
      }
    } else if (transitionedToFalse) {
      ctx.ensureActiveDownloadPolling();
    }

    ctx.notifyStateChanged();
    dispatchHibernateStateChangedEvent(this.inGameHibernating, extraDetail);
  }

  public resetSessionState(): void {
    this.inFlightLaunchesByGameId.clear();
    this.activeSessions.clear();
  }

  public replaceActiveSessions(running: ActiveGameSession[]): void {
    this.activeSessions.clear();
    for (const s of running) {
      if (s && s.gameId) {
        this.activeSessions.set(s.gameId, s);
      }
    }
  }

  public processDrainedPendingSessions(
    pendingSessions: unknown,
    ctx: SessionLifecycleManagerContext
  ): void {
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
        this.handleSessionUpdated(
          {
            session: sessionObj,
            event: item.event || 'stopped',
            sessionMinutesPlayed: item.sessionMinutesPlayed ?? 1,
            durationSeconds: item.durationSeconds ?? 60,
            lastPlayed: item.lastPlayed || item.endedAt || new Date().toISOString(),
            storefrontTotalPlaytimeMinutes: item.storefrontTotalPlaytimeMinutes,
            cloudSync: item.cloudSync,
            statusMessage: item.statusMessage,
            error: item.error,
          },
          ctx
        );
      }
    }
  }

  public handleSessionUpdated(
    data: SessionUpdatedPayload,
    ctx: SessionLifecycleManagerContext
  ): void {
    const session = data?.session;
    const isLifecycleEvent =
      data?.event === 'started' ||
      data?.event === 'stopping' ||
      data?.event === 'stopped' ||
      data?.event === 'fullscreen_updated' ||
      data?.event === 'playtime_synced';

    if (data?.event === 'fullscreen_updated') {
      const rawGameId: unknown = Reflect.get(data, 'gameId');
      const rawFullscreenActive: unknown = Reflect.get(data, 'fullscreenActive');
      const rawDisplayAspectRatio: unknown = Reflect.get(data, 'displayAspectRatio');
      const rawDisplayScalingMode: unknown = Reflect.get(data, 'displayScalingMode');
      const targetGameId =
        session?.gameId || (typeof rawGameId === 'string' ? rawGameId : undefined);
      if (targetGameId) {
        const existingSession = this.activeSessions.get(targetGameId);
        if (existingSession || session) {
          const mergedSession: ActiveGameSession = {
            ...(existingSession || session!),
            ...(session || {}),
            ...(typeof rawFullscreenActive === 'boolean'
              ? { fullscreenActive: rawFullscreenActive }
              : {}),
            ...(typeof rawDisplayAspectRatio === 'string'
              ? {
                  displayAspectRatio: sanitizeGlobalDisplayAspectRatio(rawDisplayAspectRatio),
                }
              : {}),
            ...(typeof rawDisplayScalingMode === 'string'
              ? {
                  displayScalingMode:
                    sanitizeGlobalBottleDisplayScalingMode(rawDisplayScalingMode),
                }
              : {}),
          };
          this.activeSessions.set(targetGameId, mergedSession);
        }
      }
      ctx.notifyStateChanged();
      return;
    }

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
      dispatchCloudSyncTelemetryEvent(cloudSyncDetail || session || data);
      ctx.notifyStateChanged();
      return;
    }

    if (!session || !session.gameId) {
      if (data?.event === 'stopped') {
        const rawGameId: unknown = Reflect.get(data, 'gameId');
        const fallbackGameId = typeof rawGameId === 'string' ? rawGameId.trim() : '';
        if (fallbackGameId) {
          this.activeSessions.delete(fallbackGameId);
          ctx.syncInGameResourceThrottle();
          ctx.notifyStateChanged();
        }
      }
      return;
    }

    if (data.event === 'playtime_synced') {
      if (
        typeof data.storefrontTotalPlaytimeMinutes === 'number' &&
        data.storefrontTotalPlaytimeMinutes > 0
      ) {
        dispatchGameSessionEndedEvent({
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
          sessionEvent: 'playtime_synced',
          gameId: session.gameId,
          platformId: session.platformId,
          platformGameId: session.platformGameId,
          sessionMinutesPlayed: 0,
          durationSeconds: data.durationSeconds ?? 0,
          lastPlayed: data.lastPlayed || new Date().toISOString(),
          storefrontTotalPlaytimeMinutes: data.storefrontTotalPlaytimeMinutes,
        });
      }
      ctx.notifyStateChanged();
      return;
    }

    if (data.event === 'stopped') {
      this.activeSessions.delete(session.gameId);
      if (data.cloudSync) {
        dispatchCloudSyncTelemetryEvent(data.cloudSync);
      }
      if (data.error) {
        dispatchGameLaunchErrorEvent({
          gameId: session.gameId,
          platformId: session.platformId,
          error: data.error,
        });
      }
      if ((data.sessionMinutesPlayed ?? 0) > 0 && !data.error) {
        dispatchGameSessionEndedEvent({
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
          sessionEvent: 'stopped',
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
        });
      }
    } else {
      this.activeSessions.set(session.gameId, session);
    }

    ctx.syncInGameResourceThrottle();
    ctx.notifyStateChanged();
  }

  public launchGame(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<LauncherActionResult> {
    if (!game) {
      return Promise.resolve({ success: false, error: 'No game specified to launch.' });
    }

    if (this.activeSessions.has(game.id)) {
      return Promise.resolve({
        success: true,
        message: `${game.title} is already running.`,
        session: this.activeSessions.get(game.id),
      });
    }

    const existingFlight = this.inFlightLaunchesByGameId.get(game.id);
    if (existingFlight) {
      return existingFlight;
    }

    const launchFlight = this.executeLaunchGameInternal(game, platformId, ctx).finally(() => {
      if (this.inFlightLaunchesByGameId.get(game.id) === launchFlight) {
        this.inFlightLaunchesByGameId.delete(game.id);
      }
    });
    this.inFlightLaunchesByGameId.set(game.id, launchFlight);
    return launchFlight;
  }

  private async executeLaunchGameInternal(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<LauncherActionResult> {
    const effPlatform = ctx.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId: StorefrontId =
      platformId ||
      effPlatform?.platformId ||
      ctx.getLaunchConfig(game.id)?.preferredPlatformId ||
      (game.steamAppId ? 'steam' : 'custom');

    const savedLaunchConfig = ctx.getLaunchConfig(game.id, resolvedPlatformId);
    const installedRecord = ctx.getInstalledRecordForGame(game, resolvedPlatformId);
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
    const xboxTitleId = installedRecord?.xboxTitleId || targetPlatformObj?.xboxTitleId;
    const scid = installedRecord?.scid || targetPlatformObj?.scid;
    const msaAppId = installedRecord?.msaAppId || targetPlatformObj?.msaAppId;

    const preview = ctx.resolveEffectiveLaunchModePreview(
      game,
      resolvedPlatformId,
      savedLaunchConfig
    );
    const isNativeInstalledBuild =
      preview.detectedBuildType === 'mac_native_app' ||
      preview.detectedBuildType === 'mac_native_bin' ||
      preview.detectedBuildType === 'windows_native';

    const installedClients = ctx.getInstalledStorefrontClients();
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
        installedClients[resolvedPlatformId] === false
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
          ...(installedRecord?.isCrossPlatformLauncherRuntime !== undefined ||
          targetPlatformObj?.isCrossPlatformLauncherRuntime !== undefined
            ? {
                isCrossPlatformLauncherRuntime:
                  installedRecord?.isCrossPlatformLauncherRuntime ??
                  targetPlatformObj?.isCrossPlatformLauncherRuntime,
              }
            : {}),
          ...(installedRecord?.externalStorefrontHandoff ||
          targetPlatformObj?.externalStorefrontHandoff
            ? {
                externalStorefrontHandoff:
                  installedRecord?.externalStorefrontHandoff ||
                  targetPlatformObj?.externalStorefrontHandoff,
              }
            : {}),
          ...(installedRecord?.chainedLauncherHandoff ||
          targetPlatformObj?.chainedLauncherHandoff
            ? {
                chainedLauncherHandoff:
                  installedRecord?.chainedLauncherHandoff ||
                  targetPlatformObj?.chainedLauncherHandoff,
              }
            : {}),
          ...(installedRecord?.chainedExternalInstallId ||
          targetPlatformObj?.chainedExternalInstallId
            ? {
                chainedExternalInstallId:
                  installedRecord?.chainedExternalInstallId ||
                  targetPlatformObj?.chainedExternalInstallId,
              }
            : {}),
          launchConfig,
          performanceSettings: ctx.getPerformanceSettings(),
        });

        if (res.success && res.session) {
          this.activeSessions.set(game.id, res.session);
          ctx.syncInGameResourceThrottle();
          ctx.notifyStateChanged();
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, 'Failed to launch game.'),
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
    ctx.syncInGameResourceThrottle();
    ctx.notifyStateChanged();

    return {
      success: true,
      message: `Launched ${game.title}`,
      session,
    };
  }

  public async stopGame(
    gameId: string,
    ctx: SessionLifecycleManagerContext
  ): Promise<LauncherActionResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.stopGame) {
      try {
        const session = this.activeSessions.get(gameId);
        const res = await window.electronAPI.stopGame({
          gameId,
          sessionId: session?.sessionId,
          pid: session?.pid,
        });
        this.activeSessions.delete(gameId);
        ctx.syncInGameResourceThrottle();
        ctx.notifyStateChanged();
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, 'Failed to stop game.'),
        };
      }
    }

    const existing = this.activeSessions.get(gameId);
    if (!existing) {
      return { success: false, error: 'Game is not currently running.' };
    }

    this.handleSessionUpdated(
      {
        session: existing,
        event: 'stopped',
        sessionMinutesPlayed: 1,
        durationSeconds: 60,
        lastPlayed: new Date().toISOString(),
      },
      ctx
    );

    return {
      success: true,
      message: `Stopped ${existing.title}`,
      sessionMinutesPlayed: 1,
    };
  }

  public async toggleSessionFullscreen(
    gameId: string,
    options: { fullscreen?: boolean; aspectRatio?: GlobalDisplayAspectRatioMode } | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<ToggleSessionFullscreenResult> {
    const active = this.activeSessions.get(gameId);

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.toggleSessionFullscreen === 'function'
    ) {
      try {
        const res = await window.electronAPI.toggleSessionFullscreen({
          gameId,
          sessionId: active?.sessionId,
          ...options,
        });
        const latestSession = this.activeSessions.get(gameId);
        if (latestSession && res && res.success !== false) {
          const nextFullscreen =
            typeof res.fullscreenActive === 'boolean'
              ? res.fullscreenActive
              : typeof options?.fullscreen === 'boolean'
                ? options.fullscreen
                : !latestSession.fullscreenActive;
          const nextAspect: GlobalDisplayAspectRatioMode | undefined = res.displayAspectRatio
            ? sanitizeGlobalDisplayAspectRatio(res.displayAspectRatio)
            : options?.aspectRatio
              ? sanitizeGlobalDisplayAspectRatio(options.aspectRatio)
              : latestSession.displayAspectRatio;
          this.activeSessions.set(gameId, {
            ...latestSession,
            fullscreenActive: nextFullscreen,
            ...(nextAspect ? { displayAspectRatio: nextAspect } : {}),
          });
          ctx.notifyStateChanged();
        }
        return res;
      } catch (err: unknown) {
        return {
          success: false,
          gameId,
          sessionId: active?.sessionId,
          error: getLauncherErrorMessage(err, 'Failed to toggle session fullscreen.'),
        };
      }
    }

    if (!active) {
      return {
        success: false,
        gameId,
        error: 'Game is not currently running.',
      };
    }

    const nextFullscreen =
      typeof options?.fullscreen === 'boolean' ? options.fullscreen : !active.fullscreenActive;
    const nextAspect: GlobalDisplayAspectRatioMode = options?.aspectRatio
      ? sanitizeGlobalDisplayAspectRatio(options.aspectRatio)
      : active.displayAspectRatio ??
        sanitizeGlobalDisplayAspectRatio(
          ctx.getPerformanceSettings().defaultDisplayAspectRatio
        );

    this.activeSessions.set(gameId, {
      ...active,
      fullscreenActive: nextFullscreen,
      displayAspectRatio: nextAspect,
    });
    ctx.notifyStateChanged();

    return {
      success: true,
      gameId,
      sessionId: active.sessionId,
      fullscreenActive: nextFullscreen,
      displayAspectRatio: nextAspect,
      message: nextFullscreen
        ? 'Switched bottled game to fullscreen.'
        : 'Switched bottled game to windowed mode.',
    };
  }

  public async uninstallGame(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<LauncherActionResult> {
    const effPlatform = ctx.getEffectivePlatformForGame(game, platformId);
    const rec = ctx.getInstalledRecordForGame(game, platformId || effPlatform?.platformId);
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
      try {
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
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, `Failed to uninstall ${game.title}.`),
        };
      }
    }

    if (res.success) {
      ctx.deleteCachedInstallInfoEntry(`${game.id}:${resolvedPlatformId}`);
      ctx.removeInstalledRecords(
        (r) =>
          r.platformId === resolvedPlatformId &&
          (String(r.platformGameId) === String(resolvedPlatformGameId) ||
            Boolean(xboxProductId && String(r.platformGameId) === String(xboxProductId)) ||
            Boolean(packageFamilyName && r.packageFamilyName === packageFamilyName))
      );

      const existingPlatCfg = ctx.getLaunchConfig(game.id, resolvedPlatformId);
      if (existingPlatCfg?.customExecutablePath) {
        const { customExecutablePath: _ce, workingDirectory: _wd, ...restCfg } = existingPlatCfg;
        await ctx.saveLaunchConfig(
          {
            ...restCfg,
            gameId: game.id,
            preferredPlatformId: resolvedPlatformId,
            launchMethod: restCfg.launchMethod || 'auto',
          },
          resolvedPlatformId
        );
      }

      dispatchGameInstalledEvent({
        gameId: game.id,
        platformId: resolvedPlatformId,
        platformGameId: resolvedPlatformGameId,
        installed: false,
      });

      ctx.notifyStateChanged();
    }

    return res;
  }

  public async verifyGameFiles(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<LauncherActionResult> {
    const effPlatform = ctx.getEffectivePlatformForGame(game, platformId);
    const rec = ctx.getInstalledRecordForGame(game, effPlatform?.platformId);
    const resolvedPlatformId: StorefrontId =
      platformId || rec?.platformId || effPlatform?.platformId || 'steam';
    const resolvedPlatformGameId =
      rec?.platformGameId || effPlatform?.platformGameId || String(game.steamAppId || game.id);
    const installPath = rec?.installPath || effPlatform?.installPath;

    if (typeof window !== 'undefined' && window.electronAPI?.verifyGameFiles) {
      try {
        return await window.electronAPI.verifyGameFiles({
          gameId: game.id,
          title: game.title,
          platformId: resolvedPlatformId,
          platformGameId: resolvedPlatformGameId,
          steamAppId: game.steamAppId,
          installPath,
        });
      } catch (err: unknown) {
        return {
          success: false,
          error: getLauncherErrorMessage(err, `Failed to verify game files for ${game.title}.`),
        };
      }
    }

    return {
      success: true,
      message: `Verified game files for ${game.title}`,
    };
  }

  public async browseLocalFiles(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<boolean> {
    const effPlatform = ctx.getEffectivePlatformForGame(game, platformId);
    const resolvedPlatformId = platformId || effPlatform?.platformId;
    const cfg = ctx.getLaunchConfig(game.id, resolvedPlatformId);
    const rec = ctx.getInstalledRecordForGame(game, resolvedPlatformId);
    const targetPath =
      rec?.installPath ||
      effPlatform?.installPath ||
      cfg?.workingDirectory ||
      cfg?.customExecutablePath ||
      rec?.executablePath;

    if (!targetPath) return false;

    if (typeof window !== 'undefined' && window.electronAPI?.browseLocalFiles) {
      try {
        const res = await window.electronAPI.browseLocalFiles(targetPath);
        return typeof res === 'boolean' ? res : Boolean(res?.success);
      } catch {
        return false;
      }
    }

    return false;
  }

  public async locateInstalledGame(
    game: CanonicalGame,
    platformId: StorefrontId | undefined,
    ctx: SessionLifecycleManagerContext
  ): Promise<string | null> {
    const selectedExe = await ctx.selectExecutable();
    if (!selectedExe) return null;

    const resolvedPlatformId: StorefrontId =
      platformId ||
      ctx.getLaunchConfig(game.id)?.preferredPlatformId ||
      game.platforms[0]?.platformId ||
      'custom';

    const existingCfg = ctx.getLaunchConfig(game.id, resolvedPlatformId) || {
      gameId: game.id,
      launchMethod: 'direct' as LaunchMethod,
    };

    const normalizedExe = selectedExe.replace(/[\\/]+$/, '');
    const lastSepIdx = Math.max(normalizedExe.lastIndexOf('/'), normalizedExe.lastIndexOf('\\'));
    const exeDir = lastSepIdx > 0 ? normalizedExe.slice(0, lastSepIdx) : undefined;
    const isWinExeOnMac = !ctx.isWindowsHost() && isWindowsExecutablePath(selectedExe);

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

    await ctx.saveLaunchConfig(updatedCfg, resolvedPlatformId);

    const resolvedPlatformGameId =
      game.platforms.find((p) => p.platformId === resolvedPlatformId)?.platformGameId || game.id;

    dispatchGameInstalledEvent({
      gameId: game.id,
      platformId: resolvedPlatformId,
      platformGameId: resolvedPlatformGameId,
      installPath: exeDir || selectedExe,
      executablePath: selectedExe,
      isWindowsBinaryOnMac: isWinExeOnMac,
      installed: true,
    });

    ctx.notifyStateChanged();
    return selectedExe;
  }
}
