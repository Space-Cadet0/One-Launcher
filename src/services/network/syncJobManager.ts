import type { CanonicalGame } from '../../contracts/game';
import { requestScheduler } from './requestScheduler';
import { onlineLifecycleManager } from './onlineLifecycleManager';
import {
  computeMediaRepairPriority,
  evaluateGameNeedsStoreMediaSync,
  hasActiveMediaSyncCooldown,
  MAX_PASSIVE_REPAIR_PER_BOOT,
  MEDIA_SYNC_DOMAINS,
  type MediaRepairPriorityTier,
  type StoreMediaSyncEvalOptions,
  type StoreMediaSyncOptions,
} from './sync/mediaSyncEligibility';
import {
  buildP2CoverHydrationBatch,
  extractStaticHydrationAssets,
  type HydrationQueueGameEntry,
} from './sync/hydrationAssetExtractor';
import {
  buildSyncHeadline,
  CATEGORY_SHORT_LABELS,
  CATEGORY_SINGLE_HEADLINES,
  drainResolverQueue,
  type PriorityScopeEntry,
  type SyncCategory,
  type SyncJobHandle,
  type SyncJobState,
  type TrackedCategoryStats,
} from './sync/syncStateMachine';
import {
  type CriticScoreSyncOptions,
  executeCriticScoreSyncJob,
} from './sync/criticScoreSyncRunner';
import { executeStoreMediaSyncJob } from './sync/storeMediaSyncRunner';

export {
  type StoreMediaSyncEvalOptions,
  type MediaRepairPriorityTier,
  MAX_PASSIVE_REPAIR_PER_BOOT,
  type StoreMediaSyncOptions,
  computeMediaRepairPriority,
  evaluateGameNeedsStoreMediaSync,
  extractStaticHydrationAssets,
  type HydrationQueueGameEntry,
  buildP2CoverHydrationBatch,
  MEDIA_SYNC_DOMAINS,
  hasActiveMediaSyncCooldown,
  type SyncCategory,
  type SyncJobState,
  type SyncJobHandle,
};

export class SyncJobManager {
  private state: SyncJobState | null = null;
  private listeners = new Set<(state: SyncJobState | null) => void>();
  private isCancelled = false;

  // P0-1: Multi-waiter pause queue (replaces scalar pausePromiseResolve so concurrent
  // critic/media chunk workers NEVER drop waiters and deadlock backgroundWarmupChain)
  private pauseResolvers: Array<() => void> = [];

  // Multi-category background activity tracking (e.g. Cover Art + Review Scores + Achievements)
  private categoryStats = new Map<SyncCategory, TrackedCategoryStats>();
  private categoryClearTimer: ReturnType<typeof setTimeout> | null = null;

  // On-demand priority preemption scopes (e.g. Fix & Match Wizard, Sync Store Media for single game)
  private priorityScopes = new Map<string, PriorityScopeEntry>();
  private preemptionResolvers: Array<() => void> = [];
  private priorityCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  private trophyCompleteTimer: ReturnType<typeof setTimeout> | null = null;

  // Active background critic score, store media, and trophy sync loop cancellation tokens
  private criticLoopToken = 0;
  private mediaSyncLoopToken = 0;
  private trophyLoopToken = 0;

  // Serialized FIFO coordination lane for background warmup jobs (critic_scores <-> store_media)
  // so sibling warmups queue/chain cleanly instead of cancelling each other during hydration waits.
  private backgroundWarmupChain: Promise<void> = Promise.resolve();
  private backgroundWarmupEpoch = 0;
  private queuedBackgroundWarmups = new Set<'critic_scores' | 'store_media'>();

  private hasActiveManualJob(): boolean {
    return Boolean(
      this.state &&
        !this.state.id.startsWith('auto-') &&
        (this.state.status === 'running' ||
          this.state.status === 'paused' ||
          this.state.status === 'rate_limited')
    );
  }

  private clearCategoryTimer(): void {
    if (this.categoryClearTimer) {
      clearTimeout(this.categoryClearTimer);
      this.categoryClearTimer = null;
    }
  }

  private clearPriorityTimer(): void {
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }
  }

  private clearTrophyTimer(): void {
    if (this.trophyCompleteTimer) {
      clearTimeout(this.trophyCompleteTimer);
      this.trophyCompleteTimer = null;
    }
  }

  private createJobHandle(
    kind: 'store_media' | 'critic_scores' | 'achievements',
    jobId: string,
    loopToken: number
  ): SyncJobHandle {
    const isStale = (): boolean => {
      const activeToken =
        kind === 'store_media'
          ? this.mediaSyncLoopToken
          : kind === 'critic_scores'
            ? this.criticLoopToken
            : this.trophyLoopToken;
      return activeToken !== loopToken || this.state?.id !== jobId;
    };
    return {
      jobId,
      kind,
      loopToken,
      isStale,
      safeUpdateState: (partial: Partial<SyncJobState>): boolean => {
        if (isStale()) return false;
        this.updateState(partial);
        return true;
      },
    };
  }

  private enqueueBackgroundWarmup(
    kind: 'critic_scores' | 'store_media',
    runner: () => Promise<void>
  ): Promise<void> {
    if (this.queuedBackgroundWarmups.has(kind)) {
      return Promise.resolve();
    }
    this.queuedBackgroundWarmups.add(kind);
    const myEpoch = this.backgroundWarmupEpoch;
    const prevTail = this.backgroundWarmupChain;
    const { promise: slotDone, resolve: releaseSlot } = Promise.withResolvers<void>();
    this.backgroundWarmupChain = prevTail.then(() => slotDone);

    return (async () => {
      try {
        await prevTail;
        if (myEpoch !== this.backgroundWarmupEpoch) {
          return;
        }
        if (!onlineLifecycleManager.isOnline()) {
          return;
        }
        if (this.hasActiveManualJob()) {
          return;
        }
        await runner();
      } finally {
        this.queuedBackgroundWarmups.delete(kind);
        releaseSlot();
      }
    })();
  }

  public getState(): SyncJobState | null {
    return this.state ? { ...this.state } : null;
  }

  public subscribe(listener: (state: SyncJobState | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const current = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch (err) {
        console.error('[SyncJobManager] Error in listener callback:', err);
      }
    }
  }

  private updateState(partial: Partial<SyncJobState>): void {
    if (!this.state) return;
    this.state = {
      ...this.state,
      ...partial,
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();
  }

  private getActiveCategories(): SyncCategory[] {
    const active: SyncCategory[] = [];
    for (const [cat, stats] of this.categoryStats.entries()) {
      if (stats.inFlight > 0 || stats.completed < stats.total) {
        active.push(cat);
      }
    }
    if (
      this.state &&
      !this.state.id.startsWith('priority-') &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      const primaryType = this.state.type;
      if (primaryType !== 'multi' && !active.includes(primaryType as SyncCategory)) {
        active.unshift(primaryType as SyncCategory);
      }
    }
    return active;
  }

  private syncHeadlineAndPriorityFields(): void {
    if (!this.state) return;
    const activeCats = this.getActiveCategories();
    const activeLabels = activeCats.map((c) => CATEGORY_SHORT_LABELS[c]);

    // P0-3 / BUG-C7: Prevent trophy sync and storefront library sync from marking themselves
    // `isPreempted: true` when wrapped in their own matching priority scope.
    const isSelfTrophyJob =
      this.state.type === 'achievements' && this.state.id.startsWith('trophy-sync-');
    const isSelfStorefrontJob =
      !this.state.id.startsWith('priority-') &&
      (this.state.type === 'storefront_libraries' ||
        (this.state.id.startsWith('auto-sync-') &&
          activeCats.includes('storefront_libraries')));
    const scopes = Array.from(this.priorityScopes.values());
    const latestPriority = scopes
      .filter((s) => {
        if (isSelfTrophyJob && s.headline === this.state?.title) {
          return false;
        }
        if (
          isSelfStorefrontJob &&
          s.headline === CATEGORY_SINGLE_HEADLINES.storefront_libraries
        ) {
          return false;
        }
        return true;
      })
      .pop();

    this.state.activeCategories = activeLabels;
    this.state.activeCategoryKeys = activeCats;
    this.state.isPreempted = Boolean(latestPriority);
    this.state.priorityHeadline = latestPriority?.headline;
    this.state.priorityItemName = latestPriority?.itemName;

    if (this.state.id.startsWith('priority-') && latestPriority) {
      this.state.id = `priority-${latestPriority.id}`;
      this.state.title = latestPriority.headline;
      this.state.headline = latestPriority.headline;
      this.state.currentItemName = latestPriority.itemName;
    } else if (activeCats.length > 1) {
      this.state.headline = buildSyncHeadline(activeCats, this.state.title);
    } else if (activeCats.length === 1 && this.state.id.startsWith('auto-')) {
      const single = buildSyncHeadline(activeCats, this.state.title);
      this.state.title = single;
      this.state.headline = single;
    } else {
      this.state.headline = this.state.title;
    }
  }

  /**
   * Begins an on-demand user priority scope (e.g. "Sync Store Media (this game)" or "Fix & Match Metadata").
   * Automatically pauses running background syncs and prioritizes P0_INTERACTIVE network requests.
   * When endPriorityScope is called, background syncs automatically resume where they left off.
   */
  public beginPriorityScope(headline: string, itemName?: string): string {
    this.clearPriorityTimer();

    const scopeId = requestScheduler.beginInteractiveScope();
    this.priorityScopes.set(scopeId, { id: scopeId, headline, itemName });

    if (
      !this.state ||
      this.state.status === 'idle' ||
      this.state.status === 'completed' ||
      this.state.status === 'cancelled'
    ) {
      this.state = {
        id: `priority-${scopeId}`,
        type: 'store_media',
        title: headline,
        headline,
        total: 1,
        current: 0,
        currentItemName: itemName,
        status: 'running',
        isPreempted: true,
        priorityHeadline: headline,
        priorityItemName: itemName,
        startedAt: Date.now(),
      };
    } else {
      this.syncHeadlineAndPriorityFields();
    }
    this.notify();
    return scopeId;
  }

  /**
   * Ends an on-demand priority scope and automatically resumes any preempted background syncs.
   */
  public endPriorityScope(scopeId: string): void {
    if (!this.priorityScopes.has(scopeId)) return;
    this.priorityScopes.delete(scopeId);
    requestScheduler.endInteractiveScope(scopeId);

    if (this.priorityScopes.size === 0) {
      drainResolverQueue(this.preemptionResolvers);
    }

    if (this.state) {
      if (this.state.id.startsWith('priority-') && this.priorityScopes.size === 0) {
        const activeCats = this.getActiveCategories();
        if (activeCats.length > 0) {
          this.recomputeAggregateStateFromCategories();
        } else {
          this.state = {
            ...this.state,
            current: 1,
            total: 1,
            status: 'completed',
            isPreempted: false,
            priorityHeadline: undefined,
            priorityItemName: undefined,
          };
          this.notify();
          this.clearPriorityTimer();
          this.priorityCompleteTimer = setTimeout(() => {
            this.priorityCompleteTimer = null;
            if (
              this.state &&
              this.state.id.startsWith('priority-') &&
              this.state.status === 'completed' &&
              this.priorityScopes.size === 0
            ) {
              this.state = null;
              this.notify();
            }
          }, 1500);
        }
      } else {
        this.syncHeadlineAndPriorityFields();
        this.notify();
      }
    }
  }

  /**
   * Ends all active priority scopes immediately and resumes any preempted background syncs.
   */
  public endAllPriorityScopes(): void {
    this.clearPriorityTimer();

    for (const scopeId of this.priorityScopes.keys()) {
      requestScheduler.endInteractiveScope(scopeId);
    }
    this.priorityScopes.clear();
    drainResolverQueue(this.preemptionResolvers);

    if (this.state) {
      if (this.state.id.startsWith('priority-')) {
        const activeCats = this.getActiveCategories();
        if (activeCats.length > 0) {
          this.recomputeAggregateStateFromCategories();
        } else {
          this.state = null;
          this.notify();
        }
      } else {
        this.syncHeadlineAndPriorityFields();
        this.notify();
      }
    }
  }

  /**
   * Convenience wrapper to run an async on-demand user action with automatic background preemption & resume.
   */
  public async runPriorityAction<T>(
    headline: string,
    itemName: string | undefined,
    fn: () => Promise<T>,
    timeoutMs = 12000
  ): Promise<T> {
    const scopeId = this.beginPriorityScope(headline, itemName);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (timeoutMs > 0) {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Priority action "${headline}" timed out after ${timeoutMs}ms`)),
              timeoutMs
            );
          }),
        ]);
      }
      return await fn();
    } finally {
      if (timer) clearTimeout(timer);
      this.endPriorityScope(scopeId);
    }
  }

  public isPriorityPreempted(): boolean {
    return this.priorityScopes.size > 0;
  }

  /**
   * Waits while the job is manually paused by the user OR preempted by an on-demand priority action.
   * Uses `Promise.withResolvers<void>()` and multi-waiter queues so concurrent workers never deadlock.
   */
  private async waitWhilePausedOrPreempted(shouldAbort?: () => boolean): Promise<void> {
    while (
      (this.state?.status === 'paused' || this.priorityScopes.size > 0) &&
      !this.isCancelled &&
      !(shouldAbort && shouldAbort())
    ) {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (this.state?.status === 'paused') {
        this.pauseResolvers.push(resolve);
      } else if (this.priorityScopes.size > 0) {
        this.preemptionResolvers.push(resolve);
      } else {
        break;
      }
      await promise;
    }
  }

  /**
   * Tracks an individual background task (such as a Cover Art lookup, Storefront Library sync, or Achievement sync)
   * so the persistent progress bar reflects all active background work and headlines across page navigation.
   */
  public async trackTask<T>(
    category: SyncCategory,
    itemName: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    this.clearCategoryTimer();

    const existing = this.categoryStats.get(category) || {
      total: 0,
      completed: 0,
      inFlight: 0,
    };
    existing.total += 1;
    existing.inFlight += 1;
    if (itemName) existing.lastItemName = itemName;
    this.categoryStats.set(category, existing);

    this.recomputeAggregateStateFromCategories(category, itemName);

    try {
      return await fn();
    } finally {
      const stat = this.categoryStats.get(category);
      if (stat) {
        stat.inFlight = Math.max(0, stat.inFlight - 1);
        stat.completed = Math.min(stat.total, stat.completed + 1);
      }
      this.recomputeAggregateStateFromCategories(category, itemName);
    }
  }

  private recomputeAggregateStateFromCategories(
    latestCategory?: SyncCategory,
    latestItemName?: string
  ): void {
    // If a primary manual job (like startStoreMediaSync) is actively running, just update its headline/categories
    if (
      this.state &&
      !this.state.id.startsWith('auto-') &&
      !this.state.id.startsWith('priority-') &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      this.syncHeadlineAndPriorityFields();
      this.notify();
      return;
    }

    let total = 0;
    let completed = 0;
    let inFlight = 0;
    let currentItemName = latestItemName;

    for (const stat of this.categoryStats.values()) {
      total += stat.total;
      completed += stat.completed;
      inFlight += stat.inFlight;
      if (
        !currentItemName &&
        stat.lastItemName &&
        (stat.inFlight > 0 || stat.completed < stat.total)
      ) {
        currentItemName = stat.lastItemName;
      }
    }

    if (total === 0) return;

    const activeCats = this.getActiveCategories();
    const primaryCat = activeCats[0] || latestCategory || 'cover_art';
    const headline = buildSyncHeadline(
      activeCats.length > 0 ? activeCats : [primaryCat],
      CATEGORY_SINGLE_HEADLINES[primaryCat]
    );

    if (inFlight > 0 || completed < total) {
      this.clearCategoryTimer();
      this.state = {
        id: this.state?.id.startsWith('auto-') ? this.state.id : `auto-sync-${Date.now()}`,
        type: activeCats.length > 1 ? 'multi' : primaryCat,
        title: headline,
        headline,
        activeCategories: activeCats.map((c) => CATEGORY_SHORT_LABELS[c]),
        activeCategoryKeys: activeCats,
        total,
        current: completed,
        currentItemName,
        status: this.state?.status === 'paused' ? 'paused' : 'running',
        startedAt: this.state?.startedAt || Date.now(),
      };
      this.syncHeadlineAndPriorityFields();
      this.notify();
    } else {
      if (this.state && this.state.id.startsWith('auto-')) {
        this.state = {
          ...this.state,
          current: total,
          total,
          currentItemName: undefined,
          status: 'completed',
        };
        this.syncHeadlineAndPriorityFields();
        this.notify();
      }
      this.clearCategoryTimer();
      this.categoryClearTimer = setTimeout(() => {
        this.categoryClearTimer = null;
        this.categoryStats.clear();
      }, 4500);
    }
  }

  public pauseJob(id: string): void {
    if (!this.state || this.state.id !== id) return;
    if (this.state.status === 'running') {
      this.updateState({ status: 'paused' });
    }
  }

  public resumeJob(id: string): void {
    if (!this.state || this.state.id !== id) return;
    if (this.state.status === 'paused') {
      this.updateState({ status: 'running' });
      drainResolverQueue(this.pauseResolvers);
    }
  }

  public cancelJob(id: string): void {
    if (id.startsWith('priority-') || this.priorityScopes.size > 0) {
      this.endAllPriorityScopes();
      if (id.startsWith('priority-')) return;
    }
    if (!this.state || this.state.id !== id) return;
    this.isCancelled = true;
    this.criticLoopToken++;
    this.mediaSyncLoopToken++;
    this.trophyLoopToken++;
    this.backgroundWarmupEpoch++;
    this.clearCategoryTimer();
    this.clearTrophyTimer();
    this.categoryStats.clear();
    this.updateState({
      status: 'cancelled',
      currentItemName: undefined,
    });
    drainResolverQueue(this.pauseResolvers);
    drainResolverQueue(this.preemptionResolvers);
  }

  /**
   * Resets active job state (useful for cleanup and testing).
   */
  public reset(): void {
    this.isCancelled = true;
    this.criticLoopToken++;
    this.mediaSyncLoopToken++;
    this.trophyLoopToken++;
    this.backgroundWarmupEpoch++;
    this.queuedBackgroundWarmups.clear();
    this.backgroundWarmupChain = Promise.resolve();
    this.clearCategoryTimer();
    this.clearPriorityTimer();
    this.clearTrophyTimer();
    this.categoryStats.clear();
    for (const scopeId of this.priorityScopes.keys()) {
      requestScheduler.endInteractiveScope(scopeId);
    }
    this.priorityScopes.clear();
    drainResolverQueue(this.pauseResolvers);
    drainResolverQueue(this.preemptionResolvers);
    this.state = null;
    this.notify();
  }

  /**
   * Starts a background or user-triggered Critic & Community Review Score sync job.
   * Persists across page navigation, reports headline progress to GlobalSyncProgressBar,
   * and automatically pauses/resumes when preempted by on-demand user actions.
   */
  public async startCriticScoreSync(
    games: CanonicalGame[],
    options?: CriticScoreSyncOptions
  ): Promise<void> {
    const isBackground = Boolean(options?.isBackgroundWarmup || options?.isBackground);

    if (isBackground && !onlineLifecycleManager.isOnline()) {
      return;
    }

    if (isBackground && this.state?.type === 'critic_scores' && this.state?.status === 'running') {
      return;
    }

    if (isBackground && this.hasActiveManualJob()) {
      return;
    }

    if (isBackground) {
      return this.enqueueBackgroundWarmup('critic_scores', () =>
        this.executeCriticScoreSync(games, options, true)
      );
    }

    this.backgroundWarmupEpoch++;
    return this.executeCriticScoreSync(games, options, false);
  }

  private async executeCriticScoreSync(
    games: CanonicalGame[],
    options: CriticScoreSyncOptions | undefined,
    isBackground: boolean
  ): Promise<void> {
    return executeCriticScoreSyncJob(
      {
        getState: () => this.state,
        setState: (next) => {
          this.state = next;
        },
        notify: () => this.notify(),
        syncHeadlineAndPriorityFields: () => this.syncHeadlineAndPriorityFields(),
        hasActiveManualJob: () => this.hasActiveManualJob(),
        getCriticLoopToken: () => this.criticLoopToken,
        getBackgroundWarmupEpoch: () => this.backgroundWarmupEpoch,
        isCancelled: () => this.isCancelled,
        setCancelled: (cancelled) => {
          this.isCancelled = cancelled;
        },
        preemptExistingForManualJob: () => {
          this.mediaSyncLoopToken++;
          this.trophyLoopToken++;
          this.clearTrophyTimer();
          drainResolverQueue(this.pauseResolvers);
        },
        allocateCriticJobHandle: (bg) => {
          const myToken = ++this.criticLoopToken;
          const jobId = bg
            ? `auto-critic-scores-${Date.now()}-${myToken}`
            : `sync-critic-scores-${Date.now()}-${myToken}`;
          return this.createJobHandle('critic_scores', jobId, myToken);
        },
        getCategoryStats: () => this.categoryStats,
        getActiveCategories: () => this.getActiveCategories(),
        recomputeAggregateStateFromCategories: (cat, name) =>
          this.recomputeAggregateStateFromCategories(cat, name),
        waitWhilePausedOrPreempted: (abort) => this.waitWhilePausedOrPreempted(abort),
      },
      games,
      options,
      isBackground
    );
  }

  /**
   * Starts a background store media synchronization job.
   * Runs independently of React component lifecycle so page navigation does not cancel it.
   */
  public async startStoreMediaSync(
    games: CanonicalGame[],
    onGameUpdated: (updated: CanonicalGame) => void,
    options?: StoreMediaSyncOptions
  ): Promise<void> {
    const isBackgroundWarmup = Boolean(options?.isBackgroundWarmup);

    if (isBackgroundWarmup && !onlineLifecycleManager.isOnline()) {
      return;
    }

    if (isBackgroundWarmup && hasActiveMediaSyncCooldown()) {
      return;
    }

    if (
      isBackgroundWarmup &&
      this.state?.type === 'store_media' &&
      this.state?.status === 'running'
    ) {
      return;
    }

    if (isBackgroundWarmup && this.hasActiveManualJob()) {
      return;
    }

    if (isBackgroundWarmup) {
      return this.enqueueBackgroundWarmup('store_media', () =>
        this.executeStoreMediaSync(games, onGameUpdated, options)
      );
    }

    this.backgroundWarmupEpoch++;
    return this.executeStoreMediaSync(games, onGameUpdated, options);
  }

  private async executeStoreMediaSync(
    games: CanonicalGame[],
    onGameUpdated: (updated: CanonicalGame) => void,
    options?: StoreMediaSyncOptions
  ): Promise<void> {
    return executeStoreMediaSyncJob(
      {
        getState: () => this.state,
        setState: (next) => {
          this.state = next;
        },
        notify: () => this.notify(),
        syncHeadlineAndPriorityFields: () => this.syncHeadlineAndPriorityFields(),
        hasActiveManualJob: () => this.hasActiveManualJob(),
        getMediaSyncLoopToken: () => this.mediaSyncLoopToken,
        getBackgroundWarmupEpoch: () => this.backgroundWarmupEpoch,
        isCancelled: () => this.isCancelled,
        setCancelled: (cancelled) => {
          this.isCancelled = cancelled;
        },
        cancelJob: (id) => this.cancelJob(id),
        bumpMediaSyncLoopToken: () => ++this.mediaSyncLoopToken,
        bumpCriticLoopToken: () => {
          this.criticLoopToken++;
          this.trophyLoopToken++;
          this.clearTrophyTimer();
        },
        drainPauseWaiters: () => {
          drainResolverQueue(this.pauseResolvers);
        },
        createMediaJobHandle: (jobId, myToken) =>
          this.createJobHandle('store_media', jobId, myToken),
        waitWhilePausedOrPreempted: (abort) => this.waitWhilePausedOrPreempted(abort),
      },
      games,
      onGameUpdated,
      options
    );
  }

  /**
   * Starts a dedicated cross-storefront Trophy & Achievement synchronization job
   * with live progress reporting in GlobalSyncProgressBar, unified preemption guards,
   * direct interactive scheduler priority, and a dedicated completion timer.
   */
  public async startTrophySync(
    totalSteps: number,
    runner: (
      updateProgress: (current: number, total: number, currentItemName?: string) => void,
      checkCancelled: () => boolean
    ) => Promise<void>
  ): Promise<void> {
    // P0-3: Bump sibling tokens AND backgroundWarmupEpoch, drain any waiting background workers
    this.mediaSyncLoopToken++;
    this.criticLoopToken++;
    this.backgroundWarmupEpoch++;
    const myToken = ++this.trophyLoopToken;
    this.clearTrophyTimer();
    this.isCancelled = false;
    drainResolverQueue(this.pauseResolvers);
    drainResolverQueue(this.preemptionResolvers);

    const jobId = `trophy-sync-${Date.now()}-${myToken}`;
    const handle = this.createJobHandle('achievements', jobId, myToken);
    const safeTotal = Math.max(1, totalSteps);
    const schedulerScopeId = requestScheduler.beginInteractiveScope(`trophy-sync-${myToken}`);

    this.state = {
      id: jobId,
      type: 'achievements',
      title: 'Syncing Storefront Trophies',
      headline: 'Syncing Storefront Trophies',
      activeCategories: [CATEGORY_SHORT_LABELS.achievements],
      activeCategoryKeys: ['achievements'],
      total: safeTotal,
      current: 0,
      status: 'running',
      startedAt: Date.now(),
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();

    try {
      await runner(
        (current, total, currentItemName) => {
          if (this.isCancelled || handle.isStale()) return;
          handle.safeUpdateState({
            current: Math.min(Math.max(0, current), Math.max(1, total)),
            total: Math.max(1, total),
            currentItemName,
          });
        },
        () => this.isCancelled || handle.isStale() || this.state?.status === 'cancelled'
      );

      if (!handle.isStale()) {
        if (this.isCancelled || this.state?.status === 'cancelled') {
          handle.safeUpdateState({
            status: 'cancelled',
            currentItemName: undefined,
          });
        } else {
          handle.safeUpdateState({
            status: 'completed',
            current: this.state?.total ?? safeTotal,
            currentItemName: undefined,
          });
          this.clearTrophyTimer();
          this.trophyCompleteTimer = setTimeout(() => {
            this.trophyCompleteTimer = null;
            if (!handle.isStale() && this.state?.status === 'completed') {
              this.state = null;
              this.notify();
            }
          }, 3000);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : undefined;
      if (!handle.isStale()) {
        handle.safeUpdateState({
          status: 'completed',
          current: this.state?.total ?? safeTotal,
          currentItemName: undefined,
          error: errMsg,
        });
      }
      throw err;
    } finally {
      requestScheduler.endInteractiveScope(schedulerScopeId);
    }
  }
}

export const syncJobManager = new SyncJobManager();
