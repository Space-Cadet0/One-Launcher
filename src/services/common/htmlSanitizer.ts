import DOMPurify from 'dompurify';
import { isAllowedOlMediaUrl, parseSafeHttpUrl } from './storeUrlUtils';

/**
 * Strict URI allowlist for untrusted storefront HTML (`https://` and validated
 * `ol-media://asset`, `ol-media://covers`, `ol-media://vault` only).
 * Blocks `file:`, `javascript:`, `data:`, `vbscript:`, arbitrary `ol-media://` authorities,
 * and unencrypted `http:` schemes.
 */
export const ALLOWED_STORE_URI_REGEXP =
  /^(?:https:\/\/|ol-media:\/\/(?:asset(?:\?|\/)|(?:covers|vault)\/))/i;
export const SAFE_STORE_URI_REGEXP = ALLOWED_STORE_URI_REGEXP;

/**
 * Internal URI pattern passed to DOMPurify so protocol-relative `//cdn.host/path`
 * attributes can reach `beforeSanitizeAttributes` / `afterSanitizeAttributes` hooks and be
 * upgraded to `https://` cleanly without regex-rewriting text inside `<code>` / `<pre>`.
 */
const DOMPURIFY_ALLOWED_URI_REGEXP =
  /^(?:https:\/\/|ol-media:\/\/(?:asset(?:\?|\/)|(?:covers|vault)\/)|\/\/[^/])/i;

/**
 * Strict class token allowlist blocking Tailwind UI-redressing utility classes
 * (`fixed`, `absolute`, `inset-*`, `z-*`, `bg-*`, etc.) while preserving legitimate
 * Steam/BBCode structural classes (`bb_*`, `steam_*`, `lead`).
 */
export const ALLOWED_STORE_CLASS_TOKEN_REGEXP = /^(?:bb_[a-z0-9_-]+|steam_[a-z0-9_-]+|lead)$/;

/**
 * Canonical allowlist of safe structural & media HTML element names for storefront descriptions
 * and system requirements.
 *
 * Intentionally omits `<main>`, `<header>`, and `<footer>` so untrusted storefront HTML can never
 * inject competing page-level landmarks, while unifying safe structural elements (`<details>`,
 * `<summary>`, `<kbd>`, `<del>`, `<s>`, `<figure>`, `<figcaption>`).
 */
export const ALLOWED_STORE_ELEMENT_NAMES: readonly string[] = [
  'a',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
];

const ALLOWED_DOMPURIFY_TAGS: string[] = [...ALLOWED_STORE_ELEMENT_NAMES, '#text'];

export const ALLOWED_STORE_ATTR: readonly string[] = [
  'alt',
  'autoplay',
  'class',
  'colspan',
  'controls',
  'datetime',
  'decoding',
  'height',
  'href',
  'loading',
  'loop',
  'media',
  'muted',
  'open',
  'playsinline',
  'poster',
  'preload',
  'rel',
  'rowspan',
  'src',
  'srcset',
  'target',
  'title',
  'type',
  'width',
];

const ALLOWED_STORE_ELEMENT_SET = new Set<string>(ALLOWED_STORE_ELEMENT_NAMES);
const ALLOWED_STORE_ATTR_SET = new Set<string>(ALLOWED_STORE_ATTR);

interface NativeSanitizerConfig {
  elements: readonly string[];
  attributes: readonly string[];
}

interface SanitizerCapableElement extends Element {
  setHTML(input: string, options?: { sanitizer?: NativeSanitizerConfig }): void;
}

interface SanitizerCapableDocumentConstructor {
  parseHTML(input: string, options?: { sanitizer?: NativeSanitizerConfig }): Document;
}

type DomPurifyHookName = 'beforeSanitizeAttributes' | 'afterSanitizeAttributes';

interface DomPurifyLike {
  sanitize: (
    dirty: string,
    cfg: {
      ALLOWED_TAGS: string[];
      ALLOWED_ATTR: string[];
      ALLOWED_URI_REGEXP: RegExp;
      ALLOW_ARIA_ATTR: boolean;
      ALLOW_DATA_ATTR: boolean;
      KEEP_CONTENT: boolean;
      RETURN_DOM_FRAGMENT?: boolean;
    }
  ) => string | DocumentFragment;
  addHook?: (hookName: DomPurifyHookName, cb: (node: Element) => void) => void;
  isSupported?: boolean;
}

type DomPurifyFactory = (root?: Window) => DomPurifyLike;

let cachedPurifier: DomPurifyLike | null = null;
let cachedPurifierWindow: Window | null = null;
const hookedPurifierTargets = new WeakSet<object>();

/**
 * Upgrades protocol-relative `//cdn.host/path` references (used by Steam store HTML)
 * to `https://cdn.host/path` while leaving all other URI values untouched for
 * strict scheme validation.
 */
export function upgradeProtocolRelativeUrl(raw?: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

/**
 * Filters a raw HTML `class` attribute value down to strictly allowlisted
 * storefront/BBCode tokens (`bb_*`, `steam_*`, `lead`), blocking Tailwind
 * positioning/overlay UI-redressing classes.
 */
export function sanitizeStoreClassValue(rawClass?: string | null): string {
  if (!rawClass || typeof rawClass !== 'string') return '';
  const allowedTokens = rawClass
    .trim()
    .split(/\s+/)
    .filter((token) => ALLOWED_STORE_CLASS_TOKEN_REGEXP.test(token));
  return allowedTokens.join(' ');
}

/**
 * Validates an attribute URI after upgrading protocol-relative `//...` references:
 * - Must match `https://` (valid host via `new URL()`) or validated `ol-media://asset` / `ol-media://covers`
 * - Rejects traversal (`..`, `%2e%2e`), arbitrary `ol-media://` authorities, `http:`, `javascript:`, `data:`, `file:`
 */
export function sanitizeAllowedStoreUri(raw?: string | null): string {
  const upgraded = upgradeProtocolRelativeUrl(raw);
  if (!upgraded || !ALLOWED_STORE_URI_REGEXP.test(upgraded)) {
    return '';
  }

  if (/^https:\/\//i.test(upgraded)) {
    return parseSafeHttpUrl(upgraded, { allowHttp: false }) ? upgraded : '';
  }

  if (/^ol-media:\/\//i.test(upgraded)) {
    return isAllowedOlMediaUrl(upgraded) ? upgraded : '';
  }

  return '';
}

export function sanitizeSrcsetValue(rawSrcset?: string | null): string {
  if (!rawSrcset) return '';
  return rawSrcset
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const safeUrl = sanitizeAllowedStoreUri(parts[0]);
      if (!safeUrl) return '';
      return parts.length > 1 ? `${safeUrl} ${parts.slice(1).join(' ')}` : safeUrl;
    })
    .filter(Boolean)
    .join(', ');
}

function upgradeProtocolRelativeElementAttributes(el: Element): void {
  if (!el || typeof el.hasAttribute !== 'function') return;

  for (const attr of ['href', 'src', 'poster']) {
    if (el.hasAttribute(attr)) {
      const raw = el.getAttribute(attr);
      if (raw && raw.trim().startsWith('//')) {
        const upgraded = upgradeProtocolRelativeUrl(raw);
        el.setAttribute(attr, upgraded);
      }
    }
  }

  if (el.hasAttribute('srcset')) {
    const rawSrcset = el.getAttribute('srcset');
    if (rawSrcset && rawSrcset.includes('//')) {
      const cleaned = sanitizeSrcsetValue(rawSrcset);
      if (cleaned) {
        el.setAttribute('srcset', cleaned);
      } else {
        el.removeAttribute('srcset');
      }
    }
  }
}

function applyElementSecurityRules(el: Element): void {
  if (!el || typeof el.hasAttribute !== 'function') return;

  for (const attr of ['href', 'src', 'poster']) {
    if (el.hasAttribute(attr)) {
      const safeUri = sanitizeAllowedStoreUri(el.getAttribute(attr));
      if (!safeUri) {
        el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, safeUri);
      }
    }
  }

  if (el.hasAttribute('srcset')) {
    const cleanedSrcset = sanitizeSrcsetValue(el.getAttribute('srcset'));
    if (cleanedSrcset) {
      el.setAttribute('srcset', cleanedSrcset);
    } else {
      el.removeAttribute('srcset');
    }
  }

  if (el.hasAttribute('class')) {
    const safeClass = sanitizeStoreClassValue(el.getAttribute('class'));
    if (safeClass) {
      el.setAttribute('class', safeClass);
    } else {
      el.removeAttribute('class');
    }
  }

  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'a') {
    el.setAttribute('rel', 'noopener noreferrer');
    if (el.hasAttribute('href')) {
      el.setAttribute('target', '_blank');
    } else {
      el.removeAttribute('target');
    }
  }
}

/**
 * Post-sanitization walk on a `DocumentFragment` or `Element` subtree enforcing:
 * - Only validated `https://` and `ol-media://(?:asset|covers)` URIs survive on `href`, `src`, `poster`, and `srcset`
 * - `class` tokens are restricted strictly to `ALLOWED_STORE_CLASS_TOKEN_REGEXP`
 * - Every `<a>` anchor carries `rel="noopener noreferrer"` and `target="_blank"` (when `href` exists)
 */
export function enforceFragmentSecurityPolicy(root: DocumentFragment | Element): void {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    applyElementSecurityRules(el);
  }
}

function hasNativeParseHtml(
  docCtor: unknown
): docCtor is SanitizerCapableDocumentConstructor {
  return (
    typeof docCtor === 'function' &&
    'parseHTML' in docCtor &&
    typeof (docCtor as Partial<SanitizerCapableDocumentConstructor>).parseHTML === 'function'
  );
}

function hasNativeElementSetHtml(): boolean {
  return (
    typeof Element !== 'undefined' &&
    'setHTML' in Element.prototype &&
    typeof (Element.prototype as Partial<SanitizerCapableElement>).setHTML === 'function'
  );
}

function isSanitizerCapableElement(el: Element): el is SanitizerCapableElement {
  return (
    'setHTML' in el &&
    typeof (el as Partial<SanitizerCapableElement>).setHTML === 'function'
  );
}

function isDomPurifyLike(value: unknown): value is DomPurifyLike {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const candidate = value as Partial<DomPurifyLike>;
  return typeof candidate.sanitize === 'function' && candidate.isSupported !== false;
}

function isDomPurifyFactory(value: unknown): value is DomPurifyFactory {
  return typeof value === 'function';
}

function installPurifierHooksOnce(
  underlyingTarget: object,
  addHook?: DomPurifyLike['addHook']
): void {
  if (hookedPurifierTargets.has(underlyingTarget) || typeof addHook !== 'function') {
    return;
  }
  hookedPurifierTargets.add(underlyingTarget);
  addHook('beforeSanitizeAttributes', (node: Element) => {
    upgradeProtocolRelativeElementAttributes(node);
  });
  addHook('afterSanitizeAttributes', (node: Element) => {
    applyElementSecurityRules(node);
  });
}

function resolvePurifierFromCandidate(
  rawCandidate: unknown,
  currentWindow: Window | null
): DomPurifyLike | null {
  let candidate: unknown = rawCandidate;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'default' in candidate &&
    !isDomPurifyLike(candidate)
  ) {
    candidate = (candidate as { default?: unknown }).default;
  }

  if (isDomPurifyLike(candidate)) {
    const boundAddHook =
      typeof candidate.addHook === 'function' ? candidate.addHook.bind(candidate) : undefined;
    // Key hook deduplication strictly on the underlying DOMPurify instance, never on a wrapper object
    installPurifierHooksOnce(candidate, boundAddHook);
    const resolved: DomPurifyLike = {
      sanitize: candidate.sanitize.bind(candidate),
      addHook: boundAddHook,
      isSupported: candidate.isSupported,
    };
    cachedPurifier = resolved;
    cachedPurifierWindow = currentWindow;
    return resolved;
  }

  if (isDomPurifyFactory(candidate) && currentWindow) {
    try {
      const created = candidate(currentWindow);
      if (isDomPurifyLike(created)) {
        const boundAddHook =
          typeof created.addHook === 'function' ? created.addHook.bind(created) : undefined;
        installPurifierHooksOnce(created, boundAddHook);
        const resolved: DomPurifyLike = {
          sanitize: created.sanitize.bind(created),
          addHook: boundAddHook,
          isSupported: created.isSupported,
        };
        cachedPurifier = resolved;
        cachedPurifierWindow = currentWindow;
        return resolved;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function getReadyPurifier(): DomPurifyLike | null {
  const currentWindow = typeof window !== 'undefined' ? window : null;
  if (cachedPurifier && cachedPurifierWindow === currentWindow) {
    return cachedPurifier;
  }
  const rawModule: unknown = DOMPurify;
  return resolvePurifierFromCandidate(rawModule, currentWindow);
}

/**
 * Resolves the `DOMPurify` fallback synchronously on engines that lack the native Sanitizer API
 * (`Document.parseHTML` / inert `Element.prototype.setHTML`), guaranteeing initial synchronous renders
 * (`AboutThisGame` mount & `SystemRequirements` `useMemo`) never miss sanitization.
 */
export function ensureDomPurifyFallbackLoaded(): Promise<DomPurifyLike | null> {
  if (typeof Document !== 'undefined' && hasNativeParseHtml(Document)) {
    return Promise.resolve(null);
  }
  if (
    hasNativeElementSetHtml() &&
    typeof document !== 'undefined' &&
    typeof document.implementation?.createHTMLDocument === 'function'
  ) {
    return Promise.resolve(null);
  }
  return Promise.resolve(getReadyPurifier());
}

/**
 * Strict allowlist tree scrubber matching native `Sanitizer` semantics:
 * - Disallowed elements are removed **together with their content** (`KEEP_CONTENT: false`)
 * - All non-allowlisted attributes (including `on*`, `style`, `aria-*`, `data-*`) are stripped
 */
function scrubDomSubtree(root: ParentNode): void {
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === 3) {
      continue;
    }
    if (child.nodeType !== 1) {
      child.parentNode?.removeChild(child);
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_STORE_ELEMENT_SET.has(tag)) {
      el.parentNode?.removeChild(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.name.toLowerCase();
      if (!ALLOWED_STORE_ATTR_SET.has(attrName)) {
        el.removeAttribute(attr.name);
      }
    }
    applyElementSecurityRules(el);
    scrubDomSubtree(el);
  }
}

function createInertHtmlDocument(): Document | null {
  if (
    typeof document !== 'undefined' &&
    document.implementation &&
    typeof document.implementation.createHTMLDocument === 'function'
  ) {
    try {
      return document.implementation.createHTMLDocument('');
    } catch {
      return null;
    }
  }
  return null;
}

function parseSanitizedFragmentNativeOrFallback(rawHtml: string): DocumentFragment | null {
  if (typeof document === 'undefined' || typeof document.createDocumentFragment !== 'function') {
    return null;
  }

  // 1. Native Sanitizer API fast path: Document.parseHTML() parses into an INERT document
  //    (zero speculative HTTP media fetches). Enforce policy BEFORE moving into live fragment.
  if (typeof Document !== 'undefined' && hasNativeParseHtml(Document)) {
    try {
      const doc = Document.parseHTML(rawHtml, {
        sanitizer: {
          elements: ALLOWED_STORE_ELEMENT_NAMES,
          attributes: ALLOWED_STORE_ATTR,
        },
      });
      enforceFragmentSecurityPolicy(doc.body);
      const fragment = document.createDocumentFragment();
      while (doc.body.firstChild) {
        fragment.appendChild(doc.body.firstChild);
      }
      return fragment;
    } catch {
      // Fall through if custom config rejected by partial implementation
    }
  }

  // 2. Native Sanitizer API Element.prototype.setHTML() strictly inside an INERT HTMLDocument
  //    so untrusted `http:` images/media can NEVER trigger speculative live-document requests.
  if (hasNativeElementSetHtml()) {
    const inertDoc = createInertHtmlDocument();
    if (inertDoc && typeof inertDoc.createElement === 'function') {
      try {
        const host = inertDoc.createElement('div');
        if (isSanitizerCapableElement(host)) {
          host.setHTML(rawHtml, {
            sanitizer: {
              elements: ALLOWED_STORE_ELEMENT_NAMES,
              attributes: ALLOWED_STORE_ATTR,
            },
          });
          enforceFragmentSecurityPolicy(host);
          const fragment = document.createDocumentFragment();
          while (host.firstChild) {
            fragment.appendChild(host.firstChild);
          }
          return fragment;
        }
      } catch {
        // Fall through
      }
    }
  }

  // 3. DOMPurify fallback (parses inside an inert document/template, with single-registered hooks)
  const purifier = getReadyPurifier();
  if (purifier) {
    const res = purifier.sanitize(rawHtml, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ALLOWED_DOMPURIFY_TAGS,
      ALLOWED_ATTR: [...ALLOWED_STORE_ATTR],
      ALLOWED_URI_REGEXP: DOMPURIFY_ALLOWED_URI_REGEXP,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: false,
    });
    if (res && typeof res !== 'string' && typeof res.querySelectorAll === 'function') {
      enforceFragmentSecurityPolicy(res);
      return res;
    }
  }

  // 4. Synchronous inert DOMParser + strict allowlist scrubber
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');
      if (doc?.body) {
        // Scrub and enforce full security policy inside inert <body> BEFORE moving into live fragment
        scrubDomSubtree(doc.body);
        enforceFragmentSecurityPolicy(doc.body);
        const fragment = document.createDocumentFragment();
        while (doc.body.firstChild) {
          fragment.appendChild(doc.body.firstChild);
        }
        return fragment;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Escapes untrusted plain text for safe interpolation into HTML templates.
 */
export function escapeHtml(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitizes untrusted HTML into a detached `DocumentFragment` without re-serializing
 * to `innerHTML` (preventing mXSS), enforcing `KEEP_CONTENT: false`, `ALLOW_ARIA_ATTR: false`,
 * `ALLOW_DATA_ATTR: false`, protocol-relative `//` -> `https://` upgrades on element attributes only
 * (preserving `//` inside `<code>`/`<pre>`), allowlisted `class` tokens, strict `ol-media://`
 * authority validation, and `rel="noopener noreferrer"` on anchors.
 */
export function sanitizeSafeDomFragment(
  rawHtml: string | undefined | null
): DocumentFragment | null {
  if (!rawHtml) {
    if (typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function') {
      return document.createDocumentFragment();
    }
    return null;
  }
  return parseSanitizedFragmentNativeOrFallback(rawHtml);
}

/**
 * Sanitizes untrusted storefront HTML strings with strict URI scheme allowlisting
 * (`https://` and validated `ol-media://asset` / `ol-media://covers` only, upgrading
 * protocol-relative `//...` attributes to `https://`), `ALLOW_ARIA_ATTR: false`,
 * `ALLOW_DATA_ATTR: false`, `KEEP_CONTENT: false`, allowlisted `class` tokens, and
 * mandatory `rel="noopener noreferrer"` on anchors.
 */
export function sanitizeStoreHtml(html: string | undefined | null): string {
  if (!html) return '';
  const fragment = sanitizeSafeDomFragment(html);
  if (fragment) {
    const inertDoc = createInertHtmlDocument();
    if (inertDoc && typeof inertDoc.createElement === 'function') {
      const container = inertDoc.createElement('div');
      container.appendChild(fragment);
      return container.innerHTML;
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const container = document.createElement('div');
      container.appendChild(fragment);
      return container.innerHTML;
    }
  }
  return escapeHtml(html);
}
