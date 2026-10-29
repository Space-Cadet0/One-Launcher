import React from 'react';
import {
  Check,
  Image as ImageIcon,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import {
  ScrapedCoverOption,
  SearchMatchCandidate,
} from '../../../contracts/override';
import { SOURCE_FILTER_TABS, SourceFilterTab } from './fixMatchTypes';

export interface FixMatchCoverStepProps {
  idPrefix?: string;
  selectedCandidate: SearchMatchCandidate | null;
  coverSearchTerm: string;
  onCoverSearchTermChange: (val: string) => void;
  onSearchCovers: (e?: React.FormEvent, overrideTab?: SourceFilterTab) => void;
  coverSourceTab: SourceFilterTab;
  onCoverSourceTabChange: (tab: SourceFilterTab) => void;
  combinedCovers: ScrapedCoverOption[];
  selectedCoverUrl: string;
  onSelectCoverUrl: (url: string) => void;
  isScrapingDetails: boolean;
  isSearchingCovers: boolean;
  onBackToStep1: () => void;
}

export function renderFixMatchCoverStep({
  idPrefix = 'fix-match-wizard',
  selectedCandidate,
  coverSearchTerm,
  onCoverSearchTermChange,
  onSearchCovers,
  coverSourceTab,
  onCoverSourceTabChange,
  combinedCovers,
  selectedCoverUrl,
  onSelectCoverUrl,
  isScrapingDetails,
  isSearchingCovers,
  onBackToStep1,
}: FixMatchCoverStepProps): React.ReactElement {
  const coverSearchInputId = `${idPrefix}-cover-search`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ImageIcon aria-hidden="true" className="w-4 h-4 text-[#66c0f4]" />
            <span>Select 2:3 Vertical Cover Art</span>
          </h3>
          <p className="text-xs text-slate-300 mt-0.5">
            Choose from official high-resolution storefront posters or search across all stores
          </p>
        </div>

        {selectedCandidate && (
          <div className="flex items-center gap-2 bg-[#16202d] px-3 py-1 rounded-md border border-[#2a475e]">
            <span className="text-[10px] uppercase font-bold text-slate-300">
              Selected Candidate:
            </span>
            <span className="text-xs font-semibold text-white">{selectedCandidate.title}</span>
          </div>
        )}
      </div>

      {/* Independent Cover Art Search Bar & Source Filter Pills */}
      <div className="space-y-2.5 bg-[#131c27] p-3 rounded-lg border border-[#2a475e]/70">
        <form
          onSubmit={(e) => onSearchCovers(e)}
          className="flex flex-col sm:flex-row gap-2.5"
        >
          <div className="relative flex-1">
            <label htmlFor={coverSearchInputId} className="sr-only">
              Search cover art by game title
            </label>
            <Search
              aria-hidden="true"
              className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              id={coverSearchInputId}
              type="text"
              value={coverSearchTerm}
              onChange={(e) => onCoverSearchTermChange(e.target.value)}
              placeholder="Search cover art by game title across Steam, IGDB, GOG, Epic, Xbox..."
              className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-400 text-xs focus:outline-none focus:border-[#66c0f4] transition-colors"
            />
            {coverSearchTerm && (
              <button
                type="button"
                aria-label="Clear cover search"
                onClick={() => onCoverSearchTermChange('')}
                className="min-w-6 min-h-6 inline-flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
              >
                <X aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={isSearchingCovers || isScrapingDetails}
            className="min-h-6 px-3.5 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow shrink-0"
          >
            {isSearchingCovers ? (
              <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin text-[#66c0f4]" />
            ) : (
              <Search aria-hidden="true" className="w-3.5 h-3.5 text-[#66c0f4]" />
            )}
            <span>Search Covers</span>
          </button>
        </form>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1 p-1 rounded-md bg-[#16202d] border border-[#2a475e]/70">
            {SOURCE_FILTER_TABS.map((tab) => {
              const isTabActive = coverSourceTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={isTabActive}
                  onClick={() => {
                    onCoverSourceTabChange(tab);
                    onSearchCovers(undefined, tab);
                  }}
                  className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-all cursor-pointer ${
                    isTabActive
                      ? 'bg-[#66c0f4] text-slate-950 shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-[#1b2838]'
                  }`}
                >
                  {tab}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] text-slate-300">
            {`${combinedCovers.length} cover option${combinedCovers.length === 1 ? '' : 's'} shown`}
          </span>
        </div>
      </div>

      {isScrapingDetails || (isSearchingCovers && combinedCovers.length === 0) ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-300">
          <Loader2 aria-hidden="true" className="w-8 h-8 animate-spin text-[#66c0f4]" />
          <span className="text-xs font-medium">
            {isSearchingCovers
              ? 'Searching cover art across storefronts...'
              : 'Scraping high-resolution storefront box art, screenshots & blurbs...'}
          </span>
        </div>
      ) : combinedCovers.length === 0 ? (
        <div className="py-16 text-center text-slate-400 border border-dashed border-[#2a475e] rounded-lg">
          <p className="text-sm font-medium text-slate-300">No cover art options available</p>
          <p className="text-xs mt-1">
            Use the cover search bar above to find vertical box art from Steam, IGDB, GOG, Epic, or
            Xbox.
          </p>
          <button
            type="button"
            onClick={onBackToStep1}
            className="min-h-6 mt-3 px-3 py-1.5 rounded bg-[#1b2838] text-xs text-[#66c0f4] hover:brightness-110 cursor-pointer"
          >
            Back to Candidate Selection
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 max-h-[44vh] overflow-y-auto pr-1 custom-scrollbar">
          {combinedCovers.map((cover, idx) => {
            const isSelected = selectedCoverUrl === cover.url;
            const isXbxCover =
              cover.label.toLowerCase().startsWith('xbox') ||
              cover.url.toLowerCase().includes('s-microsoft.com');
            const displayCoverSource = isXbxCover ? 'xbox' : cover.source;

            let sourceBadgeColor = 'bg-sky-950/90 text-sky-200 border-sky-500/50';
            if (isXbxCover) {
              sourceBadgeColor = 'bg-[#107C10]/45 text-emerald-200 border-emerald-500/60';
            } else if (cover.source === 'gog') {
              sourceBadgeColor = 'bg-purple-950/90 text-purple-200 border-purple-500/50';
            } else if (cover.source === 'epic') {
              sourceBadgeColor = 'bg-zinc-800 text-zinc-200 border-zinc-600';
            } else if (cover.source === 'igdb') {
              sourceBadgeColor = 'bg-emerald-950/90 text-emerald-200 border-emerald-500/50';
            }

            return (
              <button
                key={`${cover.url}-${idx}`}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCoverUrl(cover.url)}
                className={`relative rounded-lg overflow-hidden border text-left cursor-pointer transition-all duration-200 flex flex-col group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                  isSelected
                    ? 'border-[#66c0f4] ring-2 ring-[#66c0f4]/50 shadow-xl shadow-[#66c0f4]/20 scale-[1.02]'
                    : 'border-[#2a475e] hover:border-slate-400 bg-[#16202d]'
                }`}
              >
                {/* 2:3 Aspect Ratio Container */}
                <div className="relative aspect-[2/3] w-full bg-black/60 overflow-hidden flex items-center justify-center">
                  <img
                    src={cover.url}
                    alt={cover.label}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />

                  {/* Selected Checkmark Badge */}
                  {isSelected && (
                    <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#66c0f4] text-slate-950 flex items-center justify-center shadow-lg font-bold">
                      <Check aria-hidden="true" className="w-4 h-4 stroke-[3]" />
                    </div>
                  )}

                  {/* Source Pill */}
                  <div className="absolute bottom-2 left-2">
                    <span
                      className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${sourceBadgeColor}`}
                    >
                      {displayCoverSource}
                    </span>
                  </div>

                  {/* Dimensions Pill */}
                  {cover.dimensions && (
                    <div className="absolute bottom-2 right-2 bg-black/85 text-slate-200 text-[9px] font-mono px-1.5 py-0.5 rounded border border-white/20">
                      {cover.dimensions}
                    </div>
                  )}
                </div>

                {/* Label info */}
                <div className="p-2 bg-[#16202d] border-t border-[#2a475e]/60 w-full">
                  <p
                    className="text-[11px] font-medium text-slate-200 truncate"
                    title={cover.label}
                  >
                    {cover.label}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const FixMatchCoverStep: React.FC<FixMatchCoverStepProps> = renderFixMatchCoverStep;
