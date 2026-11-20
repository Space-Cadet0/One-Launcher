import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalGame } from '../src/contracts/game';
import {
  DEFAULT_LIBRARY_FILTER_STATE,
  LibraryFilterState,
  activeGameFilterToLibraryFilterState,
  countActiveFilterCriteria,
  isLibraryFilterActive,
  isReleaseYearRangeActive,
} from '../src/contracts/filter';
import {
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
  describeActiveFilterChips,
} from '../src/services/filter/libraryFilterIndex';
import { LibraryFilterPanel } from '../src/components/Library/LibraryFilterPanel';
import { LibraryGridView } from '../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import { launcherService } from '../src/services/launcher/launcherService';
import * as userTagStorage from '../src/services/storage/userTagStorage';
import * as openCriticModule from '../src/services/opencritic/openCritic';

const ROOT_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Headless Browser Polyfills & Stateful React 19 Component Harness
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();
const globalRecord = globalThis as Record<string, unknown>;

if (typeof globalRecord.localStorage === 'undefined') {
  globalRecord.localStorage = mockStorage;
}

const eventTarget = new EventTarget();

if (typeof globalRecord.window === 'undefined') {
  globalRecord.window = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
    location: { hostname: 'example.com' },
    innerWidth: 1440,
    innerHeight: 900,
    open: vi.fn(),
  };
} else {
  (globalRecord.window as Record<string, unknown>).localStorage =
    globalRecord.localStorage || mockStorage;
}

if (typeof globalRecord.document === 'undefined') {
  globalRecord.document = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    body: {},
  };
}

interface TestVNodeProps {
  children?: unknown;
  onClick: (...args: unknown[]) => unknown;
  onChange: (...args: unknown[]) => unknown;
  min?: number;
  max?: number;
  className?: string;
  autoCorrect?: string;
  autoCapitalize?: string;
  spellCheck?: boolean;
  htmlFor?: string;
  id?: string;
  title?: string;
  [key: string]: unknown;
}

interface TestVNode {
  type?: unknown;
  props: TestVNodeProps;
}

function getTextContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props) return getTextContent(props.children);
  }
  return '';
}

function findElements(
  node: unknown,
  predicate: (el: TestVNode) => boolean,
  acc: TestVNode[] = []
): TestVNode[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  const el = node as TestVNode;
  if (predicate(el)) acc.push(el);
  if (el.props && el.props.children) {
    findElements(el.props.children, predicate, acc);
  }
  return acc;
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => void | (() => void) }> = [];

    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = effectIdx++;
      const oldDeps = prevDeps[idx];
      const changed =
        !oldDeps ||
        !deps ||
        oldDeps.length !== deps.length ||
        deps.some((d, i) => !Object.is(d, oldDeps[i]));
      if (changed) {
        prevDeps[idx] = deps;
        pendingEffects.push({ idx, fn });
      }
    };

    const dispatcher = {
      useState<T>(initial: T | (() => T)) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => T)() : initial);
        }
        const setState = (updater: T | ((prev: T) => T)) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: T) => T)(states[idx] as T)
              : updater;
        };
        return [states[idx], setState];
      },
      useRef<T>(initial: T) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo<T>(fn: () => T) {
        return fn();
      },
      useCallback<T>(fn: T) {
        return fn;
      },
      useDeferredValue<T>(val: T) {
        return val;
      },
    };

    // Expand nested custom function components (such as LibraryFilterPanel inside LibraryGridView)
    const expandNode = (node: unknown): unknown => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(expandNode);
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (typeof el.type === 'function' && el.type === LibraryFilterPanel) {
        const renderedChild = (el.type as (props: unknown) => unknown)(el.props);
        return expandNode(renderedChild);
      }
      if (el.props && el.props.children) {
        return {
          ...el,
          props: {
            ...el.props,
            children: expandNode(el.props.children),
          },
        };
      }
      return el;
    };

    internals.H = dispatcher;
    let tree: unknown;
    try {
      const rawTree = Component(currentProps);
      tree = expandNode(rawTree);
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (cleanups[eff.idx]) {
        try {
          cleanups[eff.idx]!();
        } catch {
          // ignore
        }
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    return tree;
  };

  return { render };
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------
const SAMPLE_GAMES: CanonicalGame[] = [
  {
    id: 'game-bg3',
    title: "Baldur's Gate 3",
    sortTitle: "Baldur's Gate 3",
    steamAppId: 1086940,
    nativePlatforms: ['windows', 'mac'],
    headerImage: '',
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '1086940',
        installed: true,
        achievements: { unlocked: 20, total: 54, percentage: 37 },
      },
    ],
    genres: ['RPG', 'Adventure', 'Strategy'],
    tags: ['Single-player', 'Online Co-op', 'Steam Cloud', 'Full controller support'],
    developers: ['Larian Studios'],
    publishers: ['Larian Studios'],
    releaseDate: 'Aug 3, 2023',
    reviewSummary: {
      reviewScore: 9,
      totalPositive: 480000,
      totalNegative: 20000,
      reviewScoreDesc: 'Overwhelmingly Positive',
      positivePercent: 96,
      totalReviews: 500000,
    },
  },
  {
    id: 'game-cp2077',
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    nativePlatforms: ['windows'],
    headerImage: '',
    platforms: [
      {
        platformId: 'gog',
        platformGameId: '1423049311',
        installed: true,
        isWindowsBinaryOnMac: true,
        achievements: { unlocked: 10, total: 44, percentage: 23 },
      },
    ],
    genres: ['RPG', 'Action'],
    tags: ['Single-player', 'HDR', 'Cloud Saves', 'Controller'],
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    releaseDate: 'Dec 10, 2020',
    reviewSummary: {
      reviewScore: 8,
      totalPositive: 498000,
      totalNegative: 102000,
      reviewScoreDesc: 'Very Positive',
      positivePercent: 83,
      totalReviews: 600000,
    },
    hdrSupport: true,
  } as CanonicalGame,
  {
    id: 'game-disco',
    title: 'Disco Elysium - The Final Cut',
    sortTitle: 'Disco Elysium - The Final Cut',
    steamAppId: 632470,
    nativePlatforms: ['mac'],
    headerImage: '',
    platforms: [{ platformId: 'epic', platformGameId: 'disco', installed: false }],
    genres: ['rpg', 'Indie'],
    tags: ['Single-player'],
    developers: ['ZA/UM'],
    publishers: ['ZA/UM'],
    releaseDate: 'Oct 15, 2019',
    reviewSummary: {
      reviewScore: 9,
      totalPositive: 79050,
      totalNegative: 5950,
      reviewScoreDesc: 'Very Positive',
      positivePercent: 93,
      totalReviews: 85000,
    },
  },
  {
    id: 'game-starfield',
    title: 'Starfield',
    sortTitle: 'Starfield',
    steamAppId: 1716740,
    nativePlatforms: ['windows'],
    headerImage: '',
    platforms: [{ platformId: 'steam', platformGameId: '1716740', installed: false }],
    genres: ['RPG', 'Simulation'],
    tags: ['Single-player', 'Steam Cloud'],
    developers: ['Bethesda Game Studios'],
    publishers: ['Bethesda Softworks'],
    releaseDate: 'Sep 6, 2023',
    reviewSummary: {
      reviewScore: 6,
      totalPositive: 57820,
      totalNegative: 40180,
      reviewScoreDesc: 'Mixed',
      positivePercent: 59,
      totalReviews: 98000,
    },
  },
  {
    id: 'game-retro-tba',
    title: 'Mystery Retro Prototype',
    sortTitle: 'Mystery Retro Prototype',
    nativePlatforms: ['windows'],
    headerImage: '',
    platforms: [{ platformId: 'gog', platformGameId: '99999', installed: false }],
    genres: ['Arcade'],
    tags: ['Multiplayer', 'PvP'],
    developers: ['PixelForge Dev'],
    publishers: ['RetroPub Inc'],
    releaseDate: 'TBA',
    reviewSummary: {
      reviewScore: 4,
      totalPositive: 128,
      totalNegative: 272,
      reviewScoreDesc: 'Mostly Negative',
      positivePercent: 32,
      totalReviews: 400,
    },
  },
  {
    id: 'game-halo',
    title: 'Halo: The Master Chief Collection',
    sortTitle: 'Halo: The Master Chief Collection',
    steamAppId: 976730,
    nativePlatforms: ['windows'],
    headerImage: '',
    platforms: [{ platformId: 'steam', platformGameId: '976730', installed: false }],
    genres: ['Action', 'Shooter'],
    tags: ['Single-player', 'Online PvP', 'Online Co-op', 'Full controller support', 'Steam Achievements'],
    developers: ['343 Industries'],
    publishers: ['Xbox Game Studios'],
    releaseDate: 'Dec 3, 2019',
    reviewSummary: {
      reviewScore: 7,
      totalPositive: 159600,
      totalNegative: 50400,
      reviewScoreDesc: 'Mostly Positive',
      positivePercent: 76,
      totalReviews: 210000,
    },
  },
];

describe('v2 6-Category Library Filter System & Dual-Range Release Year Slider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(userTagStorage.STORAGE_KEY_USER_TAG_OVERRIDES);
  });

  describe('Category 1 — OS & Compatibility (mac_native, windows_native, mac_compat_layer)', () => {
    it('accurately indexes and filters macOS Native, Windows Native, and CrossOver/Wine compatible titles', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);

      // game-bg3 (mac+win) & game-disco (mac) are mac_native
      expect(index.osCounts.mac_native).toBe(2);
      // game-bg3, game-cp2077, game-starfield, game-retro-tba, game-halo are windows_native
      expect(index.osCounts.windows_native).toBe(5);
      // Windows-only games (cp2077, starfield, retro-tba, halo) are eligible for mac_compat_layer
      expect(index.osCounts.mac_compat_layer).toBe(4);

      const macNativeFiltered = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: ['mac_native'],
      });
      expect(macNativeFiltered.map((g) => g.id)).toEqual(['game-bg3', 'game-disco']);

      const winNativeFiltered = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: ['windows_native'],
      });
      expect(winNativeFiltered.map((g) => g.id)).toEqual([
        'game-bg3',
        'game-cp2077',
        'game-starfield',
        'game-retro-tba',
        'game-halo',
      ]);

      const compatFiltered = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: ['mac_compat_layer'],
      });
      expect(compatFiltered.map((g) => g.id)).toEqual([
        'game-cp2077',
        'game-starfield',
        'game-retro-tba',
        'game-halo',
      ]);
    });
  });

  describe('Category 2 — Rating (criticTiers, minCriticScore, reviewSentiments)', () => {
    it('filters by Critic Tier, Minimum Critic Score, and Player Review Sentiment while calling getOpenCriticData with skipBackgroundTrigger = true', () => {
      const ocSpy = vi.spyOn(openCriticModule, 'getOpenCriticData').mockImplementation(
        (_steamAppId, title = '', _pos, _rel, _ovr, _allowUnverified, skipBackgroundTrigger) => {
          expect(skipBackgroundTrigger).toBe(true);
          if (title.includes("Baldur's Gate 3")) {
            return { score: 96, percentRecommended: 98, tier: 'Mighty', source: 'metacritic', url: '', isVerified: true };
          }
          if (title.includes('Disco Elysium')) {
            return { score: 91, percentRecommended: 94, tier: 'Mighty', source: 'metacritic', url: '', isVerified: true };
          }
          if (title.includes('Cyberpunk 2077') || title.includes('Halo')) {
            return { score: 81, percentRecommended: 80, tier: 'Strong', source: 'metacritic', url: '', isVerified: true };
          }
          if (title.includes('Starfield')) {
            return { score: 71, percentRecommended: 65, tier: 'Fair', source: 'metacritic', url: '', isVerified: true };
          }
          return { score: 52, percentRecommended: 30, tier: 'Weak', source: 'metacritic', url: '', isVerified: true };
        }
      );

      const index = buildLibraryFilterIndex(SAMPLE_GAMES);
      expect(ocSpy).toHaveBeenCalledTimes(SAMPLE_GAMES.length);
      expect(index.criticTierCounts).toEqual({
        mighty: 2,
        strong: 2,
        fair: 1,
        weak: 1,
      });

      // Critic Tier filter
      expect(
        evaluateLibraryFilter(SAMPLE_GAMES, index, {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          criticTiers: ['mighty'],
        }).map((g) => g.id)
      ).toEqual(['game-bg3', 'game-disco']);

      expect(
        evaluateLibraryFilter(SAMPLE_GAMES, index, {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          criticTiers: ['fair', 'weak'],
        }).map((g) => g.id)
      ).toEqual(['game-starfield', 'game-retro-tba']);

      // Minimum Critic Score filter (80+ and 90+)
      expect(
        evaluateLibraryFilter(SAMPLE_GAMES, index, {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          minCriticScore: 80,
        }).map((g) => g.id)
      ).toEqual(['game-bg3', 'game-cp2077', 'game-disco', 'game-halo']);

      expect(
        evaluateLibraryFilter(SAMPLE_GAMES, index, {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          minCriticScore: 90,
        }).map((g) => g.id)
      ).toEqual(['game-bg3', 'game-disco']);

      // Player Review Sentiment filter
      expect(index.reviewSentimentCounts).toEqual({
        overwhelmingly_positive: 1,
        very_positive: 2,
        mostly_positive: 1,
        mixed: 1,
        negative: 1,
      });

      expect(
        evaluateLibraryFilter(SAMPLE_GAMES, index, {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          reviewSentiments: ['overwhelmingly_positive'],
        }).map((g) => g.id)
      ).toEqual(['game-bg3']);

      expect(
        evaluateLibraryFilter(SAMPLE_GAMES, index, {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          reviewSentiments: ['mixed', 'negative'],
        }).map((g) => g.id)
      ).toEqual(['game-starfield', 'game-retro-tba']);
    });
  });

  describe('Category 3 — Genres (ANY vs ALL match mode)', () => {
    it('supports OR (any) vs AND (all) multi-genre filtering and case-insensitive genre normalization', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);

      // 'RPG' and 'rpg' normalize to key 'rpg' with count 4
      const rpgFacet = index.genreCounts.find((g) => g.key === 'rpg');
      expect(rpgFacet).toBeDefined();
      expect(rpgFacet?.count).toBe(4);

      // OR mode ('any'): RPG or Action -> bg3, cp2077, disco, starfield, halo
      const anyGenreMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        genres: ['RPG', 'Action'],
        genreMatchMode: 'any',
      });
      expect(anyGenreMatches.map((g) => g.id)).toEqual([
        'game-bg3',
        'game-cp2077',
        'game-disco',
        'game-starfield',
        'game-halo',
      ]);

      // AND mode ('all'): RPG AND Action -> only cp2077
      const allGenreMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        genres: ['rpg', 'ACTION'],
        genreMatchMode: 'all',
      });
      expect(allGenreMatches.map((g) => g.id)).toEqual(['game-cp2077']);
    });
  });

  describe('Category 4 — Features & Capabilities', () => {
    it('composes selected features with AND logic across all 7 capability flags', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);

      expect(index.featureCounts.singleplayer).toBeGreaterThanOrEqual(5);
      expect(index.featureCounts.coop).toBeGreaterThanOrEqual(2);
      expect(index.featureCounts.multiplayer).toBeGreaterThanOrEqual(2);
      expect(index.featureCounts.controller).toBeGreaterThanOrEqual(3);
      expect(index.featureCounts.cloud_saves).toBeGreaterThanOrEqual(3);
      expect(index.featureCounts.achievements).toBeGreaterThanOrEqual(3);
      expect(index.featureCounts.hdr).toBeGreaterThanOrEqual(1);

      // Single-player + Co-op + Controller + Achievements -> bg3 and halo
      const coopControllerMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        features: ['singleplayer', 'coop', 'controller', 'achievements'],
      });
      expect(coopControllerMatches.map((g) => g.id)).toEqual(['game-bg3', 'game-halo']);

      // HDR + Cloud Saves + Controller -> cp2077
      const hdrCloudMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        features: ['hdr', 'cloud_saves', 'controller'],
      });
      expect(hdrCloudMatches.map((g) => g.id)).toEqual(['game-cp2077']);
    });
  });

  describe('Category 5 — Release Date (Two-Point From/To Year Slider & Unknown Year Toggle)', () => {
    it('computes minReleaseYear/maxReleaseYear bounds and filters by [fromYear, toYear] range and includeUnknownReleaseYear', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);

      expect(index.minReleaseYear).toBe(2019);
      expect(index.maxReleaseYear).toBe(2023);
      expect(index.unknownReleaseYearCount).toBe(1); // game-retro-tba ('TBA')

      // Range [2019, 2020] with includeUnknownReleaseYear = false -> cp2077 (2020), disco (2019), halo (2019)
      const rangeWithoutUnknown = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        releaseYearRange: [2019, 2020],
        includeUnknownReleaseYear: false,
      });
      expect(rangeWithoutUnknown.map((g) => g.id)).toEqual([
        'game-cp2077',
        'game-disco',
        'game-halo',
      ]);

      // Range [2019, 2020] with includeUnknownReleaseYear = true -> also includes game-retro-tba
      const rangeWithUnknown = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        releaseYearRange: [2019, 2020],
        includeUnknownReleaseYear: true,
      });
      expect(rangeWithUnknown.map((g) => g.id)).toEqual([
        'game-cp2077',
        'game-disco',
        'game-retro-tba',
        'game-halo',
      ]);
    });

    it('renders both From and To range slider inputs in LibraryFilterPanel, updates the readout, clamps from <= to, and filters games', () => {
      const gamesWithWideYears: CanonicalGame[] = [
        ...SAMPLE_GAMES,
        {
          id: 'game-1998',
          title: 'Half-Life (1998)',
          sortTitle: 'Half-Life (1998)',
          nativePlatforms: ['windows'],
          headerImage: '',
          platforms: [{ platformId: 'steam', platformGameId: '70', installed: false }],
          genres: ['Action'],
          tags: ['Single-player'],
          developers: ['Valve'],
          publishers: ['Valve'],
          releaseDate: 'Nov 19, 1998',
        },
      ];
      const index = buildLibraryFilterIndex(gamesWithWideYears);
      expect(index.minReleaseYear).toBe(1998);
      expect(index.maxReleaseYear).toBe(2023);

      let currentFilterState: LibraryFilterState = { ...DEFAULT_LIBRARY_FILTER_STATE };
      const harness = createComponentHarness(LibraryFilterPanel, {
        filterState: currentFilterState,
        onChange: (next) => {
          currentFilterState = next;
        },
        onReset: () => {
          currentFilterState = { ...DEFAULT_LIBRARY_FILTER_STATE };
        },
        filterIndex: index,
        filteredCount: gamesWithWideYears.length,
        totalCount: gamesWithWideYears.length,
      });

      const tree1 = harness.render();
      const fromSlider1 = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'release-year-slider-from'
      )[0];
      const toSlider1 = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'release-year-slider-to'
      )[0];
      const readout1 = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'release-year-range-readout'
      )[0];

      expect(fromSlider1).toBeDefined();
      expect(fromSlider1.props['aria-label']).toBe('Release year from');
      expect(fromSlider1.props.min).toBe(1998);
      expect(fromSlider1.props.max).toBe(2023);

      expect(toSlider1).toBeDefined();
      expect(toSlider1.props['aria-label']).toBe('Release year to');
      expect(toSlider1.props.min).toBe(1998);
      expect(toSlider1.props.max).toBe(2023);
      expect(getTextContent(readout1)).toBe('1998 — 2023');

      // Move From slider to 2015
      fromSlider1.props.onChange({ target: { value: '2015' } });
      expect(currentFilterState.releaseYearRange).toEqual([2015, 2023]);

      const tree2 = harness.render({ filterState: currentFilterState });
      const toSlider2 = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'release-year-slider-to'
      )[0];
      // Move To slider to 2020
      toSlider2.props.onChange({ target: { value: '2020' } });
      expect(currentFilterState.releaseYearRange).toEqual([2015, 2020]);

      const tree3 = harness.render({ filterState: currentFilterState });
      const readout3 = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'release-year-range-readout'
      )[0];
      expect(getTextContent(readout3)).toBe('2015 — 2020');

      // Verify clamping: attempting to drag From slider past To (e.g. 2022 > 2020) clamps From to 2020
      const fromSlider3 = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'release-year-slider-from'
      )[0];
      fromSlider3.props.onChange({ target: { value: '2022' } });
      expect(currentFilterState.releaseYearRange).toEqual([2020, 2020]);

      // Verify clamping: attempting to drag To slider below From (e.g. 2010 < 2020) clamps To to 2020
      const tree4 = harness.render({ filterState: currentFilterState });
      const toSlider4 = findElements(
        tree4,
        (el) => el.props?.['data-testid'] === 'release-year-slider-to'
      )[0];
      toSlider4.props.onChange({ target: { value: '2010' } });
      expect(currentFilterState.releaseYearRange).toEqual([2020, 2020]);
    });

    it('renders both release-year-slider-from and release-year-slider-to range inputs with dual-range-input styling', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);
      const harness = createComponentHarness(LibraryFilterPanel, {
        filterState: DEFAULT_LIBRARY_FILTER_STATE,
        onChange: () => {},
        onReset: () => {},
        filterIndex: index,
        filteredCount: SAMPLE_GAMES.length,
        totalCount: SAMPLE_GAMES.length,
      });
      const tree = harness.render();
      const fromSlider = findElements(
        tree,
        (el) => el.props?.['data-testid'] === 'release-year-slider-from'
      )[0];
      const toSlider = findElements(
        tree,
        (el) => el.props?.['data-testid'] === 'release-year-slider-to'
      )[0];
      expect(fromSlider?.type).toBe('input');
      expect(fromSlider?.props?.type).toBe('range');
      expect(fromSlider?.props?.className).toContain('dual-range-input');
      expect(toSlider?.type).toBe('input');
      expect(toSlider?.props?.type).toBe('range');
      expect(toSlider?.props?.className).toContain('dual-range-input');
    });
  });

  describe('Category 6 — Creator (Developers & Publishers)', () => {
    it('classifies creator roles (developer, publisher, both), supports search filtering, and filters by multi-creator selection', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);

      const larian = index.creatorCounts.find((c) => c.key === 'larian studios');
      const bethesdaDev = index.creatorCounts.find((c) => c.key === 'bethesda game studios');
      const bethesdaPub = index.creatorCounts.find((c) => c.key === 'bethesda softworks');

      expect(larian?.role).toBe('both');
      expect(bethesdaDev?.role).toBe('developer');
      expect(bethesdaPub?.role).toBe('publisher');

      // Multi-creator filter (OR across selected creators)
      const creatorMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        creators: ['Larian Studios', 'Xbox Game Studios'],
      });
      expect(creatorMatches.map((g) => g.id)).toEqual(['game-bg3', 'game-halo']);

      // Search input filtering inside LibraryFilterPanel
      const harness = createComponentHarness(LibraryFilterPanel, {
        filterState: DEFAULT_LIBRARY_FILTER_STATE,
        onChange: () => {},
        onReset: () => {},
        filterIndex: index,
        filteredCount: SAMPLE_GAMES.length,
        totalCount: SAMPLE_GAMES.length,
      });

      const tree1 = harness.render();
      const creatorSearchInput = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'filter-creator-search'
      )[0];
      expect(creatorSearchInput).toBeDefined();

      creatorSearchInput.props.onChange({ target: { value: 'larian' } });
      const tree2 = harness.render();
      const creatorButtons = findElements(
        tree2,
        (el) =>
          typeof el.props?.['data-testid'] === 'string' &&
          el.props['data-testid'].startsWith('filter-creator-') &&
          el.props['data-testid'] !== 'filter-creator-search'
      );
      expect(creatorButtons).toHaveLength(1);
      expect(creatorButtons[0].props['data-testid']).toBe('filter-creator-larian studios');
    });
  });

  describe('UI Integration, Active Filter Chips & Strict v2 Constraints', () => {
    it('toggles LibraryFilterPanel from LibraryGridView, displays active filter chips, and supports chip removal & Clear All', () => {
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);
      let state: LibraryFilterState = { ...DEFAULT_LIBRARY_FILTER_STATE };

      const harness = createComponentHarness(LibraryGridView, {
        games: SAMPLE_GAMES,
        onSelectGame: () => {},
        libraryFilterState: state,
        libraryFilterIndex: index,
        onUpdateLibraryFilterState: (next) => {
          state = next;
        },
        onResetLibraryFilterState: () => {
          state = { ...DEFAULT_LIBRARY_FILTER_STATE };
        },
      });

      // Initially filter panel is closed
      const tree1 = harness.render();
      expect(
        findElements(tree1, (el) => el.props?.['data-testid'] === 'library-filter-panel')
      ).toHaveLength(0);

      // Click library-filter-toggle-btn to open the 6-category panel
      const toggleBtn = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'library-filter-toggle-btn'
      )[0];
      expect(toggleBtn).toBeDefined();
      toggleBtn.props.onClick();

      const tree2 = harness.render();
      expect(
        findElements(tree2, (el) => el.props?.['data-testid'] === 'library-filter-panel')
      ).toHaveLength(1);

      // Select macOS Native and RPG inside the opened panel
      const macBtn = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'filter-os-mac_native'
      )[0];
      expect(macBtn).toBeDefined();
      macBtn.props.onClick();
      expect(state.osCompatibility).toEqual(['mac_native']);

      const tree3 = harness.render({ libraryFilterState: state });
      const rpgBtn = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'filter-genre-rpg'
      )[0];
      expect(rpgBtn).toBeDefined();
      rpgBtn.props.onClick();
      expect(state.genres).toEqual(['rpg']);

      // Render with both filters active and verify active-filter-chips-bar
      const tree4 = harness.render({ libraryFilterState: state });
      const chipsBar = findElements(
        tree4,
        (el) => el.props?.['data-testid'] === 'active-filter-chips-bar'
      )[0];
      expect(chipsBar).toBeDefined();

      // Remove only the mac_native chip via its 1-click remove button
      const removeOsChipBtn = findElements(
        tree4,
        (el) => el.props?.['data-testid'] === 'remove-filter-chip-os:mac_native'
      )[0];
      expect(removeOsChipBtn).toBeDefined();
      removeOsChipBtn.props.onClick();
      expect(state.osCompatibility).toEqual([]);
      expect(state.genres).toEqual(['rpg']);

      // Click Clear All button to reset all filters
      const tree5 = harness.render({ libraryFilterState: state });
      const clearAllBtn = findElements(
        tree5,
        (el) => el.props?.['data-testid'] === 'clear-all-filters-btn'
      )[0];
      expect(clearAllBtn).toBeDefined();
      clearAllBtn.props.onClick();
      expect(state).toEqual(DEFAULT_LIBRARY_FILTER_STATE);
    });

    it('bridges SteamStorePage pill clicks (ActiveGameFilter) into LibraryFilterState via activeGameFilterToLibraryFilterState', () => {
      expect(
        activeGameFilterToLibraryFilterState({ type: 'os', label: 'Native OS', value: 'mac' })
          .osCompatibility
      ).toEqual(['mac_native']);

      expect(
        activeGameFilterToLibraryFilterState({
          type: 'opencritic',
          label: 'Rating',
          value: 'Mighty',
        }).criticTiers
      ).toEqual(['mighty']);

      expect(
        activeGameFilterToLibraryFilterState({
          type: 'review',
          label: 'Reviews',
          value: 'Overwhelmingly Positive',
        }).reviewSentiments
      ).toEqual(['overwhelmingly_positive']);

      expect(
        activeGameFilterToLibraryFilterState({
          type: 'developer',
          label: 'Developer',
          value: 'Larian Studios',
        }).creators
      ).toEqual(['Larian Studios']);

      expect(
        activeGameFilterToLibraryFilterState({
          type: 'feature',
          label: 'Feature',
          value: 'HDR available',
        }).features
      ).toEqual(['hdr']);

      expect(
        activeGameFilterToLibraryFilterState({
          type: 'genre',
          label: 'Genre',
          value: 'RPG',
        }).genres
      ).toEqual(['RPG']);

      const tagFilterState = activeGameFilterToLibraryFilterState({
        type: 'tag',
        label: 'Tag',
        value: 'Cozy',
      });
      expect(tagFilterState.tags).toEqual(['Cozy']);
      expect(tagFilterState.genres).toEqual([]);
      expect(tagFilterState.features).toEqual([]);

      // Even feature-like tag clicks route directly into `tags` (not `features` or `genres`)
      const coopTagState = activeGameFilterToLibraryFilterState({
        type: 'tag',
        label: 'Tag',
        value: 'Online Co-op',
      });
      expect(coopTagState.tags).toEqual(['Online Co-op']);
      expect(coopTagState.features).toEqual([]);
      expect(coopTagState.genres).toEqual([]);
    });

    it('enforces strict v2 constraints behaviorally: LibrarySidebar does not render LibraryFilterPanel and TopNavBar exposes interactive Storefront & Installed Only controls', () => {
      const sidebarHarness = createComponentHarness(LibrarySidebar, {
        games: SAMPLE_GAMES,
        selectedGameId: SAMPLE_GAMES[0].id,
        onSelectGame: vi.fn(),
        searchQuery: '',
        onSearchChange: vi.fn(),
        selectedPlatform: 'all',
        onSelectPlatform: vi.fn(),
        installedOnly: false,
        onToggleInstalledOnly: vi.fn(),
        collections: [],
        onOpenManageCollectionsModal: vi.fn(),
        onToggleGameInCollection: vi.fn(),
      });
      const sidebarTree = sidebarHarness.render();
      expect(
        findElements(sidebarTree, (el) => el.props?.['data-testid'] === 'library-filter-panel')
      ).toHaveLength(0);

      const onSelectPlatform = vi.fn();
      const onToggleInstalledOnly = vi.fn();
      const topNavHarness = createComponentHarness(TopNavBar, {
        selectedPlatform: 'steam',
        onSelectPlatform,
        installedOnly: false,
        onToggleInstalledOnly,
        totalGamesCount: SAMPLE_GAMES.length,
        filteredCount: SAMPLE_GAMES.length,
        isSyncing: false,
        onTriggerSync: vi.fn(),
        onHomeClick: vi.fn(),
        onOpenIntegrations: vi.fn(),
      });
      const topNavTree = topNavHarness.render();
      const buttons = findElements(topNavTree, (el) => el.type === 'button');
      const allLibrariesBtn = buttons.find((b) => JSON.stringify(b).includes('All Libraries'));
      const installedOnlyBtn = buttons.find((b) => JSON.stringify(b).includes('Installed Only'));

      expect(allLibrariesBtn).toBeDefined();
      expect(installedOnlyBtn).toBeDefined();

      allLibrariesBtn!.props.onClick();
      expect(onSelectPlatform).toHaveBeenCalledWith('all');

      installedOnlyBtn!.props.onClick();
      expect(onToggleInstalledOnly).toHaveBeenCalledTimes(1);
    });

    it('sorts games by Release Year (Newest First desc by default, Oldest First asc on second click) with unknown release years placed at the end', () => {
      window.localStorage.removeItem('one_launcher_grid_sort_by');
      window.localStorage.removeItem('one_launcher_grid_release_year_order');

      const index = buildLibraryFilterIndex(SAMPLE_GAMES);
      const harness = createComponentHarness(LibraryGridView, {
        games: SAMPLE_GAMES,
        onSelectGame: () => {},
        libraryFilterIndex: index,
      });

      const tree1 = harness.render();
      const releaseYearSortBtn1 = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'grid-sort-release-year'
      )[0];
      expect(releaseYearSortBtn1).toBeDefined();

      // 1st click: activates 'release_year' sort in 'desc' (Newest First) order
      releaseYearSortBtn1.props.onClick();
      expect(window.localStorage.getItem('one_launcher_grid_sort_by')).toBe('release_year');

      const tree2 = harness.render();
      const descGameIds = findElements(tree2, (el) => Boolean(el.props?.['data-game-id'])).map(
        (el) => el.props['data-game-id']
      );
      expect(descGameIds).toEqual([
        'game-bg3', // 2023
        'game-starfield', // 2023
        'game-cp2077', // 2020
        'game-disco', // 2019
        'game-halo', // 2019
        'game-retro-tba', // TBA (unknown year always at the end)
      ]);

      // 2nd click while already active: toggles order to 'asc' (Oldest First)
      const releaseYearSortBtn2 = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'grid-sort-release-year'
      )[0];
      releaseYearSortBtn2.props.onClick();
      expect(window.localStorage.getItem('one_launcher_grid_release_year_order')).toBe('asc');

      const tree3 = harness.render();
      const ascGameIds = findElements(tree3, (el) => Boolean(el.props?.['data-game-id'])).map(
        (el) => el.props['data-game-id']
      );
      expect(ascGameIds).toEqual([
        'game-disco', // 2019
        'game-halo', // 2019
        'game-cp2077', // 2020
        'game-bg3', // 2023
        'game-starfield', // 2023
        'game-retro-tba', // TBA (unknown year remains at the end)
      ]);
    });
  });

  describe('Performance Benchmark (1,000-Game Library)', () => {
    it('evaluates multi-category filtering across a 1,000-game catalog in < 5ms', () => {
      const syntheticGames: CanonicalGame[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `synth-game-${i}`,
        title: `Synthetic Game ${i}`,
        sortTitle: `Synthetic Game ${i}`,
        nativePlatforms: i % 3 === 0 ? ['windows', 'mac'] : ['windows'],
        headerImage: '',
        platforms: [
          {
            platformId: i % 2 === 0 ? 'steam' : 'gog',
            platformGameId: String(100000 + i),
            installed: i % 5 === 0,
            achievements: i % 2 === 0 ? { unlocked: 5, total: 20, percentage: 25 } : undefined,
          },
        ],
        genres: i % 2 === 0 ? ['RPG', 'Action'] : ['Strategy', 'Indie'],
        tags: ['Single-player', i % 4 === 0 ? 'Controller' : 'Co-op', 'Steam Cloud'],
        developers: [`Studio ${i % 25}`],
        publishers: [`Publisher ${i % 15}`],
        releaseDate: `Oct 15, ${1995 + (i % 30)}`,
        reviewSummary: {
          reviewScore: i % 2 === 0 ? 8 : 6,
          totalPositive: i % 2 === 0 ? 1056 : 660,
          totalNegative: i % 2 === 0 ? 144 : 540,
          reviewScoreDesc: i % 2 === 0 ? 'Very Positive' : 'Mixed',
          positivePercent: i % 2 === 0 ? 88 : 55,
          totalReviews: 1200,
        },
      }));

      const index = buildLibraryFilterIndex(syntheticGames);
      const multiCategoryFilter: LibraryFilterState = {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: ['mac_native'],
        reviewSentiments: ['very_positive'],
        genres: ['RPG', 'Action'],
        genreMatchMode: 'all',
        features: ['singleplayer', 'cloud_saves'],
        releaseYearRange: [2005, 2022],
        includeUnknownReleaseYear: false,
        creators: ['Studio 0', 'Studio 6', 'Publisher 3'],
      };

      const startMs = performance.now();
      const matched = evaluateLibraryFilter(syntheticGames, index, multiCategoryFilter);
      const elapsedMs = performance.now() - startMs;

      expect(matched.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(5);

      // Also verify 7-category evaluation including `tags` (ANY and ALL) stays < 5ms
      const withTagsFilter: LibraryFilterState = {
        ...multiCategoryFilter,
        tags: ['Single-player', 'Steam Cloud'],
        tagMatchMode: 'all',
      };
      const tagStartMs = performance.now();
      const tagMatched = evaluateLibraryFilter(syntheticGames, index, withTagsFilter);
      const tagElapsedMs = performance.now() - tagStartMs;
      expect(tagMatched.length).toBeGreaterThan(0);
      expect(tagElapsedMs).toBeLessThan(5);
    });
  });

  describe('Category 7 — Tags (ANY vs ALL, User Overrides, Chips & Progressive Disclosure)', () => {
    it('indexes effective tags using a single loadUserTagOverrides() call, supports ANY/ALL evaluation, and emits removable Tag chips', () => {
      // Apply user tag edits on bg3 (+Cozy Night, -Online Co-op) and disco (+Cozy Night)
      userTagStorage.addUserTagForGame(SAMPLE_GAMES[0], 'Cozy Night', SAMPLE_GAMES[0].tags);
      userTagStorage.removeUserTagForGame(SAMPLE_GAMES[0], 'Online Co-op', SAMPLE_GAMES[0].tags);
      userTagStorage.addUserTagForGame(SAMPLE_GAMES[2], 'Cozy Night', SAMPLE_GAMES[2].tags);

      const loadSpy = vi.spyOn(userTagStorage, 'loadUserTagOverrides');
      const index = buildLibraryFilterIndex(SAMPLE_GAMES);
      // Preloaded ONCE outside the games loop for < 5ms benchmark compliance
      expect(loadSpy).toHaveBeenCalledTimes(1);

      const cozyFacet = index.tagCounts.find((t) => t.key === 'cozy night');
      expect(cozyFacet).toEqual({ key: 'cozy night', label: 'Cozy Night', count: 2 });

      // Single-player is on 5 games, so it ranks ahead of Cozy Night (2)
      const singlePlayerIdx = index.tagCounts.findIndex((t) => t.key === 'single-player');
      const cozyIdx = index.tagCounts.findIndex((t) => t.key === 'cozy night');
      expect(singlePlayerIdx).toBeGreaterThanOrEqual(0);
      expect(cozyIdx).toBeGreaterThan(singlePlayerIdx);

      // Removed synced tag ('Online Co-op') is excluded from bg3, remaining only on halo
      const coopMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        tags: ['Online Co-op'],
        tagMatchMode: 'any',
      });
      expect(coopMatches.map((g) => g.id)).toEqual(['game-halo']);

      // ANY (OR) mode: Cozy Night OR Multiplayer -> bg3, disco, retro-tba
      const anyTagMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        tags: ['cozy night', 'multiplayer'],
        tagMatchMode: 'any',
      });
      expect(anyTagMatches.map((g) => g.id)).toEqual(['game-bg3', 'game-disco', 'game-retro-tba']);

      // ALL (AND) mode: Cozy Night AND Steam Cloud -> bg3 only
      const allTagMatches = evaluateLibraryFilter(SAMPLE_GAMES, index, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        tags: ['Cozy Night', 'Steam Cloud'],
        tagMatchMode: 'all',
      });
      expect(allTagMatches.map((g) => g.id)).toEqual(['game-bg3']);

      // countActiveFilterCriteria & isLibraryFilterActive account for tags
      const tagState: LibraryFilterState = {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        tags: ['cozy night', 'steam cloud'],
        tagMatchMode: 'all',
      };
      expect(countActiveFilterCriteria(tagState)).toBe(2);
      expect(isLibraryFilterActive(tagState)).toBe(true);

      // describeActiveFilterChips emits removable Tag chips with canonical display label
      const chips = describeActiveFilterChips(tagState, index);
      const cozyChip = chips.find((c) => c.id === 'tag:cozy night');
      expect(cozyChip).toBeDefined();
      expect(cozyChip?.category).toBe('Tag');
      expect(cozyChip?.label).toBe('Cozy Night');

      const afterRemove = cozyChip!.remove(tagState);
      expect(afterRemove.tags).toEqual(['steam cloud']);
    });

    it('renders full-width 7. Tags card with ANY/ALL mode, search input, top-40 + selected tags progressive disclosure, and updated toolbar tooltip', () => {
      // Build a catalog with 48 distinct tags so top-40 progressive disclosure engages
      const manyTags = Array.from({ length: 48 }, (_, i) => `CustomTag-${String(i + 1).padStart(2, '0')}`);
      const gamesWithManyTags: CanonicalGame[] = [
        {
          ...SAMPLE_GAMES[0],
          id: 'tag-heavy-1',
          tags: manyTags.slice(0, 48),
        },
        {
          ...SAMPLE_GAMES[1],
          id: 'tag-heavy-2',
          tags: manyTags.slice(0, 40),
        },
      ];

      const index = buildLibraryFilterIndex(gamesWithManyTags);
      expect(index.tagCounts.length).toBe(48);
      // Tail tag ranked #48 (count 1) is outside top-40
      const tailTag = index.tagCounts[47];
      expect(tailTag.count).toBe(1);

      // Pre-select the #48 tail tag so we verify selected tags outside top-40 stay visible!
      let state: LibraryFilterState = {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        tags: [tailTag.key],
      };

      const harness = createComponentHarness(LibraryFilterPanel, {
        filterState: state,
        onChange: (next) => {
          state = next;
        },
        onReset: () => {
          state = { ...DEFAULT_LIBRARY_FILTER_STATE };
        },
        filterIndex: index,
        filteredCount: 1,
        totalCount: 2,
      });

      const tree1 = harness.render();
      const tagsCard = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'filter-cat-tags'
      )[0];
      expect(tagsCard).toBeDefined();
      expect(tagsCard.props.className).toContain('md:col-span-2');
      expect(tagsCard.props.className).toContain('xl:col-span-3');
      expect(getTextContent(tagsCard)).toContain('7. Tags');

      // Verify search input accessibility & attributes
      const tagSearchInput = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'filter-tag-search'
      )[0];
      expect(tagSearchInput).toBeDefined();
      expect(tagSearchInput.props.autoCorrect).toBe('off');
      expect(tagSearchInput.props.autoCapitalize).toBe('none');
      expect(tagSearchInput.props.spellCheck).toBe(false);

      const srLabel = findElements(
        tagsCard,
        (el) => el.type === 'label' && el.props?.htmlFor === tagSearchInput.props.id
      )[0];
      expect(srLabel).toBeDefined();
      expect(getTextContent(srLabel)).toBe('Search tags');

      // Top 40 + 1 selected tail tag = 41 rendered pills, plus "Show all 48 tags" button
      const tagPills1 = findElements(
        tagsCard,
        (el) =>
          typeof el.props?.['data-testid'] === 'string' &&
          el.props['data-testid'].startsWith('filter-tag-') &&
          !el.props['data-testid'].startsWith('filter-tag-mode-') &&
          !el.props['data-testid'].startsWith('filter-tag-search')
      );
      expect(tagPills1).toHaveLength(41);
      expect(
        tagPills1.some((el) => el.props['data-testid'] === `filter-tag-${tailTag.key}` && el.props['aria-pressed'] === true)
      ).toBe(true);

      const showAllBtn = findElements(
        tagsCard,
        (el) => el.props?.['data-testid'] === 'filter-tags-show-all'
      )[0];
      expect(showAllBtn).toBeDefined();
      expect(getTextContent(showAllBtn)).toBe('Show all 48 tags');
      expect(showAllBtn.props['aria-expanded']).toBe(false);

      // Click "Show all 48 tags" -> all 48 pills render
      showAllBtn.props.onClick();
      const tree2 = harness.render();
      const tagPills2 = findElements(
        tree2,
        (el) =>
          typeof el.props?.['data-testid'] === 'string' &&
          el.props['data-testid'].startsWith('filter-tag-') &&
          !el.props['data-testid'].startsWith('filter-tag-mode-') &&
          !el.props['data-testid'].startsWith('filter-tag-search')
      );
      expect(tagPills2).toHaveLength(48);

      // Switch tag match mode to ALL
      const allModeBtn = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'filter-tag-mode-all'
      )[0];
      expect(allModeBtn).toBeDefined();
      allModeBtn.props.onClick();
      expect(state.tagMatchMode).toBe('all');

      // Live search filters immediately across all tags
      const searchInput2 = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'filter-tag-search'
      )[0];
      searchInput2.props.onChange({ target: { value: 'customtag-48' } });
      const tree3 = harness.render({ filterState: state });
      const tagPills3 = findElements(
        tree3,
        (el) =>
          typeof el.props?.['data-testid'] === 'string' &&
          el.props['data-testid'].startsWith('filter-tag-') &&
          !el.props['data-testid'].startsWith('filter-tag-mode-') &&
          !el.props['data-testid'].startsWith('filter-tag-search')
      );
      expect(tagPills3).toHaveLength(1);
      expect(tagPills3[0].props['data-testid']).toBe('filter-tag-customtag-48');

      // Verify LibraryGridToolbar tooltip no longer hardcodes "6-category"
      const gridHarness = createComponentHarness(LibraryGridView, {
        games: SAMPLE_GAMES,
        onSelectGame: () => {},
        libraryFilterIndex: buildLibraryFilterIndex(SAMPLE_GAMES),
      });
      const gridTree = gridHarness.render();
      const filterToggle = findElements(
        gridTree,
        (el) => el.props?.['data-testid'] === 'library-filter-toggle-btn'
      )[0];
      expect(filterToggle?.props?.title).toBe('Open library filter panel');
    });
  });

  describe('Task 5 — Windows (win32) mac_compat_layer Isolation in Filter Engine & Panel', () => {
    it('hides filter-os-mac_compat_layer, titles Category 1 "1. Operating System", and ignores mac_compat_layer in evaluation & chips on win32', () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');

      const winIndex = buildLibraryFilterIndex(SAMPLE_GAMES);
      expect(winIndex.osCounts.mac_compat_layer).toBe(0);
      expect(winIndex.osCounts.windows_native).toBe(5);
      expect(winIndex.osCounts.mac_native).toBe(2);

      // evaluateLibraryFilter strips mac_compat_layer on win32 instead of returning 0 games
      const compatOnlyResult = evaluateLibraryFilter(SAMPLE_GAMES, winIndex, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: ['mac_compat_layer'],
      });
      expect(compatOnlyResult.map((g) => g.id)).toEqual(SAMPLE_GAMES.map((g) => g.id));

      // describeActiveFilterChips strips mac_compat_layer on win32 while preserving valid chips
      const winChips = describeActiveFilterChips(
        {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          osCompatibility: ['windows_native', 'mac_compat_layer'],
        },
        winIndex
      );
      expect(winChips.map((c) => c.id)).toEqual(['os:windows_native']);

      // LibraryFilterPanel hides CrossOver / Wine (Mac) and uses "1. Operating System" heading
      const panelHarness = createComponentHarness(LibraryFilterPanel, {
        filterState: DEFAULT_LIBRARY_FILTER_STATE,
        onChange: () => {},
        onReset: () => {},
        filterIndex: winIndex,
        filteredCount: SAMPLE_GAMES.length,
        totalCount: SAMPLE_GAMES.length,
      });
      const panelTree = panelHarness.render();
      const osCard = findElements(
        panelTree,
        (el) => el.props?.['data-testid'] === 'filter-cat-os'
      )[0];
      expect(osCard).toBeDefined();
      const osCardText = getTextContent(osCard);
      expect(osCardText).toContain('1. Operating System');
      expect(osCardText).not.toContain('1. OS & Compatibility');
      expect(osCardText).not.toContain('CrossOver / Wine (Mac)');

      expect(
        findElements(panelTree, (el) => el.props?.['data-testid'] === 'filter-os-mac_compat_layer')
      ).toHaveLength(0);
      expect(
        findElements(panelTree, (el) => el.props?.['data-testid'] === 'filter-os-windows_native')
      ).toHaveLength(1);

      // F10: countActiveFilterCriteria and LibraryGridView toolbar badge strip mac_compat_layer on win32
      expect(
        countActiveFilterCriteria(
          {
            ...DEFAULT_LIBRARY_FILTER_STATE,
            osCompatibility: ['mac_compat_layer'],
          },
          undefined,
          { supportsWindowsTranslation: false }
        )
      ).toBe(0);
      expect(
        countActiveFilterCriteria(
          {
            ...DEFAULT_LIBRARY_FILTER_STATE,
            osCompatibility: ['windows_native', 'mac_compat_layer'],
          },
          undefined,
          { supportsWindowsTranslation: false }
        )
      ).toBe(1);

      const winGridHarness = createComponentHarness(LibraryGridView, {
        games: SAMPLE_GAMES,
        onSelectGame: () => {},
        libraryFilterIndex: winIndex,
        libraryFilterState: {
          ...DEFAULT_LIBRARY_FILTER_STATE,
          osCompatibility: ['mac_compat_layer'],
        },
      });
      const winGridTree = winGridHarness.render();
      const winFilterToggle = findElements(
        winGridTree,
        (el) => el.props?.['data-testid'] === 'library-filter-toggle-btn'
      )[0];
      expect(getTextContent(winFilterToggle).trim()).toBe('Filter');
    });
  });
});
