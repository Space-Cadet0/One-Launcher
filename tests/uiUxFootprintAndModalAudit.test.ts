import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { CanonicalGame } from '../src/contracts/game';
import { resolveEffectiveLaunchPolicy } from '../src/contracts/launchPolicyResolver';
import { launcherService } from '../src/services/launcher/launcherService';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { computeInGameFootprintBadge } from '../src/components/Launcher/LaunchConfig/launchConfigHelpers';
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
  const effectDeps: ( any[] | undefined )[] = [];
  const effectCleanups: ( (() => void) | undefined )[] = [];

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

const mockMacLayers = [
  {
    id: 'crossover-26',
    type: 'crossover' as const,
    name: 'CrossOver',
    binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    bottlesDir: '/tmp/Bottles',
    availableBottles: ['OneLauncher', 'Steam'],
    version: '26.0.0',
  },
];

describe('UI/UX Game Page, Launch & Compatibility Settings, and Storefront Function Preservation Audit', () => {
  const storageMap = new Map<string, string>();

  beforeEach(async () => {
    storageMap.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
      setItem: (k: string, v: string) => {
        storageMap.set(k, String(v));
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
      clear: () => {
        storageMap.clear();
      },
    });

    await launcherService.savePerformanceSettings({
      inGameLauncherBehavior: 'hide_tray_hibernate',
      postGameLauncherBehavior: 'restore_window',
      storefrontClientLifecycle: 'minimal_and_close_if_started',
      pauseBackgroundSyncInGame: true,
      pauseDownloadsInGame: true,
      autoShutdownWinePrefixOnExit: true,
      suppressWineDebugLogging: true,
    });
  });

  afterEach(() => {
    while (activeRenderers.length > 0) {
      activeRenderers.pop()?.unmount();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Task 1 & Task 6: removes play-policy-caption badge from SteamLibraryActionBar and persists selected storefront per game', () => {
    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);

    const multiStoreGame: CanonicalGame = {
      id: 'multi-quake-2',
      title: 'Quake II',
      sortTitle: 'Quake II',
      steamAppId: 2320,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
        {
          platformId: 'gog',
          platformGameId: '1441704920',
          installed: true,
          installPath: '/tmp/Games/Quake II GOG',
          executablePath: '/tmp/Games/Quake II GOG/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
        {
          platformId: 'epic',
          platformGameId: 'QuakeIIEpic',
          installed: false,
        },
      ],
      headerImage: '',
      developers: ['id Software'],
      publishers: ['Bethesda'],
      genres: ['Shooter'],
      tags: ['FPS'],
    };

    const otherGame: CanonicalGame = {
      ...multiStoreGame,
      id: 'steam-only-hades',
      title: 'Hades',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '1145360',
          installed: true,
          installPath: '/Applications/Hades.app',
          executablePath: '/Applications/Hades.app',
        },
      ],
    };

    let activeGame = multiStoreGame;
    const bar = createStatefulRenderer(SteamLibraryActionBar, () => ({
      game: activeGame,
      playtimeMinutes: 120,
    }));

    // Task 1: Policy caption badge ("Silent Client + Cloud Sync", etc.) is completely removed from Game Page
    expect(bar.html).not.toContain('data-testid="play-policy-caption"');
    expect(bar.html).not.toContain('Silent Client + Cloud Sync');
    expect(bar.html).not.toContain('CrossOver Bottle Steam');
    expect(bar.html).not.toContain('Fast Direct Bypass');

    // Task 6: Select GOG in Target Storefront dropdown -> persisted in storage & remembered across game switches + remounts
    const getStoreSelect = () =>
      bar.findElements(
        (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Storefront'
      )[0];
    expect(getStoreSelect()).toBeDefined();
    expect(getStoreSelect().props.value).toBe('steam');

    getStoreSelect().props.onChange({ target: { value: 'gog' } });
    bar.rerender();
    expect(getStoreSelect().props.value).toBe('gog');
    expect(launcherService.getSelectedStorefrontForGame('multi-quake-2')).toBe('gog');

    // Navigate to a different game, then back to Quake II
    activeGame = otherGame;
    bar.rerender();
    activeGame = multiStoreGame;
    bar.rerender();
    expect(getStoreSelect().props.value).toBe('gog');

    // Remount a brand-new SteamLibraryActionBar instance (simulating app restart / fresh mount)
    bar.unmount();
    const freshBar = createStatefulRenderer(SteamLibraryActionBar, () => ({
      game: multiStoreGame,
      playtimeMinutes: 120,
    }));
    const freshSelect = freshBar.findElements(
      (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Storefront'
    )[0];
    expect(freshSelect.props.value).toBe('gog');
    freshBar.unmount();
  });

  it('Task 2 & Task 3: merges Fast Launch into In-Game Footprint & Performance, filters options per OS/build/storefront, and dynamically updates footprint badge', () => {
    const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

    const bottleSteamGame: CanonicalGame = {
      id: 'bottle-steam-q2',
      title: 'Quake II Bottle',
      sortTitle: 'Quake II Bottle',
      steamAppId: 2320,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: bottleSteamGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));

    // Verify Storefront Launch Policy card & lifecycle dropdown live INSIDE in-game-performance-section and NOT inside compatibility-layer-settings
    const compatSection = modal.findElements(
      (el) => el.props?.['data-section'] === 'compatibility-layer-settings'
    )[0];
    const perfSection = modal.findElements(
      (el) => el.props?.['data-testid'] === 'in-game-performance-section'
    )[0];
    expect(compatSection).toBeDefined();
    expect(perfSection).toBeDefined();
    expect(renderToString(compatSection)).not.toContain('storefront-launch-policy-card');
    expect(renderToString(perfSection)).not.toContain('toggle-bottle-fast-bypass');
    expect(renderToString(perfSection)).toContain('storefront-launch-policy-card');
    expect(renderToString(perfSection)).toContain('Bottle Steam Launch Policy');
    expect(renderToString(perfSection)).toContain('Fast Bottle Launch');
    expect(renderToString(perfSection)).toContain('toggle-auto-shutdown-wine');

    // Task 3: Initial badge is Low-RAM / Zero-GPU Overhead Mode
    const getBadgeText = () => {
      const badgeEl = modal.findElements(
        (el) => el.props?.['data-testid'] === 'in-game-footprint-mode-badge'
      )[0];
      return renderToString(badgeEl).replace(/<[^>]+>/g, '');
    };
    expect(getBadgeText()).toBe('Low-RAM / Zero-GPU Overhead Mode');

    // Select fast_direct_bypass in Bottle Steam Launch Policy dropdown -> badge updates to Amber warning & orange warning info box appears
    const getPolicySelect = () =>
      modal.findElements(
        (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
      )[0];
    getPolicySelect().props.onChange({ target: { value: 'fast_direct_bypass' } });
    modal.rerender();

    expect(getBadgeText()).toBe('Fast Direct Bypass • Zero-GPU (No Steam Cloud)');
    const updatedPerfHtml = renderToString(
      modal.findElements((el) => el.props?.['data-testid'] === 'in-game-performance-section')[0]
    );
    expect(updatedPerfHtml).toContain('data-testid="fast-minimal-launch-warning"');
    expect(updatedPerfHtml).toContain('data-policy-severity="warning"');

    // Switch back to minimal_and_close_if_started + In-Game Launcher Behavior to zero_renderer_daemon -> Ultra-Low RAM badge
    getPolicySelect().props.onChange({ target: { value: 'minimal_and_close_if_started' } });
    modal.rerender();
    modal
      .findElements((el) => el.props?.['data-testid'] === 'in-game-launcher-behavior-select')[0]
      .props.onChange({ target: { value: 'zero_renderer_daemon' } });
    modal.rerender();
    expect(getBadgeText()).toBe('Ultra-Low RAM (~45 MB) • Zero-GPU + Cloud Sync');

    // Switch In-Game Launcher Behavior to keep_open -> Standard Footprint badge
    modal
      .findElements((el) => el.props?.['data-testid'] === 'in-game-launcher-behavior-select')[0]
      .props.onChange({ target: { value: 'keep_open' } });
    modal.rerender();
    expect(getBadgeText()).toBe('Standard Footprint • Launcher UI Active');
    modal.unmount();

    // Native macOS .app build: must NOT show Wine/Bottle daemon toggle or "Bottle" wording in Fast Launch
    const nativeMacAppGame: CanonicalGame = {
      ...bottleSteamGame,
      id: 'native-mac-balatro',
      title: 'Balatro Mac',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2379780',
          installed: true,
          installPath: '/Applications/Balatro.app',
          executablePath: '/Applications/Balatro.app',
        },
      ],
    };
    const macNativeModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: nativeMacAppGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));
    expect(macNativeModal.html).not.toContain('toggle-auto-shutdown-wine');
    expect(macNativeModal.html).toContain('Fast Direct Launch — Bypass Steam Client');
    expect(macNativeModal.html).not.toContain('Fast Bottle Launch');
    macNativeModal.unmount();

    // Windows (win32) build: zero macOS / Bottle / CrossOver / Wine / Dock / Menu Bar terminology
    hostSpy.mockReturnValue('win32');
    const winNativeGame: CanonicalGame = {
      ...bottleSteamGame,
      id: 'win-native-doom',
      title: 'DOOM Eternal',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '199999',
          installed: true,
          installPath: 'C:\\Games\\DOOMEternal',
          executablePath: 'C:\\Games\\DOOMEternal\\DOOMEternalx64vk.exe',
        },
      ],
    };
    const winModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: winNativeGame,
      initialPlatformId: 'gog' as const,
      onClose: vi.fn(),
    }));
    expect(winModal.html).not.toMatch(
      /CrossOver|Whisky|GPTK|Bottle|wineserver|Menu Bar|Dock|macOS/i
    );
    expect(winModal.html).toContain('GOG Galaxy Launch Policy');
    expect(winModal.html).toContain('Fast Direct Launch — Bypass GOG Galaxy Client');
    // Verify GOG Fast Launch badge is emerald ("Max Savings • Zero-GPU + Fast Launch") because gogdl preserves Cloud Saves
    const gogBadge = computeInGameFootprintBadge({
      preferredPlatformId: 'gog',
      activeDisplayMethod: 'direct',
      inGameLauncherBehavior: 'hide_tray_hibernate',
      storefrontClientLifecycle: 'fast_direct_bypass',
      perfSettings: launcherService.getPerformanceSettings(),
    });
    expect(gogBadge).toEqual({
      label: 'Max Savings • Zero-GPU + Fast Launch',
      tone: 'emerald',
    });
    winModal.unmount();
  });

  it('Task 4 & Storefront Preservation: modifying controls keeps Launch Mode without promoting to removed custom mode while normalizing legacy custom configs and preserving Cloud Sync', async () => {
    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

    const bottleSteamGame: CanonicalGame = {
      id: 'bottle-steam-no-custom-promo',
      title: 'Cyber Bottle Steam',
      sortTitle: 'Cyber Bottle Steam',
      steamAppId: 1091500,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/CyberBottle',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/CyberBottle/Cyber.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    let savedCfg: any = null;
    const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: bottleSteamGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
      onSaved: (cfg) => {
        savedCfg = cfg;
      },
    }));

    // Starts in 'auto' mode on Bottle builds and never renders 'custom' launch mode
    const getSelectedMode = () =>
      modal.findElements(
        (el) => Boolean(el.props?.['data-launch-mode']) && el.props?.['aria-pressed'] === true
      )[0]?.props?.['data-launch-mode'];
    expect(getSelectedMode()).toBe('auto');
    expect(modal.html).not.toContain('data-launch-mode="custom"');
    expect(modal.html).not.toContain('Custom Launch Settings');

    // Modifying Launch Arguments keeps Launch Mode on 'auto' (no auto-promotion to 'custom' or 'direct')
    const argsInput = modal.findElements(
      (el) => el.type === 'input' && String(el.props?.placeholder || '').includes('-skipintro')
    )[0];
    expect(argsInput).toBeDefined();
    argsInput.props.onChange({ target: { value: '-skipintro' } });
    modal.rerender();

    expect(getSelectedMode()).toBe('auto');

    // Save configuration and verify 'auto' + launchArguments persist cleanly
    const saveBtn = modal.findElements(
      (el) =>
        el.type === 'button' &&
        renderToString(el).includes('Save Configuration')
    )[0];
    await saveBtn.props.onClick();
    expect(savedCfg?.launchMethod).toBe('auto');
    expect(savedCfg?.launchArguments).toBe('-skipintro');
    modal.unmount();

    // Verify TS === CJS policy parity for legacy 'custom': normalizes to 'auto' and preserves Cloud Saves, Achievements & DRM!
    for (const platformId of ['steam', 'gog', 'epic'] as const) {
      const input = {
        platformId,
        hostPlatform: 'darwin' as const,
        isInstalled: true,
        hasExecutable: true,
        executablePath: '/Applications/CyberMac.app',
        configuredLaunchMethod: 'custom' as const,
        storefrontClientLifecycle: 'default' as const,
        globalStorefrontLifecycle: 'minimal_and_close_if_started' as const,
      };
      const tsPolicy = resolveEffectiveLaunchPolicy(input);
      const cjsPolicy = cjsPolicyResolver.resolveEffectiveLaunchPolicy(input);
      expect(tsPolicy).toEqual(cjsPolicy);
      expect(tsPolicy.configuredLaunchMethod).toBe('auto');
      expect(tsPolicy.isFastDirectBypass).toBe(false);
      if (platformId === 'steam') {
        expect(tsPolicy.delegatesToStorefrontUri).toBe(true);
      } else {
        expect(tsPolicy.effectiveLaunchMethod).toBe('direct');
        expect(tsPolicy.syncsCloudSavesStandalone).toBe(true);
      }
    }
  });

  it('Task 5A: orders modal sections by interaction priority for both installed and uninstalled games', () => {
    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

    const installedBottleGame: CanonicalGame = {
      id: 'order-installed-game',
      title: 'Installed Priority Test',
      sortTitle: 'Installed Priority Test',
      steamAppId: 2320,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/Quake2',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/Quake2/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const installedModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: installedBottleGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));
    const html = installedModal.html;
    const idxLaunchMode = html.indexOf('Launch Mode');
    const idxCompat = html.indexOf('data-section="compatibility-layer-settings"');
    const idxFootprint = html.indexOf('data-section="in-game-performance"');
    const idxExeArgs = html.indexOf('data-section="executable-and-args"');
    const idxEnvHooks = html.indexOf('data-section="environment-variables"');

    expect(idxLaunchMode).toBeGreaterThan(-1);
    expect(idxCompat).toBeGreaterThan(idxLaunchMode);
    expect(idxFootprint).toBeGreaterThan(idxCompat);
    expect(idxExeArgs).toBeGreaterThan(idxFootprint);
    expect(idxEnvHooks).toBeGreaterThan(idxExeArgs);
    installedModal.unmount();

    // Uninstalled game: Locate Existing Local Executable appears above In-Game Footprint & Performance
    const uninstalledGame: CanonicalGame = {
      ...installedBottleGame,
      id: 'order-uninstalled-game',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: false,
        },
      ],
    };
    const uninstalledModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: uninstalledGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));
    const uHtml = uninstalledModal.html;
    expect(uHtml.indexOf('data-section="executable-and-args"')).toBeLessThan(
      uHtml.indexOf('data-section="in-game-performance"')
    );
    uninstalledModal.unmount();
  });

  it('Task 5B: prevents background game-page flicker via modalOverlayLock (inert + data-modal-overlay-open without root overflow mutation) and deduplicates unchanged compat layer broadcasts', async () => {
    // 1. Verify modalOverlayLock tracks nested locks and dispatches pause/resume events without mutating body.style.overflow
    const events: boolean[] = [];
    const mockRoot = {
      attrs: new Map<string, string>(),
      setAttribute(k: string, v: string) {
        this.attrs.set(k, v);
      },
      removeAttribute(k: string) {
        this.attrs.delete(k);
      },
    };
    const mockDocEl = {
      attrs: new Map<string, string>(),
      setAttribute(k: string, v: string) {
        this.attrs.set(k, v);
      },
      removeAttribute(k: string) {
        this.attrs.delete(k);
      },
    };
    class FakeHTMLElement {}
    const fakeBody = Object.assign(new FakeHTMLElement(), { style: { overflow: '' } });

    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    vi.stubGlobal('document', {
      body: fakeBody,
      documentElement: mockDocEl,
      getElementById: (id: string) => (id === 'root' ? mockRoot : null),
    });
    vi.stubGlobal('window', {
      dispatchEvent: (ev: any) => {
        if (ev?.type === 'antigravity:modal-overlay-changed') {
          events.push(Boolean(ev.detail?.isOpen));
        }
        return true;
      },
      electronAPI: {
        platform: 'darwin',
        detectCompatibilityLayers: vi.fn().mockResolvedValue(mockMacLayers),
        checkCompatibilityLayerUpdates: vi.fn().mockResolvedValue({
          crossover: { runnerType: 'crossover', installedVersion: '26.0.0', updateAvailable: false },
        }),
      },
    });

    expect(isModalOverlayOpen()).toBe(false);
    const release1 = acquireModalOverlayLock();
    const release2 = acquireModalOverlayLock();
    expect(isModalOverlayOpen()).toBe(true);
    expect(mockDocEl.attrs.get('data-modal-overlay-open')).toBe('true');
    expect(mockRoot.attrs.has('inert')).toBe(true);
    expect(fakeBody.style.overflow).toBe('');
    expect(events).toEqual([true]);

    release1();
    expect(isModalOverlayOpen()).toBe(true);
    release2();
    expect(isModalOverlayOpen()).toBe(false);
    expect(mockDocEl.attrs.has('data-modal-overlay-open')).toBe(false);
    expect(mockRoot.attrs.has('inert')).toBe(false);
    expect(events).toEqual([true, false]);

    // 2. Verify detectCompatibilityLayers and checkCompatibilityLayerUpdates deduplicate unchanged state broadcasts
    const notifySpy = vi.spyOn(launcherService as any, 'notifyStateChanged');
    await launcherService.detectCompatibilityLayers();
    const countAfterFirstDetect = notifySpy.mock.calls.length;
    await launcherService.detectCompatibilityLayers();
    expect(notifySpy.mock.calls.length).toBe(countAfterFirstDetect);

    await launcherService.checkCompatibilityLayerUpdates();
    const countAfterFirstUpdateCheck = notifySpy.mock.calls.length;
    await launcherService.checkCompatibilityLayerUpdates();
    expect(notifySpy.mock.calls.length).toBe(countAfterFirstUpdateCheck);
  });

  it('filters Storefront Client controls for custom non-storefront games and storefront_uri mode, and keeps preferred mode without promoting to custom on Windows (win32)', () => {
    const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');

    // 1. Custom standalone game -> zero storefront client policy or bypass controls
    const customGame: CanonicalGame = {
      id: 'custom-standalone-1',
      title: 'Indie Standalone',
      sortTitle: 'Indie Standalone',
      platforms: [
        {
          platformId: 'custom',
          platformGameId: 'custom-1',
          installed: true,
          installPath: 'C:\\Games\\IndieStandalone',
          executablePath: 'C:\\Games\\IndieStandalone\\game.exe',
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };
    const customModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: customGame,
      initialPlatformId: 'custom' as const,
      onClose: vi.fn(),
    }));
    expect(customModal.html).not.toContain('toggle-bottle-fast-bypass');
    expect(customModal.html).not.toContain('storefront-launch-policy-card');
    expect(customModal.html).not.toContain('storefront-client-lifecycle-select');
    customModal.unmount();

    // 2. Windows Steam game: defaults to 'storefront_uri' (Storefront Client Protocol (Recommended)) without 'auto' or 'custom';
    //    modifying In-Game Launcher Behavior keeps Launch Mode on 'storefront_uri'
    const winSteamGame: CanonicalGame = {
      ...customGame,
      id: 'win-steam-440',
      title: 'Team Fortress 2',
      steamAppId: 440,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '440',
          installed: true,
          installPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2',
          executablePath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Team Fortress 2\\tf_win64.exe',
        },
      ],
    };
    const winSteamModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: winSteamGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));

    const getSelectedMode = () =>
      winSteamModal.findElements(
        (el) => Boolean(el.props?.['data-launch-mode']) && el.props?.['aria-pressed'] === true
      )[0]?.props?.['data-launch-mode'];
    expect(getSelectedMode()).toBe('storefront_uri');
    expect(winSteamModal.html).not.toContain('data-launch-mode="auto"');
    expect(winSteamModal.html).not.toContain('data-launch-mode="custom"');

    // Modify In-Game Launcher Behavior -> keeps 'storefront_uri' on Windows (never promotes to 'custom')
    winSteamModal
      .findElements((el) => el.props?.['data-testid'] === 'in-game-launcher-behavior-select')[0]
      .props.onChange({ target: { value: 'minimize_taskbar' } });
    winSteamModal.rerender();
    expect(getSelectedMode()).toBe('storefront_uri');
    expect(winSteamModal.html).toContain('Reduced Footprint • UI Minimized');

    // Selecting default_client in Steam Launch Policy updates badge to Desktop Client Managed
    winSteamModal
      .findElements((el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select')[0]
      .props.onChange({ target: { value: 'default_client' } });
    winSteamModal.rerender();
    expect(winSteamModal.html).not.toContain('toggle-bottle-fast-bypass');
    expect(winSteamModal.html).toContain('Desktop Client Managed • Standard Footprint');
    winSteamModal.unmount();

    // 3. Windows GOG game: switching from Direct (Recommended) to Storefront Client Protocol shows delegated note & Desktop Client Managed badge
    const winGogGame: CanonicalGame = {
      ...customGame,
      id: 'win-gog-1207658924',
      title: 'Hollow Knight GOG',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '1207658924',
          installed: true,
          installPath: 'C:\\GOG Games\\Hollow Knight',
          executablePath: 'C:\\GOG Games\\Hollow Knight\\hollow_knight.exe',
        },
      ],
    };
    const winGogModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: winGogGame,
      initialPlatformId: 'gog' as const,
      onClose: vi.fn(),
    }));
    winGogModal
      .findElements((el) => el.props?.['data-launch-mode'] === 'storefront_uri')[0]
      .props.onClick();
    winGogModal.rerender();
    expect(winGogModal.html).toContain('data-testid="storefront-delegated-lifecycle-note"');
    expect(winGogModal.html).not.toContain('storefront-client-lifecycle-select');
    expect(winGogModal.html).toContain('Desktop Client Managed • Standard Footprint');
    winGogModal.unmount();

    hostSpy.mockRestore();
  });

  it('Compositor Scroll & Navigation Smoothness: renders flat sibling dark scrim without backdrop-blur, contain:paint, translateZ(0), or transition-all, and skips unnecessary spinner repaints when runner updates are cached', () => {
    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
    vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({
      crossover: {
        runnerType: 'crossover',
        installedVersion: '26.0.0',
        latestVersion: '26.0.0',
        updateAvailable: false,
      } as any,
    });
    // Return a pending promise so we can verify cached updates prevent immediate 'Checking for updates...' spinner
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockImplementation(
      () => new Promise(() => {})
    );

    const bottleGame: CanonicalGame = {
      id: 'smooth-scroll-game',
      title: 'Smooth Scroll Test',
      sortTitle: 'Smooth Scroll Test',
      steamAppId: 2320,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/Quake2',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/Quake2/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: bottleGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));

    expect(modal.html).toContain('data-testid="launch-config-modal-scrim"');
    expect(modal.html).not.toContain('backdrop-blur');
    expect(modal.html).not.toContain('transition-all');
    expect(modal.html).not.toContain('translateZ(0)');
    expect(modal.html).not.toContain('contain:layout style paint');
    expect(modal.html).not.toContain('Checking for updates...');
    expect(modal.html).toContain('Up to Date (v26.0.0)');
    modal.unmount();

    // Verify GameInstallModal also uses flat sibling scrim without backdrop-blur or contain:layout style paint
    vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
      platformId: 'steam',
      platformGameId: '2320',
      defaultInstallDir: '/tmp/Games',
      availableInstallDirs: ['/tmp/Games'],
      canDirectDownload: true,
    } as any);
    const installModal = createStatefulRenderer(GameInstallModal, () => ({
      isOpen: true,
      game: {
        ...bottleGame,
        platforms: [{ platformId: 'steam' as const, platformGameId: '2320', installed: false }],
      },
      onClose: vi.fn(),
    }));
    expect(installModal.html).not.toContain('backdrop-blur');
    expect(installModal.html).not.toContain('contain:layout style paint');
    expect(installModal.html).toContain('modal-scroll-body');
    installModal.unmount();
  });

  it('Dynamic Storefront Lifecycle & Post-Exit Matrix: hides no-op client policies on Native Epic, exposes 4-option Bottle Launch Policy dropdowns on Bottle Epic & Bottle GOG, syncs Direct mode with lifecycle dropdown, and hides contradictory stay_minimized when keep_open is active', () => {
    const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockMacLayers);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockMacLayers);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

    // 1a. Native Epic Games Store (clientless via Legendary + EOS Exchange Code) -> shows clientless note, hides client dropdown
    const epicNativeGame: CanonicalGame = {
      id: 'epic-native-quake',
      title: 'Quake Epic Native',
      sortTitle: 'Quake Epic Native',
      platforms: [
        {
          platformId: 'epic',
          platformGameId: 'QuakeEpicNativeApp',
          installed: true,
          installPath: '/Applications/QuakeEpic.app',
          executablePath: '/Applications/QuakeEpic.app/Contents/MacOS/QuakeEpic',
          isWindowsBinaryOnMac: false,
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };
    const epicNativeModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: epicNativeGame,
      initialPlatformId: 'epic' as const,
      onClose: vi.fn(),
    }));
    expect(epicNativeModal.html).toContain('data-testid="storefront-clientless-native-note"');
    expect(epicNativeModal.html).toContain('Zero-Footprint Clientless Epic Pipeline');
    expect(epicNativeModal.html).not.toContain('storefront-client-lifecycle-select');
    expect(epicNativeModal.html).not.toContain('toggle-bottle-fast-bypass');
    epicNativeModal.unmount();

    // 1b. Epic inside macOS Bottle -> renders Bottle Epic Games Store Launch Policy dropdown with 4 options
    const epicBottleGame: CanonicalGame = {
      ...epicNativeGame,
      id: 'epic-bottle-quake',
      title: 'Quake Epic',
      sortTitle: 'Quake Epic',
      platforms: [
        {
          platformId: 'epic',
          platformGameId: 'QuakeEpicApp',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/QuakeEpic',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/QuakeEpic/quake.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
    };
    const epicModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: epicBottleGame,
      initialPlatformId: 'epic' as const,
      onClose: vi.fn(),
    }));
    expect(epicModal.html).toContain('Bottle Epic Games Store Launch Policy');
    expect(epicModal.html).toContain('data-testid="storefront-client-lifecycle-select"');
    expect(epicModal.html).not.toContain('toggle-bottle-fast-bypass');
    epicModal.unmount();

    // 2. GOG inside macOS Bottle -> renders Bottle GOG Launch Policy dropdown with all 4 options
    const gogBottleGame: CanonicalGame = {
      ...epicBottleGame,
      id: 'gog-bottle-q2',
      title: 'Quake II GOG Bottle',
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '1441704920',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/Quake2GOG',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/Quake2GOG/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
    };
    const gogBottleModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: gogBottleGame,
      initialPlatformId: 'gog' as const,
      onClose: vi.fn(),
    }));
    expect(gogBottleModal.html).toContain('Bottle GOG Launch Policy');
    expect(gogBottleModal.html).toContain('data-testid="storefront-client-lifecycle-select"');
    expect(gogBottleModal.html).not.toContain('toggle-bottle-fast-bypass');

    // Bottle GOG supports Full Windows GOG Galaxy UI (default_client), whereas Native GOG coerces default_client -> minimal_keep_running
    const bottleGogFullBadge = computeInGameFootprintBadge({
      preferredPlatformId: 'gog',
      activeDisplayMethod: 'auto',
      inGameLauncherBehavior: 'hide_tray_hibernate',
      storefrontClientLifecycle: 'default_client',
      perfSettings: launcherService.getPerformanceSettings(),
      isBottleContext: true,
    });
    expect(bottleGogFullBadge.label).toBe('Zero-GPU Hibernation • Full Store Client');

    const nativeGogBadge = computeInGameFootprintBadge({
      preferredPlatformId: 'gog',
      activeDisplayMethod: 'direct',
      inGameLauncherBehavior: 'hide_tray_hibernate',
      storefrontClientLifecycle: 'default_client',
      perfSettings: launcherService.getPerformanceSettings(),
      isBottleContext: false,
    });
    expect(nativeGogBadge.label).toBe('Low-RAM / Zero-GPU • Silent Client Kept Warm');
    gogBottleModal.unmount();

    // 3. Steam on Windows: Direct mode syncs storefront-client-lifecycle-select to fast_direct_bypass,
    //    and selecting minimal_and_close_if_started transitions out of Direct mode to storefront_uri;
    //    selecting keep_open hides contradictory stay_minimized in post-game-launcher-behavior-select
    hostSpy.mockReturnValue('win32');
    const winSteamGame: CanonicalGame = {
      ...epicBottleGame,
      id: 'win-steam-sync',
      title: 'Half-Life 2',
      steamAppId: 220,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '220',
          installed: true,
          installPath: 'C:\\Steam\\steamapps\\common\\Half-Life 2',
          executablePath: 'C:\\Steam\\steamapps\\common\\Half-Life 2\\hl2.exe',
        },
      ],
    };
    const steamModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: winSteamGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));

    steamModal
      .findElements((el) => el.props?.['data-launch-mode'] === 'direct')[0]
      .props.onClick();
    steamModal.rerender();

    const getLifecycleSelect = () =>
      steamModal.findElements(
        (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
      )[0];
    expect(getLifecycleSelect().props.value).toBe('fast_direct_bypass');

    // Switching dropdown back to Silent Background Steam transitions Launch Mode from 'direct' to 'storefront_uri'
    getLifecycleSelect().props.onChange({ target: { value: 'minimal_and_close_if_started' } });
    steamModal.rerender();
    const activeModeAfter = steamModal.findElements(
      (el) => Boolean(el.props?.['data-launch-mode']) && el.props?.['aria-pressed'] === true
    )[0]?.props?.['data-launch-mode'];
    expect(activeModeAfter).toBe('storefront_uri');
    expect(getLifecycleSelect().props.value).toBe('minimal_and_close_if_started');

    // Selecting keep_open hides contradictory 'stay_minimized' option in post-game-launcher-behavior-select
    steamModal
      .findElements((el) => el.props?.['data-testid'] === 'in-game-launcher-behavior-select')[0]
      .props.onChange({ target: { value: 'keep_open' } });
    steamModal.rerender();
    const postExitSelectHtml = renderToString(
      steamModal.findElements(
        (el) => el.props?.['data-testid'] === 'post-game-launcher-behavior-select'
      )[0]
    );
    expect(postExitSelectHtml).toContain('Keep One Launcher Window Open');
    expect(postExitSelectHtml).not.toContain('value="stay_minimized"');

    steamModal.unmount();
    hostSpy.mockRestore();
  });

  it('Dynamic Compatibility Runner, Graphics Backend & Identifier Input Filtering: adapts Bottle/WinePrefix controls for GPTK/Wine, disables DXVK HUD on Metal-native backends, and disables spellcheck on technical inputs', async () => {
    const multiRunners = [
      ...mockMacLayers,
      {
        id: 'apple-gptk',
        type: 'gptk' as const,
        name: 'Apple Game Porting Toolkit',
        binaryPath: '/usr/local/bin/gameportingtoolkit',
        availableBottles: [],
        version: '2.0',
      },
    ];
    vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(multiRunners as any);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(multiRunners as any);
    vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({} as any);

    const winOnMacGame: CanonicalGame = {
      id: 'compat-dynamic-audit',
      title: 'Metro Exodus Bottle',
      sortTitle: 'Metro Exodus Bottle',
      steamAppId: 412020,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '412020',
          installed: true,
          installPath: '/tmp/Bottles/OneLauncher/drive_c/Games/MetroExodus',
          executablePath: '/tmp/Bottles/OneLauncher/drive_c/Games/MetroExodus/MetroExodus.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    let savedCfg: any = null;
    const modal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: winOnMacGame,
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
      onSaved: (cfg) => {
        savedCfg = cfg;
      },
    }));

    // 1. CrossOver + Auto backend: Target Bottle Name is shown, DXVK HUD is enabled
    expect(
      modal.findElements((el) => el.props?.['aria-label'] === 'Target Bottle Name').length
    ).toBe(1);
    const getDxvkBtn = () =>
      modal.findElements((el) => el.props?.['data-testid'] === 'toggle-dxvk-hud')[0];
    expect(getDxvkBtn().props.disabled).toBe(false);

    // Enable DXVK HUD, then switch Graphics Backend to D3DMetal -> DXVK HUD disables ("N/A") and is omitted on save!
    getDxvkBtn().props.onClick();
    modal.rerender();
    expect(renderToString(getDxvkBtn())).toContain('ON');

    modal
      .findElements((el) => el.props?.['aria-label'] === 'Graphics Backend')[0]
      .props.onChange({ target: { value: 'd3dmetal' } });
    modal.rerender();
    expect(getDxvkBtn().props.disabled).toBe(true);
    expect(renderToString(getDxvkBtn())).toContain('N/A');

    // Switch runner to GPTK (with 0 bottles) -> hides no-op Target Bottle Name input & updates WinePrefix placeholder
    modal
      .findElements((el) => el.props?.['data-testid'] === 'compat-runner-select')[0]
      .props.onChange({ target: { value: 'gptk' } });
    modal.rerender();
    expect(
      modal.findElements((el) => el.props?.['aria-label'] === 'Target Bottle Name').length
    ).toBe(0);
    expect(modal.html).toContain('~/Games/OneLauncher/Prefixes/default');
    expect(getDxvkBtn().props.disabled).toBe(true);

    // Verify technical text/textarea inputs disable spellCheck & autoCorrect, and macOS env placeholder omits Linux MANGOHUD
    expect(modal.html).not.toContain('MANGOHUD=1');
    const textInputs = modal.findElements(
      (el) => el.type === 'input' || el.type === 'textarea'
    );
    expect(textInputs.length).toBeGreaterThanOrEqual(4);
    for (const inp of textInputs) {
      expect(inp.props.spellCheck).toBe(false);
      expect(inp.props.autoCorrect).toBe('off');
    }

    // Save while on GPTK (where DXVK HUD is unsupported) -> dxvkHud must NOT leak into saved config
    const saveBtn = modal.findElements(
      (el) => el.type === 'button' && renderToString(el).includes('Save Configuration')
    )[0];
    await saveBtn.props.onClick();
    expect(savedCfg?.compatibilityLayer).toBe('gptk');
    expect(savedCfg?.dxvkHud).toBeUndefined();
    modal.unmount();

    // Native macOS .app build: switch to Direct mode to inspect Launch Arguments placeholder (omits Windows '-dx11')
    const nativeMacModal = createStatefulRenderer(GameLaunchConfigModal, () => ({
      isOpen: true,
      game: {
        ...winOnMacGame,
        id: 'native-mac-args-check',
        platforms: [
          {
            platformId: 'steam' as const,
            platformGameId: '2379780',
            installed: true,
            installPath: '/Applications/Balatro.app',
            executablePath: '/Applications/Balatro.app',
          },
        ],
      },
      initialPlatformId: 'steam' as const,
      onClose: vi.fn(),
    }));
    nativeMacModal
      .findElements((el) => el.props?.['data-launch-mode'] === 'direct')[0]
      .props.onClick();
    nativeMacModal.rerender();
    expect(nativeMacModal.html).toContain('e.g. -windowed -skipintro -fullscreen');
    expect(nativeMacModal.html).not.toContain('-dx11');
    nativeMacModal.unmount();
  });

  it('Storefront Download Protection: prevents wineserver -k from terminating an active or in-game-paused Bottle download when another game in the same bottle exits', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-bottle-dl-guard-'));
    const userDataDir = path.join(tmpDir, 'userData');
    const homedir = path.join(tmpDir, 'home');
    const appsDir = path.join(tmpDir, 'Applications');
    const crossoverBinDir = path.join(
      appsDir,
      'CrossOver.app',
      'Contents',
      'SharedSupport',
      'CrossOver',
      'bin'
    );
    const bottlePath = path.join(
      homedir,
      'Library',
      'Application Support',
      'CrossOver',
      'Bottles',
      'OneLauncher'
    );
    const bottleSteamDir = path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam');
    const gameExe = path.join(bottlePath, 'drive_c', 'Games', 'QuakeGog', 'quake.exe');

    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(crossoverBinDir, { recursive: true });
    fs.mkdirSync(bottleSteamDir, { recursive: true });
    fs.mkdirSync(path.dirname(gameExe), { recursive: true });
    fs.writeFileSync(path.join(crossoverBinDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(crossoverBinDir, 'wineserver'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(bottlePath, 'cxbottle.conf'), '[Bottle]\n', 'utf8');
    fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
    fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
    fs.writeFileSync(path.join(bottleSteamDir, 'steam.exe'), 'MZ_FAKE_STEAM', 'utf8');
    const peBuf = Buffer.alloc(128);
    peBuf.write('MZ', 0, 'ascii');
    fs.writeFileSync(gameExe, peBuf);

    launcherEngine.setUserDataDir(userDataDir);
    launcherEngine.clearDownloadQueue();

    const activePids = new Set<number>();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
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

    const wineShutdownCalls: string[] = [];
    const spawnFn = vi.fn(() => {
      const pid = 74100;
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
    const execFileImpl = vi.fn((cmd: string, args: string[], _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (String(cmd).includes('wineserver') && Array.isArray(args) && args.includes('-k')) {
        wineShutdownCalls.push(args.join(' '));
      }
      callback?.(null, '', '');
    });

    try {
      // Seed an active Steam download targeting this CrossOver bottle
      await launcherEngine.installGame(
        {
          taskId: 'bottle-steam-dl-999',
          gameId: 'steam-999',
          platformId: 'steam',
          platformGameId: '999',
          steamAppId: 999,
          title: 'Downloading Bottle Steam Game',
          installDir: path.join(bottleSteamDir, 'steamapps', 'common', 'NewGame'),
          manualControl: true,
        },
        { userDataDir, homedir }
      );

      const commonOpts = {
        platform: 'darwin',
        homedir,
        userDataDir,
        customApplicationsDir: appsDir,
        skipAuthRefresh: true,
        spawnFn,
        gameSpawnFn: spawnFn,
        execFileImpl,
        wineCleanupSettleMs: 10,
        onWinePrefixShutdown: (prefix: string) => wineShutdownCalls.push(`shutdown:${prefix}`),
      };

      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'gog-bottle-quake',
          title: 'Quake Bottle GOG',
          platformId: 'gog',
          platformGameId: '1441704920',
          installPath: path.dirname(gameExe),
          executablePath: gameExe,
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover',
          wineBottleName: 'OneLauncher',
        },
        commonOpts
      );
      expect(launchRes.success).toBe(true);

      // Stop the game while 'bottle-steam-dl-999' is still active/queued in the same bottle
      const stopRes = await launcherEngine.stopGame({ gameId: 'gog-bottle-quake' }, commonOpts);
      expect(stopRes.success).toBe(true);
      await new Promise((r) => setTimeout(r, 40));

      // CRITICAL GUARANTEE: wineserver -k MUST NOT fire while a Bottle download is active in that prefix!
      expect(wineShutdownCalls).toEqual([]);
    } finally {
      killSpy.mockRestore();
      launcherEngine.shutdownLauncherEngine();
      launcherEngine.clearDownloadQueue();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
