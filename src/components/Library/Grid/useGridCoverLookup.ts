import { useCallback, useEffect, useState } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { igdbCoverService, normalizeKey } from '../../../services/igdb/igdbCoverService';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';
import { steamApi } from '../../../services/steam/steamApi';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import { getReleaseYear, globalAttemptedCoverLookups } from './gridCoverUtils';

interface IgdbCoverUpdatedDetail {
  title?: string;
  coverUrl?: string;
}

export function useGridCoverLookup(gamesRef: React.MutableRefObject<CanonicalGame[]>): {
  coverOverrides: Record<string, string | null>;
  handleNeedCoverLookup: (game: CanonicalGame) => void;
} {
  const [coverOverrides, setCoverOverrides] = useState<Record<string, string | null>>({});

  const handleNeedCoverLookup = useCallback((game: CanonicalGame) => {
    if (!onlineLifecycleManager.isOnline()) {
      const instant = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
      if (instant) {
        setCoverOverrides((prev) =>
          prev[game.id] === instant ? prev : { ...prev, [game.id]: instant }
        );
      }
      return;
    }
    const targetAppId = steamMatcher.getEffectiveSteamAppId(game);
    const lookupKey = targetAppId ? `${game.id}:steam:${targetAppId}` : game.id;
    if (globalAttemptedCoverLookups.has(lookupKey)) return;
    globalAttemptedCoverLookups.add(lookupKey);

    const releaseYear = getReleaseYear(game, targetAppId);
    const isExplicitNonSteam = game.isExplicitNonSteam === true;

    const triggerIgdbLookup = () => {
      if (igdbCoverService.hasAttemptedIgdbCover(game.title, releaseYear)) {
        const instant = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
        if (instant) {
          setCoverOverrides((prev) =>
            prev[game.id] === instant ? prev : { ...prev, [game.id]: instant }
          );
        }
        return;
      }

      igdbCoverService
        .fetchIgdbCover(game.title, releaseYear, undefined, { trackInGlobalBar: false })
        .then((resolvedCover) => {
          if (resolvedCover) {
            setCoverOverrides((prev) =>
              prev[game.id] === resolvedCover ? prev : { ...prev, [game.id]: resolvedCover }
            );
          }
        })
        .catch(() => {});
    };

    if (targetAppId && !isExplicitNonSteam) {
      steamApi
        .fetchStoreBrowseAssets(targetAppId)
        .then((assets) => {
          if (assets?.capsuleImage) {
            setCoverOverrides((prev) =>
              prev[game.id] === assets.capsuleImage!
                ? prev
                : { ...prev, [game.id]: assets.capsuleImage! }
            );
            return;
          }
          triggerIgdbLookup();
        })
        .catch(() => {
          triggerIgdbLookup();
        });
      return;
    }

    if (!targetAppId && !isExplicitNonSteam && !steamMatcher.hasAttemptedMatch(game.title)) {
      steamMatcher
        .matchGameToSteam(game.title, {
          releaseYear: game.releaseDate,
          developers: game.developers,
        })
        .then((matchedId) => {
          if (matchedId) {
            steamApi.fetchStoreBrowseAssets(matchedId).catch(() => null);
          }
        })
        .catch(() => null);
    }

    triggerIgdbLookup();
  }, []);

  useEffect(() => {
    const handleCoverUpdate = (e: Event) => {
      const detail = (e as CustomEvent<IgdbCoverUpdatedDetail | undefined>)?.detail;
      const titleVal = detail?.title;
      const coverUrl = detail?.coverUrl;
      if (titleVal && coverUrl) {
        setCoverOverrides((prev) => {
          const normTitle = normalizeKey(titleVal);
          let changed = false;
          let next: Record<string, string | null> | null = null;
          for (const g of gamesRef.current) {
            if (normalizeKey(g.title) === normTitle && prev[g.id] !== coverUrl) {
              if (!next) next = { ...prev };
              next[g.id] = coverUrl;
              changed = true;
            }
          }
          return changed && next ? next : prev;
        });
      }
    };
    window.addEventListener('antigravity:igdb-cover-updated', handleCoverUpdate);
    return () => {
      window.removeEventListener('antigravity:igdb-cover-updated', handleCoverUpdate);
    };
  }, [gamesRef]);

  return { coverOverrides, handleNeedCoverLookup };
}
