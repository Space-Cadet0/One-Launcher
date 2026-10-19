import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import type {
  StorefrontAchievementsData,
  MultiStoreAchievementsMap,
} from '../../contracts/achievement';
import { achievementDetailService } from '../../services/achievements/achievementDetailService';
import { matchesLooseSearchQuery } from '../../services/common/titleUtils';
import { StorefrontIcon } from '../Common/StorefrontIcon';
import {
  Trophy,
  X,
  Search,
  CheckCircle2,
  Lock,
  Sparkles,
  Calendar,
  Flame,
  ArrowUpDown,
  Eye,
  EyeOff,
  Zap,
  Loader2,
} from 'lucide-react';

export interface GameAchievementsModalProps {
  isOpen: boolean;
  game: CanonicalGame | null;
  initialStorefrontId?: StorefrontId;
  onClose: () => void;
}

type FilterTab = 'all' | 'unlocked' | 'locked' | 'secret';
type SortOption = 'default' | 'rarity_rarest' | 'rarity_common' | 'unlock_date' | 'name';

export const GameAchievementsModal: React.FC<GameAchievementsModalProps> = ({
  isOpen,
  game,
  initialStorefrontId,
  onClose,
}) => {
  const [multiStoreData, setMultiStoreData] = useState<MultiStoreAchievementsMap>({});
  const [activeStorefront, setActiveStorefront] = useState<StorefrontId>('steam');
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>('all');
  const [sortOption, setSortOption] = useState<SortOption>('default');
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());

  // Available storefronts with achievements for this game
  const availableStorefronts = useMemo(() => {
    if (!game) return [];
    const ids: StorefrontId[] = [];
    if (multiStoreData.steam) ids.push('steam');
    if (multiStoreData.epic) ids.push('epic');
    if (multiStoreData.gog) ids.push('gog');

    // Also include any owned platform on game
    for (const p of game.platforms) {
      if (!ids.includes(p.platformId as StorefrontId)) {
        ids.push(p.platformId as StorefrontId);
      }
    }
    return ids;
  }, [game, multiStoreData]);

  // Load detailed achievements on open
  useEffect(() => {
    if (isOpen && game) {
      setSearchQuery('');
      setActiveFilterTab('all');
      setSortOption('default');
      setRevealedSecrets(new Set());

      // Determine initial storefront tab
      const preferredStore =
        initialStorefrontId ||
        (game.platforms.some((p) => p.platformId === 'steam')
          ? 'steam'
          : game.platforms[0]?.platformId || 'steam');
      setActiveStorefront(preferredStore as StorefrontId);

      setIsLoading(true);
      achievementDetailService
        .fetchGameAchievements(game)
        .then((data) => {
          setMultiStoreData(data);
          // If preferred storefront has no achievements, select the first available with achievements
          if (!data[preferredStore as StorefrontId]) {
            const firstWithData = Object.keys(data)[0] as StorefrontId;
            if (firstWithData) setActiveStorefront(firstWithData);
          }
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, game?.id, initialStorefrontId]);

  // Handle escape key to close modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Active storefront data
  const currentStoreData: StorefrontAchievementsData | undefined = multiStoreData[activeStorefront];

  // Toggle reveal for hidden / secret achievements
  const toggleSecretReveal = useCallback((id: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filtered and sorted achievements list
  const displayedAchievements = useMemo(() => {
    if (!currentStoreData?.achievements) return [];
    let list = [...currentStoreData.achievements];

    // Filter tab
    if (activeFilterTab === 'unlocked') {
      list = list.filter((a) => a.unlocked);
    } else if (activeFilterTab === 'locked') {
      list = list.filter((a) => !a.unlocked);
    } else if (activeFilterTab === 'secret') {
      list = list.filter((a) => a.isSecret);
    }

    // Text search query
    if (searchQuery.trim()) {
      list = list.filter(
        (a) =>
          matchesLooseSearchQuery(a.name, searchQuery) ||
          matchesLooseSearchQuery(a.description, searchQuery)
      );
    }

    // Sorting
    list.sort((a, b) => {
      if (sortOption === 'rarity_rarest') {
        const pctA = a.globalPercentage ?? 100;
        const pctB = b.globalPercentage ?? 100;
        return pctA - pctB;
      }
      if (sortOption === 'rarity_common') {
        const pctA = a.globalPercentage ?? 0;
        const pctB = b.globalPercentage ?? 0;
        return pctB - pctA;
      }
      if (sortOption === 'unlock_date') {
        // Unlocked first, sorted by newest unlock timestamp
        if (a.unlocked && !b.unlocked) return -1;
        if (!a.unlocked && b.unlocked) return 1;
        const timeA = typeof a.unlockedAt === 'number' ? a.unlockedAt : a.unlockedAt ? new Date(a.unlockedAt).getTime() : 0;
        const timeB = typeof b.unlockedAt === 'number' ? b.unlockedAt : b.unlockedAt ? new Date(b.unlockedAt).getTime() : 0;
        return timeB - timeA;
      }
      if (sortOption === 'name') {
        return a.name.localeCompare(b.name);
      }
      // Default: Unlocked first, then preserved natural order
      if (a.unlocked && !b.unlocked) return -1;
      if (!a.unlocked && b.unlocked) return 1;
      return 0;
    });

    return list;
  }, [currentStoreData, activeFilterTab, searchQuery, sortOption]);

  const totalCount = currentStoreData?.total || 0;
  const unlockedCount = currentStoreData?.unlocked || 0;
  const percentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
  const isMastered = totalCount > 0 && unlockedCount >= totalCount;
  const lockedCount = Math.max(0, totalCount - unlockedCount);
  const secretCount = currentStoreData?.achievements.filter((a) => a.isSecret).length || 0;

  if (!isOpen || !game) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/85 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl bg-[#101822] border border-[#2a475e] rounded-xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden text-steam-text"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="achievements-modal-title"
      >
        {/* Top Header Banner */}
        <div className="relative border-b border-[#2a475e] bg-gradient-to-r from-[#172435] via-[#101822] to-[#14202d] px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500/20 to-amber-700/10 border border-amber-500/40 flex items-center justify-center shadow-inner shrink-0">
              <Trophy className="w-5 h-5 text-amber-400 fill-amber-400/20" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="achievements-modal-title" className="text-lg font-bold text-white truncate tracking-wide">
                  {game.title}
                </h2>
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Achievements
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 truncate">
                Official individual achievement media, global player percentages & unlock history
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Storefront Selection Tabs (Only shown if multiple storefronts exist) */}
        {availableStorefronts.length > 1 && (
          <div className="px-6 py-2.5 bg-[#0c131c] border-b border-[#2a475e]/70 flex items-center gap-2 overflow-x-auto custom-scrollbar shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1 shrink-0">
              Storefront:
            </span>
            {availableStorefronts.map((storeId) => {
              const isActive = activeStorefront === storeId;
              const storeInfo = STOREFRONT_REGISTRY[storeId];
              const storeData = multiStoreData[storeId];
              const sTotal = storeData?.total ?? 0;
              const sUnlocked = storeData?.unlocked ?? 0;
              const sPct = sTotal > 0 ? Math.round((sUnlocked / sTotal) * 100) : 0;
              const sMastered = sTotal > 0 && sUnlocked >= sTotal;

              return (
                <button
                  key={storeId}
                  type="button"
                  onClick={() => setActiveStorefront(storeId)}
                  className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer shrink-0 border ${
                    isActive
                      ? 'bg-[#1b2b3d] text-white border-steam-accent shadow-[0_0_12px_rgba(102,192,244,0.25)]'
                      : 'bg-[#141d27] text-slate-400 hover:text-white border-[#2a475e]/60 hover:bg-[#1b2838]'
                  }`}
                >
                  <StorefrontIcon storefrontId={storeId} className="w-3.5 h-3.5" />
                  <span>{storeInfo?.name || storeId}</span>
                  {sTotal > 0 && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${
                        sMastered
                          ? 'bg-amber-950/80 text-amber-300 border border-amber-500/50'
                          : 'bg-black/40 text-slate-300'
                      }`}
                    >
                      {sUnlocked}/{sTotal} ({sPct}%)
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Master Showcase Progress Bar Header */}
        <div className="px-6 py-4 bg-[#141f2c] border-b border-[#2a475e]/70 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-4">
            {/* Circular / Badge Metric */}
            <div className="relative w-14 h-14 rounded-full bg-black/50 border-2 border-steam-accent/40 flex items-center justify-center shrink-0 shadow-lg">
              {isMastered ? (
                <div className="relative flex items-center justify-center">
                  <Trophy className="w-7 h-7 text-amber-300 fill-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
                  <Sparkles className="w-3.5 h-3.5 text-yellow-200 absolute -top-1 -right-1 animate-pulse" />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-center">
                  <span className="text-xs font-extrabold text-white leading-none font-mono">
                    {percentage}%
                  </span>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">
                  {unlockedCount} of {totalCount} Unlocked
                </span>
                {isMastered && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/60 shadow">
                    <Trophy className="w-3 h-3 fill-amber-400" />
                    Mastered 100%
                  </span>
                )}
              </div>

              {/* Linear Progress Bar */}
              <div className="w-56 sm:w-72 h-2 bg-black/60 rounded-full overflow-hidden mt-1.5 border border-white/10">
                <div
                  className={`h-full transition-all duration-500 ${
                    isMastered
                      ? 'bg-gradient-to-r from-amber-400 to-yellow-300 shadow-[0_0_10px_rgba(251,191,36,0.6)]'
                      : 'bg-gradient-to-r from-sky-500 to-[#66c0f4]'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
                />
              </div>

              {/* Storefront XP / Gamerscore breakdown */}
              {currentStoreData?.totalXp !== undefined && currentStoreData.totalXp > 0 && (
                <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-300">
                  <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                  <span className="font-semibold text-white">
                    {currentStoreData.earnedXp || 0} / {currentStoreData.totalXp} XP
                  </span>
                  <span className="text-[10px] text-slate-400">Epic Games XP</span>
                </div>
              )}
            </div>
          </div>

          {/* Source indicator */}
          <div className="flex items-center gap-2 self-start sm:self-center">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5 bg-black/30 px-2.5 py-1 rounded border border-[#2a475e]/60">
              <StorefrontIcon storefrontId={activeStorefront} className="w-3.5 h-3.5" />
              <span>{STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront} Catalog</span>
            </span>
          </div>
        </div>

        {/* Toolbar: Search, Filter Tabs & Sort Dropdown */}
        <div className="px-6 py-3 bg-[#111923] border-b border-[#2a475e]/60 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shrink-0">
          {/* Status Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar">
            <button
              type="button"
              onClick={() => setActiveFilterTab('all')}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 ${
                activeFilterTab === 'all'
                  ? 'bg-[#1b2b3d] text-white border border-steam-accent/70'
                  : 'text-slate-400 hover:text-white bg-[#16202d] border border-transparent'
              }`}
            >
              All ({totalCount})
            </button>
            <button
              type="button"
              onClick={() => setActiveFilterTab('unlocked')}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                activeFilterTab === 'unlocked'
                  ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-500/70'
                  : 'text-slate-400 hover:text-white bg-[#16202d] border border-transparent'
              }`}
            >
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              <span>Unlocked ({unlockedCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveFilterTab('locked')}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                activeFilterTab === 'locked'
                  ? 'bg-slate-800 text-slate-200 border border-slate-600'
                  : 'text-slate-400 hover:text-white bg-[#16202d] border border-transparent'
              }`}
            >
              <Lock className="w-3 h-3 text-slate-400" />
              <span>Locked ({lockedCount})</span>
            </button>
            {secretCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveFilterTab('secret')}
                className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                  activeFilterTab === 'secret'
                    ? 'bg-purple-950/70 text-purple-300 border border-purple-500/70'
                    : 'text-slate-400 hover:text-white bg-[#16202d] border border-transparent'
                }`}
              >
                <EyeOff className="w-3 h-3 text-purple-400" />
                <span>Secret ({secretCount})</span>
              </button>
            )}
          </div>

          {/* Search & Sort Controls */}
          <div className="flex items-center gap-2.5">
            <div className="relative flex-1 md:w-56">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                placeholder="Search achievements..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-8 py-1.5 rounded bg-[#16202d] border border-[#2a475e] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-steam-accent"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Sort Selector */}
            <div className="flex items-center gap-1 bg-[#16202d] border border-[#2a475e] rounded px-2 py-1">
              <ArrowUpDown className="w-3 h-3 text-slate-400 shrink-0" />
              <select
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value as SortOption)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer pr-1"
              >
                <option value="default" className="bg-[#16202d] text-white">Default Order</option>
                <option value="unlock_date" className="bg-[#16202d] text-white">Unlock Date (Recent)</option>
                <option value="rarity_rarest" className="bg-[#16202d] text-white">Rarity (Rarest First)</option>
                <option value="rarity_common" className="bg-[#16202d] text-white">Rarity (Most Common)</option>
                <option value="name" className="bg-[#16202d] text-white">Alphabetical (A-Z)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Scrollable Achievements Cards List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
          {isLoading ? (
            <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-steam-accent" />
              <span className="text-xs font-semibold">Loading official storefront achievements...</span>
            </div>
          ) : displayedAchievements.length === 0 ? (
            <div className="py-20 text-center border border-dashed border-[#2a475e] rounded-xl bg-black/20">
              <Trophy className="w-10 h-10 text-slate-600 mx-auto mb-2 opacity-50" />
              <p className="text-sm font-semibold text-slate-300">
                {searchQuery || activeFilterTab !== 'all'
                  ? 'No achievements match your filter'
                  : currentStoreData?.supportsAchievements === false || totalCount === 0
                  ? `This title does not feature achievements on ${STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront}`
                  : 'No achievement records found for this title'}
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                {searchQuery
                  ? 'Try clearing your search query or switching filter tabs.'
                  : currentStoreData?.supportsAchievements === false || totalCount === 0
                  ? 'Classic and retro releases, standalone expansions, or developer tools do not feature achievement tracking.'
                  : 'Achievements for this storefront are pending sync or not configured.'}
              </p>
              {(searchQuery || activeFilterTab !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setActiveFilterTab('all');
                  }}
                  className="mt-3 px-3 py-1.5 rounded bg-[#1b2838] text-xs text-steam-accent font-semibold hover:brightness-110 cursor-pointer"
                >
                  Clear Filters
                </button>
              )}
            </div>
          ) : (
            displayedAchievements.map((ach) => {
              const isUnlocked = ach.unlocked;
              const isSecretHidden = ach.isSecret && !isUnlocked && !revealedSecrets.has(ach.id);

              // Rarity styling
              let rarityBadge = null;
              if (ach.globalPercentage !== undefined) {
                const tier = ach.rarityTier || 'common';
                let tierStyle = 'border-slate-700 bg-slate-900/60 text-slate-300';
                let tierLabel = 'Common';

                if (tier === 'ultra_rare') {
                  tierStyle = 'border-amber-500/60 bg-amber-950/60 text-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.25)]';
                  tierLabel = 'Ultra Rare';
                } else if (tier === 'rare') {
                  tierStyle = 'border-sky-500/60 bg-sky-950/60 text-sky-300 shadow-[0_0_8px_rgba(102,192,244,0.2)]';
                  tierLabel = 'Rare';
                } else if (tier === 'uncommon') {
                  tierStyle = 'border-emerald-500/60 bg-emerald-950/60 text-emerald-300';
                  tierLabel = 'Uncommon';
                }

                rarityBadge = (
                  <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-bold ${tierStyle}`}>
                    {tier === 'ultra_rare' ? (
                      <Flame className="w-3 h-3 text-amber-400 fill-amber-400" />
                    ) : tier === 'rare' ? (
                      <Sparkles className="w-3 h-3 text-sky-400" />
                    ) : null}
                    <span>{ach.globalPercentage}%</span>
                    <span className="text-[9px] opacity-75 font-normal">({tierLabel})</span>
                  </div>
                );
              }

              // Formatted unlock timestamp
              let formattedUnlockDate: string | null = null;
              if (ach.unlockedAt) {
                try {
                  const d = new Date(ach.unlockedAt);
                  if (!isNaN(d.getTime())) {
                    formattedUnlockDate = d.toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                  }
                } catch {}
              }

              return (
                <div
                  key={ach.id}
                  className={`rounded-lg p-3.5 border transition-all duration-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
                    isUnlocked
                      ? 'bg-[#15202e] border-[#2b4b6f] hover:border-steam-accent/70 shadow-md'
                      : 'bg-[#0f1620]/90 border-[#1c2a38] opacity-80 hover:opacity-100 hover:border-slate-600'
                  }`}
                >
                  {/* Left: Icon & Description Details */}
                  <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
                    {/* Achievement Icon */}
                    <div className="relative w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-black/60 border border-white/10 flex items-center justify-center">
                      <img
                        src={isUnlocked ? ach.iconUnlockedUrl : (ach.iconLockedUrl || ach.iconUnlockedUrl)}
                        alt={ach.name}
                        loading="lazy"
                        className={`w-full h-full object-cover transition-transform group-hover:scale-105 ${
                          isUnlocked
                            ? 'filter-none'
                            : 'grayscale contrast-75 brightness-60 opacity-60'
                        }`}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />

                      {/* Locked Overlay Badge */}
                      {!isUnlocked && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                          <div className="w-6 h-6 rounded-full bg-black/80 border border-slate-500/60 flex items-center justify-center text-slate-300 shadow">
                            <Lock className="w-3.5 h-3.5 text-slate-400" />
                          </div>
                        </div>
                      )}

                      {/* Unlocked Checkmark Badge */}
                      {isUnlocked && (
                        <div className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center shadow font-bold">
                          <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                        </div>
                      )}
                    </div>

                    {/* Achievement Text Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4
                          className={`text-sm font-bold truncate ${
                            isUnlocked ? 'text-white' : 'text-slate-300'
                          }`}
                        >
                          {isSecretHidden ? 'Hidden Achievement' : ach.name}
                        </h4>

                        {/* XP Badge if Epic */}
                        {ach.xp !== undefined && (
                          <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-950/80 border border-amber-500/50 text-amber-300">
                            +{ach.xp} XP
                          </span>
                        )}

                        {/* Gamerscore Badge if Xbox */}
                        {ach.gamerscore !== undefined && (
                          <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                            {ach.gamerscore} G
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        {isSecretHidden
                          ? 'Details of this achievement are kept hidden until unlocked in game.'
                          : ach.description || 'No description provided.'}
                      </p>

                      {/* Progress Bar (e.g. 8/10 items collected) */}
                      {ach.progress && !isUnlocked && (
                        <div className="mt-2 max-w-xs">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1 font-semibold">
                            <span>Progress</span>
                            <span className="font-mono text-slate-300">
                              {ach.progress.current} / {ach.progress.max} {ach.progress.unit || ''}
                            </span>
                          </div>
                          <div className="h-1.5 w-full bg-black/60 rounded-full overflow-hidden border border-white/10">
                            <div
                              className="h-full bg-[#66c0f4] rounded-full transition-all"
                              style={{ width: `${ach.progress.percentage}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Unlocked Date & Secret Reveal Button */}
                      <div className="flex items-center gap-3 mt-1.5 text-[11px]">
                        {isUnlocked && formattedUnlockDate && (
                          <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                            <Calendar className="w-3 h-3" />
                            <span>Unlocked {formattedUnlockDate}</span>
                          </span>
                        )}

                        {/* Secret spoiler reveal toggle */}
                        {ach.isSecret && !isUnlocked && (
                          <button
                            type="button"
                            onClick={() => toggleSecretReveal(ach.id)}
                            className="inline-flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300 hover:underline cursor-pointer"
                          >
                            {isSecretHidden ? (
                              <>
                                <Eye className="w-3 h-3" />
                                <span>Reveal Spoiler</span>
                              </>
                            ) : (
                              <>
                                <EyeOff className="w-3 h-3" />
                                <span>Hide Spoiler</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Rarity Percentage Badge */}
                  {rarityBadge && (
                    <div className="self-end sm:self-center shrink-0 flex items-center gap-2">
                      {rarityBadge}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Modal Bottom Footer Bar */}
        <div className="px-6 py-3.5 bg-[#0e1620] border-t border-[#2a475e] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Trophy className="w-4 h-4 text-amber-400" />
            <span>
              Showing {displayedAchievements.length} of {totalCount} achievements
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white hover:border-slate-500 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
