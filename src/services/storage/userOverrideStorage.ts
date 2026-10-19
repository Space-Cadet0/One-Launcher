import type { CanonicalGame } from '../../contracts/game';
import type { StorefrontId } from '../../contracts/platform';
import type {
  UserGameOverride,
  UserGameOverridesMap,
  ReviewScoreRoute,
  MetadataSourceRoute,
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
  rawGameSnapshot: CanonicalGame;
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

function getStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  return null;
}

let cachedOverridesRaw: string | null = null;
let cachedOverridesMap: UserGameOverridesMap = {};
let cachedStorageRef: Storage | null = null;

/**
 * Loads all user-defined game overrides from localStorage (and native Electron if available).
 */
export function loadUserOverrides(): UserGameOverridesMap {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY_USER_OVERRIDES);
    if (!raw) {
      cachedStorageRef = storage;
      cachedOverridesRaw = null;
      cachedOverridesMap = {};
      return {};
    }
    if (storage === cachedStorageRef && raw === cachedOverridesRaw) {
      return cachedOverridesMap;
    }
    const parsed = JSON.parse(raw);
    const map = parsed && typeof parsed === 'object' ? (parsed as UserGameOverridesMap) : {};
    cachedStorageRef = storage;
    cachedOverridesRaw = raw;
    cachedOverridesMap = map;
    return map;
  } catch (err) {
    console.warn('Failed to load user game overrides from localStorage:', err);
    return {};
  }
}

let cachedHiddenRaw: string | null = null;
let cachedHiddenMap: Record<string, HiddenStorefrontEntry> = {};
let cachedHiddenStorageRef: Storage | null = null;

/**
 * Loads all user-hidden storefront entries from localStorage.
 */
export function loadHiddenStorefrontEntries(): Record<string, HiddenStorefrontEntry> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY_HIDDEN_ENTRIES);
    if (!raw) {
      cachedHiddenStorageRef = storage;
      cachedHiddenRaw = null;
      cachedHiddenMap = {};
      return {};
    }
    if (storage === cachedHiddenStorageRef && raw === cachedHiddenRaw) {
      return cachedHiddenMap;
    }
    const parsed = JSON.parse(raw);
    const map =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, HiddenStorefrontEntry>)
        : {};
    cachedHiddenStorageRef = storage;
    cachedHiddenRaw = raw;
    cachedHiddenMap = map;
    return map;
  } catch (err) {
    console.warn('Failed to load hidden storefront entries from localStorage:', err);
    return {};
  }
}

function persistHiddenEntriesMap(map: Record<string, HiddenStorefrontEntry>): void {
  const storage = getStorage();
  if (!storage) return;
  const serialized = JSON.stringify(map);
  storage.setItem(STORAGE_KEY_HIDDEN_ENTRIES, serialized);
  cachedHiddenStorageRef = storage;
  cachedHiddenRaw = serialized;
  cachedHiddenMap = map;
}

export function loadRestoredNonGameKeys(): Set<string> {
  const storage = getStorage();
  if (!storage) return new Set<string>();
  try {
    const raw = storage.getItem(STORAGE_KEY_RESTORED_NON_GAMES);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set<string>(parsed.filter((s) => typeof s === 'string' && s.trim().length > 0));
    }
  } catch {}
  return new Set<string>();
}

function persistRestoredNonGameKeys(keys: Set<string>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY_RESTORED_NON_GAMES, JSON.stringify(Array.from(keys)));
  } catch {}
}

export function isNonGameStorefrontEntryRestored(
  platformId?: StorefrontId,
  platformGameId?: string,
  gameId?: string
): boolean {
  const keys = loadRestoredNonGameKeys();
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

export function loadConfirmedNonGameKeys(): Set<string> {
  const storage = getStorage();
  if (!storage) return new Set<string>();
  try {
    const raw = storage.getItem(STORAGE_KEY_CONFIRMED_NON_GAMES);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set<string>(parsed.filter((s) => typeof s === 'string' && s.trim().length > 0));
    }
  } catch {}
  return new Set<string>();
}

function persistConfirmedNonGameKeys(keys: Set<string>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY_CONFIRMED_NON_GAMES, JSON.stringify(Array.from(keys)));
  } catch {}
}

export function isNonGameStorefrontEntryConfirmed(
  platformId?: StorefrontId,
  platformGameId?: string,
  gameId?: string
): boolean {
  const keys = loadConfirmedNonGameKeys();
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
        restoredKeys.delete(game.id);
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
            detail: { hiddenGameId: game.id, targetPlatformId },
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

    if (keyOrGameId) {
      restoredKeys.add(keyOrGameId);
      confirmedKeys.delete(keyOrGameId);
      confirmedKeys.delete(`game:${keyOrGameId}`);
    }
    if (platformId) {
      restoredKeys.add(platformId);
    }
    if (platformGameId) {
      restoredKeys.add(platformGameId);
    }
    if (platformId && platformGameId) {
      restoredKeys.add(`${platformId}:${platformGameId}`);
      restoredKeys.add(`${platformId}-${platformGameId}`);
      confirmedKeys.delete(`${platformId}:${platformGameId}`);
      confirmedKeys.delete(`${platformId}-${platformGameId}`);
    }
    if (keyOrGameId && platformId) {
      restoredKeys.add(`${keyOrGameId}:${platformId}`);
      restoredKeys.add(`${keyOrGameId}-${platformId}`);
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
            detail: { unhiddenKey: keyOrGameId, platformId, platformGameId },
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

/**
 * Persists a user-defined game override into localStorage (and native Electron if available).
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
    const updatedOverride: UserGameOverride = {
      ...override,
      updatedAt: override.updatedAt || new Date().toISOString(),
    };
    if (typeof updatedOverride.shortDescription === 'string') {
      if (/<[a-z][\s\S]*>/i.test(updatedOverride.shortDescription) && !updatedOverride.detailedDescription) {
        updatedOverride.detailedDescription = updatedOverride.shortDescription;
      }
      updatedOverride.shortDescription = sanitizePlainSynopsis(updatedOverride.shortDescription);
    }
    if (override.reviewScoreOverride !== undefined) {
      updatedOverride.reviewScoreOverride = override.reviewScoreOverride;
    } else if (current[override.gameId]?.reviewScoreOverride !== undefined) {
      updatedOverride.reviewScoreOverride = current[override.gameId].reviewScoreOverride;
    }

    if (override.reviewRoute !== undefined) {
      updatedOverride.reviewRoute = override.reviewRoute;
    } else if (override.reviewScoreOverride === undefined && current[override.gameId]?.reviewRoute !== undefined) {
      updatedOverride.reviewRoute = current[override.gameId].reviewRoute;
    }

    if (updatedOverride.reviewScoreOverride !== undefined && updatedOverride.reviewRoute === undefined) {
      updatedOverride.reviewRoute = inferReviewRouteFromOverride(updatedOverride);
    }

    if (override.metadataRoute !== undefined) {
      updatedOverride.metadataRoute = inferMetadataRouteFromOverride(updatedOverride);
    } else if (current[override.gameId]?.metadataRoute !== undefined) {
      updatedOverride.metadataRoute = current[override.gameId].metadataRoute;
    } else {
      updatedOverride.metadataRoute = inferMetadataRouteFromOverride(updatedOverride);
    }

    current[override.gameId] = updatedOverride;

    // Also index platform key if available (e.g., 'epic:boga' or 'gog:1837805079')
    if (override.platformId && override.platformGameId) {
      const platformKey = `${override.platformId}:${override.platformGameId}`;
      current[platformKey] = updatedOverride;
      if (override.splitFromMerged) {
        const dashKey = `${override.platformId}-${override.platformGameId}`;
        current[dashKey] = updatedOverride;
      }
    }

    const storage = getStorage();
    if (storage) {
      const serialized = JSON.stringify(current);
      storage.setItem(STORAGE_KEY_USER_OVERRIDES, serialized);
      cachedStorageRef = storage;
      cachedOverridesRaw = serialized;
      cachedOverridesMap = current;
    }

    // Notify window listeners reactively
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', { detail: { override: updatedOverride, oldGame } })
        );
      } catch {}
    }

    // Optional Electron IPC sync if available
    if (
      typeof window !== 'undefined' &&
      (window.electronAPI as unknown as Record<string, unknown>)?.saveUserOverride &&
      typeof (window.electronAPI as unknown as Record<string, (o: unknown) => unknown>).saveUserOverride === 'function'
    ) {
      try {
        (window.electronAPI as unknown as Record<string, (o: unknown) => unknown>).saveUserOverride(updatedOverride);
      } catch (ipcErr) {
        console.warn('Failed to sync user override to Electron:', ipcErr);
      }
    }
  } catch (err) {
    console.error('Failed to save user game override:', err);
  }
}

/**
 * Removes a user-defined game override by gameId.
 */
export function removeUserOverride(gameId: string): void {
  if (!gameId) return;
  try {
    const current: UserGameOverridesMap = { ...loadUserOverrides() };
    const existing = current[gameId];
    let deleted = false;
    if (current[gameId]) {
      delete current[gameId];
      deleted = true;
    }
    // Also remove any entries referencing this gameId
    for (const [key, ov] of Object.entries(current)) {
      if (ov.gameId === gameId) {
        delete current[key];
        deleted = true;
      }
    }

    const storage = getStorage();
    if (deleted && storage) {
      const serialized = JSON.stringify(current);
      storage.setItem(STORAGE_KEY_USER_OVERRIDES, serialized);
      cachedStorageRef = storage;
      cachedOverridesRaw = serialized;
      cachedOverridesMap = current;
    }

    // Notify window listeners reactively
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:user-override-removed', { detail: { gameId, oldOverride: existing } })
        );
      } catch {}
    }

    // Optional Electron IPC sync if available
    if (
      typeof window !== 'undefined' &&
      (window.electronAPI as unknown as Record<string, unknown>)?.removeUserOverride &&
      typeof (window.electronAPI as unknown as Record<string, (id: string) => unknown>).removeUserOverride === 'function'
    ) {
      try {
        (window.electronAPI as unknown as Record<string, (id: string) => unknown>).removeUserOverride(gameId);
      } catch (ipcErr) {
        console.warn('Failed to remove user override in Electron:', ipcErr);
      }
    }
  } catch (err) {
    console.error('Failed to remove user game override:', err);
  }
}

/**
 * Retrieves a matching user override for a canonical game.
 * Checks game.id, game.steamAppId, and platform keys (e.g. 'epic:gameId', 'gog:gameId').
 */
export function getUserOverrideForGame(
  game: CanonicalGame,
  overrides?: UserGameOverridesMap
): UserGameOverride | undefined {
  if (!game) return undefined;
  const map = overrides ?? loadUserOverrides();
  if (!map || Object.keys(map).length === 0) return undefined;

  const isCompatibleWithGame = (ov?: UserGameOverride): boolean => {
    if (!ov) return false;
    if (!ov.splitFromMerged) return true;
    if (!Array.isArray(game.platforms) || game.platforms.length !== 1) return false;
    const p = game.platforms[0];
    if (ov.platformId && p.platformId !== ov.platformId) return false;
    if (ov.platformGameId && String(p.platformGameId) !== String(ov.platformGameId)) return false;
    return true;
  };

  // 1. Direct match on game.id
  if (game.id && map[game.id] && isCompatibleWithGame(map[game.id])) {
    return map[game.id];
  }

  // 2. Direct match on steamAppId
  if (game.steamAppId) {
    if (map[`steam-${game.steamAppId}`] && isCompatibleWithGame(map[`steam-${game.steamAppId}`])) {
      return map[`steam-${game.steamAppId}`];
    }
    if (map[String(game.steamAppId)] && isCompatibleWithGame(map[String(game.steamAppId)])) {
      return map[String(game.steamAppId)];
    }
  }

  // 3. Fallback checks on platform combinations
  if (Array.isArray(game.platforms)) {
    for (const p of game.platforms) {
      if (!p) continue;
      const colonKey = `${p.platformId}:${p.platformGameId}`;
      if (map[colonKey] && isCompatibleWithGame(map[colonKey])) return map[colonKey];
      const dashKey = `${p.platformId}-${p.platformGameId}`;
      if (map[dashKey] && isCompatibleWithGame(map[dashKey])) return map[dashKey];
      if (p.platformGameId && map[p.platformGameId] && isCompatibleWithGame(map[p.platformGameId])) {
        return map[p.platformGameId];
      }
    }
  }

  // 4. Value scan fallback (in case gameId format changed or matched by platformGameId)
  for (const ov of Object.values(map)) {
    if (!ov || !isCompatibleWithGame(ov)) continue;
    if (ov.gameId === game.id) return ov;
    if (
      ov.platformGameId &&
      Array.isArray(game.platforms) &&
      game.platforms.some(
        (p) =>
          p.platformGameId === ov.platformGameId &&
          (!ov.platformId || p.platformId === ov.platformId)
      )
    ) {
      return ov;
    }
  }

  return undefined;
}

/**
 * Updates the cached metadata snapshot on a routed UserGameOverride without overwriting
 * user-pinned custom fields (such as customTitleEdited, customSynopsisEdited, or Step 2 capsuleImage).
 */
export function updateRoutedMetadataSnapshot(
  gameId: string,
  refreshed: Partial<UserGameOverride>
): void {
  if (!gameId || !refreshed) return;
  try {
    const current: UserGameOverridesMap = { ...loadUserOverrides() };
    const existing = current[gameId];
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
    if (refreshed.headerImage && refreshed.headerImage.trim()) {
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
    if (existing.platformId && existing.platformGameId) {
      current[`${existing.platformId}:${existing.platformGameId}`] = next;
    }

    const storage = getStorage();
    if (storage) {
      const serialized = JSON.stringify(current);
      storage.setItem(STORAGE_KEY_USER_OVERRIDES, serialized);
      cachedStorageRef = storage;
      cachedOverridesRaw = serialized;
      cachedOverridesMap = current;
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
  if (!map || Object.keys(map).length === 0) return catalog;

  return catalog.map((game) => {
    const ov = getUserOverrideForGame(game, map);
    return ov ? applyUserOverrideToGame(game, ov) : game;
  });
}

/**
 * Resolves the effective Steam App ID for a game taking user overrides and explicit non-Steam flags into account.
 */
export function getEffectiveSteamAppId(game?: CanonicalGame | null): number | undefined {
  if (!game) return undefined;
  const ov = getUserOverrideForGame(game);
  if (ov?.steamAppId === null || ov?.isExplicitNonSteam || game.isExplicitNonSteam) {
    return undefined;
  }
  if (typeof ov?.steamAppId === 'number' && ov.steamAppId > 0) {
    return ov.steamAppId;
  }
  const route = inferMetadataRouteFromOverride(ov);
  if (route?.source === 'steam' && typeof route.steamAppId === 'number' && route.steamAppId > 0) {
    return route.steamAppId;
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
  return undefined;
}
