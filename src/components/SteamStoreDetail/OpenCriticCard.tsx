import React from 'react';
import { OpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { getReviewSourceDisplayMeta } from '../../services/critic/criticUtils';
import { ExternalLink, Award, ThumbsUp, Sparkles, Newspaper, ShieldCheck, HelpCircle } from 'lucide-react';

interface OpenCriticCardProps {
  openCritic: OpenCriticData | null;
  gameTitle: string;
}

const OpenCriticCardImpl: React.FC<OpenCriticCardProps> = ({ openCritic, gameTitle }) => {
  const handleOpenExternal = (url: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!url) return;
    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noreferrer,noopener');
    }
  };

  if (!openCritic) {
    const unratedSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(gameTitle + ' game review')}`;
    return (
      <div className="bg-[#121923] border border-[#2a475e]/60 rounded p-4 text-steam-text select-none">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded flex items-center justify-center font-bold text-xs bg-slate-800 text-slate-400 border border-slate-700">
              <HelpCircle className="w-4 h-4 text-slate-400" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Critic Consensus
                </span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border bg-slate-800/80 border-slate-700 text-slate-400">
                  Unrated
                </span>
              </div>
              <div className="text-[10px] text-steam-subtext">
                No critical reviews aggregated for this title on OpenCritic or Metacritic.
              </div>
            </div>
          </div>

          <a
            href={unratedSearchUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleOpenExternal(unratedSearchUrl, e)}
            className="inline-flex items-center gap-1.5 min-h-6 text-xs text-steam-accent hover:text-white hover:underline transition-colors group cursor-pointer"
            aria-label={`Search reviews for ${gameTitle}`}
            title={`Search reviews for ${gameTitle}`}
          >
            <span>Search Reviews</span>
            <ExternalLink
              className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform"
              aria-hidden="true"
            />
          </a>
        </div>
      </div>
    );
  }

  const meta = getReviewSourceDisplayMeta(openCritic);
  const isMetacriticCritic = meta.shortTag === 'MC';
  const isMetacriticUser = meta.shortTag === 'MCU';
  const isSteam = meta.shortTag === 'STM';
  const isGog = meta.shortTag === 'GOG';
  const isEpic = meta.shortTag === 'EGS';
  const isXbox = meta.shortTag === 'XBX';
  const isCustom = meta.shortTag === 'CST';
  const isStoreRating = meta.isStoreRating;
  const showFiveStarScale = isStoreRating && openCritic.starRatingRaw !== undefined;
  const showTenPointScale = isMetacriticUser && openCritic.userScoreRaw !== undefined;
  const primaryScaleSuffix = showFiveStarScale ? '/ 5' : showTenPointScale ? '/ 10' : '/ 100';
  const colors = getTierColor(openCritic.tier);

  const badgeToneClass = isMetacriticCritic
    ? 'bg-gradient-to-br from-[#ffd500] to-[#cca700] text-black font-extrabold shadow-[0_0_12px_rgba(255,213,0,0.35)]'
    : isMetacriticUser
    ? 'bg-gradient-to-br from-[#00ce7a] to-[#009b5a] text-[#121923] font-black shadow-[0_0_12px_rgba(0,206,122,0.35)]'
    : isSteam
    ? 'bg-gradient-to-br from-[#1b2838] to-[#2a475e] text-[#66c0f4] font-extrabold border border-[#66c0f4]/50 shadow-[0_0_12px_rgba(102,192,244,0.35)]'
    : isGog
    ? 'bg-gradient-to-br from-[#8a2be2] to-[#4b0082] text-white font-extrabold shadow-[0_0_12px_rgba(138,43,226,0.35)]'
    : isEpic
    ? 'bg-gradient-to-br from-[#313131] to-[#121212] text-white font-extrabold border border-white/20 shadow-[0_0_12px_rgba(255,255,255,0.2)]'
    : isXbox
    ? 'bg-gradient-to-br from-[#107c10] to-[#0b5a0b] text-white font-extrabold border border-[#52d652]/40 shadow-[0_0_12px_rgba(16,124,16,0.35)]'
    : isCustom
    ? 'bg-gradient-to-br from-[#334155] to-[#1e293b] text-sky-200 font-extrabold border border-sky-400/40 shadow-[0_0_12px_rgba(56,189,248,0.25)]'
    : `${colors.scoreBg} ${colors.glow} text-white`;

  return (
    <div
      data-critic-source={meta.shortTag}
      className="bg-[#121923] border border-[#2a475e] rounded p-4 shadow-lg text-steam-text select-none"
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#2a475e]/60">
        <div className="flex items-center gap-2.5">
          {/* Logo / Badge Icon */}
          <div
            role="img"
            aria-label={meta.ariaLabel}
            className={`w-7 h-7 rounded flex items-center justify-center font-black text-xs ${badgeToneClass}`}
          >
            {meta.shortTag}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                {meta.cardHeading}
              </span>
              <span
                className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${colors.badgeBg} ${colors.badgeBorder} ${colors.badgeText}`}
              >
                {openCritic.tier}
              </span>
              {isMetacriticUser && (
                <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/40 text-emerald-300">
                  User Score
                </span>
              )}
              {isStoreRating && (
                <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-purple-950/70 border border-purple-500/40 text-purple-300">
                  Store Rating
                </span>
              )}
              {isCustom && (
                <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-sky-950/70 border border-sky-500/40 text-sky-300">
                  Custom Override
                </span>
              )}
              {openCritic.isSynthetic && (
                <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-blue-950/70 border border-blue-500/40 text-blue-300">
                  Synthetic
                </span>
              )}
            </div>
            <div className="text-[10px] text-steam-subtext">
              {isMetacriticCritic
                ? 'Aggregated Metascore from top game publications'
                : isMetacriticUser
                ? 'Aggregated player ratings from Metacritic community reviews'
                : isSteam
                ? 'Derived from Steam player sentiment while checking Metacritic & OpenCritic in background'
                : isGog
                ? 'Aggregated player ratings from GOG player community (converted out of 100)'
                : isEpic
                ? 'Aggregated player ratings from Epic Games Store (converted out of 100)'
                : isXbox
                ? 'Aggregated player ratings from Xbox Store community (converted out of 100)'
                : isCustom
                ? 'Manually assigned custom review score override'
                : 'Aggregated critical consensus from top industry publications'}
            </div>
          </div>
        </div>

        {openCritic.url && (
          <a
            href={openCritic.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleOpenExternal(openCritic.url, e)}
            className="inline-flex items-center gap-1.5 min-h-6 text-xs text-steam-accent hover:text-white hover:underline transition-colors group cursor-pointer"
            aria-label={`${meta.externalLinkPrefix} ${gameTitle}`}
            title={`${meta.externalLinkPrefix} ${gameTitle}`}
          >
            <span>{meta.actionLabel}</span>
            <ExternalLink
              className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform"
              aria-hidden="true"
            />
          </a>
        )}
      </div>

      {/* 4 Metrics Pillars Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {/* Metric 1: Top Critic Average / Metascore / User Score / Steam Rating / Storefront Stars */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors relative overflow-hidden">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-sky-400">
              <Award className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              {isGog
                ? 'Star Rating'
                : isEpic || isXbox
                ? 'Store Rating'
                : isMetacriticCritic
                ? 'Metascore'
                : isMetacriticUser
                ? 'User Score'
                : isSteam
                ? 'Community Score'
                : isCustom
                ? 'Custom Score'
                : 'Top Critic Avg'}
            </span>
            <span className="text-[10px] text-steam-subtext/70">{primaryScaleSuffix}</span>
          </div>
          <div className="flex items-baseline gap-1 my-1">
            <span className={`text-2xl font-black tracking-tight ${colors.accentText}`}>
              {showFiveStarScale
                ? `${openCritic.starRatingRaw} ★`
                : showTenPointScale
                ? openCritic.userScoreRaw
                : openCritic.score}
            </span>
            <span className="text-xs text-steam-subtext font-medium">{primaryScaleSuffix}</span>
          </div>
          <div className="text-[10px] text-steam-subtext mt-1 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-400" aria-hidden="true" />
            <span>
              {isStoreRating
                ? `${openCritic.score}/100 Equivalent`
                : isMetacriticCritic
                ? 'Metacritic Metascore'
                : isMetacriticUser
                ? 'Metacritic User Rating'
                : isSteam
                ? 'Synthetic Steam Rating'
                : isCustom
                ? 'Manual Score Override'
                : 'Top Critic Average'}
            </span>
          </div>
        </div>

        {/* Metric 2: Critics Recommend / Consensus / Positive / Converted 0-100 */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-emerald-400">
              <ThumbsUp className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              {isStoreRating
                ? 'Score (0-100)'
                : openCritic.percentRecommended !== undefined
                ? isSteam
                  ? 'Positive'
                  : 'Recommend'
                : 'Consensus'}
            </span>
            <span className="text-[10px] text-steam-subtext/70">
              {isStoreRating
                ? 'Score'
                : openCritic.percentRecommended !== undefined
                ? 'Ratio'
                : 'Tier'}
            </span>
          </div>
          <div className="flex items-baseline gap-1 my-1">
            <span className="text-2xl font-black text-emerald-400 tracking-tight">
              {isStoreRating
                ? `${openCritic.score}/100`
                : openCritic.percentRecommended !== undefined
                ? `${openCritic.percentRecommended}%`
                : openCritic.tier}
            </span>
          </div>
          <div className="text-[10px] text-steam-subtext mt-1">
            {isStoreRating
              ? 'Converted 5-Star Rating'
              : openCritic.percentRecommended !== undefined
              ? isSteam
                ? 'Positive Player Reviews'
                : 'Critics Recommended'
              : isMetacriticUser
              ? 'Player Sentiment Tier'
              : isCustom
              ? 'Custom Rating Tier'
              : 'Critical Acclaim'}
          </div>
        </div>

        {/* Metric 3: Rating Tier */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className={`font-semibold uppercase tracking-wider flex items-center gap-1 ${colors.accentText}`}>
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              Tier Rating
            </span>
          </div>
          <div className="flex items-baseline gap-1 my-1">
            <span className={`text-xl font-black tracking-tight ${colors.accentText}`}>
              {openCritic.tier}
            </span>
          </div>
          <div className="text-[10px] text-steam-subtext mt-1">
            {openCritic.percentile
              ? `${openCritic.percentile}th Percentile`
              : isMetacriticUser
              ? 'Metacritic User Tier'
              : isSteam
              ? 'Steam Community Tier'
              : isGog
              ? 'GOG Player Tier'
              : isEpic
              ? 'Epic Player Tier'
              : isXbox
              ? 'Xbox Store Tier'
              : isCustom
              ? 'Custom Score Tier'
              : isMetacriticCritic
              ? 'Metacritic Rating'
              : 'OpenCritic Rating'}
          </div>
        </div>

        {/* Metric 4: Critic Reviews / Community Count */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-amber-400">
              <Newspaper className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              {isSteam
                ? 'Steam Players'
                : isGog
                ? 'GOG Players'
                : isEpic
                ? 'Epic Players'
                : isXbox
                ? 'Xbox Players'
                : isMetacriticUser
                ? 'User Reviews'
                : isCustom
                ? 'Custom Source'
                : 'Publications'}
            </span>
          </div>
          <div className="flex items-baseline gap-1 my-1">
            <span className="text-2xl font-black text-white/90 tracking-tight">
              {openCritic.numReviews ? openCritic.numReviews.toLocaleString() : '—'}
            </span>
            {openCritic.numReviews && (
              <span className="text-xs text-steam-subtext font-medium">reviews</span>
            )}
          </div>
          <div className="text-[10px] text-steam-subtext mt-1">
            {isSteam
              ? 'Player Reviews'
              : isGog
              ? 'GOG Player Ratings'
              : isEpic
              ? 'Epic Store Ratings'
              : isXbox
              ? 'Xbox Store Ratings'
              : isMetacriticUser
              ? 'Metacritic Users'
              : isCustom
              ? 'User-Specified Rating'
              : 'Aggregated Reviews'}
          </div>
        </div>
      </div>
    </div>
  );
};

export const OpenCriticCard: React.FC<OpenCriticCardProps> = React.memo(OpenCriticCardImpl);
