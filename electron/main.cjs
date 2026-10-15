const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const storeSync = require('./storeSync.cjs');
const launcherEngine = require('./launcherEngine.cjs');

// Ensure videos and embedded trailers autoplay smoothly without requiring user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
launcherEngine.setMainWindowGetter(() => mainWindow);

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
      webSecurity: true, // Secure webSecurity enabled; cross-origin requests handled via IPC and onHeadersReceived
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

        // Steam age-gate cookies for store.steampowered.com only (never api.steampowered.com or login.steampowered.com)
        if (url.includes('store.steampowered.com')) {
          const existingCookie = details.requestHeaders['Cookie'] || details.requestHeaders['cookie'] || '';
          delete details.requestHeaders['cookie'];
          const steamMature = 'birthtime=568022401; mature_content=1; wants_mature_content=1';
          if (!existingCookie) {
            details.requestHeaders['Cookie'] = steamMature;
          } else {
            let updated = existingCookie;
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

/**
 * Read local Steam playtimes (Playtime + PlaytimeDisconnected) from localconfig.vdf
 */
function readLocalSteamPlaytimes() {
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
      if (!fs.existsSync(base)) continue;
      const userFolders = fs.readdirSync(base);
      for (const u of userFolders) {
        const vdfPath = path.join(base, u, 'config/localconfig.vdf');
        if (!fs.existsSync(vdfPath)) continue;
        const vdf = fs.readFileSync(vdfPath, 'utf8');
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
          if (!playtimes[appId] || totalMin >= playtimes[appId].playtimeMinutes) {
            playtimes[appId] = { playtimeMinutes: totalMin, lastPlayedEpoch: lpEpoch };
          }
        }
      }
    }
  } catch {}
  return playtimes;
}

/**
 * Synchronously scan local Steam client userdata librarycache for achievement counts
 */
function scanLocalSteamAchievementsSync() {
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
                  if (data && typeof data.unlocked === 'number' && typeof data.total === 'number' && data.total > 0) {
                    const pct = Math.round((data.unlocked / data.total) * 100);
                    achievements[appId] = {
                      unlocked: data.unlocked,
                      total: data.total,
                      percentage: pct,
                      isMastered: pct === 100,
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
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  return achievements;
}

/**
 * Fetch batch Steam achievement progress using IPlayerService/GetAchievementsProgress/v1 + local Steam cache
 */
async function fetchSteamBatchAchievements(webapiToken, steamId, appIds = []) {
  const achievements = scanLocalSteamAchievementsSync();
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
 * Convert Steam web gameslist JSON into CanonicalGame objects
 */
function parseSteamGamesListJson(rawJsonStr, steamId, personaName, avatarUrl) {
  const parsed = typeof rawJsonStr === 'string' ? JSON.parse(rawJsonStr) : rawJsonStr;
  const rgGames = Array.isArray(parsed?.rgGames)
    ? parsed.rgGames
    : Array.isArray(parsed?.games)
      ? parsed.games
      : Array.isArray(parsed)
        ? parsed
        : [];
  const storeItems = (parsed && typeof parsed.storeItems === 'object' && parsed.storeItems) || {};
  const resolvedName = parsed?.strProfileName || personaName || 'Steam User';
  const localPlaytimes = readLocalSteamPlaytimes();
  const localAchievements = scanLocalSteamAchievementsSync();
  const games = [];

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
    const assetFormat = (si && si.asset_url_format) || `steam/apps/${appId}/\${FILENAME}`;
    const buildAssetUrl = (filename) =>
      `https://shared.akamai.steamstatic.com/store_item_assets/${assetFormat.replace('${FILENAME}', filename)}`;

    const headerFile = (si && si.header) || 'header.jpg';
    const capsuleFile =
      (si && (si.library_capsule_2x || si.library_capsule)) ||
      (typeof g.capsule_filename === 'string' && g.capsule_filename.includes('/')
        ? g.capsule_filename
        : 'library_600x900_2x.jpg');

    games.push({
      id: `steam-${appId}`,
      title,
      sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
      steamAppId: appId,
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: String(appId),
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
      headerImage: buildAssetUrl(headerFile),
      capsuleImage: buildAssetUrl(capsuleFile),
      shortDescription: '',
      releaseDate: 'Released',
      developers: [],
      publishers: [],
      genres: [],
      tags: ['Steam'],
    });
  }

  return {
    accountName: resolvedName,
    accountId: steamId,
    avatarUrl,
    games,
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
          const parsedSteam = parseSteamGamesListJson(
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
  return processStoreAuth(storefrontId, code);
});

/**
 * Background / Manual sync of store using stored session tokens
 */
ipcMain.handle('store:sync', async (_event, storefrontId, fallbackCredentials) => {
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
              const refreshed = parseSteamGamesListJson(
                { rgGames: apiJson.response.games, strProfileName: accountName },
                tokenData.steamId,
                accountName,
                avatarUrl
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

          const ssrResult = await new Promise((resolveSsr) => {
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
              },
            });

            const finish = (val) => {
              if (done) return;
              done = true;
              try {
                if (!bgWin.isDestroyed()) bgWin.destroy();
              } catch {}
              resolveSsr(val);
            };

            const timer = setTimeout(() => finish(null), 12000);

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
                  clearTimeout(timer);
                  finish(extracted);
                }
              } catch {}
            });

            bgWin.loadURL('https://steamcommunity.com/my/games/?tab=all').catch(() => {
              clearTimeout(timer);
              finish(null);
            });
          });

          if (ssrResult && Array.isArray(ssrResult.rgGames) && ssrResult.rgGames.length > 0) {
            const refreshed = parseSteamGamesListJson(
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
          }
        } catch {}
      }

      let steamAchMap = {};
      if (Array.isArray(games) && games.length > 0) {
        const localPlaytimes = readLocalSteamPlaytimes();
        const appIds = games
          .map((g) => Number(g.steamAppId || (String(g.id || '').startsWith('steam-') ? String(g.id).replace('steam-', '') : 0)))
          .filter((id) => id > 0);
        steamAchMap = await fetchSteamBatchAchievements(tokenData.webapi_token, tokenData.steamId, appIds);

        games = games.map((g) => {
          const appId = Number(g.steamAppId || (String(g.id || '').startsWith('steam-') ? String(g.id).replace('steam-', '') : 0));
          const localPt = appId ? localPlaytimes[appId] : null;
          const ach = appId ? steamAchMap[appId] : null;
          if ((!localPt || !localPt.playtimeMinutes) && !ach) return g;
          return {
            ...g,
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
      return {
        success: true,
        storefrontId,
        accountName,
        accountId,
        avatarUrl,
        games,
        achievements: storeSync.fetchGogOwnedGames.lastAchievementsMap || {},
      };
    } else if (storefrontId === 'epic') {
      let accessToken = tokenData.access_token || fallbackCredentials?.epicToken;
      let accountId = tokenData.account_id || fallbackCredentials?.epicAccountId;
      accountName = tokenData.displayName || accountId || 'Epic Games User';
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
            const renewed = await storeSync.renewEpicTokens(refreshCand);
            accessToken = renewed.access_token;
            accountId = renewed.account_id || accountId;
            accountName = renewed.displayName || accountName;
            games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
          } else {
            throw err;
          }
        }
      }
      return {
        success: true,
        storefrontId,
        accountName,
        accountId,
        avatarUrl,
        games,
        achievements: storeSync.fetchEpicOwnedGames.lastAchievementsMap || {},
      };
    }

    return { success: true, storefrontId, accountName, avatarUrl, games, achievements: {} };
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

ipcMain.handle('epic:fetch-achievements', async (_event, { accountId, accessToken } = {}) => {
  try {
    const savedTokens = storeSync.loadSavedTokens();
    const savedEpic = savedTokens?.epic || {};
    let resolvedAccountId = accountId || savedEpic.account_id;
    let resolvedToken = accessToken || savedEpic.access_token;
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
 * Native Scanner for installed Steam, GOG, and Epic games directly from local OS filesystem
 */
ipcMain.handle('scan:steam-installed', async () => {
  return launcherEngine.scanAllInstalledGames();
});

/**
 * Native Scanner for Steam achievements directly from local Steam client userdata
 */
ipcMain.handle('scan:steam-achievements', async () => {
  try {
    const achievements = scanLocalSteamAchievementsSync();
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
    url &&
    (url.startsWith('https://') ||
      url.startsWith('http://') ||
      url.startsWith('steam://') ||
      url.startsWith('goggalaxy://') ||
      url.startsWith('com.epicgames.launcher://'))
  ) {
    await require('electron').shell.openExternal(url);
    return true;
  }
  return false;
});

// ============================================================================
// Universal Game Launcher & Install Manager IPC Handlers
// ============================================================================

ipcMain.handle('launcher:scan-installed', async (_event, options) => {
  return launcherEngine.scanAllInstalledGames(options || {});
});

ipcMain.handle('launcher:detect-compat-layers', async (_event, options) => {
  return launcherEngine.detectCompatibilityLayers(options || {});
});

ipcMain.handle('launcher:get-disk-space', async (_event, targetPath) => {
  return launcherEngine.getDiskSpace(targetPath);
});

ipcMain.handle('launcher:get-install-info', async (_event, payload) => {
  return await launcherEngine.getGameInstallInfo(payload || {});
});

ipcMain.handle('launcher:launch-game', async (_event, payload) => {
  return await launcherEngine.launchGame(payload || {});
});

ipcMain.handle('launcher:stop-game', async (_event, payload) => {
  return await launcherEngine.stopGame(payload || {});
});

ipcMain.handle('launcher:get-running-games', async () => {
  return launcherEngine.getRunningGames();
});

ipcMain.handle('launcher:install-game', async (_event, payload) => {
  return await launcherEngine.installGame(payload || {});
});

ipcMain.handle('launcher:pause-download', async (_event, taskId) => {
  return launcherEngine.pauseDownload(taskId);
});

ipcMain.handle('launcher:resume-download', async (_event, taskId) => {
  return launcherEngine.resumeDownload(taskId);
});

ipcMain.handle('launcher:cancel-download', async (_event, taskId) => {
  return launcherEngine.cancelDownload(taskId);
});

ipcMain.handle('launcher:get-download-queue', async () => {
  return launcherEngine.getDownloadQueue();
});

ipcMain.handle('launcher:uninstall-game', async (_event, payload) => {
  return await launcherEngine.uninstallGame(payload || {});
});

ipcMain.handle('launcher:verify-game', async (_event, payload) => {
  return await launcherEngine.verifyGameFiles(payload || {});
});

ipcMain.handle('launcher:browse-files', async (_event, targetPath) => {
  return await launcherEngine.browseLocalFiles(targetPath);
});

ipcMain.handle('launcher:select-executable', async (_event, defaultPath) => {
  return await launcherEngine.selectExecutableDialog(defaultPath);
});

ipcMain.handle('launcher:select-folder', async (_event, defaultPath) => {
  return await launcherEngine.selectFolderDialog(defaultPath);
});

ipcMain.handle('launcher:save-launch-config', async (_event, config) => {
  return launcherEngine.saveGameLaunchConfig(config);
});

ipcMain.handle('launcher:get-launch-configs', async () => {
  return launcherEngine.getGameLaunchConfigs();
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

