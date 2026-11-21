import {
  ANCHOR_SUFFIX_CONFLICT_TOKENS,
  PURE_EDITION_WORDS,
  SPECIAL_CHAR_TRANSLITERATION,
  TITLE_MATCH_STOP_WORDS,
  cleanTitleForMatching,
  hasExplicitClassicOrOriginalEditionTag,
  isTitleCompatible,
} from '../../common/titleMatching';
import {
  NUMERIC_SEQUELS,
  ROMAN_TO_ARABIC,
  decodeTitleHtmlEntities,
  extractParentheticalReleaseYear,
  extractSequelIdentifier,
  extractTrailingDelimitedReleaseYear,
  isSequelMismatch,
  isYearEditionToken,
  stripPackagingEditionPhrases,
  stripTrademarkSymbols,
  stripTrailingDelimitedReleaseYear,
  stripYearEditionPhrases,
} from '../../common/titleUtils';

export {
  ANCHOR_SUFFIX_CONFLICT_TOKENS,
  PURE_EDITION_WORDS,
  SPECIAL_CHAR_TRANSLITERATION,
  TITLE_MATCH_STOP_WORDS,
  cleanTitleForMatching,
  hasExplicitClassicOrOriginalEditionTag,
  isTitleCompatible,
};

export const METACRITIC_STOP_WORDS = TITLE_MATCH_STOP_WORDS;
export const DOTTED_ACRONYM_TEST_RE = /\b(?:[a-z]\.){2,}[a-z]?\.?/i;

export function stripTrailingReleaseYearFromSlug(slug: string): string {
  const match = slug.match(/^(.*)-((?:19|20)\d{2})$/);
  if (!match) return slug;
  const yr = parseInt(match[2], 10);
  const maxYear = new Date().getFullYear() + 1;
  return yr >= 1975 && yr <= maxYear ? match[1] : slug;
}

/**
 * Universal slug generator for Metacritic URLs.
 * Correctly strips punctuation, apostrophes, and noise while preserving edition specifics.
 */
export function toCanonicalMetacriticSlug(title: string): string {
  if (!title) return '';
  return cleanTitleForMatching(title)
    .replace(/\s*\((?:[^)]*,\s*)?((?:19|20)\d{2})[^)]*\)/g, ' $1')
    .replace(/\s*\([a-z0-9\s,]+\)/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function stripMetacriticEditionSlug(slug: string): string {
  if (!slug) return '';
  let current = slug;
  for (let i = 0; i < 3; i++) {
    const next = current
      .replace(
        /-(?:ea-play-edition|war-chest|planetary-pack|ultimate-evil-edition|trials-of-fear-edition|valhalla-edition|juggernaut-edition|maximum-edition|spacers-choice-edition|20-year-celebration|(?:19|20)\d{2}-edition)$/i,
        ''
      )
      .replace(
        /-(the-)?(standard|deluxe|gold|silver|platinum|diamond|premium|collectors|collector|ultimate|complete|special|limited|definitive|enhanced|extended|enchanted|anniversary|directors-cut|goty|game-of-the-year|redux|emperor|gourmet|celebration|20-year-celebration|spacers-choice|classic-and-uncut|original|launcher|unlimited|re-elected|reelected|resnarkled|arpg|trilogy)(-edition|-pack|-bundle|-collection|-cut)?$/i,
        ''
      )
      .replace(/-(edition|pack|bundle|collection)$/i, '');
    if (next === current || next.length < 2) break;
    current = next;
  }
  return current;
}

/**
 * Helper to check whether a candidate slug is compatible with or an alias of the storefront anchor slug.
 */
export function isAnchorMatch(candidateSlug: string, anchorSlug: string): boolean {
  const cSlug = candidateSlug.toLowerCase().trim();
  const aSlug = anchorSlug.toLowerCase().trim();
  if (cSlug === aSlug) return true;
  const aNorm = stripTrailingReleaseYearFromSlug(aSlug).replace(/^the-/, '');
  const cNorm = stripTrailingReleaseYearFromSlug(cSlug).replace(/^the-/, '');
  if (aNorm === cNorm) return true;
  const romanToArabic = (s: string) =>
    s
      .replace(/-ii-/g, '-2-')
      .replace(/-ii$/, '-2')
      .replace(/-iii-/g, '-3-')
      .replace(/-iii$/, '-3')
      .replace(/-iv-/g, '-4-')
      .replace(/-iv$/, '-4')
      .replace(/-v-/g, '-5-')
      .replace(/-v$/, '-5');
  return romanToArabic(aNorm) === romanToArabic(cNorm);
}

/**
 * Helper to determine if a candidate slug conflicts with the ground truth storefront anchor slug.
 */
export function isCandidateConflictingWithAnchor(candidateSlug: string, anchorSlug: string): boolean {
  return !isAnchorMatch(candidateSlug, anchorSlug);
}

function tokenizeForAnchorPrefix(str: string): string[] {
  const parenYr = extractParentheticalReleaseYear(str);
  const parenYrStr = parenYr !== null ? String(parenYr) : null;
  const trailingYr = extractTrailingDelimitedReleaseYear(str);
  const trailingYrStr = trailingYr !== null ? String(trailingYr) : null;
  const preStripped = stripPackagingEditionPhrases(
    stripYearEditionPhrases(stripTrailingDelimitedReleaseYear(str))
  )
    .replace(/\s*\([^)]*\)/g, ' ')
    .trim();
  return cleanTitleForMatching(preStripped)
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 0 &&
        w !== parenYrStr &&
        w !== trailingYrStr &&
        !isYearEditionToken(str, w)
    )
    .map((w) => ROMAN_TO_ARABIC[w] || w);
}

/**
 * Validates whether a storefront or Wikidata ground-truth Metacritic anchor slug is semantically
 * compatible with the game title.
 * Normalizes episodic pilot suffixes (e.g. 'the-walking-dead-episode-1---a-new-day' -> 'the-walking-dead'),
 * permits verified ground-truth remastered-to-base/collection anchors and canonical Metacritic subtitle
 * expansions when franchise + sequel match, while blocking cross-sequel or cross-franchise anchor bleed.
 */
export function isAnchorSlugCompatible(title: string, rawAnchorSlug: string): boolean {
  if (!rawAnchorSlug) return false;
  const cleanAnchor = rawAnchorSlug
    .toLowerCase()
    .trim()
    .replace(/-episode-(?:1|one)\b.*$/i, '');
  const anchorWords = cleanAnchor.replace(/-/g, ' ');
  const sequelMismatch = isSequelMismatch(title, anchorWords);

  if (!sequelMismatch && isTitleCompatible(title, anchorWords)) return true;

  if (!sequelMismatch && /\s[-–—]\s/.test(title)) {
    const [mainPart, ...rest] = title.split(/\s+[-–—]\s+/);
    const subPart = rest.join(' ');
    if (
      mainPart.trim().length >= 4 &&
      !/\b(season|episode|part|chapter|book|act|testing|beta|deathmatch)\b/i.test(subPart) &&
      isTitleCompatible(mainPart.trim(), anchorWords)
    ) {
      return true;
    }
  }

  // Ground-truth anchor remastered relaxation ONLY (never in heuristic isTitleCompatible):
  const hasRemasterQuery = /\bremastered?\b/i.test(title);
  const hasHardRemakeConflict =
    /\b(?:remake|rebirth|reloaded)\b/i.test(title) ||
    /\b(?:remake|rebirth|reloaded)\b/i.test(anchorWords);
  if (hasRemasterQuery && !hasHardRemakeConflict) {
    const titleWithoutRemaster = stripPackagingEditionPhrases(
      stripTrailingDelimitedReleaseYear(title)
    )
      .replace(/\bremastered?\b/gi, ' ')
      .replace(/\s*[:\-–—]\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (titleWithoutRemaster) {
      const anchorCandidates = [anchorWords];
      const anchorWithoutCollection = anchorWords
        .replace(/\b(?:the\s+)?(?:collection|trilogy|anthology)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (anchorWithoutCollection && anchorWithoutCollection !== anchorWords) {
        anchorCandidates.push(anchorWithoutCollection);
      }
      for (const candidateWords of anchorCandidates) {
        if (
          !isSequelMismatch(titleWithoutRemaster, candidateWords) &&
          isTitleCompatible(titleWithoutRemaster, candidateWords)
        ) {
          return true;
        }
      }
    }
  }

  // Ground-truth anchor Metacritic canonical subtitle suffix expansion ONLY:
  if (!sequelMismatch) {
    const hasInstallmentNumeral = extractSequelIdentifier(title) !== null;
    const cleanedClause = stripTrademarkSymbols(decodeTitleHtmlEntities(title)).trim();
    const endsWithClausePunctuation = /[!?]$/.test(cleanedClause);
    if (hasInstallmentNumeral || endsWithClausePunctuation) {
      const titleTokens = tokenizeForAnchorPrefix(title);
      const anchorTokens = tokenizeForAnchorPrefix(anchorWords);
      const titleSubstantive = titleTokens.filter((t) => !PURE_EDITION_WORDS.has(t));
      if (
        titleSubstantive.length >= 2 &&
        anchorTokens.length > titleSubstantive.length &&
        titleSubstantive.every((t, idx) => anchorTokens[idx] === t)
      ) {
        const extraSuffix = anchorTokens.slice(titleSubstantive.length);
        const hasConflict = extraSuffix.some(
          (t) =>
            ANCHOR_SUFFIX_CONFLICT_TOKENS.has(t) ||
            NUMERIC_SEQUELS.has(t) ||
            /^\d+$/.test(t)
        );
        if (!hasConflict) {
          return true;
        }
      }
    }
  }

  return false;
}
