import type { CanonicalGame } from '../../../contracts/game';
import type { UserGameOverride } from '../../../contracts/override';
import {
  MutabilityTier,
  evictStagedCache,
} from '../../storage/stagedCacheService';
import {
  normalizeCriticTitleKey,
  stripEditionSuffix,
} from '../criticUtils';
import {
  type CriticEntitlementPlatform,
  STORAGE_PREFIX,
} from './criticServiceTypes';
import { isLegacyCriticStorageKey } from './criticSchemaMigration';

export interface EvictionTargets {
  keysToEvict: Set<string>;
  titlesToEvict: Set<string>;
  steamIdsToEvict: Set<number>;
  xboxIdsToEvict: Set<string>;
  openCriticIdsToEvict: Set<number>;
  gogSlugsToEvict: Set<string>;
}

export function collectGameEvictionTargets(
  gameId?: string | null,
  title?: string | null,
  steamAppId?: number | null,
  extra?: {
    deletedKeys?: string[];
    oldOverride?: Partial<UserGameOverride> | null;
    oldGame?: Partial<CanonicalGame> | null;
    platforms?: CriticEntitlementPlatform[];
  }
): EvictionTargets {
  const keysToEvict = new Set<string>();
  const titlesToEvict = new Set<string>();
  const steamIdsToEvict = new Set<number>();
  const xboxIdsToEvict = new Set<string>();
  const openCriticIdsToEvict = new Set<number>();
  const gogSlugsToEvict = new Set<string>();

  const addTitleKeys = (rawTitle?: string | null) => {
    if (!rawTitle || typeof rawTitle !== 'string') return;
    const trimmed = rawTitle.trim();
    const lower = trimmed.toLowerCase();
    if (!lower) return;
    titlesToEvict.add(trimmed);
    titlesToEvict.add(lower);
    keysToEvict.add(`title:${lower}`);
    const aposStripped = lower.replace(/['’ʼ`]/g, '');
    if (aposStripped && aposStripped !== lower) {
      keysToEvict.add(`title:${aposStripped}`);
    }
    const norm = normalizeCriticTitleKey(trimmed);
    if (norm) {
      titlesToEvict.add(norm);
      keysToEvict.add(`title:${norm}`);
    }
    const stripped = stripEditionSuffix(trimmed);
    if (stripped) {
      keysToEvict.add(`title:${stripped}`);
    }
  };

  const addSteamIdKeys = (rawAppId?: number | null) => {
    if (typeof rawAppId === 'number' && Number.isFinite(rawAppId) && rawAppId > 0) {
      steamIdsToEvict.add(rawAppId);
      keysToEvict.add(`id:${rawAppId}`);
      keysToEvict.add(`steam-${rawAppId}`);
      keysToEvict.add(String(rawAppId));
    }
  };

  const addIdKeys = (rawId?: string | number | null) => {
    if (rawId === undefined || rawId === null) return;
    const str = String(rawId).trim();
    if (!str) return;
    keysToEvict.add(str);
    const cleanId = str.replace(/^steam[-_:]/i, '');
    if (cleanId) {
      keysToEvict.add(`id:${cleanId}`);
      if (/^\d+$/.test(cleanId)) {
        const parsedNum = Number(cleanId);
        if (parsedNum > 0) steamIdsToEvict.add(parsedNum);
      }
    }
    const xboxMatch = str.match(/^xbox[-_:]([a-z0-9]{12})$/i);
    if (xboxMatch?.[1]) {
      xboxIdsToEvict.add(xboxMatch[1]);
    } else if (/^[a-z0-9]{12}$/i.test(str) && !/^\d+$/.test(str)) {
      xboxIdsToEvict.add(str);
    }
    addTitleKeys(str);
  };

  const addPlatforms = (
    plats?: Array<{ platformId?: string; platformGameId?: string; xboxProductId?: string }>
  ) => {
    if (!Array.isArray(plats)) return;
    for (const p of plats) {
      if (!p) continue;
      if (p.platformId === 'steam' && p.platformGameId && /^\d+$/.test(String(p.platformGameId))) {
        addSteamIdKeys(Number(p.platformGameId));
      } else if (p.platformId === 'xbox') {
        const xid = p.xboxProductId || p.platformGameId;
        if (xid) xboxIdsToEvict.add(String(xid));
      } else if (p.platformId === 'gog' && p.platformGameId) {
        gogSlugsToEvict.add(String(p.platformGameId));
      }
      if (p.platformId && p.platformGameId) {
        keysToEvict.add(`${p.platformId}:${p.platformGameId}`);
        keysToEvict.add(`${p.platformId}-${p.platformGameId}`);
      }
    }
  };

  addIdKeys(gameId);
  addTitleKeys(title);
  addSteamIdKeys(steamAppId);
  addPlatforms(extra?.platforms);

  if (Array.isArray(extra?.deletedKeys)) {
    for (const dk of extra.deletedKeys) {
      addIdKeys(dk);
    }
  }

  const oldOverride = extra?.oldOverride;
  if (oldOverride) {
    addIdKeys(oldOverride.gameId);
    addSteamIdKeys(oldOverride.steamAppId);
    if (oldOverride.matchedId !== undefined) {
      addIdKeys(oldOverride.matchedId);
    }
    if (oldOverride.platformId && oldOverride.platformGameId) {
      addPlatforms([{ platformId: oldOverride.platformId, platformGameId: oldOverride.platformGameId }]);
    }
    addSteamIdKeys(oldOverride.nativeBaseline?.steamAppId);
    addIdKeys(oldOverride.nativeBaseline?.id);
    addTitleKeys(oldOverride.title);
    addTitleKeys(oldOverride.originalSourceTitle);
    addTitleKeys(oldOverride.nativeBaseline?.title);
    if (oldOverride.reviewRoute) {
      addTitleKeys(oldOverride.reviewRoute.targetTitle);
      addSteamIdKeys(oldOverride.reviewRoute.steamAppId);
      if (oldOverride.reviewRoute.xboxProductId) {
        xboxIdsToEvict.add(oldOverride.reviewRoute.xboxProductId);
      }
      if (
        typeof oldOverride.reviewRoute.openCriticId === 'number' &&
        oldOverride.reviewRoute.openCriticId > 0
      ) {
        openCriticIdsToEvict.add(oldOverride.reviewRoute.openCriticId);
      }
      if (oldOverride.reviewRoute.gogId) {
        gogSlugsToEvict.add(oldOverride.reviewRoute.gogId);
      }
    }
    if (
      typeof oldOverride.storefrontAnchor?.openCriticId === 'number' &&
      oldOverride.storefrontAnchor.openCriticId > 0
    ) {
      openCriticIdsToEvict.add(oldOverride.storefrontAnchor.openCriticId);
    }
  }

  const oldGame = extra?.oldGame;
  if (oldGame) {
    addIdKeys(oldGame.id);
    addSteamIdKeys(oldGame.steamAppId);
    addTitleKeys(oldGame.title);
    addTitleKeys(oldGame.originalStoreTitle);
    addPlatforms(oldGame.platforms);
  }

  return {
    keysToEvict,
    titlesToEvict,
    steamIdsToEvict,
    xboxIdsToEvict,
    openCriticIdsToEvict,
    gogSlugsToEvict,
  };
}

export function purgeLegacyCriticKeysFromStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isLegacyCriticStorageKey(key)) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {}
}

export function purgeAllCriticKeysFromStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(STORAGE_PREFIX) || isLegacyCriticStorageKey(key))) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {}
}

export function purgeNegativeCriticKeysFromStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const negativeKeysToClear: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { tier?: string; data?: unknown };
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed.tier === MutabilityTier.TIER_4B_NEGATIVE_CACHE ||
            parsed.tier === MutabilityTier.TIER_4C_TRANSIENT_ERROR ||
            parsed.tier === 'negative' ||
            parsed.tier === 'transient_error') &&
          parsed.data === null
        ) {
          negativeKeysToClear.push(key);
        }
      } catch {}
    }
    for (const k of negativeKeysToClear) {
      evictStagedCache(k);
      localStorage.removeItem(k);
    }
  } catch {}
}
