import { CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../contracts/network';
import { calculateTier, isSequelMismatch, stripEditionSuffix } from './criticUtils';
import {
  ROMAN_TO_ARABIC,
  NUMERIC_SEQUELS,
  decodeTitleHtmlEntities,
  extractParentheticalReleaseYear,
  extractSequelIdentifier,
  foldLatinLigaturesAndDiacritics,
  isYearEditionToken,
  normalizeTitleKey,
  stripIntermediateSubtitleNumeral,
  stripPackagingEditionPhrases,
  stripTrademarkSymbols,
  stripYearEditionPhrases,
} from '../common/titleUtils';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';

export interface MetacriticBundle {
  critic: CriticScoreData | null;
  user: CriticScoreData | null;
  offlinePartialUserScore?: boolean;
}

export const SPECIAL_CHAR_TRANSLITERATION: Record<string, string> = {
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

const DOTTED_ACRONYM_RE = /\b(?:[a-z]\.){2,}[a-z]?\.?/gi;
const DOTTED_ACRONYM_TEST_RE = /\b(?:[a-z]\.){2,}[a-z]?\.?/i;
const REMASTER_OR_EDITION_TAG_RE =
  /\b(?:remastered|remaster|remake|redux|definitive|enhanced|anniversary|celebration|goty|game\s+of\s+the\s+year|complete|ultimate|director['’]?s\s+cut|final\s+cut|collection|trilogy|anthology|edition)\b/i;

function parseParamYear(releaseYear?: number | string | null): number | null {
  if (releaseYear === null || releaseYear === undefined) return null;
  const maxYear = new Date().getFullYear() + 1;
  if (typeof releaseYear === 'number') {
    if (!Number.isFinite(releaseYear)) return null;
    const yr = Math.trunc(releaseYear);
    return yr >= 1975 && yr <= maxYear ? yr : null;
  }
  const match = String(releaseYear).match(/\b((?:19|20)\d{2})\b/);
  if (!match) return null;
  const yr = parseInt(match[1], 10);
  return yr >= 1975 && yr <= maxYear ? yr : null;
}

function hasRemasterOrEditionTag(title: string): boolean {
  if (!title) return false;
  return REMASTER_OR_EDITION_TAG_RE.test(title);
}

function cleanForTitleTokens(s: string): string {
  if (!s) return '';
  let clean = stripTrademarkSymbols(decodeTitleHtmlEntities(s));
  for (const [char, rep] of Object.entries(SPECIAL_CHAR_TRANSLITERATION)) {
    clean = clean.replace(new RegExp(char, 'g'), ` ${rep} `);
  }
  clean = foldLatinLigaturesAndDiacritics(clean);
  return clean
    .toLowerCase()
    .replace(DOTTED_ACRONYM_RE, (m) => m.replace(/\./g, ''))
    .replace(/\bre-elected\b/gi, 'reelected')
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/(\d),(\d)/g, '$1$2');
}

function stripTrailingReleaseYearFromSlug(slug: string): string {
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
  let clean = stripTrademarkSymbols(decodeTitleHtmlEntities(title));
  for (const [char, rep] of Object.entries(SPECIAL_CHAR_TRANSLITERATION)) {
    clean = clean.replace(new RegExp(char, 'g'), ` ${rep} `);
  }
  clean = foldLatinLigaturesAndDiacritics(clean);
  return clean
    .toLowerCase()
    .replace(DOTTED_ACRONYM_RE, (m) => m.replace(/\./g, ''))
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/(\d),(\d)/g, '$1$2')
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
      .replace(/-ii-/g, '-2-').replace(/-ii$/, '-2')
      .replace(/-iii-/g, '-3-').replace(/-iii$/, '-3')
      .replace(/-iv-/g, '-4-').replace(/-iv$/, '-4')
      .replace(/-v-/g, '-5-').replace(/-v$/, '-5');
  return romanToArabic(aNorm) === romanToArabic(cNorm);
}

/**
 * Helper to determine if a candidate slug conflicts with the ground truth storefront anchor slug.
 */
export function isCandidateConflictingWithAnchor(candidateSlug: string, anchorSlug: string): boolean {
  return !isAnchorMatch(candidateSlug, anchorSlug);
}

const METACRITIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'till', 'into', 'from',
  'standard', 'deluxe', 'gold', 'silver', 'platinum', 'diamond', 'premium', 'collectors', 'collector', 'ultimate',
  'complete', 'special', 'limited', 'definitive', 'enhanced', 'anniversary', 'edition', 'remastered', 'remaster',
  'remake', 'directors', 'cut', 'legacy', 'classic', 'redux', 'extended', 'enchanted',
  'emperor', 'gourmet', 'celebration', 'spacers', 'choice', 'uncut', 'year', 'original',
  'digital', 'gog', 'steam', 'epic', 'launcher', 'unlimited', 'reelected', 'resnarkled', 'arpg', 'trilogy',
]);

const PURE_EDITION_WORDS = new Set([
  'edition', 'deluxe', 'gold', 'silver', 'platinum', 'diamond', 'premium', 'collectors', 'collector', 'ultimate',
  'goty', 'remastered', 'remaster', 'remake',
  'directors', 'cut', 'definitive', 'enhanced', 'anniversary', 'special', 'limited', 'standard',
  'classic', 'game', 'games', 'role', 'playing', 'rpg', 'arpg', 'post', 'nuclear', 'pack', 'bundle',
  'collection', 'trilogy', 'complete', 'redux', 'extended', 'enchanted', 'emperor', 'gourmet', 'celebration',
  'spacers', 'choice', 'uncut', 'year', 'original', 'ecto',
  'lightspeed', 'landmark', 'super', 'turbo', 'championship', 'unrated', 'anthology', 'telltale',
  'series', 'sid', 'meiers', 'meier', '20', '10', '25', '30',
  'digital', 'gog', 'steam', 'epic',
  'launcher', 'unlimited', 'reelected', 'resnarkled',
]);

const ANCHOR_SUFFIX_CONFLICT_TOKENS = new Set([
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

function tokenizeForAnchorPrefix(str: string): string[] {
  const parenYr = extractParentheticalReleaseYear(str);
  const parenYrStr = parenYr !== null ? String(parenYr) : null;
  const preStripped = stripPackagingEditionPhrases(stripYearEditionPhrases(str))
    .replace(/\s*\([^)]*\)/g, ' ')
    .trim();
  return cleanForTitleTokens(preStripped)
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== parenYrStr && !isYearEditionToken(str, w))
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

  if (!sequelMismatch && title.includes(' - ')) {
    const [mainPart, ...rest] = title.split(' - ');
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
  // Permits verified Steam/Wikidata anchors where a Remastered SKU points to the base or collection slug
  // (e.g. "BioShock Remastered" -> "bioshock-the-collection", "Saints Row: The Third Remastered" -> "saints-row-the-third",
  // "The Bard's Tale ARPG : Remastered and Resnarkled" -> "the-bards-tale") when franchise + sequel match.
  const hasRemasterQuery = /\bremastered?\b/i.test(title);
  const hasHardRemakeConflict =
    /\b(?:remake|rebirth|reloaded)\b/i.test(title) ||
    /\b(?:remake|rebirth|reloaded)\b/i.test(anchorWords);
  if (hasRemasterQuery && !hasHardRemakeConflict) {
    const titleWithoutRemaster = stripPackagingEditionPhrases(title)
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
  // Permits verified anchors whose slug starts with the exact normalized title tokens and appends
  // Metacritic's official subtitle ONLY when the title already carries an explicit installment numeral
  // (>= 2, e.g. "Cat Quest II" -> "cat-quest-ii-the-lupus-empire", "POSTAL 2" -> "postal-2-share-the-pain")
  // OR ends with explicit non-word clause punctuation ('!' or '?', e.g. "Monsters are Coming!" ->
  // "monsters-are-coming-rock-road"), never allowing bare unnumbered franchise titles ("Deus Ex",
  // "Grand Theft Auto", "Assassin's Creed", "Call of Duty") to match sequel/spinoff subtitles.
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

/**
 * Generates alternate slug variations based on systematic title patterns:
 * 1. Verified ground-truth anchor slug (when compatible)
 * 2. Exact canonical slug first (never heuristically stripping remastered/remaster/remake)
 * 3. Packaging-edition-stripped slug
 * 4. Mid-numeral-omitted subtitle slug via stripIntermediateSubtitleNumeral
 * 5. Release year suffix variations (using parenthetical year or releaseYear param, never bare title numbers)
 * 6. Additional structural fallbacks (acronym collapse, parenthetical strip, leading 'the-', Roman <-> Arabic)
 */
export function generateMetacriticSlugCandidates(
  title: string,
  releaseYear?: number | string | null,
  storefrontAnchor?: StorefrontReviewAnchor | null
): string[] {
  const clean = (title || '').trim();
  const base = toCanonicalMetacriticSlug(clean);
  const candidates: string[] = base ? [base] : [];

  if (!base && !storefrontAnchor?.metacriticSlug) return [];

  // 1. Packaging-edition-stripped slug (prioritized immediately after exact canonical base;
  // NEVER strips remastered/remaster/remake into a heuristic base slug)
  const phraseStrippedTitle = stripPackagingEditionPhrases(stripYearEditionPhrases(clean));
  const phraseStrippedBase = phraseStrippedTitle && phraseStrippedTitle !== clean
    ? toCanonicalMetacriticSlug(phraseStrippedTitle)
    : '';
  const stripped = stripMetacriticEditionSlug(phraseStrippedBase || base);
  if (stripped && stripped !== base) {
    candidates.push(stripped);
  }

  // 2. Mid-numeral-omitted subtitle slug via stripIntermediateSubtitleNumeral
  // (e.g. 'Deus Ex 2: Invisible War' -> 'deus-ex-invisible-war', 'The Elder Scrolls III: Morrowind' -> 'the-elder-scrolls-morrowind')
  // Placed BEFORE year-suffixed variants and BEFORE word+digit concatenation!
  const midNumeralTitles = new Set<string>();
  const midFromClean = stripIntermediateSubtitleNumeral(clean);
  if (midFromClean) midNumeralTitles.add(midFromClean);
  if (phraseStrippedTitle && phraseStrippedTitle !== clean) {
    const midFromStripped = stripIntermediateSubtitleNumeral(phraseStrippedTitle);
    if (midFromStripped) midNumeralTitles.add(midFromStripped);
  }
  const midNumeralSlugs: string[] = [];
  for (const midTitle of midNumeralTitles) {
    const midSlug = toCanonicalMetacriticSlug(midTitle);
    if (midSlug && midSlug !== base && !midNumeralSlugs.includes(midSlug)) {
      midNumeralSlugs.push(midSlug);
      candidates.push(midSlug);
    }
    const midStripped = stripMetacriticEditionSlug(midSlug);
    if (midStripped && midStripped !== base && midStripped !== midSlug && !midNumeralSlugs.includes(midStripped)) {
      midNumeralSlugs.push(midStripped);
      candidates.push(midStripped);
    }
  }

  // 3. Release year suffix variations (parenthetical release year or releaseYear param only; never bare 4-digit title numbers)
  const titleYearNum = extractParentheticalReleaseYear(clean);
  const paramYearNum = parseParamYear(releaseYear);
  const yrNum = titleYearNum ?? paramYearNum;
  const yr = yrNum !== null ? String(yrNum) : null;

  if (yr) {
    if (base && !base.endsWith(`-${yr}`) && base !== yr) {
      candidates.push(`${base}-${yr}`);
    } else if (base && base.endsWith(`-${yr}`)) {
      const baseNoYr = base.slice(0, -(yr.length + 1));
      if (baseNoYr) {
        candidates.push(baseNoYr);
        const strippedNoYr = stripMetacriticEditionSlug(baseNoYr);
        if (strippedNoYr && strippedNoYr !== baseNoYr) {
          candidates.push(strippedNoYr);
        }
      }
    }
    if (stripped && stripped !== base && !stripped.endsWith(`-${yr}`) && stripped !== yr) {
      candidates.push(`${stripped}-${yr}`);
    }
    for (const midSlug of midNumeralSlugs) {
      if (!midSlug.endsWith(`-${yr}`) && midSlug !== yr) {
        candidates.push(`${midSlug}-${yr}`);
      }
    }
  }

  // 4. Parenthetical subtitle stripping (e.g. 'Never Alone (Kisima Ingitchuna)' -> 'never-alone')
  const withoutParens = clean.replace(/\s*\([^)]*\)/g, '').trim();
  if (withoutParens && withoutParens !== clean) {
    const parenBase = toCanonicalMetacriticSlug(withoutParens);
    if (parenBase && parenBase !== base) {
      if (yr && !parenBase.endsWith(`-${yr}`)) {
        candidates.push(`${parenBase}-${yr}`);
      }
      candidates.push(parenBase);
    }
  }

  // 5. Trailing sequel word+digit concatenation (e.g. 'mdk-2' -> 'mdk2'; never 4-digit years)
  if (/-(?:[2-9]|1\d)$/.test(base)) {
    candidates.push(base.replace(/-((?:[2-9]|1\d))$/, '$1'));
  }
  if (stripped && stripped !== base && /-(?:[2-9]|1\d)$/.test(stripped)) {
    candidates.push(stripped.replace(/-((?:[2-9]|1\d))$/, '$1'));
  }

  // 6. Leading 'the-' toggling
  if (base.startsWith('the-')) {
    candidates.push(base.replace(/^the-/, ''));
  } else if (base) {
    candidates.push(`the-${base}`);
  }
  if (stripped && stripped !== base) {
    if (stripped.startsWith('the-')) {
      candidates.push(stripped.replace(/^the-/, ''));
    } else {
      candidates.push(`the-${stripped}`);
    }
  }

  // 7. Symbol expansion ('+' -> 'plus', '&' -> 'and')
  if (clean.includes('+')) {
    const withPlus = toCanonicalMetacriticSlug(clean.replace(/\+/g, ' plus '));
    if (withPlus && withPlus !== base) {
      candidates.push(withPlus);
    }
  }
  if (clean.includes('&')) {
    const withAnd = toCanonicalMetacriticSlug(clean.replace(/&/g, ' and '));
    if (withAnd && withAnd !== base) {
      candidates.push(withAnd);
    }
  }

  // 8. Subtitle splitting: only strip colon/dash suffix when it consists solely of non-remaster edition/packaging words
  if (clean.includes(':') || clean.includes(' - ')) {
    const parts = clean.split(/\s*:\s*|\s+-\s+/);
    const mainTitle = parts[0].trim();
    const suffixTokens = cleanForTitleTokens(stripPackagingEditionPhrases(parts.slice(1).join(' ')))
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const containsRemasterOrRemake = suffixTokens.some(
      (t) => t === 'remastered' || t === 'remaster' || t === 'remake'
    );
    const isEditionSuffix =
      !containsRemasterOrRemake &&
      suffixTokens.every((t) => METACRITIC_STOP_WORDS.has(t) || PURE_EDITION_WORDS.has(t));
    if (mainTitle.length >= 3 && isEditionSuffix) {
      const mainSlug = toCanonicalMetacriticSlug(mainTitle);
      if (mainSlug && mainSlug !== base) {
        candidates.push(mainSlug);
      }
    }
  }

  // 9. Roman numeral <-> Arabic conversions
  if (base.includes('-ii-')) candidates.push(base.replace(/-ii-/g, '-2-'));
  if (base.endsWith('-ii')) candidates.push(base.replace(/-ii$/, '-2'));
  if (base.includes('-iii-')) candidates.push(base.replace(/-iii-/g, '-3-'));
  if (base.endsWith('-iii')) candidates.push(base.replace(/-iii$/, '-3'));
  if (base.includes('-iv-')) candidates.push(base.replace(/-iv-/g, '-4-'));
  if (base.endsWith('-iv')) candidates.push(base.replace(/-iv$/, '-4'));
  if (base.includes('-v-')) candidates.push(base.replace(/-v-/g, '-5-'));
  if (base.endsWith('-v')) candidates.push(base.replace(/-v$/, '-5'));

  if (base.includes('-2-')) candidates.push(base.replace(/-2-/g, '-ii-'));
  if (base.endsWith('-2')) candidates.push(base.replace(/-2$/, '-ii'));
  if (base.includes('-3-')) candidates.push(base.replace(/-3-/g, '-iii-'));
  if (base.endsWith('-3')) candidates.push(base.replace(/-3$/, '-iii'));
  if (base.includes('-4-')) candidates.push(base.replace(/-4-/g, '-iv-'));
  if (base.endsWith('-4')) candidates.push(base.replace(/-4$/, '-iv'));
  if (base.includes('-5-')) candidates.push(base.replace(/-5-/g, '-v-'));
  if (base.endsWith('-5')) candidates.push(base.replace(/-5$/, '-v'));

  // Optional uncollapsed dotted acronym fallback (e.g. 'l-a-noire' after primary 'la-noire')
  if (DOTTED_ACRONYM_TEST_RE.test(clean)) {
    const uncollapsedSlug = foldLatinLigaturesAndDiacritics(
      stripTrademarkSymbols(decodeTitleHtmlEntities(clean))
    )
      .toLowerCase()
      .replace(/['’‘ʼ`´"“”]/g, '')
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (uncollapsedSlug && uncollapsedSlug !== base) {
      candidates.push(uncollapsedSlug);
    }
  }

  const unique = Array.from(new Set(candidates));
  if (storefrontAnchor?.metacriticSlug) {
    const rawAnchorSlug = storefrontAnchor.metacriticSlug.toLowerCase().trim();
    if (rawAnchorSlug && isAnchorSlugCompatible(title, rawAnchorSlug)) {
      const prioritized: string[] = [rawAnchorSlug];
      if (base && base !== rawAnchorSlug) {
        prioritized.push(base);
      }
      if (stripped && stripped !== base && stripped !== rawAnchorSlug) {
        prioritized.push(stripped);
      }
      for (const midSlug of midNumeralSlugs) {
        if (!prioritized.includes(midSlug)) {
          prioritized.push(midSlug);
        }
      }
      if (yr) {
        if (!rawAnchorSlug.endsWith(`-${yr}`) && rawAnchorSlug !== yr) {
          prioritized.push(`${rawAnchorSlug}-${yr}`);
        }
        if (base && !base.endsWith(`-${yr}`) && base !== yr && `${base}-${yr}` !== `${rawAnchorSlug}-${yr}`) {
          prioritized.push(`${base}-${yr}`);
        }
      }
      return Array.from(new Set([...prioritized, ...unique]));
    }
  }

  return unique;
}

function isViteBrowserDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol?.startsWith('http') &&
    (window.location.port === '3000' || window.location.port === '5173') &&
    typeof navigator !== 'undefined' &&
    !navigator.userAgent?.includes('jsdom') &&
    !navigator.userAgent?.includes('Node')
  );
}

export interface MetacriticSearchCandidate {
  slug: string;
  title?: string;
  score?: number | null;
  releaseDate?: string;
}

/**
 * Queries official Metacritic finder search API to discover release-year and alternative slugs.
 */
export async function searchMetacriticCandidates(
  query: string,
  priority: number = Priority.P1_VIEWPORT,
  options?: { onTransientError?: () => void; onSuccess?: () => void }
): Promise<MetacriticSearchCandidate[]> {
  if (!onlineLifecycleManager.isOnline()) {
    options?.onTransientError?.();
    return [];
  }
  try {
    let cleanQuery = stripTrademarkSymbols(decodeTitleHtmlEntities(query));
    for (const [char, rep] of Object.entries(SPECIAL_CHAR_TRANSLITERATION)) {
      cleanQuery = cleanQuery.replace(new RegExp(char, 'g'), ` ${rep} `);
    }
    cleanQuery = foldLatinLigaturesAndDiacritics(cleanQuery)
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/[:\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanQuery) return [];

    const baseUrl = isViteBrowserDev()
      ? '/api/metacritic-backend'
      : 'https://backend.metacritic.com';

    const url = `${baseUrl}/finder/metacritic/search/${encodeURIComponent(cleanQuery)}/web?offset=0&limit=10&mcoTypeId=13`;
    const res = await requestScheduler.schedule(
      url,
      () =>
        fetch(url, {
          headers: {
            Accept: 'application/json',
          },
          signal:
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(6000)
              : undefined,
        }),
      priority,
      'backend.metacritic.com'
    );

    if (!res.ok) {
      if (
        res.status === 429 ||
        res.status >= 500 ||
        isWafOrChallengeResponse(res.status, '', res.headers, true)
      ) {
        options?.onTransientError?.();
      }
      return [];
    }

    let data: unknown;
    if (typeof res.text === 'function') {
      const rawText = await res.text();
      if (isWafOrChallengeResponse(res.status, rawText, res.headers, true)) {
        options?.onTransientError?.();
        return [];
      }
      try {
        data = JSON.parse(rawText);
      } catch {
        options?.onTransientError?.();
        return [];
      }
    } else {
      data = await res.json();
    }

    if (!data || typeof data !== 'object') {
      options?.onTransientError?.();
      return [];
    }

    const rawItems =
      (data as { data?: { items?: unknown } }).data &&
      Array.isArray((data as { data: { items?: unknown } }).data.items)
        ? ((data as { data: { items: unknown[] } }).data.items as Array<{
            slug?: unknown;
            title?: unknown;
            criticScoreSummary?: { score?: unknown };
            releaseDate?: unknown;
          }>)
        : [];
    const candidates: MetacriticSearchCandidate[] = [];
    for (const item of rawItems) {
      if (item?.slug && typeof item.slug === 'string') {
        candidates.push({
          slug: item.slug,
          title: typeof item.title === 'string' ? item.title : undefined,
          score: typeof item.criticScoreSummary?.score === 'number' ? item.criticScoreSummary.score : null,
          releaseDate: typeof item.releaseDate === 'string' ? item.releaseDate : undefined,
        });
      }
    }
    options?.onSuccess?.();
    return candidates;
  } catch (err: unknown) {
    if (classifyNetworkError(err).status === 'transient_error') {
      options?.onTransientError?.();
    }
    return [];
  }
}

export async function searchMetacriticSlugs(
  query: string,
  priority: number = Priority.P1_VIEWPORT
): Promise<string[]> {
  const candidates = await searchMetacriticCandidates(query, priority);
  return candidates.map((c) => c.slug);
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

/**
 * Rigorously validates title compatibility between user library title and candidate Metacritic page title:
 * 1. Checks sequel numbers (via isSequelMismatch).
 * 2. Prevents explicit classic/original editions from matching modern remasters/enhanced editions.
 * 3. Prevents distinctive subtitle omissions across all subtitle segments.
 * 4. Enforces bidirectional substantive token conservation between query and candidate,
 *    preserving bare 4-digit title numbers (e.g. 2033, 2077, 2042, 2000) while ignoring
 *    only parenthetical disambiguation years and year-edition phrases.
 */
export function isTitleCompatible(rawQueryTitle: string, rawCanonicalName: string): boolean {
  if (!rawCanonicalName) return true;
  if (isSequelMismatch(rawQueryTitle, rawCanonicalName)) return false;

  // Guard against explicit Classic / Original / Gold editions matching modern Enhanced / Remastered / Remake / Reloaded editions
  const queryIsExplicitClassicOrOriginal = hasExplicitClassicOrOriginalEditionTag(rawQueryTitle);
  if (
    queryIsExplicitClassicOrOriginal &&
    /\b(enhanced|remastered|remaster|remake|reloaded|redux|definitive)\b/i.test(rawCanonicalName)
  ) {
    return false;
  }

  const qParenYr = extractParentheticalReleaseYear(rawQueryTitle);
  const qParenYrStr = qParenYr !== null ? String(qParenYr) : null;
  const cParenYr = extractParentheticalReleaseYear(rawCanonicalName);
  const cParenYrStr = cParenYr !== null ? String(cParenYr) : null;

  const queryTitle = stripPackagingEditionPhrases(stripYearEditionPhrases(rawQueryTitle));
  const canonicalName = stripPackagingEditionPhrases(stripYearEditionPhrases(rawCanonicalName));

  const norm = (s: string) =>
    cleanForTitleTokens(s)
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !METACRITIC_STOP_WORDS.has(w))
      .map((w) => ROMAN_TO_ARABIC[w] || w);

  const qTokens = norm(queryTitle);
  const cTokens = norm(canonicalName);

  if (qTokens.length === 0 || cTokens.length === 0) return true;

  // Must share at least one substantive token
  if (!qTokens.some((t) => cTokens.includes(t))) {
    return false;
  }

  // 1. Prevent distinctive subtitle omissions across every colon/dash/exclamation segment
  if (queryTitle.includes(':') || queryTitle.includes(' - ') || /!\s+\S/.test(queryTitle)) {
    const segments = queryTitle.split(/\s*[:!]\s*|\s+-\s+/).slice(1);
    const candWords = cleanForTitleTokens(canonicalName)
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ROMAN_TO_ARABIC[w] || w);

    for (const seg of segments) {
      const segWithoutParens = seg.replace(/\s*\([^)]*\)/g, '').trim();
      const rawSubTokens = cleanForTitleTokens(segWithoutParens)
        .replace(/[^a-z0-9]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0 && !['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is'].includes(w))
        .map((w) => ROMAN_TO_ARABIC[w] || w);

      if (rawSubTokens.length >= 1 && !rawSubTokens.some((t) => candWords.includes(t))) {
        const isPureEdition = rawSubTokens.every(
          (t) =>
            PURE_EDITION_WORDS.has(t) ||
            t === qParenYrStr ||
            isYearEditionToken(rawQueryTitle, t)
        );
        if (!isPureEdition) {
          return false;
        }
      }
    }
  }

  // 2. Bidirectional substantive token conservation:
  // Reject if query has extra non-edition substantive words outside parentheticals that are missing from candidate
  // (e.g. 'Godzilla Voxel Wars' -> 'Godzilla', 'Quake Champions' -> 'Quake', 'Quake II RTX' -> 'Quake II Enhanced Edition',
  // 'Metro 2033' -> 'Metro', 'Cyberpunk 2077' -> 'Cyberpunk', 'Syndicate Wars' / 'Syndicate Plus' -> 'Syndicate')
  const queryWithoutParens = queryTitle
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\b(mega\s+drive\s*(?:&|and)?\s*)/gi, '')
    .trim();
  const qSubstantive = norm(queryWithoutParens).filter(
    (t) =>
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      t !== qParenYrStr &&
      !isYearEditionToken(rawQueryTitle, t)
  );
  const qExtra = qSubstantive.filter((t) => !cTokens.includes(t));
  if (qExtra.length >= 1) {
    return false;
  }

  const qBaseStr =
    queryTitle.includes(':') || queryTitle.includes(' - ') || /!\s+\S/.test(queryTitle)
      ? queryTitle.split(/[:\-!]/)[0].trim()
      : queryTitle.replace(/\s*\([^)]*\)/g, '').trim();
  const qBase = norm(qBaseStr).filter(
    (t) =>
      !PURE_EDITION_WORDS.has(t) &&
      t !== qParenYrStr &&
      !isYearEditionToken(rawQueryTitle, t)
  );
  const hasEditionSuffix =
    queryTitle !== rawQueryTitle ||
    stripEditionSuffix(rawQueryTitle).trim().toLowerCase() !== normalizeTitleKey(rawQueryTitle) ||
    /\b(definitive|complete|goty|game of the year|director'?s cut|ultimate|enhanced|anniversary|remastered|collection|anthology|gold|deluxe|special|royal|legendary|edition)\b/i.test(
      rawQueryTitle
    );

  // Compute candidate extra non-edition substantive tokens BEFORE edition-suffix early return
  // so unnumbered franchise editions ("Fallout Complete Edition", "Portal: Enhanced Edition",
  // "Diablo: Deluxe Edition") never match distinct spinoffs/mods ("Fallout Shelter", "Portal: Revolution", "Diablo Immortal").
  const cExtra = cTokens.filter(
    (t) =>
      !qTokens.includes(t) &&
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      t !== cParenYrStr &&
      !isYearEditionToken(rawCanonicalName, t) &&
      !(t === 'plus' && rawQueryTitle.includes('+'))
  );

  // Numbered sequel editions replacing an original release subtitle (e.g.
  // "Trine 4: Definitive Edition" -> "Trine 4: The Nightmare Prince") are allowed ONLY when
  // the query has an explicit installment numeral at the end of qBase, an explicit delimiter
  // before the edition tag, and a multi-word conflict-free candidate subtitle.
  const hasNumberedEditionSubtitleReplacement =
    hasEditionSuffix &&
    extractSequelIdentifier(rawQueryTitle) !== null &&
    qBase.length >= 2 &&
    NUMERIC_SEQUELS.has(qBase[qBase.length - 1]) &&
    (rawQueryTitle.includes(':') || rawQueryTitle.includes(' - ')) &&
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

  const cBase = canonicalName.includes(':') || canonicalName.includes(' - ') || /!\s+\S/.test(canonicalName)
    ? canonicalName.split(/[:\-!]/)[0].trim()
    : canonicalName;

  const cBaseTokens = norm(cBase);

  // Reject if candidate base title has extra non-edition substantive words not in query title
  // (e.g. 'Metal Gear Solid Delta: Snake Eater' for 'Metal Gear Solid: Snake Eater', or 'Kingdom Come' for 'Kingdom: Classic')
  const cBaseExtra = cBaseTokens.filter(
    (t) =>
      !qTokens.includes(t) &&
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      t !== cParenYrStr &&
      !isYearEditionToken(rawCanonicalName, t) &&
      !(t === 'plus' && rawQueryTitle.includes('+'))
  );
  if (cBaseExtra.length >= 1) {
    return false;
  }

  // Reject if candidate has extra non-edition substantive words anywhere not in query
  // (e.g. 'Pool of Radiance: Ruins of Myth Drannor' for 'Pool of Radiance', 'RPG Maker WITH' for 'RPG Maker XP',
  //  'Portal: Revolution' for 'Portal: Enhanced Edition')
  const qBaseTokens = qBase.filter((t) => !NUMERIC_SEQUELS.has(t));
  const candidateHasSubtitle =
    canonicalName.includes(':') || canonicalName.includes(' - ') || /!\s+\S/.test(canonicalName);

  if (!candidateHasSubtitle) {
    if (cExtra.length >= 1) {
      return false;
    }
  } else {
    if ((qBaseTokens.length >= 2 || hasEditionSuffix) && cExtra.length >= 1) {
      return false;
    }
  }

  return true;
}

/**
 * Decodes HTML entities and filters out corrupted upstream Metacritic mobile-app spam descriptions.
 */
export function sanitizeMetacriticDescription(rawDesc: string | undefined, reviewCount: number): string {
  const fallback = `Metacritic consensus score based on ${reviewCount} critic reviews.`;
  if (!rawDesc || typeof rawDesc !== 'string') return fallback;

  const decoded = rawDesc
    .replace(/\s*\[(?:WiiWare|iOS|DSiWare|Xbox Live Arcade|PSN|AppStore|App Store)\]\s*/gi, ' ')
    .replace(/&#39;|&#x27;|&#8217;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&#34;|&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&radic;/gi, '')
    .replace(/&ndash;|&#8211;/gi, '-')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    !decoded ||
    /^\s*\?[?\sA-Z]*\?/.test(decoded) ||
    /\b(slide your finger to link|using openfeint|free coins everyday|wiiware download|coming to touch screen devices|available on the app store|match 3 gem game|use your fingers to jump|touch-controlled platformer)\b/i.test(
      decoded
    )
  ) {
    return fallback;
  }

  return decoded;
}

/**
 * Filters and ranks discovered search slugs against the original query to prevent sequel/variant mismatches.
 */
export function rankCandidateSlugs(
  query: string,
  candidateSlugs: Array<string | MetacriticSearchCandidate>,
  storefrontAnchor?: StorefrontReviewAnchor | null
): string[] {
  const queryParenYr = extractParentheticalReleaseYear(query);
  const queryParenYrStr = queryParenYr !== null ? String(queryParenYr) : undefined;
  const cleanedQuery = stripPackagingEditionPhrases(stripYearEditionPhrases(query)).replace(
    /\s*\([^)]*\)/g,
    ' '
  );
  const clean = cleanForTitleTokens(cleanedQuery)
    .replace(/[:\-–—]/g, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const qTokens = clean
    .split(' ')
    .filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t))
    .map((t) => ROMAN_TO_ARABIC[t] || t);

  const normalized: MetacriticSearchCandidate[] = candidateSlugs.map((c) =>
    typeof c === 'string' ? { slug: c, score: null } : c
  );

  const rawAnchorSlug = storefrontAnchor?.metacriticSlug?.toLowerCase().trim();
  const anchorSlug = rawAnchorSlug && isAnchorSlugCompatible(query, rawAnchorSlug) ? rawAnchorSlug : undefined;

  // Rule 4: If storefrontAnchor is present, veto conflicting candidates and place anchor match at index 0
  if (anchorSlug) {
    const nonConflicting = normalized.filter((c) => !isCandidateConflictingWithAnchor(c.slug, anchorSlug));
    const queryYr = queryParenYrStr;

    nonConflicting.sort((a, b) => {
      if (queryYr) {
        const aYearMatch = a.slug.toLowerCase().trim() === `${anchorSlug}-${queryYr}` ? 1 : 0;
        const bYearMatch = b.slug.toLowerCase().trim() === `${anchorSlug}-${queryYr}` ? 1 : 0;
        if (bYearMatch !== aYearMatch) return bYearMatch - aYearMatch;
      }

      const aExact = a.slug.toLowerCase().trim() === anchorSlug ? 1 : 0;
      const bExact = b.slug.toLowerCase().trim() === anchorSlug ? 1 : 0;
      if (bExact !== aExact) return bExact - aExact;

      const aMatch = isAnchorMatch(a.slug, anchorSlug) ? 1 : 0;
      const bMatch = isAnchorMatch(b.slug, anchorSlug) ? 1 : 0;
      return bMatch - aMatch;
    });

    return nonConflicting.map(({ slug }) => slug);
  }

  const maxYear = new Date().getFullYear() + 1;
  const stripSlugReleaseYear = (slug: string): string => {
    const m = slug.match(/^(.*)-((?:19|20)\d{2})$/);
    if (!m) return slug;
    const yrStr = m[2];
    const yrVal = parseInt(yrStr, 10);
    if (yrVal < 1975 || yrVal > maxYear) return slug;
    // Preserve bare 4-digit title numbers (e.g. 'simcity-2000', 'battlefield-2042') when present in query tokens
    if (qTokens.includes(yrStr) && yrStr !== queryParenYrStr) return slug;
    return m[1];
  };

  const toSlugTokens = (slug: string): string[] =>
    stripSlugReleaseYear(slug)
      .split('-')
      .filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t))
      .map((t) => ROMAN_TO_ARABIC[t] || t);

  return normalized
    .filter((c) => {
      const { slug } = c;
      const slugWithoutYear = stripSlugReleaseYear(slug);
      const slugTitle = slugWithoutYear.replace(/-/g, ' ');
      if (isSequelMismatch(query, slugTitle)) {
        return false;
      }

      if (c.title) {
        if (!isTitleCompatible(query, c.title)) {
          return false;
        }
      } else {
        if (!isTitleCompatible(query, slugTitle)) {
          return false;
        }
        const sTokens = toSlugTokens(slug);
        const nonStopSTokens = sTokens.filter(
          (t) =>
            !METACRITIC_STOP_WORDS.has(t) &&
            t !== queryParenYrStr &&
            !isYearEditionToken(query, t)
        );
        const sExtraSubstantive = nonStopSTokens.filter((t) => !qTokens.includes(t));
        if (qTokens.length === 1 && sExtraSubstantive.length >= 1) {
          return false;
        }
        if (sExtraSubstantive.length >= 2 && qTokens.length <= 2 && query.includes(':')) {
          return false;
        }
      }

      const sTokens = toSlugTokens(slug);
      if (qTokens.length > 0 && sTokens.length > 0) {
        if (qTokens[0] !== sTokens[0] && !sTokens.includes(qTokens[0])) {
          return false;
        }
      }

      // Prevent distinct franchise entries with disjoint substantive words (e.g. 'wrath' vs 'rise')
      const qDisjoint = qTokens.filter((t) => !sTokens.includes(t) && t.length >= 3);
      const sDisjoint = sTokens.filter((t) => !qTokens.includes(t) && t.length >= 3);
      if (qDisjoint.length > 0 && sDisjoint.length > 0) {
        return false;
      }

      const overlap = qTokens.filter((t) => sTokens.includes(t));
      const qRatio = qTokens.length > 0 ? overlap.length / qTokens.length : 0;
      const sRatio = sTokens.length > 0 ? overlap.length / sTokens.length : 0;

      return (qRatio >= 0.65 || sRatio === 1) && overlap.length >= Math.min(1, qTokens.length);
    })

    .sort((a, b) => {
      const aTokens = toSlugTokens(a.slug);
      const bTokens = toSlugTokens(b.slug);
      const aOverlap = qTokens.filter((t) => aTokens.includes(t)).length;
      const bOverlap = qTokens.filter((t) => bTokens.includes(t)).length;
      const aRatio = aTokens.length > 0 ? aOverlap / aTokens.length : 0;
      const bRatio = bTokens.length > 0 ? bOverlap / bTokens.length : 0;

      if (Math.abs(bRatio - aRatio) > 0.1) {
        return bRatio - aRatio;
      }

      // Prioritize candidates with verified scores in Metacritic search
      const aHasScore = typeof a.score === 'number' && a.score > 0 ? 1 : 0;
      const bHasScore = typeof b.score === 'number' && b.score > 0 ? 1 : 0;
      if (bHasScore !== aHasScore) {
        return bHasScore - aHasScore;
      }

      return bRatio - aRatio;
    })
    .map(({ slug }) => slug);
}

const MAX_METACRITIC_CACHE_ENTRIES = 2000;

interface MetacriticJsonLdPayload {
  name?: string;
  description?: string;
  datePublished?: string;
  dateCreated?: string;
  aggregateRating?: {
    ratingValue?: number;
    reviewCount?: number;
  };
}

interface MetacriticComposerScoreSummary {
  url?: string;
  max?: number;
  score?: number | null;
  reviewCount?: number | null;
}

interface MetacriticComposerPlatform {
  id?: number;
  name?: string;
  slug?: string;
  releaseDate?: string;
  criticScoreSummary?: MetacriticComposerScoreSummary | null;
  userScoreSummary?: MetacriticComposerScoreSummary | null;
}

type ComposerRedirectTarget =
  | string
  | { slug?: string; url?: string }
  | Array<string | { slug?: string; url?: string }>;

interface MetacriticComposerProductItem {
  type?: string;
  slug?: string;
  title?: string;
  name?: string;
  releaseDate?: string;
  description?: string;
  criticScoreSummary?: MetacriticComposerScoreSummary | null;
  userScoreSummary?: MetacriticComposerScoreSummary | null;
  platforms?: MetacriticComposerPlatform[];
  availableOn?: ComposerRedirectTarget;
  redirect?: ComposerRedirectTarget;
  redirectUrl?: string;
}

interface MetacriticComposerComponent {
  data?: {
    item?: Record<string, unknown> | null;
    items?: Array<Record<string, unknown>>;
  };
  meta?: {
    componentName?: string;
    componentType?: string;
  };
}

interface MetacriticComposerResponse {
  code?: number;
  data?: {
    item?: MetacriticComposerProductItem | null;
    availableOn?: ComposerRedirectTarget;
    redirect?: ComposerRedirectTarget;
    redirectUrl?: string;
  };
  availableOn?: ComposerRedirectTarget;
  redirect?: ComposerRedirectTarget;
  redirectUrl?: string;
  components?: MetacriticComposerComponent[];
}

type YearCompatibilityStatus = 'accept' | 'defer_older' | 'reject';

interface DeferredOlderCritic {
  critic: CriticScoreData;
  user: CriticScoreData | null;
  pageYear: number;
}

interface DeferredOlderUser {
  user: CriticScoreData;
  pageYear: number;
}

interface SlugEvaluationResult {
  critic: CriticScoreData | null;
  user: CriticScoreData | null;
  deferredOlderCritic?: DeferredOlderCritic;
  deferredOlderUser?: DeferredOlderUser;
}

function parseMetacriticDocument(html: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

function extractYearFromDateString(dateStr?: string | null): number | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const match = dateStr.match(/\b((?:19|20)\d{2})\b/);
  if (!match) return null;
  const yr = parseInt(match[1], 10);
  const maxYear = new Date().getFullYear() + 2;
  return yr >= 1975 && yr <= maxYear ? yr : null;
}

function stripMetacriticPageTitleSuffix(rawPageTitle: string): string {
  return (rawPageTitle || '')
    .replace(/\s*(?:critic\s+reviews|user\s+reviews|reviews)?\s*[-|–—]\s*metacritic\s*$/i, '')
    .trim();
}

function extractSlugFromRedirectValue(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') {
    const clean = val.split('?')[0].split('#')[0].trim().replace(/\/+$/, '');
    if (!clean) return null;
    const gameMatch = clean.match(/\/game\/(?:[a-z0-9-]+\/)?([a-z0-9][a-z0-9!-]*)$/i);
    if (gameMatch?.[1]) return gameMatch[1].toLowerCase();
    if (/^[a-z0-9][a-z0-9-]*$/i.test(clean)) return clean.toLowerCase();
    return null;
  }
  if (Array.isArray(val)) {
    for (const entry of val) {
      const found = extractSlugFromRedirectValue(entry);
      if (found) return found;
    }
    return null;
  }
  if (typeof val === 'object') {
    const obj = val as { slug?: unknown; url?: unknown };
    return extractSlugFromRedirectValue(obj.slug) || extractSlugFromRedirectValue(obj.url);
  }
  return null;
}

function extractComposerRedirectSlug(payload: MetacriticComposerResponse, currentSlug: string): string | null {
  const candidates = [
    payload.availableOn,
    payload.redirect,
    payload.redirectUrl,
    payload.data?.availableOn,
    payload.data?.redirect,
    payload.data?.redirectUrl,
    payload.data?.item?.availableOn,
    payload.data?.item?.redirect,
    payload.data?.item?.redirectUrl,
  ];
  for (const cand of candidates) {
    const extracted = extractSlugFromRedirectValue(cand);
    if (extracted && extracted !== currentSlug.toLowerCase()) {
      return extracted;
    }
  }
  return null;
}

function isComposerScoreSummary(obj: unknown): obj is MetacriticComposerScoreSummary {
  if (!obj || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>;
  return 'score' in rec || 'reviewCount' in rec;
}

function extractComposerProductNodes(payload: MetacriticComposerResponse): {
  productItem: MetacriticComposerProductItem | null;
  componentCriticSummary: MetacriticComposerScoreSummary | null;
  componentUserSummary: MetacriticComposerScoreSummary | null;
} {
  let productItem: MetacriticComposerProductItem | null =
    payload.data?.item && typeof payload.data.item === 'object' ? { ...payload.data.item } : null;
  let componentCriticSummary: MetacriticComposerScoreSummary | null = null;
  let componentUserSummary: MetacriticComposerScoreSummary | null = null;

  if (Array.isArray(payload.components)) {
    for (const comp of payload.components) {
      const compName = String(comp?.meta?.componentName || '').toLowerCase();
      const compType = String(comp?.meta?.componentType || '').toLowerCase();
      const item = comp?.data?.item;
      if (!item || typeof item !== 'object') continue;

      if (compName === 'product' || compType === 'product') {
        productItem = productItem
          ? { ...(item as MetacriticComposerProductItem), ...productItem }
          : ({ ...(item as MetacriticComposerProductItem) } as MetacriticComposerProductItem);
      } else if (compName === 'critic-score-summary' || compType === 'critic-score-summary') {
        if (isComposerScoreSummary(item)) {
          componentCriticSummary = item;
        }
      } else if (compName === 'user-score-summary' || compType === 'user-score-summary') {
        if (isComposerScoreSummary(item)) {
          componentUserSummary = item;
        }
      } else if (!productItem && ('title' in item || 'platforms' in item)) {
        productItem = { ...(item as MetacriticComposerProductItem) };
      }
    }
  }

  return { productItem, componentCriticSummary, componentUserSummary };
}

function selectComposerCriticSummary(
  productItem: MetacriticComposerProductItem | null,
  componentCriticSummary: MetacriticComposerScoreSummary | null
): MetacriticComposerScoreSummary | null {
  const overallCritic = productItem?.criticScoreSummary ?? componentCriticSummary ?? null;
  const platforms = Array.isArray(productItem?.platforms) ? productItem.platforms : [];
  const pcPlatform = platforms.find((p) => {
    const pSlug = typeof p?.slug === 'string' ? p.slug.toLowerCase().trim() : '';
    const pName = typeof p?.name === 'string' ? p.name.toLowerCase().trim() : '';
    return pSlug === 'pc' || pName === 'pc';
  });
  const pcCritic = pcPlatform?.criticScoreSummary ?? null;

  const pcHasScore = typeof pcCritic?.score === 'number' && pcCritic.score > 0;
  const pcReviewCount = typeof pcCritic?.reviewCount === 'number' ? pcCritic.reviewCount : 0;
  const overallHasScore = typeof overallCritic?.score === 'number' && overallCritic.score > 0;

  if (pcHasScore && (pcReviewCount >= 4 || !overallHasScore)) {
    return pcCritic;
  }
  if (overallHasScore) {
    return overallCritic;
  }
  if (pcHasScore) {
    return pcCritic;
  }
  return overallCritic;
}

export class MetacriticResolver {
  private cache = new Map<string, MetacriticBundle>();
  private cacheKeysByTitle = new Map<string, Set<string>>();
  private cacheKeyToTitleKeys = new Map<string, string[]>();
  private inFlight = new Map<string, Promise<MetacriticBundle>>();
  private transientFailureTitles = new Set<string>();

  constructor() {
    try {
      onlineLifecycleManager.onOnline(() => {
        this.transientFailureTitles.clear();
        const partialKeys: string[] = [];
        for (const [k, bundle] of this.cache.entries()) {
          if (bundle.offlinePartialUserScore) {
            partialKeys.push(k);
          }
        }
        for (const k of partialKeys) {
          this.deleteCacheKey(k);
        }
      });
    } catch {}
  }

  private deleteCacheKey(key: string): void {
    this.cache.delete(key);
    this.inFlight.delete(key);
    const titleKeys = this.cacheKeyToTitleKeys.get(key);
    if (titleKeys) {
      for (const tk of titleKeys) {
        const set = this.cacheKeysByTitle.get(tk);
        if (set) {
          set.delete(key);
          if (set.size === 0) this.cacheKeysByTitle.delete(tk);
        }
      }
      this.cacheKeyToTitleKeys.delete(key);
    }
  }

  private setCacheBounded(key: string, bundle: MetacriticBundle, rawTitle?: string): void {
    if (this.cache.has(key)) {
      this.deleteCacheKey(key);
    }
    this.cache.set(key, bundle);
    const titleKeys: string[] = [];
    const titleLower = (rawTitle || '').trim().toLowerCase();
    if (titleLower) {
      titleKeys.push(titleLower);
      const norm = normalizeTitleKey(titleLower);
      if (norm && norm !== titleLower) {
        titleKeys.push(norm);
      }
    }
    if (titleKeys.length > 0) {
      this.cacheKeyToTitleKeys.set(key, titleKeys);
      for (const tk of titleKeys) {
        let set = this.cacheKeysByTitle.get(tk);
        if (!set) {
          set = new Set<string>();
          this.cacheKeysByTitle.set(tk, set);
        }
        set.add(key);
      }
    }
    while (this.cache.size > MAX_METACRITIC_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.deleteCacheKey(oldest);
    }
  }

  public hadRecentTransientFailure(rawTitle: string): boolean {
    const title = (rawTitle || '').trim().toLowerCase();
    return title ? this.transientFailureTitles.has(title) : false;
  }

  /**
   * Resolves both Critic Metascore and User Score for a game title in a single request pass.
   */
  async resolveMetacritic(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<MetacriticBundle> {
    const title = (rawTitle || '').trim();
    if (!title) return { critic: null, user: null };

    const rawAnchorSlug = storefrontAnchor?.metacriticSlug?.toLowerCase().trim();
    const anchorSlug = rawAnchorSlug && isAnchorSlugCompatible(title, rawAnchorSlug) ? rawAnchorSlug : undefined;
    const cacheKey = `${title.toLowerCase()}${releaseYear ? `:${releaseYear}` : ''}${anchorSlug ? `:${anchorSlug}` : ''}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (cached.offlinePartialUserScore && onlineLifecycleManager.isOnline()) {
        this.deleteCacheKey(cacheKey);
      } else {
        return cached;
      }
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    this.transientFailureTitles.delete(title.toLowerCase());

    if (!onlineLifecycleManager.isOnline()) {
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        const fallbackSlug =
          anchorSlug ||
          storefrontAnchor.metacriticSlug ||
          toCanonicalMetacriticSlug(title);
        if (fallbackSlug && isAnchorSlugCompatible(title, fallbackSlug)) {
          const anchorCritic: CriticScoreData = {
            id: `mc-${fallbackSlug}`,
            source: 'metacritic',
            score: storefrontAnchor.metacriticScore,
            tier: calculateTier(storefrontAnchor.metacriticScore),
            numReviews: 20,
            url:
              storefrontAnchor.metacriticUrl ||
              `https://www.metacritic.com/game/${fallbackSlug}/critic-reviews/`,
            summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
            isVerified: true,
            isSynthetic: false,
          };
          const bundle: MetacriticBundle = {
            critic: anchorCritic,
            user: null,
            offlinePartialUserScore: true,
          };
          this.setCacheBounded(cacheKey, bundle, title);
          return bundle;
        }
      }
      this.transientFailureTitles.add(title.toLowerCase());
      return { critic: null, user: null };
    }

    const titleYear = extractParentheticalReleaseYear(title);
    const paramYear = parseParamYear(releaseYear);
    const titleHasRemasterOrEdition = hasRemasterOrEditionTag(title);
    const titleWithoutParenYear = title
      .replace(/\s*[\(\[]\s*(?:[^)\]]*?[,\s-])?(?:19|20)\d{2}\s*[\)\]]/g, '')
      .trim();
    const queryHasExplicitFirstInstallment = /\b(?:1|i)\b/i.test(titleWithoutParenYear);
    const isExplicitRetroQuery =
      hasExplicitClassicOrOriginalEditionTag(titleWithoutParenYear) ||
      /\b(plus|dos)\b/i.test(titleWithoutParenYear);

    const evaluateReleaseYearCompatibility = (
      pageYear: number | null,
      isAnchor: boolean
    ): YearCompatibilityStatus => {
      if (!pageYear) return 'accept';
      // Rule 1: Explicit parenthetical release year in title is strict and symmetric
      if (titleYear !== null) {
        return Math.abs(titleYear - pageYear) > 2 ? 'reject' : 'accept';
      }
      if (paramYear !== null) {
        // Rule 2: Classic game must never match a newer modern reboot
        if (pageYear > paramYear + 3) {
          if (paramYear <= 2020 && !titleHasRemasterOrEdition) {
            return 'reject';
          }
          return 'accept';
        }
        // Rule 3: Storefront re-release date newer than Metacritic page
        if (pageYear < paramYear - 3) {
          return isAnchor ? 'accept' : 'defer_older';
        }
      }
      return 'accept';
    };

    const validatePageIdentity = (
      canonicalName: string,
      pageYear: number | null,
      description: string | undefined,
      isAnchor: boolean
    ): YearCompatibilityStatus => {
      if (!isAnchor && canonicalName && !isTitleCompatible(title, canonicalName)) {
        return 'reject';
      }

      const yearStatus = evaluateReleaseYearCompatibility(pageYear, isAnchor);
      if (yearStatus === 'reject') {
        return 'reject';
      }

      // Guard against explicit first-installment or retro classic matching an unnumbered modern reboot
      if (
        ((queryHasExplicitFirstInstallment &&
          canonicalName &&
          !/\b(?:1|i)\b/i.test(canonicalName)) ||
          (isExplicitRetroQuery &&
            canonicalName &&
            !/\b(classic|original|plus|dos)\b/i.test(canonicalName))) &&
        ((pageYear && pageYear >= 2008) ||
          /\b(reimagination|reimagining|remake of the|modern reboot|reboot of the|completely remastered)\b/i.test(
            description || ''
          ))
      ) {
        return 'reject';
      }

      // Guard against franchise spinoff subtitle collisions on base-title review URLs
      const descText = description || '';
      const escapedBase = titleWithoutParenYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escapedBase && !title.includes(':') && descText) {
        const spinoffColonRe = new RegExp(`\\b${escapedBase}:\\s+([A-Z][A-Za-z0-9'\\s-]{2,})`, 'i');
        const spinoffMatch = descText.match(spinoffColonRe);
        if (spinoffMatch?.[1]) {
          const subLower = spinoffMatch[1].trim().toLowerCase();
          if (subLower && !title.toLowerCase().includes(subLower)) {
            return 'reject';
          }
        }
      }

      return yearStatus;
    };

    const buildAnchorFallbackCritic = (slug: string): CriticScoreData | null => {
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        return {
          id: `mc-${slug}`,
          source: 'metacritic',
          score: storefrontAnchor.metacriticScore,
          tier: calculateTier(storefrontAnchor.metacriticScore),
          numReviews: 20,
          url:
            storefrontAnchor.metacriticUrl ||
            `https://www.metacritic.com/game/${slug}/critic-reviews/`,
          summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
          isVerified: true,
          isSynthetic: false,
        };
      }
      return null;
    };

    const promise = (async (): Promise<MetacriticBundle> => {
      const slugs = generateMetacriticSlugCandidates(title, releaseYear, storefrontAnchor);
      let fallbackUser: CriticScoreData | null = null;
      let deferredOlderCritic: DeferredOlderCritic | null = null;
      let deferredOlderUser: DeferredOlderUser | null = null;
      let sawTransientError = false;

      const recordDeferredOlder = (evalRes: SlugEvaluationResult): void => {
        if (evalRes.deferredOlderCritic) {
          if (
            !deferredOlderCritic ||
            (paramYear !== null &&
              Math.abs(evalRes.deferredOlderCritic.pageYear - paramYear) <
                Math.abs(deferredOlderCritic.pageYear - paramYear))
          ) {
            deferredOlderCritic = evalRes.deferredOlderCritic;
          }
        }
        if (evalRes.deferredOlderUser && !deferredOlderUser) {
          deferredOlderUser = evalRes.deferredOlderUser;
        }
      };

      const evaluateHtmlBody = (
        html: string,
        slug: string,
        isAnchor: boolean
      ): SlugEvaluationResult => {
        const doc = parseMetacriticDocument(html);
        const extractPageReleaseYear = (jsonLd?: MetacriticJsonLdPayload | null): number | null => {
          const domReleaseText =
            doc?.querySelector('.c-gameDetails_releaseDate, [itemprop="datePublished"], [data-testid="release-date"]')
              ?.textContent || '';
          const candidateDateStr =
            jsonLd?.datePublished ||
            jsonLd?.dateCreated ||
            domReleaseText ||
            html.match(/(?:datePublished|releaseDate|c-gameDetails_releaseDate)[^>]*?(\b(?:19\d\d|20\d\d)\b)/i)?.[1] ||
            '';
          return extractYearFromDateString(candidateDateStr);
        };

        const rawPageTitle =
          doc?.title?.trim() ||
          html.match(/<title>([^<]+)<\/title>/i)?.[1] ||
          '';
        const cleanedPageTitle = stripMetacriticPageTitleSuffix(rawPageTitle);
        const domHeadingTitle = doc?.querySelector('h1')?.textContent?.trim() || '';

        let criticData: CriticScoreData | null = null;
        let validatedPageStatus: YearCompatibilityStatus | null = null;
        let validatedPageYear: number | null = null;

        // 1. Critic extraction from JSON-LD Schema via DOMParser
        const jsonLdBlocks: string[] = [];
        if (doc) {
          const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (const script of Array.from(scripts)) {
            if (script.textContent) jsonLdBlocks.push(script.textContent);
          }
        } else {
          const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
          if (jsonLdMatch?.[1]) jsonLdBlocks.push(jsonLdMatch[1]);
        }

        for (const rawBlock of jsonLdBlocks) {
          try {
            const parsedLd: unknown = JSON.parse(rawBlock);
            const ldItems: MetacriticJsonLdPayload[] = Array.isArray(parsedLd)
              ? (parsedLd as MetacriticJsonLdPayload[])
              : parsedLd && typeof parsedLd === 'object'
              ? [parsedLd as MetacriticJsonLdPayload]
              : [];
            for (const jsonLd of ldItems) {
              if (!jsonLd.name && !jsonLd.aggregateRating) continue;
              const canonicalName = jsonLd.name || domHeadingTitle || cleanedPageTitle;
              const pageYear = extractPageReleaseYear(jsonLd);
              const pageStatus = validatePageIdentity(canonicalName, pageYear, jsonLd.description, isAnchor);
              validatedPageStatus = pageStatus;
              validatedPageYear = pageYear;

              if (pageStatus === 'reject') {
                return { critic: null, user: null };
              }

              const rating = jsonLd.aggregateRating;
              if (
                rating &&
                typeof rating.ratingValue === 'number' &&
                rating.ratingValue > 0 &&
                typeof rating.reviewCount === 'number' &&
                rating.reviewCount >= 4
              ) {
                const score = Math.round(rating.ratingValue);
                if (
                  !isAnchor &&
                  typeof storefrontAnchor?.metacriticScore === 'number' &&
                  storefrontAnchor.metacriticScore > 0 &&
                  Math.abs(score - storefrontAnchor.metacriticScore) > 15
                ) {
                  return { critic: null, user: null };
                }
                criticData = {
                  id: `mc-${slug}`,
                  source: 'metacritic',
                  score,
                  tier: calculateTier(score),
                  numReviews: rating.reviewCount,
                  url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
                  summary: sanitizeMetacriticDescription(jsonLd.description, rating.reviewCount),
                  isVerified: true,
                  isSynthetic: false,
                };
                break;
              }
            }
            if (criticData) break;
          } catch {}
        }

        // Fallback: Critic extraction directly from Metacritic DOM markup (e.g. for /critic-reviews/ pages)
        if (!criticData) {
          const metaScoreTitleAttr =
            doc?.querySelector('.c-siteReviewScore_large[title], [title^="Metascore "]')?.getAttribute('title') ||
            '';
          const metaScoreMatch =
            metaScoreTitleAttr.match(/Metascore\s+([0-9]+)\s+out\s+of\s+100/i) ||
            html.match(
              /class="[^"]*c-siteReviewScore_large[^"]*"[^>]*title="Metascore\s+([0-9]+)\s+out\s+of\s+100"/i
            );

          if (metaScoreMatch && metaScoreMatch[1]) {
            const pageTitle = domHeadingTitle || cleanedPageTitle;
            const pageYear = extractPageReleaseYear(null);
            const pageStatus = validatePageIdentity(pageTitle, pageYear, undefined, isAnchor);
            validatedPageStatus = pageStatus;
            validatedPageYear = pageYear;

            if (pageStatus === 'reject') {
              return { critic: null, user: null };
            }

            const rawScore = parseInt(metaScoreMatch[1], 10);
            if (!isNaN(rawScore) && rawScore > 0 && rawScore <= 100) {
              if (
                !isAnchor &&
                typeof storefrontAnchor?.metacriticScore === 'number' &&
                storefrontAnchor.metacriticScore > 0 &&
                Math.abs(rawScore - storefrontAnchor.metacriticScore) > 15
              ) {
                return { critic: null, user: null };
              }
              criticData = {
                id: `mc-${slug}`,
                source: 'metacritic',
                score: rawScore,
                tier: calculateTier(rawScore),
                numReviews: 20,
                url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
                summary: `Metacritic consensus score based on critic reviews.`,
                isVerified: true,
                isSynthetic: false,
              };
            }
          }
        }

        // Gate User Score (MCU) behind the EXACT SAME isTitleCompatible + directional release-year validation
        if (validatedPageStatus === null) {
          const fallbackPageTitle = domHeadingTitle || cleanedPageTitle;
          const fallbackPageYear = extractPageReleaseYear(null);
          validatedPageStatus = validatePageIdentity(fallbackPageTitle, fallbackPageYear, undefined, isAnchor);
          validatedPageYear = fallbackPageYear;
        }

        if (validatedPageStatus === 'reject') {
          return { critic: null, user: null };
        }

        // 2. User Score extraction via DOMParser (only reached after page passes validation)
        let userData: CriticScoreData | null = null;
        let rawUserScoreStr: string | undefined;
        if (doc) {
          const userLabeledEl = doc.querySelector('[title^="User score "], [aria-label^="User score "]');
          const labelVal =
            userLabeledEl?.getAttribute('title') || userLabeledEl?.getAttribute('aria-label') || '';
          const labelMatch = labelVal.match(/User score\s+([0-9.]+)/i);
          if (labelMatch?.[1]) {
            rawUserScoreStr = labelMatch[1];
          } else {
            const globalVal = doc.querySelector('[data-testid="global-score-value"]')?.textContent?.trim();
            if (globalVal && /^[0-9.]+$/.test(globalVal)) {
              rawUserScoreStr = globalVal;
            } else {
              const userSpanVal = doc
                .querySelector('.c-siteReviewScore_user span, .c-siteReviewScore_user')
                ?.textContent?.trim();
              if (userSpanVal && /^[0-9.]+$/.test(userSpanVal)) {
                rawUserScoreStr = userSpanVal;
              }
            }
          }
        }
        if (!rawUserScoreStr) {
          const userScoreMatch =
            html.match(/(?:title|aria-label)=["']User score ([0-9.]+) out of 10["']/i) ||
            html.match(/data-testid="global-score-value">([0-9.]+)<\/span>/i) ||
            html.match(/c-siteReviewScore_user[^\"]*\"[^>]*><span>([0-9.]+)<\/span>/i) ||
            html.match(/class=\"[^\"]*c-siteReviewScore_user[^\"]*\"[^>]*title=\"User score ([0-9.]+)/i);
          rawUserScoreStr = userScoreMatch?.[1];
        }

        const bodyText = doc?.body?.textContent || html;
        const userCountMatch =
          bodyText.match(/Based on\s+([0-9,]+)\s+User (?:Ratings|Reviews)/i) ||
          bodyText.match(/([0-9,]+)\s+User (?:Ratings|Reviews)/i);

        if (rawUserScoreStr) {
          const rawScore = parseFloat(rawUserScoreStr);
          const rawCount =
            userCountMatch && userCountMatch[1]
              ? parseInt(userCountMatch[1].replace(/,/g, ''), 10)
              : 0;

          if (!isNaN(rawScore) && rawScore > 0 && rawScore <= 10 && rawCount >= 4) {
            const normalizedScore = Math.round(rawScore * 10);
            userData = {
              id: `mc-user-${slug}`,
              source: 'metacritic_user',
              score: normalizedScore,
              userScoreRaw: rawScore,
              tier: calculateTier(normalizedScore),
              numReviews: rawCount,
              url: `https://www.metacritic.com/game/${slug}/`,
              summary: `Metacritic user score (${rawScore}/10 based on ${rawCount} user reviews).`,
              isVerified: false,
              isSynthetic: false,
            };
          }
        }

        if (validatedPageStatus === 'defer_older' && validatedPageYear !== null) {
          return {
            critic: null,
            user: null,
            ...(criticData
              ? { deferredOlderCritic: { critic: criticData, user: userData, pageYear: validatedPageYear } }
              : userData
              ? { deferredOlderUser: { user: userData, pageYear: validatedPageYear } }
              : {}),
          };
        }

        if (userData && !fallbackUser) {
          fallbackUser = userData;
        }
        return { critic: criticData, user: userData };
      };

      const evaluateComposerPayload = (
        payload: MetacriticComposerResponse,
        slug: string,
        isAnchor: boolean
      ): { handled: boolean; result: SlugEvaluationResult; redirectSlug?: string } => {
        const { productItem, componentCriticSummary, componentUserSummary } =
          extractComposerProductNodes(payload);

        const hasProductOrScoreNode = Boolean(
          (productItem &&
            (productItem.title ||
              productItem.name ||
              productItem.criticScoreSummary ||
              productItem.userScoreSummary ||
              (Array.isArray(productItem.platforms) && productItem.platforms.length > 0))) ||
            componentCriticSummary ||
            componentUserSummary
        );

        const redirectSlug = extractComposerRedirectSlug(payload, slug);
        if (!hasProductOrScoreNode) {
          if (redirectSlug) {
            return { handled: false, result: { critic: null, user: null }, redirectSlug };
          }
          return { handled: false, result: { critic: null, user: null } };
        }

        const effectiveSlug =
          typeof productItem?.slug === 'string' && productItem.slug.trim()
            ? productItem.slug.trim().toLowerCase()
            : slug;
        const canonicalName =
          (typeof productItem?.title === 'string' && productItem.title.trim()) ||
          (typeof productItem?.name === 'string' && productItem.name.trim()) ||
          '';
        const description =
          typeof productItem?.description === 'string' ? productItem.description : undefined;

        const platforms = Array.isArray(productItem?.platforms) ? productItem.platforms : [];
        const pcPlatform = platforms.find((p) => {
          const pSlug = typeof p?.slug === 'string' ? p.slug.toLowerCase().trim() : '';
          const pName = typeof p?.name === 'string' ? p.name.toLowerCase().trim() : '';
          return pSlug === 'pc' || pName === 'pc';
        });
        const releaseDateStr =
          (typeof productItem?.releaseDate === 'string' && productItem.releaseDate) ||
          (typeof pcPlatform?.releaseDate === 'string' && pcPlatform.releaseDate) ||
          platforms.find((p) => typeof p?.releaseDate === 'string' && p.releaseDate)?.releaseDate ||
          '';
        const pageYear = extractYearFromDateString(releaseDateStr);

        const pageStatus = validatePageIdentity(canonicalName, pageYear, description, isAnchor);
        if (pageStatus === 'reject') {
          return { handled: true, result: { critic: null, user: null } };
        }

        let criticData: CriticScoreData | null = null;
        const selectedCritic = selectComposerCriticSummary(productItem, componentCriticSummary);
        if (
          selectedCritic &&
          typeof selectedCritic.score === 'number' &&
          selectedCritic.score > 0 &&
          typeof selectedCritic.reviewCount === 'number' &&
          selectedCritic.reviewCount >= 4
        ) {
          const score = Math.round(selectedCritic.score);
          if (
            !isAnchor &&
            typeof storefrontAnchor?.metacriticScore === 'number' &&
            storefrontAnchor.metacriticScore > 0 &&
            Math.abs(score - storefrontAnchor.metacriticScore) > 15
          ) {
            return { handled: true, result: { critic: null, user: null } };
          }
          criticData = {
            id: `mc-${effectiveSlug}`,
            source: 'metacritic',
            score,
            tier: calculateTier(score),
            numReviews: selectedCritic.reviewCount,
            url: `https://www.metacritic.com/game/${effectiveSlug}/critic-reviews/`,
            summary: sanitizeMetacriticDescription(description, selectedCritic.reviewCount),
            isVerified: true,
            isSynthetic: false,
          };
        }

        // Gated User Score (MCU) extraction: only reached after validatePageIdentity succeeded
        let userData: CriticScoreData | null = null;
        const userSummary =
          productItem?.userScoreSummary ??
          componentUserSummary ??
          pcPlatform?.userScoreSummary ??
          null;
        if (userSummary && typeof userSummary.score === 'number' && userSummary.score > 0) {
          const uCount = typeof userSummary.reviewCount === 'number' ? userSummary.reviewCount : 0;
          if (uCount >= 4) {
            const rawScore =
              userSummary.score <= 10
                ? Math.round(userSummary.score * 10) / 10
                : userSummary.max === 100 && userSummary.score <= 100
                ? Math.round(userSummary.score) / 10
                : 0;
            if (rawScore > 0 && rawScore <= 10) {
              const normalizedScore = Math.round(rawScore * 10);
              userData = {
                id: `mc-user-${effectiveSlug}`,
                source: 'metacritic_user',
                score: normalizedScore,
                userScoreRaw: rawScore,
                tier: calculateTier(normalizedScore),
                numReviews: uCount,
                url: `https://www.metacritic.com/game/${effectiveSlug}/`,
                summary: `Metacritic user score (${rawScore}/10 based on ${uCount} user reviews).`,
                isVerified: false,
                isSynthetic: false,
              };
            }
          }
        }

        if (pageStatus === 'defer_older' && pageYear !== null) {
          return {
            handled: true,
            result: {
              critic: null,
              user: null,
              ...(criticData
                ? { deferredOlderCritic: { critic: criticData, user: userData, pageYear } }
                : userData
                ? { deferredOlderUser: { user: userData, pageYear } }
                : {}),
            },
          };
        }

        if (userData && !fallbackUser) {
          fallbackUser = userData;
        }
        return { handled: true, result: { critic: criticData, user: userData } };
      };

      const evaluateSlug = async (
        slug: string,
        isAnchor = false,
        redirectDepth = 0,
        allowAnchorFallback = isAnchor
      ): Promise<SlugEvaluationResult> => {
        const composerBaseUrl = isViteBrowserDev()
          ? '/api/metacritic-backend'
          : 'https://backend.metacritic.com';
        const composerUrl = `${composerBaseUrl}/composer/metacritic/pages/games/${encodeURIComponent(slug)}/web`;

        let shouldFallbackToHtml = false;
        let definitiveNotFound = false;

        // Primary: Metacritic Composer JSON API (CORS-simple request: zero User-Agent/Referer headers)
        try {
          const composerRes = await requestScheduler.schedule(
            composerUrl,
            () =>
              fetch(composerUrl, {
                headers: {
                  Accept: 'application/json',
                },
                signal:
                  typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                    ? AbortSignal.timeout(6000)
                    : undefined,
              }),
            priority,
            'backend.metacritic.com'
          );

          const contentType = (composerRes.headers?.get?.('content-type') || '').toLowerCase();

          if (composerRes.ok) {
            const rawBody = await composerRes.text();
            if (isWafOrChallengeResponse(composerRes.status, rawBody, composerRes.headers)) {
              sawTransientError = true;
              shouldFallbackToHtml = true;
            } else if (
              contentType.includes('text/html') ||
              (!contentType.includes('application/json') &&
                /<(?:!doctype|html|head|body|script|div)\b/i.test(rawBody))
            ) {
              // Smart fallback: generic HTML fetch mock returned HTML directly for Composer URL
              return evaluateHtmlBody(rawBody, slug, isAnchor);
            } else {
              try {
                const parsed: unknown = JSON.parse(rawBody);
                if (parsed && typeof parsed === 'object') {
                  const composerEval = evaluateComposerPayload(
                    parsed as MetacriticComposerResponse,
                    slug,
                    isAnchor
                  );
                  if (composerEval.handled) {
                    return composerEval.result;
                  }
                  if (composerEval.redirectSlug && redirectDepth < 1) {
                    return evaluateSlug(
                      composerEval.redirectSlug,
                      isAnchor,
                      redirectDepth + 1,
                      allowAnchorFallback
                    );
                  }
                }
                // Composer returned 200 JSON lacking product/score nodes -> fall back to HTML
                shouldFallbackToHtml = true;
              } catch {
                shouldFallbackToHtml = true;
              }
            }
          } else if (composerRes.status === 404) {
            if (contentType.includes('application/json')) {
              // Genuine Composer JSON 404 -> definitive 404 immediately (zero double-404 on www.metacritic.com)
              definitiveNotFound = true;
            } else {
              // Bare 404 without application/json (e.g. inline fetch mock only handling www.metacritic.com)
              shouldFallbackToHtml = true;
            }
          } else {
            if (
              composerRes.status === 429 ||
              composerRes.status >= 500 ||
              isWafOrChallengeResponse(composerRes.status, '', composerRes.headers)
            ) {
              sawTransientError = true;
            }
            shouldFallbackToHtml = true;
          }
        } catch (err: unknown) {
          if (classifyNetworkError(err).status === 'transient_error') {
            sawTransientError = true;
          }
          shouldFallbackToHtml = true;
        }

        if (definitiveNotFound) {
          const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
          return { critic: anchorFallback, user: null };
        }

        if (!shouldFallbackToHtml) {
          return { critic: null, user: null };
        }

        // Smart HTML Fallback: www.metacritic.com/game/${slug}/ (CORS-simple request: zero User-Agent/Referer)
        const htmlUrl = isViteBrowserDev()
          ? `/api/metacritic/game/${slug}/`
          : `https://www.metacritic.com/game/${slug}/`;

        try {
          let res: Response | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              res = await requestScheduler.schedule(
                htmlUrl,
                () =>
                  fetch(htmlUrl, {
                    headers: {
                      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                    signal:
                      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                        ? AbortSignal.timeout(6000)
                        : undefined,
                  }),
                priority,
                'metacritic.com'
              );
              if (res.ok || res.status === 404) break;
              if (
                res.status === 429 ||
                res.status >= 500 ||
                isWafOrChallengeResponse(res.status, '', res.headers)
              ) {
                sawTransientError = true;
              }
            } catch (e: unknown) {
              if (classifyNetworkError(e).status === 'transient_error') {
                sawTransientError = true;
              }
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          }

          if (!res || !res.ok) {
            if (
              res &&
              (res.status === 429 ||
                res.status >= 500 ||
                isWafOrChallengeResponse(res.status, '', res.headers))
            ) {
              sawTransientError = true;
            }
            const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
            return { critic: anchorFallback, user: null };
          }

          const html = await res.text();
          if (isWafOrChallengeResponse(res.status, html, res.headers)) {
            sawTransientError = true;
            const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
            return { critic: anchorFallback, user: null };
          }

          return evaluateHtmlBody(html, slug, isAnchor);
        } catch {
          const anchorFallback = allowAnchorFallback ? buildAnchorFallbackCritic(slug) : null;
          return { critic: anchorFallback, user: null };
        }
      };

      const testedSlugs = new Set<string>();
      const baseCanonicalSlug = toCanonicalMetacriticSlug(title);

      // 1. If an anchor slug is present: evaluate anchor slug (with parenthetical year suffix if title specifies one).
      // When Step 1 synthesizes `${anchorSlug}-${queryYr}` (`primaryAnchorSlug !== anchorSlug`), do NOT
      // short-circuit straight to `buildAnchorFallbackCritic` on 404/error — probe `anchorSlug` directly
      // (with full `titleYear` validation) first and let Step 4 handle true anchor fallback.
      const queryYr = titleYear !== null ? String(titleYear) : undefined;
      const primaryAnchorSlug =
        queryYr && anchorSlug && !anchorSlug.endsWith(`-${queryYr}`) && anchorSlug !== queryYr
          ? `${anchorSlug}-${queryYr}`
          : anchorSlug;

      if (primaryAnchorSlug) {
        const isSynthesizedYearAnchor = primaryAnchorSlug !== anchorSlug;
        testedSlugs.add(primaryAnchorSlug);
        const evalRes = await evaluateSlug(primaryAnchorSlug, true, 0, !isSynthesizedYearAnchor);
        if (evalRes.critic) {
          const bundle: MetacriticBundle = { critic: evalRes.critic, user: evalRes.user || fallbackUser };
          this.setCacheBounded(cacheKey, bundle, title);
          return bundle;
        }
        recordDeferredOlder(evalRes);

        if (isSynthesizedYearAnchor && anchorSlug && !testedSlugs.has(anchorSlug)) {
          testedSlugs.add(anchorSlug);
          const baseAnchorEval = await evaluateSlug(anchorSlug, true, 0, false);
          if (baseAnchorEval.critic) {
            const bundle: MetacriticBundle = {
              critic: baseAnchorEval.critic,
              user: baseAnchorEval.user || fallbackUser,
            };
            this.setCacheBounded(cacheKey, bundle, title);
            return bundle;
          }
          recordDeferredOlder(baseAnchorEval);
        }
      }

      // 2. Direct candidate probing with candidateLimit = 4
      const candidateLimit = 4;
      const step2Queue: string[] = [];
      for (const slug of slugs) {
        if (!testedSlugs.has(slug)) {
          step2Queue.push(slug);
        }
        if (step2Queue.length + testedSlugs.size >= candidateLimit) {
          break;
        }
      }

      for (let i = 0; i < step2Queue.length; i++) {
        const slug = step2Queue[i];
        if (testedSlugs.has(slug)) continue;
        testedSlugs.add(slug);
        const isAnchor = Boolean(anchorSlug && isAnchorMatch(slug, anchorSlug));
        const evalRes = await evaluateSlug(slug, isAnchor, 0, false);
        if (evalRes.critic) {
          const bundle: MetacriticBundle = { critic: evalRes.critic, user: evalRes.user || fallbackUser };
          this.setCacheBounded(cacheKey, bundle, title);
          return bundle;
        }
        recordDeferredOlder(evalRes);

        // Two-phase remake protection (Trap T1): when an older page is deferred, guarantee
        // `${base}-${paramYear}` is probed in Step 2 before proceeding to Step 3 Finder!
        if (
          (evalRes.deferredOlderCritic || evalRes.deferredOlderUser) &&
          titleYear === null &&
          paramYear !== null &&
          baseCanonicalSlug &&
          !baseCanonicalSlug.endsWith(`-${paramYear}`)
        ) {
          const yearProbeSlug = `${baseCanonicalSlug}-${paramYear}`;
          if (!testedSlugs.has(yearProbeSlug) && !step2Queue.includes(yearProbeSlug)) {
            step2Queue.push(yearProbeSlug);
          }
        }
      }

      // 3. Query Metacritic backend finder search API to discover verified slugs (and check for modern remakes)
      let modernRemakeExistsInFinder = false;
      let finderSucceeded = false;
      try {
        const markSearchTransient = () => {
          sawTransientError = true;
        };
        const markSearchSuccess = () => {
          finderSucceeded = true;
        };
        let searchCandidates = await searchMetacriticCandidates(title, priority, {
          onTransientError: markSearchTransient,
          onSuccess: markSearchSuccess,
        });
        let ranked = rankCandidateSlugs(title, searchCandidates, storefrontAnchor);

        const midNumeralQuery = stripIntermediateSubtitleNumeral(title);
        if (ranked.length === 0 && midNumeralQuery && midNumeralQuery !== title) {
          const midSearchCandidates = await searchMetacriticCandidates(midNumeralQuery, priority, {
            onTransientError: markSearchTransient,
            onSuccess: markSearchSuccess,
          });
          if (midSearchCandidates.length > 0) {
            searchCandidates = midSearchCandidates;
            ranked = rankCandidateSlugs(title, searchCandidates, storefrontAnchor);
          }
        }

        const phraseStrippedForSearch = stripPackagingEditionPhrases(stripYearEditionPhrases(title));
        const strippedSlug = stripMetacriticEditionSlug(
          toCanonicalMetacriticSlug(phraseStrippedForSearch) || baseCanonicalSlug
        );
        if (ranked.length === 0 && strippedSlug && strippedSlug !== baseCanonicalSlug) {
          const strippedQuery = strippedSlug.replace(/-/g, ' ');
          searchCandidates = await searchMetacriticCandidates(strippedQuery, priority, {
            onTransientError: markSearchTransient,
            onSuccess: markSearchSuccess,
          });
          ranked = rankCandidateSlugs(strippedQuery, searchCandidates, storefrontAnchor);
        }

        // Check whether Finder contains ANY title-compatible modern remake within ±2 years of paramYear
        const modernRemakeSlugs: string[] = [];
        if (titleYear === null && paramYear !== null) {
          for (const cand of searchCandidates) {
            const candYear = extractYearFromDateString(cand.releaseDate);
            if (candYear === null || Math.abs(candYear - paramYear) > 2) continue;
            const candTitle = cand.title || cand.slug.replace(/-/g, ' ');
            const isCompat =
              !isSequelMismatch(title, candTitle) &&
              (!cand.title || isTitleCompatible(title, cand.title));
            if (isCompat) {
              modernRemakeExistsInFinder = true;
              if (!modernRemakeSlugs.includes(cand.slug)) {
                modernRemakeSlugs.push(cand.slug);
              }
            }
          }
        }

        const step3Slugs = Array.from(new Set([...modernRemakeSlugs, ...ranked.slice(0, 2)]));

        for (const s of step3Slugs) {
          const isAnchor = Boolean(anchorSlug && isAnchorMatch(s, anchorSlug));
          if (!testedSlugs.has(s)) {
            testedSlugs.add(s);
            const evalRes = await evaluateSlug(s, isAnchor, 0, false);
            if (evalRes.critic) {
              const bundle: MetacriticBundle = {
                critic: evalRes.critic,
                user: evalRes.user || fallbackUser,
              };
              this.setCacheBounded(cacheKey, bundle, title);
              return bundle;
            }
            recordDeferredOlder(evalRes);
          }

          // Fallback to official Metacritic backend Finder JSON score if Composer/HTML was blocked/failed
          const searchCand = searchCandidates.find((c) => c.slug === s);
          if (
            searchCand &&
            typeof searchCand.score === 'number' &&
            searchCand.score > 0 &&
            (!searchCand.title || isTitleCompatible(title, searchCand.title))
          ) {
            const candYear = extractYearFromDateString(searchCand.releaseDate);
            const candTitleForGuard = searchCand.title || s.replace(/-/g, ' ');
            const candHasFirstInstallment = /\b(?:1|i)\b/i.test(candTitleForGuard);
            const candHasRetroKeyword = /\b(classic|original|plus|dos)\b/i.test(candTitleForGuard);
            const isRebootMismatch =
              ((queryHasExplicitFirstInstallment && !candHasFirstInstallment) ||
                (isExplicitRetroQuery && !candHasRetroKeyword)) &&
              Boolean(candYear && candYear >= 2008);
            const yearStatus = evaluateReleaseYearCompatibility(candYear, isAnchor);
            if (!isRebootMismatch && yearStatus !== 'reject') {
              const jsonScore = Math.round(searchCand.score);
              const jsonCritic: CriticScoreData = {
                id: `mc-${s}`,
                source: 'metacritic',
                score: jsonScore,
                tier: calculateTier(jsonScore),
                numReviews: 20,
                url: `https://www.metacritic.com/game/${s}/critic-reviews/`,
                summary: `Metacritic consensus score based on critic reviews.`,
                isVerified: true,
                isSynthetic: false,
              };
              if (yearStatus === 'accept') {
                const bundle: MetacriticBundle = { critic: jsonCritic, user: fallbackUser };
                this.setCacheBounded(cacheKey, bundle, title);
                return bundle;
              }
              if (yearStatus === 'defer_older' && candYear !== null && !deferredOlderCritic) {
                deferredOlderCritic = { critic: jsonCritic, user: null, pageYear: candYear };
              }
            }
          }
        }
      } catch {
        sawTransientError = true;
      }

      // Two-phase promotion: ONLY promote deferredOlderCritic / deferredOlderUser when Finder returned
      // a valid HTTP 200 non-WAF JSON response (`finderSucceeded`), no transient error occurred
      // (`!sawTransientError`), AND no ±2-year modern remake exists in Finder (`!modernRemakeExistsInFinder`).
      const promotedOlderCritic = deferredOlderCritic as DeferredOlderCritic | null;
      if (
        promotedOlderCritic &&
        finderSucceeded &&
        !sawTransientError &&
        !modernRemakeExistsInFinder
      ) {
        const bundle: MetacriticBundle = {
          critic: promotedOlderCritic.critic,
          user: promotedOlderCritic.user || fallbackUser,
        };
        this.setCacheBounded(cacheKey, bundle, title);
        return bundle;
      }

      const promotedOlderUser = deferredOlderUser as DeferredOlderUser | null;
      if (
        !fallbackUser &&
        promotedOlderUser &&
        finderSucceeded &&
        !sawTransientError &&
        !modernRemakeExistsInFinder
      ) {
        fallbackUser = promotedOlderUser.user;
      }

      if ((promotedOlderCritic || promotedOlderUser) && !finderSucceeded) {
        sawTransientError = true;
      }

      // 4. Final Storefront Anchor ground-truth fallback if Composer/HTML & backend search failed
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        const fallbackSlug =
          anchorSlug ||
          storefrontAnchor.metacriticSlug ||
          toCanonicalMetacriticSlug(title);
        if (fallbackSlug && isAnchorSlugCompatible(title, fallbackSlug)) {
          const anchorCritic: CriticScoreData = {
            id: `mc-${fallbackSlug}`,
            source: 'metacritic',
            score: storefrontAnchor.metacriticScore,
            tier: calculateTier(storefrontAnchor.metacriticScore),
            numReviews: 20,
            url:
              storefrontAnchor.metacriticUrl ||
              `https://www.metacritic.com/game/${fallbackSlug}/critic-reviews/`,
            summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
            isVerified: true,
            isSynthetic: false,
          };
          const bundle: MetacriticBundle = {
            critic: anchorCritic,
            user: fallbackUser,
            ...(!onlineLifecycleManager.isOnline() && !fallbackUser
              ? { offlinePartialUserScore: true }
              : {}),
          };
          this.setCacheBounded(cacheKey, bundle, title);
          return bundle;
        }
      }

      // If no critic data was found across all candidates, return fallback user score (or null)
      const finalBundle: MetacriticBundle = { critic: null, user: fallbackUser };
      if (finalBundle.critic === null && finalBundle.user === null && (sawTransientError || !onlineLifecycleManager.isOnline())) {
        this.transientFailureTitles.add(title.toLowerCase());
        return finalBundle;
      }
      this.setCacheBounded(cacheKey, finalBundle, title);
      return finalBundle;
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolves verified Critic score only.
   */
  async resolveCriticScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.critic;
  }

  /**
   * Resolves verified User score only.
   */
  async resolveUserScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.user;
  }

  /**
   * Backward-compatible resolveScore: returns Critic score if available, otherwise User score.
   */
  async resolveScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.critic || bundle.user;
  }

  public evictForGame(rawTitle?: string | null): void {
    const titleLower = (rawTitle || '').trim().toLowerCase();
    if (!titleLower) return;
    this.transientFailureTitles.delete(titleLower);
    const keysToDelete = new Set<string>([titleLower]);
    const exactSet = this.cacheKeysByTitle.get(titleLower);
    if (exactSet) {
      for (const k of exactSet) keysToDelete.add(k);
    }
    const normTitle = normalizeTitleKey(titleLower);
    if (normTitle && normTitle !== titleLower) {
      this.transientFailureTitles.delete(normTitle);
      keysToDelete.add(normTitle);
      const normSet = this.cacheKeysByTitle.get(normTitle);
      if (normSet) {
        for (const k of normSet) keysToDelete.add(k);
      }
    }
    for (const k of keysToDelete) {
      this.deleteCacheKey(k);
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheKeysByTitle.clear();
    this.cacheKeyToTitleKeys.clear();
    this.inFlight.clear();
    this.transientFailureTitles.clear();
  }
}

export const metacriticResolver = new MetacriticResolver();
