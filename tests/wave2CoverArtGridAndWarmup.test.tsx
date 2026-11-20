import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CanonicalGame } from '../src/contracts/game';
import { SteamEnrichedMetadata } from '../src/contracts/steam';
import { UserGameOverride } from '../src/contracts/override';
import { unwrapOlMediaUrl } from '../src/contracts/network';
import {
  clearAttemptedCoverLookups,
  clearEmittedCoverSelfHealKeys,
  clearFailedCoverUrls,
  failedCoverUrls,
  getCoverCandidates,
} from '../src/components/Library/Grid/gridCoverUtils';
import { GameCardCover } from '../src/components/Library/Grid/GameCardCover';
import { renderLibraryGridCard } from '../src/components/Library/Grid/LibraryGridCard';
import { LibraryGridView } from '../src/components/Library/LibraryGridView';
import {
  FAST_SCROLL_CALM_MS,
  isCurrentlyFastScrolling,
  recordScrollActivity,
} from '../src/components/Library/Grid/gridScrollTracker';
import { igdbCoverService } from '../src/services/igdb/igdbCoverService';
import { steamApi } from '../src/services/steam/steamApi';
import { steamMatcher } from '../src/services/steam/steamMatcher';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import {
  SyncJobManager,
  buildP2CoverHydrationBatch,
  evaluateGameNeedsStoreMediaSync,
  extractStaticHydrationAssets,
  syncJobManager,
} from '../src/services/network/syncJobManager';
import * as stagedCacheService from '../src/services/storage/stagedCacheService';
import { buildLibraryFilterIndex } from '../src/services/filter/libraryFilterIndex';
import { useBackgroundMediaWarmup } from '../src/hooks/useBackgroundMediaWarmup';

// ---------------------------------------------------------------------------
// Minimal Zero-Dependency React 19 Client Component Harness (No jsdom/any)
// ---------------------------------------------------------------------------

interface RenderedNode {
  tag: string;
  props: Record<string, unknown>;
}

interface HookFiber {
  states: unknown[];
  refs: Array<{ current: unknown }>;
  memos: Array<{ deps?: readonly unknown[]; value: unknown }>;
  effectDeps: Array<readonly unknown[] | undefined>;
  effectCleanups: Array<(() => void) | undefined>;
}

function mountClientComponent<P extends object>(
  Component: React.ComponentType<P>,
  initialProps: P
) {
  let currentProps: P = { ...initialProps };
  const fibers = new Map<string, HookFiber>();
  let isUnmounted = false;
  let dirty = false;
  let renderedElements: RenderedNode[] = [];

  const getFiber = (key: string): HookFiber => {
    let f = fibers.get(key);
    if (!f) {
      f = { states: [], refs: [], memos: [], effectDeps: [], effectCleanups: [] };
      fibers.set(key, f);
    }
    return f;
  };

  const depsChanged = (
    prev: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined
  ) =>
    prev === undefined ||
    next === undefined ||
    prev.length !== next.length ||
    next.some((d, i) => !Object.is(d, prev[i]));

  const runRenderCycle = () => {
    const elements: RenderedNode[] = [];
    const pendingEffects: Array<{ fiber: HookFiber; idx: number; fn: () => void | (() => void) }> =
      [];

    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    let activeFiber: HookFiber | null = null;
    let stateIdx = 0;
    let refIdx = 0;
    let memoIdx = 0;
    let effectIdx = 0;

    const dispatcher = {
      useState<S>(initial: S | (() => S)) {
        const fiber = activeFiber!;
        const idx = stateIdx++;
        if (idx >= fiber.states.length) {
          fiber.states.push(typeof initial === 'function' ? (initial as () => S)() : initial);
        }
        const setState = (updater: S | ((prev: S) => S)) => {
          if (isUnmounted) return;
          const prevVal = fiber.states[idx] as S;
          const nextVal =
            typeof updater === 'function' ? (updater as (prev: S) => S)(prevVal) : updater;
          if (!Object.is(prevVal, nextVal)) {
            fiber.states[idx] = nextVal;
            dirty = true;
          }
        };
        return [fiber.states[idx] as S, setState] as const;
      },
      useRef<T>(initial: T) {
        const fiber = activeFiber!;
        const idx = refIdx++;
        if (idx >= fiber.refs.length) {
          fiber.refs.push({ current: initial });
        }
        return fiber.refs[idx] as { current: T };
      },
      useMemo<T>(factory: () => T, deps?: readonly unknown[]) {
        const fiber = activeFiber!;
        const idx = memoIdx++;
        const prev = fiber.memos[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          const value = factory();
          fiber.memos[idx] = { deps: deps ? [...deps] : undefined, value };
          return value;
        }
        return prev.value as T;
      },
      useCallback<T extends (...args: never[]) => unknown>(cb: T, deps?: readonly unknown[]) {
        return dispatcher.useMemo(() => cb, deps);
      },
      useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
        const fiber = activeFiber!;
        const idx = effectIdx++;
        if (depsChanged(fiber.effectDeps[idx], deps)) {
          fiber.effectDeps[idx] = deps ? [...deps] : undefined;
          pendingEffects.push({ fiber, idx, fn });
        }
      },
      useLayoutEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
        dispatcher.useEffect(fn, deps);
      },
    };

    const walk = (node: React.ReactNode, pathKey: string): void => {
      if (node === null || node === undefined || typeof node === 'boolean') return;
      if (typeof node === 'string' || typeof node === 'number') return;
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${pathKey}.${i}`));
        return;
      }
      if (!React.isValidElement(node)) return;

      const el = node as React.ReactElement<Record<string, unknown>>;
      const type = el.type as unknown;
      if (typeof type === 'string') {
        elements.push({ tag: type, props: el.props });
        if (el.props.children !== undefined) {
          walk(el.props.children as React.ReactNode, `${pathKey}/${type}`);
        }
        return;
      }
      if (type === React.Fragment) {
        walk(el.props.children as React.ReactNode, `${pathKey}/frag`);
        return;
      }

      const fnComponent =
        typeof type === 'function'
          ? (type as (p: Record<string, unknown>) => React.ReactNode)
          : typeof type === 'object' &&
              type !== null &&
              'type' in type &&
              typeof (type as { type?: unknown }).type === 'function'
            ? ((type as { type: (p: Record<string, unknown>) => React.ReactNode }).type)
            : null;
      if (!fnComponent) return;

      const fKey = `${pathKey}/${fnComponent.name || 'Comp'}`;
      activeFiber = getFiber(fKey);
      stateIdx = 0;
      refIdx = 0;
      memoIdx = 0;
      effectIdx = 0;
      const out = fnComponent(el.props);
      walk(out, fKey);
    };

    internals.H = dispatcher;
    try {
      walk(React.createElement(Component, currentProps), 'root');
    } finally {
      internals.H = prevH;
    }

    renderedElements = elements;

    for (const eff of pendingEffects) {
      eff.fiber.effectCleanups[eff.idx]?.();
      const cleanup = eff.fn();
      eff.fiber.effectCleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }
  };

  const flush = () => {
    let guard = 0;
    do {
      dirty = false;
      runRenderCycle();
      guard++;
    } while (dirty && guard < 12);
  };

  flush();

  return {
    getElements: () => renderedElements,
    flush,
    rerender(nextProps: P) {
      currentProps = { ...nextProps };
      flush();
    },
    unmount() {
      isUnmounted = true;
      for (const fiber of fibers.values()) {
        for (const cleanup of fiber.effectCleanups) {
          cleanup?.();
        }
      }
      fibers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Test Environment & Synthetic Fixtures
// ---------------------------------------------------------------------------

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function makeSyntheticGame(overrides: Partial<CanonicalGame> & { id: string; title: string }): CanonicalGame {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    sortTitle: title,
    platforms: rest.platforms ?? [
      {
        platformId: 'steam',
        platformGameId: String(rest.steamAppId ?? 975001),
        installed: false,
        playtimeMinutes: 0,
      },
    ],
    headerImage: 'https://cdn.example.invalid/synthetic/header.jpg',
    developers: ['Synthetic Dev'],
    publishers: ['Synthetic Pub'],
    genres: ['RPG'],
    tags: ['Singleplayer'],
    ...rest,
  };
}

function makeSyntheticEnrichedMetadata(
  overrides: Partial<SteamEnrichedMetadata> = {}
): SteamEnrichedMetadata {
  return {
    appId: 975001,
    name: 'Synthetic Title',
    shortDescription: 'Authoritative synthetic game synopsis.',
    detailedDescription: '<p>Detailed synthetic store body.</p>',
    aboutTheGame: '<p>About this synthetic game.</p>',
    headerImage: 'https://cdn.example.invalid/synthetic/header.jpg',
    developers: ['Synthetic Dev'],
    publishers: ['Synthetic Pub'],
    releaseDate: '2024-03-10',
    genres: ['RPG'],
    tags: ['Singleplayer'],
    categories: [{ id: 2, description: 'Single-player' }],
    screenshots: [
      {
        id: 1,
        pathThumbnail: 'https://cdn.example.invalid/synthetic/s1_thumb.jpg',
        pathFull: 'https://cdn.example.invalid/synthetic/s1_full.jpg',
      },
    ],
    movies: [],
    systemRequirements: { minimum: '64-bit OS' },
    reviewSummary: {
      reviewScore: 8,
      reviewScoreDesc: 'Very Positive',
      totalPositive: 850,
      totalNegative: 150,
      totalReviews: 1000,
      positivePercent: 85,
    },
    metadataQuality: 'authoritative',
    enrichedSource: 'steam',
    enrichedAt: Date.now() - 10_000,
    ...overrides,
  };
}

describe('Wave 2 — Cover Art Waterfall Elimination, Virtualized Grid Overscan, Self-Heal & Warmup Alignment', () => {
  let memStorage: MemoryStorage;
  let eventTarget: EventTarget;
  let prevWindow: unknown;
  let prevLocalStorage: unknown;
  let prevCustomEvent: unknown;

  beforeEach(() => {
    memStorage = new MemoryStorage();
    eventTarget = new EventTarget();
    const g = globalThis as Record<string, unknown>;
    prevWindow = g.window;
    prevLocalStorage = g.localStorage;
    prevCustomEvent = g.CustomEvent;

    if (typeof g.CustomEvent === 'undefined') {
      g.CustomEvent = class SyntheticCustomEvent<T = unknown> extends Event {
        public readonly detail: T;
        constructor(type: string, params?: CustomEventInit<T>) {
          super(type);
          this.detail = params?.detail as T;
        }
      };
    }

    g.localStorage = memStorage;
    g.window = {
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        eventTarget.addEventListener(type, cb),
      removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        eventTarget.removeEventListener(type, cb),
      dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
      localStorage: memStorage,
      innerWidth: 1440,
      innerHeight: 900,
      location: { protocol: 'app:', hostname: 'one-launcher.local', port: '' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };

    igdbCoverService.clearCache();
    clearFailedCoverUrls();
    clearAttemptedCoverLookups();
    clearEmittedCoverSelfHealKeys();
    syncJobManager.reset();
    vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    const g = globalThis as Record<string, unknown>;
    g.window = prevWindow;
    g.localStorage = prevLocalStorage;
    g.CustomEvent = prevCustomEvent;
  });

  // =========================================================================
  // 1. gridCoverUtils: IStoreBrowseService Negative Honor, SWR & Mirror Collapse
  // =========================================================================
  describe('1. gridCoverUtils — IStoreBrowseService Negative Honor, Dead-Steam SWR & 1x+2x Mirror Collapse', () => {
    it('collapses 3 redundant 1x Steam mirrors into 1 canonical 1x URL followed by 1 _2x fallback', () => {
      const appId = 975101;
      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);
      const game = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic Mirror Collapse',
        steamAppId: appId,
        capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
      });

      const candidates = getCoverCandidates(game, null, null);
      expect(candidates).toEqual([
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
      ]);
      expect(candidates.some((u) => u.includes('shared.fastly.steamstatic.com'))).toBe(false);
      expect(candidates.some((u) => u.includes('cdn.akamai.steamstatic.com/steam/apps/'))).toBe(
        false
      );
    });

    it('honors authoritative IStoreBrowseService negative results (absent capsuleImage) and skips speculative unhashed library_600x900 URLs', () => {
      const appId = 975102;
      const gogId = '8800102';
      const gogBoxArt = 'https://images.gog-statics.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg';
      const igdbCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/synth_neg_02.jpg';

      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue({
        headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
        iconUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/icon.jpg`,
        ts: Date.now(),
      });
      vi.spyOn(igdbCoverService, 'getGogVerticalCoverInstant').mockReturnValue(gogBoxArt);
      vi.spyOn(igdbCoverService, 'getIgdbCoverInstant').mockReturnValue(igdbCover);

      const gameWithFallback = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic Browse Negative Title',
        steamAppId: appId,
        platforms: [{ platformId: 'gog', platformGameId: gogId, installed: false }],
        capsuleImage: igdbCover,
      });

      const candidates = getCoverCandidates(gameWithFallback, null, null);
      expect(candidates[0]).toBe(gogBoxArt);
      expect(candidates.some((u) => u.includes('/library_600x900'))).toBe(false);

      // Even without a fallback cover, browse negative confirmation avoids synthesizing guaranteed 404s
      vi.spyOn(igdbCoverService, 'getGogVerticalCoverInstant').mockReturnValue(null);
      vi.spyOn(igdbCoverService, 'getIgdbCoverInstant').mockReturnValue(null);
      const gameWithoutFallback = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic Browse Negative No Fallback',
        steamAppId: appId,
        capsuleImage: undefined,
      });
      expect(getCoverCandidates(gameWithoutFallback, null, null)).toEqual([]);
    });

    it('suppresses speculative unhashed Steam URLs synchronously on expired dead Steam AppIDs when verified portrait fallback exists and schedules idle SWR reprobe', () => {
      const appId = 975103;
      const igdbFallback =
        'https://images.igdb.com/igdb/image/upload/t_cover_big/synth_swr_fallback.jpg';

      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);
      vi.spyOn(igdbCoverService, 'isKnownDeadUnhashedSteamCover').mockReturnValue(false);
      vi.spyOn(igdbCoverService, 'isExpiredDeadSteamUnhashed').mockReturnValue(true);
      const scheduleReprobeSpy = vi
        .spyOn(igdbCoverService, 'scheduleExpiredDeadSteamReprobe')
        .mockImplementation(() => {});

      const gameWithVerifiedFallback = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic Expired Dead SWR',
        steamAppId: appId,
        capsuleImage: igdbFallback,
      });

      // Synchronous render path: serves verified IGDB cover at index 0 + schedules background reprobe
      const candidates = getCoverCandidates(gameWithVerifiedFallback, null, null);
      expect(candidates[0]).toBe(igdbFallback);
      expect(candidates.some((u) => u.includes('/library_600x900'))).toBe(false);
      expect(scheduleReprobeSpy).toHaveBeenCalledTimes(1);
      expect(scheduleReprobeSpy).toHaveBeenCalledWith(appId);

      // Hydration extraction path (`scheduleSwrReprobe: false`) suppresses speculative URLs without side effects
      scheduleReprobeSpy.mockClear();
      const silentCandidates = getCoverCandidates(gameWithVerifiedFallback, null, null, {
        scheduleSwrReprobe: false,
      });
      expect(silentCandidates[0]).toBe(igdbFallback);
      expect(scheduleReprobeSpy).not.toHaveBeenCalled();

      // Without ANY verified portrait fallback, speculative canonical 1x + 2x URLs are still permitted
      scheduleReprobeSpy.mockClear();
      const gameNoFallback = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic Expired Dead Without Fallback',
        steamAppId: appId,
        capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
      });
      const fallbacklessCandidates = getCoverCandidates(gameNoFallback, null, null);
      expect(fallbacklessCandidates[0]).toBe(
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`
      );
      expect(scheduleReprobeSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Virtualized Grid Overscan, Explicit Dimensions, 75ms Calm & 404 Short-Circuit
  // =========================================================================
  describe('2. Virtualized Grid Overscan, Explicit Dimensions, 75ms Calm & 404 Short-Circuit', () => {
    it('omits .cv-card-deferred and mounts eager 600x900 <img> inside virtualized cards (idx >= 28), while keeping .cv-card-deferred & lazy gating for non-virtualized cards', () => {
      const g = globalThis as Record<string, unknown>;
      const prevIO = g.IntersectionObserver;
      let ioConstructorCalls = 0;
      g.IntersectionObserver = class NonIntersectingIO {
        constructor() {
          ioConstructorCalls++;
        }
        observe() {}
        disconnect() {}
      };

      try {
        const game = makeSyntheticGame({
          id: 'steam-975201',
          title: 'Synthetic Overscan Card',
          steamAppId: 975201,
          capsuleImage:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975201/library_600x900.jpg',
        });
        const filterIndex = buildLibraryFilterIndex([game]);
        const sharedArgs = {
          game,
          idx: 60, // well past non-virtualized above-the-fold cutoff (28)
          sortBy: 'alphabetical' as const,
          userOverridesMap: {},
          coverOverrides: {},
          connectedSet: new Set<'steam' | 'gog' | 'epic' | 'xbox'>(['steam']),
          effectiveFilterIndex: filterIndex,
          contextMenuOpenRef: { current: false },
          onDismissContextMenu: vi.fn(),
          onSelectGame: vi.fn(),
          onNeedCoverLookup: vi.fn(),
          onMouseEnter: vi.fn(),
          onMouseLeave: vi.fn(),
          onContextMenu: vi.fn(),
          resolveGameCriticData: () => null,
        };

        // Virtualized card at idx=60: .cv-card WITHOUT .cv-card-deferred, eager <img> with 600x900
        const virtualizedHtml = renderToString(
          renderLibraryGridCard({ ...sharedArgs, isVirtualized: true })
        );
        expect(virtualizedHtml).toContain('cv-card');
        expect(virtualizedHtml).not.toContain('cv-card-deferred');
        expect(virtualizedHtml).toContain('<img');
        expect(virtualizedHtml).toContain('loading="eager"');
        expect(virtualizedHtml).toContain('width="600"');
        expect(virtualizedHtml).toContain('height="900"');
        expect(ioConstructorCalls).toBe(0);

        // Non-virtualized card at idx=60: retains .cv-card-deferred and defers <img> when IO hasn't fired
        const nonVirtualizedHtml = renderToString(
          renderLibraryGridCard({ ...sharedArgs, isVirtualized: false })
        );
        expect(nonVirtualizedHtml).toContain('cv-card-deferred');
        expect(nonVirtualizedHtml).not.toContain('<img');
      } finally {
        if (prevIO === undefined) {
          delete g.IntersectionObserver;
        } else {
          g.IntersectionObserver = prevIO;
        }
      }
    });

    it('defers virtualized GameCardCover ONLY during active fast-scroll without creating IntersectionObserver and mounts immediately after tightened 75ms calm timer', () => {
      vi.useFakeTimers();
      expect(FAST_SCROLL_CALM_MS).toBe(75);

      const g = globalThis as Record<string, unknown>;
      const prevIO = g.IntersectionObserver;
      let ioConstructorCalls = 0;
      g.IntersectionObserver = class SpyIO {
        constructor() {
          ioConstructorCalls++;
        }
        observe() {}
        disconnect() {}
      };

      try {
        // Trigger fast scroll (>300px step)
        recordScrollActivity(0, 'main');
        recordScrollActivity(600, 'main');
        expect(isCurrentlyFastScrolling()).toBe(true);

        const game = makeSyntheticGame({
          id: 'steam-975202',
          title: 'Synthetic Fast Scroll Card',
          steamAppId: 975202,
          capsuleImage:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975202/library_600x900.jpg',
        });

        const root = mountClientComponent(GameCardCover, {
          game,
          cardIndex: 80,
          isVirtualized: true,
        });

        try {
          // While fast-scrolling: <img> deferred and ZERO IntersectionObserver created
          expect(root.getElements().filter((el) => el.tag === 'img')).toHaveLength(0);
          expect(ioConstructorCalls).toBe(0);

          // At 74ms: still fast-scrolling
          vi.advanceTimersByTime(74);
          root.flush();
          expect(isCurrentlyFastScrolling()).toBe(true);
          expect(root.getElements().filter((el) => el.tag === 'img')).toHaveLength(0);

          // At 76ms (past 75ms calm window): mounts eager 600x900 <img> immediately!
          vi.advanceTimersByTime(2);
          root.flush();
          expect(isCurrentlyFastScrolling()).toBe(false);
          const imgs = root.getElements().filter((el) => el.tag === 'img');
          expect(imgs).toHaveLength(1);
          expect(imgs[0].props.loading).toBe('eager');
          expect(imgs[0].props.width).toBe(600);
          expect(imgs[0].props.height).toBe(900);
          expect(ioConstructorCalls).toBe(0);
        } finally {
          root.unmount();
        }
      } finally {
        if (prevIO === undefined) {
          delete g.IntersectionObserver;
        } else {
          g.IntersectionObserver = prevIO;
        }
      }
    });

    it('renders explicit width=460 height=215 on the header fallback <img> and passes overscan=4 + isVirtualized=true into VirtualGridRows in LibraryGridView for >80 games', () => {
      const headerOnlyGame = makeSyntheticGame({
        id: 'epic-synth-header-only',
        title: 'Synthetic Header Fallback',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'synth-header-only', installed: false }],
        headerImage: 'https://cdn.example.invalid/synthetic/banner-460x215.jpg',
        capsuleImage: undefined,
      });

      const headerFallbackHtml = renderToString(
        React.createElement(GameCardCover, {
          game: headerOnlyGame,
          cardIndex: 40,
          isVirtualized: true,
        })
      );
      expect(headerFallbackHtml).toContain('width="460"');
      expect(headerFallbackHtml).toContain('height="215"');
      expect(headerFallbackHtml).toContain('loading="eager"');

      // Exercise LibraryGridView with 90 games and a measurable scroll container so it enters the
      // VirtualGridRows branch (`sortedGames.length > 80`), verifying overscan={4} and virtualized card flags.
      const ninetyGames = Array.from({ length: 90 }, (_, idx) => {
        const appId = 976000 + idx;
        return makeSyntheticGame({
          id: `steam-${appId}`,
          title: `Synthetic Virtual Game ${String(idx).padStart(3, '0')}`,
          steamAppId: appId,
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
        });
      });

      const scrollParentStub = {
        clientHeight: 900,
        clientWidth: 1440,
        scrollTop: 0,
        scrollHeight: 6000,
        tagName: 'MAIN',
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 1440, height: 900 }),
      };
      const gridRootStub = {
        clientWidth: 1440,
        clientHeight: 900,
        parentElement: scrollParentStub,
        closest: () => scrollParentStub,
      };

      const capturedVirtualProps: Array<{
        overscan?: number;
        itemsLength?: number;
        renderCard?: (g: CanonicalGame, idx: number) => React.ReactElement;
      }> = [];

      const internals = (
        React as unknown as {
          __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
        }
      ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;
      const states: unknown[] = [];
      const refs: Array<{ current: unknown }> = [];
      const memos: Array<{ value: unknown }> = [];
      const layoutEffects: Array<() => void> = [];
      let sIdx = 0;
      let rIdx = 0;
      let mIdx = 0;
      let dirtyGrid = false;

      const gridDispatcher = {
        useState<S>(init: S | (() => S)) {
          const i = sIdx++;
          if (i >= states.length) {
            states.push(typeof init === 'function' ? (init as () => S)() : init);
          }
          const setter = (u: S | ((p: S) => S)) => {
            const prevVal = states[i] as S;
            const nextVal = typeof u === 'function' ? (u as (p: S) => S)(prevVal) : u;
            if (!Object.is(prevVal, nextVal)) {
              states[i] = nextVal;
              dirtyGrid = true;
            }
          };
          return [states[i] as S, setter] as const;
        },
        useRef<T>(init: T) {
          const i = rIdx++;
          if (i >= refs.length) {
            refs.push({ current: i === 0 ? gridRootStub : init });
          }
          return refs[i] as { current: T };
        },
        useMemo<T>(factory: () => T) {
          const i = mIdx++;
          const val = factory();
          memos[i] = { value: val };
          return val;
        },
        useCallback<T extends (...args: never[]) => unknown>(cb: T) {
          return cb;
        },
        useEffect() {},
        useLayoutEffect(fn: () => void) {
          if (layoutEffects.length === 0) {
            layoutEffects.push(fn);
          }
        },
      };

      const findVirtualGrid = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(findVirtualGrid);
          return;
        }
        if (!React.isValidElement(node)) return;
        const el = node as React.ReactElement<Record<string, unknown>>;
        const typeObj = el.type as { name?: string };
        if (typeObj?.name === 'VirtualGridRows') {
          capturedVirtualProps.push({
            overscan: el.props.overscan as number | undefined,
            itemsLength: Array.isArray(el.props.items) ? el.props.items.length : undefined,
            renderCard: el.props.renderCard as
              | ((g: CanonicalGame, idx: number) => React.ReactElement)
              | undefined,
          });
          return;
        }
        if (el.props.children) {
          findVirtualGrid(el.props.children);
        }
      };

      internals.H = gridDispatcher;
      try {
        const gridProps = { games: ninetyGames, onSelectGame: vi.fn() };
        // Pass 1: mount & run useLayoutEffect to populate scrollEl + clientHeight
        LibraryGridView(gridProps);
        layoutEffects.forEach((fn) => fn());
        expect(dirtyGrid).toBe(true);

        // Pass 2: re-render with live scroll metrics -> VirtualGridRows active!
        sIdx = 0;
        rIdx = 0;
        mIdx = 0;
        const tree = LibraryGridView(gridProps);
        findVirtualGrid(tree);
      } finally {
        internals.H = prevH;
      }

      expect(capturedVirtualProps).toHaveLength(1);
      expect(capturedVirtualProps[0].overscan).toBe(4);
      expect(capturedVirtualProps[0].itemsLength).toBe(90);

      // Render card #60 via VirtualGridRows' renderCard callback -> isVirtualized=true!
      const card60Html = renderToString(capturedVirtualProps[0].renderCard!(ninetyGames[60], 60));
      expect(card60Html).toContain('cv-card');
      expect(card60Html).not.toContain('cv-card-deferred');
      expect(card60Html).toContain('loading="eager"');
      expect(card60Html).toContain('width="600"');
      expect(card60Html).toContain('height="900"');
    });

    it('passes currentRawUrl to verifyAndRecordDeadSteamCover on 1x 404 and immediately short-circuits remaining unhashed _2x variant without retrying it', async () => {
      const appId = 975204;
      const igdbFallback =
        'https://images.igdb.com/igdb/image/upload/t_cover_big/synth_shortcircuit_04.jpg';
      const canonical1x = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
      const canonical2x = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`;

      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);
      const verifySpy = vi
        .spyOn(igdbCoverService, 'verifyAndRecordDeadSteamCover')
        .mockResolvedValue(true);

      const game = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic 404 Short Circuit',
        steamAppId: appId,
        capsuleImage: igdbFallback,
      });

      const root = mountClientComponent(GameCardCover, {
        game,
        cardIndex: 0,
        isVirtualized: true,
      });

      try {
        const imgsInitial = root.getElements().filter((el) => el.tag === 'img');
        expect(imgsInitial).toHaveLength(1);
        expect(unwrapOlMediaUrl(String(imgsInitial[0].props.src))).toBe(canonical1x);

        // Simulate 1x image load error
        const onError = imgsInitial[0].props.onError as () => void;
        onError();

        // Allow async verifyAndRecordDeadSteamCover(appId, canonical1x) resolution microtask
        await Promise.resolve();
        await Promise.resolve();
        root.flush();

        expect(verifySpy).toHaveBeenCalledTimes(1);
        expect(verifySpy).toHaveBeenCalledWith(appId, canonical1x);
        expect(failedCoverUrls.has(canonical2x)).toBe(true);

        // Card must now render the IGDB fallback directly, skipping _2x.jpg!
        const imgsAfter = root.getElements().filter((el) => el.tag === 'img');
        expect(imgsAfter).toHaveLength(1);
        expect(unwrapOlMediaUrl(String(imgsAfter[0].props.src))).toBe(igdbFallback);
      } finally {
        root.unmount();
      }
    });

    it('passes exact SHA1-hashed Steam URL to verifyAndRecordDeadSteamCover on onError without marking unhashed library_600x900 variants failed', async () => {
      const appId = 975205;
      const sha1 = '0123456789abcdef0123456789abcdef01234567';
      const hashedUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/${sha1}/library_capsule.jpg`;
      const unhashed1x = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
      const unhashed2x = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`;

      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue({
        capsuleImage: hashedUrl,
        ts: Date.now(),
      });
      const verifySpy = vi
        .spyOn(igdbCoverService, 'verifyAndRecordDeadSteamCover')
        .mockResolvedValue(true);

      const game = makeSyntheticGame({
        id: `steam-${appId}`,
        title: 'Synthetic SHA1 Isolated Error',
        steamAppId: appId,
        capsuleImage: hashedUrl,
      });

      const root = mountClientComponent(GameCardCover, {
        game,
        cardIndex: 0,
        isVirtualized: true,
      });

      try {
        const imgs = root.getElements().filter((el) => el.tag === 'img');
        expect(imgs).toHaveLength(1);
        expect(unwrapOlMediaUrl(String(imgs[0].props.src))).toBe(hashedUrl);

        const onError = imgs[0].props.onError as () => void;
        onError();
        await Promise.resolve();
        root.flush();

        expect(verifySpy).toHaveBeenCalledTimes(1);
        expect(verifySpy).toHaveBeenCalledWith(appId, hashedUrl);
        // Unhashed fallback variants MUST remain eligible (NOT marked dead!)
        expect(failedCoverUrls.has(unhashed1x)).toBe(false);
        expect(failedCoverUrls.has(unhashed2x)).toBe(false);
        const imgsNext = root.getElements().filter((el) => el.tag === 'img');
        expect(imgsNext).toHaveLength(1);
        expect(unwrapOlMediaUrl(String(imgsNext[0].props.src))).toBe(unhashed1x);
      } finally {
        root.unmount();
      }
    });
  });

  // =========================================================================
  // 3. Task 4 Stage 3 Split-Brain Self-Heal Event
  // =========================================================================
  describe('3. Stage 3 Split-Brain Self-Heal — Deduplicated Once-Per-Game-Per-Session Cover Events', () => {
    it('emits antigravity:gog-cover-updated once per game per session when GOG instant cover resolves while game.capsuleImage is missing/unsuitable (even if hasAttemptedGogVerticalCover is already true)', () => {
      const gogId = '8800301';
      const gogBoxArt =
        'https://images.gog-statics.com/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg';

      vi.spyOn(igdbCoverService, 'hasAttemptedGogVerticalCover').mockReturnValue(true);
      vi.spyOn(igdbCoverService, 'getGogVerticalCoverInstant').mockReturnValue(gogBoxArt);

      const dispatched: Array<{ gogId?: string; gameId?: string; title?: string; coverUrl?: string }> =
        [];
      const listener = (e: Event) => {
        dispatched.push(
          (e as CustomEvent<{ gogId?: string; gameId?: string; title?: string; coverUrl?: string }>)
            .detail
        );
      };
      eventTarget.addEventListener('antigravity:gog-cover-updated', listener);

      const gameMissingCover = makeSyntheticGame({
        id: `gog-${gogId}`,
        title: 'Synthetic Split-Brain GOG Title',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'gog', platformGameId: gogId, installed: false }],
        capsuleImage: undefined,
      });

      const root1 = mountClientComponent(GameCardCover, {
        game: gameMissingCover,
        cardIndex: 0,
        isVirtualized: true,
      });
      root1.rerender({ game: gameMissingCover, cardIndex: 0, isVirtualized: true });
      root1.unmount();

      // Remounting a second time in the same session must NOT duplicate the event!
      const root2 = mountClientComponent(GameCardCover, {
        game: gameMissingCover,
        cardIndex: 0,
        isVirtualized: true,
      });
      root2.unmount();

      eventTarget.removeEventListener('antigravity:gog-cover-updated', listener);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toEqual({
        gameId: `gog-${gogId}`,
        gogId,
        title: 'Synthetic Split-Brain GOG Title',
        coverUrl: gogBoxArt,
      });
    });

    it('emits antigravity:igdb-cover-updated once per game per session when IGDB instant cover resolves while game.capsuleImage is unsuitable, and does NOT emit when capsuleImage or userOverride is already valid', () => {
      const igdbCover =
        'https://images.igdb.com/igdb/image/upload/t_cover_big/synth_igdb_selfheal.jpg';
      vi.spyOn(igdbCoverService, 'getGogVerticalCoverInstant').mockReturnValue(null);
      vi.spyOn(igdbCoverService, 'getIgdbCoverInstant').mockReturnValue(igdbCover);

      const dispatched: Array<{ gameId?: string; title?: string; coverUrl?: string }> = [];
      const listener = (e: Event) => {
        dispatched.push(
          (e as CustomEvent<{ gameId?: string; title?: string; coverUrl?: string }>).detail
        );
      };
      eventTarget.addEventListener('antigravity:igdb-cover-updated', listener);

      // 1) Unsuitable horizontal banner in capsuleImage -> heals once via IGDB event
      const brokenGame = makeSyntheticGame({
        id: 'epic-synth-broken-302',
        title: 'Synthetic Unsuitable Capsule',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'synth-broken-302', installed: false }],
        capsuleImage: 'https://cdn.example.invalid/header.jpg',
      });
      const r1 = mountClientComponent(GameCardCover, { game: brokenGame, cardIndex: 1 });
      r1.unmount();
      const r2 = mountClientComponent(GameCardCover, { game: brokenGame, cardIndex: 1 });
      r2.unmount();

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toEqual({
        gameId: 'epic-synth-broken-302',
        title: 'Synthetic Unsuitable Capsule',
        coverUrl: igdbCover,
      });

      // 2) Healthy portrait capsuleImage -> emits 0 events
      const healthyGame = makeSyntheticGame({
        id: 'epic-synth-healthy-303',
        title: 'Synthetic Healthy Capsule',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'synth-healthy-303', installed: false }],
        capsuleImage: 'https://cdn1.epicgames.com/offer/synth/EGS_Tall.jpg',
      });
      const r3 = mountClientComponent(GameCardCover, { game: healthyGame, cardIndex: 2 });
      r3.unmount();

      // 3) Missing capsuleImage BUT explicit userOverride.capsuleImage set -> emits 0 events
      const userOv: UserGameOverride = {
        gameId: 'epic-synth-ov-304',
        matchedStore: 'custom',
        title: 'Synthetic Overridden',
        capsuleImage: 'https://cdn.example.invalid/custom-portrait.jpg',
        updatedAt: '2026-10-01T00:00:00Z',
      };
      const overriddenGame = makeSyntheticGame({
        id: 'epic-synth-ov-304',
        title: 'Synthetic Overridden',
        isExplicitNonSteam: true,
        capsuleImage: undefined,
      });
      const r4 = mountClientComponent(GameCardCover, {
        game: overriddenGame,
        userOverride: userOv,
        cardIndex: 3,
      });
      r4.unmount();

      eventTarget.removeEventListener('antigravity:igdb-cover-updated', listener);
      expect(dispatched).toHaveLength(1);
    });
  });

  // =========================================================================
  // 4. SyncJobManager Alignment, Authoritative Artwork Backfill, Sibling Warmup Chaining & P2 Queue Pass
  // =========================================================================
  describe('4. SyncJobManager Alignment, Backfill, Sibling Warmup Chaining & P2 Cover Warmup Pass', () => {
    it('aligns extractStaticHydrationAssets cover URL with getCoverCandidates(game)[0] (Steam 1x, Epic ?h=480&resize=1, and dead-Steam IGDB fallback)', () => {
      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);

      // A. Steam 2x raw capsule -> aligns to canonical 1x URL requested by GameCardCover
      const steamGame = makeSyntheticGame({
        id: 'steam-975401',
        title: 'Synthetic Steam 2x Align',
        steamAppId: 975401,
        capsuleImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975401/library_600x900_2x.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975401/icon.jpg',
      });
      const steamAssets = extractStaticHydrationAssets(steamGame);
      expect(steamAssets.find((a) => a.role === 'cover')?.url).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975401/library_600x900.jpg'
      );

      // B. Epic raw capsule -> aligns to ?h=480&resize=1 URL requested by GameCardCover
      const epicGame = makeSyntheticGame({
        id: 'epic-synth-402',
        title: 'Synthetic Epic Align',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'synth-402', installed: false }],
        capsuleImage: 'https://cdn1.epicgames.com/offer/synth/EGS_Synth_Tall.jpg',
      });
      const epicAssets = extractStaticHydrationAssets(epicGame);
      expect(epicAssets.find((a) => a.role === 'cover')?.url).toBe(
        'https://cdn1.epicgames.com/offer/synth/EGS_Synth_Tall.jpg?h=480&resize=1'
      );

      // C. Expired dead Steam AppID with IGDB cover -> aligns to IGDB cover WITHOUT firing SWR reprobe
      const igdbCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/synth_align_403.jpg';
      vi.spyOn(igdbCoverService, 'isExpiredDeadSteamUnhashed').mockReturnValue(true);
      const reprobeSpy = vi
        .spyOn(igdbCoverService, 'scheduleExpiredDeadSteamReprobe')
        .mockImplementation(() => {});
      const deadSteamGame = makeSyntheticGame({
        id: 'steam-975403',
        title: 'Synthetic Dead Steam Align',
        steamAppId: 975403,
        capsuleImage: igdbCover,
      });
      const deadAssets = extractStaticHydrationAssets(deadSteamGame);
      expect(deadAssets.find((a) => a.role === 'cover')?.url).toBe(igdbCover);
      expect(reprobeSpy).not.toHaveBeenCalled();
    });

    it('allows targeted artwork backfill in evaluateGameNeedsStoreMediaSync when metadataQuality === authoritative and capsuleImage is missing or unsuitable', () => {
      const authoritativeMissingCover = makeSyntheticGame({
        id: 'steam-975410',
        title: 'Synthetic Authoritative Missing Cover',
        steamAppId: 975410,
        capsuleImage: undefined,
        enrichedMetadata: makeSyntheticEnrichedMetadata({
          appId: 975410,
          metadataQuality: 'authoritative',
        }),
      });

      const authoritativeUnsuitableCover = makeSyntheticGame({
        id: 'gog-8800411',
        title: 'Synthetic Authoritative Cropped Cover',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'gog', platformGameId: '8800411', installed: false }],
        capsuleImage:
          'https://images.gog-statics.com/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc_glx_vertical_cover.jpg',
        enrichedMetadata: makeSyntheticEnrichedMetadata({
          appId: 0,
          metadataQuality: 'authoritative',
        }),
      });

      const authoritativeValidCover = makeSyntheticGame({
        id: 'steam-975412',
        title: 'Synthetic Authoritative Valid Cover',
        steamAppId: 975412,
        capsuleImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975412/library_600x900.jpg',
        enrichedMetadata: makeSyntheticEnrichedMetadata({
          appId: 975412,
          metadataQuality: 'authoritative',
        }),
      });

      expect(evaluateGameNeedsStoreMediaSync(authoritativeMissingCover, false)).toEqual({
        eligible: true,
        alreadyEnriched: false,
      });
      expect(evaluateGameNeedsStoreMediaSync(authoritativeUnsuitableCover, false)).toEqual({
        eligible: true,
        alreadyEnriched: false,
      });
      expect(evaluateGameNeedsStoreMediaSync(authoritativeValidCover, false)).toEqual({
        eligible: false,
        alreadyEnriched: true,
      });
    });

    it('chains concurrent background startCriticScoreSync and startStoreMediaSync via FIFO queue during whenStagedCacheHydrated() without cancelling sibling warmup', async () => {
      const executionOrder: string[] = [];
      let releaseHydration!: (count: number) => void;
      const hydrationGate = new Promise<number>((resolve) => {
        releaseHydration = resolve;
      });

      vi.spyOn(stagedCacheService, 'whenStagedCacheHydrated').mockReturnValue(hydrationGate);
      vi.spyOn(stagedCacheService, 'hasFreshMediaSyncAttempt').mockReturnValue(false);
      vi.spyOn(stagedCacheService, 'recordMediaSyncAttempt').mockImplementation(() => {});
      vi.spyOn(steamMatcher, 'getEffectiveSteamAppId').mockImplementation(
        (g) => g?.steamAppId ?? undefined
      );
      vi.spyOn(steamApi, 'fetchStoreBrowseAssetsBatch').mockResolvedValue(new Map());

      vi.spyOn(criticScoreService, 'hasValidCachedResolution').mockReturnValue(false);
      vi.spyOn(criticScoreService, 'hasAttemptedDynamicResolution').mockReturnValue(false);
      vi.spyOn(criticScoreService, 'resolveDynamicScore').mockImplementation(async () => {
        executionOrder.push('critic:start');
        await new Promise((r) => setTimeout(r, 15));
        executionOrder.push('critic:end');
        return {
          id: 'synth-oc-1',
          score: 88,
          tier: 'Mighty',
          source: 'opencritic',
          url: 'https://opencritic.example.invalid/game/1',
          isVerified: true,
        };
      });

      vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId) => {
        executionOrder.push('media:start');
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push('media:end');
        return makeSyntheticEnrichedMetadata({
          appId,
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
        });
      });

      const mgr = new SyncJobManager();
      const cancelSpy = vi.spyOn(mgr, 'cancelJob');

      const game = makeSyntheticGame({
        id: 'steam-975420',
        title: 'Synthetic Sibling Warmup Game',
        steamAppId: 975420,
        capsuleImage: undefined,
        enrichedMetadata: undefined,
      });

      // Launch BOTH background warmups concurrently while staged cache hydration is pending
      const criticPromise = mgr.startCriticScoreSync([game], { isBackgroundWarmup: true });
      const updatedGames: CanonicalGame[] = [];
      const mediaPromise = mgr.startStoreMediaSync([game], (u) => updatedGames.push(u), {
        incremental: true,
        isBackgroundWarmup: true,
      });

      expect(executionOrder).toEqual([]);

      releaseHydration(0);
      await Promise.all([criticPromise, mediaPromise]);

      // Zero sibling cancellations; strict FIFO ordering: critic finishes cleanly before media starts!
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(executionOrder).toEqual(['critic:start', 'critic:end', 'media:start', 'media:end']);
      expect(updatedGames).toHaveLength(1);
    });

    it('dispatches a polite one-time-per-session P2 cover queueHydration pass from useBackgroundMediaWarmup even when gamesNeedingWarmup.length === 0', async () => {
      vi.useFakeTimers();

      const queueHydrationSpy = vi.fn(async () => ({ success: true, queued: 2 }));
      const winRecord = globalThis.window as unknown as Record<string, unknown>;
      winRecord.__ENABLE_AUTO_STORE_MEDIA_WARMUP__ = true;
      winRecord.electronAPI = {
        offlineVault: {
          queueHydration: queueHydrationSpy,
        },
      };

      const startMediaSpy = vi.spyOn(syncJobManager, 'startStoreMediaSync');
      vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);

      // Both games are already authoritatively enriched with valid covers -> gamesNeedingWarmup === []
      const catalog: CanonicalGame[] = [
        makeSyntheticGame({
          id: 'steam-975430',
          title: 'Synthetic Already Enriched Steam',
          steamAppId: 975430,
          capsuleImage:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975430/library_600x900_2x.jpg',
          iconUrl:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975430/icon.jpg',
          enrichedMetadata: makeSyntheticEnrichedMetadata({ appId: 975430 }),
        }),
        makeSyntheticGame({
          id: 'epic-synth-431',
          title: 'Synthetic Already Enriched Epic',
          isExplicitNonSteam: true,
          platforms: [{ platformId: 'epic', platformGameId: 'synth-431', installed: false }],
          capsuleImage: 'https://cdn1.epicgames.com/offer/synth/EGS_Enriched_Tall.jpg',
          enrichedMetadata: makeSyntheticEnrichedMetadata({
            appId: 0,
            enrichedSource: 'epic',
            metadataQuality: 'authoritative',
          }),
        }),
      ];

      expect(buildP2CoverHydrationBatch(catalog)).toHaveLength(2);

      const gamesRef = { current: catalog };
      const setGames = vi.fn();
      const setIsSyncingAllMedia = vi.fn();

      function WarmupHarness(props: { items: CanonicalGame[] }) {
        useBackgroundMediaWarmup({
          games: props.items,
          gamesRef,
          isHibernating: false,
          runningGamesCount: 0,
          isModalSuspended: false,
          isBootHydrating: false,
          setGames,
          setIsSyncingAllMedia,
        });
        return null;
      }

      const root = mountClientComponent(WarmupHarness, { items: catalog });
      try {
        // Advance past vitest warmup timer (120ms) and flush dynamic import microtasks
        await vi.advanceTimersByTimeAsync(200);

        // No metadata enrichment needed, YET polite P2 cover hydration pass ran once with aligned URLs!
        expect(startMediaSpy).not.toHaveBeenCalled();
        expect(queueHydrationSpy).toHaveBeenCalledTimes(1);

        const firstCallArg = (
          queueHydrationSpy.mock.calls as unknown as Array<
            [{ games: Array<{ gameId: string; priority?: number; assets: Array<{ role: string; url: string }> }> }]
          >
        )[0]?.[0];
        expect(firstCallArg?.games).toHaveLength(2);
        expect(firstCallArg?.games[0].priority).toBe(2);
        expect(firstCallArg?.games[0].assets.find((a) => a.role === 'cover')?.url).toBe(
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975430/library_600x900.jpg'
        );
        expect(firstCallArg?.games[1].priority).toBe(2);
        expect(firstCallArg?.games[1].assets.find((a) => a.role === 'cover')?.url).toBe(
          'https://cdn1.epicgames.com/offer/synth/EGS_Enriched_Tall.jpg?h=480&resize=1'
        );

        // Re-rendering with another game added in the same session must NOT re-queue duplicate P2 pass
        const expanded = [...catalog, makeSyntheticGame({
          id: 'steam-975432',
          title: 'Synthetic Enriched Third',
          steamAppId: 975432,
          capsuleImage:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/975432/library_600x900.jpg',
          enrichedMetadata: makeSyntheticEnrichedMetadata({ appId: 975432 }),
        })];
        gamesRef.current = expanded;
        root.rerender({ items: expanded });
        await vi.advanceTimersByTimeAsync(250);

        expect(queueHydrationSpy).toHaveBeenCalledTimes(1);
      } finally {
        root.unmount();
      }
    });
  });
});
