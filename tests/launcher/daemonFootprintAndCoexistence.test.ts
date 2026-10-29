import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import type { CanonicalGame } from '../../src/contracts/game';
import type {
  ActiveGameSession,
  CompatibilityLayerInfo,
  DownloadTaskState,
  GameLaunchConfig,
  InstalledGameRecord,
} from '../../src/contracts/launcher';
import { LauncherService, launcherService } from '../../src/services/launcher/launcherService';
import { requestScheduler } from '../../src/services/network/requestScheduler';
import { sanitizeGameCatalog } from '../../src/services/integrations/catalogSanitizer';
import {
  loadUserOverrides,
  saveUserOverride,
  removeUserOverride,
} from '../../src/services/storage/userOverrideStorage';
import { SteamLibraryActionBar } from '../../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { SteamStorePage } from '../../src/components/SteamStoreDetail/SteamStorePage';
import { DownloadManagerDrawer } from '../../src/components/Launcher/DownloadManagerDrawer';
import { GameInstallModal } from '../../src/components/Launcher/GameInstallModal';
import { GameLaunchConfigModal } from '../../src/components/Launcher/GameLaunchConfigModal';
import {
  getNativeOsPlatforms,
  getStorefrontNativeOsPlatforms,
  isNativelyAvailableOnMac,
} from '../../src/services/platform/nativeOsService';
import {
  MockStorage,
  mockStorage,
  installUniversalLauncherBrowserMocks,
  writeTempFile,
  launcherEngine,
} from '../helpers/universalLauncherHarness';

const require = createRequire(import.meta.url);
installUniversalLauncherBrowserMocks();

describe("Universal Game Launcher QA — Auth Self-Healing, Footprint & TCC Coexistence (35–39)", () => {
  let tmpRoot: string;
  let userDataDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launcher-qa-'));
    userDataDir = path.join(tmpRoot, 'userdata');
    fs.mkdirSync(userDataDir, { recursive: true });
    launcherEngine.setUserDataDir(userDataDir);
    launcherEngine.clearDownloadQueue();
    launcherEngine.openedExternalUris.length = 0;
    mockStorage.clear();
  });

  afterEach(async () => {
    const running = launcherEngine.getRunningGames();
    for (const session of running) {
      await launcherEngine.stopGame({ gameId: session.gameId });
    }
    launcherEngine.clearDownloadQueue();
    delete (globalThis as any).window.electronAPI;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // 35. STOREFRONT ACHIEVEMENT AUTH / DAEMON WAKE & CLOUD PLAYTIME SYNC
  // =========================================================================
  describe('35. Storefront Achievement Auth / Daemon Wake & Cloud Playtime Single-Point-of-Truth Sync (Tasks 1 & 2)', () => {
    it('Task 1A: resolveEpicLaunchAuthArguments exchanges OAuth token for live EOS -AUTH_PASSWORD exchange code and falls back to offline identity flags when network is unavailable', async () => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-epic-auth-'));
      try {
        const metaDir = path.join(tempHome, 'Library/Application Support/heroic/legendaryConfig/legendary/metadata');
        writeTempFile(
          path.join(metaDir, 'Calluna.json'),
          JSON.stringify({
            app_name: 'Calluna',
            app_title: 'Control',
            metadata: {
              namespace: 'calluna-namespace-id',
              id: 'calluna-catalog-item-id',
            },
          })
        );

        const fetchCalls: Array<{ url: string; options: any }> = [];
        const mockFetch = async (url: string, opts: any) => {
          fetchCalls.push({ url, options: opts });
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 'live-eos-exchange-code-999' }),
          };
        };

        // 1. Online exchange code resolution
        const onlineAuth = await launcherEngine.resolveEpicLaunchAuthArguments(
          {
            gameId: 'epic-Calluna',
            platformId: 'epic',
            platformGameId: 'Calluna',
            title: 'Control',
          },
          {
            platform: 'darwin',
            homedir: tempHome,
            userDataDir,
            savedTokens: {
              epic: {
                access_token: 'epic-oauth-bearer-token-123',
                account_id: 'epic-acct-abc',
                displayName: 'CommanderShepard',
              },
            },
            fetchFn: mockFetch,
          }
        );

        expect(onlineAuth.authenticated).toBe(true);
        expect(onlineAuth.exchangeCode).toBe('live-eos-exchange-code-999');
        expect(onlineAuth.appName).toBe('Calluna');
        expect(onlineAuth.namespace).toBe('calluna-namespace-id');
        expect(onlineAuth.catalogItemId).toBe('calluna-catalog-item-id');
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe(
          'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/exchange'
        );
        expect(fetchCalls[0].options.headers.Authorization).toBe(
          'bearer epic-oauth-bearer-token-123'
        );
        expect(onlineAuth.args).toEqual([
          '-AUTH_LOGIN=unused',
          '-AUTH_PASSWORD=live-eos-exchange-code-999',
          '-AUTH_TYPE=exchangecode',
          '-epicapp=Calluna',
          '-epicenv=Prod',
          '-EpicPortal',
          '-epicusername=CommanderShepard',
          '-epicuserid=epic-acct-abc',
          '-epiclocale=en',
          '-epicsandboxid=calluna-namespace-id',
        ]);

        // 2. Offline / failed exchange fallback
        const offlineAuth = await launcherEngine.resolveEpicLaunchAuthArguments(
          {
            gameId: 'epic-Calluna',
            platformId: 'epic',
            platformGameId: 'Calluna',
            title: 'Control',
          },
          {
            platform: 'darwin',
            homedir: tempHome,
            userDataDir,
            skipNetwork: true,
            savedTokens: {
              epic: {
                access_token: 'epic-oauth-bearer-token-123',
                account_id: 'epic-acct-abc',
                displayName: 'CommanderShepard',
              },
            },
          }
        );

        expect(offlineAuth.authenticated).toBe(false);
        expect(offlineAuth.exchangeCode).toBeNull();
        expect(offlineAuth.args).toEqual([
          '-epicapp=Calluna',
          '-epicenv=Prod',
          '-EpicPortal',
          '-epicusername=CommanderShepard',
          '-epicuserid=epic-acct-abc',
          '-epiclocale=en',
          '-epicsandboxid=calluna-namespace-id',
        ]);
      } finally {
        try {
          fs.rmSync(tempHome, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 1B: ensureGogGalaxyBackgroundService wakes GOG Galaxy communication daemon on Windows and macOS when installed and not already running', async () => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-gog-wake-'));
      try {
        // 1. Not installed -> found: false, started: false
        const missingRes = await launcherEngine.ensureGogGalaxyBackgroundService({
          platform: 'darwin',
          homedir: tempHome,
          gogGalaxyClientPath: path.join(tempHome, 'NonExistent/GOG Galaxy.app'),
        });
        expect(missingRes).toEqual({
          found: false,
          alreadyRunning: false,
          started: false,
          clientPath: null,
        });

        // 2. Installed on Windows & not running -> spawns GalaxyClient.exe /launchViaAutoStart
        const winClientExe = path.join(tempHome, 'GOG Galaxy', 'GalaxyClient.exe');
        writeTempFile(winClientExe, 'MZ-galaxy-client');
        const spawnedCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
        const mockSpawn = (cmd: string, args: string[], opts: any) => {
          spawnedCalls.push({ cmd, args, opts });
          return { unref: vi.fn() };
        };

        const winWakeRes = await launcherEngine.ensureGogGalaxyBackgroundService({
          platform: 'win32',
          homedir: tempHome,
          gogGalaxyClientPath: winClientExe,
          mockProcessListOutput: 'explorer.exe\nsvchost.exe\n',
          allowGogWakeInTest: true,
          spawnFn: mockSpawn,
        });
        expect(winWakeRes).toEqual({
          found: true,
          alreadyRunning: false,
          started: true,
          clientPath: winClientExe,
        });
        expect(spawnedCalls).toHaveLength(1);
        expect(spawnedCalls[0].cmd).toBe(winClientExe);
        expect(spawnedCalls[0].args).toEqual(['/launchViaAutoStart', '/runWithoutUpdating']);

        // 3. Installed on macOS & not running -> spawns /usr/bin/open -g -j -a <GOG Galaxy.app>
        const macGalaxyApp = path.join(tempHome, 'Applications', 'GOG Galaxy.app');
        fs.mkdirSync(macGalaxyApp, { recursive: true });
        spawnedCalls.length = 0;

        const macWakeRes = await launcherEngine.ensureGogGalaxyBackgroundService({
          platform: 'darwin',
          homedir: tempHome,
          gogGalaxyClientPath: macGalaxyApp,
          mockProcessListOutput: '/sbin/launchd\n/System/Applications/Finder.app\n',
          allowGogWakeInTest: true,
          spawnFn: mockSpawn,
        });
        expect(macWakeRes).toEqual({
          found: true,
          alreadyRunning: false,
          started: true,
          clientPath: macGalaxyApp,
        });
        expect(spawnedCalls).toHaveLength(1);
        expect(spawnedCalls[0].cmd).toBe('/usr/bin/open');
        expect(spawnedCalls[0].args).toEqual([
          '-g',
          '-j',
          '-a',
          macGalaxyApp,
          '--args',
          '--launchViaAutoStart',
          '--runWithoutUpdating',
        ]);

        // 4. Already running -> alreadyRunning: true, started: false (does not spawn)
        spawnedCalls.length = 0;
        const alreadyRunningRes = await launcherEngine.ensureGogGalaxyBackgroundService({
          platform: 'darwin',
          homedir: tempHome,
          gogGalaxyClientPath: macGalaxyApp,
          mockProcessListOutput: '/Users/test/Applications/GOG Galaxy.app/Contents/MacOS/GOG Galaxy\n',
          allowGogWakeInTest: true,
          spawnFn: mockSpawn,
        });
        expect(alreadyRunningRes).toEqual({
          found: true,
          alreadyRunning: true,
          started: false,
          clientPath: macGalaxyApp,
        });
        expect(spawnedCalls).toHaveLength(0);
      } finally {
        try {
          fs.rmSync(tempHome, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 2: syncSessionPlaytimeToStorefront uploads Epic & GOG session playtime to cloud APIs and reconciles authoritative storefront total playtime', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-playtime-sync-'));
      try {
        // 1. Zero-duration guard
        const zeroRes = await launcherEngine.syncSessionPlaytimeToStorefront({
          platformId: 'epic',
          durationSeconds: 0,
          sessionMinutesPlayed: 0,
        });
        expect(zeroRes).toEqual({
          synced: false,
          platformId: 'epic',
          reason: 'zero_duration',
          storefrontTotalPlaytimeMinutes: null,
        });

        // 2. Epic playtime PUT + GET /all authoritative total reconciliation
        const epicHttpCalls: Array<{ url: string; options: any }> = [];
        const mockEpicFetch = async (url: string, options: any) => {
          epicHttpCalls.push({ url, options });
          if (options.method === 'PUT') {
            return {
              ok: true,
              status: 204,
              text: async () => '',
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify([
                { artifactId: 'Calluna', totalTime: 7200 },
                { artifactId: 'OtherGame', totalTime: 600 },
              ]),
          };
        };

        const epicSyncRes = await launcherEngine.syncSessionPlaytimeToStorefront(
          {
            gameId: 'epic-Calluna',
            platformId: 'epic',
            platformGameId: 'Calluna',
            artifactId: 'Calluna',
            startedAt: '2026-10-22T18:00:00.000Z',
            endedAt: '2026-10-22T18:30:00.000Z',
            durationSeconds: 1800,
            sessionMinutesPlayed: 30,
          },
          {
            homedir: tempDir,
            userDataDir,
            machineId: 'test-machine-uuid-1234',
            savedTokens: {
              epic: {
                access_token: 'epic-playtime-token',
                account_id: 'epic-user-777',
              },
            },
            fetchFn: mockEpicFetch,
          }
        );

        expect(epicSyncRes).toEqual({
          synced: true,
          platformId: 'epic',
          artifactId: 'Calluna',
          storefrontTotalPlaytimeMinutes: 120,
        });
        expect(epicHttpCalls).toHaveLength(2);
        expect(epicHttpCalls[0].url).toBe(
          'https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/epic-user-777'
        );
        expect(epicHttpCalls[0].options.method).toBe('PUT');
        expect(JSON.parse(epicHttpCalls[0].options.body)).toEqual({
          machineId: 'test-machine-uuid-1234',
          artifactId: 'Calluna',
          startTime: '2026-10-22T18:00:00.000Z',
          endTime: '2026-10-22T18:30:00.000Z',
          startSegment: true,
          endSegment: true,
        });
        expect(epicHttpCalls[1].url).toBe(
          'https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/epic-user-777/all'
        );

        // 3. GOG playtime POST with goggame-<id>.info fallback discovery
        const gogGameDir = path.join(tempDir, 'Hollow Knight');
        writeTempFile(
          path.join(gogGameDir, 'goggame-1308320804.info'),
          JSON.stringify({ gameId: '1308320804', name: 'Hollow Knight' })
        );

        const gogHttpCalls: Array<{ url: string; options: any }> = [];
        const mockGogFetch = async (url: string, options: any) => {
          gogHttpCalls.push({ url, options });
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ total_time: 95 }),
          };
        };

        const gogSyncRes = await launcherEngine.syncSessionPlaytimeToStorefront(
          {
            gameId: 'gog-hollow-knight',
            platformId: 'gog',
            platformGameId: 'hollow-knight',
            installPath: gogGameDir,
            startedAt: '2026-10-22T19:00:00.000Z',
            endedAt: '2026-10-22T19:15:00.000Z',
            durationSeconds: 900,
            sessionMinutesPlayed: 15,
          },
          {
            homedir: tempDir,
            userDataDir,
            savedTokens: {
              gog: {
                access_token: 'gog-oauth-token-456',
                user_id: '4815162342',
              },
            },
            fetchFn: mockGogFetch,
          }
        );

        expect(gogSyncRes).toEqual({
          synced: true,
          platformId: 'gog',
          gameId: '1308320804',
          storefrontTotalPlaytimeMinutes: 95,
        });
        expect(gogHttpCalls).toHaveLength(1);
        expect(gogHttpCalls[0].url).toBe(
          'https://gameplay.gog.com/clients/1308320804/users/4815162342/sessions'
        );
        expect(gogHttpCalls[0].options.method).toBe('POST');
        expect(JSON.parse(gogHttpCalls[0].options.body)).toEqual({
          session_date: Math.floor(new Date('2026-10-22T19:00:00.000Z').getTime() / 1000),
          time: 15,
        });
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  describe('36. In-Game Footprint Minimization & Performance Policy (Task 3)', () => {
    it('persists and sanitizes global performance settings via getLauncherPerformanceSettings and saveLauncherPerformanceSettings', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-perf-settings-'));
      try {
        const defaults = launcherEngine.getLauncherPerformanceSettings({ userDataDir: tempDir });
        expect(defaults).toEqual({
          inGameLauncherBehavior: 'hide_tray_hibernate',
          postGameLauncherBehavior: 'restore_window',
          pauseBackgroundSyncInGame: true,
          pauseDownloadsInGame: true,
          storefrontClientLifecycle: 'minimal_and_close_if_started',
          autoShutdownWinePrefixOnExit: true,
          suppressWineDebugLogging: true,
        });

        const saved = launcherEngine.saveLauncherPerformanceSettings(
          {
            inGameLauncherBehavior: 'zero_renderer_daemon',
            postGameLauncherBehavior: 'stay_minimized',
            pauseBackgroundSyncInGame: false,
            pauseDownloadsInGame: true,
            storefrontClientLifecycle: 'minimal_keep_running',
            autoShutdownWinePrefixOnExit: false,
            suppressWineDebugLogging: false,
          },
          { userDataDir: tempDir }
        );
        expect(saved.success).toBe(true);
        expect(saved).toEqual({
          inGameLauncherBehavior: 'zero_renderer_daemon',
          postGameLauncherBehavior: 'stay_minimized',
          pauseBackgroundSyncInGame: false,
          pauseDownloadsInGame: true,
          storefrontClientLifecycle: 'minimal_keep_running',
          autoShutdownWinePrefixOnExit: false,
          suppressWineDebugLogging: false,
        });

        const reloaded = launcherEngine.getLauncherPerformanceSettings({ userDataDir: tempDir });
        expect(reloaded).toEqual(saved);

        // Verify sanitization of invalid enum values and legacy aliases
        const sanitized = launcherEngine.saveLauncherPerformanceSettings(
          {
            inGameLauncherBehavior: 'invalid_mode',
            postGameLauncherBehavior: 'invalid_post_mode',
            storefrontClientLifecycle: 'shutdown_if_woken',
          },
          { userDataDir: tempDir }
        );
        expect(sanitized.inGameLauncherBehavior).toBe('hide_tray_hibernate');
        expect(sanitized.postGameLauncherBehavior).toBe('restore_window');
        expect(sanitized.storefrontClientLifecycle).toBe('minimal_and_close_if_started');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('merges per-game overrides over global settings via resolveEffectivePerformancePolicy', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-perf-policy-'));
      try {
        launcherEngine.saveLauncherPerformanceSettings(
          {
            inGameLauncherBehavior: 'hide_tray_hibernate',
            postGameLauncherBehavior: 'restore_window',
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          },
          { userDataDir: tempDir }
        );

        const inherited = launcherEngine.resolveEffectivePerformancePolicy(
          {
            gameId: 'steam-620',
            inGameLauncherBehavior: 'default',
            storefrontClientLifecycle: 'default',
          },
          { userDataDir: tempDir }
        );
        expect(inherited.inGameLauncherBehavior).toBe('hide_tray_hibernate');
        expect(inherited.storefrontClientLifecycle).toBe('minimal_and_close_if_started');

        const overridden = launcherEngine.resolveEffectivePerformancePolicy(
          {
            gameId: 'steam-620',
            inGameLauncherBehavior: 'keep_open',
            storefrontClientLifecycle: 'default_client',
          },
          { userDataDir: tempDir }
        );
        expect(overridden.inGameLauncherBehavior).toBe('keep_open');
        expect(overridden.storefrontClientLifecycle).toBe('default_client');
        expect(overridden.postGameLauncherBehavior).toBe('restore_window');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('builds minimal Steam client args via resolveSteamClientLaunchCommand when Steam is not running and respects alreadyRunning / default_client', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-steam-minimal-'));
      try {
        const fakeSteamExe = path.join(tempDir, 'Steam', 'steam.exe');
        fs.mkdirSync(path.dirname(fakeSteamExe), { recursive: true });
        fs.writeFileSync(fakeSteamExe, 'MZ');

        // 1. Steam not running + minimal_and_close_if_started -> silent applaunch preserving Friends/Overlay
        const minimalCmd = await launcherEngine.resolveSteamClientLaunchCommand(
          '1091500',
          ['-skipStartScreen'],
          {
            platform: 'win32',
            userDataDir: tempDir,
            steamClientBinaryPath: fakeSteamExe,
            mockProcessListOutput: 'INFO: No tasks are running',
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          }
        );
        expect(minimalCmd.useMinimalBinarySpawn).toBe(true);
        expect(minimalCmd.alreadyRunning).toBe(false);
        expect(minimalCmd.wokeSteamByLauncher).toBe(true);
        expect(minimalCmd.binaryPath).toBe(fakeSteamExe);
        expect(minimalCmd.args).toEqual([
          '-silent',
          '-applaunch',
          '1091500',
          '-skipStartScreen',
        ]);

        // 1b. Steam not running + fast_direct_bypass -> ultra-minimal flags (-nochatui, -nofriendsui, -nobrowser)
        const fastBypassCmd = await launcherEngine.resolveSteamClientLaunchCommand(
          '1091500',
          ['-skipStartScreen'],
          {
            platform: 'win32',
            userDataDir: tempDir,
            steamClientBinaryPath: fakeSteamExe,
            mockProcessListOutput: 'INFO: No tasks are running',
            storefrontClientLifecycle: 'fast_direct_bypass',
          }
        );
        expect(fastBypassCmd.useMinimalBinarySpawn).toBe(true);
        expect(fastBypassCmd.args).toEqual([
          '-silent',
          '-nochatui',
          '-nofriendsui',
          '-nobrowser',
          '-applaunch',
          '1091500',
          '-skipStartScreen',
        ]);

        // 2. Steam not running + minimal_keep_running -> minimal silent flags
        const keepRunningCmd = await launcherEngine.resolveSteamClientLaunchCommand('1091500', [], {
          platform: 'win32',
          userDataDir: tempDir,
          steamClientBinaryPath: fakeSteamExe,
          mockProcessListOutput: 'INFO: No tasks are running',
          storefrontClientLifecycle: 'minimal_keep_running',
        });
        expect(keepRunningCmd.useMinimalBinarySpawn).toBe(true);
        expect(keepRunningCmd.wokeSteamByLauncher).toBe(true);

        // 3. Steam already running -> falls back (does not spawn duplicate minimal binary)
        const alreadyRunningCmd = await launcherEngine.resolveSteamClientLaunchCommand(
          '1091500',
          [],
          {
            platform: 'win32',
            userDataDir: tempDir,
            steamClientBinaryPath: fakeSteamExe,
            mockProcessListOutput: 'steam.exe 4120 Console 1 124,000 K',
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          }
        );
        expect(alreadyRunningCmd.useMinimalBinarySpawn).toBe(false);
        expect(alreadyRunningCmd.alreadyRunning).toBe(true);
        expect(alreadyRunningCmd.wokeSteamByLauncher).toBe(false);

        // 4. Policy is default_client -> falls back
        const defaultClientCmd = await launcherEngine.resolveSteamClientLaunchCommand(
          '1091500',
          [],
          {
            platform: 'win32',
            userDataDir: tempDir,
            steamClientBinaryPath: fakeSteamExe,
            mockProcessListOutput: 'INFO: No tasks are running',
            storefrontClientLifecycle: 'default_client',
          }
        );
        expect(defaultClientCmd.useMinimalBinarySpawn).toBe(false);
        expect(defaultClientCmd.wokeSteamByLauncher).toBe(false);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('shuts down ephemeral GOG Galaxy or Steam clients via shutdownEphemeralStorefrontClient only when woken by One Launcher and policy is minimal_and_close_if_started', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ephemeral-shutdown-'));
      try {
        const fakeGalaxyExe = path.join(tempDir, 'GOG Galaxy', 'GalaxyClient.exe');
        const fakeSteamExe = path.join(tempDir, 'Steam', 'steam.exe');
        fs.mkdirSync(path.dirname(fakeGalaxyExe), { recursive: true });
        fs.mkdirSync(path.dirname(fakeSteamExe), { recursive: true });
        fs.writeFileSync(fakeGalaxyExe, 'MZ');
        fs.writeFileSync(fakeSteamExe, 'MZ');

        const spawnedCalls: Array<{ bin: string; args: string[] }> = [];
        const execCalls: Array<{ bin: string; args: string[] }> = [];

        // 1a. Windows GOG Galaxy woken by launcher -> GalaxyClient.exe /command=shutdown
        const winGogRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'gog',
            wokeGogGalaxyByLauncher: true,
            gogGalaxyClientPath: fakeGalaxyExe,
          },
          {
            platform: 'win32',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            spawnFn: (bin: string, args: string[]) => {
              spawnedCalls.push({ bin, args });
            },
          }
        );
        expect(winGogRes.closed).toBe(true);
        expect(spawnedCalls).toHaveLength(1);
        expect(spawnedCalls[0]).toEqual({
          bin: fakeGalaxyExe,
          args: ['/command=shutdown'],
        });

        // 1b. macOS GOG Galaxy woken by launcher -> /usr/bin/pkill -TERM -x "GOG Galaxy"
        const macGogRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'gog',
            wokeGogGalaxyByLauncher: true,
          },
          {
            platform: 'darwin',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            execFileFn: (bin: string, args: string[], _opts: any, cb: Function) => {
              execCalls.push({ bin, args });
              cb(null, '', '');
            },
          }
        );
        expect(macGogRes.closed).toBe(true);
        expect(macGogRes.method).toBe('sigterm_quit');
        expect(execCalls).toHaveLength(1);
        expect(execCalls[0]).toEqual({
          bin: '/usr/bin/pkill',
          args: ['-TERM', '-x', 'GOG Galaxy'],
        });

        // 2a. Windows Steam woken by launcher -> steam.exe -shutdown
        spawnedCalls.length = 0;
        const winSteamRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'steam',
            wokeSteamByLauncher: true,
            steamClientBinaryPath: fakeSteamExe,
          },
          {
            platform: 'win32',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            spawnFn: (bin: string, args: string[]) => {
              spawnedCalls.push({ bin, args });
            },
          }
        );
        expect(winSteamRes.closed).toBe(true);
        expect(spawnedCalls).toHaveLength(1);
        expect(spawnedCalls[0]).toEqual({
          bin: fakeSteamExe,
          args: ['-shutdown'],
        });

        // 2b. macOS Steam woken by launcher -> /usr/bin/pkill -TERM -x steam_osx
        execCalls.length = 0;
        const macSteamRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'steam',
            wokeSteamByLauncher: true,
          },
          {
            platform: 'darwin',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            execFileFn: (bin: string, args: string[], _opts: any, cb: Function) => {
              execCalls.push({ bin, args });
              cb(null, '', '');
            },
          }
        );
        expect(macSteamRes.closed).toBe(true);
        expect(macSteamRes.method).toBe('sigterm_quit');
        expect(execCalls).toHaveLength(1);
        expect(execCalls[0]).toEqual({
          bin: '/usr/bin/pkill',
          args: ['-TERM', '-x', 'steam_osx'],
        });

        // 3. Client was already running before launch (wokeSteamByLauncher: false) -> does NOT shut down
        spawnedCalls.length = 0;
        const notWokenRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'steam',
            wokeSteamByLauncher: false,
            steamClientBinaryPath: fakeSteamExe,
          },
          {
            platform: 'win32',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            spawnFn: (bin: string, args: string[]) => {
              spawnedCalls.push({ bin, args });
            },
          }
        );
        expect(notWokenRes.closed).toBe(false);
        expect(spawnedCalls).toHaveLength(0);

        // 4. Policy is minimal_keep_running -> does NOT shut down even if woken
        const keepPolicyRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          {
            platformId: 'steam',
            wokeSteamByLauncher: true,
            steamClientBinaryPath: fakeSteamExe,
          },
          {
            platform: 'win32',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_keep_running',
            spawnFn: (bin: string, args: string[]) => {
              spawnedCalls.push({ bin, args });
            },
          }
        );
        expect(keepPolicyRes.closed).toBe(false);
        expect(keepPolicyRes.reason).toBe('policy_keep_running');
        expect(spawnedCalls).toHaveLength(0);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('queues completed sessions when renderer is destroyed in zero_renderer_daemon mode and atomically drains them via drainPendingCompletedSessions', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-pending-sessions-'));
      try {
        launcherEngine.queuePendingCompletedSession(
          {
            sessionId: 'sess-headless-1',
            gameId: 'epic-alan-wake-2',
            title: 'Alan Wake 2',
            platformId: 'epic',
            platformGameId: 'alan-wake-2',
            sessionMinutesPlayed: 42,
            durationSeconds: 2520,
            lastPlayed: '2026-10-22T20:00:00.000Z',
          },
          { userDataDir: tempDir }
        );

        // Subsequent playtime_synced update for same sessionId merges storefrontTotalPlaytimeMinutes
        launcherEngine.queuePendingCompletedSession(
          {
            sessionId: 'sess-headless-1',
            gameId: 'epic-alan-wake-2',
            title: 'Alan Wake 2',
            platformId: 'epic',
            platformGameId: 'alan-wake-2',
            sessionMinutesPlayed: 0,
            durationSeconds: 2520,
            storefrontTotalPlaytimeMinutes: 180,
            lastPlayed: '2026-10-22T20:00:01.000Z',
          },
          { userDataDir: tempDir }
        );

        const drained = launcherEngine.drainPendingCompletedSessions({ userDataDir: tempDir });
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
          sessionId: 'sess-headless-1',
          gameId: 'epic-alan-wake-2',
          platformId: 'epic',
          sessionMinutesPlayed: 42,
          storefrontTotalPlaytimeMinutes: 180,
        });

        // Second drain returns empty array (atomic clear)
        const secondDrain = launcherEngine.drainPendingCompletedSessions({ userDataDir: tempDir });
        expect(secondDrain).toEqual([]);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('injects WINEDEBUG=-all in applyCrossOverPerGameSettings when suppressWineDebugLogging !== false and respects explicit launchConfig.wineDebug', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-winedebug-'));
      try {
        const defaultEnv: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'crossover' },
          {},
          defaultEnv,
          tempDir,
          { userDataDir: tempDir }
        );
        expect(defaultEnv.WINEDEBUG).toBe('-all');

        const customEnv: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'crossover' },
          { wineDebug: '+loaddll,err+all' },
          customEnv,
          tempDir,
          { userDataDir: tempDir }
        );
        expect(customEnv.WINEDEBUG).toBe('+loaddll,err+all');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('throttles requestScheduler and auto-pauses/resumes active downloads in launcherService during an active game session', async () => {
      expect(requestScheduler.isInGameThrottled()).toBe(false);
      requestScheduler.setInGameThrottle(true);
      expect(requestScheduler.isInGameThrottled()).toBe(true);
      requestScheduler.setInGameThrottle(false);
      expect(requestScheduler.isInGameThrottled()).toBe(false);

      const pausedTaskIds: string[] = [];
      const resumedTaskIds: string[] = [];
      let sessionUpdateCallback: ((data: any) => void) | null = null;

      (window as any).electronAPI = {
        ...(window as any).electronAPI,
        getPerformanceSettings: vi.fn().mockResolvedValue({
          inGameLauncherBehavior: 'hide_tray_hibernate',
          postGameLauncherBehavior: 'restore_window',
          pauseBackgroundSyncInGame: true,
          pauseDownloadsInGame: true,
          storefrontClientLifecycle: 'minimal_and_close_if_started',
          autoShutdownWinePrefixOnExit: true,
          suppressWineDebugLogging: true,
        }),
        drainPendingSessions: vi.fn().mockResolvedValue([]),
        getActiveSessions: vi.fn().mockResolvedValue([]),
        getDownloadQueue: vi.fn().mockResolvedValue([
          {
            taskId: 'dl-task-active-1',
            gameId: 'gog-cyberpunk',
            title: 'Cyberpunk 2077',
            platformId: 'gog',
            platformGameId: '1207664643',
            status: 'downloading',
            progressPercent: 45,
            bytesDownloaded: 450,
            totalBytes: 1000,
            speedBytesPerSec: 100,
            installDir: '/tmp/cp2077',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]),
        pauseDownload: vi.fn().mockImplementation(async (taskId: string) => {
          pausedTaskIds.push(taskId);
          return { success: true };
        }),
        resumeDownload: vi.fn().mockImplementation(async (taskId: string) => {
          resumedTaskIds.push(taskId);
          return { success: true };
        }),
        onSessionUpdated: vi.fn().mockImplementation((cb: (data: any) => void) => {
          sessionUpdateCallback = cb;
          return () => {};
        }),
        onDownloadUpdated: vi.fn().mockReturnValue(() => {}),
        onHibernateStateChanged: vi.fn().mockReturnValue(() => {}),
        scanAllInstalledGames: vi.fn().mockResolvedValue({ success: true, installedGames: [] }),
        detectCompatibilityLayers: vi.fn().mockResolvedValue([]),
        getGameLaunchConfigs: vi.fn().mockResolvedValue({}),
      };

      const testService = new LauncherService();
      await testService.initialize();

      expect(sessionUpdateCallback).toBeTypeOf('function');
      sessionUpdateCallback!({
        event: 'started',
        session: {
          sessionId: 'sess-1',
          gameId: 'steam-1091500',
          title: 'Cyberpunk 2077',
          platformId: 'steam',
          platformGameId: '1091500',
          status: 'running',
          startedAt: new Date().toISOString(),
        },
      });

      await new Promise((r) => setTimeout(r, 25));
      expect(requestScheduler.isInGameThrottled()).toBe(true);
      expect(pausedTaskIds).toContain('dl-task-active-1');

      sessionUpdateCallback!({
        event: 'stopped',
        session: {
          sessionId: 'sess-1',
          gameId: 'steam-1091500',
          title: 'Cyberpunk 2077',
          platformId: 'steam',
          platformGameId: '1091500',
          status: 'stopped',
          startedAt: new Date().toISOString(),
        },
        sessionMinutesPlayed: 5,
        durationSeconds: 300,
      });

      await new Promise((r) => setTimeout(r, 25));
      expect(requestScheduler.isInGameThrottled()).toBe(false);
      expect(resumedTaskIds).toContain('dl-task-active-1');
    });

    it('renders In-Game Performance & Resource Footprint controls in GameLaunchConfigModal', () => {
      const sampleGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        primaryPlatform: 'steam',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
          },
        ],
      } as any;

      const html = renderToString(
        React.createElement(GameLaunchConfigModal, {
          isOpen: true,
          game: sampleGame,
          onClose: vi.fn(),
        })
      );

      expect(html).toContain('data-testid="in-game-performance-section"');
      expect(html).toContain('data-testid="in-game-launcher-behavior-select"');
      expect(html).toContain('data-testid="post-game-launcher-behavior-select"');
      expect(html).toContain('data-testid="storefront-client-lifecycle-select"');
      expect(html).toContain('data-testid="toggle-pause-sync-in-game"');
      expect(html).toContain('data-testid="toggle-pause-downloads-in-game"');
      expect(html).toContain('data-testid="toggle-auto-shutdown-wine"');
    });
  });

  describe('37. Storefront Auth Self-Healing, Test Vault Isolation, GOG Size Resolution & Install Modal Steam Path Cleanup', () => {
    const storeSync = require('../../electron/storeSync.cjs');

    it('isolates storeSync.getTokensFilePath() to os.tmpdir() under Vitest and sanitizes poisoned mock tokens via isMockOrCorruptedToken and sanitizeStorefrontTokensObject', () => {
      // 1. Verify getTokensFilePath() under Vitest resolves inside os.tmpdir() and never touches real user home/Library
      const testVaultPath = storeSync.getTokensFilePath();
      expect(testVaultPath.startsWith(os.tmpdir())).toBe(true);
      expect(testVaultPath).toContain(`one-launcher-test-vault-${process.pid}`);

      // 2. Verify isMockOrCorruptedToken detects poisoned fixture tokens
      expect(storeSync.isMockOrCorruptedToken('epic-rotated-access-token')).toBe(true);
      expect(storeSync.isMockOrCorruptedToken('gog-rotated-refresh-token')).toBe(true);
      expect(storeSync.isMockOrCorruptedToken('freshly-renewed-token')).toBe(true);
      expect(storeSync.isMockOrCorruptedToken('mock-token-123')).toBe(true);
      expect(storeSync.isMockOrCorruptedToken('eg1~eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(false);

      // 3. Verify sanitizeStorefrontTokensObject strips poisoned tokens and restores epic.account_id from epic.in_app_id
      const rawPoisoned = {
        epic: {
          access_token: 'epic-rotated-access-token',
          refresh_token: 'epic-rotated-refresh-token',
          account_id: 'epic-user-1',
          in_app_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
          displayName: 'TestPlayerOne',
        },
        gog: {
          access_token: 'gog-rotated-access-token',
          refresh_token: 'gog-rotated-refresh-token',
          user_id: 'gog-user-1',
        },
      };

      const { cleaned, modified } = storeSync.sanitizeStorefrontTokensObject(rawPoisoned, {
        sanitizeMockTokens: true,
      });
      expect(modified).toBe(true);
      expect(cleaned.epic.access_token).toBeUndefined();
      expect(cleaned.epic.refresh_token).toBeUndefined();
      expect(cleaned.epic.account_id).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
      expect(cleaned.epic.displayName).toBe('TestPlayerOne');
      expect(cleaned.gog.access_token).toBeUndefined();
      expect(cleaned.gog.refresh_token).toBeUndefined();
      expect(cleaned.gog.user_id).toBeUndefined();
    });

    it('strips poisoned epic-rotated-* tokens in ensureLegendaryConfigAndAuth and recovers via recoverEpicAuthFn when refresh tokens are expired or missing', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-leg-selfheal-'));
      try {
        const userDataDir = path.join(tempDir, 'userData');
        const legDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
        fs.mkdirSync(legDir, { recursive: true });

        // Write a poisoned user.json on disk
        const poisonedUserJson = path.join(legDir, 'user.json');
        fs.writeFileSync(
          poisonedUserJson,
          JSON.stringify({
            access_token: 'epic-rotated-access-token',
            refresh_token: 'epic-rotated-refresh-token',
            account_id: 'epic-user-1',
            in_app_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
            displayName: 'TestPlayerOne',
          }),
          'utf8'
        );

        const savedEpicPayloads: any[] = [];
        const res = await launcherEngine.ensureLegendaryConfigAndAuth({
          homedir: tempDir,
          userDataDir,
          sanitizeMockTokens: true,
          savedTokens: {
            epic: {
              access_token: 'epic-rotated-access-token',
              refresh_token: 'epic-rotated-refresh-token',
              account_id: 'epic-user-1',
              in_app_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
              displayName: 'TestPlayerOne',
            },
          },
          storeSync: {
            saveTokens: (_platform: string, data: any) => {
              savedEpicPayloads.push(data);
            },
          },
          recoverEpicAuthFn: async () => ({
            access_token: 'eg1~real-recovered-epic-access-token',
            refresh_token: 'eg1~real-recovered-epic-refresh-token',
            expires_in: 7200,
            expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
            account_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
            displayName: 'TestPlayerOne',
          }),
        });

        expect(res.authenticated).toBe(true);
        expect(res.recoveredSession).toBe(true);
        expect(res.accessToken).toBe('eg1~real-recovered-epic-access-token');
        expect(res.accountId).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
        expect(savedEpicPayloads).toHaveLength(1);

        const onDiskUser = JSON.parse(fs.readFileSync(poisonedUserJson, 'utf8'));
        expect(onDiskUser.access_token).toBe('eg1~real-recovered-epic-access-token');
        expect(onDiskUser.account_id).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('strips poisoned gog-rotated-* tokens in ensureGogdlAuthConfig, recovers from Heroic gog_store/auth.json, and returns both gogAuthPath and configPath', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-selfheal-'));
      try {
        const userDataDir = path.join(tempDir, 'userData');
        const oneLauncherGogAuth = path.join(userDataDir, 'gog_store', 'auth.json');
        fs.mkdirSync(path.dirname(oneLauncherGogAuth), { recursive: true });

        // Poisoned One Launcher auth.json
        fs.writeFileSync(
          oneLauncherGogAuth,
          JSON.stringify({
            '46899977096215655': {
              access_token: 'gog-rotated-access-token',
              refresh_token: 'gog-rotated-refresh-token',
              user_id: 'gog-user-1',
            },
          }),
          'utf8'
        );

        // Valid Heroic gog_store/auth.json in homedir
        const heroicGogAuth = path.join(
          tempDir,
          'Library/Application Support/heroic/gog_store/auth.json'
        );
        fs.mkdirSync(path.dirname(heroicGogAuth), { recursive: true });
        fs.writeFileSync(
          heroicGogAuth,
          JSON.stringify({
            '46899977096215655': {
              access_token: 'real-heroic-gog-access-token',
              refresh_token: 'real-heroic-gog-refresh-token',
              user_id: '10000000000000000',
              expires_in: 3600,
              loginTime: Math.floor(Date.now() / 1000),
            },
          }),
          'utf8'
        );

        const savedGogPayloads: any[] = [];
        const res = await launcherEngine.ensureGogdlAuthConfig({
          homedir: tempDir,
          userDataDir,
          sanitizeMockTokens: true,
          savedTokens: {
            gog: {
              access_token: 'gog-rotated-access-token',
              refresh_token: 'gog-rotated-refresh-token',
              user_id: 'gog-user-1',
            },
          },
          storeSync: {
            renewGogTokens: async (refreshToken: string) => ({
              access_token: `renewed-from-${refreshToken}`,
              refresh_token: 'renewed-real-gog-refresh-token',
              user_id: '10000000000000000',
              expires_in: 3600,
              updatedAt: new Date().toISOString(),
            }),
            saveTokens: (_platform: string, data: any) => {
              savedGogPayloads.push(data);
            },
          },
          forceTokenRefresh: true,
        });

        expect(res.authenticated).toBe(true);
        expect(res.gogAuthPath).toBe(oneLauncherGogAuth);
        expect(res.configPath).toBe(oneLauncherGogAuth);
        expect(res.accessToken).toBe('renewed-from-real-heroic-gog-refresh-token');
        expect(res.userId).toBe('10000000000000000');
        expect(savedGogPayloads.length).toBeGreaterThanOrEqual(1);

        const diskAuth = JSON.parse(fs.readFileSync(oneLauncherGogAuth, 'utf8'));
        expect(diskAuth['46899977096215655'].access_token).toBe(
          'renewed-from-real-heroic-gog-refresh-token'
        );
        expect(diskAuth['46899977096215655'].user_id).toBe('10000000000000000');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('renders steam-library-location-display in GameInstallModal without steam-library-drive-select, switches between Native and CrossOver Bottle Steam paths on OS toggle, and hides duplicate Installer Build select when 2 OS build cards are shown', async () => {
      const prevHost = vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
      const prevGetInfo = vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
        gameId: 'steam-400',
        platformId: 'steam',
        platformGameId: '400',
        defaultInstallDir: '/Users/test/Library/Application Support/Steam/steamapps/common',
        availableInstallDirs: [
          '/Users/test/Library/Application Support/Steam/steamapps/common',
          '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common',
        ],
        estimatedSizeBytes: 5_000_000_000,
        availableInstallers: [
          {
            id: 'steam_mac',
            name: 'Portal — macOS Native Build',
            os: 'mac',
            totalSizeBytes: 5_000_000_000,
          },
          {
            id: 'steam_win',
            name: 'Portal — Windows Build (CrossOver / Wine)',
            os: 'windows',
            totalSizeBytes: 5_000_000_000,
          },
        ],
        diskSpace: {
          freeBytes: 250_000_000_000,
          totalBytes: 500_000_000_000,
        },
      } as any);
      const prevGetLayers = vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
        {
          id: 'crossover',
          type: 'crossover',
          name: 'CrossOver',
          binaryPath: '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
          bottlesDir: '/Users/test/Library/Application Support/CrossOver/Bottles',
          availableBottles: ['Steam', 'OneLauncher'],
        },
      ]);

      try {
        const dualBuildSteamGame: CanonicalGame = {
          id: 'steam-400',
          title: 'Portal',
          primaryPlatform: 'steam',
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '400',
              installed: false,
            },
          ],
          osSupport: ['mac', 'windows'],
        } as any;

        const states: any[] = [];
        const effects: boolean[] = [];
        const internals =
          (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

        const doRender = () => {
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
              if (!effects[idx]) {
                effects[idx] = true;
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
              game: dualBuildSteamGame,
              initialPlatformId: 'steam',
              onClose: vi.fn(),
            });
            const html = renderToString(vnode).replace(/<!--\s*-->/g, '');
            return { vnode, html };
          } finally {
            internals.H = prevH;
          }
        };

        doRender();
        await new Promise((r) => setTimeout(r, 20));
        const macRender = doRender();

        // 1. Native macOS selected by default -> displays Native Steam Library path, no drive-select dropdown, and no duplicate Installer Build select
        expect(macRender.html).toContain('data-testid="steam-library-location-display"');
        expect(macRender.html).not.toContain('data-testid="steam-library-drive-select"');
        expect(macRender.html).not.toContain('aria-label="Installer Build"');
        expect(macRender.html).toContain(
          '/Users/test/Library/Application Support/Steam/steamapps/common'
        );
        expect(macRender.html).toContain('Native Steam Library');

        // 2. Click Windows Build card -> switches dynamically to CrossOver Bottle Steam Library path
        const findElement = (node: any, pred: (el: any) => boolean): any => {
          if (!node || typeof node !== 'object') return null;
          if (Array.isArray(node)) {
            for (const c of node) {
              const found = findElement(c, pred);
              if (found) return found;
            }
            return null;
          }
          if (pred(node)) return node;
          if (node.props?.children) return findElement(node.props.children, pred);
          return null;
        };

        const winBuildCard = findElement(
          macRender.vnode,
          (el) => el.props?.['data-testid'] === 'install-option-win-compat'
        );
        expect(winBuildCard).toBeTruthy();
        winBuildCard.props.onClick();

        const winRender = doRender();
        expect(winRender.html).toContain('data-testid="steam-library-location-display"');
        expect(winRender.html).toContain(
          '/Users/test/Library/Application Support/CrossOver/Bottles/Steam/drive_c/Program Files (x86)/Steam/steamapps/common'
        );
        expect(winRender.html).toContain('CrossOver / Wine Bottle Steam Library (Steam)');
      } finally {
        prevHost.mockRestore();
        prevGetInfo.mockRestore();
        prevGetLayers.mockRestore();
      }
    });
  });

  describe('38. GOG macOS/Windows Launch Integrity & Epic Trophies / Cloud Playtime Verification', () => {
    const storeSync = require('../../electron/storeSync.cjs');

    it('Task 1A: doesGogInstallUseGalaxySdk detects libGalaxy64.dylib, Galaxy64.dll, or GalaxyPeer.json and returns false for pure DRM-free games', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-sdk-detect-'));
      try {
        // 1. Pure DRM-free macOS .app bundle without Galaxy SDK -> false
        const drmFreeAppDir = path.join(tempDir, 'Janosik', 'Janosik.app', 'Contents', 'MacOS');
        fs.mkdirSync(drmFreeAppDir, { recursive: true });
        const drmFreeBin = path.join(drmFreeAppDir, 'Janosik');
        fs.writeFileSync(drmFreeBin, '#!/bin/sh\nexit 0\n');
        expect(
          launcherEngine.doesGogInstallUseGalaxySdk(path.join(tempDir, 'Janosik'), drmFreeBin)
        ).toBe(false);

        // 2. macOS .app bundle with libGalaxy64.dylib in Contents/Frameworks -> true
        const sdkMacFrameworks = path.join(
          tempDir,
          'HollowKnight',
          'Hollow Knight.app',
          'Contents',
          'Frameworks'
        );
        fs.mkdirSync(sdkMacFrameworks, { recursive: true });
        fs.writeFileSync(path.join(sdkMacFrameworks, 'libGalaxy64.dylib'), 'MACHO');
        expect(
          launcherEngine.doesGogInstallUseGalaxySdk(
            path.join(tempDir, 'HollowKnight'),
            path.join(tempDir, 'HollowKnight', 'Hollow Knight.app')
          )
        ).toBe(true);

        // 3. Windows folder with Galaxy64.dll -> true
        const winSdkDir = path.join(tempDir, 'Cyberpunk');
        fs.mkdirSync(winSdkDir, { recursive: true });
        fs.writeFileSync(path.join(winSdkDir, 'Galaxy64.dll'), 'MZ');
        expect(launcherEngine.doesGogInstallUseGalaxySdk(winSdkDir, '')).toBe(true);

        // 4. Folder with GalaxyPeer.json -> true
        const peerDir = path.join(tempDir, 'Witcher3');
        fs.mkdirSync(peerDir, { recursive: true });
        fs.writeFileSync(path.join(peerDir, 'GalaxyPeer.json'), '{}');
        expect(launcherEngine.doesGogInstallUseGalaxySdk(peerDir, '')).toBe(true);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 1B: ensureGogGalaxyBackgroundService on darwin spawns /usr/bin/open with [-g, -j, -a, clientPath, --args, --launchViaAutoStart]', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-gog-darwin-wake-'));
      try {
        const macGalaxyApp = path.join(tempDir, 'Applications', 'GOG Galaxy.app');
        fs.mkdirSync(path.join(macGalaxyApp, 'Contents', 'MacOS'), { recursive: true });

        const spawnedCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
        const res = await launcherEngine.ensureGogGalaxyBackgroundService({
          platform: 'darwin',
          homedir: tempDir,
          gogGalaxyClientPath: macGalaxyApp,
          mockProcessListOutput: '/sbin/launchd\n',
          allowGogWakeInTest: true,
          spawnFn: (cmd: string, args: string[], opts: any) => {
            spawnedCalls.push({ cmd, args, opts });
            return { unref: () => {} };
          },
        });

        expect(res).toEqual({
          found: true,
          alreadyRunning: false,
          started: true,
          clientPath: macGalaxyApp,
        });
        expect(spawnedCalls).toHaveLength(1);
        expect(spawnedCalls[0].cmd).toBe('/usr/bin/open');
        expect(spawnedCalls[0].args).toEqual([
          '-g',
          '-j',
          '-a',
          macGalaxyApp,
          '--args',
          '--launchViaAutoStart',
          '--runWithoutUpdating',
        ]);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 1C: launchGame records exitCode: -1, crashedEarly error, and sessionMinutesPlayed: 0 when child process is killed by SIGKILL', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-sigkill-crash-'));
      const events: any[] = [];
      const unsubscribe = launcherEngine.onSessionUpdated((payload: any) => {
        events.push(payload);
      });
      try {
        const scriptPath = path.join(tempDir, 'sigkill_self.sh');
        fs.writeFileSync(scriptPath, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });

        const { EventEmitter } = require('node:events');
        const winSigkillSpawnOption =
          process.platform === 'win32'
            ? {
                gameSpawnFn: () => {
                  const child: any = new EventEmitter();
                  child.pid = 91827;
                  child.stderr = new EventEmitter();
                  child.stdout = new EventEmitter();
                  child.unref = () => {};
                  child.kill = () => true;
                  setTimeout(() => child.emit('exit', null, 'SIGKILL'), 25);
                  return child;
                },
              }
            : {};

        const launchRes = await launcherEngine.launchGame(
          {
            gameId: 'gog-sigkill-test',
            title: 'SIGKILL Test Game',
            platformId: 'gog',
            platformGameId: '999999',
            installPath: tempDir,
            executablePath: scriptPath,
          },
          {
            homedir: tempDir,
            userDataDir: tempDir,
            ...winSigkillSpawnOption,
          }
        );
        expect(launchRes.success).toBe(true);

        // Wait for process to terminate via SIGKILL and finalizeSession to fire
        for (let i = 0; i < 40; i++) {
          if (events.some((e) => e.event === 'stopped')) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        const stoppedEvent = events.find((e) => e.event === 'stopped');
        expect(stoppedEvent).toBeDefined();
        expect(stoppedEvent.sessionMinutesPlayed).toBe(0);
        expect(stoppedEvent.error).toContain('SIGKILL');
      } finally {
        unsubscribe();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 2A: resolveEpicLaunchAuthArguments extracts deploymentId from sidecar.config.deploymentId and auto-renews expired Epic token on 401/403', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-epic-deploy-auth-'));
      try {
        const userDataDir = path.join(tempDir, 'userData');
        const legMetaDir = path.join(userDataDir, 'legendaryConfig', 'legendary', 'metadata');
        fs.mkdirSync(legMetaDir, { recursive: true });

        const appName = '0000000000000000000000000000aaaa';
        fs.writeFileSync(
          path.join(legMetaDir, `${appName}.json`),
          JSON.stringify({
            app_name: appName,
            app_title: 'Hollow Knight',
            namespace: '0000000000000000000000000000bbbb',
            catalog_item_id: '0000000000000000000000000000cccc',
            sidecar: {
              config: {
                deploymentId: '0000000000000000000000000000dddd',
              },
            },
          }),
          'utf8'
        );

        const exchangeCalls: string[] = [];
        const authRes = await launcherEngine.resolveEpicLaunchAuthArguments(
          {
            gameId: `epic-${appName}`,
            platformId: 'epic',
            platformGameId: appName,
          },
          {
            homedir: tempDir,
            userDataDir,
            savedTokens: {
              epic: {
                access_token: 'expired-epic-access-token',
                refresh_token: 'valid-epic-refresh-token',
                expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                account_id: '00000000000000000000000000000042',
                displayName: 'SyntheticEpicPlayer',
              },
            },
            renewEpicTokensFn: async (rt: string) => ({
              access_token: `renewed-epic-token-from-${rt}`,
              refresh_token: 'new-epic-refresh-token',
              account_id: '00000000000000000000000000000042',
              displayName: 'SyntheticEpicPlayer',
            }),
            fetchFn: async (_url: string, opts: any) => {
              const authHeader = opts?.headers?.Authorization || '';
              exchangeCalls.push(authHeader);
              if (authHeader.includes('expired-epic-access-token')) {
                return {
                  ok: false,
                  status: 401,
                  text: async () => JSON.stringify({ errorCode: 'errors.com.epicgames.common.oauth.invalid_token' }),
                };
              }
              return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ code: 'live-eos-exchange-code-999' }),
              };
            },
          }
        );

        expect(exchangeCalls).toHaveLength(2);
        expect(authRes.authenticated).toBe(true);
        expect(authRes.deploymentId).toBe('0000000000000000000000000000dddd');
        expect(authRes.exchangeCode).toBe('live-eos-exchange-code-999');
        expect(authRes.args).toContain('-AUTH_PASSWORD=live-eos-exchange-code-999');
        expect(authRes.args).toContain('-epicdeploymentid=0000000000000000000000000000dddd');
        expect(authRes.args).toContain('-epicsandboxid=0000000000000000000000000000bbbb');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 2B: syncSessionPlaytimeToStorefront automatically renews expired Epic and GOG tokens on 401/403 and retries PUT/POST playtime upload', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-playtime-401-retry-'));
      try {
        const userDataDir = path.join(tempDir, 'userData');
        fs.mkdirSync(userDataDir, { recursive: true });

        // 1. Epic 401 -> renewEpicTokensFn -> retry PUT -> synced: true
        const epicPutHeaders: string[] = [];
        const epicSyncRes = await launcherEngine.syncSessionPlaytimeToStorefront(
          {
            gameId: 'epic-hollow-knight',
            platformId: 'epic',
            platformGameId: '0000000000000000000000000000aaaa',
            durationSeconds: 600,
            sessionMinutesPlayed: 10,
          },
          {
            homedir: tempDir,
            userDataDir,
            savedTokens: {
              epic: {
                access_token: 'expired-epic-token',
                refresh_token: 'valid-epic-rt',
                expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                account_id: '00000000000000000000000000000042',
              },
            },
            renewEpicTokensFn: async () => ({
              access_token: 'fresh-epic-token-after-401',
              refresh_token: 'fresh-epic-rt',
              account_id: '00000000000000000000000000000042',
            }),
            fetchFn: async (_url: string, opts: any) => {
              if (opts.method === 'PUT') {
                epicPutHeaders.push(opts.headers.Authorization);
                if (opts.headers.Authorization.includes('expired-epic-token')) {
                  return { ok: false, status: 401, text: async () => '' };
                }
                return { ok: true, status: 204, text: async () => '' };
              }
              return {
                ok: true,
                status: 200,
                text: async () =>
                  JSON.stringify([
                    {
                      artifactId: '0000000000000000000000000000aaaa',
                      totalTime: 1800,
                    },
                  ]),
              };
            },
          }
        );

        expect(epicPutHeaders).toHaveLength(2);
        expect(epicSyncRes).toEqual({
          synced: true,
          platformId: 'epic',
          artifactId: '0000000000000000000000000000aaaa',
          storefrontTotalPlaytimeMinutes: 30,
        });

        // 2. GOG 401 -> renewGogTokensFn -> retry POST -> synced: true
        const gogPostHeaders: string[] = [];
        const gogSyncRes = await launcherEngine.syncSessionPlaytimeToStorefront(
          {
            gameId: 'gog-1200000001',
            platformId: 'gog',
            platformGameId: '1200000001',
            durationSeconds: 900,
            sessionMinutesPlayed: 15,
          },
          {
            homedir: tempDir,
            userDataDir,
            skipNetwork: true,
            savedTokens: {
              gog: {
                access_token: 'expired-gog-token',
                refresh_token: 'valid-gog-rt',
                user_id: '10000000000000042',
              },
            },
            renewGogTokensFn: async () => ({
              access_token: 'fresh-gog-token-after-401',
              refresh_token: 'fresh-gog-rt',
              user_id: '10000000000000042',
            }),
            fetchFn: async (_url: string, opts: any) => {
              gogPostHeaders.push(opts.headers.Authorization);
              if (opts.headers.Authorization.includes('expired-gog-token')) {
                return { ok: false, status: 401, text: async () => '' };
              }
              return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ total_time: 45 }),
              };
            },
          }
        );

        expect(gogPostHeaders).toHaveLength(2);
        expect(gogSyncRes).toEqual({
          synced: true,
          platformId: 'gog',
          gameId: '1200000001',
          storefrontTotalPlaytimeMinutes: 45,
        });
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('Task 2C: storeSync.getEpicGameAchievementSchema unwraps achievement definitions and storeSync.fetchEpicAchievements seeds local Legendary totals and overlays live GraphQL progress', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-epic-ach-schema-'));
      try {
        const metaDir = path.join(
          tempDir,
          'Library/Application Support/heroic/legendaryConfig/legendary/metadata'
        );
        fs.mkdirSync(metaDir, { recursive: true });

        const appName = '0000000000000000000000000000aaaa';
        const sandboxId = '0000000000000000000000000000bbbb';
        fs.writeFileSync(
          path.join(metaDir, `${appName}.json`),
          JSON.stringify({
            app_name: appName,
            app_title: 'Hollow Knight',
            namespace: sandboxId,
            catalog_item_id: '0000000000000000000000000000cccc',
            achievements: {
              total_achievements: 2,
              total_product_xp: 250,
              achievements: [
                {
                  achievement: {
                    achievement_id: 'ach_forest',
                    unlocked_display_name: 'Forest Explorer',
                    unlocked_description: 'Complete all forest areas',
                    xp: 100,
                    completed_percent: 42.5,
                    unlocked_icon_url: 'https://cdn.epicgames.com/forest_unlocked.png',
                    locked_icon_url: 'https://cdn.epicgames.com/forest_locked.png',
                  },
                },
                {
                  achievement: {
                    achievement_id: 'ach_city',
                    unlocked_display_name: 'City Finder',
                    unlocked_description: 'Complete all city areas',
                    xp: 150,
                    completed_percent: 18.2,
                    unlocked_icon_url: 'https://cdn.epicgames.com/city_unlocked.png',
                    locked_icon_url: 'https://cdn.epicgames.com/city_locked.png',
                  },
                },
              ],
            },
          }),
          'utf8'
        );

        // 1. Verify getEpicGameAchievementSchema unwraps nested { achievement: { ... } } definitions
        const schema = await storeSync.getEpicGameAchievementSchema(
          { appName },
          { homedir: tempDir }
        );
        expect(schema).toHaveLength(2);
        expect(schema[0]).toMatchObject({
          id: 'ach_forest',
          name: 'Forest Explorer',
          description: 'Complete all forest areas',
          xp: 100,
          globalPercentage: 42.5,
          iconUnlockedUrl: 'https://cdn.epicgames.com/forest_unlocked.png',
          iconLockedUrl: 'https://cdn.epicgames.com/forest_locked.png',
        });

        // 2. Verify fetchEpicAchievements seeds local totals (skipNetwork: true) under appName, epic-${appName}, sandboxId, and title
        const seededMap = await storeSync.fetchEpicAchievements('token', 'acc-1', {
          homedir: tempDir,
          skipNetwork: true,
        });
        expect(seededMap[appName]).toMatchObject({
          unlocked: 0,
          total: 2,
          percentage: 0,
          xp: { earned: 0, total: 250 },
          source: 'local_client_cache',
        });
        expect(seededMap[`epic-${appName}`]).toBeDefined();
        expect(seededMap[sandboxId]).toBeDefined();
        expect(seededMap['hollow knight']).toBeDefined();

        // 3. Verify live GraphQL response overlays unlocked progress onto appName, epic-${appName}, sandboxId, and title
        const liveMap = await storeSync.fetchEpicAchievements('token', 'acc-1', {
          homedir: tempDir,
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                PlayerProfile: {
                  playerProfile: {
                    achievementsSummaries: {
                      data: [
                        {
                          sandboxId,
                          totalUnlocked: 1,
                          totalXP: 100,
                          product: { name: 'Hollow Knight', slug: 'hollow-knight' },
                          productAchievements: {
                            totalAchievements: 2,
                            totalProductXP: 250,
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          }),
        });
        expect(liveMap[appName]).toMatchObject({
          unlocked: 1,
          total: 2,
          percentage: 50,
          xp: { earned: 100, total: 250 },
          source: 'live_cloud_graphql',
        });
        expect(liveMap[`epic-${appName}`]?.unlocked).toBe(1);
        expect(liveMap[sandboxId]?.unlocked).toBe(1);
        expect(liveMap['hollow knight']?.unlocked).toBe(1);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // =========================================================================
  // 39. macOS TCC PERMISSION HARDENING & STOREFRONT CLOUD SAVE / FOOTPRINT COEXISTENCE
  // =========================================================================
  describe('39. macOS TCC Permission Hardening & Storefront Cloud Save / Footprint Coexistence', () => {
    it('sandboxWinePrefixUserFolders replaces symlinks to host TCC folders with bottle-local directories while leaving external targets intact', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-tcc-sandbox-'));
      try {
        const fakeHostHome = path.join(tempDir, 'host-home');
        const hostDocs = path.join(fakeHostHome, 'Documents');
        const hostDesktop = path.join(fakeHostHome, 'Desktop');
        const hostDownloads = path.join(fakeHostHome, 'Downloads');
        fs.mkdirSync(hostDocs, { recursive: true });
        fs.mkdirSync(hostDesktop, { recursive: true });
        fs.mkdirSync(hostDownloads, { recursive: true });
        const sentinelDocFile = path.join(hostDocs, 'important-host-doc.txt');
        fs.writeFileSync(sentinelDocFile, 'DO_NOT_DELETE', 'utf8');

        const bottleDir = path.join(tempDir, 'Bottles', 'OneLauncher');
        const wineUserDir = path.join(bottleDir, 'drive_c', 'users', 'crossover');
        fs.mkdirSync(wineUserDir, { recursive: true });

        // Create external symlinks (pointing to fakeHostHome TCC folders)
        const dirSymlinkType = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(hostDocs, path.join(wineUserDir, 'Documents'), dirSymlinkType);
        fs.symlinkSync(hostDesktop, path.join(wineUserDir, 'Desktop'), dirSymlinkType);
        fs.symlinkSync(hostDownloads, path.join(wineUserDir, 'Downloads'), dirSymlinkType);

        // Create an internal symlink (pointing inside the bottle prefix) that should NOT be removed
        const internalTarget = path.join(wineUserDir, 'Saved Games');
        fs.mkdirSync(internalTarget, { recursive: true });
        fs.symlinkSync(internalTarget, path.join(wineUserDir, 'Pictures'), dirSymlinkType);

        const res = launcherEngine.sandboxWinePrefixUserFolders(bottleDir);
        expect(res.sandboxedFolders.map((f: any) => f.folder).sort()).toEqual([
          'Desktop',
          'Documents',
          'Downloads',
        ]);

        // Verify bottle folders are now real directories (not symlinks) and Documents/My Games exists
        for (const folder of ['Documents', 'Desktop', 'Downloads']) {
          const p = path.join(wineUserDir, folder);
          const st = fs.lstatSync(p);
          expect(st.isSymbolicLink()).toBe(false);
          expect(st.isDirectory()).toBe(true);
        }
        expect(fs.existsSync(path.join(wineUserDir, 'Documents', 'My Games'))).toBe(true);

        // Verify internal symlink was preserved
        expect(fs.lstatSync(path.join(wineUserDir, 'Pictures')).isSymbolicLink()).toBe(true);

        // Verify external host folders and sentinel file are 100% untouched
        expect(fs.existsSync(hostDocs)).toBe(true);
        expect(fs.existsSync(hostDesktop)).toBe(true);
        expect(fs.existsSync(hostDownloads)).toBe(true);
        expect(fs.readFileSync(sentinelDocFile, 'utf8')).toBe('DO_NOT_DELETE');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('shutdownEphemeralStorefrontClient refuses to shut down during active downloads, honors cloudSyncGraceMs, and uses pkill on darwin', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ephemeral-guard-'));
      try {
        launcherEngine.clearDownloadQueue();

        // 1. Refuses when options.hasActiveDownloads is true
        const blockedByFlag = await launcherEngine.shutdownEphemeralStorefrontClient(
          { platformId: 'steam', wokeSteamByLauncher: true },
          {
            platform: 'darwin',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            hasActiveDownloads: true,
          }
        );
        expect(blockedByFlag).toMatchObject({
          closed: false,
          shutDown: false,
          reason: 'active_download_in_progress',
        });

        // 2. Refuses when an active download for the same platform exists in downloadQueueMap
        const steamDlRes = await launcherEngine.installGame(
          {
            gameId: 'steam-400',
            title: 'Portal',
            platformId: 'steam',
            platformGameId: '400',
            installDir: path.join(tempDir, 'Downloads'),
            totalBytes: 100 * 1024 * 1024,
            manualControl: true,
          },
          { userDataDir: tempDir }
        );
        expect(steamDlRes.success).toBe(true);
        const blockedByQueue = await launcherEngine.shutdownEphemeralStorefrontClient(
          { platformId: 'steam', wokeSteamByLauncher: true },
          {
            platform: 'darwin',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
          }
        );
        expect(blockedByQueue).toMatchObject({
          closed: false,
          shutDown: false,
          reason: 'active_download_in_progress',
        });

        launcherEngine.clearDownloadQueue();

        // 3. Honors cloudSyncGraceMs delay and uses /usr/bin/pkill -TERM -x on darwin
        const execCalls: Array<{ bin: string; args: string[] }> = [];
        const t0 = Date.now();
        const graceRes = await launcherEngine.shutdownEphemeralStorefrontClient(
          { platformId: 'gog', wokeGogGalaxyByLauncher: true },
          {
            platform: 'darwin',
            userDataDir: tempDir,
            storefrontClientLifecycle: 'minimal_and_close_if_started',
            cloudSyncGraceMs: 60,
            execFileFn: (bin: string, args: string[], _opts: any, cb: Function) => {
              execCalls.push({ bin, args });
              cb(null, '', '');
            },
          }
        );
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(graceRes).toMatchObject({
          closed: true,
          shutDown: true,
          platformId: 'gog',
          method: 'sigterm_quit',
        });
        expect(execCalls).toEqual([
          {
            bin: '/usr/bin/pkill',
            args: ['-TERM', '-x', 'GOG Galaxy'],
          },
        ]);
      } finally {
        launcherEngine.clearDownloadQueue();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('pauseActiveDownloadsForInGame and resumeDownloadsPausedByInGame manage main-process downloads without a renderer window', async () => {
      launcherEngine.clearDownloadQueue();
      try {
        const epicDl = await launcherEngine.installGame(
          {
            gameId: 'epic-celeste',
            title: 'Celeste',
            platformId: 'epic',
            platformGameId: 'Celeste',
            installDir: path.join(tmpRoot, 'Downloads', 'Epic'),
            totalBytes: 500 * 1024 * 1024,
            manualControl: true,
          },
          { userDataDir }
        );
        const gogDl = await launcherEngine.installGame(
          {
            gameId: 'gog-123',
            title: 'Manual Paused Game',
            platformId: 'gog',
            platformGameId: '123',
            installDir: path.join(tmpRoot, 'Downloads', 'GOG'),
            totalBytes: 500 * 1024 * 1024,
            manualControl: true,
          },
          { userDataDir }
        );
        const epicTaskId = epicDl.task.taskId;
        const gogTaskId = gogDl.task.taskId;
        launcherEngine.pauseDownload(gogTaskId);

        const pauseRes = launcherEngine.pauseActiveDownloadsForInGame({ userDataDir });
        expect(pauseRes.pausedTaskIds).toEqual([epicTaskId]);
        expect(launcherEngine.getPausedByInGameTaskIds()).toEqual([epicTaskId]);

        const queueDuringGame = launcherEngine.getDownloadQueue();
        const epicDuringGame = queueDuringGame.find((t: any) => t.taskId === epicTaskId);
        expect(epicDuringGame?.status).toBe('paused');
        expect(epicDuringGame?.statusMessage).toBe('Paused while in-game');

        const resumeRes = launcherEngine.resumeDownloadsPausedByInGame({ userDataDir });
        expect(resumeRes.resumedTaskIds).toEqual([epicTaskId]);
        expect(launcherEngine.getPausedByInGameTaskIds()).toEqual([]);

        const queueAfterGame = launcherEngine.getDownloadQueue();
        const epicAfterGame = queueAfterGame.find((t: any) => t.taskId === epicTaskId);
        const manualPausedAfterGame = queueAfterGame.find((t: any) => t.taskId === gogTaskId);
        expect(epicAfterGame?.status).toBe('downloading');
        expect(manualPausedAfterGame?.status).toBe('paused');
      } finally {
        launcherEngine.clearDownloadQueue();
      }
    });

    it('syncEpicCloudSaves detects CloudSaveFolder in Legendary metadata and runs pre_launch (--skip-upload) and post_exit (--skip-download)', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-epic-cloudsaves-'));
      try {
        const metaDir = path.join(tempDir, 'legendaryConfig', 'legendary', 'metadata');
        fs.mkdirSync(metaDir, { recursive: true });

        // Game 1: Has CloudSaveFolder
        fs.writeFileSync(
          path.join(metaDir, 'CloudGameApp.json'),
          JSON.stringify({
            app_name: 'CloudGameApp',
            app_title: 'Cloud Save Adventure',
            metadata: {
              customAttributes: {
                CloudSaveFolder: {
                  type: 'STRING',
                  value: '{AppData}/CloudSaveAdventure/Saves/',
                },
              },
            },
          }),
          'utf8'
        );

        // Game 2: No CloudSaveFolder
        fs.writeFileSync(
          path.join(metaDir, 'OfflineGameApp.json'),
          JSON.stringify({
            app_name: 'OfflineGameApp',
            app_title: 'Offline Only Game',
            metadata: {
              customAttributes: {},
            },
          }),
          'utf8'
        );

        const execCalls: Array<{ bin: string; args: string[]; env: any }> = [];
        const mockExecFile = (bin: string, args: string[], opts: any, cb: Function) => {
          execCalls.push({ bin, args, env: opts?.env });
          cb(null, 'Sync complete', '');
        };

        const expectedSavePath = launcherEngine.resolveEpicSavePathTemplate(
          '{AppData}/CloudSaveAdventure/Saves/',
          { homedir: tempDir }
        );

        // 1. Pre-launch cloud save pull (--skip-upload)
        const preRes = await launcherEngine.syncEpicCloudSaves(
          { appName: 'CloudGameApp' },
          'pre_launch',
          {
            homedir: tempDir,
            userDataDir: tempDir,
            legendaryBinaryPath: '/mock/bin/legendary',
            execFileFn: mockExecFile,
          }
        );
        expect(preRes).toMatchObject({
          synced: true,
          appName: 'CloudGameApp',
          mode: 'pre_launch',
          args: ['sync-saves', 'CloudGameApp', '-y', '--skip-upload', '--save-path', expectedSavePath],
          cloudSaveFolder: '{AppData}/CloudSaveAdventure/Saves/',
        });

        // 2. Post-exit cloud save push (--skip-download)
        const postRes = await launcherEngine.syncEpicCloudSaves(
          { appName: 'CloudGameApp' },
          'post_exit',
          {
            homedir: tempDir,
            userDataDir: tempDir,
            legendaryBinaryPath: '/mock/bin/legendary',
            execFileFn: mockExecFile,
          }
        );
        expect(postRes).toMatchObject({
          synced: true,
          appName: 'CloudGameApp',
          mode: 'post_exit',
          args: ['sync-saves', 'CloudGameApp', '-y', '--skip-download', '--save-path', expectedSavePath],
        });
        expect(execCalls).toHaveLength(2);
        expect(execCalls[0].bin).toBe('/mock/bin/legendary');
        expect(execCalls[0].args).toEqual([
          'sync-saves',
          'CloudGameApp',
          '-y',
          '--skip-upload',
          '--save-path',
          expectedSavePath,
        ]);
        expect(execCalls[1].args).toEqual([
          'sync-saves',
          'CloudGameApp',
          '-y',
          '--skip-download',
          '--save-path',
          expectedSavePath,
        ]);

        // 3. Game without CloudSaveFolder -> skips cleanly without invoking legendary
        const skipRes = await launcherEngine.syncEpicCloudSaves(
          { appName: 'OfflineGameApp' },
          'pre_launch',
          {
            homedir: tempDir,
            userDataDir: tempDir,
            legendaryBinaryPath: '/mock/bin/legendary',
            execFileFn: mockExecFile,
          }
        );
        expect(skipRes).toMatchObject({
          synced: false,
          appName: 'OfflineGameApp',
          reason: 'no_cloud_save_folder_or_skipped',
        });
        expect(execCalls).toHaveLength(2);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});
