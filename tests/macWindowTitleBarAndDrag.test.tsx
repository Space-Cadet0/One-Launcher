import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';

// ---------------------------------------------------------------------------
// Headless Browser Environment Polyfills
// ---------------------------------------------------------------------------
const eventTarget = new EventTarget();

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: any) => eventTarget.dispatchEvent(event),
    location: { hostname: 'example.com' },
    innerWidth: 1440,
    innerHeight: 900,
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
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };

  return { render, unmount, states, refs };
}

function createDefaultTopNavBarProps(overrides?: Partial<React.ComponentProps<typeof TopNavBar>>) {
  return {
    selectedPlatform: 'all' as const,
    onSelectPlatform: vi.fn(),
    installedOnly: false,
    onToggleInstalledOnly: vi.fn(),
    totalGamesCount: 120,
    filteredCount: 42,
    isSyncing: false,
    onTriggerSync: vi.fn(),
    onHomeClick: vi.fn(),
    onOpenIntegrations: vi.fn(),
    canGoBack: true,
    onGoBack: vi.fn(),
    canGoForward: true,
    onGoForward: vi.fn(),
    connectedStorefronts: ['steam', 'gog', 'epic'] as any,
    onOpenDownloads: vi.fn(),
    ...overrides,
  };
}

describe('macOS Window Title Bar Traffic Light Safe Zone & Top Bar Dragging', () => {
  const originalElectronAPI = (globalThis as any).window?.electronAPI;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window.electronAPI;
  });

  afterEach(() => {
    if (originalElectronAPI !== undefined) {
      (globalThis as any).window.electronAPI = originalElectronAPI;
    } else {
      delete (globalThis as any).window.electronAPI;
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Issue 1: macOS Traffic Light Safe Zone
  // =========================================================================
  describe('Issue 1: macOS Traffic Light Safe Zone (pl-[88px] vs pl-4)', () => {
    it('applies pl-[88px] and data-mac-traffic-inset="true" when window.electronAPI is darwin so Menu and Back/Forward buttons never overlap traffic lights', () => {
      (globalThis as any).window.electronAPI = {
        isElectron: true,
        platform: 'darwin',
        onFullscreenChanged: vi.fn(() => () => {}),
      };

      const props = createDefaultTopNavBarProps();
      const harness = createComponentHarness(TopNavBar, props);
      const tree = harness.render();

      const insetContainers = findElements(
        tree,
        (el) => el.props?.['data-mac-traffic-inset'] !== undefined
      );
      expect(insetContainers).toHaveLength(1);
      const insetDiv = insetContainers[0];
      expect(insetDiv.props['data-mac-traffic-inset']).toBe('true');
      expect(insetDiv.props.className).toContain('pl-[88px]');
      expect(insetDiv.props.className).not.toContain('pl-4');

      const html = renderToString(React.createElement(TopNavBar, props));
      expect(html).toContain('data-mac-traffic-inset="true"');
      expect(html).toContain('pl-[88px]');

      harness.unmount();
    });

    it('switches to standard pl-4 (data-mac-traffic-inset="false") when onFullscreenChanged(true) fires in native macOS fullscreen, and restores pl-[88px] on exit', () => {
      let fullscreenCallback: ((full: boolean) => void) | null = null;
      (globalThis as any).window.electronAPI = {
        isElectron: true,
        platform: 'darwin',
        onFullscreenChanged: vi.fn((cb: (full: boolean) => void) => {
          fullscreenCallback = cb;
          return () => {
            fullscreenCallback = null;
          };
        }),
      };

      const harness = createComponentHarness(TopNavBar, createDefaultTopNavBarProps());

      // Windowed on macOS -> pl-[88px]
      let tree = harness.render();
      let insetDiv = findElements(
        tree,
        (el) => el.props?.['data-mac-traffic-inset'] !== undefined
      )[0];
      expect(insetDiv.props['data-mac-traffic-inset']).toBe('true');
      expect(insetDiv.props.className).toContain('pl-[88px]');
      expect(fullscreenCallback).toBeTypeOf('function');

      // Enter native macOS fullscreen -> traffic lights hide, use standard pl-4
      fullscreenCallback!(true);
      tree = harness.render();
      insetDiv = findElements(
        tree,
        (el) => el.props?.['data-mac-traffic-inset'] !== undefined
      )[0];
      expect(insetDiv.props['data-mac-traffic-inset']).toBe('false');
      expect(insetDiv.props.className).toContain('pl-4');
      expect(insetDiv.props.className).not.toContain('pl-[88px]');

      // Leave native macOS fullscreen -> traffic lights reappear, restore pl-[88px]
      fullscreenCallback!(false);
      tree = harness.render();
      insetDiv = findElements(
        tree,
        (el) => el.props?.['data-mac-traffic-inset'] !== undefined
      )[0];
      expect(insetDiv.props['data-mac-traffic-inset']).toBe('true');
      expect(insetDiv.props.className).toContain('pl-[88px]');

      harness.unmount();
    });

    it('uses standard pl-4 (data-mac-traffic-inset="false") on Windows (platform: "win32")', () => {
      (globalThis as any).window.electronAPI = {
        isElectron: true,
        platform: 'win32',
        onFullscreenChanged: vi.fn(() => () => {}),
      };

      const harness = createComponentHarness(TopNavBar, createDefaultTopNavBarProps());
      const tree = harness.render();

      const insetDiv = findElements(
        tree,
        (el) => el.props?.['data-mac-traffic-inset'] !== undefined
      )[0];
      expect(insetDiv.props['data-mac-traffic-inset']).toBe('false');
      expect(insetDiv.props.className).toContain('pl-4');
      expect(insetDiv.props.className).not.toContain('pl-[88px]');

      harness.unmount();
    });

    it('verifies electron/main.cjs configures hiddenInset & trafficLightPosition: { x: 16, y: 19 } and electron/preload.cjs exposes onFullscreenChanged', () => {
      const mainCjsPath = path.resolve(__dirname, '../electron/main.cjs');
      const preloadCjsPath = path.resolve(__dirname, '../electron/preload.cjs');

      const mainSource = fs.readFileSync(mainCjsPath, 'utf-8');
      const preloadSource = fs.readFileSync(preloadCjsPath, 'utf-8');

      expect(mainSource).toContain("titleBarStyle: 'hiddenInset'");
      expect(mainSource).toContain('frame: false');
      expect(mainSource).toContain('trafficLightPosition: { x: 16, y: 19 }');
      expect(mainSource).toContain("mainWindow.on('enter-full-screen'");
      expect(mainSource).toContain("mainWindow.on('leave-full-screen'");
      expect(mainSource).toContain("mainWindow.webContents.send('window:fullscreen-changed', true)");
      expect(mainSource).toContain("mainWindow.webContents.send('window:fullscreen-changed', false)");

      expect(preloadSource).toContain('onFullscreenChanged:');
      expect(preloadSource).toContain("ipcRenderer.on('window:fullscreen-changed'");
      expect(preloadSource).toContain("ipcRenderer.removeListener('window:fullscreen-changed'");
    });
  });

  // =========================================================================
  // Issue 2: macOS Top Bar Window Dragging & Interactive Controls
  // =========================================================================
  describe('Issue 2: macOS Top Bar Window Dragging & Interactive Controls', () => {
    it('configures TopNavBar <header> with app-drag-region and -webkit-app-region: drag, and CSS rules in src/index.css', () => {
      (globalThis as any).window.electronAPI = {
        isElectron: true,
        platform: 'darwin',
        onFullscreenChanged: vi.fn(() => () => {}),
      };

      const props = createDefaultTopNavBarProps();
      const harness = createComponentHarness(TopNavBar, props);
      const tree = harness.render();

      expect(tree.type).toBe('header');
      expect(tree.props.className).toContain('app-drag-region');
      expect(tree.props.style).toEqual({ WebkitAppRegion: 'drag' });

      const html = renderToString(React.createElement(TopNavBar, props));
      expect(html).toContain('class="app-drag-region');
      expect(html).toContain('-webkit-app-region:drag');

      const indexCssPath = path.resolve(__dirname, '../src/index.css');
      const cssSource = fs.readFileSync(indexCssPath, 'utf-8');
      expect(cssSource).toContain('.app-drag-region');
      expect(cssSource).toContain('-webkit-app-region: drag;');
      expect(cssSource).toContain('.app-no-drag');
      expect(cssSource).toContain('-webkit-app-region: no-drag;');

      harness.unmount();
    });

    it('marks interactive controls (Menu, Back/Forward, Storefront filter pills, Downloads, Installed Only) with app-no-drag / no-drag and keeps them 100% clickable', () => {
      (globalThis as any).window.electronAPI = {
        isElectron: true,
        platform: 'darwin',
        onFullscreenChanged: vi.fn(() => () => {}),
      };

      const onSelectPlatform = vi.fn();
      const onToggleInstalledOnly = vi.fn();
      const onGoBack = vi.fn();
      const onGoForward = vi.fn();
      const onOpenDownloads = vi.fn();

      const props = createDefaultTopNavBarProps({
        onSelectPlatform,
        onToggleInstalledOnly,
        onGoBack,
        onGoForward,
        onOpenDownloads,
      });

      const harness = createComponentHarness(TopNavBar, props);
      let tree = harness.render();

      // Left container wrapping Menu + Back/Forward has app-no-drag & WebkitAppRegion: 'no-drag'
      const noDragContainers = findElements(
        tree,
        (el) =>
          el.type === 'div' &&
          typeof el.props?.className === 'string' &&
          el.props.className.includes('app-no-drag')
      );
      expect(noDragContainers.length).toBeGreaterThanOrEqual(2);
      for (const container of noDragContainers) {
        expect(container.props.style).toEqual({ WebkitAppRegion: 'no-drag' });
      }

      // 1. Menu button
      const menuBtn = findElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Menu'
      )[0];
      expect(menuBtn).toBeDefined();
      expect(menuBtn.props.className).toContain('app-no-drag');
      expect(menuBtn.props.style).toEqual({ WebkitAppRegion: 'no-drag' });
      expect(menuBtn.props['aria-expanded']).toBe(false);

      // Click Menu button -> opens dropdown
      menuBtn.props.onClick();
      tree = harness.render();
      const openedMenuBtn = findElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Menu'
      )[0];
      expect(openedMenuBtn.props['aria-expanded']).toBe(true);

      // 2. Back & Forward buttons
      const backBtn = findElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Back'
      )[0];
      const forwardBtn = findElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Forward'
      )[0];
      expect(backBtn).toBeDefined();
      expect(forwardBtn).toBeDefined();
      backBtn.props.onClick();
      forwardBtn.props.onClick();
      expect(onGoBack).toHaveBeenCalledTimes(1);
      expect(onGoForward).toHaveBeenCalledTimes(1);

      // 3. Storefront filter buttons (All Libraries, Steam, GOG.com, Epic Games Store)
      const steamFilterBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Steam')
      )[0];
      expect(steamFilterBtn).toBeDefined();
      expect(steamFilterBtn.props.className).toContain('app-no-drag');
      expect(steamFilterBtn.props.style).toEqual({ WebkitAppRegion: 'no-drag' });
      steamFilterBtn.props.onClick();
      expect(onSelectPlatform).toHaveBeenCalledWith('steam');

      // 4. Downloads button
      const downloadsBtn = findElements(
        tree,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Downloads'
      )[0];
      expect(downloadsBtn).toBeDefined();
      expect(downloadsBtn.props.className).toContain('app-no-drag');
      expect(downloadsBtn.props.style).toEqual({ WebkitAppRegion: 'no-drag' });
      downloadsBtn.props.onClick();
      expect(onOpenDownloads).toHaveBeenCalledTimes(1);

      // 5. Installed Only button
      const installedOnlyBtn = findElements(
        tree,
        (el) => el.type === 'button' && getTextContent(el).includes('Installed Only')
      )[0];
      expect(installedOnlyBtn).toBeDefined();
      expect(installedOnlyBtn.props.className).toContain('app-no-drag');
      expect(installedOnlyBtn.props.style).toEqual({ WebkitAppRegion: 'no-drag' });
      installedOnlyBtn.props.onClick();
      expect(onToggleInstalledOnly).toHaveBeenCalledTimes(1);

      harness.unmount();
    });
  });
});
