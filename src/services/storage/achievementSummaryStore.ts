/**
 * Layer 1 (`services-catalog`) public barrel re-exporting the canonical Layer 0
 * `AchievementSummaryStore` implementation from `knownGameAchievementsStore.ts`.
 *
 * Preserves the strict 3-tier Rollup chunk DAG (`services-catalog -> services-foundation`,
 * zero circular chunk edges).
 */

export {
  ACHIEVEMENT_SUMMARY_IDB_KEYS,
  ACHIEVEMENT_SUMMARY_STORAGE_KEYS,
  AchievementSummaryStore,
  STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC,
  achievementSummaryStore,
  clearStorefrontAchievementSummaries,
  normalizeStoredAchievementSummary,
  type AchievementSummaryStorefrontId,
} from './knownGameAchievementsStore';
