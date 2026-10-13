import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
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
  Award,
  AlertCircle,
} from 'lucide-react';
import { getOpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { getHowLongToBeat } from '../../services/hltb/howLongToBeat';
import { steamMatcher } from '../../services/steam/steamMatcher';
import steamEnrichedCache from '../../services/storage/steamEnrichedCache.json';
import steamBlurbCache from '../../services/storage/steamBlurbCache.json';
import { steamApi } from '../../services/steam/steamApi';
import { ActiveGameFilter } from '../../contracts/filter';
import { parseTimestampMs } from '../../utils/dateUtils';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { igdbCoverService, isKnownDeadSteamCover, isUnsuitableCoverUrl, normalizeKey } from '../../services/igdb/igdbCoverService';
import {
  extractFirstParagraph,
  isGenericPlaceholderSynopsis,
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

function isPlaceholderSynopsis(desc?: string, title?: string): boolean {
  return isGenericPlaceholderSynopsis(desc, title);
}

function getCleanSynopsis(
  game: CanonicalGame,
  targetAppId?: number | null,
  userOverride?: UserGameOverride | null
): string | null {
  // 0. User manual override ALWAYS takes priority #1
  const effectiveOverride = userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  if (effectiveOverride?.shortDescription && !isPlaceholderSynopsis(effectiveOverride.shortDescription, game.title)) {
    return effectiveOverride.shortDescription.trim();
  }
  if (effectiveOverride && game.shortDescription && !isPlaceholderSynopsis(game.shortDescription, game.title)) {
    return game.shortDescription.trim();
  }

  // If user explicitly unlinked from Steam, targetAppId should be ignored
  const effectiveAppId = effectiveOverride?.steamAppId === null ? null : targetAppId;

  // 1. Steam blurb cache (curated store blurbs for 387+ matched catalog titles)
  if (effectiveAppId) {
    const blurb = (steamBlurbCache as Record<string, string>)[String(effectiveAppId)];
    if (blurb && !isPlaceholderSynopsis(blurb, game.title)) {
      return blurb.trim();
    }
  }

  // 2. Steam enriched cache
  if (effectiveAppId) {
    const cached = (steamEnrichedCache as Record<string, any>)[String(effectiveAppId)];
    if (cached?.shortDescription && !isPlaceholderSynopsis(cached.shortDescription, game.title)) {
      return cached.shortDescription.trim();
    }
  }

  // 3. Steam API live memory cache
  if (effectiveAppId) {
    const live = steamApi.getCachedMetadata(effectiveAppId);
    if (live?.shortDescription && !isPlaceholderSynopsis(live.shortDescription, game.title)) {
      return live.shortDescription.trim();
    }
  }

  // 4. Curated GOG special descriptions (Blood Omen, Daggerfall Unity, Fallout: London, etc.)
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  if (gogPlat?.platformGameId) {
    const special = GOG_SPECIAL_DESCRIPTIONS[gogPlat.platformGameId];
    if (special?.lead && !isPlaceholderSynopsis(special.lead, game.title)) {
      return special.lead.trim();
    }
    const gogCached = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
    if (gogCached?.shortDescription && !isPlaceholderSynopsis(gogCached.shortDescription, game.title)) {
      return gogCached.shortDescription.trim();
    }
  }

  // 5. Enriched metadata on game
  if (game.enrichedMetadata?.shortDescription && !isPlaceholderSynopsis(game.enrichedMetadata.shortDescription, game.title)) {
    return game.enrichedMetadata.shortDescription.trim();
  }

  // 6. Game shortDescription (if not a placeholder)
  if (game.shortDescription && !isPlaceholderSynopsis(game.shortDescription, game.title)) {
    return game.shortDescription.trim();
  }

  // 7. First paragraph of game description (truncated with ... if needed)
  const gogCachedData = gogPlat?.platformGameId ? (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId] : null;
  const firstPara =
    extractFirstParagraph(game.enrichedMetadata?.detailedDescription) ||
    extractFirstParagraph(game.enrichedMetadata?.aboutTheGame) ||
    extractFirstParagraph(gogCachedData?.aboutTheGame) ||
    extractFirstParagraph(gogCachedData?.detailedDescription) ||
    extractFirstParagraph(game.shortDescription);

  if (firstPara && !isPlaceholderSynopsis(firstPara, game.title)) {
    return firstPara;
  }

  // 8. Clean summary from genres and developers
  if (game.genres && game.genres.length > 0) {
    const cleanGenres = game.genres
      .map((g) => g.replace(/\s*on GOG\.com.*$/i, '').replace(/\s*\(DRM-Free\)/i, '').trim())
      .filter((g) => g.length > 0 && !g.toLowerCase().includes('drm-free') && !g.toLowerCase().includes('gog') && !g.toLowerCase().includes('store exclusive'));
    if (cleanGenres.length > 0) {
      const dev = game.developers?.[0] ? ` developed by ${game.developers[0]}` : '';
      return `${game.title} is a ${cleanGenres.slice(0, 3).join(', ')} title${dev}.`;
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

  // 1. Authoritative user manual override ALWAYS takes absolute priority #1
  const effectiveOverride = userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
  if (effectiveOverride?.capsuleImage) {
    add(effectiveOverride.capsuleImage, true);
  }
  if (overrideCoverUrl) {
    add(overrideCoverUrl, true);
  }
  if (effectiveOverride && game.capsuleImage) {
    add(game.capsuleImage, true);
  }

  // 2. Instant verified IGDB portrait box art if known or cached
  const igdbCover = igdbCoverService.getIgdbCoverInstant(game.title, game.steamAppId, game.id);
  add(igdbCover);

  // 3. Official Steam 600x900 2:3 Library Poster (for games available on Steam that are not 404/hashed)
  // If user explicitly unlinked from Steam (effectiveOverride?.steamAppId === null), do NOT match to Steam!
  const isExplicitNonSteam = effectiveOverride?.steamAppId === null || game.isExplicitNonSteam === true;
  const targetSteamId = !isExplicitNonSteam
    ? steamMatcher.getEffectiveSteamAppId(game)
    : null;

  if (targetSteamId && !isKnownDeadSteamCover(targetSteamId)) {
    add(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900_2x.jpg`);
  }

  // 4. Official Steam / Epic / GOG tall vertical posters already attached to the game entity
  if (game.capsuleImage) {
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
      (isGog && lower.includes('_glx_vertical_cover'))
    ) {
      add(game.capsuleImage);
    }
  }

  // 5. Official Steam 600x900 1x poster
  if (targetSteamId && !isKnownDeadSteamCover(targetSteamId)) {
    add(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${targetSteamId}/library_600x900.jpg`);
  }

  // 6. Primary capsule image if valid
  if (game.capsuleImage) {
    add(game.capsuleImage);
  }

  return candidates;
}

interface GameCardCoverProps {
  game: CanonicalGame;
  overrideCoverUrl?: string | null;
  userOverride?: UserGameOverride | null;
  onNeedCoverLookup?: (game: CanonicalGame) => void;
}

export const GameCardCover: React.FC<GameCardCoverProps> = React.memo(
  ({ game, overrideCoverUrl, userOverride, onNeedCoverLookup }) => {
    const candidates = useMemo(() => {
      return getCoverCandidates(game, overrideCoverUrl || undefined, userOverride);
    }, [game, overrideCoverUrl, userOverride]);

    const [candidateIndex, setCandidateIndex] = useState(0);

    // Reset candidate progression when game or explicit override changes
    useEffect(() => {
      setCandidateIndex(0);
    }, [game.id, game.capsuleImage, overrideCoverUrl, userOverride?.capsuleImage]);

    const currentSrc = candidateIndex < candidates.length ? candidates[candidateIndex] : null;

    useEffect(() => {
      if (!currentSrc && onNeedCoverLookup) {
        onNeedCoverLookup(game);
      }
    }, [currentSrc, game, onNeedCoverLookup]);

    if (!currentSrc) {
      return (
        <div className="grid-cover-fallback w-full h-full flex flex-col items-center justify-center p-4 text-center bg-gradient-to-b from-[#1b2838] to-[#0f161f] select-none">
          <Gamepad2 className="w-10 h-10 text-slate-500 mb-2 opacity-60 group-hover:scale-110 group-hover:text-steam-accent transition-all" />
          <span className="text-xs font-semibold text-slate-300 line-clamp-3 leading-tight px-1">
            {game.title}
          </span>
        </div>
      );
    }

    const isUserExplicitCover = Boolean(
      (userOverride?.capsuleImage && currentSrc === userOverride.capsuleImage) ||
      (overrideCoverUrl && currentSrc === overrideCoverUrl)
    );

    return (
      <img
        key={currentSrc}
        src={currentSrc}
        alt={game.title}
        loading="lazy"
        onLoad={(e) => {
          const { naturalWidth, naturalHeight } = e.currentTarget;
          if (naturalWidth && naturalHeight && !isUserExplicitCover) {
            const ratio = naturalWidth / naturalHeight;
            // Reject square (1.0) and landscape (> 1.0) images in portrait gridview
            // ratio > 0.94 cleanly rejects 1:1 square icons and wide banners
            // while preserving legitimate portrait covers like Epic's 1280x1440 (0.888)
            if (ratio > 0.94) {
              setCandidateIndex((prev) => prev + 1);
              if (onNeedCoverLookup) onNeedCoverLookup(game);
            }
          }
        }}
        onError={() => {
          // Declaratively advance to the next candidate without mutating the DOM
          setCandidateIndex((prev) => prev + 1);
        }}
        className="w-full h-full object-cover group-hover:brightness-105 transition-all duration-300"
      />
    );
  }
);


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
  onSyncGameMedia?: (game: CanonicalGame) => void;
  collections?: GameCollection[];
  onToggleGameInCollection?: (collectionId: string, gameId: string) => void;
  onOpenManageCollectionsModal?: (game?: CanonicalGame) => void;
  onViewAchievements?: (game: CanonicalGame) => void;
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
  onSyncGameMedia,
  collections,
  onToggleGameInCollection,
  onOpenManageCollectionsModal,
  onViewAchievements,
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
    window.addEventListener('antigravity_critic_updated', handleUpdate);
    return () => window.removeEventListener('antigravity_critic_updated', handleUpdate);
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
    if (connectedStorefronts && connectedStorefronts.length > 0) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      if (connected.length > 0) {
        return new Set<StorefrontId>(connected);
      }
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
  const [sortBy, setSortBy] = useState<'alphabetical' | 'rating' | 'playtime' | 'recent'>('alphabetical');
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const popoutRef = useRef<HTMLDivElement | null>(null);
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  const gamesRef = useRef(games);
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
  const scrollEndTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [dynamicBlurb, setDynamicBlurb] = useState<{ id: string; blurb: string } | null>(null);
  const [coverOverrides, setCoverOverrides] = useState<Record<string, string | null>>({});
  const attemptedCoverLookupsRef = useRef<Set<string>>(new Set());

  // Listen for user override additions / modifications to reactively update the grid
  const [overrideVersion, setOverrideVersion] = useState(0);
  useEffect(() => {
    const handleOverrideUpdate = () => {
      setOverrideVersion((v) => v + 1);
    };
    window.addEventListener('antigravity:user-override-updated', handleOverrideUpdate);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleOverrideUpdate);
    };
  }, []);

  const userOverridesMap = useMemo(() => loadUserOverrides(), [games, overrideVersion]);

  const handleNeedCoverLookup = useCallback((game: CanonicalGame) => {
    if (attemptedCoverLookupsRef.current.has(game.id)) return;
    attemptedCoverLookupsRef.current.add(game.id);

    igdbCoverService.fetchIgdbCover(game.title).then((resolvedCover) => {
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
        if (active && meta?.shortDescription && !isPlaceholderSynopsis(meta.shortDescription, hoveredGame.title)) {
          setDynamicBlurb({ id: hoveredGame.id, blurb: meta.shortDescription.trim() });
        }
      });
      return () => {
        active = false;
      };
    }
  }, [hoveredGame?.id]);

  const handleSortChange = (newSort: 'alphabetical' | 'rating' | 'playtime' | 'recent') => {
    setSortBy(newSort);
    if (gridContainerRef.current?.parentElement) {
      gridContainerRef.current.parentElement.scrollTop = 0;
    }
  };

  // Sorting
  const sortedGames = [...games].sort((a, b) => {
    if (sortBy === 'rating') {
      const targetSteamIdA = steamMatcher.getEffectiveSteamAppId(a);
      const targetSteamIdB = steamMatcher.getEffectiveSteamAppId(b);
      const ocA = getOpenCriticData(targetSteamIdA || undefined, a.title, a.reviewSummary?.positivePercent);
      const ocB = getOpenCriticData(targetSteamIdB || undefined, b.title, b.reviewSummary?.positivePercent);
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
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

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
                    {games.length}
                  </span>
                </h1>
                {activeFilter && (
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
                {onClearGroupFilter && !activeFilter && (
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

          {/* Sort Controls */}
          <div className="flex items-center gap-2 text-xs shrink-0 self-end lg:self-center">
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
            </div>
          </div>
        </div>

        {/* Search status notice if filtering */}
        {searchQuery && (
          <div className="text-xs text-steam-subtext flex items-center gap-2">
            <span>Showing results for</span>
            <span className="text-white font-semibold bg-white/10 px-2 py-0.5 rounded">
              "{searchQuery}"
            </span>
            <span>({games.length} matching)</span>
          </div>
        )}

        {/* Empty State */}
        {games.length === 0 && (
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
            {activeFilter && onClearActiveFilter ? (
              <button
                onClick={onClearActiveFilter}
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
            const isInstalled = game.platforms.some((p) => p.installed);
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
                className="group relative flex flex-col rounded-md overflow-hidden bg-[#16202d] border border-steam-border/70 hover:border-steam-accent transition-all duration-200 cursor-pointer shadow-md hover:shadow-2xl hover:scale-[1.03] active:scale-[0.99]"
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

                  {/* Top Header: Installed status badge if installed */}
                  {isInstalled && (
                    <div className="absolute top-2 left-2 flex items-center gap-1 bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 text-[10px] font-semibold px-1.5 py-0.5 rounded shadow z-10">
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      <span>Ready</span>
                    </div>
                  )}

                  {/* Top-Right: Critic Score Pill */}
                  {(() => {
                    const targetSteamId = steamMatcher.getEffectiveSteamAppId(game);
                    const oc = getOpenCriticData(
                      targetSteamId || undefined,
                      game.title,
                      game.reviewSummary?.positivePercent
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
                  <div className="flex items-center justify-between text-[10px] text-steam-subtext mt-0.5">
                    <span>
                      {game.genres.slice(0, 1).join(', ') || 'Game'}
                    </span>
                    {formatPlaytime(game) && (
                      <span className="text-white/80 font-medium">
                        {formatPlaytime(game)}
                      </span>
                    )}
                  </div>
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
      />
    </div>
  );
};
