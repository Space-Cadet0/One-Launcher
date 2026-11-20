import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import type {
  StorefrontAchievementsData,
  MultiStoreAchievementsMap,
} from '../../contracts/achievement';
import {
  achievementDetailService,
  deduplicateDetailedAchievements,
} from '../../services/achievements/achievementDetailService';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { toOlMediaUrl } from '../../contracts/network';
import { matchesLooseSearchQuery } from '../../services/common/titleUtils';
import { StorefrontIcon } from '../Common/StorefrontIcon';
import { ModalShell } from '../Common/ModalShell';
import { VirtualListRows } from '../Common/VirtualContainers';
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
  RefreshCw,
  TrendingUp,
} from 'lucide-react';

export interface GameAchievementsModalProps {
  isOpen: boolean;
  game: CanonicalGame | null;
  initialStorefrontId?: StorefrontId;
  onClose: () => void;
}

type FilterTab = 'all' | 'unlocked' | 'locked' | 'in_progress' | 'secret';
type SortOption =
  | 'default'
  | 'closest_progress'
  | 'rarity_rarest'
  | 'rarity_common'
  | 'unlock_date'
  | 'name';

const SWR_STALE_AGE_MS = 5 * 60 * 1000;

function shouldSwrRevalidateMap(map: MultiStoreAchievementsMap): boolean {
  const entries = Object.values(map);
  if (entries.length === 0) return true;
  const now = Date.now();
  return entries.some((entry) => {
    if (!entry) return false;
    if (entry.schemaUnavailableOffline) return true;
    if (entry.unlockPrecision === 'summary_count_only') return true;
    if ((entry.cacheVersion ?? 0) < 2) return true;
    if (Array.isArray(entry.achievements) && entry.achievements.length > 0 && entry.total !== entry.achievements.length) {
      return true;
    }
    if (entry.syncedAt) {
      const syncedMs = Date.parse(entry.syncedAt);
      if (!Number.isNaN(syncedMs) && now - syncedMs > SWR_STALE_AGE_MS) {
        return true;
      }
    }
    return false;
  });
}

function hasHigherPlatformUnlockedSummary(
  game: CanonicalGame,
  cachedMap: MultiStoreAchievementsMap
): boolean {
  return game.platforms.some((plat) => {
    const summaryUnlocked = plat.achievements?.unlocked ?? 0;
    if (summaryUnlocked <= 0) return false;
    const cachedEntry = cachedMap[plat.platformId as StorefrontId];
    if (!cachedEntry) return true;
    return summaryUnlocked > cachedEntry.unlocked;
  });
}

type ProgressFillStyle = React.CSSProperties & { '--ol-progress-fill'?: string };

export const GameAchievementsModal: React.FC<GameAchievementsModalProps> = ({
  isOpen,
  game,
  initialStorefrontId,
  onClose,
}) => {
  const [multiStoreData, setMultiStoreData] = useState<MultiStoreAchievementsMap>({});
  const [activeStorefront, setActiveStorefront] = useState<StorefrontId>('steam');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>('all');
  const [sortOption, setSortOption] = useState<SortOption>('default');
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [failedIconKeys, setFailedIconKeys] = useState<Set<string>>(new Set());
  const [isOnline, setIsOnline] = useState<boolean>(() => onlineLifecycleManager.isOnline());
  const [listClientHeight, setListClientHeight] = useState(0);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const multiStoreDataRef = useRef<MultiStoreAchievementsMap>(multiStoreData);
  const fetchSeqRef = useRef(0);
  multiStoreDataRef.current = multiStoreData;

  // Available storefronts with achievements for this game
  const availableStorefronts = useMemo(() => {
    if (!game) return [];
    const ids: StorefrontId[] = [];
    if (multiStoreData.steam) ids.push('steam');
    if (multiStoreData.epic) ids.push('epic');
    if (multiStoreData.xbox) ids.push('xbox');
    if (multiStoreData.gog) ids.push('gog');

    // Also include any owned platform on game
    for (const p of game.platforms) {
      if (!ids.includes(p.platformId as StorefrontId)) {
        ids.push(p.platformId as StorefrontId);
      }
    }
    return ids;
  }, [game, multiStoreData]);

  // Load detailed achievements on open with instant cache paint + non-blocking SWR refresh
  useEffect(() => {
    if (!isOpen || !game) return;
    let cancelled = false;
    const reqSeq = ++fetchSeqRef.current;

    setSearchQuery('');
    setActiveFilterTab('all');
    setSortOption('default');
    setRevealedSecrets(new Set());
    setFailedIconKeys(new Set());
    const currentlyOnline = onlineLifecycleManager.isOnline();
    setIsOnline(currentlyOnline);

    // Determine initial storefront tab
    const preferredStore = (
      initialStorefrontId ||
      (game.platforms.some((p) => p.platformId === 'steam')
        ? 'steam'
        : game.platforms[0]?.platformId || 'steam')
    ) as StorefrontId;
    setActiveStorefront(preferredStore);

    const applyResolvedData = (data: MultiStoreAchievementsMap) => {
      if (cancelled || fetchSeqRef.current !== reqSeq) return;
      setMultiStoreData(data);
      if (!data[preferredStore]) {
        const firstWithData = Object.keys(data)[0] as StorefrontId | undefined;
        if (firstWithData) setActiveStorefront(firstWithData);
      }
    };

    const syncCached =
      typeof achievementDetailService.peekCachedGameAchievements === 'function'
        ? achievementDetailService.peekCachedGameAchievements(game.id)
        : null;

    if (syncCached && Object.keys(syncCached).length > 0) {
      applyResolvedData(syncCached);
      setIsLoading(false);

      const hasElectronIpc =
        typeof window !== 'undefined' && Boolean(window.electronAPI?.getStoreAchievements);
      const needsSwr =
        shouldSwrRevalidateMap(syncCached) ||
        hasHigherPlatformUnlockedSummary(game, syncCached);
      if (currentlyOnline && needsSwr) {
        setIsRefreshing(true);
        const forceSwr = hasElectronIpc;
        achievementDetailService.fetchGameAchievements(game, forceSwr).then(
          (fresh) => {
            if (fresh && Object.keys(fresh).length > 0) {
              applyResolvedData(fresh);
            }
            if (!cancelled && fetchSeqRef.current === reqSeq) {
              setIsRefreshing(false);
            }
          },
          () => {
            if (!cancelled && fetchSeqRef.current === reqSeq) {
              setIsRefreshing(false);
            }
          }
        );
      } else {
        setIsRefreshing(false);
      }
    } else {
      setIsLoading(true);
      setIsRefreshing(false);
      achievementDetailService.fetchGameAchievements(game).then(
        (data) => {
          applyResolvedData(data);
          if (!cancelled && fetchSeqRef.current === reqSeq) {
            setIsLoading(false);
          }
        },
        () => {
          if (!cancelled && fetchSeqRef.current === reqSeq) {
            setIsLoading(false);
          }
        }
      );
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, game?.id, initialStorefrontId]);

  const handleManualRefresh = useCallback(() => {
    if (!game || isLoading || isRefreshing || !onlineLifecycleManager.isOnline()) return;
    const reqSeq = ++fetchSeqRef.current;
    setIsRefreshing(true);
    achievementDetailService.fetchGameAchievements(game, true).then(
      (fresh) => {
        if (fetchSeqRef.current !== reqSeq) return;
        if (fresh && Object.keys(fresh).length > 0) {
          setMultiStoreData(fresh);
        }
        setIsRefreshing(false);
      },
      () => {
        if (fetchSeqRef.current === reqSeq) {
          setIsRefreshing(false);
        }
      }
    );
  }, [game, isLoading, isRefreshing]);

  const handleSelectStorefront = useCallback((storeId: StorefrontId) => {
    setActiveStorefront(storeId);
    setActiveFilterTab('all');
    if (listScrollRef.current) {
      listScrollRef.current.scrollTop = 0;
    }
  }, []);

  // Reset failed achievement icons and re-fetch missing schemas automatically on reconnect
  useEffect(() => {
    if (!isOpen || !game) return;
    const offConn = onlineLifecycleManager.onConnectivityChange((online) => {
      setIsOnline(online);
    });
    const offOnline = onlineLifecycleManager.onOnline(() => {
      setFailedIconKeys(new Set());
      const existing = multiStoreDataRef.current;
      const needsRefetch =
        Object.keys(existing).length === 0 ||
        Object.values(existing).some(
          (d) =>
            Boolean(d?.schemaUnavailableOffline) ||
            ((d?.total || 0) > 0 && (d?.achievements?.length || 0) === 0)
        );
      if (needsRefetch) {
        setIsLoading(true);
        achievementDetailService.fetchGameAchievements(game).then(
          (data) => {
            setMultiStoreData(data);
            setIsLoading(false);
          },
          () => {
            setIsLoading(false);
          }
        );
      }
    });
    return () => {
      offConn();
      offOnline();
    };
  }, [isOpen, game]);

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

  // Active storefront data (defensively deduplicated so duplicate React keys never reach reconciler)
  const rawStoreData: StorefrontAchievementsData | undefined = multiStoreData[activeStorefront];
  const currentStoreData: StorefrontAchievementsData | undefined = useMemo(
    () => (rawStoreData ? deduplicateDetailedAchievements(rawStoreData) : undefined),
    [rawStoreData]
  );
  const isSummaryCountOnly = currentStoreData?.unlockPrecision === 'summary_count_only';

  // Locked secret IDs for "Reveal All Secrets" toggle
  const lockedSecretIds = useMemo(() => {
    if (!currentStoreData?.achievements) return [];
    return currentStoreData.achievements
      .filter((a) => a.isSecret && !a.unlocked)
      .map((a) => a.id);
  }, [currentStoreData]);

  const allSecretsRevealed = useMemo(
    () =>
      lockedSecretIds.length > 0 && lockedSecretIds.every((id) => revealedSecrets.has(id)),
    [lockedSecretIds, revealedSecrets]
  );

  // Toggle reveal for hidden / secret achievements
  const toggleSecretReveal = useCallback((id: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleRevealAllSecrets = useCallback(() => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (lockedSecretIds.every((id) => prev.has(id))) {
        for (const id of lockedSecretIds) next.delete(id);
      } else {
        for (const id of lockedSecretIds) next.add(id);
      }
      return next;
    });
  }, [lockedSecretIds]);

  const inProgressCount = useMemo(() => {
    if (!currentStoreData?.achievements || isSummaryCountOnly) return 0;
    return currentStoreData.achievements.filter(
      (a) => !a.unlocked && Boolean(a.progress && a.progress.current > 0 && a.progress.max > 0)
    ).length;
  }, [currentStoreData, isSummaryCountOnly]);

  // Filtered and sorted achievements list (with defensive deduplication by ach.id)
  const displayedAchievements = useMemo(() => {
    if (!currentStoreData?.achievements) return [];
    const deduped: StorefrontAchievementsData['achievements'] = [];
    const seenIndexById = new Map<string, number>();
    for (const ach of currentStoreData.achievements) {
      const idKey = typeof ach?.id === 'string' ? ach.id.trim() : '';
      if (idKey) {
        const existingIdx = seenIndexById.get(idKey);
        if (existingIdx !== undefined) {
          if (!deduped[existingIdx].unlocked && ach.unlocked) {
            deduped[existingIdx] = { ...deduped[existingIdx], ...ach, unlocked: true };
          }
          continue;
        }
        seenIndexById.set(idKey, deduped.length);
      }
      deduped.push(ach);
    }
    let list = deduped;

    // Filter tab (avoid misleading per-item locked/unlocked filtering when precision is summary_count_only)
    if (!isSummaryCountOnly) {
      if (activeFilterTab === 'unlocked') {
        list = list.filter((a) => a.unlocked);
      } else if (activeFilterTab === 'locked') {
        list = list.filter((a) => !a.unlocked);
      } else if (activeFilterTab === 'in_progress') {
        list = list.filter(
          (a) => !a.unlocked && Boolean(a.progress && a.progress.current > 0 && a.progress.max > 0)
        );
      } else if (activeFilterTab === 'secret') {
        list = list.filter((a) => a.isSecret);
      }
    } else if (activeFilterTab === 'secret') {
      list = list.filter((a) => a.isSecret);
    }

    // Text search query (exclude unrevealed locked secret text so search never spoils hidden trophies)
    if (searchQuery.trim()) {
      list = list.filter((a) => {
        const isHiddenUnrevealed = Boolean(a.isSecret && !a.unlocked && !revealedSecrets.has(a.id));
        if (isHiddenUnrevealed) {
          return matchesLooseSearchQuery('Hidden Achievement Secret', searchQuery);
        }
        return (
          matchesLooseSearchQuery(a.name, searchQuery) ||
          matchesLooseSearchQuery(a.description, searchQuery)
        );
      });
    }

    // Sorting
    list.sort((a, b) => {
      if (sortOption === 'closest_progress') {
        // 1. Locked with partial progress > 0 descending by progress %, tie-break by highest global %
        // 2. Remaining locked by highest global % (easiest remaining)
        // 3. Unlocked last
        if (!a.unlocked && b.unlocked) return -1;
        if (a.unlocked && !b.unlocked) return 1;
        if (!a.unlocked && !b.unlocked) {
          const progA = a.progress && a.progress.current > 0 ? a.progress.percentage : -1;
          const progB = b.progress && b.progress.current > 0 ? b.progress.percentage : -1;
          if (progA !== progB) return progB - progA;
          return (b.globalPercentage ?? 0) - (a.globalPercentage ?? 0);
        }
        return 0;
      }
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
  }, [currentStoreData, activeFilterTab, searchQuery, sortOption, isSummaryCountOnly, revealedSecrets]);

  const totalCount = currentStoreData?.total || 0;
  const unlockedCount = currentStoreData?.unlocked || 0;
  const percentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
  const isMastered = totalCount > 0 && unlockedCount >= totalCount;
  const lockedCount = Math.max(0, totalCount - unlockedCount);
  const secretCount = currentStoreData?.achievements.filter((a) => a.isSecret).length || 0;
  const isSchemaUnavailableOffline =
    Boolean(currentStoreData?.schemaUnavailableOffline) ||
    (!isOnline && totalCount > 0 && (currentStoreData?.achievements?.length || 0) === 0);

  if (!isOpen || !game) return null;

  const renderAchievementCard = (
    ach: StorefrontAchievementsData['achievements'][number],
    idx: number
  ) => {
    const isUnlocked = ach.unlocked;
    const isSecretHidden = ach.isSecret && !isUnlocked && !revealedSecrets.has(ach.id);

    // Rarity styling
    let rarityBadge = null;
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
        key={`${activeStorefront}:${ach.id || idx}`}
        className={`rounded-lg p-3.5 border transition-all duration-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
          isUnlocked
            ? 'bg-[#15202e] border-[#2b4b6f] hover:border-steam-accent/70 shadow-md'
            : isSummaryCountOnly
              ? 'bg-[#121c28] border-[#223447] hover:border-slate-500'
              : 'bg-[#0f1620]/90 border-[#1c2a38] opacity-80 hover:opacity-100 hover:border-slate-600'
        }`}
      >
        {/* Left: Icon & Description Details */}
        <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1">
          {/* Achievement Icon */}
          <div className="relative w-14 h-14 rounded-lg overflow-hidden shrink-0 bg-black/60 border border-white/10 flex items-center justify-center">
            {(() => {
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
              return !isIconFailed ? (
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
                  onError={() => {
                    setFailedIconKeys((prev) => {
                      if (prev.has(iconKey)) return prev;
                      const next = new Set(prev);
                      next.add(iconKey);
                      return next;
                    });
                  }}
                />
              ) : (
                <Trophy
                  className={`w-6 h-6 ${
                    isUnlocked ? 'text-amber-400/80' : 'text-slate-400'
                  }`}
                />
              );
            })()}

            {/* Locked Overlay Badge (suppressed when unlockPrecision is summary_count_only) */}
            {!isUnlocked && !isSummaryCountOnly && (
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
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className={`text-sm font-bold truncate ${
                  isUnlocked || isSummaryCountOnly ? 'text-white' : 'text-slate-300'
                }`}
              >
                {isSecretHidden ? 'Hidden Achievement' : ach.name}
              </h3>

              {/* Secret pill when hidden */}
              {ach.isSecret && !isUnlocked && (
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-purple-950/80 border border-purple-500/50 text-purple-300">
                  Secret
                </span>
              )}

              {/* DLC / Expansion badge for non-base sets */}
              {ach.isBaseGame === false && (
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-indigo-950/80 border border-indigo-400/50 text-indigo-200">
                  DLC
                </span>
              )}

              {/* XP Badge if Epic */}
              {ach.xp !== undefined && (
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-950/80 border border-amber-500/50 text-amber-300">
                  +{ach.xp} XP
                </span>
              )}

              {/* Gamerscore Badge if Xbox */}
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

            {/* Description (blur-to-reveal spoiler shield for locked hidden achievements) */}
            {isSecretHidden ? (
              <button
                type="button"
                onClick={() => toggleSecretReveal(ach.id)}
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

            {/* Single native styled <progress> bar (`44 / 50 (88%)` vs `64%` for percentage-unit progress) */}
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
                  value={Math.min(Math.max(0, ach.progress.current), Math.max(1, ach.progress.max))}
                  max={Math.max(1, ach.progress.max)}
                  aria-label={
                    isSecretHidden ? 'Hidden achievement progress' : `${ach.name} progress`
                  }
                />
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
                  className="min-h-6 px-1 inline-flex items-center gap-1 text-[10px] text-purple-300 hover:text-purple-200 hover:underline cursor-pointer"
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
  };

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

          <div className="flex items-center gap-2 shrink-0">
            {isRefreshing && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-sky-950/60 border border-sky-500/40 text-[11px] font-semibold text-sky-200"
              >
                <Loader2 className="w-3 h-3 animate-spin text-sky-300" />
                <span>Refreshing...</span>
              </span>
            )}
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={isLoading || isRefreshing || !isOnline}
              aria-label="Refresh achievements"
              className="min-w-6 min-h-6 p-1.5 rounded-lg inline-flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              title="Refresh achievements from storefront"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close achievements modal"
              className="min-w-6 min-h-6 p-1.5 rounded-lg inline-flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
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
                  onClick={() => handleSelectStorefront(storeId)}
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

              {/* Single Native Styled Linear Progress Bar */}
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

          {/* Source indicator */}
          <div className="flex items-center gap-2 self-start sm:self-center">
            <span className="text-[11px] text-slate-300 flex items-center gap-1.5 bg-black/30 px-2.5 py-1 rounded border border-[#2a475e]/60">
              <StorefrontIcon storefrontId={activeStorefront} className="w-3.5 h-3.5" />
              <span>{STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront} Catalog</span>
            </span>
          </div>
        </div>

        {/* Summary-Count-Only Precision Banner */}
        {isSummaryCountOnly && totalCount > 0 && (
          <div
            role="status"
            data-testid="achievements-summary-precision-banner"
            className="px-6 py-2.5 bg-sky-950/35 border-b border-sky-500/35 text-xs text-sky-200 flex items-center gap-2.5 shrink-0"
          >
            <Trophy className="w-4 h-4 text-sky-300 shrink-0" />
            <span>
              <strong className="text-white">Verified Summary Progress:</strong>{' '}
              {STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront} provides your aggregate unlock total ({unlockedCount} of {totalCount} unlocked), while individual per-achievement unlock states and timestamps are not exposed by this storefront endpoint.
            </span>
          </div>
        )}

        {/* Toolbar: Filter Tabs (Row 1) & Search + Sort Controls (Row 2) */}
        <div
          data-testid="achievements-toolbar"
          className="px-6 py-3 bg-[#111923] border-b border-[#2a475e]/60 flex flex-col gap-2.5 shrink-0"
        >
          {/* Row 1: Status Filter Tabs & Secret Reveal Toggle */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              data-testid="achievements-filter-tabs"
              className="flex flex-wrap items-center gap-1.5"
            >
              <button
                type="button"
                onClick={() => setActiveFilterTab('all')}
                className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 ${
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
                    onClick={() => setActiveFilterTab('unlocked')}
                    className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                      activeFilterTab === 'unlocked'
                        ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-500/70'
                        : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                    }`}
                  >
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    <span>Unlocked ({unlockedCount})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveFilterTab('locked')}
                    className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                      activeFilterTab === 'locked'
                        ? 'bg-slate-800 text-slate-200 border border-slate-600'
                        : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                    }`}
                  >
                    <Lock className="w-3 h-3 text-slate-300" />
                    <span>Locked ({lockedCount})</span>
                  </button>
                  {inProgressCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveFilterTab('in_progress')}
                      className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                        activeFilterTab === 'in_progress'
                          ? 'bg-sky-950/70 text-sky-200 border border-sky-400/70'
                          : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                      }`}
                    >
                      <TrendingUp className="w-3 h-3 text-sky-400" />
                      <span>In Progress ({inProgressCount})</span>
                    </button>
                  )}
                </>
              )}
              {secretCount > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveFilterTab('secret')}
                  className={`min-h-6 px-3 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 ${
                    activeFilterTab === 'secret'
                      ? 'bg-purple-950/70 text-purple-300 border border-purple-500/70'
                      : 'text-slate-300 hover:text-white bg-[#16202d] border border-transparent'
                  }`}
                >
                  <EyeOff className="w-3 h-3 text-purple-400" />
                  <span>Secret ({secretCount})</span>
                </button>
              )}
            </div>

            {!isSummaryCountOnly && secretCount > 0 && lockedSecretIds.length > 0 && (
              <button
                type="button"
                onClick={toggleRevealAllSecrets}
                className="min-h-6 px-2.5 py-1.5 rounded text-xs font-semibold text-purple-200 hover:text-white bg-purple-950/40 hover:bg-purple-950/70 border border-purple-500/40 transition-colors cursor-pointer shrink-0 flex items-center gap-1.5"
              >
                {allSecretsRevealed ? (
                  <>
                    <EyeOff className="w-3 h-3 text-purple-300" />
                    <span>Hide All Secrets</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3 h-3 text-purple-300" />
                    <span>Reveal All Secrets</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Row 2: Search & Sort Controls */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                aria-label="Search achievements"
                autoComplete="off"
                spellCheck={false}
                placeholder="Search achievements..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-8 py-1.5 rounded bg-[#16202d] border border-[#2a475e] text-xs text-white placeholder-slate-400 focus:outline-none focus:border-steam-accent"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear achievement search"
                  onClick={() => setSearchQuery('')}
                  className="min-w-6 min-h-6 flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-white cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Sort Selector */}
            <div className="flex items-center gap-1 bg-[#16202d] border border-[#2a475e] rounded px-2 py-1 sm:w-52 shrink-0">
              <ArrowUpDown className="w-3 h-3 text-slate-400 shrink-0" />
              <select
                aria-label="Sort achievements"
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value as SortOption)}
                className="w-full bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer pr-1"
              >
                <option value="default" className="bg-[#16202d] text-white">Default Order</option>
                <option value="closest_progress" className="bg-[#16202d] text-white">Closest to Unlock</option>
                <option value="unlock_date" className="bg-[#16202d] text-white">Unlock Date (Recent)</option>
                <option value="rarity_rarest" className="bg-[#16202d] text-white">Rarity (Rarest First)</option>
                <option value="rarity_common" className="bg-[#16202d] text-white">Rarity (Most Common)</option>
                <option value="name" className="bg-[#16202d] text-white">Alphabetical (A-Z)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Scrollable Achievements Cards List */}
        <div
          ref={listScrollRef}
          className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar"
        >
          {isLoading ? (
            <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-steam-accent" />
              <span className="text-xs font-semibold">Loading official storefront achievements...</span>
            </div>
          ) : displayedAchievements.length === 0 ? (
            <div className="py-20 text-center border border-dashed border-[#2a475e] rounded-xl bg-black/20 px-4">
              <Trophy className="w-10 h-10 text-slate-600 mx-auto mb-2 opacity-50" />
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
                  ? 'Classic and retro releases, standalone expansions, or developer tools do not feature achievement tracking.'
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
                  renderItem={(ach, idx) => renderAchievementCard(ach, idx)}
                />
              ) : (
                displayedAchievements.map((ach, idx) => renderAchievementCard(ach, idx))
              )}
            </div>
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
    </ModalShell>
  );
};
