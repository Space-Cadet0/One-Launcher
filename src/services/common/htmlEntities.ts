/**
 * Unified single-pass HTML entity decoder using validated `String.fromCodePoint`.
 *
 * Enforces strict Unicode scalar bounds (`0x20..0x10FFFF`, excluding C0 controls `0x00..0x1F`,
 * DEL `0x7F`, and UTF-16 surrogates `0xD800..0xDFFF`) and performs single-pass decoding to avoid
 * double-unescaping vulnerabilities (e.g. `&amp;lt;` -> `&lt;`, never `<`).
 */

export interface DecodeHtmlEntitiesOptions {
  /**
   * When true, maps typographic smart-quote entities (`&rsquo;`, `&lsquo;`, `&ldquo;`, `&rdquo;`)
   * to ASCII quotes (`'` and `"`), matching plain-text synopsis conventions.
   * Defaults to `false` (preserves canonical Unicode typographic characters).
   */
  asciiQuotes?: boolean;
  /**
   * When true, preserves invalid/out-of-range numeric character references verbatim instead of
   * stripping them to `""`. Defaults to `false` (strips invalid numeric references).
   */
  preserveInvalidNumeric?: boolean;
}

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  trade: '\u2122',
  reg: '\u00ae',
  copy: '\u00a9',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  radic: '\u221a',
  eacute: '\u00e9',
  egrave: '\u00e8',
  ecirc: '\u00ea',
  euml: '\u00eb',
  aacute: '\u00e1',
  agrave: '\u00e0',
  acirc: '\u00e2',
  auml: '\u00e4',
  atilde: '\u00e3',
  aring: '\u00e5',
  aelig: '\u00e6',
  ccedil: '\u00e7',
  iacute: '\u00ed',
  igrave: '\u00ec',
  icirc: '\u00ee',
  iuml: '\u00ef',
  ntilde: '\u00f1',
  oacute: '\u00f3',
  ograve: '\u00f2',
  ocirc: '\u00f4',
  ouml: '\u00f6',
  otilde: '\u00f5',
  oslash: '\u00f8',
  uacute: '\u00fa',
  ugrave: '\u00f9',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  yacute: '\u00fd',
  yuml: '\u00ff',
  szlig: '\u00df',
};

const ASCII_QUOTE_OVERRIDES: Readonly<Record<string, string>> = {
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

const HTML_ENTITY_RE = /&(?:#x0*([0-9a-f]+)|#0*(\d+)|([a-z][a-z0-9]*));/gi;

/**
 * Returns true if `codePoint` is a safe Unicode scalar value in `[0x20, 0x10FFFF]`,
 * excluding C0 control characters (`0x00..0x1F`), DEL (`0x7F`), and UTF-16 surrogates (`0xD800..0xDFFF`).
 */
export function isValidHtmlCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0x20 &&
    codePoint <= 0x10ffff &&
    codePoint !== 0x7f &&
    (codePoint < 0xd800 || codePoint > 0xdfff)
  );
}

/**
 * Safely converts a numeric code point to a string using `String.fromCodePoint`,
 * returning `""` for out-of-range, surrogate, or C0 control values.
 */
export function safeFromCodePoint(codePoint: number): string {
  if (!isValidHtmlCodePoint(codePoint)) {
    return '';
  }
  if (codePoint === 0xa0) {
    return ' ';
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Decodes named and numeric (`&#...;`, `&#x...;`) HTML entities in a single pass.
 */
export function decodeHtmlEntities(
  input: string | undefined | null,
  options?: DecodeHtmlEntitiesOptions
): string {
  if (!input || typeof input !== 'string') return '';
  if (!input.includes('&')) return input;

  const asciiQuotes = Boolean(options?.asciiQuotes);
  const preserveInvalidNumeric = Boolean(options?.preserveInvalidNumeric);

  return input.replace(
    HTML_ENTITY_RE,
    (full: string, hex?: string, dec?: string, named?: string): string => {
      if (hex !== undefined) {
        if (hex.length > 6) {
          return preserveInvalidNumeric ? full : '';
        }
        const code = Number.parseInt(hex, 16);
        const decoded = safeFromCodePoint(code);
        if (!decoded) {
          return preserveInvalidNumeric ? full : '';
        }
        if (asciiQuotes) {
          if (code === 0x2018 || code === 0x2019) return "'";
          if (code === 0x201c || code === 0x201d) return '"';
        }
        return decoded;
      }

      if (dec !== undefined) {
        if (dec.length > 7) {
          return preserveInvalidNumeric ? full : '';
        }
        const code = Number.parseInt(dec, 10);
        const decoded = safeFromCodePoint(code);
        if (!decoded) {
          return preserveInvalidNumeric ? full : '';
        }
        if (asciiQuotes) {
          if (code === 0x2018 || code === 0x2019) return "'";
          if (code === 0x201c || code === 0x201d) return '"';
        }
        return decoded;
      }

      if (named !== undefined) {
        const lower = named.toLowerCase();
        if (asciiQuotes && lower in ASCII_QUOTE_OVERRIDES) {
          return ASCII_QUOTE_OVERRIDES[lower];
        }
        if (lower in NAMED_HTML_ENTITIES) {
          return NAMED_HTML_ENTITIES[lower];
        }
      }

      return full;
    }
  );
}
