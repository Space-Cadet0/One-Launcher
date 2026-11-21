/**
 * Pure game-title compatibility and similarity matching utilities.
 *
 * Extracted into Layer 0 (`services-foundation`) to provide a single canonical source of truth
 * for `isTitleCompatible` (shared by Metacritic, OpenCritic, Wikidata, and IGDB cover matching —
 * eliminating the `igdbCoverService -> metacriticResolver` reverse import) and
 * `computeTitleSimilarity` (unifying `steamMatcher` and `entityResolver`).
 */

import {
  EDITION_TOKENS,
  NUMERIC_SEQUELS,
  ROMAN_TO_ARABIC,
  alignCompoundWordTokens,
  decodeTitleHtmlEntities,
  extractParentheticalReleaseYear,
  extractSequelIdentifier,
  extractTrailingDelimitedReleaseYear,
  foldLatinLigaturesAndDiacritics,
  isIntermediateNumeralSubtitleMatch,
  isSequelMismatch,
  isYearEditionToken,
  normalizeTitleKey,
  stripEditionSuffix,
  stripPackagingEditionPhrases,
  stripPlatformAndDistributionNoise,
  stripTrademarkSymbols,
  stripYearEditionPhrases,
} from './titleUtils';

export const SPECIAL_CHAR_TRANSLITERATION: Readonly<Record<string, string>> = {
  'Δ': 'delta',
  'δ': 'delta',
  'α': 'alpha',
  'β': 'beta',
  'γ': 'gamma',
  'λ': 'lambda',
  'ω': 'omega',
  'Ω': 'omega',
  'π': 'pi',
  'μ': 'mu',
  'σ': 'sigma',
  'Σ': 'sigma',
  'θ': 'theta',
  '½': 'half',
};

const SPECIAL_CHAR_TRANSLITERATION_RE = /[ΔδαβγλωΩπμσΣθ½]/g;
const DOTTED_ACRONYM_RE = /\b(?:[a-z]\.){2,}[a-z]?\.?/gi;

export const TITLE_MATCH_STOP_WORDS = new Set<string>([
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
  'till',
  'into',
  'from',
  'standard',
  'deluxe',
  'gold',
  'silver',
  'platinum',
  'diamond',
  'premium',
  'collectors',
  'collector',
  'ultimate',
  'complete',
  'special',
  'limited',
  'definitive',
  'enhanced',
  'anniversary',
  'edition',
  'remastered',
  'remaster',
  'remake',
  'directors',
  'cut',
  'legacy',
  'classic',
  'redux',
  'extended',
  'enchanted',
  'emperor',
  'gourmet',
  'celebration',
  'spacers',
  'choice',
  'uncut',
  'year',
  'original',
  'digital',
  'gog',
  'steam',
  'epic',
  'launcher',
  'unlimited',
  'reelected',
  'resnarkled',
  'arpg',
  'trilogy',
]);

export const PURE_EDITION_WORDS = new Set<string>([
  'edition',
  'deluxe',
  'gold',
  'silver',
  'platinum',
  'diamond',
  'premium',
  'collectors',
  'collector',
  'ultimate',
  'goty',
  'remastered',
  'remaster',
  'remake',
  'directors',
  'cut',
  'definitive',
  'enhanced',
  'anniversary',
  'special',
  'limited',
  'standard',
  'classic',
  'game',
  'games',
  'role',
  'playing',
  'rpg',
  'arpg',
  'post',
  'nuclear',
  'pack',
  'bundle',
  'collection',
  'trilogy',
  'complete',
  'redux',
  'extended',
  'enchanted',
  'emperor',
  'gourmet',
  'celebration',
  'spacers',
  'choice',
  'uncut',
  'year',
  'original',
  'ecto',
  'lightspeed',
  'landmark',
  'super',
  'turbo',
  'championship',
  'unrated',
  'anthology',
  'telltale',
  'series',
  'sid',
  'meiers',
  'meier',
  '20',
  '10',
  '25',
  '30',
  'digital',
  'gog',
  'steam',
  'epic',
  'launcher',
  'unlimited',
  'reelected',
  'resnarkled',
]);

export const ANCHOR_SUFFIX_CONFLICT_TOKENS = new Set<string>([
  'season',
  'episode',
  'part',
  'chapter',
  'dlc',
  'expansion',
  'soundtrack',
  'ost',
  'demo',
  'beta',
  'playtest',
  'deathmatch',
  'multiplayer',
  'online',
  'vr',
  'remake',
  'rebirth',
  'reloaded',
  'tactics',
  'champions',
  'arena',
  'origins',
  'prequel',
  'prologue',
]);

const SUBTITLE_SEGMENT_STOP_WORDS = new Set<string>([
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

const DISJOINT_STOP_WORDS = new Set<string>([
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
  'with',
  'from',
  'by',
]);

/**
 * Transliterates Greek/math symbols, folds Latin ligatures/diacritics, collapses dotted acronyms,
 * and strips trademarks and quotes using a single precompiled regex pass.
 */
export function cleanTitleForMatching(input: string): string {
  if (!input) return '';
  const clean = stripTrademarkSymbols(decodeTitleHtmlEntities(input)).replace(
    SPECIAL_CHAR_TRANSLITERATION_RE,
    (ch) => ` ${SPECIAL_CHAR_TRANSLITERATION[ch] ?? ch} `
  );
  return foldLatinLigaturesAndDiacritics(clean)
    .toLowerCase()
    .replace(DOTTED_ACRONYM_RE, (m) => m.replace(/\./g, ''))
    .replace(/\bre-elected\b/gi, 'reelected')
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/(\d),(\d)/g, '$1$2');
}

/**
 * Structurally detects whether a title explicitly denotes a Classic, Original, or Gold edition
 * without matching core title nouns where "Original" precedes a non-edition word.
 */
export function hasExplicitClassicOrOriginalEditionTag(text: string): boolean {
  if (!text) return false;
  if (/\((?:[^)]*\b)?(?:classic|original|gold)(?:\b[^)]*)?\)/i.test(text)) {
    return true;
  }
  if (
    /\b(?:classic|original|gold)\s+(?:edition|version|release|complete|redux|uncut|cut|pack|saga|classic)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (/(?:[:\-–—]|\bthe)\s*(?:classic|original|gold)\s*$/i.test(text)) {
    return true;
  }
  if (/\b(?:classic|gold)\b/i.test(text) && !/\bclassics\b/i.test(text)) {
    return true;
  }
  return false;
}

function tokenizeNormalizedForCompatibility(input: string): string[] {
  return cleanTitleForMatching(input)
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TITLE_MATCH_STOP_WORDS.has(w))
    .map((w) => ROMAN_TO_ARABIC[w] || w);
}

/**
 * Rigorously validates title compatibility between a user library title and a candidate
 * storefront/critic title:
 * 1. Checks sequel/variant/reboot mismatches via `isSequelMismatch`.
 * 2. Prevents explicit Classic / Original / Gold editions from matching modern remasters/remakes.
 * 3. Fails closed when either non-empty side yields zero alphanumeric tokens unless raw trimmed
 *    strings are equal (fixes CJK/punctuation fail-open bug).
 * 4. Prevents distinctive subtitle omissions across all colon/dash/exclamation segments.
 * 5. Enforces bidirectional substantive token conservation while preserving bare 4-digit title
 *    numbers (`Metro 2033`, `Cyberpunk 2077`, `Battlefield 2042`, `SimCity 2000`, `Anno 1800`)
 *    and tolerating parenthetical, trailing-dash, and year-edition disambiguation years
 *    (e.g. `"Oblivion Game of the Year Edition – 2009"`).
 */
export function isTitleCompatible(rawQueryTitle: string, rawCanonicalName: string): boolean {
  if (!rawCanonicalName) return true;
  if (!rawQueryTitle || !rawQueryTitle.trim()) return false;
  if (isSequelMismatch(rawQueryTitle, rawCanonicalName)) return false;

  const queryIsExplicitClassicOrOriginal = hasExplicitClassicOrOriginalEditionTag(rawQueryTitle);
  if (
    queryIsExplicitClassicOrOriginal &&
    /\b(enhanced|remastered|remaster|remake|reloaded|redux|definitive)\b/i.test(rawCanonicalName)
  ) {
    return false;
  }

  const qParenYr = extractParentheticalReleaseYear(rawQueryTitle);
  const qParenYrStr = qParenYr !== null ? String(qParenYr) : null;
  const qDelimYr = extractTrailingDelimitedReleaseYear(rawQueryTitle);
  const qDelimYrStr = qDelimYr !== null ? String(qDelimYr) : null;

  const cParenYr = extractParentheticalReleaseYear(rawCanonicalName);
  const cParenYrStr = cParenYr !== null ? String(cParenYr) : null;
  const cDelimYr = extractTrailingDelimitedReleaseYear(rawCanonicalName);
  const cDelimYrStr = cDelimYr !== null ? String(cDelimYr) : null;

  const queryTitle = stripPackagingEditionPhrases(stripYearEditionPhrases(rawQueryTitle));
  const canonicalName = stripPackagingEditionPhrases(stripYearEditionPhrases(rawCanonicalName));

  const qTokens = tokenizeNormalizedForCompatibility(queryTitle);
  const cTokens = tokenizeNormalizedForCompatibility(canonicalName);

  // Fail closed when either side produces zero tokens (e.g. CJK-only or punctuation-only titles),
  // succeeding ONLY if the normalized or raw trimmed titles match identically.
  if (qTokens.length === 0 || cTokens.length === 0) {
    const qNormKey = normalizeTitleKey(queryTitle);
    const cNormKey = normalizeTitleKey(canonicalName);
    if (qNormKey && cNormKey) {
      return qNormKey === cNormKey;
    }
    const qTrimmed = rawQueryTitle.trim().toLowerCase();
    const cTrimmed = rawCanonicalName.trim().toLowerCase();
    return Boolean(qTrimmed) && qTrimmed === cTrimmed;
  }

  if (!qTokens.some((t) => cTokens.includes(t))) {
    return false;
  }

  // 1. Prevent distinctive subtitle omissions across every colon/dash/exclamation segment
  if (
    queryTitle.includes(':') ||
    /\s[-–—]\s/.test(queryTitle) ||
    /!\s+\S/.test(queryTitle)
  ) {
    const segments = queryTitle.split(/\s*[:!]\s*|\s+[-–—]\s+/).slice(1);
    const candWords = cleanTitleForMatching(canonicalName)
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ROMAN_TO_ARABIC[w] || w);

    for (const seg of segments) {
      const segWithoutParens = seg.replace(/\s*\([^)]*\)/g, '').trim();
      const rawSubTokens = cleanTitleForMatching(segWithoutParens)
        .replace(/[^a-z0-9]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0 && !SUBTITLE_SEGMENT_STOP_WORDS.has(w))
        .map((w) => ROMAN_TO_ARABIC[w] || w);

      if (rawSubTokens.length >= 1 && !rawSubTokens.some((t) => candWords.includes(t))) {
        const isPureEdition = rawSubTokens.every(
          (t) =>
            PURE_EDITION_WORDS.has(t) ||
            t === qParenYrStr ||
            t === qDelimYrStr ||
            isYearEditionToken(rawQueryTitle, t)
        );
        if (!isPureEdition) {
          return false;
        }
      }
    }
  }

  // 2. Bidirectional substantive token conservation
  const queryWithoutParens = queryTitle
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\b(mega\s+drive\s*(?:&|and)?\s*)/gi, '')
    .trim();
  const qSubstantive = tokenizeNormalizedForCompatibility(queryWithoutParens).filter(
    (t) =>
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      t !== qParenYrStr &&
      t !== qDelimYrStr &&
      !isYearEditionToken(rawQueryTitle, t)
  );
  const qExtra = qSubstantive.filter((t) => !cTokens.includes(t));
  if (qExtra.length >= 1) {
    return false;
  }

  const qBaseStr =
    queryTitle.includes(':') || /\s[-–—]\s/.test(queryTitle) || /!\s+\S/.test(queryTitle)
      ? queryTitle.split(/[:\-–—!]/)[0].trim()
      : queryTitle.replace(/\s*\([^)]*\)/g, '').trim();
  const qBase = tokenizeNormalizedForCompatibility(qBaseStr).filter(
    (t) =>
      !PURE_EDITION_WORDS.has(t) &&
      t !== qParenYrStr &&
      t !== qDelimYrStr &&
      !isYearEditionToken(rawQueryTitle, t)
  );
  const hasEditionSuffix =
    queryTitle !== rawQueryTitle ||
    stripEditionSuffix(rawQueryTitle).trim().toLowerCase() !== normalizeTitleKey(rawQueryTitle) ||
    /\b(definitive|complete|goty|game of the year|director'?s cut|ultimate|enhanced|anniversary|remastered|collection|anthology|gold|deluxe|special|royal|legendary|edition)\b/i.test(
      rawQueryTitle
    );

  const cExtra = cTokens.filter(
    (t) =>
      !qTokens.includes(t) &&
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      t !== cParenYrStr &&
      t !== cDelimYrStr &&
      !isYearEditionToken(rawCanonicalName, t) &&
      !(t === 'plus' && rawQueryTitle.includes('+'))
  );

  const hasNumberedEditionSubtitleReplacement =
    hasEditionSuffix &&
    extractSequelIdentifier(rawQueryTitle) !== null &&
    qBase.length >= 2 &&
    NUMERIC_SEQUELS.has(qBase[qBase.length - 1]) &&
    (rawQueryTitle.includes(':') || /\s[-–—]\s/.test(rawQueryTitle)) &&
    cExtra.length >= 2 &&
    !cExtra.some(
      (t) =>
        ANCHOR_SUFFIX_CONFLICT_TOKENS.has(t) ||
        NUMERIC_SEQUELS.has(t) ||
        /^\d+$/.test(t)
    );

  if (
    hasEditionSuffix &&
    qBase.length >= 1 &&
    qTokens.every((t) => cTokens.includes(t)) &&
    qBase.every((t, idx) => cTokens[idx] === t) &&
    (cExtra.length === 0 || hasNumberedEditionSubtitleReplacement)
  ) {
    return true;
  }

  const candidateHasSubtitle =
    canonicalName.includes(':') ||
    /\s[-–—]\s/.test(canonicalName) ||
    /!\s+\S/.test(canonicalName);

  const cBase = candidateHasSubtitle
    ? canonicalName.split(/[:\-–—!]/)[0].trim()
    : canonicalName;
  const cBaseTokens = tokenizeNormalizedForCompatibility(cBase);

  const cBaseExtra = cBaseTokens.filter(
    (t) =>
      !qTokens.includes(t) &&
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      t !== cParenYrStr &&
      t !== cDelimYrStr &&
      !isYearEditionToken(rawCanonicalName, t) &&
      !(t === 'plus' && rawQueryTitle.includes('+'))
  );
  if (cBaseExtra.length >= 1) {
    return false;
  }

  const qBaseTokens = qBase.filter((t) => !NUMERIC_SEQUELS.has(t));
  if (!candidateHasSubtitle) {
    if (cExtra.length >= 1) {
      return false;
    }
  } else if ((qBaseTokens.length >= 2 || hasEditionSuffix) && cExtra.length >= 1) {
    return false;
  }

  return true;
}

export interface ComputeTitleSimilarityOptions {
  /**
   * When true, only applies mutually exclusive disjoint-token rejection if either title contains
   * a subtitle delimiter (`:`, `-`, `–`, `—`), matching `entityResolver`'s historical behavior.
   * Defaults to `false` (strict rejection across all pairs, matching `steamMatcher`).
   */
  requireDelimiterForDisjointCheck?: boolean;
  /**
   * When true, awards `0.92` when both titles collapse to the same non-empty `stripEditionSuffix`
   * key after sequel/disjoint verification. Defaults to `true`.
   */
  checkEditionStrippedEquality?: boolean;
}

function normalizeForSimilarity(input: string): string {
  return foldLatinLigaturesAndDiacritics(stripPlatformAndDistributionNoise(input))
    .toLowerCase()
    .replace(/['’‘"“”]/g, '')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/[™®©℠•·𝄞★☆–—−‑]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes canonical token similarity in `[0, 1]` between two game titles with strict sequel
 * verification, intermediate-numeral subtitle matching, compound-word alignment, disjoint
 * franchise rejection, and intelligent edition variant matching.
 */
export function computeTitleSimilarity(
  source: string,
  candidate: string,
  options?: ComputeTitleSimilarityOptions
): number {
  if (!source || !candidate) return 0;

  const cleanSource = stripYearEditionPhrases(source);
  const cleanCandidate = stripYearEditionPhrases(candidate);
  const s1 = normalizeForSimilarity(cleanSource);
  const s2 = normalizeForSimilarity(cleanCandidate);

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const rawWords1 = s1.split(' ').filter(Boolean);
  const rawWords2 = s2.split(' ').filter(Boolean);

  const seq1 = extractSequelIdentifier(rawWords1);
  const seq2 = extractSequelIdentifier(rawWords2);
  const isIntermediateSubtitleBypass =
    seq1 !== seq2 && isIntermediateNumeralSubtitleMatch(cleanSource, cleanCandidate);
  if (seq1 !== seq2 && !isIntermediateSubtitleBypass) {
    return 0;
  }

  if (isSequelMismatch(source, candidate)) {
    return 0;
  }

  const mappedWords1Raw = rawWords1.map((w) => ROMAN_TO_ARABIC[w] || w);
  const mappedWords2Raw = rawWords2.map((w) => ROMAN_TO_ARABIC[w] || w);
  let mappedWords1 = seq1 !== null ? mappedWords1Raw : rawWords1;
  let mappedWords2 = seq2 !== null ? mappedWords2Raw : rawWords2;

  if (isIntermediateSubtitleBypass) {
    const set1 = new Set(mappedWords1Raw);
    const set2 = new Set(mappedWords2Raw);
    const extraIn1 = seq1 !== null && !set2.has(seq1) ? seq1 : null;
    const extraIn2 = seq2 !== null && !set1.has(seq2) ? seq2 : null;
    if (extraIn1) {
      let removed = false;
      mappedWords1 = mappedWords1Raw.filter((w) => {
        if (!removed && w === extraIn1) {
          removed = true;
          return false;
        }
        return true;
      });
    } else if (extraIn2) {
      let removed = false;
      mappedWords2 = mappedWords2Raw.filter((w) => {
        if (!removed && w === extraIn2) {
          removed = true;
          return false;
        }
        return true;
      });
    }
  }

  const [words1, words2] = alignCompoundWordTokens(mappedWords1, mappedWords2);

  if (words1.join(' ') === words2.join(' ')) {
    return 1.0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  const shouldCheckDisjoint =
    !options?.requireDelimiterForDisjointCheck ||
    /[:\-–—]/.test(cleanSource) ||
    /[:\-–—]/.test(cleanCandidate);

  if (shouldCheckDisjoint) {
    const substantive1 = words1.filter(
      (w) => !/^\d+$/.test(w) && !EDITION_TOKENS.has(w) && !DISJOINT_STOP_WORDS.has(w)
    );
    const substantive2 = words2.filter(
      (w) => !/^\d+$/.test(w) && !EDITION_TOKENS.has(w) && !DISJOINT_STOP_WORDS.has(w)
    );
    const disjoint1 = substantive1.filter((w) => !tokens2.has(w));
    const disjoint2 = substantive2.filter((w) => !tokens1.has(w));
    if (disjoint1.length >= 1 && disjoint2.length >= 1) {
      return 0;
    }
  }

  if (options?.checkEditionStrippedEquality !== false) {
    const stripped1 = stripEditionSuffix(cleanSource);
    const stripped2 = stripEditionSuffix(cleanCandidate);
    if (stripped1 && stripped1.length >= 2 && stripped1 === stripped2) {
      return 0.92;
    }
  }

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  if (union === 0) return 0;
  const jaccard = intersection / union;

  if (words1.length === 1 && !tokens2.has(words1[0])) {
    return 0;
  }
  if (words2.length === 1 && !tokens1.has(words2[0])) {
    return 0;
  }

  const [shorterWords, longerWords] =
    words1.length <= words2.length ? [words1, words2] : [words2, words1];
  const shorterSet = new Set(shorterWords);
  const longerSet = new Set(longerWords);

  let allShorterInLonger = true;
  for (const w of shorterWords) {
    if (!longerSet.has(w)) {
      allShorterInLonger = false;
      break;
    }
  }

  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    let hasEditionToken = false;
    for (const w of longerWords) {
      if (!shorterSet.has(w)) {
        if (EDITION_TOKENS.has(w)) {
          hasEditionToken = true;
        } else if (w !== 'the' && w !== 'of' && w !== 'a' && w !== 'an') {
          onlyEditionTokensRemaining = false;
          break;
        }
      }
    }
    if (onlyEditionTokensRemaining && (hasEditionToken || shorterWords.length >= 2)) {
      return 0.92;
    }
  }

  const joined1 = words1.join(' ');
  const joined2 = words2.join(' ');
  if (
    seq1 !== null &&
    seq1 === seq2 &&
    words1.length >= 2 &&
    (joined1.includes(joined2) || joined2.includes(joined1))
  ) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}
