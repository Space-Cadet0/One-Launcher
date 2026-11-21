import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import type { SteamEnrichedMetadata } from '../../contracts/steam';
import { scanLocalSteamAchievements } from '../../services/system/localSystemScanner';
import { cacheUserSteamAchievements } from '../../services/storage/knownGameAchievements';
import { saveCurrentCatalog } from '../../services/integrations/integrationStorage';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { steamApi } from '../../services/steam/steamApi';
import { RequestPriority } from '../../services/network/requestScheduler';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
} from '../../services/storage/metadataReconciliation';
import { pickBestEnrichedMetadata } from '../../services/storage/librarySync';
import { reconcileAchievementSummaries } from '../../services/storage/achievementReconciliation';
import { getUserOverrideForGame } from '../../services/storage/userOverrideStorage';
import {
  clearFailedCoverUrls,
  clearFailedSidebarIconUrls,
} from '../../services/media/failedMediaUrlRegistry';
import type { SyncNoticeTone } from '../useSyncNotice';

export interface RunSingleGameSyncParams {
  target: CanonicalGame;
  gamesRef: MutableRefObject<CanonicalGame[]>;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  onCatalogPersisted?: (catalog: CanonicalGame[]) => void;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
  isMountedRef: MutableRefObject<boolean>;
}

function applyNonSteamEnrichmentToCatalog(
  catalog: CanonicalGame[],
  target: CanonicalGame,
  gogId: string | undefined,
  refreshed: SteamEnrichedMetadata | null,
  validRefreshedCapsule: string | undefined,
  isGenericPlaceholderSynopsis: (synopsis: string | undefined, title?: string) => boolean
): CanonicalGame[] {
  return catalog.map((g) => {
    if (g.id !== target.id) return g;
    const userOv = getUserOverrideForGame(g);
    const hasCustomSynopsis = Boolean(
      userOv?.shortDescription || userOv?.metadataRoute?.customSynopsisEdited
    );
    const hasCustomDetailed = Boolean(
      userOv?.detailedDescription || userOv?.metadataRoute?.customSynopsisEdited
    );

    const safeRefreshed =
      refreshed &&
      refreshed.metadataQuality === 'skeleton_fallback' &&
      g.enrichedMetadata &&
      g.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
        ? undefined
        : refreshed || undefined;

    // Route through pickBestEnrichedMetadata so C8 __quotaSlimmed immunity & macOS/Linux specs are preserved
    const mergedEnriched = pickBestEnrichedMetadata(g.enrichedMetadata, safeRefreshed);
    const cleanDevelopers = (safeRefreshed?.developers ?? mergedEnriched?.developers)?.filter(
      (d) => d && d !== 'Unknown Developer'
    );
    const nextHeader =
      reconcileHeaderImage(g.headerImage, safeRefreshed?.headerImage, {
        gameId: g.id,
        title: g.title,
        gogId,
        userOverrideHeader: userOv?.headerImage,
      }) || g.headerImage;
    const nextCapsule = reconcileCapsuleImage(g.capsuleImage, validRefreshedCapsule, {
      gameId: g.id,
      title: g.title,
      gogId,
      userOverrideCapsule: userOv?.capsuleImage,
      headerUrl: nextHeader,
    });

    const refreshedShort =
      safeRefreshed?.shortDescription &&
      !isGenericPlaceholderSynopsis(safeRefreshed.shortDescription, target.title)
        ? safeRefreshed.shortDescription
        : undefined;
    const refreshedDetailed = safeRefreshed?.detailedDescription || safeRefreshed?.aboutTheGame;

    return {
      ...g,
      title: userOv?.title || g.title,
      enrichedMetadata: mergedEnriched,
      headerImage: nextHeader,
      capsuleImage: nextCapsule,
      shortDescription: hasCustomSynopsis
        ? userOv?.shortDescription || g.shortDescription
        : refreshedShort || g.shortDescription,
      detailedDescription: hasCustomDetailed
        ? userOv?.detailedDescription || g.detailedDescription
        : refreshedDetailed || g.detailedDescription,
      developers: userOv?.developers?.length
        ? userOv.developers
        : cleanDevelopers?.length
          ? cleanDevelopers
          : g.developers,
      publishers: userOv?.publishers?.length
        ? userOv.publishers
        : safeRefreshed?.publishers?.length
          ? safeRefreshed.publishers
          : g.publishers,
      releaseDate: userOv?.releaseDate
        ? userOv.releaseDate
        : safeRefreshed?.releaseDate && safeRefreshed.releaseDate !== 'TBA'
          ? safeRefreshed.releaseDate
          : g.releaseDate,
      genres: userOv?.genres?.length
        ? userOv.genres
        : safeRefreshed?.genres?.length
          ? safeRefreshed.genres
          : g.genres,
      tags: userOv?.tags?.length
        ? userOv.tags
        : safeRefreshed?.tags?.length
          ? safeRefreshed.tags
          : g.tags,
      reviewSummary: safeRefreshed?.reviewSummary || g.reviewSummary,
    };
  });
}

function applySteamEnrichmentToCatalog(
  catalog: CanonicalGame[],
  target: CanonicalGame,
  targetAppId: number,
  gogId: string | undefined,
  refreshed: SteamEnrichedMetadata | null,
  browseAssets: { headerImage?: string; capsuleImage?: string; iconUrl?: string } | null,
  resolvedVerticalCover: string | undefined,
  preEvictGogCover: string | undefined,
  preEvictIgdbCover: string | undefined,
  liveAchs: StoreAchievementSummary | null
): CanonicalGame[] {
  return catalog.map((g) => {
    if (g.id !== target.id) return g;
    const userOv = getUserOverrideForGame(g);
    const hasCustomSynopsis = Boolean(
      userOv?.shortDescription || userOv?.metadataRoute?.customSynopsisEdited
    );
    const hasCustomDetailed = Boolean(
      userOv?.detailedDescription || userOv?.metadataRoute?.customSynopsisEdited
    );

    const updatedPlatforms = g.platforms.map((p) => {
      if (p.platformId === 'steam' && liveAchs) {
        return {
          ...p,
          achievements: reconcileAchievementSummaries(p.achievements, liveAchs, {
            title: g.title,
            appId: targetAppId,
            store: 'steam',
          }),
        };
      }
      return p;
    });

    const safeRefreshed =
      refreshed &&
      refreshed.metadataQuality === 'skeleton_fallback' &&
      g.enrichedMetadata &&
      g.enrichedMetadata.metadataQuality !== 'skeleton_fallback'
        ? undefined
        : refreshed || undefined;

    // Route through pickBestEnrichedMetadata so C8 __quotaSlimmed immunity & macOS/Linux specs are preserved
    const mergedEnriched = pickBestEnrichedMetadata(g.enrichedMetadata, safeRefreshed);
    const nextHeader =
      reconcileHeaderImage(
        g.headerImage,
        safeRefreshed?.headerImage || browseAssets?.headerImage,
        {
          gameId: g.id,
          title: g.title,
          steamAppId: targetAppId,
          gogId,
          userOverrideHeader: userOv?.headerImage,
        }
      ) || g.headerImage;
    const nextCapsule = reconcileCapsuleImage(
      g.capsuleImage,
      resolvedVerticalCover || preEvictGogCover || preEvictIgdbCover,
      {
        gameId: g.id,
        title: g.title,
        steamAppId: targetAppId,
        gogId,
        userOverrideCapsule: userOv?.capsuleImage,
        headerUrl: nextHeader,
      }
    );

    const refreshedDetailed = safeRefreshed?.detailedDescription || safeRefreshed?.aboutTheGame;

    return {
      ...g,
      title: userOv?.title || g.title,
      steamAppId: targetAppId,
      platforms: updatedPlatforms,
      enrichedMetadata: mergedEnriched,
      headerImage: nextHeader,
      capsuleImage: nextCapsule,
      iconUrl: userOv?.iconUrl || browseAssets?.iconUrl || g.iconUrl,
      shortDescription: hasCustomSynopsis
        ? userOv?.shortDescription || g.shortDescription
        : safeRefreshed?.shortDescription || g.shortDescription,
      detailedDescription: hasCustomDetailed
        ? userOv?.detailedDescription || g.detailedDescription
        : refreshedDetailed || g.detailedDescription,
      developers: userOv?.developers?.length
        ? userOv.developers
        : safeRefreshed?.developers?.length
          ? safeRefreshed.developers
          : g.developers,
      publishers: userOv?.publishers?.length
        ? userOv.publishers
        : safeRefreshed?.publishers?.length
          ? safeRefreshed.publishers
          : g.publishers,
      genres: userOv?.genres?.length
        ? userOv.genres
        : safeRefreshed?.genres?.length
          ? safeRefreshed.genres
          : g.genres,
      tags: userOv?.tags?.length
        ? userOv.tags
        : safeRefreshed?.tags?.length
          ? safeRefreshed.tags
          : g.tags,
      reviewSummary: safeRefreshed?.reviewSummary || g.reviewSummary,
    };
  });
}

export async function runSingleGameSync({
  target,
  gamesRef,
  setGames,
  setGameRefreshKey,
  onCatalogPersisted,
  showSyncNotice,
  isMountedRef,
}: RunSingleGameSyncParams): Promise<void> {
  const targetAppId = steamMatcher.getEffectiveSteamAppId(target);
  const gogId = target.platforms?.find((p) => p.platformId === 'gog')?.platformGameId;

  const [
    { syncJobManager },
    { igdbCoverService, isUnsuitableCoverUrl },
    { fallbackMetadataProvider, isGenericPlaceholderSynopsis },
    { steamAchievementsService },
  ] = await Promise.all([
    import('../../services/network/syncJobManager'),
    import('../../services/igdb/igdbCoverService'),
    import('../../services/steam/fallbackMetadataProvider'),
    import('../../services/steam/steamAchievementsService'),
  ]);

  const preEvictGogCover =
    igdbCoverService.getGogVerticalCoverInstant(gogId, target.title) || undefined;
  const preEvictIgdbCover =
    igdbCoverService.getIgdbCoverInstant(target.title, targetAppId, target.id) || undefined;

  if (onlineLifecycleManager.isOnline()) {
    igdbCoverService.evictCacheForGame(target.title, gogId, targetAppId);
    if (targetAppId) {
      steamApi.evictCache(targetAppId);
    }
    clearFailedCoverUrls(target.id);
    clearFailedSidebarIconUrls();
  }

  await syncJobManager.runPriorityAction('Syncing Game Media', target.title, async () => {
    if (!targetAppId) {
      const [refreshed, gogBoxArt, igdbCover] = await Promise.all([
        fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(target).catch(() => null),
        gogId
          ? igdbCoverService
              .fetchGogVerticalCover(gogId, target.title, RequestPriority.P0_INTERACTIVE)
              .catch(() => null)
          : Promise.resolve(null),
        igdbCoverService
          .fetchIgdbCover(target.title, target.releaseDate, RequestPriority.P0_INTERACTIVE)
          .catch(() => null),
      ]);

      const validRefreshedCapsule =
        gogBoxArt ||
        (refreshed?.capsuleImage && !isUnsuitableCoverUrl(refreshed.capsuleImage)
          ? refreshed.capsuleImage
          : undefined) ||
        igdbCover ||
        preEvictGogCover ||
        preEvictIgdbCover;

      if (refreshed || validRefreshedCapsule) {
        const baseAtCommit = gamesRef.current;
        const nextCatalog = applyNonSteamEnrichmentToCatalog(
          baseAtCommit,
          target,
          gogId,
          refreshed,
          validRefreshedCapsule,
          isGenericPlaceholderSynopsis
        );
        gamesRef.current = nextCatalog;
        if (isMountedRef.current) {
          setGames((prev) => {
            const next =
              prev === baseAtCommit
                ? nextCatalog
                : applyNonSteamEnrichmentToCatalog(
                    prev,
                    target,
                    gogId,
                    refreshed,
                    validRefreshedCapsule,
                    isGenericPlaceholderSynopsis
                  );
            gamesRef.current = next;
            return next;
          });
        }
        saveCurrentCatalog(gamesRef.current, {
          dirtyGameIds: [target.id],
          skipSanitize: true,
        });
        onCatalogPersisted?.(gamesRef.current);
        if (isMountedRef.current) {
          setGameRefreshKey((prev) => prev + 1);
          showSyncNotice(`Successfully synced ${target.title} metadata!`, 5000);
        }
      } else if (isMountedRef.current) {
        showSyncNotice(`No new metadata updates found for ${target.title}.`, 5000);
      }
      return;
    }

    try {
      const steamAchs = await scanLocalSteamAchievements();
      if (steamAchs && Object.keys(steamAchs).length > 0) {
        cacheUserSteamAchievements(steamAchs);
      }
    } catch {}

    const [refreshed, browseAssets, liveAchs] = await Promise.all([
      steamApi.fetchGameMetadata(targetAppId, RequestPriority.P0_INTERACTIVE),
      steamApi.fetchStoreBrowseAssets(targetAppId),
      steamAchievementsService.fetchPlayerGameAchievements(
        targetAppId,
        undefined,
        undefined,
        RequestPriority.P0_INTERACTIVE
      ),
    ]);

    let resolvedVerticalCover =
      (refreshed?.capsuleImage && !isUnsuitableCoverUrl(refreshed.capsuleImage)
        ? refreshed.capsuleImage
        : undefined) ||
      (browseAssets?.capsuleImage && !isUnsuitableCoverUrl(browseAssets.capsuleImage)
        ? browseAssets.capsuleImage
        : undefined);

    if (!resolvedVerticalCover && gogId) {
      const instantGogCover =
        igdbCoverService.getGogVerticalCoverInstant(gogId, target.title) || undefined;
      if (instantGogCover && !isUnsuitableCoverUrl(instantGogCover)) {
        resolvedVerticalCover = instantGogCover;
      } else {
        const fetchedGogCover =
          (await igdbCoverService
            .fetchGogVerticalCover(gogId, target.title, RequestPriority.P0_INTERACTIVE)
            .catch(() => null)) || undefined;
        if (fetchedGogCover && !isUnsuitableCoverUrl(fetchedGogCover)) {
          resolvedVerticalCover = fetchedGogCover;
        } else if (preEvictGogCover && !isUnsuitableCoverUrl(preEvictGogCover)) {
          resolvedVerticalCover = preEvictGogCover;
        }
      }
    }

    if (!resolvedVerticalCover) {
      resolvedVerticalCover =
        (await igdbCoverService
          .fetchIgdbCover(
            target.title,
            refreshed?.releaseDate || target.releaseDate,
            RequestPriority.P0_INTERACTIVE
          )
          .catch(() => null)) ||
        preEvictGogCover ||
        preEvictIgdbCover ||
        undefined;
    }

    if (refreshed || browseAssets || resolvedVerticalCover || liveAchs) {
      const baseAtCommit = gamesRef.current;
      const nextCatalog = applySteamEnrichmentToCatalog(
        baseAtCommit,
        target,
        targetAppId,
        gogId,
        refreshed,
        browseAssets,
        resolvedVerticalCover,
        preEvictGogCover,
        preEvictIgdbCover,
        liveAchs
      );
      gamesRef.current = nextCatalog;
      if (isMountedRef.current) {
        setGames((prev) => {
          const next =
            prev === baseAtCommit
              ? nextCatalog
              : applySteamEnrichmentToCatalog(
                  prev,
                  target,
                  targetAppId,
                  gogId,
                  refreshed,
                  browseAssets,
                  resolvedVerticalCover,
                  preEvictGogCover,
                  preEvictIgdbCover,
                  liveAchs
                );
          gamesRef.current = next;
          return next;
        });
      }
      saveCurrentCatalog(gamesRef.current, {
        dirtyGameIds: [target.id],
        skipSanitize: true,
      });
      onCatalogPersisted?.(gamesRef.current);
      if (isMountedRef.current) {
        setGameRefreshKey((prev) => prev + 1);
        showSyncNotice(`Successfully synced ${target.title} from Steam!`, 5000);
      }
    } else if (isMountedRef.current) {
      showSyncNotice(`No new updates found on Steam for ${target.title}.`, 5000);
    }
  });
}
