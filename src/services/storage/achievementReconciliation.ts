import { StoreAchievementSummary, AchievementDataSource } from '../../contracts/game';

/**
 * Priority rank for achievement data sources.
 * Higher rank represents higher authority.
 *
 * Rank 3 (Authoritative Cloud): Real-time responses from storefront user endpoints
 * Rank 2 (Local Machine Cache): Scanned from local client userdata/librarycache on the workstation
 * Rank 1 (Static Baseline / Fallback): Built-in offline dictionaries or untagged legacy objects
 */
export function getAchievementSourceRank(source?: AchievementDataSource): number {
  switch (source) {
    case 'live_cloud_api':
    case 'live_cloud_xml':
    case 'live_cloud_graphql':
      return 3;
    case 'local_client_cache':
      return 2;
    case 'baseline_fallback':
    default:
      return 1;
  }
}

export interface ConflictDetectionResult {
  hasConflict: boolean;
  details?: string;
  unlockedDelta: number;
  totalDelta: number;
}

/**
 * Parses an ISO 8601 (or RFC 2822) timestamp string into epoch milliseconds using `Date.parse()`.
 */
function parseTimestampMs(value?: string): number | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Selects the newest valid timestamp among candidate ISO strings using `Date.parse()` and `.toSorted()`.
 */
function pickLatestTimestamp(...candidates: Array<string | undefined>): string | undefined {
  const validEntries = candidates
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => ({ value: value.trim(), ms: parseTimestampMs(value) }));

  if (validEntries.length === 0) return undefined;

  const sorted = validEntries.toSorted((a, b) => {
    if (a.ms !== null && b.ms !== null) {
      return b.ms - a.ms;
    }
    if (a.ms !== null) return -1;
    if (b.ms !== null) return 1;
    return 0;
  });

  return sorted[0]?.value;
}

/**
 * Returns true when two Rank-3 live cloud summaries differ solely due to normal monotonic
 * gameplay progression (unlocking additional trophies or DLC increasing total count) rather
 * than a regression or cross-source disagreement.
 */
function isMonotonicLiveCloudProgression(
  existing: StoreAchievementSummary,
  incoming: StoreAchievementSummary
): boolean {
  if (
    getAchievementSourceRank(existing.source) !== 3 ||
    getAchievementSourceRank(incoming.source) !== 3
  ) {
    return false;
  }

  const existingMs = parseTimestampMs(existing.syncedAt);
  const incomingMs = parseTimestampMs(incoming.syncedAt);

  // Incoming is newer (or timestamps are absent/equal) and progress moved forward monotonically
  const incomingNotOlder =
    existingMs === null || incomingMs === null || incomingMs >= existingMs;
  if (
    incomingNotOlder &&
    incoming.unlocked >= existing.unlocked &&
    (existing.total === 0 || incoming.total >= existing.total)
  ) {
    return true;
  }

  // Existing is strictly newer and already holds equal-or-higher progress than a stale cloud snapshot
  if (
    existingMs !== null &&
    incomingMs !== null &&
    existingMs > incomingMs &&
    existing.unlocked >= incoming.unlocked &&
    (incoming.total === 0 || existing.total >= incoming.total)
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether two achievement summaries conflict in unlocked or total counts.
 * Normal monotonic progression between authoritative live cloud syncs is NOT flagged as a conflict.
 */
export function detectAchievementConflict(
  existing?: StoreAchievementSummary,
  incoming?: StoreAchievementSummary
): ConflictDetectionResult {
  if (!existing || !incoming) {
    return { hasConflict: false, unlockedDelta: 0, totalDelta: 0 };
  }

  const unlockedDelta = incoming.unlocked - existing.unlocked;
  const totalDelta = incoming.total - existing.total;

  const hasDiscrepancy =
    unlockedDelta !== 0 || (existing.total > 0 && incoming.total > 0 && totalDelta !== 0);

  if (!hasDiscrepancy) {
    return { hasConflict: false, unlockedDelta: 0, totalDelta: 0 };
  }

  if (isMonotonicLiveCloudProgression(existing, incoming)) {
    return { hasConflict: false, unlockedDelta, totalDelta };
  }

  const existingSrc = existing.source || 'unspecified_cache';
  const incomingSrc = incoming.source || 'unspecified_source';

  const details = `Discrepancy: existing [${existingSrc}: ${existing.unlocked}/${existing.total}] vs incoming [${incomingSrc}: ${incoming.unlocked}/${incoming.total}]`;

  return {
    hasConflict: true,
    details,
    unlockedDelta,
    totalDelta,
  };
}

/**
 * Reconciles two achievement summaries using explicit source authority and canonical timestamps.
 *
 * Rules:
 * 1. Authoritative live cloud (rank 3) supersedes local cache (rank 2) and baseline (rank 1),
 *    even when the live cloud count is lower (e.g. 0 trophies on Steam account).
 * 2. Local cache (rank 2) supersedes baseline (rank 1).
 * 3. A static baseline (rank 1) will NEVER overwrite or downgrade live cloud or local cache data.
 * 4. When ranks are equal:
 *    - An empty `{ unlocked: 0, total: 0 }` payload never wipes an equal-rank summary with `total > 0`.
 *    - If valid timestamps exist, the more recent `Date.parse(syncedAt)` wins.
 *    - Otherwise, higher `unlocked` count (then higher `total`) wins (progression latch).
 * 5. Genuine conflicts (cross-source disagreements or regressions) are recorded on the winning
 *    summary with `hasConflict: true` and `conflictDetails`; normal monotonic live-cloud unlocks
 *    do not set `hasConflict`.
 */
export function reconcileAchievementSummaries(
  existing?: StoreAchievementSummary,
  incoming?: StoreAchievementSummary,
  context?: { title?: string; appId?: number; store?: string }
): StoreAchievementSummary | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming ? { ...incoming } : undefined;
  if (!incoming) return { ...existing };

  const conflict = detectAchievementConflict(existing, incoming);
  const existingRank = getAchievementSourceRank(existing.source);
  const incomingRank = getAchievementSourceRank(incoming.source);

  let winner: StoreAchievementSummary;
  let resolutionReason: string;

  if (incomingRank > existingRank) {
    // Incoming has higher authority (e.g. Live Cloud overriding Cache/Baseline)
    winner = { ...incoming };
    resolutionReason = `Incoming source (${incoming.source || 'cloud'}) has higher authority than existing (${existing.source || 'cache'})`;
  } else if (existingRank > incomingRank) {
    // Existing has higher authority (e.g. Live Cloud refusing downgrade from Baseline)
    winner = { ...existing };
    resolutionReason = `Existing source (${existing.source || 'cloud'}) has higher authority than incoming (${incoming.source || 'baseline'})`;
  } else {
    // Equal authority rank
    const existingIsKnownZeroUnlocked = existing.total > 0;
    const incomingIsEmptyZero = incoming.unlocked === 0 && incoming.total === 0;
    const incomingIsKnownTotal = incoming.total > 0;
    const existingIsEmptyZero = existing.unlocked === 0 && existing.total === 0;

    if (existingIsKnownZeroUnlocked && incomingIsEmptyZero) {
      // Prevent `{ unlocked: 0, total: 0 }` from wiping `{ unlocked: 0, total: 50 }` on equal rank
      winner = { ...existing };
      resolutionReason = `Existing retains known total (${existing.unlocked}/${existing.total}) over empty incoming (0/0)`;
    } else if (incomingIsKnownTotal && existingIsEmptyZero) {
      winner = { ...incoming };
      resolutionReason = `Incoming provides known total (${incoming.unlocked}/${incoming.total}) over empty existing (0/0)`;
    } else {
      const existingMs = parseTimestampMs(existing.syncedAt);
      const incomingMs = parseTimestampMs(incoming.syncedAt);

      if (existingMs !== null && incomingMs !== null && incomingMs !== existingMs) {
        if (incomingMs > existingMs) {
          winner = { ...incoming };
          resolutionReason = `Incoming has newer timestamp (${incoming.syncedAt} > ${existing.syncedAt})`;
        } else {
          winner = { ...existing };
          resolutionReason = `Existing has newer timestamp (${existing.syncedAt} > ${incoming.syncedAt})`;
        }
      } else if (incoming.unlocked > existing.unlocked) {
        winner = { ...incoming };
        resolutionReason = `Incoming has higher progress (${incoming.unlocked} > ${existing.unlocked})`;
      } else if (existing.unlocked > incoming.unlocked) {
        winner = { ...existing };
        resolutionReason = `Existing has higher progress (${existing.unlocked} > ${incoming.unlocked})`;
      } else if (incoming.total > existing.total) {
        winner = { ...incoming };
        resolutionReason = `Incoming has higher known total (${incoming.total} > ${existing.total})`;
      } else if (existing.total > incoming.total) {
        winner = { ...existing };
        resolutionReason = `Existing has higher known total (${existing.total} > ${incoming.total})`;
      } else {
        winner = { ...incoming };
        resolutionReason = `Incoming matches existing progress (${incoming.unlocked}/${incoming.total})`;
      }
    }
  }

  if (existing.gamerscore || incoming.gamerscore) {
    if (incomingRank > existingRank && incoming.gamerscore) {
      winner.gamerscore = {
        earned: incoming.gamerscore.earned,
        total: incoming.gamerscore.total || existing.gamerscore?.total || 0,
      };
    } else if (existingRank > incomingRank && existing.gamerscore) {
      winner.gamerscore = {
        earned: existing.gamerscore.earned,
        total: existing.gamerscore.total || incoming.gamerscore?.total || 0,
      };
    } else {
      winner.gamerscore = {
        earned: Math.max(existing.gamerscore?.earned ?? 0, incoming.gamerscore?.earned ?? 0),
        total: Math.max(existing.gamerscore?.total ?? 0, incoming.gamerscore?.total ?? 0),
      };
    }
  }

  if (winner.xp === undefined && (existing.xp !== undefined || incoming.xp !== undefined)) {
    winner.xp = incoming.xp ?? existing.xp;
  }

  if (winner.unlocked > 0) {
    const resolvedLastUnlockedAt = pickLatestTimestamp(
      existing.lastUnlockedAt,
      incoming.lastUnlockedAt
    );
    if (resolvedLastUnlockedAt) {
      winner.lastUnlockedAt = resolvedLastUnlockedAt;
    }
  } else {
    delete winner.lastUnlockedAt;
  }

  if (conflict.hasConflict) {
    winner.hasConflict = true;
    winner.conflictDetails = `${conflict.details}. Resolution: ${resolutionReason}.`;

    const tag = context?.appId
      ? `[AppID ${context.appId}]`
      : context?.title
        ? `[${context.title}]`
        : '[Storefront]';
    console.info(`[Achievement Conflict Reconciled] ${tag} ${winner.conflictDetails}`);
  }

  return winner;
}
