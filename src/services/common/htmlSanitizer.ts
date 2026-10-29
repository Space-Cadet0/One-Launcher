import createDOMPurify from 'dompurify';

export const ALLOWED_STORE_URI_REGEXP = /^(?:https:|ol-media:)/i;

const ALLOWED_STORE_TAGS = [
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
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'kbd',
  'li',
  'main',
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
  '#text',
];

const ALLOWED_STORE_ATTR = [
  'alt',
  'autoplay',
  'class',
  'colspan',
  'controls',
  'datetime',
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

const ALLOWED_STORE_TAG_SET = new Set(ALLOWED_STORE_TAGS);
const ALLOWED_STORE_ATTR_SET = new Set(ALLOWED_STORE_ATTR);

type PurifierInstance = ReturnType<typeof createDOMPurify>;

type DomPurifyFactory = (root?: Window) => PurifierInstance;

type DomPurifyModuleShape =
  | (DomPurifyFactory & {
      sanitize?: PurifierInstance['sanitize'];
      addHook?: PurifierInstance['addHook'];
      isSupported?: boolean;
    })
  | {
      default?: DomPurifyFactory;
      sanitize?: PurifierInstance['sanitize'];
      addHook?: PurifierInstance['addHook'];
      isSupported?: boolean;
    };

let purifierInstance: PurifierInstance | null = null;
let purifierWindowRef: Window | null = null;
const hookedPurifiers = new WeakSet<object>();

function applyElementSecurityRules(node: Element): void {
  const tag = node.tagName ? node.tagName.toLowerCase() : '';
  for (const uriAttr of ['href', 'src', 'poster']) {
    if (node.hasAttribute(uriAttr)) {
      const val = (node.getAttribute(uriAttr) || '').trim();
      if (!ALLOWED_STORE_URI_REGEXP.test(val)) {
        node.removeAttribute(uriAttr);
      }
    }
  }
  if (node.hasAttribute('srcset')) {
    const rawSrcSet = node.getAttribute('srcset') || '';
    const validEntries = rawSrcSet
      .split(',')
      .map((part) => part.trim())
      .filter((part) => {
        const urlPart = part.split(/\s+/)[0] || '';
        return ALLOWED_STORE_URI_REGEXP.test(urlPart);
      });
    if (validEntries.length > 0) {
      node.setAttribute('srcset', validEntries.join(', '));
    } else {
      node.removeAttribute('srcset');
    }
  }
  if (tag === 'a') {
    node.setAttribute('rel', 'noopener noreferrer');
    if (node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
    } else {
      node.removeAttribute('target');
    }
  }
}

function installAnchorSecurityHook(purifier: PurifierInstance): void {
  if (hookedPurifiers.has(purifier) || typeof purifier.addHook !== 'function') {
    return;
  }
  hookedPurifiers.add(purifier);
  purifier.addHook('afterSanitizeAttributes', (node: Element) => {
    applyElementSecurityRules(node);
  });
}

function getPurifier(): PurifierInstance | null {
  const currentWindow = typeof window !== 'undefined' ? window : null;
  if (purifierInstance && purifierWindowRef === currentWindow) {
    return purifierInstance;
  }

  const mod = createDOMPurify as unknown as DomPurifyModuleShape;
  const factory = typeof mod === 'function' ? mod : mod?.default;

  if (
    mod &&
    mod.isSupported !== false &&
    typeof mod.sanitize === 'function'
  ) {
    const prebound = mod as unknown as PurifierInstance;
    installAnchorSecurityHook(prebound);
    purifierInstance = prebound;
    purifierWindowRef = currentWindow;
    return prebound;
  }

  if (typeof factory === 'function' && currentWindow) {
    try {
      const created = factory(currentWindow);
      if (
        created &&
        (created as { isSupported?: boolean }).isSupported !== false &&
        typeof created.sanitize === 'function'
      ) {
        installAnchorSecurityHook(created);
        purifierInstance = created;
        purifierWindowRef = currentWindow;
        return created;
      }
    } catch {
      // Fall through to DOMParser / plain-text escape fallback when synthetic test windows lack full DOM APIs.
    }
  }

  return null;
}

function scrubDomSubtree(root: ParentNode): void {
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === 3) {
      // Text node (#text)
      continue;
    }
    if (child.nodeType !== 1) {
      child.parentNode?.removeChild(child);
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_STORE_TAG_SET.has(tag)) {
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

function sanitizeViaDomParser(html: string): Document | null {
  if (typeof DOMParser === 'undefined') {
    return null;
  }
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (!doc || !doc.body) {
      return null;
    }
    scrubDomSubtree(doc.body);
    return doc;
  } catch {
    return null;
  }
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
 * Sanitizes untrusted storefront HTML strings with strict URI scheme allowlisting
 * (`https:` and `ol-media:` only), `ALLOW_ARIA_ATTR: false`, `ALLOW_DATA_ATTR: false`,
 * `KEEP_CONTENT: false`, and mandatory `rel="noopener noreferrer"` on anchors.
 */
export function sanitizeStoreHtml(html: string | undefined | null): string {
  if (!html) return '';
  const purifier = getPurifier();
  if (purifier) {
    return String(
      purifier.sanitize(html, {
        ALLOWED_TAGS: ALLOWED_STORE_TAGS,
        ALLOWED_ATTR: ALLOWED_STORE_ATTR,
        ALLOWED_URI_REGEXP: ALLOWED_STORE_URI_REGEXP,
        ALLOW_ARIA_ATTR: false,
        ALLOW_DATA_ATTR: false,
        KEEP_CONTENT: false,
      })
    );
  }

  const parsedDoc = sanitizeViaDomParser(html);
  if (parsedDoc?.body) {
    return parsedDoc.body.innerHTML;
  }

  return escapeHtml(html);
}

/**
 * Sanitizes untrusted storefront HTML directly into a detached `DocumentFragment`
 * so callers can insert nodes without re-serializing and re-parsing `innerHTML` (preventing mXSS).
 */
export function sanitizeStoreDomFragment(html: string | undefined | null): DocumentFragment {
  if (typeof document === 'undefined') {
    throw new Error('sanitizeStoreDomFragment requires a DOM environment');
  }
  const emptyFragment = document.createDocumentFragment();
  if (!html) return emptyFragment;

  const purifier = getPurifier();
  if (purifier) {
    return purifier.sanitize(html, {
      ALLOWED_TAGS: ALLOWED_STORE_TAGS,
      ALLOWED_ATTR: ALLOWED_STORE_ATTR,
      ALLOWED_URI_REGEXP: ALLOWED_STORE_URI_REGEXP,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: false,
      RETURN_DOM_FRAGMENT: true,
    }) as DocumentFragment;
  }

  const parsedDoc = sanitizeViaDomParser(html);
  if (parsedDoc?.body) {
    while (parsedDoc.body.firstChild) {
      emptyFragment.appendChild(parsedDoc.body.firstChild);
    }
    return emptyFragment;
  }

  emptyFragment.appendChild(document.createTextNode(html));
  return emptyFragment;
}
