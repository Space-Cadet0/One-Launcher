import React from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import type {
  StorefrontAchievementsData,
  MultiStoreAchievementsMap,
} from '../../contracts/achievement';
import { toOlMediaUrl } from '../../contracts/network';
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
  TrendingUp,
} from 'lucide-react';
import type {
  FilterTab,
  ProgressFillStyle,
  SortOption,
} from './achievementsModalTypes';

export function renderStorefrontTabs(params: {
  availableStorefronts: StorefrontId[];
  activeStorefront: StorefrontId;
  multiStoreData: MultiStoreAchievementsMap;
  tabButtonRefs: React.MutableRefObject<Partial<Record<StorefrontId, HTMLButtonElement | null>>>;
  onSelectStorefront: (storeId: StorefrontId) => void;
}): React.ReactElement {
  const {
    availableStorefronts,
    activeStorefront,
    multiStoreData,
    tabButtonRefs,
    onSelectStorefront,
  } = params;

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    const count = availableStorefronts.length;
    if (count <= 1) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % count;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + count) % count;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = count - 1;
    }

    if (nextIndex === null) return;
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }

    const nextStore = availableStorefronts[nextIndex];
    if (!nextStore) return;
    onSelectStorefront(nextStore);

    const targetBtn = tabButtonRefs.current[nextStore];
    if (targetBtn && typeof targetBtn.focus === 'function') {
      targetBtn.focus();
    }
  };

  return (
    <div className="px-6 py-2.5 bg-[#0c131c] border-b border-[#2a475e]/70 flex items-center gap-2 overflow-x-auto shrink-0">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1 shrink-0">
        Storefront:
      </span>
      <div
        role="tablist"
        aria-label="Storefront achievements"
        className="flex items-center gap-2"
      >
        {availableStorefronts.map((storeId, index) => {
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
              ref={(el) => {
                tabButtonRefs.current[storeId] = el;
              }}
              id={`achievements-storefront-tab-${storeId}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="achievements-list-tabpanel"
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelectStorefront(storeId)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              className={`inline-flex items-center gap-2 min-h-6 px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer shrink-0 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                isActive
                  ? 'bg-[#1b2b3d] text-white border-steam-accent shadow-[0_0_12px_rgba(102,192,244,0.25)]'
                  : 'bg-[#141d27] text-slate-400 hover:text-white border-[#2a475e]/60 hover:bg-[#1b2838]'
              }`}
            >
              <StorefrontIcon storefrontId={storeId} decorative className="w-3.5 h-3.5" />
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
                  {storeId === 'xbox' &&
                    storeData?.totalGamerscore !== undefined &&
                    storeData.totalGamerscore > 0 &&
                    ` • ${storeData.earnedGamerscore || 0}/${storeData.totalGamerscore} G`}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function renderAchievementsProgressHeader(params: {
  activeStorefront: StorefrontId;
  currentStoreData?: StorefrontAchievementsData;
  unlockedCount: number;
  totalCount: number;
  percentage: number;
  isMastered: boolean;
}): React.ReactElement {
  const {
    activeStorefront,
    currentStoreData,
    unlockedCount,
    totalCount,
    percentage,
    isMastered,
  } = params;

  return (
    <div className="px-6 py-4 bg-[#141f2c] border-b border-[#2a475e]/70 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-4">
        <div className="relative w-14 h-14 rounded-full bg-black/50 border-2 border-steam-accent/40 flex items-center justify-center shrink-0 shadow-lg">
          {isMastered ? (
            <div className="relative flex items-center justify-center">
              <Trophy
                className="w-7 h-7 text-amber-300 fill-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.8)]"
                aria-hidden="true"
              />
              <Sparkles
                className="w-3.5 h-3.5 text-yellow-200 absolute -top-1 -right-1 animate-pulse"
                aria-hidden="true"
              />
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
                <Trophy className="w-3 h-3 fill-amber-400" aria-hidden="true" />
                Mastered 100%
              </span>
            )}
          </div>

          <progress
            className="ol-setup-progress w-56 sm:w-72 h-2 block mt-1.5"
            value={Math.min(Math.max(0, unlockedCount), Math.max(1, totalCount))}
            max={Math.max(1, totalCount)}
            aria-label={`${unlockedCount} of ${totalCount} achievements unlocked`}
            style={
              isMastered
                ? ({
                    '--ol-progress-fill':
                      'linear-gradient(90deg, #fbbf24 0%, #fde047 100%)',
                  } as ProgressFillStyle)
                : undefined
            }
          />

          {currentStoreData?.totalXp !== undefined && currentStoreData.totalXp > 0 && (
            <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-300">
              <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" aria-hidden="true" />
              <span className="font-semibold text-white">
                {currentStoreData.earnedXp || 0} / {currentStoreData.totalXp} XP
              </span>
              <span className="text-[10px] text-slate-400">Epic Games XP</span>
            </div>
          )}
          {currentStoreData?.totalGamerscore !== undefined &&
            currentStoreData.totalGamerscore > 0 && (
              <div
                data-testid="achievements-modal-xbox-gamerscore"
                className="flex items-center gap-2 mt-1.5 text-xs text-slate-300"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-400 text-slate-950 text-[10px] font-black leading-none shadow-sm shrink-0"
                >
                  G
                </span>
                <span className="font-semibold text-white font-mono">
                  {(currentStoreData.earnedGamerscore || 0).toLocaleString()} /{' '}
                  {currentStoreData.totalGamerscore.toLocaleString()} G
                </span>
                <span className="text-[10px] text-emerald-300/90">Xbox Gamerscore</span>
              </div>
            )}
        </div>
      </div>

      <div className="flex items-center gap-2 self-start sm:self-center">
        <span className="text-[11px] text-slate-300 flex items-center gap-1.5 bg-black/30 px-2.5 py-1 rounded border border-[#2a475e]/60">
          <StorefrontIcon storefrontId={activeStorefront} decorative className="w-3.5 h-3.5" />
          <span>{STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront} Catalog</span>
        </span>
      </div>
    </div>
  );
}

export function renderAchievementsToolbar(params: {
  activeFilterTab: FilterTab;
  setActiveFilterTab: (tab: FilterTab) => void;
  isSummaryCountOnly: boolean;
  totalCount: number;
  unlockedCount: number;
  lockedCount: number;
  inProgressCount: number;
  secretCount: number;
  lockedSecretCount: number;
  allSecretsRevealed: boolean;
  toggleRevealAllSecrets: () => void;
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  sortOption: SortOption;
  setSortOption: (val: SortOption) => void;
}): React.ReactElement {
  const {
    activeFilterTab,
    setActiveFilterTab,
    isSummaryCountOnly,
    totalCount,
    unlockedCount,
    lockedCount,
    inProgressCount,
    secretCount,
    lockedSecretCount,
    allSecretsRevealed,
    toggleRevealAllSecrets,
    searchQuery,
    setSearchQuery,
    sortOption,
    setSortOption,
  } = params;

  return (
    <div
      data-testid="achievements-toolbar"
      className="px-6 py-3 bg-[#111923] border-b border-[#2a475e]/60 flex flex-col gap-2.5 shrink-0"
    >
      {/* Row 1: Status Filter Pills & Secret Reveal Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          data-testid="achievements-filter-tabs"
          role="group"
          aria-label="Filter achievements by status"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            aria-pressed={activeFilterTab === 'all'}
            onClick={() => setActiveFilterTab('all')}
            className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
              activeFilterTab === 'all'
                ? 'bg-[#1b2b3d] text-white border border-steam-accent/70'
                : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
            }`}
          >
            All ({totalCount})
          </button>
          {!isSummaryCountOnly && (
            <>
              <button
                type="button"
                aria-pressed={activeFilterTab === 'unlocked'}
                onClick={() => setActiveFilterTab('unlocked')}
                className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                  activeFilterTab === 'unlocked'
                    ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-500/70'
                    : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                }`}
              >
                <CheckCircle2 className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                <span>Unlocked ({unlockedCount})</span>
              </button>
              <button
                type="button"
                aria-pressed={activeFilterTab === 'locked'}
                onClick={() => setActiveFilterTab('locked')}
                className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                  activeFilterTab === 'locked'
                    ? 'bg-slate-800 text-slate-200 border border-slate-600'
                    : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                }`}
              >
                <Lock className="w-3 h-3 text-slate-300" aria-hidden="true" />
                <span>Locked ({lockedCount})</span>
              </button>
              {inProgressCount > 0 && (
                <button
                  type="button"
                  aria-pressed={activeFilterTab === 'in_progress'}
                  onClick={() => setActiveFilterTab('in_progress')}
                  className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                    activeFilterTab === 'in_progress'
                      ? 'bg-sky-950/70 text-sky-200 border border-sky-400/70'
                      : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                  }`}
                >
                  <TrendingUp className="w-3 h-3 text-sky-400" aria-hidden="true" />
                  <span>In Progress ({inProgressCount})</span>
                </button>
              )}
            </>
          )}
          {secretCount > 0 && (
            <button
              type="button"
              aria-pressed={activeFilterTab === 'secret'}
              onClick={() => setActiveFilterTab('secret')}
              className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                activeFilterTab === 'secret'
                  ? 'bg-purple-950/70 text-purple-300 border border-purple-500/70'
                  : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
              }`}
            >
              <EyeOff className="w-3 h-3 text-purple-400" aria-hidden="true" />
              <span>Secret ({secretCount})</span>
            </button>
          )}
        </div>

        {!isSummaryCountOnly && secretCount > 0 && lockedSecretCount > 0 && (
          <button
            type="button"
            aria-pressed={allSecretsRevealed}
            onClick={toggleRevealAllSecrets}
            className="min-h-6 px-2.5 py-1.5 rounded text-xs font-semibold text-purple-200 hover:text-white bg-purple-950/40 hover:bg-purple-950/70 border border-purple-500/40 transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
          >
            {allSecretsRevealed ? (
              <>
                <EyeOff className="w-3 h-3 text-purple-300" aria-hidden="true" />
                <span>Hide All Secrets</span>
              </>
            ) : (
              <>
                <Eye className="w-3 h-3 text-purple-300" aria-hidden="true" />
                <span>Reveal All Secrets</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Row 2: Search & Sort Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
        <div className="relative flex-1">
          <Search
            className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            aria-label="Search achievements"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search achievements..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-1.5 rounded bg-[#16202d] border border-[#2a475e] text-xs text-white placeholder-slate-400 focus:outline-none focus:border-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent/60"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear achievement search"
              onClick={() => setSearchQuery('')}
              className="min-w-6 min-h-6 flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Sort Selector */}
        <div className="flex items-center gap-1 bg-[#16202d] border border-[#2a475e] rounded px-2 py-1 sm:w-52 shrink-0 focus-within:border-steam-accent focus-within:ring-2 focus-within:ring-steam-accent/60">
          <ArrowUpDown className="w-3 h-3 text-slate-400 shrink-0" aria-hidden="true" />
          <select
            aria-label="Sort achievements"
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as SortOption)}
            className="w-full bg-transparent text-xs text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded cursor-pointer pr-1"
          >
            <option value="default" className="bg-[#16202d] text-white">
              Default Order
            </option>
            <option value="closest_progress" className="bg-[#16202d] text-white">
              Closest to Unlock
            </option>
            <option value="unlock_date" className="bg-[#16202d] text-white">
              Unlock Date (Recent)
            </option>
            <option value="rarity_rarest" className="bg-[#16202d] text-white">
              Rarity (Rarest First)
            </option>
            <option value="rarity_common" className="bg-[#16202d] text-white">
              Rarity (Most Common)
            </option>
            <option value="name" className="bg-[#16202d] text-white">
              Alphabetical (A-Z)
            </option>
          </select>
        </div>
      </div>
    </div>
  );
}

export function renderAchievementCard(params: {
  ach: StorefrontAchievementsData['achievements'][number];
  idx: number;
  game: CanonicalGame;
  activeStorefront: StorefrontId;
  isSummaryCountOnly: boolean;
  revealedSecrets: Set<string>;
  failedIconKeys: Set<string>;
  onToggleSecretReveal: (id: string) => void;
  onMarkIconFailed: (iconKey: string) => void;
}): React.ReactElement {
  const {
    ach,
    idx,
    game,
    activeStorefront,
    isSummaryCountOnly,
    revealedSecrets,
    failedIconKeys,
    onToggleSecretReveal,
    onMarkIconFailed,
  } = params;

  const isUnlocked = ach.unlocked;
  const isSecretHidden = ach.isSecret && !isUnlocked && !revealedSecrets.has(ach.id);

  let rarityBadge: React.ReactElement | null = null;
  if (ach.globalPercentage !== undefined) {
    const tier = ach.rarityTier || 'common';
    let tierStyle = 'border-slate-700 bg-slate-900/60 text-slate-300';
    let tierLabel = 'Common';

    if (tier === 'ultra_rare') {
      tierStyle =
        'border-amber-500/60 bg-amber-950/60 text-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.25)]';
      tierLabel = 'Ultra Rare';
    } else if (tier === 'rare') {
      tierStyle =
        'border-sky-500/60 bg-sky-950/60 text-sky-300 shadow-[0_0_8px_rgba(102,192,244,0.2)]';
      tierLabel = 'Rare';
    } else if (tier === 'uncommon') {
      tierStyle = 'border-emerald-500/60 bg-emerald-950/60 text-emerald-300';
      tierLabel = 'Uncommon';
    }

    rarityBadge = (
      <div
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-bold ${tierStyle}`}
      >
        {tier === 'ultra_rare' ? (
          <Flame className="w-3 h-3 text-amber-400 fill-amber-400" aria-hidden="true" />
        ) : tier === 'rare' ? (
          <Sparkles className="w-3 h-3 text-sky-400" aria-hidden="true" />
        ) : null}
        <span>{ach.globalPercentage}%</span>
        <span className="text-[9px] opacity-75 font-normal">({tierLabel})</span>
      </div>
    );
  }

  let formattedUnlockDate: string | null = null;
  if (ach.unlockedAt) {
    try {
      const d = new Date(ach.unlockedAt);
      if (!Number.isNaN(d.getTime())) {
        formattedUnlockDate = d.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    } catch {
      // Ignore malformed dates
    }
  }

  const rawIconSrc =
    isUnlocked || isSummaryCountOnly
      ? ach.iconUnlockedUrl || ach.iconLockedUrl
      : ach.iconLockedUrl || ach.iconUnlockedUrl;
  const resolvedIconSrc = rawIconSrc
    ? toOlMediaUrl({
        url: rawIconSrc,
        gameId: game.id,
        role: 'achievement_icon',
        ordinal: 1,
      })
    : '';
  const iconKey = `${activeStorefront}:${ach.id}:${isUnlocked ? 'u' : isSummaryCountOnly ? 's' : 'l'}`;
  const isIconFailed = !resolvedIconSrc || failedIconKeys.has(iconKey);

  return (
    <div
      key={`${activeStorefront}:${ach.id || idx}`}
      className={`rounded-lg p-3.5 border transition-all duration-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
        isUnlocked
          ? 'bg-[#15202e] border-[#2b4b6f] hover:border-steam-accent/70 shadow-md'
          : isSummaryCountOnly
            ? 'bg-[#121c28] border-[#223447] hover:border-slate-500'
            : 'bg-[#0f1620]/90 border-[#1c2a38] opacity-80 hover:opacity-100 hover:border-slate-600'
      }`}
    >
      <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
        <div className="relative w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-black/60 border border-white/10 flex items-center justify-center">
          {!isIconFailed ? (
            <img
              src={resolvedIconSrc}
              alt={isSecretHidden ? 'Hidden Achievement' : ach.name}
              loading="lazy"
              decoding="async"
              className={`w-full h-full object-cover transition-transform group-hover:scale-105 ${
                isSecretHidden
                  ? 'grayscale contrast-75 brightness-50 opacity-50 blur-[2px]'
                  : isUnlocked || isSummaryCountOnly
                    ? 'filter-none'
                    : 'grayscale contrast-75 brightness-60 opacity-60'
              }`}
              onError={() => onMarkIconFailed(iconKey)}
            />
          ) : (
            <Trophy
              className={`w-6 h-6 ${isUnlocked ? 'text-amber-400/80' : 'text-slate-400'}`}
              aria-hidden="true"
            />
          )}

          {!isUnlocked && !isSummaryCountOnly && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="w-6 h-6 rounded-full bg-black/80 border border-slate-500/60 flex items-center justify-center text-slate-300 shadow">
                <Lock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              </div>
            </div>
          )}

          {isUnlocked && (
            <div className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center shadow font-bold">
              <CheckCircle2 className="w-3.5 h-3.5 text-white" aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3
              className={`text-sm font-bold truncate ${
                isUnlocked || isSummaryCountOnly ? 'text-white' : 'text-slate-300'
              }`}
            >
              {isSecretHidden ? 'Hidden Achievement' : ach.name}
            </h3>

            {ach.isSecret && !isUnlocked && (
              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-purple-950/80 border border-purple-500/50 text-purple-300">
                Secret
              </span>
            )}

            {ach.isBaseGame === false && (
              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-indigo-950/80 border border-indigo-400/50 text-indigo-200">
                DLC
              </span>
            )}

            {ach.xp !== undefined && (
              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-950/80 border border-amber-500/50 text-amber-300">
                +{ach.xp} XP
              </span>
            )}

            {ach.gamerscore !== undefined && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-emerald-400 text-slate-950 text-[8px] font-black leading-none"
                >
                  G
                </span>
                <span>{ach.gamerscore}</span>
              </span>
            )}
          </div>

          {isSecretHidden ? (
            <button
              type="button"
              onClick={() => onToggleSecretReveal(ach.id)}
              className="mt-1 text-left text-xs text-slate-300 leading-relaxed group/spoiler cursor-pointer min-h-6 inline-flex items-center gap-1.5"
              title="Click to reveal hidden achievement details"
            >
              <span className="blur-[3px] select-none opacity-75 group-hover/spoiler:blur-[2px] transition-all">
                Details of this achievement are kept hidden until unlocked in game.
              </span>
            </button>
          ) : (
            <p className="text-xs text-slate-300 mt-1 leading-relaxed">
              {ach.description || 'No description provided.'}
            </p>
          )}

          {ach.progress && !isUnlocked && ach.progress.max > 0 && (
            <div className="mt-2 max-w-xs">
              <div className="flex items-center justify-between text-[10px] text-slate-300 mb-1 font-semibold">
                <span>Progress</span>
                <span className="font-mono text-slate-200">
                  {ach.progress.unit === '%' ? (
                    `${ach.progress.percentage}%`
                  ) : (
                    <>
                      {ach.progress.current} / {ach.progress.max}
                      {ach.progress.unit ? ` ${ach.progress.unit}` : ''}{' '}
                      <span className="text-sky-300">({ach.progress.percentage}%)</span>
                    </>
                  )}
                </span>
              </div>
              <progress
                className="ol-setup-progress h-1.5 w-full block"
                value={Math.min(
                  Math.max(0, ach.progress.current),
                  Math.max(1, ach.progress.max)
                )}
                max={Math.max(1, ach.progress.max)}
                aria-label={
                  isSecretHidden ? 'Hidden achievement progress' : `${ach.name} progress`
                }
              />
            </div>
          )}

          <div className="flex items-center gap-3 mt-1.5 text-[11px]">
            {isUnlocked && formattedUnlockDate && (
              <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                <Calendar className="w-3 h-3" aria-hidden="true" />
                <span>Unlocked {formattedUnlockDate}</span>
              </span>
            )}

            {ach.isSecret && !isUnlocked && (
              <button
                type="button"
                onClick={() => onToggleSecretReveal(ach.id)}
                className="min-h-6 px-1 inline-flex items-center gap-1 text-[10px] text-purple-300 hover:text-purple-200 hover:underline cursor-pointer"
              >
                {isSecretHidden ? (
                  <>
                    <Eye className="w-3 h-3" aria-hidden="true" />
                    <span>Reveal Spoiler</span>
                  </>
                ) : (
                  <>
                    <EyeOff className="w-3 h-3" aria-hidden="true" />
                    <span>Hide Spoiler</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {rarityBadge && (
        <div className="self-end sm:self-center shrink-0 flex items-center gap-2">
          {rarityBadge}
        </div>
      )}
    </div>
  );
}
