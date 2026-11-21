// @ts-check
'use strict';

const { isAllowedHttpsHost } = require('../../launcher/securityAndPathUtils.cjs');
const { sanitizeRendererIpcOptions } = require('../launcher/launchApprovalIpc.cjs');
const {
  readLocalSteamPlaytimes,
  scanLocalSteamAchievements,
  fetchSteamBatchAchievements,
  fetchSteamStoreBrowseItemsMap,
  parseSteamGamesListJson,
} = require('../../storefronts/steamLocalScanner.cjs');
const {
  fetchSteamDetailedGameAchievements,
} = require('../../storefronts/steamAchievementsProvider.cjs');
const { STEAM_SSR_BG_EXTRACTOR_SCRIPT } = require('../../storefronts/epicAuthRecovery.cjs');
const {
  isNetworkOnlineForStoreSync,
  isOfflineOrNetworkError,
  readSyncResultMeta,
  isRealSecretToken,
  resolveStorefrontOAuthPartition,
  resolvePartitionsToClearForStorefront,
  clearOAuthPopupSessionCaches,
  isAuthenticatedSteamCommunityUrl,
  resolveCleanBrowserUserAgent,
  sanitizeStoreTokenEntryForRenderer,
} = require('./oauthPopupWindows.cjs');

const STEAM_GET_OWNED_GAMES_TIMEOUT_MS = 10_000;
const STEAM_SSR_NAV_ALLOWLIST = Object.freeze([
  'steamcommunity.com',
  'store.steampowered.com',
  'steampowered.com',
  'login.steampowered.com',
]);

/**
 * Return the first Steam browser partition holding an authenticated `steamLoginSecure` cookie,
 * or `null` if none is present.
 *
 * @param {any} sessionMod
 * @returns {Promise<string | null>}
 */
async function findSteamSessionCookiePartition(sessionMod) {
  if (!sessionMod || typeof sessionMod.fromPartition !== 'function') return null;
  const partitions = Array.from(
    new Set([resolveStorefrontOAuthPartition('steam'), 'persist:storefront_auth'])
  );
  for (const partition of partitions) {
    try {
      const partSession = sessionMod.fromPartition(partition);
      if (!partSession?.cookies || typeof partSession.cookies.get !== 'function') continue;
      const cookies = await partSession.cookies.get({ domain: 'steamcommunity.com' });
      if (
        Array.isArray(cookies) &&
        cookies.some(
          (/** @type {any} */ c) =>
            c &&
            typeof c.name === 'string' &&
            c.name === 'steamLoginSecure' &&
            typeof c.value === 'string' &&
            c.value.trim().length > 0
        )
      ) {
        return partition;
      }
    } catch {}
  }
  return null;
}

/**
 * Register storefront token management, library sync, achievement, metadata, and IGDB IPC handlers.
 *
 * @param {{
 *   ipcMain: any,
 *   BrowserWindow: any,
 *   session: any,
 *   storeSync: any,
 *   launcherEngine: any,
 *   processStoreAuth: (storefrontId: string, codeOrPayload: any) => Promise<any>,
 *   handlerOptions?: Record<string, any>,
 * }} deps
 */
function registerStorefrontCatalogIpcHandlers({
  ipcMain,
  BrowserWindow,
  session,
  storeSync,
  launcherEngine,
  processStoreAuth,
  handlerOptions = {},
}) {
  ipcMain.handle(
    'store:exchange-code',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPayload = {}) => {
      const cleanPayload =
        rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
          ? /** @type {{ storefrontId?: string, code?: string }} */ (rawPayload)
          : {};
      const storefrontId =
        typeof cleanPayload.storefrontId === 'string' ? cleanPayload.storefrontId.trim() : '';
      const code = typeof cleanPayload.code === 'string' ? cleanPayload.code : '';
      if (!storefrontId) {
        return { success: false, error: 'Missing storefrontId for code exchange.' };
      }
      const res = await processStoreAuth(storefrontId, code);
      if (res && res.success) {
        try {
          launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
        } catch {}
      }
      return res;
    }
  );

  /** @type {Map<string, Promise<any>>} */
  const inFlightStoreSyncs = new Map();

  ipcMain.handle(
    'store:sync',
    async (
      /** @type {any} */ _event,
      /** @type {string} */ storefrontId,
      /** @type {Record<string, any> | undefined} */ rawFallbackCredentials
    ) => {
      const fallbackCredentials =
        rawFallbackCredentials &&
        typeof rawFallbackCredentials === 'object' &&
        !Array.isArray(rawFallbackCredentials)
          ? sanitizeRendererIpcOptions(rawFallbackCredentials)
          : undefined;
      const syncKey = String(storefrontId || '').toLowerCase().trim() || 'default';
      if (inFlightStoreSyncs.has(syncKey)) {
        return inFlightStoreSyncs.get(syncKey);
      }

      const syncPromise = (async () => {
        const savedTokens = storeSync.loadSavedTokens();
        let tokenData = savedTokens[storefrontId] || {};
        const cleanFallbackEpicToken = isRealSecretToken(fallbackCredentials?.epicToken)
          ? fallbackCredentials.epicToken.trim()
          : '';
        const cleanFallbackEpicRefresh = isRealSecretToken(fallbackCredentials?.epicRefreshToken)
          ? fallbackCredentials.epicRefreshToken.trim()
          : '';
        const cleanFallbackGogToken = isRealSecretToken(fallbackCredentials?.gogToken)
          ? fallbackCredentials.gogToken.trim()
          : '';

        const hasSavedSteamId =
          storefrontId === 'steam' &&
          typeof tokenData.steamId === 'string' &&
          tokenData.steamId.trim().length > 0;
        const steamCookiePartition =
          storefrontId === 'steam' ? await findSteamSessionCookiePartition(session) : null;

        if (
          !isRealSecretToken(tokenData.access_token) &&
          !isRealSecretToken(tokenData.xblAccessToken) &&
          !isRealSecretToken(tokenData.userStsLegacyTokenXml) &&
          !isRealSecretToken(tokenData.msaRefreshToken) &&
          !isRealSecretToken(tokenData.refresh_token) &&
          !isRealSecretToken(tokenData.webapi_token) &&
          !isRealSecretToken(tokenData.apiKey) &&
          !cleanFallbackEpicToken &&
          !cleanFallbackGogToken &&
          !hasSavedSteamId &&
          !steamCookiePartition
        ) {
          return {
            success: false,
            error: `No saved credentials found for ${storefrontId}. Please connect in Settings.`,
          };
        }

        try {
          let accountName = 'Verified User';
          let avatarUrl;
          /** @type {any[]} */
          let games = [];

          if (storefrontId === 'steam') {
            const steamCacheOpts = handlerOptions.userDataDir
              ? { userDataDir: handlerOptions.userDataDir }
              : {};
            const steamFetchImpl =
              typeof handlerOptions.fetchFn === 'function' ? handlerOptions.fetchFn : fetch;
            const steamTimeoutMs =
              typeof handlerOptions.steamTimeoutMs === 'number' && handlerOptions.steamTimeoutMs > 0
                ? handlerOptions.steamTimeoutMs
                : STEAM_GET_OWNED_GAMES_TIMEOUT_MS;
            accountName = tokenData.accountName || 'Steam User';
            avatarUrl = tokenData.avatarUrl;
            const initialWebApiToken = tokenData.webapi_token;
            const initialAccountName = tokenData.accountName;
            const initialAvatarUrl = tokenData.avatarUrl;
            const initialSteamId = tokenData.steamId;
            const hadLegacyGamesInVault = Object.prototype.hasOwnProperty.call(tokenData, 'games');

            const loadedCachedGames =
              typeof storeSync.loadSteamOwnedGamesCache === 'function'
                ? storeSync.loadSteamOwnedGamesCache({
                    ...steamCacheOpts,
                    steamId: tokenData.steamId,
                    legacyGames: tokenData.games,
                  })
                : Array.isArray(tokenData.games)
                  ? tokenData.games
                  : [];
            const loadedFromDiskCache = Boolean(
              loadedCachedGames && /** @type {any} */ (loadedCachedGames).fromDiskCache === true
            );
            games = Array.isArray(loadedCachedGames) ? loadedCachedGames : [];
            let refreshedLive = false;
            let networkOfflineDetected = !isNetworkOnlineForStoreSync(handlerOptions);

            const steamWebApiAuthQuery = isRealSecretToken(tokenData.webapi_token)
              ? `access_token=${encodeURIComponent(tokenData.webapi_token.trim())}`
              : isRealSecretToken(tokenData.apiKey)
                ? `key=${encodeURIComponent(tokenData.apiKey.trim())}`
                : '';

            if (!networkOfflineDetected && steamWebApiAuthQuery && tokenData.steamId) {
              try {
                const res = await steamFetchImpl(
                  `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?${steamWebApiAuthQuery}&steamid=${encodeURIComponent(tokenData.steamId)}&include_appinfo=1&include_played_free_games=1&include_free_sub=0`,
                  {
                    signal:
                      typeof AbortSignal !== 'undefined' &&
                      typeof AbortSignal.timeout === 'function'
                        ? AbortSignal.timeout(steamTimeoutMs)
                        : undefined,
                  }
                );
                if (res.ok) {
                  /** @type {{ response?: { games?: Array<{ appid?: number }> } } | null} */
                  const apiJson = /** @type {any} */ (await res.json());
                  if (Array.isArray(apiJson?.response?.games) && apiJson.response.games.length > 0) {
                    const ownedAppIds = apiJson.response.games
                      .map((/** @type {any} */ g) => g.appid)
                      .filter(Boolean);
                    const storeItems = await fetchSteamStoreBrowseItemsMap(ownedAppIds, {
                      ...(typeof handlerOptions.fetchFn === 'function'
                        ? { fetchImpl: handlerOptions.fetchFn }
                        : {}),
                    });
                    const refreshed = await parseSteamGamesListJson(
                      { rgGames: apiJson.response.games, storeItems, strProfileName: accountName },
                      tokenData.steamId,
                      accountName,
                      avatarUrl,
                      games,
                      storeSync
                    );
                    games = refreshed.games;
                    refreshedLive = true;
                  }
                }
              } catch (steamApiErr) {
                if (isOfflineOrNetworkError(steamApiErr)) {
                  networkOfflineDetected = true;
                }
              }
            }

            if (
              !refreshedLive &&
              !networkOfflineDetected &&
              isNetworkOnlineForStoreSync(handlerOptions)
            ) {
              try {
                const cleanBrowserUA = resolveCleanBrowserUserAgent(session);

                /** @type {{ rgGames: any[], storeItems: Record<string, any>, webApiToken?: string, steamId?: string } | null} */
                let ssrResult = null;
                const steamOAuthPartition =
                  steamCookiePartition || resolveStorefrontOAuthPartition('steam');
                const steamCandidatePartitions = Array.from(
                  new Set([
                    ...(steamCookiePartition ? [steamCookiePartition] : []),
                    resolveStorefrontOAuthPartition('steam'),
                    'persist:storefront_auth',
                  ])
                );
                for (const partition of steamCandidatePartitions) {
                  if (ssrResult || networkOfflineDetected) break;
                  try {
                    const authSession = session?.fromPartition?.(partition);
                    if (authSession && typeof authSession.fetch === 'function') {
                      const fetchAbort = new AbortController();
                      const fetchTimer = setTimeout(() => fetchAbort.abort(), 10000);
                      try {
                        const ssrRes = await authSession.fetch(
                          'https://steamcommunity.com/my/games/?tab=all',
                          {
                            signal: fetchAbort.signal,
                            headers: {
                              'User-Agent': cleanBrowserUA,
                              Accept: 'text/html,application/xhtml+xml',
                            },
                          }
                        );
                        const resolvedSsrUrl = String(
                          ssrRes?.url || 'https://steamcommunity.com/my/games/?tab=all'
                        );
                        if (
                          ssrRes &&
                          ssrRes.ok &&
                          isAuthenticatedSteamCommunityUrl(resolvedSsrUrl)
                        ) {
                          const html = await ssrRes.text();
                          const htmlSteamIdMatch = html.match(/g_steamID\s*=\s*"(\d{17})"/);
                          const htmlSteamId = htmlSteamIdMatch ? htmlSteamIdMatch[1] : undefined;
                          const ssrMatch = html.match(
                            /<script\s+id=["']valve-ssr-data["'][^>]*>([\s\S]*?)<\/script>/i
                          );
                          if (ssrMatch && ssrMatch[1]) {
                            try {
                              const ssr = JSON.parse(ssrMatch[1].trim());
                              let webApiToken;
                              let rgGames = null;
                              /** @type {Record<string, any>} */
                              const storeItems = {};
                              const loaderData = Array.isArray(ssr?.loaderData)
                                ? ssr.loaderData
                                : [];
                              for (const item of loaderData) {
                                if (!item) continue;
                                try {
                                  const parsed =
                                    typeof item === 'string' ? JSON.parse(item) : item;
                                  if (parsed && parsed.strWebAPIToken && !webApiToken) {
                                    webApiToken = String(parsed.strWebAPIToken);
                                  }
                                } catch {}
                              }
                              const rawQueryData = ssr?.renderContext?.queryData;
                              if (rawQueryData) {
                                try {
                                  const qd =
                                    typeof rawQueryData === 'string'
                                      ? JSON.parse(rawQueryData)
                                      : rawQueryData;
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
                                ssrResult = {
                                  rgGames,
                                  storeItems,
                                  webApiToken,
                                  ...(htmlSteamId ? { steamId: htmlSteamId } : {}),
                                };
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
                                if (
                                  Array.isArray(parsedLegacy?.rgGames) &&
                                  parsedLegacy.rgGames.length > 0
                                ) {
                                  ssrResult = {
                                    rgGames: parsedLegacy.rgGames,
                                    storeItems: parsedLegacy.storeItems || {},
                                    webApiToken:
                                      parsedLegacy.strWebAPIToken || parsedLegacy.webapi_token,
                                    ...(htmlSteamId ? { steamId: htmlSteamId } : {}),
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
                  } catch (ssrErr) {
                    if (isOfflineOrNetworkError(ssrErr)) {
                      networkOfflineDetected = true;
                    }
                  }
                }

                if (ssrResult && Array.isArray(ssrResult.rgGames) && ssrResult.rgGames.length > 0) {
                  const resolvedSteamId = tokenData.steamId || ssrResult.steamId;
                  const refreshed = await parseSteamGamesListJson(
                    {
                      rgGames: ssrResult.rgGames,
                      strProfileName: accountName,
                      storeItems: ssrResult.storeItems || {},
                    },
                    resolvedSteamId,
                    accountName,
                    avatarUrl,
                    games,
                    storeSync
                  );
                  games = refreshed.games;
                  tokenData = {
                    ...tokenData,
                    ...(resolvedSteamId ? { steamId: resolvedSteamId } : {}),
                    webapi_token: ssrResult.webApiToken || tokenData.webapi_token,
                  };
                  refreshedLive = true;
                }

                if (
                  !refreshedLive &&
                  !networkOfflineDetected &&
                  isNetworkOnlineForStoreSync(handlerOptions) &&
                  BrowserWindow
                ) {
                  ssrResult = await new Promise((resolveSsr) => {
                    let done = false;
                    const bgWin = new BrowserWindow({
                      width: 1024,
                      height: 768,
                      show: false,
                      webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                        partition: steamOAuthPartition,
                        userAgent: cleanBrowserUA,
                        images: false,
                        spellcheck: false,
                        backgroundThrottling: true,
                        v8CacheOptions: 'none',
                      },
                    });
                    if (typeof bgWin.webContents?.setUserAgent === 'function' && cleanBrowserUA) {
                      bgWin.webContents.setUserAgent(cleanBrowserUA);
                    }
                    if (typeof bgWin.webContents?.setWindowOpenHandler === 'function') {
                      bgWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                    }
                    bgWin.webContents?.on?.(
                      'will-navigate',
                      (/** @type {any} */ event, /** @type {string} */ targetUrl) => {
                        if (
                          targetUrl !== 'about:blank' &&
                          !isAllowedHttpsHost(targetUrl, STEAM_SSR_NAV_ALLOWLIST)
                        ) {
                          event?.preventDefault?.();
                        }
                      }
                    );
                    const bgSession =
                      bgWin.webContents?.session ||
                      session?.fromPartition?.(steamOAuthPartition) ||
                      null;

                    /** @type {ReturnType<typeof setTimeout> | null} */
                    let timer = null;
                    /** @param {any} val */
                    const finish = (val) => {
                      if (done) return;
                      done = true;
                      if (timer) clearTimeout(timer);
                      clearOAuthPopupSessionCaches(bgSession);
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
                      if (!isAuthenticatedSteamCommunityUrl(currentUrl)) {
                        return;
                      }
                      try {
                        const extracted = await bgWin.webContents.executeJavaScript(
                          STEAM_SSR_BG_EXTRACTOR_SCRIPT
                        );
                        if (
                          extracted &&
                          Array.isArray(extracted.rgGames) &&
                          extracted.rgGames.length > 0
                        ) {
                          finish(extracted);
                        }
                      } catch {}
                    });

                    bgWin.loadURL('https://steamcommunity.com/my/games/?tab=all').catch(() => {
                      finish(null);
                    });
                  });

                  if (
                    ssrResult &&
                    Array.isArray(ssrResult.rgGames) &&
                    ssrResult.rgGames.length > 0
                  ) {
                    const resolvedSteamId = tokenData.steamId || ssrResult.steamId;
                    const refreshed = await parseSteamGamesListJson(
                      {
                        rgGames: ssrResult.rgGames,
                        strProfileName: accountName,
                        storeItems: ssrResult.storeItems || {},
                      },
                      resolvedSteamId,
                      accountName,
                      avatarUrl,
                      games,
                      storeSync
                    );
                    games = refreshed.games;
                    tokenData = {
                      ...tokenData,
                      ...(resolvedSteamId ? { steamId: resolvedSteamId } : {}),
                      webapi_token: ssrResult.webApiToken || tokenData.webapi_token,
                    };
                    refreshedLive = true;
                  }
                }
              } catch {}
            }

            if (
              !refreshedLive &&
              games.length === 0 &&
              !networkOfflineDetected &&
              !steamWebApiAuthQuery &&
              !isRealSecretToken(tokenData.access_token)
            ) {
              return {
                success: false,
                error: 'Steam session expired. Please sign in to Steam again in Settings.',
              };
            }

            /** @type {Record<number, any>} */
            let steamAchMap = {};
            let mergedLocalDelta = false;
            if (Array.isArray(games) && games.length > 0) {
              const localPlaytimes = await readLocalSteamPlaytimes();
              const appIds = games
                .map((g) =>
                  Number(
                    g.steamAppId ||
                      (String(g.id || '').startsWith('steam-')
                        ? String(g.id).replace('steam-', '')
                        : 0)
                  )
                )
                .filter((id) => id > 0);
              steamAchMap =
                networkOfflineDetected || !isNetworkOnlineForStoreSync(handlerOptions)
                  ? await scanLocalSteamAchievements({ activeSteamId64: tokenData.steamId })
                  : await fetchSteamBatchAchievements(
                      tokenData.webapi_token,
                      tokenData.steamId,
                      appIds,
                      typeof handlerOptions.fetchFn === 'function'
                        ? { fetchImpl: handlerOptions.fetchFn }
                        : undefined
                    );

              games = games.map((g) => {
                const appId = Number(
                  g.steamAppId ||
                    (String(g.id || '').startsWith('steam-')
                      ? String(g.id).replace('steam-', '')
                      : 0)
                );
                const localPt = appId ? localPlaytimes[appId] : null;
                const ach = appId ? steamAchMap[appId] : null;
                if ((!localPt || !localPt.playtimeMinutes) && !ach) {
                  if (g.isVerifiedEntitlement === true) return g;
                  mergedLocalDelta = true;
                  return { ...g, isVerifiedEntitlement: true };
                }
                let gameChanged = g.isVerifiedEntitlement !== true;
                const nextPlatforms = (g.platforms || []).map((/** @type {any} */ p) => {
                  if (p.platformId !== 'steam') return p;
                  const prevPt = Number(p.playtimeMinutes || 0);
                  const mergedPt =
                    localPt && localPt.playtimeMinutes
                      ? Math.max(prevPt, localPt.playtimeMinutes)
                      : prevPt;
                  const existingAch = p.achievements;
                  let mergedAch = existingAch;
                  let achChanged = false;
                  if (ach && ach.total > 0) {
                    const bestUnlocked = existingAch
                      ? Math.max(ach.unlocked, Number(existingAch.unlocked || 0))
                      : ach.unlocked;
                    const bestTotal = existingAch
                      ? Math.max(ach.total, Number(existingAch.total || 0))
                      : ach.total;
                    const pct = bestTotal > 0 ? Math.round((bestUnlocked / bestTotal) * 100) : 0;
                    const isMastered =
                      Boolean(ach.isMastered) || (bestTotal > 0 && bestUnlocked >= bestTotal);
                    if (
                      !existingAch ||
                      Number(existingAch.unlocked || 0) !== bestUnlocked ||
                      Number(existingAch.total || 0) !== bestTotal ||
                      Number(existingAch.percentage || 0) !== pct ||
                      Boolean(existingAch.isMastered) !== isMastered
                    ) {
                      achChanged = true;
                      mergedAch = {
                        unlocked: bestUnlocked,
                        total: bestTotal,
                        percentage: pct,
                        isMastered,
                      };
                    }
                  }
                  const ptChanged = mergedPt !== prevPt || p.playtimeMinutes !== mergedPt;
                  if (!ptChanged && !achChanged) return p;
                  gameChanged = true;
                  return {
                    ...p,
                    playtimeMinutes: mergedPt,
                    achievements: mergedAch,
                  };
                });
                if (!gameChanged) return g;
                mergedLocalDelta = true;
                return {
                  ...g,
                  isVerifiedEntitlement: true,
                  platforms: nextPlatforms,
                };
              });

              if (
                typeof storeSync.saveSteamOwnedGamesCache === 'function' &&
                (refreshedLive || hadLegacyGamesInVault || !loadedFromDiskCache || mergedLocalDelta)
              ) {
                storeSync.saveSteamOwnedGamesCache(games, {
                  ...steamCacheOpts,
                  steamId: tokenData.steamId,
                });
              }
            }

            const steamCredentialsChanged =
              tokenData.webapi_token !== initialWebApiToken ||
              tokenData.accountName !== initialAccountName ||
              tokenData.avatarUrl !== initialAvatarUrl ||
              tokenData.steamId !== initialSteamId;

            if (steamCredentialsChanged || hadLegacyGamesInVault) {
              const { games: _strippedGames, ...cleanSteamTokens } = tokenData;
              storeSync.saveTokens(
                'steam',
                hadLegacyGamesInVault
                  ? { ...cleanSteamTokens, games: undefined }
                  : cleanSteamTokens
              );
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
                  ? storeSync
                      .scanLocalSuppressedStorefrontItems()
                      .filter((/** @type {any} */ x) => x.platformId === 'steam')
                  : [],
            };
          } else if (storefrontId === 'gog') {
            let accessToken =
              (isRealSecretToken(tokenData.access_token) ? tokenData.access_token : '') ||
              cleanFallbackGogToken;
            let accountId;
            try {
              if (!accessToken) {
                throw new Error('GOG access token missing');
              }
              const account = await storeSync.fetchGogAccount(accessToken);
              accountName = account.username || 'GOG User';
              accountId = account.userId;
              avatarUrl = account.avatarUrl;
              games = await storeSync.fetchGogOwnedGames(accessToken, accountName, account.userId);
            } catch (err) {
              if (isRealSecretToken(tokenData.refresh_token)) {
                const renewed = await storeSync.renewGogTokens(tokenData.refresh_token);
                accessToken = renewed.access_token;
                const account = await storeSync.fetchGogAccount(accessToken);
                accountName = account.username || 'GOG User';
                accountId = account.userId;
                avatarUrl = account.avatarUrl;
                games = await storeSync.fetchGogOwnedGames(
                  accessToken,
                  accountName,
                  account.userId
                );
              } else {
                throw err;
              }
            }
            const localGogSuppressed =
              typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
                ? storeSync
                    .scanLocalSuppressedStorefrontItems({ gogUserId: accountId })
                    .filter((/** @type {any} */ x) => x.platformId === 'gog')
                : [];
            const gogSyncMeta = readSyncResultMeta(games, storeSync.fetchGogOwnedGames);
            const gogAuthoritativeComplete = gogSyncMeta.authoritativeComplete;
            return {
              success: true,
              storefrontId,
              accountName,
              accountId,
              avatarUrl,
              games,
              authoritativeComplete: gogAuthoritativeComplete,
              transientOffline: games.length === 0 && !gogAuthoritativeComplete,
              achievements: gogSyncMeta.achievementsMap,
              suppressedItems: [...gogSyncMeta.suppressedItems, ...localGogSuppressed],
            };
          } else if (storefrontId === 'epic') {
            const epicDisconnected = Boolean(
              launcherEngine?.isStoreDisconnectedTombstoned?.('epic')
            );
            let accessToken =
              (isRealSecretToken(tokenData.access_token) ? tokenData.access_token : '') ||
              cleanFallbackEpicToken;
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
              if (!accessToken) {
                throw new Error('Epic library API unauthorized (missing access token)');
              }
              games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
            } catch (err) {
              let recoveredSync = false;
              if (cleanFallbackEpicToken && cleanFallbackEpicToken !== accessToken) {
                try {
                  accessToken = cleanFallbackEpicToken;
                  games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
                  recoveredSync =
                    games.length > 0 ||
                    readSyncResultMeta(games, storeSync.fetchEpicOwnedGames).authoritativeComplete;
                  storeSync.saveTokens('epic', {
                    ...tokenData,
                    access_token: accessToken,
                    refresh_token: cleanFallbackEpicRefresh || tokenData.refresh_token,
                    account_id: accountId,
                  });
                } catch {
                  games = [];
                }
              }
              if ((!games || games.length === 0) && !recoveredSync) {
                const refreshCand =
                  cleanFallbackEpicRefresh ||
                  (isRealSecretToken(tokenData.refresh_token) ? tokenData.refresh_token : '');
                if (refreshCand) {
                  try {
                    const renewed = await storeSync.renewEpicTokens(refreshCand);
                    accessToken = renewed.access_token;
                    accountId = renewed.account_id || accountId;
                    accountName = renewed.displayName || accountName;
                    games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
                    recoveredSync =
                      games.length > 0 ||
                      readSyncResultMeta(games, storeSync.fetchEpicOwnedGames)
                        .authoritativeComplete;
                  } catch {}
                }
                if (
                  (!games || games.length === 0) &&
                  !recoveredSync &&
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
                } else if ((!games || games.length === 0) && !recoveredSync) {
                  throw err;
                }
              }
            }
            const localEpicSuppressed =
              typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
                ? storeSync
                    .scanLocalSuppressedStorefrontItems({ epicAccountId: accountId })
                    .filter((/** @type {any} */ x) => x.platformId === 'epic')
                : [];
            const epicSyncMeta = readSyncResultMeta(games, storeSync.fetchEpicOwnedGames);
            const epicAuthoritativeComplete = epicSyncMeta.authoritativeComplete;
            return {
              success: true,
              storefrontId,
              accountName,
              accountId,
              avatarUrl,
              games,
              authoritativeComplete: epicAuthoritativeComplete,
              transientOffline: games.length === 0 && !epicAuthoritativeComplete,
              achievements: epicSyncMeta.achievementsMap,
              suppressedItems: [...epicSyncMeta.suppressedItems, ...localEpicSuppressed],
            };
          } else if (storefrontId === 'xbox') {
            const xboxSync = await storeSync.syncXboxLibrary({
              syncMode: fallbackCredentials?.syncMode,
              forceRefresh: Boolean(fallbackCredentials?.forceRefresh),
            });
            const xboxGames = xboxSync.games || [];
            const xboxAuthoritativeComplete = Boolean(xboxSync.authoritativeComplete);
            return {
              success: true,
              storefrontId,
              accountName: xboxSync.accountName,
              accountId: xboxSync.xuid,
              xuid: xboxSync.xuid,
              avatarUrl: xboxSync.avatarUrl,
              gamerscore: xboxSync.gamerscore || 0,
              subscription: xboxSync.subscription,
              syncMode: xboxSync.syncMode,
              authoritativeComplete: xboxAuthoritativeComplete,
              subscriptionChanged: Boolean(xboxSync.subscriptionChanged),
              transientOffline: xboxGames.length === 0 && !xboxAuthoritativeComplete,
              games: xboxGames,
              achievements: xboxSync.achievements || {},
              suppressedItems: xboxSync.suppressedItems || [],
            };
          }

          return { success: true, storefrontId, accountName, avatarUrl, games, achievements: {} };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: msg };
        }
      })().finally(() => {
        inFlightStoreSyncs.delete(syncKey);
        try {
          storeSync.trimStoreSyncMemory?.();
        } catch {}
      });

      inFlightStoreSyncs.set(syncKey, syncPromise);
      return syncPromise;
    }
  );

  const handleGetSavedStoreTokens = async () => {
    const rawLoaded = storeSync.loadSavedTokens() || {};
    /** @type {Record<string, any>} */
    let saved = { ...rawLoaded };

    if (
      (!saved.epic || !isRealSecretToken(saved.epic.access_token)) &&
      !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
      typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
    ) {
      try {
        const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
        if (legAuth?.accessToken) {
          const reloaded = storeSync.loadSavedTokens() || saved;
          saved = { ...reloaded };
          if (!saved.epic || !isRealSecretToken(saved.epic.access_token)) {
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

    if (saved.gog && isRealSecretToken(saved.gog.access_token)) {
      let gogEntry = { ...saved.gog };
      const normalizedExisting =
        typeof storeSync.normalizeGogAvatarUrl === 'function'
          ? storeSync.normalizeGogAvatarUrl(gogEntry.avatarUrl, gogEntry.avatars)
          : gogEntry.avatarUrl;
      if (normalizedExisting && normalizedExisting !== gogEntry.avatarUrl) {
        gogEntry = { ...gogEntry, avatarUrl: normalizedExisting };
        storeSync.saveTokens('gog', gogEntry);
      }
      // Guard live GOG profile/renewal fetches on online connectivity so offline cold boot never stalls
      if ((!gogEntry.avatarUrl || !gogEntry.username) && isNetworkOnlineForStoreSync(handlerOptions)) {
        try {
          const account = await storeSync.fetchGogAccount(gogEntry.access_token);
          if (account) {
            gogEntry = {
              ...gogEntry,
              username: account.username || gogEntry.username,
              avatarUrl: account.avatarUrl || gogEntry.avatarUrl,
              user_id: account.userId || gogEntry.user_id,
            };
            storeSync.saveTokens('gog', gogEntry);
          }
        } catch {
          if (
            isRealSecretToken(gogEntry.refresh_token) &&
            isNetworkOnlineForStoreSync(handlerOptions)
          ) {
            try {
              const renewed = await storeSync.renewGogTokens(gogEntry.refresh_token);
              const account = await storeSync.fetchGogAccount(renewed.access_token);
              gogEntry = {
                ...gogEntry,
                ...renewed,
                username: account?.username || gogEntry.username,
                avatarUrl: account?.avatarUrl || gogEntry.avatarUrl,
                user_id: account?.userId || renewed.user_id || gogEntry.user_id,
              };
              storeSync.saveTokens('gog', gogEntry);
            } catch {}
          }
        }
      }
      saved.gog = gogEntry;
    }

    /** @type {Record<string, any>} */
    const projected = {};
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'suppressedItems') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const redactedEntry = sanitizeStoreTokenEntryForRenderer(key, value, storeSync);
        if (redactedEntry) {
          projected[key] = redactedEntry;
        }
      }
    }

    if (typeof storeSync.scanLocalSuppressedStorefrontItems === 'function') {
      try {
        projected.suppressedItems = storeSync.scanLocalSuppressedStorefrontItems();
      } catch {}
    }

    return projected;
  };
  ipcMain.handle('store:get-tokens', handleGetSavedStoreTokens);

  /**
   * @param {any} _event
   * @param {string | { storefrontId?: string, store?: string }} rawStorefrontArg
   */
  const handleClearStoreTokens = async (_event, rawStorefrontArg) => {
    const storefrontId =
      rawStorefrontArg && typeof rawStorefrontArg === 'object'
        ? rawStorefrontArg.storefrontId || rawStorefrontArg.store || ''
        : String(rawStorefrontArg || '');
    const normalizedStore = storefrontId.trim().toLowerCase();
    storeSync.clearTokens(normalizedStore === 'all' ? '' : storefrontId);
    if (
      (!normalizedStore || normalizedStore === 'all' || normalizedStore === 'steam') &&
      typeof storeSync.clearSteamOwnedGamesCache === 'function'
    ) {
      try {
        storeSync.clearSteamOwnedGamesCache(
          handlerOptions.userDataDir ? { userDataDir: handlerOptions.userDataDir } : {}
        );
      } catch {}
    }
    try {
      launcherEngine?.purgeStoreHelperCredentials?.(normalizedStore === 'all' ? '' : storefrontId);
    } catch {}
    const partitionsToClear = resolvePartitionsToClearForStorefront(normalizedStore);
    for (const partName of partitionsToClear) {
      try {
        const targetSession = session?.fromPartition?.(partName);
        if (targetSession) {
          if (typeof targetSession.clearStorageData === 'function') {
            await targetSession.clearStorageData();
          }
          clearOAuthPopupSessionCaches(targetSession);
        }
      } catch {}
    }
    return { success: true };
  };

  ipcMain.handle('store:clear-tokens', handleClearStoreTokens);
  ipcMain.handle('store:disconnect', handleClearStoreTokens);

  ipcMain.handle(
    'epic:fetch-achievements',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPayload = {}) => {
      const {
        accountId,
        accessToken,
        sandboxId,
        namespace,
        appName,
        catalogItemId,
        title,
        targets,
        forceRefresh,
      } = sanitizeRendererIpcOptions(rawPayload);
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedEpic = savedTokens?.epic || {};
        let resolvedAccountId = accountId || savedEpic.account_id;
        let resolvedToken =
          (isRealSecretToken(accessToken) ? accessToken.trim() : '') ||
          (isRealSecretToken(savedEpic.access_token) ? savedEpic.access_token : '');
        let resolvedRefreshToken = savedEpic.refresh_token || '';
        if (
          (!resolvedToken || !resolvedAccountId) &&
          !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
          typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
        ) {
          try {
            const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
            resolvedToken = resolvedToken || legAuth?.accessToken;
            resolvedAccountId = resolvedAccountId || legAuth?.accountId;
            resolvedRefreshToken = resolvedRefreshToken || legAuth?.refreshToken || '';
          } catch {}
        }
        const safeTargets = Array.isArray(targets)
          ? targets
              .slice(0, 2000)
              .filter((/** @type {any} */ t) => t && typeof t === 'object')
              .map((/** @type {any} */ t) => ({
                ...(typeof t.sandboxId === 'string' && t.sandboxId.trim()
                  ? { sandboxId: t.sandboxId.trim() }
                  : {}),
                ...(typeof t.namespace === 'string' && t.namespace.trim()
                  ? { namespace: t.namespace.trim() }
                  : {}),
                ...(typeof t.appName === 'string' && t.appName.trim()
                  ? { appName: t.appName.trim() }
                  : {}),
                ...(typeof t.catalogItemId === 'string' && t.catalogItemId.trim()
                  ? { catalogItemId: t.catalogItemId.trim() }
                  : {}),
                ...(typeof t.title === 'string' && t.title.trim() ? { title: t.title.trim() } : {}),
              }))
              .filter((/** @type {any} */ t) => Boolean(t.sandboxId || t.namespace))
          : [];
        /** @type {Record<string, any>} */
        const targetOpts = {
          ...(sandboxId ? { sandboxId } : {}),
          ...(namespace ? { namespace } : {}),
          ...(appName ? { appName } : {}),
          ...(catalogItemId ? { catalogItemId } : {}),
          ...(title ? { title } : {}),
          ...(safeTargets.length > 0 ? { targets: safeTargets } : {}),
          ...(forceRefresh === true ? { forceRefresh: true } : {}),
          ...(resolvedRefreshToken ? { refreshToken: resolvedRefreshToken } : {}),
          ...(handlerOptions.userDataDir ? { userDataDir: handlerOptions.userDataDir } : {}),
        };
        const hasTargetOpts = Object.keys(targetOpts).length > 0;
        let result = hasTargetOpts
          ? await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId, targetOpts)
          : await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId);
        if ((!result || Object.keys(result).length === 0) && savedEpic.refresh_token) {
          try {
            const renewed = await storeSync.renewEpicTokens(savedEpic.refresh_token);
            resolvedToken = renewed.access_token;
            resolvedAccountId = renewed.account_id || resolvedAccountId;
            result = hasTargetOpts
              ? await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId, targetOpts)
              : await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId);
          } catch {}
        }
        return result || {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC epic:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'epic:fetch-game-schema',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        if (typeof storeSync.getEpicGameAchievementSchema === 'function') {
          return await storeSync.getEpicGameAchievementSchema(
            cleanPayload,
            handlerOptions.userDataDir ? { userDataDir: handlerOptions.userDataDir } : {}
          );
        }
        return [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC epic:fetch-game-schema warning:', msg);
        return [];
      }
    }
  );

  ipcMain.handle(
    'store:fetch-epic-metadata',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        return await storeSync.fetchEpicProductOfferMetadata(cleanPayload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:fetch-epic-metadata warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'xbox:fetch-achievements',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        if (typeof storeSync.fetchXboxAchievements === 'function') {
          return await storeSync.fetchXboxAchievements(cleanPayload);
        }
        return {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC xbox:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'xbox:fetch-game-schema',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        if (typeof storeSync.getXboxGameAchievementSchema === 'function') {
          return await storeSync.getXboxGameAchievementSchema(cleanPayload);
        }
        return [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC xbox:fetch-game-schema warning:', msg);
        return [];
      }
    }
  );

  ipcMain.handle(
    'store:get-achievements',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        const platformId = String(cleanPayload.platformId || cleanPayload.storefrontId || '')
          .trim()
          .toLowerCase();
        const sharedVaultOpts = handlerOptions.userDataDir
          ? { userDataDir: handlerOptions.userDataDir }
          : {};

        if (
          platformId === 'xbox' &&
          typeof storeSync.fetchXboxDetailedGameAchievements === 'function'
        ) {
          return await storeSync.fetchXboxDetailedGameAchievements(cleanPayload);
        }

        if (
          platformId === 'gog' &&
          typeof storeSync.fetchGogDetailedGameAchievements === 'function'
        ) {
          return await storeSync.fetchGogDetailedGameAchievements(cleanPayload, sharedVaultOpts);
        }

        if (platformId === 'epic') {
          if (typeof storeSync.fetchEpicDetailedGameAchievements === 'function') {
            const ensureLegendaryAuth =
              !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
              typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
                ? () => launcherEngine.ensureLegendaryConfigAndAuth()
                : undefined;
            const detailed = await storeSync.fetchEpicDetailedGameAchievements(cleanPayload, {
              ...sharedVaultOpts,
              ...(ensureLegendaryAuth ? { ensureLegendaryAuth } : {}),
            });
            if (detailed) return detailed;
          }
          if (typeof storeSync.getEpicGameAchievementSchema === 'function') {
            const list = await storeSync.getEpicGameAchievementSchema(
              cleanPayload,
              sharedVaultOpts
            );
            return {
              storefrontId: 'epic',
              storefrontName: 'Epic Games',
              total: list.length,
              unlocked: list.filter((/** @type {any} */ a) => a.unlocked).length,
              percentage:
                list.length > 0
                  ? Math.round(
                      (list.filter((/** @type {any} */ a) => a.unlocked).length / list.length) * 100
                    )
                  : 0,
              isMastered:
                list.length > 0 && list.every((/** @type {any} */ a) => Boolean(a.unlocked)),
              achievements: list,
              source: 'local_cache',
            };
          }
        }

        if (platformId === 'steam') {
          const savedTokens =
            typeof storeSync.loadSavedTokensAsync === 'function'
              ? await storeSync.loadSavedTokensAsync(sharedVaultOpts)
              : typeof storeSync.loadSavedTokens === 'function'
                ? storeSync.loadSavedTokens(sharedVaultOpts)
                : {};
          const savedSteam = savedTokens?.steam || {};
          const steamProviderFn =
            typeof storeSync.fetchSteamDetailedGameAchievements === 'function'
              ? storeSync.fetchSteamDetailedGameAchievements
              : fetchSteamDetailedGameAchievements;
          return await steamProviderFn(cleanPayload, {
            ...sharedVaultOpts,
            steamId: savedSteam.steamId || cleanPayload.steamId,
            apiKey: savedSteam.apiKey || savedSteam.api_key || cleanPayload.apiKey,
            webapiToken: savedSteam.webapi_token,
            ...(cleanPayload.existingSummary
              ? { existingSummary: cleanPayload.existingSummary }
              : {}),
          });
        }

        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:get-achievements warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'store:fetch-xbox-metadata',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        if (typeof storeSync.fetchXboxProductOfferMetadata === 'function') {
          return await storeSync.fetchXboxProductOfferMetadata(cleanPayload);
        }
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:fetch-xbox-metadata warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'store:xbox-get-status',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload = {}) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      try {
        if (typeof storeSync.getXboxStatus === 'function') {
          return await storeSync.getXboxStatus(cleanPayload);
        }
        return { connected: false, syncMode: 'owned_and_played' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { connected: false, syncMode: 'owned_and_played', error: msg };
      }
    }
  );

  ipcMain.handle(
    'store:xbox-set-sync-mode',
    async (/** @type {any} */ _event, /** @type {any} */ arg) => {
      try {
        const rawMode =
          arg && typeof arg === 'object' ? arg.syncMode || arg.mode : String(arg || '');
        if (typeof storeSync.setXboxSyncMode === 'function') {
          return storeSync.setXboxSyncMode(rawMode);
        }
        return { success: false, error: 'setXboxSyncMode unavailable' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );

  ipcMain.handle(
    'gog:fetch-achievements',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPayload = {}) => {
      const { username, accessToken, userId, productId, gameId, title } =
        sanitizeRendererIpcOptions(rawPayload);
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedGog = savedTokens?.gog || {};
        let resolvedToken =
          (isRealSecretToken(accessToken) ? accessToken.trim() : '') ||
          (isRealSecretToken(savedGog.access_token) ? savedGog.access_token : '');
        let resolvedUsername = username || savedGog.username;
        let resolvedUserId = userId || savedGog.user_id;

        /** @type {Record<string, any>} */
        const targetOpts = {
          ...(productId ? { productId } : {}),
          ...(gameId ? { gameId } : {}),
          ...(title ? { title } : {}),
        };
        const isSingleGameScoped = Boolean(productId || gameId);

        if (resolvedToken && (!isSingleGameScoped || !resolvedUserId)) {
          try {
            const account = await storeSync.fetchGogAccount(resolvedToken);
            resolvedUsername = account.username || resolvedUsername;
            resolvedUserId = account.userId || resolvedUserId;
          } catch {
            if (isRealSecretToken(savedGog.refresh_token)) {
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
        let result = isSingleGameScoped
          ? await storeSync.fetchGogAchievements(
              resolvedToken,
              resolvedUsername,
              resolvedUserId,
              targetOpts
            )
          : await storeSync.fetchGogAchievements(resolvedToken, resolvedUsername, resolvedUserId);

        if (
          isSingleGameScoped &&
          Boolean(/** @type {any} */ (result)?.authExpired) &&
          isRealSecretToken(savedGog.refresh_token)
        ) {
          try {
            const renewed = await storeSync.renewGogTokens(savedGog.refresh_token);
            resolvedToken = renewed.access_token;
            result = await storeSync.fetchGogAchievements(
              resolvedToken,
              resolvedUsername,
              resolvedUserId,
              targetOpts
            );
          } catch {}
        }
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC gog:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'steam:fetch-achievements',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPayload = {}) => {
      const { appIds } = sanitizeRendererIpcOptions(rawPayload);
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedSteam = savedTokens?.steam || {};
        const cachedSteamGames =
          typeof storeSync.loadSteamOwnedGamesCache === 'function'
            ? storeSync.loadSteamOwnedGamesCache({
                ...(handlerOptions.userDataDir ? { userDataDir: handlerOptions.userDataDir } : {}),
                steamId: savedSteam.steamId,
                legacyGames: savedSteam.games,
              })
            : Array.isArray(savedSteam.games)
              ? savedSteam.games
              : [];
        const resolvedAppIds =
          Array.isArray(appIds) && appIds.length > 0
            ? appIds
            : Array.isArray(cachedSteamGames)
              ? cachedSteamGames
                  .map((/** @type {any} */ g) => Number(g.steamAppId || 0))
                  .filter((/** @type {number} */ id) => id > 0)
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
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg, achievements: {} };
      }
    }
  );

  ipcMain.handle('scan:steam-achievements', async () => {
    try {
      const achievements = await scanLocalSteamAchievements();
      return { success: true, achievements };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, achievements: {} };
    }
  });

  ipcMain.handle(
    'igdb:fetch-cover',
    async (/** @type {any} */ _event, /** @type {unknown} */ gameTitle) => {
      try {
        return await storeSync.fetchIgdbCover(typeof gameTitle === 'string' ? gameTitle : '');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC igdb:fetch-cover warning:', msg);
        return null;
      }
    }
  );
}

module.exports = {
  registerStorefrontCatalogIpcHandlers,
};
