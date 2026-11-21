import { CriticScoreData, StorefrontReviewAnchor } from '../../../contracts/critic';
import { calculateTier } from '../criticUtils';
import type { SlugEvaluationResult } from './metacriticHtmlParser';
import {
  type MetacriticIdentityContext,
  extractYearFromDateString,
  sanitizeMetacriticDescription,
  validatePageIdentity,
} from './metacriticYearGuard';

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

export interface MetacriticComposerResponse {
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

export function extractComposerRedirectSlug(
  payload: MetacriticComposerResponse,
  currentSlug: string
): string | null {
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

export function evaluateMetacriticComposerPayload(params: {
  payload: MetacriticComposerResponse;
  slug: string;
  isAnchor: boolean;
  identityCtx: MetacriticIdentityContext;
  storefrontAnchor?: StorefrontReviewAnchor | null;
}): { handled: boolean; result: SlugEvaluationResult; redirectSlug?: string } {
  const { payload, slug, isAnchor, identityCtx, storefrontAnchor } = params;
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

  const pageStatus = validatePageIdentity(
    identityCtx,
    canonicalName,
    pageYear,
    description,
    isAnchor
  );
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

  return { handled: true, result: { critic: criticData, user: userData } };
}
