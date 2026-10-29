import { CanonicalGame } from '../../contracts/game';
import { SteamCategory, SteamReviewSummary } from '../../contracts/steam';
import { OpenCriticData } from '../../contracts/critic';
import {
  CriticTierFilterOption,
  FeatureFilterOption,
  LibraryFilterState,
  OsCompatibilityFilterOption,
  ReviewSentimentFilterOption,
  isLibraryFilterActive,
  isReleaseYearRangeActive,
} from '../../contracts/filter';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { getOpenCriticData } from '../opencritic/openCritic';
import { steamMatcher } from '../steam/steamMatcher';
import {
  getEffectiveCategories,
  getEffectiveTags,
  isGameOwnedOnSteam,
} from '../steam/steamFeatureNormalizer';
import {
  isNativelyAvailableOnMac,
  isNativelyAvailableOnWindows,
  isPureUwpWindowsGame,
} from '../platform/nativeOsService';
import { launcherService } from '../launcher/launcherService';

interface CachedSteamFilterRecord {
  reviewSummary?: Partial<SteamReviewSummary>;
  categories?: SteamCategory[];
  controllerSupport?: string;
  hdrSupport?: boolean;
  achievements?: {
    total?: number;
  };
  genres?: string[];
  releaseDate?: string;
  release_date?: string;
  developers?: string[];
  publishers?: string[];
}

const steamCache = (steamEnrichedCache || {}) as Record<string, CachedSteamFilterRecord>;

export interface GameFilterIndexEntry {
  gameId: string;
  effectiveSteamAppId?: number;
  osFlags: Set<OsCompatibilityFilterOption>;
  criticData: OpenCriticData | null;
  criticScore: number | null;
  criticPercentRecommended: number | null;
  criticTier: CriticTierFilterOption | null;
  reviewSentiment: ReviewSentimentFilterOption | null;
  genresNormalized: Set<string>;
  features: Set<FeatureFilterOption>;
  releaseYear: number | null;
  creatorsNormalized: Set<string>;
}

export interface GenreFacetCount {
  key: string;
  label: string;
  count: number;
}

export interface CreatorFacetCount {
  key: string;
  name: string;
  role: 'developer' | 'publisher' | 'both';
  count: number;
}

export interface LibraryFilterIndex {
  entriesById: Map<string, GameFilterIndexEntry>;
  osCounts: Record<OsCompatibilityFilterOption, number>;
  criticTierCounts: Record<CriticTierFilterOption, number>;
  reviewSentimentCounts: Record<ReviewSentimentFilterOption, number>;
  genreCounts: GenreFacetCount[];
  featureCounts: Record<FeatureFilterOption, number>;
  minReleaseYear: number;
  maxReleaseYear: number;
  unknownReleaseYearCount: number;
  creatorCounts: CreatorFacetCount[];
}

export interface ActiveFilterChipDescriptor {
  id: string;
  category: string;
  label: string;
  remove: (prev: LibraryFilterState) => LibraryFilterState;
}

export type ActiveFilterChip = ActiveFilterChipDescriptor;

const OS_LABELS: Record<OsCompatibilityFilterOption, string> = {
  mac_native: 'Native macOS',
  windows_native: 'Native Windows',
  mac_compat_layer: 'CrossOver / Wine Ready',
};

const CRITIC_TIER_LABELS: Record<CriticTierFilterOption, string> = {
  mighty: 'Mighty (84+)',
  strong: 'Strong (75–83)',
  fair: 'Fair (60–74)',
  weak: 'Weak (<60)',
};

const REVIEW_SENTIMENT_LABELS: Record<ReviewSentimentFilterOption, string> = {
  overwhelmingly_positive: 'Overwhelmingly Positive',
  very_positive: 'Very Positive',
  mostly_positive: 'Mostly Positive',
  mixed: 'Mixed',
  negative: 'Negative',
};

const FEATURE_LABELS: Record<FeatureFilterOption, string> = {
  singleplayer: 'Single-player',
  coop: 'Co-op',
  multiplayer: 'Multiplayer / PvP',
  controller: 'Controller Support',
  cloud_saves: 'Cloud Saves',
  achievements: 'Achievements',
  hdr: 'HDR Available',
};

function parseReleaseYear(rawDate?: string | number | null): number | null {
  if (rawDate === undefined || rawDate === null) return null;
  const str = String(rawDate).trim();
  if (!str || /^(tba|tbd|coming soon|unannounced|unknown)$/i.test(str)) {
    return null;
  }
  const maxAllowedYear = new Date().getFullYear() + 5;
  const match = str.match(/\b(19[7-9]\d|20\d\d)\b/);
  if (!match) return null;
  const yr = parseInt(match[1], 10);
  if (isNaN(yr) || yr < 1970 || yr > maxAllowedYear) {
    return null;
  }
  return yr;
}

function resolveReviewSentiment(
  game: CanonicalGame,
  cachedSteamEntry: CachedSteamFilterRecord | undefined
): ReviewSentimentFilterOption | null {
  const desc = (
    game.reviewSummary?.reviewScoreDesc ||
    game.enrichedMetadata?.reviewSummary?.reviewScoreDesc ||
    cachedSteamEntry?.reviewSummary?.reviewScoreDesc ||
    ''
  )
    .trim()
    .toLowerCase();

  if (desc && desc !== 'no user reviews') {
    if (desc.includes('overwhelmingly positive')) return 'overwhelmingly_positive';
    if (desc.includes('very positive')) return 'very_positive';
    if (desc.includes('mostly positive') || desc === 'positive') return 'mostly_positive';
    if (desc.includes('mixed')) return 'mixed';
    if (desc.includes('negative')) return 'negative';
  }

  const pos =
    game.reviewSummary?.positivePercent ??
    game.enrichedMetadata?.reviewSummary?.positivePercent ??
    cachedSteamEntry?.reviewSummary?.positivePercent;
  const totalReviews =
    game.reviewSummary?.totalReviews ??
    game.enrichedMetadata?.reviewSummary?.totalReviews ??
    cachedSteamEntry?.reviewSummary?.totalReviews ??
    1;

  if (typeof pos === 'number' && pos > 0 && totalReviews > 0) {
    if (pos >= 95) return 'overwhelmingly_positive';
    if (pos >= 80) return 'very_positive';
    if (pos >= 70) return 'mostly_positive';
    if (pos >= 40) return 'mixed';
    return 'negative';
  }

  return null;
}

function resolveCriticTierOption(tier?: string | null): CriticTierFilterOption | null {
  if (!tier) return null;
  const lower = tier.trim().toLowerCase();
  if (lower === 'mighty') return 'mighty';
  if (lower === 'strong') return 'strong';
  if (lower === 'fair') return 'fair';
  if (lower === 'weak') return 'weak';
  return null;
}

function extractFeaturesForGame(
  game: CanonicalGame,
  cachedSteamEntry: CachedSteamFilterRecord | undefined
): Set<FeatureFilterOption> {
  const features = new Set<FeatureFilterOption>();
  const isOwnedOnSteam = isGameOwnedOnSteam(game.platforms);
  const effectiveTags = getEffectiveTags(game.tags || [], isOwnedOnSteam);

  const rawCategories = [
    ...(game.enrichedMetadata?.categories || []),
    ...(Array.isArray(cachedSteamEntry?.categories) ? cachedSteamEntry.categories : []),
  ];
  const effectiveCategories = getEffectiveCategories(rawCategories, isOwnedOnSteam);

  const descriptors: string[] = [
    ...effectiveTags,
    ...effectiveCategories.map((c) => c.description || ''),
  ];

  for (const raw of descriptors) {
    if (!raw) continue;
    if (/single-?player/i.test(raw)) features.add('singleplayer');
    if (/\bco-?op\b|coop/i.test(raw)) features.add('coop');
    if (/multi-?player|\bpvp\b|online pvp|lan pvp|cross-platform multiplayer/i.test(raw)) {
      features.add('multiplayer');
    }
    if (/controller|gamepad/i.test(raw)) features.add('controller');
    if (/steam cloud|cloud saves?|\bcloud\b/i.test(raw)) features.add('cloud_saves');
    if (/achievements?/i.test(raw)) features.add('achievements');
    if (/\bhdr\b/i.test(raw)) features.add('hdr');
  }

  const controllerSupport =
    game.controllerSupport ||
    game.enrichedMetadata?.controllerSupport ||
    cachedSteamEntry?.controllerSupport;
  if (controllerSupport && String(controllerSupport).toLowerCase() !== 'none') {
    features.add('controller');
  }

  if (
    Boolean(game.hdrSupport) ||
    Boolean(game.enrichedMetadata?.hdrSupport) ||
    Boolean(cachedSteamEntry?.hdrSupport)
  ) {
    features.add('hdr');
  }

  if (
    (game.platforms || []).some((p) => (p.achievements?.total ?? 0) > 0) ||
    (game.enrichedMetadata?.achievements?.total ?? 0) > 0 ||
    (cachedSteamEntry?.achievements?.total ?? 0) > 0
  ) {
    features.add('achievements');
  }

  return features;
}

function isValidCreatorName(name?: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !/^(unknown|unknown developer|unknown publisher|n\/a|none|tba)$/i.test(trimmed);
}

/**
 * Precomputes a compact O(1) lookup index and live facet counts across the library.
 * Side-effect free: never triggers background network fetches.
 */
export function buildLibraryFilterIndex(
  games: CanonicalGame[],
  options?: { hostPlatform?: 'darwin' | 'win32' | 'linux' }
): LibraryFilterIndex {
  const entriesById = new Map<string, GameFilterIndexEntry>();
  const hostOs = options?.hostPlatform ?? launcherService.getHostPlatform();

  const osCounts: Record<OsCompatibilityFilterOption, number> = {
    mac_native: 0,
    windows_native: 0,
    mac_compat_layer: 0,
  };

  const criticTierCounts: Record<CriticTierFilterOption, number> = {
    mighty: 0,
    strong: 0,
    fair: 0,
    weak: 0,
  };

  const reviewSentimentCounts: Record<ReviewSentimentFilterOption, number> = {
    overwhelmingly_positive: 0,
    very_positive: 0,
    mostly_positive: 0,
    mixed: 0,
    negative: 0,
  };

  const featureCounts: Record<FeatureFilterOption, number> = {
    singleplayer: 0,
    coop: 0,
    multiplayer: 0,
    controller: 0,
    cloud_saves: 0,
    achievements: 0,
    hdr: 0,
  };

  const genreMap = new Map<string, { label: string; count: number }>();
  const creatorMap = new Map<
    string,
    { name: string; hasDev: boolean; hasPub: boolean; count: number }
  >();

  let minReleaseYear = Infinity;
  let maxReleaseYear = -Infinity;
  let unknownReleaseYearCount = 0;

  for (const game of games || []) {
    if (!game || !game.id) continue;

    const cachedSteamEntry = game.steamAppId ? steamCache[String(game.steamAppId)] : undefined;

    // Category 1: OS & Compatibility
    const osFlags = new Set<OsCompatibilityFilterOption>();
    const isMacNative = isNativelyAvailableOnMac(game);
    const isWinNative = isNativelyAvailableOnWindows(game);
    let isCompatLayerEligible = false;
    if (hostOs !== 'win32') {
      const hasXboxPlatform = (game.platforms || []).some((p) => p.platformId === 'xbox');
      const cachedXboxInstallInfo = hasXboxPlatform
        ? launcherService.getCachedInstallInfo(game.id, 'xbox')
        : undefined;
      const pureUwpOnly = isPureUwpWindowsGame(
        game,
        cachedXboxInstallInfo?.xboxCompatibility?.tier
      );
      if (!pureUwpOnly) {
        const launchCfg = launcherService.getLaunchConfig(game.id);
        isCompatLayerEligible =
          (!isMacNative && isWinNative) ||
          (game.platforms || []).some((p) => Boolean(p.isWindowsBinaryOnMac)) ||
          Boolean(launchCfg?.compatibilityLayer && launchCfg.compatibilityLayer !== 'native');
      }
    }

    if (isMacNative) {
      osFlags.add('mac_native');
      osCounts.mac_native++;
    }
    if (isWinNative) {
      osFlags.add('windows_native');
      osCounts.windows_native++;
    }
    if (isCompatLayerEligible) {
      osFlags.add('mac_compat_layer');
      osCounts.mac_compat_layer++;
    }

    // Category 2: Rating (Critic Tier, Score & Review Sentiment)
    const effectiveSteamAppId =
      game.steamAppId || steamMatcher.getEffectiveSteamAppId(game) || undefined;
    const oc = getOpenCriticData(
      effectiveSteamAppId,
      game.title,
      game.reviewSummary?.positivePercent,
      game.releaseDate,
      undefined,
      false,
      true
    );
    const criticScore =
      oc && typeof oc.score === 'number' && oc.score > 0 ? Math.round(oc.score) : null;
    const criticPercentRecommended =
      oc && typeof oc.percentRecommended === 'number' ? oc.percentRecommended : null;
    const criticTier = oc ? resolveCriticTierOption(oc.tier) : null;
    if (criticTier) {
      criticTierCounts[criticTier]++;
    }

    const reviewSentiment = resolveReviewSentiment(game, cachedSteamEntry);
    if (reviewSentiment) {
      reviewSentimentCounts[reviewSentiment]++;
    }

    // Category 3: Genres
    const genresNormalized = new Set<string>();
    const rawGenres = [
      ...(game.genres || []),
      ...(game.enrichedMetadata?.genres || []),
      ...(Array.isArray(cachedSteamEntry?.genres) ? cachedSteamEntry.genres : []),
    ];
    for (const rawGenre of rawGenres) {
      if (!rawGenre || typeof rawGenre !== 'string') continue;
      const label = rawGenre.trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (!genresNormalized.has(key)) {
        genresNormalized.add(key);
        const existing = genreMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          genreMap.set(key, { label, count: 1 });
        }
      }
    }

    // Category 4: Features & Capabilities
    const features = extractFeaturesForGame(game, cachedSteamEntry);
    for (const feat of features) {
      featureCounts[feat]++;
    }

    // Category 5: Release Year
    const releaseYear =
      parseReleaseYear(game.releaseDate) ??
      parseReleaseYear(game.enrichedMetadata?.releaseDate) ??
      parseReleaseYear(cachedSteamEntry?.releaseDate || cachedSteamEntry?.release_date);

    if (releaseYear !== null) {
      if (releaseYear < minReleaseYear) minReleaseYear = releaseYear;
      if (releaseYear > maxReleaseYear) maxReleaseYear = releaseYear;
    } else {
      unknownReleaseYearCount++;
    }

    // Category 6: Creators (Developers & Publishers)
    const creatorsNormalized = new Set<string>();
    const gameDevKeys = new Set<string>();
    const gamePubKeys = new Set<string>();

    const rawDevs = [
      ...(game.developers || []),
      ...(game.enrichedMetadata?.developers || []),
      ...(Array.isArray(cachedSteamEntry?.developers) ? cachedSteamEntry.developers : []),
    ];
    const rawPubs = [
      ...(game.publishers || []),
      ...(game.enrichedMetadata?.publishers || []),
      ...(Array.isArray(cachedSteamEntry?.publishers) ? cachedSteamEntry.publishers : []),
    ];

    for (const dev of rawDevs) {
      if (!isValidCreatorName(dev)) continue;
      const cleanName = dev.trim();
      const key = cleanName.toLowerCase();
      gameDevKeys.add(key);
      if (!creatorMap.has(key)) {
        creatorMap.set(key, { name: cleanName, hasDev: true, hasPub: false, count: 0 });
      } else {
        creatorMap.get(key)!.hasDev = true;
      }
    }

    for (const pub of rawPubs) {
      if (!isValidCreatorName(pub)) continue;
      const cleanName = pub.trim();
      const key = cleanName.toLowerCase();
      gamePubKeys.add(key);
      if (!creatorMap.has(key)) {
        creatorMap.set(key, { name: cleanName, hasDev: false, hasPub: true, count: 0 });
      } else {
        creatorMap.get(key)!.hasPub = true;
      }
    }

    for (const key of new Set([...gameDevKeys, ...gamePubKeys])) {
      creatorsNormalized.add(key);
      const item = creatorMap.get(key);
      if (item) {
        item.count++;
      }
    }

    entriesById.set(game.id, {
      gameId: game.id,
      effectiveSteamAppId,
      osFlags,
      criticData: oc,
      criticScore,
      criticPercentRecommended,
      criticTier,
      reviewSentiment,
      genresNormalized,
      features,
      releaseYear,
      creatorsNormalized,
    });
  }

  const currentYear = new Date().getFullYear();
  if (!isFinite(minReleaseYear) || !isFinite(maxReleaseYear) || minReleaseYear > maxReleaseYear) {
    minReleaseYear = 1990;
    maxReleaseYear = currentYear;
  }

  const genreCounts: GenreFacetCount[] = Array.from(genreMap.entries())
    .map(([key, val]) => ({
      key,
      label: val.label,
      count: val.count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const creatorCounts: CreatorFacetCount[] = Array.from(creatorMap.entries())
    .map(([key, val]) => ({
      key,
      name: val.name,
      role: (val.hasDev && val.hasPub
        ? 'both'
        : val.hasDev
          ? 'developer'
          : 'publisher') as CreatorFacetCount['role'],
      count: val.count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    entriesById,
    osCounts,
    criticTierCounts,
    reviewSentimentCounts,
    genreCounts,
    featureCounts,
    minReleaseYear,
    maxReleaseYear,
    unknownReleaseYearCount,
    creatorCounts,
  };
}

/**
 * Evaluates a multi-facet LibraryFilterState against a catalog in O(1) per game using LibraryFilterIndex.
 */
export function evaluateLibraryFilter(
  games: CanonicalGame[],
  index: LibraryFilterIndex,
  state: LibraryFilterState
): CanonicalGame[] {
  if (!games || games.length === 0) return [];
  const bounds = { minYear: index.minReleaseYear, maxYear: index.maxReleaseYear };
  if (!isLibraryFilterActive(state, bounds)) {
    return games;
  }

  const hasOsFilter = state.osCompatibility.length > 0;
  const hasCriticTierFilter = state.criticTiers.length > 0;
  const hasMinScoreFilter = state.minCriticScore !== null;
  const hasSentimentFilter = state.reviewSentiments.length > 0;
  const normalizedGenres = state.genres.map((g) => g.toLowerCase().trim()).filter(Boolean);
  const hasGenreFilter = normalizedGenres.length > 0;
  const hasFeatureFilter = state.features.length > 0;
  const hasYearFilter = isReleaseYearRangeActive(state.releaseYearRange, bounds);
  const fromYear = hasYearFilter
    ? Math.min(state.releaseYearRange![0], state.releaseYearRange![1])
    : 0;
  const toYear = hasYearFilter
    ? Math.max(state.releaseYearRange![0], state.releaseYearRange![1])
    : 0;
  const normalizedCreators = state.creators.map((c) => c.toLowerCase().trim()).filter(Boolean);
  const hasCreatorFilter = normalizedCreators.length > 0;

  return games.filter((game) => {
    const entry = index.entriesById.get(game.id);
    if (!entry) return false;

    // Category 1: OS & Compatibility (OR within category)
    if (hasOsFilter) {
      if (!state.osCompatibility.some((opt) => entry.osFlags.has(opt))) {
        return false;
      }
    }

    // Category 2: Rating
    if (hasCriticTierFilter) {
      if (entry.criticTier === null || !state.criticTiers.includes(entry.criticTier)) {
        return false;
      }
    }
    if (hasMinScoreFilter) {
      if (entry.criticScore === null || entry.criticScore < state.minCriticScore!) {
        return false;
      }
    }
    if (hasSentimentFilter) {
      if (
        entry.reviewSentiment === null ||
        !state.reviewSentiments.includes(entry.reviewSentiment)
      ) {
        return false;
      }
    }

    // Category 3: Genres ('any' = OR, 'all' = AND)
    if (hasGenreFilter) {
      if (state.genreMatchMode === 'all') {
        if (!normalizedGenres.every((g) => entry.genresNormalized.has(g))) {
          return false;
        }
      } else {
        if (!normalizedGenres.some((g) => entry.genresNormalized.has(g))) {
          return false;
        }
      }
    }

    // Category 4: Features & Capabilities (AND across selected features)
    if (hasFeatureFilter) {
      if (!state.features.every((f) => entry.features.has(f))) {
        return false;
      }
    }

    // Category 5: Release Year Range
    if (hasYearFilter) {
      if (entry.releaseYear === null) {
        if (!state.includeUnknownReleaseYear) {
          return false;
        }
      } else if (entry.releaseYear < fromYear || entry.releaseYear > toYear) {
        return false;
      }
    }

    // Category 6: Creators (OR across selected developers/publishers)
    if (hasCreatorFilter) {
      if (!normalizedCreators.some((c) => entry.creatorsNormalized.has(c))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Returns 1-click removable chip descriptors for all active filter criteria.
 */
export function describeActiveFilterChips(
  state: LibraryFilterState,
  index: LibraryFilterIndex
): ActiveFilterChipDescriptor[] {
  const chips: ActiveFilterChipDescriptor[] = [];
  if (!state) return chips;

  const genreLabelByKey = new Map<string, string>();
  for (const g of index.genreCounts) {
    genreLabelByKey.set(g.key, g.label);
  }
  const creatorNameByKey = new Map<string, string>();
  for (const c of index.creatorCounts) {
    creatorNameByKey.set(c.key, c.name);
  }

  for (const osOpt of state.osCompatibility) {
    chips.push({
      id: `os:${osOpt}`,
      category: 'OS',
      label: OS_LABELS[osOpt] || osOpt,
      remove: (prev) => ({
        ...prev,
        osCompatibility: prev.osCompatibility.filter((item) => item !== osOpt),
      }),
    });
  }

  for (const tier of state.criticTiers) {
    chips.push({
      id: `tier:${tier}`,
      category: 'Critic Tier',
      label: CRITIC_TIER_LABELS[tier] || tier,
      remove: (prev) => ({
        ...prev,
        criticTiers: prev.criticTiers.filter((item) => item !== tier),
      }),
    });
  }

  if (state.minCriticScore !== null) {
    chips.push({
      id: `minScore:${state.minCriticScore}`,
      category: 'Min Score',
      label: `Score ${state.minCriticScore}+`,
      remove: (prev) => ({
        ...prev,
        minCriticScore: null,
      }),
    });
  }

  for (const sentiment of state.reviewSentiments) {
    chips.push({
      id: `sentiment:${sentiment}`,
      category: 'Reviews',
      label: REVIEW_SENTIMENT_LABELS[sentiment] || sentiment,
      remove: (prev) => ({
        ...prev,
        reviewSentiments: prev.reviewSentiments.filter((item) => item !== sentiment),
      }),
    });
  }

  for (const genre of state.genres) {
    const key = genre.toLowerCase().trim();
    const display = genreLabelByKey.get(key) || genre;
    chips.push({
      id: `genre:${key}`,
      category: 'Genre',
      label: display,
      remove: (prev) => ({
        ...prev,
        genres: prev.genres.filter((item) => item.toLowerCase().trim() !== key),
      }),
    });
  }

  for (const feat of state.features) {
    chips.push({
      id: `feature:${feat}`,
      category: 'Feature',
      label: FEATURE_LABELS[feat] || feat,
      remove: (prev) => ({
        ...prev,
        features: prev.features.filter((item) => item !== feat),
      }),
    });
  }

  const bounds = { minYear: index.minReleaseYear, maxYear: index.maxReleaseYear };
  if (isReleaseYearRangeActive(state.releaseYearRange, bounds) && state.releaseYearRange) {
    const fromYear = Math.min(state.releaseYearRange[0], state.releaseYearRange[1]);
    const toYear = Math.max(state.releaseYearRange[0], state.releaseYearRange[1]);
    chips.push({
      id: `year:${fromYear}-${toYear}`,
      category: 'Release Year',
      label: fromYear === toYear ? `${fromYear}` : `${fromYear} – ${toYear}`,
      remove: (prev) => ({
        ...prev,
        releaseYearRange: null,
        includeUnknownReleaseYear: true,
      }),
    });
  }

  for (const creator of state.creators) {
    const key = creator.toLowerCase().trim();
    const display = creatorNameByKey.get(key) || creator;
    chips.push({
      id: `creator:${key}`,
      category: 'Creator',
      label: display,
      remove: (prev) => ({
        ...prev,
        creators: prev.creators.filter((item) => item.toLowerCase().trim() !== key),
      }),
    });
  }

  return chips;
}
