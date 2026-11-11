import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { Component, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

import { AppErrorBoundary, AppErrorBoundaryClass } from '../src/components/Common/AppErrorBoundary';
import { ModalErrorBoundary, ModalErrorBoundaryClass } from '../src/components/Common/ModalErrorBoundary';
import {
  acquireModalOverlayLock,
  emergencyResetModalOverlayLock,
  checkModalOverlaySelfHealing,
  isModalOverlayOpen,
} from '../src/utils/modalOverlayLock';
import { lazyWithRetry } from '../src/utils/lazyWithRetry';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import type { CanonicalGame } from '../src/contracts/game';

const globalRecord = globalThis as Record<string, unknown>;

interface LazyPayload {
  _status: number;
  _result: unknown;
}

function attachStateTracker<S extends object>(inst: { state: S; setState: unknown }): void {
  inst.setState = vi.fn((updater: unknown) => {
    const next =
      typeof updater === 'function'
        ? (updater as (s: S) => S)(inst.state)
        : updater;
    inst.state = { ...inst.state, ...(next as Partial<S>) };
  });
}

function createAdversarialSyntheticGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return {
    id: 'chaos-synthetic-game',
    title: 'Adversarial Chaos Title',
    sortTitle: 'adversarial chaos title',
    headerImage: 'https://cdn.example.invalid/headers/chaos.jpg',
    capsuleImage: 'https://cdn.example.invalid/covers/chaos-2x3.jpg',
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '999888',
        installed: false,
        playtimeMinutes: 0,
      },
    ],
    genres: ['Action', 'Stress Test'],
    tags: ['Adversarial'],
    developers: ['Chaos Labs'],
    publishers: ['Chaos Distro'],
    ...overrides,
  };
}

describe('Adversarial M4 Stress Test Harness: Error Boundary & Inert Chaos Torture', () => {
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

  // =========================================================================
  // Torture Suite 1: Chaos Exception Injection in Child Components
  // =========================================================================
  describe('Chaos Torture Suite 1: Exception Injection (Non-Error Objects)', () => {
    it('1.1 AppErrorBoundary: normalizes raw string throws and empty string without unmounting #root', () => {
      // Test non-empty string
      const stateStr = AppErrorBoundary.getDerivedStateFromError('CRITICAL_CHAOS_DATABASE_LOCK_DEADLOCK');
      expect(stateStr.hasError).toBe(true);
      expect(stateStr.error).toBeInstanceOf(Error);
      expect(stateStr.error?.message).toBe('CRITICAL_CHAOS_DATABASE_LOCK_DEADLOCK');

      // Test empty string fallback
      const stateEmptyStr = AppErrorBoundary.getDerivedStateFromError('');
      expect(stateEmptyStr.hasError).toBe(true);
      expect(stateEmptyStr.error).toBeInstanceOf(Error);
      expect(stateEmptyStr.error?.message).toBe('Unknown application error');

      // Verify panic dashboard renders string payload
      const boundary = new AppErrorBoundary({ children: <div>Main App</div> });
      boundary.state = {
        hasError: true,
        error: stateStr.error ?? null,
        errorInfo: { componentStack: '\n    in ChaosComponent' },
        resetKey: 0,
        copied: false,
      };

      const html = renderToString(boundary.render() as React.ReactElement);
      expect(html).toContain('Application Encountered an Error');
      expect(html).toContain('CRITICAL_CHAOS_DATABASE_LOCK_DEADLOCK');
      expect(html).toContain('role="region"');
      expect(html).toContain('role="alert"');
      expect(html).toContain('aria-live="assertive"');
      expect(html).toContain('Try Again');
      expect(html).toContain('Reload View');
      expect(html).toContain('Relaunch Application');
      expect(html).toContain('Safe Mode Restart');
      expect(html).toContain('Copy Error Details');
    });

    it('1.2 AppErrorBoundary: normalizes numeric throws (status codes, 0, NaN, Infinity)', () => {
      // 500 error code
      const state500 = AppErrorBoundary.getDerivedStateFromError(500);
      expect(state500.hasError).toBe(true);
      expect(state500.error).toBeInstanceOf(Error);
      expect(state500.error?.message).toBe('500');

      // 0 (falsy number)
      const stateZero = AppErrorBoundary.getDerivedStateFromError(0);
      expect(stateZero.hasError).toBe(true);
      expect(stateZero.error).toBeInstanceOf(Error);
      expect(stateZero.error?.message).toBe('Unknown application error');

      // NaN (falsy numeric)
      const stateNaN = AppErrorBoundary.getDerivedStateFromError(NaN);
      expect(stateNaN.hasError).toBe(true);
      expect(stateNaN.error).toBeInstanceOf(Error);
      expect(stateNaN.error?.message).toBe('Unknown application error');

      // Infinity
      const stateInf = AppErrorBoundary.getDerivedStateFromError(Infinity);
      expect(stateInf.hasError).toBe(true);
      expect(stateInf.error).toBeInstanceOf(Error);
      expect(stateInf.error?.message).toBe('Infinity');
    });

    it('1.3 AppErrorBoundary: normalizes null and undefined without throwing TypeError', () => {
      const stateNull = AppErrorBoundary.getDerivedStateFromError(null);
      expect(stateNull.hasError).toBe(true);
      expect(stateNull.error).toBeInstanceOf(Error);
      expect(stateNull.error?.message).toBe('Unknown application error');

      const stateUndef = AppErrorBoundary.getDerivedStateFromError(undefined);
      expect(stateUndef.hasError).toBe(true);
      expect(stateUndef.error).toBeInstanceOf(Error);
      expect(stateUndef.error?.message).toBe('Unknown application error');
    });

    it('1.4 AppErrorBoundary: normalizes Symbols without crashing String conversion', () => {
      const chaosSymbol = Symbol('CHAOS_INJECTOR_TOKEN');
      const stateSym = AppErrorBoundary.getDerivedStateFromError(chaosSymbol);
      expect(stateSym.hasError).toBe(true);
      expect(stateSym.error).toBeInstanceOf(Error);
      expect(stateSym.error?.message).toBe('Symbol(CHAOS_INJECTOR_TOKEN)');

      const anonSymbol = Symbol();
      const stateAnonSym = AppErrorBoundary.getDerivedStateFromError(anonSymbol);
      expect(stateAnonSym.hasError).toBe(true);
      expect(stateAnonSym.error).toBeInstanceOf(Error);
      expect(stateAnonSym.error?.message).toBe('Symbol()');
    });

    it('1.5 AppErrorBoundary: normalizes deeply circular objects without recursion stack overflow', () => {
      const circularA: Record<string, unknown> = { name: 'NodeA' };
      const circularB: Record<string, unknown> = { name: 'NodeB' };
      circularA.neighbor = circularB;
      circularB.neighbor = circularA;
      circularA.self = circularA;

      const stateCirc = AppErrorBoundary.getDerivedStateFromError(circularA);
      expect(stateCirc.hasError).toBe(true);
      expect(stateCirc.error).toBeInstanceOf(Error);
      expect(stateCirc.error?.message).toBe('[object Object]');
    });

    it('1.6 AppErrorBoundary: normalizes Promise rejections and rejection descriptors', () => {
      const rejectedPromise = Promise.reject(new Error('Uncaught background rejection'));
      rejectedPromise.catch(() => {}); // prevent uncaught rejection warning in node

      const rejectionObj = {
        reason: 'Async pipe closed unexpectedly',
        promise: rejectedPromise,
      };

      const stateRejection = AppErrorBoundary.getDerivedStateFromError(rejectionObj);
      expect(stateRejection.hasError).toBe(true);
      expect(stateRejection.error).toBeInstanceOf(Error);
      expect(stateRejection.error?.message).toBe('[object Object]');
    });

    it('1.7 AppErrorBoundary: normalizes booleans, BigInt, and function objects', () => {
      const stateFalse = AppErrorBoundary.getDerivedStateFromError(false);
      expect(stateFalse.hasError).toBe(true);
      expect(stateFalse.error?.message).toBe('Unknown application error');

      const stateTrue = AppErrorBoundary.getDerivedStateFromError(true);
      expect(stateTrue.hasError).toBe(true);
      expect(stateTrue.error?.message).toBe('true');

      const stateBigInt = AppErrorBoundary.getDerivedStateFromError(9007199254740999n);
      expect(stateBigInt.hasError).toBe(true);
      expect(stateBigInt.error?.message).toBe('9007199254740999');

      const crashFn = () => 'I am a throwing function payload';
      const stateFn = AppErrorBoundary.getDerivedStateFromError(crashFn);
      expect(stateFn.hasError).toBe(true);
      expect(stateFn.error?.message).toContain('I am a throwing function payload');
    });

    it('1.8 ModalErrorBoundary: normalizes string, number, null, symbol, circular, and promise objects', () => {
      // String
      const mStr = ModalErrorBoundary.getDerivedStateFromError('CORRUPTED_RUNNER_PAYLOAD');
      expect(mStr.hasError).toBe(true);
      expect(mStr.error).toBeInstanceOf(Error);
      expect(mStr.error?.message).toBe('CORRUPTED_RUNNER_PAYLOAD');

      // Number
      const mNum = ModalErrorBoundary.getDerivedStateFromError(404);
      expect(mNum.hasError).toBe(true);
      expect(mNum.error?.message).toBe('404');

      // Null
      const mNull = ModalErrorBoundary.getDerivedStateFromError(null);
      expect(mNull.hasError).toBe(true);
      expect(mNull.error?.message).toBe('Unknown error');

      // Symbol
      const mSym = ModalErrorBoundary.getDerivedStateFromError(Symbol('MODAL_CHAOS_SYM'));
      expect(mSym.hasError).toBe(true);
      expect(mSym.error?.message).toBe('Symbol(MODAL_CHAOS_SYM)');

      // Circular
      const cyclic: Record<string, unknown> = { dialog: 'install' };
      cyclic.cyclic = cyclic;
      const mCirc = ModalErrorBoundary.getDerivedStateFromError(cyclic);
      expect(mCirc.hasError).toBe(true);
      expect(mCirc.error?.message).toBe('[object Object]');

      // Verify fallback rendering in ModalShell
      const boundary = new ModalErrorBoundary({
        modalName: 'Chaos Modal',
        isOpen: true,
        onClose: vi.fn(),
        children: <div>Modal Inner</div>,
      });
      boundary.state = {
        hasError: true,
        error: mStr.error ?? null,
        resetKey: 0,
      };

      const html = renderToString(boundary.render() as React.ReactElement).replace(/<!-- -->/g, '');
      expect(html).toContain('Chaos Modal Error');
      expect(html).toContain('CORRUPTED_RUNNER_PAYLOAD');
      expect(html).toContain('role="alert"');
      expect(html).toContain('aria-live="assertive"');
      expect(html).toContain('autofocus=""');
    });

    it('1.9 Adversarial Discovery: verifies behavior when non-standard objects are thrown', () => {
      // Standard plain object
      const plainObj = { code: 'ERR_WINE_CRASH', exitCode: 139 };
      const derived = AppErrorBoundary.getDerivedStateFromError(plainObj);
      expect(derived.hasError).toBe(true);
      expect(derived.error).toBeInstanceOf(Error);
      expect(derived.error?.message).toBe('[object Object]');
    });
  });

  // =========================================================================
  // Torture Suite 2: Inert Lock Deadlock & Self-Healing Torture
  // =========================================================================
  describe('Chaos Torture Suite 2: Inert Lock Deadlock & Self-Healing Torture', () => {
    it('2.1 simulates fatal crash during modal open transition and verifies emergency reset clears #root[inert]', () => {
      let rootInert = false;
      let openOverlayAttr: string | null = null;
      let modalOverlayEvents: boolean[] = [];

      const docMock = {
        documentElement: {
          setAttribute: vi.fn((attr: string, val: string) => {
            if (attr === 'data-modal-overlay-open') openOverlayAttr = val;
          }),
          removeAttribute: vi.fn((attr: string) => {
            if (attr === 'data-modal-overlay-open') openOverlayAttr = null;
          }),
        },
        getElementById: vi.fn((id: string) => {
          if (id === 'root') {
            return {
              setAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') rootInert = true;
              }),
              removeAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') rootInert = false;
              }),
            };
          }
          return null;
        }),
        body: { nodeType: 1 },
      };

      const winMock = {
        dispatchEvent: vi.fn((ev: CustomEvent<{ isOpen: boolean }>) => {
          modalOverlayEvents.push(ev.detail.isOpen);
          return true;
        }),
      };

      globalRecord.document = docMock;
      globalRecord.window = winMock;
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      // 1. Modal starts opening and acquires lock
      acquireModalOverlayLock();
      expect(isModalOverlayOpen()).toBe(true);
      expect(rootInert).toBe(true);
      expect(openOverlayAttr).toBe('true');
      expect(modalOverlayEvents).toEqual([true]);

      // 2. Fatal unhandled crash occurs inside the tree during render
      const boundary = new AppErrorBoundary({ children: <div>Tree</div> });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      boundary.componentDidCatch(new Error('Fatal transition deadlock panic'), {
        componentStack: '\n    in CrashingModalDuringOpen',
      });

      // 3. AppErrorBoundary.componentDidCatch MUST have invoked emergencyResetModalOverlayLock()
      expect(isModalOverlayOpen()).toBe(false);
      expect(rootInert).toBe(false);
      expect(openOverlayAttr).toBeNull();
      expect(modalOverlayEvents).toEqual([true, false]);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('2.2 simulates zombie leaked locks and verifies checkModalOverlaySelfHealing recovers #root interactivity', () => {
      let rootInert = false;
      let openOverlayAttr: string | null = null;

      const docMock = {
        documentElement: {
          setAttribute: vi.fn((attr: string, val: string) => {
            if (attr === 'data-modal-overlay-open') openOverlayAttr = val;
          }),
          removeAttribute: vi.fn((attr: string) => {
            if (attr === 'data-modal-overlay-open') openOverlayAttr = null;
          }),
        },
        getElementById: vi.fn((id: string) => {
          if (id === 'root') {
            return {
              setAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') rootInert = true;
              }),
              removeAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') rootInert = false;
              }),
            };
          }
          return null;
        }),
        // Simulate no open dialogs in DOM (all dialogs unmounted or destroyed)
        querySelectorAll: vi.fn().mockReturnValue([]),
        body: { nodeType: 1 },
      };

      globalRecord.document = docMock;
      globalRecord.window = { dispatchEvent: vi.fn() };
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      // Simulate 5 unclosed/leaked modal locks
      for (let i = 0; i < 5; i++) {
        acquireModalOverlayLock();
      }
      expect(rootInert).toBe(true);
      expect(openOverlayAttr).toBe('true');

      // Trigger self healing audit
      const isOpen = checkModalOverlaySelfHealing();
      expect(isOpen).toBe(false);
      expect(isModalOverlayOpen()).toBe(false);
      expect(rootInert).toBe(false);
      expect(openOverlayAttr).toBeNull();
    });

    it('2.3 verifies checkModalOverlaySelfHealing preserves locks when a valid dialog is open in DOM', () => {
      let rootInert = false;
      const docMock = {
        documentElement: {
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
        },
        getElementById: vi.fn((id: string) => {
          if (id === 'root') {
            return {
              setAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') rootInert = true;
              }),
              removeAttribute: vi.fn((attr: string) => {
                if (attr === 'inert') rootInert = false;
              }),
            };
          }
          return null;
        }),
        // A genuine <dialog open> element is actively present in DOM
        querySelectorAll: vi.fn().mockReturnValue([{ tagName: 'DIALOG', open: true }]),
        body: { nodeType: 1 },
      };

      globalRecord.document = docMock;
      globalRecord.window = { dispatchEvent: vi.fn() };
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      acquireModalOverlayLock();
      expect(rootInert).toBe(true);

      // Self healing should detect the open dialog and NOT reset the lock
      const isOpen = checkModalOverlaySelfHealing();
      expect(isOpen).toBe(true);
      expect(rootInert).toBe(true);
    });

    it('2.4 subjects lock coordinator to 50 rapid alternating acquire/release/crash cycles', () => {
      let rootInert = false;
      const docMock = {
        documentElement: {
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
        },
        getElementById: vi.fn((id: string) => ({
          setAttribute: vi.fn((attr: string) => {
            if (attr === 'inert') rootInert = true;
          }),
          removeAttribute: vi.fn((attr: string) => {
            if (attr === 'inert') rootInert = false;
          }),
        })),
        querySelectorAll: vi.fn().mockReturnValue([]),
        body: { nodeType: 1 },
      };

      globalRecord.document = docMock;
      globalRecord.window = { dispatchEvent: vi.fn() };
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      // Rapid chaos cycles
      for (let i = 0; i < 50; i++) {
        const release = acquireModalOverlayLock();
        if (i % 3 === 0) {
          // Normal clean release
          release();
        } else if (i % 3 === 1) {
          // Double release (idempotency check)
          release();
          release();
        } else {
          // Abrupt crash -> emergency reset
          emergencyResetModalOverlayLock();
        }
      }

      // Final check: emergency reset ensures clean zero state
      emergencyResetModalOverlayLock();
      expect(isModalOverlayOpen()).toBe(false);
      expect(rootInert).toBe(false);
    });

    it('2.5 verifies CustomEvent dispatching does not throw when window.dispatchEvent fails', () => {
      const docMock = {
        documentElement: { setAttribute: vi.fn(), removeAttribute: vi.fn() },
        getElementById: vi.fn(() => ({ setAttribute: vi.fn(), removeAttribute: vi.fn() })),
        body: { nodeType: 1 },
      };
      globalRecord.document = docMock;
      globalRecord.HTMLElement = function () {};
      Object.setPrototypeOf(
        docMock.body,
        (globalThis as unknown as Record<string, { prototype?: object }>).HTMLElement?.prototype ?? {}
      );

      // Faulty dispatchEvent throwing DOMException
      globalRecord.window = {
        dispatchEvent: vi.fn(() => {
          throw new Error('Restricted sandboxed dispatch failure');
        }),
      };

      expect(() => {
        const release = acquireModalOverlayLock();
        release();
      }).not.toThrow();

      expect(() => {
        emergencyResetModalOverlayLock();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Torture Suite 3: Lazy Chunk Poisoning Torture
  // =========================================================================
  describe('Chaos Torture Suite 3: Lazy Chunk Poisoning & Dynamic Import Recovery', () => {
    it('3.1 simulates complete network outage, exhausts retries, and verifies payload status un-poisoning', async () => {
      let loaderAttempts = 0;
      const failingLoader = vi.fn(async () => {
        loaderAttempts++;
        throw new Error(`ChunkLoadError: Connection reset by peer (attempt ${loaderAttempts})`);
      });

      // 2 retries with 5ms backoff
      const LazyComp = lazyWithRetry(failingLoader, 2, 5);
      const payload = (LazyComp as unknown as { _payload: LazyPayload })._payload;

      expect(payload._status).toBe(-1);
      const initialCtor = payload._result as () => Promise<unknown>;

      // Execute initial dynamic import attempt
      let caughtError: Error | null = null;
      try {
        await initialCtor();
      } catch (err) {
        caughtError = err as Error;
      }

      // Must have executed 3 attempts (1 initial + 2 retries)
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError?.message).toContain('ChunkLoadError: Connection reset by peer');
      expect(loaderAttempts).toBe(3);

      // React's lazy initializer sets _status = 2 on rejected promises
      payload._status = 2;
      payload._result = caughtError;

      // Wait for next event loop tick so lazyWithRetry un-poisoning setTimeout(..., 0) runs
      await new Promise((resolve) => setTimeout(resolve, 25));

      // VERIFY: _status has been un-poisoned back to -1, and _result is a fresh constructor!
      expect(payload._status).toBe(-1);
      expect(typeof payload._result).toBe('function');
      expect(payload._result).not.toBe(initialCtor);
    });

    it('3.2 verifies that subsequent render attempt after network recovery fetches fresh chunk rather than serving cached rejection', async () => {
      let isNetworkOffline = true;
      let totalImportInvocations = 0;

      const dynamicChunkLoader = vi.fn(async () => {
        totalImportInvocations++;
        if (isNetworkOffline) {
          throw new Error('ERR_INTERNET_DISCONNECTED: Chunk bundle 104.js failed');
        }
        return {
          default: () => React.createElement('div', { 'data-testid': 'recovered-chunk' }, 'Online Payload'),
        };
      });

      const LazyComp = lazyWithRetry(dynamicChunkLoader, 1, 5);
      const payload = (LazyComp as unknown as { _payload: LazyPayload })._payload;

      // 1. Initial attempt fails while network is offline
      try {
        await (payload._result as () => Promise<unknown>)();
      } catch {
        // Simulated rejection
      }
      expect(totalImportInvocations).toBe(2); // 1 initial + 1 retry

      // Simulate React marking the payload rejected
      payload._status = 2;
      payload._result = new Error('Cached rejection');

      // Wait for un-poisoning
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(payload._status).toBe(-1);

      // 2. Network connection is restored!
      isNetworkOffline = false;

      // User reopens the dialog or triggers re-render -> React invokes the fresh constructor
      const freshCtor = payload._result as () => Promise<unknown>;
      const resolvedModule = (await freshCtor()) as { default: React.ComponentType };
      expect(resolvedModule).toBeDefined();
      expect(typeof resolvedModule.default).toBe('function');

      // Update payload to resolved state (as React 19 does)
      payload._status = 1;
      payload._result = resolvedModule;

      // Render the recovered component
      const html = renderToString(React.createElement(LazyComp));
      expect(html).toContain('data-testid="recovered-chunk"');
      expect(html).toContain('Online Payload');

      // Total invocations should be 3 (2 offline + 1 online)
      expect(totalImportInvocations).toBe(3);
    });

    it('3.3 verifies transient network blip recovers before retries are exhausted', async () => {
      let attempts = 0;
      const intermittentLoader = vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('ETIMEDOUT: Transient socket drop');
        }
        return {
          default: () => React.createElement('span', null, 'Transient Recovery Succeeded'),
        };
      });

      const LazyComp = lazyWithRetry(intermittentLoader, 2, 5);
      const payload = (LazyComp as unknown as { _payload: LazyPayload })._payload;

      const result = (await (payload._result as () => Promise<unknown>)()) as { default: React.ComponentType };
      expect(result).toBeDefined();
      expect(attempts).toBe(2); // 1 initial fail + 1 retry success

      payload._status = 1;
      payload._result = result;
      const html = renderToString(React.createElement(LazyComp));
      expect(html).toContain('Transient Recovery Succeeded');
    });

    it('3.4 verifies synchronous exceptions inside factory are safely intercepted and retried', async () => {
      let syncThrows = 0;
      const crashingFactory = vi.fn(() => {
        syncThrows++;
        if (syncThrows <= 1) {
          throw new Error('EvalError: Unexpected token in dynamic chunk');
        }
        return Promise.resolve({
          default: () => React.createElement('div', null, 'Sync Error Recovered'),
        });
      });

      const LazyComp = lazyWithRetry(crashingFactory, 2, 5);
      const payload = (LazyComp as unknown as { _payload: LazyPayload })._payload;

      const result = (await (payload._result as () => Promise<unknown>)()) as { default: React.ComponentType };
      expect(result).toBeDefined();
      expect(syncThrows).toBe(2);

      payload._status = 1;
      payload._result = result;
      const html = renderToString(React.createElement(LazyComp));
      expect(html).toContain('Sync Error Recovered');
    });
  });

  // =========================================================================
  // Torture Suite 4: Action Bar Modal Fault Isolation
  // =========================================================================
  describe('Chaos Torture Suite 4: Action Bar Modal Fault Isolation', () => {
    it('4.1 simulates GameInstallModal crash and verifies ModalErrorBoundary traps error while parent remains intact', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Crashing child component simulating fatal storage or manifest corruption
      class CrashingInstallModal extends Component {
        public override render(): ReactNode {
          throw new Error('FATAL_MANIFEST_CORRUPTION: Invalid depots definition for game 999888');
        }
      }

      const onCloseMock = vi.fn();
      const modalBoundary = new ModalErrorBoundary({
        modalName: 'Game Installation',
        isOpen: true,
        onClose: onCloseMock,
        children: <CrashingInstallModal />,
      });

      // Simulate React error boundary lifecycle
      const derived = ModalErrorBoundary.getDerivedStateFromError(
        new Error('FATAL_MANIFEST_CORRUPTION: Invalid depots definition for game 999888')
      );
      modalBoundary.state = {
        hasError: true,
        error: derived.error ?? null,
        resetKey: 0,
      };

      modalBoundary.componentDidCatch(derived.error as Error, {
        componentStack: '\n    in CrashingInstallModal',
      });

      // Render modal boundary fallback
      const modalHtml = renderToString(modalBoundary.render() as React.ReactElement).replace(/<!-- -->/g, '');
      expect(modalHtml).toContain('Game Installation Error');
      expect(modalHtml).toContain('FATAL_MANIFEST_CORRUPTION: Invalid depots definition');
      expect(modalHtml).toContain('role="alert"');
      expect(modalHtml).toContain('aria-live="assertive"');
      expect(modalHtml).toContain('autofocus=""');

      // Verify action buttons in error fallback
      expect(modalHtml).toContain('Try Again');
      expect(modalHtml).toContain('Close');

      // Verify parent action bar is completely intact and functional
      const game = createAdversarialSyntheticGame();
      const parentBarHtml = renderToString(<SteamLibraryActionBar game={game} />);
      expect(parentBarHtml).toContain('Install');
      expect(parentBarHtml).not.toContain('Game Installation Error');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('4.2 simulates GameLaunchConfigModal crash and verifies launch config isolation', () => {
      const onCloseMock = vi.fn();
      const modalBoundary = new ModalErrorBoundary({
        modalName: 'Launch Configuration',
        isOpen: true,
        onClose: onCloseMock,
        children: <div>Launch Config Modal</div>,
      });
      attachStateTracker(modalBoundary);

      const derived = ModalErrorBoundary.getDerivedStateFromError(
        new Error('CORRUPT_WINE_RUNNER_REGISTRY: Runner path does not exist on disk')
      );
      modalBoundary.state = {
        hasError: true,
        error: derived.error ?? null,
        resetKey: 0,
      };

      const html = renderToString(modalBoundary.render() as React.ReactElement).replace(/<!-- -->/g, '');
      expect(html).toContain('Launch Configuration Error');
      expect(html).toContain('CORRUPT_WINE_RUNNER_REGISTRY');
      expect(html).toContain('role="alert"');

      // Test Close action
      modalBoundary.handleClose();
      expect(modalBoundary.state.hasError).toBe(false);
      expect(modalBoundary.state.error).toBeNull();
      expect(onCloseMock).toHaveBeenCalledTimes(1);

      // Test Try Again action
      modalBoundary.state.hasError = true;
      modalBoundary.handleReset();
      expect(modalBoundary.state.hasError).toBe(false);
      expect(modalBoundary.state.resetKey).toBe(1);
    });

    it('4.3 verifies ModalErrorBoundary auto-clears error state when isOpen transitions from true to false', () => {
      const modalBoundary = new ModalErrorBoundary({
        modalName: 'Game Installation',
        isOpen: true,
        onClose: vi.fn(),
        children: <div>Modal Content</div>,
      });
      attachStateTracker(modalBoundary);

      modalBoundary.state = {
        hasError: true,
        error: new Error('Transient modal error'),
        resetKey: 0,
      };

      // Modal closes (isOpen: true -> false)
      modalBoundary.componentDidUpdate({
        modalName: 'Game Installation',
        isOpen: true,
        children: <div>Modal Content</div>,
      });
      // In this call, props.isOpen is still true, so error is NOT cleared yet
      expect(modalBoundary.state.hasError).toBe(true);

      // Now props update to isOpen: false
      Object.assign(modalBoundary, {
        props: {
          modalName: 'Game Installation',
          isOpen: false,
          onClose: vi.fn(),
          children: <div>Modal Content</div>,
        },
      });
      modalBoundary.componentDidUpdate({
        modalName: 'Game Installation',
        isOpen: true,
        children: <div>Modal Content</div>,
      });

      // Error state MUST be auto-cleared upon visibility change
      expect(modalBoundary.state.hasError).toBe(false);
      expect(modalBoundary.state.error).toBeNull();
    });

    it('4.4 verifies ModalErrorBoundary returns null when isOpen is false even if hasError is true', () => {
      const modalBoundary = new ModalErrorBoundary({
        modalName: 'Game Installation',
        isOpen: false,
        onClose: vi.fn(),
        children: <div>Modal Content</div>,
      });

      modalBoundary.state = {
        hasError: true,
        error: new Error('Lingering modal error'),
        resetKey: 0,
      };

      const rendered = modalBoundary.render();
      expect(rendered).toBeNull();
    });
  });

  // =========================================================================
  // Torture Suite 5: Extended Recovery Actions & Resilient Fallbacks
  // =========================================================================
  describe('Chaos Torture Suite 5: Extended Recovery Actions & Defense-in-Depth', () => {
    it('5.1 AppErrorBoundary: honors custom fallback prop when supplied during crash', () => {
      const boundary = new AppErrorBoundary({
        children: <div>Main Content</div>,
        fallback: <div data-testid="custom-fallback">Custom Safe View</div>,
      });
      boundary.state = {
        hasError: true,
        error: new Error('Simulated crash with fallback'),
        errorInfo: null,
        resetKey: 0,
        copied: false,
      };

      const html = renderToString(boundary.render() as React.ReactElement);
      expect(html).toContain('Custom Safe View');
      expect(html).not.toContain('Application Encountered an Error');
    });

    it('5.2 AppErrorBoundary: handleSafeModeRestart survives when sessionStorage throws QuotaExceededError', () => {
      const reloadMock = vi.fn();
      globalRecord.window = { location: { reload: reloadMock } };
      globalRecord.sessionStorage = {
        setItem: () => {
          throw new Error('QuotaExceededError: storage disabled in sandbox');
        },
      };

      const boundary = new AppErrorBoundary({ children: <div>App</div> });
      expect(() => {
        boundary.handleSafeModeRestart();
      }).not.toThrow();
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('5.3 AppErrorBoundary: handleCopyDetails safely catches clipboard.writeText rejections', async () => {
      const writeTextMock = vi.fn().mockRejectedValue(new Error('DOMException: Clipboard permission denied'));
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: writeTextMock },
          configurable: true,
          writable: true,
        });
      } catch {
        // Fallback
      }

      const boundary = new AppErrorBoundary({ children: <div>App</div> });
      boundary.state = {
        hasError: true,
        error: new Error('Permission denied error'),
        errorInfo: { componentStack: '\n    in SensitiveView' },
        resetKey: 0,
        copied: false,
      };

      expect(() => {
        boundary.handleCopyDetails();
      }).not.toThrow();
    });

    it('5.4 modalOverlayLock: guarantees non-portaled modals NEVER lock #root with inert', () => {
      let rootInert = false;
      const docMock = {
        documentElement: { setAttribute: vi.fn(), removeAttribute: vi.fn() },
        getElementById: vi.fn((id: string) => ({
          setAttribute: vi.fn((attr: string) => {
            if (attr === 'inert') rootInert = true;
          }),
          removeAttribute: vi.fn(),
        })),
        body: null, // No body -> cannot portal to body
      };
      globalRecord.document = docMock;

      // When cannot portal to body, acquireModalOverlayLock must NOT lock #root with inert
      const release = acquireModalOverlayLock();
      expect(rootInert).toBe(false);
      release();
    });

    it('5.5 lazyWithRetry: handles 0 retries and instant un-poisoning upon first failure', async () => {
      let invocations = 0;
      const singleAttemptLoader = vi.fn(async () => {
        invocations++;
        throw new Error('Immediate network disconnect');
      });

      const LazyComp = lazyWithRetry(singleAttemptLoader, 0, 0);
      const payload = (LazyComp as unknown as { _payload: LazyPayload })._payload;

      try {
        await (payload._result as () => Promise<unknown>)();
      } catch {
        // Expected reject
      }
      expect(invocations).toBe(1);

      payload._status = 2;
      payload._result = new Error('Instant fail');

      await new Promise((r) => setTimeout(r, 20));
      expect(payload._status).toBe(-1);
    });
  });
});
