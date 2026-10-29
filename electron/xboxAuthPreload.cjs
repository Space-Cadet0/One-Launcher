// @ts-check
'use strict';

/**
 * Dedicated sandboxed remote-page preload for Microsoft / Xbox `InlineLogin.srf` (`CloudExperienceHost` `TokenBroker`).
 * Exposes ZERO launcher APIs, ZERO Node.js APIs, and ZERO filesystem/token access.
 * Only forwards `window.external.notify(payload)` strings (<= 64 KB) on top-frame HTTPS Microsoft auth hosts
 * and installs a non-intrusive passkey cancellation helper so macOS users can choose password/code/Authenticator
 * if WebAuthn passkeys hang inside Chromium.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const TRUSTED_HOSTS = [
  'login.live.com',
  'account.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'account.microsoft.com',
  'sisu.xboxlive.com',
];

/**
 * Validate strict `https:` origin hostname (exact match or `.subdomain` match) via `new URL`.
 * Self-contained so this `sandbox: true` preload requires zero Node filesystem modules.
 *
 * @param {unknown} urlStr
 * @param {readonly string[]} allowedHosts
 * @returns {boolean}
 */
function isAllowedHttpsHost(urlStr, allowedHosts) {
  if (typeof urlStr !== 'string' || !urlStr.trim() || /[\x00-\x1f\x7f]/.test(urlStr)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    return false;
  }
  const host = String(parsed.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return false;
  for (const rawAllowed of allowedHosts) {
    const allowed = String(rawAllowed || '')
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/\.$/, '');
    if (allowed && (host === allowed || host.endsWith(`.${allowed}`))) {
      return true;
    }
  }
  return false;
}

function installPasskeyCancellationHelper() {
  const g = /** @type {any} */ (globalThis);
  const credentials = g.navigator && g.navigator.credentials;
  if (!credentials || typeof credentials.get !== 'function') return;
  const originalGet = credentials.get;
  /** @type {Set<AbortController>} */
  const activeControllers = new Set();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let eligible = false;
  /** @type {any} */
  let panel;

  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    eligible = false;
    if (panel) panel.remove();
    panel = undefined;
  };

  const show = () => {
    const doc = g.document;
    if (!activeControllers.size || panel || !doc || !doc.body) return;
    panel = doc.createElement('div');
    panel.setAttribute('data-one-launcher-passkey-control', '');
    panel.style.cssText =
      'all:initial;display:block;position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-width:560px;margin:0 auto;color-scheme:dark';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#f4f5f6}
      .panel{box-sizing:border-box;display:flex;align-items:center;gap:16px;padding:14px 16px;font:13px system-ui,-apple-system,sans-serif;color:#f4f5f6;background:#1e2228;border:1px solid #3d4450;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,0.45)}
      .copy{flex:1;min-width:0}
      .brand{font-size:10px;font-weight:700;letter-spacing:.8px;color:#52b043;margin-bottom:4px}
      h2{font-size:13.5px;line-height:1.35;margin:0 0 4px;font-weight:600}
      p{font-size:12px;line-height:1.45;color:#bdc3cb;margin:0}
      button{flex:none;font:600 12.5px system-ui,-apple-system,sans-serif;color:#f4f5f6;background:#2f3640;border:1px solid #596270;border-radius:6px;padding:9px 12px;cursor:pointer}
      button:hover{background:#3d4652}
      @media(max-width:460px){.panel{align-items:stretch;flex-direction:column;gap:10px}button{width:100%}}
    </style><section class="panel" role="region" aria-label="One Launcher sign-in helper">
      <div class="copy">
        <div class="brand">ONE LAUNCHER</div>
        <h2>Passkey prompt taking too long?</h2>
        <p>Cancel the passkey request to choose <strong>Other ways to sign in</strong> (password, email code, or Microsoft Authenticator).</p>
      </div>
      <button type="button" data-cancel>Cancel passkey</button>
    </section>`;
    const btn = shadow.querySelector('[data-cancel]');
    if (btn) {
      btn.addEventListener('click', () => {
        for (const ctrl of activeControllers) ctrl.abort();
        hide();
      });
    }
    doc.body.appendChild(panel);
  };

  Object.defineProperty(credentials, 'get', {
    configurable: true,
    writable: true,
    value: function (/** @type {any} */ options) {
      if (!options || !options.publicKey) {
        return Reflect.apply(originalGet, this, [options]);
      }
      const prior = options.signal;
      if (
        prior &&
        (typeof prior.addEventListener !== 'function' ||
          typeof prior.removeEventListener !== 'function')
      ) {
        return Reflect.apply(originalGet, this, [options]);
      }
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(prior ? prior.reason : undefined);
      if (prior && prior.aborted) forwardAbort();
      else if (prior) prior.addEventListener('abort', forwardAbort, { once: true });
      activeControllers.add(controller);
      if (!timer) {
        timer = setTimeout(() => {
          eligible = true;
          show();
        }, 4000);
      }
      const finish = () => {
        if (prior) prior.removeEventListener('abort', forwardAbort);
        activeControllers.delete(controller);
        if (!activeControllers.size) hide();
      };
      try {
        const req = Object.create(options, {
          signal: { value: controller.signal, enumerable: true },
        });
        return Promise.resolve(Reflect.apply(originalGet, this, [req])).then(
          (val) => {
            finish();
            return val;
          },
          (err) => {
            finish();
            throw err;
          }
        );
      } catch (err) {
        finish();
        throw err;
      }
    },
  });

  if (g.document && typeof g.document.addEventListener === 'function') {
    g.document.addEventListener(
      'DOMContentLoaded',
      () => {
        if (eligible) show();
      },
      { once: true }
    );
  }
  if (g.window && typeof g.window.addEventListener === 'function') {
    g.window.addEventListener('pagehide', hide, { once: true });
  }
}

const gTop = /** @type {any} */ (globalThis);
const winObj = gTop.window;
const locObj = gTop.location;
const candidateHref =
  locObj && typeof locObj.href === 'string' && locObj.href
    ? locObj.href
    : locObj && locObj.protocol && locObj.hostname
      ? `${locObj.protocol}//${locObj.host || locObj.hostname}${locObj.pathname || '/'}`
      : '';

if (
  winObj &&
  winObj === winObj.top &&
  locObj &&
  !locObj.port &&
  isAllowedHttpsHost(candidateHref, TRUSTED_HOSTS)
) {
  contextBridge.exposeInMainWorld('__oneLauncherXboxAuth', {
    notify: (/** @type {unknown} */ payload) => {
      if (typeof payload === 'string' && payload.length <= 65536) {
        ipcRenderer.send('one-launcher:xbox-cxh-notify', payload);
      }
    },
  });

  void webFrame.executeJavaScript(`
    try {
      if (!globalThis.external) {
        globalThis.external = {};
      }
      Object.defineProperty(globalThis.external, 'notify', {
        value: (payload) => globalThis.__oneLauncherXboxAuth.notify(payload),
        configurable: false,
        writable: false
      });
    } catch {}
    (${installPasskeyCancellationHelper.toString()})();
  `);
}
