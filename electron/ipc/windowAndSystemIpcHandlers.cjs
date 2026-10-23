'use strict';

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

/**
 * Window Chrome, Fullscreen & Menu Action IPC Handlers
 * Extracted from electron/main.cjs for clean modular boundary separation.
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

  ipcMain.handle('window:perform-menu-action', (_event, action) => {
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
        mainWindow.webContents.toggleDevTools();
        return true;
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
};
