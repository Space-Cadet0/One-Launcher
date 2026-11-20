import type {
  UserTagOverride,
  UserTagOverridesMap,
} from '../../contracts/tags';

export const STORAGE_KEY_USER_TAG_OVERRIDES = 'universal_game_library_user_tag_overrides_v1';
export const USER_TAG_OVERRIDES_UPDATED_EVENT = 'antigravity:user-tag-overrides-updated';

export const MAX_USER_TAG_LENGTH = 64;
export const MAX_USER_TAGS_PER_ARRAY = 100;
export const MAX_USER_TAG_PLATFORM_ALIASES = 50;

export interface TagOverrideGameIdentity {
  id?: string | null;
  steamAppId?: number | string | null;
  isExplicitNonSteam?: boolean;
  platforms?: Array<{
    platformId?: string | null;
    platformGameId?: string | number | null;
  }>;
}

interface DeduplicatedUserTagOverridesEnvelopeV2 {
  __v: 2;
  records: Record<string, UserTagOverride>;
  aliases: Record<string, string>;
}

interface TagOverrideLookupIndex {
  isEmpty: boolean;
  byGameId: Map<string, UserTagOverride>;
  byAlias: Map<string, UserTagOverride[]>;
}

const REBRAND_EQUIVALENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  achievements: ['achievements', 'steam achievements'],
  'steam achievements': ['steam achievements', 'achievements'],
  'cloud saves': ['cloud saves', 'steam cloud'],
  'steam cloud': ['steam cloud', 'cloud saves'],
  leaderboards: ['leaderboards', 'steam leaderboards'],
  'steam leaderboards': ['steam leaderboards', 'leaderboards'],
};

function isTestEnv(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean(process.env?.VITEST || process.env?.NODE_ENV === 'test')
    );
  } catch {
    return false;
  }
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

/**
 * Validates a canonical gameId or platform alias key against prototype-pollution
 * and control-character hazards.
 */
function normalizeSafeIdKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.replace(/[\x00-\x1f\x7f]+/g, '').trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed === '__proto__' ||
    trimmed === 'constructor' ||
    trimmed === 'prototype'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Strips ASCII control characters, collapses internal whitespace, trims, and clamps a tag label to 64 chars.
 */
export function sanitizeTagLabel(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_USER_TAG_LENGTH)
    .trim();
}

/**
 * Canonical case-insensitive tag lookup key.
 */
export function normalizeTagKey(raw: string): string {
  return sanitizeTagLabel(raw).toLowerCase();
}

function sanitizeTagArray(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (out.length >= MAX_USER_TAGS_PER_ARRAY) break;
    if (typeof item !== 'string') continue;
    const clean = sanitizeTagLabel(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function sanitizePlatformAliasArray(rawAliases: unknown): string[] {
  if (!Array.isArray(rawAliases)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rawAliases) {
    if (out.length >= MAX_USER_TAG_PLATFORM_ALIASES) break;
    if (typeof item !== 'string') continue;
    const safe = normalizeSafeIdKey(item);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  return out;
}

function parseTimestampMs(updatedAt?: string | null): number {
  if (!updatedAt) return 0;
  const ts = Date.parse(updatedAt);
  return Number.isFinite(ts) ? ts : 0;
}

function sanitizeUserTagOverride(
  fallbackKey: string,
  raw: unknown
): UserTagOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Partial<UserTagOverride>;
  const gameId = normalizeSafeIdKey(obj.gameId || fallbackKey);
  if (!gameId) return null;

  const addedTags = sanitizeTagArray(obj.addedTags);
  const addedKeys = new Set(addedTags.map((t) => t.toLowerCase()));
  const removedTags = sanitizeTagArray(obj.removedTags).filter(
    (t) => !addedKeys.has(t.toLowerCase())
  );
  const platformAliases = sanitizePlatformAliasArray(obj.platformAliases);
  const rawUpdated = typeof obj.updatedAt === 'string' ? obj.updatedAt.trim() : '';
  const updatedAt = Number.isFinite(Date.parse(rawUpdated))
    ? rawUpdated
    : new Date(0).toISOString();

  return {
    gameId,
    ...(platformAliases.length > 0 ? { platformAliases } : {}),
    addedTags,
    removedTags,
    updatedAt,
  };
}

function normalizePositiveSteamAppId(raw: number | string | null | undefined): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/**
 * Extracts ONLY the platform aliases currently present on `game` (`C10` split-game safety):
 * `${platformId}:${platformGameId}` for each owned entitlement plus `steam:${appId}` when
 * owned on Steam or when the game identity has no explicit non-Steam platform list.
 */
export function extractGameTagPlatformAliases(
  game: TagOverrideGameIdentity | null | undefined
): string[] {
  if (!game) return [];
  const aliases: string[] = [];
  const seen = new Set<string>();
  const pushAlias = (rawAlias: string) => {
    if (aliases.length >= MAX_USER_TAG_PLATFORM_ALIASES) return;
    const safe = normalizeSafeIdKey(rawAlias);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    aliases.push(safe);
  };

  const platforms = Array.isArray(game.platforms) ? game.platforms : [];
  let hasSteamPlatform = false;

  for (const plat of platforms) {
    if (!plat || !plat.platformId || plat.platformGameId === undefined || plat.platformGameId === null) {
      continue;
    }
    const pId = String(plat.platformId).trim().toLowerCase();
    let pGid = String(plat.platformGameId).trim();
    if (!pId || !pGid) continue;
    if (pId === 'xbox' && /^[A-Z0-9]{12}$/i.test(pGid)) {
      pGid = pGid.toUpperCase();
    }
    if (pId === 'steam') {
      hasSteamPlatform = true;
    }
    pushAlias(`${pId}:${pGid}`);
  }

  const steamAppId = normalizePositiveSteamAppId(game.steamAppId);
  const gameIdStr = typeof game.id === 'string' ? game.id.trim() : '';
  const isSteamKeyedId = /^steam[:_-]\d+$/i.test(gameIdStr);
  if (
    steamAppId &&
    !game.isExplicitNonSteam &&
    (platforms.length === 0 || hasSteamPlatform || isSteamKeyedId)
  ) {
    pushAlias(`steam:${steamAppId}`);
  }

  return aliases;
}

function expandAliasLookupVariants(alias: string): string[] {
  const variants = [alias];
  const lower = alias.toLowerCase();
  if (lower !== alias) {
    variants.push(lower);
  }
  const match = alias.match(/^([a-z0-9_]+):(.+)$/i);
  if (match) {
    const store = match[1].toLowerCase();
    const rest = match[2].trim();
    if (rest) {
      variants.push(`${store}-${rest}`);
      const lowerRest = rest.toLowerCase();
      if (lowerRest !== rest) {
        variants.push(`${store}-${lowerRest}`);
        variants.push(`${store}:${lowerRest}`);
      }
      if (store === 'xbox' && /^[A-Z0-9]{12}$/i.test(rest)) {
        const up = rest.toUpperCase();
        variants.push(`xbox:${up}`);
        variants.push(`xbox-${up}`);
      }
    }
  }
  return variants;
}

function serializeUserTagOverridesEnvelopeV2(map: UserTagOverridesMap): string {
  const records: Record<string, UserTagOverride> = {};
  const aliases: Record<string, string> = {};
  const objectToCanonicalKey = new Map<UserTagOverride, string>();

  // Pass 1: register canonical records keyed by their own `gameId`
  for (const [key, rec] of Object.entries(map)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (rec.gameId && key === rec.gameId) {
      if (rec.addedTags.length === 0 && rec.removedTags.length === 0) continue;
      records[key] = rec;
      objectToCanonicalKey.set(rec, key);
    }
  }

  // Pass 2: register any standalone records & alias pointers
  for (const [key, rec] of Object.entries(map)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (Object.prototype.hasOwnProperty.call(records, key)) continue;
    if (rec.addedTags.length === 0 && rec.removedTags.length === 0) continue;

    const existingObjKey = objectToCanonicalKey.get(rec);
    if (existingObjKey) {
      aliases[key] = existingObjKey;
      continue;
    }

    if (rec.gameId && Object.prototype.hasOwnProperty.call(records, rec.gameId)) {
      aliases[key] = rec.gameId;
      continue;
    }

    records[key] = rec;
    objectToCanonicalKey.set(rec, key);
  }

  // Pass 3: ensure every canonical record's `platformAliases` has a deduplicated pointer
  // (newest canonical record wins if two split records temporarily share an old alias;
  // exact `game.id` lookup still always beats alias fallback!)
  const canonicalSorted = Object.entries(records).sort(
    ([, a], [, b]) => parseTimestampMs(a.updatedAt) - parseTimestampMs(b.updatedAt)
  );
  for (const [canonicalKey, rec] of canonicalSorted) {
    if (!Array.isArray(rec.platformAliases)) continue;
    for (const alias of rec.platformAliases) {
      if (!alias || Object.prototype.hasOwnProperty.call(records, alias)) continue;
      aliases[alias] = canonicalKey;
    }
  }

  const envelope: DeduplicatedUserTagOverridesEnvelopeV2 = {
    __v: 2,
    records,
    aliases,
  };
  return JSON.stringify(envelope);
}

function isDeduplicatedUserTagOverridesEnvelopeV2(parsed: unknown): boolean {
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

function deserializeUserTagOverridesPayload(parsed: unknown): UserTagOverridesMap {
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
      if (
        safeAlias &&
        typeof targetKey === 'string' &&
        Object.prototype.hasOwnProperty.call(projected, targetKey) &&
        !Object.prototype.hasOwnProperty.call(projected, safeAlias)
      ) {
        projected[safeAlias] = projected[targetKey];
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

let userTagOverridesRevision = 0;

/**
 * Monotonic revision counter incremented whenever user tag overrides mutate in memory,
 * hydrate from the Electron vault, or update via cross-window `StorageEvent`.
 */
export function getUserTagOverridesRevision(): number {
  return userTagOverridesRevision;
}

function bumpUserTagOverridesRevision(): void {
  userTagOverridesRevision += 1;
}

let cachedTagOverridesRaw: string | null = null;
let cachedTagOverridesMap: UserTagOverridesMap = {};
let cachedTagStorageRef: Storage | null = null;
let inMemoryTagOverridesHydrated = false;
let attachedTagStorageWindowRef: Window | null = null;

function dispatchUserTagOverridesUpdatedEvent(
  detail: { gameId?: string; hydratedFromVault?: boolean; fromStorageEvent?: boolean }
): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent(USER_TAG_OVERRIDES_UPDATED_EVENT, { detail })
      );
    } catch {
      // Ignore event dispatch errors in minimal test environments
    }
  }
}

function ensureTagOverrideStorageListener(): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  if (attachedTagStorageWindowRef === window) return;
  attachedTagStorageWindowRef = window;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY_USER_TAG_OVERRIDES) {
      inMemoryTagOverridesHydrated = false;
      cachedTagOverridesRaw = null;
      bumpUserTagOverridesRevision();
      dispatchUserTagOverridesUpdatedEvent({ fromStorageEvent: true });
    }
  });
}

/**
 * Loads all user tag overrides from `localStorage` (with in-memory caching).
 * Safe to call once before iterating an entire catalog (`buildLibraryFilterIndex`) so per-game lookups stay O(1).
 */
export function loadUserTagOverrides(): UserTagOverridesMap {
  const storage = getStorage();
  if (!storage) return {};
  ensureTagOverrideStorageListener();

  if (!isTestEnv() && inMemoryTagOverridesHydrated && storage === cachedTagStorageRef) {
    return cachedTagOverridesMap;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY_USER_TAG_OVERRIDES);
    if (!raw) {
      if (inMemoryTagOverridesHydrated && cachedTagOverridesRaw !== null) {
        bumpUserTagOverridesRevision();
      }
      cachedTagStorageRef = storage;
      cachedTagOverridesRaw = null;
      cachedTagOverridesMap = {};
      inMemoryTagOverridesHydrated = true;
      return {};
    }

    if (
      inMemoryTagOverridesHydrated &&
      storage === cachedTagStorageRef &&
      raw === cachedTagOverridesRaw
    ) {
      cachedTagOverridesRaw = raw;
      return cachedTagOverridesMap;
    }

    const parsed: unknown = JSON.parse(raw);
    const map = deserializeUserTagOverridesPayload(parsed);
    const needsV2Upgrade = !isDeduplicatedUserTagOverridesEnvelopeV2(parsed);

    cachedTagStorageRef = storage;
    cachedTagOverridesRaw = raw;
    cachedTagOverridesMap = map;
    inMemoryTagOverridesHydrated = true;

    if (needsV2Upgrade && Object.keys(map).length > 0) {
      try {
        const serializedV2 = serializeUserTagOverridesEnvelopeV2(map);
        storage.setItem(STORAGE_KEY_USER_TAG_OVERRIDES, serializedV2);
        cachedTagOverridesRaw = isTestEnv() ? serializedV2 : null;
      } catch {
        // Keep deserialized map if storage quota refuses rewrite
      }
    }

    return map;
  } catch (err) {
    console.warn('Failed to load user tag overrides from localStorage:', err);
    return {};
  }
}

function persistUserTagOverridesMapToStorage(current: UserTagOverridesMap): void {
  const storage = getStorage();
  ensureTagOverrideStorageListener();
  cachedTagOverridesMap = current;
  inMemoryTagOverridesHydrated = true;
  if (storage) {
    const serialized = serializeUserTagOverridesEnvelopeV2(current);
    storage.setItem(STORAGE_KEY_USER_TAG_OVERRIDES, serialized);
    cachedTagStorageRef = storage;
    cachedTagOverridesRaw = isTestEnv() ? serialized : null;
  }
  bumpUserTagOverridesRevision();
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

  for (const key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    const rec = map[key];
    if (!rec || typeof rec !== 'object') continue;
    hasAny = true;

    if (rec.gameId) {
      const prev = byGameId.get(rec.gameId);
      if (!prev || parseTimestampMs(rec.updatedAt) >= parseTimestampMs(prev.updatedAt)) {
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
  candidates: UserTagOverride[]
): UserTagOverride {
  const sortedNewestFirst = [...candidates].sort(
    (a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt)
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
  const map = overridesMap ?? loadUserTagOverrides();
  if (!map) return undefined;

  const idx = getTagOverrideLookupIndex(map);
  if (idx.isEmpty) return undefined;

  const exactId = typeof game.id === 'string' ? game.id.trim() : '';

  // 1. Exact `game.id` match FIRST (never shadowed by platformAliases!)
  if (exactId) {
    const direct = map[exactId];
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
      const directAlias = map[variant];
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

/**
 * Persists a canonical `UserTagOverride` keyed strictly under `override.gameId` with ONLY
 * `override.platformAliases`, never mutating sibling split-game records or `user_overrides.json`.
 */
export function saveUserTagOverride(
  override: UserTagOverride,
  options?: { silentEvent?: boolean }
): UserTagOverride | null {
  if (!override || !override.gameId) return null;
  const sanitized = sanitizeUserTagOverride(override.gameId, {
    ...override,
    updatedAt: override.updatedAt || new Date().toISOString(),
  });
  if (!sanitized) return null;

  if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) {
    removeUserTagOverride(sanitized.gameId, { silentEvent: options?.silentEvent });
    return null;
  }

  try {
    const current: UserTagOverridesMap = { ...loadUserTagOverrides() };

    // Rebind stale alias pointers belonging strictly to THIS `gameId` (never touching sibling games!)
    for (const [k, existingRec] of Object.entries(current)) {
      if (k !== sanitized.gameId && existingRec && existingRec.gameId === sanitized.gameId) {
        delete current[k];
      }
    }

    current[sanitized.gameId] = sanitized;
    if (Array.isArray(sanitized.platformAliases)) {
      for (const alias of sanitized.platformAliases) {
        const existingAtAlias = current[alias];
        // Never overwrite another game's canonical record if `alias` collides with a `gameId`
        if (!existingAtAlias || existingAtAlias.gameId !== alias) {
          current[alias] = sanitized;
        }
      }
    }

    persistUserTagOverridesMapToStorage(current);

    if (!options?.silentEvent) {
      dispatchUserTagOverridesUpdatedEvent({ gameId: sanitized.gameId });
    }

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.saveUserTagOverride === 'function'
    ) {
      try {
        void window.electronAPI.offlineVault
          .saveUserTagOverride(sanitized.gameId, sanitized)
          ?.catch?.(() => {});
      } catch (vaultErr) {
        console.warn('Failed to sync user tag override to offlineVault:', vaultErr);
      }
    }

    return sanitized;
  } catch (err) {
    console.error('Failed to save user tag override:', err);
    return null;
  }
}

/**
 * Removes a `UserTagOverride` by canonical `gameId` (and any explicitly supplied `aliasKeys`),
 * leaving sibling games' canonical records strictly untouched.
 */
export function removeUserTagOverride(
  gameId: string,
  options?: { aliasKeys?: string[]; silentEvent?: boolean }
): boolean {
  const safeId = normalizeSafeIdKey(gameId);
  if (!safeId) return false;

  try {
    const current: UserTagOverridesMap = { ...loadUserTagOverrides() };
    const extraDeleteSet = new Set<string>();
    if (Array.isArray(options?.aliasKeys)) {
      for (const k of options.aliasKeys) {
        const safe = normalizeSafeIdKey(k);
        if (safe && safe !== safeId) {
          extraDeleteSet.add(safe);
        }
      }
    }

    let removedAny = false;
    for (const [k, rec] of Object.entries(current)) {
      if (
        k === safeId ||
        (rec && rec.gameId === safeId) ||
        extraDeleteSet.has(k) ||
        (rec && rec.gameId && extraDeleteSet.has(rec.gameId))
      ) {
        delete current[k];
        removedAny = true;
      }
    }

    if (removedAny) {
      persistUserTagOverridesMapToStorage(current);
      if (!options?.silentEvent) {
        dispatchUserTagOverridesUpdatedEvent({ gameId: safeId });
      }
    }

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.offlineVault?.removeUserTagOverride === 'function'
    ) {
      try {
        void window.electronAPI.offlineVault
          .removeUserTagOverride({
            gameId: safeId,
            ...(extraDeleteSet.size > 0 ? { aliasKeys: Array.from(extraDeleteSet) } : {}),
          })
          ?.catch?.(() => {});
      } catch (vaultErr) {
        console.warn('Failed to remove user tag override in offlineVault:', vaultErr);
      }
    }

    return removedAny;
  } catch (err) {
    console.error('Failed to remove user tag override:', err);
    return false;
  }
}

function getEquivalentTagKeys(key: string): readonly string[] {
  return REBRAND_EQUIVALENT_KEYS[key] ?? [key];
}

function nextMonotonicTimestamp(prevUpdatedAt?: string): string {
  const prevTs = parseTimestampMs(prevUpdatedAt);
  const nowTs = Date.now();
  return new Date(nowTs > prevTs ? nowTs : prevTs + 1).toISOString();
}

/**
 * Adds a user tag (or restores a previously removed synced tag) for `game`.
 * On write, keys strictly under `game.id` and records ONLY `platformAliases` currently present on `game`.
 */
export function addUserTagForGame(
  game: TagOverrideGameIdentity,
  rawTag: string,
  currentSyncedTags?: readonly string[]
): UserTagOverride | null {
  const gameId = normalizeSafeIdKey(game?.id);
  const label = sanitizeTagLabel(rawTag);
  const key = label.toLowerCase();
  if (!gameId || !label || !key) {
    return getUserTagOverrideForGame(game) ?? null;
  }

  const existing = getUserTagOverrideForGame(game);
  const equivKeys = new Set(getEquivalentTagKeys(key));

  const nextAdded = existing ? [...existing.addedTags] : [];
  const nextRemoved = existing
    ? existing.removedTags.filter((t) => !equivKeys.has(normalizeTagKey(t)))
    : [];

  const wasRemoved = existing
    ? existing.removedTags.some((t) => equivKeys.has(normalizeTagKey(t)))
    : false;

  const existingAddedIdx = nextAdded.findIndex((t) => normalizeTagKey(t) === key);
  const matchingSyncedTag = Array.isArray(currentSyncedTags)
    ? currentSyncedTags.find((t) => equivKeys.has(normalizeTagKey(t)))
    : undefined;

  if (existingAddedIdx >= 0) {
    // Update user display casing in place
    nextAdded[existingAddedIdx] = label;
  } else if (wasRemoved && matchingSyncedTag && matchingSyncedTag === label) {
    // Simply un-hiding a previously removed synced tag with identical casing restores it cleanly
  } else if (!wasRemoved && matchingSyncedTag && matchingSyncedTag === label) {
    // Tag is already active on the game with identical casing — no redundant user delta needed
    if (!existing || existing.gameId === gameId) {
      return existing ?? null;
    }
  } else if (nextAdded.length < MAX_USER_TAGS_PER_ARRAY) {
    nextAdded.push(label);
  }

  if (nextAdded.length === 0 && nextRemoved.length === 0) {
    removeUserTagOverride(gameId);
    return null;
  }

  const record: UserTagOverride = {
    gameId,
    platformAliases: extractGameTagPlatformAliases(game),
    addedTags: nextAdded,
    removedTags: nextRemoved,
    updatedAt: nextMonotonicTimestamp(existing?.updatedAt),
  };
  return saveUserTagOverride(record);
}

/**
 * Removes a tag from `game`: deletes it from `addedTags`, and if present in `currentSyncedTags`
 * (or when `currentSyncedTags` is omitted and the tag wasn't user-added), records it in `removedTags`
 * so future storefront syncs cannot resurrect it. Automatically deletes empty delta records.
 */
export function removeUserTagForGame(
  game: TagOverrideGameIdentity,
  rawTag: string,
  currentSyncedTags?: readonly string[]
): UserTagOverride | null {
  const gameId = normalizeSafeIdKey(game?.id);
  const label = sanitizeTagLabel(rawTag);
  const key = label.toLowerCase();
  if (!gameId || !label || !key) {
    return getUserTagOverrideForGame(game) ?? null;
  }

  const existing = getUserTagOverrideForGame(game);
  const equivKeys = new Set(getEquivalentTagKeys(key));

  const hadInAdded = existing
    ? existing.addedTags.some((t) => normalizeTagKey(t) === key)
    : false;
  const nextAdded = existing
    ? existing.addedTags.filter((t) => normalizeTagKey(t) !== key)
    : [];
  const nextRemoved = existing ? [...existing.removedTags] : [];

  const existsInSynced = Array.isArray(currentSyncedTags)
    ? currentSyncedTags.some((t) => equivKeys.has(normalizeTagKey(t)))
    : !hadInAdded;

  if (existsInSynced) {
    const alreadyInRemoved = nextRemoved.some((t) => normalizeTagKey(t) === key);
    if (!alreadyInRemoved && nextRemoved.length < MAX_USER_TAGS_PER_ARRAY) {
      nextRemoved.push(label);
    }
  }

  if (nextAdded.length === 0 && nextRemoved.length === 0) {
    removeUserTagOverride(gameId);
    return null;
  }

  const record: UserTagOverride = {
    gameId,
    platformAliases: extractGameTagPlatformAliases(game),
    addedTags: nextAdded,
    removedTags: nextRemoved,
    updatedAt: nextMonotonicTimestamp(existing?.updatedAt),
  };
  return saveUserTagOverride(record);
}

/**
 * Resets all user tag edits for `game` back to synced defaults.
 * Preserves sibling split-game records: only deletes `game.id` plus any legacy alias-matched record
 * whose entire `platformAliases` set is a strict subset of `game`'s own current aliases.
 */
export function resetUserTagsForGame(game: TagOverrideGameIdentity): boolean {
  const gameId = normalizeSafeIdKey(game?.id);
  if (!gameId) return false;

  const map = loadUserTagOverrides();
  const currentAliases = new Set(extractGameTagPlatformAliases(game));
  const subsumedLegacyIds: string[] = [];

  if (currentAliases.size > 0) {
    const seen = new Set<string>();
    for (const rec of Object.values(map)) {
      if (!rec || !rec.gameId || rec.gameId === gameId || seen.has(rec.gameId)) continue;
      seen.add(rec.gameId);
      const recAliases = Array.isArray(rec.platformAliases) ? rec.platformAliases : [];
      if (
        recAliases.length > 0 &&
        recAliases.every((a) => currentAliases.has(a))
      ) {
        subsumedLegacyIds.push(rec.gameId);
      }
    }
  }

  return removeUserTagOverride(gameId, {
    aliasKeys: subsumedLegacyIds,
  });
}

let inFlightVaultTagSync: Promise<boolean> | null = null;

/**
 * Reconciles canonical `UserTagOverride` records between renderer `localStorage` and Electron
 * `offlineVault` (`user_tag_overrides.json`) using newest-`updatedAt`-wins resolution.
 */
export async function hydrateUserTagOverridesFromVault(): Promise<boolean> {
  if (inFlightVaultTagSync) {
    return inFlightVaultTagSync;
  }
  if (
    typeof window === 'undefined' ||
    typeof window.electronAPI?.offlineVault?.getUserTagOverrides !== 'function'
  ) {
    return false;
  }

  inFlightVaultTagSync = (async (): Promise<boolean> => {
    try {
      const vaultRaw = await window.electronAPI!.offlineVault!.getUserTagOverrides!();
      const localMap: UserTagOverridesMap = { ...loadUserTagOverrides() };

      const canonicalLocal: Record<string, UserTagOverride> = {};
      for (const [key, rec] of Object.entries(localMap)) {
        const clean = sanitizeUserTagOverride(key, rec);
        if (!clean || (clean.addedTags.length === 0 && clean.removedTags.length === 0)) continue;
        const prev = canonicalLocal[clean.gameId];
        if (!prev || parseTimestampMs(clean.updatedAt) >= parseTimestampMs(prev.updatedAt)) {
          canonicalLocal[clean.gameId] = clean;
        }
      }

      const canonicalVault: Record<string, UserTagOverride> = {};
      if (vaultRaw && typeof vaultRaw === 'object' && !Array.isArray(vaultRaw)) {
        for (const [key, rawRec] of Object.entries(vaultRaw)) {
          const clean = sanitizeUserTagOverride(key, rawRec);
          if (!clean || (clean.addedTags.length === 0 && clean.removedTags.length === 0)) continue;
          const prev = canonicalVault[clean.gameId];
          if (!prev || parseTimestampMs(clean.updatedAt) >= parseTimestampMs(prev.updatedAt)) {
            canonicalVault[clean.gameId] = clean;
          }
        }
      }

      const hydratedGameIds: string[] = [];
      for (const [gameId, vaultRec] of Object.entries(canonicalVault)) {
        const localRec = canonicalLocal[gameId];
        const vaultTs = parseTimestampMs(vaultRec.updatedAt);
        const localTs = localRec ? parseTimestampMs(localRec.updatedAt) : -1;
        if (!localRec || vaultTs > localTs) {
          localMap[gameId] = vaultRec;
          if (Array.isArray(vaultRec.platformAliases)) {
            for (const alias of vaultRec.platformAliases) {
              const existingAtAlias = localMap[alias];
              if (!existingAtAlias || existingAtAlias.gameId !== alias) {
                localMap[alias] = vaultRec;
              }
            }
          }
          hydratedGameIds.push(gameId);
        }
      }

      const missingOrNewerForVault: Record<string, UserTagOverride> = {};
      for (const [gameId, localRec] of Object.entries(canonicalLocal)) {
        const vaultRec = canonicalVault[gameId];
        const localTs = parseTimestampMs(localRec.updatedAt);
        const vaultTs = vaultRec ? parseTimestampMs(vaultRec.updatedAt) : -1;
        if (!vaultRec || localTs > vaultTs) {
          missingOrNewerForVault[gameId] = localRec;
        }
      }

      if (hydratedGameIds.length > 0) {
        persistUserTagOverridesMapToStorage(localMap);
        dispatchUserTagOverridesUpdatedEvent({
          gameId: hydratedGameIds.length === 1 ? hydratedGameIds[0] : undefined,
          hydratedFromVault: true,
        });
      }

      const pushIds = Object.keys(missingOrNewerForVault);
      if (
        pushIds.length > 0 &&
        typeof window.electronAPI?.offlineVault?.saveUserTagOverride === 'function'
      ) {
        try {
          const batchRes = await window.electronAPI.offlineVault.saveUserTagOverride({
            batchOverrides: missingOrNewerForVault,
          });
          if (!batchRes || batchRes.success === false) {
            for (const [id, rec] of Object.entries(missingOrNewerForVault)) {
              await window.electronAPI.offlineVault
                .saveUserTagOverride(id, rec)
                ?.catch?.(() => {});
            }
          }
        } catch {
          for (const [id, rec] of Object.entries(missingOrNewerForVault)) {
            await window.electronAPI.offlineVault
              .saveUserTagOverride(id, rec)
              ?.catch?.(() => {});
          }
        }
      }

      return hydratedGameIds.length > 0 || pushIds.length > 0;
    } catch {
      return false;
    } finally {
      inFlightVaultTagSync = null;
    }
  })();

  return inFlightVaultTagSync;
}

if (
  !isTestEnv() &&
  typeof window !== 'undefined' &&
  typeof window.electronAPI?.offlineVault?.getUserTagOverrides === 'function'
) {
  void hydrateUserTagOverridesFromVault().catch(() => {});
}
