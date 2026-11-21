import { decodeHtmlEntities } from './htmlEntities';
import { LruMap } from './lruMap';

const MAX_SYNOPSIS_MEMO_ENTRIES = 2048;
const MAX_SYNOPSIS_MEMO_INPUT_LEN = 24000;

const plainSynopsisMemo = new LruMap<string, string>(MAX_SYNOPSIS_MEMO_ENTRIES);

const EMPTY_MARKDOWN_LINK_ONLY_RE = /^(?:\s*!?\[\s*\]\([^)]*\)\s*)+$/;
const HTML_TAG_RE = /<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*)?\s*\/?>/gi;
const DANGEROUS_HTML_BLOCK_RE =
  /<(?:script|style|noscript|template|iframe|svg|math)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|iframe|svg|math)>/gi;

/**
 * Returns true when raw text consists solely of empty-label Markdown link/image artifacts
 * such as `[](/discover/v-bucks)` or `![]()`.
 */
export function isEmptyMarkdownLinkArtifact(rawText?: string): boolean {
  if (!rawText || typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed) return false;
  return EMPTY_MARKDOWN_LINK_ONLY_RE.test(trimmed);
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
  if (isEmptyMarkdownLinkArtifact(rawText)) return '';
  const canMemo = rawText.length <= MAX_SYNOPSIS_MEMO_INPUT_LEN;
  const memoKey = canMemo ? `${maxLength}\u0000${rawText}` : '';
  if (canMemo) {
    const hit = plainSynopsisMemo.get(memoKey);
    if (hit !== undefined) return hit;
  }

  const strippedMarkup = rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DANGEROUS_HTML_BLOCK_RE, '')
    .replace(/product_(?:description|feature)_\d+/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n')
    .replace(HTML_TAG_RE, '')
    .replace(/\[\/?(?:b|i|u|url|quote|img|h[1-6]|list|code|spoiler|\*)[^\]]*\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  const clean = decodeHtmlEntities(strippedMarkup, { asciiQuotes: true }).trim();

  if (!clean) {
    if (canMemo) plainSynopsisMemo.set(memoKey, '');
    return '';
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
    if (canMemo) plainSynopsisMemo.set(memoKey, '');
    return '';
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
  if (canMemo) {
    plainSynopsisMemo.set(memoKey, result);
  }
  return result;
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
  const strippedMarkup = rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DANGEROUS_HTML_BLOCK_RE, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n')
    .replace(HTML_TAG_RE, '');

  return decodeHtmlEntities(strippedMarkup, { asciiQuotes: true })
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

export function clearSynopsisTextMemo(): void {
  plainSynopsisMemo.clear();
}
