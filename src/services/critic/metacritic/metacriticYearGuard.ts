import { extractParentheticalReleaseYear } from '../../common/titleUtils';
import {
  hasExplicitClassicOrOriginalEditionTag,
  isTitleCompatible,
} from './metacriticTitleMatching';

export type YearCompatibilityStatus = 'accept' | 'defer_older' | 'reject';

export interface MetacriticIdentityContext {
  title: string;
  titleYear: number | null;
  paramYear: number | null;
  titleHasRemasterOrEdition: boolean;
  titleWithoutParenYear: string;
  queryHasExplicitFirstInstallment: boolean;
  isExplicitRetroQuery: boolean;
}

const REMASTER_OR_EDITION_TAG_RE =
  /\b(?:remastered|remaster|remake|redux|definitive|enhanced|anniversary|celebration|goty|game\s+of\s+the\s+year|complete|ultimate|director['’]?s\s+cut|final\s+cut|collection|trilogy|anthology|edition)\b/i;

export function parseParamYear(releaseYear?: number | string | null): number | null {
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

export function extractYearFromDateString(dateStr?: string | null): number | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const match = dateStr.match(/\b((?:19|20)\d{2})\b/);
  if (!match) return null;
  const yr = parseInt(match[1], 10);
  const maxYear = new Date().getFullYear() + 2;
  return yr >= 1975 && yr <= maxYear ? yr : null;
}

export function hasRemasterOrEditionTag(title: string): boolean {
  if (!title) return false;
  return REMASTER_OR_EDITION_TAG_RE.test(title);
}

export function createMetacriticIdentityContext(
  title: string,
  releaseYear?: number | string | null
): MetacriticIdentityContext {
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

  return {
    title,
    titleYear,
    paramYear,
    titleHasRemasterOrEdition,
    titleWithoutParenYear,
    queryHasExplicitFirstInstallment,
    isExplicitRetroQuery,
  };
}

export function evaluateReleaseYearCompatibility(
  ctx: MetacriticIdentityContext,
  pageYear: number | null,
  isAnchor: boolean
): YearCompatibilityStatus {
  if (!pageYear) return 'accept';
  // Rule 1: Explicit parenthetical release year in title is strict and symmetric
  if (ctx.titleYear !== null) {
    return Math.abs(ctx.titleYear - pageYear) > 2 ? 'reject' : 'accept';
  }
  if (ctx.paramYear !== null) {
    // Rule 2: Classic game must never match a newer modern reboot
    if (pageYear > ctx.paramYear + 3) {
      if (ctx.paramYear <= 2020 && !ctx.titleHasRemasterOrEdition) {
        return 'reject';
      }
      return 'accept';
    }
    // Rule 3: Storefront re-release date newer than Metacritic page
    if (pageYear < ctx.paramYear - 3) {
      return isAnchor ? 'accept' : 'defer_older';
    }
  }
  return 'accept';
}

/**
 * Checks whether a description explicitly references a franchise spinoff subtitle
 * (`"<BaseTitle>: <Capitalized Subtitle>"`) that does not appear in the base title.
 * Matches `<BaseTitle>` case-insensitively while strictly requiring an ACTUAL uppercase
 * first character on the subtitle (avoiding false positives on lowercase prose like
 * `"Doom: the ultimate FPS experience"`).
 */
export function hasConflictingColonSpinoffInDescription(
  title: string,
  titleWithoutParenYear: string,
  description: string | undefined
): boolean {
  const descText = description || '';
  if (!descText || !titleWithoutParenYear || title.includes(':')) return false;
  const escapedBase = titleWithoutParenYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spinoffColonRe = new RegExp(`\\b${escapedBase}:\\s+([A-Za-z][A-Za-z0-9'\\s-]{2,})`, 'gi');
  const lowerTitle = title.toLowerCase();
  for (const match of descText.matchAll(spinoffColonRe)) {
    const rawSub = match[1];
    if (!rawSub || !/^[A-Z]/.test(rawSub)) continue;
    const subLower = rawSub.trim().toLowerCase();
    if (subLower && !lowerTitle.includes(subLower)) {
      return true;
    }
  }
  return false;
}

export function validatePageIdentity(
  ctx: MetacriticIdentityContext,
  canonicalName: string,
  pageYear: number | null,
  description: string | undefined,
  isAnchor: boolean
): YearCompatibilityStatus {
  if (!isAnchor && canonicalName && !isTitleCompatible(ctx.title, canonicalName)) {
    return 'reject';
  }

  const yearStatus = evaluateReleaseYearCompatibility(ctx, pageYear, isAnchor);
  if (yearStatus === 'reject') {
    return 'reject';
  }

  // Guard against explicit first-installment or retro classic matching an unnumbered modern reboot
  if (
    ((ctx.queryHasExplicitFirstInstallment &&
      canonicalName &&
      !/\b(?:1|i)\b/i.test(canonicalName)) ||
      (ctx.isExplicitRetroQuery &&
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
  if (hasConflictingColonSpinoffInDescription(ctx.title, ctx.titleWithoutParenYear, description)) {
    return 'reject';
  }

  return yearStatus;
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
