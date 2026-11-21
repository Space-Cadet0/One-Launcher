import { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import {
  isMicrosoftStoreCdnUrl,
  sanitizeStoreReleaseDate,
  stripStorefrontPlatformDisambiguators,
} from '../common/titleUtils';
import {
  getAlphabeticalTitleSortKey,
  LIBRARY_TITLE_COLLATOR,
} from '../common/titleSortUtils';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from '../storage/metadataReconciliation';
import { KNOWN_EPIC_APP_NAMES } from './epicCodenames';
import { GOG_USER_LIBRARY } from '../storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
  isUnsuitableHeaderUrl,
} from '../igdb/igdbCoverService';
import { steamMatcher } from '../steam/steamMatcher';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import {
  GOG_SPECIAL_DESCRIPTIONS,
  extractFirstParagraph,
  cleanGogDescriptionHtml,
  stripHtmlToPlainSynopsis,
} from '../steam/fallbackMetadataProvider';
import {
  filterEnglishMovies,
  isNonEnglishRegionalMovieName,
  steamApi,
} from '../steam/steamApi';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
  doesReviewScoreOverrideMatch,
  findIncompatibleCollidingOverrideForGame,
  loadHiddenStorefrontEntries,
  isStorefrontEntryHidden,
  isNonGameStorefrontEntryRestored,
} from '../storage/userOverrideStorage';
import {
  STOREFRONT_BONUS_SUFFIX_REGEX,
  UNOWNED_STEAM_PROMO_APP_IDS,
  getNonGameSuppressionReason,
  hasSameStorefrontConflict,
  hasSplitOverrideConflict,
  isEpicNonGameEntry,
  isMockOrUnownedIdentifier,
  isNonGameCatalogEntry,
  isPlaceholderDesc,
  isUnmappedEpicInternalCodename,
  loadVerifiedEntitlementsFromStorage,
  normalizeCanonicalTitle,
  sanitizeShortDescriptionText,
} from './sanitizer/nonGameAndDescriptionFilter';
import {
  clearUserHiddenSuppressedEntriesInMemory,
  persistSuppressedEntriesToStorage,
  pruneActiveGamesFromSuppressedEntries,
  recordSuppressedCatalogEntryInMemory,
  syncSuppressedEntriesWithStorage,
} from './sanitizer/suppressedEntriesStore';
import {
  sanitizePlatformOwnershipOsFlags,
  selfHealCatalogEntryHandoffsAndOs,
  type GogEnrichedCacheItem,
} from './sanitizer/handoffAndAntiCheat';
import {
  disambiguateSameStorefrontCollision,
  enforceUniqueIdsAndSteamAppIds,
  mergeDuplicateCatalogEntries,
} from './sanitizer/catalogDeduplicator';

export {
  STORAGE_KEY_SUPPRESSED_ENTRIES,
  type SuppressedCatalogEntry,
  buildMinimalSuppressedGameStub,
  ensureSuppressedEntryRawGame,
  clearSuppressedCatalogEntries,
  getSuppressedCatalogEntries,
  type RegisterSuppressedOptions,
  registerSuppressedCatalogEntries,
  reconcileStorefrontSuppressedEntries,
} from './sanitizer/suppressedEntriesStore';

export {
  isHexOrGuidString,
  sanitizeShortDescriptionText,
  isPlaceholderDesc,
  NON_GAME_CATALOG_TITLE_REGEX,
  STANDALONE_STOREFRONT_LAUNCHER_CLIENT_REGEX,
  isNonGameCatalogEntry,
  getNonGameSuppressionReason,
  isUnmappedEpicInternalCodename,
  isEpicNonGameEntry,
  normalizeCanonicalTitle,
  hasSameStorefrontConflict,
  hasSplitOverrideConflict,
  UNOWNED_STEAM_PROMO_APP_IDS,
  isMockOrUnownedIdentifier,
} from './sanitizer/nonGameAndDescriptionFilter';

export {
  type NormalizedChainedHandoffId,
  EA_DRM_BACKGROUND_REQUIRED_RE,
  KERNEL_ANTICHEAT_DRM_RE,
  normalizeChainedHandoffId,
  mapChainedHandoffIdToExternalLauncher,
  type StructuralKernelAntiCheatCategory,
  resolveCanonicalKernelAntiCheatDisplayName,
  isRing0HardBlockKernelAntiCheat,
  isBattlEyeKernelAntiCheat,
  detectStructuralKernelAntiCheatFromNotices,
  detectKernelAntiCheatFromNotice,
  sanitizePlatformOwnershipOsFlags,
  mergePlatformEntry,
  mergePlatformEntries,
  selfHealCatalogEntryHandoffsAndOs,
} from './sanitizer/handoffAndAntiCheat';

export interface CatalogGamePatch {
  targetId?: string;
  title?: string;
  sortTitle?: string;
  steamAppId?: number | null;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
  preserveExistingIcon?: boolean;
  shortDescription?: string;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  platformFilters?: {
    excludePlatformId?: string;
    setPlatformGameId?: { platformId: string; gameId: string };
  };
}

/**
 * Curated declarative game overrides and asset patches (empty by default for universal dynamic resolution).
 */
export const KNOWN_GAME_PATCHES: Record<string, CatalogGamePatch> = {};

export function applyCatalogPatch(game: CanonicalGame, patch: CatalogGamePatch): CanonicalGame {
  const updated: CanonicalGame = { ...game };

  if (patch.targetId) updated.id = patch.targetId;
  if (patch.title) updated.title = patch.title;
  if (patch.sortTitle) updated.sortTitle = patch.sortTitle;

  if (patch.steamAppId === null) {
    updated.steamAppId = undefined;
  } else if (patch.steamAppId !== undefined) {
    updated.steamAppId = patch.steamAppId;
  }

  if (patch.headerImage) updated.headerImage = patch.headerImage;
  if (patch.capsuleImage) updated.capsuleImage = patch.capsuleImage;

  if (patch.iconUrl) {
    updated.iconUrl =
      patch.preserveExistingIcon && updated.iconUrl ? updated.iconUrl : patch.iconUrl;
  }

  if (patch.shortDescription) {
    if (!updated.shortDescription || isPlaceholderDesc(updated.shortDescription, updated.title)) {
      updated.shortDescription = patch.shortDescription;
    }
  }

  if (patch.releaseDate) updated.releaseDate = patch.releaseDate;
  if (patch.developers) updated.developers = patch.developers;
  if (patch.publishers) updated.publishers = patch.publishers;
  if (patch.genres) updated.genres = patch.genres;
  if (patch.tags) updated.tags = patch.tags;

  if (patch.platformFilters) {
    if (patch.platformFilters.excludePlatformId) {
      updated.platforms = updated.platforms.filter(
        (p) => p.platformId !== patch.platformFilters!.excludePlatformId
      );
    }
    if (patch.platformFilters.setPlatformGameId) {
      const { platformId, gameId } = patch.platformFilters.setPlatformGameId;
      updated.platforms = updated.platforms.map((p) =>
        p.platformId === platformId ? { ...p, platformGameId: gameId } : p
      );
    }
  }

  return updated;
}

export function findGamePatch(
  game: CanonicalGame,
  lowerTitle?: string,
  normTitle?: string
): CatalogGamePatch | undefined {
  const currentTitleLower = lowerTitle ?? (game.title || '').toLowerCase().trim();
  const currentNorm = normTitle ?? normalizeCanonicalTitle(game.title);

  if (KNOWN_GAME_PATCHES[currentTitleLower]) return KNOWN_GAME_PATCHES[currentTitleLower];
  if (KNOWN_GAME_PATCHES[currentNorm]) return KNOWN_GAME_PATCHES[currentNorm];
  if (game.id && KNOWN_GAME_PATCHES[game.id.toLowerCase()]) {
    return KNOWN_GAME_PATCHES[game.id.toLowerCase()];
  }
  if (game.steamAppId && KNOWN_GAME_PATCHES[`app-${game.steamAppId}`]) {
    return KNOWN_GAME_PATCHES[`app-${game.steamAppId}`];
  }

  return undefined;
}

export interface SanitizeCatalogOptions {
  allowNewPurchases?: boolean;
  validSteamAppIds?: Set<number>;
  skipUserOverrides?: boolean;
}

function buildBaselineSets() {
  const validGogProductIds = new Set<string>();
  const validGogTitles = new Set<string>();
  for (const g of GOG_USER_LIBRARY) {
    validGogTitles.add(normalizeCanonicalTitle(g.title));
    for (const p of g.platforms) {
      if (p.platformId === 'gog' && p.platformGameId) {
        validGogProductIds.add(p.platformGameId.trim());
      }
    }
  }

  const validEpicBaseGameByCatalogId = new Map<string, CanonicalGame>();
  const validEpicCatalogIds = new Set<string>();
  const validEpicTitles = new Set<string>();
  for (const g of EPIC_USER_LIBRARY) {
    validEpicTitles.add(normalizeCanonicalTitle(g.title));
    for (const p of g.platforms) {
      if (p.platformId === 'epic' && p.platformGameId) {
        const cleanId = p.platformGameId.trim().toLowerCase();
        validEpicCatalogIds.add(cleanId);
        validEpicBaseGameByCatalogId.set(cleanId, g);
      }
    }
  }

  const validSteamAppIds = new Set<number>();
  const validSteamTitles = new Set<string>();
  for (const g of FULL_USER_STEAM_GAMES) {
    if (g.steamAppId) validSteamAppIds.add(g.steamAppId);
    validSteamTitles.add(normalizeCanonicalTitle(g.title));
  }

  return {
    validGogProductIds,
    validGogTitles,
    validEpicBaseGameByCatalogId,
    validEpicCatalogIds,
    validEpicTitles,
    validSteamAppIds,
    validSteamTitles,
  };
}

/**
 * Sanitizes the catalog:
 * 1. Normalizes titles, platforms, OS flags, handoffs, and anti-cheat descriptors
 * 2. Purges raw GUIDs, microtransactions, invalid DLC entries, and unmapped codenames
 * 3. Applies user overrides (from Fix Match Wizard)
 * 4. Deduplicates games by normalized title and Steam App ID, merging multi-storefront ownership cleanly
 */
export function sanitizeGameCatalog(
  catalog: CanonicalGame[],
  optionsOrOverrides?: SanitizeCatalogOptions | Record<string, unknown>,
  maybeOptions?: SanitizeCatalogOptions
): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];

  clearUserHiddenSuppressedEntriesInMemory();
  syncSuppressedEntriesWithStorage();

  let suppressedMutatedThisPass = false;
  const recordSuppressed = (
    rawGame: CanonicalGame,
    reason: string,
    reasonCategory:
      | 'non_game_filter'
      | 'unverified_entitlement'
      | 'duplicate_conflict'
      | 'score_suppressed'
      | 'user_hidden',
    specificPlat?: { platformId: CanonicalGame['platforms'][number]['platformId']; platformGameId: string }
  ) => {
    if (recordSuppressedCatalogEntryInMemory(rawGame, reason, reasonCategory, specificPlat)) {
      suppressedMutatedThisPass = true;
    }
  };

  const options =
    maybeOptions ??
    (optionsOrOverrides &&
    ('allowNewPurchases' in optionsOrOverrides ||
      'validSteamAppIds' in optionsOrOverrides ||
      'skipUserOverrides' in optionsOrOverrides)
      ? (optionsOrOverrides as SanitizeCatalogOptions)
      : undefined);
  const explicitValidSteamAppIds =
    options?.validSteamAppIds instanceof Set ? options.validSteamAppIds : undefined;
  const skipUserOverrides = options?.skipUserOverrides === true;

  const {
    validGogProductIds,
    validGogTitles,
    validEpicBaseGameByCatalogId,
    validEpicCatalogIds,
    validEpicTitles,
    validSteamAppIds,
    validSteamTitles,
  } = buildBaselineSets();

  const verifiedEntitlements = loadVerifiedEntitlementsFromStorage();
  const userOverrides = skipUserOverrides ? {} : loadUserOverrides();
  const hasUserOverrides = !skipUserOverrides && Object.keys(userOverrides).length > 0;
  const hasHiddenStorefrontEntries = Object.keys(loadHiddenStorefrontEntries()).length > 0;
  const hasGamePatches = Object.keys(KNOWN_GAME_PATCHES).length > 0;
  const hasKnownEpicNames = Object.keys(KNOWN_EPIC_APP_NAMES).length > 0;
  const hasGogSpecialDescriptions = Object.keys(GOG_SPECIAL_DESCRIPTIONS).length > 0;
  const hasGogEnrichedCache = Object.keys(gogEnrichedCache).length > 0;

  const cleaned: CanonicalGame[] = [];
  const titleToIndex = new Map<string, number>();
  const steamIdToIndex = new Map<number, number>();
  const idToIndex = new Map<string, number>();
  let needsFinalOverridePass = false;

  // Pre-pass: Unmerge/split individual platforms that have an explicit splitFromMerged override
  const expandedCatalog: CanonicalGame[] = [];
  for (const rawItem of catalog) {
    if (!rawItem || !rawItem.title) continue;
    if (hasUserOverrides && Array.isArray(rawItem.platforms) && rawItem.platforms.length > 1) {
      const remainingPlatforms: typeof rawItem.platforms = [];
      const splitGames: CanonicalGame[] = [];

      for (const p of rawItem.platforms) {
        if (!p) continue;
        const pOv =
          userOverrides[`${p.platformId}:${p.platformGameId}`] ||
          userOverrides[`${p.platformId}-${p.platformGameId}`];
        const shouldSplit =
          Boolean(pOv?.splitFromMerged) ||
          Boolean(
            pOv?.title &&
              normalizeCanonicalTitle(pOv.title) !== normalizeCanonicalTitle(rawItem.title)
          );

        if (shouldSplit) {
          const splitPlatRawTitle =
            p.originalTitle ||
            pOv?.originalSourceTitle ||
            rawItem.originalStoreTitle ||
            rawItem.title;
          splitGames.push({
            ...rawItem,
            id: `${p.platformId}-${p.platformGameId}`,
            title: splitPlatRawTitle,
            sortTitle: getAlphabeticalTitleSortKey(splitPlatRawTitle, true),
            originalStoreTitle: splitPlatRawTitle,
            steamAppId:
              p.platformId === 'steam' && !isNaN(Number(p.platformGameId))
                ? Number(p.platformGameId)
                : undefined,
            enrichedMetadata: undefined,
            reviewScoreOverride: undefined,
            platforms: [{ ...p, originalTitle: splitPlatRawTitle }],
          });
        } else {
          remainingPlatforms.push(p);
        }
      }

      if (splitGames.length > 0) {
        needsFinalOverridePass = true;
        if (remainingPlatforms.length > 0) {
          const hadSteam = rawItem.platforms.some((p) => p.platformId === 'steam');
          const stillHasSteam = remainingPlatforms.some((p) => p.platformId === 'steam');
          const primaryRemaining = remainingPlatforms[0];
          const remainingTitle =
            !stillHasSteam && hadSteam
              ? primaryRemaining.originalTitle || rawItem.originalStoreTitle || rawItem.title
              : rawItem.title;
          expandedCatalog.push({
            ...rawItem,
            id:
              !stillHasSteam && hadSteam
                ? `${primaryRemaining.platformId}-${primaryRemaining.platformGameId}`
                : rawItem.id,
            title: remainingTitle,
            sortTitle: getAlphabeticalTitleSortKey(remainingTitle, true),
            steamAppId: !stillHasSteam && hadSteam ? undefined : rawItem.steamAppId,
            platforms: remainingPlatforms,
          });
        }
        expandedCatalog.push(...splitGames);
        continue;
      }
    }
    expandedCatalog.push(rawItem);
  }

  for (const rawGame of expandedCatalog) {
    if (!rawGame || !rawGame.title) continue;

    const rawSourceTitle =
      rawGame.originalStoreTitle || rawGame.platforms?.[0]?.originalTitle || rawGame.title;

    const hadRawPlatforms = Array.isArray(rawGame.platforms) && rawGame.platforms.length > 0;
    let platformsMutated = !Array.isArray(rawGame.platforms);
    const sanitizedPlatforms: GamePlatformOwnership[] = [];
    if (Array.isArray(rawGame.platforms)) {
      for (const p of rawGame.platforms) {
        if (!p || typeof p !== 'object') {
          platformsMutated = true;
          continue;
        }
        const isPhysicallyInstalled = Boolean(
          p.installed ||
            (typeof p.installPath === 'string' && p.installPath.trim().length > 0) ||
            (typeof p.executablePath === 'string' && p.executablePath.trim().length > 0)
        );
        if (
          !isPhysicallyInstalled &&
          p.platformId === 'xbox' &&
          p.ownershipType === 'subscription' &&
          p.subscriptionExpired === true
        ) {
          platformsMutated = true;
          continue;
        }
        const needsOriginalTitle = !p.originalTitle && Boolean(rawSourceTitle);
        const needsStripVersion = !isPhysicallyInstalled && p.version !== undefined;
        let workingP: GamePlatformOwnership = p;
        if (needsOriginalTitle || needsStripVersion) {
          workingP = {
            ...p,
            originalTitle: p.originalTitle || rawSourceTitle,
          };
          if (needsStripVersion) {
            delete workingP.version;
          }
        }
        const osSanitizedP = sanitizePlatformOwnershipOsFlags(workingP);
        if (osSanitizedP !== p) {
          platformsMutated = true;
        }
        sanitizedPlatforms.push(osSanitizedP);
      }
    }
    if (hadRawPlatforms && sanitizedPlatforms.length === 0) {
      continue;
    }

    let game: CanonicalGame =
      rawGame.originalStoreTitle === rawSourceTitle && !platformsMutated
        ? rawGame
        : {
            ...rawGame,
            originalStoreTitle: rawSourceTitle,
            platforms: platformsMutated ? sanitizedPlatforms : rawGame.platforms,
          };

    if (
      game.worksOn &&
      typeof game.worksOn === 'object' &&
      !game.worksOn.windows &&
      !game.worksOn.Windows &&
      !game.worksOn.mac &&
      !game.worksOn.Mac &&
      !game.worksOn.linux &&
      !game.worksOn.Linux
    ) {
      game = {
        ...game,
        worksOn: { windows: true, mac: false, linux: false },
      };
    }
    if (
      game.platforms_os &&
      typeof game.platforms_os === 'object' &&
      !game.platforms_os.windows &&
      !game.platforms_os.mac &&
      !game.platforms_os.linux
    ) {
      game = {
        ...game,
        platforms_os: { windows: true, mac: false, linux: false },
      };
    }

    // Enforce user-hidden storefront entries
    if (hasHiddenStorefrontEntries) {
      if (game.platforms.length > 0) {
        const visiblePlatforms: typeof game.platforms = [];
        for (const p of game.platforms) {
          if (isStorefrontEntryHidden(p.platformId, p.platformGameId, game.id)) {
            const platRawTitle = p.originalTitle || game.originalStoreTitle || game.title;
            const hiddenSnap: CanonicalGame = {
              ...game,
              id:
                game.platforms.length > 1
                  ? `${p.platformId}-${p.platformGameId}`
                  : game.id || `${p.platformId}-${p.platformGameId}`,
              title: platRawTitle,
              originalStoreTitle: platRawTitle,
              platforms: [{ ...p, originalTitle: platRawTitle }],
            };
            recordSuppressed(hiddenSnap, 'Hidden / Suppressed by User', 'user_hidden', {
              platformId: p.platformId,
              platformGameId: String(p.platformGameId || game.id),
            });
          } else {
            visiblePlatforms.push(p);
          }
        }
        if (visiblePlatforms.length === 0) {
          continue;
        }
        if (visiblePlatforms.length !== game.platforms.length) {
          const hadSteam = game.platforms.some((p) => p.platformId === 'steam');
          const stillHasSteam = visiblePlatforms.some((p) => p.platformId === 'steam');
          game = {
            ...game,
            id:
              !stillHasSteam && hadSteam
                ? `${visiblePlatforms[0].platformId}-${visiblePlatforms[0].platformGameId}`
                : game.id,
            steamAppId: !stillHasSteam && hadSteam ? undefined : game.steamAppId,
            platforms: visiblePlatforms,
          };
        }
      } else if (isStorefrontEntryHidden(undefined, undefined, game.id)) {
        recordSuppressed(game, 'Hidden / Suppressed by User', 'user_hidden');
        continue;
      }
    }

    if (STOREFRONT_BONUS_SUFFIX_REGEX.test(game.title)) {
      const strippedTitle = game.title.replace(STOREFRONT_BONUS_SUFFIX_REGEX, '').trim();
      game = {
        ...game,
        title: strippedTitle,
        sortTitle: getAlphabeticalTitleSortKey(strippedTitle, true),
      };
    }

    if (game.platforms.some((p) => p.platformId === 'xbox') && game.title) {
      const strippedXboxTitle = stripStorefrontPlatformDisambiguators(game.title);
      if (strippedXboxTitle && strippedXboxTitle !== game.title) {
        const preservedRawTitle = game.originalStoreTitle || rawGame.title;
        game = {
          ...game,
          title: strippedXboxTitle,
          originalStoreTitle: preservedRawTitle,
          sortTitle: getAlphabeticalTitleSortKey(strippedXboxTitle, true),
          platforms: game.platforms.map((p) =>
            p.platformId === 'xbox' && !p.originalTitle
              ? { ...p, originalTitle: preservedRawTitle }
              : p
          ),
          ...(game.enrichedMetadata && game.enrichedMetadata.name === game.title
            ? {
                enrichedMetadata: {
                  ...game.enrichedMetadata,
                  name: strippedXboxTitle,
                },
              }
            : {}),
        };
      }
    }

    const lowerTitle = game.title.toLowerCase().trim();

    // 1. Resolve Epic codenames if present (O(1) skip when table is empty)
    if (hasKnownEpicNames) {
      const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
      const epicPlatformId = (epicPlatform?.platformGameId || '').toLowerCase().trim();
      const gameIdClean = game.id.replace(/^epic-/, '').toLowerCase().trim();

      const epicMapping =
        KNOWN_EPIC_APP_NAMES[lowerTitle] ||
        (epicPlatformId ? KNOWN_EPIC_APP_NAMES[epicPlatformId] : undefined) ||
        (gameIdClean ? KNOWN_EPIC_APP_NAMES[gameIdClean] : undefined);

      if (epicMapping) {
        const steamId = epicMapping.steamAppId;
        const epicArtCtx: ArtworkRecoveryContext = {
          gameId: steamId ? `steam-${steamId}` : game.id,
          title: epicMapping.title,
          steamAppId: steamId || game.steamAppId,
        };
        const nextHeader = steamId
          ? reconcileHeaderImage(
              game.headerImage,
              `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`,
              epicArtCtx
            ) || game.headerImage
          : game.headerImage;
        const nextCapsule = steamId
          ? reconcileCapsuleImage(
              game.capsuleImage,
              !isKnownDeadSteamCover(steamId)
                ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/library_600x900_2x.jpg`
                : undefined,
              { ...epicArtCtx, headerUrl: nextHeader }
            )
          : game.capsuleImage;
        game = {
          ...game,
          id: steamId ? `steam-${steamId}` : game.id,
          title: epicMapping.title,
          sortTitle: getAlphabeticalTitleSortKey(epicMapping.title, true),
          steamAppId: steamId || game.steamAppId,
          headerImage: nextHeader,
          capsuleImage: nextCapsule,
          shortDescription: epicMapping.description || game.shortDescription,
          developers: epicMapping.developer ? [epicMapping.developer] : game.developers,
        };
      }
    }

    // Look up userOverride and restored non-game flag lazily
    let userOverride = hasUserOverrides ? getUserOverrideForGame(game, userOverrides) : undefined;
    let cachedRestoredNonGame: boolean | undefined;
    const getIsRestoredNonGame = (): boolean => {
      if (cachedRestoredNonGame === undefined) {
        cachedRestoredNonGame =
          game.platforms.some((p) =>
            isNonGameStorefrontEntryRestored(p.platformId, p.platformGameId, game.id)
          ) || isNonGameStorefrontEntryRestored(undefined, undefined, game.id);
      }
      return cachedRestoredNonGame;
    };

    // 2. Filter out junk, pure hex hashes, microtransaction packs, and unmapped codenames
    if (isEpicNonGameEntry(game)) {
      if (!userOverride && !getIsRestoredNonGame()) {
        recordSuppressed(game, getNonGameSuppressionReason(game), 'non_game_filter');
        continue;
      }
    }

    const currentTitleLower = game.title.toLowerCase().trim();
    let normTitle = normalizeCanonicalTitle(game.title);
    if (isUnmappedEpicInternalCodename(game)) {
      if (!userOverride && !getIsRestoredNonGame()) {
        recordSuppressed(game, getNonGameSuppressionReason(game), 'non_game_filter');
        continue;
      }
    }

    // Curated game patches declarative lookup (no-op when KNOWN_GAME_PATCHES is empty)
    const patch = hasGamePatches ? findGamePatch(game, currentTitleLower, normTitle) : undefined;
    if (patch) {
      game = applyCatalogPatch(game, patch);
      if (game.platforms.length === 0) continue;
      normTitle = normalizeCanonicalTitle(game.title);
    }

    // Curated user override lookup (explicit user intent takes highest priority)
    if (hasUserOverrides && !userOverride) {
      userOverride = getUserOverrideForGame(game, userOverrides);
    }
    if (userOverride) {
      game = applyUserOverrideToGame(game, userOverride);
      normTitle = normalizeCanonicalTitle(game.title);
    } else if (hasUserOverrides) {
      // Self-heal leaked fields previously bled from an incompatible sibling override on the
      // same storefront (e.g. xbox:9NRRJLLXM68V override sharing steam-2537590 with xbox:9P38D19T7LRV).
      const conflictingOv = findIncompatibleCollidingOverrideForGame(game, userOverrides);
      if (conflictingOv) {
        const leakedReview = doesReviewScoreOverrideMatch(
          game.reviewScoreOverride,
          conflictingOv.reviewScoreOverride
        );
        const leakedNonSteam = Boolean(
          game.isExplicitNonSteam === true &&
            (conflictingOv.isExplicitNonSteam === true || conflictingOv.steamAppId === null)
        );
        const leakedEnrichedDate = Boolean(
          conflictingOv.releaseDate &&
            game.enrichedMetadata?.releaseDate === conflictingOv.releaseDate &&
            (leakedReview || leakedNonSteam)
        );
        if (leakedReview || leakedNonSteam || leakedEnrichedDate) {
          const healed: CanonicalGame = { ...game };
          if (leakedReview) {
            delete healed.reviewScoreOverride;
          }
          if (leakedNonSteam) {
            delete healed.isExplicitNonSteam;
          }
          if (leakedEnrichedDate && healed.enrichedMetadata) {
            const safeTopDate =
              healed.releaseDate && healed.releaseDate !== conflictingOv.releaseDate
                ? sanitizeStoreReleaseDate(healed.releaseDate)
                : undefined;
            healed.enrichedMetadata = {
              ...healed.enrichedMetadata,
              releaseDate: safeTopDate || 'TBA',
            };
          }
          game = healed;
        }
      }
    }

    const isAuthenticNew =
      game.isVerifiedEntitlement === true ||
      options?.allowNewPurchases === true ||
      game.platforms.some((p) => p.installed === true) ||
      getIsRestoredNonGame();

    // 6. Verify GOG entitlements
    if (game.platforms.some((p) => p.platformId === 'gog')) {
      const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
      const gogIdTrimmed = (gogPlatform?.platformGameId || '').trim();
      const isMockOrUnownedGog = isMockOrUnownedIdentifier(game.id, gogIdTrimmed);
      const isVerifiedGogDynamic =
        (gogIdTrimmed && verifiedEntitlements.gog.has(gogIdTrimmed.toLowerCase())) ||
        verifiedEntitlements.gog.has(normTitle) ||
        verifiedEntitlements.gog.has(normalizeCanonicalTitle(rawGame.title));
      const isRealGogGame =
        !isMockOrUnownedGog &&
        (userOverride !== undefined ||
          isAuthenticNew ||
          isVerifiedGogDynamic ||
          validGogProductIds.size === 0 ||
          (gogIdTrimmed && validGogProductIds.has(gogIdTrimmed)) ||
          validGogTitles.has(normTitle) ||
          validGogTitles.has(normalizeCanonicalTitle(rawGame.title)) ||
          getIsRestoredNonGame());

      if (isVerifiedGogDynamic && !isMockOrUnownedGog && !game.isVerifiedEntitlement) {
        game = { ...game, isVerifiedEntitlement: true };
      }

      if (!isRealGogGame) {
        recordSuppressed(
          game,
          'Filtered as unverified storefront entitlement',
          'unverified_entitlement',
          { platformId: 'gog', platformGameId: gogIdTrimmed || game.id }
        );
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'gog'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    // 7. Verify Epic entitlements (preserving valid YYYY-MM-DD releaseDate values!)
    if (game.platforms.some((p) => p.platformId === 'epic')) {
      const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
      const epicGameId = (epicPlatform?.platformGameId || '').trim().toLowerCase();

      if (!validEpicTitles.has(normTitle) && validEpicBaseGameByCatalogId.has(epicGameId)) {
        const baseGame = validEpicBaseGameByCatalogId.get(epicGameId)!;
        game = {
          ...baseGame,
          originalStoreTitle: game.originalStoreTitle || rawSourceTitle,
          isVerifiedEntitlement: game.isVerifiedEntitlement || baseGame.isVerifiedEntitlement,
          matchConfidence: game.matchConfidence ?? baseGame.matchConfidence,
          needsMatchReview: game.needsMatchReview ?? baseGame.needsMatchReview,
          platforms: game.platforms.map((p) =>
            p.platformId === 'epic'
              ? {
                  ...p,
                  platformGameId: epicGameId,
                  originalTitle: p.originalTitle || rawSourceTitle,
                }
              : { ...p, originalTitle: p.originalTitle || rawSourceTitle }
          ),
        };
      }

      const updatedNormTitle = normalizeCanonicalTitle(game.title);
      const isNonGameEpic = !userOverride && isEpicNonGameEntry(game) && !getIsRestoredNonGame();
      const isMockOrInvalidEpic =
        isMockOrUnownedIdentifier(game.id, epicPlatform?.platformGameId) || isNonGameEpic;
      const isVerifiedEpicDynamic =
        (epicGameId && verifiedEntitlements.epic.has(epicGameId)) ||
        verifiedEntitlements.epic.has(updatedNormTitle) ||
        verifiedEntitlements.epic.has(normalizeCanonicalTitle(rawGame.title));
      const isRealEpicGame =
        !isMockOrInvalidEpic &&
        (userOverride !== undefined ||
          isAuthenticNew ||
          isVerifiedEpicDynamic ||
          validEpicTitles.size === 0 ||
          (epicGameId && validEpicCatalogIds.has(epicGameId)) ||
          validEpicTitles.has(updatedNormTitle) ||
          validEpicTitles.has(normalizeCanonicalTitle(rawGame.title)) ||
          getIsRestoredNonGame());

      if (isVerifiedEpicDynamic && !isMockOrInvalidEpic && !game.isVerifiedEntitlement) {
        game = { ...game, isVerifiedEntitlement: true };
      }

      if (!isRealEpicGame) {
        recordSuppressed(
          game,
          isNonGameEpic
            ? getNonGameSuppressionReason(game)
            : 'Filtered as unverified storefront entitlement',
          isNonGameEpic ? 'non_game_filter' : 'unverified_entitlement',
          { platformId: 'epic', platformGameId: epicGameId || game.id }
        );
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'epic'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    // 7b. Verify Xbox / Microsoft Store / Game Pass entitlements
    if (game.platforms.some((p) => p.platformId === 'xbox')) {
      const xboxPlatform = game.platforms.find((p) => p.platformId === 'xbox');
      const xboxGameId = (
        xboxPlatform?.xboxProductId ||
        xboxPlatform?.platformGameId ||
        xboxPlatform?.xboxTitleId ||
        ''
      )
        .trim()
        .toLowerCase();
      const isNonGameXbox = !userOverride && isNonGameCatalogEntry(game) && !getIsRestoredNonGame();
      const isMockOrInvalidXbox =
        isMockOrUnownedIdentifier(game.id, xboxPlatform?.platformGameId) || isNonGameXbox;
      const hasValidXboxIdentifier = Boolean(
        xboxPlatform?.xboxProductId ||
          xboxPlatform?.xboxTitleId ||
          xboxPlatform?.packageFamilyName ||
          xboxPlatform?.platformGameId
      );
      const isVerifiedXboxDynamic =
        (xboxGameId && verifiedEntitlements.xbox.has(xboxGameId)) ||
        (xboxPlatform?.platformGameId &&
          verifiedEntitlements.xbox.has(xboxPlatform.platformGameId.trim().toLowerCase())) ||
        verifiedEntitlements.xbox.has(normTitle) ||
        verifiedEntitlements.xbox.has(normalizeCanonicalTitle(rawGame.title));

      const isRealXboxGame =
        !isMockOrInvalidXbox &&
        (userOverride !== undefined ||
          isAuthenticNew ||
          isVerifiedXboxDynamic ||
          hasValidXboxIdentifier ||
          getIsRestoredNonGame());

      if (
        (isVerifiedXboxDynamic || hasValidXboxIdentifier) &&
        !isMockOrInvalidXbox &&
        !game.isVerifiedEntitlement
      ) {
        game = { ...game, isVerifiedEntitlement: true };
      }

      if (!isRealXboxGame) {
        recordSuppressed(
          game,
          isNonGameXbox
            ? getNonGameSuppressionReason(game)
            : 'Filtered as unverified storefront entitlement',
          isNonGameXbox ? 'non_game_filter' : 'unverified_entitlement',
          { platformId: 'xbox', platformGameId: xboxGameId || game.id }
        );
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'xbox'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    // 8. Verify Steam entitlements and strip phantom Steam entries
    if (game.platforms.some((p) => p.platformId === 'steam')) {
      const steamPlatform = game.platforms.find((p) => p.platformId === 'steam');
      const appId =
        game.steamAppId ||
        (steamPlatform?.platformGameId && !isNaN(Number(steamPlatform.platformGameId))
          ? Number(steamPlatform.platformGameId)
          : undefined);

      const isUnownedPromo =
        !userOverride && appId && UNOWNED_STEAM_PROMO_APP_IDS.has(appId)
          ? !getIsRestoredNonGame()
          : false;
      const isMockOrUnownedSteam = isMockOrUnownedIdentifier(
        game.id,
        steamPlatform?.platformGameId
      );
      const isVerifiedSteamDynamic = Boolean(appId && verifiedEntitlements.steam.has(appId));
      const isBaselineSteamOwned =
        explicitValidSteamAppIds !== undefined
          ? Boolean(appId && (explicitValidSteamAppIds.has(appId) || isVerifiedSteamDynamic))
          : validSteamAppIds.size === 0 ||
            isVerifiedSteamDynamic ||
            (appId
              ? validSteamAppIds.has(appId)
              : validSteamTitles.has(normTitle) ||
                validSteamTitles.has(normalizeCanonicalTitle(rawGame.title)));

      const hasNonSteamRunnerPath = Boolean(
        steamPlatform?.installPath &&
          /[/\\](?:epic|gog|legendary|heroic|xboxgames|windowsapps)[/\\]/i.test(
            steamPlatform.installPath
          )
      );
      const hasRealSteamappsPath = Boolean(
        steamPlatform?.installPath && /steamapps/i.test(steamPlatform.installPath)
      );

      let isRealSteamGame: boolean;
      if (isUnownedPromo || isMockOrUnownedSteam || hasNonSteamRunnerPath) {
        isRealSteamGame = false;
      } else if (explicitValidSteamAppIds !== undefined) {
        isRealSteamGame = isBaselineSteamOwned || hasRealSteamappsPath;
      } else if (!isBaselineSteamOwned) {
        isRealSteamGame =
          userOverride?.matchedStore === 'steam' || isAuthenticNew || hasRealSteamappsPath;
      } else {
        isRealSteamGame = true;
      }

      if (isVerifiedSteamDynamic && isRealSteamGame && !game.isVerifiedEntitlement) {
        game = { ...game, isVerifiedEntitlement: true };
      }

      if (isUnownedPromo || !isRealSteamGame) {
        recordSuppressed(
          game,
          isUnownedPromo
            ? 'Filtered as SDK / Redistributable / Promo AppID'
            : 'Filtered as unverified storefront entitlement',
          isUnownedPromo ? 'non_game_filter' : 'unverified_entitlement',
          {
            platformId: 'steam',
            platformGameId: String(steamPlatform?.platformGameId || appId || game.id),
          }
        );
        const remainingPlatforms = game.platforms.filter((p) => p.platformId !== 'steam');
        if (remainingPlatforms.length === 0) {
          continue;
        }
        // Only fold local session playtime back onto the sibling non-Steam platform when the
        // phantom Steam entry explicitly carried a misattributed non-Steam install directory.
        // Never add arbitrary unowned Steam playtime onto GOG/Epic platforms!
        if (hasNonSteamRunnerPath && (steamPlatform?.playtimeMinutes || 0) > 0) {
          remainingPlatforms[0] = {
            ...remainingPlatforms[0],
            playtimeMinutes:
              (remainingPlatforms[0].playtimeMinutes || 0) + (steamPlatform?.playtimeMinutes || 0),
            lastPlayed: remainingPlatforms[0].lastPlayed || steamPlatform?.lastPlayed,
          };
        }
        game = {
          ...game,
          steamAppId: isUnownedPromo ? undefined : game.steamAppId,
          platforms: remainingPlatforms,
        };
      } else if (
        game.steamAppId &&
        steamPlatform &&
        steamPlatform.platformGameId !== String(game.steamAppId)
      ) {
        game = {
          ...game,
          platforms: game.platforms.map((p) =>
            p.platformId === 'steam' ? { ...p, platformGameId: String(game.steamAppId) } : p
          ),
        };
      }
    }

    normTitle = normalizeCanonicalTitle(game.title);

    const matchedAppIdForBlurb =
      userOverride?.steamAppId === null || game.isExplicitNonSteam
        ? undefined
        : game.steamAppId || steamMatcher.peekCachedMatch(game.title);

    // Self-heal legacy Xbox native metadata lacking a valid Steam AppID
    if (
      game.enrichedMetadata &&
      game.platforms.some((p) => p.platformId === 'xbox') &&
      (!game.enrichedMetadata.appId || Number(game.enrichedMetadata.appId) <= 0) &&
      (game.enrichedMetadata.metadataQuality === undefined ||
        (game.enrichedMetadata.metadataQuality === 'authoritative' &&
          game.enrichedMetadata.enrichedSource !== 'steam'))
    ) {
      game = {
        ...game,
        enrichedMetadata: {
          ...game.enrichedMetadata,
          metadataQuality: 'storefront_native',
          enrichedSource: game.enrichedMetadata.enrichedSource || 'xbox',
        },
      };
    }

    // Purge cached placeholder tokens, HTML in shortDescription, or regional non-English movies.
    // Skip __quotaSlimmed first-paint projections so stripped `undefined` descriptions stay undefined.
    if (game.enrichedMetadata && !game.enrichedMetadata.__quotaSlimmed) {
      const hasPlaceholderShort = isPlaceholderDesc(
        game.enrichedMetadata.shortDescription,
        game.title
      );
      const hasHtmlInShort = Boolean(
        game.enrichedMetadata.shortDescription &&
          /[<&]/.test(game.enrichedMetadata.shortDescription)
      );
      const hasGogPlaceholderTokens = /product_(?:description|feature)_\d+/i.test(
        game.enrichedMetadata.aboutTheGame || game.enrichedMetadata.detailedDescription || ''
      );
      const hasRegionalMovies = Boolean(
        Array.isArray(game.enrichedMetadata.movies) &&
          game.enrichedMetadata.movies.some((m) => isNonEnglishRegionalMovieName(m?.name))
      );
      const hasSteamLangPlaceholderOnNonSteam = Boolean(
        !game.steamAppId && game.enrichedMetadata.supportedLanguages === 'English<strong>*</strong>'
      );

      if (
        hasPlaceholderShort ||
        hasHtmlInShort ||
        hasGogPlaceholderTokens ||
        hasRegionalMovies ||
        hasSteamLangPlaceholderOnNonSteam
      ) {
        const cleanedAbout = cleanGogDescriptionHtml(game.enrichedMetadata.aboutTheGame);
        const cleanedDetailed = cleanGogDescriptionHtml(game.enrichedMetadata.detailedDescription);
        const sanitizedEnrichedShort = hasPlaceholderShort
          ? ''
          : stripHtmlToPlainSynopsis(game.enrichedMetadata.shortDescription);
        const filteredMovies = hasRegionalMovies
          ? filterEnglishMovies(game.enrichedMetadata.movies)
          : game.enrichedMetadata.movies;

        game = {
          ...game,
          enrichedMetadata: {
            ...game.enrichedMetadata,
            shortDescription: sanitizedEnrichedShort,
            aboutTheGame: isPlaceholderDesc(cleanedAbout, game.title) ? '' : cleanedAbout,
            detailedDescription: isPlaceholderDesc(cleanedDetailed, game.title)
              ? ''
              : cleanedDetailed,
            movies: filteredMovies,
            ...(hasSteamLangPlaceholderOnNonSteam ? { supportedLanguages: undefined } : {}),
          },
        };
      }
    }

    if (
      !userOverride?.shortDescription &&
      !(game.enrichedMetadata?.__quotaSlimmed === true && game.shortDescription === undefined) &&
      isPlaceholderDesc(game.shortDescription, game.title)
    ) {
      const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
      const gogSpecial =
        hasGogSpecialDescriptions && gogPlat?.platformGameId
          ? GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId]?.lead
          : null;
      const gogEnrichedEntry =
        hasGogEnrichedCache && gogPlat?.platformGameId
          ? (gogEnrichedCache as Record<string, GogEnrichedCacheItem>)[gogPlat.platformGameId]
          : null;
      const gogEnrichedDesc =
        gogEnrichedEntry?.shortDescription || gogEnrichedEntry?.description || null;
      const enrichedShort = game.enrichedMetadata?.shortDescription || null;
      const rawDetailedSource =
        game.enrichedMetadata?.aboutTheGame ||
        game.enrichedMetadata?.detailedDescription ||
        game.detailedDescription;
      const detailedFallback = rawDetailedSource
        ? extractFirstParagraph(rawDetailedSource, 300)
        : null;

      if (gogSpecial && !isPlaceholderDesc(gogSpecial, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(gogSpecial) };
      } else if (gogEnrichedDesc && !isPlaceholderDesc(gogEnrichedDesc, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(gogEnrichedDesc) };
      } else if (enrichedShort && !isPlaceholderDesc(enrichedShort, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(enrichedShort) };
      } else if (detailedFallback && !isPlaceholderDesc(detailedFallback, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(detailedFallback) };
      } else {
        game = { ...game, shortDescription: '' };
      }
    } else if (game.shortDescription) {
      const cleanedShort =
        /<[a-z][\s\S]*>/i.test(game.shortDescription) ||
        /when you buy this game\b|will be added to your gog\.com account/i.test(
          game.shortDescription
        )
          ? extractFirstParagraph(game.shortDescription) ||
            sanitizeShortDescriptionText(game.shortDescription.replace(/<[^>]+>/g, ' '))
          : sanitizeShortDescriptionText(game.shortDescription);
      if (cleanedShort !== game.shortDescription) {
        game = { ...game, shortDescription: cleanedShort };
      }
    }

    if (
      (!game.developers || game.developers.length === 0) &&
      game.enrichedMetadata?.developers?.length
    ) {
      const validDevs = game.enrichedMetadata.developers.filter(
        (d) => d && d !== 'Unknown Developer'
      );
      if (validDevs.length > 0) {
        game = { ...game, developers: validDevs };
      }
    }

    // Sanitize sentinel release dates
    if (game.enrichedMetadata?.releaseDate && game.enrichedMetadata.releaseDate !== 'TBA') {
      const sanitizedMetaDate = sanitizeStoreReleaseDate(game.enrichedMetadata.releaseDate);
      if (sanitizedMetaDate !== game.enrichedMetadata.releaseDate) {
        game = {
          ...game,
          enrichedMetadata: {
            ...game.enrichedMetadata,
            releaseDate: sanitizedMetaDate || 'TBA',
          },
        };
      }
    }

    if (game.releaseDate && game.releaseDate !== 'TBA') {
      const sanitizedTopDate = sanitizeStoreReleaseDate(game.releaseDate);
      if (!sanitizedTopDate) {
        const fallbackValidDate = sanitizeStoreReleaseDate(game.enrichedMetadata?.releaseDate);
        game = { ...game, releaseDate: fallbackValidDate || 'TBA' };
      } else if (sanitizedTopDate !== game.releaseDate) {
        game = { ...game, releaseDate: sanitizedTopDate };
      }
    } else if (
      (!game.releaseDate || game.releaseDate === 'TBA') &&
      game.enrichedMetadata?.releaseDate &&
      game.enrichedMetadata.releaseDate !== 'TBA'
    ) {
      const validMetaDate = sanitizeStoreReleaseDate(game.enrichedMetadata.releaseDate);
      if (validMetaDate) {
        game = { ...game, releaseDate: validMetaDate };
      }
    }

    if (
      game.enrichedMetadata?.capsuleImage &&
      isUnsuitableCoverUrl(game.enrichedMetadata.capsuleImage)
    ) {
      game = {
        ...game,
        enrichedMetadata: {
          ...game.enrichedMetadata,
          capsuleImage: undefined,
        },
      };
    }

    if (
      !userOverride?.headerImage &&
      game.enrichedMetadata?.headerImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\//i.test(game.enrichedMetadata.headerImage) &&
      (!game.headerImage || !/\/apps\/\d+\/[a-f0-9]{40}\//i.test(game.headerImage))
    ) {
      game = {
        ...game,
        headerImage: game.enrichedMetadata.headerImage,
      };
    }

    if (
      !userOverride?.capsuleImage &&
      game.capsuleImage &&
      (game.capsuleImage.includes('184x69') || game.capsuleImage.includes('capsule_sm_120'))
    ) {
      game = {
        ...game,
        capsuleImage:
          game.enrichedMetadata?.capsuleImage &&
          !isUnsuitableCoverUrl(game.enrichedMetadata.capsuleImage)
            ? game.enrichedMetadata.capsuleImage
            : undefined,
      };
    }

    const effectiveSteamIdForAssets = !game.isExplicitNonSteam
      ? game.steamAppId || matchedAppIdForBlurb
      : undefined;
    if (effectiveSteamIdForAssets) {
      const browseAssets = steamApi.peekCachedBrowseAssets(effectiveSteamIdForAssets);
      if (browseAssets) {
        const nextCapsule =
          !userOverride?.capsuleImage &&
          browseAssets.capsuleImage &&
          (!game.capsuleImage ||
            isUnsuitableCoverUrl(game.capsuleImage) ||
            isMicrosoftStoreCdnUrl(game.capsuleImage) ||
            (!/\/apps\/\d+\/[a-f0-9]{40}\//i.test(game.capsuleImage) &&
              /\/apps\/\d+\/[a-f0-9]{40}\//i.test(browseAssets.capsuleImage)))
            ? browseAssets.capsuleImage
            : game.capsuleImage;
        const nextHeader =
          !userOverride?.headerImage &&
          browseAssets.headerImage &&
          (!game.headerImage ||
            isUnsuitableHeaderUrl(game.headerImage) ||
            isMicrosoftStoreCdnUrl(game.headerImage) ||
            (!/\/apps\/\d+\/[a-f0-9]{40}\//i.test(game.headerImage) &&
              /\/apps\/\d+\/[a-f0-9]{40}\//i.test(browseAssets.headerImage)))
            ? browseAssets.headerImage
            : game.headerImage;
        const nextIcon =
          browseAssets.iconUrl &&
          (!game.iconUrl ||
            isMicrosoftStoreCdnUrl(game.iconUrl) ||
            (!/\/apps\/\d+\/[a-f0-9]{40}\//i.test(game.iconUrl) &&
              !game.iconUrl.includes('steamcommunity/public/images/apps/')))
            ? browseAssets.iconUrl
            : game.iconUrl;
        if (
          nextCapsule !== game.capsuleImage ||
          nextHeader !== game.headerImage ||
          nextIcon !== game.iconUrl
        ) {
          game = {
            ...game,
            capsuleImage: nextCapsule,
            headerImage: nextHeader,
            iconUrl: nextIcon,
          };
        }
      }
    }

    const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
    if (!userOverride?.capsuleImage && gogPlat && gogPlat.platformGameId) {
      const enrichedGog = hasGogEnrichedCache
        ? (gogEnrichedCache as Record<string, GogEnrichedCacheItem>)[gogPlat.platformGameId]
        : undefined;
      const hHash = enrichedGog?.coverHorizontal
        ? enrichedGog.coverHorizontal.match(/\/([a-f0-9]{64})/i)?.[1]
        : null;
      const needsVerticalCover =
        !game.capsuleImage ||
        (hHash && game.capsuleImage.includes(hHash)) ||
        game.capsuleImage.includes('_glx_vertical_cover') ||
        isUnsuitableCoverUrl(game.capsuleImage) ||
        isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage);
      if (needsVerticalCover) {
        const gogVerticalCover =
          (enrichedGog?.coverVertical && !isUnsuitableCoverUrl(enrichedGog.coverVertical)
            ? enrichedGog.coverVertical
            : null) ||
          igdbCoverService.getGogVerticalCoverInstant(gogPlat.platformGameId, game.title);
        if (
          gogVerticalCover &&
          !isUnsuitableCoverUrl(gogVerticalCover) &&
          !isGogCroppedHorizontalCover(gogVerticalCover, game.headerImage) &&
          gogVerticalCover !== game.capsuleImage
        ) {
          game = {
            ...game,
            capsuleImage: gogVerticalCover,
            iconUrl: game.iconUrl || gogVerticalCover,
          };
        }
      }
    }

    if (!userOverride?.capsuleImage) {
      if (
        !game.capsuleImage ||
        isUnsuitableCoverUrl(game.capsuleImage) ||
        isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)
      ) {
        const instantIgdbCover = igdbCoverService.getIgdbCoverInstant(
          game.title,
          game.steamAppId || matchedAppIdForBlurb || undefined,
          game.id
        );
        if (
          instantIgdbCover &&
          !isUnsuitableCoverUrl(instantIgdbCover) &&
          instantIgdbCover !== game.capsuleImage
        ) {
          game = {
            ...game,
            capsuleImage: instantIgdbCover,
            iconUrl: game.iconUrl || instantIgdbCover,
          };
        }
      }
    }

    if (
      game.platforms.some(
        (p) =>
          p.platformId === 'xbox' &&
          ((p.ownershipType === 'owned' &&
            (p.gamePassTier !== undefined ||
              p.isLeavingSoon !== undefined ||
              p.isRecentlyAddedToGamePass !== undefined ||
              p.subscriptionExpired === true)) ||
            (p.subscriptionExpired &&
              (p.isLeavingSoon !== undefined || p.isRecentlyAddedToGamePass !== undefined)))
      )
    ) {
      game = {
        ...game,
        platforms: game.platforms.map((p) => {
          if (p.platformId !== 'xbox') return p;
          if (p.ownershipType === 'owned') {
            return {
              ...p,
              gamePassTier: undefined,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
              subscriptionExpired: false,
            };
          }
          if (p.subscriptionExpired) {
            return {
              ...p,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
            };
          }
          return p;
        }),
      };
    }

    // Single per-game handoff/anti-cheat/OS self-heal pass (eliminates 4x redundant invocations)
    game = selfHealCatalogEntryHandoffsAndOs(game);

    // 9. Cross-store deduplication by Steam App ID and Normalized Title
    const idMatchIndex = game.id && idToIndex.has(game.id) ? idToIndex.get(game.id)! : -1;
    const candidateIndex =
      (game.steamAppId && steamIdToIndex.has(game.steamAppId)
        ? steamIdToIndex.get(game.steamAppId)
        : undefined) ??
      (normTitle && titleToIndex.has(normTitle) ? titleToIndex.get(normTitle) : undefined) ??
      (idMatchIndex >= 0 ? idMatchIndex : undefined);
    const existingIndex =
      candidateIndex !== undefined &&
      cleaned[candidateIndex] &&
      !hasSameStorefrontConflict(cleaned[candidateIndex], game) &&
      (!hasUserOverrides ||
        !hasSplitOverrideConflict(cleaned[candidateIndex], game, userOverrides))
        ? candidateIndex
        : undefined;

    if (existingIndex !== undefined && cleaned[existingIndex]) {
      cleaned[existingIndex] = mergeDuplicateCatalogEntries({
        existing: cleaned[existingIndex],
        incoming: game,
        hasUserOverrides,
        userOverrides,
        incomingOverride: userOverride,
        explicitValidSteamAppIds,
      });
      needsFinalOverridePass = true;

      if (cleaned[existingIndex].steamAppId) {
        steamIdToIndex.set(cleaned[existingIndex].steamAppId!, existingIndex);
      }
      if (cleaned[existingIndex].id) {
        idToIndex.set(cleaned[existingIndex].id, existingIndex);
      }
    } else {
      if (
        candidateIndex !== undefined &&
        cleaned[candidateIndex] &&
        hasSameStorefrontConflict(cleaned[candidateIndex], game)
      ) {
        const disambiguated = disambiguateSameStorefrontCollision({
          cleaned,
          candidateIndex,
          incomingGame: game,
          hasUserOverrides,
          userOverrides,
          titleToIndex,
          steamIdToIndex,
          idToIndex,
        });
        game = disambiguated.game;
        normTitle = disambiguated.normTitle;
        needsFinalOverridePass = true;
      }

      const newIndex = cleaned.length;
      cleaned.push(game);
      if (normTitle) titleToIndex.set(normTitle, newIndex);
      if (game.steamAppId) steamIdToIndex.set(game.steamAppId, newIndex);
      if (game.id) idToIndex.set(game.id, newIndex);
    }
  }

  const finalCatalog =
    hasUserOverrides && needsFinalOverridePass
      ? applyUserOverridesToCatalog(cleaned, userOverrides)
      : cleaned;

  enforceUniqueIdsAndSteamAppIds(finalCatalog, hasUserOverrides, userOverrides);

  if (pruneActiveGamesFromSuppressedEntries(finalCatalog)) {
    suppressedMutatedThisPass = true;
  }

  if (suppressedMutatedThisPass) {
    persistSuppressedEntriesToStorage();
  }

  return finalCatalog.toSorted((a, b) => LIBRARY_TITLE_COLLATOR.compare(a.title, b.title));
}
