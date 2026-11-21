import React from 'react';
import { Calendar } from 'lucide-react';
import { LibraryFilterState } from '../../../contracts/filter';
import { LibraryFilterIndex } from '../../../services/filter/libraryFilterIndex';

export interface RenderReleaseDateSectionArgs {
  includeUnknownYearId: string;
  minYear: number;
  maxYear: number;
  fromYear: number;
  toYear: number;
  fromPct: number;
  toPct: number;
  isYearFilterActive: boolean;
  filterState: LibraryFilterState;
  filterIndex: LibraryFilterIndex;
  onChange: (nextState: LibraryFilterState) => void;
  applyEraPreset: (presetFrom: number | null, presetTo: number | null) => void;
}

export function renderReleaseDateSection({
  includeUnknownYearId,
  minYear,
  maxYear,
  fromYear,
  toYear,
  fromPct,
  toPct,
  isYearFilterActive,
  filterState,
  filterIndex,
  onChange,
  applyEraPreset,
}: RenderReleaseDateSectionArgs): React.ReactElement {
  return (
    <div
      data-testid="filter-cat-release-date"
      className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
          <Calendar aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>5. Release Date</span>
        </div>
        <span
          data-testid="release-year-range-readout"
          className={`px-2 py-0.5 rounded font-mono text-[11px] font-semibold border ${
            isYearFilterActive
              ? 'bg-steam-accent/20 border-steam-accent/50 text-steam-accent'
              : 'bg-[#16202d] border-steam-border/60 text-white'
          }`}
        >
          {fromYear} — {toYear}
        </span>
      </div>

      {/* Two-Point Dual-Range Slider */}
      <div className="px-1 pt-1">
        <div className="relative h-6 flex items-center">
          <div className="h-1.5 w-full rounded-full bg-[#1a222f]" />
          <div
            className="bg-[#66c0f4] h-1.5 rounded-full absolute pointer-events-none"
            style={{
              left: `${fromPct}%`,
              width: `${Math.max(0, toPct - fromPct)}%`,
            }}
          />
          <input
            type="range"
            aria-label="Release year from"
            data-testid="release-year-slider-from"
            min={minYear}
            max={maxYear}
            step={1}
            value={fromYear}
            style={{ zIndex: fromYear >= maxYear - 1 ? 5 : 3 }}
            onChange={(e) => {
              const nextFrom = Math.min(Number(e.target.value), toYear);
              const nextRange: [number, number] | null =
                nextFrom <= minYear && toYear >= maxYear ? null : [nextFrom, toYear];
              onChange({ ...filterState, releaseYearRange: nextRange });
            }}
            className="dual-range-input absolute inset-0 w-full h-full m-0"
          />
          <input
            type="range"
            aria-label="Release year to"
            data-testid="release-year-slider-to"
            min={minYear}
            max={maxYear}
            step={1}
            value={toYear}
            style={{ zIndex: 4 }}
            onChange={(e) => {
              const nextTo = Math.max(Number(e.target.value), fromYear);
              const nextRange: [number, number] | null =
                fromYear <= minYear && nextTo >= maxYear ? null : [fromYear, nextTo];
              onChange({ ...filterState, releaseYearRange: nextRange });
            }}
            className="dual-range-input absolute inset-0 w-full h-full m-0"
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-steam-subtext font-mono mt-0.5">
          <span>{minYear}</span>
          <span>{maxYear}</span>
        </div>
      </div>

      {/* Quick Era Preset Pills */}
      <div className="flex flex-wrap gap-1">
        {[
          { label: 'All Years', from: null, to: null },
          { label: '2020s', from: 2020, to: 2029 },
          { label: '2010s', from: 2010, to: 2019 },
          { label: '2000s', from: 2000, to: 2009 },
          { label: '≤ 1999', from: minYear, to: 1999 },
        ].map((era) => {
          const isAll = era.from === null;
          const expectedFrom =
            era.from !== null ? Math.max(minYear, Math.min(maxYear, era.from)) : minYear;
          const expectedTo =
            era.to !== null ? Math.max(expectedFrom, Math.min(maxYear, era.to)) : maxYear;
          const isSelected = isAll
            ? !isYearFilterActive
            : isYearFilterActive && fromYear === expectedFrom && toYear === expectedTo;
          return (
            <button
              key={era.label}
              type="button"
              aria-pressed={isSelected}
              onClick={() => applyEraPreset(era.from, era.to)}
              className={`min-h-6 px-2 py-0.5 rounded border text-[10px] font-semibold transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-steam-accent text-black border-steam-accent'
                  : 'bg-[#16202d] border-steam-border/60 text-steam-subtext hover:text-white'
              }`}
            >
              {era.label}
            </button>
          );
        })}
      </div>

      {/* Include games with unknown release date */}
      <label
        htmlFor={includeUnknownYearId}
        className="inline-flex items-center gap-2 text-[11px] text-steam-subtext hover:text-white cursor-pointer select-none pt-0.5"
      >
        <input
          id={includeUnknownYearId}
          type="checkbox"
          data-testid="release-year-include-unknown"
          checked={filterState.includeUnknownReleaseYear}
          onChange={(e) =>
            onChange({
              ...filterState,
              includeUnknownReleaseYear: e.target.checked,
            })
          }
          className="rounded border-steam-border bg-[#16202d] text-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent cursor-pointer"
        />
        <span>
          Include games with unknown release date ({filterIndex.unknownReleaseYearCount})
        </span>
      </label>
    </div>
  );
}
