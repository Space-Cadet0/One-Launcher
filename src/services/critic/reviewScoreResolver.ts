import type { CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import type { CanonicalGame } from '../../contracts/game';
import type { UserGameOverride } from '../../contracts/override';
import type { SteamEnrichedMetadata, SteamReviewSummary } from '../../contracts/steam';
import * as openCriticModule from '../opencritic/openCritic';
import { steamMatcher } from '../steam/steamMatcher';
import { inferReviewRouteFromOverride } from '../storage/userOverrideStorage';
import { criticScoreService, type CriticScoreContext } from './criticScoreService';
import { isAnchorSlugCompatible } from './metacriticResolver';
import { extractMetacriticSlugFromUrl } from './storefrontReviewHarvester';

export interface ResolveGameReviewScoreOptions {
  skipBackgroundTrigger?: boolean;
  bypassTTL?: boolean;
  liveMetadata?: SteamEnrichedMetadata | null;
  liveReviewSummary?: SteamReviewSummary | null;
  userOverride?: UserGameOverride | null;
}

type CanonicalGameWithVaultCritic = CanonicalGame & {
  criticScore?: CriticScoreData | null;
};

function isValidMetacriticHostUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (host === 'metacritic.com' || host.endsWith('.metacritic.com'))
    );
  } catch {
    return /^https?:\/\/(?:www\.)?metacritic\.com\/game\//i.test(trimmed);
  }
}

function extractVerifiedAnchorFromMetadata(
  game: CanonicalGame,
  meta: SteamEnrichedMetadata | null | undefined,
  effectiveSteamAppId: number | undefined
): StorefrontReviewAnchor | undefined {
  if (!meta || typeof meta !== 'object' || !meta.metacritic || typeof meta.metacritic !== 'object') {
    return undefined;
  }

  const rawUrl =
    typeof meta.metacritic.url === 'string' && meta.metacritic.url.trim()
      ? meta.metacritic.url.trim()
      : undefined;
  const hasValidMcUrl = isValidMetacriticHostUrl(rawUrl);
  const slug = hasValidMcUrl ? extractMetacriticSlugFromUrl(rawUrl) : undefined;
  const score =
    typeof meta.metacritic.score === 'number' &&
    Number.isFinite(meta.metacritic.score) &&
    meta.metacritic.score > 0
      ? meta.metacritic.score
      : undefined;

  // Strictly exclude legacy `local_federated` GOG star ratings masquerading in enrichedMetadata.metacritic
  const enrichedSourceStr = typeof meta.enrichedSource === 'string' ? meta.enrichedSource.trim() : '';
  const isLegacyFederated =
    meta.metadataQuality === 'local_federated' || enrichedSourceStr === 'local_federated';
  const isNonSteamSource = enrichedSourceStr.length > 0 && enrichedSourceStr !== 'steam';

  if ((isLegacyFederated || isNonSteamSource) && !hasValidMcUrl) {
    return undefined;
  }
  if (!effectiveSteamAppId && !hasValidMcUrl) {
    return undefined;
  }
  if (score === undefined && !hasValidMcUrl) {
    return undefined;
  }
  if (slug && game.title && !isAnchorSlugCompatible(game.title, slug)) {
    return undefined;
  }

  const canonicalMcUrl = slug
    ? `https://www.metacritic.com/game/${slug}/critic-reviews/`
    : hasValidMcUrl
    ? rawUrl
    : undefined;

  return {
    storefront: 'steam',
    metacriticUrl: canonicalMcUrl,
    metacriticScore: score,
    metacriticSlug: slug,
    ...(effectiveSteamAppId
      ? { rawStoreUrl: `https://store.steampowered.com/app/${effectiveSteamAppId}` }
      : {}),
    isVerifiedGroundTruth: true,
  };
}

/**
 * Builds a verified Steam Metacritic review anchor from live or persisted enriched metadata,
 * strictly excluding legacy `local_federated` GOG star ratings masquerading inside `metacritic`.
 */
export function buildVerifiedSteamMetacriticAnchor(
  game: CanonicalGame,
  liveMetadata?: SteamEnrichedMetadata | null
): StorefrontReviewAnchor | undefined {
  if (!game) return undefined;
  const effectiveSteamAppId = steamMatcher.getEffectiveSteamAppId(game);
  return (
    extractVerifiedAnchorFromMetadata(game, liveMetadata, effectiveSteamAppId) ??
    extractVerifiedAnchorFromMetadata(game, game.enrichedMetadata, effectiveSteamAppId)
  );
}

/**
 * Single unified review-score resolver across Library Grid, Hover Popout, Filters, Sorting,
 * and Game Detail pages. Delegates through `openCriticModule.getOpenCriticData` (Trap T10)
 * with full entitlement context (`{ gameId, platforms }`) and verified Steam anchor extraction.
 */
export function resolveGameReviewScore(
  game: CanonicalGame,
  options?: ResolveGameReviewScoreOptions
): CriticScoreData | null {
  if (!game) return null;

  const effectiveSteamAppId = steamMatcher.getEffectiveSteamAppId(game);
  const positivePercent =
    options?.liveReviewSummary?.positivePercent ??
    game.reviewSummary?.positivePercent ??
    options?.liveMetadata?.reviewSummary?.positivePercent ??
    game.enrichedMetadata?.reviewSummary?.positivePercent;
  const releaseDate =
    options?.liveMetadata?.releaseDate ||
    game.releaseDate ||
    game.enrichedMetadata?.releaseDate;
  const anchor = buildVerifiedSteamMetacriticAnchor(game, options?.liveMetadata);
  const bypassTTL = options?.bypassTTL ?? false;
  const skipBackgroundTrigger = options?.skipBackgroundTrigger ?? false;
  const context: CriticScoreContext = {
    gameId: game.id,
    platforms: game.platforms,
  };

  // CRITICAL TRAP T10: Always delegate through openCriticModule.getOpenCriticData with
  // skipBackgroundTrigger as arg 7 and entitlement context as arg 8 so existing spies record calls.
  const resolved = openCriticModule.getOpenCriticData(
    effectiveSteamAppId || undefined,
    game.title,
    positivePercent,
    releaseDate,
    anchor,
    bypassTTL,
    skipBackgroundTrigger,
    context
  );

  const explicitOverrideRoute = options?.userOverride
    ? inferReviewRouteFromOverride(options.userOverride)
    : undefined;
  if (explicitOverrideRoute?.mode === 'unrated') {
    return null;
  }

  if (
    resolved &&
    typeof resolved.score === 'number' &&
    Number.isFinite(resolved.score) &&
    resolved.score > 0
  ) {
    return resolved;
  }

  if (explicitOverrideRoute?.mode === 'static') {
    return options?.userOverride?.reviewScoreOverride ?? null;
  }

  // Fallback to vault-hydrated game.criticScore when semantically valid and no unrated override is active
  const embeddedCriticScore = (game as CanonicalGameWithVaultCritic).criticScore;
  if (
    embeddedCriticScore &&
    typeof embeddedCriticScore.score === 'number' &&
    Number.isFinite(embeddedCriticScore.score) &&
    embeddedCriticScore.score > 0
  ) {
    const activeOverride =
      options?.userOverride ??
      criticScoreService.findMatchingUserOverride(
        effectiveSteamAppId,
        game.title,
        game.id,
        game.platforms
      );
    const activeRoute = activeOverride ? inferReviewRouteFromOverride(activeOverride) : undefined;
    if (activeRoute?.mode === 'unrated') {
      return null;
    }
    if (
      criticScoreService.isScoreSemanticallyCompatible(
        game.title,
        embeddedCriticScore,
        effectiveSteamAppId,
        anchor?.metacriticSlug
      )
    ) {
      return embeddedCriticScore;
    }
  }

  return null;
}
