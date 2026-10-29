import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import type { CanonicalGame } from '../src/contracts/game';
import type { CompatibilityLayerInfo } from '../src/contracts/launcher';

// ---------------------------------------------------------------------------
// Headless Browser Environment Setup (window, localStorage, CustomEvent)
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

const windowEventListeners: Record<string, Function[]> = {};
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockStorage,
    location: { hostname: '' },
    addEventListener: (event: string, fn: Function) => {
      windowEventListeners[event] = windowEventListeners[event] || [];
      windowEventListeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: Function) => {
      if (windowEventListeners[event]) {
        windowEventListeners[event] = windowEventListeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: any) => {
      const fns = (windowEventListeners[event.type] || []).slice();
      fns.forEach((f) => f(event));
      return true;
    },
  };
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = mockStorage;
}

import {
  launcherService,
  computeFastMinimalLaunchAdvisory,
} from '../src/services/launcher/launcherService';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';

const requireCjs = createRequire(import.meta.url);
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');

// ---------------------------------------------------------------------------
// Helpers for Temp File Creation, Valid PE64 Stubs & React VNode Traversal
// ---------------------------------------------------------------------------
function writeTempFile(filePath: string, content: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(filePath, mode);
  }
}

function createMockPe64Buffer(sizeBytes = 4096): Buffer {
  const buf = Buffer.alloc(Math.max(sizeBytes, 512), 0);
  // MZ header
  buf.write('MZ', 0, 'ascii');
  // e_lfanew at 0x3C -> 0x80
  buf.writeUInt32LE(0x80, 0x3c);
  // PE\0\0 signature at 0x80
  buf.write('PE\0\0', 0x80, 'ascii');
  // Machine = IMAGE_FILE_MACHINE_AMD64 (0x8664)
  buf.writeUInt16LE(0x8664, 0x84);
  // Optional header magic = PE32+ (0x20b) at 0x80 + 24 = 0x98
  buf.writeUInt16LE(0x020b, 0x98);
  return buf;
}

function findElements(node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findElements(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) {
    acc.push(node);
  }
  if (node.props && node.props.children !== undefined) {
    findElements(node.props.children, predicate, acc);
  } else if (typeof node.type === 'function') {
    try {
      const rendered = node.type(node.props || {});
      findElements(rendered, predicate, acc);
    } catch {}
  }
  return acc;
}

describe('Cloud Save Parity, Fast Direct Bypass & Cross-Platform Footprint Coexistence Suite', () => {
  let tmpRoot: string;

  beforeEach(() => {
    localStorage.clear();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cloud-parity-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      launcherEngine.setMainWindowGetter(() => null);
    } catch {}
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // OPTION 1: GOG CLOUD SAVES (syncGogCloudSaves) & GOG URI / WAKE GATING
  // =========================================================================
  describe('Option 1: GOG Cloud Save Engine & GOG URI / Wake Gating', () => {
    it('resolveGogCloudSaveLocations resolves win32 native, darwin native, and darwin CrossOver bottle user.reg [Shell Folders]', () => {
      const locations = [
        { name: 'saves', location: '<?DOCUMENTS?>/My Games/CyberRPG/Saves' },
        { name: 'appdata', location: '<?APPLICATION_DATA_LOCAL?>/CD Projekt Red/Saves' },
        { name: 'install_rel', location: '<?INSTALL?>/userdata/saves' },
      ];

      // 1. Windows native
      const winResolved = launcherEngine.resolveGogCloudSaveLocations(locations, {
        platform: 'win32',
        useCompatLayer: false,
        homedir: path.join(tmpRoot, 'winhome'),
        installPath: path.join(tmpRoot, 'GOG Games', 'CyberRPG'),
      });
      expect(winResolved).toHaveLength(3);
      expect(winResolved[0].resolvedPath.replace(/\\/g, '/')).toContain(
        path.posix.join('winhome', 'Documents', 'My Games', 'CyberRPG', 'Saves')
      );
      expect(winResolved[1].resolvedPath.replace(/\\/g, '/')).toContain(
        path.posix.join('winhome', 'AppData', 'Local', 'CD Projekt Red', 'Saves')
      );

      // 2. macOS native
      const macResolved = launcherEngine.resolveGogCloudSaveLocations(locations, {
        platform: 'darwin',
        useCompatLayer: false,
        homedir: path.join(tmpRoot, 'machome'),
        installPath: path.join(tmpRoot, 'Applications', 'CyberRPG.app'),
      });
      expect(macResolved).toHaveLength(3);
      expect(macResolved[0].resolvedPath.replace(/\\/g, '/')).toBe(
        path.posix
          .join(tmpRoot, 'machome', 'Documents', 'My Games', 'CyberRPG', 'Saves')
          .replace(/\\/g, '/')
      );
      expect(macResolved[1].resolvedPath.replace(/\\/g, '/')).toBe(
        path.posix
          .join(
            tmpRoot,
            'machome',
            'Library',
            'Application Support',
            'CD Projekt Red',
            'Saves'
          )
          .replace(/\\/g, '/')
      );

      // 3. macOS CrossOver bottle with user.reg [Shell Folders]
      const bottleDir = path.join(tmpRoot, 'Bottles', 'OneLauncher');
      fs.mkdirSync(path.join(bottleDir, 'drive_c', 'users', 'crossover', 'Documents'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(bottleDir, 'drive_c', 'users', 'crossover', 'AppData', 'Local'), {
        recursive: true,
      });
      writeTempFile(
        path.join(bottleDir, 'user.reg'),
        [
          'WINE REGISTRY Version 2',
          '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders] 1700000000',
          '"Personal"="C:\\\\users\\\\crossover\\\\Documents"',
          '"Local AppData"="C:\\\\users\\\\crossover\\\\AppData\\\\Local"',
          '',
        ].join('\n')
      );

      const bottleResolved = launcherEngine.resolveGogCloudSaveLocations(locations, {
        platform: 'darwin',
        useCompatLayer: true,
        winePrefix: bottleDir,
        installPath: path.join(bottleDir, 'drive_c', 'GOG Games', 'CyberRPG'),
      });
      expect(bottleResolved).toHaveLength(3);
      expect(bottleResolved[0].resolvedPath).toBe(
        path.join(
          bottleDir,
          'drive_c',
          'users',
          'crossover',
          'Documents',
          'My Games',
          'CyberRPG',
          'Saves'
        )
      );
      expect(bottleResolved[1].resolvedPath).toBe(
        path.join(
          bottleDir,
          'drive_c',
          'users',
          'crossover',
          'AppData',
          'Local',
          'CD Projekt Red',
          'Saves'
        )
      );
    });

    it('syncGogCloudSaves runs pre_launch (--skip-upload + rolling backup) and post_exit (--skip-download + timestamp persistence)', async () => {
      const installDir = path.join(tmpRoot, 'GOG Games', 'StarboundGOG');
      const userDataDir = path.join(tmpRoot, 'userdata');
      const homeDir = path.join(tmpRoot, 'home');
      const saveDir = path.join(homeDir, 'Documents', 'StarboundSaves');
      const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
      const gogdlBin = path.join(tmpRoot, 'bin', 'gogdl');

      writeTempFile(
        path.join(installDir, 'goggame-1453375253.info'),
        JSON.stringify({ gameId: '1453375253', clientId: '50112233445566' })
      );
      writeTempFile(path.join(saveDir, 'player1.sav'), 'LOCAL_SAVE_DATA_V1');
      writeTempFile(gogAuthPath, JSON.stringify({ '50112233445566': { access_token: 'tok' } }));
      writeTempFile(gogdlBin, '#!/bin/sh\nexit 0\n', 0o755);

      const remoteConfigOverride = {
        content: {
          MacOS: {
            cloudStorage: {
              enabled: true,
              locations: [{ name: 'saves', location: '<?DOCUMENTS?>/StarboundSaves' }],
            },
          },
        },
      };

      const execCalls: Array<{ bin: string; args: string[] }> = [];
      const mockExecFile = (bin: string, args: string[], _opts: any, cb: Function) => {
        execCalls.push({ bin, args });
        cb(null, '1729680000\n', '');
      };

      // 1. Pre-launch: creates rolling backup + passes --skip-upload
      const preRes = await launcherEngine.syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: '1453375253',
          installPath: installDir,
        },
        'pre_launch',
        {
          platform: 'darwin',
          homedir: homeDir,
          userDataDir,
          gogdlBinaryPath: gogdlBin,
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: remoteConfigOverride,
          execFileFn: mockExecFile,
        }
      );

      expect(preRes.synced).toBe(true);
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0].bin).toBe(gogdlBin);
      expect(execCalls[0].args).toContain('save-sync');
      expect(execCalls[0].args).toContain('--skip-upload');
      expect(execCalls[0].args).toContain('--os');
      expect(execCalls[0].args).toContain('osx');

      const backupBase = path.join(userDataDir, 'cloud_save_backups', 'gog', '1453375253', 'saves');
      expect(fs.existsSync(backupBase)).toBe(true);
      const backupSnapshots = fs.readdirSync(backupBase);
      expect(backupSnapshots.length).toBeGreaterThanOrEqual(1);

      // 2. Post-exit: passes --skip-download + persists timestamp in one_launcher_cloud_sync_timestamps.json
      const postRes = await launcherEngine.syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: '1453375253',
          installPath: installDir,
        },
        'post_exit',
        {
          platform: 'darwin',
          homedir: homeDir,
          userDataDir,
          gogdlBinaryPath: gogdlBin,
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: remoteConfigOverride,
          execFileFn: mockExecFile,
        }
      );

      expect(postRes.synced).toBe(true);
      expect(execCalls).toHaveLength(2);
      expect(execCalls[1].args).toContain('--skip-download');
      expect(execCalls[1].args).toContain('1729680000');

      const tsFile = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
      expect(fs.existsSync(tsFile)).toBe(true);
      const tsJson = JSON.parse(fs.readFileSync(tsFile, 'utf8'));
      expect(tsJson.gog['1453375253:osx:saves']).toBe(1729680000);
    });

    it('builds goggalaxy://launchGame/gog_<id> URI and skips waking host macOS GOG Galaxy when useCompatLayer or fast_direct_bypass is active', async () => {
      expect(
        launcherEngine.buildStorefrontLaunchUri({
          platformId: 'gog',
          platformGameId: '1207658924',
        })
      ).toBe('goggalaxy://launchGame/gog_1207658924');

      // Setup mock macOS GOG Galaxy.app + mock CrossOver runner + Windows GOG .exe with Galaxy64.dll
      const fakeAppsDir = path.join(tmpRoot, 'Applications');
      const fakeGalaxyBin = path.join(
        fakeAppsDir,
        'GOG Galaxy.app',
        'Contents',
        'MacOS',
        'GOG Galaxy'
      );
      writeTempFile(fakeGalaxyBin, '#!/bin/sh\nexit 0\n', 0o755);

      const fakeCrossOverWine = path.join(
        fakeAppsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin',
        'wine'
      );
      writeTempFile(fakeCrossOverWine, '#!/bin/sh\nexit 0\n', 0o755);

      const bottleDir = path.join(
        tmpRoot,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      const gogWinInstall = path.join(bottleDir, 'drive_c', 'GOG Games', 'WitcherGOG');
      const gogWinExe = path.join(gogWinInstall, 'witcher.exe');
      writeTempFile(gogWinExe, createMockPe64Buffer());
      writeTempFile(path.join(gogWinInstall, 'Galaxy64.dll'), 'DLL');

      const wakeSpawns: Array<{ cmd: string; args: string[] }> = [];
      const mockWakeSpawn = (cmd: string, args: string[]) => {
        wakeSpawns.push({ cmd, args });
        const fakeProc: any = new EventEmitter();
        fakeProc.pid = 41111;
        fakeProc.unref = () => {};
        return fakeProc;
      };
      const mockGameSpawn = () => {
        const fakeChild: any = new EventEmitter();
        fakeChild.pid = 42222;
        fakeChild.stderr = new EventEmitter();
        fakeChild.kill = () => true;
        return fakeChild;
      };

      // Case A: GOG Windows .exe in CrossOver bottle on darwin -> never wakes host macOS GOG Galaxy.app
      const compatLaunch = await launcherEngine.launchGame(
        {
          gameId: 'gog-witcher-bottle',
          platformId: 'gog',
          platformGameId: '1207658924',
          title: 'Witcher Bottle',
          installPath: gogWinInstall,
          executablePath: gogWinExe,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            winePrefixPath: bottleDir,
          },
        },
        {
          platform: 'darwin',
          homedir: tmpRoot,
          userDataDir: path.join(tmpRoot, 'ud1'),
          customApplicationsDir: fakeAppsDir,
          gogGalaxyClientPath: path.join(fakeAppsDir, 'GOG Galaxy.app'),
          mockProcessListOutput: '',
          spawnFn: mockWakeSpawn,
          gameSpawnFn: mockGameSpawn,
          skipCloudSaveSync: true,
        }
      );
      expect(compatLaunch.success).toBe(true);
      expect(wakeSpawns).toHaveLength(0);
      await launcherEngine.stopGame(
        { gameId: 'gog-witcher-bottle' },
        { platform: 'darwin', skipCloudSaveSync: true }
      );

      // Case B: Native macOS GOG build with storefrontClientLifecycle: 'fast_direct_bypass' -> skips waking GOG Galaxy.app
      const macNativeDir = path.join(tmpRoot, 'Games', 'NativeGOG');
      const macNativeBin = path.join(macNativeDir, 'game_mac');
      writeTempFile(macNativeBin, '#!/bin/sh\nsleep 5\n', 0o755);
      writeTempFile(path.join(macNativeDir, 'libGalaxy64.dylib'), 'DYLIB');

      const fastBypassLaunch = await launcherEngine.launchGame(
        {
          gameId: 'gog-native-fast-bypass',
          platformId: 'gog',
          platformGameId: '1207658925',
          title: 'Native GOG Fast',
          installPath: macNativeDir,
          executablePath: macNativeBin,
          launchConfig: {
            launchMethod: 'auto',
            storefrontClientLifecycle: 'fast_direct_bypass',
          },
        },
        {
          platform: 'darwin',
          homedir: tmpRoot,
          userDataDir: path.join(tmpRoot, 'ud2'),
          customApplicationsDir: fakeAppsDir,
          gogGalaxyClientPath: path.join(fakeAppsDir, 'GOG Galaxy.app'),
          mockProcessListOutput: '',
          spawnFn: mockWakeSpawn,
          gameSpawnFn: mockGameSpawn,
          skipCloudSaveSync: true,
        }
      );
      expect(fastBypassLaunch.success).toBe(true);
      expect(wakeSpawns).toHaveLength(0);
      await launcherEngine.stopGame(
        { gameId: 'gog-native-fast-bypass' },
        { platform: 'darwin', skipCloudSaveSync: true }
      );
    });
  });

  // =========================================================================
  // OPTION 2: EPIC CLOUD SAVES (syncEpicCloudSaves HARDENING)
  // =========================================================================
  describe('Option 2: Epic Cloud Save Hardening (CloudSaveFolder_MAC, Bottle WINEPREFIX, EGL Import & Honest Status)', () => {
    it('resolves uppercase CloudSaveFolder_MAC on native darwin and bottle WINEPREFIX + --save-path via user.reg', async () => {
      const legCfgDir = path.join(tmpRoot, 'legendaryConfig');
      const homeDir = path.join(tmpRoot, 'epicHome');
      const userDataDir = path.join(tmpRoot, 'epicUserData');

      writeTempFile(
        path.join(legCfgDir, 'user.json'),
        JSON.stringify({ account_id: 'epicacct99887766' })
      );
      writeTempFile(
        path.join(legCfgDir, 'installed.json'),
        JSON.stringify({
          MacAndWinEpicApp: { app_name: 'MacAndWinEpicApp', install_path: '/tmp/game' },
        })
      );
      writeTempFile(
        path.join(legCfgDir, 'metadata', 'MacAndWinEpicApp.json'),
        JSON.stringify({
          app_name: 'MacAndWinEpicApp',
          metadata: {
            customAttributes: {
              CloudSaveFolder: {
                type: 'STRING',
                value: '{AppData}/../LocalLow/DevStudio/EpicRPG/{EpicID}/Saves',
              },
              CloudSaveFolder_MAC: {
                type: 'STRING',
                value: '{UserLibrary}/Application Support/DevStudio/EpicRPG/{EpicID}/Saves',
              },
            },
          },
        })
      );

      const calls: Array<{ bin: string; args: string[]; env: any }> = [];
      const mockExec = (bin: string, args: string[], opts: any, cb: Function) => {
        calls.push({ bin, args, env: opts?.env });
        cb(null, 'Finished syncing saves', '');
      };

      // 1. Native darwin selects CloudSaveFolder_MAC
      const macRes = await launcherEngine.syncEpicCloudSaves(
        { appName: 'MacAndWinEpicApp' },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir: homeDir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: '/mock/legendary',
          execFileFn: mockExec,
        }
      );

      expect(macRes.synced).toBe(true);
      expect(macRes.resolvedSavePath.replace(/\\/g, '/')).toBe(
        path.posix
          .join(
            homeDir,
            'Library',
            'Application Support',
            'DevStudio',
            'EpicRPG',
            'epicacct99887766',
            'Saves'
          )
          .replace(/\\/g, '/')
      );
      expect(calls[0].args).toContain('--save-path');
      expect(calls[0].args).toContain(macRes.resolvedSavePath);

      // 2. CrossOver Bottle on darwin selects Windows CloudSaveFolder + injects WINEPREFIX + resolves LocalLow inside bottle
      const bottleDir = path.join(tmpRoot, 'Bottles', 'EpicBottle');
      fs.mkdirSync(path.join(bottleDir, 'drive_c', 'users', 'crossover', 'AppData', 'LocalLow'), {
        recursive: true,
      });
      writeTempFile(
        path.join(bottleDir, 'user.reg'),
        [
          'WINE REGISTRY Version 2',
          '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders] 1700000000',
          '"Local AppData"="C:\\\\users\\\\crossover\\\\AppData\\\\Local"',
          '',
        ].join('\n')
      );

      const bottleRes = await launcherEngine.syncEpicCloudSaves(
        { appName: 'MacAndWinEpicApp' },
        'post_exit',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: bottleDir,
          homedir: homeDir,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: '/mock/legendary',
          execFileFn: mockExec,
        }
      );

      expect(bottleRes.synced).toBe(true);
      expect(bottleRes.resolvedSavePath).toBe(
        path.join(
          bottleDir,
          'drive_c',
          'users',
          'crossover',
          'AppData',
          'LocalLow',
          'DevStudio',
          'EpicRPG',
          'epicacct99887766',
          'Saves'
        )
      );
      expect(calls[1].env.WINEPREFIX).toBe(bottleDir);
      expect(calls[1].args).toContain('--skip-download');
      expect(calls[1].args).toContain(bottleRes.resolvedSavePath);
    });

    it('auto-imports unregistered official Epic Games Launcher installs and reports { synced: false } on skipping due to --yes or non-zero exit', async () => {
      const legCfgDir = path.join(tmpRoot, 'legCfgImport');
      const eglInstallDir = path.join(tmpRoot, 'Epic Games', 'AlanWakeRemastered');
      fs.mkdirSync(eglInstallDir, { recursive: true });

      writeTempFile(path.join(legCfgDir, 'installed.json'), JSON.stringify({}));
      writeTempFile(
        path.join(legCfgDir, 'metadata', 'EglOnlyGame.json'),
        JSON.stringify({
          app_name: 'EglOnlyGame',
          metadata: {
            customAttributes: {
              CloudSaveFolder: { type: 'STRING', value: '{UserDir}/EglOnlyGame/Saves' },
            },
          },
        })
      );

      const recordedArgs: string[][] = [];
      let simulateSkipDueToYes = false;
      const mockExec = (_bin: string, args: string[], _opts: any, cb: Function) => {
        recordedArgs.push(args);
        if (args[0] === 'sync-saves' && simulateSkipDueToYes) {
          cb(null, '', 'WARNING: Game "EglOnlyGame" is not installed, skipping due to --yes');
          return;
        }
        cb(null, 'Sync succeeded', '');
      };

      // 1. Auto-runs `legendary import EglOnlyGame <installPath> --platform Windows --disable-check -y` before `sync-saves`
      const okRes = await launcherEngine.syncEpicCloudSaves(
        { appName: 'EglOnlyGame', installPath: eglInstallDir },
        'pre_launch',
        {
          platform: 'win32',
          homedir: tmpRoot,
          userDataDir: tmpRoot,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: '/mock/legendary',
          execFileFn: mockExec,
        }
      );

      expect(okRes.synced).toBe(true);
      expect(recordedArgs).toHaveLength(2);
      expect(recordedArgs[0]).toEqual([
        'import',
        'EglOnlyGame',
        eglInstallDir,
        '--platform',
        'Windows',
        '--disable-check',
        '-y',
      ]);
      expect(recordedArgs[1][0]).toBe('sync-saves');

      // 2. Reports { synced: false } when legendary outputs "skipping due to --yes"
      simulateSkipDueToYes = true;
      const skippedRes = await launcherEngine.syncEpicCloudSaves(
        { appName: 'EglOnlyGame', installPath: eglInstallDir },
        'post_exit',
        {
          platform: 'win32',
          homedir: tmpRoot,
          userDataDir: tmpRoot,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: '/mock/legendary',
          execFileFn: mockExec,
        }
      );
      expect(skippedRes.synced).toBe(false);
      expect(String(skippedRes.reason)).toContain('skipping due to --yes');
    });
  });

  // =========================================================================
  // OPTION 3: STEAM NATIVE & BOTTLE CLOUD PARITY + FAST BYPASS + ORDERED SHUTDOWN
  // =========================================================================
  describe('Option 3: Steam Native & Bottle Cloud Parity, fast_direct_bypass & Ordered Post-Exit Shutdown', () => {
    it('resolveSteamClientLaunchCommand preserves Friends/Overlay in minimal_* and strips UI services in fast_direct_bypass', async () => {
      const fakeSteamBin = path.join(tmpRoot, 'Steam', 'steam.exe');
      writeTempFile(fakeSteamBin, 'MZ');

      const minimalCmd = await launcherEngine.resolveSteamClientLaunchCommand(
        '620',
        ['-novid'],
        {
          platform: 'win32',
          userDataDir: tmpRoot,
          steamClientBinaryPath: fakeSteamBin,
          mockProcessListOutput: 'INFO: No tasks are running',
          storefrontClientLifecycle: 'minimal_and_close_if_started',
        }
      );
      expect(minimalCmd.args).toEqual(['-silent', '-applaunch', '620', '-novid']);

      const fastBypassCmd = await launcherEngine.resolveSteamClientLaunchCommand(
        '620',
        ['-novid'],
        {
          platform: 'win32',
          userDataDir: tmpRoot,
          steamClientBinaryPath: fakeSteamBin,
          mockProcessListOutput: 'INFO: No tasks are running',
          storefrontClientLifecycle: 'fast_direct_bypass',
        }
      );
      expect(fastBypassCmd.args).toEqual([
        '-silent',
        '-nochatui',
        '-nofriendsui',
        '-nobrowser',
        '-applaunch',
        '620',
        '-novid',
      ]);
    });

    it('launches Bottle Steam via <wine> <bottleSteamExe> -silent -applaunch <id>, tracks Game.exe PID, and orders cloud_log -> steam.exe -shutdown -> wineserver -k', async () => {
      const fakeAppsDir = path.join(tmpRoot, 'Apps');
      const binDir = path.join(
        fakeAppsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin'
      );
      const fakeWine = path.join(binDir, 'wine');
      const wineserverMarkerFile = path.join(tmpRoot, 'wineserver_killed_at.txt');
      writeTempFile(fakeWine, '#!/bin/sh\nexit 0\n', 0o755);
      // Real tiny wineserver script that records timestamp when invoked with -k
      writeTempFile(
        path.join(binDir, 'wineserver'),
        `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(
          wineserverMarkerFile
        )}, Date.now() + ':' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(0);\n`,
        0o755
      );

      const bottleDir = path.join(
        tmpRoot,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'SteamBottle'
      );
      const bottleSteamDir = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'Steam');
      const bottleSteamExe = path.join(bottleSteamDir, 'steam.exe');
      const cloudLogPath = path.join(bottleSteamDir, 'logs', 'cloud_log.txt');
      const gameInstallDir = path.join(bottleSteamDir, 'steamapps', 'common', 'Portal 2');
      const gameExePath = path.join(gameInstallDir, 'portal2.exe');

      writeTempFile(bottleSteamExe, createMockPe64Buffer());
      writeTempFile(gameExePath, createMockPe64Buffer());
      // Initially write an active Cloud upload line for AppID 620
      writeTempFile(
        cloudLogPath,
        '[2026-10-23 10:00:00] [AppID 620] Uploading 2 save files to Steam Cloud...\n'
      );

      const spawnedCommands: Array<{ cmd: string; args: string[] }> = [];
      const mockGameSpawn = (cmd: string, args: string[]) => {
        spawnedCommands.push({ cmd, args });
        const fakeChild: any = new EventEmitter();
        fakeChild.pid = 51000;
        fakeChild.stderr = new EventEmitter();
        fakeChild.kill = () => true;
        return fakeChild;
      };

      const timelineEvents: string[] = [];
      let gameProcessVisible = true;

      const mockExecFile = (cmd: string, args: string[], opts: any, cb: Function) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd === 'ps' && Array.isArray(args) && args.includes('pid=,command=')) {
          if (gameProcessVisible) {
            callback(null, '52345 C:\\Program Files (x86)\\Steam\\steamapps\\common\\Portal 2\\portal2.exe\n', '');
          } else {
            callback(null, '51000 C:\\Program Files (x86)\\Steam\\steam.exe -silent\n', '');
          }
          return;
        }
        if (cmd === fakeWine && Array.isArray(args) && args.includes('-shutdown')) {
          timelineEvents.push(`steam_shutdown:${Date.now()}`);
          callback(null, '', '');
          return;
        }
        callback(null, '', '');
      };

      // Spy on process.kill so latched PID 52345 appears alive until gameProcessVisible = false
      const origKill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
        if (pid === 52345) {
          if (gameProcessVisible) return true;
          const err: any = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        if (pid === 51000) return true;
        return origKill(pid, sig);
      }) as any);

      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-620-bottle',
          platformId: 'steam',
          platformGameId: '620',
          steamAppId: 620,
          title: 'Portal 2',
          installPath: gameInstallDir,
          executablePath: gameExePath,
          launchConfig: {
            launchMethod: 'auto',
            compatibilityLayer: 'crossover',
            winePrefixPath: bottleDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        {
          platform: 'darwin',
          homedir: tmpRoot,
          userDataDir: path.join(tmpRoot, 'ud_steam_bottle'),
          customApplicationsDir: fakeAppsDir,
          mockProcessListOutput: '',
          bottleSteamPollIntervalMs: 30,
          cloudSyncPollIntervalMs: 30,
          cloudSyncMaxWaitMs: 500,
          gameSpawnFn: mockGameSpawn,
          execFileFn: mockExecFile,
        }
      );

      expect(launchRes.success).toBe(true);
      // Pre-launch wineserver -k MUST NOT have been called when launching via Bottle Steam!
      expect(fs.existsSync(wineserverMarkerFile)).toBe(false);
      expect(spawnedCommands).toHaveLength(1);
      expect(spawnedCommands[0].cmd).toBe(fakeWine);
      expect(spawnedCommands[0].args).toEqual([bottleSteamExe, '-silent', '-applaunch', '620']);

      // Wait ~80ms so the bottle poller latches PID 52345
      await new Promise((r) => setTimeout(r, 80));
      const running = launcherEngine.getRunningGames();
      expect(running.find((s: any) => s.gameId === 'steam-620-bottle')?.pid).toBe(52345);

      // Now simulate game exiting while Steam Cloud is finishing upload after 90ms
      setTimeout(() => {
        timelineEvents.push(`cloud_upload_complete:${Date.now()}`);
        fs.appendFileSync(
          cloudLogPath,
          '[2026-10-23 10:00:02] [AppID 620] Syncing to Steam Cloud succeeded\n'
        );
      }, 90);
      gameProcessVisible = false;

      // Wait for poller to detect exit -> waitForSteamCloudSyncCompletion -> steam.exe -shutdown -> wineserver -k
      await new Promise((r) => setTimeout(r, 320));
      const postWorkDeadline = Date.now() + 2500;
      while (launcherEngine.hasActivePostSessionWork() && Date.now() < postWorkDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(timelineEvents.some((e) => e.startsWith('cloud_upload_complete:'))).toBe(true);
      expect(timelineEvents.some((e) => e.startsWith('steam_shutdown:'))).toBe(true);
      expect(fs.existsSync(wineserverMarkerFile)).toBe(true);

      const cloudCompleteIdx = timelineEvents.findIndex((e) =>
        e.startsWith('cloud_upload_complete:')
      );
      const steamShutdownIdx = timelineEvents.findIndex((e) => e.startsWith('steam_shutdown:'));
      expect(steamShutdownIdx).toBeGreaterThan(cloudCompleteIdx);

      const wineserverLine = fs.readFileSync(wineserverMarkerFile, 'utf8').trim().split('\n')[0];
      const wineserverTs = Number(wineserverLine.split(':')[0]);
      const steamShutdownTs = Number(timelineEvents[steamShutdownIdx].split(':')[1]);
      expect(wineserverTs).toBeGreaterThanOrEqual(steamShutdownTs);
    });

    it('bypasses bottleSteamExe and spawns <wineBinary> <Game.exe> directly when storefrontClientLifecycle === fast_direct_bypass', async () => {
      const fakeAppsDir = path.join(tmpRoot, 'AppsFast');
      const binDir = path.join(
        fakeAppsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin'
      );
      const fakeWine = path.join(binDir, 'wine');
      writeTempFile(fakeWine, '#!/bin/sh\nexit 0\n', 0o755);

      const bottleDir = path.join(
        tmpRoot,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'FastSteamBottle'
      );
      const bottleSteamDir = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'Steam');
      const bottleSteamExe = path.join(bottleSteamDir, 'steam.exe');
      const gameInstallDir = path.join(bottleSteamDir, 'steamapps', 'common', 'DRMFreeIndie');
      const gameExePath = path.join(gameInstallDir, 'indie.exe');

      writeTempFile(bottleSteamExe, createMockPe64Buffer());
      writeTempFile(gameExePath, createMockPe64Buffer());

      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const res = await launcherEngine.launchGame(
        {
          gameId: 'steam-999111-fast',
          platformId: 'steam',
          platformGameId: '999111',
          steamAppId: 999111,
          title: 'DRM Free Indie',
          installPath: gameInstallDir,
          executablePath: gameExePath,
          launchConfig: {
            launchMethod: 'auto',
            compatibilityLayer: 'crossover',
            winePrefixPath: bottleDir,
            storefrontClientLifecycle: 'fast_direct_bypass',
          },
        },
        {
          platform: 'darwin',
          homedir: tmpRoot,
          userDataDir: path.join(tmpRoot, 'ud_fast'),
          customApplicationsDir: fakeAppsDir,
          gameSpawnFn: (cmd: string, args: string[]) => {
            spawned.push({ cmd, args });
            const fakeChild: any = new EventEmitter();
            fakeChild.pid = 61234;
            fakeChild.stderr = new EventEmitter();
            fakeChild.kill = () => true;
            return fakeChild;
          },
        }
      );

      expect(res.success).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].cmd).toBe(fakeWine);
      // Directly spawns indie.exe, NOT steam.exe!
      expect(spawned[0].args[0]).toBe(gameExePath);
      expect(fs.existsSync(path.join(gameInstallDir, 'steam_appid.txt'))).toBe(true);

      await launcherEngine.stopGame({ gameId: 'steam-999111-fast' }, { platform: 'darwin' });
    });
  });

  // =========================================================================
  // OPTION 4: sandboxWinePrefixUserFolders SAVE SEEDING
  // =========================================================================
  describe('Option 4: sandboxWinePrefixUserFolders Save Seeding Before Symlink Unlink', () => {
    it('copy-seeds My Games & remotecache.vdf save subdirectories into bottle Documents before unlinking symlink while skipping blocklisted folders', () => {
      const mockHostHome = path.join(tmpRoot, 'hostHome');
      const mockHostDocs = path.join(mockHostHome, 'Documents');

      // 1. Create My Games save + remotecache.vdf-referenced save + unrelated Antigravity workspace folder on host
      writeTempFile(
        path.join(mockHostDocs, 'My Games', 'Skyrim Special Edition', 'Saves', 'Save1.ess'),
        'SKYRIM_SAVE_PAYLOAD'
      );
      writeTempFile(
        path.join(mockHostDocs, 'Klei', 'DoNotStarve', 'saveindex'),
        'KLEI_REMOTECACHE_SAVE'
      );
      writeTempFile(
        path.join(mockHostDocs, 'Antigravity', 'huge_workspace_file.bin'),
        'DO_NOT_COPY_ME'
      );

      // 2. Create mock bottle with Steam remotecache.vdf referencing WinMyDocuments/Klei/... and symlink Documents -> mockHostDocs
      const bottleDir = path.join(tmpRoot, 'Bottles', 'SeedBottle');
      const crossoverUserDir = path.join(bottleDir, 'drive_c', 'users', 'crossover');
      fs.mkdirSync(crossoverUserDir, { recursive: true });
      fs.symlinkSync(mockHostDocs, path.join(crossoverUserDir, 'Documents'));

      writeTempFile(
        path.join(
          bottleDir,
          'drive_c',
          'Program Files (x86)',
          'Steam',
          'userdata',
          '123456',
          '219740',
          'remotecache.vdf'
        ),
        [
          '"219740"',
          '{',
          '  "Klei/DoNotStarve/saveindex"',
          '  {',
          '    "root" "WinMyDocuments"',
          '    "size" "22"',
          '  }',
          '}',
        ].join('\n')
      );

      const res = launcherEngine.sandboxWinePrefixUserFolders(bottleDir, {
        homedir: mockHostHome,
      });

      expect(res.sandboxedFolders.length).toBeGreaterThanOrEqual(1);
      const bottleDocs = path.join(crossoverUserDir, 'Documents');
      expect(fs.lstatSync(bottleDocs).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(bottleDocs).isDirectory()).toBe(true);

      // My Games & remotecache.vdf Klei saves were copy-seeded into bottle-local Documents!
      expect(
        fs.readFileSync(
          path.join(bottleDocs, 'My Games', 'Skyrim Special Edition', 'Saves', 'Save1.ess'),
          'utf8'
        )
      ).toBe('SKYRIM_SAVE_PAYLOAD');
      expect(
        fs.readFileSync(path.join(bottleDocs, 'Klei', 'DoNotStarve', 'saveindex'), 'utf8')
      ).toBe('KLEI_REMOTECACHE_SAVE');

      // Blocklisted workspace directory was NOT copied into bottle!
      expect(fs.existsSync(path.join(bottleDocs, 'Antigravity'))).toBe(false);
      // Host Documents remains completely untouched!
      expect(fs.existsSync(path.join(mockHostDocs, 'Antigravity', 'huge_workspace_file.bin'))).toBe(
        true
      );
    });
  });

  // =========================================================================
  // OPTION 5: zero_renderer_daemon, pauseDownloadsInGame, ANTI-CHEAT & DLCs
  // =========================================================================
  describe('Option 5: Zero-Renderer Loading Guard, Download Pause/Resume, Anti-Cheat Bootstrappers & DLCs', () => {
    it('queues completed session when win.webContents.isLoadingMainFrame() is true in zero_renderer_daemon recreate window race', async () => {
      const pendingDir = path.join(tmpRoot, 'pendingSessions');
      const gameDir = path.join(tmpRoot, 'HollowKnightDir');
      const exePath = path.join(gameDir, 'hollow_knight.sh');
      writeTempFile(exePath, '#!/bin/sh\nsleep 5\n', 0o755);

      const sentIpcMessages: any[] = [];
      launcherEngine.setUserDataDir(pendingDir);
      launcherEngine.setMainWindowGetter(() => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoadingMainFrame: () => true,
          send: (channel: string, payload: any) => {
            sentIpcMessages.push({ channel, payload });
          },
        },
      }));

      try {
        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'custom-hollow-knight-race',
            platformId: 'custom',
            platformGameId: 'hk-race',
            title: 'Hollow Knight',
            installPath: gameDir,
            executablePath: exePath,
            launchConfig: { launchMethod: 'direct' },
          },
          {
            platform: 'darwin',
            homedir: tmpRoot,
            userDataDir: pendingDir,
            gameSpawnFn: () => {
              const fakeChild: any = new EventEmitter();
              fakeChild.pid = 79123;
              fakeChild.stderr = new EventEmitter();
              fakeChild.kill = () => true;
              return fakeChild;
            },
          }
        );
        expect(launchRes.success).toBe(true);

        const stopRes = await launcherEngine.stopGame(
          { gameId: 'custom-hollow-knight-race', homedir: tmpRoot },
          { platform: 'darwin', homedir: tmpRoot, userDataDir: pendingDir }
        );
        expect(stopRes.success).toBe(true);

        // Because main frame is still loading, ALL IPC sends were suppressed and completed session was persisted for drainPendingCompletedSessions!
        expect(sentIpcMessages).toHaveLength(0);
        const drained = launcherEngine.drainPendingCompletedSessions({ userDataDir: pendingDir });
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
          gameId: 'custom-hollow-knight-race',
          title: 'Hollow Knight',
        });
      } finally {
        launcherEngine.setMainWindowGetter(() => null);
      }
    });

    it('preserves GOG V1 tempBinPath on pauseDownload (resuming with HTTP 206 Range) and invokes resumeInstallFn on win32 CLI pause/resume', async () => {
      // 1. GOG V1 HTTP stream pause preserves tempBinPath and resumes via Range: bytes=8- (HTTP 206)
      const gogV1InstallDir = path.join(tmpRoot, 'GogV1PauseResumeGame');
      const fullPayload = Buffer.from('0123456789ABCDEF', 'utf8'); // 16 bytes total
      const seenRangeHeaders: Array<string | undefined> = [];
      let streamAttempt = 0;

      const makeJsonRes = (obj: unknown) => {
        const raw = Buffer.from(JSON.stringify(obj), 'utf8');
        return {
          ok: true,
          status: 200,
          json: async () => obj,
          arrayBuffer: async () =>
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        };
      };

      const mockV1Fetch = async (url: string, init?: any) => {
        if (url.includes('/builds?generation=2')) {
          return makeJsonRes({
            items: [
              {
                generation: 1,
                legacy_build_id: '991',
                link: 'https://cdn.gog-test.invalid/v1/meta/repository.json',
              },
            ],
          });
        }
        if (url.endsWith('/repository.json')) {
          return makeJsonRes({
            product: {
              installDirectory: 'GogV1PauseResumeGame',
              depots: [{ gameIDs: ['1207658924'], languages: ['en'], manifest: 'manifest_main.json' }],
            },
          });
        }
        if (url.endsWith('/manifest_main.json')) {
          return makeJsonRes({
            depot: {
              files: [{ path: 'game_payload.txt', offset: 0, size: 16 }],
            },
          });
        }
        if (url.includes('/secure_link')) {
          return makeJsonRes({
            urls: [{ url: 'https://cdn.gog-test.invalid/v1/depot' }],
          });
        }
        if (url.endsWith('/main.bin')) {
          streamAttempt += 1;
          const rangeHeader = init?.headers?.Range;
          seenRangeHeaders.push(rangeHeader);
          if (streamAttempt === 1) {
            return {
              ok: true,
              status: 200,
              body: (async function* () {
                yield fullPayload.subarray(0, 8);
                // Pause mid-stream after writing first 8 bytes!
                launcherEngine.pauseDownload('dl-gog-v1-range', { platform: 'darwin' });
                yield fullPayload.subarray(8, 16);
              })(),
            };
          }
          // Second attempt after resumeDownload -> expects Range: bytes=8-
          return {
            ok: true,
            status: 206,
            body: (async function* () {
              yield fullPayload.subarray(8, 16);
            })(),
          };
        }
        throw new Error(`Unexpected URL in mockV1Fetch: ${url}`);
      };

      // Seed task into downloadQueueMap first so pauseDownload/resumeDownload manage it
      await launcherEngine.installGame(
        {
          taskId: 'dl-gog-v1-range',
          gameId: 'gog-1207658924',
          platformId: 'custom',
          platformGameId: '1207658924',
          title: 'GOG V1 Pause Resume Game',
          installDir: gogV1InstallDir,
        },
        { userDataDir: tmpRoot, homedir: tmpRoot }
      );

      await expect(
        launcherEngine.downloadGogV1Depot(
          {
            taskId: 'dl-gog-v1-range',
            cleanId: '1207658924',
            platformGameId: '1207658924',
            title: 'GOG V1 Pause Resume Game',
            gogPlatformFlag: 'windows',
            finalInstallPath: gogV1InstallDir,
            gogToken: 'valid-gog-token-v1',
            platform: 'win32',
            totalBytes: 16,
          },
          { fetchImpl: mockV1Fetch, userDataDir: tmpRoot, homedir: tmpRoot }
        )
      ).rejects.toThrow(/paused/i);

      const tempBinPath = path.join(gogV1InstallDir, '.gog_v1_1207658924_main.bin');
      // tempBinPath MUST remain on disk with the 8 downloaded bytes!
      expect(fs.existsSync(tempBinPath)).toBe(true);
      expect(fs.statSync(tempBinPath).size).toBe(8);

      const gogResumeRes = launcherEngine.resumeDownload('dl-gog-v1-range', { platform: 'darwin' });
      expect(gogResumeRes.success).toBe(true);

      // Wait for async resumeInstallFn to complete HTTP 206 Range download & extraction
      const v1Deadline = Date.now() + 2000;
      while (
        launcherEngine.getDownloadQueue().find((t: any) => t.taskId === 'dl-gog-v1-range')?.status !==
          'completed' &&
        Date.now() < v1Deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(seenRangeHeaders).toEqual([undefined, 'bytes=8-']);
      expect(fs.readFileSync(path.join(gogV1InstallDir, 'game_payload.txt'), 'utf8')).toBe(
        '0123456789ABCDEF'
      );

      // 2. win32 CLI download pause terminates via taskkill and resume invokes resumeInstallFn
      const legCfgDir = path.join(tmpRoot, 'legCliPause');
      const installDir = path.join(tmpRoot, 'EpicDownloads');
      writeTempFile(
        path.join(legCfgDir, 'user.json'),
        JSON.stringify({ access_token: 'valid-real-token-abc', refresh_token: 'valid-real-refresh-xyz' })
      );
      writeTempFile(
        path.join(legCfgDir, 'metadata', 'PauseTestApp.json'),
        JSON.stringify({
          app_name: 'PauseTestApp',
          app_title: 'Pause Test Game',
          asset_infos: { Windows: { build_version: '1.0' } },
        })
      );
      const mockLegBin = path.join(tmpRoot, 'bin', 'legendary');
      writeTempFile(mockLegBin, '#!/bin/sh\nexit 0\n', 0o755);

      const spawnedArgsList: string[][] = [];
      const mockSpawn = (_cmd: string, args: string[]) => {
        spawnedArgsList.push(args);
        const proc: any = new EventEmitter();
        proc.pid = 70000 + spawnedArgsList.length;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => {
          proc.emit('close', 1);
          return true;
        };
        return proc;
      };

      const startRes = await launcherEngine.installGame(
        {
          taskId: 'dl-win32-epic-dlc',
          gameId: 'epic-PauseTestApp',
          platformId: 'epic',
          platformGameId: 'PauseTestApp',
          title: 'Pause Test Game',
          installDir,
          os: 'windows',
          includeDlcs: true,
        },
        {
          platform: 'win32',
          homedir: tmpRoot,
          userDataDir: tmpRoot,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: mockLegBin,
          spawnFn: mockSpawn,
          execFileFn: (_c: string, _a: string[], _o: any, cb: Function) => cb && cb(null, '', ''),
        }
      );

      expect(startRes.success).toBe(true);
      expect(spawnedArgsList).toHaveLength(1);
      // Verifies includeDlcs: true -> passes --with-dlcs!
      expect(spawnedArgsList[0]).toContain('--with-dlcs');

      // Pause on win32 -> status stays 'paused' even though child emitted 'close' with code 1!
      const pauseRes = launcherEngine.pauseDownload('dl-win32-epic-dlc', {
        platform: 'win32',
        execFileFn: (_c: string, _a: string[], _o: any, cb: Function) => cb && cb(null, '', ''),
      });
      expect(pauseRes.success).toBe(true);
      expect(pauseRes.task.status).toBe('paused');

      // Resume on win32 -> invokes resumeInstallFn which spawns legendary install a second time from checkpoint!
      const resumeRes = launcherEngine.resumeDownload('dl-win32-epic-dlc', { platform: 'win32' });
      expect(resumeRes.success).toBe(true);
      await new Promise((r) => setTimeout(r, 40));
      expect(spawnedArgsList.length).toBe(2);
      expect(spawnedArgsList[1]).toContain('--with-dlcs');

      launcherEngine.cancelDownload('dl-win32-epic-dlc');
    });

    it('prioritizes anti-cheat bootstrapper start_protected_game.exe (with EasyAntiCheat/Settings.json) over inner Shipping.exe on win32', () => {
      const gameDir = path.join(tmpRoot, 'EldenRingLike');
      const eacBootstrap = path.join(gameDir, 'start_protected_game.exe');
      const shippingExe = path.join(
        gameDir,
        'Game',
        'Binaries',
        'Win64',
        'EldenRingLike-Win64-Shipping.exe'
      );

      // Make shippingExe much larger (64 KB) than start_protected_game.exe (4 KB)
      writeTempFile(eacBootstrap, createMockPe64Buffer(4096));
      writeTempFile(shippingExe, createMockPe64Buffer(65536));
      writeTempFile(
        path.join(gameDir, 'EasyAntiCheat', 'Settings.json'),
        JSON.stringify({ productid: 'eac-prod-1', executable: 'Game/Binaries/Win64/EldenRingLike-Win64-Shipping.exe' })
      );

      const foundOnWin = launcherEngine.findPrimaryExecutable(gameDir, {
        platform: 'win32',
        hintName: 'EldenRingLike',
      });
      expect(foundOnWin.executablePath).toBe(eacBootstrap);
    });
  });

  // =========================================================================
  // ADVISORY ENGINE & UI MODALS (GameLaunchConfigModal & GameInstallModal)
  // =========================================================================
  describe('Advisory Engine & UI Controls (GameLaunchConfigModal & GameInstallModal)', () => {
    it('computes accurate FastMinimalLaunchAdvisory across Steam (bottle & native), GOG, and Epic', () => {
      const steamBottleOff = computeFastMinimalLaunchAdvisory({
        platformId: 'steam',
        detectedBuildType: 'windows_exe_on_mac',
        hostPlatform: 'darwin',
        launchMethod: 'auto',
        storefrontClientLifecycle: 'minimal_and_close_if_started',
      });
      expect(steamBottleOff.isActive).toBe(false);

      const steamBottleOn = launcherService.getFastMinimalLaunchAdvisory({
        platformId: 'steam',
        detectedBuildType: 'windows_exe_on_mac',
        hostPlatform: 'darwin',
        launchMethod: 'auto',
        storefrontClientLifecycle: 'fast_direct_bypass',
      });
      expect(steamBottleOn.isActive).toBe(true);
      expect(steamBottleOn.title).toContain('Bypasses Bottle Steam');
      expect(steamBottleOn.warnings.some((w) => w.includes('Steam Cloud Saves'))).toBe(true);
      expect(steamBottleOn.warnings.some((w) => w.includes('SteamStub / Denuvo'))).toBe(true);

      const gogDefault = computeFastMinimalLaunchAdvisory({
        platformId: 'gog',
        detectedBuildType: 'windows_native',
        hostPlatform: 'win32',
        launchMethod: 'direct',
        storefrontClientLifecycle: 'default',
      });
      expect(gogDefault.isActive).toBe(false);

      const gogOn = computeFastMinimalLaunchAdvisory({
        platformId: 'gog',
        detectedBuildType: 'windows_native',
        hostPlatform: 'win32',
        launchMethod: 'direct',
        storefrontClientLifecycle: 'fast_direct_bypass',
      });
      expect(gogOn.isActive).toBe(true);
      expect(gogOn.severity).toBe('warning');
      expect(gogOn.warnings.some((w) => w.includes('gogdl Cloud Saves'))).toBe(true);
      expect(gogOn.warnings.some((w) => w.includes('Achievements / Trophies Do NOT Work'))).toBe(
        true
      );

      const epicOn = computeFastMinimalLaunchAdvisory({
        platformId: 'epic',
        detectedBuildType: 'windows_exe_on_mac',
        hostPlatform: 'darwin',
        launchMethod: 'auto',
        storefrontClientLifecycle: 'fast_direct_bypass',
      });
      expect(epicOn.isActive).toBe(true);
      expect(epicOn.warnings.some((w) => w.includes('EOS OAuth Exchange Code'))).toBe(true);
    });

    it('GameLaunchConfigModal renders unified storefront-launch-policy-card and reveals orange fast-minimal-launch-warning when fast_direct_bypass is selected', () => {
      const mockLayers: CompatibilityLayerInfo[] = [
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          version: '26.0',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          available: true,
          bottlesDir: '/Users/test/Library/Application Support/CrossOver/Bottles',
          availableBottles: ['Steam'],
        },
      ];

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue(mockLayers);
      vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue(mockLayers);
      vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
      vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
        platformId: 'steam',
        platformGameId: '1091500',
        appId: 1091500,
        title: 'Bottle Steam Action RPG',
        installPath:
          '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/ActionRPG',
        executablePath:
          '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common/ActionRPG/game.exe',
        runner: 'crossover',
        isWindowsBinaryOnMac: true,
      });

      const game: CanonicalGame = {
        id: 'steam-1091500-modal-test',
        title: 'Bottle Steam Action RPG',
        sortTitle: 'Bottle Steam Action RPG',
        steamAppId: 1091500,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
          },
        ],
        genres: ['RPG'],
        tags: [],
        playtimeMinutes: 0,
      } as any;

      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const renderModal = () => {
        let sIdx = 0;
        let eIdx = 0;
        const prevH = internals.H;
        internals.H = {
          useState(init: any) {
            const idx = sIdx++;
            if (idx >= states.length) {
              states.push(typeof init === 'function' ? init() : init);
            }
            const setS = (upd: any) => {
              states[idx] = typeof upd === 'function' ? upd(states[idx]) : upd;
            };
            return [states[idx], setS];
          },
          useEffect(fn: () => any) {
            const idx = eIdx++;
            if (!effectsRan[idx]) {
              effectsRan[idx] = true;
              fn();
            }
          },
          useRef(init: any) {
            return { current: init };
          },
          useMemo(fn: () => any) {
            return fn();
          },
          useCallback(fn: any) {
            return fn;
          },
        };
        try {
          const vnode = (GameLaunchConfigModal as any)({
            isOpen: true,
            game,
            initialPlatformId: 'steam',
            onClose: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      const initialRender = renderModal();
      expect(initialRender.html).toContain('data-testid="storefront-launch-policy-card"');
      expect(initialRender.html).toContain('Bottle Steam Launch Policy');
      expect(initialRender.html).toContain('data-testid="storefront-policy-info-box"');
      expect(initialRender.html).toContain('data-policy-severity="optimal"');
      expect(initialRender.html).toContain('data-testid="storefront-client-lifecycle-select"');
      expect(initialRender.html).toContain('value="fast_direct_bypass"');
      expect(initialRender.html).not.toContain('data-testid="toggle-bottle-fast-bypass"');
      expect(initialRender.html).not.toContain('data-testid="fast-minimal-launch-warning"');

      const lifecycleSelect = findElements(
        initialRender.vnode,
        (el) => el.props?.['data-testid'] === 'storefront-client-lifecycle-select'
      )[0];
      expect(lifecycleSelect).toBeDefined();
      expect(lifecycleSelect.props.value).toBe('minimal_and_close_if_started');

      // Select fast_direct_bypass -> displays orange warning info box with fast-minimal-launch-warning
      lifecycleSelect.props.onChange({ target: { value: 'fast_direct_bypass' } });
      const afterSelectRender = renderModal();
      expect(afterSelectRender.html).toContain('data-policy-severity="warning"');
      expect(afterSelectRender.html).toContain('bg-orange-950/45');
      expect(afterSelectRender.html).toContain('data-testid="fast-minimal-launch-warning"');
      expect(afterSelectRender.html).toContain('Steam Cloud Saves');
      expect(afterSelectRender.html).toContain('SteamStub');
    });

    it('GameInstallModal renders toggle-include-dlcs checked by default for Epic/GOG and passes includeDlcs to startInstall', async () => {
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        success: true,
        platformId: 'epic',
        platformGameId: 'EpicDlcAdventure',
        defaultInstallDir: '/Users/test/Games/OneLauncher',
        availableInstallDirs: ['/Users/test/Games/OneLauncher'],
        estimatedSizeBytes: 4096,
        availableInstallers: [
          { id: 'mac-ins', os: 'mac', title: 'macOS Build', totalSizeBytes: 4096 },
        ],
      } as any);
      vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
        freeBytes: 200 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        usedBytes: 300 * 1024 * 1024 * 1024,
      } as any);

      const startInstallSpy = vi.spyOn(launcherService, 'startInstall').mockResolvedValue({
        success: true,
        message: 'Started',
      } as any);

      const epicGame: CanonicalGame = {
        id: 'epic-EpicDlcAdventure',
        title: 'Epic DLC Adventure',
        sortTitle: 'Epic DLC Adventure',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'EpicDlcAdventure',
            installed: false,
          },
        ],
        genres: ['Adventure'],
        tags: [],
        playtimeMinutes: 0,
      } as any;

      const states: any[] = [];
      const effectsRan: boolean[] = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const renderInstall = () => {
        let sIdx = 0;
        let eIdx = 0;
        const prevH = internals.H;
        internals.H = {
          useState(init: any) {
            const idx = sIdx++;
            if (idx >= states.length) {
              states.push(typeof init === 'function' ? init() : init);
            }
            const setS = (upd: any) => {
              states[idx] = typeof upd === 'function' ? upd(states[idx]) : upd;
            };
            return [states[idx], setS];
          },
          useEffect(fn: () => any) {
            const idx = eIdx++;
            if (!effectsRan[idx]) {
              effectsRan[idx] = true;
              fn();
            }
          },
          useRef(init: any) {
            return { current: init };
          },
          useMemo(fn: () => any) {
            return fn();
          },
          useCallback(fn: any) {
            return fn;
          },
        };
        try {
          const vnode = (GameInstallModal as any)({
            isOpen: true,
            game: epicGame,
            initialPlatformId: 'epic',
            onClose: vi.fn(),
          });
          const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
          return { vnode, html };
        } finally {
          internals.H = prevH;
        }
      };

      const r1 = renderInstall();
      await new Promise((r) => setTimeout(r, 20));
      const r2 = renderInstall();

      expect(r2.html).toContain('data-testid="toggle-include-dlcs"');
      const dlcCheckbox = findElements(
        r2.vnode,
        (el) => el.props?.['data-testid'] === 'toggle-include-dlcs'
      )[0];
      expect(dlcCheckbox).toBeDefined();
      expect(dlcCheckbox.props.checked).toBe(true);

      // Click Start Download & Install -> passes includeDlcs: true
      const startBtn = findElements(
        r2.vnode,
        (el) =>
          el.type === 'button' &&
          JSON.stringify(el.props?.children || '').includes('Start Download & Install')
      )[0];
      expect(startBtn).toBeDefined();
      await startBtn.props.onClick();

      expect(startInstallSpy).toHaveBeenCalledTimes(1);
      expect(startInstallSpy.mock.calls[0][0]).toMatchObject({
        platformId: 'epic',
        platformGameId: 'EpicDlcAdventure',
        includeDlcs: true,
      });
      void r1;
    });
  });
});
