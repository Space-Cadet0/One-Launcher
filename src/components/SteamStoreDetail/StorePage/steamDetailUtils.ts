import { CanonicalGame } from '../../../contracts/game';
import {
  SteamEnrichedMetadata,
  SteamMovie,
  SteamReviewSummary,
  SteamScreenshot,
} from '../../../contracts/steam';
import { CriticScoreData } from '../../../contracts/critic';
import { UserGameOverride } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { unwrapOlMediaUrl } from '../../../contracts/network';
import type { SteamStoreBrowseAssets } from '../../../services/steam/steamApi';
import {
  isGenericPlaceholderSynopsis,
  stripHtmlToPlainSynopsis,
} from '../../../services/steam/fallbackMetadataProvider';
import type { HltbData } from '../../../services/hltb/howLongToBeat';
import {
  getReviewSourceAuthorityRank,
  normalizeCriticTitleKey,
} from '../../../services/critic/criticUtils';
import { inferReviewRouteFromOverride } from '../../../services/storage/userOverrideStorage';
import { launcherService } from '../../../services/launcher/launcherService';

export const EMPTY_SCREENSHOTS: SteamScreenshot[] = [];
export const EMPTY_MOVIES: SteamMovie[] = [];
export const EMPTY_STRINGS: string[] = [];

export const RICH_HTML_DESC_RE = /<(video|img|p|h[1-6]|div|ul)\b/i;

export function isSkeletonMetadata(meta?: SteamEnrichedMetadata | null): boolean {
  return Boolean(meta && meta.metadataQuality === 'skeleton_fallback');
}

export function hasRichMetadata(meta?: SteamEnrichedMetadata | null): boolean {
  return Boolean(
    meta && meta.metadataQuality !== 'skeleton_fallback' && !meta.__quotaSlimmed
  );
}

export function isAuthoritativeSteamMetadata(
  meta?: SteamEnrichedMetadata | null,
  expectedAppId?: number | null
): boolean {
  return (
    Boolean(meta) &&
    !meta!.__quotaSlimmed &&
    Number(meta!.appId) > 0 &&
    (!expectedAppId || Number(meta!.appId) === Number(expectedAppId)) &&
    meta!.metadataQuality !== 'storefront_native' &&
    meta!.metadataQuality !== 'skeleton_fallback' &&
    meta!.metadataQuality !== 'local_federated' &&
    meta!.enrichedSource !== 'xbox'
  );
}

export function isSentinelReleaseDate(raw?: string | null): boolean {
  if (!raw) return false;
  const match = raw.match(/\b(\d{4})\b/);
  if (!match) return false;
  const year = Number(match[1]);
  const maxValidYear = new Date().getFullYear() + 10;
  return Number.isFinite(year) && (year < 1975 || year > maxValidYear);
}

export function isMicrosoftStoreAssetUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const normalized = url.trim().startsWith('//') ? `https:${url.trim()}` : url.trim();
    const unwrapped = normalized.startsWith('ol-media://')
      ? unwrapOlMediaUrl(normalized)
      : normalized;
    const host = new URL(unwrapped).hostname.toLowerCase();
    return (
      host === 's-microsoft.com' ||
      host.endsWith('.s-microsoft.com') ||
      host === 'xboxlive.com' ||
      host.endsWith('.xboxlive.com')
    );
  } catch {
    return false;
  }
}

export function mergePreservingXboxHints(
  incoming: SteamEnrichedMetadata | null | undefined,
  baseline?: SteamEnrichedMetadata | null
): SteamEnrichedMetadata | null {
  if (!incoming) return null;
  if (baseline?.xboxDeliveryHints && !incoming.xboxDeliveryHints) {
    return {
      ...incoming,
      xboxDeliveryHints: baseline.xboxDeliveryHints,
    };
  }
  return incoming;
}

export function normalizeProtocolRelativeUrl(raw?: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

export function normalizeSrcsetUrls(rawSrcset?: string | null): string {
  if (!rawSrcset) return '';
  return rawSrcset
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const normalizedUrl = normalizeProtocolRelativeUrl(parts[0]);
      if (!normalizedUrl) return '';
      return parts.length > 1 ? `${normalizedUrl} ${parts.slice(1).join(' ')}` : normalizedUrl;
    })
    .filter(Boolean)
    .join(', ');
}

export function parseVaultHltb(raw: unknown): HltbData | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<HltbData> & { unmatched?: boolean };
  if (candidate.isAccurate === false || candidate.unmatched === true) return null;
  const mainStoryHours = typeof candidate.mainStoryHours === 'number' ? candidate.mainStoryHours : 0;
  const mainExtraHours = typeof candidate.mainExtraHours === 'number' ? candidate.mainExtraHours : 0;
  const completionistHours =
    typeof candidate.completionistHours === 'number' ? candidate.completionistHours : 0;
  const allStylesHours = typeof candidate.allStylesHours === 'number' ? candidate.allStylesHours : 0;
  if (
    mainStoryHours <= 0 &&
    mainExtraHours <= 0 &&
    completionistHours <= 0 &&
    allStylesHours <= 0
  ) {
    return null;
  }
  return {
    mainStoryHours,
    mainExtraHours,
    completionistHours,
    allStylesHours,
    gameplayType: typeof candidate.gameplayType === 'string' ? candidate.gameplayType : undefined,
    hltbGameId: typeof candidate.hltbGameId === 'number' ? candidate.hltbGameId : undefined,
    isAccurate: true,
  };
}

export function buildVaultCriticSignature(
  gameId: string,
  score: CriticScoreData | null,
  isExplicitOverride = false
): string {
  if (!score || typeof score.score !== 'number' || !Number.isFinite(score.score) || score.score <= 0) {
    return '';
  }
  return [
    gameId,
    score.source,
    score.score,
    score.userScoreRaw ?? '',
    score.starRatingRaw ?? '',
    score.numReviews ?? '',
    score.url || '',
    isExplicitOverride ? 'override' : 'auto',
  ].join('|');
}

export function shouldAcceptCriticUpdateEvent(
  detail: {
    gameId?: string;
    title?: string;
    steamAppId?: number;
    appId?: number;
  },
  target: {
    gameId: string;
    gameSteamAppId?: number;
    currentSteamAppId?: number;
    effectiveSteamId?: number;
    resolvedSteamAppId?: number | null;
    lowerGameTitle: string;
    normalizedGameTitle: string;
  }
): boolean {
  const rawDetailSteamAppId = detail.steamAppId ?? detail.appId;
  const detailSteamAppId =
    typeof rawDetailSteamAppId === 'number' &&
    Number.isInteger(rawDetailSteamAppId) &&
    rawDetailSteamAppId > 0
      ? rawDetailSteamAppId
      : undefined;
  const effectiveCurrentSteamAppId =
    typeof target.resolvedSteamAppId === 'number' &&
    Number.isInteger(target.resolvedSteamAppId) &&
    target.resolvedSteamAppId > 0
      ? target.resolvedSteamAppId
      : undefined;
  const matchesGameId = Boolean(detail.gameId && detail.gameId === target.gameId);
  const matchesSteamId = Boolean(
    detailSteamAppId &&
      (detailSteamAppId === target.gameSteamAppId ||
        detailSteamAppId === target.currentSteamAppId ||
        detailSteamAppId === target.effectiveSteamId ||
        detailSteamAppId === effectiveCurrentSteamAppId)
  );
  if (
    !matchesGameId &&
    !matchesSteamId &&
    detailSteamAppId !== undefined &&
    effectiveCurrentSteamAppId !== undefined &&
    detailSteamAppId !== effectiveCurrentSteamAppId
  ) {
    return false;
  }
  const detailTitleTrimmed = typeof detail.title === 'string' ? detail.title.trim() : '';
  const matchesTitle = Boolean(
    detailTitleTrimmed &&
      (detailTitleTrimmed.toLowerCase() === target.lowerGameTitle ||
        (target.normalizedGameTitle &&
          normalizeCriticTitleKey(detailTitleTrimmed) === target.normalizedGameTitle))
  );
  return matchesGameId || matchesSteamId || matchesTitle;
}

export function hasRealSteamReviewSummary(
  summary?: SteamReviewSummary | null
): summary is SteamReviewSummary {
  return Boolean(
    summary &&
      (summary.totalReviews > 0 ||
        (summary.positivePercent > 0 &&
          summary.reviewScoreDesc &&
          !/no user reviews/i.test(summary.reviewScoreDesc)))
  );
}

export function selectPreferredCriticScore(
  resolved: CriticScoreData | null,
  vaultFallback: CriticScoreData | null,
  userOverride?: UserGameOverride | null
): CriticScoreData | null {
  const overrideRoute = userOverride ? inferReviewRouteFromOverride(userOverride) : undefined;
  if (overrideRoute?.mode === 'unrated') {
    return null;
  }
  if (overrideRoute?.mode === 'static' || overrideRoute?.mode === 'routed') {
    return resolved ?? userOverride?.reviewScoreOverride ?? null;
  }
  if (!vaultFallback) {
    return resolved;
  }
  const resolvedRank = getReviewSourceAuthorityRank(resolved);
  const vaultRank = getReviewSourceAuthorityRank(vaultFallback);
  return vaultRank > resolvedRank ? vaultFallback : resolved;
}

export function resolveInitialDetailPlatformId(targetGame: CanonicalGame): StorefrontId {
  const persisted = launcherService.getSelectedStorefrontForGame(targetGame.id);
  const validPersisted =
    persisted && (targetGame.platforms || []).some((p) => p.platformId === persisted)
      ? persisted
      : undefined;
  return (
    validPersisted ||
    launcherService.getSelectedStorefrontForGame(targetGame) ||
    launcherService.getEffectivePlatformForGame(targetGame)?.platformId ||
    targetGame.platforms?.[0]?.platformId ||
    (targetGame.steamAppId ? 'steam' : 'custom')
  );
}

export function buildEnrichedTopLevelFields(params: {
  game: CanonicalGame;
  currentOverride?: UserGameOverride | null;
  existingRichMeta?: SteamEnrichedMetadata | null;
  hasUserHeaderOverride: boolean;
  hasUserCoverOverride: boolean;
  meta?: SteamEnrichedMetadata | null;
  browseAssets?: SteamStoreBrowseAssets | null;
}) {
  const {
    game,
    currentOverride,
    existingRichMeta,
    hasUserHeaderOverride,
    hasUserCoverOverride,
    meta,
    browseAssets,
  } = params;

  if (!meta || isSkeletonMetadata(meta)) {
    return {
      nextShortDescription: game.shortDescription,
      nextDetailedDescription: game.detailedDescription,
      nextDevelopers: game.developers,
      nextPublishers: game.publishers,
      nextReleaseDate: game.releaseDate,
      nextHeaderImage: game.headerImage,
      nextCapsuleImage: game.capsuleImage,
      nextReviewSummary: game.reviewSummary,
      topLevelChanged: false,
    };
  }

  const cleanMetaShort = meta.shortDescription
    ? stripHtmlToPlainSynopsis(meta.shortDescription)
    : '';
  const cleanGameShort = game.shortDescription
    ? stripHtmlToPlainSynopsis(game.shortDescription)
    : '';
  const incomingShort =
    cleanMetaShort && !isGenericPlaceholderSynopsis(cleanMetaShort, game.title)
      ? cleanMetaShort
      : undefined;
  const shouldUpgradeShortFromSteam =
    !currentOverride?.shortDescription &&
    Boolean(incomingShort) &&
    (!cleanGameShort ||
      isGenericPlaceholderSynopsis(cleanGameShort, game.title) ||
      (Number(meta.appId) > 0 && !isAuthoritativeSteamMetadata(game.enrichedMetadata)));
  const nextShortDescription = shouldUpgradeShortFromSteam
    ? incomingShort
    : cleanGameShort || game.shortDescription;

  const incomingDetailed = meta.detailedDescription || meta.aboutTheGame || '';
  const metaHasRichHtmlOrSteam =
    RICH_HTML_DESC_RE.test(incomingDetailed) || Number(meta.appId) > 0;
  const existingHasRichHtml = RICH_HTML_DESC_RE.test(game.detailedDescription || '');
  const preferredMetaDetailed = RICH_HTML_DESC_RE.test(meta.detailedDescription || '')
    ? meta.detailedDescription
    : RICH_HTML_DESC_RE.test(meta.aboutTheGame || '')
    ? meta.aboutTheGame
    : meta.detailedDescription || meta.aboutTheGame;
  const nextDetailedDescription =
    !currentOverride?.detailedDescription &&
    preferredMetaDetailed &&
    (!game.detailedDescription ||
      isGenericPlaceholderSynopsis(game.detailedDescription, game.title) ||
      (metaHasRichHtmlOrSteam && !existingHasRichHtml) ||
      (isAuthoritativeSteamMetadata(meta) &&
        !isAuthoritativeSteamMetadata(game.enrichedMetadata)))
      ? preferredMetaDetailed
      : game.detailedDescription || meta.detailedDescription || meta.aboutTheGame;

  const validIncomingDevs =
    meta.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
  const nextDevelopers =
    (!game.developers || game.developers.length === 0) && validIncomingDevs.length > 0
      ? validIncomingDevs
      : game.developers;
  const validIncomingPubs =
    meta.publishers?.filter((p) => p && p !== 'Unknown Publisher') || [];
  const nextPublishers =
    (!game.publishers || game.publishers.length === 0) && validIncomingPubs.length > 0
      ? validIncomingPubs
      : game.publishers;

  const gameHasMissingOrSentinelDate =
    !game.releaseDate ||
    game.releaseDate === 'TBA' ||
    isSentinelReleaseDate(game.releaseDate);
  const validMetaReleaseDate =
    meta.releaseDate && !isSentinelReleaseDate(meta.releaseDate)
      ? meta.releaseDate
      : undefined;
  const nextReleaseDate = gameHasMissingOrSentinelDate
    ? validMetaReleaseDate ||
      (isSentinelReleaseDate(game.releaseDate) ? 'TBA' : game.releaseDate)
    : game.releaseDate;

  const candidateSteamHeader = browseAssets?.headerImage || meta.headerImage;
  const nextHeaderImage =
    !hasUserHeaderOverride &&
    (!game.headerImage || isMicrosoftStoreAssetUrl(game.headerImage)) &&
    candidateSteamHeader &&
    !isMicrosoftStoreAssetUrl(candidateSteamHeader)
      ? candidateSteamHeader
      : game.headerImage;

  const candidateSteamCapsule = browseAssets?.capsuleImage || meta.capsuleImage;
  const nextCapsuleImage =
    !hasUserCoverOverride &&
    (!game.capsuleImage || isMicrosoftStoreAssetUrl(game.capsuleImage)) &&
    candidateSteamCapsule &&
    !isMicrosoftStoreAssetUrl(candidateSteamCapsule)
      ? candidateSteamCapsule
      : game.capsuleImage;

  const baselineMeta = existingRichMeta || game.enrichedMetadata;
  const richerScreenshots =
    (meta.screenshots?.length || 0) > (baselineMeta?.screenshots?.length || 0);
  const richerMovies = (meta.movies?.length || 0) > (baselineMeta?.movies?.length || 0);
  const upgradedPlaceholderSynopsis =
    Boolean(baselineMeta?.shortDescription) &&
    isGenericPlaceholderSynopsis(baselineMeta?.shortDescription, game.title) &&
    Boolean(nextShortDescription) &&
    !isGenericPlaceholderSynopsis(nextShortDescription, game.title);
  const updatedAbout =
    Boolean(meta.aboutTheGame) && meta.aboutTheGame !== baselineMeta?.aboutTheGame;
  const updatedLanguages =
    Boolean(
      meta.supportedLanguages &&
        meta.supportedLanguages !== baselineMeta?.supportedLanguages
    ) ||
    Boolean(
      (meta.languageOptions?.length || 0) > 0 &&
        (meta.languageOptions?.length !== baselineMeta?.languageOptions?.length ||
          JSON.stringify(meta.languageOptions) !==
            JSON.stringify(baselineMeta?.languageOptions))
    ) ||
    Boolean(
      meta.languageTableSchema &&
        meta.languageTableSchema !== baselineMeta?.languageTableSchema
    );
  const hasReqText = (req?: { minimum?: string; recommended?: string }) =>
    Boolean(req?.minimum?.trim() || req?.recommended?.trim());
  const updatedSystemRequirements =
    hasReqText(meta.systemRequirements) &&
    (meta.systemRequirements?.minimum !== baselineMeta?.systemRequirements?.minimum ||
      meta.systemRequirements?.recommended !== baselineMeta?.systemRequirements?.recommended);
  const updatedMacRequirements =
    hasReqText(meta.macRequirements) &&
    (meta.macRequirements?.minimum !== baselineMeta?.macRequirements?.minimum ||
      meta.macRequirements?.recommended !== baselineMeta?.macRequirements?.recommended);
  const updatedLinuxRequirements =
    hasReqText(meta.linuxRequirements) &&
    (meta.linuxRequirements?.minimum !== baselineMeta?.linuxRequirements?.minimum ||
      meta.linuxRequirements?.recommended !== baselineMeta?.linuxRequirements?.recommended);

  const existingReviewCount = game.reviewSummary?.totalReviews ?? 0;
  const incomingReviewCount = meta.reviewSummary?.totalReviews ?? 0;
  const shouldUpdateReviewSummary =
    hasRealSteamReviewSummary(meta.reviewSummary) &&
    (!game.reviewSummary ||
      incomingReviewCount > existingReviewCount ||
      (incomingReviewCount === existingReviewCount &&
        (meta.reviewSummary!.positivePercent !== game.reviewSummary.positivePercent ||
          meta.reviewSummary!.reviewScoreDesc !== game.reviewSummary.reviewScoreDesc)));
  const nextReviewSummary = shouldUpdateReviewSummary
    ? meta.reviewSummary
    : game.reviewSummary;

  const topLevelChanged =
    nextShortDescription !== game.shortDescription ||
    nextDetailedDescription !== game.detailedDescription ||
    nextDevelopers !== game.developers ||
    nextReleaseDate !== game.releaseDate ||
    nextHeaderImage !== game.headerImage ||
    nextCapsuleImage !== game.capsuleImage ||
    nextReviewSummary !== game.reviewSummary ||
    richerScreenshots ||
    richerMovies ||
    upgradedPlaceholderSynopsis ||
    updatedAbout ||
    updatedLanguages ||
    updatedSystemRequirements ||
    updatedMacRequirements ||
    updatedLinuxRequirements;

  return {
    nextShortDescription,
    nextDetailedDescription,
    nextDevelopers,
    nextPublishers,
    nextReleaseDate,
    nextHeaderImage,
    nextCapsuleImage,
    nextReviewSummary,
    topLevelChanged,
  };
}
