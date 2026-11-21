import type { StorefrontReviewAnchor } from '../../contracts/critic';
import type { CanonicalGame } from '../../contracts/game';
import type { SearchMatchCandidate, ScrapedMetadataBundle } from '../../contracts/override';
import { withTimeoutFallback } from '../../utils/asyncUtils';
import {
  type ReviewCandidateOption,
  type ReviewDiscoveryResult,
  deduplicateAndRankReviewCandidates,
} from './reviewCandidateRanker';
import {
  buildCandidateRoute,
  extractDirectOpenCriticId,
  resolveReviewDiscoveryContext,
} from './reviewDiscoveryContext';
import {
  buildAnchorReviewCandidates,
  collectLocalReviewCandidates,
  fetchMetacriticReviewCandidates,
  fetchOpenCriticReviewCandidate,
  fetchSteamReviewCandidate,
  fetchStorefrontStarCandidate,
  resolveDirectOpenCriticCandidate,
  resolveStorefrontAnchor,
} from './reviewSourceCollectors';

export type { ReviewCandidateOption, ReviewDiscoveryResult };

export class ReviewCandidateService {
  /**
   * Discovers and aggregates review score candidates for a game from local caches,
   * ground truth storefront links, and live external APIs (Metacritic, OpenCritic, Steam, GOG, Epic, Xbox).
   *
   * @param game The CanonicalGame from local library.
   * @param candidate Optional SearchMatchCandidate selected in Fix Match or search modal.
   * @param scrapedBundle Optional ScrapedMetadataBundle containing scraped metadata and storefrontAnchor.
   * @param customSearchQuery Optional custom search query for Stage 3 independent review discovery.
   * @returns Deduplicated, ranked array of ReviewCandidateOption.
   */
  public async discoverReviewCandidates(
    game: CanonicalGame,
    candidate?: SearchMatchCandidate | null,
    scrapedBundle?: ScrapedMetadataBundle | null,
    customSearchQuery?: string
  ): Promise<ReviewCandidateOption[]> {
    const hasCustomQuery = Boolean(customSearchQuery && customSearchQuery.trim());
    const directOpenCriticId = hasCustomQuery ? extractDirectOpenCriticId(customSearchQuery) : null;
    if (directOpenCriticId !== null) {
      const targetTitle = (
        scrapedBundle?.title ||
        candidate?.title ||
        game.title ||
        ''
      ).trim();
      const routedOption = await resolveDirectOpenCriticCandidate(directOpenCriticId, targetTitle);
      return routedOption ? this.deduplicateAndRank([routedOption]) : [];
    }

    const ctx = await resolveReviewDiscoveryContext(
      game,
      candidate,
      scrapedBundle,
      customSearchQuery
    );

    // STEP A: Instant Local & Cached Collection (0ms, 0 network requests)
    const rawCandidates: ReviewCandidateOption[] = collectLocalReviewCandidates(ctx);

    // STEP B, C & D: Storefront Anchor + Parallel Live Collectors (zero wait if anchor is already on scrapedBundle;
    // Steam & Storefront Star collectors overlap immediately with anchor harvesting instead of blocking behind it).
    const existingAnchor: StorefrontReviewAnchor | null =
      !ctx.isDifferentQueryTitle && scrapedBundle?.storefrontAnchor
        ? scrapedBundle.storefrontAnchor
        : null;

    const anchorPromise: Promise<StorefrontReviewAnchor | null> = existingAnchor
      ? Promise.resolve(existingAnchor)
      : resolveStorefrontAnchor(ctx);

    const steamPromise = withTimeoutFallback(fetchSteamReviewCandidate(ctx), 7500, null);
    const starPromise = withTimeoutFallback(fetchStorefrontStarCandidate(ctx), 7500, null);
    const mcPromise = anchorPromise.then((resolvedAnchor) =>
      withTimeoutFallback(fetchMetacriticReviewCandidates(ctx, resolvedAnchor), 7500, {
        critic: null,
        user: null,
      })
    );
    const ocPromise = anchorPromise.then((resolvedAnchor) =>
      withTimeoutFallback(fetchOpenCriticReviewCandidate(ctx, resolvedAnchor), 7500, null)
    );

    const [anchorSettled, mcSettled, ocSettled, steamSettled, starSettled] =
      await Promise.allSettled([
        anchorPromise,
        mcPromise,
        ocPromise,
        steamPromise,
        starPromise,
      ]);

    const resolvedAnchor =
      anchorSettled.status === 'fulfilled' ? anchorSettled.value : null;
    const replacesAnchorMetacritic =
      mcSettled.status === 'fulfilled' && Boolean(mcSettled.value?.replacesAnchorMetacritic);

    // Apply anchor candidates deterministically after all parallel tasks complete (zero concurrent array mutation)
    for (const anchorCandidate of buildAnchorReviewCandidates(resolvedAnchor)) {
      if (replacesAnchorMetacritic && anchorCandidate.id === 'anchor-metacritic') {
        continue;
      }
      rawCandidates.push(anchorCandidate);
    }

    if (mcSettled.status === 'fulfilled' && mcSettled.value) {
      if (mcSettled.value.critic) rawCandidates.push(mcSettled.value.critic);
      if (mcSettled.value.user) rawCandidates.push(mcSettled.value.user);
    }

    if (ocSettled.status === 'fulfilled' && ocSettled.value) {
      rawCandidates.push(ocSettled.value);
    }

    if (steamSettled.status === 'fulfilled' && steamSettled.value) {
      rawCandidates.push(steamSettled.value);
    }

    if (starSettled.status === 'fulfilled' && starSettled.value) {
      rawCandidates.push(starSettled.value);
    }

    const routeCtx = {
      title: ctx.title,
      steamAppId: ctx.steamAppId,
      gogId: ctx.gogId ? String(ctx.gogId) : undefined,
      epicId: ctx.epicId ? String(ctx.epicId) : undefined,
      xboxProductId: ctx.xboxCandidateId,
      anchor: resolvedAnchor,
    };

    const routedCandidates = rawCandidates.map((opt) => ({
      ...opt,
      reviewRoute: opt.reviewRoute || buildCandidateRoute(opt, routeCtx),
    }));

    // STEP E: Lossless Deduplication & Hierarchical Ranking
    return this.deduplicateAndRank(routedCandidates);
  }

  /**
   * Helper that discovers candidates and returns full ReviewDiscoveryResult with recommendedCandidateId.
   */
  public async discoverReviews(
    game: CanonicalGame,
    candidate?: SearchMatchCandidate | null,
    scrapedBundle?: ScrapedMetadataBundle | null,
    customSearchQuery?: string
  ): Promise<ReviewDiscoveryResult> {
    try {
      const candidates = await this.discoverReviewCandidates(
        game,
        candidate,
        scrapedBundle,
        customSearchQuery
      );
      const recommended = candidates.find((c) => c.isRecommended) || candidates[0];
      return {
        candidates,
        recommendedCandidateId: recommended?.id,
        isLoading: false,
      };
    } catch (err: unknown) {
      return {
        candidates: [],
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to discover review candidates',
      };
    }
  }

  /**
   * Deduplicates options by source and score, merging richer live metadata, and ranks them.
   */
  public deduplicateAndRank(options: ReviewCandidateOption[]): ReviewCandidateOption[] {
    return deduplicateAndRankReviewCandidates(options);
  }
}

export const reviewCandidateService = new ReviewCandidateService();
