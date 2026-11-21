import type { UserTagOverride, UserTagOverridesMap } from '../../../contracts/tags';
import { parseIsoTimestampMs } from '../storageRuntimeUtils';
import { loadUserTagOverridesFromStore } from './tagEnvelopeAndStore';
import {
  expandAliasLookupVariants,
  extractGameTagPlatformAliases,
  MAX_USER_TAG_PLATFORM_ALIASES,
  MAX_USER_TAGS_PER_ARRAY,
  normalizeTagKey,
  type TagOverrideGameIdentity,
} from './tagSanitizerAndAliases';

interface TagOverrideLookupIndex {
  isEmpty: boolean;
  byGameId: Map<string, UserTagOverride>;
  byAlias: Map<string, UserTagOverride[]>;
}

const tagLookupIndexCache = new WeakMap<UserTagOverridesMap, TagOverrideLookupIndex>();

function getTagOverrideLookupIndex(map: UserTagOverridesMap): TagOverrideLookupIndex {
  const cached = tagLookupIndexCache.get(map);
  if (cached) return cached;

  const byGameId = new Map<string, UserTagOverride>();
  const byAlias = new Map<string, UserTagOverride[]>();
  const seenRecords = new Set<UserTagOverride>();
  let hasAny = false;

  const pushAlias = (aliasKey: string, rec: UserTagOverride) => {
    if (!aliasKey) return;
    let bucket = byAlias.get(aliasKey);
    if (!bucket) {
      bucket = [rec];
      byAlias.set(aliasKey, bucket);
    } else if (!bucket.includes(rec)) {
      bucket.push(rec);
    }
  };

  for (const key of Object.keys(map)) {
    const rec = map[key];
    if (!rec || typeof rec !== 'object') continue;
    hasAny = true;

    if (rec.gameId) {
      const prev = byGameId.get(rec.gameId);
      if (!prev || parseIsoTimestampMs(rec.updatedAt) >= parseIsoTimestampMs(prev.updatedAt)) {
        byGameId.set(rec.gameId, rec);
      }
    }

    if (seenRecords.has(rec)) {
      if (key !== rec.gameId) {
        pushAlias(key, rec);
        pushAlias(key.toLowerCase(), rec);
      }
      continue;
    }
    seenRecords.add(rec);

    if (key !== rec.gameId) {
      pushAlias(key, rec);
      pushAlias(key.toLowerCase(), rec);
    }
    if (Array.isArray(rec.platformAliases)) {
      for (const alias of rec.platformAliases) {
        for (const variant of expandAliasLookupVariants(alias)) {
          pushAlias(variant, rec);
        }
      }
    }
    if (rec.gameId) {
      for (const variant of expandAliasLookupVariants(rec.gameId)) {
        pushAlias(variant, rec);
      }
    }
  }

  const built: TagOverrideLookupIndex = {
    isEmpty: !hasAny,
    byGameId,
    byAlias,
  };
  tagLookupIndexCache.set(map, built);
  return built;
}

/**
 * Merges multiple alias-matched tag overrides (e.g., when two separately edited storefront
 * entries later merge into one multi-store CanonicalGame) using newest `updatedAt` precedence
 * per normalized tag key.
 */
function mergeAliasTagOverrides(
  fallbackGameId: string,
  candidates: readonly UserTagOverride[]
): UserTagOverride {
  const sortedNewestFirst = candidates.toSorted(
    (a, b) => parseIsoTimestampMs(b.updatedAt) - parseIsoTimestampMs(a.updatedAt)
  );
  const addedTags: string[] = [];
  const removedTags: string[] = [];
  const decidedKeys = new Set<string>();
  const aliases = new Set<string>();

  for (const rec of sortedNewestFirst) {
    if (Array.isArray(rec.platformAliases)) {
      for (const alias of rec.platformAliases) {
        if (aliases.size < MAX_USER_TAG_PLATFORM_ALIASES) {
          aliases.add(alias);
        }
      }
    }
    for (const tag of rec.addedTags) {
      const key = normalizeTagKey(tag);
      if (!key || decidedKeys.has(key)) continue;
      decidedKeys.add(key);
      if (addedTags.length < MAX_USER_TAGS_PER_ARRAY) {
        addedTags.push(tag);
      }
    }
    for (const tag of rec.removedTags) {
      const key = normalizeTagKey(tag);
      if (!key || decidedKeys.has(key)) continue;
      decidedKeys.add(key);
      if (removedTags.length < MAX_USER_TAGS_PER_ARRAY) {
        removedTags.push(tag);
      }
    }
  }

  return {
    gameId: fallbackGameId || sortedNewestFirst[0].gameId,
    ...(aliases.size > 0 ? { platformAliases: Array.from(aliases) } : {}),
    addedTags,
    removedTags,
    updatedAt: sortedNewestFirst[0].updatedAt,
  };
}

/**
 * Retrieves the effective `UserTagOverride` for a game.
 *
 * `C10` Split-Game Alias Safety:
 * 1. Exact `game.id` match is ALWAYS checked FIRST before any `platformAliases` fallback,
 *    ensuring split multi-store games maintain strictly isolated tag deltas.
 * 2. Only when no exact `game.id` record exists does lookup fall back to `platformAliases`
 *    currently present on `game` so newly merged multi-store games preserve prior tag edits.
 */
export function getUserTagOverrideForGame(
  game: TagOverrideGameIdentity | null | undefined,
  overridesMap?: UserTagOverridesMap
): UserTagOverride | undefined {
  if (!game) return undefined;
  const map = overridesMap ?? loadUserTagOverridesFromStore();
  if (!map) return undefined;

  const idx = getTagOverrideLookupIndex(map);
  if (idx.isEmpty) return undefined;

  const exactId = typeof game.id === 'string' ? game.id.trim() : '';

  // 1. Exact `game.id` match FIRST (never shadowed by platformAliases!)
  if (exactId) {
    const direct = Object.hasOwn(map, exactId) ? map[exactId] : undefined;
    if (direct && (!direct.gameId || direct.gameId === exactId)) {
      return direct;
    }
    const indexedById = idx.byGameId.get(exactId);
    if (indexedById) {
      return indexedById;
    }
  }

  // 2. Fallback to `platformAliases` currently present on `game`
  const aliases = extractGameTagPlatformAliases(game);
  if (aliases.length === 0) return undefined;

  const matched: UserTagOverride[] = [];
  const seenGameIds = new Set<string>();
  const addCandidate = (rec?: UserTagOverride) => {
    if (!rec) return;
    if (matched.includes(rec)) return;
    if (rec.gameId && seenGameIds.has(rec.gameId)) return;
    if (rec.gameId) seenGameIds.add(rec.gameId);
    matched.push(rec);
  };

  for (const alias of aliases) {
    for (const variant of expandAliasLookupVariants(alias)) {
      const directAlias = Object.hasOwn(map, variant) ? map[variant] : undefined;
      if (directAlias) addCandidate(directAlias);
      const bucket = idx.byAlias.get(variant);
      if (bucket) {
        for (const rec of bucket) {
          addCandidate(rec);
        }
      }
    }
  }

  if (matched.length === 0) return undefined;
  if (matched.length === 1) return matched[0];
  return mergeAliasTagOverrides(exactId, matched);
}
