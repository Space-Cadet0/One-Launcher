import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  E2ESandbox,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_SYNTHETIC_EPIC_ACCOUNT_ID,
  E2E_SYNTHETIC_STEAM_ID,
  asContractComponentId,
  asContractLayerType,
  createIsolatedE2ESandbox,
  createIpcAndServiceHarness,
  diagnosticLogger,
  environmentHealthProber,
  extractVNodeText,
  findVNodeByTestId,
  findVNodes,
  flushMicrotasks,
  makeE2ECanonicalGame,
  makeE2ESnapshot,
  makeSimpleSetupSuccessResult,
  seedBottle,
  seedPreviewAppBundle,
} from '../harness';
import { CompatibilityAndBottleStep } from '../../../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { StorefrontClientsStep } from '../../../src/components/Launcher/SystemSetupWizard/steps/StorefrontClientsStep';
import { SystemSetupWizardModal } from '../../../src/components/Launcher/SystemSetupWizard/SystemSetupWizardModal';
import { GameLaunchConfigModal } from '../../../src/components/Launcher/GameLaunchConfigModal';
import { GameInstallModal } from '../../../src/components/Launcher/GameInstallModal';
import { TopNavBar } from '../../../src/components/Navigation/TopNavBar';
import { LibraryFilterPanel } from '../../../src/components/Library/LibraryFilterPanel';
import { renderLibraryGridCard } from '../../../src/components/Library/Grid/LibraryGridCard';
import type { EnvironmentComponentId } from '../../../src/contracts/environmentSetup';
import { DEFAULT_LIBRARY_FILTER_STATE } from '../../../src/contracts/filter';
import {
  buildLibraryFilterIndex,
  evaluateLibraryFilter,
} from '../../../src/services/filter/libraryFilterIndex';
import { buildEffectiveLaunchModePreview } from '../../../src/services/launcher/launchPolicyPreview';
import { formatUserFacingPath } from '../../../src/components/Launcher/LaunchConfig/launchConfigHelpers';
import { launcherService } from '../../../src/services/launcher/launcherService';
import { environmentSetupService } from '../../../src/services/launcher/environmentSetupService';
import { createDomain12DeepRenderer } from '../../helpers/xboxTestHarness';
import {
  scanRepoForPiiViolations,
  scanWorkspaceRootForPollutedEntries,
} from '../../helpers/piiHygieneGuard';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('Tier 1 — F10 & F12: Full UI Integration & Universal Portability', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t1-f10f12-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F10: Full UI Integration across Setup Wizard, Launch Config, Install Modal, TopNavBar (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F10.1: SystemSetupWizardModal on arm64 Apple Silicon renders both Preview cards and resolves default bottle to OneLauncher-arm64 when switching runner', async () => {
    const snapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      isAppleSiliconMac: true,
      runnerType: 'crossover',
      recommendedBottleName: 'OneLauncher',
    });

    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        probeEnvironmentHealth: vi.fn(async () => snapshot),
        getSetupWizardState: vi.fn(async () => ({
          schemaVersion: 1,
          completedAt: null,
          dismissedAt: null,
          lastHealthCheckAt: null,
          configuredComponents: [],
        })),
      },
    });

    try {
      await environmentSetupService.probeHealth(['steam'], { forceFresh: true });
      const renderer = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });

      let tree = renderer.render();
      await flushMicrotasks();
      tree = renderer.render();

      const stdCard = findVNodeByTestId(tree, 'setup-runner-crossover-preview');
      const armCard = findVNodeByTestId(tree, 'setup-runner-crossover-preview-arm64');
      const bottleInputBefore = findVNodeByTestId(tree, 'setup-bottle-name-input');

      expect(stdCard).toBeDefined();
      expect(armCard).toBeDefined();
      expect(bottleInputBefore?.props?.value).toBe('OneLauncher');

      armCard.props.onClick?.();
      tree = renderer.render();

      const bottleInputAfter = findVNodeByTestId(tree, 'setup-bottle-name-input');
      expect(bottleInputAfter?.props?.value).toBe('OneLauncher-arm64');
      expect(bottleInputAfter?.props?.placeholder).toBe('OneLauncher-arm64');

      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('F10.2: SystemSetupWizardModal steps through compatibility -> clients -> summary -> Run -> queues runner_crossover_preview_arm64 + OneLauncher-arm64', async () => {
    const initialSnapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      isAppleSiliconMac: true,
      components: {
        runner_crossover_preview_arm64: {
          status: 'missing',
          canAutoInstall: true,
        },
      },
    });
    const completedSnapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      isAppleSiliconMac: true,
      runnerType: 'crossover_preview_arm64',
      recommendedBottleName: 'OneLauncher-arm64',
      components: {
        runner_crossover_preview_arm64: { status: 'ready' },
        bottle_default: { status: 'ready' },
      },
    });

    const runSetupSpy = vi.fn(async (req: any) =>
      makeSimpleSetupSuccessResult(req.tasks, completedSnapshot)
    );

    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        probeEnvironmentHealth: vi.fn(async () => initialSnapshot),
        runEnvironmentSetupTasks: runSetupSpy,
        getSetupWizardState: vi.fn(async () => ({
          schemaVersion: 1,
          completedAt: null,
          dismissedAt: null,
          lastHealthCheckAt: null,
          configuredComponents: [],
        })),
        saveSetupWizardState: vi.fn(async (p: any) => p),
      },
    });

    try {
      await environmentSetupService.probeHealth(['steam'], { forceFresh: true });
      const renderer = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });

      let tree = renderer.render();
      await flushMicrotasks();
      tree = renderer.render();

      const armCard = findVNodeByTestId(tree, 'setup-runner-crossover-preview-arm64');
      expect(armCard).toBeDefined();
      armCard.props.onClick?.();
      tree = renderer.render();

      // Advance via setup-next-step-btn: compatibility -> clients -> summary
      const nextBtn1 = findVNodeByTestId(tree, 'setup-next-step-btn');
      expect(nextBtn1).toBeDefined();
      expect(nextBtn1?.props?.disabled).toBeFalsy();
      nextBtn1.props.onClick?.();
      tree = renderer.render();

      const nextBtn2 = findVNodeByTestId(tree, 'setup-next-step-btn');
      expect(nextBtn2).toBeDefined();
      nextBtn2.props.onClick?.();
      tree = renderer.render();

      const runBtn = findVNodeByTestId(tree, 'run-provisioning-btn');
      expect(runBtn).toBeDefined();
      await runBtn.props.onClick?.();
      await flushMicrotasks();
      tree = renderer.render();

      expect(runSetupSpy).toHaveBeenCalled();
      const tasks = runSetupSpy.mock.calls[0]?.[0]?.tasks || [];
      expect(
        tasks.some(
          (t: any) =>
            t.action === 'install_runner' && t.componentId === 'runner_crossover_preview_arm64'
        )
      ).toBe(true);
      expect(
        tasks.some(
          (t: any) => t.action === 'ensure_bottle' && t.bottleName === 'OneLauncher-arm64'
        )
      ).toBe(true);

      const progressPanel = findVNodeByTestId(tree, 'provisioning-progress-panel');
      expect(progressPanel).toBeDefined();

      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('F10.3: GameLaunchConfigModal renders crossover_preview_arm64 option, bottle selector/placeholder for OneLauncher-arm64, and CrossOver graphics controls', async () => {
    const game = makeE2ECanonicalGame();
    const layers = [
      {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        binaryPath: '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver Preview.app',
        version: '20261111',
        availableBottles: ['OneLauncher'],
        d3dmetalVersion: '4.0b3',
      },
      {
        id: 'crossover_preview_arm64',
        type: 'crossover_preview_arm64',
        name: 'CrossOver Preview (arm64 / FEX)',
        binaryPath:
          '/Applications/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/wine',
        appPath: '/Applications/CrossOver Preview arm64.app',
        version: '20261111',
        availableBottles: ['OneLauncher-arm64'],
        d3dmetalVersion: '4.0b3',
      },
    ];

    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        detectCompatibilityLayers: vi.fn(() => layers),
        checkCompatibilityLayerUpdates: vi.fn(async () => ({})),
        getGameLaunchConfigs: vi.fn(() => ({
          [game.id]: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover_preview_arm64',
            wineBottleName: 'OneLauncher-arm64',
          },
        })),
      },
    });

    try {
      await launcherService.initialize();
      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        onClose: vi.fn(),
      });

      let tree = renderer.render();
      await flushMicrotasks();
      tree = renderer.render();

      const runnerSelect = findVNodeByTestId(tree, 'compat-runner-select');
      expect(runnerSelect).toBeDefined();
      const selectOptions = findVNodes(runnerSelect, (n) => n.type === 'option');
      expect(
        selectOptions.some((o) => o.props?.value === 'crossover_preview_arm64')
      ).toBe(true);

      const bottleControl = findVNodes(
        tree,
        (n) => n.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(bottleControl).toBeDefined();
      // When availableBottles.length > 0, renders LaunchSelect (<select>) with Default Bottle (OneLauncher-arm64)
      expect(extractVNodeText(bottleControl)).toContain('Default Bottle (OneLauncher-arm64)');

      const d3dSection = findVNodeByTestId(tree, 'crossover-d3dmetal-version-section');
      expect(d3dSection).toBeDefined();

      renderer.unmount();
    } finally {
      bridge.dispose();
    }

    // Also verify empty availableBottles renders <input placeholder="...OneLauncher-arm64...">
    const emptyBottleBridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        detectCompatibilityLayers: vi.fn(() => [
          {
            ...layers[1],
            availableBottles: [],
          },
        ]),
        checkCompatibilityLayerUpdates: vi.fn(async () => ({})),
        getGameLaunchConfigs: vi.fn(() => ({
          [game.id]: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover_preview_arm64',
            wineBottleName: '',
          },
        })),
      },
    });

    try {
      await launcherService.initialize();
      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        onClose: vi.fn(),
      });

      let tree = renderer.render();
      await flushMicrotasks();
      tree = renderer.render();

      const bottleInput = findVNodes(
        tree,
        (n) => n.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(bottleInput).toBeDefined();
      expect(bottleInput.type).toBe('input');
      expect(String(bottleInput.props?.placeholder || '')).toContain('OneLauncher-arm64');

      renderer.unmount();
    } finally {
      emptyBottleBridge.dispose();
    }
  });

  it('F10.4: GameInstallModal allows selecting crossover_preview_arm64 and defaults empty-bottle fallback & Steam path to OneLauncher-arm64', async () => {
    const game = makeE2ECanonicalGame();
    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        detectCompatibilityLayers: vi.fn(() => [
          {
            id: 'crossover_preview_arm64',
            type: 'crossover_preview_arm64',
            name: 'CrossOver Preview (arm64 / FEX)',
            binaryPath:
              '/Applications/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/wine',
            appPath: '/Applications/CrossOver Preview arm64.app',
            bottlesDir: '/Users/test/Library/Application Support/CrossOver Preview/Bottles',
            availableBottles: [],
          },
        ]),
        getGameInstallInfo: vi.fn(async () => ({
          gameId: game.id,
          platformId: 'steam',
          canInstall: true,
          requiresWindowsCompatibilityOnMac: true,
          availableInstallers: [
            { id: 'win-64', label: 'Windows 64-bit', os: 'windows', arch: 'x64' },
          ],
        })),
      },
    });

    try {
      await launcherService.initialize();
      const renderer = createDomain12DeepRenderer(GameInstallModal, {
        isOpen: true,
        game,
        initialPlatformId: 'steam',
        onClose: vi.fn(),
      });

      let tree = renderer.render();
      await flushMicrotasks();
      tree = renderer.render();

      const runnerSelect = findVNodeByTestId(tree, 'preinstall-compat-runner');
      const bottleSelect = findVNodeByTestId(tree, 'preinstall-compat-bottle');
      const steamLocDisplay = findVNodeByTestId(tree, 'steam-library-location-display');
      expect(runnerSelect).toBeDefined();
      expect(bottleSelect).toBeDefined();
      expect(steamLocDisplay).toBeDefined();

      const runnerOpts = findVNodes(runnerSelect, (n) => n.type === 'option');
      expect(runnerOpts.some((o) => o.props?.value === 'crossover_preview_arm64')).toBe(true);

      const bottleText = extractVNodeText(bottleSelect);
      expect(bottleText).toContain('Default Bottle (OneLauncher-arm64)');

      const steamLocText = extractVNodeText(steamLocDisplay);
      expect(steamLocText).toContain('CrossOver Preview/Bottles/OneLauncher-arm64');

      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('F10.5: TopNavBar displays setup health alert dot and StorefrontClientsStep renders bottle clients for crossover_preview_arm64', () => {
    const bridge = createIpcAndServiceHarness({ arch: 'arm64', platform: 'darwin' });
    try {
      const renderer = createDomain12DeepRenderer(TopNavBar, {
        selectedPlatform: 'all',
        onSelectPlatform: vi.fn(),
        installedOnly: false,
        onToggleInstalledOnly: vi.fn(),
        totalGamesCount: 5,
        filteredCount: 5,
        isSyncing: false,
        onTriggerSync: vi.fn(),
        onHomeClick: vi.fn(),
        onOpenIntegrations: vi.fn(),
        onOpenSystemSetup: vi.fn(),
        systemSetupAlertCount: 2,
        defaultMenuOpen: true,
      });

      const tree = renderer.render();
      const setupBtn = findVNodeByTestId(tree, 'menu-system-setup-health');
      const alertDot = findVNodeByTestId(tree, 'menu-system-setup-alert-dot');

      expect(setupBtn).toBeDefined();
      expect(alertDot).toBeDefined();

      renderer.unmount();

      const clientsSnap = makeE2ESnapshot({
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        isAppleSiliconMac: true,
        runnerType: 'crossover_preview_arm64',
      });
      const clientsRenderer = createDomain12DeepRenderer(StorefrontClientsStep, {
        snapshot: clientsSnap,
        mode: 'first_launch',
        chosenRunner: asContractLayerType('crossover_preview_arm64'),
        connectedStorefronts: ['steam', 'gog', 'epic'],
        selectedIds: new Set([asContractComponentId('bottle_steam')]),
        forceRepairIds: new Set<EnvironmentComponentId>(),
        onToggleComponent: vi.fn(),
        onToggleForceRepair: vi.fn(),
      });
      const clientsTree = clientsRenderer.render();
      expect(findVNodeByTestId(clientsTree, 'setup-client-card-bottle_steam')).toBeDefined();
      expect(findVNodeByTestId(clientsTree, 'setup-client-card-bottle_gog')).toBeDefined();
      expect(findVNodeByTestId(clientsTree, 'setup-client-card-bottle_epic')).toBeDefined();
      clientsRenderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('F10.6: CompatibilityAndBottleStep exposes Update badge & action when runner_crossover_preview_arm64 has updateAvailable', () => {
    const snapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      isAppleSiliconMac: true,
      components: {
        runner_crossover_preview_arm64: {
          status: 'update_available',
          version: '20261015',
          latestVersion: '20261111',
          latestDisplayVersion: 'Preview 20261111',
          downloadUrl: E2E_ARM64_PREVIEW_ZIP_URL,
          canAutoInstall: true,
        },
      },
    });

    const renderer = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
      snapshot,
      chosenRunner: asContractLayerType('crossover_preview_arm64'),
      onSelectRunner: vi.fn(),
      bottleMode: 'create_dedicated',
      onChangeBottleMode: vi.fn(),
      bottleName: 'OneLauncher-arm64',
      onChangeBottleName: vi.fn(),
      runnerUpdateOptInIds: new Set([asContractComponentId('runner_crossover_preview_arm64')]),
      onToggleRunnerUpdate: vi.fn(),
    });

    const tree = renderer.render();
    const updateBadge = findVNodeByTestId(
      tree,
      'runner-update-badge-crossover-preview-arm64'
    );
    const updateOptIn = findVNodeByTestId(
      tree,
      'runner-update-toggle-crossover-preview-arm64'
    );
    expect(updateBadge).toBeDefined();
    expect(updateOptIn).toBeDefined();

    renderer.unmount();
  });

  it('F10.7: buildEffectiveLaunchModePreview enables crossoverRendering & resolves CrossOver Preview arm64 summary', () => {
    const game = makeE2ECanonicalGame();
    const preview = buildEffectiveLaunchModePreview({
      game,
      preferredPlatformId: 'steam',
      draftConfig: {
        launchMethod: 'compatibility_layer',
        compatibilityLayer: asContractLayerType('crossover_preview_arm64'),
        wineBottleName: 'OneLauncher-arm64',
      },
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      layers: [
        {
          id: 'crossover_preview_arm64',
          type: asContractLayerType('crossover_preview_arm64'),
          name: 'CrossOver Preview (arm64 / FEX)',
          binaryPath:
            '/Applications/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/wine',
          appPath: '/Applications/CrossOver Preview arm64.app',
          availableBottles: ['OneLauncher-arm64'],
        },
      ],
      globalStorefrontLifecycle: 'minimal_and_close_if_started',
    });

    expect(preview.visibleSections.compatibilityLayer).toBe(true);
    expect(preview.visibleSections.crossoverRendering).toBe(true);
    expect(preview.autoResolvedSummary).toContain('CrossOver Preview (arm64 / FEX)');
    expect(preview.autoResolvedSummary).toContain('OneLauncher-arm64');
  });

  it('F10.8: Library filter index, LibraryFilterPanel, and LibraryGridCard reflect mac_compat_layer & Windows badge for crossover_preview_arm64 games', async () => {
    const game = makeE2ECanonicalGame({
      id: 'e2e-lib-arm64-game',
      title: 'Arm64 Library Title',
    });
    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        getGameLaunchConfigs: vi.fn(() => ({
          [game.id]: {
            gameId: game.id,
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover_preview_arm64',
            wineBottleName: 'OneLauncher-arm64',
          },
        })),
      },
    });

    try {
      await launcherService.initialize();
      const filterIndex = buildLibraryFilterIndex([game]);
      expect(filterIndex.osCounts.mac_compat_layer).toBe(1);

      const matched = evaluateLibraryFilter([game], filterIndex, {
        ...DEFAULT_LIBRARY_FILTER_STATE,
        osCompatibility: ['mac_compat_layer'],
      });
      expect(matched.map((g) => g.id)).toEqual([game.id]);

      const filterPanelRenderer = createDomain12DeepRenderer(LibraryFilterPanel, {
        filterState: { ...DEFAULT_LIBRARY_FILTER_STATE, osCompatibility: ['mac_compat_layer'] },
        onChange: vi.fn(),
        onReset: vi.fn(),
        filterIndex,
        filteredCount: matched.length,
        totalCount: 1,
      });
      const panelTree = filterPanelRenderer.render();
      expect(extractVNodeText(panelTree)).toContain('CrossOver / Wine (Mac)');
      filterPanelRenderer.unmount();

      const CardWrapper: React.FC = () =>
        renderLibraryGridCard({
          game,
          idx: 0,
          sortBy: 'alphabetical',
          userOverridesMap: {},
          coverOverrides: {},
          connectedSet: new Set(['steam']),
          effectiveFilterIndex: filterIndex,
          contextMenuOpenRef: { current: false },
          onDismissContextMenu: vi.fn(),
          onSelectGame: vi.fn(),
          onNeedCoverLookup: vi.fn(),
          onMouseEnter: vi.fn(),
          onMouseLeave: vi.fn(),
          onContextMenu: vi.fn(),
          resolveGameCriticData: () => null,
        });
      const cardRenderer = createDomain12DeepRenderer(CardWrapper, {});
      const cardTree = cardRenderer.render();
      expect(findVNodeByTestId(cardTree, 'cover-native-os-badge')).toBeDefined();
      cardRenderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // F12: Universal Portability & Zero Hardcoded User/Machine/Account Data (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F12.1: scanRepoForPiiViolations over src/ and electron/ reports zero hardcoded user/account/PII violations', () => {
    const violations = scanRepoForPiiViolations(
      REPO_ROOT,
      ['src', 'electron'],
      /\.(?:ts|tsx|js|jsx|cjs|mjs)$/i
    );
    expect(violations).toEqual([]);
  });

  it('F12.2: scanWorkspaceRootForPollutedEntries passes with zero Windows/drive-letter filename artifacts', () => {
    const polluted = scanWorkspaceRootForPollutedEntries(REPO_ROOT);
    expect(polluted).toEqual([]);
  });

  it('F12.3: redactSensitiveDiagnosticText scrubs macOS, Linux, Windows user homes, SteamID64, and auth tokens', () => {
    const rawLog = [
      'Launching /Users/portable_alice/Library/Application Support/CrossOver Preview/Bottles/OneLauncher-arm64',
      'Linux path /home/portable_bob/.local/share/OneLauncher',
      'Windows path C:\\Users\\portable_carol\\AppData\\Local\\OneLauncher',
      `SteamID=${E2E_SYNTHETIC_STEAM_ID}`,
      `EpicAccount=${E2E_SYNTHETIC_EPIC_ACCOUNT_ID}`,
      'Authorization: Bearer syntheticSuperSecretToken1234567890abcdef',
      'Authorization: XBL3.0 x=123456;eyJhbGciOiJIUzI1NiJ9.payload.sig',
    ].join('\n');

    const redacted = diagnosticLogger.redactSensitiveDiagnosticText(rawLog);
    expect(redacted).not.toContain('portable_alice');
    expect(redacted).not.toContain('portable_bob');
    expect(redacted).not.toContain('portable_carol');
    expect(redacted).not.toContain(E2E_SYNTHETIC_STEAM_ID);
    expect(redacted).not.toContain('syntheticSuperSecretToken1234567890abcdef');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted).toContain('[REDACTED]');
  });

  it('F12.4: formatUserFacingPath normalizes arbitrary user home directories to ~ portably', () => {
    const macFormatted = formatUserFacingPath(
      '/Users/portable_alpha/Library/Application Support/CrossOver Preview/Bottles/OneLauncher-arm64'
    );
    const winFormatted = formatUserFacingPath(
      'C:\\Users\\portable_beta\\Games\\TestGame\\game.exe'
    );

    expect(macFormatted).toMatch(/^~\//);
    expect(macFormatted).not.toContain('portable_alpha');
    expect(winFormatted).not.toContain('portable_beta');
  });

  it('F12.5: identical bundle/bottle workflows across two distinct synthetic user homes leave zero cross-home path leakage', async () => {
    const homeAlpha = path.join(sandbox.tmpRoot, 'portable_alpha_root');
    const homeBeta = path.join(sandbox.tmpRoot, 'portable_beta_root');
    const appsAlpha = path.join(homeAlpha, 'Applications');
    const appsBeta = path.join(homeBeta, 'Applications');
    fs.mkdirSync(appsAlpha, { recursive: true });
    fs.mkdirSync(appsBeta, { recursive: true });

    seedPreviewAppBundle(appsAlpha, { branch: 'arm64' });
    seedPreviewAppBundle(appsBeta, { branch: 'arm64' });
    seedBottle(path.join(homeAlpha, 'Library/Application Support/CrossOver Preview/Bottles'), 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    seedBottle(path.join(homeBeta, 'Library/Application Support/CrossOver Preview/Bottles'), 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const snapAlpha = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'arm64',
      homedir: homeAlpha,
      userDataDir: path.join(homeAlpha, 'userData'),
      customApplicationsDir: appsAlpha,
      applicationsDirs: [appsAlpha],
      skipNetwork: true,
      execFileSyncFn: () => {},
    });

    const snapBeta = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'arm64',
      homedir: homeBeta,
      userDataDir: path.join(homeBeta, 'userData'),
      customApplicationsDir: appsBeta,
      applicationsDirs: [appsBeta],
      skipNetwork: true,
      execFileSyncFn: () => {},
    });

    expect(snapAlpha.detectedRunners.some((r: any) => r.type === 'crossover_preview_arm64')).toBe(
      true
    );
    expect(snapAlpha.components.runner_crossover_preview_arm64?.status).toBe('ready');
    expect(snapBeta.detectedRunners.some((r: any) => r.type === 'crossover_preview_arm64')).toBe(
      true
    );
    expect(snapBeta.components.runner_crossover_preview_arm64?.status).toBe('ready');

    const serializedAlpha = JSON.stringify(snapAlpha);
    const serializedBeta = JSON.stringify(snapBeta);

    expect(serializedAlpha).toContain('portable_alpha_root');
    expect(serializedAlpha).not.toContain('portable_beta_root');
    expect(serializedBeta).toContain('portable_beta_root');
    expect(serializedBeta).not.toContain('portable_alpha_root');
  });
});
