import React from 'react';
import { Building2, Search, Tag, X } from 'lucide-react';
import { LibraryFilterState } from '../../../contracts/filter';
import { LibraryFilterIndex } from '../../../services/filter/libraryFilterIndex';
import { VirtualListRows } from '../../Common/VirtualContainers';
import { TAG_PREVIEW_LIMIT } from './filterPanelConstants';

export interface RenderCreatorSectionArgs {
  creatorSearchInputId: string;
  creatorSearch: string;
  setCreatorSearch: (q: string) => void;
  creatorScrollRef: React.RefObject<HTMLDivElement | null>;
  creatorScrollHeight: number;
  filteredCreators: LibraryFilterIndex['creatorCounts'];
  selectedCreatorSet: Set<string>;
  creatorsCount: number;
  toggleCreator: (creatorKey: string) => void;
}

export function renderCreatorSection({
  creatorSearchInputId,
  creatorSearch,
  setCreatorSearch,
  creatorScrollRef,
  creatorScrollHeight,
  filteredCreators,
  selectedCreatorSet,
  creatorsCount,
  toggleCreator,
}: RenderCreatorSectionArgs): React.ReactElement {
  const renderCreatorItem = (creator: LibraryFilterIndex['creatorCounts'][number]) => {
    const isSelected = selectedCreatorSet.has(creator.key);
    const roleLabel =
      creator.role === 'both' ? 'Dev & Pub' : creator.role === 'developer' ? 'Dev' : 'Pub';
    return (
      <button
        key={creator.key}
        type="button"
        data-testid={`filter-creator-${creator.key}`}
        aria-pressed={isSelected}
        onClick={() => toggleCreator(creator.key)}
        className={`w-full min-h-6 flex items-center justify-between px-2.5 py-1.5 rounded border text-left text-[11px] transition-all cursor-pointer ${
          isSelected
            ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
            : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate">{creator.name}</span>
          <span className="px-1.5 py-0.2 rounded bg-black/30 border border-white/10 text-[9px] uppercase tracking-wider text-steam-subtext shrink-0">
            {roleLabel}
          </span>
        </div>
        <span className="text-[10px] text-steam-subtext font-mono ml-2 shrink-0">
          {creator.count}
        </span>
      </button>
    );
  };

  return (
    <div
      data-testid="filter-cat-creator"
      className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
          <Building2 aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>6. Creator</span>
        </div>
        {creatorsCount > 0 && (
          <span className="text-[10px] text-steam-accent font-semibold">
            {creatorsCount} selected
          </span>
        )}
      </div>

      {/* Search Creators Input */}
      <div className="relative">
        <label htmlFor={creatorSearchInputId} className="sr-only">
          Search developers or publishers
        </label>
        <Search
          aria-hidden="true"
          className="w-3 h-3 text-steam-subtext absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
        />
        <input
          id={creatorSearchInputId}
          type="text"
          data-testid="filter-creator-search"
          value={creatorSearch}
          onChange={(e) => setCreatorSearch(e.target.value)}
          placeholder="Search developers or publishers..."
          className="w-full bg-[#16202d] border border-steam-border/60 rounded pl-7 pr-2.5 py-1 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent/60"
        />
      </div>

      {/* Virtualized Scrollable Multi-Select Creator List */}
      <div ref={creatorScrollRef} className="max-h-44 overflow-y-auto pr-1 flex flex-col gap-1">
        {filteredCreators.length === 0 ? (
          <div className="text-[11px] text-steam-subtext italic py-2">
            No matching developers or publishers
          </div>
        ) : filteredCreators.length > 30 && creatorScrollHeight > 0 ? (
          <VirtualListRows
            items={filteredCreators}
            scrollElement={creatorScrollRef.current}
            estimatedItemHeight={30}
            itemGapPx={4}
            overscan={6}
            getItemKey={(c) => c.key}
            renderItem={(c) => renderCreatorItem(c)}
          />
        ) : (
          filteredCreators.map((creator) => renderCreatorItem(creator))
        )}
      </div>
    </div>
  );
}

export interface RenderTagsSectionArgs {
  tagSearchInputId: string;
  tagSearch: string;
  setTagSearch: (q: string) => void;
  selectedTagsCount: number;
  tagMatchMode: 'any' | 'all';
  filterState: LibraryFilterState;
  onChange: (nextState: LibraryFilterState) => void;
  visibleTags: LibraryFilterIndex['tagCounts'];
  filteredTagsCount: number;
  selectedTagKeySet: Set<string>;
  isTagSearchEmpty: boolean;
  showAllTags: boolean;
  setShowAllTags: React.Dispatch<React.SetStateAction<boolean>>;
  toggleTag: (tagKey: string) => void;
}

export function renderTagsSection({
  tagSearchInputId,
  tagSearch,
  setTagSearch,
  selectedTagsCount,
  tagMatchMode,
  filterState,
  onChange,
  visibleTags,
  filteredTagsCount,
  selectedTagKeySet,
  isTagSearchEmpty,
  showAllTags,
  setShowAllTags,
  toggleTag,
}: RenderTagsSectionArgs): React.ReactElement {
  return (
    <div
      data-testid="filter-cat-tags"
      className="md:col-span-2 xl:col-span-3 rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-2 font-bold text-white uppercase tracking-wider text-[11px]">
          <Tag aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>7. Tags</span>
          {selectedTagsCount > 0 && (
            <span className="text-[10px] text-steam-accent font-semibold normal-case tracking-normal">
              {selectedTagsCount} selected
            </span>
          )}
        </div>
        {/* ANY / ALL Match Mode Toggle */}
        <div className="inline-flex items-center rounded bg-[#16202d] border border-steam-border/60 p-0.5 text-[10px]">
          <button
            type="button"
            data-testid="filter-tag-mode-any"
            aria-pressed={tagMatchMode === 'any'}
            onClick={() => onChange({ ...filterState, tagMatchMode: 'any' })}
            className={`min-w-6 min-h-6 px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer ${
              tagMatchMode === 'any'
                ? 'bg-steam-accent text-black'
                : 'text-steam-subtext hover:text-white'
            }`}
            title="Match games with ANY selected tag (OR)"
          >
            ANY
          </button>
          <button
            type="button"
            data-testid="filter-tag-mode-all"
            aria-pressed={tagMatchMode === 'all'}
            onClick={() => onChange({ ...filterState, tagMatchMode: 'all' })}
            className={`min-w-6 min-h-6 px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer ${
              tagMatchMode === 'all'
                ? 'bg-steam-accent text-black'
                : 'text-steam-subtext hover:text-white'
            }`}
            title="Match games with ALL selected tags (AND)"
          >
            ALL
          </button>
        </div>
      </div>

      {/* Search Tags Input */}
      <div className="relative">
        <label htmlFor={tagSearchInputId} className="sr-only">
          Search tags
        </label>
        <Search
          aria-hidden="true"
          className="w-3 h-3 text-steam-subtext absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
        />
        <input
          id={tagSearchInputId}
          type="text"
          data-testid="filter-tag-search"
          value={tagSearch}
          onChange={(e) => setTagSearch(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Search tags..."
          className="w-full bg-[#16202d] border border-steam-border/60 rounded pl-7 pr-7 py-1 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent/60"
        />
        {tagSearch.length > 0 && (
          <button
            type="button"
            data-testid="filter-tag-search-clear"
            aria-label="Clear tag search"
            onClick={() => setTagSearch('')}
            className="min-w-6 min-h-6 inline-flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2 text-steam-subtext hover:text-white rounded cursor-pointer"
          >
            <X aria-hidden="true" className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Scrollable Multi-Select Tag Cloud */}
      <div className="max-h-44 overflow-y-auto pr-1 flex flex-wrap gap-1.5 items-center">
        {visibleTags.length === 0 ? (
          <div className="text-[11px] text-steam-subtext italic py-2">No matching tags</div>
        ) : (
          <>
            {visibleTags.map((tag) => {
              const isSelected = selectedTagKeySet.has(tag.key);
              return (
                <button
                  key={tag.key}
                  type="button"
                  data-testid={`filter-tag-${tag.key}`}
                  aria-pressed={isSelected}
                  onClick={() => toggleTag(tag.key)}
                  className={`min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
                      : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
                  }`}
                >
                  <span>{tag.label}</span>
                  <span className="text-[10px] text-steam-subtext font-mono">({tag.count})</span>
                </button>
              );
            })}
            {isTagSearchEmpty && filteredTagsCount > TAG_PREVIEW_LIMIT && (
              <button
                type="button"
                data-testid="filter-tags-show-all"
                aria-expanded={showAllTags}
                onClick={() => setShowAllTags((prev) => !prev)}
                className="min-h-6 inline-flex items-center px-2.5 py-1 rounded border border-steam-accent/40 bg-steam-accent/10 hover:bg-steam-accent/20 text-steam-accent hover:text-white text-[11px] font-semibold transition-colors cursor-pointer"
              >
                {showAllTags ? 'Show fewer tags' : `Show all ${filteredTagsCount} tags`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
