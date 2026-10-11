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
 * Detects whether two achievement summaries conflict in unlocked or total counts.
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

  const hasConflict = unlockedDelta !== 0 || (existing.total > 0 && incoming.total > 0 && totalDelta !== 0);

  if (!hasConflict) {
    return { hasConflict: false, unlockedDelta: 0, totalDelta: 0 };
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
 * Reconciles two achievement summaries using explicit source authority and timestamps.
 *
 * Rules:
 * 1. Authoritative live cloud (rank 3) supersedes local cache (rank 2) and baseline (rank 1),
 *    even when the live cloud count is lower (e.g. 0 trophies on Steam account for Soul Reaver).
 * 2. Local cache (rank 2) supersedes baseline (rank 1).
 * 3. A static baseline (rank 1) will NEVER overwrite or downgrade live cloud or local cache data.
 * 4. When ranks are equal:
 *    - If timestamps exist, the more recent `syncedAt` wins.
 *    - Otherwise, the higher unlocked count wins (progression latch).
 * 5. Any conflict is recorded on the winning summary with `hasConflict: true` and `conflictDetails`.
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
    if (incoming.syncedAt && existing.syncedAt && incoming.syncedAt !== existing.syncedAt) {
      if (incoming.syncedAt > existing.syncedAt) {
        winner = { ...incoming };
        resolutionReason = `Incoming has newer timestamp (${incoming.syncedAt} > ${existing.syncedAt})`;
      } else {
        winner = { ...existing };
        resolutionReason = `Existing has newer timestamp (${existing.syncedAt} >= ${incoming.syncedAt})`;
      }
    } else {
      // Default to progress: higher unlocked count, or incoming if identical
      if (incoming.unlocked >= existing.unlocked) {
        winner = { ...incoming };
        resolutionReason = `Incoming has equal or higher progress (${incoming.unlocked} >= ${existing.unlocked})`;
      } else {
        winner = { ...existing };
        resolutionReason = `Existing has higher progress (${existing.unlocked} > ${incoming.unlocked})`;
      }
    }
  }

  if (conflict.hasConflict) {
    winner.hasConflict = true;
    winner.conflictDetails = `${conflict.details}. Resolution: ${resolutionReason}.`;

    const tag = context?.appId ? `[AppID ${context.appId}]` : context?.title ? `[${context.title}]` : '[Storefront]';
    console.info(`[Achievement Conflict Reconciled] ${tag} ${winner.conflictDetails}`);
  }

  return winner;
}
