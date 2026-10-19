import { GameCollection } from '../../contracts/collection';

const STORAGE_KEY = 'antigravity_user_collections';

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

const UNOWNED_MOCK_IDS = new Set([
  'gears-of-war-e-day',
  'alan-wake-2',
  'hades-ii',
  'hollow-knight-silksong',
  'dead-space-remake',
  'celeste',
]);

const MIGRATED_IDS: Record<string, string> = {
  'death-stranding': 'steam-1190460',
  'cyberpunk-2077': 'steam-1091500',
  'baldurs-gate-3': 'steam-1086940',
};

function sanitizeCollections(cols: GameCollection[]): GameCollection[] {
  return cols.map((col) => ({
    ...col,
    icon: col.icon || DEFAULT_COLLECTION_ICONS[col.id] || 'folder',
    gameIds: Array.from(
      new Set(
        (col.gameIds || [])
          .map((id) => MIGRATED_IDS[id] || id)
          .filter((id) => !UNOWNED_MOCK_IDS.has(id))
      )
    ),
  }));
}

export function loadCollections(): GameCollection[] {
  if (typeof window === 'undefined') return DEFAULT_COLLECTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      saveCollections(DEFAULT_COLLECTIONS);
      return DEFAULT_COLLECTIONS;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const sanitized = sanitizeCollections(parsed);
      saveCollections(sanitized);
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
