import React from 'react';
import {
  Check,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Info,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { CanonicalGame, PlatformOwnership } from '../../../contracts/game';
import { SearchMatchCandidate, UserGameOverride } from '../../../contracts/override';
import {
  buildCandidateStoreUrl,
  isXboxStoreCandidateId,
} from '../../../services/scraper/metadataScraperService';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import {
  formatMatchPercentage,
  openExternalStoreUrl,
  SOURCE_FILTER_TABS,
  SourceFilterTab,
} from './fixMatchTypes';

export interface FixMatchCandidateStepProps {
  idPrefix?: string;
  game: CanonicalGame;
  sourcePlatform?: PlatformOwnership;
  rawSourceTitle: string;
  existingOverride?: UserGameOverride;
  searchTerm: string;
  onSearchTermChange: (val: string) => void;
  onClearSearch: () => void;
  onSearchSubmit: (e?: React.FormEvent) => void;
  sourceTab: SourceFilterTab;
  onSourceTabChange: (tab: SourceFilterTab) => void;
  notOnSteamOnly: boolean;
  onToggleNotOnSteam: () => void;
  candidates: SearchMatchCandidate[];
  isLoadingCandidates: boolean;
  selectedCandidate: SearchMatchCandidate | null;
  onSelectCandidate: (candidate: SearchMatchCandidate) => void;
}

export function renderFixMatchCandidateStep({
  idPrefix = 'fix-match-wizard',
  game,
  sourcePlatform,
  rawSourceTitle,
  existingOverride,
  searchTerm,
  onSearchTermChange,
  onClearSearch,
  onSearchSubmit,
  sourceTab,
  onSourceTabChange,
  notOnSteamOnly,
  onToggleNotOnSteam,
  candidates,
  isLoadingCandidates,
  selectedCandidate,
  onSelectCandidate,
}: FixMatchCandidateStepProps): React.ReactElement {
  const searchInputId = `${idPrefix}-candidate-search`;

  return (
    <div className="space-y-4">
      {/* Search Bar & Options */}
      <form onSubmit={onSearchSubmit} className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <label htmlFor={searchInputId} className="sr-only">
            Search candidate game by title or keywords
          </label>
          <Search
            aria-hidden="true"
            className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            id={searchInputId}
            type="text"
            autoFocus
            value={searchTerm}
            onChange={(e) => onSearchTermChange(e.target.value)}
            placeholder="Search candidate game by title or keywords..."
            className="w-full pl-10 pr-10 py-2 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-400 text-sm focus:outline-none focus:border-[#66c0f4] transition-colors"
          />
          {searchTerm && (
            <button
              type="button"
              aria-label="Clear candidate search"
              onClick={onClearSearch}
              className="min-w-6 min-h-6 inline-flex items-center justify-center absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
            >
              <X aria-hidden="true" className="w-4 h-4" />
            </button>
          )}
        </div>

        <button
          type="submit"
          disabled={isLoadingCandidates}
          className="min-h-6 px-4 py-2 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer shadow"
        >
          {isLoadingCandidates ? (
            <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin text-[#66c0f4]" />
          ) : (
            <Search aria-hidden="true" className="w-4 h-4 text-[#66c0f4]" />
          )}
          <span>Search</span>
        </button>
      </form>

      {/* Source Tabs & Non-Steam Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        {/* Storefront Source Tabs */}
        <div className="flex items-center gap-1.5 p-1 rounded-md bg-[#16202d] border border-[#2a475e]/70">
          {SOURCE_FILTER_TABS.map((tab) => {
            const isTabDisabled = notOnSteamOnly && tab === 'Steam';
            const isTabActive = sourceTab === tab;
            return (
              <button
                key={tab}
                type="button"
                disabled={isTabDisabled}
                aria-pressed={isTabActive}
                onClick={() => onSourceTabChange(tab)}
                className={`min-h-6 px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                  isTabActive
                    ? 'bg-[#66c0f4] text-slate-950 shadow-sm'
                    : isTabDisabled
                      ? 'text-slate-600 cursor-not-allowed opacity-40'
                      : 'text-slate-300 hover:text-white hover:bg-[#1b2838]'
                }`}
              >
                {tab}
              </button>
            );
          })}
        </div>

        {/* Not on Steam Toggle Switch Button */}
        <button
          type="button"
          aria-pressed={notOnSteamOnly}
          onClick={onToggleNotOnSteam}
          className={`min-h-6 flex items-center gap-2.5 px-3 py-1.5 rounded-md border text-xs font-semibold transition-all cursor-pointer ${
            notOnSteamOnly
              ? 'bg-amber-950/60 border-amber-500/60 text-amber-200'
              : 'bg-[#16202d] border-[#2a475e] text-slate-300 hover:text-white hover:border-slate-400'
          }`}
          title="Force search to ignore Steam store candidates (ideal for GOG/Epic/IGDB-exclusive titles)"
        >
          <div
            className={`w-3.5 h-3.5 rounded-full border transition-all flex items-center justify-center ${
              notOnSteamOnly
                ? 'border-amber-400 bg-amber-400'
                : 'border-slate-400 bg-transparent'
            }`}
          >
            {notOnSteamOnly && <Check aria-hidden="true" className="w-2.5 h-2.5 text-black font-bold" />}
          </div>
          <span>Game is not on Steam (IGDB/GOG only)</span>
        </button>
      </div>

      {/* Source Entitlement vs Active Match Comparison Banner */}
      <div className="mt-3 p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-slate-300 font-medium">Original Storefront Entitlement:</span>
          <span className="px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-bold text-sky-300">
            {getStorefrontDisplayName(sourcePlatform?.platformId || 'steam')}
          </span>
          <span className="text-white font-semibold truncate">&ldquo;{rawSourceTitle}&rdquo;</span>
          {sourcePlatform?.platformGameId && (
            <span className="text-[10px] font-mono text-slate-400">
              (Platform ID: {sourcePlatform.platformGameId})
            </span>
          )}
        </div>

        {existingOverride && (
          <div className="flex flex-wrap items-center gap-1.5 min-w-0 sm:border-l sm:border-[#2a475e] sm:pl-3">
            <span className="text-amber-300/95 font-medium">Currently Routed To:</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-500/40 text-[10px] font-bold text-amber-200 uppercase">
              {existingOverride.matchedStore}
            </span>
            <span className="text-amber-200 font-semibold truncate">
              &ldquo;{existingOverride.title || game.title}&rdquo;
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              (ID: {existingOverride.matchedId})
            </span>
          </div>
        )}
      </div>

      {/* Candidate Results Grid */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Suggested Matches ({candidates.length})
          </span>
          <span className="text-[11px] text-slate-400">
            Click any candidate to scrape official high-res posters &amp; store metadata
          </span>
        </div>

        {isLoadingCandidates ? (
          <div className="py-16 flex flex-col items-center justify-center gap-3 text-slate-300">
            <Loader2 aria-hidden="true" className="w-8 h-8 animate-spin text-[#66c0f4]" />
            <span className="text-xs font-medium">
              Scanning Steam, GOG, Epic, Xbox &amp; IGDB databases...
            </span>
          </div>
        ) : candidates.length === 0 ? (
          <div className="py-16 text-center text-slate-400 border border-dashed border-[#2a475e] rounded-lg">
            <Info aria-hidden="true" className="w-8 h-8 mx-auto mb-2 text-slate-500" />
            <p className="text-sm font-medium text-slate-300">No match candidates found</p>
            <p className="text-xs mt-1">
              Try modifying the search query above or switching source tabs.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto pr-1 custom-scrollbar">
            {candidates.map((cand) => {
              const isSelected = selectedCandidate?.id === cand.id;
              const isCurrentOverride = existingOverride?.matchedId === cand.id;
              const isXboxCand = isXboxStoreCandidateId(cand.id, cand.storeUrl);
              const displaySource = isXboxCand ? 'xbox' : cand.source;
              const storeUrl =
                cand.storeUrl ||
                buildCandidateStoreUrl({
                  source: displaySource,
                  title: cand.title,
                  steamAppId: cand.steamAppId,
                  gogId: cand.source === 'gog' ? cand.id : undefined,
                  epicSlug: cand.source === 'epic' ? String(cand.id) : undefined,
                  igdbId: cand.igdbId ?? (cand.source === 'igdb' ? cand.id : undefined),
                  xboxProductId: isXboxCand ? cand.id : undefined,
                });

              let sourceColor = 'bg-sky-950/80 border-sky-600/50 text-sky-200';
              if (isXboxCand) {
                sourceColor = 'bg-[#107C10]/35 border-emerald-500/60 text-emerald-200';
              } else if (cand.source === 'gog') {
                sourceColor = 'bg-purple-950/80 border-purple-600/50 text-purple-200';
              } else if (cand.source === 'epic') {
                sourceColor = 'bg-zinc-800 border-zinc-600 text-zinc-200';
              } else if (cand.source === 'igdb') {
                sourceColor = 'bg-emerald-950/80 border-emerald-600/50 text-emerald-200';
              }

              return (
                <div
                  key={`${displaySource}-${cand.id}`}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-150 group relative ${
                    isSelected
                      ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
                      : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/70 hover:bg-[#1b2838]/80'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`Select ${cand.title} (${displaySource.toUpperCase()})`}
                    onClick={() => onSelectCandidate(cand)}
                    className="card-stretched-trigger z-10 rounded-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] focus-visible:ring-inset"
                  />

                  {/* Candidate Poster / Thumbnail Preview */}
                  <div className="relative w-14 aspect-[2/3] rounded bg-black/60 overflow-hidden shrink-0 border border-black/40">
                    {cand.capsuleImage ? (
                      <img
                        src={cand.capsuleImage}
                        alt={cand.title}
                        width={56}
                        height={84}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        onError={(e) => {
                          if (cand.headerImage && e.currentTarget.src !== cand.headerImage) {
                            e.currentTarget.src = cand.headerImage;
                          }
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-500">
                        <ImageIcon aria-hidden="true" className="w-5 h-5" />
                      </div>
                    )}
                  </div>

                  {/* Candidate Meta Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      <span
                        className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${sourceColor}`}
                      >
                        {displaySource}
                      </span>

                      {cand.year && (
                        <span className="text-[10px] text-slate-300 font-mono">({cand.year})</span>
                      )}

                      {cand.confidenceScore != null && cand.confidenceScore > 0 && (
                        <span
                          className={`text-[10px] font-semibold ml-auto px-1.5 py-0.5 rounded border ${
                            (cand.confidenceScore <= 1
                              ? cand.confidenceScore * 100
                              : cand.confidenceScore) >= 90
                              ? 'text-emerald-200 bg-emerald-950/70 border-emerald-500/40'
                              : (cand.confidenceScore <= 1
                                    ? cand.confidenceScore * 100
                                    : cand.confidenceScore) >= 70
                                ? 'text-sky-200 bg-sky-950/70 border-sky-500/40'
                                : 'text-amber-200 bg-amber-950/70 border-amber-500/40'
                          }`}
                        >
                          {formatMatchPercentage(cand.confidenceScore)}
                        </span>
                      )}
                    </div>

                    <h3
                      className="text-xs font-semibold text-white group-hover:text-[#66c0f4] transition-colors line-clamp-1 leading-tight"
                      title={cand.title}
                    >
                      {cand.title}
                    </h3>

                    {cand.description && (
                      <p className="text-[11px] text-slate-300 line-clamp-2 mt-1 leading-relaxed">
                        {cand.description}
                      </p>
                    )}

                    <div className="mt-2 flex items-center gap-2 flex-wrap relative z-20 pointer-events-none">
                      {storeUrl && (
                        <button
                          type="button"
                          onClick={(e) => {
                            openExternalStoreUrl(storeUrl, e);
                          }}
                          className="min-h-6 pointer-events-auto inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
                          title={`Open ${displaySource.toUpperCase()} store page for ${cand.title} in browser`}
                        >
                          <ExternalLink aria-hidden="true" className="w-2.5 h-2.5" />
                          <span>Store Page</span>
                        </button>
                      )}

                      {isCurrentOverride && (
                        <div className="inline-flex items-center gap-1 text-[10px] text-amber-200 font-medium">
                          <Check aria-hidden="true" className="w-3 h-3 text-amber-300" />
                          <span>Current Override</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Arrow indicator */}
                  <ChevronRight
                    aria-hidden="true"
                    className="w-4 h-4 text-slate-400 group-hover:text-[#66c0f4] group-hover:translate-x-0.5 transition-all self-center shrink-0"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const FixMatchCandidateStep: React.FC<FixMatchCandidateStepProps> =
  renderFixMatchCandidateStep;
