/**
 * Wave 3B — Hermetic Performance & Behavioral Regression Test Suite
 * for Library Match & Overrides Studio (macOS `darwin` + Windows `win32`).
 *
 * Strictly Zero-PII (100% synthetic fixtures), offline `net.Socket` safe,
 * and deterministic (< 4s execution).
 *
 * Covers:
 * 1. `LibraryMatchManagerModal` Frame-1 Virtualization & Zero Mount Bomb (`darwin` & `win32`)
 * 2. Imperative Bounded `P2_BACKGROUND` Synopsis Probe Worker & Durable Negative Cache (`darwin` & `win32`)
 * 3. `O(1)` Memoized `getSuppressedCatalogEntries`, Key Hygiene & Scaling
 * 4. Event Storm Isolation, `stagedCacheService` >2KB Vault Round-Trip & `SteamApiService` Digest Retention
 * 5. Interactive Modal Preemption (`useBackgroundMediaWarmup`) & Incremental Dirty-Slice Persistence (`saveCurrentCatalog`)
 * 6. Universal Portability, Dual-OS Entitlement Badges (`macOS Native` / `Bottled` vs `Windows Native`) & WCAG 2.2 AA Semantics
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestDOMParser, type ParsedDomElementNode } from './helpers/domParserHelper';
import type { CanonicalGame } from '../src/contracts/game';
import type { StorefrontId } from '../src/contracts/platform';
import type { SearchMatchCandidate } from '../src/contracts/override';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import { RequestPriority } from '../src/services/network/requestScheduler';
import {
  LibraryMatchManagerModal,
  clearDurableEmptySynopsisProbe,
  hasDurableEmptySynopsisProbe,
} from '../src/components/Library/LibraryMatchManagerModal';
import {
  STORAGE_KEY_EMPTY_SYNOPSIS_PROBES,
  classifyAutoFilteredSubCategory,
} from '../src/components/Library/MatchManager/matchManagerDiagnostics';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import {
  STORAGE_KEY_SUPPRESSED_ENTRIES,
  clearSuppressedCatalogEntries,
  getSuppressedCatalogEntries,
  registerSuppressedCatalogEntries,
  type SuppressedCatalogEntry,
} from '../src/services/integrations/catalogSanitizer';
import * as catalogSanitizerModule from '../src/services/integrations/catalogSanitizer';
import {
  STORAGE_KEY_RESTORED_NON_GAMES,
  confirmMultipleNonGameStorefrontEntries,
  confirmNonGameStorefrontEntry,
  getReadonlyRestoredNonGameKeys,
  hideStorefrontEntry,
  saveUserOverride,
  unconfirmNonGameStorefrontEntry,
  unhideStorefrontEntry,
} from '../src/services/storage/userOverrideStorage';
import {
  clearStagedMemoryFallback,
  hydrateAllStagedCacheFromVault,
  loadStagedCache,
  saveStagedCache,
} from '../src/services/storage/stagedCacheService';
import { SteamApiService, steamApi } from '../src/services/steam/steamApi';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { useCatalogOverrideSync } from '../src/hooks/useCatalogOverrideSync';
import { useBackgroundMediaWarmup } from '../src/hooks/useBackgroundMediaWarmup';
import { syncJobManager, type SyncJobState } from '../src/services/network/syncJobManager';
import { saveCurrentCatalog } from '../src/services/integrations/integrationStorage';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import { launcherService } from '../src/services/launcher/launcherService';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';

// ============================================================================
// Hermetic Browser, Storage, IndexedDB & React 19 Client Renderer Harness
// ============================================================================

function parseHtmlDocument(html: string): {
  body: ParsedDomElementNode;
  querySelector: (selector: string) => ParsedDomElementNode | null;
  querySelectorAll: (selector: string) => ParsedDomElementNode[];
  getElementById: (id: string) => ParsedDomElementNode | null;
} {
  const parsed = new TestDOMParser().parseFromString(html, 'text/html');
  return {
    body: parsed.body,
    querySelector: parsed.querySelector,
    querySelectorAll: parsed.querySelectorAll,
    getElementById: (id: string) => parsed.body.querySelector(`[id="${id}"]`),
  };
}

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
    open(dbName: string, _version?: number) {
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
        transaction(_storeNames: string | string[], _mode?: IDBTransactionMode) {
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

interface HostViewportMetrics {
  clientWidth: number;
  clientHeight: number;
}

interface StubHostElement {
  tagName: string;
  isConnected: boolean;
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  offsetHeight: number;
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

interface FiberRecord {
  states: unknown[];
  refs: Array<{ current: unknown }>;
  memos: Array<{ deps?: readonly unknown[]; value: unknown }>;
  effectDeps: Array<readonly unknown[] | undefined>;
  effectCleanups: Array<(() => void) | undefined>;
  layoutDeps: Array<readonly unknown[] | undefined>;
  layoutCleanups: Array<(() => void) | undefined>;
}

const REACT_PORTAL_SYMBOL = Symbol.for('react.portal');
const REACT_MEMO_SYMBOL = Symbol.for('react.memo');
const REACT_FORWARD_REF_SYMBOL = Symbol.for('react.forward_ref');
const REACT_PROVIDER_SYMBOL = Symbol.for('react.provider');
const REACT_CONTEXT_SYMBOL = Symbol.for('react.context');

/**
 * Recursive React 19 Client Renderer Harness.
 * Executes components with a genuine client hook dispatcher (`isRealClientRenderer === true`),
 * supports `@tanstack/react-virtual` (`useReducer`, `useLayoutEffect`, `ResizeObserver`, ref callbacks),
 * captures exact Frame-1 HTML prior to layout commit, and tracks effect lifecycles cleanly.
 */
function createClientComponentRoot<P extends object>(
  Component: React.ComponentType<P>,
  initialProps: P,
  initialMetrics: HostViewportMetrics = { clientWidth: 0, clientHeight: 0 }
) {
  let currentProps: P = { ...initialProps };
  const viewportMetrics: HostViewportMetrics = { ...initialMetrics };
  const fibers = new Map<string, FiberRecord>();
  const hostElements = new Map<string, StubHostElement>();
  const activeResizeCallbacks = new Set<ResizeObserverCallback>();
  let isUnmounted = false;
  let dirtyFromStateUpdate = false;
  let latestHtml = '';
  let frame1InitialPassHtml = '';
  let latestElements: RenderedElementRecord[] = [];

  const prevResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
  class ControlledResizeObserver {
    private cb: ResizeObserverCallback;
    private observed = new Set<Element>();
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      activeResizeCallbacks.add(cb);
    }
    observe(target: Element) {
      this.observed.add(target);
    }
    unobserve(target: Element) {
      this.observed.delete(target);
    }
    disconnect() {
      this.observed.clear();
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
      attrs.set(attrName, String(v));
      if (k.startsWith('data-')) {
        const camel = k
          .slice(5)
          .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
        dataset[camel] = String(v);
      }
    }
    const isRowItem = props['data-index'] !== undefined;
    const width = isRowItem ? Math.max(viewportMetrics.clientWidth, 960) : viewportMetrics.clientWidth;
    const height = isRowItem ? 78 : viewportMetrics.clientHeight;

    if (!stub) {
      stub = {
        tagName: tag.toUpperCase(),
        isConnected: true,
        clientWidth: width,
        clientHeight: height,
        offsetWidth: width,
        offsetHeight: height,
        scrollTop: 0,
        scrollLeft: 0,
        scrollHeight: 24_000,
        scrollWidth: 960,
        open: Boolean(props.open),
        style: {},
        dataset,
        ownerDocument: { defaultView: typeof window !== 'undefined' ? window : globalThis },
        getAttribute: (name: string) => attrs.get(name) ?? null,
        setAttribute: (name: string, value: string) => {
          attrs.set(name, value);
        },
        removeAttribute: (name: string) => {
          attrs.delete(name);
        },
        hasAttribute: (name: string) => attrs.has(name),
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () =>
          ({
            top: 0,
            left: 0,
            right: stub!.clientWidth,
            bottom: stub!.clientHeight,
            width: stub!.clientWidth,
            height: stub!.clientHeight,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
        scrollTo: (opts) => {
          if (typeof opts === 'object' && opts !== null && typeof opts.top === 'number') {
            stub!.scrollTop = opts.top;
          } else if (typeof opts === 'number') {
            stub!.scrollTop = opts;
          }
        },
        focus: () => {},
        showModal: () => {
          stub!.open = true;
        },
        close: () => {
          stub!.open = false;
        },
      };
      hostElements.set(elKey, stub);
    } else {
      stub.clientWidth = width;
      stub.clientHeight = height;
      stub.offsetWidth = width;
      stub.offsetHeight = height;
      stub.dataset = dataset;
      stub.getAttribute = (name: string) => attrs.get(name) ?? null;
    }
    return stub;
  };

  const executeSingleRenderCycle = () => {
    const seenFibers = new Set<string>();
    const elements: RenderedElementRecord[] = [];
    const refCommits: Array<() => void> = [];
    const pendingLayouts: Array<{ fiber: FiberRecord; idx: number; fn: () => void | (() => void) }> = [];
    const pendingEffects: Array<{ fiber: FiberRecord; idx: number; fn: () => void | (() => void) }> = [];

    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    let activeFiber: FiberRecord | null = null;
    let activeFiberKey = '';
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
          pendingLayouts.push({ fiber, idx, fn });
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
      const prevIndices = [stateIdx, refIdx, memoIdx, layoutIdx, effectIdx, idIdx] as const;

      activeFiber = getOrCreateFiber(fiberKey);
      activeFiberKey = fiberKey;
      stateIdx = 0;
      refIdx = 0;
      memoIdx = 0;
      layoutIdx = 0;
      effectIdx = 0;
      idIdx = 0;

      try {
        const out = invoke();
        return renderNode(out, fiberKey);
      } finally {
        activeFiber = prevFiber;
        activeFiberKey = prevKey;
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

          if (wrapper.$$typeof === REACT_MEMO_SYMBOL) {
            const inner = wrapper.type;
            if (typeof inner === 'function') {
              const fnName =
                (inner as { displayName?: string; name?: string }).displayName ||
                (inner as { name?: string }).name ||
                'Memo';
              return renderComponentWithHooks(`${pathKey}/Memo(${fnName}):${keyPart}`, () =>
                (inner as (p: Record<string, unknown>) => React.ReactNode)(rawProps)
              );
            }
          }

          if (wrapper.$$typeof === REACT_FORWARD_REF_SYMBOL && typeof wrapper.render === 'function') {
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

          if (elRef) {
            const stub = getOrCreateStubElement(domKey, tag, rawProps);
            refCommits.push(() => {
              if (typeof elRef === 'function') {
                elRef(stub);
              } else if (typeof elRef === 'object' && elRef !== null && 'current' in elRef) {
                (elRef as { current: unknown }).current = stub;
              }
            });
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

  const flushRenderAndCommit = (captureFrame1: boolean) => {
    let guard = 0;
    const queuedPassiveEffects: Array<{
      fiber: FiberRecord;
      idx: number;
      fn: () => void | (() => void);
    }> = [];

    do {
      dirtyFromStateUpdate = false;
      const cycle = executeSingleRenderCycle();
      if (captureFrame1 && guard === 0) {
        frame1InitialPassHtml = cycle.html;
      }
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
    getFrame1Html: () => frame1InitialPassHtml,
    getHtml: () => latestHtml,
    getElements: () => latestElements,
    rerender(nextProps?: Partial<P>) {
      if (nextProps) {
        currentProps = { ...currentProps, ...nextProps };
      }
      flushRenderAndCommit(false);
    },
    triggerResize(nextMetrics: HostViewportMetrics) {
      viewportMetrics.clientWidth = nextMetrics.clientWidth;
      viewportMetrics.clientHeight = nextMetrics.clientHeight;
      for (const stub of hostElements.values()) {
        if (!('index' in stub.dataset)) {
          stub.clientWidth = nextMetrics.clientWidth;
          stub.clientHeight = nextMetrics.clientHeight;
          stub.offsetWidth = nextMetrics.clientWidth;
          stub.offsetHeight = nextMetrics.clientHeight;
        }
      }
      for (const cb of Array.from(activeResizeCallbacks)) {
        cb([], {} as ResizeObserver);
      }
      if (typeof window !== 'undefined') {
        const flushRaf = (window as unknown as { __flushAnimationFrames?: () => void })
          .__flushAnimationFrames;
        flushRaf?.();
      }
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
// Synthetic Zero-PII Fixture Builders
// ============================================================================

function makeSyntheticGame(
  index: number,
  overrides: Partial<CanonicalGame> = {}
): CanonicalGame {
  const padded = String(index).padStart(4, '0');
  const title = overrides.title ?? `Synthetic Horizon Quest ${padded}`;
  const platformId: StorefrontId =
    overrides.platforms?.[0]?.platformId ??
    (['steam', 'gog', 'epic', 'xbox'][index % 4] as StorefrontId);
  const platformGameId =
    overrides.platforms?.[0]?.platformGameId ??
    (platformId === 'steam' ? String(910000 + index) : `syn-${platformId}-${padded}`);

  const defaultPlatform: CanonicalGame['platforms'][number] = {
    platformId,
    platformGameId,
    originalTitle: title,
    installed: false,
  };

  return {
    id: overrides.id ?? `${platformId}-${platformGameId}`,
    title,
    sortTitle: title,
    originalStoreTitle: title,
    steamAppId:
      overrides.steamAppId !== undefined
        ? overrides.steamAppId
        : platformId === 'steam'
        ? 910000 + index
        : undefined,
    headerImage: overrides.headerImage ?? `https://cdn.synthetic.invalid/headers/${padded}.jpg`,
    capsuleImage: overrides.capsuleImage ?? `https://cdn.synthetic.invalid/capsules/${padded}.jpg`,
    shortDescription:
      overrides.shortDescription !== undefined
        ? overrides.shortDescription
        : `Synthetic synopsis for ${title}.`,
    releaseDate: overrides.releaseDate ?? '2024',
    developers: overrides.developers ?? ['Synthetic Studio Works'],
    publishers: overrides.publishers ?? ['Synthetic Publishing'],
    genres: overrides.genres ?? ['Action', 'Adventure'],
    tags: overrides.tags ?? ['Singleplayer'],
    platforms: overrides.platforms ?? [defaultPlatform],
    ...overrides,
  };
}

function setupBrowserAndPlatformGlobals(
  platform: 'darwin' | 'win32',
  storage: MemoryStorage,
  electronOverrides: Record<string, unknown> = {}
) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let nextRafId = 1;
  const queuedRafCallbacks = new Map<number, FrameRequestCallback>();

  const flushAnimationFrames = () => {
    const batch = Array.from(queuedRafCallbacks.entries());
    queuedRafCallbacks.clear();
    for (const [, cb] of batch) {
      cb(16);
    }
  };

  const winObj: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: storage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    __flushAnimationFrames: flushAnimationFrames,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      queuedRafCallbacks.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      queuedRafCallbacks.delete(id);
    },
    addEventListener(type: string, handler: EventListenerOrEventListenerObject) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: Event) {
      const set = listeners.get(event.type);
      if (set) {
        for (const fn of Array.from(set)) {
          if (typeof fn === 'function') {
            fn(event);
          } else if (typeof fn.handleEvent === 'function') {
            fn.handleEvent(event);
          }
        }
      }
      return true;
    },
    electronAPI: {
      platform,
      offlineVault: {
        upsertGames: vi.fn().mockResolvedValue({ ok: true }),
        removeGames: vi.fn().mockResolvedValue({ ok: true }),
        loadCatalog: vi.fn().mockResolvedValue([]),
      },
      ...electronOverrides,
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winObj,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: true,
      platform: platform === 'darwin' ? 'MacIntel' : 'Win32',
      userAgent:
        platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_0)'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    configurable: true,
    writable: true,
  });

  if (typeof globalThis.CustomEvent === 'undefined') {
    class PolyfillCustomEvent<T = unknown> extends Event {
      readonly detail: T;
      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    }
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: PolyfillCustomEvent,
      configurable: true,
      writable: true,
    });
  }

  return winObj;
}

// ============================================================================
// Suite Lifecycle Setup & Isolation
// ============================================================================

describe('Wave 3B — Match Studio Performance & Behavioral Regression Suite (darwin + win32)', () => {
  let memoryStorage: MemoryStorage;

  beforeEach(() => {
    vi.restoreAllMocks();
    activeIdbDatabases.clear();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: createHermeticIndexedDbFactory(),
      configurable: true,
      writable: true,
    });

    memoryStorage = new MemoryStorage();
    setupBrowserAndPlatformGlobals('darwin', memoryStorage);
    clearSuppressedCatalogEntries();
    clearStagedMemoryFallback();

    vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
    vi.spyOn(onlineLifecycleManager, 'onOnline').mockReturnValue(() => {});
    vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(undefined);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
  });

  afterEach(() => {
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).__ENABLE_AUTO_STORE_MEDIA_WARMUP__;
    }
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Frame-1 Virtualization & Zero Mount Bomb (`darwin` & `win32`)
  // ==========================================================================
  describe('1. LibraryMatchManagerModal Frame-1 Virtualization & Zero Mount Bomb', () => {
    it.each(['darwin', 'win32'] as const)(
      'mounts data-testid="virtualized-list-container" on Frame 1 with <= 30 [data-index] rows when clientHeight === 0 on %s',
      (osPlatform) => {
        setupBrowserAndPlatformGlobals(osPlatform, memoryStorage);

        vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
        vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(
          null as unknown as SteamEnrichedMetadata
        );

        // 500 synthetic games where 420 are missing 2:3 cover art -> > 400 diagnostic rows on Frame 1
        const syntheticGames: CanonicalGame[] = Array.from({ length: 500 }, (_, i) =>
          makeSyntheticGame(i + 1, {
            capsuleImage: i < 420 ? '' : `https://cdn.synthetic.invalid/cap-${i}.jpg`,
          })
        );

        const t0 = performance.now();
        const root = createClientComponentRoot(
          LibraryMatchManagerModal,
          {
            isOpen: true,
            games: syntheticGames,
            onClose: () => {},
            onFixMatchForGame: () => {},
          },
          { clientWidth: 0, clientHeight: 0 }
        );
        const frame1ElapsedMs = performance.now() - t0;

        try {
          // 1A: Exact Frame-1 initial render pass (before ResizeObserver / layout rect measurement)
          const frame1Doc = parseHtmlDocument(root.getFrame1Html());
          expect(
            frame1Doc.querySelector('[data-testid="virtualized-list-container"]')
          ).not.toBeNull();
          const frame1Rows = frame1Doc.querySelectorAll('[data-index]');
          expect(frame1Rows.length).toBeGreaterThan(0);
          expect(frame1Rows.length).toBeLessThanOrEqual(30);

          // 1B: Post-layout commit while scroll container STILL reports clientHeight === 0
          // Virtualizer stays mounted (never falling back to mounting 420+ non-virtualized rows!)
          const zeroRectDoc = parseHtmlDocument(root.getHtml());
          expect(
            zeroRectDoc.querySelector('[data-testid="virtualized-list-container"]')
          ).not.toBeNull();
          const zeroRectRows = zeroRectDoc.querySelectorAll('[data-index]');
          expect(zeroRectRows.length).toBeLessThanOrEqual(30);

          // 1C: Subsequent ResizeObserver callback reporting real 960x680 modal viewport
          root.triggerResize({ clientWidth: 960, clientHeight: 680 });
          const resizedDoc = parseHtmlDocument(root.getHtml());
          expect(
            resizedDoc.querySelector('[data-testid="virtualized-list-container"]')
          ).not.toBeNull();
          const resizedRows = resizedDoc.querySelectorAll('[data-index]');
          expect(resizedRows.length).toBeGreaterThan(5);
          expect(resizedRows.length).toBeLessThanOrEqual(30);

          expect(frame1ElapsedMs).toBeLessThan(400);
        } finally {
          root.unmount();
        }
      }
    );
  });

  // ==========================================================================
  // 2. Imperative Bounded P2_BACKGROUND Synopsis Probe Worker & Negative Cache
  // ==========================================================================
  describe('2. Imperative Bounded P2_BACKGROUND Synopsis Probe Worker & Durable Negative Cache', () => {
    it.each(['darwin', 'win32'] as const)(
      'bounds concurrency <= 2, completes 16/16 staggered probes at P2_BACKGROUND, coalesces batch updates, and persists negative cache on %s',
      async (osPlatform) => {
        setupBrowserAndPlatformGlobals(osPlatform, memoryStorage);

        const emptyIndices = new Set([3, 7, 11, 15]);
        const games: CanonicalGame[] = Array.from({ length: 16 }, (_, idx) => {
          const isSteam = idx < 8;
          const store: StorefrontId = isSteam
            ? 'steam'
            : (['gog', 'epic', 'xbox'][idx % 3] as StorefrontId);
          const platGameId = isSteam ? String(920100 + idx) : `syn-probe-${store}-${idx}`;
          return makeSyntheticGame(idx + 100, {
            id: `${store}-${platGameId}`,
            title: `Synthetic Unprobed Adventure ${idx + 1}`,
            steamAppId: isSteam ? 920100 + idx : undefined,
            capsuleImage: `https://cdn.synthetic.invalid/cap-probe-${idx}.jpg`,
            headerImage: `https://cdn.synthetic.invalid/hdr-probe-${idx}.jpg`,
            shortDescription: '',
            enrichedMetadata: undefined,
            platforms: [
              {
                platformId: store,
                platformGameId: platGameId,
                originalTitle: `Synthetic Unprobed Adventure ${idx + 1}`,
                installed: false,
              },
            ],
          });
        });

        let activeInFlight = 0;
        let peakInFlight = 0;
        let completedProbes = 0;
        const observedSteamPriorities: RequestPriority[] = [];
        const observedNonSteamOpts: Array<{
          priority?: RequestPriority;
          synopsisOnly?: boolean;
        }> = [];

        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        const steamSpy = vi
          .spyOn(steamApi, 'fetchGameMetadata')
          .mockImplementation(async (appId, priority) => {
            observedSteamPriorities.push(priority as RequestPriority);
            activeInFlight += 1;
            peakInFlight = Math.max(peakInFlight, activeInFlight);
            const idx = appId - 920100;
            await delay(idx % 2 === 0 ? 2 : 25);
            activeInFlight -= 1;
            completedProbes += 1;

            const emptyReviewSummary = {
              reviewScore: 0,
              reviewScoreDesc: 'No user reviews',
              totalPositive: 0,
              totalNegative: 0,
              totalReviews: 0,
              positivePercent: 0,
            };

            if (emptyIndices.has(idx)) {
              return {
                appId,
                name: `Synthetic Unprobed Adventure ${idx + 1}`,
                shortDescription: '',
                detailedDescription: '',
                aboutTheGame: '',
                headerImage: `https://cdn.synthetic.invalid/hdr-probe-${idx}.jpg`,
                developers: ['Synthetic Dev'],
                publishers: ['Synthetic Pub'],
                genres: ['Action'],
                tags: [],
                categories: [],
                screenshots: [],
                movies: [],
                systemRequirements: {},
                reviewSummary: emptyReviewSummary,
                releaseDate: '',
              };
            }
            return {
              appId,
              name: `Synthetic Unprobed Adventure ${idx + 1}`,
              shortDescription: `Resolved Steam synopsis for synthetic item ${idx + 1}.`,
              detailedDescription: '',
              aboutTheGame: '',
              headerImage: `https://cdn.synthetic.invalid/hdr-probe-${idx}.jpg`,
              developers: ['Synthetic Dev'],
              publishers: ['Synthetic Pub'],
              genres: ['Action'],
              tags: [],
              categories: [],
              screenshots: [],
              movies: [],
              systemRequirements: {},
              reviewSummary: emptyReviewSummary,
              releaseDate: '2024',
            };
          });

        const nonSteamSpy = vi
          .spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame')
          .mockImplementation(async (game, _explicitOverride, options) => {
            observedNonSteamOpts.push({
              priority: options?.priority,
              synopsisOnly: options?.synopsisOnly,
            });
            activeInFlight += 1;
            peakInFlight = Math.max(peakInFlight, activeInFlight);
            const idxMatch = /(\d+)$/.exec(game.platforms[0]?.platformGameId ?? '');
            const idx = idxMatch ? Number(idxMatch[1]) : 8;
            await delay(idx % 2 === 0 ? 2 : 25);
            activeInFlight -= 1;
            completedProbes += 1;

            if (emptyIndices.has(idx)) {
              return { shortDescription: '' } as unknown as SteamEnrichedMetadata;
            }
            return {
              shortDescription: `Resolved storefront synopsis for synthetic item ${idx + 1}.`,
              developers: ['Synthetic Non-Steam Dev'],
              releaseDate: '2023',
            } as unknown as SteamEnrichedMetadata;
          });

        const singleUpdateSpy = vi.fn();
        const batchedSnapshots: CanonicalGame[][] = [];
        let catalogAfterProbes = [...games];

        const onGamesBatchUpdated = vi.fn((updatedBatch: CanonicalGame[]) => {
          batchedSnapshots.push(updatedBatch);
          const byId = new Map(updatedBatch.map((g) => [g.id, g]));
          catalogAfterProbes = catalogAfterProbes.map((g) => byId.get(g.id) ?? g);
        });

        const root = createClientComponentRoot(LibraryMatchManagerModal, {
          isOpen: true,
          games,
          onClose: () => {},
          onFixMatchForGame: () => {},
          onGameUpdated: singleUpdateSpy,
          onGamesBatchUpdated,
        });

        try {
          const deadline = Date.now() + 2_500;
          while (completedProbes < 16 && Date.now() < deadline) {
            await delay(10);
          }

          expect(completedProbes).toBe(16);
          expect(peakInFlight).toBeLessThanOrEqual(2);
          expect(peakInFlight).toBe(2);
          expect(steamSpy).toHaveBeenCalledTimes(8);
          expect(nonSteamSpy).toHaveBeenCalledTimes(8);

          expect(
            observedSteamPriorities.every((p) => p === RequestPriority.P2_BACKGROUND)
          ).toBe(true);
          expect(
            observedNonSteamOpts.every(
              (o) => o.priority === RequestPriority.P2_BACKGROUND && o.synopsisOnly === true
            )
          ).toBe(true);

          // Closing the modal flushes any pending throttled batch updates immediately
          root.rerender({ isOpen: false });

          expect(singleUpdateSpy).toHaveBeenCalledTimes(0);
          expect(onGamesBatchUpdated).toHaveBeenCalled();
          expect(batchedSnapshots.length).toBeLessThanOrEqual(3);

          const totalResolvedGames = catalogAfterProbes.filter(
            (g) => Boolean(g.shortDescription && g.shortDescription.trim().length > 0)
          );
          expect(totalResolvedGames.length).toBe(12);

          // Verify durable negative cache recorded all 4 empty-synopsis games in localStorage
          for (const emptyIdx of emptyIndices) {
            expect(hasDurableEmptySynopsisProbe(games[emptyIdx].id)).toBe(true);
          }
          const rawNegativeCache = memoryStorage.getItem(STORAGE_KEY_EMPTY_SYNOPSIS_PROBES);
          expect(rawNegativeCache).toBeTruthy();

          // Re-open Match Studio with updated catalog + durable negative cache -> ZERO repeat probes!
          steamSpy.mockClear();
          nonSteamSpy.mockClear();
          root.rerender({
            isOpen: true,
            games: catalogAfterProbes,
          });
          await delay(40);
          expect(steamSpy).toHaveBeenCalledTimes(0);
          expect(nonSteamSpy).toHaveBeenCalledTimes(0);

          // Clearing a single game from the negative cache removes only that game's entry
          const clearedId = games[3].id;
          clearDurableEmptySynopsisProbe(clearedId);
          expect(hasDurableEmptySynopsisProbe(clearedId)).toBe(false);
          expect(hasDurableEmptySynopsisProbe(games[7].id)).toBe(true);
        } finally {
          root.unmount();
        }
      }
    );
  });

  // ==========================================================================
  // 3. O(1) Memoized getSuppressedCatalogEntries, Key Hygiene & Scaling
  // ==========================================================================
  describe('3. O(1) Memoized getSuppressedCatalogEntries, Key Hygiene & Scaling', () => {
    it('memoizes 500 suppressed + 100 hidden + 200 overrides in O(1) with <= 1 JSON.parse across 50 reads and invalidates cleanly', () => {
      // Seed 500 synthetic persisted suppressed entries directly into localStorage
      const initial500 = Array.from({ length: 500 }, (_, i) => ({
        id: `steam-${800000 + i}`,
        platformId: 'steam' as StorefrontId,
        platformGameId: String(800000 + i),
        rawTitle: `Synthetic Soundtrack Bonus ${i + 1}`,
        reason: 'Filtered non-game soundtrack entry',
        reasonCategory: 'non_game_filter' as const,
        suppressedAt: 1_700_000_000_000 + i,
      }));
      memoryStorage.setItem(STORAGE_KEY_SUPPRESSED_ENTRIES, JSON.stringify(initial500));

      // Populate 100 hidden entries and 200 user overrides
      for (let i = 0; i < 100; i++) {
        const g = makeSyntheticGame(5000 + i, {
          id: `gog-hidden-${i}`,
          platforms: [
            {
              platformId: 'gog',
              platformGameId: `hidden-${i}`,
              originalTitle: `Synthetic Hidden Quest ${i}`,
              installed: false,
            },
          ],
        });
        hideStorefrontEntry(g, 'gog', 'User hidden in synthetic test');
      }
      for (let i = 0; i < 200; i++) {
        saveUserOverride({
          gameId: `epic-ovr-${i}`,
          platformId: 'epic',
          platformGameId: `ovr-${i}`,
          matchedStore: 'epic',
          title: `Synthetic Override Title ${i}`,
          updatedAt: '2026-10-01T00:00:00.000Z',
        });
      }

      getReadonlyRestoredNonGameKeys();

      const parseSpy = vi.spyOn(JSON, 'parse');
      let firstResult: SuppressedCatalogEntry[] | null = null;
      for (let readIdx = 0; readIdx < 50; readIdx++) {
        const res = getSuppressedCatalogEntries();
        if (readIdx === 0) {
          firstResult = res;
        } else {
          expect(res).toBe(firstResult);
        }
      }

      expect(firstResult).not.toBeNull();
      // 500 auto-suppressed + 100 user-hidden = 600 total suppressed catalog entries
      expect(firstResult!.length).toBe(600);
      expect(parseSpy.mock.calls.length).toBeLessThanOrEqual(1);

      // Subsequent 50 reads hit 0 JSON.parse invocations!
      parseSpy.mockClear();
      for (let readIdx = 0; readIdx < 50; readIdx++) {
        expect(getSuppressedCatalogEntries()).toBe(firstResult);
      }
      expect(parseSpy).toHaveBeenCalledTimes(0);

      // Mutating via registerSuppressedCatalogEntries invalidates memo immediately without stale reads
      registerSuppressedCatalogEntries([
        {
          id: 'xbox-9P7777',
          platformId: 'xbox',
          platformGameId: '9P7777',
          rawTitle: 'Synthetic Artbook Companion',
          reason: 'Digital Artbook',
          reasonCategory: 'non_game_filter',
          suppressedAt: 1_700_000_999_000,
          rawGame: makeSyntheticGame(9777, { id: 'xbox-9P7777', title: 'Synthetic Artbook Companion' }),
        },
      ]);
      const afterRegister = getSuppressedCatalogEntries();
      expect(afterRegister.length).toBe(601);
      expect(afterRegister.some((e) => e.id === 'xbox-9P7777')).toBe(true);

      // Restoring via unhideStorefrontEntry removes the restored non-game from active suppressed list immediately
      unhideStorefrontEntry('xbox-9P7777', 'xbox', '9P7777');
      const afterUnhide = getSuppressedCatalogEntries();
      expect(afterUnhide.some((e) => e.id === 'xbox-9P7777')).toBe(false);
    });

    it('enforces strict restored-key hygiene and never pollutes getReadonlyRestoredNonGameKeys with bare storefront IDs', () => {
      unhideStorefrontEntry('steam-400', 'steam', '400');
      unhideStorefrontEntry('gog-900', 'gog', '900');
      unhideStorefrontEntry('epic-700', 'epic', '700');
      unhideStorefrontEntry('xbox-9P0001', 'xbox', '9P0001');

      // Edge-case inputs: bare keyOrGameId, empty platformGameId, and saveUserOverride without platformGameId
      unhideStorefrontEntry('steam', 'steam', '');
      unhideStorefrontEntry('', 'xbox', '');
      saveUserOverride({
        gameId: 'steam-400',
        platformId: 'steam',
        matchedStore: 'steam',
        title: 'Synthetic Clean Override',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });

      const restored = getReadonlyRestoredNonGameKeys();
      expect(restored.has('steam-400')).toBe(true);
      expect(restored.has('steam:400')).toBe(true);
      expect(restored.has('game:steam-400')).toBe(true);

      for (const bare of ['steam', 'gog', 'epic', 'xbox', 'custom']) {
        expect(restored.has(bare)).toBe(false);
      }

      // Legacy corrupted storage defense-in-depth check
      memoryStorage.setItem(
        STORAGE_KEY_RESTORED_NON_GAMES,
        JSON.stringify(['steam', 'gog', 'epic', 'xbox', 'custom', 'steam:400'])
      );
      const sanitizedRead = getReadonlyRestoredNonGameKeys();
      expect(sanitizedRead.has('steam:400')).toBe(true);
      for (const bare of ['steam', 'gog', 'epic', 'xbox', 'custom']) {
        expect(sanitizedRead.has(bare)).toBe(false);
      }
    });
  });

  // ==========================================================================
  // 4. Event Storm Isolation, stagedCacheService >2KB Vault & Steam Digest
  // ==========================================================================
  describe('4. Event Storm Isolation, >2KB IndexedDB Vault Round-Trip & SteamApiService Digest Retention', () => {
    it('isolates non-game confirm/unconfirm events from criticScoreService.handleUserOverride and catalog re-sanitization storms', () => {
      criticScoreService.initEventListeners();
      const handleOverrideSpy = vi
        .spyOn(criticScoreService, 'handleUserOverride')
        .mockImplementation(() => {});
      const sanitizeSpy = vi.spyOn(catalogSanitizerModule, 'sanitizeGameCatalog');
      const setGamesSpy = vi.fn();

      const sampleCatalog = [
        makeSyntheticGame(1, { id: 'steam-99001', steamAppId: 99001 }),
        makeSyntheticGame(2, { id: 'steam-99002', steamAppId: 99002 }),
      ];

      function SyncHookHarness() {
        useCatalogOverrideSync({
          selectedGame: null,
          isGridView: true,
          navigateHome: () => {},
          setGames: setGamesSpy,
          setGameRefreshKey: () => {},
          showSyncNotice: () => {},
        });
        return null;
      }

      const root = createClientComponentRoot(SyncHookHarness, {});
      try {
        handleOverrideSpy.mockClear();
        sanitizeSpy.mockClear();
        setGamesSpy.mockClear();

        confirmMultipleNonGameStorefrontEntries(
          Array.from({ length: 25 }, (_, i) => ({
            platformId: 'steam' as StorefrontId,
            platformGameId: String(77000 + i),
            gameId: `steam-${77000 + i}`,
          }))
        );
        confirmNonGameStorefrontEntry('steam', '77099', 'steam-77099');
        unconfirmNonGameStorefrontEntry('steam', '77099', 'steam-77099');

        expect(handleOverrideSpy).toHaveBeenCalledTimes(0);
        expect(sanitizeSpy).toHaveBeenCalledTimes(0);
        expect(setGamesSpy).toHaveBeenCalledTimes(0);

        // Positive control: a genuine game override STILL invokes handleUserOverride & targeted catalog update
        saveUserOverride({
          gameId: sampleCatalog[1].id,
          platformId: 'steam',
          platformGameId: '99002',
          matchedStore: 'steam',
          title: 'Synthetic Control Override Title',
          updatedAt: '2026-10-01T00:00:00.000Z',
        });
        expect(handleOverrideSpy).toHaveBeenCalledTimes(1);
        expect(setGamesSpy).toHaveBeenCalledTimes(1);
      } finally {
        root.unmount();
      }
    });

    it('round-trips 100 >2KB (~3.2KB) metadata payloads through stagedCacheService IndexedDB bulk vault at 100% full-payload hit rate', async () => {
      const totalItems = 100;
      const paddingParagraph =
        'Synthetic high-resolution lore and storefront metadata block. '.repeat(52); // ~3.2 KB > 2048 B

      for (let i = 0; i < totalItems; i++) {
        const key = `antigravity_staged_synthetic_bulk_${i}`;
        saveStagedCache(
          key,
          {
            id: `syn-vault-${i}`,
            title: `Synthetic Vault Entry ${i}`,
            shortDescription: `Compact blurb ${i}`,
            detailedDescription: `${paddingParagraph} [item=${i}]`,
          },
          'mature'
        );
      }

      // Verify localStorage stores a compact < 512 B stub rather than the full 3.2 KB payload
      const rawStub0 = memoryStorage.getItem('antigravity_staged_synthetic_bulk_0');
      expect(rawStub0).toBeTruthy();
      expect(rawStub0!.length).toBeLessThan(600);
      expect(rawStub0).not.toContain('[item=0]');

      // Allow microtask-queued IndexedDB `put` transactions to complete
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Simulate cold app reload: clear in-memory fallback map
      clearStagedMemoryFallback();
      const beforeHydrate = loadStagedCache<{ detailedDescription?: string }>(
        'antigravity_staged_synthetic_bulk_0'
      );
      expect(beforeHydrate.data?.detailedDescription ?? '').not.toContain('[item=0]');

      // Bulk-hydrate all >2KB staged cache entries from IndexedDB vault in one cursor scan
      const hydratedCount = await hydrateAllStagedCacheFromVault();
      expect(hydratedCount).toBe(100);

      let fullHits = 0;
      for (let i = 0; i < totalItems; i++) {
        const loaded = loadStagedCache<{
          id: string;
          title: string;
          detailedDescription: string;
        }>(`antigravity_staged_synthetic_bulk_${i}`);
        if (
          loaded.valid &&
          loaded.data?.id === `syn-vault-${i}` &&
          loaded.data.detailedDescription.length > 3000 &&
          loaded.data.detailedDescription.endsWith(`[item=${i}]`)
        ) {
          fullHits += 1;
        }
      }
      expect(fullHits).toBe(100);
    });

    it('retains O(1) lightweight synopsis/dev/year digest in SteamApiService after heavy LRU eviction and trimMemoryCache', () => {
      const svc = new SteamApiService();
      const internalSvc = svc as unknown as {
        metadataCache: Map<number, SteamEnrichedMetadata>;
        setCacheEntry: (appId: number, data: SteamEnrichedMetadata) => void;
      };

      for (let appId = 1; appId <= 90; appId++) {
        internalSvc.setCacheEntry(appId, {
          appId,
          name: `Synthetic Steam Title ${appId}`,
          shortDescription: `Lightweight digest synopsis for synthetic app ${appId}.`,
          detailedDescription: '<p>Heavy HTML description '.repeat(80) + '</p>',
          aboutTheGame: '<p>Heavy about block</p>',
          headerImage: `https://cdn.synthetic.invalid/steam/${appId}/header.jpg`,
          capsuleImage: `https://cdn.synthetic.invalid/steam/${appId}/capsule_600x900.jpg`,
          developers: [`Synthetic Dev ${appId}`],
          publishers: ['Synthetic Publisher'],
          genres: ['RPG', 'Strategy'],
          tags: ['Singleplayer'],
          categories: [{ id: 2, description: 'Single-player' }],
          releaseDate: '14 Oct, 2022',
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 90,
            totalNegative: 10,
            totalReviews: 100,
            positivePercent: 90,
          },
          screenshots: [
            {
              id: 1,
              pathThumbnail: 'https://cdn.synthetic.invalid/s1_thumb.jpg',
              pathFull: 'https://cdn.synthetic.invalid/s1_full.jpg',
            },
          ],
          movies: [
            {
              id: 10,
              name: 'Synthetic Trailer',
              thumbnail: 'https://cdn.synthetic.invalid/m1.jpg',
              webm: {
                480: 'https://cdn.synthetic.invalid/m1.webm',
                max: 'https://cdn.synthetic.invalid/m1.webm',
              },
            },
          ],
        });
      }

      expect(internalSvc.metadataCache.size).toBe(60);
      svc.trimMemoryCache(30);
      expect(internalSvc.metadataCache.size).toBe(30);
      expect(internalSvc.metadataCache.has(1)).toBe(false);

      const digestHit = svc.getCachedMetadata(1);
      expect(digestHit).not.toBeNull();
      expect(digestHit?.shortDescription).toBe(
        'Lightweight digest synopsis for synthetic app 1.'
      );
      expect(digestHit?.developers).toEqual(['Synthetic Dev 1']);
      expect(digestHit?.releaseDate).toBe('14 Oct, 2022');
      expect(digestHit?.screenshots).toEqual([]);
      expect(digestHit?.movies).toEqual([]);
      expect(digestHit?.detailedDescription).toBe('');
    });
  });

  // ==========================================================================
  // 5. Interactive Modal Preemption & Incremental Dirty-Slice Persistence
  // ==========================================================================
  describe('5. Interactive Modal Preemption & Incremental Dirty-Slice Persistence', () => {
    it('pauses active store_media warmup and buffers setGames while isModalSuspended === true, then resumes and flushes once on close', async () => {
      vi.useFakeTimers();
      (window as unknown as Record<string, unknown>).__ENABLE_AUTO_STORE_MEDIA_WARMUP__ = true;

      let jobState: SyncJobState | null = null;
      let capturedOnGameUpdated: ((g: CanonicalGame) => void) | null = null;
      let resolveWarmupRun: (() => void) | undefined;

      vi.spyOn(launcherService, 'isInGameHibernating').mockReturnValue(false);
      vi.spyOn(syncJobManager, 'getState').mockImplementation(() => jobState);
      vi.spyOn(syncJobManager, 'subscribe').mockImplementation((cb) => {
        cb(jobState);
        return () => {};
      });
      const pauseSpy = vi.spyOn(syncJobManager, 'pauseJob').mockImplementation((id: string) => {
        if (jobState && jobState.id === id) {
          jobState = { ...jobState, status: 'paused' };
        }
      });
      const resumeSpy = vi.spyOn(syncJobManager, 'resumeJob').mockImplementation((id: string) => {
        if (jobState && jobState.id === id) {
          jobState = { ...jobState, status: 'running' };
        }
      });
      vi.spyOn(syncJobManager, 'startStoreMediaSync').mockImplementation(
        (_games, onGameUpdated) => {
          jobState = {
            id: 'job-store-media-1',
            type: 'store_media',
            title: 'Syncing Store Media',
            total: 10,
            current: 2,
            status: 'running',
          };
          capturedOnGameUpdated = onGameUpdated ?? null;
          return new Promise<void>((resolve) => {
            resolveWarmupRun = resolve;
          });
        }
      );

      let catalogState: CanonicalGame[] = [
        makeSyntheticGame(1, { id: 'syn-1', shortDescription: '', enrichedMetadata: undefined }),
        makeSyntheticGame(2, { id: 'syn-2', shortDescription: '', enrichedMetadata: undefined }),
        makeSyntheticGame(3, { id: 'syn-3', shortDescription: '', enrichedMetadata: undefined }),
      ];
      const gamesRef = { current: catalogState };

      const setGamesSpy = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        catalogState = typeof updater === 'function' ? updater(catalogState) : updater;
        gamesRef.current = catalogState;
      });
      const setIsSyncingAllMediaSpy = vi.fn();

      function WarmupHarness(props: { games: CanonicalGame[]; suspended: boolean }) {
        useBackgroundMediaWarmup({
          games: props.games,
          gamesRef,
          isHibernating: false,
          runningGamesCount: 0,
          isModalSuspended: props.suspended,
          setGames: setGamesSpy,
          setIsSyncingAllMedia: setIsSyncingAllMediaSpy,
        });
        return null;
      }

      const root = createClientComponentRoot(WarmupHarness, {
        games: catalogState,
        suspended: false,
      });

      try {
        // Advance past the 6000ms polite warmup delay + dynamic import microtasks
        await vi.advanceTimersByTimeAsync(6_100);
        expect(capturedOnGameUpdated).not.toBeNull();

        // Open interactive modal -> suspends warmup immediately!
        root.rerender({ games: catalogState, suspended: true });
        await vi.advanceTimersByTimeAsync(20);
        expect(pauseSpy).toHaveBeenCalledWith('job-store-media-1');

        // Emit 3 background game updates while modal is open -> MUST buffer, ZERO setGames calls!
        setGamesSpy.mockClear();
        capturedOnGameUpdated!(
          makeSyntheticGame(1, { id: 'syn-1', shortDescription: 'Warmup Synopsis 1' })
        );
        capturedOnGameUpdated!(
          makeSyntheticGame(2, { id: 'syn-2', shortDescription: 'Warmup Synopsis 2' })
        );
        capturedOnGameUpdated!(
          makeSyntheticGame(3, { id: 'syn-3', shortDescription: 'Warmup Synopsis 3' })
        );
        await vi.advanceTimersByTimeAsync(3_000);
        expect(setGamesSpy).toHaveBeenCalledTimes(0);

        // Close interactive modal -> resumes job AND flushes all 3 buffered updates in 1 single batch!
        root.rerender({ games: catalogState, suspended: false });
        await vi.advanceTimersByTimeAsync(20);
        expect(resumeSpy).toHaveBeenCalledWith('job-store-media-1');
        expect(setGamesSpy).toHaveBeenCalledTimes(1);
        expect(catalogState.map((g) => g.shortDescription)).toEqual([
          'Warmup Synopsis 1',
          'Warmup Synopsis 2',
          'Warmup Synopsis 3',
        ]);
      } finally {
          resolveWarmupRun?.();
        root.unmount();
        vi.useRealTimers();
      }
    });

    it('sends ONLY dirtyGameIds slice (length === 1) to offlineVault.upsertGames on incremental saveCurrentCatalog', () => {
      const upsertSpy = vi.fn().mockResolvedValue({ ok: true });
      const removeSpy = vi.fn().mockResolvedValue({ ok: true });
      setupBrowserAndPlatformGlobals('darwin', memoryStorage, {
        offlineVault: {
          upsertGames: upsertSpy,
          removeGames: removeSpy,
          loadCatalog: vi.fn().mockResolvedValue([]),
        },
      });

      const fiftyGames = Array.from({ length: 50 }, (_, idx) =>
        makeSyntheticGame(idx + 1, { id: `g-${idx + 1}` })
      );

      saveCurrentCatalog(fiftyGames, {
        skipSanitize: true,
        dirtyGameIds: ['g-2'],
        immediate: true,
      });

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const upsertedSlice = upsertSpy.mock.calls[0][0] as CanonicalGame[];
      expect(Array.isArray(upsertedSlice)).toBe(true);
      expect(upsertedSlice).toHaveLength(1);
      expect(upsertedSlice[0].id).toBe('g-2');
      expect(removeSpy).toHaveBeenCalledTimes(0);
    });
  });

  // ==========================================================================
  // 6. Universal Portability, Dual-OS Entitlement Badges & WCAG 2.2 AA
  // ==========================================================================
  describe('6. Universal Portability, Dual-OS Entitlement Badges & WCAG 2.2 AA Semantics', () => {
    it('classifies auto-filtered sub-categories purely by generic tokens without false-positive "Score" matches or hardcoded game IDs', () => {
      const mkEntry = (
        rawTitle: string,
        reasonCategory: SuppressedCatalogEntry['reasonCategory'] = 'non_game_filter',
        reason = 'Filtered non-game item'
      ): SuppressedCatalogEntry => ({
        id: 'steam-999001',
        platformId: 'steam',
        platformGameId: '999001',
        rawTitle,
        reasonCategory,
        reason,
        suppressedAt: 1_700_000_000_000,
        rawGame: makeSyntheticGame(999, { id: 'steam-999001', title: rawTitle }),
      });

      expect(classifyAutoFilteredSubCategory(mkEntry('Synthetic Quest - Original Score'))).toBe(
        'soundtrack'
      );
      expect(classifyAutoFilteredSubCategory(mkEntry('Synthetic Quest Official OST'))).toBe(
        'soundtrack'
      );
      expect(classifyAutoFilteredSubCategory(mkEntry('Score Attack Playable Teaser'))).toBe(
        'prologue'
      );
      expect(
        classifyAutoFilteredSubCategory(
          mkEntry(
            'Synthetic Indie Action',
            'score_suppressed',
            'Score suppressed due to insufficient critic reviews'
          )
        )
      ).toBe('beta');

      const diagSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../src/components/Library/MatchManager/matchManagerDiagnostics.ts'
        ),
        'utf8'
      );
      const modalSource = fs.readFileSync(
        path.resolve(__dirname, '../src/components/Library/LibraryMatchManagerModal.tsx'),
        'utf8'
      );
      expect(diagSource).not.toMatch(/steamAppId\s*===\s*\d{3,}/);
      expect(modalSource).not.toMatch(/steamAppId\s*===\s*\d{3,}/);
    });

    it('renders macOS Native & Bottled (Wine/CrossOver) badges on darwin and Windows Native badge on win32', () => {
      const mergedDarwinGame = makeSyntheticGame(701, {
        id: 'merged-synthetic-701',
        title: 'Synthetic Cross-Storefront Odyssey',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '970100',
            originalTitle: 'Synthetic Cross-Storefront Odyssey',
            installed: true,
            installPath: '/Applications/SyntheticOdyssey.app',
            isWindowsBinaryOnMac: false,
          },
          {
            platformId: 'gog',
            platformGameId: 'gog-970100',
            originalTitle: 'Synthetic Cross-Storefront Odyssey',
            installed: true,
            executablePath:
              '/Users/testuser/Library/Application Support/CrossOver/Bottles/WinGames/drive_c/Games/SyntheticOdyssey/game.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
      });

      setupBrowserAndPlatformGlobals('darwin', memoryStorage);
      const darwinRoot = createClientComponentRoot(LibraryMatchManagerModal, {
        isOpen: true,
        games: [mergedDarwinGame],
        initialTab: 'merged',
        onClose: () => {},
        onFixMatchForGame: () => {},
      });
      try {
        const darwinHtml = darwinRoot.getHtml();
        expect(darwinHtml).toContain('macOS Native');
        expect(darwinHtml).toContain('Bottled (Wine/CrossOver)');
        expect(darwinHtml).not.toContain('Windows Native');
      } finally {
        darwinRoot.unmount();
      }

      const mergedWin32Game = makeSyntheticGame(702, {
        id: 'merged-synthetic-702',
        title: 'Synthetic Dual Storefront Saga',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '970200',
            originalTitle: 'Synthetic Dual Storefront Saga',
            installed: true,
            installPath: 'C:\\Games\\SyntheticSaga\\Saga.exe',
          },
          {
            platformId: 'epic',
            platformGameId: 'epic-970200',
            originalTitle: 'Synthetic Dual Storefront Saga',
            installed: false,
          },
        ],
      });

      setupBrowserAndPlatformGlobals('win32', memoryStorage);
      const winRoot = createClientComponentRoot(LibraryMatchManagerModal, {
        isOpen: true,
        games: [mergedWin32Game],
        initialTab: 'merged',
        onClose: () => {},
        onFixMatchForGame: () => {},
      });
      try {
        const winHtml = winRoot.getHtml();
        expect(winHtml).toContain('Windows Native');
        expect(winHtml).not.toContain('macOS Native');
        expect(winHtml).not.toContain('Bottled (Wine/CrossOver)');
      } finally {
        winRoot.unmount();
      }
    });

    it('satisfies WCAG 2.2 AA semantics across LibraryMatchManagerModal and FixMatchWizardModal (landmarks, roving tabs, heading hierarchy)', async () => {
      setupBrowserAndPlatformGlobals('darwin', memoryStorage);
      const unmatchedSynthetic = makeSyntheticGame(801, {
        id: 'syn-unmatched-801',
        title: 'Synthetic Unmatched Relic',
        capsuleImage: '',
      });

      const studioRoot = createClientComponentRoot(LibraryMatchManagerModal, {
        isOpen: true,
        games: [unmatchedSynthetic],
        onClose: () => {},
        onFixMatchForGame: () => {},
      });

      try {
        const doc = parseHtmlDocument(studioRoot.getHtml());

        // <dialog> aria-labelledby points to <h2> title
        const dialog = doc.querySelector('dialog[aria-labelledby]');
        expect(dialog).not.toBeNull();
        const titleId = dialog!.getAttribute('aria-labelledby')!;
        const h2 = doc.getElementById(titleId);
        expect(h2?.tagName).toBe('H2');

        // <search> landmark wraps <input type="search" autofocus> with associated <label for="...">
        const searchLandmark = doc.querySelector('search');
        expect(searchLandmark).not.toBeNull();
        const searchInput = searchLandmark!.querySelector('input[type="search"]');
        expect(searchInput).not.toBeNull();
        expect(searchInput!.hasAttribute('autofocus')).toBe(true);
        const searchInputId = searchInput!.getAttribute('id')!;
        expect(searchInputId.length).toBeGreaterThan(0);
        const searchLabel = searchLandmark!.querySelector(`label[for="${searchInputId}"]`);
        expect(searchLabel).not.toBeNull();

        // WAI-ARIA tablist -> 5 tabs with roving tabindex & aria-controls <-> tabpanel id linkage
        const tablist = doc.querySelector('[role="tablist"]');
        expect(tablist).not.toBeNull();
        const tabs = Array.from(tablist!.querySelectorAll('[role="tab"]'));
        expect(tabs).toHaveLength(5);
        const selectedTabs = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
        expect(selectedTabs).toHaveLength(1);
        expect(selectedTabs[0].getAttribute('tabindex')).toBe('0');
        for (const inactive of tabs.filter((t) => t.getAttribute('aria-selected') !== 'true')) {
          expect(inactive.getAttribute('tabindex')).toBe('-1');
        }

        const tabPanel = doc.querySelector('[role="tabpanel"]');
        expect(tabPanel).not.toBeNull();
        expect(selectedTabs[0].getAttribute('aria-controls')).toBe(tabPanel!.getAttribute('id'));
        expect(tabPanel!.getAttribute('aria-labelledby')).toBe(selectedTabs[0].getAttribute('id'));

        // Keyboard ArrowRight roving navigation on role="tablist" moves active tab & roves focus!
        const tablistVNode = studioRoot
          .getElements()
          .find((el) => el.tag === 'div' && el.props.role === 'tablist');
        expect(tablistVNode).toBeDefined();
        const focusSpy = vi.fn();
        const onKeyDown = tablistVNode!.props.onKeyDown as (ev: {
          key: string;
          preventDefault: () => void;
          currentTarget: { querySelector: (sel: string) => { focus: () => void } };
        }) => void;
        onKeyDown({
          key: 'ArrowRight',
          preventDefault: () => {},
          currentTarget: { querySelector: () => ({ focus: focusSpy }) },
        });
        expect(focusSpy).toHaveBeenCalledTimes(1);
        studioRoot.rerender();

        const docAfterArrow = parseHtmlDocument(studioRoot.getHtml());
        const newActiveTab = docAfterArrow.querySelector('[role="tab"][aria-selected="true"]');
        expect(newActiveTab).not.toBeNull();
        expect(newActiveTab?.getAttribute('id')).not.toBe(selectedTabs[0].getAttribute('id'));

        // Section disclosure header uses <h3><button aria-expanded="true|false">
        const sectionHeadingBtn = docAfterArrow
          .querySelectorAll('h3')
          .map((h) => h.querySelector('button[aria-expanded]'))
          .find((btn) => btn !== null);
        expect(sectionHeadingBtn).toBeDefined();
      } finally {
        studioRoot.unmount();
      }

      // FixMatchWizardModal heading hierarchy: <h2> dialog title -> <h3> candidate cards (no h2 -> h4 skip)
      const syntheticCandidates: SearchMatchCandidate[] = [
        {
          id: 'steam-980100',
          source: 'steam',
          title: 'Synthetic Unmatched Relic: Director Cut',
          year: '2024',
          capsuleImage: 'https://cdn.synthetic.invalid/relic-2x3.jpg',
          confidenceScore: 96,
          steamAppId: 980100,
        },
      ];
      vi.spyOn(metadataScraperService, 'getSuggestedMatches').mockResolvedValue(syntheticCandidates);

      const wizardRoot = createClientComponentRoot(FixMatchWizardModal, {
        isOpen: true,
        game: unmatchedSynthetic,
        onClose: () => {},
        onApplyOverride: () => {},
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        wizardRoot.rerender();
        const wizDoc = parseHtmlDocument(wizardRoot.getHtml());
        const wizDialog = wizDoc.querySelector('dialog[aria-labelledby]');
        expect(wizDialog).not.toBeNull();
        const wizTitle = wizDoc.getElementById(wizDialog!.getAttribute('aria-labelledby')!);
        expect(wizTitle?.tagName).toBe('H2');

        expect(wizDoc.querySelector('[aria-current="step"]')).not.toBeNull();

        const h3Titles = Array.from(wizDoc.querySelectorAll('h3')).map((el) =>
          el.textContent?.trim()
        );
        expect(h3Titles).toContain('Synthetic Unmatched Relic: Director Cut');
        expect(wizDoc.querySelectorAll('h4').length).toBe(0);
      } finally {
        wizardRoot.unmount();
      }
    });
  });
});
