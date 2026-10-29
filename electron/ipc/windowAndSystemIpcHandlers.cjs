// @ts-check
'use strict';

const { compareSemver } = require('../utils/semverUtils.cjs');
const { isAllowedHttpsHost } = require('../launcher/securityAndPathUtils.cjs');

const ALLOWED_GITHUB_RELEASE_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const ARM64_RELEASE_ASSET_RE = /(?:^|[-_.])(?:arm64|aarch64|apple[-_.]?silicon)(?=[-_.])/i;
const X64_RELEASE_ASSET_RE = /(?:^|[-_.])(?:x64|x86_64|amd64|intel)(?=[-_.])/i;
const UNIVERSAL_RELEASE_ASSET_RE = /(?:^|[-_.])universal(?=[-_.])/i;

/**
 * Validate that a release page or binary asset URL uses `https:` on an official GitHub domain.
 *
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isSafeGitHubReleaseUrl(urlStr) {
  return isAllowedHttpsHost(urlStr, ALLOWED_GITHUB_RELEASE_HOSTS);
}

/**
 * Architecture-aware GitHub Release installer selector (`darwin` `arm64`/`x64`, `win32` `x64`/`arm64`).
 * Ensures Intel (`x64`) Macs are never offered incompatible Apple Silicon (`arm64`-only) DMGs,
 * and rejects any asset whose `browser_download_url` points outside official GitHub HTTPS hosts.
 *
 * @param {Array<{ name?: string, browser_download_url?: string }>} assets
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {{ name: string, browser_download_url?: string } | null}
 */
function selectPlatformReleaseAsset(assets, platform = process.platform, arch = process.arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const validAssets = /** @type {Array<{ name: string, browser_download_url?: string }>} */ (
    assets.filter(
      (a) =>
        a &&
        typeof a.name === 'string' &&
        a.name.trim().length > 0 &&
        !/\.blockmap$/i.test(a.name) &&
        (!a.browser_download_url || isSafeGitHubReleaseUrl(a.browser_download_url))
    )
  );

  if (platform === 'win32') {
    const exeCandidates = validAssets.filter((a) => {
      if (!/\.exe$/i.test(a.name) || /uninstaller/i.test(a.name)) return false;
      if (arch === 'x64' && ARM64_RELEASE_ASSET_RE.test(a.name)) return false;
      if (arch === 'arm64' && X64_RELEASE_ASSET_RE.test(a.name)) return false;
      return true;
    });
    return (
      exeCandidates.find((a) => /setup.*\.exe$/i.test(a.name)) ||
      exeCandidates[0] ||
      null
    );
  }

  if (platform === 'darwin') {
    const dmgCandidates = validAssets.filter((a) => /\.dmg$/i.test(a.name));
    if (dmgCandidates.length === 0) return null;

    if (arch === 'arm64') {
      return (
        dmgCandidates.find((a) => ARM64_RELEASE_ASSET_RE.test(a.name)) ||
        dmgCandidates.find((a) => UNIVERSAL_RELEASE_ASSET_RE.test(a.name)) ||
        dmgCandidates.find(
          (a) => !ARM64_RELEASE_ASSET_RE.test(a.name) && !X64_RELEASE_ASSET_RE.test(a.name)
        ) ||
        null
      );
    }

    // Intel (`x64`) macOS: prefer explicit x64/intel -> universal -> arch-neutral `.dmg`; NEVER select arm64-only DMG
    return (
      dmgCandidates.find(
        (a) => X64_RELEASE_ASSET_RE.test(a.name) && !ARM64_RELEASE_ASSET_RE.test(a.name)
      ) ||
      dmgCandidates.find((a) => UNIVERSAL_RELEASE_ASSET_RE.test(a.name)) ||
      dmgCandidates.find((a) => !ARM64_RELEASE_ASSET_RE.test(a.name)) ||
      null
    );
  }

  return null;
}

/**
 * Window Chrome, Fullscreen & Menu Action IPC Handlers
 * Extracted from electron/main.cjs for clean modular boundary separation.
 *
 * @param {{ ipcMain: any, app: any, getMainWindow: () => any }} deps
 */
function registerWindowAndSystemIpcHandlers({ ipcMain, app, getMainWindow }) {
  if (!ipcMain) return;

  ipcMain.handle('window:toggle-fullscreen', () => {
    const mainWindow = getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });

  ipcMain.handle('window:is-fullscreen', () => {
    const mainWindow = getMainWindow?.();
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen());
  });

  ipcMain.handle('window:minimize', () => {
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
    return true;
  });

  ipcMain.handle('window:maximize-toggle', () => {
    const mainWindow = getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });

  ipcMain.handle('window:is-maximized', () => {
    const mainWindow = getMainWindow?.();
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
  });

  ipcMain.handle('window:close', () => {
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    return true;
  });

  ipcMain.handle('window:perform-menu-action', (/** @type {any} */ _event, /** @type {unknown} */ action) => {
    const mainWindow = getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const act = String(action || '').toLowerCase().trim();
    switch (act) {
      case 'reload':
        mainWindow.webContents.reload();
        return true;
      case 'force-reload':
        mainWindow.webContents.reloadIgnoringCache();
        return true;
      case 'toggle-devtools':
        if (!app?.isPackaged || process.env.ONE_LAUNCHER_DEBUG === '1') {
          mainWindow.webContents.toggleDevTools();
          return true;
        }
        return false;
      case 'reset-zoom':
        mainWindow.webContents.setZoomLevel(0);
        return true;
      case 'zoom-in':
        mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
        return true;
      case 'zoom-out':
        mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5);
        return true;
      case 'toggle-fullscreen':
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
        return true;
      case 'undo':
        mainWindow.webContents.undo();
        return true;
      case 'redo':
        mainWindow.webContents.redo();
        return true;
      case 'cut':
        mainWindow.webContents.cut();
        return true;
      case 'copy':
        mainWindow.webContents.copy();
        return true;
      case 'paste':
        mainWindow.webContents.paste();
        return true;
      case 'select-all':
        mainWindow.webContents.selectAll();
        return true;
      case 'minimize':
        mainWindow.minimize();
        return true;
      case 'maximize-toggle':
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
        return true;
      case 'close':
      case 'quit':
        app?.quit?.();
        return true;
      default:
        return false;
    }
  });
}

module.exports = {
  registerWindowAndSystemIpcHandlers,
  compareSemver,
  ALLOWED_GITHUB_RELEASE_HOSTS,
  isSafeGitHubReleaseUrl,
  selectPlatformReleaseAsset,
};
