import { CriticScoreData, StorefrontReviewAnchor } from '../../../contracts/critic';
import { calculateTier } from '../criticUtils';
import {
  type MetacriticIdentityContext,
  type YearCompatibilityStatus,
  extractYearFromDateString,
  sanitizeMetacriticDescription,
  validatePageIdentity,
} from './metacriticYearGuard';

export interface DeferredOlderCritic {
  critic: CriticScoreData;
  user: CriticScoreData | null;
  pageYear: number;
}

export interface DeferredOlderUser {
  user: CriticScoreData;
  pageYear: number;
}

export interface SlugEvaluationResult {
  critic: CriticScoreData | null;
  user: CriticScoreData | null;
  deferredOlderCritic?: DeferredOlderCritic;
  deferredOlderUser?: DeferredOlderUser;
}

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

export function parseMetacriticDocument(html: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

export function stripMetacriticPageTitleSuffix(rawPageTitle: string): string {
  return (rawPageTitle || '')
    .replace(/\s*(?:critic\s+reviews|user\s+reviews|reviews)?\s*[-|–—]\s*metacritic\s*$/i, '')
    .trim();
}

export function evaluateMetacriticHtmlBody(params: {
  html: string;
  slug: string;
  isAnchor: boolean;
  identityCtx: MetacriticIdentityContext;
  storefrontAnchor?: StorefrontReviewAnchor | null;
}): SlugEvaluationResult {
  const { html, slug, isAnchor, identityCtx, storefrontAnchor } = params;
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
        const pageStatus = validatePageIdentity(
          identityCtx,
          canonicalName,
          pageYear,
          jsonLd.description,
          isAnchor
        );
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
      const pageStatus = validatePageIdentity(identityCtx, pageTitle, pageYear, undefined, isAnchor);
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
    validatedPageStatus = validatePageIdentity(
      identityCtx,
      fallbackPageTitle,
      fallbackPageYear,
      undefined,
      isAnchor
    );
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

  return { critic: criticData, user: userData };
}
