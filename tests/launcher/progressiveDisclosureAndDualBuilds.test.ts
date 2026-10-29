import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import type { CanonicalGame } from '../../src/contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  DownloadTaskState,
  GameLaunchConfig,
  InstalledGameRecord,
} from '../../src/contracts/launcher';
import { LauncherService, launcherService } from '../../src/services/launcher/launcherService';
import { requestScheduler } from '../../src/services/network/requestScheduler';
import { sanitizeGameCatalog } from '../../src/services/integrations/catalogSanitizer';
import {
  loadUserOverrides,
  saveUserOverride,
  removeUserOverride,
} from '../../src/services/storage/userOverrideStorage';
import { SteamLibraryActionBar } from '../../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { SteamStorePage } from '../../src/components/SteamStoreDetail/SteamStorePage';
import { DownloadManagerDrawer } from '../../src/components/Launcher/DownloadManagerDrawer';
import { GameInstallModal } from '../../src/components/Launcher/GameInstallModal';
import { GameLaunchConfigModal } from '../../src/components/Launcher/GameLaunchConfigModal';
import {
  getNativeOsPlatforms,
  getStorefrontNativeOsPlatforms,
  isNativelyAvailableOnMac,
} from '../../src/services/platform/nativeOsService';
import {
  MockStorage,
  mockStorage,
  installUniversalLauncherBrowserMocks,
  writeTempFile,
  launcherEngine,
} from '../helpers/universalLauncherHarness';

const require = createRequire(import.meta.url);
installUniversalLauncherBrowserMocks();

describe("Universal Game Launcher QA — Progressive Disclosure & Dual Builds (31–34)", () => {
  let tmpRoot: string;
  let userDataDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launcher-qa-'));
    userDataDir = path.join(tmpRoot, 'userdata');
    fs.mkdirSync(userDataDir, { recursive: true });
    launcherEngine.setUserDataDir(userDataDir);
    launcherEngine.clearDownloadQueue();
    launcherEngine.openedExternalUris.length = 0;
    mockStorage.clear();
  });

  afterEach(async () => {
    const running = launcherEngine.getRunningGames();
    for (const session of running) {
      await launcherEngine.stopGame({ gameId: session.gameId });
    }
    launcherEngine.clearDownloadQueue();
    delete (globalThis as any).window.electronAPI;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  // ============================================================================
  // 31. Steam-Style Integrated Window & Menu Bar on Windows/Linux
  // ============================================================================
  describe('31. Steam-Style Integrated Window & Menu Bar on Windows/Linux', () => {
    let previousElectronAPI: any;

    beforeEach(() => {
      previousElectronAPI = (globalThis as any).window?.electronAPI;
    });

    afterEach(() => {
      if (previousElectronAPI === undefined) {
        delete (globalThis as any).window.electronAPI;
      } else {
        (globalThis as any).window.electronAPI = previousElectronAPI;
      }
    });

    it('1. Windows (electronAPI.platform = "win32") renders Steam-style integrated window bar, File/Edit/View/Window menus, hover switching, performMenuAction IPC dispatches, and minimize/maximize/close controls', async () => {
      const ReactModule = await import('react');
      const React = ReactModule.default || ReactModule;
      const { renderToString } = await import('react-dom/server');
      const { TopNavBar } = await import('../../src/components/Navigation/TopNavBar');

      const minimizeWindowMock = vi.fn().mockResolvedValue(undefined);
      const toggleMaximizeWindowMock = vi.fn().mockResolvedValue(true);
      const closeWindowMock = vi.fn().mockResolvedValue(undefined);
      const isWindowMaximizedMock = vi.fn().mockResolvedValue(false);
      const onMaximizedChangedMock = vi.fn().mockReturnValue(() => {});
      const performMenuActionMock = vi.fn().mockResolvedValue(undefined);

      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'win32',
        minimizeWindow: minimizeWindowMock,
        toggleMaximizeWindow: toggleMaximizeWindowMock,
        closeWindow: closeWindowMock,
        isWindowMaximized: isWindowMaximizedMock,
        onMaximizedChanged: onMaximizedChangedMock,
        performMenuAction: performMenuActionMock,
      };

      const findElements = (
        node: any,
        predicate: (el: any) => boolean,
        acc: any[] = []
      ): any[] => {
        if (!node) return acc;
        if (Array.isArray(node)) {
          for (const child of node) findElements(child, predicate, acc);
          return acc;
        }
        if (typeof node === 'object') {
          if (predicate(node)) acc.push(node);
          if (typeof node.type === 'function') {
            try {
              const rendered = node.type(node.props || {});
              findElements(rendered, predicate, acc);
            } catch {}
          }
          if (node.props && node.props.children) {
            findElements(node.props.children, predicate, acc);
          }
        }
        return acc;
      };

      const getTextContent = (node: any): string => {
        if (node === null || node === undefined || typeof node === 'boolean') return '';
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(getTextContent).join('');
        if (typeof node === 'object' && node.props) {
          return getTextContent(node.props.children);
        }
        return '';
      };

      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const renderTopNav = () => {
        let hookIdx = 0;
        let effectIdx = 0;
        const prevH = internals.H;
        internals.H = {
          useState(initial: any) {
            const idx = hookIdx++;
            if (!(idx in states)) {
              states[idx] = typeof initial === 'function' ? initial() : initial;
            }
            const setState = (updater: any) => {
              states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
            };
            return [states[idx], setState];
          },
          useEffect(fn: () => any) {
            const idx = effectIdx++;
            if (!effectsRan[idx]) {
              effectsRan[idx] = true;
              fn();
            }
          },
          useRef(initial: any) {
            return { current: initial };
          },
          useMemo(fn: () => any) {
            return fn();
          },
          useCallback(fn: any) {
            return fn;
          },
        };
        try {
          const vnode = (TopNavBar as any)({
            selectedPlatform: 'all',
            onSelectPlatform: vi.fn(),
            installedOnly: false,
            onToggleInstalledOnly: vi.fn(),
            totalGamesCount: 42,
            filteredCount: 42,
            isSyncing: false,
            onTriggerSync: vi.fn(),
            onHomeClick: vi.fn(),
            onOpenIntegrations: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      const r1 = renderTopNav();

      // 1a. Verify steam-integrated-window-bar, 4 menu triggers, and 3 caption buttons render
      expect(r1.html).toContain('data-testid="steam-integrated-window-bar"');
      expect(r1.html).toContain('data-testid="win-menu-file"');
      expect(r1.html).toContain('data-testid="win-menu-edit"');
      expect(r1.html).toContain('data-testid="win-menu-view"');
      expect(r1.html).toContain('data-testid="win-menu-window"');
      expect(r1.html).toContain('data-testid="win-btn-minimize"');
      expect(r1.html).toContain('data-testid="win-btn-maximize"');
      expect(r1.html).toContain('data-testid="win-btn-close"');
      expect(r1.html).toContain('data-mac-traffic-inset="false"');

      // 1b. Click win-menu-view -> opens win-menu-dropdown-view with all 7 View actions
      const viewMenuBtn = findElements(
        r1.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-view'
      )[0];
      expect(viewMenuBtn).toBeDefined();
      viewMenuBtn.props.onClick();

      const rViewOpen = renderTopNav();
      expect(rViewOpen.html).toContain('data-testid="win-menu-dropdown-view"');
      expect(rViewOpen.html).toContain('Reload');
      expect(rViewOpen.html).toContain('Force Reload');
      expect(rViewOpen.html).toContain('Toggle Developer Tools');
      expect(rViewOpen.html).toContain('Actual Size');
      expect(rViewOpen.html).toContain('Zoom In');
      expect(rViewOpen.html).toContain('Zoom Out');
      expect(rViewOpen.html).toContain('Toggle Full Screen');

      // Verify clicking each item in View dropdown calls performMenuAction with exact action ID
      const expectedViewActions: Array<[string, string]> = [
        ['Reload', 'reload'],
        ['Force Reload', 'force-reload'],
        ['Toggle Developer Tools', 'toggle-devtools'],
        ['Actual Size', 'reset-zoom'],
        ['Zoom In', 'zoom-in'],
        ['Zoom Out', 'zoom-out'],
        ['Toggle Full Screen', 'toggle-fullscreen'],
      ];

      for (const [label, actionId] of expectedViewActions) {
        // Ensure View menu is open
        const currentRender = renderTopNav();
        let dropdown = findElements(
          currentRender.vnode,
          (el) => el.props?.['data-testid'] === 'win-menu-dropdown-view'
        )[0];
        if (!dropdown) {
          const btn = findElements(
            currentRender.vnode,
            (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-view'
          )[0];
          btn.props.onClick();
          dropdown = findElements(
            renderTopNav().vnode,
            (el) => el.props?.['data-testid'] === 'win-menu-dropdown-view'
          )[0];
        }
        expect(dropdown).toBeDefined();
        const itemBtn = findElements(
          dropdown,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).startsWith(label) &&
            (label !== 'Reload' || !getTextContent(el).startsWith('Force Reload'))
        )[0];
        expect(itemBtn).toBeDefined();
        itemBtn.props.onClick();
        expect(performMenuActionMock).toHaveBeenLastCalledWith(actionId);
      }

      // 1c. Re-open View menu, then hover over win-menu-file -> switches active dropdown to win-menu-dropdown-file
      const rClosed = renderTopNav();
      const viewTrigger = findElements(
        rClosed.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-view'
      )[0];
      viewTrigger.props.onClick();

      const rViewAgain = renderTopNav();
      expect(rViewAgain.html).toContain('data-testid="win-menu-dropdown-view"');

      const fileTrigger = findElements(
        rViewAgain.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-menu-file'
      )[0];
      expect(fileTrigger).toBeDefined();
      fileTrigger.props.onMouseEnter();

      const rFileHovered = renderTopNav();
      expect(rFileHovered.html).toContain('data-testid="win-menu-dropdown-file"');
      expect(rFileHovered.html).not.toContain('data-testid="win-menu-dropdown-view"');

      // 1d. Click minimize, maximize, and close window caption buttons
      const minBtn = findElements(
        rFileHovered.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-btn-minimize'
      )[0];
      const maxBtn = findElements(
        rFileHovered.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-btn-maximize'
      )[0];
      const closeBtn = findElements(
        rFileHovered.vnode,
        (el) => el.type === 'button' && el.props?.['data-testid'] === 'win-btn-close'
      )[0];

      expect(minBtn).toBeDefined();
      expect(maxBtn).toBeDefined();
      expect(closeBtn).toBeDefined();

      minBtn.props.onClick();
      expect(minimizeWindowMock).toHaveBeenCalledTimes(1);

      maxBtn.props.onClick();
      expect(toggleMaximizeWindowMock).toHaveBeenCalledTimes(1);

      closeBtn.props.onClick();
      expect(closeWindowMock).toHaveBeenCalledTimes(1);
    });

    it('2. macOS (electronAPI.platform = "darwin") preserves data-mac-traffic-inset="true" and does NOT render steam-integrated-window-bar or Windows caption buttons', async () => {
      const ReactModule = await import('react');
      const React = ReactModule.default || ReactModule;
      const { renderToString } = await import('react-dom/server');
      const { TopNavBar } = await import('../../src/components/Navigation/TopNavBar');

      (globalThis as any).window.electronAPI = {
        ...(previousElectronAPI || {}),
        isElectron: true,
        platform: 'darwin',
      };

      const html = renderToString(
        React.createElement(TopNavBar, {
          selectedPlatform: 'all',
          onSelectPlatform: vi.fn(),
          installedOnly: false,
          onToggleInstalledOnly: vi.fn(),
          totalGamesCount: 42,
          filteredCount: 42,
          isSyncing: false,
          onTriggerSync: vi.fn(),
          onHomeClick: vi.fn(),
          onOpenIntegrations: vi.fn(),
        })
      ).replace(/<!--\s*-->/g, '');

      expect(html).toContain('data-mac-traffic-inset="true"');
      expect(html).toContain('pl-[88px]');
      expect(html).not.toContain('data-testid="steam-integrated-window-bar"');
      expect(html).not.toContain('data-testid="win-btn-minimize"');
      expect(html).not.toContain('data-testid="win-btn-maximize"');
      expect(html).not.toContain('data-testid="win-btn-close"');
    });
  });

  // ============================================================================
  // 32. Holistic Dynamic Relevance & Progressive Disclosure of Launch & Compatibility Settings (Scenarios A–E)
  // ============================================================================
  describe('32. Holistic Dynamic Relevance & Progressive Disclosure of Launch & Compatibility Settings (Scenarios A–E)', () => {
    const mockMacLayers: CompatibilityLayerInfo[] = [
      {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        availableBottles: ['OneLauncher', 'Steam', 'GOG'],
      },
      {
        id: 'gptk',
        type: 'gptk',
        name: 'Apple Game Porting Toolkit',
        binaryPath:
          '/Users/test/Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64',
        availableBottles: ['GPTKBottle'],
      },
    ];

    const findElements = (
      node: any,
      predicate: (el: any) => boolean,
      acc: any[] = []
    ): any[] => {
      if (!node) return acc;
      if (Array.isArray(node)) {
        for (const child of node) findElements(child, predicate, acc);
        return acc;
      }
      if (typeof node === 'object') {
        if (predicate(node)) acc.push(node);
        if (typeof node.type === 'function') {
          try {
            const rendered = node.type(node.props || {});
            findElements(rendered, predicate, acc);
          } catch {}
        }
        if (node.props && node.props.children) {
          findElements(node.props.children, predicate, acc);
        }
      }
      return acc;
    };

    const getTextContent = (node: any): string => {
      if (node === null || node === undefined || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(getTextContent).join('');
      if (typeof node === 'object' && node.props) return getTextContent(node.props.children);
      return '';
    };

    const createModalRenderer = (game: CanonicalGame, initialPlatformId?: any) => {
      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const render = () => {
        let stateIdx = 0;
        let effectIdx = 0;
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
          useEffect(fn: () => any) {
            const idx = effectIdx++;
            if (!effectsRan[idx]) {
              effectsRan[idx] = true;
              fn();
            }
          },
          useRef(initial: any) {
            return { current: initial };
          },
          useMemo(fn: () => any) {
            return fn();
          },
          useCallback(fn: any) {
            return fn;
          },
        };
        try {
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game,
            initialPlatformId,
            onClose: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      return { render, states };
    };

    it('Scenario A (macOS + Windows .exe game installed — windows_exe_on_mac): restricts availableModes to [auto, compatibility_layer], keeps windows_exe_on_mac when executablePath is omitted after download completion, and promotes launchMethod to compatibility_layer when runner/bottle changes in auto mode', async () => {
      const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      try {
        // 1. Standard windows_exe_on_mac with .exe executablePath
        const winExeGame: CanonicalGame = {
          id: 'steam-1091500-scenA',
          title: 'Cyberpunk 2077',
          sortTitle: 'Cyberpunk 2077',
          steamAppId: 1091500,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1091500',
              installed: true,
              installPath: '/Users/test/Games/Cyberpunk 2077',
              executablePath: '/Users/test/Games/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe',
              isWindowsBinaryOnMac: true,
            },
          ],
          headerImage: '',
          developers: ['CD PROJEKT RED'],
          publishers: ['CD PROJEKT RED'],
          genres: ['RPG'],
          tags: [],
        };

        const preview1 = launcherService.resolveEffectiveLaunchModePreview(winExeGame, 'steam');
        expect(preview1.detectedBuildType).toBe('windows_exe_on_mac');
        expect(preview1.availableModes).toEqual(['auto', 'compatibility_layer']);
        expect(preview1.availableModes).not.toContain('direct');
        expect(preview1.availableModes).not.toContain('storefront_uri');
        expect(preview1.visibleSections.compatibilityLayer).toBe(true);
        expect(preview1.visibleSections.nativeMacMetalHud).toBe(false);

        // 2. Missing executablePath on GamePlatformOwnership after download completion (via isWindowsBinaryOnMac, Bottle path, or Windows-only metadata)
        const postDownloadEvents: any[] = [];
        const onInstalled = (e: any) => postDownloadEvents.push(e.detail);
        window.addEventListener('antigravity:game-installed', onInstalled);
        try {
          (launcherService as any).handleDownloadUpdated({
            task: {
              taskId: 'dl-scenA-1',
              gameId: 'gog-win-postdl',
              title: 'Post-Download Win Game',
              platformId: 'gog',
              platformGameId: '99887766',
              status: 'completed',
              progressPercent: 100,
              bytesDownloaded: 1024,
              totalBytes: 1024,
              speedBytesPerSec: 0,
              etaSeconds: 0,
              installDir:
                '/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/GOG Games/PostDownloadWinGame',
              startedAt: '2026-01-01T00:00:00.000Z',
              // executablePath intentionally omitted on task completion payload
            } satisfies DownloadTaskState,
          });
        } finally {
          window.removeEventListener('antigravity:game-installed', onInstalled);
        }

        expect(postDownloadEvents).toHaveLength(1);
        expect(postDownloadEvents[0].isWindowsBinaryOnMac).toBe(true);

        const postDlGameNoExecPath: CanonicalGame = {
          id: 'gog-win-postdl',
          title: 'Post-Download Win Game',
          sortTitle: 'Post-Download Win Game',
          platforms: [
            {
              platformId: 'gog',
              platformGameId: '99887766',
              installed: true,
              installPath: '/Users/test/Games/FolderWithoutExeSuffix',
              // executablePath missing, but isWindowsBinaryOnMac preserved
              isWindowsBinaryOnMac: true,
            },
          ],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };
        const previewPostDl = launcherService.resolveEffectiveLaunchModePreview(
          postDlGameNoExecPath,
          'gog'
        );
        expect(previewPostDl.detectedBuildType).toBe('windows_exe_on_mac');
        expect(previewPostDl.detectedBuildType).not.toBe('mac_native_bin');
        expect(previewPostDl.availableModes).toEqual(['auto', 'compatibility_layer']);

        // Also verify Windows-only enrichedMetadata without executablePath or bottle path stays windows_exe_on_mac
        const winMetaOnlyInstalledGame: CanonicalGame = {
          id: 'steam-win-meta-only',
          title: 'Windows Metadata Only Installed Game',
          sortTitle: 'Windows Metadata Only Installed Game',
          steamAppId: 777111,
          enrichedMetadata: {
            platforms: { windows: true, mac: false, linux: false },
          } as any,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '777111',
              installed: true,
              installPath: '/Users/test/Games/WinMetaOnly',
            },
          ],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };
        const previewMetaOnly = launcherService.resolveEffectiveLaunchModePreview(
          winMetaOnlyInstalledGame,
          'steam'
        );
        expect(previewMetaOnly.detectedBuildType).toBe('windows_exe_on_mac');
        expect(previewMetaOnly.availableModes).toEqual(['auto', 'compatibility_layer']);

        // 3. In GameLaunchConfigModal, changing Compatibility Runner or Target Bottle Name while in 'auto' mode preserves 'auto' until explicitly pinned to 'compatibility_layer'
        const { render } = createModalRenderer(winExeGame, 'steam');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rAuto = render();

        // Initially in 'auto' mode ("Auto-Detect Runner" badge shown)
        expect(rAuto.html).toContain('Auto-Detect Runner');

        const runnerSelect = findElements(
          rAuto.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'compat-runner-select'
        )[0];
        expect(runnerSelect).toBeDefined();
        runnerSelect.props.onChange({ target: { value: 'gptk' } });

        const rAfterRunnerChange = render();
        expect(rAfterRunnerChange.html).toContain('Auto-Detect Runner');

        // Explicitly select 'Custom Compatibility Runner & Bottle' mode -> pins 'Custom Runner Pinned'
        const compatModeBtn = findElements(
          rAfterRunnerChange.vnode,
          (el) =>
            el.type === 'button' &&
            el.props?.['data-launch-mode'] === 'compatibility_layer'
        )[0];
        expect(compatModeBtn).toBeDefined();
        compatModeBtn.props.onClick();

        const rPinned = render();
        expect(rPinned.html).toContain('Custom Runner Pinned');

        // Reset back to 'auto' mode, then change Target Bottle Name -> stays in 'auto' mode without hijacking launchMethod
        const autoModeBtn = findElements(
          rPinned.vnode,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).includes('Auto-Detect Compatibility Pipeline')
        )[0];
        expect(autoModeBtn).toBeDefined();
        autoModeBtn.props.onClick();

        const rBackToAuto = render();
        expect(rBackToAuto.html).toContain('Auto-Detect Runner');

        const bottleSelect = findElements(
          rBackToAuto.vnode,
          (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Bottle Name'
        )[0];
        expect(bottleSelect).toBeDefined();
        bottleSelect.props.onChange({ target: { value: 'GPTKBottle' } });

        const rAfterBottleChange = render();
        expect(rAfterBottleChange.html).toContain('Auto-Detect Runner');
      } finally {
        hostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario B (macOS + Native .app or Mach-O binary installed — mac_native_app / mac_native_bin): never misclassifies mac_native_bin as windows_exe_on_mac even when CrossOver has default bottles, excludes compatibility_layer, and shows nativeMacMetalHud', async () => {
      const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      try {
        const nativeBinGame: CanonicalGame = {
          id: 'steam-native-bin-scenB',
          title: 'Factorio Headless Mach-O',
          sortTitle: 'Factorio Headless Mach-O',
          steamAppId: 427520,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '427520',
              installed: true,
              installPath: '/Users/test/Games/NativeBin',
              executablePath: '/Users/test/Games/NativeBin/game_bin',
              isWindowsBinaryOnMac: false,
            },
          ],
          headerImage: '',
          developers: ['Wube Software'],
          publishers: ['Wube Software'],
          genres: ['Strategy'],
          tags: [],
        };

        // Even if draftConfig has a default wineBottleName, mac_native_bin MUST remain mac_native_bin
        const previewBin = launcherService.resolveEffectiveLaunchModePreview(
          nativeBinGame,
          'steam',
          { wineBottleName: 'OneLauncher', launchMethod: 'direct' }
        );
        expect(previewBin.detectedBuildType).toBe('mac_native_bin');
        expect(previewBin.availableModes).toEqual(['storefront_uri', 'direct']);
        expect(previewBin.availableModes).not.toContain('auto');
        expect(previewBin.availableModes).not.toContain('compatibility_layer');
        expect(previewBin.visibleSections).toEqual({
          compatibilityLayer: false,
          crossoverRendering: false,
          nativeMacMetalHud: true,
          executableAndArgs: true,
          environmentAndHooks: true,
        });

        const { render } = createModalRenderer(nativeBinGame, 'steam');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rInitial = render();

        expect(rInitial.html).toContain('macOS Native Binary');
        expect(rInitial.html).not.toContain('data-section="compatibility-layer-settings"');
        expect(rInitial.html).not.toContain('Custom Compatibility Runner &amp; Bottle');

        const directBtn = findElements(
          rInitial.vnode,
          (el) => el.type === 'button' && el.props?.['data-launch-mode'] === 'direct'
        )[0];
        expect(directBtn).toBeDefined();
        directBtn.props.onClick();

        const rDirect = render();
        expect(rDirect.html).toContain('data-section="native-mac-settings"');
        expect(rDirect.html).not.toContain('data-section="compatibility-layer-settings"');
      } finally {
        hostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario C (Storefront Client Protocol storefront_uri selected on installed game): hides nativeMacMetalHud, executableAndArgs, and environmentAndHooks and renders data-section="storefront-uri-notice"', async () => {
      const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      try {
        const installedNativeAppGame: CanonicalGame = {
          id: 'steam-1145360-scenC',
          title: 'Hades',
          sortTitle: 'Hades',
          steamAppId: 1145360,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1145360',
              installed: true,
              installPath: '/Users/test/Library/Application Support/Steam/steamapps/common/Hades',
              executablePath:
                '/Users/test/Library/Application Support/Steam/steamapps/common/Hades/Hades.app/Contents/MacOS/Hades',
              isWindowsBinaryOnMac: false,
            },
          ],
          headerImage: '',
          developers: ['Supergiant Games'],
          publishers: ['Supergiant Games'],
          genres: ['Action'],
          tags: [],
        };

        const previewStoreUri = launcherService.resolveEffectiveLaunchModePreview(
          installedNativeAppGame,
          'steam',
          { launchMethod: 'storefront_uri' }
        );
        expect(previewStoreUri.visibleSections).toEqual({
          compatibilityLayer: false,
          crossoverRendering: false,
          nativeMacMetalHud: false,
          executableAndArgs: false,
          environmentAndHooks: false,
        });

        const { render } = createModalRenderer(installedNativeAppGame, 'steam');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rInitial = render();

        // Steam native defaults to 'storefront_uri' (Recommended): storefront-uri-notice shown, direct-only sections hidden
        expect(rInitial.html).toContain('data-section="storefront-uri-notice"');
        expect(rInitial.html).not.toContain('data-section="native-mac-settings"');
        expect(rInitial.html).not.toContain('data-section="executable-and-args"');
        expect(rInitial.html).not.toContain('data-section="environment-variables"');
        expect(rInitial.html).not.toContain('data-section="shell-hooks"');

        // Click 'Direct macOS Application' mode button -> reveals native-mac-settings, executable-and-args, environment-variables, shell-hooks
        const directBtn = findElements(
          rInitial.vnode,
          (el) => el.type === 'button' && el.props?.['data-launch-mode'] === 'direct'
        )[0];
        expect(directBtn).toBeDefined();
        directBtn.props.onClick();

        const rDirect = render();
        expect(rDirect.html).toContain('data-section="native-mac-settings"');
        expect(rDirect.html).toContain('data-section="executable-and-args"');
        expect(rDirect.html).toContain('data-section="environment-variables"');
        expect(rDirect.html).toContain('data-section="shell-hooks"');
        expect(rDirect.html).not.toContain('data-section="storefront-uri-notice"');

        // Click 'Storefront Client Protocol' mode button -> hides direct-only sections again
        const storeUriBtn = findElements(
          rDirect.vnode,
          (el) =>
            el.type === 'button' && getTextContent(el).includes('Storefront Client Protocol')
        )[0];
        expect(storeUriBtn).toBeDefined();
        storeUriBtn.props.onClick();

        const rStoreUri = render();
        expect(rStoreUri.html).toContain('data-section="storefront-uri-notice"');
        expect(rStoreUri.html).not.toContain('data-section="native-mac-settings"');
        expect(rStoreUri.html).not.toContain('data-section="executable-and-args"');
        expect(rStoreUri.html).not.toContain('data-section="environment-variables"');
        expect(rStoreUri.html).not.toContain('data-section="shell-hooks"');
      } finally {
        hostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario D (Uninstalled game not_installed on macOS & Windows — Before Install): enforces pre-install availableModes, GameLaunchConfigModal progressive disclosure, GameInstallModal preinstall-compat-config, and SteamLibraryActionBar gear menu filtering', async () => {
      const detectSpy = vi
        .spyOn(launcherService, 'detectCompatibilityLayers')
        .mockResolvedValue(mockMacLayers);
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);

      const uninstalledGame: CanonicalGame = {
        id: 'gog-uninstalled-scenD',
        title: 'Uninstalled RPG',
        sortTitle: 'Uninstalled RPG',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '55443322',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: ['RPG'],
        tags: [],
      };

      const macOnlyUninstalledGame: CanonicalGame = {
        id: 'steam-mac-only-scenD',
        title: 'Mac Exclusive Studio Game',
        sortTitle: 'Mac Exclusive Studio Game',
        steamAppId: 888999,
        enrichedMetadata: {
          platforms: { windows: false, mac: true, linux: false },
        } as any,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '888999',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // 1. macOS host ('darwin')
      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      try {
        // 1a. Windows/dual-platform uninstalled game on macOS -> availableModes is ['auto', 'compatibility_layer']
        const previewMacAuto = launcherService.resolveEffectiveLaunchModePreview(
          uninstalledGame,
          'gog',
          { launchMethod: 'auto' }
        );
        expect(previewMacAuto.detectedBuildType).toBe('not_installed');
        expect(previewMacAuto.availableModes).toEqual(['auto', 'compatibility_layer']);
        expect(previewMacAuto.availableModes).not.toContain('direct');
        expect(previewMacAuto.availableModes).not.toContain('storefront_uri');
        expect(previewMacAuto.autoResolvedMethod).toBe('storefront_uri');
        expect(Object.keys(previewMacAuto.modeNotes)).toEqual(
          expect.arrayContaining(['auto', 'direct', 'compatibility_layer', 'storefront_uri'])
        );
        expect(previewMacAuto.visibleSections.compatibilityLayer).toBe(false);
        expect(previewMacAuto.visibleSections.crossoverRendering).toBe(false);

        // 1b. Known macOS-only uninstalled game on macOS -> availableModes is ['auto']
        const previewMacOnly = launcherService.resolveEffectiveLaunchModePreview(
          macOnlyUninstalledGame,
          'steam'
        );
        expect(previewMacOnly.detectedBuildType).toBe('not_installed');
        expect(previewMacOnly.availableModes).toEqual(['auto']);
        expect(previewMacOnly.visibleSections.compatibilityLayer).toBe(false);

        // 1c. Selecting 'compatibility_layer' on uninstalled game reveals compatibilityLayer & crossoverRendering
        const previewMacCompat = launcherService.resolveEffectiveLaunchModePreview(
          uninstalledGame,
          'gog',
          { launchMethod: 'compatibility_layer' }
        );
        expect(previewMacCompat.visibleSections.compatibilityLayer).toBe(true);
        expect(previewMacCompat.visibleSections.crossoverRendering).toBe(true);

        // 1d. GameLaunchConfigModal when !preview.isInstalled:
        // - Default bottle does NOT pollute 'auto' mode into showing compatibility-layer-settings
        // - Shows 'Locate Existing Local Executable' + 'Browse Executable...' while hiding 'Working Directory' and 'Launch Arguments' until customExecutablePath is entered
        // - Labels compatibility_layer as 'Pre-Configure Compatibility Runner & Bottle'
        const { render } = createModalRenderer(uninstalledGame, 'gog');
        render();
        await new Promise((r) => setTimeout(r, 10));
        const rAuto = render();
        expect(rAuto.html).not.toContain('data-section="compatibility-layer-settings"');
        expect(rAuto.html).toContain('Locate Existing Local Executable');
        expect(rAuto.html).toContain('Browse Executable...');
        expect(rAuto.html).not.toContain('Working Directory');
        expect(rAuto.html).not.toContain('Launch Arguments');
        expect(rAuto.html).toContain('Pre-Configure Compatibility Runner &amp; Bottle');

        // Clicking 'Pre-Configure Compatibility Runner & Bottle' reveals compatibility-layer-settings for pre-configuration
        const compatBtn = findElements(
          rAuto.vnode,
          (el) =>
            el.type === 'button' &&
            getTextContent(el).includes('Pre-Configure Compatibility Runner & Bottle')
        )[0];
        expect(compatBtn).toBeDefined();
        compatBtn.props.onClick();

        const rCompat = render();
        expect(rCompat.html).toContain('data-section="compatibility-layer-settings"');

        // Entering a customExecutablePath on uninstalled game reveals Working Directory & Launch Arguments
        const exeInput = findElements(
          rCompat.vnode,
          (el) =>
            el.type === 'input' &&
            typeof el.props?.placeholder === 'string' &&
            el.props.placeholder.includes('Auto-detected from storefront manifest')
        )[0];
        expect(exeInput).toBeDefined();
        exeInput.props.onChange({ target: { value: '/Users/test/Games/UninstalledRPG/game.exe' } });

        const rWithCustomExe = render();
        expect(rWithCustomExe.html).toContain('Working Directory');
        expect(rWithCustomExe.html).toContain('Launch Arguments');

        // 1e. GameInstallModal on macOS: renders preinstall-compat-config when selectedOs === 'windows', hides when selectedOs === 'mac'
        const installInfoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockResolvedValue({
            success: true,
            platformId: 'gog',
            platformGameId: '55443322',
            defaultInstallDir: '/Users/test/Games/OneLauncher',
            availableInstallDirs: ['/Users/test/Games/OneLauncher'],
            estimatedSizeBytes: 2048,
            availableInstallers: [
              { id: 'win-installer', os: 'windows', title: 'Windows Installer', totalSizeBytes: 2048 },
              { id: 'mac-installer', os: 'mac', title: 'macOS Installer', totalSizeBytes: 2048 },
            ],
          } as any);
        const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
          freeBytes: 100 * 1024 * 1024 * 1024,
          totalBytes: 500 * 1024 * 1024 * 1024,
          usedBytes: 400 * 1024 * 1024 * 1024,
        } as any);

        try {
          const installStates: any[] = [];
          const installEffects: boolean[] = [];
          const internals =
            (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
            (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
          const renderInstallModal = () => {
            let sIdx = 0;
            let eIdx = 0;
            const prevH = internals.H;
            internals.H = {
              useState(init: any) {
                const idx = sIdx++;
                if (idx >= installStates.length) {
                  installStates.push(typeof init === 'function' ? init() : init);
                }
                const setS = (upd: any) => {
                  installStates[idx] = typeof upd === 'function' ? upd(installStates[idx]) : upd;
                };
                return [installStates[idx], setS];
              },
              useEffect(fn: () => any) {
                const idx = eIdx++;
                if (!installEffects[idx]) {
                  installEffects[idx] = true;
                  fn();
                }
              },
              useRef(init: any) {
                return { current: init };
              },
              useMemo(fn: () => any) {
                return fn();
              },
              useCallback(fn: any) {
                return fn;
              },
            };
            try {
              const vnode = (GameInstallModal as any)({
                isOpen: true,
                game: uninstalledGame,
                initialPlatformId: 'gog',
                onClose: vi.fn(),
              });
              const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
              return { vnode, html };
            } finally {
              internals.H = prevH;
            }
          };

          renderInstallModal();
          await new Promise((r) => setTimeout(r, 15));
          const rInstallMac = renderInstallModal();
          // Default selects macOS build when available -> preinstall-compat-config is hidden
          expect(rInstallMac.html).not.toContain('data-testid="preinstall-compat-config"');

          // Switch installer build card to 'win-installer' -> selectedOs becomes 'windows' -> preinstall-compat-config is shown
          const winBuildCard = findElements(
            rInstallMac.vnode,
            (el) => el.type === 'button' && el.props?.['data-testid'] === 'install-option-win-compat'
          )[0];
          expect(winBuildCard).toBeDefined();
          winBuildCard.props.onClick();

          const rInstallWin = renderInstallModal();
          expect(rInstallWin.html).toContain('data-testid="preinstall-compat-config"');
          expect(rInstallWin.html).toContain('data-testid="preinstall-compat-runner"');
          expect(rInstallWin.html).toContain('data-testid="preinstall-compat-bottle"');
        } finally {
          installInfoSpy.mockRestore();
          diskSpy.mockRestore();
        }

        // 1f. SteamLibraryActionBar Gear Menu (Manage Game) when !isInstalled:
        // Hides 'Browse Local Files' and 'Verify / Repair Game Files', shows 'Install Game...', 'Locate Installed Game...', and 'Mark as Manually Installed'
        const actionStates: any[] = [];
        const actionEffects: boolean[] = [];
        const internals =
          (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const renderActionBar = () => {
          let sIdx = 0;
          let eIdx = 0;
          const prevH = internals.H;
          internals.H = {
            useState(init: any) {
              const idx = sIdx++;
              if (idx >= actionStates.length) {
                actionStates.push(typeof init === 'function' ? init() : init);
              }
              const setS = (upd: any) => {
                actionStates[idx] = typeof upd === 'function' ? upd(actionStates[idx]) : upd;
              };
              return [actionStates[idx], setS];
            },
            useEffect(fn: () => any) {
              const idx = eIdx++;
              if (!actionEffects[idx]) {
                actionEffects[idx] = true;
                fn();
              }
            },
            useRef(init: any) {
              return { current: init };
            },
            useMemo(fn: () => any) {
              return fn();
            },
            useCallback(fn: any) {
              return fn;
            },
          };
          try {
            const vnode = (SteamLibraryActionBar as any)({
              game: uninstalledGame,
            });
            const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        const rBarClosed = renderActionBar();
        const manageBtn = findElements(
          rBarClosed.vnode,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
        )[0];
        expect(manageBtn).toBeDefined();
        manageBtn.props.onClick();

        const rBarOpen = renderActionBar();
        expect(rBarOpen.html).toContain('Install Game...');
        expect(rBarOpen.html).toContain('Locate Installed Game...');
        expect(rBarOpen.html).toContain('Mark as Manually Installed');
        expect(rBarOpen.html).not.toContain('Browse Local Files');
        expect(rBarOpen.html).not.toContain('Verify / Repair Game Files');
      } finally {
        macHostSpy.mockRestore();
      }

      // 2. Windows host ('win32')
      const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      try {
        const previewWin = launcherService.resolveEffectiveLaunchModePreview(
          uninstalledGame,
          'gog'
        );
        expect(previewWin.detectedBuildType).toBe('not_installed');
        expect(previewWin.availableModes).toEqual(['auto']);
        expect(previewWin.availableModes).not.toContain('compatibility_layer');
        expect(previewWin.availableModes).not.toContain('storefront_uri');
        expect(previewWin.visibleSections.compatibilityLayer).toBe(false);
      } finally {
        winHostSpy.mockRestore();
        detectSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('Scenario E (custom storefront game): excludes storefront_uri from availableModes across macOS and Windows', () => {
      const customMacAppGame: CanonicalGame = {
        id: 'custom-mac-game-scenE',
        title: 'Custom Indie App',
        sortTitle: 'Custom Indie App',
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'custom-1',
            installed: true,
            installPath: '/Applications/CustomIndie.app',
            executablePath: '/Applications/CustomIndie.app/Contents/MacOS/CustomIndie',
            isWindowsBinaryOnMac: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const customUninstalledGame: CanonicalGame = {
        id: 'custom-uninstalled-scenE',
        title: 'Unlinked Custom Game',
        sortTitle: 'Unlinked Custom Game',
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'custom-2',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      try {
        const macInstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customMacAppGame,
          'custom'
        );
        expect(macInstalledPreview.availableModes).toEqual(['direct']);
        expect(macInstalledPreview.availableModes).not.toContain('auto');
        expect(macInstalledPreview.availableModes).not.toContain('storefront_uri');

        const macUninstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customUninstalledGame,
          'custom'
        );
        expect(macUninstalledPreview.availableModes).toEqual(['auto', 'compatibility_layer']);
        expect(macUninstalledPreview.availableModes).not.toContain('storefront_uri');
      } finally {
        macHostSpy.mockRestore();
      }

      const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      try {
        const winInstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customMacAppGame,
          'custom'
        );
        expect(winInstalledPreview.availableModes).toEqual(['direct']);
        expect(winInstalledPreview.availableModes).not.toContain('auto');
        expect(winInstalledPreview.availableModes).not.toContain('storefront_uri');

        const winUninstalledPreview = launcherService.resolveEffectiveLaunchModePreview(
          customUninstalledGame,
          'custom'
        );
        expect(winUninstalledPreview.availableModes).toEqual(['auto']);
        expect(winUninstalledPreview.availableModes).not.toContain('storefront_uri');
      } finally {
        winHostSpy.mockRestore();
      }
    });
  });

  // ============================================================================
  // 33. Per-Store, Per-Game Dual-Build (macOS + Windows) & Single-Build Resolution, UI Presentation, and Install/Launch Execution
  // ============================================================================
  describe('33. Per-Store, Per-Game Dual-Build (macOS + Windows) & Single-Build Resolution, UI Presentation, and Install/Launch Execution', () => {
    const mockMacLayers: CompatibilityLayerInfo[] = [
      {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
        availableBottles: ['OneLauncher', 'Steam', 'GOG'],
      },
      {
        id: 'gptk',
        type: 'gptk',
        name: 'Apple Game Porting Toolkit',
        binaryPath:
          '/Users/test/Library/Application Support/heroic/tools/game-porting-toolkit/GPTK-2.0/bin/wine64',
        availableBottles: ['GPTKBottle'],
      },
    ];

    const findElements = (
      node: any,
      predicate: (el: any) => boolean,
      acc: any[] = []
    ): any[] => {
      if (!node) return acc;
      if (Array.isArray(node)) {
        for (const child of node) findElements(child, predicate, acc);
        return acc;
      }
      if (typeof node === 'object') {
        if (predicate(node)) acc.push(node);
        if (typeof node.type === 'function') {
          try {
            const rendered = node.type(node.props || {});
            findElements(rendered, predicate, acc);
          } catch {}
        }
        if (node.props && node.props.children) {
          findElements(node.props.children, predicate, acc);
        }
      }
      return acc;
    };

    const getTextContent = (node: any): string => {
      if (node === null || node === undefined || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(getTextContent).join('');
      if (typeof node === 'object' && node.props) return getTextContent(node.props.children);
      return '';
    };

    it('1. Per-Storefront Isolation & epicPlatformSupport preservation: Epic-only Windows game with Steam Mac metadata (20 Minutes Till Dawn) reports Windows-only and hasDualMacAndWinBuild: false', async () => {
      // 1a. Verify scanAllInstalledGames preserves epicPlatformSupport on returned array
      const prevApi = (window as any).electronAPI;
      const mockEpicSupport = {
        '4656facc740742a39e265b026e13d075': { windows: true, mac: false },
      };
      (window as any).electronAPI = {
        ...prevApi,
        scanAllInstalledGames: vi.fn().mockResolvedValue({
          success: true,
          installedGames: [],
          epicPlatformSupport: mockEpicSupport,
        }),
      };
      try {
        const scanned = await launcherService.scanAllInstalledGames(true);
        expect((scanned as any).epicPlatformSupport).toEqual(mockEpicSupport);
      } finally {
        (window as any).electronAPI = prevApi;
      }

      // 1b. Verify 20 Minutes Till Dawn owned ONLY on Epic with Steam Mac metadata does NOT bleed mac:true
      const epicOnlyTwentyMinutesTillDawn: CanonicalGame = {
        id: 'epic-4656facc740742a39e265b026e13d075',
        title: '20 Minutes Till Dawn',
        sortTitle: '20 Minutes Till Dawn',
        steamAppId: 1966900,
        enrichedMetadata: {
          appId: 1966900,
          name: '20 Minutes Till Dawn',
          shortDescription: 'Shoot down an ever-growing horde of Lovecraftian monsters.',
          detailedDescription: 'Shoot down an ever-growing horde of Lovecraftian monsters.',
          aboutTheGame: 'Shoot down an ever-growing horde of Lovecraftian monsters.',
          headerImage: '',
          developers: ['flanne'],
          publishers: ['Erabit'],
          genres: ['Action'],
          tags: [],
          categories: [],
          releaseDate: 'Jun 8, 2023',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 20000,
            totalNegative: 1500,
            totalReviews: 21500,
            positivePercent: 93,
          },
        },
        platforms: [
          {
            platformId: 'epic',
            platformGameId: '4656facc740742a39e265b026e13d075',
            installed: false,
            platforms: { windows: true, mac: false },
          },
        ],
        headerImage: '',
        developers: ['flanne'],
        publishers: ['Erabit'],
        genres: ['Action'],
        tags: [],
      };

      expect(getNativeOsPlatforms(epicOnlyTwentyMinutesTillDawn)).toEqual(['windows']);
      expect(isNativelyAvailableOnMac(epicOnlyTwentyMinutesTillDawn)).toBe(false);

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);
      try {
        const preview = launcherService.resolveEffectiveLaunchModePreview(
          epicOnlyTwentyMinutesTillDawn,
          'epic'
        );
        expect(preview.hasDualMacAndWinBuild).toBe(false);
        expect(preview.detectedBuildType).toBe('not_installed');
        expect(preview.detectedBuildLabel).toBe(
          'Not Installed Locally • Windows Build (CrossOver / Wine)'
        );
      } finally {
        macHostSpy.mockRestore();
        getLayersSpy.mockRestore();
      }
    });

    it('2. Multi-Store Duplicate Ownership (Steam has Mac + Windows, GOG has Windows-only): resolves dual build on Steam and Windows-only on GOG across preview and GameInstallModal', async () => {
      const multiStoreGame: CanonicalGame = {
        id: 'steam-777888',
        title: 'Dual Store Tactical RPG',
        sortTitle: 'Dual Store Tactical RPG',
        steamAppId: 777888,
        enrichedMetadata: {
          appId: 777888,
          name: 'Dual Store Tactical RPG',
          shortDescription: 'Tactical RPG with Mac + Win on Steam and Win-only on GOG.',
          detailedDescription: 'Tactical RPG with Mac + Win on Steam and Win-only on GOG.',
          aboutTheGame: 'Tactical RPG with Mac + Win on Steam and Win-only on GOG.',
          headerImage: '',
          developers: ['Tactics Studio'],
          publishers: ['Tactics Studio'],
          genres: ['RPG'],
          tags: [],
          categories: [],
          releaseDate: '2024',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 500,
            totalNegative: 50,
            totalReviews: 550,
            positivePercent: 91,
          },
        },
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '777888',
            installed: false,
            platforms: { windows: true, mac: true },
          },
          {
            platformId: 'gog',
            platformGameId: '9988776655',
            installed: false,
            platforms: { windows: true, mac: false },
          },
        ],
        headerImage: '',
        developers: ['Tactics Studio'],
        publishers: ['Tactics Studio'],
        genres: ['RPG'],
        tags: [],
      };

      expect(getStorefrontNativeOsPlatforms(multiStoreGame, 'steam')).toEqual(['windows', 'mac']);
      expect(getStorefrontNativeOsPlatforms(multiStoreGame, 'gog')).toEqual(['windows']);

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);
      const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        freeBytes: 100 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 400 * 1024 * 1024 * 1024,
      } as any);

      try {
        // 2a. Verify resolveEffectiveLaunchModePreview for Steam vs GOG
        const steamPreview = launcherService.resolveEffectiveLaunchModePreview(
          multiStoreGame,
          'steam'
        );
        expect(steamPreview.hasDualMacAndWinBuild).toBe(true);
        expect(steamPreview.detectedBuildLabel).toBe(
          'Not Installed Locally • Native macOS (Recommended) & Windows Builds Available'
        );
        expect(steamPreview.modeNotes.auto.badge).toBe('Recommended • Native macOS');
        expect(steamPreview.modeNotes.compatibility_layer.badge).toBe('Windows Translation');

        const gogPreview = launcherService.resolveEffectiveLaunchModePreview(multiStoreGame, 'gog');
        expect(gogPreview.hasDualMacAndWinBuild).toBe(false);
        expect(gogPreview.detectedBuildLabel).toBe(
          'Not Installed Locally • Windows Build (CrossOver / Wine)'
        );

        // 2b. Verify GameInstallModal on Steam renders both install-option-mac-native and install-option-win-compat
        // while GameInstallModal on GOG shows only the Windows CrossOver/Wine build
        const createInstallModalHarness = (initialPlat: 'steam' | 'gog') => {
          const states: any[] = [];
          const effects: boolean[] = [];
          const internals =
            (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
            (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
          const render = () => {
            let sIdx = 0;
            let eIdx = 0;
            const prevH = internals.H;
            internals.H = {
              useState(init: any) {
                const idx = sIdx++;
                if (idx >= states.length) {
                  states.push(typeof init === 'function' ? init() : init);
                }
                const setS = (upd: any) => {
                  states[idx] = typeof upd === 'function' ? upd(states[idx]) : upd;
                };
                return [states[idx], setS];
              },
              useEffect(fn: () => any) {
                const idx = eIdx++;
                if (!effects[idx]) {
                  effects[idx] = true;
                  fn();
                }
              },
              useRef(init: any) {
                return { current: init };
              },
              useMemo(fn: () => any) {
                return fn();
              },
              useCallback(fn: any) {
                return fn;
              },
            };
            try {
              const vnode = (GameInstallModal as any)({
                isOpen: true,
                game: multiStoreGame,
                initialPlatformId: initialPlat,
                onClose: vi.fn(),
              });
              const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
              return { vnode, html };
            } finally {
              internals.H = prevH;
            }
          };
          return { render };
        };

        const steamModal = createInstallModalHarness('steam');
        steamModal.render();
        await new Promise((r) => setTimeout(r, 15));
        const rSteam = steamModal.render();
        expect(rSteam.html).toContain('data-testid="install-option-mac-native"');
        expect(rSteam.html).toContain('★ Recommended • Native macOS');
        expect(rSteam.html).toContain('data-testid="install-option-win-compat"');
        expect(rSteam.html).toContain('Windows Build (CrossOver / Wine)');

        const gogModal = createInstallModalHarness('gog');
        gogModal.render();
        await new Promise((r) => setTimeout(r, 15));
        const rGog = gogModal.render();
        expect(rGog.html).not.toContain('data-testid="install-option-mac-native"');
        expect(rGog.html).not.toContain('data-testid="install-option-win-compat"');
        expect(rGog.html).toContain('AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)');
      } finally {
        macHostSpy.mockRestore();
        getLayersSpy.mockRestore();
        diskSpy.mockRestore();
      }
    });

    it('3. Selected Build Is Actually Installed & Launched: GameInstallModal saves/resets launchConfig & passes os/runner/bottle, findPrimaryExecutable respects preferWindowsExecutable, and launchGame never runs Wine on native Mac binaries', async () => {
      const dualBuildGame: CanonicalGame = {
        id: 'gog-dual-build-exec',
        title: 'Dual Build SciFi',
        sortTitle: 'Dual Build SciFi',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1122334455',
            installed: false,
            platforms: { windows: true, mac: true },
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const getLayersSpy = vi
        .spyOn(launcherService, 'getCompatibilityLayers')
        .mockReturnValue(mockMacLayers);
      const diskSpy = vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        freeBytes: 100 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 400 * 1024 * 1024 * 1024,
      } as any);
      const startInstallSpy = vi
        .spyOn(launcherService, 'startInstall')
        .mockResolvedValue({ success: true } as any);

      try {
        const states: any[] = [];
        const effects: boolean[] = [];
        const internals =
          (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const renderInstallModal = () => {
          let sIdx = 0;
          let eIdx = 0;
          const prevH = internals.H;
          internals.H = {
            useState(init: any) {
              const idx = sIdx++;
              if (idx >= states.length) {
                states.push(typeof init === 'function' ? init() : init);
              }
              const setS = (upd: any) => {
                states[idx] = typeof upd === 'function' ? upd(states[idx]) : upd;
              };
              return [states[idx], setS];
            },
            useEffect(fn: () => any) {
              const idx = eIdx++;
              if (!effects[idx]) {
                effects[idx] = true;
                fn();
              }
            },
            useRef(init: any) {
              return { current: init };
            },
            useMemo(fn: () => any) {
              return fn();
            },
            useCallback(fn: any) {
              return fn;
            },
          };
          try {
            const vnode = (GameInstallModal as any)({
              isOpen: true,
              game: dualBuildGame,
              initialPlatformId: 'gog',
              onClose: vi.fn(),
            });
            const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        renderInstallModal();
        await new Promise((r) => setTimeout(r, 15));
        const rInitial = renderInstallModal();

        // 3a. Click Windows Compatibility build card ('install-option-win-compat'), select runner & bottle, and click Start Download & Install
        const winCardBtn = findElements(
          rInitial.vnode,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'install-option-win-compat'
        )[0];
        expect(winCardBtn).toBeDefined();
        winCardBtn.props.onClick();

        const rWinSelected = renderInstallModal();
        const bottleSelect = findElements(
          rWinSelected.vnode,
          (el) => el.type === 'select' && el.props?.['data-testid'] === 'preinstall-compat-bottle'
        )[0];
        expect(bottleSelect).toBeDefined();
        bottleSelect.props.onChange({ target: { value: 'GOG' } });

        const rReadyWin = renderInstallModal();
        const startBtnWin = findElements(
          rReadyWin.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
        )[0];
        expect(startBtnWin).toBeDefined();
        await startBtnWin.props.onClick();

        const savedWinCfg = launcherService.getLaunchConfig(dualBuildGame.id, 'gog');
        expect(savedWinCfg?.launchMethod).toBe('compatibility_layer');
        expect(savedWinCfg?.compatibilityLayer).toBe('crossover');
        expect(savedWinCfg?.wineBottleName).toBe('GOG');
        expect(startInstallSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gameId: dualBuildGame.id,
            platformId: 'gog',
            os: 'windows',
            compatibilityLayer: 'crossover',
            wineBottleName: 'GOG',
          })
        );

        // 3b. Now click Recommended Native macOS build card ('install-option-mac-native') and click Start Download & Install
        // Verify it invokes startInstall with os: 'mac' and resets launchMethod from 'compatibility_layer' to 'auto'
        const rAfterWin = renderInstallModal();
        const macCardBtn = findElements(
          rAfterWin.vnode,
          (el) => el.type === 'button' && el.props?.['data-testid'] === 'install-option-mac-native'
        )[0];
        expect(macCardBtn).toBeDefined();
        macCardBtn.props.onClick();

        const rReadyMac = renderInstallModal();
        const startBtnMac = findElements(
          rReadyMac.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Start Download & Install')
        )[0];
        expect(startBtnMac).toBeDefined();
        await startBtnMac.props.onClick();

        const savedMacCfg = launcherService.getLaunchConfig(dualBuildGame.id, 'gog');
        expect(savedMacCfg?.launchMethod).toBe('auto');
        expect(savedMacCfg?.compatibilityLayer).toBeUndefined();
        expect(startInstallSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gameId: dualBuildGame.id,
            platformId: 'gog',
            os: 'mac',
          })
        );
      } finally {
        macHostSpy.mockRestore();
        getLayersSpy.mockRestore();
        diskSpy.mockRestore();
        startInstallSpy.mockRestore();
      }

      // 3c. Verify launcherEngine.findPrimaryExecutable respects preferWindowsExecutable when both .app and .exe exist,
      // and launcherEngine.launchGame never invokes Wine/CrossOver on a native .app / Mach-O binary (isMacNativeExecutable)
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-dual-build-'));
      try {
        const appBundleMacOsDir = path.join(
          tmpDir,
          'DualBuildGame.app',
          'Contents',
          'MacOS'
        );
        fs.mkdirSync(appBundleMacOsDir, { recursive: true });
        const macNativeBinPath = path.join(appBundleMacOsDir, 'DualBuildGame');
        fs.writeFileSync(
          macNativeBinPath,
          '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 2000);\n',
          { mode: 0o755 }
        );

        const winExePath = path.join(tmpDir, 'DualBuildGame.exe');
        fs.writeFileSync(winExePath, 'MZ-fake-windows-pe-binary-payload');

        // Default on darwin (preferWindowsExecutable: false) selects native .app
        const defaultDiscovered = launcherEngine.findPrimaryExecutable(tmpDir, {
          platform: 'darwin',
          preferWindowsExecutable: false,
        });
        expect(defaultDiscovered.executablePath).toBe(macNativeBinPath);
        expect(defaultDiscovered.isWindowsBinaryOnMac).toBe(false);

        // preferWindowsExecutable: true on darwin selects .exe and sets isWindowsBinaryOnMac: true
        const winPreferredDiscovered = launcherEngine.findPrimaryExecutable(tmpDir, {
          platform: 'darwin',
          preferWindowsExecutable: true,
        });
        expect(winPreferredDiscovered.executablePath).toBe(winExePath);
        expect(winPreferredDiscovered.isWindowsBinaryOnMac).toBe(true);

        // Verify launchGame never invokes Wine/CrossOver on a native .app or Mach-O binary even if compatibilityLayer is passed
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'mac-native-guard-test',
            title: 'DualBuildGame',
            platformId: 'gog',
            platformGameId: '1122334455',
            installPath: path.join(tmpDir, 'DualBuildGame.app'),
            executablePath: macNativeBinPath,
            isWindowsBinaryOnMac: false,
            launchConfig: {
              gameId: 'mac-native-guard-test',
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
            },
          },
          {
            platform: 'darwin',
            userDataDir: tmpDir,
            skipStartupWait: true,
          }
        );

        expect(launchRes.success).toBe(true);
        expect(launchRes.session?.launchMethod).toBe('direct');
        expect(launchRes.session?.executablePath).toBe(macNativeBinPath);

        await launcherEngine.stopGame('mac-native-guard-test');
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // =========================================================================
  // 34. REAL-WORLD WINDOWS X64 FEEDBACK FIXES: EPIC FIRST-PARTY REGISTRATION,
  //     STEAM MANAGED INSTALL LOCATION, & STEAM PREALLOCATION PROGRESS GUARD
  // =========================================================================
  describe('34. Real-World Windows x64 Feedback Fixes: Epic First-Party Registration, Steam Managed Install Location & Steam Preallocation Progress Guard', () => {
    it('Issue 1: syncEpicFirstPartyLauncher on Windows x64 extracts nested asset_infos.Windows CatalogItemId/CatalogNamespace, self-heals incomplete .item manifests, writes .egstore/<guid>.mancpn & <guid>.manifest, and updates LauncherInstalled.dat', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-win64-epic-sync-'));
      const tempUserData = path.join(tempDir, 'userData');
      const eglManifestsDir = path.join(tempDir, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
      const eglLauncherInstalledDat = path.join(
        tempDir,
        'ProgramData',
        'Epic',
        'UnrealEngineLauncher',
        'LauncherInstalled.dat'
      );

      try {
        const appName = 'b3c4d5e6f7a8901234567890abcdef12';
        const catalogItemId = 'cat_item_99887766554433221100ff';
        const catalogNamespace = 'ns_epic_win64_realworld_01';
        const guid = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
        const installPath = path.join(tempDir, 'Games', 'CyberActionWin64');
        const binDir = path.join(installPath, 'Binaries', 'Win64');
        fs.mkdirSync(binDir, { recursive: true });

        const exePath = path.join(binDir, 'CyberAction-Win64-Shipping.exe');
        fs.writeFileSync(exePath, 'MZ-windows-x64-shipping-executable');

        const legBaseDir = path.join(tempUserData, 'legendaryConfig', 'legendary');
        const legMetaDir = path.join(legBaseDir, 'metadata');
        const legManifestsDir = path.join(legBaseDir, 'manifests');
        fs.mkdirSync(legMetaDir, { recursive: true });
        fs.mkdirSync(legManifestsDir, { recursive: true });

        // 1. Write Legendary installed.json with Windows backslash relative executable
        const installedJsonPath = path.join(legBaseDir, 'installed.json');
        fs.writeFileSync(
          installedJsonPath,
          JSON.stringify(
            {
              [appName]: {
                app_name: appName,
                title: 'Cyber Action Win64',
                install_path: installPath,
                executable: '.\\Binaries\\Win64\\CyberAction-Win64-Shipping.exe',
                version: '2.4.1-win64',
                install_size: 4294967296,
                platform: 'Windows',
              },
            },
            null,
            2
          ),
          'utf8'
        );

        // 2. Write metadata/<appName>.json with nested asset_infos.Windows.catalog_item_id & namespace
        //    and metadata.customAttributes.FolderName.value
        fs.writeFileSync(
          path.join(legMetaDir, `${appName}.json`),
          JSON.stringify(
            {
              app_name: appName,
              app_title: 'Cyber Action Win64',
              asset_infos: {
                Windows: {
                  app_name: appName,
                  asset_id: appName,
                  build_version: '2.4.1-win64',
                  catalog_item_id: catalogItemId,
                  namespace: catalogNamespace,
                },
              },
              metadata: {
                customAttributes: {
                  FolderName: {
                    type: 'STRING',
                    value: 'CyberActionCustomFolder',
                  },
                },
              },
            },
            null,
            2
          ),
          'utf8'
        );

        // 3. Write binary manifest in manifests/<appName>_win.manifest
        const sourceManifestBytes = Buffer.from('EPIC-BINARY-MANIFEST-WIN64-PAYLOAD-9876543210', 'utf8');
        const sourceManifestFile = path.join(legManifestsDir, `${appName}_win.manifest`);
        fs.writeFileSync(sourceManifestFile, sourceManifestBytes);

        // 4. Place an existing incomplete .item manifest in eglManifestsDir with empty CatalogItemId & CatalogNamespace
        //    and missing .egstore/<guid>.mancpn to verify self-healing
        fs.mkdirSync(eglManifestsDir, { recursive: true });
        fs.writeFileSync(
          path.join(eglManifestsDir, `${guid}.item`),
          JSON.stringify(
            {
              FormatVersion: 0,
              bIsIncompleteInstall: false,
              AppName: appName,
              DisplayName: 'Cyber Action Win64',
              InstallationGuid: guid,
              InstallLocation: installPath,
              CatalogItemId: '',
              CatalogNamespace: '',
              LaunchExecutable: '.\\Binaries\\Win64\\CyberAction-Win64-Shipping.exe',
            },
            null,
            2
          ),
          'utf8'
        );

        //Also place a stale .item inside .egstore to verify cleanup
        const egstoreDir = path.join(installPath, '.egstore');
        fs.mkdirSync(egstoreDir, { recursive: true });
        fs.writeFileSync(path.join(egstoreDir, `${guid}.item`), '{}', 'utf8');

        // 5. Run syncEpicFirstPartyLauncher
        const syncRes = launcherEngine.syncEpicFirstPartyLauncher({
          platform: 'win32',
          homedir: tempDir,
          userDataDir: tempUserData,
          eglManifestsDir,
          eglLauncherInstalledDat,
        });

        expect(syncRes.synced).toBe(1);

        // Verify self-healed <guid>.item in eglManifestsDir
        const healedItemPath = path.join(eglManifestsDir, `${guid}.item`);
        expect(fs.existsSync(healedItemPath)).toBe(true);
        const healedItem = JSON.parse(fs.readFileSync(healedItemPath, 'utf8'));
        expect(healedItem.CatalogItemId).toBe(catalogItemId);
        expect(healedItem.CatalogNamespace).toBe(catalogNamespace);
        expect(healedItem.MandatoryAppFolderName).toBe('CyberActionCustomFolder');
        expect(healedItem.FullAppName).toBe(appName);
        expect(healedItem.MainGameAppName).toBe(appName);
        expect(healedItem.LaunchExecutable).toBe('Binaries/Win64/CyberAction-Win64-Shipping.exe');
        expect(healedItem.bIsIncompleteInstall).toBe(false);

        // Verify stale .item inside .egstore was removed
        expect(fs.existsSync(path.join(egstoreDir, `${guid}.item`))).toBe(false);

        // Verify <installPath>/.egstore/<guid>.mancpn exists and has required fields
        const mancpnPath = path.join(egstoreDir, `${guid}.mancpn`);
        expect(fs.existsSync(mancpnPath)).toBe(true);
        const mancpn = JSON.parse(fs.readFileSync(mancpnPath, 'utf8'));
        expect(mancpn).toEqual({
          FormatVersion: 0,
          AppName: appName,
          CatalogItemId: catalogItemId,
          CatalogNamespace: catalogNamespace,
        });

        // Verify <installPath>/.egstore/<guid>.manifest exists and matches binary manifest from manifests/
        const copiedManifestPath = path.join(egstoreDir, `${guid}.manifest`);
        expect(fs.existsSync(copiedManifestPath)).toBe(true);
        expect(fs.readFileSync(copiedManifestPath).equals(sourceManifestBytes)).toBe(true);

        // Verify LauncherInstalled.dat has the entry with NamespaceId: catalogNamespace and ItemId: catalogItemId
        expect(fs.existsSync(eglLauncherInstalledDat)).toBe(true);
        const launcherInstalled = JSON.parse(fs.readFileSync(eglLauncherInstalledDat, 'utf8'));
        expect(Array.isArray(launcherInstalled.InstallationList)).toBe(true);
        const entry = launcherInstalled.InstallationList.find((e: any) => e.AppName === appName);
        expect(entry).toBeDefined();
        expect(entry.InstallLocation).toBe(installPath);
        expect(entry.NamespaceId).toBe(catalogNamespace);
        expect(entry.ItemId).toBe(catalogItemId);
        expect(entry.ArtifactId).toBe(appName);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Issue 2: getGameInstallInfo discovers Steam steamapps/common directories and GameInstallModal renders read-only Managed by Steam Client notice (with multi-library selector) for Steam while keeping editable directory input & Browse button for GOG/Epic', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-steam-install-loc-'));
      try {
        const primarySteamRoot = path.join(tempDir, 'SteamPrimary');
        const primarySteamapps = path.join(primarySteamRoot, 'steamapps');
        const primaryCommon = path.join(primarySteamapps, 'common');
        fs.mkdirSync(primaryCommon, { recursive: true });

        const secondarySteamRoot = path.join(tempDir, 'SteamSecondaryDrive');
        const secondarySteamapps = path.join(secondarySteamRoot, 'steamapps');
        const secondaryCommon = path.join(secondarySteamapps, 'common');
        fs.mkdirSync(secondaryCommon, { recursive: true });

        // Write libraryfolders.vdf in primarySteamapps pointing to both libraries
        const vdfContent = `"libraryfolders"
{
  "0"
  {
    "path" "${primarySteamRoot.replace(/\\/g, '\\\\')}"
  }
  "1"
  {
    "path" "${secondarySteamRoot.replace(/\\/g, '\\\\')}"
  }
}`;
        fs.writeFileSync(path.join(primarySteamapps, 'libraryfolders.vdf'), vdfContent, 'utf8');

        // 2a. Verify launcherEngine.getGameInstallInfo for platformId: 'steam' discovers steamapps/common
        const steamInstallInfo = await launcherEngine.getGameInstallInfo(
          {
            platformId: 'steam',
            platformGameId: '1091500',
            steamAppId: 1091500,
            title: 'Cyberpunk 2077',
          },
          {
            platform: 'win32',
            homedir: tempDir,
            userDataDir: tempDir,
            customRoots: [primarySteamRoot],
            skipNetwork: true,
          }
        );

        expect(steamInstallInfo.defaultInstallDir).toBe(primaryCommon);
        expect(steamInstallInfo.availableInstallDirs).toContain(primaryCommon);
        expect(steamInstallInfo.availableInstallDirs).toContain(secondaryCommon);

        // 2b. Render GameInstallModal for a Steam game (selectedPlatformId === 'steam')
        const testGame: CanonicalGame = {
          id: 'multi-store-loc-test',
          title: 'Cyberpunk 2077',
          sortTitle: 'Cyberpunk 2077',
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1091500',
              installed: false,
              storePlatforms: { windows: true, mac: false, linux: false },
            } as any,
            {
              platformId: 'gog',
              platformGameId: '1423049311',
              installed: false,
              storePlatforms: { windows: true, mac: false, linux: false },
            } as any,
          ],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        };

        const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
        const getInstallInfoSpy = vi
          .spyOn(launcherService, 'getGameInstallInfo')
          .mockImplementation(async (_game, platId) => {
            if (platId === 'steam') {
              return {
                platformId: 'steam',
                platformGameId: '1091500',
                hostPlatform: 'win32',
                estimatedSizeBytes: 60 * 1024 * 1024 * 1024,
                defaultInstallDir: primaryCommon,
                availableInstallDirs: [primaryCommon, secondaryCommon],
                availableInstallers: [
                  {
                    id: 'steam-win-native',
                    name: 'Cyberpunk 2077 (Steam Client — Windows Native)',
                    os: 'windows',
                    totalSizeBytes: 60 * 1024 * 1024 * 1024,
                  },
                ],
                canDirectDownload: false,
                requiresStoreClientFallback: true,
                diskSpace: {
                  freeBytes: 250 * 1024 * 1024 * 1024,
                  totalBytes: 500 * 1024 * 1024 * 1024,
                  usedBytes: 250 * 1024 * 1024 * 1024,
                },
              } as any;
            }
            return {
              platformId: 'gog',
              platformGameId: '1423049311',
              hostPlatform: 'win32',
              estimatedSizeBytes: 60 * 1024 * 1024 * 1024,
              defaultInstallDir: 'C:\\Games\\OneLauncher',
              availableInstallDirs: ['C:\\Games\\OneLauncher', 'D:\\GOG Games'],
              availableInstallers: [
                {
                  id: 'gog-win-native',
                  name: 'Cyberpunk 2077 — Windows Native Build',
                  os: 'windows',
                  totalSizeBytes: 60 * 1024 * 1024 * 1024,
                },
              ],
              canDirectDownload: true,
              requiresStoreClientFallback: false,
              diskSpace: {
                freeBytes: 250 * 1024 * 1024 * 1024,
                totalBytes: 500 * 1024 * 1024 * 1024,
                usedBytes: 250 * 1024 * 1024 * 1024,
              },
            } as any;
          });

        try {
          const renderModalForPlatform = async (platformId: 'steam' | 'gog') => {
            const states: any[] = [];
            const effects: boolean[] = [];
            const internals =
              (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
              (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
            const doRender = () => {
              let sIdx = 0;
              let eIdx = 0;
              const prevH = internals.H;
              internals.H = {
                useState(init: any) {
                  const idx = sIdx++;
                  if (idx >= states.length) {
                    states.push(typeof init === 'function' ? init() : init);
                  }
                  const setS = (upd: any) => {
                    states[idx] = typeof upd === 'function' ? upd(states[idx]) : upd;
                  };
                  return [states[idx], setS];
                },
                useEffect(fn: () => any) {
                  const idx = eIdx++;
                  if (!effects[idx]) {
                    effects[idx] = true;
                    fn();
                  }
                },
                useRef(init: any) {
                  return { current: init };
                },
                useMemo(fn: () => any) {
                  return fn();
                },
                useCallback(fn: any) {
                  return fn;
                },
              };
              try {
                const vnode = (GameInstallModal as any)({
                  isOpen: true,
                  game: testGame,
                  initialPlatformId: platformId,
                  onClose: vi.fn(),
                });
                const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
                return { vnode, html };
              } finally {
                internals.H = prevH;
              }
            };
            doRender();
            await new Promise((r) => setTimeout(r, 15));
            return doRender();
          };

          const getTextContent = (node: any): string => {
            if (node == null || typeof node === 'boolean') return '';
            if (typeof node === 'string' || typeof node === 'number') return String(node);
            if (Array.isArray(node)) return node.map(getTextContent).join('');
            if (node.props?.children) return getTextContent(node.props.children);
            return '';
          };
          const findElements = (node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] => {
            if (!node || typeof node !== 'object') return acc;
            if (Array.isArray(node)) {
              node.forEach((c) => findElements(c, predicate, acc));
              return acc;
            }
            if (predicate(node)) acc.push(node);
            if (node.props?.children) findElements(node.props.children, predicate, acc);
            return acc;
          };

          // Steam modal assertions
          const steamRendered = await renderModalForPlatform('steam');
          expect(steamRendered.html).toContain('data-testid="steam-managed-install-location"');
          expect(steamRendered.html).toContain('Managed by Steam Client');
          expect(steamRendered.html).toContain('data-testid="steam-library-location-display"');
          expect(steamRendered.html).not.toContain('data-testid="steam-library-drive-select"');

          const steamTextInputs = findElements(
            steamRendered.vnode,
            (el) => el.type === 'input' && el.props?.type === 'text'
          );
          expect(steamTextInputs).toHaveLength(0);
          const steamBrowseBtns = findElements(
            steamRendered.vnode,
            (el) => el.type === 'button' && getTextContent(el).includes('Browse...')
          );
          expect(steamBrowseBtns).toHaveLength(0);

          // GOG modal assertions
          const gogRendered = await renderModalForPlatform('gog');
          expect(gogRendered.html).not.toContain('data-testid="steam-managed-install-location"');
          expect(gogRendered.html).toContain('Installation Directory');

          const gogTextInputs = findElements(
            gogRendered.vnode,
            (el) => el.type === 'input' && el.props?.type === 'text'
          );
          expect(gogTextInputs.length).toBeGreaterThanOrEqual(1);
          const gogBrowseBtns = findElements(
            gogRendered.vnode,
            (el) => el.type === 'button' && getTextContent(el).includes('Browse...')
          );
          expect(gogBrowseBtns.length).toBeGreaterThanOrEqual(1);
        } finally {
          winHostSpy.mockRestore();
          getInstallInfoSpy.mockRestore();
        }
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Issue 3: parseSteamContentLogForApp resets stale download counters on update started / Uninstalled, and startSteamInstallMonitor ignores 100% pre-allocated downloading/<appId> files while advancing 0% -> 25% -> 60% -> 100%', async () => {
      // 3a. Verify parseSteamContentLogForApp resets historical download/stage counters when update started or Uninstalled appears
      const logWithHistoryAndReset = [
        '[2026-10-21 10:00:01] AppID 1091500 update started : download 0/50000000',
        '[2026-10-21 10:05:10] AppID 1091500 download 50000000/50000000',
        '[2026-10-21 10:05:12] AppID 1091500 stage 50000000/50000000',
        '[2026-10-21 10:05:15] AppID 1091500 state changed : Fully Installed,',
        '[2026-10-21 10:15:00] AppID 1091500 state changed : Uninstalled,',
        '[2026-10-21 10:20:00] AppID 1091500 update started :',
        '[2026-10-21 10:20:01] AppID 1091500 App update changed : Running Update, Preallocating,',
      ].join('\n');

      const parsedResetLog = launcherEngine.parseSteamContentLogForApp(
        logWithHistoryAndReset,
        '1091500'
      );
      expect(parsedResetLog.bytesDownloaded).toBe(0);
      expect(parsedResetLog.bytesToDownload).toBe(0);
      expect(parsedResetLog.bytesStaged).toBe(0);
      expect(parsedResetLog.bytesToStage).toBe(0);
      expect(parsedResetLog.fullyInstalled).toBe(false);
      expect(parsedResetLog.updateStarted).toBe(true);
      expect(parsedResetLog.isRunning).toBe(true);

      // 3b. Verify startSteamInstallMonitor never jumps to 99% when steamapps/downloading/<appId> has 100% preallocated sparse files
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-steam-prealloc-'));
      const tempUserData = path.join(tempDir, 'userData');
      const steamRoot = path.join(tempDir, 'Steam');
      const steamappsDir = path.join(steamRoot, 'steamapps');
      const appId = '1091500';
      const downloadingAppDir = path.join(steamappsDir, 'downloading', appId);
      const commonAppDir = path.join(steamappsDir, 'common', 'PreallocGame');
      fs.mkdirSync(downloadingAppDir, { recursive: true });
      fs.mkdirSync(tempUserData, { recursive: true });

      const totalGameBytes = 200000;
      // Write a pre-allocated file equal to 100% of totalGameBytes inside steamapps/downloading/<appId>
      fs.writeFileSync(
        path.join(downloadingAppDir, 'preallocated_depot.bin'),
        Buffer.alloc(totalGameBytes, 0)
      );

      const writeAcf = (bytesDownloaded: number, stateFlags: string) => {
        const acfContent = `"AppState"
{
	"appid"		"${appId}"
	"Universe"		"1"
	"name"		"PreallocGame"
	"StateFlags"		"${stateFlags}"
	"installdir"		"PreallocGame"
	"SizeOnDisk"		"${totalGameBytes}"
	"BytesToDownload"		"${totalGameBytes}"
	"BytesDownloaded"		"${bytesDownloaded}"
	"BytesToStage"		"${totalGameBytes}"
	"BytesStaged"		"${bytesDownloaded}"
}`;
        fs.writeFileSync(path.join(steamappsDir, `appmanifest_${appId}.acf`), acfContent, 'utf8');
      };

      // Initial state: Preallocating / starting download with BytesDownloaded = 0, StateFlags = 1026
      writeAcf(0, '1026');

      const monitorOptions = {
        platform: 'win32',
        homedir: tempDir,
        userDataDir: tempUserData,
        customRoots: [steamRoot],
        steamPollIntervalMs: 20,
      };

      try {
        const installRes = await launcherEngine.installGame(
          {
            gameId: 'steam-prealloc-test',
            title: 'PreallocGame',
            platformId: 'steam',
            platformGameId: appId,
            steamAppId: Number(appId),
            totalBytes: totalGameBytes,
            manualControl: true,
          },
          monitorOptions
        );
        expect(installRes.success).toBe(true);
        const taskId = installRes.task.taskId;

        launcherEngine.startSteamInstallMonitor(taskId, appId, monitorOptions);

        // Wait for monitor ticks with BytesDownloaded = 0 while downloading/<appId> has 100% preallocated size
        await new Promise((r) => setTimeout(r, 60));
        let currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask).toBeDefined();
        expect(currentTask.progressPercent).toBe(0);
        expect(currentTask.bytesDownloaded).toBe(0);
        expect(currentTask.status).toBe('downloading');

        // Advance ACF to 25% (50,000 / 200,000)
        writeAcf(50000, '1026');
        await new Promise((r) => setTimeout(r, 60));
        currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask.progressPercent).toBe(25);
        expect(currentTask.bytesDownloaded).toBe(50000);

        // Advance ACF to 60% (120,000 / 200,000)
        writeAcf(120000, '1026');
        await new Promise((r) => setTimeout(r, 60));
        currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask.progressPercent).toBe(60);
        expect(currentTask.bytesDownloaded).toBe(120000);

        // Complete installation: create common/PreallocGame with .exe and set BytesDownloaded = 200,000, StateFlags = 4
        fs.mkdirSync(commonAppDir, { recursive: true });
        fs.writeFileSync(path.join(commonAppDir, 'PreallocGame.exe'), 'MZ-win64-pe');
        writeAcf(totalGameBytes, '4');
        await new Promise((r) => setTimeout(r, 60));

        currentTask = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
        expect(currentTask.status).toBe('completed');
        expect(currentTask.progressPercent).toBe(100);
        expect(currentTask.finalInstallPath).toBe(commonAppDir);
      } finally {
        launcherEngine.clearDownloadQueue();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('detects older libMoltenVK.dylib _GLOBAL__sub_I_mvk_datatypes.mm deadlock symbol, keeps MTL_HUD_ENABLED=1 while injecting libone_metal_preload.dylib, cleans up when metalHud is false, and resolves adjacent/parent wineserver binaries', () => {
      const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-mvk-hud-test-'));
      try {
        // 1. Wine distribution WITH _GLOBAL__sub_I_mvk_datatypes.mm in lib/libMoltenVK.dylib
        const legacyWineRoot = path.join(mockRoot, 'wine-legacy');
        const legacyWineBin = path.join(legacyWineRoot, 'bin', 'wine64');
        const legacyWineserver = path.join(legacyWineRoot, 'bin', 'wineserver');
        const legacyMvkDylib = path.join(legacyWineRoot, 'lib', 'libMoltenVK.dylib');
        writeTempFile(legacyWineBin, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(legacyWineserver, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(
          legacyMvkDylib,
          'FAKE_MACHO_HEADER\0__TEXT\0_GLOBAL__sub_I_mvk_datatypes.mm\0MTLRegisterDevices\0'
        );

        // 2. Wine distribution WITHOUT _GLOBAL__sub_I_mvk_datatypes.mm in lib/external/libMoltenVK.dylib
        const modernWineRoot = path.join(mockRoot, 'wine-modern');
        const modernWineBin = path.join(modernWineRoot, 'lib', 'wine', 'x86_64-unix', 'wine');
        const modernWineserver = path.join(modernWineRoot, 'lib', 'wine', 'bin', 'wineserver64');
        const modernMvkDylib = path.join(
          modernWineRoot,
          'lib',
          'wine',
          'lib',
          'external',
          'libMoltenVK.dylib'
        );
        writeTempFile(modernWineBin, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(modernWineserver, '#!/bin/sh\nexit 0\n', 0o755);
        writeTempFile(modernMvkDylib, 'FAKE_MACHO_HEADER\0__TEXT\0mvkCreateInstance\0');

        launcherEngine.invalidateScanCaches();

        // Verify resolveWineLayerMoltenVkPath & ensureWineMetalPreloadDylib
        expect(launcherEngine.resolveWineLayerMoltenVkPath(legacyWineBin)).toBe(legacyMvkDylib);
        expect(launcherEngine.resolveWineLayerMoltenVkPath(modernWineBin)).toBe(modernMvkDylib);
        const preloadDylib = launcherEngine.ensureWineMetalPreloadDylib({ userDataDir });
        expect(preloadDylib).toBeTruthy();
        expect(preloadDylib).toContain('libone_metal_preload.dylib');
        expect(fs.existsSync(preloadDylib)).toBe(true);

        // Verify doesWineLayerHaveMoltenVkHudDeadlock
        expect(launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock(legacyWineBin)).toBe(true);
        expect(
          launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock({ binaryPath: legacyWineBin })
        ).toBe(true);
        expect(launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock(modernWineBin)).toBe(false);
        expect(
          launcherEngine.doesWineLayerHaveMoltenVkHudDeadlock({ binaryPath: modernWineBin })
        ).toBe(false);

        // Verify applyCrossOverPerGameSettings keeps MTL_HUD_ENABLED='1' and injects libone_metal_preload.dylib + ONE_LAUNCHER_MOLTENVK_PATH when deadlock symbol is present
        const legacyBottle = path.join(mockRoot, 'bottle-legacy');
        fs.mkdirSync(legacyBottle, { recursive: true });
        const legacyEnv: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'wine', binaryPath: legacyWineBin },
          { metalHud: true },
          legacyEnv,
          legacyBottle,
          { userDataDir }
        );
        expect(legacyEnv.MTL_HUD_ENABLED).toBe('1');
        expect(legacyEnv.DYLD_INSERT_LIBRARIES).toContain('libone_metal_preload.dylib');
        expect(legacyEnv.ONE_LAUNCHER_MOLTENVK_PATH).toBe(legacyMvkDylib);

        // Verify applyCrossOverPerGameSettings cleans up MTL_HUD_ENABLED, ONE_LAUNCHER_MOLTENVK_PATH, and libone_metal_preload.dylib when metalHud is false
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'wine', binaryPath: legacyWineBin },
          { metalHud: false },
          legacyEnv,
          legacyBottle,
          { userDataDir }
        );
        expect(legacyEnv.MTL_HUD_ENABLED).toBeUndefined();
        expect(legacyEnv.ONE_LAUNCHER_MOLTENVK_PATH).toBeUndefined();
        expect(legacyEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();

        // Verify applyCrossOverPerGameSettings sets MTL_HUD_ENABLED='1' without preload dylib when deadlock symbol is NOT present
        const modernBottle = path.join(mockRoot, 'bottle-modern');
        fs.mkdirSync(modernBottle, { recursive: true });
        const modernEnv: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'crossover', binaryPath: modernWineBin },
          { metalHud: true },
          modernEnv,
          modernBottle,
          { userDataDir }
        );
        expect(modernEnv.MTL_HUD_ENABLED).toBe('1');
        expect(modernEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();
        expect(modernEnv.ONE_LAUNCHER_MOLTENVK_PATH).toBeUndefined();

        // Verify resolveWineserverBinary resolves both adjacent bin/wineserver and ../bin/wineserver64
        expect(launcherEngine.resolveWineserverBinary(legacyWineBin)).toBe(legacyWineserver);
        expect(launcherEngine.resolveWineserverBinary(modernWineBin)).toBe(modernWineserver);
        expect(launcherEngine.resolveWineserverBinary(legacyWineserver)).toBe(legacyWineserver);
      } finally {
        try {
          fs.rmSync(mockRoot, { recursive: true, force: true });
        } catch {}
      }
    });

    it('resolves host display bounds via getHostMaxDisplayResolution and clamps out-of-bounds Retina-doubled .cfg and .ini resolutions via sanitizeWinePrefixDisplayConfigs idempotently', () => {
      const mockPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-display-sanitize-'));
      try {
        // 1. Verify getHostMaxDisplayResolution(true) vs getHostMaxDisplayResolution(false)
        const hiRes = launcherEngine.getHostMaxDisplayResolution(true, {
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
        });
        expect(hiRes.width).toBe(3024);
        expect(hiRes.height).toBe(1964);
        expect(hiRes.logicalWidth).toBe(1512);
        expect(hiRes.logicalHeight).toBe(982);

        const loRes = launcherEngine.getHostMaxDisplayResolution(false, {
          maxWidth: 3024,
          maxHeight: 1964,
          logicalWidth: 1512,
          logicalHeight: 982,
        });
        expect(loRes.width).toBe(1512);
        expect(loRes.height).toBe(982);

        const hostResLive = launcherEngine.getHostMaxDisplayResolution(true);
        expect(hostResLive.width).toBeGreaterThanOrEqual(1280);
        expect(hostResLive.height).toBeGreaterThanOrEqual(720);
        const hostResLogicalLive = launcherEngine.getHostMaxDisplayResolution(false);
        expect(hostResLogicalLive.width).toBeGreaterThanOrEqual(640);
        expect(hostResLogicalLive.width).toBeLessThanOrEqual(hostResLive.width);

        // 2. Create a temporary Wine prefix with an out-of-bounds .cfg and .ini file
        const cfgFile = path.join(
          mockPrefix,
          'drive_c/users/crossover/Saved Games/SampleEngine/Game/kexengine.cfg'
        );
        writeTempFile(
          cfgFile,
          [
            'seta v_vsync "1"',
            'seta v_windowed "0"',
            'seta v_width "6048"',
            'seta v_height "3928"',
            'seta v_refresh "120"',
            '',
          ].join('\n')
        );

        const iniFile = path.join(
          mockPrefix,
          'drive_c/users/crossover/AppData/Local/SampleUEGame/Saved/Config/WindowsNoEditor/GameUserSettings.ini'
        );
        writeTempFile(
          iniFile,
          [
            '[/Script/Engine.GameUserSettings]',
            'ResolutionSizeX=7680',
            'ResolutionSizeY=4320',
            'LastUserConfirmedResolutionSizeX=7680',
            'LastUserConfirmedResolutionSizeY=4320',
            'FullscreenMode=0',
            '',
          ].join('\n')
        );

        const firstRun = launcherEngine.sanitizeWinePrefixDisplayConfigs(mockPrefix, {
          maxWidth: 3024,
          maxHeight: 1964,
          highResolutionMode: true,
        });
        expect(firstRun.maxWidth).toBe(3024);
        expect(firstRun.maxHeight).toBe(1964);
        expect(firstRun.sanitizedFiles).toHaveLength(2);

        const sanitizedCfgEntry = firstRun.sanitizedFiles.find(
          (f: any) => f.filePath === cfgFile
        );
        expect(sanitizedCfgEntry).toEqual({
          filePath: cfgFile,
          previousWidth: 6048,
          previousHeight: 3928,
          clampedWidth: 3024,
          clampedHeight: 1964,
        });

        const updatedCfgText = fs.readFileSync(cfgFile, 'utf8');
        expect(updatedCfgText).toContain('seta v_width "3024"');
        expect(updatedCfgText).toContain('seta v_height "1964"');
        expect(updatedCfgText).not.toContain('6048');

        const updatedIniText = fs.readFileSync(iniFile, 'utf8');
        expect(updatedIniText).toContain('ResolutionSizeX=3024');
        expect(updatedIniText).toContain('ResolutionSizeY=1964');
        expect(updatedIniText).toContain('LastUserConfirmedResolutionSizeX=3024');
        expect(updatedIniText).toContain('LastUserConfirmedResolutionSizeY=1964');

        // 3. Second run on already-clamped files must be idempotent (sanitizedFiles: [])
        const secondRun = launcherEngine.sanitizeWinePrefixDisplayConfigs(mockPrefix, {
          maxWidth: 3024,
          maxHeight: 1964,
          highResolutionMode: true,
        });
        expect(secondRun.sanitizedFiles).toEqual([]);
      } finally {
        try {
          fs.rmSync(mockPrefix, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});
