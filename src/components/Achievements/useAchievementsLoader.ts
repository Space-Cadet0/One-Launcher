import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import type { MultiStoreAchievementsMap } from '../../contracts/achievement';
import { achievementDetailService } from '../../services/achievements/achievementDetailService';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import {
  filterMapToOwnedStorefronts,
  hasHigherPlatformUnlockedSummary,
  resolvePreferredStorefront,
  shouldSwrRevalidateMap,
} from './achievementsModalTypes';

export interface UseAchievementsLoaderParams {
  isOpen: boolean;
  game: CanonicalGame | null;
  initialStorefrontId?: StorefrontId;
  onResetFilterUi: () => void;
}

export function useAchievementsLoader({
  isOpen,
  game,
  initialStorefrontId,
  onResetFilterUi,
}: UseAchievementsLoaderParams) {
  const [multiStoreData, setMultiStoreData] = useState<MultiStoreAchievementsMap>({});
  const [activeStorefront, setActiveStorefront] = useState<StorefrontId>('steam');
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [failedIconKeys, setFailedIconKeys] = useState<Set<string>>(new Set());
  const [isOnline, setIsOnline] = useState<boolean>(() => onlineLifecycleManager.isOnline());

  const multiStoreDataRef = useRef<MultiStoreAchievementsMap>(multiStoreData);
  const fetchSeqRef = useRef(0);
  const onResetFilterUiRef = useRef(onResetFilterUi);
  multiStoreDataRef.current = multiStoreData;
  onResetFilterUiRef.current = onResetFilterUi;

  // Strictly only show tabs for storefronts actually owned on `game.platforms` (prevents phantom Steam tab!)
  const availableStorefronts = useMemo<StorefrontId[]>(() => {
    if (!game) return [];
    const ownedIds = new Set<StorefrontId>(
      (game.platforms || []).map((p) => p.platformId as StorefrontId)
    );
    const ids: StorefrontId[] = [];
    const pushIfOwned = (storeId: StorefrontId) => {
      if (ownedIds.has(storeId) && !ids.includes(storeId)) {
        ids.push(storeId);
      }
    };

    if (multiStoreData.steam) pushIfOwned('steam');
    if (multiStoreData.epic) pushIfOwned('epic');
    if (multiStoreData.xbox) pushIfOwned('xbox');
    if (multiStoreData.gog) pushIfOwned('gog');

    for (const p of game.platforms) {
      const pid = p.platformId as StorefrontId;
      if (!ids.includes(pid)) {
        ids.push(pid);
      }
    }
    return ids;
  }, [game, multiStoreData]);

  useEffect(() => {
    if (!isOpen || !game) return;
    let cancelled = false;
    const reqSeq = ++fetchSeqRef.current;

    onResetFilterUiRef.current();
    setFailedIconKeys(new Set());
    const currentlyOnline = onlineLifecycleManager.isOnline();
    setIsOnline(currentlyOnline);

    const preferredStore = resolvePreferredStorefront(game, initialStorefrontId);
    setActiveStorefront(preferredStore);

    const applyResolvedData = (rawData: MultiStoreAchievementsMap) => {
      if (cancelled || fetchSeqRef.current !== reqSeq) return;
      const ownedData = filterMapToOwnedStorefronts(game, rawData);
      setMultiStoreData(ownedData);
      if (!ownedData[preferredStore]) {
        const firstWithData = Object.keys(ownedData)[0] as StorefrontId | undefined;
        if (firstWithData) setActiveStorefront(firstWithData);
      }
    };

    const rawSyncCached =
      typeof achievementDetailService.peekCachedGameAchievements === 'function'
        ? achievementDetailService.peekCachedGameAchievements(game.id)
        : null;
    const syncCached = rawSyncCached ? filterMapToOwnedStorefronts(game, rawSyncCached) : null;

    if (syncCached && Object.keys(syncCached).length > 0) {
      applyResolvedData(syncCached);
      setIsLoading(false);

      const hasElectronIpc =
        typeof window !== 'undefined' && Boolean(window.electronAPI?.getStoreAchievements);
      const needsSwr =
        shouldSwrRevalidateMap(syncCached) || hasHigherPlatformUnlockedSummary(game, syncCached);
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
        const ownedFresh = fresh ? filterMapToOwnedStorefronts(game, fresh) : {};
        if (Object.keys(ownedFresh).length > 0) {
          setMultiStoreData(ownedFresh);
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
            setMultiStoreData(filterMapToOwnedStorefronts(game, data));
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

  const markIconFailed = useCallback((iconKey: string) => {
    setFailedIconKeys((prev) => {
      if (prev.has(iconKey)) return prev;
      const next = new Set(prev);
      next.add(iconKey);
      return next;
    });
  }, []);

  return {
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
  };
}
