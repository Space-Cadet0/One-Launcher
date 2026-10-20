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
  bounds?: { minYear: number; maxYear: number }
): number {
  if (!state) return 0;
  return (
    state.osCompatibility.length +
    state.criticTiers.length +
    (state.minCriticScore !== null ? 1 : 0) +
    state.reviewSentiments.length +
    state.genres.length +
    state.features.length +
    (isReleaseYearRangeActive(state.releaseYearRange, bounds) ? 1 : 0) +
    state.creators.length
  );
}

export function isLibraryFilterActive(
  state: LibraryFilterState,
  bounds?: { minYear: number; maxYear: number }
): boolean {
  return countActiveFilterCriteria(state, bounds) > 0;
}

function mapFeatureKeyword(target: string): FeatureFilterOption | null {
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

  if (filter.type === 'os') {
    if (
      target === 'mac' ||
      target === 'macos' ||
      target === 'mac os' ||
      target === 'osx' ||
      target === 'apple' ||
      target === 'mac_native'
    ) {
      if (!base.osCompatibility.includes('mac_native')) {
        base.osCompatibility.push('mac_native');
      }
    } else if (
      target === 'windows' ||
      target === 'win' ||
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

  if (filter.type === 'opencritic' || filter.type === 'rating' || filter.type === 'critic') {
    const tiers: CriticTierFilterOption[] = ['mighty', 'strong', 'fair', 'weak'];
    for (const tier of tiers) {
      if (target === tier || target.includes(tier)) {
        if (!base.criticTiers.includes(tier)) {
          base.criticTiers.push(tier);
        }
      }
    }
    const numMatch = target.match(/\b(\d{2,3})\b/);
    if (numMatch) {
      const score = Number(numMatch[1]);
      if (score >= 1 && score <= 100) {
        base.minCriticScore = score;
      }
    }
    return base;
  }

  if (filter.type === 'review') {
    let sentiment: ReviewSentimentFilterOption | null = null;
    if (target.includes('overwhelmingly') || target === 'overwhelmingly_positive') {
      sentiment = 'overwhelmingly_positive';
    } else if (target.includes('very') || target === 'very_positive') {
      sentiment = 'very_positive';
    } else if (target.includes('mostly') || target === 'mostly_positive' || target === 'positive') {
      sentiment = 'mostly_positive';
    } else if (target.includes('mixed')) {
      sentiment = 'mixed';
    } else if (target.includes('negative')) {
      sentiment = 'negative';
    }
    if (sentiment && !base.reviewSentiments.includes(sentiment)) {
      base.reviewSentiments.push(sentiment);
    }
    return base;
  }

  if (filter.type === 'developer' || filter.type === 'publisher') {
    pushUniqueCaseInsensitive(base.creators, rawVal);
    return base;
  }

  if (filter.type === 'feature') {
    const feat = mapFeatureKeyword(target);
    if (feat && !base.features.includes(feat)) {
      base.features.push(feat);
    }
    return base;
  }

  if (filter.type === 'genre') {
    pushUniqueCaseInsensitive(base.genres, rawVal);
    return base;
  }

  if (filter.type === 'tag') {
    const feat = mapFeatureKeyword(target);
    if (feat) {
      if (!base.features.includes(feat)) {
        base.features.push(feat);
      }
    } else {
      pushUniqueCaseInsensitive(base.genres, rawVal);
    }
    return base;
  }

  return base;
}

