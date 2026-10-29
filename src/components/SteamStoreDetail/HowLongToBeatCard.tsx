import React, { useState, useEffect } from 'react';
import { HltbData, getHowLongToBeat, fetchAndCacheHltb } from '../../services/hltb/howLongToBeat';
import { Clock, ExternalLink, Trophy, Compass, Flag, Layers, CheckCircle2, Loader2 } from 'lucide-react';

interface HowLongToBeatCardProps {
  gameTitle: string;
  appId?: number;
  genres?: string[];
  tags?: string[];
  hltb?: HltbData;
}

export const HowLongToBeatCard: React.FC<HowLongToBeatCardProps> = ({
  gameTitle,
  appId,
  genres = [],
  tags = [],
  hltb: initialHltb,
}) => {
  const [hltb, setHltb] = useState<HltbData | null>(() =>
    initialHltb ?? getHowLongToBeat(gameTitle, appId, genres, tags)
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const immediate = initialHltb ?? getHowLongToBeat(gameTitle, appId, genres, tags);
    setHltb(immediate);

    if (immediate?.isAccurate) {
      return;
    }

    setIsLoading(true);
    fetchAndCacheHltb(gameTitle, appId)
      .then((live) => {
        if (isMounted && live) {
          setHltb(live);
        }
      })
      .catch((err) => {
        console.warn('[HLTB] Async fetch error:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [gameTitle, appId, initialHltb]);

  if (!hltb && !isLoading) {
    return null;
  }

  const hltbUrl = hltb?.hltbGameId
    ? `https://howlongtobeat.com/game/${hltb.hltbGameId}`
    : `https://howlongtobeat.com/?q=${encodeURIComponent(gameTitle)}`;

  const formatHours = (hours?: number): string => {
    if (!hours || hours <= 0) return '--';
    if (hours % 1 === 0.5) {
      return `${Math.floor(hours)}½h`;
    }
    return `${hours}h`;
  };

  const maxHours = Math.max(
    hltb?.completionistHours || 0,
    hltb?.mainExtraHours || 0,
    hltb?.mainStoryHours || 0,
    hltb?.allStylesHours || 0,
    1
  );

  return (
    <div className="bg-[#121923] border border-[#2a475e] rounded p-4 shadow-lg text-steam-text">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#2a475e]/60">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-[#1f3a52] flex items-center justify-center text-steam-accent border border-steam-accent/30">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wider text-white">HowLongToBeat</span>
              {hltb?.isAccurate ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" aria-hidden="true" />
                  Verified
                </span>
              ) : isLoading ? (
                <span className="inline-flex items-center gap-1 text-[10px] tracking-wider px-1.5 py-0.5 rounded bg-[#1f2b38] text-steam-accent border border-steam-accent/30">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />
                  Fetching...
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#1f2b38] text-steam-subtext border border-steam-border/40">
                  Estimated
                </span>
              )}
              {hltb?.gameplayType && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.2 rounded bg-[#1f2b38] text-steam-subtext border border-steam-border/40">
                  {hltb.gameplayType}
                </span>
              )}
            </div>
            <div className="text-[10px] text-steam-subtext">Community-sourced completion estimates</div>
          </div>
        </div>

        <a
          href={hltbUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 min-h-6 px-1.5 text-[11px] text-steam-accent hover:text-white hover:underline transition-colors"
          title={`View ${gameTitle} on HowLongToBeat`}
        >
          <span>View on HLTB</span>
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      </div>

      {/* 4 Pillars Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {/* Main Story */}
        <div className="bg-[#182330] p-2.5 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-sky-400">
              <Flag className="w-3 h-3 text-sky-400" aria-hidden="true" />
              Main Story
            </span>
          </div>
          <div className="text-xl font-extrabold text-white tracking-tight my-0.5">
            {formatHours(hltb?.mainStoryHours)}
          </div>
          <div className="text-[10px] text-[#94a3b8]">Core Objectives</div>
          {/* Progress Indicator */}
          <div className="w-full bg-[#101720] h-1 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-sky-400 h-full rounded-full"
              style={{ width: `${Math.min(100, ((hltb?.mainStoryHours || 0) / maxHours) * 100)}%` }}
            />
          </div>
        </div>

        {/* Main + Extra */}
        <div className="bg-[#182330] p-2.5 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-cyan-400">
              <Compass className="w-3 h-3 text-cyan-400" aria-hidden="true" />
              Main + Sides
            </span>
          </div>
          <div className="text-xl font-extrabold text-white tracking-tight my-0.5">
            {formatHours(hltb?.mainExtraHours)}
          </div>
          <div className="text-[10px] text-[#94a3b8]">Quests & Exploration</div>
          {/* Progress Indicator */}
          <div className="w-full bg-[#101720] h-1 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-cyan-400 h-full rounded-full"
              style={{ width: `${Math.min(100, ((hltb?.mainExtraHours || 0) / maxHours) * 100)}%` }}
            />
          </div>
        </div>

        {/* Completionist */}
        <div className="bg-[#182330] p-2.5 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-amber-400">
              <Trophy className="w-3 h-3 text-amber-400" aria-hidden="true" />
              Completionist
            </span>
          </div>
          <div className="text-xl font-extrabold text-white tracking-tight my-0.5">
            {formatHours(hltb?.completionistHours)}
          </div>
          <div className="text-[10px] text-[#94a3b8]">100% / All Medals</div>
          {/* Progress Indicator */}
          <div className="w-full bg-[#101720] h-1 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-amber-400 h-full rounded-full"
              style={{ width: `${Math.min(100, ((hltb?.completionistHours || 0) / maxHours) * 100)}%` }}
            />
          </div>
        </div>

        {/* All Playstyles */}
        <div className="bg-[#182330] p-2.5 rounded border border-[#25394b] flex flex-col justify-between group hover:border-[#3d6385] transition-colors">
          <div className="flex items-center justify-between text-[11px] text-steam-subtext mb-1">
            <span className="font-semibold uppercase tracking-wider flex items-center gap-1 text-slate-400">
              <Layers className="w-3 h-3 text-slate-400" aria-hidden="true" />
              All Styles
            </span>
          </div>
          <div className="text-xl font-extrabold text-white tracking-tight my-0.5">
            {formatHours(hltb?.allStylesHours)}
          </div>
          <div className="text-[10px] text-[#94a3b8]">Average Combined</div>
          {/* Progress Indicator */}
          <div className="w-full bg-[#101720] h-1 rounded-full mt-2 overflow-hidden">
            <div
              className="bg-slate-400 h-full rounded-full"
              style={{ width: `${Math.min(100, ((hltb?.allStylesHours || 0) / maxHours) * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
