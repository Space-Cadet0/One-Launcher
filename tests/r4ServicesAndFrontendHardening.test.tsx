import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

import { makeCanonicalGame, makeSteamEnrichedMetadata, makeUserGameOverride } from './helpers/factories';
import { TestDOMParser, ParsedDomElementNode, ParsedDomTextNode } from './helpers/domParserHelper';

import type { CanonicalGame, StoreAchievementSummary } from '../src/contracts/game';
import type { CriticScoreData } from '../src/contracts/critic';
import type { GameCollection } from '../src/contracts/collection';
import type { StorefrontId } from '../src/contracts/platform';
import type { SteamMovie, SteamScreenshot } from '../src/contracts/steam';
import type { MultiStoreAchievementsMap, StorefrontAchievementsData } from '../src/contracts/achievement';
import type { ElectronAPI } from '../src/types/electron';

// ---------------------------------------------------------------------------
// Hoisted Headless DOM, Storage & IndexedDB Vault Harness
// ---------------------------------------------------------------------------
const testEnv = vi.hoisted(() => {
  class MockStorage implements Storage {
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

  const localStorageMock = new MockStorage();
  const idbStore = new Map<string, unknown>();
  let customVaultGetHandler: ((key: string) => Promise<unknown> | undefined) | null = null;

  const eventTarget = new EventTarget();
  const docElementAttrs = new Map<string, string>();
  const rootElementAttrs = new Map<string, string>();
  let openDialogSelectorCount = 0;

  const rootElement = {
    id: 'root',
    setAttribute: vi.fn((name: string, value: string) => {
      rootElementAttrs.set(name, String(value));
    }),
    getAttribute: vi.fn((name: string) => rootElementAttrs.get(name) ?? null),
    hasAttribute: vi.fn((name: string) => rootElementAttrs.has(name)),
    removeAttribute: vi.fn((name: string) => {
      rootElementAttrs.delete(name);
    }),
  };

  const documentElement = {
    setAttribute: vi.fn((name: string, value: string) => {
      docElementAttrs.set(name, String(value));
    }),
    getAttribute: vi.fn((name: string) => docElementAttrs.get(name) ?? null),
    hasAttribute: vi.fn((name: string) => docElementAttrs.has(name)),
    removeAttribute: vi.fn((name: string) => {
      docElementAttrs.delete(name);
    }),
  };

  const windowObj: Record<string, unknown> = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    localStorage: localStorageMock,
    location: { hostname: 'example.invalid', origin: 'https://example.invalid', protocol: 'https:' },
    navigator: { onLine: true, userAgent: 'NodeVitest/1.0' },
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    open: vi.fn(),
  };

  const documentObj: Record<string, unknown> = {
    hidden: false,
    documentElement,
    body: {},
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    getElementById: (id: string) => (id === 'root' ? rootElement : null),
    querySelectorAll: (selector: string) => {
      if (selector.includes('dialog[open]') || selector.includes('data-modal-shell')) {
        return Array.from({ length: openDialogSelectorCount }, () => ({}));
      }
      return [];
    },
  };

  const g = globalThis as Record<string, unknown>;
  g.localStorage = localStorageMock;
  g.window = windowObj;
  g.document = documentObj;
  if (typeof g.requestAnimationFrame === 'undefined') {
    g.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }

  return {
    localStorageMock,
    idbStore,
    windowObj,
    documentObj,
    rootElement,
    rootElementAttrs,
    documentElement,
    docElementAttrs,
    setOpenDialogCount(count: number) {
      openDialogSelectorCount = count;
    },
    setCustomVaultGetHandler(fn: ((key: string) => Promise<unknown> | undefined) | null) {
      customVaultGetHandler = fn;
    },
    getCustomVaultGetHandler() {
      return customVaultGetHandler;
    },
    resetDomFlags() {
      docElementAttrs.clear();
      rootElementAttrs.clear();
      openDialogSelectorCount = 0;
      rootElement.setAttribute.mockClear();
      rootElement.removeAttribute.mockClear();
      documentElement.setAttribute.mockClear();
      documentElement.removeAttribute.mockClear();
    },
  };
});

vi.mock('../src/services/storage/indexedDbVault', () => ({
  isIndexedDbAvailable: vi.fn(() => true),
  vaultGet: vi.fn(async <T,>(key: string): Promise<T | undefined> => {
    const custom = testEnv.getCustomVaultGetHandler();
    if (custom) {
      const intercepted = custom(key);
      if (intercepted !== undefined) {
        return (await intercepted) as T | undefined;
      }
    }
    if (!testEnv.idbStore.has(key)) return undefined;
    return structuredClone(testEnv.idbStore.get(key)) as T;
  }),
  vaultSet: vi.fn(async <T,>(key: string, value: T): Promise<boolean> => {
    testEnv.idbStore.set(key, structuredClone(value));
    return true;
  }),
  vaultDelete: vi.fn(async (key: string): Promise<boolean> => {
    testEnv.idbStore.delete(key);
    return true;
  }),
  vaultEntries: vi.fn(async <K extends IDBValidKey = IDBValidKey, V = unknown>(): Promise<Array<[K, V]>> => {
    return Array.from(testEnv.idbStore.entries()).map(([k, v]) => [k as K, structuredClone(v) as V]);
  }),
}));

import * as indexedDbVault from '../src/services/storage/indexedDbVault';
import { gogIntegration } from '../src/services/integrations/gogIntegration';
import { epicIntegration } from '../src/services/integrations/epicIntegration';
import { steamIntegration } from '../src/services/integrations/steamIntegration';
import { xboxIntegration } from '../src/services/integrations/xboxIntegration';
import { mergeStorefrontGames } from '../src/services/integrations/catalog/catalogMerger';
import * as integrationStorageModule from '../src/services/integrations/integrationStorage';
import { achievementDetailService } from '../src/services/achievements/achievementDetailService';
import { GameAchievementsModal } from '../src/components/Achievements/GameAchievementsModal';
import {
  achievementSummaryStore,
  STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC,
} from '../src/services/storage/achievementSummaryStore';
import {
  cacheUserSteamAchievements,
  getKnownSteamAchievements,
} from '../src/services/storage/knownGameAchievements';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import {
  extractTrailingDelimitedReleaseYear,
  isIntermediateNumeralSubtitleMatch,
  isSequelMismatch,
  stripTrailingDelimitedReleaseYear,
  stripYearEditionPhrases,
} from '../src/services/common/titleUtils';
import { isTitleCompatible } from '../src/services/common/titleMatching';
import { isAnchorSlugCompatible } from '../src/services/critic/metacritic/metacriticTitleMatching';
import {
  createMetacriticIdentityContext,
  evaluateReleaseYearCompatibility,
} from '../src/services/critic/metacritic/metacriticYearGuard';
import {
  getReviewSourceAuthorityRank,
  parseVaultCriticScore,
} from '../src/services/critic/criticUtils';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { metacriticResolver, type MetacriticBundle } from '../src/services/critic/metacriticResolver';
import { openCriticResolver } from '../src/services/critic/openCriticResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { wikidataBridge } from '../src/services/critic/wikidataBridge';
import { loadUserOverrides } from '../src/services/storage/userOverrideStorage';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isUnsuitableCoverUrl,
  isUnsuitableHeaderUrl,
} from '../src/services/igdb/igdbCoverService';
import {
  ARTWORK_AUTHORITY_RANK,
  getCapsuleAuthorityRank,
  getHeaderAuthorityRank,
} from '../src/services/storage/metadataReconciliation';
import { findBestHltbMatch } from '../src/services/hltb/howLongToBeat';
import { syncJobManager } from '../src/services/network/syncJobManager';
import { RequestPriority, requestScheduler } from '../src/services/network/requestScheduler';
import {
  clearExpiredStagedCache,
  clearStagedMemoryFallback,
  hydrateStagedCacheKeyFromVault,
  saveStagedCache,
} from '../src/services/storage/stagedCacheService';
import { matchesGameFilter, matchesStudioFilter } from '../src/services/filter/gameFilterService';
import { scanLocalInstalledGames } from '../src/services/system/localSystemScanner';
import {
  sanitizeAllowedStoreUri,
  sanitizeSafeDomFragment,
  sanitizeStoreClassValue,
  sanitizeStoreHtml,
} from '../src/services/common/htmlSanitizer';
import { SanitizedHtmlBlock } from '../src/utils/safeHtmlSanitizer';
import {
  acquireModalOverlayLock,
  emergencyResetModalOverlayLock,
  isModalOverlayOpen,
} from '../src/utils/modalOverlayLock';
import { MediaGallery } from '../src/components/SteamStoreDetail/MediaGallery';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { ManageCollectionsModal } from '../src/components/Library/ManageCollectionsModal';
import { useCatalogOverrideSync } from '../src/hooks/useCatalogOverrideSync';
import { steamApi } from '../src/services/steam/steamApi';
import { steamMatcher } from '../src/services/steam/steamMatcher';

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Headless React 19 Component & Hook Harnesses
// ---------------------------------------------------------------------------
interface ReactElementLike {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
  key?: string | null;
}

function findElements(
  node: unknown,
  predicate: (el: ReactElementLike) => boolean,
  acc: ReactElementLike[] = []
): ReactElementLike[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  const el = node as ReactElementLike;
  if (predicate(el)) acc.push(el);
  if (el.props && 'children' in el.props) {
    findElements(el.props.children, predicate, acc);
  }
  return acc;
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  const memoCache: Array<{ deps?: unknown[]; value: unknown }> = [];
  let currentProps = initialProps;

  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: Record<string, unknown>;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  const render = (nextProps?: Partial<P>): ReactElementLike | null => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    let memoIdx = 0;
    let idIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => unknown }> = [];

    const prevH = internals.H;

    const runEffectHook = (fn: () => unknown, deps?: unknown[]) => {
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
      useState(initial: unknown) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        const setState = (updater: unknown) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(states[idx])
              : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: unknown) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => unknown, deps?: unknown[]) {
        const idx = memoIdx++;
        const cached = memoCache[idx];
        const changed =
          !cached ||
          !deps ||
          !cached.deps ||
          deps.length !== cached.deps.length ||
          deps.some((d, i) => !Object.is(d, cached.deps![i]));
        if (changed) {
          const value = fn();
          memoCache[idx] = { deps, value };
          return value;
        }
        return cached.value;
      },
      useCallback(fn: unknown) {
        return fn;
      },
      useDeferredValue(val: unknown) {
        return val;
      },
      useTransition() {
        return [false, (fn: () => void) => fn()];
      },
      useContext(ctx: { _currentValue: unknown }) {
        return ctx._currentValue;
      },
      useId() {
        return `r4-mock-id-${idIdx++}`;
      },
    };

    let tree: ReactElementLike | null = null;
    try {
      tree = Component(currentProps) as ReactElementLike | null;
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (cleanups[eff.idx]) {
        try {
          cleanups[eff.idx]!();
        } catch {
          // Ignore cleanup errors
        }
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? (cleanup as () => void) : undefined;
    }

    return tree;
  };

  const unmount = () => {
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch {
          // Ignore unmount cleanup errors
        }
      }
    }
  };

  return { render, unmount };
}

function createHookHarness<R>(useHookFn: () => R) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];

  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: Record<string, unknown>;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  const run = (): R => {
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => unknown }> = [];
    const prevH = internals.H;

    const runEffectHook = (fn: () => unknown, deps?: unknown[]) => {
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
      useState(initial: unknown) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        const setState = (updater: unknown) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(states[idx])
              : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: unknown) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => unknown) {
        return fn();
      },
      useCallback(fn: unknown) {
        return fn;
      },
      useId() {
        return 'r4-hook-id';
      },
    };

    let result!: R;
    try {
      result = useHookFn();
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (cleanups[eff.idx]) {
        try {
          cleanups[eff.idx]!();
        } catch {}
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? (cleanup as () => void) : undefined;
    }

    return result;
  };

  const harness = {
    current: run(),
    rerender() {
      harness.current = run();
      return harness.current;
    },
    unmount() {
      for (const cleanup of cleanups) {
        if (typeof cleanup === 'function') {
          try {
            cleanup();
          } catch {}
        }
      }
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Minimal Inert DOMParser + DocumentFragment Adapter for HTML Sanitizer Tests
// ---------------------------------------------------------------------------
function installInertDomParserHarness(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prevDomParser = g.DOMParser;
  const prevCreateFragment = testEnv.documentObj.createDocumentFragment;
  const prevCreateElement = testEnv.documentObj.createElement;
  const prevImplementation = testEnv.documentObj.implementation;

  class FragmentAdapter {
    public readonly nodeType = 11;
    public readonly nodeName = '#document-fragment';
    public childNodes: Array<ParsedDomElementNode | ParsedDomTextNode> = [];
    get firstChild(): ParsedDomElementNode | ParsedDomTextNode | null {
      return this.childNodes[0] ?? null;
    }
    appendChild(child: ParsedDomElementNode | ParsedDomTextNode) {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = null;
      this.childNodes.push(child);
      return child;
    }
    querySelectorAll(selector: string): ParsedDomElementNode[] {
      const out: ParsedDomElementNode[] = [];
      for (const child of this.childNodes) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) out.push(child);
          out.push(...child.querySelectorAll(selector));
        }
      }
      return out;
    }
  }

  const attachFirstChildGetter = (el: ParsedDomElementNode): ParsedDomElementNode => {
    if (!Object.prototype.hasOwnProperty.call(el, 'firstChild')) {
      Object.defineProperty(el, 'firstChild', {
        get() {
          return el.childNodes[0] ?? null;
        },
        configurable: true,
      });
    }
    const origAppend = el.appendChild.bind(el);
    el.appendChild = ((child: unknown) => {
      if (child instanceof FragmentAdapter) {
        const moved = [...child.childNodes];
        child.childNodes.length = 0;
        for (const item of moved) {
          origAppend(item);
        }
        return child;
      }
      return origAppend(child as ParsedDomElementNode | ParsedDomTextNode);
    }) as typeof el.appendChild;
    return el;
  };

  class AdapterDOMParser {
    private inner = new TestDOMParser();
    parseFromString(markup: string, type = 'text/html') {
      const parsed = this.inner.parseFromString(markup, type);
      attachFirstChildGetter(parsed.body);
      return parsed;
    }
  }

  g.DOMParser = AdapterDOMParser;
  testEnv.documentObj.createDocumentFragment = () => new FragmentAdapter();
  testEnv.documentObj.createElement = (tag: string) =>
    attachFirstChildGetter(new ParsedDomElementNode(tag));
  testEnv.documentObj.implementation = {
    createHTMLDocument: () => ({
      createElement: (tag: string) => attachFirstChildGetter(new ParsedDomElementNode(tag)),
    }),
  };

  return () => {
    if (prevDomParser === undefined) {
      delete g.DOMParser;
    } else {
      g.DOMParser = prevDomParser;
    }
    if (prevCreateFragment === undefined) {
      delete testEnv.documentObj.createDocumentFragment;
    } else {
      testEnv.documentObj.createDocumentFragment = prevCreateFragment;
    }
    if (prevCreateElement === undefined) {
      delete testEnv.documentObj.createElement;
    } else {
      testEnv.documentObj.createElement = prevCreateElement;
    }
    if (prevImplementation === undefined) {
      delete testEnv.documentObj.implementation;
    } else {
      testEnv.documentObj.implementation = prevImplementation;
    }
  };
}

// ---------------------------------------------------------------------------
// WCAG 2.1 Relative Luminance & Contrast Ratio Helper
// ---------------------------------------------------------------------------
function hexToRelativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = hexToRelativeLuminance(hexA);
  const lumB = hexToRelativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

// ===========================================================================
// Comprehensive R4 Services & React 19 Frontend Ground-Up Refactor Test Suite
// ===========================================================================
describe('R4 Services & React 19 Frontend Ground-Up Refactor Hardening Suite', () => {
  beforeEach(() => {
    testEnv.localStorageMock.clear();
    testEnv.idbStore.clear();
    testEnv.setCustomVaultGetHandler(null);
    testEnv.resetDomFlags();
    delete testEnv.windowObj.electronAPI;

    requestScheduler.reset();
    requestScheduler.setEnforceDelays(false);
    syncJobManager.reset();
    achievementSummaryStore.resetForTests();
    steamAchievementsService.resetForTests();
    achievementDetailService.clearCache();
    criticScoreService.purgeAllScoreCache();
    igdbCoverService.clearCache();
    clearStagedMemoryFallback();
    emergencyResetModalOverlayLock();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete testEnv.windowObj.electronAPI;
    testEnv.setCustomVaultGetHandler(null);
    requestScheduler.reset();
    syncJobManager.reset();
    emergencyResetModalOverlayLock();
  });

  // =========================================================================
  // 1. Storefront Library-Wipe Guards, Secret Redaction & Achievement Isolation
  // =========================================================================
  describe('1. Storefront Library-Wipe Guards, Secret Redaction & Achievement Isolation (W3-E & W4-C)', () => {
    it('gogIntegration fails closed on HTTP 200 HTML login pages and {} missing products[]/totalPages, preserving 100% of non-installed GOG games in mergeStorefrontGames', async () => {
      const existingCatalog: CanonicalGame[] = [
        makeCanonicalGame({
          id: 'gog-101',
          title: 'Chronicle of Aradia',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'gog', platformGameId: '101', installed: false }],
        }),
        makeCanonicalGame({
          id: 'gog-102',
          title: 'Starforge Odyssey',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'gog', platformGameId: '102', installed: false }],
        }),
        makeCanonicalGame({
          id: 'gog-103',
          title: 'Tactical Horizon',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'gog', platformGameId: '103', installed: false }],
        }),
      ];

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const getSpy = vi.spyOn(axios, 'get');

      // Case A: HTTP 200 HTML login redirect page
      getSpy.mockResolvedValueOnce({
        status: 200,
        data: '<!doctype html><html><body><form action="/login">Sign in to GOG</form></body></html>',
      });
      const htmlRes = await gogIntegration.fetchOwnedGamesDetailed('test-gog-token');
      expect(htmlRes).toEqual({ games: [], authoritativeComplete: false });

      const afterHtmlMerge = mergeStorefrontGames(existingCatalog, htmlRes.games, 'gog', {
        authoritativeComplete: htmlRes.authoritativeComplete,
      });
      expect(afterHtmlMerge.map((g) => g.id).sort()).toEqual(['gog-101', 'gog-102', 'gog-103']);

      // Case B: HTTP 200 `{}` missing products[] and totalPages
      getSpy.mockResolvedValueOnce({ status: 200, data: {} });
      const emptyObjRes = await gogIntegration.fetchOwnedGamesDetailed('test-gog-token');
      expect(emptyObjRes).toEqual({ games: [], authoritativeComplete: false });

      const afterEmptyObjMerge = mergeStorefrontGames(existingCatalog, emptyObjRes.games, 'gog', {
        authoritativeComplete: emptyObjRes.authoritativeComplete,
      });
      expect(afterEmptyObjMerge.map((g) => g.id).sort()).toEqual(['gog-101', 'gog-102', 'gog-103']);

      // Case B2: HTTP 200 `{ products: [] }` missing totalPages also fails closed
      getSpy.mockResolvedValueOnce({ status: 200, data: { products: [] } });
      const missingTotalPagesRes = await gogIntegration.fetchOwnedGamesDetailed('test-gog-token');
      expect(missingTotalPagesRes).toEqual({ games: [], authoritativeComplete: false });

      // Case C: HTTP 200 valid authoritative response marks authoritativeComplete: true,
      // pruning removed non-installed GOG games while ALWAYS retaining installed ones
      const catalogWithInstalled: CanonicalGame[] = [
        ...existingCatalog,
        makeCanonicalGame({
          id: 'gog-104',
          title: 'Locally Installed Classic',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'gog',
              platformGameId: '104',
              installed: true,
              installPath: '/Users/testuser/Games/GOG/Classic',
            },
          ],
        }),
      ];
      getSpy.mockResolvedValueOnce({
        status: 200,
        data: {
          totalPages: 1,
          products: [{ id: 101, title: 'Chronicle of Aradia', isHidden: false }],
        },
      });
      const validRes = await gogIntegration.fetchOwnedGamesDetailed('test-gog-token');
      expect(validRes.authoritativeComplete).toBe(true);
      expect(validRes.games).toHaveLength(1);
      expect(validRes.games[0].id).toBe('gog-101');
      const afterAuthoritativeMerge = mergeStorefrontGames(catalogWithInstalled, validRes.games, 'gog', {
        authoritativeComplete: validRes.authoritativeComplete,
      });
      expect(afterAuthoritativeMerge.map((g) => g.id).sort()).toEqual(['gog-101', 'gog-104']);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('epicIntegration fails closed on HTTP 200 HTML login pages and {} missing records[], preserving 100% of non-installed Epic games in mergeStorefrontGames', async () => {
      const existingCatalog: CanonicalGame[] = [
        makeCanonicalGame({
          id: 'epic-alpha-01',
          title: 'Nebula Drift',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'epic', platformGameId: 'alpha-01', installed: false }],
        }),
        makeCanonicalGame({
          id: 'epic-beta-02',
          title: 'Iron Bastion',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'epic', platformGameId: 'beta-02', installed: false }],
        }),
        makeCanonicalGame({
          id: 'epic-gamma-03',
          title: 'Shadow Harbor',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'epic', platformGameId: 'gamma-03', installed: false }],
        }),
      ];

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(steamMatcher, 'matchGameToSteam').mockResolvedValue(null);
      const getSpy = vi.spyOn(axios, 'get');

      // Case A: HTTP 200 HTML login page
      getSpy.mockResolvedValueOnce({
        status: 200,
        data: '<html><body><h1>Sign in with Epic Games</h1></body></html>',
      });
      const htmlRes = await epicIntegration.fetchOwnedGamesDetailed('test-epic-token');
      expect(htmlRes).toEqual({ games: [], authoritativeComplete: false });

      const afterHtmlMerge = mergeStorefrontGames(existingCatalog, htmlRes.games, 'epic', {
        authoritativeComplete: htmlRes.authoritativeComplete,
      });
      expect(afterHtmlMerge.map((g) => g.id).sort()).toEqual([
        'epic-alpha-01',
        'epic-beta-02',
        'epic-gamma-03',
      ]);

      // Case B: HTTP 200 `{}` missing records[]
      getSpy.mockResolvedValueOnce({ status: 200, data: {} });
      const emptyObjRes = await epicIntegration.fetchOwnedGamesDetailed('test-epic-token');
      expect(emptyObjRes).toEqual({ games: [], authoritativeComplete: false });

      const afterEmptyObjMerge = mergeStorefrontGames(existingCatalog, emptyObjRes.games, 'epic', {
        authoritativeComplete: emptyObjRes.authoritativeComplete,
      });
      expect(afterEmptyObjMerge.map((g) => g.id).sort()).toEqual([
        'epic-alpha-01',
        'epic-beta-02',
        'epic-gamma-03',
      ]);

      // Case C: Valid Epic records[] response resolves authoritativeComplete: true
      getSpy.mockResolvedValueOnce({
        status: 200,
        data: {
          records: [
            {
              appName: 'NebulaDriftApp',
              namespace: 'ns-nebula',
              catalogItemId: 'alpha-01',
              metadata: {
                title: 'Nebula Drift',
                description: 'Deep-space exploration tactics.',
                developer: 'Synthetic Studio',
                categories: [{ path: 'games' }],
                keyImages: [
                  {
                    type: 'DieselGameBoxTall',
                    url: 'https://cdn.example.invalid/epic/nebula-tall.jpg',
                  },
                ],
              },
            },
          ],
          responseMetadata: {},
        },
      });
      const validRes = await epicIntegration.fetchOwnedGamesDetailed('test-epic-token');
      expect(validRes.authoritativeComplete).toBe(true);
      expect(validRes.games).toHaveLength(1);
      expect(validRes.games[0].title).toBe('Nebula Drift');
    });

    it('steamIntegration redacts key=<API_KEY> in error logs and xboxIntegration never falls back accountName to credentials.webToken', async () => {
      const secretKey = 'SYNTH_STEAM_API_KEY_9876543210';
      const warnMessages: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnMessages.push(args.map((a) => String(a)).join(' '));
      });

      const getSpy = vi.spyOn(axios, 'get');
      getSpy.mockRejectedValue(
        Object.assign(
          new Error(
            `Request failed for https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${secretKey}&steamid=76561198000000042`
          ),
          { code: 'ERR_BAD_REQUEST', response: { status: 403 } }
        )
      );

      const resolvedVanity = await steamIntegration.resolveVanityUrl('synthetic_player', secretKey);
      expect(resolvedVanity).toBeNull();

      await expect(
        steamIntegration.fetchOwnedGames({
          steamId: '76561198000000042',
          apiKey: secretKey,
        })
      ).rejects.toThrow();

      expect(warnMessages.length).toBeGreaterThanOrEqual(2);
      const joinedLogs = warnMessages.join('\n');
      expect(joinedLogs).toContain('key=[REDACTED]');
      expect(joinedLogs).not.toContain(secretKey);

      // Xbox accountName must never leak credentials.webToken (both non-Electron and Electron modes)
      const secretXboxWebToken = 'SYNTH_XBOX_SECRET_WEB_TOKEN_DO_NOT_DISPLAY';
      const fallbackXbox = await xboxIntegration.syncXboxAccount({
        webToken: secretXboxWebToken,
      });
      expect(fallbackXbox.accountName).toBe('Xbox Live Account');
      expect(fallbackXbox.accountName).not.toContain(secretXboxWebToken);
      expect(fallbackXbox.gamertag).not.toContain(secretXboxWebToken);
      expect(fallbackXbox.authoritativeComplete).toBe(false);

      testEnv.windowObj.electronAPI = {
        syncStore: vi.fn(async () => ({
          success: true,
          games: [],
          authoritativeComplete: true,
        })),
      } as Partial<ElectronAPI>;

      const electronXbox = await xboxIntegration.syncXboxAccount({
        webToken: secretXboxWebToken,
      });
      expect(electronXbox.accountName).toBe('Xbox Live Account');
      expect(electronXbox.accountName).not.toContain(secretXboxWebToken);
    });

    it('achievementDetailService & GameAchievementsModal isolate non-Steam games with cross-referenced steamAppId: zero Steam fetches and zero phantom steam tabs', async () => {
      const nonSteamCrossRefGame = makeCanonicalGame({
        id: 'gog-1495134320',
        title: 'Wild Hunt Cross-Ref Edition',
        steamAppId: 292030,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1495134320',
            installed: true,
            achievements: { unlocked: 3, total: 10, percentage: 30, isMastered: false },
          },
          {
            platformId: 'xbox',
            platformGameId: '9NBLGGH4TEST',
            installed: false,
            achievements: { unlocked: 2, total: 10, percentage: 20, isMastered: false },
          },
        ],
      });

      const makeStoreData = (store: 'steam' | 'gog' | 'xbox'): StorefrontAchievementsData => ({
        storefrontId: store,
        storefrontName: store === 'gog' ? 'GOG.com' : store === 'xbox' ? 'Xbox' : 'Steam',
        source: 'live_cloud',
        total: 10,
        unlocked: store === 'gog' ? 3 : 2,
        percentage: store === 'gog' ? 30 : 20,
        isMastered: false,
        supportsAchievements: true,
        cacheVersion: 4,
        achievements: [
          {
            id: `${store}-ach-1`,
            apiName: `${store}_ACH_1`,
            name: `${store.toUpperCase()} First Trophy`,
            description: 'Completed chapter one.',
            iconUnlockedUrl: `https://cdn.example.invalid/icons/${store}-1.png`,
            storefrontId: store,
            unlocked: true,
          },
        ],
      });

      const steamFetchSpy = vi
        .spyOn(achievementDetailService, 'fetchSteamDetailedAchievements')
        .mockResolvedValue(makeStoreData('steam'));
      const gogFetchSpy = vi
        .spyOn(achievementDetailService, 'fetchGogDetailedAchievements')
        .mockResolvedValue(makeStoreData('gog'));
      const xboxFetchSpy = vi
        .spyOn(achievementDetailService, 'fetchXboxDetailedAchievements')
        .mockResolvedValue(makeStoreData('xbox'));

      // 1. Live fetch must NEVER call fetchSteamDetailedAchievements for GOG+Xbox-only game
      const fetched = await achievementDetailService.fetchGameAchievements(
        nonSteamCrossRefGame,
        true
      );
      expect(steamFetchSpy).not.toHaveBeenCalled();
      expect(gogFetchSpy).toHaveBeenCalledTimes(1);
      expect(xboxFetchSpy).toHaveBeenCalledTimes(1);
      expect(fetched.steam).toBeUndefined();
      expect(fetched.gog).toBeDefined();
      expect(fetched.xbox).toBeDefined();

      // 2. Even if a legacy poisoned cache contained a phantom `steam` entry, both service and modal strip it
      const poisonedMap: MultiStoreAchievementsMap = {
        steam: makeStoreData('steam'),
        gog: makeStoreData('gog'),
        xbox: makeStoreData('xbox'),
      };
      achievementDetailService.setCachedMultiStoreAchievements(
        nonSteamCrossRefGame.id,
        poisonedMap
      );
      const cachedRead = await achievementDetailService.fetchGameAchievements(
        nonSteamCrossRefGame,
        false
      );
      expect(cachedRead.steam).toBeUndefined();
      expect(cachedRead.gog).toBeDefined();
      expect(cachedRead.xbox).toBeDefined();

      // 3. Render GameAchievementsModal with poisoned cache peek -> ONLY gog & xbox tabs render, zero phantom steam tab
      const modalHarness = createComponentHarness(GameAchievementsModal, {
        isOpen: true,
        game: nonSteamCrossRefGame,
        onClose: vi.fn(),
      });
      modalHarness.render();
      await flushMicrotasks();
      const tree = modalHarness.render();

      const tabButtons = findElements(
        tree,
        (el) =>
          el.type === 'button' &&
          typeof el.props?.id === 'string' &&
          el.props.id.startsWith('achievements-storefront-tab-')
      );
      const tabIds = tabButtons.map((btn) => btn.props?.id);
      expect(tabIds).toContain('achievements-storefront-tab-gog');
      expect(tabIds).toContain('achievements-storefront-tab-xbox');
      expect(tabIds).not.toContain('achievements-storefront-tab-steam');
      modalHarness.unmount();

      // 4. Epic-only game with cross-referenced steamAppId also never fetches Steam achievements
      const epicOnlyCrossRefGame = makeCanonicalGame({
        id: 'epic-control-01',
        title: 'Epic Cross-Ref Adventure',
        steamAppId: 870780,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-control-01', installed: true }],
      });
      const epicFetchSpy = vi
        .spyOn(achievementDetailService, 'fetchEpicDetailedAchievements')
        .mockResolvedValue({
          ...makeStoreData('gog'),
          storefrontId: 'epic',
          storefrontName: 'Epic Games',
        });
      steamFetchSpy.mockClear();
      const epicFetched = await achievementDetailService.fetchGameAchievements(
        epicOnlyCrossRefGame,
        true
      );
      expect(steamFetchSpy).not.toHaveBeenCalled();
      expect(epicFetchSpy).toHaveBeenCalledTimes(1);
      expect(epicFetched.steam).toBeUndefined();
      expect(epicFetched.epic).toBeDefined();
    });

    it('Unified AchievementSummaryStore avoids split-brain overwrites, preserves lastUnlockedAt, and failed/0-result Steam sync does NOT trigger 6-hour cooldown lockout', async () => {
      const tsGameA = '2026-03-01T10:00:00.000Z';
      const tsGameB = '2026-04-02T12:30:00.000Z';

      // Write App 1001 through knownGameAchievements helper
      cacheUserSteamAchievements({
        1001: {
          unlocked: 5,
          total: 20,
          percentage: 25,
          isMastered: false,
          lastUnlockedAt: tsGameA,
          source: 'local_client_cache',
        },
      });

      // Write App 2002 through steamAchievementsService (debounced) + flush
      steamAchievementsService.setCachedAchievement(2002, {
        unlocked: 10,
        total: 10,
        percentage: 100,
        isMastered: true,
        lastUnlockedAt: tsGameB,
        source: 'live_cloud_api',
        syncedAt: '2026-04-03T00:00:00.000Z',
      });
      steamAchievementsService.flushPendingSave();

      // Zero split-brain: BOTH games coexist in both readers and localStorage
      const read1001A = getKnownSteamAchievements(1001);
      const read2002A = getKnownSteamAchievements(2002);
      const read1001B = steamAchievementsService.getCachedAchievements(1001);
      const read2002B = steamAchievementsService.getCachedAchievements(2002);

      expect(read1001A?.unlocked).toBe(5);
      expect(read1001A?.lastUnlockedAt).toBe(tsGameA);
      expect(read2002A?.unlocked).toBe(10);
      expect(read2002A?.lastUnlockedAt).toBe(tsGameB);
      expect(read1001B?.unlocked).toBe(5);
      expect(read2002B?.unlocked).toBe(10);

      // Reconciled update to App 1001 without lastUnlockedAt MUST preserve existing lastUnlockedAt
      cacheUserSteamAchievements({
        1001: {
          unlocked: 7,
          total: 20,
          percentage: 35,
          isMastered: false,
          source: 'live_cloud_api',
        },
      });
      const updated1001 = getKnownSteamAchievements(1001);
      expect(updated1001?.unlocked).toBe(7);
      expect(updated1001?.lastUnlockedAt).toBe(tsGameA);

      // Failed / 0-result Steam library achievement sync must NOT stamp 6-hour cooldown lockout
      const playedSteamGame = makeCanonicalGame({
        id: 'steam-77001',
        title: 'Offline Lockout Guard Game',
        steamAppId: 77001,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '77001',
            installed: true,
            playtimeMinutes: 180,
          },
        ],
      });

      testEnv.windowObj.electronAPI = {
        fetchSteamBatchAchievements: vi.fn(async () => ({
          success: false,
          achievements: {},
        })),
      } as Partial<ElectronAPI>;

      vi.spyOn(axios, 'get').mockRejectedValue(new Error('Simulated network outage'));
      testEnv.localStorageMock.removeItem(STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC);

      const syncResults = await steamAchievementsService.syncUserLibraryAchievements(
        [playedSteamGame],
        undefined,
        { forceRefresh: true }
      );
      expect(syncResults).toEqual({});
      expect(steamAchievementsService.hasRecentFullSync()).toBe(false);
      expect(
        testEnv.localStorageMock.getItem(STORAGE_KEY_STEAM_ACHIEVEMENTS_LAST_SYNC)
      ).toBeNull();
    });

    it('AchievementSummaryStore enforces IDB hydration-before-write barrier so cold-boot writes merge with existing vault entries instead of clobbering them', async () => {
      const deferredIdb = Promise.withResolvers<Record<string, StoreAchievementSummary> | undefined>();
      testEnv.setCustomVaultGetHandler((key: string) =>
        key === 'idb_steam_achievements_summary_v1' ? deferredIdb.promise : undefined
      );

      const vaultSetSpy = vi.mocked(indexedDbVault.vaultSet);
      vaultSetSpy.mockClear();

      // Cold-boot write for App 3003 before IDB hydration finishes
      cacheUserSteamAchievements({
        3003: {
          unlocked: 4,
          total: 10,
          percentage: 40,
          isMastered: false,
          lastUnlockedAt: '2026-04-10T08:00:00.000Z',
          source: 'live_cloud_api',
        },
      });
      await flushMicrotasks();

      // Barrier check: MUST NOT overwrite IDB before hydration resolves
      const prematureIdbWrites = vaultSetSpy.mock.calls.filter(
        ([k]) => k === 'idb_steam_achievements_summary_v1'
      );
      expect(prematureIdbWrites).toHaveLength(0);

      // Resolve IDB hydration with pre-existing App 4004 summary
      deferredIdb.resolve({
        '4004': {
          unlocked: 15,
          total: 15,
          percentage: 100,
          isMastered: true,
          lastUnlockedAt: '2025-12-20T18:00:00.000Z',
          source: 'live_cloud_api',
        },
      });
      await flushMicrotasks(10);

      // Merged IDB write preserves BOTH existing App 4004 and new cold-boot App 3003
      const mergedWrites = vaultSetSpy.mock.calls.filter(
        ([k]) => k === 'idb_steam_achievements_summary_v1'
      );
      expect(mergedWrites.length).toBeGreaterThanOrEqual(1);
      const savedDict = mergedWrites[mergedWrites.length - 1][1] as Record<
        string,
        StoreAchievementSummary
      >;
      expect(savedDict['3003']?.unlocked).toBe(4);
      expect(savedDict['4004']?.unlocked).toBe(15);
      expect(getKnownSteamAchievements(4004)?.isMastered).toBe(true);
      expect(getKnownSteamAchievements(3003)?.unlocked).toBe(4);
    });
  });

  // =========================================================================
  // 2. Title/Year Matching, Critic Hierarchy, IGDB Unwrap, HLTB & IDB Barriers
  // =========================================================================
  describe('2. Title/Year Matching, Critic Hierarchy, IGDB ol-media:// Unwrap, HLTB & IDB Barriers (W1-B & W3-D)', () => {
    it('strips trailing delimited release years cleanly while strictly preserving bare title numbers and parenthetical reboots', () => {
      const oblivionGoty2009 = 'The Elder Scrolls IV: Oblivion Game of the Year Edition – 2009';
      expect(extractTrailingDelimitedReleaseYear(oblivionGoty2009)).toBe(2009);
      expect(stripTrailingDelimitedReleaseYear(oblivionGoty2009)).toBe(
        'The Elder Scrolls IV: Oblivion Game of the Year Edition'
      );
      expect(stripTrailingDelimitedReleaseYear('Title - 2009')).toBe('Title');
      expect(isTitleCompatible(oblivionGoty2009, 'The Elder Scrolls IV: Oblivion')).toBe(true);
      expect(isAnchorSlugCompatible(oblivionGoty2009, 'the-elder-scrolls-iv-oblivion')).toBe(true);

      // Bare title numbers MUST remain strictly preserved and never treated as trailing release years
      const bareYearTitles = [
        'Metro 2033',
        'Cyberpunk 2077',
        'Battlefield 2042',
        'SimCity 2000',
        '1942',
      ];
      for (const t of bareYearTitles) {
        expect(extractTrailingDelimitedReleaseYear(t)).toBeNull();
        expect(stripTrailingDelimitedReleaseYear(t)).toBe(t);
        expect(stripYearEditionPhrases(t)).toBe(t);
      }
      expect(isTitleCompatible('Metro 2033', 'Metro')).toBe(false);
      expect(isTitleCompatible('Cyberpunk 2077', 'Cyberpunk')).toBe(false);
      expect(isTitleCompatible('Battlefield 2042', 'Battlefield')).toBe(false);
      expect(isTitleCompatible('SimCity 2000', 'SimCity')).toBe(false);

      // Parenthetical reboots strictly isolated
      expect(stripYearEditionPhrases('DOOM (2016)')).toBe('DOOM (2016)');
      expect(isSequelMismatch('DOOM (2016)', 'DOOM (1993)')).toBe(true);
      expect(isTitleCompatible('DOOM (2016)', 'DOOM (1993)')).toBe(false);

      // End-to-end semantic compatibility via criticScoreService & metacriticYearGuard
      expect(
        criticScoreService.isScoreSemanticallyCompatible(oblivionGoty2009, {
          source: 'metacritic',
          score: 94,
          tier: 'Mighty',
          url: 'https://www.metacritic.com/game/the-elder-scrolls-iv-oblivion/',
          isVerified: true,
        })
      ).toBe(true);
      expect(
        criticScoreService.isScoreSemanticallyCompatible('Metro 2033', {
          source: 'metacritic',
          score: 81,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/metro/',
          isVerified: true,
        })
      ).toBe(false);
      const doom2016Ctx = createMetacriticIdentityContext('DOOM (2016)');
      expect(evaluateReleaseYearCompatibility(doom2016Ctx, 1993, false)).toBe('reject');
      expect(evaluateReleaseYearCompatibility(doom2016Ctx, 2016, false)).toBe('accept');
    });

    it('GENERIC_SUBTITLE_TOKENS rejects false addon matches while permitting genuine distinctive intermediate-numeral subtitles', () => {
      expect(isIntermediateNumeralSubtitleMatch('Game 2: Bonus Content', 'Game: Bonus Content')).toBe(
        false
      );
      expect(isSequelMismatch('Game 2: Bonus Content', 'Game: Bonus Content')).toBe(true);
      expect(isTitleCompatible('Game 2: Bonus Content', 'Game: Bonus Content')).toBe(false);

      // Additional generic addon subtitle rejections
      expect(
        isIntermediateNumeralSubtitleMatch('Chronicle 2: Weapon Skins', 'Chronicle: Weapon Skins')
      ).toBe(false);
      expect(
        isIntermediateNumeralSubtitleMatch('Chronicle 2: Free Trial', 'Chronicle: Free Trial')
      ).toBe(false);

      // Genuine distinctive subtitle still matches
      expect(
        isIntermediateNumeralSubtitleMatch('Deus Ex 2: Invisible War', 'Deus Ex: Invisible War')
      ).toBe(true);
    });

    it('criticUtils classifies untagged user-reviews/mc-user-* safely, sanitizes >100 scores and javascript: URLs, and criticScoreService achieves 0 localStorage.getItem calls on warm memory hits in production mode + fences stale pre-eviction promises via cacheEpoch', async () => {
      // 1. Untagged Metacritic user-reviews URL and mc-user-* ID classification
      const parsedUserUrl = parseVaultCriticScore({
        score: 81,
        url: 'https://www.metacritic.com/game/synthetic-foo/user-reviews/',
      });
      expect(parsedUserUrl).not.toBeNull();
      expect(parsedUserUrl?.source).toBe('metacritic_user');
      expect(parsedUserUrl?.isVerified).toBe(false);
      expect(getReviewSourceAuthorityRank(parsedUserUrl)).toBe(1);

      const parsedUserId = parseVaultCriticScore({
        id: 'mc-user-synthetic-foo',
        score: 86,
        numReviews: 45,
      });
      expect(parsedUserId).not.toBeNull();
      expect(parsedUserId?.source).toBe('metacritic_user');
      expect(parsedUserId?.isVerified).toBe(false);
      expect(getReviewSourceAuthorityRank(parsedUserId)).toBe(2);

      // 2. Out-of-range scores (>100 / <=0) rejected and javascript: URLs sanitized
      expect(parseVaultCriticScore({ score: 101, source: 'metacritic' })).toBeNull();
      expect(parseVaultCriticScore({ score: 0, source: 'metacritic' })).toBeNull();
      expect(
        getReviewSourceAuthorityRank({
          source: 'metacritic',
          score: 120,
          tier: 'Mighty',
          url: 'https://www.metacritic.com/game/invalid/',
          isVerified: true,
        })
      ).toBe(0);

      const sanitizedJsUrl = parseVaultCriticScore({
        score: 79,
        url: 'javascript:alert(1)',
      });
      expect(sanitizedJsUrl).not.toBeNull();
      expect(sanitizedJsUrl?.url).toBe('');
      expect(sanitizedJsUrl?.source).toBe('custom');

      // 3. Warm memory hit in production mode performs 0 localStorage.getItem calls
      const warmTitle = 'Warm Memory Critic Showcase';
      const warmAppId = 44001;
      const warmScore: CriticScoreData = {
        source: 'metacritic',
        score: 89,
        tier: 'Mighty',
        numReviews: 32,
        url: 'https://www.metacritic.com/game/warm-memory-critic-showcase/',
        isVerified: true,
      };
      criticScoreService.seedFromVaultIfMissing(warmAppId, warmTitle, warmScore);
      // Warm up userOverrideStorage hydration once before flipping to production mode
      loadUserOverrides();

      const prevVitest = process.env.VITEST;
      const prevNodeEnv = process.env.NODE_ENV;
      const getItemSpy = vi.spyOn(testEnv.localStorageMock, 'getItem');
      try {
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';
        // Prime first read in production mode so inMemoryOverridesHydrated is guaranteed settled
        criticScoreService.getCriticScore(warmAppId, warmTitle, undefined, 2021, undefined, false, true);
        getItemSpy.mockClear();

        const warmHit = criticScoreService.getCriticScore(
          warmAppId,
          warmTitle,
          undefined,
          2021,
          undefined,
          false,
          true
        );
        expect(warmHit?.score).toBe(89);
        expect(warmHit?.source).toBe('metacritic');
        expect(getItemSpy).not.toHaveBeenCalled();
      } finally {
        if (prevVitest === undefined) {
          delete process.env.VITEST;
        } else {
          process.env.VITEST = prevVitest;
        }
        if (prevNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = prevNodeEnv;
        }
      }

      // 4. cacheEpoch fences stale pre-eviction dynamic resolution promises
      const deferredMc = Promise.withResolvers<MetacriticBundle>();
      vi.spyOn(wikidataBridge, 'resolveForGame').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockReturnValue(deferredMc.promise);
      vi.spyOn(openCriticResolver, 'resolveForGame').mockResolvedValue(null);
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue(null);
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue(null);

      const fencedAppId = 55501;
      const fencedTitle = 'Epoch Fenced Title';
      const inFlightPromise = criticScoreService.resolveDynamicScore(fencedTitle, fencedAppId, 2022);
      await flushMicrotasks();

      // Evict this game while the Metacritic resolution is still in flight
      criticScoreService.evictCriticCacheForGame(`steam-${fencedAppId}`, fencedTitle, fencedAppId);

      // Now resolve the stale pre-eviction promise
      deferredMc.resolve({
        critic: {
          source: 'metacritic',
          score: 76,
          tier: 'Strong',
          numReviews: 18,
          url: 'https://www.metacritic.com/game/epoch-fenced-title/',
          isVerified: true,
        },
        user: null,
      });

      const fencedOutcome = await inFlightPromise;
      expect(fencedOutcome).toBeNull();
      expect(
        criticScoreService.getCriticScore(fencedAppId, fencedTitle, undefined, 2022, undefined, false, true)
      ).toBeNull();
    });

    it('igdbCoverService unwraps ol-media://asset?url=... before classifying unsuitable Spacewar/GOG-cropped covers (blocking Rank 5 promotion) and isolates Prey 2017 vs Prey 2006 lookups', async () => {
      const gogHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const croppedGogRaw = `https://images.gog-statics.com/${gogHash}_glx_vertical_cover.jpg`;
      const croppedGogWrapped = `ol-media://asset?url=${encodeURIComponent(croppedGogRaw)}`;
      const gogSameHashCapWrapped = `ol-media://asset?url=${encodeURIComponent(
        `https://images.gog-statics.com/${gogHash}_product_tile.jpg`
      )}`;
      const gogSameHashHeaderWrapped = `ol-media://asset?url=${encodeURIComponent(
        `https://images.gog-statics.com/${gogHash}_bg_crop_1920x655.jpg`
      )}`;
      const spacewarHeaderWrapped = `ol-media://asset?url=${encodeURIComponent(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480/header.jpg'
      )}`;
      const validIgdbWrapped = `ol-media://asset?url=${encodeURIComponent(
        'https://images.igdb.com/igdb/image/upload/t_cover_big/co9988.jpg'
      )}`;

      expect(isGogCroppedHorizontalCover(croppedGogWrapped)).toBe(true);
      expect(isGogCroppedHorizontalCover(gogSameHashCapWrapped, gogSameHashHeaderWrapped)).toBe(
        true
      );
      expect(isUnsuitableCoverUrl(croppedGogWrapped)).toBe(true);
      expect(isUnsuitableCoverUrl(spacewarHeaderWrapped)).toBe(true);
      expect(isUnsuitableHeaderUrl(spacewarHeaderWrapped)).toBe(true);

      // Must NEVER be promoted to Rank 5 (VERIFIED_LOCAL_PORTRAIT)!
      expect(getCapsuleAuthorityRank(croppedGogWrapped)).toBe(
        ARTWORK_AUTHORITY_RANK.UNSUITABLE_OR_LANDSCAPE
      );
      expect(
        getCapsuleAuthorityRank(gogSameHashCapWrapped, { headerUrl: gogSameHashHeaderWrapped })
      ).toBe(ARTWORK_AUTHORITY_RANK.UNSUITABLE_OR_LANDSCAPE);
      expect(getHeaderAuthorityRank(spacewarHeaderWrapped)).toBe(
        ARTWORK_AUTHORITY_RANK.UNSUITABLE_OR_LANDSCAPE
      );

      // Legitimate portrait wrapped in ol-media:// DOES achieve Rank 5
      expect(isUnsuitableCoverUrl(validIgdbWrapped)).toBe(false);
      expect(getCapsuleAuthorityRank(validIgdbWrapped)).toBe(
        ARTWORK_AUTHORITY_RANK.VERIFIED_LOCAL_PORTRAIT
      );

      // Year-specific IGDB lookups: Prey 2017 vs Prey 2006 never collide
      const lutrisPayload = {
        results: [
          {
            name: 'Prey',
            year: 2006,
            coverart: 'https://lutris.net/media/coverart/co_prey2006.jpg',
          },
          {
            name: 'Prey',
            year: 2017,
            coverart: 'https://lutris.net/media/coverart/co_prey2017.jpg',
          },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify(lutrisPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const cover2017 = await igdbCoverService.fetchIgdbCover('Prey', 2017);
      expect(cover2017).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_prey2017.jpg');

      // 2006 lookup must NOT receive 2017's cover before fetching 2006
      expect(igdbCoverService.getIgdbCoverInstant('Prey', undefined, undefined, 2006)).toBeNull();
      expect(igdbCoverService.getIgdbCoverInstant('Prey (2006)')).toBeNull();

      const cover2006 = await igdbCoverService.fetchIgdbCover('Prey', 2006);
      expect(cover2006).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co_prey2006.jpg');

      expect(igdbCoverService.getIgdbCoverInstant('Prey', undefined, undefined, 2017)).toBe(
        cover2017
      );
      expect(igdbCoverService.getIgdbCoverInstant('Prey', undefined, undefined, 2006)).toBe(
        cover2006
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('howLongToBeat: findBestHltbMatch prevents rejected higher-sim non-prefix candidates from clobbering accepted base-prefix matches, and cold-boot writes merge with IDB hydration instead of overwriting the vault', async () => {
      // 9 tokens total; 5-word base prefix before colon -> base-only match has sim = 5/9 (~0.556) & isBasePrefixMatch: true
      // Non-prefix distractor has 7/12 (~0.583) similarity (< 0.60) & isBasePrefixMatch: false -> rejected!
      const queryTitle = 'Alpha Beta Gamma Delta Epsilon: Zeta Eta Theta Iota';
      const acceptedPrefixCandidate = {
        game_id: 1001,
        game_name: 'Alpha Beta Gamma Delta Epsilon',
        comp_main: 36000,
      };
      const rejectedHigherSimCandidate = {
        game_id: 2002,
        game_name: 'Alpha Beta Gamma Delta Epsilon Zeta Eta Extra1 Extra2 Extra3 Extra4 Extra5',
        comp_main: 72000,
      };

      expect(
        findBestHltbMatch(queryTitle, [rejectedHigherSimCandidate, acceptedPrefixCandidate])?.game_id
      ).toBe(1001);
      expect(
        findBestHltbMatch(queryTitle, [acceptedPrefixCandidate, rejectedHigherSimCandidate])?.game_id
      ).toBe(1001);

      // IDB cold-boot hydration-before-write barrier (fresh module import with deferred vaultGet)
      const deferredVaultRead = Promise.withResolvers<Record<string, unknown> | undefined>();
      testEnv.setCustomVaultGetHandler((key: string) =>
        key === 'hltb_lru_v3' ? deferredVaultRead.promise : undefined
      );

      const vaultSetSpy = vi.mocked(indexedDbVault.vaultSet);
      vaultSetSpy.mockClear();

      vi.resetModules();
      const freshHltb = await import('../src/services/hltb/howLongToBeat');

      // Write an early cold-boot entry BEFORE IDB hydration resolves, then trigger immediate pagehide/beforeunload flush
      freshHltb.seedHltbFromVaultIfMissing('Cold Boot Frontier', 9901, {
        mainStoryHours: 14,
        mainExtraHours: 22,
        completionistHours: 35,
        allStylesHours: 18,
      });
      (testEnv.windowObj.dispatchEvent as (e: Event) => boolean)(new Event('beforeunload'));
      await flushMicrotasks();

      // Barrier check: MUST NOT overwrite 'hltb_lru_v3' before hydration completes
      const prematureWrites = vaultSetSpy.mock.calls.filter(([k]) => k === 'hltb_lru_v3');
      expect(prematureWrites).toHaveLength(0);

      // Now resolve IDB hydration with pre-existing vault entries
      deferredVaultRead.resolve({
        'vault legacy alpha': {
          mainStoryHours: 30,
          mainExtraHours: 45,
          completionistHours: 60,
          allStylesHours: 40,
          isAccurate: true,
          cachedAt: Date.now() - 10000,
        },
        'vault legacy beta': {
          mainStoryHours: 8,
          mainExtraHours: 12,
          completionistHours: 16,
          allStylesHours: 10,
          isAccurate: true,
          cachedAt: Date.now() - 10000,
        },
      });
      await flushMicrotasks(10);

      // Deferred vault flush MUST now write the MERGED dictionary containing both pre-existing vault entries + cold-boot write!
      const mergedWrites = vaultSetSpy.mock.calls.filter(([k]) => k === 'hltb_lru_v3');
      expect(mergedWrites.length).toBeGreaterThanOrEqual(1);
      const finalPayload = mergedWrites[mergedWrites.length - 1][1] as Record<string, unknown>;
      expect(finalPayload['vault legacy alpha']).toBeDefined();
      expect(finalPayload['vault legacy beta']).toBeDefined();
      expect(finalPayload['cold boot frontier']).toBeDefined();
      expect(finalPayload['app_9901']).toBeDefined();
    });
  });

  // =========================================================================
  // 3. Network Scheduler, Sync Job Manager, Staged Cache, Filters, Scanner & Sanitizer
  // =========================================================================
  describe('3. Network Scheduler, Sync Job Manager, Staged Cache, Filters, Scanner & HTML Sanitizer (W1-B & W3-C)', () => {
    it('syncJobManager resumes all concurrently paused chunk workers cleanly without deadlock (pauseResolvers[])', async () => {
      const games: CanonicalGame[] = [
        makeCanonicalGame({
          id: 'steam-81001',
          title: 'Concurrent Worker One',
          steamAppId: 81001,
          platforms: [{ platformId: 'steam', platformGameId: '81001', installed: false }],
        }),
        makeCanonicalGame({
          id: 'steam-81002',
          title: 'Concurrent Worker Two',
          steamAppId: 81002,
          platforms: [{ platformId: 'steam', platformGameId: '81002', installed: false }],
        }),
        makeCanonicalGame({
          id: 'steam-81003',
          title: 'Concurrent Worker Three',
          steamAppId: 81003,
          platforms: [{ platformId: 'steam', platformGameId: '81003', installed: false }],
        }),
      ];

      vi.spyOn(wikidataBridge, 'batchResolveByStoreIds').mockResolvedValue(new Map());
      const resolvedTitles: string[] = [];
      vi.spyOn(criticScoreService, 'resolveDynamicScore').mockImplementation(async (title) => {
        resolvedTitles.push(title);
        return {
          source: 'metacritic',
          score: 84,
          tier: 'Strong',
          url: `https://www.metacritic.com/game/${title.toLowerCase().replace(/\s+/g, '-')}/`,
          isVerified: true,
        };
      });

      // Trigger pause on the chunk-start state update right BEFORE Promise.all launches all 3 chunk workers
      let pausedJobId: string | null = null;
      const unsub = syncJobManager.subscribe((state) => {
        if (
          !pausedJobId &&
          state &&
          state.type === 'critic_scores' &&
          state.status === 'running' &&
          state.current === 0 &&
          state.total === 3
        ) {
          pausedJobId = state.id;
          syncJobManager.pauseJob(state.id);
        }
      });

      const syncPromise = syncJobManager.startCriticScoreSync(games, { forceRefresh: true });
      await flushMicrotasks(12);

      // All 3 chunk workers are now suspended on pauseResolvers[] while job is paused
      expect(pausedJobId).not.toBeNull();
      expect(syncJobManager.getState()?.status).toBe('paused');
      expect(resolvedTitles).toHaveLength(0);

      // Resuming MUST wake ALL 3 paused workers (never deadlocking on a single overwritten resolver)
      syncJobManager.resumeJob(pausedJobId!);
      await syncPromise;
      unsub();

      expect(resolvedTitles.sort()).toEqual([
        'Concurrent Worker One',
        'Concurrent Worker Three',
        'Concurrent Worker Two',
      ]);
      expect(syncJobManager.getState()?.status).toBe('completed');
      expect(syncJobManager.getState()?.current).toBe(3);
    });

    it('requestScheduler clears probeInFlight when an in-flight HALF_OPEN canary probe is aborted so subsequent requests proceed without wedging', async () => {
      // Put lutris.net into a short cooldown and let it expire so bucket.wasCoolingDown === true (HALF_OPEN)
      requestScheduler.setCooldown('lutris.net', 0.015);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(requestScheduler.isRateLimited('lutris.net')).toBe(false);

      const canaryController = new AbortController();
      let canaryStarted = false;
      let followUpExecuted = false;

      const canaryPromise = requestScheduler.schedule(
        'https://lutris.net/api/games?search=canary',
        () =>
          new Promise<string>((_resolve, reject) => {
            canaryStarted = true;
            canaryController.signal.addEventListener(
              'abort',
              () => {
                const err = new Error('Canary aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true }
            );
          }),
        RequestPriority.P1_VIEWPORT,
        { domainKey: 'lutris.net', signal: canaryController.signal }
      );

      // Schedule a second request while the HALF_OPEN canary probe is in flight
      const followUpPromise = requestScheduler.schedule(
        'https://lutris.net/api/games?search=followup',
        async () => {
          followUpExecuted = true;
          return 'recovered-ok';
        },
        RequestPriority.P1_VIEWPORT,
        'lutris.net'
      );

      await flushMicrotasks();
      expect(canaryStarted).toBe(true);
      expect(followUpExecuted).toBe(false);

      // Abort the in-flight canary probe -> probeInFlight MUST clear and unblock followUpPromise
      canaryController.abort();
      await expect(canaryPromise).rejects.toThrow();

      const followUpResult = await followUpPromise;
      expect(followUpExecuted).toBe(true);
      expect(followUpResult).toBe('recovered-ok');
    });

    it('stagedCacheService: clearExpiredStagedCache() deletes expired negative/transient_error entries from IDB while preserving expired positive fresh/mature entries for offline fallback', async () => {
      const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const negKey = 'antigravity_staged_r4_expired_neg';
      const transientKey = 'antigravity_staged_r4_expired_transient';
      const freshKey = 'antigravity_staged_r4_expired_fresh';
      const matureKey = 'antigravity_staged_r4_expired_mature';

      saveStagedCache(negKey, null, 'negative', { cachedAt: oneYearAgo });
      saveStagedCache(transientKey, null, 'transient_error', {
        cachedAt: oneYearAgo,
        failureReason: 'rate_limited',
      });
      saveStagedCache(freshKey, { score: 88, source: 'metacritic' }, 'fresh', {
        cachedAt: oneYearAgo,
      });
      saveStagedCache(matureKey, { score: 92, source: 'metacritic' }, 'mature', {
        cachedAt: oneYearAgo,
      });

      // Flush coalesced microtask vault writes so all 4 exist in IDB
      await flushMicrotasks(8);
      expect(testEnv.idbStore.has(`staged:${negKey}`)).toBe(true);
      expect(testEnv.idbStore.has(`staged:${transientKey}`)).toBe(true);
      expect(testEnv.idbStore.has(`staged:${freshKey}`)).toBe(true);
      expect(testEnv.idbStore.has(`staged:${matureKey}`)).toBe(true);

      vi.mocked(indexedDbVault.vaultDelete).mockClear();

      clearExpiredStagedCache();
      await flushMicrotasks(8);

      // Expired negative & transient_error tiers MUST be deleted from IDB
      expect(testEnv.idbStore.has(`staged:${negKey}`)).toBe(false);
      expect(testEnv.idbStore.has(`staged:${transientKey}`)).toBe(false);

      // Expired positive tiers ('fresh' and 'mature') MUST be preserved in IDB for offline fallback
      expect(testEnv.idbStore.has(`staged:${freshKey}`)).toBe(true);
      expect(testEnv.idbStore.has(`staged:${matureKey}`)).toBe(true);

      const hydratedFresh = await hydrateStagedCacheKeyFromVault<{ score: number }>(freshKey);
      const hydratedMature = await hydrateStagedCacheKeyFromVault<{ score: number }>(matureKey);
      expect(hydratedFresh?.data?.score).toBe(88);
      expect(hydratedMature?.data?.score).toBe(92);
    });

    it('gameFilterService platform filter does NOT match EA games for steam ("steam".includes("ea") bug fixed) and studio filter respects word boundaries', () => {
      const eaOnlyGame = makeCanonicalGame({
        id: 'ea-9001',
        title: 'Apex Horizon EA',
        developers: ['EA Sports'],
        platforms: [{ platformId: 'ea', platformGameId: 'ea-9001', installed: true }],
      });
      const steamOnlyGame = makeCanonicalGame({
        id: 'steam-9002',
        title: 'Valiant Quest Steam',
        developers: ['Creative Assembly', 'Obsidian Entertainment'],
        platforms: [{ platformId: 'steam', platformGameId: '9002', installed: true }],
      });

      expect(
        matchesGameFilter(eaOnlyGame, { type: 'platform', label: 'Steam', value: 'steam' })
      ).toBe(false);
      expect(
        matchesGameFilter(steamOnlyGame, { type: 'platform', label: 'Steam', value: 'steam' })
      ).toBe(true);
      expect(
        matchesGameFilter(steamOnlyGame, { type: 'platform', label: 'EA', value: 'ea' })
      ).toBe(false);
      expect(
        matchesGameFilter(eaOnlyGame, { type: 'platform', label: 'EA', value: 'ea' })
      ).toBe(true);
      expect(
        matchesGameFilter(eaOnlyGame, { type: 'platform', label: 'EA App', value: 'EA App' })
      ).toBe(true);

      // Short studio token boundary checks
      expect(matchesStudioFilter('Creative Assembly', 'EA')).toBe(false);
      expect(matchesStudioFilter('Obsidian Entertainment', 'id')).toBe(false);
      expect(matchesStudioFilter('EA Sports', 'EA')).toBe(true);
    });

    it('localSystemScanner preserves all 12 storefronts without corrupting them to steam and retains handoff/bottle metadata', async () => {
      const allTwelveStorefronts: StorefrontId[] = [
        'steam',
        'gog',
        'epic',
        'xbox',
        'ea',
        'ubisoft',
        'bnet',
        'amazon',
        'itch',
        'rockstar',
        'humble',
        'custom',
      ];

      const rawScanned = allTwelveStorefronts.map((storeId, idx) => ({
        platformId: storeId,
        platformGameId: storeId === 'steam' ? String(50000 + idx) : `${storeId}-game-${idx}`,
        appId: storeId === 'steam' ? 50000 + idx : undefined,
        title: `Synthetic ${storeId.toUpperCase()} Title`,
        installPath: `/Users/testuser/Games/${storeId}/game-${idx}`,
        executablePath: `/Users/testuser/Games/${storeId}/game-${idx}/game.exe`,
        installSize: 4 * 1024 * 1024 * 1024,
        externalStorefrontHandoff: storeId === 'epic' ? 'ea' : undefined,
        chainedLauncherHandoff: storeId === 'epic' ? 'ea' : undefined,
        chainedExternalInstallId: storeId === 'epic' ? 'ea-chained-77' : undefined,
        chainedHandoffTopology: storeId === 'epic' ? ('partner_launcher_link' as const) : undefined,
        epicPartnerRegistryPath: storeId === 'epic' ? 'HKLM\\SOFTWARE\\EA Games\\Test' : undefined,
        bottleName: `Bottle-${storeId}`,
        runner: 'crossover' as const,
        xboxBottleCompatibilityTier: storeId === 'xbox' ? 'playable' : undefined,
        isWindowsBinaryOnMac: true,
        executableArchitecture: 'x86_64',
        is32BitExecutable: false,
      }));

      testEnv.windowObj.electronAPI = {
        scanAllInstalledGames: vi.fn(async () => ({
          success: true,
          installedSteamAppIds: [50000],
          installedGames: rawScanned,
        })),
      } as Partial<ElectronAPI>;

      const scanResult = await scanLocalInstalledGames();
      expect(scanResult?.success).toBe(true);
      expect(scanResult?.installedGames).toHaveLength(12);

      const scannedByPlatform = new Map(
        (scanResult?.installedGames ?? []).map((item) => [item.platformId, item])
      );
      for (const storeId of allTwelveStorefronts) {
        const entry = scannedByPlatform.get(storeId);
        expect(entry, `Storefront ${storeId} must be preserved intact`).toBeDefined();
        expect(entry?.platformId).toBe(storeId);
        expect(entry?.bottleName).toBe(`Bottle-${storeId}`);
        expect(entry?.runner).toBe('crossover');
        expect(entry?.isWindowsBinaryOnMac).toBe(true);
        expect(entry?.executableArchitecture).toBe('x86_64');
        if (storeId !== 'steam') {
          expect(entry?.appId).toBe(0);
        } else {
          expect(entry?.appId).toBe(50000);
        }
      }

      const epicEntry = scannedByPlatform.get('epic');
      expect(epicEntry?.externalStorefrontHandoff).toBe('ea');
      expect(epicEntry?.chainedLauncherHandoff).toBe('ea');
      expect(epicEntry?.chainedExternalInstallId).toBe('ea-chained-77');
      expect(epicEntry?.chainedHandoffTopology).toBe('partner_launcher_link');
      expect(epicEntry?.epicPartnerRegistryPath).toBe('HKLM\\SOFTWARE\\EA Games\\Test');
    });

    it('htmlSanitizer / safeHtmlSanitizer strips Tailwind overlay classes while keeping bb_*/steam_*/lead, rejects invalid ol-media://evil/.., maps <time datetime> to dateTime, and preserves // inside <code>', () => {
      const restoreDom = installInertDomParserHarness();
      try {
        // Direct utility invariants
        expect(sanitizeStoreClassValue('fixed inset-0 z-50 bg-black bb_tag steam_banner lead')).toBe(
          'bb_tag steam_banner lead'
        );
        expect(sanitizeAllowedStoreUri('ol-media://evil/../../etc/passwd')).toBe('');
        expect(sanitizeAllowedStoreUri('ol-media://covers/../../secret.png')).toBe('');
        expect(sanitizeAllowedStoreUri('javascript:alert(1)')).toBe('');
        expect(
          sanitizeAllowedStoreUri(
            'ol-media://asset?url=https%3A%2F%2Fcdn.example.invalid%2Fart.jpg'
          )
        ).toBe('ol-media://asset?url=https%3A%2F%2Fcdn.example.invalid%2Fart.jpg');

        const dirtyHtml = [
          '<div class="fixed inset-0 z-50 bg-black bb_tag steam_card lead">Overlay Guard</div>',
          '<img src="ol-media://evil/../../etc/passwd" alt="blocked" />',
          '<img src="ol-media://asset?url=https%3A%2F%2Fcdn.example.invalid%2Fok.jpg" alt="allowed" />',
          '<a href="//cdn.example.invalid/changelog">Changelog</a>',
          '<time datetime="2026-05-01">May 1, 2026</time>',
          '<code>const path = "//keep-slashes"; // inline comment</code>',
        ].join('');

        // 1. Fragment & string sanitization path
        const sanitizedStr = sanitizeStoreHtml(dirtyHtml);
        expect(sanitizedStr).toContain('class="bb_tag steam_card lead"');
        expect(sanitizedStr).not.toContain('fixed');
        expect(sanitizedStr).not.toContain('inset-0');
        expect(sanitizedStr).not.toContain('z-50');
        expect(sanitizedStr).not.toContain('bg-black');
        expect(sanitizedStr).not.toContain('ol-media://evil');
        expect(sanitizedStr).toContain(
          'ol-media://asset?url=https%3A%2F%2Fcdn.example.invalid%2Fok.jpg'
        );
        expect(sanitizedStr).toContain('href="https://cdn.example.invalid/changelog"');
        expect(sanitizedStr).toContain('rel="noopener noreferrer"');
        expect(sanitizedStr).toContain('//keep-slashes');
        expect(sanitizedStr).not.toContain('https://keep-slashes');

        // 2. React element tree via SanitizedHtmlBlock (verifying React camelCase dateTime prop!)
        const blockHarness = createComponentHarness(SanitizedHtmlBlock, {
          html: dirtyHtml,
          testId: 'r4-sanitized-block',
        });
        const tree = blockHarness.render();
        const timeEls = findElements(tree, (el) => el.type === 'time');
        expect(timeEls).toHaveLength(1);
        expect(timeEls[0].props?.dateTime).toBe('2026-05-01');
        expect(timeEls[0].props?.datetime).toBeUndefined();

        const codeEls = findElements(tree, (el) => el.type === 'code');
        expect(codeEls).toHaveLength(1);
        expect(String(codeEls[0].props?.children)).toContain('//keep-slashes');
        expect(String(codeEls[0].props?.children)).not.toContain('https://keep-slashes');

        const divEls = findElements(
          tree,
          (el) => el.type === 'div' && el.props?.['data-testid'] !== 'r4-sanitized-block'
        );
        expect(divEls[0]?.props?.className).toBe('bb_tag steam_card lead');

        const ssrHtml = renderToString(
          React.createElement(SanitizedHtmlBlock, { html: dirtyHtml, testId: 'r4-ssr-block' })
        );
        expect(ssrHtml).toMatch(/<time date[Tt]ime="2026-05-01">May 1, 2026<\/time>/);
        expect(ssrHtml).toContain('const path = &quot;//keep-slashes&quot;; // inline comment');
        expect(ssrHtml).not.toContain('ol-media://evil');

        // Ensure fragment helper itself returns a valid sanitized fragment
        const frag = sanitizeSafeDomFragment('<p class="fixed bb_paragraph">Hello</p>');
        expect(frag).not.toBeNull();
        blockHarness.unmount();
      } finally {
        restoreDom();
      }
    });
  });

  // =========================================================================
  // 4. React 19 Frontend, Modal Focus, Scroll Perf, Carousel & WCAG
  // =========================================================================
  describe('4. React 19 Frontend, Modal Focus, Scroll Perf, Carousel & WCAG (W4-A..W4-E)', () => {
    it('modalOverlayLock never sets #root[inert], ignores stale release() closures after emergencyResetModalOverlayLock() via lockGeneration, and clears stray inert on emergency reset', () => {
      testEnv.setOpenDialogCount(1);

      const releaseStale = acquireModalOverlayLock();
      expect(testEnv.documentElement.getAttribute('data-modal-overlay-open')).toBe('true');
      expect(isModalOverlayOpen()).toBe(true);
      // MUST NOT set #root[inert] (breaks native <dialog>.showModal() focus restoration)
      expect(testEnv.rootElement.setAttribute).not.toHaveBeenCalledWith('inert', expect.anything());
      expect(testEnv.rootElement.hasAttribute('inert')).toBe(false);

      // Simulate a stray inert attribute left behind by an external crash
      testEnv.rootElementAttrs.set('inert', '');
      expect(testEnv.rootElement.hasAttribute('inert')).toBe(true);

      emergencyResetModalOverlayLock();
      expect(testEnv.rootElement.hasAttribute('inert')).toBe(false);
      expect(testEnv.rootElement.removeAttribute).toHaveBeenCalledWith('inert');
      expect(testEnv.documentElement.getAttribute('data-modal-overlay-open')).toBeNull();
      expect(isModalOverlayOpen()).toBe(false);

      // Acquire a brand-new modal lock after emergency reset
      const releaseFresh = acquireModalOverlayLock();
      expect(isModalOverlayOpen()).toBe(true);
      expect(testEnv.documentElement.getAttribute('data-modal-overlay-open')).toBe('true');

      // Calling the stale release closure from before the reset MUST be ignored by lockGeneration!
      releaseStale();
      expect(isModalOverlayOpen()).toBe(true);
      expect(testEnv.documentElement.getAttribute('data-modal-overlay-open')).toBe('true');

      // Only the current-generation release closes the lock
      releaseFresh();
      expect(isModalOverlayOpen()).toBe(false);
      expect(testEnv.documentElement.getAttribute('data-modal-overlay-open')).toBeNull();
    });

    it('src/index.css defines WCAG 1.4.11 compliant --scrollbar-thumb (#4c799c >= 3:1 vs #0f161e), standard scrollbar-color/scrollbar-width: thin, @supports not (scrollbar-color: auto), and dialog:modal overscroll containment', () => {
      const css = fs.readFileSync(path.join(REPO_ROOT, 'src/index.css'), 'utf8');

      const trackMatch = css.match(/--scrollbar-track\s*:\s*(#[0-9a-fA-F]{6})\s*;/);
      const thumbMatch = css.match(/--scrollbar-thumb\s*:\s*(#[0-9a-fA-F]{6})\s*;/);
      expect(trackMatch?.[1]?.toLowerCase()).toBe('#0f161e');
      expect(thumbMatch?.[1]?.toLowerCase()).toBe('#4c799c');

      const ratio = contrastRatio(thumbMatch![1], trackMatch![1]);
      expect(ratio).toBeGreaterThanOrEqual(3.0);

      expect(css).toMatch(/scrollbar-color\s*:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)\s*;/);
      expect(css).toMatch(/scrollbar-width\s*:\s*thin\s*;/);
      expect(css).toMatch(/@supports\s+not\s*\(\s*scrollbar-color\s*:\s*auto\s*\)/);
      expect(css).toMatch(/dialog:modal\s*\{[^}]*overscroll-behavior\s*:\s*contain\s*;/);
    });

    it('MediaGallery + SteamStorePage: re-rendering with same gameId and empty/fresh movies & screenshots does NOT reset activeIndex back to 0', () => {
      const screenshots: SteamScreenshot[] = [
        {
          id: 1,
          pathThumbnail: 'https://cdn.example.invalid/shot1-thumb.jpg',
          pathFull: 'https://cdn.example.invalid/shot1-full.jpg',
        },
        {
          id: 2,
          pathThumbnail: 'https://cdn.example.invalid/shot2-thumb.jpg',
          pathFull: 'https://cdn.example.invalid/shot2-full.jpg',
        },
        {
          id: 3,
          pathThumbnail: 'https://cdn.example.invalid/shot3-thumb.jpg',
          pathFull: 'https://cdn.example.invalid/shot3-full.jpg',
        },
      ];
      const emptyMovies: SteamMovie[] = [];

      const galleryHarness = createComponentHarness(MediaGallery, {
        gameId: 'steam-42000',
        title: 'Carousel Stability Title',
        screenshots,
        movies: emptyMovies,
        autoplay: false,
      });

      const tree0 = galleryHarness.render();
      const getThumbButtons = (tree: ReactElementLike | null) =>
        findElements(
          tree,
          (el) =>
            el.type === 'button' &&
            typeof el.props?.onClick === 'function' &&
            findElements(el, (child) => child.type === 'img').some((img) =>
              String(img.props?.src || '').includes('thumb.jpg')
            )
        );
      const getActiveShowcaseImgSrcs = (tree: ReactElementLike | null) =>
        findElements(tree, (el) => el.type === 'img')
          .map((img) => String(img.props?.src || ''))
          .filter((src) => src.includes('-full.jpg'));

      const thumbButtons = getThumbButtons(tree0);
      expect(thumbButtons.length).toBe(3);

      // Select screenshot #3 (index 2)
      (thumbButtons[2].props?.onClick as () => void)();
      const treeAtIndex2 = galleryHarness.render();
      expect(getActiveShowcaseImgSrcs(treeAtIndex2)).toContain(
        'https://cdn.example.invalid/shot3-full.jpg'
      );

      // Re-render with the SAME gameId, brand-new empty movies array reference, and cloned screenshots array
      galleryHarness.render({
        gameId: 'steam-42000',
        movies: [],
        screenshots: screenshots.map((s) => ({ ...s })),
      });
      const treeAfterSameGameEffects = galleryHarness.render();
      expect(getActiveShowcaseImgSrcs(treeAfterSameGameEffects)).toContain(
        'https://cdn.example.invalid/shot3-full.jpg'
      );

      // Switching to a DIFFERENT gameId DOES reset activeIndex back to 0 (verify after effect flush)
      galleryHarness.render({
        gameId: 'steam-99999',
        movies: [],
        screenshots,
      });
      const treeDifferentGame = galleryHarness.render();
      expect(getActiveShowcaseImgSrcs(treeDifferentGame)).toContain(
        'https://cdn.example.invalid/shot1-full.jpg'
      );
      galleryHarness.unmount();

      // SteamStorePage passes referentially stable EMPTY_SCREENSHOTS / EMPTY_MOVIES across re-renders
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
      vi.spyOn(criticScoreService, 'resolveDynamicScore').mockResolvedValue(null);

      const gameWithoutMedia = makeCanonicalGame({
        id: 'gog-7707',
        title: 'Stable Empty Media Page',
        platforms: [{ platformId: 'gog', platformGameId: '7707', installed: true }],
        enrichedMetadata: {
          ...makeSteamEnrichedMetadata({ appId: 0, name: 'Stable Empty Media Page' }),
          screenshots: undefined as unknown as SteamScreenshot[],
          movies: undefined as unknown as SteamMovie[],
        },
      });

      const pageHarness = createComponentHarness(SteamStorePage, {
        game: gameWithoutMedia,
      });
      const pageTree1 = pageHarness.render();
      const pageTree2 = pageHarness.render({
        game: { ...gameWithoutMedia },
      });

      const findMemoGallery = (tree: ReactElementLike | null) =>
        findElements(
          tree,
          (el) =>
            Boolean(el.props) &&
            Array.isArray(el.props?.screenshots) &&
            Array.isArray(el.props?.movies) &&
            el.props?.gameId === 'gog-7707'
        )[0];

      const galleryEl1 = findMemoGallery(pageTree1);
      const galleryEl2 = findMemoGallery(pageTree2);
      expect(galleryEl1).toBeDefined();
      expect(galleryEl2).toBeDefined();
      expect(galleryEl1.props?.screenshots).toBe(galleryEl2.props?.screenshots);
      expect(galleryEl1.props?.movies).toBe(galleryEl2.props?.movies);
      pageHarness.unmount();
    });

    it('ManageCollectionsModal: Escape during inline rename calls preventDefault() and cancels rename without closing modal, and trash click requires two-step confirmation before onDeleteCollection', () => {
      const collections: GameCollection[] = [
        { id: 'col-a', name: 'Alpha RPGs', icon: 'swords', gameIds: ['game-1'] },
        { id: 'col-b', name: 'Beta Strategy', icon: 'crown', gameIds: ['game-2'] },
      ];
      const onClose = vi.fn();
      const onDeleteCollection = vi.fn();
      const onRenameCollection = vi.fn();

      const modalHarness = createComponentHarness(ManageCollectionsModal, {
        isOpen: true,
        onClose,
        collections,
        onCreateCollection: vi.fn(),
        onRenameCollection,
        onDeleteCollection,
        onToggleGameInCollection: vi.fn(),
      });

      const initialTree = modalHarness.render();

      // 1. Start inline rename for Alpha RPGs
      const editBtn = findElements(
        initialTree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Edit Alpha RPGs'
      )[0];
      expect(editBtn).toBeDefined();
      (editBtn.props?.onClick as () => void)();

      const editingTree = modalHarness.render();
      const renameInput = findElements(
        editingTree,
        (el) => el.type === 'input' && el.props?.type === 'text' && el.props?.value === 'Alpha RPGs'
      )[0];
      expect(renameInput).toBeDefined();

      // Press Escape in inline rename input -> MUST call preventDefault() + stopPropagation(), cancel edit, NOT close modal
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      (renameInput.props?.onKeyDown as (e: Record<string, unknown>) => void)({
        key: 'Escape',
        preventDefault,
        stopPropagation,
      });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(stopPropagation).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(onRenameCollection).not.toHaveBeenCalled();

      const afterEscapeTree = modalHarness.render();
      expect(
        findElements(
          afterEscapeTree,
          (el) => el.type === 'input' && el.props?.type === 'text'
        )
      ).toHaveLength(0);

      // 2. Two-step delete confirmation guard
      const trashBtn = findElements(
        afterEscapeTree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Delete Alpha RPGs'
      )[0];
      expect(trashBtn).toBeDefined();
      (trashBtn.props?.onClick as () => void)();

      // First trash click MUST NOT invoke onDeleteCollection immediately!
      expect(onDeleteCollection).not.toHaveBeenCalled();

      const confirmTree = modalHarness.render();
      const confirmDeleteBtn = findElements(
        confirmTree,
        (el) =>
          el.type === 'button' && el.props?.['data-testid'] === 'confirm-delete-collection-col-a'
      )[0];
      const cancelDeleteBtn = findElements(
        confirmTree,
        (el) =>
          el.type === 'button' && el.props?.['data-testid'] === 'cancel-delete-collection-col-a'
      )[0];
      expect(confirmDeleteBtn).toBeDefined();
      expect(cancelDeleteBtn).toBeDefined();

      // Clicking confirm triggers onDeleteCollection once
      (confirmDeleteBtn.props?.onClick as () => void)();
      expect(onDeleteCollection).toHaveBeenCalledTimes(1);
      expect(onDeleteCollection).toHaveBeenCalledWith('col-a');
      expect(onClose).not.toHaveBeenCalled();
      modalHarness.unmount();
    });

    it('useCatalogOverrideSync deterministically calls saveCurrentCatalog under React 19 batched setGames updates (both apply and reset)', () => {
      const initialGame = makeCanonicalGame({
        id: 'gog-5555',
        title: 'Original Store Title',
        platforms: [{ platformId: 'gog', platformGameId: '5555', installed: false }],
      });

      const gamesRef = { current: [initialGame] as CanonicalGame[] };
      const pendingStateUpdaters: Array<React.SetStateAction<CanonicalGame[]>> = [];
      // Simulate React 19 automatic batching: setGames queues updaters without executing them synchronously!
      const batchedSetGames: React.Dispatch<React.SetStateAction<CanonicalGame[]>> = vi.fn(
        (updater) => {
          pendingStateUpdaters.push(updater);
        }
      );

      const saveCatalogSpy = vi
        .spyOn(integrationStorageModule, 'saveCurrentCatalog')
        .mockImplementation(() => {});
      const onCatalogPersisted = vi.fn();
      const showSyncNotice = vi.fn();

      const hookHarness = createHookHarness(() =>
        useCatalogOverrideSync({
          selectedGame: initialGame,
          isGridView: true,
          navigateHome: vi.fn(),
          setGames: batchedSetGames,
          gamesRef,
          setGameRefreshKey: vi.fn(),
          onCatalogPersisted,
          showSyncNotice,
        })
      );

      // 1. handleApplyOverride MUST persist synchronously even while batched setGames updaters are still pending
      const override = makeUserGameOverride({
        gameId: 'gog-5555',
        platformId: 'gog',
        platformGameId: '5555',
        title: 'Corrected Remastered Title',
        matchedStore: 'gog',
      });

      hookHarness.current.handleApplyOverride(override);

      expect(pendingStateUpdaters.length).toBeGreaterThanOrEqual(1);
      expect(saveCatalogSpy).toHaveBeenCalledTimes(1);
      const [persistedAfterApply, applyOpts] = saveCatalogSpy.mock.calls[0];
      expect(persistedAfterApply.some((g) => g.title === 'Corrected Remastered Title')).toBe(true);
      expect(applyOpts?.skipSanitize).toBe(true);
      expect(onCatalogPersisted).toHaveBeenCalledTimes(1);
      expect(gamesRef.current.some((g) => g.title === 'Corrected Remastered Title')).toBe(true);

      // Flush batched updater cleanly
      let simulatedState = [initialGame];
      while (pendingStateUpdaters.length > 0) {
        const nextUpdater = pendingStateUpdaters.shift()!;
        simulatedState =
          typeof nextUpdater === 'function' ? nextUpdater(simulatedState) : nextUpdater;
      }
      expect(simulatedState.some((g) => g.title === 'Corrected Remastered Title')).toBe(true);

      // 2. handleResetOverride MUST also call saveCurrentCatalog deterministically BEFORE batched setGames runs
      saveCatalogSpy.mockClear();
      onCatalogPersisted.mockClear();

      hookHarness.current.handleResetOverride('gog-5555', {
        game: gamesRef.current[0],
        override,
      });

      expect(pendingStateUpdaters.length).toBeGreaterThanOrEqual(1);
      expect(saveCatalogSpy).toHaveBeenCalledTimes(1);
      const [persistedAfterReset, resetOpts] = saveCatalogSpy.mock.calls[0];
      expect(persistedAfterReset.some((g) => g.title === 'Original Store Title')).toBe(true);
      expect(resetOpts?.immediate).toBe(true);
      expect(onCatalogPersisted).toHaveBeenCalledTimes(1);

      hookHarness.unmount();
    });
  });
});
