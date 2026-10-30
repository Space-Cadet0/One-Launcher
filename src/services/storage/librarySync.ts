import { CanonicalGame } from '../../contracts/game';
import { FULL_USER_STEAM_GAMES } from './fullUserSteamGames';
import { USER_SCANNED_STEAM_GAMES } from './userScannedLibrary';
import { reconcileAchievementSummaries } from './achievementReconciliation';
import { isUnsuitableCoverUrl, isUnsuitableHeaderUrl } from '../igdb/igdbCoverService';
import {
  isMicrosoftStoreCdnUrl,
  isSteamCdnAssetUrl,
  sanitizeStoreReleaseDate,
} from '../common/titleUtils';

const STEAM_HASHED_ASSET_RE = /\/apps\/\d+\/[a-f0-9]{40}\//i;
const RICH_MEDIA_HTML_RE = /<(?:video|img)\b/i;

export function getEnrichedMetadataQualityRank(
  meta?: CanonicalGame['enrichedMetadata'] | null
): number {
  if (!meta || typeof meta !== 'object') return -1;

  if (
    meta.enrichedSource === 'xbox' &&
    (!meta.appId || Number(meta.appId) <= 0) &&
    meta.metadataQuality !== 'scraped'
  ) {
    return 2; // storefront_native
  }

  switch (meta.metadataQuality) {
    case 'skeleton_fallback':
      return 0;
    case 'local_federated':
      return 1;
    case 'storefront_native':
      return 2;
    case 'scraped':
      return 3;
    case 'authoritative':
      return 4;
    default: {
      if (Number(meta.appId) > 0 && meta.enrichedSource !== 'xbox') {
        return 4;
      }
      return 2;
    }
  }
}

export function pickBestEnrichedMetadata(
  existing?: CanonicalGame['enrichedMetadata'],
  incoming?: CanonicalGame['enrichedMetadata']
): CanonicalGame['enrichedMetadata'] {
  if (!incoming) return existing;
  if (!existing) return incoming;

  const mergeWinnerWithFallbackFields = (
    winner: NonNullable<CanonicalGame['enrichedMetadata']>,
    other: NonNullable<CanonicalGame['enrichedMetadata']>
  ): NonNullable<CanonicalGame['enrichedMetadata']> => {
    const nextXboxHints = winner.xboxDeliveryHints || other.xboxDeliveryHints;
    const nextMovies =
      winner.movies && winner.movies.length > 0
        ? winner.movies
        : other.movies && other.movies.length > 0
        ? other.movies
        : winner.movies;
    const nextCategories =
      winner.categories && winner.categories.length > 0
        ? winner.categories
        : other.categories && other.categories.length > 0
        ? other.categories
        : winner.categories;
    const nextScreenshots =
      winner.screenshots && winner.screenshots.length > 0
        ? winner.screenshots
        : other.screenshots && other.screenshots.length > 0
        ? other.screenshots
        : winner.screenshots;
    const nextShortDesc = winner.shortDescription || other.shortDescription;
    const nextDetailedDesc = pickPreferredDetailedDescription(
      winner.detailedDescription,
      other.detailedDescription
    );

    const nextEnrichedAt =
      typeof winner.enrichedAt === 'number' || typeof other.enrichedAt === 'number'
        ? Math.max(winner.enrichedAt || 0, other.enrichedAt || 0) || undefined
        : undefined;
    const winnerAttemptTs =
      typeof winner.lastMediaSyncAttemptAt === 'number' ? winner.lastMediaSyncAttemptAt : 0;
    const otherAttemptTs =
      typeof other.lastMediaSyncAttemptAt === 'number' ? other.lastMediaSyncAttemptAt : 0;
    const nextLastMediaSyncAttemptAt = Math.max(winnerAttemptTs, otherAttemptTs) || undefined;
    const nextMediaSyncOutcome =
      otherAttemptTs > winnerAttemptTs
        ? other.mediaSyncOutcome ?? winner.mediaSyncOutcome
        : winner.mediaSyncOutcome ?? other.mediaSyncOutcome;
    const nextMediaSyncFailureCount =
      otherAttemptTs > winnerAttemptTs
        ? other.mediaSyncFailureCount ?? winner.mediaSyncFailureCount
        : winner.mediaSyncFailureCount ?? other.mediaSyncFailureCount;

    const hasRestoredRichMedia =
      Boolean(!winner.__quotaSlimmed || !other.__quotaSlimmed) &&
      ((nextScreenshots && nextScreenshots.length > 0) ||
        (nextMovies && nextMovies.length > 0) ||
        !winner.__quotaSlimmed);
    const nextQuotaSlimmed = hasRestoredRichMedia
      ? undefined
      : winner.__quotaSlimmed || other.__quotaSlimmed || undefined;
    const nextHasScreenshotsCount = nextQuotaSlimmed
      ? Math.max(winner.hasScreenshotsCount || 0, other.hasScreenshotsCount || 0) || undefined
      : undefined;
    const nextHasMoviesCount = nextQuotaSlimmed
      ? Math.max(winner.hasMoviesCount || 0, other.hasMoviesCount || 0) || undefined
      : undefined;

    if (
      nextXboxHints === winner.xboxDeliveryHints &&
      nextMovies === winner.movies &&
      nextCategories === winner.categories &&
      nextScreenshots === winner.screenshots &&
      nextShortDesc === winner.shortDescription &&
      nextDetailedDesc === winner.detailedDescription &&
      nextEnrichedAt === winner.enrichedAt &&
      nextLastMediaSyncAttemptAt === winner.lastMediaSyncAttemptAt &&
      nextMediaSyncOutcome === winner.mediaSyncOutcome &&
      nextMediaSyncFailureCount === winner.mediaSyncFailureCount &&
      nextQuotaSlimmed === winner.__quotaSlimmed &&
      nextHasScreenshotsCount === winner.hasScreenshotsCount &&
      nextHasMoviesCount === winner.hasMoviesCount
    ) {
      return winner;
    }

    const merged: NonNullable<CanonicalGame['enrichedMetadata']> = {
      ...winner,
      ...(nextXboxHints ? { xboxDeliveryHints: nextXboxHints } : {}),
      ...(nextMovies ? { movies: nextMovies } : {}),
      ...(nextCategories ? { categories: nextCategories } : {}),
      ...(nextScreenshots ? { screenshots: nextScreenshots } : {}),
      ...(nextShortDesc !== undefined ? { shortDescription: nextShortDesc } : {}),
      ...(nextDetailedDesc !== undefined ? { detailedDescription: nextDetailedDesc } : {}),
      ...(nextEnrichedAt !== undefined ? { enrichedAt: nextEnrichedAt } : {}),
      ...(nextLastMediaSyncAttemptAt !== undefined
        ? { lastMediaSyncAttemptAt: nextLastMediaSyncAttemptAt }
        : {}),
      ...(nextMediaSyncOutcome !== undefined ? { mediaSyncOutcome: nextMediaSyncOutcome } : {}),
      ...(nextMediaSyncFailureCount !== undefined
        ? { mediaSyncFailureCount: nextMediaSyncFailureCount }
        : {}),
    };
    if (nextQuotaSlimmed) {
      merged.__quotaSlimmed = true;
      if (nextHasScreenshotsCount !== undefined) merged.hasScreenshotsCount = nextHasScreenshotsCount;
      if (nextHasMoviesCount !== undefined) merged.hasMoviesCount = nextHasMoviesCount;
    } else {
      delete merged.__quotaSlimmed;
      delete merged.hasScreenshotsCount;
      delete merged.hasMoviesCount;
    }
    return merged;
  };

  const existingRank = getEnrichedMetadataQualityRank(existing);
  const incomingRank = getEnrichedMetadataQualityRank(incoming);

  if (existingRank > incomingRank) {
    return mergeWinnerWithFallbackFields(existing, incoming);
  }
  if (incomingRank > existingRank) {
    return mergeWinnerWithFallbackFields(incoming, existing);
  }

  if (incoming.__quotaSlimmed && !existing.__quotaSlimmed) {
    return mergeWinnerWithFallbackFields(existing, incoming);
  }
  if (existing.__quotaSlimmed && !incoming.__quotaSlimmed) {
    return mergeWinnerWithFallbackFields(incoming, existing);
  }

  // Equal rank: preserve richer media/HTML if incoming is sparser
  const existingHasRichHtml = RICH_MEDIA_HTML_RE.test(existing.detailedDescription || '');
  const incomingHasRichHtml = RICH_MEDIA_HTML_RE.test(incoming.detailedDescription || '');
  if (existingHasRichHtml && !incomingHasRichHtml) {
    return mergeWinnerWithFallbackFields(existing, incoming);
  }
  if (
    (incoming.screenshots?.length || 0) === 0 &&
    (existing.screenshots?.length || 0) > 0
  ) {
    return mergeWinnerWithFallbackFields(existing, incoming);
  }

  return mergeWinnerWithFallbackFields(incoming, existing);
}

export function pickPreferredCapsuleImage(
  existingUrl?: string,
  incomingUrl?: string
): string | undefined {
  const validExisting =
    existingUrl && !isUnsuitableCoverUrl(existingUrl) ? existingUrl : undefined;
  const validIncoming =
    incomingUrl && !isUnsuitableCoverUrl(incomingUrl) ? incomingUrl : undefined;

  if (!validExisting) return validIncoming;
  if (!validIncoming) return validExisting;

  const existingIsSteam = isSteamCdnAssetUrl(validExisting);
  const incomingIsSteam = isSteamCdnAssetUrl(validIncoming);
  const existingIsMs = isMicrosoftStoreCdnUrl(validExisting);
  const incomingIsMs = isMicrosoftStoreCdnUrl(validIncoming);

  // Authoritative Steam CDN covers always beat MS Store covers (both protecting against clobber and allowing upgrade)
  if (existingIsSteam && incomingIsMs) return validExisting;
  if (incomingIsSteam && existingIsMs) return validIncoming;

  // Prefer 40-char SHA1-hashed Steam browse assets over unhashed legacy URLs
  if (
    existingIsSteam &&
    incomingIsSteam &&
    !STEAM_HASHED_ASSET_RE.test(validExisting) &&
    STEAM_HASHED_ASSET_RE.test(validIncoming)
  ) {
    return validIncoming;
  }

  return validExisting;
}

export function pickPreferredHeaderImage(
  existingUrl?: string,
  incomingUrl?: string
): string | undefined {
  const validExisting =
    existingUrl && !isUnsuitableHeaderUrl(existingUrl) ? existingUrl : undefined;
  const validIncoming =
    incomingUrl && !isUnsuitableHeaderUrl(incomingUrl) ? incomingUrl : undefined;

  if (!validExisting) return validIncoming;
  if (!validIncoming) return validExisting;

  const existingIsSteam = isSteamCdnAssetUrl(validExisting);
  const incomingIsSteam = isSteamCdnAssetUrl(validIncoming);
  const existingIsMs = isMicrosoftStoreCdnUrl(validExisting);
  const incomingIsMs = isMicrosoftStoreCdnUrl(validIncoming);

  if (existingIsSteam && incomingIsMs) return validExisting;
  if (incomingIsSteam && existingIsMs) return validIncoming;

  if (
    existingIsSteam &&
    incomingIsSteam &&
    !STEAM_HASHED_ASSET_RE.test(validExisting) &&
    STEAM_HASHED_ASSET_RE.test(validIncoming)
  ) {
    return validIncoming;
  }

  return validExisting;
}

export function pickPreferredDetailedDescription(
  existingHtml?: string,
  incomingHtml?: string
): string | undefined {
  if (!existingHtml) return incomingHtml;
  if (!incomingHtml) return existingHtml;

  const existingHasMedia = RICH_MEDIA_HTML_RE.test(existingHtml);
  const incomingHasMedia = RICH_MEDIA_HTML_RE.test(incomingHtml);
  if (existingHasMedia && !incomingHasMedia) return existingHtml;
  if (incomingHasMedia && !existingHasMedia) return incomingHtml;

  const existingHasTags = /<[a-z!\/][^>]*>/i.test(existingHtml);
  const incomingHasTags = /<[a-z!\/][^>]*>/i.test(incomingHtml);
  if (existingHasTags && !incomingHasTags) return existingHtml;
  if (incomingHasTags && !existingHasTags) return incomingHtml;

  return existingHtml;
}

export function pickPreferredReleaseDate(
  existingDate?: string,
  incomingDate?: string
): string | undefined {
  const validExisting = sanitizeStoreReleaseDate(existingDate);
  const validIncoming = sanitizeStoreReleaseDate(incomingDate);
  if (validExisting) return validExisting;
  if (validIncoming) return validIncoming;
  if (existingDate === 'TBA' || incomingDate === 'TBA') return 'TBA';
  return existingDate || incomingDate;
}

export function mergeScannedSteamGames(existingGames: CanonicalGame[]): CanonicalGame[] {
  const merged = [...existingGames];

  // Merge full local Steam library of 251 games
  const allSteamGames = [...USER_SCANNED_STEAM_GAMES, ...FULL_USER_STEAM_GAMES];

  for (const scanned of allSteamGames) {
    const existingIndex = merged.findIndex(
      (g) =>
        (g.steamAppId && scanned.steamAppId && g.steamAppId === scanned.steamAppId) ||
        g.title.toLowerCase().trim() === scanned.title.toLowerCase().trim()
    );

    const scannedSteam = scanned.platforms.find((p) => p.platformId === 'steam');

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      let hasSteam = false;

      const updatedPlatforms = existing.platforms.map((p) => {
        if (p.platformId === 'steam') {
          hasSteam = true;
          if (scannedSteam) {
            return {
              ...p,
              playtimeMinutes: Math.max(p.playtimeMinutes || 0, scannedSteam.playtimeMinutes || 0),
              lastPlayed: scannedSteam.lastPlayed || p.lastPlayed,
              installed: p.installed || scannedSteam.installed,
              achievements: reconcileAchievementSummaries(
                p.achievements,
                scannedSteam.achievements,
                { title: scanned.title, appId: scanned.steamAppId, store: 'steam' }
              ),
            };
          }
        }
        return p;
      });

      if (!hasSteam && scannedSteam) {
        updatedPlatforms.push(scannedSteam);
      }

      merged[existingIndex] = {
        ...existing,
        steamAppId: existing.steamAppId || scanned.steamAppId,
        platforms: updatedPlatforms,
        headerImage: pickPreferredHeaderImage(existing.headerImage, scanned.headerImage) || existing.headerImage || scanned.headerImage,
        capsuleImage: pickPreferredCapsuleImage(existing.capsuleImage, scanned.capsuleImage),
        iconUrl: !isUnsuitableHeaderUrl(existing.iconUrl) ? existing.iconUrl : (scanned.iconUrl || scanned.capsuleImage || scanned.headerImage),
        shortDescription: existing.shortDescription || scanned.shortDescription,
        detailedDescription: pickPreferredDetailedDescription(
          existing.detailedDescription,
          scanned.detailedDescription
        ),
        releaseDate: pickPreferredReleaseDate(existing.releaseDate, scanned.releaseDate) || existing.releaseDate,
        reviewSummary: existing.reviewSummary || scanned.reviewSummary,
        tags: existing.tags && existing.tags.length > 0 ? existing.tags : scanned.tags,
        enrichedMetadata: pickBestEnrichedMetadata(
          existing.enrichedMetadata,
          scanned.enrichedMetadata
        ),
      };
    } else {
      merged.push(scanned);
    }
  }

  // Sort alphabetically by canonical title
  return merged.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}
