import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  E2ESandbox,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_STANDARD_PREVIEW_ZIP_URL,
  E2E_STABLE_CXMAC_XML_URL,
  type IpcBridgeHarness,
  asContractLayerType,
  buildSyntheticPeBinary,
  createIsolatedE2ESandbox,
  createIpcAndServiceHarness,
  createMockPreviewPortalElectron,
  diagnosticLogger,
  environmentHealthProber,
  environmentProvisioner,
  findVNodeByTestId,
  findVNodes,
  flushMicrotasks,
  macNativeInstaller,
  makeE2ECanonicalGame,
  makeE2ESnapshot,
  makeMockStatfs,
  makeSimpleSetupSuccessResult,
  seedBottle,
  seedPreviewAppBundle,
  sessionSupervisor,
} from '../harness';
import { SystemSetupWizardModal } from '../../../src/components/Launcher/SystemSetupWizard/SystemSetupWizardModal';
import { GameLaunchConfigModal } from '../../../src/components/Launcher/GameLaunchConfigModal';
import { launcherService } from '../../../src/services/launcher/launcherService';
import { environmentSetupService } from '../../../src/services/launcher/environmentSetupService';
import { createDomain12DeepRenderer } from '../../helpers/xboxTestHarness';
import { scanContentForPiiViolations } from '../../helpers/piiHygieneGuard';

describe('Tier 4 — End-to-End Real-World User Scenarios', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t4-scenarios-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('Scenario 1: Fresh Apple Silicon setup via Setup Wizard -> sign-in -> background install/rename Arm64 Preview -> OneLauncher-arm64 provisioning -> Launch Config -> FEX launch & wineserver lifecycle', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: false,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL, E2E_ARM64_PREVIEW_ZIP_URL],
    });
    const armZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(armZip, 'PK\x03\x04ARM64ZIP', 'utf8');

    const spawned: Array<{ cmd: string; env: Record<string, any> }> = [];
    const mockSpawnFn = vi.fn((cmd: string, _args: string[], opts: { env?: Record<string, any> }) => {
      spawned.push({ cmd, env: opts?.env || {} });
      const child = new EventEmitter() as any;
      child.pid = 51001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    });

    const game = makeE2ECanonicalGame({
      id: 'scenario1-game',
      title: 'FreshSetupGame',
    });
    const savedConfigs: Record<string, any> = {};

    const setupOptions = {
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      homedir: sandbox.homedir,
      userDataDir: sandbox.userDataDir,
      customApplicationsDir: sandbox.applicationsDir,
      applicationsDirs: [sandbox.applicationsDir],
      allowInteractivePreviewCapture: true,
      statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
      electronMod: portal.electronMod,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zip: string, dir: string) => {
        seedPreviewAppBundle(dir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
      },
      execFileFn: (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: Error | null, out?: string, err?: string) => void
      ) => {
        if (String(cmd).includes('cxbottle')) {
          seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
            wineArch: 'arm64',
            previewEnabled: true,
          });
        }
        cb(null, '', '');
      },
    };

    const bridge = createIpcAndServiceHarness({
      arch: 'arm64',
      platform: 'darwin',
      engineOverrides: {
        probeEnvironmentHealth: vi.fn(async () =>
          environmentHealthProber.probeEnvironmentHealth({
            ...setupOptions,
            skipNetwork: true,
            execFileSyncFn: () => {},
          })
        ),
        runEnvironmentSetupTasks: vi.fn(async (req: any) =>
          environmentProvisioner.runEnvironmentSetupTasks(req, setupOptions)
        ),
        detectCompatibilityLayers: vi.fn(() =>
          macNativeInstaller.detectCompatibilityLayers({
            platform: 'darwin',
            arch: 'arm64',
            homedir: sandbox.homedir,
            applicationsDirs: [sandbox.applicationsDir],
          })
        ),
        checkCompatibilityLayerUpdates: vi.fn(async () => ({})),
        saveGameLaunchConfig: vi.fn((cfg: any) => {
          savedConfigs[cfg.gameId] = cfg;
          return { success: true, config: cfg };
        }),
        getGameLaunchConfigs: vi.fn(() => ({ ...savedConfigs })),
        getSetupWizardState: vi.fn(async () =>
          environmentHealthProber.getSetupWizardState({ userDataDir: sandbox.userDataDir })
        ),
        saveSetupWizardState: vi.fn(async (patch: any) =>
          environmentHealthProber.saveSetupWizardState(patch, { userDataDir: sandbox.userDataDir })
        ),
      },
    });

    try {
      // Step 1: Drive Setup Wizard UI (compatibility -> clients -> summary -> Run) backed by real environmentProvisioner
      await environmentSetupService.probeHealth(['steam'], { forceFresh: true });
      const wizardRenderer = createDomain12DeepRenderer(SystemSetupWizardModal, {
        isOpen: true,
        initialStep: 'compatibility',
        connectedStorefronts: ['steam'],
        onClose: vi.fn(),
      });
      let wizardTree = wizardRenderer.render();
      await flushMicrotasks();
      wizardTree = wizardRenderer.render();

      const armCard = findVNodeByTestId(wizardTree, 'setup-runner-crossover-preview-arm64');
      expect(armCard).toBeDefined();
      armCard.props.onClick?.();
      wizardTree = wizardRenderer.render();

      findVNodeByTestId(wizardTree, 'setup-next-step-btn')?.props?.onClick?.();
      wizardTree = wizardRenderer.render();
      findVNodeByTestId(wizardTree, 'setup-next-step-btn')?.props?.onClick?.();
      wizardTree = wizardRenderer.render();

      const runBtn = findVNodeByTestId(wizardTree, 'run-provisioning-btn');
      expect(runBtn).toBeDefined();
      await runBtn.props.onClick?.();
      await flushMicrotasks();
      wizardRenderer.unmount();

      expect(
        fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app'))
      ).toBe(true);
      expect(
        fs.readFileSync(
          path.join(sandbox.previewBottlesDir, 'OneLauncher-arm64/cxbottle.conf'),
          'utf8'
        )
      ).toContain('"WineArch" = "arm64"');

      // Step 2: Open Launch Config UI, verify crossover_preview_arm64 + OneLauncher-arm64, and save config via IPC
      await launcherService.initialize();
      const cfgRenderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        onClose: vi.fn(),
      });
      let cfgTree = cfgRenderer.render();
      await flushMicrotasks();
      cfgTree = cfgRenderer.render();
      const runnerSelect = findVNodeByTestId(cfgTree, 'compat-runner-select');
      expect(
        findVNodes(runnerSelect, (n) => n.type === 'option').some(
          (o) => o.props?.value === 'crossover_preview_arm64'
        )
      ).toBe(true);
      await launcherService.saveLaunchConfig({
        gameId: game.id,
        launchMethod: 'compatibility_layer',
        compatibilityLayer: asContractLayerType('crossover_preview_arm64'),
        wineBottleName: 'OneLauncher-arm64',
      });
      expect(savedConfigs[game.id]?.compatibilityLayer).toBe('crossover_preview_arm64');
      cfgRenderer.unmount();

      // Step 3: Launch a synthetic x64 game under the provisioned OneLauncher-arm64 FEX bottle
      const gameDir = path.join(sandbox.gamesDir, 'FreshSetupGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const exePath = path.join(gameDir, 'freshgame.exe');
      fs.writeFileSync(exePath, buildSyntheticPeBinary(0x8664));

      const launchRes = await sessionSupervisor.launchGame(
        {
          gameId: game.id,
          platformId: 'custom',
          title: 'FreshSetupGame',
          installPath: gameDir,
          executablePath: exePath,
          launchConfig: savedConfigs[game.id],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox.homedir,
          userDataDir: sandbox.userDataDir,
          applicationsDirs: [sandbox.applicationsDir],
          customApplicationsDir: sandbox.applicationsDir,
          skipBottleProvisioning: true,
          skipRegistrySpawn: true,
          gameSpawnFn: mockSpawnFn,
          spawnFn: mockSpawnFn,
          execFileFn: (_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
            cb(null),
        }
      );

      expect(launchRes.success).toBe(true);
      expect(spawned[0]?.env?.CX_BOTTLE).toBe('OneLauncher-arm64');

      // Step 4: Wineserver lifecycle shutdown via wineserver-arm64
      const armLoader = path.join(
        sandbox.applicationsDir,
        'CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/lib/wine/aarch64-unix/wine'
      );
      const bottleDir = path.join(sandbox.previewBottlesDir, 'OneLauncher-arm64');
      const shutdownBins: string[] = [];
      const stopped = await macNativeInstaller.shutdownWinePrefix(armLoader, bottleDir, 2000, {
        bottleName: 'OneLauncher-arm64',
        execFileFn: (bin: string, _args: string[], _o: unknown, cb: (e: Error | null) => void) => {
          shutdownBins.push(path.basename(bin));
          cb(null);
        },
      });
      expect(stopped).toBe(true);
      expect(shutdownBins).toContain('wineserver-arm64');
    } finally {
      bridge.dispose();
    }
  });

  it('Scenario 2: Dual-branch side-by-side coexistence (Standard CrossOver Preview + Arm64 CrossOver Preview) & per-game switching', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard', shortVersion: '20261111' });
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64', shortVersion: '20261111' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const detected = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });
    expect(detected.map((l: any) => l.type)).toEqual(
      expect.arrayContaining(['crossover_preview', 'crossover_preview_arm64'])
    );

    const gameDir = path.join(sandbox.gamesDir, 'DualBranchTitle');
    fs.mkdirSync(gameDir, { recursive: true });
    const exePath = path.join(gameDir, 'dual.exe');
    fs.writeFileSync(exePath, buildSyntheticPeBinary(0x8664));

    const launchedEnvs: Array<{ cmd: string; bottle?: string }> = [];
    const mockSpawnFn = vi.fn((cmd: string, _args: string[], opts: { env?: Record<string, any> }) => {
      launchedEnvs.push({ cmd, bottle: opts?.env?.CX_BOTTLE });
      const child = new EventEmitter() as any;
      child.pid = 52000 + launchedEnvs.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    });

    const commonOpts = {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      userDataDir: sandbox.userDataDir,
      applicationsDirs: [sandbox.applicationsDir],
      customApplicationsDir: sandbox.applicationsDir,
      skipBottleProvisioning: true,
      skipRegistrySpawn: true,
      gameSpawnFn: mockSpawnFn,
      spawnFn: mockSpawnFn,
      execFileFn: (_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
        cb(null),
    };

    const resStd = await sessionSupervisor.launchGame(
      {
        gameId: 'dual-std',
        platformId: 'custom',
        title: 'DualBranchTitle',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
          wineBottleName: 'OneLauncher',
        },
      },
      commonOpts
    );

    const resArm = await sessionSupervisor.launchGame(
      {
        gameId: 'dual-arm',
        platformId: 'custom',
        title: 'DualBranchTitle',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
        },
      },
      commonOpts
    );

    expect(resStd.success).toBe(true);
    expect(resArm.success).toBe(true);
    expect(launchedEnvs[0]?.bottle).toBe('OneLauncher');
    expect(launchedEnvs[0]?.cmd).toContain('CrossOver Preview.app');
    expect(launchedEnvs[1]?.bottle).toBe('OneLauncher-arm64');
    expect(launchedEnvs[1]?.cmd).toContain('CrossOver Preview arm64.app');
  });

  it('Scenario 3: Existing populated OneLauncher (win64) bottle protection during Arm64 Preview adoption', async () => {
    const intelBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
      sentinelMarkerFile: 'users/crossover/Documents/savegame.sav',
    });
    const armZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(armZip, 'PK\x03\x04ARM', 'utf8');

    const setupRes = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 'scenario3-protect-intel',
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_crossover_preview_arm64',
            runnerType: 'crossover_preview_arm64',
            archivePath: armZip,
          },
          {
            action: 'ensure_bottle',
            componentId: 'bottle_default',
            runnerType: 'crossover_preview_arm64',
            bottleMode: 'create_dedicated',
            bottleName: 'OneLauncher-arm64',
          },
        ],
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        customApplicationsDir: sandbox.applicationsDir,
        applicationsDirs: [sandbox.applicationsDir],
        skipNetwork: true,
        skipProcessCheck: true,
        skipStagingCodesignVerify: true,
        verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
        onExtractArchive: async (_zip: string, dir: string) => {
          seedPreviewAppBundle(dir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
        },
        execFileFn: (
          cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (e: Error | null, out?: string, err?: string) => void
        ) => {
          if (String(cmd).includes('cxbottle')) {
            seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
              wineArch: 'arm64',
              previewEnabled: true,
            });
          }
          cb(null, '', '');
        },
      }
    );

    expect(setupRes.success).toBe(true);
    expect(fs.readFileSync(path.join(intelBottle, 'cxbottle.conf'), 'utf8')).toContain(
      '"WineArch" = "win64"'
    );
    expect(
      fs.existsSync(path.join(intelBottle, 'drive_c/users/crossover/Documents/savegame.sav'))
    ).toBe(true);
    expect(fs.existsSync(path.join(sandbox.previewBottlesDir, 'OneLauncher-arm64'))).toBe(true);

    // Mismatch launch checks:
    // 1) crossover_preview_arm64 paired with OneLauncher (win64) must fail fast without mutating win64 bottle
    // 2) crossover_preview (standard) paired with OneLauncher-arm64 (arm64) must fail fast
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });
    const gameDir = path.join(sandbox.gamesDir, 'MismatchCheckGame');
    fs.mkdirSync(gameDir, { recursive: true });
    const exePath = path.join(gameDir, 'game.exe');
    fs.writeFileSync(exePath, buildSyntheticPeBinary(0x8664));

    const mismatchArmWithWin64 = await sessionSupervisor.launchGame(
      {
        gameId: 'scenario3-mismatch-arm-win64',
        platformId: 'custom',
        title: 'MismatchCheckGame',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        applicationsDirs: [sandbox.applicationsDir],
        customApplicationsDir: sandbox.applicationsDir,
        skipBottleProvisioning: true,
        skipRegistrySpawn: true,
      }
    );
    expect(mismatchArmWithWin64.success).toBe(false);
    expect(String(mismatchArmWithWin64.error || '')).toMatch(
      /arch|winearch|arm64|win64|mismatch|incompatible/i
    );
    expect(fs.readFileSync(path.join(intelBottle, 'cxbottle.conf'), 'utf8')).toContain(
      '"WineArch" = "win64"'
    );

    const mismatchStdWithArm64 = await sessionSupervisor.launchGame(
      {
        gameId: 'scenario3-mismatch-std-arm64',
        platformId: 'custom',
        title: 'MismatchCheckGame',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
          wineBottleName: 'OneLauncher-arm64',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        applicationsDirs: [sandbox.applicationsDir],
        customApplicationsDir: sandbox.applicationsDir,
        skipBottleProvisioning: true,
        skipRegistrySpawn: true,
      }
    );
    expect(mismatchStdWithArm64.success).toBe(false);
    expect(String(mismatchStdWithArm64.error || '')).toMatch(
      /arch|winearch|arm64|win64|mismatch|incompatible/i
    );
  });

  it('Scenario 4: Expired session auth recovery -> re-auth -> update -> cross-service & UI synchronization', async () => {
    let authenticated = false;
    let currentVersion = '20261015';
    const updateCalls: any[] = [];
    const game = makeE2ECanonicalGame();
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
            version: currentVersion,
            availableBottles: ['OneLauncher-arm64'],
          },
        ]),
        checkCompatibilityLayerUpdates: vi.fn(async () => ({
          crossover_preview_arm64: {
            runnerType: 'crossover_preview_arm64',
            installed: true,
            installedVersion: currentVersion,
            latestVersion: authenticated ? '20261111' : undefined,
            updateAvailable: authenticated && currentVersion !== '20261111',
            authRequired: !authenticated,
            downloadUrl: authenticated ? E2E_ARM64_PREVIEW_ZIP_URL : undefined,
            canAutoUpdate: true,
            checkedAt: '2026-11-18T00:00:00.000Z',
          },
        })),
        updateCompatibilityLayer: vi.fn(async (payload: any) => {
          updateCalls.push(payload);
          const runnerType = payload?.runnerType || 'crossover_preview_arm64';
          if (payload.authenticateOnly) {
            authenticated = true;
            bridge?.emitBroadcast('launcher:compat-runner-progress', {
              runnerType,
              operation: 'update',
              phase: 'completed',
              progressPercent: 100,
              message: 'CrossOver Preview session authenticated.',
              updatedAt: new Date().toISOString(),
            });
            return {
              success: true,
              runnerType,
              updated: false,
              authenticated: true,
            };
          }
          currentVersion = '20261111';
          bridge?.emitBroadcast('launcher:compat-runner-progress', {
            runnerType,
            operation: 'update',
            phase: 'completed',
            progressPercent: 100,
            message: 'CrossOver Preview updated to 20261111.',
            updatedAt: new Date().toISOString(),
          });
          return {
            success: true,
            runnerType,
            updated: true,
            previousVersion: '20261015',
            newVersion: '20261111',
          };
        }),
        probeEnvironmentHealth: vi.fn(async () =>
          makeE2ESnapshot({
            components: {
              runner_crossover_preview_arm64: {
                status: !authenticated
                  ? 'ready'
                  : currentVersion === '20261111'
                    ? 'ready'
                    : 'update_available',
                authRequired: !authenticated,
                downloadUrl: authenticated ? E2E_ARM64_PREVIEW_ZIP_URL : undefined,
                version: currentVersion,
                latestVersion: authenticated ? '20261111' : undefined,
              },
            },
          })
        ),
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
      await environmentSetupService.probeHealth(['steam'], { forceFresh: true });

      const renderer = createDomain12DeepRenderer(GameLaunchConfigModal, {
        isOpen: true,
        game,
        onClose: vi.fn(),
      });
      let tree = renderer.render();
      await flushMicrotasks();
      tree = renderer.render();

      // 1) Initially authRequired -> sign-in button shown, downloadUrl absent
      expect(launcherService.getRunnerUpdates()['crossover_preview_arm64']?.downloadUrl).toBeUndefined();
      const signInBtn = findVNodeByTestId(tree, 'sign-in-runner-btn');
      expect(signInBtn).toBeDefined();
      await signInBtn.props.onClick?.();
      await flushMicrotasks();
      tree = renderer.render();

      // 2) After re-auth -> updateAvailable=true, update button shown and enabled
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]?.authenticateOnly).toBe(true);
      expect(launcherService.getRunnerUpdates()['crossover_preview_arm64']?.updateAvailable).toBe(true);
      const updateBtn = findVNodeByTestId(tree, 'update-runner-btn');
      expect(updateBtn).toBeDefined();
      expect(updateBtn?.props?.disabled).toBeFalsy();
      await updateBtn.props.onClick?.();
      await flushMicrotasks();
      tree = renderer.render();

      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[1]?.authenticateOnly).toBeFalsy();

      // 3) After update -> both services synchronized at 20261111
      expect(launcherService.getCompatibilityLayers()[0]?.version).toBe('20261111');
      expect(
        (environmentSetupService.getLastSnapshot()?.components as Record<string, any>)
          ?.runner_crossover_preview_arm64?.status
      ).toBe('ready');

      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('Scenario 5: x86_64 Intel Mac host boundary journey hides/gates Arm64 Preview while Standard Preview remains fully usable', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });

    const intelSnap = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'x64',
      homedir: sandbox.homedir,
      userDataDir: sandbox.userDataDir,
      customApplicationsDir: sandbox.applicationsDir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml: `<a href="${E2E_STANDARD_PREVIEW_ZIP_URL}">Std</a><a href="${E2E_ARM64_PREVIEW_ZIP_URL}">Arm64</a>`,
      execFileSyncFn: () => {},
    });

    expect(intelSnap.isAppleSiliconMac).toBe(false);
    expect(intelSnap.components.runner_crossover_preview_arm64?.status).toBe('not_applicable');
    expect(intelSnap.components.runner_crossover_preview?.status).toBe('update_available');
    expect(intelSnap.components.runner_crossover_preview?.downloadUrl).toBe(
      E2E_STANDARD_PREVIEW_ZIP_URL
    );

    const bridge = createIpcAndServiceHarness({
      arch: 'x64',
      platform: 'darwin',
      engineOverrides: {
        probeEnvironmentHealth: vi.fn(async () => intelSnap),
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

      expect(findVNodeByTestId(tree, 'setup-runner-crossover-preview')).toBeDefined();
      expect(findVNodeByTestId(tree, 'setup-runner-crossover-preview-arm64')).toBeUndefined();
      renderer.unmount();
    } finally {
      bridge.dispose();
    }
  });

  it('Scenario 6: Multi-machine portability simulation across /Users/portable_alpha and /Users/portable_beta produces zero PII or path leaks', async () => {
    const homes = ['portable_alpha', 'portable_beta'].map((label) => {
      const root = path.join(sandbox.tmpRoot, label);
      const appsDir = path.join(root, 'Applications');
      const userDataDir = path.join(root, 'userData');
      const bottlesDir = path.join(root, 'Library/Application Support/CrossOver Preview/Bottles');
      fs.mkdirSync(appsDir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(bottlesDir, { recursive: true });
      return { label, root, appsDir, userDataDir, bottlesDir };
    });

    for (const h of homes) {
      const otherLabel = h.label === 'portable_alpha' ? 'portable_beta' : 'portable_alpha';
      seedPreviewAppBundle(h.appsDir, { branch: 'arm64' });
      seedBottle(h.bottlesDir, 'OneLauncher-arm64', { wineArch: 'arm64', previewEnabled: true });

      const probedSnap = await environmentHealthProber.probeEnvironmentHealth({
        platform: 'darwin',
        arch: 'arm64',
        homedir: h.root,
        userDataDir: h.userDataDir,
        customApplicationsDir: h.appsDir,
        applicationsDirs: [h.appsDir],
        skipNetwork: true,
        execFileSyncFn: () => {},
      });

      expect(
        probedSnap.detectedRunners.some((r: any) => r.type === 'crossover_preview_arm64')
      ).toBe(true);
      expect(
        probedSnap.bottleSummary.availableBottles.some(
          (b: any) => b.name === 'OneLauncher-arm64' && b.wineArch === 'arm64'
        )
      ).toBe(true);

      const savedConfigs: Record<string, any> = {};
      const bridge = createIpcAndServiceHarness({
        arch: 'arm64',
        platform: 'darwin',
        engineOverrides: {
          saveSetupWizardState: vi.fn((patch: any) =>
            environmentHealthProber.saveSetupWizardState(patch, { userDataDir: h.userDataDir })
          ),
          saveGameLaunchConfig: vi.fn((cfg: any) => {
            savedConfigs[cfg.gameId] = cfg;
            fs.writeFileSync(
              path.join(h.userDataDir, 'launch-configs.json'),
              JSON.stringify(savedConfigs, null, 2),
              'utf8'
            );
            return { success: true, config: cfg };
          }),
          getGameLaunchConfigs: vi.fn(() => ({ ...savedConfigs })),
        },
      });

      try {
        const persistedWizard = await bridge.invokeChannel('launcher:save-setup-wizard-state', {
          completedAt: '2026-11-18T00:00:00.000Z',
          preferredRunnerType: 'crossover_preview_arm64',
          preferredBottleName: 'OneLauncher-arm64',
          configuredComponents: ['runner_crossover_preview_arm64', 'bottle_default'],
        });
        expect(persistedWizard.success).toBe(true);
        expect(persistedWizard.state.preferredRunnerType).toBe('crossover_preview_arm64');
        expect(persistedWizard.state.preferredBottleName).toBe('OneLauncher-arm64');

        await bridge.invokeChannel('launcher:save-launch-config', {
          gameId: `portable-game-${h.label}`,
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
        });
        const persistedCfg = await bridge.invokeChannel(
          'launcher:get-launch-config',
          `portable-game-${h.label}`
        );
        expect(persistedCfg?.compatibilityLayer).toBe('crossover_preview_arm64');
        expect(persistedCfg?.wineBottleName).toBe('OneLauncher-arm64');
      } finally {
        bridge.dispose();
      }

      const stateText = fs.readFileSync(path.join(h.userDataDir, 'setup-wizard-state.json'), 'utf8');
      const launchCfgText = fs.readFileSync(path.join(h.userDataDir, 'launch-configs.json'), 'utf8');
      const confText = fs.readFileSync(
        path.join(h.bottlesDir, 'OneLauncher-arm64/cxbottle.conf'),
        'utf8'
      );
      const diagSample = diagnosticLogger.redactSensitiveDiagnosticText(
        `Setup complete for /Users/${h.label}/Library/Application Support/CrossOver Preview/Bottles/OneLauncher-arm64`
      );

      expect(scanContentForPiiViolations(stateText, 'setup-wizard-state.json')).toEqual([]);
      expect(scanContentForPiiViolations(launchCfgText, 'launch-configs.json')).toEqual([]);
      expect(scanContentForPiiViolations(confText, 'cxbottle.conf')).toEqual([]);
      expect(JSON.stringify(probedSnap)).not.toContain(otherLabel);
      expect(stateText).not.toContain(otherLabel);
      expect(launchCfgText).not.toContain(otherLabel);
      expect(diagSample).not.toContain(h.label);
      expect(diagSample).toContain('/Users/[REDACTED]/');
    }
  });
});
