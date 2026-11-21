// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  isAllowedHttpsHost,
  getCanonicalChromeUserAgent,
} = require('../launcher/securityAndPathUtils.cjs');

const EMBED_FILTERS = Object.freeze([
  '*://*.youtube.com/*',
  '*://youtube.com/*',
  '*://*.youtube-nocookie.com/*',
  '*://youtube-nocookie.com/*',
  '*://*.wistia.net/*',
  '*://*.fast.wistia.net/*',
]);

const STORE_API_FILTERS = Object.freeze([
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
  '*://*.wikidata.org/*',
]);

const BEFORE_SEND_FILTERS = Object.freeze([
  ...EMBED_FILTERS,
  '*://*.steampowered.com/*',
  '*://*.lutris.net/*',
  '*://*.metacritic.com/*',
  '*://metacritic.com/*',
  '*://*.opencritic.com/*',
  '*://opencritic.com/*',
  '*://*.wikidata.org/*',
  '*://wikidata.org/*',
]);

const HEADERS_RECEIVED_FILTERS = Object.freeze(['http://*/*', 'https://*/*']);

const EMBED_HOST_ALLOWLIST = Object.freeze(
  EMBED_FILTERS.map((f) => f.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/\*$/, ''))
);

const STORE_API_HOST_ALLOWLIST = Object.freeze(
  STORE_API_FILTERS.map((f) => f.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/\*$/, ''))
);

const APP_CSP_PACKAGED = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: ol-media: https:",
  "media-src 'self' data: blob: ol-media: https:",
  "connect-src 'self' ol-media: https:",
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com https://youtube.com https://youtube-nocookie.com https://*.wistia.net https://*.fast.wistia.net',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const APP_CSP_DEV = [
  "default-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* http://[::1]:* ws://[::1]:*",
  "script-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: ol-media: https:",
  "media-src 'self' data: blob: ol-media: https:",
  "connect-src 'self' ol-media: https: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* http://[::1]:* ws://[::1]:*",
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com https://youtube.com https://youtube-nocookie.com https://*.wistia.net https://*.fast.wistia.net',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/** @type {string | null} */
let cachedPackageJsonVersion = null;

/**
 * Read the application version dynamically from Electron `app.getVersion()`, falling back
 * to `package.json` (read and cached once) so version strings are never hardcoded.
 *
 * @param {any} app
 * @returns {string}
 */
function resolveAppVersionString(app) {
  try {
    const resolved = typeof app?.getVersion === 'function' ? String(app.getVersion() || '').trim() : '';
    if (resolved) {
      return resolved;
    }
  } catch {}
  if (cachedPackageJsonVersion !== null) {
    return cachedPackageJsonVersion;
  }
  try {
    const pkgPath = path.join(__dirname, '../../package.json');
    const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(pkgRaw);
    const ver = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
    cachedPackageJsonVersion = ver || '0.0.0';
  } catch {
    cachedPackageJsonVersion = '0.0.0';
  }
  return cachedPackageJsonVersion;
}

/**
 * Case-insensitively set a header key while removing any differently-cased duplicates.
 *
 * @param {Record<string, any>} headers
 * @param {string} name
 * @param {any} value
 */
function setHeaderCaseInsensitive(headers, name, value) {
  if (!headers || typeof headers !== 'object') return;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower && key !== name) {
      delete headers[key];
    }
  }
  headers[name] = value;
}

/**
 * Case-insensitively delete all keys matching `name`.
 *
 * @param {Record<string, any>} headers
 * @param {string} name
 */
function deleteHeaderCaseInsensitive(headers, name) {
  if (!headers || typeof headers !== 'object') return;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

/**
 * Delete `Origin: null` headers emitted by packaged `file://` origins on metadata API requests.
 *
 * @param {Record<string, any>} headers
 */
function deleteNullOriginHeader(headers) {
  if (!headers || typeof headers !== 'object') return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'origin') {
      const val = String(headers[key] ?? '').trim().toLowerCase();
      if (val === 'null') {
        delete headers[key];
      }
    }
  }
}

/**
 * Verify fail-closed that a webRequest `details` payload belongs to the active `mainWindow`
 * (`details.webContentsId === mainWindow.webContents.id`). Rejects requests when `mainWindow`
 * is destroyed/missing (`zero_renderer_daemon`), when `webContentsId` is absent/invalid, or
 * when initiated by any other window.
 *
 * @param {any} details
 * @param {() => any} getMainWindow
 * @returns {boolean}
 */
function isTrustedMainWindowWebRequest(details, getMainWindow) {
  const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
  if (
    !mainWindow ||
    (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) ||
    !mainWindow.webContents
  ) {
    return false;
  }
  if (typeof details?.webContentsId !== 'number' || details.webContentsId <= 0) {
    return false;
  }
  return details.webContentsId === mainWindow.webContents.id;
}

/**
 * Verify fail-closed that a webRequest was initiated by the top-level main app frame
 * (not an embedded third-party iframe, popup, or detached/missing webContents).
 *
 * @param {any} details
 * @param {{ getMainWindow: () => any, isPackaged?: boolean }} opts
 * @returns {boolean}
 */
function checkMainAppFrameInitiator(details, { getMainWindow, isPackaged = false }) {
  if (!isTrustedMainWindowWebRequest(details, getMainWindow)) {
    return false;
  }
  const mainWindow = getMainWindow();
  if (
    details?.frame &&
    mainWindow?.webContents?.mainFrame &&
    details.frame !== mainWindow.webContents.mainFrame
  ) {
    return false;
  }
  const initiator =
    typeof details?.initiator === 'string' ? details.initiator.trim().toLowerCase() : '';
  if (
    !initiator ||
    initiator === 'null' ||
    initiator.startsWith('file://') ||
    initiator.startsWith('ol-media://')
  ) {
    return true;
  }
  if (
    !isPackaged &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(initiator)
  ) {
    return true;
  }
  return false;
}

/**
 * Return true if `url` is a trusted unpackaged loopback dev document URL (`localhost`, `127.0.0.1`, `[::1]`).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isLoopbackDevMainFrameUrl(url) {
  return (
    url.startsWith('http://localhost:') ||
    url.startsWith('http://127.0.0.1:') ||
    url.startsWith('http://[::1]:')
  );
}

/**
 * Register fail-closed `onBeforeSendHeaders` and HTTP(S)-filtered
 * `onHeadersReceived` guards on `session.defaultSession.webRequest`.
 *
 * @param {{
 *   session: any,
 *   app: any,
 *   getMainWindow: () => any,
 *   isMainAppFrameInitiator?: (details: any) => boolean,
 * }} deps
 */
function registerWebRequestHeaderGuards({
  session,
  app,
  getMainWindow,
  isMainAppFrameInitiator: customInitiatorCheck,
}) {
  if (!session?.defaultSession?.webRequest) return;

  const isPackaged = Boolean(app?.isPackaged);
  const isMainAppFrameInitiator =
    typeof customInitiatorCheck === 'function'
      ? customInitiatorCheck
      : (/** @type {any} */ details) =>
          checkMainAppFrameInitiator(details, { getMainWindow, isPackaged });

  const standardChromeUa = getCanonicalChromeUserAgent();
  const wikimediaAppVersion = resolveAppVersionString(app);
  const wikimediaMetadataUa = `One-Launcher/${wikimediaAppVersion} (https://github.com/Space-Cadet0/One-Launcher; desktop library metadata bridge)`;

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [...BEFORE_SEND_FILTERS] },
    (/** @type {any} */ details, /** @type {any} */ callback) => {
      if (!isTrustedMainWindowWebRequest(details, getMainWindow)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }

      const requestHeaders = { ...(details.requestHeaders || {}) };
      const url = String(details.url || '');

      if (
        (details.resourceType === 'subFrame' || details.resourceType === 'mainFrame') &&
        isAllowedHttpsHost(url, EMBED_HOST_ALLOWLIST)
      ) {
        deleteHeaderCaseInsensitive(requestHeaders, 'origin');
        deleteHeaderCaseInsensitive(requestHeaders, 'referer');
        requestHeaders['Origin'] = 'https://www.gog.com';
        requestHeaders['Referer'] = 'https://www.gog.com/';
      }

      if (isMainAppFrameInitiator(details)) {
        if (isAllowedHttpsHost(url, ['store.steampowered.com'])) {
          const existingCookie = requestHeaders['Cookie'] || requestHeaders['cookie'] || '';
          deleteHeaderCaseInsensitive(requestHeaders, 'cookie');
          deleteHeaderCaseInsensitive(requestHeaders, 'accept-language');
          requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
          const steamMature =
            'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1';
          if (!existingCookie) {
            requestHeaders['Cookie'] = steamMature;
          } else {
            let updated = String(existingCookie).replace(
              /Steam_Language=[a-zA-Z_-]+/gi,
              'Steam_Language=english'
            );
            if (!/Steam_Language=/i.test(updated)) updated = `Steam_Language=english; ${updated}`;
            if (!updated.includes('birthtime=')) updated += '; birthtime=568022401';
            if (!updated.includes('mature_content=')) updated += '; mature_content=1';
            if (!updated.includes('wants_mature_content=')) updated += '; wants_mature_content=1';
            requestHeaders['Cookie'] = updated;
          }
        }

        if (isAllowedHttpsHost(url, ['lutris.net'])) {
          setHeaderCaseInsensitive(requestHeaders, 'User-Agent', standardChromeUa);
        }

        if (isAllowedHttpsHost(url, ['wikidata.org'])) {
          setHeaderCaseInsensitive(requestHeaders, 'User-Agent', wikimediaMetadataUa);
          deleteNullOriginHeader(requestHeaders);
        }

        if (isAllowedHttpsHost(url, ['metacritic.com'])) {
          setHeaderCaseInsensitive(requestHeaders, 'User-Agent', standardChromeUa);
          setHeaderCaseInsensitive(requestHeaders, 'Referer', 'https://www.metacritic.com/');
          deleteNullOriginHeader(requestHeaders);
        }

        if (isAllowedHttpsHost(url, ['opencritic.com'])) {
          setHeaderCaseInsensitive(requestHeaders, 'User-Agent', standardChromeUa);
          setHeaderCaseInsensitive(requestHeaders, 'Referer', 'https://opencritic.com/');
          deleteNullOriginHeader(requestHeaders);
        }
      }

      callback({ requestHeaders });
    }
  );

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [...HEADERS_RECEIVED_FILTERS] },
    (/** @type {any} */ details, /** @type {any} */ callback) => {
      if (!isTrustedMainWindowWebRequest(details, getMainWindow)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const url = String(details.url || '');
      const responseHeaders = { ...(details.responseHeaders || {}) };

      if (
        details.resourceType === 'mainFrame' &&
        (url.startsWith('file://') || (!isPackaged && isLoopbackDevMainFrameUrl(url)))
      ) {
        deleteHeaderCaseInsensitive(responseHeaders, 'content-security-policy');
        responseHeaders['Content-Security-Policy'] = [
          url.startsWith('file://') ? APP_CSP_PACKAGED : APP_CSP_DEV,
        ];
        callback({ responseHeaders });
        return;
      }

      // Allow embedded trailer subframes to render inside iframes without granting wildcard CORS
      if (details.resourceType === 'subFrame' && isAllowedHttpsHost(url, EMBED_HOST_ALLOWLIST)) {
        deleteHeaderCaseInsensitive(responseHeaders, 'x-frame-options');
        callback({ responseHeaders });
        return;
      }

      // Only inject CORS headers on storefront/metadata APIs when initiated by the top-level app frame
      if (isAllowedHttpsHost(url, STORE_API_HOST_ALLOWLIST) && isMainAppFrameInitiator(details)) {
        for (const key of Object.keys(responseHeaders)) {
          const lowerKey = key.toLowerCase();
          if (
            lowerKey === 'access-control-allow-origin' ||
            lowerKey === 'access-control-allow-methods' ||
            lowerKey === 'access-control-allow-headers' ||
            lowerKey === 'access-control-expose-headers' ||
            lowerKey === 'access-control-allow-credentials'
          ) {
            delete responseHeaders[key];
          }
        }

        responseHeaders['Access-Control-Allow-Origin'] = ['*'];
        responseHeaders['Access-Control-Allow-Methods'] = [
          'GET, POST, PUT, DELETE, OPTIONS, HEAD',
        ];
        responseHeaders['Access-Control-Allow-Headers'] = ['*'];
        responseHeaders['Access-Control-Expose-Headers'] = ['*'];
      }

      callback({ responseHeaders });
    }
  );
}

module.exports = {
  EMBED_FILTERS,
  STORE_API_FILTERS,
  BEFORE_SEND_FILTERS,
  HEADERS_RECEIVED_FILTERS,
  EMBED_HOST_ALLOWLIST,
  STORE_API_HOST_ALLOWLIST,
  APP_CSP_PACKAGED,
  APP_CSP_DEV,
  resolveAppVersionString,
  setHeaderCaseInsensitive,
  deleteHeaderCaseInsensitive,
  deleteNullOriginHeader,
  isTrustedMainWindowWebRequest,
  checkMainAppFrameInitiator,
  isLoopbackDevMainFrameUrl,
  registerWebRequestHeaderGuards,
};
