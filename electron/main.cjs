// @ts-check
'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  nativeImage,
  Menu,
  Tray,
  shell,
  dialog,
  protocol,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const storeSync = require('./storeSync.cjs');
const launcherEngine = require('./launcherEngine.cjs');
const { createStorefrontLocalCacheFederator } = require('./launcher/storefrontLocalCacheFederator.cjs');
const { createOfflineVaultService } = require('./launcher/offlineVaultService.cjs');
const { createMediaHydrationEngine } = require('./launcher/mediaHydrationEngine.cjs');
const { registerLauncherIpcHandlers } = require('./ipc/launcherIpcHandlers.cjs');
const {
  registerWindowAndSystemIpcHandlers,
  selectPlatformReleaseAsset,
  isSafeGitHubReleaseUrl,
  ALLOWED_GITHUB_RELEASE_HOSTS,
} = require('./ipc/windowAndSystemIpcHandlers.cjs');
const { registerStoreSyncIpcHandlers } = require('./ipc/storeSyncIpcHandlers.cjs');
const {
  registerOfflineVaultIpcHandlers,
  createOlMediaProtocolHandler,
} = require('./ipc/offlineVaultIpcHandlers.cjs');
const { compareSemver } = require('./utils/semverUtils.cjs');
const { diagLog, flushSync: flushDiagnosticLogSync } = require('./utils/diagnosticLogger.cjs');
const { isAllowedHttpsHost } = require('./launcher/securityAndPathUtils.cjs');

// Register custom streaming media protocol (`ol-media://`) before `app.whenReady()`
if (protocol && typeof protocol.registerSchemesAsPrivileged === 'function') {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ol-media',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

// Ensure videos and embedded trailers autoplay smoothly without requiring user gesture
if (app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

// Only use Chromium's mock keychain in unsigned local development builds on macOS so ad-hoc rebuilds
// do not trigger repeated Login Keychain prompts while signed production builds retain real Keychain protection.
if (
  process.platform === 'darwin' &&
  !app?.isPackaged &&
  !process.env.CSC_LINK &&
  app &&
  app.commandLine &&
  typeof app.commandLine.appendSwitch === 'function'
) {
  app.commandLine.appendSwitch('use-mock-keychain');
}

/** @type {any} */
let mainWindow = null;
/** @type {any} */
let appTray = null;
let isZeroRendererDaemonActive = false;
let isQuittingAfterSync = false;
/** @type {Promise<any> | null} */
let shutdownInProgressPromise = null;
let hasCompletedSubsystemShutdown = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let zeroRendererTeardownTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let postGameExitTimer = null;

const MAX_DAEMON_BUFFERED_EVENTS = 64;
/** @type {Array<{ channel: string, payload: any, queuedAt: number }>} */
const pendingRendererLifecycleEvents = [];

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
 * events while in `zero_renderer_daemon` / active-game headless mode.
 * @param {string} channel
 * @param {any} payload
 */
function sendOrBufferRendererEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    try {
      if (
        typeof mainWindow.webContents.isLoadingMainFrame === 'function' &&
        mainWindow.webContents.isLoadingMainFrame()
      ) {
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
 * Flush buffered lifecycle events once a recreated `mainWindow` finishes loading.
 */
function flushBufferedRendererEvents() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
  if (pendingRendererLifecycleEvents.length === 0) return;
  const queued = pendingRendererLifecycleEvents.splice(0, pendingRendererLifecycleEvents.length);
  for (const item of queued) {
    try {
      mainWindow.webContents.send(item.channel, item.payload);
    } catch {}
  }
}

launcherEngine.setMainWindowGetter(() => mainWindow);

const storefrontFederator = createStorefrontLocalCacheFederator();
const offlineVaultService = createOfflineVaultService({ federator: storefrontFederator });
const mediaHydrationEngine = createMediaHydrationEngine({
  offlineVaultService,
  launcherEngine,
});

if (typeof launcherEngine.setOfflineVaultLifecycleHooks === 'function') {
  launcherEngine.setOfflineVaultLifecycleHooks({
    trimMemory: () => offlineVaultService.trimMemory(),
    shutdown: () => {
      mediaHydrationEngine.shutdown();
      offlineVaultService.shutdown();
    },
  });
}

/**
 * Resolve the application icon path on a real filesystem path (preferring `.asar.unpacked` when packaged).
 * @returns {string | undefined}
 */
function getAppIconPath() {
  const ext = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, 'assets', ext),
    path.join(unpackedDir, '../build', ext),
    path.join(__dirname, 'assets', ext),
    path.join(__dirname, '../build', ext),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function restoreOrCreateMainWindow() {
  isZeroRendererDaemonActive = false;
  if (zeroRendererTeardownTimer) {
    clearTimeout(zeroRendererTeardownTimer);
    zeroRendererTeardownTimer = null;
  }
  if (process.platform === 'darwin' && app.dock && typeof app.dock.show === 'function') {
    try {
      app.dock.show();
    } catch {}
  }
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
    const iconPath = getAppIconPath();
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

launcherEngine.setSessionLifecycleHook((/** @type {string} */ gameId, /** @type {any} */ eventPayload) => {
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
      if (postGameExitTimer) {
        clearTimeout(postGameExitTimer);
        postGameExitTimer = null;
      }
      if (zeroRendererTeardownTimer) {
        clearTimeout(zeroRendererTeardownTimer);
        zeroRendererTeardownTimer = null;
      }

      const memTrimTimer = setTimeout(() => {
        try {
          launcherEngine.trimLauncherEngineMemory();
        } catch {}
      }, 3000);
      if (typeof memTrimTimer.unref === 'function') {
        memTrimTimer.unref();
      }

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
          if (tray || process.platform === 'darwin') {
            mainWindow.hide();
          } else {
            mainWindow.minimize();
          }
        }
        launcherEngine.trimLauncherEngineMemory();
      } else if (mode === 'zero_renderer_daemon') {
        const tray = ensureAppTray();
        if (!tray && process.platform !== 'darwin') {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.minimize();
          }
          launcherEngine.trimLauncherEngineMemory();
        } else {
          isZeroRendererDaemonActive = true;
          zeroRendererTeardownTimer = setTimeout(() => {
            zeroRendererTeardownTimer = null;
            if ((launcherEngine.getRunningGames() || []).length === 0) return;
            if (mainWindow && !mainWindow.isDestroyed()) {
              try {
                mainWindow.destroy();
              } catch {}
              mainWindow = null;
            }
            launcherEngine.trimLauncherEngineMemory();
          }, 1500);
          if (typeof zeroRendererTeardownTimer.unref === 'function') {
            zeroRendererTeardownTimer.unref();
          }
        }
      }
    } else if (eventType === 'stopped') {
      const remainingGames = launcherEngine.getRunningGames() || [];
      if (remainingGames.length > 0) return;

      if (zeroRendererTeardownTimer) {
        clearTimeout(zeroRendererTeardownTimer);
        zeroRendererTeardownTimer = null;
      }

      const postAction = effectivePolicy.postGameLauncherBehavior;
      if (postAction === 'exit_launcher') {
        if (postGameExitTimer) clearTimeout(postGameExitTimer);
        const startedWaitMs = Date.now();
        const maxWaitMs = 60000;
        const attemptPostGameExit = () => {
          postGameExitTimer = null;
          if ((launcherEngine.getRunningGames() || []).length > 0) {
            return;
          }
          const hasActiveDownloads = (launcherEngine.getDownloadQueue() || []).some((/** @type {any} */ t) =>
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
});

function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const allowDevTools = !app?.isPackaged || process.env.ONE_LAUNCHER_DEBUG === '1';

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'One Launcher',
    icon: getAppIconPath(),
    backgroundColor: '#0b0f17',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 19 },
        }
      : {
          frame: false,
          autoHideMenuBar: true,
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
      webSecurity: true,
    },
  });

  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);

    mainWindow.webContents.on(
      'before-input-event',
      (/** @type {any} */ event, /** @type {any} */ input) => {
        if (input.type !== 'keyDown' || !mainWindow || mainWindow.isDestroyed()) return;
        const key = String(input.key || '').toLowerCase();
        const ctrlOrCmd = Boolean(input.control || input.meta);

        if (input.key === 'F11') {
          event.preventDefault();
          mainWindow.setFullScreen(!mainWindow.isFullScreen());
        } else if (input.key === 'F12' || (ctrlOrCmd && input.shift && key === 'i')) {
          event.preventDefault();
          if (allowDevTools) {
            mainWindow.webContents.toggleDevTools();
          }
        } else if (ctrlOrCmd && input.shift && key === 'r') {
          event.preventDefault();
          mainWindow.webContents.reloadIgnoringCache();
        } else if (ctrlOrCmd && !input.shift && key === 'r') {
          event.preventDefault();
          mainWindow.webContents.reload();
        } else if (ctrlOrCmd && (key === '=' || key === '+')) {
          event.preventDefault();
          mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
        } else if (ctrlOrCmd && key === '-') {
          event.preventDefault();
          mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5);
        } else if (ctrlOrCmd && key === '0') {
          event.preventDefault();
          mainWindow.webContents.setZoomLevel(0);
        }
      }
    );
  }

  const distHtml = path.join(__dirname, '../dist/index.html');
  if (app.isPackaged || process.env.NODE_ENV === 'production' || !process.env.ELECTRON_START_URL) {
    if (fs.existsSync(distHtml)) {
      mainWindow.loadFile(distHtml);
    } else {
      mainWindow.loadURL('http://localhost:3000').catch(() => {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL('http://localhost:3000').catch(() => {});
          }
        }, 1000);
      });
    }
  } else {
    mainWindow.loadURL('http://localhost:3000').catch(() => {
      if (fs.existsSync(distHtml) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(distHtml);
      }
    });
  }

  // Strictly deny arbitrary child popup windows; open external http(s) and storefront protocol links via OS shell
  mainWindow.webContents.setWindowOpenHandler((/** @type {any} */ { url }) => {
    if (
      typeof url === 'string' &&
      !/[\x00-\x1f\x7f]/.test(url) &&
      /^(?:https?:\/\/|msxbox:(?:\/\/|\S)|ms-windows-store:(?:\/\/|\S)|xbox:(?:\/\/|\S)|ms-xbl-[a-z0-9-]+:(?:\/\/|\S))/i.test(
        url.trim()
      )
    ) {
      shell?.openExternal?.(url.trim());
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    flushBufferedRendererEvents();
  });

  mainWindow.on('enter-full-screen', () => {
    sendOrBufferRendererEvent('window:fullscreen-changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    sendOrBufferRendererEvent('window:fullscreen-changed', false);
  });

  mainWindow.on('maximize', () => {
    sendOrBufferRendererEvent('window:maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    sendOrBufferRendererEvent('window:maximized-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Ensure single application instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreOrCreateMainWindow();
  });

  try {
    if (app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
      app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --expose-gc');
      app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024));
      app.commandLine.appendSwitch('media-cache-size', String(25 * 1024 * 1024));
      app.commandLine.appendSwitch('renderer-process-limit', '2');
      // Preserve CalculateNativeWinOcclusion on Windows so occluded/minimized renderer windows throttle to 0% GPU
      app.commandLine.appendSwitch(
        'disable-features',
        'SpareRendererForSitePerProcess,BackForwardCache'
      );
    }
  } catch {
    // Ignore if commandLine is unavailable in mocked test environments
  }

  app.whenReady().then(() => {
    if (protocol && typeof protocol.handle === 'function') {
      try {
        protocol.handle('ol-media', createOlMediaProtocolHandler({ offlineVaultService }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to register ol-media protocol handler:', msg);
      }
    }

    if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
      try {
        const iconPath = getAppIconPath();
        if (iconPath) {
          const dockImg = nativeImage.createFromPath(iconPath);
          if (!dockImg.isEmpty()) {
            app.dock.setIcon(dockImg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to set macOS dock icon:', msg);
      }
    }

    const embedFilters = [
      '*://*.youtube.com/*',
      '*://youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://youtube-nocookie.com/*',
      '*://*.wistia.net/*',
      '*://*.fast.wistia.net/*',
    ];

    const storeApiFilters = [
      '*://*.steampowered.com/*',
      '*://*.steamcommunity.com/*',
      '*://*.steamstatic.com/*',
      '*://*.gog.com/*',
      '*://*.gog-statics.com/*',
      '*://*.epicgames.com/*',
      '*://*.howlongtobeat.com/*',
      '*://howlongtobeat.com/*',
      '*://*.lutris.net/*',
      '*://*.opencritic.com/*',
      '*://*.metacritic.com/*',
    ];

    const beforeSendFilters = [
      ...embedFilters,
      '*://*.steampowered.com/*',
      '*://*.lutris.net/*',
    ];

    const embedHostAllowlist = embedFilters.map((f) =>
      f.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/\*$/, '')
    );

    const corsRewriteHostPatterns = [...embedFilters, ...storeApiFilters].map((f) =>
      f.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/\*$/, '')
    );

    const STANDARD_CHROME_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: beforeSendFilters },
      (/** @type {any} */ details, /** @type {any} */ callback) => {
        if (
          mainWindow &&
          !mainWindow.isDestroyed() &&
          details.webContentsId &&
          details.webContentsId !== mainWindow.webContents.id
        ) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        const url = details.url || '';

        if (
          (details.resourceType === 'subFrame' || details.resourceType === 'mainFrame') &&
          isAllowedHttpsHost(url, embedHostAllowlist)
        ) {
          delete details.requestHeaders['origin'];
          delete details.requestHeaders['Origin'];
          delete details.requestHeaders['referer'];
          delete details.requestHeaders['Referer'];
          details.requestHeaders['Origin'] = 'https://www.gog.com';
          details.requestHeaders['Referer'] = 'https://www.gog.com/';
        }

        if (isAllowedHttpsHost(url, ['store.steampowered.com'])) {
          const existingCookie =
            details.requestHeaders['Cookie'] || details.requestHeaders['cookie'] || '';
          delete details.requestHeaders['cookie'];
          delete details.requestHeaders['accept-language'];
          details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
          const steamMature =
            'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1';
          if (!existingCookie) {
            details.requestHeaders['Cookie'] = steamMature;
          } else {
            let updated = existingCookie.replace(
              /Steam_Language=[a-zA-Z_-]+/gi,
              'Steam_Language=english'
            );
            if (!/Steam_Language=/i.test(updated)) updated = `Steam_Language=english; ${updated}`;
            if (!updated.includes('birthtime=')) updated += '; birthtime=568022401';
            if (!updated.includes('mature_content=')) updated += '; mature_content=1';
            if (!updated.includes('wants_mature_content=')) updated += '; wants_mature_content=1';
            details.requestHeaders['Cookie'] = updated;
          }
        }

        if (isAllowedHttpsHost(url, ['lutris.net'])) {
          details.requestHeaders['User-Agent'] = STANDARD_CHROME_UA;
        }

        callback({ requestHeaders: details.requestHeaders });
      }
    );

    const APP_CSP_PACKAGED = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: ol-media: https:",
      "media-src 'self' data: blob: ol-media: https:",
      "connect-src 'self' ol-media: https:",
      "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://youtube.com https://youtube-nocookie.com https://*.wistia.net https://*.fast.wistia.net",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join('; ');

    const APP_CSP_DEV = [
      "default-src 'self' http://localhost:* ws://localhost:*",
      "script-src 'self' 'unsafe-inline' http://localhost:*",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: ol-media: https:",
      "media-src 'self' data: blob: ol-media: https:",
      "connect-src 'self' ol-media: https: http://localhost:* ws://localhost:*",
      "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://youtube.com https://youtube-nocookie.com https://*.wistia.net https://*.fast.wistia.net",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join('; ');

    session.defaultSession.webRequest.onHeadersReceived(
      (/** @type {any} */ details, /** @type {any} */ callback) => {
        if (
          mainWindow &&
          !mainWindow.isDestroyed() &&
          details.webContentsId &&
          details.webContentsId !== mainWindow.webContents.id
        ) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }

        const url = String(details.url || '');
        const responseHeaders = { ...(details.responseHeaders || {}) };

        if (
          details.resourceType === 'mainFrame' &&
          (url.startsWith('file://') ||
            url.startsWith('http://localhost:') ||
            url.startsWith('http://127.0.0.1:'))
        ) {
          responseHeaders['Content-Security-Policy'] = [
            url.startsWith('file://') ? APP_CSP_PACKAGED : APP_CSP_DEV,
          ];
          callback({ responseHeaders });
          return;
        }

        if (isAllowedHttpsHost(url, corsRewriteHostPatterns)) {
          for (const key of Object.keys(responseHeaders)) {
            const lowerKey = key.toLowerCase();
            if (
              lowerKey === 'x-frame-options' ||
              lowerKey === 'access-control-allow-origin' ||
              lowerKey === 'access-control-allow-methods' ||
              lowerKey === 'access-control-allow-headers' ||
              lowerKey === 'access-control-expose-headers' ||
              lowerKey === 'access-control-allow-credentials'
            ) {
              delete responseHeaders[key];
            }
          }

          responseHeaders['Access-Control-Allow-Origin'] = ['*'];
          responseHeaders['Access-Control-Allow-Methods'] = [
            'GET, POST, PUT, DELETE, OPTIONS, HEAD',
          ];
          responseHeaders['Access-Control-Allow-Headers'] = ['*'];
          responseHeaders['Access-Control-Expose-Headers'] = ['*'];
        }

        callback({ responseHeaders });
      }
    );

    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        restoreOrCreateMainWindow();
      } else if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        restoreOrCreateMainWindow();
      }
    });
  });
}

function runSubsystemShutdownOnce() {
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

app.on('before-quit', (/** @type {any} */ event) => {
  isZeroRendererDaemonActive = false;
  if (hasCompletedSubsystemShutdown) {
    return;
  }
  if (shutdownInProgressPromise) {
    event?.preventDefault?.();
    return;
  }
  if (
    !isQuittingAfterSync &&
    typeof launcherEngine.hasActivePostSessionWork === 'function' &&
    launcherEngine.hasActivePostSessionWork()
  ) {
    event?.preventDefault?.();
    isQuittingAfterSync = true;
    const waitPromise =
      typeof launcherEngine.waitForActivePostSessionWork === 'function'
        ? launcherEngine.waitForActivePostSessionWork(10000)
        : Promise.resolve();
    shutdownInProgressPromise = Promise.resolve(waitPromise)
      .catch(() => {})
      .finally(() => {
        runSubsystemShutdownOnce();
        shutdownInProgressPromise = null;
        app.quit();
      });
    return;
  }
  runSubsystemShutdownOnce();
});

app.on('will-quit', () => {
  try {
    flushDiagnosticLogSync();
  } catch {}
});

process.on('uncaughtException', (err) => {
  try {
    diagLog.error('main', 'Uncaught exception in main process', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    flushDiagnosticLogSync();
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try {
    diagLog.error('main', 'Unhandled promise rejection in main process', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    flushDiagnosticLogSync();
  } catch {}
});

app.on('window-all-closed', () => {
  if (
    isZeroRendererDaemonActive ||
    (launcherEngine.getRunningGames() || []).length > 0
  ) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================================================
// Modularized Storefront, Launcher & Window IPC Handlers
// ============================================================================
const { trimStoreSyncIpcMemory } = registerStoreSyncIpcHandlers({
  ipcMain,
  BrowserWindow,
  session,
  getMainWindow: () => mainWindow,
  storeSync,
  launcherEngine,
});

registerLauncherIpcHandlers({ ipcMain, launcherEngine, dialog, getMainWindow: () => mainWindow });

registerWindowAndSystemIpcHandlers({
  ipcMain,
  app,
  getMainWindow: () => mainWindow,
});

registerOfflineVaultIpcHandlers({
  ipcMain,
  offlineVaultService,
  mediaHydrationEngine,
  federator: storefrontFederator,
  getMainWindow: () => mainWindow,
  sendRendererEvent: sendOrBufferRendererEvent,
});

const SAFE_EXTERNAL_URI_SCHEME_RE =
  /^(?:https?:\/\/|steam:\/\/|goggalaxy:\/\/|com\.epicgames\.launcher:\/\/|heroic:\/\/|msxbox:(?:\/\/|\S)|ms-windows-store:(?:\/\/|\S)|xbox:(?:\/\/|\S)|ms-xbl-[a-z0-9-]+:(?:\/\/|\S))/i;

ipcMain.handle('shell:open-external', async (/** @type {any} */ _event, /** @type {unknown} */ url) => {
  if (typeof url === 'string') {
    const trimmed = url.trim();
    if (
      trimmed.length > 0 &&
      !/[\x00-\x1f\x7f]/.test(trimmed) &&
      SAFE_EXTERNAL_URI_SCHEME_RE.test(trimmed)
    ) {
      await shell.openExternal(trimmed);
      return true;
    }
  }
  return false;
});

ipcMain.handle('perf:trim-memory', async (/** @type {any} */ _event, /** @type {any} */ options) => {
  try {
    launcherEngine.trimLauncherEngineMemory?.();
  } catch {}
  try {
    offlineVaultService.trimMemory?.();
  } catch {}
  try {
    storeSync.trimStoreSyncMemory?.();
  } catch {}
  try {
    trimStoreSyncIpcMemory?.();
  } catch {}
  try {
    if (
      options?.clearDiskCache &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.webContents &&
      mainWindow.webContents.session &&
      typeof mainWindow.webContents.session.clearCache === 'function'
    ) {
      await mainWindow.webContents.session.clearCache().catch(() => {});
    }
  } catch {}
  if (!options?.passive && typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {}
  }
  return { success: true };
});

ipcMain.handle('app:get-version', () => {
  try {
    return app.getVersion();
  } catch {
    return '0.2.0';
  }
});

ipcMain.handle('app:get-info', () => {
  let version = '0.2.0';
  try {
    version = app.getVersion();
  } catch {}
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    isUpdatedLaunch: Array.isArray(process.argv) && process.argv.includes('--updated'),
  };
});

ipcMain.handle('app:check-for-updates', async () => {
  const rawRepoSlug = String(
    process.env.ONE_LAUNCHER_GITHUB_REPO || 'Space-Cadet0/One-Launcher'
  ).trim();
  const repoSlug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rawRepoSlug)
    ? rawRepoSlug
    : 'Space-Cadet0/One-Launcher';
  const defaultReleaseUrl = `https://github.com/${repoSlug}/releases`;
  let currentVersion = '0.2.0';
  try {
    currentVersion = app.getVersion();
  } catch {}

  try {
    const res = await fetch(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `OneLauncher/${currentVersion}`,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        releaseUrl: defaultReleaseUrl,
      };
    }

    const data = await res.json();
    const rawTag = String(data?.tag_name || data?.name || currentVersion).trim();
    const latestVersion = rawTag.replace(/^v/i, '').trim() || currentVersion;
    const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
    const releaseUrl = isAllowedHttpsHost(data?.html_url, ALLOWED_GITHUB_RELEASE_HOSTS)
      ? String(data.html_url).trim()
      : defaultReleaseUrl;
    const assets = Array.isArray(data?.assets) ? data.assets : [];

    const matchedAsset = selectPlatformReleaseAsset(assets, process.platform, process.arch);
    const downloadUrl =
      matchedAsset?.browser_download_url &&
      isSafeGitHubReleaseUrl(matchedAsset.browser_download_url)
        ? String(matchedAsset.browser_download_url).trim()
        : releaseUrl;
    const publishedAt = data?.published_at || undefined;

    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseUrl,
      downloadUrl,
      publishedAt,
    };
  } catch {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      releaseUrl: defaultReleaseUrl,
    };
  }
});
