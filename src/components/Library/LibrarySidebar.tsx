import React, { useState, useMemo, useEffect, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import { GameCollection } from '../../contracts/collection';
import { ActiveGameFilter } from '../../contracts/filter';
import { ActiveGameSession } from '../../contracts/launcher';
import { VirtualListRows } from '../Common/VirtualContainers';
import { recordScrollActivity } from './LibraryGridView';
import { useSafeId } from '../../utils/useSafeId';
import { isImeComposing } from '../../utils/keyboardUtils';
import {
  Gamepad2,
  CheckCircle2,
  Search,
  FolderPlus,
  List,
  FolderTree,
  LayoutGrid,
  Sliders,
  X,
} from 'lucide-react';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { launcherService } from '../../services/launcher/launcherService';
import {
  clearFailedSidebarIconUrls,
  markSidebarIconUrlFailed,
} from '../../services/media/failedMediaUrlRegistry';
import {
  buildSidebarFlatRows,
  computeSidebarLauncherSignature,
  groupSidebarGames,
} from './Sidebar/sidebarGroupingUtils';
import { renderSidebarFlatRow, SidebarRowRenderContext } from './Sidebar/SidebarRows';
import { renderSidebarStorefrontDropdown } from './Sidebar/SidebarStorefrontDropdown';

export { clearFailedSidebarIconUrls, markSidebarIconUrlFailed };

const COLLAPSED_STORAGE_KEY = 'antigravity_library_collapsed_groups';

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
  ignoreLeadingTheWhenSorting?: boolean;
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
  ignoreLeadingTheWhenSorting,
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
  const storesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const storesMenuRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const lastLauncherSigRef = useRef<string>('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const focusStoreMenuItem = (target: 'first' | 'last') => {
    const run = () => {
      const menuEl = storesMenuRef.current;
      if (!menuEl) return;
      const items = Array.from(
        menuEl.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')
      );
      if (items.length === 0) return;
      const item = target === 'first' ? items[0] : items[items.length - 1];
      item?.focus({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  };

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
    lastLauncherSigRef.current = computeSidebarLauncherSignature();
    const unsub = launcherService.subscribe(() => {
      const nextSig = computeSidebarLauncherSignature();
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
    if (connectedStorefronts !== undefined) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      return new Set<StorefrontId>(connected);
    } catch {
      // Fallback
    }
    return new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']);
  }, [connectedStorefronts]);

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

  const effectiveIgnoreLeadingThe =
    ignoreLeadingTheWhenSorting ??
    (launcherService.getPerformanceSettings?.()?.ignoreLeadingTheWhenSorting ?? true);

  const groupedData = useMemo(
    () => groupSidebarGames(games, collections, effectiveIgnoreLeadingThe),
    [games, collections, effectiveIgnoreLeadingThe]
  );

  const flattenedRows = useMemo(
    () =>
      buildSidebarFlatRows({
        gamesCount: games.length,
        groupByCollections,
        groupedData,
        searchQuery,
        collapsedCollections,
      }),
    [games.length, groupByCollections, groupedData, searchQuery, collapsedCollections]
  );

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
  }, [launcherTick]);

  const rowRenderCtx: SidebarRowRenderContext = {
    selectedGameId,
    activeGroupId,
    isGridView,
    sidebarClientHeight,
    hoveredRowKey,
    setHoveredRowKey,
    connectedSet,
    favoriteIdsSet,
    runningSessionByGameId,
    onSelectGame,
    onSelectGroupGrid,
    onOpenManageCollectionsModal,
    onToggleGameInCollection,
    toggleCollectionCollapse,
  };

  return useMemo(
    () => (
    <aside className="w-72 md:w-80 h-full bg-[#12161d] border-r border-steam-border flex flex-col flex-shrink-0 select-none">
      {/* Sidebar Header & Search */}
      <div className="p-3 border-b border-steam-border/60 space-y-2.5 bg-[#161a22]">
        {/* Search Input */}
        <search aria-label="Filter library" className="relative block">
          <label htmlFor={sidebarSearchInputId} className="sr-only">
            Search library by title
          </label>
          <Search
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-steam-subtext pointer-events-none"
          />
          <input
            ref={searchInputRef}
            id={sidebarSearchInputId}
            type="text"
            aria-label="Search library by title"
            autoComplete="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && searchQuery && !isImeComposing(e)) {
                e.preventDefault();
                e.stopPropagation();
                onSearchChange('');
              }
            }}
            placeholder="Search by title..."
            className={`w-full bg-[#10141b] border border-steam-border rounded pl-8 ${
              searchQuery ? 'pr-8' : 'pr-3'
            } py-1.5 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent/60 transition-colors`}
          />
          {searchQuery && (
            <button
              type="button"
              data-testid="sidebar-search-clear-btn"
              aria-label="Clear search"
              title="Clear search (Escape)"
              onClick={() => {
                onSearchChange('');
                searchInputRef.current?.focus?.({ preventScroll: true });
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 min-w-6 min-h-6 flex items-center justify-center rounded text-steam-subtext hover:text-white hover:bg-white/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent/70"
            >
              <X aria-hidden="true" className="w-3.5 h-3.5" />
            </button>
          )}
        </search>

        {/* Filter Controls Row */}
        <div className="flex items-center justify-between text-xs">
          {renderSidebarStorefrontDropdown({
            storesDropdownRef,
            storesTriggerRef,
            storesMenuRef,
            isStoresDropdownOpen,
            setIsStoresDropdownOpen,
            selectedPlatform,
            onSelectPlatform,
            connectedSet,
            focusStoreMenuItem,
          })}

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
              aria-hidden="true"
              className={`w-3 h-3 ${installedOnly ? 'text-emerald-400' : 'text-steam-subtext'}`}
            />
            <span>Ready to Play</span>
          </button>
        </div>

        {/* Active Temporary Filter Chip */}
        {activeFilter && (
          <div className="flex items-center justify-between px-2.5 py-1.5 bg-steam-accent/15 border border-steam-accent/30 rounded text-xs">
            <div className="flex items-center gap-1.5 truncate">
              <Sliders aria-hidden="true" className="w-3 h-3 text-steam-accent flex-shrink-0" />
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
                <X aria-hidden="true" className="w-3.5 h-3.5" />
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
              <FolderTree aria-hidden="true" className="w-3 h-3" />
            ) : (
              <List aria-hidden="true" className="w-3 h-3" />
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
            <FolderPlus aria-hidden="true" className="w-3 h-3 text-steam-accent" />
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
              <LayoutGrid aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
              <span>All Games (Grid)</span>
            </div>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/40 text-steam-subtext border border-white/5 font-mono">
              {games.length}
            </span>
          </button>
        )}

        {games.length === 0 ? (
          <div className="p-6 text-center text-xs text-steam-subtext space-y-2">
            <Gamepad2 aria-hidden="true" className="w-8 h-8 text-steam-subtext/30 mx-auto" />
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
            renderItem={(row) => renderSidebarFlatRow(row, rowRenderCtx)}
          />
        ) : (
          <div className="space-y-0.5">
            {flattenedRows.map((row) => renderSidebarFlatRow(row, rowRenderCtx))}
          </div>
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
