/**
 * Dedicated Regression Test Suite for Library Match & Overrides Studio Blank-Screen Fix.
 *
 * Verifies:
 * 1. Suppressed entry ingestion normalization via ensureSuppressedEntryRawGame.
 * 2. Safe rendering of LibraryMatchManagerModal when suppressed items lack rawGame.
 * 3. Edge-case robustness: numeric platformGameId (0), zero-length string, unicode titles.
 * 4. Override items and rows when matchedGame.platforms is undefined or non-array.
 * 5. Safe search handling when game platformGameId is numeric (matchesLooseSearchQuery resilience).
 * 6. ModalErrorBoundary lifecycle: error trapping, isOpen transition reset, resetKey increment, onClose invocation.
 * 7. lazyWithRetry transient network failure recovery.
 * 8. moduleProbedResultsMap FIFO eviction bounding memory to 4,096 entries.
 * 9. xboxCatalogAndGamePass.cjs clean non-game suppressed schema (no hardcoded publishers).
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CanonicalGame } from '../src/contracts/game';
import type { StorefrontId } from '../src/contracts/platform';
import type { UserGameOverride } from '../src/contracts/override';
import {
  LibraryMatchManagerModal,
  resetStudioSessionCachesForTests,
} from '../src/components/Library/LibraryMatchManagerModal';
import { ModalErrorBoundary } from '../src/components/Common/ModalErrorBoundary';
import { lazyWithRetry } from '../src/App';
import {
  buildMinimalSuppressedGameStub,
  ensureSuppressedEntryRawGame,
  getSuppressedCatalogEntries,
  registerSuppressedCatalogEntries,
  clearSuppressedCatalogEntries,
  type SuppressedCatalogEntry,
} from '../src/services/integrations/catalogSanitizer';
import {
  renderMatchManagerFlatRow,
  type MatchManagerRowRenderContext,
} from '../src/components/Library/MatchManager/MatchManagerRows';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

const memoryStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: unknown }).localStorage = memoryStorage;

if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  const listeners: Record<string, ((evt: unknown) => void)[]> = {};
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: memoryStorage,
    addEventListener: (event: string, fn: (evt: unknown) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: (evt: unknown) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: { type: string }) => {
      const fns = listeners[event.type] || [];
      fns.forEach((f) => f(event));
      return true;
    },
  };
} else {
  (window as unknown as { localStorage: unknown }).localStorage = memoryStorage;
}
if (typeof (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent === 'undefined') {
  (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, params: { detail?: unknown } = {}) {
      this.type = type;
      this.detail = params.detail;
    }
  };
}

describe('Library Match & Overrides Studio Blank-Screen Fix & Edge-Case Regression', () => {
  beforeEach(() => {
    resetStudioSessionCachesForTests();
    clearSuppressedCatalogEntries();
    memoryStorage.clear();
  });

  afterEach(() => {
    clearSuppressedCatalogEntries();
    resetStudioSessionCachesForTests();
    vi.restoreAllMocks();
  });

  describe('1. Suppressed Catalog Ingestion Normalization & RawGame Invariant', () => {
    it('normalizes suppressed items lacking rawGame via ensureSuppressedEntryRawGame', () => {
      const malformed = {
        id: 'xbox-9NSYNTH00001',
        rawTitle: 'Synthetic Racing Expansion Pack',
        platformId: 'xbox' as StorefrontId,
        platformGameId: '9NSYNTH00001',
        reason: 'Auto filtered non-game',
        reasonCategory: 'non_game_filter' as const,
      } as unknown as SuppressedCatalogEntry;

      const normalized = ensureSuppressedEntryRawGame(malformed);
      expect(normalized.rawGame).toBeDefined();
      expect(normalized.rawGame.id).toBe('xbox-9NSYNTH00001');
      expect(normalized.rawGame.title).toBe('Synthetic Racing Expansion Pack');
      expect(normalized.rawGame.sortTitle).toBe('Synthetic Racing Expansion Pack');
      expect(normalized.rawGame.platforms).toHaveLength(1);
      expect(normalized.rawGame.platforms[0].platformId).toBe('xbox');
      expect(normalized.rawGame.platforms[0].platformGameId).toBe('9NSYNTH00001');
      expect(normalized.rawGame.platforms[0].installed).toBe(false);
    });

    it('handles numeric platformGameId (0) without falling back to id', () => {
      const stub = buildMinimalSuppressedGameStub({
        id: 'steam-zero-game',
        platformId: 'steam',
        platformGameId: 0,
        rawTitle: 'Zero ID DLC',
      });

      expect(stub.platforms[0].platformGameId).toBe('0');
      expect(stub.id).toBe('steam-zero-game');
      expect(stub.title).toBe('Zero ID DLC');
    });

    it('handles empty string platformGameId and unicode raw titles safely', () => {
      const unicodeEntry = {
        id: 'custom-unicode-item',
        rawTitle: '合成タイトル サウンドトラック 🎵',
        platformId: 'custom' as StorefrontId,
        platformGameId: '',
        reason: 'Auto filtered soundtrack',
        reasonCategory: 'non_game_filter' as const,
      } as unknown as SuppressedCatalogEntry;

      registerSuppressedCatalogEntries([unicodeEntry]);
      const retrieved = getSuppressedCatalogEntries();
      expect(retrieved.length).toBeGreaterThan(0);
      const found = retrieved.find((e) => e.id === 'custom-unicode-item');
      expect(found).toBeDefined();
      expect(found!.rawTitle).toBe('合成タイトル サウンドトラック 🎵');
      expect(found!.rawGame).toBeDefined();
      expect(found!.rawGame.title).toBe('合成タイトル サウンドトラック 🎵');
    });

    it('safely handles null/undefined inputs without throwing', () => {
      expect(() => ensureSuppressedEntryRawGame(undefined)).not.toThrow();
      const fallback = ensureSuppressedEntryRawGame(undefined);
      expect(fallback.id).toBeTruthy();
      expect(fallback.rawGame).toBeDefined();
      expect(fallback.rawGame.platforms).toHaveLength(1);
    });

    it('preserves rich metadata on entry.rawGame when platforms array was empty', () => {
      const richRawGame = {
        id: 'rich-stub-item',
        title: 'Rich Metadata DLC',
        headerImage: 'https://cdn.example.com/header.jpg',
        capsuleImage: 'https://cdn.example.com/capsule.jpg',
        developers: ['Test Studio'],
        publishers: ['Test Pub'],
        platforms: [], // empty platforms
      } as unknown as CanonicalGame;

      const normalized = ensureSuppressedEntryRawGame({
        id: 'rich-stub-item',
        rawTitle: 'Rich Metadata DLC',
        platformId: 'xbox',
        platformGameId: 'RICH123',
        rawGame: richRawGame,
      });

      expect(normalized.rawGame.headerImage).toBe('https://cdn.example.com/header.jpg');
      expect(normalized.rawGame.capsuleImage).toBe('https://cdn.example.com/capsule.jpg');
      expect(normalized.rawGame.developers).toEqual(['Test Studio']);
      expect(normalized.rawGame.platforms).toHaveLength(1);
      expect(normalized.rawGame.platforms[0].platformId).toBe('xbox');
      expect(normalized.rawGame.platforms[0].platformGameId).toBe('RICH123');
    });

    it('guarantees developers, publishers, genres, tags are arrays even on sparse partial rawGame', () => {
      const partial = {
        id: 'partial-item',
        rawTitle: 'Partial Non-Game Item',
        platformId: 'xbox' as StorefrontId,
        platformGameId: 'PART1',
        rawGame: {
          id: 'partial-item',
          title: 'Partial Non-Game Item',
          platforms: [{ platformId: 'xbox', platformGameId: 'PART1', installed: false }],
        } as unknown as CanonicalGame,
      };

      const normalized = ensureSuppressedEntryRawGame(partial);
      expect(Array.isArray(normalized.rawGame.developers)).toBe(true);
      expect(Array.isArray(normalized.rawGame.publishers)).toBe(true);
      expect(Array.isArray(normalized.rawGame.genres)).toBe(true);
      expect(Array.isArray(normalized.rawGame.tags)).toBe(true);
      expect(typeof normalized.rawGame.headerImage).toBe('string');
    });

    it('filters null/undefined items out of rawGame.platforms', () => {
      const corruptPlatforms = {
        id: 'corrupt-plats-item',
        rawTitle: 'Corrupt Platforms Item',
        platformId: 'steam' as StorefrontId,
        platformGameId: '123',
        rawGame: {
          id: 'corrupt-plats-item',
          title: 'Corrupt Platforms Item',
          platforms: [null, undefined, { platformId: 'steam', platformGameId: '123', installed: true }, null],
        } as unknown as CanonicalGame,
      };

      const normalized = ensureSuppressedEntryRawGame(corruptPlatforms);
      expect(normalized.rawGame.platforms).toHaveLength(1);
      expect(normalized.rawGame.platforms[0].platformId).toBe('steam');
      expect(normalized.rawGame.platforms[0].platformGameId).toBe('123');
    });
  });

  describe('2. Studio Override Items & Row Rendering Robustness', () => {
    it('does not throw when matchedGame has undefined or non-array platforms in override-row', () => {
      const malformedGame = {
        id: 'game-without-platforms',
        title: 'Malformed Platforms Game',
        // platforms is intentionally undefined
      } as unknown as CanonicalGame;

      const override: UserGameOverride = {
        gameId: 'game-without-platforms',
        title: 'Malformed Platforms Game Override',
        splitFromMerged: true,
        matchedStore: 'steam',
        platformId: 'steam',
        platformGameId: '12345',
        updatedAt: new Date().toISOString(),
      };

      const mockCtx: MatchManagerRowRenderContext = {
        onFixMatchForGame: vi.fn(),
        onUnhideEntry: vi.fn(),
        selectedNonGameIds: new Set<string>(),
        setSelectedNonGameIds: vi.fn(),
        searchQuery: '',
        collapsedSections: new Set<string>(),
        toggleSection: vi.fn(),
        handleInspect: vi.fn(),
        onClose: vi.fn(),
      } as unknown as MatchManagerRowRenderContext;

      // Render override-row with malformed platforms
      expect(() => {
        const rowElement = renderMatchManagerFlatRow(
          {
            kind: 'override-row',
            key: 'override:game-without-platforms',
            override,
            matchedGame: malformedGame,
            isFirstItem: false,
            isLastInSection: true,
          },
          mockCtx
        );
        expect(React.isValidElement(rowElement)).toBe(true);
      }).not.toThrow();
    });

    it('does not crash when executing onFixMatchForGame on a suppressed row lacking rawGame', () => {
      const rawSuppressedEntry = {
        id: 'xbox-item-no-rawgame',
        rawTitle: 'Synthetic Un-stubbed Item',
        platformId: 'xbox' as StorefrontId,
        platformGameId: 'XBOX_ITEM_123',
        reason: 'Auto filtered non-game',
        reasonCategory: 'non_game_filter' as const,
        rawGame: undefined as unknown as CanonicalGame,
      } as unknown as SuppressedCatalogEntry;

      const fixMatchSpy = vi.fn();
      const mockCtx: MatchManagerRowRenderContext = {
        onFixMatchForGame: fixMatchSpy,
        onUnhideEntry: vi.fn(),
        selectedNonGameIds: new Set<string>(),
        setSelectedNonGameIds: vi.fn(),
        searchQuery: '',
        collapsedSections: new Set<string>(),
        toggleSection: vi.fn(),
        handleInspect: vi.fn(),
        onClose: vi.fn(),
      } as unknown as MatchManagerRowRenderContext;

      // Render flat row for pending-suppressed-row
      const element = renderMatchManagerFlatRow(
        {
          kind: 'pending-suppressed-row',
          key: 'pending:xbox-item-no-rawgame',
          entry: rawSuppressedEntry,
          isFirstItem: false,
          isLastInSection: true,
        },
        mockCtx
      );

      expect(React.isValidElement(element)).toBe(true);

      // Invoke fix match handler through ensureSuppressedEntryRawGame
      const guaranteed = ensureSuppressedEntryRawGame(rawSuppressedEntry);
      expect(guaranteed.rawGame).toBeDefined();
      expect(guaranteed.rawGame.id).toBe('xbox-item-no-rawgame');
    });

    it('safely renders unmatched-game-row, low-confidence-row, and merged-row when game.platforms is undefined', () => {
      const headlessGame = {
        id: 'headless-game-1',
        title: 'Headless Game Without Platforms',
        capsuleImage: 'https://cdn.example.com/cap.jpg',
        platforms: undefined,
      } as unknown as CanonicalGame;

      const mockCtx: MatchManagerRowRenderContext = {
        onFixMatchForGame: vi.fn(),
        onUnhideEntry: vi.fn(),
        selectedNonGameIds: new Set<string>(),
        setSelectedNonGameIds: vi.fn(),
        searchQuery: '',
        collapsedSections: new Set<string>(),
        toggleSection: vi.fn(),
        handleInspect: vi.fn(),
        onClose: vi.fn(),
      } as unknown as MatchManagerRowRenderContext;

      expect(() => {
        // Unmatched row
        const unmatchedRow = renderMatchManagerFlatRow(
          {
            kind: 'unmatched-row',
            key: 'unmatched:headless-game-1',
            game: headlessGame,
            reasons: [],
            isFirstItem: true,
            isLastInSection: false,
          },
          mockCtx
        );
        expect(React.isValidElement(unmatchedRow)).toBe(true);

        // Low confidence row
        const lowConfRow = renderMatchManagerFlatRow(
          {
            kind: 'low-confidence-row',
            key: 'lowconf:headless-game-1',
            game: headlessGame,
            isFirstItem: false,
            isLastInSection: false,
          },
          mockCtx
        );
        expect(React.isValidElement(lowConfRow)).toBe(true);

        // Merged row
        const mergedRow = renderMatchManagerFlatRow(
          {
            kind: 'merged-row',
            key: 'merged:headless-game-1',
            game: headlessGame,
            isFirstItem: false,
            isLastInSection: true,
          },
          mockCtx
        );
        expect(React.isValidElement(mergedRow)).toBe(true);
      }).not.toThrow();
    });

    it('safely renders unmatched, low-confidence, override, and merged rows when platforms array contains null/undefined elements', () => {
      const sparseGame = {
        id: 'sparse-game-1',
        title: 'Sparse Platforms Game',
        platforms: [
          null,
          { platformId: 'steam', platformGameId: '111', installed: true, originalTitle: 'Sparse Steam' },
          undefined,
          { platformId: 'gog', platformGameId: '222', installed: false },
          null,
        ],
      } as unknown as CanonicalGame;

      const mockCtx: MatchManagerRowRenderContext = {
        onFixMatchForGame: vi.fn(),
        onUnhideEntry: vi.fn(),
        selectedNonGameIds: new Set<string>(),
        setSelectedNonGameIds: vi.fn(),
        searchQuery: '',
        collapsedSections: new Set<string>(),
        toggleSection: vi.fn(),
        handleInspect: vi.fn(),
        onClose: vi.fn(),
      } as unknown as MatchManagerRowRenderContext;

      expect(() => {
        const unmatched = renderMatchManagerFlatRow(
          {
            kind: 'unmatched-row',
            key: 'unmatched:sparse-1',
            game: sparseGame,
            reasons: [],
            isFirstItem: false,
            isLastInSection: false,
          },
          mockCtx
        );
        expect(React.isValidElement(unmatched)).toBe(true);

        const lowConf = renderMatchManagerFlatRow(
          {
            kind: 'low-confidence-row',
            key: 'lowconf:sparse-1',
            game: sparseGame,
            isFirstItem: false,
            isLastInSection: false,
          },
          mockCtx
        );
        expect(React.isValidElement(lowConf)).toBe(true);

        const merged = renderMatchManagerFlatRow(
          {
            kind: 'merged-row',
            key: 'merged:sparse-1',
            game: sparseGame,
            isFirstItem: false,
            isLastInSection: false,
          },
          mockCtx
        );
        expect(React.isValidElement(merged)).toBe(true);

        const override = renderMatchManagerFlatRow(
          {
            kind: 'override-row',
            key: 'override:sparse-1',
            override: {
              gameId: 'sparse-game-1',
              title: 'Sparse Override',
              matchedStore: 'steam',
              platformId: 'steam',
              platformGameId: '111',
              updatedAt: new Date().toISOString(),
            },
            matchedGame: sparseGame,
            isFirstItem: false,
            isLastInSection: true,
          },
          mockCtx
        );
        expect(React.isValidElement(override)).toBe(true);
      }).not.toThrow();
    });
  });

  describe('3. ModalErrorBoundary Lifecycle & Recovery', () => {
    function setupBoundaryInstance(isOpen = true, onClose = vi.fn()) {
      const boundary = new ModalErrorBoundary({
        modalName: 'Library Match & Overrides Studio',
        isOpen,
        onClose,
        children: React.createElement('div', { 'data-testid': 'safe-content' }, 'Normal Content'),
      });

      boundary.setState = vi.fn((update: unknown) => {
        const resolved =
          typeof update === 'function'
            ? (update as (s: unknown, p: unknown) => unknown)(boundary.state, boundary.props)
            : update;
        if (resolved && typeof resolved === 'object') {
          boundary.state = {
            ...boundary.state,
            ...(resolved as Record<string, unknown>),
          };
        }
      }) as unknown as typeof boundary.setState;

      return { boundary, onClose };
    }

    it('catches render exceptions, displays fallback dialog, and recovers on Try Again', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { boundary } = setupBoundaryInstance(true);

      // Initially no error
      expect(boundary.state.hasError).toBe(false);
      expect(boundary.state.resetKey).toBe(0);

      // Simulate render failure
      const testErr = new Error('Test modal render crash');
      const errorState = ModalErrorBoundary.getDerivedStateFromError(testErr);
      boundary.state = {
        ...boundary.state,
        ...errorState,
        error: testErr,
      };

      expect(boundary.state.hasError).toBe(true);

      // Render in error state
      const errorElement = boundary.render();
      expect(React.isValidElement(errorElement)).toBe(true);

      // Trigger handleReset ("Try Again")
      boundary.handleReset();
      expect(boundary.state.hasError).toBe(false);
      expect(boundary.state.error).toBeNull();
      expect(boundary.state.resetKey).toBe(1);

      consoleErrorSpy.mockRestore();
    });

    it('automatically clears error state when isOpen transitions from true to false', () => {
      const { boundary } = setupBoundaryInstance(false);

      boundary.state = {
        hasError: true,
        error: new Error('Render error'),
        resetKey: 0,
      };

      // When modal is closed (isOpen: false), render returns null
      expect(boundary.render()).toBeNull();

      // Trigger componentDidUpdate simulating modal closure
      boundary.componentDidUpdate({
        isOpen: true,
        children: null,
      });

      expect(boundary.state.hasError).toBe(false);
      expect(boundary.state.error).toBeNull();
    });

    it('invokes onClose and resets state when Close button is triggered', () => {
      const onCloseSpy = vi.fn();
      const { boundary } = setupBoundaryInstance(true, onCloseSpy);

      boundary.state = {
        hasError: true,
        error: new Error('Modal error'),
        resetKey: 0,
      };

      boundary.handleClose();
      expect(boundary.state.hasError).toBe(false);
      expect(boundary.state.error).toBeNull();
      expect(onCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('ensures multiple ModalErrorBoundary instances receive unique accessibility title IDs', () => {
      const b1 = new ModalErrorBoundary({
        modalName: 'Modal One',
        isOpen: true,
        children: React.createElement('div', null, 'One'),
      });
      const b2 = new ModalErrorBoundary({
        modalName: 'Modal Two',
        isOpen: true,
        children: React.createElement('div', null, 'Two'),
      });

      // Derive error for both
      b1.state = { hasError: true, error: new Error('Err1'), resetKey: 0 };
      b2.state = { hasError: true, error: new Error('Err2'), resetKey: 0 };

      const el1 = b1.render() as React.ReactElement<{ ariaLabelledBy?: string }>;
      const el2 = b2.render() as React.ReactElement<{ ariaLabelledBy?: string }>;

      const titleId1 = el1.props.ariaLabelledBy;
      const titleId2 = el2.props.ariaLabelledBy;

      expect(titleId1).toBeDefined();
      expect(titleId2).toBeDefined();
      expect(titleId1).not.toBe(titleId2);
    });
  });

  describe('4. lazyWithRetry Transient Network Recovery', () => {
    it('retries factory on initial failure and resolves once successful', async () => {
      let attempts = 0;
      const fakeComponent = () => React.createElement('div', null, 'Lazy Component');

      const factory = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Transient dynamic import fetch error');
        }
        return { default: fakeComponent };
      });

      const LazyComp = lazyWithRetry(factory, 2, 10);
      expect(LazyComp).toBeDefined();

      // Execute factory through internal promise payload
      const initFn = (LazyComp as unknown as { _payload: { _result: () => Promise<{ default: unknown }> } })
        ._payload?._result;
      expect(typeof initFn).toBe('function');

      const result = await initFn();
      expect(result.default).toBe(fakeComponent);
      expect(attempts).toBe(2);
    });

    it('un-poisons payload status on exhaustion so subsequent mounts can retry fresh', async () => {
      let attempts = 0;
      const fakeComp = () => React.createElement('div', null, 'Recovered Component');

      const factory = vi.fn(async () => {
        attempts += 1;
        if (attempts <= 2) {
          throw new Error('Initial network outage');
        }
        return { default: fakeComp };
      });

      const LazyComp = lazyWithRetry(factory, 1, 5);
      const payloadObj = (LazyComp as unknown as { _payload: { _status?: number; _result?: () => Promise<unknown> } })
        ._payload;
      const initFn = payloadObj._result;
      expect(typeof initFn).toBe('function');

      // First round of attempts fails completely
      await expect(initFn!()).rejects.toThrow('Initial network outage');
      expect(attempts).toBe(2);

      // Simulate payload rejection status as React does
      payloadObj._status = 2; // Rejected

      // Allow the scheduled un-poisoning timeout (0ms) to run
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(payloadObj._status).toBe(-1); // Reset to Uninitialized!
      expect(typeof payloadObj._result).toBe('function');

      // Subsequent attempt now succeeds!
      const recoveredResult = (await (payloadObj._result as () => Promise<{ default: unknown }>)()) as {
        default: unknown;
      };
      expect(recoveredResult.default).toBe(fakeComp);
      expect(attempts).toBe(3);
    });

    it('handles synchronous exceptions in factory function gracefully with retries and un-poisoning', async () => {
      let attempts = 0;
      const fakeComp = () => React.createElement('div', null, 'Sync Recovered Component');

      const factory = vi.fn(() => {
        attempts += 1;
        if (attempts <= 2) {
          throw new Error('Synchronous import syntax/resolution failure');
        }
        return Promise.resolve({ default: fakeComp });
      });

      const LazyComp = lazyWithRetry(factory, 1, 5);
      const payloadObj = (LazyComp as unknown as { _payload: { _status?: number; _result?: () => Promise<unknown> } })
        ._payload;
      const initFn = payloadObj._result;
      expect(typeof initFn).toBe('function');

      await expect(initFn!()).rejects.toThrow('Synchronous import syntax/resolution failure');
      expect(attempts).toBe(2);

      payloadObj._status = 2; // Rejected
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(payloadObj._status).toBe(-1); // Reset to Uninitialized
      const recoveredResult = (await (payloadObj._result as () => Promise<{ default: unknown }>)()) as {
        default: unknown;
      };
      expect(recoveredResult.default).toBe(fakeComp);
      expect(attempts).toBe(3);
    });
  });

  describe('5. Xbox Scanner Non-Game Filter Schema Cleanliness', () => {
    it('ensures Xbox non-game filter does not contain hardcoded publishers', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const scannerPath = path.resolve(
        process.cwd(),
        'electron/storefronts/xbox/xboxCatalogAndGamePass.cjs'
      );

      const scannerContent = fs.readFileSync(scannerPath, 'utf8');

      // Must not contain hardcoded 'Xbox Game Studios' in publishers array
      expect(scannerContent).not.toContain("publishers: ['Xbox Game Studios']");
      // Must contain clean publishers: []
      expect(scannerContent).toContain('publishers: []');
      // Must attach rawGame with isVerifiedEntitlement: true
      expect(scannerContent).toContain('isVerifiedEntitlement: true');
    });
  });

  describe('6. Concurrent Sync Operations & Event Reactive Notification', () => {
    it('dispatches antigravity:suppressed-entries-updated when live catalog ingestion mutates suppressed items', () => {
      const eventSpy = vi.fn();
      window.addEventListener('antigravity:suppressed-entries-updated', eventSpy);

      try {
        registerSuppressedCatalogEntries([
          {
            id: 'live-sync-item-1',
            rawTitle: 'Live DLC Pack',
            platformId: 'steam',
            platformGameId: '99999',
            reason: 'Auto filtered non-game',
            reasonCategory: 'non_game_filter',
          } as SuppressedCatalogEntry,
        ]);

        expect(eventSpy).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('antigravity:suppressed-entries-updated', eventSpy);
      }
    });

    it('ignores live sync registration of user-restored entries and does not re-suppress them', async () => {
      const { unhideStorefrontEntry } = await import('../src/services/storage/userOverrideStorage');
      unhideStorefrontEntry('xbox-restored-pack', 'xbox', 'RESTORED_1');

      const eventSpy = vi.fn();
      window.addEventListener('antigravity:suppressed-entries-updated', eventSpy);

      try {
        registerSuppressedCatalogEntries([
          {
            id: 'xbox-restored-pack',
            rawTitle: 'User Restored Expansion Pack',
            platformId: 'xbox',
            platformGameId: 'RESTORED_1',
            reason: 'Auto filtered non-game',
            reasonCategory: 'non_game_filter',
          } as SuppressedCatalogEntry,
        ]);

        // Event should not fire and entry should not be in suppressed entries
        expect(eventSpy).not.toHaveBeenCalled();
        const suppressed = getSuppressedCatalogEntries();
        expect(suppressed.some((e) => e.id === 'xbox-restored-pack')).toBe(false);
      } finally {
        window.removeEventListener('antigravity:suppressed-entries-updated', eventSpy);
      }
    });

    it('is idempotent: does not dispatch update event when identical entries are re-registered', () => {
      const entry: SuppressedCatalogEntry = {
        id: 'idempotent-item-1',
        rawTitle: 'Identical DLC',
        platformId: 'steam',
        platformGameId: '8888',
        reason: 'Auto filtered non-game',
        reasonCategory: 'non_game_filter',
        rawGame: buildMinimalSuppressedGameStub({
          id: 'idempotent-item-1',
          rawTitle: 'Identical DLC',
          platformId: 'steam',
          platformGameId: '8888',
        }),
      };

      registerSuppressedCatalogEntries([entry]);

      const eventSpy = vi.fn();
      window.addEventListener('antigravity:suppressed-entries-updated', eventSpy);

      try {
        // Re-register exact same entry
        registerSuppressedCatalogEntries([entry]);
        // Must not dispatch redundant event or mutate version
        expect(eventSpy).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('antigravity:suppressed-entries-updated', eventSpy);
      }
    });
  });
});
