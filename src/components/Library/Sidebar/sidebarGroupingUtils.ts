import { CanonicalGame } from '../../../contracts/game';
import { GameCollection } from '../../../contracts/collection';
import { StorefrontId } from '../../../contracts/platform';
import { launcherService } from '../../../services/launcher/launcherService';
import { sortByTitleKey } from '../../../services/common/titleSortUtils';

export const SIDEBAR_PLATFORMS: readonly (StorefrontId | 'all')[] = [
  'all',
  'steam',
  'gog',
  'epic',
  'xbox',
  'amazon',
  'ubisoft',
  'ea',
  'bnet',
  'itch',
];

export type SidebarFlatRow =
  | {
      kind: 'header';
      key: string;
      groupId: string;
      name: string;
      icon?: string;
      count: number;
      isCollapsed: boolean;
      isUncategorized: boolean;
    }
  | {
      kind: 'empty';
      key: string;
      groupId: string;
    }
  | {
      kind: 'game';
      key: string;
      game: CanonicalGame;
      gameRowIndex: number;
      indented: boolean;
    };

export interface GroupedSidebarData {
  collections: Array<GameCollection & { games: CanonicalGame[] }>;
  groups: Array<GameCollection & { games: CanonicalGame[] }>;
  uncategorized: CanonicalGame[];
  uncategorizedGames: CanonicalGame[];
  allSorted: CanonicalGame[];
}

export function computeSidebarLauncherSignature(): string {
  const runningSig = launcherService
    .getRunningGames()
    .map((s) => `${s.gameId}:${s.status}`)
    .sort()
    .join('|');
  const completedSig = launcherService
    .getDownloadQueue()
    .filter((t) => t.status === 'completed')
    .map((t) => t.gameId)
    .sort()
    .join('|');
  const ignoreLeadingTheSig =
    launcherService.getPerformanceSettings?.()?.ignoreLeadingTheWhenSorting ?? true;
  return `${runningSig}##${completedSig}##${ignoreLeadingTheSig}`;
}

export function groupSidebarGames(
  games: CanonicalGame[],
  collections: GameCollection[],
  effectiveIgnoreLeadingThe: boolean
): GroupedSidebarData {
  const seenGameIds = new Set<string>();
  const seenPlatformSigs = new Set<string>();
  const uniqueFilteredGames = games.filter((g) => {
    if (!g || seenGameIds.has(g.id)) return false;
    const platSig = g.platforms
      ?.map((p) => `${p.platformId}:${p.platformGameId}`)
      .sort()
      .join('|');
    if (platSig && seenPlatformSigs.has(platSig)) return false;
    seenGameIds.add(g.id);
    if (platSig) seenPlatformSigs.add(platSig);
    return true;
  });
  const uniqueSortedGames = sortByTitleKey(uniqueFilteredGames, (g) => g.title, {
    ignoreLeadingThe: effectiveIgnoreLeadingThe,
    getId: (g) => g.id,
  });

  const gameMap = new Map<string, CanonicalGame>();
  uniqueSortedGames.forEach((g) => gameMap.set(g.id, g));

  const categorizedGameIds = new Set<string>();

  const colGroups = collections.map((col) => {
    const colUnsorted = Array.from(new Set(col.gameIds))
      .map((id) => gameMap.get(id))
      .filter((g): g is CanonicalGame => !!g);
    const colGames = sortByTitleKey(colUnsorted, (g) => g.title, {
      ignoreLeadingThe: effectiveIgnoreLeadingThe,
      getId: (g) => g.id,
    });

    colGames.forEach((g) => categorizedGameIds.add(g.id));

    return {
      ...col,
      games: colGames,
    };
  });

  const uncategorizedGames = uniqueSortedGames.filter((g) => !categorizedGameIds.has(g.id));

  return {
    collections: colGroups,
    groups: colGroups,
    uncategorized: uncategorizedGames,
    uncategorizedGames,
    allSorted: uniqueSortedGames,
  };
}

export function buildSidebarFlatRows(params: {
  gamesCount: number;
  groupByCollections: boolean;
  groupedData: GroupedSidebarData;
  searchQuery: string;
  collapsedCollections: Record<string, boolean>;
}): SidebarFlatRow[] {
  const { gamesCount, groupByCollections, groupedData, searchQuery, collapsedCollections } = params;
  if (gamesCount === 0) return [];
  const rows: SidebarFlatRow[] = [];
  let gameCounter = 0;

  if (groupByCollections) {
    for (const col of groupedData.collections) {
      if (col.games.length === 0 && searchQuery) continue;
      const isCollapsed = Boolean(collapsedCollections[col.id]);
      rows.push({
        kind: 'header',
        key: `header:${col.id}`,
        groupId: col.id,
        name: col.name,
        icon: col.icon,
        count: col.games.length,
        isCollapsed,
        isUncategorized: false,
      });
      if (!isCollapsed) {
        if (col.games.length === 0) {
          rows.push({
            kind: 'empty',
            key: `empty:${col.id}`,
            groupId: col.id,
          });
        } else {
          for (const g of col.games) {
            rows.push({
              kind: 'game',
              key: `game:${col.id}:${g.id}`,
              game: g,
              gameRowIndex: gameCounter++,
              indented: true,
            });
          }
        }
      }
    }

    if (groupedData.uncategorized.length > 0) {
      const isCollapsed = Boolean(collapsedCollections['uncategorized']);
      rows.push({
        kind: 'header',
        key: 'header:uncategorized',
        groupId: 'uncategorized',
        name: 'Uncategorized',
        count: groupedData.uncategorized.length,
        isCollapsed,
        isUncategorized: true,
      });
      if (!isCollapsed) {
        for (const g of groupedData.uncategorized) {
          rows.push({
            kind: 'game',
            key: `game:uncat:${g.id}`,
            game: g,
            gameRowIndex: gameCounter++,
            indented: true,
          });
        }
      }
    }
  } else {
    for (const g of groupedData.allSorted) {
      rows.push({
        kind: 'game',
        key: `game:flat:${g.id}`,
        game: g,
        gameRowIndex: gameCounter++,
        indented: false,
      });
    }
  }

  return rows;
}
