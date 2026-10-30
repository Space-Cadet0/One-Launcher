/**
 * Wave 3A — Hermetic Regression Suite for Studio Lifecycle, Multi-Key Custom Match Reset,
 * and Custom / Cross-Storefront Cover Art Selection (`macOS darwin` + `Windows win32`).
 *
 * Strictly Zero-PII (100% synthetic titles, IDs, and `os.tmpdir()` paths),
 * offline `net.Socket`-safe, and fast (`< 6s`).
 *
 * Covers:
 * - Suite 1 (Issue 1): `O(1)` Storage Cache Coherence, `<dialog>` Top-Layer Geometry &
 *   Studio `10x` Exit -> Re-Enter / Stacked `FixMatchWizardModal` Suspend Lifecycle,
 *   `requestScheduler` `AbortSignal` Queue Eviction, and `integrationStorage` Re-Open Flush Cancellation.
 * - Suite 2 (Issue 2): Multi-Key Custom Match `"Reset"` in Both Studio (`OverrideRow`) &
 *   `FixMatchWizardModal` (`"Reset to Default"`) across Legacy 3-Key Orphaned State + `nativeBaseline`.
 * - Suite 3 (Issue 3): Real SQLite `OfflineVaultService` + `StorefrontLocalCacheFederator`
 *   Startup Self-Heal, Cross-Storefront / 64-Hex / `ov` Federation Guards, Same-Storefront
 *   `"Enhanced"` Collision Protection, and `GameCardCover` `_2x.jpg` + `ratio > 0.94` Acceptance.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestDOMParser, type ParsedDomElementNode } from './helpers/domParserHelper';
import type { CanonicalGame } from '../src/contracts/game';
import type { StorefrontId } from '../src/contracts/platform';
import type { UserGameOverride } from '../src/contracts/override';
import {
  LibraryMatchManagerModal,
  recordDurableEmptySynopsisProbe,
  resetStudioSessionCachesForTests,
} from '../src/components/Library/LibraryMatchManagerModal';
import {
  STORAGE_KEY_EMPTY_SYNOPSIS_PROBES,
  loadDurableEmptySynopsisProbeMap,
} from '../src/components/Library/MatchManager/matchManagerDiagnostics';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import { GameCardCover } from '../src/components/Library/Grid/GameCardCover';
import {
  failedCoverUrls,
  getCoverCandidates,
} from '../src/components/Library/Grid/gridCoverUtils';
import {
  STORAGE_KEY_HIDDEN_ENTRIES,
  STORAGE_KEY_USER_OVERRIDES,
  getUserOverrideForGame,
  hideStorefrontEntry,
  hydrateUserOverridesFromVault,
  loadHiddenStorefrontEntries,
  loadUserOverrides,
  saveUserOverride,
} from '../src/services/storage/userOverrideStorage';
import {
  LAUNCH_CONFIGS_STORAGE_KEY,
  getLaunchConfigFromStorage,
  persistLocalLaunchConfigsToStorage,
} from '../src/services/launcher/launchConfigStore';
import {
  clearSuppressedCatalogEntries,
  registerSuppressedCatalogEntries,
  sanitizeGameCatalog,
} from '../src/services/integrations/catalogSanitizer';
import {
  clearIntegrationStorage,
  loadSavedCatalog,
  saveCurrentCatalog,
} from '../src/services/integrations/integrationStorage';

const MAIN_CATALOG_STORAGE_KEY = 'universal_game_library_catalog';
import {
  RequestPriority,
  RequestScheduler,
} from '../src/services/network/requestScheduler';
import { useCatalogOverrideSync } from '../src/hooks/useCatalogOverrideSync';
import { acquireModalOverlayLock, isModalOverlayOpen } from '../src/utils/modalOverlayLock';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (dbPath: string, opts?: { readOnly?: boolean }) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      run: (...args: unknown[]) => { changes?: number };
      get: (...args: unknown[]) => Record<string, unknown> | undefined;
      all: (...args: unknown[]) => Array<Record<string, unknown>>;
    };
    close: () => void;
  };
};

const { OfflineVaultService } = nodeRequire('../electron/launcher/offlineVaultService.cjs') as {
  OfflineVaultService: new (opts?: Record<string, unknown>) => {
    ensureOpen: () => {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        run: (...args: unknown[]) => { changes?: number };
        get: (...args: unknown[]) => Record<string, unknown> | undefined;
        all: (...args: unknown[]) => Array<Record<string, unknown>>;
      };
    };
    upsertGames: (games: unknown[]) => { success: boolean; upserted?: number };
    deleteGames: (ids: string[]) => { success: boolean; deleted?: number };
    saveUserOverride: (
      gameId: string,
      record?: Record<string, unknown>,
      extraKeys?: string[]
    ) => { success: boolean; invalidated: number };
    removeUserOverride: (
      gameId: string,
      extraKeys?: string[]
    ) => { success: boolean; invalidated: number };
    resolveMediaRequest: (
      params: Record<string, unknown> | string,
      opts?: Record<string, unknown>
    ) => Promise<{
      kind: 'file' | 'buffer' | 'error';
      filePath?: string;
      buffer?: Buffer;
      mimeType?: string;
      sizeBytes?: number;
      status?: number;
      reason?: string;
      source?: string;
    }>;
    shutdown: () => void;
    federator?: unknown;
  };
};

const {
  StorefrontLocalCacheFederator,
  clearFederatorCaches,
} = nodeRequire('../electron/launcher/storefrontLocalCacheFederator.cjs') as {
  StorefrontLocalCacheFederator: new (opts?: Record<string, unknown>) => {
    resolveFederatedAsset: (params: Record<string, unknown>) => Record<string, unknown> | null;
    resolveLocalMetadata: (payload: Record<string, unknown>) => Record<string, unknown> | null;
    trimMemory: () => void;
  };
  clearFederatorCaches: () => void;
};

const {
  registerOfflineVaultIpcHandlers,
  readUserOverridesAsync,
  writeUserOverridesToDiskAsync,
} = nodeRequire('../electron/ipc/offlineVaultIpcHandlers.cjs') as {
  registerOfflineVaultIpcHandlers: (deps: Record<string, unknown>) => { dispose: () => void };
  readUserOverridesAsync: (filePath: string) => Promise<Record<string, UserGameOverride>>;
  writeUserOverridesToDiskAsync: (
    filePath: string,
    overridesMap: Record<string, unknown>
  ) => Promise<boolean>;
};

// ============================================================================
// Hermetic Browser, Storage, IndexedDB & React 19 `<dialog>` Client Harness
// ============================================================================

class HermeticStorage implements Storage {
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

class HermeticStorageEvent extends Event {
  readonly key: string | null;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly url: string;
  readonly storageArea: Storage | null;

  constructor(
    type: string,
    init?: {
      key?: string | null;
      oldValue?: string | null;
      newValue?: string | null;
      url?: string;
      storageArea?: Storage | null;
    }
  ) {
    super(type);
    this.key = init?.key !== undefined ? init.key : null;
    this.oldValue = init?.oldValue ?? null;
    this.newValue = init?.newValue ?? null;
    this.url = init?.url ?? 'http://localhost/';
    this.storageArea = init?.storageArea ?? null;
  }
}

interface MockIdbRequest<T = unknown> {
  result: T;
  error: Error | null;
  onsuccess: ((ev: { target: MockIdbRequest<T> }) => void) | null;
  onerror: ((ev: { target: MockIdbRequest<T> }) => void) | null;
  onupgradeneeded?: ((ev: { target: MockIdbRequest<T> }) => void) | null;
}

const activeIdbDatabases = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();

function createAsyncIdbRequest<T>(compute: () => T): MockIdbRequest<T> {
  const req: MockIdbRequest<T> = {
    result: undefined as unknown as T,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => {
    try {
      req.result = compute();
      req.onsuccess?.({ target: req });
    } catch (err) {
      req.error = err instanceof Error ? err : new Error(String(err));
      req.onerror?.({ target: req });
    }
  });
  return req;
}

function createHermeticIndexedDbFactory(): IDBFactory {
  return {
    open(dbName: string) {
      let dbStores = activeIdbDatabases.get(dbName);
      const isUpgrade = !dbStores;
      if (!dbStores) {
        dbStores = new Map<string, Map<IDBValidKey, unknown>>();
        activeIdbDatabases.set(dbName, dbStores);
      }
      const resolvedDbStores = dbStores;

      const dbObject = {
        name: dbName,
        objectStoreNames: {
          contains: (storeName: string) => resolvedDbStores.has(storeName),
        },
        createObjectStore(storeName: string) {
          if (!resolvedDbStores.has(storeName)) {
            resolvedDbStores.set(storeName, new Map<IDBValidKey, unknown>());
          }
          return {};
        },
        transaction() {
          const txObj: {
            oncomplete: (() => void) | null;
            onabort: (() => void) | null;
            onerror: (() => void) | null;
            error: Error | null;
            objectStore: (storeName: string) => Record<string, unknown>;
          } = {
            oncomplete: null,
            onabort: null,
            onerror: null,
            error: null,
            objectStore(storeName: string) {
              if (!resolvedDbStores.has(storeName)) {
                resolvedDbStores.set(storeName, new Map<IDBValidKey, unknown>());
              }
              const kv = resolvedDbStores.get(storeName)!;
              const scheduleTxComplete = () => {
                queueMicrotask(() => {
                  txObj.oncomplete?.();
                });
              };
              return {
                get(key: IDBValidKey) {
                  const r = createAsyncIdbRequest(() => kv.get(key));
                  scheduleTxComplete();
                  return r;
                },
                put(value: unknown, key: IDBValidKey) {
                  const r = createAsyncIdbRequest(() => {
                    kv.set(key, structuredClone(value));
                    return key;
                  });
                  scheduleTxComplete();
                  return r;
                },
                delete(key: IDBValidKey) {
                  const r = createAsyncIdbRequest(() => {
                    kv.delete(key);
                    return undefined;
                  });
                  scheduleTxComplete();
                  return r;
                },
                clear() {
                  const r = createAsyncIdbRequest(() => {
                    kv.clear();
                    return undefined;
                  });
                  scheduleTxComplete();
                  return r;
                },
                getAllKeys() {
                  const r = createAsyncIdbRequest(() => Array.from(kv.keys()));
                  scheduleTxComplete();
                  return r;
                },
                getAll() {
                  const r = createAsyncIdbRequest(() =>
                    Array.from(kv.values()).map((v) => structuredClone(v))
                  );
                  scheduleTxComplete();
                  return r;
                },
              };
            },
          };
          return txObj;
        },
        close() {},
      };

      const openReq: MockIdbRequest<typeof dbObject> = {
        result: dbObject,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };

      queueMicrotask(() => {
        if (isUpgrade) {
          openReq.onupgradeneeded?.({ target: openReq });
        }
        openReq.onsuccess?.({ target: openReq });
      });

      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function parseHtmlDocument(html: string): {
  body: ParsedDomElementNode;
  querySelector: (selector: string) => ParsedDomElementNode | null;
  querySelectorAll: (selector: string) => ParsedDomElementNode[];
} {
  const parsed = new TestDOMParser().parseFromString(html, 'text/html');
  return {
    body: parsed.body,
    querySelector: parsed.querySelector,
    querySelectorAll: parsed.querySelectorAll,
  };
}

interface HostViewportMetrics {
  clientWidth: number;
  clientHeight: number;
  gateScrollElementByDialogOpen?: boolean;
}

interface StubHostElement {
  tagName: string;
  isConnected: boolean;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  open: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  ownerDocument: { defaultView: unknown };
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  hasAttribute: (name: string) => boolean;
  addEventListener: (type: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener: (type: string, listener: (...args: unknown[]) => void) => void;
  getBoundingClientRect: () => DOMRect;
  scrollTo: (opts?: { top?: number; left?: number } | number, y?: number) => void;
  focus: () => void;
  showModal: () => void;
  close: () => void;
}

interface RenderedElementRecord {
  tag: string;
  props: Record<string, unknown>;
}

interface FiberRecord {
  states: unknown[];
  refs: Array<{ current: unknown }>;
  memos: Array<{ deps?: readonly unknown[]; value: unknown }>;
  effectDeps: Array<readonly unknown[] | undefined>;
  effectCleanups: Array<(() => void) | undefined>;
  layoutDeps: Array<readonly unknown[] | undefined>;
  layoutCleanups: Array<(() => void) | undefined>;
}

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const REACT_PORTAL_SYMBOL = Symbol.for('react.portal');
const REACT_MEMO_SYMBOL = Symbol.for('react.memo');
const REACT_FORWARD_REF_SYMBOL = Symbol.for('react.forward_ref');
const REACT_PROVIDER_SYMBOL = Symbol.for('react.provider');
const REACT_CONTEXT_SYMBOL = Symbol.for('react.context');

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssCamelToKebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function serializeStyleObject(style: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${cssCamelToKebab(k)}:${String(v)}`);
  }
  return parts.join(';');
}

/**
 * React 19 Client Renderer Harness with Native `<dialog>` Top-Layer Geometry Simulation:
 * When `gateScrollElementByDialogOpen` is enabled, child scroll containers inside `<dialog>`
 * report `clientHeight === 0` (`display: none`) while `dialog.open === false` and
 * `clientHeight === viewportMetrics.clientHeight` (`600`) immediately once `dialog.showModal()`
 * opens the `<dialog>` in `useLayoutEffect`.
 */
function createClientComponentRoot<P extends object>(
  Component: React.ComponentType<P>,
  initialProps: P,
  initialMetrics: HostViewportMetrics = {
    clientWidth: 960,
    clientHeight: 600,
    gateScrollElementByDialogOpen: false,
  }
) {
  let currentProps: P = { ...initialProps };
  const viewportMetrics: HostViewportMetrics = { ...initialMetrics };
  const fibers = new Map<string, FiberRecord>();
  const hostElements = new Map<string, StubHostElement>();
  const activeResizeCallbacks = new Set<ResizeObserverCallback>();
  let enclosingDialogStub: StubHostElement | null = null;
  let isUnmounted = false;
  let dirtyFromStateUpdate = false;
  let latestHtml = '';
  let latestElements: RenderedElementRecord[] = [];

  const prevResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
  class ControlledResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      activeResizeCallbacks.add(cb);
    }
    observe(_target: Element) {}
    unobserve(_target: Element) {}
    disconnect() {
      activeResizeCallbacks.delete(this.cb);
    }
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ControlledResizeObserver;
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).ResizeObserver = ControlledResizeObserver;
  }

  const getOrCreateFiber = (fiberKey: string): FiberRecord => {
    let rec = fibers.get(fiberKey);
    if (!rec) {
      rec = {
        states: [],
        refs: [],
        memos: [],
        effectDeps: [],
        effectCleanups: [],
        layoutDeps: [],
        layoutCleanups: [],
      };
      fibers.set(fiberKey, rec);
    }
    return rec;
  };

  const getOrCreateStubElement = (
    elKey: string,
    tag: string,
    props: Record<string, unknown>
  ): StubHostElement => {
    let stub = hostElements.get(elKey);
    const attrs = new Map<string, string>();
    const dataset: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) {
      if (
        v === undefined ||
        v === null ||
        typeof v === 'function' ||
        k === 'children' ||
        k === 'ref' ||
        k === 'style'
      ) {
        continue;
      }
      const attrName = k === 'className' ? 'class' : k === 'htmlFor' ? 'for' : k;
      if (typeof v === 'boolean') {
        if (v) attrs.set(attrName, '');
      } else {
        attrs.set(attrName, String(v));
      }
      if (k.startsWith('data-')) {
        const camel = k
          .slice(5)
          .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
        dataset[camel] = String(v);
      }
    }
    const isRowItem = props['data-index'] !== undefined;
    const isDialogTag = tag.toLowerCase() === 'dialog';

    const computeEffectiveWidth = (): number => {
      if (isRowItem) return Math.max(viewportMetrics.clientWidth, 960);
      if (
        viewportMetrics.gateScrollElementByDialogOpen &&
        !isDialogTag &&
        (!enclosingDialogStub || !enclosingDialogStub.open)
      ) {
        return 0;
      }
      if (attrs.has('hidden')) return 0;
      return viewportMetrics.clientWidth;
    };

    const computeEffectiveHeight = (): number => {
      if (isRowItem) return 78;
      if (
        viewportMetrics.gateScrollElementByDialogOpen &&
        !isDialogTag &&
        (!enclosingDialogStub || !enclosingDialogStub.open)
      ) {
        return 0;
      }
      if (attrs.has('hidden')) return 0;
      return viewportMetrics.clientHeight;
    };

    if (!stub) {
      let openState = Boolean(props.open);
      stub = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        get clientWidth() {
          return computeEffectiveWidth();
        },
        get clientHeight() {
          return computeEffectiveHeight();
        },
        get offsetWidth() {
          return computeEffectiveWidth();
        },
        get offsetHeight() {
          return computeEffectiveHeight();
        },
        scrollTop: 0,
        scrollLeft: 0,
        scrollHeight: 24_000,
        scrollWidth: 960,
        get open() {
          return openState;
        },
        set open(val: boolean) {
          openState = val;
        },
        style: {},
        dataset,
        ownerDocument: { defaultView: typeof window !== 'undefined' ? window : globalThis },
        getAttribute: (name: string) => attrs.get(name) ?? null,
        setAttribute: (name: string, value: string) => {
          attrs.set(name, value);
          if (name === 'open') openState = true;
        },
        removeAttribute: (name: string) => {
          attrs.delete(name);
          if (name === 'open') openState = false;
        },
        hasAttribute: (name: string) => attrs.has(name),
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => {
          const w = computeEffectiveWidth();
          const h = computeEffectiveHeight();
          return {
            top: 0,
            left: 0,
            right: w,
            bottom: h,
            width: w,
            height: h,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        },
        scrollTo: (opts) => {
          if (typeof opts === 'object' && opts !== null && typeof opts.top === 'number') {
            stub!.scrollTop = opts.top;
          } else if (typeof opts === 'number') {
            stub!.scrollTop = opts;
          }
        },
        focus: () => {},
        showModal: () => {
          const wasClosed = !openState;
          openState = true;
          attrs.set('open', '');
          if (wasClosed) {
            for (const cb of Array.from(activeResizeCallbacks)) {
              cb([], {} as ResizeObserver);
            }
          }
        },
        close: () => {
          openState = false;
          attrs.delete('open');
        },
      };
      hostElements.set(elKey, stub);
    } else {
      stub.dataset = dataset;
      stub.getAttribute = (name: string) => attrs.get(name) ?? null;
      stub.hasAttribute = (name: string) => attrs.has(name);
    }

    if (isDialogTag) {
      enclosingDialogStub = stub;
    }
    return stub;
  };

  const executeSingleRenderCycle = () => {
    const seenFibers = new Set<string>();
    const elements: RenderedElementRecord[] = [];
    const refCommits: Array<() => void> = [];
    const pendingLayouts: Array<{
      fiber: FiberRecord;
      idx: number;
      fn: () => void | (() => void);
    }> = [];
    const pendingEffects: Array<{
      fiber: FiberRecord;
      idx: number;
      fn: () => void | (() => void);
    }> = [];

    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    let activeFiber: FiberRecord | null = null;
    let activeFiberKey = '';
    let activeComponentPendingLayouts: Array<{
      fiber: FiberRecord;
      idx: number;
      fn: () => void | (() => void);
    }> = [];
    let stateIdx = 0;
    let refIdx = 0;
    let memoIdx = 0;
    let layoutIdx = 0;
    let effectIdx = 0;
    let idIdx = 0;

    const depsChanged = (
      prev: readonly unknown[] | undefined,
      next: readonly unknown[] | undefined
    ) =>
      prev === undefined ||
      next === undefined ||
      prev.length !== next.length ||
      next.some((d, i) => !Object.is(d, prev[i]));

    const clientDispatcher = {
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
            dirtyFromStateUpdate = true;
          }
        };
        return [fiber.states[idx] as S, setState] as const;
      },
      useReducer<S, I, A>(
        reducer: (state: S, action: A) => S,
        initialArg: I,
        init?: (arg: I) => S
      ) {
        const fiber = activeFiber!;
        const idx = stateIdx++;
        if (idx >= fiber.states.length) {
          fiber.states.push(init ? init(initialArg) : (initialArg as unknown as S));
        }
        const dispatch = (action: A) => {
          if (isUnmounted) return;
          const prevVal = fiber.states[idx] as S;
          const nextVal = reducer(prevVal, action);
          if (!Object.is(prevVal, nextVal)) {
            fiber.states[idx] = nextVal;
            dirtyFromStateUpdate = true;
          }
        };
        return [fiber.states[idx] as S, dispatch] as const;
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
        return clientDispatcher.useMemo(() => cb, deps);
      },
      useLayoutEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
        const fiber = activeFiber!;
        const idx = layoutIdx++;
        if (depsChanged(fiber.layoutDeps[idx], deps)) {
          fiber.layoutDeps[idx] = deps ? [...deps] : undefined;
          activeComponentPendingLayouts.push({ fiber, idx, fn });
        }
      },
      useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
        const fiber = activeFiber!;
        const idx = effectIdx++;
        if (depsChanged(fiber.effectDeps[idx], deps)) {
          fiber.effectDeps[idx] = deps ? [...deps] : undefined;
          pendingEffects.push({ fiber, idx, fn });
        }
      },
      useSyncExternalStore<T>(
        subscribe: (onStoreChange: () => void) => () => void,
        getSnapshot: () => T,
        _getServerSnapshot?: () => T
      ): T {
        const value = getSnapshot();
        clientDispatcher.useEffect(
          () =>
            subscribe(() => {
              dirtyFromStateUpdate = true;
            }),
          [subscribe]
        );
        return value;
      },
      useId(): string {
        const idx = idIdx++;
        const safe = activeFiberKey.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `«r-${safe}-${idx}»`;
      },
      useContext<T>(ctx: React.Context<T> & { _currentValue?: T }): T {
        return ctx._currentValue as T;
      },
      useDeferredValue<T>(val: T): T {
        return val;
      },
      useTransition() {
        return [
          false,
          (cb: () => void) => {
            cb();
          },
        ] as const;
      },
    };

    const renderComponentWithHooks = (
      fiberKey: string,
      invoke: () => React.ReactNode
    ): string => {
      seenFibers.add(fiberKey);
      const prevFiber = activeFiber;
      const prevKey = activeFiberKey;
      const prevOwnLayouts = activeComponentPendingLayouts;
      const prevIndices = [stateIdx, refIdx, memoIdx, layoutIdx, effectIdx, idIdx] as const;

      activeFiber = getOrCreateFiber(fiberKey);
      activeFiberKey = fiberKey;
      const ownLayouts: Array<{
        fiber: FiberRecord;
        idx: number;
        fn: () => void | (() => void);
      }> = [];
      activeComponentPendingLayouts = ownLayouts;
      stateIdx = 0;
      refIdx = 0;
      memoIdx = 0;
      layoutIdx = 0;
      effectIdx = 0;
      idIdx = 0;

      try {
        const out = invoke();
        const rendered = renderNode(out, fiberKey);
        // True React bottom-up `useLayoutEffect` commit order (children commit before parents)
        pendingLayouts.push(...ownLayouts);
        return rendered;
      } finally {
        activeFiber = prevFiber;
        activeFiberKey = prevKey;
        activeComponentPendingLayouts = prevOwnLayouts;
        [stateIdx, refIdx, memoIdx, layoutIdx, effectIdx, idIdx] = prevIndices;
      }
    };

    const renderNode = (node: unknown, pathKey: string): string => {
      if (node === null || node === undefined || typeof node === 'boolean') {
        return '';
      }
      if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
        return escapeHtml(String(node));
      }
      if (Array.isArray(node)) {
        return node.map((child, idx) => renderNode(child, `${pathKey}[${idx}]`)).join('');
      }
      if (typeof node === 'object') {
        const obj = node as {
          $$typeof?: symbol;
          type?: unknown;
          key?: string | number | null;
          props?: Record<string, unknown>;
          children?: unknown;
        };

        if (obj.$$typeof === REACT_PORTAL_SYMBOL) {
          return renderNode(obj.children, `${pathKey}:portal`);
        }

        if (!React.isValidElement(node)) {
          return '';
        }

        const keyPart = node.key != null ? String(node.key) : '0';
        const rawProps = (node.props ?? {}) as Record<string, unknown>;
        const elRef = rawProps.ref;
        const elType = node.type as unknown;

        if (elType === React.Fragment) {
          return renderNode(rawProps.children, `${pathKey}/frag:${keyPart}`);
        }

        if (typeof elType === 'function') {
          const fnName =
            (elType as { displayName?: string; name?: string }).displayName ||
            (elType as { name?: string }).name ||
            'Anon';
          return renderComponentWithHooks(`${pathKey}/${fnName}:${keyPart}`, () =>
            (elType as (p: Record<string, unknown>) => React.ReactNode)(rawProps)
          );
        }

        if (typeof elType === 'object' && elType !== null) {
          const wrapper = elType as {
            $$typeof?: symbol;
            type?: unknown;
            render?: (p: Record<string, unknown>, r: unknown) => React.ReactNode;
            _context?: { _currentValue?: unknown };
            _currentValue?: unknown;
          };

          if (wrapper.$$typeof === REACT_MEMO_SYMBOL && typeof wrapper.type === 'function') {
            const inner = wrapper.type;
            const fnName =
              (inner as { displayName?: string; name?: string }).displayName ||
              (inner as { name?: string }).name ||
              'Memo';
            return renderComponentWithHooks(`${pathKey}/Memo(${fnName}):${keyPart}`, () =>
              (inner as (p: Record<string, unknown>) => React.ReactNode)(rawProps)
            );
          }

          if (
            wrapper.$$typeof === REACT_FORWARD_REF_SYMBOL &&
            typeof wrapper.render === 'function'
          ) {
            const fnName =
              (wrapper.render as { displayName?: string; name?: string }).displayName ||
              (wrapper.render as { name?: string }).name ||
              'ForwardRef';
            return renderComponentWithHooks(`${pathKey}/Fwd(${fnName}):${keyPart}`, () =>
              wrapper.render!(rawProps, elRef ?? null)
            );
          }

          if (wrapper.$$typeof === REACT_PROVIDER_SYMBOL && wrapper._context) {
            const ctx = wrapper._context;
            const prevVal = ctx._currentValue;
            ctx._currentValue = rawProps.value;
            try {
              return renderNode(rawProps.children, `${pathKey}/Provider:${keyPart}`);
            } finally {
              ctx._currentValue = prevVal;
            }
          }

          if (wrapper.$$typeof === REACT_CONTEXT_SYMBOL && 'value' in rawProps) {
            const prevVal = wrapper._currentValue;
            wrapper._currentValue = rawProps.value;
            try {
              return renderNode(rawProps.children, `${pathKey}/CtxProvider:${keyPart}`);
            } finally {
              wrapper._currentValue = prevVal;
            }
          }
        }

        if (typeof elType === 'string') {
          const tag = elType;
          const domKey = `${pathKey}/${tag}:${keyPart}`;
          elements.push({ tag, props: rawProps });

          if (elRef || tag.toLowerCase() === 'dialog') {
            const stub = getOrCreateStubElement(domKey, tag, rawProps);
            if (elRef) {
              refCommits.push(() => {
                if (typeof elRef === 'function') {
                  elRef(stub);
                } else if (typeof elRef === 'object' && elRef !== null && 'current' in elRef) {
                  (elRef as { current: unknown }).current = stub;
                }
              });
            }
          }

          const attrParts: string[] = [];
          for (const [k, v] of Object.entries(rawProps)) {
            if (
              k === 'children' ||
              k === 'ref' ||
              k === 'key' ||
              k === 'dangerouslySetInnerHTML' ||
              typeof v === 'function' ||
              v === undefined ||
              v === null
            ) {
              continue;
            }
            if (k === 'style' && typeof v === 'object') {
              const styleStr = serializeStyleObject(v as Record<string, unknown>);
              if (styleStr) attrParts.push(`style="${escapeHtml(styleStr)}"`);
              continue;
            }
            const attrName =
              k === 'className'
                ? 'class'
                : k === 'htmlFor'
                  ? 'for'
                  : k === 'tabIndex'
                    ? 'tabindex'
                    : k === 'autoFocus'
                      ? 'autofocus'
                      : k === 'readOnly'
                        ? 'readonly'
                        : k;

            if (typeof v === 'boolean') {
              if (k.startsWith('aria-') || k.startsWith('data-')) {
                attrParts.push(`${attrName}="${String(v)}"`);
              } else if (v === true) {
                attrParts.push(attrName);
              }
              continue;
            }

            attrParts.push(`${attrName}="${escapeHtml(String(v))}"`);
          }

          const openTag = attrParts.length > 0 ? `<${tag} ${attrParts.join(' ')}>` : `<${tag}>`;
          if (VOID_HTML_TAGS.has(tag)) {
            return openTag;
          }
          const innerHtml =
            rawProps.dangerouslySetInnerHTML &&
            typeof (rawProps.dangerouslySetInnerHTML as { __html?: string }).__html === 'string'
              ? (rawProps.dangerouslySetInnerHTML as { __html: string }).__html
              : renderNode(rawProps.children, domKey);
          return `${openTag}${innerHtml}</${tag}>`;
        }
      }
      return '';
    };

    internals.H = clientDispatcher;
    try {
      const html = renderNode(React.createElement(Component, currentProps), 'root');
      return { html, elements, refCommits, pendingLayouts, pendingEffects, seenFibers };
    } finally {
      internals.H = prevH;
    }
  };

  const cleanupPrunedFibers = (seenFibers: Set<string>) => {
    for (const [key, fiber] of Array.from(fibers.entries())) {
      if (!seenFibers.has(key)) {
        for (const clean of fiber.layoutCleanups) {
          if (typeof clean === 'function') clean();
        }
        for (const clean of fiber.effectCleanups) {
          if (typeof clean === 'function') clean();
        }
        fibers.delete(key);
      }
    }
  };

  let frame1PaintHtml = '';

  const flushRenderAndCommit = (captureFrame1Paint: boolean) => {
    let guard = 0;
    const queuedPassiveEffects: Array<{
      fiber: FiberRecord;
      idx: number;
      fn: () => void | (() => void);
    }> = [];

    // Synchronous render + layout-effect loop prior to browser paint (Frame 1)
    do {
      dirtyFromStateUpdate = false;
      const cycle = executeSingleRenderCycle();
      latestHtml = cycle.html;
      latestElements = cycle.elements;

      cleanupPrunedFibers(cycle.seenFibers);

      for (const commitRef of cycle.refCommits) {
        commitRef();
      }
      for (const layout of cycle.pendingLayouts) {
        if (typeof layout.fiber.layoutCleanups[layout.idx] === 'function') {
          layout.fiber.layoutCleanups[layout.idx]!();
        }
        const cleanup = layout.fn();
        layout.fiber.layoutCleanups[layout.idx] =
          typeof cleanup === 'function' ? cleanup : undefined;
      }
      queuedPassiveEffects.push(...cycle.pendingEffects);
      guard += 1;
    } while (dirtyFromStateUpdate && guard < 8);

    // Exact HTML committed synchronously before first browser paint (prior to passive `useEffect`s)
    if (captureFrame1Paint) {
      frame1PaintHtml = latestHtml;
    }

    for (const eff of queuedPassiveEffects) {
      if (isUnmounted) break;
      if (typeof eff.fiber.effectCleanups[eff.idx] === 'function') {
        eff.fiber.effectCleanups[eff.idx]!();
      }
      const cleanup = eff.fn();
      eff.fiber.effectCleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    if (dirtyFromStateUpdate && !isUnmounted) {
      dirtyFromStateUpdate = false;
      const settle = executeSingleRenderCycle();
      latestHtml = settle.html;
      latestElements = settle.elements;
      for (const commitRef of settle.refCommits) commitRef();
      for (const layout of settle.pendingLayouts) {
        if (typeof layout.fiber.layoutCleanups[layout.idx] === 'function') {
          layout.fiber.layoutCleanups[layout.idx]!();
        }
        const cleanup = layout.fn();
        layout.fiber.layoutCleanups[layout.idx] =
          typeof cleanup === 'function' ? cleanup : undefined;
      }
      for (const eff of settle.pendingEffects) {
        if (typeof eff.fiber.effectCleanups[eff.idx] === 'function') {
          eff.fiber.effectCleanups[eff.idx]!();
        }
        const cleanup = eff.fn();
        eff.fiber.effectCleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
  };

  flushRenderAndCommit(true);

  return {
    getFrame1PaintHtml: () => frame1PaintHtml,
    getHtml: () => latestHtml,
    getElements: () => latestElements,
    getDialogStub: () => enclosingDialogStub,
    rerender(nextProps?: Partial<P>) {
      if (nextProps) {
        currentProps = { ...currentProps, ...nextProps };
      }
      flushRenderAndCommit(false);
    },
    flushStateUpdates() {
      flushRenderAndCommit(false);
    },
    unmount() {
      if (isUnmounted) return;
      isUnmounted = true;
      for (const fiber of fibers.values()) {
        for (const clean of fiber.layoutCleanups) {
          if (typeof clean === 'function') clean();
        }
        for (const clean of fiber.effectCleanups) {
          if (typeof clean === 'function') clean();
        }
      }
      fibers.clear();
      hostElements.clear();
      activeResizeCallbacks.clear();
      (globalThis as Record<string, unknown>).ResizeObserver = prevResizeObserver;
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).ResizeObserver = prevResizeObserver;
      }
    },
  };
}

// ============================================================================
// Synthetic Zero-PII Fixture Builders & Binary Image Buffers
// ============================================================================

const HEX_64_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX_64_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

function buildSyntheticWebpBytes(markerText: string): Buffer {
  const payload = Buffer.from(`VP8 synthetic-webp-${markerText}-padding-for-valid-size`, 'ascii');
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(payload.length + 4, 4);
  riffHeader.write('WEBP', 8, 'ascii');
  return Buffer.concat([riffHeader, payload]);
}

function buildSyntheticJpegBytes(markerText: string): Buffer {
  const soiAndApp0 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const body = Buffer.from(`synthetic-jpeg-${markerText}-body-bytes-0123456789`, 'ascii');
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soiAndApp0, body, eoi]);
}

const MOCK_OLD_GOG_WEBP_BYTES = buildSyntheticWebpBytes('old-gog-vertical-cover-a');
const MOCK_STEAM_JPEG_BYTES = buildSyntheticJpegBytes('steam-880100-portrait-2x');
const MOCK_CUSTOM_GOG_JPEG_BYTES = buildSyntheticJpegBytes('custom-gog-cover-hex-b');

function makeSyntheticStudioCatalog(count = 400): CanonicalGame[] {
  const catalog: CanonicalGame[] = [];
  for (let i = 0; i < count; i += 1) {
    const padded = String(i).padStart(4, '0');
    const storeCycle: StorefrontId[] = ['steam', 'gog', 'epic', 'xbox'];
    const platformId = storeCycle[i % 4];
    const platformGameId =
      platformId === 'steam'
        ? String(890000 + i)
        : platformId === 'gog'
          ? String(995000 + i)
          : platformId === 'xbox'
            ? `9NSYNTH${padded}Z`
            : `syn-epic-${padded}`;
    const title = `Synthetic Studio Odyssey ${padded}`;

    // Partition into Unmatched (~160), Low-Confidence (~80), Merged (~80), and Healthy (~80)
    const isUnmatched = i < 160;
    const isLowConfidence = i >= 160 && i < 240;
    const isMerged = i >= 240 && i < 320;

    const platforms: CanonicalGame['platforms'] = isMerged
      ? [
          {
            platformId: 'steam',
            platformGameId: String(890000 + i),
            originalTitle: title,
            installed: i % 2 === 0,
          },
          {
            platformId: 'gog',
            platformGameId: String(995000 + i),
            originalTitle: title,
            installed: false,
          },
        ]
      : [
          {
            platformId,
            platformGameId,
            originalTitle: title,
            installed: i % 5 === 0,
          },
        ];

    catalog.push({
      id: isMerged ? `steam-${890000 + i}` : `${platformId}-${platformGameId}`,
      title,
      sortTitle: title,
      originalStoreTitle: title,
      steamAppId:
        isMerged || platformId === 'steam' ? 890000 + i : isLowConfidence ? 870000 + i : undefined,
      capsuleImage: isUnmatched ? '' : `https://cdn.synthetic.invalid/covers/${padded}.jpg`,
      headerImage: isUnmatched ? '' : `https://cdn.synthetic.invalid/headers/${padded}.jpg`,
      shortDescription: isUnmatched
        ? ''
        : `Authentic synthetic storefront synopsis for ${title} with rich gameplay details.`,
      releaseDate: isUnmatched ? '' : '2024-06-15',
      developers: isUnmatched ? [] : ['Synthetic Studio Works'],
      publishers: ['Synthetic Publishing'],
      genres: ['Action', 'Adventure'],
      tags: ['Singleplayer'],
      platforms,
      needsMatchReview: isLowConfidence,
      matchConfidence: isLowConfidence ? 68 : 100,
    });
  }
  return catalog;
}

function seedSyntheticGogGalaxyDbAndWebCache(gogRootDir: string): {
  dbPath: string;
  webCacheCoverPath: string;
} {
  const storageDir = path.join(gogRootDir, 'storage');
  const webCacheGameDir = path.join(gogRootDir, 'WebCache', 'u1', 'gog', '991001');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(webCacheGameDir, { recursive: true });

  const webCacheFilename = `${HEX_64_A}_glx_vertical_cover.webp`;
  const webCacheCoverPath = path.join(webCacheGameDir, webCacheFilename);
  fs.writeFileSync(webCacheCoverPath, MOCK_OLD_GOG_WEBP_BYTES);

  const dbPath = path.join(storageDir, 'galaxy-2.0.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE WebCache (
        id INTEGER PRIMARY KEY,
        releaseKey TEXT NOT NULL,
        userId INTEGER NOT NULL
      );
      CREATE TABLE WebCacheResourceTypes (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL
      );
      CREATE TABLE WebCacheResources (
        webCacheId INTEGER NOT NULL,
        webCacheResourceTypeId INTEGER NOT NULL,
        filename TEXT NOT NULL
      );
      CREATE TABLE GamePieceTypes (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL
      );
      CREATE TABLE GamePieces (
        releaseKey TEXT NOT NULL,
        gamePieceTypeId INTEGER NOT NULL,
        value TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO WebCache (id, releaseKey, userId) VALUES (?, ?, ?)').run(
      1,
      'gog_991001',
      101
    );
    // Use userId 'u1' via TEXT-compatible row so WebCache/u1/gog/991001 matches exact fixture path
    db.exec('DROP TABLE WebCache;');
    db.exec(`
      CREATE TABLE WebCache (
        id INTEGER PRIMARY KEY,
        releaseKey TEXT NOT NULL,
        userId TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO WebCache (id, releaseKey, userId) VALUES (?, ?, ?)').run(
      1,
      'gog_991001',
      'u1'
    );
    db.prepare('INSERT INTO WebCacheResourceTypes (id, type) VALUES (?, ?)').run(
      1,
      'verticalCover'
    );
    db.prepare(
      'INSERT INTO WebCacheResources (webCacheId, webCacheResourceTypeId, filename) VALUES (?, ?, ?)'
    ).run(1, 1, webCacheFilename);

    db.prepare('INSERT INTO GamePieceTypes (id, type) VALUES (?, ?)').run(1, 'title');
    db.prepare('INSERT INTO GamePieceTypes (id, type) VALUES (?, ?)').run(2, 'summary');
    db.prepare('INSERT INTO GamePieceTypes (id, type) VALUES (?, ?)').run(3, 'originalImages');
    db.prepare('INSERT INTO GamePieceTypes (id, type) VALUES (?, ?)').run(4, 'meta');

    db.prepare(
      'INSERT INTO GamePieces (releaseKey, gamePieceTypeId, value) VALUES (?, ?, ?)'
    ).run('gog_991001', 1, JSON.stringify({ title: 'Synthetic Classic Shooter Enhanced' }));
    db.prepare(
      'INSERT INTO GamePieces (releaseKey, gamePieceTypeId, value) VALUES (?, ?, ?)'
    ).run(
      'gog_991001',
      2,
      JSON.stringify({
        summary:
          'Authentic GOG Galaxy local synopsis for Synthetic Classic Shooter Enhanced.',
      })
    );
    db.prepare(
      'INSERT INTO GamePieces (releaseKey, gamePieceTypeId, value) VALUES (?, ?, ?)'
    ).run(
      'gog_991001',
      3,
      JSON.stringify({
        verticalCover: `https://images.gog-statics.com/${HEX_64_A}.webp`,
        background: `https://images.gog-statics.com/${HEX_64_A}_bg.webp`,
      })
    );
    db.prepare(
      'INSERT INTO GamePieces (releaseKey, gamePieceTypeId, value) VALUES (?, ?, ?)'
    ).run(
      'gog_991001',
      4,
      JSON.stringify({
        developers: ['Synthetic Retro Labs'],
        publishers: ['Synthetic Classics Publishing'],
        genres: ['Shooter'],
        releaseDate: 800064000,
      })
    );
  } finally {
    db.close();
  }

  return { dbPath, webCacheCoverPath };
}

function createMockIpcAndVaultBridge(deps: {
  offlineVaultService: InstanceType<typeof OfflineVaultService>;
  federator: InstanceType<typeof StorefrontLocalCacheFederator>;
  userDataDir: string;
}) {
  const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle(channel: string, fn: (...args: unknown[]) => Promise<unknown>) {
      ipcHandlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      ipcHandlers.delete(channel);
    },
  };

  const registration = registerOfflineVaultIpcHandlers({
    ipcMain,
    offlineVaultService: deps.offlineVaultService,
    federator: deps.federator,
    userDataDir: deps.userDataDir,
    getMainWindow: () => null,
  });

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const fn = ipcHandlers.get(channel);
    if (!fn) {
      throw new Error(`Missing IPC handler for ${channel}`);
    }
    return await fn({}, ...args);
  };

  const offlineVaultBridge = {
    getStats: () => invoke('offlineVault:get-stats'),
    setTier: (tier: string) => invoke('offlineVault:set-tier', tier),
    clear: (opts?: unknown) => invoke('offlineVault:clear', opts),
    getCatalogSnapshot: () => invoke('offlineVault:get-catalog-snapshot'),
    upsertGames: (games: unknown[]) => invoke('offlineVault:upsert-games', games),
    deleteGames: (gameIds: string[]) => invoke('offlineVault:delete-games', gameIds),
    setModalBusy: (isBusy: boolean) => invoke('offlineVault:set-modal-busy', isBusy),
    getGameDetail: (gameId: string) => invoke('offlineVault:get-game-detail', gameId),
    saveGameDetail: (payload: unknown) => invoke('offlineVault:save-game-detail', payload),
    resolveLocalMetadata: (payload: unknown) =>
      invoke('offlineVault:resolve-local-metadata', payload),
    queueHydration: (payload: unknown) => invoke('offlineVault:queue-hydration', payload),
    checkUrlStatus: (url: string) => invoke('offlineVault:check-url-status', url),
    getUserOverrides: () => invoke('offlineVault:get-user-overrides'),
    saveUserOverride: (arg1: unknown, arg2?: unknown) =>
      invoke('offlineVault:save-user-override', arg1, arg2),
    removeUserOverride: (arg: unknown) => invoke('offlineVault:remove-user-override', arg),
  };

  return {
    offlineVaultBridge,
    invoke,
    dispose: registration.dispose,
  };
}

// ============================================================================
// Global Hermetic Setup & Teardown
// ============================================================================

let localStorageInstance: HermeticStorage;
let sessionStorageInstance: HermeticStorage;
const tempDirsToCleanup: string[] = [];

function makeTempTestDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-wave3a-${prefix}-`));
  tempDirsToCleanup.push(dir);
  return dir;
}

beforeEach(() => {
  activeIdbDatabases.clear();
  failedCoverUrls.clear();
  clearFederatorCaches();

  localStorageInstance = new HermeticStorage();
  sessionStorageInstance = new HermeticStorage();

  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const rootAttrs = new Map<string, string>();
  const docElAttrs = new Map<string, string>();

  class StubHTMLElement {}
  class StubHTMLDialogElement extends StubHTMLElement {}

  const bodyEl = Object.assign(new StubHTMLElement(), {
    nodeType: 1,
    tagName: 'BODY',
    appendChild: () => {},
    removeChild: () => {},
  });

  const rootEl = {
    id: 'root',
    setAttribute: (k: string, v: string) => {
      rootAttrs.set(k, v);
    },
    removeAttribute: (k: string) => {
      rootAttrs.delete(k);
    },
    hasAttribute: (k: string) => rootAttrs.has(k),
    getAttribute: (k: string) => rootAttrs.get(k) ?? null,
  };

  const docObj = {
    body: bodyEl,
    documentElement: {
      setAttribute: (k: string, v: string) => {
        docElAttrs.set(k, v);
      },
      removeAttribute: (k: string) => {
        docElAttrs.delete(k);
      },
      hasAttribute: (k: string) => docElAttrs.has(k),
      getAttribute: (k: string) => docElAttrs.get(k) ?? null,
    },
    getElementById: (id: string) => (id === 'root' ? rootEl : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const idbFactory = createHermeticIndexedDbFactory();

  const winObj = {
    localStorage: localStorageInstance,
    sessionStorage: sessionStorageInstance,
    indexedDB: idbFactory,
    Storage: HermeticStorage,
    StorageEvent: HermeticStorageEvent,
    HTMLElement: StubHTMLElement,
    HTMLDialogElement: StubHTMLDialogElement,
    innerWidth: 1440,
    innerHeight: 900,
    location: {
      hostname: 'localhost',
      origin: 'http://localhost',
      protocol: 'http:',
      href: 'http://localhost/',
    },
    navigator: { onLine: true },
    document: docObj,
    electronAPI: undefined as unknown,
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
    addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(cb);
    },
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent(ev: Event) {
      const set = listeners.get(ev.type);
      if (set) {
        for (const cb of Array.from(set)) {
          if (typeof cb === 'function') {
            cb(ev);
          } else if (cb && typeof cb.handleEvent === 'function') {
            cb.handleEvent(ev);
          }
        }
      }
      return true;
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };

  Object.assign(globalThis, {
    window: winObj,
    document: docObj,
    localStorage: localStorageInstance,
    sessionStorage: sessionStorageInstance,
    indexedDB: idbFactory,
    Storage: HermeticStorage,
    StorageEvent: HermeticStorageEvent,
    HTMLElement: StubHTMLElement,
    HTMLDialogElement: StubHTMLDialogElement,
  });

  // Enforce strict offline `net.Socket` hermetic guard — zero outbound network sockets permitted
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
    throw new Error('Offline net.Socket guard blocked outbound network connection in hermetic test');
  });

  // Hermetic default `fetch` stub so background metadata scrapers never touch real sockets
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );

  window.dispatchEvent(new Event('online'));
  resetStudioSessionCachesForTests();
  clearSuppressedCatalogEntries();
  clearIntegrationStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  clearFederatorCaches();
  failedCoverUrls.clear();
  while (tempDirsToCleanup.length > 0) {
    const dir = tempDirsToCleanup.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup race on temp directories
      }
    }
  }
});

// ============================================================================
// SUITE 1 — Issue 1: `O(1)` Storage Cache Coherence, `<dialog>` Top-Layer
// Geometry & Studio Exit -> Re-Enter / Suspend Lifecycle
// ============================================================================

describe('Suite 1 — Issue 1: O(1) Storage Cache Coherence, <dialog> Top-Layer Geometry & Studio Lifecycle', () => {
  it('eliminates V8 cross-representation string-poisoning via pointer adoption in test mode and executes 0 localStorage.getItem calls across 3,000 reads in production mode while honoring StorageEvent invalidation', async () => {
    // 1. Seed a > 100 KB UTF-16 multi-byte override map via `saveUserOverride` + `hydrateUserOverridesFromVault`
    const vaultSeedOverrides: Record<string, UserGameOverride> = {};
    const unicodeSynopsisChunk =
      'Synthetic UTF-16 Chronicles — 宇宙戦艦シンセティック ★ Édition Complète Ω '.repeat(24);

    for (let i = 0; i < 95; i += 1) {
      const gid = `gog-${992000 + i}`;
      vaultSeedOverrides[gid] = {
        gameId: gid,
        platformId: 'gog',
        platformGameId: String(992000 + i),
        title: `Synthetic Override Saga ${i} — 特別版`,
        matchedStore: 'steam',
        matchedId: 882000 + i,
        steamAppId: 882000 + i,
        capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${882000 + i}/library_600x900_2x.jpg`,
        shortDescription: unicodeSynopsisChunk,
        updatedAt: '2026-10-29T20:00:00.000Z',
      };
    }

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      isElectron: true,
      offlineVault: {
        getUserOverrides: vi.fn(async () => vaultSeedOverrides),
        saveUserOverride: vi.fn(async () => ({ success: true })),
        removeUserOverride: vi.fn(async () => ({ success: true })),
      },
    };

    saveUserOverride({
      gameId: 'gog-991001',
      platformId: 'gog',
      platformGameId: '991001',
      title: 'Synthetic Classic Shooter Enhanced — 改訂版',
      matchedStore: 'steam',
      matchedId: 880100,
      steamAppId: 880100,
      capsuleImage:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/library_600x900_2x.jpg',
      shortDescription: unicodeSynopsisChunk,
      updatedAt: '2026-10-29T21:00:00.000Z',
    });

    await hydrateUserOverridesFromVault();

    const rawOverridesPayload = localStorage.getItem(STORAGE_KEY_USER_OVERRIDES) || '';
    expect(Buffer.byteLength(rawOverridesPayload, 'utf16le')).toBeGreaterThan(100 * 1024);

    // Seed empty-synopsis probes, hidden storefront entries, and launch configs
    recordDurableEmptySynopsisProbe('gog-999404');
    hideStorefrontEntry(
      {
        id: 'epic-syn-hidden-01',
        title: 'Synthetic Hidden Alpha Build',
        sortTitle: 'Synthetic Hidden Alpha Build',
        headerImage: '',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'syn-hidden-01',
            originalTitle: 'Synthetic Hidden Alpha Build',
            installed: false,
          },
        ],
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      },
      'epic',
      'Hidden synthetic beta'
    );
    persistLocalLaunchConfigsToStorage({
      'gog-991001': {
        gameId: 'gog-991001',
        launchMethod: 'storefront_uri',
        preferredPlatformId: 'gog',
      },
    });

    const targetGame: CanonicalGame = {
      id: 'gog-991001',
      title: 'Synthetic Classic Shooter Enhanced',
      sortTitle: 'Synthetic Classic Shooter Enhanced',
      headerImage: '',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '991001',
          originalTitle: 'Synthetic Classic Shooter Enhanced',
          installed: false,
        },
      ],
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    // 2. Test-mode V8 cross-representation pointer adoption check:
    // Simulate Blink returning a distinct UTF-16 external string wrapper per storage slot
    const originalGetItem = HermeticStorage.prototype.getItem;
    const blinkExternalStringCache = new Map<string, string>();
    const getItemSpy = vi
      .spyOn(HermeticStorage.prototype, 'getItem')
      .mockImplementation(function (this: HermeticStorage, key: string): string | null {
        const val = originalGetItem.call(this, key);
        if (val === null) return null;
        let materialized = blinkExternalStringCache.get(key);
        if (materialized === undefined) {
          // Force a distinct heap string allocation from the `JSON.stringify` SeqTwoByteString
          materialized = `${val.slice(0, 1)}${val.slice(1)}`;
          blinkExternalStringCache.set(key, materialized);
        }
        return materialized;
      });

    const jsonParseSpy = vi.spyOn(JSON, 'parse');

    // First read in test mode compares `raw === cachedOverridesRaw` and adopts Blink pointer without `JSON.parse`
    jsonParseSpy.mockClear();
    const firstTestModeOv = getUserOverrideForGame(targetGame);
    expect(firstTestModeOv?.steamAppId).toBe(880100);
    for (let i = 0; i < 50; i += 1) {
      expect(getUserOverrideForGame(targetGame)?.title).toBe(
        'Synthetic Classic Shooter Enhanced — 改訂版'
      );
    }
    expect(jsonParseSpy).toHaveBeenCalledTimes(0);

    // 3. Production mode (`VITEST = ''`, `NODE_ENV = 'production'`) zero-`getItem` verification across 3,000 loops!
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      vi.resetModules();
      const prodOverrideMod = await import('../src/services/storage/userOverrideStorage');
      const prodDiagMod = await import(
        '../src/components/Library/MatchManager/matchManagerDiagnostics'
      );
      const prodLaunchMod = await import('../src/services/launcher/launchConfigStore');

      // Initial cold hydration pass in production mode (reads each storage key once)
      expect(prodOverrideMod.getUserOverrideForGame(targetGame)?.steamAppId).toBe(880100);
      expect(prodDiagMod.loadDurableEmptySynopsisProbeMap().has('gog-999404')).toBe(true);
      expect(
        Object.keys(prodOverrideMod.loadHiddenStorefrontEntries()).some((k) =>
          k.includes('syn-hidden-01')
        )
      ).toBe(true);
      expect(prodLaunchMod.getLaunchConfigFromStorage('gog-991001')?.launchMethod).toBe(
        'storefront_uri'
      );

      getItemSpy.mockClear();
      jsonParseSpy.mockClear();

      for (let i = 0; i < 3_000; i += 1) {
        const ov = prodOverrideMod.getUserOverrideForGame(targetGame);
        const probes = prodDiagMod.loadDurableEmptySynopsisProbeMap();
        const hidden = prodOverrideMod.loadHiddenStorefrontEntries();
        const cfg = prodLaunchMod.getLaunchConfigFromStorage('gog-991001');
        if (!ov || !probes.has('gog-999404') || !hidden['epic:syn-hidden-01'] || !cfg) {
          throw new Error(`Unexpected cache miss on iteration ${i}`);
        }
      }

      // Strictly ZERO `localStorage.getItem` and ZERO `JSON.parse` across 12,000 production calls!
      expect(getItemSpy).toHaveBeenCalledTimes(0);
      expect(jsonParseSpy).toHaveBeenCalledTimes(0);

      // 4. Dispatch cross-window `StorageEvent('storage', ...)` and verify clean invalidation + re-hydration
      const updatedMap: Record<string, UserGameOverride> = {
        ...JSON.parse(rawOverridesPayload),
        'gog-991001': {
          ...vaultSeedOverrides['gog-992000'],
          gameId: 'gog-991001',
          platformId: 'gog',
          platformGameId: '991001',
          title: 'Synthetic Classic Shooter Enhanced — StorageEvent Updated',
          steamAppId: 880100,
          updatedAt: '2026-10-29T22:30:00.000Z',
        },
      };
      const updatedRaw = JSON.stringify(updatedMap);
      localStorage.setItem(STORAGE_KEY_USER_OVERRIDES, updatedRaw);
      blinkExternalStringCache.set(STORAGE_KEY_USER_OVERRIDES, updatedRaw);

      window.dispatchEvent(
        new HermeticStorageEvent('storage', {
          key: STORAGE_KEY_USER_OVERRIDES,
          newValue: updatedRaw,
          storageArea: localStorage,
        })
      );

      getItemSpy.mockClear();
      expect(prodOverrideMod.getUserOverrideForGame(targetGame)?.title).toBe(
        'Synthetic Classic Shooter Enhanced — StorageEvent Updated'
      );
      expect(getItemSpy).toHaveBeenCalledTimes(1);

      // Subsequent reads return to 0 `getItem` calls!
      getItemSpy.mockClear();
      for (let i = 0; i < 200; i += 1) {
        expect(prodOverrideMod.getUserOverrideForGame(targetGame)?.title).toBe(
          'Synthetic Classic Shooter Enhanced — StorageEvent Updated'
        );
      }
      expect(getItemSpy).toHaveBeenCalledTimes(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('opens <dialog> synchronously before layout measurement for >0 Frame-1 virtual rows across 10x Studio Exit -> Re-Enter cycles and preserves geometry + badge counts across FixMatchWizardModal suspend/resume', () => {
    const catalog = makeSyntheticStudioCatalog(400);

    // Seed 1 manual override, 1 user-hidden entry, and 2 auto-filtered entries so ALL Studio tabs have non-zero badges
    saveUserOverride({
      gameId: catalog[350].id,
      platformId: catalog[350].platforms[0].platformId,
      platformGameId: String(catalog[350].platforms[0].platformGameId),
      title: 'Synthetic Manually Matched Studio Title',
      matchedStore: 'steam',
      matchedId: 880555,
      steamAppId: 880555,
      updatedAt: '2026-10-29T21:00:00.000Z',
    });

    hideStorefrontEntry({
      id: 'gog-998002',
      title: 'Synthetic Hidden User Title',
      sortTitle: 'Synthetic Hidden User Title',
      headerImage: '',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '998002',
          originalTitle: 'Synthetic Hidden User Title',
          installed: false,
        },
      ],
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    });

    registerSuppressedCatalogEntries([
      {
        id: 'steam:998001',
        platformId: 'steam',
        platformGameId: '998001',
        rawTitle: 'Synthetic Dedicated Server Tool',
        reason: 'Filtered dedicated server utility',
        reasonCategory: 'non_game_filter',
        rawGame: {
          id: 'steam-998001',
          title: 'Synthetic Dedicated Server Tool',
          sortTitle: 'Synthetic Dedicated Server Tool',
          headerImage: '',
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '998001',
              originalTitle: 'Synthetic Dedicated Server Tool',
              installed: false,
            },
          ],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
      },
    ]);

    const baseProps: React.ComponentProps<typeof LibraryMatchManagerModal> = {
      isOpen: true,
      isSuspended: false,
      games: catalog,
      onClose: vi.fn(),
      onFixMatchForGame: vi.fn(),
      onResetOverride: vi.fn(),
      onHideGame: vi.fn(),
      onUnhideEntry: vi.fn(),
    };

    // Part A: Initial open + Stacked `FixMatchWizardModal` suspend (`isSuspended={true}` -> `false`)
    const studioRoot = createClientComponentRoot(LibraryMatchManagerModal, baseProps, {
      clientWidth: 960,
      clientHeight: 600,
      gateScrollElementByDialogOpen: true,
    });

    try {
      // `<dialog>` must be opened synchronously via `showModal()` before Frame 1 paint!
      expect(studioRoot.getDialogStub()?.open).toBe(true);
      const frame1Doc = parseHtmlDocument(studioRoot.getFrame1PaintHtml());
      const frame1Container = frame1Doc.querySelector('[data-testid="virtualized-list-container"]');
      expect(frame1Container).not.toBeNull();
      const frame1Rows = frame1Container!.querySelectorAll('[data-index]');
      expect(frame1Rows.length).toBeGreaterThan(0);

      // Suspend Studio (simulating `FixMatchWizardModal` opening on top of Studio)
      studioRoot.rerender({ isSuspended: true });
      const suspendedDoc = parseHtmlDocument(studioRoot.getHtml());
      const scrollBodySuspended = suspendedDoc.querySelector('.ol-studio-scroll-body');
      expect(scrollBodySuspended).not.toBeNull();
      expect(scrollBodySuspended!.getAttribute('hidden')).toBeNull();
      expect(scrollBodySuspended!.getAttribute('style') || '').not.toContain('display:none');
      expect(scrollBodySuspended!.getAttribute('inert')).not.toBeNull();

      // Resume Studio (`isSuspended={false}` when `FixMatchWizardModal` closes)
      studioRoot.rerender({ isSuspended: false });
      const resumedDoc = parseHtmlDocument(studioRoot.getHtml());
      const scrollBodyResumed = resumedDoc.querySelector('.ol-studio-scroll-body');
      expect(scrollBodyResumed).not.toBeNull();
      expect(scrollBodyResumed!.getAttribute('inert')).toBeNull();
      expect(scrollBodyResumed!.getAttribute('hidden')).toBeNull();
      const resumedRows =
        resumedDoc
          .querySelector('[data-testid="virtualized-list-container"]')
          ?.querySelectorAll('[data-index]') ?? [];
      expect(resumedRows.length).toBeGreaterThan(0);
    } finally {
      studioRoot.unmount();
    }

    // Part B: Mounting directly with `isSuspended={true}` STILL computes non-zero tab badge counts!
    const mountedSuspendedRoot = createClientComponentRoot(
      LibraryMatchManagerModal,
      { ...baseProps, isSuspended: true },
      {
        clientWidth: 960,
        clientHeight: 600,
        gateScrollElementByDialogOpen: true,
      }
    );
    try {
      const doc = parseHtmlDocument(mountedSuspendedRoot.getHtml());
      const tabs = doc.querySelectorAll('[role="tab"]');
      expect(tabs).toHaveLength(5);
      for (const tab of tabs) {
        const text = tab.textContent || '';
        // Every seeded tab (`Needs Attention`, `User-Suppressed`, `Auto-Filtered Non-Games`, `Manual Overrides`, `Merged Multi-Store`) has count > 0
        const countMatch = text.match(/\((\d+)\)\s*$/);
        expect(countMatch).not.toBeNull();
        expect(Number(countMatch![1])).toBeGreaterThan(0);
      }
    } finally {
      mountedSuspendedRoot.unmount();
    }

    // Part C: 10 consecutive Studio Exit -> Re-enter cycles (`unmount` -> `mount`) render >0 virtual rows on Frame 1 every single time!
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      const cycleRoot = createClientComponentRoot(LibraryMatchManagerModal, baseProps, {
        clientWidth: 960,
        clientHeight: 600,
        gateScrollElementByDialogOpen: true,
      });
      try {
        expect(cycleRoot.getDialogStub()?.open).toBe(true);
        const f1 = parseHtmlDocument(cycleRoot.getFrame1PaintHtml());
        const virtualRows =
          f1
            .querySelector('[data-testid="virtualized-list-container"]')
            ?.querySelectorAll('[data-index]') ?? [];
        expect(virtualRows.length).toBeGreaterThan(0);
        expect(virtualRows.length).toBeLessThan(40); // Virtualized window, never a 400-row mount bomb
      } finally {
        cycleRoot.unmount();
      }
    }
  });

  it('evicts aborted P2 tasks from requestScheduler with 0 upstream calls and cancels integrationStorage 250ms modal-close flush on rapid modal re-open', async () => {
    // Part A: `requestScheduler` `AbortSignal` queue eviction
    const scheduler = new RequestScheduler();

    let releaseBlocker!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      void scheduler.schedule(
        'https://synthetic-cdn.invalid/blocker',
        () =>
          new Promise<string>((res) => {
            releaseBlocker = () => res('done');
            resolve();
          }),
        RequestPriority.P0_INTERACTIVE
      );
    });
    await blockerStarted;

    const abortController = new AbortController();
    const p2UpstreamSpy = vi.fn(async () => 'should-never-run');

    const p2Task1 = scheduler.schedule(
      'https://synthetic-cdn.invalid/probe-1',
      p2UpstreamSpy,
      RequestPriority.P2_BACKGROUND,
      { signal: abortController.signal }
    );
    const p2Task2 = scheduler.schedule(
      'https://synthetic-cdn.invalid/probe-2',
      p2UpstreamSpy,
      RequestPriority.P2_BACKGROUND,
      { signal: abortController.signal }
    );

    expect(scheduler.getQueueLength('synthetic-cdn.invalid')).toBe(2);

    abortController.abort();

    await expect(p2Task1).rejects.toMatchObject({ name: 'AbortError' });
    await expect(p2Task2).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.getQueueLength('synthetic-cdn.invalid')).toBe(0);

    releaseBlocker();
    await new Promise((r) => setTimeout(r, 10));
    expect(p2UpstreamSpy).toHaveBeenCalledTimes(0);

    // Part B: `integrationStorage` 250ms post-modal-close flush cancellation when modal re-opens within 50ms
    vi.useFakeTimers();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      vi.resetModules();
      const prodModalLock = await import('../src/utils/modalOverlayLock');
      const prodIntegrationStorage = await import('../src/services/integrations/integrationStorage');

      const setItemSpy = vi.spyOn(HermeticStorage.prototype, 'setItem');
      const sampleCatalog = makeSyntheticStudioCatalog(12);

      // 1. Open Studio modal -> acquires modal overlay lock (`isModalOverlayOpen() === true`)
      const releaseFirstModal = prodModalLock.acquireModalOverlayLock();
      expect(prodModalLock.isModalOverlayOpen()).toBe(true);

      // 2. Queue background catalog save while modal is open -> deferred (0 synchronous setItem writes)
      setItemSpy.mockClear();
      prodIntegrationStorage.saveCurrentCatalog(sampleCatalog);
      const writesWhileOpen = setItemSpy.mock.calls.filter(
        ([k]) => k === MAIN_CATALOG_STORAGE_KEY
      );
      expect(writesWhileOpen).toHaveLength(0);

      // 3. Close Studio modal -> fires `'antigravity:modal-overlay-changed'` `{ isOpen: false }`, arming 250ms timer
      releaseFirstModal();
      expect(prodModalLock.isModalOverlayOpen()).toBe(false);

      // 4. Advance 50ms (< 250ms), then re-open Studio modal -> fires `{ isOpen: true }` and MUST cancel the 250ms timer!
      vi.advanceTimersByTime(50);
      const releaseReopenedModal = prodModalLock.acquireModalOverlayLock();
      expect(prodModalLock.isModalOverlayOpen()).toBe(true);

      vi.advanceTimersByTime(600);
      const writesDuringReopen = setItemSpy.mock.calls.filter(
        ([k]) => k === MAIN_CATALOG_STORAGE_KEY
      );
      expect(writesDuringReopen).toHaveLength(0);

      // 5. Finally close modal and let >= 250ms elapse -> deferred catalog flush persists cleanly!
      releaseReopenedModal();
      vi.advanceTimersByTime(300);
      const writesAfterFinalClose = setItemSpy.mock.calls.filter(
        ([k]) => k === MAIN_CATALOG_STORAGE_KEY
      );
      expect(writesAfterFinalClose.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });
});

// ============================================================================
// SUITE 2 — Issue 2: Multi-Key Custom Match `"Reset"` in Both Studio &
// Fix Match Wizard (Legacy 3-Key Orphaned State + `nativeBaseline`)
// ============================================================================

describe('Suite 2 — Issue 2: Multi-Key Custom Match Reset in Studio & Fix Match Wizard', () => {
  async function runLegacyThreeKeyResetScenario(triggerSurface: 'studio' | 'wizard') {
    const tempRoot = makeTempTestDir(`reset-${triggerSurface}`);
    const userDataDir = path.join(tempRoot, 'userData');
    const homeDir = path.join(tempRoot, 'home');
    const gogRootDir = path.join(tempRoot, 'gog-galaxy');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    seedSyntheticGogGalaxyDbAndWebCache(gogRootDir);

    const federator = new StorefrontLocalCacheFederator({
      homedir: homeDir,
      userDataDir,
      gogGalaxyRoots: [gogRootDir],
      steamRoots: [],
      heroicRoots: [],
      legendaryDirs: [],
      xboxGamesRoots: [],
      amazonDbPaths: [],
    });

    const vaultService = new OfflineVaultService({
      userDataDir,
      federator,
      fetchImpl: vi.fn(async () => new Response(null, { status: 404 })),
    });

    const bridge = createMockIpcAndVaultBridge({
      offlineVaultService: vaultService,
      federator,
      userDataDir,
    });

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      isElectron: true,
      offlineVault: bridge.offlineVaultBridge,
    };

    try {
      // Mutated in-place GOG catalog entry (`0` `nativeBaseline`, `0` `routedMetadataSnapshot`)
      const mutatedGogCatalogEntry: CanonicalGame = {
        id: 'steam-880100',
        steamAppId: 880100,
        title: 'Wrong Routed Title',
        sortTitle: 'Wrong Routed Title',
        originalStoreTitle: 'Wrong Routed Title',
        capsuleImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/library_600x900_2x.jpg',
        headerImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/header.jpg',
        shortDescription: 'Custom Overridden Synopsis',
        detailedDescription: 'Custom Overridden Detailed Synopsis',
        reviewScoreOverride: {
          score: 99,
          tier: 'Mighty',
          source: 'steam',
          url: '',
          isVerified: true,
        },
        developers: ['Wrong Routed Dev'],
        publishers: ['Wrong Routed Pub'],
        genres: ['RPG'],
        tags: [],
        releaseDate: '2020-01-01',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '991001',
            originalTitle: 'Synthetic Classic Shooter Enhanced',
            installed: false,
          },
        ],
      };

      // Seed both orphan `'steam-880100'` and stale `'gog-991001'` (`steam_app_id = 880100`) in SQLite `vault_games`
      vaultService.upsertGames([
        mutatedGogCatalogEntry,
        {
          ...mutatedGogCatalogEntry,
          id: 'gog-991001',
          steamAppId: 880100,
        },
      ]);

      // Seed 3 conflicting legacy override keys in BOTH `localStorage` and `user_overrides.json`
      const legacyThreeKeyOverrides: Record<string, UserGameOverride> = {
        'gog-991001': {
          gameId: 'gog-991001',
          platformId: 'gog',
          platformGameId: '991001',
          title: 'Wrong Routed Title (Oldest Pre-Rekey)',
          matchedStore: 'steam',
          matchedId: 880100,
          steamAppId: 880100,
          capsuleImage: mutatedGogCatalogEntry.capsuleImage,
          shortDescription: 'Custom Overridden Synopsis',
          updatedAt: '2026-10-29T19:00:00.000Z',
        },
        'steam-880100': {
          gameId: 'steam-880100',
          platformId: 'gog',
          platformGameId: '991001',
          title: 'Wrong Routed Title (Mid Rekey)',
          matchedStore: 'steam',
          matchedId: 880100,
          steamAppId: 880100,
          capsuleImage: mutatedGogCatalogEntry.capsuleImage,
          shortDescription: 'Custom Overridden Synopsis',
          updatedAt: '2026-10-29T20:00:00.000Z',
        },
        'gog:991001': {
          gameId: 'steam-880100',
          platformId: 'gog',
          platformGameId: '991001',
          title: 'Wrong Routed Title',
          matchedStore: 'steam',
          matchedId: 880100,
          steamAppId: 880100,
          capsuleImage: mutatedGogCatalogEntry.capsuleImage,
          shortDescription: 'Custom Overridden Synopsis',
          updatedAt: '2026-10-29T21:00:00.000Z',
        },
      };

      localStorage.setItem(STORAGE_KEY_USER_OVERRIDES, JSON.stringify(legacyThreeKeyOverrides));
      window.dispatchEvent(
        new HermeticStorageEvent('storage', { key: STORAGE_KEY_USER_OVERRIDES })
      );

      const overridesJsonPath = path.join(userDataDir, 'user_overrides.json');
      await writeUserOverridesToDiskAsync(overridesJsonPath, legacyThreeKeyOverrides);
      expect(Object.keys(await readUserOverridesAsync(overridesJsonPath))).toHaveLength(3);

      // Harness component wiring `useCatalogOverrideSync` + Studio + Wizard
      let liveGamesState: CanonicalGame[] = [mutatedGogCatalogEntry];
      let latestSyncHook!: ReturnType<typeof useCatalogOverrideSync>;

      const HarnessComponent: React.FC = () => {
        const [games, setGames] = React.useState<CanonicalGame[]>([mutatedGogCatalogEntry]);
        const gamesRef = React.useRef<CanonicalGame[]>(games);
        gamesRef.current = games;
        liveGamesState = games;
        const [, setRefreshKey] = React.useState(0);

        const sync = useCatalogOverrideSync({
          selectedGame: games[0] ?? null,
          isGridView: true,
          navigateHome: () => {},
          setGames,
          gamesRef,
          setGameRefreshKey: setRefreshKey,
          showSyncNotice: () => {},
        });
        latestSyncHook = sync;

        return triggerSurface === 'studio' ? (
          <LibraryMatchManagerModal
            isOpen={true}
            games={games}
            initialTab="overrides"
            onClose={() => {}}
            onFixMatchForGame={() => {}}
            onResetOverride={sync.handleResetOverride}
          />
        ) : (
          <FixMatchWizardModal
            isOpen={true}
            game={games[0] ?? null}
            existingOverride={getUserOverrideForGame(games[0])}
            onClose={() => {}}
            onApplyOverride={sync.handleApplyOverride}
            onResetOverride={sync.handleResetOverride}
          />
        );
      };

      const root = createClientComponentRoot(HarnessComponent, {});
      try {
        if (triggerSurface === 'studio') {
          // Verify `LibraryMatchManagerModal` deduplicates all 3 conflicting keys into 1 OverrideRow showing newest `updatedAt`!
          const studioDoc = parseHtmlDocument(root.getHtml());
          const studioHtml = root.getHtml();
          expect(studioHtml).toContain('Wrong Routed Title');
          expect(studioHtml).not.toContain('Wrong Routed Title (Oldest Pre-Rekey)');
          expect(studioHtml).not.toContain('Wrong Routed Title (Mid Rekey)');

          const resetButtons = root
            .getElements()
            .filter(
              (el) =>
                el.tag === 'button' &&
                String(el.props.title || '').includes('Remove manual override')
            );
          expect(resetButtons).toHaveLength(1);
          expect(studioDoc.querySelectorAll('.ol-studio-row-card').length).toBe(1);

          // Trigger `"Reset"` directly from Studio's `OverrideRow` button!
          (resetButtons[0].props.onClick as () => void)();
        } else {
          // Trigger `"Reset to Default"` directly from `FixMatchWizardModal` footer button!
          const wizardResetBtns = root
            .getElements()
            .filter(
              (el) =>
                el.tag === 'button' &&
                String(el.props.title || '').includes('Discard user match overrides')
            );
          expect(wizardResetBtns).toHaveLength(1);
          (wizardResetBtns[0].props.onClick as () => void)();
        }

        // Let async IPC `removeUserOverride`, `deleteGames`, and `resolveLocalMetadata` settle
        await new Promise((r) => setTimeout(r, 40));
        root.flushStateUpdates();

        // 1. 0 override keys remain in `localStorage` AND 0 override keys remain in `user_overrides.json`!
        expect(Object.keys(loadUserOverrides())).toHaveLength(0);
        const diskAfterReset = await readUserOverridesAsync(overridesJsonPath);
        expect(Object.keys(diskAfterReset)).toHaveLength(0);

        // 2. `CanonicalGame` reverted cleanly in memory AND persisted catalog, and `resolveLocalMetadata` re-hydrated clean GOG metadata!
        expect(liveGamesState).toHaveLength(1);
        const reverted = liveGamesState[0];
        expect(reverted.id).toBe('gog-991001');
        expect(reverted.title).toBe('Synthetic Classic Shooter Enhanced');
        expect(reverted.steamAppId).toBeUndefined();
        expect(reverted.reviewScoreOverride).toBeUndefined();
        expect(reverted.capsuleImage).toBe(`https://images.gog-statics.com/${HEX_64_A}.webp`);
        expect(reverted.shortDescription).toBe(
          'Authentic GOG Galaxy local synopsis for Synthetic Classic Shooter Enhanced.'
        );
        expect(reverted.shortDescription).not.toContain('Custom Overridden Synopsis');

        // Persist final hydrated catalog to SQLite `vault_games` (mirrors renderer catalog sync) and verify SQLite state
        await bridge.offlineVaultBridge.upsertGames(liveGamesState);

        const persistedCatalog = loadSavedCatalog();
        const persistedEntry = persistedCatalog.find((g) => g.id === 'gog-991001');
        expect(persistedEntry).toBeDefined();
        expect(persistedEntry?.title).toBe('Synthetic Classic Shooter Enhanced');
        expect(persistedEntry?.steamAppId).toBeUndefined();
        expect(persistedEntry?.reviewScoreOverride).toBeUndefined();

        // 3. SQLite `vault_games` deleted orphan `'steam-880100'` and cleared `gog-991001.steam_app_id` to `null`!
        const db = vaultService.ensureOpen();
        const orphanRow = db
          .prepare('SELECT game_id FROM vault_games WHERE game_id = ?')
          .get('steam-880100');
        expect(orphanRow).toBeUndefined();

        const gogRow = db
          .prepare(
            'SELECT game_id, canonical_title, steam_app_id FROM vault_games WHERE game_id = ?'
          )
          .get('gog-991001');
        expect(gogRow).toBeDefined();
        expect(gogRow?.canonical_title).toBe('Synthetic Classic Shooter Enhanced');
        expect(gogRow?.steam_app_id).toBeNull();
        expect(latestSyncHook).toBeDefined();
      } finally {
        root.unmount();
      }
    } finally {
      bridge.dispose();
      vaultService.shutdown();
    }
  }

  it('deduplicates 3 conflicting legacy override keys into 1 row and resets all 3 keys, catalog fields, SQLite orphan row, and local GOG metadata from Studio (OverrideRow)', async () => {
    await runLegacyThreeKeyResetScenario('studio');
  });

  it('resets all 3 conflicting legacy override keys, catalog fields, SQLite orphan row, and local GOG metadata from FixMatchWizardModal ("Reset to Default")', async () => {
    await runLegacyThreeKeyResetScenario('wizard');
  });

  it('captures nativeBaseline on first handleApplyOverride, preserves it across a second cover-only edit, and restores exact nativeBaseline fields on handleResetOverride', () => {
    const initialNativeGame: CanonicalGame = {
      id: 'gog-991001',
      title: 'Synthetic Classic Shooter Enhanced',
      sortTitle: 'Synthetic Classic Shooter Enhanced',
      originalStoreTitle: 'Synthetic Classic Shooter Enhanced',
      capsuleImage: `https://images.gog-statics.com/${HEX_64_A}_native_cover.jpg`,
      headerImage: `https://images.gog-statics.com/${HEX_64_A}_native_header.jpg`,
      iconUrl: `https://images.gog-statics.com/${HEX_64_A}_native_icon.png`,
      shortDescription:
        'Original native GOG storefront synopsis for Synthetic Classic Shooter Enhanced.',
      detailedDescription:
        '<p>Original native GOG storefront detailed description for Synthetic Classic Shooter Enhanced.</p>',
      releaseDate: '1995-04-30',
      developers: ['Synthetic Retro Labs'],
      publishers: ['Synthetic Classics Publishing'],
      genres: ['Action', 'Shooter'],
      tags: ['Classic', 'Sci-Fi'],
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '991001',
          originalTitle: 'Synthetic Classic Shooter Enhanced',
          installed: true,
          playtimeMinutes: 120,
        },
      ],
    };

    let currentGames: CanonicalGame[] = [initialNativeGame];
    let syncApi!: ReturnType<typeof useCatalogOverrideSync>;

    const HookHost: React.FC = () => {
      const [games, setGames] = React.useState<CanonicalGame[]>([initialNativeGame]);
      const gamesRef = React.useRef<CanonicalGame[]>(games);
      gamesRef.current = games;
      currentGames = games;
      const [, setRefreshKey] = React.useState(0);

      syncApi = useCatalogOverrideSync({
        selectedGame: games[0] ?? null,
        isGridView: true,
        navigateHome: () => {},
        setGames,
        gamesRef,
        setGameRefreshKey: setRefreshKey,
        showSyncNotice: () => {},
      });
      return null;
    };

    const root = createClientComponentRoot(HookHost, {});
    try {
      // 1st override: route GOG game to Steam 880100 with custom title, cover, synopsis, and score
      syncApi.handleApplyOverride({
        gameId: 'gog-991001',
        platformId: 'gog',
        platformGameId: '991001',
        title: 'Synthetic Shooter Remade',
        matchedStore: 'steam',
        matchedId: 880100,
        steamAppId: 880100,
        capsuleImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/library_600x900_2x.jpg',
        headerImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/header.jpg',
        shortDescription: 'First custom routed synopsis.',
        reviewScoreOverride: {
          score: 94,
          tier: 'Mighty',
          source: 'steam',
          url: '',
          isVerified: true,
        },
        updatedAt: '2026-10-29T21:10:00.000Z',
      });
      root.flushStateUpdates();

      const afterFirstOv = getUserOverrideForGame(currentGames[0]);
      expect(afterFirstOv?.nativeBaseline).toBeDefined();
      expect(afterFirstOv?.nativeBaseline?.id).toBe('gog-991001');
      expect(afterFirstOv?.nativeBaseline?.title).toBe('Synthetic Classic Shooter Enhanced');
      expect(afterFirstOv?.nativeBaseline?.capsuleImage).toBe(initialNativeGame.capsuleImage);
      expect(afterFirstOv?.nativeBaseline?.shortDescription).toBe(
        initialNativeGame.shortDescription
      );

      // 2nd edit: cover-only override update (omitting `nativeBaseline` on incoming object)
      syncApi.handleApplyOverride({
        gameId: currentGames[0].id,
        platformId: 'gog',
        platformGameId: '991001',
        title: 'Synthetic Shooter Remade',
        matchedStore: 'steam',
        matchedId: 880100,
        steamAppId: 880100,
        capsuleImage: `https://images.gog-statics.com/${HEX_64_B}.jpg`,
        shortDescription: 'First custom routed synopsis.',
        updatedAt: '2026-10-29T21:20:00.000Z',
      });
      root.flushStateUpdates();

      const afterSecondOv = getUserOverrideForGame(currentGames[0]);
      expect(afterSecondOv?.capsuleImage).toBe(`https://images.gog-statics.com/${HEX_64_B}.jpg`);
      // `nativeBaseline` MUST still hold the original native GOG snapshot, NOT the 1st override!
      expect(afterSecondOv?.nativeBaseline?.id).toBe('gog-991001');
      expect(afterSecondOv?.nativeBaseline?.title).toBe('Synthetic Classic Shooter Enhanced');
      expect(afterSecondOv?.nativeBaseline?.capsuleImage).toBe(initialNativeGame.capsuleImage);
      expect(afterSecondOv?.nativeBaseline?.shortDescription).toBe(
        initialNativeGame.shortDescription
      );

      // Reset override -> restores 100% of `nativeBaseline` fields!
      syncApi.handleResetOverride(currentGames[0].id, {
        game: currentGames[0],
        override: afterSecondOv ?? null,
      });
      root.flushStateUpdates();

      expect(Object.keys(loadUserOverrides())).toHaveLength(0);
      expect(currentGames).toHaveLength(1);
      const restored = currentGames[0];
      expect(restored.id).toBe('gog-991001');
      expect(restored.title).toBe('Synthetic Classic Shooter Enhanced');
      expect(restored.steamAppId).toBeUndefined();
      expect(restored.capsuleImage).toBe(initialNativeGame.capsuleImage);
      expect(restored.headerImage).toBe(initialNativeGame.headerImage);
      expect(restored.iconUrl).toBe(initialNativeGame.iconUrl);
      expect(restored.shortDescription).toBe(initialNativeGame.shortDescription);
      expect(restored.detailedDescription).toBe(initialNativeGame.detailedDescription);
      expect(restored.releaseDate).toBe('1995-04-30');
      expect(restored.developers).toEqual(['Synthetic Retro Labs']);
      expect(restored.publishers).toEqual(['Synthetic Classics Publishing']);
      expect(restored.genres).toEqual(['Action', 'Shooter']);
      expect(restored.tags).toEqual(['Classic', 'Sci-Fi']);
    } finally {
      root.unmount();
    }
  });
});

// ============================================================================
// SUITE 3 — Issue 3: Custom & Cross-Storefront Cover Art Selection,
// SQLite Self-Heal & Same-Storefront `"Enhanced"` Protection
// ============================================================================

describe('Suite 3 — Issue 3: Custom & Cross-Storefront Cover Art, SQLite Self-Heal & Enhanced Collision Protection', () => {
  it('self-heals poisoned federated rows on startup and enforces cross-storefront, 64-hex GOG hash, and ov blob-persistence guards in real SQLite OfflineVaultService + StorefrontLocalCacheFederator', async () => {
    const tempRoot = makeTempTestDir('sqlite-cover-federation');
    const userDataDir = path.join(tempRoot, 'userData');
    const homeDir = path.join(tempRoot, 'home');
    const gogRootDir = path.join(tempRoot, 'gog-galaxy');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const { webCacheCoverPath } = seedSyntheticGogGalaxyDbAndWebCache(gogRootDir);

    const federator = new StorefrontLocalCacheFederator({
      homedir: homeDir,
      userDataDir,
      gogGalaxyRoots: [gogRootDir],
      steamRoots: [],
      heroicRoots: [],
      legendaryDirs: [],
      xboxGamesRoots: [],
      amazonDbPaths: [],
    });

    // Step 1: Seed poisoned `game_media_assets` rows across BOTH macOS (`darwin` POSIX) AND Windows (`win32` NT backslash) paths
    const win32PoisonedWebCachePath = `C:\\ProgramData\\GOG.com\\Galaxy\\webcache\\u1\\gog\\991001\\${HEX_64_A}_glx_vertical_cover.webp`;
    const seedVault = new OfflineVaultService({
      userDataDir,
      federator,
    });
    try {
      const db1 = seedVault.ensureOpen();
      const insertStmt = db1.prepare(
        `
          INSERT INTO game_media_assets (
            url_key, game_id, asset_role, ordinal, source_url, storage_kind,
            blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
          ) VALUES (?, ?, ?, ?, ?, 'federated', NULL, ?, 0, 0, 200, ?)
        `
      );
      insertStmt.run(
        'steam-880100::cover::0',
        'steam-880100',
        'cover',
        0,
        `https://images.gog-statics.com/${HEX_64_B}.jpg`,
        webCacheCoverPath,
        Date.now()
      );
      insertStmt.run(
        'steam-880100-win32::cover::0',
        'steam-880100-win32',
        'cover',
        0,
        `https://images.gog-statics.com/${HEX_64_B}.jpg`,
        win32PoisonedWebCachePath,
        Date.now()
      );
    } finally {
      seedVault.shutdown();
    }

    // Step 2: Re-open `OfflineVaultService` and verify `runStartupSelfHeal` resets `steam-880100::cover::0` to `'pending'`!
    let isOnline = true;
    const steamCoverUrl =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/library_600x900_2x.jpg';
    const gogHexBCoverUrl = `https://images.gog-statics.com/${HEX_64_B}.jpg`;
    const gogHexACoverUrl = `https://images.gog-statics.com/${HEX_64_A}.webp`;

    const fetchMock = vi.fn(async (input: string | URL) => {
      if (!isOnline) {
        throw new Error('Simulated offline network');
      }
      const reqUrl = String(input);
      if (reqUrl === steamCoverUrl) {
        return new Response(new Uint8Array(MOCK_STEAM_JPEG_BYTES), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (reqUrl === gogHexBCoverUrl || reqUrl === gogHexACoverUrl) {
        return new Response(new Uint8Array(MOCK_CUSTOM_GOG_JPEG_BYTES), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response(null, { status: 404 });
    });

    const activeVault = new OfflineVaultService({
      userDataDir,
      federator,
      fetchImpl: fetchMock,
      isNetworkOnline: () => isOnline,
    });

    try {
      const db2 = activeVault.ensureOpen();
      const healedRow = db2
        .prepare(
          'SELECT storage_kind, federated_path FROM game_media_assets WHERE url_key = ?'
        )
        .get('steam-880100::cover::0');
      expect(healedRow).toBeDefined();
      expect(healedRow?.storage_kind).toBe('pending');
      expect(healedRow?.federated_path).toBeNull();

      const healedWin32Row = db2
        .prepare(
          'SELECT storage_kind, federated_path FROM game_media_assets WHERE url_key = ?'
        )
        .get('steam-880100-win32::cover::0');
      expect(healedWin32Row).toBeDefined();
      expect(healedWin32Row?.storage_kind).toBe('pending');
      expect(healedWin32Row?.federated_path).toBeNull();

      // Case 1: Steam cover URL with `gogId: '991001'` & `steamAppId: '880100'` (even WITHOUT `ov`!)
      // Must NOT hijack with local GOG `.webp` WebCache; must fetch & blob `MOCK_STEAM_JPEG_BYTES`!
      const resSteam = await activeVault.resolveMediaRequest({
        gameId: 'steam-880100',
        role: 'cover',
        ordinal: 0,
        url: steamCoverUrl,
        gogId: '991001',
        steamAppId: '880100',
      });
      expect(resSteam.kind).toBe('buffer');
      expect(resSteam.source).toBe('upstream_persisted');
      expect(Buffer.compare(resSteam.buffer!, MOCK_STEAM_JPEG_BYTES)).toBe(0);
      expect(Buffer.compare(resSteam.buffer!, MOCK_OLD_GOG_WEBP_BYTES)).not.toBe(0);

      // Case 2: Different GOG CDN URL (`HEX_64_B`) vs local `HEX_64_A` WebCache
      // 64-hex mismatch MUST bypass local `<64hexA>` WebCache and fetch & blob `MOCK_CUSTOM_GOG_JPEG_BYTES`!
      const resGogHexB = await activeVault.resolveMediaRequest({
        gameId: 'gog-991001',
        role: 'cover',
        ordinal: 0,
        url: gogHexBCoverUrl,
        gogId: '991001',
        steamAppId: '880100',
      });
      expect(resGogHexB.kind).toBe('buffer');
      expect(resGogHexB.source).toBe('upstream_persisted');
      expect(Buffer.compare(resGogHexB.buffer!, MOCK_CUSTOM_GOG_JPEG_BYTES)).toBe(0);

      // Case 3: Explicit user override (`ov: '2026-10-29T22:00:00.000Z'`) even on `HEX_64_A` URL!
      // First verify without `ov` on a clean game slot that `HEX_64_A` WOULD federate locally, then pass `ov` and prove Tier 1B & Tier 2 are bypassed and stored in `media_blobs`!
      const fedWithoutOv = await activeVault.resolveMediaRequest({
        gameId: 'gog-991099',
        role: 'cover',
        ordinal: 0,
        url: gogHexACoverUrl,
        gogId: '991001',
      });
      expect(fedWithoutOv.kind).toBe('file');
      expect(fedWithoutOv.source).toBe('gog_galaxy_webcache');

      const resExplicitOv = await activeVault.resolveMediaRequest({
        gameId: 'gog-991099',
        role: 'cover',
        ordinal: 0,
        url: gogHexACoverUrl,
        gogId: '991001',
        steamAppId: '880100',
        ov: '2026-10-29T22:00:00.000Z',
      });
      expect(resExplicitOv.kind).toBe('buffer');
      expect(resExplicitOv.source).toBe('upstream_persisted');
      expect(Buffer.compare(resExplicitOv.buffer!, MOCK_CUSTOM_GOG_JPEG_BYTES)).toBe(0);

      // Go completely offline and verify subsequent read serves `MOCK_CUSTOM_GOG_JPEG_BYTES` from Tier 1A `vault_blob`!
      isOnline = false;
      fetchMock.mockClear();
      const resOfflineBlob = await activeVault.resolveMediaRequest({
        gameId: 'gog-991099',
        role: 'cover',
        ordinal: 0,
        url: gogHexACoverUrl,
        gogId: '991001',
        steamAppId: '880100',
        ov: '2026-10-29T22:00:00.000Z',
      });
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(resOfflineBlob.kind).toBe('file');
      expect(resOfflineBlob.source).toBe('vault_blob');
      const diskBlobBytes = fs.readFileSync(resOfflineBlob.filePath!);
      expect(Buffer.compare(diskBlobBytes, MOCK_CUSTOM_GOG_JPEG_BYTES)).toBe(0);
    } finally {
      activeVault.shutdown();
    }
  });

  it('protects an overridden "Enhanced" GOG entitlement from same-storefront Steam AppID collision demotion in sanitizeGameCatalog', () => {
    const customCoverUrl = `https://images.gog-statics.com/${HEX_64_B}.jpg`;

    saveUserOverride({
      gameId: 'gog-991001',
      platformId: 'gog',
      platformGameId: '991001',
      title: 'Synthetic Shooter Enhanced',
      matchedStore: 'steam',
      matchedId: 880100,
      steamAppId: 880100,
      capsuleImage: customCoverUrl,
      updatedAt: '2026-10-29T22:00:00.000Z',
    });

    const gogEnhanced: CanonicalGame = {
      id: 'gog-991001',
      title: 'Synthetic Shooter Enhanced',
      sortTitle: 'Synthetic Shooter Enhanced',
      originalStoreTitle: 'Synthetic Shooter Enhanced',
      steamAppId: 880100,
      capsuleImage: customCoverUrl,
      headerImage: 'https://cdn.synthetic.invalid/headers/991001.jpg',
      shortDescription: 'Enhanced edition of Synthetic Shooter.',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '991001',
          originalTitle: 'Synthetic Shooter Enhanced',
          installed: true,
        },
      ],
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const gogBundleSequel: CanonicalGame = {
      id: 'gog-991002',
      title: 'Synthetic Shooter + Sequel',
      sortTitle: 'Synthetic Shooter + Sequel',
      originalStoreTitle: 'Synthetic Shooter + Sequel',
      steamAppId: 880100,
      capsuleImage: 'https://cdn.synthetic.invalid/covers/991002.jpg',
      headerImage: 'https://cdn.synthetic.invalid/headers/991002.jpg',
      shortDescription: 'Classic bundle edition.',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '991002',
          originalTitle: 'Synthetic Shooter + Sequel',
          installed: false,
        },
      ],
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const sanitized = sanitizeGameCatalog([gogEnhanced, gogBundleSequel]);
    const enhancedOut = sanitized.find((g) =>
      g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '991001')
    );

    expect(enhancedOut).toBeDefined();
    expect(enhancedOut?.title).toBe('Synthetic Shooter Enhanced');
    expect(enhancedOut?.steamAppId).toBe(880100);
    expect(enhancedOut?.capsuleImage).toBe(customCoverUrl);
  });

  it('places _2x.jpg userOverride.capsuleImage at index 0, renders ol-media://asset?...&ov=..., and accepts wide custom covers (ratio 1.0 > 0.94) on both _2x and 1x fallback without adding to failedCoverUrls', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      isElectron: true,
      offlineVault: {},
    };
    window.dispatchEvent(new Event('offline'));

    const cover2x =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/library_600x900_2x.jpg';
    const cover1x =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/library_600x900.jpg';
    const ovTimestamp = '2026-10-29T22:00:00.000Z';

    const userOverride: UserGameOverride = {
      gameId: 'gog-991001',
      platformId: 'gog',
      platformGameId: '991001',
      title: 'Synthetic Classic Shooter Enhanced',
      matchedStore: 'steam',
      matchedId: 880100,
      steamAppId: 880100,
      capsuleImage: cover2x,
      updatedAt: ovTimestamp,
    };
    saveUserOverride(userOverride);

    const game: CanonicalGame = {
      id: 'gog-991001',
      title: 'Synthetic Classic Shooter Enhanced',
      sortTitle: 'Synthetic Classic Shooter Enhanced',
      steamAppId: 880100,
      capsuleImage: cover2x,
      headerImage:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/880100/header.jpg',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '991001',
          originalTitle: 'Synthetic Classic Shooter Enhanced',
          installed: false,
        },
      ],
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    // 1. Candidate ordering: exact `_2x.jpg` at index 0 ahead of `1x`
    const candidates = getCoverCandidates(game, undefined, userOverride);
    expect(candidates[0]).toBe(cover2x);
    expect(candidates[1]).toBe(cover1x);

    // 2. Render `GameCardCover` and verify `ol-media://asset?...&ov=...`
    const root = createClientComponentRoot(GameCardCover, {
      game,
      userOverride,
      cardIndex: 0,
    });

    try {
      const imgElements1 = root.getElements().filter((el) => el.tag === 'img');
      expect(imgElements1).toHaveLength(1);
      const renderedSrc2x = String(imgElements1[0].props.src || '');
      expect(renderedSrc2x.startsWith('ol-media://asset?')).toBe(true);
      const parsed2x = new URL(renderedSrc2x);
      expect(parsed2x.searchParams.get('url')).toBe(cover2x);
      expect(parsed2x.searchParams.get('ov')).toBe(ovTimestamp);

      // 3a. Fire `onLoad` with square/wide dimensions (`1000x1000`, `ratio = 1.0 > 0.94`) on `_2x`
      const onLoad2x = imgElements1[0].props.onLoad as (e: {
        currentTarget: { naturalWidth: number; naturalHeight: number };
      }) => void;
      onLoad2x({ currentTarget: { naturalWidth: 1000, naturalHeight: 1000 } });
      root.flushStateUpdates();

      expect(failedCoverUrls.has(renderedSrc2x)).toBe(false);
      expect(failedCoverUrls.has(cover2x)).toBe(false);

      // 3b. Simulate `_2x` 404 (`onError`) so `GameCardCover` falls back to `1x`, then fire `onLoad` (`1000x1000`) on `1x`!
      const onError2x = imgElements1[0].props.onError as () => void;
      onError2x();
      root.flushStateUpdates();

      const imgElements1x = root.getElements().filter((el) => el.tag === 'img');
      expect(imgElements1x).toHaveLength(1);
      const renderedSrc1x = String(imgElements1x[0].props.src || '');
      const parsed1x = new URL(renderedSrc1x);
      expect(parsed1x.searchParams.get('url')).toBe(cover1x);
      expect(parsed1x.searchParams.get('ov')).toBe(ovTimestamp);

      const onLoad1x = imgElements1x[0].props.onLoad as (e: {
        currentTarget: { naturalWidth: number; naturalHeight: number };
      }) => void;
      onLoad1x({ currentTarget: { naturalWidth: 1000, naturalHeight: 1000 } });
      root.flushStateUpdates();

      expect(failedCoverUrls.has(renderedSrc1x)).toBe(false);
      expect(failedCoverUrls.has(cover1x)).toBe(false);
    } finally {
      root.unmount();
    }
  });
});
