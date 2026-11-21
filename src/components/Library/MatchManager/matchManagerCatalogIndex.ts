import { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import {
  getUserOverrideForGame,
  getUserOverridesRevision,
  loadConfirmedNonGameKeys,
  loadUserOverrides,
} from '../../../services/storage/userOverrideStorage';
import {
  getSuppressedCatalogEntries,
  normalizeCanonicalTitle,
  SuppressedCatalogEntry,
} from '../../../services/integrations/catalogSanitizer';
import { matchesLooseSearchQuery } from '../../../services/common/titleUtils';
import {
  classifyAutoFilteredSubCategory,
  getGranularUnmatchedReasons,
  getSynopsisProbeRevision,
  isLikelyNonStoreOrTestBranchTitle,
  loadDurableEmptySynopsisProbeMap,
} from './matchManagerDiagnostics';
import {
  AutoFilteredSubFilter,
  UnmatchedDiagnosticReason,
} from './matchManagerTypes';

export const STUDIO_TITLE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export interface CatalogLookupIndex {
  byId: Map<string, CanonicalGame>;
  byIdLower: Map<string, CanonicalGame>;
  byPlatComposite: Map<string, CanonicalGame>;
  byPlatCompositeLower: Map<string, CanonicalGame>;
  bySinglePlatComposite: Map<string, CanonicalGame>;
  bySinglePlatCompositeLower: Map<string, CanonicalGame>;
}

export const EMPTY_CATALOG_LOOKUP: CatalogLookupIndex = {
  byId: new Map(),
  byIdLower: new Map(),
  byPlatComposite: new Map(),
  byPlatCompositeLower: new Map(),
  bySinglePlatComposite: new Map(),
  bySinglePlatCompositeLower: new Map(),
};

export interface IndexedUnmatchedItem {
  game: CanonicalGame;
  reasons: UnmatchedDiagnosticReason[];
  searchFields: string[];
}

export interface IndexedGameItem {
  game: CanonicalGame;
  searchFields: string[];
}

export interface IndexedSuppressedItem {
  entry: SuppressedCatalogEntry;
  subCategory: Exclude<AutoFilteredSubFilter, 'all'>;
  searchFields: string[];
}

export interface IndexedOverrideItem {
  override: UserGameOverride;
  matchedGame?: CanonicalGame;
  searchFields: string[];
}

interface CachedUnmatchedDiagEntry {
  overridesRev: number;
  probeRev: number;
  eventRev: number;
  hasProbedEntry: boolean;
  probedVal: string | null | undefined;
  item: IndexedUnmatchedItem | null;
}

interface CachedLowConfDiagEntry {
  overridesRev: number;
  eventRev: number;
  isUnmatched: boolean;
  item: IndexedGameItem | null;
}

const MAX_MODULE_PROBED_RESULTS = 4_096;
export const moduleProbedResultsMap = new Map<string, string | null>();
export const moduleProbingSet = new Set<string>();

export function setModuleProbedResult(id: string, value: string | null): void {
  moduleProbedResultsMap.delete(id);
  if (moduleProbedResultsMap.size >= MAX_MODULE_PROBED_RESULTS) {
    const oldestKey = moduleProbedResultsMap.keys().next().value;
    if (oldestKey !== undefined) {
      moduleProbedResultsMap.delete(oldestKey);
    }
  }
  moduleProbedResultsMap.set(id, value);
}

let moduleStudioEventRevision = 0;
let lastSeenOverridesMapRef: Record<string, UserGameOverride> | null = null;
let syntheticOverridesMapRev = 0;
let moduleUnmatchedDiagWeakMap = new WeakMap<CanonicalGame, CachedUnmatchedDiagEntry>();
let moduleLowConfDiagWeakMap = new WeakMap<CanonicalGame, CachedLowConfDiagEntry>();

export function bumpStudioEventRevision(): void {
  moduleStudioEventRevision += 1;
}

export function resetStudioSessionCachesForTests(): void {
  moduleProbedResultsMap.clear();
  moduleProbingSet.clear();
  moduleStudioEventRevision += 1;
  lastSeenOverridesMapRef = null;
  moduleUnmatchedDiagWeakMap = new WeakMap();
  moduleLowConfDiagWeakMap = new WeakMap();
}

function resolveEffectiveOverridesRevision(
  overridesMap: Record<string, UserGameOverride>
): number {
  if (overridesMap !== lastSeenOverridesMapRef) {
    lastSeenOverridesMapRef = overridesMap;
    syntheticOverridesMapRev += 1;
  }
  const storageRev =
    typeof getUserOverridesRevision === 'function' ? getUserOverridesRevision() : 0;
  return storageRev * 1_000_003 + syntheticOverridesMapRev;
}

export function collectGameSearchFields(game: CanonicalGame): string[] {
  const fields: string[] = [];
  if (!game) return fields;
  if (game.title) fields.push(game.title);
  if (game.originalStoreTitle) fields.push(game.originalStoreTitle);
  if (game.id) fields.push(game.id);
  const platforms = Array.isArray(game.platforms) ? game.platforms : [];
  for (let i = 0; i < platforms.length; i += 1) {
    const p = platforms[i];
    if (!p) continue;
    if (p.platformId) fields.push(p.platformId);
    if (p.platformGameId !== undefined && p.platformGameId !== null) {
      fields.push(String(p.platformGameId));
    }
    if (p.originalTitle) fields.push(p.originalTitle);
  }
  return fields;
}

export function matchesAnySearchField(fields: readonly string[], query: string): boolean {
  for (let i = 0; i < fields.length; i += 1) {
    if (matchesLooseSearchQuery(fields[i], query)) {
      return true;
    }
  }
  return false;
}

export function buildCatalogLookupIndex(games: CanonicalGame[]): CatalogLookupIndex {
  const byId = new Map<string, CanonicalGame>();
  const byIdLower = new Map<string, CanonicalGame>();
  const byPlatComposite = new Map<string, CanonicalGame>();
  const byPlatCompositeLower = new Map<string, CanonicalGame>();
  const bySinglePlatComposite = new Map<string, CanonicalGame>();
  const bySinglePlatCompositeLower = new Map<string, CanonicalGame>();

  for (let i = 0; i < games.length; i += 1) {
    const g = games[i];
    if (!g || !g.id) continue;
    byId.set(g.id, g);
    byIdLower.set(g.id.toLowerCase(), g);
    const platforms = Array.isArray(g.platforms)
      ? g.platforms.filter(
          (p): p is GamePlatformOwnership => Boolean(p && typeof p === 'object' && p.platformId)
        )
      : [];
    const isSinglePlat = platforms.length === 1;
    for (let j = 0; j < platforms.length; j += 1) {
      const p = platforms[j];
      if (!p || !p.platformId || p.platformGameId === undefined || p.platformGameId === null) {
        continue;
      }
      const compKey = `${p.platformId}:${String(p.platformGameId)}`;
      const compLower = compKey.toLowerCase();
      const dashLower = `${p.platformId}-${String(p.platformGameId)}`.toLowerCase();
      if (!byPlatComposite.has(compKey)) {
        byPlatComposite.set(compKey, g);
      }
      if (!byPlatCompositeLower.has(compLower)) {
        byPlatCompositeLower.set(compLower, g);
      }
      if (!byIdLower.has(dashLower)) {
        byIdLower.set(dashLower, g);
      }
      if (isSinglePlat && !bySinglePlatComposite.has(compKey)) {
        bySinglePlatComposite.set(compKey, g);
      }
      if (isSinglePlat && !bySinglePlatCompositeLower.has(compLower)) {
        bySinglePlatCompositeLower.set(compLower, g);
      }
    }
  }

  return {
    byId,
    byIdLower,
    byPlatComposite,
    byPlatCompositeLower,
    bySinglePlatComposite,
    bySinglePlatCompositeLower,
  };
}

export function computeBaseUnmatchedItems(
  games: CanonicalGame[],
  probedSynopsisMap: Record<string, string | null>
): { items: IndexedUnmatchedItem[]; idSet: Set<string> } {
  const overridesMap = loadUserOverrides();
  const overridesRev = resolveEffectiveOverridesRevision(overridesMap);
  const probeMap = loadDurableEmptySynopsisProbeMap();
  const probeRev = getSynopsisProbeRevision();
  const eventRev = moduleStudioEventRevision;
  const hasProbedMapEntries = Object.keys(probedSynopsisMap).length > 0;

  const items: IndexedUnmatchedItem[] = [];
  for (let i = 0; i < games.length; i += 1) {
    const game = games[i];
    if (!game || !game.id) continue;
    const hasProbedEntryForGame =
      hasProbedMapEntries && Object.prototype.hasOwnProperty.call(probedSynopsisMap, game.id);
    const probedVal = hasProbedEntryForGame ? probedSynopsisMap[game.id] : undefined;

    const cachedDiag = moduleUnmatchedDiagWeakMap.get(game);
    if (
      cachedDiag &&
      cachedDiag.overridesRev === overridesRev &&
      cachedDiag.probeRev === probeRev &&
      cachedDiag.eventRev === eventRev &&
      cachedDiag.hasProbedEntry === hasProbedEntryForGame &&
      cachedDiag.probedVal === probedVal
    ) {
      if (cachedDiag.item) items.push(cachedDiag.item);
      continue;
    }

    if (getUserOverrideForGame(game, overridesMap)) {
      moduleUnmatchedDiagWeakMap.set(game, {
        overridesRev,
        probeRev,
        eventRev,
        hasProbedEntry: hasProbedEntryForGame,
        probedVal,
        item: null,
      });
      continue;
    }

    const reasons = getGranularUnmatchedReasons(game, undefined, probedSynopsisMap, probeMap);
    if (reasons.length === 0) {
      moduleUnmatchedDiagWeakMap.set(game, {
        overridesRev,
        probeRev,
        eventRev,
        hasProbedEntry: hasProbedEntryForGame,
        probedVal,
        item: null,
      });
      continue;
    }

    const hasFullArtwork = Boolean(game.capsuleImage && game.headerImage);
    const rawConf =
      typeof game.matchConfidence === 'number'
        ? game.matchConfidence <= 1
          ? game.matchConfidence * 100
          : game.matchConfidence
        : 0;
    const isLowConfCandidate =
      Boolean(game.needsMatchReview) || (rawConf > 0 && rawConf < 85);

    if (
      hasFullArtwork &&
      isLowConfCandidate &&
      !(
        reasons.some((r) => r.code === 'missing_synopsis') &&
        isLikelyNonStoreOrTestBranchTitle(game.title)
      )
    ) {
      moduleUnmatchedDiagWeakMap.set(game, {
        overridesRev,
        probeRev,
        eventRev,
        hasProbedEntry: hasProbedEntryForGame,
        probedVal,
        item: null,
      });
      continue;
    }

    const builtItem: IndexedUnmatchedItem = {
      game,
      reasons,
      searchFields: collectGameSearchFields(game),
    };
    moduleUnmatchedDiagWeakMap.set(game, {
      overridesRev,
      probeRev,
      eventRev,
      hasProbedEntry: hasProbedEntryForGame,
      probedVal,
      item: builtItem,
    });
    items.push(builtItem);
  }

  items.sort((a, b) => STUDIO_TITLE_COLLATOR.compare(a.game?.title || '', b.game?.title || ''));
  const idSet = new Set<string>();
  for (let i = 0; i < items.length; i += 1) {
    idSet.add(items[i].game.id);
  }
  return { items, idSet };
}

export function computeBaseLowConfidenceItems(
  games: CanonicalGame[],
  unmatchedSet: Set<string>
): IndexedGameItem[] {
  const overridesMap = loadUserOverrides();
  const overridesRev = resolveEffectiveOverridesRevision(overridesMap);
  const eventRev = moduleStudioEventRevision;
  const items: IndexedGameItem[] = [];

  for (let i = 0; i < games.length; i += 1) {
    const game = games[i];
    if (!game || !game.id) continue;
    const isUnmatched = unmatchedSet.has(game.id);
    const cachedLowConf = moduleLowConfDiagWeakMap.get(game);
    if (
      cachedLowConf &&
      cachedLowConf.overridesRev === overridesRev &&
      cachedLowConf.eventRev === eventRev &&
      cachedLowConf.isUnmatched === isUnmatched
    ) {
      if (cachedLowConf.item) items.push(cachedLowConf.item);
      continue;
    }

    if (isUnmatched || getUserOverrideForGame(game, overridesMap)) {
      moduleLowConfDiagWeakMap.set(game, {
        overridesRev,
        eventRev,
        isUnmatched,
        item: null,
      });
      continue;
    }

    const rawConf =
      typeof game.matchConfidence === 'number'
        ? game.matchConfidence <= 1
          ? game.matchConfidence * 100
          : game.matchConfidence
        : undefined;

    const hasTitleShift =
      Boolean(game.originalStoreTitle) &&
      game.originalStoreTitle !== game.title &&
      normalizeCanonicalTitle(game.originalStoreTitle!) !== normalizeCanonicalTitle(game.title);

    const isLowConf =
      Boolean(game.needsMatchReview) ||
      (typeof rawConf === 'number' && rawConf > 0 && rawConf < 85) ||
      hasTitleShift;

    if (!isLowConf) {
      moduleLowConfDiagWeakMap.set(game, {
        overridesRev,
        eventRev,
        isUnmatched,
        item: null,
      });
      continue;
    }

    const builtItem: IndexedGameItem = {
      game,
      searchFields: collectGameSearchFields(game),
    };
    moduleLowConfDiagWeakMap.set(game, {
      overridesRev,
      eventRev,
      isUnmatched,
      item: builtItem,
    });
    items.push(builtItem);
  }

  items.sort((a, b) => STUDIO_TITLE_COLLATOR.compare(a.game?.title || '', b.game?.title || ''));
  return items;
}

export function computeBaseSuppressedSplit(catalogLookupIndex: CatalogLookupIndex): {
  userSuppressed: IndexedSuppressedItem[];
  autoFiltered: IndexedSuppressedItem[];
} {
  const rawSuppressed = getSuppressedCatalogEntries();
  const userSuppressed: IndexedSuppressedItem[] = [];
  const autoFiltered: IndexedSuppressedItem[] = [];

  for (let i = 0; i < rawSuppressed.length; i += 1) {
    const entry = rawSuppressed[i];
    if (!entry) continue;
    const suppressedGameId = entry.rawGame?.id || entry.id;
    const suppressedGameIdLower = suppressedGameId ? suppressedGameId.toLowerCase() : '';
    const platId = entry.platformId || entry.rawGame?.platforms?.[0]?.platformId;
    const platGameId =
      entry.platformGameId !== undefined &&
      entry.platformGameId !== null &&
      String(entry.platformGameId).trim() !== ''
        ? String(entry.platformGameId).trim()
        : entry.rawGame?.platforms?.[0]?.platformGameId !== undefined
          ? String(entry.rawGame.platforms[0].platformGameId).trim()
          : entry.id;
    const compKey = platId && platGameId ? `${platId}:${platGameId}` : '';
    const compKeyLower = compKey.toLowerCase();
    if (
      (suppressedGameId &&
        (catalogLookupIndex.byId.has(suppressedGameId) ||
          (suppressedGameIdLower && catalogLookupIndex.byIdLower.has(suppressedGameIdLower)))) ||
      (compKey &&
        (catalogLookupIndex.byPlatComposite.has(compKey) ||
          catalogLookupIndex.byPlatCompositeLower.has(compKeyLower)))
    ) {
      continue;
    }

    const searchFields: string[] = [];
    if (entry.rawTitle) searchFields.push(entry.rawTitle);
    if (entry.platformId) searchFields.push(entry.platformId);
    if (entry.platformGameId) searchFields.push(String(entry.platformGameId));
    if (entry.reason) searchFields.push(entry.reason);

    if (entry.reasonCategory === 'user_hidden') {
      userSuppressed.push({
        entry,
        subCategory: 'beta',
        searchFields,
      });
    } else {
      autoFiltered.push({
        entry,
        subCategory: classifyAutoFilteredSubCategory(entry),
        searchFields,
      });
    }
  }

  userSuppressed.sort((a, b) =>
    STUDIO_TITLE_COLLATOR.compare(a.entry?.rawTitle || '', b.entry?.rawTitle || '')
  );
  autoFiltered.sort((a, b) =>
    STUDIO_TITLE_COLLATOR.compare(a.entry?.rawTitle || '', b.entry?.rawTitle || '')
  );

  return { userSuppressed, autoFiltered };
}

export function computeBaseOverrideItems(
  catalogLookupIndex: CatalogLookupIndex
): IndexedOverrideItem[] {
  const allMap = loadUserOverrides();
  const keyToEntryIndex = new Map<string, number>();
  const dedupedList: Array<{ item: IndexedOverrideItem; updatedAtMs: number }> = [];

  for (const [dictKey, ov] of Object.entries(allMap)) {
    if (!ov || !ov.gameId) continue;

    let matchedGame =
      catalogLookupIndex.byId.get(ov.gameId) ??
      catalogLookupIndex.byIdLower.get(ov.gameId.toLowerCase()) ??
      catalogLookupIndex.byId.get(dictKey) ??
      catalogLookupIndex.byIdLower.get(dictKey.toLowerCase());

    if (!matchedGame && ov.steamAppId) {
      matchedGame = catalogLookupIndex.byId.get(`steam-${ov.steamAppId}`);
    }
    if (!matchedGame && ov.matchedStore === 'steam' && ov.matchedId) {
      matchedGame = catalogLookupIndex.byId.get(`steam-${String(ov.matchedId)}`);
    }
    if (!matchedGame && ov.platformId && ov.platformGameId) {
      const compKey = `${ov.platformId}:${String(ov.platformGameId)}`;
      const compLower = compKey.toLowerCase();
      matchedGame = ov.splitFromMerged
        ? (catalogLookupIndex.bySinglePlatComposite.get(compKey) ??
          catalogLookupIndex.bySinglePlatCompositeLower.get(compLower))
        : (catalogLookupIndex.byPlatComposite.get(compKey) ??
          catalogLookupIndex.byPlatCompositeLower.get(compLower));
      if (!matchedGame) {
        matchedGame = catalogLookupIndex.byIdLower.get(
          `${ov.platformId}-${String(ov.platformGameId)}`.toLowerCase()
        );
      }
    }

    const candidateKeys: string[] = [`gid:${ov.gameId.toLowerCase()}`];
    if (dictKey) {
      candidateKeys.push(`gid:${dictKey.toLowerCase()}`);
    }
    if (ov.platformId && ov.platformGameId) {
      candidateKeys.push(
        `plat:${ov.platformId.toLowerCase()}:${String(ov.platformGameId).toLowerCase()}`
      );
    }
    if (matchedGame) {
      const splitSuffix =
        ov.splitFromMerged &&
        ov.platformId &&
        ov.platformGameId &&
        Array.isArray(matchedGame.platforms) &&
        matchedGame.platforms.length > 1
          ? `:split:${ov.platformId.toLowerCase()}:${String(ov.platformGameId).toLowerCase()}`
          : '';
      candidateKeys.push(`matched:${matchedGame.id.toLowerCase()}${splitSuffix}`);
    }

    const searchFields: string[] = [];
    if (ov.title) searchFields.push(ov.title);
    if (ov.originalSourceTitle) searchFields.push(ov.originalSourceTitle);
    if (ov.matchedStore) searchFields.push(ov.matchedStore);
    if (ov.matchedId !== undefined && ov.matchedId !== null && String(ov.matchedId)) {
      searchFields.push(String(ov.matchedId));
    }
    if (ov.platformId) searchFields.push(ov.platformId);
    if (ov.platformGameId !== undefined && ov.platformGameId !== null) {
      searchFields.push(String(ov.platformGameId));
    }
    if (matchedGame?.title) searchFields.push(matchedGame.title);
    if (matchedGame?.originalStoreTitle) searchFields.push(matchedGame.originalStoreTitle);
    if (matchedGame?.id) searchFields.push(matchedGame.id);

    const updatedAtMs = ov.updatedAt ? Date.parse(ov.updatedAt) || 0 : 0;
    const built: IndexedOverrideItem = { override: ov, matchedGame, searchFields };

    let existingIdx: number | undefined;
    for (let k = 0; k < candidateKeys.length; k += 1) {
      const found = keyToEntryIndex.get(candidateKeys[k]);
      if (found !== undefined) {
        existingIdx = found;
        break;
      }
    }

    if (existingIdx !== undefined) {
      if (updatedAtMs >= dedupedList[existingIdx].updatedAtMs) {
        dedupedList[existingIdx] = { item: built, updatedAtMs };
      }
      for (let k = 0; k < candidateKeys.length; k += 1) {
        keyToEntryIndex.set(candidateKeys[k], existingIdx);
      }
    } else {
      const nextIdx = dedupedList.length;
      dedupedList.push({ item: built, updatedAtMs });
      for (let k = 0; k < candidateKeys.length; k += 1) {
        keyToEntryIndex.set(candidateKeys[k], nextIdx);
      }
    }
  }

  const list = dedupedList.map((entry) => entry.item);
  list.sort((a, b) =>
    STUDIO_TITLE_COLLATOR.compare(a.override.title || '', b.override.title || '')
  );
  return list;
}

export function computeBaseMergedItems(games: CanonicalGame[]): IndexedGameItem[] {
  const items: IndexedGameItem[] = [];
  for (let i = 0; i < games.length; i += 1) {
    const game = games[i];
    if (!game || !game.platforms || !Array.isArray(game.platforms)) continue;
    const validPlatforms = game.platforms.filter(
      (p): p is GamePlatformOwnership => Boolean(p && typeof p === 'object' && p.platformId)
    );
    if (validPlatforms.length <= 1) continue;
    items.push({
      game,
      searchFields: collectGameSearchFields(game),
    });
  }

  items.sort((a, b) => STUDIO_TITLE_COLLATOR.compare(a.game?.title || '', b.game?.title || ''));
  return items;
}

export function partitionAutoFilteredByConfirmation(
  searchedAutoFilteredItems: IndexedSuppressedItem[]
): {
  unreviewedAutoFilteredItems: IndexedSuppressedItem[];
  confirmedAutoFilteredEntries: SuppressedCatalogEntry[];
} {
  const confirmedKeys = loadConfirmedNonGameKeys();
  const hasConfirmedKeys = confirmedKeys.size > 0;
  const unreviewed: IndexedSuppressedItem[] = [];
  const confirmed: SuppressedCatalogEntry[] = [];
  for (let i = 0; i < searchedAutoFilteredItems.length; i += 1) {
    const item = searchedAutoFilteredItems[i];
    const { entry } = item;
    const isConfirmed =
      hasConfirmedKeys &&
      (Boolean(
        entry.platformId &&
          entry.platformGameId &&
          (confirmedKeys.has(`${entry.platformId}:${entry.platformGameId}`) ||
            confirmedKeys.has(`${entry.platformId}-${entry.platformGameId}`))
      ) ||
        Boolean(entry.id && (confirmedKeys.has(entry.id) || confirmedKeys.has(`game:${entry.id}`))));
    if (isConfirmed) {
      confirmed.push(entry);
    } else {
      unreviewed.push(item);
    }
  }
  return {
    unreviewedAutoFilteredItems: unreviewed,
    confirmedAutoFilteredEntries: confirmed,
  };
}
