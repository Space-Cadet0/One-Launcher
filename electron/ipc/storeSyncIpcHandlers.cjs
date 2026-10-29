// @ts-check
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {
  isAllowedHttpsHost,
  sanitizeLaunchConfigRecursive,
} = require('../launcher/securityAndPathUtils.cjs');
const {
  diagLog,
  redactSensitiveDiagnosticText,
} = require('../utils/diagnosticLogger.cjs');
const {
  readLocalSteamPlaytimes,
  scanLocalSteamAchievements,
  fetchSteamBatchAchievements,
  fetchSteamStoreBrowseItemsMap,
  parseSteamGamesListJson,
  trimSteamLocalScannerMemory,
} = require('../storefronts/steamLocalScanner.cjs');
const {
  STORE_OAUTH_URLS,
  STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT,
  STEAM_SSR_BG_EXTRACTOR_SCRIPT,
  createEpicAuthRecovery,
} = require('../storefronts/epicAuthRecovery.cjs');

const XBOX_TRUSTED_AUTH_HOSTS = Object.freeze([
  'login.live.com',
  'account.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'account.microsoft.com',
  'sisu.xboxlive.com',
]);

const STOREFRONT_OAUTH_PARTITIONS = Object.freeze({
  xbox: 'persist:oauth_xbox',
  gog: 'persist:oauth_gog',
  epic: 'persist:oauth_epic',
  steam: 'persist:oauth_steam',
});

const RENDERER_TOKEN_SENTINELS = new Set([
  'saved_in_electron',
  '[REDACTED]',
  '[REDACTED_SECRET]',
  '[REDACTED_BEARER]',
  '[REDACTED_BASIC]',
  '[REDACTED_XBL_TOKEN]',
]);

const SECRET_TOKEN_OBJECT_KEYS = new Set([
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'apiKey',
  'api_key',
  'steamApiKey',
  'webapi_token',
  'webApiToken',
  'client_secret',
  'clientSecret',
  'exchange_code',
  'authorization_code',
  'xblAccessToken',
  'xstsToken',
  'msaAccessToken',
  'msaRefreshToken',
  'storeTicket',
  'userStsLegacyTokenXml',
  'deviceToken',
  'deviceKey',
  'proofKey',
  'privateKey',
  'sDAToken',
]);

/**
 * Determine whether a candidate string is a real credential rather than an empty or redacted sentinel.
 * @param {unknown} val
 * @returns {val is string}
 */
function isRealSecretToken(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  return !RENDERER_TOKEN_SENTINELS.has(trimmed);
}

/**
 * Scrub PII, emails, compact/XBL tickets, and filesystem paths from an error before logging or returning.
 * @param {unknown} err
 * @returns {string}
 */
function scrubAuthDiagnosticError(err) {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  return redactSensitiveDiagnosticText(raw)
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED]')
    .replace(/\b(?:[td]|XBL3\.0\s+x)=[^\s,;)"']+/gi, '[REDACTED]')
    .replace(/\b(?:puid|xuid|membername|cid|ANID)\s*[:=]\s*[^\s,;)"']+/gi, '[REDACTED]')
    .slice(0, 240);
}

/**
 * Resolve the isolated Electron session partition name for a storefront OAuth popup.
 * @param {unknown} storefrontId
 * @returns {string}
 */
function resolveStorefrontOAuthPartition(storefrontId) {
  const normalized = String(storefrontId || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STOREFRONT_OAUTH_PARTITIONS, normalized)) {
    return STOREFRONT_OAUTH_PARTITIONS[
      /** @type {keyof typeof STOREFRONT_OAUTH_PARTITIONS} */ (normalized)
    ];
  }
  const safeSlug = normalized.replace(/[^a-z0-9_-]/g, '') || 'generic';
  return `persist:oauth_${safeSlug}`;
}

/**
 * Clear HTTP and V8 bytecode caches on an isolated OAuth popup session when closed.
 * @param {any} targetSession
 */
function clearOAuthPopupSessionCaches(targetSession) {
  if (!targetSession) return;
  try {
    if (typeof targetSession.clearCache === 'function') {
      Promise.resolve(targetSession.clearCache()).catch(() => {});
    }
  } catch {}
  try {
    if (typeof targetSession.clearCodeCaches === 'function') {
      Promise.resolve(targetSession.clearCodeCaches({})).catch(() => {});
    }
  } catch {}
}

/**
 * Validate `https://login.live.com/ppsecure/post.srf` via strict WHATWG URL parsing.
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isLivePostSrfUrl(urlStr) {
  if (!isAllowedHttpsHost(urlStr, ['login.live.com'])) return false;
  try {
    const parsed = new URL(String(urlStr));
    return /^\/ppsecure\/post\.srf\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Validate `https://*.epicgames.com/id/api/redirect*` via strict WHATWG URL parsing.
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isEpicAuthRedirectUrl(urlStr) {
  if (!isAllowedHttpsHost(urlStr, ['epicgames.com'])) return false;
  try {
    const parsed = new URL(String(urlStr));
    return parsed.pathname.startsWith('/id/api/redirect');
  } catch {
    return false;
  }
}

/**
 * Validate authenticated `https://steamcommunity.com/...` (excluding `/login` paths) via WHATWG URL.
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isAuthenticatedSteamCommunityUrl(urlStr) {
  if (!isAllowedHttpsHost(urlStr, ['steamcommunity.com'])) return false;
  try {
    const parsed = new URL(String(urlStr));
    const lowerPath = parsed.pathname.toLowerCase();
    return lowerPath !== '/login' && !lowerPath.startsWith('/login/');
  } catch {
    return false;
  }
}

/**
 * Project a storefront credential record across the main->renderer IPC boundary without
 * ever exposing raw OAuth access/refresh tokens, Steam WebAPI tokens/keys, or Xbox XSTS/MSA keys.
 *
 * @param {string} storefrontId
 * @param {any} rawEntry
 * @param {any} [storeSync]
 * @returns {Record<string, any> | null}
 */
function sanitizeStoreTokenEntryForRenderer(storefrontId, rawEntry, storeSync) {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return null;
  }
  const normalizedStore = String(storefrontId || '').trim().toLowerCase();

  const hasAccessToken = Boolean(
    (isRealSecretToken(rawEntry.access_token) && rawEntry.access_token !== 'steam_web_session') ||
      isRealSecretToken(rawEntry.accessToken) ||
      isRealSecretToken(rawEntry.xblAccessToken) ||
      isRealSecretToken(rawEntry.msaAccessToken) ||
      isRealSecretToken(rawEntry.storeTicket) ||
      (normalizedStore === 'steam' && rawEntry.access_token === 'steam_web_session')
  );
  const hasRefreshToken = Boolean(
    isRealSecretToken(rawEntry.refresh_token) ||
      isRealSecretToken(rawEntry.refreshToken) ||
      isRealSecretToken(rawEntry.msaRefreshToken) ||
      isRealSecretToken(rawEntry.userStsLegacyTokenXml)
  );
  const hasApiKey = Boolean(
    isRealSecretToken(rawEntry.apiKey) ||
      isRealSecretToken(rawEntry.api_key) ||
      isRealSecretToken(rawEntry.steamApiKey) ||
      isRealSecretToken(rawEntry.webapi_token) ||
      isRealSecretToken(rawEntry.webApiToken)
  );

  if (normalizedStore === 'xbox') {
    const baseXbox =
      typeof storeSync?.projectRedactedXboxSummary === 'function'
        ? storeSync.projectRedactedXboxSummary(rawEntry)
        : null;
    const xboxConnected = Boolean(
      baseXbox?.connected || hasAccessToken || hasRefreshToken || rawEntry.connected
    );
    if (!baseXbox && !xboxConnected) {
      return null;
    }
    /** @type {Record<string, any>} */
    const safeXbox = {};
    if (baseXbox && typeof baseXbox === 'object') {
      for (const [k, v] of Object.entries(baseXbox)) {
        if (!SECRET_TOKEN_OBJECT_KEYS.has(k)) {
          safeXbox[k] = v;
        }
      }
    } else {
      if (typeof rawEntry.accountName === 'string') safeXbox.accountName = rawEntry.accountName;
      if (typeof rawEntry.gamertag === 'string') safeXbox.gamertag = rawEntry.gamertag;
      if (typeof rawEntry.xuid === 'string') safeXbox.xuid = rawEntry.xuid;
      if (typeof rawEntry.avatarUrl === 'string') safeXbox.avatarUrl = rawEntry.avatarUrl;
      if (rawEntry.subscription) safeXbox.subscription = rawEntry.subscription;
      if (rawEntry.syncMode) safeXbox.syncMode = rawEntry.syncMode;
    }
    safeXbox.connected = xboxConnected;
    safeXbox.hasAccessToken = hasAccessToken || xboxConnected;
    safeXbox.hasRefreshToken = hasRefreshToken;
    safeXbox.hasApiKey = hasApiKey;
    if (xboxConnected) {
      safeXbox.access_token = 'saved_in_electron';
    }
    return safeXbox;
  }

  const isConnected = Boolean(
    hasAccessToken ||
      hasRefreshToken ||
      hasApiKey ||
      (normalizedStore === 'steam' && typeof rawEntry.steamId === 'string' && rawEntry.steamId.trim())
  );
  if (!isConnected) {
    return null;
  }

  /** @type {Record<string, any>} */
  const projected = {};
  for (const [key, value] of Object.entries(rawEntry)) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      SECRET_TOKEN_OBJECT_KEYS.has(key)
    ) {
      continue;
    }
    projected[key] = value;
  }

  projected.connected = true;
  projected.hasAccessToken = hasAccessToken;
  projected.hasRefreshToken = hasRefreshToken;
  projected.hasApiKey = hasApiKey;
  projected.access_token = 'saved_in_electron';
  return projected;
}

/** @type {string | null} */
let hltbCachedToken = null;
let hltbTokenExpiry = 0;

/**
 * @returns {Promise<string | null>}
 */
async function getHltbToken() {
  if (hltbCachedToken && Date.now() < hltbTokenExpiry) {
    return hltbCachedToken;
  }
  try {
    const initRes = await fetch(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        Referer: 'https://howlongtobeat.com/',
      },
    });
    if (!initRes.ok) return null;
    /** @type {{ token?: string } | null} */
    const initData = /** @type {any} */ (await initRes.json());
    if (initData?.token) {
      hltbCachedToken = String(initData.token);
      hltbTokenExpiry = Date.now() + 10 * 60 * 1000;
      return hltbCachedToken;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[HLTB] Token init failed:', msg);
  }
  return null;
}

/**
 * Clean Electron/OneLauncher tokens from User-Agent string so storefront OAuth pages do not block WebViews.
 * @param {any} session
 * @returns {string}
 */
function resolveCleanBrowserUserAgent(session) {
  const defaultUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
  try {
    const rawUa = session?.defaultSession?.getUserAgent?.();
    if (!rawUa || typeof rawUa !== 'string') return defaultUa;
    return rawUa
      .replace(/\s+OneLauncher\/[^\s]+/gi, '')
      .replace(/\s+one-launcher\/[^\s]+/gi, '')
      .replace(/\s+Electron\/[^\s]+/gi, '');
  } catch {
    return defaultUa;
  }
}

/**
 * Register all Storefront OAuth, Catalog Sync, Achievement, HLTB & IGDB IPC handlers.
 *
 * @param {{
 *   ipcMain: any,
 *   BrowserWindow: any,
 *   session: any,
 *   getMainWindow: () => any,
 *   storeSync: any,
 *   launcherEngine: any
 * }} deps
 */
function registerStoreSyncIpcHandlers({
  ipcMain,
  BrowserWindow,
  session,
  getMainWindow,
  storeSync,
  launcherEngine,
}) {
  if (!ipcMain) return { trimStoreSyncIpcMemory: trimSteamLocalScannerMemory };
  trimSteamLocalScannerMemory();

  const recoverEpicAuthSession = createEpicAuthRecovery({
    BrowserWindow,
    getMainWindow,
    storeSync,
    launcherEngine,
  });

  if (typeof launcherEngine?.setEpicAuthRecoveryHook === 'function') {
    launcherEngine.setEpicAuthRecoveryHook(recoverEpicAuthSession);
  }

  /** @type {Promise<{ recovered: boolean, error?: string }> | null} */
  let inFlightXboxLicenseRecovery = null;

  /**
   * On-demand single-flight Microsoft Store `TokenBroker` (`InlineLogin.srf`) recovery hook.
   * Invoked automatically during Xbox `.msixvc` installation when an account was previously
   * restored from an OAuth2-only refresh token lacking `storeTicket` / `userStsLegacyTokenXml`
   * (or when a Store licensing session requires interactive consent), so `Quake` and all other
   * encrypted `.msixvc` packages acquire their 32-byte `CIK` and stream seamlessly without failing.
   *
   * @param {{ title?: string, userDataDir?: string }} [context]
   * @returns {Promise<{ recovered: boolean, error?: string }>}
   */
  const recoverXboxStoreLicenseSession = (context = {}) => {
    if (inFlightXboxLicenseRecovery) {
      return inFlightXboxLicenseRecovery;
    }

    inFlightXboxLicenseRecovery = (async () => {
      if (
        !BrowserWindow ||
        typeof storeSync?.xboxStorefront?.buildInlineLoginRequest !== 'function' ||
        typeof storeSync?.getXboxAuthProvider !== 'function'
      ) {
        return { recovered: false, error: 'Xbox Store license recovery window unavailable' };
      }

      const provider = storeSync.getXboxAuthProvider(
        context?.userDataDir ? { userDataDir: context.userDataDir } : undefined
      );
      if (
        !provider ||
        typeof provider.ensureDeviceContext !== 'function' ||
        typeof provider.exchangeTokenBrokerDaProperty !== 'function'
      ) {
        return { recovered: false, error: 'Xbox auth provider unavailable' };
      }

      /** @type {{ url: string, userAgent: string, extraHeadersString?: string }} */
      let xboxInlineReq;
      try {
        await provider.ensureDeviceContext({ requireLegacyToken: true });
        xboxInlineReq = storeSync.xboxStorefront.buildInlineLoginRequest();
      } catch (err) {
        const scrubbedMessage = scrubAuthDiagnosticError(err);
        diagLog.warn(
          'storeSyncIpc.recoverXboxStoreLicenseSession.ensureDeviceContext',
          scrubbedMessage
        );
        return {
          recovered: false,
          error: scrubbedMessage || 'Xbox device license provisioning failed',
        };
      }
      const config = STORE_OAUTH_URLS.xbox || { width: 520, height: 680 };

      return await new Promise((resolve) => {
        let resolved = false;
        let xboxIsSecondLeg = false;
        let xboxProcessingToken = false;

        const currentMain = getMainWindow?.();
        const isolatedXboxSession =
          typeof session?.fromPartition === 'function'
            ? session.fromPartition(`xbox-cxh-lic-${crypto.randomUUID()}`, { cache: false })
            : null;

        /** @type {Record<string, any>} */
        const webPreferences = {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: path.join(__dirname, '../xboxAuthPreload.cjs'),
          userAgent: xboxInlineReq.userAgent,
          ...(isolatedXboxSession
            ? { session: isolatedXboxSession }
            : { partition: resolveStorefrontOAuthPartition('xbox') }),
        };

        const authWindow = new BrowserWindow({
          width: config.width || 520,
          height: config.height || 680,
          parent: currentMain && !currentMain.isDestroyed() ? currentMain : undefined,
          modal: false,
          closable: true,
          minimizable: true,
          resizable: true,
          autoHideMenuBar: true,
          show: true,
          title: context?.title
            ? `Authorize Microsoft Store License - ${context.title}`
            : 'Authorize Microsoft Store License - XBOX',
          webPreferences,
        });

        const popupSession =
          isolatedXboxSession ||
          authWindow.webContents?.session ||
          (typeof session?.fromPartition === 'function'
            ? session.fromPartition(resolveStorefrontOAuthPartition('xbox'))
            : null);

        if (typeof authWindow.webContents?.setUserAgent === 'function') {
          authWindow.webContents.setUserAgent(xboxInlineReq.userAgent);
        }

        const isTrustedXboxUrl = (/** @type {string} */ candidate) => {
          if (!isAllowedHttpsHost(candidate, XBOX_TRUSTED_AUTH_HOSTS)) {
            return false;
          }
          if (typeof storeSync?.xboxStorefront?.isTrustedXboxAuthUrl === 'function') {
            return Boolean(storeSync.xboxStorefront.isTrustedXboxAuthUrl(candidate));
          }
          return true;
        };

        /** @type {(event: any, payload: unknown) => void} */
        let onXboxCxhNotify = () => {};

        const safelyCloseAuthWindow = () => {
          if (typeof ipcMain?.removeListener === 'function') {
            try {
              ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
            } catch {}
          }
          if (isolatedXboxSession && typeof isolatedXboxSession.clearStorageData === 'function') {
            try {
              void isolatedXboxSession.clearStorageData();
            } catch {}
          }
          clearOAuthPopupSessionCaches(popupSession);
          try {
            if (!authWindow.isDestroyed()) {
              authWindow.close();
            }
            if (!authWindow.isDestroyed()) {
              authWindow.destroy();
            }
          } catch {}
        };

        /** @param {string} rawPayload */
        const handleXboxCxhPayload = async (rawPayload) => {
          if (
            resolved ||
            authWindow.isDestroyed() ||
            typeof rawPayload !== 'string' ||
            !rawPayload ||
            Buffer.byteLength(rawPayload) > 65536
          ) {
            return;
          }
          /** @type {any} */
          let parsed = null;
          try {
            parsed = JSON.parse(rawPayload);
          } catch {
            return;
          }
          if (!parsed || typeof parsed !== 'object') return;

          if (
            parsed.type === 'invoke' &&
            parsed.value &&
            parsed.value.name === 'CloudExperienceHost.getContext' &&
            typeof parsed.value.context === 'string' &&
            parsed.value.context.length <= 4096
          ) {
            if (!isTrustedXboxUrl(authWindow.webContents.getURL())) return;
            const callbackMsg = JSON.stringify({
              type: 'callback',
              value: {
                name: 'CloudExperienceHost.getContext',
                args: [
                  'CloudExperienceHost',
                  'TokenBroker',
                  'TokenBroker',
                  '{"PrivatePropertyBag":1,"PasswordlessConnect":1,"PreferAssociate":1,"ChromelessUI":0}',
                ],
                context: parsed.value.context,
              },
            });
            try {
              await authWindow.webContents.executeJavaScript(
                `globalThis["CloudExperienceHost.Bridge.dispatchMessage"]?.(${JSON.stringify(callbackMsg)})`
              );
            } catch {}
            return;
          }

          if (typeof parsed.sDAToken === 'string' && parsed.sDAToken && !xboxProcessingToken) {
            xboxProcessingToken = true;
            try {
              const exResult = await provider.exchangeTokenBrokerDaProperty(parsed, {
                isSecondLeg: xboxIsSecondLeg,
              });
              if (
                exResult &&
                exResult.requiresInlineConsent &&
                exResult.inlineAuthUrl &&
                !xboxIsSecondLeg &&
                !resolved &&
                !authWindow.isDestroyed()
              ) {
                xboxIsSecondLeg = true;
                authWindow.loadURL(exResult.inlineAuthUrl);
                return;
              }
              if (!resolved) {
                resolved = true;
                safelyCloseAuthWindow();
                const mintedTicket =
                  exResult?.storeTicket ||
                  (typeof provider.getStoreMsaToken === 'function'
                    ? await provider.getStoreMsaToken({ forLicensing: true })
                    : '');
                resolve({ recovered: Boolean(mintedTicket) });
              }
            } catch (err) {
              if (!resolved) {
                resolved = true;
                safelyCloseAuthWindow();
                resolve({
                  recovered: false,
                  error: scrubAuthDiagnosticError(err),
                });
              }
            } finally {
              xboxProcessingToken = false;
            }
          }
        };

        onXboxCxhNotify = (/** @type {any} */ event, /** @type {unknown} */ payload) => {
          if (
            resolved ||
            authWindow.isDestroyed() ||
            event?.sender !== authWindow.webContents ||
            (event?.senderFrame &&
              authWindow.webContents.mainFrame &&
              event.senderFrame !== authWindow.webContents.mainFrame) ||
            typeof payload !== 'string'
          ) {
            return;
          }
          const senderUrl = event?.senderFrame?.url || authWindow.webContents.getURL();
          if (!isTrustedXboxUrl(senderUrl)) return;
          void handleXboxCxhPayload(payload);
        };

        if (typeof ipcMain?.on === 'function') {
          ipcMain.on('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
        }

        authWindow.webContents.on('will-prevent-unload', (/** @type {any} */ event) => {
          event.preventDefault();
        });

        authWindow.webContents.on('did-finish-load', async () => {
          if (resolved || authWindow.isDestroyed()) return;
          const currentUrl = authWindow.webContents.getURL();
          if (isLivePostSrfUrl(currentUrl)) {
            try {
              const serverDataStr = await authWindow.webContents.executeJavaScript(
                'JSON.stringify(globalThis.ServerData ?? null)'
              );
              if (typeof serverDataStr === 'string' && serverDataStr !== 'null') {
                await handleXboxCxhPayload(serverDataStr);
              }
            } catch {}
          }
        });

        authWindow.on('closed', () => {
          if (typeof ipcMain?.removeListener === 'function') {
            try {
              ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
            } catch {}
          }
          clearOAuthPopupSessionCaches(popupSession);
          if (!resolved) {
            resolved = true;
            resolve({ recovered: false, error: 'Sign-in window closed by user.' });
          }
        });

        if (xboxInlineReq.extraHeadersString) {
          authWindow.loadURL(xboxInlineReq.url, { extraHeaders: xboxInlineReq.extraHeadersString });
        } else {
          authWindow.loadURL(xboxInlineReq.url);
        }
      });
    })()
      .catch((err) => ({
        recovered: false,
        error: scrubAuthDiagnosticError(err),
      }))
      .finally(() => {
        inFlightXboxLicenseRecovery = null;
      });

    return inFlightXboxLicenseRecovery;
  };

  if (typeof launcherEngine?.setXboxStoreLicenseRecoveryHook === 'function') {
    launcherEngine.setXboxStoreLicenseRecoveryHook(recoverXboxStoreLicenseSession);
  }

  /**
   * Process OAuth / TokenBroker exchange and full library entitlement synchronization.
   * @param {string} storefrontId
   * @param {any} codeOrPayload
   */
  async function processStoreAuth(storefrontId, codeOrPayload) {
    let accountName = 'Verified User';
    let avatarUrl;
    /** @type {any[]} */
    let games = [];
    let tokenData = null;
    const codeLabel = typeof codeOrPayload === 'string' ? codeOrPayload : 'xbox_token_broker';

    try {
      launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
      if (storefrontId === 'gog') {
        tokenData = await storeSync.exchangeGogCode(codeLabel);
        const account = await storeSync.fetchGogAccount(tokenData.access_token);
        accountName = account.username || 'GOG User';
        avatarUrl = account.avatarUrl;
        games = await storeSync.fetchGogOwnedGames(
          tokenData.access_token,
          accountName,
          account.userId
        );
      } else if (storefrontId === 'epic') {
        tokenData = await storeSync.exchangeEpicCode(codeLabel);
        accountName = tokenData.displayName || tokenData.account_id || 'Epic Games User';
        games = await storeSync.fetchEpicOwnedGames(tokenData.access_token, tokenData.account_id);
      } else if (storefrontId === 'xbox') {
        const xboxRes = await storeSync.loginXbox(codeOrPayload);
        if (xboxRes && xboxRes.requiresInlineConsent) {
          return xboxRes;
        }
        accountName = xboxRes.accountName || xboxRes.gamertag || 'Xbox Player';
        avatarUrl = xboxRes.avatarUrl;
        games = xboxRes.games || [];
        const savedXboxRaw = storeSync.loadSavedTokens()?.xbox || {
          connected: true,
          accountName,
          gamertag: xboxRes.gamertag || accountName,
          xuid: xboxRes.xuid,
          avatarUrl,
          subscription: xboxRes.subscription,
          syncMode: xboxRes.syncMode,
        };
        tokenData = sanitizeStoreTokenEntryForRenderer('xbox', savedXboxRaw, storeSync);
        return {
          success: true,
          code: codeLabel,
          storefrontId,
          accountName,
          accountId: xboxRes.xuid,
          xuid: xboxRes.xuid,
          avatarUrl,
          gamerscore: xboxRes.gamerscore || 0,
          subscription: xboxRes.subscription,
          syncMode: xboxRes.syncMode,
          games,
          achievements: xboxRes.achievements || {},
          suppressedItems: xboxRes.suppressedItems || [],
          tokenData,
        };
      }

      return {
        success: true,
        code: codeLabel,
        storefrontId,
        accountName,
        avatarUrl,
        games,
        tokenData: sanitizeStoreTokenEntryForRenderer(storefrontId, tokenData, storeSync),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (storefrontId === 'xbox' && !tokenData) {
        const anyErr = /** @type {any} */ (err);
        return {
          success: false,
          storefrontId,
          error: msg,
          errorCode: anyErr?.code,
          xerr: anyErr?.xerr,
          redirectUrl: anyErr?.redirectUrl,
        };
      }
      console.warn(`Post-login sync warning for ${storefrontId}:`, msg);
      return {
        success: true,
        code: codeLabel,
        storefrontId,
        accountName,
        avatarUrl,
        games: [],
        syncError: msg,
        tokenData: sanitizeStoreTokenEntryForRenderer(storefrontId, tokenData, storeSync),
      };
    }
  }

  ipcMain.handle('auth:storefront', async (/** @type {any} */ _event, /** @type {string} */ storefrontId) => {
    const config = STORE_OAUTH_URLS[storefrontId];
    if (!config) {
      return { success: false, error: `Unsupported storefront: ${storefrontId}` };
    }

    /** @type {{ url: string, userAgent: string, extraHeadersString: string } | null} */
    let xboxInlineReq = null;
    if (
      storefrontId === 'xbox' &&
      typeof storeSync?.xboxStorefront?.buildInlineLoginRequest === 'function'
    ) {
      try {
        const provider = storeSync.getXboxAuthProvider?.();
        if (provider && typeof provider.ensureDeviceContext === 'function') {
          await provider.ensureDeviceContext({ requireLegacyToken: true });
          xboxInlineReq = storeSync.xboxStorefront.buildInlineLoginRequest();
        }
      } catch (err) {
        // Fallback seamlessly to standard LiveSDK Desktop OAuth2 (`oauth20_desktop.srf`) if SOAP device init is unavailable
        diagLog.warn(
          'storeSyncIpc.authStorefront.xboxEnsureDeviceContext',
          scrubAuthDiagnosticError(err)
        );
        xboxInlineReq = null;
      }
    }

    return new Promise((resolve) => {
      let resolved = false;
      let extractingSteam = false;
      let xboxIsSecondLeg = false;
      let xboxProcessingToken = false;

      const cleanBrowserUA = resolveCleanBrowserUserAgent(session);
      const currentMain = getMainWindow?.();
      const xboxCsrfState =
        storefrontId === 'xbox' ? crypto.randomBytes(16).toString('hex') : '';
      let targetAuthUrl = xboxInlineReq ? xboxInlineReq.url : config.url;
      if (!xboxInlineReq && storefrontId === 'xbox') {
        try {
          const parsedCfgUrl = new URL(config.url);
          if (!parsedCfgUrl.searchParams.has('state')) {
            parsedCfgUrl.searchParams.set('state', xboxCsrfState);
          }
          targetAuthUrl = parsedCfgUrl.toString();
        } catch {}
      }

      const oauthPartition = resolveStorefrontOAuthPartition(storefrontId);
      const isolatedXboxSession =
        xboxInlineReq && typeof session?.fromPartition === 'function'
          ? session.fromPartition(`xbox-cxh-${crypto.randomUUID()}`, { cache: false })
          : null;

      /** @type {Record<string, any>} */
      const webPreferences = {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        userAgent: xboxInlineReq ? xboxInlineReq.userAgent : cleanBrowserUA,
      };
      if (xboxInlineReq) {
        webPreferences.preload = path.join(__dirname, '../xboxAuthPreload.cjs');
        if (isolatedXboxSession) {
          webPreferences.session = isolatedXboxSession;
        } else {
          webPreferences.partition = oauthPartition;
        }
      } else {
        webPreferences.partition = oauthPartition;
      }

      const authWindow = new BrowserWindow({
        width: config.width,
        height: config.height,
        parent: currentMain && !currentMain.isDestroyed() ? currentMain : undefined,
        modal: false,
        closable: true,
        minimizable: true,
        resizable: true,
        autoHideMenuBar: true,
        show: true,
        title: `Sign In - ${storefrontId.toUpperCase()}`,
        webPreferences,
      });

      const popupSession =
        isolatedXboxSession ||
        authWindow.webContents?.session ||
        (typeof session?.fromPartition === 'function'
          ? session.fromPartition(oauthPartition)
          : null);

      if (xboxInlineReq && typeof authWindow.webContents?.setUserAgent === 'function') {
        authWindow.webContents.setUserAgent(xboxInlineReq.userAgent);
      }

      const isTrustedXboxUrl = (/** @type {string} */ candidate) => {
        if (!isAllowedHttpsHost(candidate, XBOX_TRUSTED_AUTH_HOSTS)) {
          return false;
        }
        if (typeof storeSync?.xboxStorefront?.isTrustedXboxAuthUrl === 'function') {
          return Boolean(storeSync.xboxStorefront.isTrustedXboxAuthUrl(candidate));
        }
        return true;
      };

      /** @param {string} rawPayload */
      const handleXboxCxhPayload = async (rawPayload) => {
        if (resolved || authWindow.isDestroyed() || typeof rawPayload !== 'string' || !rawPayload) {
          return;
        }
        if (Buffer.byteLength(rawPayload) > 65536) return;
        /** @type {any} */
        let parsed = null;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;

        // 1. CloudExperienceHost.getContext bridge handshake
        if (
          parsed.type === 'invoke' &&
          parsed.value &&
          parsed.value.name === 'CloudExperienceHost.getContext' &&
          typeof parsed.value.context === 'string' &&
          parsed.value.context.length <= 4096
        ) {
          if (!isTrustedXboxUrl(authWindow.webContents.getURL())) return;
          const callbackMsg = JSON.stringify({
            type: 'callback',
            value: {
              name: 'CloudExperienceHost.getContext',
              args: [
                'CloudExperienceHost',
                'TokenBroker',
                'TokenBroker',
                '{"PrivatePropertyBag":1,"PasswordlessConnect":1,"PreferAssociate":1,"ChromelessUI":0}',
              ],
              context: parsed.value.context,
            },
          });
          try {
            await authWindow.webContents.executeJavaScript(
              `globalThis["CloudExperienceHost.Bridge.dispatchMessage"]?.(${JSON.stringify(callbackMsg)})`
            );
          } catch {}
          return;
        }

        // 2. DAProperty user token exchange (1-leg SSO or 2-leg consent)
        if (typeof parsed.sDAToken === 'string' && parsed.sDAToken && !xboxProcessingToken) {
          xboxProcessingToken = true;
          try {
            const syncResult = await processStoreAuth('xbox', {
              daProperty: parsed,
              isSecondLeg: xboxIsSecondLeg,
            });
            if (
              syncResult &&
              syncResult.requiresInlineConsent &&
              syncResult.inlineAuthUrl &&
              !xboxIsSecondLeg &&
              !resolved &&
              !authWindow.isDestroyed()
            ) {
              xboxIsSecondLeg = true;
              authWindow.loadURL(syncResult.inlineAuthUrl);
              return;
            }
            if (!resolved) {
              resolved = true;
              safelyCloseAuthWindow();
              resolve(syncResult);
            }
          } finally {
            xboxProcessingToken = false;
          }
        }
      };

      const onXboxCxhNotify = (/** @type {any} */ event, /** @type {unknown} */ payload) => {
        if (
          resolved ||
          authWindow.isDestroyed() ||
          event?.sender !== authWindow.webContents ||
          (event?.senderFrame &&
            authWindow.webContents.mainFrame &&
            event.senderFrame !== authWindow.webContents.mainFrame) ||
          typeof payload !== 'string'
        ) {
          return;
        }
        const senderUrl = event?.senderFrame?.url || authWindow.webContents.getURL();
        if (!isTrustedXboxUrl(senderUrl)) return;
        void handleXboxCxhPayload(payload);
      };

      if (xboxInlineReq && typeof ipcMain.on === 'function') {
        ipcMain.on('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
      }

      const safelyCloseAuthWindow = () => {
        if (xboxInlineReq && typeof ipcMain.removeListener === 'function') {
          try {
            ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
          } catch {}
        }
        if (isolatedXboxSession && typeof isolatedXboxSession.clearStorageData === 'function') {
          try {
            void isolatedXboxSession.clearStorageData();
          } catch {}
        }
        clearOAuthPopupSessionCaches(popupSession);
        try {
          if (!authWindow.isDestroyed()) {
            authWindow.close();
          }
          if (!authWindow.isDestroyed()) {
            authWindow.destroy();
          }
        } catch {}
      };

      authWindow.webContents.on('will-prevent-unload', (/** @type {any} */ event) => {
        event.preventDefault();
      });

      /** @param {string} code */
      const handleAuthCodeFound = async (code) => {
        if (!code || resolved) return;
        resolved = true;
        safelyCloseAuthWindow();
        const syncResult = await processStoreAuth(storefrontId, code);
        resolve(syncResult);
      };

      /** @param {string} url */
      const checkUrlForCode = (url) => {
        if (!url || resolved) return;

        if (storefrontId === 'gog' && isAllowedHttpsHost(url, ['embed.gog.com', 'auth.gog.com', 'gog.com'])) {
          try {
            const parsed = new URL(url);
            if (parsed.pathname.includes('/on_login_success')) {
              const code = parsed.searchParams.get('code');
              if (code) {
                handleAuthCodeFound(code);
                return;
              }
            }
          } catch {}
        }

        if (storefrontId === 'epic') {
          try {
            const parsed = new URL(url);
            if (
              (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
              parsed.hostname.toLowerCase() === 'localhost' &&
              parsed.pathname.startsWith('/launcher/authorized')
            ) {
              const code = parsed.searchParams.get('code');
              if (code) {
                handleAuthCodeFound(code);
                return;
              }
            }
          } catch {}
        }

        if (
          storefrontId === 'xbox' &&
          isAllowedHttpsHost(url, ['login.live.com', 'login.microsoftonline.com'])
        ) {
          try {
            const parsed = new URL(url);
            if (parsed.pathname.toLowerCase().endsWith('/oauth20_desktop.srf')) {
              if (parsed.searchParams.has('error')) {
                const errCode = parsed.searchParams.get('error') || 'access_denied';
                const errDesc = parsed.searchParams.get('error_description') || errCode;
                resolved = true;
                safelyCloseAuthWindow();
                resolve({
                  success: false,
                  storefrontId: 'xbox',
                  error: `Microsoft sign-in cancelled (${errDesc})`,
                });
                return;
              }
              const returnedState = parsed.searchParams.get('state');
              if (xboxCsrfState && returnedState && returnedState !== xboxCsrfState) {
                resolved = true;
                safelyCloseAuthWindow();
                resolve({
                  success: false,
                  storefrontId: 'xbox',
                  error: 'Microsoft OAuth state mismatch (CSRF validation failed).',
                });
                return;
              }
              const code = parsed.searchParams.get('code');
              if (code) {
                handleAuthCodeFound(code);
                return;
              }
            }
          } catch {}
        }
      };

      const tryExtractSteamGames = async () => {
        if (resolved || extractingSteam || authWindow.isDestroyed() || storefrontId !== 'steam') {
          return;
        }
        const currentUrl = authWindow.webContents.getURL();
        if (!isAuthenticatedSteamCommunityUrl(currentUrl)) {
          return;
        }

        extractingSteam = true;
        try {
          const steamData = await authWindow.webContents.executeJavaScript(
            STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT
          );

          if (steamData && steamData.gameslistJson && !resolved) {
            resolved = true;
            safelyCloseAuthWindow();
            const parsedSteam = await parseSteamGamesListJson(
              steamData.gameslistJson,
              steamData.steamId,
              steamData.personaName,
              steamData.avatarUrl,
              [],
              storeSync
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
              tokenData: sanitizeStoreTokenEntryForRenderer('steam', tokenPayload, storeSync),
            });
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('Steam web extraction warning:', msg);
        } finally {
          extractingSteam = false;
        }
      };

      authWindow.webContents.on('will-redirect', (/** @type {any} */ _event, /** @type {string} */ url) => {
        checkUrlForCode(url);
      });

      authWindow.webContents.on('will-navigate', (/** @type {any} */ _event, /** @type {string} */ url) => {
        checkUrlForCode(url);
      });

      authWindow.webContents.on(
        'did-navigate',
        async (/** @type {any} */ _event, /** @type {string} */ url) => {
          checkUrlForCode(url);

          if (storefrontId === 'epic' && isEpicAuthRedirectUrl(url)) {
            try {
              const pageSource = await authWindow.webContents.executeJavaScript(
                'document.body.innerText'
              );
              if (pageSource) {
                const match =
                  pageSource.match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i) ||
                  pageSource.match(/\b([a-fA-F0-9]{32})\b/);
                if (match) {
                  handleAuthCodeFound(match[1]);
                  return;
                }
              }
            } catch {}
          }

          if (storefrontId === 'steam' && isAuthenticatedSteamCommunityUrl(url)) {
            await tryExtractSteamGames();
          }
        }
      );

      authWindow.webContents.on('did-finish-load', async () => {
        if (resolved || authWindow.isDestroyed()) return;
        const currentUrl = authWindow.webContents.getURL();
        checkUrlForCode(currentUrl);

        if (xboxInlineReq && storefrontId === 'xbox' && isLivePostSrfUrl(currentUrl)) {
          try {
            const serverDataStr = await authWindow.webContents.executeJavaScript(
              'JSON.stringify(globalThis.ServerData ?? null)'
            );
            if (typeof serverDataStr === 'string' && serverDataStr !== 'null') {
              await handleXboxCxhPayload(serverDataStr);
              return;
            }
          } catch {}
        }

        if (storefrontId === 'epic' && isEpicAuthRedirectUrl(currentUrl)) {
          try {
            const pageSource = await authWindow.webContents.executeJavaScript(
              'document.body.innerText'
            );
            if (pageSource) {
              const match =
                pageSource.match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i) ||
                pageSource.match(/\b([a-fA-F0-9]{32})\b/);
              if (match) {
                handleAuthCodeFound(match[1]);
                return;
              }
            }
          } catch {}
        }

        if (storefrontId === 'steam' && isAuthenticatedSteamCommunityUrl(currentUrl)) {
          await tryExtractSteamGames();
        }
      });

      authWindow.on('closed', () => {
        if (xboxInlineReq && typeof ipcMain.removeListener === 'function') {
          try {
            ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
          } catch {}
        }
        clearOAuthPopupSessionCaches(popupSession);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Sign-in window closed by user.' });
        }
      });

      if (xboxInlineReq && xboxInlineReq.extraHeadersString) {
        authWindow.loadURL(targetAuthUrl, { extraHeaders: xboxInlineReq.extraHeadersString });
      } else {
        authWindow.loadURL(targetAuthUrl);
      }
    });
  });

  ipcMain.handle(
    'store:exchange-code',
    async (/** @type {any} */ _event, /** @type {{ storefrontId: string, code: string }} */ { storefrontId, code }) => {
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
      /** @type {Record<string, any> | undefined} */ fallbackCredentials
    ) => {
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

        if (
          !isRealSecretToken(tokenData.access_token) &&
          !isRealSecretToken(tokenData.xblAccessToken) &&
          !isRealSecretToken(tokenData.userStsLegacyTokenXml) &&
          !isRealSecretToken(tokenData.msaRefreshToken) &&
          !isRealSecretToken(tokenData.refresh_token) &&
          !isRealSecretToken(tokenData.webapi_token) &&
          !isRealSecretToken(tokenData.apiKey) &&
          !cleanFallbackEpicToken &&
          !cleanFallbackGogToken
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
                  /** @type {{ response?: { games?: Array<{ appid?: number }> } } | null} */
                  const apiJson = /** @type {any} */ (await res.json());
                  if (Array.isArray(apiJson?.response?.games) && apiJson.response.games.length > 0) {
                    const ownedAppIds = apiJson.response.games
                      .map((/** @type {any} */ g) => g.appid)
                      .filter(Boolean);
                    const storeItems = await fetchSteamStoreBrowseItemsMap(ownedAppIds);
                    const refreshed = await parseSteamGamesListJson(
                      { rgGames: apiJson.response.games, storeItems, strProfileName: accountName },
                      tokenData.steamId,
                      accountName,
                      avatarUrl,
                      games,
                      storeSync
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
                const cleanBrowserUA = resolveCleanBrowserUserAgent(session);

                /** @type {{ rgGames: any[], storeItems: Record<string, any>, webApiToken?: string } | null} */
                let ssrResult = null;
                const steamOAuthPartition = resolveStorefrontOAuthPartition('steam');
                try {
                  const authSession =
                    session?.fromPartition?.(steamOAuthPartition) ||
                    session?.fromPartition?.('persist:storefront_auth');
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
                      if (ssrRes && ssrRes.ok && isAuthenticatedSteamCommunityUrl(resolvedSsrUrl)) {
                        const html = await ssrRes.text();
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
                              if (
                                Array.isArray(parsedLegacy?.rgGames) &&
                                parsedLegacy.rgGames.length > 0
                              ) {
                                ssrResult = {
                                  rgGames: parsedLegacy.rgGames,
                                  storeItems: parsedLegacy.storeItems || {},
                                  webApiToken:
                                    parsedLegacy.strWebAPIToken || parsedLegacy.webapi_token,
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
                    {
                      rgGames: ssrResult.rgGames,
                      strProfileName: accountName,
                      storeItems: ssrResult.storeItems || {},
                    },
                    tokenData.steamId,
                    accountName,
                    avatarUrl,
                    games,
                    storeSync
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

                if (!refreshedLive && BrowserWindow) {
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
                    const refreshed = await parseSteamGamesListJson(
                      {
                        rgGames: ssrResult.rgGames,
                        strProfileName: accountName,
                        storeItems: ssrResult.storeItems || {},
                      },
                      tokenData.steamId,
                      accountName,
                      avatarUrl,
                      games,
                      storeSync
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

            /** @type {Record<number, any>} */
            let steamAchMap = {};
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
              steamAchMap = await fetchSteamBatchAchievements(
                tokenData.webapi_token,
                tokenData.steamId,
                appIds
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
                  return g.isVerifiedEntitlement === true ? g : { ...g, isVerifiedEntitlement: true };
                }
                return {
                  ...g,
                  isVerifiedEntitlement: true,
                  platforms: (g.platforms || []).map((/** @type {any} */ p) => {
                    if (p.platformId !== 'steam') return p;
                    const mergedPt =
                      localPt && localPt.playtimeMinutes
                        ? Math.max(Number(p.playtimeMinutes || 0), localPt.playtimeMinutes)
                        : Number(p.playtimeMinutes || 0);
                    const existingAch = p.achievements;
                    let mergedAch = existingAch;
                    if (ach && ach.total > 0) {
                      const bestUnlocked = existingAch
                        ? Math.max(ach.unlocked, Number(existingAch.unlocked || 0))
                        : ach.unlocked;
                      const bestTotal = existingAch
                        ? Math.max(ach.total, Number(existingAch.total || 0))
                        : ach.total;
                      const pct = bestTotal > 0 ? Math.round((bestUnlocked / bestTotal) * 100) : 0;
                      mergedAch = {
                        unlocked: bestUnlocked,
                        total: bestTotal,
                        percentage: pct,
                        isMastered:
                          Boolean(ach.isMastered) || (bestTotal > 0 && bestUnlocked >= bestTotal),
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
                    .scanLocalSuppressedStorefrontItems()
                    .filter((/** @type {any} */ x) => x.platformId === 'gog')
                : [];
            return {
              success: true,
              storefrontId,
              accountName,
              accountId,
              avatarUrl,
              games,
              achievements: storeSync.fetchGogOwnedGames.lastAchievementsMap || {},
              suppressedItems: [
                ...(storeSync.fetchGogOwnedGames.lastSuppressedItems || []),
                ...localGogSuppressed,
              ],
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
              games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
            } catch (err) {
              if (cleanFallbackEpicToken && cleanFallbackEpicToken !== accessToken) {
                try {
                  accessToken = cleanFallbackEpicToken;
                  games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
                  storeSync.saveTokens('epic', {
                    ...tokenData,
                    access_token: accessToken,
                    refresh_token:
                      cleanFallbackEpicRefresh || tokenData.refresh_token,
                    account_id: accountId,
                  });
                } catch {
                  games = [];
                }
              }
              if (!games || games.length === 0) {
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
                ? storeSync
                    .scanLocalSuppressedStorefrontItems()
                    .filter((/** @type {any} */ x) => x.platformId === 'epic')
                : [];
            return {
              success: true,
              storefrontId,
              accountName,
              accountId,
              avatarUrl,
              games,
              achievements: storeSync.fetchEpicOwnedGames.lastAchievementsMap || {},
              suppressedItems: [
                ...(storeSync.fetchEpicOwnedGames.lastSuppressedItems || []),
                ...localEpicSuppressed,
              ],
            };
          } else if (storefrontId === 'xbox') {
            const xboxSync = await storeSync.syncXboxLibrary({
              syncMode: fallbackCredentials?.syncMode,
              forceRefresh: Boolean(fallbackCredentials?.forceRefresh),
            });
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
              games: xboxSync.games || [],
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
      if (!gogEntry.avatarUrl || !gogEntry.username) {
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
          if (isRealSecretToken(gogEntry.refresh_token)) {
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
  ipcMain.handle('store:get-saved-tokens', handleGetSavedStoreTokens);

  /**
   * @param {any} _event
   * @param {string | { storefrontId?: string, store?: string }} rawStorefrontArg
   */
  const handleClearStoreTokens = async (_event, rawStorefrontArg) => {
    const storefrontId =
      rawStorefrontArg && typeof rawStorefrontArg === 'object'
        ? rawStorefrontArg.storefrontId || rawStorefrontArg.store || ''
        : String(rawStorefrontArg || '');
    storeSync.clearTokens(storefrontId);
    try {
      launcherEngine?.purgeStoreHelperCredentials?.(storefrontId);
    } catch {}
    const partitionsToClear = [resolveStorefrontOAuthPartition(storefrontId)];
    if (storefrontId === 'xbox') {
      partitionsToClear.push('persist:auth_xbox');
    }
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
  ipcMain.handle('store:clear-token', handleClearStoreTokens);
  ipcMain.handle('store:disconnect', handleClearStoreTokens);

  /**
   * @param {any} _event
   * @param {any} arg1
   * @param {any} arg2
   */
  const handleSaveStoreTokens = async (_event, arg1, arg2) => {
    const rawStorefrontId =
      arg1 && typeof arg1 === 'object' ? arg1.storefrontId || arg1.store : arg1;
    const rawTokenData =
      arg1 && typeof arg1 === 'object' ? arg1.tokenData || arg1.tokens || arg2 : arg2;
    const storefrontId = typeof rawStorefrontId === 'string' ? rawStorefrontId.trim() : '';
    if (
      !storefrontId ||
      storefrontId === '__proto__' ||
      storefrontId === 'constructor' ||
      storefrontId === 'prototype' ||
      !rawTokenData ||
      typeof rawTokenData !== 'object' ||
      Array.isArray(rawTokenData)
    ) {
      return { success: false, error: 'Invalid storefront token payload' };
    }
    const cleanIncoming = sanitizeLaunchConfigRecursive(rawTokenData);
    const existing = storeSync.loadSavedTokens()?.[storefrontId] || {};
    /** @type {Record<string, any>} */
    const merged = { ...existing };
    for (const [k, v] of Object.entries(cleanIncoming)) {
      if (SECRET_TOKEN_OBJECT_KEYS.has(k) && typeof v === 'string' && !isRealSecretToken(v)) {
        // Ignore renderer sentinel strings (`saved_in_electron`, `[REDACTED]`, etc.) so vaulted secrets stay intact
        continue;
      }
      merged[k] = v;
    }
    storeSync.saveTokens(storefrontId, merged);
    try {
      launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
    } catch {}
    return { success: true };
  };

  ipcMain.handle('store:save-tokens', handleSaveStoreTokens);
  ipcMain.handle('store:save-token', handleSaveStoreTokens);

  ipcMain.handle(
    'epic:fetch-achievements',
    async (
      /** @type {any} */ _event,
      /** @type {{ accountId?: string, accessToken?: string }} */ { accountId, accessToken } = {}
    ) => {
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedEpic = savedTokens?.epic || {};
        let resolvedAccountId = accountId || savedEpic.account_id;
        let resolvedToken =
          (isRealSecretToken(accessToken) ? accessToken.trim() : '') ||
          (isRealSecretToken(savedEpic.access_token) ? savedEpic.access_token : '');
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
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC epic:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'epic:fetch-game-schema',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.getEpicGameAchievementSchema === 'function') {
          return await storeSync.getEpicGameAchievementSchema(payload);
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
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        return await storeSync.fetchEpicProductOfferMetadata(payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:fetch-epic-metadata warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'xbox:fetch-achievements',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.fetchXboxAchievements === 'function') {
          return await storeSync.fetchXboxAchievements(payload);
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
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.getXboxGameAchievementSchema === 'function') {
          return await storeSync.getXboxGameAchievementSchema(payload);
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
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        const platformId = String(payload?.platformId || payload?.storefrontId || '')
          .trim()
          .toLowerCase();
        if (platformId === 'xbox' && typeof storeSync.fetchXboxDetailedGameAchievements === 'function') {
          return await storeSync.fetchXboxDetailedGameAchievements(payload);
        }
        if (platformId === 'epic' && typeof storeSync.getEpicGameAchievementSchema === 'function') {
          const list = await storeSync.getEpicGameAchievementSchema(payload);
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
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.fetchXboxProductOfferMetadata === 'function') {
          return await storeSync.fetchXboxProductOfferMetadata(payload);
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
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.getXboxStatus === 'function') {
          return await storeSync.getXboxStatus(payload);
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
    async (
      /** @type {any} */ _event,
      /** @type {{ username?: string, accessToken?: string, userId?: string }} */ {
        username,
        accessToken,
        userId,
      } = {}
    ) => {
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedGog = savedTokens?.gog || {};
        let resolvedToken =
          (isRealSecretToken(accessToken) ? accessToken.trim() : '') ||
          (isRealSecretToken(savedGog.access_token) ? savedGog.access_token : '');
        let resolvedUsername = username;
        let resolvedUserId = userId || savedGog.user_id;

        if (resolvedToken) {
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
        return await storeSync.fetchGogAchievements(resolvedToken, resolvedUsername, resolvedUserId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC gog:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'steam:fetch-achievements',
    async (
      /** @type {any} */ _event,
      /** @type {{ appIds?: Array<number | string> }} */ { appIds } = {}
    ) => {
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedSteam = savedTokens?.steam || {};
        const resolvedAppIds =
          Array.isArray(appIds) && appIds.length > 0
            ? appIds
            : Array.isArray(savedSteam.games)
              ? savedSteam.games
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

  ipcMain.handle('hltb:search', async (/** @type {any} */ _event, /** @type {unknown} */ gameTitle) => {
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

      /** @param {string} authToken */
      const executeSearch = async (authToken) =>
        fetch('https://howlongtobeat.com/api/search/site', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': authToken,
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
            Referer: 'https://howlongtobeat.com/',
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

      /** @type {{ data?: unknown[] } | null} */
      const json = /** @type {any} */ (await searchRes.json());
      return { success: true, data: json?.data || [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, data: [] };
    }
  });

  ipcMain.handle(
    'igdb:fetch-cover',
    async (/** @type {any} */ _event, /** @type {string} */ gameTitle) => {
      try {
        return await storeSync.fetchIgdbCover(gameTitle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC igdb:fetch-cover warning:', msg);
        return null;
      }
    }
  );

  return {
    trimStoreSyncIpcMemory: trimSteamLocalScannerMemory,
  };
}

module.exports = {
  registerStoreSyncIpcHandlers,
  STORE_OAUTH_URLS,
  STOREFRONT_OAUTH_PARTITIONS,
  resolveStorefrontOAuthPartition,
  sanitizeStoreTokenEntryForRenderer,
};
