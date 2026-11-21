import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const launcherEngine = require('../electron/launcherEngine.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');
const bottleDisplayController = require('../electron/launcher/supervisor/bottleDisplayAndEnvController.cjs');
const chainedSpecBuilder = require('../electron/launcher/publishers/chainedLaunchSpecBuilder.cjs');
const chainedPublisherLauncher = require('../electron/launcher/supervisor/chainedPublisherLauncher.cjs');
const compatRegistry = require('../electron/launcher/mac/compatLayerRegistryAndDetection.cjs');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildMinimalPeBuffer(machine: 0x014c | 0x8664 = 0x8664): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(machine, 0x84);
  buf.writeUInt16LE(1, 0x86); // NumberOfSections
  buf.writeUInt16LE(machine === 0x8664 ? 0xf0 : 0xe0, 0x94); // SizeOfOptionalHeader
  buf.writeUInt16LE(0x0002, 0x96); // Characteristics (EXECUTABLE_IMAGE)
  buf.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 0x98); // OptionalHeader Magic
  return buf;
}

function createFakeChild(pid = 41234): any {
  const child: any = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

function createFakeCrossOverApp(appsDir: string, appName: string): { appPath: string; wineBin: string; wineserverBin: string } {
  const appPath = path.join(appsDir, appName);
  const cxRoot = path.join(appPath, 'Contents', 'SharedSupport', 'CrossOver');
  const binDir = path.join(cxRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wineBin = path.join(binDir, 'wine');
  const wineserverBin = path.join(binDir, 'wineserver');
  fs.writeFileSync(
    wineBin,
    '#!/usr/bin/perl\n# synthetic CrossOver wine wrapper with --wait-children and CXOpts\nexit 0;\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(wineserverBin, '#!/bin/sh\nexit 0;\n', { mode: 0o755 });
  if (/arm64/i.test(appName)) {
    fs.writeFileSync(path.join(binDir, 'wineserver-arm64'), '#!/bin/sh\nexit 0;\n', {
      mode: 0o755,
    });
    const aarch64Dir = path.join(cxRoot, 'lib', 'wine', 'aarch64-unix');
    fs.mkdirSync(aarch64Dir, { recursive: true });
    fs.writeFileSync(path.join(aarch64Dir, 'ntdll.so'), 'ELF-fake-arm64', 'utf8');
  }
  return { appPath, wineBin, wineserverBin };
}

function createFakeBottle(
  bottlesDir: string,
  bottleName: string,
  opts: {
    wineArch?: 'win64' | 'arm64' | 'win32';
    withSteam?: boolean;
    withGogGalaxy?: boolean;
    steamAppIds?: string[];
    libraryFoldersVdf?: string;
  } = {}
): { bottlePath: string; steamExe: string; steamRoot: string; gogExe: string } {
  const bottlePath = path.join(bottlesDir, bottleName);
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'windows', 'system32'), { recursive: true });
  if (opts.wineArch !== 'win32') {
    fs.mkdirSync(path.join(bottlePath, 'drive_c', 'windows', 'syswow64'), { recursive: true });
  }
  const archVal = opts.wineArch || 'win64';
  fs.writeFileSync(
    path.join(bottlePath, 'cxbottle.conf'),
    `[Bottle]\n"WineArch" = "${archVal}"\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

  const steamRoot = path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam');
  const steamExe = path.join(steamRoot, 'steam.exe');
  if (opts.withSteam) {
    fs.mkdirSync(path.join(steamRoot, 'steamapps', 'common'), { recursive: true });
    fs.mkdirSync(path.join(steamRoot, 'logs'), { recursive: true });
    fs.writeFileSync(steamExe, buildMinimalPeBuffer(0x014c));
    for (const appId of opts.steamAppIds || []) {
      fs.writeFileSync(
        path.join(steamRoot, 'steamapps', `appmanifest_${appId}.acf`),
        `"AppState"\n{\n\t"appid"\t"${appId}"\n\t"name"\t"SynthApp ${appId}"\n}\n`,
        'utf8'
      );
    }
    if (opts.libraryFoldersVdf) {
      fs.writeFileSync(
        path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
        opts.libraryFoldersVdf,
        'utf8'
      );
    }
  }

  const gogExe = path.join(
    bottlePath,
    'drive_c',
    'Program Files (x86)',
    'GOG Galaxy',
    'GalaxyClient.exe'
  );
  if (opts.withGogGalaxy) {
    fs.mkdirSync(path.dirname(gogExe), { recursive: true });
    fs.writeFileSync(gogExe, buildMinimalPeBuffer(0x014c));
  }

  return { bottlePath, steamExe, steamRoot, gogExe };
}

describe('Phase 2 W2: Game Launch Orchestrator & Chained Publisher Specs', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    bottleDisplayController.resetSupervisorStateForTests();
    compatRegistry.invalidateCompatLayerDetectionCache?.();
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.pendingBottleLaunches.clear();
    engineStateRegistry.pendingStorefrontLaunches.clear();
  });

  afterEach(() => {
    for (const [, entry] of Array.from(engineStateRegistry.activeSessions.entries()) as any[]) {
      if (entry?.pollTimer) clearInterval(entry.pollTimer);
      if (entry?.displayStatusTimer) clearInterval(entry.displayStatusTimer);
    }
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.pendingBottleLaunches.clear();
    engineStateRegistry.pendingStorefrontLaunches.clear();
    bottleDisplayController.resetSupervisorStateForTests();
    compatRegistry.invalidateCompatLayerDetectionCache?.();
    vi.restoreAllMocks();
    for (const d of tempDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  // =========================================================================
  // 1. Install-Bottle Runner Affinity & Explicit Pin Sovereignty
  // =========================================================================
  describe('1. Install-Bottle Runner Affinity & Explicit Pin Sovereignty', () => {
    it('auto-aligns runner and bottle to a win64 install bottle even when arm64 preview is also installed', async () => {
      const root = makeTempDir('w2-affinity-win64-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      const previewWin64 = createFakeCrossOverApp(appsDir, 'CrossOver Preview.app');
      createFakeCrossOverApp(appsDir, 'CrossOver Preview arm64.app');

      const sharedBottlesDir = path.join(
        homedir,
        'Library/Application Support/CrossOver/Bottles'
      );
      const win64Bottle = createFakeBottle(sharedBottlesDir, 'SynthWin64', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77001'],
      });
      createFakeBottle(sharedBottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: false,
      });

      const gameDir = path.join(
        win64Bottle.steamRoot,
        'steamapps/common/SynthArena'
      );
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'SynthArena.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77001',
          title: 'Synth Arena',
          platformId: 'steam',
          platformGameId: '77001',
          steamAppId: 77001,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          mockProcessListOutput: '',
          gameSpawnFn: (cmd: string, args: string[], opts: any) => {
            spawns.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
            return createFakeChild(51001);
          },
        }
      );

      expect(res.success).toBe(true);
      expect(res.session?.launchMethod).toBe('compatibility_layer:crossover_preview');
      expect(res.session?.winePrefix).toBe(win64Bottle.bottlePath);
      expect(spawns.length).toBe(1);
      expect(spawns[0].cmd).toBe(previewWin64.wineBin);
      expect(spawns[0].env.CX_BOTTLE).toBe('SynthWin64');
      expect(spawns[0].args).toContain('-applaunch');
      expect(spawns[0].args).toContain('77001');
    });

    it('auto-selects crossover_preview_arm64 when game is installed inside an arm64 bottle', async () => {
      const root = makeTempDir('w2-affinity-arm64-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const previewArm64 = createFakeCrossOverApp(appsDir, 'CrossOver Preview arm64.app');

      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      createFakeBottle(bottlesDir, 'OneLauncher', { wineArch: 'win64', withSteam: true });
      const arm64Bottle = createFakeBottle(bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
        steamAppIds: ['77002'],
      });

      const gameDir = path.join(arm64Bottle.steamRoot, 'steamapps/common/ArmTestGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'ArmTest.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77002',
          title: 'Arm Test Game',
          platformId: 'steam',
          platformGameId: '77002',
          steamAppId: 77002,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          mockProcessListOutput: '',
          gameSpawnFn: (cmd: string, args: string[], opts: any) => {
            spawns.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
            return createFakeChild(51002);
          },
        }
      );

      expect(res.success).toBe(true);
      expect(res.session?.launchMethod).toBe('compatibility_layer:crossover_preview_arm64');
      expect(spawns[0].cmd).toBe(previewArm64.wineBin);
      expect(spawns[0].env.CX_BOTTLE).toBe('OneLauncher-arm64');
    });

    it('uses secondary Steam appmanifest affinity for external libraries mounted via libraryfolders.vdf', async () => {
      const root = makeTempDir('w2-affinity-extlib-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      createFakeBottle(bottlesDir, 'OneLauncher', { wineArch: 'win64', withSteam: false });

      const externalLib = path.join(root, 'ExternalSteamLib');
      const extGameDir = path.join(externalLib, 'steamapps', 'common', 'ExternalQuest');
      fs.mkdirSync(extGameDir, { recursive: true });
      const extGameExe = path.join(extGameDir, 'ExternalQuest.exe');
      fs.writeFileSync(extGameExe, buildMinimalPeBuffer(0x8664));
      fs.writeFileSync(
        path.join(externalLib, 'steamapps', 'appmanifest_77003.acf'),
        `"AppState"\n{\n\t"appid"\t"77003"\n}\n`,
        'utf8'
      );

      const zWineExtPath = `Z:\\\\${externalLib.replace(/^\/+/, '').replace(/\//g, '\\\\')}`;
      const mountedBottle = createFakeBottle(bottlesDir, 'MountedSteamBottle', {
        wineArch: 'win64',
        withSteam: true,
        libraryFoldersVdf: `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t"${zWineExtPath}"\n\t}\n}\n`,
      });

      const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77003',
          title: 'External Quest',
          platformId: 'steam',
          platformGameId: '77003',
          steamAppId: 77003,
          installPath: extGameDir,
          executablePath: extGameExe,
          isWindowsBinaryOnMac: true,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          mockProcessListOutput: '',
          gameSpawnFn: (cmd: string, args: string[], opts: any) => {
            spawns.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
            return createFakeChild(51003);
          },
        }
      );

      expect(res.success).toBe(true);
      expect(res.session?.winePrefix).toBe(mountedBottle.bottlePath);
      expect(spawns[0].env.CX_BOTTLE).toBe('MountedSteamBottle');
      expect(spawns[0].args).toContain(mountedBottle.steamExe);
    });

    it('honors explicit preferredType pin strictly and fails closed with BOTTLE_STEAM_NOT_INSTALLED instead of substituting runners', async () => {
      const root = makeTempDir('w2-pin-guard2a-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver Preview.app');
      createFakeCrossOverApp(appsDir, 'CrossOver Preview arm64.app');

      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const win64Bottle = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77004'],
      });
      const arm64Bottle = createFakeBottle(bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: false,
      });

      const gameDir = path.join(win64Bottle.steamRoot, 'steamapps/common/PinnedTitle');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'PinnedTitle.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const spawnSpy = vi.fn(() => createFakeChild(51004));
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77004',
          title: 'Pinned Title',
          platformId: 'steam',
          platformGameId: '77004',
          steamAppId: 77004,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            compatibilityLayer: 'crossover_preview_arm64',
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          gameSpawnFn: spawnSpy,
        }
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('BOTTLE_STEAM_NOT_INSTALLED');
      expect(res.targetBottleName).toBe('OneLauncher-arm64');
      expect(res.targetBottlePath).toBe(arm64Bottle.bottlePath);
      expect(res.installBottleName).toBe('OneLauncher');
      expect(res.installBottleHasSteam).toBe(true);
      expect(res.recommendedRunnerType).toBe('crossover_preview');
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(engineStateRegistry.pendingBottleLaunches.size).toBe(0);
      expect(engineStateRegistry.pendingStorefrontLaunches.size).toBe(0);
    });
  });

  // =========================================================================
  // 2. Guard 2B, customExecutablePath Parity & Bottled storefront_uri Routing
  // =========================================================================
  describe('2. Cross-Bottle Manifest Guard 2B, customExecutablePath Parity & Bottled storefront_uri', () => {
    it('blocks cross-bottle Steam launch with BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE when target bottle lacks appmanifest', async () => {
      const root = makeTempDir('w2-guard2b-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottleA = createFakeBottle(bottlesDir, 'InstallBottleA', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77010'],
      });
      const bottleB = createFakeBottle(bottlesDir, 'TargetBottleB', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: [],
      });

      const gameDir = path.join(bottleA.steamRoot, 'steamapps/common/CrossBottleTitle');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'CrossBottle.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const spawnSpy = vi.fn(() => createFakeChild(51010));
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77010',
          title: 'Cross Bottle Title',
          platformId: 'steam',
          platformGameId: '77010',
          steamAppId: 77010,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            compatibilityLayer: 'crossover',
            wineBottleName: 'TargetBottleB',
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          gameSpawnFn: spawnSpy,
        }
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE');
      expect(res.targetBottleName).toBe('TargetBottleB');
      expect(res.targetBottlePath).toBe(bottleB.bottlePath);
      expect(res.installBottleName).toBe('InstallBottleA');
      expect(res.installBottleHasSteam).toBe(true);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(engineStateRegistry.pendingBottleLaunches.size).toBe(0);
    });

    it('bypasses Bottle Steam when customExecutablePath is set (matching launchPolicyCore parity)', async () => {
      const root = makeTempDir('w2-custom-exe-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottle = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77011'],
      });

      const gameDir = path.join(bottle.steamRoot, 'steamapps/common/ModdedTitle');
      fs.mkdirSync(gameDir, { recursive: true });
      const customExe = path.join(gameDir, 'ModLoader.exe');
      fs.writeFileSync(customExe, buildMinimalPeBuffer(0x8664));

      const spawns: Array<{ cmd: string; args: string[] }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77011',
          title: 'Modded Title',
          platformId: 'steam',
          platformGameId: '77011',
          steamAppId: 77011,
          installPath: gameDir,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            customExecutablePath: customExe,
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          gameSpawnFn: (cmd: string, args: string[]) => {
            spawns.push({ cmd, args: [...args] });
            return createFakeChild(51011);
          },
        }
      );

      expect(res.success).toBe(true);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].args).toContain(customExe);
      expect(spawns[0].args).not.toContain('-applaunch');
    });

    it('routes bottled windows_exe_on_mac Steam storefront_uri into Bottle Steam and NEVER opens host macOS Steam.app', async () => {
      const root = makeTempDir('w2-uri-steam-bottle-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottle = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77012'],
      });
      const gameDir = path.join(bottle.steamRoot, 'steamapps/common/UriBottleGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'UriBottleGame.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const openedUris: string[] = [];
      const spawns: Array<{ cmd: string; args: string[] }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77012',
          title: 'URI Bottle Game',
          platformId: 'steam',
          platformGameId: '77012',
          steamAppId: 77012,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'storefront_uri',
            storefrontClientLifecycle: 'fast_direct_bypass',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          mockProcessListOutput: '',
          onOpenExternal: (u: string) => openedUris.push(u),
          gameSpawnFn: (cmd: string, args: string[]) => {
            spawns.push({ cmd, args: [...args] });
            return createFakeChild(51012);
          },
        }
      );

      expect(res.success).toBe(true);
      expect(openedUris).toEqual([]);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].args).toContain(bottle.steamExe);
      expect(spawns[0].args).toContain('-applaunch');
      expect(spawns[0].args).toContain('77012');
    });

    it('fails closed for bottled windows_exe_on_mac GOG storefront_uri when bottle lacks GalaxyClient.exe', async () => {
      const root = makeTempDir('w2-uri-gog-failclosed-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottle = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withGogGalaxy: false,
      });
      const gameDir = path.join(bottle.bottlePath, 'drive_c/GOG Games/SynthRPG');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'SynthRPG.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const openedUris: string[] = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'gog-1234567890',
          title: 'Synth RPG',
          platformId: 'gog',
          platformGameId: '1234567890',
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'storefront_uri',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          onOpenExternal: (u: string) => openedUris.push(u),
          gameSpawnFn: () => createFakeChild(51013),
        }
      );

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('BOTTLE_GOG_GALAXY_NOT_INSTALLED');
      expect(res.error).toMatch(/GOG Galaxy/i);
      expect(openedUris).toEqual([]);
      expect(engineStateRegistry.pendingBottleLaunches.size).toBe(0);
    });
  });

  // =========================================================================
  // 3. Warm Bottle Steam, Env/DLL Isolation, default_client & 64-bit Watch-Dir
  // =========================================================================
  describe('3. Warm Bottle Steam, Env/DLL Isolation, default_client & 64-bit --watch-dir', () => {
    it('isolates app-local proxy DLL overrides to AppDefaults (NOT steam.exe WINEDLLOVERRIDES) and strips ONLY DISPLAY_SCALER_ENV_KEYS from Stage 1/2 steam.exe', async () => {
      const root = makeTempDir('w2-env-dll-iso-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottle = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77020'],
      });
      // Seed prior cloud_log.txt bytes so Stage 1 completes immediately and Stage 2 snapshots post-Stage-1 offset
      const cloudLogPath = path.join(bottle.steamRoot, 'logs', 'cloud_log.txt');
      fs.writeFileSync(cloudLogPath, '[2026-01-01 00:00:00] Prior session line\n', 'utf8');

      const gameDir = path.join(bottle.steamRoot, 'steamapps/common/ProxyDllGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'ProxyGame.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x014c));
      // Validated x86 app-local proxy DLL in game directory
      fs.writeFileSync(path.join(gameDir, 'd3d9.dll'), buildMinimalPeBuffer(0x014c));

      // Stage synthetic display scaler bin directory for --watch-dir check
      const fakeScalerBinDir = path.join(root, 'scaler-bin');
      fs.mkdirSync(fakeScalerBinDir, { recursive: true });
      for (const fname of [
        'one_display_scaler_x86.dll',
        'one_display_scaler_x64.dll',
        'one_display_launcher_x86.exe',
        'one_display_launcher_x64.exe',
      ]) {
        fs.writeFileSync(path.join(fakeScalerBinDir, fname), buildMinimalPeBuffer(0x8664));
      }

      const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-77020',
          title: 'Proxy DLL Game',
          platformId: 'steam',
          platformGameId: '77020',
          steamAppId: 77020,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            crossoverGraphicsBackend: 'dxvk',
            performanceHud: 'on',
            displayScalingMode: 'force_fullscreen',
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          displayScalerBinDir: fakeScalerBinDir,
          enableDisplayScalerInTests: true,
          enableTwoStageSteamColdStart: true,
          maxStartupCloudWaitMs: 120,
          settleAfterClientSyncMs: 10,
          pollIntervalMs: 10,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          mockProcessListOutput: '',
          gameSpawnFn: (cmd: string, args: string[], opts: any) => {
            spawns.push({ cmd, args: [...args], env: { ...(opts?.env || {}) } });
            // Simulate Stage 1 finishing startup cloud sync right after Stage 1 steam.exe spawns
            if (args.includes(bottle.steamExe) && !args.includes('-applaunch')) {
              fs.appendFileSync(
                cloudLogPath,
                '[2026-01-01 00:00:01] [AppID 77020] Starting sync (eval,)\n[2026-01-01 00:00:02] [AppID 77020] Eval complete\n',
                'utf8'
              );
            }
            return createFakeChild(51020 + spawns.length);
          },
        }
      );

      expect(res.success).toBe(true);
      const stage1Spawn = spawns.find(
        (s) => s.args.includes(bottle.steamExe) && !s.args.includes('-applaunch')
      );
      const stage2Spawn = spawns.find(
        (s) => s.args.includes(bottle.steamExe) && s.args.includes('-applaunch')
      );
      const watchDirSpawn = spawns.find((s) => s.args.includes('--watch-dir'));

      expect(stage1Spawn).toBeDefined();
      expect(stage2Spawn).toBeDefined();
      expect(watchDirSpawn).toBeDefined();

      // App-local d3d9=n,b MUST NOT pollute steam.exe WINEDLLOVERRIDES / --dll
      expect(String(stage1Spawn?.env.WINEDLLOVERRIDES || '')).not.toContain('d3d9');
      expect(String(stage2Spawn?.env.WINEDLLOVERRIDES || '')).not.toContain('d3d9');
      expect(stage1Spawn?.args.join(' ')).not.toContain('d3d9=n,b');
      expect(stage2Spawn?.args.join(' ')).not.toContain('d3d9=n,b');

      // Per-exe AppDefaults IS written in user.reg for ProxyGame.exe
      const userReg = fs.readFileSync(path.join(bottle.bottlePath, 'user.reg'), 'utf8');
      expect(userReg).toContain('AppDefaults\\\\proxygame.exe\\\\DllOverrides');
      expect(userReg).toContain('"d3d9"="native,builtin"');

      // Stage 1 & Stage 2 strip ONLY DISPLAY_SCALER_ENV_KEYS while preserving HUD & backend
      expect(stage1Spawn?.env.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBeUndefined();
      expect(stage2Spawn?.env.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBeUndefined();
      expect(String(stage1Spawn?.env.CX_ENV || '')).not.toContain('ONE_LAUNCHER_DISPLAY_SCALING_MODE');
      expect(stage1Spawn?.env.CX_GRAPHICS_BACKEND).toBe('dxvk');
      expect(Boolean(stage1Spawn?.env.DXVK_HUD || stage1Spawn?.env.MTL_HUD_ENABLED === '1')).toBe(
        true
      );

      // 64-bit bottle prefers launcher_x64 even when launching a 32-bit game stub
      expect(watchDirSpawn?.args.join(' ')).toContain('one_display_launcher_x64.exe');
      expect(watchDirSpawn?.args.join(' ')).not.toContain('one_display_launcher_x86.exe');

      // Session offset snapshotted AFTER Stage 1 appended sync lines
      const entry = engineStateRegistry.activeSessions.get('steam-77020');
      expect(entry?.steamCloudLogSessionStartOffset).toBe(fs.statSync(cloudLogPath).size);
      expect(entry?.isFastDirectBypass).toBe(false);
    });

    it('sends separate steam://open/main IPC ping on warm -silent -> default_client transition and polls steam.exe exit before wineserver -k on contract recycle', async () => {
      const root = makeTempDir('w2-warm-steam-transitions-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      const cx = createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottle = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77021', '77022'],
      });
      const gameDir = path.join(bottle.steamRoot, 'steamapps/common/WarmSteamGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'WarmGame.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      // Part A: Warm -silent -> default_client dispatches separate steam://open/main IPC ping before Stage 2
      bottleDisplayController.setLiveBottleSteamUiMode(bottle.bottlePath, 'silent');
      const eventsA: string[] = [];
      const execFileA = (cmd: string, args: string[], opts: any, cb: Function) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (args.includes('steam://open/main')) {
          eventsA.push(`open_main:${args.join('|')}`);
        }
        callback?.(null, '', '');
      };
      const resA = await launcherEngine.launchGame(
        {
          gameId: 'steam-77021',
          title: 'Warm Game A',
          platformId: 'steam',
          platformGameId: '77021',
          steamAppId: 77021,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            storefrontClientLifecycle: 'default_client',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          mockProcessListOutput: `WINEPREFIX=${bottle.bottlePath} ${cx.wineBin} ${bottle.steamExe} -silent`,
          execFileImpl: execFileA,
          gameSpawnFn: (_cmd: string, args: string[]) => {
            eventsA.push(`stage2:${args.join('|')}`);
            return createFakeChild(51021);
          },
        }
      );

      expect(resA.success).toBe(true);
      expect(eventsA.length).toBe(2);
      expect(eventsA[0]).toContain('open_main:');
      expect(eventsA[0]).toContain('steam://open/main');
      expect(eventsA[0]).not.toContain('-applaunch');
      expect(eventsA[1]).toContain('stage2:');
      expect(eventsA[1]).toContain('-applaunch');
      expect(eventsA[1]).not.toContain('-silent');
      expect(bottleDisplayController.getLiveBottleSteamUiMode(bottle.bottlePath)).toBe('standard');
      engineStateRegistry.activeSessions.clear();

      // Part B: Warm contract mismatch sends -shutdown, polls !isBottleWinExeRunning BEFORE wineserver -k
      const eventsB: string[] = [];
      let steamAlivePolls = 0;
      const execFileB = (cmd: string, args: string[], opts: any, cb: Function) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (args.includes('-shutdown')) {
          eventsB.push('steam_shutdown');
          callback?.(null, '', '');
          return;
        }
        if (cmd.includes('wineserver') && args.includes('-k')) {
          eventsB.push('wineserver_k');
          callback?.(null, '', '');
          return;
        }
        callback?.(null, '', '');
      };
      const resB = await launcherEngine.launchGame(
        {
          gameId: 'steam-77022',
          title: 'Warm Game B',
          platformId: 'steam',
          platformGameId: '77022',
          steamAppId: 77022,
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            crossoverGraphicsBackend: 'd3dmetal',
            environmentVariables: { CUSTOM_SHADERS: 'ultra' },
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          disableBottleSteamPolling: true,
          enableWarmDaemonEnvRecycle: true,
          awaitBottleSteamExitInTest: true,
          bottleSteamShutdownPollMs: 15,
          getProcessListOutput: () => {
            steamAlivePolls += 1;
            eventsB.push(`ps_poll_${steamAlivePolls}`);
            // Initial probe + 1st post-shutdown poll see steam.exe; 2nd post-shutdown poll sees exited
            return steamAlivePolls <= 2
              ? `WINEPREFIX=${bottle.bottlePath} CX_GRAPHICS_BACKEND=dxvk ${bottle.steamExe} -silent`
              : '';
          },
          execFileImpl: execFileB,
          gameSpawnFn: () => {
            eventsB.push('stage2_spawn');
            return createFakeChild(51022);
          },
        }
      );

      expect(resB.success).toBe(true);
      const shutdownIdx = eventsB.indexOf('steam_shutdown');
      const postExitPollIdx = eventsB.indexOf('ps_poll_3');
      const wineserverKIdx = eventsB.indexOf('wineserver_k');
      expect(shutdownIdx).toBeGreaterThan(-1);
      expect(postExitPollIdx).toBeGreaterThan(shutdownIdx);
      expect(wineserverKIdx).toBeGreaterThan(postExitPollIdx);
    });
  });

  // =========================================================================
  // 4. Hardened Bottle Steam Poller, Native macOS Steam & Epic .exe Filter
  // =========================================================================
  describe('4. Hardened Bottle Steam Poller, Native macOS Steam & Epic .exe Filter', () => {
    it('uses ps eww + WINEPREFIX scoping + gameprocess_log.txt dynamic hint discovery (never POSIX-killing Win32 PIDs) + session_updated + consecutive-miss grace', async () => {
      const root = makeTempDir('w2-bottle-poller-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottleA = createFakeBottle(bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        steamAppIds: ['77030'],
      });
      const bottleB = createFakeBottle(bottlesDir, 'OtherBottle', {
        wineArch: 'win64',
        withSteam: true,
      });

      const gameDir = path.join(bottleA.steamRoot, 'steamapps/common/PollerGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const stubExe = path.join(gameDir, 'StubLauncher.exe');
      fs.writeFileSync(stubExe, buildMinimalPeBuffer(0x8664));

      const gpLogPath = path.join(bottleA.steamRoot, 'logs', 'gameprocess_log.txt');
      fs.writeFileSync(gpLogPath, '[old] AppID 77030 adding PID 99999 as a tracked process "C:\\old.exe"\n', 'utf8');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
      const sessionEvents: any[] = [];
      const unsub = launcherEngine.onSessionUpdated((ev: any) => sessionEvents.push(ev));

      let psTick = 0;
      const observedPsArgs: string[][] = [];
      const execFileImpl = (cmd: string, args: string[], opts: any, cb: Function) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'ps') {
          observedPsArgs.push([...args]);
          if (args.includes('pid=,command=')) {
            psTick += 1;
            if (psTick === 1) {
              // Tick 1: Steam already logged dynamic real exe `DynamicRealGame.exe` with Win32 PID 884
              // (never POSIX killed!), another bottle runs `StubLauncher.exe` (ignored by WINEPREFIX filter),
              // and target bottle runs `DynamicRealGame.exe` under real macOS PID 62345.
              callback?.(
                null,
                `61111 StubLauncher.exe WINEPREFIX=${bottleB.bottlePath} HOME=/tmp\n` +
                  `62345 C:\\Game\\DynamicRealGame.exe WINEPREFIX=${bottleA.bottlePath} HOME=/tmp\n`,
                ''
              );
              return;
            }
            if (psTick === 2) {
              // Tick 2: transient miss 1 while Win32 PID 884 is removed -> should NOT finalize yet (threshold=2)
              fs.appendFileSync(gpLogPath, '[now] AppID 77030 removing PID 884\n', 'utf8');
              callback?.(
                null,
                `61111 DynamicRealGame.exe WINEPREFIX=${bottleB.bottlePath} HOME=/tmp\n`,
                ''
              );
              return;
            }
            // Tick 3+: miss 2 -> finalizes cleanly
            callback?.(null, '', '');
            return;
          }
          callback?.(null, '', '');
          return;
        }
        callback?.(null, '', '');
      };

      try {
        const res = await launcherEngine.launchGame(
          {
            gameId: 'steam-77030',
            title: 'Poller Game',
            platformId: 'steam',
            platformGameId: '77030',
            steamAppId: 77030,
            installPath: gameDir,
            executablePath: stubExe,
            isWindowsBinaryOnMac: true,
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            homedir,
            userDataDir,
            customApplicationsDir: appsDir,
            skipRegistrySpawn: true,
            bottleSteamPollIntervalMs: 25,
            bottleSteamExitMissThreshold: 2,
            execFileImpl,
            gameSpawnFn: () => {
              // Simulate Steam launching the real game exe right as Stage 2 triggers
              fs.appendFileSync(
                gpLogPath,
                '[now] AppID 77030 adding PID 884 as a tracked process "C:\\Game\\DynamicRealGame.exe"\n',
                'utf8'
              );
              return createFakeChild(51030);
            },
          }
        );
        expect(res.success).toBe(true);
        expect(res.session?.winePrefix).toBe(bottleA.bottlePath);

        for (let i = 0; i < 60 && engineStateRegistry.activeSessions.has('steam-77030'); i++) {
          await new Promise((r) => setTimeout(r, 25));
        }

        expect(engineStateRegistry.activeSessions.has('steam-77030')).toBe(false);
        expect(psTick).toBeGreaterThanOrEqual(3);
        expect(
          observedPsArgs.some(
            (a) => a[0] === 'eww' && a.includes('-ax') && a.includes('pid=,command=')
          )
        ).toBe(true);
        // Real macOS PID 62345 latched and emitted `session_updated`
        expect(
          sessionEvents.some(
            (e) => e.event === 'session_updated' && e.session?.pid === 62345
          )
        ).toBe(true);
        // Win32 PID 884 or stale 99999 was NEVER passed to process.kill
        const killedPids = killSpy.mock.calls.map((c) => c[0]);
        expect(killedPids).not.toContain(884);
        expect(killedPids).not.toContain(99999);
      } finally {
        unsub();
      }
    });

    it('drops -nofriendsui/-nochatui on native macOS Steam minimal_keep_running, preserves args in default_client, and rejects bottled Epic .exe lines', async () => {
      const root = makeTempDir('w2-native-steam-epic-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      const steamRoot = path.join(homedir, 'Library/Application Support/Steam');
      fs.mkdirSync(path.join(steamRoot, 'logs'), { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });

      const macSteamBin = path.join(appsDir, 'Steam.app/Contents/MacOS/steam_osx');
      fs.mkdirSync(path.dirname(macSteamBin), { recursive: true });
      fs.writeFileSync(macSteamBin, '#!/bin/sh\nexit 0;\n', { mode: 0o755 });

      const cloudLog = path.join(steamRoot, 'logs', 'cloud_log.txt');
      fs.writeFileSync(cloudLog, '[prior] line\n', 'utf8');

      // A) Native macOS Steam minimal_keep_running via /usr/bin/open drops -nofriendsui & -nochatui
      const minimalSpawns: Array<{ cmd: string; args: string[] }> = [];
      const resMin = await launcherEngine.launchGame(
        {
          gameId: 'steam-77040',
          title: 'Native Mac Minimal',
          platformId: 'steam',
          platformGameId: '77040',
          steamAppId: 77040,
          launchConfig: {
            launchMethod: 'storefront_uri',
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          steamRoot,
          steamClientBinaryPath: macSteamBin,
          enableTwoStageSteamColdStart: true,
          forceMacOpenSteamInTest: true,
          maxStartupCloudWaitMs: 60,
          settleAfterClientSyncMs: 5,
          pollIntervalMs: 5,
          disableUriPolling: true,
          mockProcessListOutput: '',
          spawnFn: (cmd: string, args: string[]) => {
            minimalSpawns.push({ cmd, args: [...args] });
            return createFakeChild(51040);
          },
        }
      );
      expect(resMin.success).toBe(true);
      const openStage1 = minimalSpawns.find((s) => s.cmd === '/usr/bin/open');
      expect(openStage1).toBeDefined();
      expect(openStage1?.args).toContain('-silent');
      expect(openStage1?.args).not.toContain('-nofriendsui');
      expect(openStage1?.args).not.toContain('-nochatui');
      expect(engineStateRegistry.activeSessions.get('steam-77040')?.steamCloudLogSessionStartOffset).toBe(
        fs.statSync(cloudLog).size
      );
      engineStateRegistry.activeSessions.clear();

      // B) Native macOS Steam default_client preserves launchArguments via Stage 2 -applaunch <id> ...args
      const defaultSpawns: Array<{ cmd: string; args: string[] }> = [];
      const resDef = await launcherEngine.launchGame(
        {
          gameId: 'steam-77041',
          title: 'Native Mac Default Args',
          platformId: 'steam',
          platformGameId: '77041',
          steamAppId: 77041,
          launchConfig: {
            launchMethod: 'storefront_uri',
            storefrontClientLifecycle: 'default_client',
            launchArguments: '-vulkan -novid',
          },
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          steamRoot,
          steamClientBinaryPath: macSteamBin,
          enableTwoStageSteamColdStart: true,
          maxStartupCloudWaitMs: 60,
          settleAfterClientSyncMs: 5,
          pollIntervalMs: 5,
          disableUriPolling: true,
          mockProcessListOutput: '',
          spawnFn: (cmd: string, args: string[]) => {
            defaultSpawns.push({ cmd, args: [...args] });
            return createFakeChild(51041);
          },
        }
      );
      expect(resDef.success).toBe(true);
      const stage2Def = defaultSpawns.find((s) => s.args.includes('-applaunch'));
      expect(stage2Def?.args).toEqual(['-applaunch', '77041', '-vulkan', '-novid']);
      engineStateRegistry.activeSessions.clear();

      // C) Native macOS Epic storefront_uri rejects bottled EpicGamesLauncher.exe lines
      const resEpic = await launcherEngine.launchGame(
        {
          gameId: 'epic-synth-mac',
          title: 'Native Mac Epic',
          platformId: 'epic',
          platformGameId: 'synth-mac',
          launchConfig: { launchMethod: 'storefront_uri' },
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          disableUriPolling: true,
          onOpenExternal: () => {},
          mockProcessListOutput:
            'WINEPREFIX=/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher C:\\Program Files\\Epic Games\\EpicGamesLauncher.exe\n',
        }
      );
      expect(resEpic.success).toBe(true);
      expect(engineStateRegistry.activeSessions.get('epic-synth-mac')?.wokeEpicByLauncher).toBe(
        true
      );
    });
  });

  // =========================================================================
  // 5. Xbox Pre-Launch Sync Seeding, Win32 Lifecycle & Chained Publishers
  // =========================================================================
  describe('5. Xbox Pre-Launch Sync Seeding, Win32 Xbox Lifecycle & Chained Publishers', () => {
    it('passes initialPreLaunchSync into startXboxRuntimeLoopbackServer on bottled Xbox launches', async () => {
      const root = makeTempDir('w2-xbox-seed-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });

      createFakeCrossOverApp(appsDir, 'CrossOver.app');
      const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
      const bottle = createFakeBottle(bottlesDir, 'OneLauncher', { wineArch: 'win64' });

      const gameDir = path.join(bottle.bottlePath, 'drive_c/XboxGames/SynthXbox');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'SynthXbox.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      const xboxMods = engineStateRegistry.getXboxStorefrontModules();
      const capturedLoopbackOpts: any[] = [];
      vi.spyOn(xboxMods.xboxRuntimeLoopbackServer, 'startXboxRuntimeLoopbackServer').mockImplementation(
        async (opts: any) => {
          capturedLoopbackOpts.push(opts);
          return {
            port: 0,
            env: { ONE_XGR_PORT: '0' },
            close: async () => {},
          };
        }
      );

      const res = await launcherEngine.launchGame(
        {
          gameId: 'xbox-9SYNTH000001',
          title: 'Synth Xbox',
          platformId: 'xbox',
          platformGameId: '9SYNTH000001',
          packageFamilyName: 'SynthPub.SynthXbox_1234567890abc',
          scid: '00000000-0000-0000-0000-000000007777',
          installPath: gameDir,
          executablePath: gameExe,
          isWindowsBinaryOnMac: true,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          skipRegistrySpawn: true,
          gameSpawnFn: () => createFakeChild(51050),
        }
      );

      expect(res.success).toBe(true);
      expect(capturedLoopbackOpts).toHaveLength(1);
      expect('initialPreLaunchSync' in capturedLoopbackOpts[0]).toBe(true);
      expect(capturedLoopbackOpts[0].initialPreLaunchSync).toBeTruthy();
    });

    it('enforces Win32 Native Xbox fast_direct_bypass (skips AUMID) and default_client (launches Xbox PC App)', async () => {
      const root = makeTempDir('w2-win32-xbox-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      fs.mkdirSync(userDataDir, { recursive: true });
      const gameDir = path.join(root, 'XboxGames', 'WinNativeTitle');
      fs.mkdirSync(gameDir, { recursive: true });
      const gameExe = path.join(gameDir, 'WinNative.exe');
      fs.writeFileSync(gameExe, buildMinimalPeBuffer(0x8664));

      // A) fast_direct_bypass skips AUMID activation and spawns resolvedExePath directly
      const activateSpyA = vi.fn(async () => ({ activated: true, pid: 77701 }));
      const spawnsA: Array<{ cmd: string; args: string[] }> = [];
      const resA = await launcherEngine.launchGame(
        {
          gameId: 'xbox-9WINNATIVE01',
          title: 'Win Native Fast',
          platformId: 'xbox',
          platformGameId: '9WINNATIVE01',
          packageFamilyName: 'SynthPub.WinNative_1234567890abc',
          appUserModelId: 'SynthPub.WinNative_1234567890abc!App',
          installPath: gameDir,
          executablePath: gameExe,
          launchConfig: { storefrontClientLifecycle: 'fast_direct_bypass' },
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          activateXboxApplicationFn: activateSpyA,
          gameSpawnFn: (cmd: string, args: string[]) => {
            spawnsA.push({ cmd, args: [...args] });
            return createFakeChild(51051);
          },
        }
      );
      expect(resA.success).toBe(true);
      expect(activateSpyA).not.toHaveBeenCalled();
      expect(spawnsA).toHaveLength(1);
      expect(spawnsA[0].cmd).toBe(gameExe);
      engineStateRegistry.activeSessions.clear();

      // B) default_client wakes Xbox PC App when not already running & sets wokeXboxAppByLauncher=true
      const xboxAppSpawns: Array<{ cmd: string; args: string[] }> = [];
      const activateSpyB = vi.fn(async () => ({ activated: true, pid: 77702 }));
      const resB = await launcherEngine.launchGame(
        {
          gameId: 'xbox-9WINNATIVE02',
          title: 'Win Native Default',
          platformId: 'xbox',
          platformGameId: '9WINNATIVE02',
          packageFamilyName: 'SynthPub.WinNative_1234567890abc',
          appUserModelId: 'SynthPub.WinNative_1234567890abc!App',
          installPath: gameDir,
          executablePath: gameExe,
          launchConfig: { storefrontClientLifecycle: 'default_client' },
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          mockProcessListOutput: '',
          enableWindowsXboxDefaultClientLaunchInTest: true,
          xboxPollIntervalMs: 10000,
          activateXboxApplicationFn: activateSpyB,
          xboxAppSpawnFn: (cmd: string, args: string[]) => {
            xboxAppSpawns.push({ cmd, args: [...args] });
            return createFakeChild(51052);
          },
        }
      );
      expect(resB.success).toBe(true);
      expect(activateSpyB).toHaveBeenCalledTimes(1);
      expect(xboxAppSpawns).toEqual([
        {
          cmd: 'explorer.exe',
          args: ['shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App'],
        },
      ]);
      expect(engineStateRegistry.activeSessions.get('xbox-9WINNATIVE02')?.wokeXboxAppByLauncher).toBe(
        true
      );
    });

    it('anchors Rockstar foreground regex, threads storefrontClientLifecycle flags cleanly, and tracks native macOS .app publisher wake state', async () => {
      // 1. Anchored Rockstar regex
      const rockstarRe = chainedPublisherLauncher.getPublisherForegroundUiRegex('rockstar');
      expect(rockstarRe).toBeInstanceOf(RegExp);
      expect(rockstarRe.test('C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe')).toBe(true);
      expect(rockstarRe.test('C:\\Program Files\\Rockstar Games\\Launcher\\LauncherPatcher.exe')).toBe(true);
      expect(rockstarRe.test('RockstarLauncher.exe')).toBe(true);
      expect(rockstarRe.test('C:\\Games\\UnrelatedGame\\Launcher.exe')).toBe(false);
      expect(rockstarRe.test('C:\\Program Files\\Rockstar Games\\Launcher\\RockstarService.exe')).toBe(false);

      // 2. buildChainedLauncherLaunchSpec lifecycle flags (Ubisoft -minimized, Rockstar -minmode, never /deactivated or -SuppressBrowser)
      const ubiMin = chainedSpecBuilder.buildChainedLauncherLaunchSpec({
        handoffId: 'ubisoft',
        externalInstallId: '12345',
        launcherBinaryPath: 'C:\\Ubisoft\\upc.exe',
        platform: 'win32',
        storefrontClientLifecycle: 'minimal_and_close_if_started',
      });
      expect(ubiMin.args).toContain('-minimized');
      expect(ubiMin.args).toContain('uplay://launch/12345/0');
      expect(ubiMin.args).not.toContain('/deactivated');
      expect(ubiMin.args).not.toContain('-SuppressBrowser');

      const ubiDef = chainedSpecBuilder.buildChainedLauncherLaunchSpec({
        handoffId: 'ubisoft',
        externalInstallId: '12345',
        launcherBinaryPath: 'C:\\Ubisoft\\upc.exe',
        platform: 'win32',
        storefrontClientLifecycle: 'default_client',
      });
      expect(ubiDef.args).not.toContain('-minimized');

      const rglMin = chainedSpecBuilder.buildChainedLauncherLaunchSpec({
        handoffId: 'rockstar',
        launcherBinaryPath: 'C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe',
        windowsInstallDir: 'C:\\Games\\SynthRGL',
        platform: 'win32',
        storefrontClientLifecycle: 'minimal_keep_running',
      });
      expect(rglMin.args).toEqual(['-minmode', '-launchTitleInFolder', 'C:\\Games\\SynthRGL']);

      const rglDef = chainedSpecBuilder.buildChainedLauncherLaunchSpec({
        handoffId: 'rockstar',
        launcherBinaryPath: 'C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe',
        windowsInstallDir: 'C:\\Games\\SynthRGL',
        platform: 'win32',
        storefrontClientLifecycle: 'default_client',
      });
      expect(rglDef.args).toEqual(['-launchTitleInFolder', 'C:\\Games\\SynthRGL']);

      // 3. Native macOS .app pre-launch host probe filters out bottled .exe / /Bottles/ / WINEPREFIX=
      const bottledOnlyOut =
        'WINEPREFIX=/Users/test/Library/Application Support/CrossOver/Bottles/OneLauncher Battle.net.exe\n';
      expect(
        await chainedPublisherLauncher.checkHostMacPublisherAppRunningAsync('bnet', {
          mockProcessListOutput: bottledOnlyOut,
        })
      ).toBe(false);
      expect(
        await chainedPublisherLauncher.checkHostMacPublisherAppRunningAsync('bnet', {
          mockProcessListOutput: '/Applications/Battle.net.app/Contents/MacOS/Battle.net\n',
        })
      ).toBe(true);

      // End-to-end native macOS Battle.net .app launch tracks wokePublisherClientByLauncher & ephemeralClientWoken
      const root = makeTempDir('w2-mac-bnet-');
      tempDirs.push(root);
      const homedir = path.join(root, 'home');
      const userDataDir = path.join(root, 'userdata');
      const appsDir = path.join(root, 'Applications');
      fs.mkdirSync(userDataDir, { recursive: true });
      const bnetBin = path.join(appsDir, 'Battle.net.app/Contents/MacOS/Battle.net');
      fs.mkdirSync(path.dirname(bnetBin), { recursive: true });
      fs.writeFileSync(bnetBin, '#!/bin/sh\nexit 0;\n', { mode: 0o755 });
      const macGameApp = path.join(root, 'Games/SynthCraft.app');
      fs.mkdirSync(path.join(macGameApp, 'Contents/MacOS'), { recursive: true });
      fs.writeFileSync(path.join(macGameApp, 'Contents/MacOS/SynthCraft'), '#!/bin/sh\n', {
        mode: 0o755,
      });

      const resBnet = await launcherEngine.launchGame(
        {
          gameId: 'bnet-synthcraft',
          title: 'SynthCraft',
          platformId: 'bnet',
          platformGameId: 'synthcraft',
          chainedExternalInstallId: 'SC2',
          installPath: macGameApp,
          executablePath: macGameApp,
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          customApplicationsDir: appsDir,
          mockProcessListOutput: bottledOnlyOut,
          gameSpawnFn: () => createFakeChild(51060),
        }
      );
      expect(resBnet.success).toBe(true);
      const bnetEntry = engineStateRegistry.activeSessions.get('bnet-synthcraft');
      expect(bnetEntry?.wasHostPublisherRunning).toBe(false);
      expect(bnetEntry?.wokePublisherClientByLauncher).toBe(true);
      expect(bnetEntry?.ephemeralClientWoken).toBe(true);
    });
  });
});
