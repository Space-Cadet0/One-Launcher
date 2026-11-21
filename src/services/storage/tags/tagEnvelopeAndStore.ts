import type { UserTagOverride, UserTagOverridesMap } from '../../../contracts/tags';
import {
  createCachedLocalStorageSlot,
  normalizeSafeIdKey,
  parseIsoTimestampMs,
} from '../storageRuntimeUtils';
import { sanitizeUserTagOverride } from './tagSanitizerAndAliases';

export const STORAGE_KEY_USER_TAG_OVERRIDES = 'universal_game_library_user_tag_overrides_v1';
export const USER_TAG_OVERRIDES_UPDATED_EVENT = 'antigravity:user-tag-overrides-updated';

interface DeduplicatedUserTagOverridesEnvelopeV2 {
  __v: 2;
  records: Record<string, UserTagOverride>;
  aliases: Record<string, string>;
}

export function serializeUserTagOverridesEnvelopeV2(map: UserTagOverridesMap): string {
  const records: Record<string, UserTagOverride> = {};
  const aliases: Record<string, string> = {};
  const objectToCanonicalKey = new Map<UserTagOverride, string>();

  // Pass 1: register canonical records keyed by their own `gameId`
  for (const [key, rec] of Object.entries(map)) {
    const safeKey = normalizeSafeIdKey(key);
    if (!safeKey || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (rec.gameId && safeKey === rec.gameId) {
      if (rec.addedTags.length === 0 && rec.removedTags.length === 0) continue;
      records[safeKey] = rec;
      objectToCanonicalKey.set(rec, safeKey);
    }
  }

  // Pass 2: register any standalone records & alias pointers
  for (const [key, rec] of Object.entries(map)) {
    const safeKey = normalizeSafeIdKey(key);
    if (!safeKey || !rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (Object.hasOwn(records, safeKey)) continue;
    if (rec.addedTags.length === 0 && rec.removedTags.length === 0) continue;

    const existingObjKey = objectToCanonicalKey.get(rec);
    if (existingObjKey) {
      aliases[safeKey] = existingObjKey;
      continue;
    }

    if (rec.gameId && Object.hasOwn(records, rec.gameId)) {
      aliases[safeKey] = rec.gameId;
      continue;
    }

    records[safeKey] = rec;
    objectToCanonicalKey.set(rec, safeKey);
  }

  // Pass 3: ensure every canonical record's `platformAliases` has a deduplicated pointer
  // (newest canonical record wins if two split records temporarily share an old alias;
  // exact `game.id` lookup still always beats alias fallback!)
  const canonicalSorted = Object.entries(records).toSorted(
    ([, a], [, b]) => parseIsoTimestampMs(a.updatedAt) - parseIsoTimestampMs(b.updatedAt)
  );
  for (const [canonicalKey, rec] of canonicalSorted) {
    if (!Array.isArray(rec.platformAliases)) continue;
    for (const alias of rec.platformAliases) {
      const safeAlias = normalizeSafeIdKey(alias);
      if (!safeAlias || Object.hasOwn(records, safeAlias)) continue;
      aliases[safeAlias] = canonicalKey;
    }
  }

  const envelope: DeduplicatedUserTagOverridesEnvelopeV2 = {
    __v: 2,
    records,
    aliases,
  };
  return JSON.stringify(envelope);
}

export function isDeduplicatedUserTagOverridesEnvelopeV2(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const rawObj = parsed as Record<string, unknown>;
  if (
    rawObj.__v !== 2 ||
    !rawObj.records ||
    typeof rawObj.records !== 'object' ||
    Array.isArray(rawObj.records)
  ) {
    return false;
  }
  for (const k of Object.keys(rawObj)) {
    if (k !== '__v' && k !== 'records' && k !== 'aliases') {
      return false;
    }
  }
  return true;
}

export function deserializeUserTagOverridesPayload(parsed: unknown): UserTagOverridesMap {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const rawObj = parsed as Record<string, unknown>;
  if (
    rawObj.__v === 2 &&
    rawObj.records &&
    typeof rawObj.records === 'object' &&
    !Array.isArray(rawObj.records)
  ) {
    const records = rawObj.records as Record<string, unknown>;
    const aliases =
      rawObj.aliases && typeof rawObj.aliases === 'object' && !Array.isArray(rawObj.aliases)
        ? (rawObj.aliases as Record<string, unknown>)
        : {};
    const projected: UserTagOverridesMap = {};

    for (const [k, rec] of Object.entries(records)) {
      const safeKey = normalizeSafeIdKey(k);
      if (!safeKey) continue;
      const clean = sanitizeUserTagOverride(safeKey, rec);
      if (!clean || (clean.addedTags.length === 0 && clean.removedTags.length === 0)) continue;
      projected[safeKey] = clean;
    }

    for (const [aliasKey, targetKey] of Object.entries(aliases)) {
      const safeAlias = normalizeSafeIdKey(aliasKey);
      const safeTarget = normalizeSafeIdKey(targetKey);
      if (
        safeAlias &&
        safeTarget &&
        Object.hasOwn(projected, safeTarget) &&
        !Object.hasOwn(projected, safeAlias)
      ) {
        projected[safeAlias] = projected[safeTarget];
      }
    }

    return projected;
  }

  // Flat legacy map fallback
  const flatMap: UserTagOverridesMap = {};
  for (const [k, val] of Object.entries(rawObj)) {
    const safeKey = normalizeSafeIdKey(k);
    if (!safeKey) continue;
    const clean = sanitizeUserTagOverride(safeKey, val);
    if (!clean || (clean.addedTags.length === 0 && clean.removedTags.length === 0)) continue;
    flatMap[safeKey] = clean;
  }
  return flatMap;
}

export function dispatchUserTagOverridesUpdatedEvent(detail: {
  gameId?: string;
  hydratedFromVault?: boolean;
  fromStorageEvent?: boolean;
}): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(USER_TAG_OVERRIDES_UPDATED_EVENT, { detail }));
    } catch {
      // Ignore event dispatch errors in minimal test environments
    }
  }
}

const tagOverridesSlot = createCachedLocalStorageSlot<UserTagOverridesMap>({
  storageKey: STORAGE_KEY_USER_TAG_OVERRIDES,
  createEmpty: () => ({}),
  deserialize: (raw) => {
    const parsed: unknown = JSON.parse(raw);
    const map = deserializeUserTagOverridesPayload(parsed);
    const needsV2Upgrade = !isDeduplicatedUserTagOverridesEnvelopeV2(parsed);
    return {
      value: map,
      ...(needsV2Upgrade && Object.keys(map).length > 0
        ? { upgradedRaw: serializeUserTagOverridesEnvelopeV2(map) }
        : {}),
    };
  },
  serialize: (map) => serializeUserTagOverridesEnvelopeV2(map),
  onExternalInvalidate: () => {
    dispatchUserTagOverridesUpdatedEvent({ fromStorageEvent: true });
  },
});

export function getUserTagOverridesRevision(): number {
  return tagOverridesSlot.getRevision();
}

export function loadUserTagOverridesFromStore(): UserTagOverridesMap {
  return tagOverridesSlot.load();
}

export function persistUserTagOverridesMapToStorage(current: UserTagOverridesMap): void {
  tagOverridesSlot.persist(current);
}
