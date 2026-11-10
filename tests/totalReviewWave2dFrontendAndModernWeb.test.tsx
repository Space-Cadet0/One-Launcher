import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import type { CanonicalGame } from '../src/contracts/game';
import type { UserGameOverride } from '../src/contracts/override';
import type { StorefrontIntegration } from '../src/contracts/integration';
import type { ElectronAPI } from '../src/types/electron';

type SyncStorePayload = Awaited<ReturnType<NonNullable<ElectronAPI['syncStore']>>>;
import {
  ALLOWED_STORE_ATTR,
  ALLOWED_STORE_ELEMENT_NAMES,
  enforceFragmentSecurityPolicy,
  sanitizeAllowedStoreUri,
  sanitizeSafeDomFragment,
  sanitizeSrcsetValue,
  sanitizeStoreHtml,
  upgradeProtocolRelativeUrl,
} from '../src/services/common/htmlSanitizer';
import * as safeHtmlSanitizerModule from '../src/utils/safeHtmlSanitizer';
import { SanitizedHtmlBlock } from '../src/utils/safeHtmlSanitizer';
import {
  clearSynopsisTextMemo,
  extractFirstParagraph,
  stripHtmlToPlainSynopsis,
} from '../src/services/common/synopsisTextUtils';
import { reconcileNativeStorefrontAuthSessions } from '../src/services/integrations/storefrontAuthReconciler';
import {
  loadIntegrations,
  saveCurrentCatalog,
  saveIntegrations,
} from '../src/services/integrations/integrationStorage';
import {
  TIER_4C_TRANSIENT_ERROR,
  clearExpiredStagedCache,
  clearStagedMemoryFallback,
  loadStagedCache,
  saveStagedCache,
} from '../src/services/storage/stagedCacheService';
import {
  failedCoverUrls,
  globalAttemptedCoverLookups,
} from '../src/components/Library/Grid/gridCoverUtils';
import { GameCardCover } from '../src/components/Library/Grid/GameCardCover';
import { isImeComposing } from '../src/utils/keyboardUtils';
import { isBackdropPoint } from '../src/components/Common/ModalShell';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import { SteamLanguagesTable } from '../src/components/SteamStoreDetail/SteamLanguagesTable';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { MediaGallery } from '../src/components/SteamStoreDetail/MediaGallery';
import {
  RequestPriority,
  requestScheduler,
} from '../src/services/network/requestScheduler';
import { syncJobManager } from '../src/services/network/syncJobManager';
import { useManualLibrarySyncActions } from '../src/hooks/useManualLibrarySyncActions';
import * as integrationStorageModule from '../src/services/integrations/integrationStorage';
import axios from 'axios';
import { FallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { applyUserOverrideToGame } from '../src/services/storage/userOverrideStorage';

const ROOT_DIR = path.resolve(__dirname, '..');

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

const mockLocalStorage = new MockStorage();
const globalRecord = globalThis as Record<string, unknown>;
if (typeof globalRecord.localStorage === 'undefined') {
  globalRecord.localStorage = mockLocalStorage;
}

function createSyntheticGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return {
    id: 'synthetic-game-alpha',
    title: 'Synthetic Studio Alpha',
    sortTitle: 'synthetic studio alpha',
    headerImage: 'https://cdn.example.invalid/headers/alpha-header.jpg',
    capsuleImage: 'https://cdn.example.invalid/covers/alpha-2x3.jpg',
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '100001',
        installed: true,
        playtimeMinutes: 90,
      },
    ],
    genres: ['Action'],
    tags: ['Singleplayer'],
    developers: ['Synthetic Dev'],
    publishers: ['Synthetic Pub'],
    ...overrides,
  };
}

interface SyntheticDomNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  textContent: string | null;
  parentNode: SyntheticDomNode | null;
  childNodes: SyntheticDomNode[];
  readonly firstChild: SyntheticDomNode | null;
  attributes: Array<{ name: string; value: string }>;
  appendChild: (child: SyntheticDomNode) => SyntheticDomNode;
  removeChild: (child: SyntheticDomNode) => SyntheticDomNode;
  hasAttribute: (name: string) => boolean;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  querySelectorAll: (selector: string) => SyntheticDomNode[];
}

function createSyntheticTextNode(text: string): SyntheticDomNode {
  return {
    nodeType: 3,
    nodeName: '#text',
    textContent: text,
    parentNode: null,
    childNodes: [],
    get firstChild() {
      return null;
    },
    attributes: [],
    appendChild(c) {
      return c;
    },
    removeChild(c) {
      return c;
    },
    hasAttribute: () => false,
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    querySelectorAll: () => [],
  };
}

function createSyntheticElement(
  tag: string,
  attrs: Record<string, string> = {},
  children: SyntheticDomNode[] = []
): SyntheticDomNode {
  const attrList = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  const node: SyntheticDomNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    get textContent() {
      return node.childNodes.map((c) => c.textContent ?? '').join('');
    },
    set textContent(val: string | null) {
      node.childNodes.length = 0;
      if (val) {
        node.appendChild(createSyntheticTextNode(val));
      }
    },
    parentNode: null,
    childNodes: [],
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    attributes: attrList,
    appendChild(child: SyntheticDomNode) {
      if (child.nodeType === 11) {
        const moved = [...child.childNodes];
        child.childNodes.length = 0;
        for (const item of moved) {
          item.parentNode = node;
          node.childNodes.push(item);
        }
        return child;
      }
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child: SyntheticDomNode) {
      const idx = node.childNodes.indexOf(child);
      if (idx >= 0) {
        node.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    hasAttribute(name: string) {
      const lower = name.toLowerCase();
      return node.attributes.some((a) => a.name.toLowerCase() === lower);
    },
    getAttribute(name: string) {
      const lower = name.toLowerCase();
      return node.attributes.find((a) => a.name.toLowerCase() === lower)?.value ?? null;
    },
    setAttribute(name: string, value: string) {
      const lower = name.toLowerCase();
      const existing = node.attributes.find((a) => a.name.toLowerCase() === lower);
      if (existing) {
        existing.value = value;
      } else {
        node.attributes.push({ name, value });
      }
    },
    removeAttribute(name: string) {
      const lower = name.toLowerCase();
      const idx = node.attributes.findIndex((a) => a.name.toLowerCase() === lower);
      if (idx >= 0) {
        node.attributes.splice(idx, 1);
      }
    },
    querySelectorAll(selector: string) {
      const results: SyntheticDomNode[] = [];
      const walk = (parent: SyntheticDomNode): void => {
        for (const child of parent.childNodes) {
          if (child.nodeType === 1) {
            if (selector === '*' || child.tagName?.toLowerCase() === selector.toLowerCase()) {
              results.push(child);
            }
            walk(child);
          }
        }
      };
      walk(node);
      return results;
    },
  };
  for (const child of children) {
    node.appendChild(child);
  }
  return node;
}

function createSyntheticFragment(children: SyntheticDomNode[] = []): SyntheticDomNode {
  const frag = createSyntheticElement('#document-fragment', {}, children);
  frag.nodeType = 11;
  frag.nodeName = '#document-fragment';
  delete frag.tagName;
  return frag;
}

interface HookHarness<R> {
  current: R;
  rerender: () => R;
}

function createHookHarness<R>(useHookFn: () => R): HookHarness<R> {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const reactInternalHolder = React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      H: Record<string, unknown>;
    };
  };

  const render = (): R => {
    let stateIdx = 0;
    let refIdx = 0;
    const prevH = reactInternalHolder.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;

    reactInternalHolder.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
      useState(initial: unknown) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        const setter = (updater: unknown) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(states[idx])
              : updater;
        };
        return [states[idx], setter];
      },
      useRef(initial: unknown) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useMemo(factory: () => unknown) {
        return factory();
      },
      useCallback(fn: unknown) {
        return fn;
      },
      useEffect() {},
      useLayoutEffect() {},
    };

    try {
      return useHookFn();
    } finally {
      reactInternalHolder.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = prevH;
    }
  };

  const initialResult = render();
  const harness: HookHarness<R> = {
    current: initialResult,
    rerender() {
      harness.current = render();
      return harness.current;
    },
  };
  return harness;
}

describe('Wave 2D: Frontend Architecture, Vite Bundle DAG, React 19 Concurrency & Modern Web Platform', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    clearSynopsisTextMemo();
    failedCoverUrls.clear();
    globalAttemptedCoverLookups.clear();
    clearStagedMemoryFallback();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rank 1 & Rank 4: Vite 3-Layer Service DAG, Lazy Action-Bar Modals & Steam Scanner Delegation', () => {
    it('configures cycle-free 3-layer service chunks, removes empty stubs, and delegates local Steam scanning to steamLocalScanner.cjs', () => {
      const viteConfigSrc = fs.readFileSync(path.join(ROOT_DIR, 'vite.config.ts'), 'utf8');

      expect(viteConfigSrc).not.toContain("'store-steam-enriched'");
      expect(viteConfigSrc).not.toContain("'store-gog-enriched'");
      expect(viteConfigSrc).not.toContain("'store-epic-library'");

      expect(viteConfigSrc).toContain("return 'services-foundation'");
      expect(viteConfigSrc).toContain("return 'services-catalog'");
      expect(viteConfigSrc).toContain("return 'services-launcher'");

      expect(viteConfigSrc).toContain('./electron/storefronts/steamLocalScanner.cjs');
      expect(viteConfigSrc).toContain('resolveLocalSteamUserdataDirs');
      expect(viteConfigSrc).toContain('scanLocalSteamAchievements');
      expect(viteConfigSrc).not.toContain('readdirSync');
      expect(viteConfigSrc).not.toContain('readFileSync');
    });

    it('lazy-loads GameInstallModal and omits closed action-bar modal subtrees from initial render output', () => {
      const actionBarSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/SteamStoreDetail/SteamLibraryActionBar.tsx'),
        'utf8'
      );
      expect(actionBarSrc).toContain("import('../Launcher/GameInstallModal')");
      expect(actionBarSrc).toContain('{isInstallModalOpen && (');

      const game = createSyntheticGame();
      const html = renderToString(<SteamLibraryActionBar game={game} />);
      expect(html).not.toContain('install-modal-overlay');
      expect(html).not.toContain('launch-config-modal-overlay');
    });
  });

  describe('Rank 2: Live-Snapshot Manual Library Sync & Priority Scopes (useManualLibrarySyncActions)', () => {
    it('commits manual storefront sync against live gamesRef/setGames state without clobbering concurrent user updates', async () => {
      const prevWin = globalRecord.window;
      const initialGame = createSyntheticGame({
        id: 'synthetic-live-1',
        title: 'Synthetic Live Title',
        sortTitle: 'synthetic live title',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: 'gog-501',
            installed: false,
            playtimeMinutes: 30,
          },
        ],
      });

      let liveGames: CanonicalGame[] = [initialGame];
      const gamesRef: { current: CanonicalGame[] } = { current: liveGames };
      const setGames = (updater: React.SetStateAction<CanonicalGame[]>) => {
        liveGames = typeof updater === 'function' ? updater(liveGames) : updater;
        gamesRef.current = liveGames;
      };

      const gogIntegration: StorefrontIntegration = {
        storefrontId: 'gog',
        name: 'GOG.com',
        isConnected: true,
        gamesCount: 1,
        lastSyncedAt: new Date(0).toISOString(),
        credentials: { gogToken: '[MANAGED_BY_NATIVE_VAULT]' },
      };

      let notifyGogSyncStarted!: () => void;
      const gogSyncStartedPromise = new Promise<void>((resolve) => {
        notifyGogSyncStarted = resolve;
      });
      let resolveSyncStore!: (res: SyncStorePayload) => void;
      const syncStorePromise = new Promise<SyncStorePayload>((resolve) => {
        resolveSyncStore = resolve;
      });

      globalRecord.window = {
        localStorage: mockLocalStorage,
        dispatchEvent: () => true,
        electronAPI: {
          scanAllInstalledGames: () =>
            Promise.resolve({ success: true, installedSteamAppIds: [], installedGames: [] }),
          scanSteamAchievements: () => Promise.resolve({ success: true, achievements: {} }),
          syncStore: vi.fn((store: string) => {
            if (store === 'gog') {
              notifyGogSyncStarted();
              return syncStorePromise;
            }
            return Promise.resolve({ success: true, games: [] });
          }),
        },
      };
      saveIntegrations([gogIntegration]);

      vi.spyOn(integrationStorageModule, 'saveCurrentCatalog').mockImplementation(() => {});
      const beginScopeSpy = vi.spyOn(syncJobManager, 'beginPriorityScope');
      const endScopeSpy = vi.spyOn(syncJobManager, 'endPriorityScope');

      try {
        const harness = createHookHarness(() =>
          useManualLibrarySyncActions({
            games: liveGames,
            gamesRef,
            selectedGame: null,
            isGridView: true,
            isSyncingAllMedia: false,
            setIsSyncingAllMedia: () => {},
            setGames,
            setGameRefreshKey: () => {},
            overlayLauncherInstalledState: (cat) => cat,
            showSyncNotice: () => {},
          })
        );

        const syncPromise = harness.current.handleTriggerSync();
        await gogSyncStartedPromise;
        expect(beginScopeSpy).toHaveBeenCalledTimes(1);

        // Simulate a concurrent user edit (marking gog-501 installed + adding a newly discovered local game)
        // while the remote GOG network request is still in flight!
        const concurrentUserGame = createSyntheticGame({
          id: 'synthetic-concurrent-user-added',
          title: 'Concurrent Local Discovery',
          sortTitle: 'concurrent local discovery',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'custom',
              platformGameId: 'custom-999888',
              installed: true,
              playtimeMinutes: 15,
            },
          ],
        });
        setGames((prev) => [
          prev.map((g) =>
            g.id === 'synthetic-live-1'
              ? {
                  ...g,
                  platforms: g.platforms.map((p) => ({ ...p, installed: true })),
                }
              : g
          )[0],
          concurrentUserGame,
        ]);

        resolveSyncStore({
          success: true,
          games: [
            createSyntheticGame({
              id: 'gog-501',
              title: 'Synthetic Live Title',
              sortTitle: 'synthetic live title',
              platforms: [
                {
                  platformId: 'gog',
                  platformGameId: 'gog-501',
                  installed: false,
                  playtimeMinutes: 145,
                },
              ],
            }),
          ],
        });

        await syncPromise;

        expect(endScopeSpy).toHaveBeenCalledTimes(1);
        expect(liveGames.some((g) => g.id === 'synthetic-concurrent-user-added')).toBe(true);
        const mergedLive = liveGames.find((g) =>
          g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === 'gog-501')
        );
        expect(mergedLive?.platforms.find((p) => p.platformId === 'gog')?.installed).toBe(true);
        expect(mergedLive?.platforms.find((p) => p.platformId === 'gog')?.playtimeMinutes).toBe(
          145
        );
      } finally {
        if (prevWin === undefined) {
          delete globalRecord.window;
        } else {
          globalRecord.window = prevWin;
        }
      }
    });
  });

  describe('Rank 3: Unified Spec-Compliant HTML Sanitizer (sanitize-untrusted-html)', () => {
    it('unifies tag allowlists, excludes <main>/<header>/<footer>, and deletes dead sanitizeStoreDomFragment', () => {
      expect(ALLOWED_STORE_ELEMENT_NAMES).not.toContain('main');
      expect(ALLOWED_STORE_ELEMENT_NAMES).not.toContain('header');
      expect(ALLOWED_STORE_ELEMENT_NAMES).not.toContain('footer');
      expect(ALLOWED_STORE_ELEMENT_NAMES).not.toContain('#text');
      expect(ALLOWED_STORE_ELEMENT_NAMES).toEqual(
        expect.arrayContaining(['details', 'summary', 'kbd', 'del', 's', 'figure', 'figcaption'])
      );
      expect(ALLOWED_STORE_ATTR).not.toContain('style');
      expect('sanitizeStoreDomFragment' in safeHtmlSanitizerModule).toBe(false);
    });

    it('upgrades protocol-relative // URLs to https:// and validates schemes via new URL()', () => {
      expect(upgradeProtocolRelativeUrl('//cdn.example.invalid/media/shot.webp')).toBe(
        'https://cdn.example.invalid/media/shot.webp'
      );
      expect(sanitizeAllowedStoreUri('///evil.example.invalid/payload')).toBe('');
      expect(sanitizeAllowedStoreUri('//cdn.example.invalid/media/shot.webp')).toBe(
        'https://cdn.example.invalid/media/shot.webp'
      );
      expect(sanitizeAllowedStoreUri('https://cdn.example.invalid/video.mp4')).toBe(
        'https://cdn.example.invalid/video.mp4'
      );
      expect(sanitizeAllowedStoreUri('ol-media://covers/cached.webp')).toBe(
        'ol-media://covers/cached.webp'
      );
      expect(sanitizeAllowedStoreUri('javascript:alert(1)')).toBe('');
      expect(sanitizeAllowedStoreUri('vbscript:msgbox(1)')).toBe('');
      expect(sanitizeAllowedStoreUri('data:text/html,<script>alert(1)</script>')).toBe('');
      expect(sanitizeAllowedStoreUri('http://insecure.example.invalid/img.jpg')).toBe('');

      expect(
        sanitizeSrcsetValue(
          '//cdn.example.invalid/1x.webp 1x, javascript:alert(1) 2x, https://cdn.example.invalid/2x.webp 2x'
        )
      ).toBe('https://cdn.example.invalid/1x.webp 1x, https://cdn.example.invalid/2x.webp 2x');
    });

    it('enforces KEEP_CONTENT:false, strips aria-*/data-* attributes, enforces anchor rel="noopener noreferrer", and walks DOM fragments directly in SanitizedHtmlBlock', () => {
      const prevDoc = globalRecord.document;
      const prevDomParser = globalRecord.DOMParser;

      class SyntheticDOMParser {
        parseFromString(_html: string): { body: SyntheticDomNode } {
          const body = createSyntheticElement('body', {}, [
            createSyntheticElement(
              'p',
              {
                class: 'lead',
                'data-track': 'secret',
                'aria-label': 'spoofed',
                onclick: 'evil()',
              },
              [createSyntheticTextNode('Safe intro ')]
            ),
            createSyntheticElement('script', {}, [createSyntheticTextNode('alert("xss")')]),
            createSyntheticElement('style', {}, [
              createSyntheticTextNode('body { display: none }'),
            ]),
            createSyntheticElement('svg', {}, [createSyntheticTextNode('svg-inner-payload')]),
            createSyntheticElement('main', {}, [createSyntheticTextNode('disallowed-landmark')]),
            createSyntheticElement(
              'details',
              { open: '' },
              [
                createSyntheticElement('summary', {}, [createSyntheticTextNode('Patch Notes')]),
                createSyntheticElement(
                  'a',
                  { href: '//store.example.invalid/notes' },
                  [createSyntheticTextNode('Read full notes')]
                ),
                createSyntheticElement(
                  'a',
                  { href: 'javascript:alert(1)', target: '_blank' },
                  [createSyntheticTextNode('Blocked link')]
                ),
              ]
            ),
          ]);
          return { body };
        }
      }

      globalRecord.DOMParser = SyntheticDOMParser;
      globalRecord.document = {
        createDocumentFragment: () => createSyntheticFragment(),
        createElement: (tag: string) => {
          const el = createSyntheticElement(tag);
          Object.defineProperty(el, 'innerHTML', {
            get() {
              const serialize = (n: SyntheticDomNode): string => {
                if (n.nodeType === 3) return n.textContent ?? '';
                if (n.nodeType !== 1) return n.childNodes.map(serialize).join('');
                const t = (n.tagName ?? 'div').toLowerCase();
                const attrStr = n.attributes
                  .map((a) => (a.value === '' ? ` ${a.name}` : ` ${a.name}="${a.value}"`))
                  .join('');
                return `<${t}${attrStr}>${n.childNodes.map(serialize).join('')}</${t}>`;
              };
              return el.childNodes.map(serialize).join('');
            },
          });
          return el;
        },
      };

      try {
        const fragment = sanitizeSafeDomFragment('<p>ignored raw</p>');
        expect(fragment).not.toBeNull();

        const serialized = sanitizeStoreHtml('<p>ignored raw</p>');
        expect(serialized).not.toContain('alert("xss")');
        expect(serialized).not.toContain('display: none');
        expect(serialized).not.toContain('svg-inner-payload');
        expect(serialized).not.toContain('disallowed-landmark');
        expect(serialized).not.toContain('data-track');
        expect(serialized).not.toContain('aria-label');
        expect(serialized).not.toContain('onclick');
        expect(serialized).toContain('href="https://store.example.invalid/notes"');
        expect(serialized).toContain('rel="noopener noreferrer"');
        expect(serialized).toContain('<a rel="noopener noreferrer">Blocked link</a>');

        const blockHtml = renderToString(
          <SanitizedHtmlBlock html="<p>ignored raw</p>" className="prose-block" />
        );
        expect(blockHtml).toContain('<details open="">');
        expect(blockHtml).toContain('<summary>Patch Notes</summary>');
        expect(blockHtml).toContain('Safe intro ');
        expect(blockHtml).not.toContain('alert(&quot;xss&quot;)');
      } finally {
        if (prevDoc === undefined) {
          delete globalRecord.document;
        } else {
          globalRecord.document = prevDoc;
        }
        if (prevDomParser === undefined) {
          delete globalRecord.DOMParser;
        } else {
          globalRecord.DOMParser = prevDomParser;
        }
      }

      const ssrFallback = renderToString(
        <SanitizedHtmlBlock html="<p>Hello <b>World</b></p><script>evil()</script>" />
      );
      expect(ssrFallback).toContain('Hello World');
      expect(ssrFallback).not.toContain('evil()');

      const emptyFrag = createSyntheticFragment();
      enforceFragmentSecurityPolicy(emptyFrag as unknown as DocumentFragment);
      expect(emptyFrag.childNodes).toHaveLength(0);
    });
  });

  describe('Rank 5, 8, 9, 11, 15 & 16: Modern Web Guidance (Menubar, IME, Dialog, Landmarks & LCP)', () => {
    it('guards Enter submissions during active IME composition including Safari keyCode 229', () => {
      expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
      expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
      expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
      expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
      expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);

      const collectionsModalSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Library/ManageCollectionsModal.tsx'),
        'utf8'
      );
      const fixMatchReviewSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Library/FixMatch/FixMatchReviewStep.tsx'),
        'utf8'
      );
      expect(collectionsModalSrc).toContain('isImeComposing');
      expect(fixMatchReviewSrc).toContain('isImeComposing');
    });

    it('renders TopNavBar with role="menubar", roving tabIndex, aria-pressed, and decoupled presentStorefronts', () => {
      const prevWin = globalRecord.window;
      globalRecord.window = {
        localStorage: mockLocalStorage,
        addEventListener: () => {},
        removeEventListener: () => {},
        electronAPI: {
          platform: 'win32',
        },
      };

      try {
        const html = renderToString(
          <TopNavBar
            selectedPlatform="all"
            onSelectPlatform={() => {}}
            presentStorefronts={['steam', 'gog']}
            installedOnly={true}
            onToggleInstalledOnly={() => {}}
            totalGamesCount={12}
            filteredCount={4}
            isSyncing={false}
            onTriggerSync={() => {}}
            onHomeClick={() => {}}
            onOpenIntegrations={() => {}}
          />
        );

        expect(html).toContain('role="menubar"');
        expect(html).toContain('aria-label="Application commands"');
        expect(html).toContain('data-testid="win-menu-file"');
        expect(html).toContain('tabindex="0"');
        expect((html.match(/tabindex="-1"/g) ?? []).length).toBeGreaterThanOrEqual(3);
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain('Steam');
        expect(html).toContain('GOG Galaxy');
      } finally {
        if (prevWin === undefined) {
          delete globalRecord.window;
        } else {
          globalRecord.window = prevWin;
        }
      }
    });

    it('checks pointer coordinates in ModalShell isBackdropPoint with 0x0 headless fallback and resets returnValue', () => {
      const dialogRect = {
        left: 100,
        right: 500,
        top: 80,
        bottom: 420,
        width: 400,
        height: 340,
      };
      const fakeDialog = {
        getBoundingClientRect: () => dialogRect,
      } as unknown as HTMLDialogElement;

      expect(
        isBackdropPoint(fakeDialog, {
          target: fakeDialog,
          clientX: 250,
          clientY: 200,
        })
      ).toBe(false);

      expect(
        isBackdropPoint(fakeDialog, {
          target: fakeDialog,
          clientX: 40,
          clientY: 200,
        })
      ).toBe(true);

      const zeroRectDialog = {
        getBoundingClientRect: () => ({
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          width: 0,
          height: 0,
        }),
      } as unknown as HTMLDialogElement;
      expect(
        isBackdropPoint(zeroRectDialog, {
          target: zeroRectDialog,
          clientX: 0,
          clientY: 0,
        })
      ).toBe(true);

      const modalShellSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Common/ModalShell.tsx'),
        'utf8'
      );
      expect(modalShellSrc).toContain("dialog.returnValue = ''");
      expect(modalShellSrc).toContain('acquireModalOverlayLock');
    });

    it('implements skip link, <search> landmark, native <button> language disclosure, sequential headings, and targeted fetchPriority="high"', () => {
      const cssSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/index.css'), 'utf8');
      expect(cssSrc).toContain('.ol-visually-hidden:not(.ol-skip-link)');
      expect(cssSrc).toContain('.ol-visually-hidden.ol-skip-link:where(:not(:focus-visible, :active))');
      expect(cssSrc).toContain('.app-drag-region');
      expect(cssSrc).toContain('.modal-scroll-body');
      expect(cssSrc).toContain('.cv-card-deferred');

      const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
      expect(appSrc).toContain('href="#main-content"');
      expect(appSrc).toContain('Skip to main content');
      expect(appSrc).toContain('id="main-content"');

      const sidebarSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Library/LibrarySidebar.tsx'),
        'utf8'
      );
      expect(sidebarSrc).toContain('<search aria-label="Filter library"');
      expect(sidebarSrc).toContain('}, [launcherTick])');

      const eightLangs = Array.from({ length: 8 }, (_, idx) => ({
        name: `Language ${idx + 1}`,
        hasInterface: true,
        hasAudio: idx < 3,
        hasSubtitles: true,
      }));
      const langTableHtml = renderToString(<SteamLanguagesTable languageOptions={eightLangs} />);
      expect(langTableHtml).toContain('<button type="button"');
      expect(langTableHtml).toContain('aria-expanded="false"');
      expect(langTableHtml).not.toContain('<a role="button"');

      const achievementsModalSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Achievements/GameAchievementsModal.tsx'),
        'utf8'
      );
      expect(achievementsModalSrc).not.toContain('<h4');
      const gridViewSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Library/LibraryGridView.tsx'),
        'utf8'
      );
      expect(gridViewSrc).toContain('<h2 className="text-base font-bold text-white">');

      const game = createSyntheticGame();
      const firstCardHtml = renderToString(<GameCardCover game={game} cardIndex={0} />);
      const fifthCardHtml = renderToString(<GameCardCover game={game} cardIndex={4} />);
      expect(firstCardHtml).toMatch(/fetchpriority="high"/i);
      expect(fifthCardHtml).not.toMatch(/fetchpriority="high"/i);

      const mediaGallerySrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/SteamStoreDetail/MediaGallery.tsx'),
        'utf8'
      );
      expect(mediaGallerySrc).toContain('retryNonce');
      expect(mediaGallerySrc).toContain("video.canPlayType('application/vnd.apple.mpegurl')");

      const galleryHtml = renderToString(
        <MediaGallery
          title="Synthetic Showcase"
          headerImage="https://cdn.example.invalid/header.jpg"
          movies={[]}
          screenshots={[
            {
              id: 1,
              pathThumbnail: 'https://cdn.example.invalid/thumb1.jpg',
              pathFull: 'https://cdn.example.invalid/full1.jpg',
            },
            {
              id: 2,
              pathThumbnail: 'https://cdn.example.invalid/thumb2.jpg',
              pathFull: 'https://cdn.example.invalid/full2.jpg',
            },
          ]}
        />
      );
      expect((galleryHtml.match(/<img\b[^>]*fetchpriority="high"/gi) ?? []).length).toBe(1);
    });
  });

  describe('Rank 7, 10, 12, 13, 14, 17 & 18: Shared Reconciler, Bounded Caches, Incremental Persistence, O(1) Scheduler & Zero-Any AST', () => {
    it('reconciles Steam/GOG/Epic/Xbox sessions via shared storefrontAuthReconciler and scrubs raw tokens', () => {
      const baseIntegrations = loadIntegrations();
      const result = reconcileNativeStorefrontAuthSessions({
        initialIntegrations: baseIntegrations,
        savedTokens: {
          steam: {
            steamId: '76561198000000001',
            accountName: 'SyntheticSteamUser',
          },
          gog: {
            user_id: 'gog-user-1',
            username: 'SyntheticGogUser',
            access_token: 'RAW_SECRET_SHOULD_NEVER_PERSIST',
          },
          epic: {
            account_id: 'epic-user-1',
            displayName: 'SyntheticEpicUser',
            access_token: 'RAW_EPIC_SECRET',
          },
        },
        xboxStatus: {
          connected: true,
          gamertag: 'SyntheticXboxTag',
          xuid: '2533274790000001',
        },
        persistIfChanged: true,
        dispatchXboxProfileEvent: false,
      });

      expect(result.changed).toBe(true);
      const byPlatform = new Map(result.integrations.map((i) => [i.storefrontId, i]));
      expect(byPlatform.get('steam')?.isConnected).toBe(true);
      expect(byPlatform.get('gog')?.isConnected).toBe(true);
      expect(byPlatform.get('gog')?.credentials?.gogUsername).toBe('SyntheticGogUser');
      expect(byPlatform.get('gog')?.credentials?.gogToken).toBeUndefined();
      expect(byPlatform.get('epic')?.isConnected).toBe(true);
      expect(byPlatform.get('epic')?.credentials?.epicAccountId).toBe('epic-user-1');
      expect(byPlatform.get('epic')?.credentials?.epicToken).toBeUndefined();
      expect(byPlatform.get('xbox')?.isConnected).toBe(true);
      expect(JSON.stringify(result.integrations)).not.toContain('RAW_SECRET_SHOULD_NEVER_PERSIST');
      expect(JSON.stringify(result.integrations)).not.toContain('RAW_EPIC_SECRET');
    });

    it('strips HTML to plain synopsis with paragraph preservation and bounded LRU memoization', () => {
      const synopsis = stripHtmlToPlainSynopsis(
        '<style>.bad{color:red}</style><p>First paragraph &amp; intro explaining the core adventure loop in detail.</p><script>evil()</script><p>Second line of synopsis.</p>'
      );
      expect(synopsis).toBe(
        'First paragraph & intro explaining the core adventure loop in detail.'
      );
      expect(synopsis).not.toContain('.bad');
      expect(synopsis).not.toContain('evil()');
      expect(
        extractFirstParagraph('First paragraph & intro.\n\nSecond line of synopsis.', 120)
      ).toBe('First paragraph & intro.');
    });

    it('caps gridCoverUtils sets at 8,192, shares vaultEntries in stagedCacheService, and clears trackedCacheKeys on fallback reset', () => {
      for (let i = 0; i < 8250; i++) {
        failedCoverUrls.add(`https://cdn.example.invalid/fail/${i}.jpg`);
      }
      expect(failedCoverUrls.size).toBe(8192);
      expect(failedCoverUrls.has('https://cdn.example.invalid/fail/0.jpg')).toBe(false);
      expect(failedCoverUrls.has('https://cdn.example.invalid/fail/8249.jpg')).toBe(true);

      const stagedKey = 'antigravity_staged_synthetic_wave2d';
      saveStagedCache(stagedKey, { ok: true }, TIER_4C_TRANSIENT_ERROR);
      expect(loadStagedCache<{ ok: boolean }>(stagedKey)?.data).toEqual({ ok: true });

      clearStagedMemoryFallback();
      mockLocalStorage.clear();
      clearExpiredStagedCache({ onlyNegativeAndTransient: true });
      expect(loadStagedCache<{ ok: boolean }>(stagedKey)).toEqual({ valid: false, data: null });

      const stagedSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/services/storage/stagedCacheService.ts'),
        'utf8'
      );
      expect(stagedSrc).not.toContain("createStore('one-launcher-db'");
      expect(stagedSrc).toContain('vaultEntries');

      const installModalSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/Launcher/GameInstallModal.tsx'),
        'utf8'
      );
      expect(installModalSrc).not.toMatch(/^let diskSpaceReqSeq\b/m);
      expect(installModalSrc).not.toMatch(/^let diskSpaceDebounceTimer\b/m);
    });

    it('persists incremental removedGameIds in saveCurrentCatalog without upserting unchanged games', () => {
      const prevWin = globalRecord.window;
      const upsertSpy = vi.fn(() => Promise.resolve({ ok: true, count: 0 }));
      const deleteSpy = vi.fn(() => Promise.resolve({ ok: true, deleted: 1 }));

      globalRecord.window = {
        localStorage: mockLocalStorage,
        electronAPI: {
          offlineVault: {
            upsertGames: upsertSpy,
            deleteGames: deleteSpy,
          },
        },
      };

      try {
        const remaining = [
          createSyntheticGame({ id: 'keep-1' }),
          createSyntheticGame({ id: 'keep-2' }),
        ];
        saveCurrentCatalog(remaining, {
          dirtyGameIds: [],
          removedGameIds: ['removed-hidden-1'],
        });

        expect(deleteSpy).toHaveBeenCalledWith(['removed-hidden-1']);
        expect(upsertSpy).not.toHaveBeenCalled();
      } finally {
        if (prevWin === undefined) {
          delete globalRecord.window;
        } else {
          globalRecord.window = prevWin;
        }
      }
    });

    it('dispatches RequestScheduler P0 > P1 > P2 in O(1) FIFO order with accurate getQueueLength and abort eviction', async () => {
      vi.useFakeTimers();
      requestScheduler.setEnforceDelays(true);
      requestScheduler.reset();

      try {
        const executionOrder: string[] = [];
        const url = 'https://store.steampowered.com/api/appdetails?appids=100001';

        // Exhaust burst capacity (2 tokens on store.steampowered.com)
        const burstPromises = Array.from({ length: 2 }, (_, idx) =>
          requestScheduler.schedule(url, async () => idx, RequestPriority.P0_INTERACTIVE)
        );

        const abortCtrl = new AbortController();
        const p2 = requestScheduler.schedule(
          url,
          async () => {
            executionOrder.push('p2-first');
            return 'p2';
          },
          RequestPriority.P2_BACKGROUND
        );
        const pAborted = requestScheduler.schedule(
          url,
          async () => {
            executionOrder.push('aborted');
            return 'aborted';
          },
          RequestPriority.P1_VIEWPORT,
          { signal: abortCtrl.signal }
        );
        pAborted.catch(() => {});

        const p1 = requestScheduler.schedule(
          url,
          async () => {
            executionOrder.push('p1-second');
            return 'p1';
          },
          RequestPriority.P1_VIEWPORT
        );
        const p0 = requestScheduler.schedule(
          url,
          async () => {
            executionOrder.push('p0-third');
            return 'p0';
          },
          RequestPriority.P0_INTERACTIVE
        );

        expect(requestScheduler.getQueueLength('store.steampowered.com')).toBe(4);
        abortCtrl.abort();
        expect(requestScheduler.getQueueLength('store.steampowered.com')).toBe(3);

        await expect(pAborted).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(12000);
        await Promise.all([...burstPromises, p0, p1, p2]);

        expect(executionOrder).toEqual(['p0-third', 'p1-second', 'p2-first']);
        expect(requestScheduler.getQueueLength('store.steampowered.com')).toBe(0);
      } finally {
        requestScheduler.reset();
        requestScheduler.setEnforceDelays(false);
        vi.useRealTimers();
      }
    });

    it('enforces zero TypeScript AnyKeyword occurrences across src/** and vite.config.ts', () => {
      const filesToScan: string[] = [path.join(ROOT_DIR, 'vite.config.ts')];
      const walkSrc = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkSrc(full);
          } else if (/\.(ts|tsx)$/.test(entry.name)) {
            filesToScan.push(full);
          }
        }
      };
      walkSrc(path.join(ROOT_DIR, 'src'));

      const violations: string[] = [];
      for (const filePath of filesToScan) {
        const content = fs.readFileSync(filePath, 'utf8');
        const sf = ts.createSourceFile(
          filePath,
          content,
          ts.ScriptTarget.Latest,
          true,
          filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const visit = (node: ts.Node): void => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${path.relative(ROOT_DIR, filePath)}:${pos.line + 1}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }

      expect(violations).toEqual([]);
    });

    it('formats GOG v1/catalog queries with like:, ignores productCount===0 recommendations, and rejects QA sandbox entries', async () => {
      const requestedUrls: string[] = [];
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('/v1/catalog')) {
          return {
            data: {
              productCount: 0,
              products: [
                {
                  id: '9999999991',
                  slug: 'synthetic_sandbox_item',
                  title: 'Synthetic Bonus Edition',
                  developers: ['TEST DEVELOPER'],
                  publishers: ['TEST PUBLISHER'],
                },
                {
                  id: '9999999992',
                  slug: 'unrelated_recommended_item',
                  title: 'Unrelated Recommended Item',
                  developers: ['Genuine Studio'],
                  publishers: ['Genuine Publisher'],
                },
              ],
            },
          };
        }
        return { data: {} };
      });

      const provider = new FallbackMetadataProvider();
      const res = await provider.fetchGogProductMetadata('9100000001', 'Synthetic Bonus Edition');

      const catalogCall = requestedUrls.find((u) => u.includes('/v1/catalog')) || '';
      expect(catalogCall).toContain('query=like%3ASynthetic%20Bonus%20Edition');
      expect(res?.developers || []).not.toContain('TEST DEVELOPER');
      expect(res?.developers || []).not.toContain('Genuine Studio');
    });

    it('self-heals routed UserGameOverride snapshots poisoned by QA sandbox developer/publisher fields while preserving custom edits', () => {
      const baseGame = createSyntheticGame({
        id: 'gog-9100000001',
        title: 'Synthetic Bonus Edition',
        shortDescription: 'Genuine storefront synopsis.',
        developers: ['Genuine Studio'],
        publishers: ['Genuine Publisher'],
      });

      const poisonedRoutedOverride: UserGameOverride = {
        gameId: 'gog-9100000001',
        matchedStore: 'gog',
        matchedId: '9100000001',
        shortDescription: 'Poisoned sandbox synopsis',
        developers: ['TEST DEVELOPER'],
        publishers: ['TEST PUBLISHER'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      const healed = applyUserOverrideToGame(baseGame, poisonedRoutedOverride);
      expect(healed.developers).toEqual(['Genuine Studio']);
      expect(healed.publishers).toEqual(['Genuine Publisher']);
      expect(healed.shortDescription).toBe('Genuine storefront synopsis.');

      const explicitCustomOverride: UserGameOverride = {
        ...poisonedRoutedOverride,
        matchedStore: 'custom',
        metadataRoute: { mode: 'custom', source: 'custom', customSynopsisEdited: true },
      };
      const customApplied = applyUserOverrideToGame(baseGame, explicitCustomOverride);
      expect(customApplied.developers).toEqual(['TEST DEVELOPER']);
      expect(customApplied.shortDescription).toBe('Poisoned sandbox synopsis');
    });
  });
});
