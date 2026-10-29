import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { CanonicalGame } from '../src/contracts/game';
import {
  resolveEffectiveLaunchPolicy,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  resolveEffectiveLifecyclePolicy,
  type LaunchPolicyBuildType,
} from '../src/contracts/launchPolicyResolver';
import type {
  CompatibilityLayerInfo,
  LaunchMethod,
  StorefrontClientLifecyclePolicy,
} from '../src/contracts/launcher';
import type { StorefrontId } from '../src/contracts/platform';
import {
  buildEffectiveLaunchModePreview,
  buildStorefrontLaunchPolicyView,
  computeFastMinimalLaunchAdvisory,
} from '../src/services/launcher/launchPolicyPreview';
import { sanitizeStorefrontLifecycleOverride } from '../src/services/launcher/launchConfigStore';
import { launcherService } from '../src/services/launcher/launcherService';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { acquireModalOverlayLock, isModalOverlayOpen } from '../src/utils/modalOverlayLock';

const require = createRequire(import.meta.url);
const cjsPolicyResolver = require('../electron/launcher/launchPolicyResolver.cjs');
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
    id: 'crossover-26',
    type: 'crossover',
    name: 'CrossOver',
    binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    availableBottles: ['OneLauncher', 'Steam', 'CustomBottle'],
    version: '26.0.0',
  },
  {
    id: 'apple-gptk',
    type: 'gptk',
    name: 'Apple Game Porting Toolkit',
    binaryPath: '/usr/local/bin/gameportingtoolkit',
    availableBottles: ['GPTKBottle'],
    version: '2.0',
  },
];

function createMockGame(overrides: Partial<CanonicalGame> & { platforms: CanonicalGame['platforms'] }): CanonicalGame {
  return {
    id: overrides.id || 'test-game-id',
    title: overrides.title || 'Test Game Title',
    sortTitle: overrides.sortTitle || overrides.title || 'Test Game Title',
    steamAppId: overrides.steamAppId,
    platforms: overrides.platforms,
    headerImage: '',
    developers: ['Studio'],
    publishers: ['Publisher'],
    genres: ['Action'],
    tags: [],
  };
}

describe('Launch & Compatibility Settings 6-Task Overhaul — Comprehensive QA & Regression Suite', () => {
  const memStorage = new Map<string, string>();
  const origLocalStorage = (globalThis as any).localStorage;
  const origWindow = (globalThis as any).window;
  const origDocument = (globalThis as any).document;

  beforeEach(() => {
    memStorage.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (memStorage.has(k) ? memStorage.get(k)! : null),
      setItem: (k: string, v: string) => {
        memStorage.set(k, String(v));
      },
      removeItem: (k: string) => {
        memStorage.delete(k);
      },
      clear: () => memStorage.clear(),
    };

    const attrs = new Map<string, string>();
    (globalThis as any).document = {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, String(v)),
        getAttribute: (k: string) => attrs.get(k) ?? null,
        removeAttribute: (k: string) => attrs.delete(k),
      },
    };

    (globalThis as any).window = {
      localStorage: (globalThis as any).localStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      electronAPI: undefined,
    };

    (launcherService as any).launchConfigs?.clear?.();
    (launcherService as any).installedStorefrontClients = {};
  });

  afterEach(() => {
    while (activeRenderers.length > 0) {
      activeRenderers.pop()?.unmount();
    }
    vi.restoreAllMocks();
    (globalThis as any).localStorage = origLocalStorage;
    (globalThis as any).window = origWindow;
    (globalThis as any).document = origDocument;
  });

  // ============================================================================
  // TASK 1: Bottle Mode Selector & TS === CJS Shared Policy Resolver Lockstep
  // ============================================================================
  describe('Task 1: Bottle Mode Selector (Auto vs Custom Compatibility Runner & Bottle) & TS/CJS Lockstep', () => {
    it('sanitizes legacy launchMethod="custom" to "auto" and maintains 100% lockstep between TypeScript and CommonJS resolvers across the full combinatorial matrix', () => {
      expect(sanitizeLaunchMethod('custom')).toBe('auto');
      expect(cjsPolicyResolver.sanitizeLaunchMethod('custom')).toBe('auto');
      expect(sanitizeLaunchMethod(undefined)).toBe('auto');
      expect(cjsPolicyResolver.sanitizeLaunchMethod(undefined)).toBe('auto');

      const platforms: StorefrontId[] = ['steam', 'gog', 'epic', 'custom'];
      const hosts: ('darwin' | 'win32')[] = ['darwin', 'win32'];
      const buildTypes: LaunchPolicyBuildType[] = [
        'mac_native_app',
        'mac_native_bin',
        'windows_exe_on_mac',
        'windows_native',
        'not_installed',
      ];
      const launchMethods = ['auto', 'direct', 'storefront_uri', 'compatibility_layer', 'custom'];
      const lifecycles: ('default' | StorefrontClientLifecyclePolicy)[] = [
        'default',
        'minimal_and_close_if_started',
        'minimal_keep_running',
        'default_client',
        'fast_direct_bypass',
      ];

      let checkedCount = 0;
      for (const platformId of platforms) {
        for (const hostPlatform of hosts) {
          for (const detectedBuildType of buildTypes) {
            for (const configuredLaunchMethod of launchMethods) {
              for (const storefrontClientLifecycle of lifecycles) {
                for (const usesGalaxySdk of [false, true]) {
                  const input = {
                    platformId,
                    hostPlatform,
                    detectedBuildType,
                    isInstalled: detectedBuildType !== 'not_installed',
                    hasExecutable: detectedBuildType !== 'not_installed',
                    configuredLaunchMethod,
                    storefrontClientLifecycle,
                    globalStorefrontLifecycle: 'minimal_and_close_if_started' as const,
                    usesGalaxySdk,
                  };
                  const tsRes = resolveEffectiveLaunchPolicy(input);
                  const cjsRes = cjsPolicyResolver.resolveEffectiveLaunchPolicy(input);
                  expect(cjsRes).toEqual(tsRes);
                  expect(
                    cjsPolicyResolver.sanitizeStorefrontLifecyclePolicy(storefrontClientLifecycle)
                  ).toBe(sanitizeStorefrontLifecyclePolicy(storefrontClientLifecycle));
                  expect(
                    cjsPolicyResolver.resolveEffectiveLifecyclePolicy(
                      storefrontClientLifecycle,
                      'minimal_keep_running'
                    )
                  ).toBe(
                    resolveEffectiveLifecyclePolicy(
                      storefrontClientLifecycle,
                      'minimal_keep_running'
                    )
                  );
                  checkedCount++;
                }
              }
            }
          }
        }
      }
      expect(checkedCount).toBe(2000);
    });

    it('preserves Auto-Detect Compatibility Pipeline when editing runner or bottle in GameLaunchConfigModal, and only pins compatibility_layer when explicitly selected', async () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({
        steam: true,
        gog: true,
        epic: true,
      });

      const bottleGame = createMockGame({
        id: 'bottle-task1-game',
        title: 'Bottle Pipeline Verification',
        steamAppId: 1091500,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
            installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/BottleGame',
            executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/BottleGame/game.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
      });

      let savedPayload: any = null;
      const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: bottleGame,
        initialPlatformId: 'steam' as const,
        onClose: vi.fn(),
        onSaved: (cfg) => {
          savedPayload = cfg;
        },
      }));

      // Only 2 modes exposed on macOS Bottle: auto & compatibility_layer
      const modeButtons = modal.findElements((el) => Boolean(el.props?.['data-launch-mode']));
      expect(modeButtons.map((b) => b.props['data-launch-mode'])).toEqual([
        'auto',
        'compatibility_layer',
      ]);
      expect(modal.html).toContain('Auto-Detect Runner');

      // Changing runner or bottle while in 'auto' mode MUST stay in 'auto'
      const getActiveMode = () =>
        modal.findElements(
          (el) => Boolean(el.props?.['data-launch-mode']) && el.props?.['aria-pressed'] === true
        )[0]?.props?.['data-launch-mode'];

      expect(getActiveMode()).toBe('auto');

      modal
        .findElements((el) => el.props?.['data-testid'] === 'compat-runner-select')[0]
        .props.onChange({ target: { value: 'crossover' } });
      modal.rerender();
      expect(getActiveMode()).toBe('auto');

      modal
        .findElements((el) => el.props?.['aria-label'] === 'Target Bottle Name')[0]
        .props.onChange({ target: { value: 'CustomBottle' } });
      modal.rerender();
      expect(getActiveMode()).toBe('auto');
      expect(modal.html).toContain('Auto-Detect Runner');

      // Explicitly clicking 'compatibility_layer' pins Custom Runner & Bottle
      modal
        .findElements((el) => el.props?.['data-launch-mode'] === 'compatibility_layer')[0]
        .props.onClick();
      modal.rerender();
      expect(getActiveMode()).toBe('compatibility_layer');
      expect(modal.html).toContain('Custom Runner Pinned');

      const saveBtn = modal.findElements(
        (el) => el.type === 'button' && renderToString(el).includes('Save Configuration')
      )[0];
      await saveBtn.props.onClick();
      expect(savedPayload?.launchMethod).toBe('compatibility_layer');
      expect(savedPayload?.wineBottleName).toBe('CustomBottle');
      modal.unmount();
    });
  });

  // ============================================================================
  // TASK 2: Native Mode Selector (2-Mode Model Without Redundant Auto + Uninstalled Client Grey-Out)
  // ============================================================================
  describe('Task 2: Native Mode Selector (macOS & Windows Parity + Uninstalled Desktop Client Grey-Out)', () => {
    it('enforces exact 2-mode native ordering (Steam: [storefront_uri, direct]; GOG/Epic: [direct, storefront_uri]; Custom: [direct]) across darwin and win32 without Auto', () => {
      for (const hostPlatform of ['darwin', 'win32'] as const) {
        const exeSuffix = hostPlatform === 'win32' ? 'C:\\Games\\Sample\\game.exe' : '/Applications/Sample.app';

        // 1. Steam Native -> ['storefront_uri', 'direct'], default 'storefront_uri'
        const steamGame = createMockGame({
          id: `steam-native-${hostPlatform}`,
          steamAppId: 620,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '620',
              installed: true,
              installPath: exeSuffix,
              executablePath: exeSuffix,
            },
          ],
        });
        const steamPreview = buildEffectiveLaunchModePreview({
          game: steamGame,
          hostPlatform,
          preferredPlatformId: 'steam',
          effPlatform: steamGame.platforms[0],
          layers: mockMacLayers,
          globalStorefrontLifecycle: 'minimal_and_close_if_started',
          installedStorefrontClients: { steam: true, gog: true, epic: true },
        });
        expect(steamPreview.availableModes).toEqual(['storefront_uri', 'direct']);
        expect(steamPreview.availableModes).not.toContain('auto');
        expect(steamPreview.defaultLaunchMethod).toBe('storefront_uri');
        expect(steamPreview.modeNotes.storefront_uri.badge).toBe('Recommended');
        expect(steamPreview.modeNotes.storefront_uri.disabled).toBeFalsy();

        // 2. GOG & Epic Native -> ['direct', 'storefront_uri'], default 'direct'
        for (const store of ['gog', 'epic'] as const) {
          const storeGame = createMockGame({
            id: `${store}-native-${hostPlatform}`,
            platforms: [
              {
                platformId: store,
                platformGameId: store === 'gog' ? '1207658924' : 'SampleEpicId',
                installed: true,
                installPath: exeSuffix,
                executablePath: exeSuffix,
              },
            ],
          });
          const storePreview = buildEffectiveLaunchModePreview({
            game: storeGame,
            hostPlatform,
            preferredPlatformId: store,
            effPlatform: storeGame.platforms[0],
            layers: mockMacLayers,
            globalStorefrontLifecycle: 'minimal_and_close_if_started',
            installedStorefrontClients: { steam: true, gog: true, epic: true },
          });
          expect(storePreview.availableModes).toEqual(['direct', 'storefront_uri']);
          expect(storePreview.availableModes).not.toContain('auto');
          expect(storePreview.defaultLaunchMethod).toBe('direct');
          expect(storePreview.modeNotes.direct.badge).toBe('Recommended');
          expect(storePreview.modeNotes.storefront_uri.disabled).toBe(false);
        }

        // 3. Custom Standalone Native -> ['direct']
        const customGame = createMockGame({
          id: `custom-native-${hostPlatform}`,
          platforms: [
            {
              platformId: 'custom',
              platformGameId: 'custom-1',
              installed: true,
              installPath: exeSuffix,
              executablePath: exeSuffix,
            },
          ],
        });
        const customPreview = buildEffectiveLaunchModePreview({
          game: customGame,
          hostPlatform,
          preferredPlatformId: 'custom',
          effPlatform: customGame.platforms[0],
          layers: mockMacLayers,
          globalStorefrontLifecycle: 'minimal_and_close_if_started',
        });
        expect(customPreview.availableModes).toEqual(['direct']);
      }
    });

    it('greys out Storefront Client Protocol with "Client Not Installed" when the desktop client is absent, coerces GOG/Epic saved storefront_uri back to direct, and detects clients cleanly on darwin & win32', async () => {
      // 1. Test detectInstalledStorefrontClients on isolated darwin & win32 filesystems
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-client-detect-'));
      try {
        const emptyMacHome = path.join(tmpDir, 'mac-empty');
        fs.mkdirSync(path.join(emptyMacHome, 'Applications'), { recursive: true });
        expect(
          launcherEngine.detectInstalledStorefrontClients({
            platform: 'darwin',
            homedir: emptyMacHome,
          })
        ).toEqual({ steam: false, gog: false, epic: false, xbox: false });

        const populatedMacHome = path.join(tmpDir, 'mac-populated');
        fs.mkdirSync(
          path.join(populatedMacHome, 'Applications', 'Steam.app', 'Contents', 'MacOS'),
          { recursive: true }
        );
        fs.writeFileSync(
          path.join(populatedMacHome, 'Applications', 'Steam.app', 'Contents', 'MacOS', 'steam_osx'),
          '#!/bin/sh\n'
        );
        fs.mkdirSync(path.join(populatedMacHome, 'Applications', 'GOG Galaxy.app'), {
          recursive: true,
        });
        fs.mkdirSync(path.join(populatedMacHome, 'Applications', 'Epic Games Launcher.app'), {
          recursive: true,
        });
        expect(
          launcherEngine.detectInstalledStorefrontClients({
            platform: 'darwin',
            homedir: populatedMacHome,
          })
        ).toEqual({ steam: true, gog: true, epic: true, xbox: false });

        const emptyWinApps = path.join(tmpDir, 'win-empty');
        fs.mkdirSync(emptyWinApps, { recursive: true });
        expect(
          launcherEngine.detectInstalledStorefrontClients({
            platform: 'win32',
            homedir: emptyWinApps,
            customApplicationsDir: emptyWinApps,
          })
        ).toEqual({ steam: false, gog: false, epic: false, xbox: false });

        const populatedWinApps = path.join(tmpDir, 'win-populated');
        fs.mkdirSync(path.join(populatedWinApps, 'Steam'), { recursive: true });
        fs.writeFileSync(path.join(populatedWinApps, 'Steam', 'steam.exe'), 'MZ');
        fs.mkdirSync(path.join(populatedWinApps, 'GOG Galaxy'), { recursive: true });
        fs.writeFileSync(path.join(populatedWinApps, 'GOG Galaxy', 'GalaxyClient.exe'), 'MZ');
        fs.mkdirSync(
          path.join(populatedWinApps, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64'),
          { recursive: true }
        );
        fs.writeFileSync(
          path.join(
            populatedWinApps,
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win64',
            'EpicGamesLauncher.exe'
          ),
          'MZ'
        );
        fs.mkdirSync(path.join(populatedWinApps, 'AppData', 'Local', 'Microsoft', 'WindowsApps'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(populatedWinApps, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'XboxPcApp.exe'),
          'MZ'
        );
        expect(
          launcherEngine.detectInstalledStorefrontClients({
            platform: 'win32',
            homedir: populatedWinApps,
            customApplicationsDir: populatedWinApps,
          })
        ).toEqual({ steam: true, gog: true, epic: true, xbox: true });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      // 2. Verify UI grey-out and GOG/Epic fallback coercion when client is not installed
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);
      (launcherService as any).installedStorefrontClients = {
        steam: false,
        gog: false,
        epic: false,
      };
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({
        steam: false,
        gog: false,
        epic: false,
      });

      const gogNativeGame = createMockGame({
        id: 'gog-uninstalled-client-check',
        title: 'GOG Native Without Galaxy Installed',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207658924',
            installed: true,
            installPath: '/Applications/SampleGog.app',
            executablePath: '/Applications/SampleGog.app',
          },
        ],
      });

      // Even if savedConfig previously had launchMethod: 'storefront_uri', missing GOG Galaxy coerces activeMode to 'direct'
      const preview = buildEffectiveLaunchModePreview({
        game: gogNativeGame,
        hostPlatform: 'darwin',
        preferredPlatformId: 'gog',
        savedConfig: { gameId: gogNativeGame.id, launchMethod: 'storefront_uri' },
        effPlatform: gogNativeGame.platforms[0],
        layers: mockMacLayers,
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
        installedStorefrontClients: { steam: false, gog: false, epic: false },
      });
      expect(preview.resolvedPolicy?.effectiveLaunchMethod).toBe('direct');
      expect(preview.modeNotes.storefront_uri.disabled).toBe(true);
      expect(preview.modeNotes.storefront_uri.badge).toBe('Client Not Installed');
      expect(preview.modeNotes.storefront_uri.disabledReason).toContain(
        'GOG Galaxy is not installed'
      );

      const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: gogNativeGame,
        initialPlatformId: 'gog' as const,
        onClose: vi.fn(),
      }));
      const storeUriBtn = modal.findElements(
        (el) => el.props?.['data-launch-mode'] === 'storefront_uri'
      )[0];
      expect(storeUriBtn).toBeDefined();
      expect(storeUriBtn.props.disabled).toBe(true);
      expect(modal.html).toContain('Client Not Installed');
      expect(modal.html).toContain('GOG Galaxy is not installed on this system.');
      modal.unmount();
    });
  });

  // ============================================================================
  // TASK 3: GOG Native & Protocol Launch Overhaul
  // ============================================================================
  describe('Task 3: GOG goggalaxy://launchGame/gog_<id> URI, syncGogGameToGalaxy SQLite Registration & Silent Galaxy Wake vs fast_direct_bypass', () => {
    it('builds goggalaxy://launchGame/gog_<id> without store-page openGameView regression and registers local installs via syncGogGameToGalaxy while generically cleaning stale steam-% rows', async () => {
      expect(
        launcherEngine.buildStorefrontLaunchUri({
          platformId: 'gog',
          platformGameId: '1207658924',
        })
      ).toBe('goggalaxy://launchGame/gog_1207658924');
      expect(
        launcherEngine.buildStorefrontLaunchUri({
          platformId: 'gog',
          platformGameId: 'gog_1207658924',
        })
      ).toBe('goggalaxy://launchGame/gog_1207658924');
      expect(
        launcherEngine.buildStorefrontLaunchUri({
          platformId: 'gog',
          platformGameId: 'gog-1207658924',
        })
      ).toBe('goggalaxy://launchGame/gog_1207658924');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-galaxy-sync-'));
      try {
        const dbPath = path.join(tmpDir, 'Storage', 'galaxy-2.0.db');
        const configPath = path.join(tmpDir, 'config.json');
        const gameInstallDir = path.join(tmpDir, 'Games', 'SampleGogGame.app');
        const macBinDir = path.join(gameInstallDir, 'Contents', 'MacOS');
        fs.mkdirSync(macBinDir, { recursive: true });
        const macBinPath = path.join(macBinDir, 'SampleGogGame');
        fs.writeFileSync(macBinPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(configPath, JSON.stringify({ libraryPath: '/tmp/GOG', installationPaths: [] }));

        // Pre-seed arbitrary stale steam-* row (any arbitrary ID like 999991) to verify generic subquery cleanup
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const { DatabaseSync } = require('node:sqlite');
        const seedDb = new DatabaseSync(dbPath);
        seedDb.exec(`
          CREATE TABLE IF NOT EXISTS Products (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER);
          CREATE TABLE IF NOT EXISTS InstalledProducts (productId INTEGER PRIMARY KEY);
          INSERT INTO Products (id, name, parentId) VALUES (999991, 'steam-999991', NULL);
          INSERT INTO InstalledProducts (productId) VALUES (999991);
        `);
        seedDb.close();

        const syncRes = await launcherEngine.syncGogGameToGalaxy(
          {
            platformGameId: '1888880001',
            title: 'Sample GOG Adventure',
            installPath: gameInstallDir,
            executablePath: macBinPath,
          },
          {
            platform: 'darwin',
            homedir: tmpDir,
            gogGalaxyDbPath: dbPath,
            gogGalaxyConfigPath: configPath,
          }
        );
        expect(syncRes.synced).toBe(true);

        const verifyDb = new DatabaseSync(dbPath);
        const staleRow = verifyDb.prepare('SELECT * FROM Products WHERE id = 999991').get();
        expect(staleRow).toBeUndefined();

        const gogProduct = verifyDb
          .prepare('SELECT id, name FROM Products WHERE id = 1888880001')
          .get();
        expect(gogProduct).toEqual({ id: 1888880001, name: 'Sample GOG Adventure' });

        const playTask = verifyDb
          .prepare('SELECT id, gameReleaseKey FROM PlayTasks WHERE gameReleaseKey = ?')
          .get('gog_1888880001');
        expect(playTask?.gameReleaseKey).toBe('gog_1888880001');
        verifyDb.close();

        const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(updatedConfig.installationPaths).toContain(path.dirname(gameInstallDir));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('launches GOG storefront_uri via goggalaxy://launchGame/gog_<id> on darwin (after syncGogGameToGalaxy) and via GalaxyClient.exe /command=runGame on win32', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-storeuri-e2e-'));
      try {
        const userDataDir = path.join(tmpDir, 'userData');
        const homedir = path.join(tmpDir, 'home');
        const dbPath = path.join(tmpDir, 'galaxy-2.0.db');
        const configPath = path.join(tmpDir, 'config.json');
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.mkdirSync(homedir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ installationPaths: [] }));

        const macInstallDir = path.join(tmpDir, 'Games', 'MacGogTitle.app');
        const macExe = path.join(macInstallDir, 'Contents', 'MacOS', 'MacGogTitle');
        fs.mkdirSync(path.dirname(macExe), { recursive: true });
        fs.writeFileSync(macExe, '#!/bin/sh\n', { mode: 0o755 });

        const openedUris: string[] = [];
        const macLaunch = await launcherEngine.launchGame(
          {
            gameId: 'gog-1777770002',
            title: 'Mac GOG Title',
            platformId: 'gog',
            platformGameId: '1777770002',
            installPath: macInstallDir,
            executablePath: macExe,
            launchConfig: {
              gameId: 'gog-1777770002',
              launchMethod: 'storefront_uri',
            },
          },
          {
            platform: 'darwin',
            userDataDir,
            homedir,
            gogGalaxyDbPath: dbPath,
            gogGalaxyConfigPath: configPath,
            onOpenExternal: async (uri: string) => {
              openedUris.push(uri);
            },
          }
        );

        expect(macLaunch.success).toBe(true);
        expect(openedUris).toEqual(['goggalaxy://launchGame/gog_1777770002']);
        await launcherEngine.stopGame({ gameId: 'gog-1777770002' }, { userDataDir });

        // Windows win32: spawns GalaxyClient.exe /command=runGame /gameId=<id> /path=<installPath>
        const winInstallDir = path.join(tmpDir, 'WinGames', 'WinGogTitle');
        const winExe = path.join(winInstallDir, 'game.exe');
        const galaxyExe = path.join(tmpDir, 'GOG Galaxy', 'GalaxyClient.exe');
        fs.mkdirSync(winInstallDir, { recursive: true });
        fs.mkdirSync(path.dirname(galaxyExe), { recursive: true });
        fs.writeFileSync(winExe, 'MZ');
        fs.writeFileSync(galaxyExe, 'MZ');

        const winSpawned: { cmd: string; args: string[] }[] = [];
        const winLaunch = await launcherEngine.launchGame(
          {
            gameId: 'gog-1777770003',
            title: 'Win GOG Title',
            platformId: 'gog',
            platformGameId: '1777770003',
            installPath: winInstallDir,
            executablePath: winExe,
            launchConfig: {
              gameId: 'gog-1777770003',
              launchMethod: 'storefront_uri',
            },
          },
          {
            platform: 'win32',
            userDataDir,
            homedir,
            gogGalaxyClientPath: galaxyExe,
            gogGalaxyDbPath: dbPath,
            gogGalaxyConfigPath: configPath,
            spawnFn: (cmd: string, args: string[]) => {
              winSpawned.push({ cmd, args });
              const child = new EventEmitter() as any;
              child.pid = 48123;
              child.unref = vi.fn();
              return child;
            },
          }
        );

        expect(winLaunch.success).toBe(true);
        expect(winSpawned).toEqual([
          {
            cmd: galaxyExe,
            args: ['/command=runGame', '/gameId=1777770003', `/path=${winInstallDir}`],
          },
        ]);
        await launcherEngine.stopGame({ gameId: 'gog-1777770003' }, { userDataDir });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('wakes GOG Galaxy silently in Direct mode under minimal_and_close_if_started, and skips waking GOG Galaxy under fast_direct_bypass while keeping standalone gogdl Cloud Saves active', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-direct-wake-'));
      try {
        const userDataDir = path.join(tmpDir, 'userData');
        const homedir = path.join(tmpDir, 'home');
        const galaxyApp = path.join(homedir, 'Applications', 'GOG Galaxy.app');
        const gameDir = path.join(tmpDir, 'Games', 'DirectGogGame');
        const gameBin = path.join(gameDir, 'game_bin');
        const gogSaveDir = path.join(homedir, 'Documents', 'DirectGogGameSaves');
        const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.mkdirSync(galaxyApp, { recursive: true });
        fs.mkdirSync(gameDir, { recursive: true });
        fs.mkdirSync(gogSaveDir, { recursive: true });
        fs.writeFileSync(gameBin, '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(gameDir, 'libGalaxy64.dylib'), 'GALAXY_SDK');
        fs.writeFileSync(path.join(gogSaveDir, 'slot0.sav'), 'save_data');
        fs.writeFileSync(gogAuthPath, '{}');

        const gogRemoteOverride = {
          content: {
            MacOS: {
              cloudStorage: {
                enabled: true,
                locations: [{ name: 'saves', location: '<?DOCUMENTS?>/DirectGogGameSaves' }],
              },
            },
          },
        };

        // 1. Direct + minimal_and_close_if_started -> wakes GOG Galaxy silently AND runs gogdl cloud sync
        const spawnedCallsMinimal: { cmd: string; args: string[] }[] = [];
        let gogSyncMinimalCalls = 0;
        const resMinimal = await launcherEngine.launchGame(
          {
            gameId: 'gog-direct-minimal',
            title: 'Direct GOG With Achievements',
            platformId: 'gog',
            platformGameId: '1666660001',
            gogClientId: 'gog_cid_1666660001',
            installPath: gameDir,
            executablePath: gameBin,
            launchConfig: {
              gameId: 'gog-direct-minimal',
              launchMethod: 'direct',
              storefrontClientLifecycle: 'minimal_and_close_if_started',
            },
          },
          {
            platform: 'darwin',
            userDataDir,
            homedir,
            gogGalaxyClientPath: galaxyApp,
            allowGogWakeInTest: true,
            mockProcessListOutput: '',
            gogdlBinaryPath: 'gogdl',
            gogAuthConfigPath: gogAuthPath,
            gogRemoteConfigOverride: gogRemoteOverride,
            execFileImpl: (cmd: string, args: string[], opts: any, cb?: any) => {
              const callback = typeof opts === 'function' ? opts : cb;
              if (cmd === 'gogdl' && args.includes('save-sync')) {
                gogSyncMinimalCalls++;
              }
              callback?.(null, '1790000100\n', '');
            },
            spawnFn: (cmd: string, args: string[]) => {
              spawnedCallsMinimal.push({ cmd, args });
              const child = new EventEmitter() as any;
              child.pid = 51001 + spawnedCallsMinimal.length;
              child.stdout = new EventEmitter();
              child.stderr = new EventEmitter();
              child.unref = vi.fn();
              child.kill = () => {
                setImmediate(() => child.emit('close', 0));
              };
              return child;
            },
          }
        );

        expect(resMinimal.success).toBe(true);
        expect(gogSyncMinimalCalls).toBeGreaterThanOrEqual(1);
        expect(
          spawnedCallsMinimal.some(
            (c) =>
              c.cmd === '/usr/bin/open' &&
              c.args.includes(galaxyApp) &&
              c.args.includes('--launchViaAutoStart')
          )
        ).toBe(true);
        await launcherEngine.stopGame({ gameId: 'gog-direct-minimal' }, { userDataDir });

        // 2. Direct + fast_direct_bypass -> NEVER wakes GOG Galaxy, yet STILL runs gogdl cloud sync!
        const spawnedCallsFast: { cmd: string; args: string[] }[] = [];
        let gogSyncFastCalls = 0;
        const resFast = await launcherEngine.launchGame(
          {
            gameId: 'gog-direct-fast',
            title: 'Direct GOG Fast Bypass',
            platformId: 'gog',
            platformGameId: '1666660002',
            gogClientId: 'gog_cid_1666660002',
            installPath: gameDir,
            executablePath: gameBin,
            launchConfig: {
              gameId: 'gog-direct-fast',
              launchMethod: 'direct',
              storefrontClientLifecycle: 'fast_direct_bypass',
            },
          },
          {
            platform: 'darwin',
            userDataDir,
            homedir,
            gogGalaxyClientPath: galaxyApp,
            allowGogWakeInTest: true,
            mockProcessListOutput: '',
            gogdlBinaryPath: 'gogdl',
            gogAuthConfigPath: gogAuthPath,
            gogRemoteConfigOverride: gogRemoteOverride,
            execFileImpl: (cmd: string, args: string[], opts: any, cb?: any) => {
              const callback = typeof opts === 'function' ? opts : cb;
              if (cmd === 'gogdl' && args.includes('save-sync')) {
                gogSyncFastCalls++;
              }
              callback?.(null, '1790000100\n', '');
            },
            spawnFn: (cmd: string, args: string[]) => {
              spawnedCallsFast.push({ cmd, args });
              const child = new EventEmitter() as any;
              child.pid = 52001 + spawnedCallsFast.length;
              child.stdout = new EventEmitter();
              child.stderr = new EventEmitter();
              child.unref = vi.fn();
              child.kill = () => {
                setImmediate(() => child.emit('close', 0));
              };
              return child;
            },
          }
        );

        expect(resFast.success).toBe(true);
        expect(gogSyncFastCalls).toBeGreaterThanOrEqual(1);
        expect(
          spawnedCallsFast.some(
            (c) => c.args.includes(galaxyApp) || c.args.includes('--launchViaAutoStart')
          )
        ).toBe(false);
        await launcherEngine.stopGame({ gameId: 'gog-direct-fast' }, { userDataDir });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // TASKS 4 & 5: Unified Storefront Launch Policy Card & Store-Accurate Policy Info Boxes
  // ============================================================================
  describe('Tasks 4 & 5: Unified Storefront Launch Policy Card & Store-Accurate Policy Info Boxes (Steam / GOG / Epic × Native / Bottle)', () => {
    it('renders store-accurate policy info boxes and lifecycle dropdown options across Steam, GOG, and Epic for both Native and Bottle builds', () => {
      // 1. Steam Native: storefront_uri + minimal_and_close_if_started -> optimal; direct -> fast_direct_bypass warning
      const steamSilentView = buildStorefrontLaunchPolicyView({
        platformId: 'steam',
        detectedBuildType: 'mac_native_app',
        activeDisplayMethod: 'storefront_uri',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(steamSilentView.showDropdown).toBe(true);
      expect(steamSilentView.dropdownOptions.map((o) => o.value)).toEqual([
        'default_client',
        'minimal_keep_running',
        'minimal_and_close_if_started',
        'fast_direct_bypass',
      ]);
      expect(steamSilentView.infoBox.severity).toBe('optimal');
      expect(steamSilentView.infoBox.includedFeatures.join(' ')).toContain('Steam Cloud Save');
      expect(steamSilentView.infoBox.includedFeatures.join(' ')).toContain('Achievements');

      const steamDirectView = buildStorefrontLaunchPolicyView({
        platformId: 'steam',
        detectedBuildType: 'windows_native',
        activeDisplayMethod: 'direct',
        effectiveLifecycle: 'fast_direct_bypass',
        isInstalled: true,
        hostPlatform: 'win32',
      });
      expect(steamDirectView.showDropdown).toBe(true);
      expect(steamDirectView.selectedDropdownValue).toBe('fast_direct_bypass');
      expect(steamDirectView.infoBox.severity).toBe('warning');
      expect(steamDirectView.infoBox.excludedOrTradeoffs.join(' ')).toContain('Steam Cloud Save');
      expect(steamDirectView.infoBox.excludedOrTradeoffs.join(' ')).toContain('Achievements');

      // 2. Steam Bottle: 4-option dropdown without separate fast-bypass button
      const steamBottleFastView = buildStorefrontLaunchPolicyView({
        platformId: 'steam',
        detectedBuildType: 'windows_exe_on_mac',
        activeDisplayMethod: 'auto',
        effectiveLifecycle: 'fast_direct_bypass',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(steamBottleFastView.cardHeading).toBe('Bottle Steam Launch Policy');
      expect(steamBottleFastView.showDropdown).toBe(true);
      expect(steamBottleFastView.infoBox.severity).toBe('warning');
      expect(steamBottleFastView.infoBox.headline).toContain('Bottle');

      // 3. GOG Native: direct + minimal_and_close_if_started -> optimal (Achievements + gogdl Cloud Saves);
      //    direct + fast_direct_bypass -> warning (Achievements disabled, gogdl Cloud Saves still active);
      //    storefront_uri -> protocol_delegated (dropdown hidden)
      const gogSilentView = buildStorefrontLaunchPolicyView({
        platformId: 'gog',
        detectedBuildType: 'mac_native_app',
        activeDisplayMethod: 'direct',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(gogSilentView.showDropdown).toBe(true);
      expect(gogSilentView.infoBox.severity).toBe('optimal');
      expect(gogSilentView.infoBox.includedFeatures.join(' ')).toContain('gogdl');
      expect(gogSilentView.infoBox.includedFeatures.join(' ')).toContain('Achievements');

      const gogFastView = buildStorefrontLaunchPolicyView({
        platformId: 'gog',
        detectedBuildType: 'windows_native',
        activeDisplayMethod: 'direct',
        effectiveLifecycle: 'fast_direct_bypass',
        isInstalled: true,
        hostPlatform: 'win32',
      });
      expect(gogFastView.showDropdown).toBe(true);
      expect(gogFastView.infoBox.severity).toBe('warning');
      expect(gogFastView.infoBox.includedFeatures.join(' ')).toContain('gogdl');
      expect(gogFastView.infoBox.excludedOrTradeoffs.join(' ')).toContain('Achievements');

      const gogProtocolView = buildStorefrontLaunchPolicyView({
        platformId: 'gog',
        detectedBuildType: 'mac_native_app',
        activeDisplayMethod: 'storefront_uri',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(gogProtocolView.showDropdown).toBe(false);
      expect(gogProtocolView.infoBox.policyKey).toBe('protocol_delegated');

      // 4. GOG Bottle: 4-option Bottle GOG Launch Policy dropdown (gogdl Cloud Saves + optional Windows GOG Galaxy inside bottle)
      const gogBottleView = buildStorefrontLaunchPolicyView({
        platformId: 'gog',
        detectedBuildType: 'windows_exe_on_mac',
        activeDisplayMethod: 'auto',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(gogBottleView.showDropdown).toBe(true);
      expect(gogBottleView.dropdownOptions.map((o) => o.value)).toEqual([
        'default_client',
        'minimal_keep_running',
        'minimal_and_close_if_started',
        'fast_direct_bypass',
      ]);
      expect(gogBottleView.infoBox.policyKey).toBe('minimal_and_close_if_started');
      expect(gogBottleView.infoBox.includedFeatures.join(' ')).toContain('gogdl');
      expect(gogBottleView.infoBox.excludedOrTradeoffs.join(' ')).toContain(
        'cold bottle startup'
      );

      // 5. Epic Native & Bottle: clientless_epic optimal in Direct/Bottle; protocol_delegated in storefront_uri
      expect(sanitizeStorefrontLifecycleOverride('default_client', 'gog')).toBe(
        'minimal_keep_running'
      );
      expect(sanitizeStorefrontLifecycleOverride('invalid_legacy_policy', 'epic')).toBe('default');
      const epicDirectView = buildStorefrontLaunchPolicyView({
        platformId: 'epic',
        detectedBuildType: 'windows_native',
        activeDisplayMethod: 'direct',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'win32',
      });
      expect(epicDirectView.showDropdown).toBe(false);
      expect(epicDirectView.infoBox.policyKey).toBe('clientless_epic');
      expect(epicDirectView.infoBox.severity).toBe('optimal');
      expect(epicDirectView.infoBox.includedFeatures.join(' ')).toContain('Achievements');
      expect(epicDirectView.infoBox.includedFeatures.join(' ')).toContain('legendary');

      const epicProtocolView = buildStorefrontLaunchPolicyView({
        platformId: 'epic',
        detectedBuildType: 'windows_native',
        activeDisplayMethod: 'storefront_uri',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'win32',
      });
      expect(epicProtocolView.showDropdown).toBe(false);
      expect(epicProtocolView.infoBox.policyKey).toBe('protocol_delegated');

      // Advisory parity check for GOG Direct default vs fast_direct_bypass
      expect(
        computeFastMinimalLaunchAdvisory({
          platformId: 'gog',
          detectedBuildType: 'mac_native_app',
          hostPlatform: 'darwin',
          launchMethod: 'direct',
          storefrontClientLifecycle: 'minimal_and_close_if_started',
          isInstalled: true,
        }).isActive
      ).toBe(false);
      const gogFastAdvisory = computeFastMinimalLaunchAdvisory({
        platformId: 'gog',
        detectedBuildType: 'mac_native_app',
        hostPlatform: 'darwin',
        launchMethod: 'direct',
        storefrontClientLifecycle: 'fast_direct_bypass',
        isInstalled: true,
      });
      expect(gogFastAdvisory.isActive).toBe(true);
      expect(gogFastAdvisory.severity).toBe('warning');
    });

    it('synchronizes Steam Launch Mode and Storefront Lifecycle dropdown bidirectionally and avoids rendering duplicate FastLaunchWarningBanner inside GameLaunchConfigModal', () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);
      vi.spyOn(launcherService, 'detectInstalledStorefrontClients').mockResolvedValue({
        steam: true,
        gog: true,
        epic: true,
      });

      const steamNativeGame = createMockGame({
        id: 'steam-policy-sync-modal',
        title: 'Balatro Native',
        steamAppId: 2379780,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '2379780',
            installed: true,
            installPath: '/Applications/Balatro.app',
            executablePath: '/Applications/Balatro.app',
          },
        ],
      });

      const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: steamNativeGame,
        initialPlatformId: 'steam' as const,
        onClose: vi.fn(),
      }));

      expect(modal.html).toContain('data-testid="storefront-launch-policy-card"');
      expect(modal.html).toContain('data-testid="storefront-policy-info-box"');
      expect(modal.html).not.toContain('toggle-bottle-fast-bypass');
      expect(modal.html).not.toContain('data-testid="fast-launch-warning-banner"');

      const getLifecycleSelect = () =>
        modal.findElements(
          (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
        )[0];
      const getActiveMode = () =>
        modal.findElements(
          (el) => Boolean(el.props?.['data-launch-mode']) && el.props?.['aria-pressed'] === true
        )[0]?.props?.['data-launch-mode'];

      // Default on Steam Native is 'storefront_uri'
      expect(getActiveMode()).toBe('storefront_uri');

      // Selecting 'fast_direct_bypass' in Steam Launch Policy dropdown switches Launch Mode to 'direct'
      getLifecycleSelect().props.onChange({ target: { value: 'fast_direct_bypass' } });
      modal.rerender();
      expect(getActiveMode()).toBe('direct');
      expect(getLifecycleSelect().props.value).toBe('fast_direct_bypass');
      expect(modal.html).toContain('Bypasses Steam Client');
      // Still zero duplicate top warning banner — policy info box inside Storefront Policy Card is the single source of truth
      expect(modal.html).not.toContain('data-testid="fast-launch-warning-banner"');

      // Switching dropdown back to 'minimal_keep_running' switches Launch Mode back to 'storefront_uri'
      getLifecycleSelect().props.onChange({ target: { value: 'minimal_keep_running' } });
      modal.rerender();
      expect(getActiveMode()).toBe('storefront_uri');
      expect(getLifecycleSelect().props.value).toBe('minimal_keep_running');
      modal.unmount();
    });
  });

  // ============================================================================
  // TASK 6: Scroll Flash & Compositor Repaint Elimination
  // ============================================================================
  describe('Task 6: Scroll Flash & Compositor Repaint Elimination (Rendered Modal Scrim & Modal Lock Invariants)', () => {
    it('enforces GPU compositor scroll-flash invariants across rendered GameLaunchConfigModal, GameInstallModal, and modalOverlayLock lifecycle', () => {
      // 1. Render both GameLaunchConfigModal and GameInstallModal to verify flat sibling scrim + modal-scroll-body DOM classes without backdrop-blur / transition-all / translateZ(0)
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
      const installGame = createMockGame({
        id: 'install-modal-scrim-check',
        title: 'Install Modal Scrim Check',
        platforms: [{ platformId: 'gog', platformGameId: '1555550001', installed: false }],
      });
      const launchModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: installGame,
        onClose: vi.fn(),
      }));
      const installModal = createStatefulRenderer(GameInstallModal, () => ({
        isOpen: true,
        game: installGame,
        onClose: vi.fn(),
      }));

      for (const [name, html] of [
        ['GameLaunchConfigModal', launchModal.html],
        ['GameInstallModal', installModal.html],
      ] as const) {
        expect(html, `${name} must use .modal-scroll-body`).toContain('modal-scroll-body');
        expect(html, `${name} must use overscroll-contain`).toContain('overscroll-contain');
        expect(html, `${name} must render flat pointer-events-none sibling scrim`).toContain(
          'pointer-events-none'
        );
        expect(html, `${name} must not use backdrop-blur`).not.toContain('backdrop-blur');
        expect(html, `${name} must not use transition-all`).not.toContain('transition-all');
        expect(html, `${name} must not use translateZ(0)`).not.toContain('translateZ(0)');
        expect(html, `${name} must not use contain:layout style paint`).not.toContain(
          'contain:layout style paint'
        );
      }
      launchModal.unmount();
      installModal.unmount();

      // 4. Reference-counted modalOverlayLock lifecycle (data-modal-overlay-open + #root inert)
      const origHtmlElement = (globalThis as any).HTMLElement;
      class MockHTMLElement {
        private attrMap = new Map<string, string>();
        setAttribute(k: string, v: string) {
          this.attrMap.set(k, String(v));
        }
        getAttribute(k: string) {
          return this.attrMap.has(k) ? this.attrMap.get(k)! : null;
        }
        removeAttribute(k: string) {
          this.attrMap.delete(k);
        }
      }
      const rootEl = new MockHTMLElement();
      (globalThis as any).HTMLElement = MockHTMLElement;
      (document as any).body = new MockHTMLElement();
      (document as any).getElementById = (id: string) => (id === 'root' ? rootEl : null);
      try {
        expect(isModalOverlayOpen()).toBe(false);
        const releaseFirst = acquireModalOverlayLock();
        const releaseSecond = acquireModalOverlayLock();
        expect(isModalOverlayOpen()).toBe(true);
        expect(document.documentElement.getAttribute('data-modal-overlay-open')).toBe('true');
        expect(rootEl.getAttribute('inert')).toBe('');
        releaseFirst();
        expect(isModalOverlayOpen()).toBe(true);
        expect(rootEl.getAttribute('inert')).toBe('');
        releaseSecond();
        expect(isModalOverlayOpen()).toBe(false);
        expect(document.documentElement.getAttribute('data-modal-overlay-open')).toBeNull();
        expect(rootEl.getAttribute('inert')).toBeNull();
      } finally {
        (globalThis as any).HTMLElement = origHtmlElement;
      }
    });
  });

  // ============================================================================
  // FRESH-INSTALL PORTABILITY & ZERO PER-GAME / PER-USER HARDCODED PATCHES AUDIT
  // ============================================================================
  describe('Fresh-Install Portability & Zero Per-Game / Per-User Hardcoded Patches Audit', () => {
    it('resolves clean defaults on a brand-new install with empty localStorage and contains zero hardcoded personal /Users/<name> paths or per-game SQLite AppID patches in production code', () => {
      // 1. Brand-new install: empty localStorage & empty launchConfigs
      expect(localStorage.getItem('onelauncher_launch_configs_v1')).toBeNull();
      expect(localStorage.getItem('onelauncher_perf_settings_v1')).toBeNull();

      const freshGame = createMockGame({
        id: 'fresh-install-audit-game',
        title: 'Fresh Install Verification',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1999999999',
            installed: true,
            installPath: '/Applications/FreshGame.app',
            executablePath: '/Applications/FreshGame.app',
          },
        ],
      });

      const freshPreview = launcherService.resolveEffectiveLaunchModePreview(freshGame, 'gog');
      expect(freshPreview.defaultLaunchMethod).toBe('direct');
      expect(freshPreview.availableModes).toEqual(['direct', 'storefront_uri']);
      expect(freshPreview.resolvedPolicy?.effectiveLifecycle).toBe('minimal_and_close_if_started');
    });
  });
});
