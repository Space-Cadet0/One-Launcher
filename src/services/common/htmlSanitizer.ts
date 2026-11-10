import DOMPurify from 'dompurify';

/**
 * Strict URI allowlist for untrusted storefront HTML (`https:` and `ol-media:` only).
 * Blocks `file:`, `javascript:`, `data:`, `vbscript:`, and unencrypted `http:` schemes.
 */
export const ALLOWED_STORE_URI_REGEXP = /^(?:https:|ol-media:)/i;
export const SAFE_STORE_URI_REGEXP = ALLOWED_STORE_URI_REGEXP;

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
  addHook?: (hookName: 'afterSanitizeAttributes', cb: (node: Element) => void) => void;
  isSupported?: boolean;
}

type DomPurifyFactory = (root?: Window) => DomPurifyLike;

type DomPurifyImportedModule = {
  default?: DomPurifyFactory | DomPurifyLike;
  sanitize?: DomPurifyLike['sanitize'];
  addHook?: DomPurifyLike['addHook'];
  isSupported?: boolean;
};

let cachedPurifier: DomPurifyLike | null = null;
let cachedPurifierWindow: Window | null = null;
const hookedPurifiers = new WeakSet<object>();

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
 * Validates an attribute URI after upgrading protocol-relative `//...` references:
 * - Must match `https:` or `ol-media:`
 * - Must parse cleanly via `new URL()` with a non-empty host (for `https:`)
 */
export function sanitizeAllowedStoreUri(raw?: string | null): string {
  const upgraded = upgradeProtocolRelativeUrl(raw);
  if (!upgraded || !ALLOWED_STORE_URI_REGEXP.test(upgraded)) {
    return '';
  }
  try {
    const parsed = new URL(upgraded);
    if (parsed.protocol === 'https:') {
      return parsed.hostname ? upgraded : '';
    }
    if (parsed.protocol === 'ol-media:') {
      return upgraded;
    }
    return '';
  } catch {
    return '';
  }
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

function preNormalizeProtocolRelativeHtml(rawHtml: string): string {
  return rawHtml
    .replace(
      /\b(src|href|poster)\s*=\s*(["'])\s*\/\/(?!\/)/gi,
      (_match, attrName: string, quote: string) => `${attrName}=${quote}https://`
    )
    .replace(/\bsrcset\s*=\s*(["'])([^"']*)\1/gi, (_match, quote: string, val: string) => {
      const upgraded = val
        .split(',')
        .map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return '';
          const tokens = trimmed.split(/\s+/);
          const first = upgradeProtocolRelativeUrl(tokens[0]);
          return tokens.length > 1 ? `${first} ${tokens.slice(1).join(' ')}` : first;
        })
        .filter(Boolean)
        .join(', ');
      return `srcset=${quote}${upgraded}${quote}`;
    });
}

function applyElementSecurityRules(el: Element): void {
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
 * - Only validated `https:` and `ol-media:` URIs survive on `href`, `src`, `poster`, and `srcset`
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

function bindPurifierFromModule(mod: DomPurifyImportedModule): DomPurifyLike | null {
  const currentWindow = typeof window !== 'undefined' ? window : null;
  if (mod && mod.isSupported !== false && typeof mod.sanitize === 'function') {
    const direct: DomPurifyLike = {
      sanitize: mod.sanitize.bind(mod),
      addHook: typeof mod.addHook === 'function' ? mod.addHook.bind(mod) : undefined,
      isSupported: mod.isSupported,
    };
    installPurifierHook(direct);
    cachedPurifier = direct;
    cachedPurifierWindow = currentWindow;
    return direct;
  }

  const candidate = mod?.default ?? mod;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'sanitize' in candidate &&
    typeof candidate.sanitize === 'function' &&
    candidate.isSupported !== false
  ) {
    const resolved: DomPurifyLike = {
      sanitize: candidate.sanitize.bind(candidate),
      addHook: typeof candidate.addHook === 'function' ? candidate.addHook.bind(candidate) : undefined,
      isSupported: candidate.isSupported,
    };
    installPurifierHook(resolved);
    cachedPurifier = resolved;
    cachedPurifierWindow = currentWindow;
    return resolved;
  }

  if (typeof candidate === 'function' && currentWindow) {
    try {
      const created = candidate(currentWindow);
      if (created && created.isSupported !== false && typeof created.sanitize === 'function') {
        installPurifierHook(created);
        cachedPurifier = created;
        cachedPurifierWindow = currentWindow;
        return created;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function installPurifierHook(purifier: DomPurifyLike): void {
  if (hookedPurifiers.has(purifier) || typeof purifier.addHook !== 'function') {
    return;
  }
  hookedPurifiers.add(purifier);
  purifier.addHook('afterSanitizeAttributes', (node: Element) => {
    applyElementSecurityRules(node);
  });
}

/**
 * Resolves the `DOMPurify` fallback synchronously on engines that lack the native Sanitizer API
 * (`Document.parseHTML` / `Element.prototype.setHTML`), guaranteeing initial synchronous renders
 * (`AboutThisGame` mount & `SystemRequirements` `useMemo`) never miss sanitization.
 */
export function ensureDomPurifyFallbackLoaded(): Promise<DomPurifyLike | null> {
  if ((typeof Document !== 'undefined' && hasNativeParseHtml(Document)) || hasNativeElementSetHtml()) {
    return Promise.resolve(null);
  }
  return Promise.resolve(getReadyPurifier());
}

function getReadyPurifier(): DomPurifyLike | null {
  const currentWindow = typeof window !== 'undefined' ? window : null;
  if (cachedPurifier && cachedPurifierWindow === currentWindow) {
    return cachedPurifier;
  }
  return bindPurifierFromModule({ default: DOMPurify as unknown as DomPurifyFactory | DomPurifyLike });
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

function parseSanitizedFragmentNativeOrFallback(normalizedHtml: string): DocumentFragment | null {
  if (typeof document === 'undefined' || typeof document.createDocumentFragment !== 'function') {
    return null;
  }

  // 1. Native Sanitizer API fast path: Document.parseHTML()
  if (typeof Document !== 'undefined' && hasNativeParseHtml(Document)) {
    try {
      const doc = Document.parseHTML(normalizedHtml, {
        sanitizer: {
          elements: ALLOWED_STORE_ELEMENT_NAMES,
          attributes: ALLOWED_STORE_ATTR,
        },
      });
      const fragment = document.createDocumentFragment();
      while (doc.body.firstChild) {
        fragment.appendChild(doc.body.firstChild);
      }
      enforceFragmentSecurityPolicy(fragment);
      return fragment;
    } catch {
      // Fall through if custom config rejected by partial implementation
    }
  }

  // 2. Native Sanitizer API fast path: Element.prototype.setHTML()
  if (hasNativeElementSetHtml() && typeof document.createElement === 'function') {
    try {
      const host = document.createElement('div');
      if (isSanitizerCapableElement(host)) {
        host.setHTML(normalizedHtml, {
          sanitizer: {
            elements: ALLOWED_STORE_ELEMENT_NAMES,
            attributes: ALLOWED_STORE_ATTR,
          },
        });
        const fragment = document.createDocumentFragment();
        while (host.firstChild) {
          fragment.appendChild(host.firstChild);
        }
        enforceFragmentSecurityPolicy(fragment);
        return fragment;
      }
    } catch {
      // Fall through
    }
  }

  // 3. Loaded DOMPurify fallback with native-equivalent flags (`KEEP_CONTENT: false`)
  const purifier = getReadyPurifier();
  if (purifier) {
    const res = purifier.sanitize(normalizedHtml, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ALLOWED_DOMPURIFY_TAGS,
      ALLOWED_ATTR: [...ALLOWED_STORE_ATTR],
      ALLOWED_URI_REGEXP: ALLOWED_STORE_URI_REGEXP,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: false,
    });
    if (res && typeof res !== 'string' && typeof res.querySelectorAll === 'function') {
      enforceFragmentSecurityPolicy(res);
      return res;
    }
  }

  // 4. Synchronous inert DOMParser + strict allowlist scrubber while lazy DOMPurify chunk resolves
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(normalizedHtml, 'text/html');
      if (doc?.body) {
        // Remove <head> script/style/meta payloads completely; only scrub inert <body>
        scrubDomSubtree(doc.body);
        const fragment = document.createDocumentFragment();
        while (doc.body.firstChild) {
          fragment.appendChild(doc.body.firstChild);
        }
        enforceFragmentSecurityPolicy(fragment);
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
 * `ALLOW_DATA_ATTR: false`, protocol-relative `//` -> `https://` upgrades with `new URL()`
 * validation, and `rel="noopener noreferrer"` on anchors.
 */
export function sanitizeSafeDomFragment(rawHtml: string | undefined | null): DocumentFragment | null {
  if (!rawHtml) {
    if (typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function') {
      return document.createDocumentFragment();
    }
    return null;
  }
  const normalizedInput = preNormalizeProtocolRelativeHtml(rawHtml);
  return parseSanitizedFragmentNativeOrFallback(normalizedInput);
}

/**
 * Asynchronously inserts untrusted HTML directly into a target `Element` using native
 * `Element.prototype.setHTML()` when supported or lazy-loaded `DOMPurify` + `DocumentFragment`
 * insertion otherwise.
 */
export async function safeSetStoreHtml(
  element: Element,
  rawHtml: string | undefined | null
): Promise<void> {
  if (!rawHtml) {
    element.replaceChildren();
    return;
  }
  const normalizedInput = preNormalizeProtocolRelativeHtml(rawHtml);
  if (isSanitizerCapableElement(element)) {
    element.setHTML(normalizedInput, {
      sanitizer: {
        elements: ALLOWED_STORE_ELEMENT_NAMES,
        attributes: ALLOWED_STORE_ATTR,
      },
    });
    enforceFragmentSecurityPolicy(element);
    return;
  }

  await ensureDomPurifyFallbackLoaded();
  const fragment = parseSanitizedFragmentNativeOrFallback(normalizedInput);
  if (fragment) {
    element.replaceChildren(fragment);
  } else {
    element.textContent = rawHtml;
  }
}

/**
 * Sanitizes untrusted storefront HTML strings with strict URI scheme allowlisting
 * (`https:` and `ol-media:` only, upgrading protocol-relative `//...` URLs to `https://`),
 * `ALLOW_ARIA_ATTR: false`, `ALLOW_DATA_ATTR: false`, `KEEP_CONTENT: false`, and
 * mandatory `rel="noopener noreferrer"` on anchors.
 */
export function sanitizeStoreHtml(html: string | undefined | null): string {
  if (!html) return '';
  const fragment = sanitizeSafeDomFragment(html);
  if (fragment && typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const container = document.createElement('div');
    container.appendChild(fragment);
    return container.innerHTML;
  }
  return escapeHtml(html);
}
