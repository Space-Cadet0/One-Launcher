import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';

/**
 * Strict URI allowlist for untrusted storefront HTML (`https:` and `ol-media:` only).
 * Blocks `file:`, `javascript:`, `data:`, `vbscript:`, and unencrypted `http:` schemes.
 */
export const SAFE_STORE_URI_REGEXP = /^(?:https:|ol-media:)/i;

const ALLOWED_STORE_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'dd',
  'del',
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
  'li',
  'ol',
  'p',
  'picture',
  'pre',
  's',
  'section',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'video',
  '#text',
];

const ALLOWED_STORE_ATTR = [
  'alt',
  'autoplay',
  'class',
  'colspan',
  'controls',
  'decoding',
  'height',
  'href',
  'loading',
  'loop',
  'media',
  'muted',
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

export function sanitizeSrcsetValue(rawSrcset?: string | null): string {
  if (!rawSrcset) return '';
  return rawSrcset
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const urlCandidate = upgradeProtocolRelativeUrl(parts[0]);
      if (!urlCandidate || !SAFE_STORE_URI_REGEXP.test(urlCandidate)) {
        return '';
      }
      return parts.length > 1 ? `${urlCandidate} ${parts.slice(1).join(' ')}` : urlCandidate;
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

/**
 * Post-sanitization walk on a `DocumentFragment` or `Element` subtree enforcing:
 * - Only `https:` and `ol-media:` URIs survive on `href`, `src`, `poster`, and `srcset`
 * - Every `<a>` anchor carries `rel="noopener noreferrer"` and `target="_blank"`
 */
export function enforceFragmentSecurityPolicy(root: DocumentFragment | Element): void {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  const elements = Array.from(root.querySelectorAll('*'));
  for (const el of elements) {
    for (const attr of ['href', 'src', 'poster']) {
      if (el.hasAttribute(attr)) {
        const upgraded = upgradeProtocolRelativeUrl(el.getAttribute(attr));
        if (!upgraded || !SAFE_STORE_URI_REGEXP.test(upgraded)) {
          el.removeAttribute(attr);
        } else {
          el.setAttribute(attr, upgraded);
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
}

/**
 * Sanitizes untrusted HTML into a detached `DocumentFragment` using `DOMPurify`
 * with `RETURN_DOM_FRAGMENT: true` (preventing re-serialization mXSS), strict
 * `https:` / `ol-media:` URI allowlisting, and mandatory anchor hardening.
 */
export function sanitizeSafeDomFragment(rawHtml: string | undefined | null): DocumentFragment | null {
  if (!rawHtml) {
    if (typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function') {
      return document.createDocumentFragment();
    }
    return null;
  }

  const normalizedInput = preNormalizeProtocolRelativeHtml(rawHtml);

  const sanitizedResult = DOMPurify.sanitize(normalizedInput, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ALLOWED_STORE_TAGS,
    ALLOWED_ATTR: ALLOWED_STORE_ATTR,
    ALLOWED_URI_REGEXP: SAFE_STORE_URI_REGEXP,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  }) as unknown;

  let fragment: DocumentFragment | null = null;
  if (
    sanitizedResult &&
    typeof (sanitizedResult as DocumentFragment).querySelectorAll === 'function'
  ) {
    fragment = sanitizedResult as DocumentFragment;
  } else if (typeof sanitizedResult === 'string') {
    if (
      typeof Document !== 'undefined' &&
      typeof (Document as unknown as { parseHTML?: (input: string) => Document }).parseHTML ===
        'function' &&
      typeof document !== 'undefined' &&
      typeof document.createDocumentFragment === 'function'
    ) {
      const parsedDoc = (
        Document as unknown as { parseHTML: (input: string) => Document }
      ).parseHTML(sanitizedResult);
      fragment = document.createDocumentFragment();
      while (parsedDoc.body.firstChild) {
        fragment.appendChild(parsedDoc.body.firstChild);
      }
    } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const tpl = document.createElement('template');
      tpl.innerHTML = sanitizedResult;
      fragment = tpl.content;
    }
  }

  if (fragment) {
    enforceFragmentSecurityPolicy(fragment);
  }
  return fragment;
}

/**
 * Sanitizes untrusted HTML to a clean string for SSR / non-DOM test environments
 * using the identical tag, attribute, and URI allowlist.
 */
export function sanitizeSafeHtmlString(rawHtml: string | undefined | null): string {
  if (!rawHtml) return '';
  const normalizedInput = preNormalizeProtocolRelativeHtml(rawHtml);
  const cleaned = String(
    DOMPurify.sanitize(normalizedInput, {
      ALLOWED_TAGS: ALLOWED_STORE_TAGS,
      ALLOWED_ATTR: ALLOWED_STORE_ATTR,
      ALLOWED_URI_REGEXP: SAFE_STORE_URI_REGEXP,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    })
  );
  // Enforce rel="noopener noreferrer" on serialized anchors for SSR / string consumers
  return cleaned.replace(/<a\b([^>]*)>/gi, (_full, attrs: string) => {
    const withoutRelOrTarget = attrs
      .replace(/\s+\b(?:rel|target)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .trim();
    const hasHref = /\bhref\s*=/i.test(withoutRelOrTarget);
    const prefix = withoutRelOrTarget ? ` ${withoutRelOrTarget}` : '';
    return hasHref
      ? `<a${prefix} target="_blank" rel="noopener noreferrer">`
      : `<a${prefix} rel="noopener noreferrer">`;
  });
}

const VOID_HTML_TAGS = new Set(['br', 'hr', 'img', 'source']);
const ALLOWED_REACT_TAGS = new Set(ALLOWED_STORE_TAGS.filter((t) => t !== '#text'));

function decodeHtmlEntities(text: string): string {
  if (!text || !text.includes('&')) return text;
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|nbsp|ndash|mdash));/gi,
    (full, dec?: string, hex?: string, named?: string) => {
      if (dec) {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      if (hex) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      switch ((named || '').toLowerCase()) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'nbsp':
          return '\u00A0';
        case 'ndash':
          return '–';
        case 'mdash':
          return '—';
        default:
          return full;
      }
    }
  );
}

function parseSanitizedAttributes(rawAttrs: string, tagName: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const attrRegex = /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawAttrs)) !== null) {
    const rawName = match[1].toLowerCase();
    if (!ALLOWED_STORE_ATTR.includes(rawName)) continue;
    const rawVal = match[2] ?? match[3] ?? match[4] ?? '';
    const decodedVal = decodeHtmlEntities(rawVal);

    if (rawName === 'href' || rawName === 'src' || rawName === 'poster') {
      const upgraded = upgradeProtocolRelativeUrl(decodedVal);
      if (!upgraded || !SAFE_STORE_URI_REGEXP.test(upgraded)) continue;
      props[rawName] = upgraded;
      continue;
    }
    if (rawName === 'srcset') {
      const cleanedSrcset = sanitizeSrcsetValue(decodedVal);
      if (cleanedSrcset) props.srcSet = cleanedSrcset;
      continue;
    }
    if (rawName === 'class') {
      props.className = decodedVal;
      continue;
    }
    if (rawName === 'colspan') {
      const n = Number.parseInt(decodedVal, 10);
      if (Number.isFinite(n) && n > 0) props.colSpan = n;
      continue;
    }
    if (rawName === 'rowspan') {
      const n = Number.parseInt(decodedVal, 10);
      if (Number.isFinite(n) && n > 0) props.rowSpan = n;
      continue;
    }
    if (
      rawName === 'autoplay' ||
      rawName === 'controls' ||
      rawName === 'loop' ||
      rawName === 'muted' ||
      rawName === 'playsinline'
    ) {
      const reactBoolProp =
        rawName === 'autoplay'
          ? 'autoPlay'
          : rawName === 'playsinline'
            ? 'playsInline'
            : rawName;
      props[reactBoolProp] = true;
      continue;
    }
    props[rawName] = decodedVal;
  }

  if (tagName === 'a') {
    props.rel = 'noopener noreferrer';
    if (typeof props.href === 'string' && props.href) {
      props.target = '_blank';
    } else {
      delete props.target;
    }
  }
  return props;
}

function parseSanitizedHtmlToReactNodes(sanitizedHtml: string): React.ReactNode[] {
  if (!sanitizedHtml) return [];
  interface StackFrame {
    tag: string;
    props: Record<string, unknown>;
    children: React.ReactNode[];
  }
  const rootChildren: React.ReactNode[] = [];
  const stack: StackFrame[] = [];
  let keyCounter = 0;

  const appendNode = (node: React.ReactNode) => {
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      rootChildren.push(node);
    }
  };

  const tokenRegex = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(sanitizedHtml)) !== null) {
    const [, closeTagRaw, openTagRaw, rawAttrs, selfClosingSlash, textChunk] = match;
    if (textChunk !== undefined) {
      const decoded = decodeHtmlEntities(textChunk);
      if (decoded) appendNode(decoded);
      continue;
    }
    if (closeTagRaw !== undefined) {
      const closeTag = closeTagRaw.toLowerCase();
      let matchIdx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === closeTag) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx !== -1) {
        while (stack.length > matchIdx) {
          const popped = stack.pop()!;
          const element = React.createElement(
            popped.tag,
            { ...popped.props, key: `sh-${keyCounter++}` },
            ...(popped.children.length > 0 ? popped.children : [])
          );
          appendNode(element);
        }
      }
      continue;
    }
    if (openTagRaw !== undefined) {
      const openTag = openTagRaw.toLowerCase();
      if (!ALLOWED_REACT_TAGS.has(openTag)) continue;
      const props = parseSanitizedAttributes(rawAttrs || '', openTag);
      if (VOID_HTML_TAGS.has(openTag) || selfClosingSlash === '/') {
        appendNode(React.createElement(openTag, { ...props, key: `sh-${keyCounter++}` }));
      } else {
        stack.push({ tag: openTag, props, children: [] });
      }
    }
  }

  while (stack.length > 0) {
    const popped = stack.pop()!;
    const element = React.createElement(
      popped.tag,
      { ...popped.props, key: `sh-${keyCounter++}` },
      ...(popped.children.length > 0 ? popped.children : [])
    );
    appendNode(element);
  }

  return rootChildren;
}

export interface SanitizedHtmlBlockProps {
  html: string;
  className?: string;
  testId?: string;
}

/**
 * Renders DOMPurify-sanitized HTML directly into allowlisted React elements without
 * invoking `innerHTML` or `dangerouslySetInnerHTML`, eliminating re-serialization mXSS
 * across browser DOM, SSR (`renderToString`), and headless test renderers.
 */
export const SanitizedHtmlBlock: React.FC<SanitizedHtmlBlockProps> = ({
  html,
  className,
  testId,
}) => {
  const nodes = useMemo(
    () => parseSanitizedHtmlToReactNodes(sanitizeSafeHtmlString(html)),
    [html]
  );

  return React.createElement(
    'div',
    {
      'data-testid': testId,
      className,
    },
    ...nodes
  );
};
