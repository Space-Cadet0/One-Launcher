import React from 'react';
import { Search, Sparkles, Tags } from 'lucide-react';
import { FeatureFilterOption, LibraryFilterState } from '../../../contracts/filter';
import { LibraryFilterIndex } from '../../../services/filter/libraryFilterIndex';
import { FEATURE_OPTIONS } from './filterPanelConstants';

export interface RenderGenresSectionArgs {
  genreSearchInputId: string;
  genreSearch: string;
  setGenreSearch: (q: string) => void;
  filteredGenres: LibraryFilterIndex['genreCounts'];
  filterState: LibraryFilterState;
  onChange: (nextState: LibraryFilterState) => void;
  toggleGenre: (genreKey: string) => void;
}

export function renderGenresSection({
  genreSearchInputId,
  genreSearch,
  setGenreSearch,
  filteredGenres,
  filterState,
  onChange,
  toggleGenre,
}: RenderGenresSectionArgs): React.ReactElement {
  return (
    <div
      data-testid="filter-cat-genres"
      className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
          <Tags aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>3. Genres</span>
        </div>
        {/* ANY / ALL Match Mode Toggle */}
        <div className="inline-flex items-center rounded bg-[#16202d] border border-steam-border/60 p-0.5 text-[10px]">
          <button
            type="button"
            data-testid="filter-genre-mode-any"
            aria-pressed={filterState.genreMatchMode === 'any'}
            onClick={() => onChange({ ...filterState, genreMatchMode: 'any' })}
            className={`min-w-6 min-h-6 px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer ${
              filterState.genreMatchMode === 'any'
                ? 'bg-steam-accent text-black'
                : 'text-steam-subtext hover:text-white'
            }`}
            title="Match games with ANY selected genre (OR)"
          >
            ANY
          </button>
          <button
            type="button"
            data-testid="filter-genre-mode-all"
            aria-pressed={filterState.genreMatchMode === 'all'}
            onClick={() => onChange({ ...filterState, genreMatchMode: 'all' })}
            className={`min-w-6 min-h-6 px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer ${
              filterState.genreMatchMode === 'all'
                ? 'bg-steam-accent text-black'
                : 'text-steam-subtext hover:text-white'
            }`}
            title="Match games with ALL selected genres (AND)"
          >
            ALL
          </button>
        </div>
      </div>

      {/* Search Genres Input */}
      <div className="relative">
        <label htmlFor={genreSearchInputId} className="sr-only">
          Search genres
        </label>
        <Search
          aria-hidden="true"
          className="w-3 h-3 text-steam-subtext absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
        />
        <input
          id={genreSearchInputId}
          type="text"
          data-testid="filter-genre-search"
          value={genreSearch}
          onChange={(e) => setGenreSearch(e.target.value)}
          placeholder="Search genres..."
          className="w-full bg-[#16202d] border border-steam-border/60 rounded pl-7 pr-2.5 py-1 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent/60"
        />
      </div>

      {/* Scrollable Multi-Select Genre List */}
      <div className="max-h-44 overflow-y-auto pr-1 flex flex-wrap gap-1.5">
        {filteredGenres.length === 0 ? (
          <div className="text-[11px] text-steam-subtext italic py-2">No matching genres</div>
        ) : (
          filteredGenres.map((genre) => {
            const isSelected = filterState.genres.some((g) => g.toLowerCase().trim() === genre.key);
            return (
              <button
                key={genre.key}
                type="button"
                data-testid={`filter-genre-${genre.key}`}
                aria-pressed={isSelected}
                onClick={() => toggleGenre(genre.key)}
                className={`min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
                    : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
                }`}
              >
                <span>{genre.label}</span>
                <span className="text-[10px] text-steam-subtext font-mono">({genre.count})</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export interface RenderFeaturesSectionArgs {
  filterState: LibraryFilterState;
  filterIndex: LibraryFilterIndex;
  toggleFeature: (feat: FeatureFilterOption) => void;
}

export function renderFeaturesSection({
  filterState,
  filterIndex,
  toggleFeature,
}: RenderFeaturesSectionArgs): React.ReactElement {
  return (
    <div
      data-testid="filter-cat-features"
      className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
          <Sparkles aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>4. Features &amp; Capabilities</span>
        </div>
        {filterState.features.length > 0 && (
          <span className="text-[10px] text-steam-accent font-semibold">
            {filterState.features.length} selected
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {FEATURE_OPTIONS.map((feat) => {
          const isSelected = filterState.features.includes(feat.id);
          const count = filterIndex.featureCounts[feat.id] ?? 0;
          return (
            <button
              key={feat.id}
              type="button"
              data-testid={`filter-feature-${feat.id}`}
              aria-pressed={isSelected}
              onClick={() => toggleFeature(feat.id)}
              className={`min-h-6 flex items-center justify-between px-2.5 py-1.5 rounded border text-[11px] transition-all cursor-pointer ${
                isSelected
                  ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
                  : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
              }`}
            >
              <span className="truncate">{feat.label}</span>
              <span className="text-[10px] text-steam-subtext font-mono ml-1">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
