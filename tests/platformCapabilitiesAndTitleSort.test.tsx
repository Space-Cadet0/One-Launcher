import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

import {
  buildHostCapabilities,
  getHostCapabilities,
  resolveHostArch,
  resolveHostPlatform,
} from '../src/contracts/hostPlatform';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type CompatibilityLayerInfo,
  type LauncherPerformanceSettings,
} from '../src/contracts/launcher';
import { sanitizePerformanceSettings } from '../src/services/launcher/launchConfigStore';
import { launcherService } from '../src/services/launcher/launcherService';
import { buildEffectiveLaunchModePreview } from '../src/services/launcher/launchPolicyPreview';
import {
  compareGameTitles,
  getAlphabeticalTitleSortKey,
  sortByTitleKey,
} from '../src/services/common/titleSortUtils';
import {
  resolveMetalfxSpatialEligibility,
} from '../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { SettingsModal } from '../src/components/Settings/SettingsModal';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import { NativeOsBadges } from '../src/components/Common/NativeOsBadges';
import { SteamSidebarNotices } from '../src/components/SteamStoreDetail/SteamSidebarNotices';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { LibraryGridView } from '../src/components/Library/LibraryGridView';
import type { CanonicalGame } from '../src/contracts/game';
import type { GameCollection } from '../src/contracts/collection';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const securityAndPathUtils = require('../electron/launcher/securityAndPathUtils.cjs') as {
  ALLOWED_LAUNCHER_SETTINGS_KEYS: Set<string>;
  sanitizeLauncherSettingsPayload: (raw: Record<string, unknown>) => Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs') as {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS: Record<string, unknown>;
  sanitizeLauncherPerformanceSettings: (raw?: Record<string, unknown>) => Record<string, unknown>;
  getLauncherPerformanceSettings: (options?: { userDataDir?: string }) => Record<string, unknown>;
  saveLauncherPerformanceSettings: (
    settings?: Record<string, unknown>,
    options?: { userDataDir?: string }
  ) => Record<string, unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const macNativeInstallerAndCodesign = require('../electron/launcher/macNativeInstallerAndCodesign.cjs') as {
  checkCompatibilityLayerUpdates: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const ROOT_DIR = path.resolve(__dirname, '..');

function findByTestId(
  tree: unknown,
  testId: string
): React.ReactElement<Record<string, unknown>> | undefined {
  return findElements(
    tree,
    (el) => el.props?.['data-testid'] === testId
  )[0] as React.ReactElement<Record<string, unknown>> | undefined;
}

function createCrossOverLayerFixture(
  overrides: Partial<CompatibilityLayerInfo> = {}
): CompatibilityLayerInfo {
  return {
    id: 'crossover-main',
    type: 'crossover',
    name: 'CrossOver',
    binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    appPath: '/Applications/CrossOver.app',
    bottlesDir: '/tmp/synthetic-bottles',
    availableBottles: ['OneLauncher'],
    available: true,
    version: '26.0',
    d3dmetalVersion: '3.0',
    darwinKernelMajor: 25,
    supportsMetalFxDlssD3dMetal: true,
    supportsMetalFxDlssDxmt: true,
    bottleDetails: {
      OneLauncher: { wineArch: 'win64' },
    },
    ...overrides,
  };
}

function makeSimpleGame(
  id: string,
  title: string,
  platformGameId: string,
  overrides: Partial<CanonicalGame> = {}
): CanonicalGame {
  return makeCanonicalGameFixture({
    id,
    title,
    sortTitle: title,
    platforms: [{ platformId: 'steam', platformGameId, installed: false }],
    ...overrides,
  });
}

describe('Tasks 4, 5, 9 & 11: DXMT MetalFX Spatial UX, HostPlatformCapabilities & win32 Isolation, Burger Hint & Title Sort', () => {
  const globalRecord = globalThis as Record<string, unknown>;
  let prevWindow: unknown;
  let prevLocalStorage: unknown;
  let mockStorage: Storage;

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevLocalStorage = globalRecord.localStorage;
    mockStorage = createMemoryStorage();
    globalRecord.localStorage = mockStorage;
    globalRecord.window = {
      localStorage: mockStorage,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: vi.fn(() => true),
      electronAPI: {
        isElectron: true,
        platform: 'darwin',
        arch: 'arm64',
        detectCompatibilityLayers: vi.fn().mockResolvedValue([createCrossOverLayerFixture()]),
        checkCompatibilityLayerUpdates: vi.fn().mockResolvedValue({}),
        detectInstalledStorefrontClients: vi
          .fn()
          .mockResolvedValue({ steam: true, gog: false, epic: false, xbox: false }),
        saveGameLaunchConfig: vi.fn().mockResolvedValue({ success: true }),
        saveLauncherPerformanceSettings: vi
          .fn()
          .mockImplementation(async (s: LauncherPerformanceSettings) => ({
            success: true,
            settings: s,
          })),
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await launcherService.savePerformanceSettings({
      ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
    });
    if (prevWindow === undefined) {
      delete globalRecord.window;
    } else {
      globalRecord.window = prevWindow;
    }
    if (prevLocalStorage === undefined) {
      delete globalRecord.localStorage;
    } else {
      globalRecord.localStorage = prevLocalStorage;
    }
  });

  // ---------------------------------------------------------------------------
  // Task 4: DXMT MetalFX Spatial Upscaling Eligibility & Disabled-With-Reason UI
  // ---------------------------------------------------------------------------
  describe('Task 4: MetalFX Spatial Upscaling (DXMT-Only) Eligibility & UI', () => {
    it('classifies dxmt/auto as supported and d3dmetal/dxvk/wined3d as DXMT Only with clear reason', () => {
      expect(resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend: 'dxmt' })).toEqual({
        supported: true,
      });
      expect(resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend: 'auto' })).toEqual({
        supported: true,
        autoModeNote: true,
      });

      const d3d = resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend: 'd3dmetal' });
      expect(d3d.supported).toBe(false);
      expect(d3d.badge).toBe('DXMT Only');
      expect(d3d.reason).toContain('D3DMetal');
      expect(d3d.reason).toContain('DXMT');

      const dxvk = resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend: 'dxvk' });
      expect(dxvk.supported).toBe(false);
      expect(dxvk.badge).toBe('DXMT Only');
      expect(dxvk.reason).toContain('DXVK');

      const wined3d = resolveMetalfxSpatialEligibility({ crossoverGraphicsBackend: 'wined3d' });
      expect(wined3d.supported).toBe(false);
      expect(wined3d.badge).toBe('DXMT Only');
      expect(wined3d.reason).toContain('WineD3D');
    });

    it('keeps MetalFX Spatial visible and disabled across d3dmetal/dxvk/wined3d, parses DXMT_CONFIG fallback, and clears factor on non-DXMT save', async () => {
      const game = makeCanonicalGameFixture({
        id: 'synth-dxmt-spatial-game',
        title: 'Synthetic DXMT Spatial Title',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '888101',
            installed: true,
            installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/DxmtTest',
            executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/DxmtTest/Game.exe',
          },
        ],
      });

      const layer = createCrossOverLayerFixture();
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([layer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([layer]);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'steam',
        platformGameId: '888101',
        installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/DxmtTest',
        executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/DxmtTest/Game.exe',
        isWindowsBinaryOnMac: true,
      });
      // Legacy env-only config with DXMT_CONFIG factor
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover',
        crossoverGraphicsBackend: 'dxmt',
        environmentVariables: {
          DXMT_METALFX_SPATIAL_SWAPCHAIN: '1',
          DXMT_CONFIG: 'd3d11.metalSpatialUpscaleFactor = 1.5',
        },
      });
      const saveSpy = vi.spyOn(launcherService, 'saveLaunchConfig').mockResolvedValue(undefined);

      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: () => {},
      });

      try {
        renderer.render();
        await Promise.resolve();
        let tree = renderer.render();

        // Hydrated from DXMT_CONFIG regex fallback
        let spatialSelect = findByTestId(tree, 'metalfx-spatial-upscale-select');
        expect(spatialSelect).toBeDefined();
        expect(spatialSelect!.props.disabled).toBe(false);
        expect(spatialSelect!.props.value).toBe('1.5');
        expect(findByTestId(tree, 'metalfx-spatial-unavailable-badge')).toBeUndefined();

        // Check each non-DXMT backend keeps control visible, disabled, with proper label + badge + reason
        for (const [backendVal, expectedLabel] of [
          ['d3dmetal', 'Unavailable on D3DMetal'],
          ['dxvk', 'Unavailable on DXVK'],
          ['wined3d', 'Unavailable on WineD3D'],
        ] as const) {
          const backendSelect = findElements(
            tree,
            (el) => el.type === 'select' && el.props?.['aria-label'] === 'Graphics Backend'
          )[0];
          expect(backendSelect).toBeDefined();
          (backendSelect!.props.onChange as (e: { target: { value: string } }) => void)({
            target: { value: backendVal },
          });
          tree = renderer.render();
          spatialSelect = findByTestId(tree, 'metalfx-spatial-upscale-select');
          expect(spatialSelect).toBeDefined();
          expect(spatialSelect!.props.disabled).toBe(true);
          expect(spatialSelect!.props.value).toBe('');
          expect(getTextContent(spatialSelect)).toContain(expectedLabel);
          expect(getTextContent(findByTestId(tree, 'metalfx-spatial-unavailable-badge'))).toBe(
            'DXMT Only'
          );
          expect(getTextContent(findByTestId(tree, 'metalfx-spatial-upscale-hint'))).toContain(
            'DXMT'
          );
        }

        // Save while on wined3d -> metalfxSpatialUpscaleFactor MUST be cleared (undefined)
        const saveBtn = findByTestId(tree, 'launch-config-save-btn');
        expect(saveBtn).toBeDefined();
        await (saveBtn!.props.onClick as () => Promise<void>)();

        expect(saveSpy).toHaveBeenCalledTimes(1);
        const savedCfg = saveSpy.mock.calls[0][0];
        expect(savedCfg.metalfxSpatialUpscaleFactor).toBeUndefined();
      } finally {
        renderer.unmount();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Task 5: Centralized HostPlatformCapabilities & Native Windows (win32) Zero-Leak Sweep
  // ---------------------------------------------------------------------------
  describe('Task 5: HostPlatformCapabilities & Native Windows (win32) Isolation', () => {
    it('builds accurate capability flags across darwin/arm64, darwin/x64, win32/x64, and linux/x64', () => {
      const macArm = buildHostCapabilities('darwin', 'arm64');
      expect(macArm.isMac).toBe(true);
      expect(macArm.isWindows).toBe(false);
      expect(macArm.supportsWindowsTranslation).toBe(true);
      expect(macArm.supportsBottleDisplayScaler).toBe(true);
      expect(macArm.supportsMetalHud).toBe(true);
      expect(macArm.supportsDxvkHud).toBe(true);
      expect(macArm.supportsAppleSiliconArm64Runners).toBe(true);

      const macIntel = buildHostCapabilities('darwin', 'x64');
      expect(macIntel.supportsWindowsTranslation).toBe(true);
      expect(macIntel.supportsAppleSiliconArm64Runners).toBe(false);

      const win = buildHostCapabilities('win32', 'x64');
      expect(win.isWindows).toBe(true);
      expect(win.isMac).toBe(false);
      expect(win.supportsWindowsTranslation).toBe(false);
      expect(win.supportsBottleDisplayScaler).toBe(false);
      expect(win.supportsMetalHud).toBe(false);
      expect(win.supportsDxvkHud).toBe(true);
      expect(win.supportsAppleSiliconArm64Runners).toBe(false);

      const linux = buildHostCapabilities('linux', 'x64');
      expect(linux.isLinux).toBe(true);
      expect(linux.supportsWindowsTranslation).toBe(false);
      expect(linux.supportsBottleDisplayScaler).toBe(false);
      expect(linux.supportsMetalHud).toBe(false);
      expect(linux.supportsDxvkHud).toBe(true);
      expect(linux.supportsAppleSiliconArm64Runners).toBe(false);
    });

    it('resolveHostPlatform honors explicit > electronAPI.platform > fallback darwin and NEVER reads process.platform', () => {
      expect(resolveHostPlatform('win32')).toBe('win32');
      expect(resolveHostPlatform('linux')).toBe('linux');
      expect(resolveHostPlatform('darwin')).toBe('darwin');

      (
        (globalRecord.window as Record<string, unknown>).electronAPI as Record<string, unknown>
      ).platform = 'win32';
      expect(resolveHostPlatform()).toBe('win32');

      // When electronAPI.platform is absent in Node/Vitest, must default to 'darwin' regardless of process.platform
      delete (
        (globalRecord.window as Record<string, unknown>).electronAPI as Record<string, unknown>
      ).platform;
      const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try {
        expect(resolveHostPlatform()).toBe('darwin');
        expect(getHostCapabilities().hostPlatform).toBe('darwin');
      } finally {
        if (origPlatformDesc) {
          Object.defineProperty(process, 'platform', origPlatformDesc);
        }
      }

      expect(resolveHostArch('x64')).toBe('x64');
      expect(resolveHostArch('arm64')).toBe('arm64');
    });

    it('launcherService.getHostCapabilities honors existing getHostPlatform / isWindowsHost / getHostArch spies', () => {
      vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(true);
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const winCaps = launcherService.getHostCapabilities();
      expect(winCaps.hostPlatform).toBe('win32');
      expect(winCaps.hostArch).toBe('x64');
      expect(winCaps.supportsWindowsTranslation).toBe(false);

      vi.restoreAllMocks();
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getHostArch').mockReturnValue('x64');
      const intelMacCaps = launcherService.getHostCapabilities();
      expect(intelMacCaps.hostPlatform).toBe('darwin');
      expect(intelMacCaps.supportsWindowsTranslation).toBe(true);
      expect(intelMacCaps.supportsAppleSiliconArm64Runners).toBe(false);
    });

    it('short-circuits detectCompatibilityLayers and checkCompatibilityLayerUpdates on win32 in renderer and Electron main', async () => {
      const api = (globalRecord.window as Record<string, unknown>).electronAPI as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      api.platform = 'win32' as unknown as ReturnType<typeof vi.fn>;

      const layers = await launcherService.detectCompatibilityLayers();
      const updates = await launcherService.checkCompatibilityLayerUpdates();

      expect(layers).toEqual([]);
      expect(updates).toEqual({});
      expect(api.detectCompatibilityLayers).not.toHaveBeenCalled();
      expect(api.checkCompatibilityLayerUpdates).not.toHaveBeenCalled();

      // Main process guard
      const mainUpdates = await macNativeInstallerAndCodesign.checkCompatibilityLayerUpdates({
        platform: 'win32',
        fetchFn: () => {
          throw new Error('Must not fetch updates on win32');
        },
      });
      expect(mainUpdates).toEqual({});
    });

    it('eliminates all win32 copy & event leaks across SettingsModal, GameLaunchConfigModal (uninstalled & installed), NativeOsBadges, TopNavBar, and SteamSidebarNotices', () => {
      const dispatchSpy = vi.fn(() => true);
      (globalRecord.window as Record<string, unknown>).dispatchEvent = dispatchSpy;
      (
        (globalRecord.window as Record<string, unknown>).electronAPI as Record<string, unknown>
      ).platform = 'win32';

      // 1. SettingsModal fallback event dispatches initialStep: 'prerequisites' on win32
      const settingsRenderer = createDomain12DeepRenderer(SettingsModal, {
        isOpen: true,
        onClose: () => {},
        hostPlatform: 'win32',
      });
      try {
        const tree = settingsRenderer.render();
        const setupBtn = findByTestId(tree, 'settings-open-runner-setup-btn');
        expect(setupBtn).toBeDefined();
        expect(getTextContent(setupBtn)).toBe('System Setup Wizard…');
        (setupBtn!.props.onClick as () => void)();
        const wizardEvent = dispatchSpy.mock.calls
          .map((c) => (c as unknown as [CustomEvent<{ initialStep: string }>])[0])
          .find((ev) => ev?.type === 'antigravity:open-setup-wizard');
        expect(wizardEvent?.detail?.initialStep).toBe('prerequisites');
      } finally {
        settingsRenderer.unmount();
      }

      // 2. Uninstalled game on win32: launchPolicyPreview + GameLaunchConfigModal + EnvironmentAndHooksSection
      const uninstalledGame = makeCanonicalGameFixture({
        id: 'win-uninstalled-1',
        title: 'Uninstalled Windows Game',
        platforms: [{ platformId: 'steam', platformGameId: '123456', installed: false }],
      });
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: uninstalledGame.id,
        preferredPlatformId: 'steam',
        launchMethod: 'direct',
      });

      const preview = buildEffectiveLaunchModePreview({
        game: uninstalledGame,
        preferredPlatformId: 'steam',
        hostPlatform: 'win32',
        layers: [],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });
      expect(preview.modeNotes.auto.dynamicDesc).toContain('native Windows pipeline');
      expect(preview.modeNotes.auto.dynamicDesc).not.toMatch(/CrossOver|compatibility layer/i);

      const uninstalledModalHtml = renderToString(
        <GameLaunchConfigModal
          isOpen={true}
          game={uninstalledGame}
          initialPlatformId="steam"
          onClose={() => {}}
        />
      );
      expect(uninstalledModalHtml).not.toMatch(/CrossOver|compatibility layer|D3DMetal|DXMT|MetalFX/i);

      // Installed Windows game: EnvironmentAndHooksSection uses Windows env placeholder (not Linux __GL_*)
      const installedWinGame = makeCanonicalGameFixture({
        id: 'win-installed-1',
        title: 'Installed Windows Game',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '654321',
            installed: true,
            installPath: 'C:\\Games\\InstalledWin',
            executablePath: 'C:\\Games\\InstalledWin\\Game.exe',
          },
        ],
      });
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'gog',
        platformGameId: '654321',
        installPath: 'C:\\Games\\InstalledWin',
        executablePath: 'C:\\Games\\InstalledWin\\Game.exe',
        isWindowsBinaryOnMac: false,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      const installedModalHtml = renderToString(
        <GameLaunchConfigModal
          isOpen={true}
          game={installedWinGame}
          initialPlatformId="gog"
          onClose={() => {}}
        />
      );
      expect(installedModalHtml).not.toMatch(/CrossOver|compatibility layer|D3DMetal|DXMT|MetalFX/i);
      expect(installedModalHtml).toContain('SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS=0');
      expect(installedModalHtml).not.toContain('__GL_THREADED_OPTIMIZATIONS');

      // 3. NativeOsBadges tooltip drops "(Compatibility layers excluded)" on win32
      const coverHtmlWin = renderToString(
        <NativeOsBadges platforms={['mac']} variant="cover-badge" />
      );
      const pillHtmlWin = renderToString(
        <NativeOsBadges platforms={['mac']} variant="detail-pill" />
      );
      expect(coverHtmlWin).toContain('title="Natively available on macOS"');
      expect(coverHtmlWin).not.toContain('Compatibility layers excluded');
      expect(pillHtmlWin).toContain('title="Natively available on macOS"');
      expect(pillHtmlWin).not.toContain('Compatibility layers excluded');

      // 4. SteamSidebarNotices suppresses macOS Bottle kernel anti-cheat notice on win32
      const antiCheatGame = makeCanonicalGameFixture({
        id: 'ac-win-1',
        title: 'Kernel Anti-Cheat Shooter',
        requiresKernelAntiCheat: true,
        kernelAntiCheatName: 'Easy Anti-Cheat',
        platforms: [{ platformId: 'steam', platformGameId: '555000', installed: false }],
      });
      const noticesHtmlWin = renderToString(
        <SteamSidebarNotices
          title={antiCheatGame.title}
          genres={antiCheatGame.genres}
          developers={antiCheatGame.developers}
          publishers={antiCheatGame.publishers}
          game={antiCheatGame}
          activePlatformId="steam"
        />
      );
      expect(noticesHtmlWin).not.toContain('macOS Bottle');

      // 5. NativeOsBadges keeps compatibility-layer wording on darwin
      (
        (globalRecord.window as Record<string, unknown>).electronAPI as Record<string, unknown>
      ).platform = 'darwin';
      const coverHtmlMac = renderToString(
        <NativeOsBadges platforms={['mac']} variant="cover-badge" />
      );
      expect(coverHtmlMac).toContain('Natively available on macOS (Compatibility layers excluded)');
    });
  });

  // ---------------------------------------------------------------------------
  // Task 11: Leading-"The" Alphabetical Sorting, 4-Point Lockstep & Live Reactivity
  // ---------------------------------------------------------------------------
  describe('Task 11: Leading-"The" Alphabetical Sorting & Settings Persistence', () => {
    it('computes strict word-boundary sort keys and deterministic tie-breakers across edge cases', () => {
      // Default ignoreLeadingThe = true
      expect(getAlphabeticalTitleSortKey('The Witcher 3: Wild Hunt')).toBe('Witcher 3: Wild Hunt');
      expect(getAlphabeticalTitleSortKey('the elder scrolls v')).toBe('elder scrolls v');
      expect(getAlphabeticalTitleSortKey('THE LAST OF US')).toBe('LAST OF US');
      expect(getAlphabeticalTitleSortKey('The   Long Dark')).toBe('Long Dark');
      expect(getAlphabeticalTitleSortKey('  The   Forest  ')).toBe('Forest');

      // Non-matching prefixes stay untouched
      expect(getAlphabeticalTitleSortKey('Theater of War')).toBe('Theater of War');
      expect(getAlphabeticalTitleSortKey("Them's Fightin' Herds")).toBe("Them's Fightin' Herds");
      expect(getAlphabeticalTitleSortKey('The')).toBe('The');
      expect(getAlphabeticalTitleSortKey('The   ')).toBe('The');
      expect(getAlphabeticalTitleSortKey('A Plague Tale: Innocence')).toBe(
        'A Plague Tale: Innocence'
      );
      expect(getAlphabeticalTitleSortKey('An Outcry')).toBe('An Outcry');
      expect(getAlphabeticalTitleSortKey('')).toBe('');
      expect(getAlphabeticalTitleSortKey(null)).toBe('');

      // Toggle OFF preserves raw title
      expect(getAlphabeticalTitleSortKey('The Witcher 3: Wild Hunt', false)).toBe(
        'The Witcher 3: Wild Hunt'
      );

      // Tie-breaker: "Forest" deterministically precedes "The Forest"
      expect(compareGameTitles('Forest', 'The Forest', { ignoreLeadingThe: true })).toBeLessThan(0);
      expect(compareGameTitles('The Forest', 'Forest', { ignoreLeadingThe: true })).toBeGreaterThan(
        0
      );

      const sample = [
        { id: '1', title: 'The Witcher 3: Wild Hunt' },
        { id: '2', title: 'Theater of War' },
        { id: '3', title: 'A Plague Tale: Innocence' },
        { id: '4', title: 'The Forest' },
        { id: '5', title: 'Forest' },
        { id: '6', title: 'Alan Wake 2' },
        { id: '7', title: 'The' },
        { id: '8', title: 'Wasteland 3' },
      ];

      const ignoredOrder = sortByTitleKey(sample, (g) => g.title, {
        ignoreLeadingThe: true,
        getId: (g) => g.id,
      }).map((g) => g.title);
      expect(ignoredOrder).toEqual([
        'A Plague Tale: Innocence',
        'Alan Wake 2',
        'Forest',
        'The Forest',
        'The',
        'Theater of War',
        'Wasteland 3',
        'The Witcher 3: Wild Hunt',
      ]);

      const strictOrder = sortByTitleKey(sample, (g) => g.title, {
        ignoreLeadingThe: false,
        getId: (g) => g.id,
      }).map((g) => g.title);
      expect(strictOrder).toEqual([
        'A Plague Tale: Innocence',
        'Alan Wake 2',
        'Forest',
        'The',
        'The Forest',
        'The Witcher 3: Wild Hunt',
        'Theater of War',
        'Wasteland 3',
      ]);
    });

    it('sorts 1,500 games deterministically with Schwartzian O(N) key precomputation', () => {
      const items = Array.from({ length: 1500 }, (_, i) => ({
        id: `game-${i}`,
        title: i % 3 === 0 ? `The Synthetic Title ${String(1500 - i).padStart(4, '0')}` : `Alpha ${String(i).padStart(4, '0')}`,
      }));

      const first = sortByTitleKey(items, (g) => g.title, {
        ignoreLeadingThe: true,
        getId: (g) => g.id,
      });
      const second = sortByTitleKey(items, (g) => g.title, {
        ignoreLeadingThe: true,
        getId: (g) => g.id,
      });

      expect(first).toHaveLength(1500);
      expect(first.map((g) => g.id)).toEqual(second.map((g) => g.id));
      expect(first[0].title).toBe('Alpha 0001');
      expect(first[first.length - 1].title).toBe('The Synthetic Title 1500');
    });

    it('round-trips ignoreLeadingTheWhenSorting across all 4 lockstep persistence modules including IPC allowlist', () => {
      expect(DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.ignoreLeadingTheWhenSorting).toBe(true);
      expect(sanitizePerformanceSettings({}).ignoreLeadingTheWhenSorting).toBe(true);
      expect(
        sanitizePerformanceSettings({ ignoreLeadingTheWhenSorting: false })
          .ignoreLeadingTheWhenSorting
      ).toBe(false);

      // Electron IPC allowlist (securityAndPathUtils.cjs)
      expect(
        securityAndPathUtils.ALLOWED_LAUNCHER_SETTINGS_KEYS.has('ignoreLeadingTheWhenSorting')
      ).toBe(true);
      expect(
        securityAndPathUtils.sanitizeLauncherSettingsPayload({
          ignoreLeadingTheWhenSorting: false,
        })
      ).toEqual({ ignoreLeadingTheWhenSorting: false });

      // Electron main-process disk persistence (engineStateRegistry.cjs)
      expect(
        engineStateRegistry.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.ignoreLeadingTheWhenSorting
      ).toBe(true);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-sort-pref-'));
      try {
        expect(
          engineStateRegistry.getLauncherPerformanceSettings({ userDataDir: tmpDir })
            .ignoreLeadingTheWhenSorting
        ).toBe(true);

        engineStateRegistry.saveLauncherPerformanceSettings(
          { ignoreLeadingTheWhenSorting: false },
          { userDataDir: tmpDir }
        );
        expect(
          engineStateRegistry.getLauncherPerformanceSettings({ userDataDir: tmpDir })
            .ignoreLeadingTheWhenSorting
        ).toBe(false);

        engineStateRegistry.saveLauncherPerformanceSettings(
          { reset: true },
          { userDataDir: tmpDir }
        );
        expect(
          engineStateRegistry.getLauncherPerformanceSettings({ userDataDir: tmpDir })
            .ignoreLeadingTheWhenSorting
        ).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('toggles Ignore Leading "The" in SettingsModal, marks dirty, saves, and resets to default true', async () => {
      const savePerfSpy = vi
        .spyOn(launcherService, 'savePerformanceSettings')
        .mockImplementation(async (patch) =>
          sanitizePerformanceSettings({ ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS, ...patch })
        );
      const onClose = vi.fn();

      const renderer = createDomain12DeepRenderer(SettingsModal, {
        isOpen: true,
        onClose,
        hostPlatform: 'darwin',
      });

      try {
        renderer.render();
        await Promise.resolve();
        let tree = renderer.render();

        const toggle = findByTestId(tree, 'settings-toggle-ignore-leading-the');
        expect(toggle).toBeDefined();
        expect(toggle!.props['aria-checked']).toBe(true);

        // Toggle OFF -> marks modal dirty
        (toggle!.props.onClick as () => void)();
        tree = renderer.render();
        expect(findByTestId(tree, 'settings-toggle-ignore-leading-the')!.props['aria-checked']).toBe(
          false
        );
        expect(findByTestId(tree, 'global-settings-modal')!.props.closedby).toBe('none');

        // Reset to Defaults restores true
        (findByTestId(tree, 'settings-reset-defaults-btn')!.props.onClick as () => void)();
        tree = renderer.render();
        expect(findByTestId(tree, 'settings-toggle-ignore-leading-the')!.props['aria-checked']).toBe(
          true
        );

        // Toggle OFF again and save
        (findByTestId(tree, 'settings-toggle-ignore-leading-the')!.props.onClick as () => void)();
        tree = renderer.render();
        const formEl = findElements(tree, (el) => el.type === 'form')[0];
        await (formEl.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({
          preventDefault: vi.fn(),
        });

        expect(savePerfSpy).toHaveBeenCalledWith(
          expect.objectContaining({ ignoreLeadingTheWhenSorting: false })
        );
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        renderer.unmount();
      }
    });

    it('reactively re-sorts LibrarySidebar (All Games, Uncategorized & Collections) and LibraryGridView when ignoreLeadingTheWhenSorting changes', async () => {
      const games: CanonicalGame[] = [
        makeSimpleGame('g-witcher', 'The Witcher 3: Wild Hunt', '292030'),
        makeSimpleGame('g-theater', 'Theater of War', '46290'),
        makeSimpleGame('g-alan', 'Alan Wake 2', '108710'),
        makeSimpleGame('g-wasteland', 'Wasteland 3', '719040'),
      ];
      const collections: GameCollection[] = [
        {
          id: 'col-rpg',
          name: 'RPGs',
          icon: 'star',
          gameIds: ['g-witcher', 'g-theater', 'g-wasteland'],
        },
      ];

      await launcherService.savePerformanceSettings({ ignoreLeadingTheWhenSorting: true });

      const sidebarRenderer = createDomain12DeepRenderer(LibrarySidebar, {
        games,
        selectedGameId: null,
        onSelectGame: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        collections,
        onOpenManageCollectionsModal: () => {},
        onToggleGameInCollection: () => {},
        connectedStorefronts: ['steam'],
      });

      const gridRenderer = createDomain12DeepRenderer(LibraryGridView, {
        games,
        onSelectGame: () => {},
        sortBy: 'alphabetical',
        connectedStorefronts: ['steam'],
      });

      try {
        // Default ON: "The Witcher 3" appears AFTER "Wasteland 3" (under W) in both Sidebar & Grid
        const sidebarOnText = getTextContent(sidebarRenderer.render());
        expect(sidebarOnText.indexOf('Theater of War')).toBeLessThan(
          sidebarOnText.indexOf('Wasteland 3')
        );
        expect(sidebarOnText.indexOf('Wasteland 3')).toBeLessThan(
          sidebarOnText.indexOf('The Witcher 3: Wild Hunt')
        );

        const gridOnText = getTextContent(gridRenderer.render());
        expect(gridOnText.indexOf('Alan Wake 2')).toBeLessThan(gridOnText.indexOf('Theater of War'));
        expect(gridOnText.indexOf('Theater of War')).toBeLessThan(
          gridOnText.indexOf('Wasteland 3')
        );
        expect(gridOnText.indexOf('Wasteland 3')).toBeLessThan(
          gridOnText.indexOf('The Witcher 3: Wild Hunt')
        );

        // Toggle OFF via launcherService.savePerformanceSettings -> live subscription re-sorts immediately
        await launcherService.savePerformanceSettings({ ignoreLeadingTheWhenSorting: false });

        const sidebarOffText = getTextContent(sidebarRenderer.render());
        expect(sidebarOffText.indexOf('The Witcher 3: Wild Hunt')).toBeLessThan(
          sidebarOffText.indexOf('Theater of War')
        );
        expect(sidebarOffText.indexOf('Theater of War')).toBeLessThan(
          sidebarOffText.indexOf('Wasteland 3')
        );

        const gridOffText = getTextContent(gridRenderer.render());
        expect(gridOffText.indexOf('Alan Wake 2')).toBeLessThan(
          gridOffText.indexOf('The Witcher 3: Wild Hunt')
        );
        expect(gridOffText.indexOf('The Witcher 3: Wild Hunt')).toBeLessThan(
          gridOffText.indexOf('Theater of War')
        );
        expect(gridOffText.indexOf('Theater of War')).toBeLessThan(
          gridOffText.indexOf('Wasteland 3')
        );
      } finally {
        sidebarRenderer.unmount();
        gridRenderer.unmount();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Zero TypeScript AnyKeyword AST Guard across all new & touched Wave 1 src/** files
  // ---------------------------------------------------------------------------
  describe('AST Guard: Zero AnyKeyword across all Wave 1 Platform & Sort src/** files', () => {
    it('contains zero TypeScript AnyKeyword nodes across all owned src/** modules', () => {
      const ownedSrcFiles = [
        'src/contracts/hostPlatform.ts',
        'src/services/common/titleSortUtils.ts',
        'src/contracts/launcher.ts',
        'src/services/launcher/launchConfigStore.ts',
        'src/services/launcher/launcherService.ts',
        'src/services/launcher/launchPolicyPreview.ts',
        'src/components/Launcher/LaunchConfig/CompatibilityLayerSection.tsx',
        'src/components/Launcher/LaunchConfig/useGameLaunchConfigForm.ts',
        'src/components/Launcher/GameLaunchConfigModal.tsx',
        'src/components/Launcher/LaunchConfig/EnvironmentAndHooksSection.tsx',
        'src/components/Settings/SettingsModal.tsx',
        'src/components/Navigation/TopNavBar.tsx',
        'src/components/Common/NativeOsBadges.tsx',
        'src/components/Library/MatchManager/MatchManagerRows.tsx',
        'src/components/SteamStoreDetail/SteamSidebarNotices.tsx',
        'src/components/Library/LibrarySidebar.tsx',
        'src/components/Library/LibraryGridView.tsx',
      ];

      const violations: string[] = [];
      for (const relPath of ownedSrcFiles) {
        const fullPath = path.join(ROOT_DIR, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const sf = ts.createSourceFile(
          fullPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          fullPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const visit = (node: ts.Node): void => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${pos.line + 1}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }

      expect(violations).toEqual([]);
    });
  });
});
