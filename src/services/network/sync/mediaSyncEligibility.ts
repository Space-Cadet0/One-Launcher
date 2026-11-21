import type { CanonicalGame } from '../../../contracts/game';
import type { MediaSyncOutcome } from '../../../contracts/steam';
import { steamMatcher } from '../../steam/steamMatcher';
import { requestScheduler } from '../requestScheduler';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
} from '../../storage/userOverrideStorage';
import {
  MEDIA_ATTEMPT_KEY_PREFIX,
  getMediaSyncOutcomeTtlMs,
  hasFreshMediaSyncAttempt,
  loadStagedCache,
} from '../../storage/stagedCacheService';
import {
  isGogCroppedHorizontalCover,
  isUnsuitableCoverUrl,
} from '../../igdb/igdbCoverService';
import { getNativeOsPlatforms } from '../../platform/nativeOsService';
import {
  hasGenuineStoreSynopsis,
  isLikelyNonStoreOrTestBranchTitle,
} from '../../../components/Library/MatchManager/matchManagerDiagnostics';
import type { FavoritableGame } from './hydrationAssetExtractor';

export interface StoreMediaSyncEvalOptions {
  isManualSync?: boolean;
  isPostHydration?: boolean;
}

export type MediaRepairPriorityTier = 0 | 1 | 2 | 3;

export const MAX_PASSIVE_REPAIR_PER_BOOT = 45;

export interface StoreMediaSyncOptions {
  forceRefresh?: boolean;
  incremental?: boolean;
  isBackgroundWarmup?: boolean;
  isManualSync?: boolean;
  isPostHydration?: boolean;
  maxRepairTier?: MediaRepairPriorityTier;
  maxBatchSize?: number;
  onGameAttempted?: (gameId: string) => void;
}

export const MEDIA_SYNC_DOMAINS = [
  'store.steampowered.com',
  'api.steampowered.com',
  'catalog.gog.com',
  'api.gog.com',
  'launcher.store.epicgames.com',
  'store-content.ak.epicgames.com',
  'api.igdb.com',
] as const;

export function hasActiveMediaSyncCooldown(): boolean {
  return requestScheduler.getMaxCooldownRemaining(MEDIA_SYNC_DOMAINS) > 0;
}

export function resolveSyncHostPlatform(): 'darwin' | 'win32' | 'linux' {
  if (typeof window !== 'undefined') {
    const plat = window.electronAPI?.platform;
    if (plat === 'win32' || plat === 'linux' || plat === 'darwin') {
      return plat;
    }
    const navPlat = String(window.navigator?.platform || '').toLowerCase();
    if (navPlat.includes('win')) return 'win32';
    if (navPlat.includes('linux')) return 'linux';
  }
  return 'darwin';
}

export function isOwnedNativeMacGame(g: CanonicalGame): boolean {
  try {
    return getNativeOsPlatforms(g).includes('mac');
  } catch {
    return false;
  }
}

export function hasFreshNegativeMediaSyncAttempt(
  gameId: string,
  meta?: CanonicalGame['enrichedMetadata'] | null,
  minAttemptedAt?: number
): boolean {
  const minTs = typeof minAttemptedAt === 'number' && minAttemptedAt > 0 ? minAttemptedAt : 0;
  if (gameId) {
    const staged = loadStagedCache<{ attemptedAt?: number; outcome?: MediaSyncOutcome }>(
      `${MEDIA_ATTEMPT_KEY_PREFIX}${gameId}`
    );
    if (staged.valid) {
      const attemptedAt = staged.data?.attemptedAt ?? staged.entry?.cachedAt ?? 0;
      const outcome = staged.data?.outcome;
      if (
        attemptedAt >= minTs &&
        (outcome === 'unavailable_404' || outcome === 'transient_error')
      ) {
        return true;
      }
    }
  }
  if (
    meta &&
    typeof meta.lastMediaSyncAttemptAt === 'number' &&
    meta.lastMediaSyncAttemptAt >= minTs &&
    (meta.mediaSyncOutcome === 'unavailable_404' || meta.mediaSyncOutcome === 'transient_error')
  ) {
    // Unified single source of truth TTL (14d for 404, 2h for transient_error) from stagedCacheService
    const ttlMs = getMediaSyncOutcomeTtlMs(meta.mediaSyncOutcome);
    if (Date.now() - meta.lastMediaSyncAttemptAt < ttlMs) {
      return true;
    }
  }
  return false;
}

export function computeMediaRepairPriority(
  g: CanonicalGame,
  explicitOverride?: ReturnType<typeof getUserOverrideForGame>,
  hostPlatform?: 'darwin' | 'win32' | 'linux'
): MediaRepairPriorityTier {
  const ov = explicitOverride !== undefined ? explicitOverride : getUserOverrideForGame(g);
  const meta = g.enrichedMetadata;
  const activeHost = hostPlatform ?? resolveSyncHostPlatform();

  // Tier 0: Missing genuine store synopsis OR missing/unsuitable cover artwork
  const hasGenuineSynopsis = hasGenuineStoreSynopsis(g, ov, undefined, null);
  const missingSynopsis = !hasGenuineSynopsis && !isLikelyNonStoreOrTestBranchTitle(g.title);
  const missingOrUnsuitableCover =
    !ov?.capsuleImage &&
    (!g.capsuleImage ||
      isUnsuitableCoverUrl(g.capsuleImage) ||
      isGogCroppedHorizontalCover(g.capsuleImage, g.headerImage));
  if (missingSynopsis || missingOrUnsuitableCover) {
    return 0;
  }

  const hasFetchedAt = typeof meta?.fetchedAt === 'number' && meta.fetchedAt > 0;
  const hasSysReq = Boolean(
    meta?.systemRequirements?.minimum?.trim() || meta?.systemRequirements?.recommended?.trim()
  );
  const hasMacReq = Boolean(
    meta?.macRequirements?.minimum?.trim() || meta?.macRequirements?.recommended?.trim()
  );
  const favGame = g as FavoritableGame;
  const isInstalledOrFavorited = Boolean(
    g.platforms?.some((p) => p?.installed) ||
      favGame.isFavorite ||
      favGame.favorited ||
      favGame.isFavorited
  );

  // Tier 1: Active-host native OS spec gap OR installed/favorited slimmed row
  const hasActiveHostSpecGap =
    activeHost === 'darwin'
      ? isOwnedNativeMacGame(g) && !hasMacReq && !hasFetchedAt
      : activeHost === 'win32'
        ? !hasSysReq && !hasFetchedAt
        : false;
  if (hasActiveHostSpecGap || (meta?.__quotaSlimmed === true && isInstalledOrFavorited)) {
    return 1;
  }

  // Tier 2: Remaining persisted slimmed rows or un-upgraded / screenshot-less records
  if (
    meta?.__quotaSlimmed === true ||
    !meta ||
    meta.metadataQuality === 'skeleton_fallback' ||
    meta.metadataQuality === 'storefront_native' ||
    meta.metadataQuality === 'local_federated' ||
    (meta.screenshots?.length || 0) === 0
  ) {
    return 2;
  }

  // Tier 3: Non-slimmed Frankenstein backfill (valid synopsis, cover, screenshots, and active-host specs)
  return 3;
}

export function evaluateGameNeedsStoreMediaSync(
  g: CanonicalGame,
  forceRefresh: boolean,
  options: StoreMediaSyncEvalOptions = {}
): { eligible: boolean; alreadyEnriched: boolean } {
  const ov = getUserOverrideForGame(g);
  const route = inferMetadataRouteFromOverride(ov);
  const effectiveSteamId = steamMatcher.getEffectiveSteamAppId(g);
  const gameExtended = g as CanonicalGame & {
    platform?: string;
    xboxProductId?: string;
  };
  const hasXboxPlat =
    gameExtended.platform === 'xbox' ||
    Boolean(gameExtended.xboxProductId) ||
    Boolean(
      g.platforms?.some((p) =>
        typeof p === 'string'
          ? p === 'xbox'
          : p?.platformId === 'xbox' || Boolean(p?.xboxProductId)
      )
    );

  let hasMediaRoute = false;
  if (effectiveSteamId) {
    hasMediaRoute = true;
  } else if (
    hasXboxPlat ||
    g.platforms?.some((p) =>
      typeof p === 'string'
        ? p === 'gog' || p === 'epic'
        : p?.platformId === 'gog' || p?.platformId === 'epic'
    )
  ) {
    hasMediaRoute = true;
  } else {
    hasMediaRoute = Boolean(
      route &&
        route.mode === 'routed' &&
        (route.source === 'steam' ||
          route.source === 'gog' ||
          route.source === 'epic' ||
          route.source === 'igdb' ||
          (route.source === 'custom' && String(route.matchedId || '').startsWith('xbox-')))
    );
  }

  if (!hasMediaRoute) {
    return { eligible: false, alreadyEnriched: false };
  }

  if (forceRefresh) {
    return { eligible: true, alreadyEnriched: false };
  }

  const isManualSync = Boolean(options.isManualSync);
  const isPostHydration = Boolean(options.isPostHydration);
  const meta = g.enrichedMetadata;
  const ovUpdatedAtMs = ov?.updatedAt ? Date.parse(ov.updatedAt) || 0 : 0;

  // Backward-compatible fast-path for fresh transient localStorage slim projections
  // (where slimGameForLocalStorageQuota deleted top-level `shortDescription` leaving `undefined`)
  // when neither `isManualSync` nor `isPostHydration` is asserted.
  const isFreshLocalStorageSlimProjection = Boolean(
    meta?.__quotaSlimmed === true &&
      !isManualSync &&
      !isPostHydration &&
      g.shortDescription === undefined &&
      (meta.hasScreenshotsCount || 0) > 0
  );
  const isPersistedSlim = Boolean(
    meta?.__quotaSlimmed === true && !isFreshLocalStorageSlimProjection
  );

  const hasGenuineSynopsis = hasGenuineStoreSynopsis(g, ov, undefined, null);
  const needsSynopsisRepair = Boolean(
    !isFreshLocalStorageSlimProjection &&
      !hasGenuineSynopsis &&
      !isLikelyNonStoreOrTestBranchTitle(g.title)
  );

  const hasSysReq = Boolean(
    meta?.systemRequirements?.minimum?.trim() || meta?.systemRequirements?.recommended?.trim()
  );
  const hasMacReq = Boolean(
    meta?.macRequirements?.minimum?.trim() || meta?.macRequirements?.recommended?.trim()
  );
  const hasFetchedAt = typeof meta?.fetchedAt === 'number' && meta.fetchedAt > 0;

  const needsSysReqRepair = Boolean(
    (isManualSync || isPostHydration) &&
      meta &&
      !meta.__quotaSlimmed &&
      meta.metadataQuality === 'authoritative' &&
      Boolean(effectiveSteamId && effectiveSteamId > 0) &&
      !hasSysReq &&
      !hasFetchedAt
  );
  const needsMacReqRepair = Boolean(
    (isManualSync || isPostHydration) &&
      meta &&
      !meta.__quotaSlimmed &&
      meta.metadataQuality !== 'skeleton_fallback' &&
      isOwnedNativeMacGame(g) &&
      !hasMacReq &&
      !hasFetchedAt
  );

  const hasMetadataCorruptionOrGap =
    isPersistedSlim || needsSynopsisRepair || needsSysReqRepair || needsMacReqRepair;

  if (hasFreshMediaSyncAttempt(g.id, meta, ovUpdatedAtMs)) {
    const canBypassFreshAttempt =
      hasMetadataCorruptionOrGap &&
      (isManualSync ||
        (!hasFreshNegativeMediaSyncAttempt(g.id, meta, ovUpdatedAtMs) &&
          (isPersistedSlim || !hasFetchedAt)));
    if (!canBypassFreshAttempt) {
      return {
        eligible: false,
        alreadyEnriched: Boolean(
          meta && meta.metadataQuality !== 'skeleton_fallback' && !isPersistedSlim
        ),
      };
    }
  }

  const hasScreenshots =
    (meta?.screenshots?.length || 0) > 0 || isFreshLocalStorageSlimProjection;
  const metaAlreadyFromSteam = Boolean(
    meta &&
      !meta.__quotaSlimmed &&
      Number(meta.appId) > 0 &&
      meta.enrichedSource !== 'xbox' &&
      meta.metadataQuality !== 'skeleton_fallback'
  );
  const canStillMatchSteam =
    !g.isExplicitNonSteam &&
    g.steamAppId !== null &&
    ov?.steamAppId !== null &&
    !metaAlreadyFromSteam &&
    (Boolean(effectiveSteamId) || !steamMatcher.hasAttemptedMatch(g.title));
  const isStorefrontNativeMeta = Boolean(
    meta &&
      !meta.__quotaSlimmed &&
      (meta.metadataQuality === 'storefront_native' ||
        meta.metadataQuality === 'local_federated' ||
        meta.enrichedSource === 'xbox' ||
        (!g.steamAppId &&
          meta.metadataQuality !== 'scraped' &&
          hasXboxPlat &&
          (!meta.appId || Number(meta.appId) <= 0)))
  );
  const needsRichSteamUpgrade = isStorefrontNativeMeta && canStillMatchSteam;
  const needsAuthoritativeArtworkBackfill = Boolean(
    meta &&
      !meta.__quotaSlimmed &&
      meta.metadataQuality === 'authoritative' &&
      !ov?.capsuleImage &&
      (!g.capsuleImage ||
        isUnsuitableCoverUrl(g.capsuleImage) ||
        isGogCroppedHorizontalCover(g.capsuleImage, g.headerImage))
  );

  if (
    meta &&
    meta.metadataQuality !== 'skeleton_fallback' &&
    hasScreenshots &&
    !hasMetadataCorruptionOrGap &&
    !needsRichSteamUpgrade &&
    !needsAuthoritativeArtworkBackfill
  ) {
    return { eligible: false, alreadyEnriched: true };
  }

  if (
    meta &&
    meta.metadataQuality !== 'skeleton_fallback' &&
    !hasScreenshots &&
    !hasMetadataCorruptionOrGap &&
    !needsRichSteamUpgrade &&
    !needsAuthoritativeArtworkBackfill &&
    typeof meta.enrichedAt === 'number' &&
    Date.now() - meta.enrichedAt < 30 * 24 * 60 * 60 * 1000
  ) {
    return { eligible: false, alreadyEnriched: true };
  }

  return { eligible: true, alreadyEnriched: false };
}
