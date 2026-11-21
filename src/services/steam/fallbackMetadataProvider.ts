import { CanonicalGame } from '../../contracts/game';
import { UserGameOverride } from '../../contracts/override';
import {
  SteamCategory,
  SteamEnrichedMetadata,
  SteamReviewSummary,
} from '../../contracts/steam';
import { extractFirstParagraph, stripHtmlToPlainSynopsis } from '../common/synopsisTextUtils';
import { sanitizeStoreReleaseDate } from '../common/titleUtils';
import { reconcileCapsuleImage } from '../storage/metadataReconciliation';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../storage/userOverrideStorage';
import {
  fetchEpicProductMetadata as fetchEpicProductMetadataClient,
  type EpicMetadataFetchOptions,
} from './metadata/epicMetadataClient';
import { fetchGogProductMetadata as fetchGogProductMetadataClient } from './metadata/gogMetadataClient';
import {
  cleanGogDescriptionHtml,
  ensureHttps,
  extractEpicRequirementsByOs,
  extractGogRequirementsByOs,
  formatDescriptionToHtml,
  formatGogSystemRequirements,
  isGenericPlaceholderSynopsis,
  normalizeEpicLanguageName,
  parseEpicLanguages,
  parseGogLocalizations,
  stripStoreBoilerplate,
  type EpicRequirementDetail,
  type EpicRequirementSystem,
  type GogSupportedOperatingSystem,
} from './metadata/storefrontTextFormatting';
import {
  fetchXboxProductMetadata as fetchXboxProductMetadataClient,
  type XboxMetadataFetchOptions,
} from './metadata/xboxMetadataClient';

export {
  cleanGogDescriptionHtml,
  extractEpicRequirementsByOs,
  extractFirstParagraph,
  extractGogRequirementsByOs,
  formatDescriptionToHtml,
  formatGogSystemRequirements,
  isGenericPlaceholderSynopsis,
  normalizeEpicLanguageName,
  parseEpicLanguages,
  parseGogLocalizations,
  stripHtmlToPlainSynopsis,
  stripStoreBoilerplate,
};

export type { EpicRequirementDetail, EpicRequirementSystem, GogSupportedOperatingSystem };

export interface NonSteamMetadataFetchOptions {
  priority?: number;
  synopsisOnly?: boolean;
}

/**
 * Legacy empty map preserved for backwards-compatible imports from Grid/Sanitizer modules.
 * Not queried in hot metadata resolution paths.
 */
export const GOG_SPECIAL_DESCRIPTIONS: Record<
  string,
  { lead: string; full: string; releaseDate?: string; headerImage?: string }
> = {};

function slugifyEpicTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export class FallbackMetadataProvider {
  /**
   * Fetches rich metadata directly from GOG's official product API and catalog endpoints.
   */
  async fetchGogProductMetadata(
    gogId: string,
    gameTitle?: string,
    fetchOptions?: NonSteamMetadataFetchOptions
  ): Promise<Partial<SteamEnrichedMetadata> | null> {
    return fetchGogProductMetadataClient(gogId, gameTitle, fetchOptions);
  }

  /**
   * Fetches rich metadata directly from Epic Games Store Catalog Offers API (via IPC) and Content API.
   */
  async fetchEpicProductMetadata(
    slugOrTitle: string,
    options?: EpicMetadataFetchOptions
  ): Promise<Partial<SteamEnrichedMetadata> | null> {
    return fetchEpicProductMetadataClient(slugOrTitle, options);
  }

  /**
   * Fetches rich metadata directly from Microsoft Store DisplayCatalog via Electron IPC Bridge.
   */
  async fetchXboxProductMetadata(
    options: XboxMetadataFetchOptions
  ): Promise<Partial<SteamEnrichedMetadata> | null> {
    return fetchXboxProductMetadataClient(options);
  }

  /**
   * Builds high-quality enriched metadata for games that DO NOT exist on Steam
   * or are explicitly routed to a non-Steam storefront via metadataRoute.
   * Deduplicates attempted GOG IDs, Epic slugs/IPC lookups, and Xbox keys across Steps 1 & 2.
   */
  async getEnrichedMetadataForNonSteamGame(
    game: CanonicalGame,
    explicitOverride?: UserGameOverride,
    options?: NonSteamMetadataFetchOptions
  ): Promise<SteamEnrichedMetadata> {
    const synopsisOnly = Boolean(options?.synopsisOnly);
    const gogPlatform = game.platforms?.find((p) => p.platformId === 'gog');
    const epicPlatform = game.platforms?.find((p) => p.platformId === 'epic');
    const xboxPlatform = game.platforms?.find((p) => p.platformId === 'xbox');
    const override = explicitOverride ?? getUserOverrideForGame(game);
    const route = inferMetadataRouteFromOverride(override);

    const lookupTitle = route?.targetTitle || override?.title || game.title;

    const epicPlatformExtended = epicPlatform as
      | (typeof epicPlatform & { namespace?: string; catalogItemId?: string })
      | undefined;
    const baseEpicOptions: EpicMetadataFetchOptions = {
      appName: epicPlatform?.platformGameId,
      namespace: epicPlatformExtended?.namespace,
      catalogItemId: epicPlatformExtended?.catalogItemId,
      title: lookupTitle,
      ...(options?.priority !== undefined ? { priority: options.priority } : {}),
      ...(options?.synopsisOnly !== undefined ? { synopsisOnly: options.synopsisOnly } : {}),
    };

    const routeExtended = route as
      | (typeof route & { xboxProductId?: string; source?: string })
      | undefined;
    const routedXboxId =
      routeExtended?.xboxProductId ||
      (String(route?.matchedId || '').startsWith('xbox-')
        ? String(route?.matchedId).replace(/^xbox-/, '')
        : undefined);
    const isXboxRouted =
      routeExtended?.source === 'xbox' || (route?.source === 'custom' && Boolean(routedXboxId));

    // Per-call deduplication sets eliminating 5x Epic / 2x GOG / 2x Xbox retry storms across Steps 1 & 2
    const triedGogIds = new Set<string>();
    const triedEpicSlugs = new Set<string>();
    const triedEpicIpcTuples = new Set<string>();
    const triedXboxKeys = new Set<string>();

    const tryFetchGog = async (
      rawId?: string | number
    ): Promise<Partial<SteamEnrichedMetadata> | null> => {
      if (rawId === undefined || rawId === null) return null;
      const cleanId = String(rawId).replace(/^gog-/, '').trim();
      if (!cleanId || triedGogIds.has(cleanId)) return null;
      triedGogIds.add(cleanId);
      return options
        ? await this.fetchGogProductMetadata(cleanId, lookupTitle, options)
        : await this.fetchGogProductMetadata(cleanId, lookupTitle);
    };

    const tryFetchEpic = async (
      rawSlug?: string
    ): Promise<Partial<SteamEnrichedMetadata> | null> => {
      const candidate = String(rawSlug || '').trim();
      if (!candidate) return null;
      const dedupKey = candidate.toLowerCase();
      const normalizedSlugKey = slugifyEpicTitle(candidate);
      if (
        triedEpicSlugs.has(dedupKey) ||
        (normalizedSlugKey && triedEpicSlugs.has(normalizedSlugKey))
      ) {
        return null;
      }
      triedEpicSlugs.add(dedupKey);
      if (normalizedSlugKey) triedEpicSlugs.add(normalizedSlugKey);

      const ipcTupleKey = [
        baseEpicOptions.appName || '',
        baseEpicOptions.namespace || '',
        baseEpicOptions.catalogItemId || '',
        baseEpicOptions.title || '',
      ]
        .join('|')
        .toLowerCase();
      const skipIpc = Boolean(ipcTupleKey !== '|||' && triedEpicIpcTuples.has(ipcTupleKey));
      if (ipcTupleKey !== '|||') {
        triedEpicIpcTuples.add(ipcTupleKey);
      }

      const callOptions: EpicMetadataFetchOptions = skipIpc
        ? { ...baseEpicOptions, skipIpc: true }
        : baseEpicOptions;
      return await this.fetchEpicProductMetadata(candidate, callOptions);
    };

    const tryFetchXbox = async (
      params: XboxMetadataFetchOptions
    ): Promise<Partial<SteamEnrichedMetadata> | null> => {
      const dedupKey = [
        params.xboxProductId || '',
        params.xboxTitleId || '',
        params.packageFamilyName || '',
        params.platformGameId || '',
        params.title || '',
      ]
        .join('|')
        .toLowerCase();
      if (triedXboxKeys.has(dedupKey)) return null;
      triedXboxKeys.add(dedupKey);
      return await this.fetchXboxProductMetadata(params);
    };

    let storeMetadata: Partial<SteamEnrichedMetadata> | null = null;

    // 1. Honor explicit Step 4 MetadataSourceRoute first (allows routing any game to GOG, Epic, or Xbox)
    if (route?.source === 'gog') {
      const targetGogId =
        route.gogId ||
        (route.matchedId ? String(route.matchedId).replace(/^gog-/, '') : undefined) ||
        gogPlatform?.platformGameId;
      storeMetadata = await tryFetchGog(targetGogId);
    } else if (route?.source === 'epic') {
      const explicitSlug =
        route.epicSlug ||
        (route.matchedId && !/^[0-9a-f]{20,}$/i.test(String(route.matchedId))
          ? String(route.matchedId).replace(/^epic-/, '')
          : undefined);
      const titleSlug = slugifyEpicTitle(lookupTitle);

      for (const candidate of [explicitSlug, titleSlug, epicPlatform?.platformGameId]) {
        if (storeMetadata) break;
        storeMetadata = await tryFetchEpic(candidate);
      }
    } else if (isXboxRouted) {
      storeMetadata = await tryFetchXbox({
        xboxProductId: routedXboxId || xboxPlatform?.xboxProductId,
        xboxTitleId: xboxPlatform?.xboxTitleId,
        packageFamilyName: xboxPlatform?.packageFamilyName,
        platformGameId: xboxPlatform?.platformGameId,
        title: lookupTitle,
        ...(options?.synopsisOnly !== undefined ? { synopsisOnly: options.synopsisOnly } : {}),
      });
    }

    // 2. Fallback to platform-based or cross-store GOG/Epic/Xbox IDs if not yet resolved (deduplicated)
    if (!storeMetadata) {
      const fallbackGogId = route?.gogId || gogPlatform?.platformGameId;
      storeMetadata = await tryFetchGog(fallbackGogId);
    }

    if (!storeMetadata && (epicPlatform || route?.epicSlug)) {
      const titleSlug = slugifyEpicTitle(route?.targetTitle || game.title);
      for (const candidate of [route?.epicSlug || titleSlug, epicPlatform?.platformGameId]) {
        if (storeMetadata) break;
        storeMetadata = await tryFetchEpic(candidate);
      }
    }

    if (!storeMetadata && xboxPlatform) {
      storeMetadata = await tryFetchXbox({
        xboxProductId: xboxPlatform.xboxProductId,
        xboxTitleId: xboxPlatform.xboxTitleId,
        packageFamilyName: xboxPlatform.packageFamilyName,
        platformGameId: xboxPlatform.platformGameId,
        title: lookupTitle,
        ...(options?.synopsisOnly !== undefined ? { synopsisOnly: options.synopsisOnly } : {}),
      });
    }

    // 3. Hydrate from local offline storefront DBs when live storeMetadata is unavailable
    if (
      !storeMetadata &&
      typeof window !== 'undefined' &&
      window.electronAPI?.offlineVault?.resolveLocalMetadata
    ) {
      try {
        const fallbackGogId =
          route?.gogId ||
          (route?.matchedId ? String(route.matchedId).replace(/^gog-/, '') : undefined) ||
          gogPlatform?.platformGameId;
        const localXboxProductId =
          routedXboxId ||
          xboxPlatform?.xboxProductId ||
          (/^[A-Z0-9]{12}$/i.test(String(xboxPlatform?.platformGameId || ''))
            ? xboxPlatform?.platformGameId
            : undefined);
        const localRes = await window.electronAPI.offlineVault.resolveLocalMetadata({
          gameId: game.id,
          title: game.title,
          steamAppId: game.steamAppId ?? undefined,
          gogId: fallbackGogId ? String(fallbackGogId) : undefined,
          epicAppName: epicPlatform?.platformGameId,
          xboxProductId: localXboxProductId ?? null,
          packageFamilyName: xboxPlatform?.packageFamilyName ?? null,
        });
        if (localRes?.success && localRes.metadata) {
          storeMetadata = {
            ...localRes.metadata,
            metadataQuality: localRes.metadata.metadataQuality || 'local_federated',
          };
        }
      } catch {
        // Ignore offline local federation lookup errors
      }
    }

    // 4. CRITICAL NON-CLOBBER GUARD: Never overwrite existing rich enrichedMetadata with an offline skeleton!
    if (
      !storeMetadata &&
      game.enrichedMetadata &&
      !game.enrichedMetadata.__quotaSlimmed &&
      !game.enrichedMetadata.__digestOnly
    ) {
      const existing = game.enrichedMetadata;
      const existingAbout = existing.aboutTheGame || existing.detailedDescription || '';
      const plainAbout = stripHtmlToPlainSynopsis(existingAbout, 0);
      const hasMultiSentenceAbout =
        Boolean(plainAbout) &&
        !isGenericPlaceholderSynopsis(existingAbout, game.title) &&
        plainAbout.split(/[.!?]+\s+/).filter(Boolean).length >= 2;
      const hasRichScreenshots = (existing.screenshots?.length || 0) > 1;
      const hasNonSkeletonQuality =
        Boolean(existing.metadataQuality) && existing.metadataQuality !== 'skeleton_fallback';

      if (hasNonSkeletonQuality || hasRichScreenshots || hasMultiSentenceAbout) {
        return { ...existing };
      }
    }

    if (storeMetadata && override && route?.mode === 'routed') {
      updateRoutedMetadataSnapshot(game.id, {
        title: storeMetadata.name,
        shortDescription: storeMetadata.shortDescription,
        detailedDescription: storeMetadata.detailedDescription || storeMetadata.aboutTheGame,
        headerImage: storeMetadata.headerImage,
        developers: storeMetadata.developers,
        publishers: storeMetadata.publishers,
        genres: storeMetadata.genres,
        tags: storeMetadata.tags,
        releaseDate: storeMetadata.releaseDate,
      });
    }

    // Preserve only authentic storefront user review summaries (never fabricate Steam review counts)
    const reviewSummary: SteamReviewSummary =
      storeMetadata?.reviewSummary && storeMetadata.reviewSummary.totalReviews > 0
        ? storeMetadata.reviewSummary
        : {
            reviewScore: 0,
            reviewScoreDesc: 'No user reviews',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          };

    const devs =
      storeMetadata?.developers && storeMetadata.developers.length > 0
        ? storeMetadata.developers
        : game.developers && game.developers.length > 0
          ? game.developers
          : [];

    const pubs =
      storeMetadata?.publishers && storeMetadata.publishers.length > 0
        ? storeMetadata.publishers
        : game.publishers && game.publishers.length > 0
          ? game.publishers
          : [];

    const genres =
      storeMetadata?.genres && storeMetadata.genres.length > 0
        ? storeMetadata.genres
        : game.genres && game.genres.length > 0
          ? game.genres
          : [];

    const tags =
      storeMetadata?.tags && storeMetadata.tags.length > 0
        ? storeMetadata.tags
        : game.tags && game.tags.length > 0
          ? game.tags
          : [];

    const categories: SteamCategory[] =
      storeMetadata?.categories && storeMetadata.categories.length > 0
        ? storeMetadata.categories
        : [];

    const firstParaDesc =
      extractFirstParagraph(storeMetadata?.detailedDescription) ||
      extractFirstParagraph(storeMetadata?.aboutTheGame) ||
      extractFirstParagraph(game.shortDescription);

    const cleanSummary =
      genres.length > 0 && genres[0] !== 'Store Exclusive'
        ? `${game.title} is a ${genres.slice(0, 3).join(', ')} title${devs.length > 0 ? ` developed by ${devs[0]}` : ''}.`
        : `${game.title} is a PC library title${devs.length > 0 ? ` developed by ${devs[0]}` : ''}.`;

    const rawShortCandidate =
      storeMetadata?.shortDescription &&
      !isGenericPlaceholderSynopsis(storeMetadata.shortDescription, game.title)
        ? storeMetadata.shortDescription.trim()
        : game.shortDescription && !isGenericPlaceholderSynopsis(game.shortDescription, game.title)
          ? game.shortDescription.trim()
          : firstParaDesc && !isGenericPlaceholderSynopsis(firstParaDesc, game.title)
            ? firstParaDesc
            : cleanSummary;

    const shortDescription = stripHtmlToPlainSynopsis(rawShortCandidate) || cleanSummary;

    const detailedDescription =
      storeMetadata?.detailedDescription ||
      storeMetadata?.aboutTheGame ||
      (game.shortDescription && !isGenericPlaceholderSynopsis(game.shortDescription, game.title)
        ? game.shortDescription
        : '') ||
      cleanSummary;

    // P0-11: synopsisOnly results remain 'local_federated' without fetchedAt so full detail hydration never skips them
    const resolvedQuality = !storeMetadata
      ? 'skeleton_fallback'
      : synopsisOnly
        ? 'local_federated'
        : storeMetadata.metadataQuality || 'scraped';

    const preservedXboxHints =
      storeMetadata?.xboxDeliveryHints || game.enrichedMetadata?.xboxDeliveryHints;

    const resolvedHeaderImage = ensureHttps(storeMetadata?.headerImage || game.headerImage);
    const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
    const reconciledCapsule = reconcileCapsuleImage(
      game.capsuleImage,
      storeMetadata?.capsuleImage,
      {
        gameId: game.id,
        title: game.title,
        steamAppId: game.steamAppId,
        gogId: gogPlat?.platformGameId,
        headerUrl: resolvedHeaderImage,
      }
    );

    const resolvedScreenshots = synopsisOnly
      ? []
      : storeMetadata?.screenshots && storeMetadata.screenshots.length > 0
        ? storeMetadata.screenshots
        : game.headerImage
          ? [
              {
                id: 0,
                pathThumbnail: ensureHttps(game.headerImage),
                pathFull: ensureHttps(game.headerImage),
              },
            ]
          : [];

    return {
      appId: storeMetadata?.appId ?? 0,
      name: storeMetadata?.name || game.title,
      shortDescription,
      detailedDescription,
      aboutTheGame: storeMetadata?.aboutTheGame || detailedDescription,
      headerImage: resolvedHeaderImage,
      capsuleImage: reconciledCapsule ? ensureHttps(reconciledCapsule) : undefined,
      iconUrl: ensureHttps(storeMetadata?.iconUrl || game.iconUrl || ''),
      developers: devs,
      publishers: pubs,
      releaseDate:
        sanitizeStoreReleaseDate(storeMetadata?.releaseDate) ||
        sanitizeStoreReleaseDate(game.releaseDate) ||
        'TBA',
      genres,
      tags,
      categories,
      supportedLanguages: storeMetadata?.supportedLanguages || '',
      languageOptions: storeMetadata?.languageOptions,
      languageTableSchema: storeMetadata?.languageTableSchema || 'audio_text',
      screenshots: resolvedScreenshots,
      movies: synopsisOnly ? [] : storeMetadata?.movies || [],
      systemRequirements: synopsisOnly ? {} : storeMetadata?.systemRequirements || {},
      ...(synopsisOnly ? {} : { macRequirements: storeMetadata?.macRequirements }),
      ...(synopsisOnly ? {} : { linuxRequirements: storeMetadata?.linuxRequirements }),
      extUserAccountNotice: storeMetadata?.extUserAccountNotice,
      website: storeMetadata?.website,
      metadataQuality: resolvedQuality,
      ...(storeMetadata?.platforms ? { platforms: storeMetadata.platforms } : {}),
      ...(storeMetadata?.enrichedSource ? { enrichedSource: storeMetadata.enrichedSource } : {}),
      ...(preservedXboxHints ? { xboxDeliveryHints: preservedXboxHints } : {}),
      ...(synopsisOnly ? {} : { fetchedAt: storeMetadata?.fetchedAt || Date.now() }),
      reviewSummary,
      achievements: storeMetadata?.achievements,
    };
  }
}

export const fallbackMetadataProvider = new FallbackMetadataProvider();
