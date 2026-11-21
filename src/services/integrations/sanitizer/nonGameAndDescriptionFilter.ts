import { CanonicalGame } from '../../../contracts/game';
import type { UserGameOverridesMap } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { getSafeLocalStorage } from '../../common/runtimeEnv';
import { LruMap } from '../../common/lruMap';
import { stripStorefrontPlatformDisambiguators } from '../../common/titleUtils';
import { stripHtmlToPlainSynopsis } from '../../steam/fallbackMetadataProvider';
import {
  getUserOverrideForGame,
  loadUserOverrides,
} from '../../storage/userOverrideStorage';
import {
  hasStructuralEpicCodenameTraits,
  KNOWN_EPIC_APP_NAMES,
  UNMAPPED_EPIC_INTERNAL_CODENAMES,
} from '../epicCodenames';

export const STORAGE_KEY_VERIFIED_ENTITLEMENTS =
  'antigravity_verified_storefront_entitlements_v1';

/**
 * Checks if a string is a 20+ hex hash or UUID.
 */
export function isHexOrGuidString(str: string): boolean {
  if (!str || str.length < 20) return false;
  const trimmed = str.trim();
  if (trimmed.length < 20) return false;
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return true;
  }
  return false;
}

const sanitizeShortDescMemo = new LruMap<string, string>(16384);

export function sanitizeShortDescriptionText(desc?: string): string {
  if (!desc) return '';
  const cached = sanitizeShortDescMemo.get(desc);
  if (cached !== undefined) return cached;
  const cleaned = stripHtmlToPlainSynopsis(desc, 360);
  sanitizeShortDescMemo.set(desc, cleaned);
  return cleaned;
}

const GENERIC_ALL_CAPS_GENRE_ACRONYMS = new Set([
  'GOTY',
  'MMORPG',
  'JRPG',
  'CRPG',
  'ARPG',
  'SRPG',
  'TRPG',
  'TTRPG',
  'DRPG',
  'MOBA',
  'FPS',
  'RTS',
  'TBS',
]);

const PUBLISHER_BLEED_SUBJECT_REGEX = /\b([A-Z][A-Z0-9]{3,})\s+is\s+an?\s+/g;
const PUBLISHER_BLEED_PREDICATE_REGEX =
  /^(?:(?!(?:in|on|at|of|for|from|with|by|to|into|aboard|within|through|across|under|over|after|before|during|without|against|the|this|that|these|those|a|an|my|your|his|her|its|our|their|where|when|which|who|whom|whose|while|is|are|was|were|has|have|had)\b)(?:\d[dD]|[a-zA-Z0-9-]+)\s+){0,3}(?:platformer|metroidvania|roguelike|roguelite|rpg|jrpg|crpg|arpg|mmorpg|shooter|brawler|visual\s+novel|sim|simulator|game|videogame|video\s+game)\b/i;

export function isPlaceholderDesc(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const trimmed = sanitizeShortDescriptionText(desc);
  if (trimmed.length <= 3) return true;
  if (/product_(?:description|feature)_\d+/i.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (title && lower === title.trim().toLowerCase()) return true;
  if (lower.includes('description is not set')) return true;
  // Require short placeholder length (< 60 chars) before treating storefront keywords as stubs,
  // preserving authentic synopses that mention DRM-free editions or storefront launches.
  if (trimmed.length < 60) {
    if (lower.includes('on gog.com')) return true;
    if (lower.includes('drm-free')) return true;
    if (lower.includes('epic games store')) return true;
    if (lower.includes('store exclusive')) return true;
    if (/^[a-z\s-]+ on gog\.com/i.test(trimmed)) return true;
  }
  if (lower.endsWith(' experience') && trimmed.split(' ').length <= 4) return true;
  if (
    /^(action|role-playing|adventure|shooter|strategy|simulation|racing|sports|indie)\s+experience$/i.test(
      trimmed
    )
  ) {
    return true;
  }
  if (lower === 'classic title') return true;
  if (/^dlcs?\s+(included|available)/i.test(trimmed)) return true;
  if (/^includes\s+(the\s+following\s+)?dlc/i.test(trimmed)) return true;
  if (/^bonus\s+content/i.test(trimmed)) return true;
  if (/^this\s+package\s+includes/i.test(trimmed)) return true;
  if (/\bis\s+a\s+[\w,\s-]+\s+title(?:\s+developed\s+by\s+.+)?\.?$/i.test(trimmed)) return true;
  if (/\bstandard\s+steam\s+catalog\s+title\b/i.test(trimmed)) return true;
  if (/\bis\s+a\s+single-player\s+title\b/i.test(trimmed)) return true;

  // Detect publisher copy-paste bleed where an unrelated ALL-CAPS title subject is defined as a game genre noun
  if (title && trimmed.includes(' is a') && title.trim()) {
    const titleLower = title.trim().toLowerCase();
    const titlePlain = titleLower.replace(/[™®©]/g, '').trim();
    const titleCompact = titlePlain.replace(/[^a-z0-9]/g, '');
    const mentionsOwnTitle =
      (titleLower.length >= 4 && lower.includes(titleLower)) ||
      (titlePlain.length >= 4 && lower.includes(titlePlain));

    if (!mentionsOwnTitle) {
      for (const bleedMatch of trimmed.matchAll(PUBLISHER_BLEED_SUBJECT_REGEX)) {
        const subject = bleedMatch[1];
        if (!subject || GENERIC_ALL_CAPS_GENRE_ACRONYMS.has(subject)) continue;
        const matchIndex = bleedMatch.index ?? 0;
        const rest = trimmed.slice(matchIndex + bleedMatch[0].length);
        if (!PUBLISHER_BLEED_PREDICATE_REGEX.test(rest)) continue;
        const subjLower = subject.toLowerCase();
        if (!titleLower.includes(subjLower) && !titleCompact.includes(subjLower)) {
          return true;
        }
      }
    }
  }

  // Reject unlocalized CJK blurbs on purely non-CJK game titles
  if (
    title &&
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(trimmed) &&
    !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(title.trim())
  ) {
    return true;
  }

  return false;
}

export const NON_GAME_CATALOG_TITLE_REGEX =
  /\b(tech beta|closed beta|open beta|public testing|playtest|test branch|alpha version|legacy mode|pre-game editor|resource archiver|digital goodies|goodies collection|goodie pack|digital comics|playable teaser|prologue|redistributables|multiplayer only|dedicated multiplayer|standalone multiplayer)\b|\bcontent$|\bdlc$|[a-z0-9]+beta$|\b(?:dedicated server|multiplayer client)$|\S+\s+multiplayer$/i;

export const STANDALONE_STOREFRONT_LAUNCHER_CLIENT_REGEX =
  /^(?:minecraft\s+launcher|ea\s+app|ubisoft\s+connect|rockstar\s+games\s+launcher|battle\.net|riot\s+client|gog\s+galaxy|epic\s+games\s+launcher)$/i;

const LIVE_SERVICE_MTX_ADDON_REGEX =
  /\b(?:v-?bucks|battle\s+pass|cosmetic\s+pack|starter\s+pack|quest\s+pack|outfit\s+pack|skin\s+pack|crew\s+pack|emote\s+pack|emotes\b|currency\s+pack|season\s+pass)\b|\s[-–—:]\s*(?:cosmetic|starter|crew|drop|quest|outfit|skin)\s*(?:pack|bundle)?$/i;

// Microsoft Store protocol PFN for the standalone launcher wrapper package (not a standalone game).
const STANDALONE_LAUNCHER_PACKAGE_PREFIX = 'microsoft.4297127d64ec6';

export function isStandaloneStorefrontLauncherClientEntry(game: CanonicalGame): boolean {
  const title = (game.title || '').trim();
  if (title && STANDALONE_STOREFRONT_LAUNCHER_CLIENT_REGEX.test(title)) {
    return true;
  }
  if (
    Array.isArray(game.platforms) &&
    game.platforms.length > 0 &&
    game.platforms.every((p) =>
      String(p?.packageFamilyName || '')
        .trim()
        .toLowerCase()
        .startsWith(STANDALONE_LAUNCHER_PACKAGE_PREFIX)
    )
  ) {
    return true;
  }
  return false;
}

export function isNonGameCatalogEntry(game: CanonicalGame): boolean {
  if (Array.isArray(game.platforms) && game.platforms.some((p) => p?.installed === true)) {
    return false;
  }
  const title = (game.title || '').trim();
  if (!title) return true;
  if (isStandaloneStorefrontLauncherClientEntry(game)) {
    return true;
  }
  if (NON_GAME_CATALOG_TITLE_REGEX.test(title)) {
    return true;
  }
  return false;
}

export function getNonGameSuppressionReason(game: CanonicalGame): string {
  const title = (game.title || '').trim();
  if (isStandaloneStorefrontLauncherClientEntry(game)) {
    return 'Tool / Editor / SDK / Redistributable';
  }
  if (
    /\b(tech beta|closed beta|open beta|public testing|playtest|test branch|legacy mode|multiplayer only|dedicated multiplayer|standalone multiplayer)\b|[a-z0-9]+beta$|\b(?:dedicated server|multiplayer client)$|\S+\s+multiplayer$/i.test(
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
    LIVE_SERVICE_MTX_ADDON_REGEX.test(title) ||
    /\bdlc$/i.test(title) ||
    game.tags?.some((t) => t.toLowerCase() === 'dlc' || t.toLowerCase() === 'add-on')
  ) {
    return 'DLC / Expansion / Add-On';
  }
  return 'Filtered as non-game / beta / trial / SDK / add-on entry';
}

export function isUnmappedEpicInternalCodename(gameOrTitle: CanonicalGame | string): boolean {
  if (typeof gameOrTitle === 'string') {
    const trimmed = gameOrTitle.trim();
    const clean = trimmed.toLowerCase();
    if (!clean || /\s/.test(trimmed)) return false;
    if (UNMAPPED_EPIC_INTERNAL_CODENAMES.has(clean)) return true;
    return /(?:staging|devbuild|qatest|internalbuild)$/i.test(trimmed);
  }
  const isEpic =
    Boolean(gameOrTitle.id?.toLowerCase().startsWith('epic-')) ||
    Boolean(gameOrTitle.platforms?.some((p) => p.platformId === 'epic'));
  const lacksStoreMetadata =
    !gameOrTitle.steamAppId &&
    (!Array.isArray(gameOrTitle.platforms) || gameOrTitle.platforms.length === 0);
  if (!isEpic && !lacksStoreMetadata) {
    return false;
  }
  return hasStructuralEpicCodenameTraits(gameOrTitle);
}

/**
 * Detects whether an item is a non-game item (microtransactions, cosmetic packs, DLC add-ons, betas, editors, prologues).
 */
export function isEpicNonGameEntry(game: CanonicalGame): boolean {
  if (Array.isArray(game.platforms) && game.platforms.some((p) => p?.installed === true)) {
    return false;
  }
  const title = (game.title || '').trim().toLowerCase();
  const id = (game.id || '').toLowerCase();

  if (isNonGameCatalogEntry(game)) {
    return true;
  }

  if (isUnmappedEpicInternalCodename(game)) {
    return true;
  }

  // Pure hex or UUID titles unless explicitly mapped
  if (isHexOrGuidString(game.title)) {
    const cleanId = id.replace(/^epic-/, '').trim();
    if (
      Object.keys(KNOWN_EPIC_APP_NAMES).length > 0 &&
      (KNOWN_EPIC_APP_NAMES[cleanId] || KNOWN_EPIC_APP_NAMES[title])
    ) {
      return false;
    }
    return true;
  }

  // Structural live-service microtransaction, battle-pass, currency, and cosmetic pack filter
  if (LIVE_SERVICE_MTX_ADDON_REGEX.test(game.title || '')) {
    return true;
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
  const hasDlcOnlyTag = game.tags?.some(
    (t) => t.toLowerCase() === 'dlc' || t.toLowerCase() === 'add-on'
  );
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

const normalizeCanonicalTitleMemo = new LruMap<string, string>(32768);

export const STOREFRONT_BONUS_SUFFIX_REGEX =
  /\s*\+\s*(?:official\s+)?(?:walkthrough|strategy\s+guide|guide|artbook|digital\s+artbook|ost|soundtrack)$/i;

/**
 * Normalizes title for robust cross-storefront game deduplication.
 * Preserves distinct remake/remaster/enhanced/definitive/classic/gold editions while normalizing
 * packaging/DLC bundle suffixes across storefronts.
 */
export function normalizeCanonicalTitle(title: string): string {
  if (!title) return '';
  const cached = normalizeCanonicalTitleMemo.get(title);
  if (cached !== undefined) return cached;

  const result = stripStorefrontPlatformDisambiguators(title)
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’ʼ`]/g, '')
    .replace(STOREFRONT_BONUS_SUFFIX_REGEX, '')
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

  normalizeCanonicalTitleMemo.set(title, result);
  return result;
}

/**
 * Prevents collapsing two distinct game entitlements that belong to the SAME storefront.
 */
export function hasSameStorefrontConflict(
  existing: CanonicalGame,
  incoming: CanonicalGame
): boolean {
  if (existing.steamAppId && incoming.steamAppId && existing.steamAppId !== incoming.steamAppId) {
    return true;
  }
  const existingPlatforms = existing.platforms || [];
  const incomingPlatforms = incoming.platforms || [];
  for (const ep of existingPlatforms) {
    if (!ep?.platformId) continue;
    const platIdLower = String(ep.platformId).toLowerCase();
    const matchingIncoming = incomingPlatforms.filter(
      (p) => p?.platformId && String(p.platformId).toLowerCase() === platIdLower
    );
    if (matchingIncoming.length === 0) continue;

    if (platIdLower === 'xbox') {
      const epGameId = String(ep.platformGameId || '').trim().toLowerCase();
      const epProductId = String(ep.xboxProductId || '').trim().toLowerCase();
      const epIds = [epGameId, epProductId].filter(Boolean);
      if (epIds.length === 0) continue;

      const anyCompatible = matchingIncoming.some((ip) => {
        const ipGameId = String(ip.platformGameId || '').trim().toLowerCase();
        const ipProductId = String(ip.xboxProductId || '').trim().toLowerCase();
        const ipIds = [ipGameId, ipProductId].filter(Boolean);
        if (ipIds.length === 0) return true;
        if (epProductId && ipProductId && epProductId !== ipProductId) {
          return false;
        }
        return epIds.some((id) => ipIds.includes(id));
      });
      if (!anyCompatible) {
        return true;
      }
      continue;
    }

    const epId = String(ep.platformGameId || '').trim();
    if (!epId) continue;
    const anyCompatible = matchingIncoming.some((ip) => {
      const ipId = String(ip.platformGameId || '').trim();
      return !ipId || ipId === epId;
    });
    if (!anyCompatible) {
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

/**
 * Blacklist of non-game SDK test AppIDs (e.g. Spacewar 480, Steamworks Common Redistributables 228980).
 */
export const UNOWNED_STEAM_PROMO_APP_IDS = new Set<number>([480, 228980]);

/**
 * Universal detector for synthetic mock or unowned test identifiers.
 */
export function isMockOrUnownedIdentifier(gameId?: string, platformGameId?: string): boolean {
  const gid = (gameId || '').trim().toLowerCase();
  const pid = (platformGameId || '').trim().toLowerCase();
  return /^(mock|unowned)-/.test(gid) || /^(mock|unowned)-/.test(pid);
}

export interface VerifiedEntitlementSets {
  steam: Set<number>;
  gog: Set<string>;
  epic: Set<string>;
  xbox: Set<string>;
}

export function loadVerifiedEntitlementsFromStorage(): VerifiedEntitlementSets {
  const result: VerifiedEntitlementSets = {
    steam: new Set<number>(),
    gog: new Set<string>(),
    epic: new Set<string>(),
    xbox: new Set<string>(),
  };
  try {
    const storage = getSafeLocalStorage();
    if (!storage) return result;
    const raw = storage.getItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as Partial<Record<StorefrontId, unknown>>;
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
