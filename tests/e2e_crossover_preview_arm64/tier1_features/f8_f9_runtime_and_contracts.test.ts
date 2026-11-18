import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  E2ESandbox,
  asContractLayerType,
  buildSyntheticPeBinary,
  createIsolatedE2ESandbox,
  createIpcAndServiceHarness,
  environmentHealthProber,
  macNativeInstaller,
  makeE2ESnapshot,
  seedBottle,
  seedPreviewAppBundle,
  sessionSupervisor,
  wineAndCrossOverManager,
} from '../harness';
import { launcherService } from '../../../src/services/launcher/launcherService';
import { environmentSetupService } from '../../../src/services/launcher/environmentSetupService';

describe('Tier 1 — F8 & F9: Arm64 FEX Runtime, IPC Allowlists & Cross-Service Synchronization', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t1-f8f9-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F8: Arm64 FEX Runtime, Wineserver, Loader, PE & Graphics Backend (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F8.1: resolveWineserverBinary and shutdownWinePrefix support wineserver-arm64 and wineserver-x86', async () => {
    const armBundle = seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const stdBundle = seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });

    const armLoader = path.join(armBundle.cxRoot, 'lib/wine/aarch64-unix/wine');
    const resolvedArmServer = macNativeInstaller.resolveWineserverBinary(armLoader);
    expect(resolvedArmServer).toBeTruthy();
    expect(path.basename(resolvedArmServer)).toBe('wineserver-arm64');

    const stdLoader = path.join(stdBundle.cxRoot, 'lib/wine/x86_64-unix/wine');
    const resolvedStdServer = macNativeInstaller.resolveWineserverBinary(stdLoader);
    expect(resolvedStdServer).toBeTruthy();

    const executed: Array<{ bin: string; args: string[] }> = [];
    const bottleDir = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const stopped = await macNativeInstaller.shutdownWinePrefix(armLoader, bottleDir, 2000, {
      bottleName: 'OneLauncher-arm64',
      execFileFn: (
        bin: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void
      ) => {
        executed.push({ bin, args: args.map(String) });
        cb(null);
      },
    });

    expect(stopped).toBe(true);
    expect(
      executed.some((e) => path.basename(e.bin) === 'wineserver-arm64' && e.args.includes('-k'))
    ).toBe(true);
  });

  it('F8.2: deriveCrossOverRootPath and prepareXboxBottleEnvironment recognize crossover_preview_arm64 and aarch64-windows', async () => {
    const armBundle = seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const bottleDir = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const derivedRoot = wineAndCrossOverManager.deriveCrossOverRootPath({
      compatLayer: {
        type: 'crossover_preview_arm64',
        appPath: armBundle.appPath,
        binaryPath: armBundle.wineBinary,
      },
      customApplicationsDir: sandbox.applicationsDir,
      homedir: sandbox.homedir,
    });

    expect(derivedRoot).toBe(armBundle.cxRoot);

    const prepEnv: Record<string, string> = {};
    const prep = await wineAndCrossOverManager.prepareXboxBottleEnvironment({
      compatLayer: {
        type: 'crossover_preview_arm64',
        appPath: armBundle.appPath,
        binaryPath: armBundle.wineBinary,
      },
      bottlePath: bottleDir,
      winePrefix: bottleDir,
      env: prepEnv,
      skipRegistrySpawn: true,
      customApplicationsDir: sandbox.applicationsDir,
      homedir: sandbox.homedir,
    });

    expect(prep).toBeDefined();
    expect(prepEnv.WINEDLLOVERRIDES).toBeTruthy();
    expect(fs.existsSync(path.join(armBundle.cxRoot, 'lib/wine/aarch64-windows/kernel32.dll'))).toBe(
      true
    );
  });

  it('F8.3: launchGame allows ARM64 PE (0xaa64) executable when targeting OneLauncher-arm64 on crossover_preview_arm64', async () => {
    const armBundle = seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const gameDir = path.join(sandbox.gamesDir, 'Arm64Title');
    fs.mkdirSync(gameDir, { recursive: true });
    const armExe = path.join(gameDir, 'arm64game.exe');
    fs.writeFileSync(armExe, buildSyntheticPeBinary(0xaa64));

    const spawned: Array<{ cmd: string; env: Record<string, any> }> = [];
    const mockSpawnFn = vi.fn((cmd: string, _args: string[], opts: { env?: Record<string, any> }) => {
      spawned.push({ cmd, env: opts?.env || {} });
      const child = new EventEmitter() as any;
      child.pid = 42420;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    });

    const launchRes = await sessionSupervisor.launchGame(
      {
        gameId: 'e2e-arm64-pe-game',
        platformId: 'custom',
        title: 'Arm64Title',
        installPath: gameDir,
        executablePath: armExe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
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
        gameSpawnFn: mockSpawnFn,
        spawnFn: mockSpawnFn,
        execFileFn: (_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
          cb(null),
      }
    );

    expect(launchRes.success).toBe(true);
    expect(spawned.length).toBeGreaterThanOrEqual(1);
    expect(spawned[0].env.CX_BOTTLE).toBe('OneLauncher-arm64');
    expect(spawned[0].env.WINEPREFIX).toContain('OneLauncher-arm64');
    expect(spawned[0].cmd).toContain(path.basename(armBundle.appPath));
  });

  it('F8.4: resolveEffectiveCrossOverGraphicsBackend supports crossover_preview_arm64 with d3dmetal / dxmt / dxvk', () => {
    const armBundle = seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      withD3dMetal: true,
      withDxmt32: true,
      withDxvk32: true,
    });
    const bottleDir = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const dxmtRes = macNativeInstaller.resolveEffectiveCrossOverGraphicsBackend({
      compatLayer: {
        type: 'crossover_preview_arm64',
        appPath: armBundle.appPath,
        binaryPath: armBundle.wineBinary,
      },
      cxRoot: armBundle.cxRoot,
      bottlePath: bottleDir,
      requestedBackend: 'dxmt',
      hostArch: 'arm64',
    });

    const d3dRes = macNativeInstaller.resolveEffectiveCrossOverGraphicsBackend({
      compatLayer: {
        type: 'crossover_preview_arm64',
        appPath: armBundle.appPath,
        binaryPath: armBundle.wineBinary,
      },
      cxRoot: armBundle.cxRoot,
      bottlePath: bottleDir,
      requestedBackend: 'd3dmetal',
      hostArch: 'arm64',
    });

    expect(dxmtRes.backend).toBe('dxmt');
    expect(d3dRes.backend).toBe('d3dmetal');
  });

  it('F8.5: launchGame supports x64 Windows PE (0x8664) inside OneLauncher-arm64 FEX bottle on Apple Silicon', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const gameDir = path.join(sandbox.gamesDir, 'X64UnderFexTitle');
    fs.mkdirSync(gameDir, { recursive: true });
    const x64Exe = path.join(gameDir, 'game64.exe');
    fs.writeFileSync(x64Exe, buildSyntheticPeBinary(0x8664));

    const mockSpawnFn = vi.fn((_cmd: string) => {
      const child = new EventEmitter() as any;
      child.pid = 42421;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    });

    const launchRes = await sessionSupervisor.launchGame(
      {
        gameId: 'e2e-x64-fex-game',
        platformId: 'custom',
        title: 'X64UnderFexTitle',
        installPath: gameDir,
        executablePath: x64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
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
        gameSpawnFn: mockSpawnFn,
        spawnFn: mockSpawnFn,
        execFileFn: (_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
          cb(null),
      }
    );

    expect(launchRes.success).toBe(true);
    expect(mockSpawnFn).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // F9: Contracts, IPC Allowlists & Cross-Service State Sync (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F9.1: IPC launcher:install-compat-layer and launcher:update-compat-layer accept crossover_preview_arm64', async () => {
    const receivedInstall: any[] = [];
    const receivedUpdate: any[] = [];

    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        installCompatibilityLayer: vi.fn(async (payload: any) => {
          receivedInstall.push(payload);
          return { success: true, runnerType: payload.runnerType, installedPath: '/tmp/arm64.app' };
        }),
        updateCompatibilityLayer: vi.fn(async (payload: any) => {
          receivedUpdate.push(payload);
          return { success: true, runnerType: payload.runnerType, updated: true };
        }),
      },
    });

    try {
      const installRes = await bridge.invokeChannel('launcher:install-compat-layer', {
        runnerType: 'crossover_preview_arm64',
        mode: 'direct',
      });
      const updateRes = await bridge.invokeChannel('launcher:update-compat-layer', {
        runnerType: 'crossover_preview_arm64',
        authenticateOnly: true,
      });

      expect(installRes.success).toBe(true);
      expect(receivedInstall[0]?.runnerType).toBe('crossover_preview_arm64');
      expect(updateRes.success).toBe(true);
      expect(receivedUpdate[0]?.runnerType).toBe('crossover_preview_arm64');
      expect(receivedUpdate[0]?.authenticateOnly).toBe(true);
    } finally {
      bridge.dispose();
    }
  });

  it('F9.2: IPC launcher:run-environment-setup-tasks accepts runner_crossover_preview_arm64 and bottleName OneLauncher-arm64', async () => {
    const receivedPayloads: any[] = [];
    const readySnapshot = makeE2ESnapshot({
      runnerType: 'crossover_preview_arm64',
      recommendedBottleName: 'OneLauncher-arm64',
    });

    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        runEnvironmentSetupTasks: vi.fn(async (payload: any) => {
          receivedPayloads.push(payload);
          return {
            success: true,
            runId: payload.runId || 'run-arm64',
            outcomes: payload.tasks.map((t: any) => ({
              componentId: t.componentId,
              action: t.action,
              status: 'completed',
              message: 'ok',
            })),
            snapshot: readySnapshot,
          };
        }),
      },
    });

    try {
      const res = await bridge.invokeChannel('launcher:run-environment-setup-tasks', {
        runId: 'ipc-arm64-setup',
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_crossover_preview_arm64',
            runnerType: 'crossover_preview_arm64',
          },
          {
            action: 'ensure_bottle',
            componentId: 'bottle_default',
            runnerType: 'crossover_preview_arm64',
            bottleMode: 'create_dedicated',
            bottleName: 'OneLauncher-arm64',
          },
        ],
      });

      expect(res.success).toBe(true);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].tasks[0].componentId).toBe('runner_crossover_preview_arm64');
      expect(receivedPayloads[0].tasks[1].bottleName).toBe('OneLauncher-arm64');
    } finally {
      bridge.dispose();
    }
  });

  it('F9.3: IPC launcher:save-setup-wizard-state persists preferredRunnerType crossover_preview_arm64 and preferredBottleName OneLauncher-arm64', async () => {
    const savedPatches: any[] = [];
    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        saveSetupWizardState: vi.fn((patch: any) => {
          savedPatches.push(patch);
          return {
            schemaVersion: 1,
            completedAt: patch.completedAt ?? null,
            dismissedAt: null,
            lastHealthCheckAt: null,
            preferredRunnerType: patch.preferredRunnerType,
            preferredBottleName: patch.preferredBottleName,
            configuredComponents: patch.configuredComponents ?? [],
          };
        }),
      },
    });

    try {
      const state = await bridge.invokeChannel('launcher:save-setup-wizard-state', {
        completedAt: '2026-11-18T00:00:00.000Z',
        preferredRunnerType: 'crossover_preview_arm64',
        preferredBottleName: 'OneLauncher-arm64',
        configuredComponents: ['runner_crossover_preview_arm64', 'bottle_default'],
      });

      expect(savedPatches[0]?.preferredRunnerType).toBe('crossover_preview_arm64');
      expect(savedPatches[0]?.preferredBottleName).toBe('OneLauncher-arm64');
      expect(state.preferredRunnerType).toBe('crossover_preview_arm64');
      expect(state.preferredBottleName).toBe('OneLauncher-arm64');
    } finally {
      bridge.dispose();
    }
  });

  it('F9.4: IPC launcher:save-launch-config and launcher:launch-game preserve compatibilityLayer crossover_preview_arm64 and wineBottleName OneLauncher-arm64', async () => {
    const launchPayloads: any[] = [];
    const savedConfigs: Record<string, any> = {};

    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        saveGameLaunchConfig: vi.fn((config: any) => {
          savedConfigs[config.gameId] = config;
          return { success: true, config };
        }),
        getGameLaunchConfigs: vi.fn(() => ({ ...savedConfigs })),
        launchGame: vi.fn(async (payload: any) => {
          launchPayloads.push(payload);
          return { success: true, sessionId: 'sess-arm64' };
        }),
      },
    });

    try {
      await bridge.invokeChannel('launcher:save-launch-config', {
        gameId: 'e2e-arm64-cfg-game',
        launchMethod: 'compatibility_layer',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottleName: 'OneLauncher-arm64',
      });

      const persisted = await bridge.invokeChannel('launcher:get-launch-config', 'e2e-arm64-cfg-game');
      expect(persisted).toBeDefined();
      expect(persisted.compatibilityLayer).toBe('crossover_preview_arm64');
      expect(persisted.wineBottleName).toBe('OneLauncher-arm64');

      const launchRes = await bridge.invokeChannel('launcher:launch-game', {
        gameId: 'e2e-arm64-cfg-game',
        platformId: 'custom',
        title: 'Arm64 Config Game',
        launchConfig: persisted,
      });

      expect(launchRes.success).toBe(true);
      expect(launchPayloads[0]?.launchConfig?.compatibilityLayer).toBe('crossover_preview_arm64');
      expect(launchPayloads[0]?.launchConfig?.wineBottleName).toBe('OneLauncher-arm64');
    } finally {
      bridge.dispose();
    }
  });

  it('F9.5: LauncherService <-> EnvironmentSetupService synchronize runnerUpdates, detectedRunners, and lastSnapshot after install/update/auth', async () => {
    let installedArm64 = false;
    let authRequired = true;

    const makeCurrentLayers = () =>
      installedArm64
        ? [
            {
              id: 'crossover_preview_arm64',
              type: 'crossover_preview_arm64',
              name: 'CrossOver Preview (arm64 / FEX)',
              binaryPath: '/tmp/CrossOver Preview arm64.app/Contents/SharedSupport/CrossOver/bin/wine',
              appPath: '/tmp/CrossOver Preview arm64.app',
              version: '20261111',
              previewBranch: 'arm64',
              availableBottles: ['OneLauncher-arm64'],
            },
          ]
        : [];

    const makeCurrentUpdates = () => ({
      crossover_preview_arm64: {
        runnerType: 'crossover_preview_arm64',
        installed: installedArm64,
        updateAvailable: installedArm64 && !authRequired ? false : !authRequired,
        authRequired,
        downloadUrl: authRequired ? undefined : 'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip',
        canAutoUpdate: true,
        checkedAt: '2026-11-18T00:00:00.000Z',
        previewBranch: 'arm64',
      },
    });

    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        detectCompatibilityLayers: vi.fn(() => makeCurrentLayers()),
        checkCompatibilityLayerUpdates: vi.fn(async () => makeCurrentUpdates()),
        installCompatibilityLayer: vi.fn(async () => {
          installedArm64 = true;
          authRequired = false;
          environmentHealthProber.invalidateProberRunnerUpdatesCache();
          return { success: true, runnerType: 'crossover_preview_arm64', installedPath: '/tmp/arm64.app' };
        }),
        probeEnvironmentHealth: vi.fn(async () =>
          makeE2ESnapshot({
            detectedRunners: makeCurrentLayers() as any,
            components: {
              runner_crossover_preview_arm64: {
                status: installedArm64 ? 'ready' : 'missing',
                authRequired,
              },
            },
          })
        ),
      },
    });

    try {
      await environmentSetupService.probeHealth(['steam'], { forceFresh: true });
      expect(
        environmentSetupService.getLastSnapshot()?.components?.[
          'runner_crossover_preview_arm64' as keyof NonNullable<
            ReturnType<typeof environmentSetupService.getLastSnapshot>
          >['components']
        ]?.status
      ).toBe('missing');

      await launcherService.installCompatibilityLayer(
        asContractLayerType('crossover_preview_arm64'),
        'direct'
      );

      const syncedSnapshot = environmentSetupService.getLastSnapshot();
      const syncedUpdates = launcherService.getRunnerUpdates();
      expect(syncedUpdates['crossover_preview_arm64']?.installed).toBe(true);
      expect(
        syncedSnapshot?.components?.[
          'runner_crossover_preview_arm64' as keyof NonNullable<typeof syncedSnapshot>['components']
        ]?.status
      ).toBe('ready');
    } finally {
      bridge.dispose();
    }
  });
});
