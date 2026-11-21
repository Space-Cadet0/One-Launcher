import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const supervisor = require('../electron/launcher/sessionAndProcessSupervisor.cjs');
const storefrontLifecycle = require('../electron/launcher/supervisor/storefrontLifecycleAndCloudSync.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');
const bottleDisplayAndEnv = require('../electron/launcher/supervisor/bottleDisplayAndEnvController.cjs');
const xboxRuntimeLoopbackServer = require('../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs');
const xboxTitleStorageSync = require('../electron/storefronts/xbox/xboxTitleStorageSync.cjs');

async function sendLoopbackRpcCall(
  port: number,
  sessionKey: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1
): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const frame = xboxRuntimeLoopbackServer.encodeRpcFrame({
        id,
        key: sessionKey,
        method,
        params,
      });
      sock.write(frame);
    });
    const chunks: Buffer[] = [];
    let expectedBody = -1;
    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      if (expectedBody < 0 && total >= 4) {
        expectedBody = Buffer.concat(chunks, total).readUInt32LE(0);
      }
      if (expectedBody >= 0 && total >= 4 + expectedBody) {
        const full = Buffer.concat(chunks, total);
        const jsonStr = full.subarray(4, 4 + expectedBody).toString('utf8');
        sock.destroy();
        try {
          resolve(JSON.parse(jsonStr));
        } catch (err) {
          reject(err);
        }
      }
    });
    sock.on('error', reject);
  });
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ol-p2w3-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

describe('Phase 2 W3 — Session Finalizer, Cloud Barrier Handoff & Ordered Client/Prefix Shutdown', () => {
  beforeEach(() => {
    supervisor.resetSupervisorStateForTests();
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.inFlightPostSessionByGame.clear();
    engineStateRegistry.inFlightPostSessionByBottle.clear();
    engineStateRegistry.pendingBottleLaunches.clear();
    engineStateRegistry.pendingStorefrontLaunches.clear();
    engineStateRegistry.pendingEphemeralShutdowns.clear();
    engineStateRegistry.downloadQueueMap.clear();
    engineStateRegistry.pausedByInGameTaskIds.clear();
    engineStateRegistry.inFlightPostSessionPromises.clear();
  });

  afterEach(() => {
    supervisor.resetSupervisorStateForTests();
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.downloadQueueMap.clear();
    engineStateRegistry.pausedByInGameTaskIds.clear();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  describe('1. Native macOS steam_osx Process Isolation & Shutdown Hardening', () => {
    it('1.1 resolveSteamClientLaunchCommand on darwin ignores bottle steam.exe and matches only native steam_osx', async () => {
      const tmp = makeTempDir('mac-steam-detect');
      const macSteamBin = path.join(tmp, 'Steam.app', 'Contents', 'MacOS', 'steam_osx');
      fs.mkdirSync(path.dirname(macSteamBin), { recursive: true });
      fs.writeFileSync(macSteamBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const bottleSteamPs = [
        '/Users/tester/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steam.exe -silent',
        'C:\\Program Files (x86)\\Steam\\steam.exe -silent',
      ].join('\n');

      const withOnlyBottleSteam = await supervisor.resolveSteamClientLaunchCommand('620', [], {
        platform: 'darwin',
        userDataDir: tmp,
        steamClientBinaryPath: macSteamBin,
        mockProcessListOutput: bottleSteamPs,
        storefrontClientLifecycle: 'minimal_and_close_if_started',
      });
      expect(withOnlyBottleSteam.alreadyRunning).toBe(false);
      expect(withOnlyBottleSteam.useMinimalBinarySpawn).toBe(true);
      expect(withOnlyBottleSteam.wokeSteamByLauncher).toBe(true);

      const withNativeSteam = await supervisor.resolveSteamClientLaunchCommand('620', [], {
        platform: 'darwin',
        userDataDir: tmp,
        steamClientBinaryPath: macSteamBin,
        mockProcessListOutput: `${bottleSteamPs}\n/Applications/Steam.app/Contents/MacOS/steam_osx -silent\n`,
        storefrontClientLifecycle: 'minimal_and_close_if_started',
      });
      expect(withNativeSteam.alreadyRunning).toBe(true);
      expect(withNativeSteam.useMinimalBinarySpawn).toBe(false);
      expect(withNativeSteam.wokeSteamByLauncher).toBe(false);
    });

    it('1.2 darwin steam_osx -shutdown uses 15000ms timeout, polls clean exit before pkill, and falls back to pkill when stuck', async () => {
      const tmp = makeTempDir('mac-steam-shutdown');
      const macSteamBin = path.join(tmp, 'Steam.app', 'Contents', 'MacOS', 'steam_osx');
      fs.mkdirSync(path.dirname(macSteamBin), { recursive: true });
      fs.writeFileSync(macSteamBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // Case A: steam_osx exits on poll #2 -> returns steam_shutdown_flag with zero pkill
      const execCallsA: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
      let pollCountA = 0;
      const resClean = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'steam',
          wokeSteamByLauncher: true,
          steamClientBinaryPath: macSteamBin,
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'darwin',
          userDataDir: tmp,
          awaitHostSteamExitInTest: true,
          hostSteamExitWaitMs: 500,
          hostSteamExitPollIntervalMs: 20,
          getProcessListOutput: async () => {
            pollCountA += 1;
            return pollCountA < 2
              ? '/Applications/Steam.app/Contents/MacOS/steam_osx -silent\n'
              : 'C:\\Program Files (x86)\\Steam\\steam.exe\n';
          },
          execFileImpl: (cmd: string, args: string[], opts: any, cb: Function) => {
            execCallsA.push({ cmd, args, timeout: opts?.timeout });
            cb(null, '', '');
          },
        }
      );

      expect(resClean.closed).toBe(true);
      expect(resClean.method).toBe('steam_shutdown_flag');
      expect(pollCountA).toBe(2);
      expect(execCallsA).toHaveLength(1);
      expect(execCallsA[0]).toEqual({
        cmd: macSteamBin,
        args: ['-shutdown'],
        timeout: 15000,
      });

      // Case B: steam_osx remains running past hostSteamExitWaitMs -> falls back to pkill -TERM -x steam_osx
      const execCallsB: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
      const resFallback = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'steam',
          wokeSteamByLauncher: true,
          steamClientBinaryPath: macSteamBin,
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'darwin',
          userDataDir: tmp,
          awaitHostSteamExitInTest: true,
          hostSteamExitWaitMs: 60,
          hostSteamExitPollIntervalMs: 15,
          getProcessListOutput: async () =>
            '/Applications/Steam.app/Contents/MacOS/steam_osx -silent\n',
          execFileImpl: (cmd: string, args: string[], opts: any, cb: Function) => {
            execCallsB.push({ cmd, args, timeout: opts?.timeout });
            cb(null, '', '');
          },
        }
      );

      expect(resFallback.closed).toBe(true);
      expect(resFallback.method).toBe('sigterm_quit');
      expect(execCallsB.map((c) => [c.cmd, ...c.args])).toEqual([
        [macSteamBin, '-shutdown'],
        ['/usr/bin/pkill', '-TERM', '-x', 'steam_osx'],
      ]);
      expect(execCallsB[0].timeout).toBe(15000);
    });

    it('1.3 native host Steam keeps paused downloads held until post-exit cloud sync finishes, and honors sessionStartOffset & isFastDirectBypass', async () => {
      const tmp = makeTempDir('host-steam-downloads');
      const steamRoot = path.join(tmp, 'Steam');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const cloudLogPath = path.join(logsDir, 'cloud_log.txt');
      fs.writeFileSync(
        cloudLogPath,
        '[2026-01-01 00:00:00] [AppID 440123] Starting sync (up, AC Exit)\n',
        'utf8'
      );

      // Register a real paused download task to verify pausedByInGameTaskIds stays held until cloud upload finishes
      const dlTaskId = 'dl-host-steam-wait';
      engineStateRegistry.downloadQueueMap.set(dlTaskId, {
        taskId: dlTaskId,
        gameId: 'gog-bg-1',
        platformId: 'gog',
        status: 'paused',
        manualControl: true,
      });
      engineStateRegistry.pausedByInGameTaskIds.add(dlTaskId);

      engineStateRegistry.activeSessions.set('steam:440123', {
        session: {
          sessionId: 'sess-host-steam-1',
          gameId: 'steam:440123',
          title: 'Synthetic Native Steam',
          platformId: 'steam',
          platformGameId: '440123',
          launchMethod: 'storefront_uri',
          status: 'running',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        platformId: 'steam',
        platformGameId: '440123',
        steamAppId: '440123',
        steamRoot,
        wokeSteamByLauncher: false,
        isFastDirectBypass: false,
        steamCloudLogSessionStartOffset: 0,
        effectiveStorefrontLifecycle: 'minimal_keep_running',
        startedMs: Date.now() - 120_000,
        exitCode: 0,
        stoppedByUser: false,
        launchOptions: {
          platform: 'darwin',
          homedir: tmp,
          userDataDir: tmp,
          steamRoot,
          pollIntervalMs: 20,
          maxCloudWaitMs: 2000,
        },
      });

      const fin = supervisor.finalizeGameSession('steam:440123', {
        platform: 'darwin',
        homedir: tmp,
        userDataDir: tmp,
        steamRoot,
        pollIntervalMs: 20,
        maxCloudWaitMs: 2000,
      });
      expect(fin).toBeTruthy();
      // Because willRunPostExitCloudSync includes native host Steam, downloads MUST NOT resume eagerly!
      expect(engineStateRegistry.pausedByInGameTaskIds.has(dlTaskId)).toBe(true);

      setTimeout(() => {
        fs.appendFileSync(
          cloudLogPath,
          '[2026-01-01 00:00:02] [AppID 440123] Upload complete\n',
          'utf8'
        );
      }, 40);

      await fin.postSessionBarrierPromise;
      expect(engineStateRegistry.pausedByInGameTaskIds.has(dlTaskId)).toBe(false);

      // Now verify pure isFastDirectBypass resumes immediately when no upload is active after sessionStartOffset
      const afterCompleteOffset = fs.statSync(cloudLogPath).size;
      engineStateRegistry.downloadQueueMap.get(dlTaskId).status = 'paused';
      engineStateRegistry.pausedByInGameTaskIds.add(dlTaskId);
      engineStateRegistry.activeSessions.set('steam:440124', {
        session: {
          sessionId: 'sess-host-steam-bypass',
          gameId: 'steam:440124',
          title: 'Synthetic Bypass Steam',
          platformId: 'steam',
          platformGameId: '440124',
          launchMethod: 'direct',
          status: 'running',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        platformId: 'steam',
        platformGameId: '440124',
        steamAppId: '440124',
        steamRoot,
        wokeSteamByLauncher: false,
        isFastDirectBypass: true,
        steamCloudLogSessionStartOffset: afterCompleteOffset,
        effectiveStorefrontLifecycle: 'fast_direct_bypass',
        startedMs: Date.now() - 120_000,
        exitCode: 0,
        stoppedByUser: false,
        launchOptions: { platform: 'darwin', homedir: tmp, userDataDir: tmp, steamRoot },
      });
      const finBypass = supervisor.finalizeGameSession('steam:440124', {
        platform: 'darwin',
        homedir: tmp,
        userDataDir: tmp,
        steamRoot,
      });
      // Pure fast_direct_bypass is NOT in willRunPostExitCloudSync, so downloads resume eagerly!
      expect(engineStateRegistry.pausedByInGameTaskIds.has(dlTaskId)).toBe(false);
      await finBypass.postSessionBarrierPromise;
    });
  });

  describe('2. Bottle Steam Post-Exit Cloud Upload & Clean steam.exe -shutdown Exit Wait', () => {
    it('2.1 strictly orders cloud upload -> steam.exe -shutdown (8s timeout) -> steam.exe exit poll -> wineserver -k, clears daemon contract, and enforces steamRootStrict', async () => {
      const tmp = makeTempDir('bottle-steam-order');
      const bottleDir = path.join(tmp, 'Bottles', 'OneLauncher-arm64');
      const bottleSteamRoot = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'Steam');
      const bottleSteamExe = path.join(bottleSteamRoot, 'steam.exe');
      const bottleLogsDir = path.join(bottleSteamRoot, 'logs');
      fs.mkdirSync(bottleLogsDir, { recursive: true });
      fs.writeFileSync(bottleSteamExe, 'MZ');

      // Put an active job in HOST macOS Steam logs to prove steamRootStrict does NOT leak to host logs!
      const hostSteamLogsDir = path.join(tmp, 'Library', 'Application Support', 'Steam', 'logs');
      fs.mkdirSync(hostSteamLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(hostSteamLogsDir, 'cloud_log.txt'),
        '[2026-01-01 00:00:00] [AppID 555001] Starting sync (up, AC Exit)\n',
        'utf8'
      );

      // Bottle cloud_log has an old stale session entry + a fresh post-sessionStartOffset upload
      const bottleCloudLog = path.join(bottleLogsDir, 'cloud_log.txt');
      fs.writeFileSync(
        bottleCloudLog,
        '[2025-01-01 00:00:00] [AppID 555001] Starting sync (up, AC Exit)\n',
        'utf8'
      );
      const sessionStartOffset = fs.statSync(bottleCloudLog).size;
      fs.appendFileSync(
        bottleCloudLog,
        '[2026-01-01 00:00:00] [AppID 555001] Starting sync (up, AC Exit)\n',
        'utf8'
      );

      // Synthetic wine + wineserver-arm64 scripts that record invocation timeline
      const binDir = path.join(tmp, 'cx-preview', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const wineBin = path.join(binDir, 'wine');
      const wineserverBin = path.join(binDir, 'wineserver-arm64');
      const wineserverLog = path.join(tmp, 'wineserver.log');
      fs.writeFileSync(wineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        wineserverBin,
        `#!/bin/sh\necho "WINESERVER:$1:$CX_BOTTLE" >> "${wineserverLog}"\nexit 0\n`,
        { mode: 0o755 }
      );
      fs.writeFileSync(
        path.join(bottleDir, 'cxbottle.conf'),
        '[Bottle]\n"WineArch" = "arm64"\n',
        'utf8'
      );

      bottleDisplayAndEnv.liveBottleDaemonEnvContractByPrefix.set(
        bottleDisplayAndEnv.normalizeBottlePrefixContractKey(bottleDir),
        '{"backend":"d3dmetal"}'
      );
      bottleDisplayAndEnv.setLiveBottleSteamUiMode(bottleDir, 'silent');
      expect(bottleDisplayAndEnv.getLiveBottleDaemonEnvContract(bottleDir)).toBeTruthy();
      expect(bottleDisplayAndEnv.getLiveBottleSteamUiMode(bottleDir)).toBe('silent');

      const timeline: string[] = [];
      let steamShutdownTimeout = 0;
      let steamExitPolls = 0;

      engineStateRegistry.activeSessions.set('steam:555001', {
        session: {
          sessionId: 'sess-bottle-steam-1',
          gameId: 'steam:555001',
          title: 'Synthetic Bottle Steam',
          platformId: 'steam',
          platformGameId: '555001',
          launchMethod: 'compatibility_layer',
          status: 'running',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        platformId: 'steam',
        platformGameId: '555001',
        steamAppId: '555001',
        bottleSteamRoot,
        bottleSteamExe,
        launchedViaBottleSteam: true,
        wokeBottleSteamByLauncher: true,
        steamCloudLogSessionStartOffset: sessionStartOffset,
        chosenCompatLayerType: 'crossover_preview_arm64',
        winePrefix: bottleDir,
        wineBinary: wineBin,
        wineserverBinary: wineserverBin,
        effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        startedMs: Date.now() - 120_000,
        exitCode: 0,
        stoppedByUser: false,
        launchOptions: {
          platform: 'darwin',
          homedir: tmp,
          userDataDir: tmp,
        },
      });

      const fin = supervisor.finalizeGameSession('steam:555001', {
        platform: 'darwin',
        homedir: tmp,
        userDataDir: tmp,
        pollIntervalMs: 20,
        maxCloudWaitMs: 2000,
        awaitBottleSteamExitInTest: true,
        bottleSteamExitWaitMs: 1000,
        bottleSteamExitPollIntervalMs: 25,
        execFileImpl: (cmd: string, args: string[], opts: any, cb: Function) => {
          if (args.includes('-shutdown')) {
            timeline.push('steam_shutdown_dispatched');
            steamShutdownTimeout = Number(opts?.timeout || 0);
          }
          cb(null, '', '');
        },
        getProcessListOutput: async () => {
          steamExitPolls += 1;
          if (steamExitPolls < 3) {
            timeline.push(`steam_still_alive_poll_${steamExitPolls}`);
            return `WINEPREFIX=${bottleDir} ${bottleSteamExe} -silent\n`;
          }
          timeline.push('steam_exited_cleanly');
          return '';
        },
        onWinePrefixShutdown: () => {
          timeline.push('wineserver_shutdown_complete');
        },
      });

      setTimeout(() => {
        timeline.push('cloud_upload_complete_logged');
        fs.appendFileSync(
          bottleCloudLog,
          '[2026-01-01 00:00:01] [AppID 555001] Upload complete\n',
          'utf8'
        );
      }, 45);

      await fin.postSessionBarrierPromise;

      expect(steamShutdownTimeout).toBe(8000);
      expect(steamExitPolls).toBe(3);
      expect(bottleDisplayAndEnv.getLiveBottleDaemonEnvContract(bottleDir)).toBeUndefined();
      expect(bottleDisplayAndEnv.getLiveBottleSteamUiMode(bottleDir)).toBeUndefined();
      expect(timeline.indexOf('cloud_upload_complete_logged')).toBeLessThan(
        timeline.indexOf('steam_shutdown_dispatched')
      );
      expect(timeline.indexOf('steam_shutdown_dispatched')).toBeLessThan(
        timeline.indexOf('steam_exited_cleanly')
      );
      expect(timeline.indexOf('steam_exited_cleanly')).toBeLessThan(
        timeline.indexOf('wineserver_shutdown_complete')
      );
      const wsLogText = fs.readFileSync(wineserverLog, 'utf8');
      expect(wsLogText).toContain('WINESERVER:-k:OneLauncher-arm64');
      expect(wsLogText).toContain('WINESERVER:-w:OneLauncher-arm64');
    });

    it('2.2 preserves F18-03 static invariant (Run post-exit Cloud Save uploads precedes wineserver -k)', () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../electron/launcher/supervisor/sessionFinalizerAndControl.cjs'),
        'utf8'
      );
      expect(/Run post-exit Cloud Save uploads[\s\S]*?wineserver -k/im.test(src)).toBe(true);
    });
  });

  describe('3. Xbox consumeHeldLock(scid) Single DELETE /lock Handoff', () => {
    it('3.1 hands off loopback held lock + hadWrites=true to post_exit sync so EXACTLY ONE DELETE /lock?newSavesUploaded=true is issued across sync + loopback.close()', async () => {
      const tmp = makeTempDir('xbox-single-delete-lock');
      const bottleDir = path.join(tmp, 'XboxBottle');
      const pfn = 'Studio.SingleLockTest_8wekyb3d8bbwe';
      const scid = '11223344-5566-4778-99aa-bbccddeeff00';
      const xuid = '2533274790395904';
      const sysAppDataDir = path.join(
        bottleDir,
        'drive_c',
        'users',
        'crossover',
        'AppData',
        'Local',
        'Packages',
        pfn,
        'SystemAppData'
      );
      fs.mkdirSync(sysAppDataDir, { recursive: true });

      const requests: Array<{ method: string; url: string }> = [];
      const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const urlStr = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        requests.push({ method, url: urlStr });
        if (urlStr.includes('/lock')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            arrayBuffer: async () =>
              Buffer.from(JSON.stringify({ quotaInfo: { quotaBytes: 268435456 } })),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => Buffer.from(JSON.stringify({ blobs: [] })),
        };
      });

      const mockAuthProvider = {
        getValidXboxSession: async () => ({
          xuid,
          gamertag: 'LockHandoffTester',
          authorizationHeader: `XBL3.0 x=${xuid};tok`,
        }),
        getTokenAndSignatureForUrl: async () => ({
          token: `XBL3.0 x=${xuid};tok`,
          signature: '',
        }),
      };

      const server = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
        userProfile: { xuid, gamertag: 'LockHandoffTester' },
        gameMetadata: { titleId: '71B6A9D4', scid, packageFamilyName: pfn },
        saveRootDir: sysAppDataDir,
        enableCloudSaveSync: true,
        authProvider: mockAuthProvider,
        fetchImpl: mockFetch,
      });

      try {
        const initRes = await sendLoopbackRpcCall(
          server.port,
          server.sessionKey,
          'xgamesave.init',
          { scid, packageFamilyName: pfn },
          1
        );
        expect(initRes.ok).toBe(true);

        // Write a dirty container and commit in-session so lock is held with hadWrites: true
        const folderName = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, scid);
        const wgsDir = path.join(sysAppDataDir, 'wgs', folderName);
        await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsDir, {
          containers: [
            {
              name: 'Slot1',
              displayName: 'Slot1',
              dirty: true,
              blobs: [{ name: 'save.dat', data: Buffer.from('IN-SESSION-SAVE') }],
            },
          ],
        });

        const commitRes = await sendLoopbackRpcCall(
          server.port,
          server.sessionKey,
          'xgamesave.commit',
          { scid, packageFamilyName: pfn, containerName: 'Slot1', waitForCloud: true },
          2
        );
        expect(commitRes.ok).toBe(true);

        const reqsBeforeFinalize = requests.length;
        const gameId = 'xbox-single-lock-1';
        engineStateRegistry.activeSessions.set(gameId, {
          session: {
            sessionId: 'sess-xbox-lock-1',
            gameId,
            platformId: 'xbox',
            platformGameId: '9PSINGLELOCK',
            title: 'Synthetic Single Lock',
            status: 'running',
            launchMethod: 'compatibility_layer',
            startedAt: new Date(Date.now() - 120_000).toISOString(),
          },
          platformId: 'xbox',
          platformGameId: '9PSINGLELOCK',
          startedMs: Date.now() - 120_000,
          exitCode: 0,
          stoppedByUser: false,
          winePrefix: bottleDir,
          packageFamilyName: pfn,
          scid,
          xboxTitleId: '71B6A9D4',
          xboxProductId: '9PSINGLELOCK',
          xboxLoopbackServer: server,
          launchOptions: {
            userDataDir: makeTempDir('xbox-ud'),
            fetchImpl: mockFetch,
            xboxSession: {
              xuid,
              gamertag: 'LockHandoffTester',
              authorizationHeader: `XBL3.0 x=${xuid};tok`,
            },
            xboxAuthProvider: mockAuthProvider,
          },
        });

        const fin = supervisor.finalizeGameSession(gameId);
        expect(fin).toBeTruthy();
        await fin.postSessionBarrierPromise;

        const postExitRequests = requests.slice(reqsBeforeFinalize);
        const postLockCalls = postExitRequests.filter(
          (r) => r.method === 'POST' && r.url.includes('/lock')
        );
        const deleteLockCalls = postExitRequests.filter(
          (r) => r.method === 'DELETE' && r.url.includes('/lock')
        );

        expect(postLockCalls).toHaveLength(0);
        expect(deleteLockCalls).toHaveLength(1);
        expect(deleteLockCalls[0].url).toContain('newSavesUploaded=true');
      } finally {
        await server.close().catch(() => {});
      }
    });

    it('3.2 emits single DELETE /lock?newSavesUploaded=false when no writes occurred, and releases lock via close() on early crash', async () => {
      const tmp = makeTempDir('xbox-zero-write-and-crash');
      const bottleDir = path.join(tmp, 'XboxBottle2');
      const pfn = 'Studio.ZeroWriteLock_8wekyb3d8bbwe';
      const scid = 'aabbccdd-1122-4334-9556-667788990011';
      const xuid = '2533274790395904';
      const sysAppDataDir = path.join(
        bottleDir,
        'drive_c',
        'users',
        'crossover',
        'AppData',
        'Local',
        'Packages',
        pfn,
        'SystemAppData'
      );
      fs.mkdirSync(sysAppDataDir, { recursive: true });

      const requests: Array<{ method: string; url: string }> = [];
      const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const urlStr = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        requests.push({ method, url: urlStr });
        if (urlStr.includes('/lock')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            arrayBuffer: async () =>
              Buffer.from(JSON.stringify({ quotaInfo: { quotaBytes: 268435456 } })),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          arrayBuffer: async () => Buffer.from(JSON.stringify({ blobs: [] })),
        };
      });

      const mockAuthProvider = {
        getValidXboxSession: async () => ({
          xuid,
          gamertag: 'ZeroWriteTester',
          authorizationHeader: `XBL3.0 x=${xuid};tok`,
        }),
        getTokenAndSignatureForUrl: async () => ({
          token: `XBL3.0 x=${xuid};tok`,
          signature: '',
        }),
      };

      const server = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
        userProfile: { xuid, gamertag: 'ZeroWriteTester' },
        gameMetadata: { titleId: '71B6A9D4', scid, packageFamilyName: pfn },
        saveRootDir: sysAppDataDir,
        enableCloudSaveSync: true,
        authProvider: mockAuthProvider,
        fetchImpl: mockFetch,
      });

      try {
        await sendLoopbackRpcCall(
          server.port,
          server.sessionKey,
          'xgamesave.init',
          { scid, packageFamilyName: pfn },
          1
        );

        const reqsBefore = requests.length;
        engineStateRegistry.activeSessions.set('xbox-zero-write-1', {
          session: {
            sessionId: 'sess-xbox-zero-1',
            gameId: 'xbox-zero-write-1',
            platformId: 'xbox',
            platformGameId: '9PZEROWRITE',
            title: 'Synthetic Zero Write',
            status: 'running',
            launchMethod: 'compatibility_layer',
            startedAt: new Date(Date.now() - 120_000).toISOString(),
          },
          platformId: 'xbox',
          platformGameId: '9PZEROWRITE',
          startedMs: Date.now() - 120_000,
          exitCode: 0,
          stoppedByUser: false,
          winePrefix: bottleDir,
          packageFamilyName: pfn,
          scid,
          xboxTitleId: '71B6A9D4',
          xboxProductId: '9PZEROWRITE',
          xboxLoopbackServer: server,
          launchOptions: {
            userDataDir: makeTempDir('xbox-ud2'),
            fetchImpl: mockFetch,
            xboxSession: {
              xuid,
              gamertag: 'ZeroWriteTester',
              authorizationHeader: `XBL3.0 x=${xuid};tok`,
            },
            xboxAuthProvider: mockAuthProvider,
          },
        });

        const fin = supervisor.finalizeGameSession('xbox-zero-write-1');
        await fin.postSessionBarrierPromise;

        const postExitReqs = requests.slice(reqsBefore);
        const delCalls = postExitReqs.filter((r) => r.method === 'DELETE' && r.url.includes('/lock'));
        expect(delCalls).toHaveLength(1);
        expect(delCalls[0].url).toContain('newSavesUploaded=false');
      } finally {
        await server.close().catch(() => {});
      }
    });
  });
});

describe('Phase 2 W3 — GOG/Epic URI Barriers & Chained Publisher Ordered Shutdown', () => {
  beforeEach(() => {
    supervisor.resetSupervisorStateForTests();
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.inFlightPostSessionByGame.clear();
    engineStateRegistry.inFlightPostSessionByBottle.clear();
    engineStateRegistry.pendingBottleLaunches.clear();
    engineStateRegistry.pendingStorefrontLaunches.clear();
    engineStateRegistry.pendingEphemeralShutdowns.clear();
    engineStateRegistry.downloadQueueMap.clear();
    engineStateRegistry.pausedByInGameTaskIds.clear();
    engineStateRegistry.inFlightPostSessionPromises.clear();
  });

  afterEach(() => {
    supervisor.resetSupervisorStateForTests();
    engineStateRegistry.activeSessions.clear();
    engineStateRegistry.downloadQueueMap.clear();
    engineStateRegistry.pausedByInGameTaskIds.clear();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  describe('4. GOG & Epic storefront_uri Cloud-Upload Barriers', () => {
    it('4.1 GOG storefront_uri shutdown passes isStorefrontUri=true to waitForGogPostExitFlush and waits for GalaxyClient.log upload finish before shutdown', async () => {
      const tmp = makeTempDir('gog-uri-barrier');
      const gogLogsDir = path.join(tmp, 'GOGLogs');
      fs.mkdirSync(gogLogsDir, { recursive: true });
      const commLogPath = path.join(gogLogsDir, 'CommunicationService.log');
      const clientLogPath = path.join(gogLogsDir, 'GalaxyClient.log');
      fs.writeFileSync(commLogPath, '[GameplayLogicManager] destructor\n', 'utf8');
      fs.writeFileSync(clientLogPath, 'CloudStorage: Syncing saves for game\n', 'utf8');

      const timeline: string[] = [];
      setTimeout(() => {
        timeline.push('gog_cloud_upload_finished');
        fs.appendFileSync(clientLogPath, 'CloudStorage: Upload finished\n', 'utf8');
      }, 45);

      const res = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'gog',
          wokeGogGalaxyByLauncher: true,
          gogCommLogPreExitOffset: 0,
          gogClientLogPreExitOffset: 0,
          session: { launchMethod: 'storefront_uri' },
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'darwin',
          userDataDir: tmp,
          enableUriCloudFlushWaitInTest: true,
          gogPostExitFlushMs: 1500,
          gogPostExitSettleMs: 10,
          pollIntervalMs: 20,
          gogCommunicationLogPath: commLogPath,
          gogClientLogPath: clientLogPath,
          mockProcessListOutput: '/Applications/GOG Galaxy.app/Contents/MacOS/GOG Galaxy\n',
          execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
            timeline.push(`exec:${cmd}:${args.join(' ')}`);
            cb(null, '', '');
          },
        }
      );

      expect(res.closed).toBe(true);
      expect(res.postExitFlush?.reason).toBe('cloud_sync_completed');
      expect(timeline[0]).toBe('gog_cloud_upload_finished');
      expect(timeline[1]).toContain('/usr/bin/pkill');
    });

    it('4.2 Epic storefront_uri shutdown (darwin & win32) and bottle Epic finalizer await waitForEpicLauncherCloudSyncCompletion before quitting EGL', async () => {
      const tmp = makeTempDir('epic-uri-barrier');
      const epicLogPath = path.join(tmp, 'EpicGamesLauncher.log');
      fs.writeFileSync(epicLogPath, 'LogCloudSync: CloudSync upload starting\n', 'utf8');

      const timeline: string[] = [];
      setTimeout(() => {
        timeline.push('epic_cloud_sync_done');
        fs.appendFileSync(epicLogPath, 'LogCloudSync: CloudSync Completed\n', 'utf8');
      }, 45);

      const macRes = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'epic',
          wokeEpicByLauncher: true,
          epicLogPreExitOffset: 0,
          session: { launchMethod: 'storefront_uri' },
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'darwin',
          userDataDir: tmp,
          preferOsascriptQuitOnDarwin: true,
          enableEpicCloudSyncWaitInTest: true,
          epicCloudSyncWaitMs: 1500,
          pollIntervalMs: 20,
          epicLogPath,
          execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
            timeline.push(`exec:${cmd}:${args.join(' ')}`);
            cb(null, '', '');
          },
        }
      );

      expect(macRes.closed).toBe(true);
      expect(macRes.method).toBe('osascript_quit');
      expect(macRes.cloudSyncWait?.reason).toBe('cloud_sync_completed');
      expect(timeline[0]).toBe('epic_cloud_sync_done');
      expect(timeline[1]).toContain('/usr/bin/osascript');

      // Bottle Epic finalizer also awaits waitForEpicLauncherCloudSyncCompletion before taskkill
      const bottleDir = path.join(tmp, 'EpicBottle');
      const bottleEpicLog = path.join(
        bottleDir,
        'drive_c',
        'users',
        'crossover',
        'AppData',
        'Local',
        'EpicGamesLauncher',
        'Saved',
        'Logs',
        'EpicGamesLauncher.log'
      );
      fs.mkdirSync(path.dirname(bottleEpicLog), { recursive: true });
      fs.writeFileSync(bottleEpicLog, 'LogCloudSync: SaveSync active\n', 'utf8');

      const bottleTimeline: string[] = [];
      setTimeout(() => {
        bottleTimeline.push('bottle_epic_cloud_done');
        fs.appendFileSync(bottleEpicLog, 'LogCloudSync: SaveSync Finished\n', 'utf8');
      }, 45);

      engineStateRegistry.activeSessions.set('epic:bottle-uri-1', {
        session: {
          sessionId: 'sess-bottle-epic-1',
          gameId: 'epic:bottle-uri-1',
          title: 'Synthetic Bottle Epic',
          platformId: 'epic',
          platformGameId: 'BottleEpicApp',
          launchMethod: 'storefront_uri',
          status: 'running',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        platformId: 'epic',
        platformGameId: 'BottleEpicApp',
        wokeBottleEpicByLauncher: true,
        epicLogPreExitOffset: 0,
        winePrefix: bottleDir,
        wineBinary: '/usr/bin/true',
        bottleEpicExe: 'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
        effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        startedMs: Date.now() - 120_000,
        exitCode: 0,
        stoppedByUser: false,
        launchOptions: { platform: 'darwin', homedir: tmp, userDataDir: tmp },
      });

      const finBottleEpic = supervisor.finalizeGameSession('epic:bottle-uri-1', {
        platform: 'darwin',
        homedir: tmp,
        userDataDir: tmp,
        enableEpicCloudSyncWaitInTest: true,
        epicCloudSyncWaitMs: 1500,
        pollIntervalMs: 20,
        autoShutdownWinePrefixOnExit: false,
        execFileImpl: (_cmd: string, args: string[], _opts: any, cb: Function) => {
          bottleTimeline.push(`bottle_exec:${args.join(' ')}`);
          cb(null, '', '');
        },
      });
      await finBottleEpic.postSessionBarrierPromise;
      expect(bottleTimeline[0]).toBe('bottle_epic_cloud_done');
      expect(bottleTimeline[1]).toBe('bottle_exec:taskkill /IM EpicGamesLauncher.exe');
    });
  });

  describe('5. Chained Publishers: Sequential Ordering, Settle Barrier, Win32 All-5 Parity, Anchored Rockstar Regex & macOS .app Quit', () => {
    it('5.1 waitForPublisherCloudUploadSettle enforces minimum grace, extends while publisher logs are actively written, and aborts cleanly', async () => {
      const tmp = makeTempDir('pub-settle');
      const eaLog = path.join(tmp, 'EADesktop.log');
      fs.writeFileSync(eaLog, 'upload chunk 1\n', 'utf8');

      // Keep touching log once during extension window, then let it settle
      const writerTimer = setTimeout(() => {
        fs.appendFileSync(eaLog, 'upload chunk 2\n', 'utf8');
      }, 60);

      const t0 = Date.now();
      const settleRes = await storefrontLifecycle.waitForPublisherCloudUploadSettle(
        'ea',
        {},
        {
          publisherLogPath: eaLog,
          publisherCloudSyncGraceMs: 40,
          publisherCloudSyncMaxWaitMs: 800,
          publisherActiveWriteWindowMs: 110,
          publisherCloudSyncPollIntervalMs: 25,
        }
      );
      clearTimeout(writerTimer);
      const elapsed = Date.now() - t0;

      expect(settleRes.settled).toBe(true);
      expect(settleRes.extended).toBe(true);
      expect(settleRes.reason).toBe('log_writes_settled');
      expect(elapsed).toBeGreaterThanOrEqual(130);

      // Abort signal terminates settle immediately
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      const tAbort = Date.now();
      const abortRes = await storefrontLifecycle.waitForPublisherCloudUploadSettle(
        'ea',
        {},
        {
          publisherLogPath: eaLog,
          publisherCloudSyncGraceMs: 500,
          publisherCloudSyncMaxWaitMs: 1500,
          signal: ac.signal,
        }
      );
      expect(abortRes.aborted).toBe(true);
      expect(Date.now() - tAbort).toBeLessThan(250);
    });

    it('5.2 eliminates 0ms EA kill & wineserver -k race: settle -> EA reg delete -> SIGTERM -> SIGKILL -> wineserver -k strictly in order', async () => {
      const tmp = makeTempDir('ea-sequential-order');
      const bottleDir = path.join(tmp, 'Bottles', 'OneLauncher');
      const eaLogDir = path.join(
        bottleDir,
        'drive_c',
        'users',
        'crossover',
        'AppData',
        'Local',
        'Electronic Arts',
        'EA Desktop',
        'Logs'
      );
      fs.mkdirSync(eaLogDir, { recursive: true });
      const eaLogPath = path.join(eaLogDir, 'EADesktop.log');
      // Set stale mtime so settle waits exactly minGraceMs without extending
      fs.writeFileSync(eaLogPath, 'previous log\n', 'utf8');
      const staleTime = new Date(Date.now() - 60_000);
      fs.utimesSync(eaLogPath, staleTime, staleTime);

      const binDir = path.join(tmp, 'cx', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const wineBin = path.join(binDir, 'wine');
      const wineserverBin = path.join(binDir, 'wineserver');
      fs.writeFileSync(wineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(wineserverBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const timeline: string[] = [];
      let eaStillAlive = true;

      engineStateRegistry.activeSessions.set('ea:seq-test-1', {
        session: {
          sessionId: 'sess-ea-seq-1',
          gameId: 'ea:seq-test-1',
          title: 'Synthetic EA Sequential',
          platformId: 'ea',
          platformGameId: 'seq-test-1',
          launchMethod: 'compatibility_layer',
          status: 'running',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
        },
        platformId: 'ea',
        platformGameId: 'seq-test-1',
        isChainedPublisherLauncher: true,
        chainedLauncherHandoff: 'ea',
        wokePublisherClientByLauncher: true,
        ephemeralClientWoken: true,
        winePrefix: bottleDir,
        wineBinary: wineBin,
        wineserverBinary: wineserverBin,
        effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        startedMs: Date.now() - 120_000,
        exitCode: 0,
        stoppedByUser: false,
        launchOptions: { platform: 'darwin', homedir: tmp, userDataDir: tmp },
      });

      const t0 = Date.now();
      const fin = supervisor.finalizeGameSession('ea:seq-test-1', {
        platform: 'darwin',
        homedir: tmp,
        userDataDir: tmp,
        publisherCloudSyncGraceMs: 60,
        bottlePublisherGracefulKillWaitMs: 30,
        getProcessListOutput: async () =>
          eaStillAlive
            ? `71001 WINEPREFIX=${bottleDir} C:\\Program Files\\Electronic Arts\\EA Desktop\\EADesktop.exe\n`
            : '',
        killPidFn: (pid: number, sig: string) => {
          timeline.push(`kill:${pid}:${sig}`);
          if (sig === 'SIGKILL') eaStillAlive = false;
        },
        execFileImpl: (_cmd: string, args: string[], _opts: any, cb: Function) => {
          timeline.push(`exec:${args.join(' ')}`);
          cb(null, '', '');
        },
        onWinePrefixShutdown: () => {
          timeline.push('wineserver_k_complete');
        },
      });

      await fin.postSessionBarrierPromise;

      expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
      // Zero premature taskkill /F calls!
      expect(timeline.some((e) => e.includes('taskkill /F'))).toBe(false);
      const regIdx = timeline.findIndex((e) => e.includes('reg delete') && e.includes('EADM'));
      const sigtermIdx = timeline.indexOf('kill:71001:SIGTERM');
      const sigkillIdx = timeline.indexOf('kill:71001:SIGKILL');
      const wsIdx = timeline.indexOf('wineserver_k_complete');

      expect(regIdx).toBeGreaterThanOrEqual(0);
      expect(sigtermIdx).toBeGreaterThan(regIdx);
      expect(sigkillIdx).toBeGreaterThan(sigtermIdx);
      expect(wsIdx).toBeGreaterThan(sigkillIdx);
    });

    it('5.3 Win32 all-5 publishers graceful->force parity, Steam+EA no blind /F, and CRITICAL Rockstar CIM path-scoping (NEVER bare taskkill /IM Launcher.exe)', async () => {
      const tmp = makeTempDir('win32-all5-pub');

      // Verify ea, ubisoft, bnet, riot graceful -> force sequence
      const standardPubs: Array<{ id: string; expectedGraceful: string; expectedForce: string }> = [
        { id: 'ea', expectedGraceful: 'EADesktop.exe', expectedForce: 'EABackgroundService.exe' },
        { id: 'ubisoft', expectedGraceful: 'upc.exe', expectedForce: 'UplayService.exe' },
        { id: 'bnet', expectedGraceful: 'Battle.net.exe', expectedForce: 'Agent.exe' },
        { id: 'riot', expectedGraceful: 'RiotClientUx.exe', expectedForce: 'RiotClientCrashHandler.exe' },
      ];

      for (const pub of standardPubs) {
        const calls: Array<{ cmd: string; args: string[] }> = [];
        const res = await supervisor.shutdownEphemeralStorefrontClient(
          {
            platformId: 'xbox',
            chainedLauncherHandoff: pub.id,
            wokePublisherClientByLauncher: true,
            effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
          },
          {
            platform: 'win32',
            userDataDir: tmp,
            execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
              calls.push({ cmd, args });
              cb(null, '', '');
            },
          }
        );
        expect(res.closed).toBe(true);
        expect(res.chainedLauncherHandoff).toBe(pub.id);
        expect(calls).toHaveLength(2);
        expect(calls[0].cmd).toBe('taskkill.exe');
        expect(calls[0].args).not.toContain('/F');
        expect(calls[0].args).toContain(pub.expectedGraceful);
        expect(calls[1].cmd).toBe('taskkill.exe');
        expect(calls[1].args).toContain('/F');
        expect(calls[1].args).toContain(pub.expectedForce);
      }

      // CRITICAL ROCKSTAR SAFETY: NEVER bare taskkill /IM Launcher.exe!
      const rglCalls: Array<{ cmd: string; args: string[] }> = [];
      const rglRes = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'steam',
          chainedLauncherHandoff: 'rockstar',
          wokePublisherClientByLauncher: true,
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'win32',
          userDataDir: tmp,
          execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
            rglCalls.push({ cmd, args });
            cb(null, '', '');
          },
        }
      );
      expect(rglRes.closed).toBe(true);
      expect(rglRes.method).toBe('cim_scoped_graceful');
      // ZERO bare taskkill.exe /IM Launcher.exe anywhere!
      for (const c of rglCalls) {
        if (c.cmd.toLowerCase().includes('taskkill')) {
          expect(c.args.map((a) => a.toLowerCase())).not.toContain('launcher.exe');
        }
      }
      const psCommands = rglCalls
        .filter((c) => c.cmd.toLowerCase().includes('powershell'))
        .map((c) => c.args.join(' '));
      expect(psCommands.length).toBe(2);
      expect(psCommands[0]).toContain("*Rockstar Games*Launcher*");
      expect(psCommands[0]).toContain('CloseMainWindow');
      expect(psCommands[1]).toContain("*Rockstar Games*Launcher*");
      expect(psCommands[1]).toContain('Stop-Process');

      // Win32 Steam + woken EA routes through graceful EADesktop.exe first (NO blind immediate /F)
      const steamEaExecs: Array<{ cmd: string; args: string[] }> = [];
      const steamEaSpawns: Array<{ cmd: string; args: string[] }> = [];
      const steamEaRes = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'steam',
          wokeSteamByLauncher: true,
          steamClientBinaryPath: 'C:\\Program Files (x86)\\Steam\\steam.exe',
          chainedLauncherHandoff: 'ea',
          wokePublisherClientByLauncher: true,
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'win32',
          userDataDir: tmp,
          spawnFn: (cmd: string, args: string[]) => {
            steamEaSpawns.push({ cmd, args });
          },
          execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
            steamEaExecs.push({ cmd, args });
            cb(null, '', '');
          },
        }
      );
      expect(steamEaRes.closed).toBe(true);
      expect(steamEaSpawns[0]?.args).toEqual(['-shutdown']);
      expect(steamEaExecs[0]?.cmd).toBe('taskkill.exe');
      expect(steamEaExecs[0]?.args).not.toContain('/F');
      expect(steamEaExecs[0]?.args).toEqual(['/IM', 'EADesktop.exe']);
    });

    it('5.4 anchored bottle Rockstar regex & exact bottle prefix guard prevent collateral kills of unrelated Launcher.exe or sibling bottles', async () => {
      const tmp = makeTempDir('rockstar-bottle-safety');
      const targetBottle = path.join(tmp, 'Bottles', 'OneLauncher');
      const siblingBottle = path.join(tmp, 'Bottles', 'OneLauncher-arm64');
      fs.mkdirSync(targetBottle, { recursive: true });
      fs.mkdirSync(siblingBottle, { recursive: true });

      const psSnapshot = [
        `80101 WINEPREFIX=${targetBottle} C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe -minmode`,
        `80102 WINEPREFIX=${targetBottle} C:\\Program Files\\Rockstar Games\\Social Club\\SocialClubHelper.exe`,
        `80103 WINEPREFIX=${targetBottle} C:\\Games\\Fallout 4\\Launcher.exe`,
        `80104 WINEPREFIX=${targetBottle} C:\\Games\\Skyrim\\SkyrimSELauncher.exe`,
        `80105 WINEPREFIX=${siblingBottle} C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe`,
      ].join('\n');

      const killed: number[] = [];
      const res = await supervisor.shutdownEphemeralStorefrontClient(
        {
          platformId: 'rockstar',
          chainedLauncherHandoff: 'rockstar',
          wokePublisherClientByLauncher: true,
          winePrefix: targetBottle,
          effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
        },
        {
          platform: 'darwin',
          userDataDir: tmp,
          mockProcessListOutput: psSnapshot,
          killPidFn: (pid: number) => {
            killed.push(pid);
          },
        }
      );

      expect(res.closed).toBe(true);
      expect(killed).toEqual([80101, 80102]);
      expect(killed).not.toContain(80103); // Fallout 4 Launcher.exe spared!
      expect(killed).not.toContain(80104); // SkyrimSELauncher.exe spared!
      expect(killed).not.toContain(80105); // Sibling OneLauncher-arm64 bottle spared!
    });

    it('5.5 native macOS .app publishers (Battle.net, EA app, Riot Client) quit via osascript with pkill -TERM fallback', async () => {
      const tmp = makeTempDir('mac-native-pub-quit');
      const expectedApps: Array<{ id: string; appName: string; firstPkill: string }> = [
        { id: 'bnet', appName: 'Battle.net', firstPkill: 'Battle.net' },
        { id: 'ea', appName: 'EA app', firstPkill: 'EADesktop' },
        { id: 'riot', appName: 'Riot Client', firstPkill: 'RiotClientUx' },
      ];

      for (const item of expectedApps) {
        // Case A: osascript succeeds
        const osaCalls: Array<{ cmd: string; args: string[] }> = [];
        const okRes = await supervisor.shutdownEphemeralStorefrontClient(
          {
            platformId: item.id,
            chainedLauncherHandoff: item.id,
            wokePublisherClientByLauncher: true,
            winePrefix: null,
            effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
          },
          {
            platform: 'darwin',
            userDataDir: tmp,
            execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
              osaCalls.push({ cmd, args });
              cb(null, '', '');
            },
          }
        );
        expect(okRes.closed).toBe(true);
        expect(okRes.method).toBe('osascript_quit');
        expect(osaCalls).toEqual([
          {
            cmd: '/usr/bin/osascript',
            args: ['-e', `tell application "${item.appName}" to quit`],
          },
        ]);

        // Case B: osascript fails -> falls back to /usr/bin/pkill -TERM -x
        const fallbackCalls: Array<{ cmd: string; args: string[] }> = [];
        const fbRes = await supervisor.shutdownEphemeralStorefrontClient(
          {
            platformId: item.id,
            chainedLauncherHandoff: item.id,
            wokePublisherClientByLauncher: true,
            winePrefix: null,
            effectiveStorefrontLifecycle: 'minimal_and_close_if_started',
          },
          {
            platform: 'darwin',
            userDataDir: tmp,
            execFileImpl: (cmd: string, args: string[], _opts: any, cb: Function) => {
              fallbackCalls.push({ cmd, args });
              if (cmd === '/usr/bin/osascript') {
                cb(new Error('osascript failed'), '', '');
              } else {
                cb(null, '', '');
              }
            },
          }
        );
        expect(fbRes.closed).toBe(true);
        expect(fbRes.method).toBe('sigterm_quit');
        expect(fallbackCalls[0].cmd).toBe('/usr/bin/osascript');
        expect(fallbackCalls[1]).toEqual({
          cmd: '/usr/bin/pkill',
          args: ['-TERM', '-x', item.firstPkill],
        });
      }
    });
  });
});
