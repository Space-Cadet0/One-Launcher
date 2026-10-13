import React, { useState } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import { PlatformBadges } from './PlatformBadges';
import { StorefrontIcon } from '../Common/StorefrontIcon';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../contracts/platform';
import {
  Play,
  Download,
  HardDrive,
  Clock,
  Calendar,
  Trophy,
  CheckCircle2,
  Cloud,
  Bookmark,
  Award,
  ChevronDown,
  X,
  ExternalLink,
  Sparkles,
  Wand,
  ChevronRight,
} from 'lucide-react';
import { getOpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { parseTimestampMs, formatLastPlayedDate, formatPlaytime } from '../../utils/dateUtils';
import {
  getKnownAchievementTotal,
  getKnownEpicAchievements,
  getKnownGogAchievements,
  getKnownSteamAchievements,
} from '../../services/storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../../services/storage/achievementReconciliation';
import { steamAchievementsService } from '../../services/steam/steamAchievementsService';
import { ActiveGameFilter } from '../../contracts/filter';
import { GameCollection } from '../../contracts/collection';
import { loadCollections } from '../../services/storage/collectionStorage';

// Known install sizes for popular games
const KNOWN_INSTALL_SIZES: Record<number, string> = {
  3010850: '90 GB',
  1091500: '70 GB',
  292030: '50 GB',
  1086940: '150 GB',
  228280: '4.5 GB',
  257350: '5.2 GB',
  1174180: '150 GB',
  814380: '25 GB',
  374320: '25 GB',
  211420: '8 GB',
  782330: '80 GB',
  379720: '55 GB',
  1190460: '80 GB',
  400: '5 GB',
  620: '8 GB',
  220: '7 GB',
  70: '1 GB',
  22380: '10 GB',
  377160: '30 GB',
  412020: '59 GB',
  286690: '10 GB',
  287390: '10 GB',
  632470: '22 GB',
  435150: '60 GB',
  1687950: '41 GB',
  883710: '26 GB',
  952060: '45 GB',
  2050650: '67 GB',
  480490: '42 GB',
  287700: '28 GB',
  17460: '12 GB',
  24980: '15 GB',
  1238020: '15 GB',
  1151640: '67 GB',
  268500: '45 GB',
};

interface SteamLibraryActionBarProps {
  game: CanonicalGame;
  metadata?: SteamEnrichedMetadata | null;
  collections?: GameCollection[];
  onManageCollections?: () => void;
  onToggleInstallStatus?: () => void;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  connectedStorefronts?: StorefrontId[];
  onFixMatch?: () => void;
  onViewAchievements?: (storefrontId?: StorefrontId) => void;
}

export const SteamLibraryActionBar: React.FC<SteamLibraryActionBarProps> = ({
  game,
  metadata,
  collections,
  onManageCollections,
  onToggleInstallStatus,
  onApplyFilter,
  connectedStorefronts,
  onFixMatch,
  onViewAchievements,
}) => {
  const [showAchievementPopover, setShowAchievementPopover] = useState(false);
  const isInstalled = game.platforms.some((p) => p.installed);
  const primaryPlatform = game.platforms.find((p) => p.platformId === 'steam') || game.platforms[0];

  // Determine if game belongs to at least 1 user collection
  const allCollections = collections || loadCollections();
  const targetGameIds = [game.id];
  if (game.steamAppId) {
    targetGameIds.push(`steam-${game.steamAppId}`, String(game.steamAppId));
  }
  const isInCollection = allCollections.some((col) =>
    col.gameIds.some((id) => targetGameIds.includes(id))
  );

  const handleInstallClick = () => {
    if (game.steamAppId) {
      window.location.href = `steam://install/${game.steamAppId}`;
    }
  };

  const handlePlayClick = () => {
    if (game.steamAppId) {
      window.location.href = `steam://run/${game.steamAppId}`;
    }
  };

  // Playtime calculation (Total aggregated across all owned storefronts)
  const totalPlaytimeMinutes = game.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);
  const platformsWithPlaytime = game.platforms.filter((p) => (p.playtimeMinutes || 0) > 0);

  // Last played formatting across all owned storefronts
  const formatLastPlayed = () => {
    let latestMs: number | null = null;
    let latestRaw: string | number | undefined = undefined;

    for (const p of game.platforms) {
      const ms = parseTimestampMs(p.lastPlayed);
      if (ms !== null && (latestMs === null || ms > latestMs)) {
        latestMs = ms;
        latestRaw = p.lastPlayed;
      }
    }

    return formatLastPlayedDate(latestRaw || primaryPlatform?.lastPlayed);
  };

  // Space Required extraction
  const getSpaceRequired = () => {
    if (game.steamAppId && KNOWN_INSTALL_SIZES[game.steamAppId]) {
      return KNOWN_INSTALL_SIZES[game.steamAppId];
    }
    // Extract from system requirements text
    const reqText = metadata?.systemRequirements?.minimum || metadata?.pcRequirementsHtml || '';
    const match = reqText.match(/(\d+(?:\.\d+)?)\s*(GB|MB)\s*(?:available|free|storage|space)/i);
    if (match) {
      return `${match[1]} ${match[2].toUpperCase()}`;
    }
    // Generic fallback based on tags
    const isBig = game.tags.some((t) => ['Open World', 'RPG', 'Action'].includes(t));
    return isBig ? '65 GB' : '15 GB';
  };

  // Multi-store achievements evaluation
  const targetSteamAppId = game.steamAppId || metadata?.appId;
  const knownTotal = getKnownAchievementTotal(targetSteamAppId, game.id, game.title);
  const steamData = targetSteamAppId
    ? (steamAchievementsService.getCachedAchievements(targetSteamAppId) || getKnownSteamAchievements(targetSteamAppId, game.title))
    : undefined;

  // If verified Steam client data or metadata has achievement count, it takes precedence
  const effectiveTotal =
    steamData?.total ??
    metadata?.achievements?.total ??
    knownTotal ??
    (metadata && !metadata.categories?.some((c) => c.id === 22) ? 0 : 0);

  const platformAchievements: {
    platformId: StorefrontId;
    platformName: string;
    unlocked: number;
    total: number;
    percentage: number;
    gamerscore?: { earned: number; total: number };
    xp?: { earned: number; total: number };
    isMastered: boolean;
  }[] = game.platforms.map((p) => {
    const reg = STOREFRONT_REGISTRY[p.platformId];
    const name = reg?.name || p.platformId;

    let pAchievements = p.achievements;

    // Check store-specific live scan and verified cache using authority reconciliation
    if (p.platformId === 'steam' && targetSteamAppId) {
      const sData = steamData || (pAchievements ? { unlocked: pAchievements.unlocked, total: pAchievements.total, percentage: pAchievements.percentage } : undefined);
      if (sData) {
        pAchievements = reconcileAchievementSummaries(pAchievements, sData, {
          title: game.title,
          appId: targetSteamAppId,
          store: 'steam',
        }) || pAchievements;
      }
    } else if (p.platformId === 'gog') {
      const gogKnown = getKnownGogAchievements(p.platformGameId || game.id, game.title);
      if (gogKnown) {
        pAchievements = reconcileAchievementSummaries(pAchievements, gogKnown, {
          title: game.title,
          store: 'gog',
        }) || pAchievements;
      }
    } else if (p.platformId === 'epic') {
      const epicKnown = getKnownEpicAchievements(game.id, game.title);
      if (epicKnown) {
        pAchievements = reconcileAchievementSummaries(pAchievements, epicKnown, {
          title: game.title,
          store: 'epic',
        }) || pAchievements;
      }
    }

    let platTotal = effectiveTotal ?? 0;
    if (pAchievements && pAchievements.total > 0) {
      platTotal = pAchievements.total;
    } else {
      const known = getKnownAchievementTotal(targetSteamAppId, p.platformGameId || game.id, game.title);
      if (known && known > 0) platTotal = known;
    }

    const unlocked = pAchievements?.unlocked ?? 0;
    const customXp: { earned: number; total: number } | undefined = pAchievements?.xp;

    const percentage = platTotal > 0 ? Math.round((unlocked / platTotal) * 100) : 0;
    const isMastered = (platTotal > 0 && unlocked >= platTotal) || !!pAchievements?.isMastered;

    const res: any = {
      platformId: p.platformId,
      platformName: name,
      unlocked,
      total: platTotal,
      percentage,
      isMastered,
      hasConflict: pAchievements?.hasConflict,
      conflictDetails: pAchievements?.conflictDetails,
    };

    if (p.platformId === 'epic' && platTotal > 0) {
      res.xp = customXp || { earned: Math.round((percentage / 100) * 1000), total: 1000 };
    }
    if (p.platformId === 'xbox' && platTotal > 0) {
      res.gamerscore = pAchievements?.gamerscore || { earned: Math.round((percentage / 100) * 1000), total: 1000 };
    }

    return res;
  });

  const hasAchievements = platformAchievements.some((p) => p.total > 0);

  // Best platform achievement by highest percentage, then unlocked count, then total
  const bestAchievement = platformAchievements.reduce((best, cur) => {
    if (cur.percentage > best.percentage) return cur;
    if (cur.percentage === best.percentage) {
      if (cur.unlocked > best.unlocked) return cur;
      if (cur.total > best.total) return cur;
      if (cur.platformId === 'steam') return cur;
    }
    return best;
  }, platformAchievements[0] || {
    platformId: 'steam',
    platformName: 'Steam',
    unlocked: 0,
    total: 0,
    percentage: 0,
    isMastered: false,
  });

  const isAnyMastered = platformAchievements.some((p) => p.isMastered || p.percentage >= 100);

  // Critic consensus rating
  const targetSteamId = game.steamAppId || steamMatcher.matchGameToSteamInstant(game.title);
  const openCritic = getOpenCriticData(
    targetSteamId || undefined,
    game.title,
    game.reviewSummary?.positivePercent
  );
  const ocColors = openCritic ? getTierColor(openCritic.tier) : null;

  return (
    <div className="bg-[#101822] border border-[#2a475e] rounded p-3.5 xl:p-4 shadow-xl text-steam-text select-none">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 xl:gap-5">
        {/* Left: Action Button & Library Status */}
        <div className="flex items-center gap-2 xl:gap-3 shrink-0 flex-nowrap py-0.5">
          {/* Main Action Button (Play / Install) */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isInstalled ? (
              <button
                onClick={handlePlayClick}
                className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-4.5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0"
                style={{
                  background: 'linear-gradient(to right, #75b022 5%, #588a1b 95%)',
                  boxShadow: '0 0 16px rgba(91, 163, 43, 0.45)',
                }}
                title={game.steamAppId ? `Launch game via steam://run/${game.steamAppId}` : 'Launch game'}
              >
                <Play className="w-4 h-4 fill-white" />
                <span>Play</span>
              </button>
            ) : (
              <button
                onClick={handleInstallClick}
                className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-4.5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0"
                style={{
                  background: 'linear-gradient(to right, #214b6b 0%, #123049 100%)',
                  border: '1px solid #3878a8',
                  boxShadow: '0 0 12px rgba(33, 75, 107, 0.4)',
                }}
                title={game.steamAppId ? `Open Steam client to install (${game.steamAppId})` : 'Install game'}
              >
                <Download className="w-4 h-4 text-sky-400" />
                <span>Install</span>
              </button>
            )}

            {/* Quick manual installed toggle */}
            {onToggleInstallStatus && (
              <button
                onClick={onToggleInstallStatus}
                className="p-2 xl:p-2.5 rounded text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80 transition-colors shrink-0"
                title={
                  isInstalled
                    ? 'Manually mark as uninstalled (cloud only)'
                    : 'Manually mark as installed (locally available)'
                }
              >
                <HardDrive className={`w-4 h-4 ${isInstalled ? 'text-emerald-400' : 'text-steam-subtext'}`} />
              </button>
            )}
          </div>

          {/* Collections Shortcut Button */}
          {onManageCollections && (
            <button
              onClick={onManageCollections}
              className={`p-2 xl:p-2.5 rounded transition-all shrink-0 ${
                isInCollection
                  ? 'bg-[#1b2b3d] text-steam-accent border border-steam-accent/60 shadow-[0_0_8px_rgba(102,192,244,0.3)] hover:brightness-110'
                  : 'text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80'
              }`}
              title={isInCollection ? 'In Collection (click to manage)' : 'Add to Collections'}
            >
              <Bookmark
                className={`w-4 h-4 transition-transform active:scale-95 ${
                  isInCollection
                    ? 'text-steam-accent fill-steam-accent drop-shadow-[0_0_4px_rgba(102,192,244,0.6)]'
                    : 'text-steam-subtext hover:text-white'
                }`}
              />
            </button>
          )}

          {/* Fix Match & Metadata Shortcut Button */}
          {onFixMatch && (
            <button
              onClick={onFixMatch}
              className="p-2 xl:p-2.5 rounded text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80 transition-colors shrink-0 group"
              title="Fix match, cover poster & scraped metadata..."
            >
              <Wand className="w-4 h-4 text-steam-subtext group-hover:text-[#66c0f4] transition-colors" />
            </button>
          )}

          {/* Library Status Indicator */}
          <div className="flex flex-col justify-center border-l border-[#2a475e]/60 pl-2.5 xl:pl-3.5 py-0.5 shrink-0 min-w-max">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white whitespace-nowrap">
              {isInstalled ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="text-emerald-400">Ready to Play</span>
                </>
              ) : (
                <>
                  <Cloud className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="text-sky-300">In Library</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1 whitespace-nowrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#8f98a0] whitespace-nowrap">Owned on:</span>
              <PlatformBadges
                platforms={game.platforms}
                game={game}
                steamAppId={metadata?.appId || game.steamAppId}
                connectedStorefronts={connectedStorefronts}
                iconOnly
              />
            </div>
          </div>
        </div>

        {/* Right: Steam Library Stats Matrix */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:flex lg:items-start lg:justify-between gap-3 sm:gap-4 lg:gap-3 xl:gap-5 2xl:gap-6 border-t lg:border-t-0 lg:border-l border-[#2a475e]/60 pt-3 lg:pt-0 pl-0 lg:pl-3.5 xl:pl-6 flex-1 min-w-0">
          {/* Play Time */}
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8f98a0] flex items-center gap-1 whitespace-nowrap">
              <Clock className="w-3 h-3 text-sky-400" />
              Play Time
            </span>
            <span className="text-sm font-bold text-white mt-0.5">
              {formatPlaytime(totalPlaytimeMinutes)}
            </span>
            {/* Multi-store breakdown pills if owned on >1 storefront or multiple have playtime */}
            {platformsWithPlaytime.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {platformsWithPlaytime.map((plat) => {
                  const reg = STOREFRONT_REGISTRY[plat.platformId];
                  return (
                    <span
                      key={plat.platformId}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[#16202d] border border-steam-border/60 text-[#c6d4df]"
                      title={`${reg?.name || plat.platformId}: ${formatPlaytime(plat.playtimeMinutes || 0)}`}
                    >
                      <StorefrontIcon storefrontId={plat.platformId} className="w-2.5 h-2.5 text-steam-accent" />
                      <span>{reg?.name || plat.platformId}: {formatPlaytime(plat.playtimeMinutes || 0)}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Last Played */}
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8f98a0] flex items-center gap-1 whitespace-nowrap">
              <Calendar className="w-3 h-3 text-sky-400" />
              Last Played
            </span>
            <span className="text-sm font-bold text-white mt-0.5">
              {formatLastPlayed()}
            </span>
          </div>

          {/* Space Required */}
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8f98a0] flex items-center gap-1 whitespace-nowrap">
              <HardDrive className="w-3 h-3 text-sky-400" />
              Space Required
            </span>
            <span className="text-sm font-bold text-white mt-0.5">
              {getSpaceRequired()}
            </span>
          </div>

          {/* Achievements */}
          <div
            onClick={() => {
              if (onViewAchievements && hasAchievements && bestAchievement.total > 0) {
                onViewAchievements(bestAchievement.platformId);
              } else if (platformAchievements.length > 1) {
                setShowAchievementPopover((prev) => !prev);
              }
            }}
            className={`flex flex-col min-w-0 ${
              (hasAchievements && bestAchievement.total > 0) || platformAchievements.length > 1
                ? 'cursor-pointer group select-none'
                : ''
            }`}
            title={
              hasAchievements && bestAchievement.total > 0
                ? 'Click to view full achievements browser, icons & unlock dates'
                : platformAchievements.length > 1
                ? 'Click to view per-store achievements breakdown'
                : undefined
            }
          >
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 transition-colors ${
                  platformAchievements.length > 1
                    ? showAchievementPopover
                      ? 'text-steam-accent'
                      : 'text-[#8f98a0] group-hover:text-white'
                    : 'text-[#8f98a0]'
                }`}
              >
                {isAnyMastered ? (
                  <span
                    className="relative inline-flex items-center justify-center w-3 h-3 shrink-0"
                    title="Mastered (100% Achievements Unlocked)"
                  >
                    <Trophy className="w-3 h-3 text-amber-300 fill-amber-400 drop-shadow-[0_0_4px_rgba(251,191,36,0.95)]" />
                    <Sparkles className="w-2 h-2 text-yellow-200 absolute -top-1 -right-1 drop-shadow-[0_0_2px_rgba(255,255,255,0.9)] animate-pulse pointer-events-none" />
                  </span>
                ) : (
                  <Trophy
                    className={`w-3 h-3 shrink-0 ${
                      hasAchievements && bestAchievement.total > 0
                        ? 'text-amber-400'
                        : 'text-[#8f98a0]'
                    }`}
                  />
                )}
                <span>Achievements</span>
                {platformAchievements.length > 1 && (
                  <ChevronDown
                    className={`w-2.5 h-2.5 transition-transform duration-200 text-sky-400/80 group-hover:text-sky-300 ${
                      showAchievementPopover ? 'rotate-180 text-steam-accent' : ''
                    }`}
                  />
                )}
              </span>
            </div>

            {hasAchievements && bestAchievement.total > 0 ? (
              <>
                <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap">
                  <span
                    className={`text-sm font-bold text-white transition-colors ${
                      platformAchievements.length > 1
                        ? 'group-hover:text-steam-accent'
                        : ''
                    }`}
                  >
                    {bestAchievement.unlocked} / {bestAchievement.total}
                  </span>
                  <span
                    className={`text-[11px] ${
                      isAnyMastered ? 'text-amber-300 font-semibold' : 'text-[#8f98a0]'
                    }`}
                  >
                    ({bestAchievement.percentage}%)
                  </span>
                </div>

                {/* Miniature progress bar */}
                <div className="w-full bg-[#1b2838] h-1 rounded-full mt-1 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isAnyMastered
                        ? 'bg-gradient-to-r from-amber-400 to-yellow-300'
                        : 'bg-amber-400'
                    }`}
                    style={{ width: `${Math.min(100, bestAchievement.percentage)}%` }}
                  />
                </div>
              </>
            ) : (
              <span className="text-sm font-medium text-steam-subtext mt-0.5 whitespace-nowrap">
                No Achievements
              </span>
            )}
          </div>

          {/* Critic Score */}
          {openCritic && ocColors && (
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8f98a0] flex items-center gap-1 whitespace-nowrap">
                <Award className="w-3 h-3 text-purple-400" />
                {openCritic.source === 'metacritic'
                  ? 'Metacritic'
                  : openCritic.source === 'metacritic_user'
                  ? 'MC User Score'
                  : openCritic.source === 'steam'
                  ? 'Steam Community'
                  : openCritic.source === 'gog'
                  ? 'GOG Rating'
                  : openCritic.source === 'epic'
                  ? 'Epic Rating'
                  : 'OpenCritic'}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap">
                <span className={`text-sm font-black ${ocColors.accentText}`}>
                  {openCritic.source === 'metacritic_user' && openCritic.userScoreRaw !== undefined
                    ? `${openCritic.userScoreRaw}/10`
                    : (openCritic.source === 'gog' || openCritic.source === 'epic') && openCritic.starRatingRaw !== undefined
                    ? `${openCritic.starRatingRaw}★ (${openCritic.score})`
                    : openCritic.score}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({
                      type: 'rating',
                      label: 'Rating',
                      value: openCritic.tier,
                    })
                  }
                  className={`text-[10px] font-bold px-1.5 py-0.2 rounded border hover:underline hover:brightness-125 cursor-pointer ${ocColors.badgeBg} ${ocColors.badgeBorder} ${ocColors.badgeText}`}
                  title={`Filter library for ${openCritic.tier} games`}
                >
                  {openCritic.tier}
                </button>
                <a
                  href={openCritic.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                      window.electronAPI.openExternal(openCritic.url);
                    } else {
                      window.open(openCritic.url, '_blank', 'noreferrer,noopener');
                    }
                  }}
                  className="text-steam-subtext hover:text-white transition-colors cursor-pointer"
                  title={
                    openCritic.source === 'metacritic'
                      ? `View ${game.title} on Metacritic.com`
                      : openCritic.source === 'metacritic_user'
                      ? `View ${game.title} User Reviews on Metacritic.com`
                      : openCritic.source === 'steam'
                      ? `View ${game.title} on Steam Store`
                      : openCritic.source === 'gog'
                      ? `View ${game.title} on GOG.com`
                      : openCritic.source === 'epic'
                      ? `View ${game.title} on Epic Games Store`
                      : `View ${game.title} on OpenCritic.com`
                  }
                >
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <span className="text-[10px] text-[#8f98a0] mt-0.5 truncate">
                {openCritic.percentRecommended !== undefined
                  ? `${openCritic.percentRecommended}% ${openCritic.source === 'steam' ? 'Positive' : 'Recommended'}`
                  : (openCritic.source === 'gog' || openCritic.source === 'epic') && openCritic.starRatingRaw !== undefined
                  ? `${openCritic.starRatingRaw}/5 Stars (${openCritic.numReviews ? openCritic.numReviews.toLocaleString() : ''} ratings)`
                  : `${openCritic.tier} Consensus`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Multi-Store Achievements Drawer (Expandable Inline to Avoid Obscuring Content Below) */}
      {showAchievementPopover && platformAchievements.length > 1 && (
        <div className="mt-4 pt-3.5 border-t border-[#2a475e]/70 animate-in fade-in duration-150">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-bold text-white tracking-wide">
                Storefront Achievements Breakdown
              </span>
              <span className="text-[10px] text-steam-subtext font-normal">
                ({platformAchievements.length} connected storefronts)
              </span>
            </div>
            <div className="flex items-center gap-2">
              {onViewAchievements && (
                <button
                  type="button"
                  onClick={() => onViewAchievements()}
                  className="px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#25394e] text-xs font-semibold text-steam-accent border border-steam-accent/40 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  <span>View All Achievements...</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowAchievementPopover(false)}
                className="text-steam-subtext hover:text-white px-2 py-0.5 rounded hover:bg-white/10 text-xs flex items-center gap-1 cursor-pointer transition-colors"
                title="Close storefront achievements"
              >
                <span className="text-[11px]">Close</span>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {platformAchievements.map((plat) => (
              <div key={plat.platformId} className="bg-[#141d28] p-3 rounded border border-steam-border/50 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center gap-1.5 font-semibold text-white">
                      <StorefrontIcon storefrontId={plat.platformId} className="w-3.5 h-3.5 text-steam-accent" />
                      <span>{plat.platformName}</span>
                    </div>
                    {plat.isMastered && (
                      <span className="text-[10px] font-black text-amber-300 bg-amber-400/15 border border-amber-400/40 px-1.5 py-0.2 rounded">
                        ★ Mastered
                      </span>
                    )}
                  </div>

                  <div className="flex items-baseline justify-between mt-1">
                    {plat.total > 0 ? (
                      <>
                        <span className="text-sm font-bold text-white">
                          {plat.unlocked} <span className="text-xs text-steam-subtext font-normal">/ {plat.total}</span>
                        </span>
                        <span className="text-xs font-semibold text-amber-400">
                          {plat.percentage}%
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-steam-subtext">No Achievements</span>
                    )}
                  </div>

                  {/* Extra Gamerscore or XP badges if applicable */}
                  {plat.total > 0 && plat.gamerscore && (
                    <div className="text-[10px] text-emerald-400 font-mono mt-1">
                      Gamerscore: {plat.gamerscore.earned} / {plat.gamerscore.total} G
                    </div>
                  )}
                  {plat.total > 0 && plat.xp && (
                    <div className="text-[10px] text-sky-400 font-mono mt-1">
                      XP: {plat.xp.earned} / {plat.xp.total} XP
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                {plat.total > 0 && (
                  <div className="w-full bg-[#1b2838] h-1.5 rounded-full mt-2.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        plat.isMastered || plat.percentage >= 100
                          ? 'bg-gradient-to-r from-amber-400 to-yellow-300'
                          : 'bg-amber-400'
                      }`}
                      style={{ width: `${Math.min(100, plat.percentage)}%` }}
                    />
                  </div>
                )}

                {/* View Achievements Button */}
                {plat.total > 0 && onViewAchievements && (
                  <button
                    type="button"
                    onClick={() => onViewAchievements(plat.platformId)}
                    className="mt-3 w-full py-1.5 px-2 rounded bg-[#1b2838] hover:bg-[#25394e] text-xs font-semibold text-steam-accent flex items-center justify-center gap-1 transition-colors cursor-pointer border border-[#2a475e]/60"
                  >
                    <span>View Achievements</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
