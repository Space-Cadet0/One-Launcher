import { StorefrontReviewAnchor } from '../../../contracts/critic';
import { classifyNetworkError, isWafOrChallengeResponse } from '../../../contracts/network';
import {
  ROMAN_TO_ARABIC,
  decodeTitleHtmlEntities,
  extractParentheticalReleaseYear,
  extractTrailingDelimitedReleaseYear,
  foldLatinLigaturesAndDiacritics,
  isSequelMismatch,
  isYearEditionToken,
  stripIntermediateSubtitleNumeral,
  stripPackagingEditionPhrases,
  stripTrademarkSymbols,
  stripTrailingDelimitedReleaseYear,
  stripYearEditionPhrases,
} from '../../common/titleUtils';
import { getDevProxyBaseForRoute } from '../../network/browserDevProxy';
import { onlineLifecycleManager } from '../../network/onlineLifecycleManager';
import { Priority, requestScheduler } from '../../network/requestScheduler';
import { createTimeoutSignal } from '../stagedResolverCache';
import {
  DOTTED_ACRONYM_TEST_RE,
  METACRITIC_STOP_WORDS,
  PURE_EDITION_WORDS,
  cleanTitleForMatching,
  isAnchorMatch,
  isAnchorSlugCompatible,
  isCandidateConflictingWithAnchor,
  isTitleCompatible,
  stripMetacriticEditionSlug,
  toCanonicalMetacriticSlug,
} from './metacriticTitleMatching';
import { parseParamYear } from './metacriticYearGuard';

export interface MetacriticSearchCandidate {
  slug: string;
  title?: string;
  score?: number | null;
  releaseDate?: string;
}

/**
 * Generates alternate slug variations based on systematic title patterns:
 * 1. Verified ground-truth anchor slug (when compatible)
 * 2. Exact canonical slug first (never heuristically stripping remastered/remaster/remake)
 * 3. Packaging-edition- and trailing-dash-year-stripped slug (e.g. "Oblivion GOTY – 2009" -> "the-elder-scrolls-iv-oblivion")
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

  // 1. Packaging-edition + trailing-dash-year stripped slug (prioritized immediately after exact canonical base;
  // NEVER strips remastered/remaster/remake into a heuristic base slug, NEVER strips bare 4-digit title numbers)
  const phraseStrippedTitle = stripPackagingEditionPhrases(
    stripYearEditionPhrases(stripTrailingDelimitedReleaseYear(clean))
  );
  const phraseStrippedBase =
    phraseStrippedTitle && phraseStrippedTitle !== clean
      ? toCanonicalMetacriticSlug(phraseStrippedTitle)
      : '';
  const stripped = stripMetacriticEditionSlug(phraseStrippedBase || base);
  if (stripped && stripped !== base) {
    candidates.push(stripped);
  }

  // 2. Mid-numeral-omitted subtitle slug via stripIntermediateSubtitleNumeral
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
    if (
      midStripped &&
      midStripped !== base &&
      midStripped !== midSlug &&
      !midNumeralSlugs.includes(midStripped)
    ) {
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
  if (clean.includes(':') || /\s[-–—]\s/.test(clean)) {
    const parts = clean.split(/\s*:\s*|\s+[-–—]\s+/);
    const mainTitle = parts[0].trim();
    const suffixText = stripTrailingDelimitedReleaseYear(parts.slice(1).join(' '));
    const suffixTokens = cleanTitleForMatching(stripPackagingEditionPhrases(suffixText))
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
        if (
          base &&
          !base.endsWith(`-${yr}`) &&
          base !== yr &&
          `${base}-${yr}` !== `${rawAnchorSlug}-${yr}`
        ) {
          prioritized.push(`${base}-${yr}`);
        }
      }
      return Array.from(new Set([...prioritized, ...unique]));
    }
  }

  return unique;
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
    const cleanQuery = cleanTitleForMatching(query)
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/[:\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanQuery) return [];

    const baseUrl = getDevProxyBaseForRoute('metacriticBackend');
    const url = `${baseUrl}/finder/metacritic/search/${encodeURIComponent(cleanQuery)}/web?offset=0&limit=10&mcoTypeId=13`;
    const res = await requestScheduler.schedule(
      url,
      () =>
        fetch(url, {
          headers: {
            Accept: 'application/json',
          },
          signal: createTimeoutSignal(6000),
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
 * Filters and ranks discovered search slugs against the original query to prevent sequel/variant mismatches.
 */
export function rankCandidateSlugs(
  query: string,
  candidateSlugs: Array<string | MetacriticSearchCandidate>,
  storefrontAnchor?: StorefrontReviewAnchor | null
): string[] {
  const queryParenYr = extractParentheticalReleaseYear(query);
  const queryParenYrStr = queryParenYr !== null ? String(queryParenYr) : undefined;
  const queryTrailingYr = extractTrailingDelimitedReleaseYear(query);
  const queryTrailingYrStr = queryTrailingYr !== null ? String(queryTrailingYr) : undefined;
  const cleanedQuery = stripPackagingEditionPhrases(
    stripYearEditionPhrases(stripTrailingDelimitedReleaseYear(query))
  ).replace(/\s*\([^)]*\)/g, ' ');
  const clean = cleanTitleForMatching(cleanedQuery)
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
  const anchorSlug =
    rawAnchorSlug && isAnchorSlugCompatible(query, rawAnchorSlug) ? rawAnchorSlug : undefined;

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
    if (qTokens.includes(yrStr) && yrStr !== queryParenYrStr && yrStr !== queryTrailingYrStr) {
      return slug;
    }
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
            t !== queryTrailingYrStr &&
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
