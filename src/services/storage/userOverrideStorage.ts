import type { CanonicalGame } from '../../contracts/game';
import type {
  UserGameOverride,
  UserGameOverridesMap,
  ReviewScoreRoute,
  MetadataSourceRoute,
} from '../../contracts/override';

export const STORAGE_KEY_USER_OVERRIDES = 'universal_game_library_user_overrides';

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

/**
 * Persists a user-defined game override into localStorage (and native Electron if available).
 */
export function saveUserOverride(override: UserGameOverride, oldGame?: CanonicalGame): void {
  if (!override || !override.gameId) return;
  try {
    const current: UserGameOverridesMap = { ...loadUserOverrides() };
    const updatedOverride: UserGameOverride = {
      ...override,
      updatedAt: override.updatedAt || new Date().toISOString(),
    };
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

  // 1. Direct match on game.id
  if (game.id && map[game.id]) {
    return map[game.id];
  }

  // 2. Direct match on steamAppId
  if (game.steamAppId) {
    if (map[`steam-${game.steamAppId}`]) return map[`steam-${game.steamAppId}`];
    if (map[String(game.steamAppId)]) return map[String(game.steamAppId)];
  }

  // 3. Fallback checks on platform combinations
  if (Array.isArray(game.platforms)) {
    for (const p of game.platforms) {
      if (!p) continue;
      const colonKey = `${p.platformId}:${p.platformGameId}`;
      if (map[colonKey]) return map[colonKey];
      const dashKey = `${p.platformId}-${p.platformGameId}`;
      if (map[dashKey]) return map[dashKey];
      if (p.platformGameId && map[p.platformGameId]) return map[p.platformGameId];
    }
  }

  // 4. Value scan fallback (in case gameId format changed or matched by platformGameId)
  for (const ov of Object.values(map)) {
    if (!ov) continue;
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
      next.shortDescription = refreshed.shortDescription.trim();
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
    updated.shortDescription = override.shortDescription;
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
