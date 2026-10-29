import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import type { CanonicalGame } from '../src/contracts/game';
import type {
  InstalledGameRecord,
  StorefrontClientLifecyclePolicy,
} from '../src/contracts/launcher';
import type { StorefrontId } from '../src/contracts/platform';
import { buildStorefrontLaunchPolicyView } from '../src/services/launcher/launchPolicyPreview';
import { launcherService } from '../src/services/launcher/launcherService';
import {
  mergeStorefrontGames,
  reconcileCatalogGamesWithInstalledRecords,
  mergeUpdatedGamePreservingLivePlatformState,
  mergeHydratedCatalogPreservingLiveState,
} from '../src/services/integrations/integrationStorage';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';

const requireCjs = createRequire(import.meta.url);
const cjsFs = requireCjs('node:fs') as typeof fs;
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');
const readinessBarrier = requireCjs('../electron/launcher/storefrontReadinessBarrier.cjs');
const firstPartyReg = requireCjs('../electron/launcher/firstPartyRegistration.cjs');
const windowsRegistryDiscovery = requireCjs('../electron/utils/windowsRegistryDiscovery.cjs');

function createFakeChildProcess(pid = 51200) {
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

const createdTempDirs: string[] = [];

function trackTempDir(prefix: string): string {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-3x3-${prefix}-`));
  const resolved = fs.realpathSync(rawDir);
  createdTempDirs.push(resolved);
  return resolved;
}

describe('Dual-OS 3×3 Silent Launch, Bidirectional First-Party Registration & Quit/Relaunch Persistence Suite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    launcherEngine.setUserDataDir(null);
    launcherEngine.clearDownloadQueue();
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
  // TASK 1: 3×3 Silent Launch, Storefront Daemon Readiness Handshakes & Hygiene
  // ============================================================================
  describe('Task 1 — 3×3 Silent Launch, Storefront Daemon Readiness Handshakes & Process Hygiene', () => {
    it('1A: filters GOG Galaxy auxiliary/bottle processes in isHostGogGalaxyRunning and reaps only orphaned GOG Galaxy Overlay processes', async () => {
      // Negative cases on darwin: overlay, service, updater, helper, comm daemon, and Wine/CrossOver GalaxyClient.exe
      const darwinAuxList = [
        '4101 /Applications/GOG Galaxy.app/Contents/MacOS/GalaxyCommunication',
        '4102 /Users/Shared/GOG.com/Galaxy/redists/overlay/current/GOG Galaxy Overlay.app/Contents/MacOS/GOG Galaxy Overlay --product-id=1800001001 --attached-pid=99100',
        '4103 /Library/PrivilegedHelperTools/com.gog.galaxy.ClientService/GalaxyClientService',
        '4104 /Applications/GOG Galaxy.app/Contents/MacOS/GalaxyUpdater',
        '4105 /Applications/GOG Galaxy.app/Contents/Frameworks/GOG Galaxy Helper (Renderer).app/Contents/MacOS/GOG Galaxy Helper (Renderer)',
        '4106 C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe /launchViaAutoStart',
      ].join('\n');
      expect(
        await readinessBarrier.isHostGogGalaxyRunning({
          platform: 'darwin',
          mockProcessListOutput: darwinAuxList,
        })
      ).toBe(false);

      // Positive case on darwin: real host GOG Galaxy binary
      expect(
        await readinessBarrier.isHostGogGalaxyRunning({
          platform: 'darwin',
          mockProcessListOutput: `${darwinAuxList}\n4199 /Applications/GOG Galaxy.app/Contents/MacOS/GOG Galaxy --launchViaAutoStart`,
        })
      ).toBe(true);

      // Negative & positive cases on win32
      const winAuxCsv = [
        '"GalaxyCommunication.exe","2100","Console","1","18,400 K"',
        '"GalaxyOverlay.exe","2101","Console","1","42,100 K"',
        '"GalaxyClientService.exe","2102","Services","0","12,000 K"',
        '"GalaxyUpdater.exe","2103","Console","1","15,000 K"',
        '"GalaxyClient Helper.exe","2104","Console","1","31,000 K"',
      ].join('\r\n');
      expect(
        await readinessBarrier.isHostGogGalaxyRunning({
          platform: 'win32',
          mockProcessListOutput: winAuxCsv,
        })
      ).toBe(false);
      expect(
        await readinessBarrier.isHostGogGalaxyRunning({
          platform: 'win32',
          mockProcessListOutput: `${winAuxCsv}\r\n"GalaxyClient.exe","3120","Console","1","94,200 K"`,
        })
      ).toBe(true);

      // Orphaned GOG Galaxy Overlay reaper: kills dead --attached-pid, spares live --attached-pid
      const killed: Array<{ pid: number; signal: string }> = [];
      const aliveGamePids = new Set([62002]);
      const overlayOut = [
        '51001 /Users/Shared/GOG.com/Galaxy/redists/overlay/GOG Galaxy Overlay --product-id=1800001001 --attached-pid=62001',
        '51002 /Users/Shared/GOG.com/Galaxy/redists/overlay/GOG Galaxy Overlay --product-id=1800001002 --attached-pid=62002',
      ].join('\n');

      const reapRes = await readinessBarrier.reapOrphanedGogOverlayProcesses({
        platform: 'darwin',
        allowOverlayReaperInTest: true,
        mockOverlayProcessList: overlayOut,
        isPidAliveFn: (pid: number) => aliveGamePids.has(pid),
        killPidFn: (pid: number, signal: string) => {
          killed.push({ pid, signal });
        },
      });
      expect(reapRes.reapedPids).toEqual([51001]);
      expect(killed).toEqual([{ pid: 51001, signal: 'SIGTERM' }]);
    });

    it('1B: detects deep macOS .framework, Unity .bundle, symlinked SDKs, and Windows Galaxy64.dll in doesGogInstallUseGalaxySdk while returning false for pure DRM-free games', () => {
      const root = trackTempDir('gog-sdk-scan');

      // 1. Pure DRM-free macOS & Windows installs -> false
      const drmFreeMac = path.join(root, 'PureMacFolder');
      const drmFreeMacBin = path.join(drmFreeMac, 'PureGame.app', 'Contents', 'MacOS', 'PureGame');
      fs.mkdirSync(path.dirname(drmFreeMacBin), { recursive: true });
      fs.writeFileSync(drmFreeMacBin, '#!/bin/sh\nexit 0\n');
      expect(launcherEngine.doesGogInstallUseGalaxySdk(drmFreeMac, drmFreeMacBin)).toBe(false);

      const drmFreeWin = path.join(root, 'PureWinFolder');
      const drmFreeWinExe = path.join(drmFreeWin, 'Bin', 'PureWin.exe');
      fs.mkdirSync(path.dirname(drmFreeWinExe), { recursive: true });
      fs.writeFileSync(drmFreeWinExe, 'MZ-DRM-FREE');
      expect(launcherEngine.doesGogInstallUseGalaxySdk(drmFreeWin, drmFreeWinExe)).toBe(false);

      // 2. Depth-6 macOS framework binary: <Game>.app/Contents/Frameworks/Galaxy64.framework/Versions/A/Galaxy64
      const fwInstall = path.join(root, 'FrameworkMacGame');
      const fwBin = path.join(
        fwInstall,
        'Starlight.app',
        'Contents',
        'Frameworks',
        'Galaxy64.framework',
        'Versions',
        'A',
        'Galaxy64'
      );
      fs.mkdirSync(path.dirname(fwBin), { recursive: true });
      fs.writeFileSync(fwBin, 'MACHO-GALAXY64');
      expect(launcherEngine.doesGogInstallUseGalaxySdk(fwInstall)).toBe(true);

      // 3. Unity macOS plugin bundle: <Game>.app/Contents/Resources/Data/Plugins/Galaxy.bundle/Contents/MacOS/libGalaxy64.dylib
      const unityInstall = path.join(root, 'UnityMacGame');
      const unityDylib = path.join(
        unityInstall,
        'Nebula.app',
        'Contents',
        'Resources',
        'Data',
        'Plugins',
        'Galaxy.bundle',
        'Contents',
        'MacOS',
        'libGalaxy64.dylib'
      );
      fs.mkdirSync(path.dirname(unityDylib), { recursive: true });
      fs.writeFileSync(unityDylib, 'MACHO-UNITY-GALAXY');
      expect(launcherEngine.doesGogInstallUseGalaxySdk(unityInstall)).toBe(true);

      // 4. Symlinked SDK dylib inside app Frameworks
      const symlinkTarget = path.join(root, 'SharedSdkPool', 'custom_runtime.bin');
      fs.mkdirSync(path.dirname(symlinkTarget), { recursive: true });
      fs.writeFileSync(symlinkTarget, 'MACHO-SYMLINK');
      const symlinkInstall = path.join(root, 'SymlinkMacGame');
      const symlinkDir = path.join(symlinkInstall, 'Comet.app', 'Contents', 'Frameworks');
      fs.mkdirSync(symlinkDir, { recursive: true });
      fs.symlinkSync(symlinkTarget, path.join(symlinkDir, 'libGalaxy64.dylib'));
      expect(launcherEngine.doesGogInstallUseGalaxySdk(symlinkInstall)).toBe(true);

      // 5. Windows Galaxy64.dll
      const winSdkInstall = path.join(root, 'WinSdkGame');
      fs.mkdirSync(path.join(winSdkInstall, 'Binaries', 'Win64'), { recursive: true });
      fs.writeFileSync(path.join(winSdkInstall, 'Binaries', 'Win64', 'Galaxy64.dll'), 'PE-DLL');
      expect(launcherEngine.doesGogInstallUseGalaxySdk(winSdkInstall)).toBe(true);
    });

    it('1C: enforces real TCP + GalaxyCommunication.log AuthManager readiness handshake and post-exit GameplayLogicManager flush barrier', async () => {
      const tmp = trackTempDir('gog-comm-barrier');
      const commLogPath = path.join(tmp, 'GalaxyCommunication.log');

      // Seed stale closed session: signed in earlier, then Communication service stopping
      fs.writeFileSync(
        commLogPath,
        [
          '2026-10-24 12:00:01.000 [Info] Communication service starting',
          '2026-10-24 12:00:02.100 [Info] [AuthManager(90000000000000001)::AuthListener] Succeeded to sign in.',
          '2026-10-24 12:05:00.000 [Info] Communication service stopping',
        ].join('\n') + '\n',
        'utf8'
      );
      expect(readinessBarrier.hasActiveGogAuthSessionInLog(commLogPath, 0)).toBe(false);

      const server = net.createServer((socket) => {
        socket.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address();
      const dynamicPort = typeof addr === 'object' && addr ? addr.port : 0;
      expect(dynamicPort).toBeGreaterThan(0);

      try {
        // Confirm closed-session timeout when TCP is open but no new AuthManager sign-in arrives
        const closedTimeoutRes = await readinessBarrier.waitForGogCommunicationServiceReady({
          port: dynamicPort,
          gogCommunicationLogPath: commLogPath,
          enableGogReadinessBarrier: true,
          alreadyRunning: true,
          timeoutMs: 90,
          pollIntervalMs: 20,
        });
        expect(closedTimeoutRes.ready).toBe(false);

        // Now start barrier and append fresh Communication service starting + AuthManager sign-in after 80ms
        const preBootOffset = fs.statSync(commLogPath).size;
        const appendTimer = setTimeout(() => {
          fs.appendFileSync(
            commLogPath,
            [
              '2026-10-24 12:10:00.010 [Info] Communication service starting',
              '2026-10-24 12:10:00.080 [Info] [AuthManager(90000000000000001)::AuthListener] Succeeded to sign in.',
            ].join('\n') + '\n',
            'utf8'
          );
        }, 80);

        const readyRes = await readinessBarrier.waitForGogCommunicationServiceReady({
          port: dynamicPort,
          gogCommunicationLogPath: commLogPath,
          preBootLogOffset: preBootOffset,
          enableGogReadinessBarrier: true,
          timeoutMs: 2500,
          pollIntervalMs: 20,
        });
        clearTimeout(appendTimer);
        expect(readyRes.ready).toBe(true);
        expect(readyRes.reason).toBe('tcp_and_auth_ready');
        expect(readyRes.waitedMs).toBeGreaterThanOrEqual(60);

        // Post-exit flush barrier waits for [GameplayLogicManager] destructor after preExitOffset
        const preExitOffset = fs.statSync(commLogPath).size;
        const flushTimer = setTimeout(() => {
          fs.appendFileSync(
            commLogPath,
            '2026-10-24 12:25:00.120 [Info] [GameplayLogicManager] destructor\n',
            'utf8'
          );
        }, 60);

        const flushRes = await readinessBarrier.waitForGogPostExitFlush({
          gogCommunicationLogPath: commLogPath,
          preExitOffset,
          enableGogReadinessBarrier: true,
          maxFlushWaitMs: 1500,
          settleMs: 25,
          pollIntervalMs: 15,
        });
        clearTimeout(flushTimer);
        expect(flushRes.flushed).toBe(true);
        expect(flushRes.reason).toBe('destructor_settled');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('1D: scopes Bottle GOG/Epic process detection by WINEPREFIX, skips waking Bottle GOG for pure DRM-free installs, wakes SDK installs with /launchViaAutoStart /runWithoutUpdating, and shuts down Bottle Epic gracefully without /F first', async () => {
      const tmpHome = trackTempDir('bottle-gog-epic');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const appsDir = path.join(tmpHome, 'Applications');
      const crossoverBinDir = path.join(
        appsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin'
      );
      const crossoverAppBin = path.join(crossoverBinDir, 'wine');
      fs.mkdirSync(crossoverBinDir, { recursive: true });
      fs.writeFileSync(crossoverAppBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(crossoverBinDir, 'wineserver'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });

      const spaceFreeBottlesRoot = path.join(tmpHome, 'CrossOver', 'Bottles');
      const bottleA = path.join(spaceFreeBottlesRoot, 'BottleA');
      const bottleB = path.join(spaceFreeBottlesRoot, 'BottleB');
      fs.mkdirSync(path.join(bottleA, 'drive_c'), { recursive: true });
      fs.mkdirSync(path.join(bottleB, 'drive_c'), { recursive: true });

      // 1. Strict WINEPREFIX scoping across BottleA vs BottleB
      const psBottleAOnly = [
        `7101 ${crossoverAppBin} "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe" WINEPREFIX="${bottleA}"`,
        `7102 ${crossoverAppBin} "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe" WINEPREFIX="${bottleA}"`,
      ].join('\n');
      expect(
        await readinessBarrier.isBottleWinExeRunning('GalaxyClient.exe', bottleA, {
          platform: 'darwin',
          mockProcessListOutput: psBottleAOnly,
        })
      ).toBe(true);
      expect(
        await readinessBarrier.isBottleWinExeRunning('GalaxyClient.exe', bottleB, {
          platform: 'darwin',
          mockProcessListOutput: psBottleAOnly,
        })
      ).toBe(false);
      expect(
        await readinessBarrier.isBottleWinExeRunning('EpicGamesLauncher.exe', bottleB, {
          platform: 'darwin',
          mockProcessListOutput: psBottleAOnly,
        })
      ).toBe(false);

      // Seed CrossOver bottle in standard CrossOver Bottles container for end-to-end launchGame tests
      const launchBottle = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      fs.mkdirSync(path.join(launchBottle, 'drive_c'), { recursive: true });
      fs.writeFileSync(path.join(launchBottle, 'cxbottle.conf'), '[Bottle]\n', 'utf8');
      fs.writeFileSync(path.join(launchBottle, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      fs.writeFileSync(path.join(launchBottle, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

      const bottleGogExe = path.join(
        launchBottle,
        'drive_c',
        'Program Files (x86)',
        'GOG Galaxy',
        'GalaxyClient.exe'
      );
      const bottleEpicExe = path.join(
        launchBottle,
        'drive_c',
        'Program Files (x86)',
        'Epic Games',
        'Launcher',
        'Portal',
        'Binaries',
        'Win64',
        'EpicGamesLauncher.exe'
      );
      fs.mkdirSync(path.dirname(bottleGogExe), { recursive: true });
      fs.mkdirSync(path.dirname(bottleEpicExe), { recursive: true });
      fs.writeFileSync(bottleGogExe, 'MZ-GOG');
      fs.writeFileSync(bottleEpicExe, 'MZ-EPIC');

      // 2. Pure DRM-free Bottle GOG install (no Galaxy*.dll) -> does NOT wake GalaxyClient.exe
      const drmFreeGameDir = path.join(launchBottle, 'drive_c', 'GOG Games', 'SyntheticDrmFreeWin');
      const drmFreeGameExe = path.join(drmFreeGameDir, 'SyntheticDrmFreeWin.exe');
      fs.mkdirSync(drmFreeGameDir, { recursive: true });
      fs.writeFileSync(drmFreeGameExe, 'MZ-GAME');

      const clientSpawns: Array<{ cmd: string; args: string[] }> = [];
      const execCalls: Array<{ cmd: string; args: string[] }> = [];
      const baseOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        customApplicationsDir: appsDir,
        skipAuthRefresh: true,
        strictGalaxySdkCheck: true,
        mockProcessListOutput: '',
        bottleClientSpawnFn: (cmd: string, args: string[]) => {
          clientSpawns.push({ cmd, args });
          return createFakeChildProcess(72001);
        },
        gameSpawnFn: () => createFakeChildProcess(72002),
        execFileImpl: (cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout?: string) => void) => {
          execCalls.push({ cmd, args: Array.isArray(args) ? args : [] });
          if (typeof _opts === 'function') (_opts as (err: Error | null, stdout: string) => void)(null, '');
          else if (typeof cb === 'function') cb(null, '');
        },
      };

      const drmFreeRes = await launcherEngine.launchGame(
        {
          gameId: 'gog-1800001001',
          title: 'Synthetic DRM Free Win',
          platformId: 'gog',
          platformGameId: '1800001001',
          installPath: drmFreeGameDir,
          executablePath: drmFreeGameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            crossoverBottle: 'OneLauncher',
            winePrefix: launchBottle,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        baseOpts
      );
      expect(drmFreeRes.success).toBe(true);
      expect(clientSpawns).toHaveLength(0);
      await launcherEngine.stopGame({ gameId: 'gog-1800001001' }, baseOpts);

      // SDK Bottle GOG install with Galaxy64.dll -> wakes GalaxyClient.exe with ['/launchViaAutoStart', '/runWithoutUpdating']
      const sdkGameDir = path.join(launchBottle, 'drive_c', 'GOG Games', 'SyntheticSdkWin');
      const sdkGameExe = path.join(sdkGameDir, 'SyntheticSdkWin.exe');
      fs.mkdirSync(sdkGameDir, { recursive: true });
      fs.writeFileSync(sdkGameExe, 'MZ-SDK-GAME');
      fs.writeFileSync(path.join(sdkGameDir, 'Galaxy64.dll'), 'PE-GALAXY64');

      const sdkRes = await launcherEngine.launchGame(
        {
          gameId: 'gog-1800001002',
          title: 'Synthetic SDK Win',
          platformId: 'gog',
          platformGameId: '1800001002',
          installPath: sdkGameDir,
          executablePath: sdkGameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            crossoverBottle: 'OneLauncher',
            winePrefix: launchBottle,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        baseOpts
      );
      expect(sdkRes.success).toBe(true);
      expect(clientSpawns).toHaveLength(1);
      expect(clientSpawns[0].args).toEqual([
        bottleGogExe,
        '/launchViaAutoStart',
        '/runWithoutUpdating',
      ]);
      await launcherEngine.stopGame({ gameId: 'gog-1800001002' }, baseOpts);

      // 3. Bottle Epic launch + natural exit -> graceful ['taskkill', '/IM', 'EpicGamesLauncher.exe'] without /F first
      clientSpawns.length = 0;
      execCalls.length = 0;
      const bottleEpicGameDir = path.join(launchBottle, 'drive_c', 'Games', 'SyntheticEpicWin');
      const bottleEpicGameExe = path.join(bottleEpicGameDir, 'SyntheticEpicWin.exe');
      fs.mkdirSync(bottleEpicGameDir, { recursive: true });
      fs.writeFileSync(bottleEpicGameExe, 'MZ-EPIC-GAME');

      let epicGameProc: ReturnType<typeof createFakeChildProcess> | null = null;
      const epicOpts = {
        ...baseOpts,
        gameSpawnFn: () => {
          epicGameProc = createFakeChildProcess(73001);
          return epicGameProc;
        },
      };

      const epicLaunchRes = await launcherEngine.launchGame(
        {
          gameId: 'epic-SyntheticOrionApp',
          title: 'Synthetic Orion',
          platformId: 'epic',
          platformGameId: 'SyntheticOrionApp',
          installPath: bottleEpicGameDir,
          executablePath: bottleEpicGameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            crossoverBottle: 'OneLauncher',
            winePrefix: launchBottle,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        epicOpts
      );
      expect(epicLaunchRes.success).toBe(true);
      expect(clientSpawns).toHaveLength(1);
      expect(clientSpawns[0].args).toEqual([bottleEpicExe, '-silent']);

      // Simulate natural game exit so finalizeGameSession runs Bottle Epic shutdown
      epicGameProc!.emit('exit', 0, null);
      await new Promise((r) => setTimeout(r, 80));

      const taskkillCalls = execCalls.filter((c) => c.args[0] === 'taskkill');
      expect(taskkillCalls.length).toBeGreaterThanOrEqual(1);
      expect(taskkillCalls[0].args).toEqual(['taskkill', '/IM', 'EpicGamesLauncher.exe']);
      expect(taskkillCalls[0].args).not.toContain('/F');
    });

    it('1E: extracts live Steam gameprocess_log.txt PIDs and enforces zero /deactivated or -SuppressBrowser flags across all buildStorefrontLaunchPolicyView cells', () => {
      const steamRoot = trackTempDir('steam-gameproc-log');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const gpLog = path.join(logsDir, 'gameprocess_log.txt');
      fs.writeFileSync(
        gpLog,
        [
          '[2026-10-24 14:00:01] AppID 990011 adding PID 81001 as a tracked process ""',
          '[2026-10-24 14:00:03] AppID 990011 no longer tracking PID 81001, exit code 0',
          '[2026-10-24 14:00:04] AppID 990011 adding PID 81002 as a tracked process "/Games/RealGame"',
        ].join('\n') + '\n',
        'utf8'
      );

      const trackedPid = readinessBarrier.extractTrackedPidFromSteamGameProcessLog(
        steamRoot,
        990011,
        0,
        { isPidAliveFn: (pid: number) => pid === 81001 || pid === 81002 }
      );
      expect(trackedPid).toBe(81002);

      // Verify Bottle GOG & Bottle Steam footprint copy and exhaustive zero-banned-flag sweep
      const bottleGogView = buildStorefrontLaunchPolicyView({
        platformId: 'gog',
        detectedBuildType: 'windows_exe_on_mac',
        activeDisplayMethod: 'compatibility_layer',
        effectiveLifecycle: 'minimal_and_close_if_started',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(bottleGogView.infoBox.footprintSummary).toContain(
        '/launchViaAutoStart /runWithoutUpdating'
      );

      const bottleSteamKeepView = buildStorefrontLaunchPolicyView({
        platformId: 'steam',
        detectedBuildType: 'windows_exe_on_mac',
        activeDisplayMethod: 'compatibility_layer',
        effectiveLifecycle: 'minimal_keep_running',
        isInstalled: true,
        hostPlatform: 'darwin',
      });
      expect(bottleSteamKeepView.infoBox.footprintSummary).toContain(
        '-silent -nofriendsui -nochatui'
      );

      const platforms: StorefrontId[] = ['steam', 'gog', 'epic'];
      const buildTypes = [
        'mac_native_app',
        'mac_native_bin',
        'windows_exe_on_mac',
        'windows_native',
        'not_installed',
      ] as const;
      const methods = ['auto', 'direct', 'compatibility_layer', 'storefront_uri'] as const;
      const lifecycles: StorefrontClientLifecyclePolicy[] = [
        'minimal_and_close_if_started',
        'minimal_keep_running',
        'default_client',
        'fast_direct_bypass',
      ];
      const hosts = ['darwin', 'win32'] as const;

      for (const platformId of platforms) {
        for (const detectedBuildType of buildTypes) {
          for (const activeDisplayMethod of methods) {
            for (const effectiveLifecycle of lifecycles) {
              for (const hostPlatform of hosts) {
                const view = buildStorefrontLaunchPolicyView({
                  platformId,
                  detectedBuildType,
                  activeDisplayMethod,
                  effectiveLifecycle,
                  isInstalled: detectedBuildType !== 'not_installed',
                  hostPlatform,
                });
                const serialized = JSON.stringify(view);
                expect(serialized).not.toContain('/deactivated');
                expect(serialized).not.toContain('-SuppressBrowser');
              }
            }
          }
        }
      }
    });

    it('1F: executes production-realistic Native macOS and Native Windows GOG direct & storefront_uri silent launch + lifecycle shutdown WITHOUT libGalaxy*.dylib / Galaxy*.dll or gogGalaxyClientPath override', async () => {
      // --- Part 1: Native macOS GOG (.app without libGalaxy*.dylib, no gogGalaxyClientPath override) ---
      const macHome = trackTempDir('cell-1f-mac-native-gog');
      const macUserData = path.join(macHome, 'userdata');
      const macInstallDir = path.join(macHome, 'Games', 'OneLauncher', 'GOG', 'SyntheticNativeMacGog');
      const macAppDir = path.join(macInstallDir, 'SyntheticNativeMacGog.app');
      const macExe = path.join(macAppDir, 'Contents', 'MacOS', 'SyntheticNativeMacGog');
      fs.mkdirSync(path.dirname(macExe), { recursive: true });
      fs.writeFileSync(
        path.join(macAppDir, 'Contents', 'Info.plist'),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<plist version="1.0"><dict>',
          '<key>CFBundleExecutable</key><string>SyntheticNativeMacGog</string>',
          '<key>CFBundleIdentifier</key><string>com.synthetic.nativemacgog</string>',
          '</dict></plist>',
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(macExe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(launcherEngine.doesGogInstallUseGalaxySdk(macInstallDir, macExe)).toBe(false);

      const gogAppPath = path.join(macHome, 'Applications', 'GOG Galaxy.app');
      const gogInnerBin = path.join(gogAppPath, 'Contents', 'MacOS', 'GOG Galaxy');
      fs.mkdirSync(path.dirname(gogInnerBin), { recursive: true });
      fs.writeFileSync(gogInnerBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const sessionEvents: Array<Record<string, unknown>> = [];
      const unsubscribeSession = launcherEngine.onSessionUpdated((ev: Record<string, unknown>) => {
        sessionEvents.push(ev);
      });

      const timeline: string[] = [];
      const macClientSpawns: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
      const macGameSpawns: Array<{ cmd: string; args: string[] }> = [];
      const macExecCalls: Array<{ cmd: string; args: string[] }> = [];
      const openedUris: string[] = [];

      const resetMacTrackers = () => {
        sessionEvents.length = 0;
        timeline.length = 0;
        macClientSpawns.length = 0;
        macGameSpawns.length = 0;
        macExecCalls.length = 0;
        openedUris.length = 0;
      };

      const macBaseOpts = {
        platform: 'darwin',
        homedir: macHome,
        userDataDir: macUserData,
        allowGogWakeInTest: true,
        skipAuthRefresh: true,
        mockProcessListOutput: '',
        spawnFn: (cmd: string, args: string[], opts: Record<string, unknown> = {}) => {
          macClientSpawns.push({ cmd, args: Array.isArray(args) ? args : [], opts });
          timeline.push(`client-spawn:${cmd}`);
          return createFakeChildProcess(82001);
        },
        gameSpawnFn: (cmd: string, args: string[]) => {
          macGameSpawns.push({ cmd, args: Array.isArray(args) ? args : [] });
          timeline.push('game-spawn');
          return createFakeChildProcess(82002);
        },
        execFileImpl: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout?: string) => void
        ) => {
          macExecCalls.push({ cmd, args: Array.isArray(args) ? args : [] });
          timeline.push(`exec:${cmd}`);
          if (typeof _opts === 'function') (_opts as (err: Error | null, stdout: string) => void)(null, '');
          else if (typeof cb === 'function') cb(null, '');
        },
        openExternalFn: async (uri: string) => {
          openedUris.push(uri);
          timeline.push(`open-uri:${uri}`);
        },
      };

      try {
        // (a) direct + minimal_and_close_if_started
        const resA = await launcherEngine.launchGame(
          {
            gameId: 'gog-1800001099',
            title: 'Synthetic Native Mac GOG',
            platformId: 'gog',
            platformGameId: '1800001099',
            installPath: macInstallDir,
            executablePath: macExe,
            launchConfig: {
              launchMethod: 'direct',
              storefrontClientLifecycle: 'minimal_and_close_if_started',
            },
          },
          macBaseOpts
        );
        expect(resA.success).toBe(true);
        expect(
          sessionEvents.some(
            (ev) =>
              ev.status === 'starting' &&
              ev.statusMessage === 'Starting GOG Galaxy background service...'
          )
        ).toBe(true);
        expect(macClientSpawns).toHaveLength(1);
        expect(macClientSpawns[0].cmd).toBe('/usr/bin/open');
        expect(macClientSpawns[0].args).toEqual([
          '-g',
          '-j',
          '-a',
          gogAppPath,
          '--args',
          '--launchViaAutoStart',
          '--runWithoutUpdating',
        ]);
        expect(macGameSpawns).toHaveLength(1);
        expect(timeline.indexOf('client-spawn:/usr/bin/open')).toBeGreaterThanOrEqual(0);
        expect(timeline.indexOf('client-spawn:/usr/bin/open')).toBeLessThan(
          timeline.indexOf('game-spawn')
        );

        await launcherEngine.stopGame(
          { gameId: 'gog-1800001099' },
          {
            ...macBaseOpts,
            mockProcessListOutput: `4210 ${gogInnerBin}\n`,
            awaitPostSessionBarrier: true,
            awaitStorefrontPlaytimeSync: true,
          }
        );
        await launcherEngine.waitForActivePostSessionWork(5000);
        expect(
          macExecCalls.some(
            (c) => c.cmd === gogInnerBin && c.args.length === 1 && c.args[0] === '--command=shutdown'
          )
        ).toBe(true);

        // Manual-quit guard: user already quit GOG Galaxy mid-session -> alreadyClosed: true, reason: 'already_exited', 0 --command=shutdown calls
        resetMacTrackers();
        const manualQuitDirect = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'gog',
            wokeGogGalaxyByLauncher: true,
            gogGalaxyClientPath: gogAppPath,
            effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
          },
          {
            ...macBaseOpts,
            mockProcessListOutput: '',
          }
        );
        expect(manualQuitDirect).toMatchObject({
          closed: false,
          shutDown: false,
          alreadyClosed: true,
          reason: 'already_exited',
        });
        expect(macExecCalls.filter((c) => c.args.includes('--command=shutdown'))).toHaveLength(0);

        const resManualSession = await launcherEngine.launchGame(
          {
            gameId: 'gog-1800001099',
            title: 'Synthetic Native Mac GOG',
            platformId: 'gog',
            platformGameId: '1800001099',
            installPath: macInstallDir,
            executablePath: macExe,
            launchConfig: {
              launchMethod: 'direct',
              storefrontClientLifecycle: 'minimal_and_close_if_started',
            },
          },
          macBaseOpts
        );
        expect(resManualSession.success).toBe(true);
        macExecCalls.length = 0;
        await launcherEngine.stopGame(
          { gameId: 'gog-1800001099' },
          {
            ...macBaseOpts,
            mockProcessListOutput: '',
            awaitPostSessionBarrier: true,
            awaitStorefrontPlaytimeSync: true,
          }
        );
        await launcherEngine.waitForActivePostSessionWork(5000);
        expect(macExecCalls.filter((c) => c.args.includes('--command=shutdown'))).toHaveLength(0);

        // (b) direct + minimal_keep_running
        resetMacTrackers();
        const resB = await launcherEngine.launchGame(
          {
            gameId: 'gog-1800001098',
            title: 'Synthetic Native Mac GOG Keep',
            platformId: 'gog',
            platformGameId: '1800001098',
            installPath: macInstallDir,
            executablePath: macExe,
            launchConfig: {
              launchMethod: 'direct',
              storefrontClientLifecycle: 'minimal_keep_running',
            },
          },
          macBaseOpts
        );
        expect(resB.success).toBe(true);
        expect(macClientSpawns).toHaveLength(1);
        expect(macClientSpawns[0].args).toEqual([
          '-g',
          '-j',
          '-a',
          gogAppPath,
          '--args',
          '--launchViaAutoStart',
          '--runWithoutUpdating',
        ]);
        await launcherEngine.stopGame(
          { gameId: 'gog-1800001098' },
          {
            ...macBaseOpts,
            mockProcessListOutput: `4210 ${gogInnerBin}\n`,
            awaitPostSessionBarrier: true,
            awaitStorefrontPlaytimeSync: true,
          }
        );
        await launcherEngine.waitForActivePostSessionWork(5000);
        expect(macExecCalls.filter((c) => c.args.includes('--command=shutdown'))).toHaveLength(0);

        // (c) direct + fast_direct_bypass
        resetMacTrackers();
        const resC = await launcherEngine.launchGame(
          {
            gameId: 'gog-1800001097',
            title: 'Synthetic Native Mac GOG Fast',
            platformId: 'gog',
            platformGameId: '1800001097',
            installPath: macInstallDir,
            executablePath: macExe,
            launchConfig: {
              launchMethod: 'direct',
              storefrontClientLifecycle: 'fast_direct_bypass',
            },
          },
          macBaseOpts
        );
        expect(resC.success).toBe(true);
        expect(macClientSpawns).toHaveLength(0);
        expect(macGameSpawns).toHaveLength(1);
        await launcherEngine.stopGame({ gameId: 'gog-1800001097' }, macBaseOpts);
        await launcherEngine.waitForActivePostSessionWork(5000);

        // (d) storefront_uri + minimal_and_close_if_started on darwin
        resetMacTrackers();
        const resD = await launcherEngine.launchGame(
          {
            gameId: 'gog-1800001099',
            title: 'Synthetic Native Mac GOG URI',
            platformId: 'gog',
            platformGameId: '1800001099',
            installPath: macInstallDir,
            executablePath: macExe,
            launchConfig: {
              launchMethod: 'storefront_uri',
              storefrontClientLifecycle: 'minimal_and_close_if_started',
            },
          },
          { ...macBaseOpts, disableUriPolling: true }
        );
        expect(resD.success).toBe(true);
        expect(macClientSpawns).toHaveLength(1);
        expect(macClientSpawns[0].args).toEqual([
          '-g',
          '-j',
          '-a',
          gogAppPath,
          '--args',
          '--launchViaAutoStart',
          '--runWithoutUpdating',
        ]);
        expect(openedUris).toEqual(['goggalaxy://launchGame/gog_1800001099']);
        expect(timeline.indexOf('client-spawn:/usr/bin/open')).toBeGreaterThanOrEqual(0);
        expect(timeline.indexOf('client-spawn:/usr/bin/open')).toBeLessThan(
          timeline.indexOf('open-uri:goggalaxy://launchGame/gog_1800001099')
        );

        await launcherEngine.stopGame(
          { gameId: 'gog-1800001099' },
          {
            ...macBaseOpts,
            mockProcessListOutput: `4210 ${gogInnerBin}\n`,
            awaitPostSessionBarrier: true,
            awaitStorefrontPlaytimeSync: true,
          }
        );
        await launcherEngine.waitForActivePostSessionWork(5000);
        expect(
          macExecCalls.some(
            (c) => c.cmd === gogInnerBin && c.args.length === 1 && c.args[0] === '--command=shutdown'
          )
        ).toBe(true);
      } finally {
        unsubscribeSession();
      }

      // --- Part 2: Native Windows GOG (pure .exe without Galaxy*.dll, no gogGalaxyClientPath override) ---
      const winHome = trackTempDir('cell-1f-win-native-gog');
      const winUserData = path.join(winHome, 'userdata');
      const winInstallDir = path.join(winHome, 'Games', 'SyntheticNativeWinGog');
      const winExe = path.join(winInstallDir, 'SyntheticNativeWinGog.exe');
      fs.mkdirSync(winInstallDir, { recursive: true });
      fs.writeFileSync(winExe, 'MZ-SYNTHETIC-WIN-GAME');
      expect(launcherEngine.doesGogInstallUseGalaxySdk(winInstallDir, winExe)).toBe(false);

      const winGalaxyExe = path.join(winHome, 'Program Files', 'GOG Galaxy', 'GalaxyClient.exe');
      fs.mkdirSync(path.dirname(winGalaxyExe), { recursive: true });
      fs.writeFileSync(winGalaxyExe, 'MZ-GALAXY-CLIENT');

      const winTimeline: string[] = [];
      const winClientSpawns: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
      const winGameSpawns: Array<{ cmd: string; args: string[] }> = [];

      const winBaseOpts = {
        platform: 'win32',
        homedir: winHome,
        userDataDir: winUserData,
        allowGogWakeInTest: true,
        skipAuthRefresh: true,
        mockProcessListOutput: '',
        spawnFn: (cmd: string, args: string[], opts: Record<string, unknown> = {}) => {
          winClientSpawns.push({ cmd, args: Array.isArray(args) ? args : [], opts });
          winTimeline.push(`client-spawn:${args[0] || cmd}`);
          return createFakeChildProcess(83001);
        },
        gameSpawnFn: (cmd: string, args: string[]) => {
          winGameSpawns.push({ cmd, args: Array.isArray(args) ? args : [] });
          winTimeline.push('game-spawn');
          return createFakeChildProcess(83002);
        },
      };

      const winResMin = await launcherEngine.launchGame(
        {
          gameId: 'gog-1800001096',
          title: 'Synthetic Native Win GOG',
          platformId: 'gog',
          platformGameId: '1800001096',
          installPath: winInstallDir,
          executablePath: winExe,
          launchConfig: {
            launchMethod: 'direct',
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        winBaseOpts
      );
      expect(winResMin.success).toBe(true);
      expect(winClientSpawns).toHaveLength(1);
      expect(winClientSpawns[0].cmd).toBe(winGalaxyExe);
      expect(winClientSpawns[0].args).toEqual(['/launchViaAutoStart', '/runWithoutUpdating']);
      expect(winClientSpawns[0].opts.windowsHide).toBe(true);
      expect(winTimeline.indexOf('client-spawn:/launchViaAutoStart')).toBeLessThan(
        winTimeline.indexOf('game-spawn')
      );

      await launcherEngine.stopGame(
        { gameId: 'gog-1800001096' },
        {
          ...winBaseOpts,
          mockProcessListOutput: '"GalaxyClient.exe","3120","Console","1","92,000 K"\r\n',
          awaitPostSessionBarrier: true,
          awaitStorefrontPlaytimeSync: true,
        }
      );
      await launcherEngine.waitForActivePostSessionWork(5000);
      expect(
        winClientSpawns.some(
          (s) =>
            s.cmd === winGalaxyExe &&
            s.args.length === 1 &&
            s.args[0] === '/command=shutdown' &&
            s.opts.windowsHide === true
        )
      ).toBe(true);

      winClientSpawns.length = 0;
      winGameSpawns.length = 0;
      const winResFast = await launcherEngine.launchGame(
        {
          gameId: 'gog-1800001095',
          title: 'Synthetic Native Win GOG Fast',
          platformId: 'gog',
          platformGameId: '1800001095',
          installPath: winInstallDir,
          executablePath: winExe,
          launchConfig: {
            launchMethod: 'direct',
            storefrontClientLifecycle: 'fast_direct_bypass',
          },
        },
        winBaseOpts
      );
      expect(winResFast.success).toBe(true);
      expect(winClientSpawns).toHaveLength(0);
      expect(winGameSpawns).toHaveLength(1);
      await launcherEngine.stopGame({ gameId: 'gog-1800001095' }, winBaseOpts);
      await launcherEngine.waitForActivePostSessionWork(5000);
    });

    it('1G: wakes Bottle GOG Galaxy by default without Galaxy*.dll, discovers 64-bit GOG Galaxy 2.1.10+ & Inno Setup registry paths, and evicts cross-bottle port 9977 collisions on macOS', async () => {
      // --- 1. Non-DLL Bottled GOG Default Wake (no strictGalaxySdkCheck override) ---
      const tmpHome = trackTempDir('cell-1g-bottle-reg-port9977');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const appsDir = path.join(tmpHome, 'CustomApps');
      const fakeCxBinDir = path.join(
        appsDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'bin'
      );
      fs.mkdirSync(fakeCxBinDir, { recursive: true });
      const fakeWineBin = path.join(fakeCxBinDir, 'wine');
      const fakeWineserverBin = path.join(fakeCxBinDir, 'wineserver');
      fs.writeFileSync(fakeWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(fakeWineserverBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const launchBottle = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      fs.mkdirSync(path.join(launchBottle, 'drive_c'), { recursive: true });
      fs.writeFileSync(path.join(launchBottle, 'cxbottle.conf'), '[Bottle]\n', 'utf8');
      fs.writeFileSync(path.join(launchBottle, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
      fs.writeFileSync(path.join(launchBottle, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

      const bottleGogExe = path.join(
        launchBottle,
        'drive_c',
        'Program Files (x86)',
        'GOG Galaxy',
        'GalaxyClient.exe'
      );
      fs.mkdirSync(path.dirname(bottleGogExe), { recursive: true });
      fs.writeFileSync(bottleGogExe, 'MZ-BOTTLE-GOG');

      const nonDllBottleGameDir = path.join(
        launchBottle,
        'drive_c',
        'GOG Games',
        'SyntheticNonDllBottleGog'
      );
      const nonDllBottleGameExe = path.join(nonDllBottleGameDir, 'SyntheticNonDllBottleGog.exe');
      fs.mkdirSync(nonDllBottleGameDir, { recursive: true });
      fs.writeFileSync(nonDllBottleGameExe, 'MZ-NON-DLL-GAME');
      expect(
        launcherEngine.doesGogInstallUseGalaxySdk(nonDllBottleGameDir, nonDllBottleGameExe)
      ).toBe(false);

      const bottleClientSpawns: Array<{ cmd: string; args: string[] }> = [];
      const bottleExecCalls: Array<{ cmd: string; args: string[] }> = [];
      const bottleOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        customApplicationsDir: appsDir,
        skipAuthRefresh: true,
        mockProcessListOutput: '',
        bottleClientSpawnFn: (cmd: string, args: string[]) => {
          bottleClientSpawns.push({ cmd, args: Array.isArray(args) ? args : [] });
          return createFakeChildProcess(84001);
        },
        gameSpawnFn: () => createFakeChildProcess(84002),
        execFileImpl: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout?: string) => void
        ) => {
          bottleExecCalls.push({ cmd, args: Array.isArray(args) ? args : [] });
          if (typeof _opts === 'function') (_opts as (err: Error | null, stdout: string) => void)(null, '');
          else if (typeof cb === 'function') cb(null, '');
        },
      };

      const defaultBottleWakeRes = await launcherEngine.launchGame(
        {
          gameId: 'gog-1800001094',
          title: 'Synthetic Non-DLL Bottle GOG',
          platformId: 'gog',
          platformGameId: '1800001094',
          installPath: nonDllBottleGameDir,
          executablePath: nonDllBottleGameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            crossoverBottle: 'OneLauncher',
            winePrefix: launchBottle,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
        },
        bottleOpts
      );
      expect(defaultBottleWakeRes.success).toBe(true);
      expect(bottleClientSpawns).toHaveLength(1);
      expect(bottleClientSpawns[0].args).toEqual([
        bottleGogExe,
        '/launchViaAutoStart',
        '/runWithoutUpdating',
      ]);
      await launcherEngine.stopGame(
        { gameId: 'gog-1800001094' },
        { ...bottleOpts, awaitPostSessionBarrier: true }
      );
      await launcherEngine.waitForActivePostSessionWork(5000);
      expect(
        bottleExecCalls.some(
          (c) => c.args[0] === bottleGogExe && c.args[1] === '/command=shutdown'
        )
      ).toBe(true);

      bottleClientSpawns.length = 0;
      const fastBottleBypassRes = await launcherEngine.launchGame(
        {
          gameId: 'gog-1800001093',
          title: 'Synthetic Non-DLL Bottle GOG Fast',
          platformId: 'gog',
          platformGameId: '1800001093',
          installPath: nonDllBottleGameDir,
          executablePath: nonDllBottleGameExe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            crossoverBottle: 'OneLauncher',
            winePrefix: launchBottle,
            storefrontClientLifecycle: 'fast_direct_bypass',
          },
        },
        bottleOpts
      );
      expect(fastBottleBypassRes.success).toBe(true);
      expect(bottleClientSpawns).toHaveLength(0);
      await launcherEngine.stopGame({ gameId: 'gog-1800001093' }, bottleOpts);
      await launcherEngine.waitForActivePostSessionWork(5000);

      // --- 2. Windows 64-Bit GOG Galaxy 2.1.10+ Registry Discovery & Inno Setup Fallback ---
      const reg64Result = windowsRegistryDiscovery.discoverWindowsGogGalaxyRegistryPaths({
        platform: 'win32',
        execFileSyncFn: (_bin: string, regArgs: string[]) => {
          const keyPath = regArgs[1] || '';
          const valName = regArgs[3] || '';
          if (keyPath === 'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient\\paths' && valName === 'client') {
            return '\r\n    client    REG_SZ    D:\\Clients\\GOG Galaxy\r\n';
          }
          if (
            keyPath === 'HKLM\\SOFTWARE\\GOG.com\\GalaxyClient' &&
            valName === 'clientExecutable'
          ) {
            return '\r\n    clientExecutable    REG_SZ    GalaxyClient.exe\r\n';
          }
          throw new Error('Registry key not found');
        },
      });
      expect(reg64Result).toEqual({
        clientDir: 'D:\\Clients\\GOG Galaxy',
        clientExe: 'D:\\Clients\\GOG Galaxy\\GalaxyClient.exe',
      });

      const innoFallbackResult = windowsRegistryDiscovery.discoverWindowsGogGalaxyRegistryPaths({
        platform: 'win32',
        execFileSyncFn: (_bin: string, regArgs: string[]) => {
          const keyPath = regArgs[1] || '';
          const valName = regArgs[3] || '';
          if (
            keyPath ===
              'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7258BA11-600C-430E-A759-27E2C691A335}_is1' &&
            valName === 'InstallLocation'
          ) {
            return '\r\n    InstallLocation    REG_SZ    E:\\GOG Galaxy\\\r\n';
          }
          throw new Error('Registry key not found');
        },
      });
      expect(innoFallbackResult).toEqual({
        clientDir: 'E:\\GOG Galaxy',
        clientExe: 'E:\\GOG Galaxy\\GalaxyClient.exe',
      });

      // --- 3. macOS Port 9977 Cross-Bottle Eviction ---
      const gogAppPath = path.join(tmpHome, 'Applications', 'GOG Galaxy.app');
      const gogInnerBin = path.join(gogAppPath, 'Contents', 'MacOS', 'GOG Galaxy');
      fs.mkdirSync(path.dirname(gogInnerBin), { recursive: true });
      fs.writeFileSync(gogInnerBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const evictionEvents: string[] = [];
      let port9977ProbeCount = 0;
      const evictExecCalls: Array<{ cmd: string; args: string[] }> = [];
      const evictSpawns: Array<{ cmd: string; args: string[] }> = [];

      const evictWakeRes = await launcherEngine.ensureGogGalaxyBackgroundService({
        platform: 'darwin',
        homedir: tmpHome,
        allowGogWakeInTest: true,
        enableGogPortEviction: true,
        storefrontClientLifecycle: 'minimal_and_close_if_started',
        mockProcessListOutput: '',
        probeTcpPortFn: async (port: number, host: string) => {
          expect(port).toBe(9977);
          expect(host).toBe('127.0.0.1');
          port9977ProbeCount += 1;
          const busy = port9977ProbeCount <= 2;
          evictionEvents.push(`probe:${port9977ProbeCount}:${busy ? 'busy' : 'free'}`);
          return busy;
        },
        execFileImpl: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: Error | null, stdout?: string) => void
        ) => {
          evictExecCalls.push({ cmd, args: Array.isArray(args) ? args : [] });
          evictionEvents.push(`pkill:${cmd}`);
          if (typeof _opts === 'function') (_opts as (err: Error | null, stdout: string) => void)(null, '');
          else if (typeof cb === 'function') cb(null, '');
        },
        spawnFn: (cmd: string, args: string[]) => {
          evictSpawns.push({ cmd, args: Array.isArray(args) ? args : [] });
          evictionEvents.push(`spawn:${cmd}`);
          return createFakeChildProcess(85001);
        },
      });

      expect(evictWakeRes.started).toBe(true);
      expect(evictWakeRes.clientPath).toBe(gogAppPath);
      expect(evictExecCalls).toEqual([
        {
          cmd: '/usr/bin/pkill',
          args: ['-TERM', '-f', 'GalaxyCommunication\\.exe|GalaxyClient\\.exe|GalaxyCommunication'],
        },
      ]);
      expect(evictSpawns).toEqual([
        {
          cmd: '/usr/bin/open',
          args: [
            '-g',
            '-j',
            '-a',
            gogAppPath,
            '--args',
            '--launchViaAutoStart',
            '--runWithoutUpdating',
          ],
        },
      ]);
      expect(evictionEvents).toEqual([
        'probe:1:busy',
        'pkill:/usr/bin/pkill',
        'probe:2:busy',
        'probe:3:free',
        'spawn:/usr/bin/open',
      ]);
    });
  });

  // ============================================================================
  // TASK 2: 3×3 Bidirectional First-Party Launcher Registration & Unregistration
  // ============================================================================
  describe('Task 2 — 3×3 Bidirectional First-Party Launcher Registration & Unregistration', () => {
    it('2A (macOS Native GOG): preserves sealed .app bundle integrity, writes outer Contents/Resources .info, preserves 64-bit BigInt buildId, updates PlayTaskLaunchParameters, and unregisters cleanly', () => {
      const tmpHome = trackTempDir('cell-2a-mac-gog');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const installPath = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'SyntheticStar');
      const innerApp = path.join(installPath, 'SyntheticStar.app');
      const innerBin = path.join(innerApp, 'Contents', 'MacOS', 'SyntheticStar');
      const codeSigDir = path.join(innerApp, 'Contents', '_CodeSignature');
      fs.mkdirSync(path.dirname(innerBin), { recursive: true });
      fs.mkdirSync(codeSigDir, { recursive: true });
      fs.writeFileSync(innerBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(innerApp, 'Contents', 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>SyntheticStar</string></dict></plist>',
        'utf8'
      );
      fs.writeFileSync(path.join(codeSigDir, 'CodeResources'), '<plist/>', 'utf8');

      // Snapshot inner .app file tree before sync to verify zero files are written/modified inside .app
      const listTree = (dir: string, prefix = ''): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          return ent.isDirectory() ? [rel, ...listTree(path.join(dir, ent.name), rel)] : [rel];
        });
      const beforeAppTree = listTree(innerApp).sort();

      const gogDbPath = path.join(tmpHome, 'GalaxyStorage', 'galaxy-2.0.db');
      const gogConfigPath = path.join(tmpHome, 'GalaxyStorage', 'config.json');
      fs.mkdirSync(path.dirname(gogDbPath), { recursive: true });

      const cleanId = '1800001001';
      const bigBuildIdStr = '59123456789012345'; // > Number.MAX_SAFE_INTEGER (9007199254740991)

      // Seed Builds manifest with 64-bit build_id and a stale PlayTaskLaunchParameters row
      const seedDb = new DatabaseSync(gogDbPath, { readBigInts: true });
      seedDb.exec(`
        CREATE TABLE Builds (productId INTEGER PRIMARY KEY, manifest TEXT);
        CREATE TABLE PlayTasks (id INTEGER PRIMARY KEY, gameReleaseKey TEXT, userId INTEGER, "order" INTEGER, typeId INTEGER, isPrimary INTEGER);
        CREATE TABLE PlayTaskLaunchParameters (playTaskId INTEGER PRIMARY KEY, executablePath TEXT, commandLineArgs TEXT, label TEXT);
      `);
      seedDb
        .prepare('INSERT INTO Builds (productId, manifest) VALUES (?, ?)')
        .run(
          BigInt(cleanId),
          JSON.stringify({
            items: [
              {
                generation: 2,
                build_id: bigBuildIdStr,
                clientId: '56789012345678901',
              },
            ],
          })
        );
      seedDb
        .prepare(
          'INSERT INTO PlayTasks (id, gameReleaseKey, userId, "order", typeId, isPrimary) VALUES (42, ?, NULL, 0, 1, 1)'
        )
        .run(`gog_${cleanId}`);
      seedDb
        .prepare(
          'INSERT INTO PlayTaskLaunchParameters (playTaskId, executablePath, commandLineArgs, label) VALUES (42, ?, ?, ?)'
        )
        .run('/Stale/OldLocation/SyntheticStar.app/Contents/MacOS/SyntheticStar', '', 'Stale');
      seedDb.close();

      const syncOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        gogGalaxyDbPath: gogDbPath,
        gogGalaxyConfigPath: gogConfigPath,
      };

      const syncRes = launcherEngine.syncGogFirstPartyLauncher(
        {
          platformId: 'gog',
          platformGameId: cleanId,
          title: 'Synthetic Star',
          installPath,
          executablePath: innerBin,
          isWindowsBinaryOnMac: false,
        },
        syncOpts
      );
      expect(syncRes.synced).toBe(true);

      // 1. Sealed inner .app bundle was NEVER modified (zero inner .info files added)
      expect(listTree(innerApp).sort()).toEqual(beforeAppTree);

      // 2. Outer <installPath>/Contents/Resources/{goggame-<id>.info, .goggame-<id>.info} written cleanly
      const outerInfoPath = path.join(installPath, 'Contents', 'Resources', `goggame-${cleanId}.info`);
      const outerDotInfoPath = path.join(installPath, 'Contents', 'Resources', `.goggame-${cleanId}.info`);
      expect(fs.existsSync(outerInfoPath)).toBe(true);
      expect(fs.existsSync(outerDotInfoPath)).toBe(true);
      const parsedInfo = JSON.parse(fs.readFileSync(outerInfoPath, 'utf8'));
      expect(parsedInfo.clientId).toBe('56789012345678901');
      expect(parsedInfo.playTasks[0].path).toBe('SyntheticStar.app/Contents/MacOS/SyntheticStar');

      // 3. SQLite verification: installationPath === installPath, 64-bit BigInt buildId, ProductsToReleaseKeys, updated PlayTaskLaunchParameters
      const verifyDb = new DatabaseSync(gogDbPath, { readBigInts: true });
      const ibp = verifyDb
        .prepare('SELECT installationPath, buildId FROM InstalledBaseProducts WHERE productId = ?')
        .get(BigInt(cleanId)) as { installationPath: string; buildId: bigint };
      expect(ibp.installationPath).toBe(installPath);
      expect(ibp.buildId).toBe(BigInt(bigBuildIdStr));

      const ptrk = verifyDb
        .prepare('SELECT gogId, releaseKey FROM ProductsToReleaseKeys WHERE releaseKey = ?')
        .get(`gog_${cleanId}`) as { gogId: bigint; releaseKey: string };
      expect(ptrk).toEqual({ gogId: BigInt(cleanId), releaseKey: `gog_${cleanId}` });

      const ptlp = verifyDb
        .prepare('SELECT executablePath FROM PlayTaskLaunchParameters WHERE playTaskId = 42')
        .get() as { executablePath: string };
      expect(ptlp.executablePath).toBe(innerBin);
      verifyDb.close();

      // 4. Unregistration deletes all rows cleanly
      const unregRes = launcherEngine.unregisterGogFirstPartyLauncher(cleanId, installPath, syncOpts);
      expect(unregRes.removed).toBe(true);

      const postDb = new DatabaseSync(gogDbPath, { readBigInts: true });
      expect(
        postDb.prepare('SELECT * FROM InstalledBaseProducts WHERE productId = ?').get(BigInt(cleanId))
      ).toBeUndefined();
      expect(
        postDb.prepare('SELECT * FROM ProductsToReleaseKeys WHERE releaseKey = ?').get(`gog_${cleanId}`)
      ).toBeUndefined();
      expect(
        postDb.prepare('SELECT * FROM PlayTasks WHERE gameReleaseKey = ?').get(`gog_${cleanId}`)
      ).toBeUndefined();
      postDb.close();
    });

    it('2B & 2C (macOS Bottled GOG & Windows Native GOG): routes Cell 2B to CrossOver bottle Z:\\ paths + system.reg while pruning stale host macOS DB rows, and syncs/unregisters Cell 2C on win32', () => {
      const tmpHome = trackTempDir('cell-2b-2c-gog');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const bottlePath = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      const bottleGalaxyDir = path.join(bottlePath, 'drive_c', 'ProgramData', 'GOG.com', 'Galaxy');
      const bottleDbPath = path.join(bottleGalaxyDir, 'storage', 'galaxy-2.0.db');
      const bottleCfgPath = path.join(bottleGalaxyDir, 'config.json');
      const bottleSysReg = path.join(bottlePath, 'system.reg');
      fs.mkdirSync(path.dirname(bottleDbPath), { recursive: true });
      fs.writeFileSync(bottleSysReg, 'WINE REGISTRY Version 2\n\n', 'utf8');
      const initBottleDb = new DatabaseSync(bottleDbPath);
      initBottleDb.exec('CREATE TABLE IF NOT EXISTS Products (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER);');
      initBottleDb.close();

      // External macOS folder containing Windows .exe (outside drive_c -> maps to Z:\...)
      const winOnMacInstall = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'SyntheticWinPort');
      const winOnMacExe = path.join(winOnMacInstall, 'Bin', 'SyntheticWinPort.exe');
      fs.mkdirSync(path.dirname(winOnMacExe), { recursive: true });
      fs.writeFileSync(winOnMacExe, 'MZ-WIN-EXE');

      // Seed host macOS galaxy-2.0.db with a stale row pointing at winOnMacInstall that MUST be pruned during Cell 2B sync
      const hostMacDbPath = path.join(tmpHome, 'HostMacGalaxy', 'galaxy-2.0.db');
      fs.mkdirSync(path.dirname(hostMacDbPath), { recursive: true });
      const seedHostDb = new DatabaseSync(hostMacDbPath);
      seedHostDb.exec(`
        CREATE TABLE InstalledProducts (productId INTEGER PRIMARY KEY);
        CREATE TABLE InstalledBaseProducts (productId INTEGER PRIMARY KEY, installationPath TEXT);
        CREATE TABLE PlayTasks (id INTEGER PRIMARY KEY, gameReleaseKey TEXT);
        CREATE TABLE PlayTaskLaunchParameters (playTaskId INTEGER PRIMARY KEY, executablePath TEXT);
      `);
      seedHostDb.prepare('INSERT INTO InstalledProducts (productId) VALUES (1800001002)').run();
      seedHostDb
        .prepare('INSERT INTO InstalledBaseProducts (productId, installationPath) VALUES (1800001002, ?)')
        .run(winOnMacInstall);
      seedHostDb.close();

      const cell2bOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        bottlePath,
        routeWindowsGogToBottle: true,
        hostMacGogDbPath: hostMacDbPath,
        gogGalaxyDbPath: hostMacDbPath,
      };

      const sync2b = launcherEngine.syncGogFirstPartyLauncher(
        {
          platformId: 'gog',
          platformGameId: '1800001002',
          title: 'Synthetic Win Port',
          installPath: winOnMacInstall,
          executablePath: winOnMacExe,
          isWindowsBinaryOnMac: true,
        },
        cell2bOpts
      );
      expect(sync2b.synced).toBe(true);

      // Depth-0 .info has backslash relative path
      const info2b = JSON.parse(
        fs.readFileSync(path.join(winOnMacInstall, 'goggame-1800001002.info'), 'utf8')
      );
      expect(info2b.playTasks[0].path).toBe('Bin\\SyntheticWinPort.exe');

      // Bottle config.json, bottle galaxy-2.0.db, and system.reg all hold Z:\... Windows paths
      const expectedWineInstall = firstPartyReg.toWineWindowsPath(winOnMacInstall, bottlePath);
      expect(expectedWineInstall.startsWith('Z:\\')).toBe(true);
      const bottleCfg = JSON.parse(fs.readFileSync(bottleCfgPath, 'utf8'));
      expect(bottleCfg.libraryPath || JSON.stringify(bottleCfg)).toContain('Z:\\');

      const checkBottleDb = new DatabaseSync(bottleDbPath, { readBigInts: true });
      const bRow = checkBottleDb
        .prepare('SELECT installationPath FROM InstalledBaseProducts WHERE productId = 1800001002')
        .get() as { installationPath: string };
      expect(bRow.installationPath).toBe(expectedWineInstall);
      checkBottleDb.close();

      const regTextAfterSync = fs.readFileSync(bottleSysReg, 'utf8');
      expect(regTextAfterSync).toContain('[Software\\\\Wow6432Node\\\\GOG.com\\\\Games\\\\1800001002]');

      // Host macOS galaxy-2.0.db had its stale 1800001002 row pruned!
      const checkHostDb = new DatabaseSync(hostMacDbPath);
      expect(
        checkHostDb.prepare('SELECT * FROM InstalledProducts WHERE productId = 1800001002').get()
      ).toBeUndefined();
      checkHostDb.close();

      // Unregister Cell 2B -> cleans bottle galaxy-2.0.db AND system.reg
      launcherEngine.unregisterGogFirstPartyLauncher('1800001002', winOnMacInstall, cell2bOpts);
      const postBottleDb = new DatabaseSync(bottleDbPath);
      expect(
        postBottleDb.prepare('SELECT * FROM InstalledBaseProducts WHERE productId = 1800001002').get()
      ).toBeUndefined();
      postBottleDb.close();
      expect(fs.readFileSync(bottleSysReg, 'utf8')).not.toContain(
        '[Software\\\\Wow6432Node\\\\GOG.com\\\\Games\\\\1800001002]'
      );

      // Cell 2C: Windows Native GOG (platform: 'win32')
      const winHostDb = path.join(tmpHome, 'WinProgramData', 'Galaxy', 'storage', 'galaxy-2.0.db');
      const winHostCfg = path.join(tmpHome, 'WinProgramData', 'Galaxy', 'config.json');
      const regCommands: string[][] = [];
      const winOpts = {
        platform: 'win32',
        userDataDir: tmpUserData,
        gogGalaxyDbPath: winHostDb,
        gogGalaxyConfigPath: winHostCfg,
        execFileSyncFn: (_cmd: string, args: string[]) => {
          regCommands.push(args);
          return '';
        },
      };
      const sync2c = launcherEngine.syncGogFirstPartyLauncher(
        {
          platformId: 'gog',
          platformGameId: '1800001002',
          title: 'Synthetic Win Native',
          installPath: winOnMacInstall,
          executablePath: winOnMacExe,
        },
        winOpts
      );
      expect(sync2c.synced).toBe(true);
      expect(regCommands.some((a) => a[0] === 'add' && a[1].includes('1800001002'))).toBe(true);

      launcherEngine.unregisterGogFirstPartyLauncher('1800001002', winOnMacInstall, winOpts);
      expect(regCommands.some((a) => a[0] === 'delete' && a[1].includes('1800001002'))).toBe(true);
    });

    it('3A (macOS Native Epic): prefers _Mac_ manifest over _Windows_, sets LaunchExecutable to SampleGame.app with empty MainGameAppName, and uninstalls cleanly when platformGameId === catalogItemId !== appName', async () => {
      const tmpHome = trackTempDir('cell-3a-mac-epic');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const legDir = path.join(tmpUserData, 'legendaryConfig', 'legendary');
      const legMetaDir = path.join(legDir, 'metadata');
      const legManifestsDir = path.join(legDir, 'manifests');
      const eglManifestsDir = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'Epic',
        'EpicGamesLauncher',
        'Data',
        'Manifests'
      );
      const eglDatPath = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'Epic',
        'UnrealEngineLauncher',
        'LauncherInstalled.dat'
      );
      fs.mkdirSync(legMetaDir, { recursive: true });
      fs.mkdirSync(legManifestsDir, { recursive: true });
      fs.mkdirSync(eglManifestsDir, { recursive: true });

      const appName = 'SyntheticOrionApp';
      const catalogItemId = 'a1b2c3d4e5f64789a1b2c3d4e5f64789';
      const catalogNamespace = 'ns_synthetic_orion';
      const guid = '11223344556647898899AABBCCDDEEFF';
      const installPath = path.join(tmpHome, 'Games', 'OneLauncher', 'Epic', 'SampleGame');
      const appBin = path.join(installPath, 'SampleGame.app', 'Contents', 'MacOS', 'SampleGame');
      fs.mkdirSync(path.dirname(appBin), { recursive: true });
      fs.writeFileSync(appBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // Seed both _Mac_ and _Windows_ manifests (with _Windows_ given a newer mtime to prove OS preference wins)
      const macMf = path.join(legManifestsDir, `${appName}_Mac_1.2.manifest`);
      const winMf = path.join(legManifestsDir, `${appName}_Windows_1.2.manifest`);
      fs.writeFileSync(macMf, 'MAC_BINARY_MANIFEST_CONTENT', 'utf8');
      fs.writeFileSync(winMf, 'WIN_BINARY_MANIFEST_CONTENT', 'utf8');
      const nowSec = Date.now() / 1000;
      fs.utimesSync(macMf, nowSec - 60, nowSec - 60);
      fs.utimesSync(winMf, nowSec, nowSec);

      fs.writeFileSync(
        path.join(legMetaDir, `${appName}.json`),
        JSON.stringify({
          app_name: appName,
          app_title: 'Sample Game',
          asset_infos: {
            Mac: {
              app_name: appName,
              catalog_item_id: catalogItemId,
              namespace: catalogNamespace,
              build_version: '1.2.0-mac',
            },
          },
          metadata: {
            id: catalogItemId,
            namespace: catalogNamespace,
          },
        }),
        'utf8'
      );

      const legInstalledPath = path.join(legDir, 'installed.json');
      fs.writeFileSync(
        legInstalledPath,
        JSON.stringify({
          [appName]: {
            app_name: appName,
            title: 'Sample Game',
            install_path: installPath,
            executable: 'SampleGame.app/Contents/MacOS/SampleGame',
            platform: 'Mac',
            version: '1.2.0-mac',
            install_size: 2048000,
            egl_guid: guid,
          },
        }),
        'utf8'
      );

      const epicOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        eglManifestsDir,
        eglLauncherInstalledPath: eglDatPath,
      };

      const syncRes = launcherEngine.syncEpicFirstPartyLauncher(epicOpts);
      expect(syncRes.synced).toBe(1);

      // Verify .egstore/<GUID>.mancpn & _Mac_ .manifest
      expect(fs.existsSync(path.join(installPath, '.egstore', `${guid}.mancpn`))).toBe(true);
      expect(
        fs.readFileSync(path.join(installPath, '.egstore', `${guid}.manifest`), 'utf8')
      ).toBe('MAC_BINARY_MANIFEST_CONTENT');

      // Verify <GUID>.item has LaunchExecutable: "SampleGame.app" and MainGameAppName: ""
      const itemPath = path.join(eglManifestsDir, `${guid}.item`);
      expect(fs.existsSync(itemPath)).toBe(true);
      const parsedItem = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
      expect(parsedItem.LaunchExecutable).toBe('SampleGame.app');
      expect(parsedItem.MainGameAppName).toBe('');
      expect(parsedItem.CatalogItemId).toBe(catalogItemId);

      const datBefore = JSON.parse(fs.readFileSync(eglDatPath, 'utf8'));
      expect(datBefore.InstallationList.some((e: { AppName: string }) => e.AppName === appName)).toBe(true);

      // Uninstall using platformGameId = catalogItemId (!== appName) -> cleans installed.json, .item, and LauncherInstalled.dat
      const uninstRes = await launcherEngine.uninstallGame(
        {
          gameId: `epic-${catalogItemId}`,
          platformId: 'epic',
          platformGameId: catalogItemId,
          installPath,
          deleteFiles: true,
        },
        epicOpts
      );
      expect(uninstRes.success).toBe(true);
      const legAfter = JSON.parse(fs.readFileSync(legInstalledPath, 'utf8'));
      expect(legAfter[appName]).toBeUndefined();
      expect(fs.existsSync(itemPath)).toBe(false);
      const datAfter = JSON.parse(fs.readFileSync(eglDatPath, 'utf8'));
      expect(datAfter.InstallationList.some((e: { AppName: string }) => e.AppName === appName)).toBe(false);
    });

    it('3B & 3C (macOS Bottled Epic & Windows Native Epic) + 4A/4B/4C (Steam): writes EOSH .egi + 18-digit BigInt .NET ticks in Revision.json, prunes stale host Mac .item, and discovers custom-drive Windows Steam via steamRoot/steamPath', () => {
      const tmpHome = trackTempDir('cell-3b-3c-4abc');
      const tmpUserData = path.join(tmpHome, 'userdata');
      const legMetaDir = path.join(tmpUserData, 'legendaryConfig', 'legendary', 'metadata');
      fs.mkdirSync(legMetaDir, { recursive: true });

      const appName = 'SyntheticWinEpicApp';
      const catalogItemId = 'f0e1d2c3b4a5498790123456789abcde';
      const guid = 'AABBCCDDEEFF4012890123456789ABCD';
      fs.writeFileSync(
        path.join(legMetaDir, `${appName}.json`),
        JSON.stringify({
          app_name: appName,
          app_title: 'Synthetic Win Epic',
          asset_infos: {
            Windows: {
              app_name: appName,
              catalog_item_id: catalogItemId,
              namespace: 'ns_win_epic',
              build_version: '2.0.1-win',
            },
          },
        }),
        'utf8'
      );

      // Initialize CrossOver bottle with EOSH InstalledItems directory AND a stale host Mac .item
      const bottlePath = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      const bottleProgramDataEpic = path.join(bottlePath, 'drive_c', 'ProgramData', 'Epic');
      const bottleEoshItemsDir = path.join(
        bottleProgramDataEpic,
        'EpicOnlineServices',
        'InstallHelper',
        'InstalledItems'
      );
      fs.mkdirSync(bottleEoshItemsDir, { recursive: true });

      const hostMacManifestsDir = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'Epic',
        'EpicGamesLauncher',
        'Data',
        'Manifests'
      );
      const hostMacDatPath = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'Epic',
        'UnrealEngineLauncher',
        'LauncherInstalled.dat'
      );
      fs.mkdirSync(hostMacManifestsDir, { recursive: true });
      const staleHostItem = path.join(hostMacManifestsDir, `${guid}.item`);
      fs.writeFileSync(
        staleHostItem,
        JSON.stringify({ AppName: appName, CatalogItemId: catalogItemId, InstallLocation: '/Stale' }),
        'utf8'
      );

      const winEpicInstall = path.join(tmpHome, 'Games', 'OneLauncher', 'Epic', 'SyntheticWinEpic');
      const winEpicExe = path.join(winEpicInstall, 'Binaries', 'Win64', 'SyntheticWinEpic.exe');
      fs.mkdirSync(path.dirname(winEpicExe), { recursive: true });
      fs.writeFileSync(winEpicExe, 'MZ-EPIC-WIN');

      const cell3bOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        bottlePath,
        routeWindowsEpicToBottle: true,
        eglManifestsDir: hostMacManifestsDir,
        eglLauncherInstalledPath: hostMacDatPath,
      };

      const legInstalledFile = path.join(
        tmpUserData,
        'legendaryConfig',
        'legendary',
        'installed.json'
      );
      fs.writeFileSync(
        legInstalledFile,
        JSON.stringify({
          [appName]: {
            app_name: appName,
            title: 'Synthetic Win Epic',
            install_path: winEpicInstall,
            executable: 'Binaries\\Win64\\SyntheticWinEpic.exe',
            platform: 'Windows',
            version: '2.0.1-win',
            install_size: 4096000,
            egl_guid: guid,
          },
        }),
        'utf8'
      );

      const sync3b = launcherEngine.syncEpicFirstPartyLauncher(cell3bOpts);
      expect(sync3b.synced).toBe(1);

      // Stale host Mac .item pruned; bottle .item + LauncherInstalled.dat + EOSH .egi + Revision.json written
      expect(fs.existsSync(staleHostItem)).toBe(false);
      const bottleItemPath = path.join(
        bottleProgramDataEpic,
        'EpicGamesLauncher',
        'Data',
        'Manifests',
        `${guid}.item`
      );
      expect(fs.existsSync(bottleItemPath)).toBe(true);
      const bottleItem = JSON.parse(fs.readFileSync(bottleItemPath, 'utf8'));
      expect(bottleItem.InstallLocation.startsWith('Z:\\')).toBe(true);

      const egiPath = path.join(bottleEoshItemsDir, `${guid.toLowerCase()}.egi`);
      const revPath = path.join(bottleEoshItemsDir, 'Revision.json');
      expect(fs.existsSync(egiPath)).toBe(true);
      const parsedEgi = JSON.parse(fs.readFileSync(egiPath, 'utf8'));
      expect(parsedEgi.version).toBe(4);
      expect(parsedEgi.state).toBe('Installed');

      const rawRevBefore = fs.readFileSync(revPath, 'utf8');
      expect(rawRevBefore).toMatch(/"timestamp":\s*\d{18}/);
      const revNumBefore = JSON.parse(rawRevBefore).number as number;

      // Unregister Cell 3B -> deletes .egi and bumps Revision.json number
      launcherEngine.unregisterEpicFirstPartyLauncher(appName, winEpicInstall, {
        ...cell3bOpts,
        bottlePaths: [bottlePath],
      });
      expect(fs.existsSync(egiPath)).toBe(false);
      const rawRevAfter = fs.readFileSync(revPath, 'utf8');
      expect(rawRevAfter).toMatch(/"timestamp":\s*\d{18}/);
      expect(JSON.parse(rawRevAfter).number).toBeGreaterThan(revNumBefore);

      // Cell 3C: Windows Native Epic (platform: 'win32') + EOSH .egi
      const winProgramDataEpic = path.join(tmpHome, 'WinProgramDataEpic');
      const winManifestsDir = path.join(winProgramDataEpic, 'EpicGamesLauncher', 'Data', 'Manifests');
      const winDatPath = path.join(winProgramDataEpic, 'UnrealEngineLauncher', 'LauncherInstalled.dat');
      const winEoshItems = path.join(
        winProgramDataEpic,
        'EpicOnlineServices',
        'InstallHelper',
        'InstalledItems'
      );
      fs.mkdirSync(winEoshItems, { recursive: true });
      const win3cOpts = {
        platform: 'win32',
        homedir: tmpHome,
        userDataDir: tmpUserData,
        eglManifestsDir: winManifestsDir,
        eglLauncherInstalledPath: winDatPath,
        programDataEpicDir: winProgramDataEpic,
      };
      expect(launcherEngine.syncEpicFirstPartyLauncher(win3cOpts).synced).toBe(1);
      expect(fs.existsSync(path.join(winEoshItems, `${guid.toLowerCase()}.egi`))).toBe(true);
      launcherEngine.unregisterEpicFirstPartyLauncher(appName, winEpicInstall, win3cOpts);
      expect(fs.existsSync(path.join(winEoshItems, `${guid.toLowerCase()}.egi`))).toBe(false);

      // Cells 4A, 4B & 4C (Steam host macOS + CrossOver bottle + Windows custom-drive registry)
      const macSteamapps = path.join(tmpHome, 'Library', 'Application Support', 'Steam', 'steamapps');
      const bottleSteamapps = path.join(
        bottlePath,
        'drive_c',
        'Program Files (x86)',
        'Steam',
        'steamapps'
      );
      fs.mkdirSync(macSteamapps, { recursive: true });
      fs.mkdirSync(bottleSteamapps, { recursive: true });
      const macSteamLocs = launcherEngine.discoverSteamLocations({
        platform: 'darwin',
        homedir: tmpHome,
      });
      expect(macSteamLocs.steamappsDirs).toContain(macSteamapps);
      expect(macSteamLocs.steamappsDirs).toContain(bottleSteamapps);

      // Cell 4C: discoverWindowsSteamRegistryPaths returns BOTH steamRoot AND steamPath
      const regResLiteral = windowsRegistryDiscovery.discoverWindowsSteamRegistryPaths({
        platform: 'win32',
        execFileSyncFn: () =>
          'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    D:/Steam\r\n    SteamExe    REG_SZ    D:/Steam/steam.exe\r\n',
      });
      expect(regResLiteral.steamRoot).toBe('D:\\Steam');
      expect(regResLiteral.steamPath).toBe('D:\\Steam');

      // Verify end-to-end discoverSteamLocations on win32 picks up custom-drive Steam root from registry
      const customDriveSteamRoot = path.join(tmpHome, 'CustomDriveD', 'Steam');
      fs.mkdirSync(path.join(customDriveSteamRoot, 'steamapps'), { recursive: true });
      const winSteamLocs = launcherEngine.discoverSteamLocations({
        platform: 'win32',
        execFileSyncFn: () =>
          `HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${customDriveSteamRoot}\r\n`,
      });
      expect(winSteamLocs.steamappsDirs).toContain(path.join(customDriveSteamRoot, 'steamapps'));
    });
  });

  // ============================================================================
  // TASK 3: Quit & Relaunch Installed-State Persistence (Electron + Catalog + UI)
  // ============================================================================
  describe('Task 3 — Quit & Relaunch Installed-State Persistence (Electron + Catalog + UI)', () => {
    it('3A: isolates stage exceptions in scanAllInstalledGames so Stage 4 managed installs survive, and resolves outer folder installPath in parseGogInfoFile', () => {
      const tmpHome = trackTempDir('task3-fault-isolation');
      const tmpUserData = path.join(tmpHome, 'userdata');
      fs.mkdirSync(tmpUserData, { recursive: true });

      // 1. Seed a managed macOS GOG folder install in one_launcher_installed.json
      const managedInstallDir = path.join(tmpHome, 'ManagedGames', 'SyntheticFolderMac');
      const managedBin = path.join(
        managedInstallDir,
        'SyntheticFolderMac.app',
        'Contents',
        'MacOS',
        'SyntheticFolderMac'
      );
      fs.mkdirSync(path.dirname(managedBin), { recursive: true });
      fs.writeFileSync(managedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(tmpUserData, 'one_launcher_installed.json'),
        JSON.stringify([
          {
            platformId: 'gog',
            platformGameId: '1800001001',
            title: 'Synthetic Folder Mac',
            installPath: managedInstallDir,
            executablePath: managedBin,
            installSize: 512000000,
            isWindowsBinaryOnMac: false,
          },
        ]),
        'utf8'
      );

      // Force Stage 1 (Steam) and Stage 3 (Epic) to throw uncaught errors inside their stage try/catch blocks
      const origExistsSync = cjsFs.existsSync;
      let stageThrowsTriggered = 0;
      const existsSpy = vi.spyOn(cjsFs, 'existsSync').mockImplementation((targetPath) => {
        const s = String(targetPath).replace(/\\/g, '/');
        if (
          s.endsWith('Library/Application Support/Steam') ||
          s.includes('Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat')
        ) {
          stageThrowsTriggered++;
          throw new Error(`Simulated scanner EACCES on ${s}`);
        }
        return origExistsSync(targetPath);
      });

      let scanRes: { installedGames: InstalledGameRecord[] };
      try {
        scanRes = launcherEngine.scanAllInstalledGames({
          platform: 'darwin',
          homedir: tmpHome,
          userDataDir: tmpUserData,
        });
      } finally {
        existsSpy.mockRestore();
      }

      expect(stageThrowsTriggered).toBeGreaterThanOrEqual(2);
      const survivedGog = scanRes.installedGames.find(
        (r) => r.platformId === 'gog' && r.platformGameId === '1800001001'
      );
      expect(survivedGog).toBeDefined();
      expect(survivedGog?.installPath).toBe(managedInstallDir);
      expect(survivedGog?.executablePath).toBe(managedBin);

      // 2. Verify parseGogInfoFile resolves <CustomSubfolder>/<GameFolder>/Contents/Resources/goggame-<id>.info
      // to installPath === <GameFolder> (NOT <CustomSubfolder>) when <GameFolder> does NOT end in .app
      const customSubfolder = path.join(tmpHome, 'CustomLibrarySubfolder');
      const gameFolder = path.join(customSubfolder, 'SyntheticQuasar');
      const quasarBin = path.join(
        gameFolder,
        'SyntheticQuasar.app',
        'Contents',
        'MacOS',
        'SyntheticQuasar'
      );
      const outerResDir = path.join(gameFolder, 'Contents', 'Resources');
      fs.mkdirSync(path.dirname(quasarBin), { recursive: true });
      fs.mkdirSync(outerResDir, { recursive: true });
      fs.writeFileSync(quasarBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(outerResDir, 'goggame-1800001002.info'),
        JSON.stringify({
          gameId: '1800001002',
          rootGameId: '1800001002',
          name: 'Synthetic Quasar',
          playTasks: [
            {
              isPrimary: true,
              type: 'FileTask',
              path: 'SyntheticQuasar.app/Contents/MacOS/SyntheticQuasar',
            },
          ],
        }),
        'utf8'
      );

      const folderScan = launcherEngine.scanAllInstalledGames({
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir: path.join(tmpHome, 'clean-userdata'),
        customRoots: [customSubfolder],
      });
      const quasarRec = folderScan.installedGames.find(
        (r: InstalledGameRecord) => r.platformId === 'gog' && r.platformGameId === '1800001002'
      );
      expect(quasarRec).toBeDefined();
      expect(quasarRec?.installPath).toBe(gameFolder);
      expect(quasarRec?.installPath).not.toBe(customSubfolder);
      expect(quasarRec?.executablePath).toBe(quasarBin);
    });

    it('3B: preserves installed: true, installPath, executablePath, installSize, and isWindowsBinaryOnMac across mergeStorefrontGames, non-authoritative reconciliation, delayed IDB hydration, and stale media-sync updates', () => {
      const cells: Array<{
        storefrontId: StorefrontId;
        id: string;
        platformGameId: string;
        steamAppId?: number;
        installPath: string;
        executablePath: string;
        isWindowsBinaryOnMac: boolean;
      }> = [
        // macOS Native (Steam, GOG, Epic)
        {
          storefrontId: 'steam',
          id: 'steam-990011',
          platformGameId: '990011',
          steamAppId: 990011,
          installPath: '/Users/player_one/Library/Application Support/Steam/steamapps/common/SyntheticSteamMac',
          executablePath: '/Users/player_one/Library/Application Support/Steam/steamapps/common/SyntheticSteamMac/Game.app/Contents/MacOS/Game',
          isWindowsBinaryOnMac: false,
        },
        {
          storefrontId: 'gog',
          id: 'gog-1800001001',
          platformGameId: '1800001001',
          installPath: '/Users/player_one/Games/OneLauncher/GOG/SyntheticGogMac',
          executablePath: '/Users/player_one/Games/OneLauncher/GOG/SyntheticGogMac/Game.app/Contents/MacOS/Game',
          isWindowsBinaryOnMac: false,
        },
        {
          storefrontId: 'epic',
          id: 'epic-SyntheticOrionMac',
          platformGameId: 'SyntheticOrionMac',
          installPath: '/Users/player_one/Games/OneLauncher/Epic/SyntheticOrionMac',
          executablePath: '/Users/player_one/Games/OneLauncher/Epic/SyntheticOrionMac/Game.app/Contents/MacOS/Game',
          isWindowsBinaryOnMac: false,
        },
        // macOS Bottled (Steam, GOG, Epic)
        {
          storefrontId: 'steam',
          id: 'steam-990012',
          platformGameId: '990012',
          steamAppId: 990012,
          installPath: '/Users/player_one/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/SyntheticSteamBottle',
          executablePath: '/Users/player_one/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/SyntheticSteamBottle/Game.exe',
          isWindowsBinaryOnMac: true,
        },
        {
          storefrontId: 'gog',
          id: 'gog-1800001002',
          platformGameId: '1800001002',
          installPath: '/Users/player_one/Games/OneLauncher/GOG/SyntheticGogBottle',
          executablePath: '/Users/player_one/Games/OneLauncher/GOG/SyntheticGogBottle/Game.exe',
          isWindowsBinaryOnMac: true,
        },
        {
          storefrontId: 'epic',
          id: 'epic-SyntheticOrionBottle',
          platformGameId: 'SyntheticOrionBottle',
          installPath: '/Users/player_one/Games/OneLauncher/Epic/SyntheticOrionBottle',
          executablePath: '/Users/player_one/Games/OneLauncher/Epic/SyntheticOrionBottle/Game.exe',
          isWindowsBinaryOnMac: true,
        },
        // Windows Native (Steam, GOG, Epic)
        {
          storefrontId: 'steam',
          id: 'steam-990013',
          platformGameId: '990013',
          steamAppId: 990013,
          installPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SyntheticSteamWin',
          executablePath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SyntheticSteamWin\\Game.exe',
          isWindowsBinaryOnMac: false,
        },
        {
          storefrontId: 'gog',
          id: 'gog-1800001003',
          platformGameId: '1800001003',
          installPath: 'C:\\Games\\OneLauncher\\GOG\\SyntheticGogWin',
          executablePath: 'C:\\Games\\OneLauncher\\GOG\\SyntheticGogWin\\Game.exe',
          isWindowsBinaryOnMac: false,
        },
        {
          storefrontId: 'epic',
          id: 'epic-SyntheticOrionWin',
          platformGameId: 'SyntheticOrionWin',
          installPath: 'C:\\Games\\OneLauncher\\Epic\\SyntheticOrionWin',
          executablePath: 'C:\\Games\\OneLauncher\\Epic\\SyntheticOrionWin\\Game.exe',
          isWindowsBinaryOnMac: false,
        },
      ];

      for (const cell of cells) {
        const existingGame: CanonicalGame = {
          id: cell.id,
          title: `Title ${cell.id}`,
          sortTitle: `title ${cell.id}`,
          ...(cell.steamAppId ? { steamAppId: cell.steamAppId } : {}),
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
          platforms: [
            {
              platformId: cell.storefrontId,
              platformGameId: cell.platformGameId,
              installed: true,
              installPath: cell.installPath,
              executablePath: cell.executablePath,
              installSize: 777000000,
              isWindowsBinaryOnMac: cell.isWindowsBinaryOnMac,
              playtimeMinutes: 45,
            },
          ],
        };

        const incomingCloudGame: CanonicalGame = {
          id: cell.id,
          title: `Title ${cell.id}`,
          sortTitle: `title ${cell.id}`,
          ...(cell.steamAppId ? { steamAppId: cell.steamAppId } : {}),
          headerImage: 'https://images.example.invalid/cover.jpg',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
          platforms: [
            {
              platformId: cell.storefrontId,
              platformGameId: cell.platformGameId,
              installed: false,
              playtimeMinutes: 60,
            },
          ],
        };

        // 1. mergeStorefrontGames never wipes installed: true when incoming cloud payload has installed: false
        const afterCloudMerge = mergeStorefrontGames([existingGame], [incomingCloudGame], cell.storefrontId);
        const mergedPlat = afterCloudMerge[0].platforms[0];
        expect(mergedPlat.installed).toBe(true);
        expect(mergedPlat.installPath).toBe(cell.installPath);
        expect(mergedPlat.executablePath).toBe(cell.executablePath);
        expect(mergedPlat.installSize).toBe(777000000);
        expect(mergedPlat.isWindowsBinaryOnMac).toBe(cell.isWindowsBinaryOnMac);

        // 2. reconcileCatalogGamesWithInstalledRecords with authoritativeRemoval: false preserves installed state on empty cold-boot records
        const coldBootRec = reconcileCatalogGamesWithInstalledRecords([existingGame], [], {
          authoritativeRemoval: false,
        });
        expect(coldBootRec[0].platforms[0].installed).toBe(true);
        expect(coldBootRec[0].platforms[0].installPath).toBe(cell.installPath);

        // 3. mergeHydratedCatalogPreservingLiveState preserves live installed state over delayed stale IDB snapshot
        const staleHydrated: CanonicalGame = {
          ...incomingCloudGame,
          platforms: [{ ...incomingCloudGame.platforms[0], installed: false }],
        };
        const afterHydrate = mergeHydratedCatalogPreservingLiveState([existingGame], [staleHydrated]);
        expect(afterHydrate[0].platforms[0].installed).toBe(true);
        expect(afterHydrate[0].platforms[0].installPath).toBe(cell.installPath);

        // 4. mergeUpdatedGamePreservingLivePlatformState preserves live installed state against stale async media-sync closure
        const afterMediaSync = mergeUpdatedGamePreservingLivePlatformState(existingGame, staleHydrated);
        expect(afterMediaSync.platforms[0].installed).toBe(true);
        expect(afterMediaSync.platforms[0].installPath).toBe(cell.installPath);
        expect(afterMediaSync.platforms[0].executablePath).toBe(cell.executablePath);
      }
    });

    it('3C: auto-switches SteamLibraryActionBar from uninstalled Steam (Install) to installed GOG (Play) once launcherService hydrates installed records', async () => {
      const prevWindow = (globalThis as Record<string, unknown>).window;
      const tmpInstallDir = trackTempDir('ui-actionbar-gog');
      const tmpExe = path.join(tmpInstallDir, 'SyntheticMulti.app', 'Contents', 'MacOS', 'SyntheticMulti');
      fs.mkdirSync(path.dirname(tmpExe), { recursive: true });
      fs.writeFileSync(tmpExe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      let scanInstalledPayload: InstalledGameRecord[] = [];
      (globalThis as Record<string, unknown>).window = {
        electronAPI: {
          platform: 'darwin',
          scanAllInstalledGames: vi.fn(async () => ({
            success: true,
            installedGames: scanInstalledPayload,
          })),
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };

      // Reset launcherService singleton to empty pre-hydration state
      await launcherService.scanAllInstalledGames(true);

      const multiStoreGame: CanonicalGame = {
        id: 'steam-990011',
        steamAppId: 990011,
        title: 'Synthetic Multi Store Quest',
        sortTitle: 'synthetic multi store quest',
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '990011',
            installed: false,
            playtimeMinutes: 120,
          },
          {
            platformId: 'gog',
            platformGameId: '1800001001',
            installed: false,
            playtimeMinutes: 15,
          },
        ],
      };

      // Stateful React 19 hook + effect harness for SteamLibraryActionBar
      const states: unknown[] = [];
      const refs: Array<{ current: unknown }> = [];
      const effects: Array<{ deps?: unknown[]; cleanup?: (() => void) | void }> = [];
      let dirty = false;

      const depsChanged = (prev?: unknown[], next?: unknown[]) => {
        if (!prev || !next) return true;
        if (prev.length !== next.length) return true;
        return next.some((v, idx) => !Object.is(v, prev[idx]));
      };

      const renderPass = () => {
        let stateIdx = 0;
        let refIdx = 0;
        let effectIdx = 0;
        const pendingEffects: Array<{ idx: number; fn: () => (() => void) | void; deps?: unknown[] }> = [];
        const internals = (React as unknown as {
          __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
        }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
        const prevH = internals.H;

        internals.H = {
          useState(initial: unknown) {
            const idx = stateIdx++;
            if (idx >= states.length) {
              states.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
            }
            const setState = (updater: unknown) => {
              const nextVal =
                typeof updater === 'function'
                  ? (updater as (prev: unknown) => unknown)(states[idx])
                  : updater;
              if (!Object.is(states[idx], nextVal)) {
                states[idx] = nextVal;
                dirty = true;
              }
            };
            return [states[idx], setState];
          },
          useRef(initial: unknown) {
            const idx = refIdx++;
            if (idx >= refs.length) {
              refs.push({ current: initial });
            }
            return refs[idx];
          },
          useEffect(fn: () => (() => void) | void, deps?: unknown[]) {
            const idx = effectIdx++;
            const prev = effects[idx];
            if (!prev || depsChanged(prev.deps, deps)) {
              pendingEffects.push({ idx, fn, deps });
            }
          },
          useMemo(fn: () => unknown) {
            return fn();
          },
          useCallback(fn: unknown) {
            return fn;
          },
        };

        let vnode: React.ReactElement;
        try {
          vnode = (SteamLibraryActionBar as unknown as (props: unknown) => React.ReactElement)({
            game: multiStoreGame,
          });
        } finally {
          internals.H = prevH;
        }

        const html = renderToString(vnode);
        for (const eff of pendingEffects) {
          if (effects[eff.idx]?.cleanup) {
            effects[eff.idx].cleanup?.();
          }
          const cleanup = eff.fn();
          effects[eff.idx] = { deps: eff.deps, cleanup };
        }
        return { vnode, html };
      };

      const flushRenders = () => {
        let result = renderPass();
        let guard = 0;
        while (dirty && guard < 10) {
          dirty = false;
          guard++;
          result = renderPass();
        }
        return result;
      };

      try {
        // 1. Pre-hydration render: neither storefront installed -> defaults to 'steam' and renders 'Install'
        const initialRender = flushRenders();
        expect(initialRender.html).toContain('Active Storefront: Steam');
        expect(initialRender.html).toContain('<span>Install</span>');
        expect(initialRender.html).not.toContain('<span>Play</span>');

        // 2. Hydrate GOG installed record via launcherService -> subscriber notifies SteamLibraryActionBar
        scanInstalledPayload = [
          {
            platformId: 'gog',
            platformGameId: '1800001001',
            title: 'Synthetic Multi Store Quest',
            installPath: tmpInstallDir,
            executablePath: tmpExe,
            installSize: 512000000,
            isWindowsBinaryOnMac: false,
          },
        ];
        await launcherService.scanAllInstalledGames(true);

        const hydratedRender = flushRenders();
        expect(hydratedRender.html).toContain('Active Storefront: GOG');
        expect(hydratedRender.html).toContain('<span>Play</span>');
        expect(hydratedRender.html).not.toContain('<span>Install</span>');
      } finally {
        for (const eff of effects) {
          try {
            eff?.cleanup?.();
          } catch {}
        }
        scanInstalledPayload = [];
        await launcherService.scanAllInstalledGames(true);
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    });
  });
});
