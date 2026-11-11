import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '..');

const securityUtils = nodeRequire('../electron/launcher/securityAndPathUtils.cjs');
const engineStateRegistry = nodeRequire('../electron/launcher/engineStateRegistry.cjs');
const uninstallSafety = nodeRequire('../electron/launcher/uninstallSafety.cjs');
const binaryInspectors = nodeRequire('../electron/launcher/binaryAndManifestInspectors.cjs');
const macNative = nodeRequire('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const supervisor = nodeRequire('../electron/launcher/sessionAndProcessSupervisor.cjs');
const downloadCoordinator = nodeRequire('../electron/launcher/downloadQueueCoordinator.cjs');
const cloudSaveEngine = nodeRequire('../electron/launcher/cloudSaveEngine.cjs');
const offlineVaultMod = nodeRequire('../electron/launcher/offlineVaultService.cjs');
const offlineVaultIpc = nodeRequire('../electron/ipc/offlineVaultIpcHandlers.cjs');
const launcherIpc = nodeRequire('../electron/ipc/launcherIpcHandlers.cjs');
const storeSyncIpc = nodeRequire('../electron/ipc/storeSyncIpcHandlers.cjs');
const winRegDiscovery = nodeRequire('../electron/utils/windowsRegistryDiscovery.cjs');
const installedScanner = nodeRequire('../electron/launcher/installedGameScanner.cjs');
const launcherEngine = nodeRequire('../electron/launcherEngine.cjs');
const macSignHook = nodeRequire('../build/macSign.cjs');
const afterSignHook = nodeRequire('../build/afterSign.cjs');
const verifyUninstaller = nodeRequire('../scripts/windows-uninstaller/verify-uninstaller.cjs');

function makeTempSandbox(prefix = 'ol-w2b-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildSyntheticPeBuffer(opts: {
  arch: 'x86' | 'x64';
  importedDlls: string[];
}): Buffer {
  const is64 = opts.arch === 'x64';
  const buf = Buffer.alloc(4096, 0);
  // MZ header
  buf.writeUInt16LE(0x5a4d, 0);
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);

  // PE\0\0 signature + COFF File Header
  buf.write('PE\0\0', peOffset, 'ascii');
  buf.writeUInt16LE(is64 ? 0x8664 : 0x014c, peOffset + 4); // Machine
  buf.writeUInt16LE(1, peOffset + 6); // NumberOfSections = 1
  const optHeaderSize = is64 ? 0xf0 : 0xe0;
  buf.writeUInt16LE(optHeaderSize, peOffset + 20);
  buf.writeUInt16LE(0x0002 | (is64 ? 0x0020 : 0x0100), peOffset + 22);

  // Optional Header
  const optOffset = peOffset + 24;
  buf.writeUInt16LE(is64 ? 0x020b : 0x010b, optOffset);
  buf.writeUInt16LE(2, optOffset + 68); // Subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI (2)
  const numRvaOffset = optOffset + (is64 ? 108 : 92);
  buf.writeUInt32LE(16, numRvaOffset);

  // Data Directory[1] = Import Table at RVA 0x1000
  const importDirEntryOffset = numRvaOffset + 4 + 8;
  buf.writeUInt32LE(0x1000, importDirEntryOffset);
  buf.writeUInt32LE(0x0400, importDirEntryOffset + 4);

  // Section Header (.rdata mapping RVA 0x1000 -> RawOffset 0x400, Size 0x800)
  const secOffset = optOffset + optHeaderSize;
  buf.write('.rdata\0\0', secOffset, 'ascii');
  buf.writeUInt32LE(0x0800, secOffset + 8); // VirtualSize
  buf.writeUInt32LE(0x1000, secOffset + 12); // VirtualAddress
  buf.writeUInt32LE(0x0800, secOffset + 16); // SizeOfRawData
  buf.writeUInt32LE(0x0400, secOffset + 20); // PointerToRawData

  // Import descriptors at file offset 0x400 (RVA 0x1000)
  const descBase = 0x400;
  let strCursor = 0x600;
  opts.importedDlls.forEach((dllName, idx) => {
    const dOff = descBase + idx * 20;
    const nameRva = 0x1000 + (strCursor - 0x400);
    buf.writeUInt32LE(nameRva, dOff + 12); // Name RVA
    const written = buf.write(`${dllName}\0`, strCursor, 'ascii');
    strCursor += written;
  });

  return buf;
}

function createFakeChildProcess(pid = 48123) {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: (sig?: string) => boolean;
    unref: () => void;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  ee.pid = pid;
  ee.killed = false;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.kill = () => {
    ee.killed = true;
    setImmediate(() => ee.emit('exit', 0, 'SIGTERM'));
    return true;
  };
  return ee;
}

describe('Total Review Wave 2B: Electron Security Perimeter, Dual-OS Supervisor, Performance & Packaging', () => {
  const tempDirs: string[] = [];

  function trackSandbox(prefix?: string): string {
    const dir = makeTempSandbox(prefix);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    supervisor.resetSupervisorStateForTests?.();
    engineStateRegistry.setUserDataDir(null);
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. Finding #1: environmentVariables Sanitizer & Spawn-Time Defense-in-Depth', () => {
    it('strips dangerous linker/runtime env keys across all nesting depths in sanitizeLaunchConfigRecursive', () => {
      const sanitized = securityUtils.sanitizeLaunchConfigRecursive({
        gameId: 'gog-synth-100',
        environmentVariables: {
          DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
          DYLD_FORCE_FLAT_NAMESPACE: '1',
          LD_PRELOAD: '/tmp/evil.so',
          NODE_OPTIONS: '--require /tmp/pwn.js',
          ELECTRON_RUN_AS_NODE: '1',
          PYTHONHOME: '/tmp/py',
          PYTHONPATH: '/tmp/pylib',
          BASH_ENV: '/tmp/bashenv',
          CX_ENV: 'DYLD_INSERT_LIBRARIES=/tmp/evil.dylib',
          DXVK_ASYNC: '1',
          MANGOHUD: '1',
        },
        platformConfigs: {
          gog: {
            environmentVariables: {
              DYLD_INSERT_LIBRARIES: '/tmp/nested.dylib',
              ELECTRON_RUN_AS_NODE: '1',
              GALLIUM_HUD: 'fps',
            },
          },
        },
      });

      expect(sanitized.environmentVariables).toEqual({
        DXVK_ASYNC: '1',
        MANGOHUD: '1',
      });
      expect(sanitized.platformConfigs.gog.environmentVariables).toEqual({
        GALLIUM_HUD: 'fps',
      });
    });

    it('blocks hand-edited one_launcher_configs.json dangerous env injection at launchGame spawn time', async () => {
      const sandbox = trackSandbox('ol-w2b-env-');
      const exePath = path.join(sandbox, 'SynthGame.exe');
      fs.writeFileSync(
        exePath,
        buildSyntheticPeBuffer({ arch: 'x64', importedDlls: ['KERNEL32.dll', 'd3d11.dll'] })
      );

      // Simulate an attacker or external tool hand-editing one_launcher_configs.json directly on disk
      fs.writeFileSync(
        path.join(sandbox, 'one_launcher_configs.json'),
        JSON.stringify(
          {
            'gog-synth-handedit': {
              gameId: 'gog-synth-handedit',
              launchMethod: 'direct',
              environmentVariables: {
                DYLD_INSERT_LIBRARIES: '/tmp/unapproved.dylib',
                LD_PRELOAD: '/tmp/unapproved.so',
                NODE_OPTIONS: '--inspect=0.0.0.0:9229',
                ELECTRON_RUN_AS_NODE: '1',
                PYTHONHOME: '/tmp/evil-py',
                PYTHONPATH: '/tmp/evil-pypath',
                BASH_ENV: '/tmp/evil-bash',
                CX_ENV: 'WINEDLLOVERRIDES=evil=n',
                SAFE_GAME_FLAG: 'enabled',
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      let capturedEnv: Record<string, string | undefined> = {};
      const fakeChild = createFakeChildProcess(59001);

      const res = await supervisor.launchGame(
        {
          gameId: 'gog-synth-handedit',
          title: 'Synth Hand Edited Game',
          platformId: 'gog',
          installPath: sandbox,
          executablePath: exePath,
        },
        {
          platform: 'win32',
          homedir: sandbox,
          userDataDir: sandbox,
          gameSpawnFn: (_cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
            capturedEnv = { ...(opts?.env || {}) };
            return fakeChild;
          },
        }
      );

      expect(res.success).toBe(true);
      expect(capturedEnv.SAFE_GAME_FLAG).toBe('enabled');
      expect(capturedEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(capturedEnv.LD_PRELOAD).toBeUndefined();
      expect(capturedEnv.NODE_OPTIONS).toBeUndefined();
      expect(capturedEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(capturedEnv.PYTHONHOME).toBeUndefined();
      expect(capturedEnv.PYTHONPATH).toBeUndefined();
      expect(capturedEnv.BASH_ENV).toBeUndefined();
      expect(capturedEnv.CX_ENV).toBeUndefined();

      await supervisor.stopGame({ gameId: 'gog-synth-handedit' }, { platform: 'win32' });
    });

    it('sanitizes baseEnv as well as userEnvMap in buildSafeChildEnvironment while preserving internalOverrides', () => {
      const baseEnvWithDangerous = {
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '--inspect=0.0.0.0:9229',
        LD_PRELOAD: '/tmp/evil_preload.so',
        DYLD_INSERT_LIBRARIES: '/tmp/evil_dyld.dylib',
        ELECTRON_RUN_AS_NODE: '1',
        BASH_ENV: '/tmp/evil.sh',
        PYTHONPATH: '/tmp/evil_py',
      };
      const userEnvMap = {
        SAFE_USER_VAR: 'hello',
        LD_PRELOAD: '/tmp/user_evil.so',
      };
      const internalOverrides = {
        ONE_LAUNCHER_INTERNAL: '1',
      };

      const safeEnv = securityUtils.buildSafeChildEnvironment(
        baseEnvWithDangerous,
        userEnvMap,
        internalOverrides
      );

      // Dangerous keys from both baseEnv and userEnvMap must be stripped
      expect(safeEnv.PATH).toBe('/usr/bin:/bin');
      expect(safeEnv.SAFE_USER_VAR).toBe('hello');
      expect(safeEnv.ONE_LAUNCHER_INTERNAL).toBe('1');
      expect(safeEnv.NODE_OPTIONS).toBeUndefined();
      expect(safeEnv.LD_PRELOAD).toBeUndefined();
      expect(safeEnv.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(safeEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(safeEnv.BASH_ENV).toBeUndefined();
      expect(safeEnv.PYTHONPATH).toBeUndefined();
    });
  });

  describe('2. Findings #2 & #5: Sender Validation, Loopback Origin Lock, Preload Forwarding & IPC Pruning', () => {
    it('enforces assertTrustedIpcSender against untrusted subframes/origins while allowing unit-test mock events', () => {
      const mainFrame = { url: 'file:///app/dist/index.html', routingId: 1 };
      const subFrame = { url: 'https://www.youtube-nocookie.com/embed/xyz', routingId: 2 };
      const mainWc = { id: 10, mainFrame };
      const foreignWc = { id: 99, mainFrame };
      const mainWin = { isDestroyed: () => false, webContents: mainWc };

      const checkOpts = {
        getMainWindow: () => mainWin,
        isPackaged: true,
        expectedFileHref: 'file:///app/dist/index.html',
      };

      // Unit-test mock events without senderFrame must be permitted
      expect(securityUtils.isTrustedIpcSenderEvent({}, checkOpts)).toBe(true);
      expect(securityUtils.isTrustedIpcSenderEvent({ sender: mainWc }, checkOpts)).toBe(true);

      // Real main-frame packaged file:// event succeeds
      expect(
        securityUtils.isTrustedIpcSenderEvent({ sender: mainWc, senderFrame: mainFrame }, checkOpts)
      ).toBe(true);

      // Embedded iframe (senderFrame !== mainFrame) is rejected
      expect(() =>
        securityUtils.assertTrustedIpcSender({ sender: mainWc, senderFrame: subFrame }, checkOpts)
      ).toThrow(/Blocked IPC invocation from untrusted/);

      // Foreign BrowserWindow is rejected
      expect(() =>
        securityUtils.assertTrustedIpcSender(
          { sender: foreignWc, senderFrame: mainFrame },
          checkOpts
        )
      ).toThrow(/Blocked IPC invocation from untrusted/);

      // Dev localhost URL is rejected when isPackaged === true
      const devFrame = { url: 'http://localhost:5173/', routingId: 1 };
      expect(
        securityUtils.isTrustedIpcSenderEvent(
          { sender: { id: 10, mainFrame: devFrame }, senderFrame: devFrame },
          checkOpts
        )
      ).toBe(false);
    });

    it('validates loopback-only ELECTRON_START_URL and rejects remote or LAN origins', () => {
      expect(securityUtils.resolveTrustedDevStartUrl('http://localhost:5173/app')).toBe(
        'http://localhost:5173/app'
      );
      expect(securityUtils.resolveTrustedDevStartUrl('http://127.0.0.1:4173')).toBe(
        'http://127.0.0.1:4173/'
      );
      expect(securityUtils.resolveTrustedDevStartUrl('https://evil.example.test')).toBeNull();
      expect(securityUtils.resolveTrustedDevStartUrl('http://192.168.1.25:3000')).toBeNull();
      expect(securityUtils.resolveTrustedDevStartUrl('http://user:pass@localhost:3000')).toBeNull();
    });

    it('forwards optional opts in preload.cjs across all 8 fixed wrappers and prunes legacy unexposed IPC channels', async () => {
      const preloadSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron/preload.cjs'), 'utf8');
      expect(preloadSrc).toContain('if (isTrustedMainRendererOrigin())');
      expect(preloadSrc).toContain(
        "getGameInstallInfo: (payload, opts) =>\n    ipcRenderer.invoke('launcher:get-install-info', payload, opts)"
      );
      expect(preloadSrc).toContain(
        "getInstallInfo: (payload, opts) =>\n    ipcRenderer.invoke('launcher:get-install-info', payload, opts)"
      );
      expect(preloadSrc).toContain(
        "saveGameLaunchConfig: (config, opts) =>\n    ipcRenderer.invoke('launcher:save-launch-config', config, opts)"
      );
      expect(preloadSrc).toContain(
        "saveLaunchConfig: (config, opts) =>\n    ipcRenderer.invoke('launcher:save-launch-config', config, opts)"
      );
      expect(preloadSrc).toContain(
        "getGameLaunchConfigs: (opts) => ipcRenderer.invoke('launcher:get-launch-configs', opts)"
      );
      expect(preloadSrc).toContain(
        "getLaunchConfig: (gameId, opts) => ipcRenderer.invoke('launcher:get-launch-config', gameId, opts)"
      );
      expect(preloadSrc).toContain(
        "deleteLaunchConfig: (gameId, opts) =>\n    ipcRenderer.invoke('launcher:delete-launch-config', gameId, opts)"
      );
      expect(preloadSrc).toContain(
        "saveLauncherPerformanceSettings: (settings, opts) =>\n    ipcRenderer.invoke('launcher:save-performance-settings', settings, opts)"
      );

      // Verify main.cjs navigation & packaged load guards + subframe CORS isolation
      const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron/main.cjs'), 'utf8');
      expect(mainSrc).toContain("mainWindow.webContents.on(\n    'will-navigate'");
      expect(mainSrc).toContain("mainWindow.webContents.on(\n    'will-redirect'");
      expect(mainSrc).toContain('isMainAppFrameInitiator(details)');
      expect(mainSrc).toContain('resolveTrustedDevStartUrl(process.env.ELECTRON_START_URL');

      // Register IPC handlers on a mock ipcMain and verify unexposed legacy token/settings channels are absent
      const handlers = new Map<string, (...args: any[]) => any>();
      const mockIpcMain = {
        handle: (ch: string, fn: (...args: any[]) => any) => handlers.set(ch, fn),
        on: () => {},
      };
      const spyGetConfigs = vi.fn(() => ({}));
      launcherIpc.registerLauncherIpcHandlers({
        ipcMain: mockIpcMain,
        launcherEngine: {
          ...launcherEngine,
          getGameLaunchConfigs: spyGetConfigs,
        },
        dialog: { showMessageBox: async () => ({ response: 0 }) },
        getMainWindow: () => null,
      });
      storeSyncIpc.registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        storeSync: {},
        getMainWindow: () => null,
      });
      offlineVaultIpc.registerOfflineVaultIpcHandlers({
        ipcMain: mockIpcMain,
        getOfflineVault: () => null,
        getHydrationEngine: () => null,
      });

      expect(handlers.has('launcher:save-settings')).toBe(false);
      expect(handlers.has('store:save-tokens')).toBe(false);
      expect(handlers.has('store:save-token')).toBe(false);
      expect(handlers.has('store:get-saved-tokens')).toBe(false);
      expect(handlers.has('store:clear-token')).toBe(false);
      expect(handlers.has('vault:check-url-status')).toBe(false);
      expect(handlers.has('vault:save-user-override')).toBe(false);

      // Verify sanitized opts forwarding strips forbidden DI keys like userDataDir from renderer IPC
      const getConfigsHandler = handlers.get('launcher:get-launch-configs')!;
      await getConfigsHandler({}, { forceRefresh: true, userDataDir: '/tmp/hijack' });
      expect(spyGetConfigs).toHaveBeenCalledTimes(1);
      const passedOpts = (spyGetConfigs.mock.calls[0] as any[])[0];
      expect(passedOpts.forceRefresh).toBe(true);
      expect(passedOpts.userDataDir).toBeUndefined();
    });

    it('wraps handleOnce and avoids double-proxying wrapped ipcMain instances in wrapIpcMainWithSenderCheck', () => {
      let handleOnceChannel = '';
      let handleOnceWrappedListener: any = null;
      const fakeIpcMain = {
        handle: vi.fn(),
        handleOnce: vi.fn((ch, fn) => {
          handleOnceChannel = ch;
          handleOnceWrappedListener = fn;
        }),
      };

      const wrapped = securityUtils.wrapIpcMainWithSenderCheck(fakeIpcMain, {
        isPackaged: true,
        expectedFileHref: 'file:///app/dist/index.html',
      });
      expect(wrapped.__isIpcSenderCheckWrapped).toBe(true);

      // Re-wrapping an already wrapped proxy must return the same proxy without nesting
      const rewrapped = securityUtils.wrapIpcMainWithSenderCheck(wrapped);
      expect(rewrapped).toBe(wrapped);

      // Registering via handleOnce must wrap listener with assertTrustedIpcSender
      const dummyListener = vi.fn((_evt, arg) => `res_${arg}`);
      wrapped.handleOnce('test:once-channel', dummyListener);
      expect(handleOnceChannel).toBe('test:once-channel');
      expect(typeof handleOnceWrappedListener).toBe('function');

      // Untrusted senderFrame invocation on handleOnce must throw ERR_UNTRUSTED_IPC_SENDER
      const subFrame = { url: 'https://evil.example.com', routingId: 99 };
      const mainWc = { id: 1, mainFrame: { url: 'file:///app/dist/index.html', routingId: 1 } };
      expect(() =>
        handleOnceWrappedListener({ sender: mainWc, senderFrame: subFrame }, 'data')
      ).toThrow(/Blocked IPC invocation from untrusted/);
      expect(dummyListener).not.toHaveBeenCalled();

      // Trusted senderFrame invocation succeeds
      const result = handleOnceWrappedListener(
        { sender: mainWc, senderFrame: mainWc.mainFrame },
        'success'
      );
      expect(result).toBe('res_success');
      expect(dummyListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. Findings #3 & #14: Native reg.exe Discovery (Zero PowerShell Sync) & Shared Helper Deduplication', () => {
    it('discovers Windows storefront paths and Known Folders via reg.exe without spawning powershell.exe', async () => {
      winRegDiscovery.invalidateWindowsRegistryDiscoveryCache();
      securityUtils.clearCachedWindowsKnownFolders();
      securityUtils.clearCachedWindowsLocalDrives();

      const spawnedBins: string[] = [];
      const mockExecSync = (bin: string, args: string[]) => {
        spawnedBins.push(bin);
        const joined = args.join(' ');
        if (joined.includes('Valve\\Steam')) {
          return 'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    D:/Games/Steam\r\n';
        }
        if (joined.includes('GOG.com\\GalaxyClient\\paths')) {
          return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths\r\n    client    REG_SZ    D:\\GOG Galaxy\r\n';
        }
        if (joined.includes('User Shell Folders')) {
          return [
            'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
            '    Personal    REG_EXPAND_SZ    D:\\OneDrive\\Documents',
            '    {4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}    REG_EXPAND_SZ    D:\\Saved Games',
          ].join('\r\n');
        }
        return '';
      };

      const steamPaths = winRegDiscovery.discoverWindowsSteamRegistryPaths({
        platform: 'win32',
        queryHostWindowsRegistry: true,
        execFileSyncImpl: mockExecSync,
      });
      const gogPaths = winRegDiscovery.discoverWindowsGogGalaxyRegistryPaths({
        platform: 'win32',
        queryHostWindowsRegistry: true,
        execFileSyncImpl: mockExecSync,
      });
      expect(steamPaths.steamRoot).toBe('D:\\Games\\Steam');
      expect(gogPaths.clientDir).toBe('D:\\GOG Galaxy');

      const known = securityUtils.resolveHostWindowsKnownFolders({
        platform: 'win32',
        userProfile: 'D:\\Profile',
        execFileSyncImpl: mockExecSync,
      });
      expect(known.documents).toBe('D:\\OneDrive\\Documents');
      expect(known.savedGames).toBe('D:\\Saved Games');
      expect(spawnedBins.length).toBeGreaterThan(0);
      expect(spawnedBins.every((b) => b.toLowerCase() === 'reg.exe')).toBe(true);

      const drives = await securityUtils.discoverWindowsLocalDrivesAsync({
        platform: 'win32',
        mountedDriveRoots: ['c:', 'd:\\'],
      });
      expect(drives).toEqual(['C:\\', 'D:\\']);
      expect(typeof macNative.prepareAlignedAuxBottleWineCommand).toBe('function');
      expect(offlineVaultMod.normalizeVaultChainedHandoffId('ea-app')).toBe('ea');
      expect(offlineVaultMod.normalizeVaultChainedHandoffId('ubisoft-connect')).toBe('ubisoft');
    });
  });

  describe('4. Finding #4: OfflineVault SSRF Redirect Validation, Streaming Byte Cap & ol-media:// CORP Isolation', () => {
    it('blocks SSRF on 3xx Location redirect hops and enforces streaming maxFetchBytes when Content-Length is omitted', async () => {
      // 1. Redirect hop pointing to cloud metadata IP 169.254.169.254 MUST fail closed!
      let hopCalls = 0;
      const redirectSsrfFetch = vi.fn(async () => {
        hopCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data/' },
        });
      });

      await expect(
        securityUtils.safePublicHttpsFetch('https://cdn.example.test/cover.jpg', {
          fetchImpl: redirectSsrfFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow(/Blocked private or loopback IP literal/);
      expect(hopCalls).toBe(1);

      // 2. Streaming response without Content-Length exceeding maxFetchBytes MUST abort mid-stream!
      let chunksPulled = 0;
      const oversizedStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled += 1;
          if (chunksPulled > 10) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      const chunkedFetch = vi.fn(
        async () =>
          new Response(oversizedStream, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          })
      );

      await expect(
        securityUtils.safePublicHttpsFetch('https://cdn.example.test/huge.jpg', {
          fetchImpl: chunkedFetch as unknown as typeof fetch,
          maxFetchBytes: 128 * 1024, // 128 KB cap -> aborts on 3rd 64KB chunk!
        })
      ).rejects.toThrow(/exceeds limit/);
      expect(chunksPulled).toBeLessThanOrEqual(4);
    });

    it('enforces Cross-Origin-Resource-Policy: same-origin, rejects cross-site ol-media:// fetches, and honors localCacheOnly', async () => {
      const sandbox = trackSandbox('ol-w2b-olmedia-');
      const imgFile = path.join(sandbox, 'cover.jpg');
      fs.writeFileSync(imgFile, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]));

      const resolveCalls: Array<{ params: any; opts: any }> = [];
      const mockVault = {
        resolveMediaRequest: async (params: any, opts: any) => {
          resolveCalls.push({ params, opts });
          if (opts?.localCacheOnly && params.url.includes('uncached')) {
            return { kind: 'error', status: 504, reason: 'offline_cache_miss' };
          }
          return {
            kind: 'file',
            filePath: imgFile,
            mimeType: 'image/jpeg',
            sizeBytes: 68,
            cacheControl: 'public, max-age=3600',
            source: 'vault_blob',
          };
        },
      };

      const protocolHandler = offlineVaultIpc.createOlMediaProtocolHandler({
        getOfflineVault: () => mockVault,
        dnsLookup: async () => {
          const err = new Error('offline') as Error & { code?: string };
          err.code = 'ENOTFOUND';
          throw err;
        },
      });

      // Cross-site request (e.g. embedded third-party iframe) MUST be blocked with 403
      const crossSiteRes = await protocolHandler(
        new Request('ol-media://asset?gameId=gog-1&role=cover&url=https%3A%2F%2Fcdn.example.com%2Fa.jpg', {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      );
      expect(crossSiteRes.status).toBe(403);
      expect(crossSiteRes.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');

      // Same-origin request when OS DNS is offline passes localCacheOnly: true and serves local file stream
      const sameOriginRes = await protocolHandler(
        new Request('ol-media://asset?gameId=gog-1&role=cover&url=https%3A%2F%2Fcdn.example.com%2Fa.jpg', {
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      );
      expect(sameOriginRes.status).toBe(200);
      expect(sameOriginRes.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(resolveCalls[0].opts.localCacheOnly).toBe(true);
      const bodyBuf = Buffer.from(await sameOriginRes.arrayBuffer());
      expect(bodyBuf.length).toBe(68);
    });

    it('handles HTTP 206 byte-range requests with Content-Range, Accept-Ranges, and partial content streams on ol-media://', async () => {
      const sandbox = trackSandbox('ol-w2b-range-');
      const testFile = path.join(sandbox, 'stream_test.dat');
      const fileContent = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      fs.writeFileSync(testFile, fileContent, 'utf8');

      const mockVault = {
        resolveMediaRequest: async () => ({
          kind: 'file',
          filePath: testFile,
          mimeType: 'application/octet-stream',
          sizeBytes: fileContent.length,
          cacheControl: 'public, max-age=3600',
        }),
      };

      const handler = offlineVaultIpc.createOlMediaProtocolHandler({
        getOfflineVault: () => mockVault,
        dnsLookup: async () => ({ address: '93.184.216.34', family: 4 }),
      });

      // 1. Full content request returns 200 with Accept-Ranges: bytes
      const fullRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Ffile.dat', {
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      );
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get('Accept-Ranges')).toBe('bytes');
      expect(fullRes.headers.get('Content-Length')).toBe(String(fileContent.length));

      // 2. Valid byte range bytes=4-13 returns HTTP 206 with Content-Range
      const rangeRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Ffile.dat', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=4-13' },
        })
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('Accept-Ranges')).toBe('bytes');
      expect(rangeRes.headers.get('Content-Range')).toBe(`bytes 4-13/${fileContent.length}`);
      expect(rangeRes.headers.get('Content-Length')).toBe('10');
      const chunkBuf = Buffer.from(await rangeRes.arrayBuffer());
      expect(chunkBuf.toString('utf8')).toBe(fileContent.slice(4, 14));

      // 3. Suffix byte range bytes=-6 returns last 6 bytes
      const suffixRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Ffile.dat', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=-6' },
        })
      );
      expect(suffixRes.status).toBe(206);
      expect(suffixRes.headers.get('Content-Range')).toBe(
        `bytes ${fileContent.length - 6}-${fileContent.length - 1}/${fileContent.length}`
      );
      const suffixBuf = Buffer.from(await suffixRes.arrayBuffer());
      expect(suffixBuf.toString('utf8')).toBe(fileContent.slice(-6));

      // 4. Unsatisfiable range returns HTTP 416
      const invalidRangeRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Ffile.dat', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=100-200' },
        })
      );
      expect(invalidRangeRes.status).toBe(416);
      expect(invalidRangeRes.headers.get('Content-Range')).toBe(`bytes */${fileContent.length}`);
    });
  });

  describe('5. Findings #6 & #18: Download Engine !signaled Resume Fix, Per-Task Serialization & Graceful Shutdown', () => {
    it('re-spawns via resumeInstallFn when paused CLI downloader exited cleanly and serializes rapid pause/resume/cancel transitions', async () => {
      const taskId = 'dl-synth-task-1';
      let resumedFromCheckpoint = 0;
      const fakeCliChild = createFakeChildProcess(61234);

      engineStateRegistry.downloadQueueMap.set(taskId, {
        taskId,
        gameId: 'gog-synth-dl',
        title: 'Synth CLI Download',
        platformId: 'gog',
        runner: 'gogdl',
        status: 'downloading',
        progressPercent: 42,
      });
      engineStateRegistry.downloadControllers.set(taskId, {
        type: 'process',
        child: fakeCliChild,
        runner: 'gogdl',
        pausedByUser: false,
        cancelRequested: false,
        exitedWhilePaused: false,
        resumeInstallFn: () => {
          resumedFromCheckpoint += 1;
        },
      });

      const pauseRes = downloadCoordinator.pauseDownload(taskId, { platform: 'darwin' });
      const resumeRes = downloadCoordinator.resumeDownload(taskId, { platform: 'darwin' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(pauseRes.success).toBe(true);
      expect(resumeRes.success).toBe(true);
      expect(resumedFromCheckpoint).toBe(1);

      // Verify gracefulShutdownDownloads pauses active controllers cleanly before app quit
      const fakeActiveChild = createFakeChildProcess(61235);
      engineStateRegistry.downloadQueueMap.set('dl-synth-shutdown', {
        taskId: 'dl-synth-shutdown',
        gameId: 'epic-synth-dl',
        title: 'Synth Epic Download',
        platformId: 'epic',
        runner: 'legendary',
        status: 'downloading',
        progressPercent: 55,
      });
      engineStateRegistry.downloadControllers.set('dl-synth-shutdown', {
        type: 'process',
        child: fakeActiveChild,
        runner: 'legendary',
        pausedByUser: false,
        cancelRequested: false,
      });

      await downloadCoordinator.gracefulShutdownDownloads(1500, {
        platform: 'darwin',
      });
      expect(engineStateRegistry.downloadQueueMap.get('dl-synth-shutdown')?.status).toBe('paused');
      expect(engineStateRegistry.downloadControllers.size).toBe(0);

      engineStateRegistry.downloadQueueMap.clear();
      engineStateRegistry.downloadControllers.clear();
    });
  });

  describe('6. Finding #7: Fail-Closed Symlink-Safe Uninstall Without 2,000-Entry Blind Spot', () => {
    it('fails closed on non-ENOENT stat errors, detects escaping symlinks past >2,100 files, and unlinks internal symlinks without touching external targets', async () => {
      const sandbox = trackSandbox('ol-w2b-uninst-');
      const libraryRoot = path.join(sandbox, 'Games', 'OneLauncher', 'GOG');
      const gameDir = path.join(libraryRoot, 'SynthTitle');
      const externalSecretDir = path.join(sandbox, 'ExternalImportantDocs');
      const externalSecretFile = path.join(externalSecretDir, 'precious_save.dat');

      fs.mkdirSync(gameDir, { recursive: true });
      fs.mkdirSync(externalSecretDir, { recursive: true });
      fs.writeFileSync(externalSecretFile, 'DO_NOT_DELETE_ME', 'utf8');

      // 1. Fail-closed on EACCES stat error
      expect(() =>
        uninstallSafety.assertSafeGameUninstallDirectory(gameDir, {
          platform: process.platform,
          homedir: sandbox,
          fsImpl: {
            ...fs,
            lstatSync: () => {
              const err = new Error('Permission denied') as Error & { code?: string };
              err.code = 'EACCES';
              throw err;
            },
          },
        })
      ).toThrow(/Refusing unsafe game uninstall path/);

      // 2. Create 2,050 regular files + 1 escaping symlink to prove zero 2,000-entry blind spot
      const bulkSubdir = path.join(gameDir, 'assets');
      fs.mkdirSync(bulkSubdir, { recursive: true });
      for (let i = 0; i < 2050; i += 1) {
        fs.writeFileSync(path.join(bulkSubdir, `f_${String(i).padStart(4, '0')}.bin`), 'x');
      }
      const escapingLink = path.join(gameDir, 'zzz_escape_link');
      fs.symlinkSync(
        externalSecretDir,
        escapingLink,
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      expect(
        uninstallSafety.isSafeToDeleteInstallPath(gameDir, {
          platform: process.platform,
          homedir: sandbox,
        })
      ).toBe(false);

      // 3. safeRemoveGameDirectoryAsync with skipSafetyAssertion (or internal symlink) unlinks symlink itself without deleting target!
      const gameDir2 = path.join(libraryRoot, 'SynthTitleSafeUnlink');
      fs.mkdirSync(gameDir2, { recursive: true });
      fs.writeFileSync(path.join(gameDir2, 'game.bin'), 'binary-data');
      const linkToExternal = path.join(gameDir2, 'linked_docs');
      fs.symlinkSync(
        externalSecretDir,
        linkToExternal,
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      // Even if unlinker runs directly on a tree containing a symlink, external files MUST survive intact
      await uninstallSafety.safeRemoveGameDirectoryAsync(gameDir2, {
        platform: process.platform,
        homedir: sandbox,
        skipSafetyAssertion: true,
      });

      expect(fs.existsSync(gameDir2)).toBe(false);
      expect(fs.existsSync(externalSecretFile)).toBe(true);
      expect(fs.readFileSync(externalSecretFile, 'utf8')).toBe('DO_NOT_DELETE_ME');
    });

    it('strictly rejects deleting the library root container itself when targetPath equals options.libraryRoot', () => {
      const sandbox = trackSandbox('ol-w2b-libroot-');
      const libraryRoot = path.join(sandbox, 'Games', 'OneLauncher');
      const gameDir = path.join(libraryRoot, 'ValidGame');
      fs.mkdirSync(gameDir, { recursive: true });

      // Attempting to delete libraryRoot itself MUST be rejected even if within allowedRoot
      expect(
        uninstallSafety.isSafeToDeleteInstallPath(libraryRoot, {
          platform: process.platform,
          libraryRoot,
        })
      ).toBe(false);

      // Windows-style library root self-deletion must also be rejected
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('C:\\Games\\OneLauncher', {
          platform: 'win32',
          libraryRoot: 'C:\\Games\\OneLauncher',
        })
      ).toBe(false);

      // Strictly nested child directory inside libraryRoot is accepted
      expect(
        uninstallSafety.isSafeToDeleteInstallPath(gameDir, {
          platform: process.platform,
          libraryRoot,
        })
      ).toBe(true);
    });
  });

  describe('7. Finding #8: macOS Developer ID PyInstaller Signing Hook & Dynamic Release Tag', () => {
    it('routes unpacked gogdl and legendary to entitlements.pyinstaller.plist in build/macSign.cjs and uses dynamic release tag in release.yml', () => {
      const pyEntitlements = path.join(REPO_ROOT, 'build', 'entitlements.pyinstaller.plist');
      const appEntitlements = path.join(REPO_ROOT, 'build', 'entitlements.mac.plist');
      expect(fs.existsSync(pyEntitlements)).toBe(true);
      expect(fs.existsSync(appEntitlements)).toBe(true);

      expect(
        macSignHook._testHelpers.isUnpackedPyInstallerCliBinary(
          '/Volumes/Build/One Launcher.app/Contents/Resources/app.asar.unpacked/electron/bin/arm64/darwin/gogdl'
        )
      ).toBe(true);
      expect(
        macSignHook._testHelpers.isUnpackedPyInstallerCliBinary(
          '/Volumes/Build/One Launcher.app/Contents/Resources/app.asar.unpacked/electron/bin/x64/darwin/legendary'
        )
      ).toBe(true);
      expect(
        macSignHook._testHelpers.isUnpackedPyInstallerCliBinary(
          '/Volumes/Build/One Launcher.app/Contents/Frameworks/One Launcher Helper.app'
        )
      ).toBe(false);

      const optsFn = macSignHook._testHelpers.createPerFileSignOptionsResolver(undefined);
      expect(
        optsFn(
          '/Volumes/Build/One Launcher.app/Contents/Resources/app.asar.unpacked/electron/bin/arm64/darwin/gogdl'
        )
      ).toEqual({
        entitlements: pyEntitlements,
        hardenedRuntime: true,
      });
      expect(optsFn('/Volumes/Build/One Launcher.app')).toEqual({
        entitlements: appEntitlements,
      });
      expect(typeof afterSignHook.default).toBe('function');

      const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
      expect(pkgJson.build.mac.sign).toBe('build/macSign.cjs');
      expect(pkgJson.build.afterSign).toBe('build/afterSign.cjs');
      expect(pkgJson.build.nsis.deleteAppDataOnUninstall).toBe(false);

      const releaseYml = fs.readFileSync(
        path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
        'utf8'
      );
      expect(releaseYml).not.toContain('Highlights in v0.2.5');
      expect(releaseYml).toContain(
        "Highlights in ${{ github.ref_type == 'tag' && github.ref_name || format('v{0}', steps.meta.outputs.version) }}"
      );
    });
  });

  describe('8. Findings #9, #11, #12, #16 & #17: State .bak Recovery, Scanner Projection, Uninstaller UAC/SQLite, Async Cloud Quota & Batched ps', () => {
    it('recovers corrupted state JSON from .bak and preserves customExecutablePath on unmounted external drives', () => {
      const sandbox = trackSandbox('ol-w2b-state-');
      const cfgFile = path.join(sandbox, 'one_launcher_configs.json');
      const unmountedExe = path.join(sandbox, 'UnpluggedExternalDrive', 'Binaries', 'SynthGame.exe');

      engineStateRegistry.saveGameLaunchConfig(
        {
          gameId: 'steam-900001',
          customExecutablePath: unmountedExe,
          launchArguments: '-windowed',
        },
        { userDataDir: sandbox }
      );

      // Update once more so atomicWriteFileSync preserves a valid .bak snapshot
      engineStateRegistry.saveGameLaunchConfig(
        {
          gameId: 'steam-900001',
          customExecutablePath: unmountedExe,
          launchArguments: '-fullscreen',
        },
        { userDataDir: sandbox }
      );
      expect(fs.existsSync(`${cfgFile}.bak`)).toBe(true);

      // Unmounted drive executable MUST NOT be stripped on default getGameLaunchConfigs reads!
      const loaded = engineStateRegistry.getGameLaunchConfigs({ userDataDir: sandbox });
      expect(loaded['steam-900001'].customExecutablePath).toBe(unmountedExe);

      // Simulate power-loss truncation/corruption of primary JSON -> recovers from .bak automatically!
      fs.writeFileSync(cfgFile, '{corrupted_json', 'utf8');
      engineStateRegistry.trimLauncherEngineMemory();
      const recovered = engineStateRegistry.getGameLaunchConfigs({ userDataDir: sandbox });
      expect(recovered['steam-900001']?.customExecutablePath).toBe(unmountedExe);
    });

    it('projects vault_games columns in installedGameScanner without reading or decompressing enriched_json', () => {
      const sandbox = trackSandbox('ol-w2b-vaultproj-');
      const dbPath = path.join(sandbox, 'offline_vault.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE vault_games (
            game_id TEXT PRIMARY KEY,
            canonical_title TEXT,
            platforms_json TEXT,
            summary_json TEXT,
            enriched_json BLOB
          );
        `);
        // Insert deliberately invalid gzip bytes into enriched_json: if scanner touched enriched_json, gunzipSync would fail or waste CPU!
        db.prepare(
          'INSERT INTO vault_games (game_id, canonical_title, platforms_json, summary_json, enriched_json) VALUES (?, ?, ?, ?, ?)'
        ).run(
          'gog-800001',
          'Synth Vault Projected Title',
          JSON.stringify([{ platformId: 'gog', platformGameId: '800001' }]),
          zlib.gzipSync(
            Buffer.from(
              JSON.stringify({ developer: 'Synth Dev', chainedLauncherHandoff: 'ubisoft' }),
              'utf8'
            )
          ),
          Buffer.from('NOT_GZIP_BLOB_NEVER_TOUCHED')
        );
      } finally {
        db.close();
      }

      const scannerSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'electron/launcher/installedGameScanner.cjs'),
        'utf8'
      );
      expect(scannerSrc).toContain(
        'SELECT game_id, canonical_title, platforms_json, summary_json FROM vault_games'
      );
      expect(scannerSrc).not.toContain('SELECT * FROM vault_games');

      const scanRes = installedScanner.scanAllInstalledGames({
        platform: 'darwin',
        homedir: sandbox,
        userDataDir: sandbox,
      });
      expect(scanRes.success).toBe(true);
    });

    it('validates Windows uninstaller split-token UAC ProfileList/HKEY_USERS and galaxy-2.0.db backup/busy_timeout invariants', () => {
      expect(() =>
        verifyUninstaller.verifyFile(verifyUninstaller.CANONICAL_PS1, 'build/Uninstall-OneLauncher.ps1')
      ).not.toThrow();
      expect(() =>
        verifyUninstaller.verifyFile(
          verifyUninstaller.CANONICAL_BAT,
          'build/Uninstall One Launcher (Full Clean).bat'
        )
      ).not.toThrow();
      expect(() =>
        verifyUninstaller.verifyNsisFile(verifyUninstaller.NSIS_HOOK, 'build/installer.nsh')
      ).not.toThrow();
      expect(() =>
        verifyUninstaller.verifyNsisFile(
          verifyUninstaller.STANDALONE_NSI,
          'build/standalone-uninstaller.nsi'
        )
      ).not.toThrow();
    });

    it('enforces async cloud save backup quota and ignores 10-digit numbers on gogdl stderr', async () => {
      const sandbox = trackSandbox('ol-w2b-cloud-');
      const backupsRoot = path.join(sandbox, 'cloud_save_backups');
      const snapOld = path.join(backupsRoot, 'gog', 'gog-100', 'snapshot_2026-01-01T00-00-00Z');
      const snapNew = path.join(backupsRoot, 'gog', 'gog-100', 'snapshot_2026-01-02T00-00-00Z');
      fs.mkdirSync(snapOld, { recursive: true });
      fs.mkdirSync(snapNew, { recursive: true });
      const oldSaveFile = path.join(snapOld, 'save1.bin');
      const newSaveFile = path.join(snapNew, 'save2.bin');
      fs.writeFileSync(oldSaveFile, Buffer.alloc(4096, 1));
      fs.writeFileSync(path.join(snapOld, '.DS_Store'), 'junk');
      fs.writeFileSync(newSaveFile, Buffer.alloc(4096, 2));
      const hygiene = await cloudSaveEngine.purgeOsMetadataAndCountRealFilesAsync(snapOld);
      expect(hygiene.realFileCount).toBe(1);
      expect(hygiene.purgedCount).toBe(1);
      expect(fs.existsSync(path.join(snapOld, '.DS_Store'))).toBe(false);

      fs.utimesSync(oldSaveFile, 1700000000, 1700000000);
      fs.utimesSync(snapOld, 1700000000, 1700000000);
      fs.utimesSync(newSaveFile, 1700086400, 1700086400);
      fs.utimesSync(snapNew, 1700086400, 1700086400);

      const quotaRes = await cloudSaveEngine.enforceCloudSaveBackupQuotaAsync(backupsRoot, {
        maxTotalBackupBytes: 5000,
        minRetainedPerGame: 1,
      });
      expect(quotaRes.evictedCount).toBe(1);
      expect(fs.existsSync(snapOld)).toBe(false);
      expect(fs.existsSync(snapNew)).toBe(true);

      // Verify cloudSaveEngine only parses standalone 10-digit unix timestamps from stdout, never stderr!
      const cloudSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'electron/launcher/cloudSaveEngine.cjs'),
        'utf8'
      );
      expect(cloudSrc).toContain("const stdoutOnly = String(execRes.stdout || '');");
      expect(cloudSrc).toContain(
        'stdoutOnly.matchAll(/^\\s*(1[6-9]\\d{8}|2\\d{9})(?:\\.\\d+)?\\s*$/gm)'
      );
    });

    it('self-heals corrupted SQLite databases in ensureOpen() and batches utility deletions without phantom FTS queries', () => {
      const sandbox = trackSandbox('ol-w2b-vault-heal-');
      const vaultDir = path.join(sandbox, 'offline-vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      const dbPath = path.join(vaultDir, 'catalog_metadata.sqlite');

      // 1. Write corrupted header into SQLite file
      fs.writeFileSync(dbPath, 'CORRUPTED_SQLITE_GARBAGE_HEADER_DATA_12345');

      const vault = new offlineVaultMod.OfflineVaultService({
        userDataDir: sandbox,
      });

      // ensureOpen() must detect corruption, back up corrupt file, and initialize clean SQLite schema
      const db = vault.ensureOpen();
      expect(db).toBeDefined();

      const corruptBackups = fs.readdirSync(vaultDir).filter((f: string) => f.includes('.corrupt.'));
      expect(corruptBackups.length).toBe(1);

      // 2. Insert standalone launcher utility into vault_games and verify batch cleanup during getCatalogSnapshot()
      db.prepare(
        'INSERT INTO vault_games (game_id, canonical_title, is_installed, platforms_json, summary_json) VALUES (?, ?, 0, ?, ?)'
      ).run(
        'ea-app-util',
        'EA App',
        JSON.stringify([{ platformId: 'ea', installed: false }]),
        JSON.stringify({ id: 'ea-app-util', title: 'EA App' })
      );
      vault.upsertGames([
        {
          id: 'real-game-1',
          title: 'Synthetic Action Game',
          isInstalled: true,
          platforms: [{ platformId: 'win32', installed: true }],
        },
      ]);

      const snapshot = vault.getCatalogSnapshot();
      expect(snapshot.success).toBe(true);
      expect(snapshot.games.some((g: any) => g.id === 'real-game-1')).toBe(true);
      expect(snapshot.games.some((g: any) => g.id === 'ea-app-util')).toBe(false);

      // Verify it was purged from the database
      const row = db.prepare('SELECT game_id FROM vault_games WHERE game_id = ?').get('ea-app-util');
      expect(row).toBeUndefined();

      vault.shutdown();
    });
  });

  describe('9. Wave 1D JS Contracts: 64-Bit Unity Scaler Exclusion, active_session.ini & Metal Preload Size Refresh', () => {
    it('excludes 64-bit Unity (unityplayer.dll + opengl32.dll) from auto_fullscreen scaler wrapping unless -force-glcore is passed', () => {
      const sandbox = trackSandbox('ol-w2b-unity64-');
      const unityExe = path.join(sandbox, 'SynthUnityGame.exe');
      fs.writeFileSync(
        unityExe,
        buildSyntheticPeBuffer({
          arch: 'x64',
          importedDlls: ['KERNEL32.dll', 'UnityPlayer.dll', 'OPENGL32.dll'],
        })
      );

      const defaultCaps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        unityExe,
        sandbox,
        {}
      );
      expect(defaultCaps.importsUnityPlayer).toBe(true);
      expect(defaultCaps.usesModernGraphicsApi).toBe(true);
      expect(defaultCaps.usesOpenGl).toBe(false);
      expect(defaultCaps.isLauncherStubCandidate).toBe(false);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(defaultCaps, 'auto_fullscreen', '')
      ).toBe(false);

      // With -force-glcore, Unity runs OpenGL core -> scaler wrapping IS enabled!
      const glCoreCaps = binaryInspectors.resolveEffectiveGameExecutableCapabilities(
        unityExe,
        sandbox,
        { launchArguments: '-force-glcore' }
      );
      expect(glCoreCaps.usesOpenGl).toBe(true);
      expect(
        supervisor.shouldWrapBottleSessionWithDisplayLauncher(
          glCoreCaps,
          'auto_fullscreen',
          '-force-glcore'
        )
      ).toBe(true);
    });

    it('writes active_session.ini at launch and on toggleSessionFullscreen, and refreshes stale-sized libone_metal_preload.dylib', async () => {
      const sandbox = trackSandbox('ol-w2b-activesess-');
      const stageDir = path.join(sandbox, 'drive_c', 'ProgramData', 'OneLauncher', 'display_scaler');
      supervisor.writeActiveDisplaySessionManifestIni(stageDir, {
        seq: 1,
        mode: 'auto_fullscreen',
        aspect: 'preserve_aspect',
        safeInsetTop: 37,
        hotkey: true,
        controlFileWin: 'C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_s1.ini',
        statusFileWin: 'C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_s1.json',
      });

      const manifestPath = path.join(stageDir, 'active_session.ini');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      expect(manifestRaw).toContain('seq=1');
      expect(manifestRaw).toContain('mode=auto_fullscreen');
      expect(manifestRaw).toContain('aspect=preserve_aspect');
      expect(manifestRaw).toContain('filter=sharp_bilinear');
      expect(manifestRaw).toContain('safe_inset_top=37');
      expect(manifestRaw).toContain('hotkey=1');
      expect(manifestRaw).toContain(
        'control_file=C:\\ProgramData\\OneLauncher\\display_scaler\\display_ctl_s1.ini'
      );
      expect(manifestRaw).toContain(
        'status_file=C:\\ProgramData\\OneLauncher\\display_scaler\\display_status_s1.json'
      );
      expect(manifestRaw).toMatch(/updated_unix_ms=\d+/);

      // Verify ensureWineMetalPreloadDylib refreshes stale-sized extracted dylib
      const userDataDir = path.join(sandbox, 'userData');
      const helperDir = path.join(userDataDir, 'native_helpers');
      fs.mkdirSync(helperDir, { recursive: true });
      const extractedDylib = path.join(helperDir, 'libone_metal_preload.dylib');
      fs.writeFileSync(extractedDylib, Buffer.alloc(16, 0xaa)); // Stale 16-byte stub != real universal dylib size

      const resolvedDylib = macNative.ensureWineMetalPreloadDylib({
        platform: 'darwin',
        userDataDir,
      });
      if (resolvedDylib) {
        expect(fs.statSync(resolvedDylib).size).toBeGreaterThan(1024);
      }
    });
  });
});
