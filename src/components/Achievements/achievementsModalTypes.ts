import type React from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import type { MultiStoreAchievementsMap } from '../../contracts/achievement';

export interface GameAchievementsModalProps {
  isOpen: boolean;
  game: CanonicalGame | null;
  initialStorefrontId?: StorefrontId;
  onClose: () => void;
}

export type FilterTab = 'all' | 'unlocked' | 'locked' | 'in_progress' | 'secret';

export type SortOption =
  | 'default'
  | 'closest_progress'
  | 'rarity_rarest'
  | 'rarity_common'
  | 'unlock_date'
  | 'name';

export type ProgressFillStyle = React.CSSProperties & { '--ol-progress-fill'?: string };

export const SWR_STALE_AGE_MS = 5 * 60 * 1000;

/**
 * Filter an achievements map strictly to storefronts actually owned on `game.platforms`
 * so metadata-matched `game.steamAppId` or stale vault entries never inject a phantom Steam tab.
 */
export function filterMapToOwnedStorefronts(
  game: CanonicalGame,
  data: MultiStoreAchievementsMap
): MultiStoreAchievementsMap {
  const ownedIds = new Set<StorefrontId>(
    (game.platforms || []).map((p) => p.platformId as StorefrontId)
  );
  if (ownedIds.size === 0) return data;

  const filtered: MultiStoreAchievementsMap = {};
  for (const key of Object.keys(data) as StorefrontId[]) {
    if (ownedIds.has(key) && data[key]) {
      filtered[key] = data[key];
    }
  }
  return filtered;
}

export function resolvePreferredStorefront(
  game: CanonicalGame,
  initialStorefrontId?: StorefrontId
): StorefrontId {
  const ownedIds = new Set<StorefrontId>(
    (game.platforms || []).map((p) => p.platformId as StorefrontId)
  );
  if (initialStorefrontId && (ownedIds.size === 0 || ownedIds.has(initialStorefrontId))) {
    return initialStorefrontId;
  }
  if (ownedIds.has('steam')) {
    return 'steam';
  }
  return (game.platforms[0]?.platformId || 'steam') as StorefrontId;
}

export function shouldSwrRevalidateMap(map: MultiStoreAchievementsMap): boolean {
  const entries = Object.values(map);
  if (entries.length === 0) return true;
  const now = Date.now();
  return entries.some((entry) => {
    if (!entry) return false;
    if (entry.schemaUnavailableOffline) return true;
    if (entry.unlockPrecision === 'summary_count_only') return true;
    if ((entry.cacheVersion ?? 0) < 2) return true;
    if (
      Array.isArray(entry.achievements) &&
      entry.achievements.length > 0 &&
      entry.total !== entry.achievements.length
    ) {
      return true;
    }
    if ((entry.total || 0) === 0 && !entry.syncedAt) return true;
    if (entry.syncedAt) {
      const syncedMs = Date.parse(entry.syncedAt);
      if (!Number.isNaN(syncedMs) && now - syncedMs > SWR_STALE_AGE_MS) {
        return true;
      }
    }
    return false;
  });
}

export function hasHigherPlatformUnlockedSummary(
  game: CanonicalGame,
  cachedMap: MultiStoreAchievementsMap
): boolean {
  return game.platforms.some((plat) => {
    const summaryUnlocked = plat.achievements?.unlocked ?? 0;
    const summaryTotal = plat.achievements?.total ?? 0;
    if (summaryUnlocked <= 0 && summaryTotal <= 0) return false;
    const cachedEntry = cachedMap[plat.platformId as StorefrontId];
    if (!cachedEntry) return true;
    return summaryUnlocked > cachedEntry.unlocked || summaryTotal > cachedEntry.total;
  });
}

export function resolveNoAchievementsSubtitle(
  activeStorefront: StorefrontId,
  multiStoreData: MultiStoreAchievementsMap
): string {
  const otherStorefrontHasAchievements = Object.entries(multiStoreData).some(
    ([storeKey, data]) => storeKey !== activeStorefront && (data?.total ?? 0) > 0
  );
  if (otherStorefrontHasAchievements) {
    const storeName = STOREFRONT_REGISTRY[activeStorefront]?.name || activeStorefront;
    return `This publisher did not integrate ${storeName} achievements for this release, though achievements are available on another connected storefront.`;
  }
  if (activeStorefront === 'epic') {
    return 'This release does not have Epic Achievements configured by the publisher on the Epic Games Store (many pre-2021 releases and select editions omit Epic Achievements).';
  }
  return 'Classic and retro releases, standalone expansions, or developer tools do not feature achievement tracking.';
}
