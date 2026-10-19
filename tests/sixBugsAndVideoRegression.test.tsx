import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import axios from 'axios';
import {
  stripHtmlToPlainSynopsis,
  fallbackMetadataProvider,
} from '../src/services/steam/fallbackMetadataProvider';
import { applyUserOverrideToGame } from '../src/services/storage/userOverrideStorage';
import {
  LibraryGridView,
  GRID_SORT_STORAGE_KEY,
  loadPersistedGridSort,
} from '../src/components/Library/LibraryGridView';
import { SteamHeroDetails } from '../src/components/SteamStoreDetail/SteamHeroDetails';
import { MediaGallery } from '../src/components/SteamStoreDetail/MediaGallery';
import { GameContextMenu } from '../src/components/Library/GameContextMenu';
import {
  isNonEnglishRegionalMovieName,
  filterEnglishMovies,
  steamApi,
} from '../src/services/steam/steamApi';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { requestScheduler } from '../src/services/network/requestScheduler';
import type { CanonicalGame } from '../src/contracts/game';
import type { UserGameOverride } from '../src/contracts/override';
import type { GameCollection } from '../src/contracts/collection';
import type { SteamScreenshot, SteamMovie } from '../src/contracts/steam';

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

// ---------------------------------------------------------------------------
// Headless Browser Environment Polyfills
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

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}

const eventTarget = new EventTarget();

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: any) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
    location: { hostname: 'example.com' },
    innerWidth: 1440,
    innerHeight: 900,
    open: vi.fn(),
  };
} else {
  (window as any).localStorage = (globalThis as any).localStorage || mockStorage;
  if (!(window as any).innerWidth) (window as any).innerWidth = 1440;
  if (!(window as any).innerHeight) (window as any).innerHeight = 900;
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    body: {},
  };
}

// ---------------------------------------------------------------------------
// Stateful React 19 Component Test Harness
// ---------------------------------------------------------------------------
function findElements(node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && node.props.children) {
    findElements(node.props.children, predicate, acc);
  }
  return acc;
}

function getTextContent(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && node.props) {
    return getTextContent(node.props.children);
  }
  return '';
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const prevDeps: Array<any[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => any }> = [];

    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => any, deps?: any[]) => {
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

    internals.H = {
      useState(initial: any) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? initial() : initial);
        }
        const setState = (updater: any) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: any) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => any) {
        return fn();
      },
      useCallback(fn: any) {
        return fn;
      },
    };

    let tree: any;
    try {
      tree = Component(currentProps);
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (typeof cleanups[eff.idx] === 'function') {
        cleanups[eff.idx]!();
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    return tree;
  };

  const unmount = () => {
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') cleanup();
    }
  };

  return { render, unmount, states, refs };
}

describe('Phase 3: Six Bugs & Epic Video Regression Verification Suite', () => {
  beforeEach(() => {
    localStorage.clear();
    requestScheduler.reset();
    requestScheduler.setEnforceDelays(false);
    criticScoreService.clearCache();
    (steamApi as any).cache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Bug 1: HTML in Synopsis
  // =========================================================================
  describe('1. Bug 1: HTML in Synopsis', () => {
    it('stripHtmlToPlainSynopsis strips <img>, <p>, <br>, <div>, BBCode, and HTML entities (&quot;, &#39;, &amp;, &mdash;)', () => {
      const rawGogHtml = `
        <div>
          <img src="https://items.gog.com/agony/steam_logos.png" />
          <p><strong>Agony</strong> is a first-person &quot;survival horror&quot; set in Hell&#39;s depths &amp; beyond &mdash; [b]escape[/b] the [url=https://gog.com]Red Goddess[/url].<br />Second line of lead paragraph.</p>
          <p>Second paragraph that should not bleed into the single-paragraph synopsis.</p>
        </div>
      `;

      const cleaned = stripHtmlToPlainSynopsis(rawGogHtml);

      expect(cleaned).not.toContain('<img');
      expect(cleaned).not.toContain('steam_logos.png');
      expect(cleaned).not.toContain('<p>');
      expect(cleaned).not.toContain('<div');
      expect(cleaned).not.toContain('<br');
      expect(cleaned).not.toContain('[b]');
      expect(cleaned).not.toContain('[url');
      expect(cleaned).not.toContain('&quot;');
      expect(cleaned).not.toContain('&#39;');
      expect(cleaned).not.toContain('&amp;');
      expect(cleaned).not.toContain('&mdash;');
      expect(cleaned).toContain(
        'Agony is a first-person "survival horror" set in Hell\'s depths & beyond — escape the Red Goddess.'
      );
    });

    it('applyUserOverrideToGame self-heals raw HTML in shortDescription while preserving it in detailedDescription', () => {
      const baseGame: CanonicalGame = {
        id: 'gog-agony',
        title: 'Agony',
        sortTitle: 'Agony',
        platforms: [{ platformId: 'gog', platformGameId: '1234567890', installed: false }],
        headerImage: 'https://example.com/agony-header.jpg',
        developers: ['Madmind Studio'],
        publishers: ['Madmind Studio'],
        genres: ['Horror'],
        tags: ['Horror'],
      };

      const htmlDescription =
        '<p><img src="https://items.gog.com/agony/steam_logos.png" />Begin your journey through the underworld &amp; survive the nightmare.</p><p>Full feature list below.</p>';

      const override: UserGameOverride = {
        gameId: 'gog-agony',
        title: 'Agony',
        shortDescription: htmlDescription,
      };

      const healed = applyUserOverrideToGame(baseGame, override);

      expect(healed.shortDescription).toBe(
        'Begin your journey through the underworld & survive the nightmare.'
      );
      expect(healed.shortDescription).not.toContain('<img');
      expect(healed.shortDescription).not.toContain('<p>');
      // Preserves full HTML in detailedDescription when detailedDescription was not separately provided
      expect(healed.detailedDescription).toBe(htmlDescription);
    });

    it('LibraryGridView hover synopsis and SteamHeroDetails render clean plain text without HTML tags', () => {
      const htmlShort =
        '<p><img src="https://items.gog.com/agony/steam_logos.png" />A dark &quot;survival&quot; odyssey &mdash; forged in fire &amp; brimstone.</p>';

      const heroHtml = renderToString(
        <SteamHeroDetails
          headerImage="https://example.com/agony.jpg"
          title="Agony"
          shortDescription={htmlShort}
        />
      );
      expect(heroHtml).not.toContain('steam_logos.png');
      expect(heroHtml).not.toContain('&lt;img');
      expect(heroHtml).not.toContain('&lt;p&gt;');
      expect(heroHtml).toContain('A dark &quot;survival&quot; odyssey — forged in fire &amp; brimstone.');

      // Verify LibraryGridView hover popover synopsis also strips raw HTML
      const gameWithHtml: CanonicalGame = {
        id: 'gog-agony',
        title: 'Agony',
        sortTitle: 'Agony',
        shortDescription: htmlShort,
        platforms: [{ platformId: 'gog', platformGameId: '999999', installed: true }],
        headerImage: 'https://example.com/agony.jpg',
        capsuleImage: 'https://example.com/agony-cover.jpg',
        developers: ['Madmind Studio'],
        publishers: ['Madmind Studio'],
        genres: ['Horror'],
        tags: ['Horror'],
      };

      const gridHarness = createComponentHarness(LibraryGridView, {
        games: [gameWithHtml],
        onSelectGame: vi.fn(),
        connectedStorefronts: ['gog'],
      });

      gridHarness.render();
      // Set hoveredGame state (index 2 in LibraryGridView state array: contextMenu=0, criticTick=1, hoveredGame=2)
      gridHarness.states[2] = gameWithHtml;
      const hoveredTree = gridHarness.render();
      const hoveredText = getTextContent(hoveredTree);

      expect(hoveredText).toContain('A dark "survival" odyssey — forged in fire & brimstone.');
      expect(hoveredText).not.toContain('<img');
      expect(hoveredText).not.toContain('steam_logos.png');
    });
  });

  // =========================================================================
  // 2. Bug 2: Instant Screenshot Navigation & Preloading
  // =========================================================================
  describe('2. Bug 2: Instant Screenshot Navigation & Preloading', () => {
    it('renders instant thumbnail base layer alongside full-res overlay on screenshot selection and preloads adjacent full-res screenshots', () => {
      const preloadedSrcs: string[] = [];
      const OriginalImage = (globalThis as any).Image;
      (globalThis as any).Image = class MockImage {
        onload: (() => void) | null = null;
        complete = false;
        private _src = '';
        get src() {
          return this._src;
        }
        set src(val: string) {
          this._src = val;
          preloadedSrcs.push(val);
        }
      };

      try {
        const screenshots: SteamScreenshot[] = [
          {
            id: 101,
            pathThumbnail: 'https://cdn.example.com/shot1_thumb.jpg',
            pathFull: 'https://cdn.example.com/shot1_full.jpg',
          },
          {
            id: 102,
            pathThumbnail: 'https://cdn.example.com/shot2_thumb.jpg',
            pathFull: 'https://cdn.example.com/shot2_full.jpg',
          },
          {
            id: 103,
            pathThumbnail: 'https://cdn.example.com/shot3_thumb.jpg',
            pathFull: 'https://cdn.example.com/shot3_full.jpg',
          },
          {
            id: 104,
            pathThumbnail: 'https://cdn.example.com/shot4_thumb.jpg',
            pathFull: 'https://cdn.example.com/shot4_full.jpg',
          },
          {
            id: 105,
            pathThumbnail: 'https://cdn.example.com/shot5_thumb.jpg',
            pathFull: 'https://cdn.example.com/shot5_full.jpg',
          },
        ];

        const harness = createComponentHarness(MediaGallery, {
          screenshots,
          movies: [],
        });

        const initialTree = harness.render();

        const thumbBaseInitial = findElements(
          initialTree,
          (el) => el.props?.['data-testid'] === 'media-gallery-screenshot-thumb-base'
        )[0];
        const fullOverlayInitial = findElements(
          initialTree,
          (el) => el.props?.['data-testid'] === 'media-gallery-screenshot-full'
        )[0];

        expect(thumbBaseInitial).toBeDefined();
        expect(thumbBaseInitial.props.src).toBe('https://cdn.example.com/shot1_thumb.jpg');
        expect(fullOverlayInitial).toBeDefined();
        expect(fullOverlayInitial.props.src).toBe('https://cdn.example.com/shot1_full.jpg');

        // Verify background preloading of thumbnails and first 4 full-res screenshots
        expect(preloadedSrcs).toContain('https://cdn.example.com/shot1_full.jpg');
        expect(preloadedSrcs).toContain('https://cdn.example.com/shot2_full.jpg');
        expect(preloadedSrcs).toContain('https://cdn.example.com/shot3_full.jpg');
        expect(preloadedSrcs).toContain('https://cdn.example.com/shot4_full.jpg');

        // Click the 3rd screenshot thumbnail (index 2)
        const nextBtn = findElements(
          initialTree,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Next thumbnail'
        )[0];
        expect(nextBtn).toBeDefined();
        nextBtn.props.onClick();

        const secondTree = harness.render();
        const thumbBaseSecond = findElements(
          secondTree,
          (el) => el.props?.['data-testid'] === 'media-gallery-screenshot-thumb-base'
        )[0];
        const fullOverlaySecond = findElements(
          secondTree,
          (el) => el.props?.['data-testid'] === 'media-gallery-screenshot-full'
        )[0];

        // Immediately renders shot2 thumbnail as 0ms base layer + shot2 full-res overlay
        expect(thumbBaseSecond.props.src).toBe('https://cdn.example.com/shot2_thumb.jpg');
        expect(fullOverlaySecond.props.src).toBe('https://cdn.example.com/shot2_full.jpg');
        // And preloads adjacent shot5_full.jpg (activeIndex 1 + offset 3 = index 4)
        expect(preloadedSrcs).toContain('https://cdn.example.com/shot5_full.jpg');
      } finally {
        (globalThis as any).Image = OriginalImage;
      }
    });
  });

  // =========================================================================
  // 3. Bug 3: Context Menu Submenu Navigation
  // =========================================================================
  describe('3. Bug 3: Context Menu Submenu Navigation', () => {
    it('keeps "Assign to Collection" submenu open during diagonal mouse movement / hover bridge transit and renders custom CollectionIcon icons', () => {
      vi.useFakeTimers();

      const mockGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
        headerImage: '',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: [],
      };

      const collections: GameCollection[] = [
        { id: 'favorites', name: 'Favorites', icon: 'star', gameIds: ['steam-1091500'] },
        { id: 'sci-fi-vault', name: 'Sci-Fi Vault', icon: 'rocket', gameIds: [] },
      ];

      const harness = createComponentHarness(GameContextMenu, {
        isOpen: true,
        x: 200,
        y: 200,
        game: mockGame,
        collections,
        onClose: vi.fn(),
        onFixMatch: vi.fn(),
        onSyncStoreMedia: vi.fn(),
        onToggleCollection: vi.fn(),
        onManageCollections: vi.fn(),
        onViewAchievements: vi.fn(),
      });

      let tree = harness.render();

      // Locate the "Assign to Collection" wrapper div with onMouseEnter & onMouseLeave
      const assignContainer = findElements(
        tree,
        (el) =>
          el.type === 'div' &&
          typeof el.props?.onMouseEnter === 'function' &&
          typeof el.props?.onMouseLeave === 'function' &&
          getTextContent(el).includes('Assign to Collection')
      )[0];
      expect(assignContainer).toBeDefined();

      // 1. Hover "Assign to Collection" -> submenu opens immediately
      assignContainer.props.onMouseEnter();
      tree = harness.render();

      const submenuMenu = findElements(
        tree,
        (el) => el.props?.role === 'menu' && el.props?.['aria-label'] === 'Collections submenu'
      )[0];
      expect(submenuMenu).toBeDefined();

      // Verify custom CollectionIcon elements are rendered inside the submenu
      const renderedSubmenuHtml = renderToString(submenuMenu);
      expect(renderedSubmenuHtml).toContain('data-collection-icon="star"');
      expect(renderedSubmenuHtml).toContain('data-collection-icon="rocket"');
      expect(renderedSubmenuHtml).toContain('Favorites');
      expect(renderedSubmenuHtml).toContain('Sci-Fi Vault');

      // 2. Simulate diagonal mouse movement leaving the trigger row and briefly grazing a neighboring top-level item ("View Achievements...")
      assignContainer.props.onMouseLeave();
      const neighborItem = findElements(
        tree,
        (el) =>
          el.type === 'button' &&
          el.props?.role === 'menuitem' &&
          getTextContent(el).includes('View Achievements')
      )[0];
      expect(neighborItem).toBeDefined();
      neighborItem.props.onMouseEnter(); // schedules 140ms close timer instead of instant close

      // Advance 90ms (< 140ms) while cursor is in diagonal transit toward the submenu
      vi.advanceTimersByTime(90);
      tree = harness.render();
      expect(
        findElements(
          tree,
          (el) => el.props?.role === 'menu' && el.props?.['aria-label'] === 'Collections submenu'
        ).length
      ).toBe(1);

      // 3. Cursor enters the submenu container -> cancels close timer and keeps submenu open!
      const submenuBridgeContainer = findElements(
        tree,
        (el) =>
          el.type === 'div' &&
          typeof el.props?.onMouseEnter === 'function' &&
          String(el.props?.className || '').includes('z-50')
      )[0];
      expect(submenuBridgeContainer).toBeDefined();
      submenuBridgeContainer.props.onMouseEnter();

      // Even after 500ms, the submenu remains open because the close timer was cancelled
      vi.advanceTimersByTime(500);
      tree = harness.render();
      expect(
        findElements(
          tree,
          (el) => el.props?.role === 'menu' && el.props?.['aria-label'] === 'Collections submenu'
        ).length
      ).toBe(1);
    });
  });

  // =========================================================================
  // 4. Bug 4: Persist Grid View Sort Order Across Game Navigation
  // =========================================================================
  describe('4. Bug 4: Persist Grid View Sort Order Across Game Navigation', () => {
    it('persists sortBy ("rating") to localStorage (GRID_SORT_STORAGE_KEY) and restores it across unmount/remount', () => {
      const gameLow: CanonicalGame = {
        id: 'steam-100',
        title: 'Alpha Low Score',
        sortTitle: 'Alpha Low Score',
        steamAppId: 100,
        reviewSummary: {
          reviewScore: 5,
          reviewScoreDesc: 'Mixed',
          totalPositive: 60,
          totalNegative: 40,
          totalReviews: 100,
          positivePercent: 60,
        },
        platforms: [{ platformId: 'steam', platformGameId: '100', installed: false }],
        headerImage: '',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: ['Action'],
        tags: [],
      };

      const gameHigh: CanonicalGame = {
        id: 'steam-200',
        title: 'Zulu High Score',
        sortTitle: 'Zulu High Score',
        steamAppId: 200,
        reviewSummary: {
          reviewScore: 9,
          reviewScoreDesc: 'Overwhelmingly Positive',
          totalPositive: 980,
          totalNegative: 20,
          totalReviews: 1000,
          positivePercent: 98,
        },
        platforms: [{ platformId: 'steam', platformGameId: '200', installed: false }],
        headerImage: '',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: ['Action'],
        tags: [],
      };

      // 1. Mount LibraryGridView (defaults to alphabetical: Alpha first, Zulu second)
      const firstMount = createComponentHarness(LibraryGridView, {
        games: [gameLow, gameHigh],
        onSelectGame: vi.fn(),
      });
      let tree1 = firstMount.render();
      const initialCards = findElements(tree1, (el) => Boolean(el.props?.['data-game-id']));
      expect(initialCards.map((c) => c.props['data-game-id'])).toEqual(['steam-100', 'steam-200']);

      // 2. Click "Rating" sort button
      const ratingBtn = findElements(
        tree1,
        (el) => el.type === 'button' && getTextContent(el).includes('Rating')
      )[0];
      expect(ratingBtn).toBeDefined();
      ratingBtn.props.onClick();

      expect(localStorage.getItem(GRID_SORT_STORAGE_KEY)).toBe('rating');
      expect(loadPersistedGridSort()).toBe('rating');

      tree1 = firstMount.render();
      const sortedCards = findElements(tree1, (el) => Boolean(el.props?.['data-game-id']));
      expect(sortedCards.map((c) => c.props['data-game-id'])).toEqual(['steam-200', 'steam-100']);

      // 3. Unmount LibraryGridView (user navigates into a game's detail page) and remount (user presses Back)
      firstMount.unmount();

      const secondMount = createComponentHarness(LibraryGridView, {
        games: [gameLow, gameHigh],
        onSelectGame: vi.fn(),
      });
      const tree2 = secondMount.render();
      const restoredCards = findElements(tree2, (el) => Boolean(el.props?.['data-game-id']));
      expect(restoredCards.map((c) => c.props['data-game-id'])).toEqual(['steam-200', 'steam-100']);
    });
  });

  // =========================================================================
  // 5. Bug 5: English Video Region Enforcement & Regional Trailer Filter
  // =========================================================================
  describe('5. Bug 5: English Video Region Enforcement & Regional Trailer Filter', () => {
    it('isNonEnglishRegionalMovieName flags Italian and non-English regional trailer names while keeping English/UK/US/PEGI trailers', () => {
      expect(isNonEnglishRegionalMovieName('12_RE9_LaunchPV_Multi_IT_FullHD_PEGI.mp4')).toBe(true);
      expect(isNonEnglishRegionalMovieName('Wolfenstein II_Launch Trailer_IT_PEGI')).toBe(true);
      expect(isNonEnglishRegionalMovieName('Launch_Trailer_FR_1080p')).toBe(true);
      expect(isNonEnglishRegionalMovieName('Trailer [ES]')).toBe(true);

      expect(isNonEnglishRegionalMovieName('10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4')).toBe(false);
      expect(isNonEnglishRegionalMovieName('Official Launch Trailer (US) ESRB')).toBe(false);
      expect(isNonEnglishRegionalMovieName('Gameplay Overview Trailer - English')).toBe(false);

      const filtered = filterEnglishMovies([
        { id: 1, name: '12_RE9_LaunchPV_Multi_IT_FullHD_PEGI.mp4' },
        { id: 2, name: '10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4' },
      ]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4');
    });

    it('steamApi.fetchGameMetadata passes &l=english&cc=US and filters out _IT_ regional trailers when English trailers exist', async () => {
      const testAppId = 999888777;
      const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('appdetails')) {
          return {
            data: {
              [testAppId]: {
                success: true,
                data: {
                  name: 'Resident Evil 9 Test',
                  short_description: '<p>Survival horror returns &amp; evolves.</p>',
                  detailed_description: '<p>Detailed description</p>',
                  about_the_game: '<p>About the game</p>',
                  header_image: 'https://cdn.example.com/header.jpg',
                  developers: ['CAPCOM'],
                  publishers: ['CAPCOM'],
                  release_date: { date: '2026-01-24' },
                  screenshots: [],
                  movies: [
                    {
                      id: 12,
                      name: '12_RE9_LaunchPV_Multi_IT_FullHD_PEGI.mp4',
                      thumbnail: 'https://cdn.example.com/it.jpg',
                      hls_h264: 'https://cdn.example.com/it.m3u8',
                    },
                    {
                      id: 10,
                      name: '10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4',
                      thumbnail: 'https://cdn.example.com/uk.jpg',
                      hls_h264: 'https://cdn.example.com/uk.m3u8',
                    },
                  ],
                },
              },
            },
          } as any;
        }
        return { data: {} } as any;
      });

      const meta = await steamApi.fetchGameMetadata(testAppId);

      expect(getSpy).toHaveBeenCalledWith(
        expect.stringContaining(`appids=${testAppId}&l=english&cc=US`),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Accept-Language': 'en-US,en;q=0.9',
          }),
        })
      );
      expect(meta).not.toBeNull();
      expect(meta?.shortDescription).toBe('Survival horror returns & evolves.');
      expect(meta?.movies).toHaveLength(1);
      expect(meta?.movies[0].name).toBe('10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4');
    });

    it('sanitizeGameCatalog purges cached _IT_ regional trailers from game.enrichedMetadata.movies', () => {
      const pollutedGame: CanonicalGame = {
        id: 'steam-999888777',
        title: 'Resident Evil 9 Test',
        sortTitle: 'Resident Evil 9 Test',
        steamAppId: 999888777,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '999888777', installed: true }],
        headerImage: 'https://cdn.example.com/header.jpg',
        shortDescription: 'Survival horror returns.',
        developers: ['CAPCOM'],
        publishers: ['CAPCOM'],
        genres: ['Action'],
        tags: ['Horror'],
        enrichedMetadata: {
          appId: 999888777,
          name: 'Resident Evil 9 Test',
          shortDescription: 'Survival horror returns.',
          detailedDescription: 'Survival horror returns.',
          aboutTheGame: 'Survival horror returns.',
          headerImage: 'https://cdn.example.com/header.jpg',
          developers: ['CAPCOM'],
          publishers: ['CAPCOM'],
          releaseDate: '2026-01-24',
          genres: ['Action'],
          tags: ['Horror'],
          categories: [],
          screenshots: [],
          movies: [
            {
              id: 12,
              name: '12_RE9_LaunchPV_Multi_IT_FullHD_PEGI.mp4',
              thumbnail: 'https://cdn.example.com/it.jpg',
              hls: 'https://cdn.example.com/it.m3u8',
              webm: { '480': '', max: '' },
              mp4: { '480': '', max: '' },
            },
            {
              id: 10,
              name: '10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4',
              thumbnail: 'https://cdn.example.com/uk.jpg',
              hls: 'https://cdn.example.com/uk.m3u8',
              webm: { '480': '', max: '' },
              mp4: { '480': '', max: '' },
            },
          ],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 90,
            totalNegative: 10,
            totalReviews: 100,
            positivePercent: 90,
          },
        },
      };

      const sanitized = sanitizeGameCatalog([pollutedGame]);
      expect(sanitized).toHaveLength(1);
      expect(sanitized[0].enrichedMetadata?.movies).toHaveLength(1);
      expect(sanitized[0].enrichedMetadata?.movies[0].name).toBe(
        '10_RE9_LaunchPV_Multi_UK_FullHD_PEGI.mp4'
      );
    });
  });

  // =========================================================================
  // 6. Regression (Item 6 — Epic Games Store Videos & Cross-Storefront Video Preservation)
  // =========================================================================
  describe('6. Regression: Epic Games Store Videos & Cross-Storefront Video Preservation', () => {
    it('fallbackMetadataProvider.fetchEpicProductMetadata merges Step 1 IPC metadata with Step 2 Epic Content API when Step 1 has no movies, returning playable HLS .m3u8 trailers for Alan Wake 2', async () => {
      const prevElectronApi = (window as any).electronAPI;
      (window as any).electronAPI = {
        ...prevElectronApi,
        fetchEpicProductMetadata: vi.fn().mockResolvedValue({
          title: 'Alan Wake 2',
          shortDescription: 'Saga Anderson arrives to investigate ritualistic murders in Bright Falls.',
          aboutTheGame: '<p>Saga Anderson arrives to investigate ritualistic murders in Bright Falls.</p>',
          headerImage: 'https://cdn1.epicgames.com/alan-wake-2-header.jpg',
          capsuleImage: 'https://cdn1.epicgames.com/alan-wake-2-tall.jpg',
          releaseDate: '2023-10-27',
          developers: ['Remedy Entertainment'],
          publishers: ['Epic Games Publishing'],
          screenshots: ['https://cdn1.epicgames.com/aw2-ipc-shot1.jpg'],
          movies: [], // Step 1 GraphQL/Catalog Offers returned 0 movies!
        }),
      };

      const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/content/products/alan-wake-2')) {
          return {
            data: {
              pages: [
                {
                  type: 'productHome',
                  data: {
                    carousel: {
                      items: [
                        {
                          image: { src: 'https://cdn1.epicgames.com/aw2-carousel-shot2.jpg' },
                          video: {
                            recipes: JSON.stringify({
                              'en-US': [
                                {
                                  recipe: 'video-hls',
                                  outputs: [
                                    {
                                      key: 'manifest',
                                      url: 'https://vod.epicgames.com/alan-wake-2/master.m3u8',
                                    },
                                    {
                                      key: 'thumbnail',
                                      url: 'https://cdn1.epicgames.com/aw2-video-thumb.jpg',
                                    },
                                  ],
                                },
                              ],
                            }),
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          } as any;
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      try {
        const result = await fallbackMetadataProvider.fetchEpicProductMetadata('alan-wake-2', {
          title: 'Alan Wake 2',
        });

        expect(getSpy).toHaveBeenCalledWith(
          expect.stringContaining('/api/en-US/content/products/alan-wake-2'),
          expect.any(Object)
        );
        expect(result).not.toBeNull();
        // Preserves Step 1 IPC synopsis & developers
        expect(result?.shortDescription).toBe(
          'Saga Anderson arrives to investigate ritualistic murders in Bright Falls.'
        );
        expect(result?.developers).toEqual(['Remedy Entertainment']);
        // Merges Step 1 + Step 2 screenshots
        expect(result?.screenshots?.map((s) => s.pathFull)).toContain(
          'https://cdn1.epicgames.com/aw2-ipc-shot1.jpg'
        );
        expect(result?.screenshots?.map((s) => s.pathFull)).toContain(
          'https://cdn1.epicgames.com/aw2-carousel-shot2.jpg'
        );
        // Enriches playable HLS .m3u8 trailer from Step 2!
        expect(result?.movies).toHaveLength(1);
        expect(result?.movies?.[0].hls).toBe(
          'https://vod.epicgames.com/alan-wake-2/master.m3u8'
        );
      } finally {
        (window as any).electronAPI = prevElectronApi;
      }
    });

    it('SteamStorePage updates enrichedMetadata via onGameUpdated when richerMovies are discovered', async () => {
      const epicGameWithoutMovies: CanonicalGame = {
        id: 'epic-alan-wake-2',
        title: 'Alan Wake 2',
        sortTitle: 'Alan Wake 2',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'alan-wake-2', installed: true }],
        headerImage: 'https://cdn1.epicgames.com/alan-wake-2-header.jpg',
        capsuleImage: 'https://cdn1.epicgames.com/alan-wake-2-tall.jpg',
        shortDescription: 'Saga Anderson arrives to investigate ritualistic murders in Bright Falls.',
        detailedDescription: '<p>Saga Anderson arrives to investigate ritualistic murders in Bright Falls.</p>',
        developers: ['Remedy Entertainment'],
        publishers: ['Epic Games Publishing'],
        releaseDate: '2023-10-27',
        genres: ['Survival Horror'],
        tags: ['Horror'],
        enrichedMetadata: {
          appId: 0,
          name: 'Alan Wake 2',
          shortDescription: 'Saga Anderson arrives to investigate ritualistic murders in Bright Falls.',
          detailedDescription: '<p>Saga Anderson arrives to investigate ritualistic murders in Bright Falls.</p>',
          aboutTheGame: '<p>Saga Anderson arrives to investigate ritualistic murders in Bright Falls.</p>',
          headerImage: 'https://cdn1.epicgames.com/alan-wake-2-header.jpg',
          developers: ['Remedy Entertainment'],
          publishers: ['Epic Games Publishing'],
          releaseDate: '2023-10-27',
          genres: ['Survival Horror'],
          tags: ['Horror'],
          categories: [],
          screenshots: [
            {
              id: 0,
              pathThumbnail: 'https://cdn1.epicgames.com/aw2-ipc-shot1.jpg',
              pathFull: 'https://cdn1.epicgames.com/aw2-ipc-shot1.jpg',
            },
          ],
          movies: [], // Previously cached with 0 movies
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: 'No User Reviews',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
        },
      };

      const discoveredMovie: SteamMovie = {
        id: 1,
        name: 'Alan Wake 2 Launch Trailer',
        thumbnail: 'https://cdn1.epicgames.com/aw2-video-thumb.jpg',
        hls: 'https://vod.epicgames.com/alan-wake-2/master.m3u8',
        webm: {
          '480': 'https://vod.epicgames.com/alan-wake-2/master.m3u8',
          max: 'https://vod.epicgames.com/alan-wake-2/master.m3u8',
        },
        mp4: {
          '480': 'https://vod.epicgames.com/alan-wake-2/master.m3u8',
          max: 'https://vod.epicgames.com/alan-wake-2/master.m3u8',
        },
      };

      vi.spyOn(
        fallbackMetadataProvider,
        'getEnrichedMetadataForNonSteamGame'
      ).mockResolvedValue({
        ...epicGameWithoutMovies.enrichedMetadata!,
        movies: [discoveredMovie],
      });
      vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);

      const onGameUpdated = vi.fn();

      const harness = createComponentHarness(SteamStorePage, {
        game: epicGameWithoutMovies,
        onBack: vi.fn(),
        onGameUpdated,
      });

      harness.render();
      // Wait for async metadata resolution promise in SteamStorePage useEffect
      await new Promise((r) => setTimeout(r, 25));

      expect(onGameUpdated).toHaveBeenCalledTimes(1);
      const updatedGameArg: CanonicalGame = onGameUpdated.mock.calls[0][0];
      expect(updatedGameArg.enrichedMetadata?.movies).toHaveLength(1);
      expect(updatedGameArg.enrichedMetadata?.movies[0].hls).toBe(
        'https://vod.epicgames.com/alan-wake-2/master.m3u8'
      );
    });
  });
});
