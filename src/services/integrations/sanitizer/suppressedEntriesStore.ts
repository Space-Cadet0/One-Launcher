import { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import { getSafeLocalStorage } from '../../common/runtimeEnv';
import { getAlphabeticalTitleSortKey } from '../../common/titleSortUtils';
import {
  getReadonlyRestoredNonGameKeys,
  isNonGameStorefrontEntryRestored,
  isStorefrontEntryHidden,
  loadHiddenStorefrontEntries,
} from '../../storage/userOverrideStorage';
import {
  isMockOrUnownedIdentifier,
  loadVerifiedEntitlementsFromStorage,
  normalizeCanonicalTitle,
} from './nonGameAndDescriptionFilter';

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
  const title =
    (params.rawTitle || params.id || platGameId || 'Unknown Title').trim() || 'Unknown Title';
  const sortTitle = getAlphabeticalTitleSortKey(title, true) || title;
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
    String(
      entry?.id || (platformId && platformGameId ? `${platformId}-${platformGameId}` : '')
    ).trim() || `suppressed-${Date.now()}`;
  const rawTitle =
    (entry?.rawTitle || entry?.rawGame?.title || id || 'Unknown Title').trim() || 'Unknown Title';

  let rawGame: CanonicalGame;
  if (entry?.rawGame && typeof entry.rawGame === 'object' && entry.rawGame.id) {
    const rawPlats = Array.isArray(entry.rawGame.platforms) ? entry.rawGame.platforms : [];
    const validPlatforms = rawPlats
      .filter((p): p is GamePlatformOwnership => Boolean(p && typeof p === 'object'))
      .map((p) => ({
        ...p,
        platformId: (p.platformId || platformId) as StorefrontId,
        platformGameId:
          p.platformGameId !== undefined &&
          p.platformGameId !== null &&
          String(p.platformGameId).trim() !== ''
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

    const resolvedTitle = (entry.rawGame.title || rawTitle).trim() || 'Unknown Title';
    rawGame = {
      ...entry.rawGame,
      id: entry.rawGame.id || id,
      title: resolvedTitle,
      sortTitle:
        getAlphabeticalTitleSortKey(
          entry.rawGame.sortTitle || entry.rawGame.title || rawTitle,
          true
        ) || rawTitle,
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

function addSecondaryIndexKey(
  index: Map<string, Set<string>>,
  lookupKey: string,
  mapKey: string
): void {
  if (!lookupKey) return;
  let bucket = index.get(lookupKey);
  if (!bucket) {
    bucket = new Set<string>();
    index.set(lookupKey, bucket);
  }
  bucket.add(mapKey);
}

export function syncSuppressedEntriesWithStorage(): void {
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
      cachedSuppressedRaw = raw;
      return;
    }

    const parsed: unknown = JSON.parse(raw);
    let sawLegacyRawGameBloat = false;
    let selfHealedStaleEntry = false;
    let mutatedMap = false;
    if (Array.isArray(parsed)) {
      const verifiedEntitlements = loadVerifiedEntitlementsFromStorage();
      const isEntryVerifiedEntitlement = (
        platId: StorefrontId,
        platGameId: string,
        entryId: string,
        titleStr: string
      ): boolean => {
        const cleanPlatGameId = String(platGameId || '').trim().toLowerCase();
        const cleanEntryId = String(entryId || '').trim().toLowerCase();
        const strippedEntryId = cleanEntryId.replace(new RegExp(`^${platId}[-:]`, 'i'), '').trim();
        const normTitle = titleStr ? normalizeCanonicalTitle(titleStr) : '';
        if (platId === 'steam') {
          const numId = Number(platGameId);
          return Number.isFinite(numId) && numId > 0 && verifiedEntitlements.steam.has(numId);
        }
        if (platId === 'gog' || platId === 'epic' || platId === 'xbox') {
          const bucket = verifiedEntitlements[platId];
          return Boolean(
            (cleanPlatGameId && bucket.has(cleanPlatGameId)) ||
              (cleanEntryId && bucket.has(cleanEntryId)) ||
              (strippedEntryId && bucket.has(strippedEntryId)) ||
              (normTitle && bucket.has(normTitle))
          );
        }
        return false;
      };

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
        const rawTitle = entry.rawTitle || entry.rawGame?.title || entry.id || '';
        if (
          entry.id &&
          entry.reasonCategory &&
          entry.reasonCategory !== 'user_hidden' &&
          !isNonGameStorefrontEntryRestored(platformId, platformGameId, entry.id)
        ) {
          if (
            entry.reasonCategory === 'non_game_filter' &&
            isEntryVerifiedEntitlement(platformId, platformGameId, entry.id, rawTitle)
          ) {
            const staleKey =
              platformId && platformGameId ? `${platformId}:${platformGameId}` : entry.id;
            if (lastSuppressedEntries.delete(staleKey) || lastSuppressedEntries.delete(entry.id)) {
              mutatedMap = true;
            }
            selfHealedStaleEntry = true;
            continue;
          }
          const mapKey =
            platformId && platformGameId ? `${platformId}:${platformGameId}` : entry.id;
          if (!lastSuppressedEntries.has(mapKey) && !lastSuppressedEntries.has(entry.id)) {
            lastSuppressedEntries.set(
              mapKey,
              ensureSuppressedEntryRawGame({
                id: entry.id,
                rawTitle: rawTitle || entry.id,
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
      if (sawLegacyRawGameBloat || selfHealedStaleEntry) {
        persistSuppressedEntriesToStorage();
      }
    }
  } catch {
    // Ignore malformed suppressed cache
  }
}

export function persistSuppressedEntriesToStorage(): void {
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
    if (hasWrittenSuppressedToStorage && serialized === cachedSuppressedRaw) {
      return;
    }
    storage.setItem(STORAGE_KEY_SUPPRESSED_ENTRIES, serialized);
    hasWrittenSuppressedToStorage = true;
    cachedSuppressedStorageRef = storage;
    cachedSuppressedRaw = serialized;
    cachedSuppressedRestoredRef = getReadonlyRestoredNonGameKeys();
    inMemorySuppressedHydrated = true;
  } catch {
    // Ignore storage write errors
  }
}

export function clearUserHiddenSuppressedEntriesInMemory(): boolean {
  let deleted = false;
  for (const [k, v] of lastSuppressedEntries.entries()) {
    if (v.reasonCategory === 'user_hidden') {
      lastSuppressedEntries.delete(k);
      deleted = true;
    }
  }
  if (deleted) {
    suppressedMapVersion++;
  }
  return deleted;
}

export function recordSuppressedCatalogEntryInMemory(
  rawGame: CanonicalGame,
  reason: string,
  reasonCategory: SuppressedCatalogEntry['reasonCategory'],
  specificPlat?: { platformId: StorefrontId; platformGameId: string }
): boolean {
  const plat =
    specificPlat ||
    rawGame.platforms?.[0] ||
    ({ platformId: 'steam' as StorefrontId, platformGameId: rawGame.id });
  if (isMockOrUnownedIdentifier(rawGame.id, plat.platformGameId)) {
    return false;
  }
  const key =
    plat.platformId && plat.platformGameId
      ? `${plat.platformId}:${plat.platformGameId}`
      : rawGame.id || `${plat.platformId}:${plat.platformGameId}`;
  const nextId = rawGame.id || `${plat.platformId}-${plat.platformGameId}`;
  const nextTitle =
    rawGame.originalStoreTitle || rawGame.platforms?.[0]?.originalTitle || rawGame.title;
  const nextPlatformGameId = String(plat.platformGameId || rawGame.id);

  const existing = lastSuppressedEntries.get(key);
  const changed =
    !existing ||
    existing.id !== nextId ||
    existing.rawTitle !== nextTitle ||
    existing.platformId !== plat.platformId ||
    existing.platformGameId !== nextPlatformGameId ||
    existing.reason !== reason ||
    existing.reasonCategory !== reasonCategory;

  lastSuppressedEntries.set(key, {
    id: nextId,
    rawTitle: nextTitle,
    platformId: plat.platformId,
    platformGameId: nextPlatformGameId,
    reason,
    reasonCategory,
    suppressedAt: existing?.suppressedAt ?? Date.now(),
    rawGame,
  });
  if (changed) {
    suppressedMapVersion++;
  }
  return changed && reasonCategory !== 'user_hidden';
}

export function pruneActiveGamesFromSuppressedEntries(finalCatalog: CanonicalGame[]): boolean {
  if (lastSuppressedEntries.size === 0) return false;

  const activePlatformKeys = new Set<string>();
  const activeVerifiedTitles = new Set<string>();
  for (const g of finalCatalog) {
    if (g.id) activePlatformKeys.add(g.id.toLowerCase());
    if (typeof g.steamAppId === 'number' && g.steamAppId > 0) {
      activePlatformKeys.add(`steam:${g.steamAppId}`);
      activePlatformKeys.add(`steam-${g.steamAppId}`);
    }
    if (g.isVerifiedEntitlement && g.title) {
      const nt = normalizeCanonicalTitle(g.title);
      if (nt) activeVerifiedTitles.add(nt);
    }
    for (const p of g.platforms || []) {
      if (p.platformId && p.platformGameId) {
        const pgLower = String(p.platformGameId).toLowerCase();
        activePlatformKeys.add(`${p.platformId}:${pgLower}`);
        activePlatformKeys.add(`${p.platformId}-${pgLower}`);
      }
      if (p.platformId && p.catalogItemId) {
        const catLower = String(p.catalogItemId).toLowerCase();
        activePlatformKeys.add(`${p.platformId}:${catLower}`);
        activePlatformKeys.add(`${p.platformId}-${catLower}`);
        activePlatformKeys.add(catLower);
      }
    }
  }

  let removedActive = false;
  for (const [k, entry] of lastSuppressedEntries.entries()) {
    const kLower = String(k || '').toLowerCase();
    const idLower = String(entry.id || '').toLowerCase();
    const pgLower = String(entry.platformGameId || '').toLowerCase();
    const entryNormTitle = normalizeCanonicalTitle(entry.rawTitle || entry.rawGame?.title || '');
    if (
      entry.reasonCategory !== 'user_hidden' &&
      (activePlatformKeys.has(kLower) ||
        activePlatformKeys.has(idLower) ||
        activePlatformKeys.has(`${entry.platformId}:${pgLower}`) ||
        activePlatformKeys.has(`${entry.platformId}-${pgLower}`) ||
        (pgLower && activePlatformKeys.has(pgLower)) ||
        (entryNormTitle && activeVerifiedTitles.has(entryNormTitle)))
    ) {
      lastSuppressedEntries.delete(k);
      removedActive = true;
    }
  }
  if (removedActive) {
    suppressedMapVersion++;
  }
  return removedActive;
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
    } catch {
      // Ignore storage removal errors
    }
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

export interface RegisterSuppressedOptions {
  storefrontId?: StorefrontId;
  authoritativeComplete?: boolean;
  authoritativeGames?: CanonicalGame[];
}

export function registerSuppressedCatalogEntries(
  entries: SuppressedCatalogEntry[],
  options?: RegisterSuppressedOptions
): void {
  if (!Array.isArray(entries)) return;
  syncSuppressedEntriesWithStorage();
  let mutated = false;

  const targetStorefront = options?.storefrontId;
  const isAuthoritative = Boolean(targetStorefront && options?.authoritativeComplete === true);
  const authGames = Array.isArray(options?.authoritativeGames) ? options.authoritativeGames : [];

  const positiveIds = new Set<string>();
  const positiveTitlesByStore = new Map<StorefrontId, Set<string>>();
  const positiveTitlesAll = new Set<string>();

  const addPositiveTitle = (sf: StorefrontId | undefined, raw: string | undefined) => {
    if (!raw) return;
    const norm = normalizeCanonicalTitle(raw);
    if (!norm) return;
    positiveTitlesAll.add(norm);
    if (sf) {
      let set = positiveTitlesByStore.get(sf);
      if (!set) {
        set = new Set<string>();
        positiveTitlesByStore.set(sf, set);
      }
      set.add(norm);
    }
  };

  for (const g of authGames) {
    if (!g || typeof g !== 'object') continue;
    if (g.id) positiveIds.add(String(g.id).trim().toLowerCase());
    if (typeof g.steamAppId === 'number' && g.steamAppId > 0) {
      positiveIds.add(`steam:${g.steamAppId}`);
      positiveIds.add(`steam-${g.steamAppId}`);
      positiveIds.add(String(g.steamAppId));
    }
    addPositiveTitle(targetStorefront, g.title);
    addPositiveTitle(targetStorefront, g.originalStoreTitle);
    for (const p of g.platforms || []) {
      if (!p || typeof p !== 'object') continue;
      const pid = p.platformId;
      const pgid =
        p.platformGameId !== undefined && p.platformGameId !== null
          ? String(p.platformGameId).trim()
          : '';
      if (pid && pgid) {
        const pgLower = pgid.toLowerCase();
        positiveIds.add(`${pid}:${pgLower}`);
        positiveIds.add(`${pid}-${pgLower}`);
        positiveIds.add(pgLower);
      }
      if (p.catalogItemId) {
        const catLower = String(p.catalogItemId).trim().toLowerCase();
        if (catLower) {
          positiveIds.add(catLower);
          if (pid) {
            positiveIds.add(`${pid}:${catLower}`);
            positiveIds.add(`${pid}-${catLower}`);
          }
        }
      }
      addPositiveTitle(pid || targetStorefront, g.title);
      addPositiveTitle(pid || targetStorefront, g.originalStoreTitle);
      addPositiveTitle(pid || targetStorefront, p.originalTitle);
    }
  }

  const matchesPositiveGame = (entry: SuppressedCatalogEntry): boolean => {
    if (entry.reasonCategory === 'user_hidden') return false;
    if (positiveIds.size === 0 && positiveTitlesAll.size === 0) return false;
    if (targetStorefront && entry.platformId !== targetStorefront) return false;

    const idLower = String(entry.id || '').trim().toLowerCase();
    const pgLower = String(entry.platformGameId || '').trim().toLowerCase();
    const compositeColon = entry.platformId && pgLower ? `${entry.platformId}:${pgLower}` : '';
    const compositeDash = entry.platformId && pgLower ? `${entry.platformId}-${pgLower}` : '';

    if (
      (idLower && positiveIds.has(idLower)) ||
      (pgLower && positiveIds.has(pgLower)) ||
      (compositeColon && positiveIds.has(compositeColon)) ||
      (compositeDash && positiveIds.has(compositeDash))
    ) {
      return true;
    }

    const normTitle = normalizeCanonicalTitle(entry.rawTitle || entry.rawGame?.title || '');
    if (normTitle) {
      const storeTitles = positiveTitlesByStore.get(entry.platformId);
      if (storeTitles?.has(normTitle) || (!targetStorefront && positiveTitlesAll.has(normTitle))) {
        return true;
      }
      if (targetStorefront === entry.platformId && positiveTitlesAll.has(normTitle)) {
        return true;
      }
    }
    return false;
  };

  const incomingMapKeys = new Set<string>();
  const normalizedIncoming: Array<{ mapKey: string; normalizedEntry: SuppressedCatalogEntry }> = [];

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
      if (matchesPositiveGame(normalizedEntry)) {
        continue;
      }
      const mapKey =
        normalizedEntry.platformId && normalizedEntry.platformGameId
          ? `${normalizedEntry.platformId}:${normalizedEntry.platformGameId}`
          : normalizedEntry.id;
      incomingMapKeys.add(mapKey);
      normalizedIncoming.push({ mapKey, normalizedEntry });
    }
  }

  if (isAuthoritative && targetStorefront) {
    for (const [k, existing] of lastSuppressedEntries.entries()) {
      if (
        existing &&
        existing.platformId === targetStorefront &&
        existing.reasonCategory !== 'user_hidden' &&
        !incomingMapKeys.has(k)
      ) {
        lastSuppressedEntries.delete(k);
        mutated = true;
      }
    }
  }

  if (positiveIds.size > 0 || positiveTitlesAll.size > 0) {
    for (const [k, existing] of lastSuppressedEntries.entries()) {
      if (
        existing &&
        existing.reasonCategory !== 'user_hidden' &&
        matchesPositiveGame(existing)
      ) {
        lastSuppressedEntries.delete(k);
        mutated = true;
      }
    }
  }

  for (const { mapKey, normalizedEntry } of normalizedIncoming) {
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

  if (mutated) {
    suppressedMapVersion++;
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('antigravity:suppressed-entries-updated'));
      } catch {
        // Ignore DOM dispatch errors
      }
    }
    persistSuppressedEntriesToStorage();
  }
}

export function reconcileStorefrontSuppressedEntries(
  storefrontId: StorefrontId,
  entries: SuppressedCatalogEntry[],
  options?: Omit<RegisterSuppressedOptions, 'storefrontId'>
): void {
  registerSuppressedCatalogEntries(entries, {
    ...options,
    storefrontId,
  });
}
