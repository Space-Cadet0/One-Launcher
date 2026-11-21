/**
 * Epic Games Store detailed achievement provider:
 * - Unified Electron cloud IPC (`store:get-achievements`), `fetchEpicGameSchema`, and canonical fallback
 * - Normalizes `unlockedAt` timestamps and validates progress without fabricating unlocks or XP.
 */

import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { DetailedAchievement, StorefrontAchievementsData } from '../../contracts/achievement';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import {
  KNOWN_USER_EPIC_ACHIEVEMENTS,
  getKnownEpicAchievements,
} from '../storage/knownGameAchievements';
import {
  ACHIEVEMENT_CACHE_VERSION,
  classifyRarityTier,
  deduplicateDetailedAchievements,
  extractLiveAchievementsList,
  normalizeAchievementProgress,
  normalizeUnlockTimestamp,
  type RawStoreAchievementRecord,
  type StoreAchievementsEnvelope,
} from './achievementNormalizer';

export async function fetchEpicDetailedAchievementsProvider(
  game: CanonicalGame,
  getCanonicalSchema: (game: CanonicalGame) => Promise<DetailedAchievement[]>,
  platformGameId?: string,
  existingSummary?: StoreAchievementSummary,
  canonicalSchema?: DetailedAchievement[],
  lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
): Promise<StorefrontAchievementsData | null> {
  const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
  const targetId = platformGameId || epicPlatform?.platformGameId || game.id;
  const titleLower = (game.title || '').toLowerCase().trim();
  const epicNamespace = epicPlatform?.namespace;

  const summary = existingSummary || epicPlatform?.achievements;
  const cachedUserEpic =
    getKnownEpicAchievements(targetId, game.title) ||
    (epicNamespace ? getKnownEpicAchievements(epicNamespace, game.title) : undefined);
  const userEpic =
    (cachedUserEpic && (!summary || cachedUserEpic.unlocked >= (summary.unlocked || 0))
      ? cachedUserEpic
      : summary) ||
    KNOWN_USER_EPIC_ACHIEVEMENTS[targetId] ||
    KNOWN_USER_EPIC_ACHIEVEMENTS[`epic-${targetId}`] ||
    KNOWN_USER_EPIC_ACHIEVEMENTS[titleLower] ||
    summary;

  const mapRawEpicItem = (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
    const globalPct =
      typeof rawAch.globalPercentage === 'number'
        ? rawAch.globalPercentage
        : typeof rawAch.rarityPercent === 'number'
          ? rawAch.rarityPercent
          : typeof rawAch.rarity === 'number'
            ? rawAch.rarity
            : undefined;
    const unlockedIcon =
      rawAch.iconUnlockedUrl || rawAch.unlockedIconUrl || game.headerImage || '';
    const validProgress = normalizeAchievementProgress(rawAch.progress);
    const normalizedUnlockedAt = normalizeUnlockTimestamp(
      rawAch.unlockedAt ?? rawAch.unlockTime ?? rawAch.date_unlocked
    );

    return {
      id: rawAch.id || `epic:${targetId}:${rawAch.apiName || rawAch.achievementId || idx}`,
      apiName: String(rawAch.apiName || rawAch.achievementId || `EPIC_ACH_${idx + 1}`),
      name:
        rawAch.name ||
        rawAch.unlockedDisplayName ||
        rawAch.title ||
        `${game.title} Achievement #${idx + 1}`,
      description:
        rawAch.description ||
        rawAch.unlockedDescription ||
        rawAch.lockedDescription ||
        undefined,
      isSecret: Boolean(rawAch.hidden || rawAch.isHidden || rawAch.isSecret),
      unlocked: Boolean(rawAch.unlocked || rawAch.isUnlocked || Boolean(normalizedUnlockedAt)),
      unlockedAt: normalizedUnlockedAt,
      iconUnlockedUrl: unlockedIcon,
      iconLockedUrl: rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon,
      globalPercentage: globalPct,
      rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
      ...(validProgress ? { progress: validProgress } : {}),
      xp: typeof rawAch.xp === 'number' && Number.isFinite(rawAch.xp) ? rawAch.xp : undefined,
      ...(rawAch.tierName ? { tierName: rawAch.tierName } : {}),
      ...(typeof rawAch.isBaseGame === 'boolean'
        ? { isBaseGame: rawAch.isBaseGame }
        : typeof rawAch.isBase === 'boolean'
          ? { isBaseGame: rawAch.isBase }
          : {}),
      ...(rawAch.achievementSetId ? { achievementSetId: rawAch.achievementSetId } : {}),
      storefrontId: 'epic',
    };
  };

  let schema: DetailedAchievement[] | null = null;
  let schemaHasAuthoritativeUnlocks = false;
  let liveEpicEnvelope: StoreAchievementsEnvelope | null = null;

  // 1. Primary: Unified Electron Main-Process Cloud Provider (`store:get-achievements`)
  if (typeof window !== 'undefined' && window.electronAPI?.getStoreAchievements) {
    try {
      const liveRes = await window.electronAPI.getStoreAchievements({
        platformId: 'epic',
        storefrontId: 'epic',
        gameId: game.id,
        platformGameId: targetId,
        appName: epicPlatform?.storefrontAppId || targetId,
        namespace: epicNamespace,
        catalogItemId: epicPlatform?.catalogItemId,
        title: game.title,
      });
      const { list: rawLiveList, envelope: liveEnv } = extractLiveAchievementsList(liveRes);
      liveEpicEnvelope = liveEnv;
      if (
        liveEnv?.supportsAchievements === false &&
        (!rawLiveList || rawLiveList.length === 0) &&
        !(userEpic && (userEpic.total > 0 || userEpic.unlocked > 0))
      ) {
        return {
          storefrontId: 'epic',
          storefrontName: 'Epic Games',
          total: 0,
          unlocked: 0,
          percentage: 0,
          isMastered: false,
          achievements: [],
          syncedAt: liveEnv.syncedAt || new Date().toISOString(),
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: false,
          cacheVersion: ACHIEVEMENT_CACHE_VERSION,
        };
      }
      if (rawLiveList && rawLiveList.length > 0) {
        schemaHasAuthoritativeUnlocks =
          liveEnv?.unlockPrecision === 'exact' ||
          rawLiveList.some(
            (r) =>
              Boolean(r.unlocked) ||
              Boolean(normalizeUnlockTimestamp(r.unlockedAt ?? r.unlockTime)) ||
              Boolean(r.progress)
          );
        schema = rawLiveList.map(mapRawEpicItem);
      }
    } catch {
      // Fall through to fetchEpicGameSchema
    }
  }

  // 2. Secondary: `epic:fetch-game-schema` IPC
  if (
    (!schema || schema.length === 0) &&
    typeof window !== 'undefined' &&
    window.electronAPI?.fetchEpicGameSchema
  ) {
    try {
      const schemaRes = await window.electronAPI.fetchEpicGameSchema({
        appName: epicPlatform?.storefrontAppId || targetId,
        namespace: epicNamespace,
        catalogItemId: epicPlatform?.catalogItemId,
        title: game.title,
      });
      const { list: rawSchemaList } = extractLiveAchievementsList(schemaRes);
      if (rawSchemaList && rawSchemaList.length > 0) {
        schemaHasAuthoritativeUnlocks = rawSchemaList.some(
          (r) =>
            typeof r.unlocked === 'boolean' ||
            Boolean(normalizeUnlockTimestamp(r.unlockedAt ?? r.unlockTime))
        );
        schema = rawSchemaList.map(mapRawEpicItem);
      }
    } catch {
      // Fall back to canonical game schema
    }
  }

  const summaryUnlockedCount = userEpic?.unlocked || 0;

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
    const fallbackTotal = userEpic?.total || 0;
    const fallbackPct =
      fallbackTotal > 0 ? Math.round((summaryUnlockedCount / fallbackTotal) * 100) : 0;
    const isOffline = !onlineLifecycleManager.isOnline();
    const hasKnownEpicAchievements =
      fallbackTotal > 0 ||
      summaryUnlockedCount > 0 ||
      (userEpic?.xp?.total ?? 0) > 0 ||
      (userEpic?.xp?.earned ?? 0) > 0;
    return {
      storefrontId: 'epic',
      storefrontName: 'Epic Games',
      total: fallbackTotal,
      unlocked: summaryUnlockedCount,
      percentage: fallbackPct,
      isMastered: fallbackTotal > 0 && summaryUnlockedCount >= fallbackTotal,
      ...(userEpic?.xp?.total !== undefined ? { totalXp: userEpic.xp.total } : {}),
      ...(userEpic?.xp?.earned !== undefined ? { earnedXp: userEpic.xp.earned } : {}),
      achievements: [],
      syncedAt: userEpic?.syncedAt,
      source: 'schema_fallback',
      unlockPrecision: summaryUnlockedCount > 0 ? 'summary_count_only' : 'exact',
      supportsAchievements: hasKnownEpicAchievements || isOffline,
      schemaUnavailableOffline: hasKnownEpicAchievements || isOffline,
    };
  }

  const effectiveSchema = [...schema];
  const totalCount = Math.max(effectiveSchema.length, userEpic?.total || 0);

  let sumSchemaXp = 0;
  let sumEarnedSchemaXp = 0;
  let hasSchemaXp = false;

  const achievements: DetailedAchievement[] = effectiveSchema.map((baseAch, index) => {
    const isUnlocked = Boolean(baseAch.unlocked);
    const xpVal =
      typeof baseAch.xp === 'number' && Number.isFinite(baseAch.xp) ? baseAch.xp : undefined;

    if (xpVal !== undefined) {
      hasSchemaXp = true;
      sumSchemaXp += xpVal;
      if (isUnlocked) sumEarnedSchemaXp += xpVal;
    }

    return {
      ...baseAch,
      id: baseAch.id || `epic:${targetId}:${baseAch.apiName || baseAch.name || index}`,
      unlocked: isUnlocked,
      unlockedAt: normalizeUnlockTimestamp(baseAch.unlockedAt),
      ...(xpVal !== undefined ? { xp: xpVal } : {}),
      storefrontId: 'epic',
    };
  });

  const exactUnlocked = achievements.filter((a) => a.unlocked).length;
  const hasExactUnlocks = schemaHasAuthoritativeUnlocks || exactUnlocked > 0;
  const effectiveUnlocked = hasExactUnlocks ? exactUnlocked : summaryUnlockedCount;
  const unlockPrecision: 'exact' | 'summary_count_only' =
    effectiveUnlocked > 0 && !hasExactUnlocks ? 'summary_count_only' : 'exact';
  const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;
  const isMastered = totalCount > 0 && effectiveUnlocked >= totalCount;

  const envTotalXp =
    typeof liveEpicEnvelope?.totalXp === 'number' && liveEpicEnvelope.totalXp > 0
      ? liveEpicEnvelope.totalXp
      : typeof liveEpicEnvelope?.xp?.total === 'number' && liveEpicEnvelope.xp.total > 0
        ? liveEpicEnvelope.xp.total
        : undefined;
  const envEarnedXp =
    typeof liveEpicEnvelope?.earnedXp === 'number'
      ? liveEpicEnvelope.earnedXp
      : typeof liveEpicEnvelope?.xp?.earned === 'number'
        ? liveEpicEnvelope.xp.earned
        : undefined;

  const resolvedTotalXp =
    envTotalXp ?? userEpic?.xp?.total ?? (hasSchemaXp ? sumSchemaXp : undefined);
  const resolvedEarnedXp =
    envEarnedXp ?? (hasExactUnlocks && hasSchemaXp ? sumEarnedSchemaXp : userEpic?.xp?.earned);

  return deduplicateDetailedAchievements({
    storefrontId: 'epic',
    storefrontName: 'Epic Games',
    total: totalCount,
    unlocked: effectiveUnlocked,
    percentage,
    isMastered,
    ...(resolvedTotalXp !== undefined ? { totalXp: resolvedTotalXp } : {}),
    ...(resolvedEarnedXp !== undefined ? { earnedXp: resolvedEarnedXp } : {}),
    achievements,
    syncedAt: liveEpicEnvelope?.syncedAt || userEpic?.syncedAt || new Date().toISOString(),
    source: hasExactUnlocks ? 'live_cloud' : 'schema_fallback',
    unlockPrecision,
    supportsAchievements: true,
    cacheVersion: ACHIEVEMENT_CACHE_VERSION,
  });
}
