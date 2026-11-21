import { CanonicalGame } from '../../contracts/game';
import {
  SearchMatchCandidate,
  ScrapedCoverOption,
  ScrapedMetadataBundle,
  MetadataSourceOption,
} from '../../contracts/override';
import { computeEntityMatchConfidence } from '../common/entityResolver';
import { normalizeTitleKey, matchesLooseSearchQuery } from '../common/titleUtils';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isUnsuitableCoverUrl,
} from '../igdb/igdbCoverService';
import { steamApi } from '../steam/steamApi';
import { steamMatcher, canonicalizeTitleKey } from '../steam/steamMatcher';
import {
  SteamStoreSearchItem,
  LutrisGameSearchItem,
  StorefrontSearchSource,
  gogCacheMap,
  steamCacheMap,
  hasGogCacheEntries,
  hasSteamCacheEntries,
  lookupKnownEpicApp,
  getErrorMessage,
  isXboxStoreCandidateId,
  extractXboxBigId,
  buildCandidateStoreUrl,
  cleanSearchQuery,
  isNonGameAddonTitle,
  getSteamHeaderUrl,
  resolveSteamCandidateCapsuleUrl,
} from './scraperUrlAndQueryUtils';
import { querySteamStoreItems, queryLutrisGameItems } from './scraperNetworkClients';
import { executeParallelStorefrontSearch } from './storefrontSearchEngine';
import {
  scrapeCandidateMatchDetails,
  buildCoverOptionsFromSearch,
  buildMetadataSourcesFromSearch,
} from './scrapedBundleBuilders';

export {
  isXboxStoreCandidateId,
  extractXboxBigId,
  buildCandidateStoreUrl,
  cleanSearchQuery,
  isNonGameAddonTitle,
};

export class MetadataScraperService {
  /**
   * Queries Steam Store Search API with Wave 1 dev proxy support and direct HTTPS fallback.
   * Retained on prototype so test spies (`vi.spyOn(metadataScraperService, 'querySteamStore')`) intercept calls.
   */
  private async querySteamStore(query: string): Promise<SteamStoreSearchItem[]> {
    return querySteamStoreItems(query);
  }

  /**
   * Queries Lutris/IGDB Games Search API with Wave 1 dev proxy support and direct HTTPS fallback.
   * Retained on prototype so test spies (`vi.spyOn(metadataScraperService, 'queryLutrisGames')`) intercept calls.
   */
  private async queryLutrisGames(query: string): Promise<LutrisGameSearchItem[]> {
    return queryLutrisGameItems(query);
  }

  /**
   * Generates 3-6 top candidate matches combining:
   *  a) Steam store search or instant match from steamMatcher.matchGameToSteamInstant(game.title).
   *  b) IGDB candidates via Lutris API search.
   *  c) GOG catalog search / known GOG games if applicable.
   * Scores and ranks candidates by token similarity so the most likely match is on top.
   * Optionally accepts custom search term, source tab filter, and non-Steam exclusivity toggle.
   */
  async getSuggestedMatches(
    game: CanonicalGame,
    customQuery?: string,
    sourceFilter?: string,
    nonSteamOnly?: boolean
  ): Promise<SearchMatchCandidate[]> {
    if (!game || !game.title) return [];

    const rawSourceTitle =
      game.originalStoreTitle || game.platforms?.[0]?.originalTitle || game.title;
    const effectiveTitle =
      customQuery && customQuery.trim() ? customQuery.trim() : rawSourceTitle;
    const candidates: SearchMatchCandidate[] = [];

    // 1. Steam Existing Ownership or Instant Curated Match (skip if nonSteamOnly is active)
    if (!nonSteamOnly) {
      let matchedSteamAppId: number | null = game.steamAppId || null;
      if (!matchedSteamAppId) {
        matchedSteamAppId = steamMatcher.matchGameToSteamInstant(effectiveTitle);
      }

      if (matchedSteamAppId) {
        const cachedSteamName = hasSteamCacheEntries()
          ? steamCacheMap[String(matchedSteamAppId)]?.name
          : undefined;
        const steamCandidateTitle =
          steamApi.getCachedMetadata(matchedSteamAppId)?.name ||
          cachedSteamName ||
          game.platforms?.find((p) => p.platformId === 'steam')?.originalTitle ||
          rawSourceTitle;

        candidates.push({
          id: `steam-${matchedSteamAppId}`,
          source: 'steam',
          title: steamCandidateTitle,
          steamAppId: matchedSteamAppId,
          storeUrl: buildCandidateStoreUrl({
            source: 'steam',
            title: steamCandidateTitle,
            steamAppId: matchedSteamAppId,
          }),
          capsuleImage: resolveSteamCandidateCapsuleUrl(matchedSteamAppId),
          headerImage: getSteamHeaderUrl(matchedSteamAppId),
          confidenceScore: 100,
        });
      }
    }

    // 2. Check GOG Platform Ownership
    const gogPlatform = game.platforms?.find((p) => p.platformId === 'gog');
    if (gogPlatform?.platformGameId) {
      const gogData = hasGogCacheEntries() ? gogCacheMap[gogPlatform.platformGameId] : undefined;
      const gogCandidateTitle = gogData?.title || gogPlatform.originalTitle || rawSourceTitle;
      const gogStoreUrl = buildCandidateStoreUrl({
        source: 'gog',
        title: gogCandidateTitle,
        gogId: gogPlatform.platformGameId,
      });

      if (gogData) {
        candidates.push({
          id: `gog-${gogPlatform.platformGameId}`,
          source: 'gog',
          title: gogCandidateTitle,
          gogId: gogPlatform.platformGameId,
          storeUrl: gogStoreUrl,
          year: gogData.releaseDate ? gogData.releaseDate.substring(0, 4) : undefined,
          capsuleImage: gogData.coverVertical || gogData.coverHorizontal,
          headerImage: gogData.coverHorizontal || gogData.coverVertical,
          description: gogData.shortDescription || gogData.aboutTheGame,
          confidenceScore: 98,
        });
      } else {
        const instantGogBoxArt = igdbCoverService.getGogVerticalCoverInstant(
          gogPlatform.platformGameId,
          gogCandidateTitle
        );
        const validLocalGogCover =
          game.capsuleImage &&
          !isUnsuitableCoverUrl(game.capsuleImage) &&
          !isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)
            ? game.capsuleImage
            : undefined;
        candidates.push({
          id: `gog-${gogPlatform.platformGameId}`,
          source: 'gog',
          title: gogCandidateTitle,
          gogId: gogPlatform.platformGameId,
          storeUrl: gogStoreUrl,
          year: game.releaseDate ? String(game.releaseDate).substring(0, 4) : undefined,
          capsuleImage: instantGogBoxArt || validLocalGogCover || game.headerImage,
          headerImage: game.headerImage || validLocalGogCover,
          description: game.shortDescription,
          confidenceScore: 98,
        });
      }
    }

    // 3. Check Epic Platform Ownership
    const epicPlatform = game.platforms?.find((p) => p.platformId === 'epic');
    if (epicPlatform?.platformGameId) {
      const epicMapping = lookupKnownEpicApp(epicPlatform.platformGameId, game.title);
      const epicCandidateTitle =
        epicMapping?.title || epicPlatform.originalTitle || rawSourceTitle;
      const epicStoreUrl = buildCandidateStoreUrl({
        source: 'epic',
        title: epicCandidateTitle,
        epicSlug: epicPlatform.platformGameId,
      });

      if (epicMapping) {
        candidates.push({
          id: `epic-${epicPlatform.platformGameId}`,
          source: 'epic',
          title: epicCandidateTitle,
          storeUrl: epicStoreUrl,
          capsuleImage: epicMapping.capsuleImage || epicMapping.headerImage,
          headerImage: epicMapping.headerImage,
          description: epicMapping.description,
          confidenceScore: 98,
        });
      } else {
        candidates.push({
          id: `epic-${epicPlatform.platformGameId}`,
          source: 'epic',
          title: epicCandidateTitle,
          storeUrl: epicStoreUrl,
          year: game.releaseDate ? String(game.releaseDate).substring(0, 4) : undefined,
          capsuleImage: game.capsuleImage || game.headerImage,
          headerImage: game.headerImage || game.capsuleImage,
          description: game.shortDescription,
          confidenceScore: 98,
        });
      }
    }

    // 3b. Check Xbox Platform Ownership
    const xboxPlatform = game.platforms?.find((p) => p.platformId === 'xbox');
    if (xboxPlatform) {
      const xboxProductId =
        xboxPlatform.xboxProductId || extractXboxBigId(xboxPlatform.platformGameId);
      const xboxIdToken = xboxProductId || xboxPlatform.platformGameId || game.id;
      const xboxCandidateTitle = xboxPlatform.originalTitle || rawSourceTitle;
      const xboxStoreUrl = buildCandidateStoreUrl({
        source: 'xbox',
        title: xboxCandidateTitle,
        xboxProductId,
      });

      candidates.push({
        id: `xbox-${xboxIdToken}`,
        source: 'xbox',
        title: xboxCandidateTitle,
        storeUrl: xboxStoreUrl,
        year: game.releaseDate ? String(game.releaseDate).substring(0, 4) : undefined,
        capsuleImage: game.capsuleImage || game.headerImage,
        headerImage: game.headerImage || game.capsuleImage,
        description: game.shortDescription,
        confidenceScore: 98,
      });
    }

    // 4. Concurrently query Storefronts (Steam, IGDB, GOG, Epic, Xbox)
    try {
      const normFilter = (sourceFilter || 'all').toLowerCase();
      const shouldQuerySteam = !nonSteamOnly && (normFilter === 'all' || normFilter === 'steam');
      const shouldQueryIgdb = normFilter === 'all' || normFilter === 'igdb';
      const shouldQueryGog = normFilter === 'all' || normFilter === 'gog';
      const shouldQueryEpic = normFilter === 'all' || normFilter === 'epic';
      const shouldQueryXbox = normFilter === 'all' || normFilter === 'xbox';

      const searchPromises: Promise<SearchMatchCandidate[]>[] = [];
      if (shouldQuerySteam) {
        searchPromises.push(this.searchStorefronts(effectiveTitle, 'steam').catch(() => []));
      }
      if (shouldQueryIgdb) {
        searchPromises.push(this.searchStorefronts(effectiveTitle, 'igdb').catch(() => []));
      }
      if (shouldQueryGog) {
        searchPromises.push(this.searchStorefronts(effectiveTitle, 'gog').catch(() => []));
      }
      if (shouldQueryEpic) {
        searchPromises.push(this.searchStorefronts(effectiveTitle, 'epic').catch(() => []));
      }
      if (shouldQueryXbox) {
        searchPromises.push(this.searchStorefronts(effectiveTitle, 'xbox').catch(() => []));
      }

      const results = await Promise.all(searchPromises);
      for (const resList of results) {
        candidates.push(...resList);
      }
    } catch (err: unknown) {
      console.warn(
        '[MetadataScraperService] Dynamic suggested matches search encountered error:',
        getErrorMessage(err)
      );
    }

    // 5. Score, Filter, Deduplicate, and Rank
    const scoredCandidates: SearchMatchCandidate[] = [];
    const seenByKey = new Map<string, SearchMatchCandidate>();

    for (const cand of candidates) {
      if (nonSteamOnly && cand.source === 'steam') continue;
      const candEffectiveSource =
        cand.source === 'xbox' || isXboxStoreCandidateId(cand.id, cand.storeUrl)
          ? 'xbox'
          : cand.source.toLowerCase();
      if (
        sourceFilter &&
        sourceFilter.toLowerCase() !== 'all' &&
        candEffectiveSource !== sourceFilter.toLowerCase()
      ) {
        continue;
      }

      const key = `${candEffectiveSource}:${cand.id}`;
      const existing = seenByKey.get(key);
      if (existing) {
        if (
          cand.capsuleImage &&
          (!existing.capsuleImage ||
            existing.capsuleImage === existing.headerImage ||
            isUnsuitableCoverUrl(existing.capsuleImage) ||
            isGogCroppedHorizontalCover(existing.capsuleImage, existing.headerImage))
        ) {
          existing.capsuleImage = cand.capsuleImage;
        }
        if (cand.headerImage && !existing.headerImage) {
          existing.headerImage = cand.headerImage;
        }
        if (cand.year && !existing.year) {
          existing.year = cand.year;
        }
        if (cand.storeUrl && !existing.storeUrl) {
          existing.storeUrl = cand.storeUrl;
        }
        continue;
      }

      // Multi-vector entity confidence evaluation (title + release year + developers)
      const evaluation = computeEntityMatchConfidence(
        {
          title: effectiveTitle,
          releaseYear: game.releaseDate,
          developers: game.developers,
        },
        {
          title: cand.title,
          releaseYear: cand.year,
        }
      );

      let score = evaluation.confidence;

      const normGame = normalizeTitleKey(effectiveTitle) || canonicalizeTitleKey(effectiveTitle);
      const normCand = normalizeTitleKey(cand.title) || canonicalizeTitleKey(cand.title);

      if (normGame === normCand && !evaluation.isRebootCollision) {
        score = Math.max(score, 96);
      } else if (
        matchesLooseSearchQuery(cand.title, effectiveTitle) &&
        !evaluation.isRebootCollision
      ) {
        score = Math.max(score, 72);
      }

      // Bonus if candidate has official SteamAppId matching the game
      if (cand.source === 'steam' && game.steamAppId && cand.steamAppId === game.steamAppId) {
        score = 100;
      }

      // Bonus if candidate source matches a platform owned by user
      if (
        !evaluation.isRebootCollision &&
        game.platforms?.some((p) => p.platformId === candEffectiveSource)
      ) {
        score = Math.min(100, score + 8);
      }

      // Bonus if candidate has a valid cover image
      if (!evaluation.isRebootCollision && cand.capsuleImage) {
        score = Math.min(100, score + 2);
      }

      const isAddon = isNonGameAddonTitle(cand.title || '', effectiveTitle);
      if (isAddon) {
        score = Math.max(0, score - 45);
      }

      const finalConfidence = Math.max(0, Math.min(100, score));
      if (isAddon && finalConfidence < 35) {
        continue;
      }

      const scoredEntry: SearchMatchCandidate = {
        ...cand,
        storeUrl:
          cand.storeUrl ||
          buildCandidateStoreUrl({
            source: candEffectiveSource,
            title: cand.title,
            steamAppId: cand.steamAppId,
            gogId: cand.gogId,
            epicSlug: cand.source === 'epic' ? String(cand.id) : undefined,
            igdbId: cand.igdbId || cand.id,
            xboxProductId: candEffectiveSource === 'xbox' ? cand.id : undefined,
          }),
        confidenceScore: finalConfidence,
      };
      seenByKey.set(key, scoredEntry);
      scoredCandidates.push(scoredEntry);
    }

    scoredCandidates.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    const limit =
      customQuery || (sourceFilter && sourceFilter.toLowerCase() !== 'all') ? 20 : 6;
    return scoredCandidates.slice(0, limit);
  }

  /**
   * Alias for searchStorefronts for multi-store queries with punctuation-tolerant fallback.
   */
  async searchMultiStore(
    query: string,
    source: StorefrontSearchSource = 'all'
  ): Promise<SearchMatchCandidate[]> {
    return this.searchStorefronts(query, source);
  }

  /**
   * Searches storefronts (Steam, IGDB, GOG, Epic, Xbox) for matching games.
   * Keeps primary outgoing storefront queries raw; if the raw query returns 0 candidates
   * with confidence >= 60 and normalizeTitleKey(query) differs from query.trim().toLowerCase(),
   * runs a fallback search with normalizeTitleKey(query) and merges/deduplicates results.
   */
  async searchStorefronts(
    query: string,
    source: StorefrontSearchSource = 'all'
  ): Promise<SearchMatchCandidate[]> {
    const rawTrimmed = (query || '').trim();
    if (!rawTrimmed) return [];

    const primaryCandidates = await this.executeStorefrontSearch(rawTrimmed, source);
    const hasConfidentPrimary = primaryCandidates.some((c) => (c.confidenceScore ?? 0) >= 60);
    const normalizedFallback = normalizeTitleKey(rawTrimmed);

    if (
      !hasConfidentPrimary &&
      normalizedFallback &&
      normalizedFallback !== rawTrimmed.toLowerCase()
    ) {
      const fallbackCandidates = await this.executeStorefrontSearch(normalizedFallback, source);
      if (fallbackCandidates.length > 0) {
        const mergedMap = new Map<string, SearchMatchCandidate>();
        for (const cand of [...primaryCandidates, ...fallbackCandidates]) {
          const key = `${cand.source}:${cand.id}`;
          const existing = mergedMap.get(key);
          if (!existing || (cand.confidenceScore ?? 0) > (existing.confidenceScore ?? 0)) {
            mergedMap.set(key, cand);
          }
        }
        const merged = Array.from(mergedMap.values());
        merged.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));
        return merged;
      }
    }

    return primaryCandidates;
  }

  /**
   * Executes storefront search concurrently across selected storefronts.
   * Retained on prototype so test spies (`vi.spyOn(metadataScraperService, 'executeStorefrontSearch')`) intercept calls.
   */
  private async executeStorefrontSearch(
    query: string,
    source: StorefrontSearchSource = 'all'
  ): Promise<SearchMatchCandidate[]> {
    return executeParallelStorefrontSearch(query, source, {
      querySteamStore: (q) => this.querySteamStore(q),
      queryLutrisGames: (q) => this.queryLutrisGames(q),
    });
  }

  /**
   * Scrapes comprehensive match details, assemble multiple portrait covers,
   * multiple synopsis options, cross-storefront metadata sources, and deep metadata.
   */
  async scrapeMatchDetails(
    candidate: SearchMatchCandidate,
    originalGame?: CanonicalGame | null,
    options?: { nonSteamOnly?: boolean }
  ): Promise<ScrapedMetadataBundle> {
    return scrapeCandidateMatchDetails(candidate, originalGame, options);
  }

  /**
   * Searches across storefronts and IGDB for cover art options matching a custom query and source filter.
   */
  async searchCoverOptions(
    query: string,
    sourceFilter: string = 'All',
    game?: CanonicalGame | null
  ): Promise<ScrapedCoverOption[]> {
    return buildCoverOptionsFromSearch(
      query,
      sourceFilter,
      (q, src) => this.searchStorefronts(q, src),
      game
    );
  }

  /**
   * Searches across storefronts for structured MetadataSourceOption bundles matching a query and source filter.
   */
  async searchMetadataSources(
    query: string,
    sourceFilter: string = 'All',
    game?: CanonicalGame | null
  ): Promise<MetadataSourceOption[]> {
    return buildMetadataSourcesFromSearch(
      query,
      sourceFilter,
      (q, src) => this.searchStorefronts(q, src),
      game
    );
  }
}

export const metadataScraperService = new MetadataScraperService();
