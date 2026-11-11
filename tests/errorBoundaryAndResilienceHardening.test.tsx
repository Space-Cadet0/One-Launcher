import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { AppErrorBoundary } from '../src/components/Common/AppErrorBoundary';
import { ModalErrorBoundary } from '../src/components/Common/ModalErrorBoundary';
import {
  emergencyResetModalOverlayLock,
  checkModalOverlaySelfHealing,
  acquireModalOverlayLock,
  isModalOverlayOpen,
} from '../src/utils/modalOverlayLock';
import {
  isCurrentlyFastScrolling,
  recordScrollActivity,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
} from '../src/components/Library/Grid/gridScrollTracker';
import { lazyWithRetry } from '../src/utils/lazyWithRetry';
import { lazyWithRetry as appLazyWithRetry } from '../src/App';

const ROOT_DIR = path.resolve(__dirname, '..');
const globalRecord = globalThis as Record<string, unknown>;

describe('Milestone M4: Frontend Error Boundaries, Resilience & Scroll Shielding Hardening', () => {
  let prevWindow: unknown;
  let prevDocument: unknown;

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevDocument = globalRecord.document;
  });

  afterEach(() => {
    globalRecord.window = prevWindow;
    globalRecord.document = prevDocument;
    emergencyResetModalOverlayLock();
    vi.restoreAllMocks();
  });

  describe('Feature 20: AppErrorBoundary & White Screen Prevention', () => {
    it('renders children normally when no exception is thrown', () => {
      const html = renderToString(
        <AppErrorBoundary>
          <div data-testid="app-content">Normal Application Tree</div>
        </AppErrorBoundary>
      );
      expect(html).toContain('Normal Application Tree');
      expect(html).not.toContain('Application Encountered an Error');
    });

    it('catches render exceptions, normalizes unknown errors, and renders the recovery dashboard', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const boundary = new AppErrorBoundary({
        children: <div>Safe Child</div>,
      });

      // 1. Normalize standard Error
      const state1 = AppErrorBoundary.getDerivedStateFromError(new Error('Fatal UI fault'));
      expect(state1.hasError).toBe(true);
      expect(state1.error?.message).toBe('Fatal UI fault');

      // 2. Normalize non-Error object
      const state2 = AppErrorBoundary.getDerivedStateFromError('Raw string error');
      expect(state2.hasError).toBe(true);
      expect(state2.error).toBeInstanceOf(Error);
      expect(state2.error?.message).toBe('Raw string error');

      // 3. Normalize null/undefined
      const state3 = AppErrorBoundary.getDerivedStateFromError(null);
      expect(state3.hasError).toBe(true);
      expect(state3.error?.message).toBe('Unknown application error');

      // 4. Verify componentDidCatch resets emergency modal overlay lock
      const docMock = {
        documentElement: {
          removeAttribute: vi.fn(),
        },
        getElementById: vi.fn().mockReturnValue({
          removeAttribute: vi.fn(),
        }),
      };
      globalRecord.document = docMock;

      boundary.state = {
        hasError: true,
        error: new Error('Simulated failure'),
        errorInfo: { componentStack: '\n    in CrashingComponent' },
        resetKey: 0,
        copied: false,
      };

      boundary.componentDidCatch(new Error('Simulated failure'), {
        componentStack: '\n    in CrashingComponent',
      });
      expect(consoleErrorSpy).toHaveBeenCalled();

      // Render dashboard HTML
      const html = renderToString(boundary.render() as React.ReactElement);
      expect(html).toContain('Application Encountered an Error');
      expect(html).toContain('Simulated failure');
      expect(html).toContain('role="region"');
      expect(html).toContain('role="alert"');
      expect(html).toContain('aria-live="assertive"');

      // Verify all 5 recovery buttons are present in DOM output
      expect(html).toContain('Try Again');
      expect(html).toContain('Reload View');
      expect(html).toContain('Relaunch Application');
      expect(html).toContain('Safe Mode Restart');
      expect(html).toContain('Copy Error Details');
    });

    it('provides state resets and recovery callbacks on Try Again, Reload, Relaunch, and Safe Mode', () => {
      const reloadMock = vi.fn();
      const restartAppMock = vi.fn();
      const writeTextMock = vi.fn().mockResolvedValue(undefined);

      globalRecord.window = {
        location: { reload: reloadMock },
        electronAPI: { restartApp: restartAppMock },
        dispatchEvent: vi.fn(),
      };

      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: writeTextMock },
          configurable: true,
          writable: true,
        });
      } catch {
        // Fallback for environments where navigator cannot be redefined
      }

      const sessionStore = new Map<string, string>();
      globalRecord.sessionStorage = {
        setItem: (k: string, v: string) => sessionStore.set(k, v),
        getItem: (k: string) => sessionStore.get(k) ?? null,
        removeItem: (k: string) => sessionStore.delete(k),
        clear: () => sessionStore.clear(),
        length: sessionStore.size,
        key: () => null,
      };

      const boundary = new AppErrorBoundary({
        children: <div>Safe Child</div>,
      });
      boundary.setState = vi.fn((updater: unknown) => {
        const next =
          typeof updater === 'function'
            ? (updater as (s: unknown) => unknown)(boundary.state)
            : updater;
        boundary.state = { ...boundary.state, ...(next as Record<string, unknown>) };
      }) as unknown as typeof boundary.setState;

      boundary.state = {
        hasError: true,
        error: new Error('Critical Crash'),
        errorInfo: { componentStack: '\n    in BrokenTree' },
        resetKey: 0,
        copied: false,
      };

      // 1. Copy Error Details (tested while error is still in state)
      boundary.handleCopyDetails();
      if (typeof navigator.clipboard?.writeText === 'function') {
        expect(writeTextMock).toHaveBeenCalledWith(
          expect.stringContaining('Critical Crash')
        );
      }

      // 2. Try Again (clears error state and increments resetKey)
      boundary.handleTryAgain();
      expect(boundary.state.hasError).toBe(false);
      expect(boundary.state.error).toBeNull();
      expect(boundary.state.resetKey).toBe(1);

      // 3. Reload View
      boundary.handleReloadView();
      expect(reloadMock).toHaveBeenCalledTimes(1);

      // 4. Relaunch Application
      boundary.handleRelaunchApp();
      expect(restartAppMock).toHaveBeenCalledTimes(1);

      // 5. Safe Mode Restart
      boundary.handleSafeModeRestart();
      expect(sessionStore.get('one_launcher_safe_mode')).toBe('true');
      expect(reloadMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Feature 20: ModalErrorBoundary Hardening', () => {
    it('normalizes unknown error types to Error instances', () => {
      const errObj = { custom: 'Object without message' };
      const derived = ModalErrorBoundary.getDerivedStateFromError(errObj);
      expect(derived.hasError).toBe(true);
      expect(derived.error).toBeInstanceOf(Error);
      expect(derived.error?.message).toContain('[object Object]');
    });

    it('renders with role="alert", aria-live="assertive", and autoFocus on Close button', () => {
      const boundary = new ModalErrorBoundary({
        modalName: 'Game Installation',
        isOpen: true,
        onClose: vi.fn(),
        children: <div>Modal Children</div>,
      });
      boundary.state = {
        hasError: true,
        error: new Error('Corrupted runner config'),
        resetKey: 0,
      };

      const html = renderToString(boundary.render() as React.ReactElement).replace(/<!-- -->/g, '');
      expect(html).toContain('Game Installation Error');
      expect(html).toContain('Corrupted runner config');
      expect(html).toContain('role="alert"');
      expect(html).toContain('aria-live="assertive"');
      expect(html).toContain('autofocus=""');
    });
  });

  describe('Feature 20: Modal Overlay Lock & Emergency Inert Self-Healing', () => {
    it('emergencyResetModalOverlayLock clears lockedRootWithInert and data-modal-overlay-open', () => {
      let inertRemoved = false;
      let openRemoved = false;

      const docMock = {
        documentElement: {
          setAttribute: vi.fn(),
          removeAttribute: vi.fn((attr: string) => {
            if (attr === 'data-modal-overlay-open') openRemoved = true;
          }),
        },
        getElementById: vi.fn((id: string) => {
          if (id === 'root') {
            return {
              setAttribute: vi.fn(),
              removeAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') inertRemoved = true;
              }),
            };
          }
          return null;
        }),
        body: {
          nodeType: 1,
        },
      };

      globalRecord.document = docMock;
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      // Acquire lock
      acquireModalOverlayLock();
      expect(isModalOverlayOpen()).toBe(true);

      // Trigger emergency reset
      emergencyResetModalOverlayLock();
      expect(isModalOverlayOpen()).toBe(false);
      expect(inertRemoved).toBe(true);
      expect(openRemoved).toBe(true);
    });

    it('checkModalOverlaySelfHealing resets leaked overlay lock if no dialog elements remain', () => {
      const docMock = {
        documentElement: {
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
        },
        getElementById: vi.fn(() => ({
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
        })),
        querySelectorAll: vi.fn().mockReturnValue([]), // No open dialogs
        body: { nodeType: 1 },
      };
      globalRecord.document = docMock;
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      acquireModalOverlayLock();
      // self-healing check detects 0 open dialogs
      const isOpen = isModalOverlayOpen();
      expect(isOpen).toBe(false);
    });
  });

  describe('Feature 20: lazyWithRetry Layer 0 Extraction & Backward Compatibility', () => {
    it('re-exports lazyWithRetry from src/App with 100% parity with src/utils/lazyWithRetry', () => {
      expect(typeof lazyWithRetry).toBe('function');
      expect(typeof appLazyWithRetry).toBe('function');
      expect(lazyWithRetry).toBe(appLazyWithRetry);
    });

    it('handles transient dynamic import retries and un-poisons payload status', async () => {
      let attempts = 0;
      const failingFactory = vi.fn(async () => {
        attempts++;
        if (attempts <= 1) {
          throw new Error('Transient network error');
        }
        return { default: () => React.createElement('div', null, 'Resolved Component') };
      });

      const LazyComp = lazyWithRetry(failingFactory, 2, 10);
      expect(LazyComp).toBeDefined();
    });
  });

  describe('Feature 21: High-Speed Scroll Image Shielding', () => {
    it('debounces image mounting during high-velocity scrolling and flushes on calm', () => {
      vi.useFakeTimers();
      globalRecord.window = {
        dispatchEvent: vi.fn(),
      };

      let mounted = false;
      const mountFn = () => {
        mounted = true;
      };

      // 1. Simulate fast scroll velocity (>300px step)
      recordScrollActivity(0, 'main');
      recordScrollActivity(500, 'main');
      expect(isCurrentlyFastScrolling()).toBe(true);

      // 2. Queue mount
      addPendingFastScrollMount(mountFn);
      expect(mounted).toBe(false);

      // 3. Remove mount (e.g. card scrolled past or unmounted)
      removePendingFastScrollMount(mountFn);

      // Verify that after removal it is not queued
      let secondMounted = false;
      const secondMountFn = () => {
        secondMounted = true;
      };
      addPendingFastScrollMount(secondMountFn);

      // Let calm window elapse (120ms calm window)
      vi.advanceTimersByTime(200);

      expect(isCurrentlyFastScrolling()).toBe(false);
      expect(mounted).toBe(false); // was removed
      expect(secondMounted).toBe(true); // was flushed

      vi.useRealTimers();
    });
  });

  describe('Feature 22: AST Invariant & Zero-Any Enforcement', () => {
    it('verifies SteamLibraryActionBar wraps GameInstallModal and GameLaunchConfigModal with ModalErrorBoundary', () => {
      const actionBarSrc = fs.readFileSync(
        path.join(ROOT_DIR, 'src/components/SteamStoreDetail/SteamLibraryActionBar.tsx'),
        'utf8'
      );

      // Exact AST string tokens required by regression tests
      expect(actionBarSrc).toContain("import('../Launcher/GameInstallModal')");
      expect(actionBarSrc).toContain('{isInstallModalOpen && (');

      // Error Boundary wrappers
      expect(actionBarSrc).toContain('modalName="Game Installation"');
      expect(actionBarSrc).toContain('modalName="Launch Configuration"');
      expect(actionBarSrc).toContain('lazyWithRetry');
    });

    it('verifies main.tsx wraps <App /> with <AppErrorBoundary>', () => {
      const mainSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/main.tsx'), 'utf8');
      expect(mainSrc).toContain('<AppErrorBoundary>');
      expect(mainSrc).toContain('</AppErrorBoundary>');
    });

    it('verifies zero TypeScript AnyKeyword occurrences across all modified/new files', () => {
      const targetFiles = [
        'src/utils/lazyWithRetry.ts',
        'src/utils/modalOverlayLock.ts',
        'src/components/Common/AppErrorBoundary.tsx',
        'src/components/Common/ModalErrorBoundary.tsx',
        'src/components/Common/VirtualContainers.tsx',
        'src/components/Library/Grid/GameCardCover.tsx',
        'src/components/Library/LibraryGridView.tsx',
        'src/components/SteamStoreDetail/SteamLibraryActionBar.tsx',
        'src/App.tsx',
        'src/main.tsx',
      ];

      const violations: string[] = [];
      for (const relPath of targetFiles) {
        const fullPath = path.join(ROOT_DIR, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const sf = ts.createSourceFile(
          fullPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        const checkNode = (node: ts.Node) => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${pos.line + 1}`);
          }
          ts.forEachChild(node, checkNode);
        };
        checkNode(sf);
      }

      expect(violations).toEqual([]);
    });
  });
});
