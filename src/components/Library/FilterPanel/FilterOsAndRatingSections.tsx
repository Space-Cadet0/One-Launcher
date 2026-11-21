import React from 'react';
import { Award, Check, Monitor } from 'lucide-react';
import {
  CriticTierFilterOption,
  LibraryFilterState,
  OsCompatibilityFilterOption,
  ReviewSentimentFilterOption,
} from '../../../contracts/filter';
import { LibraryFilterIndex } from '../../../services/filter/libraryFilterIndex';
import {
  CRITIC_TIER_OPTIONS,
  MIN_SCORE_OPTIONS,
  OS_OPTIONS,
  REVIEW_SENTIMENT_OPTIONS,
} from './filterPanelConstants';

export interface RenderOsSectionArgs {
  supportsWindowsTranslation: boolean;
  visibleOsOptions: readonly (typeof OS_OPTIONS)[number][];
  activeVisibleOsCount: number;
  filterState: LibraryFilterState;
  filterIndex: LibraryFilterIndex;
  toggleOsOption: (opt: OsCompatibilityFilterOption) => void;
}

export function renderOsCompatibilitySection({
  supportsWindowsTranslation,
  visibleOsOptions,
  activeVisibleOsCount,
  filterState,
  filterIndex,
  toggleOsOption,
}: RenderOsSectionArgs): React.ReactElement {
  return (
    <div
      data-testid="filter-cat-os"
      className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
          <Monitor aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>
            {supportsWindowsTranslation ? '1. OS & Compatibility' : '1. Operating System'}
          </span>
        </div>
        {activeVisibleOsCount > 0 && (
          <span className="text-[10px] text-steam-accent font-semibold">
            {activeVisibleOsCount} selected
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {visibleOsOptions.map((opt) => {
          const isSelected = filterState.osCompatibility.includes(opt.id);
          const count = filterIndex.osCounts[opt.id] ?? 0;
          return (
            <button
              key={opt.id}
              type="button"
              data-testid={`filter-os-${opt.id}`}
              aria-pressed={isSelected}
              onClick={() => toggleOsOption(opt.id)}
              className={`w-full min-h-6 flex items-center justify-between px-2.5 py-2 rounded border text-left transition-all cursor-pointer ${
                isSelected
                  ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
                  : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className={`w-3.5 h-3.5 rounded flex items-center justify-center border shrink-0 ${
                    isSelected
                      ? 'bg-steam-accent border-steam-accent text-black'
                      : 'border-steam-border bg-black/40'
                  }`}
                >
                  {isSelected && <Check aria-hidden="true" className="w-2.5 h-2.5 stroke-[3]" />}
                </div>
                <div className="truncate">
                  <div className="text-xs leading-tight">{opt.label}</div>
                  <div className="text-[10px] text-steam-subtext">{opt.sublabel}</div>
                </div>
              </div>
              <span className="px-1.5 py-0.5 rounded bg-black/40 text-[10px] text-steam-subtext font-mono shrink-0">
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface RenderRatingSectionArgs {
  filterState: LibraryFilterState;
  filterIndex: LibraryFilterIndex;
  onChange: (nextState: LibraryFilterState) => void;
  toggleCriticTier: (tier: CriticTierFilterOption) => void;
  toggleReviewSentiment: (sentiment: ReviewSentimentFilterOption) => void;
}

export function renderRatingAndReviewsSection({
  filterState,
  filterIndex,
  onChange,
  toggleCriticTier,
  toggleReviewSentiment,
}: RenderRatingSectionArgs): React.ReactElement {
  return (
    <div
      data-testid="filter-cat-rating"
      className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
        <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
          <Award aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
          <span>2. Rating &amp; Reviews</span>
        </div>
      </div>

      {/* Critic Tier Pills */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-steam-subtext">
          Critic Tier
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {CRITIC_TIER_OPTIONS.map((tier) => {
            const isSelected = filterState.criticTiers.includes(tier.id);
            const count = filterIndex.criticTierCounts[tier.id] ?? 0;
            return (
              <button
                key={tier.id}
                type="button"
                data-testid={`filter-tier-${tier.id}`}
                aria-pressed={isSelected}
                onClick={() => toggleCriticTier(tier.id)}
                className={`min-h-6 flex items-center justify-between px-2 py-1.5 rounded border text-[11px] transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
                    : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
                }`}
              >
                <span className="truncate">
                  {tier.label}{' '}
                  <span className="text-[10px] text-steam-subtext">({tier.range})</span>
                </span>
                <span className="text-[10px] text-steam-subtext font-mono ml-1">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Minimum Critic Score Segmented Selector */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-steam-subtext">
          Minimum Critic Score
        </div>
        <div className="grid grid-cols-5 gap-1 bg-[#16202d] p-0.5 rounded border border-steam-border/60">
          {MIN_SCORE_OPTIONS.map((score) => {
            const isSelected = filterState.minCriticScore === score;
            const testId = score === null ? 'filter-min-score-any' : `filter-min-score-${score}`;
            return (
              <button
                key={String(score)}
                type="button"
                data-testid={testId}
                aria-pressed={isSelected}
                onClick={() => onChange({ ...filterState, minCriticScore: score })}
                className={`min-h-6 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-steam-accent text-black shadow-sm'
                    : 'text-steam-text hover:text-white'
                }`}
              >
                {score === null ? 'Any' : `${score}+`}
              </button>
            );
          })}
        </div>
      </div>

      {/* Player Review Sentiment Pills */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-steam-subtext">
          Player Review Sentiment
        </div>
        <div className="flex flex-wrap gap-1">
          {REVIEW_SENTIMENT_OPTIONS.map((sent) => {
            const isSelected = filterState.reviewSentiments.includes(sent.id);
            const count = filterIndex.reviewSentimentCounts[sent.id] ?? 0;
            return (
              <button
                key={sent.id}
                type="button"
                data-testid={`filter-review-${sent.id}`}
                aria-pressed={isSelected}
                onClick={() => toggleReviewSentiment(sent.id)}
                className={`min-h-6 inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold'
                    : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
                }`}
              >
                <span>{sent.label}</span>
                <span className="text-steam-subtext font-mono">({count})</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
