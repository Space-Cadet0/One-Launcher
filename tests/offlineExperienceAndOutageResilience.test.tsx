import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  buildSanitizedFragmentViaDomParser,
  sanitizeHtmlStringViaDomParser,
} from './helpers/domParserHelper';

// ---------------------------------------------------------------------------
// Headless Browser + Lightweight Real-Behavior DOM Fragment Polyfills
// (Must be installed before importing renderer services/components)
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

class LiteTextNode {
  public readonly nodeType = 3;
  public parentNode: LiteHTMLElement | LiteDocumentFragment | null = null;
  constructor(public textContent: string) {}
}

class LiteDocumentFragment {
  public readonly nodeType = 11;
  public childNodes: Array<LiteHTMLElement | LiteTextNode> = [];

  get children(): LiteHTMLElement[] {
    return this.childNodes.filter((n): n is LiteHTMLElement => n instanceof LiteHTMLElement);
  }

  appendChild(node: LiteHTMLElement | LiteTextNode): LiteHTMLElement | LiteTextNode {
    if (node.parentNode) {
      const idx = node.parentNode.childNodes.indexOf(node);
      if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  querySelectorAll(selector: string): LiteHTMLElement[] {
    const out: LiteHTMLElement[] = [];
    const visit = (nodes: Array<LiteHTMLElement | LiteTextNode>) => {
      for (const n of nodes) {
        if (n instanceof LiteHTMLElement) {
          if (n.matchesSelector(selector)) out.push(n);
          visit(n.childNodes);
        }
      }
    };
    visit(this.childNodes);
    return out;
  }
}

class LiteHTMLElement {
  public readonly nodeType = 1;
  public readonly tagName: string;
  public parentNode: LiteHTMLElement | LiteDocumentFragment | null = null;
  public childNodes: Array<LiteHTMLElement | LiteTextNode> = [];
  public style: Record<string, string> = {};
  public paused = true;
  public muted = false;
  public autoplay = false;
  public clientHeight = 480;
  public scrollTop = 0;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  public forbidInnerHtmlWrite = false;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attrs.get('class') || '';
  }
  set className(val: string) {
    this.attrs.set('class', String(val));
  }

  get open(): boolean {
    return this.attrs.has('open');
  }
  set open(v: boolean) {
    if (v) this.attrs.set('open', '');
    else this.attrs.delete('open');
  }

  get isConnected(): boolean {
    let cur: LiteHTMLElement | LiteDocumentFragment | null = this;
    while (cur) {
      if (cur instanceof LiteHTMLElement && cur.getAttribute('data-testid')) return true;
      cur = cur instanceof LiteHTMLElement ? cur.parentNode : null;
    }
    return true;
  }

  get children(): LiteHTMLElement[] {
    return this.childNodes.filter((n): n is LiteHTMLElement => n instanceof LiteHTMLElement);
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  get innerHTML(): string {
    return this.childNodes
      .map((n) => (n instanceof LiteTextNode ? n.textContent : n.outerHTML))
      .join('');
  }
  set innerHTML(_val: string) {
    if (this.forbidInnerHtmlWrite) {
      throw new Error('Forbidden innerHTML write on mounted container (mXSS violation)');
    }
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrPairs = Array.from(this.attrs.entries())
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const openTag = attrPairs ? `<${tag} ${attrPairs}>` : `<${tag}>`;
    return `${openTag}${this.innerHTML}</${tag}>`;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase());
  }

  addEventListener(type: string, cb: (...args: unknown[]) => void): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(cb);
  }
  removeEventListener(type: string, cb: (...args: unknown[]) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(evt: { type: string }): boolean {
    const bucket = this.listeners.get(evt.type);
    if (bucket) {
      for (const cb of Array.from(bucket)) cb(evt);
    }
    return true;
  }

  pause(): void {
    this.paused = true;
  }
  load(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  scrollIntoView(): void {}
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 };
  }

  appendChild(node: LiteHTMLElement | LiteTextNode): LiteHTMLElement | LiteTextNode {
    if (node.parentNode) {
      const idx = node.parentNode.childNodes.indexOf(node);
      if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  replaceWith(...nodes: Array<LiteHTMLElement | LiteTextNode>): void {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const idx = parent.childNodes.indexOf(this);
    if (idx < 0) return;
    for (const n of nodes) {
      if (n.parentNode) {
        const oldIdx = n.parentNode.childNodes.indexOf(n);
        if (oldIdx >= 0) n.parentNode.childNodes.splice(oldIdx, 1);
      }
      n.parentNode = parent;
    }
    parent.childNodes.splice(idx, 1, ...nodes);
    this.parentNode = null;
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
    this.parentNode = null;
  }

  replaceChildren(...nodes: Array<LiteHTMLElement | LiteTextNode | LiteDocumentFragment>): void {
    for (const c of this.childNodes) {
      c.parentNode = null;
    }
    this.childNodes = [];
    for (const item of nodes) {
      if (item instanceof LiteDocumentFragment) {
        const moved = [...item.childNodes];
        item.childNodes = [];
        for (const child of moved) {
          child.parentNode = this;
          this.childNodes.push(child);
        }
      } else {
        this.appendChild(item);
      }
    }
  }

  matchesSelector(selector: string): boolean {
    const clean = selector.trim();
    if (!clean) return false;
    if (clean.startsWith('.')) {
      const cls = clean.slice(1);
      return this.className.split(/\s+/).includes(cls);
    }
    return this.tagName.toLowerCase() === clean.toLowerCase();
  }

  closest(selector: string): LiteHTMLElement | null {
    let cur: LiteHTMLElement | LiteDocumentFragment | null = this;
    while (cur && cur instanceof LiteHTMLElement) {
      if (cur.matchesSelector(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelectorAll(selector: string): LiteHTMLElement[] {
    const out: LiteHTMLElement[] = [];
    const visit = (nodes: Array<LiteHTMLElement | LiteTextNode>) => {
      for (const n of nodes) {
        if (n instanceof LiteHTMLElement) {
          if (n.matchesSelector(selector)) out.push(n);
          visit(n.childNodes);
        }
      }
    };
    visit(this.childNodes);
    return out;
  }
}

function parseSanitizedHtmlToFragment(rawHtml: string): LiteDocumentFragment {
  return buildSanitizedFragmentViaDomParser(rawHtml, {
    createFragment: () => new LiteDocumentFragment(),
    createElement: (tagName) => new LiteHTMLElement(tagName),
    createText: (text) => new LiteTextNode(text),
    setAttribute: (el, name, value) => el.setAttribute(name, value),
    appendChildToElement: (parent, child) => {
      parent.appendChild(child);
    },
    appendChildToFragment: (frag, child) => {
      frag.appendChild(child);
    },
  });
}

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string, cfg?: { RETURN_DOM_FRAGMENT?: boolean }) => {
      if (cfg?.RETURN_DOM_FRAGMENT) {
        return parseSanitizedHtmlToFragment(String(html || ''));
      }
      return sanitizeHtmlStringViaDomParser(String(html || ''));
    },
  },
}));

const mockStorage = new MockStorage();
const windowEvents = new EventTarget();
const documentEvents = new EventTarget();
let navigatorOnLineState = true;

(globalThis as any).HTMLElement = LiteHTMLElement;
(globalThis as any).localStorage = mockStorage;
if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent<T = unknown> extends Event {
    detail: T;
    constructor(type: string, params?: CustomEventInit<T>) {
      super(type);
      this.detail = params?.detail as T;
    }
  };
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    get onLine() {
      return navigatorOnLineState;
    },
    userAgent: 'OneLauncherChaosTest/1.0',
  },
});

(globalThis as any).window = {
  addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
    windowEvents.addEventListener(type, cb),
  removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
    windowEvents.removeEventListener(type, cb),
  dispatchEvent: (event: Event) => windowEvents.dispatchEvent(event),
  localStorage: mockStorage,
  location: { protocol: 'app:', port: '', hostname: 'one-launcher.local', origin: 'app://one-launcher' },
  innerWidth: 1440,
  innerHeight: 900,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  electronAPI: undefined as any,
};

(globalThis as any).document = {
  hidden: false,
  visibilityState: 'visible',
  documentElement: new LiteHTMLElement('html'),
  body: new LiteHTMLElement('body'),
  getElementById: () => null,
  addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
    documentEvents.addEventListener(type, cb),
  removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
    documentEvents.removeEventListener(type, cb),
  dispatchEvent: (event: Event) => documentEvents.dispatchEvent(event),
  createElement: (tag: string) => new LiteHTMLElement(tag),
  createDocumentFragment: () => new LiteDocumentFragment(),
};

function setOnlineConnectivity(online: boolean): void {
  const changed = navigatorOnLineState !== online;
  navigatorOnLineState = online;
  if (changed) {
    (globalThis as any).window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  }
}

// ---------------------------------------------------------------------------
// Imports of Application Modules (CJS Electron + Renderer TS/TSX)
// ---------------------------------------------------------------------------
const requireCjs = createRequire(import.meta.url);
const federatorMod = requireCjs('../electron/launcher/storefrontLocalCacheFederator.cjs');
const offlineVaultMod = requireCjs('../electron/launcher/offlineVaultService.cjs');
const hydrationEngineMod = requireCjs('../electron/launcher/mediaHydrationEngine.cjs');
const offlineVaultIpcMod = requireCjs('../electron/ipc/offlineVaultIpcHandlers.cjs');

import {
  OFFLINE_VAULT_TIER_CAPS,
  computeAdaptive404RetryDelayMs,
  isWafOrChallengeResponse,
  toOlMediaUrl,
} from '../src/contracts/network';
import type { CanonicalGame } from '../src/contracts/game';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import {
  RequestScheduler,
  Priority,
} from '../src/services/network/requestScheduler';
import { extractStaticHydrationAssets } from '../src/services/network/syncJobManager';
import {
  saveStagedCache,
  loadStagedCache,
  MutabilityTier,
} from '../src/services/storage/stagedCacheService';
import { steamApi } from '../src/services/steam/steamApi';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { steamMatcher } from '../src/services/steam/steamMatcher';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import {
  igdbCoverService,
  KNOWN_DEAD_STEAM_COVER_APP_IDS,
  isUnsuitableHeaderUrl,
  isUnsuitableCoverUrl,
} from '../src/services/igdb/igdbCoverService';
import { achievementDetailService } from '../src/services/achievements/achievementDetailService';
import { StoreFeatureIcon } from '../src/components/SteamStoreDetail/StoreFeatureIcon';
import { SteamFeaturesList } from '../src/components/SteamStoreDetail/SteamFeaturesList';
import { SteamLanguagesTable } from '../src/components/SteamStoreDetail/SteamLanguagesTable';
import { SteamSidebarNotices } from '../src/components/SteamStoreDetail/SteamSidebarNotices';
import { SystemRequirements } from '../src/components/SteamStoreDetail/SystemRequirements';
import { MediaGallery } from '../src/components/SteamStoreDetail/MediaGallery';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { GameAchievementsModal } from '../src/components/Achievements/GameAchievementsModal';
import { IntegrationsModal } from '../src/components/Navigation/IntegrationsModal';

// ---------------------------------------------------------------------------
// Deep Recursive React 19 Component Test Renderer (Executes Hooks + Refs)
// ---------------------------------------------------------------------------
interface ComponentSlot {
  states: any[];
  refs: Array<{ current: any }>;
  prevDeps: Array<any[] | undefined>;
  cleanups: Array<(() => void) | undefined>;
}

function createDeepTestRenderer<P extends object>(RootComponent: React.FC<P>, initialProps: P) {
  const slots = new Map<string, ComponentSlot>();
  const hostRefsByPath = new Map<string, LiteHTMLElement>();
  const hostNodesByTestId = new Map<string, LiteHTMLElement>();
  let currentProps = initialProps;
  let lastRenderedTree: any = null;

  const getOrCreateSlot = (slotKey: string): ComponentSlot => {
    let slot = slots.get(slotKey);
    if (!slot) {
      slot = { states: [], refs: [], prevDeps: [], cleanups: [] };
      slots.set(slotKey, slot);
    }
    return slot;
  };

  const renderNode = (
    node: any,
    pathPrefix: string,
    pendingEffects: Array<{ slot: ComponentSlot; idx: number; fn: () => any }>,
    visitedSlots: Set<string>
  ): any => {
    if (node === null || node === undefined || typeof node === 'boolean') return node;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) {
      return node.map((child, idx) =>
        renderNode(child, `${pathPrefix}[${idx}]`, pendingEffects, visitedSlots)
      );
    }
    if (typeof node !== 'object') return node;

    // Handle React Portals transparently
    if (node.$$typeof === Symbol.for('react.portal')) {
      return renderNode(node.children, `${pathPrefix}:portal`, pendingEffects, visitedSlots);
    }

    const rawType = node.type;
    // Unwrap React.Fragment
    if (rawType === React.Fragment) {
      return renderNode(node.props?.children, `${pathPrefix}:frag`, pendingEffects, visitedSlots);
    }

    // Unwrap React.memo / forwardRef if encountered
    let fnComponent: ((props: any, ref?: any) => any) | null = null;
    if (typeof rawType === 'function') {
      fnComponent = rawType;
    } else if (rawType && typeof rawType === 'object') {
      if (typeof rawType.type === 'function') fnComponent = rawType.type;
      else if (typeof rawType.render === 'function') fnComponent = rawType.render;
    }

    if (fnComponent) {
      const compName = (fnComponent as any).displayName || fnComponent.name || 'Anon';
      const keyPart = node.key !== null && node.key !== undefined ? `#${String(node.key)}` : '';
      const slotKey = `${pathPrefix}:${compName}${keyPart}`;
      visitedSlots.add(slotKey);
      const slot = getOrCreateSlot(slotKey);

      let stateIdx = 0;
      let refIdx = 0;
      let effectIdx = 0;
      const localEffects: Array<{ slot: ComponentSlot; idx: number; fn: () => any }> = [];

      const internals = (React as any)
        .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;

      const scheduleEffect = (fn: () => any, deps?: any[]) => {
        const idx = effectIdx++;
        const oldDeps = slot.prevDeps[idx];
        const changed =
          !oldDeps ||
          !deps ||
          oldDeps.length !== deps.length ||
          deps.some((d, i) => !Object.is(d, oldDeps[i]));
        if (changed) {
          slot.prevDeps[idx] = deps;
          localEffects.push({ slot, idx, fn });
        }
      };

      // Note: Intentionally omit useSyncExternalStore so ModalShell renders inline without portal DOM nodeType checks
      internals.H = {
        useState(initial: any) {
          const idx = stateIdx++;
          if (idx >= slot.states.length) {
            slot.states.push(typeof initial === 'function' ? initial() : initial);
          }
          const setState = (updater: any) => {
            slot.states[idx] =
              typeof updater === 'function' ? updater(slot.states[idx]) : updater;
          };
          return [slot.states[idx], setState];
        },
        useRef(initial: any) {
          const idx = refIdx++;
          if (idx >= slot.refs.length) {
            slot.refs.push({ current: initial });
          }
          return slot.refs[idx];
        },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
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
          return `id-${slotKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        },
      };

      let subTree: any;
      try {
        subTree = fnComponent(node.props || {}, node.props?.ref);
      } finally {
        internals.H = prevH;
      }

      const expandedChildren = renderNode(subTree, slotKey, pendingEffects, visitedSlots);
      // Child effects run before parent effects in React
      pendingEffects.push(...localEffects);
      return expandedChildren;
    }

    // Host element (e.g. 'div', 'img', 'video', 'button', 'dialog')
    if (typeof rawType === 'string') {
      const props = node.props || {};
      const testId = typeof props['data-testid'] === 'string' ? props['data-testid'] : undefined;
      const refProp = props.ref;
      if (refProp || testId) {
        let hostEl = hostRefsByPath.get(pathPrefix);
        if (!hostEl) {
          hostEl = new LiteHTMLElement(rawType);
          if (testId === 'about-this-game-content') {
            hostEl.forbidInnerHtmlWrite = true;
          }
          hostRefsByPath.set(pathPrefix, hostEl);
        }
        if (testId) {
          hostEl.setAttribute('data-testid', testId);
          hostNodesByTestId.set(testId, hostEl);
        }
        if (typeof props.className === 'string') {
          hostEl.className = props.className;
        }
        if (typeof refProp === 'function') {
          refProp(hostEl);
        } else if (refProp && typeof refProp === 'object' && 'current' in refProp) {
          refProp.current = hostEl;
        }
      }

      const nextChildren =
        props.children !== undefined
          ? renderNode(props.children, `${pathPrefix}/${rawType}`, pendingEffects, visitedSlots)
          : props.children;

      return {
        ...node,
        type: rawType,
        props: {
          ...props,
          children: nextChildren,
        },
      };
    }

    return node;
  };

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    const pendingEffects: Array<{ slot: ComponentSlot; idx: number; fn: () => any }> = [];
    const visitedSlots = new Set<string>();

    const rootElement = React.createElement(RootComponent, currentProps);
    lastRenderedTree = renderNode(rootElement, 'root', pendingEffects, visitedSlots);

    // Clean up unmounted component slots
    for (const [key, slot] of Array.from(slots.entries())) {
      if (!visitedSlots.has(key)) {
        for (const cleanup of slot.cleanups) {
          if (typeof cleanup === 'function') cleanup();
        }
        slots.delete(key);
      }
    }

    // Execute newly scheduled effects
    for (const eff of pendingEffects) {
      const prevCleanup = eff.slot.cleanups[eff.idx];
      if (typeof prevCleanup === 'function') {
        prevCleanup();
      }
      const nextCleanup = eff.fn();
      eff.slot.cleanups[eff.idx] = typeof nextCleanup === 'function' ? nextCleanup : undefined;
    }

    return lastRenderedTree;
  };

  const unmount = () => {
    for (const slot of slots.values()) {
      for (const cleanup of slot.cleanups) {
        if (typeof cleanup === 'function') cleanup();
      }
    }
    slots.clear();
  };

  const findElements = (predicate: (el: any) => boolean): any[] => {
    const acc: any[] = [];
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const c of n) walk(c);
        return;
      }
      if (predicate(n)) acc.push(n);
      if (n.props?.children) walk(n.props.children);
    };
    walk(lastRenderedTree);
    return acc;
  };

  const readText = (n: any): string => {
    if (n === null || n === undefined || typeof n === 'boolean') return '';
    if (typeof n === 'string' || typeof n === 'number') return String(n);
    if (Array.isArray(n)) return n.map((c) => readText(c)).join('');
    if (typeof n === 'object' && n.props) {
      if (n.props.dangerouslySetInnerHTML?.__html) {
        return String(n.props.dangerouslySetInnerHTML.__html);
      }
      return readText(n.props.children);
    }
    return '';
  };

  const getTextContent = (...args: any[]): string =>
    readText(args.length > 0 ? args[0] : lastRenderedTree);

  const getHostElementByTestId = (testId: string): LiteHTMLElement | undefined =>
    hostNodesByTestId.get(testId);

  return { render, unmount, findElements, getTextContent, getHostElementByTestId };
}

// ---------------------------------------------------------------------------
// Binary Magic-Byte & Mock HTTP Response Factories
// ---------------------------------------------------------------------------
function makeValidImageBuffer(
  format: 'jpg' | 'png' | 'webp' | 'gif' | 'avif',
  totalBytes = 64,
  seedByte = 0x42
): Buffer {
  const buf = Buffer.alloc(Math.max(48, totalBytes), seedByte);
  if (format === 'jpg') {
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    buf[3] = 0xe0;
  } else if (format === 'png') {
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  } else if (format === 'webp') {
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(buf.length - 8, 4);
    buf.write('WEBP', 8, 'ascii');
  } else if (format === 'gif') {
    buf.write('GIF89a', 0, 'ascii');
  } else if (format === 'avif') {
    buf.writeUInt32BE(28, 0);
    buf.write('ftypavif', 4, 'ascii');
  }
  return buf;
}

function makeFakeMp4Buffer(totalBytes = 64): Buffer {
  const buf = Buffer.alloc(Math.max(48, totalBytes), 0x11);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypmp42', 4, 'ascii');
  return buf;
}

function makeMockHttpResponse(opts: {
  status: number;
  body?: Buffer | string;
  headers?: Record<string, string>;
}): Response {
  const bodyBuf =
    opts.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(opts.body)
      ? opts.body
      : Buffer.from(opts.body, 'utf8');

  const headerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.headers || {})) {
    headerMap.set(k.toLowerCase(), v);
  }

  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: String(opts.status),
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
    text: async () => bodyBuf.toString('utf8'),
    json: async () => JSON.parse(bodyBuf.toString('utf8')),
    arrayBuffer: async () =>
      bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength),
  } as unknown as Response;
}

function installMockOfflineVaultBridge(overrides: Record<string, any> = {}) {
  const offlineVault = {
    getStats: vi.fn(async () => ({
      tier: 'balanced',
      maxBytes: OFFLINE_VAULT_TIER_CAPS.balanced,
      sqliteBytes: 128 * 1024,
      blobBytes: 4 * 1024 * 1024,
      totalBytes: 4 * 1024 * 1024 + 128 * 1024,
      blobCount: 18,
      enrichedGames: 12,
      totalGames: 20,
      hydratedAssets: 42,
      totalAssets: 50,
      isHydrating: false,
      isSuspendedInGame: false,
    })),
    setTier: vi.fn(async (tier: 'compact' | 'balanced' | 'max_offline' | 'full_archive') => ({
      success: true,
      stats: {
        tier,
        maxBytes:
          tier === 'max_offline'
            ? OFFLINE_VAULT_TIER_CAPS.full_archive
            : OFFLINE_VAULT_TIER_CAPS[tier],
        sqliteBytes: 128 * 1024,
        blobBytes: 2 * 1024 * 1024,
        totalBytes: 2 * 1024 * 1024 + 128 * 1024,
        blobCount: 10,
        enrichedGames: 12,
        totalGames: 20,
        hydratedAssets: 30,
        totalAssets: 50,
        isHydrating: false,
        isSuspendedInGame: false,
      },
    })),
    clear: vi.fn(async () => ({
      success: true,
      stats: {
        tier: 'balanced',
        maxBytes: OFFLINE_VAULT_TIER_CAPS.balanced,
        sqliteBytes: 128 * 1024,
        blobBytes: 0,
        totalBytes: 128 * 1024,
        blobCount: 0,
        enrichedGames: 12,
        totalGames: 20,
        hydratedAssets: 0,
        totalAssets: 50,
        isHydrating: false,
        isSuspendedInGame: false,
      },
    })),
    upsertGames: vi.fn(async () => ({ success: true, upserted: 1 })),
    getCatalogSnapshot: vi.fn(async () => ({ success: true, games: [], details: {} })),
    saveGameDetail: vi.fn(async () => ({ success: true })),
    getGameDetail: vi.fn(async () => null),
    resolveLocalMetadata: vi.fn(async () => null),
    enqueueHydration: vi.fn(async () => ({ success: true, queued: 0 })),
    pauseHydration: vi.fn(async () => ({ success: true })),
    resumeHydration: vi.fn(async () => ({ success: true })),
    checkUrlStatus: vi.fn(async () => ({
      online: navigatorOnLineState,
      status: navigatorOnLineState ? 200 : null,
      isDefinitive404: false,
      isWafOrRateLimited: false,
    })),
    onHydrationProgress: vi.fn(() => () => {}),
    onGameHydrated: vi.fn(() => () => {}),
    onEndpointHealthChanged: vi.fn(() => () => {}),
    ...overrides,
  };

  (globalThis as any).window.electronAPI = {
    isElectron: true,
    offlineVault,
  };
  return offlineVault;
}

// ---------------------------------------------------------------------------
// Global Per-Test Sandbox Setup & Teardown
// ---------------------------------------------------------------------------
let tempDirs: string[] = [];

function makeTempSandbox(prefix = 'ol-offline-chaos-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeHermeticFederator(sandbox: string) {
  return federatorMod.createStorefrontLocalCacheFederator({
    platform: 'darwin',
    homedir: path.join(sandbox, 'empty-home'),
    userDataDir: path.join(sandbox, 'empty-userdata'),
    steamRoots: [],
    gogGalaxyRoots: [],
    heroicRoots: [],
    legendaryDirs: [],
    bottlePaths: [],
  });
}

function makeSteamMetadata(overrides: Partial<SteamEnrichedMetadata> = {}): SteamEnrichedMetadata {
  return {
    appId: 0,
    name: 'Test Title',
    shortDescription: '',
    detailedDescription: '',
    aboutTheGame: '',
    headerImage: '',
    developers: [],
    publishers: [],
    releaseDate: 'TBA',
    genres: [],
    tags: [],
    categories: [],
    screenshots: [],
    movies: [],
    systemRequirements: {},
    reviewSummary: {
      reviewScore: 0,
      reviewScoreDesc: '',
      totalPositive: 0,
      totalNegative: 0,
      totalReviews: 0,
      positivePercent: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockStorage.clear();
  setOnlineConnectivity(true);
  onlineLifecycleManager.recordEndpointHealth({
    host: 'store.steampowered.com',
    state: 'CLOSED',
    consecutiveFailures: 0,
    openedUntil: 0,
  });
  federatorMod.clearFederatorCaches();
  KNOWN_DEAD_STEAM_COVER_APP_IDS.clear();
  igdbCoverService.clearCache();
  achievementDetailService.clearCache();
  installMockOfflineVaultBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
  setOnlineConnectivity(true);
  federatorMod.clearFederatorCaches();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort Windows handle release cleanup
    }
  }
});

// ===========================================================================
// GROUP 1: Zero-Copy First-Party Local Cache Federation
// ===========================================================================
describe('1. StorefrontLocalCacheFederator: Zero-Copy First-Party Cache & Security Hardening', () => {
  it('resolves Steam modern nested SHA-1 and legacy flat librarycache assets across darwin (including CrossOver bottle) and win32 roots', () => {
    const sandbox = makeTempSandbox('ol-fed-steam-');

    // 1A. Synthetic macOS + CrossOver bottle Steam roots
    const macHome = path.join(sandbox, 'mac-home');
    const crossoverBottle = path.join(sandbox, 'crossover-bottle');
    const bottleSteamRoot = path.join(crossoverBottle, 'drive_c', 'Program Files (x86)', 'Steam');
    const sha1Subdir = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
    const nestedAppDir = path.join(bottleSteamRoot, 'appcache', 'librarycache', '1091500', sha1Subdir);
    fs.mkdirSync(nestedAppDir, { recursive: true });

    const coverPath = path.join(nestedAppDir, 'library_600x900_2x.jpg');
    const headerPath = path.join(nestedAppDir, 'header.jpg');
    const iconPath = path.join(
      bottleSteamRoot,
      'appcache',
      'librarycache',
      '1091500',
      '1091500_icon.jpg'
    );
    fs.writeFileSync(coverPath, makeValidImageBuffer('jpg', 96, 0x21));
    fs.writeFileSync(headerPath, makeValidImageBuffer('jpg', 96, 0x22));
    fs.writeFileSync(iconPath, makeValidImageBuffer('jpg', 64, 0x23));

    // Write local userdata/<steam3Id>/config/librarycache/1091500.json for offline Steam metadata extraction
    const steamUserCacheDir = path.join(bottleSteamRoot, 'userdata', '12345678', 'config', 'librarycache');
    fs.mkdirSync(steamUserCacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(steamUserCacheDir, '1091500.json'),
      JSON.stringify({
        name: 'Cyberpunk 2077',
        shortDescription: 'Open-world action-adventure RPG set in Night City.',
        detailedDescription:
          '<p>Enter Night City.</p><video src="https://video.akamai.steamstatic.com/clip.mp4"></video>',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        releaseDate: 1607558400,
      }),
      'utf8'
    );

    const macFederator = federatorMod.createStorefrontLocalCacheFederator({
      platform: 'darwin',
      homedir: macHome,
      userDataDir: path.join(sandbox, 'mac-userdata'),
      bottlePaths: [crossoverBottle],
    });

    const resolvedCover = macFederator.resolveFederatedAsset({
      gameId: 'steam-1091500',
      steamAppId: 1091500,
      role: 'cover',
    });
    const resolvedHeader = macFederator.resolveFederatedAsset({
      gameId: 'steam-1091500',
      steamAppId: 1091500,
      role: 'header',
    });
    const resolvedIcon = macFederator.resolveFederatedAsset({
      gameId: 'steam-1091500',
      steamAppId: 1091500,
      role: 'icon',
    });

    expect(resolvedCover?.path).toBe(path.resolve(coverPath));
    expect(resolvedCover?.mimeType).toBe('image/jpeg');
    expect(resolvedHeader?.path).toBe(path.resolve(headerPath));
    expect(resolvedIcon?.path).toBe(path.resolve(iconPath));

    const localSteamMeta = macFederator.resolveLocalSteamMetadata(1091500);
    expect(localSteamMeta).toBeTruthy();
    expect(localSteamMeta.name).toBe('Cyberpunk 2077');
    expect(localSteamMeta.developers).toContain('CD PROJEKT RED');
    expect(localSteamMeta.detailedDescription).toContain('Enter Night City.');
    expect(localSteamMeta.detailedDescription).not.toContain('<video');
    expect(localSteamMeta.metadataQuality).toBe('local_federated');

    // 1B. Synthetic Windows legacy flat Steam librarycache root + Steam tuple-array userdata JSON
    const winSteamRoot = path.join(sandbox, 'win-steam-root');
    const winCacheDir = path.join(winSteamRoot, 'appcache', 'librarycache');
    const winUserCacheDir = path.join(winSteamRoot, 'userdata', '87654321', 'config', 'librarycache');
    fs.mkdirSync(winCacheDir, { recursive: true });
    fs.mkdirSync(winUserCacheDir, { recursive: true });
    const flatCoverPath = path.join(winCacheDir, '400_library_600x900.jpg');
    const flatHeaderPath = path.join(winCacheDir, '400_header.jpg');
    fs.writeFileSync(flatCoverPath, makeValidImageBuffer('jpg', 80, 0x31));
    fs.writeFileSync(flatHeaderPath, makeValidImageBuffer('jpg', 80, 0x32));
    fs.writeFileSync(
      path.join(winUserCacheDir, '400.json'),
      JSON.stringify([
        [
          'descriptions',
          {
            data: {
              strSnippet: 'Aperture Science puzzle platformer.',
              strFullDescription: '<p>Think with portals.</p><video src="https://bad/portal.webm"></video>',
            },
          },
        ],
        [
          'associations',
          {
            data: {
              rgDevelopers: [{ strName: 'Valve' }],
              rgPublishers: [{ strName: 'Valve' }],
            },
          },
        ],
      ]),
      'utf8'
    );

    const winFederator = federatorMod.createStorefrontLocalCacheFederator({
      platform: 'win32',
      homedir: path.join(sandbox, 'win-home'),
      userDataDir: path.join(sandbox, 'win-userdata'),
      steamRoots: [winSteamRoot],
    });

    expect(
      winFederator.resolveFederatedAsset({ steamAppId: 400, role: 'cover' })?.path
    ).toBe(path.resolve(flatCoverPath));
    expect(
      winFederator.resolveFederatedAsset({ steamAppId: 400, role: 'header' })?.path
    ).toBe(path.resolve(flatHeaderPath));
    const winPortalMeta = winFederator.resolveLocalSteamMetadata(400);
    expect(winPortalMeta?.developers).toContain('Valve');
    expect(winPortalMeta?.detailedDescription).not.toContain('<video');
  });

  it('queries GOG Galaxy galaxy-2.0.db with 64-bit WebCache.userId (> MAX_SAFE_INTEGER) without ERR_OUT_OF_RANGE and extracts local WebP artwork + GamePieces metadata', () => {
    const sandbox = makeTempSandbox('ol-fed-gog-');
    const gogRoot = path.join(sandbox, 'GOG.com', 'Galaxy');
    const storageDir = path.join(gogRoot, 'storage');
    const userId64 = '10000000000000042'; // > Number.MAX_SAFE_INTEGER (9007199254740991)
    const gogId = '1207658924';
    const webcacheDir = path.join(gogRoot, 'webcache', userId64, 'gog', gogId);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(webcacheDir, { recursive: true });

    const coverWebp = path.join(webcacheDir, 'vertical_cover_2x.webp');
    const bgWebp = path.join(webcacheDir, 'background_hero.webp');
    fs.writeFileSync(coverWebp, makeValidImageBuffer('webp', 96, 0x41));
    fs.writeFileSync(bgWebp, makeValidImageBuffer('webp', 96, 0x42));

    const dbPath = path.join(storageDir, 'galaxy-2.0.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE WebCache (id INTEGER PRIMARY KEY, releaseKey TEXT, userId INTEGER);
        CREATE TABLE WebCacheResourceTypes (id INTEGER PRIMARY KEY, type TEXT);
        CREATE TABLE WebCacheResources (
          webCacheId INTEGER,
          webCacheResourceTypeId INTEGER,
          filename TEXT
        );
        CREATE TABLE GamePieceTypes (id INTEGER PRIMARY KEY, type TEXT);
        CREATE TABLE GamePieces (
          releaseKey TEXT,
          gamePieceTypeId INTEGER,
          value TEXT
        );

        INSERT INTO WebCache (id, releaseKey, userId) VALUES (1, 'gog_${gogId}', 10000000000000042);
        INSERT INTO WebCacheResourceTypes (id, type) VALUES (10, 'verticalCover'), (11, 'background');
        INSERT INTO WebCacheResources (webCacheId, webCacheResourceTypeId, filename)
          VALUES (1, 10, 'vertical_cover_2x.webp'), (1, 11, 'background_hero.webp');

        INSERT INTO GamePieceTypes (id, type) VALUES
          (100, 'title'),
          (101, 'summary'),
          (102, 'meta'),
          (103, 'storeTags'),
          (104, 'osCompatibility');
      `);

      const insertPiece = db.prepare(
        'INSERT INTO GamePieces (releaseKey, gamePieceTypeId, value) VALUES (?, ?, ?)'
      );
      insertPiece.run(`gog_${gogId}`, 100, JSON.stringify({ title: 'The Witcher 3: Wild Hunt' }));
      insertPiece.run(
        `gog_${gogId}`,
        101,
        JSON.stringify({ summary: 'Story-driven open world RPG set in a dark fantasy universe.' })
      );
      insertPiece.run(
        `gog_${gogId}`,
        102,
        JSON.stringify({
          developers: ['CD PROJEKT RED'],
          publishers: ['CD PROJEKT'],
          genres: ['RPG', 'Adventure'],
          releaseDate: 1431993600,
        })
      );
      insertPiece.run(`gog_${gogId}`, 103, JSON.stringify({ tags: [{ name: 'Open World' }] }));
      insertPiece.run(`gog_${gogId}`, 104, JSON.stringify({ supported: ['windows', 'osx'] }));
    } finally {
      db.close();
    }

    const federator = federatorMod.createStorefrontLocalCacheFederator({
      platform: 'darwin',
      homedir: path.join(sandbox, 'home'),
      userDataDir: path.join(sandbox, 'userdata'),
      gogGalaxyRoots: [gogRoot],
    });

    const gogCover = federator.resolveFederatedAsset({
      gameId: `gog-${gogId}`,
      gogId,
      role: 'cover',
    });
    const gogHeader = federator.resolveFederatedAsset({
      gameId: `gog-${gogId}`,
      gogId,
      role: 'header',
    });

    expect(gogCover?.path).toBe(path.resolve(coverWebp));
    expect(gogCover?.mimeType).toBe('image/webp');
    expect(gogHeader?.path).toBe(path.resolve(bgWebp));
    expect(gogHeader?.mimeType).toBe('image/webp');

    const gogMeta = federator.resolveLocalGogMetadata(gogId);
    expect(gogMeta).toBeTruthy();
    expect(gogMeta.name).toBe('The Witcher 3: Wild Hunt');
    expect(gogMeta.developers).toContain('CD PROJEKT RED');
    expect(gogMeta.genres).toContain('RPG');
    expect(gogMeta.platforms.windows).toBe(true);
    expect(gogMeta.platforms.mac).toBe(true);
    expect(gogMeta.metadataQuality).toBe('local_federated');
  });

  it('resolves Epic Legendary metadata/<appName>.json and Heroic zero-extension SHA-256 images-cache across JPEG, PNG, WebP, GIF, and AVIF magic bytes', () => {
    const sandbox = makeTempSandbox('ol-fed-epic-');
    const heroicRoot = path.join(sandbox, 'heroic');
    const imagesCacheDir = path.join(heroicRoot, 'images-cache');
    const legendaryDir = path.join(sandbox, 'legendary');
    const legendaryMetaDir = path.join(legendaryDir, 'metadata');
    fs.mkdirSync(imagesCacheDir, { recursive: true });
    fs.mkdirSync(legendaryMetaDir, { recursive: true });

    const tallCoverUrl = 'https://cdn1.epicgames.com/offer/alan-wake-2/tall-cover';
    const wideBannerUrl = 'https://cdn1.epicgames.com/offer/alan-wake-2/wide-banner';
    const formats: Array<{ fmt: 'jpg' | 'png' | 'webp' | 'gif' | 'avif'; mime: string }> = [
      { fmt: 'jpg', mime: 'image/jpeg' },
      { fmt: 'png', mime: 'image/png' },
      { fmt: 'webp', mime: 'image/webp' },
      { fmt: 'gif', mime: 'image/gif' },
      { fmt: 'avif', mime: 'image/avif' },
    ];

    for (const { fmt, mime } of formats) {
      const url = `https://cdn1.epicgames.com/asset/zero-ext-${fmt}`;
      const digest = crypto.createHash('sha256').update(url).digest('hex');
      const zeroExtPath = path.join(imagesCacheDir, digest);
      fs.writeFileSync(zeroExtPath, makeValidImageBuffer(fmt, 80));

      const fed = federatorMod.createStorefrontLocalCacheFederator({
        platform: 'darwin',
        homedir: path.join(sandbox, 'home'),
        userDataDir: path.join(sandbox, 'userdata'),
        heroicRoots: [heroicRoot],
        legendaryDirs: [legendaryDir],
      });
      const hit = fed.resolveFederatedAsset({
        gameId: `epic-test-${fmt}`,
        role: 'cover',
        url,
      });
      expect(hit?.path).toBe(path.resolve(zeroExtPath));
      expect(hit?.mimeType).toBe(mime);
    }

    // Write Legendary metadata/<appName>.json + Heroic SHA-256 tall cover & wide banner
    fs.writeFileSync(
      path.join(imagesCacheDir, crypto.createHash('sha256').update(tallCoverUrl).digest('hex')),
      makeValidImageBuffer('avif', 96)
    );
    fs.writeFileSync(
      path.join(imagesCacheDir, crypto.createHash('sha256').update(wideBannerUrl).digest('hex')),
      makeValidImageBuffer('webp', 96)
    );
    fs.writeFileSync(
      path.join(legendaryMetaDir, 'CypressApp.json'),
      JSON.stringify({
        app_name: 'CypressApp',
        app_title: 'Control Ultimate Edition',
        metadata: {
          description: 'Supernatural 3rd-person action-adventure from Remedy Entertainment.',
          developer: 'Remedy Entertainment',
          publisher: '505 Games',
          keyImages: [
            { type: 'DieselGameBoxTall', url: tallCoverUrl },
            { type: 'DieselGameBox', url: wideBannerUrl },
          ],
          releaseInfo: [{ platform: ['Windows', 'Mac'], dateAdded: '2020-08-27T00:00:00.000Z' }],
        },
      }),
      'utf8'
    );

    const federator = federatorMod.createStorefrontLocalCacheFederator({
      platform: 'darwin',
      homedir: path.join(sandbox, 'home'),
      userDataDir: path.join(sandbox, 'userdata'),
      heroicRoots: [heroicRoot],
      legendaryDirs: [legendaryDir],
    });

    const epicCover = federator.resolveFederatedAsset({
      gameId: 'epic-CypressApp',
      epicAppName: 'CypressApp',
      role: 'cover',
    });
    expect(epicCover?.mimeType).toBe('image/avif');

    const epicMeta = federator.resolveLocalEpicMetadata('CypressApp');
    expect(epicMeta).toBeTruthy();
    expect(epicMeta.name).toBe('Control Ultimate Edition');
    expect(epicMeta.developers).toContain('Remedy Entertainment');
    expect(epicMeta.platforms.windows).toBe(true);
    expect(epicMeta.platforms.mac).toBe(true);
    expect(epicMeta.metadataQuality).toBe('local_federated');
  });

  it('rejects symlinks, <33B truncated stubs, HTML disguised as .jpg, and MP4 video containers (ftypmp42)', () => {
    const sandbox = makeTempSandbox('ol-fed-sec-');
    const steamRoot = path.join(sandbox, 'steam');
    const cacheRoot = path.join(steamRoot, 'appcache', 'librarycache');
    fs.mkdirSync(cacheRoot, { recursive: true });

    // 1. <33B stub
    const stubFile = path.join(cacheRoot, '101_library_600x900.jpg');
    fs.writeFileSync(stubFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    expect(federatorMod.validateFederatedImageFile(stubFile, cacheRoot)?.valid).toBe(false);

    // 2. HTML WAF page disguised as .jpg (>= 33 bytes)
    const htmlDisguised = path.join(cacheRoot, '102_library_600x900.jpg');
    fs.writeFileSync(
      htmlDisguised,
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare</body></html>',
      'utf8'
    );
    expect(federatorMod.validateFederatedImageFile(htmlDisguised, cacheRoot)?.valid).toBe(false);

    // 3. MP4 video (ftypmp42) disguised as .jpg
    const mp4Disguised = path.join(cacheRoot, '103_library_600x900.jpg');
    fs.writeFileSync(mp4Disguised, makeFakeMp4Buffer(96));
    expect(federatorMod.validateFederatedImageFile(mp4Disguised, cacheRoot)?.valid).toBe(false);

    // 4. Symlink pointing to an external secret file
    const outsideSecret = path.join(sandbox, 'outside-secret.jpg');
    fs.writeFileSync(outsideSecret, makeValidImageBuffer('jpg', 96));
    const symlinkFile = path.join(cacheRoot, '104_library_600x900.jpg');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideSecret, symlinkFile);
      symlinkCreated = true;
    } catch {
      // Unprivileged Windows without Developer Mode may disallow symlink creation
    }
    if (symlinkCreated) {
      expect(federatorMod.validateFederatedImageFile(symlinkFile, cacheRoot)?.valid).toBe(false);
    }

    const federator = federatorMod.createStorefrontLocalCacheFederator({
      platform: process.platform,
      homedir: path.join(sandbox, 'home'),
      userDataDir: path.join(sandbox, 'userdata'),
      steamRoots: [steamRoot],
    });
    for (const appId of [101, 102, 103, ...(symlinkCreated ? [104] : [])]) {
      expect(federator.resolveFederatedAsset({ steamAppId: appId, role: 'cover' })).toBeNull();
    }
  });
});

// ===========================================================================
// GROUP 2: OfflineVaultService, Content-Addressed Blobs, ol-media:// & Zero-Video
// ===========================================================================
describe('2. OfflineVaultService, Content-Addressed Blobs, ol-media:// Protocol & Zero-Video Invariant', () => {
  it('enforces tier caps (compact 150MB, balanced 350MB default, max_offline/full_archive 1.5GB), setTier(), and clear({ preserveMetadata: true })', async () => {
    const sandbox = makeTempSandbox('ol-vault-tiers-');
    const jpgBuf = makeValidImageBuffer('jpg', 512, 0x55);
    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      fetchImpl: vi.fn(async () =>
        makeMockHttpResponse({
          status: 200,
          body: jpgBuf,
          headers: { 'content-type': 'image/jpeg' },
        })
      ),
    });

    try {
      expect(offlineVaultMod.OFFLINE_VAULT_TIER_CAPS).toEqual({
        compact: 150 * 1024 * 1024,
        balanced: 350 * 1024 * 1024,
        max_offline: 1536 * 1024 * 1024,
        full_archive: 1536 * 1024 * 1024,
      });

      const initialStats = vault.getStats();
      expect(initialStats.tier).toBe('balanced');
      expect(initialStats.maxBytes).toBe(350 * 1024 * 1024);

      expect(vault.setTier('compact').stats.maxBytes).toBe(150 * 1024 * 1024);
      expect(vault.setTier('max_offline').stats.maxBytes).toBe(1536 * 1024 * 1024);
      expect(vault.setTier('full_archive').stats.maxBytes).toBe(1536 * 1024 * 1024);

      vault.saveGameDetail({
        gameId: 'steam-620',
        canonicalTitle: 'Portal 2',
        steamAppId: 620,
        metadataQuality: 'authoritative',
        enrichedMetadata: {
          appId: 620,
          name: 'Portal 2',
          shortDescription: 'Perpetual Testing Initiative.',
          screenshots: [{ id: 1, pathThumbnail: 'https://cdn.example.test/s1.jpg', pathFull: 'https://cdn.example.test/s1_full.jpg' }],
        },
      });

      const mediaRes = await vault.resolveMediaRequest({
        gameId: 'steam-620',
        role: 'cover',
        ordinal: 0,
        url: 'https://cdn.example.test/portal2_cover.jpg',
      });
      expect(mediaRes.source).toBe('upstream_persisted');
      expect(vault.getStats().blobCount).toBe(1);

      const cleared = vault.clear({ preserveMetadata: true });
      expect(cleared.success).toBe(true);
      expect(cleared.stats.blobCount).toBe(0);
      expect(cleared.stats.blobBytes).toBe(0);

      // Metadata in vault_games must remain completely intact!
      const preservedDetail = vault.getGameDetail('steam-620');
      expect(preservedDetail?.metadataQuality).toBe('authoritative');
      expect(preservedDetail?.enrichedMetadata?.name).toBe('Portal 2');
      expect(preservedDetail?.enrichedMetadata?.shortDescription).toBe('Perpetual Testing Initiative.');
    } finally {
      vault.shutdown();
    }
  });

  it('prevents skeleton_fallback or empty payloads from clobbering authoritative/scraped metadata in upsertGames and saveGameDetail', () => {
    const sandbox = makeTempSandbox('ol-vault-quality-');
    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
    });

    try {
      // Seed scraped metadata first, upgrade to authoritative, then attempt downgrade to skeleton_fallback & null
      vault.saveGameDetail({
        gameId: 'gog-1001',
        canonicalTitle: 'Disco Elysium',
        metadataQuality: 'scraped',
        enrichedMetadata: {
          appId: 0,
          name: 'Disco Elysium',
          shortDescription: 'Scraped detective RPG synopsis.',
        },
      });
      expect(vault.getGameDetail('gog-1001')?.metadataQuality).toBe('scraped');

      // Skeleton downgrade via saveGameDetail must be rejected
      vault.saveGameDetail({
        gameId: 'gog-1001',
        canonicalTitle: 'Disco Elysium',
        metadataQuality: 'skeleton_fallback',
        enrichedMetadata: {
          appId: 0,
          name: 'Disco Elysium',
          shortDescription: 'Disco Elysium in your unified library.',
          metadataQuality: 'skeleton_fallback',
        },
      });
      expect(vault.getGameDetail('gog-1001')?.metadataQuality).toBe('scraped');
      expect(vault.getGameDetail('gog-1001')?.enrichedMetadata?.shortDescription).toBe(
        'Scraped detective RPG synopsis.'
      );

      // Upgrade scraped -> authoritative must succeed
      vault.saveGameDetail({
        gameId: 'gog-1001',
        canonicalTitle: 'Disco Elysium',
        metadataQuality: 'authoritative',
        enrichedMetadata: {
          appId: 632470,
          name: 'Disco Elysium - The Final Cut',
          shortDescription: 'Authoritative Final Cut synopsis.',
          screenshots: [{ id: 1, pathThumbnail: 'https://cdn.example.test/de1.jpg', pathFull: 'https://cdn.example.test/de1f.jpg' }],
          metadataQuality: 'authoritative',
        },
      });
      expect(vault.getGameDetail('gog-1001')?.metadataQuality).toBe('authoritative');

      // Downgrade via upsertGames with skeleton_fallback or missing enrichedMetadata must preserve authoritative
      vault.upsertGames([
        {
          id: 'gog-1001',
          title: 'Disco Elysium',
          platforms: [{ platformId: 'gog', platformGameId: '1001', installed: true }],
          enrichedMetadata: {
            appId: 0,
            name: 'Disco Elysium',
            shortDescription: 'Skeleton fallback overwrite attempt',
            metadataQuality: 'skeleton_fallback',
          },
        },
        {
          id: 'gog-1001',
          title: 'Disco Elysium',
          platforms: [{ platformId: 'gog', platformGameId: '1001', installed: true }],
        },
      ]);

      const afterUpsert = vault.getGameDetail('gog-1001');
      expect(afterUpsert?.metadataQuality).toBe('authoritative');
      expect(afterUpsert?.enrichedMetadata?.shortDescription).toBe('Authoritative Final Cut synopsis.');
    } finally {
      vault.shutdown();
    }
  });

  it('enforces the Zero Offline Video Caching Invariant across resolveMediaRequest, ol-media:// protocol handler, and extractStaticHydrationAssets', async () => {
    const sandbox = makeTempSandbox('ol-vault-novideo-');
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('disguised-video-stream')) {
        return makeMockHttpResponse({
          status: 200,
          body: makeFakeMp4Buffer(128),
          headers: { 'content-type': 'video/mp4' },
        });
      }
      if (url.includes('disguised-hls-manifest')) {
        return makeMockHttpResponse({
          status: 200,
          body: '#EXTM3U\n#EXT-X-VERSION:3\n',
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      return makeMockHttpResponse({
        status: 200,
        body: makeValidImageBuffer('jpg', 96),
        headers: { 'content-type': 'image/jpeg' },
      });
    });

    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      fetchImpl: fetchSpy,
    });
    const protocolHandler = offlineVaultIpcMod.createOlMediaProtocolHandler({
      offlineVaultService: vault,
    });

    try {
      const forbiddenVideoUrls = [
        'https://video.akamai.steamstatic.com/store_trailers/256999/movie_max.mp4',
        'https://video.akamai.steamstatic.com/store_trailers/256999/movie480.webm',
        'https://video.akamai.steamstatic.com/store_trailers/256999/hls_264_master.m3u8?t=123',
      ];

      for (const videoUrl of forbiddenVideoUrls) {
        expect(offlineVaultMod.isRejectedVideoUrl(videoUrl)).toBe(true);
        const directRes = await vault.resolveMediaRequest({
          gameId: 'steam-1091500',
          role: 'inline_img',
          url: videoUrl,
        });
        expect(directRes.status).toBe(415);
        expect(directRes.reason).toBe('video_caching_prohibited');

        const protoResp: Response = await protocolHandler({
          url: `ol-media://asset?url=${encodeURIComponent(videoUrl)}&gameId=steam-1091500&role=inline_img`,
        });
        expect(protoResp.status).toBe(415);
      }
      // Network must not even be contacted for .mp4/.webm/.m3u8 URLs
      expect(fetchSpy).not.toHaveBeenCalled();

      // Upstream video/mp4 and HLS MIME responses on extensionless URLs must also be rejected with 415
      const mp4MimeResp: Response = await protocolHandler({
        url: toOlMediaUrl({
          url: 'https://cdn.example.test/disguised-video-stream',
          gameId: 'steam-1091500',
          role: 'inline_img',
        }),
      });
      const hlsMimeResp: Response = await protocolHandler({
        url: toOlMediaUrl({
          url: 'https://cdn.example.test/disguised-hls-manifest',
          gameId: 'steam-1091500',
          role: 'inline_img',
        }),
      });
      expect(mp4MimeResp.status).toBe(415);
      expect(hlsMimeResp.status).toBe(415);
      expect(vault.getStats().blobCount).toBe(0);

      // Verify extractStaticHydrationAssets extracts static images + video posters while excluding all videos
      const sampleGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/library_600x900_2x.jpg',
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
        iconUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/icon.jpg',
        platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Sci-fi'],
      };
      const sampleMeta: SteamEnrichedMetadata = makeSteamMetadata({
        appId: 1091500,
        name: 'Cyberpunk 2077',
        shortDescription: 'Night City open-world RPG.',
        aboutTheGame: `
          <p>Welcome to Night City</p>
          <img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/extras/banner1.png" />
          <img src="https://video.akamai.steamstatic.com/store_trailers/bad.webm" />
          <video poster="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/extras/clip_poster.avif" autoplay loop muted>
            <source src="https://video.akamai.steamstatic.com/store_trailers/clip.mp4" type="video/mp4" />
          </video>
        `,
        screenshots: Array.from({ length: 8 }, (_, idx) => ({
          id: idx + 1,
          pathThumbnail: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_${idx}_600x338.jpg`,
          pathFull: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_${idx}_1920x1080.jpg`,
        })),
        movies: [
          {
            id: 99,
            name: 'Launch Trailer',
            thumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/256812/movie_thumb.jpg',
            webm: { 480: 'https://video.akamai.steamstatic.com/store_trailers/256812/movie480.webm' },
            mp4: { max: 'https://video.akamai.steamstatic.com/store_trailers/256812/movie_max.mp4' },
            hls: 'https://video.akamai.steamstatic.com/store_trailers/256812/hls.m3u8',
          },
        ],
      });

      const assets = extractStaticHydrationAssets(sampleGame, sampleMeta);
      const roles = assets.map((a) => a.role);
      expect(roles).toContain('cover');
      expect(roles).toContain('header');
      expect(roles).toContain('icon');
      expect(assets.filter((a) => a.role === 'screenshot_thumb')).toHaveLength(5);
      expect(assets.find((a) => a.role === 'inline_img')?.url).toContain('banner1.png');
      expect(assets.find((a) => a.role === 'inline_poster')?.url).toContain('clip_poster.avif');
      expect(assets.some((a) => /\.(?:mp4|webm|m3u8)(?:$|[?#])/i.test(a.url))).toBe(false);
    } finally {
      vault.shutdown();
    }
  });

  it('normalizes oversized PNG (>250KB) via nativeImage.toJPEG(82), bypasses disk writes when free disk < 2GB, pins installed covers during LRU eviction, aliases Steam CDN mirrors, and checkpoints WAL on shutdown()', async () => {
    const sandbox = makeTempSandbox('ol-vault-lru-');

    // 2A. Low-disk-space (< 2 GB) passthrough guard: 0 disk blobs written
    const lowDiskDir = path.join(sandbox, 'low-disk');
    const smallJpg = makeValidImageBuffer('jpg', 128, 0x61);
    const lowDiskVault = offlineVaultMod.createOfflineVaultService({
      userDataDir: lowDiskDir,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      freeDiskBytesFn: () => 1024 * 1024 * 1024, // 1 GB < 2 GB floor
      fetchImpl: vi.fn(async () =>
        makeMockHttpResponse({
          status: 200,
          body: smallJpg,
          headers: { 'content-type': 'image/jpeg' },
        })
      ),
    });
    const lowDiskRes = await lowDiskVault.resolveMediaRequest({
      gameId: 'steam-570',
      role: 'cover',
      url: 'https://cdn.example.test/dota2.jpg',
    });
    expect(lowDiskRes.source).toBe('upstream_passthrough_low_disk');
    expect(lowDiskRes.buffer.equals(smallJpg)).toBe(true);
    expect(lowDiskVault.getStats().blobCount).toBe(0);
    lowDiskVault.shutdown();

    // 2B. Oversized PNG (>250KB) normalization + Steam CDN mirror alias + LRU eviction pinning + clean shutdown()
    const mainDir = path.join(sandbox, 'main-vault');
    const oversizedPng = makeValidImageBuffer('png', 300 * 1024, 0x71); // 300 KB > 250 KB threshold
    const normalizedJpg = makeValidImageBuffer('jpg', 40 * 1024, 0x72); // Normalized 40 KB JPEG
    const resizeSpy = vi.fn();
    const toJpegSpy = vi.fn(() => normalizedJpg);

    const mockNativeImage = {
      createFromBuffer: vi.fn(() => ({
        isEmpty: () => false,
        getSize: () => ({ width: 1200, height: 1800 }),
        resize: (dims: { width: number; height?: number }) => {
          resizeSpy(dims);
          return {
            isEmpty: () => false,
            toJPEG: toJpegSpy,
          };
        },
        toJPEG: toJpegSpy,
      })),
    };

    let networkEnabled = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (!networkEnabled) {
        throw new Error('Simulated offline network unreachable');
      }
      if (url.includes('oversized.png')) {
        return makeMockHttpResponse({
          status: 200,
          body: oversizedPng,
          headers: { 'content-type': 'image/png' },
        });
      }
      // Return distinct ~60 KB JPEGs per URL for deterministic LRU eviction math
      const seed = crypto.createHash('md5').update(url).digest()[0];
      return makeMockHttpResponse({
        status: 200,
        body: makeValidImageBuffer('jpg', 60 * 1024, seed),
        headers: { 'content-type': 'image/jpeg' },
      });
    });

    let fakeNow = 1_700_000_000_000;
    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: mainDir,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      nowFn: () => fakeNow,
      freeDiskBytesFn: () => 50 * 1024 * 1024 * 1024,
      nativeImage: mockNativeImage,
      fetchImpl: fetchMock,
    });

    // Register installed game vs uninstalled game
    vault.upsertGames([
      {
        id: 'steam-1145360',
        title: 'Hades',
        steamAppId: 1145360,
        isInstalled: true,
        platforms: [{ platformId: 'steam', platformGameId: '1145360', installed: true }],
      },
      {
        id: 'steam-999999',
        title: 'Uninstalled Showcase Title',
        steamAppId: 999999,
        isInstalled: false,
        platforms: [{ platformId: 'steam', platformGameId: '999999', installed: false }],
      },
    ]);

    // Store installed game's oversized PNG cover via Akamai Steam CDN mirror
    const installedCoverRes = await vault.resolveMediaRequest({
      gameId: 'steam-1145360',
      role: 'cover',
      ordinal: 0,
      url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/oversized.png',
    });
    expect(installedCoverRes.source).toBe('upstream_persisted');
    expect(installedCoverRes.mimeType).toBe('image/jpeg');
    expect(installedCoverRes.sizeBytes).toBe(normalizedJpg.length);
    expect(resizeSpy).toHaveBeenCalledWith({ width: 600, height: 900 });
    expect(toJpegSpy).toHaveBeenCalledWith(82);

    // Populate 6 unpinned screenshot_full blobs (360 KB) on uninstalled game
    fakeNow += 1000;
    for (let i = 0; i < 6; i++) {
      fakeNow += 100;
      await vault.resolveMediaRequest({
        gameId: 'steam-999999',
        role: 'screenshot_full',
        ordinal: i,
        url: `https://cdn.example.test/uninstalled/shot_${i}.jpg`,
      });
    }
    expect(vault.getStats().blobCount).toBe(7);

    // Phase 1 LRU eviction: cap just below current total -> evicts unpinned screenshots down to <= 80% target
    const preEvictStats = vault.getStats();
    const tightCap = preEvictStats.totalBytes - 10 * 1024;
    const evictResult = vault.maybeEvictBlobs({ forceIfOverMax: true, maxBytes: tightCap });
    expect(evictResult.evictedCount).toBeGreaterThanOrEqual(2);
    expect(preEvictStats.sqliteBytes + vault.getStats().blobBytes).toBeLessThanOrEqual(
      Math.floor(tightCap * 0.8)
    );

    // Phase 2 extreme eviction pressure (maxBytes = 100 KB): evicts ALL remaining unpinned screenshots
    // while strictly refusing to evict the installed game's pinned cover (rank 100)!
    vault.maybeEvictBlobs({ forceIfOverMax: true, maxBytes: 100 * 1024 });
    expect(vault.getStats().blobCount).toBe(1);
    expect(vault.getStats().blobBytes).toBe(normalizedJpg.length);

    // Cut network completely and request the installed cover via Cloudflare Steam CDN mirror alias!
    networkEnabled = false;
    const callsBeforeOfflineAlias = fetchMock.mock.calls.length;
    const mirrorHit = await vault.resolveMediaRequest({
      gameId: 'steam-1145360',
      role: 'cover',
      ordinal: 0,
      url: 'https://cdn.cloudflare.steamstatic.com/store_item_assets/steam/apps/1145360/oversized.png',
    });
    expect(mirrorHit.kind).toBe('file');
    expect(mirrorHit.source).toBe('vault_blob');
    expect(fs.existsSync(mirrorHit.filePath)).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeOfflineAlias);

    // Verify clean shutdown() truncates WAL and closes SQLite handle cleanly
    const dbFile = path.join(mainDir, 'offline-vault', 'catalog_metadata.sqlite');
    const walFile = `${dbFile}-wal`;
    vault.shutdown();
    expect(vault.db).toBeNull();
    expect(fs.existsSync(dbFile)).toBe(true);
    if (fs.existsSync(walFile)) {
      expect(fs.statSync(walFile).size).toBe(0);
    }
  });
});

// ===========================================================================
// GROUP 3: Storefront Outages (503), Bot-Protection / WAF & Circuit Breaker
// ===========================================================================
describe('3. Storefront Outages (503), Bot-Protection / WAF (429, 403 Challenge HTML) & Single-Canary Circuit Breaker', () => {
  it('detects Cloudflare & Akamai WAF challenges (429, 403, cf-mitigated, 200 HTML challenge), escalates cooldown (15m -> 30m -> 60m or Retry-After), and NEVER poisons 404 negative cache', async () => {
    const sandbox = makeTempSandbox('ol-waf-');
    let fakeNow = 1_700_000_000_000;
    let nextResponse: Response = makeMockHttpResponse({ status: 200 });

    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      nowFn: () => fakeNow,
      fetchImpl: vi.fn(async () => nextResponse),
    });

    try {
      const cloudflareHtml =
        '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-please-wait">Checking your browser</div></body></html>';
      const akamaiHtml =
        '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don\'t have permission to access this server. Reference #18.2d341202.1700000000.abcdef</body></html>';

      expect(
        isWafOrChallengeResponse(403, cloudflareHtml, { 'cf-mitigated': 'challenge' })
      ).toBe(true);
      expect(isWafOrChallengeResponse(403, akamaiHtml, { server: 'AkamaiGHost' })).toBe(true);
      expect(
        isWafOrChallengeResponse(200, cloudflareHtml, { 'content-type': 'text/html' }, true)
      ).toBe(true);

      // 1st WAF hit on host A -> 15m circuit open, zero 404 row in game_media_assets
      nextResponse = makeMockHttpResponse({
        status: 403,
        body: cloudflareHtml,
        headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
      });
      const r1 = await vault.resolveMediaRequest({
        gameId: 'steam-10',
        role: 'cover',
        url: 'https://waf-host.example.test/cover1.jpg',
      });
      expect(r1.reason).toBe('waf_blocked');
      const snap1 = vault.getEndpointHealth('waf-host.example.test');
      expect(snap1.state).toBe('OPEN');
      expect(snap1.openedUntil - fakeNow).toBe(15 * 60 * 1000);

      // Advance past 15m -> 2nd WAF hit (Akamai Access Denied) -> 30m circuit open
      fakeNow = snap1.openedUntil + 1;
      nextResponse = makeMockHttpResponse({
        status: 403,
        body: akamaiHtml,
        headers: { 'content-type': 'text/html', server: 'AkamaiGHost' },
      });
      await vault.resolveMediaRequest({
        gameId: 'steam-10',
        role: 'cover',
        url: 'https://waf-host.example.test/cover1.jpg',
      });
      const snap2 = vault.getEndpointHealth('waf-host.example.test');
      expect(snap2.openedUntil - fakeNow).toBe(30 * 60 * 1000);

      // Advance past 30m -> 3rd WAF hit (200 OK HTML challenge when image expected) -> 60m circuit open
      fakeNow = snap2.openedUntil + 1;
      nextResponse = makeMockHttpResponse({
        status: 200,
        body: cloudflareHtml,
        headers: { 'content-type': 'text/html' },
      });
      const r3 = await vault.resolveMediaRequest({
        gameId: 'steam-10',
        role: 'cover',
        url: 'https://waf-host.example.test/cover1.jpg',
      });
      expect(r3.reason).toBe('waf_blocked');
      const snap3 = vault.getEndpointHealth('waf-host.example.test');
      expect(snap3.openedUntil - fakeNow).toBe(60 * 60 * 1000);

      // Explicit Retry-After header (e.g. 429 Retry-After: 120) must be honored
      nextResponse = makeMockHttpResponse({
        status: 429,
        body: 'Too Many Requests',
        headers: { 'retry-after': '120' },
      });
      await vault.resolveMediaRequest({
        gameId: 'steam-20',
        role: 'cover',
        url: 'https://ratelimit-host.example.test/cover2.jpg',
      });
      expect(vault.getEndpointHealth('ratelimit-host.example.test').openedUntil - fakeNow).toBe(
        120 * 1000
      );

      // Verify ZERO 404 negative cache entries were recorded for WAF-blocked assets!
      const assetRows = vault
        .ensureOpen()
        .prepare('SELECT * FROM game_media_assets WHERE last_status_code = 404')
        .all();
      expect(assetRows).toHaveLength(0);
    } finally {
      vault.shutdown();
    }
  });

  it('enforces single-canary HALF_OPEN circuit breaker in OfflineVaultService: >=3 503s trip OPEN, strictly 1 canary allowed in HALF_OPEN, canary 200 closes & canary failure re-opens', async () => {
    const sandbox = makeTempSandbox('ol-cb-vault-');
    let fakeNow = 1_700_000_000_000;
    let mode: '503' | 'slow_canary_fail' | 'slow_canary_ok' = '503';
    let releaseCanary!: () => void;

    const fetchSpy = vi.fn(async () => {
      if (mode === '503') {
        return makeMockHttpResponse({ status: 503, body: 'Service Unavailable' });
      }
      await new Promise<void>((resolve) => {
        releaseCanary = resolve;
      });
      if (mode === 'slow_canary_fail') {
        return makeMockHttpResponse({ status: 503, body: 'Still down' });
      }
      return makeMockHttpResponse({
        status: 200,
        body: makeValidImageBuffer('jpg', 96),
        headers: { 'content-type': 'image/jpeg' },
      });
    });

    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      nowFn: () => fakeNow,
      fetchImpl: fetchSpy,
    });

    try {
      const host = 'outage-cdn.example.test';
      // 1st and 2nd 503 keep circuit CLOSED; 3rd consecutive 503 trips OPEN (30s)
      for (let i = 1; i <= 3; i++) {
        const res = await vault.resolveMediaRequest({
          gameId: `steam-${i}`,
          role: 'cover',
          url: `https://${host}/img_${i}.jpg`,
        });
        expect(res.status).toBe(503);
        expect(vault.getEndpointHealth(host).state).toBe(i < 3 ? 'CLOSED' : 'OPEN');
      }
      const openSnap = vault.getEndpointHealth(host);
      expect(openSnap.openedUntil - fakeNow).toBe(30 * 1000);

      // While OPEN, requests fast-fail without calling fetch
      const callsAfterTrip = fetchSpy.mock.calls.length;
      const blockedWhileOpen = await vault.resolveMediaRequest({
        gameId: 'steam-99',
        role: 'cover',
        url: `https://${host}/img_99.jpg`,
      });
      expect(blockedWhileOpen.reason).toBe('circuit_open');
      expect(fetchSpy.mock.calls.length).toBe(callsAfterTrip);

      // Advance clock past openedUntil -> HALF_OPEN: launch 2 concurrent requests!
      // Request A becomes the single canary; Request B MUST fast-fail immediately!
      fakeNow = openSnap.openedUntil + 10;
      expect(vault.getEndpointHealth(host).state).toBe('HALF_OPEN');
      mode = 'slow_canary_fail';

      const canaryFailPromise = vault.resolveMediaRequest({
        gameId: 'steam-101',
        role: 'cover',
        url: `https://${host}/canary_1.jpg`,
      });
      const concurrentFastFail = await vault.resolveMediaRequest({
        gameId: 'steam-102',
        role: 'cover',
        url: `https://${host}/concurrent_2.jpg`,
      });
      expect(concurrentFastFail.status).toBe(503);
      expect(concurrentFastFail.reason).toBe('circuit_open');
      expect(fetchSpy.mock.calls.length).toBe(callsAfterTrip + 1); // Strictly 1 canary hit network!

      // Canary fails with 503 -> circuit immediately re-opens with escalated 2m backoff (failures = 4)
      releaseCanary();
      const canaryFailRes = await canaryFailPromise;
      expect(canaryFailRes.status).toBe(503);
      const reopenedSnap = vault.getEndpointHealth(host);
      expect(reopenedSnap.state).toBe('OPEN');
      expect(reopenedSnap.openedUntil - fakeNow).toBe(2 * 60 * 1000);

      // Advance past 2m -> HALF_OPEN again -> Canary succeeds with 200 OK -> circuit transitions to CLOSED!
      fakeNow = reopenedSnap.openedUntil + 10;
      mode = 'slow_canary_ok';
      const canaryOkPromise = vault.resolveMediaRequest({
        gameId: 'steam-103',
        role: 'cover',
        url: `https://${host}/canary_ok.jpg`,
      });
      // Allow microtask to reach await in fetchSpy
      await Promise.resolve();
      releaseCanary();
      const canaryOkRes = await canaryOkPromise;
      expect(canaryOkRes.source).toBe('upstream_persisted');
      const closedSnap = vault.getEndpointHealth(host);
      expect(closedSnap.state).toBe('CLOSED');
      expect(closedSnap.consecutiveFailures).toBe(0);
    } finally {
      vault.shutdown();
    }
  });

  it('enforces single-canary HALF_OPEN circuit breaker in renderer RequestScheduler across 503 outages and 200 recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const scheduler = new RequestScheduler();
    scheduler.setEnforceDelays(true);
    const domain = 'store.steampowered.com';

    try {
      // 1 scheduled task with 2 retries = 3 consecutive 503 failures -> trips OPEN (30s cooldown)
      const outageTask = scheduler.schedule(
        `https://${domain}/api/appdetails?appids=1`,
        async () => {
          throw Object.assign(new Error('HTTP 503 Service Unavailable'), { status: 503 });
        },
        Priority.P0_INTERACTIVE,
        domain
      );
      const outageAssertion = expect(outageTask).rejects.toThrow('503');
      await vi.advanceTimersByTimeAsync(2500);
      await outageAssertion;

      expect(scheduler.isRateLimited(domain)).toBe(true);
      expect(scheduler.getCooldownRemaining(domain)).toBeGreaterThanOrEqual(28);
      expect(scheduler.getCooldownRemaining(domain)).toBeLessThanOrEqual(30);
      expect(onlineLifecycleManager.getEndpointHealth(domain)?.state).toBe('OPEN');

      // While OPEN, new callers fast-fail immediately with isRateLimited = true
      await expect(
        scheduler.schedule(
          `https://${domain}/api/appdetails?appids=blocked`,
          async () => 'should-not-run',
          Priority.P0_INTERACTIVE,
          domain
        )
      ).rejects.toMatchObject({ isRateLimited: true });

      // Advance past 30s -> HALF_OPEN: dispatch 2 concurrent tasks!
      // Strictly 1 canary executes while the 2nd task is held until canary finishes!
      await vi.advanceTimersByTimeAsync(30_050);
      expect(onlineLifecycleManager.getEndpointHealth(domain)?.state).toBe('HALF_OPEN');

      let rejectCanary!: (err: Error) => void;
      let canaryDispatched = false;
      let secondDispatched = false;

      const canaryFailTask = scheduler.schedule(
        `https://${domain}/api/appdetails?appids=canary1`,
        () => {
          canaryDispatched = true;
          return new Promise<string>((_resolve, reject) => {
            rejectCanary = reject;
          });
        },
        Priority.P0_INTERACTIVE,
        domain
      );
      const queuedBehindCanaryTask = scheduler.schedule(
        `https://${domain}/api/appdetails?appids=queued2`,
        async () => {
          secondDispatched = true;
          return 'recovered-payload';
        },
        Priority.P0_INTERACTIVE,
        domain
      );

      await Promise.resolve();
      expect(canaryDispatched).toBe(true);
      expect(secondDispatched).toBe(false);
      expect(onlineLifecycleManager.getEndpointHealth(domain)?.state).toBe('HALF_OPEN');

      // Canary fails with 503 -> circuit immediately re-opens for escalated 60s cooldown, keeping 2nd task held!
      const canaryFailAssertion = expect(canaryFailTask).rejects.toThrow('Still 503');
      rejectCanary(Object.assign(new Error('Still 503'), { status: 503 }));
      await canaryFailAssertion;

      expect(secondDispatched).toBe(false);
      expect(scheduler.isRateLimited(domain)).toBe(true);
      expect(scheduler.getCooldownRemaining(domain)).toBe(60);
      expect(onlineLifecycleManager.getEndpointHealth(domain)?.state).toBe('OPEN');

      // Advance past 60s -> queued task becomes the next single canary, succeeds, and closes circuit!
      await vi.advanceTimersByTimeAsync(60_050);
      const recoveredVal = await queuedBehindCanaryTask;
      expect(recoveredVal).toBe('recovered-payload');
      expect(secondDispatched).toBe(true);
      expect(scheduler.isRateLimited(domain)).toBe(false);
      expect(onlineLifecycleManager.getEndpointHealth(domain)?.state).toBe('CLOSED');
    } finally {
      scheduler.reset();
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// GROUP 4: Adaptive 404 Self-Healing Curve
// ===========================================================================
describe('4. Adaptive 404 Self-Healing Curve & Instant URL-Change Reset', () => {
  it('follows exact 6h -> 24h -> 7d -> 30d self-healing curve (never Infinity) and heals to cached blob when upstream recovers with 200 OK', async () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    expect(computeAdaptive404RetryDelayMs(1)).toBe(6 * HOUR);
    expect(computeAdaptive404RetryDelayMs(2)).toBe(24 * HOUR);
    expect(computeAdaptive404RetryDelayMs(3)).toBe(7 * DAY);
    expect(computeAdaptive404RetryDelayMs(4)).toBe(30 * DAY);
    expect(computeAdaptive404RetryDelayMs(25)).toBe(30 * DAY);
    expect(Number.isFinite(computeAdaptive404RetryDelayMs(999))).toBe(true);

    const sandbox = makeTempSandbox('ol-404-curve-');
    let fakeNow = 1_700_000_000_000;
    let shouldReturn200 = false;
    const fetchSpy = vi.fn(async () =>
      shouldReturn200
        ? makeMockHttpResponse({
            status: 200,
            body: makeValidImageBuffer('jpg', 96),
            headers: { 'content-type': 'image/jpeg' },
          })
        : makeMockHttpResponse({
            status: 404,
            body: 'Not Found',
            headers: { 'content-type': 'text/plain' },
          })
    );

    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      nowFn: () => fakeNow,
      fetchImpl: fetchSpy,
    });

    try {
      const targetUrl = 'https://cdn.example.test/game-777/library_600x900.jpg';
      const expectedDelays = [6 * HOUR, 24 * HOUR, 7 * DAY, 30 * DAY];

      for (let attempt = 0; attempt < expectedDelays.length; attempt++) {
        const res = await vault.resolveMediaRequest({
          gameId: 'steam-777',
          role: 'cover',
          ordinal: 0,
          url: targetUrl,
        });
        expect(res.status).toBe(404);
        expect(res.reason).toBe('not_found');

        const row = vault
          .ensureOpen()
          .prepare('SELECT failure_count, next_retry_at FROM game_media_assets WHERE game_id = ?')
          .get('steam-777');
        expect(Number(row.failure_count)).toBe(attempt + 1);
        expect(Number(row.next_retry_at) - fakeNow).toBe(expectedDelays[attempt]);

        // Request inside cooldown window must fast-fail without hitting upstream fetch
        const prevCalls = fetchSpy.mock.calls.length;
        fakeNow += 1000;
        const cooledRes = await vault.resolveMediaRequest({
          gameId: 'steam-777',
          role: 'cover',
          ordinal: 0,
          url: targetUrl,
        });
        expect(cooledRes.reason).toBe('adaptive_404_cooldown');
        expect(fetchSpy.mock.calls.length).toBe(prevCalls);

        // Advance past window for next attempt
        fakeNow = Number(row.next_retry_at) + 1;
      }

      // Upstream publisher uploads missing asset -> 200 OK heals asset to 'blob' with failure_count = 0!
      shouldReturn200 = true;
      const healed = await vault.resolveMediaRequest({
        gameId: 'steam-777',
        role: 'cover',
        ordinal: 0,
        url: targetUrl,
      });
      expect(healed.source).toBe('upstream_persisted');
      const healedRow = vault
        .ensureOpen()
        .prepare('SELECT storage_kind, failure_count, next_retry_at FROM game_media_assets WHERE game_id = ?')
        .get('steam-777');
      expect(healedRow.storage_kind).toBe('blob');
      expect(Number(healedRow.failure_count)).toBe(0);
      expect(Number(healedRow.next_retry_at)).toBe(0);
    } finally {
      vault.shutdown();
    }
  });

  it('resets 404 backoff in 0s immediately when source_url changes on a subsequent sync or manual cache clear / Fix Match eviction runs', async () => {
    const sandbox = makeTempSandbox('ol-404-reset-');
    const fakeNow = 1_700_000_000_000;
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('old_dead_hash')) {
        return makeMockHttpResponse({ status: 404, body: '404' });
      }
      return makeMockHttpResponse({
        status: 200,
        body: makeValidImageBuffer('webp', 96),
        headers: { 'content-type': 'image/webp' },
      });
    });

    const vault = offlineVaultMod.createOfflineVaultService({
      userDataDir: sandbox,
      federator: makeHermeticFederator(sandbox),
      disableJitter: true,
      nowFn: () => fakeNow,
      fetchImpl: fetchSpy,
    });

    try {
      // 1st sync URL returns 404 -> enters 6h cooldown
      const deadRes = await vault.resolveMediaRequest({
        gameId: 'gog-500',
        role: 'cover',
        ordinal: 0,
        url: 'https://images.gog-statics.com/old_dead_hash.webp',
      });
      expect(deadRes.status).toBe(404);

      // Without advancing clock (0s elapsed!), a new sync provides an updated source_url:
      // resolveMediaRequest & registerGameMediaCandidate must reset failure_count = 0 immediately!
      const newUrl = 'https://images.gog-statics.com/new_live_hash.webp';
      const instantRecovered = await vault.resolveMediaRequest({
        gameId: 'gog-500',
        role: 'cover',
        ordinal: 0,
        url: newUrl,
      });
      expect(instantRecovered.source).toBe('upstream_persisted');
      expect(instantRecovered.mimeType).toBe('image/webp');

      // Also verify igdbCoverService.evictCacheForGame clears dead Steam cover state immediately
      setOnlineConnectivity(true);
      igdbCoverService.recordDeadSteamCover(888888, { verified404: true });
      expect(KNOWN_DEAD_STEAM_COVER_APP_IDS.has(888888)).toBe(true);
      igdbCoverService.evictCacheForGame('Test Game', null, 888888);
      expect(KNOWN_DEAD_STEAM_COVER_APP_IDS.has(888888)).toBe(false);
    } finally {
      vault.shutdown();
    }
  });
});

// ===========================================================================
// GROUP 5: Zero Offline Poisoning / Clobbering & Truthful UI States
// ===========================================================================
describe('5. Zero Offline Poisoning / Clobbering & Truthful Offline UI States', () => {
  it('preserves pre-existing game.enrichedMetadata in SteamStorePage when offline and never clobbers via onGameUpdated with skeleton_fallback', async () => {
    setOnlineConnectivity(false);

    // Simulate offline skeleton returned by steamApi while game already carries rich cached metadata
    vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(
      makeSteamMetadata({
        appId: 1091500,
        name: 'Cyberpunk 2077',
        shortDescription: 'Cyberpunk 2077 in your unified library.',
        developers: ['Unknown Developer'],
        publishers: ['Unknown Publisher'],
        platforms: { windows: true, mac: false, linux: false },
        metadataQuality: 'skeleton_fallback',
      })
    );
    vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
    vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(
      makeSteamMetadata({
        appId: 1091500,
        name: 'Cyberpunk 2077',
        metadataQuality: 'skeleton_fallback',
      })
    );

    const richMeta: SteamEnrichedMetadata = makeSteamMetadata({
      appId: 1091500,
      name: 'Cyberpunk 2077',
      shortDescription: 'Cached authoritative Night City open-world action-adventure RPG.',
      aboutTheGame: '<p>Explore the megalopolis of Night City offline.</p>',
      detailedDescription: '<p>Explore the megalopolis of Night City offline.</p>',
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG'],
      tags: ['Cyberpunk', 'Open World'],
      categories: [
        { id: 2, description: 'Single-player' },
        { id: 22, description: 'Steam Achievements' },
        { id: 23, description: 'Steam Cloud' },
      ],
      screenshots: [
        {
          id: 1,
          pathThumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_1_thumb.jpg',
          pathFull: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_1_full.jpg',
        },
      ],
      movies: [],
      supportedLanguages: 'English<strong>*</strong>, French, Japanese',
      languageOptions: [
        { name: 'English', hasInterface: true, hasAudio: true, hasSubtitles: true },
        { name: 'Japanese', hasInterface: true, hasAudio: true, hasSubtitles: true },
      ],
      systemRequirements: {
        minimum: '<strong>Minimum:</strong> OS: Windows 10 64-bit, RAM: 12 GB',
        recommended: '<strong>Recommended:</strong> OS: Windows 10 64-bit, RAM: 16 GB',
      },
      releaseDate: 'Dec 9, 2020',
      platforms: { windows: true, mac: false, linux: false },
      metadataQuality: 'authoritative',
    });

    const game: CanonicalGame = {
      id: 'steam-1091500',
      title: 'Cyberpunk 2077',
      sortTitle: 'Cyberpunk 2077',
      steamAppId: 1091500,
      headerImage: richMeta.headerImage,
      capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/library_600x900_2x.jpg',
      shortDescription: richMeta.shortDescription,
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG'],
      tags: ['Cyberpunk'],
      releaseDate: 'Dec 9, 2020',
      platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
      enrichedMetadata: richMeta,
    };

    const onGameUpdated = vi.fn();
    const harness = createDeepTestRenderer(SteamStorePage, {
      game,
      collections: [],
      onBackToLibrary: () => {},
      onManageCollections: () => {},
      onToggleInstallStatus: () => {},
      onGameUpdated,
    });

    harness.render();
    await new Promise((r) => setTimeout(r, 15));
    harness.render();

    const text = harness.getTextContent();
    expect(text).toContain('Cached authoritative Night City open-world action-adventure RPG.');
    expect(text).toContain('Steam Achievements');
    expect(text).toContain('Japanese');
    expect(text).toContain('RAM: 12 GB');

    // Never clobber game via onGameUpdated with skeleton_fallback!
    for (const [updatedArg] of onGameUpdated.mock.calls) {
      expect(updatedArg?.enrichedMetadata?.metadataQuality).not.toBe('skeleton_fallback');
    }
    expect(onGameUpdated).not.toHaveBeenCalled();

    const aboutHost = harness.getHostElementByTestId('about-this-game-content');
    expect(aboutHost?.textContent).toContain('Explore the megalopolis of Night City offline.');
    harness.unmount();
  });

  it('treats igdbCoverService.recordDeadSteamCover as a no-op when navigator.onLine === false and never rejects header.jpg for dead cover AppIDs', () => {
    setOnlineConnectivity(false);
    igdbCoverService.recordDeadSteamCover(444444);
    expect(KNOWN_DEAD_STEAM_COVER_APP_IDS.has(444444)).toBe(false);
    expect(localStorage.getItem('antigravity_dead_steam_covers_v1')).toBeNull();

    // Even when recorded while online, only library_600x900 portrait cover is marked dead — header.jpg MUST remain valid!
    setOnlineConnectivity(true);
    igdbCoverService.recordDeadSteamCover(444444, { verified404: true });
    expect(KNOWN_DEAD_STEAM_COVER_APP_IDS.has(444444)).toBe(true);
    expect(
      isUnsuitableCoverUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/444444/library_600x900.jpg'
      )
    ).toBe(true);
    expect(
      isUnsuitableHeaderUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/444444/header.jpg'
      )
    ).toBe(false);
  });

  it('serves stale-while-offline positive matches/scores in steamMatcher & criticScoreService, never overwrites positive scores on WAF/network failure, and retains expired positive scores in purgeLegacyScores()', async () => {
    // 1. Seed expired positive critic score (cached 90 days ago > 14-day TTL) + expired negative entry
    const posKey = 'antigravity_critic_v8_id:1145360';
    const negKey = 'antigravity_critic_v8_id:999991';
    saveStagedCache(
      posKey,
      {
        id: 'mc-hades',
        source: 'metacritic',
        score: 93,
        tier: 'Mighty',
        numReviews: 74,
        url: 'https://www.metacritic.com/game/hades/critic-reviews/',
        summary: 'Universal acclaim.',
        isVerified: true,
        isSynthetic: false,
      },
      MutabilityTier.TIER_2_MATURE
    );
    saveStagedCache(negKey, null, 'negative', { failureReason: 'not_found' });

    // Backdate both entries by 90 days so both exceed their nominal TTL
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const backdateKey = (k: string) => {
      const parsed = JSON.parse(localStorage.getItem(k)!);
      parsed.cachedAt = ninetyDaysAgo;
      localStorage.setItem(k, JSON.stringify(parsed));
    };
    backdateKey(posKey);
    backdateKey(negKey);

    // purgeLegacyScores() MUST retain the expired positive score for stale-while-offline while removing the expired negative entry!
    criticScoreService.purgeLegacyScores();
    expect(localStorage.getItem(posKey)).not.toBeNull();
    expect(localStorage.getItem(negKey)).toBeNull();

    // 2. While offline, resolveDynamicScore serves the stale-while-offline positive score (93)
    setOnlineConnectivity(false);
    const offlineScore = await criticScoreService.resolveDynamicScore('Hades', 1145360, 2020, null, {
      bypassAttempted: true,
    });
    expect(offlineScore?.score).toBe(93);
    expect(offlineScore?.source).toBe('metacritic');

    // 3. While online during a simulated WAF/network failure, positive score is NEVER overwritten with null or 'negative'!
    setOnlineConnectivity(true);
    const fetchFailSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('503 Service Unavailable'));
    const outageScore = await criticScoreService.resolveDynamicScore('Hades', 1145360, 2020, null, {
      bypassAttempted: true,
    });
    expect(outageScore?.score).toBe(93);
    const storedAfterOutage = loadStagedCache<any>(posKey, false);
    expect(storedAfterOutage.data?.score).toBe(93);
    expect(storedAfterOutage.entry?.tier).not.toBe('negative');
    fetchFailSpy.mockRestore();

    // 4. steamMatcher: offline uncached lookup never poisons negative cache; cached positive match resolves offline
    localStorage.setItem(
      'steam_app_id_match_cache_v4',
      JSON.stringify({ 'custom cached adventure': 123456 })
    );
    const offlineMatcher = new (steamMatcher.constructor as any)();
    setOnlineConnectivity(false);
    expect(await offlineMatcher.matchGameToSteam('Custom Cached Adventure')).toBe(123456);
    expect(await offlineMatcher.matchGameToSteam('Brand New Unsynced Title XYZ')).toBeNull();

    // Reconnecting online must allow immediate match without 7-day negative lock
    const persistedMatches = JSON.parse(localStorage.getItem('steam_app_id_match_cache_v4') || '{}');
    expect(persistedMatches['brand new unsynced title xyz']).toBeUndefined();
  });

  it('never fabricates "Achievement #1..N" when offline without schema (schemaUnavailableOffline: true) and renders cached detailed achievements intact offline', async () => {
    setOnlineConnectivity(false);

    const uncachedGame: CanonicalGame = {
      id: 'steam-812140',
      title: 'Uncached Offline Odyssey',
      sortTitle: 'Uncached Offline Odyssey',
      steamAppId: 812140,
      headerImage: '',
      developers: ['Studio'],
      publishers: ['Pub'],
      genres: ['Action'],
      tags: [],
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '812140',
          installed: true,
          achievements: { unlocked: 7, total: 25, percentage: 28, source: 'live_cloud_api' },
        },
      ],
    };

    const uncachedMap = await achievementDetailService.fetchGameAchievements(uncachedGame);
    expect(uncachedMap.steam).toBeDefined();
    expect(uncachedMap.steam?.unlocked).toBe(7);
    expect(uncachedMap.steam?.total).toBe(25);
    expect(uncachedMap.steam?.achievements).toEqual([]);
    expect(uncachedMap.steam?.schemaUnavailableOffline).toBe(true);
    // Must NOT poison localStorage with empty schema!
    expect(localStorage.getItem('antigravity_detailed_achievements_steam-812140')).toBeNull();

    const modalHarness = createDeepTestRenderer(GameAchievementsModal, {
      isOpen: true,
      game: uncachedGame,
      onClose: () => {},
    });
    modalHarness.render();
    await new Promise((r) => setTimeout(r, 15));
    modalHarness.render();

    const uncachedText = modalHarness.getTextContent();
    expect(uncachedText).toContain('7 of 25 Unlocked');
    expect(uncachedText).toContain(
      'Detailed achievement icons and descriptions will sync automatically when online'
    );
    expect(uncachedText).not.toContain('Achievement #1');
    modalHarness.unmount();

    // Now verify a game with cached detailed achievements renders all real cards + ol-media:// icons offline!
    const cachedGame: CanonicalGame = {
      ...uncachedGame,
      id: 'steam-620',
      title: 'Portal 2',
      steamAppId: 620,
    };
    localStorage.setItem(
      'antigravity_detailed_achievements_steam-620',
      JSON.stringify({
        steam: {
          storefrontId: 'steam',
          total: 2,
          unlocked: 1,
          percentage: 50,
          isMastered: false,
          lastSyncedAt: '2026-10-20T00:00:00.000Z',
          achievements: [
            {
              id: 'WAKE_UP',
              name: 'Wake Up Call',
              description: 'Survive the manual override.',
              iconUnlockedUrl: 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/620/ach1.jpg',
              unlocked: true,
              unlockedAt: 1700000000000,
              globalPercentage: 94.2,
              rarityTier: 'common',
            },
            {
              id: 'LUNAR',
              name: 'Lunacy',
              description: 'That just happened.',
              iconUnlockedUrl: 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/620/ach2.jpg',
              unlocked: false,
              globalPercentage: 61.5,
              rarityTier: 'common',
            },
          ],
        },
      })
    );

    const cachedModal = createDeepTestRenderer(GameAchievementsModal, {
      isOpen: true,
      game: cachedGame,
      onClose: () => {},
    });
    cachedModal.render();
    await new Promise((r) => setTimeout(r, 15));
    cachedModal.render();

    const cachedText = cachedModal.getTextContent();
    expect(cachedText).toContain('Wake Up Call');
    expect(cachedText).toContain('Survive the manual override.');
    const iconImgs = cachedModal.findElements(
      (el) => el.type === 'img' && typeof el.props?.src === 'string'
    );
    expect(iconImgs.length).toBeGreaterThanOrEqual(2);
    expect(iconImgs[0].props.src.startsWith('ol-media://asset?')).toBe(true);
    cachedModal.unmount();
  });

  it('renders truthful empty/pending states (zero fake categories, zero fake English checkmarks, zero fake Deck Verified or discord.gg, and OS tabs on SystemRequirements)', () => {
    setOnlineConnectivity(false);

    // 1. StoreFeatureIcon & SteamFeaturesList: inline SVG, zero external Steam icon PNG URLs, no fake 8 categories
    const iconHtml = renderToString(
      <StoreFeatureIcon categoryId={22} description="Steam Achievements" />
    );
    expect(iconHtml).toContain('<svg');
    expect(iconHtml).not.toContain('steamstatic.com');

    const emptyFeaturesHtml = renderToString(<SteamFeaturesList categories={[]} />);
    expect(emptyFeaturesHtml).toContain('Store features pending online sync');
    expect(emptyFeaturesHtml).not.toContain('Full controller support');

    // 2. SteamLanguagesTable: empty state shows truthful sync message, zero fabricated English checkmarks
    const emptyLangsHtml = renderToString(
      <SteamLanguagesTable rawSupportedLanguagesHtml="" languageOptions={[]} />
    );
    expect(emptyLangsHtml).toContain('Language details pending online sync');
    expect(emptyLangsHtml).not.toContain('<table');

    // 3. SteamSidebarNotices: zero fabricated STEAM DECK VERIFIED badge and zero generic discord.gg links
    const noticesHtml = renderToString(
      <SteamSidebarNotices
        title="Minimal Offline Indie"
        genres={[]}
        developers={[]}
        publishers={[]}
      />
    );
    expect(noticesHtml).not.toContain('VERIFIED');
    expect(noticesHtml).not.toContain('discord.gg');

    // 4. SystemRequirements: honest pending message on skeleton_fallback, and interactive Windows/macOS/Linux tabs when present
    const skelReqHtml = renderToString(
      <SystemRequirements metadataQuality="skeleton_fallback" />
    );
    expect(skelReqHtml).toContain('System specifications pending online sync.');

    const multiOsHarness = createDeepTestRenderer(SystemRequirements, {
      metadataQuality: 'authoritative',
      requirements: { minimum: 'Windows 11 DX12 GPU' },
      macRequirements: { minimum: 'Apple M2 Max 16 GB Unified Memory' },
      linuxRequirements: { minimum: 'SteamOS 3.5 Vulkan 1.3' },
    });
    multiOsHarness.render();
    expect(multiOsHarness.getTextContent()).toContain('Windows');
    expect(multiOsHarness.getTextContent()).toContain('macOS');
    expect(multiOsHarness.getTextContent()).toContain('Linux');
    expect(multiOsHarness.getTextContent()).toContain('Windows 11 DX12 GPU');

    const macTabBtn = multiOsHarness.findElements(
      (el) => el.type === 'button' && String(el.props?.children) === 'macOS'
    )[0];
    expect(macTabBtn).toBeDefined();
    macTabBtn.props.onClick();
    multiOsHarness.render();
    expect(multiOsHarness.getTextContent()).toContain('Apple M2 Max 16 GB Unified Memory');
    multiOsHarness.unmount();
  });
});

// ===========================================================================
// GROUP 6: Offline MediaGallery, AboutThisGame DOM Fragment, Vault UI & <5ms Preemption
// ===========================================================================
describe('6. Offline MediaGallery, AboutThisGame DOM Fragment Replacement, Vault UI & <5ms Preemption', () => {
  it('omits movies trailer slides in MediaGallery when offline (opening directly onto Screenshot #1 with zero <video>/<iframe>) and restores trailers when online fires', () => {
    setOnlineConnectivity(false);

    const movies = [
      {
        id: 501,
        name: 'Official Gameplay Trailer',
        thumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/256900/movie_thumb.jpg',
        mp4: { max: 'https://video.akamai.steamstatic.com/store_trailers/256900/movie_max.mp4' },
      },
    ];
    const screenshots = [
      {
        id: 1,
        pathThumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_1_thumb.jpg',
        pathFull: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_1_full.jpg',
      },
      {
        id: 2,
        pathThumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_2_thumb.jpg',
        pathFull: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss_2_full.jpg',
      },
    ];

    const gallery = createDeepTestRenderer(MediaGallery, {
      screenshots,
      movies,
      title: 'Cyberpunk 2077',
      autoplay: true,
      gameId: 'steam-1091500',
      steamAppId: 1091500,
    });

    gallery.render();

    // Offline assertions: ZERO <video>, ZERO <iframe>, and primary showcase displays Screenshot #1 via ol-media://!
    expect(gallery.findElements((el) => el.type === 'video')).toHaveLength(0);
    expect(gallery.findElements((el) => el.type === 'iframe')).toHaveLength(0);

    const activeThumbBase = gallery.findElements(
      (el) => el.props?.['data-testid'] === 'media-gallery-screenshot-thumb-base'
    );
    expect(activeThumbBase).toHaveLength(1);
    expect(String(activeThumbBase[0].props.src)).toContain('ol-media://asset?');
    expect(String(activeThumbBase[0].props.src)).toContain('role=screenshot_thumb');

    // Only the 2 screenshot thumbnails appear in the strip (trailer slide completely omitted)
    const stripImgs = gallery.findElements(
      (el) => el.type === 'img' && el.props?.alt === 'Official Gameplay Trailer'
    );
    expect(stripImgs).toHaveLength(0);

    // Transition back online -> trailer slide dynamically returns!
    setOnlineConnectivity(true);
    gallery.render();
    const onlineTrailerThumb = gallery.findElements(
      (el) => el.type === 'img' && el.props?.alt === 'Official Gameplay Trailer'
    );
    expect(onlineTrailerThumb).toHaveLength(1);
    gallery.unmount();
  });

  it('transforms "About This Game" DOM fragments offline without innerHTML re-serialization: replaces <video poster> with <img role=inline_poster>, removes posterless <video>, and lazy-rewrites inline <img>', () => {
    setOnlineConnectivity(false);

    vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
    vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
    vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(
      makeSteamMetadata({ metadataQuality: 'skeleton_fallback' })
    );

    const aboutHtml = `
      <div class="bb_paragraph">Offline combat showcase:</div>
      <img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/extras/feature_art.png" fetchpriority="low" />
      <div class="bb_img_ctn">
        <video poster="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/extras/combat_poster.avif" title="Combat Clip" autoplay loop muted>
          <source src="https://video.akamai.steamstatic.com/store_trailers/combat.webm" type="video/webm" />
        </video>
      </div>
      <div class="bb_img_ctn">
        <video autoplay loop muted>
          <source src="https://video.akamai.steamstatic.com/store_trailers/posterless.mp4" type="video/mp4" />
        </video>
      </div>
    `;

    const game: CanonicalGame = {
      id: 'steam-1091500',
      title: 'Cyberpunk 2077',
      sortTitle: 'Cyberpunk 2077',
      steamAppId: 1091500,
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG'],
      tags: [],
      platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
      enrichedMetadata: makeSteamMetadata({
        appId: 1091500,
        name: 'Cyberpunk 2077',
        shortDescription: 'Night City RPG.',
        aboutTheGame: aboutHtml,
        detailedDescription: aboutHtml,
        screenshots: [
          {
            id: 1,
            pathThumbnail: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss1.jpg',
            pathFull: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/ss1_full.jpg',
          },
        ],
        metadataQuality: 'authoritative',
      }),
    };

    const page = createDeepTestRenderer(SteamStorePage, {
      game,
      collections: [],
      onBackToLibrary: () => {},
      onManageCollections: () => {},
      onToggleInstallStatus: () => {},
    });

    // Note: hostEl.forbidInnerHtmlWrite = true is active on 'about-this-game-content',
    // so any innerHTML assignment would throw immediately!
    page.render();

    const container = page.getHostElementByTestId('about-this-game-content');
    expect(container).toBeDefined();
    expect(container!.querySelectorAll('video')).toHaveLength(0);

    const imgs = container!.querySelectorAll('img');
    expect(imgs).toHaveLength(2);

    // 1st img: inline <img> rewritten to ol-media://...role=inline_img with loading="lazy" and fetchpriority removed
    const inlineImg = imgs[0];
    expect(inlineImg.getAttribute('src')).toContain('ol-media://asset?');
    expect(inlineImg.getAttribute('src')).toContain('role=inline_img');
    expect(inlineImg.getAttribute('loading')).toBe('lazy');
    expect(inlineImg.hasAttribute('fetchpriority')).toBe(false);

    // 2nd img: <video poster> replaced in-place with static <img class="bb_img" src="ol-media://...role=inline_poster">
    const posterImg = imgs[1];
    expect(posterImg.getAttribute('src')).toContain('ol-media://asset?');
    expect(posterImg.getAttribute('src')).toContain('role=inline_poster');
    expect(posterImg.getAttribute('alt')).toBe('Combat Clip');
    expect(posterImg.getAttribute('loading')).toBe('lazy');
    expect(posterImg.className).toBe('bb_img');

    // Empty .bb_img_ctn wrapper from posterless <video> must be collapsed (display: 'none')
    const wrappers = container!.querySelectorAll('.bb_img_ctn');
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0].style.display).not.toBe('none');
    expect(wrappers[1].style.display).toBe('none');

    page.unmount();
  });

  it('renders Offline Library Vault controls (Compact / Balanced / Full Archive + Clear Offline Media Cache) in IntegrationsModal with zero video caching toggles', async () => {
    const vaultBridge = installMockOfflineVaultBridge();

    const modal = createDeepTestRenderer(IntegrationsModal, {
      isOpen: true,
      onClose: () => {},
      onLibraryUpdated: () => {},
    });

    modal.render();
    await new Promise((r) => setTimeout(r, 15));
    modal.render();

    const vaultSections = modal.findElements(
      (el) => el.props?.['data-testid'] === 'offline-library-vault-section'
    );
    expect(vaultSections).toHaveLength(1);

    const text = modal.getTextContent();
    expect(text).toContain('Offline Library Vault');
    expect(text).toContain('Compact');
    expect(text).toContain('250 MB');
    expect(text).toContain('Balanced');
    expect(text).toContain('1 GB');
    expect(text).toContain('Full Archive');
    expect(text).toContain('2 GB');
    expect(text).toContain('Clear Offline Media Cache');

    // Strict zero-video UI invariant: no trailer/video caching option anywhere in Vault UI
    expect(text.toLowerCase()).not.toContain('cache trailer');
    expect(text.toLowerCase()).not.toContain('offline video');
    expect(text.toLowerCase()).not.toContain('download trailer');

    // Exercise tier button & Clear Offline Media Cache actions
    const tierSelector = modal.findElements(
      (el) => el.props?.['data-testid'] === 'offline-vault-tier-selector'
    )[0];
    const tierButtons = modal.findElements(
      (el) => el.type === 'button' && ['Compact', 'Balanced', 'Full Archive'].some((lbl) =>
        modal.getTextContent(el).includes(lbl)
      )
    );
    expect(tierSelector).toBeDefined();
    expect(tierButtons).toHaveLength(3);

    await tierButtons[2].props.onClick(); // Full Archive
    expect(vaultBridge.setTier).toHaveBeenCalledWith('full_archive');

    const clearBtn = modal.findElements(
      (el) => el.props?.['data-testid'] === 'clear-offline-media-cache-btn'
    )[0];
    await clearBtn.props.onClick();
    expect(vaultBridge.clear).toHaveBeenCalledWith({ preserveMetadata: true });

    modal.unmount();
  });

  it('preempts and aborts active MediaHydrationEngine background fetch via AbortController in < 5ms when a game session starts and re-queues the asset', async () => {
    let runningGames: Array<{ gameId: string }> = [];
    let sessionListener: ((evt: { event: string; gameId?: string }) => void) | null = null;
    let capturedSignal: AbortSignal | null = null;
    let notifyFetchStarted!: () => void;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });

    const mockVault = {
      getGameDetail: vi.fn(() => ({
        metadataQuality: 'authoritative',
        enrichedMetadata: { name: 'Hades' },
      })),
      isAssetAlreadyHydratedOrBackedOff: vi.fn(() => false),
      resolveMediaRequest: vi.fn(
        (_params: Record<string, unknown>, opts?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            capturedSignal = opts?.signal ?? null;
            notifyFetchStarted();
            if (opts?.signal) {
              opts.signal.addEventListener(
                'abort',
                () => resolve({ kind: 'error', status: 499, reason: 'aborted' }),
                { once: true }
              );
            }
          })
      ),
    };

    const mockLauncherEngine = {
      getRunningGames: () => runningGames,
      hasActivePostSessionWork: () => false,
      getDownloadQueue: () => [],
      getLauncherPerformanceSettings: () => ({ backgroundThrottling: true }),
      onSessionUpdated: (cb: (evt: { event: string; gameId?: string }) => void) => {
        sessionListener = cb;
        return () => {
          sessionListener = null;
        };
      },
      onDownloadUpdated: () => () => {},
    };

    const engine = hydrationEngineMod.createMediaHydrationEngine({
      offlineVaultService: mockVault,
      launcherEngine: mockLauncherEngine,
      warmStartDurationMs: 0,
      itemDelayMs: 1,
      postGameCooldownMs: 5,
    });

    try {
      engine.queueHydration({
        games: [
          {
            gameId: 'steam-1145360',
            title: 'Hades',
            steamAppId: 1145360,
            isInstalled: true,
            assets: [
              {
                role: 'cover',
                ordinal: 0,
                url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/library_600x900_2x.jpg',
              },
            ],
          },
        ],
      });

      await fetchStartedPromise;
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      // Simulate user clicking Play -> runningCount > 0 + session 'starting' event:
      // Active background fetch MUST abort synchronously in < 5ms!
      runningGames = [{ gameId: 'steam-1145360' }];
      const t0 = performance.now();
      sessionListener!({ event: 'starting', gameId: 'steam-1145360' });
      const abortElapsedMs = performance.now() - t0;

      expect(capturedSignal!.aborted).toBe(true);
      expect(abortElapsedMs).toBeLessThan(5);
      expect(engine.getProgressSnapshot().isSuspendedInGame).toBe(true);

      // Allow step finally-block microtask to settle and confirm preempted asset was re-prepended for post-game resume
      await new Promise((r) => setTimeout(r, 10));
      const queuedTask = engine.queuedGames.get('steam-1145360');
      expect(queuedTask).toBeDefined();
      expect(queuedTask.assets.some((a: { role: string }) => a.role === 'cover')).toBe(true);

      // Simulate game exit -> postGameCooldownMs (5ms) elapses -> engine unsuspends automatically
      runningGames = [];
      sessionListener!({ event: 'stopped', gameId: 'steam-1145360' });
      await new Promise((r) => setTimeout(r, 20));
      expect(engine.getProgressSnapshot().isSuspendedInGame).toBe(false);
    } finally {
      engine.shutdown();
    }
  });
});
