import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import { KNOWN_EPIC_APP_NAMES, UNMAPPED_EPIC_INTERNAL_CODENAMES } from './epicCodenames';
import { GOG_USER_LIBRARY } from '../storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import {
  igdbCoverService,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
  isUnsuitableHeaderUrl,
  KNOWN_IGDB_COVERS,
} from '../igdb/igdbCoverService';
import { steamMatcher } from '../steam/steamMatcher';
import steamBlurbCache from '../storage/steamBlurbCache.json';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
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
} from '../steam/steamApi';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
  loadHiddenStorefrontEntries,
  isStorefrontEntryHidden,
  isNonGameStorefrontEntryRestored,
} from '../storage/userOverrideStorage';
import type { UserGameOverridesMap } from '../../contracts/override';

export const STORAGE_KEY_SUPPRESSED_ENTRIES = 'universal_game_library_suppressed_entries_v1';

export interface SuppressedCatalogEntry {
  id: string;
  rawTitle: string;
  platformId: StorefrontId;
  platformGameId: string;
  reason: string;
  reasonCategory:
    | 'non_game_filter'
    | 'unverified_entitlement'
    | 'duplicate_conflict'
    | 'score_suppressed'
    | 'user_hidden';
  rawGame: CanonicalGame;
}

const lastSuppressedEntries = new Map<string, SuppressedCatalogEntry>();
let hasWrittenSuppressedToStorage = false;

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {}
  return null;
}

function syncSuppressedEntriesWithStorage(): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY_SUPPRESSED_ENTRIES);
    if (!raw) {
      if (hasWrittenSuppressedToStorage) {
        // Storage was explicitly cleared (e.g. in test beforeEach)
        lastSuppressedEntries.clear();
        hasWrittenSuppressedToStorage = false;
      }
      return;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (
          entry &&
          entry.id &&
          entry.reasonCategory !== 'user_hidden' &&
          !isNonGameStorefrontEntryRestored(entry.platformId, entry.platformGameId, entry.id)
        ) {
          const mapKey =
            entry.platformId && entry.platformGameId
              ? `${entry.platformId}:${entry.platformGameId}`
              : entry.id;
          if (!lastSuppressedEntries.has(mapKey) && !lastSuppressedEntries.has(entry.id)) {
            lastSuppressedEntries.set(mapKey, entry);
          }
        }
      }
    }
  } catch {}
}

function persistSuppressedEntriesToStorage(): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    const toPersist = Array.from(lastSuppressedEntries.values()).filter(
      (e) =>
        e &&
        e.reasonCategory !== 'user_hidden' &&
        !isNonGameStorefrontEntryRestored(e.platformId, e.platformGameId, e.id)
    );
    storage.setItem(STORAGE_KEY_SUPPRESSED_ENTRIES, JSON.stringify(toPersist));
    hasWrittenSuppressedToStorage = true;
  } catch {}
}

export function getSuppressedCatalogEntries(): SuppressedCatalogEntry[] {
  syncSuppressedEntriesWithStorage();

  const combined = new Map<string, SuppressedCatalogEntry>();
  for (const [k, entry] of lastSuppressedEntries.entries()) {
    if (!entry) continue;
    if (
      entry.reasonCategory !== 'user_hidden' &&
      isNonGameStorefrontEntryRestored(entry.platformId, entry.platformGameId, entry.id)
    ) {
      continue;
    }
    if (
      entry.reasonCategory === 'user_hidden' &&
      !isStorefrontEntryHidden(entry.platformId, entry.platformGameId, entry.id)
    ) {
      continue;
    }
    combined.set(k, entry);
  }

  const hiddenMap = loadHiddenStorefrontEntries();
  for (const h of Object.values(hiddenMap)) {
    if (!h) continue;
    const entryId =
      h.rawGameSnapshot?.id || h.gameId || `${h.platformId}-${h.platformGameId}`;
    const mapKey = `${h.platformId}:${h.platformGameId}`;
    // If an entry was both auto-filtered and explicitly user-hidden, user_hidden takes precedence
    for (const [existingKey, existingVal] of combined.entries()) {
      if (
        existingVal.id === entryId ||
        (existingVal.platformId === h.platformId &&
          String(existingVal.platformGameId) === String(h.platformGameId))
      ) {
        combined.delete(existingKey);
      }
    }
    combined.set(mapKey, {
      id: entryId,
      rawTitle: h.rawTitle || h.rawGameSnapshot?.title || entryId,
      platformId: h.platformId,
      platformGameId: String(h.platformGameId),
      reason: h.reason || 'Hidden / Suppressed by User',
      reasonCategory: 'user_hidden',
      rawGame: h.rawGameSnapshot,
    });
  }
  return Array.from(combined.values());
}

export function registerSuppressedCatalogEntries(entries: SuppressedCatalogEntry[]): void {
  if (!Array.isArray(entries)) return;
  syncSuppressedEntriesWithStorage();
  for (const entry of entries) {
    if (entry && entry.id) {
      const mapKey =
        entry.platformId && entry.platformGameId
          ? `${entry.platformId}:${entry.platformGameId}`
          : entry.id;
      lastSuppressedEntries.set(mapKey, entry);
    }
  }
  persistSuppressedEntriesToStorage();
}

/**
 * Checks if a string is a 20+ hex hash or UUID
 */
export function isHexOrGuidString(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  // 20+ character hexadecimal hash
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return true;
  // Standard UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  return false;
}

export function sanitizeShortDescriptionText(desc?: string): string {
  if (!desc) return '';
  return stripHtmlToPlainSynopsis(desc, 360);
}

export function isPlaceholderDesc(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const trimmed = sanitizeShortDescriptionText(desc);
  if (trimmed.length <= 3) return true;
  if (/product_(?:description|feature)_\d+/i.test(trimmed)) return true;
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
  if (/\bis\s+a\s+[\w,\s-]+\s+title(?:\s+developed\s+by\s+.+)?\.?$/i.test(trimmed)) return true;
  if (/\bstandard\s+steam\s+catalog\s+title\b/i.test(trimmed)) return true;
  if (/\bis\s+a\s+single-player\s+title\b/i.test(trimmed)) return true;

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
  /\b(tech beta|closed beta|open beta|public testing|playtest|test branch|alpha version|legacy mode|pre-game editor|resource archiver|digital goodies|goodies collection|goodie pack|digital comics|playable teaser|prologue|redistributables)\b|\bcontent$|\bdlc$|killingfloor2beta|^sin multiplayer$/i;

export function isNonGameCatalogEntry(game: CanonicalGame): boolean {
  const title = (game.title || '').trim();
  if (!title) return true;
  if (NON_GAME_CATALOG_TITLE_REGEX.test(title)) {
    return true;
  }
  return false;
}

export function getNonGameSuppressionReason(game: CanonicalGame): string {
  const title = (game.title || '').trim();
  const lower = title.toLowerCase();
  if (
    /\b(tech beta|closed beta|open beta|public testing|playtest|test branch|legacy mode)\b|killingfloor2beta|^sin multiplayer$/i.test(
      title
    )
  ) {
    return 'Beta / Test Branch / Legacy Client';
  }
  if (/\b(playable teaser|prologue|alpha version)\b/i.test(title)) {
    return 'Prologue / Playable Teaser / Alpha';
  }
  if (
    /\b(pre-game editor|resource archiver|redistributables|starter content|unreal engine|megascans)\b/i.test(
      title
    )
  ) {
    return 'Tool / Editor / SDK / Redistributable';
  }
  if (
    /\b(digital goodies|goodies collection|goodie pack|digital comics|soundtrack|ost|art\s*book|bonus content|wallpaper)\b|\bcontent$/i.test(
      title
    )
  ) {
    return 'Digital Soundtrack / Artbook / Extra';
  }
  if (
    lower.includes('fortnite') ||
    /\bdlc$/i.test(title) ||
    game.tags?.some((t) => t.toLowerCase() === 'dlc' || t.toLowerCase() === 'add-on')
  ) {
    return 'DLC / Expansion / Add-On';
  }
  return 'Filtered as non-game / beta / trial / SDK / add-on entry';
}

/**
 * Detects whether an item is a non-game item (Fortnite microtransactions, DLC packs, add-on assets, betas, editors, prologues)
 */
export function isEpicNonGameEntry(game: CanonicalGame): boolean {
  const title = (game.title || '').trim().toLowerCase();
  const id = (game.id || '').toLowerCase();

  if (isNonGameCatalogEntry(game)) {
    return true;
  }

  // Unmapped internal Epic project codenames
  if (UNMAPPED_EPIC_INTERNAL_CODENAMES.has(title)) {
    return true;
  }

  // Pure hex or UUID titles unless explicitly mapped in KNOWN_EPIC_APP_NAMES
  if (isHexOrGuidString(game.title)) {
    const cleanId = id.replace(/^epic-/, '').trim();
    if (KNOWN_EPIC_APP_NAMES[cleanId] || KNOWN_EPIC_APP_NAMES[title]) {
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

/**
 * Prevents auto-merging a storefront entitlement that was explicitly split/unmerged by the user
 * (splitFromMerged: true) or routed to a distinct user-override title.
 */
export function hasSplitOverrideConflict(
  g1: CanonicalGame,
  g2: CanonicalGame,
  userOverrides?: UserGameOverridesMap
): boolean {
  if (
    Array.isArray(g1.platforms) &&
    Array.isArray(g2.platforms) &&
    g1.platforms.length === 1 &&
    g2.platforms.length === 1 &&
    g1.platforms[0].platformId === g2.platforms[0].platformId &&
    String(g1.platforms[0].platformGameId || '').trim() !== '' &&
    String(g1.platforms[0].platformGameId || '').trim() ===
      String(g2.platforms[0].platformGameId || '').trim()
  ) {
    return false;
  }

  const overrides = userOverrides ?? loadUserOverrides();
  if (!overrides || Object.keys(overrides).length === 0) return false;

  const ov1 = getUserOverrideForGame(g1, overrides);
  const ov2 = getUserOverrideForGame(g2, overrides);

  if (!ov1?.splitFromMerged && !ov2?.splitFromMerged) {
    if (
      ov1?.title &&
      ov2?.title &&
      normalizeCanonicalTitle(ov1.title) !== normalizeCanonicalTitle(ov2.title)
    ) {
      return true;
    }
    return false;
  }

  if (ov1 && ov2) {
    if (
      typeof ov1.steamAppId === 'number' &&
      ov1.steamAppId > 0 &&
      ov1.steamAppId === ov2.steamAppId
    ) {
      return false;
    }
    if (
      ov1.matchedStore &&
      ov1.matchedId !== undefined &&
      ov1.matchedStore === ov2.matchedStore &&
      String(ov1.matchedId) === String(ov2.matchedId)
    ) {
      return false;
    }
  }

  return true;
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

const STORAGE_KEY_VERIFIED_ENTITLEMENTS = 'antigravity_verified_storefront_entitlements_v1';

/**
 * Universal detector for synthetic mock or unowned test identifiers.
 */
export function isMockOrUnownedIdentifier(gameId?: string, platformGameId?: string): boolean {
  const gid = (gameId || '').trim().toLowerCase();
  const pid = (platformGameId || '').trim().toLowerCase();
  return /^(mock|unowned)-/.test(gid) || /^(mock|unowned)-/.test(pid);
}

function loadVerifiedEntitlementsFromStorage(): {
  steam: Set<number>;
  gog: Set<string>;
  epic: Set<string>;
  xbox: Set<string>;
} {
  const result = {
    steam: new Set<number>(),
    gog: new Set<string>(),
    epic: new Set<string>(),
    xbox: new Set<string>(),
  };
  try {
    const storage =
      (typeof localStorage !== 'undefined' && localStorage) ||
      (typeof window !== 'undefined' && window.localStorage) ||
      null;
    if (!storage) return result;
    const raw = storage.getItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    if (!raw) return result;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.steam)) {
      for (const id of parsed.steam) {
        if (typeof id === 'number' && id > 0) result.steam.add(id);
      }
    }
    if (Array.isArray(parsed?.gog)) {
      for (const s of parsed.gog) {
        if (typeof s === 'string' && s) result.gog.add(s.trim().toLowerCase());
      }
    }
    if (Array.isArray(parsed?.epic)) {
      for (const s of parsed.epic) {
        if (typeof s === 'string' && s) result.epic.add(s.trim().toLowerCase());
      }
    }
    if (Array.isArray(parsed?.xbox)) {
      for (const s of parsed.xbox) {
        if (typeof s === 'string' && s) result.xbox.add(s.trim().toLowerCase());
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return result;
}

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
  optionsOrOverrides?: { allowNewPurchases?: boolean; validSteamAppIds?: Set<number> } | Record<string, any>,
  maybeOptions?: { allowNewPurchases?: boolean; validSteamAppIds?: Set<number> }
): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];

  // Refresh user-hidden entries while preserving previously discovered non-game / suppressed entries from storage
  for (const [k, v] of lastSuppressedEntries.entries()) {
    if (v.reasonCategory === 'user_hidden') {
      lastSuppressedEntries.delete(k);
    }
  }
  syncSuppressedEntriesWithStorage();

  const recordSuppressedEntry = (
    rawGame: CanonicalGame,
    reason: string,
    reasonCategory: SuppressedCatalogEntry['reasonCategory'],
    specificPlat?: { platformId: StorefrontId; platformGameId: string }
  ) => {
    const plat =
      specificPlat ||
      rawGame.platforms?.[0] ||
      ({ platformId: 'steam' as StorefrontId, platformGameId: rawGame.id });
    if (isMockOrUnownedIdentifier(rawGame.id, plat.platformGameId)) {
      return;
    }
    const key =
      plat.platformId && plat.platformGameId
        ? `${plat.platformId}:${plat.platformGameId}`
        : rawGame.id || `${plat.platformId}:${plat.platformGameId}`;
    lastSuppressedEntries.set(key, {
      id: rawGame.id || `${plat.platformId}-${plat.platformGameId}`,
      rawTitle:
        rawGame.originalStoreTitle ||
        rawGame.platforms?.[0]?.originalTitle ||
        rawGame.title,
      platformId: plat.platformId,
      platformGameId: String(plat.platformGameId || rawGame.id),
      reason,
      reasonCategory,
      rawGame,
    });
  };

  const options =
    maybeOptions ??
    (optionsOrOverrides &&
    ('allowNewPurchases' in optionsOrOverrides || 'validSteamAppIds' in optionsOrOverrides)
      ? (optionsOrOverrides as { allowNewPurchases?: boolean; validSteamAppIds?: Set<number> })
      : undefined);
  const explicitValidSteamAppIds =
    options?.validSteamAppIds instanceof Set ? options.validSteamAppIds : undefined;
  const verifiedEntitlements = loadVerifiedEntitlementsFromStorage();
  const userOverrides = loadUserOverrides();
  const cleaned: CanonicalGame[] = [];
  const titleToIndex = new Map<string, number>();
  const steamIdToIndex = new Map<number, number>();
  const idToIndex = new Map<string, number>();

  // Pre-pass: Unmerge/split individual platforms that have an explicit splitFromMerged override
  const expandedCatalog: CanonicalGame[] = [];
  for (const rawItem of catalog) {
    if (!rawItem || !rawItem.title) continue;
    if (Array.isArray(rawItem.platforms) && rawItem.platforms.length > 1) {
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
              normalizeCanonicalTitle(pOv.title) !==
                normalizeCanonicalTitle(rawItem.title)
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
            sortTitle: splitPlatRawTitle.replace(/^(The|A|An)\s+/i, '').trim(),
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
            sortTitle: remainingTitle.replace(/^(The|A|An)\s+/i, '').trim(),
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
      rawGame.originalStoreTitle ||
      rawGame.platforms?.[0]?.originalTitle ||
      rawGame.title;

    let game: CanonicalGame = {
      ...rawGame,
      originalStoreTitle: rawSourceTitle,
      platforms: Array.isArray(rawGame.platforms)
        ? rawGame.platforms.map((p) => ({
            ...p,
            originalTitle: p.originalTitle || rawSourceTitle,
          }))
        : [],
    };

    // Enforce user-hidden storefront entries
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
          recordSuppressedEntry(
            hiddenSnap,
            'Hidden / Suppressed by User',
            'user_hidden',
            { platformId: p.platformId, platformGameId: String(p.platformGameId || game.id) }
          );
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
      recordSuppressedEntry(game, 'Hidden / Suppressed by User', 'user_hidden');
      continue;
    }

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

    // Look up userOverride and restored non-game flag early so explicitly restored/overridden items bypass non-game filters
    let userOverride = getUserOverrideForGame(game, userOverrides);
    const isRestoredNonGame =
      game.platforms.some((p) =>
        isNonGameStorefrontEntryRestored(p.platformId, p.platformGameId, game.id)
      ) || isNonGameStorefrontEntryRestored(undefined, undefined, game.id);

    // 2. Filter out junk, pure hex hashes, Fortnite DLC, and unmapped codenames
    if (isEpicNonGameEntry(game)) {
      if (!userOverride && !isRestoredNonGame) {
        recordSuppressedEntry(
          game,
          getNonGameSuppressionReason(game),
          'non_game_filter'
        );
        continue;
      }
    }

    const currentTitleLower = game.title.toLowerCase().trim();
    let normTitle = normalizeCanonicalTitle(game.title);
    if (UNMAPPED_EPIC_INTERNAL_CODENAMES.has(currentTitleLower)) {
      if (!userOverride && !isRestoredNonGame) {
        recordSuppressedEntry(
          game,
          getNonGameSuppressionReason(game),
          'non_game_filter'
        );
        continue;
      }
    }

    // Curated game patches declarative lookup
    const patch = findGamePatch(game, currentTitleLower, normTitle);
    if (patch) {
      game = applyCatalogPatch(game, patch);
      if (game.platforms.length === 0) continue;
      normTitle = normalizeCanonicalTitle(game.title);
    }

    // Curated user override lookup (explicit user intent takes highest priority)
    if (!userOverride) {
      userOverride = getUserOverrideForGame(game, userOverrides);
    }
    if (userOverride) {
      game = applyUserOverrideToGame(game, userOverride);
      normTitle = normalizeCanonicalTitle(game.title);
    }

    const isAuthenticNew =
      isRestoredNonGame ||
      game.isVerifiedEntitlement === true ||
      options?.allowNewPurchases === true ||
      game.platforms.some((p) => p.installed === true);

    // 6. Purge false GOG platform presence from unowned GOG titles (e.g. old bestselling catalog items like Anno 1404)
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
          isRestoredNonGame ||
          isAuthenticNew ||
          isVerifiedGogDynamic ||
          validGogProductIds.size === 0 ||
          (gogIdTrimmed && validGogProductIds.has(gogIdTrimmed)) ||
          validGogTitles.has(normTitle) ||
          validGogTitles.has(normalizeCanonicalTitle(rawGame.title)));

      if (isVerifiedGogDynamic && !isMockOrUnownedGog) {
        game.isVerifiedEntitlement = true;
      }

      if (!isRealGogGame) {
        recordSuppressedEntry(
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

    // 7. Purge false Epic platform presence from unowned Epic titles, DLCs, codenames, and non-games
    if (game.platforms.some((p) => p.platformId === 'epic')) {
      const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
      const epicGameId = (epicPlatform?.platformGameId || '').trim().toLowerCase();

      // If title is not recognized, but catalog ID matches a verified base game, re-assign to real base game
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
              ? { ...p, platformGameId: epicGameId, originalTitle: p.originalTitle || rawSourceTitle }
              : { ...p, originalTitle: p.originalTitle || rawSourceTitle }
          ),
        };
      }

      const updatedNormTitle = normalizeCanonicalTitle(game.title);
      const isNonGameEpic = !userOverride && !isRestoredNonGame && isEpicNonGameEntry(game);
      const isMockOrInvalidEpic =
        isMockOrUnownedIdentifier(game.id, epicPlatform?.platformGameId) || isNonGameEpic;
      const isVerifiedEpicDynamic =
        (epicGameId && verifiedEntitlements.epic.has(epicGameId)) ||
        verifiedEntitlements.epic.has(updatedNormTitle) ||
        verifiedEntitlements.epic.has(normalizeCanonicalTitle(rawGame.title));
      // Whitelist: every authentic Epic game must match one of the verified titles or be an authentic new purchase
      const isRealEpicGame =
        !isMockOrInvalidEpic &&
        (userOverride !== undefined ||
          isRestoredNonGame ||
          isAuthenticNew ||
          isVerifiedEpicDynamic ||
          validEpicTitles.size === 0 ||
          (epicGameId && validEpicCatalogIds.has(epicGameId)) ||
          validEpicTitles.has(updatedNormTitle) ||
          validEpicTitles.has(normalizeCanonicalTitle(rawGame.title)));

      if (isVerifiedEpicDynamic && !isMockOrInvalidEpic) {
        game.isVerifiedEntitlement = true;
      }

      if (!isRealEpicGame) {
        recordSuppressedEntry(
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
      const appId =
        game.steamAppId ||
        (steamPlatform?.platformGameId && !isNaN(Number(steamPlatform.platformGameId))
          ? Number(steamPlatform.platformGameId)
          : undefined);

      const isUnownedPromo =
        !isRestoredNonGame && !userOverride && appId
          ? UNOWNED_STEAM_PROMO_APP_IDS.has(appId)
          : false;
      const isMockOrUnownedSteam = isMockOrUnownedIdentifier(game.id, steamPlatform?.platformGameId);
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
          /[/\\](?:epic|gog|legendary|heroic)[/\\]/i.test(steamPlatform.installPath)
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
          userOverride?.matchedStore === 'steam' ||
          isAuthenticNew ||
          hasRealSteamappsPath;
      } else {
        isRealSteamGame = true;
      }

      if (isVerifiedSteamDynamic && isRealSteamGame) {
        game.isVerifiedEntitlement = true;
      }

      if (isUnownedPromo || !isRealSteamGame) {
        recordSuppressedEntry(
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

    // Purge any cached localization placeholder tokens, HTML tags in shortDescription, or regional non-English movies from enrichedMetadata
    if (game.enrichedMetadata) {
      const hasPlaceholderShort = isPlaceholderDesc(game.enrichedMetadata.shortDescription, game.title);
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
            detailedDescription: isPlaceholderDesc(cleanedDetailed, game.title) ? '' : cleanedDetailed,
            movies: filteredMovies,
            ...(hasSteamLangPlaceholderOnNonSteam ? { supportedLanguages: undefined } : {}),
          },
        };
      }
    }

    if (!userOverride?.shortDescription && isPlaceholderDesc(game.shortDescription, game.title)) {
      const blurb = matchedAppIdForBlurb
        ? (steamBlurbCache as Record<string, string>)[String(matchedAppIdForBlurb)]
        : null;
      const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
      const gogSpecial = gogPlat?.platformGameId
        ? GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId]?.lead
        : null;
      const gogEnrichedEntry = gogPlat?.platformGameId
        ? (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId]
        : null;
      const gogEnrichedDesc =
        gogEnrichedEntry?.shortDescription || gogEnrichedEntry?.description || null;
      const enrichedShort = game.enrichedMetadata?.shortDescription || null;

      const extractPlainFirstPara = (rawHtml?: string): string | null => {
        if (!rawHtml) return null;
        return extractFirstParagraph(rawHtml, 300);
      };

      const detailedFallback = extractPlainFirstPara(
        game.enrichedMetadata?.aboutTheGame ||
          game.enrichedMetadata?.detailedDescription ||
          game.detailedDescription
      );

      if (blurb && !isPlaceholderDesc(blurb, game.title)) {
        game = { ...game, shortDescription: sanitizeShortDescriptionText(blurb) };
      } else if (gogSpecial && !isPlaceholderDesc(gogSpecial, game.title)) {
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
        /when you buy this game\b|will be added to your gog\.com account/i.test(game.shortDescription)
          ? extractFirstParagraph(game.shortDescription) ||
            sanitizeShortDescriptionText(game.shortDescription.replace(/<[^>]+>/g, ' '))
          : sanitizeShortDescriptionText(game.shortDescription);
      game = { ...game, shortDescription: cleanedShort };
    }

    if ((!game.developers || game.developers.length === 0) && game.enrichedMetadata?.developers?.length) {
      const validDevs = game.enrichedMetadata.developers.filter(
        (d) => d && d !== 'Unknown Developer'
      );
      if (validDevs.length > 0) {
        game = { ...game, developers: validDevs };
      }
    }

    if (
      (!game.releaseDate || game.releaseDate === 'TBA') &&
      game.enrichedMetadata?.releaseDate &&
      game.enrichedMetadata.releaseDate !== 'TBA'
    ) {
      game = { ...game, releaseDate: game.enrichedMetadata.releaseDate };
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
      !hasSameStorefrontConflict(cleaned[candidateIndex], game) &&
      !hasSplitOverrideConflict(cleaned[candidateIndex], game, userOverrides)
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

      let mergedPlatforms = primary.platforms.map((ep) => {
        const secMatch = secondary.platforms.find((sp) => sp.platformId === ep.platformId);
        return {
          ...ep,
          originalTitle:
            ep.originalTitle ||
            secMatch?.originalTitle ||
            primary.originalStoreTitle ||
            primary.title,
        };
      });
      for (const p of secondary.platforms) {
        const found = mergedPlatforms.some((ep) => ep.platformId === p.platformId);
        if (!found) {
          mergedPlatforms.push({
            ...p,
            originalTitle:
              p.originalTitle ||
              secondary.originalStoreTitle ||
              secondary.title,
          });
        }
      }

      if (
        mergedPlatforms.some((p) => p.platformId === 'steam') &&
        mergedPlatforms.some((p) => p.platformId !== 'steam')
      ) {
        const steamP = mergedPlatforms.find((p) => p.platformId === 'steam');
        const resolvedAppId =
          Number(steamP?.platformGameId) || primary.steamAppId || secondary.steamAppId || 0;
        const hasNonSteamPathOnSteam = Boolean(
          steamP?.installPath &&
            /[/\\](?:epic|gog|legendary|heroic)[/\\]/i.test(steamP.installPath)
        );
        const isPhantomSteam =
          hasNonSteamPathOnSteam ||
          (explicitValidSteamAppIds !== undefined &&
            !explicitValidSteamAppIds.has(resolvedAppId) &&
            !/steamapps/i.test(steamP?.installPath || ''));
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
        headerImage:
          secondary.headerImage && isUnsuitableHeaderUrl(primary.headerImage)
            ? secondary.headerImage
            : primary.headerImage || secondary.headerImage,
        capsuleImage: (() => {
          const igdb = igdbCoverService.getIgdbCoverInstant(
            primary.title,
            primary.steamAppId || secondary.steamAppId,
            primary.id || secondary.id
          );
          if (
            igdb &&
            (isKnownDeadSteamCover(primary.steamAppId) ||
              isKnownDeadSteamCover(secondary.steamAppId) ||
              isUnsuitableCoverUrl(primary.capsuleImage) ||
              isUnsuitableCoverUrl(secondary.capsuleImage))
          ) {
            return igdb;
          }
          if (
            secondary.capsuleImage &&
            (isKnownDeadSteamCover(primary.steamAppId) || isUnsuitableCoverUrl(primary.capsuleImage))
          ) {
            return secondary.capsuleImage;
          }
          return primary.capsuleImage || secondary.capsuleImage;
        })(),
        iconUrl:
          secondary.iconUrl && isUnsuitableHeaderUrl(primary.iconUrl)
            ? secondary.iconUrl
            : primary.iconUrl || secondary.iconUrl || secondary.capsuleImage,
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

  // Remove any previously suppressed entries that are now present in finalCatalog (because they were restored or overridden)
  if (lastSuppressedEntries.size > 0) {
    const activePlatformKeys = new Set<string>();
    for (const g of finalCatalog) {
      if (g.id) activePlatformKeys.add(g.id);
      for (const p of g.platforms || []) {
        if (p.platformId && p.platformGameId) {
          activePlatformKeys.add(`${p.platformId}:${p.platformGameId}`);
          activePlatformKeys.add(`${p.platformId}-${p.platformGameId}`);
        }
      }
    }
    for (const [k, entry] of lastSuppressedEntries.entries()) {
      if (
        entry.reasonCategory !== 'user_hidden' &&
        (activePlatformKeys.has(k) ||
          activePlatformKeys.has(entry.id) ||
          activePlatformKeys.has(`${entry.platformId}:${entry.platformGameId}`) ||
          activePlatformKeys.has(`${entry.platformId}-${entry.platformGameId}`))
      ) {
        lastSuppressedEntries.delete(k);
      }
    }
  }
  persistSuppressedEntriesToStorage();

  return finalCatalog.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
