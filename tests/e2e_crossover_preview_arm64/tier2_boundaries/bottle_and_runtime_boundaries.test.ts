import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  E2ESandbox,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_STANDARD_PREVIEW_ZIP_URL,
  buildSyntheticPeBinary,
  createIsolatedE2ESandbox,
  createIpcAndServiceHarness,
  environmentProvisioner,
  macNativeInstaller,
  seedBottle,
  seedPreviewAppBundle,
  sessionSupervisor,
} from '../harness';

describe('Tier 2 — F6–F9 Boundaries: Detection, Bottle Isolation, FEX Runtime & IPC Security', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t2-runtime-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F6 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F6.B1: corrupted Info.plist in a bundle does not crash detectCompatibilityLayers', () => {
    const brokenApp = path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app');
    fs.mkdirSync(path.join(brokenApp, 'Contents/SharedSupport/CrossOver/bin'), { recursive: true });
    fs.writeFileSync(
      path.join(brokenApp, 'Contents/SharedSupport/CrossOver/bin/wine'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(brokenApp, 'Contents/Info.plist'), '<<<NOT-XML>>>', 'utf8');

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    expect(Array.isArray(layers)).toBe(true);
  });

  it('F6.B2: Standard bundle lacking aarch64-unix/ntdll.so is never misclassified as crossover_preview_arm64', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    expect(layers.some((l: any) => l.type === 'crossover_preview')).toBe(true);
    expect(layers.some((l: any) => l.type === 'crossover_preview_arm64')).toBe(false);
  });

  it('F6.B3: empty applicationsDir returns empty runner list without touching host /Applications', () => {
    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    const crossoverFamily = layers.filter((l: any) => String(l.type).startsWith('crossover'));
    expect(crossoverFamily).toEqual([]);
  });

  it('F6.B4: detectCompatibilityLayers handles non-existent Bottles dir gracefully without fs.rmSync', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    fs.rmSync(sandbox.previewBottlesDir, { recursive: true, force: true });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');
    expect(armLayer).toBeDefined();
    expect(armLayer.availableBottles).toEqual([]);
  });

  it('F6.B5: malformed cxbottle.conf in a bottle folder does not crash bottleDetails probing', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const weirdBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    fs.writeFileSync(path.join(weirdBottle, 'cxbottle.conf'), '\0\0invalid==conf', 'utf8');

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });

    expect(layers.find((l: any) => l.type === 'crossover_preview_arm64')).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // F7 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F7.B1: ensureCompatibilityLayerReady never converts an existing win64 OneLauncher bottle to arm64 in place', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const intelBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
      sentinelMarkerFile: 'users/crossover/save.bin',
    });

    const layers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });
    const armLayer = layers.find((l: any) => l.type === 'crossover_preview_arm64');
    expect(armLayer).toBeDefined();

    const result = await macNativeInstaller
      .ensureCompatibilityLayerReady(
        armLayer,
        { compatibilityLayer: 'crossover_preview_arm64', wineBottleName: 'OneLauncher' },
        {},
        { homedir: sandbox.homedir, skipRegistrySpawn: true }
      )
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

    // Must either reject mismatch or refuse conversion; win64 bottle MUST stay win64!
    expect(fs.readFileSync(path.join(intelBottle, 'cxbottle.conf'), 'utf8')).toContain(
      '"WineArch" = "win64"'
    );
    expect(fs.existsSync(path.join(intelBottle, 'drive_c/users/crossover/save.bin'))).toBe(true);
    expect(result.error || result.targetBottle !== 'OneLauncher' || result.compatible === false).toBeTruthy();
  });

  it('F7.B2: pairing an arm64 bottle with standard crossover or crossover_preview fails fast with architecture mismatch', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });
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
    const stdLayer = layers.find((l: any) => l.type === 'crossover_preview');

    const res = await macNativeInstaller
      .ensureCompatibilityLayerReady(
        stdLayer,
        { compatibilityLayer: 'crossover_preview', wineBottleName: 'OneLauncher-arm64' },
        {},
        { homedir: sandbox.homedir, skipRegistrySpawn: true }
      )
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

    expect(res.error || res.success === false).toBeTruthy();
  });

  it('F7.B3: applyCrossOverPerGameSettings preserves WineArch = arm64 when enforcing Preview = 1', () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const armBottle = seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: false,
    });

    macNativeInstaller.applyCrossOverPerGameSettings(
      {
        type: 'crossover_preview_arm64',
        appPath: path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app'),
      },
      { compatibilityLayer: 'crossover_preview_arm64', wineBottleName: 'OneLauncher-arm64' },
      {},
      armBottle,
      { homedir: sandbox.homedir, skipRegistrySpawn: true }
    );

    const conf = fs.readFileSync(path.join(armBottle, 'cxbottle.conf'), 'utf8');
    expect(conf).toContain('"WineArch" = "arm64"');
    expect(conf).toContain('"Preview" = "1"');
  });

  it('F7.B4: path traversal bottle names (../escape) are rejected before touching filesystem', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const res = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 't2-f7-bad-slug',
        tasks: [
          {
            action: 'ensure_bottle',
            componentId: 'bottle_default',
            runnerType: 'crossover_preview_arm64',
            bottleMode: 'create_dedicated',
            bottleName: '../escape',
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
      }
    );

    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(sandbox.previewBottlesDir, '../escape'))).toBe(false);
  });

  it('F7.B5: x86_64 host refuses provisioning crossover_preview_arm64', async () => {
    const res = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 't2-f7-x64-reject',
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

    expect(res.success).toBe(false);
    expect(res.outcomes[0]?.status).toBe('failed');
  });

  // --------------------------------------------------------------------------
  // F8 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F8.B1: launchGame fails fast when CrossOver Preview Arm64 bottle directory is missing (never falls back to wine/gptk)', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    // Seed a real Wine Stable.app inside sandbox.applicationsDir so detectCompatibilityLayers finds 'wine',
    // ensuring supervisor does NOT fall back to it when crossover_preview_arm64 bottle is missing.
    const wineStableBinDir = path.join(
      sandbox.applicationsDir,
      'Wine Stable.app/Contents/Resources/wine/bin'
    );
    fs.mkdirSync(wineStableBinDir, { recursive: true });
    fs.writeFileSync(path.join(wineStableBinDir, 'wine64'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(wineStableBinDir, 'wine'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    const detected = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
    });
    expect(detected.some((l: any) => l.type === 'wine')).toBe(true);

    const gameDir = path.join(sandbox.gamesDir, 'MissingBottleGame');
    fs.mkdirSync(gameDir, { recursive: true });
    const exePath = path.join(gameDir, 'game.exe');
    fs.writeFileSync(exePath, buildSyntheticPeBinary(0x8664));

    const spawnSpy = vi.fn();

    const launchRes = await sessionSupervisor.launchGame(
      {
        gameId: 't2-f8-missing-bottle',
        platformId: 'custom',
        title: 'MissingBottleGame',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'NonExistentArm64Bottle',
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
        skipBottleDirCreation: true,
        gameSpawnFn: spawnSpy,
        spawnFn: spawnSpy,
      }
    );

    expect(launchRes.success).toBe(false);
    expect(String(launchRes.error || '')).toMatch(/bottle|OneLauncher-arm64|missing|exist/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('F8.B2: ARM64 PE (0xaa64) executable is rejected when launched with standard Intel crossover_preview', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'standard' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });

    const gameDir = path.join(sandbox.gamesDir, 'Arm64OnStandard');
    fs.mkdirSync(gameDir, { recursive: true });
    const armExe = path.join(gameDir, 'arm64only.exe');
    fs.writeFileSync(armExe, buildSyntheticPeBinary(0xaa64));

    const launchRes = await sessionSupervisor.launchGame(
      {
        gameId: 't2-f8-arm64-on-std',
        platformId: 'custom',
        title: 'Arm64OnStandard',
        installPath: gameDir,
        executablePath: armExe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
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

    expect(launchRes.success).toBe(false);
    expect(String(launchRes.error || '')).toMatch(/architecture|ARM64|unsupported/i);
  });

  it('F8.B3: corrupted PE header fails fast under crossover_preview_arm64 before spawning runtime', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const gameDir = path.join(sandbox.gamesDir, 'CorruptPe');
    fs.mkdirSync(gameDir, { recursive: true });
    const badExe = path.join(gameDir, 'corrupt.exe');
    fs.writeFileSync(badExe, Buffer.from('NOT_A_PE_HEADER', 'utf8'));

    const spawnSpy = vi.fn();
    const launchRes = await sessionSupervisor.launchGame(
      {
        gameId: 't2-f8-corrupt-pe',
        platformId: 'custom',
        title: 'CorruptPe',
        installPath: gameDir,
        executablePath: badExe,
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
        gameSpawnFn: spawnSpy,
        spawnFn: spawnSpy,
      }
    );

    expect(launchRes.success).toBe(false);
    expect(String(launchRes.error || '')).toMatch(/corrupted|invalid.*PE|PE header/i);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('F8.B4: launchGame rejects crossover_preview_arm64 on x64 Intel host architecture', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    seedBottle(sandbox.previewBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const gameDir = path.join(sandbox.gamesDir, 'IntelHostArm64Runner');
    fs.mkdirSync(gameDir, { recursive: true });
    const exePath = path.join(gameDir, 'game.exe');
    fs.writeFileSync(exePath, buildSyntheticPeBinary(0x8664));

    const launchRes = await sessionSupervisor.launchGame(
      {
        gameId: 't2-f8-x64-host',
        platformId: 'custom',
        title: 'IntelHostArm64Runner',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
        },
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        applicationsDirs: [sandbox.applicationsDir],
        customApplicationsDir: sandbox.applicationsDir,
        skipBottleProvisioning: true,
      }
    );

    expect(launchRes.success).toBe(false);
    expect(String(launchRes.error || '')).toMatch(
      /apple silicon|arm64|x86_64|intel|arch|unsupported/i
    );
  });

  it('F8.B5: resolveWineserverBinary returns null cleanly for empty or nonexistent path', () => {
    expect(macNativeInstaller.resolveWineserverBinary('')).toBeNull();
    expect(
      macNativeInstaller.resolveWineserverBinary(path.join(sandbox.tmpRoot, 'missing/bin/wine'))
    ).toBeNull();
  });

  // --------------------------------------------------------------------------
  // F9 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F9.B1: IPC sanitizers reject null bytes, .. traversal, leading -, and invalid archive extensions', async () => {
    const bridge = createIpcAndServiceHarness();
    try {
      const badArchive = await bridge.invokeChannel('launcher:update-compat-layer', {
        runnerType: 'crossover_preview_arm64',
        archivePath: '/tmp/../../etc/passwd.zip',
      });
      const badNull = await bridge.invokeChannel('launcher:update-compat-layer', {
        runnerType: 'crossover_preview_arm64',
        archivePath: '/tmp/preview\0.zip',
      });
      const badExt = await bridge.invokeChannel('launcher:update-compat-layer', {
        runnerType: 'crossover_preview_arm64',
        archivePath: '/tmp/preview.exe',
      });
      const badSetupBottle = await bridge.invokeChannel('launcher:run-environment-setup-tasks', {
        runId: 'bad-bottle',
        tasks: [
          {
            action: 'ensure_bottle',
            componentId: 'bottle_default',
            runnerType: 'crossover_preview_arm64',
            bottleName: '../escape',
          },
        ],
      });

      expect(badArchive.success).toBe(false);
      expect(String(badArchive.error || '')).toMatch(/Invalid archivePath|traversal/i);
      expect(badNull.success).toBe(false);
      expect(String(badNull.error || '')).toMatch(/Invalid archivePath|null byte/i);
      expect(badExt.success).toBe(false);
      expect(String(badExt.error || '')).toMatch(/Invalid archivePath|\.zip/i);
      expect(badSetupBottle.success).toBe(false);
      expect(
        String(badSetupBottle.error || badSetupBottle.outcomes?.[0]?.error || '')
      ).toMatch(/bottle|invalid|traversal/i);
    } finally {
      bridge.dispose();
    }
  });

  it('F9.B2: FORBIDDEN_RENDERER_IPC_KEYS strips homedir, crossoverPath, machineIdOverride, and execFileFn from IPC options', async () => {
    const capturedOpts: any[] = [];
    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        detectCompatibilityLayers: vi.fn((opts: any) => {
          capturedOpts.push(opts);
          return [];
        }),
      },
    });

    try {
      await bridge.invokeChannel('launcher:detect-compat-layers', {
        homedir: '/Users/evil',
        crossoverPath: '/evil/CrossOver.app',
        machineIdOverride: 'fake-uuid',
        execFileFn: 'not-allowed',
      });

      expect(capturedOpts[0]?.homedir).toBeUndefined();
      expect(capturedOpts[0]?.crossoverPath).toBeUndefined();
      expect(capturedOpts[0]?.machineIdOverride).toBeUndefined();
      expect(capturedOpts[0]?.execFileFn).toBeUndefined();
    } finally {
      bridge.dispose();
    }
  });

  it('F9.B3: IPC launcher:cancel-compat-layer-op accepts crossover_preview_arm64 and aborts active operation', async () => {
    const cancelSpy = vi.fn(() => ({ success: true, cancelled: true }));
    let resolveInstall!: (v: any) => void;
    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        installCompatibilityLayer: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveInstall = resolve;
            })
        ),
        cancelCompatibilityLayerOperation: cancelSpy,
      },
    });

    try {
      const pendingInstall = bridge.invokeChannel('launcher:install-compat-layer', {
        runnerType: 'crossover_preview_arm64',
        mode: 'direct',
      });
      const cancelRes = await bridge.invokeChannel(
        'launcher:cancel-compat-layer-op',
        'crossover_preview_arm64'
      );

      expect(cancelRes.success).toBe(true);
      expect(cancelSpy).toHaveBeenCalledWith('crossover_preview_arm64');
      resolveInstall({ success: false, cancelled: true, runnerType: 'crossover_preview_arm64' });
      await pendingInstall;
    } finally {
      bridge.dispose();
    }
  });

  it('F9.B4: buildContractSafeIpcSnapshotFallback includes runner_crossover_preview_arm64 when probeEnvironmentHealth is absent', async () => {
    const bridge = createIpcAndServiceHarness({
      engineOverrides: {
        probeEnvironmentHealth: undefined,
      },
    });

    try {
      const fallbackSnapshot = await bridge.invokeChannel('launcher:probe-environment-health', {});
      expect(fallbackSnapshot).toBeDefined();
      expect(fallbackSnapshot.components.runner_crossover_preview_arm64).toBeDefined();
    } finally {
      bridge.dispose();
    }
  });

  it('F9.B5: crossover_preview_arm64 cached preview URL never bleeds into crossover_preview and vice versa', () => {
    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_ARM64_PREVIEW_ZIP_URL, {
      previewBranch: 'arm64',
    });

    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBeNull();
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBe(E2E_ARM64_PREVIEW_ZIP_URL);

    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_STANDARD_PREVIEW_ZIP_URL, {
      previewBranch: 'standard',
    });
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl('standard');

    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBeNull();
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
  });
});
