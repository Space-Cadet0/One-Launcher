import { useEffect, useState, useRef } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { SteamEnrichedMetadata } from '../../../contracts/steam';
import { UserGameOverride, MetadataSourceRoute } from '../../../contracts/override';
import { steamApi, SteamStoreBrowseAssets } from '../../../services/steam/steamApi';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import { RequestPriority } from '../../../services/network/requestScheduler';
import { fallbackMetadataProvider } from '../../../services/steam/fallbackMetadataProvider';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';
import {
  getHowLongToBeat,
  seedHltbFromVaultIfMissing,
  type HltbData,
} from '../../../services/hltb/howLongToBeat';
import { getReviewSourceAuthorityRank } from '../../../services/critic/criticUtils';
import { resolveGameReviewScore } from '../../../services/critic/reviewScoreResolver';
import { steamAchievementsService } from '../../../services/steam/steamAchievementsService';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  inferReviewRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../../../services/storage/userOverrideStorage';
import type { VaultCriticAdoptionController } from './useGameDetailCritic';
import { hasMeaningfulRequirementSpec } from '../SystemRequirements';
import {
  buildEnrichedTopLevelFields,
  buildVaultCriticSignature,
  hasRealSteamReviewSummary,
  hasRichMetadata,
  isAuthoritativeSteamMetadata,
  isMicrosoftStoreAssetUrl,
  isSkeletonMetadata,
  mergePreservingXboxHints,
  parseVaultHltb,
} from './steamDetailUtils';

export interface UseGameDetailMetadataParams {
  game: CanonicalGame;
  userOverride?: UserGameOverride | null;
  metadataRoute?: MetadataSourceRoute;
  activeStoreSupportsMacRef: React.MutableRefObject<boolean>;
  onGameUpdated?: (updated: CanonicalGame) => void;
  vaultCritic: VaultCriticAdoptionController;
}

export function useGameDetailMetadata({
  game,
  userOverride,
  metadataRoute,
  activeStoreSupportsMacRef,
  onGameUpdated,
  vaultCritic,
}: UseGameDetailMetadataParams) {
  const { lastPersistedVaultCriticSigRef } = vaultCritic;
  const vaultCriticRef = useRef(vaultCritic);
  vaultCriticRef.current = vaultCritic;

  const [currentGame, setCurrentGame] = useState<CanonicalGame>(game);
  const [metadata, setMetadata] = useState<SteamEnrichedMetadata | null>(
    game.enrichedMetadata || null
  );
  const [vaultHltb, setVaultHltb] = useState<HltbData | null>(null);
  const [currentSteamAppId, setCurrentSteamAppId] = useState<number | undefined>(game.steamAppId);
  const [isLoading, setIsLoading] = useState(!game.enrichedMetadata);
  const [isOnline, setIsOnline] = useState<boolean>(() => onlineLifecycleManager.isOnline());
  const [onlineGeneration, setOnlineGeneration] = useState<number>(() =>
    onlineLifecycleManager.getOnlineGeneration()
  );
  const [reloadTrigger, setReloadTrigger] = useState<number>(0);

  const activeGameIdRef = useRef<string>(game.id);
  const latestGameRef = useRef<CanonicalGame>(game);
  latestGameRef.current = game;
  const activeOverrideStampRef = useRef<string | undefined>(userOverride?.updatedAt);
  const lastPersistedVaultMetaSigRef = useRef<string>('');
  const latestRichMetadataRef = useRef<SteamEnrichedMetadata | null>(
    hasRichMetadata(game.enrichedMetadata) ? game.enrichedMetadata! : null
  );

  useEffect(() => {
    setIsOnline(onlineLifecycleManager.isOnline());
    setOnlineGeneration(onlineLifecycleManager.getOnlineGeneration());

    const offConn = onlineLifecycleManager.onConnectivityChange((online, generation) => {
      setIsOnline(online);
      setOnlineGeneration(generation);
      if (online && !isAuthoritativeSteamMetadata(latestRichMetadataRef.current, game.steamAppId)) {
        setReloadTrigger((t) => t + 1);
      }
    });

    const offHydrated = onlineLifecycleManager.onGameHydrated((payload) => {
      if (payload.gameId !== game.id) return;
      if (payload.detail?.hltb) {
        const hydratedVaultHltb = parseVaultHltb(payload.detail.hltb);
        if (hydratedVaultHltb) {
          seedHltbFromVaultIfMissing(game.title, game.steamAppId, hydratedVaultHltb);
          setVaultHltb(hydratedVaultHltb);
        }
      }
      if (payload.detail?.criticScore) {
        const adoptedHydratedCritic = vaultCriticRef.current.adoptVaultCriticScore(
          payload.detail.criticScore,
          latestGameRef.current,
          payload.detail?.enrichedMetadata ??
            latestRichMetadataRef.current ??
            latestGameRef.current.enrichedMetadata
        );
        if (adoptedHydratedCritic) {
          vaultCriticRef.current.applyAdoptedVaultCritic(game.id, adoptedHydratedCritic);
        }
      }
      const hydratedMeta = payload.detail?.enrichedMetadata;
      if (hydratedMeta && hasRichMetadata(hydratedMeta)) {
        if (
          isAuthoritativeSteamMetadata(latestRichMetadataRef.current) &&
          !isAuthoritativeSteamMetadata(hydratedMeta)
        ) {
          return;
        }
        const mergedHydrated =
          mergePreservingXboxHints(
            hydratedMeta,
            latestRichMetadataRef.current || game.enrichedMetadata
          ) || hydratedMeta;
        latestRichMetadataRef.current = mergedHydrated;
        setMetadata(mergedHydrated);
        setIsLoading(false);
      } else {
        setReloadTrigger((t) => t + 1);
      }
    });

    return () => {
      offConn();
      offHydrated();
    };
  }, [game.id]);

  useEffect(() => {
    setCurrentGame(game);
    if (game.enrichedMetadata) {
      if (hasRichMetadata(game.enrichedMetadata)) {
        if (
          isAuthoritativeSteamMetadata(latestRichMetadataRef.current) &&
          !isAuthoritativeSteamMetadata(game.enrichedMetadata)
        ) {
          const preserved =
            mergePreservingXboxHints(latestRichMetadataRef.current, game.enrichedMetadata) ||
            latestRichMetadataRef.current!;
          latestRichMetadataRef.current = preserved;
          setMetadata(preserved);
        } else {
          const mergedIncoming =
            mergePreservingXboxHints(game.enrichedMetadata, latestRichMetadataRef.current) ||
            game.enrichedMetadata;
          latestRichMetadataRef.current = mergedIncoming;
          setMetadata((prev) =>
            prev && hasRichMetadata(prev)
              ? mergePreservingXboxHints({ ...prev, ...mergedIncoming }, prev) || {
                  ...prev,
                  ...mergedIncoming,
                }
              : mergedIncoming
          );
        }
      } else {
        setMetadata((prev) => (hasRichMetadata(prev) ? prev : game.enrichedMetadata!));
      }
      setIsLoading(false);
    }
  }, [game]);

  useEffect(() => {
    let isMounted = true;
    const isNewGame = activeGameIdRef.current !== game.id;
    const isOverrideUpdated = activeOverrideStampRef.current !== userOverride?.updatedAt;
    activeGameIdRef.current = game.id;
    activeOverrideStampRef.current = userOverride?.updatedAt;

    if (isNewGame) {
      setVaultHltb(null);
      vaultCriticRef.current.resetVaultCriticForNewGame();
      lastPersistedVaultMetaSigRef.current = '';
      latestRichMetadataRef.current = hasRichMetadata(game.enrichedMetadata)
        ? game.enrichedMetadata!
        : null;
    }

    if (isNewGame || isOverrideUpdated) {
      setMetadata(game.enrichedMetadata || null);
      setCurrentSteamAppId(game.steamAppId);
      if (isNewGame && !game.enrichedMetadata) {
        setIsLoading(true);
      }
    }

    async function loadData() {
      try {
        let existingRichMeta: SteamEnrichedMetadata | null = hasRichMetadata(game.enrichedMetadata)
          ? game.enrichedMetadata!
          : !isNewGame && hasRichMetadata(latestRichMetadataRef.current)
          ? latestRichMetadataRef.current
          : null;

        // Hydrate cached detail from SQLite offlineVault when enrichedMetadata, HLTB, or criticScore is missing/upgradable
        const vaultCheckOverride = getUserOverrideForGame(game);
        const vaultCheckRoute = vaultCheckOverride
          ? inferReviewRouteFromOverride(vaultCheckOverride)
          : undefined;
        const hasUserCriticOverride = Boolean(
          vaultCheckRoute || vaultCheckOverride?.reviewScoreOverride !== undefined
        );
        const currentResolvedCritic = resolveGameReviewScore(game, {
          liveMetadata: existingRichMeta,
          liveReviewSummary: existingRichMeta?.reviewSummary ?? game.reviewSummary,
          userOverride: vaultCheckOverride,
          skipBackgroundTrigger: true,
        });
        const needsRichMetaFromVault =
          !existingRichMeta || !isAuthoritativeSteamMetadata(existingRichMeta, game.steamAppId);
        const needsHltbFromVault = !getHowLongToBeat(game.title, game.steamAppId);
        const needsCriticFromVault =
          !hasUserCriticOverride && getReviewSourceAuthorityRank(currentResolvedCritic) < 4;
        if (
          (needsRichMetaFromVault || needsHltbFromVault || needsCriticFromVault) &&
          typeof window !== 'undefined' &&
          window.electronAPI?.offlineVault?.getGameDetail
        ) {
          try {
            const vaultDetail = await window.electronAPI.offlineVault.getGameDetail(game.id);
            if (vaultDetail?.hltb) {
              const hydratedVaultHltb = parseVaultHltb(vaultDetail.hltb);
              if (hydratedVaultHltb) {
                seedHltbFromVaultIfMissing(game.title, game.steamAppId, hydratedVaultHltb);
                if (isMounted) {
                  setVaultHltb(hydratedVaultHltb);
                }
              }
            }
            if (
              needsRichMetaFromVault &&
              vaultDetail?.enrichedMetadata &&
              hasRichMetadata(vaultDetail.enrichedMetadata)
            ) {
              const shouldAdoptVault =
                !existingRichMeta ||
                (isAuthoritativeSteamMetadata(vaultDetail.enrichedMetadata) &&
                  !isAuthoritativeSteamMetadata(existingRichMeta));
              if (shouldAdoptVault) {
                const mergedVault =
                  mergePreservingXboxHints(
                    vaultDetail.enrichedMetadata,
                    game.enrichedMetadata || existingRichMeta
                  ) || vaultDetail.enrichedMetadata;
                existingRichMeta = mergedVault;
                latestRichMetadataRef.current = mergedVault;
                if (isMounted) {
                  setMetadata(mergedVault);
                  setIsLoading(false);
                }
              }
            }
            if (vaultDetail?.criticScore) {
              const adoptedVaultCritic = vaultCriticRef.current.adoptVaultCriticScore(
                vaultDetail.criticScore,
                game,
                vaultDetail.enrichedMetadata ?? existingRichMeta
              );
              if (adoptedVaultCritic && isMounted) {
                vaultCriticRef.current.applyAdoptedVaultCritic(game.id, adoptedVaultCritic);
              }
            }
          } catch {
            // Ignore vault read error
          }
        }

        const currentOverride = getUserOverrideForGame(game);
        const route = inferMetadataRouteFromOverride(currentOverride);
        const isXboxCustomRoute =
          route?.source === 'custom' &&
          (String(route.matchedId || '').toLowerCase().startsWith('xbox-') ||
            /^[A-Z0-9]{12}$/i.test(String(route.matchedId || '').trim()));
        const isRoutedToNonSteamStore =
          route?.source === 'gog' || route?.source === 'epic' || isXboxCustomRoute;

        const resolveSafeMetadata = (
          incoming: SteamEnrichedMetadata | null | undefined,
          expectedSteamAppId?: number | null
        ): { resolved: SteamEnrichedMetadata | null; canPersistMetadata: boolean } => {
          if (incoming && !isSkeletonMetadata(incoming) && !incoming.__quotaSlimmed) {
            if (
              !isOverrideUpdated &&
              !isRoutedToNonSteamStore &&
              isAuthoritativeSteamMetadata(existingRichMeta, expectedSteamAppId) &&
              !isAuthoritativeSteamMetadata(incoming, expectedSteamAppId)
            ) {
              const kept =
                mergePreservingXboxHints(existingRichMeta, incoming || game.enrichedMetadata) ||
                existingRichMeta!;
              latestRichMetadataRef.current = kept;
              return { resolved: kept, canPersistMetadata: false };
            }
            const mergedIncoming =
              mergePreservingXboxHints(incoming, game.enrichedMetadata || existingRichMeta) ||
              incoming;
            latestRichMetadataRef.current = mergedIncoming;
            return { resolved: mergedIncoming, canPersistMetadata: true };
          }
          if (existingRichMeta && !isOverrideUpdated) {
            return { resolved: existingRichMeta, canPersistMetadata: false };
          }
          return { resolved: incoming || existingRichMeta || null, canPersistMetadata: false };
        };

        let targetAppId =
          route?.source === 'steam' && route.steamAppId ? route.steamAppId : game.steamAppId;

        const isExplicitNonSteam =
          game.isExplicitNonSteam === true ||
          currentOverride?.steamAppId === null ||
          currentOverride?.isExplicitNonSteam === true ||
          isRoutedToNonSteamStore ||
          route?.source === 'igdb';

        if (!targetAppId && !isExplicitNonSteam) {
          const instantEffective = steamMatcher.getEffectiveSteamAppId(game);
          if (instantEffective) {
            targetAppId = instantEffective;
            if (isMounted) {
              setCurrentSteamAppId(instantEffective);
            }
          }
        }

        if (!targetAppId && !isExplicitNonSteam) {
          try {
            const matchOptions = {
              releaseYear: game.releaseDate,
              developers: game.developers,
              priority: RequestPriority.P0_INTERACTIVE,
            };
            const matched = await steamMatcher.matchGameToSteam(game.title, matchOptions);
            if (matched && isMounted) {
              targetAppId = matched;
              setCurrentSteamAppId(matched);
            }
          } catch (e) {
            console.warn('Steam matching failed:', e);
          }
        }

        const rawGameExt = game as CanonicalGame & {
          customCoverUrl?: string;
          hasCustomArtwork?: boolean;
        };
        const hasUserCoverOverride = Boolean(
          currentOverride?.capsuleImage ||
            rawGameExt.customCoverUrl ||
            rawGameExt.hasCustomArtwork
        );
        const hasUserHeaderOverride = Boolean(
          currentOverride?.headerImage || rawGameExt.hasCustomArtwork
        );

        const persistDetailToVault = (
          metaToSave: SteamEnrichedMetadata | null | undefined,
          steamIdToSave: number | null | undefined
        ) => {
          if (
            !metaToSave ||
            isSkeletonMetadata(metaToSave) ||
            metaToSave.__quotaSlimmed ||
            typeof window === 'undefined' ||
            typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
          ) {
            return;
          }
          const resolvedReviewSummary = hasRealSteamReviewSummary(metaToSave.reviewSummary)
            ? metaToSave.reviewSummary
            : hasRealSteamReviewSummary(game.reviewSummary)
            ? game.reviewSummary
            : undefined;
          const enrichedForVault: SteamEnrichedMetadata = resolvedReviewSummary
            ? { ...metaToSave, reviewSummary: resolvedReviewSummary }
            : metaToSave;
          const targetGameSnapshot: CanonicalGame =
            steamIdToSave && steamIdToSave !== game.steamAppId
              ? { ...game, steamAppId: steamIdToSave }
              : game;
          const activeOverrideRoute = currentOverride
            ? inferReviewRouteFromOverride(currentOverride)
            : undefined;
          const isUnratedOverride =
            activeOverrideRoute?.mode === 'unrated' ||
            currentOverride?.reviewScoreOverride === null;
          const isExplicitCriticOverride =
            !isUnratedOverride &&
            Boolean(
              activeOverrideRoute?.mode === 'static' ||
                activeOverrideRoute?.mode === 'routed' ||
                (currentOverride?.reviewScoreOverride &&
                  typeof currentOverride.reviewScoreOverride.score === 'number' &&
                  currentOverride.reviewScoreOverride.score > 0)
            );
          const resolvedCritic = resolveGameReviewScore(targetGameSnapshot, {
            liveMetadata: enrichedForVault,
            liveReviewSummary: resolvedReviewSummary,
            userOverride: currentOverride,
            skipBackgroundTrigger: true,
          });
          const metaSig = [
            game.id,
            enrichedForVault.appId || 0,
            enrichedForVault.metadataQuality || '',
            resolvedReviewSummary?.totalReviews ?? 0,
            resolvedReviewSummary?.positivePercent ?? 0,
            enrichedForVault.metacritic?.score ?? 0,
            isUnratedOverride
              ? 'unrated'
              : resolvedCritic
              ? `${resolvedCritic.source}:${resolvedCritic.score}:${isExplicitCriticOverride ? 'ov' : 'auto'}`
              : '',
          ].join('|');
          if (metaSig === lastPersistedVaultMetaSigRef.current) {
            return;
          }
          lastPersistedVaultMetaSigRef.current = metaSig;
          if (isUnratedOverride) {
            lastPersistedVaultCriticSigRef.current = `${game.id}|__unrated__`;
          } else if (resolvedCritic && resolvedCritic.score > 0) {
            lastPersistedVaultCriticSigRef.current = buildVaultCriticSignature(
              game.id,
              resolvedCritic,
              isExplicitCriticOverride
            );
          }
          try {
            void window.electronAPI.offlineVault
              .saveGameDetail({
                gameId: game.id,
                steamAppId: steamIdToSave ?? game.steamAppId ?? null,
                canonicalTitle: game.title,
                enrichedMetadata: enrichedForVault,
                ...(isUnratedOverride
                  ? { clearCriticScore: true }
                  : resolvedCritic && resolvedCritic.score > 0
                  ? {
                      criticScore: { ...resolvedCritic },
                      ...(isExplicitCriticOverride ? { forceCriticScore: true } : {}),
                    }
                  : {}),
              })
              ?.catch?.(() => {});
          } catch {
            // Ignore vault persistence error
          }
        };

        const computeTopLevelFields = (
          meta?: SteamEnrichedMetadata | null,
          browseAssets?: SteamStoreBrowseAssets | null
        ) =>
          buildEnrichedTopLevelFields({
            game,
            currentOverride,
            existingRichMeta,
            hasUserHeaderOverride,
            hasUserCoverOverride,
            meta,
            browseAssets,
          });

        const ownsOnSteam =
          Array.isArray(game.platforms) && game.platforms.some((p) => p.platformId === 'steam');

        // Case A: User explicitly routed Step 4 metadata to GOG, Epic, or Xbox
        if (isRoutedToNonSteamStore) {
          const crossSteamAppId = game.steamAppId || route?.steamAppId;
          const [rawFallbackData, liveAchs] = await Promise.all([
            fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game, currentOverride),
            ownsOnSteam && game.steamAppId
              ? steamAchievementsService.fetchPlayerGameAchievements(game.steamAppId)
              : Promise.resolve(null),
          ]);

          let fallbackData = rawFallbackData;
          if (
            fallbackData &&
            !isSkeletonMetadata(fallbackData) &&
            (!fallbackData.movies || fallbackData.movies.length === 0)
          ) {
            if (existingRichMeta?.movies && existingRichMeta.movies.length > 0) {
              fallbackData = {
                ...fallbackData,
                movies: existingRichMeta.movies,
              };
            } else if (crossSteamAppId) {
              try {
                const steamMetaForMovies = await steamApi.fetchGameMetadata(
                  crossSteamAppId,
                  RequestPriority.P0_INTERACTIVE
                );
                if (steamMetaForMovies?.movies && steamMetaForMovies.movies.length > 0) {
                  fallbackData = {
                    ...fallbackData,
                    movies: steamMetaForMovies.movies,
                  };
                }
              } catch {
                // Ignore cross-store movie fallback error
              }
            }
          }

          const { resolved, canPersistMetadata } = resolveSafeMetadata(fallbackData);

          if (isMounted && resolved) {
            setMetadata(resolved);
            const {
              nextShortDescription,
              nextDetailedDescription,
              nextDevelopers,
              nextPublishers,
              nextReleaseDate,
              nextHeaderImage,
              nextCapsuleImage,
              nextReviewSummary,
              topLevelChanged,
            } = computeTopLevelFields(canPersistMetadata ? resolved : null);
            let updatedPlatforms = game.platforms;
            let hasChanges =
              canPersistMetadata &&
              (!game.enrichedMetadata ||
                Boolean(game.enrichedMetadata.__quotaSlimmed) ||
                isOverrideUpdated ||
                topLevelChanged);

            if (liveAchs) {
              const currentSteamPlat = game.platforms.find((p) => p.platformId === 'steam');
              const curAch = currentSteamPlat?.achievements;
              const achChanged =
                !curAch ||
                curAch.unlocked !== liveAchs.unlocked ||
                curAch.total !== liveAchs.total ||
                curAch.source !== liveAchs.source;
              if (achChanged) {
                hasChanges = true;
                updatedPlatforms = game.platforms.map((p) =>
                  p.platformId === 'steam' ? { ...p, achievements: liveAchs } : p
                );
              }
            }

            if (hasChanges) {
              const updatedGame: CanonicalGame = {
                ...game,
                platforms: updatedPlatforms,
                shortDescription: nextShortDescription,
                detailedDescription: nextDetailedDescription,
                developers: nextDevelopers,
                publishers: nextPublishers,
                releaseDate: nextReleaseDate,
                headerImage: nextHeaderImage,
                capsuleImage: nextCapsuleImage,
                ...(nextReviewSummary ? { reviewSummary: nextReviewSummary } : {}),
                enrichedMetadata: canPersistMetadata
                  ? resolved
                  : existingRichMeta || game.enrichedMetadata,
              };
              if (canPersistMetadata) {
                persistDetailToVault(resolved, game.steamAppId);
              }
              setCurrentGame(updatedGame);
              onGameUpdated?.(updatedGame);
            }
          }
        } else if (targetAppId) {
          // Case B: Matched or routed to Steam
          const needsBrowseArtworkUpgrade =
            onlineLifecycleManager.isOnline() &&
            typeof steamApi.fetchStoreBrowseAssets === 'function' &&
            ((!hasUserCoverOverride &&
              (!game.capsuleImage || isMicrosoftStoreAssetUrl(game.capsuleImage))) ||
              (!hasUserHeaderOverride &&
                (!game.headerImage || isMicrosoftStoreAssetUrl(game.headerImage))));

          const browseAssetsPromise: Promise<SteamStoreBrowseAssets | null> | null =
            needsBrowseArtworkUpgrade
              ? Promise.resolve(
                  steamApi.fetchStoreBrowseAssets(targetAppId, RequestPriority.P0_INTERACTIVE)
                ).catch(() => null)
              : null;

          const [liveData, liveAchs] = await Promise.all([
            steamApi.fetchGameMetadata(targetAppId, RequestPriority.P0_INTERACTIVE, {
              expectMacRequirements: activeStoreSupportsMacRef.current,
            }),
            ownsOnSteam
              ? steamAchievementsService.fetchPlayerGameAchievements(targetAppId)
              : Promise.resolve(null),
          ]);

          const BROWSE_PENDING = Symbol('browse-pending');
          const settledBrowseOrPending = browseAssetsPromise
            ? await Promise.race([browseAssetsPromise, Promise.resolve(BROWSE_PENDING)])
            : null;
          const instantBrowse =
            typeof steamApi.getStoreBrowseAssetsInstant === 'function'
              ? steamApi.getStoreBrowseAssetsInstant(targetAppId)
              : null;
          const resolvedBrowseAssets: SteamStoreBrowseAssets | null =
            settledBrowseOrPending !== BROWSE_PENDING && settledBrowseOrPending
              ? settledBrowseOrPending
              : instantBrowse;

          if (isMounted) {
            let candidateMetadata: SteamEnrichedMetadata | null = null;
            if (liveData && !isSkeletonMetadata(liveData)) {
              candidateMetadata = resolvedBrowseAssets
                ? {
                    ...liveData,
                    headerImage: resolvedBrowseAssets.headerImage || liveData.headerImage,
                    capsuleImage: resolvedBrowseAssets.capsuleImage || liveData.capsuleImage,
                  }
                : liveData;
              if (!candidateMetadata.movies || candidateMetadata.movies.length === 0) {
                if (existingRichMeta?.movies && existingRichMeta.movies.length > 0) {
                  candidateMetadata = {
                    ...candidateMetadata,
                    movies: existingRichMeta.movies,
                  };
                } else if (
                  game.platforms.some(
                    (p) =>
                      p.platformId === 'epic' || p.platformId === 'gog' || p.platformId === 'xbox'
                  )
                ) {
                  try {
                    const nonSteamFallback =
                      await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
                        game,
                        currentOverride
                      );
                    if (nonSteamFallback?.movies && nonSteamFallback.movies.length > 0) {
                      candidateMetadata = {
                        ...candidateMetadata,
                        movies: nonSteamFallback.movies,
                      };
                    }
                  } catch {
                    // Ignore fallback movie lookup error
                  }
                }
              }
              if (currentOverride && route?.mode === 'routed' && route.source === 'steam') {
                updateRoutedMetadataSnapshot(game.id, {
                  title: candidateMetadata.name,
                  shortDescription: candidateMetadata.shortDescription,
                  detailedDescription:
                    candidateMetadata.detailedDescription || candidateMetadata.aboutTheGame,
                  headerImage: candidateMetadata.headerImage,
                  developers: candidateMetadata.developers,
                  publishers: candidateMetadata.publishers,
                  genres: candidateMetadata.genres,
                  tags: candidateMetadata.tags,
                  releaseDate: candidateMetadata.releaseDate,
                });
              }
            } else if (
              !existingRichMeta ||
              isOverrideUpdated ||
              !isAuthoritativeSteamMetadata(existingRichMeta, targetAppId)
            ) {
              const fallbackData = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
                game,
                currentOverride
              );
              if (isMounted) {
                candidateMetadata = fallbackData;
              }
            }

            const { resolved: resolvedMetadata, canPersistMetadata } = resolveSafeMetadata(
              candidateMetadata,
              targetAppId
            );

            if (isMounted && resolvedMetadata) {
              setMetadata(resolvedMetadata);
            }

            const {
              nextShortDescription,
              nextDetailedDescription,
              nextDevelopers,
              nextPublishers,
              nextReleaseDate,
              nextHeaderImage,
              nextCapsuleImage,
              nextReviewSummary,
              topLevelChanged,
            } = computeTopLevelFields(
              canPersistMetadata ? resolvedMetadata : null,
              resolvedBrowseAssets
            );

            let hasChanges = canPersistMetadata && topLevelChanged;
            let updatedPlatforms = game.platforms;

            if (liveAchs) {
              const currentSteamPlat = game.platforms.find((p) => p.platformId === 'steam');
              const curAch = currentSteamPlat?.achievements;
              const achChanged =
                !curAch ||
                curAch.unlocked !== liveAchs.unlocked ||
                curAch.total !== liveAchs.total ||
                curAch.source !== liveAchs.source;

              if (achChanged) {
                hasChanges = true;
                updatedPlatforms = game.platforms.map((p) =>
                  p.platformId === 'steam' ? { ...p, achievements: liveAchs } : p
                );
              }
            }

            if (targetAppId !== game.steamAppId) {
              hasChanges = true;
            }

            const gainedOsRequirements = Boolean(
              resolvedMetadata &&
                ((!hasMeaningfulRequirementSpec(game.enrichedMetadata?.macRequirements) &&
                  hasMeaningfulRequirementSpec(resolvedMetadata.macRequirements)) ||
                  (!hasMeaningfulRequirementSpec(game.enrichedMetadata?.linuxRequirements) &&
                    hasMeaningfulRequirementSpec(resolvedMetadata.linuxRequirements)))
            );

            if (
              canPersistMetadata &&
              resolvedMetadata &&
              (!game.enrichedMetadata ||
                Boolean(game.enrichedMetadata.__quotaSlimmed) ||
                isOverrideUpdated ||
                gainedOsRequirements ||
                !isAuthoritativeSteamMetadata(game.enrichedMetadata, targetAppId))
            ) {
              hasChanges = true;
            }

            let latestGameSnapshot: CanonicalGame = game;

            if (hasChanges && isMounted) {
              const updatedGame: CanonicalGame = {
                ...game,
                platforms: updatedPlatforms,
                steamAppId: targetAppId,
                shortDescription: nextShortDescription,
                detailedDescription: nextDetailedDescription,
                developers: nextDevelopers,
                publishers: nextPublishers,
                releaseDate: nextReleaseDate,
                headerImage: nextHeaderImage,
                capsuleImage: nextCapsuleImage,
                ...(nextReviewSummary ? { reviewSummary: nextReviewSummary } : {}),
                enrichedMetadata: canPersistMetadata
                  ? resolvedMetadata || existingRichMeta || game.enrichedMetadata
                  : existingRichMeta || game.enrichedMetadata,
              };
              if (canPersistMetadata && resolvedMetadata) {
                persistDetailToVault(resolvedMetadata, targetAppId);
              }
              latestGameSnapshot = updatedGame;
              setCurrentGame(updatedGame);
              onGameUpdated?.(updatedGame);
            }

            if (settledBrowseOrPending === BROWSE_PENDING && browseAssetsPromise) {
              void browseAssetsPromise
                .then((lateBrowse) => {
                  if (!isMounted || !lateBrowse) return;
                  const upgradedHeader =
                    !hasUserHeaderOverride &&
                    lateBrowse.headerImage &&
                    (!latestGameSnapshot.headerImage ||
                      isMicrosoftStoreAssetUrl(latestGameSnapshot.headerImage))
                      ? lateBrowse.headerImage
                      : undefined;
                  const upgradedCapsule =
                    !hasUserCoverOverride &&
                    lateBrowse.capsuleImage &&
                    (!latestGameSnapshot.capsuleImage ||
                      isMicrosoftStoreAssetUrl(latestGameSnapshot.capsuleImage))
                      ? lateBrowse.capsuleImage
                      : undefined;
                  if (!upgradedHeader && !upgradedCapsule) return;

                  setMetadata((prev) =>
                    prev
                      ? {
                          ...prev,
                          headerImage: upgradedHeader || prev.headerImage,
                          capsuleImage: upgradedCapsule || prev.capsuleImage,
                        }
                      : prev
                  );

                  const nextGame: CanonicalGame = {
                    ...latestGameSnapshot,
                    headerImage: upgradedHeader || latestGameSnapshot.headerImage,
                    capsuleImage: upgradedCapsule || latestGameSnapshot.capsuleImage,
                    enrichedMetadata: latestGameSnapshot.enrichedMetadata
                      ? {
                          ...latestGameSnapshot.enrichedMetadata,
                          headerImage:
                            upgradedHeader || latestGameSnapshot.enrichedMetadata.headerImage,
                          capsuleImage:
                            upgradedCapsule || latestGameSnapshot.enrichedMetadata.capsuleImage,
                        }
                      : latestGameSnapshot.enrichedMetadata,
                  };
                  latestGameSnapshot = nextGame;
                  setCurrentGame(nextGame);
                  onGameUpdated?.(nextGame);
                })
                .catch(() => {});
            }
          }
        } else {
          // Case C: Non-Steam game (e.g. GOG, Epic, Xbox, IGDB exclusive)
          let fallbackData = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
            game,
            currentOverride
          );
          if (
            fallbackData &&
            !isSkeletonMetadata(fallbackData) &&
            (!fallbackData.movies || fallbackData.movies.length === 0) &&
            existingRichMeta?.movies &&
            existingRichMeta.movies.length > 0
          ) {
            fallbackData = {
              ...fallbackData,
              movies: existingRichMeta.movies,
            };
          }

          const { resolved, canPersistMetadata } = resolveSafeMetadata(fallbackData);

          if (isMounted && resolved) {
            setMetadata(resolved);
            if (canPersistMetadata) {
              const {
                nextShortDescription,
                nextDetailedDescription,
                nextDevelopers,
                nextPublishers,
                nextReleaseDate,
                nextHeaderImage,
                nextCapsuleImage,
                nextReviewSummary,
                topLevelChanged,
              } = computeTopLevelFields(resolved);
              const hasChanges =
                !game.enrichedMetadata ||
                Boolean(game.enrichedMetadata.__quotaSlimmed) ||
                isOverrideUpdated ||
                topLevelChanged;
              if (hasChanges) {
                const updatedGame: CanonicalGame = {
                  ...game,
                  shortDescription: nextShortDescription,
                  detailedDescription: nextDetailedDescription,
                  developers: nextDevelopers,
                  publishers: nextPublishers,
                  releaseDate: nextReleaseDate,
                  headerImage: nextHeaderImage,
                  capsuleImage: nextCapsuleImage,
                  ...(nextReviewSummary ? { reviewSummary: nextReviewSummary } : {}),
                  enrichedMetadata: resolved,
                };
                persistDetailToVault(resolved, game.steamAppId);
                setCurrentGame(updatedGame);
                onGameUpdated?.(updatedGame);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[SteamStorePage] Detail metadata load failed:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadData();

    return () => {
      isMounted = false;
    };
  }, [
    game.id,
    game.steamAppId,
    userOverride?.updatedAt,
    metadataRoute?.source,
    metadataRoute?.matchedId,
    metadataRoute?.steamAppId,
    metadataRoute?.gogId,
    reloadTrigger,
  ]);

  return {
    currentGame,
    metadata,
    vaultHltb,
    currentSteamAppId,
    isLoading,
    isOnline,
    onlineGeneration,
  };
}
