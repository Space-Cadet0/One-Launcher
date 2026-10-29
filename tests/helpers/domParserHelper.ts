/**
 * Lightweight, dependency-free HTML5 fragment `DOMParser` helper for Node Vitest suites.
 * Supports standard `new DOMParser().parseFromString(html, 'text/html')` semantics.
 */

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const RAW_TEXT_HTML_TAGS = new Set(['script', 'style']);

export interface ParsedDomTextNode {
  readonly nodeType: 3;
  data: string;
  textContent: string;
  parentNode: ParsedDomElementNode | null;
}

export interface ParsedDomAttr {
  name: string;
  value: string;
}

export class ParsedDomElementNode {
  public readonly nodeType = 1 as const;
  public readonly tagName: string;
  public readonly nodeName: string;
  public parentNode: ParsedDomElementNode | null = null;
  public childNodes: Array<ParsedDomElementNode | ParsedDomTextNode> = [];
  private attrMap = new Map<string, string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
  }

  get children(): ParsedDomElementNode[] {
    return this.childNodes.filter((n): n is ParsedDomElementNode => n.nodeType === 1);
  }

  get attributes(): ParsedDomAttr[] {
    return Array.from(this.attrMap.entries()).map(([name, value]) => ({ name, value }));
  }

  setAttribute(name: string, value: string): void {
    this.attrMap.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    for (const [k, v] of this.attrMap.entries()) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name: string): void {
    for (const k of Array.from(this.attrMap.keys())) {
      if (k.toLowerCase() === name.toLowerCase()) {
        this.attrMap.delete(k);
      }
    }
  }

  appendChild<T extends ParsedDomElementNode | ParsedDomTextNode>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends ParsedDomElementNode | ParsedDomTextNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  get outerHTML(): string {
    const lower = this.tagName.toLowerCase();
    const attrParts: string[] = [];
    for (const [k, v] of this.attrMap.entries()) {
      attrParts.push(`${k}="${escapeAttrValue(v)}"`);
    }
    const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';
    if (VOID_HTML_TAGS.has(lower)) {
      return `<${lower}${attrStr}>`;
    }
    return `<${lower}${attrStr}>${this.innerHTML}</${lower}>`;
  }

  get innerHTML(): string {
    return this.childNodes
      .map((child) => (child.nodeType === 3 ? escapeTextContent(child.data) : child.outerHTML))
      .join('');
  }

  matches(selector: string): boolean {
    const groups: string[] = [];
    let current = '';
    let bracketDepth = 0;
    let quoteChar: string | null = null;
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (quoteChar) {
        current += ch;
        if (ch === quoteChar) quoteChar = null;
      } else if (ch === '"' || ch === "'") {
        quoteChar = ch;
        current += ch;
      } else if (ch === '[') {
        bracketDepth++;
        current += ch;
      } else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
        current += ch;
      } else if (ch === ',' && bracketDepth === 0) {
        if (current.trim()) groups.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) groups.push(current.trim());

    const lowerTag = this.tagName.toLowerCase();
    const classes = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const id = this.getAttribute('id') || '';

    return groups.some((compound) => {
      if (compound === '*') return true;

      const attrChecks: Array<{ name: string; hasEq: boolean; value: string }> = [];
      const attrPattern =
        /\[\s*([^\s=\]~|^$*]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\s*\]/g;
      const stripped = compound
        .replace(attrPattern, (_full, attrName, dqVal, sqVal, bareVal) => {
          const hasEq = dqVal !== undefined || sqVal !== undefined || bareVal !== undefined;
          const val = dqVal ?? sqVal ?? (bareVal !== undefined ? String(bareVal).trim() : '');
          attrChecks.push({ name: String(attrName), hasEq, value: val });
          return '';
        })
        .trim();

      for (const check of attrChecks) {
        const actual = this.getAttribute(check.name);
        if (actual === null) return false;
        if (check.hasEq && actual !== check.value) return false;
      }

      if (!stripped) {
        return attrChecks.length > 0;
      }

      const tokenPattern = /(^[a-zA-Z*][a-zA-Z0-9:-]*)|(#[a-zA-Z0-9_-]+)|(\.[a-zA-Z0-9_-]+)/g;
      let consumed = '';
      let tokMatch: RegExpExecArray | null;
      while ((tokMatch = tokenPattern.exec(stripped)) !== null) {
        consumed += tokMatch[0];
        if (tokMatch[1]) {
          const expectedTag = tokMatch[1].toLowerCase();
          if (expectedTag !== '*' && lowerTag !== expectedTag) return false;
        } else if (tokMatch[2]) {
          if (id !== tokMatch[2].slice(1)) return false;
        } else if (tokMatch[3]) {
          if (!classes.includes(tokMatch[3].slice(1))) return false;
        }
      }

      return consumed.length === stripped.length;
    });
  }

  querySelectorAll(selector: string): ParsedDomElementNode[] {
    const results: ParsedDomElementNode[] = [];
    const visit = (el: ParsedDomElementNode) => {
      for (const child of el.childNodes) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) results.push(child);
          visit(child);
        }
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector: string): ParsedDomElementNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function decodeHtmlEntities(raw: string): string {
  if (!raw || !raw.includes('&')) return raw;
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z0-9]+));/g, (full, hex, dec, named) => {
    if (hex) {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (dec) {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    switch (String(named).toLowerCase()) {
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
        return '\u00a0';
      default:
        return full;
    }
  });
}

function escapeTextContent(raw: string): string {
  return String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttrValue(raw: string): string {
  return escapeTextContent(raw).replace(/"/g, '&quot;');
}

function createTextNode(rawText: string): ParsedDomTextNode {
  const decoded = decodeHtmlEntities(rawText);
  return {
    nodeType: 3,
    data: decoded,
    textContent: decoded,
    parentNode: null,
  };
}

function parseAttributesIntoElement(attrChunk: string, elem: ParsedDomElementNode): void {
  const attrRegex = /([^\s=/>"'`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrChunk)) !== null) {
    const name = match[1];
    if (!name || name === '/') continue;
    const rawVal = match[2] ?? match[3] ?? match[4] ?? '';
    elem.setAttribute(name, decodeHtmlEntities(rawVal));
  }
}

function parseHtmlIntoBody(html: string): ParsedDomElementNode {
  const body = new ParsedDomElementNode('body');
  const stack: ParsedDomElementNode[] = [body];
  const src = String(html || '');
  let idx = 0;

  while (idx < src.length) {
    const lt = src.indexOf('<', idx);
    if (lt < 0) {
      const rest = src.slice(idx);
      if (rest.length > 0) {
        stack[stack.length - 1].appendChild(createTextNode(rest));
      }
      break;
    }
    if (lt > idx) {
      stack[stack.length - 1].appendChild(createTextNode(src.slice(idx, lt)));
    }

    // HTML comment <!-- ... -->
    if (src.startsWith('<!--', lt)) {
      const endComment = src.indexOf('-->', lt + 4);
      idx = endComment >= 0 ? endComment + 3 : src.length;
      continue;
    }

    // Doctype / declaration <!DOCTYPE ...>
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const gt = src.indexOf('>', lt + 2);
      idx = gt >= 0 ? gt + 1 : src.length;
      continue;
    }

    // Closing tag </tag>
    if (src.startsWith('</', lt)) {
      const gt = src.indexOf('>', lt + 2);
      if (gt < 0) break;
      const closeName = src
        .slice(lt + 2, gt)
        .trim()
        .toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tagName.toLowerCase() === closeName) {
          stack.length = s;
          break;
        }
      }
      idx = gt + 1;
      continue;
    }

    // Opening tag <tag ...>
    let gt = -1;
    let quote: string | null = null;
    for (let pos = lt + 1; pos < src.length; pos++) {
      const ch = src[pos];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        gt = pos;
        break;
      }
    }
    if (gt < 0) {
      stack[stack.length - 1].appendChild(createTextNode(src.slice(lt)));
      break;
    }

    const inner = src.slice(lt + 1, gt).trim();
    const selfClosing = inner.endsWith('/');
    const cleanInner = selfClosing ? inner.slice(0, -1).trim() : inner;
    const tagMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(cleanInner);
    if (!tagMatch) {
      stack[stack.length - 1].appendChild(createTextNode(src.slice(lt, gt + 1)));
      idx = gt + 1;
      continue;
    }

    const tagName = tagMatch[1].toLowerCase();
    const attrPart = tagMatch[2] || '';
    const elem = new ParsedDomElementNode(tagName);
    parseAttributesIntoElement(attrPart, elem);
    stack[stack.length - 1].appendChild(elem);
    idx = gt + 1;

    if (RAW_TEXT_HTML_TAGS.has(tagName) && !selfClosing) {
      const closePattern = new RegExp(`</${tagName}\\s*>`, 'i');
      const rest = src.slice(idx);
      const closeMatch = closePattern.exec(rest);
      if (closeMatch) {
        if (closeMatch.index > 0) {
          elem.appendChild(createTextNode(rest.slice(0, closeMatch.index)));
        }
        idx += closeMatch.index + closeMatch[0].length;
      } else {
        if (rest.length > 0) elem.appendChild(createTextNode(rest));
        idx = src.length;
      }
      continue;
    }

    if (!selfClosing && !VOID_HTML_TAGS.has(tagName)) {
      stack.push(elem);
    }
  }

  return body;
}

export class TestDOMParser {
  parseFromString(markup: string, _type: string = 'text/html'): {
    body: ParsedDomElementNode;
    documentElement: ParsedDomElementNode;
    querySelector: (selector: string) => ParsedDomElementNode | null;
    querySelectorAll: (selector: string) => ParsedDomElementNode[];
  } {
    const htmlRoot = new ParsedDomElementNode('html');
    const body = parseHtmlIntoBody(markup);
    htmlRoot.appendChild(body);
    return {
      body,
      documentElement: htmlRoot,
      querySelector: (sel: string) => body.querySelector(sel),
      querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    };
  }
}

interface DomElementLike {
  readonly nodeType: number;
  readonly tagName: string;
  readonly innerHTML: string;
  readonly attributes: ArrayLike<{ name: string; value: string }>;
  readonly childNodes: ArrayLike<DomNodeLike>;
  remove(): void;
  removeAttribute(name: string): void;
  querySelectorAll(selector: string): ArrayLike<DomElementLike>;
}

interface DomNodeLike {
  readonly nodeType: number;
  readonly textContent: string | null;
}

function parseSanitizedBodyWithDomParser(rawHtml: string): DomElementLike {
  const NativeDomParser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  const doc =
    typeof NativeDomParser === 'function'
      ? new NativeDomParser().parseFromString(String(rawHtml || ''), 'text/html')
      : new TestDOMParser().parseFromString(String(rawHtml || ''), 'text/html');

  const body = doc.body as unknown as DomElementLike;
  const forbiddenList = body.querySelectorAll('script, iframe, object, embed');
  for (let i = 0; i < forbiddenList.length; i++) {
    forbiddenList[i].remove();
  }
  const allElements = body.querySelectorAll('*');
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    const attrNames: string[] = [];
    for (let a = 0; a < el.attributes.length; a++) {
      attrNames.push(el.attributes[a].name);
    }
    for (const attrName of attrNames) {
      if (/^on/i.test(attrName)) {
        el.removeAttribute(attrName);
      }
    }
  }
  return body;
}

export function sanitizeHtmlStringViaDomParser(rawHtml: string): string {
  const body = parseSanitizedBodyWithDomParser(rawHtml);
  return body.innerHTML;
}

export function buildSanitizedFragmentViaDomParser<TFrag, TElement, TText>(
  rawHtml: string,
  factories: {
    createFragment: () => TFrag;
    createElement: (tagName: string) => TElement;
    createText: (text: string) => TText;
    setAttribute: (el: TElement, name: string, value: string) => void;
    appendChildToElement: (parent: TElement, child: TElement | TText) => void;
    appendChildToFragment: (frag: TFrag, child: TElement | TText) => void;
  }
): TFrag {
  const body = parseSanitizedBodyWithDomParser(rawHtml);

  const convertNode = (node: DomNodeLike): TElement | TText | null => {
    if (node.nodeType === 3) {
      return factories.createText(String(node.textContent || ''));
    }
    if (node.nodeType === 1) {
      const domEl = node as unknown as DomElementLike;
      const outEl = factories.createElement(domEl.tagName.toLowerCase());
      for (let a = 0; a < domEl.attributes.length; a++) {
        const attr = domEl.attributes[a];
        factories.setAttribute(outEl, attr.name, attr.value);
      }
      for (let c = 0; c < domEl.childNodes.length; c++) {
        const built = convertNode(domEl.childNodes[c]);
        if (built !== null) {
          factories.appendChildToElement(outEl, built);
        }
      }
      return outEl;
    }
    return null;
  };

  const frag = factories.createFragment();
  for (let i = 0; i < body.childNodes.length; i++) {
    const built = convertNode(body.childNodes[i]);
    if (built !== null) {
      factories.appendChildToFragment(frag, built);
    }
  }
  return frag;
}
