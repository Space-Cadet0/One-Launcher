import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../contracts/platform';
import { GameCollection } from '../../contracts/collection';
import { StorefrontIcon } from '../Common/StorefrontIcon';
import { CollectionIcon } from '../Common/CollectionIcon';
import {
  notifyImageUnmounted,
  recordScrollActivity,
  isCurrentlyFastScrolling,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
} from './LibraryGridView';
import { isUserActivelyScrolling } from '../../utils/scrollActivityTracker';
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

import { ActiveGameFilter } from '../../contracts/filter';
import { ActiveGameSession } from '../../contracts/launcher';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { igdbCoverService, isKnownDeadSteamCover } from '../../services/igdb/igdbCoverService';
import { launcherService } from '../../services/launcher/launcherService';
import { steamApi } from '../../services/steam/steamApi';

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
  if (
    /cdn[12]?\.epicgames\.com\//i.test(transformed) &&
    !/[?&][hw]=/i.test(transformed)
  ) {
    transformed = `${transformed}${transformed.includes('?') ? '&' : '?'}h=96&resize=1`;
  }
  return transformed;
}

const sidebarIconCallbacks = new WeakMap<Element, (isNear: boolean) => void>();
let sharedSidebarIconObserver: IntersectionObserver | null = null;
function getSharedSidebarIconObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!sharedSidebarIconObserver) {
    sharedSidebarIconObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cb = sidebarIconCallbacks.get(entry.target);
          if (cb) cb(entry.isIntersecting);
        }
      },
      { rootMargin: '400px 0px 400px 0px' }
    );
  }
  return sharedSidebarIconObserver;
}

const SidebarRowThumbnail: React.FC<{ game: CanonicalGame; rowIndex: number }> = React.memo(
  ({ game, rowIndex }) => {
    const [isNear, setIsNear] = useState<boolean>(() => rowIndex <= 28);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const imgElementRef = useRef<HTMLImageElement | null>(null);

    const handleImgRef = useCallback((node: HTMLImageElement | null) => {
      const prev = imgElementRef.current;
      if (prev && prev !== node) {
        prev.onload = null;
        prev.onerror = null;
        prev.removeAttribute('src');
        prev.src = '';
        notifyImageUnmounted();
      }
      imgElementRef.current = node;
    }, []);

    useEffect(() => {
      if (typeof IntersectionObserver === 'undefined') {
        setIsNear(true);
        return;
      }
      const el = containerRef.current;
      const observer = getSharedSidebarIconObserver();
      if (!el || !observer) {
        setIsNear(true);
        return;
      }
      let enterTimer: ReturnType<typeof setTimeout> | null = null;
      const mountNow = () => {
        setIsNear(true);
      };
      sidebarIconCallbacks.set(el, (near) => {
        if (enterTimer) {
          clearTimeout(enterTimer);
          enterTimer = null;
        }
        removePendingFastScrollMount(mountNow);
        if (near) {
          if (isCurrentlyFastScrolling()) {
            addPendingFastScrollMount(mountNow);
          } else {
            enterTimer = setTimeout(() => {
              enterTimer = null;
              if (isCurrentlyFastScrolling()) {
                addPendingFastScrollMount(mountNow);
              } else {
                setIsNear(true);
              }
            }, 16);
          }
        } else {
          setIsNear(false);
        }
      });
      observer.observe(el);
      return () => {
        if (enterTimer) {
          clearTimeout(enterTimer);
        }
        removePendingFastScrollMount(mountNow);
        sidebarIconCallbacks.delete(el);
        observer.unobserve(el);
      };
    }, []);

    const [failedTick, setFailedTick] = useState(0);

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

      // 1. Prefer Steam community icons, hashed Steam store assets, or non-Steam icons first
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

      // 2. Standard game icon / capsule / header candidates (skipping known dead unhashed Steam URLs)
      for (const src of rawSources) {
        if (!src) continue;
        if (deadSteam && isUnhashedSteamAppAssetUrl(src, game.steamAppId)) {
          continue;
        }
        pushCandidate(src);
      }

      // 3. Instant IGDB cover thumbnail
      const igdbInstant = igdbCoverService.getIgdbCoverInstant(
        game.title,
        game.steamAppId,
        game.id
      );
      if (igdbInstant) {
        pushCandidate(igdbInstant);
      }

      // 4. Standard Steam small capsule / header fallbacks (only if not marked dead unhashed Steam CDN)
      if (game.steamAppId && !deadSteam) {
        pushCandidate(
          `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/capsule_sm_120.jpg`
        );
        pushCandidate(
          `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.steamAppId}/capsule_sm_120.jpg`
        );
        pushCandidate(
          `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/header.jpg`
        );
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

    const activeIconUrl = useMemo(
      () => iconCandidates.find((u) => !failedSidebarIconUrls.has(u)) || null,
      [iconCandidates, failedTick]
    );

    return (
      <div
        ref={containerRef}
        className="w-6 h-6 rounded bg-black/60 overflow-hidden flex-shrink-0 border border-steam-border/40 group-hover:border-steam-accent/50 relative"
      >
        {isNear && activeIconUrl ? (
          <img
            ref={handleImgRef}
            src={activeIconUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            decoding="async"
            onError={() => {
              markSidebarIconUrlFailed(activeIconUrl);
              setFailedTick((t) => t + 1);
            }}
          />
        ) : null}
        <div
          className={`w-full h-full ${
            isNear && activeIconUrl ? 'hidden' : 'flex'
          } items-center justify-center bg-gradient-to-br from-[#1b2838] to-[#2a475e] text-[10px] font-bold text-steam-accent select-none`}
          aria-hidden="true"
        >
          {game.title.charAt(0).toUpperCase()}
        </div>
      </div>
    );
  }
);

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
  const [groupByCollections, setGroupByCollections] = useState(true);
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>(() => {
    try {
      const saved =
        typeof localStorage !== 'undefined' ? localStorage.getItem(COLLAPSED_STORAGE_KEY) : null;
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load collapsed collections state:', e);
    }
    return {};
  });

  const [isStoresDropdownOpen, setIsStoresDropdownOpen] = useState(false);
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const [, setLauncherTick] = useState(0);
  const storesDropdownRef = useRef<HTMLDivElement>(null);
  const lastLauncherSigRef = useRef<string>('');

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
    return new Set<StorefrontId>(['steam', 'gog', 'epic']);
  }, [connectedStorefronts]);

  const platforms: (StorefrontId | 'all')[] = [
    'all',
    'steam',
    'gog',
    'epic',
    'amazon',
    'xbox',
    'ubisoft',
    'ea',
    'bnet',
    'itch',
  ];

  const toggleCollectionCollapse = (id: string) => {
    setCollapsedCollections((prev) => {
      const next = {
        ...prev,
        [id]: !prev[id],
      };
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error('Failed to persist collapsed collections state:', e);
      }
      return next;
    });
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
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

    const gameMap = new Map<string, CanonicalGame>();
    uniqueSortedGames.forEach((g) => gameMap.set(g.id, g));

    const categorizedGameIds = new Set<string>();

    const colGroups = collections.map((col) => {
      const colGames = Array.from(new Set(col.gameIds))
        .map((id) => gameMap.get(id))
        .filter((g): g is CanonicalGame => !!g)
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

      colGames.forEach((g) => categorizedGameIds.add(g.id));

      return {
        ...col,
        games: colGames,
      };
    });

    // Uncategorized: games in the filtered list not in any collection (already sorted alphabetically)
    const uncategorizedGames = uniqueSortedGames.filter((g) => !categorizedGameIds.has(g.id));

    return {
      collections: colGroups,
      groups: colGroups,
      uncategorized: uncategorizedGames,
      uncategorizedGames,
      allSorted: uniqueSortedGames,
    };
  }, [games, collections]);

  const favoriteIdsSet = useMemo(
    () => new Set(collections.find((c) => c.id === 'favorites')?.gameIds || []),
    [collections]
  );

  const runningSessionByGameId = new Map<string, ActiveGameSession>();
  for (const session of launcherService.getRunningGames()) {
    runningSessionByGameId.set(session.gameId, session);
  }

  let sidebarRenderedRowIdx = 0;

  const renderGameRow = (game: CanonicalGame, idx?: number) => {
    const currentRowIdx = sidebarRenderedRowIdx++;
    const isSelected = game.id === selectedGameId;
    const activeSession = runningSessionByGameId.get(game.id);
    const isInstalled =
      game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
    const isFav = favoriteIdsSet.has(game.id);
    const platformSig =
      game.platforms?.map((p) => `${p.platformId}:${p.platformGameId}`).join('|') || '';
    const rowKey = `${game.id}::${platformSig || idx || 0}`;
    const showHoverActions = currentRowIdx <= 28 || hoveredRowKey === rowKey;

    return (
      <div
        key={rowKey}
        onClick={() => onSelectGame(game)}
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
        onMouseMove={() => {
          if (
            currentRowIdx > 28 &&
            hoveredRowKey !== rowKey &&
            !isCurrentlyFastScrolling() &&
            !isUserActivelyScrolling()
          ) {
            setHoveredRowKey(rowKey);
          }
        }}
        className={`${currentRowIdx > 28 ? 'cv-sidebar-row cv-sidebar-row-deferred' : 'cv-sidebar-row'} relative px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors group select-none ${
          isSelected
            ? 'bg-[#223547] text-white border-l-4 border-steam-accent shadow-inner'
            : 'text-steam-text hover:bg-[#1a212b] hover:text-white border-l-4 border-transparent'
        }`}
      >
        {/* Small Thumbnail Icon */}
        <SidebarRowThumbnail game={game} rowIndex={currentRowIdx} />

        {/* Game Title & Badges */}
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="flex items-center gap-1.5">
            <span
              className={`text-xs truncate font-medium ${
                isSelected ? 'text-white font-semibold' : 'group-hover:text-white'
              }`}
            >
              {game.title}
            </span>
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
            {game.platforms.length > 0 && game.platforms.every((p) => !connectedSet.has(p.platformId)) && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400/90 flex-shrink-0"
                title={`Storefront account not connected (${game.platforms.map((p) => STOREFRONT_REGISTRY[p.platformId]?.name || p.platformId).join(', ')})`}
              />
            )}
          </div>
        </div>

        {/* Actions on Hover */}
        {showHoverActions && (
          <div className="hidden group-hover:flex items-center gap-1">
            {/* Favorite Star Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleGameInCollection('favorites', game.id);
              }}
              className={`p-1 rounded hover:bg-black/40 transition-colors ${
                isFav ? 'text-amber-400 opacity-100' : 'text-steam-subtext hover:text-amber-400'
              }`}
              title={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
            >
              <Star className={`w-3 h-3 ${isFav ? 'fill-amber-400' : ''}`} />
            </button>

            {/* Manage Collections Menu Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenManageCollectionsModal(game);
              }}
              className="p-1 text-steam-subtext hover:text-white rounded hover:bg-black/40 transition-colors"
              title="Manage Collections"
            >
              <MoreVertical className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Persistent Favorite Star if active and not hovered */}
        {isFav && (
          <div className="group-hover:hidden">
            <Star className="w-2.5 h-2.5 fill-amber-400/80 text-amber-400/80" />
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="w-72 md:w-80 h-full bg-[#12161d] border-r border-steam-border flex flex-col flex-shrink-0 select-none">
      {/* Sidebar Header & Search */}
      <div className="p-3 border-b border-steam-border/60 space-y-2.5 bg-[#161a22]">
        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-steam-subtext pointer-events-none" />
          <input
            type="text"
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
              className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded transition-colors cursor-pointer border select-none ${
                isStoresDropdownOpen
                  ? 'bg-[#1b222d] text-white border-steam-accent/70 shadow-sm'
                  : 'text-steam-subtext hover:text-white hover:bg-steam-card border-transparent'
              }`}
              title="Filter library by storefront"
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

            {/* Dropdown Menu */}
            {isStoresDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 w-48 bg-[#1b222d] border border-steam-border rounded shadow-2xl py-1 z-50 animate-in fade-in-50 duration-100">
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-steam-subtext border-b border-steam-border/40 mb-1">
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
                        onClick={() => {
                          onSelectPlatform(p);
                          setIsStoresDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-[#253040] transition-colors ${
                          isSelected ? 'text-steam-accent font-bold bg-[#141b24]' : 'text-steam-text'
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
                        {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-steam-accent shrink-0 ml-1.5" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Installed toggle button */}
          <button
            onClick={onToggleInstalledOnly}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors flex items-center gap-1 ${
              installedOnly
                ? 'bg-emerald-950/80 text-emerald-400 font-semibold border border-emerald-600/50'
                : 'text-steam-subtext hover:text-white hover:bg-steam-card'
            }`}
            title="Filter by locally installed titles only"
          >
            <CheckCircle2 className={`w-3 h-3 ${installedOnly ? 'text-emerald-400' : 'text-steam-subtext'}`} />
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
                onClick={onClearActiveFilter}
                className="p-0.5 hover:bg-white/10 rounded text-steam-accent hover:text-white ml-1.5 transition-colors cursor-pointer"
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
        {/* View Mode Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupByCollections(!groupByCollections)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors uppercase tracking-wider font-semibold ${
              groupByCollections
                ? 'text-steam-accent bg-[#1f2d3d]'
                : 'text-steam-subtext hover:text-white'
            }`}
            title={groupByCollections ? 'Switch to Flat List' : 'Switch to Group by Collections'}
          >
            {groupByCollections ? <FolderTree className="w-3 h-3" /> : <List className="w-3 h-3" />}
            <span>{groupByCollections ? 'Collections' : 'All Games'} ({games.length})</span>
          </button>
        </div>

        {/* Action Buttons: Add Collection & Add Game */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenManageCollectionsModal()}
            className="text-steam-subtext hover:text-white flex items-center gap-1 text-[11px] hover:underline"
            title="Create or manage collections"
          >
            <FolderPlus className="w-3 h-3 text-steam-accent" />
            <span className="hidden sm:inline">Groups</span>
          </button>
        </div>
      </div>

      {/* Games List (Grouped or Flat) */}
      <div
        style={{ overflowAnchor: 'none' }}
        onScroll={(e) => recordScrollActivity(e.currentTarget.scrollTop, 'sidebar')}
        className="flex-1 overflow-y-auto py-1.5 px-2"
      >
        {/* Quick Grid View Switcher */}
        {onViewAllGamesGrid && (
          <button
            onClick={onViewAllGamesGrid}
            className={`w-full px-2.5 py-1.5 flex items-center justify-between text-xs font-semibold rounded border transition-all mb-2 ${
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
        ) : groupByCollections ? (
          /* Grouped by Collections Mode */
          <div className="space-y-1">
            {/* User Collections */}
            {groupedData.collections.map((col) => {
              if (col.games.length === 0 && searchQuery) return null; // hide empty collections during search
              const isCollapsed = !!collapsedCollections[col.id];

              return (
                <div key={col.id} className="mb-0.5">
                  {/* Collection Header */}
                  <div
                    onClick={() => {
                      if (onSelectGroupGrid) {
                        onSelectGroupGrid(col.id);
                      }
                    }}
                    className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center justify-between cursor-pointer border-t border-b transition-colors group select-none ${
                      isGridView && activeGroupId === col.id
                        ? 'bg-[#1e2d3d] text-white border-steam-accent shadow-inner'
                        : 'bg-[#141a22] hover:bg-[#1b232e] text-steam-subtext hover:text-white border-black/30'
                    }`}
                    title={`View ${col.name} in Grid View`}
                  >
                    <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
                      {/* Chevron Button with its own click handler for expand/collapse */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollectionCollapse(col.id);
                        }}
                        className="p-1 -ml-1 text-steam-accent hover:text-white hover:bg-white/10 rounded transition-colors"
                        title={isCollapsed ? `Expand ${col.name} in sidebar` : `Collapse ${col.name} in sidebar`}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>

                      <CollectionIcon iconId={col.icon} collectionId={col.id} size={13} />
                      <span className="truncate">{col.name}</span>
                      <span className="text-[10px] text-[#677788] font-normal">({col.games.length})</span>
                    </div>

                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-steam-accent opacity-0 group-hover:opacity-100 transition-opacity font-normal normal-case flex items-center gap-0.5 mr-0.5">
                        <LayoutGrid className="w-3 h-3" />
                        Grid
                      </span>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenManageCollectionsModal();
                        }}
                        className="p-1 text-[#556772] hover:text-white rounded hover:bg-black/40 transition-colors opacity-0 group-hover:opacity-100"
                        title="Manage Collection"
                      >
                        <Bookmark className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>

                  {/* Collection Games */}
                  {!isCollapsed && (
                    <div className="divide-y divide-steam-border/10 pl-1">
                      {col.games.length === 0 ? (
                        <div className="px-5 py-2 text-[11px] text-steam-subtext italic">
                          No games in this collection.
                        </div>
                      ) : (
                        col.games.map((g, i) => renderGameRow(g, i))
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Uncategorized Collection */}
            {groupedData.uncategorized.length > 0 && (
              <div key="uncategorized" className="mb-0.5">
                <div
                  onClick={() => {
                    if (onSelectGroupGrid) {
                      onSelectGroupGrid('uncategorized');
                    }
                  }}
                  className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center justify-between cursor-pointer border-t border-b transition-colors group select-none ${
                    isGridView && activeGroupId === 'uncategorized'
                      ? 'bg-[#1e2d3d] text-white border-steam-accent shadow-inner'
                      : 'bg-[#141a22] hover:bg-[#1b232e] text-steam-subtext hover:text-white border-black/30'
                  }`}
                  title="View Uncategorized in Grid View"
                >
                  <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollectionCollapse('uncategorized');
                      }}
                      className="p-1 -ml-1 text-steam-accent hover:text-white hover:bg-white/10 rounded transition-colors"
                      title={
                        collapsedCollections['uncategorized']
                          ? 'Expand Uncategorized in sidebar'
                          : 'Collapse Uncategorized in sidebar'
                      }
                    >
                      {collapsedCollections['uncategorized'] ? (
                        <ChevronRight className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <Layers className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                    <span className="truncate">Uncategorized</span>
                    <span className="text-[10px] text-[#677788] font-normal">
                      ({groupedData.uncategorized.length})
                    </span>
                  </div>

                  <span className="text-[10px] text-steam-accent opacity-0 group-hover:opacity-100 transition-opacity font-normal normal-case flex items-center gap-0.5 mr-0.5">
                    <LayoutGrid className="w-3 h-3" />
                    Grid
                  </span>
                </div>

                {!collapsedCollections['uncategorized'] && (
                  <div className="divide-y divide-steam-border/10 pl-1">
                    {groupedData.uncategorized.map((g, i) => renderGameRow(g, i))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Flat Alphabetical Mode */
          <div className="divide-y divide-steam-border/20">
            {groupedData.allSorted.map((g, i) => renderGameRow(g, i))}
          </div>
        )}
      </div>
    </aside>
  );
};
