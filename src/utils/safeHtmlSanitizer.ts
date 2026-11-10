import React, { useMemo } from 'react';
import {
  ALLOWED_STORE_ATTR,
  ALLOWED_STORE_ELEMENT_NAMES,
  SAFE_STORE_URI_REGEXP,
  enforceFragmentSecurityPolicy,
  sanitizeAllowedStoreUri,
  sanitizeSafeDomFragment,
  sanitizeSrcsetValue,
  sanitizeStoreHtml,
  upgradeProtocolRelativeUrl,
} from '../services/common/htmlSanitizer';
import { stripHtmlToPlainText } from '../services/common/synopsisTextUtils';

export {
  SAFE_STORE_URI_REGEXP,
  enforceFragmentSecurityPolicy,
  sanitizeAllowedStoreUri,
  sanitizeSafeDomFragment,
  sanitizeSrcsetValue,
  upgradeProtocolRelativeUrl,
};

export const sanitizeSafeHtmlString = sanitizeStoreHtml;

const VOID_HTML_TAGS = new Set(['br', 'hr', 'img', 'source', 'wbr']);
const ALLOWED_REACT_TAGS = new Set<string>(ALLOWED_STORE_ELEMENT_NAMES);
const ALLOWED_ATTR_SET = new Set<string>(ALLOWED_STORE_ATTR);

function extractAllowedElementAttributes(el: Element): Array<{ name: string; value: string }> {
  if (el.attributes != null && typeof el.attributes[Symbol.iterator] === 'function') {
    return Array.from(el.attributes)
      .map((attr) => ({ name: attr.name.toLowerCase(), value: attr.value }))
      .filter((attr) => ALLOWED_ATTR_SET.has(attr.name));
  }
  if (typeof el.getAttribute === 'function') {
    const out: Array<{ name: string; value: string }> = [];
    for (const allowedName of ALLOWED_STORE_ATTR) {
      const val = el.getAttribute(allowedName);
      if (val !== null) {
        out.push({ name: allowedName, value: val });
      }
    }
    return out;
  }
  return [];
}

function mapDomAttributesToReactProps(el: Element, tagName: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const attr of extractAllowedElementAttributes(el)) {
    const rawName = attr.name;
    const rawVal = attr.value;

    if (rawName === 'href' || rawName === 'src' || rawName === 'poster') {
      const safeUri = sanitizeAllowedStoreUri(rawVal);
      if (safeUri) props[rawName] = safeUri;
      continue;
    }
    if (rawName === 'srcset') {
      const cleanedSrcset = sanitizeSrcsetValue(rawVal);
      if (cleanedSrcset) props.srcSet = cleanedSrcset;
      continue;
    }
    if (rawName === 'class') {
      props.className = rawVal;
      continue;
    }
    if (rawName === 'colspan') {
      const n = Number.parseInt(rawVal, 10);
      if (Number.isFinite(n) && n > 0) props.colSpan = n;
      continue;
    }
    if (rawName === 'rowspan') {
      const n = Number.parseInt(rawVal, 10);
      if (Number.isFinite(n) && n > 0) props.rowSpan = n;
      continue;
    }
    if (
      rawName === 'autoplay' ||
      rawName === 'controls' ||
      rawName === 'loop' ||
      rawName === 'muted' ||
      rawName === 'open' ||
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
    props[rawName] = rawVal;
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

function mapDomNodesToReactNodes(
  parent: ParentNode,
  keyCounter: { value: number }
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.textContent;
      if (text) result.push(text);
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_REACT_TAGS.has(tag)) {
      continue;
    }
    const props = mapDomAttributesToReactProps(el, tag);
    props.key = `sh-${keyCounter.value++}`;
    if (VOID_HTML_TAGS.has(tag)) {
      result.push(React.createElement(tag, props));
    } else {
      const children = mapDomNodesToReactNodes(el, keyCounter);
      result.push(
        children.length > 0
          ? React.createElement(tag, props, ...children)
          : React.createElement(tag, props)
      );
    }
  }
  return result;
}

export interface SanitizedHtmlBlockProps {
  html: string;
  className?: string;
  testId?: string;
}

/**
 * Renders sanitized untrusted HTML by walking a detached `DocumentFragment` directly into
 * allowlisted React elements without string re-serialization, regex HTML re-tokenizing, or
 * `dangerouslySetInnerHTML`. Falls back deterministically to plain text in non-DOM SSR environments.
 */
export const SanitizedHtmlBlock: React.FC<SanitizedHtmlBlockProps> = ({
  html,
  className,
  testId,
}) => {
  const nodes = useMemo<React.ReactNode[]>(() => {
    if (!html) return [];
    const fragment = sanitizeSafeDomFragment(html);
    if (fragment) {
      return mapDomNodesToReactNodes(fragment, { value: 0 });
    }
    const plainFallback = stripHtmlToPlainText(html);
    return plainFallback ? [plainFallback] : [];
  }, [html]);

  return React.createElement(
    'div',
    {
      'data-testid': testId,
      className,
    },
    ...nodes
  );
};
