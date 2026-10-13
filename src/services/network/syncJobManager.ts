import { CanonicalGame } from '../../contracts/game';
import { steamMatcher } from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import { requestScheduler, RequestPriority } from './requestScheduler';

export interface SyncJobState {
  id: string;
  type: 'store_media' | 'critic_scores' | 'achievements';
  title: string;
  total: number;
  current: number;
  currentItemName?: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'rate_limited';
  cooldownSecondsRemaining?: number;
  startedAt?: number;
  error?: string;
}

export class SyncJobManager {
  private state: SyncJobState | null = null;
  private listeners = new Set<(state: SyncJobState | null) => void>();
  private isCancelled = false;
  private pausePromiseResolve: (() => void) | null = null;

  public getState(): SyncJobState | null {
    return this.state ? { ...this.state } : null;
  }

  public subscribe(listener: (state: SyncJobState | null) => void): () => void {
    this.listeners.add(listener);
    // Notify immediately with current state
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
    this.notify();
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
    if (!this.state || this.state.id !== id) return;
    this.isCancelled = true;
    this.updateState({
      status: 'cancelled',
      currentItemName: undefined,
    });
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
  }

  /**
   * Resets active job state (useful for cleanup and testing).
   */
  public reset(): void {
    this.isCancelled = true;
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
    this.state = null;
    this.notify();
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

    const eligibleGames = games.filter((g) => Boolean(steamMatcher.getEffectiveSteamAppId(g)));
    const jobId = `sync-store-media-${Date.now()}`;
    this.isCancelled = false;
    this.pausePromiseResolve = null;

    if (eligibleGames.length === 0) {
      this.state = {
        id: jobId,
        type: 'store_media',
        title: 'Sync Official Store Media',
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
      total: eligibleGames.length,
      current: 0,
      currentItemName: eligibleGames[0]?.title,
      status: 'running',
      startedAt: Date.now(),
    };
    this.notify();

    for (let i = 0; i < eligibleGames.length; i++) {
      if (this.isCancelled || this.state.status === 'cancelled') {
        break;
      }

      const game = eligibleGames[i];
      this.updateState({
        current: i,
        currentItemName: game.title,
      });

      // 1. Pause handling
      while (this.state.status === 'paused' && !this.isCancelled) {
        await new Promise<void>((resolve) => {
          this.pausePromiseResolve = resolve;
        });
      }
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

      // 3. Perform fetch
      const targetAppId = steamMatcher.getEffectiveSteamAppId(game);
      if (targetAppId) {
        try {
          const refreshed = await steamApi.fetchGameMetadata(
            targetAppId,
            RequestPriority.P2_BACKGROUND
          );

          if (refreshed) {
            const updatedGame: CanonicalGame = {
              ...game,
              steamAppId: targetAppId,
              enrichedMetadata: refreshed || game.enrichedMetadata,
              headerImage: refreshed.headerImage || game.headerImage,
              capsuleImage: refreshed.capsuleImage || game.capsuleImage,
              shortDescription: refreshed.shortDescription || game.shortDescription,
              developers: refreshed.developers?.length ? refreshed.developers : game.developers,
              publishers: refreshed.publishers?.length ? refreshed.publishers : game.publishers,
              genres: refreshed.genres?.length ? refreshed.genres : game.genres,
              tags: refreshed.tags?.length ? refreshed.tags : game.tags,
              reviewSummary: refreshed.reviewSummary || game.reviewSummary,
            };

            onGameUpdated(updatedGame);
          }
        } catch (err: any) {
          if (err?.isRateLimited || err?.status === 429 || err?.response?.status === 429) {
            // Trigger rate limited state and retry this game
            i--;
            continue;
          }
          console.warn(`[SyncJobManager] Media sync error for ${game.title}:`, err?.message || err);
        }
      }

      this.updateState({
        current: i + 1,
      });
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
  }
}

export const syncJobManager = new SyncJobManager();
