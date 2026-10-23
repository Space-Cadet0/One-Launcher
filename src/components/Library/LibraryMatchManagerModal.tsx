import React, { useState, useMemo, useEffect, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { UserGameOverride } from '../../contracts/override';
import { StorefrontId } from '../../contracts/platform';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  isNonGameStorefrontEntryConfirmed,
  confirmNonGameStorefrontEntry,
  confirmMultipleNonGameStorefrontEntries,
  unconfirmNonGameStorefrontEntry,
} from '../../services/storage/userOverrideStorage';
import {
  getSuppressedCatalogEntries,
  SuppressedCatalogEntry,
  normalizeCanonicalTitle,
} from '../../services/integrations/catalogSanitizer';
import { matchesLooseSearchQuery } from '../../services/common/titleUtils';
import { buildCandidateStoreUrl } from '../../services/scraper/metadataScraperService';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { launcherService } from '../../services/launcher/launcherService';
import {
  isGenericPlaceholderSynopsis,
  fallbackMetadataProvider,
} from '../../services/steam/fallbackMetadataProvider';
import { steamApi } from '../../services/steam/steamApi';
import gogEnrichedCache from '../../services/storage/gogEnrichedCache.json';
import steamBlurbCache from '../../services/storage/steamBlurbCache.json';
import {
  X,
  Search,
  Wand,
  AlertTriangle,
  EyeOff,
  Sliders,
  Layers,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ExternalLink,
  RotateCcw,
  Eye,
  CheckCircle2,
  Image as ImageIcon,
  ShieldAlert,
} from 'lucide-react';

export interface LibraryMatchManagerModalProps {
  isOpen: boolean;
  games: CanonicalGame[];
  onClose: () => void;
  onFixMatchForGame: (game: CanonicalGame) => void;
  onResetOverride?: (gameId: string) => void;
  onResetOverrideForGame?: (gameId: string) => void;
  onInspectGame?: (game: CanonicalGame) => void;
  onSelectGame?: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onUnhideEntry?: (entry: SuppressedCatalogEntry) => void;
  onGameUpdated?: (game: CanonicalGame) => void;
}

type FilterTab =
  | 'all'
  | 'unmatched'
  | 'low_confidence'
  | 'user_suppressed'
  | 'suppressed'
  | 'overrides'
  | 'merged';

type UnmatchedSubFilter = 'all' | 'artwork' | 'synopsis' | 'dev_year';
type AutoFilteredSubFilter = 'all' | 'beta' | 'prologue' | 'tool' | 'soundtrack' | 'dlc';

export type UnmatchedReasonCode =
  | 'missing_all_art'
  | 'missing_vertical_cover'
  | 'unresolved_codename'
  | 'missing_synopsis'
  | 'missing_dev_year';

export interface UnmatchedDiagnosticReason {
  code: UnmatchedReasonCode;
  label: string;
  tooltip: string;
  colorClass: string;
}

export function extractCleanSynopsisText(htmlOrText?: string): string {
  if (!htmlOrText) return '';
  return htmlOrText
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\/*[a-z0-9_=]+\]/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLikelyNonStoreOrTestBranchTitle(title?: string): boolean {
  return Boolean(
    title &&
      (/\b(test\s*branch|beta\b|alpha\b|playtest|dedicated\s*server|sdk\b|benchmark|prototype|staging|experimental|press\s*build|review\s*build|demo\b)\b/i.test(
        title
      ) ||
        /^[a-z0-9]+(_[a-z0-9]+){2,}$/i.test(title.trim()))
  );
}

export function hasGenuineStoreSynopsis(
  game: CanonicalGame,
  override?: UserGameOverride,
  probedSynopsisMap?: Record<string, string | null>
): boolean {
  if (probedSynopsisMap && game.id in probedSynopsisMap) {
    const probed = probedSynopsisMap[game.id];
    if (typeof probed === 'string') {
      const cleanedProbed = extractCleanSynopsisText(probed);
      if (cleanedProbed.length >= 25 && !isGenericPlaceholderSynopsis(cleanedProbed, game.title)) {
        return true;
      }
    }
    if (probed === null) {
      return false;
    }
  }

  const candidates: Array<string | undefined> = [
    override?.shortDescription,
    override?.detailedDescription,
    game.shortDescription,
    game.detailedDescription,
    game.enrichedMetadata?.shortDescription,
    game.enrichedMetadata?.aboutTheGame,
    game.enrichedMetadata?.detailedDescription,
  ];

  if (game.steamAppId) {
    const cachedSteam = steamApi.getCachedMetadata(game.steamAppId);
    candidates.push(
      cachedSteam?.shortDescription,
      cachedSteam?.aboutTheGame,
      cachedSteam?.detailedDescription,
      (steamBlurbCache as Record<string, string>)[String(game.steamAppId)]
    );
  }

  if (game.platforms) {
    for (const p of game.platforms) {
      if (p.platformId === 'gog' && p.platformGameId) {
        const gogEntry = (gogEnrichedCache as Record<string, any>)[p.platformGameId];
        if (gogEntry) {
          candidates.push(
            gogEntry.shortDescription,
            gogEntry.description,
            gogEntry.aboutTheGame,
            gogEntry.detailedDescription
          );
        }
      }
    }
  }

  for (const str of candidates) {
    const cleaned = extractCleanSynopsisText(str);
    if (cleaned.length >= 25 && !isGenericPlaceholderSynopsis(cleaned, game.title)) {
      return true;
    }
  }

  return false;
}

export function hasDeveloperOrReleaseYear(
  game: CanonicalGame,
  override?: UserGameOverride
): boolean {
  const cachedSteam = game.steamAppId ? steamApi.getCachedMetadata(game.steamAppId) : undefined;
  const devLists = [
    override?.developers,
    game.developers,
    game.enrichedMetadata?.developers,
    cachedSteam?.developers,
  ];
  for (const list of devLists) {
    if (Array.isArray(list)) {
      const validDevs = list.filter(
        (d) => typeof d === 'string' && d.trim().length > 0 && d.trim() !== 'Unknown Developer'
      );
      if (validDevs.length > 0) return true;
    }
  }

  const dates = [
    override?.releaseDate,
    game.releaseDate,
    game.enrichedMetadata?.releaseDate,
    cachedSteam?.releaseDate,
  ];
  for (const d of dates) {
    if (typeof d === 'string' && d.trim().length > 0 && d.trim().toUpperCase() !== 'TBA') {
      return true;
    }
  }

  return false;
}

export function isSynopsisAlreadyProbed(
  game: CanonicalGame,
  override?: UserGameOverride,
  probedSynopsisMap?: Record<string, string | null>
): boolean {
  if (probedSynopsisMap && game.id in probedSynopsisMap) return true;
  if (override?.shortDescription || override?.detailedDescription) return true;
  if (game.enrichedMetadata) {
    if (
      /product_(?:description|feature)_\d+/i.test(
        game.enrichedMetadata.shortDescription ||
          game.enrichedMetadata.aboutTheGame ||
          game.enrichedMetadata.detailedDescription ||
          ''
      )
    ) {
      return false;
    }
    if (
      game.platforms?.some((p) => p.platformId === 'epic' || p.platformId === 'gog') &&
      isGenericPlaceholderSynopsis(game.enrichedMetadata.shortDescription, game.title) &&
      (game.enrichedMetadata.screenshots?.length || 0) <= 1 &&
      !isLikelyNonStoreOrTestBranchTitle(game.title)
    ) {
      return false;
    }
    return true;
  }
  if (
    Boolean(game.shortDescription && game.shortDescription.trim().length > 0) &&
    !/product_(?:description|feature)_\d+/i.test(game.shortDescription || '') &&
    (!isGenericPlaceholderSynopsis(game.shortDescription, game.title) ||
      !game.platforms?.some((p) => p.platformId === 'epic' || p.platformId === 'gog') ||
      isLikelyNonStoreOrTestBranchTitle(game.title))
  ) {
    return true;
  }
  if (isLikelyNonStoreOrTestBranchTitle(game.title)) return true;
  if (!game.steamAppId && !game.platforms?.some((p) => Boolean(p.platformGameId))) return true;
  if (!game.capsuleImage || !game.headerImage) return true;
  return false;
}

export function getGranularUnmatchedReasons(
  game: CanonicalGame,
  override?: UserGameOverride,
  probedSynopsisMap?: Record<string, string | null>
): UnmatchedDiagnosticReason[] {
  const reasons: UnmatchedDiagnosticReason[] = [];

  if (!game.capsuleImage && !game.headerImage) {
    reasons.push({
      code: 'missing_all_art',
      label: 'Missing All Artwork',
      tooltip: 'Missing both 2:3 vertical cover and 16:9 header image',
      colorClass: 'bg-rose-950/70 border-rose-500/40 text-rose-300',
    });
  } else if (!game.capsuleImage && Boolean(game.headerImage)) {
    reasons.push({
      code: 'missing_vertical_cover',
      label: 'Missing 2:3 Cover Art',
      tooltip: 'Has 16:9 header banner, but missing 2:3 vertical box art',
      colorClass: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
    });
  }

  const trimmedTitle = (game.title || '').trim();
  if (
    /^[a-z0-9_-]{6,}$/i.test(trimmedTitle) &&
    !trimmedTitle.includes(' ') &&
    (/\d/.test(trimmedTitle) || /[_-]/.test(trimmedTitle))
  ) {
    reasons.push({
      code: 'unresolved_codename',
      label: 'Unresolved Store Codename / Slug',
      tooltip: 'Title looks like a raw internal storefront identifier rather than a display name',
      colorClass: 'bg-purple-950/70 border-purple-500/40 text-purple-300',
    });
  }

  const alreadyProbed = isSynopsisAlreadyProbed(game, override, probedSynopsisMap);

  if (!hasGenuineStoreSynopsis(game, override, probedSynopsisMap) && alreadyProbed) {
    reasons.push({
      code: 'missing_synopsis',
      label: 'Missing Store Synopsis',
      tooltip: 'No store description or summary blurb scraped yet',
      colorClass: 'bg-orange-950/60 border-orange-500/35 text-orange-300',
    });
  }

  if (!hasDeveloperOrReleaseYear(game, override) && alreadyProbed) {
    reasons.push({
      code: 'missing_dev_year',
      label: 'Missing Developer & Release Year',
      tooltip: 'Missing developer studio and release year metadata',
      colorClass: 'bg-slate-800/80 border-slate-600/50 text-slate-300',
    });
  }

  return reasons;
}

function formatSuppressionBadge(entry: SuppressedCatalogEntry): {
  label: string;
  colorClass: string;
} {
  switch (entry.reasonCategory) {
    case 'user_hidden':
      return {
        label: entry.reason || 'Hidden by User',
        colorClass: 'bg-sky-950/70 border-sky-500/40 text-sky-300',
      };
    case 'unverified_entitlement':
      return {
        label: entry.reason || 'Cryptic Code / Unresolved Slug',
        colorClass: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
      };
    case 'non_game_filter':
      return {
        label: entry.reason || 'Non-Game / Engine / SDK',
        colorClass: 'bg-rose-950/70 border-rose-500/40 text-rose-300',
      };
    case 'score_suppressed':
      return {
        label: entry.reason || 'Score / Metadata Suppressed',
        colorClass: 'bg-purple-950/70 border-purple-500/40 text-purple-300',
      };
    case 'duplicate_conflict':
    default:
      return {
        label: entry.reason || 'Duplicate / Redundant Entry',
        colorClass: 'bg-slate-800 border-slate-600 text-slate-300',
      };
  }
}

function classifyAutoFilteredSubCategory(
  entry: SuppressedCatalogEntry
): Exclude<AutoFilteredSubFilter, 'all'> {
  const text = `${entry.rawTitle || ''} ${entry.reason || ''}`;
  if (
    /\b(soundtrack|ost\b|artbook|art\s*book|digital\s*goodies|goodie\s*pack|wallpaper|comic\s*book|score\b)\b/i.test(
      text
    )
  ) {
    return 'soundtrack';
  }
  if (/\b(prologue|playable\s*teaser|demo\b|trial\b)\b/i.test(text)) {
    return 'prologue';
  }
  if (/\b(dlc\b|expansion|season\s*pass|upgrade\s*pack|add-?on)\b/i.test(text)) {
    return 'dlc';
  }
  if (
    /\b(sdk\b|editor|tool|dedicated\s*server|redistributable|directx|vcredist|physx|authoring|mod\s*kit|server)\b/i.test(
      text
    )
  ) {
    return 'tool';
  }
  return 'beta';
}

export const LibraryMatchManagerModal: React.FC<LibraryMatchManagerModalProps> = ({
  isOpen,
  games,
  onClose,
  onFixMatchForGame,
  onResetOverride,
  onResetOverrideForGame,
  onInspectGame,
  onSelectGame,
  onHideGame,
  onUnhideEntry,
  onGameUpdated,
}) => {
  const handleInspect = onInspectGame || onSelectGame;
  const handleReset = onResetOverride || onResetOverrideForGame;

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [unmatchedSubFilter, setUnmatchedSubFilter] = useState<UnmatchedSubFilter>('all');
  const [autoFilteredSubFilter, setAutoFilteredSubFilter] = useState<AutoFilteredSubFilter>('all');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    unmatched: true,
    low_confidence: true,
    user_suppressed: true,
    suppressed: true,
    confirmed_suppressed: true,
    overrides: true,
    merged: true,
  });
  const [selectedNonGameIds, setSelectedNonGameIds] = useState<Set<string>>(new Set());
  const [overrideTick, setOverrideTick] = useState(0);
  const [probedSynopsisMap, setProbedSynopsisMap] = useState<Record<string, string | null>>({});
  const probingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    const handleUpdate = () => setOverrideTick((t) => t + 1);
    window.addEventListener('antigravity:user-override-updated', handleUpdate);
    window.addEventListener('antigravity:user-override-removed', handleUpdate);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleUpdate);
      window.removeEventListener('antigravity:user-override-removed', handleUpdate);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Background live storefront verification for unprobed games missing a store synopsis
  useEffect(() => {
    if (!isOpen) return;
    const candidates = games.filter(
      (game) =>
        !probingRef.current.has(game.id) &&
        !getUserOverrideForGame(game) &&
        !hasGenuineStoreSynopsis(game, undefined, probedSynopsisMap) &&
        !isSynopsisAlreadyProbed(game, undefined, probedSynopsisMap)
    );
    if (candidates.length === 0) return;

    let cancelled = false;
    const batch = candidates.slice(0, 4);
    for (const game of batch) {
      probingRef.current.add(game.id);
      const fetchPromise = game.steamAppId
        ? steamApi.fetchGameMetadata(game.steamAppId)
        : fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game);

      Promise.resolve(fetchPromise)
        .then((res) => {
          if (cancelled) return;
          const clean = extractCleanSynopsisText(
            res?.shortDescription || res?.aboutTheGame || res?.detailedDescription
          );
          if (clean.length >= 25 && !isGenericPlaceholderSynopsis(clean, game.title)) {
            setProbedSynopsisMap((prev) => ({ ...prev, [game.id]: clean }));
            const validDevs =
              res?.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
            onGameUpdated?.({
              ...game,
              shortDescription:
                res!.shortDescription &&
                !isGenericPlaceholderSynopsis(res!.shortDescription, game.title)
                  ? res!.shortDescription
                  : clean.slice(0, 280),
              detailedDescription:
                res!.aboutTheGame || res!.detailedDescription || game.detailedDescription,
              developers: validDevs.length > 0 ? validDevs : game.developers,
              releaseDate:
                res!.releaseDate && res!.releaseDate !== 'TBA'
                  ? res!.releaseDate
                  : game.releaseDate,
              enrichedMetadata: res!,
            });
          } else {
            setProbedSynopsisMap((prev) => ({ ...prev, [game.id]: null }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setProbedSynopsisMap((prev) => ({ ...prev, [game.id]: null }));
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, games, probedSynopsisMap, onGameUpdated]);

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleOpenExternalUrl = (url?: string) => {
    if (!url) return;
    const electronAPI = typeof window !== 'undefined' ? (window as any).electronAPI : undefined;
    if (electronAPI?.openExternal) {
      electronAPI.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();

  // 1. Unmatched Games (genuinely missing cover artwork or canonical storefront identity/synopsis)
  const unmatchedGames = useMemo(() => {
    return games
      .filter((game) => {
        const hasOverride = Boolean(getUserOverrideForGame(game));
        if (hasOverride) return false;

        const reasons = getGranularUnmatchedReasons(game, undefined, probedSynopsisMap);
        if (reasons.length === 0) return false;

        const hasFullArtwork = Boolean(game.capsuleImage && game.headerImage);
        const rawConf =
          typeof game.matchConfidence === 'number'
            ? game.matchConfidence <= 1
              ? game.matchConfidence * 100
              : game.matchConfidence
            : 0;
        const isLowConfCandidate =
          Boolean(game.needsMatchReview) || (rawConf > 0 && rawConf < 85);

        if (
          hasFullArtwork &&
          isLowConfCandidate &&
          !(
            reasons.some((r) => r.code === 'missing_synopsis') &&
            isLikelyNonStoreOrTestBranchTitle(game.title)
          )
        ) {
          return false;
        }

        if (!normalizedQuery) return true;
        return (
          matchesLooseSearchQuery(game.title, searchQuery) ||
          matchesLooseSearchQuery(game.originalStoreTitle, searchQuery) ||
          matchesLooseSearchQuery(game.id, searchQuery) ||
          game.platforms.some(
            (p) =>
              matchesLooseSearchQuery(p.platformId, searchQuery) ||
              matchesLooseSearchQuery(p.platformGameId, searchQuery) ||
              matchesLooseSearchQuery(p.originalTitle, searchQuery)
          )
        );
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [games, normalizedQuery, searchQuery, overrideTick, probedSynopsisMap]);

  const unmatchedWithReasons = useMemo(() => {
    return unmatchedGames.map((game) => ({
      game,
      reasons: getGranularUnmatchedReasons(game, undefined, probedSynopsisMap),
    }));
  }, [unmatchedGames, probedSynopsisMap]);

  const unmatchedSubCounts = useMemo(() => {
    let artwork = 0;
    let synopsis = 0;
    let dev_year = 0;
    for (const { reasons } of unmatchedWithReasons) {
      if (reasons.some((r) => r.code === 'missing_all_art' || r.code === 'missing_vertical_cover')) {
        artwork++;
      }
      if (reasons.some((r) => r.code === 'missing_synopsis')) {
        synopsis++;
      }
      if (reasons.some((r) => r.code === 'missing_dev_year')) {
        dev_year++;
      }
    }
    return {
      all: unmatchedGames.length,
      artwork,
      synopsis,
      dev_year,
    };
  }, [unmatchedGames.length, unmatchedWithReasons]);

  const filteredUnmatchedItems = useMemo(() => {
    if (unmatchedSubFilter === 'all') return unmatchedWithReasons;
    return unmatchedWithReasons.filter(({ reasons }) => {
      if (unmatchedSubFilter === 'artwork') {
        return reasons.some(
          (r) => r.code === 'missing_all_art' || r.code === 'missing_vertical_cover'
        );
      }
      if (unmatchedSubFilter === 'synopsis') {
        return reasons.some((r) => r.code === 'missing_synopsis');
      }
      if (unmatchedSubFilter === 'dev_year') {
        return reasons.some((r) => r.code === 'missing_dev_year');
      }
      return true;
    });
  }, [unmatchedWithReasons, unmatchedSubFilter]);

  // 2. Low-Confidence Automatic Matches
  const lowConfidenceGames = useMemo(() => {
    const unmatchedSet = new Set(unmatchedGames.map((g) => g.id));
    return games
      .filter((game) => {
        if (unmatchedSet.has(game.id)) return false;
        const hasOverride = Boolean(getUserOverrideForGame(game));
        if (hasOverride) return false;

        const rawConf =
          typeof game.matchConfidence === 'number'
            ? game.matchConfidence <= 1
              ? game.matchConfidence * 100
              : game.matchConfidence
            : undefined;

        const hasTitleShift =
          Boolean(game.originalStoreTitle) &&
          normalizeCanonicalTitle(game.originalStoreTitle!) !==
            normalizeCanonicalTitle(game.title);

        const isLowConf =
          Boolean(game.needsMatchReview) ||
          (typeof rawConf === 'number' && rawConf > 0 && rawConf < 85) ||
          hasTitleShift;

        if (!isLowConf) return false;

        if (!normalizedQuery) return true;
        return (
          matchesLooseSearchQuery(game.title, searchQuery) ||
          matchesLooseSearchQuery(game.originalStoreTitle, searchQuery) ||
          matchesLooseSearchQuery(game.id, searchQuery) ||
          game.platforms.some(
            (p) =>
              matchesLooseSearchQuery(p.platformId, searchQuery) ||
              matchesLooseSearchQuery(p.platformGameId, searchQuery) ||
              matchesLooseSearchQuery(p.originalTitle, searchQuery)
          )
        );
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [games, unmatchedGames, normalizedQuery, searchQuery, overrideTick]);

  // 3. Suppressed & Filtered Storefront Entries (split into User-Suppressed vs Auto-Filtered Non-Games)
  const suppressedEntries = useMemo(() => {
    const rawSuppressed = getSuppressedCatalogEntries();
    return rawSuppressed.filter((entry) => {
      const alreadyInCatalog = games.some(
        (g) =>
          g.id === entry.rawGame.id ||
          g.platforms.some(
            (p) =>
              p.platformId === entry.platformId &&
              p.platformGameId === entry.platformGameId
          )
      );
      if (alreadyInCatalog) return false;

      if (!normalizedQuery) return true;
      return (
        matchesLooseSearchQuery(entry.rawTitle, searchQuery) ||
        matchesLooseSearchQuery(entry.platformId, searchQuery) ||
        matchesLooseSearchQuery(entry.platformGameId, searchQuery) ||
        matchesLooseSearchQuery(entry.reason, searchQuery)
      );
    });
  }, [games, normalizedQuery, searchQuery, overrideTick]);

  const userSuppressedEntries = useMemo(
    () =>
      suppressedEntries
        .filter((entry) => entry.reasonCategory === 'user_hidden')
        .sort((a, b) => a.rawTitle.localeCompare(b.rawTitle)),
    [suppressedEntries]
  );

  const autoFilteredEntries = useMemo(
    () =>
      suppressedEntries
        .filter((entry) => entry.reasonCategory !== 'user_hidden')
        .sort((a, b) => a.rawTitle.localeCompare(b.rawTitle)),
    [suppressedEntries]
  );

  const unreviewedAutoFilteredEntries = useMemo(
    () =>
      autoFilteredEntries.filter(
        (entry) =>
          !isNonGameStorefrontEntryConfirmed(entry.platformId, entry.platformGameId, entry.id)
      ),
    [autoFilteredEntries, overrideTick]
  );

  const confirmedAutoFilteredEntries = useMemo(
    () =>
      autoFilteredEntries.filter((entry) =>
        isNonGameStorefrontEntryConfirmed(entry.platformId, entry.platformGameId, entry.id)
      ),
    [autoFilteredEntries, overrideTick]
  );

  const autoFilteredSubCounts = useMemo(() => {
    let beta = 0;
    let prologue = 0;
    let tool = 0;
    let soundtrack = 0;
    let dlc = 0;
    for (const entry of unreviewedAutoFilteredEntries) {
      const cat = classifyAutoFilteredSubCategory(entry);
      if (cat === 'beta') beta++;
      else if (cat === 'prologue') prologue++;
      else if (cat === 'tool') tool++;
      else if (cat === 'soundtrack') soundtrack++;
      else if (cat === 'dlc') dlc++;
    }
    return {
      all: unreviewedAutoFilteredEntries.length,
      beta,
      prologue,
      tool,
      soundtrack,
      dlc,
    };
  }, [unreviewedAutoFilteredEntries]);

  const filteredAutoFilteredEntries = useMemo(() => {
    if (autoFilteredSubFilter === 'all') return unreviewedAutoFilteredEntries;
    return unreviewedAutoFilteredEntries.filter(
      (entry) => classifyAutoFilteredSubCategory(entry) === autoFilteredSubFilter
    );
  }, [unreviewedAutoFilteredEntries, autoFilteredSubFilter]);

  const selectedVisibleEntries = useMemo(
    () => filteredAutoFilteredEntries.filter((entry) => selectedNonGameIds.has(entry.id)),
    [filteredAutoFilteredEntries, selectedNonGameIds]
  );

  // 4. Manual Matching Overrides
  const overrideItems = useMemo(() => {
    const allMap = loadUserOverrides();
    const seenGameIds = new Set<string>();
    const list: Array<{ override: UserGameOverride; matchedGame?: CanonicalGame }> = [];

    for (const ov of Object.values(allMap)) {
      if (!ov || !ov.gameId) continue;
      const dedupeKey =
        ov.platformId && ov.platformGameId
          ? `${ov.platformId}:${ov.platformGameId}`
          : ov.gameId;
      if (seenGameIds.has(dedupeKey) || seenGameIds.has(ov.gameId)) continue;
      seenGameIds.add(dedupeKey);
      seenGameIds.add(ov.gameId);

      const matchedGame = games.find(
        (g) =>
          g.id === ov.gameId ||
          (ov.platformId &&
            ov.platformGameId &&
            g.platforms.some(
              (p) =>
                p.platformId === ov.platformId &&
                String(p.platformGameId) === String(ov.platformGameId) &&
                (!ov.splitFromMerged || g.platforms.length === 1)
            ))
      );

      if (normalizedQuery) {
        const haystacks = [
          ov.title,
          ov.originalSourceTitle,
          ov.matchedStore,
          String(ov.matchedId || ''),
          ov.platformId,
          ov.platformGameId,
          matchedGame?.title,
          matchedGame?.originalStoreTitle,
          matchedGame?.id,
        ].filter(Boolean);

        if (!haystacks.some((h) => matchesLooseSearchQuery(String(h), searchQuery))) {
          continue;
        }
      }

      list.push({ override: ov, matchedGame });
    }

    return list.sort((a, b) =>
      (a.override.title || '').localeCompare(b.override.title || '')
    );
  }, [games, normalizedQuery, searchQuery, overrideTick]);

  // 5. Merged Multi-Storefront Listings
  const mergedGames = useMemo(() => {
    return games
      .filter((game) => {
        if (!game.platforms || game.platforms.length <= 1) return false;
        if (!normalizedQuery) return true;
        return (
          matchesLooseSearchQuery(game.title, searchQuery) ||
          matchesLooseSearchQuery(game.originalStoreTitle, searchQuery) ||
          matchesLooseSearchQuery(game.id, searchQuery) ||
          game.platforms.some(
            (p) =>
              matchesLooseSearchQuery(p.platformId, searchQuery) ||
              matchesLooseSearchQuery(p.platformGameId, searchQuery) ||
              matchesLooseSearchQuery(p.originalTitle, searchQuery)
          )
        );
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [games, normalizedQuery, searchQuery]);

  if (!isOpen) return null;

  const showUnmatched = activeTab === 'all' || activeTab === 'unmatched';
  const showLowConfidence = activeTab === 'all' || activeTab === 'low_confidence';
  const showUserSuppressed = activeTab === 'all' || activeTab === 'user_suppressed';
  const showSuppressed = activeTab === 'all' || activeTab === 'suppressed';
  const showOverrides = activeTab === 'all' || activeTab === 'overrides';
  const showMerged = activeTab === 'all' || activeTab === 'merged';

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/85 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-[#16202d] border border-[#2a475e] rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden text-slate-200 animate-in zoom-in-95 duration-150 select-none"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-match-manager-title"
      >
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#2a475e]/80 flex items-center justify-between bg-[#131c27]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center text-[#66c0f4] shadow-inner">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="library-match-manager-title"
                className="text-base font-bold text-white tracking-wide flex items-center gap-2"
              >
                <span>Library Match &amp; Overrides Studio</span>
                <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40">
                  Catalog Inspector
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Inspect unmatched &amp; low-confidence games, restore user-suppressed or auto-filtered non-game entries, manage manual overrides, and split or customize multi-storefront merges
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-[#1b2838] transition-colors cursor-pointer"
            title="Close Studio (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Studio Tab Bar & Search Toolbar */}
        <div className="px-6 pt-3 pb-0 border-b border-[#2a475e]/80 bg-[#141d28] flex flex-col gap-2.5">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-2.5">
            {/* Docked Studio Tab Bar */}
            <div
              role="tablist"
              aria-label="Library Match Studio Tabs"
              className="flex items-end gap-1 flex-wrap"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'all'}
                data-tab-id="all"
                onClick={() => setActiveTab('all')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'all'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-[#66c0f4] shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <span>All Sections</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'unmatched'}
                data-tab-id="unmatched"
                onClick={() => setActiveTab('unmatched')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'unmatched'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-amber-400 shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>Unmatched ({unmatchedGames.length})</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'low_confidence'}
                data-tab-id="low_confidence"
                onClick={() => setActiveTab('low_confidence')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'low_confidence'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-orange-400 shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5 text-orange-400" />
                <span>Low-Confidence ({lowConfidenceGames.length})</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'user_suppressed'}
                data-tab-id="user_suppressed"
                onClick={() => setActiveTab('user_suppressed')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'user_suppressed'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-indigo-400 shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <EyeOff className="w-3.5 h-3.5 text-indigo-400" />
                <span>User-Suppressed ({userSuppressedEntries.length})</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'suppressed'}
                data-tab-id="suppressed"
                onClick={() => setActiveTab('suppressed')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'suppressed'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-rose-400 shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <EyeOff className="w-3.5 h-3.5 text-rose-400" />
                <span>Auto-Filtered Non-Games ({unreviewedAutoFilteredEntries.length})</span>
                {confirmedAutoFilteredEntries.length > 0 && (
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                    title={`${confirmedAutoFilteredEntries.length} confirmed non-game entries`}
                  >
                    ✓ {confirmedAutoFilteredEntries.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'overrides'}
                data-tab-id="overrides"
                onClick={() => setActiveTab('overrides')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'overrides'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-sky-400 shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <Wand className="w-3.5 h-3.5 text-sky-400" />
                <span>Manual Overrides ({overrideItems.length})</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'merged'}
                data-tab-id="merged"
                onClick={() => setActiveTab('merged')}
                className={`px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'merged'
                    ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-emerald-400 shadow-sm'
                    : 'bg-[#121a24]/70 text-slate-400 hover:text-slate-200 hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
                }`}
              >
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                <span>Merged Multi-Store ({mergedGames.length})</span>
              </button>
            </div>

            {/* Search Input */}
            <div className="relative w-full lg:w-64 pb-2">
              <Search className="w-4 h-4 absolute left-3 top-[15px] -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by title, storefront, or ID..."
                className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#131c27] border border-[#2a475e] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#66c0f4] transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-[15px] -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Main Scrollable Accordion Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          {/* SECTION 1: UNMATCHED GAMES */}
          {showUnmatched && (
            <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
              <button
                type="button"
                onClick={() => toggleSection('unmatched')}
                className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  {expandedSections.unmatched ? (
                    <ChevronDown className="w-4 h-4 text-amber-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-amber-400" />
                  )}
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Unmatched Games
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    {unmatchedGames.length}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 hidden sm:inline">
                  Games missing cover artwork or canonical storefront identity
                </span>
              </button>

              {expandedSections.unmatched && (
                <div className="p-4 space-y-3">
                  {unmatchedGames.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap pb-2.5 border-b border-[#2a475e]/50">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mr-1">
                        Filter by Reason:
                      </span>
                      <button
                        type="button"
                        onClick={() => setUnmatchedSubFilter('all')}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
                          unmatchedSubFilter === 'all'
                            ? 'bg-amber-400 text-slate-950 shadow'
                            : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                        }`}
                      >
                        All ({unmatchedSubCounts.all})
                      </button>
                      <button
                        type="button"
                        onClick={() => setUnmatchedSubFilter('artwork')}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
                          unmatchedSubFilter === 'artwork'
                            ? 'bg-rose-400 text-slate-950 shadow'
                            : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                        }`}
                      >
                        Missing Artwork ({unmatchedSubCounts.artwork})
                      </button>
                      <button
                        type="button"
                        onClick={() => setUnmatchedSubFilter('synopsis')}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
                          unmatchedSubFilter === 'synopsis'
                            ? 'bg-orange-400 text-slate-950 shadow'
                            : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                        }`}
                      >
                        Missing Synopsis ({unmatchedSubCounts.synopsis})
                      </button>
                      <button
                        type="button"
                        onClick={() => setUnmatchedSubFilter('dev_year')}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
                          unmatchedSubFilter === 'dev_year'
                            ? 'bg-sky-400 text-slate-950 shadow'
                            : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                        }`}
                      >
                        Missing Dev / Year ({unmatchedSubCounts.dev_year})
                      </button>
                    </div>
                  )}

                  {filteredUnmatchedItems.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400 flex flex-col items-center gap-1.5">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                      <span>
                        {unmatchedGames.length === 0
                          ? 'All active library games have cover artwork and canonical storefront identity!'
                          : 'No unmatched games match this specific reason filter.'}
                      </span>
                    </div>
                  ) : (
                    <div className="divide-y divide-[#2a475e]/40">
                      {filteredUnmatchedItems.map(({ game, reasons }) => (
                        <div
                          key={game.id}
                          className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 aspect-[2/3] rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
                              {game.capsuleImage || game.headerImage ? (
                                <img
                                  src={game.capsuleImage || game.headerImage}
                                  alt={game.title}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <ImageIcon className="w-4 h-4 text-slate-600" />
                              )}
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-sm font-bold text-white truncate mr-0.5">
                                  {game.title}
                                </span>
                                {reasons.map((reason) => (
                                  <span
                                    key={reason.code}
                                    title={reason.tooltip}
                                    className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${reason.colorClass}`}
                                  >
                                    {reason.label}
                                  </span>
                                ))}
                              </div>

                              <div className="flex items-center gap-2 flex-wrap mt-1">
                                {game.platforms.map((p) => (
                                  <span
                                    key={`${p.platformId}-${p.platformGameId}`}
                                    className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-[#16202d] border border-[#2a475e] px-2 py-0.5 rounded"
                                  >
                                    <StorefrontIcon
                                      storefrontId={p.platformId as StorefrontId}
                                      className="w-3 h-3"
                                    />
                                    <span>{getStorefrontDisplayName(p.platformId)}</span>
                                    {p.originalTitle && p.originalTitle !== game.title && (
                                      <span className="text-slate-400">
                                        • &ldquo;{p.originalTitle}&rdquo;
                                      </span>
                                    )}
                                    <span className="text-[10px] font-mono text-slate-400">
                                      (ID: {p.platformGameId})
                                    </span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {handleInspect && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleInspect(game);
                                  onClose();
                                }}
                                className="px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>Inspect</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onFixMatchForGame(game)}
                              className="px-3 py-1.5 rounded bg-[#66c0f4] hover:bg-[#4da6db] text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                            >
                              <Wand className="w-3.5 h-3.5" />
                              <span>Fix Match</span>
                            </button>
                            {onHideGame && (
                              <button
                                type="button"
                                onClick={() => onHideGame(game)}
                                className="px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                                title="Hide / suppress this game from your active library"
                              >
                                <EyeOff className="w-3.5 h-3.5" />
                                <span>Hide</span>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SECTION 2: LOW-CONFIDENCE AUTOMATIC MATCHES */}
          {showLowConfidence && (
            <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
              <button
                type="button"
                onClick={() => toggleSection('low_confidence')}
                className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  {expandedSections.low_confidence ? (
                    <ChevronDown className="w-4 h-4 text-orange-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-orange-400" />
                  )}
                  <ShieldAlert className="w-4 h-4 text-orange-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Low-Confidence Automatic Matches
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-500/20 text-orange-300 border border-orange-500/40">
                    {lowConfidenceGames.length}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 hidden sm:inline">
                  Heuristic matches or title shifts that may benefit from manual verification
                </span>
              </button>

              {expandedSections.low_confidence && (
                <div className="p-4 divide-y divide-[#2a475e]/40">
                  {lowConfidenceGames.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400 flex flex-col items-center gap-1.5">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                      <span>No low-confidence automatic matches requiring verification!</span>
                    </div>
                  ) : (
                    lowConfidenceGames.map((game) => {
                      const rawConf =
                        typeof game.matchConfidence === 'number'
                          ? Math.round(
                              game.matchConfidence <= 1
                                ? game.matchConfidence * 100
                                : game.matchConfidence
                            )
                          : undefined;
                      const sourceTitle =
                        game.originalStoreTitle ||
                        game.platforms[0]?.originalTitle ||
                        game.title;

                      return (
                        <div
                          key={game.id}
                          className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 aspect-[2/3] rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
                              {game.capsuleImage || game.headerImage ? (
                                <img
                                  src={game.capsuleImage || game.headerImage}
                                  alt={game.title}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <ImageIcon className="w-4 h-4 text-slate-600" />
                              )}
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-bold text-white truncate">
                                  {game.title}
                                </span>
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-950/70 border border-orange-500/40 text-orange-300">
                                  {typeof rawConf === 'number' && rawConf > 0
                                    ? `${rawConf}% Confidence`
                                    : 'Heuristic Title Match'}
                                </span>
                              </div>

                              <div className="text-xs text-slate-300 mt-1 flex items-center gap-1.5 flex-wrap">
                                <span className="text-slate-400">Store Scrape:</span>
                                <span className="font-medium text-white">
                                  &ldquo;{sourceTitle}&rdquo;
                                </span>
                                <ArrowRight className="w-3 h-3 text-orange-400 shrink-0" />
                                <span className="text-slate-400">Matched As:</span>
                                <span className="font-semibold text-orange-200">
                                  &ldquo;{game.title}&rdquo;
                                </span>
                              </div>

                              <div className="flex items-center gap-2 flex-wrap mt-1">
                                {game.platforms.map((p) => (
                                  <span
                                    key={`${p.platformId}-${p.platformGameId}`}
                                    className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-[#16202d] border border-[#2a475e] px-2 py-0.5 rounded"
                                  >
                                    <StorefrontIcon
                                      storefrontId={p.platformId as StorefrontId}
                                      className="w-3 h-3"
                                    />
                                    <span>{getStorefrontDisplayName(p.platformId)}</span>
                                    <span className="text-[10px] font-mono text-slate-400">
                                      (ID: {p.platformGameId})
                                    </span>
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {handleInspect && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleInspect(game);
                                  onClose();
                                }}
                                className="px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>Inspect</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onFixMatchForGame(game)}
                              className="px-3 py-1.5 rounded bg-[#66c0f4] hover:bg-[#4da6db] text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                            >
                              <Wand className="w-3.5 h-3.5" />
                              <span>Verify / Fix Match</span>
                            </button>
                            {onHideGame && (
                              <button
                                type="button"
                                onClick={() => onHideGame(game)}
                                className="px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                                title="Hide / suppress this game from your active library"
                              >
                                <EyeOff className="w-3.5 h-3.5" />
                                <span>Hide</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          {/* SECTION 3A: USER-SUPPRESSED TITLES */}
          {showUserSuppressed && (
            <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
              <button
                type="button"
                onClick={() => toggleSection('user_suppressed')}
                className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  {expandedSections.user_suppressed ? (
                    <ChevronDown className="w-4 h-4 text-indigo-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-indigo-400" />
                  )}
                  <EyeOff className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    User-Suppressed Titles
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    {userSuppressedEntries.length}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 hidden sm:inline">
                  Games and storefront entries you manually chose to hide from your library
                </span>
              </button>

              {expandedSections.user_suppressed && (
                <div className="p-4 divide-y divide-[#2a475e]/40">
                  {userSuppressedEntries.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      No user-suppressed titles found. Right-click any game card or use the game menu to suppress titles you want hidden.
                    </div>
                  ) : (
                    userSuppressedEntries.map((entry) => {
                      const badge = formatSuppressionBadge(entry);
                      return (
                        <div
                          key={entry.id}
                          className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[11px] font-semibold text-sky-300">
                                <StorefrontIcon
                                  storefrontId={entry.platformId as StorefrontId}
                                  className="w-3 h-3"
                                />
                                <span>{getStorefrontDisplayName(entry.platformId)}</span>
                              </span>

                              <span className="text-sm font-bold text-white truncate">
                                &ldquo;{entry.rawTitle}&rdquo;
                              </span>

                              <span
                                className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${badge.colorClass}`}
                              >
                                {badge.label}
                              </span>
                            </div>

                            <div className="text-[11px] text-slate-400 font-mono">
                              Platform Entitlement ID: {entry.platformGameId}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 flex-wrap">
                            {onUnhideEntry && (
                              <button
                                type="button"
                                onClick={() => onUnhideEntry(entry)}
                                className="px-3 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/50 text-[#66c0f4] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                                title="Unhide and restore this entry directly back to your library"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Unhide / Restore</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onFixMatchForGame(entry.rawGame)}
                              className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                              title="Manually match this suppressed storefront entitlement to a real game and restore it to your library"
                            >
                              <Wand className="w-3.5 h-3.5" />
                              <span>Match &amp; Restore to Library</span>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          {/* SECTION 3B: SUPPRESSED & FILTERED STOREFRONT ENTRIES (AUTO-FILTERED NON-GAMES — TWO-ACCORDION REVIEW WORKFLOW) */}
          {showSuppressed && (
            <>
              {/* ACCORDION 1: PENDING REVIEW */}
              <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
                <button
                  type="button"
                  onClick={() => toggleSection('suppressed')}
                  className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {expandedSections.suppressed ? (
                      <ChevronDown className="w-4 h-4 text-rose-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-rose-400" />
                    )}
                    <EyeOff className="w-4 h-4 text-rose-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Suppressed &amp; Filtered Storefront Entries
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                      {unreviewedAutoFilteredEntries.length} Pending Review
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400 hidden sm:inline">
                    New &amp; unreviewed auto-filtered betas, prologues, tools/SDKs, soundtracks, and DLCs — confirm items you agree should stay suppressed
                  </span>
                </button>

                {expandedSections.suppressed && (
                  <div>
                    {/* Category Sub-Filter Bar */}
                    <div className="px-4 py-2.5 bg-[#16202d]/90 border-b border-[#2a475e]/50 flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1">
                          Category:
                        </span>
                        <button
                          type="button"
                          onClick={() => setAutoFilteredSubFilter('all')}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            autoFilteredSubFilter === 'all'
                              ? 'bg-rose-400 text-slate-950'
                              : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                          }`}
                        >
                          All Non-Games ({autoFilteredSubCounts.all})
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoFilteredSubFilter('beta')}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            autoFilteredSubFilter === 'beta'
                              ? 'bg-amber-400 text-slate-950'
                              : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                          }`}
                        >
                          Betas / Test / Legacy ({autoFilteredSubCounts.beta})
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoFilteredSubFilter('prologue')}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            autoFilteredSubFilter === 'prologue'
                              ? 'bg-orange-400 text-slate-950'
                              : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                          }`}
                        >
                          Prologues / Demos ({autoFilteredSubCounts.prologue})
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoFilteredSubFilter('tool')}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            autoFilteredSubFilter === 'tool'
                              ? 'bg-rose-400 text-slate-950'
                              : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                          }`}
                        >
                          Tools / SDKs / Servers ({autoFilteredSubCounts.tool})
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoFilteredSubFilter('soundtrack')}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            autoFilteredSubFilter === 'soundtrack'
                              ? 'bg-purple-400 text-slate-950'
                              : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                          }`}
                        >
                          Soundtracks / Goodies ({autoFilteredSubCounts.soundtrack})
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoFilteredSubFilter('dlc')}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                            autoFilteredSubFilter === 'dlc'
                              ? 'bg-sky-400 text-slate-950'
                              : 'bg-[#1b2838] text-slate-300 hover:text-white border border-[#2a475e]'
                          }`}
                        >
                          DLC / Add-ons ({autoFilteredSubCounts.dlc})
                        </button>
                      </div>

                      {/* Batch Selection & Confirmation Toolbar */}
                      {filteredAutoFilteredEntries.length > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => {
                              const allVisibleSelected =
                                selectedVisibleEntries.length === filteredAutoFilteredEntries.length;
                              if (allVisibleSelected) {
                                setSelectedNonGameIds((prev) => {
                                  const next = new Set(prev);
                                  for (const e of filteredAutoFilteredEntries) {
                                    next.delete(e.id);
                                  }
                                  return next;
                                });
                              } else {
                                setSelectedNonGameIds((prev) => {
                                  const next = new Set(prev);
                                  for (const e of filteredAutoFilteredEntries) {
                                    next.add(e.id);
                                  }
                                  return next;
                                });
                              }
                            }}
                            className="px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-slate-300 hover:text-white transition-colors cursor-pointer"
                          >
                            {selectedVisibleEntries.length === filteredAutoFilteredEntries.length
                              ? 'Clear Selection'
                              : 'Select All Shown'}
                          </button>

                          {selectedVisibleEntries.length > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                confirmMultipleNonGameStorefrontEntries(
                                  selectedVisibleEntries.map((e) => ({
                                    platformId: e.platformId,
                                    platformGameId: e.platformGameId,
                                    gameId: e.id,
                                  }))
                                );
                                setSelectedNonGameIds((prev) => {
                                  const next = new Set(prev);
                                  for (const e of selectedVisibleEntries) {
                                    next.delete(e.id);
                                  }
                                  return next;
                                });
                              }}
                              className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer shadow"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Confirm Selected ({selectedVisibleEntries.length})</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              confirmMultipleNonGameStorefrontEntries(
                                filteredAutoFilteredEntries.map((e) => ({
                                  platformId: e.platformId,
                                  platformGameId: e.platformGameId,
                                  gameId: e.id,
                                }))
                              );
                              setSelectedNonGameIds(new Set());
                            }}
                            className="px-2.5 py-1 rounded bg-teal-950/80 hover:bg-teal-900 border border-teal-500/40 text-teal-300 hover:text-white text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Confirm All Shown ({filteredAutoFilteredEntries.length})</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="p-4 divide-y divide-[#2a475e]/40">
                      {filteredAutoFilteredEntries.length === 0 ? (
                        <div className="py-6 text-center text-xs text-slate-400 flex flex-col items-center gap-1.5">
                          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                          <span>
                            {unreviewedAutoFilteredEntries.length === 0 &&
                            confirmedAutoFilteredEntries.length > 0
                              ? 'All auto-filtered storefront entries have been reviewed and confirmed! Any newly discovered non-game entries on future library syncs will appear here for review.'
                              : 'No auto-filtered storefront entries found matching your filter.'}
                          </span>
                        </div>
                      ) : (
                        filteredAutoFilteredEntries.map((entry) => {
                          const badge = formatSuppressionBadge(entry);
                          const isChecked = selectedNonGameIds.has(entry.id);
                          return (
                            <div
                              key={entry.id}
                              className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                            >
                              <div className="flex items-start gap-3 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedNonGameIds((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(entry.id)) {
                                        next.delete(entry.id);
                                      } else {
                                        next.add(entry.id);
                                      }
                                      return next;
                                    });
                                  }}
                                  aria-label={`Select ${entry.rawTitle}`}
                                  className="mt-1 w-4 h-4 rounded border-[#2a475e] bg-[#16202d] text-emerald-500 focus:ring-0 cursor-pointer shrink-0"
                                />

                                <div className="min-w-0 space-y-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[11px] font-semibold text-sky-300">
                                      <StorefrontIcon
                                        storefrontId={entry.platformId as StorefrontId}
                                        className="w-3 h-3"
                                      />
                                      <span>{getStorefrontDisplayName(entry.platformId)}</span>
                                    </span>

                                    <span className="text-sm font-bold text-white truncate">
                                      &ldquo;{entry.rawTitle}&rdquo;
                                    </span>

                                    <span
                                      className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${badge.colorClass}`}
                                    >
                                      {badge.label}
                                    </span>
                                  </div>

                                  <div className="text-[11px] text-slate-400 font-mono">
                                    Platform Entitlement ID: {entry.platformGameId}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => {
                                    confirmNonGameStorefrontEntry(
                                      entry.platformId,
                                      entry.platformGameId,
                                      entry.id
                                    );
                                    setSelectedNonGameIds((prev) => {
                                      if (!prev.has(entry.id)) return prev;
                                      const next = new Set(prev);
                                      next.delete(entry.id);
                                      return next;
                                    });
                                  }}
                                  className="px-3 py-1.5 rounded bg-teal-950/70 hover:bg-teal-900 border border-teal-500/40 text-teal-300 hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                                  title="Confirm this entry is a non-game item and move it to Reviewed & Confirmed Non-Games"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>Confirm Suppressed</span>
                                </button>
                                {onUnhideEntry && (
                                  <button
                                    type="button"
                                    onClick={() => onUnhideEntry(entry)}
                                    className="px-3 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/50 text-[#66c0f4] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                                    title="Restore and include this non-game storefront entry directly in your active library"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span>Include in Library</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => onFixMatchForGame(entry.rawGame)}
                                  className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                                  title="Manually match this suppressed storefront entitlement to a real game and restore it to your library"
                                >
                                  <Wand className="w-3.5 h-3.5" />
                                  <span>Match &amp; Restore to Library</span>
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ACCORDION 2: REVIEWED & CONFIRMED NON-GAMES */}
              <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
                <button
                  type="button"
                  onClick={() => toggleSection('confirmed_suppressed')}
                  className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {expandedSections.confirmed_suppressed ? (
                      <ChevronDown className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-emerald-400" />
                    )}
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Reviewed &amp; Confirmed Non-Games
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      {confirmedAutoFilteredEntries.length} Confirmed
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400 hidden sm:inline">
                    Auto-filtered storefront entries you have reviewed and confirmed to keep suppressed
                  </span>
                </button>

                {expandedSections.confirmed_suppressed && (
                  <div className="p-4 divide-y divide-[#2a475e]/40">
                    {confirmedAutoFilteredEntries.length === 0 ? (
                      <div className="py-6 text-center text-xs text-slate-400">
                        No confirmed non-game entries yet. Confirm items above once you&apos;ve verified they should stay suppressed — future library syncs will only show newly added unreviewed items in Pending Review.
                      </div>
                    ) : (
                      confirmedAutoFilteredEntries.map((entry) => {
                        const badge = formatSuppressionBadge(entry);
                        return (
                          <div
                            key={entry.id}
                            className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                          >
                            <div className="min-w-0 space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[11px] font-semibold text-sky-300">
                                  <StorefrontIcon
                                    storefrontId={entry.platformId as StorefrontId}
                                    className="w-3 h-3"
                                  />
                                  <span>{getStorefrontDisplayName(entry.platformId)}</span>
                                </span>

                                <span className="text-sm font-bold text-white truncate">
                                  &ldquo;{entry.rawTitle}&rdquo;
                                </span>

                                <span
                                  className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${badge.colorClass}`}
                                >
                                  {badge.label}
                                </span>

                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold bg-emerald-950/70 border-emerald-500/40 text-emerald-300">
                                  <CheckCircle2 className="w-3 h-3" />
                                  <span>Confirmed Suppressed</span>
                                </span>
                              </div>

                              <div className="text-[11px] text-slate-400 font-mono">
                                Platform Entitlement ID: {entry.platformGameId}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0 flex-wrap">
                              <button
                                type="button"
                                onClick={() =>
                                  unconfirmNonGameStorefrontEntry(
                                    entry.platformId,
                                    entry.platformGameId,
                                    entry.id
                                  )
                                }
                                className="px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                                title="Move this entry back to Pending Review"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Move to Pending Review</span>
                              </button>
                              {onUnhideEntry && (
                                <button
                                  type="button"
                                  onClick={() => onUnhideEntry(entry)}
                                  className="px-3 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/50 text-[#66c0f4] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                                  title="Restore and include this non-game storefront entry directly in your active library"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                  <span>Include in Library</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onFixMatchForGame(entry.rawGame)}
                                className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                                title="Manually match this suppressed storefront entitlement to a real game and restore it to your library"
                              >
                                <Wand className="w-3.5 h-3.5" />
                                <span>Match &amp; Restore to Library</span>
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* SECTION 4: MANUAL MATCHING OVERRIDES */}
          {showOverrides && (
            <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
              <button
                type="button"
                onClick={() => toggleSection('overrides')}
                className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  {expandedSections.overrides ? (
                    <ChevronDown className="w-4 h-4 text-[#66c0f4]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[#66c0f4]" />
                  )}
                  <Wand className="w-4 h-4 text-[#66c0f4]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Manual Matching Overrides (Source &rarr; Target)
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40">
                    {overrideItems.length}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 hidden sm:inline">
                  User-configured metadata routes, split entries, custom cover art, and review score overrides
                </span>
              </button>

              {expandedSections.overrides && (
                <div className="p-4 divide-y divide-[#2a475e]/40">
                  {overrideItems.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      No manual matching overrides have been configured yet.
                    </div>
                  ) : (
                    overrideItems.map(({ override, matchedGame }) => {
                      const sourcePlat =
                        matchedGame?.platforms.find(
                          (p) =>
                            p.platformId ===
                            (override.originalSourcePlatformId || override.platformId)
                        ) || matchedGame?.platforms[0];

                      const sourcePlatformId =
                        override.originalSourcePlatformId ||
                        override.platformId ||
                        sourcePlat?.platformId ||
                        'steam';

                      const sourceRawTitle =
                        override.originalSourceTitle ||
                        sourcePlat?.originalTitle ||
                        matchedGame?.originalStoreTitle ||
                        matchedGame?.title ||
                        override.title;

                      const sourcePlatformGameId =
                        override.platformGameId || sourcePlat?.platformGameId;

                      const targetUrl = buildCandidateStoreUrl({
                        source: override.matchedStore || 'steam',
                        title: override.title || sourceRawTitle || '',
                        steamAppId: override.steamAppId ?? undefined,
                        gogId:
                          override.matchedStore === 'gog' ? override.matchedId : undefined,
                        epicSlug:
                          override.matchedStore === 'epic'
                            ? String(override.matchedId)
                            : undefined,
                        igdbId: override.igdbId,
                      });

                      return (
                        <div
                          key={override.gameId}
                          className="py-3.5 first:pt-0 last:pb-0 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3 min-w-0 flex-1">
                            {/* Left: Original Source Entitlement */}
                            <div className="p-2.5 rounded-lg bg-[#16202d] border border-[#2a475e] flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                                  Original Storefront Entitlement
                                </span>
                                {override.splitFromMerged && (
                                  <span className="px-1.5 py-0.5 rounded bg-purple-950/80 border border-purple-500/40 text-[9px] font-bold uppercase text-purple-300">
                                    Split Entry
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-bold text-sky-300">
                                  <StorefrontIcon
                                    storefrontId={sourcePlatformId as StorefrontId}
                                    className="w-3 h-3"
                                  />
                                  <span>{getStorefrontDisplayName(sourcePlatformId)}</span>
                                </span>
                                <span className="text-xs font-bold text-white truncate">
                                  &ldquo;{sourceRawTitle}&rdquo;
                                </span>
                              </div>
                              {sourcePlatformGameId && (
                                <div className="text-[10px] font-mono text-slate-400 mt-1">
                                  Platform ID: {sourcePlatformGameId}
                                </div>
                              )}
                            </div>

                            <ArrowRight className="w-4 h-4 text-amber-400 shrink-0 self-center hidden sm:block" />

                            {/* Right: Active Target Override */}
                            <div className="p-2.5 rounded-lg bg-[#1b2838]/80 border border-amber-500/40 flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold">
                                  Routed Target Metadata
                                </span>
                                {targetUrl && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenExternalUrl(targetUrl)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
                                    title={`Open ${override.matchedStore.toUpperCase()} store page in browser`}
                                  >
                                    <ExternalLink className="w-2.5 h-2.5" />
                                    <span>Store Page</span>
                                  </button>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-[10px] font-bold uppercase text-amber-300">
                                  {override.matchedStore}
                                </span>
                                <span className="text-xs font-bold text-amber-100 truncate">
                                  &ldquo;{override.title}&rdquo;
                                </span>
                              </div>
                              <div className="text-[10px] font-mono text-slate-400 mt-1">
                                Target ID: {override.matchedId}
                                {override.steamAppId ? ` • Steam AppID: ${override.steamAppId}` : ''}
                              </div>
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2 shrink-0">
                            {matchedGame && (
                              <button
                                type="button"
                                onClick={() => onFixMatchForGame(matchedGame)}
                                className="px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-[#66c0f4] hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <Wand className="w-3.5 h-3.5" />
                                <span>Edit Match</span>
                              </button>
                            )}
                            {handleReset && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleReset(matchedGame?.id || override.gameId)
                                }
                                className="px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                                title="Remove manual override and revert to automatic storefront matching"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Reset</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          {/* SECTION 5: MERGED MULTI-STOREFRONT LISTINGS */}
          {showMerged && (
            <div className="border border-[#2a475e]/80 rounded-lg overflow-hidden bg-[#131c27]/70">
              <button
                type="button"
                onClick={() => toggleSection('merged')}
                className="w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  {expandedSections.merged ? (
                    <ChevronDown className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-emerald-400" />
                  )}
                  <Layers className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Merged Multi-Storefront Listings
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    {mergedGames.length}
                  </span>
                </div>
                <span className="text-[11px] text-slate-400 hidden sm:inline">
                  Fix, split, or hide individual storefront entries inside merged canonical listings
                </span>
              </button>

              {expandedSections.merged && (
                <div className="p-3.5 space-y-2">
                  {mergedGames.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      No multi-storefront merged games found matching your filter.
                    </div>
                  ) : (
                    mergedGames.map((game) => (
                      <div
                        key={game.id}
                        className="px-3 py-2.5 rounded-lg bg-[#16202d]/90 border border-[#2a475e]/40 hover:border-emerald-500/30 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-2.5"
                      >
                        {/* Left / Center section: Cover, Title, Storefronts Badge, and Inline Storefront Entitlement Chips */}
                        <div className="flex items-center gap-3 min-w-0 flex-1 flex-wrap">
                          <div className="w-8 h-11 rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
                            {game.capsuleImage || game.headerImage ? (
                              <img
                                src={game.capsuleImage || game.headerImage}
                                alt={game.title}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ImageIcon className="w-3.5 h-3.5 text-slate-600" />
                            )}
                          </div>

                          <div className="flex items-center gap-2 min-w-0 flex-wrap flex-1">
                            <span className="text-sm font-semibold text-white truncate">
                              {game.title}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 shrink-0">
                              {game.platforms.length} Storefronts
                            </span>

                            {/* Inline Compact Storefront Entitlement Chips */}
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {game.platforms.map((p) => {
                                const isPlatInstalled =
                                  launcherService.isGameInstalled(game, p.platformId) ||
                                  Boolean(p.installed);
                                const rawPlatTitle =
                                  p.originalTitle || game.originalStoreTitle || game.title;

                                return (
                                  <div
                                    key={`${p.platformId}-${p.platformGameId}`}
                                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#0e141b]/90 border border-[#2a475e]/60 text-[11px]"
                                  >
                                    <span
                                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                        isPlatInstalled ? 'bg-emerald-400' : 'bg-slate-600'
                                      }`}
                                      title={isPlatInstalled ? 'Installed' : 'Not Installed'}
                                    />
                                    <span className="sr-only">
                                      {isPlatInstalled ? 'Installed' : 'Not Installed'}
                                    </span>

                                    <StorefrontIcon
                                      storefrontId={p.platformId as StorefrontId}
                                      className="w-3 h-3 text-sky-400 shrink-0"
                                    />
                                    <span className="font-semibold text-white">
                                      {getStorefrontDisplayName(p.platformId)}
                                    </span>

                                    {rawPlatTitle && rawPlatTitle !== game.title && (
                                      <span className="text-slate-300 truncate max-w-[160px]">
                                        • &ldquo;{rawPlatTitle}&rdquo;
                                      </span>
                                    )}

                                    <span className="text-[10px] font-mono text-slate-400">
                                      #{p.platformGameId}
                                    </span>

                                    <span className="h-3 w-px bg-[#2a475e]/70 mx-0.5 shrink-0" />

                                    <button
                                      type="button"
                                      onClick={() => {
                                        const singleStoreGame: CanonicalGame & {
                                          isSplittingFromMerged?: boolean;
                                        } = {
                                          ...game,
                                          id: `${p.platformId}-${p.platformGameId}`,
                                          title: rawPlatTitle,
                                          sortTitle: rawPlatTitle,
                                          originalStoreTitle: rawPlatTitle,
                                          steamAppId:
                                            p.platformId === 'steam' &&
                                            !isNaN(Number(p.platformGameId))
                                              ? Number(p.platformGameId)
                                              : undefined,
                                          platforms: [{ ...p, originalTitle: rawPlatTitle }],
                                          isSplittingFromMerged: true,
                                        };
                                        onFixMatchForGame(singleStoreGame);
                                      }}
                                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#66c0f4] hover:bg-[#66c0f4] hover:text-slate-950 transition-colors flex items-center gap-1 cursor-pointer"
                                      title={`Split this ${getStorefrontDisplayName(p.platformId)} entry from "${game.title}" and match it to its own game`}
                                    >
                                      <Wand className="w-2.5 h-2.5" />
                                      <span>Fix / Split Entry</span>
                                    </button>

                                    {onHideGame && (
                                      <button
                                        type="button"
                                        onClick={() => onHideGame(game, p.platformId)}
                                        className="px-1.5 py-0.5 rounded text-[10px] font-medium text-rose-300 hover:bg-rose-900/80 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
                                        title={`Hide / suppress only the ${getStorefrontDisplayName(p.platformId)} entry from this merged listing`}
                                      >
                                        <EyeOff className="w-2.5 h-2.5" />
                                        <span>Hide Entry</span>
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>

                        {/* Right section: Compact Inspect and Edit Merged Match buttons */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {handleInspect && (
                            <button
                              type="button"
                              onClick={() => {
                                handleInspect(game);
                                onClose();
                              }}
                              className="px-2 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-slate-200 hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <Eye className="w-3 h-3" />
                              <span>Inspect</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onFixMatchForGame(game)}
                            className="px-2 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-[#66c0f4] hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
                          >
                            <Wand className="w-3 h-3" />
                            <span>Edit Merged Match</span>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-[#2a475e]/80 bg-[#131c27] flex items-center justify-between text-xs text-slate-400">
          <span>
            Active Catalog: <strong className="text-white">{games.length}</strong> canonical titles •{' '}
            <strong className="text-amber-300">{unmatchedGames.length}</strong> unmatched •{' '}
            <strong className="text-orange-300">{lowConfidenceGames.length}</strong> low-confidence •{' '}
            <strong className="text-sky-300">{overrideItems.length}</strong> manual overrides •{' '}
            <strong className="text-indigo-300">{userSuppressedEntries.length}</strong> user-suppressed •{' '}
            <strong className="text-rose-300">{unreviewedAutoFilteredEntries.length}</strong> pending non-games •{' '}
            <strong className="text-emerald-300">{confirmedAutoFilteredEntries.length}</strong> confirmed non-games
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-slate-200 hover:text-white font-semibold transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
