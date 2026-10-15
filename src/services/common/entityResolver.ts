import {
  normalizeTitleKey,
  stripEditionSuffix,
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
 * Extracts a 4-digit release year (1900-2099) from a number or date/title string.
 */
export function parseReleaseYear(val?: number | string | null): number | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') {
    if (Number.isFinite(val) && val >= 1900 && val <= 2099) {
      return Math.floor(val);
    }
    return null;
  }
  const str = String(val).trim();
  if (!str) return null;
  const match = str.match(/\b(19\d\d|20\d\d)\b/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function extractParentheticalYear(title: string): number | null {
  if (!title) return null;
  const match = title.match(PAREN_YEAR_REGEX);
  return match ? parseInt(match[1], 10) : null;
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
  const s1 = normalizeTitleKey(source);
  const s2 = normalizeTitleKey(candidate);

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  const rawWords1 = s1.split(' ').filter(Boolean);
  const rawWords2 = s2.split(' ').filter(Boolean);

  const seq1 = extractSequelIdentifier(rawWords1);
  const seq2 = extractSequelIdentifier(rawWords2);
  if (seq1 !== seq2) {
    return 0;
  }

  const words1 = seq1 !== null ? rawWords1.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords1;
  const words2 = seq2 !== null ? rawWords2.map((w) => ROMAN_TO_ARABIC[w] || w) : rawWords2;

  if (words1.join(' ') === words2.join(' ')) {
    return 1.0;
  }

  const tokens1 = new Set(words1);
  const tokens2 = new Set(words2);

  // Prevent distinct subtitled franchise entries with mutually exclusive non-edition substantive words
  // (e.g. 'Vampire: The Masquerade - Reckoning of New York' vs 'Vampire: The Masquerade - Coteries of New York')
  if (/[:\-–—]/.test(source) || /[:\-–—]/.test(candidate)) {
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
  if (seq1 !== null && seq1 === seq2 && words1.length >= 2 && (s1.includes(s2) || s2.includes(s1))) {
    const minWords = Math.min(words1.length, words2.length);
    const maxWords = Math.max(words1.length, words2.length);
    if (minWords / maxWords >= 0.5 && intersection >= minWords) {
      return 0.88;
    }
  }

  return jaccard;
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

  const srcYear = parseReleaseYear(source.releaseYear) ?? extractParentheticalYear(source.title);
  const candYear = parseReleaseYear(candidate.releaseYear) ?? extractParentheticalYear(candidate.title);

  // Strip parenthetical release years (e.g. "(2016)", "(1993)") for title token comparison
  const cleanSrcTitle = source.title.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
  const cleanCandTitle = candidate.title.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();

  if (!cleanSrcTitle || !cleanCandTitle) {
    return zeroResult;
  }

  // Sequel / variant safeguard (allow remaster edition suffixes to be evaluated via year/edition rules)
  const srcForSequelCheck = cleanSrcTitle.replace(/\bremastered\b/gi, '').trim() || cleanSrcTitle;
  const candForSequelCheck = cleanCandTitle.replace(/\bremastered\b/gi, '').trim() || cleanCandTitle;

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

  // Release Year Proximity
  if (srcYear !== null && candYear !== null) {
    const diff = Math.abs(srcYear - candYear);
    if (diff <= 1) {
      yearAdjustment = 12;
    } else if (diff <= 2) {
      yearAdjustment = 6;
    } else if (diff >= 4 && !isRemaster) {
      yearAdjustment = -35;
      isRebootCollision = true;
    }
  }

  // Developer / Publisher Overlap
  const srcOrgTokens = extractOrgTokens([...(source.developers || []), ...(source.publishers || [])]);
  const candOrgTokens = extractOrgTokens([...(candidate.developers || []), ...(candidate.publishers || [])]);

  if (srcOrgTokens.size > 0 && candOrgTokens.size > 0) {
    const hasOverlap = Array.from(srcOrgTokens).some((t) => candOrgTokens.has(t));
    if (hasOverlap) {
      developerBonus = 12;
    } else {
      const srcDevTokens = extractOrgTokens(source.developers);
      const candDevTokens = extractOrgTokens(candidate.developers);
      if (
        srcDevTokens.size > 0 &&
        candDevTokens.size > 0 &&
        srcYear !== null &&
        candYear !== null &&
        Math.abs(srcYear - candYear) >= 3 &&
        !isRemaster
      ) {
        isRebootCollision = true;
        yearAdjustment = Math.min(yearAdjustment, -35);
      }
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

export { normalizeTitleKey, stripEditionSuffix, extractSequelIdentifier, isSequelMismatch, EDITION_TOKENS };
