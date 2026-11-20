import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalGame } from '../src/contracts/game';
import type { InstalledGameRecord, LauncherActionResult } from '../src/contracts/launcher';
import { App } from '../src/App';
import { launcherService } from '../src/services/launcher/launcherService';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import * as integrationStorage from '../src/services/integrations/integrationStorage';
import * as localSystemScanner from '../src/services/system/localSystemScanner';
import { steamApi } from '../src/services/steam/steamApi';
import { igdbCoverService } from '../src/services/igdb/igdbCoverService';
import { environmentSetupService } from '../src/services/launcher/environmentSetupService';
import {
  saveUserOverride,
  removeUserOverride,
} from '../src/services/storage/userOverrideStorage';
import {
  useLocalInstallSync,
  type UseLocalInstallSyncParams,
} from '../src/hooks/useLocalInstallSync';
import {
  usePostSessionReconciler,
  type UsePostSessionReconcilerParams,
} from '../src/hooks/usePostSessionReconciler';
import {
  useManualLibrarySyncActions,
  type UseManualLibrarySyncActionsParams,
} from '../src/hooks/useManualLibrarySyncActions';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const ROOT_DIR = path.resolve(__dirname, '..');

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Shallow React 19 stateful component/hook harness (matches gamePageModalStability.test.tsx).
 * Runs hooks and effects cleanly without requiring jsdom or resolving React.lazy chunks.
 */
function createShallowReactHarness<P extends object>(
  Component: (props: P) => React.ReactNode,
  initialProps: P
) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const callbacks: Array<{ fn: unknown; deps?: unknown[] }> = [];
  const prevDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;
  let unmounted = false;

  const render = (nextProps?: Partial<P>): React.ReactNode => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let callbackIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => unknown }> = [];

    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
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
      useState<T>(initial: T | (() => T)) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => T)() : initial);
        }
        const setState = (updater: T | ((prev: T) => T)) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: T) => T)(states[idx] as T)
              : updater;
        };
        return [states[idx] as T, setState];
      },
      useRef<T>(initial: T) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx] as { current: T };
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo<T>(fn: () => T) {
        return fn();
      },
      useCallback<T>(fn: T, deps?: unknown[]) {
        const idx = callbackIdx++;
        const prev = callbacks[idx];
        const changed =
          !prev ||
          !deps ||
          !prev.deps ||
          prev.deps.length !== deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps![i]));
        if (changed) {
          callbacks[idx] = { fn, deps };
        }
        return callbacks[idx].fn as T;
      },
      useDeferredValue<T>(val: T) {
        return val;
      },
      useTransition() {
        return [false, (fn: () => void) => fn()];
      },
      useContext<T>(ctx: { _currentValue: T }) {
        return ctx._currentValue;
      },
      useId() {
        return 'wave2-test-id';
      },
    };

    let tree: React.ReactNode;
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
      cleanups[eff.idx] = typeof cleanup === 'function' ? (cleanup as () => void) : undefined;
    }

    return tree;
  };

  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    for (const cleanup of cleanups) {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    }
  };

  return { render, unmount };
}

function createSyntheticDualPlatformGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return makeCanonicalGameFixture({
    id: 'synth-beacon-remastered',
    title: 'Synthetic Beacon Remastered',
    steamAppId: 900101,
    capsuleImage: 'https://cdn.example.invalid/gog/900202/boxart-2x3.jpg',
    headerImage: 'https://cdn.example.invalid/steam/900101/header.jpg',
    detailedDescription: 'Rich synthetic vault description for startup hydration tests.',
    enrichedMetadata: {
      appId: 900101,
      name: 'Synthetic Beacon Remastered',
      shortDescription: 'Rich synthetic short summary.',
      detailedDescription: 'Rich synthetic vault description for startup hydration tests.',
      aboutTheGame: 'Synthetic about the game copy.',
      headerImage: 'https://cdn.example.invalid/steam/900101/header.jpg',
      capsuleImage: 'https://cdn.example.invalid/gog/900202/boxart-2x3.jpg',
      developers: ['Synthetic Studio'],
      publishers: ['Synthetic Publisher'],
      genres: ['Action'],
      tags: ['Action'],
      categories: [],
      platforms: { windows: true, mac: false, linux: false },
      releaseDate: '2026-01-01',
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
          pathThumbnail: 'https://cdn.example.invalid/shots/1-thumb.jpg',
          pathFull: 'https://cdn.example.invalid/shots/1.jpg',
        },
      ],
      movies: [],
      enrichedAt: Date.parse('2026-11-01T00:00:00.000Z'),
    },
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '900101',
        installed: false,
        playtimeMinutes: 120,
      },
      {
        platformId: 'gog',
        platformGameId: '900202',
        installed: false,
        playtimeMinutes: 45,
      },
    ],
    ...overrides,
  });
}

describe('Wave 2: App Settings Wiring, Cold-Boot Barriers, Parallel Sync & Session Reconciliation', () => {
  const globalRecord = globalThis as Record<string, unknown>;
  let prevWindow: unknown;
  let prevDocument: unknown;
  let prevLocalStorage: unknown;
  let prevRaf: unknown;
  let prevCancelRaf: unknown;
  let mockStorage: Storage;
  let eventTarget: EventTarget;

  function installMockBrowserEnvironment(electronAPI?: Record<string, unknown>) {
    mockStorage = createMemoryStorage();
    eventTarget = new EventTarget();
    const mockWindow: Record<string, unknown> = {
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => eventTarget.addEventListener(type, listener, options),
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
      ) => eventTarget.removeEventListener(type, listener, options),
      dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
      localStorage: mockStorage,
      location: { hostname: 'localhost' },
      innerWidth: 1440,
      innerHeight: 900,
      open: vi.fn(),
      electronAPI,
    };

    globalRecord.localStorage = mockStorage;
    globalRecord.window = mockWindow;
    const bodyClasses = new Set<string>();
    globalRecord.document = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        eventTarget.addEventListener(type, listener),
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        eventTarget.removeEventListener(type, listener),
      body: {
        style: {},
        classList: {
          add: (cls: string) => bodyClasses.add(cls),
          remove: (cls: string) => bodyClasses.delete(cls),
          contains: (cls: string) => bodyClasses.has(cls),
        },
      },
      documentElement: { style: {} },
    };
    globalRecord.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number;
    globalRecord.cancelAnimationFrame = (id: number) => clearTimeout(id);

    return mockWindow;
  }

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevDocument = globalRecord.document;
    prevLocalStorage = globalRecord.localStorage;
    prevRaf = globalRecord.requestAnimationFrame;
    prevCancelRaf = globalRecord.cancelAnimationFrame;
    vi.restoreAllMocks();
    launcherService.resetForTests();
    steamAchievementsService.resetForTests();
    installMockBrowserEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    launcherService.resetForTests();
    steamAchievementsService.resetForTests();
    if (prevWindow === undefined) delete globalRecord.window;
    else globalRecord.window = prevWindow;
    if (prevDocument === undefined) delete globalRecord.document;
    else globalRecord.document = prevDocument;
    if (prevLocalStorage === undefined) delete globalRecord.localStorage;
    else globalRecord.localStorage = prevLocalStorage;
    if (prevRaf === undefined) delete globalRecord.requestAnimationFrame;
    else globalRecord.requestAnimationFrame = prevRaf;
    if (prevCancelRaf === undefined) delete globalRecord.cancelAnimationFrame;
    else globalRecord.cancelAnimationFrame = prevCancelRaf;
  });

  // ---------------------------------------------------------------------------
  // 1. App.tsx SettingsModal Wiring + Cold-Boot Hydration Write Barrier (S-01)
  // ---------------------------------------------------------------------------
  describe('1. App.tsx SettingsModal wiring & S-01 Cold-Boot Hydration Write Barrier', () => {
    it('wires Cmd+, / Ctrl+,, TopNavBar onOpenSettings, Electron IPC onOpenSettings, antigravity:open-settings, antigravity:open-setup-wizard, and SettingsModal callbacks', async () => {
      let ipcSettingsCb: ((section?: string) => void) | null = null;
      const ipcUnsubscribe = vi.fn();

      installMockBrowserEnvironment({
        onOpenSettings: vi.fn((cb: (section?: string) => void) => {
          ipcSettingsCb = cb;
          return ipcUnsubscribe;
        }),
      });

      vi.spyOn(integrationStorage, 'loadCurrentCatalog').mockReturnValue([
        createSyntheticDualPlatformGame(),
      ]);
      vi.spyOn(integrationStorage, 'hydrateCatalogFromIndexedDb').mockResolvedValue(null);
      vi.spyOn(launcherService, 'initialize').mockResolvedValue();
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: '2026-11-01T00:00:00.000Z',
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });

      const app = createShallowReactHarness(App, {});
      let tree = app.render();
      await flushMicrotasks();
      tree = app.render();

      const findModal = (currentTree: React.ReactNode, modalName: string) =>
        findElements(
          currentTree,
          (el) => el.props?.modalName === modalName && el.props?.isOpen === true
        )[0];

      // Initially SettingsModal is closed
      expect(findModal(tree, 'Global Settings')).toBeUndefined();

      // A) TopNavBar onOpenSettings opens Global Settings on 'general'
      const topNav = findElements(
        tree,
        (el) => typeof el.props?.onOpenSettings === 'function'
      )[0];
      expect(topNav).toBeDefined();
      (topNav.props.onOpenSettings as () => void)();
      tree = app.render();
      let settingsBoundary = findModal(tree, 'Global Settings');
      expect(settingsBoundary).toBeDefined();
      let settingsEl = findElements(
        settingsBoundary,
        (el) => typeof el.props?.onOpenRunnerSetup === 'function'
      )[0];
      expect(settingsEl).toBeDefined();
      expect(settingsEl.props.initialSection).toBe('general');

      // SettingsModal onOpenRunnerSetup closes Settings and opens System Setup Wizard on 'compatibility'
      (settingsEl.props.onOpenRunnerSetup as () => void)();
      tree = app.render();
      expect(findModal(tree, 'Global Settings')).toBeUndefined();
      const wizardBoundary = findModal(tree, 'System Setup Wizard');
      expect(wizardBoundary).toBeDefined();
      const wizardEl = findElements(
        wizardBoundary,
        (el) => el.props?.mode === 'health_check' && el.props?.initialStep === 'compatibility'
      )[0];
      expect(wizardEl).toBeDefined();
      (wizardBoundary.props.onClose as () => void)();
      tree = app.render();

      // B) Cmd+, opens SettingsModal and calls preventDefault()
      const cmdCommaPrevent = vi.fn();
      const cmdCommaEvent = new Event('keydown');
      Object.defineProperties(cmdCommaEvent, {
        metaKey: { value: true },
        ctrlKey: { value: false },
        altKey: { value: false },
        key: { value: ',' },
        preventDefault: { value: cmdCommaPrevent },
      });
      window.dispatchEvent(cmdCommaEvent);
      tree = app.render();
      expect(cmdCommaPrevent).toHaveBeenCalledTimes(1);
      settingsBoundary = findModal(tree, 'Global Settings');
      expect(settingsBoundary).toBeDefined();

      // SettingsModal onOpenIntegrations closes Settings and opens Storefront Integrations
      settingsEl = findElements(
        settingsBoundary,
        (el) => typeof el.props?.onOpenIntegrations === 'function'
      )[0];
      (settingsEl.props.onOpenIntegrations as () => void)();
      tree = app.render();
      expect(findModal(tree, 'Global Settings')).toBeUndefined();
      expect(findModal(tree, 'Storefront Integrations & Cloud Sync')).toBeDefined();
      (findModal(tree, 'Storefront Integrations & Cloud Sync').props.onClose as () => void)();
      tree = app.render();

      // C) antigravity:open-settings custom event opens macos_bottle section
      window.dispatchEvent(
        new CustomEvent('antigravity:open-settings', {
          detail: { section: 'macos_bottle' },
        })
      );
      tree = app.render();
      settingsBoundary = findModal(tree, 'Global Settings');
      expect(settingsBoundary).toBeDefined();
      settingsEl = findElements(
        settingsBoundary,
        (el) => typeof el.props?.onOpenRunnerSetup === 'function'
      )[0];
      expect(settingsEl.props.initialSection).toBe('macos_bottle');
      (settingsBoundary.props.onClose as () => void)();
      tree = app.render();

      // D) Electron IPC window.electronAPI.onOpenSettings opens SettingsModal
      expect(ipcSettingsCb).toBeTypeOf('function');
      ipcSettingsCb!('macos_bottle');
      tree = app.render();
      settingsBoundary = findModal(tree, 'Global Settings');
      expect(settingsBoundary).toBeDefined();
      settingsEl = findElements(
        settingsBoundary,
        (el) => typeof el.props?.onOpenRunnerSetup === 'function'
      )[0];
      expect(settingsEl.props.initialSection).toBe('macos_bottle');
      (settingsBoundary.props.onClose as () => void)();
      tree = app.render();

      // E) antigravity:open-setup-wizard normalizes 'compatibility_and_bottle' -> 'compatibility'
      window.dispatchEvent(
        new CustomEvent('antigravity:open-setup-wizard', {
          detail: { initialStep: 'compatibility_and_bottle' },
        })
      );
      tree = app.render();
      const wizardBoundary2 = findModal(tree, 'System Setup Wizard');
      expect(wizardBoundary2).toBeDefined();
      const wizardEl2 = findElements(
        wizardBoundary2,
        (el) => el.props?.initialStep === 'compatibility'
      )[0];
      expect(wizardEl2).toBeDefined();

      app.unmount();
      expect(ipcUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('emits 0 SQLite/IDB/localStorage catalog writes and only 1 localStorage catalog read on clean cold-boot hydration, while persisting post-hydration mutations', async () => {
      const slimGame = createSyntheticDualPlatformGame({
        detailedDescription: undefined,
        enrichedMetadata: undefined,
      });
      const richVaultGame = createSyntheticDualPlatformGame();

      const upsertGamesSpy = vi.fn().mockResolvedValue({ success: true });
      installMockBrowserEnvironment({
        offlineVault: {
          upsertGames: upsertGamesSpy,
          deleteGames: vi.fn().mockResolvedValue({ success: true }),
          getCatalogSnapshot: vi.fn().mockResolvedValue({ success: false, games: [] }),
        },
      });

      // Seed localStorage with slim catalog
      mockStorage.setItem('universal_game_library_catalog', JSON.stringify([slimGame]));
      const lsGetSpy = vi.spyOn(mockStorage, 'getItem');
      const lsSetSpy = vi.spyOn(mockStorage, 'setItem');
      const saveCatalogSpy = vi.spyOn(integrationStorage, 'saveCurrentCatalog');

      const hydrationDeferred = createDeferred<CanonicalGame[] | null>();
      vi.spyOn(integrationStorage, 'hydrateCatalogFromIndexedDb').mockReturnValue(
        hydrationDeferred.promise
      );
      vi.spyOn(launcherService, 'initialize').mockResolvedValue();
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: '2026-11-01T00:00:00.000Z',
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });

      const app = createShallowReactHarness(App, {});
      app.render();

      // Duplicate localStorage.getItem('universal_game_library_catalog') read eliminated (<= 1 on mount)
      const catalogGetCalls = lsGetSpy.mock.calls.filter(
        ([key]) => key === 'universal_game_library_catalog'
      );
      expect(catalogGetCalls.length).toBeLessThanOrEqual(1);

      // Before hydration completes: 0 writes
      expect(saveCatalogSpy).not.toHaveBeenCalled();
      expect(upsertGamesSpy).not.toHaveBeenCalled();
      expect(
        lsSetSpy.mock.calls.filter(([key]) => key === 'universal_game_library_catalog')
      ).toHaveLength(0);

      // Complete clean cold-boot hydration with richer vault snapshot (zero live deltas)
      hydrationDeferred.resolve([richVaultGame]);
      await flushMicrotasks();
      app.render();
      await flushMicrotasks();
      app.render();

      // S-01 invariant: 0 SQLite writes, 0 saveCurrentCatalog writes, 0 localStorage catalog writes
      expect(saveCatalogSpy).not.toHaveBeenCalled();
      expect(upsertGamesSpy).not.toHaveBeenCalled();
      expect(
        lsSetSpy.mock.calls.filter(([key]) => key === 'universal_game_library_catalog')
      ).toHaveLength(0);

      // Post-hydration mutation (e.g. install lifecycle event) DOES persist cleanly once hydrated
      window.dispatchEvent(
        new CustomEvent('antigravity:game-installed', {
          detail: {
            gameId: richVaultGame.id,
            platformId: 'steam',
            platformGameId: '900101',
            installed: true,
            installPath: '/synthetic/games/beacon',
          },
        })
      );
      await flushMicrotasks();
      app.render();
      await flushMicrotasks();

      expect(saveCatalogSpy).toHaveBeenCalled();
      app.unmount();
    });

    it('preserves pre-hydration live mutations across vault hydration and emits a single delta save only for mutated game IDs', async () => {
      const slimGameA = createSyntheticDualPlatformGame({
        id: 'synth-pre-a',
        title: 'Synthetic Alpha',
        steamAppId: 901001,
        detailedDescription: undefined,
        enrichedMetadata: undefined,
        platforms: [{ platformId: 'steam', platformGameId: '901001', installed: false, playtimeMinutes: 10 }],
      });
      const slimGameB = createSyntheticDualPlatformGame({
        id: 'synth-pre-b',
        title: 'Synthetic Beta',
        steamAppId: 901002,
        detailedDescription: undefined,
        enrichedMetadata: undefined,
        platforms: [{ platformId: 'steam', platformGameId: '901002', installed: false, playtimeMinutes: 20 }],
      });
      const richVaultA = createSyntheticDualPlatformGame({
        id: 'synth-pre-a',
        title: 'Synthetic Alpha',
        steamAppId: 901001,
        platforms: [{ platformId: 'steam', platformGameId: '901001', installed: false, playtimeMinutes: 10 }],
      });
      const richVaultB = createSyntheticDualPlatformGame({
        id: 'synth-pre-b',
        title: 'Synthetic Beta',
        steamAppId: 901002,
        platforms: [{ platformId: 'steam', platformGameId: '901002', installed: false, playtimeMinutes: 20 }],
      });

      mockStorage.setItem('universal_game_library_catalog', JSON.stringify([slimGameA, slimGameB]));
      const saveCatalogSpy = vi
        .spyOn(integrationStorage, 'saveCurrentCatalog')
        .mockImplementation(() => {});

      const hydrationDeferred = createDeferred<CanonicalGame[] | null>();
      vi.spyOn(integrationStorage, 'hydrateCatalogFromIndexedDb').mockReturnValue(
        hydrationDeferred.promise
      );
      vi.spyOn(launcherService, 'initialize').mockResolvedValue();
      vi.spyOn(environmentSetupService, 'loadWizardState').mockResolvedValue({
        schemaVersion: 1,
        completedAt: '2026-11-01T00:00:00.000Z',
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      });

      const app = createShallowReactHarness(App, {});
      app.render();

      // Trigger a live install mutation BEFORE vault hydration completes
      window.dispatchEvent(
        new CustomEvent('antigravity:game-installed', {
          detail: {
            gameId: 'synth-pre-a',
            platformId: 'steam',
            platformGameId: '901001',
            installed: true,
            installPath: '/synthetic/games/alpha',
          },
        })
      );
      await flushMicrotasks();
      app.render();

      // Write barrier still blocks writing the slim pre-hydrated catalog
      expect(saveCatalogSpy).not.toHaveBeenCalled();

      // Now vault hydration resolves -> merges live install delta + rich vault metadata, delta-saving ONLY synth-pre-a
      hydrationDeferred.resolve([richVaultA, richVaultB]);
      await flushMicrotasks();
      app.render();
      await flushMicrotasks();

      expect(saveCatalogSpy).toHaveBeenCalledTimes(1);
      const [savedCatalog, savedOpts] = saveCatalogSpy.mock.calls[0];
      expect(savedOpts?.dirtyGameIds).toEqual(['synth-pre-a']);
      const savedAlpha = savedCatalog.find((g) => g.id === 'synth-pre-a');
      expect(savedAlpha?.detailedDescription).toBe(richVaultA.detailedDescription);
      expect(savedAlpha?.platforms[0].installed).toBe(true);
      app.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. LauncherService Single-Flight Init, Silent Boot Scan, Dynamic Import & Launch Lock
  // ---------------------------------------------------------------------------
  describe('2. LauncherService S-02 / S-06 / S-07 / L-01 invariants', () => {
    it('coalesces concurrent initialize() calls, fires 0 antigravity:game-installed events on cold boot, deduplicates getAppInfo & getGameLaunchConfigs, and enforces 300s focus cooldown', async () => {
      const scanDeferred = createDeferred<{
        success: boolean;
        installedGames: InstalledGameRecord[];
      }>();
      const getAppInfoMock = vi.fn().mockResolvedValue({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
      });
      const getGameLaunchConfigsMock = vi.fn().mockResolvedValue({
        success: true,
        configs: {},
      });
      const scanInstalledGamesMock = vi
        .fn()
        .mockImplementationOnce(() => scanDeferred.promise)
        .mockResolvedValue({
          success: true,
          installedGames: [
            {
              platformId: 'steam',
              platformGameId: '900101',
              title: 'Synthetic Beacon Remastered',
              installPath: '/synthetic/games/beacon',
            },
            {
              platformId: 'steam',
              platformGameId: '900999',
              title: 'Synthetic Newly Installed',
              installPath: '/synthetic/games/new-title',
            },
          ],
        });

      installMockBrowserEnvironment({
        getAppInfo: getAppInfoMock,
        getGameLaunchConfigs: getGameLaunchConfigsMock,
        scanAllInstalledGames: scanInstalledGamesMock,
        detectCompatibilityLayers: vi.fn().mockResolvedValue({ success: true, layers: [] }),
        getRunningGames: vi.fn().mockResolvedValue({ success: true, runningGames: [] }),
        onGameSessionEvent: vi.fn().mockReturnValue(() => {}),
        onCompatibilityRunnerProgress: vi.fn().mockReturnValue(() => {}),
      });

      const installedEvents: Event[] = [];
      window.addEventListener('antigravity:game-installed', (ev) => installedEvents.push(ev));

      // Concurrent StrictMode / multi-caller initialize()
      const init1 = launcherService.initialize();
      const init2 = launcherService.initialize();
      const init3 = launcherService.initialize();

      // Deduplicated getAppInfo during init
      const [infoA, infoB] = await Promise.all([
        launcherService.getAppInfo(),
        launcherService.getAppInfo(),
      ]);
      expect(infoA?.platform).toBe('darwin');
      expect(infoB?.arch).toBe('arm64');

      scanDeferred.resolve({
        success: true,
        installedGames: [
          {
            platformId: 'steam',
            platformGameId: '900101',
            title: 'Synthetic Beacon Remastered',
            installPath: '/synthetic/games/beacon',
          },
        ],
      });

      await Promise.all([init1, init2, init3]);

      // Single-flight init deduplication
      expect(getAppInfoMock).toHaveBeenCalledTimes(1);
      expect(getGameLaunchConfigsMock).toHaveBeenCalledTimes(1);
      expect(scanInstalledGamesMock).toHaveBeenCalledTimes(1);

      // S-02: 0 individual antigravity:game-installed events fired on cold boot
      expect(installedEvents).toHaveLength(0);

      // Focus cooldown check: 30s and 299s are ignored, >= 300s triggers rescan
      const baseNow = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow + 30_000);
      window.dispatchEvent(new Event('focus'));
      await flushMicrotasks();
      expect(scanInstalledGamesMock).toHaveBeenCalledTimes(1);

      dateNowSpy.mockReturnValue(baseNow + 299_000);
      window.dispatchEvent(new Event('focus'));
      await flushMicrotasks();
      expect(scanInstalledGamesMock).toHaveBeenCalledTimes(1);

      dateNowSpy.mockReturnValue(baseNow + 305_000);
      window.dispatchEvent(new Event('focus'));
      await flushMicrotasks();
      expect(scanInstalledGamesMock).toHaveBeenCalledTimes(2);
      // Post-boot focus scan SHOULD notify newly detected game
      expect(installedEvents).toHaveLength(1);
    });

    it('loads syncJobManager dynamically (zero static import in launcherService.ts) and deduplicates double-clicked launchGame() calls with safe finally cleanup', async () => {
      const sourceText = fs.readFileSync(
        path.join(ROOT_DIR, 'src/services/launcher/launcherService.ts'),
        'utf8'
      );
      expect(sourceText).not.toMatch(/^\s*import\s+.*syncJobManager/m);
      expect(sourceText).toMatch(/import\(\s*['"]\.\.\/network\/syncJobManager['"]\s*\)/);

      const firstLaunch = createDeferred<LauncherActionResult>();
      const ipcLaunchMock = vi
        .fn()
        .mockImplementationOnce(() => firstLaunch.promise)
        .mockResolvedValueOnce({ success: true, gameId: 'synth-beacon-remastered' });

      installMockBrowserEnvironment({
        getAppInfo: vi.fn().mockResolvedValue({ platform: 'darwin', arch: 'arm64' }),
        getGameLaunchConfigs: vi.fn().mockResolvedValue({ success: true, configs: {} }),
        scanAllInstalledGames: vi.fn().mockResolvedValue({
          success: true,
          installedGames: [
            {
              id: 'steam-900101',
              platformId: 'steam',
              platformGameId: '900101',
              title: 'Synthetic Beacon Remastered',
              installPath: '/synthetic/games/beacon',
              executablePath: '/synthetic/games/beacon/game.exe',
            },
          ],
        }),
        detectCompatibilityLayers: vi.fn().mockResolvedValue({ success: true, layers: [] }),
        getRunningGames: vi.fn().mockResolvedValue({ success: true, runningGames: [] }),
        onGameSessionEvent: vi.fn().mockReturnValue(() => {}),
        onCompatibilityRunnerProgress: vi.fn().mockReturnValue(() => {}),
        launchGame: ipcLaunchMock,
      });

      await launcherService.initialize();
      const game = createSyntheticDualPlatformGame();

      // Double-click launchGame() while first flight is in progress
      const flightA = launcherService.launchGame(game, 'steam');
      const flightB = launcherService.launchGame(game, 'steam');
      expect(flightA).toBe(flightB);
      expect(ipcLaunchMock).toHaveBeenCalledTimes(1);

      firstLaunch.resolve({ success: false, error: 'Simulated launch error' });
      const [resA, resB] = await Promise.all([flightA, flightB]);
      expect(resA.success).toBe(false);
      expect(resB.success).toBe(false);

      // Lock cleared in finally -> retry launches cleanly
      const retryRes = await launcherService.launchGame(game, 'steam');
      expect(retryRes.success).toBe(true);
      expect(ipcLaunchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Parallel Storefront Sync + Deterministic Canonical Merge Order (S-03)
  // ---------------------------------------------------------------------------
  describe('3. useLocalInstallSync parallel storefront fetch & canonical Steam->GOG->Epic->Xbox merge', () => {
    it('fetches all connected storefronts concurrently, defers commit until isCatalogVaultHydrated=true, and merges in strict Steam -> GOG -> Epic -> Xbox order in one coalesced commit', async () => {
      const steamDeferred = createDeferred<{
        success: boolean;
        games: CanonicalGame[];
      }>();
      const gogDeferred = createDeferred<{
        success: boolean;
        games: CanonicalGame[];
      }>();
      const epicDeferred = createDeferred<{
        success: boolean;
        games: CanonicalGame[];
      }>();
      const xboxDeferred = createDeferred<{
        success: boolean;
        games: CanonicalGame[];
      }>();

      const startedStores: string[] = [];
      const syncStoreMock = vi.fn((store: string) => {
        startedStores.push(store);
        if (store === 'steam') return steamDeferred.promise;
        if (store === 'gog') return gogDeferred.promise;
        if (store === 'epic') return epicDeferred.promise;
        if (store === 'xbox') return xboxDeferred.promise;
        return Promise.resolve({ success: false });
      });

      installMockBrowserEnvironment({
        getAppInfo: vi.fn().mockResolvedValue({ platform: 'darwin', arch: 'arm64' }),
        getGameLaunchConfigs: vi.fn().mockResolvedValue({ success: true, configs: {} }),
        scanAllInstalledGames: vi.fn().mockResolvedValue({ success: true, installedGames: [] }),
        detectCompatibilityLayers: vi.fn().mockResolvedValue({ success: true, layers: [] }),
        getRunningGames: vi.fn().mockResolvedValue({ success: true, runningGames: [] }),
        onGameSessionEvent: vi.fn().mockReturnValue(() => {}),
        onCompatibilityRunnerProgress: vi.fn().mockReturnValue(() => {}),
        getSavedTokens: vi.fn().mockResolvedValue({
          steam: { steamId: '76561198000000001', access_token: 'tok-steam' },
          gog: { access_token: 'tok-gog', userId: 'u-gog' },
          epic: { access_token: 'tok-epic', accountId: 'u-epic' },
          xbox: { xstsToken: 'tok-xbox', uhs: 'uhs-1', xuid: 'xuid-1', gamertag: 'SynthTag' },
        }),
        syncStore: syncStoreMock,
      });

      vi.spyOn(integrationStorage, 'loadIntegrations').mockReturnValue([
        { storefrontId: 'steam', isConnected: true, accountName: 'SteamUser' },
        { storefrontId: 'gog', isConnected: true, accountName: 'GogUser' },
        { storefrontId: 'epic', isConnected: true, accountName: 'EpicUser' },
        { storefrontId: 'xbox', isConnected: true, accountName: 'XboxUser' },
      ] as ReturnType<typeof integrationStorage.loadIntegrations>);
      vi.spyOn(integrationStorage, 'saveIntegrations').mockImplementation(() => {});
      vi.spyOn(localSystemScanner, 'scanLocalInstalledGames').mockResolvedValue({
        success: true,
        installedSteamAppIds: [],
        installedGames: [],
      });
      vi.spyOn(steamAchievementsService, 'scanLocalAchievementsSingleFlight').mockResolvedValue({});
      vi.spyOn(steamAchievementsService, 'syncUserLibraryAchievements').mockResolvedValue({});
      const lsSetSpy = vi.spyOn(mockStorage, 'setItem');

      let currentGames: CanonicalGame[] = [];
      const gamesRef = { current: currentGames };
      const setGames = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        currentGames = typeof updater === 'function' ? updater(currentGames) : updater;
        gamesRef.current = currentGames;
      });
      const onCatalogPersisted = vi.fn();

      const HookProbe = (props: UseLocalInstallSyncParams) => {
        useLocalInstallSync(props);
        return null;
      };

      const harness = createDomain12DeepRenderer(HookProbe, {
        gamesRef,
        setGames,
        overlayLauncherInstalledState: (catalog) => catalog,
        showSyncNotice: vi.fn(),
        isModalOpen: false,
        isCatalogVaultHydrated: false,
        onCatalogPersisted,
      });

      harness.render();
      await flushMicrotasks(20);

      // All 4 connected storefronts must have been launched concurrently BEFORE any settled!
      expect(new Set(startedStores)).toEqual(new Set(['steam', 'gog', 'epic', 'xbox']));
      expect(syncStoreMock).toHaveBeenCalledTimes(4);

      const sharedTitle = 'Synthetic MultiStore Chronicle';
      // Resolve in REVERSE order: Xbox -> Epic -> GOG -> Steam
      xboxDeferred.resolve({
        success: true,
        games: [
          makeCanonicalGameFixture({
            id: 'xbox-shared-1',
            title: sharedTitle,
            platforms: [{ platformId: 'xbox', platformGameId: '9NBLGGH77777', xboxProductId: '9NBLGGH77777', installed: false, playtimeMinutes: 10 }],
          }),
          makeCanonicalGameFixture({
            id: 'xbox-only-1',
            title: 'Synth Xbox Exclusive',
            platforms: [{ platformId: 'xbox', platformGameId: '9NBLGGH88888', xboxProductId: '9NBLGGH88888', installed: false, playtimeMinutes: 10 }],
          }),
        ],
      });
      await flushMicrotasks();
      epicDeferred.resolve({
        success: true,
        games: [
          makeCanonicalGameFixture({
            id: 'epic-shared-1',
            title: sharedTitle,
            platforms: [{ platformId: 'epic', platformGameId: 'epic-shared-app', installed: false, playtimeMinutes: 20 }],
          }),
          makeCanonicalGameFixture({
            id: 'epic-only-1',
            title: 'Synth Epic Exclusive',
            platforms: [{ platformId: 'epic', platformGameId: 'epic-only-app', installed: false, playtimeMinutes: 20 }],
          }),
        ],
      });
      await flushMicrotasks();
      gogDeferred.resolve({
        success: true,
        games: [
          makeCanonicalGameFixture({
            id: 'gog-shared-1',
            title: sharedTitle,
            platforms: [{ platformId: 'gog', platformGameId: '500100', installed: false, playtimeMinutes: 30 }],
          }),
          makeCanonicalGameFixture({
            id: 'gog-only-1',
            title: 'Synth Gog Exclusive',
            platforms: [{ platformId: 'gog', platformGameId: '500200', installed: false, playtimeMinutes: 30 }],
          }),
        ],
      });
      await flushMicrotasks();
      steamDeferred.resolve({
        success: true,
        games: [
          makeCanonicalGameFixture({
            id: 'steam-777001',
            title: sharedTitle,
            steamAppId: 777001,
            platforms: [{ platformId: 'steam', platformGameId: '777001', installed: false, playtimeMinutes: 40 }],
          }),
          makeCanonicalGameFixture({
            id: 'steam-777002',
            title: 'Synth Steam Exclusive',
            steamAppId: 777002,
            platforms: [{ platformId: 'steam', platformGameId: '777002', installed: false, playtimeMinutes: 40 }],
          }),
        ],
      });
      // Yield past waitUntilScrollIdle + yieldToMainThread macrotask
      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushMicrotasks(25);

      // Because isCatalogVaultHydrated is STILL false, catalog commit must be deferred!
      expect(onCatalogPersisted).not.toHaveBeenCalled();
      expect(currentGames).toHaveLength(0);
      expect(
        lsSetSpy.mock.calls.filter(([key]) => key === 'universal_game_library_catalog')
      ).toHaveLength(0);

      // Flip isCatalogVaultHydrated -> true: deferred coalesced merge flushes ONCE in strict canonical order!
      harness.render({ isCatalogVaultHydrated: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushMicrotasks(15);

      expect(onCatalogPersisted).toHaveBeenCalledTimes(1);
      expect(setGames).toHaveBeenCalledTimes(1);

      // Shared multi-store title MUST be anchored on Steam first, then merged GOG -> Epic -> Xbox!
      const mergedShared = currentGames.find((g) => g.title === sharedTitle);
      expect(mergedShared).toBeDefined();
      expect(mergedShared!.id).toBe('steam-777001');
      expect(mergedShared!.platforms.map((p) => p.platformId)).toEqual([
        'steam',
        'gog',
        'epic',
        'xbox',
      ]);

      // All 4 storefront exclusives were merged into the single coalesced commit
      const exclusiveTitles = new Set(
        currentGames.filter((g) => g.title.endsWith('Exclusive')).map((g) => g.title)
      );
      expect(exclusiveTitles).toEqual(
        new Set([
          'Synth Steam Exclusive',
          'Synth Gog Exclusive',
          'Synth Epic Exclusive',
          'Synth Xbox Exclusive',
        ])
      );

      harness.unmount();
    });

    it('skips redundant catalog commits and writes when startup storefront sync produces no catalog changes', async () => {
      const incomingGame = makeCanonicalGameFixture({
        id: 'steam-888001',
        title: 'Synthetic Unchanged Title',
        originalStoreTitle: 'Synthetic Unchanged Title',
        steamAppId: 888001,
        headerImage: 'https://cdn.example.invalid/steam/888001/header.jpg',
        capsuleImage: 'https://cdn.example.invalid/steam/888001/library_600x900_2x.jpg',
        iconUrl: 'https://cdn.example.invalid/steam/888001/icon.jpg',
        shortDescription: 'Synthetic unchanged description',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '888001',
            originalTitle: 'Synthetic Unchanged Title',
            installed: false,
            playtimeMinutes: 55,
          },
        ],
      });
      // Seed catalog with the already-normalized state from a previous boot
      const existingGame = integrationStorage.mergeStorefrontGames([], [incomingGame], 'steam')[0];

      installMockBrowserEnvironment({
        getAppInfo: vi.fn().mockResolvedValue({ platform: 'darwin', arch: 'arm64' }),
        getGameLaunchConfigs: vi.fn().mockResolvedValue({ success: true, configs: {} }),
        scanAllInstalledGames: vi.fn().mockResolvedValue({ success: true, installedGames: [] }),
        detectCompatibilityLayers: vi.fn().mockResolvedValue({ success: true, layers: [] }),
        getRunningGames: vi.fn().mockResolvedValue({ success: true, runningGames: [] }),
        onGameSessionEvent: vi.fn().mockReturnValue(() => {}),
        onCompatibilityRunnerProgress: vi.fn().mockReturnValue(() => {}),
        getSavedTokens: vi.fn().mockResolvedValue({
          steam: { steamId: '76561198000000001', access_token: 'tok-steam' },
        }),
        syncStore: vi.fn().mockResolvedValue({
          success: true,
          games: [incomingGame],
        }),
      });

      vi.spyOn(integrationStorage, 'loadIntegrations').mockReturnValue([
        { storefrontId: 'steam', isConnected: true, accountName: 'SteamUser' },
      ] as ReturnType<typeof integrationStorage.loadIntegrations>);
      vi.spyOn(integrationStorage, 'saveIntegrations').mockImplementation(() => {});
      vi.spyOn(localSystemScanner, 'scanLocalInstalledGames').mockResolvedValue({
        success: true,
        installedSteamAppIds: [],
        installedGames: [],
      });
      vi.spyOn(steamAchievementsService, 'scanLocalAchievementsSingleFlight').mockResolvedValue({});
      vi.spyOn(steamAchievementsService, 'syncUserLibraryAchievements').mockResolvedValue({});
      const lsSetSpy = vi.spyOn(mockStorage, 'setItem');

      let currentGames: CanonicalGame[] = [existingGame];
      const gamesRef = { current: currentGames };
      const setGames = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        currentGames = typeof updater === 'function' ? updater(currentGames) : updater;
        gamesRef.current = currentGames;
      });
      const onCatalogPersisted = vi.fn();

      const HookProbe = (props: UseLocalInstallSyncParams) => {
        useLocalInstallSync(props);
        return null;
      };

      const harness = createDomain12DeepRenderer(HookProbe, {
        gamesRef,
        setGames,
        overlayLauncherInstalledState: (catalog) => catalog,
        showSyncNotice: vi.fn(),
        isModalOpen: false,
        isCatalogVaultHydrated: true,
        onCatalogPersisted,
      });

      harness.render();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushMicrotasks(20);

      expect(onCatalogPersisted).not.toHaveBeenCalled();
      expect(setGames).not.toHaveBeenCalled();
      expect(
        lsSetSpy.mock.calls.filter(([key]) => key === 'universal_game_library_catalog')
      ).toHaveLength(0);

      harness.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Unified Single-Flight Steam Achievement Sync (S-04)
  // ---------------------------------------------------------------------------
  describe('4. SteamAchievementsService unified single-flight startup sync (S-04)', () => {
    it('deduplicates local achievement scans and batch Web API syncs, stamps last-sync timestamp, and skips Community XML for batch-solved games', async () => {
      const localScanDeferred = createDeferred<
        Record<number, { unlocked: number; total: number; percentage: number; lastUpdated?: string }>
      >();
      const localScanSpy = vi
        .spyOn(localSystemScanner, 'scanLocalSteamAchievements')
        .mockReturnValue(localScanDeferred.promise);

      const batchDeferred = createDeferred<{
        success: boolean;
        achievements: Record<number, { unlocked: number; total: number }>;
      }>();
      const fetchSteamBatchMock = vi.fn().mockReturnValue(batchDeferred.promise);
      const fetchSteamXmlMock = vi.fn().mockResolvedValue({ success: false });

      installMockBrowserEnvironment({
        fetchSteamBatchAchievements: fetchSteamBatchMock,
        fetchSteamAchievements: fetchSteamXmlMock,
      });

      vi.spyOn(integrationStorage, 'loadIntegrations').mockReturnValue([
        { storefrontId: 'steam', isConnected: true, accountName: 'SteamUser', accountId: '76561198000000001' },
      ] as ReturnType<typeof integrationStorage.loadIntegrations>);

      // A) Concurrent local scans share a single flight
      const scanA = steamAchievementsService.scanLocalAchievementsSingleFlight();
      const scanB = steamAchievementsService.scanLocalAchievementsSingleFlight();
      localScanDeferred.resolve({ 900101: { unlocked: 4, total: 20, percentage: 20 } });
      const [resScanA, resScanB] = await Promise.all([scanA, scanB]);
      expect(localScanSpy).toHaveBeenCalledTimes(1);
      expect(resScanA[900101]?.unlocked).toBe(4);
      expect(resScanB[900101]?.unlocked).toBe(4);
      // Third call inside startup window reuses cached result
      await steamAchievementsService.scanLocalAchievementsSingleFlight();
      expect(localScanSpy).toHaveBeenCalledTimes(1);

      // B) Concurrent library syncs coalesce to 1 batch Web API call and skip Community XML for solved games
      const gameA = createSyntheticDualPlatformGame({
        id: 'steam-900101',
        steamAppId: 900101,
        platforms: [{ platformId: 'steam', platformGameId: '900101', installed: true, playtimeMinutes: 60 }],
      });
      const gameB = createSyntheticDualPlatformGame({
        id: 'steam-900102',
        title: 'Synthetic Frontier',
        steamAppId: 900102,
        platforms: [{ platformId: 'steam', platformGameId: '900102', installed: true, playtimeMinutes: 30 }],
      });

      const sync1 = steamAchievementsService.syncUserLibraryAchievements([gameA, gameB], undefined, {
        forceRefresh: false,
      });
      const sync2 = steamAchievementsService.syncUserLibraryAchievements([gameA, gameB], undefined, {
        forceRefresh: false,
      });
      batchDeferred.resolve({
        success: true,
        achievements: {
          900101: { unlocked: 12, total: 20 },
          900102: { unlocked: 5, total: 10 },
        },
      });
      await Promise.all([sync1, sync2]);

      expect(fetchSteamBatchMock).toHaveBeenCalledTimes(1);
      expect(fetchSteamXmlMock).not.toHaveBeenCalled();

      // Timestamp stamped -> subsequent non-forced startup sync is a fast no-op
      expect(mockStorage.getItem('antigravity_steam_achievements_last_sync_ts')).toBeTruthy();
      expect(steamAchievementsService.hasRecentFullSync()).toBe(true);

      await steamAchievementsService.syncUserLibraryAchievements([gameA, gameB], undefined, {
        forceRefresh: false,
      });
      expect(fetchSteamBatchMock).toHaveBeenCalledTimes(1);
    });

    it('updates antigravity_steam_achievements_last_sync_ts via ingestBatchAchievements({ markFullSyncComplete: true })', () => {
      expect(steamAchievementsService.hasRecentFullSync()).toBe(false);
      const ingested = steamAchievementsService.ingestBatchAchievements(
        { '900303': { unlocked: 8, total: 16, percentage: 50 } },
        { markFullSyncComplete: true }
      );
      expect(Object.keys(ingested)).toEqual(['900303']);
      expect(steamAchievementsService.hasRecentFullSync()).toBe(true);
      expect(steamAchievementsService.getCachedAchievements(900303)).toMatchObject({
        unlocked: 8,
        total: 16,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Post-Session Reconciler: Deduplicated Single-Game Achievement Refresh (L-06)
  // ---------------------------------------------------------------------------
  describe('5. usePostSessionReconciler deduplicated single-game achievement refresh (L-06)', () => {
    it('refreshes playtime on both stopped & playtime_synced for the same sessionId, calls single-game scoped GOG/Epic/Xbox achievement IPC once, and evicts bounded session set past 128 entries', async () => {
      const fetchGogAchievements = vi.fn().mockResolvedValue({
        success: true,
        achievements: { '900202': { unlocked: 7, total: 14 } },
      });
      const fetchEpicAchievements = vi.fn().mockResolvedValue({
        success: true,
        achievements: { 'sbx-555': { unlocked: 3, total: 10 } },
      });
      const fetchXboxAchievements = vi.fn().mockResolvedValue({
        success: true,
        achievements: { '99887766': { unlocked: 11, total: 22 } },
      });

      installMockBrowserEnvironment({
        fetchGogAchievements,
        fetchEpicAchievements,
        fetchXboxAchievements,
      });

      const gogGame = makeCanonicalGameFixture({
        id: 'gog-900202',
        title: 'Synthetic Citadel GOG',
        platforms: [{ platformId: 'gog', platformGameId: '900202', installed: true, playtimeMinutes: 100 }],
      });
      const epicGame = makeCanonicalGameFixture({
        id: 'epic-555',
        title: 'Synthetic Horizon Epic',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'synthetic-app-555',
            storefrontAppId: 'synthetic-app-555',
            namespace: 'sbx-555',
            catalogItemId: 'cat-item-555',
            installed: true,
            playtimeMinutes: 50,
          },
        ],
      });
      const xboxGame = makeCanonicalGameFixture({
        id: 'xbox-99887766',
        title: 'Synthetic Vanguard Xbox',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NBLGGH55555',
            xboxProductId: '9NBLGGH55555',
            xboxTitleId: '99887766',
            packageFamilyName: 'Synthetic.Vanguard_12345',
            installed: true,
            playtimeMinutes: 25,
          },
        ],
      });

      let currentGames: CanonicalGame[] = [gogGame, epicGame, xboxGame];
      const gamesRef = { current: currentGames };
      const setGames = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        currentGames = typeof updater === 'function' ? updater(currentGames) : updater;
        gamesRef.current = currentGames;
      });
      vi.spyOn(integrationStorage, 'saveCurrentCatalog').mockImplementation(() => {});

      const ReconcilerProbe = (props: UsePostSessionReconcilerParams) => {
        usePostSessionReconciler(props);
        return null;
      };
      const harness = createDomain12DeepRenderer(ReconcilerProbe, {
        gamesRef,
        setGames,
        showSyncNotice: vi.fn(),
      });
      harness.render();

      // A) GOG: stopped followed by playtime_synced with same sessionId -> playtime updates on both, GOG IPC called ONCE with single-game scope!
      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-gog-1',
            sessionEvent: 'stopped',
            gameId: gogGame.id,
            platformId: 'gog',
            platformGameId: '900202',
            sessionMinutesPlayed: 15,
            lastPlayed: '2026-11-20T10:00:00.000Z',
          },
        })
      );
      await flushMicrotasks();
      expect(currentGames.find((g) => g.id === gogGame.id)?.platforms[0].playtimeMinutes).toBe(115);

      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-gog-1',
            sessionEvent: 'playtime_synced',
            gameId: gogGame.id,
            platformId: 'gog',
            platformGameId: '900202',
            storefrontTotalPlaytimeMinutes: 140,
            lastPlayed: '2026-11-20T10:01:00.000Z',
          },
        })
      );
      await flushMicrotasks();

      expect(currentGames.find((g) => g.id === gogGame.id)?.platforms[0].playtimeMinutes).toBe(140);
      expect(fetchGogAchievements).toHaveBeenCalledTimes(1);
      expect(fetchGogAchievements).toHaveBeenCalledWith({
        productId: '900202',
        gameId: gogGame.id,
        title: 'Synthetic Citadel GOG',
      });

      // B) Epic: scoped single-game payload + dedupe across stopped/playtime_synced
      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-epic-1',
            sessionEvent: 'stopped',
            gameId: epicGame.id,
            platformId: 'epic',
            platformGameId: 'synthetic-app-555',
            sessionMinutesPlayed: 10,
          },
        })
      );
      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-epic-1',
            sessionEvent: 'playtime_synced',
            gameId: epicGame.id,
            platformId: 'epic',
            platformGameId: 'synthetic-app-555',
            storefrontTotalPlaytimeMinutes: 65,
          },
        })
      );
      await flushMicrotasks();

      expect(fetchEpicAchievements).toHaveBeenCalledTimes(1);
      expect(fetchEpicAchievements).toHaveBeenCalledWith({
        sandboxId: 'sbx-555',
        namespace: 'sbx-555',
        appName: 'synthetic-app-555',
        catalogItemId: 'cat-item-555',
        title: 'Synthetic Horizon Epic',
      });

      // C) Xbox: scoped single-game payload + fallback dedupe when sessionId is omitted
      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionEvent: 'stopped',
            gameId: xboxGame.id,
            platformId: 'xbox',
            platformGameId: '9NBLGGH55555',
            sessionMinutesPlayed: 5,
          },
        })
      );
      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionEvent: 'playtime_synced',
            gameId: xboxGame.id,
            platformId: 'xbox',
            platformGameId: '9NBLGGH55555',
            storefrontTotalPlaytimeMinutes: 35,
          },
        })
      );
      await flushMicrotasks();

      expect(fetchXboxAchievements).toHaveBeenCalledTimes(1);
      expect(fetchXboxAchievements).toHaveBeenCalledWith({
        titleId: '99887766',
        productId: '9NBLGGH55555',
        pfn: 'Synthetic.Vanguard_12345',
        title: 'Synthetic Vanguard Xbox',
      });

      // D) Bounded 128-session eviction: firing 129 new distinct sessions evicts 'sess-gog-1',
      // allowing 'sess-gog-1' to refresh once more without unbounded memory growth
      for (let i = 0; i < 129; i++) {
        window.dispatchEvent(
          new CustomEvent('antigravity:game-session-ended', {
            detail: {
              sessionId: `sess-evict-${i}`,
              sessionEvent: 'stopped',
              gameId: gogGame.id,
              platformId: 'gog',
              platformGameId: '900202',
              sessionMinutesPlayed: 1,
            },
          })
        );
      }
      await flushMicrotasks();
      const countBeforeReuse = fetchGogAchievements.mock.calls.length;
      window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-gog-1',
            sessionEvent: 'stopped',
            gameId: gogGame.id,
            platformId: 'gog',
            platformGameId: '900202',
            sessionMinutesPlayed: 1,
          },
        })
      );
      await flushMicrotasks();
      expect(fetchGogAchievements.mock.calls.length).toBe(countBeforeReuse + 1);

      harness.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. handleSyncCurrentGame Cover Non-Erasure (Task 4)
  // ---------------------------------------------------------------------------
  describe('6. useManualLibrarySyncActions handleSyncCurrentGame cover non-erasure (Task 4)', () => {
    it('preserves Rank 4 GOG 2:3 vertical cover via reconcileCapsuleImage when Steam 600x900 capsule is dead (never wipes capsuleImage to undefined)', async () => {
      const gogVerticalCover = 'https://images.gog-statics.com/synth-beacon-boxart-2x3.jpg';
      const dualGame = createSyntheticDualPlatformGame({
        capsuleImage: gogVerticalCover,
        headerImage: 'https://cdn.example.invalid/steam/900101/header.jpg',
      });

      vi.spyOn(igdbCoverService, 'evictCacheForGame').mockImplementation(() => {});
      vi.spyOn(localSystemScanner, 'scanLocalSteamAchievements').mockResolvedValue({});
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue({
        title: 'Synthetic Beacon Remastered',
        shortDescription: 'Updated short summary',
        detailedDescription: 'Updated rich description',
        headerImage: 'https://cdn.example.invalid/steam/900101/header-v2.jpg',
        capsuleImage: undefined, // Simulate dead Steam 600x900 vertical capsule
        developers: ['Synthetic Studio'],
        publishers: ['Synthetic Pub'],
        genres: ['Action'],
        screenshots: [],
        movies: [],
      } as unknown as Awaited<ReturnType<typeof steamApi.fetchGameMetadata>>);
      vi.spyOn(steamApi, 'fetchStoreBrowseAssets').mockResolvedValue({
        capsuleImage: undefined,
        headerImage: 'https://cdn.example.invalid/steam/900101/header-v2.jpg',
      } as unknown as Awaited<ReturnType<typeof steamApi.fetchStoreBrowseAssets>>);
      vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
      vi.spyOn(igdbCoverService, 'getGogVerticalCoverInstant').mockReturnValue(null);
      const fetchGogCoverSpy = vi
        .spyOn(igdbCoverService, 'fetchGogVerticalCover')
        .mockResolvedValue(gogVerticalCover);
      vi.spyOn(integrationStorage, 'saveCurrentCatalog').mockImplementation(() => {});

      let currentGames: CanonicalGame[] = [dualGame];
      const gamesRef = { current: currentGames };
      const setGames = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        currentGames = typeof updater === 'function' ? updater(currentGames) : updater;
        gamesRef.current = currentGames;
      });

      let latestActions!: ReturnType<typeof useManualLibrarySyncActions>;
      const ActionsProbe = (props: UseManualLibrarySyncActionsParams) => {
        latestActions = useManualLibrarySyncActions(props);
        return null;
      };

      const harness = createDomain12DeepRenderer(ActionsProbe, {
        games: currentGames,
        gamesRef,
        selectedGame: dualGame,
        isGridView: false,
        isSyncingAllMedia: false,
        setIsSyncingAllMedia: vi.fn(),
        setGames,
        setGameRefreshKey: vi.fn(),
        overlayLauncherInstalledState: (catalog) => catalog,
        showSyncNotice: vi.fn(),
      });
      harness.render();

      await latestActions.handleSyncCurrentGame();

      expect(fetchGogCoverSpy).toHaveBeenCalledWith(
        '900202',
        'Synthetic Beacon Remastered',
        expect.anything()
      );
      expect(currentGames[0].capsuleImage).toBe(gogVerticalCover);
      expect(currentGames[0].capsuleImage).not.toBeUndefined();

      // Also verify Rank 6 user manual override always wins during handleSyncCurrentGame
      const customCover = 'https://cdn.example.invalid/user/custom-boxart.png';
      saveUserOverride(
        {
          gameId: dualGame.id,
          matchedStore: 'custom',
          capsuleImage: customCover,
          updatedAt: '2026-11-20T12:00:00.000Z',
        },
        dualGame
      );
      try {
        await latestActions.handleSyncCurrentGame();
        expect(currentGames[0].capsuleImage).toBe(customCover);
      } finally {
        removeUserOverride(dualGame.id);
      }

      harness.unmount();
    });
  });
});
