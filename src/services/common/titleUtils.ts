/**
 * Shared Canonical Title Normalization and Edition Utilities
 * Single source of truth for Storefront Matcher (steamMatcher), Review Engine (criticUtils),
 * and Scraper Services.
 */

export const EDITION_TOKENS = new Set<string>([
  'edition',
  'standard',
  'deluxe',
  'gold',
  'silver',
  'platinum',
  'diamond',
  'collector',
  'collectors',
  "collector's",
  'ultimate',
  'complete',
  'special',
  'limited',
  'definitive',
  'enhanced',
  'anniversary',
  'directors',
  'director',
  'cut',
  'goty',
  'remastered',
  'remaster',
  'remake',
  'classic',
  'classics',
  'pack',
  'package',
  'bundle',
  'collection',
  'trilogy',
  'drmfree',
  'drm',
  'free',
  'extended',
  'game',
  'year',
  'final',
  'royal',
  'emperor',
  'plus',
  'upgrade',
  'vr',
  'hd',
]);

export function isEditionToken(token: string): boolean {
  if (!token) return false;
  return EDITION_TOKENS.has(token.toLowerCase().trim());
}

/**
 * Normalizes title string by stripping trademarks, apostrophes, and punctuation.
 */
export function normalizeTitleKey(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips edition suffixes (e.g. Definitive Edition, Deluxe, Gold, Complete Pack, Remastered).
 */
export function stripEditionSuffix(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(
      /\b(digital\s+)?(the\s+)?(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|director'?s cut|goty|game of the year|remastered|remake)\b.*$/i,
      ''
    )
    .replace(/-(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|goty|game-of-the-year|remastered|remake)(-edition|-pack|-bundle|-collection)?$/i, '')
    .replace(/-(edition|pack|bundle|collection)$/i, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const ROMAN_TO_ARABIC: Record<string, string> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xvii: '17',
  xviii: '18',
  xix: '19',
  xx: '20',
};

export const NUMERIC_SEQUELS = new Set([
  '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'
]);

/**
 * Extracts sequel numeric identifier (Arabic or Roman numeral) from title or word token list.
 */
export function extractSequelIdentifier(input: string | string[]): string | null {
  if (!input) return null;
  const words = Array.isArray(input)
    ? input.map((w) => w.toLowerCase())
    : normalizeTitleKey(input).split(' ').filter(Boolean);
  for (const word of words) {
    if (NUMERIC_SEQUELS.has(word) || /^[2-9]$|^1[0-9]$|^20$/.test(word)) {
      return word;
    }
    if (ROMAN_TO_ARABIC[word]) {
      return ROMAN_TO_ARABIC[word];
    }
  }
  return null;
}

/**
 * Validates whether two game titles represent different numbered sequels or distinct variants.
 * Returns TRUE if there is a sequel/variant mismatch (i.e. DO NOT MATCH).
 * Returns FALSE if they are compatible.
 */
export function isSequelMismatch(query: string, candidateName: string): boolean {
  if (!query || !candidateName) return false;

  const normalize = (str: string) =>
    str
      .toLowerCase()
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => ROMAN_TO_ARABIC[token] || token);

  const qTokens = normalize(query);
  const cTokens = normalize(candidateName);

  const otherVariants = new Set(['new', 'vr']);
  const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'edition', 'game', 'classic', 'standard', 'deluxe']);

  for (const num of NUMERIC_SEQUELS) {
    const qHas = qTokens.includes(num);
    const cHas = cTokens.includes(num);
    if ((!qHas && cHas) || (qHas && !cHas)) {
      // If the number is part of an anniversary/celebration (e.g. '20 Year Celebration'), ignore
      if (num === '20' && (qTokens.includes('year') || cTokens.includes('year'))) continue;

      // Check if this is an intermediate numeral before a distinctive subtitle
      const hasNumeral = qHas ? qTokens : cTokens;
      const noNumeral = qHas ? cTokens : qTokens;
      const numIdx = hasNumeral.indexOf(num);
      const afterNum = hasNumeral.slice(numIdx + 1).filter((t) => !stopWords.has(t) && !NUMERIC_SEQUELS.has(t));

      const hasSubtitleSyntax =
        query.includes(':') ||
        query.includes(' - ') ||
        candidateName.includes(':') ||
        candidateName.includes(' - ');

      const subtitleMatches =
        afterNum.length >= (hasSubtitleSyntax ? 1 : 2) && afterNum.every((t) => noNumeral.includes(t));

      if (subtitleMatches) {
        continue; // Permitted subtitle match (e.g. Deus Ex 2: Invisible War vs Deus Ex: Invisible War)
      }
      return true;
    }
  }

  // Distinct numbers mismatch (e.g. 'THE KING OF FIGHTERS 2002' vs 'The King of Fighters-i 2012')
  const qAllNums = qTokens.filter((t) => /^\d+$/.test(t));
  const cAllNums = cTokens.filter((t) => /^\d+$/.test(t));
  if (qAllNums.length > 0 && cAllNums.length > 0) {
    const qHasDiff = qAllNums.some((n) => !cAllNums.includes(n));
    const cHasDiff = cAllNums.some((n) => !qAllNums.includes(n));
    if (qHasDiff && cHasDiff) {
      return true;
    }
  }

  for (const variant of otherVariants) {
    const qHas = qTokens.includes(variant);
    const cHas = cTokens.includes(variant);
    if ((!qHas && cHas) || (qHas && !cHas)) {
      return true;
    }
  }

  // Edition mismatch: prevent distinct remaster/remake releases from adopting original game reviews
  const editions = new Set(['remastered', 'remake']);
  for (const ed of editions) {
    const qHas = qTokens.includes(ed);
    const cHas = cTokens.includes(ed);
    if (qHas && !cHas) return true;
  }

  // Compilation/bundle mismatch: prevent dual game compilations (e.g. 'DOOM + DOOM II')
  // from erroneously resolving to a single component game (e.g. 'Doom II')
  if (/\s\+\s/.test(query) && !candidateName.toLowerCase().includes('+') && !candidateName.toLowerCase().includes('plus')) {
    return true;
  }
  return false;
}
