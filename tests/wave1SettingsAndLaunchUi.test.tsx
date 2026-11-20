import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  LAUNCH_PROFILE_KEYS,
  migrateLegacyHudConfig,
  resolveEffectivePerformanceHud,
  sanitizePerformanceHudMode,
  type CompatibilityLayerInfo,
  type GameLaunchConfig,
  type LauncherPerformanceSettings,
  type StorefrontLaunchProfile,
} from '../src/contracts/launcher';
import {
  extractStorefrontProfile,
  sanitizeGameLaunchConfig,
  sanitizePerformanceSettings,
} from '../src/services/launcher/launchConfigStore';
import { launcherService } from '../src/services/launcher/launcherService';
import { ModalShell } from '../src/components/Common/ModalShell';
import { SettingsModal } from '../src/components/Settings/SettingsModal';
import { TopNavBar } from '../src/components/Navigation/TopNavBar';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

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
    availableBottles: ['OneLauncher', 'SteamBottle'],
    available: true,
    version: '26.0',
    d3dmetalVersion: '3.0',
    darwinKernelMajor: 25,
    supportsMetalFxDlssD3dMetal: true,
    supportsMetalFxDlssDxmt: true,
    bottleDetails: {
      OneLauncher: { wineArch: 'win64' },
      SteamBottle: { wineArch: 'win64' },
    },
    ...overrides,
  };
}

describe('Wave 1: Global SettingsModal, TopNavBar Settings, Streamlined GameLaunchConfigModal & Unified Performance HUD', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
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
  // 1. Contracts, 11-Key Parity, LAUNCH_PROFILE_KEYS & HUD Migration Truth Table
  // ---------------------------------------------------------------------------
  describe('1. Contracts, 11-Key LauncherPerformanceSettings & migrateLegacyHudConfig()', () => {
    it('defines exact 11 keys in DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS and sanitizePerformanceSettings()', () => {
      const expectedKeys = [
        'inGameLauncherBehavior',
        'postGameLauncherBehavior',
        'pauseBackgroundSyncInGame',
        'pauseDownloadsInGame',
        'storefrontClientLifecycle',
        'autoShutdownWinePrefixOnExit',
        'suppressWineDebugLogging',
        'defaultBottleDisplayScalingMode',
        'defaultDisplayAspectRatio',
        'enableFullscreenHotkey',
        'defaultPerformanceHud',
      ];
      expect(Object.keys(DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS).sort()).toEqual(
        [...expectedKeys].sort()
      );
      expect(DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.defaultPerformanceHud).toBe(false);

      const sanitizedDefault = sanitizePerformanceSettings(null);
      expect(Object.keys(sanitizedDefault).sort()).toEqual([...expectedKeys].sort());
      expect(sanitizedDefault.defaultPerformanceHud).toBe(false);

      // Legacy dead keys enableMetalHud / enableMangoHud migrate once to defaultPerformanceHud: true
      const migratedLegacy = sanitizePerformanceSettings({
        enableMetalHud: true,
      } as unknown as Partial<LauncherPerformanceSettings>);
      expect(migratedLegacy.defaultPerformanceHud).toBe(true);
      expect('enableMetalHud' in migratedLegacy).toBe(false);
    });

    it('places performanceHud immediately after dxvkHud in LAUNCH_PROFILE_KEYS and keeps deprecated keys for lossless migration', () => {
      const dxvkIdx = LAUNCH_PROFILE_KEYS.indexOf('dxvkHud');
      const perfHudIdx = LAUNCH_PROFILE_KEYS.indexOf('performanceHud');
      const metalIdx = LAUNCH_PROFILE_KEYS.indexOf('metalHud');
      expect(metalIdx).toBeGreaterThan(-1);
      expect(dxvkIdx).toBeGreaterThan(-1);
      expect(perfHudIdx).toBe(dxvkIdx + 1);
      expect(LAUNCH_PROFILE_KEYS.length).toBe(32);

      // New UI save omits metalHud/dxvkHud and persists performanceHud
      const extracted = extractStorefrontProfile({
        launchMethod: 'auto',
        performanceHud: 'on',
      });
      expect(extracted.performanceHud).toBe('on');
      expect('metalHud' in extracted).toBe(false);
      expect('dxvkHud' in extracted).toBe(false);
    });

    it('migrates all 6 legacy (metalHud, dxvkHud, performanceHud) states losslessly and idempotently', () => {
      // 1. Existing valid performanceHud is authoritative & idempotent
      const explicitOff = migrateLegacyHudConfig({
        performanceHud: 'off',
        metalHud: true,
        dxvkHud: true,
      });
      expect(explicitOff.performanceHud).toBe('off');
      expect(migrateLegacyHudConfig(explicitOff)).toBe(explicitOff);

      const explicitOn = migrateLegacyHudConfig({ performanceHud: 'on' });
      expect(explicitOn.performanceHud).toBe('on');
      expect(migrateLegacyHudConfig(explicitOn)).toBe(explicitOn);

      const explicitDefault = migrateLegacyHudConfig({ performanceHud: 'default' });
      expect(explicitDefault.performanceHud).toBe('default');
      expect(migrateLegacyHudConfig(explicitDefault)).toBe(explicitDefault);

      // 2. metalHud: true + dxvkHud: false (Bug A legacy config) -> 'on'
      expect(migrateLegacyHudConfig({ metalHud: true, dxvkHud: false }).performanceHud).toBe('on');

      // 3. metalHud: true + dxvkHud: true (double-overlay legacy config) -> 'on'
      expect(migrateLegacyHudConfig({ metalHud: true, dxvkHud: true }).performanceHud).toBe('on');

      // 4. metalHud: false + dxvkHud: true -> 'on'
      expect(migrateLegacyHudConfig({ metalHud: false, dxvkHud: true }).performanceHud).toBe('on');

      // 5. Legacy metalHud: false / dxvkHud: false (saved unconditionally pre-Wave-1) -> 'default'
      expect(migrateLegacyHudConfig({ metalHud: false, dxvkHud: false }).performanceHud).toBe('default');
      expect(migrateLegacyHudConfig({ metalHud: false }).performanceHud).toBe('default');

      // 6. Legacy dxvkHud: false + metalHud: undefined -> 'default'
      expect(migrateLegacyHudConfig({ dxvkHud: false }).performanceHud).toBe('default');

      // 7. Both undefined -> 'default'
      expect(migrateLegacyHudConfig({}).performanceHud).toBe('default');

      // Sanitizer helper rejects invalid values
      expect(sanitizePerformanceHudMode('invalid')).toBeUndefined();
      expect(sanitizePerformanceHudMode('ON')).toBe('on');
    });

    it('resolves effective HUD boolean across per-game overrides, legacy profiles, and global default', () => {
      expect(resolveEffectivePerformanceHud({ performanceHud: 'on' }, { defaultPerformanceHud: false })).toBe(true);
      expect(resolveEffectivePerformanceHud({ performanceHud: 'off' }, { defaultPerformanceHud: true })).toBe(false);
      expect(resolveEffectivePerformanceHud({ performanceHud: 'default' }, { defaultPerformanceHud: true })).toBe(true);
      expect(resolveEffectivePerformanceHud({ performanceHud: 'default' }, { defaultPerformanceHud: false })).toBe(false);
      expect(resolveEffectivePerformanceHud({ metalHud: true, dxvkHud: false }, { defaultPerformanceHud: false })).toBe(true);
      expect(resolveEffectivePerformanceHud({ metalHud: false, dxvkHud: false }, { defaultPerformanceHud: true })).toBe(true);
      expect(resolveEffectivePerformanceHud({ metalHud: false, dxvkHud: false }, { defaultPerformanceHud: false })).toBe(false);
      expect(resolveEffectivePerformanceHud(undefined, { defaultPerformanceHud: true })).toBe(true);
      expect(resolveEffectivePerformanceHud(null, null)).toBe(false);

      // sanitizeGameLaunchConfig migrates both top-level and nested platformConfigs on read
      const sanitized = sanitizeGameLaunchConfig({
        gameId: 'synth-hud-migration',
        launchMethod: 'auto',
        metalHud: true,
        dxvkHud: false,
        platformConfigs: {
          steam: { launchMethod: 'auto', metalHud: false, dxvkHud: false },
          gog: { launchMethod: 'auto', performanceHud: 'off' },
        },
      });
      expect(sanitized.performanceHud).toBe('on');
      expect(sanitized.platformConfigs?.steam?.performanceHud).toBe('default');
      expect(sanitized.platformConfigs?.gog?.performanceHud).toBe('off');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. ModalShell onCloseAttemptWhilePrevented & Non-Shifting Dirty-Form Guard
  // ---------------------------------------------------------------------------
  describe('2. ModalShell onCloseAttemptWhilePrevented (closedby="none", Escape & Backdrop)', () => {
    it('fires onCloseAttemptWhilePrevented on Escape, cancel, and backdrop click when preventClose=true without closing', () => {
      const onClose = vi.fn();
      const onAttempt = vi.fn();
      const renderer = createDomain12DeepRenderer(ModalShell, {
        isOpen: true,
        onClose,
        preventClose: true,
        closeOnBackdrop: true,
        onCloseAttemptWhilePrevented: onAttempt,
        ariaLabelledBy: 'test-dialog-title',
        testId: 'test-modal-dialog',
        children: React.createElement('h2', { id: 'test-dialog-title' }, 'Test Modal'),
      });

      try {
        const tree = renderer.render();
        const dialog = findByTestId(tree, 'test-modal-dialog');
        expect(dialog).toBeDefined();
        expect(dialog!.props.closedby).toBe('none');
        expect(dialog!.props['aria-labelledby']).toBe('test-dialog-title');
        expect(dialog!.props['aria-label']).toBeUndefined();
        expect(dialog!.props.role).toBeUndefined();
        expect(dialog!.props['aria-modal']).toBeUndefined();

        // 1. Pressing Escape while preventClose=true fires onCloseAttemptWhilePrevented
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        (dialog!.props.onKeyDown as (e: Record<string, unknown>) => void)({
          key: 'Escape',
          defaultPrevented: false,
          preventDefault,
          stopPropagation,
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onAttempt).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();

        // 2. Escape during active IME composition is ignored
        (dialog!.props.onKeyDown as (e: Record<string, unknown>) => void)({
          key: 'Escape',
          isComposing: true,
          defaultPrevented: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(onAttempt).toHaveBeenCalledTimes(1);

        // 3. Clicking the backdrop (target === dialogRef.current) fires onCloseAttemptWhilePrevented
        const hostDialog = renderer.getHostElementByTestId('test-modal-dialog')!;
        expect(hostDialog).toBeDefined();
        (hostDialog as unknown as Record<string, unknown>).getBoundingClientRect = () => ({
          left: 100,
          right: 500,
          top: 80,
          bottom: 420,
          width: 400,
          height: 340,
        });
        (dialog!.props.onPointerDown as (e: Record<string, unknown>) => void)({
          target: hostDialog,
          currentTarget: hostDialog,
          clientX: 20,
          clientY: 20,
        });
        (dialog!.props.onClick as (e: Record<string, unknown>) => void)({
          target: hostDialog,
          currentTarget: hostDialog,
          clientX: 20,
          clientY: 20,
        });
        expect(onAttempt).toHaveBeenCalledTimes(2);
        expect(onClose).not.toHaveBeenCalled();

        // 4. Native cancel event while preventClose=true also fires onCloseAttemptWhilePrevented
        const cancelEvent = { type: 'cancel', target: hostDialog, preventDefault: vi.fn() };
        hostDialog.dispatchEvent(cancelEvent);
        expect(cancelEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(onAttempt).toHaveBeenCalledTimes(3);
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        renderer.unmount();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Dedicated Global SettingsModal + Decoupled Persistence
  // ---------------------------------------------------------------------------
  describe('3. Dedicated Global SettingsModal (macOS, Windows, Decoupled Persistence & Dirty Guard)', () => {
    it('renders all 11 global settings on macOS, decouples suppressWineDebugLogging, and NEVER mutates per-game configs on save', async () => {
      const initialPerf: LauncherPerformanceSettings = {
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
        autoShutdownWinePrefixOnExit: true,
        suppressWineDebugLogging: true,
        defaultPerformanceHud: false,
      };
      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue(initialPerf);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        createCrossOverLayerFixture(),
      ]);
      const savePerfSpy = vi
        .spyOn(launcherService, 'savePerformanceSettings')
        .mockImplementation(async (patch) => sanitizePerformanceSettings({ ...initialPerf, ...patch }));
      const saveGameCfgSpy = vi.spyOn(launcherService, 'saveLaunchConfig');

      const onClose = vi.fn();
      const onOpenRunnerSetup = vi.fn();
      const onOpenIntegrations = vi.fn();

      const renderer = createDomain12DeepRenderer(SettingsModal, {
        isOpen: true,
        onClose,
        onOpenRunnerSetup,
        onOpenIntegrations,
        hostPlatform: 'darwin',
      });

      try {
        renderer.render();
        await Promise.resolve();
        let tree = renderer.render();
        const modal = findByTestId(tree, 'global-settings-modal');
        expect(modal).toBeDefined();
        expect(modal!.props['aria-labelledby']).toBe('global-settings-modal-title');
        expect(modal!.props.closedby).toBe('any');

        // Both General and macOS Bottle sections render on darwin
        expect(findByTestId(tree, 'settings-section-general')).toBeDefined();
        expect(findByTestId(tree, 'settings-section-macos-bottle')).toBeDefined();
        expect(findByTestId(tree, 'settings-runners-summary-card')).toBeDefined();

        // Accurate hotkey copy (NOT misleading "global macOS shortcuts")
        const macText = getTextContent(findByTestId(tree, 'settings-section-macos-bottle'));
        expect(macText).toContain('Ctrl+Option+F');
        expect(macText).toContain('display-scaled legacy Windows games');
        expect(macText).not.toContain('Registers global macOS shortcuts');

        // macOS HUD description mentions Apple Metal HUD with automatic DXVK fallback
        const generalText = getTextContent(findByTestId(tree, 'settings-section-general'));
        expect(generalText).toContain('Apple Metal HUD');
        expect(generalText).toContain('DXVK fallback');

        // Reserved-space confirmation bar keeps an always-exposed role="status" aria-live="polite"
        // live region (empty until triggered) while Discard Changes button uses visibility: hidden + tabIndex=-1
        const confirmBarBefore = findByTestId(tree, 'settings-unsaved-confirm-bar');
        const liveRegionBefore = findElements(
          confirmBarBefore!,
          (el) => el.props.role === 'status' && el.props['aria-live'] === 'polite'
        )[0];
        const discardBtnBefore = findByTestId(tree, 'settings-discard-changes-btn');
        expect(String(confirmBarBefore!.props.className || '')).toContain('min-h-[34px]');
        expect(confirmBarBefore!.props['aria-hidden']).toBeUndefined();
        expect(liveRegionBefore).toBeDefined();
        expect(liveRegionBefore.props['aria-hidden']).toBeUndefined();
        expect(liveRegionBefore.props.style).toBeUndefined();
        expect(getTextContent(liveRegionBefore)).toBe('');
        expect((discardBtnBefore!.props.style as Record<string, string>).visibility).toBe('hidden');
        expect(discardBtnBefore!.props.tabIndex).toBe(-1);
        expect(discardBtnBefore!.props['aria-hidden']).toBe(true);

        // Toggle defaultPerformanceHud ON and autoShutdownWinePrefixOnExit OFF
        const hudSwitch = findByTestId(tree, 'settings-toggle-default-performance-hud');
        (hudSwitch!.props.onClick as () => void)();
        tree = renderer.render();

        const autoShutdownSwitch = findByTestId(tree, 'settings-toggle-auto-shutdown-wine');
        (autoShutdownSwitch!.props.onClick as () => void)();
        tree = renderer.render();

        // Dirty guard now active: closedby="none" and close attempt reveals confirmation bar without closing
        const dirtyModal = findByTestId(tree, 'global-settings-modal');
        expect(dirtyModal!.props.closedby).toBe('none');
        (dirtyModal!.props.onKeyDown as (e: Record<string, unknown>) => void)({
          key: 'Escape',
          defaultPrevented: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        tree = renderer.render();
        expect(onClose).not.toHaveBeenCalled();

        const confirmBarAfter = findByTestId(tree, 'settings-unsaved-confirm-bar');
        const liveRegionAfter = findElements(
          confirmBarAfter!,
          (el) => el.props.role === 'status' && el.props['aria-live'] === 'polite'
        )[0];
        const discardBtnAfter = findByTestId(tree, 'settings-discard-changes-btn');
        expect(liveRegionAfter).toBeDefined();
        expect(getTextContent(liveRegionAfter)).toContain('You have unsaved changes.');
        expect((discardBtnAfter!.props.style as Record<string, string>).visibility).toBe('visible');
        expect(discardBtnAfter!.props.tabIndex).toBe(0);
        expect(discardBtnAfter!.props['aria-hidden']).toBe(false);

        // Quick shortcuts call respective callbacks
        (findByTestId(tree, 'settings-manage-runners-btn')!.props.onClick as () => void)();
        expect(onOpenRunnerSetup).toHaveBeenCalledTimes(1);
        (findByTestId(tree, 'settings-open-integrations-btn')!.props.onClick as () => void)();
        expect(onOpenIntegrations).toHaveBeenCalledTimes(1);

        // Save form: writes global settings with suppressWineDebugLogging preserved as true (decoupled!)
        // and NEVER calls saveLaunchConfig!
        const formEl = findElements(tree, (el) => el.type === 'form')[0];
        await (formEl.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({
          preventDefault: vi.fn(),
        });

        expect(savePerfSpy).toHaveBeenCalledTimes(1);
        expect(savePerfSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultPerformanceHud: true,
            autoShutdownWinePrefixOnExit: false,
            suppressWineDebugLogging: true,
          })
        );
        expect(saveGameCfgSpy).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        renderer.unmount();
      }
    });

    it('hides macOS bottle section and uses honest Windows DXVK HUD copy when hostPlatform="win32"', () => {
      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue({
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
      });

      const html = renderToString(
        <SettingsModal isOpen={true} onClose={() => {}} hostPlatform="win32" />
      );
      expect(html).toContain('data-testid="settings-section-general"');
      expect(html).not.toContain('data-testid="settings-section-macos-bottle"');
      expect(html).toContain('DXVK Performance HUD');
      expect(html).toContain('Vulkan / DXVK-wrapped games');
      expect(html).not.toContain('Apple Metal HUD');
    });

    it('discards unsaved changes without saving when Discard Changes is clicked', async () => {
      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue({
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
      });
      const savePerfSpy = vi.spyOn(launcherService, 'savePerformanceSettings');
      const onClose = vi.fn();

      const renderer = createDomain12DeepRenderer(SettingsModal, {
        isOpen: true,
        onClose,
        hostPlatform: 'win32',
      });
      try {
        renderer.render();
        await Promise.resolve();
        let tree = renderer.render();
        (findByTestId(tree, 'settings-toggle-default-performance-hud')!.props.onClick as () => void)();
        tree = renderer.render();

        // Attempt close via Cancel -> opens discard bar, does not close
        (findByTestId(tree, 'settings-cancel-btn')!.props.onClick as () => void)();
        tree = renderer.render();
        expect(onClose).not.toHaveBeenCalled();

        // Click Discard Changes -> closes without saving
        (findByTestId(tree, 'settings-discard-changes-btn')!.props.onClick as () => void)();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(savePerfSpy).not.toHaveBeenCalled();
      } finally {
        renderer.unmount();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. TopNavBar Settings… Menu Item (Windows File Menu & Burger Menu)
  // ---------------------------------------------------------------------------
  describe('4. TopNavBar Settings… Menu Item', () => {
    it('renders Settings… in burger menu (macOS ⌘,) and Windows File menu (Ctrl+,) with callback and event fallback', () => {
      const onOpenSettings = vi.fn();
      const macRenderer = createDomain12DeepRenderer(TopNavBar, {
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        presentStorefronts: ['steam'],
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        totalGamesCount: 5,
        filteredCount: 5,
        isSyncing: false,
        onTriggerSync: () => {},
        onHomeClick: () => {},
        onOpenIntegrations: () => {},
        onOpenSettings,
        defaultMenuOpen: true,
      });

      try {
        const tree = macRenderer.render();
        const burgerSettingsItem = findByTestId(tree, 'menu-open-settings');
        expect(burgerSettingsItem).toBeDefined();
        expect(getTextContent(burgerSettingsItem)).toContain('Settings…');
        expect(getTextContent(burgerSettingsItem)).toContain('⌘,');

        (burgerSettingsItem!.props.onClick as () => void)();
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
      } finally {
        macRenderer.unmount();
      }

      // Windows File menu + custom event fallback when onOpenSettings omitted
      const dispatchSpy = vi.fn(() => true);
      (globalRecord.window as Record<string, unknown>).dispatchEvent = dispatchSpy;
      (
        (globalRecord.window as Record<string, unknown>).electronAPI as Record<string, unknown>
      ).platform = 'win32';

      const winRenderer = createDomain12DeepRenderer(TopNavBar, {
        selectedPlatform: 'all',
        onSelectPlatform: () => {},
        presentStorefronts: ['steam'],
        installedOnly: false,
        onToggleInstalledOnly: () => {},
        totalGamesCount: 5,
        filteredCount: 5,
        isSyncing: false,
        onTriggerSync: () => {},
        onHomeClick: () => {},
        onOpenIntegrations: () => {},
      });

      try {
        let tree = winRenderer.render();
        const fileBtn = findByTestId(tree, 'win-menu-file');
        expect(fileBtn).toBeDefined();
        (fileBtn!.props.onClick as () => void)();
        tree = winRenderer.render();

        const winSettingsItem = findByTestId(tree, 'win-menu-settings');
        expect(winSettingsItem).toBeDefined();
        expect(getTextContent(winSettingsItem)).toContain('Settings…');
        expect(getTextContent(winSettingsItem)).toContain('Ctrl+,');

        (winSettingsItem!.props.onClick as () => void)();
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const dispatchedEvent = (dispatchSpy.mock.calls[0] as unknown as [Event])[0];
        expect(dispatchedEvent.type).toBe('antigravity:open-settings');
      } finally {
        winRenderer.unmount();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Simplified Per-Game GameLaunchConfigModal & LaunchConfig/*
  // ---------------------------------------------------------------------------
  describe('5. Streamlined GameLaunchConfigModal (Unified HUD, Native <details>, Preserved Features & Zero Global Mutation)', () => {
    it('renders unified 3-way Performance HUD, preserves metalfxSpatialUpscaleFactor & preferredMaxFrameRate, removes legacy bloat, and NEVER mutates global settings on save', async () => {
      const game = makeCanonicalGameFixture({
        id: 'synth-bottled-game',
        title: 'Synthetic Bottled Title',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999001',
            installed: true,
            installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Synth',
            executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Synth/Game.exe',
          },
        ],
      });

      const savedLegacyConfig: GameLaunchConfig = {
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'auto',
        compatibilityLayer: 'crossover',
        crossoverGraphicsBackend: 'dxmt',
        crossoverHighResolutionMode: true, // Legacy true -> normalizes to undefined with 0 override badge!
        metalHud: true, // Legacy Bug A state -> migrates to performanceHud: 'on'!
        dxvkHud: false,
        preferredMaxFrameRate: 120,
        metalfxSpatialUpscaleFactor: 1.5,
      };

      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue({
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
        defaultPerformanceHud: false,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(savedLegacyConfig);
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'steam',
        platformGameId: '999001',
        installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Synth',
        executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Synth/Game.exe',
        isWindowsBinaryOnMac: true,
        executableArchitecture: 'x64',
        is32BitExecutable: false,
      });

      const saveLaunchConfigSpy = vi
        .spyOn(launcherService, 'saveLaunchConfig')
        .mockResolvedValue(undefined);
      const savePerfSpy = vi.spyOn(launcherService, 'savePerformanceSettings');
      const onOpenGlobalSettings = vi.fn();
      const onOpenRunnerSetup = vi.fn();
      const onClose = vi.fn();

      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose,
        onOpenGlobalSettings,
        onOpenRunnerSetup,
      });

      try {
        renderer.render();
        await Promise.resolve();
        let tree = renderer.render();

        // Modal uses ariaLabelledBy (NOT ariaLabel)
        const dialog = findByTestId(tree, 'launch-config-modal-overlay');
        expect(dialog).toBeDefined();
        expect(dialog!.props['aria-labelledby']).toMatch(/dialog-title$/);
        expect(dialog!.props['aria-label']).toBeUndefined();

        // Legacy bloat completely removed
        expect(findByTestId(tree, 'toggle-metal-hud')).toBeUndefined();
        expect(findByTestId(tree, 'toggle-dxvk-hud')).toBeUndefined();
        expect(findByTestId(tree, 'global-gameplay-performance-card')).toBeUndefined();
        expect(findByTestId(tree, 'install-runner-brew-btn')).toBeUndefined();
        expect(findByTestId(tree, 'update-runner-btn')).toBeUndefined();
        expect(findByTestId(tree, 'sign-in-runner-btn')).toBeUndefined();
        expect(findElements(tree, (el) => el.type === 'section')).toHaveLength(0);

        // Compact 1-line runner status banner & Manage Runners button present
        expect(findByTestId(tree, 'runner-status-banner')).toBeDefined();
        const manageRunnersBtn = findByTestId(tree, 'manage-runners-bottles-btn');
        expect(manageRunnersBtn).toBeDefined();
        (manageRunnersBtn!.props.onClick as () => void)();
        expect(onOpenRunnerSetup).toHaveBeenCalledTimes(1);

        // Unified 3-way Performance HUD segmented radio present & migrated from metalHud:true -> 'on'
        const hudGroup = findByTestId(tree, 'performance-hud-group');
        expect(hudGroup).toBeDefined();
        expect(hudGroup!.type).toBe('fieldset');
        const hudDefaultLabel = findByTestId(tree, 'performance-hud-default');
        const hudOnLabel = findByTestId(tree, 'performance-hud-on');
        const hudOffLabel = findByTestId(tree, 'performance-hud-off');
        expect(getTextContent(hudDefaultLabel)).toContain('Global Default (Off)');
        const hudOnRadio = findElements(hudOnLabel, (el) => el.type === 'input')[0];
        expect(hudOnRadio.props.checked).toBe(true);

        // Preserved features: preferredMaxFrameRate & metalfxSpatialUpscaleFactor & crossoverDlss
        const fpsSelect = findByTestId(tree, 'preferred-max-fps-select');
        expect(fpsSelect).toBeDefined();
        expect(fpsSelect!.props.value).toBe('120');

        const spatialSelect = findByTestId(tree, 'metalfx-spatial-upscale-select');
        expect(spatialSelect).toBeDefined();
        expect(spatialSelect!.props.value).toBe('1.5');

        expect(findByTestId(tree, 'toggle-crossover-dlss')).toBeDefined();

        // Legacy crossoverHighResolutionMode: true normalized to undefined -> Legacy 96 DPI switch Off & 0 Display overrides!
        const legacy96Switch = findByTestId(tree, 'toggle-legacy-96dpi-mode');
        expect(legacy96Switch).toBeDefined();
        expect(legacy96Switch!.props['aria-checked']).toBe(false);
        expect(findByTestId(tree, 'disclosure-display-overrides-badge')).toBeUndefined();

        // Compatibility & Engine Tweaks controls render directly inside the main Compatibility & Graphics card (not collapsed in a <details> accordion)
        expect(findByTestId(tree, 'disclosure-compat-tweaks')).toBeUndefined();
        expect(findByTestId(tree, 'disclosure-compat-tweaks-badge')).toBeUndefined();
        const compatGraphicsCard = findByTestId(tree, 'compatibility-graphics-card');
        expect(compatGraphicsCard).toBeDefined();
        expect(findElements(compatGraphicsCard, (el) => el.type === 'details')).toHaveLength(0);
        expect(findByTestId(compatGraphicsCard, 'metalfx-spatial-upscale-select')).toBeDefined();
        expect(findByTestId(compatGraphicsCard, 'wine-sync-mode-group')).toBeDefined();
        expect(findByTestId(compatGraphicsCard, 'toggle-force-laa')).toBeDefined();
        expect(
          findElements(
            compatGraphicsCard,
            (el) =>
              el.type === 'input' &&
              typeof el.props?.id === 'string' &&
              el.props.id.endsWith('-wine-prefix-path')
          )
        ).toHaveLength(1);

        // All 3 remaining native <details> disclosures start collapsed and contain ZERO headings inside <summary>
        const detailsNodes = findElements(tree, (el) => el.type === 'details');
        expect(detailsNodes).toHaveLength(3);
        expect(detailsNodes.map((d) => d.props?.['data-testid'])).toEqual([
          'disclosure-display-overrides',
          'disclosure-execution-hooks',
          'disclosure-lifecycle-overrides',
        ]);
        for (const detailsEl of detailsNodes) {
          expect(detailsEl.props.open).toBeUndefined();
          const summaryEl = findElements(detailsEl, (el) => el.type === 'summary')[0];
          expect(summaryEl).toBeDefined();
          const forbiddenHeadings = findElements(
            summaryEl,
            (el) => typeof el.type === 'string' && /^h[1-6]$/.test(el.type)
          );
          expect(forbiddenHeadings).toHaveLength(0);
        }

        // Edit Global Defaults… button calls onOpenGlobalSettings
        const editGlobalBtn = findByTestId(tree, 'edit-global-defaults-btn');
        expect(editGlobalBtn).toBeDefined();
        (editGlobalBtn!.props.onClick as () => void)();
        expect(onOpenGlobalSettings).toHaveBeenCalledWith('general');

        // Change Performance HUD to 'off' -> triggers dirty state & non-shifting discard confirmation on Escape
        const hudOffRadio = findElements(hudOffLabel, (el) => el.type === 'input')[0];
        (hudOffRadio.props.onChange as () => void)();
        tree = renderer.render();

        const dirtyDialog = findByTestId(tree, 'launch-config-modal-overlay');
        expect(dirtyDialog!.props.closedby).toBe('none');
        (dirtyDialog!.props.onKeyDown as (e: Record<string, unknown>) => void)({
          key: 'Escape',
          defaultPrevented: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        tree = renderer.render();
        expect(onClose).not.toHaveBeenCalled();
        const launchConfirmBar = findByTestId(tree, 'launch-config-unsaved-confirm-bar');
        const launchLiveRegion = findElements(
          launchConfirmBar!,
          (el) => el.props.role === 'status' && el.props['aria-live'] === 'polite'
        )[0];
        expect(String(launchConfirmBar!.props.className || '')).toContain('min-h-[34px]');
        expect(launchConfirmBar!.props['aria-hidden']).toBeUndefined();
        expect(launchLiveRegion).toBeDefined();
        expect(launchLiveRegion.props['aria-hidden']).toBeUndefined();
        expect(getTextContent(launchLiveRegion)).toContain('You have unsaved changes.');
        const launchDiscardBtn = findByTestId(tree, 'launch-config-discard-changes-btn');
        expect((launchDiscardBtn!.props.style as Record<string, string>).visibility).toBe('visible');
        expect(launchDiscardBtn!.props.tabIndex).toBe(0);
        expect(launchDiscardBtn!.props['aria-hidden']).toBe(false);

        // Save per-game config: writes performanceHud: 'off', omits legacy metalHud/dxvkHud, NEVER saves global settings!
        const saveBtn = findByTestId(tree, 'launch-config-save-btn');
        await (saveBtn!.props.onClick as () => Promise<void>)();

        expect(saveLaunchConfigSpy).toHaveBeenCalledTimes(1);
        const savedPayload = saveLaunchConfigSpy.mock.calls[0][0] as GameLaunchConfig;
        expect(savedPayload.performanceHud).toBe('off');
        expect(savedPayload.metalHud).toBeUndefined();
        expect(savedPayload.dxvkHud).toBeUndefined();
        expect(savedPayload.crossoverHighResolutionMode).toBeUndefined();
        expect(savedPayload.metalfxSpatialUpscaleFactor).toBe(1.5);
        expect(savedPayload.preferredMaxFrameRate).toBe(120);
        expect(savePerfSpy).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        renderer.unmount();
      }
    });

    it('maps legacy crossoverHighResolutionMode: false to Legacy 96 DPI switch On with 1 override badge', () => {
      const game = makeCanonicalGameFixture({
        id: 'synth-legacy-96dpi',
        title: 'Synthetic Legacy DPI Title',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '888001',
            installed: true,
            installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Legacy',
            executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Legacy/App.exe',
          },
        ],
      });

      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue({
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'gog',
        launchMethod: 'auto',
        compatibilityLayer: 'crossover',
        crossoverHighResolutionMode: false,
      });
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'gog',
        platformGameId: '888001',
        installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Legacy',
        executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/Legacy/App.exe',
        isWindowsBinaryOnMac: true,
        executableArchitecture: 'x86',
        is32BitExecutable: true,
      });

      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'gog',
        onClose: () => {},
      });

      try {
        renderer.render();
        const tree = renderer.render();
        const legacy96Switch = findByTestId(tree, 'toggle-legacy-96dpi-mode');
        expect(legacy96Switch!.props['aria-checked']).toBe(true);

        const displayBadge = findByTestId(tree, 'disclosure-display-overrides-badge');
        expect(displayBadge).toBeDefined();
        expect(getTextContent(displayBadge)).toBe('1 override');

        // 32-bit binary disables DLSS with visible aria-describedby reason
        const dlssSwitch = findByTestId(tree, 'toggle-crossover-dlss');
        expect(dlssSwitch!.props.disabled).toBe(true);
        expect(dlssSwitch!.props['aria-describedby']).toBeDefined();
        const dlssHint = findByTestId(tree, 'crossover-dlss-hint');
        expect(getTextContent(dlssHint)).toContain('64-bit');
      } finally {
        renderer.unmount();
      }
    });

    it('renders unified Performance HUD on macOS Native and Windows Native games and omits duplicate HUD controls', () => {
      // A) macOS Native .app
      const macNativeGame = makeCanonicalGameFixture({
        id: 'synth-mac-native',
        title: 'Synthetic Mac Native Title',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '777001',
            installed: true,
            installPath: '/Applications/SyntheticNative.app',
            executablePath: '/Applications/SyntheticNative.app',
          },
        ],
      });
      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue({
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
        defaultPerformanceHud: true,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue(undefined);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'gog',
        platformGameId: '777001',
        installPath: '/Applications/SyntheticNative.app',
        executablePath: '/Applications/SyntheticNative.app',
        isWindowsBinaryOnMac: false,
      });

      const macHtml = renderToString(
        <GameLaunchConfigModal
          isOpen={true}
          game={macNativeGame}
          initialPlatformId="gog"
          onClose={() => {}}
        />
      );
      expect(macHtml).toContain('data-testid="performance-hud-group"');
      expect(macHtml).toContain('Global Default (On)');
      expect(macHtml).toContain('MTL_HUD_ENABLED=1');
      expect(macHtml).not.toContain('toggle-metal-hud');
      expect(macHtml).not.toContain('toggle-dxvk-hud');
      // Direct mode auto-opens Execution disclosure
      expect(macHtml).toMatch(/<details[^>]*open=""[^>]*data-testid="disclosure-execution-hooks"/);

      // B) Windows Native .exe
      (
        (globalRecord.window as Record<string, unknown>).electronAPI as Record<string, unknown>
      ).platform = 'win32';
      const winGame = makeCanonicalGameFixture({
        id: 'synth-win-native',
        title: 'Synthetic Windows Title',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '777002',
            installed: true,
            installPath: 'C:\\Games\\SynthWin',
            executablePath: 'C:\\Games\\SynthWin\\Game.exe',
          },
        ],
      });
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'gog',
        platformGameId: '777002',
        installPath: 'C:\\Games\\SynthWin',
        executablePath: 'C:\\Games\\SynthWin\\Game.exe',
        isWindowsBinaryOnMac: false,
      });

      const winHtml = renderToString(
        <GameLaunchConfigModal
          isOpen={true}
          game={winGame}
          initialPlatformId="gog"
          onClose={() => {}}
        />
      );
      expect(winHtml).toContain('data-testid="performance-hud-group"');
      expect(winHtml).toContain('Vulkan / DXVK-wrapped games');
      expect(winHtml).not.toContain('DXVK Overlay HUD (DXVK_HUD=1)');
      expect(winHtml).not.toContain('data-section="compatibility-layer-settings"');
    });

    it('renders all Compatibility & Engine Tweaks controls (including D3DMetal version switcher) directly inside the main Compatibility & Graphics card', async () => {
      const previewLayer = createCrossOverLayerFixture({
        id: 'crossover-preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        version: '27.0.0',
        d3dmetalVersion: '4.0b3',
        availableD3DMetalVersions: [
          { id: '4', version: '4.0b3', label: 'D3DMetal 4.0b3 (Default)', isDefault: true },
          { id: '3', version: '3.0', label: 'D3DMetal 3.0 (Fallback)', isDefault: false },
        ],
      });

      const game = makeCanonicalGameFixture({
        id: 'synth-preview-compat-card',
        title: 'Synthetic Preview Bottled Title',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999002',
            installed: true,
            installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/PreviewSynth',
            executablePath:
              '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/PreviewSynth/Game.exe',
          },
        ],
      });

      vi.spyOn(launcherService, 'getPerformanceSettings').mockReturnValue({
        ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
      });
      vi.spyOn(launcherService, 'getLaunchConfig').mockReturnValue({
        gameId: game.id,
        preferredPlatformId: 'steam',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview',
        crossoverGraphicsBackend: 'auto',
        crossoverD3DMetalVersion: '3',
        metalfxSpatialUpscaleFactor: 1.7,
        wineMsync: false,
        wineEsync: true,
        forceLargeAddressAware: true,
        winePrefixPath: '/tmp/synthetic-bottles/CustomPrefix',
      });
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([previewLayer]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([previewLayer]);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'steam',
        platformGameId: '999002',
        installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/PreviewSynth',
        executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/Games/PreviewSynth/Game.exe',
        isWindowsBinaryOnMac: true,
        executableArchitecture: 'x86',
        is32BitExecutable: true,
      });

      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: () => {},
      });

      try {
        renderer.render();
        await Promise.resolve();
        const tree = renderer.render();

        const compatCard = findByTestId(tree, 'compatibility-graphics-card');
        expect(compatCard).toBeDefined();
        expect(findByTestId(tree, 'disclosure-compat-tweaks')).toBeUndefined();
        expect(findElements(compatCard, (el) => el.type === 'details')).toHaveLength(0);

        // All 5 former Compatibility & Engine Tweaks controls live directly inside compatibility-graphics-card
        expect(findByTestId(compatCard, 'crossover-d3dmetal-version-section')).toBeDefined();
        expect(findByTestId(compatCard, 'd3dmetal-version-auto')).toBeDefined();
        expect(findByTestId(compatCard, 'd3dmetal-version-4')).toBeDefined();
        expect(findByTestId(compatCard, 'd3dmetal-version-3')!.props['aria-pressed']).toBe(true);

        const spatialSelect = findByTestId(compatCard, 'metalfx-spatial-upscale-select');
        expect(spatialSelect).toBeDefined();
        expect(spatialSelect!.props.value).toBe('1.7');

        expect(findByTestId(compatCard, 'wine-sync-mode-group')).toBeDefined();
        const esyncRadio = findElements(
          findByTestId(compatCard, 'wine-sync-esync'),
          (el) => el.type === 'input'
        )[0];
        expect(esyncRadio.props.checked).toBe(true);

        const laaSwitch = findByTestId(compatCard, 'toggle-force-laa');
        expect(laaSwitch).toBeDefined();
        expect(laaSwitch!.props['aria-checked']).toBe(true);

        const prefixInputs = findElements(
          compatCard,
          (el) =>
            el.type === 'input' &&
            typeof el.props?.id === 'string' &&
            el.props.id.endsWith('-wine-prefix-path')
        );
        expect(prefixInputs).toHaveLength(1);
        expect(prefixInputs[0].props.value).toBe('/tmp/synthetic-bottles/CustomPrefix');

        // None of the 5 controls appear inside any <details> disclosure
        const detailsNodes = findElements(tree, (el) => el.type === 'details');
        expect(detailsNodes).toHaveLength(3);
        for (const detailsEl of detailsNodes) {
          expect(findByTestId(detailsEl, 'crossover-d3dmetal-version-section')).toBeUndefined();
          expect(findByTestId(detailsEl, 'metalfx-spatial-upscale-select')).toBeUndefined();
          expect(findByTestId(detailsEl, 'wine-sync-mode-group')).toBeUndefined();
          expect(findByTestId(detailsEl, 'toggle-force-laa')).toBeUndefined();
        }
      } finally {
        renderer.unmount();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Zero TypeScript AnyKeyword AST Guard across src/**
  // ---------------------------------------------------------------------------
  describe('6. Zero TypeScript AnyKeyword Guard across src/**', () => {
    it('contains zero TypeScript AnyKeyword nodes across all Wave 1 UI & contract files in src/**', () => {
      const filesToCheck = [
        'src/contracts/launcher.ts',
        'src/contracts/launchPolicyResolver.ts',
        'src/types/electron.d.ts',
        'src/services/launcher/launchConfigStore.ts',
        'src/components/Common/ModalShell.tsx',
        'src/components/Settings/SettingsModal.tsx',
        'src/components/Navigation/TopNavBar.tsx',
        'src/components/Launcher/GameLaunchConfigModal.tsx',
        'src/components/Launcher/LaunchConfig/CompatibilityLayerSection.tsx',
        'src/components/Launcher/LaunchConfig/ExecutableAndArgsSection.tsx',
        'src/components/Launcher/LaunchConfig/EnvironmentAndHooksSection.tsx',
        'src/components/Launcher/LaunchConfig/StorefrontLifecycleSection.tsx',
        'src/components/Launcher/LaunchConfig/LaunchConfigControls.tsx',
        'src/components/Launcher/LaunchConfig/launchConfigHelpers.ts',
        'src/components/Launcher/LaunchConfig/useGameLaunchConfigForm.ts',
      ];

      const violations: string[] = [];
      for (const relPath of filesToCheck) {
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
