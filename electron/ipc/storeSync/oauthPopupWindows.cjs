// @ts-check
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {
  isAllowedHttpsHost,
  getCanonicalChromeUserAgent,
} = require('../../launcher/securityAndPathUtils.cjs');
const {
  diagLog,
  redactSensitiveDiagnosticText,
} = require('../../utils/diagnosticLogger.cjs');
const {
  parseSteamGamesListJson,
} = require('../../storefronts/steamLocalScanner.cjs');
const {
  STORE_OAUTH_URLS,
  STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT,
} = require('../../storefronts/epicAuthRecovery.cjs');
const {
  generateXboxOAuthState,
  verifyXboxOAuthState,
} = require('../../storefronts/xbox/xboxAuthManager.cjs');

const XBOX_TRUSTED_AUTH_HOSTS = Object.freeze([
  'login.live.com',
  'account.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'account.microsoft.com',
  'sisu.xboxlive.com',
]);

const XBOX_POPUP_NAV_ALLOWLIST = Object.freeze([
  ...XBOX_TRUSTED_AUTH_HOSTS,
  'xbox.com',
  'live.com',
  'microsoft.com',
  'microsoftonline.com',
  'msftauth.net',
  'msauth.net',
]);

const STOREFRONT_OAUTH_POPUP_NAV_HOSTS = Object.freeze({
  xbox: XBOX_POPUP_NAV_ALLOWLIST,
  gog: Object.freeze([
    'gog.com',
    'embed.gog.com',
    'auth.gog.com',
    'login.gog.com',
    'accounts.google.com',
    'appleid.apple.com',
  ]),
  epic: Object.freeze([
    'epicgames.com',
    'unrealengine.com',
    'accounts.google.com',
    'appleid.apple.com',
    'login.live.com',
    'login.microsoftonline.com',
    'steamcommunity.com',
    'store.steampowered.com',
    'playstation.com',
    'sonyentertainmentnetwork.com',
    'accounts.nintendo.com',
    'hcaptcha.com',
    'arkoselabs.com',
    'funcaptcha.com',
  ]),
  steam: Object.freeze([
    'steamcommunity.com',
    'store.steampowered.com',
    'steampowered.com',
    'help.steampowered.com',
    'login.steampowered.com',
  ]),
});

const STOREFRONT_OAUTH_PARTITIONS = Object.freeze({
  xbox: 'persist:oauth_xbox',
  gog: 'persist:oauth_gog',
  epic: 'persist:oauth_epic',
  steam: 'persist:oauth_steam',
});

const ALL_OAUTH_PARTITIONS_TO_CLEAR = Object.freeze([
  'persist:oauth_steam',
  'persist:oauth_gog',
  'persist:oauth_epic',
  'persist:oauth_xbox',
  'persist:auth_xbox',
  'persist:oauth_generic',
]);

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

const OFFLINE_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_REFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Check whether the host currently reports online reachability via Electron `net.isOnline()`
 * (or injected test override in `handlerOptions`).
 *
 * @param {Record<string, any>} [handlerOptions]
 * @returns {boolean}
 */
function isNetworkOnlineForStoreSync(handlerOptions) {
  if (typeof handlerOptions?.isOnline === 'function') {
    try {
      return Boolean(handlerOptions.isOnline());
    } catch {}
  }
  if (typeof handlerOptions?.net?.isOnline === 'function') {
    try {
      return Boolean(handlerOptions.net.isOnline());
    } catch {}
  }
  try {
    const electronMod = require('electron');
    if (typeof electronMod?.net?.isOnline === 'function') {
      return Boolean(electronMod.net.isOnline());
    }
  } catch {}
  return true;
}

/**
 * Classify whether a thrown fetch/network error indicates offline reachability loss or timeout.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isOfflineOrNetworkError(err) {
  if (!err) return false;
  const anyErr = /** @type {any} */ (err);
  const name = String(anyErr?.name || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = String(anyErr?.code || anyErr?.cause?.code || '').toUpperCase();
  if (code && OFFLINE_NETWORK_ERROR_CODES.has(code)) return true;
  const msg = String(anyErr?.message || anyErr?.cause?.message || String(err));
  return /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|fetch failed|network(?:\s+request)?\s+failed|timed?\s*out|aborted/i.test(
    msg
  );
}

/**
 * Read per-call non-enumerable metadata attached to the returned games array.
 *
 * @param {any} gamesArray
 * @param {any} fnRef
 * @returns {{ authoritativeComplete: boolean, achievementsMap: Record<string, any>, suppressedItems: any[] }}
 */
function readSyncResultMeta(gamesArray, fnRef) {
  const hasPerArrayAuth =
    gamesArray &&
    typeof gamesArray === 'object' &&
    typeof gamesArray.authoritativeComplete === 'boolean';
  const authoritativeComplete = hasPerArrayAuth
    ? gamesArray.authoritativeComplete
    : Boolean(fnRef?.lastAuthoritativeComplete);
  const achievementsMap =
    gamesArray &&
    typeof gamesArray === 'object' &&
    gamesArray.achievementsMap &&
    typeof gamesArray.achievementsMap === 'object'
      ? gamesArray.achievementsMap
      : fnRef?.lastAchievementsMap || {};
  const suppressedItems =
    gamesArray && typeof gamesArray === 'object' && Array.isArray(gamesArray.suppressedItems)
      ? gamesArray.suppressedItems
      : Array.isArray(fnRef?.lastSuppressedItems)
        ? fnRef.lastSuppressedItems
        : [];
  return { authoritativeComplete, achievementsMap, suppressedItems };
}

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
 * Resolve all OAuth session partition names to clear when disconnecting one or all storefronts.
 * Clearing an empty or `'all'` storefront clears every known OAuth partition.
 *
 * @param {unknown} rawStorefrontId
 * @returns {string[]}
 */
function resolvePartitionsToClearForStorefront(rawStorefrontId) {
  const normalized = String(rawStorefrontId || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') {
    return [...ALL_OAUTH_PARTITIONS_TO_CLEAR];
  }
  const partitions = [resolveStorefrontOAuthPartition(normalized)];
  if (normalized === 'xbox') {
    partitions.push('persist:auth_xbox');
  }
  return partitions;
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
 * Validate whether an OAuth popup window for `storefrontId` is permitted to navigate to `urlStr`.
 *
 * @param {string} storefrontId
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isAllowedOAuthPopupNavigationUrl(storefrontId, urlStr) {
  if (typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (trimmed === 'about:blank') return true;

  const storeKey = String(storefrontId || '').trim().toLowerCase();
  if (storeKey === 'epic') {
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.hostname.toLowerCase() === 'localhost' &&
        parsed.pathname.startsWith('/launcher/authorized')
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }

  const allowedHosts = Object.prototype.hasOwnProperty.call(STOREFRONT_OAUTH_POPUP_NAV_HOSTS, storeKey)
    ? STOREFRONT_OAUTH_POPUP_NAV_HOSTS[
        /** @type {keyof typeof STOREFRONT_OAUTH_POPUP_NAV_HOSTS} */ (storeKey)
      ]
    : null;
  if (!allowedHosts) return false;
  return isAllowedHttpsHost(trimmed, allowedHosts);
}

/**
 * Clean Electron/OneLauncher tokens from User-Agent string so storefront OAuth pages do not block WebViews.
 * Uses the canonical Chrome User-Agent derived from `process.versions.chrome` as fallback.
 *
 * @param {any} session
 * @returns {string}
 */
function resolveCleanBrowserUserAgent(session) {
  const defaultUa = getCanonicalChromeUserAgent();
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

/**
 * Create the Xbox Store `TokenBroker` (`InlineLogin.srf`) interactive recovery flow and
 * register the `auth:storefront` OAuth popup IPC handler with strict popup hardening
 * (`setWindowOpenHandler(() => ({ action: 'deny' }))`, host-allowlisted `will-navigate`,
 * and `isTrustedXboxUrl(exResult.inlineAuthUrl)` before `loadURL`).
 *
 * @param {{
 *   ipcMain: any,
 *   BrowserWindow: any,
 *   session: any,
 *   getMainWindow: () => any,
 *   storeSync: any,
 *   launcherEngine: any,
 *   processStoreAuth: (storefrontId: string, codeOrPayload: any) => Promise<any>,
 *   handlerOptions?: Record<string, any>,
 * }} deps
 */
function registerOAuthPopupHandlers({
  ipcMain,
  BrowserWindow,
  session,
  getMainWindow,
  storeSync,
  launcherEngine,
  processStoreAuth,
  handlerOptions = {},
}) {
  /** @type {Promise<{ recovered: boolean, error?: string }> | null} */
  let inFlightXboxLicenseRecovery = null;

  /**
   * On-demand single-flight Microsoft Store `TokenBroker` (`InlineLogin.srf`) recovery hook.
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

      const isTrustedXboxUrl = (/** @type {unknown} */ candidate) => {
        if (!isAllowedHttpsHost(candidate, XBOX_TRUSTED_AUTH_HOSTS)) {
          return false;
        }
        if (typeof storeSync?.xboxStorefront?.isTrustedXboxAuthUrl === 'function') {
          return Boolean(storeSync.xboxStorefront.isTrustedXboxAuthUrl(String(candidate)));
        }
        return true;
      };

      if (!isTrustedXboxUrl(xboxInlineReq?.url)) {
        return { recovered: false, error: 'Untrusted Xbox inline login URL rejected.' };
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
          preload: path.join(__dirname, '../../xboxAuthPreload.cjs'),
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

        if (typeof authWindow.webContents?.setWindowOpenHandler === 'function') {
          authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        }

        authWindow.webContents.on(
          'will-navigate',
          (/** @type {any} */ event, /** @type {string} */ targetUrl) => {
            if (
              targetUrl !== 'about:blank' &&
              !isTrustedXboxUrl(targetUrl) &&
              !isAllowedHttpsHost(targetUrl, XBOX_POPUP_NAV_ALLOWLIST)
            ) {
              event?.preventDefault?.();
            }
          }
        );

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
                if (!isTrustedXboxUrl(exResult.inlineAuthUrl)) {
                  resolved = true;
                  safelyCloseAuthWindow();
                  resolve({
                    recovered: false,
                    error: 'Untrusted Xbox inline auth URL rejected.',
                  });
                  return;
                }
                xboxIsSecondLeg = true;
                const leg2Req =
                  typeof storeSync?.xboxStorefront?.buildInlineLoginRequest === 'function'
                    ? storeSync.xboxStorefront.buildInlineLoginRequest({
                        urlOverride: exResult.inlineAuthUrl,
                      })
                    : null;
                if (leg2Req?.extraHeadersString) {
                  authWindow.loadURL(exResult.inlineAuthUrl, {
                    extraHeaders: leg2Req.extraHeadersString,
                  });
                } else {
                  authWindow.loadURL(exResult.inlineAuthUrl);
                }
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

  ipcMain.handle(
    'auth:storefront',
    async (/** @type {any} */ _event, /** @type {string} */ storefrontId) => {
      const config = STORE_OAUTH_URLS[storefrontId];
      if (!config) {
        return { success: false, error: `Unsupported storefront: ${storefrontId}` };
      }

      return new Promise((resolve) => {
        let resolved = false;
        let extractingSteam = false;

        const cleanBrowserUA = resolveCleanBrowserUserAgent(session);
        const currentMain = getMainWindow?.();
        let targetAuthUrl = config.url;
        let xboxCsrfState = '';
        /** @type {any} */
        let xboxProvider = null;

        if (storefrontId === 'xbox') {
          try {
            xboxProvider = storeSync?.getXboxAuthProvider?.() || null;
            if (xboxProvider && typeof xboxProvider.beginOAuthAuthorization === 'function') {
              const authReq = xboxProvider.beginOAuthAuthorization();
              targetAuthUrl = authReq.url;
              xboxCsrfState = authReq.state;
            } else {
              xboxCsrfState = generateXboxOAuthState();
              const parsedCfgUrl = new URL(config.url);
              parsedCfgUrl.searchParams.set('state', xboxCsrfState);
              targetAuthUrl = parsedCfgUrl.toString();
            }
          } catch (err) {
            diagLog.warn(
              'storeSyncIpc.authStorefront.xboxBeginOAuth',
              scrubAuthDiagnosticError(err)
            );
            xboxCsrfState = generateXboxOAuthState();
            try {
              const parsedCfgUrl = new URL(config.url);
              parsedCfgUrl.searchParams.set('state', xboxCsrfState);
              targetAuthUrl = parsedCfgUrl.toString();
            } catch {
              targetAuthUrl = config.url;
            }
          }
        }

        if (!isAllowedOAuthPopupNavigationUrl(storefrontId, targetAuthUrl)) {
          resolve({ success: false, error: `Untrusted auth URL for storefront: ${storefrontId}` });
          return;
        }

        const oauthPartition = resolveStorefrontOAuthPartition(storefrontId);

        /** @type {Record<string, any>} */
        const webPreferences = {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          userAgent: cleanBrowserUA,
          partition: oauthPartition,
        };

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

        if (typeof authWindow.webContents?.setUserAgent === 'function' && cleanBrowserUA) {
          authWindow.webContents.setUserAgent(cleanBrowserUA);
        }

        if (typeof authWindow.webContents?.setWindowOpenHandler === 'function') {
          authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        }

        const popupSession =
          authWindow.webContents?.session ||
          (typeof session?.fromPartition === 'function'
            ? session.fromPartition(oauthPartition)
            : null);

        const safelyCloseAuthWindow = () => {
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

        /** @param {string | { code: string, state?: string, expectedState?: string, url?: string }} codeOrPayload */
        const handleAuthCodeFound = async (codeOrPayload) => {
          if (!codeOrPayload || resolved) return;
          resolved = true;
          safelyCloseAuthWindow();
          const syncResult = await processStoreAuth(storefrontId, codeOrPayload);
          resolve(syncResult);
        };

        /** @param {string} url */
        const checkUrlForCode = (url) => {
          if (!url || resolved) return;

          if (
            storefrontId === 'gog' &&
            isAllowedHttpsHost(url, ['embed.gog.com', 'auth.gog.com', 'gog.com'])
          ) {
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

          if (storefrontId === 'xbox' && isAllowedHttpsHost(url, XBOX_TRUSTED_AUTH_HOSTS)) {
            try {
              const parsed = new URL(url);
              const normalizedPath = parsed.pathname.replace(/\/+$/, '').toLowerCase();
              if (normalizedPath.endsWith('/oauth20_desktop.srf')) {
                const hashParams = new URLSearchParams(parsed.hash.replace(/^#\/?/, ''));
                const getParam = (/** @type {string} */ name) => {
                  const qVal = parsed.searchParams.get(name);
                  if (qVal !== null && qVal !== undefined && qVal !== '') return qVal;
                  return hashParams.get(name);
                };

                const errCode = getParam('error');
                if (errCode) {
                  const safeErr =
                    String(errCode).replace(/[^\w.-]/g, '').slice(0, 64) || 'access_denied';
                  const rawErrDesc =
                    getParam('error_description') || getParam('error_subcode') || safeErr;
                  const safeErrDesc = scrubAuthDiagnosticError(rawErrDesc) || safeErr;
                  resolved = true;
                  xboxProvider?.clearPendingOAuthState?.();
                  safelyCloseAuthWindow();
                  resolve({
                    success: false,
                    storefrontId: 'xbox',
                    error: `Microsoft sign-in cancelled (${safeErrDesc})`,
                  });
                  return;
                }
                const returnedState = getParam('state');
                if (xboxCsrfState && !verifyXboxOAuthState(returnedState, xboxCsrfState)) {
                  resolved = true;
                  xboxProvider?.clearPendingOAuthState?.();
                  safelyCloseAuthWindow();
                  resolve({
                    success: false,
                    storefrontId: 'xbox',
                    error: 'Microsoft OAuth state mismatch (CSRF validation failed).',
                  });
                  return;
                }
                const code = getParam('code');
                if (code) {
                  handleAuthCodeFound({
                    code: code.trim(),
                    state: returnedState || xboxCsrfState,
                    expectedState: xboxCsrfState,
                    url,
                  });
                  return;
                }
              }
            } catch {}
          }
        };

        const tryExtractSteamGames = async () => {
          if (
            resolved ||
            extractingSteam ||
            authWindow.isDestroyed() ||
            storefrontId !== 'steam'
          ) {
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
              };
              const steamCacheOpts = handlerOptions.userDataDir
                ? { userDataDir: handlerOptions.userDataDir }
                : {};
              storeSync.saveTokens('steam', tokenPayload);
              if (typeof storeSync.saveSteamOwnedGamesCache === 'function') {
                storeSync.saveSteamOwnedGamesCache(parsedSteam.games, {
                  ...steamCacheOpts,
                  steamId: parsedSteam.accountId,
                });
              }
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

        authWindow.webContents.on(
          'will-redirect',
          (/** @type {any} */ event, /** @type {string} */ url) => {
            checkUrlForCode(url);
            if (!resolved && !isAllowedOAuthPopupNavigationUrl(storefrontId, url)) {
              event?.preventDefault?.();
            }
          }
        );

        authWindow.webContents.on(
          'will-navigate',
          (/** @type {any} */ event, /** @type {string} */ url) => {
            checkUrlForCode(url);
            if (!resolved && !isAllowedOAuthPopupNavigationUrl(storefrontId, url)) {
              event?.preventDefault?.();
            }
          }
        );

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
          clearOAuthPopupSessionCaches(popupSession);
          if (!resolved) {
            resolved = true;
            xboxProvider?.clearPendingOAuthState?.();
            resolve({ success: false, error: 'Sign-in window closed by user.' });
          }
        });

        authWindow.loadURL(targetAuthUrl);
      });
    }
  );

  return {
    recoverXboxStoreLicenseSession,
  };
}

module.exports = {
  XBOX_TRUSTED_AUTH_HOSTS,
  XBOX_POPUP_NAV_ALLOWLIST,
  STOREFRONT_OAUTH_POPUP_NAV_HOSTS,
  STOREFRONT_OAUTH_PARTITIONS,
  ALL_OAUTH_PARTITIONS_TO_CLEAR,
  isNetworkOnlineForStoreSync,
  isOfflineOrNetworkError,
  readSyncResultMeta,
  isRealSecretToken,
  scrubAuthDiagnosticError,
  resolveStorefrontOAuthPartition,
  resolvePartitionsToClearForStorefront,
  clearOAuthPopupSessionCaches,
  isLivePostSrfUrl,
  isEpicAuthRedirectUrl,
  isAuthenticatedSteamCommunityUrl,
  isAllowedOAuthPopupNavigationUrl,
  resolveCleanBrowserUserAgent,
  sanitizeStoreTokenEntryForRenderer,
  registerOAuthPopupHandlers,
};
