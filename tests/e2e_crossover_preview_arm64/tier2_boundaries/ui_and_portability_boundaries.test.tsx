import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  E2ESandbox,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_STANDARD_PREVIEW_ZIP_URL,
  E2E_SYNTHETIC_STEAM_ID,
  type IpcBridgeHarness,
  asContractComponentId,
  asContractLayerType,
  createIsolatedE2ESandbox,
  createIpcAndServiceHarness,
  environmentHealthProber,
  extractVNodeText,
  findVNodeByTestId,
  findVNodes,
  flushMicrotasks,
  makeE2ECanonicalGame,
  makeE2ESnapshot,
  resetFrontendServiceSingletons,
  securityAndPathUtils,
  seedBottle,
  seedPreviewAppBundle,
} from '../harness';
import { CompatibilityAndBottleStep } from '../../../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { SystemSetupWizardModal } from '../../../src/components/Launcher/SystemSetupWizard/SystemSetupWizardModal';
import {
  CompatibilityLayerSection,
  type CompatibilityLayerSectionProps,
} from '../../../src/components/Launcher/LaunchConfig/CompatibilityLayerSection';
import { GameLaunchConfigModal } from '../../../src/components/Launcher/GameLaunchConfigModal';
import { useGameLaunchConfigForm } from '../../../src/components/Launcher/LaunchConfig/useGameLaunchConfigForm';
import {
  buildFallbackEnvironmentSnapshot,
  environmentSetupService,
} from '../../../src/services/launcher/environmentSetupService';
import { launcherService } from '../../../src/services/launcher/launcherService';
import { buildEffectiveLaunchModePreview } from '../../../src/services/launcher/launchPolicyPreview';
import { createDomain12DeepRenderer } from '../../helpers/xboxTestHarness';
import { scanContentForPiiViolations } from '../../helpers/piiHygieneGuard';

function makeCompatSectionProps(
  overrides: Partial<CompatibilityLayerSectionProps> = {}
): CompatibilityLayerSectionProps {
  const game = makeE2ECanonicalGame();
  const preview = buildEffectiveLaunchModePreview({
    game,
    preferredPlatformId: 'steam',
    draftConfig: { launchMethod: 'compatibility_layer', compatibilityLayer: 'crossover_preview' },
    hostPlatform: 'darwin',
    hostArch: 'arm64',
    layers: [],
    globalStorefrontLifecycle: 'minimal_and_close_if_started',
  });

  return {
    isWindowsHost: false,
    preview,
    activeDisplayMethod: 'compatibility_layer',
    detectedLayers: [],
    runnerUpdates: {},
    compatibilityLayer: 'crossover_preview',
    onSelectCompatibilityLayer: vi.fn(),
    availableBottles: [],
    wineBottleName: '',
    onChangeWineBottleName: vi.fn(),
    selectedRunnerDescriptor: {
      type: 'crossover_preview',
      label: 'CrossOver Preview',
      shortLabel: 'CrossOver Preview',
      vendor: 'CodeWeavers',
      description: 'CodeWeavers CrossOver Preview',
      bestFor: 'Upcoming CrossOver Preview features',
      downloadUrl: 'https://www.codeweavers.com/preview/download',
      downloadLabel: 'Download CrossOver Preview',
      canAutoInstallDirect: true,
    },
    activeSecondaryBuildText: '',
    isCheckingUpdates: false,
    isUpdatingRunner: false,
    onUpdateRunner: vi.fn(),
    onCheckRunnerUpdates: vi.fn(),
    onOpenBottleFolder: vi.fn(),
    isRescanningRunners: false,
    onRescanLayers: vi.fn(),
    isInstallingRunner: false,
    onInstallRunnerViaBrew: vi.fn(),
    onDownloadRunner: vi.fn(),
    runnerUpdateFeedback: null,
    runnerActionFeedback: null,
    winePrefixPath: '',
    onChangeWinePrefixPath: vi.fn(),
    onBrowseWinePrefix: vi.fn(),
    crossoverGraphicsBackend: 'auto',
    onChangeCrossoverGraphicsBackend: vi.fn(),
    crossoverD3DMetalVersion: 'auto',
    onChangeCrossoverD3DMetalVersion: vi.fn(),
    showD3DMetalVersionSelector: true,
    primaryD3DVer: '4.0b3',
    fallbackD3DVer: '3.0',
    onChangeCrossoverHighResolutionMode: vi.fn(),
    isDlssSupportedBackend: true,
    isDxvkHudSupported: true,
    crossoverDlss: false,
    onToggleCrossoverDlss: vi.fn(),
    wineMsync: true,
    onToggleWineMsync: vi.fn(),
    wineEsync: false,
    onToggleWineEsync: vi.fn(),
    metalHud: false,
    onToggleMetalHud: vi.fn(),
    dxvkHud: false,
    onToggleDxvkHud: vi.fn(),
    ...overrides,
  };
}

describe('Tier 2 — F10 & F12 Boundaries: UI Gating, R1 Defect Regression & Portability Hygiene', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t2-uipii-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F10 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F10.B1: x64 Intel Mac host hides crossover_preview_arm64 in Setup Wizard and Launch Config while arm64 Apple Silicon shows it', async () => {
    const intelSnapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'x64',
      isAppleSiliconMac: false,
      detectedRunners: [],
    });
    const armSnapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      isAppleSiliconMac: true,
      detectedRunners: [],
    });

    const intelWizard = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
      snapshot: intelSnapshot,
      chosenRunner: 'crossover_preview',
      onSelectRunner: vi.fn(),
      bottleMode: 'create_dedicated',
      onChangeBottleMode: vi.fn(),
      bottleName: 'OneLauncher',
      onChangeBottleName: vi.fn(),
    });
    const intelWizardTree = intelWizard.render();
    expect(findVNodeByTestId(intelWizardTree, 'setup-runner-crossover-preview')).toBeDefined();
    expect(
      findVNodeByTestId(intelWizardTree, 'setup-runner-crossover-preview-arm64')
    ).toBeUndefined();
    intelWizard.unmount();

    const armWizard = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
      snapshot: armSnapshot,
      chosenRunner: 'crossover_preview',
      onSelectRunner: vi.fn(),
      bottleMode: 'create_dedicated',
      onChangeBottleMode: vi.fn(),
      bottleName: 'OneLauncher',
      onChangeBottleName: vi.fn(),
    });
    const armWizardTree = armWizard.render();
    expect(findVNodeByTestId(armWizardTree, 'setup-runner-crossover-preview-arm64')).toBeDefined();
    armWizard.unmount();

    const x64Bridge = createIpcAndServiceHarness({ arch: 'x64', platform: 'darwin' });
    try {
      await launcherService.initialize();
      const props = makeCompatSectionProps({ compatibilityLayer: 'crossover_preview' });
      const sectionRenderer = createDomain12DeepRenderer(CompatibilityLayerSection, props);
      const sectionTree = sectionRenderer.render();
      const selectNode = findVNodeByTestId(sectionTree, 'compat-runner-select');
      const optionValues = findVNodes(selectNode, (n) => n.type === 'option').map(
        (n) => n.props?.value
      );
      expect(optionValues).toContain('crossover_preview');
      expect(optionValues).not.toContain('crossover_preview_arm64');
      sectionRenderer.unmount();
    } finally {
      x64Bridge.dispose();
    }

    const armBridge = createIpcAndServiceHarness({ arch: 'arm64', platform: 'darwin' });
    try {
      await launcherService.initialize();
      const props = makeCompatSectionProps({ compatibilityLayer: 'crossover_preview' });
      const sectionRenderer = createDomain12DeepRenderer(CompatibilityLayerSection, props);
      const sectionTree = sectionRenderer.render();
      const selectNode = findVNodeByTestId(sectionTree, 'compat-runner-select');
      const optionValues = findVNodes(selectNode, (n) => n.type === 'option').map(
        (n) => n.props?.value
      );
      expect(optionValues).toContain('crossover_preview');
      expect(optionValues).toContain('crossover_preview_arm64');
      sectionRenderer.unmount();
    } finally {
      armBridge.dispose();
    }
  });

  it('F10.B2: zero duplicate Sign-In UI buttons when !activeLayer && authRequired in Setup Wizard and Launch Config', () => {
    const authSnapshot = makeE2ESnapshot({
      hostPlatform: 'darwin',
      hostArch: 'arm64',
      isAppleSiliconMac: true,
      components: {
        runner_crossover_preview: {
          status: 'missing',
          authRequired: true,
          canAutoInstall: true,
        },
      },
    });

    const wizardRenderer = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
      snapshot: authSnapshot,
      chosenRunner: 'crossover_preview',
      onSelectRunner: vi.fn(),
      bottleMode: 'create_dedicated',
      onChangeBottleMode: vi.fn(),
      bottleName: 'OneLauncher',
      onChangeBottleName: vi.fn(),
      selectedIds: new Set([asContractComponentId('runner_crossover_preview')]),
    });
    const wizardTree = wizardRenderer.render();
    const wizardSignInButtons = findVNodes(
      wizardTree,
      (n) =>
        n.type === 'button' &&
        n.props?.role !== 'radio' &&
        !String(n.props?.['data-testid'] || '').startsWith('setup-runner-') &&
        /sign\s*in/i.test(String(n.props?.['data-testid'] || '') + extractVNodeText(n))
    );
    expect(wizardSignInButtons.length).toBeLessThanOrEqual(1);
    wizardRenderer.unmount();

    const sectionRenderer = createDomain12DeepRenderer(
      CompatibilityLayerSection,
      makeCompatSectionProps({
        compatibilityLayer: 'crossover_preview',
        activeLayer: undefined,
        activeUpdateInfo: {
          runnerType: 'crossover_preview',
          installed: false,
          updateAvailable: false,
          authRequired: true,
          canAutoUpdate: true,
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
      })
    );
    const sectionTree = sectionRenderer.render();
    const signInRowBtn = findVNodeByTestId(sectionTree, 'sign-in-runner-btn');
    const calloutInstallBtn = findVNodeByTestId(sectionTree, 'install-runner-brew-btn');
    const bothAreSignIn =
      Boolean(signInRowBtn) &&
      Boolean(calloutInstallBtn) &&
      /sign\s*in/i.test(extractVNodeText(calloutInstallBtn));
    expect(bothAreSignIn).toBe(false);
    sectionRenderer.unmount();
  });

  it('F10.B3: handleInstallRunnerViaBrew catches installCompatibilityLayer rejections cleanly and displays error feedback', async () => {
    const game = makeE2ECanonicalGame();
    let bridge: IpcBridgeHarness | null = null;
    bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        detectCompatibilityLayers: vi.fn(() => []),
        checkCompatibilityLayerUpdates: vi.fn(async () => ({})),
        installCompatibilityLayer: vi.fn(async (payload: any) => {
          bridge?.emitBroadcast('launcher:compat-runner-progress', {
            runnerType: payload?.runnerType || 'crossover_preview_arm64',
            operation: 'install',
            phase: 'failed',
            progressPercent: null,
            message: 'Synthetic install transport failure',
            updatedAt: new Date().toISOString(),
          });
          throw new Error('Synthetic install transport failure');
        }),
        getGameLaunchConfigs: vi.fn(() => ({
          [game.id]: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover_preview_arm64',
          },
        })),
      },
    });

    try {
      await launcherService.initialize();
      let formA: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const FormHarnessA = () => {
        formA = useGameLaunchConfigForm({
          isOpen: true,
          game,
          onClose: vi.fn(),
        });
        return React.createElement('div', { 'data-testid': 'form-harness-a' });
      };
      const renderer = createDomain12DeepRenderer(FormHarnessA, {});

      renderer.render();
      await flushMicrotasks();
      renderer.render();

      // 1) IPC rejection handled cleanly -> runnerActionFeedback displays error text
      await expect(formA!.handleInstallRunnerViaBrew()).resolves.toBeUndefined();
      await flushMicrotasks();
      renderer.render();
      expect(formA!.runnerActionFeedback?.text || '').toMatch(
        /Synthetic install transport failure|Could not install/i
      );
      renderer.unmount();

      // 2) Direct service rejection inside handleInstallRunnerViaBrew on a clean form instance
      //    must actively invoke installCompatibilityLayer and catch the rejection cleanly
      resetFrontendServiceSingletons();
      await launcherService.initialize();

      let formRetry: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const FormHarnessRetry = () => {
        formRetry = useGameLaunchConfigForm({
          isOpen: true,
          game,
          onClose: vi.fn(),
        });
        return React.createElement('div', { 'data-testid': 'form-harness-retry' });
      };
      const retryRenderer = createDomain12DeepRenderer(FormHarnessRetry, {});
      try {
        retryRenderer.render();
        await flushMicrotasks();
        retryRenderer.render();

        const installSpy = vi
          .spyOn(launcherService, 'installCompatibilityLayer')
          .mockRejectedValueOnce(new Error('Synthetic service failure'));
        try {
          await expect(formRetry!.handleInstallRunnerViaBrew()).resolves.toBeUndefined();
          expect(installSpy).toHaveBeenCalledTimes(1);
          await flushMicrotasks();
          retryRenderer.render();
          expect(formRetry!.runnerActionFeedback?.text || '').toMatch(
            /Synthetic service failure|Could not install/i
          );
        } finally {
          installSpy.mockRestore();
        }
      } finally {
        retryRenderer.unmount();
      }
    } finally {
      bridge.dispose();
    }
  });

  it('F10.B4: Sign-In vs Update disambiguation passes authenticateOnly: true when authRequired, and omits it when updateAvailable with downloadUrl', async () => {
    const game = makeE2ECanonicalGame();
    const updateCalls: any[] = [];
    let authRequired = true;
    let bridge: IpcBridgeHarness | null = null;

    bridge = createIpcAndServiceHarness({
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
            version: '20261015',
            availableBottles: ['OneLauncher-arm64'],
          },
        ]),
        checkCompatibilityLayerUpdates: vi.fn(async () => ({
          crossover_preview_arm64: {
            runnerType: 'crossover_preview_arm64',
            installed: true,
            installedVersion: '20261015',
            latestVersion: authRequired ? undefined : '20261111',
            updateAvailable: !authRequired,
            authRequired,
            downloadUrl: authRequired ? undefined : E2E_ARM64_PREVIEW_ZIP_URL,
            canAutoUpdate: true,
            checkedAt: '2026-11-18T00:00:00.000Z',
          },
        })),
        updateCompatibilityLayer: vi.fn(async (payload: any) => {
          updateCalls.push(payload);
          authRequired = false;
          const runnerType = payload?.runnerType || 'crossover_preview_arm64';
          bridge?.emitBroadcast('launcher:compat-runner-progress', {
            runnerType,
            operation: 'update',
            phase: 'completed',
            progressPercent: 100,
            message: payload?.authenticateOnly
              ? 'CrossOver Preview session authenticated.'
              : 'CrossOver Preview updated.',
            updatedAt: new Date().toISOString(),
          });
          return {
            success: true,
            runnerType,
            updated: !payload.authenticateOnly,
            authenticated: true,
          };
        }),
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
      let formRef: ReturnType<typeof useGameLaunchConfigForm> | null = null;
      const FormHarness = () => {
        formRef = useGameLaunchConfigForm({
          isOpen: true,
          game,
          onClose: vi.fn(),
        });
        return React.createElement('div', { 'data-testid': 'form-harness-b4' });
      };
      const renderer = createDomain12DeepRenderer(FormHarness, {});

      renderer.render();
      await flushMicrotasks();
      renderer.render();

      expect(formRef!.activeUpdateInfo?.authRequired).toBe(true);
      await formRef!.handleUpdateRunner();
      await flushMicrotasks();
      renderer.render();

      expect(updateCalls[0]?.authenticateOnly).toBe(true);
      expect(updateCalls[0]?.runnerType).toBe('crossover_preview_arm64');

      expect(formRef!.activeUpdateInfo?.updateAvailable).toBe(true);
      await formRef!.handleUpdateRunner();
      await flushMicrotasks();

      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[1]?.authenticateOnly).toBeFalsy();
      expect(updateCalls[1]?.runnerType).toBe('crossover_preview_arm64');

      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('F10.B5: invalid bottle names (../bad, empty, >64 chars) show role="alert" and disable Next in SystemSetupWizardModal', async () => {
    const snap = makeE2ESnapshot({ hostPlatform: 'darwin', hostArch: 'arm64' });
    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        probeEnvironmentHealth: vi.fn(async () => snap),
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

      const input = findVNodeByTestId(tree, 'setup-bottle-name-input');
      expect(input).toBeDefined();

      for (const invalidName of ['', '../bad', 'A'.repeat(65)]) {
        input.props.onChange?.({ target: { value: invalidName } });
        tree = renderer.render();
        const nextBtn = findVNodeByTestId(tree, 'setup-next-step-btn');
        expect(nextBtn?.props?.disabled).toBe(true);
        const alerts = findVNodes(tree, (n) => n.props?.role === 'alert');
        expect(alerts.length).toBeGreaterThanOrEqual(1);
      }

      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // F12 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F12.B1: scanContentForPiiViolations detects injected non-allowlisted /Users/<name>/ and C:\\Users\\<name>\\', () => {
    const macSample = ['const p = "', '/', 'Users/', 'alpha_person', '/Library/CrossOver";'].join(
      ''
    );
    const winSample = ['const p = "C:\\\\', 'Users\\\\', 'alpha_person', '\\\\Games";'].join('');
    const macViolations = scanContentForPiiViolations(macSample, 'synthetic/sample.ts');
    const winViolations = scanContentForPiiViolations(winSample, 'synthetic/sample.ts');
    expect(macViolations.length).toBeGreaterThan(0);
    expect(winViolations.length).toBeGreaterThan(0);
  });

  it('F12.B2: scanContentForPiiViolations detects real-format SteamID64, GOG ID, Bearer token, and webmail', () => {
    const fakeSteam = ['7656119', '8123456789'].join('');
    const fakeGog = ['4968', '1234567890123'].join('');
    const fakeBearer = ['Bea', 'rer ', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('');
    const fakeEmail = ['someone@', 'gmail', '.com'].join('');
    const badSample = [
      `const steam = "${fakeSteam}";`,
      `const gog = "${fakeGog}";`,
      `const auth = "${fakeBearer}";`,
      `const email = "${fakeEmail}";`,
    ].join('\n');

    const violations = scanContentForPiiViolations(badSample, 'src/synthetic.ts');
    expect(violations.length).toBeGreaterThanOrEqual(4);
  });

  it('F12.B3: sanitizeLaunchConfigRecursive strips machineIdOverride, tokensFilePath, homedir, and crossoverPath', () => {
    const cleaned = securityAndPathUtils.sanitizeLaunchConfigRecursive({
      compatibilityLayer: 'crossover_preview_arm64',
      wineBottleName: 'OneLauncher-arm64',
      homedir: '/Users/synthetic_user',
      machineIdOverride: 'UUID-1234',
      tokensFilePath: '/Users/synthetic_user/tokens.json',
      crossoverPath: '/custom/CrossOver.app',
    });

    expect(cleaned.compatibilityLayer).toBe('crossover_preview_arm64');
    expect(cleaned.wineBottleName).toBe('OneLauncher-arm64');
    expect(cleaned.homedir).toBeUndefined();
    expect(cleaned.machineIdOverride).toBeUndefined();
    expect(cleaned.tokensFilePath).toBeUndefined();
    expect(cleaned.crossoverPath).toBeUndefined();
  });

  it('F12.B4: cxbottle.conf and setup_wizard_state.json written for portable_alpha contain zero machine UUIDs or personal paths', async () => {
    const portableHome = path.join(sandbox.tmpRoot, 'portable_alpha');
    const appsDir = path.join(portableHome, 'Applications');
    const userDataDir = path.join(portableHome, 'userData');
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    seedPreviewAppBundle(appsDir, { branch: 'arm64' });
    const bottleDir = seedBottle(
      path.join(portableHome, 'Library/Application Support/CrossOver Preview/Bottles'),
      'OneLauncher-arm64',
      { wineArch: 'arm64', previewEnabled: true }
    );
    environmentHealthProber.saveSetupWizardState(
      {
        completedAt: '2026-11-18T00:00:00.000Z',
        preferredRunnerType: 'crossover_preview_arm64',
        preferredBottleName: 'OneLauncher-arm64',
        configuredComponents: ['runner_crossover_preview_arm64', 'bottle_default'],
      },
      { userDataDir }
    );

    const confText = fs.readFileSync(path.join(bottleDir, 'cxbottle.conf'), 'utf8');
    const stateJson = fs.readFileSync(path.join(userDataDir, 'setup-wizard-state.json'), 'utf8');

    expect(scanContentForPiiViolations(confText, 'cxbottle.conf')).toEqual([]);
    expect(scanContentForPiiViolations(stateJson, 'setup-wizard-state.json')).toEqual([]);
    expect(stateJson).not.toContain('IOPlatformUUID');
  });

  it('F12.B5: buildFallbackEnvironmentSnapshot contains zero hardcoded personal user home paths', () => {
    const fallback = buildFallbackEnvironmentSnapshot(['steam']);
    const json = JSON.stringify(fallback);
    expect(scanContentForPiiViolations(json, 'fallback-snapshot.json')).toEqual([]);
    expect(json).not.toMatch(/\/Users\/(?!Shared|test|user)[^"]+/);
  });
});
