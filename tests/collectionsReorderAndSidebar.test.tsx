import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { ManageCollectionsModal } from '../src/components/Library/ManageCollectionsModal';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { App } from '../src/App';
import { useCollectionsManager } from '../src/hooks/useCollectionsManager';
import { loadCollections, saveCollections } from '../src/services/storage/collectionStorage';
import { matchesLooseSearchQuery } from '../src/services/common/titleUtils';
import type { GameCollection } from '../src/contracts/collection';
import type { CanonicalGame } from '../src/contracts/game';
import { makeCanonicalGame } from './helpers/factories';

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

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
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
}

if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    body: {},
  };
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
      useDeferredValue(val: any) {
        return val;
      },
      useTransition() {
        return [false, (fn: () => void) => fn()];
      },
      useContext(ctx: any) {
        return ctx._currentValue;
      },
      useId() {
        return 'mock-id';
      },
    };

    let tree: any;
    try {
      tree = Component(currentProps);
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

  const unmount = () => {
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch {}
      }
    }
  };

  return { render, unmount };
}

const SAMPLE_COLLECTIONS: GameCollection[] = [
  { id: 'col-a', name: 'Alpha RPGs', icon: 'swords', gameIds: ['game-1'] },
  { id: 'col-b', name: 'Beta Strategy', icon: 'crown', gameIds: ['game-2'] },
  { id: 'col-c', name: 'Gamma Sci-Fi', icon: 'rocket', gameIds: ['game-3'] },
];

const SAMPLE_GAMES: CanonicalGame[] = [
  makeCanonicalGame({
    id: 'game-1',
    title: 'Baldur’s Gate 3',
    sortTitle: 'Baldur’s Gate 3',
    platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: true }],
  }),
  makeCanonicalGame({
    id: 'game-2',
    title: 'Age of Empires IV',
    sortTitle: 'Age of Empires IV',
    platforms: [{ platformId: 'steam', platformGameId: '1466860', installed: false }],
  }),
  makeCanonicalGame({
    id: 'game-3',
    title: 'Mass Effect Legendary Edition',
    sortTitle: 'Mass Effect Legendary Edition',
    platforms: [{ platformId: 'steam', platformGameId: '1328670', installed: true }],
  }),
];

describe('Drag-and-Drop Collection Reordering & Sidebar "Groups" Label', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('1. Drag-and-Drop Reordering in ManageCollectionsModal', () => {
    it('renders drag handles, collection rows, and "Drag to reorder in sidebar" hint, and invokes onReorderCollections(0, 2) on dragStart + dragOver + drop', () => {
      const onReorderCollections = vi.fn();

      const harness = createComponentHarness(ManageCollectionsModal, {
        isOpen: true,
        onClose: () => {},
        collections: SAMPLE_COLLECTIONS,
        onCreateCollection: () => {},
        onRenameCollection: () => {},
        onDeleteCollection: () => {},
        onToggleGameInCollection: () => {},
        onReorderCollections,
      });

      const tree1 = harness.render();
      expect(getTextContent(tree1)).toContain('Drag to reorder in sidebar');

      for (const col of SAMPLE_COLLECTIONS) {
        const handle = findElements(
          tree1,
          (el) => el.props?.['data-testid'] === `drag-handle-${col.id}`
        )[0];
        const row = findElements(
          tree1,
          (el) => el.props?.['data-testid'] === `collection-row-${col.id}`
        )[0];
        expect(handle).toBeDefined();
        expect(row).toBeDefined();
        expect(row.props.draggable).toBe(true);
      }

      // Simulate dragStart on collection row 0 (col-a)
      const rowA = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'collection-row-col-a'
      )[0];
      const dataStore = new Map<string, string>();
      const mockDataTransfer = {
        setData: (type: string, val: string) => dataStore.set(type, val),
        getData: (type: string) => dataStore.get(type) ?? '',
        effectAllowed: '',
        dropEffect: '',
      };

      rowA.props.onDragStart({ dataTransfer: mockDataTransfer });

      // Re-render after dragStart state update, then simulate dragOver + drop on collection row 2 (col-c)
      const tree2 = harness.render();
      const rowC = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'collection-row-col-c'
      )[0];

      rowC.props.onDragOver({
        preventDefault: () => {},
        dataTransfer: mockDataTransfer,
      });
      rowC.props.onDrop({
        preventDefault: () => {},
        dataTransfer: mockDataTransfer,
      });

      expect(onReorderCollections).toHaveBeenCalledTimes(1);
      expect(onReorderCollections).toHaveBeenCalledWith(0, 2);
    });

    it('highlights the active between-collections drop slot and inserts a dragged collection between two collections', () => {
      const onReorderCollections = vi.fn();

      const harness = createComponentHarness(ManageCollectionsModal, {
        isOpen: true,
        onClose: () => {},
        collections: SAMPLE_COLLECTIONS,
        onCreateCollection: () => {},
        onRenameCollection: () => {},
        onDeleteCollection: () => {},
        onToggleGameInCollection: () => {},
        onReorderCollections,
      });

      const tree1 = harness.render();
      const rowA = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'collection-row-col-a'
      )[0];
      const dataStore = new Map<string, string>();
      const mockDataTransfer = {
        setData: (type: string, val: string) => dataStore.set(type, val),
        getData: (type: string) => dataStore.get(type) ?? '',
        effectAllowed: '',
        dropEffect: '',
      };

      // Start dragging col-a (index 0)
      rowA.props.onDragStart({ dataTransfer: mockDataTransfer });

      // Drag over drop-slot-2 (between col-b "Beta Strategy" at index 1 and col-c "Gamma Sci-Fi" at index 2)
      const tree2 = harness.render();
      const slotBetweenBandC = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'collection-drop-slot-2'
      )[0];
      expect(slotBetweenBandC).toBeDefined();

      slotBetweenBandC.props.onDragOver({
        preventDefault: () => {},
        stopPropagation: () => {},
        dataTransfer: mockDataTransfer,
      });

      // Verify active drop indicator renders between col-b and col-c
      const tree3 = harness.render();
      const activeIndicator = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'active-drop-indicator-2'
      )[0];
      expect(activeIndicator).toBeDefined();
      expect(getTextContent(activeIndicator)).toContain(
        'Drop between "Beta Strategy" & "Gamma Sci-Fi"'
      );

      // Drop onto slot 2 -> moves index 0 to index 1 (resulting in [col-b, col-a, col-c])
      const slotActive = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'collection-drop-slot-2'
      )[0];
      slotActive.props.onDrop({
        preventDefault: () => {},
        stopPropagation: () => {},
        dataTransfer: mockDataTransfer,
      });

      expect(onReorderCollections).toHaveBeenCalledTimes(1);
      expect(onReorderCollections).toHaveBeenCalledWith(0, 1);
    });

    it('allows dragging a collection away and returning it to its original position without reordering', () => {
      const onReorderCollections = vi.fn();

      const harness = createComponentHarness(ManageCollectionsModal, {
        isOpen: true,
        onClose: () => {},
        collections: SAMPLE_COLLECTIONS,
        onCreateCollection: () => {},
        onRenameCollection: () => {},
        onDeleteCollection: () => {},
        onToggleGameInCollection: () => {},
        onReorderCollections,
      });

      const tree1 = harness.render();
      const rowA = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'collection-row-col-a'
      )[0];
      const dataStore = new Map<string, string>();
      const mockDataTransfer = {
        setData: (type: string, val: string) => dataStore.set(type, val),
        getData: (type: string) => dataStore.get(type) ?? '',
        effectAllowed: '',
        dropEffect: '',
      };

      // 1. Start dragging col-a (index 0)
      rowA.props.onDragStart({ dataTransfer: mockDataTransfer });

      // 2. Drag over slot 2 (between col-b and col-c)
      const tree2 = harness.render();
      const slot2 = findElements(
        tree2,
        (el) => el.props?.['data-testid'] === 'collection-drop-slot-2'
      )[0];
      slot2.props.onDragOver({
        preventDefault: () => {},
        stopPropagation: () => {},
        dataTransfer: mockDataTransfer,
      });

      const tree3 = harness.render();
      expect(
        findElements(tree3, (el) => el.props?.['data-testid'] === 'active-drop-indicator-2')[0]
      ).toBeDefined();

      // 3. While still holding the mouse down, move back over col-a (original position)
      const rowADragging = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'collection-row-col-a'
      )[0];
      rowADragging.props.onDragOver({
        preventDefault: () => {},
        dataTransfer: mockDataTransfer,
      });

      // Verify slot 2 indicator disappears and "Keep in current position" badge appears on col-a
      const tree4 = harness.render();
      expect(
        findElements(tree4, (el) => el.props?.['data-testid'] === 'active-drop-indicator-2')[0]
      ).toBeUndefined();
      const keepBadge = findElements(
        tree4,
        (el) => el.props?.['data-testid'] === 'keep-position-badge-col-a'
      )[0];
      expect(keepBadge).toBeDefined();
      expect(getTextContent(keepBadge)).toBe('Keep in current position');

      // 4. Drop back onto col-a -> should NOT call onReorderCollections
      const rowAReturned = findElements(
        tree4,
        (el) => el.props?.['data-testid'] === 'collection-row-col-a'
      )[0];
      rowAReturned.props.onDrop({
        preventDefault: () => {},
        dataTransfer: mockDataTransfer,
      });

      expect(onReorderCollections).not.toHaveBeenCalled();
    });
  });

  describe('2. useCollectionsManager Persistence', () => {
    it('reorders collections in state (["col-b", "col-c", "col-a"]) and persists the updated order in localStorage via loadCollections()', () => {
      saveCollections(SAMPLE_COLLECTIONS);

      let latestManager: ReturnType<typeof useCollectionsManager> | null = null;
      const HookWrapper: React.FC = () => {
        latestManager = useCollectionsManager();
        return null;
      };

      const harness = createComponentHarness(HookWrapper, {});
      harness.render();

      expect(latestManager!.collections.map((c) => c.id)).toEqual(['col-a', 'col-b', 'col-c']);

      // Reorder index 0 ('col-a') to index 2
      latestManager!.handleReorderCollections(0, 2);
      harness.render();

      expect(latestManager!.collections.map((c) => c.id)).toEqual(['col-b', 'col-c', 'col-a']);
      expect(loadCollections().map((c) => c.id)).toEqual(['col-b', 'col-c', 'col-a']);
    });
  });

  describe('3. LibrarySidebar Custom Collection Order & "Groups" Button Label', () => {
    it('renders collections in the reordered sequence (col-b, col-c, col-a) and renders "Groups" instead of "+ Group"', () => {
      const reorderedCollections: GameCollection[] = [
        SAMPLE_COLLECTIONS[1], // col-b (Beta Strategy)
        SAMPLE_COLLECTIONS[2], // col-c (Gamma Sci-Fi)
        SAMPLE_COLLECTIONS[0], // col-a (Alpha RPGs)
      ];

      const harness = createComponentHarness(LibrarySidebar, {
        games: SAMPLE_GAMES,
        selectedGameId: null,
        onSelectGame: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        collections: reorderedCollections,
        onOpenManageCollectionsModal: () => {},
        onToggleGameInCollection: () => {},
      });

      const tree = harness.render();
      const fullText = getTextContent(tree);

      // Verify "Groups" button label (and absence of "+ Group")
      const manageBtn = findElements(
        tree,
        (el) => el.type === 'button' && el.props?.title === 'Create or manage collections'
      )[0];
      expect(manageBtn).toBeDefined();
      expect(getTextContent(manageBtn)).toBe('Groups');
      expect(fullText).not.toContain('+ Group');

      // Verify collections are rendered in the exact reordered sequence: Beta Strategy -> Gamma Sci-Fi -> Alpha RPGs
      const idxBeta = fullText.indexOf('Beta Strategy');
      const idxGamma = fullText.indexOf('Gamma Sci-Fi');
      const idxAlpha = fullText.indexOf('Alpha RPGs');

      expect(idxBeta).toBeGreaterThan(-1);
      expect(idxGamma).toBeGreaterThan(idxBeta);
      expect(idxAlpha).toBeGreaterThan(idxGamma);

      // Verify search input placeholder is "Search by title..."
      const searchInput = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.placeholder === 'Search by title...'
      )[0];
      expect(searchInput).toBeDefined();
    });
  });

  describe('4. Title-Only Search Query Filtering', () => {
    it('searches only game.title and game.originalStoreTitle in App so queries like "cloud" do not match tags like "Steam Cloud"', () => {
      const testCatalog: CanonicalGame[] = [
        makeCanonicalGame({
          id: 'steam-1091500',
          title: 'Cyberpunk 2077',
          isVerifiedEntitlement: true,
          platforms: [
            { platformId: 'steam', platformGameId: '1091500', installed: true, playtimeMinutes: 100 },
          ],
          genres: ['RPG'],
          tags: ['Steam Cloud', 'Cloud Saves', 'Single-player'],
          developers: ['CD PROJEKT RED'],
        }),
        makeCanonicalGame({
          id: 'steam-746850',
          title: 'Cloudpunk',
          isVerifiedEntitlement: true,
          platforms: [
            { platformId: 'steam', platformGameId: '746850', installed: false, playtimeMinutes: 20 },
          ],
          genres: ['Indie'],
          tags: ['Steam Cloud'],
          developers: ['ION LANDS'],
        }),
      ];

      localStorage.setItem('universal_game_library_catalog', JSON.stringify(testCatalog));
      const appHarness = createComponentHarness(App, {});
      const initialTree = appHarness.render();
      const sidebarNode = findElements(initialTree, (el) => el.type === LibrarySidebar)[0];
      expect(sidebarNode).toBeDefined();
      expect(sidebarNode.props.games.map((g: CanonicalGame) => g.title).sort()).toEqual([
        'Cloudpunk',
        'Cyberpunk 2077',
      ]);

      sidebarNode.props.onSearchChange('cloud');
      const filteredTree = appHarness.render();
      const filteredSidebar = findElements(filteredTree, (el) => el.type === LibrarySidebar)[0];
      expect(filteredSidebar.props.games.map((g: CanonicalGame) => g.title)).toEqual(['Cloudpunk']);
      appHarness.unmount();

      const searchQuery = 'cloud';
      const results = testCatalog.filter((game) => {
        const matchesTitle = matchesLooseSearchQuery(game.title, searchQuery);
        const matchesOrigTitle = matchesLooseSearchQuery(game.originalStoreTitle, searchQuery);
        return matchesTitle || matchesOrigTitle;
      });

      expect(results.map((g) => g.title)).toEqual(['Cloudpunk']);
    });
  });
});
