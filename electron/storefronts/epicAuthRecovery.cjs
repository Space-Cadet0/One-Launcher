// @ts-check
'use strict';

const GOG_OAUTH_CLIENT_ID =
  String(process.env.ONE_LAUNCHER_GOG_CLIENT_ID || '').trim() || '46899977096215655';
const EPIC_OAUTH_CLIENT_ID =
  String(process.env.ONE_LAUNCHER_EPIC_CLIENT_ID || '').trim() ||
  '34a02cf8f4414e29b15921876da36f9a';

/** @type {Record<string, { url: string, successPrefix: string, width: number, height: number }>} */
const STORE_OAUTH_URLS = {
  steam: {
    url: 'https://steamcommunity.com/login/home/?goto=%2Fmy%2Fgames%2F%3Ftab%3Dall',
    successPrefix: 'https://steamcommunity.com/profiles/',
    width: 620,
    height: 740,
  },
  gog: {
    url: `https://login.gog.com/auth?client_id=${encodeURIComponent(GOG_OAUTH_CLIENT_ID)}&layout=client2&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code`,
    successPrefix: 'https://embed.gog.com/on_login_success',
    width: 500,
    height: 680,
  },
  epic: {
    url: `https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D${encodeURIComponent(EPIC_OAUTH_CLIENT_ID)}%26responseType%3Dcode`,
    successPrefix: 'https://localhost/launcher/authorized',
    width: 540,
    height: 720,
  },
  xbox: {
    url: 'https://login.live.com/oauth20_authorize.srf?client_id=00000000402b5328&response_type=code&approval_prompt=auto&scope=service%3A%3Auser.auth.xboxlive.com%3A%3AMBI_SSL&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf',
    successPrefix: 'https://login.live.com/oauth20_desktop.srf',
    width: 520,
    height: 680,
  },
};

/**
 * Builds a platform-accurate browser User-Agent string from `process.platform`.
 *
 * @param {string} [platformOverride]
 * @returns {string}
 */
function buildPlatformBrowserUserAgent(platformOverride = process.platform) {
  const osToken =
    platformOverride === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : platformOverride === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`;
}

/**
 * @param {string} rawUrl
 * @returns {URL | null}
 */
function safeParseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isEpicGamesHost(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return lower === 'epicgames.com' || lower.endsWith('.epicgames.com');
}

const STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT = `
  (async function() {
    for (let attempt = 0; attempt < 10; attempt++) {
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

      const isLoggedIn = Boolean((userCfg && userCfg.logged_in) || resolvedSteamId);
      if (isLoggedIn && !window.location.pathname.includes('/games')) {
        window.location.href = 'https://steamcommunity.com/my/games/?tab=all';
        return { redirecting: true };
      }

      await new Promise(r => setTimeout(r, 350));
    }
    return null;
  })()
`;

const STEAM_SSR_BG_EXTRACTOR_SCRIPT = `
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
`;

/**
 * Create the deduplicated Epic Games silent/interactive OAuth recovery function.
 *
 * @param {{
 *   BrowserWindow: any,
 *   getMainWindow: () => any,
 *   storeSync: any,
 *   launcherEngine: any
 * }} deps
 */
function createEpicAuthRecovery({ BrowserWindow, getMainWindow, storeSync, launcherEngine }) {
  /** @type {Promise<any> | null} */
  let inFlightEpicAuthRecovery = null;

  return async function recoverEpicAuthSession({ allowInteractiveAuth = false } = {}) {
    if (!allowInteractiveAuth && launcherEngine?.isStoreDisconnectedTombstoned?.('epic')) {
      return null;
    }
    if (inFlightEpicAuthRecovery) {
      return inFlightEpicAuthRecovery;
    }

    inFlightEpicAuthRecovery = (async () => {
      const cleanUA = buildPlatformBrowserUserAgent();
      const silentRedirectUrl = `https://www.epicgames.com/id/api/redirect?clientId=${encodeURIComponent(EPIC_OAUTH_CLIENT_ID)}&responseType=code`;

      /**
       * @param {any} win
       * @param {string} targetUrl
       * @param {number} timeoutMs
       * @param {boolean} interactive
       * @returns {Promise<string | null>}
       */
      const extractEpicAuthCodeFromWindow = (win, targetUrl, timeoutMs, interactive) =>
        new Promise((resolveCode) => {
          if (!BrowserWindow) {
            resolveCode(null);
            return;
          }
          let settled = false;
          /** @type {ReturnType<typeof setTimeout> | null} */
          let timer = null;

          /** @param {string | null} code */
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

          /** @param {string} url */
          const checkUrl = (url) => {
            if (!url || settled) return false;
            const parsed = safeParseUrl(url);
            if (
              parsed &&
              (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
              parsed.hostname.toLowerCase() === 'localhost' &&
              parsed.pathname === '/launcher/authorized'
            ) {
              const code = parsed.searchParams.get('code');
              if (code && /^[a-fA-F0-9]{32}$/.test(code)) {
                finish(code);
                return true;
              }
            }
            return false;
          };

          const checkBodyForCode = async () => {
            if (settled || !win || win.isDestroyed()) return;
            const currentUrl = win.webContents.getURL() || '';
            if (checkUrl(currentUrl)) return;
            const parsedCurrent = safeParseUrl(currentUrl);
            if (!parsedCurrent || parsedCurrent.protocol !== 'https:') return;

            const host = parsedCurrent.hostname.toLowerCase();
            const pathname = parsedCurrent.pathname || '';
            if (
              !interactive &&
              isEpicGamesHost(host) &&
              (pathname.startsWith('/id/login') || pathname.startsWith('/login'))
            ) {
              finish(null);
              return;
            }
            if (isEpicGamesHost(host) && pathname.startsWith('/id/api/redirect')) {
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

          win.webContents.on('will-prevent-unload', (/** @type {any} */ event) => {
            event.preventDefault();
          });
          win.webContents.on('will-redirect', (/** @type {any} */ _e, /** @type {string} */ url) =>
            checkUrl(url)
          );
          win.webContents.on('will-navigate', (/** @type {any} */ _e, /** @type {string} */ url) =>
            checkUrl(url)
          );
          win.webContents.on(
            'did-navigate',
            async (/** @type {any} */ _e, /** @type {string} */ url) => {
              if (!checkUrl(url)) {
                await checkBodyForCode();
              }
            }
          );
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
        let authCode = null;
        try {
          const silentWin = new BrowserWindow({
            width: 540,
            height: 720,
            show: false,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              partition: 'persist:storefront_auth',
              userAgent: cleanUA,
            },
          });
          authCode = await extractEpicAuthCodeFromWindow(silentWin, silentRedirectUrl, 6000, false);
        } catch {}

        if (!authCode && allowInteractiveAuth) {
          try {
            const currentMain = getMainWindow?.();
            const parentWin =
              currentMain && !currentMain.isDestroyed() ? currentMain : undefined;
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
                sandbox: true,
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
            if (typeof storeSync.saveTokensAsync === 'function') {
              await storeSync.saveTokensAsync('epic', tokenData);
            } else {
              storeSync.saveTokens('epic', tokenData);
            }
            return tokenData;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[recoverEpicAuthSession] warning:', msg);
      }

      return null;
    })().finally(() => {
      inFlightEpicAuthRecovery = null;
    });

    return inFlightEpicAuthRecovery;
  };
}

module.exports = {
  STORE_OAUTH_URLS,
  STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT,
  STEAM_SSR_BG_EXTRACTOR_SCRIPT,
  buildPlatformBrowserUserAgent,
  createEpicAuthRecovery,
};
