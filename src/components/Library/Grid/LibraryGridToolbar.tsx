import React from 'react';
import {
  ArrowLeft,
  Award,
  Calendar,
  Gamepad2,
  Sliders,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  ActiveGameFilter,
  LibraryFilterState,
} from '../../../contracts/filter';
import {
  ActiveFilterChip,
  LibraryFilterIndex,
} from '../../../services/filter/libraryFilterIndex';
import { LibraryFilterPanel } from '../LibraryFilterPanel';
import {
  GRID_RELEASE_YEAR_ORDER_STORAGE_KEY,
  GridSortOption,
} from './gridCoverUtils';

export interface RenderLibraryGridToolbarArgs {
  title?: string;
  subtitle?: string;
  groupIcon?: React.ReactNode;
  sortedCount: number;
  unfilteredTotalCount: number;
  activeFilter?: ActiveGameFilter | null;
  onClearActiveFilter?: () => void;
  onClearGroupFilter?: () => void;
  activeCriteriaCount: number;
  activeFilterChips: ActiveFilterChip[];
  isFilterPanelOpen: boolean;
  onToggleFilterPanel: () => void;
  onCloseFilterPanel: () => void;
  effectiveFilterState: LibraryFilterState;
  effectiveFilterIndex: LibraryFilterIndex;
  onUpdateFilterState: (next: LibraryFilterState) => void;
  onResetFilterState: () => void;
  sortBy: GridSortOption;
  onSortChange: (sort: GridSortOption) => void;
  releaseYearOrder: 'desc' | 'asc';
  onChangeReleaseYearOrder: (next: 'desc' | 'asc') => void;
}

export function renderLibraryGridToolbar({
  title,
  subtitle,
  groupIcon,
  sortedCount,
  unfilteredTotalCount,
  activeFilter,
  onClearActiveFilter,
  onClearGroupFilter,
  activeCriteriaCount,
  activeFilterChips,
  isFilterPanelOpen,
  onToggleFilterPanel,
  onCloseFilterPanel,
  effectiveFilterState,
  effectiveFilterIndex,
  onUpdateFilterState,
  onResetFilterState,
  sortBy,
  onSortChange,
  releaseYearOrder,
  onChangeReleaseYearOrder,
}: RenderLibraryGridToolbarArgs): React.ReactElement {
  return (
    <>
      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border-b border-steam-border/60 pb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2.5 rounded bg-steam-accent/15 border border-steam-accent/30 text-steam-accent shadow-sm flex items-center justify-center shrink-0">
            {groupIcon || <Gamepad2 aria-hidden="true" className="w-6 h-6" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold text-white tracking-wide flex items-center gap-2">
                {title || 'All Games'}
                <span className="text-xs px-2 py-0.5 rounded-full bg-[#1b2838] border border-steam-border text-steam-accent font-semibold shrink-0">
                  {sortedCount}
                </span>
              </h1>
              {activeFilter && activeFilterChips.length === 0 && (
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-steam-accent/20 border border-steam-accent/40 text-steam-accent text-xs shrink-0">
                  <Sliders aria-hidden="true" className="w-3 h-3" />
                  <span>
                    Filter: <strong className="text-white">{activeFilter.label}</strong>:{' '}
                    {activeFilter.value}
                  </span>
                  {onClearActiveFilter && (
                    <button
                      type="button"
                      onClick={onClearActiveFilter}
                      aria-label="Clear filter"
                      className="min-w-6 min-h-6 inline-flex items-center justify-center rounded-full hover:bg-white/10 text-steam-accent hover:text-white transition-colors cursor-pointer"
                      title="Clear filter"
                    >
                      <X aria-hidden="true" className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
              {onClearGroupFilter && !activeFilter && activeCriteriaCount === 0 && (
                <button
                  type="button"
                  onClick={onClearGroupFilter}
                  className="min-h-6 inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-semibold text-steam-accent hover:text-white bg-[#16202d] hover:bg-[#202f42] border border-steam-border rounded transition-colors group cursor-pointer shrink-0"
                  title="Return to All Games library grid"
                >
                  <ArrowLeft
                    aria-hidden="true"
                    className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform"
                  />
                  <span>All Games</span>
                </button>
              )}
            </div>
            <p className="text-xs text-steam-subtext mt-0.5">
              {subtitle ||
                'Browse your universal game collection across all connected storefronts'}
            </p>
          </div>
        </div>

        {/* Filter & Sort Controls */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs shrink-0 self-end lg:self-center">
          <button
            type="button"
            data-testid="library-filter-toggle-btn"
            onClick={onToggleFilterPanel}
            aria-expanded={isFilterPanelOpen}
            className={`min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-semibold transition-all cursor-pointer shrink-0 ${
              isFilterPanelOpen || activeCriteriaCount > 0
                ? 'bg-steam-accent/20 border-steam-accent text-white shadow-sm'
                : 'bg-[#16202d] border-steam-border text-steam-text hover:text-white hover:border-steam-accent/60'
            }`}
            title="Open 6-category library filter panel"
          >
            <SlidersHorizontal aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
            <span>Filter</span>
            {activeCriteriaCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-steam-accent text-black text-[10px] font-bold">
                {activeCriteriaCount}
              </span>
            )}
          </button>

          <span className="text-steam-subtext font-medium whitespace-nowrap">Sort by:</span>
          <div className="flex items-center rounded border border-steam-border bg-[#16202d] p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => onSortChange('alphabetical')}
              aria-pressed={sortBy === 'alphabetical'}
              className={`min-h-6 px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                sortBy === 'alphabetical'
                  ? 'bg-steam-accent text-black shadow-sm'
                  : 'text-steam-text hover:text-white'
              }`}
            >
              Alphabetical
            </button>
            <button
              type="button"
              onClick={() => onSortChange('rating')}
              aria-pressed={sortBy === 'rating'}
              className={`min-h-6 px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-1.5 cursor-pointer ${
                sortBy === 'rating'
                  ? 'bg-steam-accent text-black shadow-sm'
                  : 'text-steam-text hover:text-white'
              }`}
              title="Sort by Review Score (highest score first)"
            >
              <Award aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Rating</span>
            </button>
            <button
              type="button"
              onClick={() => onSortChange('playtime')}
              aria-pressed={sortBy === 'playtime'}
              className={`min-h-6 px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                sortBy === 'playtime'
                  ? 'bg-steam-accent text-black shadow-sm'
                  : 'text-steam-text hover:text-white'
              }`}
            >
              Play Time
            </button>
            <button
              type="button"
              onClick={() => onSortChange('recent')}
              aria-pressed={sortBy === 'recent'}
              className={`min-h-6 px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                sortBy === 'recent'
                  ? 'bg-steam-accent text-black shadow-sm'
                  : 'text-steam-text hover:text-white'
              }`}
            >
              Recently Played
            </button>
            <button
              type="button"
              data-testid="grid-sort-release-year"
              aria-pressed={sortBy === 'release_year'}
              onClick={() => {
                if (sortBy !== 'release_year') {
                  onSortChange('release_year');
                } else {
                  const nextOrder = releaseYearOrder === 'desc' ? 'asc' : 'desc';
                  onChangeReleaseYearOrder(nextOrder);
                  try {
                    if (typeof window !== 'undefined' && window.localStorage) {
                      window.localStorage.setItem(
                        GRID_RELEASE_YEAR_ORDER_STORAGE_KEY,
                        nextOrder
                      );
                    }
                  } catch {
                    // ignore storage errors
                  }
                }
              }}
              className={`min-h-6 px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-1.5 cursor-pointer ${
                sortBy === 'release_year'
                  ? 'bg-steam-accent text-black shadow-sm'
                  : 'text-steam-text hover:text-white'
              }`}
              title={
                sortBy === 'release_year'
                  ? releaseYearOrder === 'desc'
                    ? 'Sorted by Release Year: Newest First (Click for Oldest First)'
                    : 'Sorted by Release Year: Oldest First (Click for Newest First)'
                  : 'Sort by Release Year'
              }
            >
              <Calendar aria-hidden="true" className="w-3.5 h-3.5" />
              <span>
                Release Year
                {sortBy === 'release_year' ? (releaseYearOrder === 'desc' ? ' ↓' : ' ↑') : ''}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Collapsible 6-Category Filter Panel */}
      {isFilterPanelOpen && (
        <LibraryFilterPanel
          filterState={effectiveFilterState}
          onChange={onUpdateFilterState}
          onReset={onResetFilterState}
          filterIndex={effectiveFilterIndex}
          filteredCount={sortedCount}
          totalCount={unfilteredTotalCount}
          onClose={onCloseFilterPanel}
        />
      )}

      {/* Active Filter Chips Bar */}
      {(activeFilterChips.length > 0 || activeFilter) && (
        <div
          data-testid="active-filter-chips-bar"
          className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-md bg-[#141d29] border border-steam-border/70 text-xs"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-steam-subtext mr-1">
              Active Filters:
            </span>
            {activeFilterChips.map((chip) => (
              <span
                key={chip.id}
                className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-0.5 rounded-full bg-steam-accent/15 border border-steam-accent/40 text-white text-[11px]"
              >
                <span className="text-steam-accent font-semibold">{chip.category}:</span>
                <span>{chip.label}</span>
                <button
                  type="button"
                  data-testid={`remove-filter-chip-${chip.id}`}
                  aria-label={`Remove ${chip.label} filter`}
                  onClick={() => onUpdateFilterState(chip.remove(effectiveFilterState))}
                  className="min-w-6 min-h-6 inline-flex items-center justify-center rounded-full hover:bg-white/10 text-steam-accent hover:text-white transition-colors cursor-pointer"
                  title={`Remove ${chip.label} filter`}
                >
                  <X aria-hidden="true" className="w-3 h-3" />
                </button>
              </span>
            ))}
            {activeFilterChips.length === 0 && activeFilter && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-steam-accent/15 border border-steam-accent/40 text-white text-[11px]">
                <span className="text-steam-accent font-semibold">{activeFilter.label}:</span>
                <span>{activeFilter.value}</span>
              </span>
            )}
          </div>
          <button
            type="button"
            data-testid="clear-all-filters-btn"
            onClick={onResetFilterState}
            className="min-h-6 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#25364b] text-steam-accent hover:text-white border border-steam-border text-[11px] font-semibold transition-colors cursor-pointer shrink-0"
          >
            <X aria-hidden="true" className="w-3 h-3" />
            <span>Clear All</span>
          </button>
        </div>
      )}
    </>
  );
}
