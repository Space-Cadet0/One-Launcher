const MAX_SYNOPSIS_MEMO_ENTRIES = 2048;
const MAX_SYNOPSIS_MEMO_INPUT_LEN = 24000;

const plainSynopsisMemo = new Map<string, string>();

function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const val = cache.get(key);
  if (val !== undefined) {
    cache.delete(key);
    cache.set(key, val);
  }
  return val;
}

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_SYNOPSIS_MEMO_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/**
 * Strips raw HTML tags, comments, BBCode, Markdown links/images, and HTML entities
 * from storefront descriptions, returning a clean plain-text synopsis suitable for
 * hero blurbs, card hovers, and non-DOM SSR fallbacks.
 *
 * Pure Layer 0 foundation utility (`services-foundation`) with bounded LRU memoization.
 */
export function stripHtmlToPlainSynopsis(rawText?: string, maxLength = 320): string {
  if (!rawText || typeof rawText !== 'string') return '';
  const canMemo = rawText.length <= MAX_SYNOPSIS_MEMO_INPUT_LEN;
  const memoKey = canMemo ? `${maxLength}\u0000${rawText}` : '';
  if (canMemo) {
    const hit = lruGet(plainSynopsisMemo, memoKey);
    if (hit !== undefined) return hit;
  }

  const clean = rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(?:script|style|noscript|template|iframe|svg|math)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|iframe|svg|math)>/gi,
      ''
    )
    .replace(/product_(?:description|feature)_\d+/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?(?:b|i|u|url|quote|img|h[1-6]|list|code|spoiler|\*)[^\]]*\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&trade;/gi, '™')
    .replace(/&reg;/gi, '®')
    .replace(/&copy;/gi, '©')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return !isNaN(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return !isNaN(code) ? String.fromCharCode(code) : '';
    })
    .trim();

  if (!clean) {
    return canMemo ? lruSet(plainSynopsisMemo, memoKey, '') : '';
  }

  const paragraphs = clean
    .split(/\r?\n+/)
    .map((p) =>
      p
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) {
    return canMemo ? lruSet(plainSynopsisMemo, memoKey, '') : '';
  }

  while (
    paragraphs.length > 1 &&
    ((paragraphs[0].length < 40 &&
      /^(about(?:\s+the\s+game|\s+this\s+game)?|overview|story|description|features|synopsis|summary|key\s+features)\b[:.\s-]*$/i.test(
        paragraphs[0]
      )) ||
      /when you buy this game\b|will be added to your gog\.com account/i.test(paragraphs[0]))
  ) {
    paragraphs.shift();
  }

  let firstPara = paragraphs[0];

  if (maxLength > 0 && firstPara.length > maxLength) {
    const truncated = firstPara.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.7) {
      firstPara = truncated.substring(0, lastSpace).trim() + '...';
    } else {
      firstPara = truncated.trim() + '...';
    }
  }
  const result = firstPara.trim();
  return canMemo ? lruSet(plainSynopsisMemo, memoKey, result) : result;
}

export function extractFirstParagraph(rawText?: string, maxLength = 260): string | null {
  const result = stripHtmlToPlainSynopsis(rawText, maxLength);
  return result || null;
}

/**
 * Strips raw HTML tags, dangerous blocks (`<script>`, `<style>`, etc.), comments, and entities
 * while preserving **all** paragraphs/list items (for full-document non-DOM SSR fallbacks such as
 * `SanitizedHtmlBlock` in `SystemRequirements`).
 */
export function stripHtmlToPlainText(rawText?: string): string {
  if (!rawText || typeof rawText !== 'string') return '';
  return rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(?:script|style|noscript|template|iframe|svg|math)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|iframe|svg|math)>/gi,
      ''
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&trade;/gi, '™')
    .replace(/&reg;/gi, '®')
    .replace(/&copy;/gi, '©')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return !isNaN(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return !isNaN(code) ? String.fromCharCode(code) : '';
    })
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

export function clearSynopsisTextMemo(): void {
  plainSynopsisMemo.clear();
}
