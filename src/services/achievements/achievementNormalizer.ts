/**
 * Pure achievement normalization, deduplication, timestamp/progress validation, and rarity helpers.
 *
 * Preserves Hard Invariant 1 verbatim:
 * - `deduplicateDetailedAchievements()` is idempotent, preserves first-seen order, merges
 *   `unlocked: true` + `unlockedAt` + `progress` on duplicate IDs, self-heals doubled
 *   `total === deduped.length * 2` on read, keeps strictly scoped IDs (`<store>:<targetId>:<key>`),
 *   and never fabricates per-item unlocks from summary counts (`unlockPrecision: 'summary_count_only'`).
 */

import {
  AchievementProgress,
  AchievementRarityTier,
  DetailedAchievement,
  MultiStoreAchievementsMap,
  StorefrontAchievementsData,
} from '../../contracts/achievement';

export const ACHIEVEMENT_CACHE_VERSION = 2;

export interface SteamGlobalPctItem {
  name?: string;
  percent?: string | number;
}

export interface RawRewardItem {
  type?: string;
  value?: string | number;
}

export interface RawMediaAsset {
  url?: string;
}

export interface SteamGameAchievementApiItem {
  internal_name?: string;
  localized_name?: string;
  localized_desc?: string;
  icon?: string;
  icon_gray?: string;
  hidden?: boolean;
  player_percent_unlocked?: string | number;
  min_progress_int?: number;
  max_progress_int?: number;
}

export interface RawStoreAchievementRecord {
  id?: string;
  apiName?: string;
  achievementId?: string;
  achievement_id?: string;
  achievement_key?: string;
  name?: string;
  title?: string;
  unlockedDisplayName?: string;
  description?: string;
  unlockedDescription?: string;
  lockedDescription?: string;
  unlocked?: boolean;
  isUnlocked?: boolean;
  progressState?: string;
  state?: string;
  unlockedAt?: string | number | null;
  unlockTime?: string | number | null;
  date_unlocked?: string | number | null;
  progression?: { timeUnlocked?: string | null };
  iconUnlockedUrl?: string;
  unlockedIconUrl?: string;
  image_url_unlocked?: string;
  iconLockedUrl?: string;
  lockedIconUrl?: string;
  image_url_locked?: string;
  mediaAssets?: RawMediaAsset[];
  globalPercentage?: number;
  rarityPercent?: number;
  rarity?: number | { currentPercentage?: number };
  xp?: number;
  tierName?: string;
  isBaseGame?: boolean;
  isBase?: boolean;
  achievementSetId?: string;
  gamerscore?: number;
  rewards?: RawRewardItem[];
  progress?: Partial<AchievementProgress>;
  hidden?: boolean;
  isHidden?: boolean;
  isSecret?: boolean;
  visible?: boolean;
}

export interface StoreAchievementsEnvelope {
  achievements?: RawStoreAchievementRecord[];
  items?: RawStoreAchievementRecord[];
  total?: number;
  unlocked?: number;
  percentage?: number;
  isMastered?: boolean;
  totalCount?: number;
  unlockedCount?: number;
  totalGamerscore?: number;
  earnedGamerscore?: number;
  gamerscore?: { earned?: number; total?: number };
  totalXp?: number;
  earnedXp?: number;
  xp?: { earned?: number; total?: number };
  source?: 'live_cloud' | 'local_cache' | 'schema_fallback';
  unlockPrecision?: 'exact' | 'summary_count_only';
  supportsAchievements?: boolean;
  cacheVersion?: number;
  syncedAt?: string;
}

const MIN_VALID_UNLOCK_EPOCH_MS = Date.UTC(1980, 0, 1);
const UNIX_SECONDS_CUTOFF = 10_000_000_000;

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function normalizeAchievementMatchKey(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Classifies an achievement's rarity tier based on global unlock percentage.
 */
export function classifyRarityTier(percentage?: number | null): AchievementRarityTier {
  if (percentage === undefined || percentage === null || isNaN(percentage)) {
    return 'common';
  }
  if (percentage < 10.0) return 'ultra_rare';
  if (percentage < 25.0) return 'rare';
  if (percentage < 50.0) return 'uncommon';
  return 'common';
}

/**
 * Normalizes unlock timestamps from Unix seconds, Unix milliseconds, or ISO 8601 strings
 * across Steam, GOG, Epic, and Xbox into a canonical ISO 8601 UTC string (or `undefined`
 * for invalid / sentinel / `'N/A'` / pre-1980 placeholders).
 */
export function normalizeUnlockTimestamp(raw?: string | number | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    const ms = raw < UNIX_SECONDS_CUTOFF ? raw * 1000 : raw;
    if (!Number.isFinite(ms) || ms < MIN_VALID_UNLOCK_EPOCH_MS) return undefined;
    return new Date(ms).toISOString();
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || /^(?:n\/a|none|null|undefined|0)$/i.test(trimmed)) {
      return undefined;
    }
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
      const ms = numeric < UNIX_SECONDS_CUTOFF ? numeric * 1000 : numeric;
      if (!Number.isFinite(ms) || ms < MIN_VALID_UNLOCK_EPOCH_MS) return undefined;
      return new Date(ms).toISOString();
    }
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs) || parsedMs < MIN_VALID_UNLOCK_EPOCH_MS) {
      return undefined;
    }
    return new Date(parsedMs).toISOString();
  }

  return undefined;
}

/**
 * Validates and normalizes partial achievement progress (`max > 0`, finite `current`,
 * computes missing `percentage` in `[0, 100]`, preserves optional `unit`).
 */
export function normalizeAchievementProgress(
  raw?: Partial<AchievementProgress> | null
): AchievementProgress | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const current = raw.current;
  const max = raw.max;
  if (
    typeof current !== 'number' ||
    !Number.isFinite(current) ||
    typeof max !== 'number' ||
    !Number.isFinite(max) ||
    max <= 0
  ) {
    return undefined;
  }
  const safeCurrent = Math.max(0, current);
  const rawPct = raw.percentage;
  const percentage =
    typeof rawPct === 'number' && Number.isFinite(rawPct)
      ? Math.max(0, Math.min(100, Math.round(rawPct)))
      : Math.max(0, Math.min(100, Math.round((safeCurrent / max) * 100)));

  return {
    current: safeCurrent,
    max,
    percentage,
    ...(typeof raw.unit === 'string' && raw.unit.trim() ? { unit: raw.unit.trim() } : {}),
  };
}

/**
 * Parses XML CDATA or plain text safely.
 */
export function extractXmlTag(xml: string, tag: string): string {
  const cdataRegex = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const plainRegex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const plainMatch = xml.match(plainRegex);
  if (plainMatch) return plainMatch[1].trim();

  return '';
}

export function extractLiveAchievementsList(
  raw: unknown
): { list: RawStoreAchievementRecord[] | null; envelope: StoreAchievementsEnvelope | null } {
  if (Array.isArray(raw)) {
    return { list: raw as RawStoreAchievementRecord[], envelope: null };
  }
  if (raw && typeof raw === 'object') {
    const env = raw as StoreAchievementsEnvelope;
    if (Array.isArray(env.achievements)) {
      return { list: env.achievements, envelope: env };
    }
    if (Array.isArray(env.items)) {
      return { list: env.items, envelope: env };
    }
    return { list: null, envelope: env };
  }
  return { list: null, envelope: null };
}

/**
 * Hard Invariant 1:
 * Deduplicates `achievements` by `ach.id` preserving first-seen order (preferring `unlocked: true`
 * when duplicates disagree), merges `unlockedAt` + `progress` + metadata, self-heals doubled
 * `total === deduped.length * 2` on read, and recomputes `total`, `unlocked`, `percentage`, and
 * `isMastered`. Returns `data` untouched when no duplicate IDs or doubled totals are present.
 */
export function deduplicateDetailedAchievements(
  data: StorefrontAchievementsData
): StorefrontAchievementsData {
  if (!data || !Array.isArray(data.achievements) || data.achievements.length <= 1) {
    return data;
  }

  const deduped: DetailedAchievement[] = [];
  const indexById = new Map<string, number>();
  let hasDuplicates = false;

  for (const ach of data.achievements) {
    const idKey = typeof ach?.id === 'string' ? ach.id.trim() : '';
    if (idKey) {
      const existingIdx = indexById.get(idKey);
      if (existingIdx !== undefined) {
        hasDuplicates = true;
        const existing = deduped[existingIdx];
        if (!existing.unlocked && ach.unlocked) {
          deduped[existingIdx] = {
            ...existing,
            ...ach,
            unlocked: true,
            unlockedAt: ach.unlockedAt ?? existing.unlockedAt,
            description: ach.description || existing.description,
            iconUnlockedUrl: ach.iconUnlockedUrl || existing.iconUnlockedUrl,
            iconLockedUrl: ach.iconLockedUrl || existing.iconLockedUrl,
            globalPercentage: ach.globalPercentage ?? existing.globalPercentage,
            rarityTier: ach.rarityTier ?? existing.rarityTier,
            progress: ach.progress ?? existing.progress,
          };
        } else if (existing.unlocked === ach.unlocked) {
          const needsBackfill =
            (!existing.unlockedAt && Boolean(ach.unlockedAt)) ||
            (!existing.description && Boolean(ach.description)) ||
            (existing.globalPercentage === undefined && ach.globalPercentage !== undefined) ||
            (!existing.progress && Boolean(ach.progress));
          if (needsBackfill) {
            deduped[existingIdx] = {
              ...existing,
              unlockedAt: existing.unlockedAt ?? ach.unlockedAt,
              description: existing.description || ach.description,
              globalPercentage: existing.globalPercentage ?? ach.globalPercentage,
              rarityTier: existing.rarityTier ?? ach.rarityTier,
              progress: existing.progress ?? ach.progress,
            };
          }
        }
        continue;
      }
      indexById.set(idKey, deduped.length);
    }
    deduped.push(ach);
  }

  const hasDoubledOrUnderstatedTotal =
    deduped.length > 0 &&
    (data.total < deduped.length || (deduped.length > 1 && data.total === deduped.length * 2));

  if (!hasDuplicates && !hasDoubledOrUnderstatedTotal) {
    return data;
  }

  const total = deduped.length;
  const exactUnlocked = deduped.filter((a) => a.unlocked).length;
  const unlocked =
    data.unlockPrecision === 'summary_count_only' && exactUnlocked === 0
      ? Math.min(Math.max(0, data.unlocked || 0), total)
      : exactUnlocked;
  const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

  let hasGamerscore = false;
  let totalGamerscore = 0;
  let earnedGamerscore = 0;
  let hasXp = false;
  let totalXp = 0;
  let earnedXp = 0;

  for (const ach of deduped) {
    if (typeof ach.gamerscore === 'number' && Number.isFinite(ach.gamerscore)) {
      hasGamerscore = true;
      totalGamerscore += ach.gamerscore;
      if (ach.unlocked) earnedGamerscore += ach.gamerscore;
    }
    if (typeof ach.xp === 'number' && Number.isFinite(ach.xp)) {
      hasXp = true;
      totalXp += ach.xp;
      if (ach.unlocked) earnedXp += ach.xp;
    }
  }

  return {
    ...data,
    achievements: deduped,
    total,
    unlocked,
    percentage,
    isMastered: total > 0 && unlocked >= total,
    ...(hasGamerscore && data.totalGamerscore !== undefined ? { totalGamerscore } : {}),
    ...(hasGamerscore && data.earnedGamerscore !== undefined ? { earnedGamerscore } : {}),
    ...(hasXp && data.totalXp !== undefined ? { totalXp } : {}),
    ...(hasXp && data.earnedXp !== undefined ? { earnedXp } : {}),
  };
}

export function normalizeMultiStoreAchievementsMap(
  map: MultiStoreAchievementsMap
): { normalized: MultiStoreAchievementsMap; changed: boolean } {
  let changed = false;
  let normalized: MultiStoreAchievementsMap = map;
  for (const key of Object.keys(map) as Array<keyof MultiStoreAchievementsMap>) {
    const entry = map[key];
    if (!entry) continue;
    const deduped = deduplicateDetailedAchievements(entry);
    if (deduped !== entry) {
      if (!changed) {
        normalized = { ...map };
        changed = true;
      }
      normalized[key] = deduped;
    }
  }
  return { normalized, changed };
}
