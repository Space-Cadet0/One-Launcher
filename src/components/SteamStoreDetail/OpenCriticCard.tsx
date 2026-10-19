import React from 'react';
import { OpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { ExternalLink, Award, ThumbsUp, Sparkles, Newspaper, ShieldCheck, HelpCircle } from 'lucide-react';

interface OpenCriticCardProps {
  openCritic: OpenCriticData | null;
  gameTitle: string;
}

export const OpenCriticCard: React.FC<OpenCriticCardProps> = ({ openCritic, gameTitle }) => {
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
              <HelpCircle className="w-4 h-4 text-slate-400" />
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
            rel="noreferrer"
            onClick={(e) => handleOpenExternal(unratedSearchUrl, e)}
            className="inline-flex items-center gap-1.5 text-xs text-steam-accent hover:text-white hover:underline transition-colors group cursor-pointer"
            title={`Search reviews for ${gameTitle}`}
          >
            <span>Search Reviews</span>
            <ExternalLink className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </a>
        </div>
      </div>
    );
  }

  const isMetacriticCritic = openCritic.source === 'metacritic';
  const isMetacriticUser = openCritic.source === 'metacritic_user';
  const isMetacritic = isMetacriticCritic || isMetacriticUser;
  const isSteam = openCritic.source === 'steam';
  const isGog = openCritic.source === 'gog';
  const isEpic = openCritic.source === 'epic';
  const colors = getTierColor(openCritic.tier);

  return (
    <div className="bg-[#121923] border border-[#2a475e] rounded p-4 shadow-lg text-steam-text select-none">
      {/* Header Bar */}
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#2a475e]/60">
        <div className="flex items-center gap-2.5">
          {/* Logo / Badge Icon */}
          <div
            className={`w-7 h-7 rounded flex items-center justify-center font-black text-xs ${
              isMetacriticCritic
                ? 'bg-gradient-to-br from-[#ffd500] to-[#cca700] text-black font-extrabold shadow-[0_0_12px_rgba(255,213,0,0.35)]'
                : isMetacriticUser
                ? 'bg-gradient-to-br from-[#00ce7a] to-[#009b5a] text-[#121923] font-black shadow-[0_0_12px_rgba(0,206,122,0.35)]'
                : isSteam
                ? 'bg-gradient-to-br from-[#1b2838] to-[#2a475e] text-[#66c0f4] font-extrabold border border-[#66c0f4]/50 shadow-[0_0_12px_rgba(102,192,244,0.35)] text-white'
                : isGog
                ? 'bg-gradient-to-br from-[#8a2be2] to-[#4b0082] text-white font-extrabold shadow-[0_0_12px_rgba(138,43,226,0.35)]'
                : isEpic
                ? 'bg-gradient-to-br from-[#313131] to-[#121212] text-white font-extrabold border border-white/20 shadow-[0_0_12px_rgba(255,255,255,0.2)]'
                : `${colors.scoreBg} ${colors.glow} text-white`
            }`}
          >
            {isMetacriticCritic
              ? 'MC'
              : isMetacriticUser
              ? 'MCU'
              : isSteam
              ? 'STM'
              : isGog
              ? 'GOG'
              : isEpic
              ? 'EGS'
              : 'OC'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-white">
                {isMetacriticCritic
                  ? 'Metacritic Reviews'
                  : isMetacriticUser
                  ? 'Metacritic User Score'
                  : isSteam
                  ? 'Steam Community Score'
                  : isGog
                  ? 'GOG Player Rating'
                  : isEpic
                  ? 'Epic Store Rating'
                  : 'OpenCritic Reviews'}
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
              {(isGog || isEpic) && (
                <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-purple-950/70 border border-purple-500/40 text-purple-300">
                  Store Rating
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
                : 'Aggregated critical consensus from top industry publications'}
            </div>
          </div>
        </div>

        <a
          href={openCritic.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => handleOpenExternal(openCritic.url, e)}
          className="inline-flex items-center gap-1.5 text-xs text-steam-accent hover:text-white hover:underline transition-colors group cursor-pointer"
          title={
            isMetacriticCritic
              ? `View full ${gameTitle} Metascore breakdown on Metacritic`
              : isMetacriticUser
              ? `View full ${gameTitle} user reviews on Metacritic`
              : isSteam
              ? `View ${gameTitle} on Steam Store`
              : isGog
              ? `View ${gameTitle} on GOG.com`
              : isEpic
              ? `View ${gameTitle} on Epic Games Store`
              : `View full ${gameTitle} breakdown on OpenCritic`
          }
        >
          <span>
            {isMetacriticCritic
              ? 'View on Metacritic'
              : isMetacriticUser
              ? 'View Metacritic User Reviews'
              : isSteam
              ? 'View on Steam Store'
              : isGog
              ? 'View on GOG'
              : isEpic
              ? 'View on Epic Store'
              : 'View on OpenCritic'}
          </span>
          <ExternalLink className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </a>
      </div>

      {/* 4 Metrics Pillars Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {/* Metric 1: Top Critic Average / Metascore / User Score / Steam Rating / Storefront Stars */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors relative overflow-hidden">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-sky-400">
              <Award className="w-3.5 h-3.5 text-sky-400" />
              {isGog
                ? 'Star Rating'
                : isEpic
                ? 'Store Rating'
                : isMetacriticCritic
                ? 'Metascore'
                : isMetacriticUser
                ? 'User Score'
                : isSteam
                ? 'Community Score'
                : 'Top Critic Avg'}
            </span>
            <span className="text-[10px] text-steam-subtext/70">
              {isGog || isEpic ? '/ 5' : isMetacriticUser ? '/ 10' : '/ 100'}
            </span>
          </div>
          <div className="flex items-baseline gap-1 my-1">
            <span className={`text-2xl font-black tracking-tight ${colors.accentText}`}>
              {(isGog || isEpic) && openCritic.starRatingRaw !== undefined
                ? `${openCritic.starRatingRaw} ★`
                : isMetacriticUser && openCritic.userScoreRaw !== undefined
                ? openCritic.userScoreRaw
                : openCritic.score}
            </span>
            <span className="text-xs text-steam-subtext font-medium">
              {isGog || isEpic ? '/ 5' : isMetacriticUser ? '/ 10' : '/ 100'}
            </span>
          </div>
          <div className="text-[10px] text-steam-subtext mt-1 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-400" />
            <span>
              {isGog
                ? `${openCritic.score}/100 Equivalent`
                : isEpic
                ? `${openCritic.score}/100 Equivalent`
                : isMetacriticCritic
                ? 'Metacritic Metascore'
                : isMetacriticUser
                ? 'Metacritic User Rating'
                : isSteam
                ? 'Synthetic Steam Rating'
                : 'Top Critic Average'}
            </span>
          </div>
        </div>

        {/* Metric 2: Critics Recommend / Consensus / Positive / Converted 0-100 */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-emerald-400">
              <ThumbsUp className="w-3.5 h-3.5 text-emerald-400" />
              {isGog || isEpic
                ? 'Score (0-100)'
                : openCritic.percentRecommended !== undefined
                ? isSteam
                  ? 'Positive'
                  : 'Recommend'
                : 'Consensus'}
            </span>
            <span className="text-[10px] text-steam-subtext/70">
              {isGog || isEpic
                ? 'Score'
                : openCritic.percentRecommended !== undefined
                ? 'Ratio'
                : 'Tier'}
            </span>
          </div>
          <div className="flex items-baseline gap-1 my-1">
            <span className="text-2xl font-black text-emerald-400 tracking-tight">
              {isGog || isEpic
                ? `${openCritic.score}/100`
                : openCritic.percentRecommended !== undefined
                ? `${openCritic.percentRecommended}%`
                : openCritic.tier}
            </span>
          </div>
          <div className="text-[10px] text-steam-subtext mt-1">
            {isGog || isEpic
              ? 'Converted 5-Star Rating'
              : openCritic.percentRecommended !== undefined
              ? isSteam
                ? 'Positive Player Reviews'
                : 'Critics Recommended'
              : isMetacriticUser
              ? 'Player Sentiment Tier'
              : 'Critical Acclaim'}
          </div>
        </div>

        {/* Metric 3: Rating Tier */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className={`font-semibold uppercase tracking-wider flex items-center gap-1 ${colors.accentText}`}>
              <Sparkles className="w-3.5 h-3.5" />
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
              : `${isMetacritic ? 'Metacritic' : 'OpenCritic'} Rating`}
          </div>
        </div>

        {/* Metric 4: Critic Reviews / Community Count */}
        <div className="bg-[#182330] p-3 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-amber-400">
              <Newspaper className="w-3.5 h-3.5 text-amber-400" />
              {isSteam
                ? 'Steam Players'
                : isGog
                ? 'GOG Players'
                : isEpic
                ? 'Epic Players'
                : isMetacriticUser
                ? 'User Reviews'
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
              : isMetacriticUser
              ? 'Metacritic Users'
              : 'Aggregated Reviews'}
          </div>
        </div>
      </div>
    </div>
  );
};
