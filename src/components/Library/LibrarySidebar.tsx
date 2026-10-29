import React, { useState, useMemo, useEffect, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../contracts/platform';
import { GameCollection } from '../../contracts/collection';
import { ActiveGameFilter } from '../../contracts/filter';
import { ActiveGameSession } from '../../contracts/launcher';
import { StorefrontIcon } from '../Common/StorefrontIcon';
import { CollectionIcon } from '../Common/CollectionIcon';
import { VirtualListRows } from '../Common/VirtualContainers';
import { recordScrollActivity, isCurrentlyFastScrolling } from './LibraryGridView';
import { isUserActivelyScrolling } from '../../utils/scrollActivityTracker';
import { useSafeId } from '../../utils/useSafeId';
import {
  Gamepad2,
  CheckCircle2,
  Filter,
  Search,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Star,
  MoreVertical,
  List,
  FolderTree,
  Bookmark,
  LayoutGrid,
  Layers,
  Sliders,
  X,
} from 'lucide-react';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { igdbCoverService, isKnownDeadSteamCover } from '../../services/igdb/igdbCoverService';
import { launcherService } from '../../services/launcher/launcherService';
import { steamApi } from '../../services/steam/steamApi';
import { toOlMediaUrl } from '../../contracts/network';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';

const SIDEBAR_TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });
const COLLAPSED_STORAGE_KEY = 'antigravity_library_collapsed_groups';
const MAX_FAILED_SIDEBAR_ICON_URLS = 2000;
const failedSidebarIconUrls = new Set<string>();

export function markSidebarIconUrlFailed(url?: string | null): void {
  if (!url) return;
  if (failedSidebarIconUrls.size >= MAX_FAILED_SIDEBAR_ICON_URLS) {
    const oldest = failedSidebarIconUrls.values().next().value;
    if (oldest !== undefined) failedSidebarIconUrls.delete(oldest);
  }
  failedSidebarIconUrls.add(url);
}

export function clearFailedSidebarIconUrls(): void {
  failedSidebarIconUrls.clear();
}

const sidebarReconnectSubscribers = new Set<() => void>();
let sidebarOnlineUnsub: (() => void) | null = null;

function subscribeSidebarOnlineReset(cb: () => void): () => void {
  sidebarReconnectSubscribers.add(cb);
  if (!sidebarOnlineUnsub) {
    sidebarOnlineUnsub = onlineLifecycleManager.onOnline(() => {
      clearFailedSidebarIconUrls();
      for (const listener of Array.from(sidebarReconnectSubscribers)) {
        listener();
      }
    });
  }
  return () => {
    sidebarReconnectSubscribers.delete(cb);
    if (sidebarReconnectSubscribers.size === 0 && sidebarOnlineUnsub) {
      sidebarOnlineUnsub();
      sidebarOnlineUnsub = null;
    }
  };
}

function isUnhashedSteamAppAssetUrl(url: string, appId?: number | null): boolean {
  if (!appId) return false;
  if (!url.includes(`/apps/${appId}/`)) return false;
  return !/\/apps\/\d+\/[a-f0-9]{40}\//i.test(url);
}

function toSidebarIconUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.includes('default.png') || trimmed.includes('egs-badge.png')) {
    return null;
  }
  const hasSha1Subdir = /\/apps\/\d+\/[a-f0-9]{40}\//i.test(trimmed);
  let transformed = hasSha1Subdir
    ? trimmed
    : trimmed.replace(/\/library_600x900(?:_2x)?\.jpg(\?.*)?$/i, '/capsule_sm_120.jpg$1');
  transformed = transformed.replace(/\/t_cover_big(?:_2x)?\//i, '/t_thumb/');
  if (/cdn[12]?\.epicgames\.com\//i.test(transformed) && !/[?&][hw]=/i.test(transformed)) {
    transformed = `${transformed}${transformed.includes('?') ? '&' : '?'}h=96&resize=1`;
  }
  return transformed;
}

/**
 * Lightweight sidebar thumbnail relying directly on virtualizer windowing + native
 * `<img loading="lazy" decoding="async">` without per-row IntersectionObservers or `src` blanking.
 */
const SidebarRowThumbnail: React.FC<{ game: CanonicalGame }> = React.memo(({ game }) => {
  const [failedTick, setFailedTick] = useState(0);

  useEffect(() => {
    return subscribeSidebarOnlineReset(() => {
      setFailedTick((t) => t + 1);
    });
  }, []);

  const iconCandidates = useMemo(() => {
    const list: string[] = [];
    const seen = new Set<string>();
    const deadSteam = game.steamAppId ? isKnownDeadSteamCover(game.steamAppId) : false;

    const pushCandidate = (raw?: string | null) => {
      const formatted = toSidebarIconUrl(raw);
      if (!formatted || seen.has(formatted)) return;
      seen.add(formatted);
      list.push(formatted);
    };

    const browseAssets = game.steamAppId
      ? steamApi.getStoreBrowseAssetsInstant(game.steamAppId)
      : null;

    const rawSources = [
      game.iconUrl,
      browseAssets?.iconUrl,
      game.capsuleImage,
      browseAssets?.capsuleImage,
      game.enrichedMetadata?.capsuleImage,
      browseAssets?.headerImage,
      game.enrichedMetadata?.headerImage,
      game.headerImage,
    ];

    for (const src of rawSources) {
      if (!src) continue;
      if (deadSteam && isUnhashedSteamAppAssetUrl(src, game.steamAppId)) {
        continue;
      }
      if (
        /\/apps\/\d+\/[a-f0-9]{40}\//i.test(src) ||
        src.includes('steamcommunity/public/images/apps/')
      ) {
        pushCandidate(src);
      }
    }

    for (const src of rawSources) {
      if (!src) continue;
      if (deadSteam && isUnhashedSteamAppAssetUrl(src, game.steamAppId)) {
        continue;
      }
      pushCandidate(src);
    }

    const igdbInstant = igdbCoverService.getIgdbCoverInstant(
      game.title,
      game.steamAppId,
      game.id
    );
    if (igdbInstant) {
      pushCandidate(igdbInstant);
    }

    if (game.steamAppId && !deadSteam) {
      pushCandidate(
        `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/capsule_sm_120.jpg`
      );
      pushCandidate(
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.steamAppId}/capsule_sm_120.jpg`
      );
      pushCandidate(`https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/header.jpg`);
    }

    return list;
  }, [
    game.id,
    game.title,
    game.steamAppId,
    game.iconUrl,
    game.capsuleImage,
    game.headerImage,
    game.enrichedMetadata?.capsuleImage,
    game.enrichedMetadata?.headerImage,
  ]);

  const gogPlatformGameId =
    game.platforms?.find((p) => p.platformId === 'gog')?.platformGameId || null;
  const epicPlatformGameId =
    game.platforms?.find((p) => p.platformId === 'epic')?.platformGameId || null;

  const rawActiveIconUrl = useMemo(
    () => iconCandidates.find((u) => !failedSidebarIconUrls.has(u)) || null,
    [iconCandidates, failedTick]
  );

  const activeIconUrl = useMemo(() => {
    if (rawActiveIconUrl) {
      const wrapped = toOlMediaUrl({
        url: rawActiveIconUrl,
        gameId: game.id,
        role: 'icon',
        ordinal: 0,
        steamAppId: game.steamAppId || null,
        gogId: gogPlatformGameId,
        epicAppName: epicPlatformGameId,
      });
      if (!failedSidebarIconUrls.has(wrapped)) {
        return wrapped;
      }
    }
    const federatedIcon = toOlMediaUrl({
      url: '',
      gameId: game.id,
      role: 'icon',
      ordinal: 0,
      steamAppId: game.steamAppId || null,
      gogId: gogPlatformGameId,
      epicAppName: epicPlatformGameId,
    });
    if (federatedIcon && !failedSidebarIconUrls.has(federatedIcon)) {
      return federatedIcon;
    }
    return null;
  }, [
    rawActiveIconUrl,
    game.id,
    game.steamAppId,
    gogPlatformGameId,
    epicPlatformGameId,
    failedTick,
  ]);

  return (
    <div className="w-6 h-6 rounded bg-black/60 overflow-hidden flex-shrink-0 border border-steam-border/40 group-hover:border-steam-accent/50 relative pointer-events-none">
      {activeIconUrl ? (
        <img
          src={activeIconUrl}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => {
            markSidebarIconUrlFailed(activeIconUrl);
            if (rawActiveIconUrl) {
              markSidebarIconUrlFailed(rawActiveIconUrl);
            }
            setFailedTick((t) => t + 1);
          }}
        />
      ) : null}
      <div
        className={`w-full h-full ${
          activeIconUrl ? 'hidden' : 'flex'
        } items-center justify-center bg-gradient-to-br from-[#1b2838] to-[#2a475e] text-[10px] font-bold text-steam-accent select-none`}
        aria-hidden="true"
      >
        {game.title.charAt(0).toUpperCase()}
      </div>
    </div>
  );
});

type SidebarFlatRow =
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

interface LibrarySidebarProps {
  games: CanonicalGame[];
  selectedGameId: string | null;
  onSelectGame: (game: CanonicalGame) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedPlatform: StorefrontId | 'all';
  onSelectPlatform: (p: StorefrontId | 'all') => void;
  installedOnly: boolean;
  onToggleInstalledOnly: () => void;
  collections: GameCollection[];
  onOpenManageCollectionsModal: (game?: CanonicalGame) => void;
  onToggleGameInCollection: (collectionId: string, gameId: string) => void;
  onViewAllGamesGrid?: () => void;
  onSelectGroupGrid?: (groupId: string | null) => void;
  activeGroupId?: string | null;
  isGridView?: boolean;
  activeFilter?: ActiveGameFilter | null;
  onClearActiveFilter?: () => void;
  connectedStorefronts?: StorefrontId[];
}

export const LibrarySidebar: React.FC<LibrarySidebarProps> = ({
  games,
  selectedGameId,
  onSelectGame,
  searchQuery,
  onSearchChange,
  selectedPlatform,
  onSelectPlatform,
  installedOnly,
  onToggleInstalledOnly,
  collections,
  onOpenManageCollectionsModal,
  onToggleGameInCollection,
  onViewAllGamesGrid,
  onSelectGroupGrid,
  activeGroupId = null,
  isGridView = false,
  activeFilter,
  onClearActiveFilter,
  connectedStorefronts,
}) => {
  const sidebarSearchInputId = useSafeId('sidebar-title-search');
  const [groupByCollections, setGroupByCollections] = useState(true);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>(() => {
    try {
      const saved =
        typeof localStorage !== 'undefined' ? localStorage.getItem(COLLAPSED_STORAGE_KEY) : null;
      if (saved) {
        return JSON.parse(saved) as Record<string, boolean>;
      }
    } catch (e) {
      console.error('Failed to load collapsed collections state:', e);
    }
    return {};
  });
  const collapsedRef = useRef<Record<string, boolean>>(collapsedCollections);
  collapsedRef.current = collapsedCollections;

  const [isStoresDropdownOpen, setIsStoresDropdownOpen] = useState(false);
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const [launcherTick, setLauncherTick] = useState(0);
  const [sidebarClientHeight, setSidebarClientHeight] = useState(0);
  const storesDropdownRef = useRef<HTMLDivElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const lastLauncherSigRef = useRef<string>('');

  useEffect(() => {
    const scrollEl = sidebarScrollRef.current;
    if (!scrollEl) return;
    const syncHeight = () => {
      const next = scrollEl.clientHeight || 0;
      setSidebarClientHeight((prev) => (prev === next ? prev : next));
    };
    syncHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncHeight);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const computeSig = () => {
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
      return `${runningSig}##${completedSig}`;
    };
    lastLauncherSigRef.current = computeSig();
    const unsub = launcherService.subscribe(() => {
      const nextSig = computeSig();
      if (nextSig !== lastLauncherSigRef.current) {
        lastLauncherSigRef.current = nextSig;
        setLauncherTick((t) => t + 1);
      }
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (storesDropdownRef.current && !storesDropdownRef.current.contains(event.target as Node)) {
        setIsStoresDropdownOpen(false);
      }
    }
    if (isStoresDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isStoresDropdownOpen]);

  const connectedSet = useMemo(() => {
    if (connectedStorefronts && connectedStorefronts.length > 0) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      if (connected.length > 0) {
        return new Set<StorefrontId>(connected);
      }
    } catch {
      // Fallback
    }
    return new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']);
  }, [connectedStorefronts]);

  const platforms: (StorefrontId | 'all')[] = [
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

  const toggleCollectionCollapse = (id: string) => {
    const next = {
      ...collapsedRef.current,
      [id]: !collapsedRef.current[id],
    };
    collapsedRef.current = next;
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.error('Failed to persist collapsed collections state:', e);
    }
    setCollapsedCollections(next);
  };

  // Group games into collections + uncategorized
  const groupedData = useMemo(() => {
    const seenGameIds = new Set<string>();
    const seenPlatformSigs = new Set<string>();
    const uniqueSortedGames = games
      .filter((g) => {
        if (!g || seenGameIds.has(g.id)) return false;
        const platSig = g.platforms
          ?.map((p) => `${p.platformId}:${p.platformGameId}`)
          .sort()
          .join('|');
        if (platSig && seenPlatformSigs.has(platSig)) return false;
        seenGameIds.add(g.id);
        if (platSig) seenPlatformSigs.add(platSig);
        return true;
      })
      .sort((a, b) => SIDEBAR_TITLE_COLLATOR.compare(a.title, b.title));

    const gameMap = new Map<string, CanonicalGame>();
    uniqueSortedGames.forEach((g) => gameMap.set(g.id, g));

    const categorizedGameIds = new Set<string>();

    const colGroups = collections.map((col) => {
      const colGames = Array.from(new Set(col.gameIds))
        .map((id) => gameMap.get(id))
        .filter((g): g is CanonicalGame => !!g)
        .sort((a, b) => SIDEBAR_TITLE_COLLATOR.compare(a.title, b.title));

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
  }, [games, collections]);

  // Single flattened discriminated-union row array for the entire sidebar scroll container
  const flattenedRows = useMemo<SidebarFlatRow[]>(() => {
    if (games.length === 0) return [];
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
  }, [
    games.length,
    groupByCollections,
    groupedData,
    searchQuery,
    collapsedCollections,
  ]);

  const favoriteIdsSet = useMemo(
    () => new Set(collections.find((c) => c.id === 'favorites')?.gameIds || []),
    [collections]
  );

  const runningSessionByGameId = useMemo(() => {
    void launcherTick;
    const map = new Map<string, ActiveGameSession>();
    for (const session of launcherService.getRunningGames()) {
      map.set(session.gameId, session);
    }
    return map;
  }, [launcherTick, games]);

  const renderHeaderRow = (row: Extract<SidebarFlatRow, { kind: 'header' }>) => {
    const isActiveGroup = isGridView && activeGroupId === row.groupId;
    return (
      <div
        key={row.key}
        className={`relative px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center justify-between border-t border-b transition-colors group select-none ${
          isActiveGroup
            ? 'bg-[#1e2d3d] text-white border-steam-accent shadow-inner'
            : 'bg-[#141a22] hover:bg-[#1b232e] text-slate-300 hover:text-white border-black/30'
        }`}
      >
        {onSelectGroupGrid && (
          <button
            type="button"
            onClick={() => onSelectGroupGrid(row.groupId)}
            className="card-stretched-trigger text-left"
            title={`View ${row.name} in Grid View`}
            aria-label={`View ${row.name} in Grid View`}
          />
        )}

        <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleCollectionCollapse(row.groupId);
            }}
            aria-expanded={!row.isCollapsed}
            aria-label={
              row.isCollapsed ? `Expand ${row.name} in sidebar` : `Collapse ${row.name} in sidebar`
            }
            className="relative z-10 min-w-6 min-h-6 flex items-center justify-center p-1 -ml-1 text-steam-accent hover:text-white hover:bg-white/10 rounded transition-colors"
            title={
              row.isCollapsed ? `Expand ${row.name} in sidebar` : `Collapse ${row.name} in sidebar`
            }
          >
            {row.isCollapsed ? (
              <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>

          {row.isUncategorized ? (
            <Layers className="w-3.5 h-3.5 text-sky-400 flex-shrink-0 pointer-events-none" />
          ) : (
            <span className="pointer-events-none flex items-center">
              <CollectionIcon iconId={row.icon} collectionId={row.groupId} size={13} />
            </span>
          )}
          <span className="truncate pointer-events-none">{row.name}</span>
          <span className="text-[10px] text-slate-400 font-normal pointer-events-none">
            ({row.count})
          </span>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[10px] text-steam-accent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity font-normal normal-case flex items-center gap-0.5 mr-0.5 pointer-events-none">
            <LayoutGrid className="w-3 h-3" />
            Grid
          </span>

          {!row.isUncategorized && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenManageCollectionsModal();
              }}
              aria-label={`Manage ${row.name} collection`}
              className="relative z-10 min-w-6 min-h-6 flex items-center justify-center p-1 text-slate-300 hover:text-white rounded hover:bg-black/40 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              title="Manage Collection"
            >
              <Bookmark className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderGameRow = (row: Extract<SidebarFlatRow, { kind: 'game' }>) => {
    const { game, gameRowIndex: currentRowIdx, indented, key: rowKey } = row;
    const isSelected = game.id === selectedGameId;
    const activeSession = runningSessionByGameId.get(game.id);
    const isInstalled =
      game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
    const isFav = favoriteIdsSet.has(game.id);
    const xboxPlat = game.platforms.find((p) => p.platformId === 'xbox');
    const isXboxExpiredUnplayable = Boolean(
      xboxPlat && xboxPlat.subscriptionExpired && xboxPlat.ownershipType === 'subscription'
    );
    const isXboxActiveGamePass = Boolean(
      xboxPlat &&
        !xboxPlat.subscriptionExpired &&
        (xboxPlat.ownershipType === 'subscription' ||
          xboxPlat.ownershipType === 'owned_and_subscription')
    );
    const isXboxLeavingSoon = Boolean(isXboxActiveGamePass && xboxPlat?.isLeavingSoon);
    const showHoverActions = currentRowIdx <= 28 || hoveredRowKey === rowKey;

    return (
      <div
        key={rowKey}
        onMouseEnter={() => {
          if (
            currentRowIdx > 28 &&
            hoveredRowKey !== rowKey &&
            !isCurrentlyFastScrolling() &&
            !isUserActivelyScrolling()
          ) {
            setHoveredRowKey(rowKey);
          }
        }}
        onFocus={() => {
          if (currentRowIdx > 28 && hoveredRowKey !== rowKey) {
            setHoveredRowKey(rowKey);
          }
        }}
        className={`${
          currentRowIdx > 28 ? 'cv-sidebar-row cv-sidebar-row-deferred' : 'cv-sidebar-row'
        } ${
          indented ? 'ml-1 border-b border-steam-border/10' : 'border-b border-steam-border/20'
        } relative px-3 py-1.5 flex items-center gap-2 transition-colors group select-none ${
          isSelected
            ? 'bg-[#223547] text-white border-l-4 border-l-steam-accent shadow-inner'
            : 'text-steam-text hover:bg-[#1a212b] hover:text-white border-l-4 border-l-transparent'
        }`}
      >
        <button
          type="button"
          onClick={() => onSelectGame(game)}
          aria-current={isSelected ? 'page' : undefined}
          aria-label={game.title}
          className="card-stretched-trigger text-left"
        />

        {/* Small Thumbnail Icon */}
        {sidebarClientHeight > 0 || currentRowIdx <= 28 ? (
          <SidebarRowThumbnail game={game} />
        ) : (
          <div
            className="w-6 h-6 rounded bg-black/60 flex-shrink-0 border border-steam-border/40 pointer-events-none"
            aria-hidden="true"
          />
        )}

        {/* Game Title & Badges */}
        <div className="flex-1 min-w-0 flex flex-col justify-center pointer-events-none">
          <div className="flex items-center gap-1.5">
            <span
              className={`text-xs truncate font-medium ${
                isSelected ? 'text-white font-semibold' : 'group-hover:text-white'
              }`}
            >
              {game.title}
            </span>
            {isXboxExpiredUnplayable ? (
              <span
                className="px-1 py-0.2 rounded text-[8px] font-bold uppercase tracking-tight bg-rose-950/80 text-rose-300 border border-rose-500/40 flex-shrink-0"
                title="Game Pass subscription expired"
              >
                Expired
              </span>
            ) : isXboxLeavingSoon ? (
              <span
                className="px-1 py-0.2 rounded text-[8px] font-bold uppercase tracking-tight bg-amber-950/80 text-amber-300 border border-amber-500/40 flex-shrink-0"
                title="Leaving Xbox Game Pass soon"
              >
                Leaving
              </span>
            ) : isXboxActiveGamePass ? (
              <span
                className="px-1 py-0.2 rounded text-[8px] font-bold uppercase tracking-tight bg-emerald-950/80 text-emerald-300 border border-emerald-500/40 flex-shrink-0"
                title="Included with Xbox Game Pass"
              >
                GP
              </span>
            ) : null}
            {activeSession ? (
              activeSession.status === 'starting' ? (
                <span
                  data-testid={`sidebar-session-status-${game.id}`}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-300 flex-shrink-0"
                  title="Starting game..."
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                  <span>Starting</span>
                </span>
              ) : activeSession.status === 'stopping' ? (
                <span
                  data-testid={`sidebar-session-status-${game.id}`}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 flex-shrink-0"
                  title="Stopping & syncing cloud saves..."
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span>Stopping</span>
                </span>
              ) : (
                <span
                  data-testid={`sidebar-session-status-${game.id}`}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300 flex-shrink-0"
                  title="Currently Running"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Running</span>
                </span>
              )
            ) : (
              isInstalled && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"
                  title="Installed Locally"
                />
              )
            )}
            {game.platforms.length > 0 &&
              game.platforms.every((p) => !connectedSet.has(p.platformId)) && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber-400/90 flex-shrink-0"
                  title={`Storefront account not connected (${game.platforms
                    .map((p) => STOREFRONT_REGISTRY[p.platformId]?.name || p.platformId)
                    .join(', ')})`}
                />
              )}
          </div>
        </div>

        {/* Sibling Actions on Hover / Focus-Within */}
        {showHoverActions && (
          <div className="relative z-10 hidden group-hover:flex group-focus-within:flex items-center gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleGameInCollection('favorites', game.id);
              }}
              aria-label={isFav ? `Remove ${game.title} from Favorites` : `Add ${game.title} to Favorites`}
              className={`min-w-6 min-h-6 flex items-center justify-center p-1 rounded hover:bg-black/40 transition-colors ${
                isFav ? 'text-amber-400 opacity-100' : 'text-slate-300 hover:text-amber-400'
              }`}
              title={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
            >
              <Star className={`w-3 h-3 ${isFav ? 'fill-amber-400' : ''}`} />
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenManageCollectionsModal(game);
              }}
              aria-label={`Manage collections for ${game.title}`}
              className="min-w-6 min-h-6 flex items-center justify-center p-1 text-slate-300 hover:text-white rounded hover:bg-black/40 transition-colors"
              title="Manage Collections"
            >
              <MoreVertical className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Persistent Favorite Star if active and not hovered */}
        {isFav && (
          <div className="group-hover:hidden group-focus-within:hidden pointer-events-none">
            <Star className="w-2.5 h-2.5 fill-amber-400/80 text-amber-400/80" />
          </div>
        )}
      </div>
    );
  };

  const renderFlatRow = (row: SidebarFlatRow) => {
    if (row.kind === 'header') return renderHeaderRow(row);
    if (row.kind === 'empty') {
      return (
        <div
          key={row.key}
          className="px-5 py-2 text-[11px] text-slate-300 italic border-b border-steam-border/10"
        >
          No games in this collection.
        </div>
      );
    }
    return renderGameRow(row);
  };

  return useMemo(
    () => (
    <aside className="w-72 md:w-80 h-full bg-[#12161d] border-r border-steam-border flex flex-col flex-shrink-0 select-none">
      {/* Sidebar Header & Search */}
      <div className="p-3 border-b border-steam-border/60 space-y-2.5 bg-[#161a22]">
        {/* Search Input */}
        <div className="relative">
          <label htmlFor={sidebarSearchInputId} className="sr-only">
            Search library by title
          </label>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-steam-subtext pointer-events-none" />
          <input
            id={sidebarSearchInputId}
            type="text"
            aria-label="Search library by title"
            autoComplete="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by title..."
            className="w-full bg-[#10141b] border border-steam-border rounded pl-8 pr-3 py-1.5 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent transition-colors"
          />
        </div>

        {/* Filter Controls Row */}
        <div className="flex items-center justify-between text-xs">
          {/* Storefront Filter Dropdown */}
          <div className="relative" ref={storesDropdownRef}>
            <button
              type="button"
              onClick={() => setIsStoresDropdownOpen((prev) => !prev)}
              className={`min-h-6 flex items-center gap-1.5 text-[11px] px-2 py-1 rounded transition-colors cursor-pointer border select-none ${
                isStoresDropdownOpen
                  ? 'bg-[#1b222d] text-white border-steam-accent/70 shadow-sm'
                  : 'text-steam-subtext hover:text-white hover:bg-steam-card border-transparent'
              }`}
              title="Filter library by storefront"
              aria-haspopup="menu"
              aria-expanded={isStoresDropdownOpen}
            >
              <Filter className="w-3 h-3 text-steam-accent" />
              <span className="capitalize font-medium truncate max-w-[100px]">
                {selectedPlatform === 'all'
                  ? 'All Stores'
                  : STOREFRONT_REGISTRY[selectedPlatform]?.name || selectedPlatform}
              </span>
              <ChevronDown
                className={`w-3 h-3 text-steam-subtext transition-transform duration-200 ${
                  isStoresDropdownOpen ? 'rotate-180 text-white' : ''
                }`}
              />
            </button>

            {isStoresDropdownOpen && (
              <div
                role="menu"
                aria-label="Filter Storefront"
                className="absolute left-0 top-full mt-1 w-48 bg-[#1b222d] border border-steam-border rounded shadow-2xl py-1 z-50 animate-in fade-in-50 duration-100"
              >
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-300 border-b border-steam-border/40 mb-1">
                  Filter Storefront
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {platforms.map((p) => {
                    const isSelected = selectedPlatform === p;
                    const isConnected = p === 'all' || connectedSet.has(p);
                    const name =
                      p === 'all'
                        ? 'All Stores'
                        : STOREFRONT_REGISTRY[p]?.name || p.toUpperCase();
                    return (
                      <button
                        key={p}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => {
                          onSelectPlatform(p);
                          setIsStoresDropdownOpen(false);
                        }}
                        className={`w-full min-h-6 text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-[#253040] transition-colors ${
                          isSelected
                            ? 'text-steam-accent font-bold bg-[#141b24]'
                            : 'text-steam-text'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {p !== 'all' ? (
                            <StorefrontIcon storefrontId={p} className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <Filter className="w-3.5 h-3.5 text-steam-accent opacity-70 shrink-0" />
                          )}
                          <span className="truncate">{name}</span>
                          {!isConnected && (
                            <span className="text-[10px] text-amber-400 font-normal shrink-0">
                              (Not Connected)
                            </span>
                          )}
                        </div>
                        {isSelected && (
                          <span className="w-1.5 h-1.5 rounded-full bg-steam-accent shrink-0 ml-1.5" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Installed toggle button */}
          <button
            type="button"
            aria-pressed={installedOnly}
            onClick={onToggleInstalledOnly}
            className={`min-h-6 px-2 py-0.5 text-[11px] rounded transition-colors flex items-center gap-1 ${
              installedOnly
                ? 'bg-emerald-950/80 text-emerald-400 font-semibold border border-emerald-600/50'
                : 'text-steam-subtext hover:text-white hover:bg-steam-card'
            }`}
            title="Filter by locally installed titles only"
          >
            <CheckCircle2
              className={`w-3 h-3 ${installedOnly ? 'text-emerald-400' : 'text-steam-subtext'}`}
            />
            <span>Ready to Play</span>
          </button>
        </div>

        {/* Active Temporary Filter Chip */}
        {activeFilter && (
          <div className="flex items-center justify-between px-2.5 py-1.5 bg-steam-accent/15 border border-steam-accent/30 rounded text-xs animate-in fade-in duration-150">
            <div className="flex items-center gap-1.5 truncate">
              <Sliders className="w-3 h-3 text-steam-accent flex-shrink-0" />
              <span className="text-steam-accent font-semibold text-[11px] truncate">
                {activeFilter.label}: <span className="text-white">{activeFilter.value}</span>
              </span>
            </div>
            {onClearActiveFilter && (
              <button
                type="button"
                aria-label="Clear active filter"
                onClick={onClearActiveFilter}
                className="min-w-6 min-h-6 flex items-center justify-center p-0.5 hover:bg-white/10 rounded text-steam-accent hover:text-white ml-1.5 transition-colors cursor-pointer"
                title="Clear filter"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Category Section Header & Grouping Controls */}
      <div className="px-3 py-1.5 bg-[#171c24] border-b border-steam-border/40 flex items-center justify-between text-[11px] text-steam-subtext select-none">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setGroupByCollections(!groupByCollections)}
            className={`min-h-6 flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors uppercase tracking-wider font-semibold ${
              groupByCollections
                ? 'text-steam-accent bg-[#1f2d3d]'
                : 'text-steam-subtext hover:text-white'
            }`}
            title={groupByCollections ? 'Switch to Flat List' : 'Switch to Group by Collections'}
          >
            {groupByCollections ? (
              <FolderTree className="w-3 h-3" />
            ) : (
              <List className="w-3 h-3" />
            )}
            <span>
              {groupByCollections ? 'Collections' : 'All Games'} ({games.length})
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenManageCollectionsModal()}
            className="min-h-6 px-1.5 text-steam-subtext hover:text-white flex items-center gap-1 text-[11px] hover:underline"
            title="Create or manage collections"
          >
            <FolderPlus className="w-3 h-3 text-steam-accent" />
            <span className="hidden sm:inline">Groups</span>
          </button>
        </div>
      </div>

      {/* Games List — Single Flattened Virtualizer */}
      <div
        ref={sidebarScrollRef}
        style={{ overflowAnchor: 'none' }}
        onScroll={(e) => recordScrollActivity(e.currentTarget.scrollTop, 'sidebar')}
        className="flex-1 overflow-y-auto py-1.5 px-2"
      >
        {/* Quick Grid View Switcher */}
        {onViewAllGamesGrid && (
          <button
            type="button"
            onClick={onViewAllGamesGrid}
            className={`w-full min-h-6 px-2.5 py-1.5 flex items-center justify-between text-xs font-semibold rounded border transition-all mb-2 ${
              isGridView && !activeGroupId
                ? 'bg-[#223547] text-white border-steam-accent shadow-sm'
                : 'bg-[#161a22] text-steam-text hover:text-white hover:bg-[#1a212b] border-steam-border/60'
            }`}
            title="Switch to full library cover art grid"
          >
            <div className="flex items-center gap-2">
              <LayoutGrid className="w-3.5 h-3.5 text-steam-accent" />
              <span>All Games (Grid)</span>
            </div>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/40 text-steam-subtext border border-white/5 font-mono">
              {games.length}
            </span>
          </button>
        )}

        {games.length === 0 ? (
          <div className="p-6 text-center text-xs text-steam-subtext space-y-2">
            <Gamepad2 className="w-8 h-8 text-steam-subtext/30 mx-auto" />
            <p>No titles found matching criteria.</p>
          </div>
        ) : flattenedRows.length > 60 && sidebarClientHeight > 0 ? (
          <VirtualListRows
            items={flattenedRows}
            scrollElement={sidebarScrollRef.current}
            estimatedItemHeight={34}
            estimateItemSize={(row) => (row.kind === 'header' ? 32 : 34)}
            overscan={10}
            getItemKey={(row) => row.key}
            renderItem={(row) => renderFlatRow(row)}
          />
        ) : (
          <div className="space-y-0.5">{flattenedRows.map((row) => renderFlatRow(row))}</div>
        )}
      </div>
    </aside>
    ),
    [
      games,
      selectedGameId,
      onSelectGame,
      searchQuery,
      onSearchChange,
      selectedPlatform,
      onSelectPlatform,
      installedOnly,
      onToggleInstalledOnly,
      collections,
      onOpenManageCollectionsModal,
      onToggleGameInCollection,
      onViewAllGamesGrid,
      onSelectGroupGrid,
      activeGroupId,
      isGridView,
      activeFilter,
      onClearActiveFilter,
      sidebarSearchInputId,
      groupByCollections,
      collapsedCollections,
      isStoresDropdownOpen,
      hoveredRowKey,
      launcherTick,
      sidebarClientHeight,
      connectedSet,
      groupedData,
      flattenedRows,
      favoriteIdsSet,
      runningSessionByGameId,
    ]
  );
};
