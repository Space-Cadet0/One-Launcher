import { CanonicalGame } from '../../../contracts/game';
import { OpenCriticData } from '../../../contracts/critic';
import { LibraryFilterState } from '../../../contracts/filter';
import {
  LibraryFilterIndex,
  evaluateLibraryFilter,
} from '../../../services/filter/libraryFilterIndex';
import { getReviewSourceAuthorityRank } from '../../../services/critic/criticUtils';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import { parseTimestampMs } from '../../../utils/dateUtils';
import { launcherService } from '../../../services/launcher/launcherService';
import {
  getAlphabeticalTitleSortKey,
  LIBRARY_TITLE_COLLATOR,
  sortByTitleKey,
} from '../../../services/common/titleSortUtils';
import { getReleaseYear, GridSortOption } from './gridCoverUtils';

export function computeLauncherGridSignature(): string {
  const running = launcherService
    .getRunningGames()
    .map((r) => `${r.gameId}:${r.platformId || ''}`)
    .sort()
    .join(',');
  const installed = launcherService
    .getInstalledRecords()
    .map((i) => `${i.platformId}:${i.platformGameId || i.appId || ''}:${i.executablePath || ''}`)
    .sort()
    .join(',');
  const ignoreLeadingThe =
    launcherService.getPerformanceSettings?.()?.ignoreLeadingTheWhenSorting ?? true;
  return `${running}|${installed}|${ignoreLeadingThe}`;
}

export function extractOverrideResetCandidateIds(
  detail: Record<string, unknown> | undefined
): Set<string> | null {
  const eventType = typeof detail?.type === 'string' ? detail.type : undefined;
  if (
    eventType === 'confirmed-non-game' ||
    eventType === 'confirmed-non-game-batch' ||
    eventType === 'batch-confirmed-non-game' ||
    eventType === 'unconfirmed-non-game'
  ) {
    return null;
  }
  const candidateIds = new Set<string>();
  const addId = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) {
      candidateIds.add(val.trim());
    }
  };
  addId(detail?.gameId);
  addId(detail?.oldGameId);
  const oldGameObj =
    detail?.oldGame && typeof detail.oldGame === 'object'
      ? (detail.oldGame as { id?: unknown; steamAppId?: unknown })
      : undefined;
  addId(oldGameObj?.id);
  if (typeof oldGameObj?.steamAppId === 'number' && oldGameObj.steamAppId > 0) {
    candidateIds.add(`steam-${oldGameObj.steamAppId}`);
  }
  const overrideObj =
    detail?.override && typeof detail.override === 'object'
      ? (detail.override as { gameId?: unknown; steamAppId?: unknown })
      : undefined;
  addId(overrideObj?.gameId);
  if (typeof overrideObj?.steamAppId === 'number' && overrideObj.steamAppId > 0) {
    candidateIds.add(`steam-${overrideObj.steamAppId}`);
  }
  return candidateIds;
}

export interface SortAndFilterGridGamesParams {
  games: CanonicalGame[];
  sortBy: GridSortOption;
  releaseYearOrder: 'desc' | 'asc';
  isPreFiltered: boolean;
  effectiveFilterIndex: LibraryFilterIndex;
  effectiveFilterState: LibraryFilterState;
  effectiveIgnoreLeadingThe: boolean;
  resolveGameCriticData: (game: CanonicalGame) => OpenCriticData | null;
}

export function sortAndFilterLibraryGridGames({
  games,
  sortBy,
  releaseYearOrder,
  isPreFiltered,
  effectiveFilterIndex,
  effectiveFilterState,
  effectiveIgnoreLeadingThe,
  resolveGameCriticData,
}: SortAndFilterGridGamesParams): CanonicalGame[] {
  const seenIds = new Set<string>();
  const uniqueGames: CanonicalGame[] = [];
  for (const g of games) {
    if (!g || !g.id || seenIds.has(g.id)) continue;
    seenIds.add(g.id);
    uniqueGames.push(g);
  }
  const filteredUniqueGames = isPreFiltered
    ? uniqueGames
    : evaluateLibraryFilter(uniqueGames, effectiveFilterIndex, effectiveFilterState);

  const compareDecoratedTitleTie = (
    a: { game: CanonicalGame; sortKey: string; rawTitle: string },
    b: { game: CanonicalGame; sortKey: string; rawTitle: string }
  ): number => {
    const keyCmp = LIBRARY_TITLE_COLLATOR.compare(a.sortKey, b.sortKey);
    if (keyCmp !== 0) return keyCmp;
    const rawCmp = LIBRARY_TITLE_COLLATOR.compare(a.rawTitle, b.rawTitle);
    if (rawCmp !== 0) return rawCmp;
    if (a.game.id !== b.game.id) return a.game.id < b.game.id ? -1 : 1;
    return 0;
  };

  if (sortBy === 'rating') {
    const decorated = new Array<{
      game: CanonicalGame;
      score: number;
      authorityRank: number;
      numReviews: number;
      rec: number;
      sortKey: string;
      rawTitle: string;
    }>(filteredUniqueGames.length);
    for (let i = 0; i < filteredUniqueGames.length; i++) {
      const g = filteredUniqueGames[i];
      const oc = resolveGameCriticData(g);
      const rawTitle = (g.title || '').trim();
      decorated[i] = {
        game: g,
        score: oc?.score ?? -1,
        authorityRank: getReviewSourceAuthorityRank(oc),
        numReviews:
          typeof oc?.numReviews === 'number' && Number.isFinite(oc.numReviews)
            ? oc.numReviews
            : 0,
        rec: oc?.percentRecommended ?? -1,
        sortKey: getAlphabeticalTitleSortKey(rawTitle, effectiveIgnoreLeadingThe),
        rawTitle,
      };
    }
    decorated.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.authorityRank !== a.authorityRank) return b.authorityRank - a.authorityRank;
      if (b.numReviews !== a.numReviews) return b.numReviews - a.numReviews;
      if (b.rec !== a.rec) return b.rec - a.rec;
      return compareDecoratedTitleTie(a, b);
    });
    return decorated.map((d) => d.game);
  }

  if (sortBy === 'playtime') {
    const decorated = filteredUniqueGames.map((g) => {
      const rawTitle = (g.title || '').trim();
      return {
        game: g,
        playtime: g.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0),
        sortKey: getAlphabeticalTitleSortKey(rawTitle, effectiveIgnoreLeadingThe),
        rawTitle,
      };
    });
    decorated.sort((a, b) => {
      if (b.playtime !== a.playtime) return b.playtime - a.playtime;
      return compareDecoratedTitleTie(a, b);
    });
    return decorated.map((d) => d.game);
  }

  if (sortBy === 'recent') {
    const decorated = filteredUniqueGames.map((g) => {
      let maxMs = 0;
      for (const p of g.platforms) {
        const ms = parseTimestampMs(p.lastPlayed);
        if (ms && ms > maxMs) maxMs = ms;
      }
      const rawTitle = (g.title || '').trim();
      return {
        game: g,
        recentMs: maxMs,
        sortKey: getAlphabeticalTitleSortKey(rawTitle, effectiveIgnoreLeadingThe),
        rawTitle,
      };
    });
    decorated.sort((a, b) => {
      if (b.recentMs !== a.recentMs) return b.recentMs - a.recentMs;
      return compareDecoratedTitleTie(a, b);
    });
    return decorated.map((d) => d.game);
  }

  if (sortBy === 'release_year') {
    const decorated = filteredUniqueGames.map((g) => {
      const year =
        effectiveFilterIndex.entriesById.get(g.id)?.releaseYear ??
        (Number(getReleaseYear(g, steamMatcher.getEffectiveSteamAppId(g))) || null);
      const rawTitle = (g.title || '').trim();
      return {
        game: g,
        year,
        sortKey: getAlphabeticalTitleSortKey(rawTitle, effectiveIgnoreLeadingThe),
        rawTitle,
      };
    });
    decorated.sort((a, b) => {
      if (a.year === null && b.year !== null) return 1;
      if (a.year !== null && b.year === null) return -1;
      if (a.year !== null && b.year !== null && a.year !== b.year) {
        return releaseYearOrder === 'asc' ? a.year - b.year : b.year - a.year;
      }
      return compareDecoratedTitleTie(a, b);
    });
    return decorated.map((d) => d.game);
  }

  return sortByTitleKey(filteredUniqueGames, (g) => g.title, {
    ignoreLeadingThe: effectiveIgnoreLeadingThe,
    getId: (g) => g.id,
  });
}
