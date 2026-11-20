import { CanonicalGame } from '../../contracts/game';
import { SteamSystemRequirements } from '../../contracts/steam';
import { FULL_USER_STEAM_GAMES } from './fullUserSteamGames';
import { USER_SCANNED_STEAM_GAMES } from './userScannedLibrary';
import { reconcileAchievementSummaries } from './achievementReconciliation';
import { isUnsuitableHeaderUrl } from '../igdb/igdbCoverService';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from './metadataReconciliation';
import { sanitizeStoreReleaseDate } from '../common/titleUtils';

const RICH_MEDIA_HTML_RE = /<(?:video|img)\b/i;

function hasRequirementContent(req?: SteamSystemRequirements | null): boolean {
  return Boolean(
    req &&
      ((typeof req.minimum === 'string' && req.minimum.trim().length > 0) ||
        (typeof req.recommended === 'string' && req.recommended.trim().length > 0))
  );
}

function mergeSystemRequirementsField(
  winnerReq?: SteamSystemRequirements,
  otherReq?: SteamSystemRequirements
): SteamSystemRequirements | undefined {
  if (!hasRequirementContent(otherReq)) return winnerReq;
  if (!hasRequirementContent(winnerReq)) return otherReq;
  const nextMin =
    typeof winnerReq?.minimum === 'string' && winnerReq.minimum.trim().length > 0
      ? winnerReq.minimum
      : otherReq?.minimum;
  const nextRec =
    typeof winnerReq?.recommended === 'string' && winnerReq.recommended.trim().length > 0
      ? winnerReq.recommended
      : otherReq?.recommended;
  if (nextMin === winnerReq?.minimum && nextRec === winnerReq?.recommended) {
    return winnerReq;
  }
  return {
    ...(nextMin !== undefined ? { minimum: nextMin } : {}),
    ...(nextRec !== undefined ? { recommended: nextRec } : {}),
  };
}

function hasValidStudioList(list?: string[], placeholder?: string): boolean {
  return Boolean(
    Array.isArray(list) &&
      list.some((item) => typeof item === 'string' && item.trim().length > 0 && item !== placeholder)
  );
}

export function getEnrichedMetadataQualityRank(
  meta?: CanonicalGame['enrichedMetadata'] | null
): number {
  if (!meta || typeof meta !== 'object') return -1;

  // Universal C8 Lattice Invariant: __quotaSlimmed projections are ALWAYS Rank 0 (skeleton_fallback)
  // so they can never outrank or overwrite any non-slimmed durable record.
  if (meta.__quotaSlimmed === true) {
    return 0;
  }

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
    const samePositiveAppId =
      Number(winner.appId) > 0 &&
      Number(other.appId) > 0 &&
      Number(winner.appId) === Number(other.appId);
    const sameEnrichedSource =
      Boolean(winner.enrichedSource) && winner.enrichedSource === other.enrichedSource;
    const canInheritMacReqs =
      samePositiveAppId ||
      sameEnrichedSource ||
      (winner.enrichedSource !== 'xbox' &&
        (winner.platforms?.mac === true || (!winner.platforms && other.platforms?.mac === true)));
    const canInheritLinuxReqs =
      samePositiveAppId ||
      sameEnrichedSource ||
      (winner.enrichedSource !== 'xbox' &&
        (winner.platforms?.linux === true ||
          (!winner.platforms && other.platforms?.linux === true)));

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
    const nextAboutTheGame = pickPreferredDetailedDescription(
      winner.aboutTheGame,
      other.aboutTheGame
    );

    const nextSystemRequirements =
      mergeSystemRequirementsField(winner.systemRequirements, other.systemRequirements) ??
      winner.systemRequirements;
    const nextMacRequirements = canInheritMacReqs
      ? mergeSystemRequirementsField(winner.macRequirements, other.macRequirements)
      : winner.macRequirements;
    const nextLinuxRequirements = canInheritLinuxReqs
      ? mergeSystemRequirementsField(winner.linuxRequirements, other.linuxRequirements)
      : winner.linuxRequirements;
    const nextPcRequirementsHtml = winner.pcRequirementsHtml || other.pcRequirementsHtml;

    const nextSupportedLanguages =
      typeof winner.supportedLanguages === 'string' && winner.supportedLanguages.trim().length > 0
        ? winner.supportedLanguages
        : typeof other.supportedLanguages === 'string' && other.supportedLanguages.trim().length > 0
        ? other.supportedLanguages
        : winner.supportedLanguages;
    const nextLanguageOptions =
      winner.languageOptions && winner.languageOptions.length > 0
        ? winner.languageOptions
        : other.languageOptions && other.languageOptions.length > 0
        ? other.languageOptions
        : winner.languageOptions;
    const nextLanguageTableSchema = winner.languageTableSchema || other.languageTableSchema;

    const nextDevelopers = hasValidStudioList(winner.developers, 'Unknown Developer')
      ? winner.developers
      : hasValidStudioList(other.developers, 'Unknown Developer')
      ? other.developers
      : winner.developers;
    const nextPublishers = hasValidStudioList(winner.publishers, 'Unknown Publisher')
      ? winner.publishers
      : hasValidStudioList(other.publishers, 'Unknown Publisher')
      ? other.publishers
      : winner.publishers;
    const nextGenres =
      winner.genres && winner.genres.length > 0
        ? winner.genres
        : other.genres && other.genres.length > 0
        ? other.genres
        : winner.genres;
    const nextTags =
      winner.tags && winner.tags.length > 0
        ? winner.tags
        : other.tags && other.tags.length > 0
        ? other.tags
        : winner.tags;

    const winnerHasReviews = Boolean(
      winner.reviewSummary &&
        (winner.reviewSummary.totalReviews > 0 || winner.reviewSummary.positivePercent > 0)
    );
    const otherHasReviews = Boolean(
      other.reviewSummary &&
        (other.reviewSummary.totalReviews > 0 || other.reviewSummary.positivePercent > 0)
    );
    const nextReviewSummary = winnerHasReviews
      ? winner.reviewSummary
      : otherHasReviews
      ? other.reviewSummary
      : winner.reviewSummary;
    const nextMetacritic = winner.metacritic || other.metacritic;

    let nextPlatforms = winner.platforms;
    if (!winner.platforms && other.platforms && winner.enrichedSource !== 'xbox') {
      nextPlatforms = other.platforms;
    } else if (
      winner.platforms &&
      other.platforms &&
      (samePositiveAppId || sameEnrichedSource)
    ) {
      const mergedWin = winner.platforms.windows ?? other.platforms.windows;
      const mergedMac = winner.platforms.mac ?? other.platforms.mac;
      const mergedLinux = winner.platforms.linux ?? other.platforms.linux;
      if (
        mergedWin !== winner.platforms.windows ||
        mergedMac !== winner.platforms.mac ||
        mergedLinux !== winner.platforms.linux
      ) {
        nextPlatforms = {
          ...(mergedWin !== undefined ? { windows: mergedWin } : {}),
          ...(mergedMac !== undefined ? { mac: mergedMac } : {}),
          ...(mergedLinux !== undefined ? { linux: mergedLinux } : {}),
        };
      }
    }

    let nextAchievements = winner.achievements;
    if (
      winner.achievements &&
      winner.achievements.total > 0 &&
      !(winner.achievements.highlighted && winner.achievements.highlighted.length > 0) &&
      other.achievements?.highlighted &&
      other.achievements.highlighted.length > 0 &&
      other.achievements.total >= winner.achievements.total
    ) {
      nextAchievements = {
        ...winner.achievements,
        highlighted: other.achievements.highlighted,
      };
    } else if (
      (!winner.achievements || !(winner.achievements.total > 0)) &&
      other.achievements &&
      other.achievements.total > 0
    ) {
      nextAchievements = other.achievements;
    }

    const nextLegalNotice = winner.legalNotice || other.legalNotice;
    const nextDrmNotice = winner.drmNotice || other.drmNotice;
    const nextExtUserAccountNotice = winner.extUserAccountNotice || other.extUserAccountNotice;
    const nextWebsite = winner.website || other.website;
    const nextControllerSupport = winner.controllerSupport || other.controllerSupport;
    const nextDeckCompatibility =
      winner.deckCompatibility && winner.deckCompatibility !== 'unknown'
        ? winner.deckCompatibility
        : other.deckCompatibility || winner.deckCompatibility;

    const winnerFetchedAt =
      typeof winner.fetchedAt === 'number' && winner.fetchedAt > 0 ? winner.fetchedAt : undefined;
    const otherFetchedAt =
      typeof other.fetchedAt === 'number' &&
      other.fetchedAt > 0 &&
      !other.__quotaSlimmed &&
      (samePositiveAppId || sameEnrichedSource)
        ? other.fetchedAt
        : undefined;
    const nextFetchedAt =
      winnerFetchedAt !== undefined && otherFetchedAt !== undefined
        ? Math.max(winnerFetchedAt, otherFetchedAt)
        : winnerFetchedAt ?? otherFetchedAt;

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

    // Never clear __quotaSlimmed on a slimmed winner unless `other` provides non-slimmed
    // authoritative specs/descriptions (prevents Frankenstein Rank-4 stubs lacking specs).
    const otherProvidesAuthoritativeRestore = Boolean(
      !other.__quotaSlimmed &&
        other.metadataQuality !== 'skeleton_fallback' &&
        (hasRequirementContent(other.systemRequirements) ||
          hasRequirementContent(other.macRequirements) ||
          (typeof other.fetchedAt === 'number' && other.fetchedAt > 0) ||
          (other.metadataQuality === 'authoritative' &&
            Boolean(
              other.shortDescription?.trim() ||
                other.detailedDescription?.trim() ||
                other.aboutTheGame?.trim()
            )))
    );
    const nextQuotaSlimmed = !winner.__quotaSlimmed
      ? undefined
      : otherProvidesAuthoritativeRestore
      ? undefined
      : true;
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
      nextAboutTheGame === winner.aboutTheGame &&
      nextSystemRequirements === winner.systemRequirements &&
      nextMacRequirements === winner.macRequirements &&
      nextLinuxRequirements === winner.linuxRequirements &&
      nextPcRequirementsHtml === winner.pcRequirementsHtml &&
      nextSupportedLanguages === winner.supportedLanguages &&
      nextLanguageOptions === winner.languageOptions &&
      nextLanguageTableSchema === winner.languageTableSchema &&
      nextDevelopers === winner.developers &&
      nextPublishers === winner.publishers &&
      nextGenres === winner.genres &&
      nextTags === winner.tags &&
      nextReviewSummary === winner.reviewSummary &&
      nextMetacritic === winner.metacritic &&
      nextPlatforms === winner.platforms &&
      nextAchievements === winner.achievements &&
      nextLegalNotice === winner.legalNotice &&
      nextDrmNotice === winner.drmNotice &&
      nextExtUserAccountNotice === winner.extUserAccountNotice &&
      nextWebsite === winner.website &&
      nextControllerSupport === winner.controllerSupport &&
      nextDeckCompatibility === winner.deckCompatibility &&
      nextFetchedAt === winner.fetchedAt &&
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
      ...(nextAboutTheGame !== undefined ? { aboutTheGame: nextAboutTheGame } : {}),
      ...(nextSystemRequirements !== undefined
        ? { systemRequirements: nextSystemRequirements }
        : {}),
      ...(nextMacRequirements !== undefined ? { macRequirements: nextMacRequirements } : {}),
      ...(nextLinuxRequirements !== undefined ? { linuxRequirements: nextLinuxRequirements } : {}),
      ...(nextPcRequirementsHtml !== undefined
        ? { pcRequirementsHtml: nextPcRequirementsHtml }
        : {}),
      ...(nextSupportedLanguages !== undefined
        ? { supportedLanguages: nextSupportedLanguages }
        : {}),
      ...(nextLanguageOptions !== undefined ? { languageOptions: nextLanguageOptions } : {}),
      ...(nextLanguageTableSchema !== undefined
        ? { languageTableSchema: nextLanguageTableSchema }
        : {}),
      ...(nextDevelopers !== undefined ? { developers: nextDevelopers } : {}),
      ...(nextPublishers !== undefined ? { publishers: nextPublishers } : {}),
      ...(nextGenres !== undefined ? { genres: nextGenres } : {}),
      ...(nextTags !== undefined ? { tags: nextTags } : {}),
      ...(nextReviewSummary !== undefined ? { reviewSummary: nextReviewSummary } : {}),
      ...(nextMetacritic !== undefined ? { metacritic: nextMetacritic } : {}),
      ...(nextPlatforms !== undefined ? { platforms: nextPlatforms } : {}),
      ...(nextAchievements !== undefined ? { achievements: nextAchievements } : {}),
      ...(nextLegalNotice !== undefined ? { legalNotice: nextLegalNotice } : {}),
      ...(nextDrmNotice !== undefined ? { drmNotice: nextDrmNotice } : {}),
      ...(nextExtUserAccountNotice !== undefined
        ? { extUserAccountNotice: nextExtUserAccountNotice }
        : {}),
      ...(nextWebsite !== undefined ? { website: nextWebsite } : {}),
      ...(nextControllerSupport !== undefined
        ? { controllerSupport: nextControllerSupport }
        : {}),
      ...(nextDeckCompatibility !== undefined
        ? { deckCompatibility: nextDeckCompatibility }
        : {}),
      ...(nextFetchedAt !== undefined ? { fetchedAt: nextFetchedAt } : {}),
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

  // Rank 0 tiebreak: preserve __quotaSlimmed stub over bare empty skeleton_fallback
  const existingIsSkeleton =
    existing.metadataQuality === 'skeleton_fallback' && !existing.__quotaSlimmed;
  const incomingIsSkeleton =
    incoming.metadataQuality === 'skeleton_fallback' && !incoming.__quotaSlimmed;
  if (existing.__quotaSlimmed && incomingIsSkeleton) {
    return mergeWinnerWithFallbackFields(existing, incoming);
  }
  if (incoming.__quotaSlimmed && existingIsSkeleton) {
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
  incomingUrl?: string,
  ctx?: ArtworkRecoveryContext
): string | undefined {
  return reconcileCapsuleImage(existingUrl, incomingUrl, ctx);
}

export function pickPreferredHeaderImage(
  existingUrl?: string,
  incomingUrl?: string,
  ctx?: ArtworkRecoveryContext
): string | undefined {
  return reconcileHeaderImage(existingUrl, incomingUrl, ctx);
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

      const gogPlat = updatedPlatforms.find((p) => p.platformId === 'gog');
      const artworkCtx: ArtworkRecoveryContext = {
        gameId: existing.id,
        title: existing.title,
        steamAppId: existing.steamAppId || scanned.steamAppId,
        gogId: gogPlat?.platformGameId,
      };
      const mergedHeader =
        pickPreferredHeaderImage(existing.headerImage, scanned.headerImage, artworkCtx) ||
        existing.headerImage ||
        scanned.headerImage;
      const mergedCapsule = pickPreferredCapsuleImage(existing.capsuleImage, scanned.capsuleImage, {
        ...artworkCtx,
        headerUrl: mergedHeader,
      });

      merged[existingIndex] = {
        ...existing,
        steamAppId: existing.steamAppId || scanned.steamAppId,
        platforms: updatedPlatforms,
        headerImage: mergedHeader,
        capsuleImage: mergedCapsule,
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
