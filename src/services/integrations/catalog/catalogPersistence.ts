import type { CriticScoreData } from '../../../contracts/critic';
import { CanonicalGame } from '../../../contracts/game';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';
import { isModalOverlayOpen } from '../../../utils/modalOverlayLock';
import { isUserActivelyScrolling } from '../../../utils/scrollActivityTracker';
import { getSafeLocalStorage } from '../../common/runtimeEnv';
import { stripStorefrontPlatformDisambiguators } from '../../common/titleUtils';
import { criticScoreService } from '../../critic/criticScoreService';
import { calculateTier, parseVaultCriticScore } from '../../critic/criticUtils';
import { isAnchorSlugCompatible } from '../../critic/metacriticResolver';
import { recoverSteamAnchorFromVault } from '../../critic/storefrontReviewHarvester';
import { seedHltbFromVaultIfMissing } from '../../hltb/howLongToBeat';
import { steamMatcher } from '../../steam/steamMatcher';
import { FULL_USER_STEAM_GAMES } from '../../storage/fullUserSteamGames';
import { vaultDelete, vaultGet, vaultSet } from '../../storage/indexedDbVault';
import { pickBestEnrichedMetadata } from '../../storage/librarySync';
import { clearExpiredStagedCache } from '../../storage/stagedCacheService';
import { EPIC_USER_LIBRARY, GOG_USER_LIBRARY } from '../../storage/storefrontLibraries';
import {
  applyUserOverridesToCatalog,
  getUserOverrideForGame,
  hydrateUserOverridesFromVault,
  inferReviewRouteFromOverride,
  isEnrichedMetadataIncompatibleWithOverride,
  loadUserOverrides,
} from '../../storage/userOverrideStorage';
import { hydrateUserTagOverridesFromVault } from '../../storage/userTagStorage';
import { sanitizeGameCatalog } from '../catalogSanitizer';
import { mergeHydratedCatalogPreservingLiveState, mergeStorefrontGames } from './catalogMerger';
import {
  PROACTIVE_SLIM_LOCALSTORAGE_CHAR_THRESHOLD,
  PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD,
  compactGameForStorage,
  computeCatalogFingerprint,
  computeCatalogGamesFingerprint,
  isDonorGameCompatibleWithTarget,
  recoverRichSummaryFieldsFromDonor,
  slimGameForLocalStorageQuota,
} from './catalogSlimming';
import {
  STORAGE_KEY_INTEGRATIONS,
  STORAGE_KEY_VERIFIED_ENTITLEMENTS,
  STORAGE_KEY_XBOX_PROFILE,
  clearSessionApiKeys,
} from './entitlementsAndProfileStore';
import {
  collectDroppedAndSelfHealedCatalogDelta,
  deleteOrphanedGamesFromOfflineVault,
  preserveLocalInstallFieldsAcrossSanitize,
} from './installedReconciler';

const IDB_KEY_MAIN_CATALOG = 'idb_universal_game_library_catalog_v2';
const STORAGE_KEY_CUSTOM_GAMES = 'antigravity_synced_user_games';
const STORAGE_KEY_MAIN_CATALOG = 'universal_game_library_catalog';

export interface SaveCatalogOptions {
  immediate?: boolean;
  skipSanitize?: boolean;
  dirtyGameIds?: ReadonlySet<string> | readonly string[];
  dirtyGames?: readonly CanonicalGame[];
  removedGameIds?: ReadonlySet<string> | readonly string[];
}

const MODAL_CLOSE_FLUSH_DEBOUNCE_MS = 250;
const SMALL_DELTA_COALESCE_DEBOUNCE_MS = 250;
const SMALL_DELTA_MAX_DIRTY_GAMES = 20;
const SMALL_DELTA_SNAPSHOT_DEBOUNCE_MS = 3000;

/**
 * Checks dynamic `process.env` test flags directly so unit tests that toggle
 * `delete process.env.VITEST; process.env.NODE_ENV = 'production'` can exercise
 * production debounce/modal-deferral paths deterministically.
 */
function isTestEnv(): boolean {
  try {
    if (typeof process === 'undefined' || !process.env) return false;
    return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  } catch {
    return false;
  }
}

let inMemoryCatalogCache: CanonicalGame[] | null = null;
let inMemoryCatalogRawRef: string | null = null;
let lastPersistedVaultCatalogIds: Set<string> | null = null;
let pendingCatalogSaveTimer: ReturnType<typeof setTimeout> | null = null;
let modalCloseFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshotMirrorTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshotGames: CanonicalGame[] | null = null;
let pendingCatalogGames: CanonicalGame[] | null = null;
let pendingCatalogNeedsSanitize = false;
let pendingCatalogNeedsOverrides = false;
let pendingIsFullCatalogSync = false;
const pendingDirtyGameIds = new Set<string>();
const pendingRemovedGameIds = new Set<string>();
let pendingModalDeferStartedAt: number | null = null;

function collectDirtyGameIdsFromOptions(options?: SaveCatalogOptions): string[] | null {
  if (
    !options ||
    (options.dirtyGameIds === undefined &&
      options.dirtyGames === undefined &&
      options.removedGameIds === undefined)
  ) {
    return null;
  }
  const ids: string[] = [];
  if (options.dirtyGameIds) {
    for (const id of options.dirtyGameIds) {
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  if (Array.isArray(options.dirtyGames)) {
    for (const g of options.dirtyGames) {
      if (g?.id) ids.push(g.id);
    }
  }
  return ids;
}

function collectRemovedGameIdsFromOptions(options?: SaveCatalogOptions): string[] {
  if (!options?.removedGameIds) return [];
  const ids: string[] = [];
  for (const id of options.removedGameIds) {
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

function evictExpendableCachesForCatalogQuota(): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    clearExpiredStagedCache();
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (
        key &&
        (key.startsWith('antigravity_detailed_achievements_') ||
          key.startsWith('antigravity_achievement_details_'))
      ) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      storage.removeItem(k);
    }
  } catch {
    // Ignore storage cleanup errors
  }
}

function persistCatalogSnapshotToIdbAndLocalStorage(
  compacted: CanonicalGame[],
  options?: { skipIdbOverwrite?: boolean }
): void {
  // Primary rich persistence in IndexedDB vault (non-blocking, GB-scale quota).
  // Never overwrite IndexedDB with a pure __quotaSlimmed cold-boot projection.
  if (!options?.skipIdbOverwrite) {
    void vaultSet(IDB_KEY_MAIN_CATALOG, compacted);
  }

  const storage = getSafeLocalStorage();
  if (!storage) {
    inMemoryCatalogRawRef = computeCatalogGamesFingerprint(compacted);
    return;
  }

  let persistedRaw: string | null = null;
  try {
    const serialized =
      compacted.length > PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD
        ? null
        : JSON.stringify(compacted);
    if (serialized === null || serialized.length > PROACTIVE_SLIM_LOCALSTORAGE_CHAR_THRESHOLD) {
      const slimSerialized = JSON.stringify(compacted.map(slimGameForLocalStorageQuota));
      try {
        storage.setItem(STORAGE_KEY_MAIN_CATALOG, slimSerialized);
        persistedRaw = slimSerialized;
      } catch {
        evictExpendableCachesForCatalogQuota();
        try {
          storage.setItem(STORAGE_KEY_MAIN_CATALOG, slimSerialized);
          persistedRaw = slimSerialized;
        } catch {
          const sentinel = JSON.stringify({
            __idbVaultOnly: true,
            count: compacted.length,
            fp: computeCatalogGamesFingerprint(compacted),
          });
          try {
            storage.setItem(STORAGE_KEY_MAIN_CATALOG, sentinel);
            persistedRaw = sentinel;
          } catch {
            // IndexedDB vault & inMemoryCatalogCache remain authoritative
          }
        }
      }
    } else {
      try {
        storage.setItem(STORAGE_KEY_MAIN_CATALOG, serialized);
        persistedRaw = serialized;
      } catch {
        evictExpendableCachesForCatalogQuota();
        try {
          storage.setItem(STORAGE_KEY_MAIN_CATALOG, serialized);
          persistedRaw = serialized;
        } catch {
          const slimSerialized = JSON.stringify(compacted.map(slimGameForLocalStorageQuota));
          try {
            storage.setItem(STORAGE_KEY_MAIN_CATALOG, slimSerialized);
            persistedRaw = slimSerialized;
          } catch {
            const sentinel = JSON.stringify({
              __idbVaultOnly: true,
              count: compacted.length,
              fp: computeCatalogGamesFingerprint(compacted),
            });
            try {
              storage.setItem(STORAGE_KEY_MAIN_CATALOG, sentinel);
              persistedRaw = sentinel;
            } catch {
              // IndexedDB vault & inMemoryCatalogCache remain authoritative
            }
          }
        }
      }
    }
  } catch {
    // Ignore serialization fallback errors
  }

  inMemoryCatalogRawRef =
    persistedRaw !== null
      ? computeCatalogFingerprint(persistedRaw)
      : computeCatalogGamesFingerprint(compacted);

  const customGames = compacted.filter(
    (g) =>
      g.platforms?.some((p) => p.platformId === 'custom') ||
      !g.platforms?.some((p) => ['steam', 'gog', 'epic', 'xbox'].includes(p.platformId))
  );
  if (customGames.length > 0) {
    try {
      storage.setItem(STORAGE_KEY_CUSTOM_GAMES, JSON.stringify(customGames));
    } catch {
      // Ignore custom games mirror write errors
    }
  } else {
    try {
      storage.removeItem(STORAGE_KEY_CUSTOM_GAMES);
    } catch {
      // Ignore removal errors
    }
  }
}

function scheduleDebouncedCatalogSnapshotMirror(compacted: CanonicalGame[]): void {
  pendingSnapshotGames = compacted;
  if (pendingSnapshotMirrorTimer) {
    clearTimeout(pendingSnapshotMirrorTimer);
    pendingSnapshotMirrorTimer = null;
  }
  const scheduleMirror = (delayMs: number) => {
    pendingSnapshotMirrorTimer = setTimeout(() => {
      pendingSnapshotMirrorTimer = null;
      if (!isTestEnv() && (isModalOverlayOpen() || isUserActivelyScrolling())) {
        scheduleMirror(600);
        return;
      }
      const snap = pendingSnapshotGames;
      pendingSnapshotGames = null;
      if (snap) {
        persistCatalogSnapshotToIdbAndLocalStorage(snap);
      }
    }, delayMs);
  };
  scheduleMirror(SMALL_DELTA_SNAPSHOT_DEBOUNCE_MS);
}

function writeCatalogToLocalStorage(
  cleaned: CanonicalGame[],
  dirtyIds?: ReadonlySet<string> | null,
  removedIds?: ReadonlySet<string> | null,
  writeOptions?: { deferSnapshotMirror?: boolean }
): void {
  const previousInMemory = inMemoryCatalogCache;
  let compacted = cleaned.map(compactGameForStorage);

  // Guard against slimmed projections overwriting non-slimmed in-memory / durable records
  const hasIncomingSlimmed = compacted.some((g) => Boolean(g?.enrichedMetadata?.__quotaSlimmed));
  if (hasIncomingSlimmed && Array.isArray(previousInMemory) && previousInMemory.length > 0) {
    const prevById = new Map<string, CanonicalGame[]>();
    for (const pg of previousInMemory) {
      if (pg?.id && !pg.enrichedMetadata?.__quotaSlimmed) {
        let list = prevById.get(pg.id);
        if (!list) {
          list = [];
          prevById.set(pg.id, list);
        }
        list.push(pg);
      }
    }
    if (prevById.size > 0) {
      const loadedOverrides = loadUserOverrides();
      const hasAnyOverrides = Object.keys(loadedOverrides).length > 0;
      compacted = compacted.map((g) => {
        if (!g?.id || !g.enrichedMetadata?.__quotaSlimmed) return g;
        const prevCandidates = prevById.get(g.id);
        const prevRich = prevCandidates?.find((cand) => isDonorGameCompatibleWithTarget(g, cand));
        if (!prevRich) return g;
        const gOv = hasAnyOverrides ? getUserOverrideForGame(g, loadedOverrides) : undefined;
        const compatiblePrevMeta =
          prevRich.enrichedMetadata &&
          !isEnrichedMetadataIncompatibleWithOverride(prevRich.enrichedMetadata, gOv, g)
            ? prevRich.enrichedMetadata
            : undefined;
        const mergedMeta = compatiblePrevMeta
          ? pickBestEnrichedMetadata(compatiblePrevMeta, g.enrichedMetadata)
          : g.enrichedMetadata;
        const withRichMeta =
          mergedMeta !== g.enrichedMetadata ? { ...g, enrichedMetadata: mergedMeta } : g;
        const allowReviewScoreOverride = hasAnyOverrides
          ? Boolean(gOv && (gOv.reviewScoreOverride !== undefined || gOv.reviewRoute !== undefined))
          : true;
        return recoverRichSummaryFieldsFromDonor(withRichMeta, prevRich, mergedMeta, true, {
          allowReviewScoreOverride,
        });
      });
    }
  }

  const hasRemainingSlimmed = compacted.some((g) => Boolean(g?.enrichedMetadata?.__quotaSlimmed));
  const hasAnyNonSlimmedEnriched = compacted.some((g) =>
    Boolean(g?.enrichedMetadata && !g.enrichedMetadata.__quotaSlimmed)
  );
  const isPureSlimmedSnapshot = hasRemainingSlimmed && !hasAnyNonSlimmedEnriched;

  inMemoryCatalogCache = compacted;

  const isFullCatalogWrite = dirtyIds === null || dirtyIds === undefined;
  if (!isPureSlimmedSnapshot) {
    if (isFullCatalogWrite) {
      const nextIdSet = new Set<string>();
      for (const g of compacted) {
        if (g?.id) nextIdSet.add(g.id);
      }
      const removedIdSet = new Set<string>();
      if (Array.isArray(previousInMemory) && previousInMemory.length > 0) {
        for (const pg of previousInMemory) {
          if (pg?.id && !nextIdSet.has(pg.id)) {
            removedIdSet.add(pg.id);
          }
        }
      }
      if (lastPersistedVaultCatalogIds && lastPersistedVaultCatalogIds.size > 0) {
        for (const prevId of lastPersistedVaultCatalogIds) {
          if (prevId && !nextIdSet.has(prevId)) {
            removedIdSet.add(prevId);
          }
        }
      }
      if (removedIdSet.size > 0) {
        deleteOrphanedGamesFromOfflineVault(Array.from(removedIdSet));
      }
      lastPersistedVaultCatalogIds = nextIdSet;
    } else if (removedIds && removedIds.size > 0) {
      const nextIdSet = new Set<string>();
      for (const g of compacted) {
        if (g?.id) nextIdSet.add(g.id);
      }
      const confirmedRemoved: string[] = [];
      for (const remId of removedIds) {
        if (remId && !nextIdSet.has(remId)) {
          confirmedRemoved.push(remId);
          lastPersistedVaultCatalogIds?.delete(remId);
        }
      }
      if (confirmedRemoved.length > 0) {
        deleteOrphanedGamesFromOfflineVault(confirmedRemoved);
      }
    }
  }

  // Mirror catalog snapshot to Electron SQLite offlineVault when available (non-blocking).
  // Never mirror a pure __quotaSlimmed cold-boot projection into SQLite!
  if (
    !isPureSlimmedSnapshot &&
    typeof window !== 'undefined' &&
    window.electronAPI?.offlineVault?.upsertGames
  ) {
    try {
      const ipcPayload =
        dirtyIds !== null && dirtyIds !== undefined
          ? dirtyIds.size === 0
            ? []
            : dirtyIds.size < compacted.length
            ? compacted.filter((g) => Boolean(g && dirtyIds.has(g.id)))
            : compacted
          : compacted;
      if (!isFullCatalogWrite && lastPersistedVaultCatalogIds) {
        for (const g of ipcPayload) {
          if (g?.id) lastPersistedVaultCatalogIds.add(g.id);
        }
      }
      if (ipcPayload.length > 0) {
        void window.electronAPI.offlineVault.upsertGames(ipcPayload)?.catch?.(() => {});
      }
    } catch {
      // Ignore offlineVault IPC bridge errors
    }
  }

  const isSmallDeltaOnLargeCatalog = Boolean(
    !isPureSlimmedSnapshot &&
      writeOptions?.deferSnapshotMirror === true &&
      dirtyIds !== null &&
      dirtyIds !== undefined &&
      dirtyIds.size > 0 &&
      dirtyIds.size <= SMALL_DELTA_MAX_DIRTY_GAMES &&
      compacted.length > PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD
  );

  if (isSmallDeltaOnLargeCatalog) {
    scheduleDebouncedCatalogSnapshotMirror(compacted);
    return;
  }

  if (pendingSnapshotMirrorTimer) {
    clearTimeout(pendingSnapshotMirrorTimer);
    pendingSnapshotMirrorTimer = null;
  }
  pendingSnapshotGames = null;
  persistCatalogSnapshotToIdbAndLocalStorage(compacted, {
    skipIdbOverwrite: isPureSlimmedSnapshot,
  });
}

const LAZY_STEAM_ANCHOR_RECOVERY_CHUNK_SIZE = 16;
let lazySteamAnchorRecoveryToken = 0;
let lazySteamAnchorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

function hasValidSteamMetacriticOnGame(game: CanonicalGame): boolean {
  const meta = game.enrichedMetadata;
  if (!meta?.metacritic || typeof meta.metacritic !== 'object') return false;
  if (
    meta.metadataQuality === 'local_federated' ||
    String(meta.enrichedSource || '') === 'local_federated'
  ) {
    return false;
  }
  const score = meta.metacritic.score;
  const url = typeof meta.metacritic.url === 'string' ? meta.metacritic.url.trim() : '';
  const hasMcUrl = /^https?:\/\/(?:www\.)?metacritic\.com\/game\//i.test(url);
  if (hasMcUrl) return true;
  return (
    meta.enrichedSource === 'steam' &&
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score > 0
  );
}

/**
 * Lazy chunked background pass recovering verified Steam `metacritic` anchors from IndexedDB
 * (`enriched_metadata:<appId>`) for Steam-linked games missing `enrichedMetadata.metacritic`.
 * Updates `inMemoryCatalogCache` IMMUTABLY so WeakMap memos and React referential equality
 * are never poisoned by in-place mutation.
 */
export function scheduleLazySteamAnchorVaultRecovery(games: CanonicalGame[]): void {
  if (typeof window === 'undefined' || !Array.isArray(games) || games.length === 0) return;

  const candidates: Array<{ game: CanonicalGame; steamAppId: number }> = [];
  for (const g of games) {
    if (!g?.id || !g.title) continue;
    if (hasValidSteamMetacriticOnGame(g)) continue;
    const effectiveSteamAppId = steamMatcher.getEffectiveSteamAppId(g);
    if (typeof effectiveSteamAppId === 'number' && effectiveSteamAppId > 0) {
      candidates.push({ game: g, steamAppId: effectiveSteamAppId });
    }
  }

  if (candidates.length === 0) return;

  const myToken = ++lazySteamAnchorRecoveryToken;
  if (lazySteamAnchorRecoveryTimer !== null) {
    clearTimeout(lazySteamAnchorRecoveryTimer);
    lazySteamAnchorRecoveryTimer = null;
  }

  let cursor = 0;
  let upgradedCount = 0;

  const scheduleNext = (fn: () => void) => {
    const handle = setTimeout(fn, 0);
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    lazySteamAnchorRecoveryTimer = handle;
  };

  const runChunk = async () => {
    lazySteamAnchorRecoveryTimer = null;
    if (myToken !== lazySteamAnchorRecoveryToken) return;

    const end = Math.min(candidates.length, cursor + LAZY_STEAM_ANCHOR_RECOVERY_CHUNK_SIZE);
    const slice = candidates.slice(cursor, end);
    cursor = end;

    const immutableUpdatesById = new Map<string, CanonicalGame['enrichedMetadata']>();

    for (const { game, steamAppId } of slice) {
      if (myToken !== lazySteamAnchorRecoveryToken) return;
      try {
        const anchor = await recoverSteamAnchorFromVault(steamAppId);
        if (
          !anchor ||
          typeof anchor.metacriticScore !== 'number' ||
          !Number.isFinite(anchor.metacriticScore) ||
          anchor.metacriticScore <= 0
        ) {
          continue;
        }
        if (anchor.metacriticSlug && !isAnchorSlugCompatible(game.title, anchor.metacriticSlug)) {
          continue;
        }

        const roundedScore = Math.round(anchor.metacriticScore);
        const mcSlug = anchor.metacriticSlug || '';
        const canonicalMcUrl =
          anchor.metacriticUrl ||
          (mcSlug
            ? `https://www.metacritic.com/game/${mcSlug}/critic-reviews/`
            : `https://store.steampowered.com/app/${steamAppId}`);

        const recoveredCritic: CriticScoreData = {
          id: mcSlug ? `mc-${mcSlug}` : `steam-mc-${steamAppId}`,
          source: 'metacritic',
          score: roundedScore,
          tier: calculateTier(roundedScore),
          numReviews: 20,
          url: canonicalMcUrl,
          summary: 'Verified by official STEAM store review anchor.',
          isVerified: true,
          isSynthetic: false,
        };

        const activeOverride = getUserOverrideForGame(game);
        const hasActiveReviewOverride = Boolean(
          activeOverride &&
            (activeOverride.reviewRoute !== undefined ||
              activeOverride.reviewScoreOverride !== undefined ||
              inferReviewRouteFromOverride(activeOverride))
        );

        const upgraded = hasActiveReviewOverride
          ? false
          : criticScoreService.seedFromVaultIfMissing(
              steamAppId,
              game.title,
              recoveredCritic,
              game.releaseDate,
              game.genres,
              { gameId: game.id, platforms: game.platforms }
            );

        let updatedEnrichedMetadata: CanonicalGame['enrichedMetadata'] | undefined;
        if (
          game.enrichedMetadata &&
          !game.enrichedMetadata.__quotaSlimmed &&
          game.enrichedMetadata.metadataQuality !== 'local_federated'
        ) {
          updatedEnrichedMetadata = {
            ...game.enrichedMetadata,
            metacritic: {
              score: roundedScore,
              url: canonicalMcUrl,
            },
          };
          immutableUpdatesById.set(game.id, updatedEnrichedMetadata);
        }

        const shouldPersistRecoveredCritic = upgraded && !hasActiveReviewOverride;
        if (
          (shouldPersistRecoveredCritic || updatedEnrichedMetadata) &&
          window.electronAPI?.offlineVault?.saveGameDetail
        ) {
          try {
            void window.electronAPI.offlineVault
              .saveGameDetail({
                gameId: game.id,
                steamAppId,
                canonicalTitle: game.title,
                ...(updatedEnrichedMetadata ? { enrichedMetadata: updatedEnrichedMetadata } : {}),
                ...(shouldPersistRecoveredCritic ? { criticScore: recoveredCritic } : {}),
              })
              ?.catch?.(() => {});
          } catch {
            // Ignore offlineVault IPC bridge errors
          }
        }

        if (upgraded) {
          upgradedCount += 1;
        }
      } catch {
        // Ignore individual vault lookup failures
      }
    }

    if (myToken !== lazySteamAnchorRecoveryToken) return;

    // Apply recovered metacritic anchors immutably to inMemoryCatalogCache (never mutating caller objects)
    if (immutableUpdatesById.size > 0 && Array.isArray(inMemoryCatalogCache)) {
      let anyCacheUpdated = false;
      const nextCache = inMemoryCatalogCache.map((cachedGame) => {
        const nextMeta = cachedGame?.id ? immutableUpdatesById.get(cachedGame.id) : undefined;
        if (!nextMeta || !cachedGame.enrichedMetadata || cachedGame.enrichedMetadata.__quotaSlimmed) {
          return cachedGame;
        }
        anyCacheUpdated = true;
        return {
          ...cachedGame,
          enrichedMetadata: {
            ...cachedGame.enrichedMetadata,
            metacritic: nextMeta.metacritic,
          },
        };
      });
      if (anyCacheUpdated) {
        inMemoryCatalogCache = nextCache;
      }
    }

    if (cursor < candidates.length) {
      scheduleNext(() => {
        void runChunk();
      });
      return;
    }

    if (
      upgradedCount > 0 &&
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function'
    ) {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity_critic_updated', {
            detail: { hydratedFromVault: true },
          })
        );
      } catch {
        // Ignore DOM dispatch errors
      }
    }
  };

  scheduleNext(() => {
    void runChunk();
  });
}

/**
 * Asynchronously hydrates the full rich catalog from IndexedDB on startup,
 * seamlessly upgrading any quota-slimmed localStorage snapshot or migrating
 * legacy localStorage catalogs into IndexedDB on first run.
 */
export async function hydrateCatalogFromIndexedDb(): Promise<CanonicalGame[] | null> {
  if (typeof window === 'undefined') return null;
  await hydrateUserOverridesFromVault().catch(() => false);
  await hydrateUserTagOverridesFromVault().catch(() => false);
  let vaultCatalog = await vaultGet<CanonicalGame[]>(IDB_KEY_MAIN_CATALOG);
  let vaultSnapIds: Set<string> | null = null;
  let hydratedAnyCriticFromVault = false;

  if (window.electronAPI?.offlineVault?.getCatalogSnapshot) {
    try {
      const snap = await window.electronAPI.offlineVault.getCatalogSnapshot();
      const details = snap?.details || {};
      if (snap?.success && Array.isArray(snap.games) && snap.games.length > 0) {
        const hasAuthoritativeIdbCatalog = Array.isArray(vaultCatalog) && vaultCatalog.length > 0;
        const existingIdbById = hasAuthoritativeIdbCatalog
          ? new Map<string, CanonicalGame[]>()
          : null;
        if (existingIdbById && vaultCatalog) {
          for (const vg of vaultCatalog) {
            if (!vg?.id) continue;
            let list = existingIdbById.get(vg.id);
            if (!list) {
              list = [];
              existingIdbById.set(vg.id, list);
            }
            list.push(vg);
          }
        }
        vaultSnapIds = new Set<string>();
        for (const g of snap.games) {
          if (!g?.id) continue;
          vaultSnapIds.add(g.id);
          if (existingIdbById) {
            const matchingIdbGames = existingIdbById.get(g.id);
            if (
              !matchingIdbGames ||
              !matchingIdbGames.some((vg) => isDonorGameCompatibleWithTarget(vg, g))
            ) {
              continue;
            }
          }
          const detailEntry = details[g.id];
          const vaultCriticData = parseVaultCriticScore(detailEntry?.criticScore);
          if (vaultCriticData) {
            const effectiveSteamAppId = steamMatcher.getEffectiveSteamAppId(g) ?? g.steamAppId;
            const seeded = criticScoreService.seedFromVaultIfMissing(
              effectiveSteamAppId,
              g.title,
              vaultCriticData,
              g.releaseDate,
              g.genres,
              { gameId: g.id, platforms: g.platforms }
            );
            if (seeded) {
              hydratedAnyCriticFromVault = true;
            }
          }
          if (detailEntry?.hltb && typeof detailEntry.hltb === 'object') {
            seedHltbFromVaultIfMissing(g.title, g.steamAppId ?? undefined, detailEntry.hltb);
          }
        }
        if (!hasAuthoritativeIdbCatalog) {
          const loadedOverrides = loadUserOverrides();
          vaultCatalog = snap.games.map((g) => {
            const ov = getUserOverrideForGame(g, loadedOverrides);
            const detailEntry = g?.id ? details[g.id] : undefined;
            const rawDetailMeta = detailEntry?.enrichedMetadata ?? undefined;
            const compatibleDetailMeta =
              rawDetailMeta && !isEnrichedMetadataIncompatibleWithOverride(rawDetailMeta, ov, g)
                ? rawDetailMeta
                : undefined;
            const detailMeta =
              compatibleDetailMeta && detailEntry?.enrichedAt && !compatibleDetailMeta.enrichedAt
                ? { ...compatibleDetailMeta, enrichedAt: detailEntry.enrichedAt }
                : compatibleDetailMeta;
            const compatibleGameMeta =
              g.enrichedMetadata &&
              !isEnrichedMetadataIncompatibleWithOverride(g.enrichedMetadata, ov, g)
                ? g.enrichedMetadata
                : undefined;
            const mergedMeta = pickBestEnrichedMetadata(compatibleGameMeta, detailMeta);
            return mergedMeta !== g.enrichedMetadata
              ? { ...g, enrichedMetadata: mergedMeta }
              : g;
          });
          void vaultSet(IDB_KEY_MAIN_CATALOG, vaultCatalog);
        } else {
          const loadedOverrides = loadUserOverrides();
          const hasAnyOverrides = Object.keys(loadedOverrides).length > 0;
          const snapGamesById = new Map<string, CanonicalGame[]>();
          for (const sg of snap.games) {
            if (!sg?.id) continue;
            let list = snapGamesById.get(sg.id);
            if (!list) {
              list = [];
              snapGamesById.set(sg.id, list);
            }
            list.push(sg);
          }
          let upgradedAnyFromVaultDetails = false;
          vaultCatalog = vaultCatalog!.map((g) => {
            const ov = getUserOverrideForGame(g, loadedOverrides);
            const rawSnapCandidates = g?.id ? snapGamesById.get(g.id) : undefined;
            const snapGame = rawSnapCandidates?.find((cand) =>
              isDonorGameCompatibleWithTarget(g, cand)
            );
            const hadIncompatibleSnapGame = Boolean(
              rawSnapCandidates && rawSnapCandidates.length > 0 && !snapGame
            );
            const detailEntry = !hadIncompatibleSnapGame && g?.id ? details[g.id] : undefined;
            const rawDetailMeta =
              detailEntry?.enrichedMetadata ?? snapGame?.enrichedMetadata ?? undefined;
            const compatibleDetailMeta =
              rawDetailMeta && !isEnrichedMetadataIncompatibleWithOverride(rawDetailMeta, ov, g)
                ? rawDetailMeta
                : undefined;
            const detailMeta =
              compatibleDetailMeta && detailEntry?.enrichedAt && !compatibleDetailMeta.enrichedAt
                ? { ...compatibleDetailMeta, enrichedAt: detailEntry.enrichedAt }
                : compatibleDetailMeta;
            const compatibleIdbMeta =
              g.enrichedMetadata &&
              !isEnrichedMetadataIncompatibleWithOverride(g.enrichedMetadata, ov, g)
                ? g.enrichedMetadata
                : undefined;
            const mergedMeta = detailMeta
              ? pickBestEnrichedMetadata(compatibleIdbMeta, detailMeta)
              : compatibleIdbMeta;
            let nextGame =
              mergedMeta !== g.enrichedMetadata ? { ...g, enrichedMetadata: mergedMeta } : g;
            if (snapGame || (mergedMeta && !mergedMeta.__quotaSlimmed)) {
              const allowReviewScoreOverride = hasAnyOverrides
                ? Boolean(ov && (ov.reviewScoreOverride !== undefined || ov.reviewRoute !== undefined))
                : true;
              const recovered = recoverRichSummaryFieldsFromDonor(
                nextGame,
                snapGame,
                mergedMeta,
                Boolean(g.enrichedMetadata?.__quotaSlimmed),
                { allowReviewScoreOverride }
              );
              if (recovered !== nextGame) {
                nextGame = recovered;
              }
            }
            if (nextGame !== g) {
              upgradedAnyFromVaultDetails = true;
            }
            return nextGame;
          });
          if (upgradedAnyFromVaultDetails) {
            void vaultSet(IDB_KEY_MAIN_CATALOG, vaultCatalog);
          }
        }
      }
    } catch {
      // Ignore offlineVault IPC snapshot errors
    }
  }

  if (Array.isArray(vaultCatalog) && vaultCatalog.length > 0) {
    const hadUnstrippedXboxTitles = vaultCatalog.some(
      (g) =>
        g?.platforms?.some((p) => p?.platformId === 'xbox') &&
        typeof g?.title === 'string' &&
        stripStorefrontPlatformDisambiguators(g.title) !== g.title
    );
    // sanitizeGameCatalog already applies userOverrides cleanly in one pass
    const cleaned = preserveLocalInstallFieldsAcrossSanitize(
      vaultCatalog,
      sanitizeGameCatalog(vaultCatalog, { allowNewPurchases: true })
    );
    if (cleaned.length > 0 || !inMemoryCatalogCache || inMemoryCatalogCache.length === 0) {
      const mergedCache =
        inMemoryCatalogCache && inMemoryCatalogCache.length > 0
          ? mergeHydratedCatalogPreservingLiveState(inMemoryCatalogCache, cleaned)
          : cleaned;
      inMemoryCatalogCache = mergedCache;
      const survivingIdSet = new Set<string>();
      for (const mg of mergedCache) {
        if (mg?.id) survivingIdSet.add(mg.id);
      }
      const { droppedVaultIds, platformOrVersionHealed } = collectDroppedAndSelfHealedCatalogDelta(
        vaultCatalog,
        mergedCache,
        vaultSnapIds
      );
      if (droppedVaultIds.length > 0) {
        deleteOrphanedGamesFromOfflineVault(droppedVaultIds);
      }
      lastPersistedVaultCatalogIds = survivingIdSet;
      if (
        hadUnstrippedXboxTitles ||
        cleaned.length !== vaultCatalog.length ||
        platformOrVersionHealed
      ) {
        const storage = getSafeLocalStorage();
        const existingRaw = storage?.getItem(STORAGE_KEY_MAIN_CATALOG);
        if (existingRaw && !existingRaw.includes('"__idbVaultOnly":true')) {
          writeCatalogToLocalStorage(mergedCache);
        } else {
          void vaultSet(IDB_KEY_MAIN_CATALOG, mergedCache);
        }
      }
      if (
        hydratedAnyCriticFromVault &&
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function'
      ) {
        try {
          window.dispatchEvent(
            new CustomEvent('antigravity_critic_updated', {
              detail: { hydratedFromVault: true },
            })
          );
        } catch {
          // Ignore DOM dispatch errors
        }
      }
      scheduleLazySteamAnchorVaultRecovery(mergedCache);
      return mergedCache;
    }
  } else if (inMemoryCatalogCache && inMemoryCatalogCache.length > 0) {
    const inMemoryHasQuotaSlimmed = inMemoryCatalogCache.some((g) =>
      Boolean(g?.enrichedMetadata?.__quotaSlimmed)
    );
    if (!inMemoryHasQuotaSlimmed) {
      void vaultSet(IDB_KEY_MAIN_CATALOG, inMemoryCatalogCache);
      lastPersistedVaultCatalogIds = new Set(
        inMemoryCatalogCache.map((g) => g?.id).filter((id): id is string => Boolean(id))
      );
      if (window.electronAPI?.offlineVault?.upsertGames) {
        try {
          void window.electronAPI.offlineVault.upsertGames(inMemoryCatalogCache)?.catch?.(() => {});
        } catch {
          // Ignore offlineVault IPC errors
        }
      }
    }
  }
  return null;
}

export const loadNormalizedCatalogAsync = hydrateCatalogFromIndexedDb;

function flushPendingCatalogSaveInternal(options?: {
  allowDeferredSnapshotMirror?: boolean;
}): void {
  const allowDeferredSnapshotMirror = options?.allowDeferredSnapshotMirror === true;
  if (pendingCatalogSaveTimer) {
    clearTimeout(pendingCatalogSaveTimer);
    pendingCatalogSaveTimer = null;
  }
  if (modalCloseFlushTimer) {
    clearTimeout(modalCloseFlushTimer);
    modalCloseFlushTimer = null;
  }
  if (!allowDeferredSnapshotMirror && pendingSnapshotMirrorTimer) {
    clearTimeout(pendingSnapshotMirrorTimer);
    pendingSnapshotMirrorTimer = null;
  }
  if (pendingCatalogGames !== null && typeof window !== 'undefined') {
    try {
      let toWrite = pendingCatalogGames;
      const dirtySnapshot: ReadonlySet<string> | null =
        !pendingIsFullCatalogSync &&
        (pendingDirtyGameIds.size > 0 ||
          pendingRemovedGameIds.size > 0 ||
          pendingModalDeferStartedAt !== null)
          ? new Set<string>(pendingDirtyGameIds)
          : null;
      const removedSnapshot: ReadonlySet<string> | null =
        !pendingIsFullCatalogSync && pendingRemovedGameIds.size > 0
          ? new Set<string>(pendingRemovedGameIds)
          : null;
      const shouldDeferSnapshotMirror =
        allowDeferredSnapshotMirror &&
        dirtySnapshot !== null &&
        dirtySnapshot.size > 0 &&
        dirtySnapshot.size <= SMALL_DELTA_MAX_DIRTY_GAMES &&
        toWrite.length > PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD;
      if (pendingCatalogNeedsSanitize) {
        // sanitizeGameCatalog already applies user overrides cleanly in a single pass
        toWrite = preserveLocalInstallFieldsAcrossSanitize(toWrite, sanitizeGameCatalog(toWrite));
      } else if (pendingCatalogNeedsOverrides) {
        const userOverrides = loadUserOverrides();
        toWrite = applyUserOverridesToCatalog(toWrite, userOverrides);
      }
      pendingCatalogGames = null;
      if (!shouldDeferSnapshotMirror) {
        pendingSnapshotGames = null;
      }
      pendingCatalogNeedsSanitize = false;
      pendingCatalogNeedsOverrides = false;
      pendingIsFullCatalogSync = false;
      pendingDirtyGameIds.clear();
      pendingRemovedGameIds.clear();
      pendingModalDeferStartedAt = null;
      writeCatalogToLocalStorage(
        toWrite,
        dirtySnapshot,
        removedSnapshot,
        shouldDeferSnapshotMirror ? { deferSnapshotMirror: true } : undefined
      );
    } catch (err) {
      console.error('[IntegrationStorage] Failed to flush pending catalog save:', err);
    }
    return;
  }
  if (
    !allowDeferredSnapshotMirror &&
    pendingSnapshotGames !== null &&
    typeof window !== 'undefined'
  ) {
    const snap = pendingSnapshotGames;
    pendingSnapshotGames = null;
    try {
      persistCatalogSnapshotToIdbAndLocalStorage(snap);
    } catch (err) {
      console.error('[IntegrationStorage] Failed to flush pending catalog snapshot:', err);
    }
  }
}

export function flushPendingCatalogSave(): void {
  flushPendingCatalogSaveInternal({ allowDeferredSnapshotMirror: false });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    flushPendingCatalogSave();
  });
  window.addEventListener('pagehide', () => {
    flushPendingCatalogSave();
  });
  window.addEventListener('antigravity:modal-overlay-changed', (e: Event) => {
    const isOpen = Boolean((e as CustomEvent<{ isOpen?: boolean }>).detail?.isOpen);
    if (isOpen) {
      if (modalCloseFlushTimer) {
        clearTimeout(modalCloseFlushTimer);
        modalCloseFlushTimer = null;
      }
      if (pendingCatalogSaveTimer) {
        clearTimeout(pendingCatalogSaveTimer);
        pendingCatalogSaveTimer = null;
      }
      return;
    }
    if (pendingCatalogGames !== null && !isTestEnv()) {
      pendingModalDeferStartedAt = null;
      if (pendingCatalogSaveTimer) {
        clearTimeout(pendingCatalogSaveTimer);
        pendingCatalogSaveTimer = null;
      }
      if (modalCloseFlushTimer) {
        clearTimeout(modalCloseFlushTimer);
      }
      modalCloseFlushTimer = setTimeout(() => {
        modalCloseFlushTimer = null;
        if (!isTestEnv() && isModalOverlayOpen()) {
          return;
        }
        flushPendingCatalogSaveInternal({ allowDeferredSnapshotMirror: true });
      }, MODAL_CLOSE_FLUSH_DEBOUNCE_MS);
    }
  });
}

function buildDefaultBaseCatalog(
  userOverrides: ReturnType<typeof loadUserOverrides>
): CanonicalGame[] {
  if (
    FULL_USER_STEAM_GAMES.length === 0 &&
    GOG_USER_LIBRARY.length === 0 &&
    EPIC_USER_LIBRARY.length === 0
  ) {
    return [];
  }
  let defaultBase = mergeStorefrontGames(
    mergeStorefrontGames([...FULL_USER_STEAM_GAMES], GOG_USER_LIBRARY, 'gog'),
    EPIC_USER_LIBRARY,
    'epic'
  );
  if (Object.keys(userOverrides).length > 0) {
    defaultBase = applyUserOverridesToCatalog(defaultBase, userOverrides);
  }
  return defaultBase;
}

export function loadCurrentCatalog(): CanonicalGame[] {
  const userOverrides = loadUserOverrides();

  if (typeof window === 'undefined') {
    return buildDefaultBaseCatalog(userOverrides);
  }

  try {
    if (
      (pendingCatalogGames !== null || pendingSnapshotGames !== null || !isTestEnv()) &&
      inMemoryCatalogCache !== null
    ) {
      return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
    }

    const storage = getSafeLocalStorage();
    const raw = storage?.getItem(STORAGE_KEY_MAIN_CATALOG);
    if (raw) {
      const fp = computeCatalogFingerprint(raw);
      if (inMemoryCatalogCache !== null && inMemoryCatalogRawRef === fp) {
        return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
      }

      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.__idbVaultOnly) {
        if (inMemoryCatalogCache !== null) {
          return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
        }
        return buildDefaultBaseCatalog(userOverrides);
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const isQuotaSlimmedSnapshot = parsed.some((g: CanonicalGame) =>
          Boolean(g?.enrichedMetadata?.__quotaSlimmed)
        );
        let compactedAny = parsed.some(
          (g: CanonicalGame) =>
            g?.platforms?.some(
              (p) =>
                p?.installSize !== undefined &&
                sanitizeGameInstallSizeBytes(p.installSize) === undefined
            ) ||
            (g?.platforms?.some((p) => p?.platformId === 'xbox') &&
              typeof g?.title === 'string' &&
              stripStorefrontPlatformDisambiguators(g.title) !== g.title)
        );
        const sanitizedParsed = preserveLocalInstallFieldsAcrossSanitize(
          parsed,
          sanitizeGameCatalog(parsed, { allowNewPurchases: true })
        );
        const cleaned = sanitizedParsed.map((g) => {
          const c = compactGameForStorage(g);
          if (c !== g) compactedAny = true;
          return c;
        });
        const { droppedVaultIds, platformOrVersionHealed } = collectDroppedAndSelfHealedCatalogDelta(
          parsed,
          cleaned
        );
        if (lastPersistedVaultCatalogIds === null) {
          lastPersistedVaultCatalogIds = new Set(
            parsed.map((g: CanonicalGame) => g?.id).filter((id): id is string => Boolean(id))
          );
        }
        if (droppedVaultIds.length > 0) {
          for (const orphanId of droppedVaultIds) {
            lastPersistedVaultCatalogIds.add(orphanId);
          }
        }
        inMemoryCatalogCache = cleaned;
        // Cold-Boot Write Barrier (C8): NEVER write back to localStorage / IDB / SQLite when
        // parsed contains __quotaSlimmed projections — let hydrateCatalogFromIndexedDb() restore full rows.
        if (
          !isQuotaSlimmedSnapshot &&
          (cleaned.length !== parsed.length || compactedAny || platformOrVersionHealed)
        ) {
          writeCatalogToLocalStorage(cleaned);
        } else {
          inMemoryCatalogRawRef = fp;
        }
        return cleaned;
      }
    } else {
      inMemoryCatalogCache = null;
      inMemoryCatalogRawRef = null;
    }

    const defaultBase = buildDefaultBaseCatalog(userOverrides);
    const customRaw = storage?.getItem(STORAGE_KEY_CUSTOM_GAMES);
    if (customRaw) {
      try {
        const customParsed = JSON.parse(customRaw);
        if (Array.isArray(customParsed) && customParsed.length > 0) {
          const customOnly = customParsed.filter(
            (g: CanonicalGame) =>
              g.platforms?.some((p) => p.platformId === 'custom') ||
              !g.platforms?.some((p) => ['steam', 'gog', 'epic', 'xbox'].includes(p.platformId))
          );
          for (const cg of customOnly) {
            if (!defaultBase.some((g: CanonicalGame) => g.id === cg.id)) {
              defaultBase.push(cg);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to parse custom games cache:', err);
      }
    }
    return applyUserOverridesToCatalog(defaultBase, userOverrides);
  } catch (err) {
    console.warn('Failed to load cached universal catalog:', err);
  }
  return buildDefaultBaseCatalog(userOverrides);
}

export function saveCurrentCatalog(games: CanonicalGame[], options?: SaveCatalogOptions): void {
  if (typeof window === 'undefined') return;
  try {
    const incomingDirtyIds = collectDirtyGameIdsFromOptions(options);
    const incomingRemovedIds = collectRemovedGameIdsFromOptions(options);
    const isIncrementalCall = incomingDirtyIds !== null;

    if (!options?.immediate && !isTestEnv()) {
      const hadPendingSave = pendingCatalogGames !== null;
      if (
        lastPersistedVaultCatalogIds === null &&
        Array.isArray(inMemoryCatalogCache) &&
        inMemoryCatalogCache.length > 0
      ) {
        lastPersistedVaultCatalogIds = new Set(
          inMemoryCatalogCache.map((g) => g?.id).filter((id): id is string => Boolean(id))
        );
      }
      inMemoryCatalogCache = games;
      pendingCatalogGames = games;
      pendingCatalogNeedsOverrides = true;
      if (!options?.skipSanitize) {
        pendingCatalogNeedsSanitize = true;
      }

      if (!isIncrementalCall) {
        pendingIsFullCatalogSync = true;
        pendingDirtyGameIds.clear();
        pendingRemovedGameIds.clear();
        pendingModalDeferStartedAt = null;
      } else if (!pendingIsFullCatalogSync) {
        for (const id of incomingDirtyIds) {
          pendingDirtyGameIds.add(id);
          pendingRemovedGameIds.delete(id);
        }
        for (const id of incomingRemovedIds) {
          pendingRemovedGameIds.add(id);
          pendingDirtyGameIds.delete(id);
        }
      }

      if (isModalOverlayOpen()) {
        if (!pendingIsFullCatalogSync && pendingModalDeferStartedAt === null) {
          pendingModalDeferStartedAt = Date.now();
        }
        if (pendingCatalogSaveTimer) {
          clearTimeout(pendingCatalogSaveTimer);
          pendingCatalogSaveTimer = null;
        }
        if (modalCloseFlushTimer) {
          clearTimeout(modalCloseFlushTimer);
          modalCloseFlushTimer = null;
        }
        return;
      }

      const scheduleDeferredFlush = (delayMs: number) => {
        if (pendingCatalogSaveTimer) {
          clearTimeout(pendingCatalogSaveTimer);
          pendingCatalogSaveTimer = null;
        }
        pendingCatalogSaveTimer = setTimeout(() => {
          pendingCatalogSaveTimer = null;
          if (!isTestEnv() && isModalOverlayOpen()) {
            return;
          }
          if (!isTestEnv() && isUserActivelyScrolling()) {
            scheduleDeferredFlush(600);
            return;
          }
          try {
            flushPendingCatalogSaveInternal({ allowDeferredSnapshotMirror: true });
          } catch (e) {
            console.error('[IntegrationStorage] Deferred catalog flush failed:', e);
          }
        }, delayMs);
      };

      const isSmallPendingDirtySlice =
        !pendingIsFullCatalogSync &&
        pendingDirtyGameIds.size > 0 &&
        pendingDirtyGameIds.size <= SMALL_DELTA_MAX_DIRTY_GAMES &&
        games.length > PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD;

      if (!pendingCatalogSaveTimer || (hadPendingSave && pendingIsFullCatalogSync)) {
        const debounceDelayMs = isUserActivelyScrolling()
          ? 600
          : isSmallPendingDirtySlice
          ? SMALL_DELTA_COALESCE_DEBOUNCE_MS
          : 1200;
        scheduleDeferredFlush(debounceDelayMs);
      }
      return;
    }

    if (pendingCatalogSaveTimer) {
      clearTimeout(pendingCatalogSaveTimer);
      pendingCatalogSaveTimer = null;
    }
    if (modalCloseFlushTimer) {
      clearTimeout(modalCloseFlushTimer);
      modalCloseFlushTimer = null;
    }

    let immediateDirtySnapshot: ReadonlySet<string> | null = null;
    let immediateRemovedSnapshot: ReadonlySet<string> | null = null;
    if (isIncrementalCall && !pendingIsFullCatalogSync) {
      const mergedDirty = new Set<string>(pendingDirtyGameIds);
      const mergedRemoved = new Set<string>(pendingRemovedGameIds);
      for (const id of incomingDirtyIds) {
        mergedDirty.add(id);
        mergedRemoved.delete(id);
      }
      for (const id of incomingRemovedIds) {
        mergedRemoved.add(id);
        mergedDirty.delete(id);
      }
      immediateDirtySnapshot = mergedDirty;
      immediateRemovedSnapshot = mergedRemoved.size > 0 ? mergedRemoved : null;
    }

    pendingCatalogGames = null;
    pendingCatalogNeedsSanitize = false;
    pendingCatalogNeedsOverrides = false;
    pendingIsFullCatalogSync = false;
    pendingDirtyGameIds.clear();
    pendingRemovedGameIds.clear();
    pendingModalDeferStartedAt = null;

    const shouldDeferSnapshotMirror =
      !options?.immediate &&
      immediateDirtySnapshot !== null &&
      immediateDirtySnapshot.size > 0 &&
      immediateDirtySnapshot.size <= SMALL_DELTA_MAX_DIRTY_GAMES &&
      games.length > PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD;

    // Avoid redundant override pass when sanitizeGameCatalog runs (it already applies overrides once)
    const cleaned = options?.skipSanitize
      ? applyUserOverridesToCatalog(games, loadUserOverrides())
      : sanitizeGameCatalog(games);
    writeCatalogToLocalStorage(
      cleaned,
      immediateDirtySnapshot,
      immediateRemovedSnapshot,
      shouldDeferSnapshotMirror ? { deferSnapshotMirror: true } : undefined
    );
  } catch (err) {
    console.error('Failed to save universal catalog', err);
  }
}

export const loadSavedCatalog = loadCurrentCatalog;

export function clearIntegrationStorage(): void {
  if (pendingCatalogSaveTimer) {
    clearTimeout(pendingCatalogSaveTimer);
    pendingCatalogSaveTimer = null;
  }
  if (modalCloseFlushTimer) {
    clearTimeout(modalCloseFlushTimer);
    modalCloseFlushTimer = null;
  }
  if (pendingSnapshotMirrorTimer) {
    clearTimeout(pendingSnapshotMirrorTimer);
    pendingSnapshotMirrorTimer = null;
  }
  if (lazySteamAnchorRecoveryTimer) {
    clearTimeout(lazySteamAnchorRecoveryTimer);
    lazySteamAnchorRecoveryTimer = null;
  }
  lazySteamAnchorRecoveryToken++;
  pendingSnapshotGames = null;
  pendingCatalogGames = null;
  pendingCatalogNeedsSanitize = false;
  pendingCatalogNeedsOverrides = false;
  pendingIsFullCatalogSync = false;
  pendingDirtyGameIds.clear();
  pendingRemovedGameIds.clear();
  pendingModalDeferStartedAt = null;
  inMemoryCatalogCache = null;
  inMemoryCatalogRawRef = null;
  lastPersistedVaultCatalogIds = null;
  clearSessionApiKeys();
  void vaultDelete(IDB_KEY_MAIN_CATALOG);
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY_INTEGRATIONS);
    storage.removeItem(STORAGE_KEY_CUSTOM_GAMES);
    storage.removeItem(STORAGE_KEY_MAIN_CATALOG);
    storage.removeItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    storage.removeItem(STORAGE_KEY_XBOX_PROFILE);
  } catch {
    // Ignore storage removal errors
  }
}
