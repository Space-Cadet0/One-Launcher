import { useState, useEffect, useMemo } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { SteamEnrichedMetadata } from '../../../contracts/steam';
import { CriticScoreData } from '../../../contracts/critic';
import { STOREFRONT_REGISTRY } from '../../../contracts/platform';
import { getReviewSourceDisplayMeta, getTierColor } from '../../../services/critic/criticUtils';
import { resolveGameReviewScore } from '../../../services/critic/reviewScoreResolver';
import {
  getKnownAchievementTotal,
  getKnownEpicAchievements,
  getKnownGogAchievements,
  getKnownSteamAchievements,
  getKnownXboxAchievements,
} from '../../../services/storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../../../services/storage/achievementReconciliation';
import { steamAchievementsService } from '../../../services/steam/steamAchievementsService';
import type { PlatformAchievementSummary } from './actionBarTypes';

export function useActionBarAchievementsAndCritic(
  game: CanonicalGame,
  metadata: SteamEnrichedMetadata | null | undefined,
  openCriticData: CriticScoreData | null | undefined,
  targetSteamAppId: number | undefined
) {
  const [standaloneCriticTick, setStandaloneCriticTick] = useState(0);

  const knownTotal = getKnownAchievementTotal(targetSteamAppId, game.id, game.title);
  const steamData = targetSteamAppId
    ? steamAchievementsService.getCachedAchievements(targetSteamAppId) ||
      getKnownSteamAchievements(targetSteamAppId, game.title)
    : undefined;

  const effectiveTotal =
    steamData?.total ??
    metadata?.achievements?.total ??
    knownTotal ??
    (metadata && !metadata.categories?.some((c) => c.id === 22) ? 0 : 0);

  const platformAchievements: PlatformAchievementSummary[] = game.platforms.map((p) => {
    const reg = STOREFRONT_REGISTRY[p.platformId];
    const name = reg?.name || p.platformId;

    let pAchievements = p.achievements;

    if (p.platformId === 'steam' && targetSteamAppId) {
      const sData =
        steamData ||
        (pAchievements
          ? {
              unlocked: pAchievements.unlocked,
              total: pAchievements.total,
              percentage: pAchievements.percentage,
            }
          : undefined);
      if (sData) {
        pAchievements =
          reconcileAchievementSummaries(pAchievements, sData, {
            title: game.title,
            appId: targetSteamAppId,
            store: 'steam',
          }) || pAchievements;
      }
    } else if (p.platformId === 'gog') {
      const gogKnown = getKnownGogAchievements(p.platformGameId || game.id, game.title);
      if (gogKnown) {
        pAchievements =
          reconcileAchievementSummaries(pAchievements, gogKnown, {
            title: game.title,
            store: 'gog',
          }) || pAchievements;
      }
    } else if (p.platformId === 'epic') {
      const epicKnown =
        getKnownEpicAchievements(p.platformGameId, game.title) ||
        (p.namespace ? getKnownEpicAchievements(p.namespace, game.title) : undefined) ||
        getKnownEpicAchievements(game.id, game.title);
      if (epicKnown) {
        pAchievements =
          reconcileAchievementSummaries(pAchievements, epicKnown, {
            title: game.title,
            store: 'epic',
          }) || pAchievements;
      }
    } else if (p.platformId === 'xbox') {
      const xboxKnown = getKnownXboxAchievements(
        p.xboxTitleId || p.platformGameId || game.id,
        game.title,
        [p.xboxProductId, p.packageFamilyName, p.platformGameId]
      );
      if (xboxKnown) {
        pAchievements =
          reconcileAchievementSummaries(pAchievements, xboxKnown, {
            title: game.title,
            store: 'xbox',
          }) || pAchievements;
      }
    }

    // Never leak Steam's `effectiveTotal` onto unverified non-Steam storefronts
    let platTotal = 0;
    if (pAchievements && pAchievements.total > 0) {
      platTotal = pAchievements.total;
    } else if (p.platformId === 'steam') {
      platTotal = effectiveTotal ?? 0;
      if (platTotal <= 0) {
        const known = getKnownAchievementTotal(
          targetSteamAppId,
          p.platformGameId || game.id,
          game.title
        );
        if (known && known > 0) platTotal = known;
      }
    }

    const unlocked = pAchievements?.unlocked ?? 0;
    const customXp: { earned: number; total: number } | undefined = pAchievements?.xp;
    const realGamerscore =
      pAchievements?.gamerscore && pAchievements.gamerscore.total > 0
        ? pAchievements.gamerscore
        : undefined;

    const percentage =
      platTotal > 0
        ? Math.round((unlocked / platTotal) * 100)
        : realGamerscore && realGamerscore.total > 0
          ? Math.round((realGamerscore.earned / realGamerscore.total) * 100)
          : pAchievements?.percentage ?? 0;
    const isMastered =
      (platTotal > 0 && unlocked >= platTotal) ||
      Boolean(
        realGamerscore &&
          realGamerscore.total > 0 &&
          realGamerscore.earned >= realGamerscore.total
      ) ||
      !!pAchievements?.isMastered;

    const res: PlatformAchievementSummary = {
      platformId: p.platformId,
      platformName: name,
      unlocked,
      total: platTotal,
      percentage,
      isMastered,
      hasConflict: pAchievements?.hasConflict,
      conflictDetails: pAchievements?.conflictDetails,
    };

    if (p.platformId === 'epic' && customXp && customXp.total > 0) {
      res.xp = customXp;
    }
    if (p.platformId === 'xbox' && realGamerscore) {
      res.gamerscore = realGamerscore;
    }

    return res;
  });

  const hasAchievements = platformAchievements.some(
    (p) =>
      p.total > 0 ||
      p.unlocked > 0 ||
      (p.gamerscore?.total ?? 0) > 0 ||
      (p.xp?.total ?? 0) > 0
  );

  const bestAchievement = platformAchievements.reduce(
    (best, cur) => {
      if (cur.percentage > best.percentage) return cur;
      if (cur.percentage === best.percentage) {
        if (cur.unlocked > best.unlocked) return cur;
        if (cur.total > best.total) return cur;
        if (cur.platformId === 'steam') return cur;
      }
      return best;
    },
    platformAchievements[0] || {
      platformId: 'steam',
      platformName: 'Steam',
      unlocked: 0,
      total: 0,
      percentage: 0,
      isMastered: false,
    }
  );

  const isAnyMastered = platformAchievements.some((p) => p.isMastered || p.percentage >= 100);
  const hasControlledCriticData = openCriticData !== undefined;

  useEffect(() => {
    if (
      hasControlledCriticData ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return undefined;
    }
    const handleCriticEvent = () => setStandaloneCriticTick((t) => t + 1);
    window.addEventListener('antigravity_critic_updated', handleCriticEvent);
    window.addEventListener('antigravity:user-override-updated', handleCriticEvent);
    window.addEventListener('antigravity:user-override-removed', handleCriticEvent);
    return () => {
      window.removeEventListener('antigravity_critic_updated', handleCriticEvent);
      window.removeEventListener('antigravity:user-override-updated', handleCriticEvent);
      window.removeEventListener('antigravity:user-override-removed', handleCriticEvent);
    };
  }, [hasControlledCriticData]);

  const openCritic = useMemo<CriticScoreData | null>(() => {
    if (openCriticData !== undefined) {
      return openCriticData;
    }
    return resolveGameReviewScore(game, {
      liveMetadata: metadata,
      liveReviewSummary: metadata?.reviewSummary ?? game.reviewSummary,
      skipBackgroundTrigger: true,
    });
  }, [openCriticData, game, metadata, standaloneCriticTick]);

  const ocColors = openCritic ? getTierColor(openCritic.tier) : null;
  const ocMeta = openCritic ? getReviewSourceDisplayMeta(openCritic) : null;

  return {
    platformAchievements,
    hasAchievements,
    bestAchievement,
    isAnyMastered,
    openCritic,
    ocColors,
    ocMeta,
  };
}
