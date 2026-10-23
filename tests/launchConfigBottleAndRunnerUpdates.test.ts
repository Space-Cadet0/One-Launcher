import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { CanonicalGame } from '../src/contracts/game';
import type {
  CompatibilityLayerInfo,
  RunnerUpdateInfo,
  StorefrontClientLifecyclePolicy,
} from '../src/contracts/launcher';
import type { StorefrontId } from '../src/contracts/platform';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  buildStorefrontLaunchPolicyView,
} from '../src/services/launcher/launchPolicyPreview';
import { launcherService } from '../src/services/launcher/launcherService';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';

const require = createRequire(import.meta.url);
const launcherEngine = require('../electron/launcherEngine.cjs');

const activeRenderers: { unmount: () => void }[] = [];

function createStatefulRenderer<P extends object>(
  Component: React.FC<P>,
  getProps: () => P
) {
  const states: any[] = [];
  const effectDeps: (any[] | undefined)[] = [];
  const effectCleanups: ((() => void) | undefined)[] = [];

  const renderPass = () => {
    let stateIdx = 0;
    let effectIdx = 0;
    const pendingEffects: { idx: number; fn: () => any }[] = [];

    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;
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
      useEffect(fn: () => any, deps?: any[]) {
        const idx = effectIdx++;
        const prev = effectDeps[idx];
        const changed =
          prev === undefined ||
          deps === undefined ||
          prev.length !== deps.length ||
          deps.some((d, i) => !Object.is(d, prev[i]));
        if (changed) {
          effectDeps[idx] = deps;
          pendingEffects.push({ idx, fn });
        }
      },
      useRef(initial: any) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push({ current: initial });
        }
        return states[idx];
      },
      useMemo(fn: () => any) {
        return fn();
      },
      useCallback(fn: any) {
        return fn;
      },
    };

    let vnode: any;
    let html = '';
    try {
      vnode = Component(getProps());
      html = vnode ? renderToString(vnode).replace(/<!--\s*-->/g, '') : '';
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (typeof effectCleanups[eff.idx] === 'function') {
        effectCleanups[eff.idx]!();
      }
      const cleanup = eff.fn();
      effectCleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    return { vnode, html, hadEffects: pendingEffects.length > 0 };
  };

  let latest = renderPass();
  if (latest.hadEffects) {
    latest = renderPass();
  }

  const findElements = (node: any, predicate: (el: any) => boolean): any[] => {
    const out: any[] = [];
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        n.forEach(walk);
        return;
      }
      if (predicate(n)) out.push(n);
      if (n.props?.children) walk(n.props.children);
      if (typeof n.type === 'function' && !n.type.$$typeof) {
        try {
          walk(n.type(n.props || {}));
        } catch {}
      }
    };
    walk(node);
    return out;
  };

  let unmounted = false;
  const handle = {
    get vnode() {
      return latest.vnode;
    },
    get html() {
      return latest.html;
    },
    rerender() {
      latest = renderPass();
      if (latest.hadEffects) {
        latest = renderPass();
      }
      return latest;
    },
    findElements(predicate: (el: any) => boolean) {
      return findElements(latest.vnode, predicate);
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') cleanup();
      }
    },
  };
  activeRenderers.push(handle);
  return handle;
}

const mockMacLayers: CompatibilityLayerInfo[] = [
  {
    id: 'crossover',
    type: 'crossover',
    name: 'CrossOver',
    binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    availableBottles: ['OneLauncher', 'Steam'],
    version: '26.0.0',
    buildVersion: '26.0.0.39832',
    displayVersion: '26.0.0 (Build 39832)',
  },
  {
    id: 'crossover_preview',
    type: 'crossover_preview',
    name: 'CrossOver Preview',
    binaryPath:
      '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
    availableBottles: ['OneLauncher'],
    version: '26.3.0',
    buildVersion: '26.3.0.39910',
    displayVersion: '26.3.0 (Preview 20260401)',
  },
  {
    id: 'gptk',
    type: 'gptk',
    name: 'Apple Game Porting Toolkit',
    binaryPath: '/Applications/Game Porting Toolkit.app/Contents/Resources/wine/bin/wine64',
    availableBottles: [],
    version: '3.0',
    displayVersion: '3.0',
  },
  {
    id: 'wine',
    type: 'wine',
    name: 'Open-Source Wine (Heroic)',
    binaryPath:
      '/Users/tester/Library/Application Support/heroic/tools/wine/Wine-Staging-macOS-11.2/bin/wine64',
    availableBottles: [],
    version: '11.2',
    displayVersion: '11.2',
  },
];

function createBottleGame(platformId: StorefrontId, idSuffix: string): CanonicalGame {
  return {
    id: `${platformId}-bottle-${idSuffix}`,
    title: `Bottle ${platformId.toUpperCase()} Test Game`,
    sortTitle: `Bottle ${platformId.toUpperCase()} Test Game`,
    ...(platformId === 'steam' ? { steamAppId: 1245620 } : {}),
    platforms: [
      {
        platformId,
        platformGameId: platformId === 'steam' ? '1245620' : `${platformId}_app_777`,
        installed: true,
        installPath: `/tmp/Bottles/OneLauncher/drive_c/Games/${platformId}_game`,
        executablePath: `/tmp/Bottles/OneLauncher/drive_c/Games/${platformId}_game/game.exe`,
        isWindowsBinaryOnMac: true,
      },
    ],
    headerImage: '',
    developers: ['Studio'],
    publishers: ['Publisher'],
    genres: ['Action'],
    tags: [],
  };
}

describe('Bottle Storefront Lifecycle, Cold-Bottle Startup Trade-Offs & Compatibility Runner Updates (Tasks 1–3)', () => {
  const memStorage = new Map<string, string>();
  const origLocalStorage = (globalThis as any).localStorage;
  const origWindow = (globalThis as any).window;
  const origDocument = (globalThis as any).document;

  beforeEach(() => {
    memStorage.clear();
    const mockStorage = {
      getItem: (k: string) => (memStorage.has(k) ? memStorage.get(k)! : null),
      setItem: (k: string, v: string) => {
        memStorage.set(k, String(v));
      },
      removeItem: (k: string) => {
        memStorage.delete(k);
      },
      clear: () => memStorage.clear(),
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
    if (typeof (globalThis as any).window === 'undefined') {
      Object.defineProperty(globalThis, 'window', {
        value: { localStorage: mockStorage, dispatchEvent: vi.fn() },
        configurable: true,
        writable: true,
      });
    } else {
      try {
        Object.defineProperty((globalThis as any).window, 'localStorage', {
          value: mockStorage,
          configurable: true,
          writable: true,
        });
      } catch {}
    }
    (launcherService as any).launchConfigs = {};
    (launcherService as any).perfSettings = {
      ...(launcherService as any).perfSettings,
      inGameLauncherBehavior: 'hide_tray_hibernate',
      postGameLauncherBehavior: 'restore_window',
      storefrontClientLifecycle: 'minimal_and_close_if_started',
      pauseBackgroundSyncInGame: true,
      pauseDownloadsInGame: true,
      autoShutdownWinePrefixOnExit: true,
      suppressWineDebugLogging: true,
    };
    launcherEngine.openedExternalUris.length = 0;
  });

  afterEach(() => {
    while (activeRenderers.length > 0) {
      activeRenderers.pop()?.unmount();
    }
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'localStorage', {
      value: origLocalStorage,
      configurable: true,
      writable: true,
    });
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      Object.defineProperty(globalThis, 'window', {
        value: origWindow,
        configurable: true,
        writable: true,
      });
    }
    if (origDocument !== undefined) {
      Object.defineProperty(globalThis, 'document', {
        value: origDocument,
        configurable: true,
        writable: true,
      });
    }
  });

  // ==========================================================================
  // TASK 1: Explicit Cold-Bottle Startup Time Trade-Offs (Steam, GOG, Epic)
  // ==========================================================================
  describe('Task 1: Explicit Cold-Bottle Startup Time Trade-Offs Across All Bottle Storefronts', () => {
    const bottleStorefronts: StorefrontId[] = ['steam', 'gog', 'epic'];
    const clientBootPolicies: StorefrontClientLifecyclePolicy[] = [
      'default_client',
      'minimal_keep_running',
      'minimal_and_close_if_started',
    ];

    it('includes explicit cold-bottle startup time delays in excludedOrTradeoffs for default_client, minimal_keep_running, and minimal_and_close_if_started across Bottle Steam, GOG, and Epic', () => {
      for (const platformId of bottleStorefronts) {
        for (const policy of clientBootPolicies) {
          const view = buildStorefrontLaunchPolicyView({
            platformId,
            detectedBuildType: 'windows_exe_on_mac',
            activeDisplayMethod: 'auto',
            effectiveLifecycle: policy,
            isInstalled: true,
            hostPlatform: 'darwin',
          });

          const tradeoffsText = view.infoBox.excludedOrTradeoffs.join(' ');
          expect(
            tradeoffsText,
            `${platformId} bottle policy ${policy} must mention seconds delay`
          ).toMatch(/~\d+–\d+\s+seconds/);
          expect(
            tradeoffsText.toLowerCase(),
            `${platformId} bottle policy ${policy} must mention cold bottle startup`
          ).toContain('cold bottle startup');

          if (policy === 'minimal_keep_running') {
            expect(tradeoffsText.toLowerCase()).toContain('subsequent launches');
          }
          if (policy === 'minimal_and_close_if_started') {
            expect(tradeoffsText.toLowerCase()).toContain('authenticates');
            expect(view.infoBox.includedFeatures.join(' ').toLowerCase()).toContain(
              'reclaims 100%'
            );
          }
        }
      }
    });

    it('renders cold-bottle startup trade-off copy directly inside GameLaunchConfigModal across Bottle Steam, Bottle GOG, and Bottle Epic', () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

      for (const platformId of bottleStorefronts) {
        const game = createBottleGame(platformId, 'startup-tradeoffs');
        const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
          isOpen: true,
          game,
          initialPlatformId: platformId,
          onClose: vi.fn(),
        }));

        const getLifecycleSelect = () =>
          modal.findElements(
            (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
          )[0];

        for (const policy of clientBootPolicies) {
          getLifecycleSelect().props.onChange({ target: { value: policy } });
          modal.rerender();
          expect(modal.html).toContain('cold bottle startup');
          expect(modal.html).toMatch(/~\d+–\d+\s+seconds/);
        }

        modal.unmount();
      }
    });
  });

  // ==========================================================================
  // TASK 2: Bottle GOG & Bottle Epic 4-Option Dropdown, Save/Reopen & Runtime
  // ==========================================================================
  describe('Task 2: Bottle GOG & Bottle Epic 4-Option Policy Dropdown, Save Persistence & Runtime Lifecycle', () => {
    it('renders 4-option Bottle GOG & Bottle Epic Launch Policy dropdowns, updates info boxes and footprint badges dynamically, and preserves default_client across save & reopen on Bottle GOG', async () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

      const expectedOrder = [
        'default_client',
        'minimal_keep_running',
        'minimal_and_close_if_started',
        'fast_direct_bypass',
      ];

      // 1. Bottle GOG Modal: 4 options, dynamic info box severity, badge updates, and default_client save/reopen persistence
      const gogBottleGame = createBottleGame('gog', 'persist-default-client');
      const gogModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: gogBottleGame,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      }));

      expect(gogModal.html).toContain('Bottle GOG Launch Policy Mode');
      const gogSelect = () =>
        gogModal.findElements(
          (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
        )[0];
      const gogOptions = gogModal
        .findElements((el) => el.type === 'option')
        .filter((opt) => expectedOrder.includes(opt.props.value))
        .map((opt) => opt.props.value);
      expect(gogOptions).toEqual(expectedOrder);

      // Select fast_direct_bypass on Bottle GOG -> orange warning info box (GOG Galaxy Achievements/Overlay disabled, gogdl Cloud Saves active)
      gogSelect().props.onChange({ target: { value: 'fast_direct_bypass' } });
      gogModal.rerender();
      expect(gogModal.html).toContain('data-policy-severity="warning"');
      expect(gogModal.html).toContain('gogdl');
      expect(gogModal.html).toContain('Achievements / Trophies');
      expect(gogModal.html).toContain('Max Savings • Zero-GPU + Fast Launch');

      // Select default_client on Bottle GOG -> Full Store Client badge + save & reopen persistence
      gogSelect().props.onChange({ target: { value: 'default_client' } });
      gogModal.rerender();
      expect(gogModal.html).toContain('data-policy-severity="info"');
      expect(gogModal.html).toContain('Zero-GPU Hibernation • Full Store Client');

      const saveBtn = gogModal.findElements(
        (el) => el.type === 'button' && renderToString(el).includes('Save Configuration')
      )[0];
      await saveBtn.props.onClick();
      gogModal.unmount();

      // Verify saved config in launcherService AND reopened modal preserve 'default_client' on Bottle GOG
      const reloadedCfg = launcherService.getLaunchConfig(gogBottleGame.id, 'gog');
      expect(reloadedCfg?.storefrontClientLifecycle).toBe('default_client');

      const reopenedGogModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: gogBottleGame,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      }));
      const reopenedSelect = reopenedGogModal.findElements(
        (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
      )[0];
      expect(reopenedSelect.props.value).toBe('default_client');
      expect(reopenedGogModal.html).toContain('Zero-GPU Hibernation • Full Store Client');
      reopenedGogModal.unmount();

      // 2. Bottle Epic Modal: 4 options, optimal emerald info box for fast_direct_bypass (Clientless EOS Exchange Code + legendary)
      const epicBottleGame = createBottleGame('epic', 'policy-dropdown');
      const epicModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: epicBottleGame,
        initialPlatformId: 'epic',
        onClose: vi.fn(),
      }));

      expect(epicModal.html).toContain('Bottle Epic Games Store Launch Policy Mode');
      const epicSelect = () =>
        epicModal.findElements(
          (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
        )[0];
      const epicOptions = epicModal
        .findElements((el) => el.type === 'option')
        .filter((opt) => expectedOrder.includes(opt.props.value))
        .map((opt) => opt.props.value);
      expect(epicOptions).toEqual(expectedOrder);

      epicSelect().props.onChange({ target: { value: 'fast_direct_bypass' } });
      epicModal.rerender();
      expect(epicModal.html).toContain('data-policy-severity="optimal"');
      expect(epicModal.html).toContain('EOS OAuth Exchange Code');
      expect(epicModal.html).toContain('legendary');
      expect(epicModal.html).toContain('Max Savings • Zero-GPU + Fast Launch');
      epicModal.unmount();
    });

    it('launches Bottle GOG and Bottle Epic cleanly without errors when GalaxyClient.exe / EpicGamesLauncher.exe are NOT installed in the bottle (standalone gogdl / legendary Cloud Sync)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-bottle-fresh-no-client-'));
      const userDataDir = path.join(tmpDir, 'userData');
      const homedir = path.join(tmpDir, 'home');
      const appsDir = path.join(tmpDir, 'Applications');
      const crossoverBinDir = path.join(
        appsDir,
        'CrossOver.app/Contents/SharedSupport/CrossOver/bin'
      );
      const bottlePath = path.join(
        homedir,
        'Library/Application Support/CrossOver/Bottles/OneLauncher'
      );
      const gogExe = path.join(bottlePath, 'drive_c/Games/GogFresh/game.exe');
      const epicExe = path.join(bottlePath, 'drive_c/Games/EpicFresh/game.exe');

      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(crossoverBinDir, { recursive: true });
      fs.mkdirSync(path.dirname(gogExe), { recursive: true });
      fs.mkdirSync(path.dirname(epicExe), { recursive: true });
      fs.writeFileSync(path.join(crossoverBinDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(crossoverBinDir, 'wineserver'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(bottlePath, 'cxbottle.conf'), '[Bottle]\n', 'utf8');
      fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

      const peBuf = Buffer.alloc(128);
      peBuf.write('MZ', 0, 'ascii');
      fs.writeFileSync(gogExe, peBuf);
      fs.writeFileSync(epicExe, peBuf);

      launcherEngine.setUserDataDir(userDataDir);

      const activePids = new Set<number>();
      let nextPid = 81000;
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
        const absPid = Math.abs(Number(pid));
        if (sig === 0) {
          if (activePids.has(absPid)) return true;
          const err: any = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        activePids.delete(absPid);
        return true;
      }) as any);

      const bottleClientSpawns: { cmd: string; args: string[] }[] = [];
      const bottleClientSpawnFn = vi.fn((cmd: string, args: string[]) => {
        bottleClientSpawns.push({ cmd, args });
        const proc: any = new EventEmitter();
        proc.pid = nextPid++;
        proc.unref = vi.fn();
        return proc;
      });
      const gameSpawnFn = vi.fn(() => {
        const pid = nextPid++;
        activePids.add(pid);
        const proc: any = new EventEmitter();
        proc.pid = pid;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.unref = vi.fn();
        proc.kill = vi.fn(() => {
          activePids.delete(pid);
          proc.emit('exit', 0, null);
          return true;
        });
        return proc;
      });
      const execFileImpl = vi.fn((_cmd: string, _args: string[], opts: any, cb?: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        callback?.(null, '', '');
      });

      try {
        const baseOpts = {
          platform: 'darwin',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipAuthRefresh: true,
          spawnFn: gameSpawnFn,
          gameSpawnFn,
          bottleClientSpawnFn,
          execFileImpl,
          wineCleanupSettleMs: 5,
          awaitPostSessionBarrier: true,
        };

        for (const [platformId, exePath, gameId] of [
          ['gog', gogExe, 'gog-fresh-test'],
          ['epic', epicExe, 'epic-fresh-test'],
        ] as const) {
          const res = await launcherEngine.launchGame(
            {
              gameId,
              title: `${platformId.toUpperCase()} Fresh Bottle Game`,
              platformId,
              platformGameId: `${platformId}_fresh_1`,
              installPath: path.dirname(exePath),
              executablePath: exePath,
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'OneLauncher',
              storefrontClientLifecycle: 'minimal_and_close_if_started',
            },
            baseOpts
          );
          expect(res.success).toBe(true);
          expect(bottleClientSpawns.length).toBe(0);

          const stopRes = await launcherEngine.stopGame({ gameId }, baseOpts);
          expect(stopRes.success).toBe(true);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('enforces all 4 Bottle GOG & Bottle Epic client lifecycle policies when GalaxyClient.exe and EpicGamesLauncher.exe exist in the bottle', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-bottle-populated-clients-'));
      const userDataDir = path.join(tmpDir, 'userData');
      const homedir = path.join(tmpDir, 'home');
      const appsDir = path.join(tmpDir, 'Applications');
      const crossoverBinDir = path.join(
        appsDir,
        'CrossOver.app/Contents/SharedSupport/CrossOver/bin'
      );
      const bottlePath = path.join(
        homedir,
        'Library/Application Support/CrossOver/Bottles/OneLauncher'
      );
      const bottleGogExe = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/GOG Galaxy/GalaxyClient.exe'
      );
      const bottleEpicExe = path.join(
        bottlePath,
        'drive_c/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe'
      );
      const gogGameExe = path.join(bottlePath, 'drive_c/Games/GogPopulated/game.exe');
      const epicGameExe = path.join(bottlePath, 'drive_c/Games/EpicPopulated/game.exe');

      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(crossoverBinDir, { recursive: true });
      fs.mkdirSync(path.dirname(bottleGogExe), { recursive: true });
      fs.mkdirSync(path.dirname(bottleEpicExe), { recursive: true });
      fs.mkdirSync(path.dirname(gogGameExe), { recursive: true });
      fs.mkdirSync(path.dirname(epicGameExe), { recursive: true });

      fs.writeFileSync(path.join(crossoverBinDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(crossoverBinDir, 'wineserver'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(bottlePath, 'cxbottle.conf'), '[Bottle]\n', 'utf8');
      fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

      const peBuf = Buffer.alloc(128);
      peBuf.write('MZ', 0, 'ascii');
      fs.writeFileSync(bottleGogExe, peBuf);
      fs.writeFileSync(bottleEpicExe, peBuf);
      fs.writeFileSync(gogGameExe, peBuf);
      fs.writeFileSync(epicGameExe, peBuf);

      launcherEngine.setUserDataDir(userDataDir);

      const activePids = new Set<number>();
      let nextPid = 82000;
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
        const absPid = Math.abs(Number(pid));
        if (sig === 0) {
          if (activePids.has(absPid)) return true;
          const err: any = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        activePids.delete(absPid);
        return true;
      }) as any);

      try {
        const runScenario = async (
          platformId: 'gog' | 'epic',
          policy: StorefrontClientLifecyclePolicy
        ) => {
          const clientSpawns: { cmd: string; args: string[] }[] = [];
          const execCalls: { cmd: string; args: string[] }[] = [];
          const prefixShutdowns: string[] = [];

          const bottleClientSpawnFn = vi.fn((cmd: string, args: string[]) => {
            clientSpawns.push({ cmd, args });
            const proc: any = new EventEmitter();
            proc.pid = nextPid++;
            proc.unref = vi.fn();
            return proc;
          });
          const gameSpawnFn = vi.fn(() => {
            const pid = nextPid++;
            activePids.add(pid);
            const proc: any = new EventEmitter();
            proc.pid = pid;
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.unref = vi.fn();
            proc.kill = vi.fn(() => {
              activePids.delete(pid);
              proc.emit('exit', 0, null);
              return true;
            });
            return proc;
          });
          const execFileImpl = vi.fn((cmd: string, args: string[], opts: any, cb?: any) => {
            const callback = typeof opts === 'function' ? opts : cb;
            execCalls.push({ cmd, args: Array.isArray(args) ? args : [] });
            callback?.(null, '', '');
          });

          const gameExe = platformId === 'gog' ? gogGameExe : epicGameExe;
          const gameId = `${platformId}-bottle-${policy}`;
          const opts = {
            platform: 'darwin',
            homedir,
            userDataDir,
            customApplicationsDir: appsDir,
            skipAuthRefresh: true,
            spawnFn: gameSpawnFn,
            gameSpawnFn,
            bottleClientSpawnFn,
            execFileImpl,
            wineCleanupSettleMs: 5,
            awaitPostSessionBarrier: true,
            onWinePrefixShutdown: (prefix: string) => prefixShutdowns.push(prefix),
          };

          const launchRes = await launcherEngine.launchGame(
            {
              gameId,
              title: `${platformId} ${policy}`,
              platformId,
              platformGameId: `${platformId}_id_${policy}`,
              installPath: path.dirname(gameExe),
              executablePath: gameExe,
              isWindowsBinaryOnMac: true,
              launchConfig: {
                gameId,
                launchMethod: 'compatibility_layer',
                compatibilityLayer: 'crossover',
                wineBottleName: 'OneLauncher',
                storefrontClientLifecycle: policy,
              },
            },
            opts
          );
          expect(launchRes.success).toBe(true);

          const stopRes = await launcherEngine.stopGame({ gameId }, opts);
          expect(stopRes.success).toBe(true);

          return { clientSpawns, execCalls, prefixShutdowns };
        };

        // 1. Bottle GOG across all 4 policies
        const gogClose = await runScenario('gog', 'minimal_and_close_if_started');
        expect(gogClose.clientSpawns).toHaveLength(1);
        expect(gogClose.clientSpawns[0].args).toEqual([bottleGogExe, '/deactivated']);
        expect(
          gogClose.execCalls.some(
            (c) => c.args.includes(bottleGogExe) && c.args.includes('/command=shutdown')
          )
        ).toBe(true);
        expect(gogClose.prefixShutdowns).toContain(bottlePath);

        const gogKeep = await runScenario('gog', 'minimal_keep_running');
        expect(gogKeep.clientSpawns).toHaveLength(1);
        expect(gogKeep.clientSpawns[0].args).toEqual([bottleGogExe, '/deactivated']);
        expect(
          gogKeep.execCalls.some((c) => c.args.includes('/command=shutdown'))
        ).toBe(false);
        expect(gogKeep.prefixShutdowns).toHaveLength(0);

        const gogFull = await runScenario('gog', 'default_client');
        expect(gogFull.clientSpawns).toHaveLength(1);
        expect(gogFull.clientSpawns[0].args).toEqual([bottleGogExe]);
        expect(
          gogFull.execCalls.some((c) => c.args.includes('/command=shutdown'))
        ).toBe(false);
        expect(gogFull.prefixShutdowns).toHaveLength(0);

        const gogBypass = await runScenario('gog', 'fast_direct_bypass');
        expect(gogBypass.clientSpawns).toHaveLength(0);
        expect(gogBypass.prefixShutdowns).toContain(bottlePath);

        // 2. Bottle Epic across all 4 policies
        const epicClose = await runScenario('epic', 'minimal_and_close_if_started');
        expect(epicClose.clientSpawns).toHaveLength(1);
        expect(epicClose.clientSpawns[0].args).toEqual([bottleEpicExe, '-silent']);
        expect(
          epicClose.execCalls.some(
            (c) => c.args.includes('taskkill') && c.args.includes('EpicGamesLauncher.exe')
          )
        ).toBe(true);
        expect(epicClose.prefixShutdowns).toContain(bottlePath);

        const epicKeep = await runScenario('epic', 'minimal_keep_running');
        expect(epicKeep.clientSpawns).toHaveLength(1);
        expect(epicKeep.clientSpawns[0].args).toEqual([bottleEpicExe, '-silent']);
        expect(
          epicKeep.execCalls.some((c) => c.args.includes('EpicGamesLauncher.exe'))
        ).toBe(false);
        expect(epicKeep.prefixShutdowns).toHaveLength(0);

        const epicFull = await runScenario('epic', 'default_client');
        expect(epicFull.clientSpawns).toHaveLength(1);
        expect(epicFull.clientSpawns[0].args).toEqual([bottleEpicExe]);
        expect(
          epicFull.execCalls.some((c) => c.args.includes('EpicGamesLauncher.exe'))
        ).toBe(false);
        expect(epicFull.prefixShutdowns).toHaveLength(0);

        const epicBypass = await runScenario('epic', 'fast_direct_bypass');
        expect(epicBypass.clientSpawns).toHaveLength(0);
        expect(epicBypass.prefixShutdowns).toContain(bottlePath);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================================================
  // TASK 3: CrossOver Preview & All Compatibility Runner Update Checks/Updaters
  // ==========================================================================
  describe('Task 3: CrossOver Preview & Compatibility Runner Update Checks and Updaters', () => {
    it('hides update-runner-btn when CrossOver Preview is up to date (updateAvailable: false) and renders update-runner-btn when updateAvailable: true', () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);

      const upToDateMap: Partial<Record<string, RunnerUpdateInfo>> = {
        crossover_preview: {
          runnerType: 'crossover_preview',
          installed: true,
          installedVersion: '26.3.0',
          latestVersion: '26.3.0',
          updateAvailable: false,
          downloadUrl: 'https://www.codeweavers.com/preview/download',
          canAutoUpdate: true,
          updateMethod: 'vendor_portal',
          statusMessage: 'Up to date (26.3.0)',
          checkedAt: new Date().toISOString(),
        },
      };
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue(upToDateMap as any);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue(
        upToDateMap as any
      );

      const game = createBottleGame('steam', 'crossover-preview-btn');
      const modalUpToDate = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      }));

      // Switch Compatibility Runner dropdown to crossover_preview
      modalUpToDate
        .findElements((el) => el.props?.['data-testid'] === 'compat-runner-select')[0]
        .props.onChange({ target: { value: 'crossover_preview' } });
      modalUpToDate.rerender();

      expect(modalUpToDate.html).toContain('data-testid="runner-up-to-date-badge"');
      expect(modalUpToDate.html).not.toContain('data-testid="update-runner-btn"');
      expect(modalUpToDate.html).not.toContain('Update Preview Build');
      modalUpToDate.unmount();

      // Now simulate an actual update available for crossover_preview
      const updateAvailMap: Partial<Record<string, RunnerUpdateInfo>> = {
        crossover_preview: {
          runnerType: 'crossover_preview',
          installed: true,
          installedVersion: '26.0.0',
          latestVersion: '26.4.0',
          updateAvailable: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download',
          canAutoUpdate: true,
          updateMethod: 'vendor_portal',
          statusMessage: 'Update available: 26.4.0',
          checkedAt: new Date().toISOString(),
        },
      };
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue(updateAvailMap as any);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue(
        updateAvailMap as any
      );

      const modalNeedsUpdate = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      }));
      modalNeedsUpdate
        .findElements((el) => el.props?.['data-testid'] === 'compat-runner-select')[0]
        .props.onChange({ target: { value: 'crossover_preview' } });
      modalNeedsUpdate.rerender();

      expect(modalNeedsUpdate.html).toContain('data-testid="runner-update-available-badge"');
      expect(modalNeedsUpdate.html).toContain('data-testid="update-runner-btn"');
      expect(modalNeedsUpdate.html).toContain('Update to v26.4.0');
      modalNeedsUpdate.unmount();
    });

    it('uses https://www.codeweavers.com/preview/download consistently across COMPATIBILITY_RUNNER_DESCRIPTORS, checkCompatibilityLayerUpdates, updateCompatibilityLayer, and installCompatibilityLayer', async () => {
      const expectedPreviewUrl = 'https://www.codeweavers.com/preview/download';

      // 1. COMPATIBILITY_RUNNER_DESCRIPTORS
      const previewDesc = COMPATIBILITY_RUNNER_DESCRIPTORS.find(
        (d) => d.type === 'crossover_preview'
      );
      expect(previewDesc?.downloadUrl).toBe(expectedPreviewUrl);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-preview-url-audit-'));
      const homedir = path.join(tmpDir, 'home');
      const appsDir = path.join(tmpDir, 'Applications');
      const previewBinDir = path.join(
        appsDir,
        'CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin'
      );
      fs.mkdirSync(previewBinDir, { recursive: true });
      fs.writeFileSync(path.join(previewBinDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.mkdirSync(path.join(appsDir, 'CrossOver Preview.app/Contents'), { recursive: true });
      fs.writeFileSync(
        path.join(appsDir, 'CrossOver Preview.app/Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>26.3.0</string>
  <key>CFBundleVersion</key><string>26.3.0.39910</string>
</dict></plist>`,
        'utf8'
      );

      try {
        const opts = {
          platform: 'darwin',
          homedir,
          customApplicationsDir: appsDir,
          skipNetwork: true,
        };

        // 2. checkCompatibilityLayerUpdates
        const updates = await launcherEngine.checkCompatibilityLayerUpdates(opts);
        expect(updates.crossover_preview.downloadUrl).toBe(expectedPreviewUrl);
        expect(updates.crossover_preview.updateAvailable).toBe(false);

        // 3. updateCompatibilityLayer (opens official download URL & reports updated: false when version unchanged)
        launcherEngine.openedExternalUris.length = 0;
        const updRes = await launcherEngine.updateCompatibilityLayer(
          { runnerType: 'crossover_preview' },
          opts
        );
        expect(updRes.openedExternalUrl).toBe(true);
        expect(updRes.updated).toBe(false);
        expect(launcherEngine.openedExternalUris).toContain(expectedPreviewUrl);

        // 4. installCompatibilityLayer (mode: 'download')
        launcherEngine.openedExternalUris.length = 0;
        const instRes = await launcherEngine.installCompatibilityLayer(
          { runnerType: 'crossover_preview', mode: 'download' },
          opts
        );
        expect(instRes.openedExternalInstaller).toBe(true);
        expect(launcherEngine.openedExternalUris).toContain(expectedPreviewUrl);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('compares pre-release and 4-segment build runner versions accurately in compareRunnerVersions', () => {
      const { compareRunnerVersions } = launcherEngine;
      expect(compareRunnerVersions('3.0b3', '3.0')).toBe(-1);
      expect(compareRunnerVersions('3.0b3', '3.0.3')).toBe(-1);
      expect(compareRunnerVersions('3.0b3', '3.0b4')).toBe(-1);
      expect(compareRunnerVersions('3.0rc1', '3.0b9')).toBe(1);
      expect(compareRunnerVersions('3.0', '3.0rc2')).toBe(1);
      expect(compareRunnerVersions('26.3.0.39832', '26.3.0.39900')).toBe(-1);
      expect(compareRunnerVersions('26.3.0.39900', '26.3.0.39832')).toBe(1);
      expect(compareRunnerVersions('26.0.0', '26.0')).toBe(0);
    });

    it('prefers Heroic unified WoW64 Wine-Staging over retired Wine-Crossover in detectCompatibilityLayers and matches variant-specific Wine feeds in checkCompatibilityLayerUpdates', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-wine-variants-audit-'));
      const homedir = path.join(tmpDir, 'home');
      const appsDir = path.join(tmpDir, 'Applications');
      const heroicWineDir = path.join(
        homedir,
        'Library/Application Support/heroic/tools/wine'
      );

      const retiredDir = path.join(heroicWineDir, 'Wine-Crossover-macOS-23.7.1/bin');
      const stagingOldDir = path.join(heroicWineDir, 'Wine-Staging-macOS-10.4/bin');
      const stagingNewDir = path.join(heroicWineDir, 'Wine-Staging-macOS-11.2/bin');

      fs.mkdirSync(retiredDir, { recursive: true });
      fs.mkdirSync(stagingOldDir, { recursive: true });
      fs.mkdirSync(stagingNewDir, { recursive: true });
      fs.mkdirSync(appsDir, { recursive: true });

      fs.writeFileSync(path.join(retiredDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(stagingOldDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(stagingNewDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      try {
        const layers = launcherEngine.detectCompatibilityLayers({
          platform: 'darwin',
          homedir,
          customApplicationsDir: appsDir,
        });
        const wineLayer = layers.find((l: any) => l.type === 'wine');
        expect(wineLayer).toBeDefined();
        expect(wineLayer.binaryPath).toContain('Wine-Staging-macOS-11.2');
        expect(wineLayer.binaryPath).not.toContain('Wine-Crossover');

        // 1. Heroic Wine-Staging -> queries Gcenx/macOS_Wine_builds/releases/latest ('vendor_portal')
        const requestedUrls: string[] = [];
        const heroicCheck = await launcherEngine.checkCompatibilityLayerUpdates({
          layers: [
            {
              id: 'wine',
              type: 'wine',
              name: 'Open-Source Wine (Heroic)',
              binaryPath: path.join(stagingOldDir, 'wine64'),
              version: '10.4',
              displayVersion: '10.4',
            },
          ],
          httpGetText: async (url: string) => {
            requestedUrls.push(url);
            if (url.includes('Gcenx/macOS_Wine_builds/releases/latest')) {
              return JSON.stringify({
                tag_name: 'v11.2',
                html_url: 'https://github.com/Gcenx/macOS_Wine_builds/releases/tag/v11.2',
              });
            }
            return null;
          },
        });
        expect(
          requestedUrls.some((u) => u.includes('Gcenx/macOS_Wine_builds/releases/latest'))
        ).toBe(true);
        expect(heroicCheck.wine.updateAvailable).toBe(true);
        expect(heroicCheck.wine.latestVersion).toBe('11.2');
        expect(heroicCheck.wine.updateMethod).toBe('vendor_portal');

        // 2. Retired Wine-CrossOver -> skips Wine feed completely & reports updateAvailable: false
        requestedUrls.length = 0;
        const retiredCheck = await launcherEngine.checkCompatibilityLayerUpdates({
          layers: [
            {
              id: 'wine',
              type: 'wine',
              name: 'Open-Source Wine (Wine-CrossOver)',
              binaryPath: '/Applications/Wine Crossover.app/Contents/Resources/wine/bin/wine64',
              appPath: '/Applications/Wine Crossover.app',
              version: '23.7.1',
              displayVersion: '23.7.1',
            },
          ],
          httpGetText: async (url: string) => {
            requestedUrls.push(url);
            return null;
          },
        });
        expect(
          requestedUrls.some(
            (u) => u.includes('formulae.brew.sh') || u.includes('macOS_Wine_builds')
          )
        ).toBe(false);
        expect(retiredCheck.wine.updateAvailable).toBe(false);

        // 3. Homebrew Wine Staging.app -> queries wine@staging.json ('homebrew_cask')
        requestedUrls.length = 0;
        const brewStagingCheck = await launcherEngine.checkCompatibilityLayerUpdates({
          layers: [
            {
              id: 'wine',
              type: 'wine',
              name: 'Open-Source Wine (Wine Staging)',
              binaryPath: '/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine64',
              appPath: '/Applications/Wine Staging.app',
              version: '10.0',
              displayVersion: '10.0',
            },
          ],
          httpGetText: async (url: string) => {
            requestedUrls.push(url);
            if (url.includes('formulae.brew.sh/api/cask/wine@staging.json')) {
              return JSON.stringify({
                version: '11.4',
                url: 'https://github.com/Gcenx/macOS_Wine_builds/releases',
              });
            }
            return null;
          },
        });
        expect(
          requestedUrls.some((u) => u.includes('formulae.brew.sh/api/cask/wine@staging.json'))
        ).toBe(true);
        expect(brewStagingCheck.wine.updateAvailable).toBe(true);
        expect(brewStagingCheck.wine.latestVersion).toBe('11.4');
        expect(brewStagingCheck.wine.updateMethod).toBe('homebrew_cask');

        // 4. Homebrew Wine Stable.app -> queries wine-stable.json ('homebrew_cask')
        requestedUrls.length = 0;
        const brewStableCheck = await launcherEngine.checkCompatibilityLayerUpdates({
          layers: [
            {
              id: 'wine',
              type: 'wine',
              name: 'Open-Source Wine (Wine Stable)',
              binaryPath: '/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64',
              appPath: '/Applications/Wine Stable.app',
              version: '9.0',
              displayVersion: '9.0',
            },
          ],
          httpGetText: async (url: string) => {
            requestedUrls.push(url);
            if (url.includes('formulae.brew.sh/api/cask/wine-stable.json')) {
              return JSON.stringify({
                version: '10.0',
                url: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
              });
            }
            return null;
          },
        });
        expect(
          requestedUrls.some((u) => u.includes('formulae.brew.sh/api/cask/wine-stable.json'))
        ).toBe(true);
        expect(brewStableCheck.wine.updateAvailable).toBe(true);
        expect(brewStableCheck.wine.latestVersion).toBe('10.0');
        expect(brewStableCheck.wine.updateMethod).toBe('homebrew_cask');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('upgrades Wine Staging via --cask --no-quarantine wine@staging and reports updated: true when version advances', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-wine-staging-upgrade-'));
      const homedir = path.join(tmpDir, 'home');
      const appsDir = path.join(tmpDir, 'Applications');
      const wineAppDir = path.join(appsDir, 'Wine Staging.app/Contents');
      const wineBinDir = path.join(wineAppDir, 'Resources/wine/bin');
      fs.mkdirSync(wineBinDir, { recursive: true });
      fs.writeFileSync(path.join(wineBinDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(wineAppDir, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>10.0</string>
</dict></plist>`,
        'utf8'
      );

      try {
        const brewCalls: string[][] = [];
        const updRes = await launcherEngine.updateCompatibilityLayer(
          { runnerType: 'wine' },
          {
            platform: 'darwin',
            homedir,
            customApplicationsDir: appsDir,
            skipNetwork: true,
            onExecBrew: async (_brewBin: string, args: string[]) => {
              brewCalls.push(args);
              fs.writeFileSync(
                path.join(wineAppDir, 'Info.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>11.4</string>
</dict></plist>`,
                'utf8'
              );
            },
          }
        );

        expect(brewCalls).toEqual([['upgrade', '--cask', '--no-quarantine', 'wine@staging']]);
        expect(updRes.updated).toBe(true);
        expect(updRes.openedExternalUrl).toBe(false);
        expect(updRes.previousVersion).toBe('10.0');
        expect(updRes.newVersion).toBe('11.4');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
