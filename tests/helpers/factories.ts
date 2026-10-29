import type { CanonicalGame, GamePlatformOwnership } from '../../src/contracts/game';
import type { SteamEnrichedMetadata, SteamReviewSummary } from '../../src/contracts/steam';
import type { UserGameOverride } from '../../src/contracts/override';

export function makePlatformOwnership(
  partial: Partial<GamePlatformOwnership> & Pick<GamePlatformOwnership, 'platformId' | 'platformGameId'>
): GamePlatformOwnership {
  return {
    installed: false,
    ...partial,
  };
}

export function makeCanonicalGame(
  partial: Omit<Partial<CanonicalGame>, 'platforms'> & {
    id: string;
    title: string;
    platforms?: Array<
      Partial<GamePlatformOwnership> & Pick<GamePlatformOwnership, 'platformId' | 'platformGameId'>
    >;
  }
): CanonicalGame {
  const { platforms = [], ...rest } = partial;
  return {
    sortTitle: partial.sortTitle ?? partial.title,
    headerImage: partial.headerImage ?? '',
    developers: partial.developers ?? [],
    publishers: partial.publishers ?? [],
    genres: partial.genres ?? [],
    tags: partial.tags ?? [],
    ...rest,
    platforms: platforms.map((p) => makePlatformOwnership(p)),
  };
}

export function makeSteamReviewSummary(
  partial: Partial<SteamReviewSummary> = {}
): SteamReviewSummary {
  return {
    reviewScore: 0,
    reviewScoreDesc: 'No user reviews',
    totalPositive: 0,
    totalNegative: 0,
    totalReviews: 0,
    positivePercent: 0,
    ...partial,
  };
}

export function makeSteamEnrichedMetadata(
  partial: Partial<SteamEnrichedMetadata> & Pick<SteamEnrichedMetadata, 'appId' | 'name'>
): SteamEnrichedMetadata {
  return {
    shortDescription: '',
    detailedDescription: '',
    aboutTheGame: '',
    headerImage: '',
    developers: [],
    publishers: [],
    releaseDate: 'TBA',
    genres: [],
    tags: [],
    categories: [],
    screenshots: [],
    movies: [],
    systemRequirements: {},
    reviewSummary: makeSteamReviewSummary(),
    ...partial,
  };
}

export function makeUserGameOverride(
  partial: Partial<UserGameOverride> & Pick<UserGameOverride, 'gameId'>
): UserGameOverride {
  return {
    matchedStore: 'custom',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}
