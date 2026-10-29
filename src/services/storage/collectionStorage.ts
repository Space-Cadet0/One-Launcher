import { GameCollection } from '../../contracts/collection';
import type { CanonicalGame } from '../../contracts/game';
import { normalizeTitleKey, stripEditionSuffix } from '../common/titleUtils';

const STORAGE_KEY = 'antigravity_user_collections';
const CATALOG_STORAGE_KEYS = [
  'antigravity_unified_catalog_v2',
  'antigravity_current_catalog',
] as const;

const PREFIXED_GAME_ID_RE = /^(?:steam|gog|epic|xbox|custom|igdb)[-_]/i;

export const DEFAULT_COLLECTION_ICONS: Record<string, string> = {
  favorites: 'star',
  'currently-playing': 'play',
  backlog: 'clock',
  completed: 'trophy',
};

export const DEFAULT_COLLECTIONS: GameCollection[] = [
  {
    id: 'favorites',
    name: 'Favorites',
    icon: 'star',
    isDefault: true,
    gameIds: [],
  },
  {
    id: 'currently-playing',
    name: 'Currently Playing',
    icon: 'play',
    isDefault: true,
    gameIds: [],
  },
  {
    id: 'backlog',
    name: 'Backlog',
    icon: 'clock',
    isDefault: false,
    gameIds: [],
  },
  {
    id: 'completed',
    name: 'Completed',
    icon: 'trophy',
    isDefault: false,
    gameIds: [],
  },
];

function buildOwnedSlugResolutionMap(
  ownedGames?: ReadonlyArray<Pick<CanonicalGame, 'id' | 'title'>>
): Map<string, string> {
  const bySlugOrNorm = new Map<string, string>();
  let sourceGames = ownedGames;

  if (!sourceGames && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    for (const key of CATALOG_STORAGE_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          sourceGames = parsed as Array<Pick<CanonicalGame, 'id' | 'title'>>;
          break;
        }
      } catch {
        // Ignore malformed catalog snapshot
      }
    }
  }

  if (!sourceGames) return bySlugOrNorm;

  for (const game of sourceGames) {
    if (!game || typeof game.id !== 'string' || !game.id || typeof game.title !== 'string') {
      continue;
    }
    const norm = normalizeTitleKey(game.title);
    if (norm) {
      if (!bySlugOrNorm.has(norm)) bySlugOrNorm.set(norm, game.id);
      const hyphenated = norm.replace(/\s+/g, '-');
      if (!bySlugOrNorm.has(hyphenated)) bySlugOrNorm.set(hyphenated, game.id);
    }
    const stripped = stripEditionSuffix(game.title);
    if (stripped) {
      if (!bySlugOrNorm.has(stripped)) bySlugOrNorm.set(stripped, game.id);
      const hyphenatedStripped = stripped.replace(/\s+/g, '-');
      if (!bySlugOrNorm.has(hyphenatedStripped)) bySlugOrNorm.set(hyphenatedStripped, game.id);
    }
  }

  return bySlugOrNorm;
}

function resolveGameIdDynamically(
  rawId: string,
  slugMap: Map<string, string> | null
): string {
  const trimmed = String(rawId || '').trim();
  if (!trimmed || PREFIXED_GAME_ID_RE.test(trimmed)) {
    return trimmed;
  }
  if (!slugMap || slugMap.size === 0) {
    return trimmed;
  }
  const direct = slugMap.get(trimmed.toLowerCase());
  if (direct) return direct;
  const norm = normalizeTitleKey(trimmed.replace(/[-_]+/g, ' '));
  if (norm && slugMap.has(norm)) {
    return slugMap.get(norm)!;
  }
  return trimmed;
}

function sanitizeCollections(
  cols: GameCollection[],
  ownedGames?: ReadonlyArray<Pick<CanonicalGame, 'id' | 'title'>>
): GameCollection[] {
  const hasAnyUnprefixedSlug = cols.some(
    (col) =>
      Array.isArray(col?.gameIds) &&
      col.gameIds.some(
        (id) => typeof id === 'string' && id.trim().length > 0 && !PREFIXED_GAME_ID_RE.test(id)
      )
  );
  const slugMap = hasAnyUnprefixedSlug ? buildOwnedSlugResolutionMap(ownedGames) : null;

  return cols.map((col) => ({
    ...col,
    icon: col.icon || DEFAULT_COLLECTION_ICONS[col.id] || 'folder',
    gameIds: Array.from(
      new Set(
        (col.gameIds || [])
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => resolveGameIdDynamically(id, slugMap))
      )
    ),
  }));
}

function collectionsDiffer(a: GameCollection[], b: GameCollection[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const colA = a[i];
    const colB = b[i];
    if (
      !colA ||
      !colB ||
      colA.id !== colB.id ||
      colA.name !== colB.name ||
      colA.icon !== colB.icon ||
      !Array.isArray(colA.gameIds) ||
      colA.gameIds.length !== colB.gameIds.length
    ) {
      return true;
    }
    for (let j = 0; j < colA.gameIds.length; j++) {
      if (colA.gameIds[j] !== colB.gameIds[j]) return true;
    }
  }
  return false;
}

export function resolveCollectionGameIdsAgainstCatalog(
  collections: GameCollection[],
  ownedGames: ReadonlyArray<Pick<CanonicalGame, 'id' | 'title'>>
): GameCollection[] {
  if (!Array.isArray(collections) || collections.length === 0) {
    return collections;
  }
  const resolved = sanitizeCollections(collections, ownedGames);
  if (collectionsDiffer(collections, resolved)) {
    saveCollections(resolved);
  }
  return resolved;
}

export function loadCollections(
  ownedGames?: ReadonlyArray<Pick<CanonicalGame, 'id' | 'title'>>
): GameCollection[] {
  if (typeof window === 'undefined') return DEFAULT_COLLECTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_COLLECTIONS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const typedParsed = parsed as GameCollection[];
      const sanitized = sanitizeCollections(typedParsed, ownedGames);
      if (collectionsDiffer(typedParsed, sanitized)) {
        saveCollections(sanitized);
      }
      return sanitized;
    }
    return DEFAULT_COLLECTIONS;
  } catch {
    return DEFAULT_COLLECTIONS;
  }
}

export function saveCollections(collections: GameCollection[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
  } catch (err) {
    console.error('Failed to save collections to localStorage', err);
  }
}
