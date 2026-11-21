import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import {
  SystemRequirements,
  hasMeaningfulRequirementSpec,
  hasMeaningfulRequirementText,
} from '../src/components/SteamStoreDetail/SystemRequirements';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { useGameDetailMetadata } from '../src/components/SteamStoreDetail/StorePage/useGameDetailMetadata';
import { MediaGallery } from '../src/components/SteamStoreDetail/MediaGallery';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { formatGlobalBottleDisplayModeLabel } from '../src/components/Launcher/LaunchConfig/launchConfigHelpers';
import { GuidedClientSignInStep } from '../src/components/Launcher/SystemSetupWizard/steps/GuidedClientSignInStep';
import { useAchievementsFilterSort } from '../src/components/Achievements/useAchievementsFilterSort';
import { buildEffectiveLaunchModePreview } from '../src/services/launcher/launchPolicyPreview';
import { launcherService } from '../src/services/launcher/launcherService';
import { steamApi } from '../src/services/steam/steamApi';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import type {
  CompatibilityLayerInfo,
  InstalledGameRecord,
  LauncherPerformanceSettings,
} from '../src/contracts/launcher';
import type { StorefrontAchievementsData } from '../src/contracts/achievement';
import type {
  ClientAuthProbeState,
  EnvironmentComponentId,
  EnvironmentHealthSnapshot,
} from '../src/contracts/environmentSetup';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import type { VaultCriticAdoptionController } from '../src/components/SteamStoreDetail/StorePage/useGameDetailCritic';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

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
    version: '26.3.0',
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

function makeSteamMetadataFixture(
  overrides: Partial<SteamEnrichedMetadata> = {}
): SteamEnrichedMetadata {
  return {
    appId: 1086940,
    name: 'Synthetic Title',
    shortDescription: 'Synthetic game description.',
    detailedDescription: '<p>Synthetic details.</p>',
    aboutTheGame: '<p>Synthetic about.</p>',
    headerImage: 'https://example.invalid/header.jpg',
    developers: ['Synthetic Studio'],
    publishers: ['Synthetic Publisher'],
    releaseDate: '2024-01-01',
    genres: ['RPG'],
    tags: ['RPG'],
    categories: [],
    screenshots: [],
    movies: [],
    systemRequirements: {},
    reviewSummary: {
      reviewScore: 8,
      reviewScoreDesc: 'Very Positive',
      totalPositive: 90,
      totalNegative: 10,
      totalReviews: 100,
      positivePercent: 90,
    },
    metadataQuality: 'scraped',
    ...overrides,
  };
}

function createMinimalHealthSnapshot(
  clientLogins: Partial<Record<string, ClientAuthProbeState>>
): EnvironmentHealthSnapshot {
  return {
    probedAt: '2026-11-21T12:00:00.000Z',
    probeDurationMs: 12,
    hostPlatform: 'darwin',
    hostArch: 'arm64',
    isAppleSiliconMac: true,
    hasWriteAccessToSystemApplications: true,
    preferredMacApplicationsDir: '/Applications',
    connectedStorefronts: ['steam', 'gog'],
    bundledHelpers: {
      gogdlReady: true,
      legendaryReady: true,
      xboxGdkBridgesReady: true,
      metalPreloadReady: true,
    },
    detectedRunners: [],
    bottleSummary: {
      runnerType: 'crossover',
      runnerInstalled: true,
      availableBottles: [
        {
          name: 'OneLauncher',
          path: '/tmp/synthetic-bottles/OneLauncher',
          runnerType: 'crossover',
          wineArch: 'win64',
          bottleArch: 'win64',
          hasSteam: true,
          hasGogGalaxy: true,
          hasEpicLauncher: false,
          isSandboxed: false,
        },
      ],
      recommendedBottleMode: 'reuse_existing',
      recommendedBottleName: 'OneLauncher',
    },
    components: {} as EnvironmentHealthSnapshot['components'],
    clientLogins: clientLogins as EnvironmentHealthSnapshot['clientLogins'],
    localStoreHints: [],
    counts: {
      readyCount: 2,
      missingRecommendedCount: 0,
      removedSinceLastSetupCount: 0,
      pendingClientLoginCount: 1,
      accountMismatchCount: 0,
      updateAvailableCount: 0,
    },
  };
}

interface FakeMenuButton {
  role: string;
  label: string;
  disabled: boolean;
  ariaDisabled?: string;
  focusCalls: number;
  getAttribute: (name: string) => string | null;
  focus: (opts?: { preventScroll?: boolean }) => void;
}

function createFakeDropdownContainer(
  dropdownEl: React.ReactElement<Record<string, unknown>>,
  activeRef: { current: FakeMenuButton | null }
) {
  const buttonElements = findElements(
    dropdownEl,
    (el) => el.type === 'button' && el.props?.role === 'menuitem'
  );
  const fakeButtons: FakeMenuButton[] = buttonElements.map((btn) => {
    const disabled = Boolean(btn.props?.disabled);
    const ariaDisabled =
      typeof btn.props?.['aria-disabled'] === 'string'
        ? btn.props['aria-disabled']
        : btn.props?.['aria-disabled'] === true
          ? 'true'
          : undefined;
    const node: FakeMenuButton = {
      role: String(btn.props?.role || ''),
      label: getTextContent(btn).trim(),
      disabled,
      ariaDisabled,
      focusCalls: 0,
      getAttribute: (name: string) => {
        if (name === 'role') return node.role;
        if (name === 'aria-disabled') return node.ariaDisabled ?? null;
        return null;
      },
      focus: () => {
        node.focusCalls += 1;
        activeRef.current = node;
      },
    };
    return node;
  });

  const container = {
    querySelectorAll: (selector: string) => {
      if (selector.includes('role="menuitem"')) {
        return fakeButtons.filter((b) => !b.disabled && b.ariaDisabled !== 'true');
      }
      return [];
    },
    contains: () => true,
  };

  return { container, fakeButtons };
}

describe('Phase 3 UAT Remediation — Detail Page, Manage Menu, Achievements, Launch Config & Setup Wizard Fixes', () => {
  const globalRecord = globalThis as Record<string, unknown>;
  let prevWindow: unknown;
  let prevDocument: unknown;
  let prevLocalStorage: unknown;
  let mockStorage: Storage;

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevDocument = globalRecord.document;
    prevLocalStorage = globalRecord.localStorage;
    mockStorage = createMemoryStorage();
    globalRecord.localStorage = mockStorage;
    globalRecord.window = {
      localStorage: mockStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      matchMedia: vi.fn(() => ({ matches: false })),
      electronAPI: {
        isElectron: true,
        platform: 'darwin',
        arch: 'arm64',
        detectCompatibilityLayers: vi.fn().mockResolvedValue([createCrossOverLayerFixture()]),
        checkCompatibilityLayerUpdates: vi.fn().mockResolvedValue({}),
        detectInstalledStorefrontClients: vi
          .fn()
          .mockResolvedValue({ steam: true, gog: true, epic: false, xbox: false }),
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
    if (prevDocument === undefined) {
      delete globalRecord.document;
    } else {
      globalRecord.document = prevDocument;
    }
    if (prevLocalStorage === undefined) {
      delete globalRecord.localStorage;
    } else {
      globalRecord.localStorage = prevLocalStorage;
    }
  });

  describe('BUG-B3: Strip empty Steam boilerplate HTML from System Requirements tabs', () => {
    const emptyBoilerplateSteamLinux = {
      minimum: '<strong>Minimum:</strong><br><ul class="bb_ul"></ul>',
      recommended: '<strong>Recommended:</strong><br><ul class="bb_ul"></ul>',
    };

    const realWindowsSpecs = {
      minimum:
        '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>OS:</strong> Windows 10 64-bit</li><li><strong>RAM:</strong> 8 GB</li></ul>',
      recommended:
        '<strong>Recommended:</strong><br><ul class="bb_ul"><li><strong>OS:</strong> Windows 11 64-bit</li><li><strong>RAM:</strong> 16 GB</li></ul>',
    };

    const realMacSpecs = {
      minimum:
        '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>OS:</strong> macOS 12</li><li><strong>Processor:</strong> Apple M1</li></ul>',
    };

    it('detects empty HTML shells, &nbsp;, and standalone Minimum/Recommended/Additional Notes headers as non-meaningful', () => {
      expect(hasMeaningfulRequirementSpec(emptyBoilerplateSteamLinux)).toBe(false);
      expect(
        hasMeaningfulRequirementSpec({
          minimum:
            '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>Additional Notes:</strong> &nbsp; </li></ul>',
        })
      ).toBe(false);
      expect(hasMeaningfulRequirementText('   &nbsp;&#160;<strong>Minimum:</strong>   ')).toBe(
        false
      );
      expect(hasMeaningfulRequirementSpec(realWindowsSpecs)).toBe(true);
      expect(hasMeaningfulRequirementSpec(realMacSpecs)).toBe(true);
    });

    it('omits phantom Linux tab in SystemRequirements and hides empty recommended boilerplate cards', () => {
      const renderer = createDomain12DeepRenderer(SystemRequirements, {
        gameId: 'steam-1086940',
        requirements: {
          minimum: realWindowsSpecs.minimum,
          recommended: emptyBoilerplateSteamLinux.recommended,
        },
        macRequirements: realMacSpecs,
        linuxRequirements: emptyBoilerplateSteamLinux,
      });

      try {
        const tree = renderer.render();
        const tabs = findElements(tree, (el) => el.props?.role === 'tab');
        const tabLabels = tabs.map((t) => getTextContent(t).trim());
        expect(tabLabels).toEqual(['Windows', 'macOS']);
        expect(tabLabels).not.toContain('Linux');

        // Switch to Windows tab -> only Minimum card should render (empty Recommended boilerplate omitted)
        const winTab = tabs.find((t) => getTextContent(t).trim() === 'Windows');
        expect(winTab).toBeDefined();
        (winTab!.props.onClick as () => void)();
        const winTree = renderer.render();
        const tabPanel = findElements(winTree, (el) => el.props?.id === 'sysreq-tabpanel')[0];
        expect(tabPanel).toBeDefined();
        expect(String(tabPanel.props.className || '')).not.toContain('md:grid-cols-2');
      } finally {
        renderer.unmount();
      }
    });

    it('suppresses phantom Linux tab in SteamStorePage when platforms.linux === false and linuxRequirements is empty HTML', () => {
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
      vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);

      const bg3LikeGame = makeCanonicalGameFixture({
        id: 'steam-1086940',
        title: 'Synthetic Gate III',
        steamAppId: 1086940,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1086940',
            installed: false,
            platforms: { windows: true, mac: true },
          },
        ],
        enrichedMetadata: makeSteamMetadataFixture({
          appId: 1086940,
          name: 'Synthetic Gate III',
          metadataQuality: 'scraped',
          platforms: { windows: true, mac: true, linux: false },
          systemRequirements: realWindowsSpecs,
          macRequirements: realMacSpecs,
          linuxRequirements: emptyBoilerplateSteamLinux,
        }),
      });

      const renderer = createDomain12DeepRenderer(SteamStorePage, {
        game: bg3LikeGame,
      });

      try {
        const tree = renderer.render();
        const tabs = findElements(tree, (el) => el.props?.role === 'tab');
        const tabLabels = tabs.map((t) => getTextContent(t).trim());
        expect(tabLabels).toEqual(['Windows', 'macOS']);
        expect(tabLabels).not.toContain('Linux');
      } finally {
        renderer.unmount();
      }
    });
  });

  describe('BUG-B5: Manage Game dropdown ARIA menu roles & roving keyboard navigation', () => {
    it('exposes role="menu"/"menuitem"/"separator" and roves focus across enabled items on ArrowDown/ArrowUp/Home/End/Escape even when focusGroup exists', () => {
      // Simulate Electron 44 / Chrome 152 where 'focusGroup' in HTMLElement.prototype === true
      const prevHtmlEl = globalRecord.HTMLElement;
      class FakeHTMLElement {
        focusGroup?: string;
      }
      Object.defineProperty(FakeHTMLElement.prototype, 'focusGroup', {
        value: '',
        configurable: true,
      });
      globalRecord.HTMLElement = FakeHTMLElement;

      const activeRef: { current: FakeMenuButton | null } = { current: null };
      const triggerFocusSpy = vi.fn();
      const docListeners: Record<string, Array<(evt: unknown) => void>> = {};
      globalRecord.document = {
        get activeElement() {
          return activeRef.current;
        },
        addEventListener: vi.fn((type: string, cb: (evt: unknown) => void) => {
          docListeners[type] = docListeners[type] || [];
          docListeners[type].push(cb);
        }),
        removeEventListener: vi.fn((type: string, cb: (evt: unknown) => void) => {
          docListeners[type] = (docListeners[type] || []).filter((fn) => fn !== cb);
        }),
      };

      const game = makeCanonicalGameFixture({
        id: 'steam-2320',
        title: 'Synthetic Quake II',
        steamAppId: 2320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '2320',
            installed: true,
          },
          {
            platformId: 'gog',
            platformGameId: '1441704920',
            installed: false,
          },
        ],
      });

      vi.spyOn(launcherService, 'isGameInstalled').mockImplementation(
        (_g, platId) => platId === 'steam' || !platId
      );
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue(undefined);

      const renderer = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game,
        onFixMatch: vi.fn(),
        onHideGame: vi.fn(),
      });

      try {
        let tree = renderer.render();
        const triggerBtn = findElements(
          tree,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
        )[0];
        expect(triggerBtn).toBeDefined();
        expect(triggerBtn.props['aria-haspopup']).toBe('menu');
        expect(triggerBtn.props['aria-expanded']).toBe(false);

        // Attach fake ref onto trigger button so Escape restores focus (React 19 stores ref on props.ref)
        const triggerRef = triggerBtn.props.ref ?? triggerBtn.ref;
        if (typeof triggerRef === 'function') {
          triggerRef({ focus: triggerFocusSpy });
        } else if (triggerRef && typeof triggerRef === 'object') {
          (triggerRef as { current: unknown }).current = { focus: triggerFocusSpy };
        }

        // Open menu via ArrowDown on trigger button
        const arrowOpenPreventDefault = vi.fn();
        (triggerBtn.props.onKeyDown as (e: Record<string, unknown>) => void)({
          key: 'ArrowDown',
          preventDefault: arrowOpenPreventDefault,
          stopPropagation: vi.fn(),
        });
        expect(arrowOpenPreventDefault).toHaveBeenCalledTimes(1);

        tree = renderer.render();
        const dropdown = findElements(tree, (el) => el.props?.id === 'manage-game-dropdown')[0];
        expect(dropdown).toBeDefined();
        expect(dropdown.props.role).toBe('menu');
        expect(dropdown.props['aria-label']).toBe('Manage Game');

        // Separators carry role="separator"
        const separators = findElements(dropdown, (el) => el.props?.role === 'separator');
        expect(separators.length).toBeGreaterThanOrEqual(2);

        // Build fake DOM node tree for enabled menuitems (note Browse Local Files is disabled when hasLocalFilesPath=false!)
        const { container, fakeButtons } = createFakeDropdownContainer(dropdown, activeRef);
        expect(fakeButtons.length).toBeGreaterThanOrEqual(7);
        expect(fakeButtons[0].label).toContain('Browse Local Files');
        expect(fakeButtons[0].disabled).toBe(true);
        const enabledButtons = fakeButtons.filter((b) => !b.disabled);
        expect(enabledButtons[0].label).toContain('Verify / Repair Game Files');

        // Attach dropdown ref so trigger ArrowDown/ArrowUp when open can focus items
        const dropdownRefObj = dropdown.props.ref ?? dropdown.ref;
        if (typeof dropdownRefObj === 'function') {
          dropdownRefObj(container);
        } else if (dropdownRefObj && typeof dropdownRefObj === 'object') {
          (dropdownRefObj as { current: unknown }).current = container;
        }

        const openTrigger = findElements(
          tree,
          (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
        )[0];
        expect(openTrigger.props['aria-expanded']).toBe(true);
        const openTriggerRef = openTrigger.props.ref ?? openTrigger.ref;
        if (openTriggerRef && typeof openTriggerRef === 'object' && 'current' in openTriggerRef) {
          (openTriggerRef as { current: unknown }).current = { focus: triggerFocusSpy };
        }

        // ArrowDown on open trigger enters first ENABLED item (skipping disabled Browse Local Files)
        (openTrigger.props.onKeyDown as (e: Record<string, unknown>) => void)({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(activeRef.current).toBe(enabledButtons[0]);

        const onMenuKeyDown = dropdown.props.onKeyDown as (e: Record<string, unknown>) => void;

        // ArrowDown roves to second enabled item
        onMenuKeyDown({
          key: 'ArrowDown',
          currentTarget: container,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(activeRef.current).toBe(enabledButtons[1]);

        // End jumps to last enabled item
        onMenuKeyDown({
          key: 'End',
          currentTarget: container,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(activeRef.current).toBe(enabledButtons[enabledButtons.length - 1]);

        // ArrowDown from last wraps to first enabled item
        onMenuKeyDown({
          key: 'ArrowDown',
          currentTarget: container,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(activeRef.current).toBe(enabledButtons[0]);

        // ArrowUp from first wraps to last enabled item
        onMenuKeyDown({
          key: 'ArrowUp',
          currentTarget: container,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(activeRef.current).toBe(enabledButtons[enabledButtons.length - 1]);

        // Home jumps back to first enabled item
        onMenuKeyDown({
          key: 'Home',
          currentTarget: container,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        expect(activeRef.current).toBe(enabledButtons[0]);

        // Escape closes menu and restores focus to trigger
        onMenuKeyDown({
          key: 'Escape',
          currentTarget: container,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
        tree = renderer.render();
        expect(
          findElements(tree, (el) => el.props?.id === 'manage-game-dropdown')
        ).toHaveLength(0);
        expect(triggerFocusSpy).toHaveBeenCalled();
      } finally {
        renderer.unmount();
        if (prevHtmlEl === undefined) {
          delete globalRecord.HTMLElement;
        } else {
          globalRecord.HTMLElement = prevHtmlEl;
        }
      }
    });
  });

  describe('BUG-B6: Skip Steam player achievement fetch for unowned non-Steam games with cross-referenced steamAppId', () => {
    const createStubVaultCritic = (): VaultCriticAdoptionController => ({
      vaultCriticScore: null,
      lastPersistedVaultCriticSigRef: { current: '' },
      resetVaultCriticForNewGame: vi.fn(),
      adoptVaultCriticScore: vi.fn(() => null),
      applyAdoptedVaultCritic: vi.fn(),
      registerOpenCriticSetter: vi.fn(),
    });

    it('does NOT call fetchPlayerGameAchievements for Xbox/GOG/Epic-only games carrying a cross-referenced steamAppId', async () => {
      vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
      const fetchMetaSpy = vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(
        makeSteamMetadataFixture({
          appId: 1145350,
          name: 'Synthetic Hades II',
          metadataQuality: 'scraped',
        })
      );
      const fetchAchSpy = vi
        .spyOn(steamAchievementsService, 'fetchPlayerGameAchievements')
        .mockResolvedValue({ unlocked: 0, total: 49, percentage: 0, source: 'live_cloud_api' });

      const xboxOnlyGameWithSteamRef = makeCanonicalGameFixture({
        id: 'xbox-9p1234567890',
        title: 'Synthetic Hades II',
        steamAppId: 1145350,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9P1234567890',
            installed: true,
          },
        ],
      });

      const Host: React.FC = () => {
        const supportsMacRef = React.useRef(false);
        useGameDetailMetadata({
          game: xboxOnlyGameWithSteamRef,
          activeStoreSupportsMacRef: supportsMacRef,
          vaultCritic: createStubVaultCritic(),
        });
        return React.createElement('div');
      };

      const renderer = createDomain12DeepRenderer(Host, {});
      try {
        renderer.render();
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchMetaSpy).toHaveBeenCalledWith(
          1145350,
          expect.anything(),
          expect.any(Object)
        );
        expect(fetchAchSpy).not.toHaveBeenCalled();
      } finally {
        renderer.unmount();
      }
    });

    it('does NOT call fetchPlayerGameAchievements on non-Steam-routed games when Steam is unowned, and DOES call it when Steam IS owned', async () => {
      vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
      vi.spyOn(
        fallbackMetadataProvider,
        'getEnrichedMetadataForNonSteamGame'
      ).mockResolvedValue(
        makeSteamMetadataFixture({
          appId: 0,
          name: 'Synthetic Control',
          metadataQuality: 'scraped',
        })
      );
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(
        makeSteamMetadataFixture({
          appId: 870780,
          name: 'Synthetic Control',
          metadataQuality: 'scraped',
        })
      );
      const fetchAchSpy = vi
        .spyOn(steamAchievementsService, 'fetchPlayerGameAchievements')
        .mockResolvedValue({ unlocked: 5, total: 67, percentage: 7, source: 'live_cloud_api' });

      const steamOwnedGame = makeCanonicalGameFixture({
        id: 'steam-870780',
        title: 'Synthetic Control',
        steamAppId: 870780,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '870780',
            installed: true,
          },
        ],
      });

      const SteamHost: React.FC = () => {
        const supportsMacRef = React.useRef(false);
        useGameDetailMetadata({
          game: steamOwnedGame,
          activeStoreSupportsMacRef: supportsMacRef,
          vaultCritic: createStubVaultCritic(),
        });
        return React.createElement('div');
      };

      const steamRenderer = createDomain12DeepRenderer(SteamHost, {});
      try {
        steamRenderer.render();
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchAchSpy).toHaveBeenCalledWith(870780);
      } finally {
        steamRenderer.unmount();
      }
    });
  });

  describe('BUG-C5 & Display Mode Polish: Propagate executableArchitecture/is32BitExecutable and keep Display Mode label concise', () => {
    it('propagates x64, arm64, is32BitExecutable:false fallback, and unknown-arch fallthrough in buildEffectiveLaunchModePreview', () => {
      const baseGame = makeCanonicalGameFixture({
        id: 'xbox-hades2',
        title: 'Synthetic Hades II',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9P1111111111',
            installed: true,
            installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2',
            executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2/Hades2.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
      });

      const preview64 = buildEffectiveLaunchModePreview({
        game: baseGame,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        preferredPlatformId: 'xbox',
        installedRecord: {
          platformId: 'xbox',
          platformGameId: '9P1111111111',
          title: 'Synthetic Hades II',
          installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2',
          executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2/Hades2.exe',
          isWindowsBinaryOnMac: true,
          executableArchitecture: 'x64',
          is32BitExecutable: false,
        },
        layers: [createCrossOverLayerFixture()],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });
      expect(preview64.executableArchitecture).toBe('x64');
      expect(preview64.is32BitExecutable).toBe(false);

      const previewBoolOnly64 = buildEffectiveLaunchModePreview({
        game: baseGame,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        preferredPlatformId: 'xbox',
        installedRecord: {
          platformId: 'xbox',
          platformGameId: '9P1111111111',
          title: 'Synthetic Hades II',
          installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2',
          executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2/Hades2.exe',
          isWindowsBinaryOnMac: true,
          executableArchitecture: 'unknown',
          is32BitExecutable: false,
        },
        layers: [createCrossOverLayerFixture()],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });
      expect(previewBoolOnly64.executableArchitecture).toBe('x64');
      expect(previewBoolOnly64.is32BitExecutable).toBe(false);

      const previewArm64 = buildEffectiveLaunchModePreview({
        game: baseGame,
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        preferredPlatformId: 'xbox',
        installedRecord: {
          platformId: 'xbox',
          platformGameId: '9P1111111111',
          title: 'Synthetic Hades II',
          installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2',
          executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/XboxGames/Hades2/Hades2.exe',
          isWindowsBinaryOnMac: true,
          executableArchitecture: 'arm64',
          is32BitExecutable: false,
        },
        layers: [createCrossOverLayerFixture()],
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
      });
      expect(previewArm64.executableArchitecture).toBe('arm64');
      expect(previewArm64.is32BitExecutable).toBe(false);
    });

    it('reactively updates GameLaunchConfigModal to show 64-bit Binary badge and disable 32-bit LAA when scan attaches executableArchitecture, and renders concise Display Mode default label', async () => {
      const listeners = new Set<() => void>();
      let currentRecord: InstalledGameRecord = {
        platformId: 'gog',
        platformGameId: '2015545325',
        title: 'Synthetic DOOM Enhanced',
        installPath: '/tmp/synthetic-bottles/OneLauncher/drive_c/GOG/DOOM',
        executablePath: '/tmp/synthetic-bottles/OneLauncher/drive_c/GOG/DOOM/DOOM.exe',
        isWindowsBinaryOnMac: true,
      };

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
        createCrossOverLayerFixture(),
      ]);
      vi.spyOn(launcherService, 'getRunnerUpdates').mockReturnValue({});
      vi.spyOn(launcherService, 'checkCompatibilityLayerUpdates').mockResolvedValue({});
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockImplementation(() => currentRecord);
      vi.spyOn(launcherService, 'subscribe').mockImplementation((cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      });

      const game = makeCanonicalGameFixture({
        id: 'gog-2015545325',
        title: 'Synthetic DOOM Enhanced',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '2015545325',
            installed: true,
            installPath: currentRecord.installPath,
            executablePath: currentRecord.executablePath,
            isWindowsBinaryOnMac: true,
          },
        ],
      });

      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        initialPlatformId: 'gog',
        onClose: vi.fn(),
      });

      try {
        renderer.render();
        await Promise.resolve();
        let tree = renderer.render();

        // Concise Display Mode default label without awkward mid-word clipping ("& Upscaling" / "& Upscale")
        expect(formatGlobalBottleDisplayModeLabel('auto_fullscreen')).toBe('Auto Fullscreen');
        const displayModeSelect = findByTestId(tree, 'display-scaling-mode-select');
        expect(displayModeSelect).toBeDefined();
        const defaultOption = findElements(
          displayModeSelect,
          (el) => el.type === 'option' && el.props?.value === 'default'
        )[0];
        expect(getTextContent(defaultOption)).toBe('Use Global Default (Auto Fullscreen)');

        // Before architecture finishes populating, 64-bit badge is absent
        expect(findByTestId(tree, 'force-laa-64bit-badge')).toBeUndefined();

        // Scanner resolves PE32+ x64 architecture and notifies subscribers
        currentRecord = {
          ...currentRecord,
          executableArchitecture: 'x64',
          is32BitExecutable: false,
        };
        for (const cb of listeners) cb();
        tree = renderer.render();

        const badge = findByTestId(tree, 'force-laa-64bit-badge');
        expect(badge).toBeDefined();
        expect(getTextContent(badge)).toContain('64-bit Binary — Not Needed');
        const laaSwitch = findByTestId(tree, 'toggle-force-laa');
        expect(laaSwitch).toBeDefined();
        expect(laaSwitch!.props.disabled).toBe(true);
        expect(laaSwitch!.props['aria-checked']).toBe(false);
      } finally {
        renderer.unmount();
      }
    });
  });

  describe('Track B Polish #1: Alphabetical achievement sort masks unrevealed locked secrets', () => {
    it('does not leak secret achievement titles via alphabetical position until revealed or unlocked', () => {
      const storeData: StorefrontAchievementsData = {
        storefrontId: 'steam',
        storefrontName: 'Steam',
        total: 5,
        unlocked: 2,
        percentage: 40,
        isMastered: false,
        source: 'live_cloud',
        achievements: [
          {
            id: 'secret-a',
            apiName: 'ACH_SECRET_A',
            name: 'A Secret Ending',
            description: 'Spoiler ending',
            unlocked: false,
            isSecret: true,
            iconUnlockedUrl: 'https://example.invalid/a.png',
            storefrontId: 'steam',
          },
          {
            id: 'vis-z',
            apiName: 'ACH_Z',
            name: 'Zeta Finish',
            unlocked: false,
            isSecret: false,
            iconUnlockedUrl: 'https://example.invalid/z.png',
            storefrontId: 'steam',
          },
          {
            id: 'secret-m',
            apiName: 'ACH_SECRET_M',
            name: 'Midgame Twist',
            unlocked: false,
            isSecret: true,
            iconUnlockedUrl: 'https://example.invalid/m.png',
            storefrontId: 'steam',
          },
          {
            id: 'secret-unlocked',
            apiName: 'ACH_SECRET_UNLOCKED',
            name: 'Broken Seal',
            unlocked: true,
            isSecret: true,
            iconUnlockedUrl: 'https://example.invalid/b.png',
            storefrontId: 'steam',
          },
          {
            id: 'vis-a',
            apiName: 'ACH_A',
            name: 'Alpha Strike',
            unlocked: true,
            isSecret: false,
            iconUnlockedUrl: 'https://example.invalid/alpha.png',
            storefrontId: 'steam',
          },
        ],
      };

      let latestApi: ReturnType<typeof useAchievementsFilterSort> | null = null;
      const Host: React.FC = () => {
        latestApi = useAchievementsFilterSort(storeData, true);
        return React.createElement('div');
      };

      const renderer = createDomain12DeepRenderer(Host, {});
      try {
        renderer.render();
        latestApi!.setSortOption('name');
        renderer.render();

        // Visible + unlocked achievements sort A-Z first; unrevealed locked secrets stay grouped after revealed titles
        expect(latestApi!.displayedAchievements.map((a) => a.id)).toEqual([
          'vis-a',
          'secret-unlocked',
          'vis-z',
          'secret-a',
          'secret-m',
        ]);

        // Revealing secret-a lets it sort into its revealed A-Z position ("A Secret Ending" before "Alpha Strike")
        latestApi!.toggleSecretReveal('secret-a');
        renderer.render();
        expect(latestApi!.displayedAchievements.map((a) => a.id)).toEqual([
          'secret-a',
          'vis-a',
          'secret-unlocked',
          'vis-z',
          'secret-m',
        ]);
      } finally {
        renderer.unmount();
      }
    });
  });

  describe('Track B Polish #4: MediaGallery trailer iframe omits unsupported web-share feature', () => {
    it('renders embed iframe without web-share in allow attribute', () => {
      vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
      const renderer = createDomain12DeepRenderer(MediaGallery, {
        screenshots: [],
        movies: [
          {
            id: 1,
            name: 'Synthetic Trailer',
            thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
            mp4: { max: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
          },
        ],
        autoplay: true,
        gameId: 'gog-12345',
      });

      try {
        const tree = renderer.render();
        const iframe = findElements(tree, (el) => el.type === 'iframe')[0];
        expect(iframe).toBeDefined();
        const allowAttr = String(iframe.props.allow || '');
        expect(allowAttr).not.toContain('web-share');
        expect(allowAttr).toContain('autoplay');
        expect(allowAttr).toContain('picture-in-picture');
      } finally {
        renderer.unmount();
      }
    });
  });

  describe('Track C Polish #1: GuidedClientSignInStep renders a single clean status line on signed-in launcher cards', () => {
    it('eliminates duplicate "Signed in" status lines for both account-labeled and generic signed-in cards while preserving pending status', () => {
      const snapshot = createMinimalHealthSnapshot({
        host_steam: {
          targetId: 'host_steam',
          storefrontId: 'steam',
          scope: 'host',
          label: 'Steam (Mac)',
          installed: true,
          authenticated: true,
          autoLoginEnabled: true,
          detectedAccountLabel: 'TestPlayer42',
          accountMatchesOneLauncher: true,
          statusSummary: 'Signed in as TestPlayer42',
        },
        bottle_ea: {
          targetId: 'bottle_ea',
          storefrontId: 'ea',
          scope: 'bottle',
          label: 'EA App',
          installed: true,
          authenticated: true,
          accountMatchesOneLauncher: null,
          statusSummary: 'Signed in',
        },
        bottle_gog: {
          targetId: 'bottle_gog',
          storefrontId: 'gog',
          scope: 'bottle',
          label: 'GOG Galaxy',
          installed: true,
          authenticated: false,
          accountMatchesOneLauncher: null,
          statusSummary: 'Sign-in needed',
        },
      });

      const renderer = createDomain12DeepRenderer(GuidedClientSignInStep, {
        snapshot,
        chosenRunner: 'crossover',
        bottleName: 'OneLauncher',
        selectedIds: new Set<EnvironmentComponentId>(),
        activeGuidedLoginTarget: null,
        autoCloseOnSuccess: true,
        onToggleAutoCloseOnSuccess: vi.fn(),
        onGuidedLoginCompleted: vi.fn(),
      });

      try {
        const tree = renderer.render();

        const steamCard = findByTestId(tree, 'guided-login-card-host_steam');
        expect(steamCard).toBeDefined();
        const steamText = getTextContent(steamCard);
        expect(steamText).toContain('Signed in as TestPlayer42');
        expect(steamText).not.toContain('Signed in (TestPlayer42)');
        expect((steamText.match(/Signed in/gi) || []).length).toBe(1);

        const eaCard = findByTestId(tree, 'guided-login-card-bottle_ea');
        expect(eaCard).toBeDefined();
        const eaStatusEl = findByTestId(eaCard, 'guided-login-status-bottle_ea');
        expect(getTextContent(eaStatusEl)).toBe('Signed in');
        // Exclude the static SSO tip text and verify the header row renders "Signed in" exactly once
        const eaParagraphs = findElements(eaCard, (el) => el.type === 'p');
        expect(eaParagraphs.some((p) => getTextContent(p).trim() === 'Signed in')).toBe(false);

        const gogCard = findByTestId(tree, 'guided-login-card-bottle_gog');
        expect(gogCard).toBeDefined();
        expect(getTextContent(gogCard)).toContain('Sign-in needed');
        expect(getTextContent(gogCard)).toContain('Needs sign-in');
      } finally {
        renderer.unmount();
      }
    });
  });
});
