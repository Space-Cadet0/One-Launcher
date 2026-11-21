import React from 'react';
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Layers,
  LayoutGrid,
  MoreVertical,
  Star,
} from 'lucide-react';
import { CanonicalGame } from '../../../contracts/game';
import { ActiveGameSession } from '../../../contracts/launcher';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../../contracts/platform';
import { launcherService } from '../../../services/launcher/launcherService';
import { isUserActivelyScrolling } from '../../../utils/scrollActivityTracker';
import { CollectionIcon } from '../../Common/CollectionIcon';
import { isCurrentlyFastScrolling } from '../Grid/gridScrollTracker';
import { SidebarFlatRow } from './sidebarGroupingUtils';
import { SidebarRowThumbnail } from './SidebarRowThumbnail';

export interface SidebarRowRenderContext {
  selectedGameId: string | null;
  activeGroupId: string | null;
  isGridView: boolean;
  sidebarClientHeight: number;
  hoveredRowKey: string | null;
  setHoveredRowKey: (key: string) => void;
  connectedSet: Set<StorefrontId>;
  favoriteIdsSet: Set<string>;
  runningSessionByGameId: Map<string, ActiveGameSession>;
  onSelectGame: (game: CanonicalGame) => void;
  onSelectGroupGrid?: (groupId: string | null) => void;
  onOpenManageCollectionsModal: (game?: CanonicalGame) => void;
  onToggleGameInCollection: (collectionId: string, gameId: string) => void;
  toggleCollectionCollapse: (id: string) => void;
}

function renderSidebarHeaderRow(
  row: Extract<SidebarFlatRow, { kind: 'header' }>,
  ctx: SidebarRowRenderContext
): React.ReactElement {
  const isActiveGroup = ctx.isGridView && ctx.activeGroupId === row.groupId;
  return (
    <div
      key={row.key}
      className={`relative px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center justify-between border-t border-b transition-colors group select-none ${
        isActiveGroup
          ? 'bg-[#1e2d3d] text-white border-steam-accent shadow-inner'
          : 'bg-[#141a22] hover:bg-[#1b232e] text-slate-300 hover:text-white border-black/30'
      }`}
    >
      {ctx.onSelectGroupGrid && (
        <button
          type="button"
          onClick={() => ctx.onSelectGroupGrid!(row.groupId)}
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
            ctx.toggleCollectionCollapse(row.groupId);
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
            <ChevronRight aria-hidden="true" className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown aria-hidden="true" className="w-3.5 h-3.5" />
          )}
        </button>

        {row.isUncategorized ? (
          <Layers
            aria-hidden="true"
            className="w-3.5 h-3.5 text-sky-400 flex-shrink-0 pointer-events-none"
          />
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
          <LayoutGrid aria-hidden="true" className="w-3 h-3" />
          Grid
        </span>

        {!row.isUncategorized && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onOpenManageCollectionsModal();
            }}
            aria-label={`Manage ${row.name} collection`}
            className="relative z-10 min-w-6 min-h-6 flex items-center justify-center p-1 text-slate-300 hover:text-white rounded hover:bg-black/40 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            title="Manage Collection"
          >
            <Bookmark aria-hidden="true" className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function renderSidebarGameRow(
  row: Extract<SidebarFlatRow, { kind: 'game' }>,
  ctx: SidebarRowRenderContext
): React.ReactElement {
  const { game, gameRowIndex: currentRowIdx, indented, key: rowKey } = row;
  const isSelected = game.id === ctx.selectedGameId;
  const activeSession = ctx.runningSessionByGameId.get(game.id);
  const isInstalled =
    game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
  const isFav = ctx.favoriteIdsSet.has(game.id);
  const xboxPlat = game.platforms.find((p) => p.platformId === 'xbox');
  const isXboxExpiredUnplayable = Boolean(
    xboxPlat &&
      xboxPlat.installed &&
      xboxPlat.subscriptionExpired &&
      xboxPlat.ownershipType === 'subscription'
  );
  const isXboxActiveGamePass = Boolean(
    xboxPlat &&
      !xboxPlat.subscriptionExpired &&
      (xboxPlat.ownershipType === 'subscription' ||
        xboxPlat.ownershipType === 'owned_and_subscription')
  );
  const isXboxLeavingSoon = Boolean(isXboxActiveGamePass && xboxPlat?.isLeavingSoon);
  const showHoverActions = currentRowIdx <= 28 || ctx.hoveredRowKey === rowKey;

  return (
    <div
      key={rowKey}
      onMouseEnter={() => {
        if (
          currentRowIdx > 28 &&
          ctx.hoveredRowKey !== rowKey &&
          !isCurrentlyFastScrolling() &&
          !isUserActivelyScrolling()
        ) {
          ctx.setHoveredRowKey(rowKey);
        }
      }}
      onFocus={() => {
        if (currentRowIdx > 28 && ctx.hoveredRowKey !== rowKey) {
          ctx.setHoveredRowKey(rowKey);
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
        onClick={() => ctx.onSelectGame(game)}
        aria-current={isSelected ? 'page' : undefined}
        aria-label={game.title}
        className="card-stretched-trigger text-left"
      />

      {/* Small Thumbnail Icon */}
      {ctx.sidebarClientHeight > 0 || currentRowIdx <= 28 ? (
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
              className="px-1 py-0.5 rounded text-[8px] font-bold uppercase tracking-tight bg-rose-950/85 text-rose-200 border border-rose-500/50 flex-shrink-0 whitespace-nowrap"
              title="Game Pass subscription expired"
            >
              Expired
            </span>
          ) : isXboxLeavingSoon ? (
            <span
              className="px-1 py-0.5 rounded text-[8px] font-bold uppercase tracking-tight bg-amber-950/85 text-amber-200 border border-amber-500/50 flex-shrink-0 whitespace-nowrap"
              title="Leaving subscription catalog soon"
            >
              Leaving
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
            game.platforms.every((p) => !ctx.connectedSet.has(p.platformId)) && (
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
              ctx.onToggleGameInCollection('favorites', game.id);
            }}
            aria-label={isFav ? `Remove ${game.title} from Favorites` : `Add ${game.title} to Favorites`}
            className={`min-w-6 min-h-6 flex items-center justify-center p-1 rounded hover:bg-black/40 transition-colors ${
              isFav ? 'text-amber-400 opacity-100' : 'text-slate-300 hover:text-amber-400'
            }`}
            title={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
          >
            <Star aria-hidden="true" className={`w-3 h-3 ${isFav ? 'fill-amber-400' : ''}`} />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              ctx.onOpenManageCollectionsModal(game);
            }}
            aria-label={`Manage collections for ${game.title}`}
            className="min-w-6 min-h-6 flex items-center justify-center p-1 text-slate-300 hover:text-white rounded hover:bg-black/40 transition-colors"
            title="Manage Collections"
          >
            <MoreVertical aria-hidden="true" className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Persistent Favorite Star if active and not hovered */}
      {isFav && (
        <div className="group-hover:hidden group-focus-within:hidden pointer-events-none">
          <Star aria-hidden="true" className="w-2.5 h-2.5 fill-amber-400/80 text-amber-400/80" />
        </div>
      )}
    </div>
  );
}

export function renderSidebarFlatRow(
  row: SidebarFlatRow,
  ctx: SidebarRowRenderContext
): React.ReactElement {
  if (row.kind === 'header') return renderSidebarHeaderRow(row, ctx);
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
  return renderSidebarGameRow(row, ctx);
}
