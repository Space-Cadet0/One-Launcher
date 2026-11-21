import { useState, useMemo, useCallback } from 'react';
import type { StorefrontAchievementsData } from '../../contracts/achievement';
import { deduplicateDetailedAchievements } from '../../services/achievements/achievementDetailService';
import { matchesLooseSearchQuery } from '../../services/common/titleUtils';
import type { FilterTab, SortOption } from './achievementsModalTypes';

export function useAchievementsFilterSort(
  rawStoreData: StorefrontAchievementsData | undefined,
  isOnline: boolean
) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>('all');
  const [sortOption, setSortOption] = useState<SortOption>('default');
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());

  const resetFilterUi = useCallback(() => {
    setSearchQuery('');
    setActiveFilterTab('all');
    setSortOption('default');
    setRevealedSecrets(new Set());
  }, []);

  const currentStoreData: StorefrontAchievementsData | undefined = useMemo(
    () => (rawStoreData ? deduplicateDetailedAchievements(rawStoreData) : undefined),
    [rawStoreData]
  );
  const isSummaryCountOnly = currentStoreData?.unlockPrecision === 'summary_count_only';

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

    return list.toSorted((a, b) => {
      if (sortOption === 'closest_progress') {
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
        return (a.globalPercentage ?? 100) - (b.globalPercentage ?? 100);
      }
      if (sortOption === 'rarity_common') {
        return (b.globalPercentage ?? 0) - (a.globalPercentage ?? 0);
      }
      if (sortOption === 'unlock_date') {
        if (a.unlocked && !b.unlocked) return -1;
        if (!a.unlocked && b.unlocked) return 1;
        const timeA =
          typeof a.unlockedAt === 'number'
            ? a.unlockedAt
            : a.unlockedAt
              ? new Date(a.unlockedAt).getTime()
              : 0;
        const timeB =
          typeof b.unlockedAt === 'number'
            ? b.unlockedAt
            : b.unlockedAt
              ? new Date(b.unlockedAt).getTime()
              : 0;
        return timeB - timeA;
      }
      if (sortOption === 'name') {
        return a.name.localeCompare(b.name);
      }
      if (a.unlocked && !b.unlocked) return -1;
      if (!a.unlocked && b.unlocked) return 1;
      return 0;
    });
  }, [
    currentStoreData,
    activeFilterTab,
    searchQuery,
    sortOption,
    isSummaryCountOnly,
    revealedSecrets,
  ]);

  const totalCount = currentStoreData?.total || 0;
  const unlockedCount = currentStoreData?.unlocked || 0;
  const percentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
  const isMastered = totalCount > 0 && unlockedCount >= totalCount;
  const lockedCount = Math.max(0, totalCount - unlockedCount);
  const secretCount = currentStoreData?.achievements.filter((a) => a.isSecret).length || 0;
  const isSchemaUnavailableOffline =
    Boolean(currentStoreData?.schemaUnavailableOffline) ||
    (!isOnline && totalCount > 0 && (currentStoreData?.achievements?.length || 0) === 0);

  return {
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
  };
}
