import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import { renderPrimaryNavPills } from '../src/components/Navigation/topNav/renderPrimaryNavPills';
import { OfflineVaultSection } from '../src/components/Navigation/integrations/OfflineVaultSection';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { renderSidebarStorefrontDropdown } from '../src/components/Library/Sidebar/SidebarStorefrontDropdown';
import { renderLibraryGridToolbar } from '../src/components/Library/Grid/LibraryGridToolbar';
import { LibraryGridView } from '../src/components/Library/LibraryGridView';
import {
  clampHoverPopoutVerticalPos,
  renderGameHoverPopout,
  type RenderGameHoverPopoutArgs,
} from '../src/components/Library/Grid/GameHoverPopout';
import { ManageCollectionsModal } from '../src/components/Library/ManageCollectionsModal';
import { DEFAULT_LIBRARY_FILTER_STATE } from '../src/contracts/filter';
import { OFFLINE_VAULT_TIER_CAPS } from '../src/contracts/network';
import type { GameCollection } from '../src/contracts/collection';
import type { StorefrontId } from '../src/contracts/platform';
import { buildLibraryFilterIndex } from '../src/services/filter/libraryFilterIndex';
import {
  createComponentHarness,
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const globalRecord = globalThis as Record<string, unknown>;

describe('Phase 3 UAT Remediation — Slice 3: TopNav, Sidebar, Grid Toolbar, HoverPopout, Vault Labels & Collections Modal', () => {
  let prevWindow: unknown;
  let prevDocument: unknown;
  let prevHTMLElement: unknown;
  let prevNode: unknown;
  let prevLocalStorage: unknown;

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevDocument = globalRecord.document;
    prevHTMLElement = globalRecord.HTMLElement;
    prevNode = globalRecord.Node;
    prevLocalStorage = globalRecord.localStorage;
  });

  afterEach(() => {
    vi.useRealTimers();
    const restore = (key: string, val: unknown) => {
      if (val === undefined) {
        delete globalRecord[key];
      } else {
        Object.defineProperty(globalThis, key, {
          value: val,
          configurable: true,
          writable: true,
        });
      }
    };
    restore('window', prevWindow);
    restore('document', prevDocument);
    restore('HTMLElement', prevHTMLElement);
    restore('Node', prevNode);
    restore('localStorage', prevLocalStorage);
  });

  // =========================================================================
  // BUG-A1: Burger Menu & Sidebar Storefront Dropdown Keyboard Nav on Chrome 152
  // =========================================================================
  describe('BUG-A1 — Menu keyboard navigation works when HTMLElement.prototype.focusGroup exists (Electron 44 / Chrome 152)', () => {
    const installChrome152FocusGroupEnv = () => {
      class MockChrome152HTMLElement {
        focusGroup?: string;
      }
      Object.defineProperty(MockChrome152HTMLElement.prototype, 'focusGroup', {
        value: '',
        configurable: true,
        writable: true,
      });

      const docState: { activeElement: unknown } = { activeElement: null };
      const mockDoc = {
        get activeElement() {
          return docState.activeElement;
        },
        set activeElement(el: unknown) {
          docState.activeElement = el;
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelector: vi.fn(() => null),
      };

      const storage = createMemoryStorage();
      Object.defineProperty(globalThis, 'HTMLElement', {
        value: MockChrome152HTMLElement,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'document', {
        value: mockDoc,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'window', {
        value: {
          localStorage: storage,
          innerWidth: 1440,
          innerHeight: 900,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        },
        configurable: true,
        writable: true,
      });

      const makeMockItems = (count: number) => {
        return Array.from({ length: count }, (_, idx) => {
          const item = {
            id: `item-${idx}`,
            focus: vi.fn(() => {
              mockDoc.activeElement = item;
            }),
          };
          return item;
        });
      };

      return { mockDoc, makeMockItems };
    };

    it('roves focus cleanly across Burger Menu items via ArrowDown/ArrowUp/End/Home even when focusGroup is on HTMLElement.prototype', () => {
      const { mockDoc, makeMockItems } = installChrome152FocusGroupEnv();
      expect('focusGroup' in HTMLElement.prototype).toBe(true);

      const harness = createComponentHarness(TopNavBar, {
        selectedPlatform: 'all',
        onSelectPlatform: vi.fn(),
        installedOnly: false,
        onToggleInstalledOnly: vi.fn(),
        totalGamesCount: 10,
        filteredCount: 10,
        isSyncing: false,
        onTriggerSync: vi.fn(),
        onHomeClick: vi.fn(),
        onOpenIntegrations: vi.fn(),
        defaultMenuOpen: true,
        presentStorefronts: ['steam', 'gog'],
      });

      const tree = harness.render();
      const burgerMenu = findElements(
        tree,
        (el) => el.type === 'div' && el.props?.role === 'menu' && el.props?.['aria-label'] === 'Launcher actions'
      )[0];
      expect(burgerMenu).toBeDefined();
      expect(burgerMenu.props.focusgroup).toBeUndefined();

      const items = makeMockItems(5);
      mockDoc.activeElement = items[0];

      const makeKeyEvent = (key: string, hasFocusgroupAttr = false) => ({
        key,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: {
          hasAttribute: (attr: string) => (attr === 'focusgroup' ? hasFocusgroupAttr : false),
          querySelectorAll: () => items,
        },
      });

      // Without a `focusgroup` attribute on the menu container, JS roving MUST run!
      const down1 = makeKeyEvent('ArrowDown');
      burgerMenu.props.onKeyDown(down1);
      expect(down1.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockDoc.activeElement).toBe(items[1]);

      const down2 = makeKeyEvent('ArrowDown');
      burgerMenu.props.onKeyDown(down2);
      expect(mockDoc.activeElement).toBe(items[2]);

      const up1 = makeKeyEvent('ArrowUp');
      burgerMenu.props.onKeyDown(up1);
      expect(mockDoc.activeElement).toBe(items[1]);

      const endEvt = makeKeyEvent('End');
      burgerMenu.props.onKeyDown(endEvt);
      expect(mockDoc.activeElement).toBe(items[4]);

      const homeEvt = makeKeyEvent('Home');
      burgerMenu.props.onKeyDown(homeEvt);
      expect(mockDoc.activeElement).toBe(items[0]);

      // Conversely, when a container explicitly opts into native `focusgroup` AND browser supports it, yield to native
      const nativeDown = makeKeyEvent('ArrowDown', true);
      burgerMenu.props.onKeyDown(nativeDown);
      expect(nativeDown.preventDefault).not.toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(items[0]);

      harness.unmount();
    });

    it('roves focus cleanly across SidebarStorefrontDropdown items via ArrowDown/ArrowUp/End/Home even when focusGroup is on HTMLElement.prototype', () => {
      const { mockDoc, makeMockItems } = installChrome152FocusGroupEnv();
      expect('focusGroup' in HTMLElement.prototype).toBe(true);

      const dropdownTree = renderSidebarStorefrontDropdown({
        storesDropdownRef: { current: null },
        storesTriggerRef: { current: null },
        storesMenuRef: { current: null },
        isStoresDropdownOpen: true,
        setIsStoresDropdownOpen: vi.fn(),
        selectedPlatform: 'all',
        onSelectPlatform: vi.fn(),
        connectedSet: new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']),
        focusStoreMenuItem: vi.fn(),
      });

      const menuEl = findElements(
        dropdownTree,
        (el) => el.type === 'div' && el.props?.role === 'menu' && el.props?.['aria-label'] === 'Filter Storefront'
      )[0];
      expect(menuEl).toBeDefined();
      expect(menuEl.props.focusgroup).toBeUndefined();

      const items = makeMockItems(6);
      mockDoc.activeElement = items[0];

      const fireKey = (key: string, hasFocusgroupAttr = false) => {
        const evt = {
          key,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          currentTarget: {
            hasAttribute: (attr: string) => (attr === 'focusgroup' ? hasFocusgroupAttr : false),
            querySelectorAll: () => items,
          },
        };
        menuEl.props.onKeyDown(evt);
        return evt;
      };

      const down = fireKey('ArrowDown');
      expect(down.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockDoc.activeElement).toBe(items[1]);

      fireKey('End');
      expect(mockDoc.activeElement).toBe(items[5]);

      fireKey('ArrowDown'); // wraps to first
      expect(mockDoc.activeElement).toBe(items[0]);

      fireKey('ArrowUp'); // wraps to last
      expect(mockDoc.activeElement).toBe(items[5]);

      fireKey('Home');
      expect(mockDoc.activeElement).toBe(items[0]);

      // Yields when container explicitly has `focusgroup` attribute
      const nativeEvt = fireKey('ArrowDown', true);
      expect(nativeEvt.preventDefault).not.toHaveBeenCalled();
      expect(mockDoc.activeElement).toBe(items[0]);
    });
  });

  // =========================================================================
  // BUG-A2: LibraryGridToolbar Overlap & TopNav Primary Pills Clipping at 1024x700
  // =========================================================================
  describe('BUG-A2 — Narrow viewport (1024×700) toolbar wrapping & non-clipping primary storefront pills', () => {
    it('wraps LibraryGridToolbar header cleanly without nowrap collision between heading and Filter/Sort controls', () => {
      const sampleGames = [
        makeCanonicalGameFixture({
          id: 'steam-1',
          title: 'Alpha',
          platforms: [{ platformId: 'steam', platformGameId: '1', installed: true }],
        }),
      ];
      const filterIndex = buildLibraryFilterIndex(sampleGames);

      const toolbarTree = renderLibraryGridToolbar({
        sortedCount: 1276,
        unfilteredTotalCount: 1276,
        activeCriteriaCount: 0,
        activeFilterChips: [],
        isFilterPanelOpen: false,
        onToggleFilterPanel: vi.fn(),
        onCloseFilterPanel: vi.fn(),
        effectiveFilterState: DEFAULT_LIBRARY_FILTER_STATE,
        effectiveFilterIndex: filterIndex,
        onUpdateFilterState: vi.fn(),
        onResetFilterState: vi.fn(),
        sortBy: 'rating',
        onSortChange: vi.fn(),
        releaseYearOrder: 'desc',
        onChangeReleaseYearOrder: vi.fn(),
      });

      const headerBar = findElements(
        toolbarTree,
        (el) => el.props?.['data-testid'] === 'library-grid-toolbar-header'
      )[0];
      expect(headerBar).toBeDefined();
      const headerClasses = String(headerBar.props.className || '').split(/\s+/);
      expect(headerClasses).toContain('flex');
      expect(headerClasses).toContain('flex-wrap');
      expect(headerClasses).not.toContain('lg:flex-row');

      const controls = findElements(
        toolbarTree,
        (el) => el.props?.['data-testid'] === 'library-grid-toolbar-controls'
      )[0];
      expect(controls).toBeDefined();
      const controlClasses = String(controls.props.className || '').split(/\s+/);
      expect(controlClasses).toContain('flex-wrap');
      expect(controlClasses).toContain('shrink-0');
      expect(controlClasses).toContain('max-w-full');
    });

    it('keeps <nav aria-label="Primary"> scroll container justify-start with mx-auto inner strip so "All Libraries" never clips into negative scroll space', () => {
      const navTree = renderPrimaryNavPills({
        visiblePlatforms: ['all', 'steam', 'gog', 'epic', 'xbox'],
        selectedPlatform: 'all',
        connectedSet: new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']),
        onSelectPlatform: vi.fn(),
      });

      expect(navTree.type).toBe('nav');
      const navProps = navTree.props as Record<string, unknown>;
      expect(navProps['aria-label']).toBe('Primary');
      const navClasses = String(navProps.className || '').split(/\s+/);
      expect(navClasses).toContain('overflow-x-auto');
      expect(navClasses).toContain('justify-start');
      // Must NEVER combine overflow-x-auto with justify-center / md:justify-center on the same scroll container
      expect(navClasses).not.toContain('justify-center');
      expect(navClasses).not.toContain('md:justify-center');

      const innerDiv = findElements(navTree, (el) => el.type === 'div')[0];
      expect(innerDiv).toBeDefined();
      const innerClasses = String(innerDiv.props.className || '').split(/\s+/);
      expect(innerClasses).toContain('mx-auto');
      expect(innerClasses).toContain('w-max');

      const buttons = findElements(navTree, (el) => el.type === 'button');
      expect(buttons).toHaveLength(5);
      for (const btn of buttons) {
        expect(String(btn.props.className || '')).toContain('shrink-0');
        expect(String(btn.props.className || '')).toContain('app-no-drag');
      }
    });
  });

  // =========================================================================
  // BUG-A3 & BUG-A4: HoverPopout Safe MouseLeave & Dynamic Viewport Clamping
  // =========================================================================
  describe('BUG-A3 & BUG-A4 — GameHoverPopout non-Node mouseleave guard, window exit dismissal & dynamic vertical clamping', () => {
    it('clamps hover popout vertical position cleanly inside 900px and 700px viewports (BUG-A4)', () => {
      // 1440×900 lower-half card (e.g. Hades II, measured popout height 542px, desired y = 460)
      const top900 = clampHoverPopoutVerticalPos(460, 542, 900, 12);
      expect(top900).toBe(346);
      expect(top900 + 542).toBeLessThanOrEqual(900 - 12);

      // 1024×700 minimum window size (measured popout height 542px, desired y = 420)
      const top700 = clampHoverPopoutVerticalPos(420, 542, 700, 12);
      expect(top700).toBe(146);
      expect(top700 + 542).toBeLessThanOrEqual(700 - 12);

      // Row 1 card near top stays aligned with card
      expect(clampHoverPopoutVerticalPos(140, 500, 900, 12)).toBe(140);

      // Oversized popout never clamps above top viewport padding (12px)
      expect(clampHoverPopoutVerticalPos(400, 740, 700, 12)).toBe(12);
    });

    it('measures popoutRef height via useLayoutEffect and dynamically clamps top style in GameHoverPopout', () => {
      const storage = createMemoryStorage();
      Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'window', {
        value: {
          localStorage: storage,
          innerWidth: 1440,
          innerHeight: 900,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        },
        configurable: true,
        writable: true,
      });

      const mockPopoutEl = {
        offsetHeight: 542,
        getBoundingClientRect: () => ({
          top: 460,
          left: 912,
          right: 1232,
          bottom: 1002,
          width: 320,
          height: 542,
        }),
      } as unknown as HTMLDivElement;

      // Preserve our 542px measured box even when the synthetic renderer attaches its own ref node
      let attachedEl: HTMLDivElement | null = mockPopoutEl;
      const measuredPopoutRef: React.MutableRefObject<HTMLDivElement | null> = {
        get current() {
          return attachedEl;
        },
        set current(el: HTMLDivElement | null) {
          if (el) {
            Object.defineProperty(el, 'offsetHeight', { value: 542, configurable: true });
            (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
              mockPopoutEl.getBoundingClientRect;
            attachedEl = el;
          } else {
            attachedEl = null;
          }
        },
      };

      const game = makeCanonicalGameFixture({
        id: 'steam-1145350',
        title: 'Hades II',
        steamAppId: 1145350,
        platforms: [{ platformId: 'steam', platformGameId: '1145350', installed: true }],
      });

      const PopoutHost: React.FC<RenderGameHoverPopoutArgs> = (props) =>
        renderGameHoverPopout(props);

      const renderer = createDomain12DeepRenderer(PopoutHost, {
        hoveredGame: game,
        previewPos: { x: 912, y: 460, align: 'right' },
        popoutRef: measuredPopoutRef,
        userOverridesMap: {},
        connectedSet: new Set<StorefrontId>(['steam']),
        dynamicBlurb: null,
        hoverHeaderFailed: false,
        onSetHoverHeaderFailed: vi.fn(),
        onPopoutMouseEnter: vi.fn(),
        onPopoutMouseLeave: vi.fn(),
        onSelectGame: vi.fn(),
        onContextMenu: vi.fn(),
      });

      // Render 1 runs useLayoutEffect which measures height 542 against innerHeight 900 -> clamps y to 346
      renderer.render();
      const clampedTree = renderer.render();
      const popoutEl = findElements(
        clampedTree,
        (el) => el.props?.['data-testid'] === 'game-hover-popout'
      )[0];
      expect(popoutEl).toBeDefined();
      expect(popoutEl.props.style.top).toBe('346px');
      expect(popoutEl.props.style.left).toBe('912px');

      renderer.unmount();
    });

    it('guards handleCardMouseLeave & handlePopoutMouseLeave against non-Node relatedTarget (window) and dismisses on documentElement mouseleave (BUG-A3)', () => {
      vi.useFakeTimers();

      class MockDomNode {
        nodeType = 1;
        contains(other: unknown): boolean {
          if (!(other instanceof MockDomNode)) {
            throw new TypeError("Failed to execute 'contains' on 'Node': parameter 1 is not of type 'Node'.");
          }
          return other === this;
        }
      }

      const docElListeners = new Map<string, Set<() => void>>();
      const mockDocEl = {
        addEventListener: vi.fn((type: string, fn: () => void) => {
          if (!docElListeners.has(type)) docElListeners.set(type, new Set());
          docElListeners.get(type)!.add(fn);
        }),
        removeEventListener: vi.fn((type: string, fn: () => void) => {
          docElListeners.get(type)?.delete(fn);
        }),
      };

      const storage = createMemoryStorage();
      const mockWin = {
        localStorage: storage,
        innerWidth: 1440,
        innerHeight: 900,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };

      Object.defineProperty(globalThis, 'Node', {
        value: MockDomNode,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'window', {
        value: mockWin,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'document', {
        value: {
          documentElement: mockDocEl,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getElementById: vi.fn(() => null),
        },
        configurable: true,
        writable: true,
      });

      const game = makeCanonicalGameFixture({
        id: 'steam-1174180',
        title: 'Red Dead Redemption 2',
        steamAppId: 1174180,
        platforms: [{ platformId: 'steam', platformGameId: '1174180', installed: true }],
      });

      const harness = createComponentHarness(LibraryGridView, {
        games: [game],
        onSelectGame: vi.fn(),
        connectedStorefronts: ['steam'],
      });

      const initialTree = harness.render();
      const cardElVNode = findElements(
        initialTree,
        (el) => typeof el.props?.onMouseEnter === 'function' && typeof el.props?.onMouseLeave === 'function'
      )[0];
      expect(cardElVNode).toBeDefined();

      const mockCardNode = Object.assign(new MockDomNode(), {
        getBoundingClientRect: () => ({
          left: 1100,
          right: 1280,
          top: 560,
          bottom: 830,
          width: 180,
          height: 270,
        }),
      });

      const findPopout = (tree: unknown) =>
        findElements(tree, (el) => el.props?.['data-testid'] === 'game-hover-popout')[0];

      // Trigger hover on a lower-half right-edge card
      cardElVNode.props.onMouseEnter(game, { currentTarget: mockCardNode });
      vi.advanceTimersByTime(450);

      const hoveredTree = harness.render();
      const popoutEl = findPopout(hoveredTree);
      expect(popoutEl).toBeDefined();
      // Initial fallback estimate (548px + 12px padding = 560 -> 900 - 560 = 340) must NOT use stale 440px (460)
      expect(parseInt(String(popoutEl.props.style.top), 10)).toBeLessThanOrEqual(340);

      // Attach strict MockDomNode to popoutRef (throws TypeError if .contains called on non-Node!)
      const mockPopoutNode = new MockDomNode();
      const popoutRefObj = (popoutEl.props?.ref ?? popoutEl.ref) as
        | React.MutableRefObject<unknown>
        | undefined;
      expect(popoutRefObj).toBeDefined();
      popoutRefObj!.current = mockPopoutNode;

      // 1) Moving pointer into popoutRef (valid Node) keeps popout open
      cardElVNode.props.onMouseLeave({ relatedTarget: mockPopoutNode });
      expect(findPopout(harness.render())).toBeDefined();

      // 2) Leaving card off-window where relatedTarget is `window` (non-Node!) MUST NOT throw and MUST dismiss!
      expect(() => {
        cardElVNode.props.onMouseLeave({ relatedTarget: mockWin });
      }).not.toThrow();

      expect(findPopout(harness.render())).toBeUndefined();

      // 3) Re-open hover, verify popout mouseleave with non-Node relatedTarget also dismisses safely
      cardElVNode.props.onMouseEnter(game, { currentTarget: mockCardNode });
      vi.advanceTimersByTime(450);
      const popoutAgain = findPopout(harness.render());
      expect(popoutAgain).toBeDefined();

      expect(() => {
        popoutAgain.props.onMouseLeave({ relatedTarget: mockWin });
      }).not.toThrow();
      expect(findPopout(harness.render())).toBeUndefined();

      // 4) Re-open hover, verify documentElement mouseleave dismisses stray popout cleanly
      cardElVNode.props.onMouseEnter(game, { currentTarget: mockCardNode });
      vi.advanceTimersByTime(450);
      expect(findPopout(harness.render())).toBeDefined();

      for (const listener of docElListeners.get('mouseleave') ?? []) {
        listener();
      }
      expect(findPopout(harness.render())).toBeUndefined();

      harness.unmount();
    });
  });

  // =========================================================================
  // BUG-A5: Duplicate `(84%) (84%)` & Misleading `No User Reviews (0%)`
  // =========================================================================
  describe('BUG-A5 — GameHoverPopout review summary formatting & empty-review suppression', () => {
    const renderPopoutHtml = (game: ReturnType<typeof makeCanonicalGameFixture>) => {
      return renderToString(
        renderGameHoverPopout({
          hoveredGame: game,
          previewPos: { x: 100, y: 120, align: 'left' },
          popoutRef: { current: null },
          userOverridesMap: {},
          connectedSet: new Set<StorefrontId>(['steam', 'gog']),
          dynamicBlurb: null,
          hoverHeaderFailed: false,
          onSetHoverHeaderFailed: vi.fn(),
          onPopoutMouseEnter: vi.fn(),
          onPopoutMouseLeave: vi.fn(),
          onSelectGame: vi.fn(),
          onContextMenu: vi.fn(),
        })
      ).replace(/<!--\s*-->/g, '');
    };

    it('does not append duplicate percentage when reviewScoreDesc already contains % (Mighty (84%))', () => {
      const game = makeCanonicalGameFixture({
        id: 'gog-deus-ex-2',
        title: 'Deus Ex 2: Invisible War',
        platforms: [{ platformId: 'gog', platformGameId: '1207659068', installed: true }],
        reviewSummary: {
          reviewScore: 8,
          reviewScoreDesc: 'Mighty (84%)',
          totalPositive: 84,
          totalNegative: 16,
          totalReviews: 100,
          positivePercent: 84,
        },
      });

      const html = renderPopoutHtml(game);
      expect(html).toContain('Mighty (84%)');
      expect(html).not.toContain('(84%)</span><span');
      expect(html.match(/84%/g)).toHaveLength(1);
    });

    it('appends positivePercent when reviewScoreDesc does not contain % and totalReviews > 0', () => {
      const game = makeCanonicalGameFixture({
        id: 'steam-620',
        title: 'Portal 2',
        steamAppId: 620,
        platforms: [{ platformId: 'steam', platformGameId: '620', installed: true }],
        reviewSummary: {
          reviewScore: 9,
          reviewScoreDesc: 'Overwhelmingly Positive',
          totalPositive: 350000,
          totalNegative: 3500,
          totalReviews: 353500,
          positivePercent: 99,
        },
      });

      const html = renderPopoutHtml(game);
      expect(html).toContain('Overwhelmingly Positive');
      expect(html).toContain('(99%)');
    });

    it('suppresses misleading thumbs-up "No User Reviews (0%)" when totalReviews <= 0 or desc is "No User Reviews"', () => {
      const zeroReviewGame = makeCanonicalGameFixture({
        id: 'steam-1086940',
        title: "Baldur's Gate 3",
        steamAppId: 1086940,
        platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: true }],
        reviewSummary: {
          reviewScore: 0,
          reviewScoreDesc: 'No User Reviews',
          totalPositive: 0,
          totalNegative: 0,
          totalReviews: 0,
          positivePercent: 0,
        },
      });

      const html = renderPopoutHtml(zeroReviewGame);
      expect(html).not.toContain('No User Reviews');
      expect(html).not.toContain('(0%)');
      expect(html).toContain('Verified in Library');
    });

    it('falls back to enrichedMetadata.reviewSummary when top-level reviewSummary has 0 reviews', () => {
      const game = makeCanonicalGameFixture({
        id: 'steam-1145350-enriched',
        title: 'Hades II',
        steamAppId: 1145350,
        platforms: [{ platformId: 'steam', platformGameId: '1145350', installed: true }],
        reviewSummary: {
          reviewScore: 0,
          reviewScoreDesc: 'No User Reviews',
          totalPositive: 0,
          totalNegative: 0,
          totalReviews: 0,
          positivePercent: 0,
        },
        enrichedMetadata: {
          appId: 1145350,
          name: 'Hades II',
          aboutTheGame: '<p>Battle beyond the Underworld.</p>',
          shortDescription: 'Battle beyond the Underworld.',
          detailedDescription: '<p>Battle beyond the Underworld.</p>',
          headerImage: 'https://example.invalid/hades2.jpg',
          developers: ['Supergiant Games'],
          publishers: ['Supergiant Games'],
          releaseDate: '2025-09-25',
          genres: ['Action'],
          tags: ['Roguelike'],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 9,
            reviewScoreDesc: 'Overwhelmingly Positive',
            totalPositive: 52000,
            totalNegative: 2000,
            totalReviews: 54000,
            positivePercent: 96,
          },
        },
      });

      const html = renderPopoutHtml(game);
      expect(html).toContain('Overwhelmingly Positive');
      expect(html).toContain('(96%)');
      expect(html).not.toContain('No User Reviews');
    });
  });

  // =========================================================================
  // BUG-C6: OfflineVaultSection Tier Button Labels Match Enforced Caps
  // =========================================================================
  describe('BUG-C6 — OfflineVaultSection tier button labels match OFFLINE_VAULT_TIER_CAPS', () => {
    it('renders 150 MB, 350 MB, and 1.5 GB derived from OFFLINE_VAULT_TIER_CAPS instead of stale 250 MB / 1 GB / 2 GB', () => {
      const html = renderToString(
        <OfflineVaultSection
          vaultStats={{
            tier: 'balanced',
            maxBytes: OFFLINE_VAULT_TIER_CAPS.balanced,
            sqliteBytes: 20 * 1024 * 1024,
            blobBytes: 162.5 * 1024 * 1024,
            totalBytes: 182.5 * 1024 * 1024,
            blobCount: 400,
            federatedAssetCount: 120,
            totalGames: 1276,
            enrichedGames: 1276,
            pendingAssets: 0,
            isHydrating: false,
            isSuspendedInGame: false,
          }}
          isUpdatingVault={false}
          onSelectTier={vi.fn()}
          onClearMediaCache={vi.fn()}
        />
      ).replace(/<!--\s*-->/g, '');

      expect(html).toContain('Compact');
      expect(html).toContain('150 MB');
      expect(html).toContain('Balanced');
      expect(html).toContain('350 MB');
      expect(html).toContain('Full Archive');
      expect(html).toContain('1.5 GB');
      // Progress bar cap aligns with Balanced button
      expect(html).toContain('182.5 MB / 350.0 MB');
      // Stale contradictory labels must be completely gone
      expect(html).not.toContain('250 MB');
      expect(html).not.toContain('>1 GB<');
      expect(html).not.toContain('>2 GB<');
    });
  });

  // =========================================================================
  // Track A UX Polish #1 & #2: Sidebar Search Clear/Escape & Collections Count
  // =========================================================================
  describe('Track A UX Polish — Sidebar search clear button + IME-safe Escape & ManageCollectionsModal valid game counts', () => {
    it('shows inline Clear search button only when searchQuery is non-empty, focuses input on clear, and clears on Escape with IME guard', () => {
      const onSearchChange = vi.fn();
      const baseProps = {
        games: [
          makeCanonicalGameFixture({
            id: 'steam-1',
            title: 'Champions of Krynn',
            platforms: [{ platformId: 'steam', platformGameId: '1', installed: true }],
          }),
        ],
        selectedGameId: null,
        onSelectGame: vi.fn(),
        searchQuery: '',
        onSearchChange,
        selectedPlatform: 'all' as const,
        onSelectPlatform: vi.fn(),
        installedOnly: false,
        onToggleInstalledOnly: vi.fn(),
        collections: [],
        onOpenManageCollectionsModal: vi.fn(),
        onToggleGameInCollection: vi.fn(),
        connectedStorefronts: ['steam' as StorefrontId],
      };

      // 1) Empty query -> no Clear search button
      const emptyHarness = createComponentHarness(LibrarySidebar, baseProps);
      const emptyTree = emptyHarness.render();
      expect(
        findElements(
          emptyTree,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Clear search'
        )
      ).toHaveLength(0);
      emptyHarness.unmount();

      // 2) Non-empty query -> Clear search button present + Escape clears unless IME composing
      const activeHarness = createComponentHarness(LibrarySidebar, {
        ...baseProps,
        searchQuery: 'Krynn',
      });
      const activeTree = activeHarness.render();

      const clearBtn = findElements(
        activeTree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Clear search'
      )[0];
      expect(clearBtn).toBeDefined();

      const searchInput = findElements(
        activeTree,
        (el) => el.type === 'input' && el.props?.['aria-label'] === 'Search library by title'
      )[0];
      expect(searchInput).toBeDefined();

      // IME-composing Escape (isComposing: true or Safari keyCode: 229) must NOT clear search!
      const imeEsc1 = {
        key: 'Escape',
        isComposing: true,
        keyCode: 27,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      searchInput.props.onKeyDown(imeEsc1);
      expect(onSearchChange).not.toHaveBeenCalled();

      const imeEsc2 = {
        key: 'Escape',
        isComposing: false,
        keyCode: 229,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      searchInput.props.onKeyDown(imeEsc2);
      expect(onSearchChange).not.toHaveBeenCalled();

      // Normal Escape clears search and stops propagation
      const normalEsc = {
        key: 'Escape',
        isComposing: false,
        keyCode: 27,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      searchInput.props.onKeyDown(normalEsc);
      expect(normalEsc.preventDefault).toHaveBeenCalledTimes(1);
      expect(normalEsc.stopPropagation).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith('');

      onSearchChange.mockClear();
      // Clicking Clear button clears search
      clearBtn.props.onClick();
      expect(onSearchChange).toHaveBeenCalledWith('');

      activeHarness.unmount();
    });

    it('counts only valid in-library games in ManageCollectionsModal when games or validGameIds are provided and guards onDragLeave non-Node relatedTarget', () => {
      const libraryGames = [
        makeCanonicalGameFixture({
          id: 'steam-1086940',
          title: "Baldur's Gate 3",
          platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: true }],
        }),
        makeCanonicalGameFixture({
          id: 'steam-6920',
          title: 'Deus Ex: Invisible War',
          platforms: [{ platformId: 'steam', platformGameId: '6920', installed: true }],
        }),
      ];
      const collections: GameCollection[] = [
        {
          id: 'favorites',
          name: 'Favorites',
          isDefault: true,
          // Includes retired/merged ID `gog-1207659068` plus a duplicate
          gameIds: ['steam-1086940', 'steam-6920', 'gog-1207659068', 'steam-6920'],
        },
      ];

      const modalHarness = createComponentHarness(ManageCollectionsModal, {
        isOpen: true,
        onClose: vi.fn(),
        collections,
        games: libraryGames,
        onCreateCollection: vi.fn(),
        onRenameCollection: vi.fn(),
        onDeleteCollection: vi.fn(),
        onToggleGameInCollection: vi.fn(),
        onReorderCollections: vi.fn(),
      });

      const tree = modalHarness.render();
      const text = getTextContent(tree);
      expect(text).toContain('Favorites');
      expect(text).toContain('(2 games)');
      expect(text).not.toContain('(3 games)');
      expect(text).not.toContain('(4 games)');

      // Verify onDragLeave with a non-Node relatedTarget never throws TypeError
      const listContainer = findElements(
        tree,
        (el) => el.type === 'div' && typeof el.props?.onDragLeave === 'function'
      )[0];
      expect(listContainer).toBeDefined();
      expect(() => {
        listContainer.props.onDragLeave({
          relatedTarget: { notANode: true },
          currentTarget: {
            contains: () => {
              throw new TypeError('Should not be called on non-Node');
            },
          },
        });
      }).not.toThrow();

      modalHarness.unmount();
    });
  });
});
