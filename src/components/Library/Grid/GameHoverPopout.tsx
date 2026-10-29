import React from 'react';
import {
  AlertCircle,
  Clock,
  Cloud,
  Gamepad2,
  ThumbsUp,
} from 'lucide-react';
import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { toOlMediaUrl } from '../../../contracts/network';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import { steamApi } from '../../../services/steam/steamApi';
import { getOpenCriticData, getTierColor } from '../../../services/opencritic/openCritic';
import { getHowLongToBeat } from '../../../services/hltb/howLongToBeat';
import { getUserOverrideForGame } from '../../../services/storage/userOverrideStorage';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import {
  formatPlaytime,
  getCleanSynopsis,
  getReleaseYear,
  isMicrosoftOrXboxAssetUrl,
} from './gridCoverUtils';

export interface RenderGameHoverPopoutArgs {
  hoveredGame: CanonicalGame;
  previewPos: { x: number; y: number; align: 'left' | 'right' };
  popoutRef: React.MutableRefObject<HTMLDivElement | null>;
  userOverridesMap: Record<string, UserGameOverride>;
  connectedSet: Set<StorefrontId>;
  dynamicBlurb: { id: string; blurb: string } | null;
  hoverHeaderFailed: boolean;
  onSetHoverHeaderFailed: (failed: boolean) => void;
  onPopoutMouseEnter: () => void;
  onPopoutMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => void;
  onSelectGame: (game: CanonicalGame) => void;
  onContextMenu: (game: CanonicalGame, e: React.MouseEvent) => void;
}

export function renderGameHoverPopout({
  hoveredGame,
  previewPos,
  popoutRef,
  userOverridesMap,
  connectedSet,
  dynamicBlurb,
  hoverHeaderFailed,
  onSetHoverHeaderFailed,
  onPopoutMouseEnter,
  onPopoutMouseLeave,
  onSelectGame,
  onContextMenu,
}: RenderGameHoverPopoutArgs): React.ReactElement {
  const hoveredOverride =
    userOverridesMap[hoveredGame.id] || getUserOverrideForGame(hoveredGame, userOverridesMap);
  const targetAppId =
    hoveredOverride?.steamAppId === null
      ? undefined
      : steamMatcher.getEffectiveSteamAppId(hoveredGame);
  const releaseYear = getReleaseYear(hoveredGame, targetAppId);
  const cleanSynopsis = getCleanSynopsis(hoveredGame, targetAppId, hoveredOverride);
  const hoveredBrowseHeader = steamApi.getStoreBrowseAssetsInstant(
    targetAppId || hoveredGame.steamAppId
  )?.headerImage;
  const preferredEnrichedHoverHeader =
    hoveredGame.enrichedMetadata?.headerImage &&
    !(
      isMicrosoftOrXboxAssetUrl(hoveredGame.enrichedMetadata.headerImage) &&
      hoveredBrowseHeader
    )
      ? hoveredGame.enrichedMetadata.headerImage
      : hoveredBrowseHeader || hoveredGame.enrichedMetadata?.headerImage;
  const rawHoverHeader =
    hoveredOverride?.headerImage ||
    preferredEnrichedHoverHeader ||
    hoveredBrowseHeader ||
    hoveredGame.headerImage ||
    hoveredGame.capsuleImage;
  const hoveredGogId =
    hoveredGame.platforms?.find((p) => p.platformId === 'gog')?.platformGameId || null;
  const hoveredEpicApp =
    hoveredGame.platforms?.find((p) => p.platformId === 'epic')?.platformGameId || null;
  const hoveredXboxPlat = hoveredGame.platforms?.find((p) => p.platformId === 'xbox');
  const rawHoveredXbox = hoveredGame as CanonicalGame & {
    xboxProductId?: string | null;
    packageFamilyName?: string | null;
    xboxTitleId?: string | null;
  };
  const hoveredXboxProductId =
    rawHoveredXbox.xboxProductId || hoveredXboxPlat?.xboxProductId || null;
  const hoveredPackageFamilyName =
    rawHoveredXbox.packageFamilyName || hoveredXboxPlat?.packageFamilyName || null;
  const hoveredXboxTitleId =
    rawHoveredXbox.xboxTitleId || hoveredXboxPlat?.xboxTitleId || null;
  const resolvedHoverHeader = rawHoverHeader
    ? toOlMediaUrl({
        url: rawHoverHeader,
        gameId: hoveredGame.id,
        role:
          rawHoverHeader === hoveredGame.capsuleImage &&
          rawHoverHeader !== hoveredGame.headerImage
            ? 'cover'
            : 'header',
        ordinal: 0,
        steamAppId: targetAppId || hoveredGame.steamAppId || null,
        gogId: hoveredGogId,
        epicAppName: hoveredEpicApp,
        xboxProductId: hoveredXboxProductId,
        packageFamilyName: hoveredPackageFamilyName,
        xboxTitleId: hoveredXboxTitleId,
      })
    : '';

  const playtimeLabel = formatPlaytime(hoveredGame);
  const oc = getOpenCriticData(
    targetAppId,
    hoveredGame.title,
    hoveredGame.reviewSummary?.positivePercent
  );
  const hltb = getHowLongToBeat(
    hoveredGame.title,
    targetAppId,
    hoveredGame.genres,
    hoveredGame.tags
  );
  const displayedSynopsis =
    dynamicBlurb?.id === hoveredGame.id ? dynamicBlurb.blurb : cleanSynopsis;

  return (
    <div
      ref={popoutRef}
      style={{
        position: 'fixed',
        left: `${previewPos.x}px`,
        top: `${previewPos.y}px`,
        zIndex: 60,
      }}
      onMouseEnter={onPopoutMouseEnter}
      onMouseLeave={onPopoutMouseLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(hoveredGame, e);
      }}
      className="relative w-80 rounded-lg overflow-hidden bg-[#16202d] border border-steam-accent/70 shadow-[0_12px_40px_rgba(0,0,0,0.85)] pointer-events-auto cursor-pointer animate-in fade-in zoom-in-95 duration-150 text-steam-text"
    >
      <button
        type="button"
        aria-label={`Open ${hoveredGame.title}`}
        onClick={() => onSelectGame(hoveredGame)}
        className="card-stretched-trigger z-20 rounded-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent focus-visible:ring-inset"
      />

      {/* Header Image Banner */}
      <div className="relative aspect-video w-full bg-gradient-to-br from-[#1b2838] to-[#0f161f] overflow-hidden">
        {resolvedHoverHeader && !hoverHeaderFailed ? (
          <img
            src={resolvedHoverHeader}
            alt={hoveredGame.title}
            decoding="async"
            onError={() => onSetHoverHeaderFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Gamepad2 aria-hidden="true" className="w-8 h-8 text-slate-400/70" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#16202d] via-transparent to-black/30" />
        <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-white truncate">{hoveredGame.title}</span>
          {releaseYear && (
            <span className="text-[11px] font-bold text-white/95 px-1.5 py-0.5 rounded bg-black/85 border border-white/20 shrink-0 shadow">
              {releaseYear}
            </span>
          )}
        </div>
      </div>

      {/* Disconnected Storefront Notice Banner */}
      {hoveredGame.platforms.some((p) => !connectedSet.has(p.platformId)) && (
        <div className="px-3 py-1.5 bg-amber-950/85 border-b border-amber-600/40 text-[11px] text-amber-200 flex items-center gap-1.5">
          <AlertCircle aria-hidden="true" className="w-3.5 h-3.5 text-amber-300 shrink-0" />
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
              <ThumbsUp aria-hidden="true" className="w-3.5 h-3.5 text-steam-accent" />
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
            {playtimeLabel ? (
              <div className="flex items-center gap-1 text-white font-medium text-[11px]">
                <Clock aria-hidden="true" className="w-3 h-3 text-sky-400" />
                <span>{playtimeLabel}</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-sky-300 text-[11px]">
                <Cloud aria-hidden="true" className="w-3 h-3" />
                <span>In Library</span>
              </div>
            )}
          </div>
        </div>

        {/* Critic Rating Row */}
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
              ? 'Metacritic'
              : isMetacriticUser
                ? 'MC User Score'
                : isSteam
                  ? 'Steam Rating'
                  : isGog
                    ? 'GOG Rating'
                    : isEpic
                      ? 'Epic Rating'
                      : isXbox
                        ? 'Xbox Rating'
                        : 'OpenCritic';
            return (
              <div className="flex items-center justify-between bg-black/40 px-2.5 py-1.5 rounded border border-white/10 text-[10px]">
                <div className="flex items-center gap-1.5 text-slate-200">
                  <span
                    className={`w-3.5 h-3.5 rounded text-[8px] font-black flex items-center justify-center shrink-0 ${
                      isMetacritic
                        ? 'bg-amber-400 text-black font-extrabold'
                        : isMetacriticUser
                          ? 'bg-emerald-400 text-black font-extrabold'
                          : isSteam
                            ? 'bg-sky-700 text-white font-extrabold'
                            : isGog
                              ? 'bg-purple-700 text-white font-extrabold'
                              : isEpic
                                ? 'bg-zinc-700 text-white font-extrabold'
                                : isXbox
                                  ? 'bg-emerald-700 text-white font-extrabold'
                                  : `${ocColors.scoreBg} text-white`
                    }`}
                  >
                    {sourceTag}
                  </span>
                  <span className="font-semibold uppercase tracking-wider text-[9px] text-slate-300">
                    {sourceName}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${ocColors.badgeBg} ${ocColors.badgeBorder} ${ocColors.badgeText}`}
                  >
                    {oc.score}
                  </span>
                  <span className={`text-[10px] font-bold ${ocColors.accentText}`}>{oc.tier}</span>
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
        {hltb &&
          Boolean(hltb.mainStoryHours || hltb.allStylesHours) &&
          (() => {
            const formatHours = (h: number): string => {
              if (!h || h <= 0) return '--';
              if (h % 1 === 0.5) return `${Math.floor(h)}½h`;
              return `${Math.round(h)}h`;
            };

            return (
              <div className="flex items-center justify-between bg-black/40 px-2.5 py-1.5 rounded border border-white/10 text-[10px]">
                <div className="flex items-center gap-1.5 text-slate-200">
                  <Clock aria-hidden="true" className="w-3.5 h-3.5 text-sky-400" />
                  <span className="font-semibold uppercase tracking-wider text-[9px] text-slate-300">
                    HowLongToBeat
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {hltb.mainStoryHours > 0 && (
                    <span className="flex items-center gap-1 text-white/95">
                      <span className="text-steam-subtext text-[10px]">Main:</span>
                      <strong className="text-sky-300 font-bold text-[11px]">
                        {formatHours(hltb.mainStoryHours)}
                      </strong>
                    </span>
                  )}
                  {hltb.completionistHours > 0 && (
                    <span className="flex items-center gap-1 text-white/95">
                      <span className="text-steam-subtext text-[10px]">100%:</span>
                      <strong className="text-amber-300 font-bold text-[11px]">
                        {formatHours(hltb.completionistHours)}
                      </strong>
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

        {/* Synopsis Snippet */}
        {displayedSynopsis && (
          <p className="text-[11px] text-steam-subtext leading-relaxed line-clamp-3">
            {displayedSynopsis}
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
              const isXboxExpiredUnplayable = Boolean(
                p.platformId === 'xbox' &&
                  p.subscriptionExpired &&
                  p.ownershipType === 'subscription'
              );
              const isXboxActiveGamePass = Boolean(
                p.platformId === 'xbox' &&
                  !p.subscriptionExpired &&
                  (p.ownershipType === 'subscription' ||
                    p.ownershipType === 'owned_and_subscription')
              );
              const isXboxLeavingSoon = Boolean(isXboxActiveGamePass && p.isLeavingSoon);
              return (
                <div
                  key={p.platformId}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${
                    isXboxExpiredUnplayable
                      ? 'bg-rose-950/60 border-rose-500/40 text-rose-200'
                      : isConnected
                        ? 'bg-black/50 border-white/10 text-white'
                        : 'bg-amber-950/60 border-amber-500/40 text-amber-200'
                  }`}
                >
                  <StorefrontIcon
                    storefrontId={p.platformId}
                    decorative
                    className={`w-3 h-3 ${
                      isConnected
                        ? p.platformId === 'xbox'
                          ? 'text-[#52d652]'
                          : 'text-sky-400'
                        : 'text-amber-300'
                    }`}
                  />
                  <span>{getStorefrontDisplayName(p.platformId)}</span>
                  {isXboxExpiredUnplayable ? (
                    <span className="text-[8px] px-1 rounded bg-rose-900/80 text-rose-200 font-bold uppercase">
                      Expired
                    </span>
                  ) : isXboxLeavingSoon ? (
                    <span className="text-[8px] px-1 rounded bg-amber-900/80 text-amber-200 font-bold uppercase">
                      Leaving Soon
                    </span>
                  ) : isXboxActiveGamePass ? (
                    <span className="text-[8px] px-1 rounded bg-emerald-900/80 text-emerald-200 font-bold uppercase">
                      GP
                    </span>
                  ) : null}
                  {!isConnected && (
                    <span className="text-[9px] text-amber-300 font-semibold">
                      (Not Connected)
                    </span>
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
    </div>
  );
}
