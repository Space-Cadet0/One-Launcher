import React from 'react';
import {
  AlertTriangle,
  EyeOff,
  Layers,
  Search,
  ShieldAlert,
  Sliders,
  Wand,
  X,
} from 'lucide-react';
import { FilterTab } from './matchManagerTypes';

const STUDIO_TAB_ORDER: readonly FilterTab[] = [
  'all',
  'unmatched',
  'low_confidence',
  'user_suppressed',
  'suppressed',
  'overrides',
  'merged',
];

export interface MatchManagerHeaderTabsContext {
  titleId: string;
  panelId?: string;
  searchInputId: string;
  activeTab: FilterTab;
  setActiveTab: (tab: FilterTab) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onClose: () => void;
  unmatchedCount: number;
  lowConfidenceCount: number;
  userSuppressedCount: number;
  unreviewedAutoFilteredCount: number;
  confirmedAutoFilteredCount: number;
  overrideCount: number;
  mergedCount: number;
}

export function renderMatchManagerHeaderAndTabs(
  ctx: MatchManagerHeaderTabsContext
): React.ReactNode {
  const {
    titleId,
    panelId,
    searchInputId,
    activeTab,
    setActiveTab,
    searchQuery,
    setSearchQuery,
    onClose,
    unmatchedCount,
    lowConfidenceCount,
    userSuppressedCount,
    unreviewedAutoFilteredCount,
    confirmedAutoFilteredCount,
    overrideCount,
    mergedCount,
  } = ctx;

  const handleTabListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = STUDIO_TAB_ORDER.indexOf(activeTab);
    if (currentIndex === -1) return;
    let nextIndex = -1;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % STUDIO_TAB_ORDER.length;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + STUDIO_TAB_ORDER.length) % STUDIO_TAB_ORDER.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = STUDIO_TAB_ORDER.length - 1;
    }
    if (nextIndex !== -1) {
      e.preventDefault();
      const nextTab = STUDIO_TAB_ORDER[nextIndex];
      setActiveTab(nextTab);
      const btn = e.currentTarget.querySelector<HTMLButtonElement>(
        `button[data-tab-id="${nextTab}"]`
      );
      btn?.focus();
    }
  };

  return (
    <>
      {/* Modal Header */}
      <div className="px-6 py-4 border-b border-[#2a475e]/80 flex items-center justify-between bg-[#131c27]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center text-[#66c0f4] shadow-inner">
            <Sliders aria-hidden="true" className="w-5 h-5" />
          </div>
          <div>
            <h2
              id={titleId}
              className="text-base font-bold text-white tracking-wide flex items-center gap-2"
            >
              <span>Library Match &amp; Overrides Studio</span>
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40">
                Catalog Inspector
              </span>
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Inspect unmatched &amp; low-confidence games, restore user-suppressed or auto-filtered non-game entries, manage manual overrides, and split or customize multi-storefront merges
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="min-w-6 min-h-6 p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-[#1b2838] transition-colors cursor-pointer flex items-center justify-center"
          title="Close Studio (Esc)"
          aria-label="Close Studio"
        >
          <X aria-hidden="true" className="w-5 h-5" />
        </button>
      </div>

      {/* Studio Tab Bar & Search Toolbar */}
      <div className="px-6 pt-3 pb-0 border-b border-[#2a475e]/80 bg-[#141d28] flex flex-col gap-2.5">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-2.5">
          {/* Docked Studio Tab Bar */}
          <div
            role="tablist"
            aria-label="Library Match Studio Tabs"
            onKeyDown={handleTabListKeyDown}
            className="flex items-end gap-1 flex-wrap"
          >
            <button
              type="button"
              id={`${titleId}-tab-all`}
              role="tab"
              aria-selected={activeTab === 'all'}
              aria-controls={panelId}
              tabIndex={activeTab === 'all' ? 0 : -1}
              data-tab-id="all"
              onClick={() => setActiveTab('all')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-[#66c0f4] shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <span>All Sections</span>
            </button>

            <button
              type="button"
              id={`${titleId}-tab-unmatched`}
              role="tab"
              aria-selected={activeTab === 'unmatched'}
              aria-controls={panelId}
              tabIndex={activeTab === 'unmatched' ? 0 : -1}
              data-tab-id="unmatched"
              onClick={() => setActiveTab('unmatched')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'unmatched'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-amber-400 shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
              <span>Unmatched ({unmatchedCount})</span>
            </button>

            <button
              type="button"
              id={`${titleId}-tab-low_confidence`}
              role="tab"
              aria-selected={activeTab === 'low_confidence'}
              aria-controls={panelId}
              tabIndex={activeTab === 'low_confidence' ? 0 : -1}
              data-tab-id="low_confidence"
              onClick={() => setActiveTab('low_confidence')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'low_confidence'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-orange-400 shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <ShieldAlert aria-hidden="true" className="w-3.5 h-3.5 text-orange-400" />
              <span>Low-Confidence ({lowConfidenceCount})</span>
            </button>

            <button
              type="button"
              id={`${titleId}-tab-user_suppressed`}
              role="tab"
              aria-selected={activeTab === 'user_suppressed'}
              aria-controls={panelId}
              tabIndex={activeTab === 'user_suppressed' ? 0 : -1}
              data-tab-id="user_suppressed"
              onClick={() => setActiveTab('user_suppressed')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'user_suppressed'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-indigo-400 shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <EyeOff aria-hidden="true" className="w-3.5 h-3.5 text-indigo-400" />
              <span>User-Suppressed ({userSuppressedCount})</span>
            </button>

            <button
              type="button"
              id={`${titleId}-tab-suppressed`}
              role="tab"
              aria-selected={activeTab === 'suppressed'}
              aria-controls={panelId}
              tabIndex={activeTab === 'suppressed' ? 0 : -1}
              data-tab-id="suppressed"
              onClick={() => setActiveTab('suppressed')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'suppressed'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-rose-400 shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <EyeOff aria-hidden="true" className="w-3.5 h-3.5 text-rose-400" />
              <span>Auto-Filtered Non-Games ({unreviewedAutoFilteredCount})</span>
              {confirmedAutoFilteredCount > 0 && (
                <span
                  className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  title={`${confirmedAutoFilteredCount} confirmed non-game entries`}
                >
                  ✓ {confirmedAutoFilteredCount}
                </span>
              )}
            </button>

            <button
              type="button"
              id={`${titleId}-tab-overrides`}
              role="tab"
              aria-selected={activeTab === 'overrides'}
              aria-controls={panelId}
              tabIndex={activeTab === 'overrides' ? 0 : -1}
              data-tab-id="overrides"
              onClick={() => setActiveTab('overrides')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'overrides'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-sky-400 shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <Wand aria-hidden="true" className="w-3.5 h-3.5 text-sky-400" />
              <span>Manual Overrides ({overrideCount})</span>
            </button>

            <button
              type="button"
              id={`${titleId}-tab-merged`}
              role="tab"
              aria-selected={activeTab === 'merged'}
              aria-controls={panelId}
              tabIndex={activeTab === 'merged' ? 0 : -1}
              data-tab-id="merged"
              onClick={() => setActiveTab('merged')}
              className={`min-h-6 px-3.5 py-2 rounded-t-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'merged'
                  ? 'bg-[#1b2838] text-white border-t border-x border-[#2a475e] border-b-2 border-b-emerald-400 shadow-sm'
                  : 'bg-[#121a24]/70 text-slate-300 hover:text-white hover:bg-[#172230] border-t border-x border-transparent border-b-2 border-b-transparent'
              }`}
            >
              <Layers aria-hidden="true" className="w-3.5 h-3.5 text-emerald-400" />
              <span>Merged Multi-Store ({mergedCount})</span>
            </button>
          </div>

          {/* Search Input */}
          <search className="relative w-full lg:w-64 pb-2">
            <label htmlFor={searchInputId} className="sr-only">
              Filter match studio entries
            </label>
            <Search
              aria-hidden="true"
              className="w-4 h-4 absolute left-3 top-[15px] -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              id={searchInputId}
              type="search"
              autoFocus
              aria-label="Filter match studio entries"
              autoComplete="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by title, storefront, or ID..."
              className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#131c27] border border-[#2a475e] text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#66c0f4] transition-colors [&::-webkit-search-cancel-button]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear match studio filter"
                onClick={() => setSearchQuery('')}
                className="min-w-6 min-h-6 absolute right-1.5 top-[15px] -translate-y-1/2 text-slate-300 hover:text-white cursor-pointer flex items-center justify-center rounded"
              >
                <X aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}
          </search>
        </div>
      </div>
    </>
  );
}

export interface MatchManagerFooterContext {
  totalGamesCount: number;
  unmatchedCount: number;
  lowConfidenceCount: number;
  overrideCount: number;
  userSuppressedCount: number;
  unreviewedAutoFilteredCount: number;
  confirmedAutoFilteredCount: number;
  onClose: () => void;
}

export function renderMatchManagerFooter(ctx: MatchManagerFooterContext): React.ReactNode {
  return (
    <div className="px-6 py-3.5 border-t border-[#2a475e]/80 bg-[#131c27] flex items-center justify-between text-xs text-slate-300">
      <span>
        Active Catalog: <strong className="text-white">{ctx.totalGamesCount}</strong> canonical titles •{' '}
        <strong className="text-amber-300">{ctx.unmatchedCount}</strong> unmatched •{' '}
        <strong className="text-orange-300">{ctx.lowConfidenceCount}</strong> low-confidence •{' '}
        <strong className="text-sky-300">{ctx.overrideCount}</strong> manual overrides •{' '}
        <strong className="text-indigo-300">{ctx.userSuppressedCount}</strong> user-suppressed •{' '}
        <strong className="text-rose-300">{ctx.unreviewedAutoFilteredCount}</strong> pending non-games •{' '}
        <strong className="text-emerald-300">{ctx.confirmedAutoFilteredCount}</strong> confirmed non-games
      </span>
      <button
        type="button"
        onClick={ctx.onClose}
        className="min-h-6 px-4 py-1.5 rounded-md bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-slate-200 hover:text-white font-semibold transition-colors cursor-pointer"
      >
        Done
      </button>
    </div>
  );
}
