import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  E2ESandbox,
  E2ECompatibilityLayerType,
  E2EBottleWineArch,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_STANDARD_PREVIEW_ZIP_URL,
  asContractLayerType,
  buildSyntheticPeBinary,
  createIsolatedE2ESandbox,
  createIpcAndServiceHarness,
  environmentHealthProber,
  environmentProvisioner,
  extractVNodeText,
  findVNodeByTestId,
  findVNodes,
  flushMicrotasks,
  macNativeInstaller,
  makeE2ECanonicalGame,
  makeE2ESnapshot,
  seedBottle,
  seedPreviewAppBundle,
  sessionSupervisor,
} from '../harness';
import { CompatibilityAndBottleStep } from '../../../src/components/Launcher/SystemSetupWizard/steps/CompatibilityAndBottleStep';
import { GameLaunchConfigModal } from '../../../src/components/Launcher/GameLaunchConfigModal';
import { launcherService } from '../../../src/services/launcher/launcherService';
import { environmentSetupService } from '../../../src/services/launcher/environmentSetupService';
import { createDomain12DeepRenderer } from '../../helpers/xboxTestHarness';

describe('Tier 3 — Pairwise Combinatorial Interactions Across Branches, Host Arch, Bottles, Auth & UI', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t3-pairwise-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // Matrix 1: (crossover_preview vs crossover_preview_arm64) x (arm64 vs x64 hostArch)
  // --------------------------------------------------------------------------

  it.each<{
    runner: 'crossover_preview' | 'crossover_preview_arm64';
    hostArch: 'arm64' | 'x64';
    expectSupported: boolean;
  }>([
    { runner: 'crossover_preview', hostArch: 'arm64', expectSupported: true },
    { runner: 'crossover_preview', hostArch: 'x64', expectSupported: true },
    { runner: 'crossover_preview_arm64', hostArch: 'arm64', expectSupported: true },
    { runner: 'crossover_preview_arm64', hostArch: 'x64', expectSupported: false },
  ])(
    'P1 ($runner x hostArch=$hostArch): Setup Wizard & launch gate enforce host-arch boundary (supported=$expectSupported)',
    async ({ runner, hostArch, expectSupported }) => {
      const snap = makeE2ESnapshot({
        hostPlatform: 'darwin',
        hostArch,
        isAppleSiliconMac: hostArch === 'arm64',
      });

      const wizardRenderer = createDomain12DeepRenderer(CompatibilityAndBottleStep, {
        snapshot: snap,
        chosenRunner: asContractLayerType(runner),
        onSelectRunner: vi.fn(),
        bottleMode: 'create_dedicated',
        onChangeBottleMode: vi.fn(),
        bottleName: runner === 'crossover_preview_arm64' ? 'OneLauncher-arm64' : 'OneLauncher',
        onChangeBottleName: vi.fn(),
      });
      const tree = wizardRenderer.render();
      const testId =
        runner === 'crossover_preview_arm64'
          ? 'setup-runner-crossover-preview-arm64'
          : 'setup-runner-crossover-preview';

      if (expectSupported) {
        expect(findVNodeByTestId(tree, testId)).toBeDefined();
      } else {
        expect(findVNodeByTestId(tree, testId)).toBeUndefined();
      }
      wizardRenderer.unmount();

      if (runner === 'crossover_preview_arm64' && !expectSupported) {
        seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
        const setupRes = await environmentProvisioner.runEnvironmentSetupTasks(
          {
            runId: 'p1-x64-reject',
            tasks: [
              {
                action: 'install_runner',
                componentId: 'runner_crossover_preview_arm64',
                runnerType: 'crossover_preview_arm64',
              },
            ],
          },
          {
            platform: 'darwin',
            arch: 'x64',
            homedir: sandbox.homedir,
            userDataDir: sandbox.userDataDir,
            customApplicationsDir: sandbox.applicationsDir,
            applicationsDirs: [sandbox.applicationsDir],
            skipNetwork: true,
          }
        );
        expect(setupRes.success).toBe(false);
        expect(setupRes.outcomes[0]?.status).toBe('failed');
        expect(setupRes.outcomes[0]?.status).not.toBe('opened_external');
        expect(
          String(setupRes.outcomes[0]?.error || setupRes.outcomes[0]?.message || '')
        ).toMatch(/apple silicon|arm64|intel|arch|unsupported/i);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Matrix 2: Dual-branch side-by-side install + bottle isolation + UI runner switching
  // --------------------------------------------------------------------------

  it('P2: Dual-branch side-by-side install preserves both bundles & bottles without cross-contamination', async () => {
    const stdZip = path.join(sandbox.downloadsDir, 'crossover-preview-20261111.zip');
    const armZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stdZip, 'PK\x03\x04STD', 'utf8');
    fs.writeFileSync(armZip, 'PK\x03\x04ARM', 'utf8');

    const stdRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      archivePath: stdZip,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zip: string, dir: string) => {
        seedPreviewAppBundle(dir, { branch: 'standard', appName: 'CrossOver Preview.app' });
      },
    });
    const armRes = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      archivePath: armZip,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zip: string, dir: string) => {
        seedPreviewAppBundle(dir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
      },
    });

    expect(stdRes.success).toBe(true);
    expect(armRes.success).toBe(true);

    const stdBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
      sentinelMarkerFile: 'users/crossover/std.txt',
    });
    const armBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
      sentinelMarkerFile: 'users/crossover/arm.txt',
    });

    const detected = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    expect(detected.some((l: any) => l.type === 'crossover_preview')).toBe(true);
    expect(detected.some((l: any) => l.type === 'crossover_preview_arm64')).toBe(true);
    expect(fs.readFileSync(path.join(stdBottle, 'cxbottle.conf'), 'utf8')).toContain('"WineArch" = "win64"');
    expect(fs.readFileSync(path.join(armBottle, 'cxbottle.conf'), 'utf8')).toContain('"WineArch" = "arm64"');
  });

  it('P3: Switching runner between crossover_preview_arm64 and crossover_preview in GameLaunchConfigModal updates bottle placeholder & default select label without corrupting persisted config', async () => {
    const game = makeE2ECanonicalGame();
    const layers = [
      {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        binaryPath: '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
        availableBottles: [],
      },
      {
        id: 'crossover_preview_arm64',
        type: 'crossover_preview_arm64',
        name: 'CrossOver Preview (arm64 / FEX)',
        binaryPath:
          '/Applications/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/wine',
        availableBottles: [],
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

      const runnerSelect = findVNodeByTestId(tree, 'compat-runner-select');
      const bottleInputBefore = findVNodes(
        tree,
        (n) => n.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(bottleInputBefore?.type).toBe('input');
      expect(String(bottleInputBefore?.props?.placeholder || '')).toContain('OneLauncher-arm64');

      runnerSelect.props.onChange?.({ target: { value: 'crossover_preview' } });
      tree = renderer.render();

      const bottleInputAfter = findVNodes(
        tree,
        (n) => n.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(bottleInputAfter?.type).toBe('input');
      expect(String(bottleInputAfter?.props?.placeholder || '')).toContain('OneLauncher');
      expect(String(bottleInputAfter?.props?.placeholder || '')).not.toContain('OneLauncher-arm64');

      renderer.unmount();
    } finally {
      bridge.dispose();
    }

    // Also verify non-empty availableBottles renders <select> default option labels per runner
    const populatedBridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        detectCompatibilityLayers: vi.fn(() => [
          { ...layers[0], availableBottles: ['OneLauncher'] },
          { ...layers[1], availableBottles: ['OneLauncher-arm64'] },
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

      const bottleSelBefore = findVNodes(
        tree,
        (n) => n.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(extractVNodeText(bottleSelBefore)).toContain('Default Bottle (OneLauncher-arm64)');

      const runnerSelect = findVNodeByTestId(tree, 'compat-runner-select');
      runnerSelect.props.onChange?.({ target: { value: 'crossover_preview' } });
      tree = renderer.render();

      const bottleSelAfter = findVNodes(
        tree,
        (n) => n.props?.id === 'compat-target-bottle-control'
      )[0];
      expect(extractVNodeText(bottleSelAfter)).toContain('Default Bottle (OneLauncher)');
      expect(extractVNodeText(bottleSelAfter)).not.toContain('OneLauncher-arm64');

      renderer.unmount();
    } finally {
      populatedBridge.dispose();
    }
  });

  // --------------------------------------------------------------------------
  // Matrix 3: (authRequired vs authenticated vs update_available) x Cross-Service Sync
  // --------------------------------------------------------------------------

  it.each<{
    authState: 'authRequired' | 'authenticated_uptodate' | 'update_available';
  }>([
    { authState: 'authRequired' },
    { authState: 'authenticated_uptodate' },
    { authState: 'update_available' },
  ])(
    'P4 ($authState): LauncherService, EnvironmentSetupService, and prober cache synchronize dynamically across auth/update transitions',
    async ({ authState }) => {
      const targetUpdateAvailable = authState === 'update_available';
      const targetAuthRequired = authState === 'authRequired';

      let liveAuthRequired = true;
      let liveUpdateAvailable = false;
      let liveVersion = targetUpdateAvailable ? '20261015' : '20261111';

      macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_ARM64_PREVIEW_ZIP_URL, {
        previewBranch: 'arm64',
      });

      const buildUpdates = () => ({
        crossover_preview_arm64: {
          runnerType: 'crossover_preview_arm64',
          installed: true,
          installedVersion: liveVersion,
          latestVersion: liveAuthRequired ? undefined : '20261111',
          updateAvailable: liveUpdateAvailable,
          authRequired: liveAuthRequired,
          downloadUrl: liveAuthRequired ? undefined : E2E_ARM64_PREVIEW_ZIP_URL,
          canAutoUpdate: true,
          checkedAt: '2026-11-18T00:00:00.000Z',
        },
      });

      const bridge = createIpcAndServiceHarness({
        arch: 'arm64',
        platform: 'darwin',
        engineOverrides: {
          detectCompatibilityLayers: vi.fn(() => [
            {
              id: 'crossover_preview_arm64',
              type: 'crossover_preview_arm64',
              name: 'CrossOver Preview (arm64 / FEX)',
              binaryPath: '/tmp/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/wine',
              version: liveVersion,
            },
          ]),
          checkCompatibilityLayerUpdates: vi.fn(async () => buildUpdates()),
          updateCompatibilityLayer: vi.fn(async (payload: any) => {
            if (!targetAuthRequired && payload.authenticateOnly) {
              liveAuthRequired = false;
              liveUpdateAvailable = targetUpdateAvailable;
            }
            environmentHealthProber.invalidateProberRunnerUpdatesCache();
            return {
              success: !targetAuthRequired,
              runnerType: 'crossover_preview_arm64',
              updated: false,
              authenticated: !liveAuthRequired,
            };
          }),
          probeEnvironmentHealth: vi.fn(async () =>
            makeE2ESnapshot({
              components: {
                runner_crossover_preview_arm64: {
                  status: liveUpdateAvailable ? 'update_available' : 'ready',
                  authRequired: liveAuthRequired,
                  downloadUrl: liveAuthRequired ? undefined : E2E_ARM64_PREVIEW_ZIP_URL,
                  version: liveVersion,
                  latestVersion: liveAuthRequired ? undefined : '20261111',
                },
              },
            })
          ),
        },
      });

      try {
        await launcherService.initialize();
        await environmentSetupService.probeHealth(['steam'], { forceFresh: true });

        // Trigger real service mutation via LauncherService -> must sync EnvironmentSetupService & prober cache
        await launcherService.updateCompatibilityLayer(
          asContractLayerType('crossover_preview_arm64'),
          { authenticateOnly: true }
        );

        const updateEntry = launcherService.getRunnerUpdates()['crossover_preview_arm64'];
        const snapComp = (environmentSetupService.getLastSnapshot()?.components as Record<string, any>)
          ?.runner_crossover_preview_arm64;

        expect(Boolean(updateEntry?.authRequired)).toBe(targetAuthRequired);
        expect(Boolean(snapComp?.authRequired)).toBe(targetAuthRequired);
        if (targetAuthRequired) {
          expect(updateEntry?.downloadUrl).toBeUndefined();
          expect(snapComp?.downloadUrl).toBeUndefined();
        } else {
          expect(updateEntry?.downloadUrl).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
          expect(snapComp?.downloadUrl).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
        }
        expect(snapComp?.status).toBe(targetUpdateAvailable ? 'update_available' : 'ready');
        expect(
          macNativeInstaller.getCachedAuthenticatedPreviewUrl({
            allowCachedPreviewUrlInTest: true,
            previewBranch: 'arm64',
          })
        ).toBeNull();
      } finally {
        bridge.dispose();
      }
    }
  );

  // --------------------------------------------------------------------------
  // Matrix 4: (win64 vs arm64 bottle) x (crossover vs crossover_preview vs crossover_preview_arm64)
  //           and (dxmt vs d3dmetal vs dxvk) graphics backends
  // --------------------------------------------------------------------------

  it.each<{
    runner: Exclude<E2ECompatibilityLayerType, 'native' | 'gptk' | 'wine'>;
    bottleArch: E2EBottleWineArch;
    expectCompatible: boolean;
  }>([
    { runner: 'crossover', bottleArch: 'win64', expectCompatible: true },
    { runner: 'crossover', bottleArch: 'arm64', expectCompatible: false },
    { runner: 'crossover_preview', bottleArch: 'win64', expectCompatible: true },
    { runner: 'crossover_preview', bottleArch: 'arm64', expectCompatible: false },
    { runner: 'crossover_preview_arm64', bottleArch: 'arm64', expectCompatible: true },
    { runner: 'crossover_preview_arm64', bottleArch: 'win64', expectCompatible: false },
  ])(
    'P5 ($runner x $bottleArch bottle): runner <-> bottle WineArch compatibility check (compatible=$expectCompatible)',
    async ({ runner, bottleArch, expectCompatible }) => {
      const branch =
        runner === 'crossover' ? 'crossover' : runner === 'crossover_preview_arm64' ? 'arm64' : 'standard';
      seedPreviewAppBundle(sandbox.applicationsDir, { branch });
      const bottlesRoot =
        runner === 'crossover' ? sandbox.crossoverBottlesDir : sandbox.previewBottlesDir;
      const bottleName = bottleArch === 'arm64' ? 'OneLauncher-arm64' : 'OneLauncher';
      seedBottle(bottlesRoot, bottleName, {
        wineArch: bottleArch,
        previewEnabled: runner !== 'crossover',
      });

      const layers = macNativeInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        applicationsDirs: [sandbox.applicationsDir],
      });
      const layer = layers.find((l: any) => l.type === runner);
      expect(layer).toBeDefined();

      const res = await macNativeInstaller
        .ensureCompatibilityLayerReady(
          layer,
          { compatibilityLayer: runner, wineBottleName: bottleName },
          {},
          { homedir: sandbox.homedir, skipRegistrySpawn: true }
        )
        .then((r: any) => ({ ok: true, ...r }))
        .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

      if (expectCompatible) {
        expect(res.ok).toBe(true);
        expect(res.error).toBeUndefined();
      } else {
        expect(res.ok === false || Boolean(res.error)).toBe(true);
      }
    }
  );

  it.each<Array<'dxmt' | 'd3dmetal' | 'dxvk'>>([
    ['dxmt'],
    ['d3dmetal'],
    ['dxvk'],
  ])(
    'P6 (crossover_preview_arm64 x %s): graphics backend routes cleanly in arm64 FEX bottle',
    async (backend) => {
      const bundle = seedPreviewAppBundle(sandbox.applicationsDir, {
        branch: 'arm64',
        withD3dMetal: true,
        withDxmt32: true,
        withDxvk32: true,
      });
      const bottleDir = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        previewEnabled: true,
      });

      const routed = macNativeInstaller.resolveEffectiveCrossOverGraphicsBackend({
        compatLayer: {
          type: 'crossover_preview_arm64',
          appPath: bundle.appPath,
          binaryPath: bundle.wineBinary,
        },
        cxRoot: bundle.cxRoot,
        bottlePath: bottleDir,
        requestedBackend: backend,
        hostArch: 'arm64',
      });

      expect(routed.backend).toBe(backend);
    }
  );
});
