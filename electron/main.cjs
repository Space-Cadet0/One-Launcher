const { app, BrowserWindow, ipcMain, session, nativeImage, Menu, Tray } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const storeSync = require('./storeSync.cjs');
const launcherEngine = require('./launcherEngine.cjs');
const { registerLauncherIpcHandlers } = require('./ipc/launcherIpcHandlers.cjs');
const { registerWindowAndSystemIpcHandlers } = require('./ipc/windowAndSystemIpcHandlers.cjs');

// Ensure videos and embedded trailers autoplay smoothly without requiring user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Prevent Chromium's OSCrypt from querying or creating "One Launcher Safe Storage" in the macOS Login Keychain,
// eliminating macOS Keychain password prompts on initial launch and across app updates.
if (process.platform === 'darwin' && app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
  app.commandLine.appendSwitch('use-mock-keychain');
}

let mainWindow = null;
let appTray = null;
let isZeroRendererDaemonActive = false;
let zeroRendererTeardownTimer = null;
let postGameExitTimer = null;

launcherEngine.setMainWindowGetter(() => mainWindow);

function getAppIconPath() {
  const ext = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const candidate = path.join(__dirname, 'assets', ext);
  if (fs.existsSync(candidate)) return candidate;
  const fallback = path.join(__dirname, '../build', ext);
  return fs.existsSync(fallback) ? fallback : undefined;
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
    mainWindow.webContents.send('launcher:hibernate-state', {
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
    const template = [
      {
        label: activeGame ? `Playing: ${activeGame.title || activeGame.gameId}` : 'One Launcher — Idle',
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
      activeGame ? `One Launcher — Playing: ${activeGame.title || activeGame.gameId}` : 'One Launcher'
    );
  } catch {}
}

function ensureAppTray() {
  if (appTray) {
    updateAppTrayMenu();
    return appTray;
  }
  if (!Tray) return null;
  try {
    const iconPath = getAppIconPath();
    let trayImg = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if (trayImg && !trayImg.isEmpty() && typeof trayImg.resize === 'function') {
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

launcherEngine.setSessionLifecycleHook((gameId, eventPayload) => {
  try {
    updateAppTrayMenu();
    const eventType = eventPayload && eventPayload.event;
    if (!eventType) return;

    const rawGameLaunchCfg = launcherEngine.getGameLaunchConfig(gameId);
    const activePlatformId = eventPayload?.session?.platformId || eventPayload?.platformId;
    const gameLaunchCfg = launcherEngine.resolvePlatformLaunchConfig(rawGameLaunchCfg, activePlatformId);
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
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('launcher:hibernate-state', {
              hibernating: false,
              inGame: true,
              mode: 'keep_open',
              gameTitle: eventPayload.title,
            });
          } catch {}
        }
      } else if (mode === 'minimize_taskbar') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('launcher:hibernate-state', {
              hibernating: false,
              inGame: true,
              mode: 'minimize_taskbar',
              gameTitle: eventPayload.title,
            });
          } catch {}
          mainWindow.minimize();
        }
      } else if (mode === 'hide_tray_hibernate') {
        ensureAppTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('launcher:hibernate-state', {
              hibernating: true,
              inGame: true,
              mode: 'hide_tray_hibernate',
              gameTitle: eventPayload.title,
            });
            mainWindow.webContents.setAudioMuted(true);
            mainWindow.webContents.setBackgroundThrottling(true);
          } catch {}
          mainWindow.hide();
        }
        launcherEngine.trimLauncherEngineMemory();
      } else if (mode === 'zero_renderer_daemon') {
        isZeroRendererDaemonActive = true;
        ensureAppTray();
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
          const hasActiveDownloads = (launcherEngine.getDownloadQueue() || []).some((t) =>
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
            mainWindow.webContents.send('launcher:hibernate-state', {
              hibernating: false,
              inGame: false,
            });
          } catch {}
        }
      } else {
        // Default: 'restore_window'
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('launcher:hibernate-state', {
              hibernating: false,
              inGame: false,
            });
          } catch {}
        }
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
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true,
      webSecurity: true, // Secure webSecurity enabled; cross-origin requests handled via IPC and onHeadersReceived
    },
  });

  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);

    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !mainWindow || mainWindow.isDestroyed()) return;
      const key = String(input.key || '').toLowerCase();
      const ctrlOrCmd = Boolean(input.control || input.meta);

      if (input.key === 'F11') {
        event.preventDefault();
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      } else if (input.key === 'F12' || (ctrlOrCmd && input.shift && key === 'i')) {
        event.preventDefault();
        mainWindow.webContents.toggleDevTools();
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
    });
  }

  const distHtml = path.join(__dirname, '../dist/index.html');
  if (app.isPackaged || process.env.NODE_ENV === 'production' || !process.env.ELECTRON_START_URL) {
    if (fs.existsSync(distHtml)) {
      mainWindow.loadFile(distHtml);
    } else {
      mainWindow.loadURL('http://localhost:3000').catch(() => {
        setTimeout(() => mainWindow.loadURL('http://localhost:3000'), 1000);
      });
    }
  } else {
    mainWindow.loadURL('http://localhost:3000').catch(() => {
      if (fs.existsSync(distHtml)) {
        mainWindow.loadFile(distHtml);
      }
    });
  }

  // Ensure links and popups (e.g. YouTube "Watch on YouTube") open in default web browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-changed', true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreen-changed', false);
    }
  });

  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', true);
    }
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', false);
    }
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
      if (process.platform === 'win32') {
        app.commandLine.appendSwitch(
          'disable-features',
          'CalculateNativeWinOcclusion,SpareRendererForSitePerProcess,BackForwardCache'
        );
      } else {
        app.commandLine.appendSwitch(
          'disable-features',
          'SpareRendererForSitePerProcess,BackForwardCache'
        );
      }
    }
  } catch {
    // Ignore if commandLine is unavailable in mocked test environments
  }

  app.whenReady().then(() => {
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
        console.warn('Failed to set macOS dock icon:', err.message);
      }
    }
    // Intercept YouTube and external video embed requests to allow playback from file:// origins
    const embedFilters = [
      '*://*.youtube.com/*',
      '*://youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://youtube-nocookie.com/*',
      '*://*.wistia.net/*',
      '*://*.fast.wistia.net/*',
    ];

    // Store API domains requiring CORS headers for renderer fetch/axios calls with webSecurity enabled
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

    const STANDARD_CHROME_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: beforeSendFilters },
      (details, callback) => {
        // Never mutate headers for storefront sign-in popup windows (authWindow)
        if (mainWindow && !mainWindow.isDestroyed() && details.webContentsId && details.webContentsId !== mainWindow.webContents.id) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }

        const url = details.url || '';

        // Crucial: Only rewrite headers for the frame document request itself (subFrame / mainFrame).
        // Preserving original headers for XHR/fetch/chunks prevents YouTube's internal player API from stalling at 0:00.
        if (
          (details.resourceType === 'subFrame' || details.resourceType === 'mainFrame') &&
          embedFilters.some((f) => {
            const host = f.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/\*$/, '');
            return url.includes(host);
          })
        ) {
          delete details.requestHeaders['origin'];
          delete details.requestHeaders['Origin'];
          delete details.requestHeaders['referer'];
          delete details.requestHeaders['Referer'];
          details.requestHeaders['Origin'] = 'https://www.gog.com';
          details.requestHeaders['Referer'] = 'https://www.gog.com/';
        }

        // Steam age-gate & English language cookies for store.steampowered.com only (never api.steampowered.com or login.steampowered.com)
        if (url.includes('store.steampowered.com')) {
          const existingCookie = details.requestHeaders['Cookie'] || details.requestHeaders['cookie'] || '';
          delete details.requestHeaders['cookie'];
          delete details.requestHeaders['accept-language'];
          details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
          const steamMature = 'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1';
          if (!existingCookie) {
            details.requestHeaders['Cookie'] = steamMature;
          } else {
            let updated = existingCookie.replace(/Steam_Language=[a-zA-Z_-]+/gi, 'Steam_Language=english');
            if (!/Steam_Language=/i.test(updated)) updated = `Steam_Language=english; ${updated}`;
            if (!updated.includes('birthtime=')) updated += '; birthtime=568022401';
            if (!updated.includes('mature_content=')) updated += '; mature_content=1';
            if (!updated.includes('wants_mature_content=')) updated += '; wants_mature_content=1';
            details.requestHeaders['Cookie'] = updated;
          }
        }

        // Lutris bot-protection: ensure standard Chrome User-Agent
        if (url.includes('lutris.net')) {
          details.requestHeaders['User-Agent'] = STANDARD_CHROME_UA;
        }

        callback({ requestHeaders: details.requestHeaders });
      }
    );

    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [...embedFilters, ...storeApiFilters] },
      (details, callback) => {
        // Never overwrite CORS headers for storefront sign-in popup windows (authWindow).
        // Overwriting Access-Control-Allow-Origin to '*' on api.steampowered.com or login.steampowered.com
        // creates duplicate CORS headers and breaks credentialed QR-code & JWT login requests.
        if (mainWindow && !mainWindow.isDestroyed() && details.webContentsId && details.webContentsId !== mainWindow.webContents.id) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }

        const responseHeaders = { ...details.responseHeaders };
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

        // Provide clean, single-valued permissive CORS headers for mainWindow renderer calls and embeds
        responseHeaders['Access-Control-Allow-Origin'] = ['*'];
        responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS, HEAD'];
        responseHeaders['Access-Control-Allow-Headers'] = ['*'];
        responseHeaders['Access-Control-Expose-Headers'] = ['*'];

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

app.on('before-quit', () => {
  isZeroRendererDaemonActive = false;
  try {
    launcherEngine.shutdownLauncherEngine();
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

// Storefront Native OAuth URLs matching Playnite & Heroic
const STORE_OAUTH_URLS = {
  steam: {
    url: 'https://steamcommunity.com/login/home/?goto=%2Fmy%2Fgames%2F%3Ftab%3Dall',
    successPrefix: 'https://steamcommunity.com/profiles/',
    width: 620,
    height: 740,
  },
  gog: {
    url: 'https://login.gog.com/auth?client_id=46899977096215655&layout=client2&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code',
    successPrefix: 'https://embed.gog.com/on_login_success',
    width: 500,
    height: 680,
  },
  epic: {
    url: 'https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode',
    successPrefix: 'https://localhost/launcher/authorized',
    width: 540,
    height: 720,
  },
  xbox: {
    url: 'https://login.live.com/oauth20_authorize.srf?client_id=00000000402b5328&response_type=code&scope=service::user.auth.xboxlive.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf',
    successPrefix: 'https://login.live.com/oauth20_desktop.srf',
    width: 500,
    height: 680,
  },
};

/**
 * Process OAuth code exchange and full library entitlement synchronization
 */
async function processStoreAuth(storefrontId, code) {
  let accountName = 'Verified User';
  let avatarUrl = undefined;
  let games = [];
  let tokenData = null;

  try {
    launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
    if (storefrontId === 'gog') {
      tokenData = await storeSync.exchangeGogCode(code);
      const account = await storeSync.fetchGogAccount(tokenData.access_token);
      accountName = account.username || 'GOG User';
      avatarUrl = account.avatarUrl;
      games = await storeSync.fetchGogOwnedGames(tokenData.access_token, accountName, account.userId);
    } else if (storefrontId === 'epic') {
      tokenData = await storeSync.exchangeEpicCode(code);
      accountName = tokenData.displayName || tokenData.account_id || 'Epic Games User';
      games = await storeSync.fetchEpicOwnedGames(tokenData.access_token, tokenData.account_id);
    }

    return {
      success: true,
      code,
      storefrontId,
      accountName,
      avatarUrl,
      games,
      tokenData,
    };
  } catch (err) {
    console.warn(`Post-login sync warning for ${storefrontId}:`, err.message);
    return {
      success: true,
      code,
      storefrontId,
      accountName,
      avatarUrl,
      games: [],
      syncError: err.message,
      tokenData,
    };
  }
}

let inFlightEpicAuthRecovery = null;

/**
 * Recover an expired Epic Games OAuth session:
 * 1. Silent cookie refresh via hidden BrowserWindow in `persist:storefront_auth`
 * 2. Interactive Epic OAuth BrowserWindow fallback when `allowInteractiveAuth === true`
 */
async function recoverEpicAuthSession({ allowInteractiveAuth = false } = {}) {
  if (!allowInteractiveAuth && launcherEngine?.isStoreDisconnectedTombstoned?.('epic')) {
    return null;
  }
  if (inFlightEpicAuthRecovery) {
    return inFlightEpicAuthRecovery;
  }

  inFlightEpicAuthRecovery = (async () => {
    const cleanUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const silentRedirectUrl =
      'https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code';

    const extractEpicAuthCodeFromWindow = (win, targetUrl, timeoutMs, interactive) =>
      new Promise((resolveCode) => {
        if (!BrowserWindow) {
          resolveCode(null);
          return;
        }
        let settled = false;
        let timer = null;

        const finish = (code) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          try {
            if (typeof storeSync.destroyScraperWindowCleanly === 'function' && !interactive) {
              storeSync.destroyScraperWindowCleanly(win);
            } else if (win && !win.isDestroyed()) {
              win.close();
              if (!win.isDestroyed()) win.destroy();
            }
          } catch {}
          resolveCode(code || null);
        };

        if (timeoutMs > 0) {
          timer = setTimeout(() => finish(null), timeoutMs);
        }

        const checkUrl = (url) => {
          if (!url || settled) return false;
          if (url.includes('localhost/launcher/authorized')) {
            try {
              const parsed = new URL(url);
              const code = parsed.searchParams.get('code');
              if (code && /^[a-fA-F0-9]{32}$/.test(code)) {
                finish(code);
                return true;
              }
            } catch {}
          }
          return false;
        };

        const checkBodyForCode = async () => {
          if (settled || !win || win.isDestroyed()) return;
          const currentUrl = win.webContents.getURL() || '';
          if (checkUrl(currentUrl)) return;
          if (!interactive && (currentUrl.includes('/id/login') || currentUrl.includes('/login'))) {
            finish(null);
            return;
          }
          if (currentUrl.includes('/id/api/redirect')) {
            try {
              const bodyText = await win.webContents.executeJavaScript(
                'document.body ? document.body.innerText : ""'
              );
              if (bodyText) {
                const match =
                  String(bodyText).match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i) ||
                  String(bodyText).match(/\b([a-fA-F0-9]{32})\b/);
                if (match && match[1]) {
                  finish(match[1]);
                  return;
                }
                if (
                  !interactive &&
                  /"authorizationCode"\s*:\s*null/i.test(String(bodyText))
                ) {
                  finish(null);
                  return;
                }
              }
            } catch {}
          }
        };

        win.webContents.on('will-prevent-unload', (event) => {
          event.preventDefault();
        });
        win.webContents.on('will-redirect', (_e, url) => checkUrl(url));
        win.webContents.on('will-navigate', (_e, url) => checkUrl(url));
        win.webContents.on('did-navigate', async (_e, url) => {
          if (!checkUrl(url)) {
            await checkBodyForCode();
          }
        });
        win.webContents.on('did-finish-load', async () => {
          await checkBodyForCode();
        });
        win.on('closed', () => finish(null));

        try {
          win.loadURL(targetUrl).catch(() => {
            if (!interactive) finish(null);
          });
        } catch {
          finish(null);
        }
      });

    try {
      // Step 1: Silent cookie refresh in persist:storefront_auth
      let authCode = null;
      try {
        const silentWin = new BrowserWindow({
          width: 540,
          height: 720,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: 'persist:storefront_auth',
            userAgent: cleanUA,
          },
        });
        authCode = await extractEpicAuthCodeFromWindow(
          silentWin,
          silentRedirectUrl,
          6000,
          false
        );
      } catch {}

      // Step 2: Interactive sign-in window fallback when allowInteractiveAuth === true
      if (!authCode && allowInteractiveAuth) {
        try {
          const parentWin =
            mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const interactiveWin = new BrowserWindow({
            width: STORE_OAUTH_URLS.epic.width || 540,
            height: STORE_OAUTH_URLS.epic.height || 720,
            parent: parentWin,
            autoHideMenuBar: true,
            show: true,
            title: 'Sign in to Epic Games — One Launcher',
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              partition: 'persist:storefront_auth',
              userAgent: cleanUA,
            },
          });
          authCode = await extractEpicAuthCodeFromWindow(
            interactiveWin,
            STORE_OAUTH_URLS.epic.url,
            180000,
            true
          );
        } catch {}
      }

      if (authCode) {
        const tokenData = await storeSync.exchangeEpicCode(authCode);
        if (tokenData && tokenData.access_token) {
          storeSync.saveTokens('epic', tokenData);
          return tokenData;
        }
      }
    } catch (err) {
      console.warn('[recoverEpicAuthSession] warning:', err.message);
    }

    return null;
  })().finally(() => {
    inFlightEpicAuthRecovery = null;
  });

  return inFlightEpicAuthRecovery;
}

if (typeof launcherEngine.setEpicAuthRecoveryHook === 'function') {
  launcherEngine.setEpicAuthRecoveryHook(recoverEpicAuthSession);
}

const STEAM_LOCAL_SCAN_TTL_MS = 15000;
let cachedLocalSteamPlaytimes = null;
let cachedLocalSteamPlaytimesAt = 0;
let cachedLocalSteamAchievements = null;
let cachedLocalSteamAchievementsAt = 0;
const steamLocalVdfMtimeCache = new Map();
const steamLocalAchFileMtimeCache = new Map();

/**
 * Asynchronously read local Steam playtimes (Playtime + PlaytimeDisconnected) from localconfig.vdf
 * with 15s TTL + per-file mtimeMs caching so unchanged VDF files are not re-parsed.
 */
async function readLocalSteamPlaytimes(options = {}) {
  if (
    !options?.force &&
    cachedLocalSteamPlaytimes &&
    Date.now() - cachedLocalSteamPlaytimesAt < STEAM_LOCAL_SCAN_TTL_MS
  ) {
    return { ...cachedLocalSteamPlaytimes };
  }
  const playtimes = {};
  try {
    const home = os.homedir();
    const steamUserDirs = [
      path.join(home, 'Library/Application Support/Steam/userdata'),
      path.join(home, '.local/share/Steam/userdata'),
      path.join(home, '.steam/steam/userdata'),
      'C:\\Program Files (x86)\\Steam\\userdata',
    ];
    for (const base of steamUserDirs) {
      let userFolders = [];
      try {
        userFolders = await fs.promises.readdir(base);
      } catch {
        continue;
      }
      for (const u of userFolders) {
        const vdfPath = path.join(base, u, 'config/localconfig.vdf');
        try {
          const st = await fs.promises.stat(vdfPath);
          const prev = steamLocalVdfMtimeCache.get(vdfPath);
          let filePlaytimes;
          if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
            filePlaytimes = prev.playtimes;
          } else {
            filePlaytimes = {};
            const vdf = await fs.promises.readFile(vdfPath, 'utf8');
            const regex = /"(\d+)"\s*\{([^{}]+)\}/g;
            let m;
            while ((m = regex.exec(vdf)) !== null) {
              const appId = Number(m[1]);
              const body = m[2];
              if (!appId || (!body.includes('"Playtime"') && !body.includes('"LastPlayed"'))) continue;
              const ptMatch = body.match(/"Playtime"\s+"(\d+)"/i);
              const ptDiscMatch = body.match(/"PlaytimeDisconnected"\s+"(\d+)"/i);
              const lpMatch = body.match(/"LastPlayed"\s+"(\d+)"/i);
              const totalMin = (ptMatch ? Number(ptMatch[1]) : 0) + (ptDiscMatch ? Number(ptDiscMatch[1]) : 0);
              const lpEpoch = lpMatch ? Number(lpMatch[1]) : 0;
              if (!filePlaytimes[appId] || totalMin >= filePlaytimes[appId].playtimeMinutes) {
                filePlaytimes[appId] = { playtimeMinutes: totalMin, lastPlayedEpoch: lpEpoch };
              }
            }
            steamLocalVdfMtimeCache.set(vdfPath, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              playtimes: filePlaytimes,
            });
          }
          for (const [appIdKey, ptObj] of Object.entries(filePlaytimes)) {
            const appIdNum = Number(appIdKey);
            if (!playtimes[appIdNum] || ptObj.playtimeMinutes >= playtimes[appIdNum].playtimeMinutes) {
              playtimes[appIdNum] = ptObj;
            }
          }
        } catch {}
      }
    }
  } catch {}
  cachedLocalSteamPlaytimes = playtimes;
  cachedLocalSteamPlaytimesAt = Date.now();
  return { ...playtimes };
}

/**
 * Asynchronously scan local Steam client userdata librarycache for achievement counts
 * with 15s TTL + per-file mtimeMs caching so unchanged librarycache JSON files are not re-read.
 */
async function scanLocalSteamAchievements(options = {}) {
  if (
    !options?.force &&
    cachedLocalSteamAchievements &&
    Date.now() - cachedLocalSteamAchievementsAt < STEAM_LOCAL_SCAN_TTL_MS
  ) {
    return { ...cachedLocalSteamAchievements };
  }
  const achievements = {};
  try {
    const home = os.homedir();
    const steamUserDirs = [
      path.join(home, 'Library/Application Support/Steam/userdata'),
      path.join(home, '.local/share/Steam/userdata'),
      path.join(home, '.steam/steam/userdata'),
      'C:\\Program Files (x86)\\Steam\\userdata',
    ];

    for (const base of steamUserDirs) {
      let userFolders = [];
      try {
        userFolders = await fs.promises.readdir(base);
      } catch {
        continue;
      }
      for (const u of userFolders) {
        const lcDir = path.join(base, u, 'config/librarycache');
        let files = [];
        try {
          files = await fs.promises.readdir(lcDir);
        } catch {
          continue;
        }

        // 1. Check achievement_progress.json
        const progressFile = path.join(lcDir, 'achievement_progress.json');
        if (files.includes('achievement_progress.json')) {
          try {
            const st = await fs.promises.stat(progressFile);
            const prevProg = steamLocalAchFileMtimeCache.get(progressFile);
            let progMap;
            if (prevProg && prevProg.mtimeMs === st.mtimeMs && prevProg.size === st.size) {
              progMap = prevProg.data;
            } else {
              progMap = {};
              const raw = JSON.parse(await fs.promises.readFile(progressFile, 'utf8'));
              if (Array.isArray(raw?.mapCache)) {
                for (const [appId, data] of raw.mapCache) {
                  if (data && typeof data.unlocked === 'number' && typeof data.total === 'number' && data.total > 0) {
                    const pct = Math.round((data.unlocked / data.total) * 100);
                    progMap[appId] = {
                      unlocked: data.unlocked,
                      total: data.total,
                      percentage: pct,
                      isMastered: pct === 100,
                    };
                  }
                }
              }
              steamLocalAchFileMtimeCache.set(progressFile, {
                mtimeMs: st.mtimeMs,
                size: st.size,
                data: progMap,
              });
            }
            Object.assign(achievements, progMap);
          } catch {}
        }

        // 2. Scan all <appId>.json in librarycache
        for (const file of files) {
          const m = file.match(/^(\d+)\.json$/);
          if (!m) continue;
          const appId = parseInt(m[1], 10);
          const fullAchPath = path.join(lcDir, file);
          try {
            const st = await fs.promises.stat(fullAchPath);
            const prevAch = steamLocalAchFileMtimeCache.get(fullAchPath);
            let parsedCounts = null;
            if (prevAch && prevAch.mtimeMs === st.mtimeMs && prevAch.size === st.size) {
              parsedCounts = prevAch.data;
            } else {
              const content = await fs.promises.readFile(fullAchPath, 'utf8');
              const mTotal = content.match(/"nTotal"\s*:\s*(\d+)/);
              const mAchieved = content.match(/"nAchieved"\s*:\s*(\d+)/);
              if (mTotal || mAchieved) {
                parsedCounts = {
                  total: mTotal ? parseInt(mTotal[1], 10) : 0,
                  unlocked: mAchieved ? parseInt(mAchieved[1], 10) : 0,
                };
              }
              if (steamLocalAchFileMtimeCache.size > 5000) {
                const oldestKey = steamLocalAchFileMtimeCache.keys().next().value;
                if (oldestKey !== undefined) steamLocalAchFileMtimeCache.delete(oldestKey);
              }
              steamLocalAchFileMtimeCache.set(fullAchPath, {
                mtimeMs: st.mtimeMs,
                size: st.size,
                data: parsedCounts,
              });
            }
            if (parsedCounts && (parsedCounts.total > 0 || parsedCounts.unlocked > 0)) {
              const { total, unlocked } = parsedCounts;
              if (!achievements[appId] || unlocked >= achievements[appId].unlocked) {
                const finalTotal = total > 0 ? total : (achievements[appId]?.total || unlocked);
                const pct = finalTotal > 0 ? Math.round((unlocked / finalTotal) * 100) : 0;
                achievements[appId] = {
                  unlocked,
                  total: finalTotal,
                  percentage: pct,
                  isMastered: finalTotal > 0 && pct === 100,
                };
              }
            }
          } catch {}
        }
      }
    }
  } catch {}
  cachedLocalSteamAchievements = achievements;
  cachedLocalSteamAchievementsAt = Date.now();
  return { ...achievements };
}

/**
 * Fetch batch Steam achievement progress using IPlayerService/GetAchievementsProgress/v1 + local Steam cache
 */
async function fetchSteamBatchAchievements(webapiToken, steamId, appIds = []) {
  const achievements = await scanLocalSteamAchievements();
  if (!webapiToken || !steamId || !Array.isArray(appIds) || appIds.length === 0) {
    return achievements;
  }

  const cleanIds = Array.from(new Set(appIds.map((id) => Number(id)).filter((id) => id > 0)));
  const CHUNK_SIZE = 100;
  for (let i = 0; i < cleanIds.length; i += CHUNK_SIZE) {
    const chunk = cleanIds.slice(i, i + CHUNK_SIZE);
    const appIdParams = chunk.map((id, idx) => `appids[${idx}]=${encodeURIComponent(String(id))}`).join('&');
    const url = `https://api.steampowered.com/IPlayerService/GetAchievementsProgress/v1/?access_token=${encodeURIComponent(
      webapiToken
    )}&steamid=${encodeURIComponent(steamId)}&language=english&${appIdParams}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const list = json?.response?.achievement_progress;
        if (Array.isArray(list)) {
          for (const item of list) {
            const appId = Number(item.appid);
            const total = Number(item.total || 0);
            const unlocked = Number(item.unlocked || 0);
            if (appId > 0 && total > 0) {
              const prev = achievements[appId];
              const bestUnlocked = prev ? Math.max(unlocked, Number(prev.unlocked || 0)) : unlocked;
              const bestTotal = prev ? Math.max(total, Number(prev.total || 0)) : total;
              const pct = bestTotal > 0 ? Math.round((bestUnlocked / bestTotal) * 100) : 0;
              achievements[appId] = {
                unlocked: bestUnlocked,
                total: bestTotal,
                percentage: pct,
                isMastered: Boolean(item.all_unlocked) || (bestTotal > 0 && bestUnlocked >= bestTotal),
              };
            }
          }
        }
      }
    } catch {}
  }

  return achievements;
}

/**
 * Fetch batch Steam store asset hashes using public IStoreBrowseService/GetItems/v1
 */
async function fetchSteamStoreBrowseItemsMap(appIds = []) {
  const storeItems = {};
  if (!Array.isArray(appIds) || appIds.length === 0) return storeItems;
  const cleanIds = Array.from(new Set(appIds.map((id) => Number(id)).filter((id) => id > 0)));
  const CHUNK_SIZE = 100;
  for (let i = 0; i < cleanIds.length; i += CHUNK_SIZE) {
    const chunk = cleanIds.slice(i, i + CHUNK_SIZE);
    const inputJson = JSON.stringify({
      ids: chunk.map((appid) => ({ appid })),
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true },
    });
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(
      inputJson
    )}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const items = json?.response?.store_items;
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item?.appid && item?.assets) {
              storeItems[String(item.appid)] = item.assets;
            }
          }
        }
      }
    } catch {}
  }
  return storeItems;
}

/**
 * Convert Steam web gameslist JSON into CanonicalGame objects
 */
async function parseSteamGamesListJson(rawJsonStr, steamId, personaName, avatarUrl, existingGames = []) {
  const parsed = typeof rawJsonStr === 'string' ? JSON.parse(rawJsonStr) : rawJsonStr;
  const rgGames = Array.isArray(parsed?.rgGames)
    ? parsed.rgGames
    : Array.isArray(parsed?.games)
      ? parsed.games
      : Array.isArray(parsed)
        ? parsed
        : [];
  const storeItems = (parsed && typeof parsed.storeItems === 'object' && parsed.storeItems) || {};
  const existingByAppId = new Map();
  if (Array.isArray(existingGames)) {
    for (const eg of existingGames) {
      if (eg && eg.steamAppId) {
        existingByAppId.set(Number(eg.steamAppId), eg);
      }
    }
  }
  const resolvedName = parsed?.strProfileName || personaName || 'Steam User';
  const [localPlaytimes, localAchievements] = await Promise.all([
    readLocalSteamPlaytimes(),
    scanLocalSteamAchievements(),
  ]);
  const games = [];
  const suppressedItems = [];

  for (const g of rgGames) {
    const appId = Number(g.appid);
    const title = (g.name || '').trim();
    if (!appId || !title) continue;

    const cloudPlaytime = Number(g.playtime_forever || 0) + Number(g.playtime_disconnected || 0);
    const localPt = localPlaytimes[appId];
    const playtimeMinutes = Math.max(cloudPlaytime, localPt ? localPt.playtimeMinutes : 0);
    const lastPlayedEpoch = Number(g.rtime_last_played || (localPt ? localPt.lastPlayedEpoch : 0) || 0);
    const lastPlayed = lastPlayedEpoch > 0 ? new Date(lastPlayedEpoch * 1000).toISOString() : undefined;
    const ach = localAchievements[appId];

    const si = storeItems[String(appId)];
    const existingGame = existingByAppId.get(appId);
    const assetFormat = (si && si.asset_url_format) || `steam/apps/${appId}/\${FILENAME}`;
    const buildAssetUrl = (filename) =>
      `https://shared.akamai.steamstatic.com/store_item_assets/${assetFormat.replace('${FILENAME}', filename)}`;

    const headerFile = (si && si.header) || 'header.jpg';
    const capsuleFile =
      (si && (si.library_capsule || si.library_capsule_2x)) ||
      (typeof g.capsule_filename === 'string' && g.capsule_filename.includes('/')
        ? g.capsule_filename
        : 'library_600x900.jpg');

    const rawIconHash =
      (si && si.community_icon) ||
      (typeof g.img_icon_url === 'string' && g.img_icon_url.trim()) ||
      '';
    const resolvedIconUrl = rawIconHash
      ? rawIconHash.startsWith('http')
        ? rawIconHash
        : `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appId}/${
            rawIconHash.endsWith('.jpg') ? rawIconHash : `${rawIconHash}.jpg`
          }`
      : existingGame?.iconUrl;

    const builtHeader = buildAssetUrl(headerFile);
    const builtCapsule = buildAssetUrl(capsuleFile);
    const finalHeader =
      !si &&
      existingGame?.headerImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\//i.test(existingGame.headerImage)
        ? existingGame.headerImage
        : builtHeader;
    const finalCapsule =
      !si &&
      existingGame?.capsuleImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\//i.test(existingGame.capsuleImage) &&
      !existingGame.capsuleImage.includes('184x69')
        ? existingGame.capsuleImage
        : builtCapsule;

    const gameObj = {
      id: `steam-${appId}`,
      title,
      originalStoreTitle: title,
      sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
      steamAppId: appId,
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: String(appId),
          originalTitle: title,
          installed: false,
          playtimeMinutes,
          lastPlayed,
          achievements: ach
            ? {
                unlocked: ach.unlocked,
                total: ach.total,
                percentage: ach.percentage,
                isMastered: ach.isMastered,
              }
            : undefined,
        },
      ],
      headerImage: finalHeader,
      capsuleImage: finalCapsule,
      iconUrl: resolvedIconUrl,
      shortDescription: '',
      releaseDate: 'Released',
      developers: [],
      publishers: [],
      genres: [],
      tags: ['Steam'],
    };

    const nonGameReason =
      typeof storeSync.classifyNonGameStorefrontItem === 'function'
        ? storeSync.classifyNonGameStorefrontItem({
            title,
            platformId: 'steam',
            platformGameId: String(appId),
            isDlc: false,
          })
        : null;

    if (nonGameReason) {
      suppressedItems.push({
        id: `steam-${appId}`,
        rawTitle: title,
        platformId: 'steam',
        platformGameId: String(appId),
        reason: nonGameReason,
        reasonCategory: 'non_game_filter',
        rawGame: gameObj,
      });
      continue;
    }

    games.push(gameObj);
  }

  return {
    accountName: resolvedName,
    accountId: steamId,
    avatarUrl,
    games,
    suppressedItems,
  };
}

/**
 * Handle Native Storefront Authentication with interceptors
 */
ipcMain.handle('auth:storefront', async (_event, storefrontId) => {
  const config = STORE_OAUTH_URLS[storefrontId];
  if (!config) {
    return { success: false, error: `Unsupported storefront: ${storefrontId}` };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let extractingSteam = false;

    const cleanBrowserUA = session.defaultSession
      .getUserAgent()
      .replace(/\s+OneLauncher\/[^\s]+/gi, '')
      .replace(/\s+one-launcher\/[^\s]+/gi, '')
      .replace(/\s+Electron\/[^\s]+/gi, '');

    const authWindow = new BrowserWindow({
      width: config.width,
      height: config.height,
      parent: mainWindow,
      modal: false,
      closable: true,
      minimizable: true,
      resizable: true,
      autoHideMenuBar: true,
      show: true,
      title: `Sign In - ${storefrontId.toUpperCase()}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:storefront_auth',
        userAgent: cleanBrowserUA,
      },
    });

    const safelyCloseAuthWindow = () => {
      try {
        if (!authWindow.isDestroyed()) {
          authWindow.close();
        }
        if (!authWindow.isDestroyed()) {
          authWindow.destroy();
        }
      } catch {}
    };

    // Never allow a remote storefront page's beforeunload listener to block closing the window
    authWindow.webContents.on('will-prevent-unload', (event) => {
      event.preventDefault();
    });

    const handleAuthCodeFound = async (code) => {
      if (!code || resolved) return;
      resolved = true;
      safelyCloseAuthWindow();
      const syncResult = await processStoreAuth(storefrontId, code);
      resolve(syncResult);
    };

    const checkUrlForCode = (url) => {
      if (!url || resolved) return;

      // GOG intercept: https://embed.gog.com/on_login_success?origin=client&code=...
      if (storefrontId === 'gog' && url.includes('on_login_success')) {
        try {
          const parsed = new URL(url);
          const code = parsed.searchParams.get('code');
          if (code) {
            handleAuthCodeFound(code);
            return;
          }
        } catch {}
      }

      // Epic intercept: https://localhost/launcher/authorized?code=...
      if (storefrontId === 'epic') {
        if (url.includes('localhost/launcher/authorized')) {
          try {
            const parsed = new URL(url);
            const code = parsed.searchParams.get('code');
            if (code) {
              handleAuthCodeFound(code);
              return;
            }
          } catch {}
        }
      }

      // Xbox intercept: https://login.live.com/oauth20_desktop.srf?code=...
      if (storefrontId === 'xbox' && url.includes('oauth20_desktop.srf')) {
        try {
          const parsed = new URL(url);
          const code = parsed.searchParams.get('code');
          if (code) {
            handleAuthCodeFound(code);
            return;
          }
        } catch {}
      }
    };

    const tryExtractSteamGames = async () => {
      if (resolved || extractingSteam || authWindow.isDestroyed() || storefrontId !== 'steam') return;
      const currentUrl = authWindow.webContents.getURL();
      if (!currentUrl || currentUrl.includes('/login') || !currentUrl.includes('steamcommunity.com')) {
        return;
      }

      extractingSteam = true;
      try {
        const steamData = await authWindow.webContents.executeJavaScript(`
          (async function() {
            for (let attempt = 0; attempt < 10; attempt++) {
              // 1. Check Steam's new SSR architecture (window.SSR / window.UserConfig / #valve-ssr-data)
              let ssr = window.SSR;
              let userCfg = window.UserConfig;
              if (!ssr) {
                const ssrScript = document.getElementById('valve-ssr-data');
                if (ssrScript && ssrScript.textContent) {
                  try {
                    const parsedSsr = JSON.parse(ssrScript.textContent);
                    ssr = parsedSsr;
                    userCfg = userCfg || parsedSsr.UserConfig;
                  } catch (e) {}
                }
              }

              let steamId = userCfg && userCfg.steamid ? String(userCfg.steamid) : undefined;
              let personaName = userCfg && userCfg.account_name ? String(userCfg.account_name) : undefined;
              let avatarUrl = undefined;
              let webApiToken = undefined;
              let rgGames = null;
              const storeItems = {};

              if (ssr) {
                const loaderData = Array.isArray(ssr.loaderData) ? ssr.loaderData : [];
                for (const item of loaderData) {
                  if (!item) continue;
                  try {
                    const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                    if (parsed.steamid && !steamId) steamId = String(parsed.steamid);
                    if (parsed.strWebAPIToken && !webApiToken) webApiToken = String(parsed.strWebAPIToken);
                    const pub = parsed.currentUserLinkDetails && parsed.currentUserLinkDetails.public_data;
                    const priv = parsed.currentUserLinkDetails && parsed.currentUserLinkDetails.private_data;
                    if (pub) {
                      if (pub.persona_name) personaName = pub.persona_name;
                      if (pub.steamid && !steamId) steamId = String(pub.steamid);
                      const digest = pub.sha_digest_avatar && (
                        Array.isArray(pub.sha_digest_avatar.v)
                          ? pub.sha_digest_avatar.v
                          : Array.isArray(pub.sha_digest_avatar)
                            ? pub.sha_digest_avatar
                            : null
                      );
                      if (digest && digest.length === 20) {
                        const hex = digest.map(b => Number(b).toString(16).padStart(2, '0')).join('');
                        avatarUrl = 'https://avatars.steamstatic.com/' + hex + '_full.jpg';
                      }
                    }
                    if (!personaName && priv && priv.account_name) {
                      personaName = priv.account_name;
                    }
                  } catch (e) {}
                }

                const rawQueryData = ssr.renderContext && ssr.renderContext.queryData;
                if (rawQueryData) {
                  try {
                    const qd = typeof rawQueryData === 'string' ? JSON.parse(rawQueryData) : rawQueryData;
                    const queries = Array.isArray(qd && qd.queries) ? qd.queries : [];
                    for (const q of queries) {
                      const key = Array.isArray(q && q.queryKey) ? q.queryKey : [];
                      const data = q && q.state ? q.state.data : undefined;
                      if (!data) continue;
                      if (key[0] === 'OwnedGames' && Array.isArray(data)) {
                        rgGames = data;
                      } else if (key[0] === 'PlayerLinkDetails' && data.public_data) {
                        if (data.public_data.persona_name && !personaName) personaName = data.public_data.persona_name;
                        if (data.public_data.steamid && !steamId) steamId = String(data.public_data.steamid);
                      } else if (key[0] === 'StoreItem' && typeof key[1] === 'string' && key[1].startsWith('app_')) {
                        const appId = key[1].replace('app_', '');
                        storeItems[appId] = data;
                      }
                    }
                  } catch (e) {}
                }

                if ((!rgGames || rgGames.length === 0) && webApiToken && steamId) {
                  try {
                    const apiRes = await fetch(
                      'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?access_token=' +
                        encodeURIComponent(webApiToken) +
                        '&steamid=' +
                        encodeURIComponent(steamId) +
                        '&include_appinfo=1&include_played_free_games=1&include_free_sub=0'
                    );
                    if (apiRes.ok) {
                      const apiJson = await apiRes.json();
                      if (Array.isArray(apiJson?.response?.games)) {
                        rgGames = apiJson.response.games;
                      }
                    }
                  } catch (e) {}
                }

                if (Array.isArray(rgGames)) {
                  return {
                    gameslistJson: JSON.stringify({
                      rgGames,
                      strProfileName: personaName,
                      storeItems,
                    }),
                    avatarUrl,
                    steamId,
                    personaName,
                    webApiToken,
                  };
                }
              }

              // 2. Check legacy #gameslist_config DOM element
              const el = document.getElementById('gameslist_config');
              const appConfig = document.getElementById('application_config') || document.getElementById('webui_config');
              let userInfo = null;
              try {
                if (appConfig && appConfig.dataset && appConfig.dataset.userinfo) {
                  userInfo = JSON.parse(appConfig.dataset.userinfo);
                }
              } catch (e) {}

              const avatarEl = document.querySelector('.playerAvatar img, .user_avatar img');
              const html = document.documentElement ? document.documentElement.innerHTML : '';
              const steamIdMatch = html.match(/g_steamID\\s*=\\s*"(\\d{17})"/);
              const resolvedSteamId = steamId || (userInfo && userInfo.steamid) || (steamIdMatch ? steamIdMatch[1] : undefined);
              const resolvedPersona = personaName || (userInfo && userInfo.account_name) || undefined;

              if (el && el.dataset && el.dataset.profileGameslist) {
                return {
                  gameslistJson: el.dataset.profileGameslist,
                  avatarUrl: avatarUrl || (userInfo && userInfo.avatar_url) || (avatarEl ? avatarEl.src : undefined),
                  steamId: resolvedSteamId,
                  personaName: resolvedPersona,
                  webApiToken,
                };
              }

              // 3. If logged in on a non-games community page, redirect to /my/games/?tab=all
              const isLoggedIn = Boolean((userCfg && userCfg.logged_in) || resolvedSteamId);
              if (isLoggedIn && !window.location.pathname.includes('/games')) {
                window.location.href = 'https://steamcommunity.com/my/games/?tab=all';
                return { redirecting: true };
              }

              await new Promise(r => setTimeout(r, 350));
            }
            return null;
          })()
        `);

        if (steamData && steamData.gameslistJson && !resolved) {
          resolved = true;
          safelyCloseAuthWindow();
          const parsedSteam = await parseSteamGamesListJson(
            steamData.gameslistJson,
            steamData.steamId,
            steamData.personaName,
            steamData.avatarUrl
          );
          const tokenPayload = {
            access_token: 'steam_web_session',
            webapi_token: steamData.webApiToken,
            steamId: parsedSteam.accountId,
            accountName: parsedSteam.accountName,
            avatarUrl: parsedSteam.avatarUrl,
            games: parsedSteam.games,
          };
          storeSync.saveTokens('steam', tokenPayload);
          try {
            launcherEngine?.clearStoreDisconnectedTombstone?.('steam');
          } catch {}
          resolve({
            success: true,
            storefrontId: 'steam',
            accountName: parsedSteam.accountName,
            accountId: parsedSteam.accountId,
            avatarUrl: parsedSteam.avatarUrl,
            games: parsedSteam.games,
            tokenData: tokenPayload,
          });
          return;
        }
      } catch (err) {
        console.warn('Steam web extraction warning:', err.message);
      } finally {
        extractingSteam = false;
      }
    };

    // Intercept redirect attempts BEFORE the network paints the page
    authWindow.webContents.on('will-redirect', (_event, url) => {
      checkUrlForCode(url);
    });

    authWindow.webContents.on('will-navigate', (_event, url) => {
      checkUrlForCode(url);
    });

    authWindow.webContents.on('did-navigate', async (_event, url) => {
      checkUrlForCode(url);

      // In case Epic renders the JSON redirect page directly (api/redirect):
      if (storefrontId === 'epic' && url.includes('/id/api/redirect')) {
        try {
          const pageSource = await authWindow.webContents.executeJavaScript('document.body.innerText');
          if (pageSource) {
            const match = pageSource.match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i)
              || pageSource.match(/\b([a-fA-F0-9]{32})\b/);
            if (match) {
              handleAuthCodeFound(match[1]);
              return;
            }
          }
        } catch {}
      }

      if (storefrontId === 'steam' && !url.includes('/login') && url.includes('steamcommunity.com')) {
        await tryExtractSteamGames();
      }
    });

    authWindow.webContents.on('did-finish-load', async () => {
      if (resolved || authWindow.isDestroyed()) return;
      const currentUrl = authWindow.webContents.getURL();
      checkUrlForCode(currentUrl);

      if (storefrontId === 'epic' && currentUrl.includes('/id/api/redirect')) {
        try {
          const pageSource = await authWindow.webContents.executeJavaScript('document.body.innerText');
          if (pageSource) {
            const match = pageSource.match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i)
              || pageSource.match(/\b([a-fA-F0-9]{32})\b/);
            if (match) {
              handleAuthCodeFound(match[1]);
              return;
            }
          }
        } catch {}
      }

      if (storefrontId === 'steam' && !currentUrl.includes('/login') && currentUrl.includes('steamcommunity.com')) {
        await tryExtractSteamGames();
      }
    });

    authWindow.on('closed', () => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: 'Sign-in window closed by user.' });
      }
    });

    authWindow.loadURL(config.url);
  });
});

/**
 * Handle manual authorization code submission from UI (Alternative login)
 */
ipcMain.handle('store:exchange-code', async (_event, { storefrontId, code }) => {
  const res = await processStoreAuth(storefrontId, code);
  if (res && res.success) {
    try {
      launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
    } catch {}
  }
  return res;
});

const inFlightStoreSyncs = new Map();

/**
 * Background / Manual sync of store using stored session tokens
 */
ipcMain.handle('store:sync', async (_event, storefrontId, fallbackCredentials) => {
  const syncKey = String(storefrontId || '').toLowerCase().trim() || 'default';
  if (inFlightStoreSyncs.has(syncKey)) {
    return inFlightStoreSyncs.get(syncKey);
  }

  const syncPromise = (async () => {
    const savedTokens = storeSync.loadSavedTokens();
    let tokenData = savedTokens[storefrontId] || {};
    if (!tokenData.access_token && !fallbackCredentials?.epicToken && !fallbackCredentials?.gogToken) {
      return { success: false, error: `No saved credentials found for ${storefrontId}. Please connect in Settings.` };
    }

    try {
      let accountName = 'Verified User';
      let avatarUrl = undefined;
      let games = [];

      if (storefrontId === 'steam') {
        accountName = tokenData.accountName || 'Steam User';
        avatarUrl = tokenData.avatarUrl;
        games = Array.isArray(tokenData.games) ? tokenData.games : [];
        let refreshedLive = false;

        if (tokenData.webapi_token && tokenData.steamId) {
          try {
            const res = await fetch(
              `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?access_token=${encodeURIComponent(
                tokenData.webapi_token
              )}&steamid=${encodeURIComponent(tokenData.steamId)}&include_appinfo=1&include_played_free_games=1&include_free_sub=0`
            );
            if (res.ok) {
              const apiJson = await res.json();
              if (Array.isArray(apiJson?.response?.games) && apiJson.response.games.length > 0) {
                const ownedAppIds = apiJson.response.games.map((g) => g.appid).filter(Boolean);
                const storeItems = await fetchSteamStoreBrowseItemsMap(ownedAppIds);
                const refreshed = await parseSteamGamesListJson(
                  { rgGames: apiJson.response.games, storeItems, strProfileName: accountName },
                  tokenData.steamId,
                  accountName,
                  avatarUrl,
                  games
                );
                games = refreshed.games;
                tokenData = { ...tokenData, games };
                storeSync.saveTokens('steam', tokenData);
                refreshedLive = true;
              }
            }
          } catch {}
        }

        if (!refreshedLive) {
          try {
            const cleanBrowserUA = session.defaultSession
              .getUserAgent()
              .replace(/\s+OneLauncher\/[^\s]+/gi, '')
              .replace(/\s+one-launcher\/[^\s]+/gi, '')
              .replace(/\s+Electron\/[^\s]+/gi, '');

            let ssrResult = null;
            try {
              const authSession = session.fromPartition('persist:storefront_auth');
              if (authSession && typeof authSession.fetch === 'function') {
                const fetchAbort = new AbortController();
                const fetchTimer = setTimeout(() => fetchAbort.abort(), 10000);
                try {
                  const ssrRes = await authSession.fetch('https://steamcommunity.com/my/games/?tab=all', {
                    signal: fetchAbort.signal,
                    headers: {
                      'User-Agent': cleanBrowserUA,
                      Accept: 'text/html,application/xhtml+xml',
                    },
                  });
                  if (ssrRes && ssrRes.ok && !String(ssrRes.url || '').includes('/login')) {
                    const html = await ssrRes.text();
                    const ssrMatch = html.match(/<script\s+id=["']valve-ssr-data["'][^>]*>([\s\S]*?)<\/script>/i);
                    if (ssrMatch && ssrMatch[1]) {
                      try {
                        const ssr = JSON.parse(ssrMatch[1].trim());
                        let webApiToken = undefined;
                        let rgGames = null;
                        const storeItems = {};
                        const loaderData = Array.isArray(ssr?.loaderData) ? ssr.loaderData : [];
                        for (const item of loaderData) {
                          if (!item) continue;
                          try {
                            const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                            if (parsed && parsed.strWebAPIToken && !webApiToken) {
                              webApiToken = String(parsed.strWebAPIToken);
                            }
                          } catch {}
                        }
                        const rawQueryData = ssr?.renderContext?.queryData;
                        if (rawQueryData) {
                          try {
                            const qd = typeof rawQueryData === 'string' ? JSON.parse(rawQueryData) : rawQueryData;
                            const queries = Array.isArray(qd?.queries) ? qd.queries : [];
                            for (const q of queries) {
                              const key = Array.isArray(q?.queryKey) ? q.queryKey : [];
                              const data = q?.state?.data;
                              if (!data) continue;
                              if (key[0] === 'OwnedGames' && Array.isArray(data)) {
                                rgGames = data;
                              } else if (
                                key[0] === 'StoreItem' &&
                                typeof key[1] === 'string' &&
                                key[1].startsWith('app_')
                              ) {
                                storeItems[key[1].replace('app_', '')] = data;
                              }
                            }
                          } catch {}
                        }
                        if (Array.isArray(rgGames) && rgGames.length > 0) {
                          ssrResult = { rgGames, storeItems, webApiToken };
                        }
                      } catch {}
                    }
                    if (!ssrResult) {
                      const legacyMatch = html.match(/data-profile-gameslist="([^"]+)"/i);
                      if (legacyMatch && legacyMatch[1]) {
                        try {
                          const decoded = legacyMatch[1]
                            .replace(/&quot;/g, '"')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&#039;/g, "'")
                            .replace(/&#39;/g, "'");
                          const parsedLegacy = JSON.parse(decoded);
                          if (Array.isArray(parsedLegacy?.rgGames) && parsedLegacy.rgGames.length > 0) {
                            ssrResult = {
                              rgGames: parsedLegacy.rgGames,
                              storeItems: parsedLegacy.storeItems || {},
                              webApiToken: parsedLegacy.strWebAPIToken || parsedLegacy.webapi_token,
                            };
                          }
                        } catch {}
                      }
                    }
                  }
                } finally {
                  clearTimeout(fetchTimer);
                }
              }
            } catch {}

            if (ssrResult && Array.isArray(ssrResult.rgGames) && ssrResult.rgGames.length > 0) {
              const refreshed = await parseSteamGamesListJson(
                { rgGames: ssrResult.rgGames, strProfileName: accountName, storeItems: ssrResult.storeItems || {} },
                tokenData.steamId,
                accountName,
                avatarUrl
              );
              games = refreshed.games;
              tokenData = {
                ...tokenData,
                webapi_token: ssrResult.webApiToken || tokenData.webapi_token,
                games,
              };
              storeSync.saveTokens('steam', tokenData);
              refreshedLive = true;
            }

            if (!refreshedLive) {
              ssrResult = await new Promise((resolveSsr) => {
                let done = false;
                const bgWin = new BrowserWindow({
                  width: 1024,
                  height: 768,
                  show: false,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    partition: 'persist:storefront_auth',
                    userAgent: cleanBrowserUA,
                    images: false,
                    spellcheck: false,
                    backgroundThrottling: true,
                    v8CacheOptions: 'none',
                  },
                });

                let timer = null;
                const finish = (val) => {
                  if (done) return;
                  done = true;
                  if (timer) clearTimeout(timer);
                  try {
                    if (typeof storeSync.destroyScraperWindowCleanly === 'function') {
                      storeSync.destroyScraperWindowCleanly(bgWin);
                    } else if (bgWin && !bgWin.isDestroyed()) {
                      bgWin.destroy();
                    }
                  } catch {}
                  resolveSsr(val);
                };

                timer = setTimeout(() => finish(null), 12000);

                bgWin.webContents.on('did-finish-load', async () => {
                  if (done || bgWin.isDestroyed()) return;
                  const currentUrl = bgWin.webContents.getURL();
                  if (!currentUrl || currentUrl.includes('/login') || !currentUrl.includes('steamcommunity.com')) {
                    return;
                  }
                  try {
                    const extracted = await bgWin.webContents.executeJavaScript(`
                      (function() {
                        let ssr = window.SSR;
                        if (!ssr) {
                          const ssrScript = document.getElementById('valve-ssr-data');
                          if (ssrScript && ssrScript.textContent) {
                            try { ssr = JSON.parse(ssrScript.textContent); } catch (e) {}
                          }
                        }
                        if (!ssr) return null;
                        let webApiToken = undefined;
                        let rgGames = null;
                        const storeItems = {};
                        const loaderData = Array.isArray(ssr.loaderData) ? ssr.loaderData : [];
                        for (const item of loaderData) {
                          if (!item) continue;
                          try {
                            const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                            if (parsed && parsed.strWebAPIToken && !webApiToken) webApiToken = String(parsed.strWebAPIToken);
                          } catch (e) {}
                        }
                        const rawQueryData = ssr.renderContext && ssr.renderContext.queryData;
                        if (rawQueryData) {
                          try {
                            const qd = typeof rawQueryData === 'string' ? JSON.parse(rawQueryData) : rawQueryData;
                            const queries = Array.isArray(qd && qd.queries) ? qd.queries : [];
                            for (const q of queries) {
                              const key = Array.isArray(q && q.queryKey) ? q.queryKey : [];
                              const data = q && q.state ? q.state.data : undefined;
                              if (!data) continue;
                              if (key[0] === 'OwnedGames' && Array.isArray(data)) {
                                rgGames = data;
                              } else if (key[0] === 'StoreItem' && typeof key[1] === 'string' && key[1].startsWith('app_')) {
                                storeItems[key[1].replace('app_', '')] = data;
                              }
                            }
                          } catch (e) {}
                        }
                        if (Array.isArray(rgGames) && rgGames.length > 0) {
                          return { rgGames, storeItems, webApiToken };
                        }
                        return null;
                      })()
                    `);
                    if (extracted && Array.isArray(extracted.rgGames) && extracted.rgGames.length > 0) {
                      finish(extracted);
                    }
                  } catch {}
                });

                bgWin.loadURL('https://steamcommunity.com/my/games/?tab=all').catch(() => {
                  finish(null);
                });
              });

              if (ssrResult && Array.isArray(ssrResult.rgGames) && ssrResult.rgGames.length > 0) {
                const refreshed = await parseSteamGamesListJson(
                  { rgGames: ssrResult.rgGames, strProfileName: accountName, storeItems: ssrResult.storeItems || {} },
                  tokenData.steamId,
                  accountName,
                  avatarUrl
                );
                games = refreshed.games;
                tokenData = {
                  ...tokenData,
                  webapi_token: ssrResult.webApiToken || tokenData.webapi_token,
                  games,
                };
                storeSync.saveTokens('steam', tokenData);
                refreshedLive = true;
              }
            }
          } catch {}
        }

        let steamAchMap = {};
        if (Array.isArray(games) && games.length > 0) {
          const localPlaytimes = await readLocalSteamPlaytimes();
          const appIds = games
            .map((g) => Number(g.steamAppId || (String(g.id || '').startsWith('steam-') ? String(g.id).replace('steam-', '') : 0)))
            .filter((id) => id > 0);
          steamAchMap = await fetchSteamBatchAchievements(tokenData.webapi_token, tokenData.steamId, appIds);

          games = games.map((g) => {
            const appId = Number(g.steamAppId || (String(g.id || '').startsWith('steam-') ? String(g.id).replace('steam-', '') : 0));
            const localPt = appId ? localPlaytimes[appId] : null;
            const ach = appId ? steamAchMap[appId] : null;
            if ((!localPt || !localPt.playtimeMinutes) && !ach) {
              return g.isVerifiedEntitlement === true ? g : { ...g, isVerifiedEntitlement: true };
            }
            return {
              ...g,
              isVerifiedEntitlement: true,
              platforms: (g.platforms || []).map((p) => {
                if (p.platformId !== 'steam') return p;
                const mergedPt = localPt && localPt.playtimeMinutes
                  ? Math.max(Number(p.playtimeMinutes || 0), localPt.playtimeMinutes)
                  : Number(p.playtimeMinutes || 0);
                const existingAch = p.achievements;
                let mergedAch = existingAch;
                if (ach && ach.total > 0) {
                  const bestUnlocked = existingAch ? Math.max(ach.unlocked, Number(existingAch.unlocked || 0)) : ach.unlocked;
                  const bestTotal = existingAch ? Math.max(ach.total, Number(existingAch.total || 0)) : ach.total;
                  const pct = bestTotal > 0 ? Math.round((bestUnlocked / bestTotal) * 100) : 0;
                  mergedAch = {
                    unlocked: bestUnlocked,
                    total: bestTotal,
                    percentage: pct,
                    isMastered: Boolean(ach.isMastered) || (bestTotal > 0 && bestUnlocked >= bestTotal),
                  };
                }
                return {
                  ...p,
                  playtimeMinutes: mergedPt,
                  achievements: mergedAch,
                };
              }),
            };
          });
          tokenData = { ...tokenData, games };
          storeSync.saveTokens('steam', tokenData);
        }
        return {
          success: true,
          storefrontId,
          accountName,
          accountId: tokenData.steamId,
          avatarUrl,
          games,
          achievements: steamAchMap,
          suppressedItems:
            typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
              ? storeSync.scanLocalSuppressedStorefrontItems().filter((x) => x.platformId === 'steam')
              : [],
        };
      } else if (storefrontId === 'gog') {
        let accessToken = tokenData.access_token || fallbackCredentials?.gogToken;
        let accountId = undefined;
        try {
          const account = await storeSync.fetchGogAccount(accessToken);
          accountName = account.username || 'GOG User';
          accountId = account.userId;
          avatarUrl = account.avatarUrl;
          games = await storeSync.fetchGogOwnedGames(accessToken, accountName, account.userId);
        } catch (err) {
          // Automatically renew token if expired
          if (tokenData.refresh_token) {
            const renewed = await storeSync.renewGogTokens(tokenData.refresh_token);
            accessToken = renewed.access_token;
            const account = await storeSync.fetchGogAccount(accessToken);
            accountName = account.username || 'GOG User';
            accountId = account.userId;
            avatarUrl = account.avatarUrl;
            games = await storeSync.fetchGogOwnedGames(accessToken, accountName, account.userId);
          } else {
            throw err;
          }
        }
        const localGogSuppressed =
          typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
            ? storeSync.scanLocalSuppressedStorefrontItems().filter((x) => x.platformId === 'gog')
            : [];
        return {
          success: true,
          storefrontId,
          accountName,
          accountId,
          avatarUrl,
          games,
          achievements: storeSync.fetchGogOwnedGames.lastAchievementsMap || {},
          suppressedItems: [...(storeSync.fetchGogOwnedGames.lastSuppressedItems || []), ...localGogSuppressed],
        };
      } else if (storefrontId === 'epic') {
        const epicDisconnected = Boolean(launcherEngine?.isStoreDisconnectedTombstoned?.('epic'));
        let accessToken = tokenData.access_token || fallbackCredentials?.epicToken;
        let accountId = tokenData.account_id || fallbackCredentials?.epicAccountId;
        accountName = tokenData.displayName || accountId || 'Epic Games User';
        if (
          (!accessToken || !accountId) &&
          !epicDisconnected &&
          typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
        ) {
          try {
            const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
            if (legAuth?.accessToken) {
              accessToken = accessToken || legAuth.accessToken;
              accountId = accountId || legAuth.accountId;
              accountName = legAuth.displayName || accountName;
            }
          } catch {}
        }
        try {
          games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
        } catch (err) {
          if (fallbackCredentials?.epicToken && fallbackCredentials.epicToken !== accessToken) {
            try {
              accessToken = fallbackCredentials.epicToken;
              games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
              storeSync.saveTokens('epic', {
                ...tokenData,
                access_token: accessToken,
                refresh_token: fallbackCredentials.epicRefreshToken || tokenData.refresh_token,
                account_id: accountId,
              });
            } catch (innerErr) {
              games = [];
            }
          }
          if (!games || games.length === 0) {
            const refreshCand = fallbackCredentials?.epicRefreshToken || tokenData.refresh_token;
            if (refreshCand) {
              try {
                const renewed = await storeSync.renewEpicTokens(refreshCand);
                accessToken = renewed.access_token;
                accountId = renewed.account_id || accountId;
                accountName = renewed.displayName || accountName;
                games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
              } catch {}
            }
            if (
              (!games || games.length === 0) &&
              !epicDisconnected &&
              typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
            ) {
              const recoveredLegAuth = await launcherEngine.ensureLegendaryConfigAndAuth({
                forceTokenRefresh: true,
              });
              if (recoveredLegAuth?.accessToken) {
                accessToken = recoveredLegAuth.accessToken;
                accountId = recoveredLegAuth.accountId || accountId;
                accountName = recoveredLegAuth.displayName || accountName;
                games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
              } else {
                throw err;
              }
            } else if (!games || games.length === 0) {
              throw err;
            }
          }
        }
        const localEpicSuppressed =
          typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
            ? storeSync.scanLocalSuppressedStorefrontItems().filter((x) => x.platformId === 'epic')
            : [];
        return {
          success: true,
          storefrontId,
          accountName,
          accountId,
          avatarUrl,
          games,
          achievements: storeSync.fetchEpicOwnedGames.lastAchievementsMap || {},
          suppressedItems: [...(storeSync.fetchEpicOwnedGames.lastSuppressedItems || []), ...localEpicSuppressed],
        };
      }

      return { success: true, storefrontId, accountName, avatarUrl, games, achievements: {} };
    } catch (err) {
      return { success: false, error: err.message };
    }
  })().finally(() => {
    inFlightStoreSyncs.delete(syncKey);
    try {
      storeSync.trimStoreSyncMemory?.();
    } catch {}
  });

  inFlightStoreSyncs.set(syncKey, syncPromise);
  return syncPromise;
});

ipcMain.handle('store:get-tokens', async () => {
  let saved = storeSync.loadSavedTokens() || {};
  if (
    (!saved.epic || !saved.epic.access_token) &&
    !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
    typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
  ) {
    try {
      const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
      if (legAuth?.accessToken) {
        saved = storeSync.loadSavedTokens() || saved;
        if (!saved.epic || !saved.epic.access_token) {
          saved.epic = {
            ...(saved.epic || {}),
            access_token: legAuth.accessToken,
            refresh_token: legAuth.refreshToken || saved.epic?.refresh_token,
            account_id: legAuth.accountId || saved.epic?.account_id,
            displayName: legAuth.displayName || saved.epic?.displayName,
          };
        }
      }
    } catch {}
  }
  if (saved.gog && saved.gog.access_token) {
    const normalizedExisting =
      typeof storeSync.normalizeGogAvatarUrl === 'function'
        ? storeSync.normalizeGogAvatarUrl(saved.gog.avatarUrl, saved.gog.avatars)
        : saved.gog.avatarUrl;
    if (normalizedExisting && normalizedExisting !== saved.gog.avatarUrl) {
      saved.gog.avatarUrl = normalizedExisting;
      storeSync.saveTokens('gog', saved.gog);
    }
    if (!saved.gog.avatarUrl || !saved.gog.username) {
      try {
        const account = await storeSync.fetchGogAccount(saved.gog.access_token);
        if (account) {
          saved.gog.username = account.username || saved.gog.username;
          saved.gog.avatarUrl = account.avatarUrl || saved.gog.avatarUrl;
          saved.gog.user_id = account.userId || saved.gog.user_id;
          storeSync.saveTokens('gog', saved.gog);
        }
      } catch {
        if (saved.gog.refresh_token) {
          try {
            const renewed = await storeSync.renewGogTokens(saved.gog.refresh_token);
            const account = await storeSync.fetchGogAccount(renewed.access_token);
            saved.gog = {
              ...saved.gog,
              ...renewed,
              username: account?.username || saved.gog.username,
              avatarUrl: account?.avatarUrl || saved.gog.avatarUrl,
              user_id: account?.userId || renewed.user_id || saved.gog.user_id,
            };
            storeSync.saveTokens('gog', saved.gog);
          } catch {}
        }
      }
    }
  }
  if (typeof storeSync.scanLocalSuppressedStorefrontItems === 'function') {
    try {
      saved.suppressedItems = storeSync.scanLocalSuppressedStorefrontItems();
    } catch {}
  }
  return saved;
});

const handleClearStoreTokens = async (_event, storefrontId) => {
  storeSync.clearTokens(storefrontId);
  try {
    launcherEngine?.purgeStoreHelperCredentials?.(storefrontId);
  } catch {}
  return { success: true };
};

ipcMain.handle('store:clear-tokens', handleClearStoreTokens);
ipcMain.handle('store:clear-token', handleClearStoreTokens);

const handleSaveStoreTokens = async (_event, arg1, arg2) => {
  const storefrontId =
    arg1 && typeof arg1 === 'object' ? arg1.storefrontId || arg1.store : arg1;
  const tokenData =
    arg1 && typeof arg1 === 'object' ? arg1.tokenData || arg1.tokens || arg2 : arg2;
  if (!storefrontId || !tokenData || typeof tokenData !== 'object') {
    return { success: false, error: 'Invalid storefront token payload' };
  }
  storeSync.saveTokens(storefrontId, tokenData);
  try {
    launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
  } catch {}
  return { success: true };
};

ipcMain.handle('store:save-tokens', handleSaveStoreTokens);
ipcMain.handle('store:save-token', handleSaveStoreTokens);

ipcMain.handle('epic:fetch-achievements', async (_event, { accountId, accessToken } = {}) => {
  try {
    const savedTokens = storeSync.loadSavedTokens();
    const savedEpic = savedTokens?.epic || {};
    let resolvedAccountId = accountId || savedEpic.account_id;
    let resolvedToken = accessToken || savedEpic.access_token;
    if (
      (!resolvedToken || !resolvedAccountId) &&
      !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
      typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
    ) {
      try {
        const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
        resolvedToken = resolvedToken || legAuth?.accessToken;
        resolvedAccountId = resolvedAccountId || legAuth?.accountId;
      } catch {}
    }
    let result = await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId);
    if ((!result || Object.keys(result).length === 0) && savedEpic.refresh_token) {
      try {
        const renewed = await storeSync.renewEpicTokens(savedEpic.refresh_token);
        resolvedToken = renewed.access_token;
        resolvedAccountId = renewed.account_id || resolvedAccountId;
        result = await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId);
      } catch {}
    }
    return result || {};
  } catch (err) {
    console.warn('IPC epic:fetch-achievements warning:', err.message);
    return {};
  }
});

ipcMain.handle('epic:fetch-game-schema', async (_event, payload = {}) => {
  try {
    if (typeof storeSync.getEpicGameAchievementSchema === 'function') {
      return await storeSync.getEpicGameAchievementSchema(payload);
    }
    return [];
  } catch (err) {
    console.warn('IPC epic:fetch-game-schema warning:', err.message);
    return [];
  }
});

ipcMain.handle('store:fetch-epic-metadata', async (_event, payload = {}) => {
  try {
    return await storeSync.fetchEpicProductOfferMetadata(payload);
  } catch (err) {
    console.warn('IPC store:fetch-epic-metadata warning:', err.message);
    return null;
  }
});

ipcMain.handle('gog:fetch-achievements', async (_event, { username, accessToken, userId } = {}) => {
  try {
    const savedTokens = storeSync.loadSavedTokens();
    const savedGog = savedTokens?.gog || {};
    let resolvedToken = accessToken || savedGog.access_token;
    let resolvedUsername = username;
    let resolvedUserId = userId || savedGog.user_id;

    if (resolvedToken) {
      try {
        const account = await storeSync.fetchGogAccount(resolvedToken);
        resolvedUsername = account.username || resolvedUsername;
        resolvedUserId = account.userId || resolvedUserId;
      } catch {
        if (savedGog.refresh_token) {
          try {
            const renewed = await storeSync.renewGogTokens(savedGog.refresh_token);
            resolvedToken = renewed.access_token;
            const account = await storeSync.fetchGogAccount(resolvedToken);
            resolvedUsername = account.username || resolvedUsername;
            resolvedUserId = account.userId || resolvedUserId;
          } catch {}
        }
      }
    }

    if (!resolvedUsername && !resolvedToken) return {};
    return await storeSync.fetchGogAchievements(resolvedToken, resolvedUsername, resolvedUserId);
  } catch (err) {
    console.warn('IPC gog:fetch-achievements warning:', err.message);
    return {};
  }
});

ipcMain.handle('steam:fetch-achievements', async (_event, { appIds } = {}) => {
  try {
    const savedTokens = storeSync.loadSavedTokens();
    const savedSteam = savedTokens?.steam || {};
    const resolvedAppIds =
      Array.isArray(appIds) && appIds.length > 0
        ? appIds
        : Array.isArray(savedSteam.games)
          ? savedSteam.games.map((g) => Number(g.steamAppId || 0)).filter((id) => id > 0)
          : [];
    const achievements = await fetchSteamBatchAchievements(
      savedSteam.webapi_token,
      savedSteam.steamId,
      resolvedAppIds
    );
    return {
      success: true,
      achievements,
      steamId: savedSteam.steamId,
    };
  } catch (err) {
    return { success: false, error: err.message, achievements: {} };
  }
});

/**
 * Native Scanner for Steam achievements directly from local Steam client userdata
 */
ipcMain.handle('scan:steam-achievements', async () => {
  try {
    const achievements = await scanLocalSteamAchievements();
    return { success: true, achievements };
  } catch (err) {
    return { success: false, error: err.message, achievements: {} };
  }
});

/**
 * Open URL in user's default external browser or storefront client protocol
 */
ipcMain.handle('shell:open-external', async (_event, url) => {
  if (
    typeof url === 'string' &&
    url.trim().length > 0 &&
    /^https?:\/\/|^steam:\/\/|^goggalaxy:\/\/|^com\.epicgames\.launcher:\/\/|^heroic:\/\//i.test(
      url.trim()
    )
  ) {
    await require('electron').shell.openExternal(url.trim());
    return true;
  }
  return false;
});

// ============================================================================
// Universal Game Launcher & Install Manager IPC Handlers (Modularized)
// ============================================================================
registerLauncherIpcHandlers({ ipcMain, launcherEngine });
ipcMain.handle('launcher:detect-storefront-clients', (_event, options) =>
  launcherEngine.detectInstalledStorefrontClients(options || {})
);

// HowLongToBeat Token Cache
let hltbCachedToken = null;
let hltbTokenExpiry = 0;

async function getHltbToken() {
  if (hltbCachedToken && Date.now() < hltbTokenExpiry) {
    return hltbCachedToken;
  }
  try {
    const initRes = await fetch(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'Referer': 'https://howlongtobeat.com/',
      },
    });
    if (!initRes.ok) return null;
    const initData = await initRes.json();
    if (initData?.token) {
      hltbCachedToken = initData.token;
      hltbTokenExpiry = Date.now() + 10 * 60 * 1000;
      return hltbCachedToken;
    }
  } catch (e) {
    console.warn('[HLTB] Token init failed:', e.message);
  }
  return null;
}

/**
 * Live HowLongToBeat API Search IPC Handler
 */
ipcMain.handle('hltb:search', async (_event, gameTitle) => {
  if (!gameTitle || typeof gameTitle !== 'string') {
    return { success: false, data: [] };
  }

  try {
    const cleanTerms = gameTitle
      .replace(/[+:]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (cleanTerms.length === 0) return { success: false, data: [] };

    let token = await getHltbToken();
    if (!token) return { success: false, error: 'Could not obtain HLTB token', data: [] };

    const executeSearch = async (authToken) => {
      return await fetch('https://howlongtobeat.com/api/search/site', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': authToken,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
          'Referer': 'https://howlongtobeat.com/',
        },
        body: JSON.stringify({
          searchType: 'games',
          searchTerms: cleanTerms,
          searchPage: 1,
          size: 10,
          searchOptions: {
            games: {
              userId: 0,
              platform: '',
              sortCategory: 'popular',
              rangeCategory: 'main',
              rangeTime: { min: 0, max: 0 },
              gameplay: { perspective: '', flow: '', genre: '' },
              year: '',
              modifier: '',
            },
            users: { sortCategory: 'postcount' },
            lists: { sortCategory: 'follows' },
            filter: '',
            sort: 0,
            randomizer: 0,
          },
          useCache: true,
        }),
      });
    };

    let searchRes = await executeSearch(token);
    if (searchRes.status === 403) {
      hltbCachedToken = null;
      token = await getHltbToken();
      if (token) {
        searchRes = await executeSearch(token);
      }
    }

    if (!searchRes.ok) {
      return { success: false, error: `HLTB status ${searchRes.status}`, data: [] };
    }

    const json = await searchRes.json();
    return { success: true, data: json.data || [] };
  } catch (err) {
    return { success: false, error: err.message, data: [] };
  }
});

ipcMain.handle('igdb:fetch-cover', async (_event, gameTitle) => {
  try {
    return await storeSync.fetchIgdbCover(gameTitle);
  } catch (err) {
    console.warn('IPC igdb:fetch-cover warning:', err.message);
    return null;
  }
});

// ============================================================================
// Custom Steam-Style Window & Menu Bar IPC Handlers (Modularized)
// ============================================================================
registerWindowAndSystemIpcHandlers({
  ipcMain,
  app,
  getMainWindow: () => mainWindow,
});

ipcMain.handle('perf:trim-memory', async (_event, options) => {
  try {
    launcherEngine.trimLauncherEngineMemory?.();
  } catch {}
  try {
    storeSync.trimStoreSyncMemory?.();
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

// ============================================================================
// Application Version, Upgrade Status & GitHub Release Update Checker IPC
// ============================================================================

function compareSemver(verA, verB) {
  const cleanA = String(verA || '0.0.0').replace(/^v/i, '').split('-')[0];
  const cleanB = String(verB || '0.0.0').replace(/^v/i, '').split('-')[0];
  const partsA = cleanA.split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = cleanB.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length, 3);
  for (let i = 0; i < len; i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

ipcMain.handle('app:get-version', () => {
  try {
    return app.getVersion();
  } catch {
    return '0.1.0';
  }
});

ipcMain.handle('app:get-info', () => {
  let version = '0.1.0';
  try {
    version = app.getVersion();
  } catch {}
  return {
    version,
    platform: process.platform,
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
  let currentVersion = '0.1.0';
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
    const releaseUrl = data?.html_url || defaultReleaseUrl;
    const assets = Array.isArray(data?.assets) ? data.assets : [];

    let matchedAsset = null;
    if (process.platform === 'win32') {
      matchedAsset =
        assets.find(
          (a) =>
            a &&
            typeof a.name === 'string' &&
            /setup.*\.exe$/i.test(a.name) &&
            !/uninstaller/i.test(a.name)
        ) ||
        assets.find(
          (a) =>
            a &&
            typeof a.name === 'string' &&
            /\.exe$/i.test(a.name) &&
            !/uninstaller/i.test(a.name)
        );
    } else if (process.platform === 'darwin') {
      matchedAsset =
        assets.find((a) => a && typeof a.name === 'string' && /-arm64\.dmg$/i.test(a.name)) ||
        assets.find((a) => a && typeof a.name === 'string' && /\.dmg$/i.test(a.name));
    }

    const downloadUrl = matchedAsset?.browser_download_url || releaseUrl;
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

