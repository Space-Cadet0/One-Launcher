import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const cloudSaveEngine = nodeRequire('../electron/launcher/cloudSaveEngine.cjs');
const gogAndEpicRunnerMod = nodeRequire('../electron/launcher/cloudSave/gogAndEpicCloudRunner.cjs');
const boundedCopyUtils = nodeRequire('../electron/launcher/boundedCopyUtils.cjs');
const installedGameScanner = nodeRequire('../electron/launcher/installedGameScanner.cjs');
const xgsMirroring = nodeRequire('../electron/storefronts/xbox/titlestorage/xgsMirroring.cjs');
const xboxTitleStorageSync = nodeRequire('../electron/storefronts/xbox/xboxTitleStorageSync.cjs');
const xboxRuntimeLoopbackServer = nodeRequire(
  '../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs'
);

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileOptionsOrCallback = Record<string, unknown> | ExecFileCallback | undefined;

interface RunnerOptionsBag {
  homedir?: string;
  userDataDir?: string;
  legendaryConfigDir?: string;
  [key: string]: unknown;
}

interface ScannedGameLike {
  platformId?: string;
  platformGameId?: string | number;
  clientId?: string;
  gogClientId?: string;
}

interface WgsContainerStub {
  name: string;
  blobs: Map<string, unknown>;
}

interface LoopbackRpcResponse {
  id?: number;
  ok?: boolean;
  result?: {
    synced?: boolean;
    quotaBytes?: number;
    remainingQuotaBytes?: number;
    [key: string]: unknown;
  };
  error?: string;
}

function createMockSteamRunner(isTestEnvFn: (opts?: RunnerOptionsBag) => boolean = () => true) {
  return cloudSaveEngine.createCloudSaveRunner({
    resolveIsolatedHomedirAndUserData: (opts: RunnerOptionsBag = {}) => ({
      homedir: opts.homedir || os.tmpdir(),
      userDataDir: opts.userDataDir || os.tmpdir(),
    }),
    isTestEnvironment: isTestEnvFn,
    fetchGogV1Json: async () => null,
    findGogdlBinary: () => 'gogdl',
    ensureGogdlAuthConfig: async () => ({ authenticated: false }),
    resolveEpicAppAndPlatforms: () => null,
    ensureLegendaryConfigAndAuth: async () => ({ authenticated: false }),
    getLegendaryConfigDir: (opts: RunnerOptionsBag = {}) => opts.legendaryConfigDir || '',
    collectLocalEpicMetadataAndSupport: () => ({ configDirs: [] }),
    findLegendaryBinary: () => 'legendary',
  });
}

function createCrossOverBottleFixture(rootDir: string, bottleName: string) {
  const bottlePath = path.join(rootDir, 'Bottles', bottleName);
  const docsDir = path.join(bottlePath, 'drive_c', 'users', 'crossover', 'Documents');
  const localAppData = path.join(bottlePath, 'drive_c', 'users', 'crossover', 'AppData', 'Local');
  const savedGames = path.join(bottlePath, 'drive_c', 'users', 'crossover', 'Saved Games');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(savedGames, { recursive: true });
  fs.writeFileSync(
    path.join(bottlePath, 'user.reg'),
    [
      'WINE REGISTRY Version 2',
      '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders]',
      '"Personal"="C:\\\\users\\\\crossover\\\\Documents"',
      '"Local AppData"="C:\\\\users\\\\crossover\\\\AppData\\\\Local"',
      '"AppData"="C:\\\\users\\\\crossover\\\\AppData\\\\Roaming"',
      '"{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}"="C:\\\\users\\\\crossover\\\\Saved Games"',
    ].join('\n'),
    'utf8'
  );
  return { bottlePath, docsDir, localAppData, savedGames };
}

describe('Phase 2 W4: Steam, GOG, Epic & Xbox Cloud Save Engines', () => {
  let tmpRoot = '';
  let userDataDir = '';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-p2-w4-'));
    userDataDir = path.join(tmpRoot, 'userData');
    fs.mkdirSync(userDataDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  // =========================================================================
  // Suite 1: Steam Cold-Start & Post-Exit Cloud State Machine
  // =========================================================================
  describe('Suite 1: Steam Cold-Start & Post-Exit Cloud State Machine', () => {
    it('1.1 excludes ", but not attempting now" in cold-start eval while still blocking real queued downloads', async () => {
      const steamRoot = path.join(tmpRoot, 'Steam');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const cloudLog = path.join(logsDir, 'cloud_log.txt');

      fs.writeFileSync(
        cloudLog,
        [
          '[2026-11-21 10:00:00] [AppID 9001] Starting sync (eval,)',
          "[2026-11-21 10:00:00] [AppID 9001] Need to sync from local change number '0' to global change number '45' (full), but not attempting now",
          '[2026-11-21 10:00:00] [AppID 9001] Eval complete',
          '[2026-11-21 10:00:01] OnRemoteStorageSyncedClient() - result OK',
          '',
        ].join('\n'),
        'utf8'
      );

      const runner = createMockSteamRunner(() => true);
      const t0 = Date.now();
      const nonDeadlockRes = await runner.waitForSteamColdStartupCloudReady(steamRoot, '9001', {
        enableTwoStageSteamColdStart: true,
        preBootLogOffset: 0,
        steamRootStrict: true,
        settleAfterClientSyncMs: 20,
        pollIntervalMs: 15,
        maxStartupCloudWaitMs: 3000,
      });
      expect(nonDeadlockRes.ready).toBe(true);
      expect(nonDeadlockRes.reason).toBe('startup_cloud_synced');
      expect(Date.now() - t0).toBeLessThan(1500);

      // Real queued download (WITHOUT ", but not attempting now") MUST wait for Download complete
      fs.writeFileSync(
        cloudLog,
        [
          "[2026-11-21 10:01:00] [AppID 9002] Need to sync from local change number '0' to global change number '46' (full)",
          '[2026-11-21 10:01:00] OnRemoteStorageSyncedClient() - result OK',
          '',
        ].join('\n'),
        'utf8'
      );

      setTimeout(() => {
        fs.appendFileSync(
          cloudLog,
          '[2026-11-21 10:01:01] [AppID 9002] Download complete\n',
          'utf8'
        );
      }, 60);

      const queuedRes = await runner.waitForSteamColdStartupCloudReady(steamRoot, '9002', {
        enableTwoStageSteamColdStart: true,
        preBootLogOffset: 0,
        steamRootStrict: true,
        settleAfterClientSyncMs: 20,
        pollIntervalMs: 15,
        maxStartupCloudWaitMs: 2000,
      });
      expect(queuedRes.ready).toBe(true);
      expect(queuedRes.waitedMs).toBeGreaterThanOrEqual(45);
    });

    it('1.2 extends deadline via bootstrap_log.txt self-update activity and invokes onStatusUpdate once', async () => {
      const steamRoot = path.join(tmpRoot, 'SteamSelfUpdate');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const cloudLog = path.join(logsDir, 'cloud_log.txt');
      const bootLog = path.join(logsDir, 'bootstrap_log.txt');
      fs.writeFileSync(cloudLog, '', 'utf8');
      fs.writeFileSync(bootLog, '[2026-11-21 09:00:00] Previous startup\n', 'utf8');

      const statusMessages: string[] = [];
      const runner = createMockSteamRunner(() => true);

      setTimeout(() => {
        fs.appendFileSync(bootLog, '[2026-11-21 10:00:00] Downloading update (12800 KB)...\n', 'utf8');
      }, 25);
      setTimeout(() => {
        fs.appendFileSync(bootLog, '[2026-11-21 10:00:01] Extracting package...\n', 'utf8');
      }, 90);
      setTimeout(() => {
        fs.appendFileSync(
          cloudLog,
          '[2026-11-21 10:00:02] OnRemoteStorageSyncedClient() - result OK\n',
          'utf8'
        );
      }, 170);

      const res = await runner.waitForSteamColdStartupCloudReady(steamRoot, '9003', {
        enableTwoStageSteamColdStart: true,
        enableSelfUpdateExtensionInTest: true,
        isBottleSteam: true,
        steamRootStrict: true,
        maxStartupCloudWaitMs: 90,
        maxSelfUpdateWaitMs: 1500,
        settleAfterClientSyncMs: 20,
        pollIntervalMs: 15,
        onStatusUpdate: (msg: string) => statusMessages.push(msg),
      });

      expect(res.ready).toBe(true);
      expect(res.reason).toBe('startup_cloud_synced');
      expect(res.waitedMs).toBeGreaterThanOrEqual(150);
      expect(statusMessages).toEqual(['Updating Steam client...']);
    });

    it('1.3 honors isSteamAliveFn early exit after grace while ignoring bootstrap_log.txt restart within 8s', async () => {
      const steamRoot = path.join(tmpRoot, 'SteamAlive');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const cloudLog = path.join(logsDir, 'cloud_log.txt');
      const bootLog = path.join(logsDir, 'bootstrap_log.txt');
      fs.writeFileSync(cloudLog, '', 'utf8');
      fs.writeFileSync(bootLog, 'initial\n', 'utf8');

      const runner = createMockSteamRunner(() => true);

      // Case A: Steam exits cleanly after liveness grace with NO bootstrap activity -> steam_exited_early
      const deadRes = await runner.waitForSteamColdStartupCloudReady(steamRoot, '9004', {
        enableTwoStageSteamColdStart: true,
        steamRootStrict: true,
        livenessGraceMs: 40,
        pollIntervalMs: 15,
        maxStartupCloudWaitMs: 2000,
        isSteamAliveFn: () => false,
      });
      expect(deadRes.ready).toBe(false);
      expect(deadRes.reason).toBe('steam_exited_early');
      expect(deadRes.waitedMs).toBeLessThan(800);

      // Case B: Steam briefly dies during self-update restart (bootstrap_log.txt grew within 8s) -> ignored!
      let aliveFlag = false;
      setTimeout(() => {
        fs.appendFileSync(bootLog, 'Installing update and restarting...\n', 'utf8');
      }, 15);
      setTimeout(() => {
        aliveFlag = true;
        fs.appendFileSync(cloudLog, 'OnRemoteStorageSyncedClient() - result OK\n', 'utf8');
      }, 100);

      const restartRes = await runner.waitForSteamColdStartupCloudReady(steamRoot, '9004', {
        enableTwoStageSteamColdStart: true,
        enableSelfUpdateExtensionInTest: true,
        steamRootStrict: true,
        livenessGraceMs: 30,
        selfUpdateRestartGraceMs: 8000,
        settleAfterClientSyncMs: 20,
        pollIntervalMs: 15,
        maxStartupCloudWaitMs: 2000,
        isSteamAliveFn: () => aliveFlag,
      });
      expect(restartRes.ready).toBe(true);
      expect(restartRes.reason).toBe('startup_cloud_synced');
    });

    it('1.4 post-exit sessionStartOffset returns 0ms immediately when exit upload already finished and enforces prod grace defaults', async () => {
      const steamRoot = path.join(tmpRoot, 'SteamPostExit');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const cloudLog = path.join(logsDir, 'cloud_log.txt');

      const priorSession = [
        '[2026-11-21 09:00:00] [AppID 9005] Starting sync (up,AC Exit,)',
        '[2026-11-21 09:00:01] [AppID 9005] Upload complete',
        '',
      ].join('\n');
      fs.writeFileSync(cloudLog, priorSession, 'utf8');
      const sessionStartOffset = fs.statSync(cloudLog).size;

      // Append eval-only ", but not attempting now" + fast AC Exit -> Nothing to sync
      fs.appendFileSync(
        cloudLog,
        [
          "[2026-11-21 10:00:00] [AppID 9005] Need to sync from local change number '1' to global change number '2' (full), but not attempting now",
          '[2026-11-21 10:00:00] [AppID 9005] Eval complete',
          '[2026-11-21 10:05:00] [AppID 9005] Starting sync (up,AC Exit,)',
          '[2026-11-21 10:05:00] [AppID 9005] Nothing to sync',
          '',
        ].join('\n'),
        'utf8'
      );

      const prodRunner = createMockSteamRunner(() => false);
      const instantRes = await prodRunner.waitForSteamCloudSyncCompletion(steamRoot, '9005', {
        mode: 'post_exit',
        isBottleSteam: true,
        steamRootStrict: true,
        sessionStartOffset,
      });
      expect(instantRes.completed).toBe(true);
      expect(instantRes.waitedMs).toBe(0);
      expect(instantRes.reason).toBe('cloud_sync_completed');

      // Fast direct bypass with wokeSteamByLauncher=false uses 0ms grace when inactive...
      const eofOffset = fs.statSync(cloudLog).size;
      const bypassIdleRes = await prodRunner.waitForSteamCloudSyncCompletion(steamRoot, '9005', {
        mode: 'post_exit',
        isFastDirectBypass: true,
        wokeSteamByLauncher: false,
        steamRootStrict: true,
        sessionStartOffset: eofOffset,
      });
      expect(bypassIdleRes.completed).toBe(true);
      expect(bypassIdleRes.waitedMs).toBe(0);
      expect(bypassIdleRes.reason).toBe('no_active_cloud_job');

      // ...but STILL awaits an already-active upload (preserving wave1LaunchRuntimeAndCloudSync:1721)!
      fs.appendFileSync(
        cloudLog,
        '[2026-11-21 10:06:00] [AppID 9005] Starting sync (up,AC Exit,)\n',
        'utf8'
      );
      setTimeout(() => {
        fs.appendFileSync(cloudLog, '[2026-11-21 10:06:01] [AppID 9005] Upload complete\n', 'utf8');
      }, 50);
      const bypassActiveRes = await prodRunner.waitForSteamCloudSyncCompletion(steamRoot, '9005', {
        mode: 'post_exit',
        isFastDirectBypass: true,
        wokeSteamByLauncher: false,
        steamRootStrict: true,
        sessionStartOffset: eofOffset,
        pollIntervalMs: 15,
        maxCloudWaitMs: 2000,
      });
      expect(bypassActiveRes.completed).toBe(true);
      expect(bypassActiveRes.reason).toBe('cloud_sync_completed');
      expect(bypassActiveRes.waitedMs).toBeGreaterThanOrEqual(35);

      // Bottle Steam prod default grace (6000ms) exits early as soon as AC Exit completes
      const eofOffset2 = fs.statSync(cloudLog).size;
      setTimeout(() => {
        fs.appendFileSync(
          cloudLog,
          [
            '[2026-11-21 10:07:00] [AppID 9005] Starting sync (up,AC Exit,)',
            '[2026-11-21 10:07:00] [AppID 9005] 0 files to upload',
            '',
          ].join('\n'),
          'utf8'
        );
      }, 60);
      const bottleGraceEarlyRes = await prodRunner.waitForSteamCloudSyncCompletion(
        steamRoot,
        '9005',
        {
          mode: 'post_exit',
          isBottleSteam: true,
          steamRootStrict: true,
          sessionStartOffset: eofOffset2,
          pollIntervalMs: 20,
        }
      );
      expect(bottleGraceEarlyRes.completed).toBe(true);
      expect(bottleGraceEarlyRes.reason).toBe('cloud_sync_completed');
      expect(bottleGraceEarlyRes.waitedMs).toBeLessThan(1500);
    });

    it('1.5 P1-1: completed AC Launch upload after sessionStartOffset does NOT skip postExitGraceMs before AC Exit starts', async () => {
      const steamRoot = path.join(tmpRoot, 'SteamAcLaunchUpload');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const cloudLog = path.join(logsDir, 'cloud_log.txt');

      fs.writeFileSync(cloudLog, '[2026-11-21 09:50:00] Prior session log\n', 'utf8');
      const sessionStartOffset = fs.statSync(cloudLog).size;

      // Simulate a launch-time AutoCloud upload (AC Launch) + completion occurring AFTER sessionStartOffset
      fs.appendFileSync(
        cloudLog,
        [
          '[2026-11-21 10:00:00] [AppID 9006] Starting sync (init,AC Launch,up,down,)',
          "[2026-11-21 10:00:00] [AppID 9006] Need to upload file 'offline.sav'",
          '[2026-11-21 10:00:00] [AppID 9006] HTTP upload for file "offline.sav" beginning',
          '[2026-11-21 10:00:01] [AppID 9006] Upload complete',
          '[2026-11-21 10:00:01] [AppID 9006] Sync complete',
          '',
        ].join('\n'),
        'utf8'
      );

      // Simulate genuine post-exit AC Exit upload starting 80ms after post-exit wait begins, finishing at 160ms
      let acExitCompleted = false;
      setTimeout(() => {
        fs.appendFileSync(
          cloudLog,
          '[2026-11-21 10:30:00] [AppID 9006] Starting sync (up,AC Exit,)\n' +
            '[2026-11-21 10:30:00] [AppID 9006] HTTP upload for file "new_save.sav" beginning\n',
          'utf8'
        );
      }, 80);
      setTimeout(() => {
        acExitCompleted = true;
        fs.appendFileSync(
          cloudLog,
          '[2026-11-21 10:30:01] [AppID 9006] Upload complete\n',
          'utf8'
        );
      }, 160);

      const prodRunner = createMockSteamRunner(() => false);
      const res = await prodRunner.waitForSteamCloudSyncCompletion(steamRoot, '9006', {
        mode: 'post_exit',
        isBottleSteam: true,
        steamRootStrict: true,
        sessionStartOffset,
        postExitGraceMs: 600,
        pollIntervalMs: 20,
        maxCloudWaitMs: 2500,
      });

      expect(acExitCompleted).toBe(true);
      expect(res.completed).toBe(true);
      expect(res.reason).toBe('cloud_sync_completed');
      expect(res.waitedMs).toBeGreaterThanOrEqual(140);
    });
  });

  // =========================================================================
  // Suite 2: GOG Cloud Runner, Scanner & Save Paths
  // =========================================================================
  describe('Suite 2: GOG Cloud Runner, Scanner & Save Path Isolation', () => {
    it('2.1 scopes bottle timestamps with single-claimant legacy migration, shared <?INSTALL?> scope, and empty-dir pre-launch safety', async () => {
      const bottleA = createCrossOverBottleFixture(tmpRoot, 'OneLauncher');
      const bottleB = createCrossOverBottleFixture(tmpRoot, 'OneLauncher-arm64');
      const sharedInstallDir = path.join(tmpRoot, 'SharedGogGame');
      const sharedSavesDir = path.join(sharedInstallDir, 'saves');
      const bottleASaveDir = path.join(bottleA.docsDir, 'MyGogRpg');
      const bottleBSaveDir = path.join(bottleB.docsDir, 'MyGogRpg');
      fs.mkdirSync(sharedSavesDir, { recursive: true });
      fs.mkdirSync(bottleASaveDir, { recursive: true });
      fs.mkdirSync(bottleBSaveDir, { recursive: true });
      fs.writeFileSync(path.join(sharedSavesDir, 'shared.sav'), 'shared-data', 'utf8');
      fs.writeFileSync(path.join(bottleASaveDir, 'slot1.sav'), 'bottle-a-save', 'utf8');

      // Seed legacy unscoped key from pre-Phase-2 schema
      const tsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
      fs.writeFileSync(
        tsPath,
        JSON.stringify(
          {
            gog: {
              '1453370001:windows:docs': 1700000100,
              '1453370001:windows:inst': 1700000200,
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const remoteConfigOverride = {
        content: {
          Windows: {
            cloudStorage: {
              enabled: true,
              locations: [
                { name: 'docs', location: '<?DOCUMENTS?>/MyGogRpg' },
                { name: 'inst', location: '<?INSTALL?>/saves' },
              ],
            },
          },
        },
      };
      const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
      fs.writeFileSync(gogAuthPath, '{}', 'utf8');

      const seenTsByCall: Array<{ name: string; ts: string }> = [];
      const execFileImpl = vi.fn(
        (
          _cmd: string,
          args: string[],
          _opts: ExecFileOptionsOrCallback,
          cb?: ExecFileCallback
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          const nameIdx = args.indexOf('--name');
          const tsIdx = args.indexOf('--ts');
          seenTsByCall.push({
            name: nameIdx >= 0 ? args[nameIdx + 1] : '__default',
            ts: tsIdx >= 0 ? args[tsIdx + 1] : '',
          });
          callback?.(null, '1700000999\n', '');
        }
      );

      const runner = createMockSteamRunner(() => true);

      // 1. Bottle A (populated) inherits legacy key once & claims gogLegacyMigrated
      const resA = await runner.syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: '1453370001',
          clientId: 'client_gog_9001',
          installPath: sharedInstallDir,
        },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: bottleA.bottlePath,
          userDataDir,
          homedir: tmpRoot,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: remoteConfigOverride,
          execFileImpl,
        }
      );
      expect(resA.synced).toBe(true);
      expect(seenTsByCall).toEqual([
        { name: 'docs', ts: '1700000100' },
        { name: 'inst', ts: '1700000200' },
      ]);

      const tsAfterA = JSON.parse(fs.readFileSync(tsPath, 'utf8'));
      const scopeA = gogAndEpicRunnerMod.computeWinePrefixBottleScope(bottleA.bottlePath);
      const scopeB = gogAndEpicRunnerMod.computeWinePrefixBottleScope(bottleB.bottlePath);
      expect(scopeA).not.toBe(scopeB);
      expect(tsAfterA.gog[`1453370001:windows:${scopeA}:docs`]).toBe(1700000999);
      expect(tsAfterA.gog['1453370001:windows:install:inst']).toBe(1700000999);
      expect(tsAfterA.gog['1453370001:windows:docs']).toBe(1700000100); // intact for downgrade safety
      expect(tsAfterA.gogLegacyMigrated['1453370001:windows:docs']).toBe(scopeA);

      // 2. Bottle B (even with a local file!) MUST NOT inherit Bottle A's claimed legacy key -> --ts 0
      //    while <?INSTALL?> shares 'install' scope (1700000999)!
      fs.writeFileSync(path.join(bottleBSaveDir, 'other.sav'), 'b-file', 'utf8');
      seenTsByCall.length = 0;
      const resB = await runner.syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: '1453370001',
          clientId: 'client_gog_9001',
          installPath: sharedInstallDir,
        },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: bottleB.bottlePath,
          userDataDir,
          homedir: tmpRoot,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: remoteConfigOverride,
          execFileImpl,
        }
      );
      expect(resB.synced).toBe(true);
      expect(seenTsByCall).toEqual([
        { name: 'docs', ts: '0' },
        { name: 'inst', ts: '1700000999' },
      ]);

      // 3. Empty-dir pre-launch safety: even with stored scoped ts=1700000999, wiping Bottle A's dir forces --ts 0!
      fs.unlinkSync(path.join(bottleASaveDir, 'slot1.sav'));
      fs.writeFileSync(path.join(bottleASaveDir, '.DS_Store'), 'junk', 'utf8');
      seenTsByCall.length = 0;
      const resWipedA = await runner.syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: '1453370001',
          clientId: 'client_gog_9001',
          installPath: sharedInstallDir,
        },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: bottleA.bottlePath,
          userDataDir,
          homedir: tmpRoot,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: remoteConfigOverride,
          execFileImpl,
        }
      );
      expect(resWipedA.synced).toBe(true);
      expect(seenTsByCall[0]).toEqual({ name: 'docs', ts: '0' });
    });

    it('2.2 propagates clientId/gogClientId in scanner, discovers nested 1-level .info for <?INSTALL?>, blocks missing winePrefix, and retries post-exit FileNotFoundError once', async () => {
      // 1. Scanner propagates clientId & gogClientId (both sync & async scan)
      const gogRoot = path.join(tmpRoot, 'Games', 'OneLauncher', 'GOG');
      const scannedGameDir = path.join(gogRoot, 'NestedTitle');
      const nestedSubDir = path.join(scannedGameDir, 'game');
      fs.mkdirSync(nestedSubDir, { recursive: true });
      fs.writeFileSync(path.join(nestedSubDir, 'play.exe'), 'MZ', 'utf8');
      fs.writeFileSync(
        path.join(nestedSubDir, 'goggame-1453370002.info'),
        JSON.stringify({
          gameId: '1453370002',
          clientId: 'nested_client_42',
          name: 'Nested GOG Title',
          playTasks: [{ path: 'play.exe', isPrimary: true }],
        }),
        'utf8'
      );

      const scanRes = await installedGameScanner.scanAllInstalledGamesAsync({
        platform: 'darwin',
        homedir: tmpRoot,
        userDataDir,
        appsDirs: [path.join(tmpRoot, 'Applications')],
      });
      const scannedRecord = (scanRes.installedGames || []).find(
        (g: ScannedGameLike) => g.platformId === 'gog' && String(g.platformGameId) === '1453370002'
      );
      expect(scannedRecord).toBeTruthy();
      expect(scannedRecord.clientId).toBe('nested_client_42');
      expect(scannedRecord.gogClientId).toBe('nested_client_42');

      // 2. Fail-closed resolveGogCloudSaveLocations when useCompatLayer=true && !winePrefix
      const blockedLocs = cloudSaveEngine.resolveGogCloudSaveLocations(
        [{ name: 'docs', location: '<?DOCUMENTS?>/ShouldNeverHitHostMac' }],
        { platform: 'darwin', useCompatLayer: true, homedir: tmpRoot }
      );
      expect(blockedLocs).toEqual([]);

      // 3. Nested 1-level .info discovery sets effectiveInstallPath to nestedSubDir (ignoring symlinks!)
      const fakeSymlinkTarget = path.join(tmpRoot, 'outside_symlink_target');
      fs.mkdirSync(fakeSymlinkTarget, { recursive: true });
      fs.writeFileSync(
        path.join(fakeSymlinkTarget, 'goggame-1453370002.info'),
        JSON.stringify({ clientId: 'symlink_should_be_ignored' }),
        'utf8'
      );
      fs.symlinkSync(fakeSymlinkTarget, path.join(scannedGameDir, 'aaa_symlink_dir'));

      const nestedSaveDir = path.join(nestedSubDir, 'userdata');
      fs.mkdirSync(nestedSaveDir, { recursive: true });
      fs.writeFileSync(path.join(nestedSaveDir, 'progress.sav'), 'save-bytes', 'utf8');
      const gogAuthPath = path.join(userDataDir, 'gog_auth.json');
      fs.writeFileSync(gogAuthPath, '{}', 'utf8');

      // 4. Post-exit FileNotFoundError triggers 1x retry after re-purging OS junk
      let attempts = 0;
      const execFileRetry = vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: ExecFileOptionsOrCallback,
          cb?: ExecFileCallback
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          attempts += 1;
          if (attempts === 1) {
            fs.writeFileSync(path.join(nestedSaveDir, '.DS_Store'), 'transient-junk', 'utf8');
            callback?.(
              new Error('exit 1'),
              '',
              "FileNotFoundError: [Errno 2] No such file or directory: '.DS_Store'"
            );
            return;
          }
          callback?.(null, '1700001234\n', '');
        }
      );

      const runner = createMockSteamRunner(() => true);
      const postRes = await runner.syncGogCloudSaves(
        {
          platformId: 'gog',
          platformGameId: '1453370002',
          installPath: scannedGameDir,
        },
        'post_exit',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir: tmpRoot,
          userDataDir,
          gogdlBinaryPath: 'gogdl',
          gogAuthConfigPath: gogAuthPath,
          gogRemoteConfigOverride: {
            content: {
              MacOS: {
                cloudStorage: {
                  enabled: true,
                  locations: [{ name: 'inst', location: '<?INSTALL?>/userdata' }],
                },
              },
            },
          },
          execFileImpl: execFileRetry,
        }
      );

      expect(postRes.synced).toBe(true);
      expect(postRes.clientId).toBe('nested_client_42');
      expect(postRes.locations[0].resolvedPath).toBe(nestedSaveDir);
      expect(attempts).toBe(2);
      expect(fs.existsSync(path.join(nestedSaveDir, '.DS_Store'))).toBe(false);
    });
  });

  // =========================================================================
  // Suite 3: Epic Backup Filtering, Fail-Closed --save-path & Per-Bottle Watermark
  // =========================================================================
  describe('Suite 3: Epic CloudIncludeList/ExcludeList, {InstallDir} Guard & Cross-Bottle Sync', () => {
    it('3.1 createEpicCloudFileFilter handles globs accurately, is ReDoS-safe, and filters metadata purge + bounded copy without creating empty dirs', async () => {
      const filter = gogAndEpicRunnerMod.createEpicCloudFileFilter(
        ['Profile.dat', 'saves/**/*.sav', 'slot?.bin'],
        ['saves/temp/**', '*.bak'],
        true
      );
      expect(filter('Profile.dat')).toBe(true);
      expect(filter('sub/PROFILE.DAT')).toBe(true);
      expect(filter('saves/slot1.sav')).toBe(true);
      expect(filter('saves/a/b/slot2.sav')).toBe(true);
      expect(filter('saves/temp/x.sav')).toBe(false);
      expect(filter('slot1.bin')).toBe(true);
      expect(filter('slot10.bin')).toBe(false);
      expect(filter('Game.exe')).toBe(false);

      // Adversarial ReDoS pattern completes in linear time (< 100ms)
      const evilFilter = gogAndEpicRunnerMod.createEpicCloudFileFilter(
        ['**/**/**/**/**/**/**/**/**/**/**/**/**x'],
        [],
        true
      );
      const t0 = Date.now();
      expect(evilFilter('a/'.repeat(2000) + 'y')).toBe(false);
      expect(Date.now() - t0).toBeLessThan(150);

      // Verify purgeOsMetadataAndCountRealFilesAsync + copyRealDirBoundedAsync + rolling backup honor fileFilter
      const installDir = path.join(tmpRoot, 'EpicFilteredGame');
      const assetsDir = path.join(installDir, 'assets', 'textures');
      const savesDir = path.join(installDir, 'saves');
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.mkdirSync(savesDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'Profile.dat'), 'profile-bytes', 'utf8');
      fs.writeFileSync(path.join(installDir, '.DS_Store'), 'root-junk', 'utf8');
      fs.writeFileSync(path.join(assetsDir, '.DS_Store'), 'asset-junk', 'utf8');
      fs.writeFileSync(path.join(assetsDir, 'big_asset.pak'), Buffer.alloc(64 * 1024, 0x41));
      fs.writeFileSync(path.join(savesDir, '.DS_Store'), 'save-junk', 'utf8');
      fs.writeFileSync(path.join(savesDir, 'run1.sav'), 'save-data', 'utf8');

      const hygiene = await cloudSaveEngine.purgeOsMetadataAndCountRealFilesAsync(installDir, {
        fileFilter: filter,
      });
      expect(hygiene.realFileCount).toBe(2); // Profile.dat + saves/run1.sav
      expect(hygiene.purgedCount).toBe(0); // .DS_Store files outside *.sav/Profile.dat are untouched
      expect(fs.existsSync(path.join(installDir, '.DS_Store'))).toBe(true);
      expect(fs.existsSync(path.join(assetsDir, '.DS_Store'))).toBe(true);
      expect(fs.existsSync(path.join(savesDir, '.DS_Store'))).toBe(true);

      // With `saves/**` include pattern, ONLY saves/.DS_Store is purged while root & assets/.DS_Store remain untouched!
      const savesSubtreeFilter = gogAndEpicRunnerMod.createEpicCloudFileFilter(['saves/**'], [], true);
      const subtreeHygiene = await cloudSaveEngine.purgeOsMetadataAndCountRealFilesAsync(installDir, {
        fileFilter: savesSubtreeFilter,
      });
      expect(subtreeHygiene.realFileCount).toBe(1);
      expect(subtreeHygiene.purgedCount).toBe(1);
      expect(fs.existsSync(path.join(savesDir, '.DS_Store'))).toBe(false);
      expect(fs.existsSync(path.join(installDir, '.DS_Store'))).toBe(true);
      expect(fs.existsSync(path.join(assetsDir, '.DS_Store'))).toBe(true);

      // Copy with maxBytes smaller than big_asset.pak succeeds because big_asset.pak is excluded,
      // and empty assets/ directory is NEVER created in destination!
      const destDir = path.join(tmpRoot, 'FilteredCopyDest');
      const copyRes = await boundedCopyUtils.copyRealDirBoundedAsync(installDir, destDir, 4096, {
        requireNonEmpty: true,
        fileFilter: filter,
      });
      expect(copyRes.copied).toBe(true);
      expect(copyRes.fileCount).toBe(2);
      expect(fs.existsSync(path.join(destDir, 'Profile.dat'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'saves', 'run1.sav'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'assets'))).toBe(false);
    });

    it('3.2 enforces {InstallDir} guard, fail-closed --save-path on CrossOver, and per-bottle watermark + --force-download on empty cross-bottle switch', async () => {
      const bottleA = createCrossOverBottleFixture(tmpRoot, 'EpicBottleA');
      const bottleB = createCrossOverBottleFixture(tmpRoot, 'EpicBottleB');
      const legCfgDir = path.join(tmpRoot, 'legendaryCfg');
      fs.mkdirSync(path.join(legCfgDir, 'metadata'), { recursive: true });
      fs.writeFileSync(
        path.join(legCfgDir, 'user.json'),
        JSON.stringify({ account_id: '00000000000000000000000000000042' }),
        'utf8'
      );

      const recordedArgs: string[][] = [];
      const execFileImpl = vi.fn(
        (
          _cmd: string,
          args: string[],
          _opts: ExecFileOptionsOrCallback,
          cb?: ExecFileCallback
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          recordedArgs.push(args);
          callback?.(null, 'Sync complete', '');
        }
      );
      const runner = createMockSteamRunner(() => true);

      // A. {InstallDir} WITHOUT CloudIncludeList -> skips rolling backup & full-tree purge
      const installDirNoInc = path.join(tmpRoot, 'EpicInstallNoInc');
      fs.mkdirSync(installDirNoInc, { recursive: true });
      fs.writeFileSync(path.join(installDirNoInc, 'game.bin'), Buffer.alloc(8192, 0x55));
      fs.writeFileSync(path.join(installDirNoInc, '.DS_Store'), 'untouched', 'utf8');
      fs.writeFileSync(
        path.join(legCfgDir, 'metadata', 'NoIncApp.json'),
        JSON.stringify({
          metadata: { customAttributes: { CloudSaveFolder: { value: '{InstallDir}' } } },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(legCfgDir, 'installed.json'),
        JSON.stringify({ NoIncApp: { app_name: 'NoIncApp', install_path: installDirNoInc } }),
        'utf8'
      );

      const noIncRes = await runner.syncEpicCloudSaves(
        { appName: 'NoIncApp', installPath: installDirNoInc },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir: tmpRoot,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          execFileImpl,
        }
      );
      expect(noIncRes.synced).toBe(true);
      expect(noIncRes.backupPath).toBeUndefined();
      expect(noIncRes.backupSkippedReason).toBe('install_dir_without_include_list_skipped');
      expect(fs.existsSync(path.join(installDirNoInc, '.DS_Store'))).toBe(true);

      // B. {InstallDir} WITH CloudIncludeList: Profile.dat -> backs up ONLY Profile.dat!
      const installDirWithInc = path.join(tmpRoot, 'EpicCaveGame');
      fs.mkdirSync(path.join(installDirWithInc, 'data'), { recursive: true });
      fs.writeFileSync(path.join(installDirWithInc, 'Profile.dat'), 'hero-profile', 'utf8');
      fs.writeFileSync(path.join(installDirWithInc, 'data', 'huge.pak'), Buffer.alloc(32768, 0x33));
      fs.writeFileSync(
        path.join(legCfgDir, 'metadata', 'CaveApp.json'),
        JSON.stringify({
          metadata: {
            customAttributes: {
              CloudSaveFolder: { value: '{InstallDir}' },
              CloudIncludeList: { value: 'Profile.dat' },
            },
          },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(legCfgDir, 'installed.json'),
        JSON.stringify({
          NoIncApp: { app_name: 'NoIncApp', install_path: installDirNoInc },
          CaveApp: { app_name: 'CaveApp', install_path: installDirWithInc },
          BottleSwitchApp: {
            app_name: 'BottleSwitchApp',
            install_path: installDirWithInc,
            save_path: path.join(bottleA.localAppData, 'SwitchGame', 'Saves'),
            save_timestamp: 1700005555,
          },
        }),
        'utf8'
      );

      const withIncRes = await runner.syncEpicCloudSaves(
        { appName: 'CaveApp', installPath: installDirWithInc },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir: tmpRoot,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          maxBackupBytes: 4096,
          execFileImpl,
        }
      );
      expect(withIncRes.synced).toBe(true);
      expect(typeof withIncRes.backupPath).toBe('string');
      expect(fs.existsSync(path.join(withIncRes.backupPath, 'Profile.dat'))).toBe(true);
      expect(fs.existsSync(path.join(withIncRes.backupPath, 'data'))).toBe(false);

      // B2. P2-6: explicit cloudSaveFolderTemplate + cloudExcludeList (without cloudIncludeList) STILL loads CloudIncludeList from metadata!
      const withPartialFilterRes = await runner.syncEpicCloudSaves(
        { appName: 'CaveApp', installPath: installDirWithInc },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: false,
          homedir: tmpRoot,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          cloudSaveFolderTemplate: '{InstallDir}',
          cloudExcludeList: ['*.tmp'],
          maxBackupBytes: 4096,
          execFileImpl,
        }
      );
      expect(withPartialFilterRes.synced).toBe(true);
      expect(typeof withPartialFilterRes.backupPath).toBe('string');
      expect(fs.existsSync(path.join(withPartialFilterRes.backupPath, 'Profile.dat'))).toBe(true);
      expect(fs.existsSync(path.join(withPartialFilterRes.backupPath, 'data'))).toBe(false);

      // C. Fail-closed --save-path on CrossOver when winePrefix is missing -> NEVER invokes legendary
      recordedArgs.length = 0;
      const failClosedRes = await runner.syncEpicCloudSaves(
        { appName: 'BottleSwitchApp' },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          homedir: tmpRoot,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          cloudSaveFolderTemplate: '{AppData}/SwitchGame/Saves',
          execFileImpl,
        }
      );
      expect(failClosedRes.synced).toBe(false);
      expect(failClosedRes.reason).toBe('unresolved_bottle_save_path');
      expect(recordedArgs).toHaveLength(0);

      // D. Cross-bottle pre_launch with empty Bottle B -> passes --force-download (NEVER --force-upload) & writes per-bottle watermark
      const switchEmptyRes = await runner.syncEpicCloudSaves(
        { appName: 'BottleSwitchApp' },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: bottleB.bottlePath,
          homedir: tmpRoot,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          cloudSaveFolderTemplate: '{AppData}/SwitchGame/Saves',
          execFileImpl,
        }
      );
      expect(switchEmptyRes.synced).toBe(true);
      expect(recordedArgs[0]).toContain('--force-download');
      expect(recordedArgs[0]).not.toContain('--force-upload');

      const tsJson = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json'), 'utf8')
      );
      const scopeB = gogAndEpicRunnerMod.computeWinePrefixBottleScope(bottleB.bottlePath);
      expect(tsJson.epic[`BottleSwitchApp:${scopeB}`]).toMatchObject({
        savePath: path.join(bottleB.localAppData, 'SwitchGame', 'Saves'),
        saveTimestamp: 1700005555,
      });

      // E. Cross-bottle pre_launch when Bottle B ALREADY has local files -> does NOT pass --force-download
      const bottleBSaves = path.join(bottleB.localAppData, 'SwitchGame', 'Saves');
      fs.mkdirSync(bottleBSaves, { recursive: true });
      fs.writeFileSync(path.join(bottleBSaves, 'local.sav'), 'existing', 'utf8');
      recordedArgs.length = 0;
      const switchPopulatedRes = await runner.syncEpicCloudSaves(
        { appName: 'BottleSwitchApp' },
        'pre_launch',
        {
          platform: 'darwin',
          useCompatLayer: true,
          winePrefix: bottleB.bottlePath,
          homedir: tmpRoot,
          userDataDir,
          legendaryConfigDir: legCfgDir,
          legendaryBinaryPath: 'legendary',
          skipAuthRefresh: true,
          cloudSaveFolderTemplate: '{AppData}/SwitchGame/Saves',
          execFileImpl,
        }
      );
      expect(switchPopulatedRes.synced).toBe(true);
      expect(recordedArgs[0]).not.toContain('--force-download');
      expect(recordedArgs[0]).not.toContain('--force-upload');
    });
  });

  // =========================================================================
  // Suite 4: Xbox PlayFab Isolation, Single Pre-Launch Sync, consumeHeldLock & Backup Cleanup
  // =========================================================================
  describe('Suite 4: Xbox PlayFab Isolation, Single Pre-Launch Sync, consumeHeldLock & Backup Cleanup', () => {
    it('4.1 excludes top-level PlayFabGameSaves across discover, export (prune & materialize), and sanitizePoisonedWgsContainersMap', async () => {
      const xuid = '2533274790000042';
      const scid = '00000000-0000-0000-0000-000000009001';
      const folderName = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, scid);
      const wgsUserDir = path.join(tmpRoot, 'SystemAppData', 'wgs', folderName);
      const xgsUserDir = path.join(tmpRoot, 'SystemAppData', 'xgs', folderName);
      fs.mkdirSync(path.join(xgsUserDir, 'PlayFabGameSaves', 'slot0'), { recursive: true });
      fs.mkdirSync(path.join(xgsUserDir, 'RealContainer'), { recursive: true });
      const pfFile = path.join(xgsUserDir, 'PlayFabGameSaves', 'slot0', 'pf.sav');
      fs.writeFileSync(pfFile, 'playfab-owned-save', 'utf8');
      fs.writeFileSync(path.join(xgsUserDir, 'RealContainer', 'data.bin'), 'xgs-save', 'utf8');

      // 1. discoverXgsContainersMetadataOnDisk ignores PlayFabGameSaves (case-insensitive)
      const discovered = await xgsMirroring.discoverXgsContainersMetadataOnDisk(xgsUserDir);
      expect(Array.from(discovered.keys())).toEqual(['RealContainer']);

      // 2. sanitizePoisonedWgsContainersMap strips PlayFabGameSaves from containersMap & pendingDeletionsSet
      const cMap = new Map<string, WgsContainerStub>([
        ['PlayFabGameSaves/slot0', { name: 'PlayFabGameSaves/slot0', blobs: new Map() }],
        ['playfabgamesaves/other', { name: 'playfabgamesaves/other', blobs: new Map() }],
        [`${folderName}/PlayFabGameSaves/nested`, { name: `${folderName}/PlayFabGameSaves/nested`, blobs: new Map() }],
        ['RealContainer', { name: 'RealContainer', blobs: new Map() }],
      ]);
      const pDel = new Set<string>(['PlayFabGameSaves/old', 'RealDeleted']);
      expect(xgsMirroring.sanitizePoisonedWgsContainersMap(cMap, pDel)).toBe(true);
      expect(Array.from(cMap.keys())).toEqual(['RealContainer']);
      expect(Array.from(pDel)).toEqual(['RealDeleted']);

      // 3. exportWgsToXgsFolder NEVER deletes PlayFabGameSaves on disk even if in remotelyPrunedContainerNames,
      //    and NEVER materializes poisoned PlayFabGameSaves containers from containers.index
      await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsUserDir, {
        containers: [
          {
            name: 'PlayFabGameSaves/poisoned',
            displayName: 'PlayFabGameSaves/poisoned',
            containerNum: 1,
            dirty: false,
            modifiedIso: '2026-11-21T10:00:00.000Z',
            blobs: [{ name: 'bad.bin', data: Buffer.from('bad', 'utf8') }],
          },
          {
            name: 'ValidCloudSlot',
            displayName: 'ValidCloudSlot',
            containerNum: 2,
            dirty: false,
            modifiedIso: '2026-11-21T10:00:00.000Z',
            blobs: [{ name: 'save.bin', data: Buffer.from('good', 'utf8') }],
          },
        ],
      });

      await xgsMirroring.exportWgsToXgsFolder(wgsUserDir, xgsUserDir, {
        cloudPulledContainerNames: new Set(['PlayFabGameSaves/poisoned', 'ValidCloudSlot']),
        remotelyPrunedContainerNames: new Set(['PlayFabGameSaves/slot0', 'PlayFabGameSaves']),
      });

      expect(fs.existsSync(pfFile)).toBe(true);
      expect(fs.readFileSync(pfFile, 'utf8')).toBe('playfab-owned-save');
      expect(fs.existsSync(path.join(xgsUserDir, 'PlayFabGameSaves', 'poisoned'))).toBe(false);
      expect(fs.existsSync(path.join(xgsUserDir, 'ValidCloudSlot', 'save.bin'))).toBe(true);
    });

    it('4.2 skips redundant pre_launch pull in loopback xgamesave.init within 30s and issues single DELETE /lock via consumeHeldLock', async () => {
      const xuid = '2533274790000042';
      const scid = '00000000-0000-0000-0000-000000009002';
      const pfn = 'SynthPub.SingleSync_8wekyb3d8bbwe';
      const bottle = createCrossOverBottleFixture(tmpRoot, 'XboxSingleSyncBottle');

      let listContainerCalls = 0;
      let acquireLockCalls = 0;
      const releaseLockUrls: string[] = [];

      const server = http.createServer((req, res) => {
        const reqUrl = decodeURIComponent(req.url || '/');
        req.resume();
        req.on('end', () => {
          if (reqUrl.includes('/lock') && req.method === 'PUT') {
            acquireLockCalls += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ quotaBytes: 128 * 1024 * 1024 }));
            return;
          }
          if (reqUrl.includes('/lock') && req.method === 'DELETE') {
            releaseLockUrls.push(reqUrl);
            res.writeHead(204);
            res.end();
            return;
          }
          if (reqUrl.includes('/scids/') && req.method === 'GET' && !reqUrl.includes(',binary')) {
            listContainerCalls += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blobs: [] }));
            return;
          }
          if (reqUrl.includes(',binary') && req.method === 'PUT') {
            res.writeHead(201);
            res.end();
            return;
          }
          if (reqUrl.includes(',savedgame') && req.method === 'PUT') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;

      const sendRpc = (
        loopPort: number,
        key: string,
        method: string,
        params: Record<string, unknown>
      ) =>
        new Promise<LoopbackRpcResponse>((resolve, reject) => {
          const sock = net.createConnection({ host: '127.0.0.1', port: loopPort }, () => {
            sock.write(
              xboxRuntimeLoopbackServer.encodeRpcFrame({ id: 1, key, method, params })
            );
          });
          let buf = Buffer.alloc(0);
          sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length >= 4) {
              const len = buf.readUInt32LE(0);
              if (buf.length >= 4 + len) {
                const resp = JSON.parse(
                  buf.subarray(4, 4 + len).toString('utf8')
                ) as LoopbackRpcResponse;
                sock.end();
                resolve(resp);
              }
            }
          });
          sock.on('error', reject);
        });

      const authProvider = {
        getUserProfile: async () => ({ xuid, gamertag: 'SynthPlayer' }),
        getTokenAndSignatureForUrl: async () => ({
          token: `XBL3.0 x=${xuid};mock_token`,
          signature: 'mock_sig',
        }),
      };

      try {
        // 1. Pre-launch sync returns quotaBytes, remainingQuotaBytes, resolvedScid, syncedAtMs
        const preSync = await cloudSaveEngine.syncXboxCloudSaves(
          { gameId: 'xbox-9P0000SYNTH2', packageFamilyName: pfn, scid },
          'pre_launch',
          {
            platform: 'darwin',
            useCompatLayer: true,
            winePrefix: bottle.bottlePath,
            localAppData: bottle.localAppData,
            userDataDir,
            xboxSession: { xuid, authorizationHeader: `XBL3.0 x=${xuid};mock_token` },
            titleStorageOrigin: origin,
          }
        );
        expect(preSync.synced).toBe(true);
        expect(preSync.resolvedScid).toBe(scid);
        expect(preSync.quotaBytes).toBe(128 * 1024 * 1024);
        expect(preSync.remainingQuotaBytes).toBe(128 * 1024 * 1024);
        expect(typeof preSync.syncedAtMs).toBe('number');
        expect(listContainerCalls).toBe(1);
        expect(acquireLockCalls).toBe(1);
        expect(releaseLockUrls).toHaveLength(1);

        // Reset counters before loopback session starts
        listContainerCalls = 0;
        acquireLockCalls = 0;
        releaseLockUrls.length = 0;

        const saveRootDir = path.join(bottle.localAppData, 'Packages', pfn, 'SystemAppData');
        const loopback = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
          authProvider,
          userProfile: { xuid, gamertag: 'SynthPlayer' },
          gameMetadata: { scid, packageFamilyName: pfn },
          saveRootDir,
          enableCloudSaveSync: true,
          initialPreLaunchSync: preSync,
          titleStorageOrigin: origin,
        });

        try {
          // 2. xgamesave.init within 30s skips redundant GET listContainers and acquires ONLY PUT /lock!
          const initResp = await sendRpc(loopback.port, loopback.sessionKey, 'xgamesave.init', {
            xuid,
            scid,
            packageFamilyName: pfn,
          });
          expect(initResp.ok).toBe(true);
          expect(initResp.result?.synced).toBe(true);
          expect(initResp.result?.quotaBytes).toBe(128 * 1024 * 1024);
          expect(listContainerCalls).toBe(0);
          expect(acquireLockCalls).toBe(1);

          // 3. In-session write marks hadWrites = true on held lock
          const folderName = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, scid);
          const xgsDir = path.join(saveRootDir, 'xgs', folderName, 'SlotA');
          fs.mkdirSync(xgsDir, { recursive: true });
          fs.writeFileSync(path.join(xgsDir, 'save.dat'), 'updated-progress', 'utf8');

          const commitResp = await sendRpc(
            loopback.port,
            loopback.sessionKey,
            'xgamesave.commit',
            { xuid, scid, packageFamilyName: pfn, waitForCloud: true }
          );
          expect(commitResp.ok).toBe(true);
          expect(acquireLockCalls).toBe(1); // Reused held lock!

          // 4. consumeHeldLock pops lock atomically (case-insensitive)
          const consumed = loopback.consumeHeldLock(scid.toUpperCase());
          expect(consumed).toEqual({
            lockHeld: true,
            hadWrites: true,
            xuid,
            resolvedScid: scid,
            pfn,
          });
          expect(loopback.consumeHeldLock(scid)).toBeNull();

          // 5. Post-exit sync reuses lock & releases EXACTLY ONE DELETE /lock?newSavesUploaded=true
          const postRes = await cloudSaveEngine.syncXboxCloudSaves(
            { gameId: 'xbox-9P0000SYNTH2', packageFamilyName: pfn, scid },
            'post_exit',
            {
              platform: 'darwin',
              useCompatLayer: true,
              winePrefix: bottle.bottlePath,
              localAppData: bottle.localAppData,
              userDataDir,
              xboxSession: { xuid, authorizationHeader: `XBL3.0 x=${xuid};mock_token` },
              titleStorageOrigin: origin,
              alreadyLocked: Boolean(consumed?.lockHeld),
              keepLockHeld: false,
              priorHadWrites: Boolean(consumed?.hadWrites),
            }
          );
          expect(postRes.synced).toBe(true);
          expect(acquireLockCalls).toBe(1); // No extra PUT /lock!
          expect(releaseLockUrls).toHaveLength(1);
          expect(releaseLockUrls[0]).toContain('newSavesUploaded=true');
        } finally {
          await loopback.close();
        }
        // close() MUST NOT emit a duplicate DELETE /lock after consumeHeldLock!
        expect(releaseLockUrls).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('4.3 cleanupGameBackups normalizes xbox-<id>, xbox_<id>, and payload.gameId variants cleanly', () => {
      const backupsRoot = path.join(userDataDir, 'cloud_save_backups');
      const dashSnap = path.join(backupsRoot, 'xbox', 'xbox-9P0000SYNTH4', 'snapshot_1001');
      const underSnap = path.join(backupsRoot, 'xbox', 'xbox_9P0000SYNTH4', 'snapshot_1002');
      const siblingSnap = path.join(backupsRoot, 'xbox', 'xbox-9P0000OTHER9', 'snapshot_1003');
      fs.mkdirSync(dashSnap, { recursive: true });
      fs.mkdirSync(underSnap, { recursive: true });
      fs.mkdirSync(siblingSnap, { recursive: true });
      fs.writeFileSync(path.join(dashSnap, 'a.bin'), 'dash-bytes', 'utf8');
      fs.writeFileSync(path.join(underSnap, 'b.bin'), 'under-bytes', 'utf8');
      fs.writeFileSync(path.join(siblingSnap, 'c.bin'), 'sibling-bytes', 'utf8');

      const res = cloudSaveEngine.cleanupGameBackups(
        {
          platformId: 'xbox',
          platformGameId: '9P0000SYNTH4',
          gameId: 'xbox-9P0000SYNTH4',
        },
        { userDataDir, keepLatest: 0 }
      );

      expect(res.cleaned).toBe(true);
      expect(res.removedBackups).toBe(2);
      expect(fs.existsSync(path.join(backupsRoot, 'xbox', 'xbox-9P0000SYNTH4'))).toBe(false);
      expect(fs.existsSync(path.join(backupsRoot, 'xbox', 'xbox_9P0000SYNTH4'))).toBe(false);
      expect(fs.existsSync(siblingSnap)).toBe(true);
    });

    it('4.4 P1-5 & P2-7: retryWithCandidateScid releases original SCID lock & retries fallback with alreadyLocked:false, and releaseXboxTitleStorageSessionLock supports 2-arg call', async () => {
      const xuid = '2533274790000042';
      const primaryScid = '00000000-0000-0000-0000-000000009011';
      const fallbackScid = '00000000-0000-0000-0000-000000009022';
      const requests: Array<{ method: string; url: string }> = [];

      const server = http.createServer((req, res) => {
        const reqUrl = decodeURIComponent(req.url || '/');
        requests.push({ method: req.method || 'GET', url: reqUrl });
        req.resume();
        req.on('end', () => {
          if (reqUrl.includes(primaryScid) && reqUrl.includes('/lock') && req.method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (reqUrl.includes(primaryScid) && req.method === 'GET') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 1005 }));
            return;
          }
          if (reqUrl.includes(fallbackScid) && reqUrl.includes('/lock') && req.method === 'PUT') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ quotaBytes: 64 * 1024 * 1024 }));
            return;
          }
          if (reqUrl.includes(fallbackScid) && reqUrl.includes('/lock') && req.method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (reqUrl.includes(fallbackScid) && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blobs: [] }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      const wgsDir = path.join(
        tmpRoot,
        'SystemAppData',
        'wgs',
        xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, primaryScid)
      );
      fs.mkdirSync(wgsDir, { recursive: true });

      try {
        // When alreadyLocked: true on primaryScid and listContainers hits 404 -> MUST release primaryScid lock,
        // then retry fallbackScid with alreadyLocked: false (issuing PUT /lock on fallbackScid, then DELETE /lock)!
        const syncRes = await xboxTitleStorageSync.syncXboxTitleStorage({
          mode: 'pre_launch',
          wgsUserDir: wgsDir,
          xuid,
          scid: primaryScid,
          fallbackScid,
          authorizationHeader: `XBL3.0 x=${xuid};mock_token`,
          titleStorageOrigin: origin,
          allowLoopbackOrigin: true,
          alreadyLocked: true,
          keepLockHeld: false,
        });

        expect(syncRes.synced).toBe(true);
        expect(syncRes.resolvedScid).toBe(fallbackScid);
        expect(
          requests.some((r) => r.method === 'DELETE' && r.url.includes(`${primaryScid}/lock`))
        ).toBe(true);
        expect(
          requests.some((r) => r.method === 'PUT' && r.url.includes(`${fallbackScid}/lock`))
        ).toBe(true);
        expect(
          requests.some((r) => r.method === 'DELETE' && r.url.includes(`${fallbackScid}/lock`))
        ).toBe(true);

        // Two-argument releaseXboxTitleStorageSessionLock(payload, options) cleanly releases consumed lock
        requests.length = 0;
        const released = await xboxTitleStorageSync.releaseXboxTitleStorageSessionLock(
          { scid: primaryScid, packageFamilyName: 'SynthPub.Release_8wekyb3d8bbwe' },
          {
            resolvedScid: fallbackScid,
            xuid,
            authorizationHeader: `XBL3.0 x=${xuid};mock_token`,
            titleStorageOrigin: origin,
            allowLoopbackOrigin: true,
            hadWrites: true,
          }
        );
        expect(released).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe('DELETE');
        expect(requests[0].url).toContain(`${fallbackScid}/lock`);
        expect(requests[0].url).toContain('newSavesUploaded=true');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
