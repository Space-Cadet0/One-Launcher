import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import {
  SearchMatchCandidate,
  ScrapedCoverOption,
  ScrapedMetadataBundle,
  MetadataSourceOption,
} from '../../contracts/override';
import { withTimeoutFallback } from '../../utils/asyncUtils';
import { getAlphabeticalTitleSortKey } from '../common/titleSortUtils';
import { sanitizeStoreReleaseDate } from '../common/titleUtils';
import { storefrontReviewHarvester } from '../critic/storefrontReviewHarvester';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
} from '../igdb/igdbCoverService';
import { requestScheduler, Priority } from '../network/requestScheduler';
import {
  fallbackMetadataProvider,
  extractFirstParagraph,
  stripHtmlToPlainSynopsis,
} from '../steam/fallbackMetadataProvider';
import { steamApi, SteamStoreBrowseAssets } from '../steam/steamApi';
import { steamMatcher } from '../steam/steamMatcher';
import {
  GogEnrichedEntry,
  StorefrontSearchSource,
  gogCacheMap,
  hasGogCacheEntries,
  lookupKnownEpicApp,
  getErrorMessage,
  extractXboxStoreProductId,
  isXboxStoreCandidateId,
  extractXboxBigId,
  buildCandidateStoreUrl,
  getSteamHeaderUrl,
  resolveSteamCandidateCapsuleUrl,
  buildSteamCoverOptions,
  resolveSteamBrowseAssets,
  deduplicateCovers,
  deduplicateDescriptions,
  resolveReleaseYearHint,
  findGogCounterpartId,
} from './scraperUrlAndQueryUtils';

function buildOriginalMetadataOption(
  originalGame?: CanonicalGame | null
): MetadataSourceOption | null {
  if (
    !originalGame ||
    (!originalGame.shortDescription &&
      !originalGame.developers?.length &&
      !originalGame.genres?.length)
  ) {
    return null;
  }
  const origPlat = originalGame.platforms?.[0];
  const origSource = origPlat?.platformId || (originalGame.steamAppId ? 'steam' : 'original');
  const origTitle =
    originalGame.originalStoreTitle || origPlat?.originalTitle || originalGame.title;
  const cleanOrigShort = stripHtmlToPlainSynopsis(originalGame.shortDescription);
  return {
    id: `original-${originalGame.id}`,
    source: 'original',
    sourceLabel: 'Original Library Metadata',
    matchedId: originalGame.id,
    storeUrl: buildCandidateStoreUrl({
      source: origSource,
      title: origTitle,
      steamAppId: originalGame.steamAppId,
      gogId: origSource === 'gog' ? origPlat?.platformGameId : undefined,
      epicSlug: origSource === 'epic' ? origPlat?.platformGameId : undefined,
      xboxProductId:
        origSource === 'xbox'
          ? origPlat?.xboxProductId || origPlat?.platformGameId
          : undefined,
    }),
    title: originalGame.title,
    shortDescription: cleanOrigShort || undefined,
    detailedDescription: originalGame.detailedDescription || cleanOrigShort,
    availableDescriptions: cleanOrigShort
      ? [{ source: 'Original Library Synopsis', text: cleanOrigShort }]
      : [],
    releaseDate: originalGame.releaseDate,
    developers: originalGame.developers,
    publishers: originalGame.publishers,
    genres: originalGame.genres,
    tags: originalGame.tags,
    headerImage: originalGame.headerImage,
    capsuleImage: originalGame.capsuleImage,
  };
}

function buildSteamMetadataOption(
  appId: number,
  steamMeta: Partial<SteamEnrichedMetadata> | null | undefined,
  fallbackTitle: string,
  browseAssets?: SteamStoreBrowseAssets | null
): MetadataSourceOption {
  const cleanSteamShort = stripHtmlToPlainSynopsis(steamMeta?.shortDescription);
  const steamFirstPara = extractFirstParagraph(
    steamMeta?.detailedDescription || steamMeta?.aboutTheGame
  );
  const steamDescs = deduplicateDescriptions([
    ...(cleanSteamShort
      ? [{ source: 'Steam Store Synopsis', text: cleanSteamShort }]
      : []),
    ...(steamFirstPara && steamFirstPara !== cleanSteamShort
      ? [{ source: 'Steam Detailed Overview', text: steamFirstPara }]
      : []),
  ]);
  const resolvedTitle = steamMeta?.name || fallbackTitle;
  return {
    id: `steam-${appId}`,
    source: 'steam',
    sourceLabel: 'Steam Store Metadata',
    matchedId: appId,
    steamAppId: appId,
    storeUrl: buildCandidateStoreUrl({
      source: 'steam',
      title: resolvedTitle,
      steamAppId: appId,
    }),
    title: resolvedTitle,
    shortDescription: cleanSteamShort || steamDescs[0]?.text,
    detailedDescription: steamMeta?.detailedDescription || steamMeta?.aboutTheGame,
    availableDescriptions: steamDescs,
    releaseDate: steamMeta?.releaseDate,
    developers: steamMeta?.developers,
    publishers: steamMeta?.publishers,
    genres: steamMeta?.genres,
    tags: steamMeta?.tags,
    headerImage: steamMeta?.headerImage || getSteamHeaderUrl(appId),
    capsuleImage: resolveSteamCandidateCapsuleUrl(appId, browseAssets),
  };
}

function buildGogMetadataOption(
  gogId: string,
  gogMeta: Partial<SteamEnrichedMetadata> | null | undefined,
  cachedGog: GogEnrichedEntry | undefined,
  fallbackTitle: string
): MetadataSourceOption | null {
  if (!gogMeta && !cachedGog) return null;
  const gogLead = stripHtmlToPlainSynopsis(
    gogMeta?.shortDescription || cachedGog?.shortDescription
  );
  const gogFirstPara = extractFirstParagraph(
    gogMeta?.detailedDescription || cachedGog?.aboutTheGame
  );
  const gogDescs = deduplicateDescriptions([
    ...(gogLead ? [{ source: 'GOG Store Synopsis', text: gogLead }] : []),
    ...(gogFirstPara && gogFirstPara !== gogLead
      ? [{ source: 'GOG Detailed Overview', text: gogFirstPara }]
      : []),
  ]);
  const resolvedTitle = cachedGog?.title || fallbackTitle;
  return {
    id: `gog-${gogId}`,
    source: 'gog',
    sourceLabel: 'GOG.com Metadata',
    matchedId: gogId,
    gogId: String(gogId),
    storeUrl: buildCandidateStoreUrl({
      source: 'gog',
      title: resolvedTitle,
      gogId,
    }),
    title: resolvedTitle,
    shortDescription: gogLead || gogDescs[0]?.text,
    detailedDescription: gogMeta?.detailedDescription || cachedGog?.aboutTheGame || gogLead,
    availableDescriptions: gogDescs,
    releaseDate: gogMeta?.releaseDate || cachedGog?.releaseDate,
    developers: gogMeta?.developers || cachedGog?.developers,
    publishers: gogMeta?.publishers || cachedGog?.publishers,
    genres: gogMeta?.genres || cachedGog?.genres,
    tags: gogMeta?.tags || cachedGog?.tags,
    headerImage:
      gogMeta?.headerImage || cachedGog?.coverHorizontal || cachedGog?.coverVertical,
    capsuleImage:
      gogMeta?.capsuleImage || cachedGog?.coverVertical || cachedGog?.coverHorizontal,
  };
}

async function fetchCrossStoreSteamMeta(
  crossStoreSteamAppId?: number
): Promise<SteamEnrichedMetadata | null> {
  if (!crossStoreSteamAppId) return null;
  requestScheduler.promoteToInteractive(`steam:${crossStoreSteamAppId}`);
  return withTimeoutFallback(
    steamApi.fetchGameMetadata(crossStoreSteamAppId, Priority.P0_INTERACTIVE),
    4000,
    null
  );
}

async function scrapeSteamMatchDetails(
  candidate: SearchMatchCandidate,
  originalGame: CanonicalGame | null | undefined,
  crossStoreGogId: string | undefined
): Promise<ScrapedMetadataBundle> {
  const steamAppId =
    candidate.steamAppId ||
    (typeof candidate.id === 'number'
      ? candidate.id
      : parseInt(String(candidate.id).replace(/^steam-/, ''), 10));

  const cachedGog =
    crossStoreGogId && hasGogCacheEntries() ? gogCacheMap[crossStoreGogId] : undefined;

  const [meta, gogMeta, steamAnchor, browseAssets] = await Promise.all([
    (async () => {
      if (!steamAppId || isNaN(steamAppId)) return null;
      try {
        requestScheduler.promoteToInteractive(`steam:${steamAppId}`);
        return await withTimeoutFallback(
          steamApi.fetchGameMetadata(steamAppId, Priority.P0_INTERACTIVE),
          4500,
          null
        );
      } catch (err: unknown) {
        console.warn(
          `[MetadataScraperService] Failed to fetch Steam metadata for ${steamAppId}:`,
          getErrorMessage(err)
        );
        return null;
      }
    })(),
    (async () => {
      if (!crossStoreGogId) return null;
      if (cachedGog?.shortDescription && cachedGog?.coverVertical) return null;
      return withTimeoutFallback(
        fallbackMetadataProvider.fetchGogProductMetadata(
          crossStoreGogId,
          candidate.title || originalGame?.title
        ),
        3500,
        null
      );
    })(),
    (async () => {
      if (!steamAppId || isNaN(steamAppId)) return undefined;
      try {
        return (
          (await withTimeoutFallback(
            storefrontReviewHarvester.getSteamAnchor(steamAppId),
            3500,
            null
          )) || undefined
        );
      } catch (err: unknown) {
        console.warn(
          `[MetadataScraperService] Failed to harvest Steam anchor for ${steamAppId}:`,
          getErrorMessage(err)
        );
        return undefined;
      }
    })(),
    steamAppId && !isNaN(steamAppId)
      ? resolveSteamBrowseAssets(steamAppId, {
          allowFetch: isKnownDeadSteamCover(steamAppId),
          timeoutMs: 2500,
        })
      : Promise.resolve(null),
  ]);

  const resolvedHeaderImage =
    meta?.headerImage || candidate.headerImage || getSteamHeaderUrl(steamAppId);

  // 1. Assemble Available Covers
  const rawCovers: ScrapedCoverOption[] = buildSteamCoverOptions(steamAppId, { browseAssets });

  if (
    originalGame?.capsuleImage &&
    !isGogCroppedHorizontalCover(originalGame.capsuleImage, originalGame.headerImage)
  ) {
    rawCovers.push({
      url: originalGame.capsuleImage,
      source: 'original',
      label: 'Original Library Cover',
    });
  }

  const gogCoverVertical = gogMeta?.capsuleImage || cachedGog?.coverVertical;
  const gogHeaderForCoverCheck = gogMeta?.headerImage || cachedGog?.coverHorizontal;
  if (gogCoverVertical && !isGogCroppedHorizontalCover(gogCoverVertical, gogHeaderForCoverCheck)) {
    rawCovers.push({
      url: gogCoverVertical,
      source: 'gog',
      label: 'GOG Official Cover',
      dimensions: 'vertical',
    });
  }

  if (originalGame?.platforms) {
    const epicPlat = originalGame.platforms.find((p) => p.platformId === 'epic');
    if (epicPlat?.platformGameId) {
      const epicMapping = lookupKnownEpicApp(epicPlat.platformGameId, originalGame.title);
      if (epicMapping?.capsuleImage) {
        rawCovers.push({
          url: epicMapping.capsuleImage,
          source: 'epic',
          label: 'Epic Portrait Cover',
        });
      }
    }
  }

  // Check IGDB cover for fallback / alternative option with resolved release year
  const igdbReleaseYear = resolveReleaseYearHint(
    candidate.year,
    meta?.releaseDate,
    originalGame?.releaseDate
  );
  const igdbCover =
    igdbCoverService.getIgdbCoverInstant(
      candidate.title,
      steamAppId,
      originalGame?.id,
      igdbReleaseYear
    ) ||
    (await withTimeoutFallback(
      igdbCoverService
        .fetchIgdbCover(candidate.title, igdbReleaseYear, Priority.P0_INTERACTIVE)
        .catch(() => null),
      3500,
      null
    ));

  if (igdbCover) {
    rawCovers.push({
      url: igdbCover,
      source: 'igdb',
      label: 'IGDB Portrait Cover',
      dimensions: 't_cover_big',
    });
  }

  const availableCovers = deduplicateCovers(rawCovers, resolvedHeaderImage);

  // 2. Assemble Available Descriptions
  const rawDescriptions: { source: string; text: string }[] = [];
  if (meta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Store Synopsis',
      text: meta.shortDescription,
    });
  }

  const firstPara = extractFirstParagraph(meta?.detailedDescription || meta?.aboutTheGame);
  if (firstPara && firstPara !== meta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Detailed Overview',
      text: firstPara,
    });
  }

  const gogLead = gogMeta?.shortDescription || cachedGog?.shortDescription;
  if (gogLead) {
    rawDescriptions.push({
      source: 'GOG Store Synopsis',
      text: gogLead,
    });
  }
  const gogFirstPara = extractFirstParagraph(
    gogMeta?.detailedDescription || cachedGog?.aboutTheGame
  );
  if (gogFirstPara && gogFirstPara !== gogLead) {
    rawDescriptions.push({
      source: 'GOG Detailed Overview',
      text: gogFirstPara,
    });
  }

  if (originalGame?.shortDescription) {
    rawDescriptions.push({
      source: 'Original Library Synopsis',
      text: originalGame.shortDescription,
    });
  }

  const availableDescriptions = deduplicateDescriptions(rawDescriptions);

  // 3. Assemble Available Metadata Sources
  const availableMetadataSources: MetadataSourceOption[] = [
    buildSteamMetadataOption(steamAppId, meta, candidate.title, browseAssets),
  ];
  if (crossStoreGogId) {
    const gogOption = buildGogMetadataOption(
      crossStoreGogId,
      gogMeta,
      cachedGog,
      meta?.name || candidate.title
    );
    if (gogOption) availableMetadataSources.push(gogOption);
  }
  const origOption = buildOriginalMetadataOption(originalGame);
  if (origOption) availableMetadataSources.push(origOption);

  const resolvedTitle = meta?.name || candidate.title;
  return {
    matchedStore: 'steam',
    matchedId: steamAppId,
    title: resolvedTitle,
    sortTitle: getAlphabeticalTitleSortKey(resolvedTitle),
    steamAppId,
    capsuleImage:
      availableCovers[0]?.url || resolveSteamCandidateCapsuleUrl(steamAppId, browseAssets) || '',
    availableCovers,
    headerImage: resolvedHeaderImage,
    iconUrl: meta?.iconUrl || originalGame?.iconUrl || '',
    shortDescription: stripHtmlToPlainSynopsis(
      meta?.shortDescription ||
        availableDescriptions[0]?.text ||
        originalGame?.shortDescription ||
        ''
    ),
    detailedDescription: meta?.detailedDescription || meta?.aboutTheGame || '',
    availableDescriptions,
    availableMetadataSources,
    developers: meta?.developers?.length ? meta.developers : originalGame?.developers || [],
    publishers: meta?.publishers?.length ? meta.publishers : originalGame?.publishers || [],
    genres: meta?.genres?.length ? meta.genres : originalGame?.genres || [],
    tags: meta?.tags?.length ? meta.tags : originalGame?.tags || [],
    releaseDate: meta?.releaseDate || originalGame?.releaseDate || '',
    storefrontAnchor: steamAnchor,
    metadataRoute: {
      source: 'steam',
      matchedId: steamAppId,
      steamAppId,
      gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
    },
  };
}

async function scrapeGogMatchDetails(
  candidate: SearchMatchCandidate,
  originalGame: CanonicalGame | null | undefined,
  crossStoreSteamAppId: number | undefined
): Promise<ScrapedMetadataBundle> {
  const gogId = String(candidate.gogId || candidate.id).replace(/^gog-/, '');
  const cached = hasGogCacheEntries() ? gogCacheMap[gogId] : undefined;

  const [storeMeta, steamMeta, browseAssets, gogAnchor] = await Promise.all([
    (async () => {
      try {
        return await withTimeoutFallback(
          fallbackMetadataProvider.fetchGogProductMetadata(
            gogId,
            candidate.title || originalGame?.title
          ),
          4000,
          null
        );
      } catch (err: unknown) {
        console.warn(
          `[MetadataScraperService] GOG metadata fetch failed for ${gogId}:`,
          getErrorMessage(err)
        );
        return null;
      }
    })(),
    fetchCrossStoreSteamMeta(crossStoreSteamAppId),
    resolveSteamBrowseAssets(crossStoreSteamAppId, { allowFetch: true, timeoutMs: 2500 }),
    (async () => {
      try {
        return (
          (await withTimeoutFallback(
            storefrontReviewHarvester.getGogAnchor(gogId, candidate.title),
            3500,
            null
          )) || undefined
        );
      } catch (err: unknown) {
        console.warn(
          `[MetadataScraperService] Failed to harvest GOG anchor for ${gogId}:`,
          getErrorMessage(err)
        );
        return undefined;
      }
    })(),
  ]);

  const resolvedHeaderImage =
    storeMeta?.headerImage ||
    cached?.coverHorizontal ||
    candidate.headerImage ||
    originalGame?.headerImage ||
    '';

  const gogVertical = storeMeta?.capsuleImage || cached?.coverVertical || candidate.capsuleImage;
  const rawCovers: ScrapedCoverOption[] = [];

  if (gogVertical) {
    rawCovers.push({
      url: gogVertical,
      source: 'gog',
      label: 'GOG Official Cover',
      dimensions: 'vertical',
    });
  }

  if (crossStoreSteamAppId) {
    rawCovers.push(...buildSteamCoverOptions(crossStoreSteamAppId, { browseAssets }));
  }

  if (
    originalGame?.capsuleImage &&
    !isGogCroppedHorizontalCover(originalGame.capsuleImage, originalGame.headerImage)
  ) {
    rawCovers.push({
      url: originalGame.capsuleImage,
      source: 'original',
      label: 'Original Library Cover',
    });
  }

  const igdbCover = igdbCoverService.getIgdbCoverInstant(candidate.title, crossStoreSteamAppId);
  if (igdbCover) {
    rawCovers.push({
      url: igdbCover,
      source: 'igdb',
      label: 'IGDB Portrait Cover',
      dimensions: 't_cover_big',
    });
  }

  const availableCovers = deduplicateCovers(rawCovers, resolvedHeaderImage);

  const rawDescriptions: { source: string; text: string }[] = [];
  const gogLead = stripHtmlToPlainSynopsis(
    storeMeta?.shortDescription || cached?.shortDescription
  );
  if (gogLead) {
    rawDescriptions.push({
      source: 'GOG Store Synopsis',
      text: gogLead,
    });
  }

  const firstPara = extractFirstParagraph(storeMeta?.detailedDescription || cached?.aboutTheGame);
  if (firstPara && firstPara !== gogLead) {
    rawDescriptions.push({
      source: 'GOG Detailed Overview',
      text: firstPara,
    });
  }

  if (steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Store Synopsis',
      text: steamMeta.shortDescription,
    });
  }
  const steamFirstPara = extractFirstParagraph(
    steamMeta?.detailedDescription || steamMeta?.aboutTheGame
  );
  if (steamFirstPara && steamFirstPara !== steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Detailed Overview',
      text: steamFirstPara,
    });
  }

  if (originalGame?.shortDescription) {
    rawDescriptions.push({
      source: 'Original Library Synopsis',
      text: originalGame.shortDescription,
    });
  }

  const availableDescriptions = deduplicateDescriptions(rawDescriptions);

  const resolvedTitle = candidate.title || cached?.title || originalGame?.title || '';
  const availableMetadataSources: MetadataSourceOption[] = [];
  const gogOption = buildGogMetadataOption(gogId, storeMeta, cached, resolvedTitle) || {
    id: `gog-${gogId}`,
    source: 'gog',
    sourceLabel: 'GOG.com Metadata',
    matchedId: gogId,
    gogId: String(gogId),
    storeUrl: buildCandidateStoreUrl({
      source: 'gog',
      title: cached?.title || resolvedTitle,
      gogId,
    }),
    title: resolvedTitle,
    shortDescription: gogLead || availableDescriptions[0]?.text,
    detailedDescription: storeMeta?.detailedDescription || cached?.aboutTheGame || '',
    availableDescriptions: deduplicateDescriptions([
      ...(gogLead ? [{ source: 'GOG Store Synopsis', text: gogLead }] : []),
      ...(firstPara && firstPara !== gogLead
        ? [{ source: 'GOG Detailed Overview', text: firstPara }]
        : []),
    ]),
    releaseDate: storeMeta?.releaseDate || cached?.releaseDate,
    developers: storeMeta?.developers || cached?.developers,
    publishers: storeMeta?.publishers || cached?.publishers,
    genres: storeMeta?.genres || cached?.genres,
    tags: storeMeta?.tags || cached?.tags,
    headerImage: storeMeta?.headerImage || cached?.coverHorizontal || candidate.headerImage,
    capsuleImage: gogVertical,
  };
  availableMetadataSources.push(gogOption);

  if (crossStoreSteamAppId) {
    availableMetadataSources.push(
      buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, resolvedTitle, browseAssets)
    );
  }
  const origOption = buildOriginalMetadataOption(originalGame);
  if (origOption) availableMetadataSources.push(origOption);

  const safeGogFallbackCover =
    gogVertical &&
    !isUnsuitableCoverUrl(gogVertical) &&
    !isGogCroppedHorizontalCover(gogVertical, resolvedHeaderImage)
      ? gogVertical
      : '';

  return {
    matchedStore: 'gog',
    matchedId: gogId,
    title: resolvedTitle,
    sortTitle: getAlphabeticalTitleSortKey(resolvedTitle),
    steamAppId: null, // Non-Steam match explicitly unlinks Steam
    capsuleImage:
      availableCovers[0]?.url || safeGogFallbackCover || originalGame?.capsuleImage || '',
    availableCovers,
    headerImage: resolvedHeaderImage,
    iconUrl: originalGame?.iconUrl || '',
    shortDescription: stripHtmlToPlainSynopsis(
      gogLead || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
    ),
    detailedDescription: storeMeta?.detailedDescription || cached?.aboutTheGame || '',
    availableDescriptions,
    availableMetadataSources,
    developers: storeMeta?.developers || cached?.developers || originalGame?.developers || [],
    publishers: storeMeta?.publishers || cached?.publishers || originalGame?.publishers || [],
    genres: storeMeta?.genres || cached?.genres || originalGame?.genres || [],
    tags: storeMeta?.tags || cached?.tags || originalGame?.tags || [],
    releaseDate:
      storeMeta?.releaseDate || cached?.releaseDate || originalGame?.releaseDate || '',
    storefrontAnchor: gogAnchor,
    metadataRoute: {
      source: 'gog',
      matchedId: gogId,
      steamAppId: crossStoreSteamAppId,
      gogId: String(gogId),
    },
  };
}

async function scrapeEpicMatchDetails(
  candidate: SearchMatchCandidate,
  originalGame: CanonicalGame | null | undefined,
  crossStoreSteamAppId: number | undefined,
  crossStoreGogId: string | undefined
): Promise<ScrapedMetadataBundle> {
  const epicId = String(candidate.id).replace(/^epic-/, '');
  const cleanSlug = candidate.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const epicPlatform = originalGame?.platforms?.find((p) => p.platformId === 'epic');
  const epicFetchOpts = {
    appName: epicPlatform?.platformGameId || epicId,
    namespace: epicPlatform?.namespace,
    catalogItemId: epicPlatform?.catalogItemId,
    title: candidate.title || originalGame?.title,
  };

  const [storeMeta, steamMeta, browseAssets] = await Promise.all([
    (async () => {
      try {
        let meta = await withTimeoutFallback(
          fallbackMetadataProvider.fetchEpicProductMetadata(cleanSlug, epicFetchOpts),
          4500,
          null
        );
        if (!meta) {
          meta = await withTimeoutFallback(
            fallbackMetadataProvider.fetchEpicProductMetadata(epicId, epicFetchOpts),
            4500,
            null
          );
        }
        return meta;
      } catch (err: unknown) {
        console.warn(
          `[MetadataScraperService] Epic metadata fetch failed for ${candidate.title}:`,
          getErrorMessage(err)
        );
        return null;
      }
    })(),
    fetchCrossStoreSteamMeta(crossStoreSteamAppId),
    resolveSteamBrowseAssets(crossStoreSteamAppId, { allowFetch: true, timeoutMs: 2500 }),
  ]);

  const resolvedHeaderImage =
    storeMeta?.headerImage || candidate.headerImage || originalGame?.headerImage || '';
  const epicVertical = storeMeta?.capsuleImage || candidate.capsuleImage;
  const rawCovers: ScrapedCoverOption[] = [];

  if (epicVertical) {
    rawCovers.push({
      url: epicVertical,
      source: 'epic',
      label: 'Epic Portrait Cover',
    });
  }

  if (crossStoreSteamAppId) {
    rawCovers.push(...buildSteamCoverOptions(crossStoreSteamAppId, { browseAssets }));
  }

  if (
    originalGame?.capsuleImage &&
    !isGogCroppedHorizontalCover(originalGame.capsuleImage, originalGame.headerImage)
  ) {
    rawCovers.push({
      url: originalGame.capsuleImage,
      source: 'original',
      label: 'Original Library Cover',
    });
  }

  if (crossStoreGogId && hasGogCacheEntries()) {
    const cachedGog = gogCacheMap[crossStoreGogId];
    if (
      cachedGog?.coverVertical &&
      !isGogCroppedHorizontalCover(cachedGog.coverVertical, cachedGog.coverHorizontal)
    ) {
      rawCovers.push({
        url: cachedGog.coverVertical,
        source: 'gog',
        label: 'GOG Official Cover',
        dimensions: 'vertical',
      });
    }
  }

  const igdbCover = igdbCoverService.getIgdbCoverInstant(candidate.title, crossStoreSteamAppId);
  if (igdbCover) {
    rawCovers.push({
      url: igdbCover,
      source: 'igdb',
      label: 'IGDB Portrait Cover',
      dimensions: 't_cover_big',
    });
  }

  const availableCovers = deduplicateCovers(rawCovers, resolvedHeaderImage);

  const rawDescriptions: { source: string; text: string }[] = [];
  const epicShort = stripHtmlToPlainSynopsis(
    storeMeta?.shortDescription || candidate.description
  );
  if (epicShort) {
    rawDescriptions.push({
      source: 'Epic Store Synopsis',
      text: epicShort,
    });
  }

  const firstPara = extractFirstParagraph(
    storeMeta?.detailedDescription || storeMeta?.aboutTheGame
  );
  if (firstPara && firstPara !== epicShort) {
    rawDescriptions.push({
      source: 'Epic Detailed Overview',
      text: firstPara,
    });
  }

  if (steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Store Synopsis',
      text: steamMeta.shortDescription,
    });
  }
  const steamFirstPara = extractFirstParagraph(
    steamMeta?.detailedDescription || steamMeta?.aboutTheGame
  );
  if (steamFirstPara && steamFirstPara !== steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Detailed Overview',
      text: steamFirstPara,
    });
  }

  if (originalGame?.shortDescription) {
    rawDescriptions.push({
      source: 'Original Library Synopsis',
      text: originalGame.shortDescription,
    });
  }

  const availableDescriptions = deduplicateDescriptions(rawDescriptions);

  const resolvedTitle = candidate.title || originalGame?.title || '';
  const epicDescs = deduplicateDescriptions([
    ...(epicShort ? [{ source: 'Epic Store Synopsis', text: epicShort }] : []),
    ...(firstPara && firstPara !== epicShort
      ? [{ source: 'Epic Detailed Overview', text: firstPara }]
      : []),
  ]);
  const verifiedEpicSlug =
    !/^[0-9a-f]{20,}$/i.test(epicId) && !epicId.startsWith('search-') && epicId !== cleanSlug
      ? epicId
      : undefined;
  const availableMetadataSources: MetadataSourceOption[] = [
    {
      id: `epic-${epicId}`,
      source: 'epic',
      sourceLabel: 'Epic Games Store',
      matchedId: epicId,
      epicSlug: verifiedEpicSlug || cleanSlug || String(epicId),
      storeUrl:
        candidate.storeUrl ||
        buildCandidateStoreUrl({
          source: 'epic',
          title: resolvedTitle,
          epicSlug: verifiedEpicSlug,
        }),
      title: resolvedTitle,
      shortDescription: epicShort || epicDescs[0]?.text,
      detailedDescription: storeMeta?.detailedDescription || candidate.description || '',
      availableDescriptions: epicDescs,
      releaseDate:
        storeMeta?.releaseDate || (candidate.year ? String(candidate.year) : undefined),
      developers: storeMeta?.developers,
      publishers: storeMeta?.publishers,
      genres: storeMeta?.genres,
      tags: storeMeta?.tags,
      headerImage: storeMeta?.headerImage || candidate.headerImage,
      capsuleImage: epicVertical,
    },
  ];

  if (crossStoreSteamAppId) {
    availableMetadataSources.push(
      buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, resolvedTitle, browseAssets)
    );
  }
  if (crossStoreGogId && hasGogCacheEntries()) {
    const cachedGog = gogCacheMap[crossStoreGogId];
    const gogOption = buildGogMetadataOption(crossStoreGogId, null, cachedGog, resolvedTitle);
    if (gogOption) availableMetadataSources.push(gogOption);
  }
  const origOption = buildOriginalMetadataOption(originalGame);
  if (origOption) availableMetadataSources.push(origOption);

  return {
    matchedStore: 'epic',
    matchedId: epicId,
    title: resolvedTitle,
    sortTitle: getAlphabeticalTitleSortKey(resolvedTitle),
    steamAppId: null, // Non-Steam match explicitly unlinks Steam
    capsuleImage: availableCovers[0]?.url || epicVertical || originalGame?.capsuleImage || '',
    availableCovers,
    headerImage: resolvedHeaderImage,
    iconUrl: storeMeta?.iconUrl || originalGame?.iconUrl || '',
    shortDescription: stripHtmlToPlainSynopsis(
      epicShort || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
    ),
    detailedDescription: storeMeta?.detailedDescription || candidate.description || '',
    availableDescriptions,
    availableMetadataSources,
    developers: storeMeta?.developers || originalGame?.developers || [],
    publishers: storeMeta?.publishers || originalGame?.publishers || [],
    genres: storeMeta?.genres || originalGame?.genres || [],
    tags: storeMeta?.tags || originalGame?.tags || [],
    releaseDate:
      storeMeta?.releaseDate ||
      (candidate.year ? String(candidate.year) : originalGame?.releaseDate || ''),
    metadataRoute: {
      source: 'epic',
      matchedId: epicId,
      steamAppId: crossStoreSteamAppId,
      gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
    },
  };
}

async function scrapeXboxMatchDetails(
  candidate: SearchMatchCandidate,
  originalGame: CanonicalGame | null | undefined,
  crossStoreSteamAppId: number | undefined,
  crossStoreGogId: string | undefined
): Promise<ScrapedMetadataBundle> {
  const xboxRawId = String(candidate.id).replace(/^xbox-/i, '').trim();
  const xboxPlat = originalGame?.platforms?.find((p) => p.platformId === 'xbox');
  const xboxBigId =
    extractXboxBigId(xboxRawId) ||
    extractXboxBigId(xboxPlat?.xboxProductId) ||
    extractXboxBigId(xboxPlat?.platformGameId);
  const xboxReleaseYear = resolveReleaseYearHint(candidate.year, originalGame?.releaseDate);

  const [storeMeta, igdbCover, steamMeta, browseAssets] = await Promise.all([
    withTimeoutFallback(
      fallbackMetadataProvider
        .fetchXboxProductMetadata({
          xboxProductId: xboxBigId,
          title: candidate.title || originalGame?.title,
        })
        .catch(() => null),
      4000,
      null
    ),
    (async () => {
      return (
        igdbCoverService.getIgdbCoverInstant(
          candidate.title,
          crossStoreSteamAppId,
          originalGame?.id,
          xboxReleaseYear
        ) ||
        (await withTimeoutFallback(
          igdbCoverService
            .fetchIgdbCover(candidate.title, xboxReleaseYear, Priority.P0_INTERACTIVE)
            .catch(() => null),
          3500,
          null
        ))
      );
    })(),
    fetchCrossStoreSteamMeta(crossStoreSteamAppId),
    resolveSteamBrowseAssets(crossStoreSteamAppId, { allowFetch: true, timeoutMs: 2500 }),
  ]);

  const resolvedTitle = storeMeta?.name || candidate.title || originalGame?.title || '';
  const resolvedHeaderImage =
    storeMeta?.headerImage || candidate.headerImage || originalGame?.headerImage || '';
  const xboxVertical = storeMeta?.capsuleImage || candidate.capsuleImage;

  const rawCovers: ScrapedCoverOption[] = [];
  if (xboxVertical) {
    rawCovers.push({
      url: xboxVertical,
      source: 'xbox',
      label: `Xbox Store Cover — ${resolvedTitle}`,
      dimensions: '2:3',
    });
  }

  if (igdbCover) {
    rawCovers.push({
      url: igdbCover,
      source: 'igdb',
      label: 'IGDB Portrait Cover',
      dimensions: 't_cover_big',
    });
  }

  if (crossStoreSteamAppId) {
    rawCovers.push(...buildSteamCoverOptions(crossStoreSteamAppId, { browseAssets }));
  }

  if (crossStoreGogId && hasGogCacheEntries()) {
    const cachedGog = gogCacheMap[crossStoreGogId];
    if (
      cachedGog?.coverVertical &&
      !isGogCroppedHorizontalCover(cachedGog.coverVertical, cachedGog.coverHorizontal)
    ) {
      rawCovers.push({
        url: cachedGog.coverVertical,
        source: 'gog',
        label: 'GOG Official Cover',
        dimensions: 'vertical',
      });
    }
  }

  if (
    originalGame?.capsuleImage &&
    !isGogCroppedHorizontalCover(originalGame.capsuleImage, originalGame.headerImage)
  ) {
    rawCovers.push({
      url: originalGame.capsuleImage,
      source: 'original',
      label: 'Original Library Cover',
    });
  }

  const availableCovers = deduplicateCovers(rawCovers, resolvedHeaderImage);

  const xboxShort = stripHtmlToPlainSynopsis(
    storeMeta?.shortDescription || candidate.description
  );
  const xboxFirstPara = extractFirstParagraph(
    storeMeta?.detailedDescription || storeMeta?.aboutTheGame
  );
  const rawDescriptions: { source: string; text: string }[] = [];
  if (xboxShort) {
    rawDescriptions.push({
      source: 'Xbox Store Synopsis',
      text: xboxShort,
    });
  }
  if (xboxFirstPara && xboxFirstPara !== xboxShort) {
    rawDescriptions.push({
      source: 'Xbox Detailed Overview',
      text: xboxFirstPara,
    });
  }
  if (steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Store Synopsis',
      text: steamMeta.shortDescription,
    });
  }
  if (originalGame?.shortDescription) {
    rawDescriptions.push({
      source: 'Original Library Synopsis',
      text: originalGame.shortDescription,
    });
  }
  const availableDescriptions = deduplicateDescriptions(rawDescriptions);

  const xboxDescs = deduplicateDescriptions([
    ...(xboxShort ? [{ source: 'Xbox Store Synopsis', text: xboxShort }] : []),
    ...(xboxFirstPara && xboxFirstPara !== xboxShort
      ? [{ source: 'Xbox Detailed Overview', text: xboxFirstPara }]
      : []),
  ]);

  const rawStoreProductId = extractXboxStoreProductId(storeMeta);
  const canonicalXboxId = xboxBigId || rawStoreProductId || xboxRawId;
  const prefixedXboxId = `xbox-${canonicalXboxId}`;
  const xboxStoreUrl =
    candidate.storeUrl ||
    buildCandidateStoreUrl({
      source: 'xbox',
      title: resolvedTitle,
      xboxProductId: xboxBigId || rawStoreProductId,
    });

  const availableMetadataSources: MetadataSourceOption[] = [
    {
      id: prefixedXboxId,
      source: 'xbox',
      sourceLabel: 'Xbox / Microsoft Store',
      matchedId: canonicalXboxId,
      storeUrl: xboxStoreUrl,
      title: resolvedTitle,
      shortDescription: xboxShort || xboxDescs[0]?.text,
      detailedDescription:
        storeMeta?.detailedDescription || storeMeta?.aboutTheGame || candidate.description || '',
      availableDescriptions: xboxDescs,
      releaseDate:
        storeMeta?.releaseDate || (candidate.year ? String(candidate.year) : undefined),
      developers: storeMeta?.developers,
      publishers: storeMeta?.publishers,
      genres: storeMeta?.genres,
      tags: storeMeta?.tags,
      headerImage: storeMeta?.headerImage || candidate.headerImage,
      capsuleImage: xboxVertical,
    },
  ];

  if (crossStoreSteamAppId) {
    availableMetadataSources.push(
      buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, resolvedTitle, browseAssets)
    );
  }
  if (crossStoreGogId && hasGogCacheEntries()) {
    const cachedGog = gogCacheMap[crossStoreGogId];
    const gogOption = buildGogMetadataOption(crossStoreGogId, null, cachedGog, resolvedTitle);
    if (gogOption) availableMetadataSources.push(gogOption);
  }
  const origOption = buildOriginalMetadataOption(originalGame);
  if (origOption) availableMetadataSources.push(origOption);

  return {
    matchedStore: 'xbox',
    matchedId: prefixedXboxId,
    title: resolvedTitle,
    sortTitle: getAlphabeticalTitleSortKey(resolvedTitle),
    steamAppId: null, // Non-Steam match explicitly unlinks Steam
    capsuleImage: availableCovers[0]?.url || xboxVertical || originalGame?.capsuleImage || '',
    availableCovers,
    headerImage: resolvedHeaderImage,
    iconUrl: storeMeta?.iconUrl || originalGame?.iconUrl || '',
    shortDescription: stripHtmlToPlainSynopsis(
      xboxShort || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
    ),
    detailedDescription:
      storeMeta?.detailedDescription ||
      storeMeta?.aboutTheGame ||
      candidate.description ||
      '',
    availableDescriptions,
    availableMetadataSources,
    developers: storeMeta?.developers || originalGame?.developers || [],
    publishers: storeMeta?.publishers || originalGame?.publishers || [],
    genres: storeMeta?.genres || originalGame?.genres || [],
    tags: storeMeta?.tags || originalGame?.tags || [],
    releaseDate:
      storeMeta?.releaseDate ||
      (candidate.year ? String(candidate.year) : originalGame?.releaseDate || ''),
    metadataRoute: {
      source: 'xbox',
      matchedId: canonicalXboxId,
      steamAppId: crossStoreSteamAppId,
      gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
    },
  };
}

async function scrapeIgdbMatchDetails(
  candidate: SearchMatchCandidate,
  originalGame: CanonicalGame | null | undefined,
  crossStoreSteamAppId: number | undefined,
  crossStoreGogId: string | undefined
): Promise<ScrapedMetadataBundle> {
  const igdbReleaseYear = resolveReleaseYearHint(candidate.year, originalGame?.releaseDate);

  const [igdbCover, steamMeta, browseAssets] = await Promise.all([
    (async () => {
      return (
        candidate.capsuleImage ||
        igdbCoverService.getIgdbCoverInstant(
          candidate.title,
          crossStoreSteamAppId,
          originalGame?.id,
          igdbReleaseYear
        ) ||
        (await withTimeoutFallback(
          igdbCoverService
            .fetchIgdbCover(candidate.title, igdbReleaseYear, Priority.P0_INTERACTIVE)
            .catch(() => null),
          3500,
          null
        ))
      );
    })(),
    fetchCrossStoreSteamMeta(crossStoreSteamAppId),
    resolveSteamBrowseAssets(crossStoreSteamAppId, {
      allowFetch: Boolean(crossStoreSteamAppId && isKnownDeadSteamCover(crossStoreSteamAppId)),
      timeoutMs: 2500,
    }),
  ]);

  const rawCovers: ScrapedCoverOption[] = [];
  if (igdbCover) {
    rawCovers.push({
      url: igdbCover,
      source: 'igdb',
      label: 'IGDB Portrait Cover',
      dimensions: 't_cover_big',
    });
  }

  if (crossStoreSteamAppId) {
    rawCovers.push(...buildSteamCoverOptions(crossStoreSteamAppId, { browseAssets }));
  }

  if (
    originalGame?.capsuleImage &&
    !isGogCroppedHorizontalCover(originalGame.capsuleImage, originalGame.headerImage)
  ) {
    rawCovers.push({
      url: originalGame.capsuleImage,
      source: 'original',
      label: 'Original Library Cover',
    });
  }

  if (crossStoreGogId && hasGogCacheEntries()) {
    const cachedGog = gogCacheMap[crossStoreGogId];
    if (
      cachedGog?.coverVertical &&
      !isGogCroppedHorizontalCover(cachedGog.coverVertical, cachedGog.coverHorizontal)
    ) {
      rawCovers.push({
        url: cachedGog.coverVertical,
        source: 'gog',
        label: 'GOG Official Cover',
        dimensions: 'vertical',
      });
    }
  }

  if (originalGame?.platforms) {
    const epicPlat = originalGame.platforms.find((p) => p.platformId === 'epic');
    if (epicPlat?.platformGameId) {
      const epicMapping = lookupKnownEpicApp(epicPlat.platformGameId, originalGame.title);
      if (epicMapping?.capsuleImage) {
        rawCovers.push({
          url: epicMapping.capsuleImage,
          source: 'epic',
          label: 'Epic Portrait Cover',
        });
      }
    }
  }

  const baseHeaderUrl = candidate.headerImage || originalGame?.headerImage || '';
  const availableCovers = deduplicateCovers(rawCovers, baseHeaderUrl);

  const rawDescriptions: { source: string; text: string }[] = [];
  const cleanIgdbDesc = stripHtmlToPlainSynopsis(candidate.description);
  if (cleanIgdbDesc) {
    rawDescriptions.push({
      source: 'IGDB Overview',
      text: cleanIgdbDesc,
    });
  }

  if (steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Store Synopsis',
      text: steamMeta.shortDescription,
    });
  }
  const steamFirstPara = extractFirstParagraph(
    steamMeta?.detailedDescription || steamMeta?.aboutTheGame
  );
  if (steamFirstPara && steamFirstPara !== steamMeta?.shortDescription) {
    rawDescriptions.push({
      source: 'Steam Detailed Overview',
      text: steamFirstPara,
    });
  }

  if (originalGame?.shortDescription) {
    rawDescriptions.push({
      source: 'Original Library Synopsis',
      text: originalGame.shortDescription,
    });
  }

  const availableDescriptions = deduplicateDescriptions(rawDescriptions);

  const matchedIgdbId = candidate.igdbId || candidate.id;
  const availableMetadataSources: MetadataSourceOption[] = [
    {
      id: String(candidate.id).startsWith('igdb-') ? String(candidate.id) : `igdb-${matchedIgdbId}`,
      source: 'igdb',
      sourceLabel: 'IGDB Metadata',
      matchedId: matchedIgdbId,
      igdbId: matchedIgdbId,
      storeUrl:
        candidate.storeUrl ||
        buildCandidateStoreUrl({
          source: 'igdb',
          title: candidate.title,
          igdbId: matchedIgdbId,
        }),
      title: candidate.title,
      shortDescription: cleanIgdbDesc || undefined,
      detailedDescription: candidate.description,
      availableDescriptions: cleanIgdbDesc
        ? [{ source: 'IGDB Overview', text: cleanIgdbDesc }]
        : [],
      releaseDate: candidate.year ? String(candidate.year) : undefined,
      capsuleImage: igdbCover || candidate.capsuleImage,
      headerImage: candidate.headerImage || igdbCover || candidate.capsuleImage,
    },
  ];

  if (crossStoreSteamAppId) {
    availableMetadataSources.push(
      buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, candidate.title, browseAssets)
    );
  }
  if (crossStoreGogId && hasGogCacheEntries()) {
    const cachedGog = gogCacheMap[crossStoreGogId];
    const gogOption = buildGogMetadataOption(crossStoreGogId, null, cachedGog, candidate.title);
    if (gogOption) availableMetadataSources.push(gogOption);
  }
  const origOption = buildOriginalMetadataOption(originalGame);
  if (origOption) availableMetadataSources.push(origOption);

  return {
    matchedStore: 'igdb',
    matchedId: matchedIgdbId,
    title: candidate.title,
    sortTitle: getAlphabeticalTitleSortKey(candidate.title || originalGame?.title || ''),
    steamAppId: null, // null explicitly unlinks Steam for non-Steam games
    igdbId: matchedIgdbId,
    capsuleImage: availableCovers[0]?.url || originalGame?.capsuleImage || '',
    availableCovers,
    headerImage: baseHeaderUrl || availableCovers[0]?.url || '',
    iconUrl: originalGame?.iconUrl || '',
    shortDescription: stripHtmlToPlainSynopsis(
      cleanIgdbDesc || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
    ),
    detailedDescription:
      candidate.description ||
      originalGame?.detailedDescription ||
      originalGame?.shortDescription ||
      '',
    availableDescriptions,
    availableMetadataSources,
    developers: originalGame?.developers || [],
    publishers: originalGame?.publishers || [],
    genres: originalGame?.genres || [],
    tags: originalGame?.tags || [],
    releaseDate: candidate.year ? String(candidate.year) : originalGame?.releaseDate || '',
    metadataRoute: {
      source: 'igdb',
      matchedId: matchedIgdbId,
      steamAppId: crossStoreSteamAppId,
      gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
      igdbId: matchedIgdbId,
    },
  };
}

/**
 * Scrapes comprehensive match details, assembling multiple portrait covers,
 * synopsis options, cross-storefront metadata sources, and deep metadata.
 */
export async function scrapeCandidateMatchDetails(
  candidate: SearchMatchCandidate,
  originalGame?: CanonicalGame | null,
  options?: { nonSteamOnly?: boolean }
): Promise<ScrapedMetadataBundle> {
  const crossStoreSteamAppId = options?.nonSteamOnly
    ? undefined
    : candidate.steamAppId ||
      originalGame?.steamAppId ||
      steamMatcher.matchGameToSteamInstant(candidate.title || originalGame?.title || '') ||
      undefined;

  const crossStoreGogId = findGogCounterpartId(candidate, originalGame);

  if (candidate.source === 'steam') {
    return scrapeSteamMatchDetails(candidate, originalGame, crossStoreGogId);
  }
  if (candidate.source === 'gog') {
    return scrapeGogMatchDetails(candidate, originalGame, crossStoreSteamAppId);
  }
  if (candidate.source === 'epic') {
    return scrapeEpicMatchDetails(candidate, originalGame, crossStoreSteamAppId, crossStoreGogId);
  }
  if (candidate.source === 'xbox' || isXboxStoreCandidateId(candidate.id, candidate.storeUrl)) {
    return scrapeXboxMatchDetails(candidate, originalGame, crossStoreSteamAppId, crossStoreGogId);
  }
  return scrapeIgdbMatchDetails(candidate, originalGame, crossStoreSteamAppId, crossStoreGogId);
}

/**
 * Searches across storefronts and IGDB for cover art options matching a custom query and source filter.
 */
export async function buildCoverOptionsFromSearch(
  query: string,
  sourceFilter: string,
  searchStorefrontsFn: (
    q: string,
    src: StorefrontSearchSource
  ) => Promise<SearchMatchCandidate[]>,
  game?: CanonicalGame | null
): Promise<ScrapedCoverOption[]> {
  const effectiveQuery = (query && query.trim()) || game?.title?.trim() || '';
  if (!effectiveQuery) return [];

  const normalizedFilter = (sourceFilter || 'all').toLowerCase();
  const filter: StorefrontSearchSource =
    normalizedFilter === 'steam' ||
    normalizedFilter === 'igdb' ||
    normalizedFilter === 'gog' ||
    normalizedFilter === 'epic' ||
    normalizedFilter === 'xbox'
      ? normalizedFilter
      : 'all';

  const releaseYearHint = resolveReleaseYearHint(game?.releaseDate);

  const [candidates, directIgdbCover] = await Promise.all([
    searchStorefrontsFn(effectiveQuery, filter).catch(() => [] as SearchMatchCandidate[]),
    filter === 'all' || filter === 'igdb'
      ? withTimeoutFallback(
          igdbCoverService
            .fetchIgdbCover(effectiveQuery, releaseYearHint, Priority.P0_INTERACTIVE)
            .catch(() => null),
          4000,
          null
        )
      : Promise.resolve(null),
  ]);

  const rawCovers: ScrapedCoverOption[] = [];

  for (const cand of candidates) {
    if (
      (cand.source === 'xbox' || isXboxStoreCandidateId(cand.id, cand.storeUrl)) &&
      cand.capsuleImage
    ) {
      rawCovers.push({
        url: cand.capsuleImage,
        source: 'xbox',
        label: `Xbox Store Cover — ${cand.title}`,
        dimensions: '2:3',
      });
    } else if (cand.source === 'steam' && cand.steamAppId) {
      rawCovers.push(...buildSteamCoverOptions(cand.steamAppId, { labelTitle: cand.title }));
    } else if (
      cand.source === 'gog' &&
      cand.capsuleImage &&
      !isGogCroppedHorizontalCover(cand.capsuleImage, cand.headerImage)
    ) {
      rawCovers.push({
        url: cand.capsuleImage,
        source: 'gog',
        label: `GOG Cover — ${cand.title}`,
        dimensions: 'vertical',
      });
    } else if (cand.source === 'epic' && cand.capsuleImage) {
      rawCovers.push({
        url: cand.capsuleImage,
        source: 'epic',
        label: `Epic Cover — ${cand.title}`,
      });
    } else if (cand.source === 'igdb' && cand.capsuleImage) {
      rawCovers.push({
        url: cand.capsuleImage,
        source: 'igdb',
        label: `IGDB Cover — ${cand.title}`,
        dimensions: 't_cover_big',
      });
    }
  }

  if (directIgdbCover) {
    rawCovers.push({
      url: directIgdbCover,
      source: 'igdb',
      label: `IGDB Cover — ${effectiveQuery.trim()}`,
      dimensions: 't_cover_big',
    });
  }

  if (game?.capsuleImage && filter === 'all') {
    rawCovers.push({
      url: game.capsuleImage,
      source: 'original',
      label: 'Original Library Cover',
    });
  }

  return deduplicateCovers(rawCovers, game?.headerImage);
}

/**
 * Searches across storefronts for structured MetadataSourceOption bundles matching a query and source filter.
 */
export async function buildMetadataSourcesFromSearch(
  query: string,
  sourceFilter: string,
  searchStorefrontsFn: (
    q: string,
    src: StorefrontSearchSource
  ) => Promise<SearchMatchCandidate[]>,
  game?: CanonicalGame | null
): Promise<MetadataSourceOption[]> {
  const effectiveQuery = (query && query.trim()) || game?.title?.trim() || '';
  if (!effectiveQuery) return [];

  const normalizedFilter = (sourceFilter || 'all').toLowerCase();
  const filter: StorefrontSearchSource =
    normalizedFilter === 'steam' ||
    normalizedFilter === 'igdb' ||
    normalizedFilter === 'gog' ||
    normalizedFilter === 'epic' ||
    normalizedFilter === 'xbox'
      ? normalizedFilter
      : 'all';

  const candidates = await searchStorefrontsFn(effectiveQuery, filter).catch(
    () => [] as SearchMatchCandidate[]
  );

  let selectedCandidates: SearchMatchCandidate[] = [];
  if (filter === 'all') {
    const sourcesOrder: Array<'steam' | 'gog' | 'epic' | 'xbox' | 'igdb'> = [
      'steam',
      'gog',
      'epic',
      'xbox',
      'igdb',
    ];
    const pickedKeys = new Set<string>();
    for (const src of sourcesOrder) {
      const topForSrc = candidates.find((c) => {
        const isXbx = c.source === 'xbox' || isXboxStoreCandidateId(c.id, c.storeUrl);
        if (src === 'xbox') return isXbx;
        if (src === 'igdb') return c.source === 'igdb' && !isXbx;
        return c.source === src;
      });
      if (topForSrc) {
        selectedCandidates.push(topForSrc);
        pickedKeys.add(`${topForSrc.source}:${topForSrc.id}`);
      }
    }
    for (const cand of candidates) {
      if (selectedCandidates.length >= 6) break;
      const key = `${cand.source}:${cand.id}`;
      if (!pickedKeys.has(key)) {
        selectedCandidates.push(cand);
        pickedKeys.add(key);
      }
    }
  } else {
    selectedCandidates = candidates.slice(0, 6);
  }

  const builtOptions = await Promise.all(
    selectedCandidates.map(async (cand): Promise<MetadataSourceOption | null> => {
      if (cand.source === 'xbox' || isXboxStoreCandidateId(cand.id, cand.storeUrl)) {
        const xboxRawId = String(cand.id).replace(/^xbox-/i, '').trim();
        const xboxBigId = extractXboxBigId(xboxRawId);
        const storeMeta = await withTimeoutFallback(
          fallbackMetadataProvider
            .fetchXboxProductMetadata({
              xboxProductId: xboxBigId,
              title: cand.title || game?.title,
            })
            .catch(() => null),
          3500,
          null
        );

        const xboxShort = stripHtmlToPlainSynopsis(
          storeMeta?.shortDescription || cand.description
        );
        const firstPara = extractFirstParagraph(
          storeMeta?.detailedDescription || storeMeta?.aboutTheGame
        );
        const descs = deduplicateDescriptions([
          ...(xboxShort ? [{ source: 'Xbox Store Synopsis', text: xboxShort }] : []),
          ...(firstPara && firstPara !== xboxShort
            ? [{ source: 'Xbox Detailed Overview', text: firstPara }]
            : []),
        ]);

        const resolvedTitle = storeMeta?.name || cand.title;
        const rawStoreProdId = extractXboxStoreProductId(storeMeta);
        const resolvedProdId = xboxBigId || rawStoreProdId || xboxRawId;
        return {
          id: `xbox-${resolvedProdId}`,
          source: 'xbox',
          sourceLabel: `Xbox / Microsoft Store — ${resolvedTitle}`,
          matchedId: resolvedProdId,
          storeUrl:
            cand.storeUrl ||
            buildCandidateStoreUrl({
              source: 'xbox',
              title: resolvedTitle,
              xboxProductId: xboxBigId || rawStoreProdId,
            }),
          title: resolvedTitle,
          shortDescription: xboxShort || descs[0]?.text,
          detailedDescription:
            storeMeta?.detailedDescription || storeMeta?.aboutTheGame || xboxShort,
          availableDescriptions: descs,
          releaseDate:
            sanitizeStoreReleaseDate(storeMeta?.releaseDate) ||
            (cand.year
              ? sanitizeStoreReleaseDate(`${cand.year}-01-01`)?.slice(0, 4)
              : undefined),
          developers: storeMeta?.developers,
          publishers: storeMeta?.publishers,
          genres: storeMeta?.genres,
          tags: storeMeta?.tags,
          headerImage: storeMeta?.headerImage || cand.headerImage,
          capsuleImage: storeMeta?.capsuleImage || cand.capsuleImage,
        };
      }

      if (cand.source === 'steam') {
        const appId =
          cand.steamAppId ||
          (typeof cand.id === 'number'
            ? cand.id
            : parseInt(String(cand.id).replace(/^steam-/, ''), 10));
        if (!appId || isNaN(appId)) return null;

        requestScheduler.promoteToInteractive(`steam:${appId}`);
        const meta = await withTimeoutFallback(
          steamApi.fetchGameMetadata(appId, Priority.P0_INTERACTIVE).catch(() => null),
          3500,
          null
        );

        const firstPara = extractFirstParagraph(
          meta?.detailedDescription || meta?.aboutTheGame
        );
        const descs = deduplicateDescriptions([
          ...(meta?.shortDescription
            ? [{ source: 'Steam Store Synopsis', text: meta.shortDescription }]
            : []),
          ...(firstPara && firstPara !== meta?.shortDescription
            ? [{ source: 'Steam Detailed Overview', text: firstPara }]
            : []),
        ]);

        const resolvedName = meta?.name || cand.title;
        return {
          id: `steam-${appId}`,
          source: 'steam',
          sourceLabel: `Steam Store Metadata — ${resolvedName}`,
          matchedId: appId,
          steamAppId: appId,
          storeUrl:
            cand.storeUrl ||
            buildCandidateStoreUrl({
              source: 'steam',
              title: resolvedName,
              steamAppId: appId,
            }),
          title: resolvedName,
          shortDescription:
            stripHtmlToPlainSynopsis(
              meta?.shortDescription || descs[0]?.text || cand.description
            ) || undefined,
          detailedDescription:
            meta?.detailedDescription ||
            meta?.aboutTheGame ||
            meta?.shortDescription ||
            cand.description,
          availableDescriptions: descs,
          releaseDate: meta?.releaseDate || (cand.year ? String(cand.year) : undefined),
          developers: meta?.developers,
          publishers: meta?.publishers,
          genres: meta?.genres,
          tags: meta?.tags,
          headerImage: meta?.headerImage || cand.headerImage || getSteamHeaderUrl(appId),
          capsuleImage: cand.capsuleImage || resolveSteamCandidateCapsuleUrl(appId),
        };
      }

      if (cand.source === 'gog') {
        const gogId = String(cand.gogId || cand.id).replace(/^gog-/, '');
        const cached = hasGogCacheEntries() ? gogCacheMap[gogId] : undefined;
        let storeMeta = null;
        if (!cached?.shortDescription) {
          storeMeta = await withTimeoutFallback(
            fallbackMetadataProvider
              .fetchGogProductMetadata(gogId, cand.title || game?.title)
              .catch(() => null),
            3500,
            null
          );
        }

        const gogLead = stripHtmlToPlainSynopsis(
          storeMeta?.shortDescription || cached?.shortDescription || cand.description
        );
        const firstPara = extractFirstParagraph(
          storeMeta?.detailedDescription || cached?.aboutTheGame
        );
        const descs = deduplicateDescriptions([
          ...(gogLead ? [{ source: 'GOG Store Synopsis', text: gogLead }] : []),
          ...(firstPara && firstPara !== gogLead
            ? [{ source: 'GOG Detailed Overview', text: firstPara }]
            : []),
        ]);

        const resolvedGogTitle = cand.title || cached?.title || '';
        return {
          id: `gog-${gogId}`,
          source: 'gog',
          sourceLabel: `GOG.com Metadata — ${cand.title}`,
          matchedId: gogId,
          gogId,
          storeUrl:
            cand.storeUrl ||
            buildCandidateStoreUrl({
              source: 'gog',
              title: resolvedGogTitle,
              gogId,
            }),
          title: resolvedGogTitle,
          shortDescription: gogLead || descs[0]?.text,
          detailedDescription:
            storeMeta?.detailedDescription || cached?.aboutTheGame || gogLead,
          availableDescriptions: descs,
          releaseDate:
            storeMeta?.releaseDate ||
            cached?.releaseDate ||
            (cand.year ? String(cand.year) : undefined),
          developers: storeMeta?.developers || cached?.developers,
          publishers: storeMeta?.publishers || cached?.publishers,
          genres: storeMeta?.genres || cached?.genres,
          tags: storeMeta?.tags || cached?.tags,
          headerImage:
            storeMeta?.headerImage || cached?.coverHorizontal || cand.headerImage,
          capsuleImage:
            storeMeta?.capsuleImage || cached?.coverVertical || cand.capsuleImage,
        };
      }

      if (cand.source === 'epic') {
        const epicId = String(cand.id).replace(/^epic-/, '');
        const cleanSlug = cand.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        const storeMeta = await withTimeoutFallback(
          fallbackMetadataProvider.fetchEpicProductMetadata(cleanSlug).catch(() => null),
          3000,
          null
        );

        const epicShort = stripHtmlToPlainSynopsis(
          storeMeta?.shortDescription || cand.description
        );
        const firstPara = extractFirstParagraph(
          storeMeta?.detailedDescription || storeMeta?.aboutTheGame
        );
        const descs = deduplicateDescriptions([
          ...(epicShort ? [{ source: 'Epic Store Synopsis', text: epicShort }] : []),
          ...(firstPara && firstPara !== epicShort
            ? [{ source: 'Epic Detailed Overview', text: firstPara }]
            : []),
        ]);

        return {
          id: String(cand.id).startsWith('epic-') ? String(cand.id) : `epic-${cand.id}`,
          source: 'epic',
          sourceLabel: `Epic Games Store — ${cand.title}`,
          matchedId: epicId,
          epicSlug: cleanSlug || String(epicId),
          storeUrl:
            cand.storeUrl ||
            buildCandidateStoreUrl({
              source: 'epic',
              title: cand.title,
              epicSlug: cleanSlug || String(epicId),
            }),
          title: cand.title,
          shortDescription: epicShort || descs[0]?.text,
          detailedDescription: storeMeta?.detailedDescription || epicShort,
          availableDescriptions: descs,
          releaseDate:
            sanitizeStoreReleaseDate(storeMeta?.releaseDate) ||
            (cand.year
              ? sanitizeStoreReleaseDate(`${cand.year}-01-01`)?.slice(0, 4)
              : undefined),
          developers: storeMeta?.developers,
          publishers: storeMeta?.publishers,
          genres: storeMeta?.genres,
          tags: storeMeta?.tags,
          headerImage: storeMeta?.headerImage || cand.headerImage,
          capsuleImage: storeMeta?.capsuleImage || cand.capsuleImage,
        };
      }

      // IGDB candidate
      const cleanCandDesc = stripHtmlToPlainSynopsis(cand.description);
      return {
        id: String(cand.id),
        source: 'igdb',
        sourceLabel: `IGDB Metadata — ${cand.title}`,
        matchedId: cand.igdbId || cand.id,
        igdbId: cand.igdbId || cand.id,
        storeUrl:
          cand.storeUrl ||
          buildCandidateStoreUrl({
            source: 'igdb',
            title: cand.title,
            igdbId: cand.igdbId || cand.id,
          }),
        title: cand.title,
        shortDescription: cleanCandDesc || undefined,
        detailedDescription: cand.description,
        availableDescriptions: cleanCandDesc
          ? [{ source: 'IGDB Overview', text: cleanCandDesc }]
          : [],
        releaseDate: cand.year ? String(cand.year) : undefined,
        capsuleImage: cand.capsuleImage,
        headerImage: cand.headerImage || cand.capsuleImage,
      };
    })
  );

  const results: MetadataSourceOption[] = [];
  const seenIds = new Set<string>();
  for (const opt of builtOptions) {
    if (!opt || seenIds.has(opt.id)) continue;
    seenIds.add(opt.id);
    results.push(opt);
  }

  if (filter === 'all') {
    const origOption = buildOriginalMetadataOption(game);
    if (origOption && !seenIds.has(origOption.id)) {
      results.push(origOption);
    }
  }

  return results;
}
