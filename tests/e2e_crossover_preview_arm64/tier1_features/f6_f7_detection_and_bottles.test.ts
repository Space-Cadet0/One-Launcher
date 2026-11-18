import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  E2ESandbox,
  chainedPublisherLaunchers,
  createIsolatedE2ESandbox,
  environmentHealthProber,
  environmentProvisioner,
  macNativeInstaller,
  seedBottle,
  seedPreviewAppBundle,
} from '../harness';

describe('Tier 1 — F6 & F7: Branch-Aware Runner Detection & Dedicated Arm64 Bottle Architecture', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t1-f6f7-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F6: Branch-Aware Runner Detection & Bundle Capability Probing (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F6.1: detectCompatibilityLayers detects both CrossOver Preview.app and CrossOver Preview arm64.app with identical Info.plist', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261111',
      bundleVersion: '27.0.0.41303',
    });
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261111',
      bundleVersion: '27.0.0.41303',
    });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    const stdLayer = layers.find((l: any) => l.type === 'crossover_preview');
    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');

    expect(stdLayer).toBeDefined();
    expect(armLayer).toBeDefined();
    expect(stdLayer.appPath).toContain('CrossOver Preview.app');
    expect(armLayer.appPath).toContain('CrossOver Preview arm64.app');
  });

  it('F6.2: detectCompatibilityLayers differentiates Standard vs Arm64 via internal markers and exposes previewBranch & supportedBottleArches', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      buildTimestamp: '20261111T000000Z',
    });
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      buildTimestamp: '20261111T010000Z',
    });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    const stdLayer = layers.find((l: any) => l.type === 'crossover_preview');
    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');

    expect(stdLayer).toBeDefined();
    expect(armLayer).toBeDefined();
    expect(stdLayer.previewBranch).toBe('standard');
    expect(stdLayer.supportedBottleArches).toContain('win64');
    expect(armLayer.previewBranch).toBe('arm64');
    expect(armLayer.supportedBottleArches).toContain('arm64');
  });

  it('F6.3: detectCompatibilityLayers surfaces bottleDetails (wineArch, previewEnabled) for Intel and Arm64 bottles', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');
    expect(armLayer).toBeDefined();
    expect(armLayer.bottleDetails).toBeDefined();
    expect(armLayer.bottleDetails['OneLauncher']?.wineArch).toBe('win64');
    expect(armLayer.bottleDetails['OneLauncher-arm64']?.wineArch).toBe('arm64');
    expect(armLayer.bottleDetails['OneLauncher-arm64']?.previewEnabled).toBe(true);
  });

  it('F6.4: detectCompatibilityLayers has zero fs.rmSync destructive side effects on uninitialized bottle folders even without readOnly: true', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });
    const partialBottleDir = path.join(sandbox.previewBottlesDir, 'OneLauncher');
    fs.mkdirSync(partialBottleDir, { recursive: true });
    const markerFile = path.join(partialBottleDir, 'keep-user-data.txt');
    fs.writeFileSync(markerFile, 'user-created', 'utf8');

    macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      // intentionally omit readOnly
    });

    expect(fs.existsSync(partialBottleDir)).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it('F6.5: probeEnvironmentHealth exposes runner_crossover_preview_arm64 and bottle wineArch metadata', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const snapshot = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      userDataDir: sandbox.userDataDir,
      customApplicationsDir: sandbox.applicationsDir,
      applicationsDirs: [sandbox.applicationsDir],
      skipNetwork: true,
      execFileSyncFn: () => {},
    });

    expect(snapshot.components.runner_crossover_preview_arm64).toBeDefined();
    expect(snapshot.components.runner_crossover_preview_arm64.status).toBe('ready');
    const armBottle = snapshot.bottleSummary.availableBottles.find(
      (b: any) => b.name === 'OneLauncher-arm64'
    );
    expect(armBottle).toBeDefined();
    expect(armBottle.wineArch).toBe('arm64');
  });

  // --------------------------------------------------------------------------
  // F7: Dedicated OneLauncher-arm64 Bottle Provisioning & Isolation (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F7.1: resolveDefaultChainedBottleName returns OneLauncher-arm64 for crossover_preview_arm64 and OneLauncher for standard', () => {
    const armBottle = chainedPublisherLaunchers.resolveDefaultChainedBottleName({
      runnerType: 'crossover_preview_arm64',
      layerType: 'crossover_preview_arm64',
    });
    const stdBottle = chainedPublisherLaunchers.resolveDefaultChainedBottleName({
      runnerType: 'crossover_preview',
      layerType: 'crossover_preview',
    });

    expect(armBottle).toBe('OneLauncher-arm64');
    expect(stdBottle).toBe('OneLauncher');
  });

  it('F7.2: runEnvironmentSetupTasks(ensure_bottle) provisions OneLauncher-arm64 with --winearch arm64 and Preview = 1', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const cxbottleCalls: string[][] = [];

    const res = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 'e2e-f7-provision-arm64',
        tasks: [
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
        execFileFn: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (String(cmd).includes('cxbottle')) {
            cxbottleCalls.push(args.map(String));
            seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
              wineArch: 'arm64',
              previewEnabled: true,
            });
          }
          cb(null, '', '');
        },
      }
    );

    expect(res.success).toBe(true);
    expect(cxbottleCalls.length).toBeGreaterThanOrEqual(1);
    const argsStr = cxbottleCalls[0].join(' ');
    expect(argsStr).toContain('--bottle OneLauncher-arm64');
    expect(argsStr).toContain('--create');
    expect(argsStr).toContain('--winearch arm64');

    const confText = fs.readFileSync(
      path.join(sandbox.previewBottlesDir, 'OneLauncher-arm64/cxbottle.conf'),
      'utf8'
    );
    expect(confText).toContain('"WineArch" = "arm64"');
    expect(confText).toContain('"Preview" = "1"');
  });

  it('F7.3: ensureCompatibilityLayerReady enforces Preview = 1 in cxbottle.conf for both crossover_preview and crossover_preview_arm64', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });

    const stdBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: false,
    });
    const armBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: false,
    });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });
    const stdLayer = layers.find((l: any) => l.type === 'crossover_preview');
    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');

    await macNativeInstaller.ensureCompatibilityLayerReady(
      stdLayer,
      { compatibilityLayer: 'crossover_preview', wineBottleName: 'OneLauncher' },
      {},
      { homedir: sandbox.homedir, skipRegistrySpawn: true }
    );
    await macNativeInstaller.ensureCompatibilityLayerReady(
      armLayer,
      { compatibilityLayer: 'crossover_preview_arm64', wineBottleName: 'OneLauncher-arm64' },
      {},
      { homedir: sandbox.homedir, skipRegistrySpawn: true }
    );

    expect(fs.readFileSync(path.join(stdBottle, 'cxbottle.conf'), 'utf8')).toContain(
      '"Preview" = "1"'
    );
    expect(fs.readFileSync(path.join(armBottle, 'cxbottle.conf'), 'utf8')).toContain(
      '"Preview" = "1"'
    );
  });

  it('F7.4: provisioning OneLauncher-arm64 keeps existing Intel OneLauncher (win64) bottle intact and untouched', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const intelBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
      sentinelMarkerFile: 'users/crossover/intel-save.dat',
    });

    const res = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 'e2e-f7-keep-intel',
        tasks: [
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
        execFileFn: (
          cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
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

    expect(res.success).toBe(true);
    const armConfPath = path.join(sandbox.previewBottlesDir, 'OneLauncher-arm64/cxbottle.conf');
    expect(fs.existsSync(armConfPath)).toBe(true);
    expect(fs.readFileSync(armConfPath, 'utf8')).toContain('"WineArch" = "arm64"');
    expect(fs.readFileSync(path.join(intelBottle, 'cxbottle.conf'), 'utf8')).toContain(
      '"WineArch" = "win64"'
    );
    expect(
      fs.existsSync(path.join(intelBottle, 'drive_c/users/crossover/intel-save.dat'))
    ).toBe(true);
  });

  it('F7.5: ensureCompatibilityLayerReady defaults to OneLauncher-arm64 when runner is crossover_preview_arm64 and no bottle specified', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });
    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');
    const env: Record<string, string> = {};

    const ready = await macNativeInstaller.ensureCompatibilityLayerReady(
      armLayer,
      { compatibilityLayer: 'crossover_preview_arm64' },
      env,
      { homedir: sandbox.homedir, skipRegistrySpawn: true }
    );

    expect(ready.targetBottle).toBe('OneLauncher-arm64');
    expect(env.CX_BOTTLE).toBe('OneLauncher-arm64');
    expect(env.WINEPREFIX).toContain('OneLauncher-arm64');
  });
});
