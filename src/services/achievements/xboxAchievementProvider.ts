/**
 * Xbox Live / Microsoft Store detailed achievement provider:
 * - Official Xbox Achievements v2 / DisplayCatalog via Electron IPC (`store:get-achievements`,
 *   `fetchXboxGameSchema`) with canonical fallback
 * - P0-12: Stamps `cacheVersion: ACHIEVEMENT_CACHE_VERSION` (2) on Xbox schema fallback return
 *   so modals never thrash `ipcUpgradeNeeded` on every open
 * - Validates & preserves Xbox `progress` (`max > 0`, computes missing `percentage`) on BOTH
 *   live IPC and schema paths
 * - Normalizes `unlockedAt` timestamps consistently.
 */

import {
  CanonicalGame,
  GamePlatformOwnership,
  StoreAchievementSummary,
} from '../../contracts/game';
import { DetailedAchievement, StorefrontAchievementsData } from '../../contracts/achievement';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import {
  KNOWN_USER_XBOX_ACHIEVEMENTS,
  getKnownXboxAchievements,
} from '../storage/knownGameAchievements';
import {
  ACHIEVEMENT_CACHE_VERSION,
  classifyRarityTier,
  deduplicateDetailedAchievements,
  extractLiveAchievementsList,
  normalizeAchievementProgress,
  normalizeUnlockTimestamp,
  type RawRewardItem,
  type RawStoreAchievementRecord,
} from './achievementNormalizer';

export async function fetchXboxDetailedAchievementsProvider(
  game: CanonicalGame,
  getCanonicalSchema: (game: CanonicalGame) => Promise<DetailedAchievement[]>,
  xboxPlatform?: GamePlatformOwnership,
  existingSummary?: StoreAchievementSummary,
  canonicalSchema?: DetailedAchievement[],
  lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
): Promise<StorefrontAchievementsData | null> {
  const plat = xboxPlatform || game.platforms.find((p) => p.platformId === 'xbox');
  const targetId =
    plat?.xboxProductId ||
    plat?.platformGameId ||
    plat?.xboxTitleId ||
    plat?.packageFamilyName ||
    game.id;
  const titleLower = (game.title || '').toLowerCase().trim();

  const summary = existingSummary || plat?.achievements;
  const cachedUserXbox = getKnownXboxAchievements(targetId, game.title, [
    plat?.xboxProductId,
    plat?.packageFamilyName,
    plat?.xboxTitleId,
    plat?.platformGameId,
  ]);
  const userXbox =
    (cachedUserXbox &&
    (!summary ||
      cachedUserXbox.unlocked >= (summary.unlocked || 0) ||
      (cachedUserXbox.gamerscore?.earned ?? 0) >= (summary.gamerscore?.earned ?? 0))
      ? cachedUserXbox
      : summary) ||
    KNOWN_USER_XBOX_ACHIEVEMENTS[targetId] ||
    KNOWN_USER_XBOX_ACHIEVEMENTS[`xbox-${targetId}`] ||
    KNOWN_USER_XBOX_ACHIEVEMENTS[titleLower] ||
    summary;

  // 1. Live Xbox Achievements v2 via Electron IPC getStoreAchievements
  if (typeof window !== 'undefined' && window.electronAPI?.getStoreAchievements) {
    try {
      const liveRes = await window.electronAPI.getStoreAchievements({
        platformId: 'xbox',
        storefrontId: 'xbox',
        gameId: game.id,
        platformGameId: plat?.platformGameId || targetId,
        xboxProductId: plat?.xboxProductId,
        xboxTitleId: plat?.xboxTitleId,
        packageFamilyName: plat?.packageFamilyName,
        title: game.title,
      });
      const { list: rawLiveList, envelope: liveEnvelope } = extractLiveAchievementsList(liveRes);
      if (rawLiveList && rawLiveList.length > 0) {
        let sumEarnedG = 0;
        let sumTotalG = 0;
        const achievements: DetailedAchievement[] = rawLiveList.map(
          (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
            const normalizedUnlockedAt = normalizeUnlockTimestamp(
              rawAch.unlockedAt ?? rawAch.progression?.timeUnlocked ?? rawAch.unlockTime
            );
            const isUnlocked = Boolean(
              rawAch.unlocked ||
                rawAch.isUnlocked ||
                rawAch.progressState === 'Achieved' ||
                rawAch.state === 'Achieved'
            );
            const rawRewardVal =
              typeof rawAch.gamerscore === 'number'
                ? rawAch.gamerscore
                : Array.isArray(rawAch.rewards) && rawAch.rewards.length > 0
                  ? Number(
                      rawAch.rewards.find(
                        (r: RawRewardItem) =>
                          !r?.type || String(r.type).toLowerCase() === 'gamerscore'
                      )?.value ?? rawAch.rewards[0]?.value
                    )
                  : undefined;
            const gVal =
              typeof rawRewardVal === 'number' &&
              Number.isFinite(rawRewardVal) &&
              rawRewardVal >= 0
                ? Math.round(rawRewardVal)
                : undefined;
            if (gVal !== undefined) {
              sumTotalG += gVal;
              if (isUnlocked) sumEarnedG += gVal;
            }
            const rarityObj =
              rawAch.rarity && typeof rawAch.rarity === 'object' ? rawAch.rarity : undefined;
            const globalPct =
              typeof rawAch.globalPercentage === 'number'
                ? rawAch.globalPercentage
                : typeof rarityObj?.currentPercentage === 'number'
                  ? rarityObj.currentPercentage
                  : typeof rawAch.rarityPercent === 'number'
                    ? rawAch.rarityPercent
                    : undefined;
            const unlockedIcon =
              rawAch.iconUnlockedUrl ||
              rawAch.unlockedIconUrl ||
              rawAch.mediaAssets?.[0]?.url ||
              game.headerImage ||
              '';
            const validProgress = normalizeAchievementProgress(rawAch.progress);

            return {
              id:
                rawAch.id ||
                `xbox:${targetId}:${rawAch.apiName || rawAch.achievementId || idx}`,
              apiName: String(
                rawAch.apiName || rawAch.achievementId || rawAch.id || `XBOX_ACH_${idx + 1}`
              ),
              name:
                rawAch.name ||
                rawAch.title ||
                rawAch.unlockedDisplayName ||
                `${game.title} Achievement #${idx + 1}`,
              description:
                rawAch.description ||
                (isUnlocked ? rawAch.unlockedDescription : rawAch.lockedDescription) ||
                rawAch.unlockedDescription ||
                rawAch.lockedDescription ||
                undefined,
              unlocked: isUnlocked,
              unlockedAt: normalizedUnlockedAt,
              iconUnlockedUrl: unlockedIcon,
              iconLockedUrl: rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon,
              globalPercentage: globalPct,
              rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
              ...(validProgress ? { progress: validProgress } : {}),
              isSecret: Boolean(rawAch.isSecret || rawAch.isHidden || rawAch.hidden),
              gamerscore: gVal,
              storefrontId: 'xbox',
            };
          }
        );

        const total = achievements.length;
        const unlocked = achievements.filter((a) => a.unlocked).length;
        const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
        const totalGamerscore =
          (typeof liveEnvelope?.totalGamerscore === 'number' && liveEnvelope.totalGamerscore > 0
            ? liveEnvelope.totalGamerscore
            : undefined) ??
          (typeof liveEnvelope?.gamerscore?.total === 'number' && liveEnvelope.gamerscore.total > 0
            ? liveEnvelope.gamerscore.total
            : undefined) ??
          (sumTotalG > 0 ? sumTotalG : userXbox?.gamerscore?.total);
        const earnedGamerscore =
          (typeof liveEnvelope?.earnedGamerscore === 'number'
            ? liveEnvelope.earnedGamerscore
            : undefined) ??
          (typeof liveEnvelope?.gamerscore?.earned === 'number'
            ? liveEnvelope.gamerscore.earned
            : undefined) ??
          (sumTotalG > 0 ? sumEarnedG : userXbox?.gamerscore?.earned);

        return deduplicateDetailedAchievements({
          storefrontId: 'xbox',
          storefrontName: 'Xbox',
          total,
          unlocked,
          percentage,
          isMastered: total > 0 && unlocked >= total,
          ...(totalGamerscore !== undefined ? { totalGamerscore } : {}),
          ...(earnedGamerscore !== undefined ? { earnedGamerscore } : {}),
          achievements,
          syncedAt: liveEnvelope?.syncedAt || new Date().toISOString(),
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
          cacheVersion: ACHIEVEMENT_CACHE_VERSION,
        });
      }
    } catch {
      // Fall through to Xbox game schema / canonical schema fallback
    }
  }

  // 2. Try Xbox Game Schema via IPC if available
  let schema: DetailedAchievement[] | null = null;
  let schemaHasAuthoritativeUnlocks = false;

  if (typeof window !== 'undefined' && window.electronAPI?.fetchXboxGameSchema) {
    try {
      const schemaRes = await window.electronAPI.fetchXboxGameSchema({
        gameId: game.id,
        platformGameId: plat?.platformGameId || targetId,
        xboxProductId: plat?.xboxProductId,
        xboxTitleId: plat?.xboxTitleId,
        packageFamilyName: plat?.packageFamilyName,
      });
      const { list: rawSchemaList } = extractLiveAchievementsList(schemaRes);
      if (rawSchemaList && rawSchemaList.length > 0) {
        schemaHasAuthoritativeUnlocks = rawSchemaList.some(
          (r) =>
            typeof r.unlocked === 'boolean' ||
            Boolean(normalizeUnlockTimestamp(r.unlockedAt ?? r.progression?.timeUnlocked))
        );
        schema = rawSchemaList.map(
          (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
            const globalPct =
              typeof rawAch.globalPercentage === 'number'
                ? rawAch.globalPercentage
                : typeof rawAch.rarityPercent === 'number'
                  ? rawAch.rarityPercent
                  : undefined;
            const gVal =
              typeof rawAch.gamerscore === 'number' && Number.isFinite(rawAch.gamerscore)
                ? rawAch.gamerscore
                : undefined;
            const unlockedIcon =
              rawAch.iconUnlockedUrl || rawAch.unlockedIconUrl || game.headerImage || '';
            const normalizedUnlockedAt = normalizeUnlockTimestamp(
              rawAch.unlockedAt ?? rawAch.progression?.timeUnlocked ?? rawAch.unlockTime
            );
            const validProgress = normalizeAchievementProgress(rawAch.progress);

            return {
              id: rawAch.id || `xbox:${targetId}:${rawAch.apiName || idx}`,
              apiName: String(rawAch.apiName || rawAch.id || `XBOX_ACH_${idx + 1}`),
              name: rawAch.name || rawAch.title || `${game.title} Achievement #${idx + 1}`,
              description:
                rawAch.description ||
                rawAch.unlockedDescription ||
                rawAch.lockedDescription ||
                undefined,
              isSecret: Boolean(rawAch.isSecret || rawAch.hidden || rawAch.isHidden),
              unlocked: Boolean(rawAch.unlocked || rawAch.isUnlocked || Boolean(normalizedUnlockedAt)),
              unlockedAt: normalizedUnlockedAt,
              iconUnlockedUrl: unlockedIcon,
              iconLockedUrl: rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon,
              globalPercentage: globalPct,
              rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
              ...(validProgress ? { progress: validProgress } : {}),
              gamerscore: gVal,
              storefrontId: 'xbox',
            };
          }
        );
      }
    } catch {
      // Fall back to canonical game schema
    }
  }

  const summaryUnlockedCount = userXbox?.unlocked || 0;

  if (!schema || schema.length === 0) {
    schema =
      canonicalSchema && canonicalSchema.length > 0
        ? canonicalSchema
        : lazyCanonicalSchema
          ? await lazyCanonicalSchema()
          : onlineLifecycleManager.isOnline()
            ? await getCanonicalSchema(game)
            : [];
  }

  if (!schema || schema.length === 0) {
    const fallbackTotal = userXbox?.total || 0;
    const fallbackPct =
      fallbackTotal > 0 ? Math.round((summaryUnlockedCount / fallbackTotal) * 100) : 0;
    const hasSummaryProgress =
      summaryUnlockedCount > 0 || (userXbox?.gamerscore?.earned ?? 0) > 0;
    const isOffline = !onlineLifecycleManager.isOnline();
    const hasKnownXboxAchievements =
      fallbackTotal > 0 || hasSummaryProgress || (userXbox?.gamerscore?.total ?? 0) > 0;
    return {
      storefrontId: 'xbox',
      storefrontName: 'Xbox',
      total: fallbackTotal,
      unlocked: summaryUnlockedCount,
      percentage: fallbackPct,
      isMastered: fallbackTotal > 0 && summaryUnlockedCount >= fallbackTotal,
      ...(userXbox?.gamerscore?.total !== undefined
        ? { totalGamerscore: userXbox.gamerscore.total }
        : {}),
      ...(userXbox?.gamerscore?.earned !== undefined
        ? { earnedGamerscore: userXbox.gamerscore.earned }
        : {}),
      achievements: [],
      syncedAt: userXbox?.syncedAt,
      source: 'schema_fallback',
      unlockPrecision: hasSummaryProgress ? 'summary_count_only' : 'exact',
      supportsAchievements: hasKnownXboxAchievements || isOffline,
      schemaUnavailableOffline: hasKnownXboxAchievements || isOffline,
    };
  }

  const effectiveSchema = [...schema];
  const totalCount = Math.max(effectiveSchema.length, userXbox?.total || 0);

  let sumSchemaTotalG = 0;
  let sumSchemaEarnedG = 0;
  let hasSchemaGamerscore = false;

  const achievements: DetailedAchievement[] = effectiveSchema.map((baseAch, index) => {
    const isUnlocked = Boolean(baseAch.unlocked);
    const gVal =
      typeof baseAch.gamerscore === 'number' &&
      Number.isFinite(baseAch.gamerscore) &&
      baseAch.gamerscore >= 0
        ? baseAch.gamerscore
        : undefined;

    if (gVal !== undefined) {
      hasSchemaGamerscore = true;
      sumSchemaTotalG += gVal;
      if (isUnlocked) sumSchemaEarnedG += gVal;
    }

    const validProgress = normalizeAchievementProgress(baseAch.progress);

    return {
      ...baseAch,
      id: `xbox:${targetId}:${baseAch.apiName || baseAch.name || index}`,
      unlocked: isUnlocked,
      unlockedAt: normalizeUnlockTimestamp(baseAch.unlockedAt),
      ...(validProgress ? { progress: validProgress } : {}),
      ...(gVal !== undefined ? { gamerscore: gVal } : {}),
      storefrontId: 'xbox',
    };
  });

  const exactUnlocked = achievements.filter((a) => a.unlocked).length;
  const hasExactUnlocks = schemaHasAuthoritativeUnlocks || exactUnlocked > 0;
  const effectiveUnlocked = hasExactUnlocks ? exactUnlocked : summaryUnlockedCount;
  const hasSummaryProgress =
    effectiveUnlocked > 0 || (userXbox?.gamerscore?.earned ?? 0) > 0;
  const unlockPrecision: 'exact' | 'summary_count_only' =
    hasSummaryProgress && !hasExactUnlocks ? 'summary_count_only' : 'exact';
  const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;
  const isMastered = totalCount > 0 && effectiveUnlocked >= totalCount;

  const totalGamerscore =
    userXbox?.gamerscore?.total ?? (hasSchemaGamerscore ? sumSchemaTotalG : undefined);
  const earnedGamerscore =
    userXbox?.gamerscore?.earned ??
    (hasExactUnlocks && hasSchemaGamerscore ? sumSchemaEarnedG : undefined);

  return deduplicateDetailedAchievements({
    storefrontId: 'xbox',
    storefrontName: 'Xbox',
    total: totalCount,
    unlocked: effectiveUnlocked,
    percentage,
    isMastered,
    ...(totalGamerscore !== undefined ? { totalGamerscore } : {}),
    ...(earnedGamerscore !== undefined ? { earnedGamerscore } : {}),
    achievements,
    syncedAt: userXbox?.syncedAt || new Date().toISOString(),
    source: hasExactUnlocks ? 'live_cloud' : 'schema_fallback',
    unlockPrecision,
    supportsAchievements: true,
    // P0-12: Stamp cacheVersion: 2 on Xbox schema fallback return to eliminate repeated ipcUpgradeNeeded storms
    cacheVersion: ACHIEVEMENT_CACHE_VERSION,
  });
}
