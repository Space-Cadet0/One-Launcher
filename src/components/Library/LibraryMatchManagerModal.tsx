import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import { SuppressedCatalogEntry } from '../../services/integrations/catalogSanitizer';
import { ModalShell } from '../Common/ModalShell';
import { VirtualListRows } from '../Common/VirtualContainers';
import {
  useIsRealClientRenderer,
  useSafeDeferredValue,
  useSafeId,
} from '../../utils/useSafeId';
import {
  AutoFilteredSubFilter,
  estimateMatchManagerRowSize,
  FilterTab,
  LibraryMatchManagerModalProps,
  MatchManagerFlatRow,
  MatchStudioSectionKey,
  UnmatchedDiagnosticReason,
  UnmatchedReasonCode,
  UnmatchedSubFilter,
} from './MatchManager/matchManagerTypes';
import {
  clearDurableEmptySynopsisProbe,
  extractCleanSynopsisText,
  getGranularUnmatchedReasons,
  hasDeveloperOrReleaseYear,
  hasDurableEmptySynopsisProbe,
  hasGenuineStoreSynopsis,
  isLikelyNonStoreOrTestBranchTitle,
  isSynopsisAlreadyProbed,
  recordDurableEmptySynopsisProbe,
} from './MatchManager/matchManagerDiagnostics';
import {
  renderMatchManagerFooter,
  renderMatchManagerHeaderAndTabs,
} from './MatchManager/MatchManagerHeaderTabs';
import {
  buildMatchManagerFlatRows,
  MatchManagerRowRenderContext,
  MatchManagerVirtualRow,
  renderMatchManagerFlatRow,
  ResetOverrideContext,
} from './MatchManager/MatchManagerRows';
import {
  buildCatalogLookupIndex,
  bumpStudioEventRevision,
  CatalogLookupIndex,
  computeBaseLowConfidenceItems,
  computeBaseMergedItems,
  computeBaseOverrideItems,
  computeBaseSuppressedSplit,
  computeBaseUnmatchedItems,
  EMPTY_CATALOG_LOOKUP,
  IndexedGameItem,
  IndexedOverrideItem,
  IndexedSuppressedItem,
  IndexedUnmatchedItem,
  matchesAnySearchField,
  partitionAutoFilteredByConfirmation,
  resetStudioSessionCachesForTests,
} from './MatchManager/matchManagerCatalogIndex';
import { useMatchStudioSynopsisProber } from './MatchManager/useMatchStudioSynopsisProber';

export type {
  LibraryMatchManagerModalProps,
  UnmatchedReasonCode,
  UnmatchedDiagnosticReason,
};
export {
  extractCleanSynopsisText,
  isLikelyNonStoreOrTestBranchTitle,
  hasGenuineStoreSynopsis,
  hasDeveloperOrReleaseYear,
  isSynopsisAlreadyProbed,
  getGranularUnmatchedReasons,
  hasDurableEmptySynopsisProbe,
  recordDurableEmptySynopsisProbe,
  clearDurableEmptySynopsisProbe,
  resetStudioSessionCachesForTests,
};

const IS_VITEST_ENV = typeof process !== 'undefined' && Boolean(process.env?.VITEST);

type ExtendedLibraryMatchManagerModalProps = Omit<
  LibraryMatchManagerModalProps,
  'onResetOverride' | 'onResetOverrideForGame'
> & {
  onResetOverride?: (gameId: string, context?: ResetOverrideContext) => void;
  onResetOverrideForGame?: (gameId: string, context?: ResetOverrideContext) => void;
};

function getFlatRowKey(row: MatchManagerFlatRow): string {
  return row.key;
}

export const LibraryMatchManagerModal: React.FC<ExtendedLibraryMatchManagerModalProps> = ({
  isOpen,
  games,
  initialTab,
  onClose,
  onFixMatchForGame,
  onResetOverride,
  onResetOverrideForGame,
  onInspectGame,
  onSelectGame,
  onHideGame,
  onUnhideEntry,
  onGameUpdated,
  onGamesBatchUpdated,
  isSuspended = false,
}) => {
  const handleInspect = onInspectGame || onSelectGame;
  const handleReset = onResetOverride || onResetOverrideForGame;

  const isRealClientRenderer = useIsRealClientRenderer();
  const titleId = useSafeId('library-match-manager-title');
  const panelId = useSafeId('library-match-manager-panel');
  const searchInputId = useSafeId('library-match-manager-search');

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useSafeDeferredValue(searchQuery);
  const [activeTab, setActiveTab] = useState<FilterTab>(initialTab ?? 'needs_attention');
  const [unmatchedSubFilter, setUnmatchedSubFilter] = useState<UnmatchedSubFilter>('all');
  const [autoFilteredSubFilter, setAutoFilteredSubFilter] = useState<AutoFilteredSubFilter>('all');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    unmatched: true,
    low_confidence: true,
    user_suppressed: true,
    suppressed: true,
    confirmed_suppressed: true,
    overrides: true,
    merged: true,
  });
  const [selectedNonGameIds, setSelectedNonGameIds] = useState<Set<string>>(new Set());
  const [overrideTick, setOverrideTick] = useState(0);
  const [nonGameConfirmTick, setNonGameConfirmTick] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const probedSynopsisMap = useMatchStudioSynopsisProber({
    isOpen,
    isSuspended,
    games,
    onGameUpdated,
    onGamesBatchUpdated,
  });

  const handleInspectRef = useRef(handleInspect);
  handleInspectRef.current = handleInspect;
  const onResetOverrideRef = useRef(onResetOverride);
  onResetOverrideRef.current = onResetOverride;
  const onResetOverrideForGameRef = useRef(onResetOverrideForGame);
  onResetOverrideForGameRef.current = onResetOverrideForGame;
  const onFixMatchForGameRef = useRef(onFixMatchForGame);
  onFixMatchForGameRef.current = onFixMatchForGame;
  const onHideGameRef = useRef(onHideGame);
  onHideGameRef.current = onHideGame;
  const onUnhideEntryRef = useRef(onUnhideEntry);
  onUnhideEntryRef.current = onUnhideEntry;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Suspension snapshot caches while FixMatchWizardModal is stacked on top
  const cachedLookupRef = useRef<CatalogLookupIndex>(EMPTY_CATALOG_LOOKUP);
  const hasHydratedLookupRef = useRef(false);
  const cachedBaseUnmatchedRef = useRef<{
    items: IndexedUnmatchedItem[];
    idSet: Set<string>;
  }>({ items: [], idSet: new Set() });
  const hasHydratedUnmatchedRef = useRef(false);
  const cachedBaseLowConfRef = useRef<IndexedGameItem[]>([]);
  const hasHydratedLowConfRef = useRef(false);
  const cachedBaseSuppressedRef = useRef<{
    userSuppressed: IndexedSuppressedItem[];
    autoFiltered: IndexedSuppressedItem[];
  }>({ userSuppressed: [], autoFiltered: [] });
  const hasHydratedSuppressedRef = useRef(false);
  const cachedBaseOverridesRef = useRef<IndexedOverrideItem[]>([]);
  const hasHydratedOverridesRef = useRef(false);
  const cachedBaseMergedRef = useRef<IndexedGameItem[]>([]);
  const hasHydratedMergedRef = useRef(false);

  // Preload FixMatchWizardModal chunk on idle when Studio opens so clicking "Fix Match" opens in <16ms
  useEffect(() => {
    if (!isOpen || !isRealClientRenderer || IS_VITEST_ENV) return undefined;
    const g = globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof g.requestIdleCallback === 'function') {
      const idleId = g.requestIdleCallback(
        () => {
          void import('./FixMatchWizardModal').catch(() => {});
        },
        { timeout: 1_500 }
      );
      return () => {
        if (typeof g.cancelIdleCallback === 'function') {
          g.cancelIdleCallback(idleId);
        }
      };
    }
    const timer = setTimeout(() => {
      void import('./FixMatchWizardModal').catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [isOpen, isRealClientRenderer]);

  useEffect(() => {
    if (!isOpen) return;
    const handleUpdate = (event?: Event) => {
      const detail = (event as CustomEvent<{ type?: string }> | undefined)?.detail;
      const eventType = detail?.type;
      if (
        eventType === 'confirmed-non-game' ||
        eventType === 'confirmed-non-game-batch' ||
        eventType === 'batch-confirmed-non-game' ||
        eventType === 'unconfirmed-non-game'
      ) {
        setNonGameConfirmTick((t) => t + 1);
        return;
      }
      bumpStudioEventRevision();
      setOverrideTick((t) => t + 1);
    };
    const handleRemoved = () => {
      bumpStudioEventRevision();
      setOverrideTick((t) => t + 1);
    };
    window.addEventListener('antigravity:user-override-updated', handleUpdate);
    window.addEventListener('antigravity:user-override-removed', handleRemoved);
    window.addEventListener('antigravity:suppressed-entries-updated', handleUpdate);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleUpdate);
      window.removeEventListener('antigravity:user-override-removed', handleRemoved);
      window.removeEventListener('antigravity:suppressed-entries-updated', handleUpdate);
    };
  }, [isOpen]);

  const toggleSection = useCallback((key: MatchStudioSectionKey) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleOpenExternalUrl = useCallback((url?: string) => {
    if (!url) return;
    const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (electronAPI?.openExternal) {
      void electronAPI.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const stableInspect = useCallback((game: CanonicalGame) => {
    handleInspectRef.current?.(game);
  }, []);
  const stableReset = useCallback((gameId: string, context?: ResetOverrideContext) => {
    if (onResetOverrideRef.current) {
      if (context !== undefined) {
        onResetOverrideRef.current(gameId, context);
      } else {
        onResetOverrideRef.current(gameId);
      }
      return;
    }
    if (onResetOverrideForGameRef.current) {
      if (context !== undefined && onResetOverrideForGameRef.current.length >= 2) {
        onResetOverrideForGameRef.current(gameId, context);
      } else {
        onResetOverrideForGameRef.current(gameId);
      }
    }
  }, []);
  const stableFixMatch = useCallback((game: CanonicalGame) => {
    onFixMatchForGameRef.current(game);
  }, []);
  const stableHideGame = useCallback(
    (game: CanonicalGame, targetPlatformId?: StorefrontId) => {
      if (targetPlatformId !== undefined) {
        onHideGameRef.current?.(game, targetPlatformId);
      } else {
        onHideGameRef.current?.(game);
      }
    },
    []
  );
  const stableUnhideEntry = useCallback((entry: SuppressedCatalogEntry) => {
    onUnhideEntryRef.current?.(entry);
  }, []);
  const stableClose = useCallback(() => {
    onCloseRef.current();
  }, []);

  const catalogLookupIndex = useMemo<CatalogLookupIndex>(() => {
    if (!isOpen) return EMPTY_CATALOG_LOOKUP;
    if (isSuspended && hasHydratedLookupRef.current) return cachedLookupRef.current;
    const next = buildCatalogLookupIndex(games);
    cachedLookupRef.current = next;
    hasHydratedLookupRef.current = true;
    return next;
  }, [isOpen, isSuspended, games]);

  const baseUnmatchedData = useMemo(() => {
    if (!isOpen) return { items: [] as IndexedUnmatchedItem[], idSet: new Set<string>() };
    if (isSuspended && hasHydratedUnmatchedRef.current) return cachedBaseUnmatchedRef.current;
    void overrideTick;
    const next = computeBaseUnmatchedItems(games, probedSynopsisMap);
    cachedBaseUnmatchedRef.current = next;
    hasHydratedUnmatchedRef.current = true;
    return next;
  }, [isOpen, isSuspended, games, overrideTick, probedSynopsisMap]);

  const baseLowConfidenceItems = useMemo<IndexedGameItem[]>(() => {
    if (!isOpen) return [];
    if (isSuspended && hasHydratedLowConfRef.current) return cachedBaseLowConfRef.current;
    void overrideTick;
    const items = computeBaseLowConfidenceItems(games, baseUnmatchedData.idSet);
    cachedBaseLowConfRef.current = items;
    hasHydratedLowConfRef.current = true;
    return items;
  }, [isOpen, isSuspended, games, baseUnmatchedData, overrideTick]);

  const baseSuppressedSplit = useMemo(() => {
    if (!isOpen) {
      return {
        userSuppressed: [] as IndexedSuppressedItem[],
        autoFiltered: [] as IndexedSuppressedItem[],
      };
    }
    if (isSuspended && hasHydratedSuppressedRef.current) return cachedBaseSuppressedRef.current;
    void overrideTick;
    const next = computeBaseSuppressedSplit(catalogLookupIndex);
    cachedBaseSuppressedRef.current = next;
    hasHydratedSuppressedRef.current = true;
    return next;
  }, [isOpen, isSuspended, catalogLookupIndex, overrideTick]);

  const baseOverrideItems = useMemo<IndexedOverrideItem[]>(() => {
    if (!isOpen) return [];
    if (isSuspended && hasHydratedOverridesRef.current) return cachedBaseOverridesRef.current;
    void overrideTick;
    const list = computeBaseOverrideItems(catalogLookupIndex);
    cachedBaseOverridesRef.current = list;
    hasHydratedOverridesRef.current = true;
    return list;
  }, [isOpen, isSuspended, catalogLookupIndex, overrideTick]);

  const baseMergedItems = useMemo<IndexedGameItem[]>(() => {
    if (!isOpen) return [];
    if (isSuspended && hasHydratedMergedRef.current) return cachedBaseMergedRef.current;
    const items = computeBaseMergedItems(games);
    cachedBaseMergedRef.current = items;
    hasHydratedMergedRef.current = true;
    return items;
  }, [isOpen, isSuspended, games]);

  const effectiveQuery = deferredSearchQuery.trim();

  const unmatchedWithReasons = useMemo(() => {
    if (!isOpen) return [];
    const base = baseUnmatchedData.items;
    if (!effectiveQuery) return base;
    return base.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery));
  }, [isOpen, baseUnmatchedData, effectiveQuery]);

  const unmatchedGames = useMemo(() => {
    if (!isOpen) return [];
    return unmatchedWithReasons.map((item) => item.game);
  }, [isOpen, unmatchedWithReasons]);

  const unmatchedSubCounts = useMemo(() => {
    if (!isOpen) return { all: 0, artwork: 0, synopsis: 0, dev_year: 0 };
    let artwork = 0;
    let synopsis = 0;
    let dev_year = 0;
    for (let i = 0; i < unmatchedWithReasons.length; i += 1) {
      const { reasons } = unmatchedWithReasons[i];
      if (reasons.some((r) => r.code === 'missing_all_art' || r.code === 'missing_vertical_cover')) {
        artwork += 1;
      }
      if (reasons.some((r) => r.code === 'missing_synopsis')) {
        synopsis += 1;
      }
      if (reasons.some((r) => r.code === 'missing_dev_year')) {
        dev_year += 1;
      }
    }
    return {
      all: unmatchedWithReasons.length,
      artwork,
      synopsis,
      dev_year,
    };
  }, [isOpen, unmatchedWithReasons]);

  const filteredUnmatchedItems = useMemo(() => {
    if (!isOpen) return [];
    if (unmatchedSubFilter === 'all') return unmatchedWithReasons;
    return unmatchedWithReasons.filter(({ reasons }) => {
      if (unmatchedSubFilter === 'artwork') {
        return reasons.some(
          (r) => r.code === 'missing_all_art' || r.code === 'missing_vertical_cover'
        );
      }
      if (unmatchedSubFilter === 'synopsis') {
        return reasons.some((r) => r.code === 'missing_synopsis');
      }
      if (unmatchedSubFilter === 'dev_year') {
        return reasons.some((r) => r.code === 'missing_dev_year');
      }
      return true;
    });
  }, [isOpen, unmatchedWithReasons, unmatchedSubFilter]);

  const lowConfidenceGames = useMemo(() => {
    if (!isOpen) return [];
    const filtered = effectiveQuery
      ? baseLowConfidenceItems.filter((item) =>
          matchesAnySearchField(item.searchFields, effectiveQuery)
        )
      : baseLowConfidenceItems;
    return filtered.map((item) => item.game);
  }, [isOpen, baseLowConfidenceItems, effectiveQuery]);

  const userSuppressedEntries = useMemo(() => {
    if (!isOpen) return [];
    const base = baseSuppressedSplit.userSuppressed;
    const filtered = effectiveQuery
      ? base.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery))
      : base;
    return filtered.map((item) => item.entry);
  }, [isOpen, baseSuppressedSplit, effectiveQuery]);

  const searchedAutoFilteredItems = useMemo(() => {
    if (!isOpen) return [];
    const base = baseSuppressedSplit.autoFiltered;
    if (!effectiveQuery) return base;
    return base.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery));
  }, [isOpen, baseSuppressedSplit, effectiveQuery]);

  const { unreviewedAutoFilteredItems, confirmedAutoFilteredEntries } = useMemo(() => {
    if (!isOpen) {
      return {
        unreviewedAutoFilteredItems: [] as IndexedSuppressedItem[],
        confirmedAutoFilteredEntries: [] as SuppressedCatalogEntry[],
      };
    }
    void overrideTick;
    void nonGameConfirmTick;
    return partitionAutoFilteredByConfirmation(searchedAutoFilteredItems);
  }, [isOpen, searchedAutoFilteredItems, overrideTick, nonGameConfirmTick]);

  const unreviewedAutoFilteredEntries = useMemo(() => {
    if (!isOpen) return [];
    return unreviewedAutoFilteredItems.map((item) => item.entry);
  }, [isOpen, unreviewedAutoFilteredItems]);

  const autoFilteredSubCounts = useMemo(() => {
    if (!isOpen) {
      return { all: 0, beta: 0, prologue: 0, tool: 0, soundtrack: 0, dlc: 0 };
    }
    let beta = 0;
    let prologue = 0;
    let tool = 0;
    let soundtrack = 0;
    let dlc = 0;
    for (let i = 0; i < unreviewedAutoFilteredItems.length; i += 1) {
      const cat = unreviewedAutoFilteredItems[i].subCategory;
      if (cat === 'beta') beta += 1;
      else if (cat === 'prologue') prologue += 1;
      else if (cat === 'tool') tool += 1;
      else if (cat === 'soundtrack') soundtrack += 1;
      else if (cat === 'dlc') dlc += 1;
    }
    return {
      all: unreviewedAutoFilteredItems.length,
      beta,
      prologue,
      tool,
      soundtrack,
      dlc,
    };
  }, [isOpen, unreviewedAutoFilteredItems]);

  const filteredAutoFilteredEntries = useMemo(() => {
    if (!isOpen) return [];
    if (autoFilteredSubFilter === 'all') return unreviewedAutoFilteredEntries;
    const list: SuppressedCatalogEntry[] = [];
    for (let i = 0; i < unreviewedAutoFilteredItems.length; i += 1) {
      const item = unreviewedAutoFilteredItems[i];
      if (item.subCategory === autoFilteredSubFilter) {
        list.push(item.entry);
      }
    }
    return list;
  }, [isOpen, unreviewedAutoFilteredItems, unreviewedAutoFilteredEntries, autoFilteredSubFilter]);

  const selectedVisibleEntries = useMemo(() => {
    if (!isOpen || selectedNonGameIds.size === 0) return [];
    return filteredAutoFilteredEntries.filter((entry) => selectedNonGameIds.has(entry.id));
  }, [isOpen, filteredAutoFilteredEntries, selectedNonGameIds]);

  const overrideItems = useMemo(() => {
    if (!isOpen) return [];
    if (!effectiveQuery) return baseOverrideItems;
    return baseOverrideItems.filter((item) =>
      matchesAnySearchField(item.searchFields, effectiveQuery)
    );
  }, [isOpen, baseOverrideItems, effectiveQuery]);

  const mergedGames = useMemo(() => {
    if (!isOpen) return [];
    const filtered = effectiveQuery
      ? baseMergedItems.filter((item) => matchesAnySearchField(item.searchFields, effectiveQuery))
      : baseMergedItems;
    return filtered.map((item) => item.game);
  }, [isOpen, baseMergedItems, effectiveQuery]);

  const handleSelectTab = useCallback(
    (nextTab: FilterTab) => {
      setActiveTab(nextTab);
      scrollEl?.scrollTo?.({ top: 0 });
    },
    [scrollEl]
  );

  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  const showUnmatched = activeTab === 'needs_attention';
  const showLowConfidence = activeTab === 'needs_attention';
  const showUserSuppressed = activeTab === 'user_suppressed';
  const showSuppressed = activeTab === 'suppressed';
  const showOverrides = activeTab === 'overrides';
  const showMerged = activeTab === 'merged';

  const flatRows = useMemo(() => {
    if (!isOpen) return [];
    return buildMatchManagerFlatRows({
      showUnmatched,
      showLowConfidence,
      showUserSuppressed,
      showSuppressed,
      showOverrides,
      showMerged,
      expandedSections,
      unmatchedGames,
      filteredUnmatchedItems,
      lowConfidenceGames,
      userSuppressedEntries,
      unreviewedAutoFilteredEntries,
      filteredAutoFilteredEntries,
      confirmedAutoFilteredEntries,
      overrideItems,
      mergedGames,
    });
  }, [
    isOpen,
    showUnmatched,
    showLowConfidence,
    showUserSuppressed,
    showSuppressed,
    showOverrides,
    showMerged,
    expandedSections,
    unmatchedGames,
    filteredUnmatchedItems,
    lowConfidenceGames,
    userSuppressedEntries,
    unreviewedAutoFilteredEntries,
    filteredAutoFilteredEntries,
    confirmedAutoFilteredEntries,
    overrideItems,
    mergedGames,
  ]);

  const hasInspect = Boolean(handleInspect);
  const hasReset = Boolean(handleReset);
  const hasHideGame = Boolean(onHideGame);
  const hasUnhideEntry = Boolean(onUnhideEntry);

  const rowRenderContext = useMemo<MatchManagerRowRenderContext>(
    () => ({
      toggleSection,
      unmatchedSubFilter,
      setUnmatchedSubFilter,
      unmatchedSubCounts,
      autoFilteredSubFilter,
      setAutoFilteredSubFilter,
      autoFilteredSubCounts,
      filteredAutoFilteredEntries,
      selectedVisibleEntries,
      selectedNonGameIds,
      setSelectedNonGameIds,
      handleInspect: hasInspect ? stableInspect : undefined,
      handleReset: hasReset ? stableReset : undefined,
      onFixMatchForGame: stableFixMatch,
      onHideGame: hasHideGame ? stableHideGame : undefined,
      onUnhideEntry: hasUnhideEntry ? stableUnhideEntry : undefined,
      onClose: stableClose,
      handleOpenExternalUrl,
    }),
    [
      toggleSection,
      unmatchedSubFilter,
      unmatchedSubCounts,
      autoFilteredSubFilter,
      autoFilteredSubCounts,
      filteredAutoFilteredEntries,
      selectedVisibleEntries,
      selectedNonGameIds,
      hasInspect,
      stableInspect,
      hasReset,
      stableReset,
      stableFixMatch,
      hasHideGame,
      stableHideGame,
      hasUnhideEntry,
      stableUnhideEntry,
      stableClose,
      handleOpenExternalUrl,
    ]
  );

  const renderVirtualFlatRow = useCallback(
    (row: MatchManagerFlatRow) => {
      const isSelected =
        row.kind === 'pending-suppressed-row'
          ? rowRenderContext.selectedNonGameIds.has(row.entry.id)
          : false;
      return <MatchManagerVirtualRow row={row} isSelected={isSelected} ctx={rowRenderContext} />;
    },
    [rowRenderContext]
  );

  if (!isOpen) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy={titleId}
      className="w-full max-w-5xl"
    >
      <div
        className="bg-[#1b2838] border border-steam-border rounded-xl shadow-2xl w-full max-w-5xl h-[92vh] max-h-[92vh] flex flex-col overflow-hidden text-slate-200 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        {renderMatchManagerHeaderAndTabs({
          titleId,
          panelId,
          searchInputId,
          activeTab,
          setActiveTab: handleSelectTab,
          searchQuery,
          setSearchQuery,
          onClose,
          unmatchedCount: unmatchedGames.length,
          lowConfidenceCount: lowConfidenceGames.length,
          userSuppressedCount: userSuppressedEntries.length,
          unreviewedAutoFilteredCount: unreviewedAutoFilteredEntries.length,
          overrideCount: overrideItems.length,
          mergedCount: mergedGames.length,
        })}

        {/* Main Scrollable Accordion Body (Single Flattened Virtualizer) */}
        <div
          ref={setScrollEl}
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${titleId}-tab-${activeTab}`}
          inert={isSuspended ? true : undefined}
          aria-hidden={Boolean(isSuspended) || undefined}
          className={`relative flex-1 overflow-y-auto p-6 ol-studio-scroll-body${
            isSuspended ? ' pointer-events-none' : ''
          }`}
        >
          {flatRows.length > 50 && isRealClientRenderer ? (
            <VirtualListRows
              items={flatRows}
              scrollElement={scrollEl}
              estimatedItemHeight={78}
              estimateItemSize={estimateMatchManagerRowSize}
              getItemKey={getFlatRowKey}
              renderItem={renderVirtualFlatRow}
            />
          ) : (
            flatRows.map((row) => renderMatchManagerFlatRow(row, rowRenderContext))
          )}
        </div>

        {renderMatchManagerFooter({
          totalGamesCount: games.length,
          unmatchedCount: unmatchedGames.length,
          lowConfidenceCount: lowConfidenceGames.length,
          overrideCount: overrideItems.length,
          userSuppressedCount: userSuppressedEntries.length,
          unreviewedAutoFilteredCount: unreviewedAutoFilteredEntries.length,
          confirmedAutoFilteredCount: confirmedAutoFilteredEntries.length,
          onClose,
        })}
      </div>
    </ModalShell>
  );
};
