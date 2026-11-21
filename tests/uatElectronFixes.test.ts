import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '..');

interface ScannedInstalledGame {
  platformId: string;
  platformGameId: string;
  title?: string;
  installPath?: string;
  executablePath?: string;
  executableArchitecture?: string;
  is32BitExecutable?: boolean;
  isWindowsBinaryOnMac?: boolean;
}

interface InstalledScanResult {
  success: boolean;
  installedGames: ScannedInstalledGame[];
  installedSteamAppIds: number[];
}

interface InstalledGameScannerModule {
  scanAllInstalledGames: (options?: Record<string, unknown>) => InstalledScanResult;
  scanAllInstalledGamesAsync: (options?: Record<string, unknown>) => Promise<InstalledScanResult>;
}

interface StoreSyncModule {
  loadSavedTokens: (opts?: Record<string, unknown>) => Record<string, Record<string, unknown>>;
  saveTokens: (
    storeId: string,
    data: Record<string, unknown>,
    opts?: Record<string, unknown>
  ) => void;
  saveSteamOwnedGamesCache: (games: unknown[], opts?: Record<string, unknown>) => void;
  loadSteamOwnedGamesCache: (opts?: Record<string, unknown>) => unknown[];
  scanLocalSuppressedStorefrontItems?: () => Array<Record<string, unknown>>;
}

interface StoreSyncIpcHandlersModule {
  registerStoreSyncIpcHandlers: (deps: Record<string, unknown>) => void;
}

interface LifecycleHooksAndEventsInstance {
  setMainWindowGetter: (fn: () => unknown) => void;
  setSessionLifecycleHook: (fn: ((gameId: string, payload: Record<string, unknown>) => void) | null) => void;
  emitSessionUpdated: (payload: Record<string, unknown>, options?: Record<string, unknown>) => void;
  drainPendingCompletedSessions: (options?: Record<string, unknown>) => Array<Record<string, unknown>>;
}

interface LifecycleHooksAndEventsModule {
  createLifecycleHooksAndEvents: (deps: Record<string, unknown>) => LifecycleHooksAndEventsInstance;
}

interface SessionFinalizerModule {
  collectMacAppBundleProcessTreePids: (
    psOutput: string,
    macAppBundlePaths: string | string[],
    seedPids?: Array<number | null | undefined>,
    selfPid?: number
  ) => {
    matchedRootPids: number[];
    orderedPids: number[];
    cmdByPid: Map<number, string>;
  };
  stopGame: (
    request: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<{ success: boolean; message?: string; error?: string }>;
}

interface EngineStateRegistryModule {
  activeSessions: Map<string, Record<string, unknown>>;
  setLastProductionScanCache: (val: { timestamp: number; result: unknown }) => void;
}

interface CompatLayerRegistryModule {
  extractRunnerVersionInfo: (
    runnerTypeOrPath: string,
    maybeBinaryPath?: string | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>
  ) => {
    appPath?: string;
    version?: string;
    buildVersion?: string;
    displayVersion?: string;
    previewDate?: string;
  };
  readRunnerInstallReceipts: (options?: Record<string, unknown>) => Record<string, Record<string, unknown>>;
  getRunnerInstallReceiptsCandidatePaths: (options?: Record<string, unknown>) => string[];
  compareRunnerVersions: (a: string, b: string) => number;
}

interface TrayAndDaemonLifecycleInstance {
  installSessionLifecycleHook: () => void;
  restoreOrCreateMainWindow: () => void;
  stopMacBottleFocusHelper: (opts?: { restorePresentation?: boolean }) => void;
  runSubsystemShutdownOnce: () => void;
  flushBufferedRendererEvents: () => void;
}

interface TrayAndDaemonLifecycleModule {
  createTrayAndDaemonLifecycle: (deps: Record<string, unknown>) => TrayAndDaemonLifecycleInstance;
}

type MockIpcHandler = (event: Record<string, unknown>, ...args: unknown[]) => Promise<unknown>;

const installedGameScanner = nodeRequire(
  '../electron/launcher/installedGameScanner.cjs'
) as InstalledGameScannerModule;
const storeSync = nodeRequire('../electron/storeSync.cjs') as StoreSyncModule;
const { registerStoreSyncIpcHandlers } = nodeRequire(
  '../electron/ipc/storeSyncIpcHandlers.cjs'
) as StoreSyncIpcHandlersModule;
const { createLifecycleHooksAndEvents } = nodeRequire(
  '../electron/launcher/state/lifecycleHooksAndEvents.cjs'
) as LifecycleHooksAndEventsModule;
const sessionFinalizer = nodeRequire(
  '../electron/launcher/supervisor/sessionFinalizerAndControl.cjs'
) as SessionFinalizerModule;
const engineStateRegistry = nodeRequire(
  '../electron/launcher/engineStateRegistry.cjs'
) as EngineStateRegistryModule;
const compatLayerRegistry = nodeRequire(
  '../electron/launcher/mac/compatLayerRegistryAndDetection.cjs'
) as CompatLayerRegistryModule;
const { createTrayAndDaemonLifecycle } = nodeRequire(
  '../electron/ipc/trayAndDaemonLifecycle.cjs'
) as TrayAndDaemonLifecycleModule;

const trackedTempDirs: string[] = [];
const trackedSessionKeys: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

/**
 * Write a minimal valid PE executable header (`x64` 0x8664, `x86` 0x014c, or `arm64` 0xaa64)
 * that passes `inspectWindowsExecutableHeader` without being treated as a synthetic 2-byte stub.
 */
function writeSyntheticPeExecutable(filePath: string, arch: 'x64' | 'x86' | 'arm64'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.alloc(512, 0);
  buf[0] = 0x4d; // 'M'
  buf[1] = 0x5a; // 'Z'
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'ascii');
  const machine = arch === 'x64' ? 0x8664 : arch === 'x86' ? 0x014c : 0xaa64;
  buf.writeUInt16LE(machine, peOffset + 4);
  buf.writeUInt16LE(0, peOffset + 6); // NumberOfSections
  const optSize = arch === 'x86' ? 0xe0 : 0xf0;
  buf.writeUInt16LE(optSize, peOffset + 20);
  buf.writeUInt16LE(arch === 'x86' ? 0x0102 : 0x0022, peOffset + 22); // Characteristics
  buf.writeUInt16LE(arch === 'x86' ? 0x010b : 0x020b, peOffset + 24); // PE32 vs PE32+
  fs.writeFileSync(filePath, buf);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of trackedSessionKeys.splice(0, trackedSessionKeys.length)) {
    engineStateRegistry.activeSessions.delete(key);
  }
  while (trackedTempDirs.length > 0) {
    const dir = trackedTempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Phase 3 UAT Electron Main Process Fixes', () => {
  // ==========================================================================
  // BUG-B2: Double-Nested GOG Installs Missed due to visitedGogDirs Depth Bug
  // ==========================================================================
  describe('BUG-B2: Double-nested GOG installs & visitedGogDirs min-depth tracking', () => {
    it('discovers double-nested GOG installs under ~/Games/OneLauncher/GOG and nested Galaxy config roots in both sync and async scanners', async () => {
      const tmpHome = createTempDir('ol-uat-b2-home-');
      const userDataDir = createTempDir('ol-uat-b2-ud-');

      // 1. Standard double-nested installs inside ~/Games/OneLauncher/GOG
      const falloutDir = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'Fallout', 'Fallout');
      const cojDir = path.join(
        tmpHome,
        'Games',
        'OneLauncher',
        'GOG',
        'Call of Juarez Gunslinger',
        'Call of Juarez Gunslinger'
      );
      const directDir = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'DirectTitle');

      writeSyntheticPeExecutable(path.join(falloutDir, 'falloutw.exe'), 'x86');
      fs.writeFileSync(
        path.join(falloutDir, 'goggame-1440148836.info'),
        JSON.stringify({
          gameId: '1440148836',
          name: 'Fallout',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'falloutw.exe' }],
        }),
        'utf8'
      );

      writeSyntheticPeExecutable(path.join(cojDir, 'CoJGunslinger.exe'), 'x86');
      fs.writeFileSync(
        path.join(cojDir, 'goggame-2015389384.info'),
        JSON.stringify({
          gameId: '2015389384',
          name: 'Call of Juarez Gunslinger',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'CoJGunslinger.exe' }],
        }),
        'utf8'
      );

      writeSyntheticPeExecutable(path.join(directDir, 'Direct.exe'), 'x64');
      fs.writeFileSync(
        path.join(directDir, 'goggame-1111111111.info'),
        JSON.stringify({
          gameId: '1111111111',
          name: 'Direct GOG Title',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'Direct.exe' }],
        }),
        'utf8'
      );

      // 2. Dynamic Galaxy config libraryPath nested under ~/Games (reached at depth=2 from ~/Games BEFORE depth=0 from config.json!)
      const customArchiveRoot = path.join(tmpHome, 'Games', 'CustomArchive', 'GOGSub');
      const deepCustomGameDir = path.join(customArchiveRoot, 'NestedClassic', 'NestedClassic');
      writeSyntheticPeExecutable(path.join(deepCustomGameDir, 'Classic.exe'), 'x86');
      fs.writeFileSync(
        path.join(deepCustomGameDir, 'goggame-1999999999.info'),
        JSON.stringify({
          gameId: '1999999999',
          name: 'Deep Nested Classic',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'Classic.exe' }],
        }),
        'utf8'
      );
      const galaxyConfigDir = path.join(tmpHome, 'Library', 'Application Support', 'GOG.com', 'Galaxy');
      fs.mkdirSync(galaxyConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(galaxyConfigDir, 'config.json'),
        JSON.stringify({ libraryPath: customArchiveRoot }),
        'utf8'
      );

      const scanOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir,
        detectedLayers: [],
        skipFirstPartySync: true,
        forceRefresh: true,
      };

      const syncRes = installedGameScanner.scanAllInstalledGames(scanOpts);
      const asyncRes = await installedGameScanner.scanAllInstalledGamesAsync(scanOpts);

      for (const res of [syncRes, asyncRes]) {
        expect(res.success).toBe(true);
        const gogIds = res.installedGames
          .filter((g) => g.platformId === 'gog')
          .map((g) => g.platformGameId)
          .sort();
        expect(gogIds).toEqual(['1111111111', '1440148836', '1999999999', '2015389384']);
      }
    });
  });

  // ==========================================================================
  // BUG-C5: Populate executableArchitecture & is32BitExecutable on Scanned Games
  // ==========================================================================
  describe('BUG-C5: PE executableArchitecture & is32BitExecutable enrichment', () => {
    it('attaches exact x64/x86/arm64 executableArchitecture and is32BitExecutable across Steam, GOG, and custom installs in sync & async scanners', async () => {
      const tmpHome = createTempDir('ol-uat-c5-home-');
      const userDataDir = createTempDir('ol-uat-c5-ud-');

      // 64-bit Steam Windows game (DOOM.exe) inside a bottle-like steamapps tree
      const steamappsDir = path.join(
        tmpHome,
        'Library',
        'Application Support',
        'Steam',
        'steamapps'
      );
      const doomDir = path.join(steamappsDir, 'common', 'DOOM Enhanced');
      writeSyntheticPeExecutable(path.join(doomDir, 'DOOM.exe'), 'x64');
      fs.mkdirSync(steamappsDir, { recursive: true });
      fs.writeFileSync(
        path.join(steamappsDir, 'appmanifest_2280.acf'),
        `"AppState"\n{\n\t"appid"\t\t"2280"\n\t"name"\t\t"DOOM Enhanced"\n\t"installdir"\t\t"DOOM Enhanced"\n\t"StateFlags"\t\t"4"\n}\n`,
        'utf8'
      );

      // 64-bit GOG Windows game (Hades2.exe)
      const hadesDir = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'Hades II');
      writeSyntheticPeExecutable(path.join(hadesDir, 'Hades2.exe'), 'x64');
      fs.writeFileSync(
        path.join(hadesDir, 'goggame-2015545325.info'),
        JSON.stringify({
          gameId: '2015545325',
          name: 'Hades II',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'Hades2.exe' }],
        }),
        'utf8'
      );

      // 32-bit GOG Windows game (Legacy32.exe)
      const legacy32Dir = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'Legacy32');
      writeSyntheticPeExecutable(path.join(legacy32Dir, 'Legacy32.exe'), 'x86');
      fs.writeFileSync(
        path.join(legacy32Dir, 'goggame-1207658901.info'),
        JSON.stringify({
          gameId: '1207658901',
          name: 'Legacy 32-bit RPG',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'Legacy32.exe' }],
        }),
        'utf8'
      );

      // ARM64 GOG Windows game (Arm64Title.exe)
      const arm64Dir = path.join(tmpHome, 'Games', 'OneLauncher', 'GOG', 'Arm64Title');
      writeSyntheticPeExecutable(path.join(arm64Dir, 'Arm64Title.exe'), 'arm64');
      fs.writeFileSync(
        path.join(arm64Dir, 'goggame-1207658902.info'),
        JSON.stringify({
          gameId: '1207658902',
          name: 'ARM64 Windows Title',
          playTasks: [{ isPrimary: true, type: 'FileTask', path: 'Arm64Title.exe' }],
        }),
        'utf8'
      );

      const scanOpts = {
        platform: 'darwin',
        homedir: tmpHome,
        userDataDir,
        detectedLayers: [],
        skipFirstPartySync: true,
        forceRefresh: true,
      };

      const syncRes = installedGameScanner.scanAllInstalledGames(scanOpts);
      const asyncRes = await installedGameScanner.scanAllInstalledGamesAsync(scanOpts);

      for (const res of [syncRes, asyncRes]) {
        expect(res.success).toBe(true);
        const byId = new Map(res.installedGames.map((g) => [`${g.platformId}:${g.platformGameId}`, g]));

        const doom = byId.get('steam:2280');
        expect(doom).toBeDefined();
        expect(doom?.executableArchitecture).toBe('x64');
        expect(doom?.is32BitExecutable).toBe(false);

        const hades = byId.get('gog:2015545325');
        expect(hades).toBeDefined();
        expect(hades?.executableArchitecture).toBe('x64');
        expect(hades?.is32BitExecutable).toBe(false);

        const legacy32 = byId.get('gog:1207658901');
        expect(legacy32).toBeDefined();
        expect(legacy32?.executableArchitecture).toBe('x86');
        expect(legacy32?.is32BitExecutable).toBe(true);

        const arm64 = byId.get('gog:1207658902');
        expect(arm64).toBeDefined();
        expect(arm64?.executableArchitecture).toBe('arm64');
        expect(arm64?.is32BitExecutable).toBe(false);
      }
    });
  });

  // ==========================================================================
  // BUG-C1: Connected Steam store:sync Early Secret Gate & Partition Fallback
  // ==========================================================================
  describe('BUG-C1: Connected Steam store:sync without manual apiKey/webapi_token', () => {
    it('allows Steam with saved steamId (no webapi_token/apiKey) to pass the early gate and sync via persist:storefront_auth SSR cookies', async () => {
      const userDataDir = createTempDir('ol-uat-c1-steamid-');
      const vaultOpts = { userDataDir };

      // Connected via Steam OpenID / Community browser session: steamId present, NO access_token/webapi_token/apiKey
      storeSync.saveTokens(
        'steam',
        {
          steamId: '76561198000000042',
          accountName: 'SyntheticOpenIdPlayer',
          avatarUrl: 'https://avatars.steamstatic.com/synthetic.jpg',
        },
        vaultOpts
      );

      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      const ssrPayload = {
        loaderData: [JSON.stringify({ strWebAPIToken: 'syn_refreshed_webapi_token_123' })],
        renderContext: {
          queryData: JSON.stringify({
            queries: [
              {
                queryKey: ['OwnedGames'],
                state: {
                  data: [{ appid: 620, name: 'Portal 2', playtime_forever: 420 }],
                },
              },
            ],
          }),
        },
      };
      const ssrHtml = `<html><head></head><body><script>var g_steamID = "76561198000000042";</script><script id="valve-ssr-data">${JSON.stringify(ssrPayload)}</script></body></html>`;

      const fetchByPartition: Record<string, ReturnType<typeof vi.fn>> = {
        'persist:oauth_steam': vi.fn(async () => ({
          ok: true,
          status: 200,
          url: 'https://steamcommunity.com/login/home/?goto=%2Fmy%2Fgames%2F',
          text: async () => '<html>login</html>',
        })),
        'persist:storefront_auth': vi.fn(async () => ({
          ok: true,
          status: 200,
          url: 'https://steamcommunity.com/profiles/76561198000000042/games/?tab=all',
          text: async () => ssrHtml,
        })),
      };

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: vi.fn(),
        session: {
          fromPartition: (partition: string) => ({
            cookies: {
              get: async () =>
                partition === 'persist:storefront_auth'
                  ? [{ name: 'steamLoginSecure', value: '76561198000000042%7C%7Csyn_jwt' }]
                  : [],
            },
            fetch: fetchByPartition[partition] ?? vi.fn(),
          }),
        },
        getMainWindow: () => null,
        storeSync: {
          ...storeSync,
          loadSavedTokens: () => storeSync.loadSavedTokens(vaultOpts),
          saveTokens: (id: string, data: Record<string, unknown>) =>
            storeSync.saveTokens(id, data, vaultOpts),
          scanLocalSuppressedStorefrontItems: () => [],
        },
        launcherEngine: {},
        options: {
          userDataDir,
          isOnline: () => true,
          fetchFn: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ response: { achievement_progress: [] } }),
            text: async () => '{}',
          })),
        },
      });

      const syncHandler = handlers.get('store:sync');
      expect(syncHandler).toBeDefined();

      const res = (await syncHandler!({}, 'steam')) as {
        success: boolean;
        error?: string;
        accountId?: string;
        games?: Array<{ id: string; title: string }>;
      };

      expect(res.success).toBe(true);
      expect(res.error).toBeUndefined();
      expect(res.accountId).toBe('76561198000000042');
      expect(res.games?.map((g) => g.id)).toEqual(['steam-620']);
      expect(fetchByPartition['persist:storefront_auth']).toHaveBeenCalledTimes(1);
    });

    it('allows Steam to pass the early gate when persist:storefront_auth holds a steamLoginSecure cookie even before steamId is saved', async () => {
      const userDataDir = createTempDir('ol-uat-c1-cookie-only-');
      const vaultOpts = { userDataDir };

      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      const ssrPayload = {
        loaderData: [JSON.stringify({ strWebAPIToken: 'syn_cookie_only_webapi_token' })],
        renderContext: {
          queryData: JSON.stringify({
            queries: [
              {
                queryKey: ['OwnedGames'],
                state: {
                  data: [{ appid: 400, name: 'Portal', playtime_forever: 120 }],
                },
              },
            ],
          }),
        },
      };
      const ssrHtml = `<html><body><script>var g_steamID = "76561198000000001";</script><script id="valve-ssr-data">${JSON.stringify(ssrPayload)}</script></body></html>`;

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: vi.fn(),
        session: {
          fromPartition: (partition: string) => ({
            cookies: {
              get: async () =>
                partition === 'persist:storefront_auth'
                  ? [{ name: 'steamLoginSecure', value: '76561198000000001%7C%7Csyn_jwt' }]
                  : [],
            },
            fetch: vi.fn(async () => ({
              ok: true,
              status: 200,
              url: 'https://steamcommunity.com/profiles/76561198000000001/games/?tab=all',
              text: async () => ssrHtml,
            })),
          }),
        },
        getMainWindow: () => null,
        storeSync: {
          ...storeSync,
          loadSavedTokens: () => storeSync.loadSavedTokens(vaultOpts),
          saveTokens: (id: string, data: Record<string, unknown>) =>
            storeSync.saveTokens(id, data, vaultOpts),
          scanLocalSuppressedStorefrontItems: () => [],
        },
        launcherEngine: {},
        options: {
          userDataDir,
          isOnline: () => true,
          fetchFn: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ response: { achievement_progress: [] } }),
            text: async () => '{}',
          })),
        },
      });

      const res = (await handlers.get('store:sync')!({}, 'steam')) as {
        success: boolean;
        accountId?: string;
        games?: Array<{ id: string }>;
      };
      expect(res.success).toBe(true);
      expect(res.accountId).toBe('76561198000000001');
      expect(res.games?.map((g) => g.id)).toEqual(['steam-400']);
    });

    it('still rejects genuinely disconnected Steam (no saved steamId and no Steam session cookies)', async () => {
      const userDataDir = createTempDir('ol-uat-c1-disconn-');
      const vaultOpts = { userDataDir };

      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: vi.fn(),
        session: {
          fromPartition: () => ({
            cookies: { get: async () => [] },
            fetch: vi.fn(),
          }),
        },
        getMainWindow: () => null,
        storeSync: {
          ...storeSync,
          loadSavedTokens: () => storeSync.loadSavedTokens(vaultOpts),
          saveTokens: (id: string, data: Record<string, unknown>) =>
            storeSync.saveTokens(id, data, vaultOpts),
        },
        launcherEngine: {},
        options: { userDataDir, isOnline: () => true },
      });

      const res = (await handlers.get('store:sync')!({}, 'steam')) as {
        success: boolean;
        error?: string;
      };
      expect(res.success).toBe(false);
      expect(res.error).toContain('No saved credentials found for steam');
    });

    it('returns Steam session expired when saved steamId has expired cookies and empty disk cache while online, while preserving cached or offline syncs', async () => {
      const userDataDir = createTempDir('ol-uat-c1-expired-');
      const vaultOpts = { userDataDir };

      storeSync.saveTokens(
        'steam',
        {
          steamId: '76561198000000042',
          accountName: 'ExpiredCookiePlayer',
        },
        vaultOpts
      );

      let isOnlineFlag = true;
      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: null,
        session: {
          fromPartition: () => ({
            cookies: { get: async () => [] },
            fetch: vi.fn(async () => ({
              ok: true,
              status: 200,
              url: 'https://steamcommunity.com/login/home/?goto=%2Fmy%2Fgames%2F',
              text: async () => '<html>login</html>',
            })),
          }),
        },
        getMainWindow: () => null,
        storeSync: {
          ...storeSync,
          loadSavedTokens: () => storeSync.loadSavedTokens(vaultOpts),
          saveTokens: (id: string, data: Record<string, unknown>) =>
            storeSync.saveTokens(id, data, vaultOpts),
          scanLocalSuppressedStorefrontItems: () => [],
        },
        launcherEngine: {},
        options: { userDataDir, isOnline: () => isOnlineFlag },
      });

      const syncHandler = handlers.get('store:sync')!;

      // 1. Online + saved steamId + expired cookies + empty disk cache -> MUST report expired session
      const expiredRes = (await syncHandler({}, 'steam')) as {
        success: boolean;
        error?: string;
        games?: unknown[];
      };
      expect(expiredRes.success).toBe(false);
      expect(expiredRes.error).toBe(
        'Steam session expired. Please sign in to Steam again in Settings.'
      );

      // 2. Offline + saved steamId + empty disk cache -> MUST NOT falsely declare expired session
      isOnlineFlag = false;
      const offlineRes = (await syncHandler({}, 'steam')) as {
        success: boolean;
        error?: string;
        games?: unknown[];
      };
      expect(offlineRes.success).toBe(true);
      expect(offlineRes.games).toEqual([]);

      // 3. Online + saved steamId + expired cookies + non-empty disk cache -> preserves cached library
      isOnlineFlag = true;
      storeSync.saveSteamOwnedGamesCache(
        [
          {
            id: 'steam-620',
            steamAppId: 620,
            title: 'Portal 2',
            platforms: [{ platformId: 'steam', platformGameId: '620', playtimeMinutes: 60 }],
          },
        ],
        { ...vaultOpts, steamId: '76561198000000042' }
      );
      const cachedRes = (await syncHandler({}, 'steam')) as {
        success: boolean;
        error?: string;
        games?: Array<{ id: string }>;
      };
      expect(cachedRes.success).toBe(true);
      expect(cachedRes.games?.map((g) => g.id)).toEqual(['steam-620']);
    });
  });

  // ==========================================================================
  // BUG-C3: InGameHibernationView IPC Ordering Race
  // ==========================================================================
  describe('BUG-C3: emitSessionUpdated sends launcher:session-updated BEFORE sessionLifecycleHook', () => {
    it('delivers launcher:session-updated to renderer strictly before sessionLifecycleHook triggers launcher:hibernate-state', () => {
      const userDataDir = createTempDir('ol-uat-c3-');
      const ipcTimeline: Array<{ channel: string; payload: Record<string, unknown> }> = [];

      const lifecycle = createLifecycleHooksAndEvents({
        fs,
        getUserDataDir: () => userDataDir,
        atomicWriteSecureFileSync: (fp: string, content: string | Buffer) => {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content);
        },
        readJsonFileWithBackupSync: (fp: string, fallback: unknown) => {
          try {
            return JSON.parse(fs.readFileSync(fp, 'utf8'));
          } catch {
            return fallback;
          }
        },
        sessionListeners: new Set(),
        downloadListeners: new Set(),
      });

      const mockMainWindow = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isLoadingMainFrame: () => false,
          isLoading: () => false,
          send: (channel: string, payload: Record<string, unknown>) => {
            ipcTimeline.push({ channel, payload });
          },
        },
      };

      lifecycle.setMainWindowGetter(() => mockMainWindow);
      lifecycle.setSessionLifecycleHook((_gameId, eventPayload) => {
        if (eventPayload.event === 'started') {
          mockMainWindow.webContents.send('launcher:hibernate-state', {
            hibernating: true,
            inGame: true,
            mode: 'hide_tray_hibernate',
          });
        }
      });

      lifecycle.emitSessionUpdated({
        event: 'started',
        session: {
          gameId: 'gog-1207658992',
          title: 'Syndicate Plus',
          status: 'running',
        },
      });

      expect(ipcTimeline.map((e) => e.channel)).toEqual([
        'launcher:session-updated',
        'launcher:hibernate-state',
      ]);
      expect(ipcTimeline[0].payload.event).toBe('started');
      expect(ipcTimeline[1].payload.hibernating).toBe(true);
    });
  });

  // ==========================================================================
  // BUG-C4: Stop on Native macOS .app Kills Full Descendant Tree (sh / dosbox)
  // ==========================================================================
  describe('BUG-C4: Native macOS .app Stop process-tree walk & SIGKILL escalation', () => {
    it('collects Contents/MacOS, Contents/Resources, and relative-command descendants (./dosbox/dosbox) while excluding unrelated PIDs, PID 1, and self', () => {
      const bundlePath = '/Applications/Syndicate Plus.app';
      const psOutput = [
        '    1     0 /sbin/launchd',
        `${process.pid}     1 /Applications/One Launcher.app/Contents/MacOS/One Launcher`,
        '97731   500 /usr/bin/open -W -a /Applications/Syndicate Plus.app',
        '97732     1 /Applications/Syndicate Plus.app/Contents/MacOS/Launcher',
        '97763 97732 sh -c cd "/Applications/Syndicate Plus.app/Contents/Resources" && sh script',
        '97985 97763 ./dosbox/dosbox -conf dosbox_syndicate.conf',
        '99999     1 /Applications/Unrelated.app/Contents/MacOS/Unrelated',
      ].join('\n');

      const res = sessionFinalizer.collectMacAppBundleProcessTreePids(
        psOutput,
        bundlePath,
        [97731],
        process.pid
      );

      expect(res.orderedPids).toContain(97985);
      expect(res.orderedPids).toContain(97763);
      expect(res.orderedPids).toContain(97732);
      expect(res.orderedPids).toContain(97731);
      expect(res.orderedPids).not.toContain(99999);
      expect(res.orderedPids).not.toContain(1);
      expect(res.orderedPids).not.toContain(process.pid);
      // Deepest descendant (./dosbox/dosbox) must be ordered ahead of its parents
      expect(res.orderedPids.indexOf(97985)).toBeLessThan(res.orderedPids.indexOf(97763));
      expect(res.orderedPids.indexOf(97985)).toBeLessThan(res.orderedPids.indexOf(97732));
    });

    it('escalates to SIGKILL for surviving reparented ./dosbox/dosbox even after /usr/bin/open and Launcher exit on SIGTERM', async () => {
      const tmpApps = createTempDir('ol-uat-c4-apps-');
      const bundlePath = path.join(tmpApps, 'Syndicate Plus.app');
      const launcherExe = path.join(bundlePath, 'Contents', 'MacOS', 'Launcher');
      fs.mkdirSync(path.dirname(launcherExe), { recursive: true });
      fs.writeFileSync(launcherExe, '#!/bin/sh\n', 'utf8');

      const gameId = 'gog-1207658992-uat-c4';
      const sessionKey = gameId;
      trackedSessionKeys.push(sessionKey);

      const alivePids = new Set<number>([97731, 97732, 97763, 97985]);
      const signalsSent: Array<{ pid: number; signal: string | number }> = [];

      const killImpl = vi.fn((pid: number, signal: string | number = 0) => {
        if (signal === 0) {
          if (!alivePids.has(pid)) {
            const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
            throw err;
          }
          return;
        }
        signalsSent.push({ pid, signal });
        if (signal === 'SIGTERM') {
          // /usr/bin/open (97731), Launcher (97732), and sh (97763) exit cleanly on SIGTERM;
          // dosbox (97985) ignores SIGTERM and gets reparented to PID 1!
          if (pid === 97731 || pid === 97732 || pid === 97763) {
            alivePids.delete(pid);
          }
        } else if (signal === 'SIGKILL') {
          alivePids.delete(pid);
        }
      });

      const execFileImpl = vi.fn(
        (
          cmd: string,
          _args: string[],
          _opts: Record<string, unknown>,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (cmd === 'ps') {
            const rows: string[] = [
              '    1     0 /sbin/launchd',
              `${process.pid}     1 /Applications/One Launcher.app/Contents/MacOS/One Launcher`,
            ];
            if (alivePids.has(97731)) {
              rows.push(`97731   500 /usr/bin/open -W -a ${bundlePath}`);
            }
            if (alivePids.has(97732)) {
              rows.push(`97732     1 ${bundlePath}/Contents/MacOS/Launcher`);
            }
            if (alivePids.has(97763)) {
              const shPpid = alivePids.has(97732) ? 97732 : 1;
              rows.push(
                `97763 ${shPpid} sh -c cd "${bundlePath}/Contents/Resources" && sh script`
              );
            }
            if (alivePids.has(97985)) {
              const dosboxPpid = alivePids.has(97763) ? 97763 : 1;
              rows.push(`97985 ${dosboxPpid} ./dosbox/dosbox -conf dosbox_syndicate.conf`);
            }
            rows.push('99999     1 /Applications/Unrelated.app/Contents/MacOS/Unrelated');
            cb(null, rows.join('\n'), '');
            return;
          }
          cb(null, '', '');
        }
      );

      engineStateRegistry.activeSessions.set(sessionKey, {
        gameId,
        platformId: 'gog',
        pid: 97731,
        startedMs: Date.now() - 60_000,
        finalized: false,
        launchConfig: {},
        session: {
          gameId,
          platformId: 'gog',
          title: 'Syndicate Plus',
          pid: 97731,
          executablePath: launcherExe,
          status: 'running',
        },
      });

      const stopRes = await sessionFinalizer.stopGame(
        { gameId },
        {
          platform: 'darwin',
          allowProcessCheckInTest: true,
          macStopGraceMs: 30,
          execFileImpl,
          killImpl,
        }
      );

      expect(stopRes.success).toBe(true);
      expect(signalsSent).toContainEqual({ pid: 97985, signal: 'SIGTERM' });
      expect(signalsSent).toContainEqual({ pid: 97763, signal: 'SIGTERM' });
      expect(signalsSent).toContainEqual({ pid: 97732, signal: 'SIGTERM' });
      expect(signalsSent).toContainEqual({ pid: 97731, signal: 'SIGTERM' });
      // Reparented surviving dosbox MUST receive SIGKILL escalation!
      expect(signalsSent).toContainEqual({ pid: 97985, signal: 'SIGKILL' });
      // Never touch unrelated app, PID 1, or Electron self PID
      expect(signalsSent.some((s) => s.pid === 99999 || s.pid <= 1 || s.pid === process.pid)).toBe(
        false
      );
      expect(alivePids.size).toBe(0);
    });
  });

  // ==========================================================================
  // BUG-C8: GPTK 3.0-3 Info.plist Revision Parsing & Dual-Path Receipts Merge
  // ==========================================================================
  describe('BUG-C8: GPTK 3.0-3 plist patch parsing and dual-path receipt merging', () => {
    it('parses CFBundleShortVersionString/CFBundleVersion "3.0-3" into version "3.0.3" so GPTK 3.0-3 never triggers false Update Available', () => {
      const tmpHome = createTempDir('ol-uat-c8-plist-');
      const gptkApp = path.join(tmpHome, 'Applications', 'Game Porting Toolkit.app');
      const plistPath = path.join(gptkApp, 'Contents', 'Info.plist');
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>3.0-3</string>
  <key>CFBundleVersion</key>
  <string>3.0-3</string>
</dict>
</plist>`,
        'utf8'
      );

      const info = compatLayerRegistry.extractRunnerVersionInfo('gptk', gptkApp, {
        homedir: tmpHome,
      });
      expect(info.version).toBe('3.0.3');
      expect(info.buildVersion).toBe('3.0-3');
      expect(info.displayVersion).toBe('3.0-3');
      expect(compatLayerRegistry.compareRunnerVersions(info.version || '', '3.0-3')).toBe(0);
      expect(compatLayerRegistry.compareRunnerVersions(info.version || '', '3.0.3')).toBe(0);
    });

    it('merges runner-install-receipts.json from both Application Support/one-launcher and fallback Application Support/OneLauncher', () => {
      const tmpRoot = createTempDir('ol-uat-c8-receipts-');
      const appSupportDir = path.join(tmpRoot, 'Library', 'Application Support');
      const lowerUserDataDir = path.join(appSupportDir, 'one-launcher');
      const camelFallbackDir = path.join(appSupportDir, 'OneLauncher');
      fs.mkdirSync(lowerUserDataDir, { recursive: true });
      fs.mkdirSync(camelFallbackDir, { recursive: true });

      const gptkApp = path.join(tmpRoot, 'Applications', 'Game Porting Toolkit.app');
      const plistPath = path.join(gptkApp, 'Contents', 'Info.plist');
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>3.0</string>
  <key>CFBundleVersion</key>
  <string>3.0</string>
</dict>
</plist>`,
        'utf8'
      );
      const plistStat = fs.statSync(plistPath);

      // Receipt for Wine in one-launcher/, receipt for GPTK 3.0-3 ONLY in OneLauncher/
      fs.writeFileSync(
        path.join(lowerUserDataDir, 'runner-install-receipts.json'),
        JSON.stringify({
          schemaVersion: 1,
          receipts: {
            '/Applications/Wine Staging.app': {
              runnerType: 'wine',
              releaseVersion: '11.21',
              updatedAt: '2026-11-20T10:00:00.000Z',
            },
          },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(camelFallbackDir, 'runner-install-receipts.json'),
        JSON.stringify({
          schemaVersion: 1,
          receipts: {
            [path.resolve(gptkApp)]: {
              runnerType: 'gptk',
              plistShortVersion: '3.0',
              plistBundleVersion: '3.0',
              plistMtimeMs: Math.round(plistStat.mtimeMs),
              releaseVersion: '3.0-3',
              updatedAt: '2026-11-21T08:00:00.000Z',
            },
          },
        }),
        'utf8'
      );

      const mergedReceipts = compatLayerRegistry.readRunnerInstallReceipts({
        userDataDir: lowerUserDataDir,
      });
      expect(mergedReceipts['/Applications/Wine Staging.app']?.releaseVersion).toBe('11.21');
      expect(mergedReceipts[path.resolve(gptkApp)]?.releaseVersion).toBe('3.0-3');

      const info = compatLayerRegistry.extractRunnerVersionInfo('gptk', gptkApp, {
        userDataDir: lowerUserDataDir,
      });
      expect(info.version).toBe('3.0.3');
      expect(info.displayVersion).toBe('3.0-3');
    });
  });

  // ==========================================================================
  // BUG-C9: Borderless D3D12 Menu Bar Visibility (trayAndDaemonLifecycle + dylib)
  // ==========================================================================
  describe('BUG-C9: macOS app.hide() handoff & borderless layer=0 presentation options', () => {
    it('calls app.hide() on macOS hide_tray_hibernate for native launches and after cooperative handoff for bottled D3D12 launches, restoring presentation options on stop/restore', async () => {
      let hookFn: ((gameId: string, payload: Record<string, unknown>) => void) | null = null;
      const appHideSpy = vi.fn();
      const appShowSpy = vi.fn();
      const appFocusSpy = vi.fn();
      const winHideSpy = vi.fn();
      const winShowSpy = vi.fn();
      const winFocusSpy = vi.fn();
      const restorePresentationSpy = vi.fn(() => true);
      let runningGames: Array<Record<string, unknown>> = [];

      const pollArgsSeen: Array<Record<string, unknown>> = [];
      let pollCalls = 0;
      const pollAndActivateSpy = vi.fn((opts: Record<string, unknown>) => {
        pollArgsSeen.push(opts);
        pollCalls += 1;
        // Simulate Hades2.exe borderless D3D12 window mapped at layer=0, pid=4321, active=true
        const found = 1;
        const active = 2;
        const layer = 0 << 2;
        const pidTag = (4321 & 0x7fff) << 16;
        return found | active | layer | pidTag;
      });

      const mockMainWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => false,
        hide: winHideSpy,
        show: winShowSpy,
        restore: vi.fn(),
        focus: winFocusSpy,
        webContents: {
          isLoadingMainFrame: () => false,
          setAudioMuted: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          send: vi.fn(),
        },
      };

      const lifecycle = createTrayAndDaemonLifecycle({
        app: {
          hide: appHideSpy,
          show: appShowSpy,
          focus: appFocusSpy,
          dock: { show: vi.fn() },
          quit: vi.fn(),
        },
        Menu: { buildFromTemplate: vi.fn(() => ({})) },
        Tray: null,
        nativeImage: null,
        launcherEngine: {
          setSessionLifecycleHook: (fn: (gameId: string, payload: Record<string, unknown>) => void) => {
            hookFn = fn;
          },
          getGameLaunchConfig: () => ({}),
          resolvePlatformLaunchConfig: (cfg: Record<string, unknown>) => cfg,
          resolveEffectivePerformancePolicy: () => ({
            inGameLauncherBehavior: 'hide_tray_hibernate',
            postGameLauncherBehavior: 'restore_window',
          }),
          trimLauncherEngineMemory: vi.fn(),
          getRunningGames: () => runningGames,
          getDownloadQueue: () => [],
          shutdownLauncherEngine: vi.fn(),
        },
        mediaHydrationEngine: { shutdown: vi.fn() },
        offlineVaultService: { shutdown: vi.fn() },
        flushDiagnosticLogSync: vi.fn(),
        electronDir: path.join(REPO_ROOT, 'electron'),
        getMainWindow: () => mockMainWindow,
        setMainWindow: vi.fn(),
        createMainWindow: vi.fn(),
        platform: 'darwin',
        coopActivateHelper: {
          pollAndActivateBottledGame: pollAndActivateSpy,
          restorePresentationOptions: restorePresentationSpy,
        },
        macBottleFocusPollMs: 15,
      });

      lifecycle.flushBufferedRendererEvents();
      lifecycle.installSessionLifecycleHook();
      expect(hookFn).not.toBeNull();

      // 1. Native macOS .app launch -> mainWindow.hide() AND app.hide() immediately!
      runningGames = [{ gameId: 'gog-native-1', title: 'Native Mac Title' }];
      hookFn!('gog-native-1', {
        event: 'started',
        title: 'Native Mac Title',
        session: {
          gameId: 'gog-native-1',
          launchMethod: 'direct',
          executablePath: '/Applications/Native.app/Contents/MacOS/Native',
        },
      });
      expect(winHideSpy).toHaveBeenCalledTimes(1);
      expect(appHideSpy).toHaveBeenCalledTimes(1);

      // 2. Bottled D3D12 launch (Hades2.exe) -> polls helper with bottlePath & hides app after activation
      appHideSpy.mockClear();
      winHideSpy.mockClear();
      runningGames = [{ gameId: 'steam-1145350', title: 'Hades II' }];
      hookFn!('steam-1145350', {
        event: 'started',
        title: 'Hades II',
        session: {
          gameId: 'steam-1145350',
          pid: 4300,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/XboxGames/Hades II/Content/Hades2.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      expect(winHideSpy).toHaveBeenCalledTimes(1);
      // Deferred briefly until cooperative activation poll runs
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pollCalls).toBeGreaterThanOrEqual(1);
      expect(pollArgsSeen[0]).toMatchObject({
        rootPid: 4300,
        targetExeNames: ['Hades2.exe'],
        bottlePath: '/Bottles/OneLauncher',
      });
      expect(appHideSpy).toHaveBeenCalledTimes(1);

      // 3. Game stops -> restores presentation options & brings back One Launcher cleanly
      runningGames = [];
      hookFn!('steam-1145350', {
        event: 'stopped',
        title: 'Hades II',
      });
      expect(restorePresentationSpy).toHaveBeenCalled();
      expect(appShowSpy).toHaveBeenCalled();
      expect(winShowSpy).toHaveBeenCalled();

      lifecycle.runSubsystemShutdownOnce();
    });

    it('compiles borderless full-display detection (>= 95% screen bounds at layer == 0) and presentation-options restore into libone_coop_activate.dylib', () => {
      const coopSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'electron', 'helpers', 'one_coop_activate.c'),
        'utf8'
      );
      expect(coopSrc).toContain('ONE_NS_APP_PRESENTATION_AUTO_HIDE_MENU_BAR');
      expect(coopSrc).toContain('ONE_NS_APP_PRESENTATION_AUTO_HIDE_DOCK');
      expect(coopSrc).toContain('setPresentationOptions:');
      expect(coopSrc).toContain('0.95');

      if (process.platform === 'darwin') {
        const dylibPath = path.join(REPO_ROOT, 'electron', 'helpers', 'libone_coop_activate.dylib');
        const mod: {
          exports: {
            isBorderlessFullscreenWindow?: (
              fw: number,
              fh: number,
              sw: number,
              sh: number,
              layer: number
            ) => boolean;
            restorePresentationOptions?: () => boolean;
          };
        } = { exports: {} };
        process.dlopen(mod, dylibPath);

        expect(typeof mod.exports.isBorderlessFullscreenWindow).toBe('function');
        expect(typeof mod.exports.restorePresentationOptions).toBe('function');

        // Exact Hades II D3D12 Composited geometry on 1512x982 Retina screen at layer == 0
        expect(mod.exports.isBorderlessFullscreenWindow!(1512, 1014, 1512, 982, 0)).toBe(true);
        // Exact 95% borderless threshold
        expect(mod.exports.isBorderlessFullscreenWindow!(1437, 933, 1512, 982, 0)).toBe(true);
        // Windowed game at layer == 0 -> false
        expect(mod.exports.isBorderlessFullscreenWindow!(1280, 720, 1512, 982, 0)).toBe(false);
        // Exclusive shielded fullscreen at layer == 26 -> false (already above Menu Bar)
        expect(mod.exports.isBorderlessFullscreenWindow!(1512, 982, 1512, 982, 26)).toBe(false);
        // Safe idempotent restore when not applied
        expect(mod.exports.restorePresentationOptions!()).toBe(true);
      }
    });

    it('guards AppKit mutually-exclusive Hide/AutoHide bits and Native FullScreen (1<<10) in one_coop_activate.c and compiled dylib', () => {
      const coopSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'electron', 'helpers', 'one_coop_activate.c'),
        'utf8'
      );
      expect(coopSrc).toContain('ONE_NS_APP_PRESENTATION_HIDE_DOCK');
      expect(coopSrc).toContain('ONE_NS_APP_PRESENTATION_HIDE_MENU_BAR');
      expect(coopSrc).toContain('ONE_NS_APP_PRESENTATION_FULL_SCREEN');
      expect(coopSrc).toContain('ONE_NS_APP_PRESENTATION_AUTO_HIDE_TOOLBAR');
      expect(coopSrc).toContain('compute_safe_borderless_presentation_options');

      if (process.platform === 'darwin') {
        const dylibPath = path.join(REPO_ROOT, 'electron', 'helpers', 'libone_coop_activate.dylib');
        const mod: {
          exports: {
            computeSafePresentationOptions?: (
              currentOpts: number,
              savedOpts: number,
              enable: boolean
            ) => number;
          };
        } = { exports: {} };
        process.dlopen(mod, dylibPath);

        expect(typeof mod.exports.computeSafePresentationOptions).toBe('function');
        const compute = mod.exports.computeSafePresentationOptions!;

        const AUTO_HIDE_DOCK = 1 << 0;
        const HIDE_DOCK = 1 << 1;
        const AUTO_HIDE_MENU_BAR = 1 << 2;
        const HIDE_MENU_BAR = 1 << 3;
        const FULL_SCREEN = 1 << 10;
        const AUTO_HIDE_TOOLBAR = 1 << 11;

        // Default (0) -> AutoHideDock | AutoHideMenuBar (0x5)
        expect(compute(0, 0, true)).toBe(AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR);

        // HideDock present -> NEVER OR AutoHideDock (prevents AppKit NSInvalidArgumentException 0x3!)
        const hideDockTarget = compute(HIDE_DOCK, HIDE_DOCK, true);
        expect(hideDockTarget).toBe(HIDE_DOCK | AUTO_HIDE_MENU_BAR);
        expect(hideDockTarget & AUTO_HIDE_DOCK).toBe(0);

        // HideDock | HideMenuBar present -> NEVER OR AutoHideDock or AutoHideMenuBar
        const hideBoth = HIDE_DOCK | HIDE_MENU_BAR;
        const hideBothTarget = compute(hideBoth, hideBoth, true);
        expect(hideBothTarget).toBe(hideBoth);
        expect(hideBothTarget & (AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR)).toBe(0);

        // Synthetic HideMenuBar alone -> upgrades dock bit to HideDock (never invalid 0x9)
        const hideMenuOnlyTarget = compute(HIDE_MENU_BAR, HIDE_MENU_BAR, true);
        expect(hideMenuOnlyTarget).toBe(HIDE_DOCK | HIDE_MENU_BAR);
        expect(hideMenuOnlyTarget & (AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR)).toBe(0);

        // Native macOS Fullscreen (1<<10) -> MUST skip setPresentationOptions: (-1) on both enable & disable
        expect(compute(FULL_SCREEN, FULL_SCREEN, true)).toBe(-1);
        expect(compute(FULL_SCREEN | AUTO_HIDE_TOOLBAR, FULL_SCREEN | AUTO_HIDE_TOOLBAR, true)).toBe(
          -1
        );
        expect(compute(FULL_SCREEN, 0, false)).toBe(-1);

        // Restore outside FullScreen strips FullScreen | AutoHideToolbar from saved mask
        expect(
          compute(
            AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR,
            FULL_SCREEN | AUTO_HIDE_TOOLBAR | HIDE_DOCK,
            false
          )
        ).toBe(HIDE_DOCK);
        expect(compute(AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR, 0, false)).toBe(0);
      }
    });

    it('restores macOS presentation options on hideLauncherAppOnce and on app browser-window-focus / activate even when mainWindow.isVisible() is true (keep_open mode)', async () => {
      let hookFn: ((gameId: string, payload: Record<string, unknown>) => void) | null = null;
      const appListeners = new Map<string, Set<() => void>>();
      const emitAppEvent = (eventName: string) => {
        for (const fn of Array.from(appListeners.get(eventName) || [])) {
          fn();
        }
      };

      const appHideSpy = vi.fn();
      const restorePresentationSpy = vi.fn(() => true);
      let behaviorMode: 'keep_open' | 'hide_tray_hibernate' = 'keep_open';
      const pollAndActivateSpy = vi.fn(() => 1 | 2 | (0 << 2) | ((4321 & 0x7fff) << 16));

      const mockMainWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        hide: vi.fn(),
        show: vi.fn(),
        restore: vi.fn(),
        focus: vi.fn(),
        webContents: {
          isLoadingMainFrame: () => false,
          setAudioMuted: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          send: vi.fn(),
        },
      };

      const lifecycle = createTrayAndDaemonLifecycle({
        app: {
          hide: appHideSpy,
          show: vi.fn(),
          focus: vi.fn(),
          dock: { show: vi.fn() },
          quit: vi.fn(),
          on: (ev: string, fn: () => void) => {
            if (!appListeners.has(ev)) appListeners.set(ev, new Set());
            appListeners.get(ev)!.add(fn);
          },
          removeListener: (ev: string, fn: () => void) => {
            appListeners.get(ev)?.delete(fn);
          },
        },
        Menu: { buildFromTemplate: vi.fn(() => ({})) },
        Tray: null,
        nativeImage: null,
        launcherEngine: {
          setSessionLifecycleHook: (
            fn: (gameId: string, payload: Record<string, unknown>) => void
          ) => {
            hookFn = fn;
          },
          getGameLaunchConfig: () => ({}),
          resolvePlatformLaunchConfig: (cfg: Record<string, unknown>) => cfg,
          resolveEffectivePerformancePolicy: () => ({
            inGameLauncherBehavior: behaviorMode,
            postGameLauncherBehavior: 'restore_window',
          }),
          trimLauncherEngineMemory: vi.fn(),
          getRunningGames: () => [{ gameId: 'steam-1145350', title: 'Hades II' }],
          getDownloadQueue: () => [],
          shutdownLauncherEngine: vi.fn(),
        },
        mediaHydrationEngine: { shutdown: vi.fn() },
        offlineVaultService: { shutdown: vi.fn() },
        flushDiagnosticLogSync: vi.fn(),
        electronDir: path.join(REPO_ROOT, 'electron'),
        getMainWindow: () => mockMainWindow,
        setMainWindow: vi.fn(),
        createMainWindow: vi.fn(),
        platform: 'darwin',
        coopActivateHelper: {
          pollAndActivateBottledGame: pollAndActivateSpy,
          restorePresentationOptions: restorePresentationSpy,
        },
        macBottleFocusPollMs: 15,
      });

      lifecycle.installSessionLifecycleHook();
      expect(hookFn).not.toBeNull();

      // 1. keep_open mode: launch bottled borderless game while mainWindow.isVisible() remains true
      hookFn!('steam-1145350', {
        event: 'started',
        title: 'Hades II',
        session: {
          gameId: 'steam-1145350',
          pid: 4300,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/Hades2.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(appHideSpy).not.toHaveBeenCalled();

      // Switching back to One Launcher via browser-window-focus or Dock activate while
      // mainWindow.isVisible() === true MUST restore presentation options immediately!
      restorePresentationSpy.mockClear();
      emitAppEvent('browser-window-focus');
      expect(restorePresentationSpy).toHaveBeenCalledTimes(1);

      emitAppEvent('activate');
      expect(restorePresentationSpy).toHaveBeenCalledTimes(2);

      // 2. hide_tray_hibernate mode: once hideLauncherAppOnce runs app.hide(), presentation
      // options MUST be restored even before the game exits!
      behaviorMode = 'hide_tray_hibernate';
      restorePresentationSpy.mockClear();
      appHideSpy.mockClear();
      hookFn!('steam-1145350', {
        event: 'started',
        title: 'Hades II',
        session: {
          gameId: 'steam-1145350',
          pid: 4301,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/Hades2.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(appHideSpy).toHaveBeenCalledTimes(1);
      expect(restorePresentationSpy).toHaveBeenCalled();

      // 3. Verify electron/main.cjs also calls lifecycle.restoreMacPresentationOptions() on
      // activate (even when mainWindow.isVisible() is true) and on browser-window-focus
      const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.cjs'), 'utf8');
      expect(mainSrc).toMatch(
        /app\.on\(['"]activate['"],[\s\S]*?lifecycle\.restoreMacPresentationOptions\(\)/
      );
      expect(mainSrc).toMatch(
        /app\.on\(['"]browser-window-focus['"],[\s\S]*?lifecycle\.restoreMacPresentationOptions\(\)/
      );

      // 4. Shutdown detaches app focus listeners cleanly
      lifecycle.runSubsystemShutdownOnce();
      restorePresentationSpy.mockClear();
      emitAppEvent('browser-window-focus');
      emitAppEvent('activate');
      expect(restorePresentationSpy).not.toHaveBeenCalled();
    });
  });
});
