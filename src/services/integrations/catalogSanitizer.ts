import {
  CanonicalGame,
  ChainedHandoffTopology,
  GamePlatformOwnership,
} from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import {
  isMicrosoftStoreCdnUrl,
  sanitizeStoreReleaseDate,
  stripStorefrontPlatformDisambiguators,
} from '../common/titleUtils';
import {
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
  pickPreferredHeaderImage,
  pickPreferredReleaseDate,
} from '../storage/librarySync';
import {
  hasStructuralEpicCodenameTraits,
  KNOWN_EPIC_APP_NAMES,
  UNMAPPED_EPIC_INTERNAL_CODENAMES,
} from './epicCodenames';
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
  steamApi,
} from '../steam/steamApi';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
  loadHiddenStorefrontEntries,
  isStorefrontEntryHidden,
  isNonGameStorefrontEntryRestored,
  getReadonlyRestoredNonGameKeys,
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
  suppressedAt?: number | string;
  rawGame: CanonicalGame;
}

interface PersistedSuppressedCatalogEntry {
  id: string;
  store: StorefrontId;
  platformId: StorefrontId;
  platformGameId: string;
  rawTitle: string;
  reason: string;
  reasonCategory: SuppressedCatalogEntry['reasonCategory'];
  suppressedAt: number;
}

interface GogEnrichedCacheItem {
  shortDescription?: string;
  description?: string;
  coverVertical?: string;
  coverHorizontal?: string;
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
  worksOn?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
    Windows?: boolean;
    Mac?: boolean;
    Linux?: boolean;
  };
}

interface SteamEnrichedCacheItem {
  name?: string;
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
}

export function buildMinimalSuppressedGameStub(params: {
  id: string;
  rawTitle?: string;
  platformId?: StorefrontId;
  platformGameId?: string | number;
}): CanonicalGame {
  const platId = params.platformId || 'steam';
  const platGameId =
    params.platformGameId !== undefined &&
    params.platformGameId !== null &&
    String(params.platformGameId).trim() !== ''
      ? String(params.platformGameId).trim()
      : String(params.id || '').trim();
  const title = (params.rawTitle || params.id || platGameId || 'Unknown Title').trim() || 'Unknown Title';
  const sortTitle = title.replace(/^(The|A|An)\s+/i, '').trim() || title;
  return {
    id: params.id || `${platId}-${platGameId}`,
    title,
    sortTitle,
    originalStoreTitle: title,
    platforms: [
      {
        platformId: platId,
        platformGameId: platGameId,
        installed: false,
        originalTitle: title,
      },
    ],
    headerImage: '',
    developers: [],
    publishers: [],
    genres: [],
    tags: [],
  };
}

export function ensureSuppressedEntryRawGame(
  entry?: Partial<SuppressedCatalogEntry> & { id?: string }
): SuppressedCatalogEntry {
  const platformId = (entry?.platformId || 'steam') as StorefrontId;
  const platformGameId =
    entry?.platformGameId !== undefined &&
    entry?.platformGameId !== null &&
    String(entry.platformGameId).trim() !== ''
      ? String(entry.platformGameId).trim()
      : String(entry?.id || '').trim();
  const id =
    String(entry?.id || (platformId && platformGameId ? `${platformId}-${platformGameId}` : '')).trim() ||
    `suppressed-${Date.now()}`;
  const rawTitle =
    (entry?.rawTitle || entry?.rawGame?.title || id || 'Unknown Title').trim() ||
    'Unknown Title';

  let rawGame: CanonicalGame;
  if (entry?.rawGame && typeof entry.rawGame === 'object' && entry.rawGame.id) {
    const rawPlats = Array.isArray(entry.rawGame.platforms) ? entry.rawGame.platforms : [];
    const validPlatforms = rawPlats
      .filter((p): p is GamePlatformOwnership => Boolean(p && typeof p === 'object'))
      .map((p) => ({
        ...p,
        platformId: (p.platformId || platformId) as StorefrontId,
        platformGameId:
          p.platformGameId !== undefined && p.platformGameId !== null && String(p.platformGameId).trim() !== ''
            ? String(p.platformGameId).trim()
            : platformGameId,
        installed: Boolean(p.installed),
        originalTitle: (p.originalTitle || rawTitle).trim() || rawTitle,
      }));

    const platforms =
      validPlatforms.length > 0
        ? validPlatforms
        : [
            {
              platformId,
              platformGameId,
              installed: false,
              originalTitle: rawTitle,
            },
          ];

    rawGame = {
      ...entry.rawGame,
      id: entry.rawGame.id || id,
      title: (entry.rawGame.title || rawTitle).trim() || 'Unknown Title',
      sortTitle:
        (entry.rawGame.sortTitle || entry.rawGame.title || rawTitle)
          .replace(/^(The|A|An)\s+/i, '')
          .trim() || rawTitle,
      originalStoreTitle: entry.rawGame.originalStoreTitle || rawTitle,
      platforms,
      headerImage: typeof entry.rawGame.headerImage === 'string' ? entry.rawGame.headerImage : '',
      developers: Array.isArray(entry.rawGame.developers) ? entry.rawGame.developers : [],
      publishers: Array.isArray(entry.rawGame.publishers) ? entry.rawGame.publishers : [],
      genres: Array.isArray(entry.rawGame.genres) ? entry.rawGame.genres : [],
      tags: Array.isArray(entry.rawGame.tags) ? entry.rawGame.tags : [],
    };
  } else {
    rawGame = buildMinimalSuppressedGameStub({
      id,
      rawTitle,
      platformId,
      platformGameId,
    });
  }

  return {
    id,
    rawTitle,
    platformId,
    platformGameId,
    reason: entry?.reason || 'Filtered as non-game entry',
    reasonCategory: entry?.reasonCategory || 'non_game_filter',
    suppressedAt: typeof entry?.suppressedAt === 'number' ? entry.suppressedAt : Date.now(),
    rawGame,
  };
}

const lastSuppressedEntries = new Map<string, SuppressedCatalogEntry>();
let hasWrittenSuppressedToStorage = false;
let suppressedMapVersion = 0;

let cachedSuppressedStorageRef: Storage | null = null;
let cachedSuppressedRaw: string | null = null;
let cachedSuppressedRestoredRef: ReadonlySet<string> | null = null;
let inMemorySuppressedHydrated = false;
let suppressedStorageListenerAttached = false;

let cachedSuppressedSnapshot: SuppressedCatalogEntry[] | null = null;
let cachedSnapshotMapVersion = -1;
let cachedSnapshotHiddenRef: Record<string, unknown> | null = null;
let cachedSnapshotRestoredRef: ReadonlySet<string> | null = null;

function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean(process.env?.VITEST || process.env?.NODE_ENV === 'test')
    );
  } catch {
    return false;
  }
}

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {}
  return null;
}

function ensureSuppressedStorageListener(): void {
  if (suppressedStorageListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  suppressedStorageListenerAttached = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY_SUPPRESSED_ENTRIES) {
      inMemorySuppressedHydrated = false;
      cachedSuppressedRaw = null;
    }
  });
}

function addSecondaryIndexKey(index: Map<string, Set<string>>, lookupKey: string, mapKey: string): void {
  if (!lookupKey) return;
  let bucket = index.get(lookupKey);
  if (!bucket) {
    bucket = new Set<string>();
    index.set(lookupKey, bucket);
  }
  bucket.add(mapKey);
}

function syncSuppressedEntriesWithStorage(): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  ensureSuppressedStorageListener();
  const restoredRef = getReadonlyRestoredNonGameKeys();

  if (
    !isTestEnv() &&
    inMemorySuppressedHydrated &&
    storage === cachedSuppressedStorageRef &&
    restoredRef === cachedSuppressedRestoredRef
  ) {
    return;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY_SUPPRESSED_ENTRIES);
    if (!raw) {
      if (hasWrittenSuppressedToStorage || cachedSuppressedRaw !== null) {
        // Storage was explicitly cleared (e.g. in test beforeEach)
        if (lastSuppressedEntries.size > 0) {
          lastSuppressedEntries.clear();
          suppressedMapVersion++;
        }
        hasWrittenSuppressedToStorage = false;
      }
      cachedSuppressedStorageRef = storage;
      cachedSuppressedRaw = null;
      cachedSuppressedRestoredRef = restoredRef;
      inMemorySuppressedHydrated = true;
      return;
    }

    if (
      inMemorySuppressedHydrated &&
      storage === cachedSuppressedStorageRef &&
      raw === cachedSuppressedRaw &&
      restoredRef === cachedSuppressedRestoredRef
    ) {
      // Adopt Blink ExternalString pointer to eliminate O(N) cross-representation string comparisons
      cachedSuppressedRaw = raw;
      return;
    }

    const parsed: unknown = JSON.parse(raw);
    let sawLegacyRawGameBloat = false;
    let mutatedMap = false;
    if (Array.isArray(parsed)) {
      for (const rawItem of parsed) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const entry = rawItem as Partial<SuppressedCatalogEntry> & {
          store?: StorefrontId;
        };
        if ('rawGame' in entry && entry.rawGame !== undefined) {
          sawLegacyRawGameBloat = true;
        }
        const platformId = (entry.platformId || entry.store || 'steam') as StorefrontId;
        const platformGameId = String(entry.platformGameId || entry.id || '');
        if (
          entry.id &&
          entry.reasonCategory &&
          entry.reasonCategory !== 'user_hidden' &&
          !isNonGameStorefrontEntryRestored(platformId, platformGameId, entry.id)
        ) {
          const mapKey =
            platformId && platformGameId ? `${platformId}:${platformGameId}` : entry.id;
          if (!lastSuppressedEntries.has(mapKey) && !lastSuppressedEntries.has(entry.id)) {
            const rawTitle = entry.rawTitle || entry.rawGame?.title || entry.id;
            lastSuppressedEntries.set(
              mapKey,
              ensureSuppressedEntryRawGame({
                id: entry.id,
                rawTitle,
                platformId,
                platformGameId,
                reason: entry.reason,
                reasonCategory: entry.reasonCategory,
                suppressedAt: entry.suppressedAt,
                rawGame: entry.rawGame,
              })
            );
            mutatedMap = true;
          }
        }
      }
      if (mutatedMap) {
        suppressedMapVersion++;
      }
      cachedSuppressedStorageRef = storage;
      cachedSuppressedRaw = raw;
      cachedSuppressedRestoredRef = restoredRef;
      inMemorySuppressedHydrated = true;
      if (sawLegacyRawGameBloat) {
        persistSuppressedEntriesToStorage();
      }
    }
  } catch {}
}

function persistSuppressedEntriesToStorage(): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  ensureSuppressedStorageListener();
  try {
    const toPersist: PersistedSuppressedCatalogEntry[] = Array.from(
      lastSuppressedEntries.values()
    )
      .filter(
        (e) =>
          e &&
          e.reasonCategory !== 'user_hidden' &&
          !isNonGameStorefrontEntryRestored(e.platformId, e.platformGameId, e.id)
      )
      .map((e) => ({
        id: e.id,
        store: e.platformId,
        platformId: e.platformId,
        platformGameId:
          e.platformGameId !== undefined &&
          e.platformGameId !== null &&
          String(e.platformGameId) !== ''
            ? String(e.platformGameId)
            : String(e.id || ''),
        rawTitle: e.rawTitle,
        reason: e.reason,
        reasonCategory: e.reasonCategory,
        suppressedAt: typeof e.suppressedAt === 'number' ? e.suppressedAt : Date.now(),
      }));
    const serialized = JSON.stringify(toPersist);
    storage.setItem(STORAGE_KEY_SUPPRESSED_ENTRIES, serialized);
    hasWrittenSuppressedToStorage = true;
    cachedSuppressedStorageRef = storage;
    cachedSuppressedRaw = isTestEnv() ? serialized : null;
    cachedSuppressedRestoredRef = getReadonlyRestoredNonGameKeys();
    inMemorySuppressedHydrated = true;
  } catch {}
}

export function clearSuppressedCatalogEntries(): void {
  if (lastSuppressedEntries.size > 0) {
    lastSuppressedEntries.clear();
    suppressedMapVersion++;
  }
  hasWrittenSuppressedToStorage = false;
  cachedSuppressedRaw = null;
  cachedSuppressedSnapshot = null;
  inMemorySuppressedHydrated = true;
  const storage = getSafeLocalStorage();
  if (storage) {
    try {
      storage.removeItem(STORAGE_KEY_SUPPRESSED_ENTRIES);
    } catch {}
    cachedSuppressedStorageRef = storage;
  }
}

export function getSuppressedCatalogEntries(): SuppressedCatalogEntry[] {
  syncSuppressedEntriesWithStorage();

  const hiddenMap = loadHiddenStorefrontEntries();
  const restoredRef = getReadonlyRestoredNonGameKeys();

  if (
    cachedSuppressedSnapshot !== null &&
    cachedSnapshotMapVersion === suppressedMapVersion &&
    cachedSnapshotHiddenRef === hiddenMap &&
    cachedSnapshotRestoredRef === restoredRef
  ) {
    return cachedSuppressedSnapshot;
  }

  const combined = new Map<string, SuppressedCatalogEntry>();
  const byId = new Map<string, Set<string>>();
  const byPlatKey = new Map<string, Set<string>>();

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
    const sanitizedEntry = ensureSuppressedEntryRawGame(entry);
    combined.set(k, sanitizedEntry);
    addSecondaryIndexKey(byId, sanitizedEntry.id, k);
    if (sanitizedEntry.platformId && sanitizedEntry.platformGameId !== undefined) {
      addSecondaryIndexKey(
        byPlatKey,
        `${sanitizedEntry.platformId}:${String(sanitizedEntry.platformGameId)}`,
        k
      );
    }
  }

  for (const h of Object.values(hiddenMap)) {
    if (!h) continue;
    const entryId =
      h.rawGameSnapshot?.id || h.gameId || `${h.platformId}-${h.platformGameId}`;
    const platLookupKey = `${h.platformId}:${String(h.platformGameId)}`;
    const mapKey = platLookupKey;

    // O(1) precedence override: remove any auto-filtered entry matching entryId or platformId:platformGameId
    const idMatches = byId.get(entryId);
    if (idMatches) {
      for (const existingKey of idMatches) {
        combined.delete(existingKey);
      }
      byId.delete(entryId);
    }
    const platMatches = byPlatKey.get(platLookupKey);
    if (platMatches) {
      for (const existingKey of platMatches) {
        combined.delete(existingKey);
      }
      byPlatKey.delete(platLookupKey);
    }

    const rawTitle = h.rawTitle || h.rawGameSnapshot?.title || entryId;
    const hiddenSuppressedEntry = ensureSuppressedEntryRawGame({
      id: entryId,
      rawTitle,
      platformId: h.platformId,
      platformGameId: String(h.platformGameId),
      reason: h.reason || 'Hidden / Suppressed by User',
      reasonCategory: 'user_hidden',
      suppressedAt: h.hiddenAt,
      rawGame: h.rawGameSnapshot,
    });
    combined.set(mapKey, hiddenSuppressedEntry);
    addSecondaryIndexKey(byId, entryId, mapKey);
    addSecondaryIndexKey(byPlatKey, platLookupKey, mapKey);
  }

  const snapshot = Array.from(combined.values());
  cachedSuppressedSnapshot = snapshot;
  cachedSnapshotMapVersion = suppressedMapVersion;
  cachedSnapshotHiddenRef = hiddenMap;
  cachedSnapshotRestoredRef = restoredRef;
  return snapshot;
}

export function registerSuppressedCatalogEntries(entries: SuppressedCatalogEntry[]): void {
  if (!Array.isArray(entries)) return;
  syncSuppressedEntriesWithStorage();
  let mutated = false;
  for (const entry of entries) {
    if (entry && entry.id) {
      const normalizedEntry = ensureSuppressedEntryRawGame(entry);
      if (
        normalizedEntry.reasonCategory !== 'user_hidden' &&
        isNonGameStorefrontEntryRestored(
          normalizedEntry.platformId,
          normalizedEntry.platformGameId,
          normalizedEntry.id
        )
      ) {
        continue;
      }
      const mapKey =
        normalizedEntry.platformId && normalizedEntry.platformGameId
          ? `${normalizedEntry.platformId}:${normalizedEntry.platformGameId}`
          : normalizedEntry.id;
      const existing = lastSuppressedEntries.get(mapKey);
      const upgradesStubWithArtwork =
        Boolean(normalizedEntry.rawGame.capsuleImage || normalizedEntry.rawGame.headerImage) &&
        !existing?.rawGame?.capsuleImage &&
        !existing?.rawGame?.headerImage;
      if (
        !existing ||
        !existing.rawGame ||
        upgradesStubWithArtwork ||
        existing.id !== normalizedEntry.id ||
        existing.rawTitle !== normalizedEntry.rawTitle ||
        existing.reason !== normalizedEntry.reason ||
        existing.reasonCategory !== normalizedEntry.reasonCategory
      ) {
        lastSuppressedEntries.set(mapKey, normalizedEntry);
        mutated = true;
      }
    }
  }
  if (mutated) {
    suppressedMapVersion++;
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('antigravity:suppressed-entries-updated'));
      } catch {}
    }
    persistSuppressedEntriesToStorage();
  }
}

/**
 * Checks if a string is a 20+ hex hash or UUID
 */
export function isHexOrGuidString(str: string): boolean {
  if (!str || str.length < 20) return false;
  const trimmed = str.trim();
  if (trimmed.length < 20) return false;
  // 20+ character hexadecimal hash
  if (/^[0-9a-f]{20,}$/i.test(trimmed)) return true;
  // Standard UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  return false;
}

const MAX_SHORT_DESC_MEMO_ENTRIES = 16384;
const sanitizeShortDescMemo = new Map<string, string>();

export function sanitizeShortDescriptionText(desc?: string): string {
  if (!desc) return '';
  const cached = sanitizeShortDescMemo.get(desc);
  if (cached !== undefined) return cached;
  const cleaned = stripHtmlToPlainSynopsis(desc, 360);
  if (sanitizeShortDescMemo.size >= MAX_SHORT_DESC_MEMO_ENTRIES) {
    const oldest = sanitizeShortDescMemo.keys().next().value;
    if (oldest !== undefined) sanitizeShortDescMemo.delete(oldest);
  }
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

  // Detect publisher copy-paste bleed where an unrelated ALL-CAPS title subject is defined as a video game / game genre noun
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

  // Reject unlocalized CJK blurbs on purely non-CJK game titles (e.g. Japanese store blurb on English strategy title)
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

function isStandaloneStorefrontLauncherClientEntry(game: CanonicalGame): boolean {
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
        .startsWith('microsoft.4297127d64ec6')
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
  const lower = title.toLowerCase();
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
    lower.includes('fortnite') ||
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
 * Detects whether an item is a non-game item (Fortnite microtransactions, DLC packs, add-on assets, betas, editors, prologues)
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

  // Unmapped internal Epic project codenames
  if (isUnmappedEpicInternalCodename(game)) {
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

const MAX_CANONICAL_TITLE_MEMO_ENTRIES = 32768;
const normalizeCanonicalTitleMemo = new Map<string, string>();

const STOREFRONT_BONUS_SUFFIX_REGEX =
  /\s*\+\s*(?:official\s+)?(?:walkthrough|strategy\s+guide|guide|artbook|digital\s+artbook|ost|soundtrack)$/i;

/**
 * Normalizes title for robust cross-storefront game deduplication
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

  if (normalizeCanonicalTitleMemo.size >= MAX_CANONICAL_TITLE_MEMO_ENTRIES) {
    const oldest = normalizeCanonicalTitleMemo.keys().next().value;
    if (oldest !== undefined) normalizeCanonicalTitleMemo.delete(oldest);
  }
  normalizeCanonicalTitleMemo.set(title, result);
  return result;
}

/**
 * Prevents collapsing two distinct game entitlements that belong to the SAME storefront
 * (e.g. Base Edition vs Enhanced Edition on Steam, Original vs Remastered Edition on GOG,
 * or Legacy Edition vs Gen9 Enhanced Edition on Epic).
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
// Eagerly warm static Steam matcher and browse-asset caches at module load so first catalog pass never pays cold index cost
steamMatcher.peekCachedMatch('__warmup__');
steamApi.peekCachedBrowseAssets(1);

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
 * Repairs impossible or poisoned per-storefront OS flags persisted in older catalog caches:
 * - Xbox PC Store / PC Game Pass entries always support Windows and never ship native macOS apps
 *   unless explicitly marked `isCrossPlatformLauncherRuntime === true` (e.g., Minecraft Launcher).
 * - Windows-only chained publisher storefronts (`ubisoft`, `ea`, `rockstar`, `riot`) always support
 *   Windows and never ship native macOS binaries via PC Game Pass / publisher handoff.
 * - Corrupt all-false `platforms` objects (`{ windows: false, mac: false, linux: false }`, such as
 *   incomplete GOG `worksOn` payloads) are repaired to `{ windows: true, mac: false, linux: false }`.
 */
export type NormalizedChainedHandoffId = 'ea' | 'ubisoft' | 'bnet' | 'rockstar' | 'riot';

const WINDOWS_ONLY_CHAINED_HANDOFFS = new Set<NormalizedChainedHandoffId>([
  'ea',
  'ubisoft',
  'rockstar',
  'riot',
]);

export const EA_DRM_BACKGROUND_REQUIRED_RE =
  /\b(?:EA\s+app|Origin(?:\s+client)?)\s+software\s+installation\s+and\s+background\s+use\s+required/i;

export const KERNEL_ANTICHEAT_DRM_RE =
  /\b(EA\s+Javelin(?:\s+Anticheat)?|EA\s+Anti-?Cheat|Easy\s*Anti-?Cheat|BattlEye|Vanguard)\b/i;

function normalizeDrmNoticePlainText(raw?: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&#8209;|&#8211;/gi, '-')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes publisher launcher / PartnerLink / URI handoff tokens into canonical
 * One Launcher publisher handoff IDs (`'ea' | 'ubisoft' | 'bnet' | 'rockstar' | 'riot'`).
 */
export function normalizeChainedHandoffId(
  raw?: unknown
): NormalizedChainedHandoffId | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('link2ea') ||
    lower.startsWith('origin2:') ||
    lower.startsWith('origin:') ||
    lower.startsWith('eadm:')
  ) {
    return 'ea';
  }
  if (lower.startsWith('uplay:')) return 'ubisoft';
  if (lower.startsWith('battlenet:')) return 'bnet';

  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (
    compact === 'ea' ||
    compact === 'eaapp' ||
    compact === 'theeaapp' ||
    compact === 'eadesktop' ||
    compact === 'eaplay' ||
    compact === 'electronicarts' ||
    compact === 'origin' ||
    compact === 'originclient' ||
    compact === 'theoriginclient' ||
    compact === 'link2ea'
  ) {
    return 'ea';
  }
  if (
    compact === 'ubisoft' ||
    compact === 'ubisoftconnect' ||
    compact === 'theubisoftconnect' ||
    compact === 'uplay' ||
    compact === 'ubisoftgamelauncher'
  ) {
    return 'ubisoft';
  }
  if (
    compact === 'bnet' ||
    compact === 'battlenet' ||
    compact === 'blizzard' ||
    compact === 'blizzardbattlenet'
  ) {
    return 'bnet';
  }
  if (
    compact === 'rockstar' ||
    compact === 'rockstargames' ||
    compact === 'rockstarlauncher' ||
    compact === 'rockstargameslauncher'
  ) {
    return 'rockstar';
  }
  if (compact === 'riot' || compact === 'riotgames' || compact === 'riotclient') {
    return 'riot';
  }

  if (/\b(?:ea\s*app|origin(?:\s+client)?|electronic\s+arts|link2ea|ea\s+desktop|ea\s+play)\b/i.test(trimmed)) {
    return 'ea';
  }
  if (/\b(?:ubisoft(?:\s+connect)?|uplay)\b/i.test(trimmed)) {
    return 'ubisoft';
  }
  if (/\b(?:battle\.?net|blizzard)\b/i.test(trimmed)) {
    return 'bnet';
  }
  if (/\brockstar(?:\s+games)?(?:\s+launcher)?\b/i.test(trimmed)) {
    return 'rockstar';
  }
  if (/\briot(?:\s+client|\s+games)?\b/i.test(trimmed)) {
    return 'riot';
  }

  return undefined;
}

/**
 * Maps a normalized publisher handoff ID (`'ea' | 'ubisoft' | 'bnet' | 'rockstar' | 'riot'`)
 * to its canonical user-facing publisher launcher display name.
 */
export function mapChainedHandoffIdToExternalLauncher(
  handoffId?: unknown
): string | undefined {
  const canonical = normalizeChainedHandoffId(handoffId);
  switch (canonical) {
    case 'ea':
      return 'EA App';
    case 'ubisoft':
      return 'Ubisoft Connect';
    case 'bnet':
      return 'Battle.net';
    case 'rockstar':
      return 'Rockstar Games Launcher';
    case 'riot':
      return 'Riot Client';
    default:
      return undefined;
  }
}

export type StructuralKernelAntiCheatCategory =
  | 'ring0_hard_block'
  | 'battleye_multiplayer_only'
  | 'kernel_advisory';

/**
 * Resolves canonical display naming for verified Windows kernel-level anti-cheat engines
 * without any per-game title or store ID hardcoding.
 */
export function resolveCanonicalKernelAntiCheatDisplayName(
  raw?: string | null
): string | undefined {
  const plain = normalizeDrmNoticePlainText(raw);
  if (!plain) return undefined;
  if (/\b(?:ea\s*anticheat|ea\s*javelin|ea\s+anti-?cheat)\b/i.test(plain)) {
    return 'EA Javelin Anti-Cheat';
  }
  if (/\b(?:ricochet\s*anti[- ]?cheat|randgrid)\b/i.test(plain)) {
    return 'RICOCHET Anti-Cheat';
  }
  if (/\b(?:riot\s*vanguard|vgk\.sys|\bvanguard\b)\b/i.test(plain)) {
    return 'Riot Vanguard';
  }
  if (/\bbattleye\b/i.test(plain)) {
    return 'BattlEye';
  }
  if (/\beasy\s*anti-?cheat\b/i.test(plain)) {
    return 'Easy Anti-Cheat';
  }
  return undefined;
}

export function isRing0HardBlockKernelAntiCheat(antiCheatName?: string | null): boolean {
  const canonical = resolveCanonicalKernelAntiCheatDisplayName(antiCheatName);
  return (
    canonical === 'EA Javelin Anti-Cheat' ||
    canonical === 'RICOCHET Anti-Cheat' ||
    canonical === 'Riot Vanguard'
  );
}

export function isBattlEyeKernelAntiCheat(antiCheatName?: string | null): boolean {
  return resolveCanonicalKernelAntiCheatDisplayName(antiCheatName) === 'BattlEye';
}

/**
 * Structurally detects Windows kernel-level anti-cheat requirements across official
 * storefront DRM notices, third-party capability strings, and compatibility annotations.
 */
export function detectStructuralKernelAntiCheatFromNotices(
  ...notices: Array<string | null | undefined>
): {
  requiresKernelAntiCheat: true;
  kernelAntiCheatName: string;
  category: StructuralKernelAntiCheatCategory;
} | null {
  const combined = notices
    .map((n) => normalizeDrmNoticePlainText(n))
    .filter(Boolean)
    .join(' | ');
  if (!combined) return null;

  if (/\b(?:ea\s*anticheat|ea\s*javelin|ea\s+anti-?cheat)\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'EA Javelin Anti-Cheat',
      category: 'ring0_hard_block',
    };
  }
  if (/\b(?:ricochet\s*anti[- ]?cheat|randgrid)\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'RICOCHET Anti-Cheat',
      category: 'ring0_hard_block',
    };
  }
  if (/\b(?:riot\s*vanguard|vgk\.sys|\bvanguard\b)\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Riot Vanguard',
      category: 'ring0_hard_block',
    };
  }
  if (/\bbattleye\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'BattlEye',
      category: 'battleye_multiplayer_only',
    };
  }
  if (/\beasy\s*anti-?cheat\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Easy Anti-Cheat',
      category: 'kernel_advisory',
    };
  }
  return null;
}

/**
 * Structurally detects kernel-level anti-cheat requirements from storefront DRM notices.
 */
export function detectKernelAntiCheatFromNotice(
  drmNotice?: string | null
): { requiresKernelAntiCheat: true; antiCheatName: string } | null {
  const plain = normalizeDrmNoticePlainText(drmNotice);
  if (!plain) return null;
  const match = plain.match(KERNEL_ANTICHEAT_DRM_RE);
  if (!match) return null;
  const token = match[1];
  let antiCheatName = token;
  if (/ea\s+javelin/i.test(token)) {
    antiCheatName = 'EA Javelin Anticheat';
  } else if (/ea\s+anti-?cheat/i.test(token)) {
    antiCheatName = 'EA Anti-Cheat';
  } else if (/easy\s*anti-?cheat/i.test(token)) {
    antiCheatName = 'Easy Anti-Cheat';
  } else if (/battleye/i.test(token)) {
    antiCheatName = 'BattlEye';
  } else if (/vanguard/i.test(token)) {
    antiCheatName = 'Vanguard';
  } else {
    const structural = detectStructuralKernelAntiCheatFromNotices(plain);
    if (structural) {
      antiCheatName = structural.kernelAntiCheatName;
    }
  }
  return {
    requiresKernelAntiCheat: true,
    antiCheatName,
  };
}

function resolveDefaultChainedTopology(
  platformId: StorefrontId | 'riot'
): ChainedHandoffTopology | undefined {
  if (platformId === 'xbox') return 'publisher_managed';
  if (platformId === 'epic') return 'partner_launcher_link';
  if (platformId === 'steam') return 'storefront_depot_uri';
  return undefined;
}

export function sanitizePlatformOwnershipOsFlags(
  entry: GamePlatformOwnership
): GamePlatformOwnership {
  if (!entry || typeof entry !== 'object') return entry;
  const pid = entry.platformId as StorefrontId | 'riot';

  let normalizedEntry = entry;
  const rawHandoff =
    entry.chainedLauncherHandoff ||
    entry.externalStorefrontHandoff ||
    entry.externalLauncher;
  const canonicalHandoff = normalizeChainedHandoffId(rawHandoff);
  if (canonicalHandoff && canonicalHandoff !== pid) {
    const defaultTopology =
      entry.chainedHandoffTopology || resolveDefaultChainedTopology(pid);
    const mappedExternalLauncher =
      entry.externalLauncher || mapChainedHandoffIdToExternalLauncher(canonicalHandoff);
    if (
      entry.chainedLauncherHandoff !== canonicalHandoff ||
      entry.externalStorefrontHandoff !== canonicalHandoff ||
      (defaultTopology && !entry.chainedHandoffTopology) ||
      (mappedExternalLauncher && !entry.externalLauncher)
    ) {
      normalizedEntry = {
        ...normalizedEntry,
        chainedLauncherHandoff: canonicalHandoff,
        externalStorefrontHandoff: canonicalHandoff,
        ...(defaultTopology && !entry.chainedHandoffTopology
          ? { chainedHandoffTopology: defaultTopology }
          : {}),
        ...(mappedExternalLauncher && !entry.externalLauncher
          ? { externalLauncher: mappedExternalLauncher }
          : {}),
      };
    }
  } else if (
    (entry.chainedLauncherHandoff || entry.externalStorefrontHandoff) &&
    typeof rawHandoff === 'string'
  ) {
    const trimmed = rawHandoff.trim();
    if (
      trimmed &&
      trimmed.toLowerCase() !== String(pid).toLowerCase() &&
      (!entry.chainedLauncherHandoff || !entry.externalStorefrontHandoff)
    ) {
      normalizedEntry = {
        ...normalizedEntry,
        chainedLauncherHandoff: entry.chainedLauncherHandoff || trimmed,
        externalStorefrontHandoff: (entry.externalStorefrontHandoff || trimmed) as
          | StorefrontId
          | 'riot',
      };
    }
  }

  const rawPlat = normalizedEntry.platforms;
  const activeHandoff = normalizeChainedHandoffId(
    normalizedEntry.chainedLauncherHandoff || normalizedEntry.externalStorefrontHandoff
  );
  const hasWindowsOnlyChainedHandoff = Boolean(
    activeHandoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(activeHandoff)
  );

  if (pid === 'xbox') {
    const allowMac =
      !normalizedEntry.externalStorefrontHandoff &&
      !normalizedEntry.chainedLauncherHandoff &&
      normalizedEntry.xboxBottleCompatibilityTier !== 'tier_b_legacy_uwp' &&
      normalizedEntry.xboxBottleCompatibilityTier !== 'tier_c_external_launcher' &&
      normalizedEntry.xboxBottleCompatibilityTier !== 'tier_c_kernel_anticheat' &&
      normalizedEntry.isWindowsBinaryOnMac !== true &&
      (normalizedEntry.isCrossPlatformLauncherRuntime === true ||
        (normalizedEntry.isCrossPlatformLauncherRuntime !== false &&
          !normalizedEntry.packageFamilyName &&
          !normalizedEntry.appUserModelId &&
          Boolean(
            rawPlat &&
              typeof rawPlat === 'object' &&
              !Array.isArray(rawPlat) &&
              rawPlat.windows === true &&
              rawPlat.mac === true &&
              rawPlat.linux === true
          )));
    const needsPlatEnforcement =
      (rawPlat &&
        typeof rawPlat === 'object' &&
        !Array.isArray(rawPlat) &&
        (rawPlat.windows !== true || Boolean(rawPlat.mac) !== allowMac)) ||
      (!rawPlat && Boolean(activeHandoff || hasWindowsOnlyChainedHandoff));
    if (needsPlatEnforcement) {
      return {
        ...normalizedEntry,
        platforms: {
          windows: true,
          mac: allowMac,
          linux: allowMac && rawPlat ? Boolean(rawPlat.linux) : false,
        },
      };
    }
    return normalizedEntry;
  }

  if (pid === 'epic' && hasWindowsOnlyChainedHandoff) {
    if (
      !rawPlat ||
      typeof rawPlat !== 'object' ||
      Array.isArray(rawPlat) ||
      rawPlat.windows !== true ||
      rawPlat.mac !== false
    ) {
      return {
        ...normalizedEntry,
        platforms: {
          windows: true,
          mac: false,
          linux: false,
        },
      };
    }
    return normalizedEntry;
  }

  if (pid === 'ubisoft' || pid === 'ea' || pid === 'rockstar' || pid === 'riot') {
    if (
      rawPlat &&
      typeof rawPlat === 'object' &&
      !Array.isArray(rawPlat) &&
      (rawPlat.windows !== true || rawPlat.mac === true)
    ) {
      return {
        ...normalizedEntry,
        platforms: {
          windows: true,
          mac: false,
          linux: Boolean(rawPlat.linux),
        },
      };
    }
    return normalizedEntry;
  }

  if (
    rawPlat &&
    typeof rawPlat === 'object' &&
    !Array.isArray(rawPlat) &&
    !rawPlat.windows &&
    !rawPlat.mac &&
    !rawPlat.linux
  ) {
    return {
      ...normalizedEntry,
      platforms: {
        windows: true,
        mac: false,
        linux: false,
      },
    };
  }

  return normalizedEntry;
}

/**
 * Merges two per-storefront ownership entries for the same `platformId` without stripping
 * chained publisher handoff, compatibility reason/stub flags, size metadata, or kernel
 * anti-cheat descriptors.
 */
export function mergePlatformEntry(
  ep: GamePlatformOwnership,
  secMatch?: GamePlatformOwnership,
  fallbackOriginalTitle?: string
): GamePlatformOwnership {
  const epHasActiveSub =
    ep.ownershipType === 'owned_and_subscription' ||
    (ep.ownershipType === 'subscription' && !ep.subscriptionExpired);
  const secHasActiveSub = Boolean(
    secMatch &&
      (secMatch.ownershipType === 'owned_and_subscription' ||
        (secMatch.ownershipType === 'subscription' && !secMatch.subscriptionExpired))
  );
  const hasPermanentOwned =
    ep.ownershipType === 'owned' ||
    ep.ownershipType === 'owned_and_subscription' ||
    secMatch?.ownershipType === 'owned' ||
    secMatch?.ownershipType === 'owned_and_subscription';
  const hasAnySubscription =
    ep.ownershipType === 'subscription' || secMatch?.ownershipType === 'subscription';

  const mergedOwnershipType =
    hasPermanentOwned && (epHasActiveSub || secHasActiveSub)
      ? 'owned_and_subscription'
      : hasPermanentOwned
      ? 'owned'
      : epHasActiveSub || secHasActiveSub || hasAnySubscription
      ? 'subscription'
      : ep.ownershipType || secMatch?.ownershipType;
  const isPermanentOwnership =
    mergedOwnershipType === 'owned' || mergedOwnershipType === 'owned_and_subscription';
  const mergedSubscriptionExpired = isPermanentOwnership
    ? false
    : epHasActiveSub || secHasActiveSub
    ? ep.subscriptionExpired === false || secMatch?.subscriptionExpired === false
      ? false
      : undefined
    : ep.subscriptionExpired ?? secMatch?.subscriptionExpired;

  const activeEp = epHasActiveSub ? ep : undefined;
  const activeSec = secHasActiveSub ? secMatch : undefined;
  const mergedGamePassTier =
    mergedOwnershipType === 'owned'
      ? undefined
      : activeEp?.gamePassTier ||
        activeSec?.gamePassTier ||
        (mergedOwnershipType === 'subscription'
          ? ep.gamePassTier || secMatch?.gamePassTier
          : undefined);
  const mergedIsLeavingSoon =
    mergedOwnershipType === 'owned' || mergedSubscriptionExpired
      ? undefined
      : activeEp?.isLeavingSoon ?? activeSec?.isLeavingSoon;
  const mergedIsRecentlyAdded =
    mergedOwnershipType === 'owned' || mergedSubscriptionExpired
      ? undefined
      : activeEp?.isRecentlyAddedToGamePass ?? activeSec?.isRecentlyAddedToGamePass;
  const mergedCrossPlatformLauncher =
    ep.isCrossPlatformLauncherRuntime ?? secMatch?.isCrossPlatformLauncherRuntime;

  const mergedExternalLauncher = ep.externalLauncher || secMatch?.externalLauncher;
  const mergedExternalLauncherUrl =
    ep.externalLauncherUrl || secMatch?.externalLauncherUrl;
  const mergedXboxCompatReason =
    ep.xboxBottleCompatibilityReason || secMatch?.xboxBottleCompatibilityReason;
  const mergedStubPkg =
    ep.isExternalLauncherStubPackage ?? secMatch?.isExternalLauncherStubPackage;
  const mergedMaxDownloadBytes =
    ep.maxDownloadSizeBytes ?? secMatch?.maxDownloadSizeBytes;
  const mergedPcMaxInstallBytes =
    ep.pcMaxInstallSizeBytes ?? secMatch?.pcMaxInstallSizeBytes;
  const mergedInstallSize = ep.installSize ?? secMatch?.installSize;
  const mergedKernelAntiCheatName =
    ep.kernelAntiCheatName || secMatch?.kernelAntiCheatName;

  return sanitizePlatformOwnershipOsFlags({
    ...ep,
    platforms: ep.platforms || secMatch?.platforms,
    storefrontAppId: ep.storefrontAppId || secMatch?.storefrontAppId,
    namespace: ep.namespace || secMatch?.namespace,
    catalogItemId: ep.catalogItemId || secMatch?.catalogItemId,
    ...(ep.xboxProductId || secMatch?.xboxProductId
      ? { xboxProductId: ep.xboxProductId || secMatch?.xboxProductId }
      : {}),
    ...(ep.packageFamilyName || secMatch?.packageFamilyName
      ? { packageFamilyName: ep.packageFamilyName || secMatch?.packageFamilyName }
      : {}),
    ...(ep.appUserModelId || secMatch?.appUserModelId
      ? { appUserModelId: ep.appUserModelId || secMatch?.appUserModelId }
      : {}),
    ...(ep.xboxTitleId || secMatch?.xboxTitleId
      ? { xboxTitleId: ep.xboxTitleId || secMatch?.xboxTitleId }
      : {}),
    ...(ep.scid || secMatch?.scid ? { scid: ep.scid || secMatch?.scid } : {}),
    ...(ep.msaAppId || secMatch?.msaAppId
      ? { msaAppId: ep.msaAppId || secMatch?.msaAppId }
      : {}),
    ...(mergedOwnershipType ? { ownershipType: mergedOwnershipType } : {}),
    ...(ep.platformId === 'xbox'
      ? {
          gamePassTier: mergedGamePassTier,
          isLeavingSoon: mergedIsLeavingSoon,
          isRecentlyAddedToGamePass: mergedIsRecentlyAdded,
          subscriptionExpired: mergedSubscriptionExpired,
        }
      : {
          ...(mergedGamePassTier ? { gamePassTier: mergedGamePassTier } : {}),
          ...(mergedIsLeavingSoon !== undefined
            ? { isLeavingSoon: mergedIsLeavingSoon }
            : {}),
          ...(mergedIsRecentlyAdded !== undefined
            ? { isRecentlyAddedToGamePass: mergedIsRecentlyAdded }
            : {}),
          ...(mergedSubscriptionExpired !== undefined
            ? { subscriptionExpired: mergedSubscriptionExpired }
            : {}),
        }),
    ...(mergedCrossPlatformLauncher !== undefined
      ? { isCrossPlatformLauncherRuntime: mergedCrossPlatformLauncher }
      : {}),
    ...(ep.externalStorefrontHandoff ||
    secMatch?.externalStorefrontHandoff ||
    ep.chainedLauncherHandoff ||
    secMatch?.chainedLauncherHandoff ||
    mergedExternalLauncher
      ? (() => {
          const rawMergedHandoff =
            ep.chainedLauncherHandoff ||
            ep.externalStorefrontHandoff ||
            secMatch?.chainedLauncherHandoff ||
            secMatch?.externalStorefrontHandoff ||
            mergedExternalLauncher;
          const normMergedHandoff = normalizeChainedHandoffId(rawMergedHandoff);
          if (normMergedHandoff && normMergedHandoff !== ep.platformId) {
            return {
              chainedLauncherHandoff: normMergedHandoff,
              externalStorefrontHandoff: normMergedHandoff,
            };
          }
          return {
            ...(ep.externalStorefrontHandoff || secMatch?.externalStorefrontHandoff
              ? {
                  externalStorefrontHandoff:
                    ep.externalStorefrontHandoff || secMatch?.externalStorefrontHandoff,
                }
              : {}),
            ...(ep.chainedLauncherHandoff || secMatch?.chainedLauncherHandoff
              ? {
                  chainedLauncherHandoff:
                    ep.chainedLauncherHandoff || secMatch?.chainedLauncherHandoff,
                }
              : {}),
          };
        })()
      : {}),
    ...(mergedExternalLauncher ? { externalLauncher: mergedExternalLauncher } : {}),
    ...(mergedExternalLauncherUrl
      ? { externalLauncherUrl: mergedExternalLauncherUrl }
      : {}),
    ...(ep.xboxBottleCompatibilityTier || secMatch?.xboxBottleCompatibilityTier
      ? {
          xboxBottleCompatibilityTier:
            ep.xboxBottleCompatibilityTier || secMatch?.xboxBottleCompatibilityTier,
        }
      : {}),
    ...(mergedXboxCompatReason
      ? { xboxBottleCompatibilityReason: mergedXboxCompatReason }
      : {}),
    ...(mergedStubPkg !== undefined
      ? { isExternalLauncherStubPackage: mergedStubPkg }
      : {}),
    ...(mergedMaxDownloadBytes !== undefined
      ? { maxDownloadSizeBytes: mergedMaxDownloadBytes }
      : {}),
    ...(mergedPcMaxInstallBytes !== undefined
      ? { pcMaxInstallSizeBytes: mergedPcMaxInstallBytes }
      : {}),
    ...(mergedInstallSize !== undefined ? { installSize: mergedInstallSize } : {}),
    ...(ep.chainedExternalInstallId || secMatch?.chainedExternalInstallId
      ? {
          chainedExternalInstallId:
            ep.chainedExternalInstallId || secMatch?.chainedExternalInstallId,
        }
      : {}),
    ...(ep.chainedHandoffTopology || secMatch?.chainedHandoffTopology
      ? {
          chainedHandoffTopology:
            ep.chainedHandoffTopology || secMatch?.chainedHandoffTopology,
        }
      : {}),
    ...(ep.epicPartnerRegistryPath || secMatch?.epicPartnerRegistryPath
      ? {
          epicPartnerRegistryPath:
            ep.epicPartnerRegistryPath || secMatch?.epicPartnerRegistryPath,
        }
      : {}),
    ...(ep.requiresKernelAntiCheat !== undefined ||
    secMatch?.requiresKernelAntiCheat !== undefined
      ? {
          requiresKernelAntiCheat:
            ep.requiresKernelAntiCheat ?? secMatch?.requiresKernelAntiCheat,
        }
      : {}),
    ...(mergedKernelAntiCheatName
      ? { kernelAntiCheatName: mergedKernelAntiCheatName }
      : {}),
    ...(ep.antiCheatName || secMatch?.antiCheatName
      ? {
          antiCheatName: ep.antiCheatName || secMatch?.antiCheatName,
        }
      : {}),
    originalTitle:
      ep.originalTitle || secMatch?.originalTitle || fallbackOriginalTitle || '',
  });
}

/**
 * Merges per-storefront ownership entries across duplicate/multi-storefront catalog records
 * while preserving subscription/handoff metadata and self-healing per-storefront OS invariants.
 */
export function mergePlatformEntries(
  primary: Pick<CanonicalGame, 'platforms' | 'originalStoreTitle' | 'title'>,
  secondary: Pick<CanonicalGame, 'platforms' | 'originalStoreTitle' | 'title'>
): GamePlatformOwnership[] {
  const mergedPlatforms: GamePlatformOwnership[] = (primary.platforms || []).map((ep) => {
    const secMatch = (secondary.platforms || []).find((sp) => sp.platformId === ep.platformId);
    return mergePlatformEntry(
      ep,
      secMatch,
      primary.originalStoreTitle || primary.title
    );
  });

  for (const p of secondary.platforms || []) {
    const found = mergedPlatforms.some((ep) => ep.platformId === p.platformId);
    if (!found) {
      mergedPlatforms.push(
        sanitizePlatformOwnershipOsFlags({
          ...p,
          ...(p.platformId === 'xbox' && p.ownershipType === 'owned'
            ? {
                gamePassTier: undefined,
                isLeavingSoon: undefined,
                isRecentlyAddedToGamePass: undefined,
                subscriptionExpired: false,
              }
            : p.platformId === 'xbox' && p.subscriptionExpired
            ? {
                isLeavingSoon: undefined,
                isRecentlyAddedToGamePass: undefined,
              }
            : {}),
          originalTitle:
            p.originalTitle ||
            secondary.originalStoreTitle ||
            secondary.title,
        })
      );
    }
  }

  return mergedPlatforms;
}

/**
 * Self-heals publisher handoff fields (`chainedLauncherHandoff` <-> `externalStorefrontHandoff`),
 * Epic `drmNotice` EA partner links, structural kernel anti-cheat flags, and OS attribution
 * invariants across single-store and merged multi-store catalog entries.
 */
export function selfHealCatalogEntryHandoffsAndOs(game: CanonicalGame): CanonicalGame {
  if (!game || typeof game !== 'object') return game;

  const rawDrmNotice =
    game.enrichedMetadata?.drmNotice ||
    (game as { drmNotice?: string }).drmNotice ||
    '';
  const plainDrmNotice = normalizeDrmNoticePlainText(rawDrmNotice);
  const hasEaBackgroundDrmNotice = Boolean(
    plainDrmNotice && EA_DRM_BACKGROUND_REQUIRED_RE.test(plainDrmNotice)
  );
  const antiCheatFromNotice = detectKernelAntiCheatFromNotice(plainDrmNotice);

  let platformsChanged = false;
  const rawPlatforms = Array.isArray(game.platforms) ? game.platforms : [];
  let nextPlatforms = rawPlatforms.map((p) => {
    if (!p || typeof p !== 'object') return p;
    let working = p;
    const pid = String(p.platformId || '').toLowerCase();

    if (
      hasEaBackgroundDrmNotice &&
      pid === 'epic' &&
      !p.chainedLauncherHandoff &&
      !p.externalStorefrontHandoff
    ) {
      working = {
        ...working,
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: working.chainedHandoffTopology || 'partner_launcher_link',
      };
    } else if (
      hasEaBackgroundDrmNotice &&
      pid === 'steam' &&
      game.enrichedMetadata?.metadataQuality !== 'skeleton_fallback' &&
      !p.chainedLauncherHandoff &&
      !p.externalStorefrontHandoff
    ) {
      working = {
        ...working,
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: working.chainedHandoffTopology || 'storefront_depot_uri',
      };
    }

    const sanitized = sanitizePlatformOwnershipOsFlags(working);
    if (sanitized !== p) {
      platformsChanged = true;
    }
    return sanitized;
  });

  const hasGenuineMacPlatformEntry = nextPlatforms.some((p) => {
    if (!p || typeof p !== 'object') return false;
    if (
      p.installed &&
      !p.isWindowsBinaryOnMac &&
      /\.app(?:\/|$)/i.test(p.executablePath || p.installPath || '')
    ) {
      return true;
    }
    const pid = String(p.platformId || '').toLowerCase();
    const handoff = normalizeChainedHandoffId(
      p.chainedLauncherHandoff || p.externalStorefrontHandoff
    );

    if (pid === 'xbox') {
      return Boolean(p.isCrossPlatformLauncherRuntime === true || p.platforms?.mac === true);
    }
    if (pid === 'ubisoft' || pid === 'ea' || pid === 'rockstar' || pid === 'riot') {
      return false;
    }
    if (pid === 'epic') {
      if (handoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(handoff)) return false;
      if (p.platforms && typeof p.platforms === 'object' && !Array.isArray(p.platforms)) {
        return Boolean(p.platforms.mac === true);
      }
      return Boolean(
        nextPlatforms.length === 1 &&
          game.enrichedMetadata?.appId === 0 &&
          game.enrichedMetadata?.platforms?.mac === true
      );
    }
    if (pid === 'gog') {
      if (p.platforms && typeof p.platforms === 'object' && !Array.isArray(p.platforms)) {
        return Boolean(p.platforms.mac === true);
      }
      const gogId = String(p.platformGameId || '').replace(/^gog-/, '');
      const cachedGog = gogId
        ? (gogEnrichedCache as Record<string, GogEnrichedCacheItem>)[gogId]
        : undefined;
      if (cachedGog?.platforms || cachedGog?.worksOn) {
        return Boolean(
          cachedGog.platforms?.mac === true ||
            cachedGog.worksOn?.Mac === true ||
            cachedGog.worksOn?.mac === true
        );
      }
      return Boolean(
        nextPlatforms.length === 1 &&
          (game.worksOn?.mac ||
            game.worksOn?.Mac ||
            game.platforms_os?.mac ||
            (Array.isArray(game.nativePlatforms) && game.nativePlatforms.includes('mac')))
      );
    }
    if (pid === 'steam') {
      if (p.platforms && typeof p.platforms === 'object' && !Array.isArray(p.platforms)) {
        return Boolean(p.platforms.mac === true);
      }
      if (game.enrichedMetadata?.metadataQuality === 'skeleton_fallback') {
        return false;
      }
      if (game.enrichedMetadata?.platforms?.mac === true) {
        return true;
      }
      const cachedSteam = game.steamAppId
        ? (steamEnrichedCache as Record<string, SteamEnrichedCacheItem>)[String(game.steamAppId)]
        : undefined;
      return Boolean(cachedSteam?.platforms?.mac === true);
    }
    return Boolean(p.platforms?.mac === true);
  });

  const structuralAntiCheat = detectStructuralKernelAntiCheatFromNotices(
    rawDrmNotice,
    ...nextPlatforms.map((p) => p?.xboxBottleCompatibilityReason)
  );
  const existingPlatAntiCheat = nextPlatforms.find(
    (p) =>
      p?.requiresKernelAntiCheat ||
      Boolean(p?.kernelAntiCheatName) ||
      Boolean(resolveCanonicalKernelAntiCheatDisplayName(p?.antiCheatName))
  );
  const existingPlatKernelAntiCheatName = nextPlatforms
    .map(
      (p) =>
        p?.kernelAntiCheatName ||
        resolveCanonicalKernelAntiCheatDisplayName(p?.antiCheatName) ||
        (normalizeChainedHandoffId(
          p?.chainedLauncherHandoff || p?.externalStorefrontHandoff || p?.platformId
        ) === 'riot'
          ? 'Riot Vanguard'
          : undefined)
    )
    .find(Boolean);

  const effectiveKernelAntiCheatName =
    structuralAntiCheat?.kernelAntiCheatName ||
    game.kernelAntiCheatName ||
    resolveCanonicalKernelAntiCheatDisplayName(game.antiCheatName) ||
    existingPlatKernelAntiCheatName;

  const effectiveRequiresAntiCheat = Boolean(
    antiCheatFromNotice ||
      structuralAntiCheat ||
      game.requiresKernelAntiCheat ||
      existingPlatAntiCheat ||
      effectiveKernelAntiCheatName
  );
  const effectiveAntiCheatName =
    antiCheatFromNotice?.antiCheatName ||
    game.antiCheatName ||
    existingPlatAntiCheat?.antiCheatName ||
    effectiveKernelAntiCheatName;

  if (effectiveRequiresAntiCheat && !hasGenuineMacPlatformEntry) {
    nextPlatforms = nextPlatforms.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const pid = String(p.platformId || '').toLowerCase();
      if (pid === 'gog' || p.platforms?.mac === true) return p;
      const targetKernelName = p.kernelAntiCheatName || effectiveKernelAntiCheatName;
      const targetLegacyName = p.antiCheatName || effectiveAntiCheatName;
      if (
        p.requiresKernelAntiCheat === true &&
        (!targetKernelName || p.kernelAntiCheatName === targetKernelName) &&
        (!targetLegacyName || p.antiCheatName === targetLegacyName)
      ) {
        return p;
      }
      platformsChanged = true;
      return {
        ...p,
        requiresKernelAntiCheat: true,
        ...(targetKernelName ? { kernelAntiCheatName: targetKernelName } : {}),
        ...(targetLegacyName ? { antiCheatName: targetLegacyName } : {}),
      };
    });
  }

  const allOwnedEntriesExcludeMac =
    nextPlatforms.length > 0 &&
    !hasGenuineMacPlatformEntry &&
    nextPlatforms.every((p) => {
      if (!p || typeof p !== 'object') return false;
      const pid = String(p.platformId || '').toLowerCase();
      const handoff = normalizeChainedHandoffId(
        p.chainedLauncherHandoff || p.externalStorefrontHandoff
      );
      if (handoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(handoff)) {
        if (pid === 'steam' && p.platforms?.mac === true) return false;
        return true;
      }
      if (
        pid === 'xbox' ||
        pid === 'ubisoft' ||
        pid === 'ea' ||
        pid === 'rockstar' ||
        pid === 'riot' ||
        pid === 'epic'
      ) {
        return true;
      }
      if (
        p.platforms &&
        typeof p.platforms === 'object' &&
        !Array.isArray(p.platforms) &&
        p.platforms.mac === false
      ) {
        return true;
      }
      return false;
    });

  let nextGame: CanonicalGame = platformsChanged
    ? { ...game, platforms: nextPlatforms }
    : game;

  if (
    effectiveRequiresAntiCheat &&
    !hasGenuineMacPlatformEntry &&
    (nextGame.requiresKernelAntiCheat !== true ||
      (effectiveKernelAntiCheatName &&
        nextGame.kernelAntiCheatName !== effectiveKernelAntiCheatName) ||
      (effectiveAntiCheatName && nextGame.antiCheatName !== effectiveAntiCheatName))
  ) {
    nextGame = {
      ...nextGame,
      requiresKernelAntiCheat: true,
      ...(effectiveKernelAntiCheatName
        ? {
            kernelAntiCheatName:
              nextGame.kernelAntiCheatName || effectiveKernelAntiCheatName,
          }
        : {}),
      ...(effectiveAntiCheatName
        ? { antiCheatName: nextGame.antiCheatName || effectiveAntiCheatName }
        : {}),
    };
  }

  if (allOwnedEntriesExcludeMac) {
    if (
      nextGame.worksOn &&
      typeof nextGame.worksOn === 'object' &&
      (nextGame.worksOn.mac || nextGame.worksOn.Mac || nextGame.worksOn.windows === false)
    ) {
      nextGame = {
        ...nextGame,
        worksOn: { windows: true, mac: false, linux: false },
      };
    }
    if (
      nextGame.platforms_os &&
      typeof nextGame.platforms_os === 'object' &&
      (nextGame.platforms_os.mac || nextGame.platforms_os.windows === false)
    ) {
      nextGame = {
        ...nextGame,
        platforms_os: { windows: true, mac: false, linux: false },
      };
    }
    if (
      Array.isArray(nextGame.nativePlatforms) &&
      (nextGame.nativePlatforms.includes('mac') || !nextGame.nativePlatforms.includes('windows'))
    ) {
      nextGame = {
        ...nextGame,
        nativePlatforms: ['windows'],
      };
    }
    const rawSupported = (nextGame as { supportedPlatforms?: string[] }).supportedPlatforms;
    if (Array.isArray(rawSupported)) {
      const filteredSupported = rawSupported.filter(
        (os) => !/^(?:mac|macos|osx)$/i.test(String(os || '').trim())
      );
      if (!filteredSupported.some((os) => /^windows$/i.test(String(os || '').trim()))) {
        filteredSupported.unshift('windows');
      }
      if (
        filteredSupported.length !== rawSupported.length ||
        filteredSupported.some((v, idx) => v !== rawSupported[idx])
      ) {
        nextGame = {
          ...nextGame,
          ...({ supportedPlatforms: filteredSupported } as Record<string, unknown>),
        };
      }
    }
  } else if (nextPlatforms.some((p) => p?.isCrossPlatformLauncherRuntime === true)) {
    const supportsLinux = nextPlatforms.some((p) => p?.platforms?.linux === true);
    if (
      !nextGame.worksOn ||
      typeof nextGame.worksOn !== 'object' ||
      nextGame.worksOn.mac !== true ||
      nextGame.worksOn.windows === false ||
      (supportsLinux && nextGame.worksOn.linux !== true)
    ) {
      nextGame = {
        ...nextGame,
        worksOn: {
          ...(nextGame.worksOn || {}),
          windows: true,
          mac: true,
          linux: supportsLinux || Boolean(nextGame.worksOn?.linux),
        },
      };
    }
    if (
      nextGame.platforms_os &&
      typeof nextGame.platforms_os === 'object' &&
      (nextGame.platforms_os.mac !== true || nextGame.platforms_os.windows === false)
    ) {
      nextGame = {
        ...nextGame,
        platforms_os: {
          ...nextGame.platforms_os,
          windows: true,
          mac: true,
          linux: supportsLinux || Boolean(nextGame.platforms_os.linux),
        },
      };
    }
    if (Array.isArray(nextGame.nativePlatforms) && !nextGame.nativePlatforms.includes('mac')) {
      nextGame = {
        ...nextGame,
        nativePlatforms: Array.from(
          new Set([...nextGame.nativePlatforms, 'windows' as const, 'mac' as const])
        ),
      };
    }
  }

  return nextGame;
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
  optionsOrOverrides?:
    | { allowNewPurchases?: boolean; validSteamAppIds?: Set<number> }
    | Record<string, unknown>,
  maybeOptions?: { allowNewPurchases?: boolean; validSteamAppIds?: Set<number> }
): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];

  // Refresh user-hidden entries while preserving previously discovered non-game / suppressed entries from storage
  let deletedUserHidden = false;
  for (const [k, v] of lastSuppressedEntries.entries()) {
    if (v.reasonCategory === 'user_hidden') {
      lastSuppressedEntries.delete(k);
      deletedUserHidden = true;
    }
  }
  if (deletedUserHidden) {
    suppressedMapVersion++;
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
      suppressedAt: Date.now(),
      rawGame,
    });
    suppressedMapVersion++;
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
  const hasUserOverrides = Object.keys(userOverrides).length > 0;
  const hasHiddenStorefrontEntries = Object.keys(loadHiddenStorefrontEntries()).length > 0;
  const hasGamePatches = Object.keys(KNOWN_GAME_PATCHES).length > 0;
  const cleaned: CanonicalGame[] = [];
  const titleToIndex = new Map<string, number>();
  const steamIdToIndex = new Map<number, number>();
  const idToIndex = new Map<string, number>();

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

    const hadRawPlatforms = Array.isArray(rawGame.platforms) && rawGame.platforms.length > 0;
    const sanitizedPlatforms: GamePlatformOwnership[] = [];
    if (Array.isArray(rawGame.platforms)) {
      for (const p of rawGame.platforms) {
        if (!p || typeof p !== 'object') continue;
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
          continue;
        }
        const workingP: GamePlatformOwnership = {
          ...p,
          originalTitle: p.originalTitle || rawSourceTitle,
        };
        if (!isPhysicallyInstalled && workingP.version !== undefined) {
          delete workingP.version;
        }
        sanitizedPlatforms.push(sanitizePlatformOwnershipOsFlags(workingP));
      }
    }
    if (hadRawPlatforms && sanitizedPlatforms.length === 0) {
      continue;
    }

    let game: CanonicalGame = {
      ...rawGame,
      originalStoreTitle: rawSourceTitle,
      platforms: sanitizedPlatforms,
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

    game = selfHealCatalogEntryHandoffsAndOs(game);

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
    }

    if (STOREFRONT_BONUS_SUFFIX_REGEX.test(game.title)) {
      const strippedTitle = game.title.replace(STOREFRONT_BONUS_SUFFIX_REGEX, '').trim();
      game = {
        ...game,
        title: strippedTitle,
        sortTitle: strippedTitle.replace(/^(The|A|An)\s+/i, ''),
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
          sortTitle: strippedXboxTitle.replace(/^(The|A|An)\s+/i, ''),
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

    // Look up userOverride and restored non-game flag lazily so explicitly restored/overridden items bypass non-game filters
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

    // 2. Filter out junk, pure hex hashes, Fortnite DLC, and unmapped codenames
    if (isEpicNonGameEntry(game)) {
      if (!userOverride && !getIsRestoredNonGame()) {
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
    if (isUnmappedEpicInternalCodename(game)) {
      if (!userOverride && !getIsRestoredNonGame()) {
        recordSuppressedEntry(
          game,
          getNonGameSuppressionReason(game),
          'non_game_filter'
        );
        continue;
      }
    }

    // Curated game patches declarative lookup
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
    }

    const isAuthenticNew =
      game.isVerifiedEntitlement === true ||
      options?.allowNewPurchases === true ||
      game.platforms.some((p) => p.installed === true) ||
      getIsRestoredNonGame();

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
          isAuthenticNew ||
          isVerifiedGogDynamic ||
          validGogProductIds.size === 0 ||
          (gogIdTrimmed && validGogProductIds.has(gogIdTrimmed)) ||
          validGogTitles.has(normTitle) ||
          validGogTitles.has(normalizeCanonicalTitle(rawGame.title)) ||
          getIsRestoredNonGame());

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
      const isNonGameEpic = !userOverride && isEpicNonGameEntry(game) && !getIsRestoredNonGame();
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
          isAuthenticNew ||
          isVerifiedEpicDynamic ||
          validEpicTitles.size === 0 ||
          (epicGameId && validEpicCatalogIds.has(epicGameId)) ||
          validEpicTitles.has(updatedNormTitle) ||
          validEpicTitles.has(normalizeCanonicalTitle(rawGame.title)) ||
          getIsRestoredNonGame());

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

    // 7b. Verify Xbox / Microsoft Store / Game Pass entitlements and purge synthetic mock/unowned items
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

      if ((isVerifiedXboxDynamic || hasValidXboxIdentifier) && !isMockOrInvalidXbox) {
        game.isVerifiedEntitlement = true;
      }

      if (!isRealXboxGame) {
        recordSuppressedEntry(
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

    // 8. Purge false Steam platform presence from unowned Steam titles, demos, promo cache, and non-Steam installations
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
      userOverride?.steamAppId === null || game.isExplicitNonSteam
        ? undefined
        : (game.steamAppId || steamMatcher.peekCachedMatch(game.title));

    // Self-heal legacy Xbox native metadata lacking a valid Steam AppID so quality ranking never treats it as authoritative Steam
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
        ? (gogEnrichedCache as Record<string, GogEnrichedCacheItem>)[gogPlat.platformGameId]
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

    // Sanitize sentinel release dates (e.g. '2799-12-31', '9998-12-30', '0001-01-01') on enrichedMetadata and top-level game
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

    // Strip horizontal 184x69 micro-banners from capsuleImage and upgrade unhashed Steam headerImage from enrichedMetadata / browseAssets
    if (game.enrichedMetadata?.capsuleImage && isUnsuitableCoverUrl(game.enrichedMetadata.capsuleImage)) {
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
          game.enrichedMetadata?.capsuleImage && !isUnsuitableCoverUrl(game.enrichedMetadata.capsuleImage)
            ? game.enrichedMetadata.capsuleImage
            : undefined,
      };
    }

    const effectiveSteamIdForAssets = !game.isExplicitNonSteam
      ? (game.steamAppId || matchedAppIdForBlurb)
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

    // Systemic resolution of GOG official vertical covers from verified enriched cache
    const gogPlat = game.platforms.find((p) => p.platformId === 'gog');
    if (!userOverride?.capsuleImage && gogPlat && gogPlat.platformGameId) {
      const enrichedGog = (gogEnrichedCache as Record<string, GogEnrichedCacheItem>)[
        gogPlat.platformGameId
      ];
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
    if (!userOverride?.capsuleImage) {
      const isCuratedIgdb = Boolean(
        KNOWN_IGDB_COVERS[game.title.toLowerCase().trim()] ||
          KNOWN_IGDB_COVERS[normTitle] ||
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
        const instantIgdbCover = igdbCoverService.getIgdbCoverInstant(
          game.title,
          game.steamAppId || matchedAppIdForBlurb || undefined,
          game.id
        );
        if (instantIgdbCover) {
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

    game = selfHealCatalogEntryHandoffsAndOs(game);

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
      (!hasUserOverrides || !hasSplitOverrideConflict(cleaned[candidateIndex], game, userOverrides))
        ? candidateIndex
        : undefined;

    if (existingIndex !== undefined && cleaned[existingIndex]) {
      // Merge platforms across duplicates
      const existing = cleaned[existingIndex];
      const existingIsParenClassic = /\s*\((?:original|classic)\)$/i.test(existing.title);
      const incomingIsParenClassic = /\s*\((?:original|classic)\)$/i.test(game.title);
      const existingIsStandaloneXboxWithoutSteam =
        !existing.steamAppId &&
        existing.platforms.length > 0 &&
        existing.platforms.every((p) => p.platformId === 'xbox');
      const incomingHasCanonicalSteam =
        Boolean(game.steamAppId) &&
        game.platforms.some((p) => p.platformId === 'steam') &&
        !incomingIsParenClassic;
      const preferIncomingEdition =
        (existingIsParenClassic && !incomingIsParenClassic) ||
        (existingIsStandaloneXboxWithoutSteam && incomingHasCanonicalSteam);
      const primary = preferIncomingEdition ? game : existing;
      const secondary = preferIncomingEdition ? existing : game;

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
          pickPreferredHeaderImage(primary.headerImage, secondary.headerImage) ||
          primary.headerImage ||
          secondary.headerImage,
        capsuleImage: (() => {
          const primaryOv = hasUserOverrides
            ? getUserOverrideForGame(primary, userOverrides)
            : undefined;
          const secondaryOv = hasUserOverrides
            ? getUserOverrideForGame(secondary, userOverrides)
            : undefined;
          const pinnedOvCover =
            primaryOv?.capsuleImage?.trim() || secondaryOv?.capsuleImage?.trim();
          if (pinnedOvCover) {
            return pinnedOvCover;
          }
          if (
            isKnownDeadSteamCover(primary.steamAppId) ||
            isKnownDeadSteamCover(secondary.steamAppId) ||
            isUnsuitableCoverUrl(primary.capsuleImage) ||
            isUnsuitableCoverUrl(secondary.capsuleImage)
          ) {
            const igdb = igdbCoverService.getIgdbCoverInstant(
              primary.title,
              primary.steamAppId || secondary.steamAppId,
              primary.id || secondary.id
            );
            if (igdb) {
              return igdb;
            }
          }
          if (
            secondary.capsuleImage &&
            (isKnownDeadSteamCover(primary.steamAppId) || isUnsuitableCoverUrl(primary.capsuleImage))
          ) {
            return secondary.capsuleImage;
          }
          return (
            pickPreferredCapsuleImage(primary.capsuleImage, secondary.capsuleImage) ||
            primary.capsuleImage ||
            secondary.capsuleImage
          );
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
        detailedDescription: pickPreferredDetailedDescription(
          primary.detailedDescription,
          secondary.detailedDescription
        ),
        developers: primary.developers && primary.developers.length > 0 ? primary.developers : secondary.developers,
        publishers: primary.publishers && primary.publishers.length > 0 ? primary.publishers : secondary.publishers,
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
              kernelAntiCheatName:
                primary.kernelAntiCheatName || secondary.kernelAntiCheatName,
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

      cleaned[existingIndex] = selfHealCatalogEntryHandoffsAndOs(cleaned[existingIndex]);

      if (hasUserOverrides) {
        const existingOv = getUserOverrideForGame(existing, userOverrides);
        const effectiveOv = userOverride || existingOv;
        if (effectiveOv) {
          cleaned[existingIndex] = selfHealCatalogEntryHandoffsAndOs(
            applyUserOverrideToGame(cleaned[existingIndex], effectiveOv)
          );
        }
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
        const existingOv = hasUserOverrides
          ? getUserOverrideForGame(existing, userOverrides)
          : undefined;
        const gameOv = hasUserOverrides ? getUserOverrideForGame(game, userOverrides) : undefined;

        // A. Self-Heal Stale Overwritten Remastered/Enhanced Titles on Same-Storefront Pairs
        // Never strip title/artwork/steamAppId on an entry with an active UserGameOverride!
        if (
          normalizeCanonicalTitle(existing.title) === normalizeCanonicalTitle(game.title) &&
          /\b(remastered|remaster|enhanced)\b/i.test(existing.title)
        ) {
          let baseTarget: CanonicalGame | null = null;
          if (existingOv && !gameOv) {
            baseTarget = !game.platforms.some((p) => p.platformId === 'steam') ? game : null;
          } else if (gameOv && !existingOv) {
            baseTarget = !existing.platforms.some((p) => p.platformId === 'steam')
              ? existing
              : null;
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
            const restoredTitle = baseTarget.title
              .replace(/\s*[-–—:]?\s*\b(remastered|remaster|enhanced(?:\s+edition)?)\b/gi, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            const collidingAppId = baseTarget.steamAppId;
            baseTarget.title = restoredTitle;
            baseTarget.sortTitle = restoredTitle.replace(/^(The|A|An)\s+/i, '');
            baseTarget.steamAppId = undefined;
            baseTarget.enrichedMetadata = undefined;
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

          if (existingOv && gameOv) {
            // Both colliding entries have explicit UserGameOverrides: preserve steamAppId, title, and artwork on BOTH,
            // disambiguating ONLY `id` on the secondary non-Steam entry if their IDs collide!
            if (existing.id === game.id) {
              const idDisambigTarget =
                existingHasSteam && !gameHasSteam
                  ? game
                  : !existingHasSteam && gameHasSteam
                    ? existing
                    : game;
              const plat = idDisambigTarget.platforms?.[0];
              if (plat?.platformId && plat?.platformGameId) {
                const oldId = idDisambigTarget.id;
                idDisambigTarget.id = `${plat.platformId}-${plat.platformGameId}`;
                if (idDisambigTarget === existing) {
                  if (oldId && idToIndex.get(oldId) === candidateIndex) {
                    idToIndex.delete(oldId);
                  }
                  idToIndex.set(existing.id, candidateIndex);
                }
              }
            }
          } else {
            let targetToDemote: CanonicalGame = game;
            if (existingOv && !gameOv) {
              targetToDemote = game;
            } else if (gameOv && !existingOv) {
              targetToDemote = existing;
            } else if (existingHasSteam !== gameHasSteam) {
              targetToDemote = existingHasSteam ? game : existing;
            } else if (existingHasEdition !== gameHasEdition) {
              const steamCachedName = sharedAppId
                ? (steamEnrichedCache as Record<string, SteamEnrichedCacheItem>)[String(sharedAppId)]
                    ?.name || ''
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
      }

      const newIndex = cleaned.length;
      cleaned.push(game);
      if (normTitle) titleToIndex.set(normTitle, newIndex);
      if (game.steamAppId) steamIdToIndex.set(game.steamAppId, newIndex);
      if (game.id) idToIndex.set(game.id, newIndex);
    }
  }

  const finalCatalog = hasUserOverrides
    ? applyUserOverridesToCatalog(cleaned, userOverrides)
    : cleaned;

  // C. Final Strict Unique game.id & Same-Storefront Steam AppID Guarantee Pass
  const seenIds = new Set<string>();
  const seenSteamAppIds = new Map<number, CanonicalGame>();
  for (let idx = 0; idx < finalCatalog.length; idx++) {
    const g = finalCatalog[idx];
    if (g.steamAppId) {
      const prevWithAppId = seenSteamAppIds.get(g.steamAppId);
      if (prevWithAppId && hasSameStorefrontConflict(prevWithAppId, g)) {
        const prevOv = hasUserOverrides
          ? getUserOverrideForGame(prevWithAppId, userOverrides)
          : undefined;
        const currOv = hasUserOverrides ? getUserOverrideForGame(g, userOverrides) : undefined;

        if (prevOv && currOv) {
          // Both entries carry explicit UserGameOverrides: keep steamAppId, title, and artwork on BOTH;
          // `seenIds` below disambiguates `g.id` to its native platform ID if `g.id === prevWithAppId.id`.
        } else {
          // Two distinct same-storefront editions still share the same steamAppId
          const prevHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(prevWithAppId.title);
          const currHasEdition = /\b(remastered|remaster|remake|enhanced)\b/i.test(g.title);
          const targetToDemote =
            prevOv && !currOv
              ? g
              : currOv && !prevOv
                ? prevWithAppId
                : !prevWithAppId.platforms.some((p) => p.platformId === 'steam') &&
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
    let removedActive = false;
    for (const [k, entry] of lastSuppressedEntries.entries()) {
      if (
        entry.reasonCategory !== 'user_hidden' &&
        (activePlatformKeys.has(k) ||
          activePlatformKeys.has(entry.id) ||
          activePlatformKeys.has(`${entry.platformId}:${entry.platformGameId}`) ||
          activePlatformKeys.has(`${entry.platformId}-${entry.platformGameId}`))
      ) {
        lastSuppressedEntries.delete(k);
        removedActive = true;
      }
    }
    if (removedActive) {
      suppressedMapVersion++;
    }
  }
  persistSuppressedEntriesToStorage();

  return finalCatalog.sort((a, b) => BASE_TITLE_COLLATOR.compare(a.title, b.title));
}

const BASE_TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
