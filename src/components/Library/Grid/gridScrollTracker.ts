import {
  markScrollActivity,
  isUserActivelyScrolling,
} from '../../../utils/scrollActivityTracker';

let unmountedImageCount = 0;
let throttlePruneTimer: ReturnType<typeof setTimeout> | null = null;
let idlePruneTimer1: ReturnType<typeof setTimeout> | null = null;
let idlePruneTimer2: ReturnType<typeof setTimeout> | null = null;
let lastPruneTimestamp = 0;

let isFastScrolling = false;
let fastScrollCalmTimer: ReturnType<typeof setTimeout> | null = null;
const pendingFastScrollMountFns = new Set<() => void>();
const scrollWindowState = new Map<
  string,
  { lastPos: number; windowTime: number; windowPos: number }
>();

export function isCurrentlyFastScrolling(): boolean {
  return isFastScrolling;
}

export function addPendingFastScrollMount(fn: () => void): void {
  pendingFastScrollMountFns.add(fn);
}

export function removePendingFastScrollMount(fn: () => void): void {
  pendingFastScrollMountFns.delete(fn);
}

function flushFastScrollMountFns(): void {
  fastScrollCalmTimer = null;
  isFastScrolling = false;
  const fns = Array.from(pendingFastScrollMountFns);
  pendingFastScrollMountFns.clear();
  for (const fn of fns) {
    fn();
  }
}

export function recordScrollActivity(scrollTop: number, sourceKey: string = 'main'): void {
  if (typeof window === 'undefined') return;
  markScrollActivity();
  const now = Date.now();
  const prev = scrollWindowState.get(sourceKey);
  if (!prev) {
    const stepDelta = Math.abs(scrollTop);
    scrollWindowState.set(sourceKey, {
      lastPos: scrollTop,
      windowTime: now,
      windowPos: scrollTop,
    });
    if (stepDelta > 300) {
      isFastScrolling = true;
      if (fastScrollCalmTimer) clearTimeout(fastScrollCalmTimer);
      fastScrollCalmTimer = setTimeout(flushFastScrollMountFns, 120);
    }
  } else {
    const stepDelta = Math.abs(scrollTop - prev.lastPos);
    const windowElapsed = now - prev.windowTime;
    const windowDist = Math.abs(scrollTop - prev.windowPos);
    prev.lastPos = scrollTop;

    if (stepDelta > 300 || (windowDist > 300 && windowElapsed <= 150)) {
      isFastScrolling = true;
      if (fastScrollCalmTimer) clearTimeout(fastScrollCalmTimer);
      fastScrollCalmTimer = setTimeout(flushFastScrollMountFns, 120);
    }
    if (windowElapsed >= 100 || windowDist > 300) {
      prev.windowTime = now;
      prev.windowPos = scrollTop;
    }
  }
  scheduleScrollIdleMemoryTrim();
}

export function notifyImageUnmounted(): void {
  if (typeof window === 'undefined') return;
  unmountedImageCount++;
  if (unmountedImageCount >= 36 && !throttlePruneTimer) {
    throttlePruneTimer = setTimeout(() => {
      throttlePruneTimer = null;
      scheduleScrollIdleMemoryTrim();
    }, 1000);
  }
}

export function scheduleScrollIdleMemoryTrim(): void {
  if (typeof window === 'undefined') return;
  if (idlePruneTimer1) clearTimeout(idlePruneTimer1);
  if (idlePruneTimer2) {
    clearTimeout(idlePruneTimer2);
    idlePruneTimer2 = null;
  }

  // Deep-idle passive buffer trim only after 20s of complete scroll inactivity;
  // NEVER call webFrame.clearCache() or synchronous globalThis.gc() during or shortly after scrolling!
  idlePruneTimer1 = setTimeout(() => {
    idlePruneTimer1 = null;
    if (isUserActivelyScrolling() || isCurrentlyFastScrolling()) {
      scheduleScrollIdleMemoryTrim();
      return;
    }
    if (unmountedImageCount > 0 && Date.now() - lastPruneTimestamp >= 20000) {
      unmountedImageCount = 0;
      lastPruneTimestamp = Date.now();
      window.electronAPI?.trimMemory?.({ passive: true });
    }
  }, 20000);
}
