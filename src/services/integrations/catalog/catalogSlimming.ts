import type { CriticScoreData } from '../../../contracts/critic';
import {
  CanonicalGame,
  GamePlatformOwnership,
  StoreAchievementSummary,
} from '../../../contracts/game';
import type {
  QuotaSlimmedEnrichedMetadata,
  SteamEnrichedMetadata,
} from '../../../contracts/steam';
import { truncateHtmlSafely } from '../../steam/steamApi';

const MAX_STORED_SCREENSHOTS = 12;
const MAX_STORED_MOVIES = 4;
const MAX_STORED_HTML_DESCRIPTION_CHARS = 35000;
const MAX_STORED_PLAIN_DESCRIPTION_CHARS = 12000;

export const PROACTIVE_SLIM_LOCALSTORAGE_CHAR_THRESHOLD = 2_500_000;
export const PROACTIVE_SLIM_LOCALSTORAGE_GAME_COUNT_THRESHOLD = 350;

function getMaxStoredDescriptionChars(text: string): number {
  return /<[a-z!\/][^>]*>/i.test(text)
    ? MAX_STORED_HTML_DESCRIPTION_CHARS
    : MAX_STORED_PLAIN_DESCRIPTION_CHARS;
}

function fnv1aDualHashUpdate(state: [number, number], str: string): void {
  let h1 = state[0];
  let h2 = state[1];
  const len = str.length;
  h1 = Math.imul(h1 ^ len, 0x01000193) >>> 0;
  h2 = Math.imul(h2 ^ ((len << 1) | 1), 0x01000193) >>> 0;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ (code & 0xff), 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ (code >>> 8), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code & 0xff), 0x01000193) >>> 0;
  }
  state[0] = h1;
  state[1] = h2;
}

export function computeCatalogFingerprint(raw: string): string {
  const state: [number, number] = [0x811c9dc5, 0x9e3779b9];
  fnv1aDualHashUpdate(state, raw);
  return `${raw.length}:${state[0].toString(16).padStart(8, '0')}${state[1].toString(16).padStart(8, '0')}`;
}

export function computeCatalogGamesFingerprint(games: CanonicalGame[]): string {
  const state: [number, number] = [0x811c9dc5, 0x9e3779b9];
  fnv1aDualHashUpdate(state, String(games.length));
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g) continue;
    fnv1aDualHashUpdate(state, g.id || '');
    fnv1aDualHashUpdate(state, g.title || '');
    fnv1aDualHashUpdate(state, String(g.steamAppId ?? ''));
    fnv1aDualHashUpdate(state, String(g.reviewSummary?.positivePercent ?? ''));
    fnv1aDualHashUpdate(state, String(g.reviewScoreOverride?.score ?? ''));
    fnv1aDualHashUpdate(state, g.reviewScoreOverride?.source || '');
    fnv1aDualHashUpdate(state, g.headerImage || '');
    fnv1aDualHashUpdate(state, g.capsuleImage || '');
    fnv1aDualHashUpdate(state, g.shortDescription || '');
    fnv1aDualHashUpdate(state, g.releaseDate || '');
    fnv1aDualHashUpdate(state, String(Boolean(g.needsMatchReview)));
    if (Array.isArray(g.genres)) {
      fnv1aDualHashUpdate(state, g.genres.join('\u001f'));
    }
    if (Array.isArray(g.tags)) {
      fnv1aDualHashUpdate(state, g.tags.join('\u001f'));
    }
    if (g.enrichedMetadata) {
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.metacritic?.score ?? ''));
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.reviewSummary?.positivePercent ?? ''));
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.screenshots?.length ?? 0));
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.detailedDescription?.length ?? 0));
    }
    if (Array.isArray(g.platforms)) {
      fnv1aDualHashUpdate(state, String(g.platforms.length));
      for (let j = 0; j < g.platforms.length; j++) {
        const p = g.platforms[j];
        fnv1aDualHashUpdate(state, p.platformId || '');
        fnv1aDualHashUpdate(state, String(p.platformGameId || ''));
        fnv1aDualHashUpdate(state, String(Boolean(p.installed)));
        fnv1aDualHashUpdate(state, String(p.playtimeMinutes ?? ''));
        fnv1aDualHashUpdate(state, String(p.lastPlayed ?? ''));
        fnv1aDualHashUpdate(state, String(p.achievements?.unlocked ?? ''));
        fnv1aDualHashUpdate(state, String(p.achievements?.total ?? ''));
        fnv1aDualHashUpdate(state, String(p.achievements?.gamerscore?.earned ?? ''));
        fnv1aDualHashUpdate(state, String(p.ownershipType ?? ''));
        fnv1aDualHashUpdate(state, String(p.gamePassTier ?? ''));
        fnv1aDualHashUpdate(state, String(p.subscriptionTierId ?? ''));
        if (Array.isArray(p.satisfyingPassIds) && p.satisfyingPassIds.length > 0) {
          fnv1aDualHashUpdate(state, p.satisfyingPassIds.join('\u001f'));
        }
        fnv1aDualHashUpdate(state, String(Boolean(p.subscriptionExpired)));
        fnv1aDualHashUpdate(state, String(Boolean(p.isLeavingSoon)));
        fnv1aDualHashUpdate(state, String(Boolean(p.isRecentlyAddedToGamePass)));
      }
    }
  }
  return `g${games.length}:${state[0].toString(16).padStart(8, '0')}${state[1].toString(16).padStart(8, '0')}`;
}

export function areStringArraysEqual(
  a?: readonly string[] | null,
  b?: readonly string[] | null
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function areAchievementSummariesSubstantivelyEqual(
  a?: StoreAchievementSummary | null,
  b?: StoreAchievementSummary | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.unlocked === b.unlocked &&
    a.total === b.total &&
    a.percentage === b.percentage &&
    Boolean(a.isMastered) === Boolean(b.isMastered) &&
    a.lastUnlockedAt === b.lastUnlockedAt &&
    a.source === b.source &&
    Boolean(a.hasConflict) === Boolean(b.hasConflict) &&
    a.conflictDetails === b.conflictDetails &&
    a.gamerscore?.earned === b.gamerscore?.earned &&
    a.gamerscore?.total === b.gamerscore?.total &&
    a.xp?.earned === b.xp?.earned &&
    a.xp?.total === b.xp?.total
  );
}

export function areAchievementSummariesEqual(
  a?: StoreAchievementSummary | null,
  b?: StoreAchievementSummary | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return areAchievementSummariesSubstantivelyEqual(a, b) && a.syncedAt === b.syncedAt;
}

export function arePlatformOsFlagsEqual(
  a?: GamePlatformOwnership['platforms'],
  b?: GamePlatformOwnership['platforms']
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return areStringArraysEqual(a as readonly string[], b as readonly string[]);
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  return a.windows === b.windows && a.mac === b.mac && a.linux === b.linux;
}

function areWorksOnEqual(
  a?: CanonicalGame['worksOn'],
  b?: CanonicalGame['worksOn']
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.windows === b.windows &&
    a.mac === b.mac &&
    a.linux === b.linux &&
    a.Windows === b.Windows &&
    a.Mac === b.Mac &&
    a.Linux === b.Linux
  );
}

function areCriticScoreOverridesEqual(
  a?: CriticScoreData | null,
  b?: CriticScoreData | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.source === b.source &&
    a.score === b.score &&
    a.tier === b.tier &&
    a.url === b.url &&
    a.numReviews === b.numReviews &&
    a.summary === b.summary
  );
}

export function arePlatformOwnershipsEqual(
  a: GamePlatformOwnership,
  b: GamePlatformOwnership
): boolean {
  if (a === b) return true;
  return (
    a.platformId === b.platformId &&
    a.platformGameId === b.platformGameId &&
    a.storefrontAppId === b.storefrontAppId &&
    a.namespace === b.namespace &&
    a.catalogItemId === b.catalogItemId &&
    a.originalTitle === b.originalTitle &&
    Boolean(a.installed) === Boolean(b.installed) &&
    a.installPath === b.installPath &&
    a.executablePath === b.executablePath &&
    a.installSize === b.installSize &&
    a.version === b.version &&
    a.launchArguments === b.launchArguments &&
    a.isWindowsBinaryOnMac === b.isWindowsBinaryOnMac &&
    a.playtimeMinutes === b.playtimeMinutes &&
    a.lastPlayed === b.lastPlayed &&
    areAchievementSummariesEqual(a.achievements, b.achievements) &&
    arePlatformOsFlagsEqual(a.platforms, b.platforms) &&
    a.xboxProductId === b.xboxProductId &&
    a.packageFamilyName === b.packageFamilyName &&
    a.appUserModelId === b.appUserModelId &&
    a.xboxTitleId === b.xboxTitleId &&
    a.scid === b.scid &&
    a.msaAppId === b.msaAppId &&
    a.ownershipType === b.ownershipType &&
    a.gamePassTier === b.gamePassTier &&
    areStringArraysEqual(a.satisfyingPassIds, b.satisfyingPassIds) &&
    a.subscriptionTierId === b.subscriptionTierId &&
    a.subscriptionExpired === b.subscriptionExpired &&
    a.isLeavingSoon === b.isLeavingSoon &&
    a.isRecentlyAddedToGamePass === b.isRecentlyAddedToGamePass &&
    a.isCrossPlatformLauncherRuntime === b.isCrossPlatformLauncherRuntime &&
    a.isExternalLauncherStubPackage === b.isExternalLauncherStubPackage &&
    a.externalLauncher === b.externalLauncher &&
    a.externalLauncherUrl === b.externalLauncherUrl &&
    a.xboxBottleCompatibilityReason === b.xboxBottleCompatibilityReason &&
    a.xboxBottleCompatibilityTier === b.xboxBottleCompatibilityTier &&
    a.maxDownloadSizeBytes === b.maxDownloadSizeBytes &&
    a.pcMaxInstallSizeBytes === b.pcMaxInstallSizeBytes &&
    a.chainedLauncherHandoff === b.chainedLauncherHandoff &&
    a.externalStorefrontHandoff === b.externalStorefrontHandoff &&
    a.chainedExternalInstallId === b.chainedExternalInstallId &&
    a.chainedHandoffTopology === b.chainedHandoffTopology &&
    a.epicPartnerRegistryPath === b.epicPartnerRegistryPath &&
    a.requiresKernelAntiCheat === b.requiresKernelAntiCheat &&
    a.kernelAntiCheatName === b.kernelAntiCheatName &&
    a.antiCheatName === b.antiCheatName
  );
}

export function areCanonicalGamesShallowEqual(a: CanonicalGame, b: CanonicalGame): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.title !== b.title ||
    a.originalStoreTitle !== b.originalStoreTitle ||
    a.sortTitle !== b.sortTitle ||
    a.steamAppId !== b.steamAppId ||
    a.headerImage !== b.headerImage ||
    a.capsuleImage !== b.capsuleImage ||
    a.iconUrl !== b.iconUrl ||
    a.shortDescription !== b.shortDescription ||
    a.detailedDescription !== b.detailedDescription ||
    a.releaseDate !== b.releaseDate ||
    a.controllerSupport !== b.controllerSupport ||
    a.hdrSupport !== b.hdrSupport ||
    a.isVerifiedEntitlement !== b.isVerifiedEntitlement ||
    a.isExplicitNonSteam !== b.isExplicitNonSteam ||
    a.matchConfidence !== b.matchConfidence ||
    a.needsMatchReview !== b.needsMatchReview ||
    a.requiresKernelAntiCheat !== b.requiresKernelAntiCheat ||
    a.kernelAntiCheatName !== b.kernelAntiCheatName ||
    a.antiCheatName !== b.antiCheatName ||
    a.reviewSummary !== b.reviewSummary ||
    !areCriticScoreOverridesEqual(a.reviewScoreOverride, b.reviewScoreOverride) ||
    !areWorksOnEqual(a.worksOn, b.worksOn) ||
    !arePlatformOsFlagsEqual(a.platforms_os, b.platforms_os) ||
    !areStringArraysEqual(a.nativePlatforms, b.nativePlatforms) ||
    a.enrichedMetadata !== b.enrichedMetadata
  ) {
    return false;
  }
  if (
    !areStringArraysEqual(a.developers, b.developers) ||
    !areStringArraysEqual(a.publishers, b.publishers) ||
    !areStringArraysEqual(a.genres, b.genres) ||
    !areStringArraysEqual(a.tags, b.tags)
  ) {
    return false;
  }
  if (a.platforms.length !== b.platforms.length) return false;
  for (let i = 0; i < a.platforms.length; i++) {
    if (!arePlatformOwnershipsEqual(a.platforms[i], b.platforms[i])) return false;
  }
  return true;
}

const slimmedGameWeakMemo = new WeakMap<CanonicalGame, CanonicalGame>();

export function slimGameForLocalStorageQuota(game: CanonicalGame): CanonicalGame {
  if (!game || typeof game !== 'object') return game;
  const memoized = slimmedGameWeakMemo.get(game);
  if (memoized !== undefined) return memoized;

  const legacyMedia = game as CanonicalGame & { screenshots?: unknown[]; movies?: unknown[] };
  const topScreenshotsLen = Array.isArray(legacyMedia.screenshots)
    ? legacyMedia.screenshots.length
    : 0;
  const topMoviesLen = Array.isArray(legacyMedia.movies) ? legacyMedia.movies.length : 0;
  const slim: CanonicalGame = { ...game };
  Reflect.deleteProperty(slim, 'detailedDescription');
  Reflect.deleteProperty(slim, 'aboutTheGame');
  Reflect.deleteProperty(slim, 'shortDescription');
  Reflect.deleteProperty(slim, 'screenshots');
  Reflect.deleteProperty(slim, 'movies');
  Reflect.deleteProperty(slim, 'reviewSummary');
  Reflect.deleteProperty(slim, 'reviewScoreOverride');
  Reflect.deleteProperty(slim, 'lastSyncedAt');
  Reflect.deleteProperty(slim, 'controllerSupport');
  Reflect.deleteProperty(slim, 'hdrSupport');
  Reflect.deleteProperty(slim, 'antiCheatName');
  Reflect.deleteProperty(slim, 'matchConfidence');
  Reflect.deleteProperty(slim, 'needsMatchReview');
  Reflect.deleteProperty(slim, 'isVerifiedEntitlement');
  if (slim.worksOn || game.enrichedMetadata?.platforms) {
    Reflect.deleteProperty(slim, 'platforms_os');
  }
  if (slim.iconUrl && (slim.iconUrl === slim.headerImage || slim.iconUrl === slim.capsuleImage)) {
    Reflect.deleteProperty(slim, 'iconUrl');
  }
  if (slim.sortTitle === slim.title) {
    Reflect.deleteProperty(slim, 'sortTitle');
  }
  if (slim.originalStoreTitle === slim.title) {
    Reflect.deleteProperty(slim, 'originalStoreTitle');
  }
  // Trim non-first-paint metadata arrays (all restored losslessly on IDB/SQLite vault hydration)
  slim.developers = [];
  slim.publishers = [];
  slim.tags = [];
  slim.genres = Array.isArray(game.genres) ? game.genres.slice(0, 2) : [];

  if (Array.isArray(game.platforms)) {
    slim.platforms = game.platforms.map((p): GamePlatformOwnership => {
      const slimPlat: GamePlatformOwnership = {
        platformId: p.platformId,
        platformGameId: p.platformGameId,
        installed: Boolean(p.installed),
      };
      if (p.storefrontAppId && p.storefrontAppId !== p.platformGameId) {
        slimPlat.storefrontAppId = p.storefrontAppId;
      }
      if (p.namespace) slimPlat.namespace = p.namespace;
      if (p.catalogItemId) slimPlat.catalogItemId = p.catalogItemId;
      if (p.originalTitle && p.originalTitle !== game.title) {
        slimPlat.originalTitle = p.originalTitle;
      }
      if (typeof p.playtimeMinutes === 'number' && p.playtimeMinutes > 0) {
        slimPlat.playtimeMinutes = p.playtimeMinutes;
      }
      if (p.lastPlayed) {
        slimPlat.lastPlayed = p.lastPlayed;
      }
      if (p.platforms && typeof p.platforms === 'object') {
        slimPlat.platforms = p.platforms;
      }
      if (p.installed) {
        if (p.installPath) slimPlat.installPath = p.installPath;
        if (p.executablePath) slimPlat.executablePath = p.executablePath;
        if (typeof p.installSize === 'number' && p.installSize > 0) {
          slimPlat.installSize = p.installSize;
        }
        if (p.isWindowsBinaryOnMac !== undefined) {
          slimPlat.isWindowsBinaryOnMac = p.isWindowsBinaryOnMac;
        }
      }
      if (p.isCrossPlatformLauncherRuntime) {
        slimPlat.isCrossPlatformLauncherRuntime = true;
      }
      if (p.chainedLauncherHandoff) slimPlat.chainedLauncherHandoff = p.chainedLauncherHandoff;
      if (p.externalStorefrontHandoff) {
        slimPlat.externalStorefrontHandoff = p.externalStorefrontHandoff;
      }
      if (p.externalLauncher) slimPlat.externalLauncher = p.externalLauncher;
      if (p.requiresKernelAntiCheat) slimPlat.requiresKernelAntiCheat = true;
      if (p.kernelAntiCheatName) slimPlat.kernelAntiCheatName = p.kernelAntiCheatName;
      if (p.xboxBottleCompatibilityTier) {
        slimPlat.xboxBottleCompatibilityTier = p.xboxBottleCompatibilityTier;
      }
      if (p.xboxProductId) slimPlat.xboxProductId = p.xboxProductId;
      if (p.xboxTitleId) slimPlat.xboxTitleId = p.xboxTitleId;
      if (p.packageFamilyName) slimPlat.packageFamilyName = p.packageFamilyName;
      if (p.ownershipType !== undefined) {
        slimPlat.ownershipType = p.ownershipType;
        if (p.gamePassTier) slimPlat.gamePassTier = p.gamePassTier;
        if (Array.isArray(p.satisfyingPassIds) && p.satisfyingPassIds.length > 0) {
          slimPlat.satisfyingPassIds = p.satisfyingPassIds;
        }
        if (p.subscriptionTierId) slimPlat.subscriptionTierId = p.subscriptionTierId;
        if (p.subscriptionExpired !== undefined) {
          slimPlat.subscriptionExpired = p.subscriptionExpired;
        }
        if (p.isLeavingSoon) slimPlat.isLeavingSoon = true;
        if (p.isRecentlyAddedToGamePass) slimPlat.isRecentlyAddedToGamePass = true;
      }
      return slimPlat;
    });
  }
  if (game.enrichedMetadata && typeof game.enrichedMetadata === 'object') {
    const prevMeta = game.enrichedMetadata;
    const hasScreenshotsCount = Array.isArray(prevMeta.screenshots)
      ? prevMeta.screenshots.length
      : (prevMeta.hasScreenshotsCount ?? topScreenshotsLen);
    const hasMoviesCount = Array.isArray(prevMeta.movies)
      ? prevMeta.movies.length
      : (prevMeta.hasMoviesCount ?? topMoviesLen);
    const compactMeta: QuotaSlimmedEnrichedMetadata = {
      appId: prevMeta.appId,
      __quotaSlimmed: true,
    };
    if (prevMeta.metadataQuality !== undefined) {
      compactMeta.metadataQuality = prevMeta.metadataQuality;
    }
    if (prevMeta.enrichedSource !== undefined) {
      compactMeta.enrichedSource = prevMeta.enrichedSource;
    }
    if (typeof prevMeta.enrichedAt === 'number') {
      compactMeta.enrichedAt = prevMeta.enrichedAt;
    }
    if (typeof prevMeta.lastMediaSyncAttemptAt === 'number') {
      compactMeta.lastMediaSyncAttemptAt = prevMeta.lastMediaSyncAttemptAt;
    }
    if (prevMeta.mediaSyncOutcome !== undefined) {
      compactMeta.mediaSyncOutcome = prevMeta.mediaSyncOutcome;
    }
    if (typeof prevMeta.mediaSyncFailureCount === 'number') {
      compactMeta.mediaSyncFailureCount = prevMeta.mediaSyncFailureCount;
    }
    if (hasScreenshotsCount > 0) {
      compactMeta.hasScreenshotsCount = hasScreenshotsCount;
    }
    if (hasMoviesCount > 0) {
      compactMeta.hasMoviesCount = hasMoviesCount;
    }
    if (prevMeta.platforms && typeof prevMeta.platforms === 'object') {
      compactMeta.platforms = prevMeta.platforms;
    }
    if (
      prevMeta.achievements &&
      typeof prevMeta.achievements === 'object' &&
      prevMeta.achievements.total > 0
    ) {
      compactMeta.achievements = { total: prevMeta.achievements.total };
    }
    if (prevMeta.xboxDeliveryHints && typeof prevMeta.xboxDeliveryHints === 'object') {
      compactMeta.xboxDeliveryHints = prevMeta.xboxDeliveryHints;
    }
    slim.enrichedMetadata = compactMeta as SteamEnrichedMetadata;
  }
  slimmedGameWeakMemo.set(game, slim);
  slimmedGameWeakMemo.set(slim, slim);
  return slim;
}

const compactedGameWeakMemo = new WeakMap<CanonicalGame, CanonicalGame>();

export function compactGameForStorage(game: CanonicalGame): CanonicalGame {
  if (!game || typeof game !== 'object') return game;
  const memoized = compactedGameWeakMemo.get(game);
  if (memoized !== undefined) return memoized;

  let nextGame = game;
  if (typeof nextGame.detailedDescription === 'string') {
    const topDetailedMax = getMaxStoredDescriptionChars(nextGame.detailedDescription);
    if (nextGame.detailedDescription.length > topDetailedMax) {
      nextGame = {
        ...nextGame,
        detailedDescription: truncateHtmlSafely(nextGame.detailedDescription, topDetailedMax),
      };
    }
  }

  type LegacyTopLevelMediaGame = CanonicalGame & {
    aboutTheGame?: string;
    screenshots?: unknown[];
    movies?: unknown[];
  };

  const legacyTop = nextGame as LegacyTopLevelMediaGame;
  const rawTopAbout = legacyTop.aboutTheGame;
  if (typeof rawTopAbout === 'string') {
    const topAboutMax = getMaxStoredDescriptionChars(rawTopAbout);
    const trimmedTopAbout =
      rawTopAbout.length > topAboutMax
        ? truncateHtmlSafely(rawTopAbout, topAboutMax)
        : rawTopAbout;
    const finalTopAbout =
      nextGame.detailedDescription && trimmedTopAbout === nextGame.detailedDescription
        ? ''
        : trimmedTopAbout;
    if (finalTopAbout !== rawTopAbout) {
      const updatedTop: LegacyTopLevelMediaGame = {
        ...nextGame,
        aboutTheGame: finalTopAbout,
      };
      nextGame = updatedTop;
    }
  }

  const rawTopScreenshots = (nextGame as LegacyTopLevelMediaGame).screenshots;
  if (Array.isArray(rawTopScreenshots) && rawTopScreenshots.length > MAX_STORED_SCREENSHOTS) {
    const updatedTop: LegacyTopLevelMediaGame = {
      ...nextGame,
      screenshots: rawTopScreenshots.slice(0, MAX_STORED_SCREENSHOTS),
    };
    nextGame = updatedTop;
  }

  const rawTopMovies = (nextGame as LegacyTopLevelMediaGame).movies;
  if (Array.isArray(rawTopMovies) && rawTopMovies.length > MAX_STORED_MOVIES) {
    const updatedTop: LegacyTopLevelMediaGame = {
      ...nextGame,
      movies: rawTopMovies.slice(0, MAX_STORED_MOVIES),
    };
    nextGame = updatedTop;
  }

  const meta = nextGame.enrichedMetadata;
  if (!meta || typeof meta !== 'object') {
    compactedGameWeakMemo.set(game, nextGame);
    compactedGameWeakMemo.set(nextGame, nextGame);
    return nextGame;
  }

  const screenshotsNeedTrim =
    Array.isArray(meta.screenshots) && meta.screenshots.length > MAX_STORED_SCREENSHOTS;
  const moviesNeedTrim = Array.isArray(meta.movies) && meta.movies.length > MAX_STORED_MOVIES;
  const metaDetailedMax =
    typeof meta.detailedDescription === 'string'
      ? getMaxStoredDescriptionChars(meta.detailedDescription)
      : MAX_STORED_PLAIN_DESCRIPTION_CHARS;
  const metaAboutMax =
    typeof meta.aboutTheGame === 'string'
      ? getMaxStoredDescriptionChars(meta.aboutTheGame)
      : MAX_STORED_PLAIN_DESCRIPTION_CHARS;
  const detailedDescNeedsTrim =
    typeof meta.detailedDescription === 'string' &&
    meta.detailedDescription.length > metaDetailedMax;
  const aboutNeedsTrim =
    typeof meta.aboutTheGame === 'string' && meta.aboutTheGame.length > metaAboutMax;

  const trimmedDetailed = detailedDescNeedsTrim
    ? truncateHtmlSafely(meta.detailedDescription!, metaDetailedMax)
    : meta.detailedDescription;
  const trimmedAbout = aboutNeedsTrim
    ? truncateHtmlSafely(meta.aboutTheGame!, metaAboutMax)
    : meta.aboutTheGame;
  const hasDuplicateAbout = Boolean(
    trimmedDetailed && trimmedAbout && trimmedAbout === trimmedDetailed
  );

  if (
    !screenshotsNeedTrim &&
    !moviesNeedTrim &&
    !detailedDescNeedsTrim &&
    !aboutNeedsTrim &&
    !hasDuplicateAbout
  ) {
    compactedGameWeakMemo.set(game, nextGame);
    compactedGameWeakMemo.set(nextGame, nextGame);
    return nextGame;
  }

  const nextMeta = {
    ...meta,
    screenshots: screenshotsNeedTrim
      ? meta.screenshots.slice(0, MAX_STORED_SCREENSHOTS)
      : meta.screenshots,
    movies: moviesNeedTrim ? meta.movies.slice(0, MAX_STORED_MOVIES) : meta.movies,
    detailedDescription: trimmedDetailed,
    aboutTheGame: hasDuplicateAbout ? '' : (trimmedAbout ?? ''),
  };

  const finalCompacted: CanonicalGame = {
    ...nextGame,
    enrichedMetadata: nextMeta,
  };
  compactedGameWeakMemo.set(game, finalCompacted);
  compactedGameWeakMemo.set(finalCompacted, finalCompacted);
  return finalCompacted;
}

function hasNonPlaceholderStrings(list: string[] | undefined, placeholder: string): boolean {
  return Boolean(
    Array.isArray(list) &&
      list.some((s) => typeof s === 'string' && s.trim().length > 0 && s !== placeholder)
  );
}

export interface RecoverFromDonorOptions {
  allowReviewScoreOverride?: boolean;
}

/**
 * Checks whether two platform ownership entries on the same storefront represent compatible
 * product entitlements (preventing e.g. `xbox:9NRRJLLXM68V` from donating fields to `xbox:9P38D19T7LRV`).
 */
export function arePlatformEntriesCompatibleForDonor(
  targetPlat: GamePlatformOwnership,
  donorPlat: GamePlatformOwnership
): boolean {
  if (!targetPlat?.platformId || !donorPlat?.platformId) return false;
  const tpId = String(targetPlat.platformId).toLowerCase();
  const dpId = String(donorPlat.platformId).toLowerCase();
  if (tpId !== dpId) return false;

  if (tpId === 'xbox') {
    const tGameId = String(targetPlat.platformGameId || '').trim().toLowerCase();
    const tProdId = String(targetPlat.xboxProductId || '').trim().toLowerCase();
    const dGameId = String(donorPlat.platformGameId || '').trim().toLowerCase();
    const dProdId = String(donorPlat.xboxProductId || '').trim().toLowerCase();
    const tIds = [tGameId, tProdId].filter(Boolean);
    const dIds = [dGameId, dProdId].filter(Boolean);
    if (tIds.length === 0 || dIds.length === 0) return true;
    if (tProdId && dProdId && tProdId !== dProdId) return false;
    return tIds.some((id) => dIds.includes(id));
  }

  const tRaw = String(targetPlat.platformGameId || '').trim();
  const dRaw = String(donorPlat.platformGameId || '').trim();
  if (!tRaw || !dRaw) return true;
  return tRaw === dRaw;
}

/**
 * Returns `true` when `donor` is structurally compatible with `target` as a metadata/summary
 * donor: no conflicting product IDs on any shared storefront, no conflicting explicit Steam
 * App IDs, and no opposite `isExplicitNonSteam` polarity.
 */
export function isDonorGameCompatibleWithTarget(
  target: CanonicalGame,
  donor?: CanonicalGame | null
): boolean {
  if (!donor) return true;
  if (target.steamAppId && donor.steamAppId && target.steamAppId !== donor.steamAppId) {
    return false;
  }
  if (Boolean(donor.isExplicitNonSteam) !== Boolean(target.isExplicitNonSteam)) {
    return false;
  }
  const targetPlats = Array.isArray(target.platforms) ? target.platforms : [];
  const donorPlats = Array.isArray(donor.platforms) ? donor.platforms : [];
  for (const tp of targetPlats) {
    if (!tp?.platformId) continue;
    const tpLower = String(tp.platformId).toLowerCase();
    const sameStoreDonorPlats = donorPlats.filter(
      (dp) => dp?.platformId && String(dp.platformId).toLowerCase() === tpLower
    );
    if (sameStoreDonorPlats.length === 0) continue;
    if (!sameStoreDonorPlats.some((dp) => arePlatformEntriesCompatibleForDonor(tp, dp))) {
      return false;
    }
  }
  return true;
}

export function recoverRichSummaryFieldsFromDonor(
  target: CanonicalGame,
  donor?: CanonicalGame | null,
  donorMeta?: CanonicalGame['enrichedMetadata'] | null,
  wasSlimmed = false,
  options?: RecoverFromDonorOptions
): CanonicalGame {
  const donorCompatible = isDonorGameCompatibleWithTarget(target, donor);
  const effectiveDonor = donorCompatible ? donor : undefined;

  const isMetaCompatibleWithTarget = (
    meta?: CanonicalGame['enrichedMetadata'] | null
  ): meta is NonNullable<CanonicalGame['enrichedMetadata']> => {
    if (!meta || meta.__quotaSlimmed) return false;
    const metaAppId = Number(meta.appId);
    if (Number.isFinite(metaAppId) && metaAppId > 0) {
      if (target.isExplicitNonSteam === true) return false;
      if (typeof target.steamAppId === 'number' && target.steamAppId > 0 && metaAppId !== target.steamAppId) {
        return false;
      }
    }
    return true;
  };

  const canUsePassedDonorMeta = Boolean(
    donorMeta &&
      isMetaCompatibleWithTarget(donorMeta) &&
      (donorCompatible || (donorMeta !== donor?.enrichedMetadata && !donor))
  );
  const effectiveMeta = canUsePassedDonorMeta
    ? donorMeta!
    : isMetaCompatibleWithTarget(effectiveDonor?.enrichedMetadata)
    ? effectiveDonor!.enrichedMetadata
    : undefined;

  if (!effectiveDonor && !effectiveMeta) {
    return target;
  }

  const targetIsSlimmed = Boolean(wasSlimmed || target.enrichedMetadata?.__quotaSlimmed);

  const nextShortDescription =
    typeof target.shortDescription === 'string' && target.shortDescription.trim().length > 0
      ? target.shortDescription
      : typeof effectiveDonor?.shortDescription === 'string' &&
        effectiveDonor.shortDescription.trim().length > 0
      ? effectiveDonor.shortDescription
      : typeof effectiveMeta?.shortDescription === 'string' &&
        effectiveMeta.shortDescription.trim().length > 0
      ? effectiveMeta.shortDescription
      : target.shortDescription;

  const nextDetailedDescription =
    typeof target.detailedDescription === 'string' && target.detailedDescription.trim().length > 0
      ? target.detailedDescription
      : typeof effectiveDonor?.detailedDescription === 'string' &&
        effectiveDonor.detailedDescription.trim().length > 0
      ? effectiveDonor.detailedDescription
      : typeof effectiveMeta?.detailedDescription === 'string' &&
        effectiveMeta.detailedDescription.trim().length > 0
      ? effectiveMeta.detailedDescription
      : typeof effectiveMeta?.aboutTheGame === 'string' &&
        effectiveMeta.aboutTheGame.trim().length > 0
      ? effectiveMeta.aboutTheGame
      : target.detailedDescription;

  const nextDevelopers = hasNonPlaceholderStrings(target.developers, 'Unknown Developer')
    ? target.developers
    : hasNonPlaceholderStrings(effectiveDonor?.developers, 'Unknown Developer')
    ? effectiveDonor!.developers
    : hasNonPlaceholderStrings(effectiveMeta?.developers, 'Unknown Developer')
    ? effectiveMeta!.developers
    : target.developers;

  const nextPublishers = hasNonPlaceholderStrings(target.publishers, 'Unknown Publisher')
    ? target.publishers
    : hasNonPlaceholderStrings(effectiveDonor?.publishers, 'Unknown Publisher')
    ? effectiveDonor!.publishers
    : hasNonPlaceholderStrings(effectiveMeta?.publishers, 'Unknown Publisher')
    ? effectiveMeta!.publishers
    : target.publishers;

  const nextTags =
    Array.isArray(target.tags) && target.tags.length > 0
      ? target.tags
      : Array.isArray(effectiveDonor?.tags) && effectiveDonor.tags.length > 0
      ? effectiveDonor.tags
      : Array.isArray(effectiveMeta?.tags) && effectiveMeta.tags.length > 0
      ? effectiveMeta.tags
      : target.tags;

  const donorGenres =
    Array.isArray(effectiveDonor?.genres) && effectiveDonor.genres.length > 0
      ? effectiveDonor.genres
      : Array.isArray(effectiveMeta?.genres) && effectiveMeta.genres.length > 0
      ? effectiveMeta.genres
      : undefined;
  const nextGenres =
    Array.isArray(target.genres) &&
    target.genres.length > 0 &&
    !(targetIsSlimmed && donorGenres && donorGenres.length > target.genres.length)
      ? target.genres
      : donorGenres ?? target.genres;

  const targetHasReviews = Boolean(
    target.reviewSummary &&
      (target.reviewSummary.totalReviews > 0 || target.reviewSummary.positivePercent > 0)
  );
  const donorHasReviews = Boolean(
    effectiveDonor?.reviewSummary &&
      (effectiveDonor.reviewSummary.totalReviews > 0 ||
        effectiveDonor.reviewSummary.positivePercent > 0)
  );
  const metaHasReviews = Boolean(
    effectiveMeta?.reviewSummary &&
      (effectiveMeta.reviewSummary.totalReviews > 0 ||
        effectiveMeta.reviewSummary.positivePercent > 0)
  );
  const nextReviewSummary = targetHasReviews
    ? target.reviewSummary
    : donorHasReviews
    ? effectiveDonor!.reviewSummary
    : metaHasReviews
    ? effectiveMeta!.reviewSummary
    : target.reviewSummary;

  const allowReviewScoreOverrideCarry = options?.allowReviewScoreOverride !== false;
  const nextReviewScoreOverride =
    target.reviewScoreOverride !== undefined
      ? target.reviewScoreOverride
      : allowReviewScoreOverrideCarry
      ? effectiveDonor?.reviewScoreOverride
      : undefined;
  const nextControllerSupport =
    target.controllerSupport ||
    effectiveDonor?.controllerSupport ||
    effectiveMeta?.controllerSupport;
  const nextHdrSupport =
    target.hdrSupport ?? effectiveDonor?.hdrSupport ?? effectiveMeta?.hdrSupport;
  const nextNativePlatforms =
    Array.isArray(target.nativePlatforms) && target.nativePlatforms.length > 0
      ? target.nativePlatforms
      : effectiveDonor?.nativePlatforms;
  const nextWorksOn = target.worksOn || effectiveDonor?.worksOn;
  const nextPlatformsOs = target.platforms_os || effectiveDonor?.platforms_os;
  const nextOriginalStoreTitle = target.originalStoreTitle || effectiveDonor?.originalStoreTitle;
  const nextRequiresKernelAntiCheat =
    target.requiresKernelAntiCheat ?? effectiveDonor?.requiresKernelAntiCheat;
  const nextKernelAntiCheatName =
    target.kernelAntiCheatName || effectiveDonor?.kernelAntiCheatName;
  const nextAntiCheatName = target.antiCheatName || effectiveDonor?.antiCheatName;

  // Also restore platform-level fields stripped during localStorage quota slimming
  let platformsRecovered = false;
  let nextPlatforms = target.platforms;
  if (
    Array.isArray(target.platforms) &&
    Array.isArray(effectiveDonor?.platforms) &&
    effectiveDonor.platforms.length > 0
  ) {
    const recoveredPlats = target.platforms.map((tp) => {
      const dp = effectiveDonor.platforms.find(
        (p) => p.platformId === tp.platformId && arePlatformEntriesCompatibleForDonor(tp, p)
      );
      if (!dp) return tp;
      const mergedAchievements = tp.achievements ?? dp.achievements;
      const mergedNamespace = tp.namespace || dp.namespace;
      const mergedCatalogItemId = tp.catalogItemId || dp.catalogItemId;
      const mergedStorefrontAppId = tp.storefrontAppId || dp.storefrontAppId;
      const mergedChainedHandoff = tp.chainedLauncherHandoff || dp.chainedLauncherHandoff;
      const mergedExternalHandoff = tp.externalStorefrontHandoff || dp.externalStorefrontHandoff;
      const mergedExternalLauncher = tp.externalLauncher || dp.externalLauncher;
      const mergedExternalLauncherUrl = tp.externalLauncherUrl || dp.externalLauncherUrl;
      const mergedChainedInstallId = tp.chainedExternalInstallId || dp.chainedExternalInstallId;
      const mergedChainedTopology = tp.chainedHandoffTopology || dp.chainedHandoffTopology;
      const mergedEpicPartnerReg = tp.epicPartnerRegistryPath || dp.epicPartnerRegistryPath;
      const mergedReqAc = tp.requiresKernelAntiCheat ?? dp.requiresKernelAntiCheat;
      const mergedKernelAcName = tp.kernelAntiCheatName || dp.kernelAntiCheatName;
      const mergedAcName = tp.antiCheatName || dp.antiCheatName;
      const mergedXboxTier = tp.xboxBottleCompatibilityTier || dp.xboxBottleCompatibilityTier;
      const mergedXboxReason =
        tp.xboxBottleCompatibilityReason || dp.xboxBottleCompatibilityReason;
      const mergedStubPkg = tp.isExternalLauncherStubPackage ?? dp.isExternalLauncherStubPackage;
      const mergedMaxDl = tp.maxDownloadSizeBytes ?? dp.maxDownloadSizeBytes;
      const mergedPcMaxInstall = tp.pcMaxInstallSizeBytes ?? dp.pcMaxInstallSizeBytes;
      const mergedPlatOs = tp.platforms || dp.platforms;
      const mergedAumid = tp.appUserModelId || dp.appUserModelId;
      const mergedScid = tp.scid || dp.scid;
      const mergedMsaAppId = tp.msaAppId || dp.msaAppId;

      if (
        mergedAchievements === tp.achievements &&
        mergedNamespace === tp.namespace &&
        mergedCatalogItemId === tp.catalogItemId &&
        mergedStorefrontAppId === tp.storefrontAppId &&
        mergedChainedHandoff === tp.chainedLauncherHandoff &&
        mergedExternalHandoff === tp.externalStorefrontHandoff &&
        mergedExternalLauncher === tp.externalLauncher &&
        mergedExternalLauncherUrl === tp.externalLauncherUrl &&
        mergedChainedInstallId === tp.chainedExternalInstallId &&
        mergedChainedTopology === tp.chainedHandoffTopology &&
        mergedEpicPartnerReg === tp.epicPartnerRegistryPath &&
        mergedReqAc === tp.requiresKernelAntiCheat &&
        mergedKernelAcName === tp.kernelAntiCheatName &&
        mergedAcName === tp.antiCheatName &&
        mergedXboxTier === tp.xboxBottleCompatibilityTier &&
        mergedXboxReason === tp.xboxBottleCompatibilityReason &&
        mergedStubPkg === tp.isExternalLauncherStubPackage &&
        mergedMaxDl === tp.maxDownloadSizeBytes &&
        mergedPcMaxInstall === tp.pcMaxInstallSizeBytes &&
        mergedPlatOs === tp.platforms &&
        mergedAumid === tp.appUserModelId &&
        mergedScid === tp.scid &&
        mergedMsaAppId === tp.msaAppId
      ) {
        return tp;
      }

      platformsRecovered = true;
      return {
        ...tp,
        ...(mergedAchievements !== undefined ? { achievements: mergedAchievements } : {}),
        ...(mergedNamespace !== undefined ? { namespace: mergedNamespace } : {}),
        ...(mergedCatalogItemId !== undefined ? { catalogItemId: mergedCatalogItemId } : {}),
        ...(mergedStorefrontAppId !== undefined ? { storefrontAppId: mergedStorefrontAppId } : {}),
        ...(mergedChainedHandoff !== undefined
          ? { chainedLauncherHandoff: mergedChainedHandoff }
          : {}),
        ...(mergedExternalHandoff !== undefined
          ? { externalStorefrontHandoff: mergedExternalHandoff }
          : {}),
        ...(mergedExternalLauncher !== undefined ? { externalLauncher: mergedExternalLauncher } : {}),
        ...(mergedExternalLauncherUrl !== undefined
          ? { externalLauncherUrl: mergedExternalLauncherUrl }
          : {}),
        ...(mergedChainedInstallId !== undefined
          ? { chainedExternalInstallId: mergedChainedInstallId }
          : {}),
        ...(mergedChainedTopology !== undefined
          ? { chainedHandoffTopology: mergedChainedTopology }
          : {}),
        ...(mergedEpicPartnerReg !== undefined
          ? { epicPartnerRegistryPath: mergedEpicPartnerReg }
          : {}),
        ...(mergedReqAc !== undefined ? { requiresKernelAntiCheat: mergedReqAc } : {}),
        ...(mergedKernelAcName !== undefined ? { kernelAntiCheatName: mergedKernelAcName } : {}),
        ...(mergedAcName !== undefined ? { antiCheatName: mergedAcName } : {}),
        ...(mergedXboxTier !== undefined ? { xboxBottleCompatibilityTier: mergedXboxTier } : {}),
        ...(mergedXboxReason !== undefined
          ? { xboxBottleCompatibilityReason: mergedXboxReason }
          : {}),
        ...(mergedStubPkg !== undefined ? { isExternalLauncherStubPackage: mergedStubPkg } : {}),
        ...(mergedMaxDl !== undefined ? { maxDownloadSizeBytes: mergedMaxDl } : {}),
        ...(mergedPcMaxInstall !== undefined ? { pcMaxInstallSizeBytes: mergedPcMaxInstall } : {}),
        ...(mergedPlatOs !== undefined ? { platforms: mergedPlatOs } : {}),
        ...(mergedAumid !== undefined ? { appUserModelId: mergedAumid } : {}),
        ...(mergedScid !== undefined ? { scid: mergedScid } : {}),
        ...(mergedMsaAppId !== undefined ? { msaAppId: mergedMsaAppId } : {}),
      };
    });
    if (platformsRecovered) {
      nextPlatforms = recoveredPlats;
    }
  }

  if (
    !platformsRecovered &&
    nextShortDescription === target.shortDescription &&
    nextDetailedDescription === target.detailedDescription &&
    nextDevelopers === target.developers &&
    nextPublishers === target.publishers &&
    nextTags === target.tags &&
    nextGenres === target.genres &&
    nextReviewSummary === target.reviewSummary &&
    nextReviewScoreOverride === target.reviewScoreOverride &&
    nextControllerSupport === target.controllerSupport &&
    nextHdrSupport === target.hdrSupport &&
    nextNativePlatforms === target.nativePlatforms &&
    nextWorksOn === target.worksOn &&
    nextPlatformsOs === target.platforms_os &&
    nextOriginalStoreTitle === target.originalStoreTitle &&
    nextRequiresKernelAntiCheat === target.requiresKernelAntiCheat &&
    nextKernelAntiCheatName === target.kernelAntiCheatName &&
    nextAntiCheatName === target.antiCheatName
  ) {
    return target;
  }

  return {
    ...target,
    ...(platformsRecovered ? { platforms: nextPlatforms } : {}),
    ...(nextShortDescription !== undefined ? { shortDescription: nextShortDescription } : {}),
    ...(nextDetailedDescription !== undefined
      ? { detailedDescription: nextDetailedDescription }
      : {}),
    ...(nextDevelopers !== undefined ? { developers: nextDevelopers } : {}),
    ...(nextPublishers !== undefined ? { publishers: nextPublishers } : {}),
    ...(nextTags !== undefined ? { tags: nextTags } : {}),
    ...(nextGenres !== undefined ? { genres: nextGenres } : {}),
    ...(nextReviewSummary !== undefined ? { reviewSummary: nextReviewSummary } : {}),
    ...(nextReviewScoreOverride !== undefined
      ? { reviewScoreOverride: nextReviewScoreOverride }
      : {}),
    ...(nextControllerSupport !== undefined ? { controllerSupport: nextControllerSupport } : {}),
    ...(nextHdrSupport !== undefined ? { hdrSupport: nextHdrSupport } : {}),
    ...(nextNativePlatforms !== undefined ? { nativePlatforms: nextNativePlatforms } : {}),
    ...(nextWorksOn !== undefined ? { worksOn: nextWorksOn } : {}),
    ...(nextPlatformsOs !== undefined ? { platforms_os: nextPlatformsOs } : {}),
    ...(nextOriginalStoreTitle !== undefined ? { originalStoreTitle: nextOriginalStoreTitle } : {}),
    ...(nextRequiresKernelAntiCheat !== undefined
      ? { requiresKernelAntiCheat: nextRequiresKernelAntiCheat }
      : {}),
    ...(nextKernelAntiCheatName !== undefined
      ? { kernelAntiCheatName: nextKernelAntiCheatName }
      : {}),
    ...(nextAntiCheatName !== undefined ? { antiCheatName: nextAntiCheatName } : {}),
  };
}
