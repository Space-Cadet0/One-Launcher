import React from 'react';
import { Search, Sliders, X } from 'lucide-react';
import { FilterTab } from './matchManagerTypes';

export const STUDIO_TAB_ORDER: readonly FilterTab[] = [
  'needs_attention',
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
    overrideCount,
    mergedCount,
  } = ctx;

  const needsAttentionCount = unmatchedCount + lowConfidenceCount;

  const studioTabs: ReadonlyArray<{ id: FilterTab; label: string }> = [
    { id: 'needs_attention', label: `Needs Attention (${needsAttentionCount})` },
    { id: 'user_suppressed', label: `User-Suppressed (${userSuppressedCount})` },
    { id: 'suppressed', label: `Auto-Filtered Non-Games (${unreviewedAutoFilteredCount})` },
    { id: 'overrides', label: `Manual Overrides (${overrideCount})` },
    { id: 'merged', label: `Merged Multi-Store (${mergedCount})` },
  ];

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
      <div className="px-6 py-4 border-b border-steam-border/60 flex flex-wrap items-center justify-between gap-3 bg-[#16202d]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded bg-steam-accent/15 border border-steam-accent/30 text-steam-accent shrink-0">
            <Sliders aria-hidden="true" className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-lg font-bold text-white flex items-center gap-2 flex-wrap"
            >
              <span>Library Match &amp; Overrides Studio</span>
            </h2>
            <p className="text-xs text-steam-subtext">
              Review unmatched or uncertain games, manage custom overrides, and restore hidden titles
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {/* Search Input */}
          <search className="relative flex-1 sm:flex-initial sm:w-64">
            <label htmlFor={searchInputId} className="sr-only">
              Filter match studio entries
            </label>
            <Search
              aria-hidden="true"
              className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
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
              placeholder="Filter by title, store, or ID..."
              className="w-full pl-9 pr-8 py-1.5 rounded-md bg-[#121922] border border-steam-border text-xs text-white placeholder-slate-400 focus:outline-none focus:border-steam-accent transition-colors [&::-webkit-search-cancel-button]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear match studio filter"
                onClick={() => setSearchQuery('')}
                className="min-w-6 min-h-6 absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-white cursor-pointer flex items-center justify-center rounded"
              >
                <X aria-hidden="true" className="w-3.5 h-3.5" />
              </button>
            )}
          </search>

          <button
            type="button"
            onClick={onClose}
            className="min-w-6 min-h-6 inline-flex items-center justify-center p-1.5 rounded hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer shrink-0"
            title="Close Studio (Esc)"
            aria-label="Close Studio"
          >
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Studio Navigation Tabs (matches Accounts / IntegrationsModal appearance without status dots) */}
      <div
        role="tablist"
        aria-label="Library Match Studio Tabs"
        onKeyDown={handleTabListKeyDown}
        className="flex border-b border-steam-border/40 bg-[#121922] px-6 pt-3 gap-2 overflow-x-auto"
      >
        {studioTabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              id={`${titleId}-tab-${tab.id}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              data-tab-id={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-6 flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t border-t border-x transition-colors relative cursor-pointer whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-steam-accent ${
                isActive
                  ? 'bg-[#1b2838] border-steam-border text-white border-b-transparent shadow-md forced-colors:border-[Highlight]'
                  : 'bg-black/20 border-transparent text-steam-subtext hover:text-white hover:bg-white/5'
              }`}
            >
              <span>{tab.label}</span>
            </button>
          );
        })}
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
    <div className="px-6 py-3.5 border-t border-steam-border/60 bg-[#16202d] flex items-center justify-between text-xs text-slate-300">
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
