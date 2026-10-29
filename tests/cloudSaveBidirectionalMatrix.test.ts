import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { resolveEffectiveLaunchPolicy as resolveEffectiveLaunchPolicyTs } from '../src/contracts/launchPolicyResolver';
import { computeFastMinimalLaunchAdvisory } from '../src/services/launcher/launchPolicyPreview';
import { FastLaunchWarningBanner } from '../src/components/Launcher/LaunchConfig/FastLaunchWarningBanner';

const require = createRequire(import.meta.url);
const launcherEngine = require('../electron/launcherEngine.cjs');
const cloudSaveModule = require('../electron/launcher/cloudSaveEngine.cjs');

function createMockChildProcess(pid = 71001) {
  const proc: any = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stderr.destroyed = true;
  proc.stderr.readable = false;
  proc.killed = false;
  proc.unref = vi.fn();
  proc.kill = vi.fn((sig?: string) => {
    proc.killed = true;
    setImmediate(() => proc.emit('exit', 0, sig || 'SIGTERM'));
    return true;
  });
  return proc;
}

function createFakePeBinary(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.alloc(512, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x8664, 0x84);
  fs.writeFileSync(filePath, buf);
}

function createFakeMachOBinary(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.alloc(128, 0);
  buf.writeUInt32LE(0xfeedfacf, 0);
  fs.writeFileSync(filePath, buf, { mode: 0o755 });
}

function makeJsonResponse(data: any, status = 200) {
  const rawBuf = Buffer.from(JSON.stringify(data), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => rawBuf.toString('utf8'),
    arrayBuffer: async () =>
      rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength),
  };
}

function setupMockCrossOverEnvironment(
  rootDir: string,
  homeRoot: string,
  bottleName = 'SteamBottle',
  includeBottleSteam = false
) {
  const appsDir = path.join(rootDir, 'FakeApplications');
  const crossoverApp = path.join(appsDir, 'CrossOver.app');
  const macosDir = path.join(crossoverApp, 'Contents', 'MacOS');
  const wineBinDir = path.join(crossoverApp, 'Contents', 'SharedSupport', 'CrossOver', 'bin');
  const bottlesRoot = path.join(
    homeRoot,
    'Library',
    'Application Support',
    'CrossOver',
    'Bottles'
  );
  const bottlePath = path.join(bottlesRoot, bottleName);

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(wineBinDir, { recursive: true });
  fs.writeFileSync(path.join(macosDir, 'CrossOver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(wineBinDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(wineBinDir, 'wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(crossoverApp, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>25.0.0</string>
</dict></plist>`
  );

  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'windows', 'system32'), { recursive: true });
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'users', 'crossover', 'Documents'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'users', 'crossover', 'Saved Games'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'users', 'crossover', 'AppData', 'Local'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'users', 'crossover', 'AppData', 'LocalLow'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(bottlePath, 'drive_c', 'users', 'crossover', 'AppData', 'Roaming'), {
    recursive: true,
  });

  let bottleSteamExe = '';
  let bottleSteamRoot = '';
  if (includeBottleSteam) {
    bottleSteamRoot = path.join(bottlePath, 'drive_c', 'Program Files (x86)', 'Steam');
    bottleSteamExe = path.join(bottleSteamRoot, 'steam.exe');
    createFakePeBinary(bottleSteamExe);
    fs.mkdirSync(path.join(bottleSteamRoot, 'logs'), { recursive: true });
  }

  return {
    appsDir,
    cxBin: path.join(wineBinDir, 'wine'),
    crossoverApp,
    bottlesRoot,
    bottlePath,
    bottleSteamRoot,
    bottleSteamExe,
  };
}

describe('Bidirectional Cloud Save Matrix (Steam, GOG & Epic across macOS, CrossOver/Wine & Windows)', () => {
  let tmpDir: string;
  let userDataDir: string;
  let homedir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cloud-matrix-'));
    userDataDir = path.join(tmpDir, 'userData');
    homedir = path.join(tmpDir, 'home_player_one');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(homedir, { recursive: true });

    launcherEngine.setUserDataDir(userDataDir);
    launcherEngine.clearCachedWindowsKnownFolders();
    launcherEngine.clearDownloadQueue();
  });

  afterEach(() => {
    launcherEngine.shutdownLauncherEngine();
    launcherEngine.clearDownloadQueue();
    launcherEngine.clearCachedWindowsKnownFolders();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // Suite 1: OS Metadata Hygiene & Empty-Folder post_exit Upload Guard (Fix 1)
  // ==========================================================================
  describe('Suite 1: OS Metadata Hygiene & Empty-Folder post_exit Upload Guard', () => {
    it('1.1 purges .DS_Store, ._*, Thumbs.db, and desktop.ini recursively without traversing symlinks', () => {
      const saveRoot = path.join(tmpDir, 'SaveDirHygiene');
      const nestedSlot = path.join(saveRoot, 'SlotA');
      const outsideTarget = path.join(tmpDir, 'OutsideLinkedFolder');
      fs.mkdirSync(nestedSlot, { recursive: true });
      fs.mkdirSync(outsideTarget, { recursive: true });

      // Outside symlink target has a .DS_Store and real file that MUST NOT be touched or counted
      fs.writeFileSync(path.join(outsideTarget, '.DS_Store'), 'outside_junk');
      fs.writeFileSync(path.join(outsideTarget, 'external.sav'), 'external_save');
      fs.symlinkSync(outsideTarget, path.join(saveRoot, 'linked_outside'));

      // Inside saveRoot: 4 OS junk files + 2 real save files
      fs.writeFileSync(path.join(saveRoot, '.DS_Store'), 'mac_finder');
      fs.writeFileSync(path.join(saveRoot, '._slot0.sav'), 'appledouble');
      fs.writeFileSync(path.join(nestedSlot, 'Thumbs.db'), 'win_thumbs');
      fs.writeFileSync(path.join(nestedSlot, 'desktop.ini'), 'win_desktop_ini');
      fs.writeFileSync(path.join(saveRoot, 'slot0.sav'), 'real_save_0');
      fs.writeFileSync(path.join(nestedSlot, 'profile.json'), '{"level":12}');

      const res = cloudSaveModule.purgeOsMetadataAndCountRealFilesSync(saveRoot);
      expect(res).toEqual({
        exists: true,
        purgedCount: 4,
        realFileCount: 2,
      });

      expect(fs.existsSync(path.join(saveRoot, '.DS_Store'))).toBe(false);
      expect(fs.existsSync(path.join(saveRoot, '._slot0.sav'))).toBe(false);
      expect(fs.existsSync(path.join(nestedSlot, 'Thumbs.db'))).toBe(false);
      expect(fs.existsSync(path.join(nestedSlot, 'desktop.ini'))).toBe(false);
      expect(fs.existsSync(path.join(saveRoot, 'slot0.sav'))).toBe(true);
      expect(fs.existsSync(path.join(nestedSlot, 'profile.json'))).toBe(true);

      // Symlink target was untouched
      expect(fs.existsSync(path.join(outsideTarget, '.DS_Store'))).toBe(true);
      expect(fs.existsSync(path.join(outsideTarget, 'external.sav'))).toBe(true);
    });

    it('1.2 strips OS junk before both pre_launch and post_exit in syncGogCloudSaves and syncEpicCloudSaves', async () => {
      // A) GOG pre_launch & post_exit hygiene
      const gogSaveDir = path.join(homedir, 'Documents', 'GogCleanGame');
      fs.mkdirSync(gogSaveDir, { recursive: true });
      fs.writeFileSync(path.join(gogSaveDir, '.DS_Store'), 'junk');
      fs.writeFileSync(path.join(gogSaveDir, '._hero.sav'), 'junk');
      fs.writeFileSync(path.join(gogSaveDir, 'hero.sav'), 'save_v1');

      const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
      fs.writeFileSync(gogAuthPath, '{}');

      const gogFilesSeenDuringCli: string[][] = [];
      const gogExecImpl = vi.fn((_cmd: string, _args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        gogFilesSeenDuringCli.push(fs.readdirSync(gogSaveDir).sort());
        callback?.(null, '1790000100\n', '');
      });

      const gogRemoteOverride = {
        content: {
          MacOS: {
            cloudStorage: {
              enabled: true,
              locations: [{ name: 'saves', location: '<?DOCUMENTS?>/GogCleanGame' }],
            },
          },
        },
      };

      const gogPre = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '18801', gogClientId: 'real_gog_cid_18801' },
        'pre_launch',
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: gogRemoteOverride,
          execFileImpl: gogExecImpl,
        }
      );
      expect(gogPre.synced).toBe(true);

      // Re-introduce Windows & macOS junk during gameplay before post_exit
      fs.writeFileSync(path.join(gogSaveDir, 'Thumbs.db'), 'junk');
      fs.writeFileSync(path.join(gogSaveDir, 'desktop.ini'), 'junk');
      const gogPost = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '18801', gogClientId: 'real_gog_cid_18801' },
        'post_exit',
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: gogRemoteOverride,
          execFileImpl: gogExecImpl,
        }
      );
      expect(gogPost.synced).toBe(true);
      expect(gogFilesSeenDuringCli).toEqual([['hero.sav'], ['hero.sav']]);

      // B) Epic pre_launch & post_exit hygiene
      const epicSaveDir = path.join(homedir, 'Documents', 'EpicCleanGame');
      fs.mkdirSync(epicSaveDir, { recursive: true });
      fs.writeFileSync(path.join(epicSaveDir, '.DS_Store'), 'junk');
      fs.writeFileSync(path.join(epicSaveDir, 'slot1.sav'), 'epic_save_v1');

      const legCfgDir = path.join(userDataDir, 'legCfg');
      fs.mkdirSync(legCfgDir, { recursive: true });

      const epicFilesSeenDuringCli: string[][] = [];
      const epicExecImpl = vi.fn((_cmd: string, _args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        epicFilesSeenDuringCli.push(fs.readdirSync(epicSaveDir).sort());
        callback?.(null, 'Sync complete', '');
      });

      const epicPre = await launcherEngine.syncEpicCloudSaves(
        { platformId: 'epic', appName: 'EpicCleanApp' },
        'pre_launch',
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          cloudSaveFolderTemplate: '{UserDir}/EpicCleanGame',
          execFileImpl: epicExecImpl,
        }
      );
      expect(epicPre.synced).toBe(true);

      fs.writeFileSync(path.join(epicSaveDir, '._slot1.sav'), 'appledouble');
      const epicPost = await launcherEngine.syncEpicCloudSaves(
        { platformId: 'epic', appName: 'EpicCleanApp' },
        'post_exit',
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          cloudSaveFolderTemplate: '{UserDir}/EpicCleanGame',
          execFileImpl: epicExecImpl,
        }
      );
      expect(epicPost.synced).toBe(true);
      expect(epicFilesSeenDuringCli).toEqual([['slot1.sav'], ['slot1.sav']]);
    });

    it('1.3 blocks empty-folder post_exit uploads (when folder only had OS junk or 0 real files) with zero warning telemetry', async () => {
      // GOG save folder with ONLY .DS_Store & ._save.dat
      const gogEmptySaveDir = path.join(homedir, 'Documents', 'GogEmptyAfterPurge');
      fs.mkdirSync(gogEmptySaveDir, { recursive: true });
      fs.writeFileSync(path.join(gogEmptySaveDir, '.DS_Store'), 'junk');
      fs.writeFileSync(path.join(gogEmptySaveDir, '._save.dat'), 'junk');

      const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
      fs.writeFileSync(gogAuthPath, '{}');
      const gogExecSpy = vi.fn();

      const gogPostEmpty = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '18802', gogClientId: 'real_gog_cid_18802' },
        'post_exit',
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: {
            content: {
              MacOS: {
                cloudStorage: {
                  enabled: true,
                  locations: [{ name: 'saves', location: '<?DOCUMENTS?>/GogEmptyAfterPurge' }],
                },
              },
            },
          },
          execFileImpl: gogExecSpy,
        }
      );
      expect(gogPostEmpty).toMatchObject({
        synced: false,
        reason: 'nothing_to_sync',
      });
      expect(gogExecSpy).not.toHaveBeenCalled();
      expect(fs.readdirSync(gogEmptySaveDir)).toEqual([]);
      expect(
        cloudSaveModule.buildCloudSyncTelemetryPayload({
          gameId: 'gog-18802',
          platformId: 'gog',
          direction: 'post_exit',
          syncResult: gogPostEmpty,
        })
      ).toBeNull();

      // Epic save folder with ONLY Thumbs.db & desktop.ini
      const epicEmptySaveDir = path.join(homedir, 'Documents', 'EpicEmptyAfterPurge');
      fs.mkdirSync(epicEmptySaveDir, { recursive: true });
      fs.writeFileSync(path.join(epicEmptySaveDir, 'Thumbs.db'), 'junk');
      fs.writeFileSync(path.join(epicEmptySaveDir, 'desktop.ini'), 'junk');

      const legCfgDir = path.join(userDataDir, 'legCfgEmpty');
      fs.mkdirSync(legCfgDir, { recursive: true });
      const epicExecSpy = vi.fn();

      const epicPostEmpty = await launcherEngine.syncEpicCloudSaves(
        { platformId: 'epic', appName: 'EpicEmptyApp' },
        'post_exit',
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          enforceEmptySaveGuard: true,
          cloudSaveFolderTemplate: '{UserDir}/EpicEmptyAfterPurge',
          execFileImpl: epicExecSpy,
        }
      );
      expect(epicPostEmpty).toMatchObject({
        synced: false,
        reason: 'nothing_to_sync',
      });
      expect(epicExecSpy).not.toHaveBeenCalled();
      expect(fs.readdirSync(epicEmptySaveDir)).toEqual([]);
      expect(
        cloudSaveModule.buildCloudSyncTelemetryPayload({
          gameId: 'epic-EpicEmptyApp',
          platformId: 'epic',
          direction: 'post_exit',
          syncResult: epicPostEmpty,
        })
      ).toBeNull();
    });
  });

  // ==========================================================================
  // Suite 2: GOG 46899977096215655 Launcher-ID Bypass & Per-Game clientId (Fix 2)
  // ==========================================================================
  describe('Suite 2: GOG 46899977096215655 Launcher-ID Bypass & Per-Game clientId Resolution', () => {
    it('2.1 ignores poisoned 46899977096215655 in goggame-<id>.info and resolves real per-game clientId across darwin native, CrossOver bottle, and win32', async () => {
      const poisonedLauncherId = cloudSaveModule.GOG_GALAXY_LAUNCHER_CLIENT_ID;
      expect(poisonedLauncherId).toBe('46899977096215655');

      const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
      fs.writeFileSync(gogAuthPath, '{}');

      const cx = setupMockCrossOverEnvironment(tmpDir, homedir, 'GogBottle', false);

      // 1) macOS native install poisoned with 46899977096215655 -> resolves via /os/osx/builds
      const macInstallDir = path.join(tmpDir, 'GogMacNative');
      fs.mkdirSync(macInstallDir, { recursive: true });
      fs.writeFileSync(
        path.join(macInstallDir, 'goggame-145001.info'),
        JSON.stringify({ gameId: '145001', clientId: poisonedLauncherId })
      );
      const macSaveDir = path.join(homedir, 'Documents', 'Save145001');
      fs.mkdirSync(macSaveDir, { recursive: true });
      fs.writeFileSync(path.join(macSaveDir, 'run.sav'), 'mac_save');

      // 2) CrossOver bottle install poisoned with 46899977096215655 -> resolves via /os/windows/builds -> repo link fallback
      const bottleInstallDir = path.join(cx.bottlePath, 'drive_c', 'GOG Games', 'Bottle145002');
      fs.mkdirSync(bottleInstallDir, { recursive: true });
      fs.writeFileSync(
        path.join(bottleInstallDir, 'goggame-145002.info'),
        JSON.stringify({ gameId: '145002', clientId: poisonedLauncherId })
      );
      const bottleSaveDir = path.join(
        cx.bottlePath,
        'drive_c',
        'users',
        'crossover',
        'Documents',
        'Save145002'
      );
      fs.mkdirSync(bottleSaveDir, { recursive: true });
      fs.writeFileSync(path.join(bottleSaveDir, 'run.sav'), 'bottle_save');

      // 3) Windows native install poisoned with 46899977096215655 -> resolves via /os/windows/builds
      const winInstallDir = path.join(tmpDir, 'GogWinNative');
      fs.mkdirSync(winInstallDir, { recursive: true });
      fs.writeFileSync(
        path.join(winInstallDir, 'goggame-145003.info'),
        JSON.stringify({ gameId: '145003', clientId: poisonedLauncherId })
      );
      const winDocsDir = 'C:\\Users\\TestUser\\Documents';

      const requestedUrls: string[] = [];
      const mockFetch = vi.fn(async (url: string) => {
        const u = String(url);
        requestedUrls.push(u);
        if (u.includes(poisonedLauncherId)) {
          throw new Error(`Poisoned Galaxy launcher clientId ${poisonedLauncherId} must NEVER be queried!`);
        }
        if (u.includes('/products/145001/os/osx/builds?generation=2')) {
          return makeJsonResponse({
            items: [{ clientId: 'real_osx_client_145001', generation: 2 }],
          });
        }
        if (u.includes('/products/145002/os/windows/builds?generation=2')) {
          return makeJsonResponse({
            items: [
              {
                clientId: poisonedLauncherId, // Even if builds item[0] had launcher ID, fallback to repo link!
                link: 'https://cdn.gog.test/145002/repo.json',
              },
            ],
          });
        }
        if (u === 'https://cdn.gog.test/145002/repo.json') {
          return makeJsonResponse({
            product: { clientId: 'real_bottle_client_145002' },
          });
        }
        if (u.includes('/products/145003/os/windows/builds?generation=2')) {
          return makeJsonResponse({
            items: [{ clientId: 'real_win32_client_145003', generation: 2 }],
          });
        }
        if (u.includes('/clients/real_osx_client_145001')) {
          return makeJsonResponse({
            content: {
              MacOS: {
                cloudStorage: {
                  enabled: true,
                  locations: [{ name: 'saves', location: '<?DOCUMENTS?>/Save145001' }],
                },
              },
            },
          });
        }
        if (u.includes('/clients/real_bottle_client_145002')) {
          return makeJsonResponse({
            content: {
              Windows: {
                cloudStorage: {
                  enabled: true,
                  locations: [{ name: 'saves', location: '<?DOCUMENTS?>/Save145002' }],
                },
              },
            },
          });
        }
        if (u.includes('/clients/real_win32_client_145003')) {
          return makeJsonResponse({
            content: {
              Windows: {
                cloudStorage: {
                  enabled: true,
                  locations: [{ name: 'saves', location: '<?DOCUMENTS?>/Save145003' }],
                },
              },
            },
          });
        }
        return makeJsonResponse({}, 404);
      });

      const seenGogArgs: string[][] = [];
      const execFileImpl = vi.fn((_cmd: string, args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        seenGogArgs.push(args);
        callback?.(null, '1790000555\n', '');
      });

      // Run macOS native bidirectional sync (pre_launch + post_exit)
      const macPre = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '145001', installPath: macInstallDir },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          fetchImpl: mockFetch,
          execFileImpl,
        }
      );
      const macPost = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '145001', installPath: macInstallDir },
        'post_exit',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          fetchImpl: mockFetch,
          execFileImpl,
        }
      );
      expect(macPre.synced).toBe(true);
      expect(macPre.clientId).toBe('real_osx_client_145001');
      expect(macPost.synced).toBe(true);

      // Run CrossOver bottle bidirectional sync
      const bottlePre = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '145002', installPath: bottleInstallDir },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: cx.bottlePath,
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          fetchImpl: mockFetch,
          execFileImpl,
        }
      );
      const bottlePost = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '145002', installPath: bottleInstallDir },
        'post_exit',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: cx.bottlePath,
          homedir,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          fetchImpl: mockFetch,
          execFileImpl,
        }
      );
      expect(bottlePre.synced).toBe(true);
      expect(bottlePre.clientId).toBe('real_bottle_client_145002');
      expect(bottlePost.synced).toBe(true);

      // Run win32 pre_launch sync
      const winPre = await launcherEngine.syncGogCloudSaves(
        { platformId: 'gog', platformGameId: '145003', installPath: winInstallDir },
        'pre_launch',
        {
          platform: 'win32',
          useCompatLayer: false,
          homedir: 'C:\\Users\\TestUser',
          windowsKnownFolders: {
            homedir: 'C:\\Users\\TestUser',
            documents: winDocsDir,
            savedGames: 'C:\\Users\\TestUser\\Saved Games',
            localAppData: 'C:\\Users\\TestUser\\AppData\\Local',
            localLowAppData: 'C:\\Users\\TestUser\\AppData\\LocalLow',
            roamingAppData: 'C:\\Users\\TestUser\\AppData\\Roaming',
          },
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          fetchImpl: mockFetch,
          execFileImpl,
        }
      );
      expect(winPre.synced).toBe(true);
      expect(winPre.clientId).toBe('real_win32_client_145003');
      expect(winPre.locations[0].resolvedPath).toBe('C:\\Users\\TestUser\\Documents\\Save145003');

      expect(requestedUrls.some((u) => u.includes(poisonedLauncherId))).toBe(false);
      expect(seenGogArgs[0]).toContain('--skip-upload');
      expect(seenGogArgs[1]).toContain('--skip-download');
    });

    it('2.2 caches __productClientIds in one_launcher_gog_cloud_configs.json and preserves them across pruneGogCloudConfigsMap while stripping poisoned IDs', () => {
      const bigMap: Record<string, any> = {
        __productClientIds: {
          '145001': 'real_osx_client_145001',
          '145002': 'real_bottle_client_145002',
          '999999': '46899977096215655', // Poisoned entry must be stripped!
        },
      };
      for (let i = 0; i < 280; i++) {
        bigMap[`cid_${i}`] = {
          fetchedAt: 1000 + i,
          lastAccessedAt: 1000 + i,
          config: { content: {} },
        };
      }

      const pruned = cloudSaveModule.pruneGogCloudConfigsMap(bigMap, 250);
      const configKeys = Object.keys(pruned).filter((k) => k !== '__productClientIds');
      expect(configKeys.length).toBe(250);
      expect(pruned.__productClientIds).toEqual({
        '145001': 'real_osx_client_145001',
        '145002': 'real_bottle_client_145002',
      });
    });
  });

  // ==========================================================================
  // Suite 3: Two-Stage Cold Steam Startup (Bottle, macOS Native & win32 Native) (Fix 3)
  // ==========================================================================
  describe('Suite 3: Two-Stage Cold Steam Startup (Bottle Steam, macOS Native & win32 Native)', () => {
    it('3.1 CrossOver Bottle Steam cold boot spawns Stage 1 (-silent), waits for OnRemoteStorageSyncedClient + AppID Download complete + settle window, then spawns Stage 2 (-applaunch)', async () => {
      const cx = setupMockCrossOverEnvironment(tmpDir, homedir, 'ColdSteamBottle', true);
      const gameExe = path.join(
        cx.bottleSteamRoot,
        'steamapps',
        'common',
        'Portal2',
        'portal2.exe'
      );
      createFakePeBinary(gameExe);

      const cloudLogPath = path.join(cx.bottleSteamRoot, 'logs', 'cloud_log.txt');
      fs.writeFileSync(cloudLogPath, '[2026-10-23 09:00:00] Old boot log\n', 'utf8');

      const timeline: string[] = [];
      const sessionEvents: any[] = [];
      const unsub = launcherEngine.onSessionUpdated((ev: any) => sessionEvents.push(ev));

      const gameSpawnFn = vi.fn((bin: string, args: string[]) => {
        const argList = args || [];
        if (argList.includes('-silent') && !argList.includes('-applaunch')) {
          timeline.push('stage1:spawn_silent');
          // Simulate Steam booting, syncing client manifest, then downloading AppID 620 cloud saves!
          setTimeout(() => {
            timeline.push('log:client_synced_and_download_queued');
            fs.appendFileSync(
              cloudLogPath,
              '[2026-10-23 12:00:01] OnRemoteStorageSyncedClient() - result OK\n' +
                '[2026-10-23 12:00:01] [AppID 620] Need to download file "save/autosave.sav"\n' +
                '[2026-10-23 12:00:01] [AppID 620] Eval complete\n' +
                '[2026-10-23 12:00:01] [AppID 620] Starting sync (down,)\n',
              'utf8'
            );
          }, 25);
          setTimeout(() => {
            timeline.push('log:download_complete');
            fs.appendFileSync(
              cloudLogPath,
              '[2026-10-23 12:00:02] [AppID 620] Download complete, result OK\n',
              'utf8'
            );
          }, 65);
          return createMockChildProcess(72001);
        }
        if (argList.includes('-applaunch')) {
          timeline.push(`stage2:applaunch_${argList[argList.indexOf('-applaunch') + 1]}`);
          return createMockChildProcess(72002);
        }
        timeline.push(`other_spawn:${path.basename(bin)}`);
        return createMockChildProcess(72003);
      });

      const shutdownCmds: string[] = [];
      const execFileImpl = vi.fn((cmd: string, args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if ((args || []).includes('-shutdown')) {
          shutdownCmds.push(`${path.basename(cmd)} ${(args || []).join(' ')}`);
        }
        callback?.(null, '', '');
      });

      try {
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'steam-620',
            title: 'Portal 2',
            platformId: 'steam',
            platformGameId: '620',
            steamAppId: 620,
            installPath: path.dirname(gameExe),
            executablePath: gameExe,
            isWindowsBinaryOnMac: true,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'ColdSteamBottle',
              winePrefixPath: cx.bottlePath,
              storefrontClientLifecycle: 'minimal_and_close_if_started',
            },
          },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            customApplicationsDir: cx.appsDir,
            mockProcessListOutput: '', // Cold bottle Steam
            enableTwoStageSteamColdStart: true,
            pollIntervalMs: 15,
            settleAfterClientSyncMs: 35,
            maxStartupCloudWaitMs: 2000,
            disableBottleSteamPolling: true,
            gameSpawnFn,
            execFileImpl,
          }
        );

        expect(launchRes.success).toBe(true);
        expect(timeline).toEqual([
          'stage1:spawn_silent',
          'log:client_synced_and_download_queued',
          'log:download_complete',
          'stage2:applaunch_620',
        ]);
        expect(
          sessionEvents.some((e) => e.statusMessage === 'Starting Steam & syncing Steam Cloud...')
        ).toBe(true);

        // Stopping must honor wokeBottleSteamByLauncher: true and invoke steam.exe -shutdown
        await launcherEngine.stopGame(
          { gameId: 'steam-620' },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            execFileImpl,
          }
        );
        for (let i = 0; i < 30 && shutdownCmds.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 15));
        }
        expect(shutdownCmds.some((c) => c.includes('steam.exe -shutdown'))).toBe(true);
      } finally {
        unsub();
      }
    });

    it('3.2 macOS Native Steam cold boot spawns Stage 1 (-silent), waits for ~/Library/Application Support/Steam/logs/cloud_log.txt download settle, then opens steam://rungameid/<id>', async () => {
      const macSteamBin = path.join(
        tmpDir,
        'FakeApps',
        'Steam.app',
        'Contents',
        'MacOS',
        'steam_osx'
      );
      createFakeMachOBinary(macSteamBin);

      const macCloudLogDir = path.join(homedir, 'Library', 'Application Support', 'Steam', 'logs');
      fs.mkdirSync(macCloudLogDir, { recursive: true });
      const macCloudLogPath = path.join(macCloudLogDir, 'cloud_log.txt');
      fs.writeFileSync(macCloudLogPath, '[2026-10-23 08:00:00] Prior macOS session\n', 'utf8');

      const timeline: string[] = [];
      const spawnFn = vi.fn((bin: string, args: string[]) => {
        timeline.push(`stage1:${path.basename(bin)}:${(args || []).join(',')}`);
        setTimeout(() => {
          timeline.push('log:mac_download_started');
          fs.appendFileSync(
            macCloudLogPath,
            '[2026-10-23 12:10:01] OnRemoteStorageSyncedClient() - result OK\n' +
              '[2026-10-23 12:10:01] [AppID 413150] Need to download file "StardewValley/Saves/Farm_123"\n',
            'utf8'
          );
        }, 20);
        setTimeout(() => {
          timeline.push('log:mac_download_complete');
          fs.appendFileSync(
            macCloudLogPath,
            '[2026-10-23 12:10:02] [AppID 413150] Download complete, result OK\n',
            'utf8'
          );
        }, 55);
        return createMockChildProcess(73001);
      });

      const openedUris: string[] = [];
      const onOpenExternal = vi.fn(async (uri: string) => {
        timeline.push(`stage2:uri:${uri}`);
        openedUris.push(uri);
      });

      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-413150',
          title: 'Stardew Valley',
          platformId: 'steam',
          platformGameId: '413150',
          steamAppId: 413150,
          installPath: path.join(tmpDir, 'MacSteamCommon', 'Stardew Valley'),
          launchConfig: {
            launchMethod: 'storefront_uri',
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          steamClientBinaryPath: macSteamBin,
          mockProcessListOutput: '',
          enableTwoStageSteamColdStart: true,
          pollIntervalMs: 15,
          settleAfterClientSyncMs: 30,
          maxStartupCloudWaitMs: 2000,
          disableUriPolling: true,
          spawnFn,
          onOpenExternal,
        }
      );

      expect(launchRes.success).toBe(true);
      expect(openedUris).toEqual(['steam://rungameid/413150']);
      expect(timeline).toEqual([
        'stage1:steam_osx:-silent',
        'log:mac_download_started',
        'log:mac_download_complete',
        'stage2:uri:steam://rungameid/413150',
      ]);

      await launcherEngine.stopGame(
        { gameId: 'steam-413150' },
        { platform: 'darwin', homedir, userDataDir }
      );
    });

    it('3.3 Windows Native Steam cold boot spawns Stage 1 (steam.exe -silent), waits for cloud_log.txt settle, then spawns Stage 2 (steam.exe -silent -applaunch <id>)', async () => {
      const winSteamRoot = path.join(tmpDir, 'WinSteam');
      const winSteamExe = path.join(winSteamRoot, 'steam.exe');
      createFakePeBinary(winSteamExe);
      const winCloudLogDir = path.join(winSteamRoot, 'logs');
      fs.mkdirSync(winCloudLogDir, { recursive: true });
      const winCloudLogPath = path.join(winCloudLogDir, 'cloud_log.txt');
      fs.writeFileSync(winCloudLogPath, '[2026-10-23 08:00:00] Prior win32 session\n', 'utf8');

      const timeline: string[] = [];
      const spawnFn = vi.fn((_bin: string, args: string[]) => {
        const argList = args || [];
        if (argList.includes('-silent') && !argList.includes('-applaunch')) {
          timeline.push('stage1:win32_silent');
          setTimeout(() => {
            timeline.push('log:win32_synced');
            fs.appendFileSync(
              winCloudLogPath,
              '[2026-10-23 12:20:01] OnRemoteStorageSyncedClient() - result OK\n' +
                '[2026-10-23 12:20:01] [AppID 1091500] Starting sync (down,)\n' +
                '[2026-10-23 12:20:02] [AppID 1091500] Download complete\n',
              'utf8'
            );
          }, 25);
          return createMockChildProcess(74001);
        }
        timeline.push(`stage2:win32_${argList.join('_')}`);
        return createMockChildProcess(74002);
      });

      const onOpenExternal = vi.fn();

      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-1091500',
          title: 'Cyberpunk 2077',
          platformId: 'steam',
          platformGameId: '1091500',
          steamAppId: 1091500,
          installPath: path.join(winSteamRoot, 'steamapps', 'common', 'Cyberpunk 2077'),
          launchConfig: {
            launchMethod: 'storefront_uri',
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        {
          platform: 'win32',
          homedir,
          userDataDir,
          steamRoot: winSteamRoot,
          steamClientBinaryPath: winSteamExe,
          mockProcessListOutput: '',
          enableTwoStageSteamColdStart: true,
          pollIntervalMs: 15,
          settleAfterClientSyncMs: 30,
          maxStartupCloudWaitMs: 2000,
          disableUriPolling: true,
          spawnFn,
          onOpenExternal,
        }
      );

      expect(launchRes.success).toBe(true);
      expect(onOpenExternal).not.toHaveBeenCalled();
      expect(timeline).toEqual([
        'stage1:win32_silent',
        'log:win32_synced',
        'stage2:win32_-silent_-applaunch_1091500',
      ]);

      await launcherEngine.stopGame(
        { gameId: 'steam-1091500' },
        { platform: 'win32', homedir, userDataDir }
      );
    });
  });

  // ==========================================================================
  // Suite 4: Steam Post-Exit AC Exit Window, > 2m Gameplay & isSteam Telemetry (Fix 4)
  // ==========================================================================
  describe('Suite 4: Steam Post-Exit AC Exit Upload Window, > 2 Minute Gameplay & isSteam Telemetry', () => {
    it('4.1 waits through >2m stale mtime, catches delayed AC Exit upload in postExitGraceMs, ignores local AutoCloud complete, and resolves only on Upload complete', async () => {
      const steamRoot = path.join(tmpDir, 'SteamPostExitRoot');
      const logDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const cloudLogPath = path.join(logDir, 'cloud_log.txt');

      fs.writeFileSync(
        cloudLogPath,
        '[2026-10-23 11:00:00] [AppID 1145360] AutoCloud done\n',
        'utf8'
      );
      // Backdate mtime by 25 minutes (> 2 minute gameplay session!)
      const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000);
      fs.utimesSync(cloudLogPath, twentyFiveMinAgo, twentyFiveMinAgo);

      let resolvedBeforeUploadComplete = true;
      let uploadCompleteAppended = false;

      // 1) After 50ms (inside postExitGraceMs), Steam begins exit upload AND logs misleading `AutoCloud complete`
      setTimeout(() => {
        fs.appendFileSync(
          cloudLogPath,
          '[2026-10-23 11:25:01] [AppID 1145360] Running AutoCloud on exit\n' +
            '[2026-10-23 11:25:01] [AppID 1145360] AutoCloud complete\n' +
            '[2026-10-23 11:25:01] [AppID 1145360] Starting sync (up,AC Exit,)\n' +
            '[2026-10-23 11:25:01] [AppID 1145360] Need to upload file "Profile1.sav"\n' +
            '[2026-10-23 11:25:01] [AppID 1145360] HTTP upload for file "Profile1.sav" beginning\n',
          'utf8'
        );
      }, 50);

      // 2) After 150ms, Steam finishes network upload
      setTimeout(() => {
        uploadCompleteAppended = true;
        fs.appendFileSync(
          cloudLogPath,
          '[2026-10-23 11:25:02] [AppID 1145360] Upload complete, result OK\n',
          'utf8'
        );
      }, 150);

      const res = await launcherEngine.waitForSteamCloudSyncCompletion(steamRoot, '1145360', {
        platform: 'darwin',
        mode: 'post_exit',
        ignoreStaleLogAge: true,
        postExitGraceMs: 350,
        pollIntervalMs: 20,
        settleMs: 5000,
        maxCloudWaitMs: 2500,
      });
      if (uploadCompleteAppended) {
        resolvedBeforeUploadComplete = false;
      }

      expect(resolvedBeforeUploadComplete).toBe(false);
      expect(res.completed).toBe(true);
      expect(res.reason).toBe('cloud_sync_completed');
      expect(res.waitedMs).toBeGreaterThanOrEqual(140);
    });

    it('4.2 emits cloud_sync_warning telemetry with isSteam: true when post_exit Steam Cloud upload times out in finalizeGameSession', async () => {
      const cx = setupMockCrossOverEnvironment(tmpDir, homedir, 'TimeoutBottle', true);
      const gameExe = path.join(cx.bottleSteamRoot, 'steamapps', 'common', 'Hades', 'Hades.exe');
      createFakePeBinary(gameExe);

      const cloudLogPath = path.join(cx.bottleSteamRoot, 'logs', 'cloud_log.txt');
      // Active stuck upload that never logs Upload complete
      fs.writeFileSync(
        cloudLogPath,
        '[2026-10-23 12:30:00] [AppID 1145360] Starting sync (up,AC Exit,)\n' +
          '[2026-10-23 12:30:00] [AppID 1145360] HTTP upload for file "Profile1.sav" beginning\n',
        'utf8'
      );

      const telemetryEvents: any[] = [];
      const unsub = launcherEngine.onSessionUpdated((ev: any) => {
        if (ev?.event === 'cloud_sync_warning' || ev?.event === 'cloud_sync_complete') {
          telemetryEvents.push(ev);
        }
      });

      const gameSpawnFn = vi.fn(() => createMockChildProcess(75001));
      const execFileImpl = vi.fn((_cmd: string, _args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(null, '', '');
      });

      try {
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'steam-1145360',
            title: 'Hades',
            platformId: 'steam',
            platformGameId: '1145360',
            steamAppId: 1145360,
            installPath: path.dirname(gameExe),
            executablePath: gameExe,
            isWindowsBinaryOnMac: true,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'TimeoutBottle',
              winePrefixPath: cx.bottlePath,
              storefrontClientLifecycle: 'minimal_keep_running',
            },
          },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            customApplicationsDir: cx.appsDir,
            mockProcessListOutput: 'C:\\Program Files (x86)\\Steam\\steam.exe',
            disableBottleSteamPolling: true,
            pollIntervalMs: 15,
            maxCloudWaitMs: 60,
            settleMs: 5000,
            gameSpawnFn,
            execFileImpl,
          }
        );
        expect(launchRes.success).toBe(true);

        await launcherEngine.stopGame(
          { gameId: 'steam-1145360' },
          {
            platform: 'darwin',
            homedir,
            userDataDir,
            pollIntervalMs: 15,
            maxCloudWaitMs: 60,
            settleMs: 5000,
            execFileImpl,
          }
        );

        for (let i = 0; i < 40 && telemetryEvents.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 15));
        }

        expect(telemetryEvents.length).toBeGreaterThanOrEqual(1);
        expect(telemetryEvents[0]).toMatchObject({
          gameId: 'steam-1145360',
          platformId: 'steam',
          event: 'cloud_sync_warning',
          cloudSync: {
            gameId: 'steam-1145360',
            platformId: 'steam',
            direction: 'post_exit',
            synced: false,
            status: 'cloud_sync_warning',
            reason: 'timeout',
          },
        });
      } finally {
        unsub();
      }
    });
  });

  // ==========================================================================
  // Suite 5: Epic resolveEpicSavePathTemplate Edge Cases & win32 OneDrive (Fix 5)
  // ==========================================================================
  describe('Suite 5: Epic resolveEpicSavePathTemplate Edge Cases, LC_ALL Locale & win32 OneDrive Redirection', () => {
    it('5.1 expands {UserProfile} across Wine/CrossOver, win32, and darwin, and rewrites darwin {AppData}/../SubFolder while blocking traversal escapes', () => {
      const cx = setupMockCrossOverEnvironment(tmpDir, homedir, 'EpicTemplateBottle', false);

      // {UserProfile} across all 3 environments
      const wineUserProf = cloudSaveModule.resolveEpicSavePathTemplate(
        '{UserProfile}/Documents/MyGame/Saves',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: cx.bottlePath,
          homedir,
        }
      );
      expect(wineUserProf).toBe(
        path.join(cx.bottlePath, 'drive_c', 'users', 'crossover', 'Documents', 'MyGame', 'Saves')
      );

      const winUserProf = cloudSaveModule.resolveEpicSavePathTemplate(
        '{UserProfile}/Saved Games/StudioX/Slot1',
        {
          platform: 'win32',
          useCompatLayer: false,
          homedir: 'C:\\Users\\TestUser',
          windowsKnownFolders: {
            homedir: 'C:\\Users\\TestUser',
            userProfile: 'C:\\Users\\TestUser',
            documents: 'C:\\Users\\TestUser\\OneDrive\\Documents',
            savedGames: 'D:\\Saved Games',
            localAppData: 'C:\\Users\\TestUser\\AppData\\Local',
            localLowAppData: 'C:\\Users\\TestUser\\AppData\\LocalLow',
            roamingAppData: 'C:\\Users\\TestUser\\AppData\\Roaming',
          },
        }
      );
      expect(winUserProf).toBe('C:\\Users\\TestUser\\Saved Games\\StudioX\\Slot1');

      const macUserProf = cloudSaveModule.resolveEpicSavePathTemplate(
        '{UserProfile}/Documents/MyGame/Saves',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir,
        }
      );
      expect(macUserProf).toBe(path.join(homedir, 'Documents', 'MyGame', 'Saves'));

      // darwin (!useCompatLayer) {AppData}/../Darkest/ -> <homedir>/Library/Darkest
      const darkestResolved = cloudSaveModule.resolveEpicSavePathTemplate(
        '{AppData}/../Darkest/profile_0',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir,
        }
      );
      expect(darkestResolved).toBe(path.join(homedir, 'Library', 'Darkest', 'profile_0'));
      expect(cloudSaveModule.isSafeEpicSaveTemplateSyntax('{AppData}/../Darkest/')).toBe(true);

      // Bare {AppData}/.. (pointing at entire ~/Library root) and {AppData}/../../Escape MUST be rejected!
      expect(
        cloudSaveModule.resolveEpicSavePathTemplate('{AppData}/..', {
          platform: 'darwin',
          useCompatLayer: false,
          homedir,
        })
      ).toBe('');
      expect(
        cloudSaveModule.resolveEpicSavePathTemplate('{AppData}/../../EscapeOutside', {
          platform: 'darwin',
          useCompatLayer: false,
          homedir,
        })
      ).toBe('');
      expect(
        cloudSaveModule.isSafeEpicSaveTemplateSyntax('{AppData}/../../EscapeOutside')
      ).toBe(false);
    });

    it('5.2 injects UTF-8 LC_ALL/LANG into legendary env and honors win32 OneDrive Documents & D:\\Saved Games redirection end-to-end', async () => {
      const regOutput = [
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '    Personal    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Documents',
        '    {4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}    REG_EXPAND_SZ    D:\\Saved Games',
      ].join('\r\n');
      const winEnv = {
        USERPROFILE: 'C:\\Users\\TestUser',
        LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
        APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
      };

      // GOG OneDrive + D:\Saved Games resolution
      const gogResolved = cloudSaveModule.resolveGogCloudSaveLocations(
        [
          { name: 'docs', location: '<?DOCUMENTS?>/Witcher3/gamesaves' },
          { name: 'saved', location: '<?SAVED_GAMES?>/CD Projekt Red/Cyberpunk 2077' },
        ],
        {
          platform: 'win32',
          useCompatLayer: false,
          homedir: 'C:\\Users\\TestUser',
          windowsRegistryOutput: regOutput,
          env: winEnv,
        }
      );
      expect(gogResolved).toEqual([
        {
          name: 'docs',
          location: '<?DOCUMENTS?>/Witcher3/gamesaves',
          resolvedPath: 'C:\\Users\\TestUser\\OneDrive\\Documents\\Witcher3\\gamesaves',
        },
        {
          name: 'saved',
          location: '<?SAVED_GAMES?>/CD Projekt Red/Cyberpunk 2077',
          resolvedPath: 'D:\\Saved Games\\CD Projekt Red\\Cyberpunk 2077',
        },
      ]);

      // POSIX / PyInstaller UTF-8 locale normalization (C.UTF-8 / UTF-8 / POSIX -> en_US.UTF-8)
      expect(cloudSaveModule.normalizePosixUtf8Locale('C.UTF-8')).toBe('en_US.UTF-8');
      expect(cloudSaveModule.normalizePosixUtf8Locale('UTF-8')).toBe('en_US.UTF-8');
      expect(cloudSaveModule.normalizePosixUtf8Locale('C')).toBe('en_US.UTF-8');
      expect(cloudSaveModule.normalizePosixUtf8Locale('POSIX')).toBe('en_US.UTF-8');
      expect(cloudSaveModule.normalizePosixUtf8Locale('')).toBe('en_US.UTF-8');
      expect(cloudSaveModule.normalizePosixUtf8Locale('en_GB.UTF-8')).toBe('en_GB.UTF-8');

      // Epic sync-saves UTF-8 LC_ALL/LANG env (including C.UTF-8 -> en_US.UTF-8) + OneDrive --save-path verification
      const prevLcAll = process.env.LC_ALL;
      const prevLang = process.env.LANG;
      process.env.LC_ALL = 'UTF-8';
      process.env.LANG = 'C.UTF-8';

      const legCfgDir = path.join(userDataDir, 'legWinCfg');
      fs.mkdirSync(legCfgDir, { recursive: true });

      let capturedEnv: Record<string, string> | undefined;
      let capturedArgs: string[] = [];
      const execFileImpl = vi.fn((_cmd: string, args: string[], opts: any, cb?: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        capturedArgs = args;
        capturedEnv = opts?.env;
        callback?.(null, 'Sync complete', '');
      });

      try {
        const syncRes = await launcherEngine.syncEpicCloudSaves(
          { platformId: 'epic', appName: 'RocketApp' },
          'pre_launch',
          {
            platform: 'win32',
            useCompatLayer: false,
            homedir: 'C:\\Users\\TestUser',
            windowsRegistryOutput: regOutput,
            env: { ...winEnv, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
            userDataDir,
            legendaryConfigDir: legCfgDir,
            legendaryBinaryPath: 'C:\\Tools\\legendary.exe',
            skipAuthRefresh: true,
            cloudSaveFolderTemplate: '{UserDir}/My Games/Rocket League/TAGame/Demos',
            execFileImpl,
          }
        );

        expect(syncRes.synced).toBe(true);
        expect(capturedEnv?.LC_ALL).toBe('en_US.UTF-8');
        expect(capturedEnv?.LANG).toBe('en_US.UTF-8');
        expect(capturedArgs).toEqual([
          'sync-saves',
          'RocketApp',
          '-y',
          '--skip-upload',
          '--save-path',
          'C:\\Users\\TestUser\\OneDrive\\Documents\\My Games\\Rocket League\\TAGame\\Demos',
        ]);
      } finally {
        if (prevLcAll !== undefined) {
          process.env.LC_ALL = prevLcAll;
        } else {
          delete process.env.LC_ALL;
        }
        if (prevLang !== undefined) {
          process.env.LANG = prevLang;
        } else {
          delete process.env.LANG;
        }
      }
    });
  });

  // ==========================================================================
  // Suite 6: Full Launch Mode & Lifecycle Settings Matrix + UI Advisory Parity
  // ==========================================================================
  describe('Suite 6: Full Launch Mode & Lifecycle Settings Matrix + Phase 2 UI Advisory Parity', () => {
    it('6.1 delegates Cloud Save Sync to GOG Galaxy and Epic Games Launcher in storefront_uri mode (0 standalone CLI sync calls on pre_launch & post_exit)', async () => {
      const openedUris: string[] = [];
      const cliSpy = vi.fn((_cmd: string, _args: string[], _opts: any, cb?: any) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        callback?.(null, '', '');
      });

      // A) GOG storefront_uri launch -> stop
      const gogLaunch = await launcherEngine.launchGame(
        {
          gameId: 'gog-1207658924',
          title: 'Hollow Knight',
          platformId: 'gog',
          platformGameId: '1207658924',
          installPath: path.join(tmpDir, 'GogUriInstall'),
          launchConfig: { launchMethod: 'storefront_uri' },
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          disableUriPolling: true,
          execFileImpl: cliSpy,
          onOpenExternal: async (uri: string) => {
            openedUris.push(uri);
          },
        }
      );
      expect(gogLaunch.success).toBe(true);
      expect(gogLaunch.session.launchMethod).toBe('storefront_uri');

      await launcherEngine.stopGame(
        { gameId: 'gog-1207658924' },
        { platform: 'darwin', homedir, userDataDir, execFileImpl: cliSpy }
      );

      // B) Epic storefront_uri launch -> stop
      const legCfgDir = path.join(userDataDir, 'legUriCfg');
      fs.mkdirSync(legCfgDir, { recursive: true });
      const epicLaunch = await launcherEngine.launchGame(
        {
          gameId: 'epic-CelesteUri',
          title: 'Celeste',
          platformId: 'epic',
          platformGameId: 'CelesteUri',
          installPath: path.join(tmpDir, 'EpicUriInstall'),
          launchConfig: { launchMethod: 'storefront_uri' },
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          cloudSaveFolderTemplate: '{UserDir}/Celeste/Saves',
          disableUriPolling: true,
          execFileImpl: cliSpy,
          onOpenExternal: async (uri: string) => {
            openedUris.push(uri);
          },
        }
      );
      expect(epicLaunch.success).toBe(true);
      expect(epicLaunch.session.launchMethod).toBe('storefront_uri');

      await launcherEngine.stopGame(
        { gameId: 'epic-CelesteUri' },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          cloudSaveFolderTemplate: '{UserDir}/Celeste/Saves',
          execFileImpl: cliSpy,
        }
      );

      await new Promise((r) => setTimeout(r, 30));
      expect(openedUris.some((u) => u.startsWith('goggalaxy://'))).toBe(true);
      expect(openedUris.some((u) => u.startsWith('com.epicgames.launcher://'))).toBe(true);
      // Zero standalone gogdl save-sync or legendary sync-saves calls during storefront_uri sessions!
      const syncSaveCliCalls = cliSpy.mock.calls.filter((call) => {
        const argStr = (call[1] || []).join(' ');
        return argStr.includes('save-sync') || argStr.includes('sync-saves');
      });
      expect(syncSaveCliCalls).toEqual([]);
    });

    it('6.2 verifies complete LaunchMethod x StorefrontClientLifecycle matrix and Phase 2 FastLaunchWarningBanner / Advisory Cloud Save truth', () => {
      // 1. Matrix policy parity across all 4 lifecycles & 4 launch methods
      const lifecycles = [
        'minimal_and_close_if_started',
        'minimal_keep_running',
        'fast_direct_bypass',
        'default_client',
      ] as const;
      const methods = ['auto', 'compatibility_layer', 'direct', 'storefront_uri'] as const;
      const platforms = ['steam', 'gog', 'epic'] as const;

      for (const platformId of platforms) {
        for (const launchMethod of methods) {
          for (const lifecycle of lifecycles) {
            const input = {
              platformId,
              hostPlatform: 'darwin' as const,
              detectedBuildType: 'windows_exe_on_mac' as const,
              isInstalled: true,
              executablePath: `/Bottles/Test/drive_c/Games/${platformId}/Game.exe`,
              configuredLaunchMethod: launchMethod,
              storefrontClientLifecycle: lifecycle,
              globalStorefrontLifecycle: 'minimal_and_close_if_started' as const,
            };
            const tsOut = resolveEffectiveLaunchPolicyTs(input);
            const cjsOut = launcherEngine.resolveEffectiveLaunchPolicy(input);
            expect(tsOut).toEqual(cjsOut);

            if (launchMethod === 'storefront_uri') {
              expect(tsOut.isFastDirectBypass).toBe(false);
              expect(tsOut.effectiveLaunchMethod).toBe('storefront_uri');
              expect(tsOut.delegatesToStorefrontUri).toBe(true);
              expect(tsOut.syncsCloudSavesStandalone).toBe(false);
              expect(tsOut.usesSilentSteamApplaunch).toBe(false);
            } else {
              expect(tsOut.delegatesToStorefrontUri).toBe(false);
              if (platformId === 'gog' || platformId === 'epic') {
                // Standalone gogdl / legendary Cloud Saves remain active across auto, direct, and compatibility_layer regardless of lifecycle!
                expect(tsOut.syncsCloudSavesStandalone).toBe(true);
              } else {
                expect(tsOut.syncsCloudSavesStandalone).toBe(false);
                const expectedFastBypass =
                  launchMethod === 'direct' || lifecycle === 'fast_direct_bypass';
                expect(tsOut.isFastDirectBypass).toBe(expectedFastBypass);
                expect(tsOut.usesSilentSteamApplaunch).toBe(!expectedFastBypass);
              }
            }
          }
        }
      }

      // 2. Phase 2 Advisory Truth: Steam warns of Cloud bypass, while GOG & Epic confirm Cloud Saves remain active!
      const steamFastAdv = computeFastMinimalLaunchAdvisory({
        platformId: 'steam',
        detectedBuildType: 'windows_exe_on_mac',
        hostPlatform: 'darwin',
        launchMethod: 'compatibility_layer',
        storefrontClientLifecycle: 'fast_direct_bypass',
        isInstalled: true,
        executablePath: '/Bottles/Steam/drive_c/Games/Test.exe',
      });
      expect(steamFastAdv.isActive).toBe(true);
      expect(steamFastAdv.severity).toBe('warning');
      expect(steamFastAdv.warnings.join(' ')).toContain('Bypasses Steam Cloud Sync');

      const gogBottleFastAdv = computeFastMinimalLaunchAdvisory({
        platformId: 'gog',
        detectedBuildType: 'windows_exe_on_mac',
        hostPlatform: 'darwin',
        launchMethod: 'auto',
        storefrontClientLifecycle: 'fast_direct_bypass',
        globalStorefrontLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        executablePath: '/Bottles/GOG/drive_c/GOG Games/Test.exe',
      });
      expect(gogBottleFastAdv.isActive).toBe(true);
      expect(gogBottleFastAdv.severity).toBe('warning');
      expect(gogBottleFastAdv.warnings.join(' ')).toContain(
        'Achievements / Trophies Do NOT Work'
      );
      expect(gogBottleFastAdv.warnings.join(' ')).toContain(
        'Cloud Saves & Playtime Remain Active'
      );
      expect(gogBottleFastAdv.warnings.join(' ')).toContain('gogdl Cloud Saves both ways');

      const epicFastAdv = computeFastMinimalLaunchAdvisory({
        platformId: 'epic',
        detectedBuildType: 'windows_native',
        hostPlatform: 'win32',
        launchMethod: 'auto',
        storefrontClientLifecycle: 'fast_direct_bypass',
        isInstalled: true,
        executablePath: 'C:\\Games\\Epic\\Test.exe',
      });
      expect(epicFastAdv.isActive).toBe(true);
      expect(epicFastAdv.severity).toBe('info');
      expect(epicFastAdv.warnings.join(' ')).toContain(
        'Cloud Saves, Achievements, Multiplayer & Playtime Remain Active'
      );
      expect(epicFastAdv.warnings.join(' ')).toContain('legendary Cloud Saves both ways');

      // 3. FastLaunchWarningBanner storefront_uri delegation notice across Steam, GOG, and Epic
      for (const [plat, expectedSnippet] of [
        ['steam', 'steam://rungameid'],
        ['gog', 'official GOG Galaxy desktop client (goggalaxy://)'],
        ['epic', 'official Epic Games Launcher desktop client (com.epicgames.launcher://)'],
      ] as const) {
        const html = renderToString(
          React.createElement(FastLaunchWarningBanner, {
            fastLaunchAdvisory: steamFastAdv,
            activeDisplayMethod: 'storefront_uri',
            isInstalled: true,
            preferredPlatformId: plat,
          })
        );
        expect(html).toContain('data-section="storefront-uri-notice"');
        expect(html).toContain(expectedSnippet);
      }
    });
  });
});
