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
  powerMonitor,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const storeSync = require('./storeSync.cjs');
const launcherEngine = require('./launcherEngine.cjs');
const { isNetworkOnlineForLaunch } = require('./launcher/engineStateRegistry.cjs');
const { replayPendingCloudUploads } = require('./launcher/sessionAndProcessSupervisor.cjs');
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
  trimUserOverridesCache,
} = require('./ipc/offlineVaultIpcHandlers.cjs');
const {
  resolveAppVersionString,
  checkMainAppFrameInitiator,
  registerWebRequestHeaderGuards,
} = require('./ipc/webRequestHeaderGuards.cjs');
const { createTrayAndDaemonLifecycle } = require('./ipc/trayAndDaemonLifecycle.cjs');
const { installMacApplicationMenu } = require('./ipc/appMenuBuilder.cjs');
const { compareSemver } = require('./utils/semverUtils.cjs');
const { diagLog, flushSync: flushDiagnosticLogSync } = require('./utils/diagnosticLogger.cjs');
const {
  isAllowedHttpsHost,
  resolveTrustedDevStartUrl,
  isTrustedAppRendererUrl,
  wrapIpcMainWithSenderCheck,
  refreshHostWindowsKnownFoldersAsync,
  discoverWindowsLocalDrivesAsync,
  warmWindowsUserSidAsync,
} = require('./launcher/securityAndPathUtils.cjs');
const { refreshWindowsStorefrontRegistryCacheAsync } = require('./utils/windowsRegistryDiscovery.cjs');

const MAX_EXTERNAL_URI_LENGTH = 2048;

const SAFE_EXTERNAL_URI_SCHEME_RE =
  /^(?:https:\/\/|steam:\/\/|goggalaxy:\/\/|com\.epicgames\.launcher:\/\/|heroic:\/\/|msxbox:(?:\/\/|\S)|ms-windows-store:(?:\/\/|\S)|xbox:(?:\/\/|\S)|ms-xbl-[a-z0-9-]+:(?:\/\/|\S))/i;

const DIST_INDEX_HTML_PATH = path.join(__dirname, '../dist/index.html');
const EXPECTED_PACKAGED_FILE_HREF = pathToFileURL(DIST_INDEX_HTML_PATH).toString();

/**
 * Strictly validate an external URI before passing it to `shell.openExternal()`:
 * enforces length bound (`<= 2048`), rejects control characters and cleartext `http:`,
 * parses via WHATWG `new URL()`, requires clean `https:` host (no credentials) or an
 * explicitly allowlisted storefront deep-link protocol.
 *
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
function validateSafeExternalShellUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_EXTERNAL_URI_LENGTH ||
    /[\x00-\x1f\x7f]/.test(trimmed) ||
    !SAFE_EXTERNAL_URI_SCHEME_RE.test(trimmed)
  ) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:') {
    if (!parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return trimmed;
  }
  if (parsed.protocol === 'http:') {
    return null;
  }
  return trimmed;
}

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
let isQuittingAfterSync = false;
/** @type {Promise<any> | null} */
let shutdownInProgressPromise = null;

launcherEngine.setMainWindowGetter(() => mainWindow);

const storefrontFederator = createStorefrontLocalCacheFederator();
const offlineVaultService = createOfflineVaultService({ federator: storefrontFederator });
const mediaHydrationEngine = createMediaHydrationEngine({
  offlineVaultService,
  launcherEngine,
});

if (typeof launcherEngine.setOfflineVaultLifecycleHooks === 'function') {
  launcherEngine.setOfflineVaultLifecycleHooks({
    trimMemory: () => {
      try {
        storefrontFederator.trimMemory?.();
      } catch {}
      try {
        trimUserOverridesCache();
      } catch {}
      offlineVaultService.trimMemory();
    },
    shutdown: () => {
      mediaHydrationEngine.shutdown();
      offlineVaultService.shutdown();
    },
  });
}

const ipcSenderSecurityOptions = {
  isPackaged: Boolean(app?.isPackaged),
  allowedDevOrigin: resolveTrustedDevStartUrl(
    process.env.ELECTRON_START_URL,
    Boolean(app?.isPackaged)
  ),
  expectedFileHref: EXPECTED_PACKAGED_FILE_HREF,
};

const lifecycle = createTrayAndDaemonLifecycle({
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
  electronDir: __dirname,
  getMainWindow: () => mainWindow,
  setMainWindow: (win) => {
    mainWindow = win;
  },
  createMainWindow,
  ipcSenderSecurityOptions,
});

lifecycle.installSessionLifecycleHook();
lifecycle.registerRendererReadyListener();

function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const allowDevTools = !app?.isPackaged || process.env.ONE_LAUNCHER_DEBUG === '1';

  lifecycle.markMainWindowLoading();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'One Launcher',
    icon: lifecycle.getAppIconPath(),
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
        } else if (ctrlOrCmd && !input.shift && key === ',') {
          event.preventDefault();
          lifecycle.sendOrBufferRendererEvent('app:open-settings', undefined);
        }
      }
    );
  }

  const distHtml = DIST_INDEX_HTML_PATH;
  const isPackagedBuild = Boolean(app?.isPackaged);
  const devStartUrl = resolveTrustedDevStartUrl(process.env.ELECTRON_START_URL, isPackagedBuild);

  // Strictly lock top-frame navigation & redirects to the trusted app origin; route safe external URIs to OS shell
  const guardMainWindowNavigation = (
    /** @type {any} */ event,
    /** @type {unknown} */ targetUrl,
    /** @type {boolean | undefined} */ isMainFrame
  ) => {
    const isTopFrame =
      isMainFrame !== undefined
        ? Boolean(isMainFrame)
        : !event?.frame || event.frame === mainWindow?.webContents?.mainFrame;
    if (!isTopFrame) {
      return;
    }
    if (
      isTrustedAppRendererUrl(targetUrl, {
        isPackaged: isPackagedBuild,
        allowedDevOrigin: devStartUrl,
        expectedFileHref: EXPECTED_PACKAGED_FILE_HREF,
      })
    ) {
      return;
    }
    event?.preventDefault?.();
    const safeExternalUrl = validateSafeExternalShellUrl(targetUrl);
    if (safeExternalUrl) {
      shell?.openExternal?.(safeExternalUrl);
    }
  };

  mainWindow.webContents.on(
    'will-navigate',
    (
      /** @type {any} */ event,
      /** @type {string} */ targetUrl,
      /** @type {boolean} */ _isInPlace,
      /** @type {boolean} */ isMainFrame
    ) => {
      guardMainWindowNavigation(event, targetUrl, isMainFrame);
    }
  );
  mainWindow.webContents.on(
    'will-redirect',
    (
      /** @type {any} */ event,
      /** @type {string} */ targetUrl,
      /** @type {boolean} */ _isInPlace,
      /** @type {boolean} */ isMainFrame
    ) => {
      guardMainWindowNavigation(event, targetUrl, isMainFrame);
    }
  );

  // Strictly deny arbitrary child popup windows; open validated https/storefront protocol links via OS shell
  mainWindow.webContents.setWindowOpenHandler((/** @type {any} */ { url }) => {
    const safeExternalUrl = validateSafeExternalShellUrl(url);
    if (safeExternalUrl) {
      shell?.openExternal?.(safeExternalUrl);
    }
    return { action: 'deny' };
  });

  if (isPackagedBuild) {
    mainWindow.loadFile(distHtml).catch((err) => {
      diagLog.error('main', 'Failed to load packaged dist/index.html', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  } else if (process.env.NODE_ENV === 'production' || !devStartUrl) {
    if (fs.existsSync(distHtml)) {
      mainWindow.loadFile(distHtml);
    } else if (process.env.NODE_ENV !== 'production') {
      const fallbackDevUrl = 'http://localhost:3000';
      mainWindow.loadURL(fallbackDevUrl).catch(() => {
        const retryTimer = setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(fallbackDevUrl).catch(() => {});
          }
        }, 1000);
        if (typeof retryTimer.unref === 'function') {
          retryTimer.unref();
        }
      });
    }
  } else {
    mainWindow.loadURL(devStartUrl).catch(() => {
      if (fs.existsSync(distHtml) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(distHtml);
      }
    });
  }

  mainWindow.webContents.on('did-start-loading', () => {
    lifecycle.markMainWindowLoading();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    lifecycle.scheduleFallbackFlushAfterDidFinishLoad();
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
    lifecycle.markMainWindowClosed();
    mainWindow = null;
  });
}

// Ensure single application instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    lifecycle.restoreOrCreateMainWindow();
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
    if (process.platform === 'win32') {
      void refreshWindowsStorefrontRegistryCacheAsync().catch(() => {});
      void refreshHostWindowsKnownFoldersAsync().catch(() => {});
      void discoverWindowsLocalDrivesAsync().catch(() => {});
      void warmWindowsUserSidAsync().catch(() => {});
    }

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
        const iconPath = lifecycle.getAppIconPath();
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

    const isMainAppFrameInitiator = (/** @type {any} */ details) =>
      checkMainAppFrameInitiator(details, {
        getMainWindow: () => mainWindow,
        isPackaged: Boolean(app?.isPackaged),
      });

    registerWebRequestHeaderGuards({
      session,
      app,
      getMainWindow: () => mainWindow,
      isMainAppFrameInitiator: (details) => isMainAppFrameInitiator(details),
    });

    createMainWindow();

    installMacApplicationMenu({
      app,
      Menu,
      allowDevTools: !app?.isPackaged || process.env.ONE_LAUNCHER_DEBUG === '1',
      settingsMenuItem: {
        label: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        click: () => {
          lifecycle.restoreOrCreateMainWindow();
          lifecycle.sendOrBufferRendererEvent('app:open-settings', undefined);
        },
      },
    });

    lifecycle.scheduleBackgroundStartupJobs();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        lifecycle.restoreOrCreateMainWindow();
      } else if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        lifecycle.restoreOrCreateMainWindow();
      }
    });
  });
}

app.on('before-quit', (/** @type {any} */ event) => {
  lifecycle.setZeroRendererDaemonActive(false);
  if (lifecycle.hasCompletedSubsystemShutdown()) {
    return;
  }
  if (shutdownInProgressPromise) {
    event?.preventDefault?.();
    return;
  }
  const hasPostWork =
    typeof launcherEngine.hasActivePostSessionWork === 'function' &&
    launcherEngine.hasActivePostSessionWork();
  const hasActiveDownloads =
    typeof launcherEngine.gracefulShutdownDownloads === 'function' &&
    Array.isArray(launcherEngine.getDownloadQueue?.()) &&
    launcherEngine
      .getDownloadQueue()
      .some((/** @type {any} */ t) => t && t.status === 'downloading');

  if (!isQuittingAfterSync && (hasPostWork || hasActiveDownloads)) {
    event?.preventDefault?.();
    isQuittingAfterSync = true;
    const waitPromise =
      hasPostWork && typeof launcherEngine.waitForActivePostSessionWork === 'function'
        ? launcherEngine.waitForActivePostSessionWork(20000)
        : Promise.resolve();
    const downloadPromise =
      hasActiveDownloads && typeof launcherEngine.gracefulShutdownDownloads === 'function'
        ? launcherEngine.gracefulShutdownDownloads(3000)
        : Promise.resolve();
    shutdownInProgressPromise = Promise.allSettled([waitPromise, downloadPromise])
      .catch(() => {})
      .finally(() => {
        lifecycle.runSubsystemShutdownOnce();
        shutdownInProgressPromise = null;
        app.quit();
      });
    return;
  }
  lifecycle.runSubsystemShutdownOnce();
});

app.on('will-quit', () => {
  try {
    lifecycle.runSubsystemShutdownOnce();
    flushDiagnosticLogSync();
  } catch {}
});

process.on('uncaughtException', (err) => {
  try {
    diagLog.error('main', 'Uncaught exception in main process', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    lifecycle.runSubsystemShutdownOnce();
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
    lifecycle.isZeroRendererDaemonActive() ||
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
const trustedIpcMain = wrapIpcMainWithSenderCheck(ipcMain, {
  ...ipcSenderSecurityOptions,
  getMainWindow: () => mainWindow,
});

const { trimStoreSyncIpcMemory } = registerStoreSyncIpcHandlers({
  ipcMain: trustedIpcMain,
  BrowserWindow,
  session,
  getMainWindow: () => mainWindow,
  storeSync,
  launcherEngine,
  options: ipcSenderSecurityOptions,
});

registerLauncherIpcHandlers({
  ipcMain: trustedIpcMain,
  launcherEngine,
  dialog,
  getMainWindow: () => mainWindow,
  options: ipcSenderSecurityOptions,
});

trustedIpcMain.handle(
  'launcher:toggle-session-fullscreen',
  async (/** @type {any} */ _event, /** @type {any} */ payload) => {
    if (typeof payload === 'string') {
      return launcherEngine.toggleSessionFullscreen({ gameId: payload, sessionId: payload });
    }
    const raw = payload && typeof payload === 'object' ? payload : {};
    return launcherEngine.toggleSessionFullscreen({
      ...(typeof raw.sessionId === 'string' && raw.sessionId ? { sessionId: raw.sessionId } : {}),
      ...(typeof raw.gameId === 'string' && raw.gameId ? { gameId: raw.gameId } : {}),
      ...(typeof raw.fullscreen === 'boolean' ? { fullscreen: raw.fullscreen } : {}),
      ...(typeof raw.aspectRatio === 'string' && raw.aspectRatio
        ? { aspectRatio: raw.aspectRatio }
        : {}),
    });
  }
);

registerWindowAndSystemIpcHandlers({
  ipcMain: trustedIpcMain,
  app,
  BrowserWindow,
  getMainWindow: () => mainWindow,
  options: ipcSenderSecurityOptions,
});

registerOfflineVaultIpcHandlers({
  ipcMain: trustedIpcMain,
  offlineVaultService,
  mediaHydrationEngine,
  federator: storefrontFederator,
  getMainWindow: () => mainWindow,
  sendRendererEvent: lifecycle.sendOrBufferRendererEvent,
  options: ipcSenderSecurityOptions,
});

trustedIpcMain.handle(
  'shell:open-external',
  async (/** @type {any} */ _event, /** @type {unknown} */ url) => {
    const safeUrl = validateSafeExternalShellUrl(url);
    if (!safeUrl) {
      return false;
    }
    await shell.openExternal(safeUrl);
    return true;
  }
);

trustedIpcMain.handle(
  'perf:trim-memory',
  async (/** @type {any} */ _event, /** @type {any} */ options) => {
    try {
      launcherEngine.trimLauncherEngineMemory?.();
    } catch {}
    try {
      storefrontFederator.trimMemory?.();
    } catch {}
    try {
      offlineVaultService.trimMemory?.();
    } catch {}
    try {
      trimUserOverridesCache();
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
  }
);

trustedIpcMain.handle('app:get-version', () => resolveAppVersionString(app));

trustedIpcMain.handle('app:get-info', () => {
  const version = resolveAppVersionString(app);
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    isUpdatedLaunch: Array.isArray(process.argv) && process.argv.includes('--updated'),
  };
});

trustedIpcMain.handle('app:check-for-updates', async () => {
  const rawRepoSlug = String(
    process.env.ONE_LAUNCHER_GITHUB_REPO || 'Space-Cadet0/One-Launcher'
  ).trim();
  const repoSlug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rawRepoSlug)
    ? rawRepoSlug
    : 'Space-Cadet0/One-Launcher';
  const defaultReleaseUrl = `https://github.com/${repoSlug}/releases`;
  const currentVersion = resolveAppVersionString(app);

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
