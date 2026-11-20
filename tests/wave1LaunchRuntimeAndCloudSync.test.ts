import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import EventEmitter from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPreloadApi } from './helpers/electronRuntimeHarness';

const require = createRequire(import.meta.url);

interface ChildProcessStub extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: (signal?: string) => boolean;
  unref: () => void;
}

function createChildStub(pid = 41001): ChildProcessStub {
  const proc = new EventEmitter() as ChildProcessStub;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  proc.unref = () => {};
  return proc;
}

function buildSyntheticPe64(): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x8664, 0x84);
  buf.writeUInt16LE(1, 0x86);
  buf.writeUInt16LE(0xf0, 0x94);
  buf.writeUInt16LE(0x0022, 0x96);
  buf.writeUInt16LE(0x020b, 0x98);
  return buf;
}

function seedValidSyntheticBottle(bottleDir: string): void {
  fs.mkdirSync(path.join(bottleDir, 'drive_c/windows/system32'), { recursive: true });
  fs.mkdirSync(path.join(bottleDir, 'drive_c/users/crossover/Documents'), { recursive: true });
  fs.writeFileSync(path.join(bottleDir, 'system.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  fs.writeFileSync(path.join(bottleDir, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');
  fs.writeFileSync(
    path.join(bottleDir, 'cxbottle.conf'),
    '[Bottle]\n"WineArch" = "win64"\n',
    'utf8'
  );
}

function seedSyntheticCrossOverApp(appsDir: string): string {
  const cxRoot = path.join(appsDir, 'CrossOver.app/Contents/SharedSupport/CrossOver');
  const binDir = path.join(cxRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(appsDir, 'CrossOver.app/Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.codeweavers.CrossOver</string>
  <key>CFBundleShortVersionString</key><string>26.0.0</string>
</dict></plist>`,
    'utf8'
  );
  fs.writeFileSync(path.join(binDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path.join(binDir, 'wine');
}

const tempDirs: string[] = [];

function makeTempDir(prefix = 'ol-wave1-runtime-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs') as {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS: Record<string, unknown>;
  LAUNCH_PROFILE_KEYS: string[];
  migrateLegacyHudConfig: (profile: Record<string, unknown>) => Record<string, unknown>;
  resolveEffectivePerformanceHud: (
    launchConfig?: Record<string, unknown> | null,
    perfSettings?: Record<string, unknown> | null
  ) => boolean;
  getLauncherPerformanceSettings: (options?: Record<string, unknown>) => Record<string, unknown>;
  saveLauncherPerformanceSettings: (
    settings: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
  saveGameLaunchConfig: (
    config: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
  getGameLaunchConfig: (
    gameId: string,
    options?: Record<string, unknown>
  ) => Record<string, unknown> | null;
  resolvePlatformLaunchConfig: (
    raw: Record<string, unknown> | null,
    platformId: string
  ) => Record<string, unknown>;
  resolveEffectivePerformancePolicy: (
    launchConfig?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
  isNetworkOnlineForLaunch: (options?: Record<string, unknown>) => boolean;
  clearMacQuarantineAsync: (
    targetPath: string,
    options?: Record<string, unknown>
  ) => Promise<boolean>;
  quarantineClearedBinaries: Set<string>;
  macCodesignValidCache: Map<string, string>;
  pendingBottleLaunches: Map<string, number>;
  inFlightPostSessionByBottle: Map<string, Promise<unknown>>;
  pendingWineRegSyncByPrefix: Map<string, Promise<unknown>>;
  inFlightLaunchesByGameId: Map<string, Promise<unknown>>;
  inFlightLaunchAbortControllers: Map<string, AbortController>;
  activeSessions: Map<string, Record<string, unknown>>;
  onSessionUpdated: (cb: (evt: Record<string, unknown>) => void) => () => void;
};

const macInstaller = require('../electron/launcher/macNativeInstallerAndCodesign.cjs') as {
  detectCompatibilityLayers: (options?: Record<string, unknown>) => Array<Record<string, unknown>>;
  invalidateCompatLayersCache: () => void;
  applyUnifiedPerformanceHudEnv: (params: Record<string, unknown>) => {
    hudEnabled: boolean;
    mode: string;
    appliedMetalHud: boolean;
    appliedDxvkHud: boolean;
    usedPreloadDylib: boolean;
  };
  applyCrossOverPerGameSettings: (
    layer: Record<string, unknown>,
    launchConfig: Record<string, unknown>,
    env: Record<string, string | undefined>,
    bottlePath: string,
    options?: Record<string, unknown>
  ) => void;
  buildDisplaySanitizeCacheKey: (params: Record<string, unknown>) => string;
  predictTargetBottlePrefix: (
    chosenLayer: Record<string, unknown> | null,
    launchConfig: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => string;
  ensureMacAppCodeSignatureValidAsync: (
    targetPath: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

const readinessBarrier = require('../electron/launcher/storefrontReadinessBarrier.cjs') as {
  waitForGogCommunicationServiceReady: (
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  waitForBottleEpicPortalReady: (
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

const epicCoordinator = require('../electron/launcher/epicLegendaryAndEosCoordinator.cjs') as {
  renewEpicTokensSingleFlight: (
    refreshToken: string,
    renewFn: (token: string) => Promise<Record<string, unknown>>
  ) => Promise<Record<string, unknown>>;
  ensureLegendaryConfigAndAuth: (
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  resolveEpicLaunchAuthArguments: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

const gogCoordinator = require('../electron/launcher/gogRegistryAndDirectInstaller.cjs') as {
  renewGogTokensSingleFlight: (
    refreshToken: string,
    renewFn: (token: string) => Promise<Record<string, unknown>>
  ) => Promise<Record<string, unknown>>;
  ensureGogdlAuthConfig: (
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

const cloudSaveEngine = require('../electron/launcher/cloudSaveEngine.cjs') as {
  PENDING_CLOUD_UPLOADS_FILENAME: string;
  pruneGogCloudConfigsMap: (rawMap: Record<string, unknown>) => Record<string, unknown>;
  syncXboxCloudSaves: (
    payload: Record<string, unknown>,
    mode: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  computeSavePathsStateSnapshot: (savePaths: string[]) => {
    localMaxMtimeMs: number;
    localFilesDigest: string;
    fileCount: number;
  };
  loadPendingCloudUploads: (
    options?: Record<string, unknown>
  ) => Array<Record<string, unknown>>;
  enqueuePendingCloudUpload: (
    record: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
  removePendingCloudUpload: (
    gameId: string,
    platformId: string,
    options?: Record<string, unknown>
  ) => Promise<boolean>;
  replayPendingCloudUpload: (
    entry: Record<string, unknown>,
    runners: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  replayPendingCloudUploads: (
    runners: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

interface LocalWgsContainerInput {
  name: string;
  displayName: string;
  containerNum: number;
  dirty: boolean;
  modifiedIso: string;
  blobs: Array<{ name: string; data: Buffer }>;
}

interface LocalWgsWorkspace {
  containers: Map<
    string,
    {
      blobs: Map<string, { data: Buffer }>;
    }
  >;
}

const xboxTitleStorageSync = require('../electron/storefronts/xbox/xboxTitleStorageSync.cjs') as {
  syncXboxTitleStorage: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  writeLocalWgsWorkspace: (
    wgsUserDir: string,
    workspace: { containers: LocalWgsContainerInput[] }
  ) => Promise<void>;
  readLocalWgsWorkspace: (wgsUserDir: string) => Promise<LocalWgsWorkspace>;
};

const supervisor = require('../electron/launcher/sessionAndProcessSupervisor.cjs') as {
  resetSupervisorStateForTests: () => void;
  launchGame: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  stopGame: (
    gameId: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  finalizeGameSession: (
    gameId: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  waitForActivePostSessionWork: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  syncGogCloudSaves: (
    payload: Record<string, unknown>,
    mode: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  syncEpicCloudSaves: (
    payload: Record<string, unknown>,
    mode: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  waitForSteamColdStartupCloudReady: (
    steamRoot: string,
    appId: string,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

const { registerLauncherIpcHandlers } = require('../electron/ipc/launcherIpcHandlers.cjs') as {
  registerLauncherIpcHandlers: (deps: Record<string, unknown>) => void;
};

afterEach(() => {
  supervisor.resetSupervisorStateForTests();
  macInstaller.invalidateCompatLayersCache();
  engineStateRegistry.quarantineClearedBinaries.clear();
  engineStateRegistry.macCodesignValidCache.clear();
  engineStateRegistry.pendingBottleLaunches.clear();
  engineStateRegistry.inFlightPostSessionByBottle.clear();
  engineStateRegistry.pendingWineRegSyncByPrefix.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
});

describe('Wave 1 Launch Runtime, Unified Performance HUD & Cloud-Save Hardening', () => {
  describe('1. Contract Parity, Legacy HUD Migration & IPC Persistence', () => {
    it('exports 11 DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS keys with defaultPerformanceHud and places performanceHud right after dxvkHud in LAUNCH_PROFILE_KEYS', () => {
      const defaults = engineStateRegistry.DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS;
      expect(Object.keys(defaults)).toHaveLength(11);
      expect(defaults.defaultPerformanceHud).toBe(false);

      const dxvkIdx = engineStateRegistry.LAUNCH_PROFILE_KEYS.indexOf('dxvkHud');
      const perfHudIdx = engineStateRegistry.LAUNCH_PROFILE_KEYS.indexOf('performanceHud');
      expect(dxvkIdx).toBeGreaterThan(-1);
      expect(perfHudIdx).toBe(dxvkIdx + 1);
      expect(engineStateRegistry.LAUNCH_PROFILE_KEYS).toContain('metalHud');
    });

    it('migrates all 6 legacy/new HUD combinations idempotently and applies them on config read and policy resolution', () => {
      const cases: Array<{
        input: Record<string, unknown>;
        expected: string | undefined;
      }> = [
        { input: { performanceHud: 'on', metalHud: false, dxvkHud: false }, expected: 'on' },
        { input: { performanceHud: 'off', metalHud: true, dxvkHud: true }, expected: 'off' },
        { input: { performanceHud: 'default', metalHud: true }, expected: 'default' },
        { input: { metalHud: true, dxvkHud: false }, expected: 'on' },
        { input: { metalHud: false, dxvkHud: true }, expected: 'on' },
        { input: { metalHud: false, dxvkHud: false }, expected: 'off' },
        { input: {}, expected: undefined },
      ];

      for (const tc of cases) {
        const once = engineStateRegistry.migrateLegacyHudConfig(tc.input);
        const twice = engineStateRegistry.migrateLegacyHudConfig(once);
        expect(once.performanceHud).toBe(tc.expected);
        expect(twice).toEqual(once);
      }

      const userDataDir = makeTempDir('ol-hud-cfg-');
      engineStateRegistry.saveLauncherPerformanceSettings(
        { defaultPerformanceHud: true },
        { userDataDir }
      );
      const perf = engineStateRegistry.getLauncherPerformanceSettings({ userDataDir });
      expect(perf.defaultPerformanceHud).toBe(true);

      engineStateRegistry.saveGameLaunchConfig(
        { gameId: 'custom:hud-legacy', metalHud: true, dxvkHud: false },
        { userDataDir }
      );
      const readLegacy = engineStateRegistry.getGameLaunchConfig('custom:hud-legacy', {
        userDataDir,
      });
      expect(readLegacy?.performanceHud).toBe('on');

      const policyDefault = engineStateRegistry.resolveEffectivePerformancePolicy(
        { performanceHud: 'default' },
        { userDataDir }
      );
      expect(policyDefault.effectivePerformanceHud).toBe(true);

      const policyOff = engineStateRegistry.resolveEffectivePerformancePolicy(
        { performanceHud: 'off' },
        { userDataDir }
      );
      expect(policyOff.effectivePerformanceHud).toBe(false);
    });

    it('preserves defaultPerformanceHud through launcher:save-performance-settings IPC handler', async () => {
      const userDataDir = makeTempDir('ol-ipc-perf-');
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockIpcMain = {
        handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(channel, fn);
        },
      };
      const savedPayloads: Array<Record<string, unknown>> = [];
      registerLauncherIpcHandlers({
        ipcMain: mockIpcMain,
        launcherEngine: {
          getLauncherPerformanceSettings: () =>
            engineStateRegistry.getLauncherPerformanceSettings({ userDataDir }),
          saveLauncherPerformanceSettings: (
            settings: Record<string, unknown>,
            opts?: Record<string, unknown>
          ) => {
            savedPayloads.push(settings);
            return engineStateRegistry.saveLauncherPerformanceSettings(settings, {
              ...(opts || {}),
              userDataDir,
            });
          },
        },
        options: { userDataDir },
      });

      const handler = handlers.get('launcher:save-performance-settings');
      expect(handler).toBeTypeOf('function');
      await handler?.({}, { defaultPerformanceHud: true }, {});
      expect(savedPayloads[0]?.defaultPerformanceHud).toBe(true);
      expect(
        engineStateRegistry.getLauncherPerformanceSettings({ userDataDir }).defaultPerformanceHud
      ).toBe(true);
    });
  });

  describe('2. Unified Performance HUD Resolver (Bug A, Bug B, Preload Preservation & macOS Menu)', () => {
    it('fixes Bug A: falls back to DXVK_HUD under Hardened Runtime + deadlocking MoltenVK even when legacy dxvkHud: false is set', () => {
      const env: Record<string, string | undefined> = {
        MTL_HUD_ENABLED: '1',
        CX_ENV: 'MTL_HUD_ENABLED=1 WINEDLLOVERRIDES=foo=n',
      };
      const res = macInstaller.applyUnifiedPerformanceHudEnv({
        env,
        platform: 'darwin',
        useCompatLayer: true,
        backend: 'dxvk',
        launchConfig: { metalHud: true, dxvkHud: false },
        perfSettings: { defaultPerformanceHud: false },
        options: {
          hasMoltenVkHudDeadlock: true,
          loaderAllowsDyldInsert: false,
        },
      });
      expect(res.hudEnabled).toBe(true);
      expect(res.appliedMetalHud).toBe(false);
      expect(res.appliedDxvkHud).toBe(true);
      expect(env.MTL_HUD_ENABLED).toBeUndefined();
      expect(env.DXVK_HUD).toBe('devinfo,fps,frametimes');
      expect(env.CX_ENV || '').not.toContain('MTL_HUD_ENABLED');
    });

    it('prevents double overlays when MTL_HUD_ENABLED is active unless user explicitly provides environmentVariables.DXVK_HUD', () => {
      const envNoCustom: Record<string, string | undefined> = { DXVK_HUD: 'fps' };
      const res1 = macInstaller.applyUnifiedPerformanceHudEnv({
        env: envNoCustom,
        platform: 'darwin',
        useCompatLayer: true,
        backend: 'd3dmetal',
        launchConfig: { metalHud: true, dxvkHud: true },
        perfSettings: { defaultPerformanceHud: false },
        options: { hasMoltenVkHudDeadlock: false },
      });
      expect(res1.appliedMetalHud).toBe(true);
      expect(res1.appliedDxvkHud).toBe(false);
      expect(envNoCustom.MTL_HUD_ENABLED).toBe('1');
      expect(envNoCustom.DXVK_HUD).toBeUndefined();

      const envWithCustom: Record<string, string | undefined> = {};
      const res2 = macInstaller.applyUnifiedPerformanceHudEnv({
        env: envWithCustom,
        platform: 'darwin',
        useCompatLayer: true,
        backend: 'd3dmetal',
        launchConfig: {
          performanceHud: 'on',
          environmentVariables: { DXVK_HUD: 'fps,memory' },
        },
        perfSettings: { defaultPerformanceHud: false },
        options: { hasMoltenVkHudDeadlock: false },
      });
      expect(res2.appliedMetalHud).toBe(true);
      expect(res2.appliedDxvkHud).toBe(true);
      expect(envWithCustom.MTL_HUD_ENABLED).toBe('1');
      expect(envWithCustom.DXVK_HUD).toBe('fps,memory');
    });

    it('preserves libone_metal_preload.dylib when hud is disabled and audioBufferClamp is enabled', () => {
      const envClamped: Record<string, string | undefined> = {
        MTL_HUD_ENABLED: '1',
        DYLD_INSERT_LIBRARIES: '/opt/custom.dylib:/tmp/libone_metal_preload.dylib',
      };
      macInstaller.applyUnifiedPerformanceHudEnv({
        env: envClamped,
        platform: 'darwin',
        useCompatLayer: true,
        backend: 'd3dmetal',
        launchConfig: { performanceHud: 'off', audioBufferClamp: true },
        perfSettings: { defaultPerformanceHud: true },
      });
      expect(envClamped.MTL_HUD_ENABLED).toBeUndefined();
      expect(envClamped.DYLD_INSERT_LIBRARIES).toContain('libone_metal_preload.dylib');

      const envUnclamped: Record<string, string | undefined> = {
        MTL_HUD_ENABLED: '1',
        DYLD_INSERT_LIBRARIES: '/tmp/libone_metal_preload.dylib',
      };
      macInstaller.applyUnifiedPerformanceHudEnv({
        env: envUnclamped,
        platform: 'darwin',
        useCompatLayer: true,
        backend: 'd3dmetal',
        launchConfig: { performanceHud: 'off', audioBufferClamp: false },
        perfSettings: { defaultPerformanceHud: true },
      });
      expect(envUnclamped.DYLD_INSERT_LIBRARIES).toBeUndefined();
    });

    it('fixes Bug B: wires MTL_HUD_ENABLED=1 on native macOS launches and prepends --env args before -W -a for /usr/bin/open', async () => {
      const tmp = makeTempDir('ol-native-mac-hud-');
      const userDataDir = path.join(tmp, 'userData');
      const appBundle = path.join(tmp, 'SynthNativeApp.app');
      const innerExe = path.join(appBundle, 'Contents/MacOS/SynthNativeBin');
      fs.mkdirSync(path.dirname(innerExe), { recursive: true });
      fs.writeFileSync(innerExe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const spawns: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> =
        [];
      const res = await supervisor.launchGame(
        {
          gameId: 'custom:native-mac-hud',
          title: 'Synthetic Native Mac',
          platformId: 'custom',
          installPath: appBundle,
          executablePath: innerExe,
          launchConfig: {
            launchMethod: 'direct',
            performanceHud: 'on',
            environmentVariables: {
              VALID_FLAG: 'enabled',
              'INVALID-KEY': 'drop-me',
              NUL_VAL: 'bad\0value',
            },
          },
        },
        {
          platform: 'darwin',
          userDataDir,
          homedir: tmp,
          forceMacOpenLaunch: true,
          gameSpawnFn: (
            cmd: string,
            args: string[],
            opts: { env: Record<string, string | undefined> }
          ) => {
            spawns.push({ cmd, args: [...args], env: { ...opts.env } });
            return createChildStub(42001);
          },
        }
      );

      expect(res.success).toBe(true);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].cmd).toBe('/usr/bin/open');
      expect(spawns[0].env.MTL_HUD_ENABLED).toBe('1');
      const aFlagIndex = spawns[0].args.indexOf('-a');
      const mtlEnvIndex = spawns[0].args.indexOf('MTL_HUD_ENABLED=1');
      const validFlagIndex = spawns[0].args.indexOf('VALID_FLAG=enabled');
      expect(aFlagIndex).toBeGreaterThan(-1);
      expect(mtlEnvIndex).toBeGreaterThan(-1);
      expect(mtlEnvIndex).toBeLessThan(aFlagIndex);
      expect(validFlagIndex).toBeGreaterThan(-1);
      expect(validFlagIndex).toBeLessThan(aFlagIndex);
      expect(spawns[0].args.join(' ')).not.toContain('INVALID-KEY');
      expect(spawns[0].args.join(' ')).not.toContain('NUL_VAL');
    });

    it('exposes onOpenSettings in preload.cjs and configures macOS Settings menu + 20s quit budget in main.cjs', () => {
      const preloadHarness = loadPreloadApi({ platform: 'darwin' });
      const received: unknown[] = [];
      const unsub = preloadHarness.api.onOpenSettings((section: unknown) => {
        received.push(section);
      });
      preloadHarness.emitIpcEvent('app:open-settings', 'general');
      expect(received).toEqual(['general']);
      unsub();
      preloadHarness.emitIpcEvent('app:open-settings', 'after-unsub');
      expect(received).toEqual(['general']);

      const mainSrc = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
      expect(mainSrc).toContain("accelerator: 'CmdOrCtrl+,'");
      expect(mainSrc).toContain("'app:open-settings'");
      expect(mainSrc).toContain('waitForActivePostSessionWork(20000)');
    });
  });

  describe('3. L-01, L-02, L-03, L-07 & L-08 Launch & Bottle Runtime Hardening', () => {
    it('L-01: coalesces concurrent double-click launches onto one spawn and lets stopGame abort an in-flight pre-launch wait with zero spawns', async () => {
      const tmp = makeTempDir('ol-l01-');
      const userDataDir = path.join(tmp, 'userData');
      const gameDir = path.join(tmp, 'Game');
      const exePath = path.join(gameDir, 'synth_game');
      fs.mkdirSync(gameDir, { recursive: true });
      fs.writeFileSync(exePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      let spawnCalls = 0;
      const launchOpts = {
        platform: 'darwin',
        homedir: tmp,
        userDataDir,
        gameSpawnFn: () => {
          spawnCalls += 1;
          return createChildStub(43000 + spawnCalls);
        },
      };
      const payload = {
        gameId: 'custom:l01-coalesce',
        title: 'Synthetic Coalesce',
        platformId: 'custom',
        installPath: gameDir,
        executablePath: exePath,
      };
      const [r1, r2] = await Promise.all([
        supervisor.launchGame(payload, launchOpts),
        supervisor.launchGame(payload, launchOpts),
      ]);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(spawnCalls).toBe(1);
      await supervisor.finalizeGameSession('custom:l01-coalesce', {
        skipPostSessionCloudSync: true,
      });

      // Now test aborting an in-flight launch during pre-launch bottle wait (0 ghost spawns)
      const appsDir = path.join(tmp, 'Applications');
      seedSyntheticCrossOverApp(appsDir);
      const bottleDir = path.join(tmp, 'Library/Application Support/CrossOver/Bottles/AbortBottle');
      seedValidSyntheticBottle(bottleDir);
      const winExe = path.join(gameDir, 'synth_abort.exe');
      fs.writeFileSync(winExe, buildSyntheticPe64());

      let releasePostSession!: () => void;
      const blocker = new Promise<void>((resolve) => {
        releasePostSession = resolve;
      });
      engineStateRegistry.inFlightPostSessionByBottle.set(path.resolve(bottleDir), blocker);

      let abortSpawnCalls = 0;
      const pendingLaunch = supervisor.launchGame(
        {
          gameId: 'custom:l01-abort',
          title: 'Synthetic Abort',
          platformId: 'custom',
          installPath: gameDir,
          executablePath: winExe,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'AbortBottle',
            winePrefixPath: bottleDir,
          },
        },
        {
          platform: 'darwin',
          homedir: tmp,
          customApplicationsDir: appsDir,
          userDataDir,
          skipBottleProvisioning: true,
          skipRegistrySpawn: true,
          gameSpawnFn: () => {
            abortSpawnCalls += 1;
            return createChildStub(43999);
          },
        }
      );

      await new Promise((r) => setTimeout(r, 25));
      const stopRes = await supervisor.stopGame('custom:l01-abort', { userDataDir });
      expect(stopRes.success).toBe(true);
      expect(stopRes.cancelled).toBe(true);
      releasePostSession();

      const launchRes = await pendingLaunch;
      expect(launchRes.success).toBe(false);
      expect(launchRes.cancelled).toBe(true);
      expect(abortSpawnCalls).toBe(0);
      expect(engineStateRegistry.inFlightLaunchesByGameId.size).toBe(0);
    });

    it('L-02 & L-08: predicts bottle prefix, awaits inFlightPostSessionByBottle before mutating cxbottle.conf, shares sanitize cache key, and chains pendingWineRegSyncByPrefix', async () => {
      const tmp = makeTempDir('ol-l02-');
      const bottlesDir = path.join(tmp, 'Library/Application Support/CrossOver/Bottles');
      const bottleDir = path.join(bottlesDir, 'SynthBottle');
      seedValidSyntheticBottle(bottleDir);

      const mockLayer = {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        binaryPath: '/bin/sh',
        bottlesDir,
        availableBottles: ['SynthBottle'],
      };
      const predicted = macInstaller.predictTargetBottlePrefix(
        mockLayer,
        { wineBottleName: 'SynthBottle' },
        { homedir: tmp }
      );
      expect(path.resolve(predicted)).toBe(path.resolve(bottleDir));

      const k1 = macInstaller.buildDisplaySanitizeCacheKey({
        prefixPath: bottleDir,
        highResolutionMode: true,
        displayScalingMode: 'auto_fullscreen',
        displayAspectRatio: 'preserve_aspect',
        installDir: tmp,
      });
      const k2 = macInstaller.buildDisplaySanitizeCacheKey({
        prefixPath: bottleDir,
        highResolutionMode: true,
        displayScalingMode: 'auto_fullscreen',
        displayAspectRatio: 'preserve_aspect',
        installDir: tmp,
      });
      expect(k1).toBe(k2);
      expect(k1).toContain(':auto_fullscreen:preserve_aspect:');

      // Verify pendingWineRegSyncByPrefix chains overlapping reg add calls sequentially
      const regOrder: string[] = [];
      let releaseFirstReg!: () => void;
      const execOrderCalls: number[] = [];
      const mockExecFile = (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void
      ) => {
        const idx = execOrderCalls.length + 1;
        execOrderCalls.push(idx);
        regOrder.push(`start-${idx}`);
        if (idx === 1) {
          releaseFirstReg = () => {
            regOrder.push('end-1');
            cb(null);
          };
        } else {
          regOrder.push(`end-${idx}`);
          cb(null);
        }
      };

      const envA: Record<string, string | undefined> = {};
      const envB: Record<string, string | undefined> = {};
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverHighResolutionMode: true },
        envA,
        bottleDir,
        { syncLiveWineReg: true, execFileFn: mockExecFile }
      );
      macInstaller.applyCrossOverPerGameSettings(
        mockLayer,
        { crossoverHighResolutionMode: false },
        envB,
        bottleDir,
        { syncLiveWineReg: true, execFileFn: mockExecFile }
      );

      await new Promise((r) => setTimeout(r, 15));
      // First applyCrossOverPerGameSettings starts its 3 reg add calls (RetinaMode + 2 LogPixels) while second waits in queue
      expect(regOrder[0]).toBe('start-1');
      expect(regOrder.includes('start-4')).toBe(false);
      releaseFirstReg();
      const pendingReg = engineStateRegistry.pendingWineRegSyncByPrefix.get(path.resolve(bottleDir));
      if (pendingReg) {
        await pendingReg;
      }
      expect(regOrder.indexOf('end-1')).toBeLessThan(regOrder.indexOf('start-4'));
    });

    it('L-03: stopGame awaits graceful exit before wineserver shutdown and defers prefix shutdown for Xbox sessions', async () => {
      const tmp = makeTempDir('ol-l03-');
      const userDataDir = path.join(tmp, 'userData');
      const appsDir = path.join(tmp, 'Applications');
      seedSyntheticCrossOverApp(appsDir);
      const bottleDir = path.join(tmp, 'Library/Application Support/CrossOver/Bottles/XboxBottle');
      seedValidSyntheticBottle(bottleDir);
      const gameDir = path.join(tmp, 'XboxGame');
      fs.mkdirSync(gameDir, { recursive: true });
      const winExe = path.join(gameDir, 'synth_xbox.exe');
      fs.writeFileSync(winExe, buildSyntheticPe64());

      const events: string[] = [];
      const realChild = nodeSpawn(
        process.execPath,
        [
          '-e',
          'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 40)); setInterval(() => {}, 1000);',
        ],
        { stdio: 'ignore' }
      );
      realChild.once('exit', () => {
        events.push('graceful-exit');
      });

      try {
        const res = await supervisor.launchGame(
          {
            gameId: 'xbox:l03-test',
            title: 'Synthetic Xbox Stop',
            platformId: 'xbox',
            platformGameId: 'l03-test',
            installPath: gameDir,
            executablePath: winExe,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'XboxBottle',
              winePrefixPath: bottleDir,
            },
          },
          {
            platform: 'darwin',
            homedir: tmp,
            customApplicationsDir: appsDir,
            userDataDir,
            offline: true,
            skipBottleProvisioning: true,
            skipRegistrySpawn: true,
            gameSpawnFn: () => realChild,
          }
        );
        expect(res.success).toBe(true);

        const activeEntry = engineStateRegistry.activeSessions.get('xbox:l03-test');
        expect(activeEntry).toBeDefined();

        let shutdownInvoked = false;
        const stopStart = Date.now();
        const stopRes = await supervisor.stopGame('xbox:l03-test', {
          userDataDir,
          skipPostSessionCloudSync: true,
          execFileFn: (
            bin: string,
            args: string[],
            _opts: unknown,
            cb?: (err: Error | null, stdout: string) => void
          ) => {
            if (String(bin).includes('wineserver') || args.includes('-k')) {
              shutdownInvoked = true;
              events.push('wineserver-k');
            }
            if (cb) cb(null, '');
          },
        });
        const stopElapsedMs = Date.now() - stopStart;

        expect(stopRes.success).toBe(true);
        expect(stopElapsedMs).toBeGreaterThanOrEqual(25);
        expect(events).toEqual(['graceful-exit']);
        expect(activeEntry?.deferredPrefixShutdownToFinalize).toBe(true);
        expect(shutdownInvoked).toBe(false);
      } finally {
        try {
          realChild.kill('SIGKILL');
        } catch {}
      }
    });

    it('L-07: uses O(1) xattr probe + cache, persists codesign cache across restarts, and never ad-hoc re-signs on timeout or Developer ID authority', async () => {
      const tmp = makeTempDir('ol-l07-');
      const userDataDir = path.join(tmp, 'userData');
      const appBundle = path.join(tmp, 'SignedSynth.app');
      fs.mkdirSync(path.join(appBundle, 'Contents/MacOS'), { recursive: true });
      fs.writeFileSync(
        path.join(appBundle, 'Contents/Info.plist'),
        '<plist><dict><key>CFBundleIdentifier</key><string>com.synth.test</string></dict></plist>'
      );
      fs.writeFileSync(path.join(appBundle, 'Contents/MacOS/Synth'), '#!/bin/sh\n', { mode: 0o755 });

      // 1. Quarantine O(1) probe skips xattr -dr when absent and caches
      const xattrCalls: string[][] = [];
      const mockXattrExec = (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        xattrCalls.push(args);
        const err = new Error('No such xattr: com.apple.quarantine') as Error & { code?: number };
        err.code = 1;
        cb(err, '', 'No such xattr: com.apple.quarantine');
      };
      await engineStateRegistry.clearMacQuarantineAsync(appBundle, {
        platform: 'darwin',
        execFileFn: mockXattrExec,
      });
      await engineStateRegistry.clearMacQuarantineAsync(appBundle, {
        platform: 'darwin',
        execFileFn: mockXattrExec,
      });
      expect(xattrCalls).toHaveLength(1);
      expect(xattrCalls[0][0]).toBe('-p');

      // 2. Timeout during codesign --verify NEVER runs --sign -
      const timeoutCmds: string[][] = [];
      const timeoutRes = await macInstaller.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
        userDataDir,
        execFileFn: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          timeoutCmds.push([cmd, ...args]);
          if (cmd === 'codesign' && args.includes('--verify')) {
            const timeoutErr = new Error('Command timed out') as Error & {
              killed?: boolean;
              signal?: string;
            };
            timeoutErr.killed = true;
            timeoutErr.signal = 'SIGTERM';
            cb(timeoutErr, '', '');
            return;
          }
          cb(null, '', '');
        },
      });
      expect(timeoutRes.timedOut).toBe(true);
      expect(timeoutRes.repaired).toBe(false);
      expect(timeoutCmds.some((c) => c.includes('--sign'))).toBe(false);

      // 3. Developer ID Authority is NEVER overwritten with ad-hoc signature
      const devIdCmds: string[][] = [];
      const devIdRes = await macInstaller.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
        userDataDir,
        execFileFn: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          devIdCmds.push([cmd, ...args]);
          if (cmd === 'codesign' && args.includes('--verify')) {
            cb(new Error('invalid resource seal'), '', 'invalid resource seal');
            return;
          }
          if (cmd === 'codesign' && args.includes('-dv')) {
            cb(null, '', 'Authority=Developer ID Application: Synthetic Studio (TEAM12345)');
            return;
          }
          cb(null, '', '');
        },
      });
      expect(devIdRes.preservedTrustedSignature).toBe(true);
      expect(devIdRes.repaired).toBe(false);
      expect(devIdCmds.some((c) => c.includes('--sign'))).toBe(false);

      // 4. Verified signature persists across cold restart (cleared in-memory map)
      let verifyCount = 0;
      const okExec = (
        cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        if (cmd === 'codesign' && args.includes('--verify')) {
          verifyCount += 1;
        }
        cb(null, '', '');
      };
      const firstVerify = await macInstaller.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
        useCodesignCache: true,
        userDataDir,
        execFileFn: okExec,
      });
      expect(firstVerify.verified).toBe(true);
      expect(verifyCount).toBe(1);

      engineStateRegistry.macCodesignValidCache.clear();
      const secondVerify = await macInstaller.ensureMacAppCodeSignatureValidAsync(appBundle, {
        platform: 'darwin',
        allowCodesignInTest: true,
        useCodesignCache: true,
        userDataDir,
        execFileFn: okExec,
      });
      expect(secondVerify.verified).toBe(true);
      expect(secondVerify.cached).toBe(true);
      expect(verifyCount).toBe(1);
    });

    it('L-08: caches detectCompatibilityLayers for 60s and automatically busts on invalidate or bottle directory change', () => {
      const tmp = makeTempDir('ol-compat-cache-');
      const appsDir = path.join(tmp, 'Applications');
      const wineBinDir = path.join(appsDir, 'Wine Stable.app/Contents/Resources/wine/bin');
      fs.mkdirSync(wineBinDir, { recursive: true });
      fs.writeFileSync(path.join(wineBinDir, 'wine64'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const first = macInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: tmp,
        customApplicationsDir: appsDir,
      });
      expect(first.some((l) => l.type === 'wine')).toBe(true);

      const second = macInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: tmp,
        customApplicationsDir: appsDir,
      });
      expect(second).toEqual(first);
      expect(second).not.toBe(first);

      macInstaller.invalidateCompatLayersCache();
      const third = macInstaller.detectCompatibilityLayers({
        platform: 'darwin',
        homedir: tmp,
        customApplicationsDir: appsDir,
        forceRefresh: true,
      });
      expect(third).toEqual(first);
    });
  });

  describe('4. L-04, L-05, L-06, L-09 & L-10 Offline Fast-Fail, Single-Flight OAuth, Xbox Concurrency & Conflict-Safe Cloud Queue', () => {
    it('L-04: fast-fails offline across readiness barriers, cloud syncs, Steam cold wait, and Epic/GOG auth with zero hidden recovery windows', async () => {
      const tmp = makeTempDir('ol-l04-');
      const startMs = Date.now();

      const [gogBarrier, epicBarrier, gogSync, epicSync, xboxSync, steamWait, epicAuth, legAuth] =
        await Promise.all([
          readinessBarrier.waitForGogCommunicationServiceReady({
            enableGogReadinessBarrier: true,
            offline: true,
            timeoutMs: 10000,
          }),
          readinessBarrier.waitForBottleEpicPortalReady({
            enableEpicReadinessBarrier: true,
            offline: true,
            timeoutMs: 10000,
          }),
          supervisor.syncGogCloudSaves(
            { platformId: 'gog', platformGameId: '1000001', gameId: 'gog:1000001' },
            'pre_launch',
            { offline: true, userDataDir: tmp, homedir: tmp }
          ),
          supervisor.syncEpicCloudSaves(
            { platformId: 'epic', platformGameId: 'synth-epic', gameId: 'epic:synth-epic' },
            'pre_launch',
            { offline: true, userDataDir: tmp, homedir: tmp }
          ),
          cloudSaveEngine.syncXboxCloudSaves(
            {
              platformId: 'xbox',
              platformGameId: 'synth-xbox',
              gameId: 'xbox:synth-xbox',
              scid: '00000000-0000-0000-0000-000000000001',
              packageFamilyName: 'Synth.Package_12345',
            },
            'pre_launch',
            { offline: true, userDataDir: tmp, homedir: tmp }
          ),
          supervisor.waitForSteamColdStartupCloudReady(tmp, '999999', {
            offline: true,
            enableTwoStageSteamColdStart: true,
            timeoutMs: 10000,
          }),
          epicCoordinator.resolveEpicLaunchAuthArguments(
            { platformId: 'epic', platformGameId: 'synth-epic' },
            { offline: true, userDataDir: tmp, homedir: tmp }
          ),
          epicCoordinator.ensureLegendaryConfigAndAuth({
            offline: true,
            userDataDir: tmp,
            homedir: tmp,
          }),
        ]);

      const elapsedMs = Date.now() - startMs;
      expect(elapsedMs).toBeLessThan(500);
      expect(gogBarrier.offlineSkipped).toBe(true);
      expect(epicBarrier.offlineSkipped).toBe(true);
      expect(gogSync.offlineSkipped).toBe(true);
      expect(epicSync.offlineSkipped).toBe(true);
      expect(xboxSync.offlineSkipped).toBe(true);
      expect(steamWait.offlineSkipped).toBe(true);
      expect(epicAuth.offlineSkipped).toBe(true);
      expect(legAuth.authenticated).toBe(false);
    });

    it('L-05: honors both preBootOffset and preBootLogOffset in waitForBottleEpicPortalReady', async () => {
      const tmp = makeTempDir('ol-l05-');
      const logFile = path.join(tmp, 'EpicGamesLauncher.log');
      const staleContent = 'LogInit: Startup\nLogOnline: Portal Ready (stale)\n';
      fs.writeFileSync(logFile, staleContent, 'utf8');
      const offset = Buffer.byteLength(staleContent, 'utf8');

      // Append a fresh post-boot portal ready marker shortly after barrier starts
      setTimeout(() => {
        fs.appendFileSync(logFile, 'LogOnline: FCommunityPortalManagerImpl initialized\n', 'utf8');
      }, 35);

      const resWithNewName = await readinessBarrier.waitForBottleEpicPortalReady({
        enableEpicReadinessBarrier: true,
        epicBottleLogPath: logFile,
        preBootLogOffset: offset,
        timeoutMs: 1500,
        settleMs: 1500,
        pollIntervalMs: 20,
      });
      expect(resWithNewName.ready).toBe(true);
      expect(resWithNewName.reason).toBe('portal_ready');

      // Passing preBootOffset at EOF with no new lines times out instead of matching stale lines
      const endOffset = fs.statSync(logFile).size;
      const resStaleIgnored = await readinessBarrier.waitForBottleEpicPortalReady({
        enableEpicReadinessBarrier: true,
        epicBottleLogPath: logFile,
        preBootOffset: endOffset,
        timeoutMs: 80,
        settleMs: 80,
        pollIntervalMs: 20,
      });
      expect(resStaleIgnored.timedOut).toBe(true);
    });

    it('L-06: bounds Xbox Title Storage blob transfers to 4-way concurrency and coalesces 412/403 lock recovery', async () => {
      const tmp = makeTempDir('ol-l06-');
      const wgsUserDir = path.join(tmp, 'wgs_user');
      fs.mkdirSync(wgsUserDir, { recursive: true });

      const containers: LocalWgsContainerInput[] = [];
      for (let i = 0; i < 10; i += 1) {
        containers.push({
          name: `slot_${String(i).padStart(2, '0')}`,
          displayName: `Slot ${i}`,
          containerNum: i + 1,
          dirty: true,
          modifiedIso: '2026-10-26T12:00:00.000Z',
          blobs: [{ name: 'save.bin', data: Buffer.from(`payload-${i}`, 'utf8') }],
        });
      }
      await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsUserDir, { containers });

      let activeAtomUploads = 0;
      let peakAtomUploads = 0;
      let lockCalls = 0;
      let staleLockActive = true;
      const storedContainers = new Map<string, Record<string, unknown>>();

      const fetchImpl = async (urlStr: string, init?: { method?: string; body?: unknown }) => {
        const method = String(init?.method || 'GET').toUpperCase();
        const u = new URL(urlStr);
        const match = /^\/connectedstorage\/users\/xuid\([^)]+\)\/scids\/[^/]+(.*)$/.exec(
          u.pathname
        );
        const subPath = match ? decodeURIComponent(match[1] || '') : '';

        if (subPath === '/lock' && method === 'PUT') {
          lockCalls += 1;
          await new Promise((r) => setTimeout(r, 15));
          staleLockActive = false;
          return new Response(JSON.stringify({ quotaBytes: 268435456 }), { status: 200 });
        }
        if (subPath === '/lock' && method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        if ((subPath === '' || subPath === '/') && method === 'GET') {
          return new Response(JSON.stringify({ blobs: [] }), { status: 200 });
        }
        if (subPath.endsWith(',binary') && method === 'PUT') {
          activeAtomUploads += 1;
          peakAtomUploads = Math.max(peakAtomUploads, activeAtomUploads);
          await new Promise((r) => setTimeout(r, 20));
          activeAtomUploads -= 1;
          if (staleLockActive) {
            return new Response('Precondition Failed', { status: 412 });
          }
          return new Response(null, { status: 201 });
        }
        if (subPath.endsWith(',savedgame') && method === 'PUT') {
          const cName = subPath.slice(1, -',savedgame'.length);
          storedContainers.set(cName, { ok: true });
          return new Response('{}', { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const res = await xboxTitleStorageSync.syncXboxTitleStorage({
        mode: 'post_exit',
        wgsUserDir,
        xuid: '2533274799999999',
        scid: '00000000-0000-0000-0000-000000000002',
        packageFamilyName: 'Synth.Package_8wekyb3d8bbwe',
        authorizationHeader: 'XBL3.0 x=2533274799999999;mock_jwt',
        titleStorageOrigin: 'https://titlestorage.mock.local',
        alreadyLocked: true,
        fetchImpl,
        blobConcurrency: 4,
      });

      expect(res.uploadedContainers).toBe(10);
      expect(storedContainers.size).toBe(10);
      expect(peakAtomUploads).toBeGreaterThan(1);
      expect(peakAtomUploads).toBeLessThanOrEqual(4);
      // All parallel 412s coalesce onto a single lock re-acquisition
      expect(lockCalls).toBe(1);
    });

    it('L-08 & L-09: prunes expired GOG negative cache entries, deduplicates parallel OAuth refreshes, and skips unchanged disk rewrites', async () => {
      const now = Date.now();
      const pruned = cloudSaveEngine.pruneGogCloudConfigsMap({
        __noCloudProductIds: {
          '111': now - 1000,
          '222': now - 8 * 24 * 60 * 60 * 1000,
        },
      }) as { __noCloudProductIds?: Record<string, number> };
      expect(pruned.__noCloudProductIds?.['111']).toBeDefined();
      expect(pruned.__noCloudProductIds?.['222']).toBeUndefined();

      let epicCalls = 0;
      const epicRenewFn = async (rt: string) => {
        epicCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return { access_token: `tok-${rt}`, refresh_token: rt };
      };
      const [e1, e2, e3] = await Promise.all([
        epicCoordinator.renewEpicTokensSingleFlight('shared-epic-rt', epicRenewFn),
        epicCoordinator.renewEpicTokensSingleFlight('shared-epic-rt', epicRenewFn),
        epicCoordinator.renewEpicTokensSingleFlight('shared-epic-rt', epicRenewFn),
      ]);
      expect(epicCalls).toBe(1);
      expect(e1).toEqual(e2);
      expect(e2).toEqual(e3);

      let gogCalls = 0;
      const gogRenewFn = async (rt: string) => {
        gogCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return { access_token: `gog-${rt}`, refresh_token: rt };
      };
      const [g1, g2] = await Promise.all([
        gogCoordinator.renewGogTokensSingleFlight('shared-gog-rt', gogRenewFn),
        gogCoordinator.renewGogTokensSingleFlight('shared-gog-rt', gogRenewFn),
      ]);
      expect(gogCalls).toBe(1);
      expect(g1).toEqual(g2);

      // Idempotent gogdl auth.json write skips disk rewrite when serialized bytes already match
      const tmp = makeTempDir('ol-l09-gog-');
      const authPath = path.join(tmp, 'gogdl_auth.json');
      const savedTokens = {
        gog: {
          access_token: 'eyJhbGciOiJSUzI1NiJ9_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
          refresh_token: 'R9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0',
          expires_in: 3600,
          loginTime: Math.floor(Date.now() / 1000),
          user_id: '987654321',
        },
      };
      await gogCoordinator.ensureGogdlAuthConfig({
        gogAuthPath: authPath,
        homedir: tmp,
        userDataDir: tmp,
        savedTokens,
        skipNetwork: true,
      });
      const firstStat = fs.statSync(authPath);
      const backdated = new Date(firstStat.mtimeMs - 5000);
      fs.utimesSync(authPath, backdated, backdated);
      const backdatedMtime = fs.statSync(authPath).mtimeMs;

      await gogCoordinator.ensureGogdlAuthConfig({
        gogAuthPath: authPath,
        homedir: tmp,
        userDataDir: tmp,
        savedTokens,
        skipNetwork: true,
      });
      expect(fs.statSync(authPath).mtimeMs).toBe(backdatedMtime);
    });

    it('L-10: persists interrupted uploads, replays in conflict-safe bidirectional mode with rolling backup (never --force-upload), guards Xbox conflicts, and closes Steam cloud blind spot', async () => {
      const tmp = makeTempDir('ol-l10-');
      const userDataDir = path.join(tmp, 'userData');
      const saveDir = path.join(tmp, 'GameSaves');
      fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(path.join(saveDir, 'slot1.sav'), 'local-save-bytes', 'utf8');

      const snapshot = cloudSaveEngine.computeSavePathsStateSnapshot([saveDir]);
      expect(snapshot.fileCount).toBe(1);
      expect(snapshot.localFilesDigest.length).toBeGreaterThan(10);

      // Enqueue pending upload and verify disk persistence
      await cloudSaveEngine.enqueuePendingCloudUpload(
        {
          gameId: 'gog:555001',
          platformId: 'gog',
          platformGameId: '555001',
          title: 'Synthetic GOG Pending',
          lastSyncedAt: Date.now() - 60_000,
          savePaths: [saveDir],
        },
        { userDataDir }
      );
      const loaded = cloudSaveEngine.loadPendingCloudUploads({ userDataDir });
      expect(loaded).toHaveLength(1);
      expect(loaded[0].gameId).toBe('gog:555001');
      expect(loaded[0].localFilesDigest).toBe(snapshot.localFilesDigest);

      // Replay in bidirectional mode (NEVER forceUpload / --force-upload) and verify rolling backup created
      const observedSyncCalls: Array<{ mode: string; options: Record<string, unknown> }> = [];
      const replayRes = await cloudSaveEngine.replayPendingCloudUploads(
        {
          syncGogCloudSaves: async (
            _payload: Record<string, unknown>,
            mode: string,
            opts: Record<string, unknown>
          ) => {
            observedSyncCalls.push({ mode, options: opts });
            return { synced: true, uploaded: true };
          },
        },
        { userDataDir }
      );
      expect(replayRes.replayed).toBe(1);
      expect(observedSyncCalls).toHaveLength(1);
      expect(observedSyncCalls[0].mode).toBe('both');
      expect(observedSyncCalls[0].options.forceUpload).toBeFalsy();
      expect(observedSyncCalls[0].options.skipDownload).toBeFalsy();
      expect(cloudSaveEngine.loadPendingCloudUploads({ userDataDir })).toHaveLength(0);

      // Verify rolling backup was created under cloud_save_backups/gog/<safeId>/pending_replay_0
      const backupRoot = path.join(
        userDataDir,
        'cloud_save_backups',
        'gog',
        'gog_555001',
        'pending_replay_0'
      );
      expect(fs.existsSync(backupRoot)).toBe(true);

      // Verify Xbox Title Storage conflict guard pulls newer remote save instead of blindly overwriting
      const wgsConflictDir = path.join(tmp, 'wgs_conflict');
      const tSync = Date.now() - 120_000;
      const tLocalIso = new Date(tSync + 10_000).toISOString();
      const tRemoteIso = new Date(tSync + 60_000).toISOString();
      await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsConflictDir, {
        containers: [
          {
            name: 'ProfileSlot',
            displayName: 'ProfileSlot',
            containerNum: 1,
            dirty: true,
            modifiedIso: tLocalIso,
            blobs: [{ name: 'data.bin', data: Buffer.from('stale-local-data', 'utf8') }],
          },
        ],
      });

      const remoteAtomKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,binary';
      let uploadAttempted = false;
      const conflictFetch = async (urlStr: string, init?: { method?: string }) => {
        const method = String(init?.method || 'GET').toUpperCase();
        const u = new URL(urlStr);
        const match = /^\/connectedstorage\/users\/xuid\([^)]+\)\/scids\/[^/]+(.*)$/.exec(
          u.pathname
        );
        const subPath = match ? decodeURIComponent(match[1] || '') : '';
        if (subPath === '/lock' && method === 'PUT') {
          return new Response(JSON.stringify({ quotaBytes: 268435456 }), { status: 200 });
        }
        if (subPath === '/lock' && method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        if ((subPath === '' || subPath === '/') && method === 'GET') {
          return new Response(
            JSON.stringify({
              blobs: [
                {
                  fileName: 'ProfileSlot,savedgame',
                  displayName: 'ProfileSlot',
                  clientFileTime: tRemoteIso,
                  etag: '"etag-remote-newer"',
                  size: 18,
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (subPath === '/ProfileSlot,savedgame' && method === 'GET') {
          return new Response(JSON.stringify({ atoms: { 'data.bin': remoteAtomKey } }), {
            status: 200,
          });
        }
        if (subPath === `/${remoteAtomKey}` && method === 'GET') {
          return new Response(Buffer.from('newer-remote-cloud', 'utf8'), { status: 200 });
        }
        if ((subPath.endsWith(',binary') || subPath.endsWith(',savedgame')) && method === 'PUT') {
          uploadAttempted = true;
          return new Response('{}', { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const conflictRes = await xboxTitleStorageSync.syncXboxTitleStorage({
        mode: 'pre_launch',
        wgsUserDir: wgsConflictDir,
        xuid: '2533274788888888',
        scid: '00000000-0000-0000-0000-000000000009',
        packageFamilyName: 'Synth.Conflict_8wekyb3d8bbwe',
        authorizationHeader: 'XBL3.0 x=2533274788888888;mock_jwt',
        titleStorageOrigin: 'https://titlestorage.mock.local',
        pendingUploadLastSyncedAt: tSync,
        fetchImpl: conflictFetch,
      });
      expect(conflictRes.conflictDetected).toBe(true);
      expect(uploadAttempted).toBe(false);
      const postWs = await xboxTitleStorageSync.readLocalWgsWorkspace(wgsConflictDir);
      expect(
        postWs.containers.get('ProfileSlot')?.blobs.get('data.bin')?.data.toString('utf8')
      ).toBe('newer-remote-cloud');

      // Verify Steam Cloud Sync blind spot is fixed under minimal_keep_running
      const steamRoot = path.join(tmp, 'Steam');
      const steamLogsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(steamLogsDir, { recursive: true });
      const cloudLogPath = path.join(steamLogsDir, 'cloud_log.txt');
      fs.writeFileSync(
        cloudLogPath,
        '[2026-01-01 00:00:00] [AppID 777001] Starting sync (up, AC Exit)\n',
        'utf8'
      );

      const exePath = path.join(tmp, 'synth_steam_bin');
      fs.writeFileSync(exePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const steamLaunch = await supervisor.launchGame(
        {
          gameId: 'steam:777001',
          title: 'Synthetic Steam Cloud',
          platformId: 'steam',
          platformGameId: '777001',
          steamAppId: '777001',
          installPath: tmp,
          executablePath: exePath,
          launchConfig: {
            launchMethod: 'direct',
            storefrontClientLifecycle: 'minimal_keep_running',
          },
        },
        {
          platform: 'darwin',
          homedir: tmp,
          userDataDir,
          gameSpawnFn: () => createChildStub(45001),
        }
      );
      expect(steamLaunch.success).toBe(true);

      const telemetryEvents: Array<Record<string, unknown>> = [];
      const unsubTelemetry = engineStateRegistry.onSessionUpdated((evt) => {
        telemetryEvents.push(evt);
      });
      try {
        const steamEntry = engineStateRegistry.activeSessions.get('steam:777001');
        if (steamEntry) {
          steamEntry.wokeSteamByLauncher = true;
          steamEntry.effectiveStorefrontLifecycle = 'minimal_keep_running';
        }
        setTimeout(() => {
          fs.appendFileSync(
            cloudLogPath,
            '[2026-01-01 00:00:01] [AppID 777001] Upload complete\n',
            'utf8'
          );
        }, 25);
        await supervisor.finalizeGameSession('steam:777001', {
          userDataDir,
          homedir: tmp,
          steamRoot,
          steamCloudSyncTimeoutMs: 500,
          steamCloudPollIntervalMs: 20,
        });
        await supervisor.waitForActivePostSessionWork(1500);
      } finally {
        unsubTelemetry();
      }
      expect(
        telemetryEvents.some((e) => e.event === 'cloud_sync_complete')
      ).toBe(true);
    });
  });
});
