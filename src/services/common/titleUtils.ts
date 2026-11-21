/**
 * Shared Canonical Title Normalization and Edition Utilities
 * Single source of truth for Storefront Matcher (steamMatcher), Review Engine (criticUtils),
 * and Scraper Services.
 */

import { decodeHtmlEntities } from './htmlEntities';
import { LruMap } from './lruMap';

export const CURRENT_YEAR = new Date().getFullYear();
const MAX_DISAMBIGUATION_RELEASE_YEAR = CURRENT_YEAR + 1;
const MAX_ALLOWED_RELEASE_YEAR = CURRENT_YEAR + 10;

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
const YEAR_EDITION_HINT_RE =
  /\b(?:year|anniversary|edition|celebration|goty)\b|\s[-–—−]\s+(?:19|20)\d{2}\s*$/i;
const NON_ASCII_RE = /[^\x00-\x7f]/;

const LATIN_LIGATURE_MAP: Record<string, string> = {
  Ø: 'O',
  ø: 'o',
  ẞ: 'SS',
  ß: 'ss',
  Æ: 'AE',
  æ: 'ae',
  Œ: 'OE',
  œ: 'oe',
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ð: 'D',
  ð: 'd',
  Þ: 'TH',
  þ: 'th',
};

const LATIN_LIGATURE_RE = /[ØøẞßÆæŒœŁłĐđÐðÞþ]/g;

/**
 * Decodes common HTML entities (&trade;, &reg;, &copy;, &rsquo;, &ndash;, &mdash;, &amp;, etc.)
 * found in raw storefront catalog titles before symbol stripping and normalization.
 */
export function decodeTitleHtmlEntities(input: string): string {
  if (!input || !input.includes('&')) return input || '';
  return decodeHtmlEntities(input, { preserveInvalidNumeric: true });
}

/**
 * Strips trademark/registration symbols ([™®©℠℗] and (TM)/(R)/(C)) BEFORE Unicode normalization
 * or apostrophe stripping so NFKC never expands '™' -> 'TM' and "Tony Hawk™'s" -> "Tony Hawk's"
 * while preserving word separation when glued between alphanumerics ("Watch Dogs®2" -> "Watch Dogs 2").
 */
export function stripTrademarkSymbols(input: string): string {
  if (!input) return '';
  return input
    .replace(/([\p{L}\p{N}])(?:[™®©℠℗]+|\(\s*(?:tm|r|c)\s*\))(?=[\p{L}\p{N}])/giu, '$1 ')
    .replace(/(?:[™®©℠℗]+|\(\s*(?:tm|r|c)\s*\))/gi, '');
}

/**
 * Folds non-decomposing Latin ligatures/letters (ø, ß, æ, œ, ł, đ, ð, þ) and strips NFD
 * combining diacritical marks without invoking NFKC/NFKD compatibility expansion.
 */
export function foldLatinLigaturesAndDiacritics(input: string): string {
  if (!input || !NON_ASCII_RE.test(input)) return input || '';
  return input
    .replace(LATIN_LIGATURE_RE, (ch) => LATIN_LIGATURE_MAP[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

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

const EDITION_PRECEDED_YEAR_RE =
  /\b(edition|anniversary|celebration|goty|game\s+of\s+the\s+year)\s*[:\-–—−]\s*((?:19|20)\d{2})\b/gi;
const TRAILING_DASH_RELEASE_YEAR_RE = /^(.+?)\s+[-–—−]\s+((?:19|20)\d{2})\s*$/;
const TRAILING_PAREN_RELEASE_YEAR_RE =
  /^(.+?)\s*([\(\[])\s*(?:([^)\]]*?)\s*[,\s-]\s*)?((?:19|20)\d{2})\s*([\)\]])\s*$/;

function isValidDisambiguationReleaseYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1975 && year <= MAX_DISAMBIGUATION_RELEASE_YEAR;
}

function hasSubstantiveTitlePrefix(prefix: string): boolean {
  return prefix.replace(/[^a-z0-9]/gi, '').length >= 2;
}

function extractTrailingDashReleaseYear(title: string): number | null {
  if (!title || typeof title !== 'string') return null;
  const trimmed = title.trim();
  const match = trimmed.match(TRAILING_DASH_RELEASE_YEAR_RE);
  if (!match || !hasSubstantiveTitlePrefix(match[1])) return null;
  const yr = parseInt(match[2], 10);
  return isValidDisambiguationReleaseYear(yr) ? yr : null;
}

/**
 * Extracts a trailing explicitly-delimited 4-digit release year suffix:
 * - Spaced dash/en-dash/em-dash/minus: `"Title - 2009"`, `"Title – 2009"`, `"Title — 2009"`
 * - Trailing parenthesized/bracketed: `"Title (2009)"`, `"Title [2023]"`, `"Title (Classic, 2005)"`
 *
 * Strictly returns `null` for bare un-delimited 4-digit numbers in titles (`"Metro 2033"`,
 * `"Cyberpunk 2077"`, `"Battlefield 2042"`, `"Anno 1800"`, `"Warhammer 40,000"`, `"1942"`,
 * `"SimCity 2000"`) and years outside `[1975, CURRENT_YEAR + 1]`.
 */
export function extractTrailingDelimitedReleaseYear(title: string): number | null {
  if (!title || typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed) return null;

  const dashYr = extractTrailingDashReleaseYear(trimmed);
  if (dashYr !== null) {
    return dashYr;
  }

  const parenMatch = trimmed.match(TRAILING_PAREN_RELEASE_YEAR_RE);
  if (parenMatch && hasSubstantiveTitlePrefix(parenMatch[1])) {
    const yr = parseInt(parenMatch[4], 10);
    if (isValidDisambiguationReleaseYear(yr)) {
      return yr;
    }
  }

  return null;
}

/**
 * Strips a trailing explicitly-delimited 4-digit release year (`"Title - 2009"`, `"Title – 2009"`,
 * `"Title — 2009"`, `"Title (2009)"`, `"Title [2023]"`) when the year is in `[1975, CURRENT_YEAR + 1]`
 * and a substantive title prefix remains.
 *
 * Never strips bare title/sequel/future numbers (`"Metro 2033"`, `"Cyberpunk 2077"`,
 * `"Battlefield 2042"`, `"Anno 1800"`, `"Warhammer 40,000"`, `"1942"`).
 */
export function stripTrailingDelimitedReleaseYear(title: string): string {
  if (!title || typeof title !== 'string') return '';
  const trimmed = title.trim();
  if (!trimmed) return '';

  const dashMatch = trimmed.match(TRAILING_DASH_RELEASE_YEAR_RE);
  if (dashMatch && hasSubstantiveTitlePrefix(dashMatch[1])) {
    const yr = parseInt(dashMatch[2], 10);
    if (isValidDisambiguationReleaseYear(yr)) {
      return dashMatch[1].trim();
    }
  }

  const parenMatch = trimmed.match(TRAILING_PAREN_RELEASE_YEAR_RE);
  if (parenMatch && hasSubstantiveTitlePrefix(parenMatch[1])) {
    const yr = parseInt(parenMatch[4], 10);
    if (isValidDisambiguationReleaseYear(yr)) {
      const prefix = parenMatch[1].trim();
      const qualifier = (parenMatch[3] || '').trim();
      if (qualifier) {
        return `${prefix} ${parenMatch[2]}${qualifier}${parenMatch[5]}`;
      }
      return prefix;
    }
  }

  return trimmed;
}

/**
 * Strips live-service season/year pass suffixes ("Year 1 Edition", "Year 5 Pass",
 * "20 Year Celebration", "40th Anniversary Edition", "(2009 Edition)",
 * "Game of the Year Edition – 2009", "GOTY - 2009", and trailing spaced-dash disambiguation
 * release years "Title – 2009") so embedded numerals are never misclassified as franchise
 * sequel numbers. Preserves parenthetical reboot years ("DOOM (2016)") and bare title numbers
 * ("Metro 2033", "Cyberpunk 2077", "Battlefield 2042", "Anno 1800", "Warhammer 40,000", "1942").
 */
export function stripYearEditionPhrases(title: string): string {
  if (!title) return '';
  if (!YEAR_EDITION_HINT_RE.test(title)) {
    return title.replace(/\s+/g, ' ').trim();
  }
  let cur = title
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
    .replace(EDITION_PRECEDED_YEAR_RE, (full, edWord: string, yrStr: string) => {
      const yr = parseInt(yrStr, 10);
      return isValidDisambiguationReleaseYear(yr) ? edWord : full;
    })
    .replace(/\s+/g, ' ')
    .trim();

  const trailingDashMatch = cur.match(TRAILING_DASH_RELEASE_YEAR_RE);
  if (trailingDashMatch && hasSubstantiveTitlePrefix(trailingDashMatch[1])) {
    const yr = parseInt(trailingDashMatch[2], 10);
    if (isValidDisambiguationReleaseYear(yr)) {
      cur = trailingDashMatch[1].trim();
    }
  }

  return cur;
}

const PAREN_RELEASE_YEAR_RE = /[\(\[]\s*(?:[^)\]]*?[,\s-])?((?:19|20)\d{2})\s*[\)\]]/g;

/**
 * Extracts a parenthesized or bracketed 4-digit disambiguation release year
 * (e.g. "DOOM (2016)" -> 2016, "STAR WARS Battlefront II (Classic, 2005)" -> 2005,
 * "Resident Evil 4 [2023]" -> 2023), preferring the last valid match in [1975, CURRENT_YEAR + 1].
 * Strictly returns null for bare unparenthesized 4-digit title numbers ("Metro 2033 Redux",
 * "Cyberpunk 2077", "Battlefield 2042", "SimCity 2000") and year-edition suffixes ("2026 Edition").
 */
export function extractParentheticalReleaseYear(title: string): number | null {
  if (!title || typeof title !== 'string') return null;
  let found: number | null = null;
  for (const m of title.matchAll(PAREN_RELEASE_YEAR_RE)) {
    const yr = parseInt(m[1], 10);
    if (isValidDisambiguationReleaseYear(yr)) {
      found = yr;
    }
  }
  return found;
}

const PACKAGING_EDITION_PHRASE_RE =
  /\b(?:ea\s+play\s+edition|war\s+chest|planetary\s+pack|ultimate\s+evil\s+edition|trials\s+of\s+fear\s+edition|valhalla\s+edition|juggernaut\s+edition|maximum\s+edition|spacer['’]?s\s+choice\s+edition|20\s+year\s+celebration|(?:19|20)\d{2}\s+edition)\b/gi;
const TRAILING_LAUNCHER_SUFFIX_RE = /\s*[-–—]\s*launcher\s*$/i;

/**
 * Strips exact multi-word SKU/packaging edition phrases and trailing store launcher suffixes
 * without polluting single-word EDITION_TOKENS with content words ("war", "revolution", "valhalla", "evil", etc.).
 * Returns the original title unchanged when no packaging phrase or launcher suffix matches.
 */
export function stripPackagingEditionPhrases(title: string): string {
  if (!title || typeof title !== 'string') return '';
  const workingInput = title.includes('&') ? decodeTitleHtmlEntities(title) : title;
  let changed = false;
  let cur = workingInput.replace(PACKAGING_EDITION_PHRASE_RE, () => {
    changed = true;
    return ' ';
  });

  if (TRAILING_LAUNCHER_SUFFIX_RE.test(cur)) {
    const withoutLauncher = cur.replace(TRAILING_LAUNCHER_SUFFIX_RE, '').trim();
    if (withoutLauncher.replace(/[^a-z0-9]/gi, '').length >= 1) {
      cur = withoutLauncher;
      changed = true;
    }
  }

  if (!changed) {
    return title;
  }

  cur = cur
    .replace(/[\(\[]\s*[\)\]]/g, ' ')
    .replace(/\s*[:\-–—]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cur.replace(/[^a-z0-9]/gi, '').length >= 2 ? cur : title.trim();
}

/**
 * Returns true ONLY when the given numeric token participates in an explicit year-edition,
 * anniversary/season-pass phrase, edition-preceded year (`Edition – 2009`, `GOTY - 2009`),
 * or trailing spaced-dash disambiguation year (`Title – 2009`) in `title`, never for bare title numbers
 * ("2033" in "Metro 2033 Redux", "2077" in "Cyberpunk 2077: Ultimate Edition", "2000" in "SimCity 2000 Special Edition",
 * "1800" in "Anno 1800", or standalone "1942").
 */
export function isYearEditionToken(title: string, token: string): boolean {
  if (!title || !token) return false;
  const cleanToken = token.trim().toLowerCase();
  if (!/^\d{1,4}(?:st|nd|rd|th)?$/.test(cleanToken)) return false;

  const escaped = cleanToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^(?:19|20)\d{2}$/.test(cleanToken)) {
    if (
      new RegExp(
        `\\b${escaped}[\\s\\-]+(?:edition|anniversary(?:[\\s\\-]+edition)?|celebration(?:[\\s\\-]+edition)?)\\b`,
        'i'
      ).test(title)
    ) {
      return true;
    }
    const yr = parseInt(cleanToken, 10);
    if (!isValidDisambiguationReleaseYear(yr)) {
      return false;
    }
    if (
      new RegExp(
        `\\b(?:edition|anniversary|celebration|goty|game\\s+of\\s+the\\s+year)\\s*[:\\-–—−]\\s*${escaped}\\b`,
        'i'
      ).test(title)
    ) {
      return true;
    }
    return extractTrailingDashReleaseYear(title) === yr;
  }

  const numericOnly = cleanToken.replace(/(?:st|nd|rd|th)$/i, '');
  return (
    new RegExp(`\\byear[\\s\\-]+${numericOnly}[\\s\\-]+(?:edition|pass|bundle|pack|upgrade)\\b`, 'i').test(title) ||
    new RegExp(
      `\\b${numericOnly}(?:st|nd|rd|th)?[\\s\\-]*year[\\s\\-]+(?:anniversary|celebration)(?:[\\s\\-]+edition)?\\b`,
      'i'
    ).test(title) ||
    new RegExp(`\\b${numericOnly}(?:st|nd|rd|th)[\\s\\-]+anniversary(?:[\\s\\-]+edition)?\\b`, 'i').test(title)
  );
}

const MAX_TITLE_MEMO_ENTRIES = 32768;
const normalizeTitleKeyMemo = new LruMap<string, string>(MAX_TITLE_MEMO_ENTRIES);
const stripEditionSuffixMemo = new LruMap<string, string>(MAX_TITLE_MEMO_ENTRIES);

/**
 * Normalizes title string by collapsing dotted acronyms, normalizing diacritics,
 * and stripping trademarks, storefront platform disambiguators, apostrophes/quotes, and punctuation.
 */
export function normalizeTitleKey(title: string): string {
  if (!title) return '';
  const cached = normalizeTitleKeyMemo.get(title);
  if (cached !== undefined) return cached;

  let working = stripPlatformAndDistributionNoise(title);
  if (NON_ASCII_RE.test(working)) {
    working = foldLatinLigaturesAndDiacritics(working)
      .replace(/['’‘ʼ`´"“”]/g, '')
      .replace(/[•·𝄞★☆–—−‑]/g, ' ');
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

  let preStripped = stripYearEditionPhrases(stripPlatformAndDistributionNoise(title));
  if (NON_ASCII_RE.test(preStripped)) {
    preStripped = foldLatinLigaturesAndDiacritics(preStripped)
      .replace(/['’‘ʼ`´"“”]/g, '')
      .replace(/[•·𝄞★☆–—−‑]/g, ' ');
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

export const ARABIC_TO_ROMAN: Record<string, string> = {
  '2': 'II',
  '3': 'III',
  '4': 'IV',
  '5': 'V',
  '6': 'VI',
  '7': 'VII',
  '8': 'VIII',
  '9': 'IX',
  '10': 'X',
  '11': 'XI',
  '12': 'XII',
  '13': 'XIII',
  '14': 'XIV',
  '15': 'XV',
  '16': 'XVI',
  '17': 'XVII',
  '18': 'XVIII',
  '19': 'XIX',
  '20': 'XX',
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
const COMPILATION_CLAUSE_STOP_WORDS = new Set([
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
]);

function tokenizeCompilationClause(str: string): string[] {
  const preCleaned = foldLatinLigaturesAndDiacritics(
    stripYearEditionPhrases(stripPlatformAndDistributionNoise(str))
  );
  const baseTokens = preCleaned
    .toLowerCase()
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/[•·𝄞★☆–—−‑]/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ROMAN_TO_ARABIC[token] || token);
  const substantive = baseTokens.filter((token) => !COMPILATION_CLAUSE_STOP_WORDS.has(token));
  return substantive.length > 0 ? substantive : baseTokens;
}

const sequelTokensMemo = new LruMap<string, string[]>(MAX_TITLE_MEMO_ENTRIES);

function getNormalizedSequelTokens(str: string): string[] {
  const cached = sequelTokensMemo.get(str);
  if (cached !== undefined) return cached;
  const preCleaned = foldLatinLigaturesAndDiacritics(
    stripYearEditionPhrases(stripPlatformAndDistributionNoise(str))
  );
  const tokens = preCleaned
    .toLowerCase()
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/[•·𝄞★☆–—−‑]/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ROMAN_TO_ARABIC[token] || token);
  sequelTokensMemo.set(str, tokens);
  return tokens;
}

const WORD_TO_ARABIC: Record<string, string> = {
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

const GENERIC_SUBTITLE_TOKENS = new Set<string>([
  'episode',
  'season',
  'chapter',
  'online',
  'classic',
  'origins',
  'legends',
  'chronicles',
  'reloaded',
  'reborn',
  'revolution',
  'evolution',
  'survival',
  'multiplayer',
  'deathmatch',
  'campaign',
  'mission',
  'missions',
  'deluxe',
  'ultimate',
  'remake',
  'remaster',
  'remastered',
  'enhanced',
  'definitive',
  'edition',
  'special',
  'complete',
  'anthology',
  'collection',
  'legendary',
  'heroic',
  'legacy',
  'royal',
  'annual',
  'pass',
  'chest',
  'battle',
  'expansion',
  'set',
  'soundtrack',
  'soundtracks',
  'ost',
  'original',
  'role',
  'playing',
  'rpg',
  'post',
  'nuclear',
  'action',
  'adventure',
  'strategy',
  'tactical',
  'simulator',
  'simulation',
  'pack',
  'bundle',
  'kit',
  'starter',
  'base',
  'game',
  'gold',
  'platinum',
  'anniversary',
  'goty',
  'upgrade',
  'bonus',
  'content',
  'free',
  'trial',
  'download',
  'map',
  'maps',
  'dlc',
  'demo',
  'beta',
  'playtest',
  'artbook',
  'skin',
  'skins',
  'cosmetic',
  'cosmetics',
  'weapon',
  'weapons',
  'character',
  'characters',
  'costume',
  'costumes',
  'extra',
  'extras',
  'addon',
  'addons',
  'digital',
  'goodies',
  'wallpaper',
  'wallpapers',
  'avatar',
  'avatars',
  'currency',
  'coins',
  'credits',
  'points',
  'voucher',
]);

const GENERIC_SUBTITLE_PHRASE_PATTERNS: readonly RegExp[] = [
  /^(?:a\s+)?post[\s-]+nuclear\s+role[\s-]+playing(?:\s+game)?$/i,
  /\b(?:role[\s-]+playing\s+game|season\s+pass|expansion\s+(?:pass|set|pack)|battle\s+chest|war\s+chest|original\s+soundtrack|starter\s+pack|upgrade\s+pack|art\s+book|bonus\s+content|free\s+trial)\b/i,
];

function toCanonicalNumericToken(token: string): string | null {
  if (/^\d+$/.test(token)) return token;
  if (ROMAN_TO_ARABIC[token]) return ROMAN_TO_ARABIC[token];
  if (WORD_TO_ARABIC[token]) return WORD_TO_ARABIC[token];
  if (token === 'i' || token === 'one') return '1';
  if (token === 'zero') return '0';
  return null;
}

function toSequelNumeralToken(token: string): string | null {
  if (NUMERIC_SEQUELS.has(token)) return token;
  if (ROMAN_TO_ARABIC[token]) return ROMAN_TO_ARABIC[token];
  if (WORD_TO_ARABIC[token]) return WORD_TO_ARABIC[token];
  return null;
}

function hasExplicitSubtitleDelimiter(rawTitle: string): boolean {
  return rawTitle.includes(':') || /\s[-–—]\s/.test(rawTitle);
}

function cleanAndTokenizeForSubtitleNumeral(title: string): string[] {
  let cleaned = stripPlatformAndDistributionNoise(title);
  cleaned = stripYearEditionPhrases(cleaned);
  cleaned = stripPackagingEditionPhrases(cleaned);
  cleaned = cleaned.replace(PAREN_RELEASE_YEAR_RE, (full, yrStr: string) => {
    const yr = parseInt(yrStr, 10);
    return isValidDisambiguationReleaseYear(yr) ? ' ' : full;
  });
  cleaned = foldLatinLigaturesAndDiacritics(cleaned)
    .toLowerCase()
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/[•·𝄞★☆–—−‑]/g, ' ');
  if (cleaned.includes('.')) {
    cleaned = cleaned.replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/g, (m) => m.replace(/\./g, ''));
  }
  return cleaned
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractSubstantiveSubtitleTokens(tokens: string[]): string[] {
  return tokens.filter(
    (t) =>
      !SEQUEL_STOP_WORDS.has(t) &&
      !EDITION_TOKENS.has(t) &&
      toCanonicalNumericToken(t) === null
  );
}

/**
 * Pure bidirectional predicate verifying whether two titles differ ONLY by a single intermediate
 * sequel numeral (2..20 / II..XX / two..ten, never 1/I/one) sitting strictly between an identical
 * leading franchise prefix and an identical distinctive subtitle:
 *   "<Franchise> <N>: <Distinctive Subtitle>" <-> "<Franchise>: <Distinctive Subtitle>".
 * Enforces exact bidirectional ordered substantive token equality (never one-directional subset inclusion),
 * rejects generic SKU/genre/tagline subtitle phrases and all-generic multi-word subtitles,
 * and requires at least one distinctive non-generic subtitle token.
 */
export function isIntermediateNumeralSubtitleMatch(titleA: string, titleB: string): boolean {
  if (!titleA || !titleB) return false;

  const tokensA = cleanAndTokenizeForSubtitleNumeral(titleA);
  const tokensB = cleanAndTokenizeForSubtitleNumeral(titleB);
  if (tokensA.length < 3 && tokensB.length < 3) return false;

  const seqCountsA = new Map<string, number>();
  const seqCountsB = new Map<string, number>();
  for (const t of tokensA) {
    const seq = toSequelNumeralToken(t);
    if (seq !== null) seqCountsA.set(seq, (seqCountsA.get(seq) || 0) + 1);
  }
  for (const t of tokensB) {
    const seq = toSequelNumeralToken(t);
    if (seq !== null) seqCountsB.set(seq, (seqCountsB.get(seq) || 0) + 1);
  }

  const allSeqKeys = new Set<string>([...seqCountsA.keys(), ...seqCountsB.keys()]);
  const mismatched: string[] = [];
  for (const k of allSeqKeys) {
    if ((seqCountsA.get(k) || 0) !== (seqCountsB.get(k) || 0)) {
      mismatched.push(k);
    }
  }
  if (mismatched.length !== 1) return false;

  const targetNum = mismatched[0];
  const countA = seqCountsA.get(targetNum) || 0;
  const countB = seqCountsB.get(targetNum) || 0;
  if (!((countA === 1 && countB === 0) || (countB === 1 && countA === 0))) {
    return false;
  }

  const numbered = countA === 1 ? tokensA : tokensB;
  const unnumbered = countA === 1 ? tokensB : tokensA;

  const numIdx = numbered.findIndex((t) => toSequelNumeralToken(t) === targetNum);
  if (numIdx <= 0 || numIdx >= numbered.length - 1) return false;

  // Verify no other mismatched numeric token exists anywhere in the pair
  const numberedOtherNums: string[] = [];
  for (let i = 0; i < numbered.length; i++) {
    if (i === numIdx) continue;
    const canon = toCanonicalNumericToken(numbered[i]);
    if (canon !== null) numberedOtherNums.push(canon);
  }
  const unnumberedNums: string[] = [];
  for (let i = 0; i < unnumbered.length; i++) {
    const canon = toCanonicalNumericToken(unnumbered[i]);
    if (canon !== null) unnumberedNums.push(canon);
  }
  if (numberedOtherNums.length !== unnumberedNums.length) return false;
  for (let i = 0; i < numberedOtherNums.length; i++) {
    if (numberedOtherNums[i] !== unnumberedNums[i]) return false;
  }

  const prefixN = numbered.slice(0, numIdx);
  const subN = numbered.slice(numIdx + 1);
  const substantivePrefix = extractSubstantiveSubtitleTokens(prefixN);
  const substantiveSub = extractSubstantiveSubtitleTokens(subN);
  if (substantivePrefix.length < 1 || substantiveSub.length < 1) return false;

  const substantiveUnnumbered = extractSubstantiveSubtitleTokens(unnumbered);
  if (substantiveUnnumbered.length !== substantivePrefix.length + substantiveSub.length) {
    return false;
  }
  for (let i = 0; i < substantivePrefix.length; i++) {
    if (substantiveUnnumbered[i] !== substantivePrefix[i]) return false;
  }
  for (let j = 0; j < substantiveSub.length; j++) {
    if (substantiveUnnumbered[substantivePrefix.length + j] !== substantiveSub[j]) return false;
  }

  const rawSubPhrase = subN.join(' ');
  if (GENERIC_SUBTITLE_PHRASE_PATTERNS.some((pattern) => pattern.test(rawSubPhrase))) {
    return false;
  }

  if (substantiveSub.length >= 2) {
    return substantiveSub.some((t) => t.length >= 3 && !GENERIC_SUBTITLE_TOKENS.has(t));
  }

  return (
    hasExplicitSubtitleDelimiter(titleA) &&
    hasExplicitSubtitleDelimiter(titleB) &&
    substantiveSub[0].length >= 6 &&
    !GENERIC_SUBTITLE_TOKENS.has(substantiveSub[0])
  );
}

const INTERMEDIATE_SUBTITLE_NUMERAL_RE =
  /^(.+?)\s+((?:[2-9]|1[0-9]|20)|(?:xx|xix|xviii|xvii|xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii)|(?:two|three|four|five|six|seven|eight|nine|ten))(\s*:\s*|\s+[-–—]\s+)(.+)$/i;

/**
 * Removes an intermediate sequel numeral from "<Franchise> <2..20|II..XX>: <Distinctive Subtitle>"
 * or "<Franchise> <2..20|II..XX> - <Distinctive Subtitle>" when the title satisfies the exact
 * intermediate-numeral-with-distinctive-subtitle structure, returning null otherwise.
 */
export function stripIntermediateSubtitleNumeral(title: string): string | null {
  if (!title || typeof title !== 'string') return null;
  const cleaned = stripPlatformAndDistributionNoise(title).trim();
  if (!cleaned) return null;

  const match = cleaned.match(INTERMEDIATE_SUBTITLE_NUMERAL_RE);
  if (!match) return null;

  const prefix = match[1].trim();
  const sep = match[3];
  const subtitle = match[4].trim();
  if (!prefix || !subtitle) return null;

  const normalizedSep = sep.includes(':') ? ': ' : sep;
  const candidate = `${prefix}${normalizedSep}${subtitle}`;
  return isIntermediateNumeralSubtitleMatch(cleaned, candidate) ? candidate : null;
}

/**
 * Converts an intermediate sequel numeral between Roman and Arabic forms when the title
 * matches `<Franchise> <2..20|II..XX>: <Distinctive Subtitle>` (e.g. `"The Witcher II: Assassins of Kings"`
 * <-> `"The Witcher 2: Assassins of Kings"`), returning `null` otherwise.
 */
export function convertIntermediateSubtitleNumeral(title: string): string | null {
  if (!title || typeof title !== 'string') return null;
  const cleaned = stripPlatformAndDistributionNoise(title).trim();
  if (!cleaned) return null;

  const match = cleaned.match(INTERMEDIATE_SUBTITLE_NUMERAL_RE);
  if (!match) return null;

  const prefix = match[1].trim();
  const rawNum = match[2].trim();
  const sep = match[3];
  const subtitle = match[4].trim();
  if (!prefix || !rawNum || !subtitle) return null;

  const normalizedSep = sep.includes(':') ? ': ' : sep;
  const strippedCandidate = `${prefix}${normalizedSep}${subtitle}`;
  if (!isIntermediateNumeralSubtitleMatch(cleaned, strippedCandidate)) {
    return null;
  }

  const lowerNum = rawNum.toLowerCase();
  let converted: string | null = null;
  if (ROMAN_TO_ARABIC[lowerNum]) {
    converted = ROMAN_TO_ARABIC[lowerNum];
  } else if (ARABIC_TO_ROMAN[lowerNum]) {
    converted = ARABIC_TO_ROMAN[lowerNum];
  } else if (WORD_TO_ARABIC[lowerNum]) {
    converted = WORD_TO_ARABIC[lowerNum];
  }

  if (!converted) return null;
  return `${prefix} ${converted}${normalizedSep}${subtitle}`;
}

/**
 * Validates whether two game titles represent different numbered sequels or distinct variants.
 * Returns TRUE if there is a sequel/variant mismatch (i.e. DO NOT MATCH).
 * Returns FALSE if they are compatible.
 */
export function isSequelMismatch(query: string, candidateName: string): boolean {
  if (!query || !candidateName || query === candidateName) return false;

  const qTrailYr = extractTrailingDelimitedReleaseYear(query);
  const cTrailYr = extractTrailingDelimitedReleaseYear(candidateName);
  if (qTrailYr !== null && cTrailYr !== null && Math.abs(qTrailYr - cTrailYr) >= 2) {
    return true;
  }

  const qTokens = getNormalizedSequelTokens(query);
  const cTokens = getNormalizedSequelTokens(candidateName);

  for (const num of NUMERIC_SEQUELS) {
    const qHas = qTokens.includes(num);
    const cHas = cTokens.includes(num);
    if ((!qHas && cHas) || (qHas && !cHas)) {
      // If the number is part of an anniversary/celebration (e.g. '20 Year Celebration'), ignore
      if (num === '20' && (qTokens.includes('year') || cTokens.includes('year'))) continue;

      if (isIntermediateNumeralSubtitleMatch(query, candidateName)) {
        continue; // Permitted intermediate-numeral subtitle match (e.g. Deus Ex 2: Invisible War vs Deus Ex: Invisible War)
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

  // Compilation/bundle mismatch: prevent dual game compilations (e.g. 'Title A + Title A II')
  // from erroneously resolving to a single component game (e.g. 'Title A' or 'Title A II'),
  // while permitting URL-slugged compilation names ('title a title a ii') that contain every
  // constituent clause as a non-overlapping ordered token subsequence.
  if (
    /\s\+\s/.test(query) &&
    !candidateName.toLowerCase().includes('+') &&
    !candidateName.toLowerCase().includes('plus')
  ) {
    const clauses = query
      .split(/\s\+\s/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (clauses.length >= 2) {
      const candidateClauseTokens = tokenizeCompilationClause(candidateName);
      let candCursor = 0;
      for (const clause of clauses) {
        const clauseTokens = tokenizeCompilationClause(clause);
        if (clauseTokens.length === 0) {
          return true;
        }
        for (const token of clauseTokens) {
          let foundIdx = -1;
          for (let i = candCursor; i < candidateClauseTokens.length; i++) {
            if (candidateClauseTokens[i] === token) {
              foundIdx = i;
              break;
            }
          }
          if (foundIdx === -1) {
            return true;
          }
          candCursor = foundIdx + 1;
        }
      }
    }
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

export function stripStorefrontDistributionSuffixes(input: string): string {
  if (!input) return '';
  return input
    .replace(
      /\s*[\(\[]\s*(?:amazon\s+prime(?:\s+gaming)?|prime\s+gaming|ea\s+play(?:\s+pro)?|ubisoft\s+connect|xbox\s+game\s+pass)(?:\s+(?:edition|version))?\s*[\)\]]/gi,
      ''
    )
    .replace(
      /(?:[:\-–—]\s*|\s+)(?:amazon\s+prime(?:\s+gaming)?|prime\s+gaming|ea\s+play(?:\s+pro)?|ubisoft\s+connect|xbox\s+game\s+pass)(?:\s+(?:edition|version))?\s*$/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripPlatformAndDistributionNoise(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  let cur = stripTrademarkSymbols(decodeTitleHtmlEntities(rawTitle));
  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = stripStorefrontDistributionSuffixes(stripStorefrontPlatformDisambiguators(cur));
    if (cur === prev) break;
  }
  return cur;
}

function sanitizeSearchQueryClause(
  rawTitle: string,
  options?: { stripEditions?: boolean; splitHyphens?: boolean }
): string {
  if (!rawTitle || typeof rawTitle !== 'string') return '';

  let working = stripPlatformAndDistributionNoise(rawTitle);
  if (options?.stripEditions) {
    working = stripYearEditionPhrases(working);
  }

  // Unwrap pure 4-digit release years "(2016)" -> "2016", preserve "(Remastered)"/"(Remake)" on Pass 1,
  // and strip noisy multi-token or platform parens/brackets such as "(Classic, 2005)" or "(PC)".
  working = working.replace(/[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]/g, ' $1 ');
  if (!options?.stripEditions) {
    working = working.replace(/[\(\[]\s*(remastered|remaster|remake)\s*[\)\]]/gi, ' $1 ');
  }
  working = working.replace(/[\(\[][^\)\]]*[\)\]]/g, ' ');

  working = foldLatinLigaturesAndDiacritics(working);
  if (working.includes('.')) {
    working = working.replace(/\b(?:[A-Za-z]\.){2,}[A-Za-z]?\.?/g, (m) => m.replace(/\./g, ''));
  }

  working = working.replace(/['’‘ʼ`´"“”]/g, (ch, offset: number, str: string) => {
    if ("'’‘ʼ`´".includes(ch)) {
      const prev = offset > 0 ? str[offset - 1] : '';
      const next = offset + 1 < str.length ? str[offset + 1] : '';
      if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
        return "'";
      }
    }
    return '';
  });

  if (options?.stripEditions) {
    const beforeEditionStrip = working;
    const editionStripped = working
      .replace(
        /\b(?:vault|launch|founders?|royal|original|cross[\s\-]?gen|celebration|international)\s+(?:edition|bundle|pack|collection)\b.*$/i,
        ''
      )
      .replace(
        /\b(?:digital\s+)?(?:the\s+)?(?:standard|deluxe|gold|silver|platinum|diamond|premium|collector'?s|ultimate|complete|extended|special|limited|definitive|enhanced|enchanted|anniversary|celebration|director'?s\s+cut|final\s+cut|classic\s+and\s+uncut|royal\s+edition|original\s+edition|drm[\s\-]?free(?:\s+edition)?|goty|game\s+of\s+the\s+year|remastered|remaster|remake)\b.*$/i,
        ''
      )
      .replace(/[\s\-]+(?:edition|pack|bundle|collection)\s*$/i, '')
      .trim();
    working =
      editionStripped.replace(/[^A-Za-z0-9]/g, '').length >= 2
        ? editionStripped
        : beforeEditionStrip;
  }

  if (options?.splitHyphens) {
    working = working.replace(/[^A-Za-z0-9']+/g, ' ');
  } else {
    working = working
      .replace(/[\u2010\u2011]/g, '-')
      .replace(/[^A-Za-z0-9'-]+/g, ' ');
  }

  return working
    .replace(/(^|\s)[-']+|[-']+(\s|$)/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produces a clean, human- and search-API-friendly query string from a raw storefront title:
 * decodes HTML entities, strips [™®©℠℗] & (TM)/(R)/(C), strips storefront/platform/subscription
 * disambiguators, unwraps pure release years "(2016)" -> "2016", strips noisy parentheticals,
 * folds Latin ligatures/diacritics, and preserves word-internal ASCII apostrophes and hyphens.
 */
export function sanitizeTitleForSearchQuery(rawTitle: string): string {
  return sanitizeSearchQueryClause(rawTitle, { stripEditions: false, splitHyphens: false });
}

/**
 * Canonical title normalizer for storefront & critic review search queries across all resolvers.
 * Decodes HTML entities, folds Latin ligatures/diacritics, strips trademarks and storefront
 * platform/distribution suffixes ("- Amazon Prime", "PC Edition", "Game Preview", "Windows Edition"),
 * preserves sequel numbers and edition tags unless `stripEditions: true` is requested.
 */
export function normalizeTitleForStoreSearch(
  rawTitle: string,
  options?: { stripEditions?: boolean }
): string {
  return sanitizeSearchQueryClause(rawTitle, {
    stripEditions: Boolean(options?.stripEditions),
    splitHyphens: true,
  });
}

/**
 * Generates up to 3 deduplicated token-array search passes for HowLongToBeat `/api/search/site`:
 * - Pass 1: Platform-cleaned, year-unwrapped, preserving edition words and ASCII word-internal hyphens.
 * - Pass 2: Edition-stripped and hyphen-split.
 * - Pass 3 (when applicable): Intermediate subtitle numeral stripped (`"Deus Ex 2: Invisible War"` -> `"Deus Ex: Invisible War"`)
 *   and Roman↔Arabic swapped intermediate numeral (`"The Witcher II: Assassins of Kings"` -> `"The Witcher 2: Assassins of Kings"`).
 * - Fallback pass: Pre-colon / pre-dash base franchise clause (when >= 2 alphanumeric characters).
 */
export function buildHltbSearchTermPasses(rawTitle: string): string[][] {
  if (!rawTitle || typeof rawTitle !== 'string') return [];

  const passes: string[][] = [];
  const seen = new Set<string>();
  const addPass = (clause: string): void => {
    if (!clause) return;
    const tokens = clause.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const key = tokens.map((t) => t.toLowerCase()).join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    passes.push(tokens);
  };

  addPass(sanitizeTitleForSearchQuery(rawTitle));
  addPass(sanitizeSearchQueryClause(rawTitle, { stripEditions: true, splitHyphens: true }));

  const preCleaned = stripPlatformAndDistributionNoise(rawTitle);
  const intermediateStripped = stripIntermediateSubtitleNumeral(preCleaned);
  if (intermediateStripped) {
    addPass(
      sanitizeSearchQueryClause(intermediateStripped, {
        stripEditions: true,
        splitHyphens: true,
      })
    );
  }

  const intermediateSwapped = convertIntermediateSubtitleNumeral(preCleaned);
  if (intermediateSwapped) {
    addPass(
      sanitizeSearchQueryClause(intermediateSwapped, {
        stripEditions: true,
        splitHyphens: true,
      })
    );
  }

  const delimiterMatch = preCleaned.match(/^(.*?)(?::|\s+[\-–—−]\s+)/);
  if (delimiterMatch && delimiterMatch[1]) {
    const baseClause = sanitizeSearchQueryClause(delimiterMatch[1], {
      stripEditions: true,
      splitHyphens: true,
    });
    if (baseClause.replace(/[^A-Za-z0-9]/g, '').length >= 2) {
      addPass(baseClause);
    }
  }

  return passes.slice(0, 3);
}
