const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const storeSync = require('./storeSync.cjs');

// Ensure videos and embedded trailers autoplay smoothly without requiring user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'One Launcher',
    backgroundColor: '#0b0f17',
    titleBarStyle: 'hiddenInset', // Native sleek macOS titlebar
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false, // Allows cross-origin store APIs in native app without browser CORS blocking
    },
  });

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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Intercept YouTube and external video embed requests to allow playback from file:// origins
    const embedFilters = [
      '*://*.youtube.com/*',
      '*://youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://youtube-nocookie.com/*',
      '*://*.wistia.net/*',
      '*://*.fast.wistia.net/*',
    ];

    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: embedFilters },
      (details, callback) => {
        // Crucial: Only rewrite headers for the frame document request itself (subFrame / mainFrame).
        // Preserving original headers for XHR/fetch/chunks prevents YouTube's internal player API from stalling at 0:00.
        if (details.resourceType === 'subFrame' || details.resourceType === 'mainFrame') {
          delete details.requestHeaders['origin'];
          delete details.requestHeaders['Origin'];
          delete details.requestHeaders['referer'];
          delete details.requestHeaders['Referer'];
          details.requestHeaders['Origin'] = 'https://www.gog.com';
          details.requestHeaders['Referer'] = 'https://www.gog.com/';
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    session.defaultSession.webRequest.onHeadersReceived(
      { urls: embedFilters },
      (details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['X-Frame-Options'];
        callback({ responseHeaders });
      }
    );

    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Storefront Native OAuth URLs matching Playnite & Heroic
const STORE_OAUTH_URLS = {
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
    if (storefrontId === 'gog') {
      tokenData = await storeSync.exchangeGogCode(code);
      const account = await storeSync.fetchGogAccount(tokenData.access_token);
      accountName = account.username || 'mike.stokes85';
      avatarUrl = account.avatarUrl;
      games = await storeSync.fetchGogOwnedGames(tokenData.access_token, accountName);
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

    const authWindow = new BrowserWindow({
      width: config.width,
      height: config.height,
      parent: mainWindow,
      modal: true,
      show: true,
      title: `Sign In - ${storefrontId.toUpperCase()}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Chrome user-agent matching Playnite to bypass aggressive bot challenges
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    const handleAuthCodeFound = async (code) => {
      if (!code || resolved) return;
      resolved = true;
      authWindow.close();
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
    });

    authWindow.webContents.on('did-finish-load', async () => {
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
  return processStoreAuth(storefrontId, code);
});

/**
 * Background / Manual sync of store using stored session tokens
 */
ipcMain.handle('store:sync', async (_event, storefrontId) => {
  const savedTokens = storeSync.loadSavedTokens();
  let tokenData = savedTokens[storefrontId];
  if (!tokenData || !tokenData.access_token) {
    return { success: false, error: `No saved credentials found for ${storefrontId}. Please connect in Settings.` };
  }

  try {
    let accountName = 'Verified User';
    let avatarUrl = undefined;
    let games = [];

    if (storefrontId === 'gog') {
      let accessToken = tokenData.access_token;
      try {
        const account = await storeSync.fetchGogAccount(accessToken);
        accountName = account.username || 'mike.stokes85';
        avatarUrl = account.avatarUrl;
        games = await storeSync.fetchGogOwnedGames(accessToken, accountName);
      } catch (err) {
        // Automatically renew token if expired
        if (tokenData.refresh_token) {
          const renewed = await storeSync.renewGogTokens(tokenData.refresh_token);
          accessToken = renewed.access_token;
          const account = await storeSync.fetchGogAccount(accessToken);
          accountName = account.username || 'mike.stokes85';
          avatarUrl = account.avatarUrl;
          games = await storeSync.fetchGogOwnedGames(accessToken, accountName);
        } else {
          throw err;
        }
      }
    } else if (storefrontId === 'epic') {
      let accessToken = tokenData.access_token;
      let accountId = tokenData.account_id;
      accountName = tokenData.displayName || accountId || 'Epic Games User';
      try {
        games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
      } catch (err) {
        // Automatically renew token if expired
        if (tokenData.refresh_token) {
          const renewed = await storeSync.renewEpicTokens(tokenData.refresh_token);
          accessToken = renewed.access_token;
          accountId = renewed.account_id || accountId;
          accountName = renewed.displayName || accountName;
          games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
        } else {
          throw err;
        }
      }
    }

    return { success: true, storefrontId, accountName, avatarUrl, games };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('store:get-tokens', async () => {
  return storeSync.loadSavedTokens();
});

ipcMain.handle('store:clear-tokens', async (_event, storefrontId) => {
  storeSync.clearTokens(storefrontId);
  return { success: true };
});

ipcMain.handle('epic:fetch-achievements', async (_event, { accountId, accessToken }) => {
  try {
    return await storeSync.fetchEpicAchievements(accessToken, accountId);
  } catch (err) {
    console.warn('IPC epic:fetch-achievements warning:', err.message);
    return {};
  }
});

/**
 * Native Scanner for installed Steam games directly from local OS filesystem
 */
ipcMain.handle('scan:steam-installed', async () => {
  try {
    const home = os.homedir();
    const steamDirs = [
      path.join(home, 'Library/Application Support/Steam/steamapps'),
      path.join(home, '.local/share/Steam/steamapps'),
      path.join(home, '.steam/steam/steamapps'),
      'C:\\Program Files (x86)\\Steam\\steamapps',
    ];

    const installedSteamAppIds = [];
    const installedGames = [];
    for (const dir of steamDirs) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const match = file.match(/^appmanifest_(\d+)\.acf$/);
            if (match) {
              const appId = parseInt(match[1], 10);
              let gameName = undefined;
              let installDir = undefined;
              try {
                const manifestContent = fs.readFileSync(path.join(dir, file), 'utf-8');
                const nameMatch = manifestContent.match(/"name"\s+"([^"]+)"/i);
                if (nameMatch) gameName = nameMatch[1];
                const dirMatch = manifestContent.match(/"installdir"\s+"([^"]+)"/i);
                if (dirMatch) installDir = path.join(dir, 'common', dirMatch[1]);
              } catch {}

              if (!installedSteamAppIds.includes(appId)) {
                installedSteamAppIds.push(appId);
                installedGames.push({ appId, name: gameName, installPath: installDir });
              }
            }
          }
        } catch {}
      }
    }
    return { success: true, installedSteamAppIds, installedGames };
  } catch (err) {
    return { success: false, error: err.message, installedSteamAppIds: [], installedGames: [] };
  }
});

/**
 * Native Scanner for Steam achievements directly from local Steam client userdata
 */
ipcMain.handle('scan:steam-achievements', async () => {
  try {
    const home = os.homedir();
    const steamUserDirs = [
      path.join(home, 'Library/Application Support/Steam/userdata'),
      path.join(home, '.local/share/Steam/userdata'),
      path.join(home, '.steam/steam/userdata'),
      'C:\\Program Files (x86)\\Steam\\userdata',
    ];

    const achievements = {};

    for (const base of steamUserDirs) {
      if (!fs.existsSync(base)) continue;
      try {
        const userFolders = fs.readdirSync(base);
        for (const u of userFolders) {
          const lcDir = path.join(base, u, 'config/librarycache');
          if (!fs.existsSync(lcDir)) continue;

          // 1. Check achievement_progress.json
          const progressFile = path.join(lcDir, 'achievement_progress.json');
          if (fs.existsSync(progressFile)) {
            try {
              const raw = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
              if (Array.isArray(raw.mapCache)) {
                for (const [appId, data] of raw.mapCache) {
                  if (data && typeof data.unlocked === 'number' && typeof data.total === 'number') {
                    achievements[appId] = {
                      unlocked: data.unlocked,
                      total: data.total,
                      percentage: data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0,
                    };
                  }
                }
              }
            } catch {}
          }

          // 2. Scan all <appId>.json in librarycache
          const files = fs.readdirSync(lcDir);
          for (const file of files) {
            const m = file.match(/^(\d+)\.json$/);
            if (!m) continue;
            const appId = parseInt(m[1], 10);
            try {
              const content = fs.readFileSync(path.join(lcDir, file), 'utf8');
              const mTotal = content.match(/"nTotal"\s*:\s*(\d+)/);
              const mAchieved = content.match(/"nAchieved"\s*:\s*(\d+)/);
              if (mTotal || mAchieved) {
                const total = mTotal ? parseInt(mTotal[1], 10) : 0;
                const unlocked = mAchieved ? parseInt(mAchieved[1], 10) : 0;
                if (total > 0 || unlocked > 0) {
                  if (!achievements[appId] || unlocked >= achievements[appId].unlocked) {
                    achievements[appId] = {
                      unlocked,
                      total: total > 0 ? total : (achievements[appId]?.total || unlocked),
                      percentage: total > 0 ? Math.round((unlocked / total) * 100) : 0,
                    };
                  }
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
    return { success: true, achievements };
  } catch (err) {
    return { success: false, error: err.message, achievements: {} };
  }
});

/**
 * Open URL in user's default external browser (e.g. YouTube trailers)
 */
ipcMain.handle('shell:open-external', async (_event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    await require('electron').shell.openExternal(url);
    return true;
  }
  return false;
});

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

