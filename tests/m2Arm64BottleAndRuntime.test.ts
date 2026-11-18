import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const macNativeInstaller = require('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const environmentProvisioner = require('../electron/launcher/environmentProvisioner.cjs');
const environmentHealthProber = require('../electron/launcher/environmentHealthProber.cjs');
const wineAndCrossOverManager = require('../electron/launcher/wineAndCrossOverManager.cjs');
const sessionAndProcessSupervisor = require('../electron/launcher/sessionAndProcessSupervisor.cjs');
const installedGameScanner = require('../electron/launcher/installedGameScanner.cjs');
const chainedPublisherLaunchers = require('../electron/launcher/chainedPublisherLaunchers.cjs');
const binaryAndManifestInspectors = require('../electron/launcher/binaryAndManifestInspectors.cjs');
const downloadQueueCoordinator = require('../electron/launcher/downloadQueueCoordinator.cjs');
const uninstallSafety = require('../electron/launcher/uninstallSafety.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');

const tempDirs: string[] = [];

function makeTempDir(prefix = 'ol-m2-arm64-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content: string | Buffer = '#!/bin/sh\nexit 0\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function buildMockMachOArm64Binary(): Buffer {
  const buf = Buffer.alloc(64, 0);
  // MH_MAGIC_64 (little-endian 0xfeedfacf) + CPU_TYPE_ARM64 (0x0100000c)
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  return buf;
}

function buildSyntheticPe(machine: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew -> 0x80
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(machine, 0x84);
  buf.writeUInt16LE(machine === 0x014c ? 0x00e0 : 0x00f0, 0x94); // SizeOfOptionalHeader
  buf.writeUInt16LE(machine === 0x014c ? 0x010b : 0x020b, 0x98); // Magic (PE32 vs PE32+)
  return buf;
}

function seedSyntheticCrossOverApp(
  appsDir: string,
  opts: {
    branch: 'stable' | 'standard' | 'arm64';
    buildTimestamp?: string;
    withArm64Dxmt?: boolean;
    withArm64LoaderApp?: boolean;
    withLibAppleGptk3?: boolean;
    withD3dMetal?: boolean;
  }
) {
  let appName: string;
  switch (opts.branch) {
    case 'stable':
      appName = 'CrossOver.app';
      break;
    case 'standard':
      appName = 'CrossOver Preview.app';
      break;
    case 'arm64':
      appName = 'CrossOver Preview arm64.app';
      break;
    default: {
      const exhaustiveCheck: never = opts.branch;
      throw new Error(`Unexpected CrossOver branch: ${String(exhaustiveCheck)}`);
    }
  }
  const appPath = path.join(appsDir, appName);
  const cxRoot = path.join(appPath, 'Contents/SharedSupport/CrossOver');
  const binDir = path.join(cxRoot, 'bin');
  const etcDir = path.join(cxRoot, 'etc');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(etcDir, { recursive: true });

  const wineBin = path.join(binDir, 'wine');
  writeExecutable(wineBin, '#!/usr/bin/perl\nexit 0\n');
  writeExecutable(path.join(binDir, 'cxbottle'));
  writeExecutable(path.join(binDir, 'wineserver'));

  if (opts.branch === 'arm64') {
    writeExecutable(path.join(binDir, 'wineserver-arm64'));
    const aarch64Unix = path.join(cxRoot, 'lib/wine/aarch64-unix');
    fs.mkdirSync(aarch64Unix, { recursive: true });
    fs.writeFileSync(path.join(aarch64Unix, 'ntdll.so'), 'ELF-ARM64', 'utf8');
    if (opts.withArm64LoaderApp) {
      writeExecutable(
        path.join(aarch64Unix, 'wine.app/Contents/MacOS/wine'),
        buildMockMachOArm64Binary()
      );
    } else {
      writeExecutable(path.join(aarch64Unix, 'wine'), buildMockMachOArm64Binary());
    }
    if (opts.withArm64Dxmt) {
      const aarch64Dxmt = path.join(cxRoot, 'lib/dxmt/aarch64-windows');
      fs.mkdirSync(aarch64Dxmt, { recursive: true });
      fs.writeFileSync(path.join(aarch64Dxmt, 'd3d11.dll'), 'DXMT', 'utf8');
    }
  } else {
    writeExecutable(path.join(binDir, 'wineserver-x86'));
    const x64Unix = path.join(cxRoot, 'lib/wine/x86_64-unix');
    fs.mkdirSync(x64Unix, { recursive: true });
    fs.writeFileSync(path.join(x64Unix, 'ntdll.so'), 'ELF-X64', 'utf8');
    writeExecutable(path.join(x64Unix, 'wine'));
  }

  if (opts.withLibAppleGptk3) {
    const gptkWine = path.join(cxRoot, 'lib/apple_gptk3/wine');
    writeExecutable(gptkWine);
  }
  if (opts.withD3dMetal) {
    const fwDir = path.join(cxRoot, 'lib/apple_gptk/external/D3DMetal.framework/Resources');
    fs.mkdirSync(fwDir, { recursive: true });
    fs.writeFileSync(
      path.join(fwDir, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>4.0b3</string></dict></plist>`,
      'utf8'
    );
  }

  fs.writeFileSync(
    path.join(etcDir, 'CrossOver.conf'),
    `[CrossOver]\n"BuildTimestamp" = "${opts.buildTimestamp || '20261111'}"\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.codeweavers.CrossOver</string>
  <key>CFBundleShortVersionString</key><string>20261111</string>
  <key>CFBundleVersion</key><string>27.0.0.41303</string>
  <key>SUFeedURL</key><string>https://www.codeweavers.com/xml/versions/cxmac.xml</string>
</dict></plist>`,
    'utf8'
  );

  return { appPath, cxRoot, wineBin };
}

function seedSyntheticBottle(
  bottlesDir: string,
  bottleName: string,
  opts: { wineArch: 'arm64' | 'win64'; previewEnabled?: boolean; driveC?: boolean } = {
    wineArch: 'arm64',
  }
): string {
  const bottleDir = path.join(bottlesDir, bottleName);
  if (opts.driveC !== false) {
    fs.mkdirSync(path.join(bottleDir, 'drive_c/windows/system32'), { recursive: true });
    fs.writeFileSync(path.join(bottleDir, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  } else {
    fs.mkdirSync(bottleDir, { recursive: true });
  }
  const previewLine = opts.previewEnabled ? '"Preview" = "1"\n' : '';
  fs.writeFileSync(
    path.join(bottleDir, 'cxbottle.conf'),
    `[Bottle]\n"WineArch" = "${opts.wineArch}"\n${previewLine}\n[EnvironmentVariables]\n"WINEMSYNC" = "1"\n`,
    'utf8'
  );
  return bottleDir;
}

describe('M2: Arm64 Bottle Architecture & Launch/Runtime Handling (F6–F8)', () => {
  beforeEach(() => {
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
    environmentHealthProber.invalidateProberRunnerUpdatesCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engineStateRegistry.activeSessions?.clear?.();
    engineStateRegistry.pendingBottleLaunches?.clear?.();
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
    environmentHealthProber.invalidateProberRunnerUpdatesCache();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('F6: differentiates Standard vs Arm64 Preview bundles despite identical Info.plist, gates arm64 host, populates metadata, and never mutates empty bottle dirs', () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });

    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', buildTimestamp: '20261111' });
    seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', buildTimestamp: '20261111', withArm64Dxmt: true });

    const stdBottles = path.join(home, 'Library/Application Support/CrossOver Preview/Bottles');
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    seedSyntheticBottle(stdBottles, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });
    seedSyntheticBottle(armBottles, 'OneLauncher-arm64', { wineArch: 'arm64', previewEnabled: true });

    const emptyStrayDir = path.join(armBottles, 'UninitializedEmptyDir');
    fs.mkdirSync(emptyStrayDir, { recursive: true });

    const armHostLayers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'arm64',
      homedir: home,
      applicationsDirs: [appsDir],
      customApplicationsDir: appsDir,
    });

    const stdLayer = armHostLayers.find((l: any) => l.type === 'crossover_preview');
    const armLayer = armHostLayers.find((l: any) => l.type === 'crossover_preview_arm64');
    expect(stdLayer).toBeDefined();
    expect(armLayer).toBeDefined();
    expect(stdLayer.previewBranch).toBe('standard');
    expect(armLayer.previewBranch).toBe('arm64');
    expect(armLayer.supportedBottleArches).toEqual(['arm64']);
    expect(armLayer.bottleDetails?.['OneLauncher-arm64']?.wineArch).toBe('arm64');
    expect(armLayer.bottleDetails?.['OneLauncher-arm64']?.previewEnabled).toBe(true);
    expect(fs.existsSync(emptyStrayDir)).toBe(true);

    const x64HostLayers = macNativeInstaller.detectCompatibilityLayers({
      platform: 'darwin',
      arch: 'x64',
      homedir: home,
      applicationsDirs: [appsDir],
      customApplicationsDir: appsDir,
    });
    expect(x64HostLayers.some((l: any) => l.type === 'crossover_preview')).toBe(true);
    expect(x64HostLayers.find((l: any) => l.type === 'crossover_preview_arm64')?.available).toBe(
      false
    );
  });

  it('F6: probeEnvironmentHealth reflects runner_crossover_preview_arm64 as not_applicable on x64 and ready on arm64, and redirect host check rejects evil redirects', async () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const armBundle = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64' });
    // Overwrite Info.plist with non-cxmac feed pointing at an evil redirect target
    fs.writeFileSync(
      path.join(armBundle.appPath, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.codeweavers.CrossOver</string>
  <key>CFBundleShortVersionString</key><string>20261111</string>
  <key>SUFeedURL</key><string>https://www.codeweavers.com/preview/arm64-appcast.xml</string>
</dict></plist>`,
      'utf8'
    );

    const armSnap = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'arm64',
      homedir: home,
      userDataDir: path.join(home, 'userData'),
      customApplicationsDir: appsDir,
      applicationsDirs: [appsDir],
      skipNetwork: true,
      execFileSyncFn: () => {},
    });
    expect(armSnap.components.runner_crossover_preview_arm64?.status).toBe('ready');

    const x64Snap = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'x64',
      homedir: home,
      userDataDir: path.join(home, 'userData-x64'),
      customApplicationsDir: appsDir,
      applicationsDirs: [appsDir],
      skipNetwork: true,
      execFileSyncFn: () => {},
    });
    expect(x64Snap.components.runner_crossover_preview_arm64?.status).toBe('not_applicable');

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: home,
      applicationsDirs: [appsDir],
      customApplicationsDir: appsDir,
      previewSessionFetch: async () => ({
        ok: true,
        status: 200,
        url: 'https://evil.example/hijack.xml',
        text: async () =>
          '<rss><channel><item><enclosure url="https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261112.zip"/></item></channel></rss>',
      }),
    });
    expect(updates.crossover_preview_arm64?.authRequired).toBe(true);
    expect(updates.crossover_preview_arm64?.downloadUrl).toBeUndefined();
  });

  it('F7: provisions dedicated OneLauncher-arm64 via cxbottle --winearch arm64, enforces Preview=1 without losing WineArch, and rejects win64/arm64 cross-pairing', async () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const armBundle = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    const stdBundle = seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });

    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    const stdBottles = path.join(home, 'Library/Application Support/CrossOver Preview/Bottles');
    const existingWin64 = seedSyntheticBottle(stdBottles, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });

    const cxbottleCalls: Array<{ bin: string; args: string[]; env: Record<string, any> }> = [];
    const env: Record<string, any> = {};

    const readyRes = await macNativeInstaller.ensureCompatibilityLayerReady(
      {
        type: 'crossover_preview_arm64',
        appPath: armBundle.appPath,
        binaryPath: armBundle.wineBin,
        bottlesDir: armBottles,
      },
      {},
      env,
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        execFileFn: (
          bin: string,
          args: string[],
          opts: { env: Record<string, any> },
          cb: (err: Error | null) => void
        ) => {
          cxbottleCalls.push({ bin, args: [...args], env: { ...opts.env } });
          const bIdx = args.indexOf('--bottle');
          const bName = bIdx >= 0 ? args[bIdx + 1] : 'OneLauncher-arm64';
          seedSyntheticBottle(opts.env.CX_BOTTLE_PATH || armBottles, bName, {
            wineArch: 'arm64',
            previewEnabled: true,
          });
          cb(null);
        },
      }
    );

    expect(readyRes.targetBottle).toBe('OneLauncher-arm64');
    expect(readyRes.wineArch).toBe('arm64');
    expect(env.CX_BOTTLE).toBe('OneLauncher-arm64');
    expect(env.CX_BOTTLE_PATH).toBe(armBottles);
    expect(cxbottleCalls).toHaveLength(1);
    expect(cxbottleCalls[0].args).toEqual([
      '--bottle',
      'OneLauncher-arm64',
      '--create',
      '--template',
      'win10_64',
      '--winearch',
      'arm64',
    ]);

    // Original win64 OneLauncher must remain intact
    const win64Conf = fs.readFileSync(path.join(existingWin64, 'cxbottle.conf'), 'utf8');
    expect(win64Conf).toContain('"WineArch" = "win64"');

    // Cross-architecture pairing must fail fast
    await expect(
      macNativeInstaller.ensureCompatibilityLayerReady(
        {
          type: 'crossover_preview_arm64',
          appPath: armBundle.appPath,
          binaryPath: armBundle.wineBin,
          bottlesDir: stdBottles,
        },
        { wineBottleName: 'OneLauncher' },
        {},
        { platform: 'darwin', arch: 'arm64', homedir: home, skipBottleProvisioning: true }
      )
    ).rejects.toThrow(/arm64|win64|incompatible|mismatch/i);

    await expect(
      macNativeInstaller.ensureCompatibilityLayerReady(
        {
          type: 'crossover_preview',
          appPath: stdBundle.appPath,
          binaryPath: stdBundle.wineBin,
          bottlesDir: armBottles,
        },
        { wineBottleName: 'OneLauncher-arm64' },
        {},
        { platform: 'darwin', arch: 'arm64', homedir: home, skipBottleProvisioning: true }
      )
    ).rejects.toThrow(/arm64|win64|incompatible|mismatch/i);
  });

  it('F7: resolveDefaultChainedBottleName, installedGameScanner, and environmentHealthProber respect OneLauncher-arm64 isolation', async () => {
    const pickedArm64 = chainedPublisherLaunchers.resolveDefaultChainedBottleName({
      discoveredBottleNames: [
        { name: 'OneLauncher', wineArch: 'win64' },
        { name: 'OneLauncher-arm64', wineArch: 'arm64' },
      ],
      runnerType: 'crossover_preview_arm64',
    });
    expect(pickedArm64).toBe('OneLauncher-arm64');

    const fallbackArm64 = chainedPublisherLaunchers.resolveDefaultChainedBottleName({
      discoveredBottleNames: [{ name: 'OneLauncher', wineArch: 'win64' }],
      runnerType: 'crossover_preview_arm64',
    });
    expect(fallbackArm64).toBe('OneLauncher-arm64');

    const pickedStd = chainedPublisherLaunchers.resolveDefaultChainedBottleName({
      discoveredBottleNames: [
        { name: 'OneLauncher-arm64', wineArch: 'arm64' },
        { name: 'OneLauncher', wineArch: 'win64' },
      ],
      runnerType: 'crossover_preview',
    });
    expect(pickedStd).toBe('OneLauncher');

    // Scanner checks CrossOver Preview arm64/Bottles
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    seedSyntheticCrossOverApp(appsDir, { branch: 'arm64' });
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    const armBottle = seedSyntheticBottle(armBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    const steamApps = path.join(armBottle, 'drive_c/Program Files (x86)/Steam/steamapps');
    const gameDir = path.join(steamApps, 'common/FexTestGame');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'game.exe'), buildSyntheticPe(0x8664));
    fs.writeFileSync(
      path.join(steamApps, 'appmanifest_990011.acf'),
      `"AppState"\n{\n\t"appid"\t\t"990011"\n\t"name"\t\t"FexTestGame"\n\t"installdir"\t\t"FexTestGame"\n\t"SizeOnDisk"\t\t"1048576"\n}\n`,
      'utf8'
    );

    const scanRes = await installedGameScanner.scanAllInstalledGames({
      platform: 'darwin',
      homedir: home,
      userDataDir: path.join(home, 'userData'),
      customApplicationsDir: appsDir,
      applicationsDirs: [appsDir],
      forceRefresh: true,
    });
    expect(scanRes.success).toBe(true);
    const foundGame = scanRes.installedGames.find((g: any) => String(g.platformGameId) === '990011');
    expect(foundGame).toBeDefined();
    expect(foundGame.installPath).toContain('OneLauncher-arm64');
    expect(foundGame.isWindowsBinaryOnMac).toBe(true);
  });

  it('F8: resolves arm64 wine.app/aarch64-unix loaders, lib/apple_gptk3 fallback, FEX env forwarding, Rosetta AVX skip, and ARM64 PE gate', async () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });

    const armApp = seedSyntheticCrossOverApp(appsDir, {
      branch: 'arm64',
      withArm64LoaderApp: true,
      withLibAppleGptk3: true,
      withArm64Dxmt: true,
      withD3dMetal: true,
    });

    const loaderAppBin = path.join(
      armApp.cxRoot,
      'lib/wine/aarch64-unix/wine.app/Contents/MacOS/wine'
    );
    expect(macNativeInstaller.doesWineLoaderAllowDyldInsert(loaderAppBin)).toBe(true);

    const sipEnv: Record<string, any> = {
      DYLD_INSERT_LIBRARIES: '/tmp/mock_preload.dylib',
    };
    const resolvedBinary = macNativeInstaller.resolveSipSafeWineBinaryAndPreloadEnv(
      armApp.wineBin,
      sipEnv,
      { layerType: 'crossover_preview_arm64', wineArch: 'arm64' }
    );
    expect(resolvedBinary).toBe(armApp.wineBin);
    expect(sipEnv.WINELOADER).toBe(loaderAppBin);
    expect(sipEnv.CX_ENV).toContain('/tmp/mock_preload.dylib');

    // FEX env forwarding & Preview=1 without clobbering WineArch=arm64
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    const armBottleDir = seedSyntheticBottle(armBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: false,
    });
    const fexCfg = {
      environmentVariables: {
        FEX_X87REDUCEDPRECISION: '1',
        FEX_TSOENABLED: '1',
        FEX_MULTIBLOCK: '0',
      },
    };
    macNativeInstaller.applyCrossOverPerGameSettings(armBottleDir, fexCfg, {
      isPreviewRunner: true,
      isPreviewArm64Runner: true,
      runnerType: 'crossover_preview_arm64',
      homedir: home,
      hostArch: 'arm64',
    });

    const env: Record<string, any> = { ROSETTA_ADVERTISE_AVX: '1' };
    await macNativeInstaller.ensureCompatibilityLayerReady(
      {
        type: 'crossover_preview_arm64',
        appPath: armApp.appPath,
        binaryPath: armApp.wineBin,
        bottlesDir: armBottles,
      },
      { ...fexCfg, wineBottleName: 'OneLauncher-arm64' },
      env,
      { homedir: home, hostArch: 'arm64', isPreviewArm64Runner: true, skipBottleProvisioning: true }
    );
    expect(env.ROSETTA_ADVERTISE_AVX).toBeUndefined();
    expect(env.FEX_X87REDUCEDPRECISION).toBe('1');
    expect(env.FEX_TSOENABLED).toBe('1');
    expect(env.FEX_MULTIBLOCK).toBe('0');

    const confText = fs.readFileSync(path.join(armBottleDir, 'cxbottle.conf'), 'utf8');
    expect(confText).toMatch(/\[Bottle\][\s\S]*?"WineArch"\s*=\s*"arm64"/);
    expect(confText).toMatch(/\[Bottle\][\s\S]*?"Preview"\s*=\s*"1"/);
    expect(confText).toContain('"FEX_X87REDUCEDPRECISION" = "1"');
    expect(confText).toContain('"FEX_TSOENABLED" = "1"');
    expect(confText).toContain('"FEX_MULTIBLOCK" = "0"');

    // applyStrictRosettaAvxEnv skips default AVX injection for arm64 FEX unless explicitly requested
    const fexRosettaEnv: Record<string, any> = { ROSETTA_ADVERTISE_AVX: '1' };
    wineAndCrossOverManager.applyStrictRosettaAvxEnv(fexRosettaEnv, undefined, {
      layerType: 'crossover_preview_arm64',
      wineArch: 'arm64',
    });
    expect(fexRosettaEnv.ROSETTA_ADVERTISE_AVX).toBeUndefined();

    // Auto graphics backend routing picks arm64_fex_auto_dxmt -> dxmt when arm64 DXMT exists
    const autoBackend = macNativeInstaller.resolveEffectiveCrossOverGraphicsBackend({
      compatLayer: {
        type: 'crossover_preview_arm64',
        appPath: armApp.appPath,
        binaryPath: armApp.wineBin,
      },
      cxRoot: armApp.cxRoot,
      bottlePath: armBottleDir,
      requestedBackend: 'auto',
      hostArch: 'arm64',
    });
    expect(autoBackend.backend).toBe('dxmt');
    expect(autoBackend.reroutedReason).toBe('arm64_fex_auto_dxmt');

    // ARM64 PE gate
    const arm64Exe = path.join(home, 'game_arm64.exe');
    fs.writeFileSync(arm64Exe, buildSyntheticPe(0xaa64));
    const arm64PeInfo = binaryAndManifestInspectors.inspectPeCapabilities(arm64Exe);
    expect(arm64PeInfo?.isValidPe).toBe(true);
    expect(
      binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(arm64PeInfo, {
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        allowArm64Pe: true,
      })
    ).toBe(true);
    expect(
      binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(arm64PeInfo, {
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        allowArm64Pe: false,
      })
    ).toBe(false);
    expect(
      binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(arm64PeInfo, {
        hostPlatform: 'darwin',
        hostArch: 'x64',
        allowArm64Pe: true,
      })
    ).toBe(false);
  });

  it('F6/F8: stage1 launch rejects missing CrossOver bottle instead of silently falling back to Wine/GPTK, and assertRunnerSafeToReplace shuts down wineserver-arm64', async () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64' });

    const gameDir = path.join(home, 'Games/NoBottleGame');
    fs.mkdirSync(gameDir, { recursive: true });
    const exePath = path.join(gameDir, 'game64.exe');
    fs.writeFileSync(exePath, buildSyntheticPe(0x8664));

    const spawnSpy = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 55555;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    const missingBottleLaunch = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'm2-missing-bottle-test',
        platformId: 'custom',
        title: 'NoBottleGame',
        installPath: gameDir,
        executablePath: exePath,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'MissingArm64Bottle',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir: path.join(home, 'userData'),
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );

    expect(missingBottleLaunch.success).toBe(false);
    expect(String(missingBottleLaunch.error || '')).toMatch(/bottle/i);
    expect(spawnSpy).not.toHaveBeenCalled();

    // assertRunnerSafeToReplace detects wineserver-arm64 process and shuts down arm64 bottle cleanly
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    seedSyntheticBottle(armBottles, 'OneLauncher-arm64', { wineArch: 'arm64', previewEnabled: true });

    const killedCmds: string[] = [];
    let wineServerKilled = false;
    const safeRes = await environmentProvisioner.assertRunnerSafeToReplace(
      'crossover_preview_arm64',
      armApp.appPath,
      {
        type: 'crossover_preview_arm64',
        appPath: armApp.appPath,
        binaryPath: armApp.wineBin,
      },
      {
        platform: 'darwin',
        homedir: home,
        execFileFn: (
          bin: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          if (path.basename(bin) === 'ps') {
            cb(
              null,
              wineServerKilled
                ? ''
                : `88123 ${armApp.appPath}/Contents/SharedSupport/CrossOver/bin/wineserver-arm64\n`,
              ''
            );
            return;
          }
          if (path.basename(bin).startsWith('wineserver') && args.includes('-k')) {
            wineServerKilled = true;
          }
          killedCmds.push(`${path.basename(bin)} ${args.join(' ')}`);
          cb(null, '', '');
        },
      }
    );
    expect(safeRes.ok).toBe(true);
    expect(killedCmds.some((c) => c.startsWith('wineserver-arm64 -k'))).toBe(true);
  });

  it('R2-1: applyCrossOverPerGameSettings populates CX_HOME, CX_ROOT, and DOTNET_EnableWriteXorExecute for crossover_preview_arm64 while suppressing ROSETTA_ADVERTISE_AVX', () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    const armBottleDir = seedSyntheticBottle(armBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });

    const env: Record<string, any> = { ROSETTA_ADVERTISE_AVX: '1' };
    macNativeInstaller.applyCrossOverPerGameSettings(
      {
        type: 'crossover_preview_arm64',
        appPath: armApp.appPath,
        binaryPath: armApp.wineBin,
      },
      {},
      env,
      armBottleDir,
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        cxRoot: armApp.cxRoot,
      }
    );

    expect(env.CX_HOME).toBe(path.join(home, 'Library/Application Support/CrossOver'));
    expect(env.CX_ROOT).toBe(armApp.cxRoot);
    expect(env.DOTNET_EnableWriteXorExecute).toBe('0');
    expect(env.ROSETTA_ADVERTISE_AVX).toBeUndefined();
  });

  it('R2-2: filters stale wizardState.preferredBottleName and unfiltered availableBottles across ensure_bottle, chained launch, and chained install', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });

    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    seedSyntheticBottle(sharedBottles, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });

    environmentHealthProber.saveSetupWizardState(
      {
        preferredRunnerType: 'crossover',
        preferredBottleName: 'OneLauncher',
      },
      { userDataDir }
    );

    const provisionedCalls: string[][] = [];
    const setupRes = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        tasks: [
          {
            componentId: 'bottle_default',
            action: 'ensure_bottle',
            runnerType: 'crossover_preview_arm64',
          },
        ],
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        execFileFn: (
          bin: string,
          args: string[],
          opts: { env: Record<string, any> },
          cb: (err: Error | null) => void
        ) => {
          if (path.basename(bin) === 'cxbottle') {
            provisionedCalls.push([...args]);
            const bIdx = args.indexOf('--bottle');
            const bName = bIdx >= 0 ? args[bIdx + 1] : 'OneLauncher-arm64';
            seedSyntheticBottle(opts.env?.CX_BOTTLE_PATH || sharedBottles, bName, {
              wineArch: 'arm64',
              previewEnabled: true,
            });
          }
          cb(null);
        },
      }
    );

    expect(setupRes.outcomes[0]?.status).toBe('completed');
    expect(provisionedCalls).toHaveLength(1);
    expect(provisionedCalls[0]).toContain('OneLauncher-arm64');

    // Explicit incompatible bottleName on ensure_bottle still fails fast
    const explicitBadRes = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        tasks: [
          {
            componentId: 'bottle_default',
            action: 'ensure_bottle',
            runnerType: 'crossover_preview_arm64',
            bottleName: 'OneLauncher',
          },
        ],
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
      }
    );
    expect(explicitBadRes.outcomes[0]?.status).toBe('failed');
    expect(String(explicitBadRes.outcomes[0]?.error || '')).toMatch(/WineArch="win64"|incompatible/i);

    // Reset wizard state back to stale win64 OneLauncher and remove OneLauncher-arm64 to test chained install + launch
    fs.rmSync(path.join(sharedBottles, 'OneLauncher-arm64'), { recursive: true, force: true });
    environmentHealthProber.saveSetupWizardState(
      {
        preferredRunnerType: 'crossover',
        preferredBottleName: 'OneLauncher',
      },
      { userDataDir }
    );

    const ensuredBottles: string[] = [];
    const chainedInstallRes = await downloadQueueCoordinator.installGame(
      {
        gameId: 'ea_test_r2',
        platformId: 'ea',
        platformGameId: 'test_r2',
        title: 'Test EA Game',
        compatibilityLayer: 'crossover_preview_arm64',
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        execFileFn: (
          _bin: string,
          args: string[],
          opts: { env: Record<string, any> },
          cb: (err: Error | null) => void
        ) => {
          const bIdx = args.indexOf('--bottle');
          const bName = bIdx >= 0 ? args[bIdx + 1] : 'OneLauncher-arm64';
          seedSyntheticBottle(opts.env?.CX_BOTTLE_PATH || sharedBottles, bName, {
            wineArch: 'arm64',
            previewEnabled: true,
          });
          cb(null);
        },
        ensureChainedPublisherLauncherInstalledFn: async (params: any) => {
          ensuredBottles.push(params.bottleName);
          return { installed: false, error: 'stop_after_bottle_check' };
        },
      }
    );
    expect(chainedInstallRes.success).toBe(false);
    expect(ensuredBottles).toEqual(['OneLauncher-arm64']);

    // Explicit win64 OneLauncher on installGame (chained) must throw/fail rather than swallowing WineArch error
    const explicitChainedInstallBad = await downloadQueueCoordinator.installGame(
      {
        gameId: 'ea_test_r2_bad',
        platformId: 'ea',
        platformGameId: 'test_r2_bad',
        title: 'Test EA Game Bad',
        compatibilityLayer: 'crossover_preview_arm64',
        wineBottle: 'OneLauncher',
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
      }
    );
    expect(explicitChainedInstallBad.success).toBe(false);
    expect(String(explicitChainedInstallBad.error || '')).toMatch(/WineArch="win64"|incompatible/i);

    // Chained launch with stale preferredBottleName & pre-existing win64 OneLauncher must pick OneLauncher-arm64
    fs.rmSync(path.join(sharedBottles, 'OneLauncher-arm64'), { recursive: true, force: true });
    const launchedChainedBottles: string[] = [];
    await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'ea_chained_launch_r2',
        platformId: 'ea',
        platformGameId: 'chained_launch_r2',
        title: 'Chained Launch R2',
        compatibilityLayer: 'crossover_preview_arm64',
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        execFileFn: (
          _bin: string,
          args: string[],
          opts: { env: Record<string, any> },
          cb: (err: Error | null) => void
        ) => {
          const bIdx = args.indexOf('--bottle');
          const bName = bIdx >= 0 ? args[bIdx + 1] : 'OneLauncher-arm64';
          seedSyntheticBottle(opts.env?.CX_BOTTLE_PATH || sharedBottles, bName, {
            wineArch: 'arm64',
            previewEnabled: true,
          });
          cb(null);
        },
        ensureChainedPublisherLauncherInstalledFn: async (params: any) => {
          launchedChainedBottles.push(params.bottleName);
          return { installed: false, error: 'stop_after_bottle_check' };
        },
      }
    );
    expect(launchedChainedBottles).toEqual(['OneLauncher-arm64']);

    // Explicit win64 bottle on chained launch skips ensureCompatibilityLayerReady via preResolvedBottlePath, yet must still fail WineArch check
    const explicitChainedLaunchBad = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'ea_chained_launch_r2_bad',
        platformId: 'ea',
        platformGameId: 'chained_launch_r2_bad',
        title: 'Chained Launch R2 Bad',
        compatibilityLayer: 'crossover_preview_arm64',
        launchConfig: {
          wineBottleName: 'OneLauncher',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
      }
    );
    expect(explicitChainedLaunchBad.success).toBe(false);
    expect(String(explicitChainedLaunchBad.error || '')).toMatch(/WineArch="win64"|incompatible/i);

    // ensureChainedPublisherLauncherInstalled (resolveExplicitOrWizardBottlePath) ignores stale win64 preferredBottleName and resolves OneLauncher-arm64
    const armLayerObj = macNativeInstaller
      .detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
      })
      .find((l: any) => l.type === 'crossover_preview_arm64');
    const arm64PrecheckBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    const eaFakeExe = path.join(
      arm64PrecheckBottle,
      'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop/EADesktop.exe'
    );
    writeExecutable(eaFakeExe, buildSyntheticPe(0x8664));
    const ensuredChainedPrecheck = await environmentProvisioner.ensureChainedPublisherLauncherInstalled(
      {
        handoffId: 'ea',
        platform: 'darwin',
        runnerLayer: armLayerObj,
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
      }
    );
    expect(ensuredChainedPrecheck.installed).toBe(true);
    expect(ensuredChainedPrecheck.binaryPath).toContain('OneLauncher-arm64');
  });

  it('R2-3: enforces Intel x64 host guard on chained/payload launches, blocks 0xaa64 customExecutablePath on crossover_preview, admits 0xaa64 on auto/payload arm64, and skips available=false runners', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });

    // Chained launch with payload.compatibilityLayer on x64 fails fast with Apple Silicon diagnostic
    const chainedX64Res = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'ea_x64_r2',
        platformId: 'ea',
        platformGameId: 'x64_r2',
        title: 'EA x64 Guard',
        compatibilityLayer: 'crossover_preview_arm64',
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
      }
    );
    expect(chainedX64Res.success).toBe(false);
    expect(String(chainedX64Res.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);

    // Auto-select 0xaa64 PE on arm64 with only CrossOver Preview arm64.app installed succeeds
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    seedSyntheticBottle(armBottles, 'OneLauncher-arm64', { wineArch: 'arm64', previewEnabled: true });
    const gameDir = path.join(home, 'Games/Arm64PeGame');
    fs.mkdirSync(gameDir, { recursive: true });
    const arm64Exe = path.join(gameDir, 'arm64_game.exe');
    fs.writeFileSync(arm64Exe, buildSyntheticPe(0xaa64));

    const spawnSpy = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 77777;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    const autoArm64Res = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r2-auto-arm64-pe',
        platformId: 'custom',
        title: 'AutoArm64PE',
        installPath: gameDir,
        executablePath: arm64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(autoArm64Res.success).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // Clear active session and test customExecutablePath pointing to 0xaa64 on crossover_preview (must fail fast with 0 new spawns)
    spawnSpy.mockClear();
    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });
    const stdBottles = path.join(home, 'Library/Application Support/CrossOver Preview/Bottles');
    seedSyntheticBottle(stdBottles, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });

    const customArm64UnderStd = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r2-custom-arm64-under-std',
        platformId: 'custom',
        title: 'CustomArm64UnderStd',
        installPath: gameDir,
        executablePath: arm64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
          customExecutablePath: arm64Exe,
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(customArm64UnderStd.success).toBe(false);
    expect(String(customArm64UnderStd.error || '')).toMatch(/0xaa64|unsupported architecture/i);
    expect(spawnSpy).not.toHaveBeenCalled();

    // Auto-select on Intel x64 skips available=false crossover_preview_arm64 and picks crossover_preview
    const x64Exe = path.join(gameDir, 'x64_game.exe');
    fs.writeFileSync(x64Exe, buildSyntheticPe(0x8664));
    const x64AutoRes = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r2-x64-auto-skip-arm64',
        platformId: 'custom',
        title: 'X64AutoSkipArm64',
        installPath: gameDir,
        executablePath: x64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
        },
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(x64AutoRes.success).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    engineStateRegistry.activeSessions?.clear?.();
    engineStateRegistry.pendingBottleLaunches?.clear?.();
  });

  it('R2-4/5/6/7: explicit wineArch=win64 beats arm64 path heuristic, shutdownWinePrefix/assertRunnerSafeToReplace honor CX_BOTTLE_PATH, 5-deep Xbox donor probing works, and D3D12-only auto routes to d3dmetal', async () => {
    const home = makeTempDir();
    const appsDir = path.join(home, 'Applications');
    const armApp = seedSyntheticCrossOverApp(appsDir, {
      branch: 'arm64',
      withArm64LoaderApp: true,
      withArm64Dxmt: true,
      withD3dMetal: true,
    });
    // Add x86_64-unix loader + wineserver-x86 alongside arm64 binaries (and remove generic wineserver to mirror real arm64 bundle)
    fs.rmSync(path.join(armApp.cxRoot, 'bin/wineserver'), { force: true });
    writeExecutable(path.join(armApp.cxRoot, 'bin/wineserver-x86'));
    writeExecutable(
      path.join(armApp.cxRoot, 'lib/wine/x86_64-unix/wine.app/Contents/MacOS/wine'),
      buildMockMachOArm64Binary()
    );

    const wsWin64 = macNativeInstaller.resolveWineserverBinary(armApp.wineBin, { wineArch: 'win64' });
    expect(path.basename(wsWin64)).toBe('wineserver-x86');

    const win64Env: Record<string, any> = {};
    macNativeInstaller.resolveSipSafeWineBinaryAndPreloadEnv(armApp.wineBin, win64Env, {
      wineArch: 'win64',
    });
    expect(win64Env.WINELOADER).toContain('x86_64-unix/wine.app/Contents/MacOS/wine');

    // Arbitrary parent folder containing 'arm64' does NOT force arm64 loader on standard CrossOver Preview
    const devArm64Parent = path.join(home, 'arm64dev');
    const stdUnderArm64Parent = seedSyntheticCrossOverApp(devArm64Parent, { branch: 'standard' });
    writeExecutable(
      path.join(stdUnderArm64Parent.cxRoot, 'lib/wine/x86_64-unix/wine'),
      buildMockMachOArm64Binary()
    );
    const stdEnv: Record<string, any> = {};
    macNativeInstaller.resolveSipSafeWineBinaryAndPreloadEnv(stdUnderArm64Parent.wineBin, stdEnv, {});
    expect(stdEnv.WINELOADER).toContain('x86_64-unix/wine');

    // shutdownWinePrefix overrides stale process.env.CX_BOTTLE_PATH
    const customBottlesRoot = path.join(home, 'custom_bottles');
    const customBottle = seedSyntheticBottle(customBottlesRoot, 'CustomArm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    const staleCxPath = path.join(home, 'stale_cx_path');
    const prevCxBottlePath = process.env.CX_BOTTLE_PATH;
    process.env.CX_BOTTLE_PATH = staleCxPath;
    try {
      const capturedShutdownEnvs: Array<Record<string, any>> = [];
      await macNativeInstaller.shutdownWinePrefix(armApp.wineBin, customBottle, 2000, {
        bottleName: 'CustomArm64',
        execFileFn: (
          _bin: string,
          _args: string[],
          opts: { env: Record<string, any> },
          cb: (err: Error | null) => void
        ) => {
          capturedShutdownEnvs.push({ ...opts.env });
          cb(null);
        },
      });
      expect(capturedShutdownEnvs.length).toBeGreaterThan(0);
      expect(capturedShutdownEnvs[0].CX_BOTTLE_PATH).toBe(fs.realpathSync(customBottlesRoot));

      // assertRunnerSafeToReplace shuts down bottles under process.env.CX_BOTTLE_PATH / options.cxBottlePath
      process.env.CX_BOTTLE_PATH = customBottlesRoot;
      const shutdownCustomPrefixes: string[] = [];
      let psCalled = 0;
      const safeRes = await environmentProvisioner.assertRunnerSafeToReplace(
        'crossover_preview_arm64',
        armApp.appPath,
        {
          type: 'crossover_preview_arm64',
          appPath: armApp.appPath,
          binaryPath: armApp.wineBin,
        },
        {
          platform: 'darwin',
          homedir: home,
          execFileFn: (
            bin: string,
            _args: string[],
            opts: { env?: Record<string, any> },
            cb: (err: Error | null, stdout?: string, stderr?: string) => void
          ) => {
            if (path.basename(bin) === 'ps') {
              psCalled += 1;
              cb(
                null,
                psCalled === 1
                  ? `99123 ${armApp.appPath}/Contents/SharedSupport/CrossOver/bin/wineserver-arm64\n`
                  : '',
                ''
              );
              return;
            }
            if (opts?.env?.WINEPREFIX) {
              shutdownCustomPrefixes.push(opts.env.WINEPREFIX);
            }
            cb(null, '', '');
          },
        }
      );
      expect(safeRes.ok).toBe(true);
      expect(shutdownCustomPrefixes).toContain(fs.realpathSync(customBottle));
    } finally {
      if (prevCxBottlePath === undefined) {
        delete process.env.CX_BOTTLE_PATH;
      } else {
        process.env.CX_BOTTLE_PATH = prevCxBottlePath;
      }
    }

    // prepareXboxBottleEnvironment 5-deep loader path probes lib/wine/aarch64-windows
    const donorDir = path.join(armApp.cxRoot, 'lib/wine/aarch64-windows');
    fs.mkdirSync(donorDir, { recursive: true });
    fs.writeFileSync(path.join(donorDir, 'vcruntime140.dll'), 'MOCK-ARM64-VCRUNTIME', 'utf8');
    const xboxBottle = path.join(home, 'xbox_5deep_bottle');
    fs.mkdirSync(path.join(xboxBottle, 'drive_c/windows/system32'), { recursive: true });
    fs.mkdirSync(path.join(xboxBottle, 'drive_c/windows/syswow64'), { recursive: true });
    const loader5Deep = path.join(
      armApp.cxRoot,
      'lib/wine/aarch64-unix/wine.app/Contents/MacOS/wine'
    );
    await wineAndCrossOverManager.prepareXboxBottleEnvironment({
      bottlePath: xboxBottle,
      wineBinaryPath: loader5Deep,
      layerType: 'crossover_preview_arm64',
      wineArch: 'arm64',
    });
    expect(
      fs.existsSync(path.join(xboxBottle, 'drive_c/windows/system32/vcruntime140_app.dll'))
    ).toBe(true);

    // D3D12-only auto backend routing picks d3dmetal on arm64 FEX when has64BitD3dMetal is true
    const d3d12Res = macNativeInstaller.resolveEffectiveCrossOverGraphicsBackend({
      requestedBackend: 'auto',
      chosenLayer: {
        type: 'crossover_preview_arm64',
        appPath: armApp.appPath,
        binaryPath: armApp.wineBin,
      },
      cxRoot: armApp.cxRoot,
      bottlePath: customBottle,
      is64Bit: true,
      importsD3d12: true,
      importsD3d11Or10: false,
      hostArch: 'arm64',
    });
    expect(d3d12Res.backend).toBe('d3dmetal');
  });

  it('R2-8: F6/F7 hardening — leading-hyphen slugs, x64 wizard ensure_bottle guard, win64 bottle runnerType, cxbottle host fallback isolation, and NUL/INI sanitization', async () => {
    expect(uninstallSafety.isSafeBottleSlug('-bad')).toBe(false);
    expect(uninstallSafety.isSafeBottleSlug(' -bad')).toBe(false);
    expect(uninstallSafety.isSafeBottleSlug('-')).toBe(false);
    expect(engineStateRegistry.safeIsBottleSlug('-bad')).toBe(false);
    expect(uninstallSafety.isSafeBottleSlug('OneLauncher-arm64')).toBe(true);

    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });

    // x64 ensure_bottle via wizardState.preferredRunnerType=crossover_preview_arm64 (omitted task.runnerType) must fail without invoking cxbottle
    environmentHealthProber.saveSetupWizardState(
      { preferredRunnerType: 'crossover_preview_arm64' },
      { userDataDir }
    );
    const x64CxbottleSpy = vi.fn();
    const x64WizardBottleRes = await environmentProvisioner.runEnvironmentSetupTasks(
      { tasks: [{ componentId: 'bottle_default', action: 'ensure_bottle' }] },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        execFileFn: (...args: any[]) => {
          x64CxbottleSpy(...args);
        },
      }
    );
    expect(x64WizardBottleRes.outcomes[0]?.status).toBe('failed');
    expect(String(x64WizardBottleRes.outcomes[0]?.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    expect(x64CxbottleSpy).not.toHaveBeenCalled();

    // Coexisting win64 OneLauncher + arm64 OneLauncher-arm64 in CrossOver/Bottles never labels OneLauncher as crossover_preview_arm64
    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    seedSyntheticBottle(sharedBottles, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });
    seedSyntheticBottle(sharedBottles, 'OneLauncher-arm64', { wineArch: 'arm64', previewEnabled: true });
    const snap = await environmentHealthProber.probeEnvironmentHealth({
      platform: 'darwin',
      arch: 'arm64',
      homedir: home,
      userDataDir,
      customApplicationsDir: appsDir,
      applicationsDirs: [appsDir],
      skipNetwork: true,
      execFileSyncFn: () => {},
    });
    const oneLauncherBottle = snap.bottleSummary.availableBottles.find(
      (b: any) => b.name === 'OneLauncher'
    );
    expect(oneLauncherBottle).toBeDefined();
    expect(oneLauncherBottle.wineArch).toBe('win64');
    expect(oneLauncherBottle.runnerType).not.toBe('crossover_preview_arm64');

    // Isolated cxbottle check must NOT fall back to host /Applications/.../cxbottle when bundle lacks cxbottle
    fs.rmSync(path.join(armApp.cxRoot, 'bin/cxbottle'), { force: true });
    await expect(
      macNativeInstaller.ensureCompatibilityLayerReady(
        {
          type: 'crossover_preview_arm64',
          appPath: armApp.appPath,
          binaryPath: armApp.wineBin,
          bottlesDir: path.join(home, 'isolated_bottles'),
        },
        { wineBottleName: 'OneLauncher-arm64' },
        {},
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          execFileFn: (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) =>
            cb(null),
        }
      )
    ).rejects.toThrow(/cxbottle CLI not found/i);

    // NUL byte stripping, indented OneLauncherManagedPreview removal, and FEX_* INI sanitization
    const nulConfBottle = path.join(home, 'nul_conf_bottle');
    fs.mkdirSync(nulConfBottle, { recursive: true });
    const confPath = path.join(nulConfBottle, 'cxbottle.conf');
    fs.writeFileSync(
      confPath,
      '\0[Bottle]\n"WineArch" = "arm64"\n"Preview" = "0"\n  "OneLauncherManagedPreview" = "1"\n',
      'utf8'
    );
    macNativeInstaller.applyCrossOverPerGameSettings(
      { type: 'crossover_preview_arm64' },
      {
        environmentVariables: {
          FEX_TSOENABLED: '1"\n"INJECTED" = "evil',
        },
      },
      {},
      nulConfBottle,
      { platform: 'darwin', arch: 'arm64', homedir: home }
    );
    const cleanedConf = fs.readFileSync(confPath, 'utf8');
    expect(cleanedConf.match(/\[Bottle\]/g)).toHaveLength(1);
    expect(cleanedConf).toContain('"Preview" = "1"');
    expect(cleanedConf).not.toContain('OneLauncherManagedPreview');
    expect(cleanedConf).not.toMatch(/^\s*"INJECTED"/m);
    expect(cleanedConf).toContain('"FEX_TSOENABLED" = "1INJECTED = evil"');
    expect(cleanedConf).not.toContain('\0');
  });

  it('R3-1: runEnvironmentSetupTasks (bottle_steam, bottle_gog, bottle_epic) fails fast on explicit win64 bottle under crossover_preview_arm64 (both present and absent client) and rejects x64 / bad slugs', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');

    // Bottle 1: win64 OneLauncher with steam.exe, GalaxyClient.exe, EpicGamesLauncher.exe already present
    const win64Present = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });
    fs.mkdirSync(path.join(win64Present, 'drive_c/Program Files (x86)/Steam'), { recursive: true });
    fs.writeFileSync(
      path.join(win64Present, 'drive_c/Program Files (x86)/Steam/steam.exe'),
      'MZ'
    );
    fs.mkdirSync(path.join(win64Present, 'drive_c/Program Files (x86)/GOG Galaxy'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(win64Present, 'drive_c/Program Files (x86)/GOG Galaxy/GalaxyClient.exe'),
      'MZ'
    );
    fs.mkdirSync(
      path.join(
        win64Present,
        'drive_c/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64'
      ),
      { recursive: true }
    );
    fs.writeFileSync(
      path.join(
        win64Present,
        'drive_c/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe'
      ),
      'MZ'
    );

    // Bottle 2: win64 EmptyWin64 with NO client exe present
    seedSyntheticBottle(sharedBottles, 'EmptyWin64', {
      wineArch: 'win64',
      previewEnabled: true,
    });

    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });
    const spawnSpy = vi.fn((_cmd?: any, _args?: any, _opts?: any) => {
      const child = new EventEmitter() as any;
      child.pid = 94001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    for (const componentId of ['bottle_steam', 'bottle_gog', 'bottle_epic'] as const) {
      for (const bottleName of ['OneLauncher', 'EmptyWin64']) {
        const res = await environmentProvisioner.runEnvironmentSetupTasks(
          {
            tasks: [
              {
                componentId,
                action: 'install_client',
                runnerType: 'crossover_preview_arm64',
                bottleName,
              },
            ],
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir: home,
            userDataDir,
            customApplicationsDir: appsDir,
            applicationsDirs: [appsDir],
            skipNetwork: true,
            fetchFn: fetchSpy,
            spawnFn: spawnSpy,
          }
        );
        expect(res.success).toBe(false);
        expect(res.outcomes[0]?.status).toBe('failed');
        expect(String(res.outcomes[0]?.error || '')).toMatch(/WineArch="win64".*incompatible/i);
      }

      // Invalid leading-hyphen slug fails fast
      const badSlugRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId,
              action: 'install_client',
              runnerType: 'crossover_preview_arm64',
              bottleName: '-bad',
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      );
      expect(badSlugRes.success).toBe(false);
      expect(badSlugRes.outcomes[0]?.status).toBe('failed');
      expect(String(badSlugRes.outcomes[0]?.error || '')).toMatch(/Invalid bottle name/i);

      // Intel x64 fails fast for crossover_preview_arm64
      const x64Res = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId,
              action: 'install_client',
              runnerType: 'crossover_preview_arm64',
              bottleName: 'OneLauncher-arm64',
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      );
      expect(x64Res.success).toBe(false);
      expect(x64Res.outcomes[0]?.status).toBe('failed');
      expect(String(x64Res.outcomes[0]?.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    }

    // Compatible arm64 bottle with existing steam.exe skips cleanly
    const arm64Bottle = seedSyntheticBottle(sharedBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    fs.mkdirSync(path.join(arm64Bottle, 'drive_c/Program Files (x86)/Steam'), { recursive: true });
    fs.writeFileSync(
      path.join(arm64Bottle, 'drive_c/Program Files (x86)/Steam/steam.exe'),
      'MZ'
    );
    const arm64SkipRes = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        tasks: [
          {
            componentId: 'bottle_steam',
            action: 'install_client',
            runnerType: 'crossover_preview_arm64',
            bottleName: 'OneLauncher-arm64',
          },
        ],
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipNetwork: true,
      }
    );
    expect(arm64SkipRes.success).toBe(true);
    expect(arm64SkipRes.outcomes[0]?.status).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(armApp.appPath).toBeTruthy();
  });

  it('R3-2: ensureChainedPublisherLauncherInstalled fast precheck rejects win64 bottle under crossover_preview_arm64 and rejects crossover_preview_arm64 on x64', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    const win64Bottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });
    const eaDir = path.join(
      win64Bottle,
      'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop'
    );
    fs.mkdirSync(eaDir, { recursive: true });
    fs.writeFileSync(path.join(eaDir, 'EADesktop.exe'), buildSyntheticPe(0x8664));

    const arm64Layer = {
      type: 'crossover_preview_arm64',
      appPath: armApp.appPath,
      binaryPath: armApp.wineBin,
      bottlesDir: sharedBottles,
      availableBottles: ['OneLauncher', 'OneLauncher-arm64'],
    };

    // Fast precheck must reject explicit win64 OneLauncher with EADesktop.exe present
    await expect(
      environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          runnerLayer: arm64Layer,
          bottleName: 'OneLauncher',
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      )
    ).rejects.toThrow(/WineArch="win64".*incompatible/i);

    // Explicit bottlePath to win64 bottle with crossover_preview_arm64 runnerLayer also rejects
    await expect(
      environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          runnerLayer: arm64Layer,
          bottlePath: win64Bottle,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      )
    ).rejects.toThrow(/WineArch="win64".*incompatible/i);

    // On Intel x64, crossover_preview_arm64 rejects cleanly upfront
    await expect(
      environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          runnerLayer: arm64Layer,
          bottleName: 'OneLauncher-arm64',
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      )
    ).rejects.toThrow(/Apple Silicon|unsupported on Intel/i);
  });

  it('R3-3: executeChainedPublisherInstallFlow rejects crossover_preview_arm64 on darwin x64 and legacy 32-bit OpenGL fallback skips available=false arm64 layer', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });

    const ensureSpy = vi.fn(async () => {
      throw new Error('ensureChainedPublisherLauncherInstalled should not be called on x64');
    });
    const x64FlowRes = await downloadQueueCoordinator.installGame(
      {
        gameId: 'ea_r3_x64',
        platformId: 'ea',
        platformGameId: 'r3-game',
        title: 'R3 Chained x64 Test',
        compatibilityLayer: 'crossover_preview_arm64',
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipNetwork: true,
        ensureChainedPublisherLauncherInstalledFn: ensureSpy,
      }
    );
    expect(x64FlowRes.success).toBe(false);
    expect(String(x64FlowRes.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    expect(ensureSpy).not.toHaveBeenCalled();

    const x64LaunchCfgRes = await downloadQueueCoordinator.installGame(
      {
        gameId: 'ea_r3_x64_lc',
        platformId: 'ea',
        platformGameId: 'r3-game-lc',
        title: 'R3 Chained x64 LaunchConfig Test',
        launchConfig: {
          compatibilityLayer: 'crossover_preview_arm64',
        },
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipNetwork: true,
        ensureChainedPublisherLauncherInstalledFn: ensureSpy,
      }
    );
    expect(x64LaunchCfgRes.success).toBe(false);
    expect(String(x64LaunchCfgRes.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    expect(ensureSpy).not.toHaveBeenCalled();

    // Legacy 32-bit OpenGL fallback in launchGame skips crossover_preview_arm64 (available: false) on x64 and uses wine instead
    const wineBin = path.join(appsDir, 'Wine Stable.app/Contents/Resources/wine/bin/wine');
    writeExecutable(wineBin);
    const glGameDir = path.join(home, 'gl32_game');
    fs.mkdirSync(glGameDir, { recursive: true });
    const gl32Exe = path.join(glGameDir, 'legacy_gl32.exe');
    fs.writeFileSync(gl32Exe, buildSyntheticPe(0x014c));

    const spawnedBins: string[] = [];
    const spawnSpy = vi.fn((bin: string) => {
      spawnedBins.push(bin);
      const child = new EventEmitter() as any;
      child.pid = 77777;
      child.kill = vi.fn();
      child.unref = vi.fn();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    const glRes = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r3-legacy-gl32-x64',
        platformId: 'custom',
        title: 'LegacyGL32',
        installPath: glGameDir,
        executablePath: gl32Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'wine',
        },
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(glRes.success).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnedBins[0]).not.toContain('CrossOver Preview arm64');
    engineStateRegistry.activeSessions?.clear?.();
    engineStateRegistry.pendingBottleLaunches?.clear?.();
  });

  it('R4-1: Steam win-compat installGame and ensureCompatibilityLayerReady reject crossover_preview_arm64 / runner_crossover_preview_arm64 on darwin x64 and missing arm64 layer', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    const armBottlesDir = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    const armBottle = seedSyntheticBottle(armBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    const steamExeDir = path.join(armBottle, 'drive_c/Program Files (x86)/Steam');
    fs.mkdirSync(steamExeDir, { recursive: true });
    fs.writeFileSync(path.join(steamExeDir, 'steam.exe'), buildSyntheticPe(0x014c));

    const spawnSpy = vi.fn((_cmd?: any, _args?: any, _opts?: any) => {
      const child = new EventEmitter() as any;
      child.pid = 94001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });
    const openExternalSpy = vi.fn();

    for (const compatLayer of ['crossover_preview_arm64', 'runner_crossover_preview_arm64']) {
      const res = await downloadQueueCoordinator.installGame(
        {
          gameId: `steam_r4_${compatLayer}`,
          platformId: 'steam',
          platformGameId: 'steam-999',
          steamAppId: 999,
          title: 'R4 Steam Win Compat',
          os: 'windows',
          installerId: 'steam-win-compat',
          compatibilityLayer: compatLayer,
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
          disableSteamMonitor: true,
          spawnFn: spawnSpy,
          onOpenExternal: openExternalSpy,
        }
      );
      expect(res.success).toBe(false);
      expect(String(res.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    }

    // Even when omitted (auto), x64 with ONLY CrossOver Preview arm64.app installed must not spawn it
    const autoOnlyArm64OnX64 = await downloadQueueCoordinator.installGame(
      {
        gameId: 'steam_r4_auto_x64',
        platformId: 'steam',
        platformGameId: 'steam-998',
        steamAppId: 998,
        title: 'R4 Steam Auto x64',
        os: 'windows',
        installerId: 'steam-win-compat',
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipNetwork: true,
        disableSteamMonitor: true,
        spawnFn: spawnSpy,
        onOpenExternal: openExternalSpy,
      }
    );
    expect(autoOnlyArm64OnX64.success).toBe(false);
    expect(String(autoOnlyArm64OnX64.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(openExternalSpy).not.toHaveBeenCalled();

    // Missing requested crossover_preview_arm64 on arm64 (when only CrossOver.app exists) fails fast
    const stdOnlyAppsDir = path.join(home, 'StdOnlyApplications');
    seedSyntheticCrossOverApp(stdOnlyAppsDir, { branch: 'stable' });
    const missingArm64Res = await downloadQueueCoordinator.installGame(
      {
        gameId: 'steam_r4_missing_arm64',
        platformId: 'steam',
        platformGameId: 'steam-997',
        steamAppId: 997,
        title: 'R4 Steam Missing Arm64',
        os: 'windows',
        installerId: 'steam-win-compat',
        compatibilityLayer: 'crossover_preview_arm64',
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: stdOnlyAppsDir,
        applicationsDirs: [stdOnlyAppsDir],
        skipNetwork: true,
        disableSteamMonitor: true,
        spawnFn: spawnSpy,
        onOpenExternal: openExternalSpy,
      }
    );
    expect(missingArm64Res.success).toBe(false);
    expect(String(missingArm64Res.error || '')).toMatch(/not installed/i);
    expect(spawnSpy).not.toHaveBeenCalled();

    // ensureCompatibilityLayerReady also rejects crossover_preview_arm64 on darwin x64 before cxbottle
    const cxbottleSpy = vi.fn();
    await expect(
      macNativeInstaller.ensureCompatibilityLayerReady(
        {
          type: 'crossover_preview_arm64',
          appPath: armApp.appPath,
          binaryPath: armApp.wineBin,
          bottlesDir: armBottlesDir,
          available: false,
        },
        { wineBottleName: 'OneLauncher-arm64' },
        {},
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          execFileFn: cxbottleSpy,
        }
      )
    ).rejects.toThrow(/Apple Silicon|unsupported on Intel/i);
    expect(cxbottleSpy).not.toHaveBeenCalled();
  });

  it('R4-2: ensureChainedPublisherLauncherInstalled propagates x64 wizard error on bottlePath-only call, rejects -bad slug with runnerLayer.binaryPath, and checks WineArch before skipNetwork on forceReinstall', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    const armApp = seedSyntheticCrossOverApp(appsDir, { branch: 'arm64', withD3dMetal: true });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');

    const armBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    const armEaDir = path.join(armBottle, 'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop');
    fs.mkdirSync(armEaDir, { recursive: true });
    fs.writeFileSync(path.join(armEaDir, 'EADesktop.exe'), buildSyntheticPe(0x8664));

    const win64Bottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });
    const winEaDir = path.join(win64Bottle, 'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop');
    fs.mkdirSync(winEaDir, { recursive: true });
    fs.writeFileSync(path.join(winEaDir, 'EADesktop.exe'), buildSyntheticPe(0x8664));

    fs.mkdirSync(userDataDir, { recursive: true });
    environmentHealthProber.saveSetupWizardState(
      { preferredRunnerType: 'crossover_preview_arm64', preferredBottleName: 'OneLauncher-arm64' },
      { userDataDir }
    );

    // 1. bottlePath without runnerLayer on x64 with wizard preferredRunnerType='crossover_preview_arm64' must reject
    await expect(
      environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          bottlePath: armBottle,
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      )
    ).rejects.toThrow(/Apple Silicon|unsupported on Intel/i);

    // 2. Explicit bottleName: '-bad' with runnerLayer.binaryPath present must reject with Invalid bottle name
    const arm64Layer = {
      type: 'crossover_preview_arm64',
      appPath: armApp.appPath,
      binaryPath: armApp.wineBin,
      bottlesDir: sharedBottles,
      availableBottles: ['OneLauncher-arm64'],
    };
    await expect(
      environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          runnerLayer: arm64Layer,
          bottleName: '-bad',
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipNetwork: true,
        }
      )
    ).rejects.toThrow(/Invalid bottle name "-bad"/i);

    // 3. forceReinstall: true + skipNetwork: true still rejects incompatible WineArch before skipNetwork
    await expect(
      environmentProvisioner.ensureChainedPublisherLauncherInstalled(
        {
          handoffId: 'ea',
          platform: 'darwin',
          runnerLayer: arm64Layer,
          bottleName: 'OneLauncher',
          bottlePath: win64Bottle,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          forceReinstall: true,
          skipNetwork: true,
        }
      )
    ).rejects.toThrow(/WineArch="win64".*incompatible/i);
  });

  it('R4-3: executeChainedPublisherInstallFlow normalizes runner_crossover_preview_arm64 and refuses silent CrossOver.app fallback while preserving auto-selection', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDirOnlyCrossOver = path.join(home, 'AppsOnlyCrossOver');
    const crossOverStableApp = seedSyntheticCrossOverApp(appsDirOnlyCrossOver, { branch: 'stable' });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    const intelBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: false,
    });
    const eaDir = path.join(intelBottle, 'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop');
    fs.mkdirSync(eaDir, { recursive: true });
    const eaExe = path.join(eaDir, 'EADesktop.exe');
    fs.writeFileSync(eaExe, buildSyntheticPe(0x8664));

    const ensureSpy = vi.fn(async (_payload?: any, _opts?: any) => ({
      installed: true,
      provisionedNow: false,
      binaryPath: eaExe,
      installDir: eaDir,
    }));
    const spawnSpy = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 88888;
      child.kill = vi.fn();
      child.unref = vi.fn();
      return child;
    });

    // 1. runner_crossover_preview_arm64 on darwin x64 fails fast (even when only CrossOver.app exists)
    const x64RunnerIdRes = await downloadQueueCoordinator.installGame(
      {
        gameId: 'ea_r4_runner_id_x64',
        platformId: 'ea',
        platformGameId: 'r4-runner-id-x64',
        title: 'R4 EA Runner ID x64',
        compatibilityLayer: 'runner_crossover_preview_arm64',
      },
      {
        platform: 'darwin',
        arch: 'x64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDirOnlyCrossOver,
        applicationsDirs: [appsDirOnlyCrossOver],
        skipNetwork: true,
        ensureChainedPublisherLauncherInstalledFn: ensureSpy,
        spawnFn: spawnSpy,
      }
    );
    expect(x64RunnerIdRes.success).toBe(false);
    expect(String(x64RunnerIdRes.error || '')).toMatch(/Apple Silicon|unsupported on Intel/i);
    expect(ensureSpy).not.toHaveBeenCalled();

    // 2. Explicit crossover_preview_arm64 on arm64 with only CrossOver.app installed fails fast (no silent CrossOver.app fallback)
    for (const explicitArm64 of ['crossover_preview_arm64', 'runner_crossover_preview_arm64']) {
      const missingRes = await downloadQueueCoordinator.installGame(
        {
          gameId: `ea_r4_missing_${explicitArm64}`,
          platformId: 'ea',
          platformGameId: `r4-missing-${explicitArm64}`,
          title: 'R4 EA Missing Arm64',
          compatibilityLayer: explicitArm64,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDirOnlyCrossOver,
          applicationsDirs: [appsDirOnlyCrossOver],
          skipNetwork: true,
          ensureChainedPublisherLauncherInstalledFn: ensureSpy,
          spawnFn: spawnSpy,
        }
      );
      expect(missingRes.success).toBe(false);
      expect(String(missingRes.error || '')).toMatch(/not installed/i);
    }
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();

    // 3. Omitted / 'auto' compatibilityLayer continues auto-selecting installed CrossOver.app cleanly
    const autoRes = await downloadQueueCoordinator.installGame(
      {
        gameId: 'ea_r4_auto_crossover',
        platformId: 'ea',
        platformGameId: 'r4-auto-crossover',
        title: 'R4 EA Auto CrossOver',
        compatibilityLayer: 'auto',
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDirOnlyCrossOver,
        applicationsDirs: [appsDirOnlyCrossOver],
        skipNetwork: true,
        skipInstallMonitor: true,
        ensureChainedPublisherLauncherInstalledFn: ensureSpy,
        spawnFn: spawnSpy,
      }
    );
    expect(autoRes.success).toBe(true);
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    const ensurePayload = ensureSpy.mock.calls[0]?.[0];
    expect(ensurePayload?.runnerLayer?.type).toBe('crossover');
    expect(ensurePayload?.runnerLayer?.appPath).toBe(crossOverStableApp.appPath);
    expect(String(ensurePayload?.runnerLayer?.appPath || '')).toContain('CrossOver.app');
    expect(String(ensurePayload?.runnerLayer?.appPath || '')).not.toContain('CrossOver Preview.app');
    expect(ensurePayload?.runnerLayer?.binaryPath).toBe(crossOverStableApp.wineBin);
    expect(String(ensurePayload?.runnerLayer?.binaryPath || '')).toContain('CrossOver.app');
    expect(String(ensurePayload?.runnerLayer?.binaryPath || '')).not.toContain('CrossOver Preview.app');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('R6-1: post-shutdown applyCrossOverPerGameSettings preserves Preview=1 on shared crossover_preview bottles and updates arm64 cxbottle.conf without throwing', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });
    const armApp = seedSyntheticCrossOverApp(appsDir, {
      branch: 'arm64',
      withArm64LoaderApp: true,
      withArm64Dxmt: true,
      withD3dMetal: true,
    });

    // 1. Standard crossover_preview sharing CrossOver/Bottles/OneLauncher must retain Preview=1 after post-shutdown applyCrossOverPerGameSettings
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    const sharedIntelBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: true,
    });
    const gameDir = path.join(home, 'Games/R6PostShutdown');
    fs.mkdirSync(gameDir, { recursive: true });
    const x64Exe = path.join(gameDir, 'game64.exe');
    fs.writeFileSync(x64Exe, buildSyntheticPe(0x8664));

    const spawnSpy = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 91001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    const stdLaunch = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r6-shared-preview-retains-flag',
        platformId: 'custom',
        title: 'R6SharedPreview',
        installPath: gameDir,
        executablePath: x64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
          wineBottleName: 'OneLauncher',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(stdLaunch.success).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const stdConfAfter = fs.readFileSync(path.join(sharedIntelBottle, 'cxbottle.conf'), 'utf8');
    expect(stdConfAfter).toMatch(/"Preview"\s*=\s*"1"/);
    expect(stdConfAfter).toMatch(/"OneLauncherManagedPreview"\s*=\s*"1"/);
    engineStateRegistry.activeSessions?.clear?.();
    engineStateRegistry.pendingBottleLaunches?.clear?.();

    // 2. Arm64 crossover_preview_arm64 post-shutdown applyCrossOverPerGameSettings must NOT throw WineArch="arm64" incompatible with crossover
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    const armBottle = seedSyntheticBottle(armBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    const armConfPath = path.join(armBottle, 'cxbottle.conf');
    // Have wineserver-arm64 strip CX_GRAPHICS_BACKEND during shutdownWinePrefix so only a working post-shutdown applyCrossOverPerGameSettings can re-stamp it
    writeExecutable(
      path.join(armApp.cxRoot, 'bin/wineserver-arm64'),
      `#!/bin/sh
cat > "${armConfPath}" << 'EOF'
[Bottle]
"WineArch" = "arm64"
"Preview" = "1"
EOF
exit 0
`
    );

    spawnSpy.mockClear();
    const armLaunch = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r6-arm64-post-shutdown-updates-conf',
        platformId: 'custom',
        title: 'R6Arm64PostShutdown',
        installPath: gameDir,
        executablePath: x64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
          crossoverGraphicsBackend: 'dxmt',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(armLaunch.success).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const armConfAfter = fs.readFileSync(armConfPath, 'utf8');
    expect(armConfAfter).toMatch(/"WineArch"\s*=\s*"arm64"/);
    expect(armConfAfter).toMatch(/"Preview"\s*=\s*"1"/);
    expect(armConfAfter).toMatch(/"CX_GRAPHICS_BACKEND"\s*=\s*"dxmt"/);
    engineStateRegistry.activeSessions?.clear?.();
    engineStateRegistry.pendingBottleLaunches?.clear?.();
  });

  it('R6-2: launchGame fails fast with 0 spawns when explicit compatibilityLayer is missing (both direct custom and chained EA), while preserving auto fallback', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsOnlyStable = path.join(home, 'AppsOnlyStable');
    const stableApp = seedSyntheticCrossOverApp(appsOnlyStable, { branch: 'stable' });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    const intelBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: false,
    });
    const eaDir = path.join(intelBottle, 'drive_c/Program Files/Electronic Arts/EA Desktop/EA Desktop');
    fs.mkdirSync(eaDir, { recursive: true });
    fs.writeFileSync(path.join(eaDir, 'EADesktop.exe'), buildSyntheticPe(0x8664));

    const gameDir = path.join(home, 'Games/R6FailFast');
    fs.mkdirSync(gameDir, { recursive: true });
    const x64Exe = path.join(gameDir, 'game64.exe');
    fs.writeFileSync(x64Exe, buildSyntheticPe(0x8664));

    const spawnSpy = vi.fn((_cmd?: any, _args?: any, _opts?: any) => {
      const child = new EventEmitter() as any;
      child.pid = 92001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    for (const explicitMissing of [
      'crossover_preview_arm64',
      'runner_crossover_preview_arm64',
      'crossover_preview',
      'runner_crossover_preview',
      'wine',
    ]) {
      const directMissingRes = await sessionAndProcessSupervisor.launchGame(
        {
          gameId: `r6-direct-missing-${explicitMissing}`,
          platformId: 'custom',
          title: 'R6DirectMissing',
          installPath: gameDir,
          executablePath: x64Exe,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: explicitMissing,
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsOnlyStable,
          applicationsDirs: [appsOnlyStable],
          skipBottleProvisioning: true,
          spawnFn: spawnSpy,
          gameSpawnFn: spawnSpy,
        }
      );
      expect(directMissingRes.success).toBe(false);
      expect(String(directMissingRes.error || '')).toMatch(/not installed|unavailable/i);

      const chainedMissingRes = await sessionAndProcessSupervisor.launchGame(
        {
          gameId: `ea_r6_chained_missing_${explicitMissing}`,
          platformId: 'ea',
          platformGameId: `r6-chained-missing-${explicitMissing}`,
          title: 'R6ChainedMissing',
          compatibilityLayer: explicitMissing,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsOnlyStable,
          applicationsDirs: [appsOnlyStable],
          skipBottleProvisioning: true,
          spawnFn: spawnSpy,
          gameSpawnFn: spawnSpy,
        }
      );
      expect(chainedMissingRes.success).toBe(false);
      expect(String(chainedMissingRes.error || '')).toMatch(/not installed|unavailable/i);
    }
    expect(spawnSpy).not.toHaveBeenCalled();

    // CompatibilityLayer: 'auto' still auto-selects installed CrossOver.app
    const autoRes = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r6-direct-auto-crossover',
        platformId: 'custom',
        title: 'R6DirectAuto',
        installPath: gameDir,
        executablePath: x64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'auto',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsOnlyStable,
        applicationsDirs: [appsOnlyStable],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(autoRes.success).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(String(spawnSpy.mock.calls[0]?.[0] || '')).toBe(stableApp.wineBin);
    engineStateRegistry.activeSessions?.clear?.();
    engineStateRegistry.pendingBottleLaunches?.clear?.();
  });

  it('R6-3: compatibilityLayer: "auto" on Apple Silicon admits 0xaa64 and 0xa641 PEs when crossover_preview_arm64 is auto-selected', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    seedSyntheticCrossOverApp(appsDir, {
      branch: 'arm64',
      withArm64LoaderApp: true,
      withArm64Dxmt: true,
      withD3dMetal: true,
    });
    const armBottles = path.join(home, 'Library/Application Support/CrossOver Preview arm64/Bottles');
    seedSyntheticBottle(armBottles, 'OneLauncher-arm64', { wineArch: 'arm64', previewEnabled: true });

    const gameDir = path.join(home, 'Games/R6AutoArm64Pe');
    fs.mkdirSync(gameDir, { recursive: true });
    const arm64Exe = path.join(gameDir, 'arm64_auto.exe');
    const arm64EcExe = path.join(gameDir, 'arm64ec_auto.exe');
    fs.writeFileSync(arm64Exe, buildSyntheticPe(0xaa64));
    fs.writeFileSync(arm64EcExe, buildSyntheticPe(0xa641));

    const spawnSpy = vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 93001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });

    for (const [label, exePath] of [
      ['0xaa64', arm64Exe],
      ['0xa641', arm64EcExe],
    ]) {
      spawnSpy.mockClear();
      const res = await sessionAndProcessSupervisor.launchGame(
        {
          gameId: `r6-auto-pe-${label}`,
          platformId: 'custom',
          title: `R6AutoPE-${label}`,
          installPath: gameDir,
          executablePath: exePath,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'auto',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
          skipBottleProvisioning: true,
          spawnFn: spawnSpy,
          gameSpawnFn: spawnSpy,
        }
      );
      expect(res.success).toBe(true);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      engineStateRegistry.activeSessions?.clear?.();
      engineStateRegistry.pendingBottleLaunches?.clear?.();
    }
  });

  it('R6-4: recognizes ARM64EC (0xa641) PE across inspectors/win64 gating, rejects empty uninitialized bottle dirs on skipBottleProvisioning, and rejects leading-hyphen slugs in sanitizeBottleNameSlug', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const ecDir = path.join(home, 'Games/R6Arm64Ec');
    fs.mkdirSync(ecDir, { recursive: true });
    const ecExe = path.join(ecDir, 'game_arm64ec.exe');
    const ecBuf = buildSyntheticPe(0xa641);
    fs.writeFileSync(ecExe, ecBuf);

    const ecHeader = binaryAndManifestInspectors.inspectWindowsExecutableHeader(ecExe);
    expect(ecHeader.isValidPe).toBe(true);
    expect(ecHeader.machine).toBe(0xa641);
    expect(ecHeader.machineHex).toBe('0xa641');
    expect(ecHeader.is64Bit).toBe(true);
    expect(ecHeader.isArm64).toBe(true);
    expect(ecHeader.isArm64Ec).toBe(true);
    expect(ecHeader.arch).toBe('arm64ec');

    const ecCaps = binaryAndManifestInspectors.inspectPeCapabilities(ecExe);
    expect(ecCaps.machineArch).toBe('arm64ec');
    expect(ecCaps.is64Bit).toBe(true);
    expect(ecCaps.isArm64).toBe(true);
    expect(ecCaps.isArm64Ec).toBe(true);

    expect(
      binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(ecHeader, {
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        allowArm64Pe: false,
      })
    ).toBe(false);
    expect(
      binaryAndManifestInspectors.isCompatibleX86OrX64PeHeader(ecHeader, {
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        allowArm64Pe: true,
      })
    ).toBe(true);

    const managerPe = wineAndCrossOverManager.inspectPeBinaryImportsSync(ecBuf);
    expect(managerPe.validPe).toBe(true);
    expect(managerPe.rawMachine).toBe(0xa641);
    expect(managerPe.machine).toBe('arm64');

    // Launch rejection on win64 crossover_preview bottle for 0xa641
    const appsDir = path.join(home, 'Applications');
    seedSyntheticCrossOverApp(appsDir, { branch: 'standard', withD3dMetal: true });
    const stdBottles = path.join(home, 'Library/Application Support/CrossOver Preview/Bottles');
    seedSyntheticBottle(stdBottles, 'OneLauncher', { wineArch: 'win64', previewEnabled: true });

    const spawnSpy = vi.fn((_cmd?: any, _args?: any, _opts?: any) => {
      const child = new EventEmitter() as any;
      child.pid = 94001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    });
    const ecWin64Res = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r6-arm64ec-win64-reject',
        platformId: 'custom',
        title: 'R6Arm64EcWin64Reject',
        installPath: ecDir,
        executablePath: ecExe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
          customExecutablePath: ecExe,
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(ecWin64Res.success).toBe(false);
    expect(String(ecWin64Res.error || '')).toMatch(/0xa641|unsupported architecture/i);
    expect(spawnSpy).not.toHaveBeenCalled();

    // Empty uninitialized bottle directory alongside a valid bottle is rejected when skipBottleProvisioning: true
    fs.mkdirSync(path.join(stdBottles, 'EmptyUninitialized'), { recursive: true });
    const x64Exe = path.join(ecDir, 'game_x64.exe');
    fs.writeFileSync(x64Exe, buildSyntheticPe(0x8664));
    const uninitBottleRes = await sessionAndProcessSupervisor.launchGame(
      {
        gameId: 'r6-empty-bottle-dir-reject',
        platformId: 'custom',
        title: 'R6EmptyBottleReject',
        installPath: ecDir,
        executablePath: x64Exe,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview',
          wineBottleName: 'EmptyUninitialized',
        },
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipBottleProvisioning: true,
        spawnFn: spawnSpy,
        gameSpawnFn: spawnSpy,
      }
    );
    expect(uninitBottleRes.success).toBe(false);
    expect(String(uninitBottleRes.error || '')).toMatch(/missing|does not exist|valid bottle/i);
    expect(spawnSpy).not.toHaveBeenCalled();

    // resolveDefaultChainedBottleName (via sanitizeBottleNameSlug) rejects leading-hyphen slugs consistently with safeIsBottleSlug
    expect(
      chainedPublisherLaunchers.resolveDefaultChainedBottleName({
        explicitBottleName: '--winearch=win64',
        runnerType: 'crossover_preview_arm64',
      })
    ).toBe('OneLauncher-arm64');
    expect(
      chainedPublisherLaunchers.resolveDefaultChainedBottleName({
        explicitBottleName: '-bad',
        runnerType: 'crossover_preview',
      })
    ).toBe('OneLauncher');
    expect(
      chainedPublisherLaunchers.resolveDefaultChainedBottleName({
        explicitBottleName: 'OneLauncher-arm64',
        runnerType: 'crossover_preview_arm64',
      })
    ).toBe('OneLauncher-arm64');
  });

  it('R7-1: environmentProvisioner normalizes runner_crossover_preview_arm64, auto, and native across runEnvironmentSetupTasks (ensure_bottle, install_client, install_runner) and fails fast on missing/x64', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsWithArm64 = path.join(home, 'AppsWithArm64');
    const armApp = seedSyntheticCrossOverApp(appsWithArm64, {
      branch: 'arm64',
      withD3dMetal: true,
    });
    const armBottlesDir = path.join(
      home,
      'Library/Application Support/CrossOver Preview arm64/Bottles'
    );
    const arm64Bottle = seedSyntheticBottle(armBottlesDir, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    fs.mkdirSync(path.join(arm64Bottle, 'drive_c/Program Files (x86)/Steam'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(arm64Bottle, 'drive_c/Program Files (x86)/Steam/steam.exe'),
      'MZ'
    );

    const execCxbottleSpy = vi.fn(
      (
        _bin: string,
        _args: string[],
        _opts: any,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void
      ) => cb(null, '', '')
    );

    // 1. ensure_bottle and install_client (bottle_steam) succeed with 'runner_crossover_preview_arm64', 'auto', and 'native'
    for (const runnerInput of ['runner_crossover_preview_arm64', 'auto', 'native']) {
      const bottleRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'bottle_default',
              action: 'ensure_bottle',
              runnerType: runnerInput as any,
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsWithArm64,
          applicationsDirs: [appsWithArm64],
          skipNetwork: true,
          execFileFn: execCxbottleSpy,
        }
      );
      expect(bottleRes.success).toBe(true);
      expect(bottleRes.outcomes[0]?.status).toBe('completed');
      expect(bottleRes.outcomes[0]?.installedPath).toBe(arm64Bottle);

      const steamClientRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'bottle_steam',
              action: 'install_client',
              runnerType: runnerInput as any,
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsWithArm64,
          applicationsDirs: [appsWithArm64],
          skipNetwork: true,
        }
      );
      expect(steamClientRes.success).toBe(true);
      expect(steamClientRes.outcomes[0]?.status).toBe('skipped');
      expect(steamClientRes.outcomes[0]?.installedPath).toContain('steam.exe');
    }

    // 2. Fail-fast when explicit crossover_preview_arm64 / runner_crossover_preview_arm64 is missing (only CrossOver.app installed)
    const appsOnlyStable = path.join(home, 'AppsOnlyStable');
    seedSyntheticCrossOverApp(appsOnlyStable, { branch: 'stable' });
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    const intelBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: false,
    });
    fs.mkdirSync(path.join(intelBottle, 'drive_c/Program Files (x86)/Steam'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(intelBottle, 'drive_c/Program Files (x86)/Steam/steam.exe'),
      'MZ'
    );

    for (const missingRunner of ['crossover_preview_arm64', 'runner_crossover_preview_arm64']) {
      const missingBottleRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'bottle_default',
              action: 'ensure_bottle',
              runnerType: missingRunner as any,
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsOnlyStable,
          applicationsDirs: [appsOnlyStable],
          skipNetwork: true,
        }
      );
      expect(missingBottleRes.success).toBe(false);
      expect(missingBottleRes.outcomes[0]?.status).toBe('failed');
      expect(String(missingBottleRes.outcomes[0]?.error || '')).toMatch(/not installed/i);

      const missingClientRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'bottle_steam',
              action: 'install_client',
              runnerType: missingRunner as any,
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsOnlyStable,
          applicationsDirs: [appsOnlyStable],
          skipNetwork: true,
        }
      );
      expect(missingClientRes.success).toBe(false);
      expect(missingClientRes.outcomes[0]?.status).toBe('failed');
      expect(String(missingClientRes.outcomes[0]?.error || '')).toMatch(/not installed/i);
    }

    // 3. With 0 runners installed on darwin x64, install_runner and ensure_bottle with 'runner_crossover_preview_arm64' reject with Apple Silicon diagnostic
    const emptyApps = path.join(home, 'EmptyApps');
    fs.mkdirSync(emptyApps, { recursive: true });
    const progressEvents: any[] = [];
    const unsub = environmentProvisioner.onEnvironmentSetupProgress((ev: any) => {
      progressEvents.push(ev);
    });
    try {
      const x64InstallRunnerRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'runner_crossover_preview_arm64',
              action: 'install_runner',
              runnerType: 'runner_crossover_preview_arm64' as any,
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: emptyApps,
          applicationsDirs: [emptyApps],
          skipNetwork: true,
        }
      );
      expect(x64InstallRunnerRes.success).toBe(false);
      expect(x64InstallRunnerRes.outcomes[0]?.componentId).toBe('runner_crossover_preview_arm64');
      expect(x64InstallRunnerRes.outcomes[0]?.status).toBe('failed');
      expect(String(x64InstallRunnerRes.outcomes[0]?.error || '')).toMatch(
        /Apple Silicon|arm64/i
      );
      expect(
        progressEvents.some(
          (e) =>
            e.componentId === 'runner_crossover_preview_arm64' &&
            e.phase === 'failed' &&
            /Apple Silicon|arm64/i.test(String(e.error || ''))
        )
      ).toBe(true);

      const x64ZeroRunnerBottleRes = await environmentProvisioner.runEnvironmentSetupTasks(
        {
          tasks: [
            {
              componentId: 'bottle_default',
              action: 'ensure_bottle',
              runnerType: 'runner_crossover_preview_arm64' as any,
            },
          ],
        },
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: emptyApps,
          applicationsDirs: [emptyApps],
          skipNetwork: true,
        }
      );
      expect(x64ZeroRunnerBottleRes.success).toBe(false);
      expect(x64ZeroRunnerBottleRes.outcomes[0]?.status).toBe('failed');
      expect(String(x64ZeroRunnerBottleRes.outcomes[0]?.error || '')).toMatch(
        /Apple Silicon|arm64/i
      );
    } finally {
      unsub();
    }
    expect(armApp.appPath).toBeTruthy();
  });

  it('R7-2: installRunnerDirect and startGuidedClientLogin normalize runner_crossover_preview_arm64, auto, and native', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'userData');
    const appsDir = path.join(home, 'Applications');
    const stableApp = seedSyntheticCrossOverApp(appsDir, { branch: 'stable' });
    const armApp = seedSyntheticCrossOverApp(appsDir, {
      branch: 'arm64',
      buildTimestamp: '20261111',
      withD3dMetal: true,
    });

    // 1. resolveCodeWeaversRunnerSpec('runner_crossover_preview_arm64') resolves canonical arm64 spec
    const runnerSpec = environmentProvisioner.resolveCodeWeaversRunnerSpec(
      'runner_crossover_preview_arm64'
    );
    expect(runnerSpec).toEqual({
      runnerType: 'crossover_preview_arm64',
      canonicalAppName: 'CrossOver Preview arm64.app',
      displayLabel: 'CrossOver Preview (Arm64)',
      componentId: 'runner_crossover_preview_arm64',
      previewBranch: 'arm64',
    });

    // 2. installRunnerDirect rejects '', 'auto', 'native' cleanly
    for (const nonConcrete of ['', 'auto', 'native']) {
      await expect(
        environmentProvisioner.installRunnerDirect(nonConcrete, {
          platform: 'darwin',
          arch: 'arm64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
        })
      ).rejects.toThrow(/Unsupported compatibility runner type/i);
    }

    // 3. installRunnerDirect('runner_crossover_preview_arm64') on x64 rejects with Apple Silicon diagnostic + componentId
    const x64Events: any[] = [];
    const unsubX64 = environmentProvisioner.onEnvironmentSetupProgress((ev: any) => {
      x64Events.push(ev);
    });
    try {
      const x64DirectRes = await environmentProvisioner.installRunnerDirect(
        'runner_crossover_preview_arm64',
        {
          platform: 'darwin',
          arch: 'x64',
          homedir: home,
          userDataDir,
          customApplicationsDir: appsDir,
          applicationsDirs: [appsDir],
        }
      );
      expect(x64DirectRes.success).toBe(false);
      expect(String(x64DirectRes.error || '')).toMatch(/Apple Silicon|arm64/i);
      expect(
        x64Events.some(
          (e) => e.componentId === 'runner_crossover_preview_arm64' && e.phase === 'failed'
        )
      ).toBe(true);
    } finally {
      unsubX64();
    }

    // 4. installRunnerDirect('runner_crossover_preview_arm64') on arm64 normalizes effectiveRunnerType, componentId, existingLayer, and isPreviewRunner
    let capturedMockEffType = '';
    let capturedMockOpts: any = null;
    const directMockRes = await environmentProvisioner.installRunnerDirect(
      'runner_crossover_preview_arm64',
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        authenticateOnly: true,
        mockDirectDownload: async (effType: string, opts: any) => {
          capturedMockEffType = effType;
          capturedMockOpts = opts;
          return { success: true, installed: true, message: 'mocked' };
        },
      }
    );
    expect(directMockRes.success).toBe(true);
    expect(capturedMockEffType).toBe('crossover_preview_arm64');
    expect(capturedMockOpts?.requestedRunnerType).toBe('crossover_preview_arm64');
    expect(capturedMockOpts?.componentId).toBe('runner_crossover_preview_arm64');
    expect(capturedMockOpts?.existingLayer?.type).toBe('crossover_preview_arm64');
    expect(capturedMockOpts?.existingLayer?.appPath).toBe(armApp.appPath);

    // Also verify isPreviewRunner=true routes into the Preview portal branch (not cxmac.xml)
    const openedUrls: string[] = [];
    const previewBranchRes = await environmentProvisioner.installRunnerDirect(
      'runner_crossover_preview_arm64',
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        skipNetwork: true,
        authenticateOnly: true,
        openExternalFn: async (u: string) => {
          openedUrls.push(u);
          return true;
        },
      }
    );
    expect(previewBranchRes.success).toBe(true);
    expect(previewBranchRes.openedExternal).toBe(true);
    expect(openedUrls[0]).toBe('https://www.codeweavers.com/preview/download');

    // 5. startGuidedClientLogin with 'runner_crossover_preview_arm64' picks armApp (even when CrossOver.app is first) and 'auto' auto-selects cleanly
    const loginUsersVdf =
      '"users"\n{\n\t"76561198000000001"\n\t{\n\t\t"AccountName"\t\t"testuser"\n\t\t"PersonaName"\t\t"TestUser"\n\t\t"RememberPassword"\t\t"1"\n\t\t"MostRecent"\t\t"1"\n\t}\n}\n';
    const sharedBottles = path.join(home, 'Library/Application Support/CrossOver/Bottles');
    const intelBottle = seedSyntheticBottle(sharedBottles, 'OneLauncher', {
      wineArch: 'win64',
      previewEnabled: false,
    });
    fs.mkdirSync(path.join(intelBottle, 'drive_c/Program Files (x86)/Steam/config'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(intelBottle, 'drive_c/Program Files (x86)/Steam/steam.exe'),
      'MZ'
    );
    fs.writeFileSync(
      path.join(intelBottle, 'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'),
      loginUsersVdf,
      'utf8'
    );

    const armBottles = path.join(
      home,
      'Library/Application Support/CrossOver Preview arm64/Bottles'
    );
    const armBottle = seedSyntheticBottle(armBottles, 'OneLauncher-arm64', {
      wineArch: 'arm64',
      previewEnabled: true,
    });
    fs.mkdirSync(path.join(armBottle, 'drive_c/Program Files (x86)/Steam/config'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(armBottle, 'drive_c/Program Files (x86)/Steam/steam.exe'),
      'MZ'
    );
    fs.writeFileSync(
      path.join(armBottle, 'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'),
      loginUsersVdf,
      'utf8'
    );

    const spawnGuidedSpy = vi.fn(async (_ctx?: any) => {});
    const armGuidedRes = await environmentProvisioner.startGuidedClientLogin(
      {
        targetId: 'bottle_steam',
        runnerType: 'runner_crossover_preview_arm64' as any,
        bottleName: 'OneLauncher-arm64',
        forceInteractiveLogin: true,
        timeoutMs: 250,
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        connectedStorefronts: ['steam'],
        savedTokens: { steam: { steamId: '76561198000000001' } },
        spawnClientFn: spawnGuidedSpy,
      }
    );
    expect(armGuidedRes.success).toBe(true);
    expect(spawnGuidedSpy).toHaveBeenCalledTimes(1);
    expect((spawnGuidedSpy.mock.calls[0]?.[0] as any)?.bottleLayer?.type).toBe(
      'crossover_preview_arm64'
    );
    expect((spawnGuidedSpy.mock.calls[0]?.[0] as any)?.bottleLayer?.appPath).toBe(armApp.appPath);

    spawnGuidedSpy.mockClear();
    const autoGuidedRes = await environmentProvisioner.startGuidedClientLogin(
      {
        targetId: 'bottle_steam',
        runnerType: 'auto' as any,
        forceInteractiveLogin: true,
        timeoutMs: 250,
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        connectedStorefronts: ['steam'],
        savedTokens: { steam: { steamId: '76561198000000001' } },
        spawnClientFn: spawnGuidedSpy,
      }
    );
    expect(autoGuidedRes.success).toBe(true);
    expect(spawnGuidedSpy).toHaveBeenCalledTimes(1);
    expect((spawnGuidedSpy.mock.calls[0]?.[0] as any)?.bottleLayer?.binaryPath).toBeTruthy();

    // Missing explicit runner in startGuidedClientLogin fails fast on arm64 (even when CrossOver.app exists)
    const guidedMissingRes = await environmentProvisioner.startGuidedClientLogin(
      {
        targetId: 'bottle_steam',
        runnerType: 'runner_wine' as any,
        forceInteractiveLogin: true,
        timeoutMs: 250,
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: home,
        userDataDir,
        customApplicationsDir: appsDir,
        applicationsDirs: [appsDir],
        connectedStorefronts: ['steam'],
        savedTokens: { steam: { steamId: '76561198000000001' } },
        spawnClientFn: spawnGuidedSpy,
      }
    );
    expect(guidedMissingRes.success).toBe(false);
    expect(String(guidedMissingRes.error || '')).toMatch(/not installed/i);
    expect(stableApp.appPath).toBeTruthy();
  });
});
