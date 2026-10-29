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
  'premium',
  'digital',
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
  'celebration',
  'founders',
  'founder',
  "founder's",
  'directors',
  'director',
  "director's",
  'cut',
  'uncut',
  'goty',
  'remastered',
  'remaster',
  'remake',
  'redux',
  'classic',
  'classics',
  'pack',
  'package',
  'bundle',
  'collection',
  'trilogy',
  'drmfree',
  'extended',
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

const NATURAL_PC_PREDECESSOR_RE =
  /(?:^|\s)(?:my|your|our|the|his|her|its|a|an|this|that|new|old|custom|virtual|retro|mini|pocket|super|dream|ultimate|gaming|home|office|build\s+a)\s+pc$/i;
const NATURAL_WINDOWS_PREDECESSOR_RE =
  /(?:^|\s)(?:the|of|in|into|through|behind|between|beyond|under|over|from|with|without|two|three|four|many|broken|stained|open|closed|shattered|dark|rear|glass)\s+windows$/i;

const DISAMBIGUATOR_HINT_RE =
  /[()[\]:\-–—]|\b(?:pc|win(?:dows|\s*10|\s*11)?|xbox|store|preview|play|base|edition|version)\b/i;
const YEAR_EDITION_HINT_RE = /\b(?:year|anniversary|edition)\b/i;
const NON_ASCII_RE = /[^\x00-\x7f]/;

/**
 * Strips universal Microsoft Store / Xbox PC platform disambiguators
 * (e.g. "(PC)", "- PC", ": PC", "for PC", "(Windows)", "- Windows", "for Windows",
 * "Windows 10 Edition", "PC Edition", "Diablo IV PC", "Dead by Daylight Windows", "(Game Preview)")
 * without mutating core franchise titles, natural-language nouns ("PC Building Simulator",
 * "Build My PC", "Broken Windows"), or numbered sequels.
 */
export function stripStorefrontPlatformDisambiguators(title: string): string {
  if (!title) return '';
  let cur = title.replace(/\s+/g, ' ').trim();
  if (!DISAMBIGUATOR_HINT_RE.test(cur)) {
    return cur;
  }
  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = cur
      .replace(
        /\s*[\(\[]\s*(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\/|]\s*s|\s+play\s+anywhere)?|microsoft\s+store|game\s+preview|ea\s+play(?:\s+edition)?|base\s+game|(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version))\s*[\)\]]/gi,
        ''
      )
      .replace(
        /([\(\[][^\)\]]+?)\s*[:\-–—]\s*(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)(?:\s+(?:edition|version))?\s*([\)\]])/gi,
        '$1$2'
      )
      .replace(
        /(?:\s*[:\-–—]\s*|\s+for\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|microsoft\s+store|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\/|]\s*s)?)(?:\s+(?:edition|version))?\s*$/gi,
        ''
      )
      .replace(/(?:\s*[:\-–—]\s*)(?:ea\s+play(?:\s+edition)?|base\s+game)\s*$/gi, '')
      .replace(
        /(?:[:\-–—]\s*|\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version)\s*$/gi,
        ''
      )
      .replace(/(?:[:\-–—]\s*|\s+)game\s+preview\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (/\s+pc$/i.test(cur) && !NATURAL_PC_PREDECESSOR_RE.test(cur)) {
      const withoutTrailingPc = cur.replace(/\s+pc$/i, '').trim();
      if (withoutTrailingPc.length >= 2) {
        cur = withoutTrailingPc;
      }
    }

    if (/\s+windows(?:\s*10|\s*11)?$/i.test(cur) && !NATURAL_WINDOWS_PREDECESSOR_RE.test(cur)) {
      const withoutTrailingWin = cur.replace(/\s+windows(?:\s*10|\s*11)?$/i, '').trim();
      if (withoutTrailingWin.length >= 2) {
        cur = withoutTrailingWin;
      }
    }

    if (cur === prev) break;
  }
  return cur || title.trim();
}

const YEAR_NUMBER_WORDS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
]);

/**
 * Strips live-service season/year pass suffixes ("Year 1 Edition", "Year 5 Pass",
 * "20 Year Celebration", "40th Anniversary Edition", "(2009 Edition)") so embedded
 * numerals are never misclassified as franchise sequel numbers.
 */
export function stripYearEditionPhrases(title: string): string {
  if (!title) return '';
  if (!YEAR_EDITION_HINT_RE.test(title)) {
    return title.replace(/\s+/g, ' ').trim();
  }
  return title
    .replace(
      /(?:[:\-–—]\s*|\s+|\s*[\(\[]\s*)\bYear\s+(?:\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s+(?:Edition|Pass|Bundle|Pack|Upgrade)\b\s*[\)\]]?/gi,
      ' '
    )
    .replace(
      /(?:[:\-–—]\s*|\s+|\s*[\(\[]\s*)\b\d+(?:st|nd|rd|th)?[\s\-]*Year\s+(?:Anniversary|Celebration)(?:\s+Edition)?\b\s*[\)\]]?/gi,
      ' '
    )
    .replace(
      /(?:[:\-–—]\s*|\s+|\s*[\(\[]\s*)\b\d+(?:st|nd|rd|th)\s+Anniversary(?:\s+Edition)?\b\s*[\)\]]?/gi,
      ' '
    )
    .replace(/(?:\s*[\(\[]\s*(?:19|20)\d{2}\s+Edition\s*[\)\]]|(?:[:\-–—]\s*|\s+)\b(?:19|20)\d{2}\s+Edition\b)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_TITLE_MEMO_ENTRIES = 32768;
const normalizeTitleKeyMemo = new Map<string, string>();
const stripEditionSuffixMemo = new Map<string, string>();

/**
 * Normalizes title string by collapsing dotted acronyms, normalizing diacritics,
 * and stripping trademarks, storefront platform disambiguators, apostrophes/quotes, and punctuation.
 */
export function normalizeTitleKey(title: string): string {
  if (!title) return '';
  const cached = normalizeTitleKeyMemo.get(title);
  if (cached !== undefined) return cached;

  let working = stripStorefrontPlatformDisambiguators(title);
  if (NON_ASCII_RE.test(working)) {
    working = working
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’‘ʼ`"“”]/g, '')
      .replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ');
  } else {
    working = working.replace(/['`"]/g, '');
  }
  working = working.toLowerCase();
  if (working.includes('.')) {
    working = working.replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/g, (m) => m.replace(/\./g, ''));
  }
  const result = working
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalizeTitleKeyMemo.size >= MAX_TITLE_MEMO_ENTRIES) {
    const oldest = normalizeTitleKeyMemo.keys().next().value;
    if (oldest !== undefined) normalizeTitleKeyMemo.delete(oldest);
  }
  normalizeTitleKeyMemo.set(title, result);
  return result;
}

/**
 * Punctuation-, apostrophe-, hyphen-, and acronym-tolerant search matcher.
 * Handles cases like:
 * - "Alien Isolation" -> "Alien: Isolation"
 * - "deaths door" -> "Death's Door"
 * - "Stalker" -> "S.T.A.L.K.E.R. 2: Heart of Chornobyl"
 * - "spiderman" -> "Spider-Man"
 */
export function matchesLooseSearchQuery(
  target: string | undefined | null,
  query: string | undefined | null
): boolean {
  if (!query || !query.trim()) return true;
  if (!target) return false;

  const q = query.trim();
  if (target.toLowerCase().includes(q.toLowerCase())) {
    return true;
  }

  const normTarget = normalizeTitleKey(target);
  const normQuery = normalizeTitleKey(q);
  if (!normQuery) return true;
  if (!normTarget) return false;

  if (normTarget.includes(normQuery)) {
    return true;
  }

  const compactTarget = normTarget.replace(/\s+/g, '');
  const compactQuery = normQuery.replace(/\s+/g, '');
  if (compactQuery.length >= 3 && compactTarget.includes(compactQuery)) {
    return true;
  }

  const queryTokens = normQuery.split(' ').filter(Boolean);
  if (queryTokens.length > 1 && queryTokens.every((token) => normTarget.includes(token))) {
    return true;
  }

  return false;
}

/**
 * Strips edition suffixes (e.g. Definitive Edition, Deluxe, Gold, Complete Pack, Remastered).
 */
export function stripEditionSuffix(title: string): string {
  if (!title) return '';
  const cached = stripEditionSuffixMemo.get(title);
  if (cached !== undefined) return cached;

  let preStripped = stripYearEditionPhrases(stripStorefrontPlatformDisambiguators(title));
  if (NON_ASCII_RE.test(preStripped)) {
    preStripped = preStripped
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’‘ʼ`"“”]/g, '')
      .replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ');
  } else {
    preStripped = preStripped.replace(/['`"]/g, '');
  }
  preStripped = preStripped.toLowerCase();
  if (preStripped.includes('.')) {
    preStripped = preStripped.replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/g, (m) => m.replace(/\./g, ''));
  }

  const fallbackNormalized = preStripped
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stripped = preStripped
    .replace(
      /\b(?:vault|launch|founders?|royal|original|cross[\s\-]?gen|celebration|international)\s+(?:edition|bundle|pack|collection)\b.*$/i,
      ''
    )
    .replace(
      /\b(digital\s+)?(the\s+)?(standard|deluxe|gold|silver|platinum|diamond|premium|collector'?s|ultimate|complete|extended|special|limited|definitive|enhanced|anniversary|celebration|director'?s cut|final cut|classic and uncut|royal edition|original edition|drm[\s\-]?free(?:\s+edition)?|goty|game of the year|remastered|remake)\b.*$/i,
      ''
    )
    .replace(
      /-(standard|deluxe|gold|silver|platinum|diamond|premium|vault|launch|founders?|royal|original|cross-gen|collector'?s|ultimate|complete|extended|special|limited|definitive|enhanced|anniversary|celebration|directors-cut|final-cut|classic-and-uncut|drm-free|goty|game-of-the-year|remastered|remake)(-edition|-pack|-bundle|-collection)?$/i,
      ''
    )
    .replace(/-(edition|pack|bundle|collection)$/i, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const result = stripped || fallbackNormalized;

  if (stripEditionSuffixMemo.size >= MAX_TITLE_MEMO_ENTRIES) {
    const oldest = stripEditionSuffixMemo.keys().next().value;
    if (oldest !== undefined) stripEditionSuffixMemo.delete(oldest);
  }
  stripEditionSuffixMemo.set(title, result);
  return result;
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
    : normalizeTitleKey(stripYearEditionPhrases(input)).split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = i > 0 ? words[i - 1] : '';
    const next = i + 1 < words.length ? words[i + 1] : '';
    const next2 = i + 2 < words.length ? words[i + 2] : '';
    if (
      prev === 'year' &&
      YEAR_NUMBER_WORDS.has(word) &&
      (next === 'edition' || next === 'pass' || next === 'bundle' || next === 'pack' || next === 'upgrade')
    ) {
      continue;
    }
    if (next === 'year' && (next2 === 'celebration' || next2 === 'anniversary')) {
      continue;
    }
    if (NUMERIC_SEQUELS.has(word) || /^[2-9]$|^1[0-9]$|^20$/.test(word)) {
      return word;
    }
    if (ROMAN_TO_ARABIC[word]) {
      return ROMAN_TO_ARABIC[word];
    }
  }
  return null;
}

const SEQUEL_OTHER_VARIANTS = new Set(['new', 'vr']);
const SEQUEL_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'is',
  'edition',
  'game',
  'classic',
  'standard',
  'deluxe',
  'premium',
]);
const SEQUEL_SYMMETRIC_REMAKE_TOKENS = new Set(['remake', 'rebirth', 'reloaded']);
const SEQUEL_REMASTER_EDITIONS = new Set(['remastered', 'remaster']);
const sequelTokensMemo = new Map<string, string[]>();

function getNormalizedSequelTokens(str: string): string[] {
  const cached = sequelTokensMemo.get(str);
  if (cached !== undefined) return cached;
  const tokens = stripYearEditionPhrases(stripStorefrontPlatformDisambiguators(str))
    .toLowerCase()
    .replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ROMAN_TO_ARABIC[token] || token);
  if (sequelTokensMemo.size >= MAX_TITLE_MEMO_ENTRIES) {
    const oldest = sequelTokensMemo.keys().next().value;
    if (oldest !== undefined) sequelTokensMemo.delete(oldest);
  }
  sequelTokensMemo.set(str, tokens);
  return tokens;
}

/**
 * Validates whether two game titles represent different numbered sequels or distinct variants.
 * Returns TRUE if there is a sequel/variant mismatch (i.e. DO NOT MATCH).
 * Returns FALSE if they are compatible.
 */
export function isSequelMismatch(query: string, candidateName: string): boolean {
  if (!query || !candidateName || query === candidateName) return false;

  const qTokens = getNormalizedSequelTokens(query);
  const cTokens = getNormalizedSequelTokens(candidateName);

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
      const afterNum = hasNumeral
        .slice(numIdx + 1)
        .filter((t) => !SEQUEL_STOP_WORDS.has(t) && !EDITION_TOKENS.has(t) && !NUMERIC_SEQUELS.has(t));

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

  for (const variant of SEQUEL_OTHER_VARIANTS) {
    const qHas = qTokens.includes(variant);
    const cHas = cTokens.includes(variant);
    if ((!qHas && cHas) || (qHas && !cHas)) {
      return true;
    }
  }

  // Symmetric remake/rebirth/reloaded mismatch: distinct remakes never conflate with originals in either direction
  for (const rm of SEQUEL_SYMMETRIC_REMAKE_TOKENS) {
    const qHas = qTokens.includes(rm);
    const cHas = cTokens.includes(rm);
    if (qHas !== cHas) return true;
  }

  // Edition mismatch: prevent distinct remaster releases from adopting original game reviews
  for (const ed of SEQUEL_REMASTER_EDITIONS) {
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

/**
 * Splits multi-letter CamelCase compound words (e.g. "SimCity" -> "Sim City")
 * for alternate storefront search queries without breaking stylized tokens like "NieR" or "YoRHa".
 */
export function splitCamelCaseTitle(title: string): string {
  if (!title) return '';
  return title.replace(/([a-z]{2,})([A-Z][a-z]{2,})/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

/**
 * Algorithmically aligns compound word tokens across two normalized token arrays
 * when a pair of adjacent words in one array matches an exact concatenated token
 * in the counterpart array (e.g. ['sim', 'city'] <-> ['simcity'], ['disney', 'pixar'] <-> ['disneypixar']).
 */
export function alignCompoundWordTokens(words1: string[], words2: string[]): [string[], string[]] {
  if (words1.length === 0 || words2.length === 0) return [words1, words2];

  const mergeAgainstSet = (source: string[], targetSet: Set<string>): string[] => {
    const out: string[] = [];
    let i = 0;
    while (i < source.length) {
      if (i + 1 < source.length) {
        const pair = source[i] + source[i + 1];
        if (pair.length >= 4 && !/^\d+$/.test(pair) && targetSet.has(pair)) {
          out.push(pair);
          i += 2;
          continue;
        }
      }
      out.push(source[i]);
      i += 1;
    }
    return out;
  };

  const aligned1 = mergeAgainstSet(words1, new Set(words2));
  const aligned2 = mergeAgainstSet(words2, new Set(aligned1));
  return [aligned1, aligned2];
}

const MAX_ALLOWED_RELEASE_YEAR = new Date().getFullYear() + 10;

/**
 * Validates and normalizes storefront release dates, stripping placeholder strings
 * ('TBA', 'TBD', 'Unknown') and storefront sentinel dates (e.g. '2799-12-31',
 * '9998-12-30', '0001-01-01', '2099-12-31').
 */
export function sanitizeStoreReleaseDate(rawDate?: string | null): string | undefined {
  if (!rawDate || typeof rawDate !== 'string') return undefined;
  const trimmed = rawDate.trim();
  if (!trimmed) return undefined;
  if (/^(?:tba|tbd|n\/a|unknown|none|null|undefined)$/i.test(trimmed)) {
    return undefined;
  }
  if (/^coming\s+soon$/i.test(trimmed)) {
    return 'Coming Soon';
  }

  const maxAllowedYear = MAX_ALLOWED_RELEASE_YEAR;
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    if (!Number.isFinite(yr) || yr < 1975 || yr > maxAllowedYear) {
      return undefined;
    }
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const yearMatches = trimmed.match(/\b(\d{4})\b/g);
  if (yearMatches && yearMatches.length > 0) {
    for (const ym of yearMatches) {
      const yr = parseInt(ym, 10);
      if (!Number.isFinite(yr) || yr < 1975 || yr > maxAllowedYear) {
        return undefined;
      }
    }
    return trimmed;
  }

  return undefined;
}

/**
 * Detects Microsoft Store / Xbox Live CDN image URLs so richer Steam 2x SHA1-hashed
 * library assets can upgrade them while preventing MS Store re-syncs from clobbering Steam assets.
 */
export function isMicrosoftStoreCdnUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  return /(?:s-microsoft\.com|xboxlive\.com|compass-ssl\.xbox\.com)/i.test(url);
}

/**
 * Detects authoritative Steam CDN image URLs (steamstatic / akamaihd).
 */
export function isSteamCdnAssetUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  return /(?:steamstatic\.com|steamcdn-a\.akamaihd\.net|steamcommunity\.com)/i.test(url);
}
