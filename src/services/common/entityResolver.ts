import {
  normalizeTitleKey,
  stripEditionSuffix,
  stripYearEditionPhrases,
  alignCompoundWordTokens,
  extractSequelIdentifier,
  isSequelMismatch,
  ROMAN_TO_ARABIC,
  EDITION_TOKENS,
} from './titleUtils';

export interface EntityAttributes {
  title: string;
  releaseYear?: number | string | null;
  developers?: string[];
  publishers?: string[];
  steamAppId?: number | null;
  platformId?: string;
}

export interface EntityMatchEvaluation {
  confidence: number; // 0 to 100
  titleScore: number; // 0 to 100
  yearAdjustment: number; // e.g. +15, 0, or -35 on reboot mismatch
  developerBonus: number; // e.g. +15 on developer/publisher overlap
  isRebootCollision: boolean;
  needsMatchReview: boolean; // true when 55 <= confidence < 80
  isAccepted: boolean; // true when confidence >= 68 and !isRebootCollision
}

const REMASTER_EDITION_REGEX =
  /\b(remastered|remaster|definitive|enhanced|anniversary|complete|goty|game of the year|director'?s cut|redux)\b/i;

const PAREN_YEAR_REGEX = /\((19\d\d|20\d\d)\)/;

const CORPORATE_STOP_WORDS = new Set<string>([
  'inc',
  'llc',
  'ltd',
  'studios',
  'studio',
  'entertainment',
  'games',
  'game',
  'interactive',
  'software',
  'digital',
  'publishing',
  'co',
  'corp',
  'corporation',
  'company',
  'limited',
  'gmbh',
  'ab',
  'sa',
  'plc',
  'the',
  'and',
]);

/**
 * Extracts a valid 4-digit release year (1975 to currentYear+10) from a number or date/title string,
 * rejecting storefront sentinel years (e.g. 0001, 1900, 2099, 2799, 9998).
 */
export function parseReleaseYear(val?: number | string | null): number | null {
  if (val === undefined || val === null) return null;
  const maxAllowedYear = new Date().getFullYear() + 10;
  if (typeof val === 'number') {
    if (Number.isFinite(val) && val >= 1975 && val <= maxAllowedYear) {
      return Math.floor(val);
    }
    return null;
  }
  const str = String(val).trim();
  if (!str) return null;
  const isoLead = str.match(/^(\d{4})-\d{2}-\d{2}/);
  if (isoLead) {
    const yr = parseInt(isoLead[1], 10);
    return Number.isFinite(yr) && yr >= 1975 && yr <= maxAllowedYear ? yr : null;
  }
  const match = str.match(/\b(19\d\d|20\d\d)\b/);
  if (match) {
    const yr = parseInt(match[1], 10);
    return yr >= 1975 && yr <= maxAllowedYear ? yr : null;
  }
  return null;
}

function extractParentheticalYear(title: string): number | null {
  if (!title) return null;
  const maxAllowedYear = new Date().getFullYear() + 10;
  const match = title.match(PAREN_YEAR_REGEX);
  if (!match) return null;
  const yr = parseInt(match[1], 10);
  return yr >= 1975 && yr <= maxAllowedYear ? yr : null;
}

function extractOrgTokens(orgs?: string[]): Set<string> {
  const tokens = new Set<string>();
  if (!Array.isArray(orgs)) return tokens;
  for (const org of orgs) {
    if (!org) continue;
    const words = org
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !CORPORATE_STOP_WORDS.has(w));
    for (const w of words) {
      tokens.add(w);
    }
  }
  return tokens;
}

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

function computeBaseTitleSimilarity(source: string, candidate: string): number {
  const cleanSource = stripYearEditionPhrases(source);
  const cleanCandidate = stripYearEditionPhrases(candidate);
  const s1 = normalizeTitleKey(cleanSource);
  const s2 = normalizeTitleKey(cleanCandidate);

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const rawWords1 = s1.split(' ').filter(Boolean);
  const rawWords2 = s2.split(' ').filter(Boolean);

  const seq1 = extractSequelIdentifier(rawWords1);
  const seq2 = extractSequelIdentifier(rawWords2);
  if (seq1 !== seq2) {
    return 0;
  }

  const mappedWords1 = seq1 !== null ? rawWords1.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords1;
  const mappedWords2 = seq2 !== null ? rawWords2.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords2;
  const [words1, words2] = alignCompoundWordTokens(mappedWords1, mappedWords2);

  if (words1.join(' ') === words2.join(' ')) {
    return 1.0;
  }

  const stripped1 = stripEditionSuffix(cleanSource);
  const stripped2 = stripEditionSuffix(cleanCandidate);
  if (stripped1 && stripped1.length >= 2 && stripped1 === stripped2) {
    return 0.92;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  // Prevent distinct subtitled franchise entries with mutually exclusive non-edition substantive words
  // (e.g. 'Vampire: The Masquerade - Reckoning of New York' vs 'Vampire: The Masquerade - Coteries of New York')
  if (/[:\-–—]/.test(cleanSource) || /[:\-–—]/.test(cleanCandidate)) {
    const substantive1 = words1.filter((w) => !/^\d+$/.test(w) && !EDITION_TOKENS.has(w) && !DISJOINT_STOP_WORDS.has(w));
    const substantive2 = words2.filter((w) => !/^\d+$/.test(w) && !EDITION_TOKENS.has(w) && !DISJOINT_STOP_WORDS.has(w));
    const disjoint1 = substantive1.filter((w) => !tokens2.has(w));
    const disjoint2 = substantive2.filter((w) => !tokens1.has(w));
    if (disjoint1.length >= 1 && disjoint2.length >= 1) {
      return 0;
    }
  }

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  if (union === 0) return 0;
  const jaccard = intersection / union;

  // Single word checks: must match an exact word token in candidate
  if (words1.length === 1 && !tokens2.has(words1[0])) {
    return 0;
  }
  if (words2.length === 1 && !tokens1.has(words2[0])) {
    return 0;
  }

  // Intelligent Edition Variant Matching
  const [shorterWords, longerWords] = words1.length <= words2.length ? [words1, words2] : [words2, words1];
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

  // Exact multi-word phrase containment (only when sharing an explicit sequel number or article/edition-only tokens)
  const joined1 = words1.join(' ');
  const joined2 = words2.join(' ');
  if (seq1 !== null && seq1 === seq2 && words1.length >= 2 && (joined1.includes(joined2) || joined2.includes(joined1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
}

function extractBilingualTitleVariants(title: string): string[] {
  const variants = [title];
  if (title.includes(' / ')) {
    for (const part of title.split(' / ')) {
      const trimmed = part.trim();
      if (trimmed && normalizeTitleKey(trimmed).length >= 3 && !variants.includes(trimmed)) {
        variants.push(trimmed);
      }
    }
  }
  return variants;
}

function evaluateSingleTitlePair(
  srcTitle: string,
  candTitle: string,
  source: EntityAttributes,
  candidate: EntityAttributes,
  srcYear: number | null,
  candYear: number | null,
  srcParenYear: number | null,
  candParenYear: number | null
): EntityMatchEvaluation {
  const zeroResult: EntityMatchEvaluation = {
    confidence: 0,
    titleScore: 0,
    yearAdjustment: 0,
    developerBonus: 0,
    isRebootCollision: false,
    needsMatchReview: false,
    isAccepted: false,
  };

  // Strip parenthetical release years (e.g. "(2016)", "(1993)") and Year Pass suffixes for title token comparison
  const cleanSrcTitle = stripYearEditionPhrases(srcTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '')).trim();
  const cleanCandTitle = stripYearEditionPhrases(candTitle.replace(/\s*\((?:19|20)\d{2}\)/g, '')).trim();

  if (!cleanSrcTitle || !cleanCandTitle) {
    return zeroResult;
  }

  // Sequel / variant safeguard (allow remaster edition suffixes to be evaluated via year/edition rules)
  const srcForSequelCheck = cleanSrcTitle.replace(/\bremaster(?:ed)?\b/gi, '').trim() || cleanSrcTitle;
  const candForSequelCheck = cleanCandTitle.replace(/\bremaster(?:ed)?\b/gi, '').trim() || cleanCandTitle;

  if (isSequelMismatch(srcForSequelCheck, candForSequelCheck)) {
    return zeroResult;
  }

  const baseSim = computeBaseTitleSimilarity(cleanSrcTitle, cleanCandTitle);
  const titleScore = Math.round(baseSim * 100);

  if (titleScore === 0) {
    return zeroResult;
  }

  let yearAdjustment = 0;
  let developerBonus = 0;
  let isRebootCollision = false;

  const isRemaster =
    REMASTER_EDITION_REGEX.test(source.title) || REMASTER_EDITION_REGEX.test(candidate.title);

  // Developer / Publisher Overlap (computed first so verified same-studio storefront ports are recognized)
  const srcOrgTokens = extractOrgTokens([...(source.developers || []), ...(source.publishers || [])]);
  const candOrgTokens = extractOrgTokens([...(candidate.developers || []), ...(candidate.publishers || [])]);

  let hasDisjointDevelopers = false;
  if (srcOrgTokens.size > 0 && candOrgTokens.size > 0) {
    const hasOverlap = Array.from(srcOrgTokens).some((t) => candOrgTokens.has(t));
    if (hasOverlap) {
      developerBonus = 12;
    } else {
      const srcDevTokens = extractOrgTokens(source.developers);
      const candDevTokens = extractOrgTokens(candidate.developers);
      if (srcDevTokens.size > 0 && candDevTokens.size > 0) {
        hasDisjointDevelopers = true;
      }
    }
  }

  // Release Year Proximity
  if (srcYear !== null && candYear !== null) {
    const diff = Math.abs(srcYear - candYear);
    const isLaterSameDeveloperPort =
      srcYear > candYear &&
      diff <= 16 &&
      developerBonus > 0 &&
      srcParenYear === null &&
      candParenYear === null;

    if (diff <= 1) {
      yearAdjustment = 12;
    } else if (diff <= 2) {
      yearAdjustment = 6;
    } else if (diff >= 4 && !isRemaster && !isLaterSameDeveloperPort) {
      yearAdjustment = -35;
      isRebootCollision = true;
    }

    if (hasDisjointDevelopers && diff >= 3 && !isRemaster) {
      isRebootCollision = true;
      yearAdjustment = Math.min(yearAdjustment, -35);
    }
  }

  const confidence = Math.max(0, Math.min(100, Math.round(titleScore + yearAdjustment + developerBonus)));
  const isAccepted = confidence >= 68 && !isRebootCollision;
  const needsMatchReview = !isRebootCollision && confidence >= 55 && confidence < 80;

  return {
    confidence,
    titleScore,
    yearAdjustment,
    developerBonus,
    isRebootCollision,
    needsMatchReview,
    isAccepted,
  };
}

/**
 * Evaluates multi-vector entity match confidence between a source game and a candidate game,
 * combining title token similarity, sequel safeguarding, release year proximity, and developer/publisher corroboration.
 */
export function computeEntityMatchConfidence(
  source: EntityAttributes,
  candidate: EntityAttributes
): EntityMatchEvaluation {
  const zeroResult: EntityMatchEvaluation = {
    confidence: 0,
    titleScore: 0,
    yearAdjustment: 0,
    developerBonus: 0,
    isRebootCollision: false,
    needsMatchReview: false,
    isAccepted: false,
  };

  if (!source?.title || !candidate?.title) {
    return zeroResult;
  }

  const srcParenYear = extractParentheticalYear(source.title);
  const candParenYear = extractParentheticalYear(candidate.title);
  const srcYear = parseReleaseYear(source.releaseYear) ?? srcParenYear;
  const candYear = parseReleaseYear(candidate.releaseYear) ?? candParenYear;

  const srcVariants = extractBilingualTitleVariants(source.title);
  const candVariants = extractBilingualTitleVariants(candidate.title);

  let best: EntityMatchEvaluation | null = null;
  for (const sVar of srcVariants) {
    for (const cVar of candVariants) {
      const ev = evaluateSingleTitlePair(
        sVar,
        cVar,
        source,
        candidate,
        srcYear,
        candYear,
        srcParenYear,
        candParenYear
      );
      if (
        !best ||
        (ev.isAccepted && !best.isAccepted) ||
        (ev.isAccepted === best.isAccepted && ev.confidence > best.confidence)
      ) {
        best = ev;
      }
    }
  }

  return best || zeroResult;
}

export { normalizeTitleKey, stripEditionSuffix, extractSequelIdentifier, isSequelMismatch, EDITION_TOKENS };
