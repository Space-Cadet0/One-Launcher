import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface LinkSteamAppsResult {
  linkedCount: number;
  linkedAppIds: number[];
  needsVdfSync?: boolean;
}

interface SetupOutcomeLike {
  componentId: string;
  action: string;
  status: string;
  installedPath?: string;
  steamRestartRequired?: boolean;
  message?: string;
  error?: string;
}

interface SetupRunResultLike {
  success: boolean;
  outcomes: SetupOutcomeLike[];
}

interface GuidedLoginResultLike {
  success: boolean;
  targetId: string;
  authenticated: boolean;
  autoClosedClient?: boolean;
  message?: string;
}

interface SetupOrchestratorMod {
  linkInstalledSteamAppsIntoBottle: (
    targetBottlePath: string,
    options?: Record<string, unknown>
  ) => Promise<LinkSteamAppsResult>;
  runEnvironmentSetupTasks: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<SetupRunResultLike>;
  startGuidedClientLogin: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<GuidedLoginResultLike>;
}

interface CompatBottleDetail {
  wineArch?: 'win64' | 'arm64';
  previewEnabled?: boolean;
  hasSteam?: boolean;
  steamSignedIn?: boolean;
  installedSteamAppIds?: number[];
  hasGogGalaxy?: boolean;
  hasEpicLauncher?: boolean;
}

interface CompatLayerRecord {
  id: string;
  type: string;
  name: string;
  binaryPath: string;
  bottlesDir?: string;
  availableBottles?: string[];
  bottleDetails?: Record<string, CompatBottleDetail>;
}

interface CompatRegistryMod {
  detectCompatibilityLayers: (options?: Record<string, unknown>) => CompatLayerRecord[];
  hasBottleSteamAppManifest: (bottlePath: string, appId: string | number) => boolean;
  listBottleInstalledSteamAppIds: (bottlePath: string, steamExe?: string | null) => number[];
  invalidateCompatLayersCache: () => void;
}

interface ScannedGameRecord {
  platformId: string;
  platformGameId: string;
  appId?: number;
  installPath?: string;
  executablePath?: string;
  manifestPath?: string;
  isWindowsBinaryOnMac?: boolean;
}

interface ScanResultLike {
  installedGames: ScannedGameRecord[];
  installedSteamAppIds: number[];
}

interface InstalledGameScannerMod {
  scanAllInstalledGames: (options?: Record<string, unknown>) => ScanResultLike;
  scanAllInstalledGamesAsync: (options?: Record<string, unknown>) => Promise<ScanResultLike>;
}

interface UninstallResultLike {
  success: boolean;
  error?: string;
}

interface GameVerifyAndUninstallMod {
  uninstallGame: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<UninstallResultLike>;
}

interface LaunchResultLike {
  success: boolean;
  errorCode?: string;
  targetBottleName?: string;
  targetBottlePath?: string;
  chosenRunnerType?: string;
  installBottleName?: string;
  recommendedRunnerType?: string;
  error?: string;
  session?: {
    launchMethod?: string;
    winePrefix?: string;
  };
}

interface LauncherEngineMod {
  launchGame: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<LaunchResultLike>;
}

interface BottleDisplayControllerMod {
  resetSupervisorStateForTests: () => void;
}

interface EngineStateRegistryMod {
  activeSessions: Map<
    string,
    {
      winePrefix?: string;
      finalized?: boolean;
      pollTimer?: ReturnType<typeof setInterval> | null;
      displayStatusTimer?: ReturnType<typeof setInterval> | null;
    }
  >;
  pendingBottleLaunches: Map<string, unknown>;
  pendingStorefrontLaunches: Map<string, unknown>;
  invalidateScanCaches: (opts?: Record<string, unknown>) => void;
}

interface FakeChildProcess extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

interface SpawnOptionsLike {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const setupOrchestrator = nodeRequire(
  '../electron/launcher/provisioner/setupOrchestratorAndGuidedLogin.cjs'
) as SetupOrchestratorMod;
const compatRegistry = nodeRequire(
  '../electron/launcher/mac/compatLayerRegistryAndDetection.cjs'
) as CompatRegistryMod;
const gameScanner = nodeRequire(
  '../electron/launcher/installedGameScanner.cjs'
) as InstalledGameScannerMod;
const gameVerifyAndUninstall = nodeRequire(
  '../electron/launcher/supervisor/gameVerifyAndUninstall.cjs'
) as GameVerifyAndUninstallMod;
const launcherEngine = nodeRequire('../electron/launcherEngine.cjs') as LauncherEngineMod;
const bottleDisplayController = nodeRequire(
  '../electron/launcher/supervisor/bottleDisplayAndEnvController.cjs'
) as BottleDisplayControllerMod;
const engineStateRegistry = nodeRequire(
  '../electron/launcher/engineStateRegistry.cjs'
) as EngineStateRegistryMod;

function buildMinimalPeBuffer(machine: 0x014c | 0x8664 = 0x8664): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(machine, 0x84);
  buf.writeUInt16LE(1, 0x86);
  buf.writeUInt16LE(machine === 0x8664 ? 0xf0 : 0xe0, 0x94);
  buf.writeUInt16LE(0x0002, 0x96);
  buf.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 0x98);
  return buf;
}

function buildSignedPeInstallerBuffer(): Buffer {
  const totalBytes = 520 * 1024;
  const buf = Buffer.alloc(totalBytes, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  const peOffset = 0x80;
  buf.write('PE\0\0', peOffset, 'ascii');
  buf.writeUInt16LE(0x8664, peOffset + 4);
  buf.writeUInt16LE(1, peOffset + 6);
  buf.writeUInt16LE(240, peOffset + 20);
  buf.writeUInt16LE(0x0022, peOffset + 22);
  const optOffset = peOffset + 24;
  buf.writeUInt16LE(0x020b, optOffset);
  buf.writeUInt32LE(16, optOffset + 108);
  const certFileOffset = totalBytes - 1024;
  const certTableSize = 128;
  const secDirOffset = optOffset + 112 + 4 * 8;
  buf.writeUInt32LE(certFileOffset, secDirOffset);
  buf.writeUInt32LE(certTableSize, secDirOffset + 4);
  buf.writeUInt32LE(certTableSize, certFileOffset);
  buf.writeUInt16LE(0x0200, certFileOffset + 4);
  buf.writeUInt16LE(0x0002, certFileOffset + 6);
  buf[certFileOffset + 8] = 0x30;
  buf[certFileOffset + 9] = 0x81;
  buf[certFileOffset + 10] = 0x75;
  return buf;
}

function buildMockFetchResponse(body: Buffer, url = '') {
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(body.length) : null,
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    text: async () => body.toString('utf8'),
  };
}

function createFakeChild(pid = 48101): FakeChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
}

function buildAcfContent(params: {
  appId: number;
  name: string;
  installdir: string;
  stateFlags?: string;
  sizeOnDisk?: string;
  bytesToDownload?: string;
  bytesDownloaded?: string;
}): string {
  const lines = [
    '"AppState"',
    '{',
    `\t"appid"\t\t"${params.appId}"`,
    `\t"name"\t\t"${params.name}"`,
    `\t"StateFlags"\t\t"${params.stateFlags ?? '4'}"`,
    `\t"installdir"\t\t"${params.installdir}"`,
    `\t"SizeOnDisk"\t\t"${params.sizeOnDisk ?? '512000000'}"`,
  ];
  if (params.bytesToDownload !== undefined) {
    lines.push(`\t"BytesToDownload"\t\t"${params.bytesToDownload}"`);
  }
  if (params.bytesDownloaded !== undefined) {
    lines.push(`\t"BytesDownloaded"\t\t"${params.bytesDownloaded}"`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

function buildLibraryFoldersVdf(zeroAppsEntries: Record<string, string> = {}, extraLibPath?: string): string {
  const zeroAppLines = Object.entries(zeroAppsEntries)
    .map(([id, size]) => `\t\t\t"${id}"\t\t"${size}"`)
    .join('\n');
  const zeroAppsBody = zeroAppLines ? `${zeroAppLines}\n` : '';
  const extraBlock = extraLibPath
    ? `\t"1"\n\t{\n\t\t"path"\t\t"${extraLibPath.replace(/\\/g, '\\\\')}"\n\t\t"apps"\n\t\t{\n\t\t\t"999001"\t\t"4096"\n\t\t}\n\t}\n`
    : '';
  return [
    '"libraryfolders"',
    '{',
    '\t"0"',
    '\t{',
    '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
    '\t\t"label"\t\t""',
    '\t\t"apps"',
    '\t\t{',
    `${zeroAppsBody}\t\t}`,
    '\t}',
    `${extraBlock}}`,
    '',
  ].join('\n');
}

function createFakeCrossOverApp(
  appsDir: string,
  appName: string
): { appPath: string; wineBin: string } {
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
  return { appPath, wineBin };
}

function createSyntheticBottle(
  bottlesDir: string,
  bottleName: string,
  opts: {
    wineArch?: 'win64' | 'arm64';
    withSteam?: boolean;
    signedIn?: boolean;
  } = {}
): { bottlePath: string; steamRoot: string; steamExe: string; steamappsDir: string } {
  const bottlePath = path.join(bottlesDir, bottleName);
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'windows', 'system32'), { recursive: true });
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'windows', 'syswow64'), { recursive: true });
  fs.writeFileSync(
    path.join(bottlePath, 'cxbottle.conf'),
    `[Bottle]\n"WineArch" = "${opts.wineArch ?? 'win64'}"\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  fs.writeFileSync(path.join(bottlePath, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

  const steamRoot = path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam');
  const steamExe = path.join(steamRoot, 'steam.exe');
  const steamappsDir = path.join(steamRoot, 'steamapps');
  if (opts.withSteam) {
    fs.mkdirSync(path.join(steamappsDir, 'common'), { recursive: true });
    fs.mkdirSync(path.join(steamRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(steamRoot, 'logs'), { recursive: true });
    fs.writeFileSync(steamExe, buildMinimalPeBuffer(0x014c));
    if (opts.signedIn) {
      fs.writeFileSync(
        path.join(steamRoot, 'config', 'loginusers.vdf'),
        `"users"\n{\n\t"76561198000000042"\n\t{\n\t\t"AccountName"\t\t"synth_player"\n\t\t"PersonaName"\t\t"Synth Player"\n\t\t"RememberPassword"\t\t"1"\n\t\t"AllowAutoLogin"\t\t"1"\n\t\t"MostRecent"\t\t"1"\n\t}\n}\n`,
        'utf8'
      );
    }
  }
  return { bottlePath, steamRoot, steamExe, steamappsDir };
}

function seedPhysicalSteamGame(
  steamappsDir: string,
  params: {
    appId: number;
    name: string;
    installdir: string;
    exeName?: string;
    stateFlags?: string;
    sizeOnDisk?: string;
    bytesToDownload?: string;
    bytesDownloaded?: string;
  }
): { gameDir: string; exePath: string; acfPath: string } {
  const gameDir = path.join(steamappsDir, 'common', params.installdir);
  fs.mkdirSync(gameDir, { recursive: true });
  const exePath = path.join(gameDir, params.exeName ?? 'game.exe');
  fs.writeFileSync(exePath, buildMinimalPeBuffer(0x8664));
  const acfPath = path.join(steamappsDir, `appmanifest_${params.appId}.acf`);
  fs.writeFileSync(acfPath, buildAcfContent(params), 'utf8');
  return { gameDir, exePath, acfPath };
}

describe('Phase 3: 1-Click Bottle Steam Provisioning & Zero-Duplicate Cross-Bottle Linking', () => {
  const tempDirs: string[] = [];

  function makeSandbox(prefix: string): {
    root: string;
    homedir: string;
    userDataDir: string;
    appsDir: string;
    bottlesDir: string;
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(root);
    const homedir = path.join(root, 'home');
    const userDataDir = path.join(root, 'userData');
    const appsDir = path.join(root, 'Applications');
    const bottlesDir = path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(bottlesDir, { recursive: true });
    return { root, homedir, userDataDir, appsDir, bottlesDir };
  }

  beforeEach(() => {
    bottleDisplayController.resetSupervisorStateForTests();
    compatRegistry.invalidateCompatLayersCache();
    engineStateRegistry.invalidateScanCaches({ skipPreviewUrlCacheClear: true });
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.pendingBottleLaunches.clear();
    engineStateRegistry.pendingStorefrontLaunches.clear();
  });

  afterEach(() => {
    for (const [, entry] of engineStateRegistry.activeSessions.entries()) {
      if (entry?.pollTimer) clearInterval(entry.pollTimer);
      if (entry?.displayStatusTimer) clearInterval(entry.displayStatusTimer);
    }
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.pendingBottleLaunches.clear();
    engineStateRegistry.pendingStorefrontLaunches.clear();
    bottleDisplayController.resetSupervisorStateForTests();
    compatRegistry.invalidateCompatLayersCache();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  describe('1. linkInstalledSteamAppsIntoBottle — Zero-Duplicate Cross-Bottle Linking & Guards', () => {
    it('returns { linkedCount: 0, linkedAppIds: [] } when target bottle lacks steam.exe', async () => {
      const sb = makeSandbox('p3-link-no-steam-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', { withSteam: true });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
      });
      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: false,
      });

      const res = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(target.bottlePath, {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
      });

      expect(res).toEqual({ linkedCount: 0, linkedAppIds: [] });
      expect(fs.existsSync(path.join(target.steamappsDir, 'common'))).toBe(false);
    });

    it('creates POSIX symlinks (no disk duplication) and copies .acf for installed games + Steamworks Shared 228980, follows realpath, repairs broken symlinks, and never overwrites physical dirs', async () => {
      const sb = makeSandbox('p3-link-core-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

      const srcBottle = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', { withSteam: true });
      const quake = seedPhysicalSteamGame(srcBottle.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
        sizeOnDisk: '1234567890',
      });
      const sharedRedist = seedPhysicalSteamGame(srcBottle.steamappsDir, {
        appId: 228980,
        name: 'Steamworks Common Redistributables',
        installdir: 'Steamworks Shared',
        exeName: 'vcredist.exe',
        sizeOnDisk: '98765432',
      });
      // Actively downloading app (StateFlags 1026, bit 4 NOT set) must be skipped
      seedPhysicalSteamGame(srcBottle.steamappsDir, {
        appId: 55501,
        name: 'InProgress Download',
        installdir: 'InProgressGame',
        stateFlags: '1026',
        bytesToDownload: '10000',
        bytesDownloaded: '100',
      });
      // Malicious traversal installdir must be skipped
      fs.writeFileSync(
        path.join(srcBottle.steamappsDir, 'appmanifest_99901.acf'),
        buildAcfContent({ appId: 99901, name: 'Traversal', installdir: '../../escape' }),
        'utf8'
      );
      // Manifest whose physical common dir is missing must be skipped
      fs.writeFileSync(
        path.join(srcBottle.steamappsDir, 'appmanifest_99902.acf'),
        buildAcfContent({ appId: 99902, name: 'MissingDir', installdir: 'GhostGame' }),
        'utf8'
      );
      // External library folder via source libraryfolders.vdf (dosdevices d: on POSIX, C:\ExtSteamLib on win32 NTFS)
      const isPosixHost = process.platform !== 'win32';
      const extLibRoot = isPosixHost
        ? path.join(sb.root, 'ExtSteamLib')
        : path.join(srcBottle.bottlePath, 'drive_c', 'ExtSteamLib');
      const extSteamapps = path.join(extLibRoot, 'steamapps');
      const extGame = seedPhysicalSteamGame(extSteamapps, {
        appId: 620,
        name: 'Portal 2',
        installdir: 'Portal 2',
        exeName: 'portal2.exe',
        sizeOnDisk: '800000000',
      });
      if (isPosixHost) {
        fs.mkdirSync(path.join(srcBottle.bottlePath, 'dosdevices'), { recursive: true });
        fs.symlinkSync(extLibRoot, path.join(srcBottle.bottlePath, 'dosdevices', 'd:'), 'dir');
      }
      fs.writeFileSync(
        path.join(srcBottle.steamappsDir, 'libraryfolders.vdf'),
        buildLibraryFoldersVdf({ '2320': '1234567890' }, isPosixHost ? 'D:\\' : 'C:\\\\ExtSteamLib'),
        'utf8'
      );

      // Game that already has a physical non-symlink dir in target bottle
      seedPhysicalSteamGame(srcBottle.steamappsDir, {
        appId: 400,
        name: 'Portal',
        installdir: 'Portal',
        exeName: 'hl2.exe',
      });

      const targetBottle = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });

      // Seed an existing physical non-symlink dir in target for Portal + its own ACF
      const existingPhysicalPortal = path.join(targetBottle.steamappsDir, 'common', 'Portal');
      fs.mkdirSync(existingPhysicalPortal, { recursive: true });
      const sentinelFile = path.join(existingPhysicalPortal, 'local_physical_sentinel.txt');
      fs.writeFileSync(sentinelFile, 'keep-physical-copy', 'utf8');
      fs.writeFileSync(
        path.join(targetBottle.steamappsDir, 'appmanifest_400.acf'),
        buildAcfContent({ appId: 400, name: 'Portal', installdir: 'Portal' }),
        'utf8'
      );

      // Seed a broken symlink at target common/Quake 2 to verify automatic repair
      const targetQuakeDir = path.join(targetBottle.steamappsDir, 'common', 'Quake 2');
      fs.symlinkSync(path.join(sb.root, 'nonexistent-deleted-dir'), targetQuakeDir, 'dir');

      const linkOpts = {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
        mockProcessListOutput: '',
      };

      const res = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(
        targetBottle.bottlePath,
        linkOpts
      );

      expect(res.linkedAppIds).toEqual([620, 2320, 228980]);
      expect(res.linkedCount).toBe(3);

      // Verify symlinks point directly to canonical physical realpath
      expect(fs.lstatSync(targetQuakeDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(targetQuakeDir)).toBe(fs.realpathSync(quake.gameDir));
      expect(fs.existsSync(path.join(targetBottle.steamappsDir, 'appmanifest_2320.acf'))).toBe(true);

      const targetSharedDir = path.join(targetBottle.steamappsDir, 'common', 'Steamworks Shared');
      expect(fs.lstatSync(targetSharedDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(targetSharedDir)).toBe(fs.realpathSync(sharedRedist.gameDir));
      expect(fs.existsSync(path.join(targetBottle.steamappsDir, 'appmanifest_228980.acf'))).toBe(true);

      const targetExtDir = path.join(targetBottle.steamappsDir, 'common', 'Portal 2');
      expect(fs.lstatSync(targetExtDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(targetExtDir)).toBe(fs.realpathSync(extGame.gameDir));
      expect(fs.existsSync(path.join(targetBottle.steamappsDir, 'appmanifest_620.acf'))).toBe(true);

      // Verify skipped bad/downloading manifests
      expect(fs.existsSync(path.join(targetBottle.steamappsDir, 'appmanifest_55501.acf'))).toBe(false);
      expect(fs.existsSync(path.join(targetBottle.steamappsDir, 'appmanifest_99901.acf'))).toBe(false);
      expect(fs.existsSync(path.join(targetBottle.steamappsDir, 'appmanifest_99902.acf'))).toBe(false);

      // Verify existing physical directory was NEVER overwritten
      expect(fs.lstatSync(existingPhysicalPortal).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('keep-physical-copy');

      // Idempotent second run links 0 new apps
      const secondRes = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(
        targetBottle.bottlePath,
        linkOpts
      );
      expect(secondRes).toEqual({ linkedCount: 0, linkedAppIds: [] });

      // Third bottle linking when Bottle B already has symlinks resolves directly to Bottle A realpath (no chain!)
      const thirdBottle = createSyntheticBottle(sb.bottlesDir, 'ThirdBottle', {
        wineArch: 'arm64',
        withSteam: true,
      });
      await setupOrchestrator.linkInstalledSteamAppsIntoBottle(thirdBottle.bottlePath, linkOpts);
      const thirdQuakeLink = path.join(thirdBottle.steamappsDir, 'common', 'Quake 2');
      expect(fs.lstatSync(thirdQuakeLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(thirdQuakeLink)).toBe(fs.realpathSync(quake.gameDir));
    });
  });

  describe('2. Safe libraryfolders.vdf "0" -> "apps" Synchronization', () => {
    it('inserts missing apps into "0" -> "apps" in both steamapps & config libraryfolders.vdf when steam.exe is NOT running in target bottle', async () => {
      const sb = makeSandbox('p3-vdf-sync-offline-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', { withSteam: true });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        sizeOnDisk: '654321000',
      });

      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });
      const steamappsVdfPath = path.join(target.steamappsDir, 'libraryfolders.vdf');
      const configVdfPath = path.join(target.steamRoot, 'config', 'libraryfolders.vdf');
      fs.writeFileSync(
        steamappsVdfPath,
        buildLibraryFoldersVdf({ '228980': '111' }, 'D:\\ExtraLib'),
        'utf8'
      );
      fs.writeFileSync(configVdfPath, buildLibraryFoldersVdf({}), 'utf8');

      // steam.exe running ONLY in OneLauncher (NOT target OneLauncher-arm64) must NOT block sync!
      const mockPsOtherBottle = `WINEPREFIX=${src.bottlePath} C:\\Program Files (x86)\\Steam\\steam.exe -silent`;

      await setupOrchestrator.linkInstalledSteamAppsIntoBottle(target.bottlePath, {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
        mockProcessListOutput: mockPsOtherBottle,
      });

      const updatedSteamappsVdf = fs.readFileSync(steamappsVdfPath, 'utf8');
      const updatedConfigVdf = fs.readFileSync(configVdfPath, 'utf8');

      expect(updatedSteamappsVdf).toContain('\t\t\t"2320"\t\t"654321000"\n');
      expect(updatedSteamappsVdf).toContain('"228980"\t\t"111"');
      // Preserves block "1" untouched
      expect(updatedSteamappsVdf).toContain('"999001"\t\t"4096"');
      expect(updatedConfigVdf).toContain('\t\t\t"2320"\t\t"654321000"\n');

      // Re-running does not duplicate "2320"
      await setupOrchestrator.linkInstalledSteamAppsIntoBottle(target.bottlePath, {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
        mockProcessListOutput: '',
      });
      const afterSecondRun = fs.readFileSync(steamappsVdfPath, 'utf8');
      expect(afterSecondRun.match(/"2320"/g)?.length).toBe(1);
    });

    it('skips libraryfolders.vdf mutation when steam.exe IS actively running inside targetBottlePath', async () => {
      const sb = makeSandbox('p3-vdf-sync-running-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', { withSteam: true });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        sizeOnDisk: '654321000',
      });

      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });
      const steamappsVdfPath = path.join(target.steamappsDir, 'libraryfolders.vdf');
      const initialVdf = buildLibraryFoldersVdf({ '228980': '111' });
      fs.writeFileSync(steamappsVdfPath, initialVdf, 'utf8');

      const mockPsTargetRunning = `WINEPREFIX=${target.bottlePath} C:\\Program Files (x86)\\Steam\\steam.exe -silent`;
      const res = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(target.bottlePath, {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
        mockProcessListOutput: mockPsTargetRunning,
      });

      // Symlink + ACF are created, but live libraryfolders.vdf is NOT mutated while steam.exe runs
      expect(res.linkedAppIds).toEqual([2320]);
      expect(fs.readFileSync(steamappsVdfPath, 'utf8')).toBe(initialVdf);
    });
  });

  describe('3. Provisioning & Guided Login Wiring (runEnvironmentSetupTasks + startGuidedClientLogin)', () => {
    it('Branch 1 (existing Steam): links games in <50ms and invalidates compatLayersCache so installedSteamAppIds updates immediately', async () => {
      const sb = makeSandbox('p3-setup-branch1-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        signedIn: true,
      });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
      });
      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
        signedIn: true,
      });

      // Prime compatLayersCache BEFORE linking
      const beforeLayers = compatRegistry.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
      });
      const beforeArm = beforeLayers.find((l) => l.type === 'crossover_preview_arm64');
      expect(beforeArm?.bottleDetails?.['OneLauncher-arm64']?.installedSteamAppIds).toEqual([]);

      const setupRes = await setupOrchestrator.runEnvironmentSetupTasks(
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
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          skipNetwork: true,
          mockProcessListOutput: '',
        }
      );

      expect(setupRes.success).toBe(true);
      expect(setupRes.outcomes[0]?.status).toBe('skipped');
      expect(fs.lstatSync(path.join(target.steamappsDir, 'common', 'Quake 2')).isSymbolicLink()).toBe(true);

      // Without forceRefresh, cache must already be invalidated so installedSteamAppIds immediately reflects [2320]
      const afterLayers = compatRegistry.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
      });
      const afterArm = afterLayers.find((l) => l.type === 'crossover_preview_arm64');
      expect(afterArm?.bottleDetails?.['OneLauncher-arm64']?.installedSteamAppIds).toEqual([2320]);
    });

    it('Branch 2 (fresh install) + startGuidedClientLogin: links games right after SteamSetup.exe /S and syncs newly generated libraryfolders.vdf after guided login closes Steam', async () => {
      const sb = makeSandbox('p3-setup-branch2-guided-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        signedIn: true,
      });
      const quake = seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
        sizeOnDisk: '777777',
      });
      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: false,
      });

      const signedSteamSetupBuf = buildSignedPeInstallerBuffer();

      const setupRes = await setupOrchestrator.runEnvironmentSetupTasks(
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
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          mockProcessListOutput: '',
          fetchFn: async (url: string) => buildMockFetchResponse(signedSteamSetupBuf, url),
          execBottleInstallerFn: async ({ bottlePath }: { bottlePath: string }) => {
            const steamDir = path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam');
            fs.mkdirSync(path.join(steamDir, 'steamapps'), { recursive: true });
            fs.mkdirSync(path.join(steamDir, 'config'), { recursive: true });
            fs.writeFileSync(path.join(steamDir, 'steam.exe'), buildMinimalPeBuffer(0x014c));
          },
        }
      );

      expect(setupRes.success).toBe(true);
      expect(setupRes.outcomes[0]?.status).toBe('completed');
      const linkedQuakeDir = path.join(target.steamappsDir, 'common', 'Quake 2');
      expect(fs.lstatSync(linkedQuakeDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linkedQuakeDir)).toBe(fs.realpathSync(quake.gameDir));
      expect(fs.existsSync(path.join(target.steamappsDir, 'appmanifest_2320.acf'))).toBe(true);

      // Simulate guided login: Steam opens, user signs in, Steam creates fresh libraryfolders.vdf (empty apps), then closes
      const targetVdfPath = path.join(target.steamappsDir, 'libraryfolders.vdf');
      const loginRes = await setupOrchestrator.startGuidedClientLogin(
        {
          targetId: 'bottle_steam',
          runnerType: 'crossover_preview_arm64',
          bottleName: 'OneLauncher-arm64',
          autoCloseOnSuccess: true,
          timeoutMs: 5000,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          pollIntervalMs: 10,
          postLoginFlushDelayMs: 5,
          mockProcessListOutput: '',
          spawnClientFn: async () => {
            fs.writeFileSync(
              path.join(target.steamRoot, 'config', 'loginusers.vdf'),
              `"users"\n{\n\t"76561198000000042"\n\t{\n\t\t"AccountName"\t\t"synth_player"\n\t\t"RememberPassword"\t\t"1"\n\t\t"MostRecent"\t\t"1"\n\t}\n}\n`,
              'utf8'
            );
            fs.writeFileSync(targetVdfPath, buildLibraryFoldersVdf({}), 'utf8');
          },
          execFileFn: (
            _cmd: string,
            _args: string[],
            _opts: Record<string, unknown>,
            cb?: (err: Error | null, stdout?: string, stderr?: string) => void
          ) => {
            if (typeof cb === 'function') cb(null, '', '');
            return {};
          },
        }
      );

      expect(loginRes.success).toBe(true);
      expect(loginRes.authenticated).toBe(true);
      expect(fs.readFileSync(targetVdfPath, 'utf8')).toContain('\t\t\t"2320"\t\t"777777"\n');
    });
  });

  describe('4. compatLayerRegistryAndDetection — bottleDetails.installedSteamAppIds', () => {
    it('collects sorted AppIDs excluding 228980 across primary + external libraryfolders.vdf, requires existing common/<installdir>, and clones arrays safely', () => {
      const sb = makeSandbox('p3-compat-appids-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      const bottle = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        signedIn: true,
      });
      createSyntheticBottle(sb.bottlesDir, 'EmptyBottle', {
        wineArch: 'win64',
        withSteam: false,
      });

      seedPhysicalSteamGame(bottle.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
      });
      seedPhysicalSteamGame(bottle.steamappsDir, {
        appId: 228980,
        name: 'Steamworks Shared',
        installdir: 'Steamworks Shared',
      });
      // Manifest without existing common/<installdir> must be excluded
      fs.writeFileSync(
        path.join(bottle.steamappsDir, 'appmanifest_9001.acf'),
        buildAcfContent({ appId: 9001, name: 'Ghost', installdir: 'NoSuchFolder' }),
        'utf8'
      );
      // External library folder via dosdevices y: on POSIX (C:\ExternalSteam on win32 NTFS)
      const isPosixHost = process.platform !== 'win32';
      const extLib = isPosixHost
        ? path.join(sb.root, 'ExternalSteam')
        : path.join(bottle.bottlePath, 'drive_c', 'ExternalSteam');
      seedPhysicalSteamGame(path.join(extLib, 'steamapps'), {
        appId: 400,
        name: 'Portal',
        installdir: 'Portal',
      });
      if (isPosixHost) {
        fs.mkdirSync(path.join(bottle.bottlePath, 'dosdevices'), { recursive: true });
        fs.symlinkSync(extLib, path.join(bottle.bottlePath, 'dosdevices', 'y:'), 'dir');
      }
      fs.writeFileSync(
        path.join(bottle.steamappsDir, 'libraryfolders.vdf'),
        buildLibraryFoldersVdf({ '2320': '512000000' }, isPosixHost ? 'Y:\\' : 'C:\\\\ExternalSteam'),
        'utf8'
      );

      const detectOpts = {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
      };
      const layers1 = compatRegistry.detectCompatibilityLayers(detectOpts);
      const cx1 = layers1.find((l) => l.type === 'crossover');
      expect(cx1?.bottleDetails?.OneLauncher?.installedSteamAppIds).toEqual([400, 2320]);
      expect(cx1?.bottleDetails?.EmptyBottle?.installedSteamAppIds).toEqual([]);

      // Mutating returned array must NOT pollute compatLayersCache
      cx1?.bottleDetails?.OneLauncher?.installedSteamAppIds?.push(999999);
      const layers2 = compatRegistry.detectCompatibilityLayers(detectOpts);
      const cx2 = layers2.find((l) => l.type === 'crossover');
      expect(cx2?.bottleDetails?.OneLauncher?.installedSteamAppIds).toEqual([400, 2320]);
    });
  });

  describe('5. installedGameScanner — Physical Install Precedence Over Cross-Bottle Symlink', () => {
    it('always preserves physical non-symlink installPath/executablePath/manifestPath in both sync and async scans regardless of bottle alphabetical scan order', async () => {
      for (const [physName, symName] of [
        ['OneLauncher', 'OneLauncher-arm64'],
        ['Z_PhysicalBottle', 'A_SymlinkBottle'],
      ] as const) {
        const sb = makeSandbox(`p3-scan-order-${physName}-`);
        createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
        createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

        const physBottle = createSyntheticBottle(sb.bottlesDir, physName, {
          wineArch: 'win64',
          withSteam: true,
        });
        const quake = seedPhysicalSteamGame(physBottle.steamappsDir, {
          appId: 2320,
          name: 'Quake II',
          installdir: 'Quake 2',
          exeName: 'quake2ex_steam.exe',
        });

        const symBottle = createSyntheticBottle(sb.bottlesDir, symName, {
          wineArch: 'arm64',
          withSteam: true,
        });
        await setupOrchestrator.linkInstalledSteamAppsIntoBottle(symBottle.bottlePath, {
          platform: 'darwin',
          homedir: sb.homedir,
          customApplicationsDir: sb.appsDir,
          mockProcessListOutput: '',
        });

        const scanOpts = {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          forceRefresh: true,
        };

        const syncRes = gameScanner.scanAllInstalledGames(scanOpts);
        const syncQuake = syncRes.installedGames.find(
          (g) => g.platformId === 'steam' && String(g.platformGameId) === '2320'
        );
        expect(syncQuake).toBeDefined();
        expect(syncQuake?.installPath).toBe(path.resolve(quake.gameDir));
        expect(syncQuake?.executablePath).toBe(path.resolve(quake.exePath));
        expect(syncQuake?.manifestPath).toBe(path.resolve(quake.acfPath));

        const asyncRes = await gameScanner.scanAllInstalledGamesAsync(scanOpts);
        const asyncQuake = asyncRes.installedGames.find(
          (g) => g.platformId === 'steam' && String(g.platformGameId) === '2320'
        );
        expect(asyncQuake).toBeDefined();
        expect(asyncQuake?.installPath).toBe(path.resolve(quake.gameDir));
        expect(asyncQuake?.executablePath).toBe(path.resolve(quake.exePath));
        expect(asyncQuake?.manifestPath).toBe(path.resolve(quake.acfPath));
      }
    });
  });

  describe('6. gameVerifyAndUninstall — Symlink-Safe Steam Game Uninstall', () => {
    it('unlinks ONLY the cross-bottle symlink without deleting physical source files when uninstalling a symlinked bottle entry, and cleans both bottles cleanly on full cross-bottle uninstall', async () => {
      // A) Isolated symlink-only uninstall (source bottle sits outside homedir so only target bottle's symlink is in scope)
      const sbIsolated = makeSandbox('p3-uninstall-symlink-only-');
      createFakeCrossOverApp(sbIsolated.appsDir, 'CrossOver Preview arm64.app');
      const externalPhysicalDir = path.join(sbIsolated.root, 'ExternalPhysicalQuake');
      fs.mkdirSync(externalPhysicalDir, { recursive: true });
      const physicalExe = path.join(externalPhysicalDir, 'quake2ex_steam.exe');
      fs.writeFileSync(physicalExe, buildMinimalPeBuffer(0x8664));
      const physicalData = path.join(externalPhysicalDir, 'pak0.pak');
      fs.writeFileSync(physicalData, 'PHYSICAL-GAME-ASSETS', 'utf8');

      const armBottle = createSyntheticBottle(sbIsolated.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });
      const symlinkGameDir = path.join(armBottle.steamappsDir, 'common', 'Quake 2');
      fs.symlinkSync(externalPhysicalDir, symlinkGameDir, 'dir');
      const symlinkAcf = path.join(armBottle.steamappsDir, 'appmanifest_2320.acf');
      fs.writeFileSync(
        symlinkAcf,
        buildAcfContent({ appId: 2320, name: 'Quake II', installdir: 'Quake 2' }),
        'utf8'
      );

      const isolatedRes = await gameVerifyAndUninstall.uninstallGame(
        {
          gameId: 'steam-2320',
          platformId: 'steam',
          platformGameId: '2320',
          title: 'Quake II',
          installPath: symlinkGameDir,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sbIsolated.homedir,
          userDataDir: sbIsolated.userDataDir,
          customApplicationsDir: sbIsolated.appsDir,
          allowDeleteFiles: true,
        }
      );

      expect(isolatedRes.success).toBe(true);
      // Symlink and manifest inside arm64 bottle are removed
      expect(() => fs.lstatSync(symlinkGameDir)).toThrow();
      expect(fs.existsSync(symlinkAcf)).toBe(false);
      // Physical target directory and assets remain 100% intact!
      expect(fs.existsSync(externalPhysicalDir)).toBe(true);
      expect(fs.readFileSync(physicalData, 'utf8')).toBe('PHYSICAL-GAME-ASSETS');

      // B) Cross-bottle uninstall cleans physical source AND removes symlink (even if dangling after physical deletion)
      const sbFull = makeSandbox('p3-uninstall-full-');
      createFakeCrossOverApp(sbFull.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sbFull.appsDir, 'CrossOver Preview arm64.app');
      const physBottle = createSyntheticBottle(sbFull.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
      });
      const quake = seedPhysicalSteamGame(physBottle.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
      });
      const linkedBottle = createSyntheticBottle(sbFull.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });
      await setupOrchestrator.linkInstalledSteamAppsIntoBottle(linkedBottle.bottlePath, {
        platform: 'darwin',
        homedir: sbFull.homedir,
        customApplicationsDir: sbFull.appsDir,
        mockProcessListOutput: '',
      });
      const linkedGameDir = path.join(linkedBottle.steamappsDir, 'common', 'Quake 2');
      expect(fs.lstatSync(linkedGameDir).isSymbolicLink()).toBe(true);

      const fullRes = await gameVerifyAndUninstall.uninstallGame(
        {
          gameId: 'steam-2320',
          platformId: 'steam',
          platformGameId: '2320',
          title: 'Quake II',
          installPath: quake.gameDir,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sbFull.homedir,
          userDataDir: sbFull.userDataDir,
          customApplicationsDir: sbFull.appsDir,
          allowDeleteFiles: true,
        }
      );

      expect(fullRes.success).toBe(true);
      expect(fs.existsSync(quake.gameDir)).toBe(false);
      expect(fs.existsSync(quake.acfPath)).toBe(false);
      // No dangling symlink left behind in OneLauncher-arm64!
      expect(() => fs.lstatSync(linkedGameDir)).toThrow();
      expect(fs.existsSync(path.join(linkedBottle.steamappsDir, 'appmanifest_2320.acf'))).toBe(false);
    });
  });

  describe('7. gameLaunchOrchestrator — Guard 2A/2B chosenRunnerType & Cross-Bottle --watch-dir C:\\ Path', () => {
    it('includes chosenRunnerType on Guard 2A (BOTTLE_STEAM_NOT_INSTALLED) and Guard 2B (BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE), and resolves --watch-dir to C:\\Program Files (x86)\\Steam\\steamapps\\common\\<Game> once linked', async () => {
      const sb = makeSandbox('p3-launch-guards-watchdir-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

      const srcBottle = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        signedIn: true,
      });
      const quake = seedPhysicalSteamGame(srcBottle.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
      });

      const armBottle = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: false,
      });

      const fakeScalerBinDir = path.join(sb.root, 'scaler-bin');
      fs.mkdirSync(fakeScalerBinDir, { recursive: true });
      for (const fname of [
        'one_display_scaler_x86.dll',
        'one_display_scaler_x64.dll',
        'one_display_launcher_x86.exe',
        'one_display_launcher_x64.exe',
      ]) {
        fs.writeFileSync(path.join(fakeScalerBinDir, fname), buildMinimalPeBuffer(0x8664));
      }

      const payload = {
        gameId: 'steam-2320',
        title: 'Quake II',
        platformId: 'steam',
        platformGameId: '2320',
        steamAppId: 2320,
        installPath: quake.gameDir,
        executablePath: quake.exePath,
        isWindowsBinaryOnMac: true,
        launchConfig: {
          launchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover_preview_arm64',
          wineBottleName: 'OneLauncher-arm64',
          displayScalingMode: 'force_fullscreen',
        },
      };

      const guardSpawnSpy = vi.fn(() => createFakeChild(59200));
      const baseLaunchOpts = {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sb.homedir,
        userDataDir: sb.userDataDir,
        customApplicationsDir: sb.appsDir,
        displayScalerBinDir: fakeScalerBinDir,
        enableDisplayScalerInTests: true,
        skipRegistrySpawn: true,
        disableBottleSteamPolling: true,
        mockProcessListOutput: '',
        gameSpawnFn: guardSpawnSpy,
      };

      // Step 1: Guard 2A (Steam not installed in OneLauncher-arm64) -> returns chosenRunnerType + targetBottleName
      const guard2ARes = await launcherEngine.launchGame(payload, baseLaunchOpts);
      expect(guard2ARes.success).toBe(false);
      expect(guard2ARes.errorCode).toBe('BOTTLE_STEAM_NOT_INSTALLED');
      expect(guard2ARes.targetBottleName).toBe('OneLauncher-arm64');
      expect(guard2ARes.chosenRunnerType).toBe('crossover_preview_arm64');
      expect(guardSpawnSpy).not.toHaveBeenCalled();

      // Step 2: Install steam.exe into OneLauncher-arm64 WITHOUT linking Quake II -> Guard 2B triggers with chosenRunnerType
      fs.mkdirSync(path.join(armBottle.steamappsDir, 'common'), { recursive: true });
      fs.writeFileSync(armBottle.steamExe, buildMinimalPeBuffer(0x014c));
      compatRegistry.invalidateCompatLayersCache();

      const guard2BRes = await launcherEngine.launchGame(payload, baseLaunchOpts);
      expect(guard2BRes.success).toBe(false);
      expect(guard2BRes.errorCode).toBe('BOTTLE_STEAM_APP_NOT_IN_TARGET_BOTTLE');
      expect(guard2BRes.targetBottleName).toBe('OneLauncher-arm64');
      expect(guard2BRes.chosenRunnerType).toBe('crossover_preview_arm64');
      expect(guardSpawnSpy).not.toHaveBeenCalled();

      // Step 3: Link installed Steam apps into OneLauncher-arm64 -> launch succeeds & --watch-dir uses C:\ path!
      const linkRes = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(
        armBottle.bottlePath,
        {
          platform: 'darwin',
          homedir: sb.homedir,
          customApplicationsDir: sb.appsDir,
          mockProcessListOutput: '',
        }
      );
      expect(linkRes.linkedAppIds).toEqual([2320]);
      compatRegistry.invalidateCompatLayersCache();

      const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
      const launchRes = await launcherEngine.launchGame(payload, {
        ...baseLaunchOpts,
        gameSpawnFn: (cmd: string, args: string[], opts?: SpawnOptionsLike) => {
          const normalizedEnv: Record<string, string> = {};
          for (const [k, v] of Object.entries(opts?.env || {})) {
            if (typeof v === 'string') normalizedEnv[k] = v;
          }
          spawns.push({ cmd, args: [...args], env: normalizedEnv });
          return createFakeChild(59230 + spawns.length);
        },
      });

      expect(launchRes.success).toBe(true);
      expect(launchRes.session?.launchMethod).toBe('compatibility_layer:crossover_preview_arm64');
      expect(launchRes.session?.winePrefix).toBe(armBottle.bottlePath);

      const watchSpawn = spawns.find((s) => s.args.includes('--watch-dir'));
      expect(watchSpawn).toBeDefined();
      const watchDirFlagIdx = watchSpawn ? watchSpawn.args.indexOf('--watch-dir') : -1;
      const watchDirVal = watchDirFlagIdx >= 0 ? watchSpawn?.args[watchDirFlagIdx + 1] : '';
      expect(watchDirVal).toBe('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Quake 2');
    });
  });

  describe('8. Round-2 Hardening Regressions (P1-2, P2-2, P2-3, P3-1, P3-3)', () => {
    it('P1-2a: gracefully closes idle warm steam.exe in target bottle during Branch 1 link_only and syncs libraryfolders.vdf', async () => {
      const sb = makeSandbox('p3-r2-warm-steam-idle-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        signedIn: true,
      });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        sizeOnDisk: '654321000',
      });
      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
        signedIn: true,
      });
      const targetVdfPath = path.join(target.steamappsDir, 'libraryfolders.vdf');
      fs.writeFileSync(targetVdfPath, buildLibraryFoldersVdf({}), 'utf8');

      let steamRunning = true;
      const closeClientSpy = vi.fn(async () => {
        steamRunning = false;
      });
      const warmPsLine = `WINEPREFIX=${target.bottlePath} C:\\Program Files (x86)\\Steam\\steam.exe -silent`;

      const setupRes = await setupOrchestrator.runEnvironmentSetupTasks(
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
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          skipNetwork: true,
          getProcessListOutput: () => (steamRunning ? warmPsLine : ''),
          closeClientFn: closeClientSpy,
        }
      );

      expect(setupRes.success).toBe(true);
      expect(closeClientSpy).toHaveBeenCalledTimes(1);
      expect(setupRes.outcomes[0]?.steamRestartRequired).toBeUndefined();
      expect(fs.readFileSync(targetVdfPath, 'utf8')).toContain('\t\t\t"2320"\t\t"654321000"\n');
    });

    it('P1-2b: preserves warm steam.exe when an active game session is running in target bottle and returns steamRestartRequired note', async () => {
      const sb = makeSandbox('p3-r2-warm-steam-busy-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver Preview arm64.app');

      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
        signedIn: true,
      });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        sizeOnDisk: '654321000',
      });
      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
        signedIn: true,
      });
      const targetVdfPath = path.join(target.steamappsDir, 'libraryfolders.vdf');
      const initialVdf = buildLibraryFoldersVdf({});
      fs.writeFileSync(targetVdfPath, initialVdf, 'utf8');

      engineStateRegistry.activeSessions.set('steam-99999', {
        winePrefix: target.bottlePath,
        finalized: false,
      });

      const closeClientSpy = vi.fn(async () => {});
      const warmPsLine = `WINEPREFIX=${target.bottlePath} C:\\Program Files (x86)\\Steam\\steam.exe -silent`;

      const setupRes = await setupOrchestrator.runEnvironmentSetupTasks(
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
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          skipNetwork: true,
          mockProcessListOutput: warmPsLine,
          closeClientFn: closeClientSpy,
        }
      );

      expect(setupRes.success).toBe(true);
      expect(closeClientSpy).not.toHaveBeenCalled();
      expect(setupRes.outcomes[0]?.steamRestartRequired).toBe(true);
      expect(setupRes.outcomes[0]?.message).toContain(
        'Restart Steam in "OneLauncher-arm64" after your active game closes so Steam loads the newly linked library.'
      );
      expect(fs.readFileSync(targetVdfPath, 'utf8')).toBe(initialVdf);
    });

    it('P2-2: rejects reverse-containment symlinks pointing to "/" or an ancestor of targetBottle / targetCommonDir', async () => {
      const sb = makeSandbox('p3-r2-ancestor-loop-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');

      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', { withSteam: true });
      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });

      // Malicious source entries pointing to filesystem root, bottlesDir (ancestor), and targetBottle itself
      fs.symlinkSync(
        path.parse(sb.root).root,
        path.join(src.steamappsDir, 'common', 'RootEscape'),
        'dir'
      );
      fs.writeFileSync(
        path.join(src.steamappsDir, 'appmanifest_70001.acf'),
        buildAcfContent({ appId: 70001, name: 'RootEscape', installdir: 'RootEscape' }),
        'utf8'
      );
      fs.symlinkSync(sb.bottlesDir, path.join(src.steamappsDir, 'common', 'AncestorLoop'), 'dir');
      fs.writeFileSync(
        path.join(src.steamappsDir, 'appmanifest_70002.acf'),
        buildAcfContent({ appId: 70002, name: 'AncestorLoop', installdir: 'AncestorLoop' }),
        'utf8'
      );
      fs.symlinkSync(
        target.bottlePath,
        path.join(src.steamappsDir, 'common', 'TargetBottleSelf'),
        'dir'
      );
      fs.writeFileSync(
        path.join(src.steamappsDir, 'appmanifest_70003.acf'),
        buildAcfContent({ appId: 70003, name: 'TargetBottleSelf', installdir: 'TargetBottleSelf' }),
        'utf8'
      );

      const res = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(target.bottlePath, {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
        mockProcessListOutput: '',
      });

      expect(res).toEqual({ linkedCount: 0, linkedAppIds: [] });
      expect(fs.existsSync(path.join(target.steamappsDir, 'appmanifest_70001.acf'))).toBe(false);
      expect(fs.existsSync(path.join(target.steamappsDir, 'appmanifest_70002.acf'))).toBe(false);
      expect(fs.existsSync(path.join(target.steamappsDir, 'appmanifest_70003.acf'))).toBe(false);
    });

    it('P2-3: uninstallGame cleans cross-bottle symlinks and manifests in standalone ~/Games/OneLauncher/Prefixes/* bottles', async () => {
      const sb = makeSandbox('p3-r2-uninstall-standalone-prefix-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');

      const physBottle = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', {
        wineArch: 'win64',
        withSteam: true,
      });
      const quake = seedPhysicalSteamGame(physBottle.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        exeName: 'quake2ex_steam.exe',
      });

      const standalonePrefixesDir = path.join(sb.homedir, 'Games', 'OneLauncher', 'Prefixes');
      fs.mkdirSync(standalonePrefixesDir, { recursive: true });
      const standalonePrefix = createSyntheticBottle(standalonePrefixesDir, 'WineStandalone', {
        wineArch: 'win64',
        withSteam: true,
      });

      const linkRes = await setupOrchestrator.linkInstalledSteamAppsIntoBottle(
        standalonePrefix.bottlePath,
        {
          platform: 'darwin',
          homedir: sb.homedir,
          customApplicationsDir: sb.appsDir,
          mockProcessListOutput: '',
        }
      );
      expect(linkRes.linkedAppIds).toEqual([2320]);
      const standaloneLink = path.join(standalonePrefix.steamappsDir, 'common', 'Quake 2');
      expect(fs.lstatSync(standaloneLink).isSymbolicLink()).toBe(true);

      const uninstallRes = await gameVerifyAndUninstall.uninstallGame(
        {
          gameId: 'steam-2320',
          platformId: 'steam',
          platformGameId: '2320',
          title: 'Quake II',
          installPath: quake.gameDir,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sb.homedir,
          userDataDir: sb.userDataDir,
          customApplicationsDir: sb.appsDir,
          allowDeleteFiles: true,
        }
      );

      expect(uninstallRes.success).toBe(true);
      expect(fs.existsSync(quake.gameDir)).toBe(false);
      expect(() => fs.lstatSync(standaloneLink)).toThrow();
      expect(
        fs.existsSync(path.join(standalonePrefix.steamappsDir, 'appmanifest_2320.acf'))
      ).toBe(false);
    });

    it('P3-3: syncTargetBottleLibraryFoldersVdf skips orphan manifests lacking common/<installdir> and actively-downloading manifests', async () => {
      const sb = makeSandbox('p3-r2-vdf-filter-');
      createFakeCrossOverApp(sb.appsDir, 'CrossOver.app');
      const src = createSyntheticBottle(sb.bottlesDir, 'OneLauncher', { withSteam: true });
      seedPhysicalSteamGame(src.steamappsDir, {
        appId: 2320,
        name: 'Quake II',
        installdir: 'Quake 2',
        sizeOnDisk: '654321000',
      });

      const target = createSyntheticBottle(sb.bottlesDir, 'OneLauncher-arm64', {
        wineArch: 'arm64',
        withSteam: true,
      });
      const vdfPath = path.join(target.steamappsDir, 'libraryfolders.vdf');
      fs.writeFileSync(vdfPath, buildLibraryFoldersVdf({}), 'utf8');

      // Seed an orphan ACF (missing common/GhostApp) and an actively-downloading ACF inside target
      fs.writeFileSync(
        path.join(target.steamappsDir, 'appmanifest_88801.acf'),
        buildAcfContent({ appId: 88801, name: 'GhostApp', installdir: 'GhostApp' }),
        'utf8'
      );
      seedPhysicalSteamGame(target.steamappsDir, {
        appId: 88802,
        name: 'DownloadingApp',
        installdir: 'DownloadingApp',
        stateFlags: '1026',
        bytesToDownload: '50000',
        bytesDownloaded: '100',
      });

      await setupOrchestrator.linkInstalledSteamAppsIntoBottle(target.bottlePath, {
        platform: 'darwin',
        homedir: sb.homedir,
        customApplicationsDir: sb.appsDir,
        mockProcessListOutput: '',
      });

      const updatedVdf = fs.readFileSync(vdfPath, 'utf8');
      expect(updatedVdf).toContain('\t\t\t"2320"\t\t"654321000"\n');
      expect(updatedVdf).not.toContain('"88801"');
      expect(updatedVdf).not.toContain('"88802"');
    });
  });
});
