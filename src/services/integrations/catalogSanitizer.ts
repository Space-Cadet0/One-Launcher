import { CanonicalGame } from '../../contracts/game';
import { KNOWN_EPIC_APP_NAMES } from './epicCodenames';
import { GOG_USER_LIBRARY } from '../storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { igdbCoverService, isKnownDeadSteamCover, isUnsuitableCoverUrl, KNOWN_IGDB_COVERS } from '../igdb/igdbCoverService';
import { steamMatcher } from '../steam/steamMatcher';
import steamBlurbCache from '../storage/steamBlurbCache.json';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import { GOG_SPECIAL_DESCRIPTIONS } from '../steam/fallbackMetadataProvider';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
} from '../storage/userOverrideStorage';

/**
 * Checks if a string is a 20+ hex hash or UUID
 */
export function isHexOrGuidString(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  // 24+ character hexadecimal hash (e.g. c5109bdceb3a453bb38c2fdc964ddee8)
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return true;
  // Standard UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  return false;
}

export function sanitizeShortDescriptionText(desc?: string): string {
  if (!desc) return '';
  return desc.replace(/\[\/?[a-z0-9_=]+\]/gi, '').replace(/\s+/g, ' ').trim();
}

export function isPlaceholderDesc(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const trimmed = sanitizeShortDescriptionText(desc);
  if (trimmed.length <= 3) return true;
  const lower = trimmed.toLowerCase();
  if (title && lower === title.trim().toLowerCase()) return true;
  if (lower.includes('description is not set')) return true;
  if (lower.includes('on gog.com')) return true;
  if (lower.includes('drm-free')) return true;
  if (lower.includes('epic games store')) return true;
  if (lower.includes('store exclusive')) return true;
  if (lower.endsWith(' experience') && trimmed.split(' ').length <= 4) return true;
  if (/^(action|role-playing|adventure|shooter|strategy|simulation|racing|sports|indie)\s+experience$/i.test(trimmed)) return true;
  if (lower === 'classic title') return true;
  if (/^[a-z\s-]+ on gog\.com/i.test(trimmed)) return true;
  if (/^dlcs?\s+(included|available)/i.test(trimmed)) return true;
  if (/^includes\s+(the\s+following\s+)?dlc/i.test(trimmed)) return true;
  if (/^bonus\s+content/i.test(trimmed)) return true;
  if (/^this\s+package\s+includes/i.test(trimmed)) return true;

  // Reject unlocalized CJK blurbs on purely non-CJK game titles (e.g. Japanese store blurb on English strategy title)
  if (
    title &&
    !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(title.trim()) &&
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(trimmed)
  ) {
    return true;
  }

  // Reject cross-game publisher copy-paste bleed where an ALL-CAPS game subject ("..., LUNARK is a 2D...") contradicts the title
  if (title) {
    const bleedMatch = trimmed.match(/,\s+([A-Z][A-Z0-9]{3,})\s+is\s+(?:a|an|the)\b/);
    if (bleedMatch && bleedMatch[1] && !title.toUpperCase().includes(bleedMatch[1])) {
      return true;
    }
  }

  return false;
}

export const NON_GAME_CATALOG_TITLE_REGEX =
  /\b(tech beta|closed beta|open beta|public testing|playtest|test branch|alpha version|legacy mode|pre-game editor|resource archiver|digital goodies|digital comics|playable teaser|prologue)\b|\bcontent$|killingfloor2beta|^sin multiplayer$/i;

export function isNonGameCatalogEntry(game: CanonicalGame): boolean {
  const title = (game.title || '').trim();
  if (!title) return true;
  if (NON_GAME_CATALOG_TITLE_REGEX.test(title)) {
    return true;
  }
  return false;
}

/**
 * Detects whether an item is a non-game item (Fortnite microtransactions, DLC packs, add-on assets, betas, editors, prologues)
 */
export function isEpicNonGameEntry(game: CanonicalGame): boolean {
  const title = (game.title || '').trim().toLowerCase();
  const id = (game.id || '').toLowerCase();

  if (!game.isVerifiedEntitlement && isNonGameCatalogEntry(game)) {
    return true;
  }

  // Pure hex or UUID titles
  if (isHexOrGuidString(game.title)) {
    if (id.includes('c5109bdceb3a453bb38c2fdc964ddee8')) {
      return false;
    }
    return true;
  }

  // Fortnite DLC, microtransactions, battle passes, cosmetics
  if (title.includes('fortnite')) {
    const isFortniteDlc =
      title.includes('pack') ||
      title.includes('bundle') ||
      title.includes('v-bucks') ||
      title.includes('vbucks') ||
      title.includes('skin') ||
      title.includes('battle pass') ||
      title.includes('outfit') ||
      title.includes('chapter') ||
      title.includes('season') ||
      title.includes('starter') ||
      title.includes('crew') ||
      title.includes('drop') ||
      title.includes('quest') ||
      title.includes('emotes');

    // Only allow the base game "Fortnite"
    if (isFortniteDlc && title !== 'fortnite') {
      return true;
    }
  }

  // Unreal Engine Marketplace assets & plugins
  if (
    title.includes('starter content') ||
    title.includes('unreal engine') ||
    title.includes('megascans') ||
    id.includes('ue-') ||
    id.includes('unreal-engine') ||
    id.includes('unreal_engine') ||
    id.includes('unrealengine')
  ) {
    return true;
  }

  // Standalone DLC tags or descriptions that slipped in as separate games
  const hasDlcOnlyTag = game.tags?.some((t) => t.toLowerCase() === 'dlc' || t.toLowerCase() === 'add-on');
  const isSoundtrackOrArtbook =
    title.endsWith(' soundtrack') ||
    title.endsWith(' ost') ||
    title.endsWith(' artbook') ||
    title.includes(' - soundtrack') ||
    title.includes(' bonus content');

  if (hasDlcOnlyTag && isSoundtrackOrArtbook) {
    return true;
  }

  return false;
}

/**
 * Normalizes title for robust cross-storefront game deduplication
 * Preserves distinct remake/remaster/enhanced/definitive/classic/gold editions while normalizing
 * packaging/DLC bundle suffixes across storefronts.
 */
export function normalizeCanonicalTitle(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/\s*\+\s*official walkthrough$/i, '')
    .replace(/\biii\b/g, '3')
    .replace(/\bii\b/g, '2')
    .replace(/\biv\b/g, '4')
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(
      /\s+(the\s+)?(complete|extended|game of the year|goty|deluxe|standard|ultimate|20 year celebration|classic and uncut)\s*(edition|pack|bundle|collection)?$/g,
      ''
    )
    .replace(/\s+(goty|complete pack)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prevents collapsing two distinct game entitlements that belong to the SAME storefront
 * (e.g. Metro Exodus vs Metro Exodus Enhanced Edition on Steam, BioShock vs BioShock Remastered on GOG,
 * or Grand Theft Auto V vs Grand Theft Auto V Enhanced on Epic).
 */
export function hasSameStorefrontConflict(existing: CanonicalGame, incoming: CanonicalGame): boolean {
  if (existing.steamAppId && incoming.steamAppId && existing.steamAppId !== incoming.steamAppId) {
    return true;
  }
  for (const ep of existing.platforms || []) {
    if (!ep.platformId || !ep.platformGameId) continue;
    const ip = (incoming.platforms || []).find((p) => p.platformId === ep.platformId);
    if (ip && ip.platformGameId && String(ep.platformGameId).trim() !== String(ip.platformGameId).trim()) {
      return true;
    }
  }
  return false;
}

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
const validEpicSteamAppIds = new Set<number>();
for (const g of EPIC_USER_LIBRARY) {
  validEpicTitles.add(normalizeCanonicalTitle(g.title));
  if (g.steamAppId) validEpicSteamAppIds.add(g.steamAppId);
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

/**
 * Blacklist of non-game SDK test AppIDs (e.g. Spacewar 480).
 */
export const UNOWNED_STEAM_PROMO_APP_IDS = new Set<number>([
  480, // Spacewar (Steamworks SDK test app)
  228980, // Steamworks Common Redistributables
]);

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
    updated.iconUrl = patch.preserveExistingIcon && updated.iconUrl ? updated.iconUrl : patch.iconUrl;
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
  if (game.id && KNOWN_GAME_PATCHES[game.id.toLowerCase()]) return KNOWN_GAME_PATCHES[game.id.toLowerCase()];
  if (game.steamAppId && KNOWN_GAME_PATCHES[`app-${game.steamAppId}`]) {
    return KNOWN_GAME_PATCHES[`app-${game.steamAppId}`];
  }

  return undefined;
}

/**
 * Sanitizes the catalog:
 * 1. Resolves any mapped Epic codenames if present
 * 2. Purges raw GUIDs, Fortnite microtransaction items, invalid DLC entries, and unmapped codenames
 * 3. Applies user overrides (from Fix Match Wizard)
 * 4. Deduplicates games by normalized title and Steam App ID, merging multi-storefront ownership cleanly
 */
export function sanitizeGameCatalog(
  catalog: CanonicalGame[],
  optionsOrOverrides?: { allowNewPurchases?: boolean } | Record<string, any>,
  maybeOptions?: { allowNewPurchases?: boolean }
): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];

  const options =
    maybeOptions ??
    (optionsOrOverrides && 'allowNewPurchases' in optionsOrOverrides
      ? (optionsOrOverrides as { allowNewPurchases?: boolean })
      : undefined);
  const userOverrides = loadUserOverrides();
  const cleaned: CanonicalGame[] = [];
  const titleToIndex = new Map<string, number>();
  const steamIdToIndex = new Map<number, number>();
  const idToIndex = new Map<string, number>();

  for (const rawGame of catalog) {
    if (!rawGame || !rawGame.title) continue;

    let game = { ...rawGame };
    if (/\s*\+\s*Official Walkthrough$/i.test(game.title)) {
      const strippedTitle = game.title.replace(/\s*\+\s*Official Walkthrough$/i, '').trim();
      game = {
        ...game,
        title: strippedTitle,
        sortTitle: strippedTitle.replace(/^(The|A|An)\s+/i, ''),
      };
    }
    const lowerTitle = game.title.toLowerCase().trim();

    // 1. Resolve Epic codenames to their official game entities if present
    const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
    const epicPlatformId = (epicPlatform?.platformGameId || '').toLowerCase().trim();
    const gameIdClean = game.id.replace(/^epic-/, '').toLowerCase().trim();

    const epicMapping =
      KNOWN_EPIC_APP_NAMES[lowerTitle] ||
      (epicPlatformId ? KNOWN_EPIC_APP_NAMES[epicPlatformId] : undefined) ||
      (gameIdClean ? KNOWN_EPIC_APP_NAMES[gameIdClean] : undefined);

    if (epicMapping) {
      const steamId = epicMapping.steamAppId;
      game = {
        ...game,
        id: steamId ? `steam-${steamId}` : game.id,
        title: epicMapping.title,
        sortTitle: epicMapping.title.replace(/^(The|A|An)\s+/i, ''),
        steamAppId: steamId || game.steamAppId,
        headerImage: steamId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`
          : game.headerImage,
        capsuleImage: steamId
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/library_600x900_2x.jpg`
          : game.capsuleImage,
        shortDescription: epicMapping.description || game.shortDescription,
        developers: epicMapping.developer ? [epicMapping.developer] : game.developers,
      };
    }

    // 2. Filter out junk, pure hex hashes, Fortnite DLC, and unmapped codenames
    if (isEpicNonGameEntry(game)) {
      continue;
    }

    const currentTitleLower = game.title.toLowerCase().trim();
    let normTitle = normalizeCanonicalTitle(game.title);
    if ([
      'bobcat', 'boxfish', 'calluna', 'catnip', 'cormorant',
      'hazelnut', 'hazlenut', 'herring', 'boga', 'barbet', 'basil', 'batfish', 'batfishs2', 'blobfish',
      'speedwell', 'wombat', 'blackcoral', 'blunderbuss', 'boysenberry', 'brilliantrose',
      'cadmiumred', 'capsicum', 'alabaster', 'kingletaztec'
    ].includes(currentTitleLower)) {
      continue;
    }

    // Curated game patches declarative lookup
    const patch = findGamePatch(game, currentTitleLower, normTitle);
    if (patch) {
      game = applyCatalogPatch(game, patch);
      if (game.platforms.length === 0) continue;
      normTitle = normalizeCanonicalTitle(game.title);
    }

    // Curated user override lookup (explicit user intent takes highest priority)
    const userOverride = getUserOverrideForGame(game, userOverrides);
    if (userOverride) {
      game = applyUserOverrideToGame(game, userOverride);
      normTitle = normalizeCanonicalTitle(game.title);
    }

    const isAuthenticNew =
      game.isVerifiedEntitlement === true ||
      options?.allowNewPurchases === true ||
      game.platforms.some((p) => p.installed === true);

    // 6. Purge false GOG platform presence from unowned GOG titles (e.g. old bestselling catalog items like Anno 1404)
    if (game.platforms.some((p) => p.platformId === 'gog')) {
      const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
      const isMockOrUnownedGog =
        game.id.startsWith('mock-') ||
        (gogPlatform?.platformGameId || '').startsWith('unowned-');
      const isRealGogGame =
        !isMockOrUnownedGog &&
        (userOverride !== undefined ||
          isAuthenticNew ||
          validGogProductIds.size === 0 ||
          (gogPlatform?.platformGameId && validGogProductIds.has(gogPlatform.platformGameId.trim())) ||
          validGogTitles.has(normTitle) ||
          validGogTitles.has(normalizeCanonicalTitle(rawGame.title)));

      if (!isRealGogGame) {
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'gog'),
        };
        if (game.platforms.length === 0) continue;
      }
    }

    // 7. Purge false Epic platform presence from unowned Epic titles, DLCs, codenames, and non-games
    if (game.platforms.some((p) => p.platformId === 'epic')) {
      const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
      const epicGameId = (epicPlatform?.platformGameId || '').trim().toLowerCase();

      // If title is not recognized, but catalog ID matches a verified base game, re-assign to real base game
      if (!validEpicTitles.has(normTitle) && validEpicBaseGameByCatalogId.has(epicGameId)) {
        const baseGame = validEpicBaseGameByCatalogId.get(epicGameId)!;
        game = {
          ...baseGame,
          isVerifiedEntitlement: game.isVerifiedEntitlement || baseGame.isVerifiedEntitlement,
          matchConfidence: game.matchConfidence ?? baseGame.matchConfidence,
          needsMatchReview: game.needsMatchReview ?? baseGame.needsMatchReview,
          platforms: game.platforms.map((p) =>
            p.platformId === 'epic' ? { ...p, platformGameId: epicGameId } : p
          ),
        };
      }

      const updatedNormTitle = normalizeCanonicalTitle(game.title);
      const isMockOrInvalidEpic =
        game.id.startsWith('mock-') ||
        (epicPlatform?.platformGameId || '').startsWith('epic-hades') ||
        isEpicNonGameEntry(game);
      // Whitelist: every authentic Epic game must match one of the verified titles or be an authentic new purchase
      const isRealEpicGame =
        !isMockOrInvalidEpic &&
        (userOverride !== undefined ||
          isAuthenticNew ||
          validEpicTitles.size === 0 ||
          validEpicTitles.has(updatedNormTitle) ||
          validEpicTitles.has(normalizeCanonicalTitle(rawGame.title)));

      if (!isRealEpicGame) {
        game = {
          ...game,
          platforms: game.platforms.filter((p) => p.platformId !== 'epic'),
        };
        if (game.platforms.length === 0) continue;
      } else if (
        !userOverride?.releaseDate &&
        game.platforms.length === 1 &&
        game.platforms[0].platformId === 'epic' &&
        game.releaseDate &&
        /^\d{4}-\d{2}-\d{2}$/.test(game.releaseDate)
      ) {
        // Epic's library entitlement API previously mapped item.acquisitionDate (YYYY-MM-DD) into releaseDate.
        // Strip cached YYYY-MM-DD acquisition dates from Epic-only entries so they never poison year-based matching.
        game = {
          ...game,
          releaseDate: undefined,
        };
      }
    }

    // 8. Purge false Steam platform presence from unowned Steam titles, demos, promo cache, and non-Steam installations
    if (game.platforms.some((p) => p.platformId === 'steam')) {
      const steamPlatform = game.platforms.find((p) => p.platformId === 'steam');
      const gogPlatformForCheck = game.platforms.find((p) => p.platformId === 'gog');
      const appId =
        game.steamAppId ||
        (steamPlatform?.platformGameId && !isNaN(Number(steamPlatform.platformGameId))
          ? Number(steamPlatform.platformGameId)
          : undefined);

      const isUnownedPromo = appId ? UNOWNED_STEAM_PROMO_APP_IDS.has(appId) : false;
      const isBaselineSteamOwned =
        validSteamAppIds.size === 0 ||
        (appId
          ? validSteamAppIds.has(appId)
          : validSteamTitles.has(normTitle) ||
            validSteamTitles.has(normalizeCanonicalTitle(rawGame.title)));

      const hasNonSteamRunnerPath = Boolean(
        steamPlatform?.installPath &&
          /[/\\](?:epic|gog|legendary|heroic)[/\\]/i.test(steamPlatform.installPath)
      );
      const hasRealSteamappsPath = Boolean(
        steamPlatform?.installPath && /steamapps/i.test(steamPlatform.installPath)
      );
      const isKnownNonSteamGame =
        game.platforms.some((p) => p.platformId !== 'steam') ||
        validEpicTitles.has(normTitle) ||
        validGogTitles.has(normTitle) ||
        (gogPlatformForCheck?.platformGameId
          ? validGogProductIds.has(gogPlatformForCheck.platformGameId.trim())
          : false);

      let isRealSteamGame: boolean;
      if (!isBaselineSteamOwned) {
        if (hasNonSteamRunnerPath) {
          isRealSteamGame = false;
        } else if (isKnownNonSteamGame && !hasRealSteamappsPath) {
          isRealSteamGame = false;
        } else {
          isRealSteamGame =
            !isUnownedPromo &&
            !game.id.startsWith('mock-') &&
            (userOverride?.matchedStore === 'steam' || isAuthenticNew);
        }
      } else {
        isRealSteamGame =
          !isUnownedPromo && !game.id.startsWith('mock-') && !hasNonSteamRunnerPath;
      }

      if (isUnownedPromo || !isRealSteamGame) {
        const remainingPlatforms = game.platforms.filter((p) => p.platformId !== 'steam');
        if (remainingPlatforms.length === 0) {
          if ((steamPlatform?.playtimeMinutes || 0) > 0) {
            const existingIdx =
              (appId && steamIdToIndex.has(appId) ? steamIdToIndex.get(appId) : undefined) ??
              (normTitle && titleToIndex.has(normTitle) ? titleToIndex.get(normTitle) : undefined);
            if (
              existingIdx !== undefined &&
              cleaned[existingIdx] &&
              cleaned[existingIdx].platforms.length > 0
            ) {
              const target = cleaned[existingIdx];
              const firstPlat = target.platforms[0];
              cleaned[existingIdx] = {
                ...target,
                platforms: [
                  {
                    ...firstPlat,
                    playtimeMinutes:
                      (firstPlat.playtimeMinutes || 0) + (steamPlatform?.playtimeMinutes || 0),
                    lastPlayed: firstPlat.lastPlayed || steamPlatform?.lastPlayed,
                  },
                  ...target.platforms.slice(1),
                ],
              };
            }
          }
          continue;
        }
        if ((steamPlatform?.playtimeMinutes || 0) > 0) {
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
      } else if (game.steamAppId && steamPlatform && steamPlatform.platformGameId !== String(game.steamAppId)) {
        game = {
          ...game,
          platforms: game.platforms.map((p) =>
            p.platformId === 'steam' ? { ...p, platformGameId: String(game.steamAppId) } : p
          ),
        };
      }
    }

    normTitle = normalizeCanonicalTitle(game.title);

    // Look up Steam App ID for blurb / cover enrichment without altering game's canonical identity
    const matchedAppIdForBlurb =
      userOverride?.steamAppId === null
        ? undefined
        : (game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title));

    if (!userOverride?.shortDescription && isPlaceholderDesc(game.shortDescription, game.title)) {
      const blurb = matchedAppIdForBlurb ? (steamBlurbCache as Record<string, string>)[String(matchedAppIdForBlurb)] : null;
      const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
      const gogSpecial = gogPlat?.platformGameId ? GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId]?.lead : null;

      if (blurb && !isPlaceholderDesc(blurb, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(blurb) };
      } else if (gogSpecial && !isPlaceholderDesc(gogSpecial, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(gogSpecial) };
      } else {
        game = { ...game, shortDescription: '' };
      }
    } else if (game.shortDescription) {
      game = { ...game, shortDescription: sanitizeShortDescriptionText(game.shortDescription) };
    }

    // Systemic resolution of GOG official vertical covers from verified enriched cache
    const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
    if (!userOverride?.capsuleImage && gogPlat && gogPlat.platformGameId) {
      const enrichedGog = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
      if (enrichedGog?.coverVertical) {
        const hHash = enrichedGog.coverHorizontal ? enrichedGog.coverHorizontal.match(/\/([a-f0-9]{64})/i)?.[1] : null;
        if (
          !game.capsuleImage ||
          (hHash && game.capsuleImage.includes(hHash)) ||
          game.capsuleImage.includes('_glx_vertical_cover') ||
          isUnsuitableCoverUrl(game.capsuleImage)
        ) {
          game = {
            ...game,
            capsuleImage: enrichedGog.coverVertical,
            iconUrl: game.iconUrl || enrichedGog.coverVertical,
          };
        }
      }
    }

    // Attach verified IGDB portrait cover if game is curated in KNOWN_IGDB_COVERS, lacks vertical art, has unsuitable/cropped covers, or known dead Steam art
    const instantIgdbCover = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId || matchedAppIdForBlurb || undefined, game.id);
    if (!userOverride?.capsuleImage && instantIgdbCover) {
      const isCuratedIgdb = Boolean(
        KNOWN_IGDB_COVERS[game.title.toLowerCase().trim()] ||
        KNOWN_IGDB_COVERS[normalizeCanonicalTitle(game.title)] ||
        (game.id && KNOWN_IGDB_COVERS[game.id.toLowerCase().trim()])
      );
      if (
        isCuratedIgdb ||
        !game.capsuleImage ||
        isKnownDeadSteamCover(game.steamAppId) ||
        isUnsuitableCoverUrl(game.capsuleImage) ||
        game.capsuleImage.includes('231x87') ||
        game.capsuleImage.includes('616x353')
      ) {
        game = {
          ...game,
          capsuleImage: instantIgdbCover,
          iconUrl: game.iconUrl || instantIgdbCover,
        };
      }
    }

    // 9. Intelligent cross-store deduplication by Steam App ID and Normalized Title
    const idMatchIndex = game.id && idToIndex.has(game.id) ? idToIndex.get(game.id)! : -1;
    const candidateIndex =
      (game.steamAppId && steamIdToIndex.has(game.steamAppId)
        ? steamIdToIndex.get(game.steamAppId)
        : undefined) ??
      (normTitle && titleToIndex.has(normTitle)
        ? titleToIndex.get(normTitle)
        : undefined) ??
      (idMatchIndex >= 0 ? idMatchIndex : undefined);
    const existingIndex =
      candidateIndex !== undefined &&
      cleaned[candidateIndex] &&
      !hasSameStorefrontConflict(cleaned[candidateIndex], game)
        ? candidateIndex
        : undefined;

    if (existingIndex !== undefined && cleaned[existingIndex]) {
      // Merge platforms across duplicates
      const existing = cleaned[existingIndex];
      const existingIsParenClassic = /\s*\((?:original|classic)\)$/i.test(existing.title);
      const incomingIsParenClassic = /\s*\((?:original|classic)\)$/i.test(game.title);
      const preferIncomingEdition = existingIsParenClassic && !incomingIsParenClassic;
      const primary = preferIncomingEdition ? game : existing;
      const secondary = preferIncomingEdition ? existing : game;

      let mergedPlatforms = [...primary.platforms];
      for (const p of secondary.platforms) {
        const found = mergedPlatforms.some((ep) => ep.platformId === p.platformId);
        if (!found) {
          mergedPlatforms.push(p);
        }
      }

      if (
        mergedPlatforms.some((p) => p.platformId === 'steam') &&
        mergedPlatforms.some((p) => p.platformId !== 'steam') &&
        validSteamAppIds.size > 0
      ) {
        const steamP = mergedPlatforms.find((p) => p.platformId === 'steam');
        const resolvedAppId =
          Number(steamP?.platformGameId) || primary.steamAppId || secondary.steamAppId || 0;
        const isPhantomSteam =
          !validSteamAppIds.has(resolvedAppId) &&
          !validSteamTitles.has(normTitle) &&
          !/steamapps/i.test(steamP?.installPath || '');
        if (isPhantomSteam) {
          const nonSteamPlatforms = mergedPlatforms.filter((p) => p.platformId !== 'steam');
          if (nonSteamPlatforms.length > 0 && (steamP?.playtimeMinutes || 0) > 0) {
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

      cleaned[existingIndex] = {
        ...primary,
        steamAppId: primary.steamAppId || secondary.steamAppId,
        id: primary.steamAppId
          ? `steam-${primary.steamAppId}`
          : secondary.steamAppId
          ? `steam-${secondary.steamAppId}`
          : primary.id,
        platforms: mergedPlatforms,
        headerImage: (secondary.headerImage && (!primary.headerImage || primary.headerImage.includes('egs-badge.png') || primary.headerImage.includes('1225270') || primary.headerImage.endsWith('/3286930/header.jpg') || primary.headerImage.endsWith('/3783210/header.jpg') || primary.headerImage.endsWith('/3280350/header.jpg') || primary.headerImage.endsWith('/2149010/header.jpg') || primary.headerImage.endsWith('/3751260/header.jpg') || primary.headerImage.endsWith('/3504780/header.jpg') || primary.headerImage.endsWith('/480/header.jpg'))) ? secondary.headerImage : (primary.headerImage || secondary.headerImage),
        capsuleImage: (() => {
          const igdb = igdbCoverService.getIgdbCoverInstant(primary.title, primary.steamAppId || secondary.steamAppId, primary.id || secondary.id);
          if (igdb && (isKnownDeadSteamCover(primary.steamAppId) || isKnownDeadSteamCover(secondary.steamAppId) || isUnsuitableCoverUrl(primary.capsuleImage) || isUnsuitableCoverUrl(secondary.capsuleImage))) {
            return igdb;
          }
          if (
            secondary.capsuleImage &&
            (!primary.capsuleImage ||
              primary.capsuleImage.includes('egs-badge.png') ||
              primary.capsuleImage.includes('1225270') ||
              primary.capsuleImage.includes('231x87') ||
              isKnownDeadSteamCover(primary.steamAppId) ||
              isUnsuitableCoverUrl(primary.capsuleImage))
          ) {
            return secondary.capsuleImage;
          }
          return primary.capsuleImage || secondary.capsuleImage;
        })(),
        iconUrl: (secondary.iconUrl && (!primary.iconUrl || primary.iconUrl.includes('egs-badge.png') || primary.iconUrl.includes('1225270'))) ? secondary.iconUrl : (primary.iconUrl || secondary.iconUrl || secondary.capsuleImage),
        shortDescription: (!isPlaceholderDesc(primary.shortDescription, primary.title))
          ? sanitizeShortDescriptionText(primary.shortDescription)
          : (!isPlaceholderDesc(secondary.shortDescription, secondary.title))
          ? sanitizeShortDescriptionText(secondary.shortDescription)
          : '',
        developers: primary.developers && primary.developers.length > 0 ? primary.developers : secondary.developers,
        publishers: primary.publishers && primary.publishers.length > 0 ? primary.publishers : secondary.publishers,
        releaseDate: primary.releaseDate || secondary.releaseDate,
        isVerifiedEntitlement: primary.isVerifiedEntitlement || secondary.isVerifiedEntitlement,
        matchConfidence: primary.matchConfidence ?? secondary.matchConfidence,
        needsMatchReview: primary.needsMatchReview ?? secondary.needsMatchReview,
      };

      const existingOv = getUserOverrideForGame(existing, userOverrides);
      const effectiveOv = userOverride || existingOv;
      if (effectiveOv) {
        cleaned[existingIndex] = applyUserOverrideToGame(cleaned[existingIndex], effectiveOv);
      }

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
        const existing = cleaned[candidateIndex];
        const prevExistingId = existing.id;

        // A. Self-Heal Stale Overwritten Remastered/Enhanced Titles on Same-Storefront Pairs
        if (
          normalizeCanonicalTitle(existing.title) === normalizeCanonicalTitle(game.title) &&
          /\b(remastered|remaster|enhanced)\b/i.test(existing.title)
        ) {
          let baseTarget: CanonicalGame;
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

          const restoredTitle = baseTarget.title
            .replace(/\s*[-–—:]?\s*\b(remastered|remaster|enhanced(?:\s+edition)?)\b/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
          const collidingAppId = baseTarget.steamAppId;
          baseTarget.title = restoredTitle;
          baseTarget.sortTitle = restoredTitle.replace(/^(The|A|An)\s+/i, '');
          baseTarget.steamAppId = undefined;
          (baseTarget as any).enrichedMetadata = undefined;
          const primaryPlat = baseTarget.platforms?.[0];
          if (primaryPlat?.platformId && primaryPlat?.platformGameId) {
            baseTarget.id = `${primaryPlat.platformId}-${primaryPlat.platformGameId}`;
          }
          if (collidingAppId) {
            const appIdToken = `/steam/apps/${collidingAppId}/`;
            if (baseTarget.headerImage?.includes(appIdToken)) baseTarget.headerImage = '';
            if (baseTarget.capsuleImage?.includes(appIdToken)) baseTarget.capsuleImage = '';
            if (baseTarget.iconUrl?.includes(appIdToken)) baseTarget.iconUrl = undefined;
            const igdbRestored = igdbCoverService.getIgdbCoverInstant(
              restoredTitle,
              undefined,
              baseTarget.id
            );
            if (igdbRestored) {
              baseTarget.capsuleImage = igdbRestored;
              baseTarget.iconUrl = baseTarget.iconUrl || igdbRestored;
            }
          }
          if (baseTarget === existing) {
            titleToIndex.set(normalizeCanonicalTitle(existing.title), candidateIndex);
            if (collidingAppId && steamIdToIndex.get(collidingAppId) === candidateIndex) {
              steamIdToIndex.delete(collidingAppId);
            }
            if (prevExistingId && idToIndex.get(prevExistingId) === candidateIndex) {
              idToIndex.delete(prevExistingId);
            }
            if (existing.id) {
              idToIndex.set(existing.id, candidateIndex);
            }
          } else {
            normTitle = normalizeCanonicalTitle(game.title);
          }
        }

        // B. Disambiguate Shared steamAppId / id Between Same-Storefront Editions
        if (
          (existing.steamAppId && game.steamAppId && existing.steamAppId === game.steamAppId) ||
          existing.id === game.id
        ) {
          const sharedAppId = existing.steamAppId || game.steamAppId;
          const existingHasSteam = existing.platforms.some((p) => p.platformId === 'steam');
          const gameHasSteam = game.platforms.some((p) => p.platformId === 'steam');
          const existingHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(existing.title);
          const gameHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(game.title);

          let targetToDemote: CanonicalGame = game;
          if (existingHasSteam !== gameHasSteam) {
            targetToDemote = existingHasSteam ? game : existing;
          } else if (existingHasEdition !== gameHasEdition) {
            const steamCachedName = sharedAppId
              ? (steamEnrichedCache as Record<string, any>)[String(sharedAppId)]?.name || ''
              : '';
            const steamCacheHasEdition = steamCachedName
              ? /\b(remastered|remaster|remake|enhanced)\b/i.test(steamCachedName)
              : true;
            if (steamCacheHasEdition) {
              targetToDemote = existingHasEdition ? game : existing;
            } else {
              targetToDemote = existingHasEdition ? existing : game;
            }
          }

          const plat = targetToDemote.platforms?.[0];
          if (plat?.platformId && plat?.platformGameId) {
            const oldId = targetToDemote.id;
            targetToDemote.id = `${plat.platformId}-${plat.platformGameId}`;
            targetToDemote.steamAppId = undefined;
            if (targetToDemote === existing) {
              if (sharedAppId && steamIdToIndex.get(sharedAppId) === candidateIndex) {
                steamIdToIndex.delete(sharedAppId);
              }
              if (oldId && idToIndex.get(oldId) === candidateIndex) {
                idToIndex.delete(oldId);
              }
              idToIndex.set(existing.id, candidateIndex);
            }
          }
        }
      }

      const newIndex = cleaned.length;
      cleaned.push(game);
      if (normTitle) titleToIndex.set(normTitle, newIndex);
      if (game.steamAppId) steamIdToIndex.set(game.steamAppId, newIndex);
      if (game.id) idToIndex.set(game.id, newIndex);
    }
  }

  const finalCatalog = applyUserOverridesToCatalog(cleaned, userOverrides);

  // C. Final Strict Unique game.id & Same-Storefront Steam AppID Guarantee Pass
  const seenIds = new Set<string>();
  const seenSteamAppIds = new Map<number, CanonicalGame>();
  for (let idx = 0; idx < finalCatalog.length; idx++) {
    const g = finalCatalog[idx];
    if (g.steamAppId) {
      const prevWithAppId = seenSteamAppIds.get(g.steamAppId);
      if (prevWithAppId && hasSameStorefrontConflict(prevWithAppId, g)) {
        // Two distinct same-storefront editions still share the same steamAppId
        const prevHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(prevWithAppId.title);
        const currHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(g.title);
        // Demote the base non-Steam entry (or current entry) to its native storefront ID
        const targetToDemote =
          !prevWithAppId.platforms.some((p) => p.platformId === 'steam') &&
          prevWithAppId.platforms.length <= g.platforms.length &&
          !prevHasEdition &&
          currHasEdition
            ? prevWithAppId
            : g;
        const plat = targetToDemote.platforms?.[0];
        if (plat?.platformId && plat?.platformGameId) {
          if (targetToDemote === prevWithAppId) {
            seenIds.delete(prevWithAppId.id);
            prevWithAppId.id = `${plat.platformId}-${plat.platformGameId}`;
            prevWithAppId.steamAppId = undefined;
            seenIds.add(prevWithAppId.id);
            seenSteamAppIds.set(g.steamAppId, g);
          } else {
            g.id = `${plat.platformId}-${plat.platformGameId}`;
            g.steamAppId = undefined;
          }
        }
      } else {
        seenSteamAppIds.set(g.steamAppId, g);
      }
    }
    if (seenIds.has(g.id)) {
      const primaryPlat = g.platforms?.[0];
      const fallbackId =
        primaryPlat?.platformId && primaryPlat?.platformGameId
          ? `${primaryPlat.platformId}-${primaryPlat.platformGameId}`
          : `${g.id}-${idx}`;
      g.id = !seenIds.has(fallbackId) ? fallbackId : `${fallbackId}-${idx}`;
    }
    seenIds.add(g.id);
  }

  return finalCatalog.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
