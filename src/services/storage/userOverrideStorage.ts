import type { CanonicalGame } from '../../contracts/game';
import type { UserGameOverride, UserGameOverridesMap } from '../../contracts/override';

export const STORAGE_KEY_USER_OVERRIDES = 'universal_game_library_user_overrides';

function getStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  return null;
}

/**
 * Loads all user-defined game overrides from localStorage (and native Electron if available).
 */
export function loadUserOverrides(): UserGameOverridesMap {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY_USER_OVERRIDES);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as UserGameOverridesMap) : {};
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
    const current = loadUserOverrides();
    const updatedOverride: UserGameOverride = {
      ...override,
      updatedAt: override.updatedAt || new Date().toISOString(),
    };
    if (override.reviewScoreOverride !== undefined) {
      updatedOverride.reviewScoreOverride = override.reviewScoreOverride;
    } else if (current[override.gameId]?.reviewScoreOverride !== undefined) {
      updatedOverride.reviewScoreOverride = current[override.gameId].reviewScoreOverride;
    }
    current[override.gameId] = updatedOverride;

    // Also index platform key if available (e.g., 'epic:boga' or 'gog:1837805079')
    if (override.platformId && override.platformGameId) {
      const platformKey = `${override.platformId}:${override.platformGameId}`;
      current[platformKey] = updatedOverride;
    }

    const storage = getStorage();
    if (storage) {
      storage.setItem(STORAGE_KEY_USER_OVERRIDES, JSON.stringify(current));
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
    const current = loadUserOverrides();
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
      storage.setItem(STORAGE_KEY_USER_OVERRIDES, JSON.stringify(current));
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
 * Applies a user-defined override to a CanonicalGame.
 * User intent has absolute authority:
 * - If override.steamAppId === null, sets steamAppId = undefined so it is treated as non-Steam.
 * - Explicit fields overwrite incoming metadata.
 */
export function applyUserOverrideToGame(
  game: CanonicalGame,
  override: UserGameOverride
): CanonicalGame {
  if (!game || !override) return game;
  const updated: CanonicalGame = { ...game };

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
  }

  if (override.isExplicitNonSteam !== undefined) {
    updated.isExplicitNonSteam = override.isExplicitNonSteam;
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
