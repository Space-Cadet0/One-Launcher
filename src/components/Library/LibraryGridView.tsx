import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { NativeOsBadges } from '../Common/NativeOsBadges';
import { getNativeOsPlatforms } from '../../services/platform/nativeOsService';
import { StorefrontId } from '../../contracts/platform';
import {
  Gamepad2,
  Clock,
  ThumbsUp,
  Layers,
  CheckCircle2,
  Cloud,
  ArrowLeft,
  X,
  Sliders,
  SlidersHorizontal,
  Award,
  Calendar,
  AlertCircle,
  Activity,
} from 'lucide-react';
import { getOpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { getHowLongToBeat } from '../../services/hltb/howLongToBeat';
import { steamMatcher } from '../../services/steam/steamMatcher';
import steamEnrichedCache from '../../services/storage/steamEnrichedCache.json';
import steamBlurbCache from '../../services/storage/steamBlurbCache.json';
import { steamApi } from '../../services/steam/steamApi';
import {
  ActiveGameFilter,
  LibraryFilterState,
  DEFAULT_LIBRARY_FILTER_STATE,
  countActiveFilterCriteria,
} from '../../contracts/filter';
import {
  LibraryFilterIndex,
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
  describeActiveFilterChips,
} from '../../services/filter/libraryFilterIndex';
import { LibraryFilterPanel } from './LibraryFilterPanel';
import { parseTimestampMs } from '../../utils/dateUtils';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
  normalizeKey,
} from '../../services/igdb/igdbCoverService';
import {
  extractFirstParagraph,
  isGenericPlaceholderSynopsis,
  stripHtmlToPlainSynopsis,
  GOG_SPECIAL_DESCRIPTIONS,
} from '../../services/steam/fallbackMetadataProvider';
import gogEnrichedCache from '../../services/storage/gogEnrichedCache.json';
import { GameContextMenu } from './GameContextMenu';
import { GameCollection } from '../../contracts/collection';
import {
  getUserOverrideForGame,
  loadUserOverrides,
} from '../../services/storage/userOverrideStorage';
import { UserGameOverride } from '../../contracts/override';
import { launcherService } from '../../services/launcher/launcherService';

function isPlaceholderSynopsis(desc?: string, title?: string): boolean {
  return isGenericPlaceholderSynopsis(desc, title);
}

function getCleanSynopsis(
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
  const effectiveOverride = userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
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

  // 1. Steam blurb cache (curated store blurbs for 387+ matched catalog titles)
  if (effectiveAppId) {
    const blurb = cleanCandidate((steamBlurbCache as Record<string, string>)[String(effectiveAppId)]);
    if (blurb) {
      return blurb;
    }
  }

  // 2. Steam enriched cache
  if (effectiveAppId) {
    const cached = (steamEnrichedCache as Record<string, any>)[String(effectiveAppId)];
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

  // 4. Curated GOG special descriptions (Blood Omen, Daggerfall Unity, Fallout: London, etc.)
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const special = GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId];
    const specialLead = cleanCandidate(special?.lead);
    if (specialLead) {
      return specialLead;
    }
    const gogCached = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
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

  // 7. First paragraph of game description (truncated with ... if needed)
  const gogCachedData = gogPlat?.platformGameId ? (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId] : null;
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
      .filter((g) => g.length > 0 && !g.toLowerCase().includes('drm-free') && !g.toLowerCase().includes('gog') && !g.toLowerCase().includes('store exclusive'));
    if (cleanGenres.length > 0) {
      const dev = game.developers?.[0] ? ` developed by ${game.developers[0]}` : '';
      return stripHtmlToPlainSynopsis(`${game.title} is a ${cleanGenres.slice(0, 3).join(', ')} title${dev}.`, 280);
    }
  }

  return null;
}

function hasStoreSynopsis(
  game: CanonicalGame,
  targetAppId?: number | null,
  userOverride?: UserGameOverride | null
): boolean {
  const effectiveOverride = userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  if (effectiveOverride?.shortDescription && !isPlaceholderSynopsis(effectiveOverride.shortDescription, game.title)) {
    return true;
  }
  const effectiveAppId = effectiveOverride?.steamAppId === null ? null : targetAppId;
  if (effectiveAppId) {
    const blurb = (steamBlurbCache as Record<string, string>)[String(effectiveAppId)];
    if (blurb && !isPlaceholderSynopsis(blurb, game.title)) return true;
    const cached = (steamEnrichedCache as Record<string, any>)[String(effectiveAppId)];
    if (cached?.shortDescription && !isPlaceholderSynopsis(cached.shortDescription, game.title)) return true;
    const live = steamApi.getCachedMetadata(effectiveAppId);
    if (live?.shortDescription && !isPlaceholderSynopsis(live.shortDescription, game.title)) return true;
  }
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const special = GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId];
    if (special?.lead && !isPlaceholderSynopsis(special.lead, game.title)) return true;
    const gogCached = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
    if (gogCached?.shortDescription && !isPlaceholderSynopsis(gogCached.shortDescription, game.title)) return true;
  }
  if (game.enrichedMetadata?.shortDescription && !isPlaceholderSynopsis(game.enrichedMetadata.shortDescription, game.title)) {
    return true;
  }
  if (game.shortDescription && !isPlaceholderSynopsis(game.shortDescription, game.title)) {
    return true;
  }
  return false;
}

function getReleaseYear(game: CanonicalGame, targetAppId?: number | null): string | null {
  let dateStr = game.releaseDate;
  if ((!dateStr || dateStr === 'TBA') && targetAppId) {
    const cached = (steamEnrichedCache as Record<string, any>)[String(targetAppId)];
    if (cached?.releaseDate) dateStr = cached.releaseDate;
  }
  if (!dateStr || dateStr === 'TBA') return null;
  const match = dateStr.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : null;
}

const HOVER_DELAY_MS = 400;

const globalAttemptedCoverLookups = new Set<string>();

export function clearAttemptedCoverLookups(): void {
  globalAttemptedCoverLookups.clear();
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
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) return;
    if (!force && isUnsuitableCoverUrl(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const addWith1xPriority = (url?: string | null, force: boolean = false) => {
    if (!url) return;
    if (!force && url.includes('/library_600x900_2x.jpg')) {
      add(url.replace('/library_600x900_2x.jpg', '/library_600x900.jpg'), false);
    }
    add(url, force);
  };

  // 1. Authoritative user manual override ALWAYS takes absolute priority #1
  const effectiveOverride = userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  if (effectiveOverride?.capsuleImage) {
    add(effectiveOverride.capsuleImage, true);
  }
  if (effectiveOverride && game.capsuleImage) {
    add(game.capsuleImage, true);
  }

  const rawImagesCover = (game as any).images?.cover as string | undefined;
  if (rawImagesCover && !isGogCroppedHorizontalCover(rawImagesCover, game.headerImage)) {
    addWith1xPriority(rawImagesCover);
  }

  // 2. Official Steam 600x900 2:3 Library Portrait Cover (preferred whenever a game has a confirmed Steam match)
  // If user explicitly unlinked from Steam (effectiveOverride?.steamAppId === null), do NOT match to Steam!
  const isExplicitNonSteam = effectiveOverride?.steamAppId === null || game.isExplicitNonSteam === true;
  const targetSteamId = !isExplicitNonSteam
    ? steamMatcher.getEffectiveSteamAppId(game)
    : null;

  if (targetSteamId && !isKnownDeadSteamCover(targetSteamId)) {
    add(`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900.jpg`);
    add(`https://cdn.akamai.steamstatic.com/steam/apps/${targetSteamId}/library_600x900.jpg`);
    add(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900.jpg`);
    add(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900_2x.jpg`);
  }

  // 3. Official Steam / Epic / GOG tall vertical posters
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const gogBoxArt = igdbCoverService.getGogVerticalCoverInstant(gogPlat.platformGameId, game.title);
    add(gogBoxArt);
  }

  if (game.capsuleImage && !isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)) {
    const lower = game.capsuleImage.toLowerCase();
    const isGog = lower.includes('gog-statics.com');
    if (
      (!isGog &&
        (lower.includes('library_capsule.jpg') ||
          lower.includes('offerimagetall') ||
          lower.includes('dieselstorefronttall') ||
          lower.includes('t_cover_big') ||
          lower.includes('1200x1600') ||
          lower.includes('portrait'))) ||
      isGog
    ) {
      addWith1xPriority(game.capsuleImage);
    }
  }

  // 4. Verified IGDB portrait box art fallback (for non-Steam games or legacy Steam titles whose 600x900 cover 404s)
  const igdbCover = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
  add(igdbCover);
  if (overrideCoverUrl) {
    add(overrideCoverUrl);
  }

  // 5. Primary capsule image if valid and not a server-cropped horizontal GOG banner
  if (game.capsuleImage && !isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)) {
    addWith1xPriority(game.capsuleImage);
  }

  // 6. Enriched metadata or cached Steam API capsule fallback (e.g. hashed CDN paths)
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

// ========================================================
// SHARED O(1) COVER EVENT DISPATCH REGISTRY
// ========================================================
type CoverEventCallback = () => void;

const subscribersByGameId = new Map<string, Set<CoverEventCallback>>();
const subscribersByNormTitle = new Map<string, Set<CoverEventCallback>>();
const subscribersByGogId = new Map<string, Set<CoverEventCallback>>();
const allCoverSubscribers = new Set<CoverEventCallback>();
let isGlobalCoverListenerAttached = false;

function notifySubscriberSet(set?: Set<CoverEventCallback>): void {
  if (!set || set.size === 0) return;
  for (const cb of Array.from(set)) {
    cb();
  }
}

function handleGlobalSteamMatchUpdated(e: Event): void {
  const detail = (e as CustomEvent)?.detail;
  const gameId = detail?.gameId ? String(detail.gameId) : '';
  const matchedTitle = detail?.title ? normalizeKey(String(detail.title)) : '';

  if (!gameId && !matchedTitle) {
    notifySubscriberSet(allCoverSubscribers);
    return;
  }
  if (gameId) {
    notifySubscriberSet(subscribersByGameId.get(gameId));
  }
  if (matchedTitle) {
    notifySubscriberSet(subscribersByNormTitle.get(matchedTitle));
  }
}

function handleGlobalGogCoverUpdated(e: Event): void {
  const detail = (e as CustomEvent)?.detail;
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

function subscribeToCoverUpdates(
  gameId: string,
  title: string,
  gogPlatformGameId: string | undefined,
  cb: CoverEventCallback
): () => void {
  if (typeof window === 'undefined') return () => {};

  const normTitle = normalizeKey(title);
  const cleanGogId = gogPlatformGameId ? String(gogPlatformGameId).replace(/^gog-/, '') : '';

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

  if (!isGlobalCoverListenerAttached && allCoverSubscribers.size > 0) {
    window.addEventListener('antigravity:steam-match-updated', handleGlobalSteamMatchUpdated);
    window.addEventListener('antigravity:gog-cover-updated', handleGlobalGogCoverUpdated);
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

    if (isGlobalCoverListenerAttached && allCoverSubscribers.size === 0) {
      window.removeEventListener('antigravity:steam-match-updated', handleGlobalSteamMatchUpdated);
      window.removeEventListener('antigravity:gog-cover-updated', handleGlobalGogCoverUpdated);
      isGlobalCoverListenerAttached = false;
    }
  };
}

interface GameCardCoverProps {
  game: CanonicalGame;
  overrideCoverUrl?: string | null;
  userOverride?: UserGameOverride | null;
  onNeedCoverLookup?: (game: CanonicalGame) => void;
}

export const GameCardCover: React.FC<GameCardCoverProps> = React.memo(
  ({ game, overrideCoverUrl, userOverride, onNeedCoverLookup }) => {
    const [steamMatchVersion, setSteamMatchVersion] = useState(0);
    const gogPlatformGameId = game.platforms?.find((p) => p.platformId === 'gog')?.platformGameId;

    useEffect(() => {
      return subscribeToCoverUpdates(game.id, game.title, gogPlatformGameId, () => {
        setSteamMatchVersion((v) => v + 1);
      });
    }, [game.id, game.title, gogPlatformGameId]);

    const candidates = useMemo(() => {
      return getCoverCandidates(game, overrideCoverUrl || undefined, userOverride);
    }, [game, overrideCoverUrl, userOverride, steamMatchVersion]);

    const [candidateIndex, setCandidateIndex] = useState(0);
    const [headerFallbackFailed, setHeaderFallbackFailed] = useState(false);
    const topCandidate = candidates[0] || '';

    // Reset candidate progression when game, explicit override, or top priority candidate upgrades
    useEffect(() => {
      setCandidateIndex(0);
    }, [
      game.id,
      game.steamAppId,
      game.capsuleImage,
      overrideCoverUrl,
      userOverride?.capsuleImage,
      topCandidate,
    ]);

    useEffect(() => {
      setHeaderFallbackFailed(false);
    }, [game.id, game.headerImage]);

    const currentSrc = candidateIndex < candidates.length ? candidates[candidateIndex] : null;
    const effectiveOverride = userOverride !== undefined ? userOverride : getUserOverrideForGame(game);

    // Only invoke IGDB fallback lookup when all primary vertical cover candidates have failed
    useEffect(() => {
      if (!currentSrc && onNeedCoverLookup) {
        onNeedCoverLookup(game);
      }
    }, [currentSrc, game, onNeedCoverLookup]);

    // Proactively resolve confirmed Steam matches and official GOG v2 boxArtImage covers for non-Steam games
    useEffect(() => {
      if (effectiveOverride?.capsuleImage) return;
      const isExplicitNonSteam =
        effectiveOverride?.steamAppId === null || game.isExplicitNonSteam === true;
      const hasResolvedSteamId = !isExplicitNonSteam && Boolean(steamMatcher.getEffectiveSteamAppId(game));

      if (!hasResolvedSteamId && !isExplicitNonSteam && !steamMatcher.hasAttemptedMatch(game.title)) {
        steamMatcher
          .matchGameToSteam(game.title, {
            releaseYear: game.releaseDate,
            developers: game.developers,
          })
          .catch(() => null);
      }

      const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
      if (gogPlat?.platformGameId) {
        if (
          !igdbCoverService.hasAttemptedGogVerticalCover(gogPlat.platformGameId, game.title) &&
          (!hasResolvedSteamId || isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage))
        ) {
          igdbCoverService
            .fetchGogVerticalCover(gogPlat.platformGameId, game.title)
            .catch(() => null);
        }
      }
    }, [
      game.id,
      game.title,
      game.releaseDate,
      game.developers,
      game.isExplicitNonSteam,
      game.capsuleImage,
      game.headerImage,
      game.platforms,
      effectiveOverride,
    ]);
    const matchReviewBadge =
      game.needsMatchReview === true && !effectiveOverride ? (
        <div
          className="absolute bottom-9 left-2 z-20 flex items-center gap-1 bg-amber-950/90 border border-amber-500/60 text-amber-300 text-[9px] font-semibold px-1.5 py-0.5 rounded shadow backdrop-blur-sm"
          title="Low-confidence automatic match — click Fix Match to verify"
        >
          <AlertCircle className="w-2.5 h-2.5 text-amber-400 shrink-0" />
          <span>Verify</span>
        </div>
      ) : null;

    if (!currentSrc) {
      if (
        game.headerImage &&
        !headerFallbackFailed &&
        !game.headerImage.includes('default.png') &&
        !game.headerImage.includes('egs-badge.png')
      ) {
        return (
          <div className="grid-cover-fallback relative w-full h-full flex flex-col items-center justify-center text-center bg-gradient-to-b from-[#1b2838] to-[#0f161f] overflow-hidden select-none">
            <img
              src={game.headerImage}
              alt=""
              aria-hidden="true"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover scale-125 blur-md opacity-40 brightness-75 pointer-events-none"
              onError={() => setHeaderFallbackFailed(true)}
            />
            <img
              src={game.headerImage}
              alt={game.title}
              loading="lazy"
              decoding="async"
              className="relative z-10 w-full aspect-[460/215] object-cover shadow-lg border-y border-white/10"
              onError={() => setHeaderFallbackFailed(true)}
            />
            <span className="relative z-10 mt-2 text-[11px] font-semibold text-slate-200 line-clamp-2 leading-tight px-2 drop-shadow">
              {game.title}
            </span>
            {matchReviewBadge}
          </div>
        );
      }

      return (
        <div className="grid-cover-fallback relative w-full h-full flex flex-col items-center justify-center p-4 text-center bg-gradient-to-b from-[#1b2838] to-[#0f161f] select-none">
          <Gamepad2 className="w-10 h-10 text-slate-500 mb-2 opacity-60 group-hover:scale-110 group-hover:text-steam-accent transition-all" />
          <span className="text-xs font-semibold text-slate-300 line-clamp-3 leading-tight px-1">
            {game.title}
          </span>
          {matchReviewBadge}
        </div>
      );
    }

    const isUserExplicitCover = Boolean(
      (userOverride?.capsuleImage && currentSrc === userOverride.capsuleImage) ||
      (overrideCoverUrl && currentSrc === overrideCoverUrl)
    );

    return (
      <>
        <img
          key={currentSrc}
          src={currentSrc}
          alt={game.title}
          loading="lazy"
          decoding="async"
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth && naturalHeight && !isUserExplicitCover) {
              const ratio = naturalWidth / naturalHeight;
              // Reject square (1.0) and landscape (> 1.0) images in portrait gridview
              // ratio > 0.94 cleanly rejects 1:1 square icons and wide banners
              // while preserving legitimate portrait covers like Epic's 1280x1440 (0.888)
              if (ratio > 0.94) {
                setCandidateIndex((prev) => prev + 1);
              }
            }
          }}
          onError={() => {
            if (currentSrc) {
              const m = currentSrc.match(/\/apps\/(\d+)\/library_600x900(?:_2x)?\.jpg/i);
              const nextCandidate = candidates[candidateIndex + 1] || '';
              if (m && !nextCandidate.includes(`/apps/${m[1]}/library_600x900`)) {
                igdbCoverService.recordDeadSteamCover(Number(m[1]));
              }
            }
            // Declaratively advance to the next candidate without mutating the DOM
            setCandidateIndex((prev) => prev + 1);
          }}
          className="w-full h-full object-cover group-hover:brightness-105 transition-all duration-300"
        />
        {matchReviewBadge}
      </>
    );
  }
);


export type GridSortOption = 'alphabetical' | 'rating' | 'playtime' | 'recent' | 'release_year';
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

interface LibraryGridViewProps {
  games: CanonicalGame[];
  onSelectGame: (game: CanonicalGame) => void;
  searchQuery?: string;
  title?: string;
  subtitle?: string;
  groupIcon?: React.ReactNode;
  onClearGroupFilter?: () => void;
  activeFilter?: ActiveGameFilter | null;
  onClearActiveFilter?: () => void;
  connectedStorefronts?: StorefrontId[];
  onFixMatch?: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame) => void;
  onSyncGameMedia?: (game: CanonicalGame) => void;
  collections?: GameCollection[];
  onToggleGameInCollection?: (collectionId: string, gameId: string) => void;
  onOpenManageCollectionsModal?: (game?: CanonicalGame) => void;
  onViewAchievements?: (game: CanonicalGame) => void;
  sortBy?: GridSortOption;
  onSortChange?: (sort: GridSortOption) => void;
  libraryFilterState?: LibraryFilterState;
  onUpdateLibraryFilterState?: (next: LibraryFilterState) => void;
  onResetLibraryFilterState?: () => void;
  libraryFilterIndex?: LibraryFilterIndex;
  unfilteredTotalCount?: number;
}

export const LibraryGridView: React.FC<LibraryGridViewProps> = ({
  games,
  onSelectGame,
  searchQuery,
  title,
  subtitle,
  groupIcon,
  onClearGroupFilter,
  activeFilter,
  onClearActiveFilter,
  connectedStorefronts,
  onFixMatch,
  onHideGame,
  onSyncGameMedia,
  collections,
  onToggleGameInCollection,
  onOpenManageCollectionsModal,
  onViewAchievements,
  sortBy: sortByProp,
  onSortChange,
  libraryFilterState,
  onUpdateLibraryFilterState,
  onResetLibraryFilterState,
  libraryFilterIndex,
  unfilteredTotalCount,
}) => {
  const gridContainerRef = useRef<HTMLDivElement | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    x: number;
    y: number;
    game: CanonicalGame | null;
  }>({
    isOpen: false,
    x: 0,
    y: 0,
    game: null,
  });

  const [, setCriticUpdateTick] = useState(0);
  useEffect(() => {
    const handleUpdate = () => {
      setCriticUpdateTick((t) => t + 1);
    };
    const getLauncherGridSignature = () => {
      const running = launcherService
        .getRunningGames()
        .map((r) => `${r.gameId}:${r.platformId || ''}`)
        .sort()
        .join(',');
      const installed = launcherService
        .getInstalledRecords()
        .map((i) => `${i.platformId}:${i.platformGameId || i.appId || ''}:${i.executablePath || ''}`)
        .sort()
        .join(',');
      return `${running}|${installed}`;
    };
    let prevSig = getLauncherGridSignature();
    window.addEventListener('antigravity_critic_updated', handleUpdate);
    const unsubLauncher = launcherService.subscribe(() => {
      const nextSig = getLauncherGridSignature();
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        setCriticUpdateTick((t) => t + 1);
      }
    });
    return () => {
      window.removeEventListener('antigravity_critic_updated', handleUpdate);
      unsubLauncher();
    };
  }, []);

  const handleContextMenu = (game: CanonicalGame, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHoveredGame(null);
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      game,
    });
  };

  const connectedSet = useMemo(() => {
    if (connectedStorefronts !== undefined) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      return new Set<StorefrontId>(connected);
    } catch {
      // Fallback
    }
    return new Set<StorefrontId>(['steam', 'gog', 'epic']);
  }, [connectedStorefronts]);
  const [hoveredGame, setHoveredGame] = useState<CanonicalGame | null>(null);
  const [previewPos, setPreviewPos] = useState<{ x: number; y: number; align: 'left' | 'right' }>({
    x: 0,
    y: 0,
    align: 'left',
  });
  const [internalSortBy, setInternalSortBy] = useState<GridSortOption>(() =>
    sortByProp && isValidGridSortOption(sortByProp) ? sortByProp : loadPersistedGridSort()
  );

  useEffect(() => {
    if (sortByProp && isValidGridSortOption(sortByProp)) {
      setInternalSortBy(sortByProp);
    }
  }, [sortByProp]);

  const sortBy = sortByProp && isValidGridSortOption(sortByProp) ? sortByProp : internalSortBy;
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const popoutRef = useRef<HTMLDivElement | null>(null);
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  const gamesRef = useRef(games);
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
  const scrollEndTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [dynamicBlurb, setDynamicBlurb] = useState<{ id: string; blurb: string } | null>(null);
  const [coverOverrides, setCoverOverrides] = useState<Record<string, string | null>>({});

  // Listen for user override additions / modifications to reactively update the grid
  const [overrideVersion, setOverrideVersion] = useState(0);
  useEffect(() => {
    const handleOverrideUpdate = () => {
      globalAttemptedCoverLookups.clear();
      setOverrideVersion((v) => v + 1);
    };
    window.addEventListener('antigravity:user-override-updated', handleOverrideUpdate);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleOverrideUpdate);
    };
  }, []);

  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [internalFilterState, setInternalFilterState] = useState<LibraryFilterState>(
    DEFAULT_LIBRARY_FILTER_STATE
  );
  const [releaseYearOrder, setReleaseYearOrder] = useState<'desc' | 'asc'>(() =>
    loadPersistedReleaseYearOrder()
  );
  const effectiveFilterState = libraryFilterState ?? internalFilterState;
  const fallbackFilterIndex = useMemo(
    () => (libraryFilterIndex ? null : buildLibraryFilterIndex(games)),
    [libraryFilterIndex, games]
  );
  const effectiveFilterIndex = libraryFilterIndex ?? fallbackFilterIndex!;

  const handleUpdateFilterState = useCallback(
    (next: LibraryFilterState) => {
      setInternalFilterState(next);
      onUpdateLibraryFilterState?.(next);
    },
    [onUpdateLibraryFilterState]
  );

  const handleResetFilterState = useCallback(() => {
    setInternalFilterState(DEFAULT_LIBRARY_FILTER_STATE);
    onResetLibraryFilterState?.();
    onClearActiveFilter?.();
  }, [onResetLibraryFilterState, onClearActiveFilter]);

  const activeCriteriaCount = useMemo(
    () =>
      countActiveFilterCriteria(effectiveFilterState, {
        minYear: effectiveFilterIndex.minReleaseYear,
        maxYear: effectiveFilterIndex.maxReleaseYear,
      }),
    [effectiveFilterState, effectiveFilterIndex]
  );

  const activeFilterChips = useMemo(
    () => describeActiveFilterChips(effectiveFilterState, effectiveFilterIndex),
    [effectiveFilterState, effectiveFilterIndex]
  );

  const userOverridesMap = useMemo(() => loadUserOverrides(), [games, overrideVersion]);

  const handleNeedCoverLookup = useCallback((game: CanonicalGame) => {
    if (globalAttemptedCoverLookups.has(game.id)) return;
    globalAttemptedCoverLookups.add(game.id);

    const targetAppId = steamMatcher.getEffectiveSteamAppId(game);
    const releaseYear = getReleaseYear(game, targetAppId);
    const isExplicitNonSteam = game.isExplicitNonSteam === true;

    if (!targetAppId && !isExplicitNonSteam && !steamMatcher.hasAttemptedMatch(game.title)) {
      steamMatcher
        .matchGameToSteam(game.title, {
          releaseYear: game.releaseDate,
          developers: game.developers,
        })
        .catch(() => null);
    }

    if (igdbCoverService.hasAttemptedIgdbCover(game.title, releaseYear)) {
      const instant = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
      if (instant) {
        setCoverOverrides((prev) => ({ ...prev, [game.id]: instant }));
      }
      return;
    }

    igdbCoverService
      .fetchIgdbCover(game.title, releaseYear, undefined, { trackInGlobalBar: false })
      .then((resolvedCover) => {
        if (resolvedCover) {
          setCoverOverrides((prev) => ({ ...prev, [game.id]: resolvedCover }));
        }
      });
  }, []);

  useEffect(() => {
    const handleCoverUpdate = (e: any) => {
      const { title, coverUrl } = e.detail || {};
      if (title && coverUrl) {
        setCoverOverrides((prev) => {
          const next = { ...prev };
          const normTitle = normalizeKey(title);
          for (const g of gamesRef.current) {
            if (normalizeKey(g.title) === normTitle) {
              next[g.id] = coverUrl;
            }
          }
          return next;
        });
      }
    };
    window.addEventListener('antigravity:igdb-cover-updated', handleCoverUpdate);
    return () => {
      window.removeEventListener('antigravity:igdb-cover-updated', handleCoverUpdate);
    };
  }, []);

  useEffect(() => {
    gamesRef.current = games;
  }, [games]);

  const startHoverForCard = useCallback((game: CanonicalGame, cardEl: HTMLDivElement) => {
    // If already targeting this exact card and a timer is running or it is already hovered, don't restart timer
    if (activeCardRef.current === cardEl && (hoverTimeoutRef.current || hoveredGame?.id === game.id)) {
      return;
    }

    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);

    // If another card's popout is open, close it immediately!
    if (hoveredGame && hoveredGame.id !== game.id) {
      setHoveredGame(null);
    }

    activeCardRef.current = cardEl;

    hoverTimeoutRef.current = setTimeout(() => {
      const currentRect = cardEl.getBoundingClientRect();
      const isRight = currentRect.right + 340 > window.innerWidth;
      setPreviewPos({
        x: isRight ? Math.max(12, currentRect.left - 330) : currentRect.right + 12,
        y: Math.max(80, Math.min(currentRect.top - 20, window.innerHeight - 440)),
        align: isRight ? 'right' : 'left',
      });
      setHoveredGame(game);
      hoverTimeoutRef.current = null;
    }, HOVER_DELAY_MS);
  }, [hoveredGame]);

  const startHoverForCardRef = useRef(startHoverForCard);
  useEffect(() => {
    startHoverForCardRef.current = startHoverForCard;
  }, [startHoverForCard]);

  // Fast auto-dismiss on scroll, wheel, window blur, resize, or pointer outside bounds
  useEffect(() => {
    const handleDismiss = () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      setHoveredGame(null);
      activeCardRef.current = null;
    };

    const handleScrollOrWheel = () => {
      // Dismiss any open popout immediately while scrolling
      handleDismiss();

      if (scrollEndTimeoutRef.current) {
        clearTimeout(scrollEndTimeoutRef.current);
      }

      // 150ms after scroll/wheel events cease, check if cursor is resting over a card
      scrollEndTimeoutRef.current = setTimeout(() => {
        if (!lastMousePosRef.current) return;
        const { x, y } = lastMousePosRef.current;
        const el = document.elementFromPoint(x, y);
        const cardEl = el?.closest<HTMLDivElement>('[data-game-id]');
        if (cardEl) {
          const gameId = cardEl.getAttribute('data-game-id');
          const game = gamesRef.current.find((g) => g.id === gameId);
          if (game) {
            startHoverForCardRef.current(game, cardEl);
          }
        }
      }, 150);
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      // If no card or popout is actively tracked, check if mouse is over a card
      if (!activeCardRef.current && !popoutRef.current) {
        const target = e.target as HTMLElement | null;
        const cardEl = target?.closest<HTMLDivElement>('[data-game-id]');
        if (cardEl) {
          const gameId = cardEl.getAttribute('data-game-id');
          const game = gamesRef.current.find((g) => g.id === gameId);
          if (game) {
            startHoverForCardRef.current(game, cardEl);
          }
        }
        return;
      }

      const x = e.clientX;
      const y = e.clientY;

      let inCard = false;
      let inPopout = false;
      let inBridge = false;

      let cardRect: DOMRect | null = null;
      let popoutRect: DOMRect | null = null;

      if (activeCardRef.current) {
        cardRect = activeCardRef.current.getBoundingClientRect();
        // Strict bounding box for the active card
        if (x >= cardRect.left && x <= cardRect.right && y >= cardRect.top && y <= cardRect.bottom) {
          inCard = true;
        }
      }

      if (popoutRef.current) {
        popoutRect = popoutRef.current.getBoundingClientRect();
        // Strict bounding box for the popout
        if (x >= popoutRect.left && x <= popoutRect.right && y >= popoutRect.top && y <= popoutRect.bottom) {
          inPopout = true;
        }
      }

      // Check narrow bridge corridor between active card and popout to allow seamless cursor movement
      if (cardRect && popoutRect) {
        const top = Math.min(cardRect.top, popoutRect.top);
        const bottom = Math.max(cardRect.bottom, popoutRect.bottom);
        if (y >= top && y <= bottom) {
          if (cardRect.right <= popoutRect.left && x >= cardRect.right && x <= popoutRect.left) {
            inBridge = true;
          } else if (popoutRect.right <= cardRect.left && x >= popoutRect.right && x <= cardRect.left) {
            inBridge = true;
          }
        }
      }

      if (!inCard && !inPopout && !inBridge) {
        handleDismiss();

        // Check if cursor moved directly into another card
        const target = e.target as HTMLElement | null;
        const nextCardEl = target?.closest<HTMLDivElement>('[data-game-id]');
        if (nextCardEl && nextCardEl !== activeCardRef.current) {
          const gameId = nextCardEl.getAttribute('data-game-id');
          const game = gamesRef.current.find((g) => g.id === gameId);
          if (game) {
            startHoverForCardRef.current(game, nextCardEl);
          }
        }
      }
    };

    window.addEventListener('scroll', handleScrollOrWheel, true);
    window.addEventListener('wheel', handleScrollOrWheel, { passive: true });
    window.addEventListener('resize', handleDismiss, { passive: true });
    window.addEventListener('blur', handleDismiss);
    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    return () => {
      if (scrollEndTimeoutRef.current) clearTimeout(scrollEndTimeoutRef.current);
      window.removeEventListener('scroll', handleScrollOrWheel, true);
      window.removeEventListener('wheel', handleScrollOrWheel, true);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('blur', handleDismiss);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  // Live dynamic blurb fetching for newly synced games without a cached description
  useEffect(() => {
    if (!hoveredGame) return;
    const targetAppId = steamMatcher.getEffectiveSteamAppId(hoveredGame);
    if (!targetAppId) return;

    if (!hasStoreSynopsis(hoveredGame, targetAppId)) {
      let active = true;
      steamApi.fetchGameMetadata(targetAppId).then((meta) => {
        const plainBlurb = stripHtmlToPlainSynopsis(meta?.shortDescription, 280);
        if (active && plainBlurb && !isPlaceholderSynopsis(plainBlurb, hoveredGame.title)) {
          setDynamicBlurb({ id: hoveredGame.id, blurb: plainBlurb });
        }
      });
      return () => {
        active = false;
      };
    }
  }, [hoveredGame?.id]);

  const handleSortChange = (newSort: GridSortOption) => {
    setInternalSortBy(newSort);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(GRID_SORT_STORAGE_KEY, newSort);
      }
    } catch {
      // ignore storage errors
    }
    onSortChange?.(newSort);
    if (gridContainerRef.current?.parentElement) {
      gridContainerRef.current.parentElement.scrollTop = 0;
    }
  };

  // Sorting & deterministic deduplication (+ multi-category filter evaluation)
  const sortedGames = useMemo(() => {
    const seenIds = new Set<string>();
    const uniqueGames: CanonicalGame[] = [];
    for (const g of games) {
      if (!g || !g.id || seenIds.has(g.id)) continue;
      seenIds.add(g.id);
      uniqueGames.push(g);
    }
    const filteredUniqueGames = evaluateLibraryFilter(
      uniqueGames,
      effectiveFilterIndex,
      effectiveFilterState
    );
    return filteredUniqueGames.sort((a, b) => {
      if (sortBy === 'rating') {
        const targetSteamIdA = steamMatcher.getEffectiveSteamAppId(a);
        const targetSteamIdB = steamMatcher.getEffectiveSteamAppId(b);
        const ocA = getOpenCriticData(targetSteamIdA || undefined, a.title, a.reviewSummary?.positivePercent, undefined, undefined, false, true);
        const ocB = getOpenCriticData(targetSteamIdB || undefined, b.title, b.reviewSummary?.positivePercent, undefined, undefined, false, true);
        const scoreA = ocA?.score ?? -1;
        const scoreB = ocB?.score ?? -1;
        if (scoreB !== scoreA) {
          return scoreB - scoreA; // Highest verified critic score first
        }
        const recA = ocA?.percentRecommended ?? -1;
        const recB = ocB?.percentRecommended ?? -1;
        if (recB !== recA) {
          return recB - recA;
        }
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      }
      if (sortBy === 'playtime') {
        const ptA = a.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
        const ptB = b.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
        return ptB - ptA;
      }
      if (sortBy === 'recent') {
        const getRecentMs = (g: CanonicalGame) => {
          let maxMs = 0;
          for (const p of g.platforms) {
            const ms = parseTimestampMs(p.lastPlayed);
            if (ms && ms > maxMs) maxMs = ms;
          }
          return maxMs;
        };
        return getRecentMs(b) - getRecentMs(a);
      }
      if (sortBy === 'release_year') {
        const yearA =
          effectiveFilterIndex.entriesById.get(a.id)?.releaseYear ??
          (Number(getReleaseYear(a, steamMatcher.getEffectiveSteamAppId(a))) || null);
        const yearB =
          effectiveFilterIndex.entriesById.get(b.id)?.releaseYear ??
          (Number(getReleaseYear(b, steamMatcher.getEffectiveSteamAppId(b))) || null);
        if (yearA === null && yearB !== null) return 1;
        if (yearA !== null && yearB === null) return -1;
        if (yearA !== null && yearB !== null && yearA !== yearB) {
          return releaseYearOrder === 'asc' ? yearA - yearB : yearB - yearA;
        }
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      }
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
  }, [games, sortBy, releaseYearOrder, overrideVersion, effectiveFilterIndex, effectiveFilterState]);

  const handleMouseEnter = (game: CanonicalGame, e: React.MouseEvent<HTMLDivElement>) => {
    startHoverForCard(game, e.currentTarget);
  };

  const handleCardMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);

    const nextEl = e.relatedTarget as Node | null;
    if (popoutRef.current && nextEl && popoutRef.current.contains(nextEl)) {
      return;
    }

    // Immediately close popout when pointer leaves the coverart
    setHoveredGame(null);
    activeCardRef.current = null;
  };

  const handlePopoutMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);

    const nextEl = e.relatedTarget as Node | null;
    if (activeCardRef.current && nextEl && activeCardRef.current.contains(nextEl)) {
      return;
    }

    // Immediately close popout when pointer leaves the popout
    setHoveredGame(null);
    activeCardRef.current = null;
  };

  const formatPlaytime = (game: CanonicalGame) => {
    const mins = game.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
    if (mins <= 0) return null;
    if (mins < 60) return `${mins} mins`;
    const hrs = (mins / 60).toFixed(1);
    return `${hrs.endsWith('.0') ? parseInt(hrs, 10) : hrs} hrs`;
  };

  return (
    <div ref={gridContainerRef} className="w-full min-h-full bg-[#0e141b] text-steam-text pb-28 relative select-none">
      {/* Background ambient lighting */}
      <div className="absolute top-0 left-0 right-0 h-96 opacity-10 pointer-events-none bg-gradient-to-b from-steam-accent/40 via-transparent to-transparent filter blur-3xl" />

      <div className="max-w-[1600px] mx-auto px-6 pt-6 space-y-6 relative">
        {/* Header Bar */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border-b border-steam-border/60 pb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 rounded bg-steam-accent/15 border border-steam-accent/30 text-steam-accent shadow-sm flex items-center justify-center shrink-0">
              {groupIcon || <Gamepad2 className="w-6 h-6" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl font-bold text-white tracking-wide flex items-center gap-2">
                  {title || 'All Games'}
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[#1b2838] border border-steam-border text-steam-accent font-semibold shrink-0">
                    {sortedGames.length}
                  </span>
                </h1>
                {activeFilter && activeFilterChips.length === 0 && (
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-steam-accent/20 border border-steam-accent/40 text-steam-accent text-xs shrink-0">
                    <Sliders className="w-3 h-3" />
                    <span>
                      Filter: <strong className="text-white">{activeFilter.label}</strong>: {activeFilter.value}
                    </span>
                    {onClearActiveFilter && (
                      <button
                        onClick={onClearActiveFilter}
                        className="p-0.5 rounded-full hover:bg-white/10 text-steam-accent hover:text-white transition-colors cursor-pointer"
                        title="Clear filter"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}
                {onClearGroupFilter && !activeFilter && activeCriteriaCount === 0 && (
                  <button
                    onClick={onClearGroupFilter}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-semibold text-steam-accent hover:text-white bg-[#16202d] hover:bg-[#202f42] border border-steam-border rounded transition-colors group cursor-pointer shrink-0"
                    title="Return to All Games library grid"
                  >
                    <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
                    <span>All Games</span>
                  </button>
                )}
              </div>
              <p className="text-xs text-steam-subtext mt-0.5">
                {subtitle || 'Browse your universal game collection across all connected storefronts'}
              </p>
            </div>
          </div>

          {/* Filter & Sort Controls */}
          <div className="flex flex-wrap items-center gap-2.5 text-xs shrink-0 self-end lg:self-center">
            <button
              type="button"
              data-testid="library-filter-toggle-btn"
              onClick={() => setIsFilterPanelOpen((prev) => !prev)}
              aria-expanded={isFilterPanelOpen}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-semibold transition-all cursor-pointer shrink-0 ${
                isFilterPanelOpen || activeCriteriaCount > 0
                  ? 'bg-steam-accent/20 border-steam-accent text-white shadow-sm'
                  : 'bg-[#16202d] border-steam-border text-steam-text hover:text-white hover:border-steam-accent/60'
              }`}
              title="Open 6-category library filter panel"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-steam-accent" />
              <span>Filter</span>
              {activeCriteriaCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-steam-accent text-black text-[10px] font-bold">
                  {activeCriteriaCount}
                </span>
              )}
            </button>

            <span className="text-steam-subtext font-medium whitespace-nowrap">Sort by:</span>
            <div className="flex items-center rounded border border-steam-border bg-[#16202d] p-0.5 shrink-0">
              <button
                onClick={() => handleSortChange('alphabetical')}
                className={`px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors ${
                  sortBy === 'alphabetical'
                    ? 'bg-steam-accent text-black shadow-sm'
                    : 'text-steam-text hover:text-white'
                }`}
              >
                Alphabetical
              </button>
              <button
                onClick={() => handleSortChange('rating')}
                className={`px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-1.5 ${
                  sortBy === 'rating'
                    ? 'bg-steam-accent text-black shadow-sm'
                    : 'text-steam-text hover:text-white'
                }`}
                title="Sort by Review Score (highest score first)"
              >
                <Award className="w-3.5 h-3.5" />
                <span>Rating</span>
              </button>
              <button
                onClick={() => handleSortChange('playtime')}
                className={`px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors ${
                  sortBy === 'playtime'
                    ? 'bg-steam-accent text-black shadow-sm'
                    : 'text-steam-text hover:text-white'
                }`}
              >
                Play Time
              </button>
              <button
                onClick={() => handleSortChange('recent')}
                className={`px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors ${
                  sortBy === 'recent'
                    ? 'bg-steam-accent text-black shadow-sm'
                    : 'text-steam-text hover:text-white'
                }`}
              >
                Recently Played
              </button>
              <button
                type="button"
                data-testid="grid-sort-release-year"
                onClick={() => {
                  if (sortBy !== 'release_year') {
                    handleSortChange('release_year');
                  } else {
                    const nextOrder = releaseYearOrder === 'desc' ? 'asc' : 'desc';
                    setReleaseYearOrder(nextOrder);
                    try {
                      if (typeof window !== 'undefined' && window.localStorage) {
                        window.localStorage.setItem(GRID_RELEASE_YEAR_ORDER_STORAGE_KEY, nextOrder);
                      }
                    } catch {
                      // ignore storage errors
                    }
                  }
                }}
                className={`px-3 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-1.5 cursor-pointer ${
                  sortBy === 'release_year'
                    ? 'bg-steam-accent text-black shadow-sm'
                    : 'text-steam-text hover:text-white'
                }`}
                title={
                  sortBy === 'release_year'
                    ? releaseYearOrder === 'desc'
                      ? 'Sorted by Release Year: Newest First (Click for Oldest First)'
                      : 'Sorted by Release Year: Oldest First (Click for Newest First)'
                    : 'Sort by Release Year'
                }
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>
                  Release Year
                  {sortBy === 'release_year' ? (releaseYearOrder === 'desc' ? ' ↓' : ' ↑') : ''}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Collapsible 6-Category Filter Panel */}
        {isFilterPanelOpen && (
          <LibraryFilterPanel
            filterState={effectiveFilterState}
            onChange={handleUpdateFilterState}
            onReset={handleResetFilterState}
            filterIndex={effectiveFilterIndex}
            filteredCount={sortedGames.length}
            totalCount={unfilteredTotalCount ?? games.length}
            onClose={() => setIsFilterPanelOpen(false)}
          />
        )}

        {/* Active Filter Chips Bar */}
        {(activeFilterChips.length > 0 || activeFilter) && (
          <div
            data-testid="active-filter-chips-bar"
            className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-md bg-[#141d29] border border-steam-border/70 text-xs"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold text-steam-subtext mr-1">
                Active Filters:
              </span>
              {activeFilterChips.map((chip) => (
                <span
                  key={chip.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-steam-accent/15 border border-steam-accent/40 text-white text-[11px]"
                >
                  <span className="text-steam-accent font-semibold">{chip.category}:</span>
                  <span>{chip.label}</span>
                  <button
                    type="button"
                    data-testid={`remove-filter-chip-${chip.id}`}
                    onClick={() => handleUpdateFilterState(chip.remove(effectiveFilterState))}
                    className="p-0.5 rounded-full hover:bg-white/10 text-steam-accent hover:text-white transition-colors cursor-pointer"
                    title={`Remove ${chip.label} filter`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {activeFilterChips.length === 0 && activeFilter && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-steam-accent/15 border border-steam-accent/40 text-white text-[11px]">
                  <span className="text-steam-accent font-semibold">{activeFilter.label}:</span>
                  <span>{activeFilter.value}</span>
                </span>
              )}
            </div>
            <button
              type="button"
              data-testid="clear-all-filters-btn"
              onClick={handleResetFilterState}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#25364b] text-steam-accent hover:text-white border border-steam-border text-[11px] font-semibold transition-colors cursor-pointer shrink-0"
            >
              <X className="w-3 h-3" />
              <span>Clear All</span>
            </button>
          </div>
        )}

        {/* Search status notice if filtering */}
        {searchQuery && (
          <div className="text-xs text-steam-subtext flex items-center gap-2">
            <span>Showing results for</span>
            <span className="text-white font-semibold bg-white/10 px-2 py-0.5 rounded">
              "{searchQuery}"
            </span>
            <span>({sortedGames.length} matching)</span>
          </div>
        )}

        {/* Empty State */}
        {sortedGames.length === 0 && (
          <div className="py-20 text-center flex flex-col items-center justify-center gap-3 bg-[#16202d]/50 rounded-lg border border-steam-border/60 p-8">
            <Layers className="w-12 h-12 text-steam-subtext/60" />
            <h3 className="text-base font-bold text-white">
              {title ? `No games in "${title}"` : 'No games found'}
            </h3>
            <p className="text-xs text-steam-subtext max-w-sm">
              {title
                ? `You have not assigned any titles to the "${title}" collection yet. You can add games from the sidebar or any game detail page.`
                : 'No titles match your current filter or search criteria. Try clearing search or switching platforms.'}
            </p>
            {(activeFilter && onClearActiveFilter) || activeCriteriaCount > 0 ? (
              <button
                onClick={handleResetFilterState}
                className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-steam-accent text-black font-semibold text-xs hover:brightness-110 transition-all shadow"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear Filter & View All Games</span>
              </button>
            ) : onClearGroupFilter ? (
              <button
                onClick={onClearGroupFilter}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-steam-accent text-black font-semibold text-xs hover:brightness-110 transition-all shadow"
              >
                <span>View All Games</span>
              </button>
            ) : null}
          </div>
        )}

        {/* Game Covers Grid (Aspect Ratio ~2:3 Portrait Posters) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
          {sortedGames.map((game) => {
            const isRunning = launcherService.isGameRunning(game.id);
            const isInstalled =
              game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
            return (
              <div
                key={game.id}
                data-game-id={game.id}
                onClick={(e) => {
                  if (contextMenu.isOpen) {
                    setContextMenu((prev) => ({ ...prev, isOpen: false, game: null }));
                    return;
                  }
                  if (e.button === 0 && !e.ctrlKey) {
                    onSelectGame(game);
                  }
                }}
                onMouseEnter={(e) => handleMouseEnter(game, e)}
                onMouseLeave={handleCardMouseLeave}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleContextMenu(game, e);
                }}
                style={{
                  contentVisibility: 'auto',
                  containIntrinsicSize: '200px 300px',
                }}
                className="cv-card group relative flex flex-col rounded-md overflow-hidden bg-[#16202d] border border-steam-border/70 hover:border-steam-accent transition-all duration-200 cursor-pointer shadow-md hover:shadow-2xl hover:scale-[1.03] active:scale-[0.99]"
              >
                {/* 2:3 Portrait Capsule Viewport */}
                <div
                  className="relative aspect-[2/3] w-full bg-black/60 overflow-hidden flex items-center justify-center"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleContextMenu(game, e);
                  }}
                >
                  {(() => {
                    const cardUserOverride = userOverridesMap[game.id] || getUserOverrideForGame(game, userOverridesMap);
                    const cardOverrideCover = cardUserOverride?.capsuleImage || coverOverrides[game.id];
                    return (
                      <GameCardCover
                        game={game}
                        overrideCoverUrl={cardOverrideCover}
                        userOverride={cardUserOverride}
                        onNeedCoverLookup={handleNeedCoverLookup}
                      />
                    );
                  })()}

                  {/* Gradient bottom shadow to ensure overlays pop */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 pointer-events-none" />

                  {/* Top Header: Running or Installed status badge */}
                  {(isRunning || isInstalled) && (
                    <div className="absolute top-2 left-2 z-20 flex items-center gap-1 pointer-events-none">
                      {isRunning ? (
                        <div className="flex items-center gap-1 bg-amber-950/90 border border-amber-400/70 text-amber-300 text-[10px] font-bold px-1.5 py-0.5 rounded shadow">
                          <Activity className="w-2.5 h-2.5 text-amber-400 animate-pulse" />
                          <span>Running</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 text-[10px] font-semibold px-1.5 py-0.5 rounded shadow">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          <span>Ready</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Top-Right: Critic Score Pill */}
                  {(() => {
                    const targetSteamId = steamMatcher.getEffectiveSteamAppId(game);
                    const oc = getOpenCriticData(
                      targetSteamId || undefined,
                      game.title,
                      game.reviewSummary?.positivePercent,
                      undefined,
                      undefined,
                      false,
                      true
                    );
                    if (!oc) return null;
                    const ocColors = getTierColor(oc.tier);
                    const isMetacritic = oc.source === 'metacritic';
                    const isMetacriticUser = oc.source === 'metacritic_user';
                    const isSteam = oc.source === 'steam';
                    const isGog = oc.source === 'gog';
                    const isEpic = oc.source === 'epic';
                    const sourceTag = isMetacritic
                      ? 'MC'
                      : isMetacriticUser
                      ? 'MCU'
                      : isSteam
                      ? 'STM'
                      : isGog
                      ? 'GOG'
                      : isEpic
                      ? 'EGS'
                      : 'OC';
                    const sourceName = isMetacritic
                      ? 'Metacritic Metascore'
                      : isMetacriticUser
                      ? 'Metacritic User Score'
                      : isSteam
                      ? 'Steam Community'
                      : isGog
                      ? 'GOG Player Rating'
                      : isEpic
                      ? 'Epic Store Rating'
                      : 'OpenCritic';
                    return (
                      <div
                        className={`absolute top-2 right-2 z-10 flex items-center gap-1 text-[10px] font-extrabold px-1.5 py-0.5 rounded border shadow-md backdrop-blur-md transition-all ${
                          ocColors.badgeBg
                        } ${ocColors.badgeBorder} ${ocColors.badgeText} ${
                          sortBy === 'rating'
                            ? 'ring-2 ring-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.55)] scale-105'
                            : ''
                        }`}
                        title={`${sourceName}: ${oc.score}/100 • ${oc.tier}${oc.starRatingRaw !== undefined ? ` (${oc.starRatingRaw}★)` : ''}${oc.userScoreRaw ? ` (${oc.userScoreRaw}/10 user rating)` : ''}${oc.percentRecommended !== undefined ? ` (${oc.percentRecommended}% recommended)` : ''}`}
                      >
                        <span className="text-[9px] opacity-75">{sourceTag}</span>
                        <span>{oc.score}</span>
                      </div>
                    );
                  })()}

                  {/* Overlayed Bottom-Left: Native OS Compatibility Badge */}
                  <div className="absolute bottom-2 left-2 z-10 pointer-events-none">
                    <NativeOsBadges platforms={getNativeOsPlatforms(game)} variant="cover-badge" />
                  </div>

                  {/* Overlayed Bottom-Right: Storefront Icons Game is Owned On */}
                  <div
                    className="absolute bottom-2 right-2 flex items-center gap-1.5 bg-black/85 backdrop-blur-md px-2 py-1 rounded border border-white/20 shadow-lg pointer-events-none group-hover:border-steam-accent/60 transition-colors z-10"
                    title={`Owned on: ${game.platforms
                      .map((p) => {
                        const name = getStorefrontDisplayName(p.platformId);
                        const isConn = connectedSet.has(p.platformId);
                        return isConn ? name : `${name} (Not Connected)`;
                      })
                      .join(', ')}`}
                  >
                    {game.platforms.map((p) => {
                      const isPlatConnected = connectedSet.has(p.platformId);
                      return (
                        <div key={p.platformId} className="relative flex items-center">
                          <StorefrontIcon
                            storefrontId={p.platformId}
                            className={`w-3.5 h-3.5 drop-shadow ${
                              isPlatConnected ? 'text-white/90' : 'text-amber-200/80'
                            }`}
                          />
                          {!isPlatConnected && (
                            <span
                              className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-amber-400 ring-1 ring-black"
                              title="Not Connected"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Hover Quick Action Indicator */}
                  <div className="absolute inset-0 bg-steam-accent/10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                </div>

                {/* Bottom Card Title Info */}
                <div className="p-2.5 bg-[#16202d] flex flex-col justify-between border-t border-steam-border/40 min-h-[46px]">
                  <h3
                    className="text-xs font-semibold text-white/90 group-hover:text-steam-accent truncate transition-colors"
                    title={game.title}
                  >
                    {game.title}
                  </h3>
                  {(() => {
                    const cardReleaseYear =
                      effectiveFilterIndex.entriesById.get(game.id)?.releaseYear ||
                      getReleaseYear(game, steamMatcher.getEffectiveSteamAppId(game));
                    const playtimeLabel = formatPlaytime(game);
                    return (
                      <div className="flex items-center justify-between text-[10px] text-steam-subtext mt-0.5 gap-1.5">
                        <span className="truncate">
                          {game.genres.slice(0, 1).join(', ') || 'Game'}
                          {cardReleaseYear && sortBy !== 'release_year' ? ` • ${cardReleaseYear}` : ''}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {sortBy === 'release_year' && cardReleaseYear && (
                            <span className="px-1.5 py-0.2 rounded bg-steam-accent/20 border border-steam-accent/40 text-steam-accent font-mono font-semibold text-[10px]">
                              {cardReleaseYear}
                            </span>
                          )}
                          {playtimeLabel && (
                            <span className="text-white/80 font-medium">{playtimeLabel}</span>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Floating Hover Preview Pane (Steam Popover Style) */}
      {hoveredGame && (
        <div
          ref={popoutRef}
          style={{
            position: 'fixed',
            left: `${previewPos.x}px`,
            top: `${previewPos.y}px`,
            zIndex: 60,
          }}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
          }}
          onMouseLeave={handlePopoutMouseLeave}
          onClick={() => onSelectGame(hoveredGame)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleContextMenu(hoveredGame, e);
          }}
          className="w-80 rounded-lg overflow-hidden bg-[#16202d]/95 backdrop-blur-xl border border-steam-accent/70 shadow-[0_12px_40px_rgba(0,0,0,0.85)] pointer-events-auto cursor-pointer animate-in fade-in zoom-in-95 duration-150 text-steam-text"
        >
          {(() => {
            const hoveredOverride = userOverridesMap[hoveredGame.id] || getUserOverrideForGame(hoveredGame, userOverridesMap);
            const targetAppId = hoveredOverride?.steamAppId === null
              ? undefined
              : steamMatcher.getEffectiveSteamAppId(hoveredGame);
            const releaseYear = getReleaseYear(hoveredGame, targetAppId);
            const cleanSynopsis = getCleanSynopsis(hoveredGame, targetAppId, hoveredOverride);

            return (
              <>
                {/* Header Image Banner */}
                <div className="relative aspect-video w-full bg-black/60 overflow-hidden">
                  <img
                    src={hoveredOverride?.headerImage || hoveredGame.headerImage || hoveredGame.capsuleImage}
                    alt={hoveredGame.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#16202d] via-transparent to-black/30" />
                  <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-white drop-shadow truncate">
                      {hoveredGame.title}
                    </span>
                    {releaseYear && (
                      <span className="text-[11px] font-bold text-white/90 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm border border-white/20 shrink-0 shadow">
                        {releaseYear}
                      </span>
                    )}
                  </div>
                </div>

                {/* Disconnected Storefront Notice Banner */}
                {hoveredGame.platforms.some((p) => !connectedSet.has(p.platformId)) && (
                  <div className="px-3 py-1.5 bg-amber-950/70 border-b border-amber-600/40 text-[11px] text-amber-300 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>
                      {hoveredGame.platforms
                        .filter((p) => !connectedSet.has(p.platformId))
                        .map((p) => getStorefrontDisplayName(p.platformId))
                        .join(', ')}{' '}
                      (Not Connected)
                    </span>
                  </div>
                )}

                {/* Details Body */}
                <div className="p-3.5 space-y-3 text-xs">
                  {/* Review Sentiment & Playtime Row */}
                  <div className="flex items-center justify-between border-b border-steam-border/40 pb-2">
                    {hoveredGame.reviewSummary ? (
                      <div className="flex items-center gap-1.5">
                        <ThumbsUp className="w-3.5 h-3.5 text-steam-accent" />
                        <span className="text-steam-accent font-semibold text-[11px]">
                          {hoveredGame.reviewSummary.reviewScoreDesc}
                        </span>
                        <span className="text-steam-subtext text-[10px]">
                          ({hoveredGame.reviewSummary.positivePercent}%)
                        </span>
                      </div>
                    ) : (
                      <span className="text-steam-subtext text-[11px] italic">Verified in Library</span>
                    )}

                    <div className="flex items-center gap-2">
                      {formatPlaytime(hoveredGame) ? (
                        <div className="flex items-center gap-1 text-white font-medium text-[11px]">
                          <Clock className="w-3 h-3 text-sky-400" />
                          <span>{formatPlaytime(hoveredGame)}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-sky-300 text-[11px]">
                          <Cloud className="w-3 h-3" />
                          <span>In Library</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Critic Rating Row */}
                  {(() => {
                    const oc = getOpenCriticData(
                      targetAppId,
                      hoveredGame.title,
                      hoveredGame.reviewSummary?.positivePercent
                    );
                    if (!oc) return null;
                    const ocColors = getTierColor(oc.tier);
                    const isMetacritic = oc.source === 'metacritic';
                    const isMetacriticUser = oc.source === 'metacritic_user';
                    const isSteam = oc.source === 'steam';
                    const isGog = oc.source === 'gog';
                    const isEpic = oc.source === 'epic';
                    const sourceTag = isMetacritic
                      ? 'MC'
                      : isMetacriticUser
                      ? 'MCU'
                      : isSteam
                      ? 'STM'
                      : isGog
                      ? 'GOG'
                      : isEpic
                      ? 'EGS'
                      : 'OC';
                    const sourceName = isMetacritic
                      ? 'Metacritic'
                      : isMetacriticUser
                      ? 'MC User Score'
                      : isSteam
                      ? 'Steam Rating'
                      : isGog
                      ? 'GOG Rating'
                      : isEpic
                      ? 'Epic Rating'
                      : 'OpenCritic';
                    return (
                      <div className="flex items-center justify-between bg-black/40 px-2.5 py-1.5 rounded border border-white/5 text-[10px]">
                        <div className="flex items-center gap-1.5 text-white/70">
                          <span
                            className={`w-3.5 h-3.5 rounded text-[8px] font-black flex items-center justify-center shrink-0 ${
                              isMetacritic
                                ? 'bg-amber-400 text-black font-extrabold'
                                : isMetacriticUser
                                ? 'bg-emerald-500 text-black font-extrabold'
                                : isSteam
                                ? 'bg-sky-600 text-white font-extrabold'
                                : isGog
                                ? 'bg-purple-600 text-white font-extrabold'
                                : isEpic
                                ? 'bg-zinc-700 text-white font-extrabold'
                                : `${ocColors.scoreBg} text-white`
                            }`}
                          >
                            {sourceTag}
                          </span>
                          <span className="font-semibold uppercase tracking-wider text-[9px] text-white/60">
                            {sourceName}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${ocColors.badgeBg} ${ocColors.badgeBorder} ${ocColors.badgeText}`}>
                            {oc.score}
                          </span>
                          <span className={`text-[10px] font-bold ${ocColors.accentText}`}>
                            {oc.tier}
                          </span>
                          {oc.percentRecommended !== undefined && (
                            <span className="text-[10px] text-steam-subtext">
                              ({oc.percentRecommended}% rec)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* HowLongToBeat Row */}
                  {(() => {
                    const hltb = getHowLongToBeat(
                      hoveredGame.title,
                      targetAppId,
                      hoveredGame.genres,
                      hoveredGame.tags
                    );
                    if (!hltb || (!hltb.mainStoryHours && !hltb.allStylesHours)) return null;

                    const formatHours = (h: number): string => {
                      if (!h || h <= 0) return '--';
                      if (h % 1 === 0.5) return `${Math.floor(h)}½h`;
                      return `${Math.round(h)}h`;
                    };

                    return (
                      <div className="flex items-center justify-between bg-black/40 px-2.5 py-1.5 rounded border border-white/5 text-[10px]">
                        <div className="flex items-center gap-1.5 text-white/70">
                          <Clock className="w-3.5 h-3.5 text-sky-400" />
                          <span className="font-semibold uppercase tracking-wider text-[9px] text-white/60">
                            HowLongToBeat
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          {hltb.mainStoryHours > 0 && (
                            <span className="flex items-center gap-1 text-white/90">
                              <span className="text-steam-subtext text-[10px]">Main:</span>
                              <strong className="text-sky-300 font-bold text-[11px]">{formatHours(hltb.mainStoryHours)}</strong>
                            </span>
                          )}
                          {hltb.completionistHours > 0 && (
                            <span className="flex items-center gap-1 text-white/90">
                              <span className="text-steam-subtext text-[10px]">100%:</span>
                              <strong className="text-amber-300 font-bold text-[11px]">{formatHours(hltb.completionistHours)}</strong>
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Synopsis Snippet */}
                  {(dynamicBlurb?.id === hoveredGame.id ? dynamicBlurb.blurb : cleanSynopsis) && (
                    <p className="text-[11px] text-steam-subtext leading-relaxed line-clamp-3">
                      {dynamicBlurb?.id === hoveredGame.id ? dynamicBlurb.blurb : cleanSynopsis}
                    </p>
                  )}

                  {/* Owned On Storefronts Row */}
                  <div className="flex items-center justify-between pt-1 text-[11px]">
                    <span className="text-steam-subtext text-[10px] uppercase font-bold tracking-wider">
                      Owned on:
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {hoveredGame.platforms.map((p) => {
                        const isConnected = connectedSet.has(p.platformId);
                        return (
                          <div
                            key={p.platformId}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${
                              isConnected
                                ? 'bg-black/50 border-white/10 text-white'
                                : 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                            }`}
                          >
                            <StorefrontIcon
                              storefrontId={p.platformId}
                              className={`w-3 h-3 ${isConnected ? 'text-sky-400' : 'text-amber-400'}`}
                            />
                            <span>{getStorefrontDisplayName(p.platformId)}</span>
                            {!isConnected && (
                              <span className="text-[9px] text-amber-400 font-semibold">(Not Connected)</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Tags Pills */}
                  {hoveredGame.tags && hoveredGame.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {hoveredGame.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 rounded text-[10px] bg-[#223042] text-steam-accent border border-steam-border/60"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Branching Game Context Menu */}
      <GameContextMenu
        isOpen={contextMenu.isOpen}
        x={contextMenu.x}
        y={contextMenu.y}
        game={contextMenu.game}
        collections={collections || []}
        onClose={() => setContextMenu((prev) => ({ ...prev, isOpen: false, game: null }))}
        onFixMatch={(game) => {
          if (onFixMatch) onFixMatch(game);
        }}
        onSyncStoreMedia={(game) => {
          if (onSyncGameMedia) onSyncGameMedia(game);
        }}
        onToggleCollection={(colId, gameId) => {
          if (onToggleGameInCollection) onToggleGameInCollection(colId, gameId);
        }}
        onManageCollections={(game) => {
          if (onOpenManageCollectionsModal) onOpenManageCollectionsModal(game);
        }}
        onViewAchievements={(game) => {
          if (onViewAchievements) onViewAchievements(game);
        }}
        onHideGame={
          onHideGame
            ? (game) => {
                setHoveredGame(null);
                onHideGame(game);
              }
            : undefined
        }
      />
    </div>
  );
};
