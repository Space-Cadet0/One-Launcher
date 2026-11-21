/**
 * Title normalization, release-year cache key resolution, sequel-safe token similarity,
 * and Lutris/IGDB cover candidate ranking.
 *
 * Imports `isTitleCompatible` from Layer 0 (`../common/titleMatching`) rather than
 * `../critic/metacriticResolver`, eliminating reverse service coupling.
 */

import {
  isSequelMismatch,
  normalizeTitleKey,
  extractSequelIdentifier,
  extractParentheticalReleaseYear,
  extractTrailingDelimitedReleaseYear,
  stripStorefrontPlatformDisambiguators,
  stripTrademarkSymbols,
  decodeTitleHtmlEntities,
  EDITION_TOKENS,
} from '../common/titleUtils';
import { isTitleCompatible } from '../common/titleMatching';

export interface LutrisSearchItem {
  name?: string;
  year?: number | string | null;
  coverart?: string | null;
}

export interface ResolvedCoverCacheKeys {
  cleanRaw: string;
  norm: string;
  effectiveReleaseYear: number | null;
  cacheKey: string;
}

const EDITION_WORDS = new Set<string>([
  'complete',
  'definitive',
  'enhanced',
  'goty',
  'deluxe',
  'gold',
  'standard',
  'remastered',
  'remaster',
  'directors',
  'director',
  'cut',
  'edition',
  'collectors',
  'collector',
  'anniversary',
  'special',
  'ultimate',
  'extended',
  'game',
  'year',
  'final',
  'royal',
  'emperor',
  'classics',
  'classic',
  'plus',
  'bundle',
  'pack',
  'package',
  'collection',
  'upgrade',
  'vr',
  'hd',
  'digital',
  'gog',
  'steam',
  'epic',
]);

const TOKEN_STOP_WORDS = new Set<string>([
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'a',
  'an',
]);

export function normalizeKey(str: string): string {
  return stripStorefrontPlatformDisambiguators(
    stripTrademarkSymbols(decodeTitleHtmlEntities(str))
  )
    .toLowerCase()
    .replace(/['\u2018\u2019\u02BC]/g, '')
    .replace(/\s*\((?:19|20)\d{2}\)/g, '')
    .replace(/[:\-–—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes a persistent cover cache key while preserving an explicit `:YYYY` release year suffix.
 */
export function normalizeCacheKey(rawKey: string): string {
  const m = rawKey.match(/^(.*):((?:19|20)\d{2})$/);
  if (m) {
    return `${normalizeKey(m[1])}:${m[2]}`;
  }
  return normalizeKey(rawKey);
}

/**
 * Parses an explicit 4-digit release year parameter (`number` or date/year string).
 */
export function parseExplicitReleaseYear(releaseYear?: number | string | null): number | null {
  if (releaseYear === undefined || releaseYear === null || releaseYear === '') {
    return null;
  }
  const str = String(releaseYear).trim();
  if (!str) return null;
  const match = str.match(/\b(19\d{2}|20\d{2})\b/);
  const parsed = match ? Number(match[1]) : Number(str);
  if (!Number.isFinite(parsed) || parsed < 1975 || parsed > 2099) {
    return null;
  }
  return Math.floor(parsed);
}

/**
 * Extracts an explicitly delimited disambiguation release year from a title
 * (`"Prey (2006)"`, `"Battlefront II (Classic, 2005)"`, `"Oblivion – 2009"`),
 * without misclassifying bare title numbers (`"Cyberpunk 2077"`, `"Battlefield 1942"`).
 */
export function extractTitleExplicitReleaseYear(title: string): number | null {
  return extractParentheticalReleaseYear(title) ?? extractTrailingDelimitedReleaseYear(title);
}

/**
 * Resolves normalized and year-scoped cache keys for cover lookups.
 */
export function resolveCoverCacheKeys(
  title: string,
  releaseYear?: number | string | null
): ResolvedCoverCacheKeys {
  const cleanRaw = title.trim();
  const norm = normalizeKey(cleanRaw);

  const parsedParamYear = parseExplicitReleaseYear(releaseYear);
  const titleYear = extractTitleExplicitReleaseYear(cleanRaw);
  const effectiveReleaseYear = parsedParamYear ?? titleYear;

  const cacheKey = effectiveReleaseYear !== null ? `${norm}:${effectiveReleaseYear}` : norm;
  return { cleanRaw, norm, effectiveReleaseYear, cacheKey };
}

/**
 * Matches numbered series titles when the storefront omits the subtitle while IGDB/Lutris
 * includes a colon subtitle (e.g. "Ultima Underworld I" <-> "Ultima Underworld: The Stygian Abyss",
 * "Ultima Underworld II" <-> "Ultima Underworld II: Labyrinth of Worlds").
 */
export function isNumberedBaseTitleSubtitleMatch(
  queryTitle: string,
  candidateTitle: string
): boolean {
  if (!queryTitle || !candidateTitle) return false;
  if (queryTitle.includes(':') || !candidateTitle.includes(':')) return false;

  const cleanQ = queryTitle.replace(/[™®©]/g, '').trim();
  const candBase = candidateTitle.split(':')[0].replace(/[™®©]/g, '').trim();
  if (!cleanQ || !candBase) return false;

  // Must end with an explicit Roman or Arabic sequel numeral
  if (!/\b(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|1|2|3|4|5|6|7|8|9|10)\s*$/i.test(cleanQ)) {
    return false;
  }

  // Case A: Exact base + numeral match (e.g. "Ultima Underworld II" === "Ultima Underworld II")
  if (
    !isSequelMismatch(cleanQ, candBase) &&
    normalizeTitleKey(cleanQ) === normalizeTitleKey(candBase)
  ) {
    return true;
  }

  // Case B: Explicit Part I / 1 vs original subtitled first entry without numeral
  if (/\b(?:i|1)\s*$/i.test(cleanQ) && extractSequelIdentifier(candidateTitle) === null) {
    const strippedQ = cleanQ.replace(/\s+\b(?:i|1)\s*$/i, '').trim();
    const baseWords = normalizeTitleKey(candBase).split(/\s+/).filter(Boolean);
    if (baseWords.length >= 2 && normalizeTitleKey(strippedQ) === normalizeTitleKey(candBase)) {
      return true;
    }
  }

  return false;
}

export function computeTokenSimilarity(t1: string, t2: string): number {
  const numberedSubtitleMatch =
    isNumberedBaseTitleSubtitleMatch(t1, t2) || isNumberedBaseTitleSubtitleMatch(t2, t1);
  if (!numberedSubtitleMatch) {
    if (isSequelMismatch(t1, t2)) return 0;
    if (!isTitleCompatible(t1, t2)) return 0;
  } else {
    return 0.92;
  }

  const cleanT1 = normalizeTitleKey(t1);
  const cleanT2 = normalizeTitleKey(t2);
  const list1 = cleanT1
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TOKEN_STOP_WORDS.has(w));
  const list2 = cleanT2
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TOKEN_STOP_WORDS.has(w));
  const words1 = new Set(list1);
  const words2 = new Set(list2);
  if (words1.size === 0 || words2.size === 0) return 0;

  // Intelligent Edition Variant Matching
  const [shorterSet, longerList] = words1.size <= words2.size ? [words1, list2] : [words2, list1];
  let allShorterInLonger = true;
  for (const w of shorterSet) {
    if (!longerList.includes(w)) {
      allShorterInLonger = false;
      break;
    }
  }
  if (allShorterInLonger) {
    let onlyEditionTokensRemaining = true;
    for (const w of longerList) {
      if (!shorterSet.has(w) && !EDITION_TOKENS.has(w) && !EDITION_WORDS.has(w)) {
        onlyEditionTokensRemaining = false;
        break;
      }
    }
    if (onlyEditionTokensRemaining) {
      return 0.92;
    }
  }

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  return intersection / Math.max(words1.size, words2.size);
}

/**
 * Selects the highest-scoring sequel-safe and era-verified portrait cover URL from Lutris results.
 */
export function selectBestLutrisCover(
  cleanRaw: string,
  norm: string,
  effectiveReleaseYear: number | null,
  items: LutrisSearchItem[],
  isUnsuitableUrl: (url: string) => boolean
): string | null {
  if (items.length === 0) return null;

  let bestCover: string | null = null;
  let bestScore = -1;

  const hasCloseYearAlternative =
    effectiveReleaseYear !== null &&
    items.some((cand: LutrisSearchItem) => {
      if (!cand?.coverart) return false;
      const cName = cand.name || '';
      const cNumberedSubMatch = isNumberedBaseTitleSubtitleMatch(cleanRaw, cName);
      if (
        !cNumberedSubMatch &&
        (isSequelMismatch(cleanRaw, cName) || !isTitleCompatible(cleanRaw, cName))
      ) {
        return false;
      }
      const cYear =
        cand.year !== undefined && cand.year !== null && cand.year !== ''
          ? Number(cand.year)
          : null;
      return (
        cYear !== null && !Number.isNaN(cYear) && Math.abs(effectiveReleaseYear - cYear) <= 2
      );
    });

  for (const item of items) {
    if (!item.coverart) continue;
    const itemName = item.name || '';
    const numberedSubMatch = isNumberedBaseTitleSubtitleMatch(cleanRaw, itemName);
    if (
      !numberedSubMatch &&
      (isSequelMismatch(cleanRaw, itemName) || !isTitleCompatible(cleanRaw, itemName))
    ) {
      continue;
    }

    const candNorm = normalizeKey(itemName);
    let score = numberedSubMatch ? 92 : computeTokenSimilarity(cleanRaw, itemName) * 100;

    const itemYear =
      item.year !== undefined && item.year !== null && item.year !== ''
        ? Number(item.year)
        : null;
    const isNewerReboot =
      effectiveReleaseYear !== null &&
      itemYear !== null &&
      !Number.isNaN(itemYear) &&
      itemYear - effectiveReleaseYear >= 4;
    const isOlderOverriddenByCloseYear =
      effectiveReleaseYear !== null &&
      itemYear !== null &&
      !Number.isNaN(itemYear) &&
      effectiveReleaseYear - itemYear >= 4 &&
      hasCloseYearAlternative;
    const hasEraMismatch = isNewerReboot || isOlderOverriddenByCloseYear;

    if (candNorm === norm && !hasEraMismatch) {
      score += 50;
    }

    if (effectiveReleaseYear !== null && itemYear !== null && !Number.isNaN(itemYear)) {
      const yearDiff = Math.abs(effectiveReleaseYear - itemYear);
      if (yearDiff <= 1) {
        score += 15;
      } else if (hasEraMismatch) {
        score -= 35;
      }
    }

    if (score > bestScore && score >= 65) {
      let candidateCover: string | null = null;
      const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
      if (
        m &&
        !m[1].startsWith('banner_') &&
        !m[1].startsWith('library_capsule') &&
        !m[1].startsWith('header_')
      ) {
        candidateCover = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
      } else if (item.coverart.startsWith('http') && !isUnsuitableUrl(item.coverart)) {
        candidateCover = item.coverart;
      }

      if (candidateCover) {
        bestScore = score;
        bestCover = candidateCover;
      }
    }
  }

  return bestCover;
}
