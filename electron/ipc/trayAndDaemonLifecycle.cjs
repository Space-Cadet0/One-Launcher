// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isTrustedIpcSenderEvent } = require('../launcher/securityAndPathUtils.cjs');

const MAX_DAEMON_BUFFERED_EVENTS = 64;
const RENDERER_READY_FALLBACK_FLUSH_MS = 350;

/**
 * Resolve the application icon path on a real filesystem path (preferring `.asar.unpacked` when packaged).
 *
 * @param {string} electronDir
 * @returns {string | undefined}
 */
function getAppIconPath(electronDir) {
  const ext = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const unpackedDir = electronDir.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, 'assets', ext),
    path.join(unpackedDir, '../build', ext),
    path.join(electronDir, 'assets', ext),
    path.join(electronDir, '../build', ext),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Manage Electron main-process tray icon, zero-renderer daemon buffering/flushing
 * (`renderer:ready` + bounded `did-finish-load` fallback), macOS cooperative bottle focus
 * helper, tracked background timers, and idempotent subsystem shutdown (`SUP-05`).
 *
 * @param {{
 *   app: any,
 *   Menu: any,
 *   Tray: any,
 *   nativeImage: any,
 *   powerMonitor?: any,
 *   ipcMain?: any,
 *   launcherEngine: any,
 *   mediaHydrationEngine: any,
 *   offlineVaultService: any,
 *   replayPendingCloudUploads?: () => Promise<any>,
 *   isNetworkOnlineForLaunch?: () => boolean,
 *   flushDiagnosticLogSync: () => void,
 *   electronDir: string,
 *   getMainWindow: () => any,
 *   setMainWindow: (win: any) => void,
 *   createMainWindow: () => void,
 *   ipcSenderSecurityOptions?: Record<string, any>,
 *   platform?: string,
 *   coopActivateHelper?: {
 *     pollAndActivateBottledGame?: (opts?: { rootPid?: number; targetExeNames?: string[]; bottlePath?: string }) => number,
 *     restorePresentationOptions?: () => boolean,
 *   } | null,
 *   macBottleFocusPollMs?: number,
 * }} deps
 */
function createTrayAndDaemonLifecycle({
  app,
  Menu,
  Tray,
  nativeImage,
  powerMonitor,
  ipcMain,
  launcherEngine,
  mediaHydrationEngine,
  offlineVaultService,
  replayPendingCloudUploads,
  isNetworkOnlineForLaunch,
  flushDiagnosticLogSync,
  electronDir,
  getMainWindow,
  setMainWindow,
  createMainWindow,
  ipcSenderSecurityOptions = {},
  platform,
  coopActivateHelper,
  macBottleFocusPollMs,
}) {
  const effectivePlatform = platform || process.platform;
  /** @type {any} */
  let appTray = null;
  let isZeroRendererDaemonActive = false;
  let hasCompletedSubsystemShutdown = false;
  let isRendererReadyForEvents = false;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let zeroRendererTeardownTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let postGameExitTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let memTrimTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let rendererReadyFallbackTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let bgRosettaTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let startupReplayTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let resumeReplayTimer = null;
  /** @type {(() => void) | null} */
  let powerResumeListener = null;
  /** @type {(() => void) | null} */
  let macAppFocusPresentationListener = null;

  /** @type {ReturnType<typeof setInterval> | null} */
  let macBottleFocusTimer = null;
  /**
   * Track active/pending macOS cooperative focus handoff state so Bottle Steam sessions
   * without an initial PID can extend polling to 90 s (450 ticks) and update/re-arm `rootPid`
   * when a subsequent `session_updated` / `running` event latches the real game PID.
   *
   * @type {{
   *   gameId: string,
   *   sessionInfo: any,
   *   effectivePolicy: any,
   *   coopActivateOpts: { rootPid: number, targetExeNames: string[], bottlePath?: string },
   *   activated: boolean,
   *   running: boolean,
   *   maxTicks: number,
   *   ticks: number,
   * } | null}
   */
  let activeMacBottleFocusState = null;
  /**
   * @type {{
   *   pollAndActivateBottledGame?: (opts?: { rootPid?: number; targetExeNames?: string[]; bottlePath?: string }) => number,
   *   restorePresentationOptions?: () => boolean,
   * } | null | false}
   */
  let macCoopActivateAddon = coopActivateHelper !== undefined ? coopActivateHelper || false : null;

  /** @type {Array<{ channel: string, payload: any, queuedAt: number }>} */
  const pendingRendererLifecycleEvents = [];

  const clearTrackedTimer = (/** @type {ReturnType<typeof setTimeout> | null} */ timerRef) => {
    if (timerRef) {
      clearTimeout(timerRef);
    }
    return null;
  };

  function removeMacPresentationFocusListeners() {
    if (macAppFocusPresentationListener && app && typeof app.removeListener === 'function') {
      try {
        app.removeListener('browser-window-focus', macAppFocusPresentationListener);
      } catch {}
      try {
        app.removeListener('activate', macAppFocusPresentationListener);
      } catch {}
    }
    macAppFocusPresentationListener = null;
  }

  function clearAllLifecycleTimers() {
    zeroRendererTeardownTimer = clearTrackedTimer(zeroRendererTeardownTimer);
    postGameExitTimer = clearTrackedTimer(postGameExitTimer);
    memTrimTimer = clearTrackedTimer(memTrimTimer);
    rendererReadyFallbackTimer = clearTrackedTimer(rendererReadyFallbackTimer);
    bgRosettaTimer = clearTrackedTimer(bgRosettaTimer);
    startupReplayTimer = clearTrackedTimer(startupReplayTimer);
    resumeReplayTimer = clearTrackedTimer(resumeReplayTimer);
    if (powerResumeListener && powerMonitor && typeof powerMonitor.removeListener === 'function') {
      try {
        powerMonitor.removeListener('resume', powerResumeListener);
      } catch {}
      powerResumeListener = null;
    }
    removeMacPresentationFocusListeners();
  }

  /**
   * Enqueue a bounded lifecycle event when the renderer window is torn down or still loading.
   * @param {string} channel
   * @param {any} payload
   */
  function enqueueRendererLifecycleEvent(channel, payload) {
    if (pendingRendererLifecycleEvents.length >= MAX_DAEMON_BUFFERED_EVENTS) {
      pendingRendererLifecycleEvents.shift();
    }
    pendingRendererLifecycleEvents.push({
      channel,
      payload,
      queuedAt: Date.now(),
    });
  }

  /**
   * Send an outbound lifecycle event to `mainWindow` immediately if ready, or buffer up to 64
   * events while in `zero_renderer_daemon` / active-game headless mode / pre-ready boot.
   * @param {string} channel
   * @param {any} payload
   */
  function sendOrBufferRendererEvent(channel, payload) {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      try {
        const isLoading =
          typeof mainWindow.webContents.isLoadingMainFrame === 'function' &&
          mainWindow.webContents.isLoadingMainFrame();
        if (isLoading || !isRendererReadyForEvents) {
          enqueueRendererLifecycleEvent(channel, payload);
          return;
        }
        mainWindow.webContents.send(channel, payload);
        return;
      } catch {}
    }
    if (isZeroRendererDaemonActive || (launcherEngine.getRunningGames() || []).length > 0) {
      enqueueRendererLifecycleEvent(channel, payload);
    }
  }

  /**
   * Flush buffered lifecycle events once the renderer signals `renderer:ready` (or after the
   * bounded fallback timer following `did-finish-load`).
   */
  function flushBufferedRendererEvents() {
    rendererReadyFallbackTimer = clearTrackedTimer(rendererReadyFallbackTimer);
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
    isRendererReadyForEvents = true;
    if (pendingRendererLifecycleEvents.length === 0) return;
    const queued = pendingRendererLifecycleEvents.splice(0, pendingRendererLifecycleEvents.length);
    for (const item of queued) {
      try {
        mainWindow.webContents.send(item.channel, item.payload);
      } catch {}
    }
  }

  function markMainWindowLoading() {
    isRendererReadyForEvents = false;
    rendererReadyFallbackTimer = clearTrackedTimer(rendererReadyFallbackTimer);
  }

  function markMainWindowClosed() {
    isRendererReadyForEvents = false;
    rendererReadyFallbackTimer = clearTrackedTimer(rendererReadyFallbackTimer);
  }

  /**
   * Called on `did-finish-load`: arms a bounded fallback timer so queued events are flushed
   * even if the renderer does not emit `'renderer:ready'` (e.g. legacy preload or unit tests).
   */
  function scheduleFallbackFlushAfterDidFinishLoad() {
    if (isRendererReadyForEvents) {
      flushBufferedRendererEvents();
      return;
    }
    rendererReadyFallbackTimer = clearTrackedTimer(rendererReadyFallbackTimer);
    const delayMs =
      process.env.VITEST || process.env.NODE_ENV === 'test' ? 10 : RENDERER_READY_FALLBACK_FLUSH_MS;
    rendererReadyFallbackTimer = setTimeout(() => {
      rendererReadyFallbackTimer = null;
      flushBufferedRendererEvents();
    }, delayMs);
    if (typeof rendererReadyFallbackTimer.unref === 'function') {
      rendererReadyFallbackTimer.unref();
    }
  }

  /**
   * Register the `'renderer:ready'` IPC listener to immediately flush buffered daemon events
   * once React mounts its IPC listeners.
   */
  function registerRendererReadyListener() {
    if (!ipcMain || typeof ipcMain.on !== 'function') return;
    ipcMain.on('renderer:ready', (/** @type {any} */ event) => {
      if (
        !isTrustedIpcSenderEvent(event, {
          ...ipcSenderSecurityOptions,
          getMainWindow,
        })
      ) {
        return;
      }
      flushBufferedRendererEvents();
    });
  }

  function destroyAppTray() {
    if (!appTray) return;
    const trayRef = appTray;
    appTray = null;
    try {
      if (typeof trayRef.destroy === 'function') {
        trayRef.destroy();
      }
    } catch {}
  }

  function restoreMacPresentationOptions() {
    if (effectivePlatform !== 'darwin') return;
    const helper =
      macCoopActivateAddon && typeof macCoopActivateAddon === 'object'
        ? macCoopActivateAddon
        : null;
    if (helper && typeof helper.restorePresentationOptions === 'function') {
      try {
        helper.restorePresentationOptions();
      } catch {}
    }
  }

  function restoreOrCreateMainWindow() {
    isZeroRendererDaemonActive = false;
    zeroRendererTeardownTimer = clearTrackedTimer(zeroRendererTeardownTimer);
    if (effectivePlatform === 'darwin') {
      restoreMacPresentationOptions();
      if (app.dock && typeof app.dock.show === 'function') {
        try {
          app.dock.show();
        } catch {}
      }
      if (typeof app.show === 'function') {
        try {
          app.show();
        } catch {}
      }
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }
    try {
      mainWindow.webContents.setAudioMuted(false);
      sendOrBufferRendererEvent('launcher:hibernate-state', {
        hibernating: false,
        inGame: (launcherEngine.getRunningGames() || []).length > 0,
      });
    } catch {}
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    if (effectivePlatform === 'darwin' && typeof app.focus === 'function') {
      try {
        app.focus({ steal: true });
      } catch {}
    }
    mainWindow.focus();
  }

  function updateAppTrayMenu() {
    if (!appTray) return;
    try {
      const runningGames = launcherEngine.getRunningGames() || [];
      const activeGame = runningGames[0] || null;
      /** @type {import('electron').MenuItemConstructorOptions[]} */
      const template = [
        {
          label: activeGame
            ? `Playing: ${activeGame.title || activeGame.gameId}`
            : 'One Launcher — Idle',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: 'Restore One Launcher',
          click: () => {
            restoreOrCreateMainWindow();
          },
        },
        ...(activeGame
          ? [
              {
                label: 'Stop Running Game',
                click: () => {
                  launcherEngine.stopGame({ gameId: activeGame.gameId }).catch(() => {});
                },
              },
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Quit One Launcher',
          click: () => {
            isZeroRendererDaemonActive = false;
            app.quit();
          },
        },
      ];
      const contextMenu = Menu.buildFromTemplate(template);
      appTray.setContextMenu(contextMenu);
      appTray.setToolTip(
        activeGame
          ? `One Launcher — Playing: ${activeGame.title || activeGame.gameId}`
          : 'One Launcher'
      );
    } catch {}
  }

  function ensureAppTray() {
    if (appTray) {
      updateAppTrayMenu();
      return appTray;
    }
    if (!Tray || !nativeImage) return null;
    try {
      const iconPath = getAppIconPath(electronDir);
      if (!iconPath) return null;
      const resolvedIconPath = iconPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const finalPath = fs.existsSync(resolvedIconPath) ? resolvedIconPath : iconPath;
      let trayImg = nativeImage.createFromPath(finalPath);
      if (!trayImg || trayImg.isEmpty()) {
        return null;
      }
      if (typeof trayImg.resize === 'function') {
        trayImg = trayImg.resize({ width: 18, height: 18 });
      }
      appTray = new Tray(trayImg);
      appTray.on('click', () => {
        if (process.platform !== 'darwin') {
          restoreOrCreateMainWindow();
        }
      });
      updateAppTrayMenu();
      return appTray;
    } catch {
      return null;
    }
  }

  function loadMacCoopActivateHelper() {
    if (macCoopActivateAddon !== null) {
      return macCoopActivateAddon || null;
    }
    if (effectivePlatform !== 'darwin') {
      macCoopActivateAddon = false;
      return null;
    }
    const candidates = [
      path.join(
        process.resourcesPath || '',
        'app.asar.unpacked',
        'electron',
        'helpers',
        'libone_coop_activate.dylib'
      ),
      path.join(electronDir, 'helpers', 'libone_coop_activate.dylib'),
    ];
    for (const dylibPath of candidates) {
      try {
        if (!dylibPath || !fs.existsSync(dylibPath)) continue;
        const mod = { exports: {} };
        process.dlopen(mod, dylibPath);
        if (typeof (/** @type {any} */ (mod.exports).pollAndActivateBottledGame) === 'function') {
          macCoopActivateAddon =
            /**
             * @type {{
             *   pollAndActivateBottledGame: (opts?: { rootPid?: number; targetExeNames?: string[]; bottlePath?: string }) => number,
             *   restorePresentationOptions?: () => boolean,
             * }}
             */ (mod.exports);
          return macCoopActivateAddon;
        }
      } catch {}
    }
    macCoopActivateAddon = false;
    return null;
  }

  function stopMacBottleFocusHelper(
    /** @type {{ restorePresentation?: boolean, clearState?: boolean }} */ opts = {}
  ) {
    if (macBottleFocusTimer) {
      clearInterval(macBottleFocusTimer);
      macBottleFocusTimer = null;
    }
    if (opts.clearState === true) {
      activeMacBottleFocusState = null;
    } else if (activeMacBottleFocusState) {
      activeMacBottleFocusState.running = false;
    }
    if (opts.restorePresentation === true) {
      restoreMacPresentationOptions();
    }
    try {
      launcherEngine?.stopMacBottleFocusHelper?.();
    } catch {}
  }

  /**
   * Cooperatively yields and transfers macOS AppKit frontmost status & Menu Bar
   * ownership directly from One Launcher (`NSApp`) to a newly mapped CrossOver/Wine
   * game window via native AppKit (`libone_coop_activate.dylib`).
   *
   * @param {any} eventPayload
   * @param {any} [effectivePolicy]
   */
  function activateMacBottleGameWindowOnLaunch(eventPayload, effectivePolicy) {
    const hasInjectedHelper = Boolean(coopActivateHelper);
    if (
      effectivePlatform !== 'darwin' ||
      (!hasInjectedHelper && (process.env.VITEST || process.env.NODE_ENV === 'test'))
    ) {
      return;
    }
    const sessionInfo = eventPayload && eventPayload.session ? eventPayload.session : eventPayload;
    const launchMethod = String((sessionInfo && sessionInfo.launchMethod) || '');
    const exePath = String((sessionInfo && sessionInfo.executablePath) || '');
    const isBottledWindowsLaunch =
      launchMethod.startsWith('compatibility_layer') ||
      launchMethod === 'compat_layer' ||
      Boolean(sessionInfo && sessionInfo.isBottledSession) ||
      /\.(exe|bat|cmd|msi)$/i.test(exePath);
    if (!isBottledWindowsLaunch) {
      return;
    }

    stopMacBottleFocusHelper();
    const helper = loadMacCoopActivateHelper();
    if (!helper || typeof helper.pollAndActivateBottledGame !== 'function') {
      return;
    }

    const initialPid = Number(sessionInfo && sessionInfo.pid) || 0;
    const isBottledWithoutInitialPid =
      (sessionInfo && sessionInfo.pid === undefined) || !(initialPid > 0);
    const maxFocusTicks = isBottledWithoutInitialPid && isBottledWindowsLaunch ? 450 : 200;

    const bottlePath = String(
      (sessionInfo && (sessionInfo.winePrefix || sessionInfo.bottlePath)) || ''
    ).trim();
    const coopActivateOpts = {
      rootPid: initialPid,
      targetExeNames: Array.from(
        new Set(
          [
            exePath ? path.basename(exePath) : '',
            ...(Array.isArray(sessionInfo && sessionInfo.targetExeBasenamesLower)
              ? sessionInfo.targetExeBasenamesLower
              : []),
          ]
            .map((n) => String(n || '').trim())
            .filter(Boolean)
        )
      ),
      ...(bottlePath ? { bottlePath } : {}),
    };

    const sessionGameId = String(
      (sessionInfo && sessionInfo.gameId) || (eventPayload && eventPayload.gameId) || ''
    ).trim();
    const focusState = {
      gameId: sessionGameId,
      sessionInfo,
      effectivePolicy,
      coopActivateOpts,
      activated: false,
      running: true,
      maxTicks: maxFocusTicks,
      ticks: 0,
    };
    activeMacBottleFocusState = focusState;

    const shouldHideAppAfterActivation =
      effectivePolicy?.inGameLauncherBehavior === 'hide_tray_hibernate';
    let didHideAppForSession = false;
    const hideLauncherAppOnce = () => {
      if (!shouldHideAppAfterActivation || didHideAppForSession) return;
      didHideAppForSession = true;
      if (typeof app.hide === 'function') {
        try {
          app.hide();
        } catch {}
      }
      // Once One Launcher is hidden via app.hide(), NSApp is no longer frontmost, so
      // restore One Launcher's presentation options immediately so switching back never
      // leaves Menu Bar or Dock stuck auto-hidden.
      restoreMacPresentationOptions();
    };

    let ticks = 0;
    let visibleWindowTicks = 0;
    let activeLayerTicks = 0;
    let activeTicks = 0;
    let lastPidTag = -1;
    const pollIntervalMs =
      typeof macBottleFocusPollMs === 'number' && macBottleFocusPollMs > 0
        ? macBottleFocusPollMs
        : 200;

    const timer = setInterval(() => {
      ticks += 1;
      focusState.ticks = ticks;
      if (ticks > focusState.maxTicks) {
        if ((launcherEngine.getRunningGames() || []).length > 0) {
          hideLauncherAppOnce();
        }
        stopMacBottleFocusHelper({ restorePresentation: didHideAppForSession });
        return;
      }
      if (ticks > 200 && (launcherEngine.getRunningGames() || []).length === 0) {
        stopMacBottleFocusHelper({ restorePresentation: didHideAppForSession });
        return;
      }
      try {
        const encoded = Number(helper.pollAndActivateBottledGame(focusState.coopActivateOpts) || 0);
        if ((encoded & 1) === 0) {
          return;
        }
        visibleWindowTicks += 1;
        const isActive = (encoded & 2) !== 0;
        const layer = (encoded >> 2) & 0x3fff;
        const pidTag = (encoded >> 16) & 0x7fff;
        if (pidTag !== lastPidTag) {
          lastPidTag = pidTag;
          activeLayerTicks = 0;
          activeTicks = 0;
        }
        // Once the game window is active (or mapped for >= 3 ticks), hide One Launcher via
        // app.hide() so macOS never keeps "One Launcher  Edit  View  Window" in the Menu Bar
        // above layer=0 borderless D3D12/D3DMetal games.
        if (isActive || visibleWindowTicks >= 3) {
          hideLauncherAppOnce();
        }
        if (isActive && layer >= 25) {
          activeLayerTicks += 1;
          if (activeLayerTicks >= 3) {
            focusState.activated = true;
            stopMacBottleFocusHelper({ restorePresentation: didHideAppForSession });
            return;
          }
        } else {
          activeLayerTicks = 0;
        }
        if (isActive) {
          activeTicks += 1;
          if (activeTicks >= 3) {
            focusState.activated = true;
            stopMacBottleFocusHelper({ restorePresentation: didHideAppForSession });
          }
        }
      } catch {
        stopMacBottleFocusHelper({ restorePresentation: didHideAppForSession });
      }
    }, pollIntervalMs);

    macBottleFocusTimer = timer;
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function installMacPresentationFocusListeners() {
    if (effectivePlatform !== 'darwin' || !app || typeof app.on !== 'function') {
      return;
    }
    removeMacPresentationFocusListeners();
    macAppFocusPresentationListener = () => {
      restoreMacPresentationOptions();
    };
    try {
      app.on('browser-window-focus', macAppFocusPresentationListener);
      app.on('activate', macAppFocusPresentationListener);
    } catch {}
  }

  function installSessionLifecycleHook() {
    installMacPresentationFocusListeners();
    launcherEngine.setSessionLifecycleHook(
      (/** @type {string} */ gameId, /** @type {any} */ eventPayload) => {
        try {
          updateAppTrayMenu();
          const eventType = eventPayload && eventPayload.event;
          if (!eventType) return;

          const rawGameLaunchCfg = launcherEngine.getGameLaunchConfig(gameId);
          const activePlatformId = eventPayload?.session?.platformId || eventPayload?.platformId;
          const gameLaunchCfg = launcherEngine.resolvePlatformLaunchConfig(
            rawGameLaunchCfg,
            activePlatformId
          );
          const effectivePolicy = launcherEngine.resolveEffectivePerformancePolicy(gameLaunchCfg);

          if (eventType === 'started') {
            postGameExitTimer = clearTrackedTimer(postGameExitTimer);
            zeroRendererTeardownTimer = clearTrackedTimer(zeroRendererTeardownTimer);
            memTrimTimer = clearTrackedTimer(memTrimTimer);

            memTrimTimer = setTimeout(() => {
              memTrimTimer = null;
              try {
                launcherEngine.trimLauncherEngineMemory();
              } catch {}
            }, 3000);
            if (typeof memTrimTimer.unref === 'function') {
              memTrimTimer.unref();
            }

            activateMacBottleGameWindowOnLaunch(eventPayload, effectivePolicy);

            const mainWindow = getMainWindow();
            const mode = effectivePolicy.inGameLauncherBehavior;
            if (mode === 'keep_open') {
              sendOrBufferRendererEvent('launcher:hibernate-state', {
                hibernating: false,
                inGame: true,
                mode: 'keep_open',
                gameTitle: eventPayload.title,
              });
            } else if (mode === 'minimize_taskbar') {
              sendOrBufferRendererEvent('launcher:hibernate-state', {
                hibernating: false,
                inGame: true,
                mode: 'minimize_taskbar',
                gameTitle: eventPayload.title,
              });
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.minimize();
              }
            } else if (mode === 'hide_tray_hibernate') {
              const tray = ensureAppTray();
              sendOrBufferRendererEvent('launcher:hibernate-state', {
                hibernating: true,
                inGame: true,
                mode: 'hide_tray_hibernate',
                gameTitle: eventPayload.title,
              });
              if (mainWindow && !mainWindow.isDestroyed()) {
                try {
                  mainWindow.webContents.setAudioMuted(true);
                  mainWindow.webContents.setBackgroundThrottling?.(true);
                } catch {}
                if (tray || effectivePlatform === 'darwin') {
                  mainWindow.hide();
                } else {
                  mainWindow.minimize();
                }
              }
              if (
                effectivePlatform === 'darwin' &&
                !macBottleFocusTimer &&
                typeof app.hide === 'function'
              ) {
                try {
                  app.hide();
                } catch {}
                restoreMacPresentationOptions();
              }
              launcherEngine.trimLauncherEngineMemory();
            } else if (mode === 'zero_renderer_daemon') {
              const tray = ensureAppTray();
              if (!tray && effectivePlatform !== 'darwin') {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.minimize();
                }
                launcherEngine.trimLauncherEngineMemory();
              } else {
                isZeroRendererDaemonActive = true;
                zeroRendererTeardownTimer = setTimeout(() => {
                  zeroRendererTeardownTimer = null;
                  if ((launcherEngine.getRunningGames() || []).length === 0) return;
                  const win = getMainWindow();
                  if (win && !win.isDestroyed()) {
                    try {
                      win.destroy();
                    } catch {}
                    setMainWindow(null);
                  }
                  if (effectivePlatform === 'darwin' && typeof app.hide === 'function') {
                    try {
                      app.hide();
                    } catch {}
                    restoreMacPresentationOptions();
                  }
                  launcherEngine.trimLauncherEngineMemory();
                }, 1500);
                if (typeof zeroRendererTeardownTimer.unref === 'function') {
                  zeroRendererTeardownTimer.unref();
                }
              }
            }
          } else if (eventType === 'session_updated' || eventType === 'running') {
            const sessionInfo =
              eventPayload && eventPayload.session ? eventPayload.session : eventPayload;
            const latchedPid = Number(sessionInfo && sessionInfo.pid) || 0;
            const eventGameId = String(
              (sessionInfo && sessionInfo.gameId) || gameId || ''
            ).trim();
            if (
              latchedPid > 0 &&
              activeMacBottleFocusState &&
              !activeMacBottleFocusState.activated &&
              (!activeMacBottleFocusState.gameId ||
                !eventGameId ||
                activeMacBottleFocusState.gameId === eventGameId)
            ) {
              const updatedBottlePath = String(
                (sessionInfo && (sessionInfo.winePrefix || sessionInfo.bottlePath)) || ''
              ).trim();
              if (updatedBottlePath && !activeMacBottleFocusState.coopActivateOpts.bottlePath) {
                activeMacBottleFocusState.coopActivateOpts.bottlePath = updatedBottlePath;
              }
              if (Array.isArray(sessionInfo && sessionInfo.targetExeBasenamesLower)) {
                activeMacBottleFocusState.coopActivateOpts.targetExeNames = Array.from(
                  new Set([
                    ...activeMacBottleFocusState.coopActivateOpts.targetExeNames,
                    ...sessionInfo.targetExeBasenamesLower
                      .map((/** @type {any} */ n) => String(n || '').trim())
                      .filter(Boolean),
                  ])
                );
              }
              if (macBottleFocusTimer && activeMacBottleFocusState.running) {
                activeMacBottleFocusState.coopActivateOpts.rootPid = latchedPid;
              } else {
                const mergedSession = {
                  ...(activeMacBottleFocusState.sessionInfo || {}),
                  ...(sessionInfo || {}),
                  pid: latchedPid,
                };
                activateMacBottleGameWindowOnLaunch(
                  { ...(eventPayload || {}), session: mergedSession },
                  effectivePolicy || activeMacBottleFocusState.effectivePolicy
                );
              }
            }
          } else if (eventType === 'stopped') {
            stopMacBottleFocusHelper({ restorePresentation: true, clearState: true });
            const remainingGames = launcherEngine.getRunningGames() || [];
            if (remainingGames.length > 0) return;

            zeroRendererTeardownTimer = clearTrackedTimer(zeroRendererTeardownTimer);

            const postAction = effectivePolicy.postGameLauncherBehavior;
            if (postAction === 'exit_launcher') {
              postGameExitTimer = clearTrackedTimer(postGameExitTimer);
              const startedWaitMs = Date.now();
              const maxWaitMs = 60000;
              const attemptPostGameExit = () => {
                postGameExitTimer = null;
                if ((launcherEngine.getRunningGames() || []).length > 0) {
                  return;
                }
                const hasActiveDownloads = (launcherEngine.getDownloadQueue() || []).some(
                  (/** @type {any} */ t) =>
                    ['downloading', 'queued', 'extracting', 'verifying'].includes(t && t.status)
                );
                const hasPausedInGameDownloads =
                  typeof launcherEngine.getPausedByInGameTaskIds === 'function' &&
                  (launcherEngine.getPausedByInGameTaskIds() || []).length > 0;
                if (hasActiveDownloads || hasPausedInGameDownloads) {
                  return;
                }
                const hasPostWork =
                  typeof launcherEngine.hasActivePostSessionWork === 'function' &&
                  launcherEngine.hasActivePostSessionWork();
                if (hasPostWork && Date.now() - startedWaitMs < maxWaitMs) {
                  postGameExitTimer = setTimeout(attemptPostGameExit, 200);
                  if (typeof postGameExitTimer.unref === 'function') {
                    postGameExitTimer.unref();
                  }
                  return;
                }
                isZeroRendererDaemonActive = false;
                app.quit();
              };
              postGameExitTimer = setTimeout(attemptPostGameExit, 1500);
              if (typeof postGameExitTimer.unref === 'function') {
                postGameExitTimer.unref();
              }
            } else if (postAction === 'stay_minimized') {
              const mainWindow = getMainWindow();
              if (mainWindow && !mainWindow.isDestroyed()) {
                try {
                  mainWindow.webContents.setAudioMuted(false);
                } catch {}
              }
              sendOrBufferRendererEvent('launcher:hibernate-state', {
                hibernating: false,
                inGame: false,
              });
            } else {
              sendOrBufferRendererEvent('launcher:hibernate-state', {
                hibernating: false,
                inGame: false,
              });
              const mainWindow = getMainWindow();
              if (
                effectivePolicy.inGameLauncherBehavior !== 'keep_open' ||
                !mainWindow ||
                mainWindow.isDestroyed()
              ) {
                restoreOrCreateMainWindow();
              }
            }
          }
        } catch {}
      }
    );
  }

  function scheduleBackgroundStartupJobs() {
    if (
      process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      typeof launcherEngine.ensureRosetta2InBackground === 'function'
    ) {
      bgRosettaTimer = clearTrackedTimer(bgRosettaTimer);
      bgRosettaTimer = setTimeout(() => {
        bgRosettaTimer = null;
        void Promise.resolve(launcherEngine.ensureRosetta2InBackground()).catch(() => {});
      }, 1500);
      if (typeof bgRosettaTimer.unref === 'function') {
        bgRosettaTimer.unref();
      }
    }

    // L-10: Replay any interrupted/offline post-exit cloud uploads on startup and system wake
    if (
      typeof replayPendingCloudUploads === 'function' &&
      !(typeof launcherEngine.isTestEnvironment === 'function' && launcherEngine.isTestEnvironment())
    ) {
      const triggerPendingCloudReplay = () => {
        try {
          if (
            typeof isNetworkOnlineForLaunch === 'function' &&
            !isNetworkOnlineForLaunch()
          ) {
            return;
          }
          void Promise.resolve(replayPendingCloudUploads()).catch(() => {});
        } catch {}
      };
      startupReplayTimer = clearTrackedTimer(startupReplayTimer);
      startupReplayTimer = setTimeout(() => {
        startupReplayTimer = null;
        triggerPendingCloudReplay();
      }, 3000);
      if (typeof startupReplayTimer.unref === 'function') {
        startupReplayTimer.unref();
      }
      if (powerMonitor && typeof powerMonitor.on === 'function') {
        try {
          if (powerResumeListener && typeof powerMonitor.removeListener === 'function') {
            powerMonitor.removeListener('resume', powerResumeListener);
          }
          powerResumeListener = () => {
            resumeReplayTimer = clearTrackedTimer(resumeReplayTimer);
            resumeReplayTimer = setTimeout(() => {
              resumeReplayTimer = null;
              triggerPendingCloudReplay();
            }, 2000);
            if (typeof resumeReplayTimer.unref === 'function') {
              resumeReplayTimer.unref();
            }
          };
          powerMonitor.on('resume', powerResumeListener);
        } catch {}
      }
    }
  }

  function runSubsystemShutdownOnce() {
    clearAllLifecycleTimers();
    stopMacBottleFocusHelper({ restorePresentation: true, clearState: true });
    destroyAppTray();
    if (hasCompletedSubsystemShutdown) return;
    hasCompletedSubsystemShutdown = true;
    try {
      mediaHydrationEngine.shutdown();
    } catch {}
    try {
      offlineVaultService.shutdown();
    } catch {}
    try {
      launcherEngine.shutdownLauncherEngine();
    } catch {}
    try {
      flushDiagnosticLogSync();
    } catch {}
  }

  return {
    getAppIconPath: () => getAppIconPath(electronDir),
    isZeroRendererDaemonActive: () => isZeroRendererDaemonActive,
    setZeroRendererDaemonActive: (/** @type {boolean} */ active) => {
      isZeroRendererDaemonActive = Boolean(active);
    },
    hasCompletedSubsystemShutdown: () => hasCompletedSubsystemShutdown,
    enqueueRendererLifecycleEvent,
    sendOrBufferRendererEvent,
    flushBufferedRendererEvents,
    markMainWindowLoading,
    markMainWindowClosed,
    scheduleFallbackFlushAfterDidFinishLoad,
    registerRendererReadyListener,
    restoreMacPresentationOptions,
    restoreOrCreateMainWindow,
    updateAppTrayMenu,
    ensureAppTray,
    destroyAppTray,
    stopMacBottleFocusHelper,
    clearAllLifecycleTimers,
    installSessionLifecycleHook,
    scheduleBackgroundStartupJobs,
    runSubsystemShutdownOnce,
  };
}

module.exports = {
  MAX_DAEMON_BUFFERED_EVENTS,
  RENDERER_READY_FALLBACK_FLUSH_MS,
  getAppIconPath,
  createTrayAndDaemonLifecycle,
};
