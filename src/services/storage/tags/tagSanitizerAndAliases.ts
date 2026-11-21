import type { UserTagOverride } from '../../../contracts/tags';
import { normalizeSafeIdKey } from '../storageRuntimeUtils';

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

const REBRAND_EQUIVALENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  achievements: ['achievements', 'steam achievements'],
  'steam achievements': ['steam achievements', 'achievements'],
  'cloud saves': ['cloud saves', 'steam cloud'],
  'steam cloud': ['steam cloud', 'cloud saves'],
  leaderboards: ['leaderboards', 'steam leaderboards'],
  'steam leaderboards': ['steam leaderboards', 'leaderboards'],
};

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

export function getEquivalentTagKeys(key: string): readonly string[] {
  return Object.hasOwn(REBRAND_EQUIVALENT_KEYS, key) ? REBRAND_EQUIVALENT_KEYS[key] : [key];
}

export function sanitizeTagArray(rawList: unknown): string[] {
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

export function sanitizePlatformAliasArray(rawAliases: unknown): string[] {
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

export function sanitizeUserTagOverride(
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
    if (
      !plat ||
      !plat.platformId ||
      plat.platformGameId === undefined ||
      plat.platformGameId === null
    ) {
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

export function expandAliasLookupVariants(alias: string): string[] {
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
