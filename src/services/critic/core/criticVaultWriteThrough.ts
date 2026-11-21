import type { CriticScoreData } from '../../../contracts/critic';
import { getReviewSourceAuthorityRank } from '../criticUtils';
import {
  type PendingVaultCriticWrite,
  VAULT_WRITE_THROUGH_DEBOUNCE_MS,
} from './criticServiceTypes';

/**
 * Debounced write-through queue syncing resolved critic scores to Electron's SQLite offline vault
 * while preserving monotonic source-authority ordering for coalesced writes.
 */
export class CriticVaultWriteThroughQueue {
  private readonly pending = new Map<string, PendingVaultCriticWrite>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  public schedule(
    gameId: string,
    criticScore: CriticScoreData,
    steamAppId?: number | null,
    canonicalTitle?: string
  ): void {
    if (!gameId || !criticScore || typeof criticScore.score !== 'number' || criticScore.score <= 0) {
      return;
    }
    if (
      typeof window === 'undefined' ||
      typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
    ) {
      return;
    }

    const existing = this.pending.get(gameId);
    if (existing) {
      const existingRank = getReviewSourceAuthorityRank(existing.criticScore);
      const incomingRank = getReviewSourceAuthorityRank(criticScore);
      if (incomingRank < existingRank) {
        return;
      }
    }

    this.pending.set(gameId, {
      gameId,
      steamAppId: typeof steamAppId === 'number' && steamAppId > 0 ? steamAppId : null,
      canonicalTitle: canonicalTitle?.trim() || undefined,
      criticScore,
    });

    if (this.timer !== null) {
      return;
    }

    const handle = setTimeout(() => {
      this.timer = null;
      if (
        typeof window === 'undefined' ||
        typeof window.electronAPI?.offlineVault?.saveGameDetail !== 'function'
      ) {
        this.pending.clear();
        return;
      }
      const batch = Array.from(this.pending.values());
      this.pending.clear();
      for (const item of batch) {
        try {
          void window.electronAPI.offlineVault
            .saveGameDetail({
              gameId: item.gameId,
              steamAppId: item.steamAppId ?? null,
              canonicalTitle: item.canonicalTitle,
              criticScore: { ...item.criticScore },
            })
            ?.catch?.(() => {});
        } catch {}
      }
    }, VAULT_WRITE_THROUGH_DEBOUNCE_MS);
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    this.timer = handle;
  }

  public delete(gameId: string): void {
    if (gameId) {
      this.pending.delete(gameId);
    }
  }

  public clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }
}
