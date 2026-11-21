/**
 * GOG Galaxy detailed achievement provider:
 * - Calls unified object-payload `window.electronAPI.getStoreAchievements({ platformId: 'gog', ... })`
 *   (no fragile `ipcFn.length >= 2` arity check)
 * - Skips wasted Steam schema fetches for complete / 100%-mastered GOG games
 * - Reconciles partial live unlock lists against canonical schemas without fabricating unlocks
 * - Normalizes `unlockedAt` timestamps and preserves Hard Invariant 1 deduplication.
 */

import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { DetailedAchievement, StorefrontAchievementsData } from '../../contracts/achievement';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import {
  KNOWN_USER_GOG_ACHIEVEMENTS,
  getKnownGogAchievements,
} from '../storage/knownGameAchievements';
import {
  ACHIEVEMENT_CACHE_VERSION,
  classifyRarityTier,
  deduplicateDetailedAchievements,
  extractLiveAchievementsList,
  normalizeAchievementMatchKey,
  normalizeAchievementProgress,
  normalizeUnlockTimestamp,
  type RawStoreAchievementRecord,
  type StoreAchievementsEnvelope,
} from './achievementNormalizer';

export async function fetchGogDetailedAchievementsProvider(
  game: CanonicalGame,
  getCanonicalSchema: (game: CanonicalGame) => Promise<DetailedAchievement[]>,
  platformGameId?: string,
  existingSummary?: StoreAchievementSummary,
  canonicalSchema?: DetailedAchievement[],
  lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
): Promise<StorefrontAchievementsData | null> {
  const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
  const targetId = platformGameId || gogPlatform?.platformGameId || game.id;
  const titleLower = (game.title || '').toLowerCase().trim();

  const summary = existingSummary || gogPlatform?.achievements;
  const cachedUserGog = getKnownGogAchievements(targetId, game.title);
  const userGog =
    (cachedUserGog && (!summary || cachedUserGog.unlocked >= (summary.unlocked || 0))
      ? cachedUserGog
      : summary) ||
    KNOWN_USER_GOG_ACHIEVEMENTS[targetId] ||
    KNOWN_USER_GOG_ACHIEVEMENTS[`gog-${targetId}`] ||
    KNOWN_USER_GOG_ACHIEVEMENTS[titleLower] ||
    summary;

  // 1. Live GOG Gameplay API per-achievement records via unified object-payload Electron IPC
  let liveGogItems: RawStoreAchievementRecord[] | null = null;
  let liveGogEnvelope: StoreAchievementsEnvelope | null = null;

  if (typeof window !== 'undefined' && window.electronAPI?.getStoreAchievements) {
    try {
      const rawLiveRes = await window.electronAPI.getStoreAchievements({
        platformId: 'gog',
        storefrontId: 'gog',
        gameId: game.id,
        platformGameId: gogPlatform?.platformGameId || targetId,
        title: game.title,
      });
      const extracted = extractLiveAchievementsList(rawLiveRes);
      liveGogItems = extracted.list;
      liveGogEnvelope = extracted.envelope;
    } catch {
      // Fall through to schema reconciliation
    }
  }

  if (
    liveGogEnvelope?.supportsAchievements === false &&
    (!liveGogItems || liveGogItems.length === 0) &&
    !(userGog && (userGog.total > 0 || userGog.unlocked > 0))
  ) {
    return {
      storefrontId: 'gog',
      storefrontName: 'GOG GALAXY',
      total: 0,
      unlocked: 0,
      percentage: 0,
      isMastered: false,
      achievements: [],
      syncedAt: liveGogEnvelope.syncedAt || new Date().toISOString(),
      source: 'live_cloud',
      unlockPrecision: 'exact',
      supportsAchievements: false,
      cacheVersion: ACHIEVEMENT_CACHE_VERSION,
    };
  }

  const resolveFallbackSchema = async (): Promise<DetailedAchievement[]> => {
    if (canonicalSchema && canonicalSchema.length > 0) return canonicalSchema;
    if (lazyCanonicalSchema) return await lazyCanonicalSchema();
    return onlineLifecycleManager.isOnline() ? await getCanonicalSchema(game) : [];
  };

  if (liveGogItems && liveGogItems.length > 0) {
    const hasLockedItem = liveGogItems.some(
      (item) => !item.date_unlocked && !item.unlocked && !item.isUnlocked
    );
    const matchesEnvelopeTotal =
      typeof liveGogEnvelope?.totalCount === 'number' &&
      liveGogEnvelope.totalCount > 0 &&
      liveGogItems.length >= liveGogEnvelope.totalCount;
    const matchesSummaryTotal =
      typeof userGog?.total === 'number' &&
      userGog.total > 0 &&
      liveGogItems.length >= userGog.total;

    // A 100%-mastered GOG game has zero locked items, yet its item count matches the known total:
    // skip wasted Steam schema fetch when the live GOG payload is already complete and has assets!
    const liveLooksComplete =
      (hasLockedItem && liveGogItems.length >= (userGog?.total || 0)) ||
      matchesEnvelopeTotal ||
      matchesSummaryTotal;

    const liveMissingAssets = liveGogItems.some(
      (item) =>
        (!item.image_url_unlocked && !item.iconUnlockedUrl && !item.unlockedIconUrl) ||
        (!item.name && !item.title)
    );

    const schema =
      canonicalSchema && canonicalSchema.length > 0
        ? canonicalSchema
        : !liveLooksComplete || liveMissingAssets
          ? await resolveFallbackSchema()
          : [];

    const schemaByKey = new Map<string, DetailedAchievement>();
    for (const sAch of schema) {
      const k1 = normalizeAchievementMatchKey(sAch.apiName);
      const k2 = normalizeAchievementMatchKey(sAch.name);
      if (k1 && !schemaByKey.has(k1)) schemaByKey.set(k1, sAch);
      if (k2 && !schemaByKey.has(k2)) schemaByKey.set(k2, sAch);
    }

    const hasFullLiveSchema =
      hasLockedItem ||
      matchesEnvelopeTotal ||
      liveGogItems.length >= Math.max(schema.length, userGog?.total || 0);

    if (hasFullLiveSchema || schema.length === 0) {
      const achievements: DetailedAchievement[] = liveGogItems.map(
        (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
          const rawKey = String(
            rawAch.achievement_key ||
              rawAch.apiName ||
              rawAch.achievement_id ||
              rawAch.achievementId ||
              rawAch.id ||
              `GOG_ACH_${idx + 1}`
          );
          const fallbackSchemaAch =
            schemaByKey.get(normalizeAchievementMatchKey(rawKey)) ||
            schemaByKey.get(normalizeAchievementMatchKey(rawAch.name || rawAch.title));

          const normalizedUnlockedAt = normalizeUnlockTimestamp(
            rawAch.date_unlocked ?? rawAch.unlockedAt ?? rawAch.unlockTime
          );
          const isUnlocked = Boolean(
            rawAch.unlocked || rawAch.isUnlocked || Boolean(normalizedUnlockedAt)
          );
          const globalPct =
            typeof rawAch.rarity === 'number'
              ? rawAch.rarity
              : typeof rawAch.globalPercentage === 'number'
                ? rawAch.globalPercentage
                : typeof rawAch.rarityPercent === 'number'
                  ? rawAch.rarityPercent
                  : fallbackSchemaAch?.globalPercentage;
          const unlockedIcon =
            rawAch.image_url_unlocked ||
            rawAch.iconUnlockedUrl ||
            rawAch.unlockedIconUrl ||
            fallbackSchemaAch?.iconUnlockedUrl ||
            game.headerImage ||
            '';
          const lockedIcon =
            rawAch.image_url_locked ||
            rawAch.iconLockedUrl ||
            rawAch.lockedIconUrl ||
            fallbackSchemaAch?.iconLockedUrl ||
            unlockedIcon;
          const validProgress = normalizeAchievementProgress(rawAch.progress);

          return {
            id: `gog:${targetId}:${rawAch.achievement_id || rawKey || idx}`,
            apiName: rawKey,
            name:
              rawAch.name ||
              rawAch.title ||
              fallbackSchemaAch?.name ||
              `${game.title} Achievement #${idx + 1}`,
            description:
              rawAch.description ||
              rawAch.unlockedDescription ||
              rawAch.lockedDescription ||
              fallbackSchemaAch?.description ||
              undefined,
            unlocked: isUnlocked,
            unlockedAt: normalizedUnlockedAt,
            iconUnlockedUrl: unlockedIcon,
            iconLockedUrl: lockedIcon,
            globalPercentage: globalPct,
            rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
            ...(validProgress ? { progress: validProgress } : {}),
            isSecret:
              rawAch.visible === false ||
              Boolean(rawAch.isSecret || rawAch.hidden || rawAch.isHidden),
            storefrontId: 'gog',
          };
        }
      );

      const total =
        typeof liveGogEnvelope?.totalCount === 'number' &&
        liveGogEnvelope.totalCount >= achievements.length
          ? liveGogEnvelope.totalCount
          : achievements.length;
      const unlocked = achievements.filter((a) => a.unlocked).length;
      const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

      return deduplicateDetailedAchievements({
        storefrontId: 'gog',
        storefrontName: 'GOG GALAXY',
        total,
        unlocked,
        percentage,
        isMastered: total > 0 && unlocked >= total,
        achievements,
        syncedAt: liveGogEnvelope?.syncedAt || new Date().toISOString(),
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: true,
        cacheVersion: ACHIEVEMENT_CACHE_VERSION,
      });
    }

    // Partial live unlock list: reconcile unlocked IDs/keys against canonical schema
    const unlockedLookup = new Map<string, string | undefined>();
    for (const rawAch of liveGogItems) {
      const ts = normalizeUnlockTimestamp(
        rawAch.date_unlocked ?? rawAch.unlockedAt ?? rawAch.unlockTime
      );
      const isUnlocked = Boolean(rawAch.unlocked || rawAch.isUnlocked || Boolean(ts));
      if (!isUnlocked) continue;
      for (const candidateKey of [
        rawAch.achievement_id,
        rawAch.achievement_key,
        rawAch.apiName,
        rawAch.achievementId,
        rawAch.id,
        rawAch.name,
        rawAch.title,
      ]) {
        const normKey = normalizeAchievementMatchKey(candidateKey);
        if (normKey && !unlockedLookup.has(normKey)) {
          unlockedLookup.set(normKey, ts);
        }
      }
    }

    const reconciledAchievements: DetailedAchievement[] = schema.map((baseAch, index) => {
      const apiKey = normalizeAchievementMatchKey(baseAch.apiName);
      const nameKey = normalizeAchievementMatchKey(baseAch.name);
      const matchedUnlocked = unlockedLookup.has(apiKey) || unlockedLookup.has(nameKey);
      const matchedTs = unlockedLookup.get(apiKey) ?? unlockedLookup.get(nameKey);
      return {
        ...baseAch,
        id: `gog:${targetId}:${baseAch.apiName || baseAch.name || index}`,
        unlocked: matchedUnlocked,
        unlockedAt: matchedUnlocked ? matchedTs : undefined,
        storefrontId: 'gog',
      };
    });

    const total = schema.length;
    const unlocked = reconciledAchievements.filter((a) => a.unlocked).length;
    const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

    return deduplicateDetailedAchievements({
      storefrontId: 'gog',
      storefrontName: 'GOG GALAXY',
      total,
      unlocked,
      percentage,
      isMastered: total > 0 && unlocked >= total,
      achievements: reconciledAchievements,
      syncedAt: liveGogEnvelope?.syncedAt || new Date().toISOString(),
      source: 'live_cloud',
      unlockPrecision: 'exact',
      supportsAchievements: true,
      cacheVersion: ACHIEVEMENT_CACHE_VERSION,
    });
  }

  const schema = await resolveFallbackSchema();
  const summaryUnlockedCount = userGog?.unlocked || 0;

  if (!schema || schema.length === 0) {
    const fallbackTotal = userGog?.total || 0;
    const fallbackPct =
      fallbackTotal > 0 ? Math.round((summaryUnlockedCount / fallbackTotal) * 100) : 0;
    const isOffline = !onlineLifecycleManager.isOnline();
    const hasKnownGogAchievements = fallbackTotal > 0 || summaryUnlockedCount > 0;
    return {
      storefrontId: 'gog',
      storefrontName: 'GOG GALAXY',
      total: fallbackTotal,
      unlocked: summaryUnlockedCount,
      percentage: fallbackPct,
      isMastered: fallbackTotal > 0 && summaryUnlockedCount >= fallbackTotal,
      achievements: [],
      syncedAt: userGog?.syncedAt,
      source: 'schema_fallback',
      unlockPrecision: summaryUnlockedCount > 0 ? 'summary_count_only' : 'exact',
      supportsAchievements: hasKnownGogAchievements || isOffline,
      schemaUnavailableOffline: hasKnownGogAchievements || isOffline,
    };
  }

  const effectiveSchema = [...schema];
  const totalCount = Math.max(effectiveSchema.length, userGog?.total || 0);

  const achievements: DetailedAchievement[] = effectiveSchema.map((baseAch, index) => ({
    ...baseAch,
    id: `gog:${targetId}:${baseAch.apiName || baseAch.name || index}`,
    unlocked: Boolean(baseAch.unlocked),
    unlockedAt: normalizeUnlockTimestamp(baseAch.unlockedAt),
    storefrontId: 'gog',
  }));

  const exactUnlocked = achievements.filter((a) => a.unlocked).length;
  const hasExactUnlocks = exactUnlocked > 0;
  const effectiveUnlocked = hasExactUnlocks ? exactUnlocked : summaryUnlockedCount;
  const unlockPrecision: 'exact' | 'summary_count_only' =
    effectiveUnlocked > 0 && !hasExactUnlocks ? 'summary_count_only' : 'exact';
  const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;
  const isMastered = totalCount > 0 && effectiveUnlocked >= totalCount;

  return deduplicateDetailedAchievements({
    storefrontId: 'gog',
    storefrontName: 'GOG GALAXY',
    total: totalCount,
    unlocked: effectiveUnlocked,
    percentage,
    isMastered,
    achievements,
    syncedAt: userGog?.syncedAt || new Date().toISOString(),
    source: hasExactUnlocks ? 'live_cloud' : 'schema_fallback',
    unlockPrecision,
    supportsAchievements: true,
    cacheVersion: ACHIEVEMENT_CACHE_VERSION,
  });
}
