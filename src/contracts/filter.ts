import { getHostCapabilities } from './hostPlatform';

export type FilterType =
  | 'developer'
  | 'publisher'
  | 'genre'
  | 'tag'
  | 'feature'
  | 'opencritic'
  | 'rating'
  | 'critic'
  | 'review'
  | 'franchise'
  | 'platform'
  | 'os'
  | 'status';

export interface ActiveGameFilter {
  type: FilterType;
  label: string; // e.g. 'Developer', 'Publisher', 'Genre', 'Tag', 'Feature', 'Rating', 'Reviews', 'Native OS'
  value: string; // e.g. 'Larian Studios', 'HDR available', 'Mighty', 'Mostly Positive', 'RPG', 'mac', 'windows'
}

export type OsCompatibilityFilterOption = 'mac_native' | 'windows_native' | 'mac_compat_layer';
export type CriticTierFilterOption = 'mighty' | 'strong' | 'fair' | 'weak';
export type ReviewSentimentFilterOption =
  | 'overwhelmingly_positive'
  | 'very_positive'
  | 'mostly_positive'
  | 'mixed'
  | 'negative';
export type FeatureFilterOption =
  | 'singleplayer'
  | 'coop'
  | 'multiplayer'
  | 'controller'
  | 'cloud_saves'
  | 'achievements'
  | 'hdr';

export interface LibraryFilterState {
  // Category 1: OS & Compatibility
  osCompatibility: OsCompatibilityFilterOption[];
  // Category 2: Rating
  criticTiers: CriticTierFilterOption[];
  minCriticScore: number | null; // e.g. 60, 70, 80, 90
  reviewSentiments: ReviewSentimentFilterOption[];
  // Category 3: Genres
  genres: string[];
  genreMatchMode: 'any' | 'all';
  // Category 4: Features & Capabilities
  features: FeatureFilterOption[];
  // Category 5: Release Date (Two-Point From/To Year Slider + optional includeUnknownReleaseYear)
  releaseYearRange: [number, number] | null; // [fromYear, toYear]
  includeUnknownReleaseYear: boolean;
  // Category 6: Creator (Developers & Publishers)
  creators: string[];
  // Category 7: Tags
  tags: string[];
  tagMatchMode: 'any' | 'all';
}

export const DEFAULT_LIBRARY_FILTER_STATE: LibraryFilterState = {
  osCompatibility: [],
  criticTiers: [],
  minCriticScore: null,
  reviewSentiments: [],
  genres: [],
  genreMatchMode: 'any',
  features: [],
  releaseYearRange: null,
  includeUnknownReleaseYear: true,
  creators: [],
  tags: [],
  tagMatchMode: 'any',
};

export function isReleaseYearRangeActive(
  range: [number, number] | null,
  bounds?: { minYear: number; maxYear: number }
): boolean {
  if (!range) return false;
  const fromYear = Math.min(range[0], range[1]);
  const toYear = Math.max(range[0], range[1]);
  if (!bounds) return true;
  return fromYear > bounds.minYear || toYear < bounds.maxYear;
}

export function countActiveFilterCriteria(
  state: LibraryFilterState,
  bounds?: { minYear: number; maxYear: number },
  options?: { supportsWindowsTranslation?: boolean }
): number {
  if (!state) return 0;
  const supportsWindowsTranslation =
    options?.supportsWindowsTranslation ?? getHostCapabilities().supportsWindowsTranslation;
  const osCount = supportsWindowsTranslation
    ? state.osCompatibility.length
    : state.osCompatibility.filter((opt) => opt !== 'mac_compat_layer').length;
  return (
    osCount +
    state.criticTiers.length +
    (state.minCriticScore !== null ? 1 : 0) +
    state.reviewSentiments.length +
    state.genres.length +
    state.features.length +
    (isReleaseYearRangeActive(state.releaseYearRange, bounds) ? 1 : 0) +
    state.creators.length +
    (state.tags?.length ?? 0)
  );
}

export function isLibraryFilterActive(
  state: LibraryFilterState,
  bounds?: { minYear: number; maxYear: number },
  options?: { supportsWindowsTranslation?: boolean }
): boolean {
  return countActiveFilterCriteria(state, bounds, options) > 0;
}

export const UNMAPPED_LIBRARY_FILTER_TYPES: ReadonlySet<FilterType> = new Set<FilterType>([
  'franchise',
  'platform',
  'status',
]);

export function isMappedLibraryFilterType(type: FilterType): boolean {
  return !UNMAPPED_LIBRARY_FILTER_TYPES.has(type);
}

export function mapFeatureKeyword(target: string): FeatureFilterOption | null {
  if (/single-?player/i.test(target)) return 'singleplayer';
  if (/\bco-?op\b|coop/i.test(target)) return 'coop';
  if (/multi-?player|\bpvp\b|online pvp|lan pvp|cross-platform multiplayer/i.test(target)) {
    return 'multiplayer';
  }
  if (/controller|gamepad/i.test(target)) return 'controller';
  if (/steam cloud|cloud saves?|\bcloud\b/i.test(target)) return 'cloud_saves';
  if (/achievements?/i.test(target)) return 'achievements';
  if (/\bhdr\b/i.test(target)) return 'hdr';
  return null;
}

export function activeGameFilterToLibraryFilterState(
  filter: ActiveGameFilter | null,
  prev: LibraryFilterState = DEFAULT_LIBRARY_FILTER_STATE,
  additive = false
): LibraryFilterState {
  const base: LibraryFilterState = additive
    ? {
        ...prev,
        osCompatibility: [...prev.osCompatibility],
        criticTiers: [...prev.criticTiers],
        reviewSentiments: [...prev.reviewSentiments],
        genres: [...prev.genres],
        features: [...prev.features],
        releaseYearRange: prev.releaseYearRange ? [prev.releaseYearRange[0], prev.releaseYearRange[1]] : null,
        creators: [...prev.creators],
        tags: [...(prev.tags || [])],
        tagMatchMode: prev.tagMatchMode ?? 'any',
      }
    : {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: [],
        criticTiers: [],
        reviewSentiments: [],
        genres: [],
        features: [],
        releaseYearRange: null,
        creators: [],
        tags: [],
        tagMatchMode: 'any',
      };

  if (!filter || !filter.value?.trim()) {
    return base;
  }

  const rawVal = filter.value.trim();
  const target = rawVal.toLowerCase();

  const pushUniqueCaseInsensitive = (arr: string[], val: string) => {
    const lower = val.toLowerCase().trim();
    if (!arr.some((item) => item.toLowerCase().trim() === lower)) {
      arr.push(val);
    }
  };

  switch (filter.type) {
    case 'os': {
      if (
        target === 'mac' ||
        target === 'macos' ||
        target === 'mac os' ||
        target === 'osx' ||
        target === 'darwin' ||
        target === 'apple' ||
        target === 'mac_native'
      ) {
        if (!base.osCompatibility.includes('mac_native')) {
          base.osCompatibility.push('mac_native');
        }
      } else if (
        target === 'windows' ||
        target === 'win' ||
        target === 'win32' ||
        target === 'pc' ||
        target === 'windows_native'
      ) {
        if (!base.osCompatibility.includes('windows_native')) {
          base.osCompatibility.push('windows_native');
        }
      } else if (
        target.includes('crossover') ||
        target.includes('wine') ||
        target.includes('gptk') ||
        target.includes('compat')
      ) {
        if (!base.osCompatibility.includes('mac_compat_layer')) {
          base.osCompatibility.push('mac_compat_layer');
        }
      }
      return base;
    }

    case 'opencritic':
    case 'rating':
    case 'critic': {
      const tiers: CriticTierFilterOption[] = ['mighty', 'strong', 'fair', 'weak'];
      for (const tier of tiers) {
        if (target === tier || target.includes(tier)) {
          if (!base.criticTiers.includes(tier)) {
            base.criticTiers.push(tier);
          }
        }
      }
      const numMatch = target.match(/\b(\d{1,3})\b/);
      if (numMatch) {
        const score = Number(numMatch[1]);
        if (score >= 1 && score <= 100) {
          base.minCriticScore = score;
        }
      }
      return base;
    }

    case 'review': {
      let sentiment: ReviewSentimentFilterOption | null = null;
      // Check 'negative' BEFORE 'overwhelmingly'/'very'/'mostly' so Steam's
      // 'Overwhelmingly Negative' / 'Very Negative' / 'Mostly Negative' map to 'negative'.
      if (target.includes('negative')) {
        sentiment = 'negative';
      } else if (target.includes('overwhelmingly') || target === 'overwhelmingly_positive') {
        sentiment = 'overwhelmingly_positive';
      } else if (target.includes('very') || target === 'very_positive') {
        sentiment = 'very_positive';
      } else if (target.includes('mostly') || target === 'mostly_positive' || target === 'positive') {
        sentiment = 'mostly_positive';
      } else if (target.includes('mixed')) {
        sentiment = 'mixed';
      }
      if (sentiment && !base.reviewSentiments.includes(sentiment)) {
        base.reviewSentiments.push(sentiment);
      }
      return base;
    }

    case 'developer':
    case 'publisher': {
      pushUniqueCaseInsensitive(base.creators, rawVal);
      return base;
    }

    case 'feature': {
      const feat = mapFeatureKeyword(target);
      if (feat && !base.features.includes(feat)) {
        base.features.push(feat);
      }
      return base;
    }

    case 'genre': {
      pushUniqueCaseInsensitive(base.genres, rawVal);
      return base;
    }

    case 'tag': {
      pushUniqueCaseInsensitive(base.tags, rawVal);
      return base;
    }

    case 'franchise':
    case 'platform':
    case 'status': {
      // Evaluated directly by `matchesGameFilter(game, activeFilter)` rather than
      // `LibraryFilterState` facet arrays. Handled explicitly so exhaustiveness checks
      // prevent any future `FilterType` from being silently ignored.
      return base;
    }

    default: {
      const _exhaustiveCheck: never = filter.type;
      return _exhaustiveCheck;
    }
  }
}

/**
 * Returns true if `activeFilter` is still faithfully represented by `nextState`.
 * Returns false when all criteria are cleared, when the facet mirrored from `activeFilter`
 * is removed, or when an OR-evaluated category is broadened beyond the single `activeFilter`
 * value so `App.tsx` clears the stale `activeFilter` instead of trapping the grid.
 */
export function doesLibraryFilterStateStillMatchActiveFilter(
  activeFilter: ActiveGameFilter | null,
  nextState: LibraryFilterState,
  bounds?: { minYear: number; maxYear: number }
): boolean {
  if (!activeFilter) return true;
  if (countActiveFilterCriteria(nextState, bounds) === 0) {
    return false;
  }

  const mapped = activeGameFilterToLibraryFilterState(activeFilter);
  if (countActiveFilterCriteria(mapped, undefined, { supportsWindowsTranslation: true }) === 0) {
    return true;
  }

  const hasAllNormalized = (haystack: readonly string[] | undefined, needles: readonly string[]) => {
    const set = new Set((haystack || []).map((v) => v.toLowerCase().trim()).filter(Boolean));
    return needles.every((n) => set.has(n.toLowerCase().trim()));
  };

  if (mapped.osCompatibility.length > 0) {
    if (
      !mapped.osCompatibility.every((opt) => nextState.osCompatibility.includes(opt)) ||
      nextState.osCompatibility.length > mapped.osCompatibility.length
    ) {
      return false;
    }
  }

  if (mapped.criticTiers.length > 0) {
    if (
      !mapped.criticTiers.every((tier) => nextState.criticTiers.includes(tier)) ||
      nextState.criticTiers.length > mapped.criticTiers.length
    ) {
      return false;
    }
  }

  if (mapped.minCriticScore !== null && nextState.minCriticScore !== mapped.minCriticScore) {
    return false;
  }

  if (mapped.reviewSentiments.length > 0) {
    if (
      !mapped.reviewSentiments.every((sent) => nextState.reviewSentiments.includes(sent)) ||
      nextState.reviewSentiments.length > mapped.reviewSentiments.length
    ) {
      return false;
    }
  }

  if (mapped.genres.length > 0) {
    if (!hasAllNormalized(nextState.genres, mapped.genres)) {
      return false;
    }
    if (nextState.genreMatchMode !== 'all' && nextState.genres.length > mapped.genres.length) {
      return false;
    }
  }

  if (mapped.features.length > 0) {
    if (!mapped.features.every((feat) => nextState.features.includes(feat))) {
      return false;
    }
  }

  if (mapped.creators.length > 0) {
    if (
      !hasAllNormalized(nextState.creators, mapped.creators) ||
      nextState.creators.length > mapped.creators.length
    ) {
      return false;
    }
  }

  if (mapped.tags.length > 0) {
    const nextTags = nextState.tags || [];
    if (!hasAllNormalized(nextTags, mapped.tags)) {
      return false;
    }
    if ((nextState.tagMatchMode ?? 'any') !== 'all' && nextTags.length > mapped.tags.length) {
      return false;
    }
  }

  return true;
}

