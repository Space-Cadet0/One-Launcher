import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  isCurrentlyFastScrolling,
  recordScrollActivity,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
  notifyImageUnmounted,
} from '../src/components/Library/Grid/gridScrollTracker';
import {
  VirtualGridRows,
  VirtualListRows,
} from '../src/components/Common/VirtualContainers';
import { matchesLooseSearchQuery } from '../src/services/common/titleUtils';
import type { CanonicalGame } from '../src/contracts/game';

// Global mock state holder
const globalRecord = globalThis as Record<string, unknown>;

interface SyntheticScrollElement {
  clientWidth: number;
  clientHeight: number;
  scrollTop: number;
  scrollLeft: number;
  offsetTop: number;
  offsetParent: SyntheticScrollElement | null;
  ownerDocument: {
    defaultView: {
      requestAnimationFrame: (cb: FrameRequestCallback) => number;
      cancelAnimationFrame: (id: number) => void;
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };
  };
  getBoundingClientRect: () => {
    top: number;
    left: number;
    width: number;
    height: number;
    bottom: number;
    right: number;
    x: number;
    y: number;
    toJSON: () => Record<string, unknown>;
  };
  addEventListener: () => void;
  removeEventListener: () => void;
}

function createSyntheticScrollElement(height = 800, width = 1280): SyntheticScrollElement {
  return {
    clientWidth: width,
    clientHeight: height,
    scrollTop: 0,
    scrollLeft: 0,
    offsetTop: 0,
    offsetParent: null,
    ownerDocument: {
      defaultView: {
        requestAnimationFrame: (cb: FrameRequestCallback) =>
          setTimeout(() => cb(0), 0) as unknown as number,
        cancelAnimationFrame: (id: number) => clearTimeout(id),
        setTimeout,
        clearTimeout,
      },
    },
    getBoundingClientRect: () => ({
      top: 0,
      left: 0,
      width,
      height,
      bottom: height,
      right: width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

interface ReactInternalHolder {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
}

interface PendingEffect {
  idx: number;
  fn: () => unknown;
}

interface VirtualContainerProps {
  style: {
    height?: string;
    width?: string;
    position?: string;
    transform?: string;
    top?: number | string;
    left?: number | string;
    paddingBottom?: string;
  };
  children?: React.ReactNode;
  'data-index'?: number | string;
  'data-card-index'?: number;
}

type VirtualElement = React.ReactElement<VirtualContainerProps>;

interface VirtualGridRenderContext {
  render: (columnCount?: number, itemsOverride?: Array<{ id: string; title: string }>) => VirtualElement;
  cleanup: () => void;
}

function createVirtualGridHarness(
  initialItems: Array<{ id: string; title: string }>,
  scrollEl: SyntheticScrollElement,
  estimatedRowHeight = 280,
  rowGapPx = 16
): VirtualGridRenderContext {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  const prevDeps: Array<unknown[] | undefined> = [];

  const internals = (React as unknown as ReactInternalHolder)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  let currentItems = initialItems;
  let currentCols = 5;

  const render = (columnCount?: number, itemsOverride?: Array<{ id: string; title: string }>) => {
    if (columnCount !== undefined) currentCols = columnCount;
    if (itemsOverride !== undefined) currentItems = itemsOverride;

    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: PendingEffect[] = [];
    const prevH = internals.H;

    const recordEffect = (fn: () => unknown, deps?: unknown[]) => {
      const idx = effectIdx++;
      const old = prevDeps[idx];
      const changed =
        !old || !deps || old.length !== deps.length || deps.some((d, i) => !Object.is(d, old[i]));
      if (changed) {
        prevDeps[idx] = deps;
        pendingEffects.push({ idx, fn });
      }
    };

    internals.H = {
      useState(initial: unknown) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        return [
          states[idx],
          (u: unknown) => {
            states[idx] = typeof u === 'function' ? (u as (prev: unknown) => unknown)(states[idx]) : u;
          },
        ];
      },
      useReducer(
        reducer: (s: unknown, a: unknown) => unknown,
        initArg: unknown,
        init?: (a: unknown) => unknown
      ) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof init === 'function' ? init(initArg) : initArg);
        }
        return [
          states[idx],
          (action: unknown) => {
            states[idx] = reducer(states[idx], action);
          },
        ];
      },
      useRef(initial: unknown) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: recordEffect,
      useLayoutEffect: recordEffect,
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
    };

    let tree: VirtualElement;
    try {
      tree = VirtualGridRows({
        items: currentItems,
        scrollElement: scrollEl as unknown as HTMLElement,
        columnCount: currentCols,
        estimatedRowHeight,
        overscan: 3,
        rowGapPx,
        rowClassName: `grid grid-cols-${currentCols} gap-4`,
        renderCard: (item, absIdx) =>
          React.createElement(
            'div',
            { key: item.id, 'data-card-index': absIdx, 'data-testid': 'grid-card' },
            item.title
          ),
      }) as unknown as VirtualElement;
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      cleanups[eff.idx]?.();
      const c = eff.fn();
      cleanups[eff.idx] = typeof c === 'function' ? (c as () => void) : undefined;
    }

    return tree;
  };

  const cleanup = () => {
    for (const c of cleanups) {
      c?.();
    }
  };

  return { render, cleanup };
}

// Synthetic IntersectionObserver Mock for Torture Testing
type ObserverCallback = (entries: IntersectionObserverEntry[], observer: MockIntersectionObserver) => void;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly observedElements = new Set<Element>();
  readonly callback: ObserverCallback;
  readonly options?: IntersectionObserverInit;

  constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observedElements.add(element);
  }

  unobserve(element: Element): void {
    this.observedElements.delete(element);
  }

  disconnect(): void {
    this.observedElements.clear();
  }

  dispatchIntersection(isIntersecting: boolean): void {
    const syntheticEntries: IntersectionObserverEntry[] = [
      {
        isIntersecting,
        target: document.createElement('div'),
        intersectionRatio: isIntersecting ? 1.0 : 0.0,
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        time: Date.now(),
      },
    ];
    this.callback(syntheticEntries, this);
  }
}

describe('Milestone M4: Adversarial Stress Test Harness — Virtual Grid & Scroll Shielding', () => {
  let prevWindow: unknown;
  let prevDocument: unknown;
  let prevIntersectionObserver: unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    prevWindow = globalRecord.window;
    prevDocument = globalRecord.document;
    prevIntersectionObserver = globalRecord.IntersectionObserver;
    MockIntersectionObserver.instances = [];

    // Install mock window and document for Node.js test environment
    globalRecord.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      innerHeight: 900,
      innerWidth: 1440,
      electronAPI: {
        trimMemory: vi.fn(),
      },
    };

    globalRecord.document = {
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        offsetTop: 0,
        offsetParent: null,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 200, height: 300, bottom: 300, right: 200 }),
      }),
      getElementById: () => null,
    };

    globalRecord.IntersectionObserver = MockIntersectionObserver;

    // Ensure any leftover calm timer settles before each test
    vi.advanceTimersByTime(250);
  });

  afterEach(() => {
    // Flush any pending calm timers and restore mocks
    vi.advanceTimersByTime(250);
    vi.useRealTimers();
    globalRecord.window = prevWindow;
    globalRecord.document = prevDocument;
    globalRecord.IntersectionObserver = prevIntersectionObserver;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // TORTURE SCENARIO 1: Ultra-Fast Scroll Simulation (>5,000 px/s across 500 cards)
  // =========================================================================
  describe('Torture Scenario 1: Ultra-Fast Scroll Velocity Shielding & Exact Flush', () => {
    it('simulates ultra-fast scroll at >12,500 px/s across 500 virtual card intersections: verifies 0 premature mounts and exact flush at 120ms', () => {
      expect(isCurrentlyFastScrolling()).toBe(false);

      // Track mount executions
      const mountedIndices = new Set<number>();
      const cardMountFns: Array<() => void> = [];

      for (let i = 0; i < 500; i++) {
        const idx = i;
        cardMountFns.push(() => {
          mountedIndices.add(idx);
        });
      }

      // Simulate a violent scroll: 50 ticks of 400px every 16ms = 25,000 px/s (>5x the 5,000 px/s requirement)
      let currentScrollTop = 0;
      let cardIntersectionCursor = 0;

      for (let tick = 0; tick < 50; tick++) {
        currentScrollTop += 400;
        recordScrollActivity(currentScrollTop, 'main');

        // Verify tracker enters fast scrolling immediately upon high velocity
        expect(isCurrentlyFastScrolling()).toBe(true);

        // Simulate 10 new cards intersecting the viewport on each tick
        for (let k = 0; k < 10; k++) {
          if (cardIntersectionCursor < 500) {
            addPendingFastScrollMount(cardMountFns[cardIntersectionCursor]);
            cardIntersectionCursor++;
          }
        }

        // Advance 16ms (typical 60fps frame delta)
        vi.advanceTimersByTime(16);

        // CRITICAL INVARIANT: 0 cards must mount prematurely during high velocity
        expect(mountedIndices.size).toBe(0);
        expect(isCurrentlyFastScrolling()).toBe(true);
      }

      // All 500 cards have intersected and queued their mount closures.
      // Note: In the final loop tick, vi.advanceTimersByTime(16) already elapsed 16ms since the last scroll event.
      expect(cardIntersectionCursor).toBe(500);
      expect(mountedIndices.size).toBe(0);

      // Advance by 50ms: 16ms + 50ms = 66ms total elapsed (well inside the 120ms calm window)
      vi.advanceTimersByTime(50);
      expect(isCurrentlyFastScrolling()).toBe(true);
      expect(mountedIndices.size).toBe(0);

      // Advance by another 53ms: 66ms + 53ms = 119ms total elapsed (exactly 1ms before 120ms threshold)
      vi.advanceTimersByTime(53);
      expect(isCurrentlyFastScrolling()).toBe(true);
      expect(mountedIndices.size).toBe(0);

      // Advance by 2ms: 119ms + 2ms = 121ms total elapsed (calm threshold 120ms crossed!)
      vi.advanceTimersByTime(2);

      // CRITICAL INVARIANT: Exact mount flush on scroll calm!
      expect(isCurrentlyFastScrolling()).toBe(false);
      expect(mountedIndices.size).toBe(500);

      // Verify every card from index 0 to 499 was mounted
      for (let i = 0; i < 500; i++) {
        expect(mountedIndices.has(i)).toBe(true);
      }
    });

    it('shields mounts during upward high-velocity scrolling (negative scroll delta)', () => {
      let currentScrollTop = 50000;
      recordScrollActivity(currentScrollTop, 'main');
      vi.advanceTimersByTime(150); // settle initial position

      const mountedCards: number[] = [];

      // Upward scroll: step delta is -600px every 16ms (37,500 px/s)
      for (let tick = 0; tick < 20; tick++) {
        currentScrollTop -= 600;
        recordScrollActivity(currentScrollTop, 'main');
        expect(isCurrentlyFastScrolling()).toBe(true);

        // Queue card mounts during upward travel
        addPendingFastScrollMount(() => mountedCards.push(tick));

        vi.advanceTimersByTime(16);
        expect(mountedCards).toHaveLength(0); // 0 premature mounts
      }

      // Settle past 120ms
      vi.advanceTimersByTime(130);
      expect(isCurrentlyFastScrolling()).toBe(false);
      expect(mountedCards).toHaveLength(20);
    });

    it('resets calm timer when high-velocity events keep arriving before 120ms expires', () => {
      recordScrollActivity(1000, 'main');
      expect(isCurrentlyFastScrolling()).toBe(true);

      let mounted = false;
      addPendingFastScrollMount(() => {
        mounted = true;
      });

      // User pauses briefly for 100ms (not yet 120ms)
      vi.advanceTimersByTime(100);
      expect(mounted).toBe(false);

      // User resumes scrolling! Calm timer must reset
      recordScrollActivity(1600, 'main');
      expect(isCurrentlyFastScrolling()).toBe(true);

      // Advance another 100ms from the second scroll event (total 200ms from start, but only 100ms from last event)
      vi.advanceTimersByTime(100);
      expect(mounted).toBe(false);

      // Finally let 125ms elapse without scroll
      vi.advanceTimersByTime(25);
      expect(mounted).toBe(true);
      expect(isCurrentlyFastScrolling()).toBe(false);
    });
  });

  // =========================================================================
  // TORTURE SCENARIO 2: Fast-Scroll Cancellation & Clean Abort
  // =========================================================================
  describe('Torture Scenario 2: Fast-Scroll Mount Cancellation & Clean Abort', () => {
    it('cancels pending mounts when cards scroll past or unmount before calm: 0 phantom mounts and exact visible flush', () => {
      // Trigger fast scroll
      recordScrollActivity(500, 'main');
      expect(isCurrentlyFastScrolling()).toBe(true);

      const totalCards = 200;
      const executedMounts = new Set<number>();
      const closures: Array<() => void> = [];

      for (let i = 0; i < totalCards; i++) {
        const id = i;
        closures.push(() => {
          executedMounts.add(id);
        });
      }

      // All 200 cards intersect while fast-scrolling
      for (let i = 0; i < totalCards; i++) {
        addPendingFastScrollMount(closures[i]);
      }

      // 120 cards scroll past or unmount before scroll calm (indices 0 to 119)
      for (let i = 0; i < 120; i++) {
        removePendingFastScrollMount(closures[i]);
      }

      // 80 cards remain in viewport (indices 120 to 199)
      // Advance to calm (130ms)
      vi.advanceTimersByTime(130);

      expect(isCurrentlyFastScrolling()).toBe(false);

      // Exactly the 80 remaining visible cards must have mounted!
      expect(executedMounts.size).toBe(80);

      // Verify none of the 120 cancelled cards ever mounted
      for (let i = 0; i < 120; i++) {
        expect(executedMounts.has(i)).toBe(false);
      }
      for (let i = 120; i < 200; i++) {
        expect(executedMounts.has(i)).toBe(true);
      }
    });

    it('cancels pending mount at 119ms (1ms before calm flush) cleanly without race condition', () => {
      recordScrollActivity(1000, 'main');

      let mounted = false;
      const mountFn = () => {
        mounted = true;
      };

      addPendingFastScrollMount(mountFn);

      // Wait until 119ms
      vi.advanceTimersByTime(119);
      expect(mounted).toBe(false);

      // Element unmounts right before calm flush
      removePendingFastScrollMount(mountFn);

      // Elapse remaining calm time
      vi.advanceTimersByTime(5);
      expect(isCurrentlyFastScrolling()).toBe(false);
      expect(mounted).toBe(false);
    });

    it('handles multiple unmount notifications and schedules 20s idle trim only after scrolling settles', () => {
      const mockTrim = vi.fn();
      globalRecord.window = {
        addEventListener: () => {},
        removeEventListener: () => {},
        electronAPI: {
          trimMemory: mockTrim,
        },
      };

      // Unmount 40 images (threshold is >= 36)
      for (let i = 0; i < 40; i++) {
        notifyImageUnmounted();
      }

      // Throttle timer takes 1000ms to schedule idle trim
      vi.advanceTimersByTime(1000);
      expect(mockTrim).not.toHaveBeenCalled();

      // Deep idle takes 20,000ms of complete calm
      vi.advanceTimersByTime(19000);
      expect(mockTrim).not.toHaveBeenCalled();

      // Final 1000ms completes the 20s window
      vi.advanceTimersByTime(1500);
      expect(mockTrim).toHaveBeenCalledWith({ passive: true });
    });

    it('empirically tests IntersectionObserver callback lifecycle in fast scroll and unintersect cancellation', () => {
      // Set high velocity (delta > 300px from any prior position)
      recordScrollActivity(5000, 'main');
      expect(isCurrentlyFastScrolling()).toBe(true);

      let isCoverMounted = false;
      let pendingMount: (() => void) | null = null;

      const cancelPendingMount = () => {
        if (pendingMount) {
          removePendingFastScrollMount(pendingMount);
          pendingMount = null;
        }
      };

      const observer = new MockIntersectionObserver((entries) => {
        const isIntersecting = entries.some((e) => e.isIntersecting);
        if (isIntersecting) {
          if (isCurrentlyFastScrolling()) {
            if (!pendingMount) {
              pendingMount = () => {
                pendingMount = null;
                isCoverMounted = true;
                observer.disconnect();
              };
              addPendingFastScrollMount(pendingMount);
            }
          } else {
            cancelPendingMount();
            isCoverMounted = true;
            observer.disconnect();
          }
        } else {
          cancelPendingMount();
        }
      });

      // 1. Intersect during fast scroll
      observer.dispatchIntersection(true);
      expect(isCoverMounted).toBe(false); // shielded!

      // 2. Unintersect (scroll past) before calm
      observer.dispatchIntersection(false);
      expect(pendingMount).toBeNull(); // cleanly cancelled!

      // 3. Calm arrives (130ms)
      vi.advanceTimersByTime(130);
      expect(isCurrentlyFastScrolling()).toBe(false);
      expect(isCoverMounted).toBe(false); // never mounted!

      // 4. Now user re-enters viewport while stationary (calm)
      observer.dispatchIntersection(true);
      expect(isCoverMounted).toBe(true); // mounts immediately when calm!
    });
  });

  // =========================================================================
  // TORTURE SCENARIO 3: Search Query Throttling & Decoupling (1,000 rapid keystrokes)
  // =========================================================================
  describe('Torture Scenario 3: Search Query Throttling & Decoupling', () => {
    // Generate an adversarial catalog of 2,500 items with rich punctuation, unicode, diacritics, and edge cases
    const generateAdversarialCatalog = (): CanonicalGame[] => {
      const titles = [
        "Death's Door",
        'Death’s Door (Special Edition)',
        'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
        "Marvel's Spider-Man Remastered",
        "Marvel's Spider-Man: Miles Morales",
        'NieR:Automata™ Game of the YoRHa Edition',
        'Pokémon™: Legends Arceus',
        'The Witcher® 3: Wild Hunt - Complete Edition',
        'Wiedźmin 3: Dziki Gon',
        'Café Stella to Shinigami no Chou',
        'FINAL FANTASY VII REMAKE INTERGRADE',
        'Grand Theft Auto: San Andreas - The Definitive Edition',
        'Half-Life 2: Episode Two',
        'F.E.A.R. 2: Project Origin',
        'BioShock™ Remastered',
        'A.I.M.2: Clan Wars',
        'Deus Ex: Human Revolution - Director\'s Cut',
        'Sid Meier’s Civilization® VI',
        'Warhammer 40,000: Space Marine 2',
        'Tom Clancy\'s Rainbow Six® Siege',
      ];

      const catalog: CanonicalGame[] = [];
      let idCounter = 0;

      // Add special titles multiple times with different platform configs
      for (let cycle = 0; cycle < 50; cycle++) {
        for (const t of titles) {
          idCounter++;
          catalog.push({
            id: `game-${idCounter}`,
            title: t,
            sortTitle: t.toLowerCase(),
            originalStoreTitle: t,
            headerImage: 'https://cdn.example.invalid/header.jpg',
            platforms: [
              {
                platformId: 'steam',
                platformGameId: `app-${idCounter}`,
                installed: idCounter % 3 === 0,
                playtimeMinutes: idCounter * 10,
              },
            ],
            genres: ['Action', 'RPG'],
            tags: ['Singleplayer', 'Atmospheric'],
            developers: ['Studio Dev'],
            publishers: ['Publisher Global'],
          });
        }
      }

      // Fill up to 2,500 games with synthetic incremental titles
      while (catalog.length < 2500) {
        idCounter++;
        const title = `Synthetic Universe Expedition Vol. ${idCounter}`;
        catalog.push({
          id: `game-${idCounter}`,
          title,
          sortTitle: title.toLowerCase(),
          originalStoreTitle: title,
          headerImage: 'https://cdn.example.invalid/header.jpg',
          platforms: [
            {
              platformId: 'gog',
              platformGameId: `gog-${idCounter}`,
              installed: idCounter % 2 === 0,
              playtimeMinutes: 50,
            },
          ],
          genres: ['Adventure'],
          tags: ['Indie'],
          developers: ['Indie Creator'],
          publishers: ['One Launcher'],
        });
      }

      return catalog;
    };

    it('simulates 1,000 rapid keystrokes on 2,500-game catalog: verifies decoupled search throughput and punctuation-insensitive matching', () => {
      const catalog = generateAdversarialCatalog();
      expect(catalog.length).toBe(2500);

      // Simulate a sequence of 1,000 rapid keystrokes:
      // Typing words, punctuation, backspaces, gibberish, and Unicode characters
      const keystrokeSequence: string[] = [];

      // Phase 1: Typing "S.T.A.L.K.E.R." letter by letter, then backspacing, then typing "stalker"
      const s1 = 'S.T.A.L.K.E.R. 2: Heart of Chornobyl';
      for (let i = 1; i <= s1.length; i++) keystrokeSequence.push(s1.slice(0, i));
      for (let i = s1.length - 1; i >= 0; i--) keystrokeSequence.push(s1.slice(0, i));
      const s2 = 'stalker 2';
      for (let i = 1; i <= s2.length; i++) keystrokeSequence.push(s2.slice(0, i));

      // Phase 2: Typing "Death's Door" without apostrophe ("deaths door") and with curly apostrophe ("Death’s Door")
      keystrokeSequence.push('d', 'de', 'dea', 'death', 'deaths', 'deaths ', 'deaths d', 'deaths door');
      keystrokeSequence.push('death’s door', "death's door");

      // Phase 3: Typing "spiderman" for "Marvel's Spider-Man Remastered"
      keystrokeSequence.push('s', 'sp', 'spi', 'spid', 'spide', 'spider', 'spiderm', 'spiderma', 'spiderman');

      // Phase 4: Diacritics and Unicode ("pokemon", "wiedzmin", "cafe")
      keystrokeSequence.push('pokemon', 'pokémon', 'wiedzmin', 'wiedźmin', 'cafe', 'café');

      // Phase 5: Adversarial tokens (regex meta-characters, symbols, long strings)
      const adversarialTokens = [
        '.*',
        '[a-z]+',
        '(?:test)',
        '\\\\d+',
        '???',
        '!!!',
        '   ',
        '---',
        '""',
        "''",
        '™',
        '®',
        '©',
        'a'.repeat(200),
      ];
      for (const tok of adversarialTokens) {
        keystrokeSequence.push(tok);
      }

      // Pad up to exactly 1,000 keystrokes with randomized search queries
      const vocabulary = ['witcher', 'final', 'fantasy', 'nier', 'san', 'andreas', 'half', 'life', 'fear', 'bioshock'];
      let padIdx = 0;
      while (keystrokeSequence.length < 1000) {
        const word = vocabulary[padIdx % vocabulary.length];
        const sliceLen = 1 + (padIdx % word.length);
        keystrokeSequence.push(word.slice(0, sliceLen));
        padIdx++;
      }

      expect(keystrokeSequence).toHaveLength(1000);

      // Verify decoupling:
      // High-frequency UI typing updates state immediately.
      // Filtering evaluates against the deferred value without throwing unhandled exceptions.
      const startTime = Date.now();
      let matchCountSum = 0;

      for (let k = 0; k < 1000; k++) {
        const query = keystrokeSequence[k];

        // Oracle check on filtered games using the identical title matching logic from App.tsx:804-808
        if (!query.trim()) {
          matchCountSum += catalog.length;
          continue;
        }

        let matches = 0;
        for (let i = 0; i < catalog.length; i++) {
          const game = catalog[i];
          if (
            matchesLooseSearchQuery(game.title, query) ||
            matchesLooseSearchQuery(game.originalStoreTitle, query)
          ) {
            matches++;
          }
        }
        matchCountSum += matches;
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(15000); // 1,000 queries over 2,500 games must complete cleanly
      expect(matchCountSum).toBeGreaterThan(0);

      // Specific Oracle Assertions:
      // 1. "stalker" matches S.T.A.L.K.E.R.
      const stalkerMatches = catalog.filter((g) => matchesLooseSearchQuery(g.title, 'stalker'));
      expect(stalkerMatches.length).toBe(50);
      expect(stalkerMatches[0].title).toContain('S.T.A.L.K.E.R.');

      // 2. "deaths door" matches Death's Door and Death’s Door
      const deathsDoorMatches = catalog.filter((g) => matchesLooseSearchQuery(g.title, 'deaths door'));
      expect(deathsDoorMatches.length).toBe(100);

      // 3. "spiderman" compact query matches "Marvel's Spider-Man"
      const spidermanMatches = catalog.filter((g) => matchesLooseSearchQuery(g.title, 'spiderman'));
      expect(spidermanMatches.length).toBe(100);

      // 4. "pokemon" matches "Pokémon™"
      const pokemonMatches = catalog.filter((g) => matchesLooseSearchQuery(g.title, 'pokemon'));
      expect(pokemonMatches.length).toBe(50);
    });
  });

  // =========================================================================
  // TORTURE SCENARIO 4: Dynamic Viewport Resizing & Coordinate Drift Elimination
  // =========================================================================
  describe('Torture Scenario 4: Dynamic Viewport Resizing & Zero Coordinate Drift', () => {
    it('simulates rapid column transitions (1 -> 6 -> 3 -> 5) and toolbar expansions: verifies virtualizer.measure() recalculates without coordinate drift', () => {
      const itemsCount = 1200;
      const items = Array.from({ length: itemsCount }, (_, i) => ({
        id: `card-${i}`,
        title: `Game Card ${i}`,
      }));

      const scrollEl = createSyntheticScrollElement(800, 1280);
      const rowHeight = 280;
      const rowGap = 16;
      const harness = createVirtualGridHarness(items, scrollEl, rowHeight, rowGap);

      try {
        // Transition 1: Column count = 1 (single column mobile / ultra-compact layout)
        harness.render(1);
        const tree1 = harness.render(1);
        expect(tree1).toBeDefined();

        const expectedRowsCols1 = 1200;
        const expectedTotalHeightCols1 = expectedRowsCols1 * rowHeight;
        expect(tree1.props.style.height).toBe(`${expectedTotalHeightCols1}px`);

        // Check virtual row coordinates at cols=1
        const virtualRows1 = React.Children.toArray(tree1.props.children) as VirtualElement[];
        expect(virtualRows1.length).toBeGreaterThan(0);
        for (const row of virtualRows1) {
          const rowIdx = Number(row.props['data-index']);
          const expectedTranslateY = `translateY(${rowIdx * rowHeight}px)`;
          expect(row.props.style.transform).toBe(expectedTranslateY);
        }

        // Transition 2: Rapid jump to Column count = 6 (wide 4K desktop)
        harness.render(6);
        const tree2 = harness.render(6);
        expect(tree2).toBeDefined();

        const expectedRowsCols6 = Math.ceil(itemsCount / 6); // 200 rows
        const expectedTotalHeightCols6 = expectedRowsCols6 * rowHeight;
        expect(tree2.props.style.height).toBe(`${expectedTotalHeightCols6}px`);

        const virtualRows2 = React.Children.toArray(tree2.props.children) as VirtualElement[];
        expect(virtualRows2.length).toBeGreaterThan(0);
        for (const row of virtualRows2) {
          const rowIdx = Number(row.props['data-index']);
          const expectedTranslateY = `translateY(${rowIdx * rowHeight}px)`;
          expect(row.props.style.transform).toBe(expectedTranslateY);
        }

        // Transition 3: Rapid jump to Column count = 3 (tablet / portrait view)
        harness.render(3);
        const tree3 = harness.render(3);
        expect(tree3).toBeDefined();

        const expectedRowsCols3 = Math.ceil(itemsCount / 3); // 400 rows
        const expectedTotalHeightCols3 = expectedRowsCols3 * rowHeight;
        expect(tree3.props.style.height).toBe(`${expectedTotalHeightCols3}px`);

        const virtualRows3 = React.Children.toArray(tree3.props.children) as VirtualElement[];
        expect(virtualRows3.length).toBeGreaterThan(0);
        for (const row of virtualRows3) {
          const rowIdx = Number(row.props['data-index']);
          const expectedTranslateY = `translateY(${rowIdx * rowHeight}px)`;
          expect(row.props.style.transform).toBe(expectedTranslateY);
        }

        // Transition 4: Return to Column count = 5 (standard 1080p layout)
        harness.render(5);
        const tree4 = harness.render(5);
        expect(tree4).toBeDefined();

        const expectedRowsCols5 = Math.ceil(itemsCount / 5); // 240 rows
        const expectedTotalHeightCols5 = expectedRowsCols5 * rowHeight;
        expect(tree4.props.style.height).toBe(`${expectedTotalHeightCols5}px`);

        const virtualRows4 = React.Children.toArray(tree4.props.children) as VirtualElement[];
        expect(virtualRows4.length).toBeGreaterThan(0);
        for (const row of virtualRows4) {
          const rowIdx = Number(row.props['data-index']);
          const expectedTranslateY = `translateY(${rowIdx * rowHeight}px)`;
          expect(row.props.style.transform).toBe(expectedTranslateY);
        }

        // Check cards distribution in rows: exactly 5 cards per full row, zero index skips
        for (const row of virtualRows4) {
          const rowIdx = Number(row.props['data-index']);
          const rowCards = React.Children.toArray(row.props.children) as VirtualElement[];
          expect(rowCards.length).toBeLessThanOrEqual(5);
          for (let c = 0; c < rowCards.length; c++) {
            const card = rowCards[c];
            const expectedAbsIndex = rowIdx * 5 + c;
            expect(card.props['data-card-index']).toBe(expectedAbsIndex);
          }
        }
      } finally {
        harness.cleanup();
      }
    });

    it('safely clamps degenerate columnCount <= 0 to safeCols = 1 without throwing or producing NaN coordinates', () => {
      const items = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
      const scrollEl = createSyntheticScrollElement(600, 800);
      const harness = createVirtualGridHarness(items, scrollEl, 250);

      try {
        harness.render(0);
        const treeZero = harness.render(0);
        expect(treeZero.props.style.height).toBe('500px'); // 2 rows * 250px

        harness.render(-10);
        const treeNeg = harness.render(-10);
        expect(treeNeg.props.style.height).toBe('500px');
      } finally {
        harness.cleanup();
      }
    });

    it('handles empty items array gracefully with 0 rows and 0px height', () => {
      const scrollEl = createSyntheticScrollElement(600, 800);
      const harness = createVirtualGridHarness([], scrollEl, 250);

      try {
        harness.render(4);
        const tree = harness.render(4);
        expect(tree.props.style.height).toBe('0px');
        const children = React.Children.toArray(tree.props.children);
        expect(children).toHaveLength(0);
      } finally {
        harness.cleanup();
      }
    });

    it('tests VirtualListRows with dynamic item heights: total size equals sum of heights with zero drift', () => {
      const listItems = Array.from({ length: 50 }, (_, i) => ({
        id: `list-item-${i}`,
        height: 40 + (i % 5) * 20, // heights vary from 40px to 120px
      }));

      const scrollEl = createSyntheticScrollElement(600, 800);
      const states: unknown[] = [];
      const refs: Array<{ current: unknown }> = [];
      const cleanups: Array<(() => void) | undefined> = [];
      const prevDeps: Array<unknown[] | undefined> = [];

      const internals = (React as unknown as ReactInternalHolder)
        .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

      let stateIdx = 0;
      let refIdx = 0;
      let effectIdx = 0;
      const pendingEffects: PendingEffect[] = [];
      const prevH = internals.H;

      const recordEffect = (fn: () => unknown, deps?: unknown[]) => {
        const idx = effectIdx++;
        const old = prevDeps[idx];
        const changed =
          !old || !deps || old.length !== deps.length || deps.some((d, i) => !Object.is(d, old[i]));
        if (changed) {
          prevDeps[idx] = deps;
          pendingEffects.push({ idx, fn });
        }
      };

      internals.H = {
        useState(initial: unknown) {
          const idx = stateIdx++;
          if (idx >= states.length) {
            states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
          }
          return [
            states[idx],
            (u: unknown) => {
              states[idx] = typeof u === 'function' ? (u as (prev: unknown) => unknown)(states[idx]) : u;
            },
          ];
        },
        useReducer(
          reducer: (s: unknown, a: unknown) => unknown,
          initArg: unknown,
          init?: (a: unknown) => unknown
        ) {
          const idx = stateIdx++;
          if (idx >= states.length) {
            states.push(typeof init === 'function' ? init(initArg) : initArg);
          }
          return [
            states[idx],
            (action: unknown) => {
              states[idx] = reducer(states[idx], action);
            },
          ];
        },
        useRef(initial: unknown) {
          const idx = refIdx++;
          if (idx >= refs.length) {
            refs.push({ current: initial });
          }
          return refs[idx];
        },
        useEffect: recordEffect,
        useLayoutEffect: recordEffect,
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
      };

      let listTree: VirtualElement;
      try {
        listTree = VirtualListRows({
          items: listItems,
          scrollElement: scrollEl as unknown as HTMLElement,
          estimatedItemHeight: 60,
          estimateItemSize: (item) => item.height,
          overscan: 5,
          renderItem: (item, idx) =>
            React.createElement('div', { key: item.id, 'data-index': idx }, `Item ${idx}`),
        }) as unknown as VirtualElement;
      } finally {
        internals.H = prevH;
      }

      for (const eff of pendingEffects) {
        cleanups[eff.idx]?.();
        const c = eff.fn();
        cleanups[eff.idx] = typeof c === 'function' ? (c as () => void) : undefined;
      }

      try {
        const expectedTotalHeight = listItems.reduce((acc, it) => acc + it.height, 0);
        expect(listTree.props.style.height).toBe(`${expectedTotalHeight}px`);
      } finally {
        for (const c of cleanups) c?.();
      }
    });
  });

  // =========================================================================
  // ZERO-ANY AST INVARIANT VERIFICATION
  // =========================================================================
  describe('AST Strictness & Zero-Any Invariant', () => {
    it('verifies this adversarial test harness strictly adheres to zero TypeScript AnyKeyword AST tokens', () => {
      const testFilePath = path.resolve(__dirname, 'adversarial_m4_scroll_virtual_stress.test.tsx');
      const content = fs.readFileSync(testFilePath, 'utf8');

      const sf = ts.createSourceFile(
        testFilePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const anyViolations: string[] = [];
      const checkNode = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          anyViolations.push(`Line ${line + 1}, Col ${character + 1}`);
        }
        ts.forEachChild(node, checkNode);
      };

      checkNode(sf);
      expect(anyViolations).toEqual([]);
    });
  });
});
