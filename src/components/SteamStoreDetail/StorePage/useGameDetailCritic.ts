import { useEffect, useState, useCallback, useRef } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { SteamEnrichedMetadata, SteamReviewSummary } from '../../../contracts/steam';
import { CriticScoreData } from '../../../contracts/critic';
import { UserGameOverride } from '../../../contracts/override';
import { criticScoreService } from '../../../services/critic/criticScoreService';
import {
  getReviewSourceAuthorityRank,
  normalizeCriticTitleKey,
  parseVaultCriticScore,
} from '../../../services/critic/criticUtils';
import {
  buildVerifiedSteamMetacriticAnchor,
  resolveGameReviewScore,
} from '../../../services/critic/reviewScoreResolver';
import {
  getUserOverrideForGame,
  inferReviewRouteFromOverride,
} from '../../../services/storage/userOverrideStorage';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import {
  buildVaultCriticSignature,
  hasRealSteamReviewSummary,
  isSkeletonMetadata,
  selectPreferredCriticScore,
  shouldAcceptCriticUpdateEvent,
} from './steamDetailUtils';

export interface VaultCriticAdoptionController {
  vaultCriticScore: CriticScoreData | null;
  lastPersistedVaultCriticSigRef: React.MutableRefObject<string>;
  adoptVaultCriticScore: (
    rawCritic: unknown,
    targetGame: CanonicalGame,
    metaForAnchor?: SteamEnrichedMetadata | null
  ) => CriticScoreData | null;
  applyAdoptedVaultCritic: (gameId: string, adopted: CriticScoreData) => void;
  resetVaultCriticForNewGame: () => void;
  registerOpenCriticSetter: (
    setter: React.Dispatch<React.SetStateAction<CriticScoreData | null>>
  ) => void;
}

export function useVaultCriticAdoption(gameId: string): VaultCriticAdoptionController {
  const [vaultCriticState, setVaultCriticState] = useState<{
    gameId: string;
    data: CriticScoreData;
  } | null>(null);
  const lastPersistedVaultCriticSigRef = useRef<string>('');
  const openCriticSetterRef = useRef<
    React.Dispatch<React.SetStateAction<CriticScoreData | null>> | null
  >(null);

  const vaultCriticScore =
    vaultCriticState && vaultCriticState.gameId === gameId ? vaultCriticState.data : null;

  const registerOpenCriticSetter = useCallback(
    (setter: React.Dispatch<React.SetStateAction<CriticScoreData | null>>) => {
      openCriticSetterRef.current = setter;
    },
    []
  );

  const resetVaultCriticForNewGame = useCallback(() => {
    setVaultCriticState(null);
    lastPersistedVaultCriticSigRef.current = '';
  }, []);

  const adoptVaultCriticScore = useCallback(
    (
      rawCritic: unknown,
      targetGame: CanonicalGame,
      metaForAnchor?: SteamEnrichedMetadata | null
    ): CriticScoreData | null => {
      const parsed = parseVaultCriticScore(rawCritic);
      if (!parsed) return null;

      const activeOverride = getUserOverrideForGame(targetGame);
      const activeRoute = activeOverride
        ? inferReviewRouteFromOverride(activeOverride)
        : undefined;
      if (activeRoute || activeOverride?.reviewScoreOverride !== undefined) {
        return null;
      }

      const targetSteamAppId =
        steamMatcher.getEffectiveSteamAppId(targetGame) ?? targetGame.steamAppId;
      const anchorSlug = buildVerifiedSteamMetacriticAnchor(
        targetGame,
        metaForAnchor
      )?.metacriticSlug;
      if (
        !criticScoreService.isScoreSemanticallyCompatible(
          targetGame.title,
          parsed,
          targetSteamAppId,
          anchorSlug
        )
      ) {
        return null;
      }

      const currentResolved = resolveGameReviewScore(targetGame, {
        liveMetadata: metaForAnchor,
        liveReviewSummary: metaForAnchor?.reviewSummary ?? targetGame.reviewSummary,
        userOverride: activeOverride,
        skipBackgroundTrigger: true,
      });
      const currentRank = getReviewSourceAuthorityRank(currentResolved);
      const vaultRank = getReviewSourceAuthorityRank(parsed);

      const vaultSig = buildVaultCriticSignature(targetGame.id, parsed);
      if (vaultRank >= currentRank) {
        lastPersistedVaultCriticSigRef.current = vaultSig;
      }

      if (vaultRank > currentRank) {
        criticScoreService.seedFromVaultIfMissing(
          targetSteamAppId,
          targetGame.title,
          parsed,
          metaForAnchor?.releaseDate ?? targetGame.releaseDate,
          targetGame.genres,
          { gameId: targetGame.id, platforms: targetGame.platforms }
        );
        return parsed;
      }

      return null;
    },
    []
  );

  const applyAdoptedVaultCritic = useCallback((targetGameId: string, adopted: CriticScoreData) => {
    setVaultCriticState({ gameId: targetGameId, data: adopted });
    openCriticSetterRef.current?.((prev) =>
      getReviewSourceAuthorityRank(prev) >= getReviewSourceAuthorityRank(adopted) ? prev : adopted
    );
  }, []);

  return {
    vaultCriticScore,
    lastPersistedVaultCriticSigRef,
    adoptVaultCriticScore,
    applyAdoptedVaultCritic,
    resetVaultCriticForNewGame,
    registerOpenCriticSetter,
  };
}

export interface UseGameDetailCriticParams {
  game: CanonicalGame;
  activeReviewGame: CanonicalGame;
  currentSteamAppId?: number;
  effectiveSteamId?: number;
  resolvedSteamAppId: number | null;
  metadata: SteamEnrichedMetadata | null;
  reviewSummary?: SteamReviewSummary;
  userOverride?: UserGameOverride | null;
  overrideTick: number;
  vaultCritic: VaultCriticAdoptionController;
}

export function useGameDetailCritic({
  game,
  activeReviewGame,
  currentSteamAppId,
  effectiveSteamId,
  resolvedSteamAppId,
  metadata,
  reviewSummary,
  userOverride,
  overrideTick,
  vaultCritic,
}: UseGameDetailCriticParams): CriticScoreData | null {
  const { vaultCriticScore, lastPersistedVaultCriticSigRef, registerOpenCriticSetter } =
    vaultCritic;

  const [openCriticData, setOpenCriticData] = useState<CriticScoreData | null>(() =>
    resolveGameReviewScore(activeReviewGame, {
      liveMetadata: metadata,
      liveReviewSummary: reviewSummary,
      userOverride,
      skipBackgroundTrigger: true,
    })
  );

  registerOpenCriticSetter(setOpenCriticData);

  useEffect(() => {
    const refreshResolvedScore = (skipBackgroundTrigger = false): CriticScoreData | null => {
      const liveOverride = getUserOverrideForGame(activeReviewGame);
      const resolved = resolveGameReviewScore(activeReviewGame, {
        liveMetadata: metadata,
        liveReviewSummary: reviewSummary,
        userOverride: liveOverride,
        skipBackgroundTrigger,
      });
      const next = selectPreferredCriticScore(resolved, vaultCriticScore, liveOverride);
      setOpenCriticData(next);
      return next;
    };

    refreshResolvedScore(false);

    const normalizedGameTitle = normalizeCriticTitleKey(game.title);
    const lowerGameTitle = game.title.trim().toLowerCase();

    const handleCriticUpdate = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          gameId?: string;
          title?: string;
          steamAppId?: number;
          appId?: number;
          data?: CriticScoreData | null;
          refreshedAll?: boolean;
          hydratedFromVault?: boolean;
        }>
      ).detail;

      if (!detail || detail.refreshedAll || detail.hydratedFromVault) {
        refreshResolvedScore(true);
        return;
      }

      if (
        !shouldAcceptCriticUpdateEvent(detail, {
          gameId: game.id,
          gameSteamAppId: game.steamAppId,
          currentSteamAppId,
          effectiveSteamId,
          resolvedSteamAppId,
          lowerGameTitle,
          normalizedGameTitle,
        })
      ) {
        return;
      }

      if (detail.data !== undefined) {
        const liveOverride = getUserOverrideForGame(activeReviewGame);
        const liveRoute = liveOverride ? inferReviewRouteFromOverride(liveOverride) : undefined;
        if (liveRoute?.mode === 'unrated') {
          setOpenCriticData(null);
          return;
        }
        if (detail.data === null) {
          refreshResolvedScore(true);
          return;
        }
        const resolved = resolveGameReviewScore(activeReviewGame, {
          liveMetadata: metadata,
          liveReviewSummary: reviewSummary,
          userOverride: liveOverride,
          skipBackgroundTrigger: true,
        });
        const bestResolved = selectPreferredCriticScore(resolved, vaultCriticScore, liveOverride);
        const incomingRank = getReviewSourceAuthorityRank(detail.data);
        const bestRank = getReviewSourceAuthorityRank(bestResolved, {
          isUserOverride: Boolean(liveRoute?.mode === 'static' || liveRoute?.mode === 'routed'),
        });
        setOpenCriticData(incomingRank >= bestRank ? detail.data : bestResolved);
        return;
      }

      refreshResolvedScore(true);
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('antigravity_critic_updated', handleCriticUpdate);
      return () => window.removeEventListener('antigravity_critic_updated', handleCriticUpdate);
    }
    return undefined;
  }, [
    activeReviewGame,
    game.id,
    game.steamAppId,
    game.title,
    currentSteamAppId,
    effectiveSteamId,
    resolvedSteamAppId,
    metadata,
    reviewSummary,
    userOverride?.updatedAt,
    overrideTick,
    vaultCriticScore,
  ]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
    ) {
      return;
    }
    const activeOverride = getUserOverrideForGame(activeReviewGame);
    const activeRoute = activeOverride ? inferReviewRouteFromOverride(activeOverride) : undefined;
    const isUnratedOverride =
      activeRoute?.mode === 'unrated' || activeOverride?.reviewScoreOverride === null;

    if (isUnratedOverride) {
      const unratedSig = `${game.id}|__unrated__`;
      if (lastPersistedVaultCriticSigRef.current === unratedSig) {
        return;
      }
      lastPersistedVaultCriticSigRef.current = unratedSig;
      try {
        void window.electronAPI.offlineVault
          .saveGameDetail({
            gameId: game.id,
            steamAppId: resolvedSteamAppId ?? null,
            canonicalTitle: game.title,
            clearCriticScore: true,
          })
          ?.catch?.(() => {});
      } catch {
        // Ignore vault persistence error
      }
      return;
    }

    if (
      !openCriticData ||
      typeof openCriticData.score !== 'number' ||
      !Number.isFinite(openCriticData.score) ||
      openCriticData.score <= 0
    ) {
      return;
    }

    const isExplicitOverride = Boolean(
      activeRoute?.mode === 'static' ||
        activeRoute?.mode === 'routed' ||
        (activeOverride?.reviewScoreOverride &&
          typeof activeOverride.reviewScoreOverride.score === 'number' &&
          activeOverride.reviewScoreOverride.score > 0)
    );
    const anchorSlug = buildVerifiedSteamMetacriticAnchor(
      activeReviewGame,
      metadata
    )?.metacriticSlug;
    if (
      !isExplicitOverride &&
      !criticScoreService.isScoreSemanticallyCompatible(
        game.title,
        openCriticData,
        resolvedSteamAppId ?? undefined,
        anchorSlug
      )
    ) {
      return;
    }
    const nextSig = buildVaultCriticSignature(game.id, openCriticData, isExplicitOverride);
    if (!nextSig || nextSig === lastPersistedVaultCriticSigRef.current) {
      return;
    }
    lastPersistedVaultCriticSigRef.current = nextSig;

    const persistableEnrichedMetadata =
      metadata &&
      !isSkeletonMetadata(metadata) &&
      !metadata.__quotaSlimmed &&
      hasRealSteamReviewSummary(reviewSummary)
        ? {
            ...metadata,
            reviewSummary,
          }
        : undefined;

    try {
      void window.electronAPI.offlineVault
        .saveGameDetail({
          gameId: game.id,
          steamAppId: resolvedSteamAppId ?? null,
          canonicalTitle: game.title,
          criticScore: { ...openCriticData },
          ...(isExplicitOverride ? { forceCriticScore: true } : {}),
          ...(persistableEnrichedMetadata
            ? { enrichedMetadata: persistableEnrichedMetadata }
            : {}),
        })
        ?.catch?.(() => {});
    } catch {
      // Ignore vault persistence error
    }
  }, [
    activeReviewGame,
    game.id,
    game.title,
    metadata,
    openCriticData,
    overrideTick,
    resolvedSteamAppId,
    reviewSummary,
    userOverride?.updatedAt,
    lastPersistedVaultCriticSigRef,
  ]);

  return openCriticData;
}
