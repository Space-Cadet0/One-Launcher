import { CanonicalGame } from '../../contracts/game';
import { steamMatcher } from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
} from '../steam/fallbackMetadataProvider';
import { getOpenCriticData, criticScoreService } from '../critic/criticScoreService';
import { requestScheduler, RequestPriority } from './requestScheduler';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../storage/userOverrideStorage';
import { loadStagedCache } from '../storage/stagedCacheService';
import { flushPendingCatalogSave } from '../integrations/integrationStorage';

async function yieldToMainThread(): Promise<void> {
  if (
    typeof globalThis !== 'undefined' &&
    'scheduler' in globalThis &&
    typeof (globalThis as any).scheduler?.yield === 'function'
  ) {
    await (globalThis as any).scheduler.yield();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export type SyncCategory =
  | 'storefront_libraries'
  | 'cover_art'
  | 'critic_scores'
  | 'store_media'
  | 'achievements';

export interface SyncJobState {
  id: string;
  type: 'store_media' | 'critic_scores' | 'achievements' | 'cover_art' | 'storefront_libraries' | 'multi';
  title: string;
  headline?: string;
  activeCategories?: string[];
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

interface TrackedCategoryStats {
  total: number;
  completed: number;
  inFlight: number;
  lastItemName?: string;
}

interface PriorityScopeEntry {
  id: string;
  headline: string;
  itemName?: string;
}

const CATEGORY_SHORT_LABELS: Record<SyncCategory, string> = {
  storefront_libraries: 'Storefronts',
  cover_art: 'Cover Art',
  critic_scores: 'Review Scores',
  store_media: 'Store Media',
  achievements: 'Achievements',
};

const CATEGORY_SINGLE_HEADLINES: Record<SyncCategory, string> = {
  storefront_libraries: 'Syncing Storefront Libraries',
  cover_art: 'Syncing Cover Art',
  critic_scores: 'Syncing Review Scores',
  store_media: 'Syncing Official Store Media',
  achievements: 'Syncing Achievements',
};

export class SyncJobManager {
  private state: SyncJobState | null = null;
  private listeners = new Set<(state: SyncJobState | null) => void>();
  private isCancelled = false;
  private pausePromiseResolve: (() => void) | null = null;

  // Multi-category background activity tracking (e.g. Cover Art + Review Scores + Achievements)
  private categoryStats = new Map<SyncCategory, TrackedCategoryStats>();
  private categoryClearTimer: ReturnType<typeof setTimeout> | null = null;

  // On-demand priority preemption scopes (e.g. Fix & Match Wizard, Sync Store Media for single game)
  private priorityScopes = new Map<string, PriorityScopeEntry>();
  private preemptionResolvers: Array<() => void> = [];
  private priorityCompleteTimer: ReturnType<typeof setTimeout> | null = null;

  // Active background critic score loop cancellation token
  private criticLoopToken = 0;

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
      (this.state.status === 'running' || this.state.status === 'paused' || this.state.status === 'rate_limited')
    ) {
      const primaryType = this.state.type;
      if (
        primaryType !== 'multi' &&
        !active.includes(primaryType as SyncCategory)
      ) {
        active.unshift(primaryType as SyncCategory);
      }
    }
    return active;
  }

  private buildHeadline(activeCats: SyncCategory[], fallbackTitle: string): string {
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

  private syncHeadlineAndPriorityFields(): void {
    if (!this.state) return;
    const activeCats = this.getActiveCategories();
    const activeLabels = activeCats.map((c) => CATEGORY_SHORT_LABELS[c]);
    const latestPriority = Array.from(this.priorityScopes.values()).pop();

    this.state.activeCategories = activeLabels;
    this.state.isPreempted = Boolean(latestPriority);
    this.state.priorityHeadline = latestPriority?.headline;
    this.state.priorityItemName = latestPriority?.itemName;

    if (this.state.id.startsWith('priority-') && latestPriority) {
      this.state.id = `priority-${latestPriority.id}`;
      this.state.title = latestPriority.headline;
      this.state.headline = latestPriority.headline;
      this.state.currentItemName = latestPriority.itemName;
    } else if (activeCats.length > 1) {
      this.state.headline = this.buildHeadline(activeCats, this.state.title);
    } else if (activeCats.length === 1 && this.state.id.startsWith('auto-')) {
      const single = this.buildHeadline(activeCats, this.state.title);
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
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }

    const scopeId = requestScheduler.beginInteractiveScope();
    this.priorityScopes.set(scopeId, { id: scopeId, headline, itemName });

    if (!this.state || this.state.status === 'idle' || this.state.status === 'completed' || this.state.status === 'cancelled') {
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
      const resolvers = [...this.preemptionResolvers];
      this.preemptionResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }

    if (this.state) {
      if (this.state.id.startsWith('priority-') && this.priorityScopes.size === 0) {
        // Standalone priority action finished; check if background categories are still active
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
          if (this.priorityCompleteTimer) {
            clearTimeout(this.priorityCompleteTimer);
          }
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
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }

    for (const scopeId of this.priorityScopes.keys()) {
      requestScheduler.endInteractiveScope(scopeId);
    }
    this.priorityScopes.clear();

    const resolvers = [...this.preemptionResolvers];
    this.preemptionResolvers = [];
    for (const r of resolvers) {
      r();
    }

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
   */
  private async waitWhilePausedOrPreempted(): Promise<void> {
    while (
      (this.state?.status === 'paused' || this.priorityScopes.size > 0) &&
      !this.isCancelled
    ) {
      if (this.state?.status === 'paused') {
        await new Promise<void>((resolve) => {
          this.pausePromiseResolve = resolve;
        });
      } else if (this.priorityScopes.size > 0) {
        await new Promise<void>((resolve) => {
          this.preemptionResolvers.push(resolve);
        });
      }
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
    if (this.categoryClearTimer) {
      clearTimeout(this.categoryClearTimer);
      this.categoryClearTimer = null;
    }

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
    const headline = this.buildHeadline(
      activeCats.length > 0 ? activeCats : [primaryCat],
      CATEGORY_SINGLE_HEADLINES[primaryCat]
    );

    if (inFlight > 0 || completed < total) {
      this.state = {
        id: this.state?.id.startsWith('auto-') ? this.state.id : `auto-sync-${Date.now()}`,
        type: activeCats.length > 1 ? 'multi' : primaryCat,
        title: headline,
        headline,
        activeCategories: activeCats.map((c) => CATEGORY_SHORT_LABELS[c]),
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
      this.categoryClearTimer = setTimeout(() => {
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
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
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
    this.categoryStats.clear();
    this.updateState({
      status: 'cancelled',
      currentItemName: undefined,
    });
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    const resolvers = [...this.preemptionResolvers];
    this.preemptionResolvers = [];
    for (const r of resolvers) r();
  }

  /**
   * Resets active job state (useful for cleanup and testing).
   */
  public reset(): void {
    this.isCancelled = true;
    this.criticLoopToken++;
    if (this.categoryClearTimer) {
      clearTimeout(this.categoryClearTimer);
      this.categoryClearTimer = null;
    }
    if (this.priorityCompleteTimer) {
      clearTimeout(this.priorityCompleteTimer);
      this.priorityCompleteTimer = null;
    }
    this.categoryStats.clear();
    for (const scopeId of this.priorityScopes.keys()) {
      requestScheduler.endInteractiveScope(scopeId);
    }
    this.priorityScopes.clear();
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    const resolvers = [...this.preemptionResolvers];
    this.preemptionResolvers = [];
    for (const r of resolvers) r();
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
    options?: { forceRefresh?: boolean; isBackgroundWarmup?: boolean; isBackground?: boolean }
  ): Promise<void> {
    const isBackground = Boolean(options?.isBackgroundWarmup || options?.isBackground);

    if (isBackground && this.state?.type === 'critic_scores' && this.state?.status === 'running') {
      return;
    }

    // If a manual batch job is already running and this is just a passive background warmup, don't overwrite it
    if (
      isBackground &&
      this.state &&
      !this.state.id.startsWith('auto-') &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      return;
    }

    if (options?.forceRefresh) {
      criticScoreService.clearCache();
    }
    criticScoreService.purgeStaleNullScores();

    // Pass skipBackgroundTrigger = true so filtering does NOT fire 393 simultaneous background requests!
    const targetGames = options?.forceRefresh
      ? games
      : games.filter((g) => {
          const targetSteamId = steamMatcher.getEffectiveSteamAppId(g);
          const ov = getUserOverrideForGame(g) as
            | (ReturnType<typeof getUserOverrideForGame> & {
                reviewRoute?: { mode?: 'routed' | 'static' };
              })
            | undefined;
          if (
            ov &&
            (ov.reviewRoute?.mode === 'routed' ||
              (ov.reviewScoreOverride &&
                ov.reviewScoreOverride.source !== 'custom' &&
                ov.reviewRoute?.mode !== 'static'))
          ) {
            const cacheKey = targetSteamId
              ? `id:${targetSteamId}`
              : `title:${g.title.toLowerCase().trim()}`;
            const staged = loadStagedCache(`antigravity_critic_v8_${cacheKey}`, false);
            if (!staged.valid) return true;
          }
          if (isBackground && criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
            return false;
          }
          const score = getOpenCriticData(
            targetSteamId || undefined,
            g.title,
            g.reviewSummary?.positivePercent,
            g.releaseDate,
            undefined,
            false,
            true
          );
          if (isBackground && criticScoreService.hasValidCachedResolution(targetSteamId, g.title)) {
            return false;
          }
          if (criticScoreService.hasAttemptedDynamicResolution(targetSteamId, g.title)) {
            return false;
          }
          if (score && score.score > 0) {
            if (
              score.isSynthetic &&
              (!isBackground || !criticScoreService.hasValidCachedResolution(targetSteamId, g.title))
            ) {
              return true;
            }
            return false;
          }
          return true;
        });

    if (targetGames.length === 0) {
      if (!isBackground) {
        this.state = {
          id: `sync-critic-scores-${Date.now()}`,
          type: 'critic_scores',
          title: 'Syncing Review Scores',
          headline: 'Syncing Review Scores',
          total: 0,
          current: 0,
          status: 'completed',
          startedAt: Date.now(),
        };
        this.notify();
      }
      return;
    }

    const myToken = ++this.criticLoopToken;
    this.isCancelled = false;

    const jobId = isBackground
      ? `auto-critic-scores-${Date.now()}`
      : `sync-critic-scores-${Date.now()}`;

    // Prune any already-finished single-shot categories (e.g. startup achievement check)
    // so they don't pollute the count or currentItemName of this batch sync
    for (const [cat, stat] of this.categoryStats.entries()) {
      if (stat.inFlight === 0 && stat.completed >= stat.total) {
        this.categoryStats.delete(cat);
      }
    }

    this.categoryStats.set('critic_scores', {
      total: targetGames.length,
      completed: 0,
      inFlight: 1,
      lastItemName: targetGames[0]?.title,
    });

    this.state = {
      id: jobId,
      type: 'critic_scores',
      title: 'Syncing Review Scores',
      headline: 'Syncing Review Scores',
      total: targetGames.length,
      current: 0,
      currentItemName: targetGames[0]?.title,
      status: 'running',
      startedAt: Date.now(),
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();

    const chunkSize = isBackground ? 2 : 3;
    let completedCount = 0;

    try {
      for (let i = 0; i < targetGames.length; i += chunkSize) {
        if (this.isCancelled || this.criticLoopToken !== myToken || this.state?.status === 'cancelled') {
          break;
        }

        await this.waitWhilePausedOrPreempted();
        if (this.isCancelled || this.criticLoopToken !== myToken) break;

        const chunk = targetGames.slice(i, i + chunkSize);
        const activeTitles = new Set<string>();
        const firstTitle = chunk[0]?.title;

        const stat = this.categoryStats.get('critic_scores');
        if (stat) {
          stat.completed = completedCount;
          if (firstTitle) stat.lastItemName = firstTitle;
        }

        if (this.state && (this.state.id === jobId || this.state.id.startsWith('auto-'))) {
          const activeCats = this.getActiveCategories();
          if (activeCats.length > 1) {
            this.recomputeAggregateStateFromCategories('critic_scores', firstTitle);
          } else {
            this.updateState({
              current: completedCount,
              total: targetGames.length,
              currentItemName: firstTitle,
            });
          }
        }

        await Promise.all(
          chunk.map(async (game) => {
            if (this.isCancelled || this.criticLoopToken !== myToken) return;
            await this.waitWhilePausedOrPreempted();
            if (this.isCancelled || this.criticLoopToken !== myToken) return;
            if (game.title) {
              activeTitles.add(game.title);
            }
            try {
              let targetSteamId = steamMatcher.getEffectiveSteamAppId(game);
              if (!targetSteamId && !game.isExplicitNonSteam) {
                try {
                  const matchedId = await steamMatcher.matchGameToSteam(game.title, {
                    releaseYear: game.releaseDate,
                    developers: game.developers,
                  });
                  if (matchedId) targetSteamId = matchedId;
                } catch {}
              }
              await criticScoreService.resolveDynamicScore(
                game.title,
                targetSteamId,
                game.releaseDate,
                undefined,
                {
                  bypassAttempted: Boolean(options?.forceRefresh),
                  platforms: game.platforms,
                  gameId: game.id,
                  genres: game.genres,
                }
              );
            } catch {} finally {
              activeTitles.delete(game.title);
              if (!this.isCancelled && this.criticLoopToken === myToken) {
                completedCount = Math.min(targetGames.length, completedCount + 1);
                const nextActiveTitle = activeTitles.values().next().value as string | undefined;
                const nextItemName = nextActiveTitle ?? (stat?.lastItemName || this.state?.currentItemName);
                if (stat) {
                  stat.completed = completedCount;
                  if (nextItemName) stat.lastItemName = nextItemName;
                }
                if (this.state && (this.state.id === jobId || this.state.id.startsWith('auto-'))) {
                  const activeCats = this.getActiveCategories();
                  if (activeCats.length > 1) {
                    this.recomputeAggregateStateFromCategories('critic_scores', nextItemName);
                  } else {
                    this.updateState({
                      current: completedCount,
                      total: targetGames.length,
                      currentItemName: nextItemName,
                    });
                  }
                }
              }
            }
          })
        );

        await yieldToMainThread();

        if (
          isBackground &&
          completedCount < targetGames.length &&
          !this.isCancelled &&
          this.criticLoopToken === myToken &&
          !(typeof process !== 'undefined' && process.env.VITEST)
        ) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      if (this.criticLoopToken !== myToken) return;

      const stat = this.categoryStats.get('critic_scores');
      if (stat) {
        stat.inFlight = 0;
        stat.completed = stat.total;
      }

      if (this.isCancelled || this.state?.status === 'cancelled') {
        this.categoryStats.delete('critic_scores');
        this.updateState({
          status: 'cancelled',
          currentItemName: undefined,
        });
      } else {
        const remainingCats = this.getActiveCategories().filter((c) => c !== 'critic_scores');
        if (remainingCats.length > 0) {
          this.categoryStats.delete('critic_scores');
          this.recomputeAggregateStateFromCategories(remainingCats[0]);
        } else {
          this.categoryStats.delete('critic_scores');
          this.updateState({
            status: 'completed',
            current: targetGames.length,
            total: targetGames.length,
            currentItemName: undefined,
          });
        }
      }
    } finally {
      try {
        flushPendingCatalogSave();
        if (typeof window !== 'undefined') {
          (window as any).electronAPI?.trimMemory?.()?.catch?.(() => {});
        }
      } catch {}
    }
  }

  /**
   * Starts a background store media synchronization job.
   * Runs independently of React component lifecycle so page navigation does not cancel it.
   */
  public async startStoreMediaSync(
    games: CanonicalGame[],
    onGameUpdated: (updated: CanonicalGame) => void
  ): Promise<void> {
    // If a job is already running, cancel the old one first
    if (
      this.state &&
      (this.state.status === 'running' ||
        this.state.status === 'paused' ||
        this.state.status === 'rate_limited')
    ) {
      this.cancelJob(this.state.id);
      // Brief yield to allow clean loop termination
      await new Promise((r) => setTimeout(r, 10));
    }

    const eligibleGames = games.filter((g) => {
      if (steamMatcher.getEffectiveSteamAppId(g)) return true;
      if (g.platforms?.some((p) => p.platformId === 'gog' || p.platformId === 'epic')) return true;
      const ov = getUserOverrideForGame(g);
      const route = inferMetadataRouteFromOverride(ov);
      return Boolean(
        route &&
          route.mode === 'routed' &&
          (route.source === 'steam' || route.source === 'gog' || route.source === 'epic')
      );
    });
    const jobId = `sync-store-media-${Date.now()}`;
    this.isCancelled = false;
    this.pausePromiseResolve = null;

    if (eligibleGames.length === 0) {
      this.state = {
        id: jobId,
        type: 'store_media',
        title: 'Sync Official Store Media',
        headline: 'Sync Official Store Media',
        total: 0,
        current: 0,
        status: 'completed',
        startedAt: Date.now(),
      };
      this.notify();
      return;
    }

    this.state = {
      id: jobId,
      type: 'store_media',
      title: 'Syncing Official Store Media',
      headline: 'Syncing Official Store Media',
      total: eligibleGames.length,
      current: 0,
      currentItemName: eligibleGames[0]?.title,
      status: 'running',
      startedAt: Date.now(),
    };
    this.syncHeadlineAndPriorityFields();
    this.notify();

    try {
      for (let i = 0; i < eligibleGames.length; i++) {
        if (this.isCancelled || this.state.status === 'cancelled') {
          break;
        }

        const game = eligibleGames[i];
        this.updateState({
          current: i,
          currentItemName: game.title,
        });

        // 1. Pause & Priority Preemption handling
        await this.waitWhilePausedOrPreempted();
        if (this.isCancelled) break;

        // 2. Akamai rate limit edge cooldown handling
        if (requestScheduler.isRateLimited('store.steampowered.com')) {
          this.updateState({
            status: 'rate_limited',
            cooldownSecondsRemaining: requestScheduler.getCooldownRemaining('store.steampowered.com'),
          });

          while (requestScheduler.isRateLimited('store.steampowered.com') && !this.isCancelled) {
            await new Promise((r) => setTimeout(r, 1000));
            if (this.state && this.state.status === 'rate_limited') {
              this.updateState({
                cooldownSecondsRemaining: requestScheduler.getCooldownRemaining('store.steampowered.com'),
              });
            }
          }

          if (this.isCancelled) break;

          this.updateState({
            status: 'running',
            cooldownSecondsRemaining: undefined,
          });
        }

        // 3. Perform fetch (respecting Step 4 MetadataSourceRoute)
        const ov = getUserOverrideForGame(game);
        const route = inferMetadataRouteFromOverride(ov);
        const isNonSteamRouted =
          route?.mode === 'routed' && (route.source === 'gog' || route.source === 'epic');
        const targetAppId =
          route?.source === 'steam' && route.steamAppId
            ? route.steamAppId
            : steamMatcher.getEffectiveSteamAppId(game);
        const hasNonSteamPlatform = Boolean(
          game.platforms?.some((p) => p.platformId === 'gog' || p.platformId === 'epic')
        );

        if (isNonSteamRouted || targetAppId || hasNonSteamPlatform) {
          try {
            const refreshed =
              isNonSteamRouted || !targetAppId
                ? await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game, ov)
                : await steamApi.fetchGameMetadata(targetAppId!, RequestPriority.P2_BACKGROUND);

            if (refreshed) {
              if (!isNonSteamRouted && targetAppId && ov && route?.mode === 'routed') {
                updateRoutedMetadataSnapshot(game.id, {
                  title: refreshed.name,
                  shortDescription: refreshed.shortDescription,
                  detailedDescription: refreshed.detailedDescription || refreshed.aboutTheGame,
                  headerImage: refreshed.headerImage,
                  developers: refreshed.developers,
                  publishers: refreshed.publishers,
                  genres: refreshed.genres,
                  tags: refreshed.tags,
                  releaseDate: refreshed.releaseDate,
                });
              }

              const preservePinnedSynopsis = Boolean(ov && (route?.customSynopsisEdited || route?.mode === 'custom'));
              const preservePinnedCover = Boolean(ov?.capsuleImage);
              const validRefreshedShort =
                refreshed.shortDescription &&
                !isGenericPlaceholderSynopsis(refreshed.shortDescription, game.title)
                  ? refreshed.shortDescription
                  : undefined;
              const validRefreshedDevs =
                refreshed.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
              const validRefreshedPubs =
                refreshed.publishers?.filter((p) => p && p !== 'Unknown Publisher') || [];

              const updatedGame: CanonicalGame = {
                ...game,
                steamAppId: isNonSteamRouted ? game.steamAppId : (targetAppId || game.steamAppId),
                enrichedMetadata: refreshed || game.enrichedMetadata,
                headerImage: refreshed.headerImage || game.headerImage,
                capsuleImage: preservePinnedCover
                  ? ov!.capsuleImage!
                  : refreshed.capsuleImage || game.capsuleImage,
                shortDescription: preservePinnedSynopsis
                  ? ov!.shortDescription || game.shortDescription
                  : validRefreshedShort || game.shortDescription,
                detailedDescription:
                  refreshed.detailedDescription ||
                  refreshed.aboutTheGame ||
                  game.detailedDescription,
                developers: validRefreshedDevs.length ? validRefreshedDevs : game.developers,
                publishers: validRefreshedPubs.length ? validRefreshedPubs : game.publishers,
                genres: refreshed.genres?.length ? refreshed.genres : game.genres,
                tags: refreshed.tags?.length ? refreshed.tags : game.tags,
                releaseDate:
                  refreshed.releaseDate && refreshed.releaseDate !== 'TBA'
                    ? refreshed.releaseDate
                    : game.releaseDate,
                reviewSummary: refreshed.reviewSummary || game.reviewSummary,
              };

              onGameUpdated(updatedGame);
            }
          } catch (err: any) {
            if (err?.isRateLimited || err?.status === 429 || err?.response?.status === 429) {
              // Trigger rate limited state and retry this game
              i--;
              await yieldToMainThread();
              continue;
            }
            console.warn(`[SyncJobManager] Media sync error for ${game.title}:`, err?.message || err);
          }
        }

        this.updateState({
          current: i + 1,
        });
        await yieldToMainThread();
      }

      if (this.isCancelled || this.state?.status === 'cancelled') {
        this.updateState({
          status: 'cancelled',
          currentItemName: undefined,
        });
      } else {
        this.updateState({
          status: 'completed',
          current: eligibleGames.length,
          currentItemName: undefined,
        });
      }
    } finally {
      try {
        flushPendingCatalogSave();
        steamApi.trimMemoryCache(30);
        if (typeof window !== 'undefined') {
          (window as any).electronAPI?.trimMemory?.()?.catch?.(() => {});
        }
      } catch {}
    }
  }

  /**
   * Starts a dedicated cross-storefront Trophy & Achievement synchronization job
   * with live progress reporting in GlobalSyncProgressBar.
   */
  public async startTrophySync(
    totalSteps: number,
    runner: (
      updateProgress: (current: number, total: number, currentItemName?: string) => void,
      checkCancelled: () => boolean
    ) => Promise<void>
  ): Promise<void> {
    this.isCancelled = false;
    const jobId = `trophy-sync-${Date.now()}`;
    const safeTotal = Math.max(1, totalSteps);

    this.state = {
      id: jobId,
      type: 'achievements',
      title: 'Syncing Storefront Trophies',
      headline: 'Syncing Storefront Trophies',
      activeCategories: [CATEGORY_SHORT_LABELS.achievements],
      total: safeTotal,
      current: 0,
      status: 'running',
      startedAt: Date.now(),
    };
    this.notify();

    try {
      await runner(
        (current, total, currentItemName) => {
          if (this.isCancelled || !this.state || this.state.id !== jobId) return;
          this.updateState({
            current: Math.min(Math.max(0, current), Math.max(1, total)),
            total: Math.max(1, total),
            currentItemName,
          });
        },
        () => this.isCancelled || this.state?.status === 'cancelled'
      );

      if (this.state && this.state.id === jobId) {
        if (this.isCancelled || this.state.status === 'cancelled') {
          this.updateState({
            status: 'cancelled',
            currentItemName: undefined,
          });
        } else {
          this.updateState({
            status: 'completed',
            current: this.state.total,
            currentItemName: undefined,
          });
          if (this.priorityCompleteTimer) clearTimeout(this.priorityCompleteTimer);
          this.priorityCompleteTimer = setTimeout(() => {
            if (this.state && this.state.id === jobId && this.state.status === 'completed') {
              this.state = null;
              this.notify();
            }
          }, 3000);
        }
      }
    } catch (err: any) {
      if (this.state && this.state.id === jobId) {
        this.updateState({
          status: 'completed',
          current: this.state.total,
          currentItemName: undefined,
          error: err?.message,
        });
      }
      throw err;
    }
  }
}

export const syncJobManager = new SyncJobManager();
