import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import { ModalShell } from '../Common/ModalShell';
import { VirtualListRows } from '../Common/VirtualContainers';
import { Trophy, X, Loader2, RefreshCw } from 'lucide-react';
import {
  resolveNoAchievementsSubtitle,
  type GameAchievementsModalProps,
} from './achievementsModalTypes';
import { useAchievementsLoader } from './useAchievementsLoader';
import { useAchievementsFilterSort } from './useAchievementsFilterSort';
import {
  renderAchievementCard,
  renderAchievementsProgressHeader,
  renderAchievementsToolbar,
  renderStorefrontTabs,
} from './achievementsModalViews';

export type { GameAchievementsModalProps };

export const GameAchievementsModal: React.FC<GameAchievementsModalProps> = ({
  isOpen,
  game,
  initialStorefrontId,
  onClose,
}) => {
  const [listClientHeight, setListClientHeight] = useState(0);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Partial<Record<StorefrontId, HTMLButtonElement | null>>>({});
  const resetFilterUiRef = useRef<() => void>(() => {});

  const handleResetFilterUi = useCallback(() => {
    resetFilterUiRef.current();
  }, []);

  const {
    multiStoreData,
    availableStorefronts,
    activeStorefront,
    setActiveStorefront,
    isLoading,
    isRefreshing,
    isOnline,
    failedIconKeys,
    markIconFailed,
    handleManualRefresh,
  } = useAchievementsLoader({
    isOpen,
    game,
    initialStorefrontId,
    onResetFilterUi: handleResetFilterUi,
  });

  const {
    currentStoreData,
    isSummaryCountOnly,
    searchQuery,
    setSearchQuery,
    activeFilterTab,
    setActiveFilterTab,
    sortOption,
    setSortOption,
    revealedSecrets,
    lockedSecretIds,
    allSecretsRevealed,
    toggleSecretReveal,
    toggleRevealAllSecrets,
    resetFilterUi,
    inProgressCount,
    displayedAchievements,
    totalCount,
    unlockedCount,
    percentage,
    isMastered,
    lockedCount,
    secretCount,
    isSchemaUnavailableOffline,
  } = useAchievementsFilterSort(multiStoreData[activeStorefront], isOnline);

  resetFilterUiRef.current = resetFilterUi;

  const handleSelectStorefront = useCallback(
    (storeId: StorefrontId) => {
      setActiveStorefront(storeId);
      setActiveFilterTab('all');
      if (listScrollRef.current) {
        listScrollRef.current.scrollTop = 0;
      }
    },
    [setActiveStorefront, setActiveFilterTab]
  );

  useEffect(() => {
    if (!isOpen) return;
    const scrollEl = listScrollRef.current;
    if (!scrollEl) return;
    const syncHeight = () => {
      const next = scrollEl.clientHeight || 0;
      setListClientHeight((prev) => (prev === next ? prev : next));
    };
    syncHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncHeight);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [isOpen]);

  if (!isOpen || !game) return null;

  const hasMultipleStorefronts = availableStorefronts.length > 1;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy="achievements-modal-title"
      className="w-full max-w-4xl"
    >
      <div
        className="relative w-full max-w-4xl bg-[#101822] border border-[#2a475e] rounded-xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden text-steam-text"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Banner */}
        <div className="relative border-b border-[#2a475e] bg-gradient-to-r from-[#172435] via-[#101822] to-[#14202d] px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500/20 to-amber-700/10 border border-amber-500/40 flex items-center justify-center shadow-inner shrink-0">
              <Trophy className="w-5 h-5 text-amber-400 fill-amber-400/20" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2
                  id="achievements-modal-title"
                  className="text-lg font-bold text-white truncate tracking-wide"
                >
                  {game.title}
                </h2>
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Achievements
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 truncate">
                Official individual achievement media, global player percentages &amp; unlock history
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isRefreshing && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-sky-950/60 border border-sky-500/40 text-[11px] font-semibold text-sky-200"
              >
                <Loader2 className="w-3 h-3 animate-spin text-sky-300" aria-hidden="true" />
                <span>Refreshing...</span>
              </span>
            )}
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={isLoading || isRefreshing || !isOnline}
              aria-label="Refresh achievements"
              className="min-w-6 min-h-6 p-1.5 rounded-lg inline-flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
              title="Refresh achievements from storefront"
            >
              <RefreshCw
                className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close achievements modal"
              className="min-w-6 min-h-6 p-1.5 rounded-lg inline-flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
              title="Close"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Storefront Selection Tabs (Only shown if multiple owned storefronts exist) */}
        {hasMultipleStorefronts &&
          renderStorefrontTabs({
            availableStorefronts,
            activeStorefront,
            multiStoreData,
            tabButtonRefs,
            onSelectStorefront: handleSelectStorefront,
          })}

        {/* Master Showcase Progress Bar Header */}
        {renderAchievementsProgressHeader({
          activeStorefront,
          currentStoreData,
          unlockedCount,
          totalCount,
          percentage,
          isMastered,
        })}

        {/* Summary-Count-Only Precision Banner */}
        {isSummaryCountOnly && totalCount > 0 && (
          <div
            role="status"
            data-testid="achievements-summary-precision-banner"
            className="px-6 py-2.5 bg-sky-950/35 border-b border-sky-500/35 text-xs text-sky-200 flex items-center gap-2.5 shrink-0"
          >
            <Trophy className="w-4 h-4 text-sky-300 shrink-0" aria-hidden="true" />
            <span>
              <strong className="text-white">Verified Summary Progress:</strong>{' '}
              {STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront} provides your
              aggregate unlock total ({unlockedCount} of {totalCount} unlocked), while individual
              per-achievement unlock states and timestamps are not exposed by this storefront
              endpoint.
            </span>
          </div>
        )}

        {/* Toolbar: Filter Pills & Search + Sort Controls */}
        {renderAchievementsToolbar({
          activeFilterTab,
          setActiveFilterTab,
          isSummaryCountOnly,
          totalCount,
          unlockedCount,
          lockedCount,
          inProgressCount,
          secretCount,
          lockedSecretCount: lockedSecretIds.length,
          allSecretsRevealed,
          toggleRevealAllSecrets,
          searchQuery,
          setSearchQuery,
          sortOption,
          setSortOption,
        })}

        {/* Scrollable Achievements Cards List */}
        <div
          id="achievements-list-tabpanel"
          role={hasMultipleStorefronts ? 'tabpanel' : undefined}
          aria-labelledby={
            hasMultipleStorefronts
              ? `achievements-storefront-tab-${activeStorefront}`
              : undefined
          }
          ref={listScrollRef}
          className="flex-1 overflow-y-auto p-6 space-y-3"
        >
          {isLoading ? (
            <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-steam-accent" aria-hidden="true" />
              <span className="text-xs font-semibold">
                Loading official storefront achievements...
              </span>
            </div>
          ) : displayedAchievements.length === 0 ? (
            <div className="py-20 text-center border border-dashed border-[#2a475e] rounded-xl bg-black/20 px-4">
              <Trophy
                className="w-10 h-10 text-slate-600 mx-auto mb-2 opacity-50"
                aria-hidden="true"
              />
              <p className="text-sm font-semibold text-slate-200">
                {isSchemaUnavailableOffline
                  ? 'Detailed achievement icons and descriptions will sync automatically when online'
                  : isSummaryCountOnly && totalCount > 0 && !searchQuery
                  ? `Verified summary progress: ${unlockedCount} of ${totalCount} (${percentage}%) unlocked`
                  : searchQuery || activeFilterTab !== 'all'
                  ? 'No achievements match your filter'
                  : currentStoreData?.supportsAchievements === false || totalCount === 0
                  ? `This title does not feature achievements on ${STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront}`
                  : 'No achievement records found for this title'}
              </p>
              <p className="text-xs text-slate-300 mt-1 max-w-md mx-auto">
                {isSchemaUnavailableOffline
                  ? `Your ${unlockedCount} of ${totalCount} (${percentage}%) unlock progress is preserved locally. Individual achievement details will load automatically once you reconnect.`
                  : isSummaryCountOnly && totalCount > 0 && !searchQuery
                  ? `${STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront} reported your total unlocked count without exposing individual achievement definitions for this title.`
                  : searchQuery
                  ? 'Try clearing your search query or switching filter tabs.'
                  : currentStoreData?.supportsAchievements === false || totalCount === 0
                  ? resolveNoAchievementsSubtitle(activeStorefront, multiStoreData)
                  : 'Achievements for this storefront are pending sync or not configured.'}
              </p>
              {!isSchemaUnavailableOffline && (searchQuery || activeFilterTab !== 'all') && (
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
            <div
              key={activeStorefront}
              data-testid="achievements-list-pane"
              className="space-y-3"
            >
              {displayedAchievements.length > 60 && listClientHeight > 0 ? (
                <VirtualListRows
                  key={activeStorefront}
                  items={displayedAchievements}
                  scrollElement={listScrollRef.current}
                  estimatedItemHeight={96}
                  itemGapPx={12}
                  getItemKey={(ach, idx) => `${activeStorefront}:${ach.id || idx}`}
                  renderItem={(ach, idx) =>
                    renderAchievementCard({
                      ach,
                      idx,
                      game,
                      activeStorefront,
                      isSummaryCountOnly,
                      revealedSecrets,
                      failedIconKeys,
                      onToggleSecretReveal: toggleSecretReveal,
                      onMarkIconFailed: markIconFailed,
                    })
                  }
                />
              ) : (
                displayedAchievements.map((ach, idx) =>
                  renderAchievementCard({
                    ach,
                    idx,
                    game,
                    activeStorefront,
                    isSummaryCountOnly,
                    revealedSecrets,
                    failedIconKeys,
                    onToggleSecretReveal: toggleSecretReveal,
                    onMarkIconFailed: markIconFailed,
                  })
                )
              )}
            </div>
          )}
        </div>

        {/* Modal Bottom Footer Bar */}
        <div className="px-6 py-3.5 bg-[#0e1620] border-t border-[#2a475e] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Trophy className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <span>
              Showing {displayedAchievements.length} of {totalCount} achievements
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md bg-[#1b2838] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white hover:border-slate-500 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
          >
            Close
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
