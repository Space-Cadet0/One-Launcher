import React, { useState, useMemo, useRef, useEffect } from 'react';
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
import { launcherService } from '../../services/launcher/launcherService';
import { normalizeTagKey } from '../../services/tags/gameTagResolver';
import { useSafeDeferredValue, useSafeId } from '../../utils/useSafeId';
import { RotateCcw, X } from 'lucide-react';
import { OS_OPTIONS, TAG_PREVIEW_LIMIT } from './FilterPanel/filterPanelConstants';
import {
  renderOsCompatibilitySection,
  renderRatingAndReviewsSection,
} from './FilterPanel/FilterOsAndRatingSections';
import {
  renderFeaturesSection,
  renderGenresSection,
} from './FilterPanel/FilterGenresAndFeaturesSections';
import { renderReleaseDateSection } from './FilterPanel/FilterReleaseDateSection';
import {
  renderCreatorSection,
  renderTagsSection,
} from './FilterPanel/FilterCreatorAndTagsSections';

export interface LibraryFilterPanelProps {
  filterState: LibraryFilterState;
  onChange: (nextState: LibraryFilterState) => void;
  onReset: () => void;
  filterIndex: LibraryFilterIndex;
  filteredCount: number;
  totalCount: number;
  onClose?: () => void;
}

export const LibraryFilterPanel: React.FC<LibraryFilterPanelProps> = ({
  filterState = DEFAULT_LIBRARY_FILTER_STATE,
  onChange,
  onReset,
  filterIndex,
  filteredCount,
  totalCount,
  onClose,
}) => {
  const genreSearchInputId = useSafeId('filter-genre-search');
  const creatorSearchInputId = useSafeId('filter-creator-search');
  const tagSearchInputId = useSafeId('filter-tag-search');
  const includeUnknownYearId = useSafeId('release-year-include-unknown');

  const [genreSearch, setGenreSearch] = useState('');
  const [creatorSearch, setCreatorSearch] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const deferredTagSearch = useSafeDeferredValue(tagSearch);
  const [showAllTags, setShowAllTags] = useState(false);
  const [creatorScrollHeight, setCreatorScrollHeight] = useState(0);
  const creatorScrollRef = useRef<HTMLDivElement | null>(null);

  const supportsWindowsTranslation =
    launcherService.getHostCapabilities().supportsWindowsTranslation;
  const visibleOsOptions = useMemo(
    () =>
      supportsWindowsTranslation
        ? OS_OPTIONS
        : OS_OPTIONS.filter((opt) => opt.id !== 'mac_compat_layer'),
    [supportsWindowsTranslation]
  );

  useEffect(() => {
    const el = creatorScrollRef.current;
    if (!el) return;
    const syncHeight = () => {
      const next = el.clientHeight || 0;
      setCreatorScrollHeight((prev) => (prev === next ? prev : next));
    };
    syncHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const minYear = filterIndex.minReleaseYear;
  const maxYear = Math.max(filterIndex.minReleaseYear, filterIndex.maxReleaseYear);
  const yearBounds = useMemo(() => ({ minYear, maxYear }), [minYear, maxYear]);

  const activeVisibleOsCount = supportsWindowsTranslation
    ? filterState.osCompatibility.length
    : filterState.osCompatibility.filter((opt) => opt !== 'mac_compat_layer').length;
  const activeCriteriaCount = countActiveFilterCriteria(filterState, yearBounds, {
    supportsWindowsTranslation,
  });

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

  const selectedTags = filterState.tags || [];
  const tagMatchMode = filterState.tagMatchMode ?? 'any';

  const toggleTag = (tagKey: string) => {
    const key = normalizeTagKey(tagKey);
    if (!key) return;
    const exists = selectedTags.some((t) => normalizeTagKey(t) === key);
    const next = exists
      ? selectedTags.filter((t) => normalizeTagKey(t) !== key)
      : [...selectedTags, key];
    onChange({ ...filterState, tags: next });
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

  const selectedCreatorSet = useMemo(
    () => new Set(filterState.creators.map((c) => c.toLowerCase().trim())),
    [filterState.creators]
  );

  const selectedTagKeySet = useMemo(
    () => new Set(selectedTags.map((t) => normalizeTagKey(t)).filter(Boolean)),
    [selectedTags]
  );

  const allTagCounts = filterIndex.tagCounts || [];
  const normalizedTagQuery = deferredTagSearch.trim().toLowerCase();

  const filteredTags = useMemo(() => {
    if (!normalizedTagQuery) return allTagCounts;
    return allTagCounts.filter(
      (t) => t.label.toLowerCase().includes(normalizedTagQuery) || t.key.includes(normalizedTagQuery)
    );
  }, [allTagCounts, normalizedTagQuery]);

  const isTagSearchEmpty = tagSearch.trim() === '' && normalizedTagQuery === '';
  const isTagListCollapsed =
    isTagSearchEmpty && !showAllTags && filteredTags.length > TAG_PREVIEW_LIMIT;

  const visibleTags = useMemo(() => {
    if (!isTagListCollapsed) return filteredTags;
    const topSlice = filteredTags.slice(0, TAG_PREVIEW_LIMIT);
    const topKeySet = new Set(topSlice.map((t) => t.key));
    const extraSelected = filteredTags.filter(
      (t) => selectedTagKeySet.has(t.key) && !topKeySet.has(t.key)
    );
    return extraSelected.length > 0 ? [...topSlice, ...extraSelected] : topSlice;
  }, [filteredTags, isTagListCollapsed, selectedTagKeySet]);

  return (
    <div
      data-testid="library-filter-panel"
      className="w-full rounded-lg bg-[#131b26] border border-steam-border/80 shadow-2xl overflow-hidden text-xs text-steam-text motion-safe:transition-opacity motion-safe:duration-150"
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
            className="min-h-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#1e2b3c] hover:bg-[#28394f] disabled:opacity-40 disabled:pointer-events-none text-steam-text hover:text-white border border-steam-border/70 font-semibold text-[11px] transition-colors cursor-pointer"
          >
            <RotateCcw aria-hidden="true" className="w-3 h-3 text-steam-accent" />
            <span>Reset All</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-w-6 min-h-6 flex items-center justify-center p-1 rounded hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer"
              title="Close filter panel"
              aria-label="Close filter panel"
            >
              <X aria-hidden="true" className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Responsive Facet Grid */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {renderOsCompatibilitySection({
          supportsWindowsTranslation,
          visibleOsOptions,
          activeVisibleOsCount,
          filterState,
          filterIndex,
          toggleOsOption,
        })}

        {renderRatingAndReviewsSection({
          filterState,
          filterIndex,
          onChange,
          toggleCriticTier,
          toggleReviewSentiment,
        })}

        {renderGenresSection({
          genreSearchInputId,
          genreSearch,
          setGenreSearch,
          filteredGenres,
          filterState,
          onChange,
          toggleGenre,
        })}

        {renderFeaturesSection({
          filterState,
          filterIndex,
          toggleFeature,
        })}

        {renderReleaseDateSection({
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
        })}

        {renderCreatorSection({
          creatorSearchInputId,
          creatorSearch,
          setCreatorSearch,
          creatorScrollRef,
          creatorScrollHeight,
          filteredCreators,
          selectedCreatorSet,
          creatorsCount: filterState.creators.length,
          toggleCreator,
        })}

        {renderTagsSection({
          tagSearchInputId,
          tagSearch,
          setTagSearch,
          selectedTagsCount: selectedTags.length,
          tagMatchMode,
          filterState,
          onChange,
          visibleTags,
          filteredTagsCount: filteredTags.length,
          selectedTagKeySet,
          isTagSearchEmpty,
          showAllTags,
          setShowAllTags,
          toggleTag,
        })}
      </div>
    </div>
  );
};
