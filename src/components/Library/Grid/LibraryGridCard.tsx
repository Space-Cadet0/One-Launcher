import React from 'react';
import { Activity, CheckCircle2 } from 'lucide-react';
import { CanonicalGame } from '../../../contracts/game';
import { OpenCriticData } from '../../../contracts/critic';
import { UserGameOverride } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { LibraryFilterIndex } from '../../../services/filter/libraryFilterIndex';
import { launcherService } from '../../../services/launcher/launcherService';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import { getTierColor } from '../../../services/opencritic/openCritic';
import { getNativeOsPlatforms } from '../../../services/platform/nativeOsService';
import { getUserOverrideForGame } from '../../../services/storage/userOverrideStorage';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { NativeOsBadges } from '../../Common/NativeOsBadges';
import { GameCardCover } from './GameCardCover';
import {
  formatPlaytime,
  getReleaseYear,
  GridSortOption,
} from './gridCoverUtils';

export interface RenderLibraryGridCardArgs {
  game: CanonicalGame;
  idx: number;
  sortBy: GridSortOption;
  userOverridesMap: Record<string, UserGameOverride>;
  coverOverrides: Record<string, string | null>;
  connectedSet: Set<StorefrontId>;
  effectiveFilterIndex: LibraryFilterIndex;
  contextMenuOpenRef: React.MutableRefObject<boolean>;
  onDismissContextMenu: () => void;
  onSelectGame: (game: CanonicalGame) => void;
  onNeedCoverLookup: (game: CanonicalGame) => void;
  onMouseEnter: (game: CanonicalGame, e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (game: CanonicalGame, e: React.MouseEvent) => void;
  resolveGameCriticData: (game: CanonicalGame) => OpenCriticData | null;
}

export function renderLibraryGridCard({
  game,
  idx,
  sortBy,
  userOverridesMap,
  coverOverrides,
  connectedSet,
  effectiveFilterIndex,
  contextMenuOpenRef,
  onDismissContextMenu,
  onSelectGame,
  onNeedCoverLookup,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
  resolveGameCriticData,
}: RenderLibraryGridCardArgs): React.ReactElement {
  const isRunning = launcherService.isGameRunning(game.id);
  const isInstalled =
    game.platforms.some((p) => p.installed) || launcherService.isGameInstalled(game);
  const cardUserOverride =
    userOverridesMap[game.id] || getUserOverrideForGame(game, userOverridesMap);
  const cardOverrideCover = cardUserOverride?.capsuleImage || coverOverrides[game.id];

  const xboxPlat = game.platforms.find((p) => p.platformId === 'xbox');
  const isXboxExpiredUnplayable = Boolean(
    xboxPlat && xboxPlat.subscriptionExpired && xboxPlat.ownershipType === 'subscription'
  );
  const isXboxActiveGamePass = Boolean(
    xboxPlat &&
      !xboxPlat.subscriptionExpired &&
      (xboxPlat.ownershipType === 'subscription' ||
        xboxPlat.ownershipType === 'owned_and_subscription')
  );
  const isXboxLeavingSoon = Boolean(isXboxActiveGamePass && xboxPlat?.isLeavingSoon);
  const hasTopLeftBadge =
    isRunning || isInstalled || isXboxExpiredUnplayable || isXboxActiveGamePass;

  const oc = resolveGameCriticData(game);
  const cardReleaseYear =
    effectiveFilterIndex.entriesById.get(game.id)?.releaseYear ||
    getReleaseYear(game, steamMatcher.getEffectiveSteamAppId(game));
  const playtimeLabel = formatPlaytime(game);

  return (
    <div
      key={game.id}
      data-game-id={game.id}
      onMouseEnter={(e) => onMouseEnter(game, e)}
      onMouseLeave={onMouseLeave}
      onContextMenu={(e) => onContextMenu(game, e)}
      className={`${idx >= 28 ? 'cv-card cv-card-deferred perf-card-contain' : 'cv-card'} group relative flex flex-col rounded-md overflow-hidden bg-[#16202d] border border-steam-border/70 hover:border-steam-accent transition-colors duration-150 cursor-pointer shadow-md hover:shadow-2xl`}
    >
      <button
        type="button"
        aria-label={game.title}
        onClick={(e) => {
          if (contextMenuOpenRef.current) {
            onDismissContextMenu();
            return;
          }
          if (e.button === 0 && !e.ctrlKey) {
            onSelectGame(game);
          }
        }}
        className="card-stretched-trigger z-30 rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent focus-visible:ring-inset"
      />

      {/* 2:3 Portrait Capsule Viewport */}
      <div
        className="relative aspect-[2/3] w-full bg-black/60 overflow-hidden flex items-center justify-center"
        onContextMenu={(e) => onContextMenu(game, e)}
      >
        <GameCardCover
          game={game}
          overrideCoverUrl={cardOverrideCover}
          userOverride={cardUserOverride}
          onNeedCoverLookup={onNeedCoverLookup}
          cardIndex={idx}
        />

        {/* Gradient bottom shadow to ensure overlays pop */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 pointer-events-none" />

        {/* Top Header: Running, Installed, or Xbox Game Pass status badge */}
        {hasTopLeftBadge && (
          <div className="absolute top-2 left-2 z-20 flex flex-wrap items-center gap-1 pointer-events-none max-w-[70%]">
            {isRunning ? (
              <div className="flex items-center gap-1 bg-amber-950/95 border border-amber-400/70 text-amber-200 text-[10px] font-bold px-1.5 py-0.5 rounded shadow">
                <Activity
                  aria-hidden="true"
                  className="w-2.5 h-2.5 text-amber-300 animate-pulse"
                />
                <span>Running</span>
              </div>
            ) : isInstalled ? (
              <div className="flex items-center gap-1 bg-emerald-950/90 border border-emerald-500/60 text-emerald-200 text-[10px] font-semibold px-1.5 py-0.5 rounded shadow">
                <CheckCircle2 aria-hidden="true" className="w-2.5 h-2.5" />
                <span>Ready</span>
              </div>
            ) : null}
            {isXboxExpiredUnplayable ? (
              <div className="bg-rose-950/95 border border-rose-500/60 text-rose-200 text-[9px] font-bold uppercase tracking-tight px-1.5 py-0.5 rounded shadow">
                Expired
              </div>
            ) : isXboxLeavingSoon ? (
              <div className="bg-amber-950/95 border border-amber-500/60 text-amber-200 text-[9px] font-bold uppercase tracking-tight px-1.5 py-0.5 rounded shadow">
                Leaving Soon
              </div>
            ) : isXboxActiveGamePass ? (
              <div className="bg-emerald-950/95 border border-emerald-500/60 text-emerald-200 text-[9px] font-extrabold uppercase tracking-tight px-1.5 py-0.5 rounded shadow">
                GP
              </div>
            ) : null}
          </div>
        )}

        {/* Top-Right: Critic Score Pill */}
        {oc &&
          (() => {
            const ocColors = getTierColor(oc.tier);
            const isMetacritic = oc.source === 'metacritic';
            const isMetacriticUser = oc.source === 'metacritic_user';
            const isSteam = oc.source === 'steam';
            const isGog = oc.source === 'gog';
            const isEpic = oc.source === 'epic';
            const isXbox =
              String(oc.id || '').startsWith('xbox-') ||
              Boolean(oc.url && oc.url.includes('xbox.com'));
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
                      : isXbox
                        ? 'XBX'
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
                      : isXbox
                        ? 'Xbox Store Rating'
                        : 'OpenCritic';
            return (
              <div
                className={`absolute top-2 right-2 z-10 flex items-center gap-1 text-[10px] font-extrabold px-1.5 py-0.5 rounded border shadow-md pointer-events-none ${
                  ocColors.badgeBg
                } ${ocColors.badgeBorder} ${ocColors.badgeText} ${
                  sortBy === 'rating'
                    ? 'ring-2 ring-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.55)] scale-105'
                    : ''
                }`}
                title={`${sourceName}: ${oc.score}/100 • ${oc.tier}${oc.starRatingRaw !== undefined ? ` (${oc.starRatingRaw}★)` : ''}${oc.userScoreRaw ? ` (${oc.userScoreRaw}/10 user rating)` : ''}${oc.percentRecommended !== undefined ? ` (${oc.percentRecommended}% recommended)` : ''}`}
              >
                <span className="text-[9px] opacity-85">{sourceTag}</span>
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
          className="absolute bottom-2 right-2 flex items-center gap-1.5 bg-[#0a0e14]/95 px-2 py-1 rounded border border-white/20 shadow-lg pointer-events-none group-hover:border-steam-accent/60 transition-colors z-10"
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
                  className={`w-3.5 h-3.5 ${
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
        <div className="absolute inset-0 bg-steam-accent/10 hidden group-hover:block pointer-events-none" />
      </div>

      {/* Bottom Card Title Info */}
      <div className="p-2.5 bg-[#16202d] flex flex-col justify-between border-t border-steam-border/40 h-[56px]">
        <h3
          className="text-xs font-semibold text-white/95 group-hover:text-steam-accent truncate transition-colors"
          title={game.title}
        >
          {game.title}
        </h3>
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
              <span className="text-white/85 font-medium">{playtimeLabel}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
