export type SyncCategory =
  | 'storefront_libraries'
  | 'cover_art'
  | 'critic_scores'
  | 'store_media'
  | 'achievements';

export interface SyncJobState {
  id: string;
  type:
    | 'store_media'
    | 'critic_scores'
    | 'achievements'
    | 'cover_art'
    | 'storefront_libraries'
    | 'multi';
  title: string;
  headline?: string;
  activeCategories?: string[];
  activeCategoryKeys?: SyncCategory[];
  total: number;
  current: number;
  currentItemName?: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'rate_limited';
  isPreempted?: boolean;
  priorityHeadline?: string;
  priorityItemName?: string;
  cooldownSecondsRemaining?: number;
  startedAt?: number;
  error?: string;
}

export type ManagedSyncJobKind = 'store_media' | 'critic_scores' | 'achievements';

export interface SyncJobHandle {
  readonly jobId: string;
  readonly kind: ManagedSyncJobKind;
  readonly loopToken: number;
  isStale(): boolean;
  safeUpdateState(partial: Partial<SyncJobState>): boolean;
}

export interface TrackedCategoryStats {
  total: number;
  completed: number;
  inFlight: number;
  lastItemName?: string;
}

export interface PriorityScopeEntry {
  id: string;
  headline: string;
  itemName?: string;
}

export const CATEGORY_SHORT_LABELS: Record<SyncCategory, string> = {
  storefront_libraries: 'Storefronts',
  cover_art: 'Cover Art',
  critic_scores: 'Review Scores',
  store_media: 'Store Media',
  achievements: 'Achievements',
};

export const CATEGORY_SINGLE_HEADLINES: Record<SyncCategory, string> = {
  storefront_libraries: 'Syncing Storefront Libraries',
  cover_art: 'Syncing Cover Art',
  critic_scores: 'Syncing Review Scores',
  store_media: 'Syncing Official Store Media',
  achievements: 'Syncing Achievements',
};

export function buildSyncHeadline(activeCats: SyncCategory[], fallbackTitle: string): string {
  if (activeCats.length === 0) return fallbackTitle;
  if (activeCats.length === 1) {
    if (activeCats[0] === 'store_media' && fallbackTitle) {
      return fallbackTitle;
    }
    return CATEGORY_SINGLE_HEADLINES[activeCats[0]] || fallbackTitle;
  }
  const labels = activeCats.map((c) => CATEGORY_SHORT_LABELS[c]);
  if (labels.length === 2) {
    return `Syncing ${labels[0]} & ${labels[1]}`;
  }
  return `Syncing ${labels.slice(0, -1).join(', ')} & ${labels[labels.length - 1]}`;
}

export function drainResolverQueue(resolvers: Array<() => void>): void {
  if (resolvers.length === 0) return;
  const pending = resolvers.splice(0, resolvers.length);
  for (const resolve of pending) {
    resolve();
  }
}

export async function yieldToMainThread(): Promise<void> {
  const sched: unknown =
    typeof globalThis !== 'undefined' ? Reflect.get(globalThis, 'scheduler') : undefined;
  if (sched && typeof sched === 'object' && 'yield' in sched && typeof sched.yield === 'function') {
    await sched.yield();
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
