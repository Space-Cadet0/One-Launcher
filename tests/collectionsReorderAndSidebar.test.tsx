import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { ManageCollectionsModal } from '../src/components/Library/ManageCollectionsModal';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { useCollectionsManager } from '../src/hooks/useCollectionsManager';
import { loadCollections, saveCollections } from '../src/services/storage/collectionStorage';
import type { GameCollection } from '../src/contracts/collection';
import type { CanonicalGame } from '../src/contracts/game';

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

  return { render };
}

const SAMPLE_COLLECTIONS: GameCollection[] = [
  { id: 'col-a', name: 'Alpha RPGs', icon: 'swords', gameIds: ['game-1'] },
  { id: 'col-b', name: 'Beta Strategy', icon: 'crown', gameIds: ['game-2'] },
  { id: 'col-c', name: 'Gamma Sci-Fi', icon: 'rocket', gameIds: ['game-3'] },
];

const SAMPLE_GAMES: CanonicalGame[] = [
  {
    id: 'game-1',
    title: 'Baldur’s Gate 3',
    sortTitle: 'Baldur’s Gate 3',
    platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: true }],
  },
  {
    id: 'game-2',
    title: 'Age of Empires IV',
    sortTitle: 'Age of Empires IV',
    platforms: [{ platformId: 'steam', platformGameId: '1466860', installed: false }],
  },
  {
    id: 'game-3',
    title: 'Mass Effect Legendary Edition',
    sortTitle: 'Mass Effect Legendary Edition',
    platforms: [{ platformId: 'steam', platformGameId: '1328670', installed: true }],
  },
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
    });
  });
});
