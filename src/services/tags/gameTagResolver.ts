import type { SteamEnrichedMetadata } from '../../contracts/steam';
import type { UserGameOverride } from '../../contracts/override';
import type {
  ResolvedGameTag,
  ResolvedGameTagsResult,
  TagFacetCount,
  UserTagOverride,
  UserTagOverridesMap,
} from '../../contracts/tags';
import {
  getEffectiveTags,
  isGameOwnedOnSteam,
  normalizeSyncedTagToken,
} from '../steam/steamFeatureNormalizer';
import {
  getUserTagOverrideForGame,
  loadUserTagOverrides,
  normalizeTagKey,
  sanitizeTagLabel,
} from '../storage/userTagStorage';

export { normalizeTagKey, sanitizeTagLabel, normalizeSyncedTagToken };

export interface ResolvableTagGame {
  id: string;
  steamAppId?: number;
  isExplicitNonSteam?: boolean;
  platforms?: Array<{
    platformId: string;
    platformGameId?: string;
  }>;
  tags?: string[];
  enrichedMetadata?: Pick<SteamEnrichedMetadata, 'tags'> | null;
}

export interface ResolveGameTagsOptions {
  liveMetadata?: Pick<SteamEnrichedMetadata, 'tags'> | null;
  fixMatchOverride?: Pick<UserGameOverride, 'tags' | 'metadataRoute' | 'matchedStore'> | null;
  isDynamicRouted?: boolean;
  tagOverride?: UserTagOverride | null;
  overridesMap?: UserTagOverridesMap;
}

const BARE_STOREFRONT_STUB_TAG_KEYS: ReadonlySet<string> = new Set([
  'steam',
  'gog',
  'epic games store',
  'xbox',
  'microsoft store',
]);

const DYNAMIC_STOREFRONT_TAG_KEYS: ReadonlySet<string> = new Set([
  'pc game pass',
  'drm-free',
  'leaving soon',
  'xbox play anywhere',
  'requires ea',
  'ea play',
]);

function inferIsDynamicRouted(options?: ResolveGameTagsOptions): boolean {
  if (typeof options?.isDynamicRouted === 'boolean') {
    return options.isDynamicRouted;
  }
  const ov = options?.fixMatchOverride;
  if (!ov) return false;
  if (ov.metadataRoute?.mode === 'routed') return true;
  if (ov.metadataRoute?.mode === 'custom') return false;
  if (ov.metadataRoute?.source) {
    return ov.metadataRoute.source !== 'custom' && ov.metadataRoute.source !== 'original';
  }
  if (ov.matchedStore) {
    return ov.matchedStore !== 'custom';
  }
  return false;
}

function hasNonEmptyTags(tags?: readonly string[] | null): tags is readonly string[] {
  return Array.isArray(tags) && tags.length > 0;
}

/**
 * Collects and normalizes the authoritative synced storefront tags for a game:
 * - Honors `!isDynamicRouted` Fix Match precedence (`fixMatchOverride.tags` beats stale `enrichedMetadata.tags`
 *   when `!isDynamicRouted`, while live/enriched wins when `isDynamicRouted`).
 * - Merges non-placeholder dynamic tags from `game.tags` (`"PC Game Pass"`, `"DRM-Free"`, `"Leaving Soon"`,
 *   `"Xbox Play Anywhere"`, and rich summary tags on hybrid titles).
 * - Maps known Valve localization tokens (`#category_playable_at_your_own_pace`, `#category_contrast_controls`)
 *   and strips remaining raw `#category_*` keys.
 * - Normalizes Steam ownership & deduplicates via `getEffectiveTags`.
 * - Suppresses bare storefront stubs (`"Steam"`, `"GOG"`, `"Epic Games Store"`, `"Xbox"`, `"Microsoft Store"`)
 *   whenever richer non-stub tags exist.
 */
export function collectBaseSyncedTags(
  game: ResolvableTagGame | null | undefined,
  options?: ResolveGameTagsOptions
): string[] {
  if (!game) return [];

  const isDynamicRouted = inferIsDynamicRouted(options);
  const liveTags = hasNonEmptyTags(options?.liveMetadata?.tags) ? options!.liveMetadata!.tags! : null;
  const enrichedTags = hasNonEmptyTags(game.enrichedMetadata?.tags)
    ? game.enrichedMetadata!.tags!
    : null;
  const overrideTags = hasNonEmptyTags(options?.fixMatchOverride?.tags)
    ? options!.fixMatchOverride!.tags!
    : null;
  const summaryTags = hasNonEmptyTags(game.tags) ? game.tags! : null;

  const isCustomFixMatchPinned = Boolean(!isDynamicRouted && overrideTags);

  let primaryPool: readonly string[] = [];
  if (isDynamicRouted) {
    primaryPool = liveTags ?? enrichedTags ?? overrideTags ?? summaryTags ?? [];
  } else {
    primaryPool = overrideTags ?? liveTags ?? enrichedTags ?? summaryTags ?? [];
  }

  const combinedPool: string[] = [...primaryPool];

  // Merge non-placeholder dynamic tags from `game.tags` when primary came from enriched/live/override
  if (summaryTags && primaryPool !== summaryTags) {
    for (const rawTag of summaryTags) {
      const normalized = normalizeSyncedTagToken(rawTag);
      if (!normalized) continue;
      const lower = normalized.toLowerCase();
      if (BARE_STOREFRONT_STUB_TAG_KEYS.has(lower)) continue;
      if (isCustomFixMatchPinned && !DYNAMIC_STOREFRONT_TAG_KEYS.has(lower)) {
        // When user explicitly pinned non-routed Fix Match tags, only merge dynamic storefront status tags
        continue;
      }
      combinedPool.push(normalized);
    }
  }

  const isOwnedOnSteam = isGameOwnedOnSteam(game.platforms);
  const normalizedTags = getEffectiveTags(combinedPool, isOwnedOnSteam);

  if (normalizedTags.length === 0) {
    return [];
  }

  const nonStubTags = normalizedTags.filter(
    (tag) => !BARE_STOREFRONT_STUB_TAG_KEYS.has(tag.toLowerCase())
  );
  return nonStubTags.length > 0 ? nonStubTags : normalizedTags;
}

/**
 * Single authoritative tag resolver for all UI & filtering surfaces (`SteamHeroDetails`,
 * `SteamStorePage`, `LibraryFilterIndex`, `gameFilterService`, and `GameHoverPopout`).
 *
 * - Emits user `addedTags` FIRST (preserving user display casing and NEVER stripping/rebranding
 *   them through `getEffectiveTags`).
 * - Follows with synced tags not suppressed in `removedTags`.
 * - Accepts an optional preloaded `overridesMap` so catalog-wide indexing (`buildLibraryFilterIndex`)
 *   avoids repeated `localStorage` reads and stays strictly O(1) per game.
 */
export function resolveEffectiveGameTags(
  game: ResolvableTagGame | null | undefined,
  options?: ResolveGameTagsOptions
): ResolvedGameTagsResult {
  if (!game) {
    return {
      tags: [],
      entries: [],
      syncedTags: [],
      userAddedTags: [],
      hasUserEdits: false,
    };
  }

  const syncedTags = collectBaseSyncedTags(game, options);
  const tagOverride =
    options?.tagOverride !== undefined
      ? options.tagOverride ?? undefined
      : getUserTagOverrideForGame(game, options?.overridesMap);

  if (!tagOverride) {
    const entries: ResolvedGameTag[] = [];
    const seen = new Set<string>();
    for (const synced of syncedTags) {
      const key = normalizeTagKey(synced);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({ label: synced, key, source: 'synced' });
    }
    return {
      tags: entries.map((e) => e.label),
      entries,
      syncedTags,
      userAddedTags: [],
      hasUserEdits: false,
    };
  }

  const removedKeySet = new Set<string>();
  for (const rt of tagOverride.removedTags) {
    const key = normalizeTagKey(rt);
    if (key) removedKeySet.add(key);
  }

  const entries: ResolvedGameTag[] = [];
  const userAddedTags: string[] = [];
  const seenKeys = new Set<string>();

  // 1. User-added tags FIRST — preserve exact display casing, NEVER passed through `getEffectiveTags`
  for (const rawUserTag of tagOverride.addedTags) {
    const label = sanitizeTagLabel(rawUserTag);
    const key = label.toLowerCase();
    if (!label || !key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    userAddedTags.push(label);
    entries.push({ label, key, source: 'user' });
  }

  // 2. Synced tags not hidden in `removedTags` and not already superseded by a user-added tag
  for (const synced of syncedTags) {
    const key = normalizeTagKey(synced);
    if (!key || seenKeys.has(key) || removedKeySet.has(key)) continue;
    seenKeys.add(key);
    entries.push({ label: synced, key, source: 'synced' });
  }

  const hasUserEdits =
    tagOverride.addedTags.length > 0 || tagOverride.removedTags.length > 0;

  return {
    tags: entries.map((e) => e.label),
    entries,
    syncedTags,
    userAddedTags,
    hasUserEdits,
  };
}

/**
 * Aggregates frequency-sorted library tag counts using a single preloaded `UserTagOverridesMap`
 * snapshot, preferring user-supplied display casing whenever present.
 */
export function buildTagFacetCounts(
  games: readonly ResolvableTagGame[],
  overridesMap?: UserTagOverridesMap
): TagFacetCount[] {
  const snapshot = overridesMap ?? loadUserTagOverrides();
  const counts = new Map<string, { label: string; count: number; hasUserLabel: boolean }>();

  for (const game of games) {
    const resolved = resolveEffectiveGameTags(game, { overridesMap: snapshot });
    for (const entry of resolved.entries) {
      const existing = counts.get(entry.key);
      if (!existing) {
        counts.set(entry.key, {
          label: entry.label,
          count: 1,
          hasUserLabel: entry.source === 'user',
        });
      } else {
        existing.count += 1;
        if (entry.source === 'user' && !existing.hasUserLabel) {
          existing.label = entry.label;
          existing.hasUserLabel = true;
        }
      }
    }
  }

  const result: TagFacetCount[] = [];
  for (const [key, data] of counts.entries()) {
    result.push({ key, label: data.label, count: data.count });
  }

  return result.toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
