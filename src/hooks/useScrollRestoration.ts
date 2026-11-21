import { useEffect, type RefObject } from 'react';

export interface UseScrollRestorationOptions {
  containerRef: RefObject<HTMLElement | null>;
  navigationEntryId: string;
  targetScrollY: number;
  maxAttempts?: number;
}

/**
 * Restores vertical scroll position for the active navigation entry across both
 * the main scroll container and its immediate scrollable child, cleanly cancelling
 * all pending requestAnimationFrame handles and fallback timers on entry change or unmount.
 */
export function useScrollRestoration({
  containerRef,
  navigationEntryId,
  targetScrollY,
  maxAttempts = 10,
}: UseScrollRestorationOptions): void {
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let pendingRafId: number | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const hasRaf =
      typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';

    const cancelPendingRaf = () => {
      if (pendingRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingRafId);
        pendingRafId = null;
      }
    };

    const scheduleRafAttempt = () => {
      if (cancelled || !hasRaf) return;
      cancelPendingRaf();
      pendingRafId = requestAnimationFrame(() => {
        pendingRafId = null;
        applyScroll();
      });
    };

    const applyScroll = () => {
      if (cancelled) return;
      const container = containerRef.current;
      if (!container) return;

      container.scrollTop = targetScrollY;
      const child = container.firstElementChild as HTMLElement | null;
      if (child && child.scrollHeight > child.clientHeight) {
        child.scrollTop = targetScrollY;
      }

      attempts += 1;
      const currentY = container.scrollTop || child?.scrollTop || 0;
      if (targetScrollY > 0 && Math.abs(currentY - targetScrollY) > 5 && attempts < maxAttempts) {
        scheduleRafAttempt();
      }
    };

    applyScroll();
    if (!cancelled && targetScrollY > 0 && attempts < maxAttempts) {
      scheduleRafAttempt();
    }

    for (const delayMs of [30, 80, 150]) {
      timers.push(
        setTimeout(() => {
          if (!cancelled) {
            applyScroll();
          }
        }, delayMs)
      );
    }

    return () => {
      cancelled = true;
      cancelPendingRaf();
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [containerRef, navigationEntryId, targetScrollY, maxAttempts]);
}
