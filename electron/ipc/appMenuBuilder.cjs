// @ts-check
'use strict';

/**
 * Build the macOS application menu template, accepting the Settings menu item
 * constructed by the main process entry point.
 *
 * @param {{
 *   app: any,
 *   allowDevTools: boolean,
 *   settingsMenuItem: Record<string, any>,
 * }} opts
 * @returns {any[]}
 */
function buildMacApplicationMenuTemplate({ app, allowDevTools, settingsMenuItem }) {
  return [
    {
      label: app?.name || 'One Launcher',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsMenuItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(allowDevTools ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}

/**
 * Install the native macOS application menu when running on `darwin`.
 *
 * @param {{
 *   app: any,
 *   Menu: any,
 *   allowDevTools: boolean,
 *   settingsMenuItem: Record<string, any>,
 * }} opts
 */
function installMacApplicationMenu({ app, Menu, allowDevTools, settingsMenuItem }) {
  if (
    process.platform !== 'darwin' ||
    !Menu ||
    typeof Menu.buildFromTemplate !== 'function' ||
    typeof Menu.setApplicationMenu !== 'function'
  ) {
    return;
  }
  try {
    const template = buildMacApplicationMenuTemplate({
      app,
      allowDevTools,
      settingsMenuItem,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch {}
}

module.exports = {
  buildMacApplicationMenuTemplate,
  installMacApplicationMenu,
};
