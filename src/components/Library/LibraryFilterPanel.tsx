import React, { useState, useMemo } from 'react';
import {
  LibraryFilterState,
  DEFAULT_LIBRARY_FILTER_STATE,
  OsCompatibilityFilterOption,
  CriticTierFilterOption,
  ReviewSentimentFilterOption,
  FeatureFilterOption,
  isReleaseYearRangeActive,
  countActiveFilterCriteria,
} from '../../contracts/filter';
import { LibraryFilterIndex } from '../../services/filter/libraryFilterIndex';
import {
  Monitor,
  Award,
  Tags,
  Sparkles,
  Calendar,
  Building2,
  RotateCcw,
  X,
  Search,
  Check,
} from 'lucide-react';

export interface LibraryFilterPanelProps {
  filterState: LibraryFilterState;
  onChange: (nextState: LibraryFilterState) => void;
  onReset: () => void;
  filterIndex: LibraryFilterIndex;
  filteredCount: number;
  totalCount: number;
  onClose?: () => void;
}

const OS_OPTIONS: {
  id: OsCompatibilityFilterOption;
  label: string;
  sublabel: string;
}[] = [
  { id: 'mac_native', label: 'macOS Native', sublabel: 'Apple Silicon / Intel' },
  { id: 'windows_native', label: 'Windows Native', sublabel: 'PC Direct' },
  { id: 'mac_compat_layer', label: 'CrossOver / Wine (Mac)', sublabel: 'Compatibility Layer' },
];

const CRITIC_TIER_OPTIONS: {
  id: CriticTierFilterOption;
  label: string;
  range: string;
  badgeClass: string;
}[] = [
  {
    id: 'mighty',
    label: 'Mighty',
    range: '84+',
    badgeClass: 'border-amber-500/50 text-amber-300 bg-amber-500/10',
  },
  {
    id: 'strong',
    label: 'Strong',
    range: '75–83',
    badgeClass: 'border-purple-500/50 text-purple-300 bg-purple-500/10',
  },
  {
    id: 'fair',
    label: 'Fair',
    range: '60–74',
    badgeClass: 'border-sky-500/50 text-sky-300 bg-sky-500/10',
  },
  {
    id: 'weak',
    label: 'Weak',
    range: '<60',
    badgeClass: 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10',
  },
];

const MIN_SCORE_OPTIONS: (number | null)[] = [null, 60, 70, 80, 90];

const REVIEW_SENTIMENT_OPTIONS: {
  id: ReviewSentimentFilterOption;
  label: string;
}[] = [
  { id: 'overwhelmingly_positive', label: 'Overwhelmingly Positive' },
  { id: 'very_positive', label: 'Very Positive' },
  { id: 'mostly_positive', label: 'Mostly Positive' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'negative', label: 'Negative' },
];

const FEATURE_OPTIONS: {
  id: FeatureFilterOption;
  label: string;
}[] = [
  { id: 'singleplayer', label: 'Single-player' },
  { id: 'coop', label: 'Co-op' },
  { id: 'multiplayer', label: 'Multiplayer / PvP' },
  { id: 'controller', label: 'Controller Support' },
  { id: 'cloud_saves', label: 'Cloud Saves' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'hdr', label: 'HDR' },
];

export const LibraryFilterPanel: React.FC<LibraryFilterPanelProps> = ({
  filterState = DEFAULT_LIBRARY_FILTER_STATE,
  onChange,
  onReset,
  filterIndex,
  filteredCount,
  totalCount,
  onClose,
}) => {
  const [genreSearch, setGenreSearch] = useState('');
  const [creatorSearch, setCreatorSearch] = useState('');

  const minYear = filterIndex.minReleaseYear;
  const maxYear = Math.max(filterIndex.minReleaseYear, filterIndex.maxReleaseYear);
  const yearBounds = useMemo(() => ({ minYear, maxYear }), [minYear, maxYear]);

  const activeCriteriaCount = countActiveFilterCriteria(filterState, yearBounds);

  const fromYear = filterState.releaseYearRange
    ? Math.max(minYear, Math.min(filterState.releaseYearRange[0], filterState.releaseYearRange[1]))
    : minYear;
  const toYear = filterState.releaseYearRange
    ? Math.min(maxYear, Math.max(filterState.releaseYearRange[0], filterState.releaseYearRange[1]))
    : maxYear;

  const yearSpan = Math.max(1, maxYear - minYear);
  const fromPct = Math.max(0, Math.min(100, ((fromYear - minYear) / yearSpan) * 100));
  const toPct = Math.max(0, Math.min(100, ((toYear - minYear) / yearSpan) * 100));
  const isYearFilterActive = isReleaseYearRangeActive(filterState.releaseYearRange, yearBounds);

  const toggleOsOption = (opt: OsCompatibilityFilterOption) => {
    const exists = filterState.osCompatibility.includes(opt);
    const next = exists
      ? filterState.osCompatibility.filter((item) => item !== opt)
      : [...filterState.osCompatibility, opt];
    onChange({ ...filterState, osCompatibility: next });
  };

  const toggleCriticTier = (tier: CriticTierFilterOption) => {
    const exists = filterState.criticTiers.includes(tier);
    const next = exists
      ? filterState.criticTiers.filter((item) => item !== tier)
      : [...filterState.criticTiers, tier];
    onChange({ ...filterState, criticTiers: next });
  };

  const toggleReviewSentiment = (sentiment: ReviewSentimentFilterOption) => {
    const exists = filterState.reviewSentiments.includes(sentiment);
    const next = exists
      ? filterState.reviewSentiments.filter((item) => item !== sentiment)
      : [...filterState.reviewSentiments, sentiment];
    onChange({ ...filterState, reviewSentiments: next });
  };

  const toggleGenre = (genreKey: string) => {
    const lower = genreKey.toLowerCase().trim();
    const exists = filterState.genres.some((g) => g.toLowerCase().trim() === lower);
    const next = exists
      ? filterState.genres.filter((g) => g.toLowerCase().trim() !== lower)
      : [...filterState.genres, lower];
    onChange({ ...filterState, genres: next });
  };

  const toggleFeature = (feat: FeatureFilterOption) => {
    const exists = filterState.features.includes(feat);
    const next = exists
      ? filterState.features.filter((f) => f !== feat)
      : [...filterState.features, feat];
    onChange({ ...filterState, features: next });
  };

  const toggleCreator = (creatorKey: string) => {
    const lower = creatorKey.toLowerCase().trim();
    const exists = filterState.creators.some((c) => c.toLowerCase().trim() === lower);
    const next = exists
      ? filterState.creators.filter((c) => c.toLowerCase().trim() !== lower)
      : [...filterState.creators, lower];
    onChange({ ...filterState, creators: next });
  };

  const applyEraPreset = (presetFrom: number | null, presetTo: number | null) => {
    if (presetFrom === null || presetTo === null) {
      onChange({ ...filterState, releaseYearRange: null });
      return;
    }
    const clampedFrom = Math.max(minYear, Math.min(maxYear, presetFrom));
    const clampedTo = Math.max(clampedFrom, Math.min(maxYear, presetTo));
    const nextRange: [number, number] | null =
      clampedFrom <= minYear && clampedTo >= maxYear ? null : [clampedFrom, clampedTo];
    onChange({ ...filterState, releaseYearRange: nextRange });
  };

  const filteredGenres = useMemo(() => {
    const q = genreSearch.trim().toLowerCase();
    if (!q) return filterIndex.genreCounts;
    return filterIndex.genreCounts.filter(
      (g) => g.label.toLowerCase().includes(q) || g.key.includes(q)
    );
  }, [filterIndex.genreCounts, genreSearch]);

  const filteredCreators = useMemo(() => {
    const q = creatorSearch.trim().toLowerCase();
    if (!q) return filterIndex.creatorCounts;
    return filterIndex.creatorCounts.filter(
      (c) => c.name.toLowerCase().includes(q) || c.key.includes(q)
    );
  }, [filterIndex.creatorCounts, creatorSearch]);

  return (
    <div
      data-testid="library-filter-panel"
      className="w-full rounded-lg bg-[#131b26] border border-steam-border/80 shadow-2xl overflow-hidden text-xs text-steam-text animate-in fade-in duration-150"
    >
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-[#172130] border-b border-steam-border/70">
        <div className="flex items-center gap-2.5">
          <span className="font-bold text-white uppercase tracking-wider text-[11px]">
            Library Filters
          </span>
          <span className="text-steam-subtext">•</span>
          <span className="text-steam-subtext">
            Showing <strong className="text-white">{filteredCount}</strong> of{' '}
            <strong className="text-white">{totalCount}</strong> games
          </span>
          {activeCriteriaCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-steam-accent/20 border border-steam-accent/40 text-steam-accent font-semibold text-[11px]">
              {activeCriteriaCount} active
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="filter-panel-reset-btn"
            onClick={onReset}
            disabled={activeCriteriaCount === 0}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#1e2b3c] hover:bg-[#28394f] disabled:opacity-40 disabled:pointer-events-none text-steam-text hover:text-white border border-steam-border/70 font-semibold text-[11px] transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3 h-3 text-steam-accent" />
            <span>Reset All</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer"
              title="Close filter panel"
              aria-label="Close filter panel"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 6-Category Responsive Facet Grid */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* Category 1: OS & Compatibility */}
        <div
          data-testid="filter-cat-os"
          className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
              <Monitor className="w-3.5 h-3.5 text-steam-accent" />
              <span>1. OS &amp; Compatibility</span>
            </div>
            {filterState.osCompatibility.length > 0 && (
              <span className="text-[10px] text-steam-accent font-semibold">
                {filterState.osCompatibility.length} selected
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {OS_OPTIONS.map((opt) => {
              const isSelected = filterState.osCompatibility.includes(opt.id);
              const count = filterIndex.osCounts[opt.id] ?? 0;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`filter-os-${opt.id}`}
                  onClick={() => toggleOsOption(opt.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded border text-left transition-all cursor-pointer ${
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
                      {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
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

        {/* Category 2: Rating */}
        <div
          data-testid="filter-cat-rating"
          className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-3"
        >
          <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
              <Award className="w-3.5 h-3.5 text-steam-accent" />
              <span>2. Rating &amp; Reviews</span>
            </div>
          </div>

          {/* Critic Tier Pills */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-steam-subtext">
              OpenCritic Tier
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
                    onClick={() => toggleCriticTier(tier.id)}
                    className={`flex items-center justify-between px-2 py-1.5 rounded border text-[11px] transition-all cursor-pointer ${
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
                const testId =
                  score === null ? 'filter-min-score-any' : `filter-min-score-${score}`;
                return (
                  <button
                    key={String(score)}
                    type="button"
                    data-testid={testId}
                    onClick={() => onChange({ ...filterState, minCriticScore: score })}
                    className={`py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
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
                    onClick={() => toggleReviewSentiment(sent.id)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] transition-all cursor-pointer ${
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

        {/* Category 3: Genres */}
        <div
          data-testid="filter-cat-genres"
          className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
              <Tags className="w-3.5 h-3.5 text-steam-accent" />
              <span>3. Genres</span>
            </div>
            {/* ANY / ALL Match Mode Toggle */}
            <div className="inline-flex items-center rounded bg-[#16202d] border border-steam-border/60 p-0.5 text-[10px]">
              <button
                type="button"
                data-testid="filter-genre-mode-any"
                onClick={() => onChange({ ...filterState, genreMatchMode: 'any' })}
                className={`px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer ${
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
                onClick={() => onChange({ ...filterState, genreMatchMode: 'all' })}
                className={`px-2 py-0.5 rounded font-semibold transition-colors cursor-pointer ${
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
            <Search className="w-3 h-3 text-steam-subtext absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              data-testid="filter-genre-search"
              value={genreSearch}
              onChange={(e) => setGenreSearch(e.target.value)}
              placeholder="Search genres..."
              className="w-full bg-[#16202d] border border-steam-border/60 rounded pl-7 pr-2.5 py-1 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent"
            />
          </div>

          {/* Scrollable Multi-Select Genre List */}
          <div className="max-h-44 overflow-y-auto pr-1 flex flex-wrap gap-1.5">
            {filteredGenres.length === 0 ? (
              <div className="text-[11px] text-steam-subtext italic py-2">No matching genres</div>
            ) : (
              filteredGenres.map((genre) => {
                const isSelected = filterState.genres.some(
                  (g) => g.toLowerCase().trim() === genre.key
                );
                return (
                  <button
                    key={genre.key}
                    type="button"
                    data-testid={`filter-genre-${genre.key}`}
                    onClick={() => toggleGenre(genre.key)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-steam-accent/20 border-steam-accent text-white font-semibold shadow-sm'
                        : 'bg-[#16202d]/70 border-steam-border/50 text-steam-text hover:border-steam-accent/50 hover:text-white'
                    }`}
                  >
                    <span>{genre.label}</span>
                    <span className="text-[10px] text-steam-subtext font-mono">
                      ({genre.count})
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Category 4: Features & Capabilities */}
        <div
          data-testid="filter-cat-features"
          className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
              <Sparkles className="w-3.5 h-3.5 text-steam-accent" />
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
                  onClick={() => toggleFeature(feat.id)}
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded border text-[11px] transition-all cursor-pointer ${
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

        {/* Category 5: Release Date — To / From Two-Point Slider */}
        <div
          data-testid="filter-cat-release-date"
          className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-3"
        >
          <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
              <Calendar className="w-3.5 h-3.5 text-steam-accent" />
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
              {/* Background Track */}
              <div className="h-1.5 w-full rounded-full bg-[#1a222f]" />
              {/* Active Highlighted Range Bar */}
              <div
                className="bg-[#66c0f4] h-1.5 rounded-full absolute pointer-events-none"
                style={{
                  left: `${fromPct}%`,
                  width: `${Math.max(0, toPct - fromPct)}%`,
                }}
              />
              {/* From Slider */}
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
              {/* To Slider */}
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
                era.to !== null
                  ? Math.max(expectedFrom, Math.min(maxYear, era.to))
                  : maxYear;
              const isSelected = isAll
                ? !isYearFilterActive
                : isYearFilterActive && fromYear === expectedFrom && toYear === expectedTo;
              return (
                <button
                  key={era.label}
                  type="button"
                  onClick={() => applyEraPreset(era.from, era.to)}
                  className={`px-2 py-0.5 rounded border text-[10px] font-semibold transition-colors cursor-pointer ${
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
          <label className="inline-flex items-center gap-2 text-[11px] text-steam-subtext hover:text-white cursor-pointer select-none pt-0.5">
            <input
              type="checkbox"
              data-testid="release-year-include-unknown"
              checked={filterState.includeUnknownReleaseYear}
              onChange={(e) =>
                onChange({
                  ...filterState,
                  includeUnknownReleaseYear: e.target.checked,
                })
              }
              className="rounded border-steam-border bg-[#16202d] text-steam-accent focus:ring-0 cursor-pointer"
            />
            <span>
              Include games with unknown release date ({filterIndex.unknownReleaseYearCount})
            </span>
          </label>
        </div>

        {/* Category 6: Creator (Developers & Publishers) */}
        <div
          data-testid="filter-cat-creator"
          className="rounded-md bg-[#0f1620] border border-steam-border/50 p-3.5 flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
            <div className="flex items-center gap-1.5 font-bold text-white uppercase tracking-wider text-[11px]">
              <Building2 className="w-3.5 h-3.5 text-steam-accent" />
              <span>6. Creator</span>
            </div>
            {filterState.creators.length > 0 && (
              <span className="text-[10px] text-steam-accent font-semibold">
                {filterState.creators.length} selected
              </span>
            )}
          </div>

          {/* Search Creators Input */}
          <div className="relative">
            <Search className="w-3 h-3 text-steam-subtext absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              data-testid="filter-creator-search"
              value={creatorSearch}
              onChange={(e) => setCreatorSearch(e.target.value)}
              placeholder="Search developers or publishers..."
              className="w-full bg-[#16202d] border border-steam-border/60 rounded pl-7 pr-2.5 py-1 text-xs text-white placeholder-steam-subtext focus:outline-none focus:border-steam-accent"
            />
          </div>

          {/* Scrollable Multi-Select Creator List */}
          <div className="max-h-44 overflow-y-auto pr-1 flex flex-col gap-1">
            {filteredCreators.length === 0 ? (
              <div className="text-[11px] text-steam-subtext italic py-2">
                No matching developers or publishers
              </div>
            ) : (
              filteredCreators.map((creator) => {
                const isSelected = filterState.creators.some(
                  (c) => c.toLowerCase().trim() === creator.key
                );
                const roleLabel =
                  creator.role === 'both'
                    ? 'Dev & Pub'
                    : creator.role === 'developer'
                      ? 'Dev'
                      : 'Pub';
                return (
                  <button
                    key={creator.key}
                    type="button"
                    data-testid={`filter-creator-${creator.key}`}
                    onClick={() => toggleCreator(creator.key)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded border text-left text-[11px] transition-all cursor-pointer ${
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
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
