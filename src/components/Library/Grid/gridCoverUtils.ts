import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { unwrapOlMediaUrl } from '../../../contracts/network';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import steamEnrichedCache from '../../../services/storage/steamEnrichedCache.json';
import steamBlurbCache from '../../../services/storage/steamBlurbCache.json';
import gogEnrichedCache from '../../../services/storage/gogEnrichedCache.json';
import { steamApi } from '../../../services/steam/steamApi';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
  normalizeKey,
} from '../../../services/igdb/igdbCoverService';
import {
  extractFirstParagraph,
  isGenericPlaceholderSynopsis,
  stripHtmlToPlainSynopsis,
  GOG_SPECIAL_DESCRIPTIONS,
} from '../../../services/steam/fallbackMetadataProvider';
import { getUserOverrideForGame } from '../../../services/storage/userOverrideStorage';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';

interface SteamEnrichedCacheEntry {
  shortDescription?: string;
  releaseDate?: string;
}

interface GogEnrichedCacheEntry {
  shortDescription?: string;
  aboutTheGame?: string;
  detailedDescription?: string;
}

interface GameWithLegacyImages {
  images?: {
    cover?: string;
  };
}

const typedSteamBlurbCache = steamBlurbCache as Record<string, string | undefined>;
const typedSteamEnrichedCache = steamEnrichedCache as Record<
  string,
  SteamEnrichedCacheEntry | undefined
>;
const typedGogEnrichedCache = gogEnrichedCache as Record<
  string,
  GogEnrichedCacheEntry | undefined
>;

export const TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });

export function isPlaceholderSynopsis(desc?: string, title?: string): boolean {
  return isGenericPlaceholderSynopsis(desc, title);
}

export function getCleanSynopsis(
  game: CanonicalGame,
  targetAppId?: number | null,
  userOverride?: UserGameOverride | null
): string | null {
  const cleanCandidate = (raw?: string | null): string | null => {
    if (!raw) return null;
    const stripped = stripHtmlToPlainSynopsis(raw, 280);
    if (!stripped || isPlaceholderSynopsis(stripped, game.title)) return null;
    return stripped;
  };

  // 0. User manual override ALWAYS takes priority #1
  const effectiveOverride =
    userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  const overrideDesc = cleanCandidate(effectiveOverride?.shortDescription);
  if (overrideDesc) {
    return overrideDesc;
  }
  if (effectiveOverride) {
    const overrideGameDesc = cleanCandidate(game.shortDescription);
    if (overrideGameDesc) {
      return overrideGameDesc;
    }
  }

  // If user explicitly unlinked from Steam, targetAppId should be ignored
  const effectiveAppId = effectiveOverride?.steamAppId === null ? null : targetAppId;

  // 1. Steam blurb cache
  if (effectiveAppId) {
    const blurb = cleanCandidate(typedSteamBlurbCache[String(effectiveAppId)]);
    if (blurb) {
      return blurb;
    }
  }

  // 2. Steam enriched cache
  if (effectiveAppId) {
    const cached = typedSteamEnrichedCache[String(effectiveAppId)];
    const cachedDesc = cleanCandidate(cached?.shortDescription);
    if (cachedDesc) {
      return cachedDesc;
    }
  }

  // 3. Steam API live memory cache
  if (effectiveAppId) {
    const live = steamApi.getCachedMetadata(effectiveAppId);
    const liveDesc = cleanCandidate(live?.shortDescription);
    if (liveDesc) {
      return liveDesc;
    }
  }

  // 4. Curated GOG special descriptions
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const special = GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId];
    const specialLead = cleanCandidate(special?.lead);
    if (specialLead) {
      return specialLead;
    }
    const gogCached = typedGogEnrichedCache[gogPlat.platformGameId];
    const gogDesc = cleanCandidate(gogCached?.shortDescription);
    if (gogDesc) {
      return gogDesc;
    }
  }

  // 5. Enriched metadata on game
  const enrichedDesc = cleanCandidate(game.enrichedMetadata?.shortDescription);
  if (enrichedDesc) {
    return enrichedDesc;
  }

  // 6. Game shortDescription (if not a placeholder)
  const gameDesc = cleanCandidate(game.shortDescription);
  if (gameDesc) {
    return gameDesc;
  }

  // 7. First paragraph of game description
  const gogCachedData = gogPlat?.platformGameId
    ? typedGogEnrichedCache[gogPlat.platformGameId]
    : null;
  const firstPara =
    extractFirstParagraph(game.enrichedMetadata?.detailedDescription, 280) ||
    extractFirstParagraph(game.enrichedMetadata?.aboutTheGame, 280) ||
    extractFirstParagraph(gogCachedData?.aboutTheGame, 280) ||
    extractFirstParagraph(gogCachedData?.detailedDescription, 280) ||
    extractFirstParagraph(game.shortDescription, 280);

  if (firstPara && !isPlaceholderSynopsis(firstPara, game.title)) {
    return stripHtmlToPlainSynopsis(firstPara, 280);
  }

  // 8. Clean summary from genres and developers
  if (game.genres && game.genres.length > 0) {
    const cleanGenres = game.genres
      .map((g) => g.replace(/\s*on GOG\.com.*$/i, '').replace(/\s*\(DRM-Free\)/i, '').trim())
      .filter(
        (g) =>
          g.length > 0 &&
          !g.toLowerCase().includes('drm-free') &&
          !g.toLowerCase().includes('gog') &&
          !g.toLowerCase().includes('store exclusive')
      );
    if (cleanGenres.length > 0) {
      const dev = game.developers?.[0] ? ` developed by ${game.developers[0]}` : '';
      return stripHtmlToPlainSynopsis(
        `${game.title} is a ${cleanGenres.slice(0, 3).join(', ')} title${dev}.`,
        280
      );
    }
  }

  return null;
}

export function hasStoreSynopsis(
  game: CanonicalGame,
  targetAppId?: number | null,
  userOverride?: UserGameOverride | null
): boolean {
  const effectiveOverride =
    userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  if (
    effectiveOverride?.shortDescription &&
    !isPlaceholderSynopsis(effectiveOverride.shortDescription, game.title)
  ) {
    return true;
  }
  const effectiveAppId = effectiveOverride?.steamAppId === null ? null : targetAppId;
  if (effectiveAppId) {
    const blurb = typedSteamBlurbCache[String(effectiveAppId)];
    if (blurb && !isPlaceholderSynopsis(blurb, game.title)) return true;
    const cached = typedSteamEnrichedCache[String(effectiveAppId)];
    if (cached?.shortDescription && !isPlaceholderSynopsis(cached.shortDescription, game.title)) {
      return true;
    }
    const live = steamApi.getCachedMetadata(effectiveAppId);
    if (live?.shortDescription && !isPlaceholderSynopsis(live.shortDescription, game.title)) {
      return true;
    }
  }
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const special = GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId];
    if (special?.lead && !isPlaceholderSynopsis(special.lead, game.title)) return true;
    const gogCached = typedGogEnrichedCache[gogPlat.platformGameId];
    if (
      gogCached?.shortDescription &&
      !isPlaceholderSynopsis(gogCached.shortDescription, game.title)
    ) {
      return true;
    }
  }
  if (
    game.enrichedMetadata?.shortDescription &&
    !isPlaceholderSynopsis(game.enrichedMetadata.shortDescription, game.title)
  ) {
    return true;
  }
  if (game.shortDescription && !isPlaceholderSynopsis(game.shortDescription, game.title)) {
    return true;
  }
  return false;
}

export function getReleaseYear(game: CanonicalGame, targetAppId?: number | null): string | null {
  const maxReasonableYear = new Date().getFullYear() + 10;
  const extractValidYear = (raw?: string | null): string | null => {
    if (!raw || raw === 'TBA') return null;
    const anyFourDigit = raw.match(/\b(\d{4})\b/);
    if (anyFourDigit) {
      const yr = Number(anyFourDigit[1]);
      if (yr < 1975 || yr > maxReasonableYear) return null;
      return String(yr);
    }
    return null;
  };

  const fromGame = extractValidYear(game.releaseDate);
  if (fromGame) return fromGame;

  if (targetAppId) {
    const cached = typedSteamEnrichedCache[String(targetAppId)];
    const fromCached = extractValidYear(cached?.releaseDate);
    if (fromCached) return fromCached;
    const live = steamApi.getCachedMetadata(targetAppId);
    const fromLive = extractValidYear(live?.releaseDate);
    if (fromLive) return fromLive;
  }
  return null;
}

export function isMicrosoftOrXboxAssetUrl(url?: string | null): boolean {
  if (!url) return false;
  const unwrapped = unwrapOlMediaUrl(url).toLowerCase();
  return unwrapped.includes('s-microsoft.com') || unwrapped.includes('xboxlive.com');
}

export function hasUncheckedSteamBrowseAssets(appId: number): boolean {
  const apiWithPeek = steamApi as typeof steamApi & {
    peekCachedBrowseAssets?: (id: number) => unknown;
  };
  if (typeof apiWithPeek.peekCachedBrowseAssets === 'function') {
    return apiWithPeek.peekCachedBrowseAssets(appId) === undefined;
  }
  return !steamApi.getStoreBrowseAssetsInstant(appId)?.capsuleImage;
}

export const globalAttemptedCoverLookups = new Set<string>();
const resolvedCandidateIndexCache = new Map<string, number>();
export const failedCoverUrls = new Set<string>();

export function clearAttemptedCoverLookups(): void {
  globalAttemptedCoverLookups.clear();
}

export function clearFailedCoverUrls(gameId?: string): void {
  failedCoverUrls.clear();
  resolvedCandidateIndexCache.clear();
  if (gameId) {
    globalAttemptedCoverLookups.delete(gameId);
    for (const key of Array.from(globalAttemptedCoverLookups)) {
      if (key.startsWith(`${gameId}:`)) {
        globalAttemptedCoverLookups.delete(key);
      }
    }
  } else {
    globalAttemptedCoverLookups.clear();
  }
}

export function getCoverCandidates(
  game: CanonicalGame,
  overrideCoverUrl?: string | null,
  userOverride?: UserGameOverride | null
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (url?: string | null, force: boolean = false) => {
    if (!url) return;
    let trimmed = url.trim();
    if (!trimmed) return;
    if (!force && isUnsuitableCoverUrl(trimmed)) return;
    if (/cdn[12]?\.epicgames\.com\//i.test(trimmed) && !/[?&][hw]=/i.test(trimmed)) {
      trimmed = `${trimmed}${trimmed.includes('?') ? '&' : '?'}h=480&resize=1`;
    }
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const addWith1xPriority = (url?: string | null, force: boolean = false) => {
    if (!url) return;
    if (url.includes('/library_600x900_2x.jpg')) {
      add(url.replace('/library_600x900_2x.jpg', '/library_600x900.jpg'), force);
    }
    add(url, force);
    if (url.includes('/library_capsule_2x.jpg')) {
      add(url.replace('/library_capsule_2x.jpg', '/library_capsule.jpg'), force);
    }
  };

  // 1. Authoritative user manual override ALWAYS takes absolute priority #1
  const effectiveOverride =
    userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  if (effectiveOverride?.capsuleImage) {
    addWith1xPriority(effectiveOverride.capsuleImage, true);
  }
  if (effectiveOverride && game.capsuleImage) {
    addWith1xPriority(game.capsuleImage, true);
  }

  const rawImagesCover = (game as CanonicalGame & GameWithLegacyImages).images?.cover;
  if (rawImagesCover && !isGogCroppedHorizontalCover(rawImagesCover, game.headerImage)) {
    addWith1xPriority(rawImagesCover);
  }

  // 2. Official Steam 600x900 2:3 Library Portrait Cover
  const isExplicitNonSteam =
    effectiveOverride?.steamAppId === null || game.isExplicitNonSteam === true;
  const targetSteamId = !isExplicitNonSteam
    ? steamMatcher.getEffectiveSteamAppId(game)
    : null;

  if (targetSteamId) {
    const browseAssets = steamApi.getStoreBrowseAssetsInstant(targetSteamId);
    if (browseAssets?.capsuleImage) {
      addWith1xPriority(browseAssets.capsuleImage);
    }
    if (
      game.capsuleImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\/library_capsule/i.test(game.capsuleImage)
    ) {
      addWith1xPriority(game.capsuleImage);
    }
    if (
      game.enrichedMetadata?.capsuleImage &&
      /\/apps\/\d+\/[a-f0-9]{40}\/library_capsule/i.test(game.enrichedMetadata.capsuleImage)
    ) {
      addWith1xPriority(game.enrichedMetadata.capsuleImage);
    }
    if (!isKnownDeadSteamCover(targetSteamId)) {
      add(
        `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900.jpg`
      );
      add(`https://cdn.akamai.steamstatic.com/steam/apps/${targetSteamId}/library_600x900.jpg`);
      add(
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900.jpg`
      );
      add(
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900_2x.jpg`
      );
    }
  }

  // 3. Official Steam / Epic / GOG tall vertical posters
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const gogBoxArt = igdbCoverService.getGogVerticalCoverInstant(
      gogPlat.platformGameId,
      game.title
    );
    add(gogBoxArt);
  }

  if (game.capsuleImage && !isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)) {
    const lower = game.capsuleImage.toLowerCase();
    const isGog = lower.includes('gog-statics.com');
    if (
      (!isGog &&
        (lower.includes('library_capsule.jpg') ||
          lower.includes('library_capsule_2x.jpg') ||
          lower.includes('offerimagetall') ||
          lower.includes('dieselstorefronttall') ||
          lower.includes('s-microsoft.com') ||
          lower.includes('xboxlive.com') ||
          lower.includes('t_cover_big') ||
          lower.includes('1200x1600') ||
          lower.includes('portrait'))) ||
      isGog
    ) {
      addWith1xPriority(game.capsuleImage);
    }
  }

  // 4. Verified IGDB portrait box art fallback
  const igdbCover = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
  add(igdbCover);
  if (overrideCoverUrl) {
    add(overrideCoverUrl);
  }

  // 5. Primary capsule image if valid
  if (game.capsuleImage && !isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)) {
    addWith1xPriority(game.capsuleImage);
  }

  // 6. Enriched metadata or cached Steam API capsule fallback
  if (
    game.enrichedMetadata?.capsuleImage &&
    !isGogCroppedHorizontalCover(game.enrichedMetadata.capsuleImage, game.headerImage)
  ) {
    addWith1xPriority(game.enrichedMetadata.capsuleImage);
  }
  if (targetSteamId) {
    const cachedMeta = steamApi.getCachedMetadata(targetSteamId);
    if (cachedMeta?.capsuleImage) {
      addWith1xPriority(cachedMeta.capsuleImage);
    }
  }

  return candidates;
}

type CoverEventCallback = () => void;

const subscribersByGameId = new Map<string, Set<CoverEventCallback>>();
const subscribersByNormTitle = new Map<string, Set<CoverEventCallback>>();
const subscribersByGogId = new Map<string, Set<CoverEventCallback>>();
const subscribersBySteamAppId = new Map<number, Set<CoverEventCallback>>();
const allCoverSubscribers = new Set<CoverEventCallback>();
let isGlobalCoverListenerAttached = false;
let onlineCoverReconnectUnsub: (() => void) | null = null;

function notifySubscriberSet(set?: Set<CoverEventCallback>): void {
  if (!set || set.size === 0) return;
  for (const cb of Array.from(set)) {
    cb();
  }
}

interface CoverCustomEventDetail {
  gameId?: string | number;
  appId?: string | number;
  gogId?: string | number;
  title?: string;
}

function handleGlobalSteamMatchUpdated(e: Event): void {
  const detail = (e as CustomEvent<CoverCustomEventDetail | undefined>)?.detail;
  const gameId = detail?.gameId ? String(detail.gameId) : '';
  const rawAppIdNum = Number(detail?.appId || 0);
  const appId = detail?.appId ? `steam-${detail.appId}` : '';
  const matchedTitle = detail?.title ? normalizeKey(String(detail.title)) : '';

  if (!gameId && !appId && !matchedTitle && !(rawAppIdNum > 0)) {
    notifySubscriberSet(allCoverSubscribers);
    return;
  }
  if (gameId) {
    notifySubscriberSet(subscribersByGameId.get(gameId));
  }
  if (appId) {
    notifySubscriberSet(subscribersByGameId.get(appId));
  }
  if (rawAppIdNum > 0) {
    notifySubscriberSet(subscribersBySteamAppId.get(rawAppIdNum));
  }
  if (matchedTitle) {
    notifySubscriberSet(subscribersByNormTitle.get(matchedTitle));
  }
}

function handleGlobalGogCoverUpdated(e: Event): void {
  const detail = (e as CustomEvent<CoverCustomEventDetail | undefined>)?.detail;
  const gameId = detail?.gameId ? String(detail.gameId) : '';
  const gogId = detail?.gogId ? String(detail.gogId).replace(/^gog-/, '') : '';
  const gogTitle = detail?.title ? normalizeKey(String(detail.title)) : '';

  if (!gameId && !gogId && !gogTitle) {
    notifySubscriberSet(allCoverSubscribers);
    return;
  }
  if (gameId) {
    notifySubscriberSet(subscribersByGameId.get(gameId));
  }
  if (gogId) {
    notifySubscriberSet(subscribersByGogId.get(gogId));
  }
  if (gogTitle) {
    notifySubscriberSet(subscribersByNormTitle.get(gogTitle));
  }
}

export function subscribeToCoverUpdates(
  gameId: string,
  title: string,
  gogPlatformGameId: string | undefined,
  steamAppId: number | null | undefined,
  cb: CoverEventCallback
): () => void {
  if (typeof window === 'undefined') return () => {};

  const normTitle = normalizeKey(title);
  const cleanGogId = gogPlatformGameId ? String(gogPlatformGameId).replace(/^gog-/, '') : '';
  const cleanSteamAppId = Number(steamAppId || 0);

  allCoverSubscribers.add(cb);

  if (gameId) {
    let set = subscribersByGameId.get(gameId);
    if (!set) {
      set = new Set();
      subscribersByGameId.set(gameId, set);
    }
    set.add(cb);
  }

  if (normTitle) {
    let set = subscribersByNormTitle.get(normTitle);
    if (!set) {
      set = new Set();
      subscribersByNormTitle.set(normTitle, set);
    }
    set.add(cb);
  }

  if (cleanGogId) {
    let set = subscribersByGogId.get(cleanGogId);
    if (!set) {
      set = new Set();
      subscribersByGogId.set(cleanGogId, set);
    }
    set.add(cb);
  }

  if (cleanSteamAppId > 0) {
    let set = subscribersBySteamAppId.get(cleanSteamAppId);
    if (!set) {
      set = new Set();
      subscribersBySteamAppId.set(cleanSteamAppId, set);
    }
    set.add(cb);
  }

  if (!isGlobalCoverListenerAttached && allCoverSubscribers.size > 0) {
    window.addEventListener('antigravity:steam-match-updated', handleGlobalSteamMatchUpdated);
    window.addEventListener('antigravity:steam-assets-resolved', handleGlobalSteamMatchUpdated);
    window.addEventListener('antigravity:gog-cover-updated', handleGlobalGogCoverUpdated);
    onlineCoverReconnectUnsub = onlineLifecycleManager.onOnline(() => {
      clearFailedCoverUrls();
      notifySubscriberSet(allCoverSubscribers);
    });
    isGlobalCoverListenerAttached = true;
  }

  return () => {
    allCoverSubscribers.delete(cb);

    if (gameId) {
      const set = subscribersByGameId.get(gameId);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribersByGameId.delete(gameId);
      }
    }

    if (normTitle) {
      const set = subscribersByNormTitle.get(normTitle);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribersByNormTitle.delete(normTitle);
      }
    }

    if (cleanGogId) {
      const set = subscribersByGogId.get(cleanGogId);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribersByGogId.delete(cleanGogId);
      }
    }

    if (cleanSteamAppId > 0) {
      const set = subscribersBySteamAppId.get(cleanSteamAppId);
      if (set) {
        set.delete(cb);
        if (set.size === 0) subscribersBySteamAppId.delete(cleanSteamAppId);
      }
    }

    if (isGlobalCoverListenerAttached && allCoverSubscribers.size === 0) {
      window.removeEventListener('antigravity:steam-match-updated', handleGlobalSteamMatchUpdated);
      window.removeEventListener('antigravity:steam-assets-resolved', handleGlobalSteamMatchUpdated);
      window.removeEventListener('antigravity:gog-cover-updated', handleGlobalGogCoverUpdated);
      if (onlineCoverReconnectUnsub) {
        onlineCoverReconnectUnsub();
        onlineCoverReconnectUnsub = null;
      }
      isGlobalCoverListenerAttached = false;
    }
  };
}

export type GridSortOption =
  | 'alphabetical'
  | 'rating'
  | 'playtime'
  | 'recent'
  | 'release_year';
export const GRID_SORT_STORAGE_KEY = 'one_launcher_grid_sort_by';
export const GRID_RELEASE_YEAR_ORDER_STORAGE_KEY = 'one_launcher_grid_release_year_order';

export function isValidGridSortOption(val: unknown): val is GridSortOption {
  return (
    val === 'alphabetical' ||
    val === 'rating' ||
    val === 'playtime' ||
    val === 'recent' ||
    val === 'release_year'
  );
}

export function loadPersistedGridSort(): GridSortOption {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(GRID_SORT_STORAGE_KEY);
      if (isValidGridSortOption(saved)) {
        return saved;
      }
    }
  } catch {
    // ignore storage errors
  }
  return 'alphabetical';
}

export function loadPersistedReleaseYearOrder(): 'desc' | 'asc' {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(GRID_RELEASE_YEAR_ORDER_STORAGE_KEY);
      if (saved === 'asc' || saved === 'desc') {
        return saved;
      }
    }
  } catch {
    // ignore storage errors
  }
  return 'desc';
}

export function computeResponsiveColumnCount(viewportWidth: number): number {
  if (viewportWidth >= 1536) return 7;
  if (viewportWidth >= 1280) return 6;
  if (viewportWidth >= 1024) return 5;
  if (viewportWidth >= 768) return 4;
  if (viewportWidth >= 640) return 3;
  return 2;
}

export function formatPlaytime(game: CanonicalGame): string | null {
  const mins = game.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins} mins`;
  const hrs = (mins / 60).toFixed(1);
  return `${hrs.endsWith('.0') ? parseInt(hrs, 10) : hrs} hrs`;
}
