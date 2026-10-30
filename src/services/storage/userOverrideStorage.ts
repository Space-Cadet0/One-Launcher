import type { CanonicalGame } from '../../contracts/game';
import type { StorefrontId } from '../../contracts/platform';
import type {
  UserGameOverride,
  UserGameOverridesMap,
  ReviewScoreRoute,
  MetadataSourceRoute,
  NativeGameBaselineSnapshot,
} from '../../contracts/override';

export const STORAGE_KEY_USER_OVERRIDES = 'universal_game_library_user_overrides';
export const STORAGE_KEY_HIDDEN_ENTRIES = 'universal_game_library_hidden_entries';
export const STORAGE_KEY_RESTORED_NON_GAMES = 'universal_game_library_restored_non_games_v1';
export const STORAGE_KEY_CONFIRMED_NON_GAMES = 'universal_game_library_confirmed_non_games_v1';

export interface HiddenStorefrontEntry {
  key: string; // `${platformId}:${platformGameId}` or `game:${gameId}`
  gameId: string;
  platformId: StorefrontId;
  platformGameId: string;
  rawTitle: string;
  hiddenAt: string;
  reason?: string;
  rawGameSnapshot?: CanonicalGame;
}

interface CompactHiddenStorefrontRecord {
  key: string;
  gameId: string;
  store?: StorefrontId;
  platformId: StorefrontId;
  platformGameId: string;
  rawTitle: string;
  hiddenAt: string;
  reason?: string;
  steamAppId?: number;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
  releaseDate?: string;
  installed?: boolean;
  rawGameSnapshot?: CanonicalGame;
}

function reconstructHiddenGameSnapshot(record: CompactHiddenStorefrontRecord): CanonicalGame {
  const platformId: StorefrontId = record.platformId || record.store || 'custom';
  const platformGameId = String(record.platformGameId || record.gameId || '');
  const title = record.rawTitle || record.gameId || platformGameId || 'Unknown Game';
  const id = record.gameId || `${platformId}-${platformGameId}`;
  const inferredSteamId =
    typeof record.steamAppId === 'number' && record.steamAppId > 0
      ? record.steamAppId
      : platformId === 'steam' && /^\d+$/.test(platformGameId)
      ? Number(platformGameId)
      : undefined;

  return {
    id,
    title,
    sortTitle: title.replace(/^(The|A|An)\s+/i, '').trim(),
    originalStoreTitle: title,
    steamAppId: inferredSteamId,
    headerImage: record.headerImage || '',
    capsuleImage: record.capsuleImage,
    iconUrl: record.iconUrl,
    releaseDate: record.releaseDate,
    developers: [],
    publishers: [],
    genres: [],
    tags: [],
    platforms: [
      {
        platformId,
        platformGameId,
        originalTitle: title,
        installed: Boolean(record.installed),
      },
    ],
  };
}

function toCompactHiddenRecord(entry: HiddenStorefrontEntry): CompactHiddenStorefrontRecord {
  const snap = entry.rawGameSnapshot;
  const platInstalled = snap?.platforms?.some((p) => p.installed === true);
  const compact: CompactHiddenStorefrontRecord = {
    key: entry.key,
    gameId: entry.gameId,
    store: entry.platformId,
    platformId: entry.platformId,
    platformGameId: entry.platformGameId,
    rawTitle: entry.rawTitle,
    hiddenAt: entry.hiddenAt,
    reason: entry.reason,
  };
  const steamAppId =
    typeof snap?.steamAppId === 'number' && snap.steamAppId > 0
      ? snap.steamAppId
      : entry.platformId === 'steam' && /^\d+$/.test(entry.platformGameId)
      ? Number(entry.platformGameId)
      : undefined;
  if (steamAppId) compact.steamAppId = steamAppId;
  if (snap?.headerImage) compact.headerImage = snap.headerImage;
  if (snap?.capsuleImage) compact.capsuleImage = snap.capsuleImage;
  if (snap?.iconUrl) compact.iconUrl = snap.iconUrl;
  if (snap?.releaseDate) compact.releaseDate = snap.releaseDate;
  if (platInstalled) compact.installed = true;
  return compact;
}

/**
 * Strips any raw HTML tags, comments, BBCode, or entities from a short synopsis string,
 * returning clean plain text suitable for hero synopsis display.
 */
function sanitizePlainSynopsis(rawText?: string, maxLength = 360): string {
  if (!rawText || typeof rawText !== 'string') return '';
  if (!/[<&]|\[\/?(?:b|i|u|url|quote|img)/i.test(rawText) && rawText.length <= maxLength) {
    return rawText.trim();
  }
  const clean = rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/product_(?:description|feature)_\d+/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?(?:b|i|u|url|quote|img|h[1-6]|list|code|spoiler|\*)[^\]]*\]/gi, '')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&trade;/gi, '™')
    .replace(/&reg;/gi, '®')
    .replace(/&copy;/gi, '©')
    .trim();

  if (!clean) return '';
  const paragraphs = clean
    .split(/\r?\n+/)
    .map((p) =>
      p
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return '';

  while (
    paragraphs.length > 1 &&
    ((paragraphs[0].length < 40 &&
      /^(about(?:\s+the\s+game|\s+this\s+game)?|overview|story|description|features|synopsis|summary|key\s+features)\b[:.\s-]*$/i.test(
        paragraphs[0]
      )) ||
      /when you buy this game\b|will be added to your gog\.com account/i.test(paragraphs[0]))
  ) {
    paragraphs.shift();
  }

  let firstPara = paragraphs[0];
  if (maxLength > 0 && firstPara.length > maxLength) {
    const truncated = firstPara.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    firstPara =
      (lastSpace > maxLength * 0.7 ? truncated.substring(0, lastSpace) : truncated).trim() + '...';
  }
  return firstPara.trim();
}

/**
 * Infers a structured MetadataSourceRoute from a UserGameOverride (including legacy overrides).
 */
export function inferMetadataRouteFromOverride(
  override?: UserGameOverride | null
): MetadataSourceRoute | undefined {
  if (!override) return undefined;
  if (override.metadataRoute) {
    const inferredMode: 'routed' | 'custom' =
      override.metadataRoute.mode ||
      (override.metadataRoute.source === 'custom' || override.metadataRoute.source === 'original'
        ? 'custom'
        : 'routed');
    return {
      ...override.metadataRoute,
      mode: inferredMode,
    };
  }
  const source = override.matchedStore || 'custom';
  const mode: 'routed' | 'custom' = source === 'custom' ? 'custom' : 'routed';
  const steamAppId =
    typeof override.steamAppId === 'number' && override.steamAppId > 0
      ? override.steamAppId
      : source === 'steam' && override.matchedId && !isNaN(Number(override.matchedId))
      ? Number(override.matchedId)
      : undefined;
  const gogId =
    source === 'gog' && override.matchedId
      ? String(override.matchedId).replace(/^gog-/, '')
      : undefined;
  const epicSlug =
    source === 'epic' && override.matchedId
      ? String(override.matchedId).replace(/^epic-/, '')
      : undefined;

  return {
    mode,
    source,
    matchedId: override.matchedId,
    steamAppId,
    gogId,
    epicSlug,
    igdbId: override.igdbId,
    targetTitle: override.title,
  };
}

/**
 * Infers a structured ReviewScoreRoute from a UserGameOverride (including legacy overrides).
 */
export function inferReviewRouteFromOverride(override?: UserGameOverride | null): ReviewScoreRoute | undefined {
  if (!override) return undefined;
  if (override.reviewRoute) return override.reviewRoute;
  if (override.reviewScoreOverride === null) {
    return { mode: 'unrated' };
  }
  if (override.reviewScoreOverride) {
    if (override.reviewScoreOverride.source === 'custom') {
      return {
        mode: 'static',
        source: 'custom',
        url: override.reviewScoreOverride.url,
      };
    }
    const metacriticSlug =
      override.reviewScoreOverride.url?.match(/metacritic\.com\/game\/(?:pc\/)?([^/?#]+)/i)?.[1] ||
      override.storefrontAnchor?.metacriticSlug;
    const openCriticId =
      Number(override.reviewScoreOverride.url?.match(/opencritic\.com\/game\/(\d+)/i)?.[1] || 0) ||
      override.storefrontAnchor?.openCriticId ||
      undefined;
    const steamAppId =
      Number(override.reviewScoreOverride.url?.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1] || 0) ||
      (typeof override.steamAppId === 'number' && override.steamAppId > 0 ? override.steamAppId : undefined);
    const gogId =
      override.matchedStore === 'gog' && override.matchedId ? String(override.matchedId) : undefined;
    const epicId =
      override.matchedStore === 'epic' && override.matchedId ? String(override.matchedId) : undefined;

    return {
      mode: 'routed',
      source: override.reviewScoreOverride.source,
      url: override.reviewScoreOverride.url,
      metacriticSlug,
      openCriticId,
      steamAppId,
      gogId,
      epicId,
      targetTitle: override.title,
    };
  }
  return undefined;
}

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

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

let userOverridesRevision = 0;

/**
 * Monotonic revision counter incremented whenever user overrides, hidden storefront entries,
 * or confirmed/restored non-game keys mutate in memory, hydrate from vault, or change via StorageEvent.
 */
export function getUserOverridesRevision(): number {
  return userOverridesRevision;
}

function bumpUserOverridesRevision(): void {
  userOverridesRevision += 1;
}

let cachedOverridesRaw: string | null = null;
let cachedOverridesMap: UserGameOverridesMap = {};
let cachedStorageRef: Storage | null = null;
let inMemoryOverridesHydrated = false;

const EMPTY_HIDDEN_ENTRIES_MAP: Record<string, HiddenStorefrontEntry> = Object.freeze(
  {}
) as Record<string, HiddenStorefrontEntry>;
let cachedHiddenRaw: string | null = null;
let cachedHiddenMap: Record<string, HiddenStorefrontEntry> = EMPTY_HIDDEN_ENTRIES_MAP;
let cachedHiddenStorageRef: Storage | null = null;
let inMemoryHiddenHydrated = false;

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();
const BARE_STOREFRONT_KEYS: ReadonlySet<string> = new Set([
  'steam',
  'gog',
  'epic',
  'xbox',
  'custom',
]);
let cachedRestoredRaw: string | null = null;
let cachedRestoredSet: ReadonlySet<string> = EMPTY_STRING_SET;
let cachedRestoredStorageRef: Storage | null = null;
let inMemoryRestoredHydrated = false;

let cachedConfirmedRaw: string | null = null;
let cachedConfirmedSet: ReadonlySet<string> = EMPTY_STRING_SET;
let cachedConfirmedStorageRef: Storage | null = null;
let inMemoryConfirmedHydrated = false;

let overrideStorageListenerAttached = false;

function ensureOverrideStorageListener(): void {
  if (overrideStorageListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  overrideStorageListenerAttached = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    let invalidated = false;
    if (e.key === null || e.key === STORAGE_KEY_USER_OVERRIDES) {
      inMemoryOverridesHydrated = false;
      cachedOverridesRaw = null;
      invalidated = true;
    }
    if (e.key === null || e.key === STORAGE_KEY_HIDDEN_ENTRIES) {
      inMemoryHiddenHydrated = false;
      cachedHiddenRaw = null;
      invalidated = true;
    }
    if (e.key === null || e.key === STORAGE_KEY_RESTORED_NON_GAMES) {
      inMemoryRestoredHydrated = false;
      cachedRestoredRaw = null;
      invalidated = true;
    }
    if (e.key === null || e.key === STORAGE_KEY_CONFIRMED_NON_GAMES) {
      inMemoryConfirmedHydrated = false;
      cachedConfirmedRaw = null;
      invalidated = true;
    }
    if (invalidated) {
      bumpUserOverridesRevision();
    }
  });
}

/**
 * Loads all user-defined game overrides from localStorage (and native Electron if available).
 */
export function loadUserOverrides(): UserGameOverridesMap {
  const storage = getStorage();
  if (!storage) return {};
  ensureOverrideStorageListener();

  if (!isTestEnv() && inMemoryOverridesHydrated && storage === cachedStorageRef) {
    return cachedOverridesMap;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY_USER_OVERRIDES);
    if (!raw) {
      if (inMemoryOverridesHydrated && cachedOverridesRaw !== null) {
        bumpUserOverridesRevision();
      }
      cachedStorageRef = storage;
      cachedOverridesRaw = null;
      cachedOverridesMap = {};
      inMemoryOverridesHydrated = true;
      return {};
    }
    if (inMemoryOverridesHydrated && storage === cachedStorageRef && raw === cachedOverridesRaw) {
      // Adopt Blink ExternalString pointer to eliminate V8 SeqTwoByteString vs ExternalString O(N) scans
      cachedOverridesRaw = raw;
      return cachedOverridesMap;
    }
    const parsed = JSON.parse(raw);
    const map = parsed && typeof parsed === 'object' ? (parsed as UserGameOverridesMap) : {};
    cachedStorageRef = storage;
    cachedOverridesRaw = raw;
    cachedOverridesMap = map;
    inMemoryOverridesHydrated = true;
    return map;
  } catch (err) {
    console.warn('Failed to load user game overrides from localStorage:', err);
    return {};
  }
}

/**
 * Loads all user-hidden storefront entries from localStorage.
 */
export function loadHiddenStorefrontEntries(): Record<string, HiddenStorefrontEntry> {
  const storage = getStorage();
  if (!storage) return EMPTY_HIDDEN_ENTRIES_MAP;
  ensureOverrideStorageListener();

  if (!isTestEnv() && inMemoryHiddenHydrated && storage === cachedHiddenStorageRef) {
    return cachedHiddenMap;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY_HIDDEN_ENTRIES);
    if (!raw) {
      cachedHiddenStorageRef = storage;
      cachedHiddenRaw = null;
      cachedHiddenMap = EMPTY_HIDDEN_ENTRIES_MAP;
      inMemoryHiddenHydrated = true;
      return EMPTY_HIDDEN_ENTRIES_MAP;
    }
    if (inMemoryHiddenHydrated && storage === cachedHiddenStorageRef && raw === cachedHiddenRaw) {
      cachedHiddenRaw = raw;
      return cachedHiddenMap;
    }
    const parsed: unknown = JSON.parse(raw);
    const map: Record<string, HiddenStorefrontEntry> = {};
    let hadLegacyRawSnapshot = false;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const rec = v as CompactHiddenStorefrontRecord;
        if (rec.rawGameSnapshot && typeof rec.rawGameSnapshot === 'object') {
          hadLegacyRawSnapshot = true;
        }
        const platformId: StorefrontId = rec.platformId || rec.store || 'custom';
        const platformGameId = String(rec.platformGameId || rec.gameId || k);
        const gameId = String(rec.gameId || rec.rawGameSnapshot?.id || `${platformId}-${platformGameId}`);
        const rawTitle = String(rec.rawTitle || rec.rawGameSnapshot?.title || gameId);
        const hydratedEntry: HiddenStorefrontEntry = {
          key: rec.key || k,
          gameId,
          platformId,
          platformGameId,
          rawTitle,
          hiddenAt: rec.hiddenAt || new Date().toISOString(),
          reason: rec.reason,
          rawGameSnapshot:
            rec.rawGameSnapshot && typeof rec.rawGameSnapshot === 'object'
              ? reconstructHiddenGameSnapshot({
                  ...toCompactHiddenRecord({
                    key: rec.key || k,
                    gameId,
                    platformId,
                    platformGameId,
                    rawTitle,
                    hiddenAt: rec.hiddenAt || '',
                    reason: rec.reason,
                    rawGameSnapshot: rec.rawGameSnapshot,
                  }),
                })
              : reconstructHiddenGameSnapshot({
                  ...rec,
                  key: rec.key || k,
                  gameId,
                  platformId,
                  platformGameId,
                  rawTitle,
                }),
        };
        map[k] = hydratedEntry;
      }
    }
    if (hadLegacyRawSnapshot) {
      persistHiddenEntriesMap(map);
      return map;
    }
    cachedHiddenStorageRef = storage;
    cachedHiddenRaw = raw;
    cachedHiddenMap = map;
    inMemoryHiddenHydrated = true;
    return map;
  } catch (err) {
    console.warn('Failed to load hidden storefront entries from localStorage:', err);
    return {};
  }
}

function persistHiddenEntriesMap(map: Record<string, HiddenStorefrontEntry>): void {
  const storage = getStorage();
  if (!storage) return;
  ensureOverrideStorageListener();
  const compactMap: Record<string, CompactHiddenStorefrontRecord> = {};
  for (const [k, entry] of Object.entries(map)) {
    if (!entry) continue;
    compactMap[k] = toCompactHiddenRecord(entry);
  }
  const serialized = JSON.stringify(compactMap);
  storage.setItem(STORAGE_KEY_HIDDEN_ENTRIES, serialized);
  cachedHiddenStorageRef = storage;
  cachedHiddenRaw = isTestEnv() ? serialized : null;
  cachedHiddenMap = map;
  inMemoryHiddenHydrated = true;
  bumpUserOverridesRevision();
}

export function getReadonlyRestoredNonGameKeys(): ReadonlySet<string> {
  const storage = getStorage();
  if (!storage) return EMPTY_STRING_SET;
  ensureOverrideStorageListener();

  if (!isTestEnv() && inMemoryRestoredHydrated && storage === cachedRestoredStorageRef) {
    return cachedRestoredSet;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY_RESTORED_NON_GAMES);
    if (!raw) {
      cachedRestoredStorageRef = storage;
      cachedRestoredRaw = null;
      cachedRestoredSet = EMPTY_STRING_SET;
      inMemoryRestoredHydrated = true;
      return EMPTY_STRING_SET;
    }
    if (
      inMemoryRestoredHydrated &&
      storage === cachedRestoredStorageRef &&
      raw === cachedRestoredRaw
    ) {
      cachedRestoredRaw = raw;
      return cachedRestoredSet;
    }
    const parsed = JSON.parse(raw);
    const set = Array.isArray(parsed)
      ? new Set<string>(
          parsed.filter(
            (s): s is string =>
              typeof s === 'string' &&
              s.trim().length > 0 &&
              !BARE_STOREFRONT_KEYS.has(s.trim().toLowerCase())
          )
        )
      : EMPTY_STRING_SET;
    cachedRestoredStorageRef = storage;
    cachedRestoredRaw = raw;
    cachedRestoredSet = set;
    inMemoryRestoredHydrated = true;
    return set;
  } catch {
    return EMPTY_STRING_SET;
  }
}

export function loadRestoredNonGameKeys(): Set<string> {
  return new Set<string>(getReadonlyRestoredNonGameKeys());
}

function persistRestoredNonGameKeys(keys: Set<string>): void {
  const storage = getStorage();
  if (!storage) return;
  ensureOverrideStorageListener();
  try {
    const serialized = JSON.stringify(Array.from(keys));
    storage.setItem(STORAGE_KEY_RESTORED_NON_GAMES, serialized);
    cachedRestoredStorageRef = storage;
    cachedRestoredRaw = isTestEnv() ? serialized : null;
    cachedRestoredSet = new Set<string>(keys);
    inMemoryRestoredHydrated = true;
    bumpUserOverridesRevision();
  } catch {}
}

export function isNonGameStorefrontEntryRestored(
  platformId?: StorefrontId,
  platformGameId?: string,
  gameId?: string
): boolean {
  const keys = getReadonlyRestoredNonGameKeys();
  if (keys.size === 0) return false;
  if (platformId && platformGameId) {
    if (keys.has(`${platformId}:${platformGameId}`) || keys.has(`${platformId}-${platformGameId}`)) {
      return true;
    }
  }
  if (gameId && (keys.has(gameId) || keys.has(`game:${gameId}`))) {
    return true;
  }
  return false;
}

function getReadonlyConfirmedNonGameKeys(): ReadonlySet<string> {
  const storage = getStorage();
  if (!storage) return EMPTY_STRING_SET;
  ensureOverrideStorageListener();

  if (!isTestEnv() && inMemoryConfirmedHydrated && storage === cachedConfirmedStorageRef) {
    return cachedConfirmedSet;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY_CONFIRMED_NON_GAMES);
    if (!raw) {
      cachedConfirmedStorageRef = storage;
      cachedConfirmedRaw = null;
      cachedConfirmedSet = EMPTY_STRING_SET;
      inMemoryConfirmedHydrated = true;
      return EMPTY_STRING_SET;
    }
    if (
      inMemoryConfirmedHydrated &&
      storage === cachedConfirmedStorageRef &&
      raw === cachedConfirmedRaw
    ) {
      cachedConfirmedRaw = raw;
      return cachedConfirmedSet;
    }
    const parsed = JSON.parse(raw);
    const set = Array.isArray(parsed)
      ? new Set<string>(parsed.filter((s) => typeof s === 'string' && s.trim().length > 0))
      : EMPTY_STRING_SET;
    cachedConfirmedStorageRef = storage;
    cachedConfirmedRaw = raw;
    cachedConfirmedSet = set;
    inMemoryConfirmedHydrated = true;
    return set;
  } catch {
    return EMPTY_STRING_SET;
  }
}

export function loadConfirmedNonGameKeys(): Set<string> {
  return new Set<string>(getReadonlyConfirmedNonGameKeys());
}

function persistConfirmedNonGameKeys(keys: Set<string>): void {
  const storage = getStorage();
  if (!storage) return;
  ensureOverrideStorageListener();
  try {
    const serialized = JSON.stringify(Array.from(keys));
    storage.setItem(STORAGE_KEY_CONFIRMED_NON_GAMES, serialized);
    cachedConfirmedStorageRef = storage;
    cachedConfirmedRaw = isTestEnv() ? serialized : null;
    cachedConfirmedSet = new Set<string>(keys);
    inMemoryConfirmedHydrated = true;
    bumpUserOverridesRevision();
  } catch {}
}

export function isNonGameStorefrontEntryConfirmed(
  platformId?: StorefrontId,
  platformGameId?: string,
  gameId?: string
): boolean {
  const keys = getReadonlyConfirmedNonGameKeys();
  if (keys.size === 0) return false;
  if (platformId && platformGameId) {
    if (keys.has(`${platformId}:${platformGameId}`) || keys.has(`${platformId}-${platformGameId}`)) {
      return true;
    }
  }
  if (gameId && (keys.has(gameId) || keys.has(`game:${gameId}`))) {
    return true;
  }
  return false;
}

export function confirmNonGameStorefrontEntry(
  platformId: StorefrontId,
  platformGameId: string,
  gameId?: string
): void {
  const keys = loadConfirmedNonGameKeys();
  if (platformId && platformGameId) {
    keys.add(`${platformId}:${platformGameId}`);
    keys.add(`${platformId}-${platformGameId}`);
  }
  if (gameId) {
    keys.add(gameId);
    keys.add(`game:${gameId}`);
  }
  persistConfirmedNonGameKeys(keys);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('antigravity:user-override-updated', {
          detail: { type: 'confirmed-non-game', platformId, platformGameId, gameId },
        })
      );
    } catch {}
  }
}

export function confirmMultipleNonGameStorefrontEntries(
  entries: Array<{ platformId: StorefrontId; platformGameId: string; gameId?: string }>
): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const keys = loadConfirmedNonGameKeys();
  for (const entry of entries) {
    if (!entry) continue;
    const { platformId, platformGameId, gameId } = entry;
    if (platformId && platformGameId) {
      keys.add(`${platformId}:${platformGameId}`);
      keys.add(`${platformId}-${platformGameId}`);
    }
    if (gameId) {
      keys.add(gameId);
      keys.add(`game:${gameId}`);
    }
  }
  persistConfirmedNonGameKeys(keys);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('antigravity:user-override-updated', {
          detail: { type: 'confirmed-non-game-batch', count: entries.length },
        })
      );
    } catch {}
  }
}

export function unconfirmNonGameStorefrontEntry(
  platformId: StorefrontId,
  platformGameId: string,
  gameId?: string
): void {
  const keys = loadConfirmedNonGameKeys();
  if (platformId && platformGameId) {
    keys.delete(`${platformId}:${platformGameId}`);
    keys.delete(`${platformId}-${platformGameId}`);
  }
  if (gameId) {
    keys.delete(gameId);
    keys.delete(`game:${gameId}`);
  }
  persistConfirmedNonGameKeys(keys);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('antigravity:user-override-updated', {
          detail: { type: 'unconfirmed-non-game', platformId, platformGameId, gameId },
        })
      );
    } catch {}
  }
}

/**
 * Hides a specific storefront entitlement (or all storefront entitlements on a game)
 * and records a snapshot so it can be inspected or restored in Catalog Audit & Suppressed Items.
 */
export function hideStorefrontEntry(
  game: CanonicalGame,
  targetPlatformId?: StorefrontId,
  reason?: string
): void {
  if (!game) return;
  try {
    const current = { ...loadHiddenStorefrontEntries() };
    const restoredKeys = loadRestoredNonGameKeys();
    const now = new Date().toISOString();

    if (targetPlatformId) {
      const plat =
        game.platforms?.find((p) => p.platformId === targetPlatformId) ||
        game.platforms?.[0];
      if (plat) {
        const platGameId = String(plat.platformGameId || game.id);
        const rawTitle = plat.originalTitle || game.originalStoreTitle || game.title;
        const singleId =
          (game.platforms?.length || 0) > 1
            ? `${plat.platformId}-${platGameId}`
            : game.id || `${plat.platformId}-${platGameId}`;
        const snapshot: CanonicalGame = {
          ...game,
          id: singleId,
          title: rawTitle,
          sortTitle: rawTitle.replace(/^(The|A|An)\s+/i, '').trim(),
          originalStoreTitle: rawTitle,
          steamAppId:
            plat.platformId === 'steam' && !isNaN(Number(platGameId))
              ? Number(platGameId)
              : undefined,
          platforms: [{ ...plat, originalTitle: rawTitle }],
        };
        const key = `${plat.platformId}:${platGameId}`;
        restoredKeys.delete(key);
        restoredKeys.delete(`${plat.platformId}-${platGameId}`);
        restoredKeys.delete(singleId);
        restoredKeys.delete(`game:${singleId}`);
        restoredKeys.delete(`${singleId}:${plat.platformId}`);
        restoredKeys.delete(`${singleId}-${plat.platformId}`);
        current[key] = {
          key,
          gameId: singleId,
          platformId: plat.platformId,
          platformGameId: platGameId,
          rawTitle,
          hiddenAt: now,
          reason: reason || 'Hidden / Suppressed by User',
          rawGameSnapshot: snapshot,
        };
      }
    } else if (Array.isArray(game.platforms) && game.platforms.length > 0) {
      for (const plat of game.platforms) {
        const platGameId = String(plat.platformGameId || game.id);
        const rawTitle = plat.originalTitle || game.originalStoreTitle || game.title;
        const singleId =
          game.platforms.length > 1
            ? `${plat.platformId}-${platGameId}`
            : game.id || `${plat.platformId}-${platGameId}`;
        const snapshot: CanonicalGame = {
          ...game,
          id: singleId,
          title: rawTitle,
          sortTitle: rawTitle.replace(/^(The|A|An)\s+/i, '').trim(),
          originalStoreTitle: rawTitle,
          steamAppId:
            plat.platformId === 'steam' && !isNaN(Number(platGameId))
              ? Number(platGameId)
              : undefined,
          platforms: [{ ...plat, originalTitle: rawTitle }],
        };
        const key = `${plat.platformId}:${platGameId}`;
        restoredKeys.delete(key);
        restoredKeys.delete(`${plat.platformId}-${platGameId}`);
        restoredKeys.delete(singleId);
        restoredKeys.delete(`game:${singleId}`);
        restoredKeys.delete(game.id);
        restoredKeys.delete(`game:${game.id}`);
        restoredKeys.delete(`${singleId}:${plat.platformId}`);
        restoredKeys.delete(`${singleId}-${plat.platformId}`);
        current[key] = {
          key,
          gameId: singleId,
          platformId: plat.platformId,
          platformGameId: platGameId,
          rawTitle,
          hiddenAt: now,
          reason: reason || 'Hidden / Suppressed by User',
          rawGameSnapshot: snapshot,
        };
      }
    } else {
      const key = `game:${game.id}`;
      const rawTitle = game.originalStoreTitle || game.title;
      restoredKeys.delete(key);
      restoredKeys.delete(game.id);
      current[key] = {
        key,
        gameId: game.id,
        platformId: 'custom',
        platformGameId: game.id,
        rawTitle,
        hiddenAt: now,
        reason: reason || 'Hidden / Suppressed by User',
        rawGameSnapshot: { ...game, originalStoreTitle: rawTitle },
      };
    }

    persistHiddenEntriesMap(current);
    persistRestoredNonGameKeys(restoredKeys);

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', {
            detail: { type: 'hidden', hiddenGameId: game.id, targetPlatformId },
          })
        );
      } catch {}
    }
  } catch (err) {
    console.error('Failed to hide storefront entry:', err);
  }
}

/**
 * Unhides a previously hidden storefront entry (or restores an auto-filtered non-game entry)
 * and returns its CanonicalGame snapshot if found.
 */
export function unhideStorefrontEntry(
  keyOrGameId: string,
  platformId?: StorefrontId,
  platformGameId?: string,
  options?: { silentEvent?: boolean }
): CanonicalGame | undefined {
  if (!keyOrGameId && !platformGameId) return undefined;
  try {
    const current = { ...loadHiddenStorefrontEntries() };
    const restoredKeys = loadRestoredNonGameKeys();
    const confirmedKeys = loadConfirmedNonGameKeys();
    let restoredSnapshot: CanonicalGame | undefined;
    let deleted = false;

    const cleanKeyOrGameId = keyOrGameId ? keyOrGameId.trim() : '';
    const isBareKeyOrGameId =
      Boolean(cleanKeyOrGameId) && BARE_STOREFRONT_KEYS.has(cleanKeyOrGameId.toLowerCase());

    if (cleanKeyOrGameId && !isBareKeyOrGameId) {
      restoredKeys.add(cleanKeyOrGameId);
      restoredKeys.add(`game:${cleanKeyOrGameId}`);
      confirmedKeys.delete(cleanKeyOrGameId);
      confirmedKeys.delete(`game:${cleanKeyOrGameId}`);
    }
    if (platformId && platformGameId) {
      restoredKeys.add(`${platformId}:${platformGameId}`);
      restoredKeys.add(`${platformId}-${platformGameId}`);
      confirmedKeys.delete(`${platformId}:${platformGameId}`);
      confirmedKeys.delete(`${platformId}-${platformGameId}`);
    } else if (
      platformGameId &&
      !platformId &&
      !BARE_STOREFRONT_KEYS.has(platformGameId.trim().toLowerCase())
    ) {
      const cleanPlatGameId = platformGameId.trim();
      restoredKeys.add(`game:${cleanPlatGameId}`);
      if (cleanPlatGameId.includes(':') || cleanPlatGameId.includes('-')) {
        restoredKeys.add(cleanPlatGameId);
      }
    }
    if (cleanKeyOrGameId && !isBareKeyOrGameId && platformId) {
      restoredKeys.add(`${cleanKeyOrGameId}:${platformId}`);
      restoredKeys.add(`${cleanKeyOrGameId}-${platformId}`);
    }
    persistRestoredNonGameKeys(restoredKeys);
    persistConfirmedNonGameKeys(confirmedKeys);

    for (const [key, entry] of Object.entries(current)) {
      if (!entry) continue;
      const matchesKey = key === keyOrGameId;
      const matchesPlatComposite =
        Boolean(platformId && platformGameId && key === `${platformId}:${platformGameId}`);
      const matchesGameId = Boolean(keyOrGameId && entry.gameId === keyOrGameId);
      const matchesSnapId = Boolean(keyOrGameId && entry.rawGameSnapshot?.id === keyOrGameId);
      const matchesPlatFields = Boolean(
        platformId &&
          platformGameId &&
          entry.platformId === platformId &&
          String(entry.platformGameId) === String(platformGameId)
      );

      if (
        matchesKey ||
        matchesPlatComposite ||
        matchesGameId ||
        matchesSnapId ||
        matchesPlatFields
      ) {
        if (!restoredSnapshot && entry.rawGameSnapshot) {
          restoredSnapshot = entry.rawGameSnapshot;
        }
        delete current[key];
        deleted = true;
      }
    }

    if (deleted) {
      persistHiddenEntriesMap(current);
    }

    if (
      !options?.silentEvent &&
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function'
    ) {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', {
            detail: { type: 'unhidden', unhiddenKey: keyOrGameId, platformId, platformGameId },
          })
        );
      } catch {}
    }

    return restoredSnapshot;
  } catch (err) {
    console.error('Failed to unhide storefront entry:', err);
    return undefined;
  }
}

/**
 * Checks whether a specific storefront entitlement or game ID is currently hidden by the user.
 */
export function isStorefrontEntryHidden(
  platformId?: StorefrontId,
  platformGameId?: string,
  gameId?: string
): boolean {
  const map = loadHiddenStorefrontEntries();
  if (!map || Object.keys(map).length === 0) return false;
  if (platformId && platformGameId && map[`${platformId}:${platformGameId}`]) {
    return true;
  }
  if (
    gameId &&
    (map[`game:${gameId}`] ||
      Object.values(map).some(
        (e) =>
          e &&
          (e.gameId === gameId || e.rawGameSnapshot?.id === gameId) &&
          (!platformId || e.platformId === platformId)
      ))
  ) {
    return true;
  }
  return false;
}

function parseOverrideTimestamp(ov?: Partial<UserGameOverride> | null): number {
  if (!ov?.updatedAt) return 0;
  const ts = Date.parse(ov.updatedAt);
  return Number.isFinite(ts) ? ts : 0;
}

function buildNativeBaselineFromGame(game: CanonicalGame): NativeGameBaselineSnapshot {
  const primaryPlat = game.platforms?.[0];
  const steamPlat = game.platforms?.find(
    (p) => p?.platformId === 'steam' && p.platformGameId && !isNaN(Number(p.platformGameId))
  );
  const baseTitle =
    primaryPlat?.originalTitle || game.originalStoreTitle || game.title || game.id;
  return {
    id: game.id,
    title: baseTitle,
    steamAppId:
      typeof game.steamAppId === 'number' && game.steamAppId > 0
        ? game.steamAppId
        : steamPlat
          ? Number(steamPlat.platformGameId)
          : null,
    capsuleImage: game.capsuleImage,
    headerImage: game.headerImage,
    iconUrl: game.iconUrl,
    shortDescription: game.shortDescription,
    detailedDescription: game.detailedDescription,
    developers: Array.isArray(game.developers) ? [...game.developers] : undefined,
    publishers: Array.isArray(game.publishers) ? [...game.publishers] : undefined,
    genres: Array.isArray(game.genres) ? [...game.genres] : undefined,
    tags: Array.isArray(game.tags) ? [...game.tags] : undefined,
    releaseDate: game.releaseDate,
    nativePlatforms: Array.isArray(game.nativePlatforms)
      ? [...game.nativePlatforms]
      : undefined,
    worksOn: game.worksOn
      ? {
          windows: game.worksOn.windows,
          mac: game.worksOn.mac,
          linux: game.worksOn.linux,
        }
      : undefined,
    platforms_os: game.platforms_os
      ? {
          windows: game.platforms_os.windows,
          mac: game.platforms_os.mac,
          linux: game.platforms_os.linux,
        }
      : undefined,
  };
}

function persistUserOverridesMapToStorage(current: UserGameOverridesMap): void {
  const storage = getStorage();
  ensureOverrideStorageListener();
  cachedOverridesMap = current;
  inMemoryOverridesHydrated = true;
  if (storage) {
    const serialized = JSON.stringify(current);
    storage.setItem(STORAGE_KEY_USER_OVERRIDES, serialized);
    cachedStorageRef = storage;
    cachedOverridesRaw = isTestEnv() ? serialized : null;
  }
  bumpUserOverridesRevision();
}

export interface RemoveUserOverrideContext {
  game?: Partial<CanonicalGame> | null;
  override?: Partial<UserGameOverride> | null;
  orphanVaultGameIds?: string[];
}

interface ExtendedRemoveUserOverridePayload {
  gameId: string;
  aliasKeys?: string[];
  orphanVaultGameIds?: string[];
  platforms?: Array<{ platformId: string; platformGameId: string }>;
}

/**
 * Persists a user-defined game override into localStorage (and native Electron if available),
 * consolidating and purging stale pre-rekey alias keys for the same entitlement.
 */
export function saveUserOverride(override: UserGameOverride, oldGame?: CanonicalGame): void {
  if (!override || !override.gameId) return;
  try {
    if (!override.isHidden) {
      unhideStorefrontEntry(
        override.gameId,
        override.platformId as StorefrontId | undefined,
        override.platformGameId,
        { silentEvent: true }
      );
    }

    const current: UserGameOverridesMap = { ...loadUserOverrides() };

    const inferredSinglePlat =
      !override.platformId &&
      !override.platformGameId &&
      Array.isArray(oldGame?.platforms) &&
      oldGame.platforms.length === 1 &&
      oldGame.platforms[0]?.platformId &&
      oldGame.platforms[0]?.platformGameId
        ? oldGame.platforms[0]
        : undefined;

    const effPlatformId = override.platformId || inferredSinglePlat?.platformId;
    const effPlatformGameId =
      override.platformGameId ||
      (inferredSinglePlat?.platformGameId ? String(inferredSinglePlat.platformGameId) : undefined);

    // Find newest pre-existing override across gameId, oldGame.id, and platform composite/dash keys
    const priorCandidates: UserGameOverride[] = [];
    const pushPrior = (ov?: UserGameOverride) => {
      if (ov && !priorCandidates.includes(ov)) priorCandidates.push(ov);
    };
    pushPrior(current[override.gameId]);
    if (oldGame?.id && !override.splitFromMerged) {
      pushPrior(current[oldGame.id]);
    }
    if (effPlatformId && effPlatformGameId) {
      pushPrior(current[`${effPlatformId}:${effPlatformGameId}`]);
      pushPrior(current[`${effPlatformId}-${effPlatformGameId}`]);
      pushPrior(current[`${effPlatformId.toLowerCase()}:${effPlatformGameId.toLowerCase()}`]);
      pushPrior(current[`${effPlatformId.toLowerCase()}-${effPlatformGameId.toLowerCase()}`]);
    }
    priorCandidates.sort((a, b) => parseOverrideTimestamp(b) - parseOverrideTimestamp(a));
    const priorExisting = priorCandidates[0];

    const updatedOverride: UserGameOverride = {
      ...override,
      ...(effPlatformId && !override.platformId ? { platformId: effPlatformId } : {}),
      ...(effPlatformGameId && !override.platformGameId
        ? { platformGameId: effPlatformGameId }
        : {}),
      updatedAt: override.updatedAt || new Date().toISOString(),
    };

    if (!updatedOverride.nativeBaseline) {
      if (priorExisting?.nativeBaseline) {
        updatedOverride.nativeBaseline = priorExisting.nativeBaseline;
      } else if (oldGame && !priorExisting) {
        updatedOverride.nativeBaseline = buildNativeBaselineFromGame(oldGame);
      }
    }

    if (typeof updatedOverride.shortDescription === 'string') {
      if (/<[a-z][\s\S]*>/i.test(updatedOverride.shortDescription) && !updatedOverride.detailedDescription) {
        updatedOverride.detailedDescription = updatedOverride.shortDescription;
      }
      updatedOverride.shortDescription = sanitizePlainSynopsis(updatedOverride.shortDescription);
    }
    if (override.reviewScoreOverride !== undefined) {
      updatedOverride.reviewScoreOverride = override.reviewScoreOverride;
    } else if (priorExisting?.reviewScoreOverride !== undefined) {
      updatedOverride.reviewScoreOverride = priorExisting.reviewScoreOverride;
    }

    if (override.reviewRoute !== undefined) {
      updatedOverride.reviewRoute = override.reviewRoute;
    } else if (override.reviewScoreOverride === undefined && priorExisting?.reviewRoute !== undefined) {
      updatedOverride.reviewRoute = priorExisting.reviewRoute;
    }

    if (updatedOverride.reviewScoreOverride !== undefined && updatedOverride.reviewRoute === undefined) {
      updatedOverride.reviewRoute = inferReviewRouteFromOverride(updatedOverride);
    }

    if (override.metadataRoute !== undefined) {
      updatedOverride.metadataRoute = inferMetadataRouteFromOverride(updatedOverride);
    } else if (priorExisting?.metadataRoute !== undefined) {
      updatedOverride.metadataRoute = priorExisting.metadataRoute;
    } else {
      updatedOverride.metadataRoute = inferMetadataRouteFromOverride(updatedOverride);
    }

    const keepKeys = new Set<string>([override.gameId]);
    if (updatedOverride.platformId && updatedOverride.platformGameId) {
      keepKeys.add(`${updatedOverride.platformId}:${updatedOverride.platformGameId}`);
      if (updatedOverride.splitFromMerged) {
        keepKeys.add(`${updatedOverride.platformId}-${updatedOverride.platformGameId}`);
      }
    }

    const staleKeysToDelete: string[] = [];
    const targetPlatLower = updatedOverride.platformId?.toLowerCase();
    const targetPlatGidLower = updatedOverride.platformGameId
      ? String(updatedOverride.platformGameId).toLowerCase()
      : undefined;

    for (const [k, existingOv] of Object.entries(current)) {
      if (keepKeys.has(k)) continue;
      let isStaleAlias = false;
      if (
        oldGame?.id &&
        oldGame.id !== override.gameId &&
        !override.splitFromMerged &&
        (k === oldGame.id || existingOv?.gameId === oldGame.id)
      ) {
        isStaleAlias = true;
      } else if (targetPlatLower && targetPlatGidLower) {
        const kLower = k.toLowerCase();
        if (
          kLower === `${targetPlatLower}:${targetPlatGidLower}` ||
          kLower === `${targetPlatLower}-${targetPlatGidLower}` ||
          kLower === `${targetPlatLower}_${targetPlatGidLower}` ||
          (targetPlatLower !== 'steam' && kLower === targetPlatGidLower)
        ) {
          isStaleAlias = true;
        } else if (
          existingOv?.platformId?.toLowerCase() === targetPlatLower &&
          String(existingOv.platformGameId || '').toLowerCase() === targetPlatGidLower
        ) {
          isStaleAlias = true;
        }
      }
      if (isStaleAlias) {
        delete current[k];
        staleKeysToDelete.push(k);
      }
    }

    current[override.gameId] = updatedOverride;

    // Also index platform key if available (e.g., 'epic:boga' or 'gog:1837805079')
    if (updatedOverride.platformId && updatedOverride.platformGameId) {
      const platformKey = `${updatedOverride.platformId}:${updatedOverride.platformGameId}`;
      current[platformKey] = updatedOverride;
      if (updatedOverride.splitFromMerged) {
        const dashKey = `${updatedOverride.platformId}-${updatedOverride.platformGameId}`;
        current[dashKey] = updatedOverride;
      }
    }

    persistUserOverridesMapToStorage(current);

    // Notify window listeners reactively
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', { detail: { override: updatedOverride, oldGame } })
        );
      } catch {}
    }

    // Optional Electron IPC sync if available
    if (typeof window !== 'undefined' && typeof window.electronAPI?.saveUserOverride === 'function') {
      try {
        void window.electronAPI.saveUserOverride(updatedOverride);
      } catch (ipcErr) {
        console.warn('Failed to sync user override to Electron:', ipcErr);
      }
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.saveUserOverride === 'function'
    ) {
      try {
        const vaultPayload: object =
          staleKeysToDelete.length > 0
            ? { ...updatedOverride, purgeKeys: staleKeysToDelete }
            : updatedOverride;
        void window.electronAPI.offlineVault
          .saveUserOverride(updatedOverride.gameId, vaultPayload)
          ?.catch?.(() => {});
      } catch (vaultErr) {
        console.warn('Failed to sync user override to offlineVault:', vaultErr);
      }
    }
  } catch (err) {
    console.error('Failed to save user game override:', err);
  }
}

/**
 * Removes a user-defined game override across its canonical ID and all composite/dash/underscore/bare
 * platform alias keys so no zombie override record survives in memory, localStorage, or offlineVault.
 */
export function removeUserOverride(
  gameId: string,
  context?: RemoveUserOverrideContext
): UserGameOverride | undefined {
  if (!gameId) return undefined;
  try {
    const current: UserGameOverridesMap = { ...loadUserOverrides() };

    const entitlementPairs = new Map<string, { platformId: string; platformGameId: string }>();
    const addEntitlementPair = (platId?: string | null, platGameId?: string | number | null) => {
      if (!platId || platGameId === undefined || platGameId === null) return;
      const pClean = String(platId).trim();
      const gClean = String(platGameId).trim();
      if (!pClean || !gClean) return;
      const mapKey = `${pClean.toLowerCase()}:${gClean.toLowerCase()}`;
      if (!entitlementPairs.has(mapKey)) {
        entitlementPairs.set(mapKey, { platformId: pClean.toLowerCase(), platformGameId: gClean });
      }
    };

    const directExisting = current[gameId];
    const ctxOverride = context?.override;
    if (directExisting?.platformId && directExisting?.platformGameId) {
      addEntitlementPair(directExisting.platformId, directExisting.platformGameId);
    }
    if (ctxOverride?.platformId && ctxOverride?.platformGameId) {
      addEntitlementPair(ctxOverride.platformId, ctxOverride.platformGameId);
    }
    for (const ov of Object.values(current)) {
      if (ov && (ov.gameId === gameId || (context?.game?.id && ov.gameId === context.game.id))) {
        if (ov.platformId && ov.platformGameId) {
          addEntitlementPair(ov.platformId, ov.platformGameId);
        }
      }
    }

    const isSplitTarget = Boolean(directExisting?.splitFromMerged || ctxOverride?.splitFromMerged);
    if (!isSplitTarget && Array.isArray(context?.game?.platforms)) {
      for (const plat of context!.game!.platforms!) {
        if (plat?.platformId && plat?.platformGameId) {
          addEntitlementPair(plat.platformId, plat.platformGameId);
        }
      }
    }

    const parsedComposite = gameId.match(/^(steam|gog|epic|xbox|custom)[:\-_](.+)$/i);
    if (parsedComposite) {
      addEntitlementPair(parsedComposite[1], parsedComposite[2]);
    }

    const explicitKeysLower = new Set<string>([gameId.toLowerCase()]);
    const explicitGameIds = new Set<string>([gameId]);
    if (context?.game?.id) {
      explicitKeysLower.add(context.game.id.toLowerCase());
      explicitGameIds.add(context.game.id);
    }
    if (ctxOverride?.gameId) {
      explicitKeysLower.add(ctxOverride.gameId.toLowerCase());
      explicitGameIds.add(ctxOverride.gameId);
    }
    if (ctxOverride?.nativeBaseline?.id) {
      explicitKeysLower.add(ctxOverride.nativeBaseline.id.toLowerCase());
      explicitGameIds.add(ctxOverride.nativeBaseline.id);
    }

    for (const { platformId, platformGameId } of entitlementPairs.values()) {
      for (const gidVariant of [
        platformGameId,
        platformGameId.toLowerCase(),
        platformGameId.toUpperCase(),
      ]) {
        const cKey = `${platformId}:${gidVariant}`.toLowerCase();
        const dKey = `${platformId}-${gidVariant}`.toLowerCase();
        const uKey = `${platformId}_${gidVariant}`.toLowerCase();
        explicitKeysLower.add(cKey);
        explicitKeysLower.add(dKey);
        explicitKeysLower.add(uKey);
        if (platformId !== 'steam') {
          explicitKeysLower.add(gidVariant.toLowerCase());
        }
      }
    }

    const matchedOverrides: UserGameOverride[] = [];
    const keysToDelete = new Set<string>();

    const ownsEntitlement = (platId?: string, platGid?: string | number): boolean => {
      if (!platId || platGid === undefined || platGid === null) return false;
      return entitlementPairs.has(`${platId.toLowerCase()}:${String(platGid).toLowerCase()}`);
    };

    for (const [key, ov] of Object.entries(current)) {
      if (!ov) continue;
      const keyLower = key.toLowerCase();
      const matched =
        explicitKeysLower.has(keyLower) ||
        (Boolean(ov.gameId) && explicitGameIds.has(ov.gameId)) ||
        ownsEntitlement(ov.platformId, ov.platformGameId);

      if (matched) {
        keysToDelete.add(key);
        if (!matchedOverrides.includes(ov)) {
          matchedOverrides.push(ov);
        }
        if (ov.nativeBaseline?.id) {
          explicitKeysLower.add(ov.nativeBaseline.id.toLowerCase());
        }
      }
    }

    // Second pass: also catch any steam-<appId> key created by a matched override for the same entitlement
    for (const matchedOv of matchedOverrides) {
      const candidateSteamId =
        typeof matchedOv.steamAppId === 'number' && matchedOv.steamAppId > 0
          ? matchedOv.steamAppId
          : matchedOv.matchedStore === 'steam' &&
              matchedOv.matchedId &&
              !isNaN(Number(matchedOv.matchedId))
            ? Number(matchedOv.matchedId)
            : undefined;
      if (candidateSteamId) {
        for (const sKey of [`steam-${candidateSteamId}`, String(candidateSteamId)]) {
          const sOv = current[sKey];
          if (!sOv) continue;
          const belongsToUnrelatedEntitlement =
            Boolean(sOv.platformId && sOv.platformGameId) &&
            !ownsEntitlement(sOv.platformId, sOv.platformGameId) &&
            !explicitGameIds.has(sOv.gameId);
          if (!belongsToUnrelatedEntitlement) {
            keysToDelete.add(sKey);
            if (!matchedOverrides.includes(sOv)) {
              matchedOverrides.push(sOv);
            }
          }
        }
      }
    }

    matchedOverrides.sort((a, b) => parseOverrideTimestamp(b) - parseOverrideTimestamp(a));
    const removedOverride: UserGameOverride | undefined =
      matchedOverrides[0] ??
      (ctxOverride && ctxOverride.gameId ? (ctxOverride as UserGameOverride) : undefined);

    const deletedKeys: string[] = [];
    for (const k of keysToDelete) {
      if (Object.prototype.hasOwnProperty.call(current, k)) {
        delete current[k];
        deletedKeys.push(k);
      }
    }

    if (deletedKeys.length > 0) {
      persistUserOverridesMapToStorage(current);
    }

    const platformsPayload = Array.from(entitlementPairs.values());

    // Notify window listeners reactively
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        const detailPayload: {
          gameId: string;
          deletedKeys?: string[];
          removedOverride?: UserGameOverride;
          oldOverride?: UserGameOverride;
          oldGame?: Partial<CanonicalGame>;
        } = {
          gameId,
          ...(deletedKeys.length > 0 ? { deletedKeys } : {}),
          ...(removedOverride !== undefined
            ? { removedOverride, oldOverride: removedOverride }
            : {}),
          ...(context?.game ? { oldGame: context.game } : {}),
        };
        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-removed', { detail: detailPayload })
        );
      } catch {}
    }

    // Electron persistence: prefer offlineVault.removeUserOverride with full alias/orphan payload,
    // falling back to electronAPI.removeUserOverride only when offlineVault.removeUserOverride is unavailable.
    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.removeUserOverride === 'function'
    ) {
      try {
        const removePayload: ExtendedRemoveUserOverridePayload = {
          gameId,
          ...(deletedKeys.length > 0 ? { aliasKeys: deletedKeys } : {}),
          ...(context?.orphanVaultGameIds && context.orphanVaultGameIds.length > 0
            ? { orphanVaultGameIds: context.orphanVaultGameIds }
            : {}),
          ...(platformsPayload.length > 0 ? { platforms: platformsPayload } : {}),
        };
        void window.electronAPI.offlineVault
          .removeUserOverride(removePayload as { gameId: string })
          ?.catch?.(() => {});
      } catch (vaultErr) {
        console.warn('Failed to remove user override in offlineVault:', vaultErr);
      }
    } else if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.removeUserOverride === 'function'
    ) {
      try {
        void window.electronAPI.removeUserOverride(gameId);
      } catch (ipcErr) {
        console.warn('Failed to remove user override in Electron:', ipcErr);
      }
    }

    return removedOverride;
  } catch (err) {
    console.error('Failed to remove user game override:', err);
    return undefined;
  }
}

interface OverrideLookupIndex {
  isEmpty: boolean;
  byGameId: Map<string, UserGameOverride[]>;
  byPlatComposite: Map<string, UserGameOverride[]>;
  byBarePlatGameId: Map<string, UserGameOverride[]>;
}

const overrideLookupIndexCache = new WeakMap<UserGameOverridesMap, OverrideLookupIndex>();

function pushUniqueOverride(
  bucketMap: Map<string, UserGameOverride[]>,
  key: string,
  ov: UserGameOverride
): void {
  if (!key) return;
  let bucket = bucketMap.get(key);
  if (!bucket) {
    bucket = [ov];
    bucketMap.set(key, bucket);
  } else if (!bucket.includes(ov)) {
    bucket.push(ov);
  }
}

function getOverrideLookupIndex(map: UserGameOverridesMap): OverrideLookupIndex {
  const cached = overrideLookupIndexCache.get(map);
  if (cached) return cached;

  const byGameId = new Map<string, UserGameOverride[]>();
  const byPlatComposite = new Map<string, UserGameOverride[]>();
  const byBarePlatGameId = new Map<string, UserGameOverride[]>();
  let hasAny = false;

  for (const key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    const ov = map[key];
    if (!ov) continue;
    hasAny = true;
    if (ov.gameId) {
      pushUniqueOverride(byGameId, ov.gameId, ov);
    }
    if (ov.platformGameId) {
      const bareId = String(ov.platformGameId);
      pushUniqueOverride(byBarePlatGameId, bareId, ov);
      pushUniqueOverride(byBarePlatGameId, bareId.toLowerCase(), ov);
      if (ov.platformId) {
        pushUniqueOverride(byPlatComposite, `${ov.platformId}:${bareId}`, ov);
        pushUniqueOverride(
          byPlatComposite,
          `${ov.platformId.toLowerCase()}:${bareId.toLowerCase()}`,
          ov
        );
      }
    }
  }

  const built: OverrideLookupIndex = {
    isEmpty: !hasAny,
    byGameId,
    byPlatComposite,
    byBarePlatGameId,
  };
  overrideLookupIndexCache.set(map, built);
  return built;
}

/**
 * Retrieves a matching user override for a canonical game.
 * Gathers all compatible candidate overrides across game.id, steamAppId, and composite/dash/underscore/bare
 * platform keys and deterministically returns the candidate with the newest `updatedAt` timestamp.
 */
export function getUserOverrideForGame(
  game: CanonicalGame,
  overrides?: UserGameOverridesMap
): UserGameOverride | undefined {
  if (!game) return undefined;
  const map = overrides ?? loadUserOverrides();
  if (!map) return undefined;
  const idx = getOverrideLookupIndex(map);
  if (idx.isEmpty) return undefined;

  const hasPlatforms = Array.isArray(game.platforms) && game.platforms.length > 0;

  const isCompatibleWithGame = (ov?: UserGameOverride): boolean => {
    if (!ov) return false;
    if (ov.splitFromMerged) {
      if (!hasPlatforms || game.platforms.length !== 1) return false;
      const p = game.platforms[0];
      if (ov.platformId && String(p.platformId).toLowerCase() !== String(ov.platformId).toLowerCase()) {
        return false;
      }
      if (
        ov.platformGameId &&
        String(p.platformGameId).toLowerCase() !== String(ov.platformGameId).toLowerCase()
      ) {
        return false;
      }
      return true;
    }

    // If an override explicitly pins a non-Steam platform entitlement and `game.platforms` is populated,
    // verify `game` either has that exact gameId or owns that platform entitlement so overrides never bleed across entitlements.
    if (hasPlatforms && ov.platformId && ov.platformGameId) {
      if (game.id && ov.gameId && game.id === ov.gameId) {
        const ownsMatchingPlat = game.platforms.some(
          (p) =>
            p &&
            String(p.platformId).toLowerCase() === String(ov.platformId).toLowerCase() &&
            String(p.platformGameId).toLowerCase() === String(ov.platformGameId).toLowerCase()
        );
        if (ownsMatchingPlat) return true;
        // Allow direct game.id match only when game does NOT exclusively belong to a conflicting storefront entitlement
        const onlySteamWithoutTargetStore = game.platforms.every(
          (p) => String(p?.platformId).toLowerCase() !== String(ov.platformId).toLowerCase()
        );
        if (onlySteamWithoutTargetStore && game.platforms.some((p) => p?.platformId === 'steam')) {
          return false;
        }
        return true;
      }
      return game.platforms.some(
        (p) =>
          p &&
          String(p.platformId).toLowerCase() === String(ov.platformId).toLowerCase() &&
          String(p.platformGameId).toLowerCase() === String(ov.platformGameId).toLowerCase()
      );
    }

    return true;
  };

  let bestCandidate: UserGameOverride | undefined;
  let bestTs = -1;
  let bestRank = Number.POSITIVE_INFINITY;

  const considerCandidate = (ov: UserGameOverride | undefined, rank: number) => {
    if (!ov || !isCompatibleWithGame(ov)) return;
    if (bestCandidate === ov) {
      if (rank < bestRank) bestRank = rank;
      return;
    }
    const ts = parseOverrideTimestamp(ov);
    if (bestCandidate === undefined || ts > bestTs || (ts === bestTs && rank < bestRank)) {
      bestCandidate = ov;
      bestTs = ts;
      bestRank = rank;
    }
  };

  // 1. Direct match on game.id
  if (game.id) {
    considerCandidate(map[game.id], 0);
  }

  // 2. Platform composite, dash, underscore, and bare platformGameId keys
  if (hasPlatforms) {
    for (const p of game.platforms) {
      if (!p || !p.platformGameId) continue;
      const pId = String(p.platformId || '');
      const pIdLower = pId.toLowerCase();
      const bareId = String(p.platformGameId);
      const bareLower = bareId.toLowerCase();

      considerCandidate(map[`${pId}:${bareId}`], 1);
      if (`${pIdLower}:${bareLower}` !== `${pId}:${bareId}`) {
        considerCandidate(map[`${pIdLower}:${bareLower}`], 1);
      }
      if (pIdLower === 'xbox') {
        considerCandidate(map[`xbox:${bareId.toUpperCase()}`], 1);
      }

      considerCandidate(map[`${pId}-${bareId}`], 2);
      considerCandidate(map[`${pIdLower}-${bareLower}`], 2);
      considerCandidate(map[`${pId}_${bareId}`], 2);
      considerCandidate(map[`${pIdLower}_${bareLower}`], 2);
      if (pIdLower !== 'steam') {
        considerCandidate(map[bareId], 2);
        if (bareLower !== bareId) {
          considerCandidate(map[bareLower], 2);
        }
      }
    }
  }

  // 3. Direct match on steamAppId
  if (game.steamAppId) {
    considerCandidate(map[`steam-${game.steamAppId}`], 3);
    considerCandidate(map[String(game.steamAppId)], 3);
  }

  // 4. O(1) pre-indexed secondary lookup across all stored overrides
  if (game.id) {
    const byIdCandidates = idx.byGameId.get(game.id);
    if (byIdCandidates) {
      for (const cand of byIdCandidates) {
        considerCandidate(cand, 4);
      }
    }
  }

  if (hasPlatforms) {
    for (const p of game.platforms) {
      if (!p || !p.platformGameId) continue;
      const bareId = String(p.platformGameId);
      const bareLower = bareId.toLowerCase();
      if (p.platformId) {
        const pLower = String(p.platformId).toLowerCase();
        const compCandidates =
          idx.byPlatComposite.get(`${p.platformId}:${bareId}`) ||
          idx.byPlatComposite.get(`${pLower}:${bareLower}`);
        if (compCandidates) {
          for (const cand of compCandidates) {
            considerCandidate(cand, 4);
          }
        }
      }
      const bareCandidates =
        idx.byBarePlatGameId.get(bareId) || idx.byBarePlatGameId.get(bareLower);
      if (bareCandidates) {
        for (const cand of bareCandidates) {
          if (!cand.platformId || String(p.platformId).toLowerCase() === cand.platformId.toLowerCase()) {
            considerCandidate(cand, 5);
          }
        }
      }
    }
  }

  return bestCandidate;
}

/**
 * Updates the cached metadata snapshot on a routed UserGameOverride without overwriting
 * user-pinned custom fields (such as customTitleEdited, customSynopsisEdited, capsuleImage, or existing headerImage).
 */
export function updateRoutedMetadataSnapshot(
  gameId: string,
  refreshed: Partial<UserGameOverride>
): void {
  if (!gameId || !refreshed) return;
  try {
    const current: UserGameOverridesMap = { ...loadUserOverrides() };
    const existing =
      current[gameId] ||
      Object.values(current).find((ov) => ov && ov.gameId === gameId);
    if (!existing) return;

    const route = inferMetadataRouteFromOverride(existing);
    if (!route || route.mode === 'custom') return;

    const next: UserGameOverride = { ...existing };

    if (!route.customTitleEdited && refreshed.title && refreshed.title.trim()) {
      next.title = refreshed.title.trim();
      next.sortTitle = refreshed.title.replace(/^(The|A|An)\s+/i, '').trim();
    }
    if (!route.customSynopsisEdited && refreshed.shortDescription && refreshed.shortDescription.trim()) {
      next.shortDescription = sanitizePlainSynopsis(refreshed.shortDescription);
    }
    if (refreshed.detailedDescription && refreshed.detailedDescription.trim()) {
      next.detailedDescription = refreshed.detailedDescription;
    }
    // Preserve any existing custom capsuleImage and non-empty headerImage on the user override
    if (
      !route.customHeaderEdited &&
      (!existing.headerImage || !existing.headerImage.trim()) &&
      refreshed.headerImage &&
      refreshed.headerImage.trim()
    ) {
      next.headerImage = refreshed.headerImage.trim();
    }
    if (Array.isArray(refreshed.developers) && refreshed.developers.length > 0) {
      next.developers = [...refreshed.developers];
    }
    if (Array.isArray(refreshed.publishers) && refreshed.publishers.length > 0) {
      next.publishers = [...refreshed.publishers];
    }
    if (Array.isArray(refreshed.genres) && refreshed.genres.length > 0) {
      next.genres = [...refreshed.genres];
    }
    if (Array.isArray(refreshed.tags) && refreshed.tags.length > 0) {
      next.tags = [...refreshed.tags];
    }
    if (refreshed.releaseDate && refreshed.releaseDate.trim() && refreshed.releaseDate !== 'TBA') {
      next.releaseDate = refreshed.releaseDate.trim();
    }

    current[gameId] = next;
    if (existing.gameId) {
      current[existing.gameId] = next;
    }
    if (existing.platformId && existing.platformGameId) {
      current[`${existing.platformId}:${existing.platformGameId}`] = next;
      if (existing.splitFromMerged) {
        current[`${existing.platformId}-${existing.platformGameId}`] = next;
      }
    }

    persistUserOverridesMapToStorage(current);

    const canonicalId = (next.gameId || gameId).trim();
    if (
      canonicalId &&
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.saveUserOverride === 'function'
    ) {
      try {
        void window.electronAPI.offlineVault
          .saveUserOverride(canonicalId, next as unknown as object)
          ?.catch?.(() => {});
      } catch {
        // Ignore non-fatal IPC errors during snapshot update
      }
    }
  } catch (err) {
    console.warn('Failed to update routed metadata snapshot:', err);
  }
}

/**
 * Applies a user-defined override to a CanonicalGame.
 * User intent has absolute authority:
 * - If override.steamAppId === null, sets steamAppId = undefined so it is treated as non-Steam.
 * - Explicit fields overwrite incoming metadata.
 * - Stale enrichedMetadata from an old/unmatched storefront is automatically invalidated.
 */
export function applyUserOverrideToGame(
  game: CanonicalGame,
  override: UserGameOverride,
  options?: { invalidateEnrichedCache?: boolean }
): CanonicalGame {
  if (!game || !override) return game;
  const updated: CanonicalGame = { ...game };
  const route = inferMetadataRouteFromOverride(override);

  const rawSourceTitle =
    game.originalStoreTitle ||
    override.originalSourceTitle ||
    game.platforms?.[0]?.originalTitle ||
    game.title;
  updated.originalStoreTitle = rawSourceTitle;
  if (Array.isArray(updated.platforms)) {
    updated.platforms = updated.platforms.map((p) => ({
      ...p,
      originalTitle: p.originalTitle || rawSourceTitle,
    }));
  }

  if (override.title !== undefined && override.title.trim() !== '') {
    updated.title = override.title.trim();
  }
  if (override.sortTitle !== undefined && override.sortTitle.trim() !== '') {
    updated.sortTitle = override.sortTitle.trim();
  } else if (override.title) {
    updated.sortTitle = override.title.replace(/^(The|A|An)\s+/i, '').trim();
  }

  // Steam App ID: null explicitly means unlinked from Steam
  if (override.steamAppId === null) {
    updated.steamAppId = undefined;
    updated.isExplicitNonSteam = true;
  } else if (typeof override.steamAppId === 'number') {
    updated.steamAppId = override.steamAppId;
    updated.isExplicitNonSteam = false;
  } else if (route?.source === 'steam' && typeof route.steamAppId === 'number' && route.steamAppId > 0) {
    updated.steamAppId = route.steamAppId;
    updated.isExplicitNonSteam = false;
  }

  if (override.isExplicitNonSteam !== undefined) {
    updated.isExplicitNonSteam = override.isExplicitNonSteam;
  }

  // Invalidate stale enrichedMetadata if explicitly requested (e.g. wizard apply)
  // or if existing enrichedMetadata came from a mismatched Steam App ID / different store route
  if (options?.invalidateEnrichedCache) {
    updated.enrichedMetadata = undefined;
  } else if (updated.enrichedMetadata) {
    const existingEnrichedAppId = updated.enrichedMetadata.appId;
    if (
      (updated.isExplicitNonSteam && existingEnrichedAppId > 0) ||
      (typeof updated.steamAppId === 'number' &&
        existingEnrichedAppId > 0 &&
        existingEnrichedAppId !== updated.steamAppId) ||
      ((route?.source === 'gog' || route?.source === 'epic' || route?.source === 'igdb') &&
        existingEnrichedAppId > 0)
    ) {
      updated.enrichedMetadata = undefined;
    }
  }

  if (override.capsuleImage !== undefined && override.capsuleImage.trim() !== '') {
    updated.capsuleImage = override.capsuleImage.trim();
  }
  if (override.headerImage !== undefined && override.headerImage.trim() !== '') {
    updated.headerImage = override.headerImage.trim();
  }
  if (override.iconUrl !== undefined && override.iconUrl.trim() !== '') {
    updated.iconUrl = override.iconUrl.trim();
  }

  if (override.shortDescription !== undefined) {
    if (
      /<[a-z][\s\S]*>/i.test(override.shortDescription) &&
      override.detailedDescription === undefined &&
      !updated.detailedDescription
    ) {
      updated.detailedDescription = override.shortDescription;
    }
    updated.shortDescription = sanitizePlainSynopsis(override.shortDescription);
  }
  if (override.detailedDescription !== undefined) {
    updated.detailedDescription = override.detailedDescription;
  }

  if (Array.isArray(override.developers)) {
    updated.developers = [...override.developers];
  }
  if (Array.isArray(override.publishers)) {
    updated.publishers = [...override.publishers];
  }
  if (Array.isArray(override.genres)) {
    updated.genres = [...override.genres];
  }
  if (Array.isArray(override.tags)) {
    updated.tags = [...override.tags];
  }
  if (override.releaseDate !== undefined) {
    updated.releaseDate = override.releaseDate;
  }
  if (override.reviewScoreOverride !== undefined) {
    updated.reviewScoreOverride = override.reviewScoreOverride;
  }

  return updated;
}

/**
 * Returns all persisted user overrides.
 */
export function getAllUserOverrides(): UserGameOverridesMap {
  return loadUserOverrides();
}

/**
 * Applies all user-defined overrides across an entire canonical catalog.
 */
export function applyUserOverridesToCatalog(
  catalog: CanonicalGame[],
  overrides?: UserGameOverridesMap
): CanonicalGame[] {
  if (!Array.isArray(catalog)) return [];
  const map = overrides ?? loadUserOverrides();
  if (!map || getOverrideLookupIndex(map).isEmpty) return catalog;

  return catalog.map((game) => {
    const ov = getUserOverrideForGame(game, map);
    return ov ? applyUserOverrideToGame(game, ov) : game;
  });
}

export interface EffectiveSteamLookupInput {
  id?: string;
  title?: string;
  steamAppId?: number | null;
  isExplicitNonSteam?: boolean;
  enrichedMetadata?: CanonicalGame['enrichedMetadata'];
  platforms?: Array<{
    platformId: StorefrontId;
    platformGameId: string;
  }>;
}

let registeredInstantSteamTitleMatcher: ((title: string) => number | null) | null = null;

/**
 * Registers the instant offline Steam title matcher so userOverrideStorage and steamMatcher
 * share a single authoritative `getEffectiveSteamAppId` resolution pipeline without circular init issues.
 */
export function registerInstantSteamTitleMatcher(
  matcher: ((title: string) => number | null) | null
): void {
  registeredInstantSteamTitleMatcher = matcher;
}

/**
 * Authoritative unified resolver for a game's effective Steam App ID, respecting user overrides,
 * explicit non-Steam flags, routed storefront overrides, platform entitlements, and instant title matching.
 */
export function resolveEffectiveSteamAppId(
  game?: EffectiveSteamLookupInput | CanonicalGame | null,
  instantTitleMatcher?: ((title: string) => number | null) | null
): number | undefined {
  if (!game) return undefined;
  const hasLookupIdentity = Boolean(
    game.id ||
      (typeof game.steamAppId === 'number' && game.steamAppId > 0) ||
      (Array.isArray(game.platforms) && game.platforms.length > 0)
  );
  const ov = hasLookupIdentity ? getUserOverrideForGame(game as CanonicalGame) : undefined;
  if (
    ov?.steamAppId === null ||
    ov?.isExplicitNonSteam === true ||
    game.isExplicitNonSteam === true ||
    game.steamAppId === null
  ) {
    return undefined;
  }
  if (typeof ov?.steamAppId === 'number' && ov.steamAppId > 0) {
    return ov.steamAppId;
  }
  const route = inferMetadataRouteFromOverride(ov);
  if (route?.source === 'steam' && typeof route.steamAppId === 'number' && route.steamAppId > 0) {
    return route.steamAppId;
  }
  if (route?.mode === 'routed' && route.source !== 'steam') {
    return undefined;
  }
  if (typeof game.steamAppId === 'number' && game.steamAppId > 0) {
    return game.steamAppId;
  }
  const steamPlat = game.platforms?.find(
    (p) => p.platformId === 'steam' && p.platformGameId && !isNaN(Number(p.platformGameId))
  );
  if (steamPlat) {
    return Number(steamPlat.platformGameId);
  }
  const meta = game.enrichedMetadata;
  if (
    typeof meta?.appId === 'number' &&
    meta.appId > 0 &&
    meta.enrichedSource !== 'xbox' &&
    (meta.enrichedSource === 'steam' || meta.metadataQuality === 'authoritative')
  ) {
    return meta.appId;
  }
  const matcher =
    instantTitleMatcher !== undefined ? instantTitleMatcher : registeredInstantSteamTitleMatcher;
  if (matcher && game.title) {
    return matcher(game.title) || undefined;
  }
  return undefined;
}

let inFlightVaultOverrideSync: Promise<boolean> | null = null;

/**
 * Reconciles canonical user overrides between renderer `localStorage` and Electron `offlineVault`
 * (`user_overrides.json`) by `updatedAt` timestamp (newest wins), hydrating missing/newer vault
 * overrides into `localStorage` and pushing canonical `localStorage` overrides missing/older in
 * `offlineVault` without duplicating internal `platform:id` alias keys.
 */
export async function hydrateUserOverridesFromVault(): Promise<boolean> {
  if (inFlightVaultOverrideSync) {
    return inFlightVaultOverrideSync;
  }
  if (
    typeof window === 'undefined' ||
    typeof window.electronAPI?.offlineVault?.getUserOverrides !== 'function'
  ) {
    return false;
  }

  inFlightVaultOverrideSync = (async (): Promise<boolean> => {
    try {
      const vaultRaw = await window.electronAPI!.offlineVault!.getUserOverrides();
      const localMap: UserGameOverridesMap = { ...loadUserOverrides() };

      const canonicalLocal: Record<string, UserGameOverride> = {};
      for (const [key, ov] of Object.entries(localMap)) {
        if (!ov || typeof ov !== 'object') continue;
        const canonicalId =
          typeof ov.gameId === 'string' && ov.gameId.trim()
            ? ov.gameId.trim()
            : !key.includes(':')
            ? key.trim()
            : '';
        if (!canonicalId) continue;
        const prev = canonicalLocal[canonicalId];
        const prevTs = prev ? Date.parse(prev.updatedAt || '') || 0 : -1;
        const curTs = Date.parse(ov.updatedAt || '') || 0;
        if (!prev || curTs >= prevTs) {
          canonicalLocal[canonicalId] = { ...ov, gameId: canonicalId };
        }
      }

      const canonicalVault: Record<string, UserGameOverride> = {};
      if (vaultRaw && typeof vaultRaw === 'object' && !Array.isArray(vaultRaw)) {
        for (const [key, rawOv] of Object.entries(vaultRaw)) {
          if (!rawOv || typeof rawOv !== 'object' || Array.isArray(rawOv)) continue;
          const typedOv = rawOv as unknown as Partial<UserGameOverride>;
          const canonicalId =
            typeof typedOv.gameId === 'string' && typedOv.gameId.trim()
              ? typedOv.gameId.trim()
              : !key.includes(':')
              ? key.trim()
              : '';
          if (!canonicalId) continue;
          const prev = canonicalVault[canonicalId];
          const prevTs = prev ? Date.parse(prev.updatedAt || '') || 0 : -1;
          const curTs = Date.parse(typedOv.updatedAt || '') || 0;
          if (!prev || curTs >= prevTs) {
            canonicalVault[canonicalId] = {
              ...(typedOv as UserGameOverride),
              gameId: canonicalId,
              updatedAt: typedOv.updatedAt || new Date(0).toISOString(),
            };
          }
        }
      }

      // Deduplicate vault entries that share the same non-Steam (platformId, platformGameId) entitlement
      // so stale pre-rekey records (e.g. 'gog-123' superseded by 'steam-456') never overwrite or resurrect.
      const newestVaultByEntitlement = new Map<string, { gameId: string; ts: number }>();
      for (const [gameId, vaultOv] of Object.entries(canonicalVault)) {
        if (!vaultOv.platformId || !vaultOv.platformGameId || vaultOv.splitFromMerged) continue;
        const entKey = `${vaultOv.platformId.toLowerCase()}:${String(vaultOv.platformGameId).toLowerCase()}`;
        const ts = parseOverrideTimestamp(vaultOv);
        const prev = newestVaultByEntitlement.get(entKey);
        if (!prev || ts >= prev.ts) {
          if (prev && prev.gameId !== gameId) {
            delete canonicalVault[prev.gameId];
          }
          newestVaultByEntitlement.set(entKey, { gameId, ts });
        } else {
          delete canonicalVault[gameId];
        }
      }

      const newestLocalByEntitlement = new Map<string, { gameId: string; ts: number }>();
      for (const [gameId, localOv] of Object.entries(canonicalLocal)) {
        if (!localOv.platformId || !localOv.platformGameId || localOv.splitFromMerged) continue;
        const entKey = `${localOv.platformId.toLowerCase()}:${String(localOv.platformGameId).toLowerCase()}`;
        const ts = parseOverrideTimestamp(localOv);
        const prev = newestLocalByEntitlement.get(entKey);
        if (!prev || ts >= prev.ts) {
          if (prev && prev.gameId !== gameId) {
            delete canonicalLocal[prev.gameId];
            delete localMap[prev.gameId];
          }
          newestLocalByEntitlement.set(entKey, { gameId, ts });
        } else {
          delete canonicalLocal[gameId];
          delete localMap[gameId];
        }
      }

      const hydratedFromVault: UserGameOverride[] = [];
      for (const [gameId, vaultOv] of Object.entries(canonicalVault)) {
        const entKey =
          vaultOv.platformId && vaultOv.platformGameId && !vaultOv.splitFromMerged
            ? `${vaultOv.platformId.toLowerCase()}:${String(vaultOv.platformGameId).toLowerCase()}`
            : null;
        const localEnt = entKey ? newestLocalByEntitlement.get(entKey) : undefined;
        const localOv = canonicalLocal[gameId] || (localEnt ? canonicalLocal[localEnt.gameId] : undefined);
        const vaultTs = parseOverrideTimestamp(vaultOv);
        const localTs = localOv ? parseOverrideTimestamp(localOv) : -1;
        if (!localOv || vaultTs > localTs) {
          if (localEnt && localEnt.gameId !== gameId) {
            delete localMap[localEnt.gameId];
          }
          localMap[gameId] = vaultOv;
          if (vaultOv.platformId && vaultOv.platformGameId) {
            localMap[`${vaultOv.platformId}:${vaultOv.platformGameId}`] = vaultOv;
          }
          hydratedFromVault.push(vaultOv);
        }
      }

      const missingOrNewerForVault: Record<string, UserGameOverride> = {};
      for (const [gameId, localOv] of Object.entries(canonicalLocal)) {
        const entKey =
          localOv.platformId && localOv.platformGameId && !localOv.splitFromMerged
            ? `${localOv.platformId.toLowerCase()}:${String(localOv.platformGameId).toLowerCase()}`
            : null;
        const vaultEnt = entKey ? newestVaultByEntitlement.get(entKey) : undefined;
        const vaultOv = canonicalVault[gameId] || (vaultEnt ? canonicalVault[vaultEnt.gameId] : undefined);
        const localTs = parseOverrideTimestamp(localOv);
        const vaultTs = vaultOv ? parseOverrideTimestamp(vaultOv) : -1;
        if (!vaultOv || localTs > vaultTs) {
          missingOrNewerForVault[gameId] = localOv;
        }
      }

      if (hydratedFromVault.length > 0) {
        persistUserOverridesMapToStorage(localMap);
        if (typeof window.dispatchEvent === 'function') {
          for (const ov of hydratedFromVault) {
            try {
              window.dispatchEvent(
                new CustomEvent('antigravity:user-override-updated', {
                  detail: { override: ov, hydratedFromVault: true },
                })
              );
            } catch {}
          }
        }
      }

      const pushIds = Object.keys(missingOrNewerForVault);
      if (
        pushIds.length > 0 &&
        typeof window.electronAPI?.offlineVault?.saveUserOverride === 'function'
      ) {
        try {
          const batchRes = await window.electronAPI.offlineVault.saveUserOverride({
            batchOverrides: missingOrNewerForVault as unknown as Record<
              string,
              import('../../types/electron').UserMetadataOverride
            >,
          });
          if (!batchRes || batchRes.success === false) {
            for (const [id, ov] of Object.entries(missingOrNewerForVault)) {
              await window.electronAPI.offlineVault
                .saveUserOverride(id, ov as unknown as object)
                ?.catch?.(() => {});
            }
          }
        } catch {
          for (const [id, ov] of Object.entries(missingOrNewerForVault)) {
            await window.electronAPI.offlineVault
              .saveUserOverride(id, ov as unknown as object)
              ?.catch?.(() => {});
          }
        }
      }

      return hydratedFromVault.length > 0 || pushIds.length > 0;
    } catch {
      return false;
    } finally {
      inFlightVaultOverrideSync = null;
    }
  })();

  return inFlightVaultOverrideSync;
}

if (
  typeof window !== 'undefined' &&
  typeof window.electronAPI?.offlineVault?.getUserOverrides === 'function'
) {
  void hydrateUserOverridesFromVault().catch(() => {});
}

/**
 * Resolves the effective Steam App ID for a game taking user overrides and explicit non-Steam flags into account.
 */
export function getEffectiveSteamAppId(
  game?: EffectiveSteamLookupInput | CanonicalGame | null
): number | undefined {
  return resolveEffectiveSteamAppId(game);
}
