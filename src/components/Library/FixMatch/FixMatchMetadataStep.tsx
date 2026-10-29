import React from 'react';
import {
  Building,
  Calendar,
  CheckCircle2,
  Edit3,
  ExternalLink,
  EyeOff,
  Image as ImageIcon,
  Loader2,
  Search,
  Tag,
  X,
} from 'lucide-react';
import {
  MetadataSourceOption,
  ScrapedMetadataBundle,
} from '../../../contracts/override';
import { CriticScoreData } from '../../../contracts/critic';
import {
  buildCandidateStoreUrl,
  isXboxStoreCandidateId,
} from '../../../services/scraper/metadataScraperService';
import { getTierColor } from '../../../services/critic/criticUtils';
import { openExternalStoreUrl } from './fixMatchTypes';

export interface FixMatchMetadataStepProps {
  idPrefix?: string;
  scrapedBundle: ScrapedMetadataBundle;
  metadataSearchTerm: string;
  onMetadataSearchTermChange: (val: string) => void;
  onSearchMetadataSources: (e?: React.FormEvent) => void;
  isSearchingMetadataSources: boolean;
  metadataSources: MetadataSourceOption[];
  selectedMetadataSourceId: string;
  onSelectMetadataSource: (srcOpt: MetadataSourceOption) => void;
  selectedCoverUrl: string;
  customTitle: string;
  onCustomTitleChange: (val: string) => void;
  selectedReviewData: CriticScoreData | null;
  selectedReviewOptionId: string;
  activeReleaseDate: string;
  activeDevelopers: string[];
  activeGenres: string[];
  activeAvailableDescriptions: { source: string; text: string }[];
  selectedBlurb: string;
  onSelectedBlurbChange: (val: string) => void;
  onGoToStep2: () => void;
  onGoToStep3: () => void;
}

export function renderFixMatchMetadataStep({
  idPrefix = 'fix-match-wizard',
  scrapedBundle,
  metadataSearchTerm,
  onMetadataSearchTermChange,
  onSearchMetadataSources,
  isSearchingMetadataSources,
  metadataSources,
  selectedMetadataSourceId,
  onSelectMetadataSource,
  selectedCoverUrl,
  customTitle,
  onCustomTitleChange,
  selectedReviewData,
  selectedReviewOptionId,
  activeReleaseDate,
  activeDevelopers,
  activeGenres,
  activeAvailableDescriptions,
  selectedBlurb,
  onSelectedBlurbChange,
  onGoToStep2,
  onGoToStep3,
}: FixMatchMetadataStepProps): React.ReactElement {
  const metadataSearchInputId = `${idPrefix}-meta-search`;
  const gameTitleInputId = `${idPrefix}-game-title`;
  const blurbTextareaId = `${idPrefix}-blurb-textarea`;

  const isXboxBundle = isXboxStoreCandidateId(scrapedBundle.matchedId);
  const targetLabel = isXboxBundle ? 'xbox' : scrapedBundle.matchedStore;
  const targetStoreUrl = buildCandidateStoreUrl({
    source: targetLabel,
    title: scrapedBundle.title,
    steamAppId: scrapedBundle.steamAppId ?? undefined,
    gogId: scrapedBundle.matchedStore === 'gog' ? scrapedBundle.matchedId : undefined,
    epicSlug: scrapedBundle.matchedStore === 'epic' ? String(scrapedBundle.matchedId) : undefined,
    igdbId: scrapedBundle.igdbId,
    xboxProductId: isXboxBundle ? scrapedBundle.matchedId : undefined,
  });

  const displayReleaseDate = activeReleaseDate || scrapedBundle.releaseDate;
  const displayDevelopers = activeDevelopers.length
    ? activeDevelopers
    : scrapedBundle.developers || [];
  const displayGenres = activeGenres.length ? activeGenres : scrapedBundle.genres || [];
  const displayDescriptions = activeAvailableDescriptions.length
    ? activeAvailableDescriptions
    : scrapedBundle.availableDescriptions || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-emerald-400" />
            <span>Review &amp; Confirm Game Metadata Override</span>
          </h3>
          <p className="text-xs text-slate-300 mt-0.5">
            Review scraped metadata, switch storefront metadata sources, select your preferred blurb
            synopsis, and apply to catalog
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-sky-950/80 border border-sky-500/50 text-sky-200">
            Target: {targetLabel}
          </span>
          {scrapedBundle.steamAppId ? (
            <span className="text-[10px] font-mono text-slate-300">
              Steam ID: {scrapedBundle.steamAppId}
            </span>
          ) : null}
          {targetStoreUrl && (
            <button
              type="button"
              onClick={(e) => openExternalStoreUrl(targetStoreUrl, e)}
              className="min-h-6 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
              title={`Open ${targetLabel.toUpperCase()} store page in browser`}
            >
              <ExternalLink aria-hidden="true" className="w-3 h-3" />
              <span>Store Page</span>
            </button>
          )}
        </div>
      </div>

      {/* Metadata Source & Storefront Search Section */}
      <div className="p-3.5 rounded-lg bg-[#131c27] border border-[#2a475e]/80 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-xs font-bold text-white">
                Metadata Source &amp; Storefront Search
              </h4>
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-200 bg-sky-950/80 border border-sky-500/40 px-2 py-0.5 rounded">
                <span>Live Route • Auto-updates main page &amp; media on sync</span>
              </span>
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">
              Routes &ldquo;About This Game&rdquo;, screenshots, trailers, system requirements,
              developer &amp; synopsis to the selected storefront (custom text edits stay pinned)
            </p>
          </div>
        </div>

        <form onSubmit={(e) => onSearchMetadataSources(e)} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <label htmlFor={metadataSearchInputId} className="sr-only">
              Search game metadata across storefronts
            </label>
            <Search
              aria-hidden="true"
              className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              id={metadataSearchInputId}
              type="text"
              value={metadataSearchTerm}
              onChange={(e) => onMetadataSearchTermChange(e.target.value)}
              placeholder="Search game metadata across Steam, GOG, Epic, Xbox & IGDB..."
              className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-400 text-xs focus:outline-none focus:border-[#66c0f4] transition-colors"
            />
            {metadataSearchTerm && (
              <button
                type="button"
                aria-label="Clear metadata search"
                onClick={() => onMetadataSearchTermChange('')}
                className="min-w-6 min-h-6 inline-flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
              >
                <X aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={isSearchingMetadataSources}
            className="min-h-6 px-3.5 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow shrink-0"
          >
            {isSearchingMetadataSources ? (
              <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin text-[#66c0f4]" />
            ) : (
              <Search aria-hidden="true" className="w-3.5 h-3.5 text-[#66c0f4]" />
            )}
            <span>Search Metadata</span>
          </button>
        </form>

        {metadataSources.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {metadataSources.map((srcOpt) => {
              const isActive = selectedMetadataSourceId === srcOpt.id;
              const isXboxSrc = isXboxStoreCandidateId(srcOpt.id, srcOpt.storeUrl);
              const displaySrcBadge = isXboxSrc ? 'xbox' : srcOpt.source;
              const srcStoreUrl =
                srcOpt.storeUrl ||
                buildCandidateStoreUrl({
                  source: displaySrcBadge,
                  title: srcOpt.title,
                  steamAppId: srcOpt.steamAppId ?? undefined,
                  gogId: srcOpt.gogId,
                  epicSlug: srcOpt.epicSlug,
                  igdbId: srcOpt.igdbId,
                  xboxProductId: isXboxSrc ? srcOpt.matchedId : undefined,
                });
              return (
                <div
                  key={srcOpt.id}
                  className={`rounded-md border text-xs font-semibold transition-all flex items-center overflow-hidden ${
                    isActive
                      ? 'bg-[#66c0f4] text-slate-950 border-[#66c0f4] shadow-md'
                      : 'bg-[#16202d] border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4]/60'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onSelectMetadataSource(srcOpt)}
                    className="min-h-6 px-3 py-1.5 flex items-center gap-2 cursor-pointer"
                  >
                    <span className="uppercase text-[10px] font-bold opacity-85">
                      {displaySrcBadge}
                    </span>
                    <span>•</span>
                    <span>{srcOpt.sourceLabel}</span>
                  </button>
                  {srcStoreUrl && (
                    <button
                      type="button"
                      aria-label={`Open ${displaySrcBadge.toUpperCase()} store page for ${srcOpt.title}`}
                      onClick={(e) => {
                        openExternalStoreUrl(srcStoreUrl, e);
                      }}
                      className={`min-w-6 min-h-6 px-2 py-1.5 border-l flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                        isActive
                          ? 'border-slate-950/20 hover:bg-black/15 text-slate-950'
                          : 'border-[#2a475e] hover:bg-[#2a475e] text-[#66c0f4] hover:text-white'
                      }`}
                      title={`Open ${displaySrcBadge.toUpperCase()} store page for ${srcOpt.title} in browser`}
                    >
                      <ExternalLink aria-hidden="true" className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left 1/3: Chosen Cover Poster Preview */}
        <div className="flex flex-col items-center">
          <div className="relative aspect-[2/3] w-48 rounded-lg overflow-hidden border-2 border-[#66c0f4] shadow-2xl bg-black/60">
            <img
              src={selectedCoverUrl || scrapedBundle.capsuleImage}
              alt={customTitle || scrapedBundle.title}
              decoding="async"
              className="w-full h-full object-cover"
            />
            <div className="absolute top-2 left-2 bg-black/85 text-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded border border-emerald-500/40">
              Selected 2:3 Cover
            </div>
          </div>
          <button
            type="button"
            onClick={onGoToStep2}
            className="min-h-6 mt-3 px-2 text-xs text-[#66c0f4] hover:underline flex items-center gap-1 cursor-pointer"
          >
            <ImageIcon aria-hidden="true" className="w-3 h-3" />
            <span>Change Cover Poster</span>
          </button>
        </div>

        {/* Right 2/3: Metadata Fields Review & Blurb Selector */}
        <div className="md:col-span-2 space-y-4">
          {/* Title Input */}
          <div>
            <label
              htmlFor={gameTitleInputId}
              className="block text-xs font-semibold text-slate-200 mb-1"
            >
              Game Title
            </label>
            <input
              id={gameTitleInputId}
              type="text"
              value={customTitle}
              onChange={(e) => onCustomTitleChange(e.target.value)}
              className="w-full px-3 py-1.5 rounded bg-[#16202d] border border-[#2a475e] text-sm text-white font-medium focus:outline-none focus:border-[#66c0f4]"
            />
          </div>

          {/* Dedicated Review Score Badge Preview */}
          <div>
            <span className="block text-xs font-semibold text-slate-200 mb-1">
              Review Score &amp; Source Override
            </span>
            <div className="p-3 rounded-lg bg-[#16202d] border border-[#2a475e]/80 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {selectedReviewData ? (
                  <>
                    {(() => {
                      const colors = getTierColor(selectedReviewData.tier);
                      return (
                        <div
                          className={`flex items-center justify-center px-2.5 py-1 rounded font-black text-sm text-white ${colors.scoreBg} shadow-sm shrink-0 min-w-[36px]`}
                        >
                          {selectedReviewData.score}
                        </div>
                      );
                    })()}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-white">
                          {selectedReviewData.tier}
                        </span>
                        <span className="text-[11px] text-slate-200 capitalize font-medium">
                          {`• ${selectedReviewData.source.replace('_', ' ')}`}
                        </span>
                        {selectedReviewData.numReviews ? (
                          <span className="text-[11px] text-slate-300">
                            {`(${selectedReviewData.numReviews.toLocaleString()} reviews)`}
                          </span>
                        ) : null}
                        {selectedReviewOptionId !== 'custom' &&
                          selectedReviewOptionId !== 'unrated' &&
                          selectedReviewData.source !== 'custom' && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-200 bg-sky-950/80 border border-sky-500/40 px-2 py-0.5 rounded">
                              <span>Live Route • Auto-updates on sync</span>
                            </span>
                          )}
                      </div>
                      {selectedReviewData.summary && (
                        <p className="text-[11px] text-slate-300 truncate max-w-md mt-0.5">
                          {selectedReviewData.summary}
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-slate-300 text-xs py-1">
                    <EyeOff aria-hidden="true" className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="font-medium text-slate-200">
                      Unrated (Review badge hidden)
                    </span>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={onGoToStep3}
                className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] border border-[#2a475e] text-xs text-[#66c0f4] hover:text-white hover:border-[#66c0f4] transition-colors flex items-center gap-1.5 shrink-0 font-medium cursor-pointer"
                title="Navigate to Step 3 to change review score"
              >
                <Edit3 aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Edit</span>
              </button>
            </div>
          </div>

          {/* Badges / Meta row */}
          {(displayReleaseDate || displayDevelopers.length > 0) && (
            <div className="grid grid-cols-2 gap-3 text-xs">
              {displayReleaseDate && (
                <div className="p-2 rounded bg-[#16202d] border border-[#2a475e]/70">
                  <span className="text-[10px] text-slate-300 flex items-center gap-1 mb-0.5">
                    <Calendar aria-hidden="true" className="w-3 h-3" /> Release Date
                  </span>
                  <span className="font-semibold text-slate-100">{displayReleaseDate}</span>
                </div>
              )}

              {displayDevelopers.length > 0 && (
                <div className="p-2 rounded bg-[#16202d] border border-[#2a475e]/70">
                  <span className="text-[10px] text-slate-300 flex items-center gap-1 mb-0.5">
                    <Building aria-hidden="true" className="w-3 h-3" /> Developer
                  </span>
                  <span className="font-semibold text-slate-100 truncate block">
                    {displayDevelopers.join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Genres & Tags */}
          {displayGenres.length > 0 && (
            <div>
              <span className="text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                <Tag aria-hidden="true" className="w-3 h-3" /> Genres &amp; Categories
              </span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {displayGenres.map((g) => (
                  <span
                    key={g}
                    className="px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[10px] text-slate-200"
                  >
                    {g}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Blurb Synopsis Selector */}
          <div>
            <label
              htmlFor={blurbTextareaId}
              className="block text-xs font-semibold text-slate-200 mb-1"
            >
              Storefront Synopsis / Blurb
            </label>

            {displayDescriptions.length > 1 && (
              <div className="space-y-2 mb-2">
                {displayDescriptions.map((desc, i) => {
                  const isBlurbSelected = selectedBlurb === desc.text;
                  return (
                    <button
                      key={`${desc.source}-${i}`}
                      type="button"
                      aria-pressed={isBlurbSelected}
                      onClick={() => onSelectedBlurbChange(desc.text)}
                      className={`w-full text-left p-2 rounded-md border text-xs cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                        isBlurbSelected
                          ? 'bg-[#1b2838] border-[#66c0f4] text-white'
                          : 'bg-[#16202d] border-[#2a475e]/60 text-slate-300 hover:border-slate-400'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-[11px] mb-1">
                        <div
                          className={`w-3 h-3 rounded-full border flex items-center justify-center ${
                            isBlurbSelected ? 'border-[#66c0f4] bg-[#66c0f4]' : 'border-slate-400'
                          }`}
                        >
                          {isBlurbSelected && (
                            <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />
                          )}
                        </div>
                        <span className={isBlurbSelected ? 'text-[#66c0f4]' : 'text-slate-200'}>
                          {desc.source}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-[11px] leading-relaxed pl-5">{desc.text}</p>
                    </button>
                  );
                })}
              </div>
            )}

            <textarea
              id={blurbTextareaId}
              value={selectedBlurb}
              onChange={(e) => onSelectedBlurbChange(e.target.value)}
              rows={3}
              className="w-full p-2.5 rounded bg-[#16202d] border border-[#2a475e] text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-[#66c0f4] leading-relaxed"
              placeholder="Enter synopsis blurb..."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export const FixMatchMetadataStep: React.FC<FixMatchMetadataStepProps> =
  renderFixMatchMetadataStep;
