import type { CriticScoreData } from '../../../contracts/critic';
import type { UserGameOverride } from '../../../contracts/override';
import { isTitleCompatible } from '../../common/titleMatching';
import {
  MutabilityTier,
  TIER_TTLS,
  clearExpiredStagedCache,
  isCacheEntryValid,
  loadStagedCache,
  saveStagedCache,
} from '../../storage/stagedCacheService';
import {
  getReviewSourceAuthorityRank,
  isSequelMismatch,
  normalizeCriticTitleKey,
} from '../criticUtils';
import { sanitizeMetacriticDescription } from '../metacritic/metacriticYearGuard';
import {
  CRITIC_SCHEMA_V16_KEY,
  LEGACY_STORAGE_PREFIX,
  MAX_NON_CRITIC_TTL_MS,
  type MigrationV8Record,
  NON_CRITIC_FALLBACK_SOURCES,
  PREV_STORAGE_PREFIX,
  SELF_HEAL_FALLBACK_TTL_MS,
  STEAM_APP_ID_TO_TITLE,
  STEAM_ENRICHED_CRITIC_MAP,
  STORAGE_PREFIX,
} from './criticServiceTypes';

export interface CriticMigrationCallbacks {
  validateSemantic: (
    title: string,
    scoreData: CriticScoreData | null | undefined,
    steamAppId?: number | null
  ) => boolean;
  findMatchingOverride: (
    steamAppId?: number | null,
    title?: string
  ) => UserGameOverride | undefined;
  onEvictRawKey: (rawKey: string) => void;
  onPromoteRawKey: (
    rawKey: string,
    data: CriticScoreData,
    gameId: string | undefined,
    steamAppId: number | null,
    effectiveTitle: string
  ) => void;
}

export interface MigrationCatalogMaps {
  catalogTitleByAppId: Map<number, string>;
  catalogAppIdByTitle: Map<string, number>;
  catalogGameIdByAppId: Map<number, string>;
  catalogGameIdByNormTitle: Map<string, string>;
}

export function createEmptyMigrationCatalogMaps(): MigrationCatalogMaps {
  return {
    catalogTitleByAppId: new Map<number, string>(),
    catalogAppIdByTitle: new Map<string, number>(),
    catalogGameIdByAppId: new Map<number, string>(),
    catalogGameIdByNormTitle: new Map<string, string>(),
  };
}

export function populateCatalogMapsForMigration(maps: MigrationCatalogMaps): void {
  try {
    const rawCat = localStorage.getItem('universal_game_library_catalog');
    if (!rawCat) return;
    const parsedCat: unknown = JSON.parse(rawCat);
    if (!Array.isArray(parsedCat)) return;
    for (const item of parsedCat) {
      if (!item || typeof item !== 'object') continue;
      const g = item as { title?: unknown; steamAppId?: unknown; id?: unknown };
      if (typeof g.title !== 'string' || !g.title) continue;
      const normTitle = normalizeCriticTitleKey(g.title);
      const gameId = typeof g.id === 'string' && g.id.trim() ? g.id.trim() : '';
      if (gameId && normTitle) {
        maps.catalogGameIdByNormTitle.set(normTitle, gameId);
      }
      const sid =
        typeof g.steamAppId === 'number' && g.steamAppId > 0
          ? g.steamAppId
          : typeof g.id === 'string' && g.id.startsWith('steam-')
          ? Number(g.id.slice(6))
          : 0;
      if (sid > 0) {
        maps.catalogTitleByAppId.set(sid, g.title);
        maps.catalogAppIdByTitle.set(g.title.toLowerCase().trim(), sid);
        if (normTitle) {
          maps.catalogAppIdByTitle.set(normTitle, sid);
        }
        if (gameId) {
          maps.catalogGameIdByAppId.set(sid, gameId);
        }
      }
    }
  } catch {}
}

export function shouldEvictV8KeyDuringMigration(
  key: string,
  maps: MigrationCatalogMaps,
  siblingGroups: Map<string, MigrationV8Record[]>,
  callbacks: CriticMigrationCallbacks
): boolean {
  const val = localStorage.getItem(key);
  if (!val) return true;
  try {
    const parsed = JSON.parse(val) as Record<string, unknown> & {
      data?: CriticScoreData | null;
      tier?: string;
      summary?: string;
      cachedAt?: number;
      ttlMs?: number;
      ttl?: number;
      dynamicResolved?: boolean;
    };
    const isStaged = Boolean(parsed && typeof parsed === 'object' && 'data' in parsed);
    const data: CriticScoreData | null = isStaged
      ? (parsed.data ?? null)
      : (parsed as unknown as CriticScoreData);
    const tier = isStaged ? parsed.tier : undefined;
    const rawKey = key.slice(STORAGE_PREFIX.length);
    const titleFromKey = rawKey.startsWith('title:') ? rawKey.slice(6).toLowerCase().trim() : '';
    const appId = rawKey.startsWith('id:')
      ? Number(rawKey.slice(3))
      : titleFromKey
      ? maps.catalogAppIdByTitle.get(titleFromKey)
      : undefined;
    const effectiveTitle = rawKey.startsWith('title:')
      ? rawKey.slice(6)
      : appId
      ? STEAM_APP_ID_TO_TITLE.get(appId) || maps.catalogTitleByAppId.get(appId) || ''
      : '';
    const normGroup = effectiveTitle ? normalizeCriticTitleKey(effectiveTitle) : '';

    const recordSibling = (entry: MigrationV8Record) => {
      if (!entry.normGroup) return;
      const list = siblingGroups.get(entry.normGroup);
      if (list) {
        list.push(entry);
      } else {
        siblingGroups.set(entry.normGroup, [entry]);
      }
    };

    if (tier === MutabilityTier.TIER_0_USER_OVERRIDE || tier === 'override') {
      recordSibling({
        key,
        rawKey,
        appId,
        effectiveTitle,
        normGroup,
        data,
        tier: MutabilityTier.TIER_0_USER_OVERRIDE,
        cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : Date.now(),
        ttlMs: Infinity,
        rank: 5,
        isOverride: true,
      });
      return false;
    }
    if (
      isStaged &&
      data === null &&
      (tier === 'negative' || tier === 'transient_error') &&
      isCacheEntryValid(parsed as unknown as Parameters<typeof isCacheEntryValid>[0])
    ) {
      return false;
    }

    if (
      data &&
      typeof data.score === 'number' &&
      data.score > 0 &&
      (data.source === 'metacritic' ||
        data.source === 'opencritic' ||
        data.source === 'metacritic_user' ||
        data.source === 'steam' ||
        data.source === 'gog' ||
        data.source === 'epic' ||
        data.source === 'xbox')
    ) {
      const origSummary = data.summary;
      if (effectiveTitle && !callbacks.validateSemantic(effectiveTitle, data, appId)) {
        return true;
      }
      let mutated = false;
      if (origSummary && (data.source === 'metacritic' || data.source === 'metacritic_user')) {
        const sanitized = sanitizeMetacriticDescription(origSummary, data.numReviews || 20);
        if (sanitized !== origSummary) {
          data.summary = sanitized;
          if (isStaged && 'summary' in parsed) {
            parsed.summary = sanitized;
          }
          mutated = true;
        }
      }

      let effectiveTier: MutabilityTier =
        tier === 'immutable' ||
        tier === 'mature' ||
        tier === 'fresh' ||
        tier === 'early_access' ||
        tier === 'negative' ||
        tier === 'transient_error'
          ? tier
          : MutabilityTier.TIER_2_MATURE;
      const rawTtl =
        typeof parsed.ttlMs === 'number'
          ? parsed.ttlMs
          : typeof parsed.ttl === 'number'
          ? parsed.ttl
          : TIER_TTLS[effectiveTier];
      let effectiveTtlMs = rawTtl;
      const effectiveCachedAt = typeof parsed.cachedAt === 'number' ? parsed.cachedAt : Date.now();

      if (
        isStaged &&
        NON_CRITIC_FALLBACK_SOURCES.has(data.source) &&
        typeof rawTtl === 'number' &&
        rawTtl > MAX_NON_CRITIC_TTL_MS
      ) {
        effectiveTtlMs = SELF_HEAL_FALLBACK_TTL_MS;
        if (effectiveTier === MutabilityTier.TIER_1_IMMUTABLE) {
          effectiveTier = MutabilityTier.TIER_2_MATURE;
        }
        const fullDataForSave = parsed.__vaultFull
          ? (loadStagedCache<CriticScoreData>(key, false).data ?? data)
          : data;
        saveStagedCache<CriticScoreData>(key, fullDataForSave, effectiveTier, {
          source: fullDataForSave.source,
          isVerified: fullDataForSave.isVerified,
          dynamicResolved: parsed.dynamicResolved === true,
          cachedAt: effectiveCachedAt,
          customTtlMs: SELF_HEAL_FALLBACK_TTL_MS,
        });
        mutated = false;
      } else if (mutated) {
        localStorage.setItem(key, JSON.stringify(parsed));
      }

      recordSibling({
        key,
        rawKey,
        appId,
        effectiveTitle,
        normGroup,
        data,
        tier: effectiveTier,
        cachedAt: effectiveCachedAt,
        ttlMs: effectiveTtlMs,
        rank: getReviewSourceAuthorityRank(data),
        isOverride: false,
      });
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

export function promoteShadowedAliasesDuringV16Migration(
  siblingGroups: Map<string, MigrationV8Record[]>,
  maps: MigrationCatalogMaps,
  callbacks: CriticMigrationCallbacks
): number {
  let promotedCount = 0;
  for (const group of siblingGroups.values()) {
    if (group.length < 2) continue;

    let bestDonor: MigrationV8Record | null = null;
    for (const entry of group) {
      if (entry.isOverride || !entry.data) continue;
      const isVerifiedPressCritic =
        entry.data.isVerified === true &&
        (entry.data.source === 'metacritic' || entry.data.source === 'opencritic') &&
        entry.rank >= 3;
      if (!isVerifiedPressCritic) continue;
      if (
        !bestDonor ||
        entry.rank > bestDonor.rank ||
        (entry.rank === bestDonor.rank && entry.cachedAt > bestDonor.cachedAt)
      ) {
        bestDonor = entry;
      }
    }

    if (!bestDonor || !bestDonor.data) continue;

    for (const target of group) {
      if (target.isOverride || target.rank >= bestDonor.rank) continue;
      const targetOverride = callbacks.findMatchingOverride(target.appId, target.effectiveTitle);
      if (
        targetOverride &&
        (targetOverride.reviewScoreOverride !== undefined ||
          targetOverride.reviewRoute !== undefined)
      ) {
        continue;
      }
      if (
        target.effectiveTitle &&
        !callbacks.validateSemantic(target.effectiveTitle, bestDonor.data, target.appId)
      ) {
        continue;
      }

      saveStagedCache<CriticScoreData>(target.key, bestDonor.data, bestDonor.tier, {
        source: bestDonor.data.source,
        isVerified: bestDonor.data.isVerified,
        dynamicResolved: true,
        cachedAt: bestDonor.cachedAt,
        customTtlMs: bestDonor.ttlMs,
      });

      const gameId =
        (target.appId ? maps.catalogGameIdByAppId.get(target.appId) : undefined) ||
        maps.catalogGameIdByNormTitle.get(target.normGroup);
      callbacks.onPromoteRawKey(
        target.rawKey,
        bestDonor.data,
        gameId,
        target.appId ?? null,
        target.effectiveTitle || bestDonor.effectiveTitle
      );
      promotedCount += 1;
    }
  }
  return promotedCount;
}

export function cleanStaleSteamMatcherEntries(): void {
  const rawMatched = localStorage.getItem('antigravity_steam_matched_app_ids');
  if (!rawMatched) return;
  try {
    const parsedMatched = JSON.parse(rawMatched) as Record<string, unknown>;
    if (parsedMatched && typeof parsedMatched === 'object') {
      let changed = false;
      for (const [mk, mv] of Object.entries(parsedMatched)) {
        if (mv === null || typeof mv === 'object') {
          delete parsedMatched[mk];
          changed = true;
        } else if (typeof mv === 'number') {
          const enrichedName = STEAM_ENRICHED_CRITIC_MAP[String(mv)]?.name;
          if (
            enrichedName &&
            (isSequelMismatch(mk, enrichedName) || !isTitleCompatible(mk, enrichedName))
          ) {
            delete parsedMatched[mk];
            changed = true;
          }
        }
      }
      if (changed) {
        localStorage.setItem('antigravity_steam_matched_app_ids', JSON.stringify(parsedMatched));
      }
    }
  } catch {}
}

export function finalizeSchemaV16Migration(
  v8Remove: readonly string[],
  siblingGroups: Map<string, MigrationV8Record[]>,
  maps: MigrationCatalogMaps,
  callbacks: CriticMigrationCallbacks,
  options?: { clearExpiredStaged?: boolean }
): void {
  for (const k of v8Remove) {
    localStorage.removeItem(k);
    if (k.startsWith(STORAGE_PREFIX)) {
      callbacks.onEvictRawKey(k.slice(STORAGE_PREFIX.length));
    }
  }
  const promotedCount = promoteShadowedAliasesDuringV16Migration(siblingGroups, maps, callbacks);
  cleanStaleSteamMatcherEntries();
  if (options?.clearExpiredStaged) {
    clearExpiredStagedCache({ onlyNegativeAndTransient: true });
  }
  localStorage.setItem('antigravity_critic_schema_v9', '1');
  localStorage.setItem('antigravity_critic_schema_v10', '1');
  localStorage.setItem('antigravity_critic_schema_v11', '1');
  localStorage.setItem('antigravity_critic_schema_v12', '1');
  localStorage.setItem('antigravity_critic_schema_v13', '1');
  localStorage.setItem('antigravity_critic_schema_v14', '1');
  localStorage.setItem('antigravity_critic_schema_v15', '1');
  localStorage.setItem(CRITIC_SCHEMA_V16_KEY, '1');

  if (
    promotedCount > 0 &&
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function'
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent('antigravity_critic_updated', {
          detail: { hydratedFromVault: true },
        })
      );
    } catch {}
  }
}

export function isLegacyCriticStorageKey(key: string): boolean {
  return (
    key.startsWith(LEGACY_STORAGE_PREFIX) ||
    key.startsWith(PREV_STORAGE_PREFIX) ||
    key.startsWith('antigravity_critic_v6_') ||
    key.startsWith('antigravity_critic_v5_')
  );
}

export function runSchemaV16MigrationSync(callbacks: CriticMigrationCallbacks): void {
  const v8Keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) {
      v8Keys.push(key);
    }
  }
  const maps = createEmptyMigrationCatalogMaps();
  if (v8Keys.length > 0) {
    populateCatalogMapsForMigration(maps);
  }
  const v16Remove: string[] = [];
  const siblingGroups = new Map<string, MigrationV8Record[]>();
  for (const key of v8Keys) {
    if (shouldEvictV8KeyDuringMigration(key, maps, siblingGroups, callbacks)) {
      v16Remove.push(key);
    }
  }
  finalizeSchemaV16Migration(v16Remove, siblingGroups, maps, callbacks, {
    clearExpiredStaged: false,
  });
}
