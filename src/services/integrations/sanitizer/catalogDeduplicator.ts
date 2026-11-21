import { CanonicalGame, NativeOsPlatform } from '../../../contracts/game';
import type { UserGameOverride, UserGameOverridesMap } from '../../../contracts/override';
import { getAlphabeticalTitleSortKey } from '../../common/titleSortUtils';
import { igdbCoverService, isUnsuitableHeaderUrl } from '../../igdb/igdbCoverService';
import {
  pickBestEnrichedMetadata,
  pickPreferredDetailedDescription,
  pickPreferredReleaseDate,
} from '../../storage/librarySync';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from '../../storage/metadataReconciliation';
import steamEnrichedCache from '../../storage/steamEnrichedCache.json';
import {
  applyUserOverrideToGame,
  getUserOverrideForGame,
  isUserOverrideCompatibleWithGame,
} from '../../storage/userOverrideStorage';
import {
  mergePlatformEntries,
  selfHealCatalogEntryHandoffsAndOs,
  type SteamEnrichedCacheItem,
} from './handoffAndAntiCheat';
import {
  hasSameStorefrontConflict,
  isPlaceholderDesc,
  normalizeCanonicalTitle,
  sanitizeShortDescriptionText,
} from './nonGameAndDescriptionFilter';

function mergeWorksOnFlags(
  primary?: CanonicalGame['worksOn'],
  secondary?: CanonicalGame['worksOn']
): CanonicalGame['worksOn'] {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const win = Boolean(primary.windows || primary.Windows || secondary.windows || secondary.Windows);
  const mac = Boolean(primary.mac || primary.Mac || secondary.mac || secondary.Mac);
  const linux = Boolean(primary.linux || primary.Linux || secondary.linux || secondary.Linux);
  return { windows: win, mac, linux };
}

function mergePlatformsOsFlags(
  primary?: CanonicalGame['platforms_os'],
  secondary?: CanonicalGame['platforms_os']
): CanonicalGame['platforms_os'] {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    windows: Boolean(primary.windows || secondary.windows),
    mac: Boolean(primary.mac || secondary.mac),
    linux: Boolean(primary.linux || secondary.linux),
  };
}

function mergeNativePlatforms(
  primary?: NativeOsPlatform[],
  secondary?: NativeOsPlatform[]
): NativeOsPlatform[] | undefined {
  if (!Array.isArray(primary) || primary.length === 0) return secondary;
  if (!Array.isArray(secondary) || secondary.length === 0) return primary;
  const combined = Array.from(new Set<NativeOsPlatform>([...primary, ...secondary]));
  return combined.length === primary.length ? primary : combined;
}

export function mergeDuplicateCatalogEntries(params: {
  existing: CanonicalGame;
  incoming: CanonicalGame;
  hasUserOverrides: boolean;
  userOverrides: UserGameOverridesMap;
  incomingOverride?: UserGameOverride;
  explicitValidSteamAppIds?: Set<number>;
}): CanonicalGame {
  const {
    existing,
    incoming,
    hasUserOverrides,
    userOverrides,
    incomingOverride,
    explicitValidSteamAppIds,
  } = params;

  const existingIsParenClassic = /\s*\((?:original|classic)\)$/i.test(existing.title);
  const incomingIsParenClassic = /\s*\((?:original|classic)\)$/i.test(incoming.title);
  const existingIsStandaloneXboxWithoutSteam =
    !existing.steamAppId &&
    existing.platforms.length > 0 &&
    existing.platforms.every((p) => p.platformId === 'xbox');
  const incomingHasCanonicalSteam =
    Boolean(incoming.steamAppId) &&
    incoming.platforms.some((p) => p.platformId === 'steam') &&
    !incomingIsParenClassic;
  const preferIncomingEdition =
    (existingIsParenClassic && !incomingIsParenClassic) ||
    (existingIsStandaloneXboxWithoutSteam && incomingHasCanonicalSteam);
  const primary = preferIncomingEdition ? incoming : existing;
  const secondary = preferIncomingEdition ? existing : incoming;

  let mergedPlatforms: CanonicalGame['platforms'] = mergePlatformEntries(primary, secondary);

  if (
    mergedPlatforms.some((p) => p.platformId === 'steam') &&
    mergedPlatforms.some((p) => p.platformId !== 'steam')
  ) {
    const steamP = mergedPlatforms.find((p) => p.platformId === 'steam');
    const resolvedAppId =
      Number(steamP?.platformGameId) || primary.steamAppId || secondary.steamAppId || 0;
    const hasNonSteamPathOnSteam = Boolean(
      steamP?.installPath &&
        /[/\\](?:epic|gog|legendary|heroic|xboxgames|windowsapps)[/\\]/i.test(steamP.installPath)
    );
    const isPhantomSteam =
      hasNonSteamPathOnSteam ||
      (explicitValidSteamAppIds !== undefined &&
        !explicitValidSteamAppIds.has(resolvedAppId) &&
        !/steamapps/i.test(steamP?.installPath || ''));
    if (isPhantomSteam) {
      const nonSteamPlatforms = mergedPlatforms.filter((p) => p.platformId !== 'steam');
      // Only fold local session playtime back when the stripped Steam entry pointed to a
      // misattributed non-Steam install path (e.g. Epic/GOG dir). Never add arbitrary unowned
      // Steam playtime onto GOG/Epic platforms!
      if (hasNonSteamPathOnSteam && nonSteamPlatforms.length > 0 && (steamP?.playtimeMinutes || 0) > 0) {
        nonSteamPlatforms[0] = {
          ...nonSteamPlatforms[0],
          playtimeMinutes:
            (nonSteamPlatforms[0].playtimeMinutes || 0) + (steamP?.playtimeMinutes || 0),
          lastPlayed: nonSteamPlatforms[0].lastPlayed || steamP?.lastPlayed,
        };
      }
      mergedPlatforms = nonSteamPlatforms;
    }
  }

  const primaryOv = hasUserOverrides
    ? getUserOverrideForGame(primary, userOverrides)
    : undefined;
  const secondaryOv = hasUserOverrides
    ? getUserOverrideForGame(secondary, userOverrides)
    : undefined;
  const pinnedOvCover = primaryOv?.capsuleImage?.trim() || secondaryOv?.capsuleImage?.trim();
  const pinnedOvHeader = primaryOv?.headerImage?.trim() || secondaryOv?.headerImage?.trim();
  const mergedGogPlat = mergedPlatforms.find((p) => p.platformId === 'gog');
  const mergedSteamAppId = primary.steamAppId || secondary.steamAppId;
  const mergeArtCtx: ArtworkRecoveryContext = {
    gameId: primary.id || secondary.id,
    title: primary.title,
    steamAppId: mergedSteamAppId,
    gogId: mergedGogPlat?.platformGameId,
    userOverrideCapsule: pinnedOvCover,
    userOverrideHeader: pinnedOvHeader,
  };
  const mergedHeader =
    reconcileHeaderImage(primary.headerImage, secondary.headerImage, mergeArtCtx) ||
    primary.headerImage ||
    secondary.headerImage;
  const mergedCapsule = reconcileCapsuleImage(primary.capsuleImage, secondary.capsuleImage, {
    ...mergeArtCtx,
    headerUrl: mergedHeader,
  });

  const primaryHasReviews = Boolean(
    primary.reviewSummary &&
      (primary.reviewSummary.totalReviews > 0 || primary.reviewSummary.positivePercent > 0)
  );
  const secondaryHasReviews = Boolean(
    secondary.reviewSummary &&
      (secondary.reviewSummary.totalReviews > 0 || secondary.reviewSummary.positivePercent > 0)
  );
  const mergedReviewSummary = primaryHasReviews
    ? primary.reviewSummary
    : secondaryHasReviews
    ? secondary.reviewSummary
    : primary.reviewSummary || secondary.reviewSummary;
  const sameNonSteamPolarity =
    Boolean(primary.isExplicitNonSteam) === Boolean(secondary.isExplicitNonSteam);
  const mergedReviewScoreOverride =
    primary.reviewScoreOverride !== undefined
      ? primary.reviewScoreOverride
      : sameNonSteamPolarity && (!secondaryOv || isUserOverrideCompatibleWithGame(secondaryOv, primary))
      ? secondary.reviewScoreOverride
      : undefined;
  const mergedWorksOn = mergeWorksOnFlags(primary.worksOn, secondary.worksOn);
  const mergedPlatformsOs = mergePlatformsOsFlags(primary.platforms_os, secondary.platforms_os);
  const mergedNativePlatforms = mergeNativePlatforms(
    primary.nativePlatforms,
    secondary.nativePlatforms
  );

  let mergedGame: CanonicalGame = {
    ...primary,
    steamAppId: mergedSteamAppId,
    id: primary.steamAppId
      ? `steam-${primary.steamAppId}`
      : secondary.steamAppId
      ? `steam-${secondary.steamAppId}`
      : primary.id,
    platforms: mergedPlatforms,
    headerImage: mergedHeader,
    capsuleImage: mergedCapsule,
    iconUrl:
      secondary.iconUrl && isUnsuitableHeaderUrl(primary.iconUrl)
        ? secondary.iconUrl
        : primary.iconUrl || secondary.iconUrl || secondary.capsuleImage,
    shortDescription: !isPlaceholderDesc(primary.shortDescription, primary.title)
      ? sanitizeShortDescriptionText(primary.shortDescription)
      : !isPlaceholderDesc(secondary.shortDescription, secondary.title)
      ? sanitizeShortDescriptionText(secondary.shortDescription)
      : '',
    detailedDescription: pickPreferredDetailedDescription(
      primary.detailedDescription,
      secondary.detailedDescription
    ),
    developers:
      primary.developers && primary.developers.length > 0
        ? primary.developers
        : secondary.developers,
    publishers:
      primary.publishers && primary.publishers.length > 0
        ? primary.publishers
        : secondary.publishers,
    genres: primary.genres && primary.genres.length > 0 ? primary.genres : secondary.genres,
    tags: primary.tags && primary.tags.length > 0 ? primary.tags : secondary.tags,
    reviewSummary: mergedReviewSummary,
    ...(mergedReviewScoreOverride !== undefined
      ? { reviewScoreOverride: mergedReviewScoreOverride }
      : {}),
    ...(mergedWorksOn !== undefined ? { worksOn: mergedWorksOn } : {}),
    ...(mergedPlatformsOs !== undefined ? { platforms_os: mergedPlatformsOs } : {}),
    ...(mergedNativePlatforms !== undefined ? { nativePlatforms: mergedNativePlatforms } : {}),
    releaseDate:
      pickPreferredReleaseDate(primary.releaseDate, secondary.releaseDate) ||
      primary.releaseDate ||
      secondary.releaseDate,
    isVerifiedEntitlement: primary.isVerifiedEntitlement || secondary.isVerifiedEntitlement,
    matchConfidence: primary.matchConfidence ?? secondary.matchConfidence,
    needsMatchReview: primary.needsMatchReview ?? secondary.needsMatchReview,
    ...(primary.requiresKernelAntiCheat || secondary.requiresKernelAntiCheat
      ? {
          requiresKernelAntiCheat:
            primary.requiresKernelAntiCheat || secondary.requiresKernelAntiCheat,
        }
      : {}),
    ...(primary.kernelAntiCheatName || secondary.kernelAntiCheatName
      ? {
          kernelAntiCheatName: primary.kernelAntiCheatName || secondary.kernelAntiCheatName,
        }
      : {}),
    ...(primary.antiCheatName || secondary.antiCheatName
      ? {
          antiCheatName: primary.antiCheatName || secondary.antiCheatName,
        }
      : {}),
    enrichedMetadata: pickBestEnrichedMetadata(
      primary.enrichedMetadata,
      secondary.enrichedMetadata
    ),
  };

  if (hasUserOverrides) {
    const existingOv = getUserOverrideForGame(existing, userOverrides);
    const effectiveOv =
      (incomingOverride && isUserOverrideCompatibleWithGame(incomingOverride, mergedGame)
        ? incomingOverride
        : undefined) ||
      (existingOv && isUserOverrideCompatibleWithGame(existingOv, mergedGame)
        ? existingOv
        : undefined) ||
      getUserOverrideForGame(mergedGame, userOverrides);
    if (effectiveOv) {
      mergedGame = applyUserOverrideToGame(mergedGame, effectiveOv);
    }
  }

  return selfHealCatalogEntryHandoffsAndOs(mergedGame);
}

export function disambiguateSameStorefrontCollision(params: {
  cleaned: CanonicalGame[];
  candidateIndex: number;
  incomingGame: CanonicalGame;
  hasUserOverrides: boolean;
  userOverrides: UserGameOverridesMap;
  titleToIndex: Map<string, number>;
  steamIdToIndex: Map<number, number>;
  idToIndex: Map<string, number>;
}): { game: CanonicalGame; normTitle: string } {
  const {
    cleaned,
    candidateIndex,
    hasUserOverrides,
    userOverrides,
    titleToIndex,
    steamIdToIndex,
    idToIndex,
  } = params;
  let game = params.incomingGame;
  let normTitle = normalizeCanonicalTitle(game.title);

  const existing = cleaned[candidateIndex];
  const prevExistingId = existing.id;
  const existingOv = hasUserOverrides
    ? getUserOverrideForGame(existing, userOverrides)
    : undefined;
  const gameOv = hasUserOverrides ? getUserOverrideForGame(game, userOverrides) : undefined;

  // A. Self-Heal Stale Overwritten Remastered/Enhanced Titles on Same-Storefront Pairs
  if (
    normalizeCanonicalTitle(existing.title) === normalizeCanonicalTitle(game.title) &&
    /\b(remastered|remaster|enhanced)\b/i.test(existing.title)
  ) {
    let baseTarget: CanonicalGame | null = null;
    if (existingOv && !gameOv) {
      baseTarget = !game.platforms.some((p) => p.platformId === 'steam') ? game : null;
    } else if (gameOv && !existingOv) {
      baseTarget = !existing.platforms.some((p) => p.platformId === 'steam') ? existing : null;
    } else if (!existingOv && !gameOv) {
      if (existing.platforms.length < game.platforms.length) {
        baseTarget = existing;
      } else if (game.platforms.length < existing.platforms.length) {
        baseTarget = game;
      } else if (
        !existing.platforms.some((p) => p.platformId === 'steam') &&
        game.platforms.some((p) => p.platformId === 'steam')
      ) {
        baseTarget = existing;
      } else if (
        !game.platforms.some((p) => p.platformId === 'steam') &&
        existing.platforms.some((p) => p.platformId === 'steam')
      ) {
        baseTarget = game;
      } else {
        baseTarget = existing;
      }
    }

    if (baseTarget) {
      const isExistingTarget = baseTarget === existing;
      const clonedTarget: CanonicalGame = { ...baseTarget };
      const restoredTitle = clonedTarget.title
        .replace(/\s*[-–—:]?\s*\b(remastered|remaster|enhanced(?:\s+edition)?)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const collidingAppId = clonedTarget.steamAppId;
      clonedTarget.title = restoredTitle;
      clonedTarget.sortTitle = getAlphabeticalTitleSortKey(restoredTitle, true);
      clonedTarget.steamAppId = undefined;
      clonedTarget.enrichedMetadata = undefined;
      const primaryPlat = clonedTarget.platforms?.[0];
      if (primaryPlat?.platformId && primaryPlat?.platformGameId) {
        clonedTarget.id = `${primaryPlat.platformId}-${primaryPlat.platformGameId}`;
      }
      if (collidingAppId) {
        const appIdToken = `/steam/apps/${collidingAppId}/`;
        if (clonedTarget.headerImage?.includes(appIdToken)) clonedTarget.headerImage = '';
        if (clonedTarget.capsuleImage?.includes(appIdToken)) clonedTarget.capsuleImage = '';
        if (clonedTarget.iconUrl?.includes(appIdToken)) clonedTarget.iconUrl = undefined;
        const igdbRestored = igdbCoverService.getIgdbCoverInstant(
          restoredTitle,
          undefined,
          clonedTarget.id
        );
        if (igdbRestored) {
          clonedTarget.capsuleImage = igdbRestored;
          clonedTarget.iconUrl = clonedTarget.iconUrl || igdbRestored;
        }
      }
      if (isExistingTarget) {
        cleaned[candidateIndex] = clonedTarget;
        titleToIndex.set(normalizeCanonicalTitle(clonedTarget.title), candidateIndex);
        if (collidingAppId && steamIdToIndex.get(collidingAppId) === candidateIndex) {
          steamIdToIndex.delete(collidingAppId);
        }
        if (prevExistingId && idToIndex.get(prevExistingId) === candidateIndex) {
          idToIndex.delete(prevExistingId);
        }
        if (clonedTarget.id) {
          idToIndex.set(clonedTarget.id, candidateIndex);
        }
      } else {
        game = clonedTarget;
        normTitle = normalizeCanonicalTitle(game.title);
      }
    }
  }

  // B. Disambiguate Shared steamAppId / id Between Same-Storefront Editions
  const curExisting = cleaned[candidateIndex];
  if (
    (curExisting.steamAppId && game.steamAppId && curExisting.steamAppId === game.steamAppId) ||
    curExisting.id === game.id
  ) {
    const sharedAppId = curExisting.steamAppId || game.steamAppId;
    const existingHasSteam = curExisting.platforms.some((p) => p.platformId === 'steam');
    const gameHasSteam = game.platforms.some((p) => p.platformId === 'steam');
    const existingHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(curExisting.title);
    const gameHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(game.title);

    if (existingOv && gameOv) {
      if (curExisting.id === game.id) {
        const targetIsExisting = !existingHasSteam && gameHasSteam;
        const idDisambigTarget = targetIsExisting ? curExisting : game;
        const plat = idDisambigTarget.platforms?.[0];
        if (plat?.platformId && plat?.platformGameId) {
          const oldId = idDisambigTarget.id;
          const nextId = `${plat.platformId}-${plat.platformGameId}`;
          if (targetIsExisting) {
            cleaned[candidateIndex] = { ...curExisting, id: nextId };
            if (oldId && idToIndex.get(oldId) === candidateIndex) {
              idToIndex.delete(oldId);
            }
            idToIndex.set(nextId, candidateIndex);
          } else {
            game = { ...game, id: nextId };
          }
        }
      }
    } else {
      let targetIsExisting = false;
      if (existingOv && !gameOv) {
        targetIsExisting = false;
      } else if (gameOv && !existingOv) {
        targetIsExisting = true;
      } else if (existingHasSteam !== gameHasSteam) {
        targetIsExisting = !existingHasSteam;
      } else if (existingHasEdition !== gameHasEdition) {
        const steamCachedName =
          sharedAppId && Object.keys(steamEnrichedCache).length > 0
            ? (steamEnrichedCache as Record<string, SteamEnrichedCacheItem>)[String(sharedAppId)]
                ?.name || ''
            : '';
        const steamCacheHasEdition = steamCachedName
          ? /\b(remastered|remaster|remake|enhanced)\b/i.test(steamCachedName)
          : true;
        targetIsExisting = steamCacheHasEdition ? !existingHasEdition : existingHasEdition;
      }

      const targetToDemote = targetIsExisting ? curExisting : game;
      const plat = targetToDemote.platforms?.[0];
      if (plat?.platformId && plat?.platformGameId) {
        const oldId = targetToDemote.id;
        const nextId = `${plat.platformId}-${plat.platformGameId}`;
        if (targetIsExisting) {
          cleaned[candidateIndex] = {
            ...curExisting,
            id: nextId,
            steamAppId: undefined,
          };
          if (sharedAppId && steamIdToIndex.get(sharedAppId) === candidateIndex) {
            steamIdToIndex.delete(sharedAppId);
          }
          if (oldId && idToIndex.get(oldId) === candidateIndex) {
            idToIndex.delete(oldId);
          }
          idToIndex.set(nextId, candidateIndex);
        } else {
          game = {
            ...game,
            id: nextId,
            steamAppId: undefined,
          };
        }
      }
    }
  }

  return { game, normTitle };
}

export function enforceUniqueIdsAndSteamAppIds(
  finalCatalog: CanonicalGame[],
  hasUserOverrides: boolean,
  userOverrides: UserGameOverridesMap
): void {
  const seenIds = new Set<string>();
  const seenSteamAppIds = new Map<number, number>();
  for (let idx = 0; idx < finalCatalog.length; idx++) {
    let g = finalCatalog[idx];
    if (g.steamAppId) {
      const prevIdx = seenSteamAppIds.get(g.steamAppId);
      const prevWithAppId = prevIdx !== undefined ? finalCatalog[prevIdx] : undefined;
      if (prevWithAppId && prevIdx !== undefined && hasSameStorefrontConflict(prevWithAppId, g)) {
        const prevOv = hasUserOverrides
          ? getUserOverrideForGame(prevWithAppId, userOverrides)
          : undefined;
        const currOv = hasUserOverrides ? getUserOverrideForGame(g, userOverrides) : undefined;

        if (!(prevOv && currOv)) {
          const prevHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(
            prevWithAppId.title
          );
          const currHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(g.title);
          const demotePrev =
            currOv && !prevOv
              ? true
              : prevOv && !currOv
              ? false
              : !prevWithAppId.platforms.some((p) => p.platformId === 'steam') &&
                prevWithAppId.platforms.length <= g.platforms.length &&
                !prevHasEdition &&
                currHasEdition;
          const targetToDemote = demotePrev ? prevWithAppId : g;
          const plat = targetToDemote.platforms?.[0];
          if (plat?.platformId && plat?.platformGameId) {
            const nextId = `${plat.platformId}-${plat.platformGameId}`;
            if (demotePrev) {
              seenIds.delete(prevWithAppId.id);
              finalCatalog[prevIdx] = {
                ...prevWithAppId,
                id: nextId,
                steamAppId: undefined,
              };
              seenIds.add(nextId);
              seenSteamAppIds.set(g.steamAppId, idx);
            } else {
              g = {
                ...g,
                id: nextId,
                steamAppId: undefined,
              };
              finalCatalog[idx] = g;
            }
          }
        }
      } else {
        seenSteamAppIds.set(g.steamAppId, idx);
      }
    }
    if (seenIds.has(g.id)) {
      const primaryPlat = g.platforms?.[0];
      const fallbackId =
        primaryPlat?.platformId && primaryPlat?.platformGameId
          ? `${primaryPlat.platformId}-${primaryPlat.platformGameId}`
          : `${g.id}-${idx}`;
      const nextId = !seenIds.has(fallbackId) ? fallbackId : `${fallbackId}-${idx}`;
      g = { ...g, id: nextId };
      finalCatalog[idx] = g;
    }
    seenIds.add(g.id);
  }
}
