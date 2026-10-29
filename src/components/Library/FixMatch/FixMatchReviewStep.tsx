import React from 'react';
import {
  Award,
  ExternalLink,
  EyeOff,
  Loader2,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { SearchMatchCandidate } from '../../../contracts/override';
import { CriticSource } from '../../../contracts/critic';
import { ReviewCandidateOption } from '../../../services/scraper/reviewCandidateService';
import { calculateTier, getTierColor } from '../../../services/critic/criticUtils';
import { openExternalStoreUrl } from './fixMatchTypes';

export interface FixMatchReviewStepProps {
  idPrefix?: string;
  selectedCandidate: SearchMatchCandidate | null;
  reviewSearchTerm: string;
  onReviewSearchTermChange: (val: string) => void;
  onReviewSearchSubmit: (e?: React.FormEvent) => void;
  isLoadingReviews: boolean;
  reviewCandidates: ReviewCandidateOption[];
  selectedReviewOptionId: string;
  onSelectCandidateOption: (cand: ReviewCandidateOption) => void;
  onSelectCustomCard: () => void;
  onSelectUnrated: () => void;
  customScoreValue: number | string;
  onCustomScoreChange: (val: string) => void;
  customScoreSource: CriticSource;
  onCustomSourceChange: (src: CriticSource) => void;
  customScoreNumReviews: number | string;
  onCustomReviewsChange: (val: string) => void;
  customScoreUrl: string;
  onCustomUrlChange: (val: string) => void;
  customScoreSummary: string;
  onCustomSummaryChange: (val: string) => void;
}

export function renderFixMatchReviewStep({
  idPrefix = 'fix-match-wizard',
  selectedCandidate,
  reviewSearchTerm,
  onReviewSearchTermChange,
  onReviewSearchSubmit,
  isLoadingReviews,
  reviewCandidates,
  selectedReviewOptionId,
  onSelectCandidateOption,
  onSelectCustomCard,
  onSelectUnrated,
  customScoreValue,
  onCustomScoreChange,
  customScoreSource,
  onCustomSourceChange,
  customScoreNumReviews,
  onCustomReviewsChange,
  customScoreUrl,
  onCustomUrlChange,
  customScoreSummary,
  onCustomSummaryChange,
}: FixMatchReviewStepProps): React.ReactElement {
  const reviewSearchInputId = `${idPrefix}-review-search`;
  const customScoreInputId = `${idPrefix}-custom-score`;
  const customSourceSelectId = `${idPrefix}-custom-source`;
  const customReviewsInputId = `${idPrefix}-custom-reviews`;
  const customUrlInputId = `${idPrefix}-custom-url`;
  const customSummaryInputId = `${idPrefix}-custom-summary`;

  const isCustomSelected = selectedReviewOptionId === 'custom';
  const parsedScore = parseInt(String(customScoreValue), 10);
  const isValidScore = !isNaN(parsedScore) && parsedScore >= 0 && parsedScore <= 100;
  const liveTier = isValidScore ? calculateTier(parsedScore) : null;
  const liveColors = liveTier ? getTierColor(liveTier) : null;
  const isUnratedSelected = selectedReviewOptionId === 'unrated';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-[#2a475e]/60 pb-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Award aria-hidden="true" className="w-4 h-4 text-[#66c0f4]" />
            <span>Select Review Score &amp; Source</span>
          </h3>
          <p className="text-xs text-slate-300 mt-0.5">
            Select verified press review consensus, player community rating, or enter a custom score
          </p>
        </div>

        {selectedCandidate && (
          <div className="flex items-center gap-2 bg-[#16202d] px-3 py-1 rounded-md border border-[#2a475e]">
            <span className="text-[10px] uppercase font-bold text-slate-300">
              Selected Candidate:
            </span>
            <span className="text-xs font-semibold text-white truncate max-w-[200px]">
              {selectedCandidate.title}
            </span>
          </div>
        )}
      </div>

      {/* Independent Review Score Search Bar */}
      <form
        onSubmit={onReviewSearchSubmit}
        className="flex flex-col sm:flex-row gap-2.5 bg-[#131c27] p-3 rounded-lg border border-[#2a475e]/70"
      >
        <div className="relative flex-1">
          <label htmlFor={reviewSearchInputId} className="sr-only">
            Search review scores by title
          </label>
          <Search
            aria-hidden="true"
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            id={reviewSearchInputId}
            type="text"
            value={reviewSearchTerm}
            onChange={(e) => onReviewSearchTermChange(e.target.value)}
            placeholder="Search review scores by title across Metacritic, OpenCritic, Steam & GOG..."
            className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#16202d] border border-[#2a475e] text-white placeholder-slate-400 text-xs focus:outline-none focus:border-[#66c0f4] transition-colors"
          />
          {reviewSearchTerm && (
            <button
              type="button"
              aria-label="Clear review search"
              onClick={() => onReviewSearchTermChange('')}
              className="min-w-6 min-h-6 inline-flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
            >
              <X aria-hidden="true" className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          type="submit"
          disabled={isLoadingReviews}
          className="min-h-6 px-3.5 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4] transition-colors font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow shrink-0"
        >
          {isLoadingReviews ? (
            <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin text-[#66c0f4]" />
          ) : (
            <Search aria-hidden="true" className="w-3.5 h-3.5 text-[#66c0f4]" />
          )}
          <span>Search Reviews</span>
        </button>
      </form>

      {isLoadingReviews ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-300">
          <Loader2 aria-hidden="true" className="w-8 h-8 animate-spin text-[#66c0f4]" />
          <span className="text-xs font-medium">
            Discovering reviews from Metacritic, OpenCritic, Steam &amp; storefront anchors...
          </span>
        </div>
      ) : (
        <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1 custom-scrollbar">
          {/* Notice if no candidates discovered */}
          {reviewCandidates.length === 0 && (
            <div className="p-3 rounded-lg bg-[#16202d] border border-dashed border-[#2a475e] text-center text-xs text-slate-300">
              No external review scores were discovered automatically for this title. You can search
              another title above, specify a manual score, or keep it unrated below.
            </div>
          )}

          {/* Discovered Candidates */}
          {reviewCandidates.map((cand) => {
            const isSelected = selectedReviewOptionId === cand.id;
            const colors = getTierColor(cand.tier);
            const isXboxReview =
              cand.source === 'xbox' ||
              String(cand.id || '').toLowerCase().startsWith('xbox-') ||
              Boolean(cand.url && cand.url.toLowerCase().includes('xbox.com'));

            let sourceBadgeColor = 'bg-yellow-950/90 text-yellow-200 border-yellow-500/50';
            if (isXboxReview) {
              sourceBadgeColor = 'bg-[#107C10]/45 text-emerald-200 border-emerald-500/60';
            } else if (cand.source === 'opencritic') {
              sourceBadgeColor = 'bg-purple-950/90 text-purple-200 border-purple-500/50';
            } else if (cand.source === 'steam') {
              sourceBadgeColor = 'bg-sky-950/90 text-sky-200 border-sky-500/50';
            } else if (cand.source === 'gog') {
              sourceBadgeColor = 'bg-indigo-950/90 text-indigo-200 border-indigo-500/50';
            } else if (cand.source === 'epic') {
              sourceBadgeColor = 'bg-zinc-800 text-zinc-200 border-zinc-600';
            }

            return (
              <div
                key={cand.id}
                className={`p-3.5 rounded-lg border cursor-pointer transition-all duration-150 flex items-start gap-3.5 relative ${
                  isSelected
                    ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/15 ring-1 ring-[#66c0f4]/50'
                    : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60 hover:bg-[#1b2838]/80'
                }`}
              >
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`Select ${cand.sourceLabel} (${cand.score}/100)`}
                  onClick={() => onSelectCandidateOption(cand)}
                  className="card-stretched-trigger z-10 rounded-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] focus-visible:ring-inset"
                />

                {/* Radio selection ring */}
                <div
                  className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-1 transition-all ${
                    isSelected
                      ? 'border-[#66c0f4] bg-[#66c0f4]'
                      : 'border-slate-400 bg-transparent'
                  }`}
                >
                  {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                </div>

                {/* Tier Score Pill */}
                <div
                  className={`flex items-center justify-center px-3 py-1.5 rounded font-black text-sm text-white ${colors.scoreBg} shadow-sm shrink-0 min-w-[42px] mt-0.5`}
                >
                  {cand.score}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span
                      className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${sourceBadgeColor}`}
                    >
                      {isXboxReview ? 'xbox' : cand.source.replace('_', ' ')}
                    </span>

                    <span className="text-xs font-bold text-white">{cand.sourceLabel}</span>

                    <span className={`text-[11px] font-bold ${colors.accentText}`}>
                      {cand.tier}
                    </span>

                    {(cand.source !== 'custom' || isXboxReview) && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-200 bg-sky-950/80 border border-sky-500/40 px-2 py-0.5 rounded">
                        <span>Live Route • Auto-updates on sync</span>
                      </span>
                    )}

                    {(cand.isRecommended || cand.groundTruthSource) && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-200 bg-emerald-950/80 border border-emerald-500/40 px-2 py-0.5 rounded shadow-sm">
                        <ShieldCheck aria-hidden="true" className="w-3 h-3 text-emerald-300" />
                        <span>{cand.groundTruthSource || 'Recommended'}</span>
                      </span>
                    )}

                    {cand.badgeText && !cand.isRecommended && !cand.groundTruthSource && (
                      <span className="text-[10px] text-slate-300 bg-[#131c27] px-1.5 py-0.5 rounded border border-[#2a475e]/60">
                        {cand.badgeText}
                      </span>
                    )}
                  </div>

                  {/* Extra info row */}
                  <div className="flex items-center gap-3 text-[11px] text-slate-300 flex-wrap relative z-20 pointer-events-none">
                    {cand.numReviews != null && (
                      <span>{`${cand.numReviews.toLocaleString()} reviews`}</span>
                    )}
                    {cand.percentRecommended != null && (
                      <span>{`• ${cand.percentRecommended}% recommended`}</span>
                    )}
                    {cand.userScoreRaw != null && (
                      <span>{`• User Score: ${cand.userScoreRaw}/10`}</span>
                    )}
                    {cand.starRatingRaw != null && (
                      <span>{`• Rating: ${cand.starRatingRaw}/5`}</span>
                    )}
                    {cand.url && (
                      <button
                        type="button"
                        onClick={(e) => openExternalStoreUrl(cand.url, e)}
                        className="min-h-6 pointer-events-auto inline-flex items-center gap-1 px-1.5 text-[11px] text-[#66c0f4] hover:text-white hover:underline transition-colors ml-auto cursor-pointer"
                        title="Open review page in browser"
                      >
                        <span>Source</span>
                        <ExternalLink aria-hidden="true" className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {cand.summary && (
                    <p className="text-xs text-slate-200 mt-1.5 line-clamp-2 leading-relaxed italic">
                      &ldquo;{cand.summary}&rdquo;
                    </p>
                  )}
                </div>
              </div>
            );
          })}

          {/* Manual / Custom Score Card */}
          <div
            className={`p-3.5 rounded-lg border transition-all duration-150 flex flex-col gap-3 ${
              isCustomSelected
                ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/15 ring-1 ring-[#66c0f4]/50'
                : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60 hover:bg-[#1b2838]/80'
            }`}
          >
            <button
              type="button"
              aria-pressed={isCustomSelected}
              onClick={onSelectCustomCard}
              className="w-full text-left flex items-center justify-between gap-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] rounded"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                    isCustomSelected
                      ? 'border-[#66c0f4] bg-[#66c0f4]'
                      : 'border-slate-400 bg-transparent'
                  }`}
                >
                  {isCustomSelected && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">Manual / Custom Score</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-amber-200">
                      Custom
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 mt-0.5">
                    Specify your own custom score, rating source, review count, and blurb
                  </p>
                </div>
              </div>

              {isValidScore && liveTier && liveColors && (
                <div className="flex items-center gap-2 shrink-0">
                  <div
                    className={`flex items-center justify-center px-2.5 py-1 rounded font-black text-xs text-white ${liveColors.scoreBg} shadow-sm`}
                  >
                    {parsedScore}
                  </div>
                  <span className={`text-xs font-bold ${liveColors.accentText}`}>{liveTier}</span>
                </div>
              )}
            </button>

            {/* Inline Form - visible when selected */}
            {isCustomSelected && (
              <div className="mt-2 pt-3 border-t border-[#2a475e]/70 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor={customScoreInputId}
                      className="block text-[11px] font-semibold text-slate-200 mb-1"
                    >
                      Score (0 - 100) <span className="text-rose-400">*</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={customScoreInputId}
                        type="number"
                        min="0"
                        max="100"
                        value={customScoreValue}
                        onChange={(e) => onCustomScoreChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.preventDefault();
                        }}
                        placeholder="e.g. 88"
                        className="w-24 px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-sm text-white placeholder-slate-400 font-mono focus:outline-none focus:border-[#66c0f4]"
                      />
                      {isValidScore && liveTier && liveColors ? (
                        <div
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-bold text-white ${liveColors.scoreBg} shadow-sm`}
                        >
                          <span>{liveTier}</span>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 font-mono">Enter 0-100</span>
                      )}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor={customSourceSelectId}
                      className="block text-[11px] font-semibold text-slate-200 mb-1"
                    >
                      Rating Source
                    </label>
                    <select
                      id={customSourceSelectId}
                      value={customScoreSource}
                      onChange={(e) => onCustomSourceChange(e.target.value as CriticSource)}
                      className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white focus:outline-none focus:border-[#66c0f4]"
                    >
                      <option value="metacritic">Metacritic</option>
                      <option value="opencritic">OpenCritic</option>
                      <option value="steam">Steam</option>
                      <option value="gog">GOG</option>
                      <option value="epic">Epic Games</option>
                      <option value="xbox">Xbox Store</option>
                      <option value="custom">Custom / Other</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor={customReviewsInputId}
                      className="block text-[11px] font-semibold text-slate-200 mb-1"
                    >
                      Number of Reviews (Optional)
                    </label>
                    <input
                      id={customReviewsInputId}
                      type="number"
                      min="0"
                      value={customScoreNumReviews}
                      onChange={(e) => onCustomReviewsChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      placeholder="e.g. 120"
                      className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white placeholder-slate-400 font-mono focus:outline-none focus:border-[#66c0f4]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={customUrlInputId}
                      className="block text-[11px] font-semibold text-slate-200 mb-1"
                    >
                      Canonical URL (Optional)
                    </label>
                    <input
                      id={customUrlInputId}
                      type="url"
                      value={customScoreUrl}
                      onChange={(e) => onCustomUrlChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      placeholder="https://..."
                      className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#66c0f4]"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor={customSummaryInputId}
                    className="block text-[11px] font-semibold text-slate-200 mb-1"
                  >
                    Summary Consensus / Blurb (Optional)
                  </label>
                  <input
                    id={customSummaryInputId}
                    type="text"
                    value={customScoreSummary}
                    onChange={(e) => onCustomSummaryChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    placeholder="e.g. Universal acclaim based on critic reviews."
                    className="w-full px-3 py-1.5 rounded bg-[#131c27] border border-[#2a475e] text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#66c0f4]"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Unrated / Hide Review Score Card */}
          <button
            type="button"
            aria-pressed={isUnratedSelected}
            onClick={onSelectUnrated}
            className={`w-full text-left p-3.5 rounded-lg border transition-all duration-150 flex items-center justify-between gap-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
              isUnratedSelected
                ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/15 ring-1 ring-[#66c0f4]/50'
                : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60 hover:bg-[#1b2838]/80'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                  isUnratedSelected
                    ? 'border-[#66c0f4] bg-[#66c0f4]'
                    : 'border-slate-400 bg-transparent'
                }`}
              >
                {isUnratedSelected && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
              </div>

              <div className="flex items-center gap-2">
                <EyeOff aria-hidden="true" className="w-4 h-4 text-slate-300" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">
                      Unrated / Hide Review Score
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 mt-0.5">
                    Suppress review score pill and critic badge for this game in your library
                  </p>
                </div>
              </div>
            </div>

            <span className="text-[10px] text-slate-300 uppercase font-mono px-2 py-0.5 rounded border border-[#2a475e]">
              No Score
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export const FixMatchReviewStep: React.FC<FixMatchReviewStepProps> = renderFixMatchReviewStep;
