/**
 * Universal scroll-activity & main-thread yielding coordinator.
 *
 * Ensures background catalog persistence, media match reconciliation, and
 * background warmup loops yield cleanly whenever the user is scrolling ANY
 * scrollable container in the application (grid, sidebar, store page, or modals).
 */

const SCROLL_ACTIVE_SETTLE_MS = 220;

let activeScrolling = false;
let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
const idleCallbacks = new Set<() => void>();

export function markScrollActivity(): void {
  if (typeof window === 'undefined') return;
  activeScrolling = true;
  if (scrollSettleTimer) {
    clearTimeout(scrollSettleTimer);
  }
  scrollSettleTimer = setTimeout(() => {
    scrollSettleTimer = null;
    activeScrolling = false;
    if (idleCallbacks.size > 0) {
      const pending = Array.from(idleCallbacks);
      idleCallbacks.clear();
      for (const cb of pending) {
        try {
          cb();
        } catch {}
      }
    }
  }, SCROLL_ACTIVE_SETTLE_MS);
}

export function isUserActivelyScrolling(): boolean {
  return activeScrolling;
}

export function onScrollIdle(callback: () => void): () => void {
  if (!activeScrolling) {
    callback();
    return () => {};
  }
  idleCallbacks.add(callback);
  return () => {
    idleCallbacks.delete(callback);
  };
}

export function waitUntilScrollIdle(maxWaitMs: number = 1500): Promise<void> {
  if (!activeScrolling || typeof window === 'undefined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      idleCallbacks.delete(finish);
      resolve();
    };
    const safetyTimer = setTimeout(finish, maxWaitMs);
    idleCallbacks.add(finish);
  });
}

/**
 * Yields to the browser main thread using modern `scheduler.yield()` so task
 * continuations stay responsive without starving input/scroll frames, falling
 * back to `setTimeout(..., 0)` when unavailable.
 */
interface GlobalWithScheduler {
  scheduler?: {
    yield?: () => Promise<void>;
  };
}

export async function yieldToMainThread(): Promise<void> {
  const g = globalThis as unknown as GlobalWithScheduler;
  if (g.scheduler && typeof g.scheduler.yield === 'function') {
    try {
      await g.scheduler.yield();
      return;
    } catch {
      // Fall back to macrotask yield below
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
