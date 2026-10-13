import { useEffect } from 'react';
import { CanonicalGame } from '../contracts/game';
import { steamMatcher } from '../services/steam/steamMatcher';
import { getOpenCriticData, criticScoreService } from '../services/critic/criticScoreService';

/**
 * Proactive background critic score warm-up and automatic hydration hook.
 * Gradually resolves unrated library titles in small rate-limited chunks.
 */
export function useCriticScoreWarmup(games: CanonicalGame[]) {
  useEffect(() => {
    criticScoreService.purgeStaleNullScores();

    const unrated = games.filter((g) => {
      const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
      const score = getOpenCriticData(
        targetSteamId || undefined,
        g.title,
        g.reviewSummary?.positivePercent
      );
      return !score || score.score <= 0;
    });

    if (unrated.length === 0) return;

    let isCancelled = false;
    let index = 0;
    const CHUNK_SIZE = 2;
    let delayTimer: ReturnType<typeof setTimeout> | null = null;

    const processNextChunk = async () => {
      if (isCancelled || index >= unrated.length) return;
      const chunk = unrated.slice(index, index + CHUNK_SIZE);
      index += CHUNK_SIZE;

      await Promise.all(
        chunk.map(async (g) => {
          try {
            const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
            await criticScoreService.resolveDynamicScore(g.title, targetSteamId);
          } catch {}
        })
      );

      if (!isCancelled && index < unrated.length) {
        delayTimer = setTimeout(processNextChunk, 1500);
      }
    };

    const timer = setTimeout(() => {
      processNextChunk();
    }, 400);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
      if (delayTimer) clearTimeout(delayTimer);
    };
  }, [games.length]);
}
